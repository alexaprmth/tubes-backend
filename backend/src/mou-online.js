import { createHash, randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { supabase } from './db.js';
import { storageInfo } from './storage.js';
import { readMou, parseMouPdf } from './mou.js';
import { demoState } from './data/demoData.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const onlineTerms = Object.freeze({
  version: 'ACADEMIC-MOU-2026-10-14-v2',
  title: 'Ketentuan Draf MoU Online',
  clauses: [
    { title: 'Tujuan kerja sama', text: 'TransRent membantu pengelolaan armada, reservasi, serah terima, inspeksi, pengembalian, denda/refund, dan GPS untuk kebutuhan demonstrasi akademik.' },
    { title: 'Kewenangan dan data perusahaan', text: 'Pemilik rental memastikan kewenangan mewakili perusahaan dan kebenaran informasi armada, petugas, harga, serta data yang dimasukkan. Akses akun dibatasi sesuai tugas.' },
    { title: 'GPS dan privasi', text: 'Lokasi dipakai untuk operasional dan pengamanan kendaraan dalam rental yang sah. Customer hanya melihat GPS rental aktif miliknya. Pemilik menjelaskan penggunaan GPS kepada pelanggan/pengemudi dan memastikan dasar pemrosesan data yang sah.' },
    { title: 'Pelindungan data', text: 'Identitas, kontak, dokumen, dan lokasi dibatasi untuk pihak yang memerlukan. Dasar pemrosesan, masa simpan, penghapusan, penanganan hak subjek data, dan insiden harus disepakati sebelum penggunaan produksi. Persetujuan pemilik bukan persetujuan seluruh pelanggan.' },
    { title: 'Pembayaran dan biaya', text: 'Mode akademik tidak memproses pembayaran, refund atau pembelian meterai nyata. Tidak ada pembelian meterai atau penarikan biaya nyata dalam alur ini. Hubungan sewa dan penyelesaian denda dengan pelanggan memerlukan perjanjian sewa tersendiri.' },
    { title: 'Masa berlaku dan perubahan', text: 'Periode draf mengikuti tanggal yang dipilih. Perubahan perjanjian harus disepakati kedua pihak; draf ini menunggu MoU final yang telah ditandatangani dan diunggah.' },
    { title: 'Persetujuan akun', text: 'Checkbox mencatat tindakan persetujuan akun pada versi ketentuan ini. Nama akun dan ruang meterai Rp10.000 bukan tanda tangan elektronik tersertifikasi atau e-Meterai asli. Dokumen ini tidak mengaktifkan MoU resmi atau izin GPS.' }
  ],
  checks: [
    { id: 'terms', label: 'Saya telah membaca dan menyetujui seluruh ketentuan di atas.' },
    { id: 'authority', label: 'Saya berwenang mewakili perusahaan rental dan data perusahaan benar.' },
    { id: 'privacy', label: 'Saya memahami batas penggunaan GPS dan kewajiban pelindungan data pelanggan.' },
    { id: 'simulation', label: 'Saya memahami bahwa draf ini masih memerlukan tanda tangan kedua pihak dan pembubuhan meterai resmi.' }
  ]
});
export const termsHash = createHash('sha256').update(JSON.stringify(onlineTerms)).digest('hex');
export const validateOnlineConsent = (payload) => {
  if (!payload || payload.termsHash !== termsHash || payload.termsVersion !== onlineTerms.version) fail(409, 'Versi ketentuan berubah. Buka ulang popup dan baca kembali.');
  if (onlineTerms.checks.some(({ id }) => payload.consents?.[id] !== true)) fail(400, 'Semua persetujuan wajib dicentang.');
  if (payload.includeSimulatedMeterai !== true) fail(400, 'Setujui penyediaan ruang meterai pada draf.');
  const value = payload.expiresAt;
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:59+08:00`) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || date <= new Date()) fail(400, 'Tanggal berakhir draf harus valid dan belum terlewati.');
};

export const createOnlinePdf = ({ agreementNumber, companyName, signerName, acceptedAt, expiresAt, receiptId }) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: 'MoU TransRent - DRAF', Author: 'TransRent Academic Demo' } });
  const chunks = []; doc.on('data', (chunk) => chunks.push(chunk)); doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks)));
  const paragraph = (text) => { doc.font('Helvetica').fontSize(10).fillColor('#111111').text(text, 48, doc.y, { lineGap: 3 }); doc.moveDown(0.6); };
  doc.font('Helvetica-Bold').fontSize(17).text('MoU Layanan TransRent');
  doc.fontSize(11).fillColor('#a12626').text('DRAF - MENUNGGU TANDA TANGAN DAN METERAI RESMI'); doc.moveDown();
  paragraph(`Nomor MoU: ${agreementNumber}\nPihak pertama: Pengelola TransRent\nPihak kedua: ${companyName}\nPerwakilan pemilik rental: ${signerName}\nPersetujuan: ${acceptedAt}\nBerlaku sampai: ${expiresAt}`);
  for (const [index, clause] of onlineTerms.clauses.entries()) {
    if (doc.y + 100 > 750) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(`${index + 1}. ${clause.title}`); doc.moveDown(0.3); paragraph(clause.text);
  }
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(15).text('Bukti Persetujuan Akun'); doc.moveDown();
  paragraph(`Perusahaan: ${companyName}\nAkun yang menyetujui: ${signerName}\nWaktu server (UTC): ${acceptedAt}\nID persetujuan: ${receiptId}\nVersi ketentuan: ${onlineTerms.version}`);
  for (const { label } of onlineTerms.checks) paragraph(`[DISETUJUI] ${label}`);
  const y = doc.y + 12;
  doc.font('Helvetica-Bold').fontSize(11).text('Pengelola TransRent', 48, y, { width: 210 });
  doc.text('Pemilik Rental', 320, y, { width: 220 });
  doc.font('Helvetica-Oblique').fontSize(12).text('Belum ditandatangani', 48, y + 30, { width: 210 });
  doc.text(`${signerName}\nNama akun - belum ditandatangani`, 320, y + 30, { width: 220 });
  doc.rect(48, y + 85, 250, 58).strokeColor('#a12626').stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#a12626').text('RUANG METERAI Rp10.000', 58, y + 99, { width: 230 });
  doc.fontSize(9).text('BELUM DIBUBUHI METERAI RESMI', 58, y + 122, { width: 230 });
  doc.y = y + 163; paragraph('Nama dan kotak di atas bukan tanda tangan elektronik tersertifikasi, sertifikat digital, meterai resmi, atau persetujuan asli Pengelola TransRent. Tidak ada pembelian maupun pembubuhan meterai resmi.');
  paragraph(`Hash ketentuan (SHA-256):\n${termsHash}`);
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i); doc.font('Helvetica').fontSize(8).fillColor('#a12626').text(`DRAF | ${i + 1}/${range.count}`, 48, 18, { width: 500, lineBreak: false });
  }
  doc.end();
});

export const submitOnlineSimulation = async (actor, id, payload) => {
  validateOnlineConsent(payload);
  const agreement = await readMou(actor, id);
  if (actor.role !== 'RENTAL_ADMIN' || actor.companyId !== (agreement.company_id || agreement.companyId)) fail(403, 'Hanya pemilik perusahaan ini yang dapat menyetujui.');
  if (!['DRAFT', 'PENDING'].includes(agreement.status)) fail(409, 'Gunakan MoU draft/pending untuk draf online baru.');
  if (agreement.online_simulation || agreement.onlineSimulation) fail(409, 'Draf telah dibuat. Download bukti yang sudah tersimpan.');
  if (supabase) {
    const ready = await supabase.from('transrent_schema_versions').select('version').eq('version', '013').limit(1);
    if (ready.error || !ready.data?.length) fail(503, 'Migration 013 belum tersedia. Jalankan melalui SQL Editor sebelum membuat surat.');
  }
  let company;
  if (!supabase) company = demoState.companies.find((c) => c.id === actor.companyId);
  else {
    const result = await supabase.from('rental_companies').select('id,name,legal_name').eq('id', actor.companyId).maybeSingle();
    if (result.error) fail(502, 'Gagal membaca perusahaan.'); company = result.data;
  }
  if (!company || !(company.legal_name || company.legalName || company.name) || (company.legal_name || company.legalName || company.name).length > 200 || !actor.name || actor.name.length > 200) fail(400, 'Identitas perusahaan/akun belum lengkap.');
  const receipt = { receiptId: randomUUID(), acceptedAt: new Date().toISOString(), acceptedBy: actor.id, termsVersion: onlineTerms.version, termsHash, consents: Object.fromEntries(onlineTerms.checks.map(({ id }) => [id, true])), mode: 'ACADEMIC_SIMULATION', expiresAt: payload.expiresAt };
  const bytes = await createOnlinePdf({ agreementNumber: agreement.agreement_number || agreement.agreementNumber, companyName: company.legal_name || company.legalName || company.name, signerName: actor.name, ...receipt });
  receipt.sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!supabase) {
    agreement.onlineSimulation = { ...receipt, documentDataUrl: `data:application/pdf;base64,${bytes.toString('base64')}` };
    return { simulation: receipt };
  }
  const path = `agreements-simulation/${actor.companyId}/${id}/${receipt.receiptId}.pdf`;
  const uploaded = await supabase.storage.from(storageInfo.bucket).upload(path, bytes, { contentType: 'application/pdf', upsert: false });
  if (uploaded.error) fail(502, 'Gagal menyimpan PDF draf.');
  const result = await supabase.rpc('transrent_mou_simulation', { p_actor: actor.id, p_id: id, p_receipt: { ...receipt, documentPath: path } });
  if (result.error) {
    const cleanup = await supabase.storage.from(storageInfo.bucket).remove([path]);
    if (cleanup.error) console.warn('Simulation upload cleanup pending:', path);
    if (result.error.code === 'PGRST202') fail(503, 'Migration 013 belum tersedia. Jalankan melalui SQL Editor.');
    fail(/^PT\d{3}$/.test(result.error.code) ? Number(result.error.code.slice(2)) : 502, result.error.message);
  }
  return { simulation: receipt };
};
export const downloadOnlineSimulation = async (actor, id) => {
  const agreement = await readMou(actor, id);
  const receipt = agreement.online_simulation || agreement.onlineSimulation;
  if (!receipt || receipt.mode !== 'ACADEMIC_SIMULATION') fail(404, 'Dokumen draf belum dibuat.');
  if (!supabase) return parseMouPdf(receipt.documentDataUrl);
  const { data, error } = await supabase.storage.from(storageInfo.bucket).download(receipt.documentPath);
  if (error) fail(502, 'Gagal mengambil PDF draf.');
  return Buffer.from(await data.arrayBuffer());
};
