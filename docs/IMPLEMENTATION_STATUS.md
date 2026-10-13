# TransRent — Status Implementasi Prioritas 1–7

Dokumen ini menjadi checklist singkat untuk demo dan pengembangan setelah demo.

## Sudah tersedia di kode

| Prioritas | Hasil |
|---|---|
| 1. Supabase & stabilisasi | `db.js` membedakan mode demo/Supabase, `/api/health/deep` melakukan query nyata, error JWT diberi kode `SUPABASE_JWT_CLOCK_SKEW`, expiry reservation diproses setiap 60 detik. |
| 2. Dokumentasi API | Swagger UI di `/api-docs/`, JSON OpenAPI di `/api/openapi.json`, dependency `swagger-ui-express` sudah tercantum di backend. |
| 3. File & lifecycle | Adapter Supabase Storage untuk KTP/SIM/foto/tanda tangan, migration bucket private, endpoint maintenance start/complete/cancel, kendaraan kembali `AVAILABLE` setelah maintenance selesai bila GPS READY. |
| 4. Pembayaran | Payment port sederhana dengan provider `SIMULATED_GATEWAY`; endpoint simulasi tetap kompatibel dan Midtrans dapat menjadi adapter berikutnya. |
| 5. Security & GPS | Role/company isolation, optional `GPS_INGEST_TOKEN`, diagnostik mapping GPS di `/api/admin/gps/diagnostics`, unique index mapping GPS jika data tidak duplikat. |
| 6. Testing | Unit test domain untuk jarak Haversine, durasi rental, dan radius delivery; frontend production build berhasil. |
| 7. Handoff | README, env example, migration order, simulator token, troubleshooting JWT, dan checklist demo. |

## Yang tetap perlu dilakukan di project lokal

1. Salin perubahan dari paket/source ini ke folder project Windows.
2. Jalankan `npm install` di `backend` agar `swagger-ui-express` terpasang.
3. Jalankan migration `005_hardening.sql` dan `006_storage.sql` pada Supabase.
4. Pastikan `SUPABASE_URL`, `SUPABASE_ANON_KEY`, dan `SUPABASE_SERVICE_ROLE_KEY` benar.
5. Jalankan `GET /api/health/deep`; jika ada `SUPABASE_JWT_CLOCK_SKEW`, perbaiki jam Windows.
6. Login sebagai admin lalu cek `GET /api/admin/gps/diagnostics`.
7. Hanya setelah handover berstatus `ACTIVE`, jalankan simulator GPS.

## Belum dapat dianggap selesai tanpa data/provider nyata

- Kredensial Midtrans Sandbox dan webhook publik.
- Hardware GPS serta MoU dengan perusahaan rental.
- Deployment backend/frontend ke host publik.
- Pembersihan mapping GPS duplikat yang mungkin sudah telanjur ada di project Supabase.
- Notifikasi WhatsApp.
- Computer vision untuk deteksi kerusakan; untuk demo tetap manual melalui checklist/foto.

