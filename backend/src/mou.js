import { randomUUID, createHash } from 'node:crypto';
import { supabase } from './db.js';
import { storageInfo } from './storage.js';
import { demoState } from './data/demoData.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const parseMouPdf = (value) => {
  if (typeof value !== 'string' || !/^data:application\/pdf;base64,[A-Za-z0-9+/=]+$/.test(value)) fail(400, 'MoU harus PDF.');
  const bytes = Buffer.from(value.split(',')[1], 'base64');
  if (bytes.length < 8 || bytes.length > 8 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-') fail(400, 'PDF tidak valid atau melebihi 8 MB.');
  return bytes;
};
const assertAccess = (actor, agreement, ownerOnly = false) => {
  if (!agreement) fail(404, 'MoU tidak ditemukan.');
  if (actor.role === 'CENTRAL_ADMIN' && !ownerOnly) return;
  if (actor.role !== 'RENTAL_ADMIN' || actor.companyId !== (agreement.company_id || agreement.companyId)) fail(403, 'Akses MoU tidak diizinkan.');
};
export const readMou = async (actor, id) => {
  if (!supabase) {
    const agreement = demoState.agreements.find((a) => a.id === id);
    assertAccess(actor, agreement);
    return agreement;
  }
  const { data, error } = await supabase.from('rental_company_agreements').select('*').eq('id', id).maybeSingle();
  if (error) fail(502, 'Gagal membaca MoU.');
  assertAccess(actor, data);
  return data;
};
export const mouDate = (value, endOfDay=false) => {
  if(typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const check=new Date(value+'T00:00:00Z');if(!Number.isFinite(check.getTime())||check.toISOString().slice(0,10)!==value)fail(400,'Tanggal MoU tidak valid.');
    return new Date(value+(endOfDay?'T23:59:59.999+08:00':'T00:00:00+08:00'));
  }
  return new Date(value);
};
export const submitMou = async (actor, id, payload) => {
  const agreement = await readMou(actor, id);
  assertAccess(actor, agreement, true);
  if (['ACTIVE','EXPIRED','REVOKED','ARCHIVED','WAITING_REVIEW'].includes(agreement.workflow_stage||agreement.workflowStage) || !['DRAFT', 'PENDING'].includes(agreement.status)) fail(409, 'Buat MoU baru untuk mengganti dokumen yang sudah diaktifkan.');
  if (!['PHYSICAL', 'E_METERAI'].includes(payload.stampType) || payload.bothPartiesSigned !== true) fail(400, 'Pilih jenis meterai dan pastikan kedua pihak telah menandatangani.');
  const signed = mouDate(payload.signedAt); const expires = mouDate(payload.expiresAt,true);
  if (!payload.signedAt || !Number.isFinite(signed.getTime()) || signed > new Date() || !payload.expiresAt || !Number.isFinite(expires.getTime()) || expires <= signed || expires <= new Date()) fail(400, 'Tanggal tanda tangan/berakhir tidak valid.');
  const bytes = parseMouPdf(payload.documentDataUrl);
  const simulation = agreement.online_simulation || agreement.onlineSimulation;
  if (simulation?.sha256 === createHash('sha256').update(bytes).digest('hex')) fail(409, 'Dokumen simulasi ini tidak dapat diunggah sebagai MoU final resmi.');
  const metadata = { sha256: createHash('sha256').update(bytes).digest('hex'), stampType: payload.stampType, uploadedAt: new Date().toISOString(), uploadedBy: actor.id, reviewed: false };
  if (!supabase) {
    agreement.documentVersions ||= [];if(agreement.documentPath)agreement.documentVersions.push({path:agreement.documentPath,metadata:agreement.documentMetadata});
    Object.assign(agreement, { workflowStage:'WAITING_REVIEW',documentPath: payload.documentDataUrl, documentMetadata: metadata, status: 'PENDING', gpsTrackingAllowed: false, signedAt: signed.toISOString(), expiresAt: expires.toISOString() });
    return { status: 'PENDING', documentMetadata: metadata };
  }
  const path = `agreements/${agreement.company_id}/${id}/${randomUUID()}.pdf`;
  const upload = await supabase.storage.from(storageInfo.bucket).upload(path, bytes, { contentType: 'application/pdf', upsert: false });
  if (upload.error) fail(502, 'Gagal menyimpan PDF. Pastikan bucket privat transrent-files tersedia.');
  const result = await supabase.rpc('transrent_mou', { p_actor: actor.id, p_id: id, p_action: 'UPLOAD', p_payload: { path, metadata, signedAt: signed.toISOString(), expiresAt: expires.toISOString() } });
  if (result.error) {
    const cleanup = await supabase.storage.from(storageInfo.bucket).remove([path]);
    if (cleanup.error) console.warn('MoU upload cleanup pending:', path);
    if (result.error.code === 'PGRST202') fail(503, 'Migration 011 belum tersedia.');
    fail(/^PT\d{3}$/.test(result.error.code) ? Number(result.error.code.slice(2)) : 502, result.error.message);
  }
  return { status: 'PENDING', documentMetadata: metadata };
};
export const downloadMou = async (actor, id, version) => {
  const agreement = await readMou(actor, id);
  const versions=agreement.document_versions||agreement.documentVersions||[];
  if(version!==undefined && (!/^\d+$/.test(String(version)) || !versions[Number(version)])) fail(404,'Versi dokumen tidak ditemukan.');
  const path = version===undefined ? agreement.document_path || agreement.documentPath : versions[Number(version)].path;
  if (!path) fail(404, 'Dokumen belum diunggah.');
  if (!supabase) return parseMouPdf(path);
  if (path.startsWith('data:') || !path.endsWith('.pdf')) fail(409, 'Dokumen lama perlu diperiksa dan diunggah sebagai PDF final.');
  const { data, error } = await supabase.storage.from(storageInfo.bucket).download(path);
  if (error) fail(502, 'Gagal mengambil PDF.');
  return Buffer.from(await data.arrayBuffer());
};
