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

