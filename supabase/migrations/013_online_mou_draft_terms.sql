-- Draf wording v2; existing receipts stay unchanged. Owner SQL Editor only.
begin;
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
commit;
