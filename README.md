# TransRent — Transportation Rental

Prototype MVP multi-perusahaan untuk demo mata kuliah Pemrograman Backend.

## Stack

- React + Vite
- Node.js + Express modular backend
- Supabase PostgreSQL + PostGIS (persistence ketika env backend diisi)
- Supabase Auth (login customer/admin)
- Leaflet/OpenStreetMap
- Browser Geolocation API
- GPS simulator
- Simulated payment
- Tailwind/shadcn direction represented by reusable component classes in the MVP stylesheet

## Demo flow

```text
Customer login
→ Search company/vehicle by location and period
→ Detail vehicle
→ Pickup or delivery (maximum 15 km)
→ Create reservation
→ Simulate payment
→ Staff handover + BEFORE inspection
→ GPS simulator every 10 seconds
→ Tracking map
→ Staff return + AFTER inspection
→ Fine/dispute/refund confirmation
```

## Run locally

Requirements: Node.js 18+.

Verifikasi sebelum demo dari root project:

```bash
npm install --prefix backend
npm install --prefix frontend
npm test
npm run build
```

Terminal 1:

```bash
cd backend
npm install
npm run dev
```

Terminal 2:

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at `http://localhost:5174` and backend at `http://localhost:4100`.

Swagger tersedia setelah backend berjalan:

- UI: `http://localhost:4100/api-docs/`
- JSON: `http://localhost:4100/api/openapi.json`
- Health ringan: `http://localhost:4100/api/health`
- Health dengan query database: `http://localhost:4100/api/health/deep`

Terminal 3, after a handover is active:

```bash
node simulator/gps-simulator.js
```

To use another GPS device:

```powershell
$env:GPS_DEVICE_ID="GPS-VARIO-01"
node simulator/gps-simulator.js
```

## Demo accounts

All demo passwords are `demo123`.

| Role | Email |
|---|---|
| Customer | `customer@transrent.demo` |
| Staff Rental | `staff@balimove.demo` |
| Admin Rental | `admin@balimove.demo` |
| Admin Pusat | `central@transrent.demo` |
| Customer pending | `pending@transrent.demo` |

## Supabase mode

Salin `backend/.env.example` menjadi `backend/.env`, lalu isi:

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
ALLOW_DEMO_AUTH=false
SUPABASE_STORAGE_BUCKET=transrent-files
```

`SUPABASE_SERVICE_ROLE_KEY` hanya boleh berada di backend. Jangan pernah menaruhnya di `frontend/.env` atau commit ke Git.

Jika `.env` tidak ada, backend tetap bisa dijalankan dalam mode demo in-memory. Data demo akan reset ketika backend restart.

## Supabase setup

Run SQL in this order:

1. `supabase/migrations/001_core.sql`
2. `supabase/migrations/002_profiles_and_rls.sql`
3. `supabase/migrations/003_api_grants.sql`
4. `supabase/migrations/004_seed_vehicles.sql`
5. `supabase/migrations/005_hardening.sql`
6. `supabase/migrations/006_storage.sql`
7. `supabase/migrations/007_gps_agreements.sql`
8. `supabase/seed/demo_seed.sql`

Migration menggunakan PostGIS untuk koordinat cabang, delivery, dan histori lokasi kendaraan. `005_hardening.sql` menambahkan index expiry, index maintenance/GPS, dan unique mapping GPS jika data lama tidak duplikat. `006_storage.sql` membuat bucket private untuk KTP/SIM, foto inspeksi, dan tanda tangan. `007_gps_agreements.sql` mencatat MoU GPS per perusahaan; data demo dibuat aktif agar flow dapat dicoba.

Setelah migration selesai, gunakan `/api/health/deep`. Jika muncul `SUPABASE_JWT_CLOCK_SKEW`, sinkronkan tanggal, jam, dan timezone Windows sebelum mengganti key.

Untuk mencari mapping GPS yang bermasalah, login sebagai Staff/Admin Rental lalu buka:

```text
GET /api/admin/gps/diagnostics
```

## Documentation

See [docs/TRANSRENT_REQUIREMENT_V1.md](docs/TRANSRENT_REQUIREMENT_V1.md) for the domain model, permissions, sitemap, API contract, and implementation phases.

## Deferred scope

- WhatsApp API and notifications
- Geofencing
- Midtrans integration
- Real GPS hardware
- Production deployment
- Automated damage detection

## Prioritas implementasi yang sudah disiapkan

1. Supabase error classification dan health check database.
2. Swagger UI/OpenAPI untuk seluruh endpoint utama.
3. Supabase Storage adapter dengan fallback demo, lifecycle maintenance, dan expiry reservation otomatis setiap 60 detik.
4. Payment abstraction saat ini tetap `SIMULATED_GATEWAY`; Midtrans dapat dipasang tanpa mengubah flow reservation.
5. Role check, company isolation, optional `GPS_INGEST_TOKEN`, diagnostik GPS, dan unit test domain.
6. Migration, `.env.example`, README, dan checklist demo.
7. Hardening lanjutan yang masih membutuhkan environment/keputusan eksternal: sinkronisasi jam mesin, pembersihan duplicate GPS di project Supabase, kredensial Midtrans, dan deployment.
