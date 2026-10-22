import './testing-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { onlineTerms, termsHash, validateOnlineConsent, submitOnlineSimulation, downloadOnlineSimulation } from './mou-online.js';
import { submitMou } from './mou.js';
import { demoState } from './data/demoData.js';
const payload = () => ({ termsHash, termsVersion: onlineTerms.version, consents: Object.fromEntries(onlineTerms.checks.map(({id}) => [id,true])), includeSimulatedMeterai: true, expiresAt: '2099-01-01' });

test('all checkboxes must be true and the displayed terms version must match', () => {
 for (const {id} of onlineTerms.checks) {
  const p=payload(); p.consents[id]=false; assert.throws(()=>validateOnlineConsent(p),{status:400});
  p.consents[id]='true'; assert.throws(()=>validateOnlineConsent(p),{status:400});
 }
 assert.throws(()=>validateOnlineConsent({...payload(),termsHash:'stale'}),{status:409});
 assert.throws(()=>validateOnlineConsent({...payload(),includeSimulatedMeterai:false}),{status:400});
 for (const expiresAt of ['2026-02-30','invalid','2000-01-01']) assert.throws(()=>validateOnlineConsent({...payload(),expiresAt}),{status:400});
});
test('online generation records consent separately, preserves final document and denies retries', async () => {
 const admin=demoState.users.find((u)=>u.role==='RENTAL_ADMIN');
 const agreement={id:'online-test',companyId:admin.companyId,agreementNumber:'MOU-SYNTHETIC-ONLINE',status:'PENDING',gpsTrackingAllowed:false,documentPath:'existing-final.pdf',documentMetadata:{sha256:'existing-hash'}};
 demoState.agreements.push(agreement);
 await assert.rejects(()=>submitOnlineSimulation({...admin,companyId:'another'},agreement.id,payload()),{status:403});
 const result=await submitOnlineSimulation(admin,agreement.id,payload());
 assert.equal(result.simulation.mode,'ACADEMIC_SIMULATION');
 assert.equal(agreement.status,'PENDING'); assert.equal(agreement.gpsTrackingAllowed,false);
 assert.equal(agreement.documentPath,'existing-final.pdf'); assert.equal(agreement.documentMetadata.sha256,'existing-hash');
 assert.equal(result.simulation.acceptedBy,admin.id); assert.equal(result.simulation.termsHash,termsHash);
 assert.equal((await downloadOnlineSimulation(admin,agreement.id)).subarray(0,5).toString(),'%PDF-');
 await assert.rejects(()=>submitMou(admin,agreement.id,{documentDataUrl:agreement.onlineSimulation.documentDataUrl,stampType:'E_METERAI',bothPartiesSigned:true,signedAt:'2026-01-01',expiresAt:'2099-01-01'}),{status:409});
 assert.equal(agreement.documentPath,'existing-final.pdf');
 await assert.rejects(()=>submitOnlineSimulation(admin,agreement.id,payload()),{status:409});
 await assert.rejects(()=>downloadOnlineSimulation(demoState.users.find((u)=>u.role==='CUSTOMER'),agreement.id),{status:403});
});
