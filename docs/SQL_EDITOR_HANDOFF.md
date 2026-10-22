# Status database saat publikasi feature-update — 22 Oktober 2026

Read-only database yang ditunjuk backend/.env: migration010–016 terpasang, pemetaan GPS tidak duplikat. Owner telah menjalankan rekonsiliasi GPS akademik dan bundle015–016. Tidak perlu mengulang SQL pada database ini karena commit/push. Perangkat ACADEMIC_DEMO adalah virtual, bukan verifikasi hardware nyata.

Bagian berikut adalah petunjuk untuk database lain yang masih di014 dan riwayat handoff. Bootstrap hanya untuk database kosong. Selalu verifikasi target dan versi; menjalankan SQL pada lingkungan lain memerlukan persetujuan pemilik tersendiri. Tidak ada SQL yang dijalankan saat publikasi branch ini.

---

# Pembaruan 21 Oktober 2026 — aktivasi workflow internal

Untuk database TransRent existing yang sudah migration 014, jalankan **hanya `supabase/transrent-business-update-bundle.sql` (015–016)** di SQL Editor project yang sama dengan backend/.env. Agen belum menjalankannya pada Supabase. Hentikan backend saat eksekusi, tunggu hasil `BUSINESS_BUNDLE_OK`, review `archived_duplicate_count`, lalu restart backend dan pastikan `/api/health/deep` menampilkan `schemaReady: true`.

Bundle membuat snapshot privat sebelum migrasi dan melewati versi yang sudah tercatat. Snapshot berada di database yang sama, bukan backup offsite. Permintaan MoU terbuka duplikat diarsipkan dengan memprioritaskan yang sudah upload lalu yang terakhir diperbarui; PDF/data asli tetap tersimpan. Pemetaan GPS duplikat menghentikan migrasi agar direkonsiliasi manual.

**Jangan jalankan `transrent-bootstrap.sql` pada database existing.** File itu hanya untuk database kosong, 001–016 tanpa seed. Bundle lama 010–014 tidak perlu diulang.

Setelah migrasi: default pembayaran `INTERNAL_MANUAL`; checkout → deklarasi customer → review admin → receipt. Refund positif perlu pencatatan payout. Tidak ada uang nyata, bank atau Midtrans. Untuk GPS, isi `GPS_INGEST_TOKEN` acak minimal 32 karakter yang sama pada backend dan simulator. Undangan memakai Supabase Auth: atur `FRONTEND_ORIGIN`, redirect allowlist dan email provider sebelum mencoba akun nyata. Foto masih placeholder opsional; lihat `docs/DEFERRED_PHOTO_VALIDATION.md`.

Rincian logika dan file: `docs/IMPLEMENTATION_CHANGES.txt`. Pengujian lokal tidak membuktikan migrasi hosted, koneksi paralel, email atau PostGIS nyata. Backend menolak write 503 sampai marker 015–016 lengkap.

---

Catatan di bawah adalah riwayat implementasi sebelumnya.

# Handoff terbaru — bundle 010–014 (20 Oktober 2026)

**Agen belum menjalankan SQL live. Owner menjalankan satu file:
`supabase/transrent-update-bundle.sql`.** Jangan menjalankan migration satu per satu.

1. Pilih proyek Supabase yang sesuai `backend/.env`. Baca-saja pada 20 Oktober
   mengonfirmasi marker 010–013; fingerprint URL target `dfcce416dcb686d3`.
2. Hentikan backend saat migrasi. Tempel seluruh file bundle ke SQL Editor,
   jalankan dengan role owner/postgres. Bundle melewati versi yang sudah ada,
   membuat snapshot privat sebelum update, menerapkan 014 dan memeriksa hasilnya.
3. Pastikan hasil `BUNDLE_OK` mencantumkan **010,011,012,013,014**. Periksa hasil
   `legacy_completed_rentals_requiring_fine_reconciliation`: jika >0, review riwayat
   pembayaran di luar aplikasi sebelum meminta customer melunasi ulang.
4. Jalankan backend (`npm start` dari folder backend) dan frontend (`npm run dev`
   dari folder frontend), lalu refresh browser. Kode baru membutuhkan RPC v2/014.

014 menambah cancellation/refund receipt, fine payment receipt, bukti keputusan
sengketa, repair_required/backfill, indeks OPEN dispute dan RPC service-only.
Kendaraan yang pernah rusak tanpa catatan REPAIR selesai akan dikunci konservatif;
review riwayat dan catat REPAIR yang benar, jangan sekadar mengubah AVAILABLE.
Pembayaran/refund tetap akademik; tidak ada uang nyata atau API bank baru.

Snapshot berada di database yang sama; bukan offsite backup/restore otomatis.
Jika gagal: `ROLLBACK;`, perbaiki penyebab, jalankan ulang seluruh bundle.
Jangan replay bootstrap 001–009, seed, atau migration individual setelah sukses.
Pada replay sukses marker dilewati dan snapshot baru tidak dibuat.

SQL diuji pada PGlite dengan PostGIS stub dan data sintetis. Geometri asli,
paralelisme koneksi nyata, bisnis live dan klik browser belum diverifikasi.
Detail file/logika ada di `docs/IMPLEMENTATION_CHANGES.txt`.

---
## Catatan handoff sebelumnya (historis)

# Bundle SQL Editor

TRANSRENT - SATU BUNDLE SQL (14 Oktober 2026)

Jalankan hanya transrent-update-bundle.sql, seluruh isinya, di Supabase SQL Editor.
1. Pastikan project sama dengan backend/.env. Fingerprint URL: dfcce416dcb686d3.
2. Hentikan backend selama proses; pastikan restore point/provider backup sesuai kebutuhan.
3. Tempel seluruh file SQL, klik Run sebagai owner/postgres.
4. Hasil akhir harus BUNDLE_OK untuk 010, 011, 012, 013.
5. Nyalakan backend; /api/health/deep harus schemaReady=true.

Isi: preflight duplikat/nominal, snapshot privat data+definisi schema, 010 transaksi
rental atomic/grant, 011 upload/review MoU, 012 persetujuan online terpisah,
013 ketentuan draf v2, verifikasi versi/fungsi/grant/indeks. Tanpa 001-009 atau seed.
Versi terpasang dilewati. Snapshot baru dibuat hanya bila masih ada update tersisa.
Backup di database yang sama, bukan backup offsite atau restore otomatis.
Jangan expose schema transrent_backup_* melalui Data API.

Jika gagal: ROLLBACK; baca error, perbaiki penyebab, lalu ulangi seluruh bundle.
Migration dibatalkan bersama; snapshot sebelumnya tetap tersimpan.
Jangan menghapus duplikat otomatis atau menjalankan migration individual setelah sukses.

Admin Pusat membuat MoU DRAFT/PENDING untuk perusahaan; Admin Rental memilihnya.
Popup: centang 4 persetujuan + ruang meterai, isi tanggal berakhir, buat PDF draf.
Draf belum membubuhkan TTD/e-Meterai resmi dan belum mengaktifkan GPS.
PDF tersimpan lama tidak ditulis ulang; label baru berlaku untuk PDF baru.

SQL live belum dijalankan agen. Uji PGlite memakai stub PostGIS;
kompatibilitas data live dan concurrency PostgreSQL nyata belum diverifikasi.


## Verifikasi setelah owner menjalankan bundle (14 Oktober 2026, 03:20 UTC)

Screenshot owner menunjukkan private snapshot transrent_backup_20261014_031518_751799.
Read-only backend deep health: HTTP 200, ok=true, reachable=true, schemaReady=true,
marker 010/011/012/013 terpasang. Data API metadata HTTP 200 menampilkan ketiga RPC
transrent_transaction, transrent_mou dan transrent_mou_simulation; kolom MoU baru
dapat dibaca. Ini menggantikan checkpoint schemaReady=false/MIGRATION_REQUIRED.
Agen tidak menjalankan migration atau transaksi bisnis live. Transaksi aktual dan
validasi ulang constraint/grant melalui SQL belum diuji secara independen. Dua MoU
masih ACTIVE; fitur online baru memerlukan DRAFT/PENDING dari Admin Pusat.
