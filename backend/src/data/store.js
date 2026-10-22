import { randomUUID } from 'node:crypto';
import { demoState } from './demoData.js';
import { classifySupabaseError, supabase } from '../db.js';
import { uploadDataUrl, uploadDataUrls, storageInfo } from '../storage.js';
import { createPaymentRecord } from '../payments.js';

const DELIVERY_RADIUS_KM = 15;
const baliToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar', year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
const internalMode = () => process.env.PAYMENT_MODE !== 'LEGACY_SIMULATION';


const makeId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const nextDemoAgreementNumber = () => {
  const highestSerial = demoState.agreements.reduce((highest, agreement) => {
    const match = String(agreement.agreementNumber || '').match(/-(\d+)$/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `MOU-GPS-${new Date().getFullYear()}-${String(highestSerial + 1).padStart(6, '0')}`;
};

export const haversineKm = (lat1, lon1, lat2, lon2) => {
  const earthRadius = 6371;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const badRequest = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
const dateOnly = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) badRequest('Tanggal harus YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) badRequest('Tanggal tidak valid.');
  return date;
};
const validateReturn = (payload) => {
  if (payload.actualReturnDate) dateOnly(payload.actualReturnDate);
  if (payload.returnMethod && !['SELF_RETURN', 'STAFF_PICKUP'].includes(payload.returnMethod)) badRequest('Metode return tidak valid.');
  if (payload.damageItems !== undefined && !Array.isArray(payload.damageItems)) badRequest('Daftar kerusakan tidak valid.');
  for (const item of payload.damageItems || []) {
    if (!item || typeof item.amount !== 'number' || !Number.isSafeInteger(item.amount) || item.amount < 0) badRequest('Denda harus rupiah bulat, tidak negatif.');
  }
  const total = (payload.damageItems || []).reduce((sum, item) => sum + item.amount, 0);
  if (!Number.isSafeInteger(total) || total > 999999999999) badRequest('Total denda melebihi batas.');
};
const operationalCustomer = (user) => user ? ({ id: user.id, name: user.name, email: user.email, phone: user.phone }) : null;
const hasActiveRental = (vehicleId) => demoState.rentals.some((rental) => rental.vehicleId === vehicleId && activeRentalStatuses.has(rental.status));
const validateInspection = (payload) => {
  for (const key of ['staffPhotos', 'customerPhotos', 'staffChecklist']) {
    if (payload[key] !== undefined && (!Array.isArray(payload[key]) || payload[key].length > 50)) badRequest('Daftar inspeksi tidak valid.');
  }
  for (const item of payload.staffChecklist || []) if (typeof item !== 'string' || !item.trim() || item.length > 200) badRequest('Checklist tidak valid.');
  for (const value of [payload.customerSignature, ...(payload.staffPhotos || []), ...(payload.customerPhotos || [])].filter((value) => value != null)) {
    if (typeof value !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) badRequest('Foto/tanda tangan harus file PNG, JPEG atau WebP.');
  }
};

export const rentalDays = (startDate, endDate) => {
  const diff = dateOnly(endDate).getTime() - dateOnly(startDate).getTime();
  return Math.max(1, Math.ceil(diff / 86_400_000));
};

const rangesOverlap = (startA, endA, startB, endB) => (
  dateOnly(startA) < dateOnly(endB) && dateOnly(startB) < dateOnly(endA)
);

const activeReservationStatuses = new Set(['PENDING_PAYMENT', 'CONFIRMED']);
const activeRentalStatuses = new Set(['SCHEDULED', 'ACTIVE', 'RETURN_PENDING_REVIEW']);

const expireReservations = () => {
  const now = Date.now();
  demoState.reservations.forEach((reservation) => {
    if (reservation.status === 'PENDING_PAYMENT' && new Date(reservation.expiresAt).getTime() <= now) {
      reservation.status = 'EXPIRED';
    }
  });
};

/**
 * Menutup reservasi yang melewati batas pembayaran 30 menit.
 * Pada mode demo perubahan dilakukan di memory; pada Supabase perubahan
 * dipersist agar kendaraan tidak terus-terusan dianggap terblokir.
 */
export const expirePendingReservations = async () => {
  if (!supabase) {
    expireReservations();
    return { expired: 0, mode: 'demo-in-memory' };
  }

  const now = new Date().toISOString();
  const result = await supabase
    .from('reservations')
    .update({ status: 'EXPIRED', cancelled_at: now })
    .eq('status', 'PENDING_PAYMENT')
    .not('expires_at', 'is', null)
    .lte('expires_at', now)
    .select('id');

  throwSupabaseError('Gagal menutup reservasi yang kedaluwarsa', result.error);
  return { expired: result.data?.length || 0, mode: 'supabase' };
};

export const getUser = (id) => demoState.users.find((user) => user.id === id);

export const getPublicUser = (user) => {
  if (!user) return null;
  const { password, ...safeUser } = user;
  return safeUser;
};

export const findUserByEmail = (email) => demoState.users.find((user) => user.email.toLowerCase() === email.toLowerCase());

export const createCustomer = ({ name, email, password, phone, address, ktpNumber, simNumber, ktpDocument, simDocument }) => {
  if (findUserByEmail(email)) {
    const error = new Error('Email sudah terdaftar.');
    error.status = 409;
    throw error;
  }
  const user = {
    id: makeId('usr'),
    email,
    password,
    name,
    phone,
    address,
    ktpNumber,
    simNumber,
    ktpDocument,
    simDocument,
    role: 'CUSTOMER',
    companyId: null,
    branchId: null,
    verificationStatus: 'PENDING'
  };
  demoState.users.push(user);
  return user;
};

const getBranch = (id) => demoState.branches.find((branch) => branch.id === id);
const getCompany = (id) => demoState.companies.find((company) => company.id === id);
const getVehicle = (id) => demoState.vehicles.find((vehicle) => vehicle.id === id);

const throwSupabaseError = (label, error) => {
  if (!error) return;
  const classified = classifySupabaseError(error);
  const wrapped = new Error(`${label}: ${classified.message}`);
  wrapped.status = classified.code === 'SUPABASE_JWT_CLOCK_SKEW'
    || classified.code === 'SUPABASE_INVALID_KEY'
    ? 503
    : 502;
  wrapped.code = classified.code;
  throw wrapped;
};

const parseGeoPoint = (value) => {
  if (!value) return { latitude: null, longitude: null };
  if (typeof value === 'object') {
    const coordinates = Array.isArray(value.coordinates)
      ? value.coordinates
      : Array.isArray(value.geometry?.coordinates) ? value.geometry.coordinates : null;
    if (coordinates?.length >= 2) {
      return { longitude: Number(coordinates[0]), latitude: Number(coordinates[1]) };
    }
  }
  if (typeof value !== 'string') return { latitude: null, longitude: null };

  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return parseGeoPoint(parsed);
  } catch {
    // PostgREST commonly returns PostGIS geography as WKT, e.g. POINT(115.16 -8.71).
  }
  const match = trimmed.match(/^(?:SRID=\d+;)?POINT(?:\s+Z)?\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i);
  if (match) {
    return { longitude: Number(match[1]), latitude: Number(match[2]) };
  }

  // Some PostgREST/PostGIS responses are returned as EWKB hex.
  const hex = trimmed.replace(/^\\x/i, '');
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 42) {
    return { latitude: null, longitude: null };
  }

  try {
    const bytes = Buffer.from(hex, 'hex');
    const littleEndian = bytes[0] === 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const geometryType = view.getUint32(1, littleEndian);
    let offset = 5;

    // EWKB SRID flag.
    if ((geometryType & 0x20000000) !== 0) offset += 4;
    // EWKB Z/M flags, if present.
    if ((geometryType & 0x80000000) !== 0) offset += 8;
    if ((geometryType & 0x40000000) !== 0) offset += 8;

    return {
      longitude: view.getFloat64(offset, littleEndian),
      latitude: view.getFloat64(offset + 8, littleEndian)
    };
  } catch {
    return { latitude: null, longitude: null };
  }
};

const mapDbCompany = (company) => ({
  id: company.id,
  name: company.name,
  legalName: company.legal_name,
  phone: company.phone,
  email: company.email,
  status: company.status,
  description: company.description,
  deliveryRadiusKm: Number(company.delivery_radius_km ?? DELIVERY_RADIUS_KM),
  gpsAgreementStatus: company.gps_agreement_status || null,
  gpsTrackingAllowed: company.gps_tracking_allowed === true,
  gpsAgreementExpiresAt: company.gps_agreement_expires_at || null
});

export const mapDbBranch = (branch) => ({
  id: branch.id,
  companyId: branch.company_id,
  name: branch.name,
  address: branch.address,
  phone: branch.phone,
  ...parseGeoPoint(branch.location)
});

const mapDbVehicle = (vehicle, branch, company, distanceKm = null) => ({
  id: vehicle.id,
  companyId: vehicle.company_id,
  branchId: vehicle.branch_id,
  gpsDeviceId: vehicle.gps_device_id,
  name: vehicle.name,
  type: vehicle.type,
  transmission: vehicle.transmission,
  seats: vehicle.seats,
  year: vehicle.year,
  plateNumber: vehicle.plate_number,
  pricePerDay: Number(vehicle.price_per_day || 0),
  deposit: Number(vehicle.deposit_amount || 0),
  status: vehicle.status,
  gpsStatus: vehicle.gps_status,
  repairRequired: vehicle.repair_required === true,
  image: vehicle.image_url,
  branch,
  company,
  distanceKm: distanceKm === null ? null : Number(distanceKm.toFixed(2)),
  deliveryAllowed: distanceKm !== null && distanceKm <= (company?.deliveryRadiusKm || DELIVERY_RADIUS_KM),
  deliveryRadiusKm: company?.deliveryRadiusKm || DELIVERY_RADIUS_KM
});

const getCompaniesFromSupabase = async ({ includeAll = false } = {}) => {
  let companiesQuery = supabase.from('rental_companies')
    .select('id,name,legal_name,email,phone,description,status,delivery_radius_km')
    .order('name');
  if (!includeAll) companiesQuery = companiesQuery.eq('status', 'ACTIVE');

  let agreementsQuery = supabase.from('rental_company_agreements')
    .select('company_id,status,gps_tracking_allowed,expires_at,signed_at,created_at')
    .order('created_at', { ascending: false });
  if (!includeAll) agreementsQuery = agreementsQuery.eq('status', 'ACTIVE').eq('gps_tracking_allowed', true);

  const [companiesResult, branchesResult, agreementsResult] = await Promise.all([
    companiesQuery,
    supabase.from('branches')
      .select('id,company_id,name,address,phone,location')
      .order('name'),
    agreementsQuery
  ]);
  throwSupabaseError('Gagal membaca perusahaan rental', companiesResult.error);
  throwSupabaseError('Gagal membaca cabang rental', branchesResult.error);
  throwSupabaseError('Gagal membaca agreement GPS perusahaan rental', agreementsResult.error);

  const branches = (branchesResult.data || []).map(mapDbBranch);
  const now = Date.now();
  const agreements = new Map();
  (agreementsResult.data || [])
    .filter((agreement) => includeAll || !agreement.expires_at || new Date(agreement.expires_at).getTime() > now)
    .forEach((agreement) => {
      if (!agreements.has(agreement.company_id)) agreements.set(agreement.company_id, agreement);
    });
  return (companiesResult.data || []).map((company) => ({
    ...mapDbCompany({
      ...company,
      gps_agreement_status: agreements.get(company.id)?.status || null,
      gps_tracking_allowed: agreements.get(company.id)?.status === 'ACTIVE'
        && agreements.get(company.id)?.gps_tracking_allowed === true
        && (!agreements.get(company.id)?.expires_at || new Date(agreements.get(company.id).expires_at).getTime() > now),
      gps_agreement_expires_at: agreements.get(company.id)?.expires_at || null
    }),
    branches: branches.filter((branch) => branch.companyId === company.id)
  }));
};

export const getCompanies = async () => {
  if (supabase) return getCompaniesFromSupabase();
  return demoState.companies
    .filter((company) => company.status === 'ACTIVE')
    .map(mapDemoCompanyForAdmin);
};

const mapDemoCompanyForAdmin = (company) => {
  const agreement = demoState.agreements
    .filter((item) => item.companyId === company.id)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0];
  const gpsActive = agreement?.status === 'ACTIVE'
    && agreement.gpsTrackingAllowed === true
    && (!agreement.expiresAt || new Date(agreement.expiresAt).getTime() > Date.now());
  return {
    ...company,
    gpsAgreementStatus: agreement?.status || null,
    gpsTrackingAllowed: gpsActive,
    gpsAgreementExpiresAt: agreement?.expiresAt || null,
    branches: demoState.branches.filter((branch) => branch.companyId === company.id)
  };
};

export const listRentalCompanies = async (actor) => {
  requireCentralAdmin(actor, 'Hanya Admin Pusat yang dapat mengelola perusahaan rental.');
  if (supabase) return getCompaniesFromSupabase({ includeAll: true });
  return demoState.companies.map(mapDemoCompanyForAdmin);
};

export const createRentalCompany = async (actor, payload = {}) => {
  requireCentralAdmin(actor, 'Hanya Admin Pusat yang dapat menambahkan perusahaan rental.');
  const name = String(payload.name || '').trim();
  if (!name) {
    const error = new Error('Nama perusahaan wajib diisi.');
    error.status = 400;
    throw error;
  }
  const deliveryRadiusKm = Number(payload.deliveryRadiusKm || DELIVERY_RADIUS_KM);
  if (!Number.isFinite(deliveryRadiusKm) || deliveryRadiusKm <= 0 || deliveryRadiusKm > DELIVERY_RADIUS_KM) {
    const error = new Error(`Radius delivery harus antara 0 dan ${DELIVERY_RADIUS_KM} km.`);
    error.status = 400;
    throw error;
  }

  if (payload.creationKey && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(payload.creationKey)) badRequest('Kunci setup tidak valid.');
  const companyPayload = {
    name,
    ...(payload.creationKey ? {creation_key:payload.creationKey} : {}),
    legal_name: String(payload.legalName || '').trim() || null,
    email: String(payload.email || '').trim() || null,
    phone: String(payload.phone || '').trim() || null,
    description: String(payload.description || '').trim() || null,
    status: 'PENDING',
    delivery_radius_km: deliveryRadiusKm
  };

  if (supabase) {
    if(payload.creationKey){const existing=await supabase.from('rental_companies').select('*').eq('creation_key',payload.creationKey).maybeSingle();throwSupabaseError('Gagal membaca checkpoint perusahaan',existing.error);if(existing.data)return {...mapDbCompany(existing.data),branches:[]};}
    const result = await supabase
      .from('rental_companies')
      .upsert(companyPayload,{onConflict:'creation_key',ignoreDuplicates:true})
      .select('id,name,legal_name,email,phone,description,status,delivery_radius_km')
      .single();
    if(result.error?.code==='PGRST116' && payload.creationKey){const existing=await supabase.from('rental_companies').select('*').eq('creation_key',payload.creationKey).single();throwSupabaseError('Gagal melanjutkan checkpoint perusahaan',existing.error);return {...mapDbCompany(existing.data),branches:[]};}
    throwSupabaseError('Gagal menambahkan perusahaan rental', result.error);
    return { ...mapDbCompany(result.data), branches: [] };
  }

  if(payload.creationKey){const existing=demoState.companies.find(c=>c.creationKey===payload.creationKey);if(existing)return mapDemoCompanyForAdmin(existing);}
  const duplicate = demoState.companies.find((company) => company.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    const error = new Error('Nama perusahaan sudah terdaftar.');
    error.status = 409;
    throw error;
  }
  const company = {
    creationKey:payload.creationKey,
    id: makeId('company'),
    name,
    legalName: companyPayload.legal_name,
    email: companyPayload.email,
    phone: companyPayload.phone,
    description: companyPayload.description,
    status: 'PENDING',
    deliveryRadiusKm,
    gpsAgreementStatus: null,
    gpsTrackingAllowed: false
  };
  demoState.companies.push(company);
  return mapDemoCompanyForAdmin(company);
};

export const updateRentalCompany = async (actor, companyId, payload = {}) => {
  requireCentralAdmin(actor, 'Hanya Admin Pusat yang dapat mengubah perusahaan rental.');
  const status = payload.status;
  if (!['PENDING', 'ACTIVE', 'SUSPENDED'].includes(status)) {
    const error = new Error('Status perusahaan rental tidak valid.');
    error.status = 400;
    throw error;
  }

  if (supabase) {
    const result = await supabase
      .from('rental_companies')
      .update({ status })
      .eq('id', companyId)
      .select('id,name,legal_name,email,phone,description,status,delivery_radius_km')
      .maybeSingle();
    throwSupabaseError('Gagal memperbarui status perusahaan rental', result.error);
    if (!result.data) {
      const error = new Error('Perusahaan rental tidak ditemukan.');
      error.status = 404;
      throw error;
    }
    const companies = await getCompaniesFromSupabase({ includeAll: true });
    return companies.find((company) => company.id === companyId) || { ...mapDbCompany(result.data), branches: [] };
  }

  const company = getCompany(companyId);
  if (!company) {
    const error = new Error('Perusahaan rental tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  company.status = status;
  return mapDemoCompanyForAdmin(company);
};

const getActiveGpsAgreement = async (companyId) => {
  if (!supabase) {
    const company = getCompany(companyId);
    const agreement = demoState.agreements
      .filter((item) => item.companyId === companyId && item.status === 'ACTIVE' && item.gpsTrackingAllowed === true)
      .sort((a, b) => new Date(b.signedAt || b.createdAt || 0) - new Date(a.signedAt || a.createdAt || 0))[0];
    if (!company || company.status !== 'ACTIVE' || !agreement || (agreement.expiresAt && new Date(agreement.expiresAt).getTime() <= Date.now())) return null;
    return { id: agreement.id, status: agreement.status, gpsTrackingAllowed: true, expiresAt: agreement.expiresAt || null };
  }

  const result = await supabase
    .from('rental_company_agreements')
    .select('id,company_id,status,gps_tracking_allowed,expires_at,signed_at')
    .eq('company_id', companyId)
    .eq('status', 'ACTIVE')
    .eq('gps_tracking_allowed', true)
    .order('signed_at', { ascending: false })
    .limit(5);
  throwSupabaseError('Gagal membaca agreement GPS perusahaan rental', result.error);

  const now = Date.now();
  const agreement = (result.data || []).find((item) => (
    !item.expires_at || new Date(item.expires_at).getTime() > now
  ));
  return agreement
    ? {
      id: agreement.id,
      status: agreement.status,
      gpsTrackingAllowed: agreement.gps_tracking_allowed,
      expiresAt: agreement.expires_at
    }
    : null;
};

const requireCentralAdmin = (actor, message) => {
  if (actor.role !== 'CENTRAL_ADMIN') {
    const error = new Error(message || 'Hanya Admin Pusat yang dapat mengelola agreement GPS.');
    error.status = 403;
    throw error;
  }
};

const mapAgreement = (row, company = null) => ({
  id: row.id,
  companyId: row.company_id,
  companyName: company?.name || row.company_name || null,
  agreementNumber: row.agreement_number,
  status: row.status==='ACTIVE' && row.expires_at && new Date(row.expires_at)<=new Date() ? 'EXPIRED' : row.status,
  storedStatus: row.status,
  workflowStage: row.workflow_stage || row.workflowStage || (['ACTIVE','EXPIRED','REVOKED'].includes(row.status) ? row.status : row.document_path ? 'WAITING_REVIEW' : 'WAITING_OWNER'),
  revisionReason: row.revision_reason || row.revisionReason, predecessorId:row.predecessor_id, supersededBy:row.superseded_by, documentVersions:(row.document_versions||row.documentVersions||[]).map((v,i)=>({version:i,uploadedAt:v.metadata?.uploadedAt,archivedAt:v.archivedAt})),
  gpsTrackingAllowed: row.gps_tracking_allowed && (!row.expires_at || new Date(row.expires_at)>new Date()),
  signedAt: row.signed_at,
  expiresAt: row.expires_at,
  documentPath: row.document_path,
  documentMetadata: row.document_metadata || {},
  onlineSimulation: row.online_simulation ? { receiptId: row.online_simulation.receiptId, acceptedAt: row.online_simulation.acceptedAt, termsVersion: row.online_simulation.termsVersion, mode: row.online_simulation.mode } : null,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export const listGpsAgreements = async (actor) => {
  if (!['CENTRAL_ADMIN', 'RENTAL_ADMIN'].includes(actor.role)) throw Object.assign(new Error('Akses MoU tidak diizinkan.'), { status: 403 });
  if (!supabase) {
    return demoState.agreements.filter((a) => actor.role === 'CENTRAL_ADMIN' || a.companyId === actor.companyId).map((agreement) => mapAgreement(
      {
        ...agreement,
        company_id: agreement.companyId,
        agreement_number: agreement.agreementNumber,
        gps_tracking_allowed: agreement.gpsTrackingAllowed,
        signed_at: agreement.signedAt,
        expires_at: agreement.expiresAt,
        document_path: agreement.documentPath || null,
        document_metadata: agreement.documentMetadata || {},
        online_simulation: agreement.onlineSimulation || null,
        created_at: agreement.createdAt || null,
        updated_at: agreement.updatedAt || null
      },
      getCompany(agreement.companyId)
    ));
  }

  let agreementsQuery = supabase.from('rental_company_agreements').select('*').order('created_at', { ascending: false });
  let companiesQuery = supabase.from('rental_companies').select('id,name');
  if (actor.role === 'RENTAL_ADMIN') {
    if (!actor.companyId) return [];
    agreementsQuery = agreementsQuery.eq('company_id', actor.companyId);
    companiesQuery = companiesQuery.eq('id', actor.companyId);
  }
  const [agreementsResult, companiesResult] = await Promise.all([agreementsQuery, companiesQuery]);
  throwSupabaseError('Gagal membaca agreement GPS', agreementsResult.error);
  throwSupabaseError('Gagal membaca nama perusahaan agreement', companiesResult.error);
  const companies = new Map((companiesResult.data || []).map((company) => [company.id, company]));
  return (agreementsResult.data || []).map((agreement) => mapAgreement(agreement, companies.get(agreement.company_id)));
};

export const updateGpsAgreement = async (actor, agreementId, payload = {}) => {
  requireCentralAdmin(actor);
  const status = payload.status;
  if (!['DRAFT', 'PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED'].includes(status) && payload.decision !== 'REVISION_REQUIRED') {
    const error = new Error('Status agreement GPS tidak valid.');
    error.status = 400;
    throw error;
  }
  const gpsTrackingAllowed = status === 'ACTIVE' && payload.gpsTrackingAllowed !== false;

  if (!supabase) {
    const agreement = demoState.agreements.find((item) => item.id === agreementId);
    if (!agreement) {
      const error = new Error('Agreement GPS tidak ditemukan.');
      error.status = 404;
      throw error;
    }
    if (['ACTIVE','EXPIRED','REVOKED'].includes(agreement.status) && !(agreement.status==='ACTIVE'&&['EXPIRED','REVOKED'].includes(status))) throw Object.assign(new Error('MoU final tidak dapat dibuka kembali; buat perpanjangan baru.'),{status:409});
    if (payload.decision==='REVISION_REQUIRED') { if ((agreement.workflowStage|| (agreement.documentPath?'WAITING_REVIEW':'WAITING_OWNER')) !== 'WAITING_REVIEW') badRequest('Belum ada dokumen untuk direvisi.'); agreement.revisionReason=requiredReason(payload.reason); agreement.workflowStage='REVISION_REQUIRED'; return {...agreement}; }
    if (['EXPIRED','REVOKED'].includes(status)) requiredReason(payload.reason);
    if (status === 'ACTIVE') {
      if (!agreement.documentPath || !agreement.documentMetadata?.sha256 || payload.reviewed !== true || payload.reviewedSha256 !== agreement.documentMetadata.sha256 || !agreement.expiresAt || new Date(agreement.expiresAt) <= new Date()) throw Object.assign(new Error('Periksa PDF final dan masa berlaku sebelum aktivasi.'), { status: 409 });
      agreement.documentMetadata = { ...agreement.documentMetadata, reviewed: true, reviewedBy: actor.id, reviewedAt: new Date().toISOString() };
      const company = getCompany(agreement.companyId);
      if (company?.status !== 'ACTIVE') {
        const error = new Error('Perusahaan harus berstatus Aktif sebelum MoU GPS diaktifkan.');
        error.status = 409;
        throw error;
      }
      if (agreement.predecessorId) { const old=demoState.agreements.find(a=>a.id===agreement.predecessorId); if(old?.status==='ACTIVE') Object.assign(old,{status:'REVOKED',workflowStage:'REVOKED',gpsTrackingAllowed:false}); }
      if (demoState.agreements.some((item) => item.id !== agreementId && item.companyId === agreement.companyId && item.status === 'ACTIVE')) {
        const error = new Error('Perusahaan sudah memiliki MoU aktif. Nonaktifkan MoU lama terlebih dahulu.');
        error.status = 409;
        throw error;
      }
    }
    agreement.status = status;
    agreement.workflowStage = status;
    agreement.gpsTrackingAllowed = gpsTrackingAllowed;
    agreement.updatedAt = new Date().toISOString();
    return mapAgreement({
      ...agreement,
      company_id: agreement.companyId,
      agreement_number: agreement.agreementNumber,
      gps_tracking_allowed: agreement.gpsTrackingAllowed,
      signed_at: agreement.signedAt,
      expires_at: agreement.expiresAt,
      updated_at: agreement.updatedAt
    }, getCompany(agreement.companyId));
  }

  const { data, error } = await supabase.rpc('transrent_mou', { p_actor: actor.id, p_id: agreementId, p_action: 'REVIEW', p_payload: payload });
  if (error?.code === 'PGRST202') throw Object.assign(new Error('Migration 011 belum tersedia.'), { status: 503, code: 'MIGRATION_REQUIRED' });
  if (error && /^PT\d{3}$/.test(error.code)) throw Object.assign(new Error(error.message), { status: Number(error.code.slice(2)) });
  throwSupabaseError('Gagal mereview MoU', error);
  return mapAgreement(data);
};

const validateAgreementDates = (signedAt, expiresAt) => {
  for (const value of [signedAt, expiresAt]) {
    if (value && !Number.isFinite(new Date(value).getTime())) badRequest('Tanggal MoU tidak valid.');
  }
  if (signedAt && expiresAt && new Date(expiresAt).getTime() <= new Date(signedAt).getTime()) {
    const error = new Error('Tanggal berakhir MoU harus setelah tanggal tanda tangan.');
    error.status = 400;
    throw error;
  }
};

export const createGpsAgreement = async (actor, payload = {}) => {
  requireCentralAdmin(actor, 'Hanya Admin Pusat yang dapat mengirim permintaan MoU.');
  const companyId = String(payload.companyId || '').trim();
  if (!companyId) badRequest('Perusahaan tujuan wajib dipilih.');
  if (payload.status && payload.status !== 'PENDING') badRequest('Permintaan MoU baru harus berstatus PENDING.');
  if (payload.documentDataUrl || payload.documentPath || payload.signedAt || payload.expiresAt || payload.gpsTrackingAllowed) {
    badRequest('Dokumen final, tanggal tanda tangan dan masa berlaku diisi oleh pemilik rental melalui tanggapan MoU.');
  }
  if (payload.notes != null && (typeof payload.notes !== 'string' || payload.notes.length > 2000)) badRequest('Catatan permintaan maksimal 2000 karakter.');
  const notes = payload.notes?.trim() || null;
  if (!supabase) {
    const company = getCompany(companyId);
    if (!company) throw Object.assign(new Error('Perusahaan rental tidak ditemukan.'), { status: 404 });
    const existing=demoState.agreements.find(a=>a.companyId===companyId&&['DRAFT','PENDING'].includes(a.status)&&a.workflowStage!=='ARCHIVED'); if(existing) return {...existing,companyName:company.name};
    const now = new Date().toISOString();
    const agreement = { workflowStage:'WAITING_OWNER',predecessorId:demoState.agreements.find(a=>a.companyId===companyId&&a.status==='ACTIVE')?.id, id: makeId('agr'), companyId, agreementNumber: nextDemoAgreementNumber(), status: 'PENDING', gpsTrackingAllowed: false, signedAt: null, expiresAt: null, documentPath: null, notes, createdAt: now, updatedAt: now };
    demoState.agreements.push(agreement);
    return { ...agreement, companyName: company.name };
  }
  const companyResult = await supabase.from('rental_companies').select('id,name,status').eq('id', companyId).maybeSingle();
  throwSupabaseError('Gagal membaca perusahaan tujuan', companyResult.error);
  if (!companyResult.data) throw Object.assign(new Error('Perusahaan rental tidak ditemukan.'), { status: 404 });
  const { rpc }=await import('../operations.js');
  return mapAgreement(await rpc('transrent_mou',{p_actor:actor.id,p_id:companyId,p_action:'REQUEST',p_payload:{notes}}),companyResult.data);
};

export const inviteRentalAdmin = async (actor,companyId,payload={}) => { const {requestInvite}=await import('../invites.js');return requestInvite(actor,companyId,payload); };

const decorateVehicle = (vehicle, distanceKm = null) => {
  const branch = getBranch(vehicle.branchId);
  const company = getCompany(vehicle.companyId);
  return {
    ...vehicle,
    branch: branch ? { ...branch } : null,
    company: company ? { ...company } : null,
    distanceKm: distanceKm === null ? null : Number(distanceKm.toFixed(2)),
    deliveryAllowed: distanceKm === null ? false : distanceKm <= DELIVERY_RADIUS_KM,
    deliveryRadiusKm: DELIVERY_RADIUS_KM
  };
};

export const isVehicleAvailable = (vehicleId, startDate, endDate, exceptReservationId = null) => {
  expireReservations();
  const vehicle = getVehicle(vehicleId);
  if (!vehicle || vehicle.repairRequired || vehicle.status !== 'AVAILABLE' || vehicle.gpsStatus !== 'READY') return false;
  const reservationConflict = demoState.reservations.some((reservation) => (
    reservation.vehicleId === vehicleId
    && reservation.id !== exceptReservationId
    && activeReservationStatuses.has(reservation.status)
    && rangesOverlap(startDate, endDate, reservation.startDate, reservation.endDate)
  ));
  if (reservationConflict) return false;
  return !demoState.rentals.some((rental) => (
    rental.vehicleId === vehicleId
    && activeRentalStatuses.has(rental.status)
    && rangesOverlap(startDate, endDate, rental.startDate, rental.endDate)
  ));
};

const searchVehiclesDemo = ({ latitude, longitude, startDate, endDate, type }) => {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const error = new Error('Lokasi customer diperlukan untuk pencarian.');
    error.status = 400;
    throw error;
  }
  const results = demoState.vehicles
    .filter((vehicle) => !type || type === 'ALL' || vehicle.type === type)
    .filter((vehicle) => isVehicleAvailable(vehicle.id, startDate, endDate))
    .map((vehicle) => {
      const branch = getBranch(vehicle.branchId);
      const distance = haversineKm(lat, lng, branch.latitude, branch.longitude);
      return decorateVehicle(vehicle, distance);
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);
  return results;
};

const searchVehiclesFromSupabase = async ({ latitude, longitude, startDate, endDate, type }) => {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const error = new Error('Lokasi customer diperlukan untuk pencarian.');
    error.status = 400;
    throw error;
  }
  if (!startDate || !endDate || dateOnly(endDate) <= dateOnly(startDate)) {
    const error = new Error('Periode rental tidak valid.');
    error.status = 400;
    throw error;
  }

  let vehicleQuery = supabase.from('vehicles')
    .select(vehicleSelect)
    .eq('status', 'AVAILABLE')
    .eq('gps_status', 'READY')
    .eq('repair_required', false);
  if (type && type !== 'ALL') vehicleQuery = vehicleQuery.eq('type', type);

  const [companiesResult, branchesResult, vehiclesResult, devicesResult, reservationsResult, rentalsResult, maintenanceResult, agreementsResult] = await Promise.all([
    supabase.from('rental_companies')
      .select('id,name,legal_name,email,phone,description,status,delivery_radius_km')
      .eq('status', 'ACTIVE'),
    supabase.from('branches').select('id,company_id,name,address,phone,location'),
    vehicleQuery,
    supabase.from('gps_devices').select('id,status'),
    supabase.from('reservations').select('vehicle_id,start_date,end_date,status,expires_at')
      .in('status', ['PENDING_PAYMENT', 'CONFIRMED', 'RENTED']),
    supabase.from('rentals').select('vehicle_id,start_date,end_date,status')
      .in('status', ['SCHEDULED', 'ACTIVE', 'RETURN_PENDING_REVIEW']),
    supabase.from('maintenances').select('vehicle_id,status')
      .in('status', ['SCHEDULED', 'IN_PROGRESS']),
    supabase.from('rental_company_agreements')
      .select('company_id,status,gps_tracking_allowed,expires_at')
      .eq('status', 'ACTIVE')
      .eq('gps_tracking_allowed', true)
  ]);

  throwSupabaseError('Gagal membaca perusahaan rental', companiesResult.error);
  throwSupabaseError('Gagal membaca cabang rental', branchesResult.error);
  throwSupabaseError('Gagal membaca kendaraan', vehiclesResult.error);
  throwSupabaseError('Gagal membaca GPS device', devicesResult.error);
  throwSupabaseError('Gagal membaca reservasi', reservationsResult.error);
  throwSupabaseError('Gagal membaca rental aktif', rentalsResult.error);
  throwSupabaseError('Gagal membaca maintenance', maintenanceResult.error);
  throwSupabaseError('Gagal membaca agreement GPS perusahaan rental', agreementsResult.error);

  const now = Date.now();
  const agreements = new Map((agreementsResult.data || [])
    .filter((agreement) => !agreement.expires_at || new Date(agreement.expires_at).getTime() > now)
    .map((agreement) => [agreement.company_id, agreement]));
  const companies = new Map((companiesResult.data || []).map((company) => {
    const agreement = agreements.get(company.id);
    return [company.id, mapDbCompany({
      ...company,
      gps_agreement_status: agreement?.status || null,
      gps_tracking_allowed: Boolean(agreement),
      gps_agreement_expires_at: agreement?.expires_at || null
    })];
  }));
  const branches = new Map((branchesResult.data || []).map((branch) => [branch.id, mapDbBranch(branch)]));
  const readyDeviceIds = new Set((devicesResult.data || [])
    .filter((device) => device.status === 'READY')
    .map((device) => device.id));
  const agreementCompanyIds = new Set(agreements.keys());
  const blockedVehicleIds = new Set();
  const overlaps = (row) => rangesOverlap(startDate, endDate, row.start_date, row.end_date);

  (reservationsResult.data || [])
    .filter((row) => {
      if (row.status !== 'PENDING_PAYMENT') return true;
      return !row.expires_at || new Date(row.expires_at) > new Date();
    })
    .filter(overlaps)
    .forEach((row) => blockedVehicleIds.add(row.vehicle_id));
  (rentalsResult.data || []).filter(overlaps).forEach((row) => blockedVehicleIds.add(row.vehicle_id));
  (maintenanceResult.data || []).forEach((row) => blockedVehicleIds.add(row.vehicle_id));

  return (vehiclesResult.data || [])
    .filter((vehicle) => readyDeviceIds.has(vehicle.gps_device_id))
    .filter((vehicle) => agreementCompanyIds.has(vehicle.company_id))
    .filter((vehicle) => !blockedVehicleIds.has(vehicle.id))
    .map((vehicle) => {
      const branch = branches.get(vehicle.branch_id);
      const company = companies.get(vehicle.company_id);
      if (!branch || !company || !Number.isFinite(branch.latitude) || !Number.isFinite(branch.longitude)) return null;
      const distance = haversineKm(lat, lng, branch.latitude, branch.longitude);
      return mapDbVehicle(vehicle, branch, company, distance);
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm);
};

export const searchVehicles = async (params) => (
  supabase ? searchVehiclesFromSupabase(params) : searchVehiclesDemo(params)
);

const reservationSelect = `
  id,
  customer_id,
  company_id,
  branch_id,
  vehicle_id,
  start_date,
  end_date,
  pickup_mode,
  delivery_address,
  delivery_location,
  recipient_phone,
  delivery_notes,
  delivery_distance_km,
  rental_days,
  rental_amount,
  deposit_amount,
  total_amount,
  status,
  expires_at,
  paid_at,
  cancelled_at,
  cancellation,
  created_at
`;

const vehicleSelect = 'id,company_id,branch_id,gps_device_id,name,type,transmission,seats,year,plate_number,price_per_day,deposit_amount,status,gps_status,image_url,repair_required';


const queryByIds = (table, select, ids) => (
  ids.length
    ? supabase.from(table).select(select).in('id', ids)
    : Promise.resolve({ data: [], error: null })
);

const queryByColumn = (table, select, column, values) => (
  values.length
    ? supabase.from(table).select(select).in(column, values)
    : Promise.resolve({ data: [], error: null })
);

const loadReservationContext = async (rows) => {
  const vehicleIds = [...new Set(rows.map((row) => row.vehicle_id).filter(Boolean))];
  const branchIds = [...new Set(rows.map((row) => row.branch_id).filter(Boolean))];
  const companyIds = [...new Set(rows.map((row) => row.company_id).filter(Boolean))];
  const customerIds = [...new Set(rows.map((row) => row.customer_id).filter(Boolean))];

  const [vehiclesResult, branchesResult, companiesResult, customersResult] = await Promise.all([
    queryByIds('vehicles', vehicleSelect, vehicleIds),
    queryByIds('branches', 'id,company_id,name,address,phone,location', branchIds),
    queryByIds('rental_companies', 'id,name,legal_name,email,phone,description,status,delivery_radius_km', companyIds),
    queryByIds('profiles', 'id,name,email,phone', customerIds)
  ]);

  throwSupabaseError('Gagal membaca kendaraan reservasi', vehiclesResult.error);
  throwSupabaseError('Gagal membaca cabang reservasi', branchesResult.error);
  throwSupabaseError('Gagal membaca perusahaan reservasi', companiesResult.error);
  throwSupabaseError('Gagal membaca customer reservasi', customersResult.error);

  return {
    vehicles: new Map((vehiclesResult.data || []).map((row) => [row.id, row])),
    branches: new Map((branchesResult.data || []).map((row) => [row.id, mapDbBranch(row)])),
    companies: new Map((companiesResult.data || []).map((row) => [row.id, mapDbCompany(row)])),
    customers: new Map((customersResult.data || []).map((row) => [row.id, row]))
  };
};

const mapDbReservation = (row, context) => {
  const vehicle = context.vehicles.get(row.vehicle_id) || null;
  const branch = context.branches.get(row.branch_id) || null;
  const company = context.companies.get(row.company_id) || null;
  const customer = context.customers.get(row.customer_id) || null;
  const deliveryPoint = parseGeoPoint(row.delivery_location);

  return {
    id: row.id,
    customerId: row.customer_id,
    companyId: row.company_id,
    branchId: row.branch_id,
    vehicleId: row.vehicle_id,
    startDate: row.start_date,
    endDate: row.end_date,
    pickupMode: row.pickup_mode,
    deliveryAddress: row.delivery_address,
    deliveryLatitude: deliveryPoint.latitude,
    deliveryLongitude: deliveryPoint.longitude,
    recipientPhone: row.recipient_phone,
    deliveryNotes: row.delivery_notes,
    deliveryDistanceKm: row.delivery_distance_km === null ? null : Number(row.delivery_distance_km),
    rentalDays: Number(row.rental_days || 0),
    rentalAmount: Number(row.rental_amount || 0),
    depositAmount: Number(row.deposit_amount || 0),
    totalAmount: Number(row.total_amount || 0),
    status: row.status,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    cancelledAt: row.cancelled_at,
    cancellation: row.cancellation || null,
    createdAt: row.created_at,
    branch,
    company,
    vehicle: vehicle ? mapDbVehicle(vehicle, branch, company) : null,
    customer: operationalCustomer(customer)
  };
};

const listReservationsDemo = (actor) => {
  expireReservations();
  return demoState.reservations
    .filter((reservation) => {
      if (actor.role === 'CUSTOMER') return reservation.customerId === actor.id;
      if (actor.role === 'CENTRAL_ADMIN') return true;
      return reservation.companyId === actor.companyId;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((reservation) => ({
      ...reservation,
      vehicle: decorateVehicle(getVehicle(reservation.vehicleId)),
      customer: operationalCustomer(getUser(reservation.customerId))
    }));
};

const listReservationsFromSupabase = async (actor) => {
  let query = supabase
    .from('reservations')
    .select(reservationSelect)
    .order('created_at', { ascending: false });

  if (actor.role === 'CUSTOMER') {
    query = query.eq('customer_id', actor.id);
  } else if (actor.role !== 'CENTRAL_ADMIN') {
    if (!actor.companyId) return [];
    query = query.eq('company_id', actor.companyId);
  }

  const { data, error } = await query;
  throwSupabaseError('Gagal membaca reservasi', error);

  const rows = data || [];
  const context = await loadReservationContext(rows);
  return rows.map((row) => mapDbReservation(row, context));
};

export const listReservations = (actor) => (
  supabase ? listReservationsFromSupabase(actor) : listReservationsDemo(actor)
);

const rentalSelect = `
  id,
  reservation_id,
  customer_id,
  company_id,
  branch_id,
  vehicle_id,
  start_date,
  end_date,
  status,
  handover_at,
  returned_at,
  completed_at,
  return_method,
  return_schedule,
  actual_return_date,
  fine_payment,
  created_at
`;

const mapDbLocation = (row) => {
  const point = parseGeoPoint(row.location);
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    rentalId: row.rental_id,
    latitude: point.latitude,
    longitude: point.longitude,
    speed: Number(row.speed || 0),
    heading: Number(row.heading || 0),
    recordedAt: row.recorded_at
  };
};

const mapDbDispute = (row) => ({
  id: row.id, fineId: row.fine_id, customerId: row.customer_id, reason: row.reason,
  status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at,
  resolvedBy: row.resolved_by, resolutionNotes: row.resolution_notes,
  originalAmount: row.original_amount == null ? null : Number(row.original_amount),
  finalAmount: row.final_amount == null ? null : Number(row.final_amount)
});

const financialSummary = (fines, deposit, payment, disputes) => {
  const fineTotal = fines.filter((f) => f.status !== 'CANCELLED').reduce((sum, f) => sum + f.amount, 0);
  return { fineTotal, depositApplied: Math.min(deposit, fineTotal),
    balanceDue: Math.max(0, fineTotal - deposit - (payment?.amount || 0)),
    refundAmount: Math.max(0, deposit - fineTotal),
    disputed: fines.some((f) => f.status === 'DISPUTED') || disputes.some((d) => d.status === 'OPEN') };
};

const mapDbFine = (row) => ({
  id: row.id,
  rentalId: row.rental_id,
  amount: Number(row.amount || 0),
  status: row.status,
  damageItems: row.damage_items || [],
  createdAt: row.created_at
});

const mapDbRefund = (row) => ({
  id: row.id,
  rentalId: row.rental_id,
  amount: Number(row.amount || 0),
  status: row.status === 'APPROVED' && row.provider !== 'INTERNAL_MANUAL' ? 'APPROVED_SIMULATED' : row.status,
  provider: row.provider, payoutReference: row.payout_reference, paidAt: row.paid_at,
  confirmedBy: row.confirmed_by,
  createdAt: row.created_at,
  confirmedAt: row.confirmed_at
});

const loadRentalContext = async (rows) => {
  const rentalIds = [...new Set(rows.map((row) => row.id).filter(Boolean))];
  const reservationIds = [...new Set(rows.map((row) => row.reservation_id).filter(Boolean))];
  const vehicleIds = [...new Set(rows.map((row) => row.vehicle_id).filter(Boolean))];
  const branchIds = [...new Set(rows.map((row) => row.branch_id).filter(Boolean))];
  const companyIds = [...new Set(rows.map((row) => row.company_id).filter(Boolean))];
  const customerIds = [...new Set(rows.map((row) => row.customer_id).filter(Boolean))];

  const [reservationsResult, vehiclesResult, branchesResult, companiesResult, customersResult, finesResult, refundsResult, locationsResult] = await Promise.all([
    queryByIds('reservations', reservationSelect, reservationIds),
    queryByIds('vehicles', vehicleSelect, vehicleIds),
    queryByIds('branches', 'id,company_id,name,address,phone,location', branchIds),
    queryByIds('rental_companies', 'id,name,legal_name,email,phone,description,status,delivery_radius_km', companyIds),
    queryByIds('profiles', 'id,name,email,phone', customerIds),
    queryByColumn('fines', 'id,rental_id,amount,status,damage_items,created_at', 'rental_id', rentalIds),
    queryByColumn('refunds', 'id,rental_id,amount,status,confirmed_by,created_at,confirmed_at,provider,payout_reference,paid_at', 'rental_id', rentalIds),
    queryByColumn('vehicle_locations', 'id,vehicle_id,rental_id,location,speed,heading,recorded_at', 'rental_id', rentalIds)
  ]);

  throwSupabaseError('Gagal membaca reservasi rental', reservationsResult.error);
  throwSupabaseError('Gagal membaca kendaraan rental', vehiclesResult.error);
  throwSupabaseError('Gagal membaca cabang rental', branchesResult.error);
  throwSupabaseError('Gagal membaca perusahaan rental', companiesResult.error);
  throwSupabaseError('Gagal membaca customer rental', customersResult.error);
  throwSupabaseError('Gagal membaca denda rental', finesResult.error);
  throwSupabaseError('Gagal membaca refund rental', refundsResult.error);
  throwSupabaseError('Gagal membaca lokasi rental', locationsResult.error);

  const disputesResult = await queryByColumn('fine_disputes', '*', 'fine_id', (finesResult.data || []).map((f) => f.id));
  throwSupabaseError('Gagal membaca sengketa rental', disputesResult.error);
  return {
    allFines: (finesResult.data || []).map(mapDbFine),
    disputes: (disputesResult.data || []).map(mapDbDispute),
    reservations: new Map((reservationsResult.data || []).map((row) => [row.id, row])),
    vehicles: new Map((vehiclesResult.data || []).map((row) => [row.id, row])),
    branches: new Map((branchesResult.data || []).map((row) => [row.id, mapDbBranch(row)])),
    companies: new Map((companiesResult.data || []).map((row) => [row.id, mapDbCompany(row)])),
    customers: new Map((customersResult.data || []).map((row) => [row.id, row])),
    fines: new Map((finesResult.data || []).map((row) => [row.rental_id, mapDbFine(row)])),
    refunds: new Map((refundsResult.data || []).map((row) => [row.rental_id, mapDbRefund(row)])),
    locations: (locationsResult.data || []).map(mapDbLocation)
  };
};

const mapDbRental = (row, context) => {
  const vehicle = context.vehicles.get(row.vehicle_id) || null;
  const branch = context.branches.get(row.branch_id) || null;
  const company = context.companies.get(row.company_id) || null;
  const customer = context.customers.get(row.customer_id) || null;
  const reservation = context.reservations.get(row.reservation_id) || null;
  const fines = context.allFines.filter((f) => f.rentalId === row.id);
  const disputes = context.disputes.filter((d) => fines.some((f) => f.id === d.fineId));
  const locations = context.locations
    .filter((location) => location.rentalId === row.id)
    .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));

  return {
    id: row.id,
    reservationId: row.reservation_id,
    customerId: row.customer_id,
    companyId: row.company_id,
    branchId: row.branch_id,
    vehicleId: row.vehicle_id,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    handoverAt: row.handover_at,
    returnedAt: row.returned_at,
    completedAt: row.completed_at,
    returnMethod: row.return_method,
    returnSchedule: row.return_schedule,
    actualReturnDate: row.actual_return_date,
    finePayment: row.fine_payment || null,
    createdAt: row.created_at,
    vehicle: vehicle ? mapDbVehicle(vehicle, branch, company) : null,
    branch,
    company,
    customer: operationalCustomer(customer),
    reservation: reservation ? mapDbReservation(reservation, {
      vehicles: context.vehicles,
      branches: context.branches,
      companies: context.companies,
      customers: context.customers
    }) : null,
    fine: context.fines.get(row.id) || null,
    fines,
    disputes,
    settlement: financialSummary(fines, Number(reservation?.deposit_amount || 0), row.fine_payment, disputes),
    refund: context.refunds.get(row.id) || null,
    latestLocation: locations[0] || null
  };
};

const listRentalsDemo = (actor) => demoState.rentals
  .filter((rental) => {
    if (actor.role === 'CUSTOMER') return rental.customerId === actor.id;
    if (actor.role === 'CENTRAL_ADMIN') return true;
    return rental.companyId === actor.companyId;
  })
  .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  .map((rental) => ({
    ...rental,
    vehicle: decorateVehicle(getVehicle(rental.vehicleId)),
    customer: operationalCustomer(getUser(rental.customerId)),
    reservation: demoState.reservations.find((item) => item.id === rental.reservationId),
    fine: demoState.fines.find((item) => item.rentalId === rental.id) || null,
    fines: demoState.fines.filter((f) => f.rentalId === rental.id),
    disputes: demoState.disputes.filter((d) => demoState.fines.some((f) => f.rentalId === rental.id && f.id === d.fineId)),
    settlement: demoSettlement(rental),
    refund: demoState.refunds.find((item) => item.rentalId === rental.id) || null,
    latestLocation: (actor.role==='CUSTOMER'&&!demoState.agreements.some(a=>a.companyId===rental.companyId&&a.status==='ACTIVE'&&a.gpsTrackingAllowed&&(!a.expiresAt||new Date(a.expiresAt)>new Date())) ? [] : [...demoState.locations]).filter((item) => item.rentalId === rental.id).sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))[0] || null
  }));

const listRentalsFromSupabase = async (actor) => {
  let query = supabase
    .from('rentals')
    .select(rentalSelect)
    .order('created_at', { ascending: false });

  if (actor.role === 'CUSTOMER') {
    query = query.eq('customer_id', actor.id);
  } else if (actor.role !== 'CENTRAL_ADMIN') {
    if (!actor.companyId) return [];
    query = query.eq('company_id', actor.companyId);
  }

  const { data, error } = await query;
  throwSupabaseError('Gagal membaca rental', error);

  const rows = data || [];
  const context = await loadRentalContext(rows);
  const mapped=rows.map((row) => mapDbRental(row, context));
  if(actor.role==='CUSTOMER'){const allowed=await Promise.all(mapped.map(r=>getActiveGpsAgreement(r.companyId)));mapped.forEach((r,i)=>{if(!allowed[i])r.latestLocation=null;});}
  return mapped;
};

export const listRentals = (actor) => (
  supabase ? listRentalsFromSupabase(actor) : listRentalsDemo(actor)
);

const assertDemoReadiness = (vehicle, customerId) => {
  if (getUser(customerId)?.verificationStatus !== 'VERIFIED') throw Object.assign(new Error('Customer belum terverifikasi.'), { status: 403 });
  const readyMou = demoState.agreements.some((a) => a.companyId === vehicle.companyId && a.status === 'ACTIVE' && a.gpsTrackingAllowed && (!a.expiresAt || new Date(a.expiresAt).getTime() > Date.now()));
  if (getCompany(vehicle.companyId)?.status !== 'ACTIVE' || !readyMou || vehicle.repairRequired || vehicle.gpsStatus !== 'READY' || demoState.maintenances.some((m) => m.vehicleId === vehicle.id && ['SCHEDULED','IN_PROGRESS'].includes(m.status))) throw Object.assign(new Error('Perusahaan, MoU, GPS atau kendaraan belum siap.'), { status: 409 });
};

const createReservationDemo = (actor, payload) => {
  if (actor.role !== 'CUSTOMER') {
    const error = new Error('Hanya customer yang dapat membuat reservasi.');
    error.status = 403;
    throw error;
  }
  const customer = getUser(actor.id);
  if (customer.verificationStatus !== 'VERIFIED') {
    const error = new Error('Akun customer belum terverifikasi. Reservasi disimpan sebagai draft setelah verifikasi.');
    error.status = 403;
    throw error;
  }
  const vehicle = getVehicle(payload.vehicleId);
  const branch = vehicle && getBranch(vehicle.branchId);
  if (!vehicle || !branch) {
    const error = new Error('Kendaraan atau cabang tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  if (!payload.startDate || !payload.endDate || dateOnly(payload.endDate) <= dateOnly(payload.startDate)) {
    const error = new Error('Periode rental tidak valid.');
    error.status = 400;
    throw error;
  }
  assertDemoReadiness(vehicle, actor.id);
  if (!isVehicleAvailable(vehicle.id, payload.startDate, payload.endDate)) {
    const error = new Error('Kendaraan sudah tidak tersedia pada periode tersebut.');
    error.status = 409;
    throw error;
  }
  const pickupMode = payload.pickupMode === 'DELIVERY' ? 'DELIVERY' : 'PICKUP';
  let deliveryDistanceKm = null;
  if (pickupMode === 'DELIVERY') {
    deliveryDistanceKm = haversineKm(Number(payload.deliveryLatitude), Number(payload.deliveryLongitude), branch.latitude, branch.longitude);
    if (!Number.isFinite(deliveryDistanceKm) || deliveryDistanceKm > DELIVERY_RADIUS_KM) {
      const error = new Error(`Lokasi delivery harus berada maksimal ${DELIVERY_RADIUS_KM} km dari cabang.`);
      error.status = 400;
      throw error;
    }
    if (!payload.deliveryAddress || !payload.recipientPhone) {
      const error = new Error('Alamat delivery dan nomor penerima wajib diisi.');
      error.status = 400;
      throw error;
    }
  }
  if (internalMode() && payload.startDate < baliToday()) badRequest('Tanggal mulai tidak boleh di masa lalu.');
  const days = rentalDays(payload.startDate, payload.endDate);
  const rentalAmount = vehicle.pricePerDay * days;
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const reservation = {
    id: makeId('res'),
    customerId: actor.id,
    companyId: vehicle.companyId,
    branchId: vehicle.branchId,
    vehicleId: vehicle.id,
    startDate: payload.startDate,
    endDate: payload.endDate,
    pickupMode,
    deliveryAddress: pickupMode === 'DELIVERY' ? payload.deliveryAddress : null,
    deliveryLatitude: pickupMode === 'DELIVERY' ? Number(payload.deliveryLatitude) : null,
    deliveryLongitude: pickupMode === 'DELIVERY' ? Number(payload.deliveryLongitude) : null,
    recipientPhone: pickupMode === 'DELIVERY' ? payload.recipientPhone : null,
    deliveryNotes: pickupMode === 'DELIVERY' ? payload.deliveryNotes || null : null,
    deliveryDistanceKm: deliveryDistanceKm ? Number(deliveryDistanceKm.toFixed(2)) : null,
    rentalDays: days,
    rentalAmount,
    depositAmount: vehicle.deposit,
    totalAmount: rentalAmount + vehicle.deposit,
    status: 'PENDING_PAYMENT',
    expiresAt,
    createdAt: new Date().toISOString()
  };
  demoState.reservations.push(reservation);
  return reservation;
};

const createReservationFromSupabase = async (actor, payload) => {
  dateOnly(payload.startDate); dateOnly(payload.endDate);
  const result = await rentalTransaction(actor, 'RESERVE', payload);
  const context = await loadReservationContext([result.reservation]);
  return mapDbReservation(result.reservation, context);
};

export const createReservation = (actor, payload) => (
  supabase
    ? createReservationFromSupabase(actor, payload)
    : createReservationDemo(actor, payload)
);

const simulatePaymentDemo = (actor, reservationId, approvedOrder) => {
  const reservation = demoState.reservations.find((item) => item.id === reservationId);
  if (!reservation || (actor.role === 'CUSTOMER' && reservation.customerId !== actor.id)) {
    const error = new Error('Reservasi tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  if (actor.role !== 'CUSTOMER') throw Object.assign(new Error('Hanya customer pemilik transaksi yang dapat membayar.'), { status: 403 });
  if (['CONFIRMED', 'RENTED', 'COMPLETED'].includes(reservation.status)) {
    const payment = demoState.payments.find((item) => item.reservationId === reservationId && item.status === 'PAID');
    if (payment) return { reservation, payment };
  }
  if (reservation.status !== 'PENDING_PAYMENT') {
    const error = new Error('Reservasi tidak sedang menunggu pembayaran.');
    error.status = 409;
    throw error;
  }
  if (new Date(reservation.expiresAt) <= new Date()) {
    reservation.status = 'EXPIRED';
    const error = new Error('Batas pembayaran sudah berakhir.');
    error.status = 409;
    throw error;
  }
  const vehicle = getVehicle(reservation.vehicleId);
  assertDemoReadiness(vehicle, reservation.customerId);
  if (!['AVAILABLE','RESERVED'].includes(vehicle.status) || hasActiveRental(vehicle.id)) throw Object.assign(new Error('Kendaraan belum siap untuk pembayaran.'), { status: 409 });
  const paymentRecord = approvedOrder ? {provider:'INTERNAL_MANUAL',amount:reservation.totalAmount,status:'PAID',paidAt:new Date().toISOString()} : createPaymentRecord({ reservationId, amount: reservation.totalAmount });
  const payment = {
    id: makeId('pay'),
    reservationId,
    provider: paymentRecord.provider,
    amount: paymentRecord.amount,
    status: paymentRecord.status,
    paidAt: paymentRecord.paidAt
  };
  reservation.status = 'CONFIRMED';
  reservation.paidAt = payment.paidAt;
  demoState.payments.push(payment);
  return { reservation, payment };
};

const simulatePaymentFromSupabase = async (actor, reservationId) => {
  createPaymentRecord({ reservationId, amount: 0 });
  const result = await rentalTransaction(actor, 'PAY', { reservationId });
  const context = await loadReservationContext([result.reservation]);
  return { reservation: mapDbReservation(result.reservation, context), payment: {
    id: result.payment.id, reservationId: result.payment.reservation_id,
    provider: result.payment.provider, amount: Number(result.payment.amount),
    status: result.payment.status, paidAt: result.payment.paid_at
  } };
};

export const simulatePayment = (actor, reservationId, approvedOrder) => (
  supabase
    ? simulatePaymentFromSupabase(actor, reservationId)
    : simulatePaymentDemo(actor, reservationId, approvedOrder)
);

const assertCompanyAccess = (actor, companyId) => {
  if (actor.role !== 'CENTRAL_ADMIN' && actor.companyId !== companyId) {
    const error = new Error('Akses lintas perusahaan tidak diizinkan.');
    error.status = 403;
    throw error;
  }
};

const handoverDemo = (actor, reservationId, payload = {}) => {
  validateInspection(payload);
  const reservation = demoState.reservations.find((item) => item.id === reservationId);
  if (!reservation) {
    const error = new Error('Reservasi tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  assertCompanyAccess(actor, reservation.companyId);
  if (!['STAFF', 'RENTAL_ADMIN', 'CENTRAL_ADMIN'].includes(actor.role)) {
    const error = new Error('Role tidak dapat melakukan handover.');
    error.status = 403;
    throw error;
  }
  if (reservation.status !== 'CONFIRMED') {
    const error = new Error('Reservasi belum siap untuk handover.');
    error.status = 409;
    throw error;
  }
  if (internalMode() && (baliToday() < reservation.startDate || baliToday() >= reservation.endDate)) throw Object.assign(new Error('Handover hanya pada periode reservasi (waktu Bali).'), {status:409});
  const vehicle = getVehicle(reservation.vehicleId);
  assertDemoReadiness(vehicle, reservation.customerId);
  if (vehicle.gpsStatus !== 'READY' || !['AVAILABLE', 'RESERVED'].includes(vehicle.status) || hasActiveRental(vehicle.id)) {
    const error = new Error('Kendaraan tidak dapat handover karena GPS tidak siap atau kendaraan maintenance.');
    error.status = 409;
    throw error;
  }
  const rental = {
    id: makeId('rent'),
    reservationId,
    customerId: reservation.customerId,
    companyId: reservation.companyId,
    branchId: reservation.branchId,
    vehicleId: reservation.vehicleId,
    startDate: reservation.startDate,
    endDate: reservation.endDate,
    status: 'ACTIVE',
    handoverAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    returnMethod: null,
    returnSchedule: null
  };
  demoState.rentals.push(rental);
  reservation.status = 'RENTED';
  vehicle.status = 'RENTED';
  const inspection = {
    id: makeId('insp'),
    rentalId: rental.id,
    type: 'BEFORE',
    staffId: actor.id,
    staffChecklist: payload.staffChecklist || [],
    staffPhotos: payload.staffPhotos || [],
    customerPhotos: payload.customerPhotos || [],
    customerSignature: payload.customerSignature || null,
    notes: payload.notes || '',
    submittedAt: new Date().toISOString(),
    reviewedAt: null
  };
  demoState.inspections.push(inspection);
  return { rental, inspection };
};

const rentalTransaction = async (actor, action, payload) => {
  const { data, error } = await supabase.rpc('transrent_transaction_v3', { p_actor: actor.id, p_action: action, p_payload: payload });
  if (error?.code === 'PGRST202') throw Object.assign(new Error('Migration 015–016 belum tersedia. Jalankan skrip final melalui SQL Editor.'), { status: 503, code: 'MIGRATION_REQUIRED' });
  if (error && /^PT(400|403|404|409)$/.test(error.code)) throw Object.assign(new Error(error.message), { status: Number(error.code.slice(2)), code: error.code });
  if (error?.code === '23505') throw Object.assign(new Error('Transaksi bertabrakan dengan data yang sudah ada.'), { status: 409 });
  throwSupabaseError('Transaksi rental gagal', error);
  return data;
};

const prepareInspection = async (actor, subjectId, type, payload) => {
  validateInspection(payload);
  if (!['STAFF', 'RENTAL_ADMIN', 'CENTRAL_ADMIN'].includes(actor.role)) throw Object.assign(new Error('Role tidak dapat membuat inspeksi.'), { status: 403 });
  const source = type === 'BEFORE' ? 'reservations' : 'rentals';
  const { data, error } = await supabase.from(source).select('id,company_id,status').eq('id', subjectId).maybeSingle();
  throwSupabaseError('Gagal memeriksa akses inspeksi', error);
  if (!data) throw Object.assign(new Error('Data inspeksi tidak ditemukan.'), { status: 404 });
  assertCompanyAccess(actor, data.company_id);
  if (data.status !== (type === 'BEFORE' ? 'CONFIRMED' : 'ACTIVE')) throw Object.assign(new Error('Status tidak dapat diinspeksi.'), { status: 409 });
  // Immutable attempt paths preserve earlier evidence when a transaction is retried.
  const ownerId = `${subjectId}-${randomUUID()}`;
  const [customerSignature, staffPhotos, customerPhotos] = await Promise.all([
    uploadDataUrl(payload.customerSignature, { folder: 'inspections', ownerId, fileName: 'signature' }),
    uploadDataUrls(payload.staffPhotos, { folder: 'inspections', ownerId, fileName: 'staff' }),
    uploadDataUrls(payload.customerPhotos, { folder: 'inspections', ownerId, fileName: 'customer' })
  ]);
  return { ...payload, customerSignature, staffPhotos, customerPhotos };
};

const inspectionTransaction = async (actor, action, payload) => {
  try { return await rentalTransaction(actor, action, payload); }
  catch (error) {
    const paths = [payload.customerSignature, ...(payload.staffPhotos || []), ...(payload.customerPhotos || [])].filter((p) => typeof p === 'string' && p.startsWith('inspections/'));
    if (paths.length) {
      const cleanup = await supabase.storage.from(storageInfo.bucket).remove(paths);
      if (cleanup.error) console.warn('Inspection upload cleanup pending:', paths);
    }
    throw error;
  }
};

const rentalResult = async (result) => {
  if (result.rental) {
    const context = await loadRentalContext([result.rental]);
    result.rental = mapDbRental(result.rental, context);
  }
  if (result.refund) result.refund = mapDbRefund(result.refund);
  if (result.fine) result.fine = mapDbFine(result.fine);
  if (result.dispute) result.dispute = mapDbDispute(result.dispute);
  return result;
};

const handoverFromSupabase = async (actor, reservationId, payload = {}) => {
  const inspection = await prepareInspection(actor, reservationId, 'BEFORE', payload);
  return rentalResult(await inspectionTransaction(actor, 'HANDOVER', { ...inspection, reservationId }));
};

export const handover = (actor, reservationId, payload = {}) => (
  supabase
    ? handoverFromSupabase(actor, reservationId, payload)
    : handoverDemo(actor, reservationId, payload)
);

const computeFine = (rental, payload) => {
  const items = Array.isArray(payload.damageItems) ? payload.damageItems : [];
  const damageTotal = items.reduce((total, item) => total + Number(item.amount || 0), 0);
  const actualReturnDate = payload.actualReturnDate || (internalMode() ? baliToday() : rental.endDate);
  if (internalMode() && actualReturnDate !== baliToday()) badRequest('Tanggal return harus hari ini (waktu Bali).');
  const lateDays = Math.max(0, Math.ceil((dateOnly(actualReturnDate) - dateOnly(rental.endDate)) / 86_400_000));
  const vehicle = getVehicle(rental.vehicleId);
  const reservation = demoState.reservations.find(s=>s.id===rental.reservationId);
  const lateTotal = lateDays * Math.round((internalMode() ? reservation.rentalAmount / reservation.rentalDays : vehicle.pricePerDay) * 0.25);
  return { items, damageTotal, lateDays, lateTotal, total: damageTotal + lateTotal };
};

const returnRentalDemo = (actor, rentalId, payload = {}) => {
  validateInspection(payload);
  validateReturn(payload);
  const rental = demoState.rentals.find((item) => item.id === rentalId);
  if (!rental) {
    const error = new Error('Rental tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  assertCompanyAccess(actor, rental.companyId);
  if (!['STAFF', 'RENTAL_ADMIN', 'CENTRAL_ADMIN'].includes(actor.role)) {
    const error = new Error('Role tidak dapat melakukan return.');
    error.status = 403;
    throw error;
  }
  if (rental.status !== 'ACTIVE') {
    const error = new Error('Rental tidak sedang aktif.');
    error.status = 409;
    throw error;
  }
  const inspection = {
    id: makeId('insp'),
    rentalId: rental.id,
    type: 'AFTER',
    staffId: actor.id,
    staffChecklist: payload.staffChecklist || [],
    staffPhotos: payload.staffPhotos || [],
    customerPhotos: payload.customerPhotos || [],
    customerSignature: payload.customerSignature || null,
    notes: payload.notes || '',
    submittedAt: new Date().toISOString(),
    reviewedAt: null
  };
  if (payload.actualReturnDate && dateOnly(payload.actualReturnDate) < dateOnly(rental.startDate)) badRequest('Tanggal return sebelum rental dimulai.');
  const fine = computeFine(rental, payload);
  if (!Number.isFinite(fine.total) || fine.total > 999999999999) badRequest('Total denda melebihi batas.');
  demoState.inspections.push(inspection);
  if (fine.total > 0 || fine.items.length > 0) {
    demoState.fines.push({
      id: makeId('fine'),
      rentalId: rental.id,
      status: 'ISSUED',
      damageItems: fine.items,
      lateDays: fine.lateDays,
      amount: fine.total,
      createdAt: new Date().toISOString()
    });
  }
  const reservation = demoState.reservations.find((item) => item.id === rental.reservationId);
  rental.status = 'RETURN_PENDING_REVIEW';
  rental.returnedAt = new Date().toISOString();
  rental.actualReturnDate = payload.actualReturnDate || (internalMode() ? baliToday() : rental.endDate);
  rental.returnMethod = payload.returnMethod || 'SELF_RETURN';
  rental.returnSchedule = payload.returnSchedule || null;
  const vehicle = getVehicle(rental.vehicleId);
  vehicle.status = 'RETURN_INSPECTION';
  vehicle.repairRequired = vehicle.repairRequired || fine.items.length > 0;
  const refundAmount = Math.max(0, (reservation?.depositAmount || 0) - fine.total);
  demoState.refunds.push({
    id: makeId('refund'),
    rentalId: rental.id,
    amount: refundAmount,
    status: 'PENDING_CONFIRMATION',
    provider: internalMode() ? 'INTERNAL_MANUAL' : 'SIMULATED_GATEWAY',
    createdAt: new Date().toISOString()
  });
  return { rental, inspection, fine, refundAmount };
};

const returnRentalFromSupabase = async (actor, rentalId, payload = {}) => {
  validateReturn(payload);
  const inspection = await prepareInspection(actor, rentalId, 'AFTER', payload);
  return rentalResult(await inspectionTransaction(actor, 'RETURN', { ...inspection, rentalId }));
};

export const returnRental = (actor, rentalId, payload = {}) => (
  supabase
    ? returnRentalFromSupabase(actor, rentalId, payload)
    : returnRentalDemo(actor, rentalId, payload)
);

const confirmRefundDemo = (actor, rentalId) => {
  const rental = demoState.rentals.find((item) => item.id === rentalId);
  if (!rental) {
    const error = new Error('Rental tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  assertCompanyAccess(actor, rental.companyId);
  if (!['RENTAL_ADMIN', 'CENTRAL_ADMIN'].includes(actor.role)) {
    const error = new Error('Hanya Admin Rental yang dapat mengonfirmasi refund.');
    error.status = 403;
    throw error;
  }
  const refund = demoState.refunds.find((item) => item.rentalId === rentalId);
  const vehicle = getVehicle(rental.vehicleId);
  if (rental.status === 'COMPLETED' && refund?.status === 'APPROVED') return { rental, refund };
  if (rental.status === 'RETURN_PENDING_REVIEW' && refund?.status === 'APPROVED') return { rental, refund };
  if (rental.status !== 'RETURN_PENDING_REVIEW' || refund?.status !== 'PENDING_CONFIRMATION') {
    throw Object.assign(new Error('Return dan refund harus menunggu konfirmasi.'), { status: 409 });
  }
  if (demoSettlement(rental).disputed) {
    throw Object.assign(new Error('Selesaikan sengketa denda sebelum refund.'), { status: 409 });
  }
  const settlement = demoSettlement(rental);
  if (settlement.balanceDue > 0) throw Object.assign(new Error('Selisih denda harus dilunasi sebelum menutup rental.'), { status: 409 });
  refund.amount = settlement.refundAmount;
  if (internalMode() && refund.amount>0) { refund.status='APPROVED'; refund.provider='INTERNAL_MANUAL'; refund.confirmedBy=actor.id; refund.confirmedAt=new Date().toISOString(); demoState.fines.filter(f=>f.rentalId===rentalId&&f.status!=='CANCELLED').forEach(f=>{f.status='APPROVED';}); return {rental,refund}; }
  rental.status = 'COMPLETED';
  const reservation = demoState.reservations.find((item) => item.id === rental.reservationId);
  if (reservation) reservation.status = 'COMPLETED';
  rental.completedAt = new Date().toISOString();
  const damaged = demoState.fines.some((fine) => fine.rentalId === rentalId && (fine.damageItems || []).length > 0);
  const maintenance = demoState.maintenances.some((item) => item.vehicleId === vehicle.id && ['SCHEDULED', 'IN_PROGRESS'].includes(item.status));
  vehicle.status = vehicle.repairRequired || damaged || maintenance || vehicle.gpsStatus !== 'READY' ? 'MAINTENANCE' : 'AVAILABLE';
  if (refund) {
    refund.status = 'APPROVED';
    refund.confirmedAt = new Date().toISOString();
  }
  return { rental, refund };
};

const confirmRefundFromSupabase = async (actor, rentalId) => rentalResult(await rentalTransaction(actor, 'REFUND', { rentalId }));

export const confirmRefund = (actor, rentalId) => (
  supabase
    ? confirmRefundFromSupabase(actor, rentalId)
    : confirmRefundDemo(actor, rentalId)
);

const submitDisputeDemo = (actor, fineId, payload = {}) => {
  const reason = requiredReason(payload?.reason);
  const fine = demoState.fines.find((item) => item.id === fineId);
  const rental = fine && demoState.rentals.find((item) => item.id === fine.rentalId);
  if (!fine || !rental || rental.customerId !== actor.id) {
    const error = new Error('Denda tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  if (actor.role !== 'CUSTOMER') throw Object.assign(new Error('Hanya customer dapat mengajukan sengketa.'), { status: 403 });
  if (rental.finePayment || rental.status !== 'RETURN_PENDING_REVIEW' || !['ISSUED', 'ADJUSTED'].includes(fine.status)) throw Object.assign(new Error('Denda tidak dapat disengketakan.'), { status: 409 });
  if ((demoState.paymentOrders||[]).some(o=>o.rentalId===rental.id&&o.status==='DECLARED'&&new Date(o.expiresAt)>new Date())) throw Object.assign(new Error('Pembayaran sedang diperiksa admin.'),{status:409});
  (demoState.paymentOrders||[]).filter(o=>o.rentalId===rental.id&&o.status==='PENDING').forEach(o=>{o.status='CANCELLED';});
  fine.status = 'DISPUTED';
  const dispute = {
    id: makeId('dispute'),
    fineId,
    customerId: actor.id,
    reason,
    status: 'OPEN',
    createdAt: new Date().toISOString()
  };
  demoState.disputes.push(dispute);
  return dispute;
};

const submitDisputeFromSupabase = async (actor, fineId, payload = {}) => {
  const { dispute } = await rentalTransaction(actor, 'DISPUTE', { fineId, reason: requiredReason(payload?.reason) });
  return mapDbDispute(dispute);
};

export const submitDispute = (actor, fineId, payload) => (
  supabase
    ? submitDisputeFromSupabase(actor, fineId, payload)
    : submitDisputeDemo(actor, fineId, payload)
);

const profileSelect = 'id,name,email,phone,address,role,company_id,branch_id,verification_status,ktp_number,sim_number,ktp_document_path,sim_document_path,created_at,updated_at';

const mapDbProfile = (profile) => ({
  id: profile.id,
  name: profile.name,
  email: profile.email,
  phone: profile.phone,
  address: profile.address,
  role: profile.role,
  companyId: profile.company_id,
  branchId: profile.branch_id,
  verificationStatus: profile.verification_status,
  ktpNumber: profile.ktp_number,
  simNumber: profile.sim_number,
  ktpDocument: profile.ktp_document_path,
  simDocument: profile.sim_document_path,
  createdAt: profile.created_at,
  updatedAt: profile.updated_at
});

export const listCustomers = async (actor) => {
  if (supabase) {
    const { data, error } = await supabase
      .from('profiles')
      .select(profileSelect)
      .eq('role', 'CUSTOMER')
      .order('created_at', { ascending: false });

    throwSupabaseError('Gagal membaca daftar customer', error);
    return (data || []).map(mapDbProfile);
  }

  return demoState.users
    .filter((user) => user.role === 'CUSTOMER')
    .filter((user) => actor.role === 'CENTRAL_ADMIN' || !actor.companyId)
    .map(getPublicUser);
};

export const updateVerification = async (actor, customerId, status) => {
  if (actor.role !== 'CENTRAL_ADMIN') {
    const error = new Error('Hanya Admin Pusat yang dapat memverifikasi customer.');
    error.status = 403;
    throw error;
  }
  if (!['PENDING', 'VERIFIED', 'REJECTED'].includes(status)) {
    const error = new Error('Status verifikasi tidak valid.');
    error.status = 400;
    throw error;
  }

  if (supabase) {
    const { data, error } = await supabase
      .from('profiles')
      .update({
        verification_status: status,
        updated_at: new Date().toISOString()
      })
      .eq('id', customerId)
      .eq('role', 'CUSTOMER')
      .select(profileSelect)
      .maybeSingle();

    throwSupabaseError('Gagal memperbarui verifikasi customer', error);
    if (!data) {
      const notFound = new Error('Customer tidak ditemukan.');
      notFound.status = 404;
      throw notFound;
    }
    return mapDbProfile(data);
  }

  const customer = getUser(customerId);
  if (!customer || customer.role !== 'CUSTOMER') {
    const error = new Error('Customer tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  customer.verificationStatus = status;
  return getPublicUser(customer);
};

const listLocationsDemo = async (actor, vehicleId) => {
  const vehicle = getVehicle(vehicleId);
  if (!vehicle) {
    const error = new Error('Kendaraan tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  if (actor.role === 'CUSTOMER' && !await getActiveGpsAgreement(vehicle.companyId)) throw Object.assign(new Error('Izin GPS tidak aktif.'),{status:403});
  if (actor.role === 'CUSTOMER') {
    const activeRental = demoState.rentals.find((rental) => rental.vehicleId === vehicleId && rental.customerId === actor.id && rental.status === 'ACTIVE');
    if (!activeRental) {
      const error = new Error('Customer hanya dapat melihat GPS rental aktif miliknya.');
      error.status = 403;
      throw error;
    }
  } else if (actor.role !== 'CENTRAL_ADMIN' && actor.companyId !== vehicle.companyId) {
    const error = new Error('Akses tracking tidak diizinkan.');
    error.status = 403;
    throw error;
  }
  return demoState.locations.filter((location) => location.vehicleId === vehicleId && (actor.role !== 'CUSTOMER' || demoState.rentals.some((rental) => rental.id === location.rentalId && rental.customerId === actor.id && rental.status === 'ACTIVE'))).sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
};

const listLocationsFromSupabase = async (actor, vehicleId) => {
  const vehicleResult = await supabase
    .from('vehicles')
    .select('id,company_id')
    .eq('id', vehicleId)
    .maybeSingle();
  throwSupabaseError('Gagal membaca kendaraan tracking', vehicleResult.error);

  const vehicle = vehicleResult.data;
  if (!vehicle) {
    const error = new Error('Kendaraan tidak ditemukan.');
    error.status = 404;
    throw error;
  }

  if (actor.role === 'CUSTOMER' && !await getActiveGpsAgreement(vehicle.company_id)) throw Object.assign(new Error('Izin GPS tidak aktif.'),{status:403});
  let allowedRentalIds = null;
  if (actor.role === 'CUSTOMER') {
    const rentalResult = await supabase
      .from('rentals')
      .select('id')
      .eq('vehicle_id', vehicleId)
      .eq('customer_id', actor.id)
      .eq('status', 'ACTIVE')
      .limit(1);
    throwSupabaseError('Gagal memeriksa akses tracking customer', rentalResult.error);
    allowedRentalIds = (rentalResult.data || []).map((row) => row.id);
    if (allowedRentalIds.length === 0) {
      const error = new Error(
        'Customer hanya dapat melihat GPS rental aktif miliknya.'
      );
      error.status = 403;
      throw error;
    }
  } else {
    assertCompanyAccess(actor, vehicle.company_id);
  }

  let locationsQuery = supabase
    .from('vehicle_locations')
    .select('id,vehicle_id,rental_id,location,speed,heading,recorded_at')
    .eq('vehicle_id', vehicleId)
    .order('recorded_at', { ascending: true });
  if (allowedRentalIds) locationsQuery = locationsQuery.in('rental_id', allowedRentalIds);
  const locationsResult = await locationsQuery;
  throwSupabaseError('Gagal membaca histori lokasi', locationsResult.error);

  return (locationsResult.data || []).map(mapDbLocation);
};

export const listLocations = (actor, vehicleId) => (
  supabase
    ? listLocationsFromSupabase(actor, vehicleId)
    : listLocationsDemo(actor, vehicleId)
);

const trackingVehiclesDemo = async (actor) => { const rows=listRentalsDemo(actor).filter(r=>r.status==='ACTIVE'); const allowed=await Promise.all(rows.map(r=>getActiveGpsAgreement(r.companyId))); return rows.filter((r,i)=>allowed[i])
  .map((rental) => ({
    rentalId: rental.id,
    vehicle: rental.vehicle,
    customer: rental.customer,
    latestLocation: rental.latestLocation
  })); };

const trackingVehiclesFromSupabase = async (actor) => {
  const rentals = await listRentalsFromSupabase(actor);
  const allowed=await Promise.all(rentals.map(r=>getActiveGpsAgreement(r.companyId)));
  return rentals
    .filter((rental,i) => rental.status === 'ACTIVE' && allowed[i])
    .map((rental) => ({
      rentalId: rental.id,
      vehicle: rental.vehicle,
      customer: rental.customer,
      latestLocation: rental.latestLocation
    }));
};

export const trackingVehicles = (actor) => (
  supabase
    ? trackingVehiclesFromSupabase(actor)
    : trackingVehiclesDemo(actor)
);

const ingestLocationDemo = async ({ deviceId, latitude, longitude, speed = 0, heading = 0 }) => {
  const vehicle = demoState.vehicles.find((item) => item.gpsDeviceId === deviceId);
  if (!vehicle) {
    const error = new Error('GPS device tidak terdaftar.');
    error.status = 404;
    throw error;
  }
  if (!await getActiveGpsAgreement(vehicle.companyId)) throw Object.assign(new Error('Izin GPS/perusahaan tidak aktif.'),{status:403});
  if (vehicle.gpsStatus !== 'READY') {
    const error = new Error('GPS device tidak berstatus READY.');
    error.status = 409;
    throw error;
  }
  const activeRental = demoState.rentals.find((rental) => rental.vehicleId === vehicle.id && rental.status === 'ACTIVE');
  if (!activeRental) {
    const error = new Error('Kendaraan belum memiliki rental aktif.');
    error.status = 409;
    throw error;
  }
  const location = {
    id: makeId('loc'),
    vehicleId: vehicle.id,
    rentalId: activeRental.id,
    latitude: Number(latitude),
    longitude: Number(longitude),
    speed: Number(speed),
    heading: Number(heading),
    recordedAt: new Date().toISOString()
  };
  demoState.locations.push(location);
  return location;
};

const isUuid = (value) => (
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
);

const ingestLocationFromSupabase = async ({ deviceId, latitude, longitude, speed = 0, heading = 0 }) => {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const error = new Error('Koordinat GPS tidak valid.');
    error.status = 400;
    throw error;
  }

  let deviceResult = await supabase
    .from('gps_devices')
    .select('id,device_code,status')
    .eq('device_code', deviceId)
    .limit(2);
  throwSupabaseError('Gagal membaca GPS device', deviceResult.error);

  if ((deviceResult.data || []).length === 0 && isUuid(deviceId)) {
    deviceResult = await supabase
      .from('gps_devices')
      .select('id,device_code,status')
      .eq('id', deviceId)
      .limit(2);
    throwSupabaseError('Gagal membaca GPS device', deviceResult.error);
  }

  if ((deviceResult.data || []).length > 1) {
    const error = new Error(
      `GPS device '${deviceId}' memiliki lebih dari satu baris. Jalankan query diagnostik GPS dan perbaiki data sebelum simulator dijalankan.`
    );
    error.status = 409;
    error.code = 'DUPLICATE_GPS_DEVICE_CODE';
    throw error;
  }

  const device = deviceResult.data?.[0] || null;
  if (!device) {
    const error = new Error('GPS device tidak terdaftar.');
    error.status = 404;
    throw error;
  }
  if (device.status !== 'READY') {
    const error = new Error('GPS device tidak berstatus READY.');
    error.status = 409;
    throw error;
  }

  const vehicleResult = await supabase
    .from('vehicles')
    .select('id,gps_status,company_id')
    .eq('gps_device_id', device.id)
    .limit(2);
  throwSupabaseError('Gagal membaca kendaraan GPS', vehicleResult.error);

  if ((vehicleResult.data || []).length > 1) {
    const error = new Error(
      `GPS device '${device.device_code}' terhubung ke lebih dari satu kendaraan. Satu GPS hanya boleh dipasang pada satu kendaraan.`
    );
    error.status = 409;
    error.code = 'DUPLICATE_VEHICLE_GPS_MAPPING';
    throw error;
  }

  const vehicle = vehicleResult.data?.[0] || null;
  if (!vehicle || vehicle.gps_status !== 'READY') {
    const error = new Error('Kendaraan GPS tidak siap.');
    error.status = 409;
    throw error;
  }

  if (!await getActiveGpsAgreement(vehicle.company_id)) throw Object.assign(new Error('Izin GPS/perusahaan tidak aktif.'),{status:403});
  const rentalResult = await supabase
    .from('rentals')
    .select('id')
    .eq('vehicle_id', vehicle.id)
    .eq('status', 'ACTIVE')
    .limit(1);
  throwSupabaseError('Gagal membaca rental GPS aktif', rentalResult.error);

  const activeRental = rentalResult.data?.[0];
  if (!activeRental) {
    const error = new Error('Kendaraan belum memiliki rental aktif.');
    error.status = 409;
    throw error;
  }

  const {rpc}=await import('../operations.js');
  return mapDbLocation(await rpc('transrent_gps',{p_vehicle:vehicle.id,p_lat:lat,p_lng:lng,p_speed:Number(speed),p_heading:Number(heading)}));
};

export const ingestLocation = (payload={}) => {
  if(!payload || !Number.isFinite(Number(payload.latitude)) || !Number.isFinite(Number(payload.longitude)) || Math.abs(Number(payload.latitude))>90 || Math.abs(Number(payload.longitude))>180 || !Number.isFinite(Number(payload.speed||0)) || Number(payload.speed||0)<0 || !Number.isFinite(Number(payload.heading||0)) || Number(payload.heading||0)<0 || Number(payload.heading||0)>=360) badRequest('Koordinat/kecepatan/arah GPS tidak valid.');
  return supabase ? ingestLocationFromSupabase(payload) : ingestLocationDemo(payload);
};

const gpsDiagnosticsDemo = (actor) => {
  const devices = demoState.vehicles
    .filter((vehicle) => actor.role === 'CENTRAL_ADMIN' || vehicle.companyId === actor.companyId)
    .map((vehicle) => ({
      vehicleId: vehicle.id,
      vehicleName: vehicle.name,
      gpsDeviceId: vehicle.gpsDeviceId,
      gpsStatus: vehicle.gpsStatus,
      vehicleStatus: vehicle.status,
      mappingStatus: vehicle.gpsDeviceId ? 'MAPPED' : 'UNMAPPED'
    }));
  return {
    duplicateDeviceCodes: [],
    vehicles: devices,
    summary: {
      vehicles: devices.length,
      unmappedVehicles: devices.filter((item) => !item.gpsDeviceId).length,
      nonReadyVehicles: devices.filter((item) => item.gpsStatus !== 'READY').length
    }
  };
};

const gpsDiagnosticsFromSupabase = async (actor) => {
  const [devicesResult, vehiclesResult] = await Promise.all([
    supabase.from('gps_devices').select('id,device_code,status,last_seen_at').order('device_code'),
    supabase.from('vehicles').select('id,company_id,name,gps_device_id,gps_status,status').order('name')
  ]);
  throwSupabaseError('Gagal membaca GPS devices untuk diagnostik', devicesResult.error);
  throwSupabaseError('Gagal membaca kendaraan untuk diagnostik GPS', vehiclesResult.error);

  let vehicles = vehiclesResult.data || [];
  if (actor.role !== 'CENTRAL_ADMIN') {
    vehicles = vehicles.filter((vehicle) => vehicle.company_id === actor.companyId);
  }

  const deviceById = new Map((devicesResult.data || []).map((device) => [device.id, device]));
  const codeCounts = new Map();
  vehicles.forEach((vehicle) => {
    const device = deviceById.get(vehicle.gps_device_id);
    if (device) codeCounts.set(device.device_code, (codeCounts.get(device.device_code) || 0) + 1);
  });

  const duplicateDeviceCodes = [...codeCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([deviceCode, count]) => ({ deviceCode, count }));

  const rows = vehicles.map((vehicle) => {
    const device = deviceById.get(vehicle.gps_device_id) || null;
    return {
      vehicleId: vehicle.id,
      vehicleName: vehicle.name,
      gpsDeviceId: vehicle.gps_device_id,
      gpsDeviceCode: device?.device_code || null,
      gpsDeviceStatus: device?.status || null,
      lastSeenAt: device?.last_seen_at || null,
      gpsStatus: vehicle.gps_status,
      vehicleStatus: vehicle.status,
      mappingStatus: !vehicle.gps_device_id
        ? 'UNMAPPED'
        : !device
          ? 'DEVICE_NOT_FOUND'
          : 'MAPPED'
    };
  });

  return {
    duplicateDeviceCodes,
    vehicles: rows,
    summary: {
      vehicles: rows.length,
      unmappedVehicles: rows.filter((item) => item.mappingStatus !== 'MAPPED').length,
      nonReadyVehicles: rows.filter((item) => item.gpsStatus !== 'READY' || item.gpsDeviceStatus !== 'READY').length,
      duplicateMappings: duplicateDeviceCodes.length
    }
  };
};

export const gpsDiagnostics = (actor) => (
  supabase ? gpsDiagnosticsFromSupabase(actor) : gpsDiagnosticsDemo(actor)
);

const mapDbMaintenance = (row, vehicle, branch, company) => ({
  id: row.id,
  companyId: row.company_id,
  branchId: row.branch_id,
  vehicleId: row.vehicle_id,
  type: row.type,
  title: row.title,
  status: row.status,
  scheduledAt: row.scheduled_at,
  completedAt: row.completed_at,
  notes: row.notes,
  createdAt: row.created_at,
  vehicle: vehicle ? mapDbVehicle(vehicle, branch, company) : null,
  branch,
  company
});

const listMaintenanceDemo = (actor) => demoState.maintenances
  .filter((item) => {
    const vehicle = getVehicle(item.vehicleId);
    return actor.role === 'CENTRAL_ADMIN' || vehicle?.companyId === actor.companyId;
  })
  .map((item) => ({ ...item, vehicle: decorateVehicle(getVehicle(item.vehicleId)) }));

const listMaintenanceFromSupabase = async (actor) => {
  let query = supabase
    .from('maintenances')
    .select('id,company_id,branch_id,vehicle_id,type,title,status,scheduled_at,completed_at,notes,created_at')
    .order('created_at', { ascending: false });

  if (actor.role !== 'CENTRAL_ADMIN') {
    if (!actor.companyId) return [];
    query = query.eq('company_id', actor.companyId);
  }

  const { data, error } = await query;
  throwSupabaseError('Gagal membaca maintenance', error);
  const rows = data || [];
  const context = await loadReservationContext(rows.map((row) => ({
    vehicle_id: row.vehicle_id,
    branch_id: row.branch_id,
    company_id: row.company_id,
    customer_id: null
  })));

  return rows.map((row) => mapDbMaintenance(
    row,
    context.vehicles.get(row.vehicle_id),
    context.branches.get(row.branch_id) || null,
    context.companies.get(row.company_id) || null
  ));
};

export const listMaintenance = (actor) => (
  supabase
    ? listMaintenanceFromSupabase(actor)
    : listMaintenanceDemo(actor)
);

const listFleetDemo = (actor) => demoState.vehicles
  .filter((vehicle) => actor.role === 'CENTRAL_ADMIN' || vehicle.companyId === actor.companyId)
  .map((vehicle) => decorateVehicle(vehicle));

const listFleetFromSupabase = async (actor) => {
  let query = supabase
    .from('vehicles')
    .select(vehicleSelect)
    .order('name');

  if (actor.role !== 'CENTRAL_ADMIN') {
    if (!actor.companyId) return [];
    query = query.eq('company_id', actor.companyId);
  }

  const { data, error } = await query;
  throwSupabaseError('Gagal membaca armada', error);
  const rows = data || [];
  const context = await loadReservationContext(rows.map((row) => ({
    vehicle_id: row.id,
    branch_id: row.branch_id,
    company_id: row.company_id,
    customer_id: null
  })));

  return rows.map((row) => mapDbVehicle(
    row,
    context.branches.get(row.branch_id) || null,
    context.companies.get(row.company_id) || null
  ));
};

export const listFleet = (actor) => (
  supabase
    ? listFleetFromSupabase(actor)
    : listFleetDemo(actor)
);

const createMaintenanceDemo = (actor, payload) => {
  const vehicle = getVehicle(payload.vehicleId);
  if (!vehicle) {
    const error = new Error('Kendaraan tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  assertCompanyAccess(actor, vehicle.companyId);
  if (!['RENTAL_ADMIN', 'CENTRAL_ADMIN'].includes(actor.role)) {
    const error = new Error('Role tidak dapat membuat maintenance.');
    error.status = 403;
    throw error;
  }
  if (hasActiveRental(vehicle.id) || vehicle.status === 'INACTIVE') throw Object.assign(new Error('Kendaraan masih memiliki rental aktif atau dinonaktifkan.'), { status: 409 });
  if (!['SERVICE','REPAIR'].includes(payload.type || 'SERVICE')) badRequest('Jenis maintenance harus SERVICE atau REPAIR.');
  const maintenance = {
    id: makeId('mnt'),
    vehicleId: vehicle.id,
    type: payload.type || 'SERVICE',
    title: payload.title || 'Maintenance kendaraan',
    status: 'SCHEDULED',
    scheduledAt: payload.scheduledAt || new Date().toISOString(),
    notes: payload.notes || ''
  };
  demoState.maintenances.push(maintenance);
  vehicle.status = 'MAINTENANCE';
  return maintenance;
};

const maintenanceResult = async (result) => {
  const row = result.maintenance;
  const context = await loadReservationContext([row]);
  return mapDbMaintenance(row, context.vehicles.get(row.vehicle_id), context.branches.get(row.branch_id), context.companies.get(row.company_id));
};
const createMaintenanceFromSupabase = async (actor, payload) => maintenanceResult(await rentalTransaction(actor, 'MAINTENANCE', payload));

export const createMaintenance = (actor, payload) => (
  supabase
    ? createMaintenanceFromSupabase(actor, payload)
    : createMaintenanceDemo(actor, payload)
);

const maintenanceLifecycleRoles = new Set(['RENTAL_ADMIN', 'CENTRAL_ADMIN']);
const maintenanceSelect = 'id,company_id,branch_id,vehicle_id,type,title,status,scheduled_at,completed_at,notes,created_at';

const assertMaintenanceLifecycleRole = (actor) => {
  if (!maintenanceLifecycleRoles.has(actor.role)) {
    const error = new Error('Hanya Admin Rental atau Admin Pusat yang dapat mengubah status maintenance.');
    error.status = 403;
    throw error;
  }
};

const restoreDemoVehicleAvailability = (vehicleId) => {
  const vehicle = getVehicle(vehicleId);
  if (!vehicle || hasActiveRental(vehicleId) || ['RENTED', 'RETURN_INSPECTION', 'INACTIVE'].includes(vehicle.status)) return;
  const activeMaintenance = demoState.maintenances.some((item) => (
    item.vehicleId === vehicleId && ['SCHEDULED', 'IN_PROGRESS'].includes(item.status)
  ));
  if (!activeMaintenance && !vehicle.repairRequired && vehicle.gpsStatus === 'READY') vehicle.status = 'AVAILABLE';
};

const transitionMaintenanceDemo = (actor, maintenanceId, nextStatus) => {
  assertMaintenanceLifecycleRole(actor);
  const maintenance = demoState.maintenances.find((item) => item.id === maintenanceId);
  if (!maintenance) {
    const error = new Error('Maintenance tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  const vehicle = getVehicle(maintenance.vehicleId);
  assertCompanyAccess(actor, vehicle?.companyId);

  const allowed = {
    IN_PROGRESS: ['SCHEDULED'],
    COMPLETED: ['SCHEDULED', 'IN_PROGRESS'],
    CANCELLED: ['SCHEDULED', 'IN_PROGRESS']
  };
  if (!allowed[nextStatus]?.includes(maintenance.status)) {
    const error = new Error(`Maintenance berstatus ${maintenance.status} tidak dapat diubah menjadi ${nextStatus}.`);
    error.status = 409;
    throw error;
  }

  maintenance.status = nextStatus;
  maintenance.completedAt = nextStatus === 'COMPLETED' ? new Date().toISOString() : null;
  if (nextStatus === 'COMPLETED' && maintenance.type === 'REPAIR' && !demoState.maintenances.some((m) => m.vehicleId === vehicle.id && m.type === 'REPAIR' && ['SCHEDULED','IN_PROGRESS'].includes(m.status))) vehicle.repairRequired = false;
  if (['COMPLETED', 'CANCELLED'].includes(nextStatus)) restoreDemoVehicleAvailability(maintenance.vehicleId);
  return {
    ...maintenance,
    vehicle: vehicle ? decorateVehicle(vehicle) : null
  };
};

const transitionMaintenanceFromSupabase = async (actor, maintenanceId, nextStatus) => maintenanceResult(await rentalTransaction(actor, 'MAINTENANCE_STATUS', { maintenanceId, nextStatus }));

export const startMaintenance = (actor, maintenanceId) => (
  supabase
    ? transitionMaintenanceFromSupabase(actor, maintenanceId, 'IN_PROGRESS')
    : transitionMaintenanceDemo(actor, maintenanceId, 'IN_PROGRESS')
);

export const completeMaintenance = (actor, maintenanceId) => (
  supabase
    ? transitionMaintenanceFromSupabase(actor, maintenanceId, 'COMPLETED')
    : transitionMaintenanceDemo(actor, maintenanceId, 'COMPLETED')
);

export const cancelMaintenance = (actor, maintenanceId) => (
  supabase
    ? transitionMaintenanceFromSupabase(actor, maintenanceId, 'CANCELLED')
    : transitionMaintenanceDemo(actor, maintenanceId, 'CANCELLED')
);

const getSummaryDemo = async (actor) => {
  const companyVehicles = demoState.vehicles.filter((vehicle) => actor.role === 'CENTRAL_ADMIN' || vehicle.companyId === actor.companyId);
  const reservations = supabase
    ? await listReservationsFromSupabase(actor)
    : listReservationsDemo(actor);
  const rentals = listRentals(actor);
  return {
    companies: demoState.companies.filter(c=>actor.role==='CENTRAL_ADMIN'||c.id===actor.companyId).length,
    branches: demoState.branches.filter((branch) => actor.role === 'CENTRAL_ADMIN' || branch.companyId === actor.companyId).length,
    vehicles: companyVehicles.length,
    availableVehicles: companyVehicles.filter((vehicle) => vehicle.status === 'AVAILABLE' && vehicle.gpsStatus === 'READY').length,
    maintenanceVehicles: companyVehicles.filter((vehicle) => vehicle.status === 'MAINTENANCE' || vehicle.gpsStatus !== 'READY').length,
    pendingReservations: reservations.filter((item) => ['PENDING_PAYMENT', 'CONFIRMED'].includes(item.status)).length,
    activeRentals: rentals.filter((item) => item.status === 'ACTIVE').length,
    pendingRefunds: rentals.filter((item) => item.refund?.status === 'PENDING_CONFIRMATION').length,
    verifiedCustomers: demoState.users.filter((user) => user.role === 'CUSTOMER' && user.verificationStatus === 'VERIFIED').length
  };
};

const getSummaryFromSupabase = async (actor) => {
  const [companies, fleet, reservations, rentals, customers] = await Promise.all([
    getCompaniesFromSupabase({includeAll:true}),
    listFleetFromSupabase(actor),
    listReservationsFromSupabase(actor),
    listRentalsFromSupabase(actor),
    actor.role === 'CENTRAL_ADMIN' ? listCustomers(actor) : Promise.resolve([])
  ]);

  const scopedCompanies = companies.filter(c=>actor.role==='CENTRAL_ADMIN'||c.id===actor.companyId);
  const branches = scopedCompanies.reduce(
    (total, company) => total + company.branches.length,
    0
  );

  return {
    companies: scopedCompanies.length,
    branches,
    vehicles: fleet.length,
    availableVehicles: fleet.filter((vehicle) => (
      vehicle.status === 'AVAILABLE' && vehicle.gpsStatus === 'READY'
    )).length,
    maintenanceVehicles: fleet.filter((vehicle) => (
      vehicle.status === 'MAINTENANCE' || vehicle.gpsStatus !== 'READY'
    )).length,
    pendingReservations: reservations.filter((item) => (
      ['PENDING_PAYMENT', 'CONFIRMED'].includes(item.status)
    )).length,
    activeRentals: rentals.filter((item) => item.status === 'ACTIVE').length,
    pendingRefunds: rentals.filter((item) => (
      item.refund?.status === 'PENDING_CONFIRMATION'
    )).length,
    verifiedCustomers: customers.filter((user) => (
      user.verificationStatus === 'VERIFIED'
    )).length
  };
};

export const getSummary = (actor) => (
  supabase
    ? getSummaryFromSupabase(actor)
    : getSummaryDemo(actor)
);

export const constants = { DELIVERY_RADIUS_KM };

const demoSettlement = (rental) => {
  const fines = demoState.fines.filter((f) => f.rentalId === rental.id);
  const disputes = demoState.disputes.filter((d) => fines.some((f) => f.id === d.fineId));
  const reservation = demoState.reservations.find((s) => s.id === rental.reservationId);
  return financialSummary(fines, reservation?.depositAmount || 0, rental.finePayment, disputes);
};

const requiredReason = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) badRequest('Alasan wajib 1-2000 karakter.');
  return value.trim();
};

export const cancelReservation = async (actor, reservationId, payload = {}) => {
  const reason = requiredReason(payload?.reason);
  if (supabase) {
    const result = await rentalTransaction(actor, 'CANCEL', { reservationId, reason });
    return { reservation: mapDbReservation(result.reservation, await loadReservationContext([result.reservation])) };
  }
  const reservation = demoState.reservations.find((s) => s.id === reservationId);
  if (!reservation || (actor.role === 'CUSTOMER' && reservation.customerId !== actor.id)) throw Object.assign(new Error('Reservasi tidak ditemukan.'), { status: 404 });
  if (actor.role !== 'CUSTOMER') { assertCompanyAccess(actor, reservation.companyId); assertMaintenanceLifecycleRole(actor); }
  if (reservation.status === 'CANCELLED' && reservation.cancellation) return { reservation };
  if (!['DRAFT','PENDING_PAYMENT','CONFIRMED'].includes(reservation.status) || demoState.rentals.some((r) => r.reservationId === reservationId)) throw Object.assign(new Error('Pembatalan hanya sebelum handover.'), { status: 409 });
  const payment = demoState.payments.find((p) => p.reservationId === reservationId && p.status === 'PAID');
  if (payment && !['SIMULATED_GATEWAY','INTERNAL_MANUAL'].includes(payment.provider)) throw Object.assign(new Error('Pembayaran riil memerlukan refund melalui provider resmi.'), { status: 409 });
  if (reservation.status === 'CONFIRMED' && !payment) throw Object.assign(new Error('Pembayaran reservasi tidak konsisten; perlu rekonsiliasi.'), { status: 409 });
  const cancelledAt = new Date().toISOString();
  reservation.cancellation = { id: makeId('cancel'), reason, cancelledBy: actor.id, cancelledAt, refundAmount: payment?.amount || 0, refundStatus: payment ? (payment.provider === 'INTERNAL_MANUAL' ? 'REFUND_PENDING' : 'REFUNDED_SIMULATED') : 'NOT_REQUIRED', provider: payment?.provider || 'INTERNAL_MANUAL', paymentId: payment?.id || null };
  reservation.status = 'CANCELLED'; reservation.cancelledAt = cancelledAt;
  if (payment?.provider === 'SIMULATED_GATEWAY') payment.status = 'REFUNDED';
  (demoState.paymentOrders||[]).filter(o=>o.reservationId===reservationId&&['PENDING','DECLARED','PAID'].includes(o.status)).forEach(o=>{o.status=o.status==='PAID'?'REFUND_PENDING':'CANCELLED';});
  return { reservation };
};

export const resolveDispute = async (actor, disputeId, payload = {}) => {
  const notes = requiredReason(payload?.notes);
  if (!['ACCEPTED','REJECTED','ADJUSTED'].includes(payload.decision)) badRequest('Keputusan sengketa tidak valid.');
  if (payload.decision === 'ADJUSTED' && (!Number.isSafeInteger(payload.amount) || payload.amount < 0)) badRequest('Denda harus rupiah bulat tidak negatif.');
  if (supabase) return rentalResult(await rentalTransaction(actor, 'RESOLVE_DISPUTE', { ...payload, disputeId, notes }));
  assertMaintenanceLifecycleRole(actor);
  const dispute = demoState.disputes.find((d) => d.id === disputeId);
  const fine = dispute && demoState.fines.find((f) => f.id === dispute.fineId);
  const rental = fine && demoState.rentals.find((r) => r.id === fine.rentalId);
  if (!rental) throw Object.assign(new Error('Sengketa tidak ditemukan.'), { status: 404 });
  assertCompanyAccess(actor, rental.companyId);
  if (dispute.status !== 'OPEN') {
    if (dispute.status === payload.decision && dispute.resolutionNotes === notes && (payload.decision !== 'ADJUSTED' || dispute.finalAmount === payload.amount)) return { dispute, rental };
    throw Object.assign(new Error('Sengketa sudah diputuskan; keputusan tidak dapat ditimpa.'), { status: 409 });
  }
  if (rental.status !== 'RETURN_PENDING_REVIEW' || fine.status !== 'DISPUTED' || rental.finePayment) throw Object.assign(new Error('Sengketa tidak dapat diputuskan pada status ini.'), { status: 409 });
  if (payload.decision === 'ADJUSTED' && payload.amount > fine.amount) badRequest('Penyesuaian tidak boleh melebihi denda awal.');
  const amount = payload.decision === 'ACCEPTED' ? 0 : payload.decision === 'REJECTED' ? fine.amount : payload.amount;
  Object.assign(dispute, { status: payload.decision, resolutionNotes: notes, originalAmount: fine.amount, finalAmount: amount, resolvedBy: actor.id, resolvedAt: new Date().toISOString() });
  fine.amount = amount; fine.status = payload.decision === 'ACCEPTED' ? 'CANCELLED' : 'APPROVED';
  const refund = demoState.refunds.find((f) => f.rentalId === rental.id);
  if (refund?.status === 'PENDING_CONFIRMATION') refund.amount = demoSettlement(rental).refundAmount;
  return { dispute, rental };
};

export const simulateFinePayment = async (actor, rentalId, approvedOrder) => {
  if (!approvedOrder) createPaymentRecord({ reservationId: rentalId, amount: 0 });
  if (supabase) return rentalResult(await rentalTransaction(actor, 'PAY_FINE', { rentalId }));
  const rental = demoState.rentals.find((r) => r.id === rentalId);
  if (!rental || rental.customerId !== actor.id) throw Object.assign(new Error('Rental tidak ditemukan.'), { status: 404 });
  if (actor.role !== 'CUSTOMER') throw Object.assign(new Error('Hanya customer dapat membayar selisih denda.'), { status: 403 });
  if (rental.finePayment) return { rental, payment: rental.finePayment };
  const settlement = demoSettlement(rental);
  if (!['RETURN_PENDING_REVIEW','COMPLETED'].includes(rental.status) || settlement.disputed || settlement.balanceDue <= 0) throw Object.assign(new Error('Selesaikan sengketa dan pastikan ada selisih denda sebelum membayar.'), { status: 409 });
  rental.finePayment = { id: makeId('fine-pay'), provider: approvedOrder ? 'INTERNAL_MANUAL' : 'SIMULATED_GATEWAY', providerReference: makeId('FINE-SIM'), amount: settlement.balanceDue, status: 'PAID', paidBy: actor.id, paidAt: new Date().toISOString() };
  demoState.fines.filter((f) => f.rentalId === rental.id && f.status !== 'CANCELLED').forEach((f) => { f.status = 'APPROVED'; });
  return { rental, payment: rental.finePayment };
};
