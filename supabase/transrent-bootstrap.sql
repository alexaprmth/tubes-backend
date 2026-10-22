-- EMPTY DATABASE ONLY. Owner SQL Editor; do not run on the existing TransRent database.
begin;
do $$ begin if to_regclass('public.rental_companies') is not null then raise exception 'Database already initialized; use update bundles';end if;end $$;

-- 001_core.sql
create extension if not exists postgis;
create extension if not exists pgcrypto;

create table if not exists public.rental_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text,
  email text,
  phone text,
  description text,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACTIVE', 'SUSPENDED')),
  delivery_radius_km numeric(6,2) not null default 15 check (delivery_radius_km > 0 and delivery_radius_km <= 15),
  created_at timestamptz not null default now()
);

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.rental_companies(id) on delete cascade,
  name text not null,
  address text not null,
  phone text,
  location geography(point, 4326) not null,
  created_at timestamptz not null default now()
);

create index if not exists branches_location_gist on public.branches using gist(location);
create index if not exists branches_company_idx on public.branches(company_id);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  phone text,
  address text,
  role text not null default 'CUSTOMER' check (role in ('CUSTOMER', 'STAFF', 'RENTAL_ADMIN', 'CENTRAL_ADMIN')),
  company_id uuid references public.rental_companies(id) on delete set null,
  branch_id uuid references public.branches(id) on delete set null,
  verification_status text not null default 'PENDING' check (verification_status in ('PENDING', 'VERIFIED', 'REJECTED')),
  ktp_number text,
  sim_number text,
  ktp_document_path text,
  sim_document_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.gps_devices (
  id uuid primary key default gen_random_uuid(),
  device_code text unique not null,
  provider text,
  status text not null default 'READY' check (status in ('READY', 'OFFLINE', 'FAULTY', 'INACTIVE')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.rental_companies(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  gps_device_id uuid references public.gps_devices(id) on delete set null,
  name text not null,
  type text not null check (type in ('CAR', 'MOTORCYCLE')),
  transmission text,
  seats integer,
  year integer,
  plate_number text not null,
  price_per_day numeric(14,2) not null check (price_per_day >= 0),
  deposit_amount numeric(14,2) not null default 0 check (deposit_amount >= 0),
  status text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'RESERVED', 'RENTED', 'RETURN_INSPECTION', 'MAINTENANCE', 'INACTIVE')),
  gps_status text not null default 'FAULTY' check (gps_status in ('READY', 'OFFLINE', 'FAULTY', 'NOT_INSTALLED')),
  image_url text,
  created_at timestamptz not null default now()
);

create index if not exists vehicles_branch_idx on public.vehicles(branch_id);
create index if not exists vehicles_availability_idx on public.vehicles(status, gps_status, type);

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete restrict,
  company_id uuid not null references public.rental_companies(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  vehicle_id uuid not null references public.vehicles(id) on delete restrict,
  start_date date not null,
  end_date date not null,
  pickup_mode text not null default 'PICKUP' check (pickup_mode in ('PICKUP', 'DELIVERY')),
  delivery_address text,
  delivery_location geography(point, 4326),
  recipient_phone text,
  delivery_notes text,
  delivery_distance_km numeric(8,2),
  rental_days integer not null check (rental_days > 0),
  rental_amount numeric(14,2) not null default 0,
  deposit_amount numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null default 0,
  status text not null default 'PENDING_PAYMENT' check (status in ('DRAFT', 'PENDING_PAYMENT', 'CONFIRMED', 'RENTED', 'CANCELLED', 'EXPIRED')),
  expires_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_date > start_date),
  check (pickup_mode = 'PICKUP' or (delivery_address is not null and delivery_location is not null and recipient_phone is not null)),
  check (delivery_distance_km is null or delivery_distance_km <= 15)
);

create index if not exists reservations_vehicle_period_idx on public.reservations(vehicle_id, start_date, end_date);
create index if not exists reservations_customer_idx on public.reservations(customer_id, created_at desc);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  provider text not null default 'SIMULATED_GATEWAY',
  provider_reference text,
  amount numeric(14,2) not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'PAID', 'FAILED', 'REFUNDED')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.rentals (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null unique references public.reservations(id) on delete restrict,
  customer_id uuid not null references public.profiles(id) on delete restrict,
  company_id uuid not null references public.rental_companies(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  vehicle_id uuid not null references public.vehicles(id) on delete restrict,
  start_date date not null,
  end_date date not null,
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'ACTIVE', 'RETURN_PENDING_REVIEW', 'COMPLETED', 'CANCELLED')),
  handover_at timestamptz,
  returned_at timestamptz,
  completed_at timestamptz,
  return_method text check (return_method in ('SELF_RETURN', 'STAFF_PICKUP')),
  return_schedule jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.inspections (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  type text not null check (type in ('BEFORE', 'AFTER')),
  staff_id uuid references public.profiles(id) on delete set null,
  customer_signature_path text,
  notes text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists public.inspection_items (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references public.inspections(id) on delete cascade,
  item_key text not null,
  condition text not null default 'OK' check (condition in ('OK', 'DAMAGED', 'MISSING')),
  notes text
);

create table if not exists public.inspection_photos (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references public.inspections(id) on delete cascade,
  source text not null check (source in ('STAFF', 'CUSTOMER')),
  storage_path text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.fines (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references public.rentals(id) on delete cascade,
  amount numeric(14,2) not null default 0,
  status text not null default 'ISSUED' check (status in ('ISSUED', 'DISPUTED', 'ADJUSTED', 'APPROVED', 'CANCELLED')),
  damage_items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.fine_disputes (
  id uuid primary key default gen_random_uuid(),
  fine_id uuid not null references public.fines(id) on delete cascade,
  customer_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'ACCEPTED', 'REJECTED', 'ADJUSTED')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null unique references public.rentals(id) on delete cascade,
  amount numeric(14,2) not null default 0,
  status text not null default 'PENDING_CONFIRMATION' check (status in ('PENDING_CONFIRMATION', 'APPROVED', 'PAID', 'FAILED')),
  confirmed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table if not exists public.maintenances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.rental_companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  type text not null default 'SERVICE',
  title text not null,
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  scheduled_at timestamptz,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.vehicle_locations (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  rental_id uuid references public.rentals(id) on delete set null,
  location geography(point, 4326) not null,
  speed numeric(8,2),
  heading numeric(8,2),
  recorded_at timestamptz not null default now()
);

create index if not exists vehicle_locations_gist on public.vehicle_locations using gist(location);
create index if not exists vehicle_locations_vehicle_time_idx on public.vehicle_locations(vehicle_id, recorded_at desc);

alter table public.rental_companies enable row level security;
alter table public.branches enable row level security;
alter table public.profiles enable row level security;
alter table public.vehicles enable row level security;
alter table public.reservations enable row level security;
alter table public.payments enable row level security;
alter table public.rentals enable row level security;
alter table public.inspections enable row level security;
alter table public.inspection_items enable row level security;
alter table public.inspection_photos enable row level security;
alter table public.fines enable row level security;
alter table public.fine_disputes enable row level security;
alter table public.refunds enable row level security;
alter table public.maintenances enable row level security;
alter table public.vehicle_locations enable row level security;


-- 002_profiles_and_rls.sql
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, role, verification_status)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)), new.email, 'CUSTOMER', 'PENDING')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create policy "public can read active rental companies"
on public.rental_companies for select
using (status = 'ACTIVE');

create policy "public can read branches"
on public.branches for select
using (true);

create policy "public can read bookable vehicles"
on public.vehicles for select
using (status = 'AVAILABLE' and gps_status = 'READY');

create policy "users can read own profile"
on public.profiles for select
to authenticated
using (id = auth.uid());

create policy "customers can read own reservations"
on public.reservations for select
to authenticated
using (customer_id = auth.uid());

create policy "customers can create own reservations"
on public.reservations for insert
to authenticated
with check (customer_id = auth.uid());

create policy "customers can read own rentals"
on public.rentals for select
to authenticated
using (customer_id = auth.uid());

create policy "customers can read own rental locations"
on public.vehicle_locations for select
to authenticated
using (exists (
  select 1 from public.rentals r
  where r.id = vehicle_locations.rental_id
    and r.customer_id = auth.uid()
    and r.status = 'ACTIVE'
));

-- Backend uses the service role for cross-company operational actions.
-- Never expose the service role key to the frontend.


-- 003_api_grants.sql
-- Data API privileges for the TransRent backend.
-- RLS remains enabled; these grants only allow the roles to reach the tables.

grant usage on schema public to service_role;

grant select, insert, update, delete on table
  public.rental_companies,
  public.branches,
  public.profiles,
  public.gps_devices,
  public.vehicles,
  public.reservations,
  public.payments,
  public.rentals,
  public.inspections,
  public.inspection_items,
  public.inspection_photos,
  public.fines,
  public.fine_disputes,
  public.refunds,
  public.maintenances,
  public.vehicle_locations
to service_role;

grant usage, select on all sequences in schema public to service_role;

-- Public catalog reads. RLS policies still restrict the rows returned.
grant usage on schema public to anon, authenticated;
grant select on table
  public.rental_companies,
  public.branches,
  public.vehicles
to anon, authenticated;

-- Customer-facing access. RLS policies in 002_profiles_and_rls.sql
-- restrict these grants to the current user's own rows.
grant select on table
  public.profiles,
  public.reservations,
  public.rentals,
  public.vehicle_locations
to authenticated;

grant insert on table public.reservations to authenticated;


-- 005_hardening.sql
-- TransRent hardening: diagnostics and indexes for lifecycle queries.
-- Jalankan setelah 001_core.sql - 004_seed_vehicles.sql.

create index if not exists reservations_payment_expiry_idx
  on public.reservations(status, expires_at)
  where status = 'PENDING_PAYMENT';

create index if not exists maintenances_vehicle_status_idx
  on public.maintenances(vehicle_id, status);

create index if not exists gps_devices_status_idx
  on public.gps_devices(status, last_seen_at desc);

-- Satu GPS hanya boleh terpasang pada satu kendaraan.
-- Jika data lama masih duplikat, index sengaja tidak dibuat agar migration tidak
-- gagal total. Backend menyediakan /api/admin/gps/diagnostics untuk menemukan
-- mapping yang perlu diperbaiki terlebih dahulu.
do $$
begin
  if not exists (
    select 1
    from public.vehicles
    where gps_device_id is not null
    group by gps_device_id
    having count(*) > 1
  ) then
    execute 'create unique index if not exists vehicles_gps_device_unique_idx
      on public.vehicles(gps_device_id) where gps_device_id is not null';
  else
    raise notice 'Unique GPS mapping index dilewati karena masih ada duplicate gps_device_id.';
  end if;
end $$;



-- 006_storage.sql
-- Private bucket untuk dokumen identitas, foto inspeksi, dan tanda tangan.
-- Backend mengunggah file memakai SUPABASE_SERVICE_ROLE_KEY; file tidak dibuat
-- public agar dokumen customer tidak dapat diakses tanpa kontrol backend.

insert into storage.buckets (id, name, public)
values ('transrent-files', 'transrent-files', false)
on conflict (id) do update set public = false;



-- 007_gps_agreements.sql
-- Agreement/MoU GPS antara TransRent dan perusahaan rental.
-- Kendaraan hanya boleh masuk search/handover jika perusahaan memiliki
-- agreement ACTIVE dengan gps_tracking_allowed = true.

create table if not exists public.rental_company_agreements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.rental_companies(id) on delete cascade,
  agreement_number text not null unique,
  status text not null default 'PENDING'
    check (status in ('DRAFT', 'PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED')),
  gps_tracking_allowed boolean not null default false,
  signed_at timestamptz,
  expires_at timestamptz,
  document_path text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rental_company_agreements_company_idx
  on public.rental_company_agreements(company_id, status);

alter table public.rental_company_agreements enable row level security;



-- 008_company_onboarding.sql
-- Menjamin satu perusahaan hanya memiliki satu MoU GPS aktif.
-- Histori MoU lama tetap disimpan sebagai EXPIRED atau REVOKED.
create unique index if not exists rental_company_one_active_agreement_idx
  on public.rental_company_agreements(company_id)
  where status = 'ACTIVE';

alter table public.rental_company_agreements
  drop constraint if exists rental_company_agreements_valid_dates;

alter table public.rental_company_agreements
  add constraint rental_company_agreements_valid_dates
  check (expires_at is null or signed_at is null or expires_at > signed_at);


-- 009_auto_mou_number.sql
-- Nomor MoU dibuat otomatis oleh database agar aman dari benturan concurrent insert.
create sequence if not exists public.rental_company_agreement_number_seq;

alter table public.rental_company_agreements
  alter column agreement_number set default (
    'MOU-GPS-' || to_char(current_date, 'YYYY') || '-'
    || lpad(nextval('public.rental_company_agreement_number_seq')::text, 6, '0')
  );


-- 010_atomic_rental_operations.sql
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


-- 011_mou_owner_upload.sql
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


-- 012_online_mou_simulation.sql
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


-- 013_online_mou_draft_terms.sql
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


-- 014_financial_settlement_repair.sql
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


-- 015_business_workflows.sql
-- Owner execution only, after 014. No seed replay or external requests.
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


-- 016_internal_payment_orders.sql
-- Internal manual ledger. No bank, QR, webhook or external provider integration.
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


grant usage,select on all sequences in schema public to service_role;
notify pgrst,'reload schema';
commit;
select 'BOOTSTRAP_OK' as result,version from public.transrent_schema_versions order by version;
