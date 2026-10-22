# Pekerjaan tersisa dan rencana TransRent

Diperbarui: **22 Oktober 2026**. Branch publikasi: `feature-update`.

## Kondisi yang sudah terbukti

- Workflow internal pembayaran, deklarasi customer, persetujuan admin, pembatalan/refund, handover/return, sengketa OPEN/ADJUSTED, pelunasan selisih denda, payout deposit dan perbaikan kendaraan sudah diimplementasikan.
- Bukti **21 Oktober 2026** mencatat **15 tahap PASS** melalui kombinasi UI web utama dan API aplikasi terhadap Supabase, provider `INTERNAL_MANUAL`. Ini menggantikan catatan lama bahwa simulasi pascamigrasi belum dijalankan. Rincian sanitasi: [hasil verifikasi hosted](verification/2026-10-21-hosted-workflows.json).
- Inspeksi database read-only **22 Oktober 2026** memastikan marker `010`–`016` dan tidak ada duplikasi pemetaan GPS. Tidak ada SQL baru yang perlu dijalankan pada database yang diperiksa untuk publikasi branch ini. Checkout/push kode tidak menjalankan migrasi otomatis.
- Tes lokal terdahulu: backend20/20, frontend session3/3 dan regresi SQL PGlite lulus; build frontend setelah fix pergantian akun lulus75modul. Tidak menjalankan ulang test aplikasi saat commit/push22Okt.
- Data master, status/history/revisi MoU, dashboard sesuai peran, session refresh dan guard pergantian akun sudah ada. Tingkat verifikasi masing-masing fitur tetap dibedakan dari hasil demo ke integrasi produksi.

## Daftar pekerjaan dan urutan

| Urutan | Pekerjaan yang belum selesai | Langkah kerja | Syarat selesai |
|---|---|---|---|
| 1 — kesiapan demo | Konfigurasi GPS yang bertahan setelah restart | Simpan token acak minimal32karakter hanya di `.env` lokal backend dan lingkungan simulator; uji restart dan rental aktif yang mempunyai izin MoU | Telemetry diterima setelah restart, token salah ditolak, pencabutan/expiry MoU menutup akses; tidak ada secret di Git |
| 2 — onboarding | Pembuktian email undangan dan recovery pada Supabase Auth nyata | Atur redirect allowlist dan provider email; gunakan inbox uji milik pemilik; uji invite, set password, link expired, resend dan retry setup gagal | Owner dapat menyetel password dan login RENTAL_ADMIN perusahaan yang benar, tidak ada perusahaan/akun ganda atau perubahan role akun existing |
| 3 — MoU | Verifikasi end-to-end dokumen final dan semua transisi hosted | Gunakan perusahaan QA; request → owner upload PDF → review/revisi → upload versi baru → aktivasi → renewal/revoke/expiry; periksa private download dan tenant scope | Seluruh transisi, versi/hash PDF, alasan revisi dan penghentian GPS sesuai aturan; PDF draf tidak dianggap MoU resmi |
| 4 — regresi lanjutan | Cabang keputusan dan kondisi balapan yang belum dibuktikan pada hosted | Uji sengketa ACCEPTED/REJECTED, pembayaran REJECTED/EXPIRED, retry/double-click dan permintaan bersamaan, session refresh lintas peran serta akses lintas perusahaan | Bukti idempotensi, tidak ada double booking/payment/refund dan data tidak bocor; ACCEPTED/REJECTED lokal tidak disalahklaim sebagai hostedPASS |
| 5 — operasional | Kesiapan instalasi ulang, backup/restore dan verifikasi PostGIS asli | Rehearsal pada database disposable yang disetujui pemilik; cek bootstrap, migrasi, RLS/storage privat, jarak delivery/radius15km, restore snapshot dan backup offsite | Reproduksi instalasi baru dan pemulihan berhasil; pengujian SQL nyata mendapat izin terpisah; PGlite stub bukan bukti PostGIS/concurrency produksi |
| 6 — kualitas laporan | Sinkronisasi screenshot/caption dengan hasil terbaru | Pertahankan caption transaksi INTERNAL_MANUAL, pisahkan hasil simulator20Okt, ambil ulang hanya bagian yang berubah atau masih memakai placeholder | Screenshot dan status implementasi tidak mengklaim bank/TTD/e-Meterai/foto nyata; laporan BabIV yang sudah dibuat tidak perlu ditulis ulang seluruhnya |
| Tahap berikutnya — sesuai arahan pemilik | Integrasi Midtrans | Pertahankan ledger internal; mulai sandbox dengan order mapping, signature webhook, nominal server, idempotensi dan rekonsiliasi status/refund; gunakan credential lokal | Kasus success/pending/expire/cancel/refund dan webhook duplikat teruji sebelum production; saat ini **belum ada integrasi** |
| Ditunda oleh pemilik | Verifikasi berbasis foto/KTP/SIM/inspeksi | Tentukan reviewer/penyedia, privasi/retensi, alasan penolakan, perbaikan data dan banding sebelum membuat foto wajib | Ada proses verifikasi lanjutan yang nyata; saat ini foto tetap placeholder opsional. Detail: [backlog foto](DEFERRED_PHOTO_VALIDATION.md) |
| Opsional setelah demo | TTD/e-Meterai resmi dan GPS fisik | Pilih penyedia resmi/perangkat dan siapkan akses pemilik; integrasikan setelah kebutuhan disepakati | Bukti dari penyedia/perangkat; draf online, checkbox, nama akun atau GPS virtual tidak dianggap bukti resmi |

Urutan1–5 adalah urutan penyelesaian yang disarankan, bukan klaim bug baru maupun janji tanggal rilis. Integrasi eksternal memerlukan konfigurasi/akun dari pemilik; jangan kirim credential lewat chat atau commit.

## Hal yang tidak perlu diulang

- Perbaikan pembayaran/pembatalan, keputusan sengketa, selisih denda dan kendaraan rusak bukan daftar fitur yang belum dibuat; implementasi dan demo utama sudah selesai. Yang tersisa adalah cakupan verifikasi tambahan pada tabel di atas.
- SQL015–016 dan rekonsiliasi GPS sudah dijalankan pemilik. Jangan mengulang query perbaikan pramigrasi sebagai langkah demo harian.
- Bootstrap hanya untuk database kosong. Untuk database existing lain, identifikasi versi sebelum memilih bundle. Prosedur: [handoff SQL](SQL_EDITOR_HANDOFF.md).
- Hasil screenshot/QA historis dan audit20Okt adalah evidence bertanggal, bukan daftar bug aktif tanpa verifikasi ulang.

## Batas publikasi

Branch berisi kode, template aplikasi, migration/bundle SQL dan dokumentasi; tidak mencakup `.env`, token/session QA, database backup, screenshot data pengguna atau dokumen sumber pribadi. Tidak ada merge ke main atau SQL execution dalam proses publikasi. Hindsight academic tidak dapat diakses pada pemeriksaan karena autentikasi401; dokumen sumber dan checkpoint lokal dipakai sebagai evidence.
