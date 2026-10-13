-- Demo vehicles. The initial seed created GPS devices but omitted vehicles.
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
    'Toyota Avanza G', 'CAR', 'Automatic', 7, 2023,
    'DK 1782 TR', 450000, 500000, 'AVAILABLE', 'READY',
    'https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=900&q=80'
  ),
  (
    '52222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    '31111111-1111-4111-8111-111111111111',
    '42222222-2222-4222-8222-222222222222',
    'Honda Vario 160', 'MOTORCYCLE', 'Automatic', 2, 2024,
    'DK 4218 TR', 130000, 250000, 'AVAILABLE', 'READY',
    'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80'
  ),
  (
    '53333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111',
    '32222222-2222-4222-8222-222222222222',
    '43333333-3333-4333-8333-333333333333',
    'Toyota Innova Reborn', 'CAR', 'Automatic', 7, 2022,
    'DK 8831 TR', 650000, 750000, 'AVAILABLE', 'READY',
    'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=900&q=80'
  ),
  (
    '54444444-4444-4444-8444-444444444444',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    'Yamaha NMAX Connected', 'MOTORCYCLE', 'Automatic', 2, 2024,
    'DK 9901 IM', 160000, 300000, 'AVAILABLE', 'READY',
    'https://images.unsplash.com/photo-1558980664-10ea1c1b4d8a?auto=format&fit=crop&w=900&q=80'
  )
on conflict (id) do update set
  status = excluded.status,
  gps_status = excluded.gps_status,
  gps_device_id = excluded.gps_device_id,
  image_url = excluded.image_url;
