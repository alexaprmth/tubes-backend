-- READ ONLY. Check the SQL Editor project matches backend/.env first.
select current_database() as database_name,current_user as sql_role,version() as engine;
select extname,extversion from pg_extension where extname in ('postgis','pgcrypto');
select table_name,column_name,data_type from information_schema.columns
where table_schema='public' and table_name in ('reservations','rentals','fines','refunds','rental_company_agreements') order by table_name,ordinal_position;
select conrelid::regclass as target,conname,pg_get_constraintdef(oid) as definition from pg_constraint
where conrelid in ('public.reservations'::regclass,'public.rentals'::regclass,'public.fines'::regclass,'public.refunds'::regclass,'public.rental_company_agreements'::regclass);
select schemaname,tablename,policyname,cmd,roles,qual,with_check from pg_policies where schemaname='public';
select to_regclass('supabase_migrations.schema_migrations') as provider_history,to_regclass('public.transrent_schema_versions') as app_history;
-- Stop on any nonzero result. No automatic deletion or reconciliation.
select 'duplicate_active_vehicles' as issue,count(*) as groups from (select vehicle_id from public.rentals where status in ('SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW') group by vehicle_id having count(*)>1) s
union all select 'duplicate_paid_reservations',count(*) from (select reservation_id from public.payments where status='PAID' group by reservation_id having count(*)>1) s
union all select 'invalid_fines',count(*) from public.fines where amount<0 or amount='NaN'::numeric
union all select 'invalid_refunds',count(*) from public.refunds f join public.rentals r on r.id=f.rental_id join public.reservations s on s.id=r.reservation_id where f.amount<0 or f.amount='NaN'::numeric or f.amount>s.deposit_amount;
select indexname,indexdef from pg_indexes where schemaname='public' and tablename in ('rentals','payments','rental_company_agreements');
-- If history exists, inspect it separately before running the scripts:
-- select version from public.transrent_schema_versions order by version;
-- select * from supabase_migrations.schema_migrations order by version;
