# Status publikasi — 22 Oktober 2026

Branch `feature-update` memuat workflow internal terbaru. Daftar pekerjaan yang belum selesai dan urutan implementasi ada di [rencana kerja](docs/REMAINING_WORK_AND_PLAN.md).

Database TransRent yang dikonfigurasi lokal diverifikasi read-only pada22Okt: migration010–016 terpasang dan duplikasi GPS0. Pemilik sudah menjalankan perbaikan GPS dan bundle015–016; tidak ada SQL pending untuk database tersebut. Git checkout/push tidak menjalankan migration. Untuk database baru/lain, periksa versi dan ikuti [handoff SQL](docs/SQL_EDITOR_HANDOFF.md).

Simulasi Supabase21Okt mencatat15tahapPASS melalui UI dan API aplikasi; pembayaran tetap INTERNAL_MANUAL, bukan bank/Midtrans. Evidence sanitasi ada di [hasil verifikasi](docs/verification/2026-10-21-hosted-workflows.json). Catatan di bawah bersifat historis jika statusnya bertentangan dengan bagian ini.

---

# Pembaruan 21 Oktober 2026 — aktivasi workflow internal

Untuk database TransRent existing yang sudah migration 014, jalankan **hanya `supabase/transrent-business-update-bundle.sql` (015–016)** di SQL Editor project yang sama dengan backend/.env. Agen belum menjalankannya pada Supabase. Hentikan backend saat eksekusi, tunggu hasil `BUSINESS_BUNDLE_OK`, review `archived_duplicate_count`, lalu restart backend dan pastikan `/api/health/deep` menampilkan `schemaReady: true`.

Bundle membuat snapshot privat sebelum migrasi dan melewati versi yang sudah tercatat. Snapshot berada di database yang sama, bukan backup offsite. Permintaan MoU terbuka duplikat diarsipkan dengan memprioritaskan yang sudah upload lalu yang terakhir diperbarui; PDF/data asli tetap tersimpan. Pemetaan GPS duplikat menghentikan migrasi agar direkonsiliasi manual.

**Jangan jalankan `transrent-bootstrap.sql` pada database existing.** File itu hanya untuk database kosong, 001–016 tanpa seed. Bundle lama 010–014 tidak perlu diulang.

Setelah migrasi: default pembayaran `INTERNAL_MANUAL`; checkout → deklarasi customer → review admin → receipt. Refund positif perlu pencatatan payout. Tidak ada uang nyata, bank atau Midtrans. Untuk GPS, isi `GPS_INGEST_TOKEN` acak minimal 32 karakter yang sama pada backend dan simulator. Undangan memakai Supabase Auth: atur `FRONTEND_ORIGIN`, redirect allowlist dan email provider sebelum mencoba akun nyata. Foto masih placeholder opsional; lihat `docs/DEFERRED_PHOTO_VALIDATION.md`.

Rincian logika dan file: `docs/IMPLEMENTATION_CHANGES.txt`. Pengujian lokal tidak membuktikan migrasi hosted, koneksi paralel, email atau PostGIS nyata. Backend menolak write 503 sampai marker 015–016 lengkap.

---

Catatan di bawah adalah riwayat implementasi sebelumnya.

# TransRent — Transportation Rental

Prototype MVP multi-perusahaan untuk demo mata kuliah Pemrograman Backend.

## Ringkasan aplikasi

TransRent mengelola rental kendaraan dari pencarian dan reservasi sampai serah terima, tracking, pengembalian, dan refund.

- **Customer:** mencari armada berdasarkan lokasi dan periode, membuat reservasi pickup atau delivery (maksimal 15 km), membayar lewat simulasi, serta mengirim dokumen verifikasi.
- **Staff Rental:** melakukan inspeksi BEFORE saat handover, inspeksi AFTER saat return, dan memantau kendaraan aktif.
- **Admin Rental:** mengelola reservasi, armada, GPS, maintenance, serta konfirmasi refund.
- **Admin Pusat:** memverifikasi customer, mengelola perusahaan rental dan undangan Admin Rental, serta mengatur MoU GPS.

Pembayaran masih simulasi dan lokasi GPS dapat berasal dari simulator. Mode demo menyimpan data di memori dan meresetnya saat backend restart; persistence nyata memerlukan konfigurasi Supabase dan migration database.

**Snapshot progress dokumen, 13 Oktober 2026:** core rental flow 100% (selesai), role/UI 95%, Admin Pusat company + MoU 90%, kesiapan production Supabase 65%, provider eksternal 35%, dan overall MVP 80%. Persentase ini adalah estimasi pada tanggal snapshot.

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

Requirements: Node.js 22+ (locked Supabase SDK); lokal diverifikasi menggunakan Node.js 24.18.1.

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

Untuk **database yang sudah ada**, gunakan [panduan SQL Editor](docs/SQL_EDITOR_HANDOFF.md): preflight → backup → migration 010 → 011 → 012 → verify. Jangan replay migration/seed lama. Agen tidak menjalankan SQL live; pemilik menjalankan skrip final melalui SQL Editor.

Untuk **project Supabase baru dan kosong**:

1. Jalankan `001_core.sql`, `002_profiles_and_rls.sql`, `003_api_grants.sql`.
2. Opsional untuk demo sintetis saja: jalankan `supabase/seed/demo_seed.sql` **sebelum** `004_seed_vehicles.sql`. Migration 004 bukan schema wajib; jangan menjalankannya tanpa data perusahaan/cabang/GPS yang dirujuk.
3. Jalankan `005_hardening.sql`, `006_storage.sql`, `007_gps_agreements.sql`, `008_company_onboarding.sql`, `009_auto_mou_number.sql`.
4. Jalankan migration `010_atomic_rental_operations.sql`, kemudian `011_mou_owner_upload.sql` dan `012_online_mou_simulation.sql`. Jalankan bagian schema/RPC dari verify; query schema backup hanya berlaku setelah `01_backup.sql` digunakan.

Migration 007 memasukkan MoU dummy jika perusahaan demo sudah aktif. MoU dummy hanya untuk lingkungan demo akademik, bukan dokumen legal. Pada project baru tanpa seed, onboarding membuat MoU pending dan pemilik mengunggah dokumen kedua pihak sebelum review.

Migration menggunakan PostGIS untuk koordinat cabang, delivery, dan histori lokasi kendaraan. `005_hardening.sql` menambahkan index expiry, index maintenance/GPS, dan unique mapping GPS jika data lama tidak duplikat. `006_storage.sql` membuat bucket private untuk KTP/SIM, foto inspeksi, dan tanda tangan. `007_gps_agreements.sql` mencatat MoU GPS per perusahaan. `008_company_onboarding.sql` membatasi satu MoU ACTIVE per perusahaan dan memvalidasi rentang tanggal; `009_auto_mou_number.sql` menambahkan nomor MoU otomatis melalui sequence database. 010 menyatukan penulisan rental dalam transaksi dan menutup INSERT customer langsung; 011 menambahkan upload PDF final pemilik dan review hash dokumen. Mode simulasi tetap digunakan untuk pembayaran.

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

## Stabilisasi dan MoU, 14 Oktober 2026

Return UI mengirim JSON; backend memvalidasi tanggal/denda, menolak refund prematur dan rental ganda, menjaga kendaraan saat maintenance, serta membatasi identitas/GPS pada akses yang diperlukan. Penulisan Supabase menggunakan RPC dan memerlukan migration 010/011/012; sebelum migration, operasi tersebut gagal tertutup dengan 503.

[Alur MoU dan sumber resmi](docs/MOU_WORKFLOW.md) · [Checkpoint implementasi](docs/IMPLEMENTATION_STATUS.md)

Template fisik dan digital tersedia di `docs/templates/` serta menu **MoU layanan** untuk Admin Rental. Admin Pusat mengunduh PDF final, memeriksa tanda tangan/meterai dan periode, lalu mengaktifkan MoU. Keaslian meterai/TTE belum diverifikasi otomatis.

Uji PostgreSQL terisolasi (tidak menyentuh Supabase live):

```bash
npm ci --prefix supabase/tests --ignore-scripts
npm test --prefix supabase/tests
```

Suite SQL memakai PostgreSQL PGlite dengan PostGIS stub: geometri delivery dan koneksi paralel nyata belum diuji. `npm test` backend memaksa mode demo sintetis meskipun `.env` berisi Supabase live.

## MoU online simulasi akademik

Menu Admin Rental **MoU layanan** menyediakan **Buka persetujuan online** pada MoU draft/pending. Popup mewajibkan checkbox Terms and Conditions, kewenangan, privasi dan simulasi. Pemilik memilih meterai simulasi; nama/persetujuan dan PDF dibuat otomatis tanpa cetak/upload ulang. Receipt tersimpan terpisah dari MoU resmi dan tidak mengaktifkan MoU/GPS. Semua halaman PDF diberi label SIMULASI AKADEMIK.

Backend menggunakan PDFKit 0.20.2. Supabase memerlukan migration 012; tidak ada API provider e-Meterai/TTE nyata yang diaktifkan. Contoh output menggunakan data sintetis. Rincian seluruh perubahan logika/file tersedia di `docs/IMPLEMENTATION_CHANGES.txt` setelah implementasi selesai.


## Pembayaran dan penyelesaian rental (20 Oktober 2026)

Customer dapat membatalkan sebelum handover, mengajukan sengketa, serta melunasi
selisih denda setelah deposit lewat menu **Rental & denda**. Admin Rental/Pusat
memutuskan sengketa beserta alasan dan mengonfirmasi refund setelah selisih lunas.
Pembatalan sebelum handover mengembalikan pembayaran penuh melalui simulator.
Kendaraan rusak tetap MAINTENANCE sampai pekerjaan REPAIR selesai; cancel atau
penyelesaian SERVICE biasa tidak menghapus penanda kerusakan.

Backend sekarang memerlukan migration **014**. Jalankan hanya
`supabase/transrent-update-bundle.sql` melalui SQL Editor: preflight, snapshot,
selective migration 010–014 dan verifikasi sudah digabung. Jangan replay seed.
Agen belum menjalankan SQL live. Ikuti [handoff SQL](docs/SQL_EDITOR_HANDOFF.md)
dan [rincian perubahan](docs/IMPLEMENTATION_CHANGES.txt) sebelum restart layanan.
