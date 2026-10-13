import dotenv from 'dotenv';
import {
  createCustomer,
  findUserByEmail,
  getPublicUser
} from './data/store.js';
import { supabase, supabaseAuth } from './db.js';
import { uploadDataUrl } from './storage.js';

dotenv.config();

// Once Supabase persistence is configured, do not silently fall back to
// demo users. Demo users have non-UUID ids and cannot access Supabase rows.
const allowDemoAuth = !supabase && process.env.ALLOW_DEMO_AUTH !== 'false';

export const persistenceMode = supabase
  ? 'supabase'
  : 'demo-in-memory';

export const authMode = supabaseAuth
  ? (allowDemoAuth ? 'supabase-auth-with-demo-fallback' : 'supabase-auth')
  : 'demo-in-memory';

export const demoToken = (user) => `demo:${user.email}`;

const bearerToken = (request) => {
  const header = request.headers.authorization || '';
  return header.startsWith('Bearer ')
    ? header.slice(7)
    : null;
};

const resolveDemoToken = (token) => {
  if (!token?.startsWith('demo:')) return null;
  return findUserByEmail(token.slice(5));
};

const mapProfileToActor = (authUser, profile = null) => ({
  id: authUser.id,
  email: authUser.email,
  name: profile?.name
    || authUser.user_metadata?.name
    || authUser.email,
  phone: profile?.phone
    || authUser.user_metadata?.phone
    || null,
  address: profile?.address
    || authUser.user_metadata?.address
    || null,
  role: profile?.role || 'CUSTOMER',
  companyId: profile?.company_id || null,
  branchId: profile?.branch_id || null,
  verificationStatus: profile?.verification_status || 'PENDING',
  ktpNumber: profile?.ktp_number || null,
  simNumber: profile?.sim_number || null,
  ktpDocument: profile?.ktp_document_path || null,
  simDocument: profile?.sim_document_path || null
});

const getSupabaseProfile = async (userId) => {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select(
      'id,name,email,phone,address,role,company_id,branch_id,verification_status,ktp_number,sim_number,ktp_document_path,sim_document_path'
    )
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error(`Gagal membaca profile Supabase: ${error.message}`);
    return null;
  }

  return data;
};

export const resolveActor = async (request) => {
  const token = bearerToken(request);
  if (!token) return null;

  const demoUser = resolveDemoToken(token);
  if (!supabase && demoUser) return getPublicUser(demoUser);

  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) return null;

  const profile = await getSupabaseProfile(data.user.id);
  return mapProfileToActor(data.user, profile);
};

export const requireAuth = async (request, response, next) => {
  const actor = await resolveActor(request);

  if (!actor) {
    return response.status(401).json({
      message: 'Unauthorized. Silakan login.'
    });
  }

  request.actor = actor;
  return next();
};

export const requireRoles = (...roles) => (
  (request, response, next) => {
    if (!roles.includes(request.actor?.role)) {
      return response.status(403).json({
        message: 'Role tidak memiliki akses ke resource ini.'
      });
    }

    return next();
  }
);

export const loginDemo = (email, password) => {
  const user = findUserByEmail(email || '');

  if (!user || user.password !== password) {
    const error = new Error('Email atau password demo salah.');
    error.status = 401;
    throw error;
  }

  return {
    user: getPublicUser(user),
    accessToken: demoToken(user)
  };
};

const makeAuthError = (message, status = 401) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const loginSupabase = async (email, password) => {
  if (!supabaseAuth) {
    throw makeAuthError('Supabase Auth belum dikonfigurasi.');
  }

  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email,
    password
  });

  if (error || !data.user || !data.session) {
    throw makeAuthError(
      error?.message || 'Login Supabase gagal.'
    );
  }

  const profile = await getSupabaseProfile(data.user.id);

  return {
    user: mapProfileToActor(data.user, profile),
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at
  };
};

export const login = async (email, password) => {
  if (!supabaseAuth) return loginDemo(email, password);

  try {
    return await loginSupabase(email, password);
  } catch (supabaseError) {
    if (!allowDemoAuth) throw supabaseError;

    try {
      return loginDemo(email, password);
    } catch {
      throw supabaseError;
    }
  }
};

export const registerAccount = async (payload) => {
  if (!supabaseAuth) {
    const user = createCustomer(payload);

    return {
      user: getPublicUser(user),
      session: null,
      message: 'Akun demo dibuat dan menunggu verifikasi Admin Pusat.'
    };
  }

  const {
    name,
    email,
    password,
    phone,
    address,
    ktpNumber,
    simNumber,
    ktpDocument,
    simDocument
  } = payload;

  const { data, error } = await supabaseAuth.auth.signUp({
    email,
    password,
    options: {
      data: {
        name,
        phone,
        address
      }
    }
  });

  if (error || !data.user) {
    throw makeAuthError(
      error?.message || 'Registrasi Supabase gagal.',
      400
    );
  }

  if (data.user.identities?.length === 0) {
    throw makeAuthError('Email sudah terdaftar.', 409);
  }

  if (supabase) {
    const [ktpDocumentPath, simDocumentPath] = await Promise.all([
      uploadDataUrl(ktpDocument, {
        folder: 'identity/ktp',
        ownerId: data.user.id,
        fileName: 'ktp'
      }),
      uploadDataUrl(simDocument, {
        folder: 'identity/sim',
        ownerId: data.user.id,
        fileName: 'sim'
      })
    ]);

    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({
        id: data.user.id,
        name: name || email.split('@')[0],
        email,
        phone: phone || null,
        address: address || null,
        role: 'CUSTOMER',
        verification_status: 'PENDING',
        ktp_number: ktpNumber || null,
        sim_number: simNumber || null,
        ktp_document_path: ktpDocumentPath || null,
        sim_document_path: simDocumentPath || null,
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });

    if (profileError) {
      const wrapped = new Error(
        `Akun dibuat, tetapi profile gagal disiapkan: ${profileError.message}`
      );
      wrapped.status = 502;
      throw wrapped;
    }
  }

  return {
    user: mapProfileToActor(data.user),
    session: data.session,
    message: data.session
      ? 'Akun berhasil dibuat. Tunggu verifikasi Admin Pusat.'
      : 'Akun berhasil dibuat. Periksa email untuk konfirmasi, lalu tunggu verifikasi Admin Pusat.'
  };
};
