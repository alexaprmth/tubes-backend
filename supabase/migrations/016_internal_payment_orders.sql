-- Internal manual ledger. No bank, QR, webhook or external provider integration.
begin;
do $$ begin
 if not exists(select 1 from public.transrent_schema_versions where version='015') then raise exception 'Apply 015 first'; end if;
 if exists(select 1 from public.transrent_schema_versions where version='016') then raise exception '016 already applied'; end if;
end $$;
create sequence public.payment_order_number_seq;
create table public.payment_orders (
 id uuid primary key default gen_random_uuid(),order_number text not null unique default ('TRX-'||to_char(now(),'YYYYMMDD')||'-'||lpad(nextval('public.payment_order_number_seq')::text,8,'0')),
 purpose text not null check(purpose in ('RESERVATION','FINE')),
 reservation_id uuid references public.reservations(id) on delete restrict,rental_id uuid references public.rentals(id) on delete restrict,
 customer_id uuid not null references public.profiles(id),company_id uuid not null references public.rental_companies(id),
 amount numeric(14,2) not null check(amount>=0 and amount<>'NaN'::numeric),provider text not null default 'INTERNAL_MANUAL' check(provider='INTERNAL_MANUAL'),
 status text not null default 'PENDING' check(status in ('PENDING','DECLARED','PAID','REJECTED','EXPIRED','CANCELLED','REFUND_PENDING','REFUNDED')),
 expires_at timestamptz not null,declared_at timestamptz,customer_reference text,approved_at timestamptz,approved_by uuid references public.profiles(id),
 admin_notes text,payout_reference text,refunded_at timestamptz,refunded_by uuid references public.profiles(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check((purpose='RESERVATION' and reservation_id is not null and rental_id is null) or (purpose='FINE' and rental_id is not null and reservation_id is null))
);
create unique index payment_order_open_reservation on public.payment_orders(reservation_id) where status in ('PENDING','DECLARED');
create unique index payment_order_open_fine on public.payment_orders(rental_id) where status in ('PENDING','DECLARED');
create index payment_orders_customer on public.payment_orders(customer_id,created_at desc);
create index payment_orders_company on public.payment_orders(company_id,created_at desc);
alter table public.payment_orders enable row level security;
revoke all on public.payment_orders from public,anon,authenticated;
grant select,insert,update on public.payment_orders to service_role;
grant usage,select on sequence public.payment_order_number_seq to service_role;
alter table public.refunds add column provider text,add column payout_reference text,add column payout_notes text,add column paid_at timestamptz,add column paid_by uuid references public.profiles(id);
create or replace function public.transrent_transaction_v3(p_actor uuid, p_action text, p_payload jsonb)
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
    if start_value<(now() at time zone 'Asia/Makassar')::date then raise sqlstate 'PT400' using message='Tanggal mulai tidak boleh di masa lalu.'; end if;
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
    if not exists(select 1 from payment_orders where id=(p_payload->>'approvedOrderId')::uuid and reservation_id=s.id and purpose='RESERVATION' and status='PAID' and approved_by is not null and amount=s.total_amount) then raise sqlstate 'PT403' using message='Pembayaran harus dikonfirmasi admin melalui tagihan internal.'; end if;
    insert into payments(reservation_id,provider,provider_reference,amount,status,paid_at)
    values(s.id,'INTERNAL_MANUAL',(select order_number from payment_orders where id=(p_payload->>'approvedOrderId')::uuid),s.total_amount,'PAID',now()) returning * into pay;
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
    if pay.id is not null and pay.provider not in ('SIMULATED_GATEWAY','INTERNAL_MANUAL') then raise sqlstate 'PT409' using message='Pembayaran riil memerlukan refund melalui provider resmi.'; end if;
    if s.status='CONFIRMED' and pay.id is null then raise sqlstate 'PT409' using message='Pembayaran reservasi tidak konsisten; perlu rekonsiliasi.'; end if;
    cancellation_value:=jsonb_build_object('id',gen_random_uuid(),'reason',notes_value,'cancelledBy',actor.id,'cancelledAt',now(),'refundAmount',coalesce(pay.amount,0),'refundStatus',case when pay.id is null then 'NOT_REQUIRED' when pay.provider='INTERNAL_MANUAL' then 'REFUND_PENDING' else 'REFUNDED_SIMULATED' end,'provider',coalesce(pay.provider,'INTERNAL_MANUAL'),'paymentId',pay.id);
    update reservations set status='CANCELLED',cancelled_at=now(),cancellation=cancellation_value where id=s.id returning * into s;
    -- Preserve the original payment amount/reference; the cancellation is its refund receipt.
    if pay.id is not null and pay.provider='SIMULATED_GATEWAY' then update payments set status='REFUNDED' where id=pay.id; end if;
    update payment_orders set status=case when status='PAID' then 'REFUND_PENDING' else 'CANCELLED' end,updated_at=now() where reservation_id=s.id and status in ('PENDING','DECLARED','PAID');
    return jsonb_build_object('reservation',to_jsonb(s));
  elsif p_action='HANDOVER' then
    if (now() at time zone 'Asia/Makassar')::date<s.start_date or (now() at time zone 'Asia/Makassar')::date>=s.end_date then raise sqlstate 'PT409' using message='Handover hanya pada periode reservasi, mengikuti waktu Bali.'; end if;
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
    actual_value:=coalesce((p_payload->>'actualReturnDate')::date,(now() at time zone 'Asia/Makassar')::date);
    if actual_value<>(now() at time zone 'Asia/Makassar')::date then raise sqlstate 'PT400' using message='Tanggal return harus tanggal aktual hari ini (waktu Bali).'; end if;
    if actual_value<r.start_date then raise sqlstate 'PT400' using message='Tanggal return sebelum rental dimulai.'; end if;
    if jsonb_typeof(coalesce(p_payload->'damageItems','[]'::jsonb))<>'array' then raise sqlstate 'PT400' using message='Kerusakan harus daftar.'; end if;
    for item in select value from jsonb_array_elements(coalesce(p_payload->'damageItems','[]'::jsonb)) loop
      if jsonb_typeof(item->'amount') is distinct from 'number' or (item->>'amount')::numeric<0 or (item->>'amount')::numeric<>trunc((item->>'amount')::numeric) then
        raise sqlstate 'PT400' using message='Denda harus rupiah bulat tidak negatif.';
      end if;
      damage:=damage+(item->>'amount')::numeric;
    end loop;
    late_days:=greatest(0,actual_value-r.end_date);
    total_fine:=damage+late_days*round((s.rental_amount/s.rental_days)*0.25);
    if total_fine>999999999999 then raise sqlstate 'PT400' using message='Total denda melebihi batas.'; end if;
    if total_fine>0 or jsonb_array_length(coalesce(p_payload->'damageItems','[]'::jsonb))>0 then
      insert into fines(rental_id,amount,status,damage_items) values(r.id,total_fine,'ISSUED',coalesce(p_payload->'damageItems','[]'::jsonb)) returning * into fine;
    end if;
    update rentals set actual_return_date=actual_value,status='RETURN_PENDING_REVIEW',returned_at=now(),return_method=coalesce(p_payload->>'returnMethod','SELF_RETURN'),return_schedule=p_payload->'returnSchedule' where id=r.id returning * into r;
    update vehicles set status='RETURN_INSPECTION',repair_required=repair_required or jsonb_array_length(coalesce(p_payload->'damageItems','[]'::jsonb))>0 where id=v.id;
    insert into refunds(rental_id,amount,status,provider) values(r.id,greatest(0,s.deposit_amount-total_fine),'PENDING_CONFIRMATION','INTERNAL_MANUAL') returning * into refund;
  elsif p_action='REFUND' then
    perform id from fines where rental_id=r.id for update;
    select * into refund from refunds where rental_id=r.id for update;
    if r.status='COMPLETED' and refund.status in ('APPROVED','PAID') then return jsonb_build_object('rental',to_jsonb(r),'refund',to_jsonb(refund)); end if;
    if r.status='RETURN_PENDING_REVIEW' and refund.status='APPROVED' then return jsonb_build_object('rental',to_jsonb(r),'refund',to_jsonb(refund)); end if;
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
    update fines set status='APPROVED' where rental_id=r.id and status<>'CANCELLED';
    if refund.amount>0 then return jsonb_build_object('rental',to_jsonb(r),'refund',to_jsonb(refund)); end if;
    update rentals set status='COMPLETED',completed_at=now() where id=r.id returning * into r;
    update reservations set status='COMPLETED' where id=s.id;
    update vehicles set status=case when repair_required or damaged or gps_status<>'READY' or exists(select 1 from maintenances where vehicle_id=v.id and status in ('SCHEDULED','IN_PROGRESS')) then 'MAINTENANCE' else 'AVAILABLE' end where id=v.id;
    return jsonb_build_object('rental',to_jsonb(r),'refund',to_jsonb(refund));
  elsif p_action='DISPUTE' then
    if actor.role<>'CUSTOMER' or r.customer_id<>actor.id then raise sqlstate 'PT403' using message='Akses sengketa tidak diizinkan.'; end if;
    if r.status<>'RETURN_PENDING_REVIEW' then raise sqlstate 'PT409' using message='Rental tidak menunggu review return.'; end if;
    if nullif(trim(p_payload->>'reason'),'') is null then raise sqlstate 'PT400' using message='Alasan sengketa wajib diisi.'; end if;
    select * into fine from fines where id=(p_payload->>'fineId')::uuid for update;
    if exists(select 1 from payment_orders where rental_id=r.id and status='DECLARED' and expires_at>now()) then raise sqlstate 'PT409' using message='Pembayaran sedang diperiksa; minta admin menolaknya sebelum membuka sengketa.'; end if;
    if r.fine_payment is not null or fine.status not in ('ISSUED','ADJUSTED') then raise sqlstate 'PT409' using message='Denda tidak dapat disengketakan.'; end if;
    update payment_orders set status='CANCELLED',updated_at=now() where rental_id=r.id and status='PENDING';
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
    if not exists(select 1 from payment_orders where id=(p_payload->>'approvedOrderId')::uuid and rental_id=r.id and purpose='FINE' and status='PAID' and approved_by is not null and amount=due) then raise sqlstate 'PT403' using message='Pelunasan harus dikonfirmasi admin melalui tagihan internal.'; end if;
    update rentals set fine_payment=jsonb_build_object('id',gen_random_uuid(),'provider','INTERNAL_MANUAL','providerReference',(select order_number from payment_orders where id=(p_payload->>'approvedOrderId')::uuid),'amount',due,'status','PAID','paidBy',actor.id,'paidAt',now()) where id=r.id returning * into r;
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
revoke all on function public.transrent_transaction_v3(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.transrent_transaction_v3(uuid,text,jsonb) to service_role;


create or replace function public.transrent_payment(p_actor uuid,p_action text,p_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare a profiles%rowtype;o payment_orders%rowtype;s reservations%rowtype;r rentals%rowtype;v vehicles%rowtype;f refunds%rowtype;
 vehicle_value uuid;due numeric;target uuid;result jsonb;notes text;purpose_value text;
begin
 select * into a from profiles where id=p_actor;
 if not found then raise sqlstate 'PT403' using message='Akun tidak ditemukan.'; end if;
 if p_action='CREATE_RESERVATION' then select vehicle_id into vehicle_value from reservations where id=p_id;
 elsif p_action in ('CREATE_FINE','REFUND_DEPOSIT') then select vehicle_id into vehicle_value from rentals where id=p_id;
 else select coalesce(sx.vehicle_id,rx.vehicle_id) into vehicle_value from payment_orders ox left join reservations sx on sx.id=ox.reservation_id left join rentals rx on rx.id=ox.rental_id where ox.id=p_id;end if;
 select * into v from vehicles where id=vehicle_value for update;
 if not found then raise sqlstate 'PT404' using message='Transaksi tidak ditemukan.';end if;
 if a.role<>'CUSTOMER' and a.role<>'CENTRAL_ADMIN' and a.company_id is distinct from v.company_id then raise sqlstate 'PT403' using message='Akses lintas perusahaan ditolak.';end if;
 if p_action in ('CREATE_RESERVATION','CREATE_FINE') then
  if a.role<>'CUSTOMER' then raise sqlstate 'PT403' using message='Customer pemilik membuat tagihan.';end if;
  if p_action='CREATE_RESERVATION' then
   select * into s from reservations where id=p_id for update;
   if s.customer_id<>a.id then raise sqlstate 'PT404' using message='Reservasi tidak ditemukan.';end if;
   if s.status<>'PENDING_PAYMENT' or s.expires_at<=now() then raise sqlstate 'PT409' using message='Reservasi tidak menunggu pembayaran atau kedaluwarsa.';end if;
   due:=s.total_amount;purpose_value:='RESERVATION';
  else
   select * into r from rentals where id=p_id for update;select * into s from reservations where id=r.reservation_id for update;
   if r.customer_id<>a.id then raise sqlstate 'PT404' using message='Rental tidak ditemukan.';end if;
   if r.status not in ('RETURN_PENDING_REVIEW','COMPLETED') or r.fine_payment is not null then raise sqlstate 'PT409' using message='Rental tidak memiliki pelunasan terbuka.';end if;
   if exists(select 1 from fines where rental_id=r.id and status='DISPUTED') then raise sqlstate 'PT409' using message='Selesaikan sengketa dahulu.';end if;
   select greatest(0,coalesce(sum(amount),0)-s.deposit_amount) into due from fines where rental_id=r.id and status<>'CANCELLED';
   purpose_value:='FINE';if due<=0 then raise sqlstate 'PT409' using message='Tidak ada selisih denda.';end if;
  end if;
  update payment_orders set status='EXPIRED',updated_at=now() where (reservation_id=s.id and purpose_value='RESERVATION' or rental_id=r.id and purpose_value='FINE') and status in ('PENDING','DECLARED') and expires_at<=now();
  select * into o from payment_orders where (reservation_id=s.id and purpose_value='RESERVATION' or rental_id=r.id and purpose_value='FINE') and status in ('PENDING','DECLARED') for update;
  if found then return to_jsonb(o);end if;
  insert into payment_orders(purpose,reservation_id,rental_id,customer_id,company_id,amount,expires_at)
   values(purpose_value,case when purpose_value='RESERVATION' then s.id end,case when purpose_value='FINE' then r.id end,a.id,v.company_id,due,case when purpose_value='RESERVATION' then s.expires_at else now()+interval '30 minutes' end) returning * into o;
  return to_jsonb(o);
 elsif p_action='REFUND_DEPOSIT' then
  if a.role not in ('RENTAL_ADMIN','CENTRAL_ADMIN') then raise sqlstate 'PT403' using message='Hanya admin mencatat refund.';end if;
  select * into r from rentals where id=p_id for update;select * into s from reservations where id=r.reservation_id for update;select * into f from refunds where rental_id=r.id for update;
  if f.status='PAID' then return to_jsonb(f);end if;
  if r.status<>'RETURN_PENDING_REVIEW' or f.status<>'APPROVED' or f.provider is distinct from 'INTERNAL_MANUAL' or f.amount<=0 then raise sqlstate 'PT409' using message='Refund belum disetujui untuk pencatatan pembayaran.';end if;
  notes:=trim(p_payload->>'reference');if notes is null or length(notes) not between 1 and 200 then raise sqlstate 'PT400' using message='Referensi refund internal wajib diisi.';end if;
  update refunds set status='PAID',payout_reference=notes,payout_notes=p_payload->>'notes',paid_at=now(),paid_by=a.id where id=f.id returning * into f;
  update rentals set status='COMPLETED',completed_at=now() where id=r.id;update reservations set status='COMPLETED' where id=s.id;
  update vehicles set status=case when repair_required or gps_status<>'READY' or exists(select 1 from maintenances where vehicle_id=v.id and status in ('SCHEDULED','IN_PROGRESS')) then 'MAINTENANCE' else 'AVAILABLE' end where id=v.id;
  return to_jsonb(f);
 end if;
 select * into o from payment_orders where id=p_id for update;
 if a.role='CUSTOMER' and o.customer_id<>a.id then raise sqlstate 'PT404' using message='Tagihan tidak ditemukan.';end if;
 if p_action='DECLARE' then
  if a.role<>'CUSTOMER' then raise sqlstate 'PT403' using message='Hanya customer menyatakan pembayaran.';end if;
  if o.status='DECLARED' and o.expires_at>now() then return to_jsonb(o);end if;
  if o.status<>'PENDING' or o.expires_at<=now() then raise sqlstate 'PT409' using message='Tagihan tidak dapat dibayar atau kedaluwarsa.';end if;
  notes:=trim(p_payload->>'reference');if notes is null or length(notes) not between 1 and 200 then raise sqlstate 'PT400' using message='Referensi pembayaran internal wajib diisi.';end if;
  if o.purpose='RESERVATION' then
   select * into s from reservations where id=o.reservation_id for update;
   if s.status<>'PENDING_PAYMENT' or s.expires_at<=now() then raise sqlstate 'PT409' using message='Reservasi kedaluwarsa/tidak terbuka.';end if;
   update reservations set expires_at=now()+interval '24 hours' where id=s.id;
  elsif exists(select 1 from fines where rental_id=o.rental_id and status='DISPUTED') then raise sqlstate 'PT409' using message='Selesaikan sengketa dahulu.';end if;
  update payment_orders set status='DECLARED',customer_reference=notes,declared_at=now(),expires_at=now()+interval '24 hours',updated_at=now() where id=o.id returning * into o;
 elsif p_action in ('APPROVE','REJECT') then
  if a.role not in ('RENTAL_ADMIN','CENTRAL_ADMIN') then raise sqlstate 'PT403' using message='Hanya admin memverifikasi pembayaran.';end if;
  if o.status='PAID' and p_action='APPROVE' or o.status='REJECTED' and p_action='REJECT' then return to_jsonb(o);end if;
  if o.status<>'DECLARED' or o.expires_at<=now() then raise sqlstate 'PT409' using message='Pembayaran tidak menunggu pemeriksaan atau kedaluwarsa.';end if;
  notes:=trim(p_payload->>'notes');if notes is null or length(notes) not between 1 and 2000 then raise sqlstate 'PT400' using message='Catatan pemeriksaan admin wajib diisi.';end if;
  if p_action='REJECT' then update payment_orders set status='REJECTED',admin_notes=notes,approved_by=a.id,updated_at=now() where id=o.id returning * into o;return to_jsonb(o);end if;
  update payment_orders set status='PAID',approved_at=now(),approved_by=a.id,admin_notes=notes,updated_at=now() where id=o.id returning * into o;
  result:=transrent_transaction_v3(o.customer_id,case when o.purpose='RESERVATION' then 'PAY' else 'PAY_FINE' end,jsonb_build_object('reservationId',o.reservation_id,'rentalId',o.rental_id,'approvedOrderId',o.id));
 elsif p_action='REFUND_ORDER' then
  if a.role not in ('RENTAL_ADMIN','CENTRAL_ADMIN') then raise sqlstate 'PT403' using message='Hanya admin mencatat refund.';end if;
  if o.status='REFUNDED' then return to_jsonb(o);end if;
  if o.status<>'REFUND_PENDING' then raise sqlstate 'PT409' using message='Refund pembatalan tidak menunggu pencatatan.';end if;
  notes:=trim(p_payload->>'reference');if notes is null or length(notes) not between 1 and 200 then raise sqlstate 'PT400' using message='Referensi refund internal wajib diisi.';end if;
  update payment_orders set status='REFUNDED',payout_reference=notes,refunded_at=now(),refunded_by=a.id,updated_at=now() where id=o.id returning * into o;
  update payments set status='REFUNDED' where reservation_id=o.reservation_id and status='PAID';
  update reservations set cancellation=cancellation||jsonb_build_object('refundStatus','REFUNDED_INTERNAL','refundedBy',a.id,'refundedAt',now(),'payoutReference',notes) where id=o.reservation_id;
 else raise sqlstate 'PT400' using message='Operasi pembayaran tidak valid.';end if;
 return to_jsonb(o);
exception when invalid_text_representation or numeric_value_out_of_range then raise sqlstate 'PT400' using message='Format transaksi tidak valid.';
end $$;
revoke all on function public.transrent_payment(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.transrent_payment(uuid,text,uuid,jsonb) to service_role;
-- Earlier service callers use the same business guards, including admin confirmation.
create or replace function public.transrent_transaction_v2(p_actor uuid,p_action text,p_payload jsonb)
returns jsonb language sql security invoker set search_path=public,extensions,pg_temp as $$ select transrent_transaction_v3(p_actor,p_action,p_payload); $$;
revoke all on function public.transrent_transaction_v2(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.transrent_transaction_v2(uuid,text,jsonb) to service_role;
insert into public.transrent_schema_versions(version) values('016');
notify pgrst,'reload schema';
commit;
