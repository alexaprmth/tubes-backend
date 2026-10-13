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

-- Seed agreement hanya untuk demo lokal. Ganti dengan data legal yang sebenarnya
-- pada implementasi production.
insert into public.rental_company_agreements (
  company_id,
  agreement_number,
  status,
  gps_tracking_allowed,
  signed_at,
  notes
)
select
  id,
  'MOU-GPS-DEMO-' || upper(left(replace(id::text, '-', ''), 8)),
  'ACTIVE',
  true,
  now(),
  'Agreement dummy untuk demo TransRent; bukan dokumen legal produksi.'
from public.rental_companies
where status = 'ACTIVE'
on conflict (agreement_number) do update set
  status = excluded.status,
  gps_tracking_allowed = excluded.gps_tracking_allowed,
  updated_at = now();

