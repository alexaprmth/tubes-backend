begin;
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
commit;
