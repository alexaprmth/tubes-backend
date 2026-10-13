import dotenv from 'dotenv';
import { supabase } from './db.js';

dotenv.config();

const bucketName = process.env.SUPABASE_STORAGE_BUCKET || 'transrent-files';
const storageRequired = process.env.SUPABASE_STORAGE_REQUIRED === 'true';

const dataUrlPattern = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;

const safeSegment = (value) => String(value || 'unknown')
  .replace(/[^a-z0-9_-]+/gi, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80) || 'unknown';

const parseDataUrl = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.match(dataUrlPattern);
  if (!match) return null;
  return {
    contentType: match[1].toLowerCase(),
    buffer: Buffer.from(match[2].replace(/\s/g, ''), 'base64')
  };
};

const extensionFor = (contentType) => {
  const [, extension = 'bin'] = contentType.split('/');
  return extension === 'jpeg' ? 'jpg' : extension;
};

export const storageInfo = {
  enabled: Boolean(supabase),
  bucket: bucketName,
  required: storageRequired
};

/**
 * Menyimpan data URL ke Supabase Storage jika tersedia.
 * Untuk demo lama yang belum menjalankan migration storage, helper ini
 * mengembalikan data URL sebagai fallback agar alur tetap bisa dicoba.
 */
export const uploadDataUrl = async (value, { folder, ownerId, fileName } = {}) => {
  if (!value || !parseDataUrl(value)) return value || null;
  if (!supabase) return value;

  const parsed = parseDataUrl(value);
  const path = [
    safeSegment(folder || 'misc'),
    safeSegment(ownerId || 'anonymous'),
    `${safeSegment(fileName || Date.now())}.${extensionFor(parsed.contentType)}`
  ].join('/');

  const result = await supabase.storage
    .from(bucketName)
    .upload(path, parsed.buffer, {
      contentType: parsed.contentType,
      upsert: true
    });

  if (!result.error) return path;

  if (storageRequired) {
    const error = new Error(`Gagal mengunggah file ke Supabase Storage: ${result.error.message}`);
    error.status = 502;
    error.code = 'SUPABASE_STORAGE_UPLOAD_FAILED';
    throw error;
  }

  console.warn(`Supabase Storage fallback untuk ${path}: ${result.error.message}`);
  return value;
};

export const uploadDataUrls = async (values, options = {}) => {
  const list = Array.isArray(values) ? values : [];
  return Promise.all(list.map((value, index) => uploadDataUrl(value, {
    ...options,
    fileName: `${options.fileName || 'file'}-${index + 1}`
  })));
};

