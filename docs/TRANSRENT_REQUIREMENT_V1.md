# TransRent — Requirement v1

## 1. Ringkasan

TransRent adalah platform multi-perusahaan untuk pemesanan kendaraan yang memusatkan pencarian rental, reservasi, pembayaran simulasi, dokumentasi handover/return, maintenance, dan GPS tracking dalam satu sistem.

Scope MVP adalah demo lokal untuk mata kuliah Pemrograman Backend. Data demo bersifat sintetis.

## 2. Aturan bisnis utama

- Satu reservasi hanya untuk satu customer, satu kendaraan, satu perusahaan rental, dan satu cabang.
- Perusahaan rental dapat memiliki satu atau banyak cabang.
- Customer dapat memilih pickup di cabang atau delivery ke lokasi customer.
- Delivery maksimal 15 km dari cabang yang dipilih dan tanpa biaya delivery pada MVP.
- Return dilakukan ke cabang awal atau melalui staff pickup pada tanggal berakhirnya rental.
- Customer harus terverifikasi sebelum pembayaran.
- Pembayaran sewa dan deposit menggunakan satu pembayaran simulasi.
- Reservasi kadaluarsa jika tidak dibayar selama 30 menit.
- Kendaraan tanpa GPS READY tidak dapat dipesan atau handover dan masuk status MAINTENANCE.
- Perusahaan rental wajib memiliki agreement/MoU GPS berstatus ACTIVE dan `gps_tracking_allowed = true` sebelum kendaraan perusahaan dapat dicari, dipesan, atau handover.
- Geofence dan notifikasi WhatsApp ditunda.
- Refund dilakukan setelah Admin Rental mengonfirmasi hasil inspeksi.

## 3. Role dan permission

| Resource/aksi | Customer | Staff | Admin Rental | Admin Pusat |
|---|---:|---:|---:|---:|
| Registrasi/login | ✓ | via akun | via akun | via akun |
| Upload KTP/SIM | ✓ | - | - | melihat |
| Verifikasi customer | - | - | - | ✓ |
| Cari perusahaan/kendaraan | ✓ | - | - | - |
| Membuat reservasi | ✓ | - | - | - |
| Simulasi pembayaran | ✓ | dapat membantu | dapat membantu | - |
| Handover | - | ✓ | ✓ | ✓ |
| Inspeksi BEFORE/AFTER | upload customer | ✓ | ✓ | - |
| Denda/dispute/refund | dispute | input kondisi | review/refund | monitoring |
| Maintenance | - | melihat | ✓ | monitoring |
| GPS rental aktif | miliknya | perusahaan | perusahaan | belum masuk MVP |
| Perusahaan rental | - | - | miliknya | seluruhnya |

## 4. Model domain dan relasi

```text
rental_companies 1 ─── N branches
rental_companies 1 ─── N rental_company_agreements
branches         1 ─── N vehicles
vehicles         1 ─── 1 gps_devices (opsional)
profiles         N ─── 1 rental_companies (untuk staff/admin)
profiles         1 ─── N reservations
vehicles         1 ─── N reservations
reservations     1 ─── 1 payments
reservations     1 ─── 0..1 rentals
rentals          1 ─── N inspections
inspections      1 ─── N inspection_photos
rentals          1 ─── 0..1 fines
fines            1 ─── N fine_disputes
rentals          1 ─── 0..1 refunds
vehicles         1 ─── N maintenances
vehicles         1 ─── N vehicle_locations
```

Koordinat cabang, lokasi delivery, dan lokasi kendaraan disimpan sebagai data spasial PostGIS `geography(Point, 4326)`.

## 5. Sitemap frontend

### Customer

- Login/Register
- Beranda dan pencarian
- Detail kendaraan
- Checkout/reservasi
- Reservasi saya
- Rental aktif dan tracking
- Riwayat rental
- Profil dan verifikasi

### Staff Rental

- Handover hari ini
- Return hari ini
- Form inspeksi
- Tracking kendaraan perusahaan

### Admin Rental

- Overview
- Reservasi masuk
- Rental berjalan
- Armada dan GPS
- Maintenance
- Denda/refund
- Laporan

### Admin Pusat

- Overview global
- Verifikasi customer
- Perusahaan rental dan cabang
- Monitoring platform

## 6. API MVP

### Auth

```http
POST /api/auth/demo-login
POST /api/auth/register
GET  /api/auth/me
```

### Search and reservation

```http
GET  /api/companies
GET  /api/branches/search?latitude&longitude&startDate&endDate&type
GET  /api/reservations
POST /api/reservations
POST /api/reservations/:id/payments/simulate
```

### Handover, return, inspection

```http
POST /api/reservations/:id/handover
GET  /api/rentals
POST /api/rentals/:id/return
POST /api/rentals/:id/refund/confirm
POST /api/fines/:id/disputes
```

### GPS

```http
POST /api/tracking/location
GET  /api/tracking/vehicles
GET  /api/vehicles/:id/locations
```

### Admin

```http
GET   /api/admin/summary
GET   /api/admin/fleet
GET   /api/admin/customers
PATCH /api/admin/customers/:id/verification
GET   /api/admin/gps/diagnostics
GET   /api/admin/gps-agreements
PATCH /api/admin/gps-agreements/:id
GET   /api/maintenance
POST  /api/maintenance
POST  /api/maintenance/:id/start
POST  /api/maintenance/:id/complete
POST  /api/maintenance/:id/cancel
```

### Health & dokumentasi

```http
GET /api/health
GET /api/health/deep
GET /api/openapi.json
```

Swagger UI tersedia di `/api-docs/`.

## 7. Urutan implementasi

### Phase 1 — Foundation

- Buat repository dan environment.
- Jalankan backend Express dan frontend React.
- Siapkan Supabase migration dan seed.
- Siapkan demo authentication.

### Phase 2 — Customer flow

- Login/register.
- Upload KTP/SIM.
- Verifikasi customer.
- Search cabang/kendaraan dengan lokasi dan periode.
- Detail kendaraan.
- Checkout pickup/delivery.

### Phase 3 — Reservation and payment

- Buat reservasi.
- Validasi availability.
- Validasi delivery radius 15 km.
- Expiration 30 menit.
- Pembayaran simulasi sewa + deposit.

### Phase 4 — Staff operations

- Handover.
- Upload foto staff/customer.
- Checklist.
- Canvas tanda tangan.
- Rental ACTIVE.

### Phase 5 — GPS and return

- GPS simulator 10 detik.
- Penyimpanan histori lokasi.
- Map tracking.
- Return self/pickup staff.
- Inspeksi AFTER.

### Phase 6 — Fine, refund, maintenance

- Damage item dan nominal denda.
- Dispute customer.
- Konfirmasi refund Admin Rental.
- Maintenance dan blokir kendaraan.

### Phase 7 — Hardening

- RLS Supabase.
- Upload ke Supabase Storage.
- Testing API.
- Error handling.
- Integrasi Midtrans dan WhatsApp sebagai tahap lanjutan.
- Agreement/MoU GPS per perusahaan rental.
