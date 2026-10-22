import './testing-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('HTTP JSON rental flow, invalid return rollback and guarded MoU endpoints', async () => {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  const backend = fileURLToPath(new URL('../', import.meta.url));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: backend, windowsHide: true, env: { ...process.env, PORT: String(port), SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_SECRET_KEY: '', PAYMENT_PROVIDER: 'SIMULATED_GATEWAY', ALLOW_DEMO_AUTH: 'true' }, stdio: ['ignore','pipe','pipe'] });
  let logs=''; child.stdout.on('data', (chunk) => logs+=chunk); child.stderr.on('data', (chunk) => logs+=chunk);
  const base=`http://127.0.0.1:${port}/api`;
  const request=async(path,token,body)=>{
    const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  try {
    let ready=false;
    for(let n=0;n<300;n++) { try { ready=(await request('/health')).status===200; if(ready)break; } catch {} await new Promise(r=>setTimeout(r,50)); }
    assert.ok(ready,logs);
    const customer=(await request('/auth/demo-login',null,{email:'customer@transrent.demo',password:'demo123'})).body.accessToken;
    const admin=(await request('/auth/demo-login',null,{email:'admin@balimove.demo',password:'demo123'})).body.accessToken;
    assert.ok(customer); assert.ok(admin);
    for (const name of ['mou-transrent-fisik.pdf','mou-transrent-digital.pdf','mou-transrent-fisik.docx','mou-transrent-digital.docx']) {
      const template=await fetch(base+'/mou/templates/'+name,{headers:{Authorization:`Bearer ${admin}`}});
      assert.equal(template.status,200,name);
      const header=Buffer.from(await template.arrayBuffer()).subarray(0,5).toString();
      assert.ok(name.endsWith('.pdf') ? header === '%PDF-' : header.startsWith('PK'),name);
    }
    assert.equal((await fetch(base+'/mou/templates/mou-transrent-fisik.pdf',{headers:{Authorization:`Bearer ${customer}`}})).status,403);

    const created=await request('/reservations',customer,{vehicleId:'veh-avanza',startDate:'2027-04-01',endDate:'2027-04-04'});
    assert.equal(created.status,201,JSON.stringify(created.body));
    const id=created.body.reservation.id;
    assert.equal((await request(`/reservations/${id}/payments/simulate`,customer,{})).status,200);
    const handed=await request(`/reservations/${id}/handover`,admin,{}); assert.equal(handed.status,200);
    const rentalId=handed.body.rental.id;
    assert.equal((await request(`/rentals/${rentalId}/return`,admin,{damageItems:[{amount:-1}]})).status,400);
    assert.equal((await request(`/rentals/${rentalId}/return`,admin,{actualReturnDate:'2027-04-05',returnMethod:'SELF_RETURN'})).status,200);
    assert.equal((await request(`/rentals/${rentalId}/refund/confirm`,admin,{})).status,200);
    // New financial routes stay isolated from Supabase and use synthetic accounts.
    const draft=(await request('/reservations',customer,{vehicleId:'veh-avanza',startDate:'2027-06-01',endDate:'2027-06-04'})).body.reservation;
    assert.ok(draft?.id);
    assert.equal((await request(`/reservations/${draft.id}/cancel`,customer,{reason:''})).status,400);
    assert.equal((await request(`/reservations/${draft.id}/payments/simulate`,admin,{})).status,403);
    assert.equal((await request(`/reservations/${draft.id}/payments/simulate`,customer,{})).status,200);
    const cancelled=await request(`/reservations/${draft.id}/cancel`,customer,{reason:'Synthetic cancelled before handover'});
    assert.equal(cancelled.status,200,JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.reservation.cancellation.refundAmount,draft.totalAmount);
    assert.equal((await request(`/reservations/${draft.id}/cancel`,customer,{reason:'Retry'})).body.reservation.cancellation.id,cancelled.body.reservation.cancellation.id);
    assert.equal((await request(`/reservations/${draft.id}/handover`,admin,{})).status,409);
    const large=(await request('/reservations',customer,{vehicleId:'veh-avanza',startDate:'2027-07-01',endDate:'2027-07-04'})).body.reservation;
    await request(`/reservations/${large.id}/payments/simulate`,customer,{});
    const rental=(await request(`/reservations/${large.id}/handover`,admin,{})).body.rental;
    assert.equal((await request(`/rentals/${rental.id}/return`,admin,{damageItems:[{label:'Synthetic damage',amount:large.depositAmount+300000}]})).status,200);
    const listed=(await request('/rentals',customer)).body.rentals.find(r=>r.id===rental.id);
    assert.equal(listed.settlement.balanceDue,300000);
    assert.equal((await request(`/rentals/${rental.id}/refund/confirm`,admin,{})).status,409);
    const dispute=(await request(`/fines/${listed.fine.id}/disputes`,customer,{reason:'Synthetic dispute'})).body.dispute;
    assert.equal((await request(`/disputes/${dispute.id}/resolve`,customer,{decision:'ACCEPTED',notes:'No access'})).status,403);
    assert.equal((await request(`/rentals/${rental.id}/fine-payments/simulate`,customer,{})).status,409);
    assert.equal((await request(`/disputes/${dispute.id}/resolve`,admin,{decision:'ADJUSTED',amount:large.depositAmount+100000,notes:'Synthetic review'})).status,200);
    const paidExtra=await request(`/rentals/${rental.id}/fine-payments/simulate`,customer,{});
    assert.equal(paidExtra.status,200); assert.equal(paidExtra.body.payment.amount,100000);
    assert.equal((await request(`/rentals/${rental.id}/fine-payments/simulate`,customer,{})).body.payment.id,paidExtra.body.payment.id);
    assert.equal((await request(`/rentals/${rental.id}/refund/confirm`,admin,{})).status,200);
    const repair=(await request('/maintenance',admin,{vehicleId:'veh-avanza',type:'REPAIR'})).body.maintenance;
    assert.equal((await request(`/maintenance/${repair.id}/cancel`,admin,{})).status,200);
    assert.equal((await request('/admin/fleet',admin)).body.fleet.find(v=>v.id==='veh-avanza').status,'MAINTENANCE');
    const completedRepair=(await request('/maintenance',admin,{vehicleId:'veh-avanza',type:'REPAIR'})).body.maintenance;
    assert.equal((await request(`/maintenance/${completedRepair.id}/complete`,admin,{})).status,200);
    assert.equal((await request('/admin/fleet',admin)).body.fleet.find(v=>v.id==='veh-avanza').status,'AVAILABLE');
    assert.equal((await request('/rental/gps-agreements',customer)).status,403);
    assert.equal((await request('/rental/gps-agreements',admin)).status,200);
    const central=(await request('/auth/demo-login',null,{email:'central@transrent.demo',password:'demo123'})).body.accessToken;
    const createdMou=await request('/admin/companies/company-balimove/agreements',central,{notes:'Mohon lengkapi MoU untuk pengujian.'});
    assert.equal(createdMou.status,201,JSON.stringify(createdMou.body));
    const agreementId=createdMou.body.agreement.id;
    assert.equal(createdMou.body.agreement.status,'PENDING');
    assert.equal(createdMou.body.agreement.documentPath,null);
    assert.equal(createdMou.body.agreement.signedAt,null);
    assert.equal(createdMou.body.agreement.gpsTrackingAllowed,false);
    const ownerRequests=(await request('/rental/gps-agreements',admin)).body.agreements;
    assert.equal(ownerRequests.find(a=>a.id===agreementId).notes,'Mohon lengkapi MoU untuk pengujian.');
    assert.equal((await request('/admin/companies/company-balimove/agreements',central,{documentDataUrl:'data:application/pdf;base64,AAAA'})).status,400);
    assert.equal((await request('/admin/companies/company-balimove/agreements',central,{signedAt:'2026-10-01'})).status,400);
    assert.equal((await request('/admin/companies/company-balimove/agreements',admin,{})).status,403);

    assert.equal((await request('/mou/online-terms',customer)).status,403);
    const terms=(await request('/mou/online-terms',admin)).body;
    assert.equal(terms.schemaReady,true);
    const consent={termsHash:terms.termsHash,termsVersion:terms.version,consents:Object.fromEntries(terms.checks.map(({id})=>[id,true])),includeSimulatedMeterai:true,expiresAt:'2099-01-01'};
    assert.equal((await request(`/rental/gps-agreements/${agreementId}/online-simulation`,admin,{...consent,consents:{}})).status,400);
    assert.equal((await request(`/rental/gps-agreements/${agreementId}/online-simulation`,admin,consent)).status,201);
    assert.equal((await request(`/rental/gps-agreements/${agreementId}/online-simulation`,admin,consent)).status,409);
    const pdfResponse=await fetch(base+`/gps-agreements/${agreementId}/online-simulation/document`,{headers:{Authorization:`Bearer ${admin}`}});
    assert.equal(pdfResponse.status,200);assert.equal(Buffer.from(await pdfResponse.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
    const currentMou=(await request('/rental/gps-agreements',admin)).body.agreements.find(a=>a.id===agreementId);
    assert.equal(currentMou.status,'PENDING'); assert.equal(currentMou.documentPath,null); assert.equal(currentMou.onlineSimulation.mode,'ACADEMIC_SIMULATION');

  } finally {
    child.kill(); await once(child,'exit');
  }
});
