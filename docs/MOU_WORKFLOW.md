# MoU TransRent: dokumen final diunggah pemilik rental

Keputusan dan penelitian: 14 Oktober 2026. Template merupakan draf yang harus dilengkapi dengan identitas, kewenangan, periode, biaya, parameter data/GPS, dan forum sengketa yang disepakati kedua pihak.

## Jalur yang dipakai

1. Admin Pusat membuat perusahaan dan MoU DRAFT/PENDING. Pemilik menerima akun RENTAL_ADMIN perusahaan tersebut.
2. Para pihak mengisi template DOCX beserta Lampiran A dan daftar armada. Kedua pihak menyepakati isinya sebelum menandatangani.
3. Pilih satu jalur:
   - **Fisik:** cetak dokumen final, kedua pihak membubuhkan tanda tangan basah, gunakan meterai tempel asli Rp10.000 sesuai kewajiban dokumen/rangkap, pindai seluruh halaman menjadi PDF, dan simpan dokumen fisik asli.
   - **Elektronik:** ekspor PDF final, gunakan tanda tangan elektronik (disarankan PSrE tersertifikasi) dan e-Meterai asli dari penyedia resmi. Ikuti urutan/alur penyedia yang menjaga validitas tanda tangan. Upload PDF final asli tanpa perubahan, kompresi, atau cetak-pindai.
4. Pemilik rental membuka **MoU layanan**, memilih nomor MoU, jenis meterai dan tanggal sesuai dokumen, kemudian upload PDF final maksimal 8 MB. Status menjadi PENDING dan izin GPS belum aktif.
5. Admin Pusat mengunduh PDF final, memeriksa kelengkapan, kewenangan dan tanda tangan kedua pihak, keaslian meterai, kecocokan perusahaan/nomor/tanggal, serta Lampiran A. Untuk dokumen elektronik periksa validasi tanda tangan dan meterai pada PDF/provider resmi. Aktivasi meminta pernyataan review eksplisit dan hash dokumen yang sama.
6. Dokumen yang sudah diaktifkan tidak dapat diganti pemilik. Perubahan dibuat melalui MoU baru/addendum. Dokumen lama tetap ada; satu perusahaan hanya memiliki satu MoU ACTIVE.

## Dasar pemilihan

Bea Meterai merupakan pajak atas dokumen. Tarif Rp10.000 dikenakan per dokumen; surat perjanjian beserta rangkapnya termasuk objek. Untuk perjanjian dua pihak, kewajiban terkait dokumen yang diterima masing-masing pihak perlu diperhitungkan. Template menyediakan ruang meterai pada kedua kolom untuk kebutuhan rangkap, bukan menetapkan bahwa setiap PDF wajib memiliki dua meterai. [DJP: Bea Meterai](https://www.pajak.go.id/id/bea-meterai), [UU 10/2020](https://peraturan.bpk.go.id/Details/149748/uu-no-10-tahun-2020).

Meterai tempel dan tanda tangan basah mengikuti tata cara fisik. e-Meterai dan tanda tangan elektronik ditempatkan berdampingan agar tidak menghalangi kode/verifikasi; gambar meterai yang ditempel di Word bukan e-Meterai asli. [PERURI: penempatan meterai dan tanda tangan](https://www.peruri.co.id/press-release/mana-yang-lebih-dulu-pembubuhan-meterai-elektronik-atau-tanda-tangan-digital), [PERURI: pemeriksaan keaslian](https://www.peruri.co.id/press-release/awas-jangan-sampai-membeli-meterai-elektronik-palsu-1).

Ketentuan pelaksanaan Bea Meterai saat penelitian dirujuk ke PMK 78 Tahun 2024, yang menggantikan ketentuan PMK terdahulu terkait pelaksanaan tersebut. [JDIH Kementerian Keuangan](https://jdih.kemenkeu.go.id/dok/pmk-78-tahun-2024/files).

Meterai tidak menggantikan tanda tangan, kewenangan pihak, atau persetujuan atas isi. Penggunaan tanda tangan elektronik perlu memenuhi persyaratan identitas dan integritas yang berlaku. [PP 71/2019, ketentuan tanda tangan elektronik](https://jdih.komdigi.go.id/produk_hukum/view/id/695/t/common).

GPS dapat menyangkut data pribadi pelanggan/pengemudi. MoU pemilik rental saja tidak memberi persetujuan atas nama semua subjek data. Lampiran menetapkan tujuan, dasar pemrosesan, peran para pihak, akses, masa simpan, dan penanganan hak/insiden. [UU 27/2022 Pelindungan Data Pribadi](https://peraturan.bpk.go.id/Download/224884/UU%20Nomor%2027%20Tahun%202022.pdf).

## Implementasi dan batasnya

- PDF diunggah ke bucket privat dengan path UUID, tanpa upsert; SHA-256 dihitung backend dari byte asli. Download memerlukan autentikasi dan akses perusahaan/pusat.
- Metadata review mengikat hash terakhir. Hash membuktikan kesamaan byte, bukan keabsahan hukum atau keaslian meterai/tanda tangan.
- Validasi upload memeriksa format data URL, header PDF, ukuran dan akses; validasi struktur lengkap, malware, sertifikat TTE, serta e-Meterai belum otomatis. Review adalah pemeriksaan manusia di luar aplikasi.
- Tidak ada pembelian meterai atau penandatanganan berbayar yang otomatis diintegrasikan.
- MoU ACTIVE lama/demo tidak otomatis dicabut oleh migration. Aktivasi baru menggunakan alur review ini; dokumen demo bukan bukti perjanjian produksi.
- Upload Storage dan transaksi database adalah layanan berbeda. File MoU dari transaksi gagal dibersihkan sebisa mungkin; file dari penggantian pending sebelumnya tetap privat untuk audit. Kebijakan retensi/pembersihan arsip perlu ditetapkan sebelum produksi.
- Template berisi placeholder; jangan menandatangani versi kosong. Untuk konteks akademik, biaya dan status simulasi harus dinyatakan dalam Lampiran A.


## Jalur online demo tanpa upload ulang

Pemilik memilih MoU DRAFT/PENDING, menekan **Buka persetujuan online**, membaca tujuh ketentuan dalam popup, mencentang empat persetujuan dan pilihan meterai simulasi, serta memilih masa berlaku. Backend membandingkan hash/versi ketentuan, memeriksa checkbox/tanggal/perusahaan, dan membuat PDF otomatis memakai data akun/perusahaan. Tombol submit baru aktif setelah isian lengkap.

PDF memuat ketentuan, bukti persetujuan, nama kedua pihak untuk simulasi, kotak meterai Rp10.000 bertuliskan SIMULASI, dan penjelasan bahwa ini bukan TTE atau e-Meterai asli. Dokumen dan metadata disimpan privat di `online_simulation`; download otomatis dicoba dan tombol download ulang tersedia untuk pemilik/Admin Pusat. Satu bukti dibuat per MoU; retry tidak menghasilkan persetujuan baru.

Dokumen simulasi tidak menggantikan `document_path`/`document_metadata`, tidak menandai dua pihak benar-benar menandatangani, dan tidak mengaktifkan MoU/GPS. Jalur upload final untuk fisik atau elektronik resmi tetap tersedia. Provider resmi dan biaya transaksi ditunda sesuai keputusan pemilik tentang demo akademik.

Implementasi online memerlukan migration 012 untuk Supabase. Mode demo tanpa Supabase menyimpan receipt di memory, hilang saat restart seperti data demo lain. Browser download yang gagal tidak mengulang consent; pengguna mengunduh kembali bukti yang tersimpan.


## Revisi draf (14 Oktober 2026)

PDF online terbaru tanpa kata simulasi dan ditandai DRAF. Persetujuan akun serta ruang meterai belum merupakan TTD/e-Meterai resmi. Gunakan satu `supabase/transrent-update-bundle.sql` (010-013). Ketentuan v2 memerlukan 013; bukti lama tetap utuh. Tombol template telah diperbaiki; tombol proses memerlukan MoU DRAFT/PENDING, dan popup memerlukan seluruh checkbox, tanggal serta schema siap.


## Alur terbaru: permintaan melalui aplikasi

1. Admin Pusat memilih perusahaan dan mengirim permintaan MoU dengan catatan.
2. PermintaanPENDING muncul di menu MoUlayanan pemilik perusahaan.
3. Pemilik membaca/menyetujui ketentuan untuk membuat PDFdraf, atau mengunggah PDF
   final dengan tanda tangan/meterai asli dan tanggal final.
4. Admin Pusat mereview hash dokumen final, kedua tanda tangan/meterai dan periode;
   aktivasi memerlukan perusahaanACTIVE.

Admin Pusat tidak mengunggah file atau mengisi tanggal tanda tangan pada pembuatan
permintaan. Tidak ada pengirimanemail dalam action ini. Bukti draft online belum
merupakan MoU final. Tidak ada migration tambahan untuk perubahan UI/APIini.
