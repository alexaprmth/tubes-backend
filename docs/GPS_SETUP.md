# Konfigurasi GPS persisten

Backend dan simulator berbagi `backend/.env` lokal. File ini diabaikan Git.
`simulator/config.js` membaca file berdasarkan lokasi modul, sehingga simulator
boleh dimulai dari root repo atau folder simulator. Environment proses yang
sengaja diberikan tetap mengungguli file, mengikuti perilaku dotenv backend.
Tidak ada token ditulis pada source, command line atau contoh konfigurasi.

## Jalankan dan restart

Dari root repo, setelah dependency backend tersedia:

```powershell
npm run start:backend
```

Di terminal terpisah:

```powershell
npm run start:gps
```

Isi lokal `GPS_INGEST_TOKEN` acak minimal32karakter dan `GPS_DEVICE_ID` perangkat
QA yang tepat di `backend/.env`. Nilai token jangan disalin ke chat/Git. Contoh
nama variabel tanpa credential ada di `backend/.env.example`.
`GPS_INTERVAL_MS` default10000 (minimal1000). `TRANSRENT_API_URL` opsional; default
menggunakan PORT backend (4100 jika tidak diisi) pada localhost.

Hentikan dengan Ctrl+C dan jalankan perintah yang sama untuk restart. Token dan
pilihan perangkat tidak perlu diekspor ulang ke PowerShell. Jika token diubah,
restart kedua proses agar konsisten. Jangan memakai environment override lama
yang berbeda dengan file. Ini persistensi konfigurasi saat aplikasi direstart,
bukan instalasi Windows service atau autorun setelah reboot komputer.

Simulator hanya menghasilkan lokasi sintetis. Gunakan perangkat QA dengan GPS
READY, perusahaan/MoU aktif, izin GPS dan rental ACTIVE. Konfigurasi valid tidak
melewati syarat tersebut. Jangan mengirim titik demo ke rental pengguna lain.
Backend tetap menolak token salah dengan401 dan token yang belum dikonfigurasi
minimum32karakter dengan503.

## Verifikasi26Oktober2026

- `npm run test:gps`:2/2lulus; pembacaan ulang file, cwd berbeda, process override,
  tidak mengembalikan service key, validasi token/device/interval.
- Backend Supabase: schemaReadytrue, marker010–016 terdeteksi read-only.
- Satu rental sintetis menggunakan akun dan perangkat QA existing dibuat melalui
  API aplikasi; ledger INTERNAL_MANUAL, tidak ada transfer nyata atau SQL langsung.
- Sebelum restart: telemetry diterima dan token salah401.
- Backend dan simulator dihentikan, lalu keduanya dimulai sebagai proses baru
  tanpa ekspor token. Simulator berpindah cwd dari root ke folder simulator.
- Setelah restart: titik baru bertimestamp setelah restart tersimpan di Supabase,
  token tidak berubah (dibandingkan secara privat), token salah tetap401.
- Rental QA dan kedua proses dipertahankan aktif untuk demo. Database tidak
  direset. Pencabutan/expiry MoU tidak diuji ulang pada sesi ini.

Unit test dijalankan dengan token sintetis. Fingerprint/token aktual dan sesi
QA tidak disertakan dokumen atau repository. Hasil rinci sanitasi disimpan di
`docs/verification/2026-10-26-gps-persistence.json`.
