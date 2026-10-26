import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGpsConfig } from './config.js';

test('GPS file persists across fresh loads and different working directories', () => {
  const folder = mkdtempSync(join(tmpdir(), 'transrent-gps-'));
  const file = join(folder, '.env');
  const cwd = process.cwd();
  try {
    writeFileSync(file, `GPS_INGEST_TOKEN=${'a'.repeat(64)}\nGPS_DEVICE_ID=QA-PERSISTENT\nPORT=4100\nGPS_INTERVAL_MS=1000\nSUPABASE_SERVICE_ROLE_KEY=not-returned\n`);
    const before = loadGpsConfig({}, file);
    process.chdir(folder);
    assert.deepEqual(loadGpsConfig({}, file), before);
    assert.equal(before.apiUrl, 'http://localhost:4100/api');
    assert.equal(before.deviceId, 'QA-PERSISTENT');
    assert.equal(before.gpsToken.length, 64);
    assert.equal('SUPABASE_SERVICE_ROLE_KEY' in before, false);
    assert.equal(loadGpsConfig({ GPS_DEVICE_ID: 'QA-OVERRIDE' }, file).deviceId, 'QA-OVERRIDE');
    writeFileSync(file, 'GPS_INGEST_TOKEN=\nPUBLIC_API_URL=http://localhost:4100\nGPS_DEVICE_ID=QA\n');
    assert.throws(() => loadGpsConfig({}, file), /GPS_INGEST_TOKEN/);
  } finally { process.chdir(cwd); rmSync(file); rmdirSync(folder); }
});

test('GPS configuration fails closed on missing/short token, device or invalid interval', () => {
  const missing = join(tmpdir(), 'transrent-gps-file-that-does-not-exist');
  assert.throws(() => loadGpsConfig({}, missing), /GPS_INGEST_TOKEN/);
  assert.throws(() => loadGpsConfig({ GPS_INGEST_TOKEN: 'short' }, missing), /GPS_INGEST_TOKEN/);
  assert.throws(() => loadGpsConfig({ GPS_INGEST_TOKEN: 'a'.repeat(64) }, missing), /GPS_DEVICE_ID/);
  assert.throws(() => loadGpsConfig({ GPS_INGEST_TOKEN: 'a'.repeat(64), GPS_DEVICE_ID: 'QA', GPS_INTERVAL_MS: 'NaN' }, missing), /GPS_INTERVAL_MS/);
});
