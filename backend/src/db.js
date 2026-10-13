import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const authKey = process.env.SUPABASE_ANON_KEY || key;

export const databaseConfigured = Boolean(url && key);
export const authConfigured = Boolean(url && authKey);
export const supabaseUrl = url || null;

export const supabase = url && key
  ? createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  })
  : null;

// Auth menggunakan anon key jika tersedia. Service-role client di atas tetap
// hanya digunakan di backend untuk operasi trusted dan profile.
export const supabaseAuth = url && authKey
  ? createClient(url, authKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  })
  : null;

export const persistence = supabase ? 'supabase' : 'demo-in-memory';

const classifySupabaseError = (error) => {
  const message = error?.message || 'Unknown Supabase error';
  const lower = message.toLowerCase();

  if (lower.includes('jwt issued at future') || lower.includes('issued at future')) {
    return {
      code: 'SUPABASE_JWT_CLOCK_SKEW',
      message: 'Supabase menolak JWT karena waktu komputer/server tidak sinkron. Periksa tanggal, jam, dan timezone Windows, lalu restart backend.'
    };
  }

  if (lower.includes('invalid api key') || lower.includes('jwt')) {
    return {
      code: 'SUPABASE_INVALID_KEY',
      message: 'SUPABASE_SERVICE_ROLE_KEY atau SUPABASE_ANON_KEY tidak valid. Salin ulang key dari Project Settings > API dan restart backend.'
    };
  }

  return { code: error?.code || 'SUPABASE_ERROR', message };
};

export const getDatabaseHealth = async () => {
  if (!supabase) {
    return {
      configured: false,
      reachable: false,
      persistence,
      message: 'Supabase belum dikonfigurasi. Backend menggunakan demo in-memory.'
    };
  }

  const startedAt = Date.now();
  const { error, count } = await supabase
    .from('rental_companies')
    .select('id', { head: true, count: 'exact' })
    .limit(1);

  if (error) {
    const classified = classifySupabaseError(error);
    return {
      configured: true,
      reachable: false,
      persistence,
      latencyMs: Date.now() - startedAt,
      ...classified
    };
  }

  return {
    configured: true,
    reachable: true,
    persistence,
    latencyMs: Date.now() - startedAt,
    rentalCompanyRows: count ?? null
  };
};

export { classifySupabaseError };
