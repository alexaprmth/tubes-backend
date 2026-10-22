-- TransRent existing-database bundle 010-014. No bootstrap/seed replay.
-- SQL Editor owner/postgres. Target matches backend/.env, URL fingerprint dfcce416dcb686d3.
-- Stop backend first. Private snapshot is committed before migration; not an offsite backup.
-- On errors: ROLLBACK; fix the cause, rerun this whole file. Installed versions are skipped.
begin;
do $preflight$ begin
 if exists(select 1 from public.rentals where status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW') group by vehicle_id having count(*)>1)
 or exists(select 1 from public.payments where status='PAID' group by reservation_id having count(*)>1)
 or exists(select 1 from public.fines where amount<0 or amount='NaN'::numeric)
 or exists(select 1 from public.refunds f join public.rentals r on r.id=f.rental_id join public.reservations s on s.id=r.reservation_id where f.amount<0 or f.amount='NaN'::numeric or f.amount>s.deposit_amount)
 then raise exception 'Preflight failed: duplicate rentals/payments or invalid amounts. Reconcile first; no automatic deletion.'; end if;
end $preflight$;
do $backup$
declare complete boolean := false; snapshot_name text;
begin
 if to_regclass('public.transrent_schema_versions') is not null then
  select count(*)=5 into complete from public.transrent_schema_versions where version in ('010','011','012','013','014');
 end if;
 if not complete then
  snapshot_name := 'transrent_backup_' || to_char(clock_timestamp() at time zone 'UTC','YYYYMMDD_HH24MISS_US');
  execute replace($backup_sql$
-- OWNER RUNS ONCE, before 010/011. Restricted in-database snapshot, not off-site DR.

create schema __SNAPSHOT__;
revoke all on schema __SNAPSHOT__ from public,anon,authenticated,service_role;
lock table public.reservations,public.payments,public.rentals,public.vehicles,public.inspections,public.inspection_items,public.inspection_photos,public.fines,public.fine_disputes,public.refunds,public.maintenances,public.rental_company_agreements in share mode;
create table __SNAPSHOT__.reservations as table public.reservations;
create table __SNAPSHOT__.payments as table public.payments;
create table __SNAPSHOT__.rentals as table public.rentals;
create table __SNAPSHOT__.vehicles as table public.vehicles;
create table __SNAPSHOT__.inspections as table public.inspections;
create table __SNAPSHOT__.inspection_items as table public.inspection_items;
create table __SNAPSHOT__.inspection_photos as table public.inspection_photos;
create table __SNAPSHOT__.fines as table public.fines;
create table __SNAPSHOT__.fine_disputes as table public.fine_disputes;
create table __SNAPSHOT__.refunds as table public.refunds;
create table __SNAPSHOT__.maintenances as table public.maintenances;
create table __SNAPSHOT__.rental_company_agreements as table public.rental_company_agreements;
create table __SNAPSHOT__.constraints as select conrelid::regclass::text as target,conname,pg_get_constraintdef(oid) as definition from pg_constraint where connamespace='public'::regnamespace;
create table __SNAPSHOT__.indexes as select * from pg_indexes where schemaname='public';
create table __SNAPSHOT__.policies as select * from pg_policies where schemaname='public';
create table __SNAPSHOT__.columns as select * from information_schema.columns where table_schema='public';
create table __SNAPSHOT__.grants as select * from information_schema.role_table_grants where table_schema='public';
create table __SNAPSHOT__.functions as select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,p.proacl::text as acl from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f';
revoke all on all tables in schema __SNAPSHOT__ from public,anon,authenticated,service_role;


$backup_sql$, '__SNAPSHOT__', snapshot_name);
  raise notice 'Private backup schema: %', snapshot_name;
 end if;
end $backup$;
commit;
begin;
select pg_advisory_xact_lock(741014013);
do $updates$
declare needed boolean;
begin

 -- 010_atomic_rental_operations.sql
 if to_regclass('public.transrent_schema_versions') is null then needed := true;
 else select not exists(select 1 from public.transrent_schema_versions where version='010') into needed; end if;
 if needed then
 execute $migration_010$
-- Owner executes once, after preflight and backup. No seed data is replayed.

create table if not exists public.transrent_schema_versions (
  version text primary key, applied_at timestamptz not null default now()
);
alter table public.transrent_schema_versions enable row level security;
revoke all on public.transrent_schema_versions from public, anon, authenticated;
grant select on public.transrent_schema_versions to service_role;
do $$ begin
  if exists(select 1 from public.transrent_schema_versions where version='010') then
    raise exception 'Migration 010 already applied; do not replay';
  end if;
  if exists(select vehicle_id from public.rentals where status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW') group by vehicle_id having count(*)>1) then
    raise exception 'Duplicate active rentals: reconcile manually before migration';
  end if;
  if exists(select reservation_id from public.payments where status='PAID' group by reservation_id having count(*)>1) then
    raise exception 'Duplicate paid payments: reconcile manually before migration';
  end if;
end $$;
alter table public.reservations drop constraint reservations_status_check;
alter table public.reservations add constraint reservations_status_check check(status in ('DRAFT','PENDING_PAYMENT','CONFIRMED','RENTED','COMPLETED','CANCELLED','EXPIRED'));
update public.reservations s set status='COMPLETED' from public.rentals r where r.reservation_id=s.id and r.status='COMPLETED' and s.status='RENTED';
create unique index rentals_one_active_vehicle on public.rentals(vehicle_id) where status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW');
create unique index payments_one_paid_reservation on public.payments(reservation_id) where status='PAID';
alter table public.fines add constraint fines_nonnegative check(amount>=0 and amount<>'NaN'::numeric);
alter table public.refunds add constraint refunds_nonnegative check(amount>=0 and amount<>'NaN'::numeric);
drop policy if exists "customers can create own reservations" on public.reservations;
revoke insert on public.reservations from authenticated, anon;
create index if not exists vehicle_locations_rental_time_idx on public.vehicle_locations(rental_id, recorded_at desc);

-- Service role only; actor is resolved from the verified backend session.
-- Every operation locks the vehicle first, then its reservation/rental rows.
create or replace function public.transrent_transaction(p_actor uuid, p_action text, p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare
  actor profiles%rowtype; v vehicles%rowtype; s reservations%rowtype;
  r rentals%rowtype; pay payments%rowtype; refund refunds%rowtype;
  fine fines%rowtype; m maintenances%rowtype; inspection inspections%rowtype; dispute fine_disputes%rowtype;
  target uuid; vehicle_id_value uuid; start_value date; end_value date;
  actual_value date; mode_value text; days_value integer; late_days integer;
  damage numeric:=0; total_fine numeric:=0; distance_value numeric;
  delivery_value geography; item jsonb; next_value text; damaged boolean;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise sqlstate 'PT400' using message='Payload tidak valid.'; end if;
  select * into actor from profiles where id=p_actor;
  if not found then raise sqlstate 'PT403' using message='Akun tidak ditemukan.'; end if;
  if p_action='RESERVE' then
    vehicle_id_value:=(p_payload->>'vehicleId')::uuid;
  elsif p_action in ('PAY','HANDOVER') then
    target:=(p_payload->>'reservationId')::uuid;
    select vehicle_id into vehicle_id_value from reservations where id=target;
  elsif p_action in ('RETURN','REFUND') then
    target:=(p_payload->>'rentalId')::uuid;
    select vehicle_id into vehicle_id_value from rentals where id=target;
  elsif p_action='DISPUTE' then
    select f.rental_id,rental_row.vehicle_id into target,vehicle_id_value from fines f join rentals rental_row on rental_row.id=f.rental_id where f.id=(p_payload->>'fineId')::uuid;
  elsif p_action='MAINTENANCE' then
    vehicle_id_value:=(p_payload->>'vehicleId')::uuid;
  elsif p_action='MAINTENANCE_STATUS' then
    target:=(p_payload->>'maintenanceId')::uuid;
    select vehicle_id into vehicle_id_value from maintenances where id=target;
  else raise sqlstate 'PT400' using message='Operasi tidak valid.';
  end if;
  select * into v from vehicles where id=vehicle_id_value for update;
  if not found then raise sqlstate 'PT404' using message='Kendaraan atau transaksi tidak ditemukan.'; end if;
  if actor.role<>'CUSTOMER' and actor.role<>'CENTRAL_ADMIN' and actor.company_id is distinct from v.company_id then
    raise sqlstate 'PT403' using message='Akses lintas perusahaan tidak diizinkan.';
  end if;
  if p_action in ('PAY','HANDOVER') then
    select * into s from reservations where id=target for update;
    if actor.role='CUSTOMER' and s.customer_id<>actor.id then raise sqlstate 'PT404' using message='Reservasi tidak ditemukan.'; end if;
  elsif p_action in ('RETURN','REFUND','DISPUTE') then
    select * into r from rentals where id=target for update;
    select * into s from reservations where id=r.reservation_id for update;
  end if;
  if p_action in ('HANDOVER','RETURN') and actor.role not in ('STAFF','RENTAL_ADMIN','CENTRAL_ADMIN') then
    raise sqlstate 'PT403' using message='Role tidak dapat melakukan inspeksi.';
  end if;
  if p_action in ('REFUND','MAINTENANCE','MAINTENANCE_STATUS') and actor.role not in ('RENTAL_ADMIN','CENTRAL_ADMIN') then
    raise sqlstate 'PT403' using message='Hanya admin yang dapat melakukan operasi ini.';
  end if;
  if p_action in ('RESERVE','HANDOVER') then
    if not exists(select 1 from rental_companies where id=v.company_id and status='ACTIVE')
      or not exists(select 1 from rental_company_agreements where company_id=v.company_id and status='ACTIVE' and gps_tracking_allowed and (expires_at is null or expires_at>now())) then
      raise sqlstate 'PT409' using message='Perusahaan atau MoU GPS belum aktif.';
    end if;
    if v.gps_status<>'READY' or not exists(select 1 from gps_devices where id=v.gps_device_id and status='READY')
      or exists(select 1 from maintenances where vehicle_id=v.id and status in ('SCHEDULED','IN_PROGRESS')) then
      raise sqlstate 'PT409' using message='GPS atau kendaraan belum siap.';
    end if;
  end if;

  if p_action='RESERVE' then
    if actor.role<>'CUSTOMER' or actor.verification_status<>'VERIFIED' then raise sqlstate 'PT403' using message='Customer belum terverifikasi.'; end if;
    start_value:=(p_payload->>'startDate')::date; end_value:=(p_payload->>'endDate')::date;
    if start_value is null or end_value is null or end_value<=start_value then raise sqlstate 'PT400' using message='Periode rental tidak valid.'; end if;
    if v.status<>'AVAILABLE' then raise sqlstate 'PT409' using message='Kendaraan tidak tersedia.'; end if;
    if exists(select 1 from reservations where vehicle_id=v.id and status in ('PENDING_PAYMENT','CONFIRMED')
        and (status<>'PENDING_PAYMENT' or expires_at is null or expires_at>now()) and start_date<end_value and end_date>start_value)
      or exists(select 1 from rentals where vehicle_id=v.id and status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW') and start_date<end_value and end_date>start_value) then
      raise sqlstate 'PT409' using message='Periode kendaraan sudah dipesan.';
    end if;
    mode_value:=coalesce(p_payload->>'pickupMode','PICKUP');
    if mode_value not in ('PICKUP','DELIVERY') then raise sqlstate 'PT400' using message='Metode pickup tidak valid.'; end if;
    if mode_value='DELIVERY' then
      if nullif(trim(p_payload->>'deliveryAddress'),'') is null or nullif(trim(p_payload->>'recipientPhone'),'') is null
        or (p_payload->>'deliveryLatitude')::numeric not between -90 and 90 or (p_payload->>'deliveryLongitude')::numeric not between -180 and 180
        or p_payload->>'deliveryLatitude' is null or p_payload->>'deliveryLongitude' is null then
        raise sqlstate 'PT400' using message='Data delivery tidak valid.';
      end if;
      delivery_value:=st_setsrid(st_makepoint((p_payload->>'deliveryLongitude')::float8,(p_payload->>'deliveryLatitude')::float8),4326)::geography;
      select st_distance(location,delivery_value)/1000 into distance_value from branches where id=v.branch_id;
      if distance_value>15 then raise sqlstate 'PT400' using message='Delivery maksimal 15 km.'; end if;
    end if;
    days_value:=end_value-start_value;
    insert into reservations(customer_id,company_id,branch_id,vehicle_id,start_date,end_date,pickup_mode,delivery_address,delivery_location,recipient_phone,delivery_notes,delivery_distance_km,rental_days,rental_amount,deposit_amount,total_amount,status,expires_at)
    values(actor.id,v.company_id,v.branch_id,v.id,start_value,end_value,mode_value,
      case when mode_value='DELIVERY' then p_payload->>'deliveryAddress' end,delivery_value,
      case when mode_value='DELIVERY' then p_payload->>'recipientPhone' end,p_payload->>'deliveryNotes',distance_value,
      days_value,v.price_per_day*days_value,v.deposit_amount,v.price_per_day*days_value+v.deposit_amount,'PENDING_PAYMENT',now()+interval '30 minutes') returning * into s;
    return jsonb_build_object('reservation',to_jsonb(s));
  elsif p_action='PAY' then
    if s.status in ('CONFIRMED','RENTED','COMPLETED') then
      select * into pay from payments where reservation_id=s.id and status='PAID';
      if found then return jsonb_build_object('reservation',to_jsonb(s),'payment',to_jsonb(pay)); end if;
    end if;
    if s.status<>'PENDING_PAYMENT' or s.expires_at is null or s.expires_at<=now() then raise sqlstate 'PT409' using message='Reservasi tidak menunggu pembayaran atau sudah kedaluwarsa.'; end if;
    insert into payments(reservation_id,provider,provider_reference,amount,status,paid_at)
    values(s.id,'SIMULATED_GATEWAY','SIM-'||gen_random_uuid()::text,s.total_amount,'PAID',now()) returning * into pay;
    update reservations set status='CONFIRMED',paid_at=now() where id=s.id returning * into s;
    return jsonb_build_object('reservation',to_jsonb(s),'payment',to_jsonb(pay));
  elsif p_action='HANDOVER' then
    if s.status<>'CONFIRMED' or v.status not in ('AVAILABLE','RESERVED')
      or exists(select 1 from rentals where vehicle_id=v.id and status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW')) then
      raise sqlstate 'PT409' using message='Kendaraan atau reservasi belum siap handover.';
    end if;
    insert into rentals(reservation_id,customer_id,company_id,branch_id,vehicle_id,start_date,end_date,status,handover_at)
    values(s.id,s.customer_id,s.company_id,s.branch_id,v.id,s.start_date,s.end_date,'ACTIVE',now()) returning * into r;
    update reservations set status='RENTED' where id=s.id;
    update vehicles set status='RENTED' where id=v.id;
  elsif p_action='RETURN' then
    if p_payload->>'returnMethod' is not null and p_payload->>'returnMethod' not in ('SELF_RETURN','STAFF_PICKUP') then raise sqlstate 'PT400' using message='Metode return tidak valid.'; end if;
    if r.status<>'ACTIVE' then raise sqlstate 'PT409' using message='Rental tidak sedang aktif.'; end if;
    actual_value:=coalesce((p_payload->>'actualReturnDate')::date,r.end_date);
    if actual_value<r.start_date then raise sqlstate 'PT400' using message='Tanggal return sebelum rental dimulai.'; end if;
    if jsonb_typeof(coalesce(p_payload->'damageItems','[]'::jsonb))<>'array' then raise sqlstate 'PT400' using message='Kerusakan harus daftar.'; end if;
    for item in select value from jsonb_array_elements(coalesce(p_payload->'damageItems','[]'::jsonb)) loop
      if jsonb_typeof(item->'amount') is distinct from 'number' or (item->>'amount')::numeric<0 or (item->>'amount')::numeric<>trunc((item->>'amount')::numeric) then
        raise sqlstate 'PT400' using message='Denda harus rupiah bulat tidak negatif.';
      end if;
      damage:=damage+(item->>'amount')::numeric;
    end loop;
    late_days:=greatest(0,actual_value-r.end_date);
    total_fine:=damage+late_days*round(v.price_per_day*0.25);
    if total_fine>999999999999 then raise sqlstate 'PT400' using message='Total denda melebihi batas.'; end if;
    if total_fine>0 or jsonb_array_length(coalesce(p_payload->'damageItems','[]'::jsonb))>0 then
      insert into fines(rental_id,amount,status,damage_items) values(r.id,total_fine,'ISSUED',coalesce(p_payload->'damageItems','[]'::jsonb)) returning * into fine;
    end if;
    update rentals set status='RETURN_PENDING_REVIEW',returned_at=now(),return_method=coalesce(p_payload->>'returnMethod','SELF_RETURN'),return_schedule=p_payload->'returnSchedule' where id=r.id returning * into r;
    update vehicles set status='RETURN_INSPECTION' where id=v.id;
    insert into refunds(rental_id,amount,status) values(r.id,greatest(0,s.deposit_amount-total_fine),'PENDING_CONFIRMATION') returning * into refund;
  elsif p_action='REFUND' then
    perform id from fines where rental_id=r.id for update;
    select * into refund from refunds where rental_id=r.id for update;
    if r.status='COMPLETED' and refund.status in ('APPROVED','PAID') then return jsonb_build_object('rental',to_jsonb(r),'refund',to_jsonb(refund)); end if;
    if r.status<>'RETURN_PENDING_REVIEW' or refund.id is null or refund.status<>'PENDING_CONFIRMATION' then raise sqlstate 'PT409' using message='Return dan refund harus menunggu konfirmasi.'; end if;
    if exists(select 1 from fines where rental_id=r.id and status='DISPUTED')
      or exists(select 1 from fine_disputes d join fines f on f.id=d.fine_id where f.rental_id=r.id and d.status='OPEN') then
      raise sqlstate 'PT409' using message='Selesaikan sengketa denda sebelum refund.';
    end if;
    if refund.amount>s.deposit_amount then raise sqlstate 'PT409' using message='Refund melebihi deposit.'; end if;
    select exists(select 1 from fines where rental_id=r.id and jsonb_array_length(damage_items)>0 and status<>'CANCELLED') into damaged;
    update refunds set status='APPROVED',confirmed_at=now(),confirmed_by=actor.id where id=refund.id returning * into refund;
    update rentals set status='COMPLETED',completed_at=now() where id=r.id returning * into r;
    update reservations set status='COMPLETED' where id=s.id;
    update vehicles set status=case when damaged or gps_status<>'READY' or exists(select 1 from maintenances where vehicle_id=v.id and status in ('SCHEDULED','IN_PROGRESS')) then 'MAINTENANCE' else 'AVAILABLE' end where id=v.id;
    return jsonb_build_object('rental',to_jsonb(r),'refund',to_jsonb(refund));
  elsif p_action='DISPUTE' then
    if actor.role<>'CUSTOMER' or r.customer_id<>actor.id then raise sqlstate 'PT403' using message='Akses sengketa tidak diizinkan.'; end if;
    if r.status<>'RETURN_PENDING_REVIEW' then raise sqlstate 'PT409' using message='Rental tidak menunggu review return.'; end if;
    if nullif(trim(p_payload->>'reason'),'') is null then raise sqlstate 'PT400' using message='Alasan sengketa wajib diisi.'; end if;
    select * into fine from fines where id=(p_payload->>'fineId')::uuid for update;
    if fine.status not in ('ISSUED','ADJUSTED') then raise sqlstate 'PT409' using message='Denda tidak dapat disengketakan.'; end if;
    insert into fine_disputes(fine_id,customer_id,reason,status) values(fine.id,actor.id,p_payload->>'reason','OPEN') returning * into dispute;
    update fines set status='DISPUTED' where id=fine.id;
    return jsonb_build_object('dispute',to_jsonb(dispute));
  elsif p_action='MAINTENANCE' then
    if exists(select 1 from rentals where vehicle_id=v.id and status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW')) then raise sqlstate 'PT409' using message='Kendaraan masih memiliki rental aktif.'; end if;
    if v.status='INACTIVE' then raise sqlstate 'PT409' using message='Kendaraan dinonaktifkan.'; end if;
    insert into maintenances(company_id,branch_id,vehicle_id,type,title,status,scheduled_at,notes)
    values(v.company_id,v.branch_id,v.id,coalesce(p_payload->>'type','SERVICE'),coalesce(p_payload->>'title','Maintenance kendaraan'),'SCHEDULED',coalesce((p_payload->>'scheduledAt')::timestamptz,now()),p_payload->>'notes') returning * into m;
    update vehicles set status='MAINTENANCE' where id=v.id;
    return jsonb_build_object('maintenance',to_jsonb(m));
  elsif p_action='MAINTENANCE_STATUS' then
    select * into m from maintenances where id=target for update;
    next_value:=p_payload->>'nextStatus';
    if next_value is null or next_value not in ('IN_PROGRESS','COMPLETED','CANCELLED') or m.status not in ('SCHEDULED','IN_PROGRESS') or (next_value='IN_PROGRESS' and m.status<>'SCHEDULED') then
      raise sqlstate 'PT409' using message='Transisi maintenance tidak valid.';
    end if;
    update maintenances set status=next_value,completed_at=case when next_value='COMPLETED' then now() end where id=m.id returning * into m;
    if next_value in ('COMPLETED','CANCELLED') and v.status='MAINTENANCE' and v.gps_status='READY'
      and not exists(select 1 from maintenances where vehicle_id=v.id and status in ('SCHEDULED','IN_PROGRESS'))
      and not exists(select 1 from rentals where vehicle_id=v.id and status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW')) then
      update vehicles set status='AVAILABLE' where id=v.id;
    end if;
    return jsonb_build_object('maintenance',to_jsonb(m));
  end if;

  -- Both inspection variants are persisted in the same transaction as the rental.
  insert into inspections(rental_id,type,staff_id,customer_signature_path,notes)
  values(r.id,case when p_action='HANDOVER' then 'BEFORE' else 'AFTER' end,actor.id,p_payload->>'customerSignature',p_payload->>'notes') returning * into inspection;
  insert into inspection_items(inspection_id,item_key) select inspection.id,value from jsonb_array_elements_text(coalesce(p_payload->'staffChecklist','[]'::jsonb));
  insert into inspection_photos(inspection_id,source,storage_path)
    select inspection.id,'STAFF',value from jsonb_array_elements_text(coalesce(p_payload->'staffPhotos','[]'::jsonb))
    union all select inspection.id,'CUSTOMER',value from jsonb_array_elements_text(coalesce(p_payload->'customerPhotos','[]'::jsonb));
  return jsonb_build_object('rental',to_jsonb(r),'inspection',to_jsonb(inspection),'fine',case when fine.id is null then null else to_jsonb(fine) end,'refund',case when refund.id is null then null else to_jsonb(refund) end,'refundAmount',refund.amount);
exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
  raise sqlstate 'PT400' using message='Format ID, tanggal atau nominal tidak valid.';
end $$;
revoke all on function public.transrent_transaction(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.transrent_transaction(uuid,text,jsonb) to service_role;
insert into public.transrent_schema_versions(version) values('010');
notify pgrst, 'reload schema';
$migration_010$;
 else raise notice 'Skip 010: already applied'; end if;

 -- 011_mou_owner_upload.sql
 if to_regclass('public.transrent_schema_versions') is null then needed := true;
 else select not exists(select 1 from public.transrent_schema_versions where version='011') into needed; end if;
 if needed then
 execute $migration_011$
do $$ begin
 if not exists(select 1 from public.transrent_schema_versions where version='010') then raise exception 'Apply 010 first'; end if;
 if exists(select 1 from public.transrent_schema_versions where version='011') then raise exception '011 already applied'; end if;
end $$;
alter table public.rental_company_agreements add column document_metadata jsonb not null default '{}'::jsonb;
create or replace function public.transrent_mou(p_actor uuid,p_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a profiles%rowtype; m rental_company_agreements%rowtype; next_status text;
begin
 select * into a from profiles where id=p_actor;
 if not found then raise sqlstate 'PT403' using message='Akun tidak ditemukan.'; end if;
 select * into m from rental_company_agreements where id=p_id for update;
 if not found then raise sqlstate 'PT404' using message='MoU tidak ditemukan.'; end if;
 if p_action='UPLOAD' then
   if a.role<>'RENTAL_ADMIN' or a.company_id is distinct from m.company_id then raise sqlstate 'PT403' using message='Hanya pemilik perusahaan ini yang dapat mengunggah.'; end if;
   if m.status not in ('DRAFT','PENDING') then raise sqlstate 'PT409' using message='Dokumen aktif tidak dapat diganti.'; end if;
   if (p_payload->>'expiresAt')::timestamptz <= now() or (p_payload->>'expiresAt')::timestamptz <= (p_payload->>'signedAt')::timestamptz then raise sqlstate 'PT400' using message='Tanggal MoU tidak valid.'; end if;
   update rental_company_agreements set document_path=p_payload->>'path',document_metadata=p_payload->'metadata',status='PENDING',gps_tracking_allowed=false,signed_at=(p_payload->>'signedAt')::timestamptz,expires_at=(p_payload->>'expiresAt')::timestamptz,updated_at=now() where id=m.id returning * into m;
 elsif p_action='REVIEW' then
   if a.role<>'CENTRAL_ADMIN' then raise sqlstate 'PT403' using message='Hanya Admin Pusat dapat mereview.'; end if;
   next_status:=p_payload->>'status';
   if next_status is null or next_status not in ('DRAFT','PENDING','ACTIVE','EXPIRED','REVOKED') then raise sqlstate 'PT400' using message='Status tidak valid.'; end if;
   if next_status='ACTIVE' then
     if m.document_path is null or m.document_metadata->>'sha256' is null or p_payload->>'reviewedSha256' is distinct from m.document_metadata->>'sha256' or p_payload->>'reviewed' is distinct from 'true'
       or m.signed_at is null or m.signed_at>now() or m.expires_at is null or m.expires_at<=now() then
       raise sqlstate 'PT409' using message='Periksa PDF final kedua pihak, meterai, dan masa berlaku sebelum aktivasi.';
     end if;
     if not exists(select 1 from rental_companies where id=m.company_id and status='ACTIVE') then raise sqlstate 'PT409' using message='Perusahaan harus aktif.'; end if;
   end if;
   update rental_company_agreements set status=next_status,gps_tracking_allowed=next_status='ACTIVE' and coalesce((p_payload->>'gpsTrackingAllowed')::boolean,true),
     document_metadata=case when next_status='ACTIVE' then document_metadata || jsonb_build_object('reviewed',true,'reviewedBy',a.id,'reviewedAt',now()) else document_metadata end,updated_at=now() where id=m.id returning * into m;
 else raise sqlstate 'PT400' using message='Operasi tidak valid.';
 end if;
 return to_jsonb(m);
end $$;
revoke all on function public.transrent_mou(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.transrent_mou(uuid,uuid,text,jsonb) to service_role;
insert into public.transrent_schema_versions(version) values('011');
notify pgrst,'reload schema';
$migration_011$;
 else raise notice 'Skip 011: already applied'; end if;

 -- 012_online_mou_simulation.sql
 if to_regclass('public.transrent_schema_versions') is null then needed := true;
 else select not exists(select 1 from public.transrent_schema_versions where version='012') into needed; end if;
 if needed then
 execute $migration_012$
-- Owner SQL Editor only. Simulation receipt is separate from the final MoU.

do $$ begin
 if not exists(select 1 from public.transrent_schema_versions where version='011') then raise exception 'Apply 011 first'; end if;
 if exists(select 1 from public.transrent_schema_versions where version='012') then raise exception '012 already applied'; end if;
end $$;
alter table public.rental_company_agreements add column online_simulation jsonb;
create or replace function public.transrent_mou_simulation(p_actor uuid,p_id uuid,p_receipt jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a profiles%rowtype; m rental_company_agreements%rowtype;
begin
 select * into a from profiles where id=p_actor;
 if not found or a.role<>'RENTAL_ADMIN' then raise sqlstate 'PT403' using message='Hanya pemilik rental dapat menyetujui.'; end if;
 select * into m from rental_company_agreements where id=p_id for update;
 if not found then raise sqlstate 'PT404' using message='MoU tidak ditemukan.'; end if;
 if a.company_id is distinct from m.company_id then raise sqlstate 'PT403' using message='Perusahaan tidak diizinkan.'; end if;
 if m.status not in ('DRAFT','PENDING') or m.online_simulation is not null then raise sqlstate 'PT409' using message='Simulasi sudah dibuat atau MoU bukan draft/pending.'; end if;
 if p_receipt is null or p_receipt->>'mode' is distinct from 'ACADEMIC_SIMULATION'
   or p_receipt->>'acceptedBy' is distinct from a.id::text
   or p_receipt->>'termsVersion' is distinct from 'ACADEMIC-MOU-2026-10-14-v1'
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
insert into public.transrent_schema_versions(version) values('012');
notify pgrst,'reload schema';
$migration_012$;
 else raise notice 'Skip 012: already applied'; end if;

 -- 013_online_mou_draft_terms.sql
 if to_regclass('public.transrent_schema_versions') is null then needed := true;
 else select not exists(select 1 from public.transrent_schema_versions where version='013') into needed; end if;
 if needed then
 execute $migration_013$
-- Draf wording v2; existing receipts stay unchanged. Owner SQL Editor only.

do $$ begin
 if not exists(select 1 from public.transrent_schema_versions where version='012') then raise exception 'Apply 012 first'; end if;
 if exists(select 1 from public.transrent_schema_versions where version='013') then raise exception '013 already applied'; end if;
end $$;
create or replace function public.transrent_mou_simulation(p_actor uuid,p_id uuid,p_receipt jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a profiles%rowtype; m rental_company_agreements%rowtype;
begin
 select * into a from profiles where id=p_actor;
 if not found or a.role<>'RENTAL_ADMIN' then raise sqlstate 'PT403' using message='Hanya pemilik rental dapat menyetujui.'; end if;
 select * into m from rental_company_agreements where id=p_id for update;
 if not found then raise sqlstate 'PT404' using message='MoU tidak ditemukan.'; end if;
 if a.company_id is distinct from m.company_id then raise sqlstate 'PT403' using message='Perusahaan tidak diizinkan.'; end if;
 if m.status not in ('DRAFT','PENDING') or m.online_simulation is not null then raise sqlstate 'PT409' using message='Simulasi sudah dibuat atau MoU bukan draft/pending.'; end if;
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
insert into public.transrent_schema_versions(version) values('013');
notify pgrst,'reload schema';
$migration_013$;
 else raise notice 'Skip 013: already applied'; end if;

 if not exists(select 1 from public.transrent_schema_versions where version='014') then
 execute $migration_014$
-- Owner execution only. Requires 010-013. No seed/auth data or real gateway calls.
do $$ begin
 if exists(select 1 from public.transrent_schema_versions where version='014') then raise exception 'Migration 014 already applied; use the guarded bundle'; end if;
 if (select count(*) from public.transrent_schema_versions where version in ('010','011','012','013'))<>4 then raise exception 'Apply prerequisites 010-013 through the bundle'; end if;
 if exists(select fine_id from public.fine_disputes where status='OPEN' group by fine_id having count(*)>1) then raise exception 'Duplicate open disputes: reconcile before migration'; end if;
end $$;
alter table public.vehicles add column repair_required boolean not null default false;
alter table public.reservations add column cancellation jsonb;
alter table public.rentals add column fine_payment jsonb;
alter table public.fine_disputes add column resolved_by uuid references public.profiles(id) on delete restrict,
 add column resolution_notes text, add column original_amount numeric(14,2), add column final_amount numeric(14,2);
create unique index fine_disputes_one_open on public.fine_disputes(fine_id) where status='OPEN';
alter table public.fine_disputes add constraint dispute_resolution_amounts check(original_amount>=0 and final_amount>=0 and original_amount<>'NaN'::numeric and final_amount<>'NaN'::numeric);
-- Conservative legacy backfill: only a completed REPAIR after the damage is evidence of repair.
update public.vehicles v set repair_required=true where exists(
 select 1 from public.rentals r join public.fines f on f.rental_id=r.id where r.vehicle_id=v.id and jsonb_array_length(f.damage_items)>0
 and not exists(select 1 from public.maintenances m where m.vehicle_id=v.id and m.type='REPAIR' and m.status='COMPLETED' and m.completed_at>coalesce(r.returned_at,f.created_at)));
update public.vehicles set status='MAINTENANCE' where repair_required and status in ('AVAILABLE','RESERVED');
create or replace function public.transrent_transaction_v2(p_actor uuid, p_action text, p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare
  actor profiles%rowtype; v vehicles%rowtype; s reservations%rowtype;
  r rentals%rowtype; pay payments%rowtype; refund refunds%rowtype;
  fine fines%rowtype; m maintenances%rowtype; inspection inspections%rowtype; dispute fine_disputes%rowtype;
  target uuid; vehicle_id_value uuid; start_value date; end_value date;
  actual_value date; mode_value text; days_value integer; late_days integer;
  damage numeric:=0; total_fine numeric:=0; distance_value numeric;
  delivery_value geography; item jsonb; next_value text; damaged boolean;
  paid_extra numeric:=0; due numeric:=0; decision text; notes_value text; amount_value numeric;
  cancellation_value jsonb;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise sqlstate 'PT400' using message='Payload tidak valid.'; end if;
  select * into actor from profiles where id=p_actor;
  if not found then raise sqlstate 'PT403' using message='Akun tidak ditemukan.'; end if;
  if p_action='RESERVE' then
    vehicle_id_value:=(p_payload->>'vehicleId')::uuid;
  elsif p_action in ('PAY','HANDOVER','CANCEL') then
    target:=(p_payload->>'reservationId')::uuid;
    select vehicle_id into vehicle_id_value from reservations where id=target;
  elsif p_action in ('RETURN','REFUND','PAY_FINE') then
    target:=(p_payload->>'rentalId')::uuid;
    select vehicle_id into vehicle_id_value from rentals where id=target;
  elsif p_action='DISPUTE' then
    select f.rental_id,rental_row.vehicle_id into target,vehicle_id_value from fines f join rentals rental_row on rental_row.id=f.rental_id where f.id=(p_payload->>'fineId')::uuid;
  elsif p_action='RESOLVE_DISPUTE' then
    select f.rental_id,rr.vehicle_id into target,vehicle_id_value from fine_disputes d join fines f on f.id=d.fine_id join rentals rr on rr.id=f.rental_id where d.id=(p_payload->>'disputeId')::uuid;
  elsif p_action='MAINTENANCE' then
    vehicle_id_value:=(p_payload->>'vehicleId')::uuid;
  elsif p_action='MAINTENANCE_STATUS' then
    target:=(p_payload->>'maintenanceId')::uuid;
    select vehicle_id into vehicle_id_value from maintenances where id=target;
  else raise sqlstate 'PT400' using message='Operasi tidak valid.';
  end if;
  select * into v from vehicles where id=vehicle_id_value for update;
  if not found then raise sqlstate 'PT404' using message='Kendaraan atau transaksi tidak ditemukan.'; end if;
  if actor.role<>'CUSTOMER' and actor.role<>'CENTRAL_ADMIN' and actor.company_id is distinct from v.company_id then
    raise sqlstate 'PT403' using message='Akses lintas perusahaan tidak diizinkan.';
  end if;
  if p_action in ('PAY','HANDOVER','CANCEL') then
    select * into s from reservations where id=target for update;
    if actor.role='CUSTOMER' and s.customer_id<>actor.id then raise sqlstate 'PT404' using message='Reservasi tidak ditemukan.'; end if;
  elsif p_action in ('RETURN','REFUND','DISPUTE','RESOLVE_DISPUTE','PAY_FINE') then
    select * into r from rentals where id=target for update;
    select * into s from reservations where id=r.reservation_id for update;
  end if;
  if p_action in ('HANDOVER','RETURN') and actor.role not in ('STAFF','RENTAL_ADMIN','CENTRAL_ADMIN') then
    raise sqlstate 'PT403' using message='Role tidak dapat melakukan inspeksi.';
  end if;
  if p_action in ('REFUND','MAINTENANCE','MAINTENANCE_STATUS','RESOLVE_DISPUTE') and actor.role not in ('RENTAL_ADMIN','CENTRAL_ADMIN') then
    raise sqlstate 'PT403' using message='Hanya admin yang dapat melakukan operasi ini.';
  end if;
  if p_action in ('PAY','PAY_FINE') and (actor.role<>'CUSTOMER' or s.customer_id<>actor.id) then
    raise sqlstate 'PT403' using message='Hanya customer pemilik transaksi yang dapat membayar.';
  end if;
  if p_action in ('RESERVE','HANDOVER') or (p_action='PAY' and s.status='PENDING_PAYMENT') then
    if not exists(select 1 from profiles where id=case when p_action='RESERVE' then actor.id else s.customer_id end and role='CUSTOMER' and verification_status='VERIFIED') then
      raise sqlstate 'PT403' using message='Customer belum terverifikasi.';
    end if;
    if v.repair_required then raise sqlstate 'PT409' using message='Kendaraan masih memerlukan perbaikan.'; end if;
    if not exists(select 1 from rental_companies where id=v.company_id and status='ACTIVE')
      or not exists(select 1 from rental_company_agreements where company_id=v.company_id and status='ACTIVE' and gps_tracking_allowed and (expires_at is null or expires_at>now())) then
      raise sqlstate 'PT409' using message='Perusahaan atau MoU GPS belum aktif.';
    end if;
    if v.gps_status<>'READY' or not exists(select 1 from gps_devices where id=v.gps_device_id and status='READY')
      or exists(select 1 from maintenances where vehicle_id=v.id and status in ('SCHEDULED','IN_PROGRESS')) then
      raise sqlstate 'PT409' using message='GPS atau kendaraan belum siap.';
    end if;
  end if;

  if p_action='RESERVE' then
    if actor.role<>'CUSTOMER' or actor.verification_status<>'VERIFIED' then raise sqlstate 'PT403' using message='Customer belum terverifikasi.'; end if;
    start_value:=(p_payload->>'startDate')::date; end_value:=(p_payload->>'endDate')::date;
    if start_value is null or end_value is null or end_value<=start_value then raise sqlstate 'PT400' using message='Periode rental tidak valid.'; end if;
    if v.status<>'AVAILABLE' then raise sqlstate 'PT409' using message='Kendaraan tidak tersedia.'; end if;
    if exists(select 1 from reservations where vehicle_id=v.id and status in ('PENDING_PAYMENT','CONFIRMED')
        and (status<>'PENDING_PAYMENT' or expires_at is null or expires_at>now()) and start_date<end_value and end_date>start_value)
      or exists(select 1 from rentals where vehicle_id=v.id and status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW') and start_date<end_value and end_date>start_value) then
      raise sqlstate 'PT409' using message='Periode kendaraan sudah dipesan.';
    end if;
    mode_value:=coalesce(p_payload->>'pickupMode','PICKUP');
    if mode_value not in ('PICKUP','DELIVERY') then raise sqlstate 'PT400' using message='Metode pickup tidak valid.'; end if;
    if mode_value='DELIVERY' then
      if nullif(trim(p_payload->>'deliveryAddress'),'') is null or nullif(trim(p_payload->>'recipientPhone'),'') is null
        or (p_payload->>'deliveryLatitude')::numeric not between -90 and 90 or (p_payload->>'deliveryLongitude')::numeric not between -180 and 180
        or p_payload->>'deliveryLatitude' is null or p_payload->>'deliveryLongitude' is null then
        raise sqlstate 'PT400' using message='Data delivery tidak valid.';
      end if;
      delivery_value:=st_setsrid(st_makepoint((p_payload->>'deliveryLongitude')::float8,(p_payload->>'deliveryLatitude')::float8),4326)::geography;
      select st_distance(location,delivery_value)/1000 into distance_value from branches where id=v.branch_id;
      if distance_value>15 then raise sqlstate 'PT400' using message='Delivery maksimal 15 km.'; end if;
    end if;
    days_value:=end_value-start_value;
    insert into reservations(customer_id,company_id,branch_id,vehicle_id,start_date,end_date,pickup_mode,delivery_address,delivery_location,recipient_phone,delivery_notes,delivery_distance_km,rental_days,rental_amount,deposit_amount,total_amount,status,expires_at)
    values(actor.id,v.company_id,v.branch_id,v.id,start_value,end_value,mode_value,
      case when mode_value='DELIVERY' then p_payload->>'deliveryAddress' end,delivery_value,
      case when mode_value='DELIVERY' then p_payload->>'recipientPhone' end,p_payload->>'deliveryNotes',distance_value,
      days_value,v.price_per_day*days_value,v.deposit_amount,v.price_per_day*days_value+v.deposit_amount,'PENDING_PAYMENT',now()+interval '30 minutes') returning * into s;
    return jsonb_build_object('reservation',to_jsonb(s));
  elsif p_action='PAY' then
    if s.status in ('CONFIRMED','RENTED','COMPLETED') then
      select * into pay from payments where reservation_id=s.id and status='PAID';
      if found then return jsonb_build_object('reservation',to_jsonb(s),'payment',to_jsonb(pay)); end if;
    end if;
    if s.status<>'PENDING_PAYMENT' or s.expires_at is null or s.expires_at<=now() then raise sqlstate 'PT409' using message='Reservasi tidak menunggu pembayaran atau sudah kedaluwarsa.'; end if;
    if v.status not in ('AVAILABLE','RESERVED') or exists(select 1 from rentals where vehicle_id=v.id and status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW')) then raise sqlstate 'PT409' using message='Kendaraan belum siap untuk pembayaran.'; end if;
    insert into payments(reservation_id,provider,provider_reference,amount,status,paid_at)
    values(s.id,'SIMULATED_GATEWAY','SIM-'||gen_random_uuid()::text,s.total_amount,'PAID',now()) returning * into pay;
    update reservations set status='CONFIRMED',paid_at=now() where id=s.id returning * into s;
    return jsonb_build_object('reservation',to_jsonb(s),'payment',to_jsonb(pay));
  elsif p_action='CANCEL' then
    if actor.role='CUSTOMER' then
      if s.customer_id<>actor.id then raise sqlstate 'PT404' using message='Reservasi tidak ditemukan.'; end if;
    elsif actor.role not in ('RENTAL_ADMIN','CENTRAL_ADMIN') then raise sqlstate 'PT403' using message='Role tidak dapat membatalkan reservasi.'; end if;
    if s.status='CANCELLED' and s.cancellation is not null then return jsonb_build_object('reservation',to_jsonb(s)); end if;
    if s.status not in ('DRAFT','PENDING_PAYMENT','CONFIRMED') or exists(select 1 from rentals where reservation_id=s.id) then raise sqlstate 'PT409' using message='Pembatalan hanya sebelum handover.'; end if;
    notes_value:=trim(p_payload->>'reason');
    if notes_value is null or length(notes_value) not between 1 and 2000 then raise sqlstate 'PT400' using message='Alasan pembatalan wajib 1-2000 karakter.'; end if;
    select * into pay from payments where reservation_id=s.id and status='PAID' for update;
    if pay.id is not null and pay.provider<>'SIMULATED_GATEWAY' then raise sqlstate 'PT409' using message='Pembayaran riil memerlukan refund melalui provider resmi.'; end if;
    if s.status='CONFIRMED' and pay.id is null then raise sqlstate 'PT409' using message='Pembayaran reservasi tidak konsisten; perlu rekonsiliasi.'; end if;
    cancellation_value:=jsonb_build_object('id',gen_random_uuid(),'reason',notes_value,'cancelledBy',actor.id,'cancelledAt',now(),'refundAmount',coalesce(pay.amount,0),'refundStatus',case when pay.id is null then 'NOT_REQUIRED' else 'REFUNDED_SIMULATED' end,'provider','SIMULATED_GATEWAY','paymentId',pay.id);
    update reservations set status='CANCELLED',cancelled_at=now(),cancellation=cancellation_value where id=s.id returning * into s;
    -- Preserve the original payment amount/reference; the cancellation is its refund receipt.
    if pay.id is not null then update payments set status='REFUNDED' where id=pay.id; end if;
    return jsonb_build_object('reservation',to_jsonb(s));
  elsif p_action='HANDOVER' then
    if s.status<>'CONFIRMED' or v.status not in ('AVAILABLE','RESERVED')
      or exists(select 1 from rentals where vehicle_id=v.id and status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW')) then
      raise sqlstate 'PT409' using message='Kendaraan atau reservasi belum siap handover.';
    end if;
    insert into rentals(reservation_id,customer_id,company_id,branch_id,vehicle_id,start_date,end_date,status,handover_at)
    values(s.id,s.customer_id,s.company_id,s.branch_id,v.id,s.start_date,s.end_date,'ACTIVE',now()) returning * into r;
    update reservations set status='RENTED' where id=s.id;
    update vehicles set status='RENTED' where id=v.id;
  elsif p_action='RETURN' then
    if p_payload->>'returnMethod' is not null and p_payload->>'returnMethod' not in ('SELF_RETURN','STAFF_PICKUP') then raise sqlstate 'PT400' using message='Metode return tidak valid.'; end if;
    if r.status<>'ACTIVE' then raise sqlstate 'PT409' using message='Rental tidak sedang aktif.'; end if;
    actual_value:=coalesce((p_payload->>'actualReturnDate')::date,r.end_date);
    if actual_value<r.start_date then raise sqlstate 'PT400' using message='Tanggal return sebelum rental dimulai.'; end if;
    if jsonb_typeof(coalesce(p_payload->'damageItems','[]'::jsonb))<>'array' then raise sqlstate 'PT400' using message='Kerusakan harus daftar.'; end if;
    for item in select value from jsonb_array_elements(coalesce(p_payload->'damageItems','[]'::jsonb)) loop
      if jsonb_typeof(item->'amount') is distinct from 'number' or (item->>'amount')::numeric<0 or (item->>'amount')::numeric<>trunc((item->>'amount')::numeric) then
        raise sqlstate 'PT400' using message='Denda harus rupiah bulat tidak negatif.';
      end if;
      damage:=damage+(item->>'amount')::numeric;
    end loop;
    late_days:=greatest(0,actual_value-r.end_date);
    total_fine:=damage+late_days*round(v.price_per_day*0.25);
    if total_fine>999999999999 then raise sqlstate 'PT400' using message='Total denda melebihi batas.'; end if;
    if total_fine>0 or jsonb_array_length(coalesce(p_payload->'damageItems','[]'::jsonb))>0 then
      insert into fines(rental_id,amount,status,damage_items) values(r.id,total_fine,'ISSUED',coalesce(p_payload->'damageItems','[]'::jsonb)) returning * into fine;
    end if;
    update rentals set status='RETURN_PENDING_REVIEW',returned_at=now(),return_method=coalesce(p_payload->>'returnMethod','SELF_RETURN'),return_schedule=p_payload->'returnSchedule' where id=r.id returning * into r;
    update vehicles set status='RETURN_INSPECTION',repair_required=repair_required or jsonb_array_length(coalesce(p_payload->'damageItems','[]'::jsonb))>0 where id=v.id;
    insert into refunds(rental_id,amount,status) values(r.id,greatest(0,s.deposit_amount-total_fine),'PENDING_CONFIRMATION') returning * into refund;
  elsif p_action='REFUND' then
    perform id from fines where rental_id=r.id for update;
    select * into refund from refunds where rental_id=r.id for update;
    if r.status='COMPLETED' and refund.status in ('APPROVED','PAID') then return jsonb_build_object('rental',to_jsonb(r),'refund',to_jsonb(refund)); end if;
    if r.status<>'RETURN_PENDING_REVIEW' or refund.id is null or refund.status<>'PENDING_CONFIRMATION' then raise sqlstate 'PT409' using message='Return dan refund harus menunggu konfirmasi.'; end if;
    if exists(select 1 from fines where rental_id=r.id and status='DISPUTED')
      or exists(select 1 from fine_disputes d join fines f on f.id=d.fine_id where f.rental_id=r.id and d.status='OPEN') then
      raise sqlstate 'PT409' using message='Selesaikan sengketa denda sebelum refund.';
    end if;
    select coalesce(sum(amount),0) into total_fine from fines where rental_id=r.id and status<>'CANCELLED';
    paid_extra:=coalesce((r.fine_payment->>'amount')::numeric,0);
    if greatest(0,total_fine-s.deposit_amount-paid_extra)>0 then raise sqlstate 'PT409' using message='Selisih denda harus dilunasi sebelum menutup rental.'; end if;
    update refunds set amount=greatest(0,s.deposit_amount-total_fine) where id=refund.id returning * into refund;
    if refund.amount>s.deposit_amount then raise sqlstate 'PT409' using message='Refund melebihi deposit.'; end if;
    select exists(select 1 from fines where rental_id=r.id and jsonb_array_length(damage_items)>0 and status<>'CANCELLED') into damaged;
    update refunds set status='APPROVED',confirmed_at=now(),confirmed_by=actor.id where id=refund.id returning * into refund;
    update rentals set status='COMPLETED',completed_at=now() where id=r.id returning * into r;
    update reservations set status='COMPLETED' where id=s.id;
    update vehicles set status=case when repair_required or damaged or gps_status<>'READY' or exists(select 1 from maintenances where vehicle_id=v.id and status in ('SCHEDULED','IN_PROGRESS')) then 'MAINTENANCE' else 'AVAILABLE' end where id=v.id;
    return jsonb_build_object('rental',to_jsonb(r),'refund',to_jsonb(refund));
  elsif p_action='DISPUTE' then
    if actor.role<>'CUSTOMER' or r.customer_id<>actor.id then raise sqlstate 'PT403' using message='Akses sengketa tidak diizinkan.'; end if;
    if r.status<>'RETURN_PENDING_REVIEW' then raise sqlstate 'PT409' using message='Rental tidak menunggu review return.'; end if;
    if nullif(trim(p_payload->>'reason'),'') is null then raise sqlstate 'PT400' using message='Alasan sengketa wajib diisi.'; end if;
    select * into fine from fines where id=(p_payload->>'fineId')::uuid for update;
    if r.fine_payment is not null or fine.status not in ('ISSUED','ADJUSTED') then raise sqlstate 'PT409' using message='Denda tidak dapat disengketakan.'; end if;
    insert into fine_disputes(fine_id,customer_id,reason,status) values(fine.id,actor.id,p_payload->>'reason','OPEN') returning * into dispute;
    update fines set status='DISPUTED' where id=fine.id;
    return jsonb_build_object('dispute',to_jsonb(dispute));
  elsif p_action='RESOLVE_DISPUTE' then
    select * into dispute from fine_disputes where id=(p_payload->>'disputeId')::uuid for update;
    select * into fine from fines where id=dispute.fine_id for update;
    decision:=p_payload->>'decision'; notes_value:=trim(p_payload->>'notes');
    if decision is null or decision not in ('ACCEPTED','REJECTED','ADJUSTED') or notes_value is null or length(notes_value) not between 1 and 2000 then raise sqlstate 'PT400' using message='Keputusan dan alasan admin wajib diisi.'; end if;
    if decision='ADJUSTED' and (jsonb_typeof(p_payload->'amount') is distinct from 'number' or (p_payload->>'amount')::numeric<0 or (p_payload->>'amount')::numeric<>trunc((p_payload->>'amount')::numeric) or (p_payload->>'amount')::numeric>fine.amount) then raise sqlstate 'PT400' using message='Denda penyesuaian harus rupiah bulat antara nol dan denda awal.'; end if;
    amount_value:=case decision when 'ACCEPTED' then 0 when 'REJECTED' then fine.amount else (p_payload->>'amount')::numeric end;
    if dispute.status<>'OPEN' then
      if dispute.status=decision and dispute.resolution_notes=notes_value and (decision<>'ADJUSTED' or dispute.final_amount=(p_payload->>'amount')::numeric) then return jsonb_build_object('dispute',to_jsonb(dispute),'rental',to_jsonb(r)); end if;
      raise sqlstate 'PT409' using message='Sengketa sudah diputuskan; keputusan tidak dapat ditimpa.';
    end if;
    if r.status<>'RETURN_PENDING_REVIEW' or fine.status<>'DISPUTED' or r.fine_payment is not null then raise sqlstate 'PT409' using message='Sengketa tidak dapat diputuskan pada status ini.'; end if;
    update fine_disputes set status=decision,original_amount=fine.amount,final_amount=amount_value,resolution_notes=notes_value,resolved_by=actor.id,resolved_at=now() where id=dispute.id returning * into dispute;
    update fines set amount=amount_value,status=case when decision='ACCEPTED' then 'CANCELLED' else 'APPROVED' end where id=fine.id;
    select coalesce(sum(amount),0) into total_fine from fines where rental_id=r.id and status<>'CANCELLED';
    update refunds set amount=greatest(0,s.deposit_amount-total_fine) where rental_id=r.id and status='PENDING_CONFIRMATION';
    -- Liability and physical condition are independent: a waived fine does not repair the vehicle.
    return jsonb_build_object('dispute',to_jsonb(dispute),'rental',to_jsonb(r));
  elsif p_action='PAY_FINE' then
    if r.fine_payment is not null then return jsonb_build_object('rental',to_jsonb(r),'payment',r.fine_payment); end if;
    if r.status not in ('RETURN_PENDING_REVIEW','COMPLETED') then raise sqlstate 'PT409' using message='Rental belum selesai inspeksi return.'; end if;
    if exists(select 1 from fines where rental_id=r.id and status='DISPUTED') or exists(select 1 from fine_disputes d join fines f on f.id=d.fine_id where f.rental_id=r.id and d.status='OPEN') then raise sqlstate 'PT409' using message='Selesaikan sengketa sebelum membayar selisih denda.'; end if;
    perform id from fines where rental_id=r.id for update;
    select coalesce(sum(amount),0) into total_fine from fines where rental_id=r.id and status<>'CANCELLED';
    due:=greatest(0,total_fine-s.deposit_amount);
    if due<=0 then raise sqlstate 'PT409' using message='Tidak ada selisih denda yang harus dibayar.'; end if;
    update rentals set fine_payment=jsonb_build_object('id',gen_random_uuid(),'provider','SIMULATED_GATEWAY','providerReference','FINE-SIM-'||gen_random_uuid(),'amount',due,'status','PAID','paidBy',actor.id,'paidAt',now()) where id=r.id returning * into r;
    update fines set status='APPROVED' where rental_id=r.id and status<>'CANCELLED';
    return jsonb_build_object('rental',to_jsonb(r),'payment',r.fine_payment);
  elsif p_action='MAINTENANCE' then
    if coalesce(p_payload->>'type','SERVICE') not in ('SERVICE','REPAIR') then raise sqlstate 'PT400' using message='Jenis maintenance harus SERVICE atau REPAIR.'; end if;
    if exists(select 1 from rentals where vehicle_id=v.id and status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW')) then raise sqlstate 'PT409' using message='Kendaraan masih memiliki rental aktif.'; end if;
    if v.status='INACTIVE' then raise sqlstate 'PT409' using message='Kendaraan dinonaktifkan.'; end if;
    insert into maintenances(company_id,branch_id,vehicle_id,type,title,status,scheduled_at,notes)
    values(v.company_id,v.branch_id,v.id,coalesce(p_payload->>'type','SERVICE'),coalesce(p_payload->>'title','Maintenance kendaraan'),'SCHEDULED',coalesce((p_payload->>'scheduledAt')::timestamptz,now()),p_payload->>'notes') returning * into m;
    update vehicles set status='MAINTENANCE' where id=v.id;
    return jsonb_build_object('maintenance',to_jsonb(m));
  elsif p_action='MAINTENANCE_STATUS' then
    select * into m from maintenances where id=target for update;
    next_value:=p_payload->>'nextStatus';
    if next_value is null or next_value not in ('IN_PROGRESS','COMPLETED','CANCELLED') or m.status not in ('SCHEDULED','IN_PROGRESS') or (next_value='IN_PROGRESS' and m.status<>'SCHEDULED') then
      raise sqlstate 'PT409' using message='Transisi maintenance tidak valid.';
    end if;
    update maintenances set status=next_value,completed_at=case when next_value='COMPLETED' then now() end where id=m.id returning * into m;
    if next_value='COMPLETED' and m.type='REPAIR' and not exists(select 1 from maintenances where vehicle_id=v.id and type='REPAIR' and status in ('SCHEDULED','IN_PROGRESS')) then update vehicles set repair_required=false where id=v.id; end if;
    if next_value in ('COMPLETED','CANCELLED') and not (select repair_required from vehicles where id=v.id) and v.status='MAINTENANCE' and v.gps_status='READY'
      and not exists(select 1 from maintenances where vehicle_id=v.id and status in ('SCHEDULED','IN_PROGRESS'))
      and not exists(select 1 from rentals where vehicle_id=v.id and status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW')) then
      update vehicles set status='AVAILABLE' where id=v.id;
    end if;
    return jsonb_build_object('maintenance',to_jsonb(m));
  end if;

  -- Both inspection variants are persisted in the same transaction as the rental.
  insert into inspections(rental_id,type,staff_id,customer_signature_path,notes)
  values(r.id,case when p_action='HANDOVER' then 'BEFORE' else 'AFTER' end,actor.id,p_payload->>'customerSignature',p_payload->>'notes') returning * into inspection;
  insert into inspection_items(inspection_id,item_key) select inspection.id,value from jsonb_array_elements_text(coalesce(p_payload->'staffChecklist','[]'::jsonb));
  insert into inspection_photos(inspection_id,source,storage_path)
    select inspection.id,'STAFF',value from jsonb_array_elements_text(coalesce(p_payload->'staffPhotos','[]'::jsonb))
    union all select inspection.id,'CUSTOMER',value from jsonb_array_elements_text(coalesce(p_payload->'customerPhotos','[]'::jsonb));
  return jsonb_build_object('rental',to_jsonb(r),'inspection',to_jsonb(inspection),'fine',case when fine.id is null then null else to_jsonb(fine) end,'refund',case when refund.id is null then null else to_jsonb(refund) end,'refundAmount',refund.amount);
exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
  raise sqlstate 'PT400' using message='Format ID, tanggal atau nominal tidak valid.';
end $$;
revoke all on function public.transrent_transaction_v2(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.transrent_transaction_v2(uuid,text,jsonb) to service_role;

-- Keep older callers on the same guarded implementation.
create or replace function public.transrent_transaction(p_actor uuid,p_action text,p_payload jsonb)
returns jsonb language sql security invoker set search_path=public,extensions,pg_temp as $$
 select public.transrent_transaction_v2(p_actor,p_action,p_payload);
$$;
revoke all on function public.transrent_transaction(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.transrent_transaction(uuid,text,jsonb) to service_role;
insert into public.transrent_schema_versions(version) values('014');
notify pgrst,'reload schema';

$migration_014$;
 else raise notice 'Skip 014: already applied'; end if;
end $updates$;
do $verify$ begin
 if (select count(*) from public.transrent_schema_versions where version in ('010','011','012','013','014')) <> 5
 or to_regprocedure('public.transrent_transaction(uuid,text,jsonb)') is null
 or to_regprocedure('public.transrent_transaction_v2(uuid,text,jsonb)') is null
 or to_regprocedure('public.transrent_mou(uuid,uuid,text,jsonb)') is null
 or to_regprocedure('public.transrent_mou_simulation(uuid,uuid,jsonb)') is null
 then raise exception 'Required versions/functions missing'; end if;
 if has_function_privilege('authenticated','public.transrent_transaction_v2(uuid,text,jsonb)','EXECUTE') or not has_function_privilege('service_role','public.transrent_transaction_v2(uuid,text,jsonb)','EXECUTE') then raise exception 'Unexpected v2 RPC grants'; end if;
 if has_table_privilege('authenticated','public.reservations','INSERT')
 or has_function_privilege('authenticated','public.transrent_transaction(uuid,text,jsonb)','EXECUTE')
 or has_function_privilege('anon','public.transrent_mou(uuid,uuid,text,jsonb)','EXECUTE')
 or has_function_privilege('authenticated','public.transrent_mou_simulation(uuid,uuid,jsonb)','EXECUTE')
 or not has_function_privilege('service_role','public.transrent_mou_simulation(uuid,uuid,jsonb)','EXECUTE')
 then raise exception 'Unexpected grants: inspect before restarting backend'; end if;
 if to_regclass('public.fine_disputes_one_open') is null or (select count(*) from information_schema.columns where table_schema='public' and ((table_name='vehicles' and column_name='repair_required') or (table_name='reservations' and column_name='cancellation') or (table_name='rentals' and column_name='fine_payment') or (table_name='fine_disputes' and column_name in ('resolved_by','resolution_notes','original_amount','final_amount'))))<>7 then raise exception 'Financial/repair schema missing'; end if;
 if exists(select 1 from public.vehicles where repair_required and status='AVAILABLE') then raise exception 'Damaged vehicle marked available'; end if;
 if to_regclass('public.rentals_one_active_vehicle') is null or to_regclass('public.payments_one_paid_reservation') is null
 then raise exception 'Required unique indexes missing'; end if;
end $verify$;
notify pgrst,'reload schema';
commit;
select 'BUNDLE_OK' as result, version, applied_at from public.transrent_schema_versions order by version;
select schema_name as private_snapshot from information_schema.schemata where schema_name like 'transrent_backup_%' order by schema_name;

select current_database() as executed_database, current_user as executed_by;
select count(*) as legacy_completed_rentals_requiring_fine_reconciliation from public.rentals r join public.reservations s on s.id=r.reservation_id where r.status='COMPLETED' and greatest(0,(select coalesce(sum(f.amount),0) from public.fines f where f.rental_id=r.id and f.status<>'CANCELLED')-s.deposit_amount-coalesce((r.fine_payment->>'amount')::numeric,0))>0;
