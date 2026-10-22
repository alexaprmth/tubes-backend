-- Owner execution only, after 014. No seed replay or external requests.
begin;
do $$ begin
 if not exists(select 1 from public.transrent_schema_versions where version='014') then raise exception 'Apply 014 first'; end if;
 if exists(select 1 from public.transrent_schema_versions where version='015') then raise exception '015 already applied'; end if;
 if exists(select gps_device_id from public.vehicles where gps_device_id is not null group by gps_device_id having count(*)>1) then raise exception 'Resolve duplicate GPS mappings before 015; no data is deleted'; end if;
end $$;
alter table public.rental_companies add column creation_key uuid unique;
alter table public.rentals add column actual_return_date date;
alter table public.gps_devices add column company_id uuid references public.rental_companies(id) on delete restrict;
update public.gps_devices d set company_id=v.company_id from public.vehicles v where v.gps_device_id=d.id;
create unique index vehicles_one_gps on public.vehicles(gps_device_id) where gps_device_id is not null;
grant usage,select on sequence public.rental_company_agreement_number_seq to service_role;
alter table public.rental_company_agreements
 add column workflow_stage text not null default 'WAITING_OWNER' check(workflow_stage in ('WAITING_OWNER','WAITING_REVIEW','REVISION_REQUIRED','ACTIVE','EXPIRED','REVOKED','ARCHIVED')),
 add column revision_reason text,
 add column predecessor_id uuid references public.rental_company_agreements(id),
 add column superseded_by uuid references public.rental_company_agreements(id),
 add column document_versions jsonb not null default '[]'::jsonb;
update public.rental_company_agreements set workflow_stage=case
 when status in ('ACTIVE','EXPIRED','REVOKED') then status when document_path is not null then 'WAITING_REVIEW' else 'WAITING_OWNER' end;
-- Preserve every duplicate request and PDF; archive older open requests without deleting evidence.
with ranked as (select id,first_value(id) over(partition by company_id order by (document_path is not null) desc,updated_at desc,id) as keeper,
 row_number() over(partition by company_id order by (document_path is not null) desc,updated_at desc,id) as n
 from public.rental_company_agreements where status in ('DRAFT','PENDING'))
update public.rental_company_agreements a set workflow_stage='ARCHIVED',superseded_by=r.keeper,
 revision_reason='Archived duplicate by migration 015; original document and status retained' from ranked r where a.id=r.id and r.n>1;
create unique index agreements_one_open on public.rental_company_agreements(company_id) where workflow_stage in ('WAITING_OWNER','WAITING_REVIEW','REVISION_REQUIRED');
create table public.company_admin_invites (
 id uuid primary key default gen_random_uuid(),company_id uuid not null references public.rental_companies(id) on delete restrict,
 email text not null unique,name text not null,user_id uuid references auth.users(id) on delete restrict,
 status text not null default 'PREPARING' check(status in ('PREPARING','SENT','FAILED','ACCEPTED')),
 processing_until timestamptz,processing_token uuid,
 last_error text,created_by uuid not null references public.profiles(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),accepted_at timestamptz
);
alter table public.company_admin_invites enable row level security;
revoke all on public.company_admin_invites from public,anon,authenticated;
grant select,insert,update on public.company_admin_invites to service_role;
create or replace function public.transrent_mou(p_actor uuid,p_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a profiles%rowtype;m rental_company_agreements%rowtype;c uuid;next_status text;reason text;signed_value timestamptz;expires_value timestamptz;
begin
 select * into a from profiles where id=p_actor;
 if not found then raise sqlstate 'PT403' using message='Akun tidak ditemukan.'; end if;
 if p_action='REQUEST' then c:=p_id; else select company_id into c from rental_company_agreements where id=p_id; end if;
 perform id from rental_companies where id=c for update;
 if not found then raise sqlstate 'PT404' using message='Perusahaan/MoU tidak ditemukan.'; end if;
 if p_action='REQUEST' then
  if a.role<>'CENTRAL_ADMIN' then raise sqlstate 'PT403' using message='Hanya Admin Pusat mengirim permintaan.'; end if;
  select * into m from rental_company_agreements where company_id=c and workflow_stage in ('WAITING_OWNER','WAITING_REVIEW','REVISION_REQUIRED') for update;
  if found then return to_jsonb(m); end if;
  insert into rental_company_agreements(company_id,status,gps_tracking_allowed,workflow_stage,notes,predecessor_id)
  values(c,'PENDING',false,'WAITING_OWNER',p_payload->>'notes',(select id from rental_company_agreements where company_id=c and status='ACTIVE' order by created_at desc limit 1)) returning * into m;
  return to_jsonb(m);
 end if;
 select * into m from rental_company_agreements where id=p_id for update;
 if p_action='UPLOAD' then
  if a.role<>'RENTAL_ADMIN' or a.company_id is distinct from c then raise sqlstate 'PT403' using message='Hanya pemilik perusahaan ini mengunggah.'; end if;
  if m.status not in ('DRAFT','PENDING') or m.workflow_stage not in ('WAITING_OWNER','REVISION_REQUIRED') then raise sqlstate 'PT409' using message='Dokumen sedang direview atau sudah final; minta revisi terlebih dahulu.'; end if;
  signed_value:=case when p_payload->>'signedAt' ~ '^\d{4}-\d{2}-\d{2}$' then (p_payload->>'signedAt')::date::timestamp at time zone 'Asia/Makassar' else (p_payload->>'signedAt')::timestamptz end;
  expires_value:=case when p_payload->>'expiresAt' ~ '^\d{4}-\d{2}-\d{2}$' then (((p_payload->>'expiresAt')::date+1)::timestamp at time zone 'Asia/Makassar')-interval '1 millisecond' else (p_payload->>'expiresAt')::timestamptz end;
  if nullif(p_payload->>'path','') is null or nullif(p_payload->'metadata'->>'sha256','') is null or nullif(p_payload->>'signedAt','') is null or nullif(p_payload->>'expiresAt','') is null
   or signed_value>now() or expires_value<=now() or expires_value<=signed_value then raise sqlstate 'PT400' using message='PDF dan tanggal MoU tidak lengkap/valid.'; end if;
  update rental_company_agreements set document_versions=document_versions||case when document_path is not null then jsonb_build_array(jsonb_build_object('path',document_path,'metadata',document_metadata,'signedAt',signed_at,'expiresAt',expires_at,'archivedAt',now())) else '[]'::jsonb end,
   document_path=p_payload->>'path',document_metadata=p_payload->'metadata',status='PENDING',workflow_stage='WAITING_REVIEW',gps_tracking_allowed=false,
   signed_at=signed_value,expires_at=expires_value,updated_at=now() where id=m.id returning * into m;
 elsif p_action='REVIEW' then
  if a.role<>'CENTRAL_ADMIN' then raise sqlstate 'PT403' using message='Hanya Admin Pusat mereview.'; end if;
  if m.workflow_stage in ('ACTIVE','EXPIRED','REVOKED','ARCHIVED') then
   if m.status='ACTIVE' and p_payload->>'status' in ('REVOKED','EXPIRED') then
    reason:=trim(p_payload->>'reason');if reason is null or length(reason) not between 1 and 2000 then raise sqlstate 'PT400' using message='Alasan penonaktifan wajib diisi.'; end if;
   else raise sqlstate 'PT409' using message='MoU final tidak dapat dibuka/diganti; buat permintaan perpanjangan baru.'; end if;
  elsif p_payload->>'decision'='REVISION_REQUIRED' then
   reason:=trim(p_payload->>'reason');
   if m.workflow_stage<>'WAITING_REVIEW' or reason is null or length(reason) not between 1 and 2000 then raise sqlstate 'PT400' using message='Revisi memerlukan dokumen untuk direview dan alasan.'; end if;
   update rental_company_agreements set workflow_stage='REVISION_REQUIRED',revision_reason=reason,updated_at=now() where id=m.id returning * into m;
   return to_jsonb(m);
  end if;
  next_status:=p_payload->>'status';
  if next_status is null or next_status not in ('ACTIVE','EXPIRED','REVOKED') then raise sqlstate 'PT400' using message='Gunakan aktivasi, permintaan revisi, atau penonaktifan.'; end if;
  if next_status='ACTIVE' then
   if m.workflow_stage<>'WAITING_REVIEW' or m.document_path is null or m.document_metadata->>'sha256' is null or p_payload->>'reviewedSha256' is distinct from m.document_metadata->>'sha256' or p_payload->>'reviewed' is distinct from 'true'
    or m.signed_at is null or m.signed_at>now() or m.expires_at is null or m.expires_at<=now() then raise sqlstate 'PT409' using message='Periksa PDF final dan masa berlaku sebelum aktivasi.'; end if;
   if not exists(select 1 from rental_companies where id=c and status='ACTIVE') then raise sqlstate 'PT409' using message='Perusahaan harus aktif.'; end if;
   update rental_company_agreements set status='REVOKED',workflow_stage='REVOKED',gps_tracking_allowed=false,revision_reason='Superseded by approved renewal '||m.agreement_number,updated_at=now() where id=m.predecessor_id and status='ACTIVE';
  end if;
  update rental_company_agreements set status=next_status,workflow_stage=next_status,gps_tracking_allowed=next_status='ACTIVE' and coalesce((p_payload->>'gpsTrackingAllowed')::boolean,true),
   revision_reason=case when next_status='ACTIVE' then null else coalesce(reason,p_payload->>'reason') end,
   document_metadata=case when next_status='ACTIVE' then document_metadata||jsonb_build_object('reviewed',true,'reviewedBy',a.id,'reviewedAt',now()) else document_metadata end,updated_at=now() where id=m.id returning * into m;
 else raise sqlstate 'PT400' using message='Operasi MoU tidak valid.';
 end if;
 return to_jsonb(m);
exception when invalid_text_representation or datetime_field_overflow then raise sqlstate 'PT400' using message='Format MoU tidak valid.';
end $$;
revoke all on function public.transrent_mou(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.transrent_mou(uuid,uuid,text,jsonb) to service_role;
create or replace function public.transrent_master(p_actor uuid,p_entity text,p_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare a profiles%rowtype;c uuid;v vehicles%rowtype;b branches%rowtype;d gps_devices%rowtype;status_value text;
begin
 select * into a from profiles where id=p_actor;
 if not found or a.role not in ('RENTAL_ADMIN','CENTRAL_ADMIN') then raise sqlstate 'PT403' using message='Hanya admin mengelola data master.';end if;
 c:=case when a.role='CENTRAL_ADMIN' then (p_payload->>'companyId')::uuid else a.company_id end;
 if p_id is not null then
  if p_entity='vehicles' then select * into v from vehicles where id=p_id;c:=v.company_id;
  elsif p_entity='branches' then select * into b from branches where id=p_id;c:=b.company_id;
  elsif p_entity='devices' then select * into d from gps_devices where id=p_id;c:=coalesce(d.company_id,case when a.role='CENTRAL_ADMIN' then (p_payload->>'companyId')::uuid end);
  else raise sqlstate 'PT400' using message='Jenis data master tidak valid.';end if;
 end if;
 if c is null or not exists(select 1 from rental_companies where id=c) then raise sqlstate 'PT404' using message='Perusahaan/data master tidak ditemukan.';end if;
 if a.role<>'CENTRAL_ADMIN' and c is distinct from a.company_id then raise sqlstate 'PT403' using message='Akses lintas perusahaan ditolak.';end if;
 perform pg_advisory_xact_lock(hashtext(c::text));
 if p_id is not null then
  if p_entity='vehicles' then perform id from vehicles where id=p_id for update;elsif p_entity='devices' then perform id from gps_devices where id=p_id for update;else perform id from branches where id=p_id for update;end if;
 end if;
 if p_entity='branches' then
  if nullif(trim(p_payload->>'name'),'') is null or length(p_payload->>'name')>200 or nullif(trim(p_payload->>'address'),'') is null or length(p_payload->>'address')>1000 or p_payload->>'latitude' is null or p_payload->>'longitude' is null or (p_payload->>'latitude')::numeric not between -90 and 90 or (p_payload->>'longitude')::numeric not between -180 and 180 then raise sqlstate 'PT400' using message='Nama, alamat dan koordinat cabang wajib valid.';end if;
  if p_id is null then insert into branches(company_id,name,address,phone,location) values(c,trim(p_payload->>'name'),trim(p_payload->>'address'),p_payload->>'phone',st_setsrid(st_makepoint((p_payload->>'longitude')::float8,(p_payload->>'latitude')::float8),4326)::geography) returning * into b;
  else update branches set name=trim(p_payload->>'name'),address=trim(p_payload->>'address'),phone=p_payload->>'phone',location=st_setsrid(st_makepoint((p_payload->>'longitude')::float8,(p_payload->>'latitude')::float8),4326)::geography where id=p_id returning * into b;if not found then raise sqlstate 'PT404' using message='Cabang tidak ditemukan.';end if;end if;
  return to_jsonb(b);
 elsif p_entity='devices' then
  status_value:=coalesce(p_payload->>'status','READY');
  if nullif(trim(p_payload->>'deviceCode'),'') is null or length(p_payload->>'deviceCode')>200 or status_value not in ('READY','OFFLINE','FAULTY','INACTIVE') then raise sqlstate 'PT400' using message='Kode dan status GPS wajib valid.';end if;
  if p_id is null then insert into gps_devices(company_id,device_code,provider,status) values(c,trim(p_payload->>'deviceCode'),p_payload->>'provider',status_value) returning * into d;
  else update gps_devices set company_id=c,device_code=trim(p_payload->>'deviceCode'),provider=p_payload->>'provider',status=status_value where id=p_id returning * into d;if not found then raise sqlstate 'PT404' using message='GPS tidak ditemukan.';end if;update vehicles set gps_status=status_value where gps_device_id=d.id;end if;
  return to_jsonb(d);
 elsif p_entity='vehicles' then
  if nullif(trim(p_payload->>'name'),'') is null or length(p_payload->>'name')>200 or nullif(trim(p_payload->>'plateNumber'),'') is null or length(p_payload->>'plateNumber')>100 or p_payload->>'type' not in ('CAR','MOTORCYCLE') or p_payload->>'type' is null then raise sqlstate 'PT400' using message='Nama, plat dan jenis kendaraan wajib diisi.';end if;
  if p_payload->>'pricePerDay' is null or p_payload->>'deposit' is null or jsonb_typeof(p_payload->'pricePerDay')<>'number' or jsonb_typeof(p_payload->'deposit')<>'number' or (p_payload->>'pricePerDay')::numeric<0 or (p_payload->>'deposit')::numeric<0 or (p_payload->>'pricePerDay')::numeric<>trunc((p_payload->>'pricePerDay')::numeric) or (p_payload->>'deposit')::numeric<>trunc((p_payload->>'deposit')::numeric) then raise sqlstate 'PT400' using message='Tarif/deposit harus rupiah bulat tidak negatif.';end if;
  if coalesce((p_payload->>'seats')::int,4) not between 1 and 60 or coalesce((p_payload->>'year')::int,extract(year from now())::int) not between 1900 and extract(year from now())::int+1 then raise sqlstate 'PT400' using message='Jumlah kursi/tahun tidak valid.';end if;
  if p_id is not null and (exists(select 1 from rentals where vehicle_id=p_id and status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW')) or exists(select 1 from reservations where vehicle_id=p_id and (status='CONFIRMED' or status='PENDING_PAYMENT' and expires_at>now()))) then raise sqlstate 'PT409' using message='Selesaikan reservasi/rental sebelum mengubah kendaraan.';end if;
  select * into b from branches where id=(p_payload->>'branchId')::uuid and company_id=c;
  if not found then raise sqlstate 'PT400' using message='Cabang harus milik perusahaan yang sama.';end if;
  if nullif(p_payload->>'gpsDeviceId','') is not null then
   select * into d from gps_devices where id=(p_payload->>'gpsDeviceId')::uuid and company_id=c for update;
   if not found then raise sqlstate 'PT400' using message='GPS harus milik perusahaan yang sama.';end if;
   if exists(select 1 from vehicles where gps_device_id=d.id and id is distinct from p_id) then raise sqlstate 'PT409' using message='GPS sudah terpasang pada kendaraan lain.';end if;
  end if;
  status_value:=coalesce(p_payload->>'status','AVAILABLE');if status_value not in ('AVAILABLE','INACTIVE') then raise sqlstate 'PT400' using message='Gunakan lifecycle maintenance/rental untuk status operasional.';end if;
  if v.repair_required and status_value='AVAILABLE' then raise sqlstate 'PT409' using message='Selesaikan REPAIR sebelum mengaktifkan kendaraan rusak.';end if;
  if exists(select 1 from maintenances where vehicle_id=p_id and status in ('SCHEDULED','IN_PROGRESS')) and status_value='AVAILABLE' then raise sqlstate 'PT409' using message='Maintenance masih terbuka.';end if;
  if p_id is null then
   insert into vehicles(company_id,branch_id,gps_device_id,name,type,transmission,seats,year,plate_number,price_per_day,deposit_amount,status,gps_status)
   values(c,b.id,d.id,trim(p_payload->>'name'),p_payload->>'type',p_payload->>'transmission',coalesce((p_payload->>'seats')::int,4),coalesce((p_payload->>'year')::int,extract(year from now())::int),trim(p_payload->>'plateNumber'),(p_payload->>'pricePerDay')::numeric,(p_payload->>'deposit')::numeric,status_value,coalesce(d.status,'NOT_INSTALLED')) returning * into v;
  else update vehicles set branch_id=b.id,gps_device_id=d.id,name=trim(p_payload->>'name'),type=p_payload->>'type',transmission=p_payload->>'transmission',seats=coalesce((p_payload->>'seats')::int,4),year=coalesce((p_payload->>'year')::int,extract(year from now())::int),plate_number=trim(p_payload->>'plateNumber'),price_per_day=(p_payload->>'pricePerDay')::numeric,deposit_amount=(p_payload->>'deposit')::numeric,status=status_value,gps_status=coalesce(d.status,'NOT_INSTALLED') where id=p_id returning * into v;if not found then raise sqlstate 'PT404' using message='Kendaraan tidak ditemukan.';end if;end if;
  return to_jsonb(v);
 end if;
 raise sqlstate 'PT400' using message='Jenis data master tidak valid.';
exception when invalid_text_representation or numeric_value_out_of_range then raise sqlstate 'PT400' using message='Format data master tidak valid.';
end $$;
revoke all on function public.transrent_master(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.transrent_master(uuid,text,uuid,jsonb) to service_role;

create or replace function public.transrent_gps(p_vehicle uuid,p_lat numeric,p_lng numeric,p_speed numeric,p_heading numeric)
returns jsonb language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare v vehicles%rowtype;company uuid;point vehicle_locations%rowtype;
begin
 select company_id into company from vehicles where id=p_vehicle;
 -- Same company lock as MoU changes: an ingest cannot commit after a preceding revocation.
 perform id from rental_companies where id=company and status='ACTIVE' for share;
 if not found then raise sqlstate 'PT403' using message='Perusahaan tidak aktif.';end if;
 select * into v from vehicles where id=p_vehicle for update;
 if not found or v.gps_status<>'READY' or not exists(select 1 from gps_devices where id=v.gps_device_id and status='READY') then raise sqlstate 'PT409' using message='GPS/kendaraan tidak siap.';end if;
 if not exists(select 1 from rental_company_agreements where company_id=company and status='ACTIVE' and gps_tracking_allowed and (expires_at is null or expires_at>now())) then raise sqlstate 'PT403' using message='MoU/izin GPS tidak aktif.';end if;
 if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 or p_speed is null or p_speed<0 or p_heading is null or p_heading<0 or p_heading>=360 or p_lat='NaN'::numeric or p_lng='NaN'::numeric or p_speed='NaN'::numeric or p_heading='NaN'::numeric then raise sqlstate 'PT400' using message='Titik GPS tidak valid.';end if;
 insert into vehicle_locations(vehicle_id,rental_id,location,speed,heading)
 select v.id,r.id,st_setsrid(st_makepoint(p_lng::float8,p_lat::float8),4326)::geography,p_speed,p_heading from rentals r where r.vehicle_id=v.id and r.status='ACTIVE' returning * into point;
 if not found then raise sqlstate 'PT409' using message='Tidak ada rental aktif.';end if;
 update gps_devices set last_seen_at=point.recorded_at where id=v.gps_device_id;
 return to_jsonb(point);
end $$;
revoke all on function public.transrent_gps(uuid,numeric,numeric,numeric,numeric) from public,anon,authenticated;
grant execute on function public.transrent_gps(uuid,numeric,numeric,numeric,numeric) to service_role;
create or replace function public.transrent_can_read_location(p_rental uuid)
returns boolean language sql stable security definer set search_path=public,auth,pg_temp as $$
 select exists(select 1 from public.rentals r join public.rental_companies c on c.id=r.company_id
 where r.id=p_rental and r.customer_id=auth.uid() and r.status='ACTIVE' and c.status='ACTIVE'
 and exists(select 1 from public.rental_company_agreements a where a.company_id=c.id and a.status='ACTIVE' and a.gps_tracking_allowed and (a.expires_at is null or a.expires_at>now())));
$$;
revoke all on function public.transrent_can_read_location(uuid) from public,anon;
grant execute on function public.transrent_can_read_location(uuid) to authenticated;
drop policy if exists "customers can read own rental locations" on public.vehicle_locations;
create policy "customers can read own rental locations" on public.vehicle_locations for select to authenticated using(public.transrent_can_read_location(rental_id));
create or replace function public.transrent_mou_simulation(p_actor uuid,p_id uuid,p_receipt jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a profiles%rowtype; m rental_company_agreements%rowtype;
begin
 select * into a from profiles where id=p_actor;
 if not found or a.role<>'RENTAL_ADMIN' then raise sqlstate 'PT403' using message='Hanya pemilik rental dapat menyetujui.'; end if;
 select * into m from rental_company_agreements where id=p_id for update;
 if not found then raise sqlstate 'PT404' using message='MoU tidak ditemukan.'; end if;
 if a.company_id is distinct from m.company_id then raise sqlstate 'PT403' using message='Perusahaan tidak diizinkan.'; end if;
 if m.workflow_stage not in ('WAITING_OWNER','REVISION_REQUIRED') or m.status not in ('DRAFT','PENDING') or m.online_simulation is not null then raise sqlstate 'PT409' using message='Simulasi sudah dibuat atau MoU bukan draft/pending.'; end if;
 if p_receipt is null or p_receipt->>'mode' is distinct from 'ACADEMIC_SIMULATION'
   or p_receipt->>'acceptedBy' is distinct from a.id::text
   or p_receipt->>'termsVersion' is distinct from 'ACADEMIC-MOU-2026-10-14-v2'
   or p_receipt->>'termsHash' is null or length(p_receipt->>'termsHash')<>64
   or p_receipt->>'sha256' is null or length(p_receipt->>'sha256')<>64
   or p_receipt->>'documentPath' is null
   or p_receipt->>'documentPath' not like 'agreements-simulation/'||m.company_id::text||'/'||m.id::text||'/%'
   or p_receipt->'consents'->>'terms' is distinct from 'true'
   or p_receipt->'consents'->>'authority' is distinct from 'true'
   or p_receipt->'consents'->>'privacy' is distinct from 'true'
   or p_receipt->'consents'->>'simulation' is distinct from 'true' then
   raise sqlstate 'PT400' using message='Bukti persetujuan simulasi tidak lengkap.';
 end if;
 -- Backend validates current terms hash and generates the PDF; clients cannot execute this RPC.
 update rental_company_agreements set online_simulation=p_receipt || jsonb_build_object('acceptedBy',a.id,'recordedAt',now()),updated_at=now() where id=m.id returning * into m;
 return m.online_simulation;
end $$;
revoke all on function public.transrent_mou_simulation(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.transrent_mou_simulation(uuid,uuid,jsonb) to service_role;

insert into public.transrent_schema_versions(version) values('015');
notify pgrst,'reload schema';
commit;
