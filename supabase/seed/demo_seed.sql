insert into public.rental_companies (id, name, legal_name, email, phone, description, status, delivery_radius_km)
values
  ('11111111-1111-4111-8111-111111111111', 'BaliMove Rental', 'PT BaliMove Transportasi', 'hello@balimove.demo', '081230001000', 'Rental mobil dan motor untuk perjalanan Bali.', 'ACTIVE', 15),
  ('22222222-2222-4222-8222-222222222222', 'IslandMotion', 'CV IslandMotion Nusantara', 'hello@islandmotion.demo', '081230002000', 'Pilihan kendaraan praktis di Denpasar dan sekitarnya.', 'ACTIVE', 15)
on conflict (id) do nothing;

insert into public.branches (id, company_id, name, address, phone, location)
values
  ('31111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'BaliMove Kuta', 'Jl. Sunset Road No. 88, Kuta', '081230001001', st_setsrid(st_makepoint(115.1682, -8.7179), 4326)::geography),
  ('32222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'BaliMove Sanur', 'Jl. Danau Tamblingan No. 15, Sanur', '081230001002', st_setsrid(st_makepoint(115.2631, -8.6884), 4326)::geography),
  ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'IslandMotion Seminyak', 'Jl. Raya Seminyak No. 21, Seminyak', '081230002001', st_setsrid(st_makepoint(115.1681, -8.6913), 4326)::geography)
on conflict (id) do nothing;

insert into public.gps_devices (id, device_code, provider, status)
values
  ('41111111-1111-4111-8111-111111111111', 'GPS-AVANZA-01', 'TransRent Simulator', 'READY'),
  ('42222222-2222-4222-8222-222222222222', 'GPS-VARIO-01', 'TransRent Simulator', 'READY'),
  ('43333333-3333-4333-8333-333333333333', 'GPS-INNOVA-01', 'TransRent Simulator', 'READY'),
  ('44444444-4444-4444-8444-444444444444', 'GPS-NMAX-01', 'TransRent Simulator', 'READY')
on conflict (id) do nothing;

insert into public.vehicles (
  id,
  company_id,
  branch_id,
  gps_device_id,
  name,
  type,
  transmission,
  seats,
  year,
  plate_number,
  price_per_day,
  deposit_amount,
  status,
  gps_status,
  image_url
)
values
  (
    '51111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    '31111111-1111-4111-8111-111111111111',
    '41111111-1111-4111-8111-111111111111',
    'Toyota Avanza G',
    'CAR',
    'Automatic',
    7,
    2023,
    'DK 1782 TR',
    450000,
    500000,
    'AVAILABLE',
    'READY',
    'https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=900&q=80'
  ),
  (
    '52222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    '31111111-1111-4111-8111-111111111111',
    '42222222-2222-4222-8222-222222222222',
    'Honda Vario 160',
    'MOTORCYCLE',
    'Automatic',
    2,
    2024,
    'DK 4218 TR',
    130000,
    250000,
    'AVAILABLE',
    'READY',
    'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80'
  ),
  (
    '53333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111',
    '32222222-2222-4222-8222-222222222222',
    '43333333-3333-4333-8333-333333333333',
    'Toyota Innova Reborn',
    'CAR',
    'Automatic',
    7,
    2022,
    'DK 8831 TR',
    650000,
    750000,
    'AVAILABLE',
    'READY',
    'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=900&q=80'
  ),
  (
    '54444444-4444-4444-8444-444444444444',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    'Yamaha NMAX Connected',
    'MOTORCYCLE',
    'Automatic',
    2,
    2024,
    'DK 9901 IM',
    160000,
    300000,
    'AVAILABLE',
    'READY',
    'https://images.unsplash.com/photo-1558980664-10ea1c1b4d8a?auto=format&fit=crop&w=900&q=80'
  )
on conflict (id) do update set
  status = excluded.status,
  gps_status = excluded.gps_status,
  gps_device_id = excluded.gps_device_id,
  image_url = excluded.image_url;
