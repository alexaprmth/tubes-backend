import './testing-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMouPdf, submitMou, readMou } from './mou.js';
import { updateGpsAgreement } from './data/store.js';
import { demoState } from './data/demoData.js';
const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.7\nsynthetic test fixture\n%%EOF').toString('base64');
test('PDF boundary rejects other formats and oversized content', () => {
  assert.throws(() => parseMouPdf('data:image/png;base64,AAAA'), { status: 400 });
  assert.throws(() => parseMouPdf('data:application/pdf;base64,AAAA'), { status: 400 });
  assert.throws(() => parseMouPdf('data:application/pdf;base64,' + Buffer.alloc(8*1024*1024+1).toString('base64')), { status: 400 });
  assert.equal(parseMouPdf(pdf).subarray(0, 5).toString(), '%PDF-');
});
test('owner upload pending, tenant isolation, current document review, active immutability', async () => {
  const admin = demoState.users.find((a) => a.role === 'RENTAL_ADMIN');
  const central = demoState.users.find((a) => a.role === 'CENTRAL_ADMIN');
  const agreement = { id: 'synthetic-mou', companyId: admin.companyId, status: 'DRAFT', gpsTrackingAllowed: false };
  demoState.agreements.filter((a) => a.companyId === admin.companyId).forEach((a) => a.status = 'REVOKED');
  demoState.agreements.push(agreement);
  const payload = { documentDataUrl: pdf, stampType: 'E_METERAI', bothPartiesSigned: true, signedAt: '2026-01-01', expiresAt: '2099-01-01' };
  await assert.rejects(() => submitMou({ ...admin, companyId: 'another' }, agreement.id, payload), { status: 403 });
  await assert.rejects(() => readMou(demoState.users.find((a) => a.role === 'CUSTOMER'), agreement.id), { status: 403 });
  await submitMou(admin, agreement.id, payload);
  assert.equal(agreement.status, 'PENDING');
  await assert.rejects(() => updateGpsAgreement(central, agreement.id, { status: 'ACTIVE', reviewed: true, reviewedSha256: 'stale' }), { status: 409 });
  await updateGpsAgreement(central, agreement.id, { status: 'ACTIVE', reviewed: true, reviewedSha256: agreement.documentMetadata.sha256 });
  assert.equal(agreement.status, 'ACTIVE');
  await assert.rejects(() => submitMou(admin, agreement.id, payload), { status: 409 });
});
