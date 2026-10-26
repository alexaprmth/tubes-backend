import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { parse } = createRequire(new URL('../backend/package.json', import.meta.url))('dotenv');

// Resolve from this file so simulator restarts do not depend on the shell's cwd.
export function loadGpsConfig(env = process.env, envFile = new URL('../backend/.env', import.meta.url)) {
  let local = {};
  try { local = parse(readFileSync(envFile)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const settings = { ...local, ...env };
  const gpsToken = settings.GPS_INGEST_TOKEN || '';
  const deviceId = settings.GPS_DEVICE_ID?.trim();
  const intervalMs = Number(settings.GPS_INTERVAL_MS || 10_000);
  if (gpsToken.length < 32) throw new Error('Isi GPS_INGEST_TOKEN minimal 32 karakter di backend/.env.');
  if (!deviceId) throw new Error('Isi GPS_DEVICE_ID di backend/.env dengan kode perangkat demo yang benar.');
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw new Error('GPS_INTERVAL_MS minimal 1000 ms.');
  return { apiUrl: settings.TRANSRENT_API_URL || `http://localhost:${settings.PORT || 4100}/api`, deviceId, gpsToken, intervalMs };
}
