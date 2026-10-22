-- READ ONLY, after bundle 010-014. Expect five versions and service-only RPCs.
select version,applied_at from public.transrent_schema_versions order by version;
select to_regprocedure('public.transrent_transaction(uuid,text,jsonb)') as rental_rpc,to_regprocedure('public.transrent_mou(uuid,uuid,text,jsonb)') as mou_rpc;
select column_name,data_type from information_schema.columns where table_schema='public' and table_name='rental_company_agreements' and column_name='document_metadata';
select indexname,indexdef from pg_indexes where schemaname='public' and indexname in ('rentals_one_active_vehicle','payments_one_paid_reservation','vehicle_locations_rental_time_idx');
select has_function_privilege('authenticated','public.transrent_transaction(uuid,text,jsonb)','EXECUTE') as customer_rental_rpc_must_be_false,
 has_function_privilege('anon','public.transrent_mou(uuid,uuid,text,jsonb)','EXECUTE') as anonymous_mou_rpc_must_be_false,
 has_table_privilege('authenticated','public.reservations','INSERT') as customer_insert_must_be_false,
 has_function_privilege('service_role','public.transrent_transaction(uuid,text,jsonb)','EXECUTE') as backend_rental_rpc_must_be_true;
select tablename,policyname from pg_policies where schemaname='public' and tablename='reservations' and cmd='INSERT';
select count(*) as completed_rentals_with_open_reservation_must_be_zero from public.rentals r join public.reservations s on s.id=r.reservation_id where r.status='COMPLETED' and s.status='RENTED';
select schema_name as private_snapshot from information_schema.schemata where schema_name like 'transrent_backup_%';

select to_regprocedure('public.transrent_mou_simulation(uuid,uuid,jsonb)') as online_simulation_rpc;
select has_function_privilege('authenticated','public.transrent_mou_simulation(uuid,uuid,jsonb)','EXECUTE') as customer_simulation_rpc_must_be_false;
select column_name,data_type from information_schema.columns where table_schema='public' and table_name='rental_company_agreements' and column_name='online_simulation';

select to_regprocedure('public.transrent_transaction_v2(uuid,text,jsonb)') as financial_rental_rpc;
select has_function_privilege('authenticated','public.transrent_transaction_v2(uuid,text,jsonb)','EXECUTE') as customer_finance_rpc_must_be_false,
 has_function_privilege('service_role','public.transrent_transaction_v2(uuid,text,jsonb)','EXECUTE') as backend_finance_rpc_must_be_true;
select table_name,column_name,data_type from information_schema.columns where table_schema='public' and
 ((table_name='vehicles' and column_name='repair_required') or (table_name='reservations' and column_name='cancellation') or (table_name='rentals' and column_name='fine_payment') or (table_name='fine_disputes' and column_name in ('resolved_by','resolution_notes','original_amount','final_amount')));
select count(*) as damaged_available_vehicles_must_be_zero from public.vehicles where repair_required and status='AVAILABLE';
