import { demoState } from './demoData.js';
import { classifySupabaseError, supabase } from '../db.js';
import { uploadDataUrl, uploadDataUrls } from '../storage.js';
import { createPaymentRecord } from '../payments.js';

const DELIVERY_RADIUS_KM = 15;

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

const dateOnly = (value) => new Date(`${value}T00:00:00Z`);

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

const mapDbBranch = (branch) => ({
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

  const companyPayload = {
    name,
    legal_name: String(payload.legalName || '').trim() || null,
    email: String(payload.email || '').trim() || null,
    phone: String(payload.phone || '').trim() || null,
    description: String(payload.description || '').trim() || null,
    status: 'PENDING',
    delivery_radius_km: deliveryRadiusKm
  };

  if (supabase) {
    const result = await supabase
      .from('rental_companies')
      .insert(companyPayload)
      .select('id,name,legal_name,email,phone,description,status,delivery_radius_km')
      .single();
    throwSupabaseError('Gagal menambahkan perusahaan rental', result.error);
    return { ...mapDbCompany(result.data), branches: [] };
  }

  const duplicate = demoState.companies.find((company) => company.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    const error = new Error('Nama perusahaan sudah terdaftar.');
    error.status = 409;
    throw error;
  }
  const company = {
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
  status: row.status,
  gpsTrackingAllowed: row.gps_tracking_allowed,
  signedAt: row.signed_at,
  expiresAt: row.expires_at,
  documentPath: row.document_path,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export const listGpsAgreements = async (actor) => {
  requireCentralAdmin(actor);
  if (!supabase) {
    return demoState.agreements.map((agreement) => mapAgreement(
      {
        ...agreement,
        company_id: agreement.companyId,
        agreement_number: agreement.agreementNumber,
        gps_tracking_allowed: agreement.gpsTrackingAllowed,
        signed_at: agreement.signedAt,
        expires_at: agreement.expiresAt,
        document_path: agreement.documentPath || null,
        created_at: agreement.createdAt || null,
        updated_at: agreement.updatedAt || null
      },
      getCompany(agreement.companyId)
    ));
  }

  const [agreementsResult, companiesResult] = await Promise.all([
    supabase.from('rental_company_agreements')
      .select('id,company_id,agreement_number,status,gps_tracking_allowed,signed_at,expires_at,document_path,notes,created_at,updated_at')
      .order('created_at', { ascending: false }),
    supabase.from('rental_companies').select('id,name')
  ]);
  throwSupabaseError('Gagal membaca agreement GPS', agreementsResult.error);
  throwSupabaseError('Gagal membaca nama perusahaan agreement', companiesResult.error);
  const companies = new Map((companiesResult.data || []).map((company) => [company.id, company]));
  return (agreementsResult.data || []).map((agreement) => mapAgreement(agreement, companies.get(agreement.company_id)));
};

export const updateGpsAgreement = async (actor, agreementId, payload = {}) => {
  requireCentralAdmin(actor);
  const status = payload.status;
  if (!['DRAFT', 'PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED'].includes(status)) {
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
    if (status === 'ACTIVE') {
      const company = getCompany(agreement.companyId);
      if (company?.status !== 'ACTIVE') {
        const error = new Error('Perusahaan harus berstatus Aktif sebelum MoU GPS diaktifkan.');
        error.status = 409;
        throw error;
      }
      if (demoState.agreements.some((item) => item.id !== agreementId && item.companyId === agreement.companyId && item.status === 'ACTIVE')) {
        const error = new Error('Perusahaan sudah memiliki MoU aktif. Nonaktifkan MoU lama terlebih dahulu.');
        error.status = 409;
        throw error;
      }
    }
    agreement.status = status;
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

  if (status === 'ACTIVE') {
    const currentResult = await supabase
      .from('rental_company_agreements')
      .select('id,company_id')
      .eq('id', agreementId)
      .maybeSingle();
    throwSupabaseError('Gagal membaca agreement GPS', currentResult.error);
    if (!currentResult.data) {
      const error = new Error('Agreement GPS tidak ditemukan.');
      error.status = 404;
      throw error;
    }
    const companyResult = await supabase
      .from('rental_companies')
      .select('id,status')
      .eq('id', currentResult.data.company_id)
      .maybeSingle();
    throwSupabaseError('Gagal membaca status perusahaan rental', companyResult.error);
    if (companyResult.data?.status !== 'ACTIVE') {
      const error = new Error('Perusahaan harus berstatus Aktif sebelum MoU GPS diaktifkan.');
      error.status = 409;
      throw error;
    }
    const activeResult = await supabase
      .from('rental_company_agreements')
      .select('id')
      .eq('company_id', currentResult.data.company_id)
      .eq('status', 'ACTIVE')
      .neq('id', agreementId)
      .maybeSingle();
    throwSupabaseError('Gagal memeriksa MoU aktif', activeResult.error);
    if (activeResult.data) {
      const error = new Error('Perusahaan sudah memiliki MoU aktif. Nonaktifkan MoU lama terlebih dahulu.');
      error.status = 409;
      throw error;
    }
  }

  const result = await supabase
    .from('rental_company_agreements')
    .update({
      status,
      gps_tracking_allowed: gpsTrackingAllowed,
      updated_at: new Date().toISOString()
    })
    .eq('id', agreementId)
    .select('id,company_id,agreement_number,status,gps_tracking_allowed,signed_at,expires_at,document_path,notes,created_at,updated_at')
    .maybeSingle();
  throwSupabaseError('Gagal memperbarui agreement GPS', result.error);
  if (!result.data) {
    const error = new Error('Agreement GPS tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  const companyResult = await supabase
    .from('rental_companies')
    .select('id,name')
    .eq('id', result.data.company_id)
    .maybeSingle();
  throwSupabaseError('Gagal membaca perusahaan agreement GPS', companyResult.error);
  return mapAgreement(result.data, companyResult.data);
};

const validateAgreementDates = (signedAt, expiresAt) => {
  if (signedAt && expiresAt && new Date(expiresAt).getTime() <= new Date(signedAt).getTime()) {
    const error = new Error('Tanggal berakhir MoU harus setelah tanggal tanda tangan.');
    error.status = 400;
    throw error;
  }
};

export const createGpsAgreement = async (actor, payload = {}) => {
  requireCentralAdmin(actor, 'Hanya Admin Pusat yang dapat menambahkan MoU GPS.');
  const companyId = String(payload.companyId || '').trim();
  const status = payload.status || 'DRAFT';
  const signedAt = payload.signedAt || null;
  const expiresAt = payload.expiresAt || null;
  if (!companyId) {
    const error = new Error('Perusahaan MoU wajib dipilih.');
    error.status = 400;
    throw error;
  }
  if (!['DRAFT', 'PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED'].includes(status)) {
    const error = new Error('Status agreement GPS tidak valid.');
    error.status = 400;
    throw error;
  }
  validateAgreementDates(signedAt, expiresAt);
  const gpsTrackingAllowed = status === 'ACTIVE' && payload.gpsTrackingAllowed === true;
  const documentPath = await uploadDataUrl(payload.documentDataUrl, {
    folder: 'agreements',
    ownerId: companyId,
    fileName: `mou-${Date.now()}`
  });

  if (!supabase) {
    const company = getCompany(companyId);
    if (!company) {
      const error = new Error('Perusahaan rental tidak ditemukan.');
      error.status = 404;
      throw error;
    }
    const agreementNumber = nextDemoAgreementNumber();
    if (status === 'ACTIVE' && company.status !== 'ACTIVE') {
      const error = new Error('Perusahaan harus berstatus Aktif sebelum MoU GPS diaktifkan.');
      error.status = 409;
      throw error;
    }
    if (status === 'ACTIVE' && demoState.agreements.some((agreement) => agreement.companyId === companyId && agreement.status === 'ACTIVE')) {
      const error = new Error('Perusahaan sudah memiliki MoU aktif. Nonaktifkan MoU lama terlebih dahulu.');
      error.status = 409;
      throw error;
    }
    const now = new Date().toISOString();
    const agreement = {
      id: makeId('agr'),
      companyId,
      agreementNumber,
      status,
      gpsTrackingAllowed,
      signedAt,
      expiresAt,
      documentPath: documentPath || null,
      notes: String(payload.notes || '').trim() || null,
      createdAt: now,
      updatedAt: now
    };
    demoState.agreements.push(agreement);
    return mapAgreement({
      ...agreement,
      company_id: companyId,
      agreement_number: agreementNumber,
      gps_tracking_allowed: gpsTrackingAllowed,
      signed_at: signedAt,
      expires_at: expiresAt,
      document_path: documentPath || null,
      created_at: now,
      updated_at: now
    }, company);
  }

  const companyResult = await supabase
    .from('rental_companies')
    .select('id,name,status')
    .eq('id', companyId)
    .maybeSingle();
  throwSupabaseError('Gagal membaca perusahaan MoU', companyResult.error);
  if (!companyResult.data) {
    const error = new Error('Perusahaan rental tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  if (status === 'ACTIVE' && companyResult.data.status !== 'ACTIVE') {
    const error = new Error('Perusahaan harus berstatus Aktif sebelum MoU GPS diaktifkan.');
    error.status = 409;
    throw error;
  }
  if (status === 'ACTIVE') {
    const activeResult = await supabase
      .from('rental_company_agreements')
      .select('id')
      .eq('company_id', companyId)
      .eq('status', 'ACTIVE')
      .maybeSingle();
    throwSupabaseError('Gagal memeriksa MoU aktif', activeResult.error);
    if (activeResult.data) {
      const error = new Error('Perusahaan sudah memiliki MoU aktif. Nonaktifkan MoU lama terlebih dahulu.');
      error.status = 409;
      throw error;
    }
  }

  const result = await supabase
    .from('rental_company_agreements')
    .insert({
      company_id: companyId,
      status,
      gps_tracking_allowed: gpsTrackingAllowed,
      signed_at: signedAt,
      expires_at: expiresAt,
      document_path: documentPath || null,
      notes: String(payload.notes || '').trim() || null
    })
    .select('id,company_id,agreement_number,status,gps_tracking_allowed,signed_at,expires_at,document_path,notes,created_at,updated_at')
    .single();
  throwSupabaseError('Gagal menambahkan MoU GPS', result.error);
  return mapAgreement(result.data, companyResult.data);
};

export const inviteRentalAdmin = async (actor, companyId, payload = {}) => {
  requireCentralAdmin(actor, 'Hanya Admin Pusat yang dapat mengundang Admin Rental.');
  const name = String(payload.name || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    const error = new Error('Email Admin Rental tidak valid.');
    error.status = 400;
    throw error;
  }
  const company = supabase
    ? null
    : getCompany(companyId);
  if (!supabase && !company) {
    const error = new Error('Perusahaan rental tidak ditemukan.');
    error.status = 404;
    throw error;
  }

  if (supabase) {
    const inviteResult = await supabase.auth.admin.inviteUserByEmail(email, {
      data: {
        name: name || email.split('@')[0],
        role: 'RENTAL_ADMIN',
        company_id: companyId
      }
    });
    if (inviteResult.error || !inviteResult.data?.user) {
      const error = new Error(`Gagal mengirim undangan Admin Rental: ${inviteResult.error?.message || 'User tidak dibuat.'}`);
      error.status = inviteResult.error?.status || 502;
      throw error;
    }
    const profileResult = await supabase
      .from('profiles')
      .upsert({
        id: inviteResult.data.user.id,
        name: name || email.split('@')[0],
        email,
        role: 'RENTAL_ADMIN',
        company_id: companyId,
        branch_id: null,
        verification_status: 'VERIFIED',
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' })
      .select(profileSelect)
      .single();
    throwSupabaseError('Gagal menyiapkan profile Admin Rental', profileResult.error);
    return {
      invitationStatus: 'SENT',
      email,
      companyId,
      user: mapDbProfile(profileResult.data)
    };
  }

  if (findUserByEmail(email)) {
    const error = new Error('Email Admin Rental sudah terdaftar.');
    error.status = 409;
    throw error;
  }
  const temporaryPassword = `tr-${Math.random().toString(36).slice(2, 10)}`;
  const user = {
    id: makeId('usr'),
    email,
    password: temporaryPassword,
    name: name || email.split('@')[0],
    role: 'RENTAL_ADMIN',
    companyId,
    branchId: null,
    verificationStatus: 'VERIFIED',
    accountStatus: 'INVITED'
  };
  demoState.users.push(user);
  return {
    invitationStatus: 'DEMO_TEMPORARY_PASSWORD',
    email,
    companyId,
    temporaryPassword,
    user: getPublicUser(user)
  };
};

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
  if (!vehicle || vehicle.status === 'MAINTENANCE' || vehicle.gpsStatus !== 'READY') return false;
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
    .select('id,company_id,branch_id,gps_device_id,name,type,transmission,seats,year,plate_number,price_per_day,deposit_amount,status,gps_status,image_url')
    .eq('status', 'AVAILABLE')
    .eq('gps_status', 'READY');
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
  created_at
`;

const vehicleSelect = 'id,company_id,branch_id,gps_device_id,name,type,transmission,seats,year,plate_number,price_per_day,deposit_amount,status,gps_status,image_url';

const paymentSelect = 'id,reservation_id,provider,provider_reference,amount,status,paid_at,created_at';

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
    queryByIds('profiles', profileSelect, customerIds)
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
    createdAt: row.created_at,
    branch,
    company,
    vehicle: vehicle ? mapDbVehicle(vehicle, branch, company) : null,
    customer: customer ? mapDbProfile(customer) : null
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
      customer: getPublicUser(getUser(reservation.customerId))
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
  status: row.status === 'APPROVED' ? 'APPROVED_SIMULATED' : row.status,
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
    queryByIds('profiles', profileSelect, customerIds),
    queryByColumn('fines', 'id,rental_id,amount,status,damage_items,created_at', 'rental_id', rentalIds),
    queryByColumn('refunds', 'id,rental_id,amount,status,confirmed_by,created_at,confirmed_at', 'rental_id', rentalIds),
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

  return {
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
    createdAt: row.created_at,
    vehicle: vehicle ? mapDbVehicle(vehicle, branch, company) : null,
    branch,
    company,
    customer: customer ? mapDbProfile(customer) : null,
    reservation: reservation ? mapDbReservation(reservation, {
      vehicles: context.vehicles,
      branches: context.branches,
      companies: context.companies,
      customers: context.customers
    }) : null,
    fine: context.fines.get(row.id) || null,
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
    customer: getPublicUser(getUser(rental.customerId)),
    reservation: demoState.reservations.find((item) => item.id === rental.reservationId),
    fine: demoState.fines.find((item) => item.rentalId === rental.id) || null,
    refund: demoState.refunds.find((item) => item.rentalId === rental.id) || null,
    latestLocation: [...demoState.locations].filter((item) => item.vehicleId === rental.vehicleId).sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))[0] || null
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
  return rows.map((row) => mapDbRental(row, context));
};

export const listRentals = (actor) => (
  supabase ? listRentalsFromSupabase(actor) : listRentalsDemo(actor)
);

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
  if (actor.role !== 'CUSTOMER') {
    const error = new Error('Hanya customer yang dapat membuat reservasi.');
    error.status = 403;
    throw error;
  }

  const profileResult = await supabase
    .from('profiles')
    .select('verification_status')
    .eq('id', actor.id)
    .maybeSingle();
  throwSupabaseError('Gagal membaca status verifikasi customer', profileResult.error);

  if (profileResult.data?.verification_status !== 'VERIFIED') {
    const error = new Error(
      'Akun customer belum terverifikasi. Reservasi belum dapat dibuat.'
    );
    error.status = 403;
    throw error;
  }

  if (
    !payload.startDate
    || !payload.endDate
    || dateOnly(payload.endDate) <= dateOnly(payload.startDate)
  ) {
    const error = new Error('Periode rental tidak valid.');
    error.status = 400;
    throw error;
  }

  const vehicleResult = await supabase
    .from('vehicles')
    .select(vehicleSelect)
    .eq('id', payload.vehicleId)
    .maybeSingle();
  throwSupabaseError('Gagal membaca kendaraan', vehicleResult.error);

  const vehicle = vehicleResult.data;
  if (!vehicle) {
    const error = new Error('Kendaraan tidak ditemukan.');
    error.status = 404;
    throw error;
  }

  if (vehicle.status !== 'AVAILABLE' || vehicle.gps_status !== 'READY') {
    const error = new Error(
      'Kendaraan tidak tersedia atau GPS belum siap.'
    );
    error.status = 409;
    throw error;
  }

  const [branchResult, companyResult, deviceResult] = await Promise.all([
    supabase
      .from('branches')
      .select('id,company_id,name,address,phone,location')
      .eq('id', vehicle.branch_id)
      .maybeSingle(),
    supabase
      .from('rental_companies')
      .select('id,name,legal_name,email,phone,description,status,delivery_radius_km')
      .eq('id', vehicle.company_id)
      .maybeSingle(),
    vehicle.gps_device_id
      ? supabase.from('gps_devices').select('id,status').eq('id', vehicle.gps_device_id).maybeSingle()
      : Promise.resolve({ data: null, error: null })
  ]);

  throwSupabaseError('Gagal membaca cabang', branchResult.error);
  throwSupabaseError('Gagal membaca perusahaan rental', companyResult.error);
  throwSupabaseError('Gagal membaca GPS device', deviceResult.error);

  const branch = branchResult.data ? mapDbBranch(branchResult.data) : null;
  const company = companyResult.data ? mapDbCompany(companyResult.data) : null;

  if (!branch || !company) {
    const error = new Error('Cabang atau perusahaan kendaraan tidak ditemukan.');
    error.status = 404;
    throw error;
  }

  const gpsAgreement = await getActiveGpsAgreement(vehicle.company_id);
  if (!gpsAgreement) {
    const error = new Error('Perusahaan rental belum memiliki MoU GPS aktif. Kendaraan belum dapat dipesan.');
    error.status = 409;
    error.code = 'GPS_AGREEMENT_REQUIRED';
    throw error;
  }

  if (deviceResult.data?.status !== 'READY') {
    const error = new Error('GPS kendaraan belum berstatus READY.');
    error.status = 409;
    throw error;
  }

  const [reservationConflict, rentalConflict, maintenanceConflict] = await Promise.all([
    supabase
      .from('reservations')
      .select('id')
      .eq('vehicle_id', vehicle.id)
      .in('status', ['PENDING_PAYMENT', 'CONFIRMED', 'RENTED'])
      .lt('start_date', payload.endDate)
      .gt('end_date', payload.startDate),
    supabase
      .from('rentals')
      .select('id')
      .eq('vehicle_id', vehicle.id)
      .in('status', ['SCHEDULED', 'ACTIVE', 'RETURN_PENDING_REVIEW'])
      .lt('start_date', payload.endDate)
      .gt('end_date', payload.startDate),
    supabase
      .from('maintenances')
      .select('id')
      .eq('vehicle_id', vehicle.id)
      .in('status', ['SCHEDULED', 'IN_PROGRESS'])
  ]);

  throwSupabaseError('Gagal memeriksa bentrok reservasi', reservationConflict.error);
  throwSupabaseError('Gagal memeriksa rental aktif', rentalConflict.error);
  throwSupabaseError('Gagal memeriksa maintenance', maintenanceConflict.error);

  if (
    (reservationConflict.data || []).length > 0
    || (rentalConflict.data || []).length > 0
    || (maintenanceConflict.data || []).length > 0
  ) {
    const error = new Error(
      'Kendaraan sudah tidak tersedia pada periode tersebut.'
    );
    error.status = 409;
    throw error;
  }

  const pickupMode = payload.pickupMode === 'DELIVERY' ? 'DELIVERY' : 'PICKUP';
  let deliveryDistanceKm = null;
  let deliveryLocation = null;

  if (pickupMode === 'DELIVERY') {
    const deliveryLatitude = Number(payload.deliveryLatitude);
    const deliveryLongitude = Number(payload.deliveryLongitude);
    deliveryDistanceKm = haversineKm(
      deliveryLatitude,
      deliveryLongitude,
      branch.latitude,
      branch.longitude
    );

    const radius = company.deliveryRadiusKm || DELIVERY_RADIUS_KM;
    if (!Number.isFinite(deliveryDistanceKm) || deliveryDistanceKm > radius) {
      const error = new Error(
        `Lokasi delivery harus berada maksimal ${radius} km dari cabang.`
      );
      error.status = 400;
      throw error;
    }

    if (!payload.deliveryAddress || !payload.recipientPhone) {
      const error = new Error(
        'Alamat delivery dan nomor penerima wajib diisi.'
      );
      error.status = 400;
      throw error;
    }

    deliveryLocation = `SRID=4326;POINT(${deliveryLongitude} ${deliveryLatitude})`;
  }

  const days = rentalDays(payload.startDate, payload.endDate);
  const rentalAmount = Number(vehicle.price_per_day || 0) * days;
  const depositAmount = Number(vehicle.deposit_amount || 0);
  const now = new Date().toISOString();

  const insertPayload = {
    customer_id: actor.id,
    company_id: vehicle.company_id,
    branch_id: vehicle.branch_id,
    vehicle_id: vehicle.id,
    start_date: payload.startDate,
    end_date: payload.endDate,
    pickup_mode: pickupMode,
    delivery_address: pickupMode === 'DELIVERY' ? payload.deliveryAddress : null,
    delivery_location: deliveryLocation,
    recipient_phone: pickupMode === 'DELIVERY' ? payload.recipientPhone : null,
    delivery_notes: pickupMode === 'DELIVERY' ? payload.deliveryNotes || null : null,
    delivery_distance_km: deliveryDistanceKm === null ? null : Number(deliveryDistanceKm.toFixed(2)),
    rental_days: days,
    rental_amount: rentalAmount,
    deposit_amount: depositAmount,
    total_amount: rentalAmount + depositAmount,
    status: 'PENDING_PAYMENT',
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    created_at: now
  };

  const { data, error } = await supabase
    .from('reservations')
    .insert(insertPayload)
    .select(reservationSelect)
    .single();

  throwSupabaseError('Gagal membuat reservasi', error);

  const context = await loadReservationContext([data]);
  return mapDbReservation(data, context);
};

export const createReservation = (actor, payload) => (
  supabase
    ? createReservationFromSupabase(actor, payload)
    : createReservationDemo(actor, payload)
);

const simulatePaymentDemo = (actor, reservationId) => {
  const reservation = demoState.reservations.find((item) => item.id === reservationId);
  if (!reservation || (actor.role === 'CUSTOMER' && reservation.customerId !== actor.id)) {
    const error = new Error('Reservasi tidak ditemukan.');
    error.status = 404;
    throw error;
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
  reservation.status = 'CONFIRMED';
  reservation.paidAt = new Date().toISOString();
  const paymentRecord = createPaymentRecord({
    reservationId,
    amount: reservation.totalAmount
  });
  const payment = {
    id: makeId('pay'),
    reservationId,
    provider: paymentRecord.provider,
    amount: paymentRecord.amount,
    status: paymentRecord.status,
    paidAt: paymentRecord.paidAt
  };
  demoState.payments.push(payment);
  return { reservation, payment };
};

const simulatePaymentFromSupabase = async (actor, reservationId) => {
  const reservationResult = await supabase
    .from('reservations')
    .select(reservationSelect)
    .eq('id', reservationId)
    .maybeSingle();
  throwSupabaseError('Gagal membaca reservasi', reservationResult.error);

  const reservation = reservationResult.data;
  if (!reservation) {
    const error = new Error('Reservasi tidak ditemukan.');
    error.status = 404;
    throw error;
  }

  if (
    actor.role === 'CUSTOMER'
    && reservation.customer_id !== actor.id
  ) {
    const error = new Error('Reservasi tidak ditemukan.');
    error.status = 404;
    throw error;
  }

  if (
    actor.role !== 'CUSTOMER'
    && actor.role !== 'CENTRAL_ADMIN'
    && actor.companyId !== reservation.company_id
  ) {
    const error = new Error('Akses reservasi tidak diizinkan.');
    error.status = 403;
    throw error;
  }

  if (reservation.status !== 'PENDING_PAYMENT') {
    const error = new Error(
      'Reservasi tidak sedang menunggu pembayaran.'
    );
    error.status = 409;
    throw error;
  }

  if (reservation.expires_at && new Date(reservation.expires_at) <= new Date()) {
    await supabase
      .from('reservations')
      .update({ status: 'EXPIRED' })
      .eq('id', reservation.id);

    const error = new Error('Batas pembayaran sudah berakhir.');
    error.status = 409;
    throw error;
  }

  const paymentRecord = createPaymentRecord({
    reservationId: reservation.id,
    amount: reservation.total_amount
  });
  const { paidAt, ...paymentInsert } = paymentRecord;
  const paymentResult = await supabase
    .from('payments')
    .insert(paymentInsert)
    .select(paymentSelect)
    .single();

  throwSupabaseError('Gagal menyimpan pembayaran simulasi', paymentResult.error);

  const updatedReservationResult = await supabase
    .from('reservations')
    .update({
      status: 'CONFIRMED',
      paid_at: paidAt
    })
    .eq('id', reservation.id)
    .select(reservationSelect)
    .single();

  throwSupabaseError(
    'Gagal mengonfirmasi reservasi',
    updatedReservationResult.error
  );

  const context = await loadReservationContext([updatedReservationResult.data]);
  return {
    reservation: mapDbReservation(updatedReservationResult.data, context),
    payment: {
      id: paymentResult.data.id,
      reservationId: paymentResult.data.reservation_id,
      provider: paymentResult.data.provider,
      providerReference: paymentResult.data.provider_reference,
      amount: Number(paymentResult.data.amount || 0),
      status: paymentResult.data.status,
      paidAt: paymentResult.data.paid_at,
      createdAt: paymentResult.data.created_at
    }
  };
};

export const simulatePayment = (actor, reservationId) => (
  supabase
    ? simulatePaymentFromSupabase(actor, reservationId)
    : simulatePaymentDemo(actor, reservationId)
);

const assertCompanyAccess = (actor, companyId) => {
  if (actor.role !== 'CENTRAL_ADMIN' && actor.companyId !== companyId) {
    const error = new Error('Akses lintas perusahaan tidak diizinkan.');
    error.status = 403;
    throw error;
  }
};

const handoverDemo = (actor, reservationId, payload = {}) => {
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
  const vehicle = getVehicle(reservation.vehicleId);
  if (vehicle.gpsStatus !== 'READY' || vehicle.status === 'MAINTENANCE') {
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

const createSupabaseInspection = async ({ rentalId, type, actor, payload }) => {
  const [customerSignaturePath, staffPhotos, customerPhotos] = await Promise.all([
    uploadDataUrl(payload.customerSignature, {
      folder: `inspections/${type.toLowerCase()}/signatures`,
      ownerId: rentalId,
      fileName: 'customer-signature'
    }),
    uploadDataUrls(payload.staffPhotos, {
      folder: `inspections/${type.toLowerCase()}/staff`,
      ownerId: rentalId,
      fileName: 'photo'
    }),
    uploadDataUrls(payload.customerPhotos, {
      folder: `inspections/${type.toLowerCase()}/customer`,
      ownerId: rentalId,
      fileName: 'photo'
    })
  ]);

  const { data, error } = await supabase
    .from('inspections')
    .insert({
      rental_id: rentalId,
      type,
      staff_id: actor.id,
      customer_signature_path: customerSignaturePath || null,
      notes: payload.notes || null,
      submitted_at: new Date().toISOString()
    })
    .select('id,rental_id,type,staff_id,customer_signature_path,notes,submitted_at,reviewed_at')
    .single();

  throwSupabaseError(`Gagal menyimpan inspeksi ${type}`, error);

  const checklist = Array.isArray(payload.staffChecklist)
    ? payload.staffChecklist.map((item) => ({
      inspection_id: data.id,
      item_key: item,
      condition: 'OK',
      notes: null
    }))
    : [];

  if (checklist.length > 0) {
    const itemsResult = await supabase
      .from('inspection_items')
      .insert(checklist)
      .select('id,inspection_id,item_key,condition,notes');
    throwSupabaseError(`Gagal menyimpan checklist inspeksi ${type}`, itemsResult.error);
  }

  const photos = [
    ...staffPhotos.map((photo) => ({
      inspection_id: data.id,
      source: 'STAFF',
      storage_path: photo
    })),
    ...customerPhotos.map((photo) => ({
      inspection_id: data.id,
      source: 'CUSTOMER',
      storage_path: photo
    }))
  ];

  if (photos.length > 0) {
    const photosResult = await supabase
      .from('inspection_photos')
      .insert(photos)
      .select('id,inspection_id,source,storage_path,created_at');
    throwSupabaseError(`Gagal menyimpan foto inspeksi ${type}`, photosResult.error);
  }

  return {
    id: data.id,
    rentalId: data.rental_id,
    type: data.type,
    staffId: data.staff_id,
    customerSignature: data.customer_signature_path,
    notes: data.notes,
    submittedAt: data.submitted_at,
    reviewedAt: data.reviewed_at,
    staffChecklist: checklist.map((item) => item.item_key),
    staffPhotos,
    customerPhotos
  };
};

const handoverFromSupabase = async (actor, reservationId, payload = {}) => {
  if (!['STAFF', 'RENTAL_ADMIN', 'CENTRAL_ADMIN'].includes(actor.role)) {
    const error = new Error('Role tidak dapat melakukan handover.');
    error.status = 403;
    throw error;
  }

  const reservationResult = await supabase
    .from('reservations')
    .select(reservationSelect)
    .eq('id', reservationId)
    .maybeSingle();
  throwSupabaseError('Gagal membaca reservasi handover', reservationResult.error);

  const reservation = reservationResult.data;
  if (!reservation) {
    const error = new Error('Reservasi tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  assertCompanyAccess(actor, reservation.company_id);

  if (reservation.status !== 'CONFIRMED') {
    const error = new Error('Reservasi belum siap untuk handover.');
    error.status = 409;
    throw error;
  }

  const vehicleResult = await supabase
    .from('vehicles')
    .select(vehicleSelect)
    .eq('id', reservation.vehicle_id)
    .maybeSingle();
  throwSupabaseError('Gagal membaca kendaraan handover', vehicleResult.error);

  const vehicle = vehicleResult.data;
  if (!vehicle || vehicle.status === 'MAINTENANCE' || vehicle.gps_status !== 'READY') {
    const error = new Error(
      'Kendaraan tidak dapat handover karena GPS tidak siap atau kendaraan maintenance.'
    );
    error.status = 409;
    throw error;
  }

  const gpsAgreement = await getActiveGpsAgreement(reservation.company_id);
  if (!gpsAgreement) {
    const error = new Error('Perusahaan rental belum memiliki MoU GPS aktif. Handover tidak dapat dilakukan.');
    error.status = 409;
    error.code = 'GPS_AGREEMENT_REQUIRED';
    throw error;
  }

  const now = new Date().toISOString();
  const rentalResult = await supabase
    .from('rentals')
    .insert({
      reservation_id: reservation.id,
      customer_id: reservation.customer_id,
      company_id: reservation.company_id,
      branch_id: reservation.branch_id,
      vehicle_id: reservation.vehicle_id,
      start_date: reservation.start_date,
      end_date: reservation.end_date,
      status: 'ACTIVE',
      handover_at: now,
      created_at: now
    })
    .select(rentalSelect)
    .single();
  throwSupabaseError('Gagal membuat rental', rentalResult.error);

  const reservationUpdate = await supabase
    .from('reservations')
    .update({ status: 'RENTED' })
    .eq('id', reservation.id);
  throwSupabaseError('Gagal memperbarui status reservasi', reservationUpdate.error);

  const vehicleUpdate = await supabase
    .from('vehicles')
    .update({ status: 'RENTED' })
    .eq('id', vehicle.id);
  throwSupabaseError('Gagal memperbarui status kendaraan', vehicleUpdate.error);

  const inspection = await createSupabaseInspection({
    rentalId: rentalResult.data.id,
    type: 'BEFORE',
    actor,
    payload
  });

  return {
    rental: {
      id: rentalResult.data.id,
      reservationId: rentalResult.data.reservation_id,
      customerId: rentalResult.data.customer_id,
      companyId: rentalResult.data.company_id,
      branchId: rentalResult.data.branch_id,
      vehicleId: rentalResult.data.vehicle_id,
      startDate: rentalResult.data.start_date,
      endDate: rentalResult.data.end_date,
      status: rentalResult.data.status,
      handoverAt: rentalResult.data.handover_at,
      createdAt: rentalResult.data.created_at
    },
    inspection
  };
};

export const handover = (actor, reservationId, payload = {}) => (
  supabase
    ? handoverFromSupabase(actor, reservationId, payload)
    : handoverDemo(actor, reservationId, payload)
);

const computeFine = (rental, payload) => {
  const items = Array.isArray(payload.damageItems) ? payload.damageItems : [];
  const damageTotal = items.reduce((total, item) => total + Number(item.amount || 0), 0);
  const actualReturnDate = payload.actualReturnDate || rental.endDate;
  const lateDays = Math.max(0, rentalDays(rental.endDate, actualReturnDate) - 1);
  const vehicle = getVehicle(rental.vehicleId);
  const lateTotal = lateDays * Math.round(vehicle.pricePerDay * 0.25);
  return { items, damageTotal, lateDays, lateTotal, total: damageTotal + lateTotal };
};

const returnRentalDemo = (actor, rentalId, payload = {}) => {
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
  demoState.inspections.push(inspection);
  const fine = computeFine(rental, payload);
  if (fine.total > 0) {
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
  rental.returnMethod = payload.returnMethod || 'SELF_RETURN';
  rental.returnSchedule = payload.returnSchedule || null;
  const vehicle = getVehicle(rental.vehicleId);
  vehicle.status = 'RETURN_INSPECTION';
  const refundAmount = Math.max(0, (reservation?.depositAmount || 0) - fine.total);
  demoState.refunds.push({
    id: makeId('refund'),
    rentalId: rental.id,
    amount: refundAmount,
    status: 'PENDING_CONFIRMATION',
    createdAt: new Date().toISOString()
  });
  return { rental, inspection, fine, refundAmount };
};

const computeSupabaseFine = (vehicle, rental, payload) => {
  const items = Array.isArray(payload.damageItems) ? payload.damageItems : [];
  const damageTotal = items.reduce(
    (total, item) => total + Number(item.amount || 0),
    0
  );
  const actualReturnDate = payload.actualReturnDate || rental.end_date;
  const endDate = dateOnly(rental.end_date);
  const actualDate = dateOnly(actualReturnDate);
  const lateDays = Math.max(
    0,
    Math.ceil((actualDate.getTime() - endDate.getTime()) / 86_400_000)
  );
  const lateTotal = lateDays * Math.round(Number(vehicle.price_per_day || 0) * 0.25);

  return {
    items,
    damageTotal,
    lateDays,
    lateTotal,
    total: damageTotal + lateTotal
  };
};

const returnRentalFromSupabase = async (actor, rentalId, payload = {}) => {
  if (!['STAFF', 'RENTAL_ADMIN', 'CENTRAL_ADMIN'].includes(actor.role)) {
    const error = new Error('Role tidak dapat melakukan return.');
    error.status = 403;
    throw error;
  }

  const rentalResult = await supabase
    .from('rentals')
    .select(rentalSelect)
    .eq('id', rentalId)
    .maybeSingle();
  throwSupabaseError('Gagal membaca rental return', rentalResult.error);

  const rental = rentalResult.data;
  if (!rental) {
    const error = new Error('Rental tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  assertCompanyAccess(actor, rental.company_id);

  if (rental.status !== 'ACTIVE') {
    const error = new Error('Rental tidak sedang aktif.');
    error.status = 409;
    throw error;
  }

  const [vehicleResult, reservationResult] = await Promise.all([
    supabase
      .from('vehicles')
      .select(vehicleSelect)
      .eq('id', rental.vehicle_id)
      .maybeSingle(),
    supabase
      .from('reservations')
      .select(reservationSelect)
      .eq('id', rental.reservation_id)
      .maybeSingle()
  ]);

  throwSupabaseError('Gagal membaca kendaraan return', vehicleResult.error);
  throwSupabaseError('Gagal membaca reservasi return', reservationResult.error);

  if (!vehicleResult.data || !reservationResult.data) {
    const error = new Error('Data kendaraan atau reservasi tidak ditemukan.');
    error.status = 404;
    throw error;
  }

  const now = new Date().toISOString();
  const inspection = await createSupabaseInspection({
    rentalId,
    type: 'AFTER',
    actor,
    payload
  });
  const fine = computeSupabaseFine(vehicleResult.data, rental, payload);

  let fineRow = null;
  if (fine.total > 0) {
    const fineResult = await supabase
      .from('fines')
      .insert({
        rental_id: rental.id,
        amount: fine.total,
        status: 'ISSUED',
        damage_items: fine.items,
        created_at: now
      })
      .select('id,rental_id,amount,status,damage_items,created_at')
      .single();
    throwSupabaseError('Gagal menyimpan denda', fineResult.error);
    fineRow = mapDbFine(fineResult.data);
  }

  const rentalUpdate = await supabase
    .from('rentals')
    .update({
      status: 'RETURN_PENDING_REVIEW',
      returned_at: now,
      return_method: payload.returnMethod || 'SELF_RETURN',
      return_schedule: payload.returnSchedule || null
    })
    .eq('id', rental.id)
    .select(rentalSelect)
    .single();
  throwSupabaseError('Gagal memperbarui status rental return', rentalUpdate.error);

  const vehicleUpdate = await supabase
    .from('vehicles')
    .update({ status: 'RETURN_INSPECTION' })
    .eq('id', vehicleResult.data.id);
  throwSupabaseError('Gagal memperbarui status kendaraan return', vehicleUpdate.error);

  const refundAmount = Math.max(
    0,
    Number(reservationResult.data.deposit_amount || 0) - fine.total
  );
  const refundResult = await supabase
    .from('refunds')
    .upsert({
      rental_id: rental.id,
      amount: refundAmount,
      status: 'PENDING_CONFIRMATION',
      created_at: now
    }, { onConflict: 'rental_id' })
    .select('id,rental_id,amount,status,confirmed_by,created_at,confirmed_at')
    .single();
  throwSupabaseError('Gagal menyimpan refund', refundResult.error);

  return {
    rental: {
      id: rentalUpdate.data.id,
      reservationId: rentalUpdate.data.reservation_id,
      customerId: rentalUpdate.data.customer_id,
      companyId: rentalUpdate.data.company_id,
      branchId: rentalUpdate.data.branch_id,
      vehicleId: rentalUpdate.data.vehicle_id,
      startDate: rentalUpdate.data.start_date,
      endDate: rentalUpdate.data.end_date,
      status: rentalUpdate.data.status,
      returnedAt: rentalUpdate.data.returned_at,
      returnMethod: rentalUpdate.data.return_method,
      returnSchedule: rentalUpdate.data.return_schedule,
      createdAt: rentalUpdate.data.created_at
    },
    inspection,
    fine: fineRow || {
      amount: 0,
      total: 0,
      items: [],
      lateDays: fine.lateDays
    },
    refundAmount,
    refund: mapDbRefund(refundResult.data)
  };
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
  rental.status = 'COMPLETED';
  rental.completedAt = new Date().toISOString();
  vehicle.status = 'AVAILABLE';
  if (refund) {
    refund.status = 'APPROVED_SIMULATED';
    refund.confirmedAt = new Date().toISOString();
  }
  return { rental, refund };
};

const confirmRefundFromSupabase = async (actor, rentalId) => {
  if (!['RENTAL_ADMIN', 'CENTRAL_ADMIN'].includes(actor.role)) {
    const error = new Error(
      'Hanya Admin Rental yang dapat mengonfirmasi refund.'
    );
    error.status = 403;
    throw error;
  }

  const rentalResult = await supabase
    .from('rentals')
    .select(rentalSelect)
    .eq('id', rentalId)
    .maybeSingle();
  throwSupabaseError('Gagal membaca rental refund', rentalResult.error);

  const rental = rentalResult.data;
  if (!rental) {
    const error = new Error('Rental tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  assertCompanyAccess(actor, rental.company_id);

  const [refundResult, fineResult] = await Promise.all([
    supabase
      .from('refunds')
      .select('id,rental_id,amount,status,confirmed_by,created_at,confirmed_at')
      .eq('rental_id', rental.id)
      .maybeSingle(),
    supabase
      .from('fines')
      .select('id,rental_id,amount,status,damage_items,created_at')
      .eq('rental_id', rental.id)
      .order('created_at', { ascending: false })
      .limit(1)
  ]);

  throwSupabaseError('Gagal membaca refund', refundResult.error);
  throwSupabaseError('Gagal membaca denda refund', fineResult.error);

  if (!refundResult.data) {
    const error = new Error('Refund belum tersedia untuk rental ini.');
    error.status = 409;
    throw error;
  }

  const now = new Date().toISOString();
  const refundUpdate = await supabase
    .from('refunds')
    .update({
      status: 'APPROVED',
      confirmed_by: actor.id,
      confirmed_at: now
    })
    .eq('id', refundResult.data.id)
    .select('id,rental_id,amount,status,confirmed_by,created_at,confirmed_at')
    .single();
  throwSupabaseError('Gagal mengonfirmasi refund', refundUpdate.error);

  const hasDamage = Boolean(
    fineResult.data?.[0]?.damage_items
    && fineResult.data[0].damage_items.length > 0
  );
  const vehicleStatus = hasDamage ? 'MAINTENANCE' : 'AVAILABLE';

  const rentalUpdate = await supabase
    .from('rentals')
    .update({
      status: 'COMPLETED',
      completed_at: now
    })
    .eq('id', rental.id)
    .select(rentalSelect)
    .single();
  throwSupabaseError('Gagal menyelesaikan rental', rentalUpdate.error);

  const vehicleUpdate = await supabase
    .from('vehicles')
    .update({ status: vehicleStatus })
    .eq('id', rental.vehicle_id);
  throwSupabaseError('Gagal memperbarui status kendaraan setelah refund', vehicleUpdate.error);

  return {
    rental: {
      id: rentalUpdate.data.id,
      reservationId: rentalUpdate.data.reservation_id,
      customerId: rentalUpdate.data.customer_id,
      companyId: rentalUpdate.data.company_id,
      branchId: rentalUpdate.data.branch_id,
      vehicleId: rentalUpdate.data.vehicle_id,
      startDate: rentalUpdate.data.start_date,
      endDate: rentalUpdate.data.end_date,
      status: rentalUpdate.data.status,
      completedAt: rentalUpdate.data.completed_at
    },
    refund: mapDbRefund(refundUpdate.data),
    vehicleStatus
  };
};

export const confirmRefund = (actor, rentalId) => (
  supabase
    ? confirmRefundFromSupabase(actor, rentalId)
    : confirmRefundDemo(actor, rentalId)
);

const submitDisputeDemo = (actor, fineId, payload) => {
  const fine = demoState.fines.find((item) => item.id === fineId);
  const rental = fine && demoState.rentals.find((item) => item.id === fine.rentalId);
  if (!fine || !rental || rental.customerId !== actor.id) {
    const error = new Error('Denda tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  fine.status = 'DISPUTED';
  const dispute = {
    id: makeId('dispute'),
    fineId,
    customerId: actor.id,
    reason: payload.reason || '',
    status: 'OPEN',
    createdAt: new Date().toISOString()
  };
  demoState.disputes.push(dispute);
  return dispute;
};

const submitDisputeFromSupabase = async (actor, fineId, payload = {}) => {
  if (actor.role !== 'CUSTOMER') {
    const error = new Error('Hanya customer yang dapat mengajukan keberatan.');
    error.status = 403;
    throw error;
  }

  const fineResult = await supabase
    .from('fines')
    .select('id,rental_id,amount,status,damage_items,created_at')
    .eq('id', fineId)
    .maybeSingle();
  throwSupabaseError('Gagal membaca denda', fineResult.error);

  if (!fineResult.data) {
    const error = new Error('Denda tidak ditemukan.');
    error.status = 404;
    throw error;
  }

  const rentalResult = await supabase
    .from('rentals')
    .select('id,customer_id')
    .eq('id', fineResult.data.rental_id)
    .maybeSingle();
  throwSupabaseError('Gagal membaca rental denda', rentalResult.error);

  if (!rentalResult.data || rentalResult.data.customer_id !== actor.id) {
    const error = new Error('Denda tidak ditemukan.');
    error.status = 404;
    throw error;
  }

  const disputeResult = await supabase
    .from('fine_disputes')
    .insert({
      fine_id: fineId,
      customer_id: actor.id,
      reason: payload.reason || '',
      status: 'OPEN'
    })
    .select('id,fine_id,customer_id,reason,status,created_at,resolved_at')
    .single();
  throwSupabaseError('Gagal menyimpan keberatan denda', disputeResult.error);

  const fineUpdate = await supabase
    .from('fines')
    .update({ status: 'DISPUTED' })
    .eq('id', fineId);
  throwSupabaseError('Gagal memperbarui status denda', fineUpdate.error);

  const dispute = disputeResult.data;
  return {
    id: dispute.id,
    fineId: dispute.fine_id,
    customerId: dispute.customer_id,
    reason: dispute.reason,
    status: dispute.status,
    createdAt: dispute.created_at,
    resolvedAt: dispute.resolved_at
  };
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

const listLocationsDemo = (actor, vehicleId) => {
  const vehicle = getVehicle(vehicleId);
  if (!vehicle) {
    const error = new Error('Kendaraan tidak ditemukan.');
    error.status = 404;
    throw error;
  }
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
  return demoState.locations.filter((location) => location.vehicleId === vehicleId).sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
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

  if (actor.role === 'CUSTOMER') {
    const rentalResult = await supabase
      .from('rentals')
      .select('id')
      .eq('vehicle_id', vehicleId)
      .eq('customer_id', actor.id)
      .eq('status', 'ACTIVE')
      .limit(1);
    throwSupabaseError('Gagal memeriksa akses tracking customer', rentalResult.error);
    if ((rentalResult.data || []).length === 0) {
      const error = new Error(
        'Customer hanya dapat melihat GPS rental aktif miliknya.'
      );
      error.status = 403;
      throw error;
    }
  } else {
    assertCompanyAccess(actor, vehicle.company_id);
  }

  const locationsResult = await supabase
    .from('vehicle_locations')
    .select('id,vehicle_id,rental_id,location,speed,heading,recorded_at')
    .eq('vehicle_id', vehicleId)
    .order('recorded_at', { ascending: true });
  throwSupabaseError('Gagal membaca histori lokasi', locationsResult.error);

  return (locationsResult.data || []).map(mapDbLocation);
};

export const listLocations = (actor, vehicleId) => (
  supabase
    ? listLocationsFromSupabase(actor, vehicleId)
    : listLocationsDemo(actor, vehicleId)
);

const trackingVehiclesDemo = (actor) => listRentalsDemo(actor)
  .filter((rental) => rental.status === 'ACTIVE')
  .map((rental) => ({
    rentalId: rental.id,
    vehicle: rental.vehicle,
    customer: rental.customer,
    latestLocation: rental.latestLocation
  }));

const trackingVehiclesFromSupabase = async (actor) => {
  const rentals = await listRentalsFromSupabase(actor);
  return rentals
    .filter((rental) => rental.status === 'ACTIVE')
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

const ingestLocationDemo = ({ deviceId, latitude, longitude, speed = 0, heading = 0 }) => {
  const vehicle = demoState.vehicles.find((item) => item.gpsDeviceId === deviceId);
  if (!vehicle) {
    const error = new Error('GPS device tidak terdaftar.');
    error.status = 404;
    throw error;
  }
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
    .select('id,gps_status')
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

  const recordedAt = new Date().toISOString();
  const locationResult = await supabase
    .from('vehicle_locations')
    .insert({
      vehicle_id: vehicle.id,
      rental_id: activeRental.id,
      location: `SRID=4326;POINT(${lng} ${lat})`,
      speed: Number(speed || 0),
      heading: Number(heading || 0),
      recorded_at: recordedAt
    })
    .select('id,vehicle_id,rental_id,location,speed,heading,recorded_at')
    .single();
  throwSupabaseError('Gagal menyimpan lokasi GPS', locationResult.error);

  const deviceUpdate = await supabase
    .from('gps_devices')
    .update({ last_seen_at: recordedAt })
    .eq('id', device.id);
  throwSupabaseError('Gagal memperbarui waktu GPS', deviceUpdate.error);

  return mapDbLocation(locationResult.data);
};

export const ingestLocation = (payload) => (
  supabase
    ? ingestLocationFromSupabase(payload)
    : ingestLocationDemo(payload)
);

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

const createMaintenanceFromSupabase = async (actor, payload) => {
  if (!['RENTAL_ADMIN', 'CENTRAL_ADMIN'].includes(actor.role)) {
    const error = new Error('Role tidak dapat membuat maintenance.');
    error.status = 403;
    throw error;
  }

  const vehicleResult = await supabase
    .from('vehicles')
    .select(vehicleSelect)
    .eq('id', payload.vehicleId)
    .maybeSingle();
  throwSupabaseError('Gagal membaca kendaraan maintenance', vehicleResult.error);

  const vehicle = vehicleResult.data;
  if (!vehicle) {
    const error = new Error('Kendaraan tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  assertCompanyAccess(actor, vehicle.company_id);

  const now = new Date().toISOString();
  const maintenanceResult = await supabase
    .from('maintenances')
    .insert({
      company_id: vehicle.company_id,
      branch_id: vehicle.branch_id,
      vehicle_id: vehicle.id,
      type: payload.type || 'SERVICE',
      title: payload.title || 'Maintenance kendaraan',
      status: 'SCHEDULED',
      scheduled_at: payload.scheduledAt || now,
      notes: payload.notes || null,
      created_at: now
    })
    .select('id,company_id,branch_id,vehicle_id,type,title,status,scheduled_at,completed_at,notes,created_at')
    .single();
  throwSupabaseError('Gagal membuat maintenance', maintenanceResult.error);

  const vehicleUpdate = await supabase
    .from('vehicles')
    .update({ status: 'MAINTENANCE' })
    .eq('id', vehicle.id);
  throwSupabaseError('Gagal menonaktifkan kendaraan untuk maintenance', vehicleUpdate.error);

  const context = await loadReservationContext([{
    vehicle_id: vehicle.id,
    branch_id: vehicle.branch_id,
    company_id: vehicle.company_id,
    customer_id: null
  }]);

  return mapDbMaintenance(
    maintenanceResult.data,
    context.vehicles.get(vehicle.id),
    context.branches.get(vehicle.branch_id) || null,
    context.companies.get(vehicle.company_id) || null
  );
};

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
  if (!vehicle || vehicle.status === 'RENTED' || vehicle.status === 'RETURN_INSPECTION') return;
  const activeMaintenance = demoState.maintenances.some((item) => (
    item.vehicleId === vehicleId && ['SCHEDULED', 'IN_PROGRESS'].includes(item.status)
  ));
  if (!activeMaintenance && vehicle.gpsStatus === 'READY') vehicle.status = 'AVAILABLE';
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
  if (['COMPLETED', 'CANCELLED'].includes(nextStatus)) restoreDemoVehicleAvailability(maintenance.vehicleId);
  return {
    ...maintenance,
    vehicle: vehicle ? decorateVehicle(vehicle) : null
  };
};

const transitionMaintenanceFromSupabase = async (actor, maintenanceId, nextStatus) => {
  assertMaintenanceLifecycleRole(actor);
  const maintenanceResult = await supabase
    .from('maintenances')
    .select(maintenanceSelect)
    .eq('id', maintenanceId)
    .maybeSingle();
  throwSupabaseError('Gagal membaca maintenance', maintenanceResult.error);

  const maintenance = maintenanceResult.data;
  if (!maintenance) {
    const error = new Error('Maintenance tidak ditemukan.');
    error.status = 404;
    throw error;
  }
  assertCompanyAccess(actor, maintenance.company_id);

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

  const now = new Date().toISOString();
  const updatePayload = {
    status: nextStatus,
    completed_at: nextStatus === 'COMPLETED' ? now : null
  };
  const updateResult = await supabase
    .from('maintenances')
    .update(updatePayload)
    .eq('id', maintenance.id)
    .select(maintenanceSelect)
    .single();
  throwSupabaseError(`Gagal mengubah status maintenance menjadi ${nextStatus}`, updateResult.error);

  if (['COMPLETED', 'CANCELLED'].includes(nextStatus)) {
    const [vehicleResult, activeMaintenanceResult] = await Promise.all([
      supabase.from('vehicles').select('id,status,gps_status').eq('id', maintenance.vehicle_id).maybeSingle(),
      supabase.from('maintenances').select('id').eq('vehicle_id', maintenance.vehicle_id).in('status', ['SCHEDULED', 'IN_PROGRESS']).limit(1)
    ]);
    throwSupabaseError('Gagal memeriksa status kendaraan maintenance', vehicleResult.error);
    throwSupabaseError('Gagal memeriksa maintenance lain', activeMaintenanceResult.error);

    const vehicle = vehicleResult.data;
    if (
      vehicle
      && !['RENTED', 'RETURN_INSPECTION'].includes(vehicle.status)
      && vehicle.gps_status === 'READY'
      && (activeMaintenanceResult.data || []).length === 0
    ) {
      const vehicleUpdate = await supabase
        .from('vehicles')
        .update({ status: 'AVAILABLE' })
        .eq('id', vehicle.id);
      throwSupabaseError('Gagal mengaktifkan kembali kendaraan', vehicleUpdate.error);
    }
  }

  const context = await loadReservationContext([{
    vehicle_id: maintenance.vehicle_id,
    branch_id: maintenance.branch_id,
    company_id: maintenance.company_id,
    customer_id: null
  }]);
  return mapDbMaintenance(
    updateResult.data,
    context.vehicles.get(maintenance.vehicle_id),
    context.branches.get(maintenance.branch_id) || null,
    context.companies.get(maintenance.company_id) || null
  );
};

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
    companies: actor.role === 'CENTRAL_ADMIN' ? demoState.companies.length : 1,
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
    getCompanies(),
    listFleetFromSupabase(actor),
    listReservationsFromSupabase(actor),
    listRentalsFromSupabase(actor),
    actor.role === 'CENTRAL_ADMIN' ? listCustomers(actor) : Promise.resolve([])
  ]);

  const branches = companies.reduce(
    (total, company) => total + company.branches.length,
    0
  );

  return {
    companies: actor.role === 'CENTRAL_ADMIN' ? companies.length : 1,
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
