import '../testing-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, haversineKm, rentalDays } from './store.js';

test('haversineKm menghitung jarak koordinat dengan satuan kilometer', () => {
  const distance = haversineKm(0, 0, 0, 1);
  assert.ok(distance > 111 && distance < 112);
});

test('rentalDays menghitung durasi minimum satu hari', () => {
  assert.equal(rentalDays('2026-10-01', '2026-10-01'), 1);
  assert.equal(rentalDays('2026-10-01', '2026-10-04'), 3);
});

test('radius delivery TransRent maksimal 15 km', () => {
  assert.equal(constants.DELIVERY_RADIUS_KM, 15);
});

