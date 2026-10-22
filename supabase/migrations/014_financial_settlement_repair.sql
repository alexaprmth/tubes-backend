-- Owner execution only. Requires 010-013. No seed/auth data or real gateway calls.
begin;
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
commit;
