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
