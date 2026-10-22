import { randomUUID } from 'node:crypto';
import { supabase } from './db.js';
import { demoState } from './data/demoData.js';
import { listFleet, getUser, simulatePayment, simulateFinePayment, mapDbBranch } from './data/store.js';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const reason=(value,max=2000)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail(400,`Isi referensi/catatan 1-${max} karakter.`);return value.trim();};
const admin=(actor,company)=>{if(!['RENTAL_ADMIN','CENTRAL_ADMIN'].includes(actor.role)||actor.role!=='CENTRAL_ADMIN'&&actor.companyId!==company)fail(403,'Hanya admin perusahaan terkait.');};
export const rpc = async(name,args)=>{
 const {data,error}=await supabase.rpc(name,args);
 if(error?.code==='PGRST202')fail(503,'Migration 015–016 belum tersedia. Jalankan bundle business update melalui SQL Editor.');
 if(error&&/^PT\d{3}$/.test(error.code))fail(Number(error.code.slice(2)),error.message);
 if(error?.code==='23505')fail(409,'Data sudah ada atau sedang dipakai transaksi lain.');
 if(error)fail(502,error.message);return data;
};
const checked=(result)=>{if(result.error)fail(502,result.error.message);return result.data||[];};
demoState.paymentOrders ||= [];
demoState.devices ||= demoState.vehicles.map(v=>({id:v.gpsDeviceId,companyId:v.companyId,deviceCode:v.gpsDeviceId,status:v.gpsStatus,provider:'ACADEMIC'})).filter((v,i,a)=>v.id&&a.findIndex(x=>x.id===v.id)===i);
const mapOrder=o=>({...o,orderNumber:o.order_number||o.orderNumber,customerId:o.customer_id||o.customerId,companyId:o.company_id||o.companyId,reservationId:o.reservation_id||o.reservationId,rentalId:o.rental_id||o.rentalId,
 amount:Number(o.amount),expiresAt:o.expires_at||o.expiresAt,customerReference:o.customer_reference||o.customerReference,adminNotes:o.admin_notes||o.adminNotes,approvedBy:o.approved_by||o.approvedBy,
 declaredAt:o.declared_at||o.declaredAt,approvedAt:o.approved_at||o.approvedAt,createdAt:o.created_at||o.createdAt,payoutReference:o.payout_reference||o.payoutReference,
 status:['PENDING','DECLARED'].includes(o.status)&&new Date(o.expires_at||o.expiresAt)<=new Date()?'EXPIRED':o.status});
export const listPaymentOrders=async actor=>{
 if(supabase){let q=supabase.from('payment_orders').select('*').order('created_at',{ascending:false});if(actor.role==='CUSTOMER')q=q.eq('customer_id',actor.id);else if(actor.role!=='CENTRAL_ADMIN'){if(!actor.companyId)return [];q=q.eq('company_id',actor.companyId);}return checked(await q).map(mapOrder);}
 return demoState.paymentOrders.filter(o=>actor.role==='CUSTOMER'?o.customerId===actor.id:actor.role==='CENTRAL_ADMIN'||o.companyId===actor.companyId).map(mapOrder).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
};
const balance=r=>Math.max(0,demoState.fines.filter(f=>f.rentalId===r.id&&f.status!=='CANCELLED').reduce((n,f)=>n+f.amount,0)-(demoState.reservations.find(s=>s.id===r.reservationId)?.depositAmount||0));
export const paymentAction=async(actor,action,id,payload={})=>{
 if(supabase)return mapOrder(await rpc('transrent_payment',{p_actor:actor.id,p_action:action,p_id:id,p_payload:payload}));
 const snapshot=structuredClone(demoState);
 try {
  if(['CREATE_RESERVATION','CREATE_FINE'].includes(action)){
   if(actor.role!=='CUSTOMER')fail(403,'Customer pemilik membuat tagihan.');
   const s=demoState.reservations.find(s=>s.id===id),r=demoState.rentals.find(r=>r.id===id);const parent=action==='CREATE_RESERVATION'?s:r;
   if(!parent||parent.customerId!==actor.id)fail(404,'Transaksi tidak ditemukan.');
   let amount,expiresAt;
   if(s&&action==='CREATE_RESERVATION'){if(s.status!=='PENDING_PAYMENT'||new Date(s.expiresAt)<=new Date())fail(409,'Reservasi kedaluwarsa/tidak menunggu pembayaran.');amount=s.totalAmount;expiresAt=s.expiresAt;}
   else {if(!['RETURN_PENDING_REVIEW','COMPLETED'].includes(r.status)||r.finePayment||demoState.fines.some(f=>f.rentalId===r.id&&f.status==='DISPUTED'))fail(409,'Rental masih sengketa atau tidak menunggu pelunasan.');amount=balance(r);if(amount<=0)fail(409,'Tidak ada selisih denda.');expiresAt=new Date(Date.now()+1800000).toISOString();}
   const key=action==='CREATE_RESERVATION'?'reservationId':'rentalId';
   demoState.paymentOrders.filter(o=>o[key]===id&&['PENDING','DECLARED'].includes(o.status)&&new Date(o.expiresAt)<=new Date()).forEach(o=>{o.status='EXPIRED';});
   const existing=demoState.paymentOrders.find(o=>o[key]===id&&['PENDING','DECLARED'].includes(o.status));if(existing)return mapOrder(existing);
   const o={id:randomUUID(),orderNumber:`TRX-${Date.now()}-${demoState.paymentOrders.length+1}`,purpose:action==='CREATE_RESERVATION'?'RESERVATION':'FINE',[key]:id,customerId:actor.id,companyId:parent.companyId,amount,provider:'INTERNAL_MANUAL',status:'PENDING',expiresAt,createdAt:new Date().toISOString()};demoState.paymentOrders.push(o);return mapOrder(o);
  }
  if(action==='REFUND_DEPOSIT'){
   const r=demoState.rentals.find(r=>r.id===id);if(!r)fail(404,'Rental tidak ditemukan.');admin(actor,r.companyId);const f=demoState.refunds.find(f=>f.rentalId===id);if(f?.status==='PAID')return f;
   if(r.status!=='RETURN_PENDING_REVIEW'||f?.status!=='APPROVED'||f.provider!=='INTERNAL_MANUAL'||f.amount<=0)fail(409,'Refund belum disetujui.');
   Object.assign(f,{status:'PAID',payoutReference:reason(payload.reference,200),paidAt:new Date().toISOString(),paidBy:actor.id});r.status='COMPLETED';r.completedAt=f.paidAt;demoState.reservations.find(s=>s.id===r.reservationId).status='COMPLETED';
   const v=demoState.vehicles.find(v=>v.id===r.vehicleId);v.status=v.repairRequired||v.gpsStatus!=='READY'||demoState.maintenances.some(m=>m.vehicleId===v.id&&['SCHEDULED','IN_PROGRESS'].includes(m.status))?'MAINTENANCE':'AVAILABLE';return f;
  }
  const o=demoState.paymentOrders.find(o=>o.id===id);if(!o||actor.role==='CUSTOMER'&&o.customerId!==actor.id)fail(404,'Tagihan tidak ditemukan.');
  if(action==='DECLARE'){
   if(actor.role!=='CUSTOMER')fail(403,'Hanya customer menyatakan pembayaran.');if(o.status==='DECLARED'&&new Date(o.expiresAt)>new Date())return mapOrder(o);
   if(o.status!=='PENDING'||new Date(o.expiresAt)<=new Date())fail(409,'Tagihan tidak terbuka atau kedaluwarsa.');
   if(o.purpose==='RESERVATION'){const s=demoState.reservations.find(s=>s.id===o.reservationId);if(s.status!=='PENDING_PAYMENT'||new Date(s.expiresAt)<=new Date())fail(409,'Reservasi tidak terbuka.');s.expiresAt=new Date(Date.now()+86400000).toISOString();}
   else if(demoState.fines.some(f=>f.rentalId===o.rentalId&&f.status==='DISPUTED'))fail(409,'Selesaikan sengketa dahulu.');
   Object.assign(o,{status:'DECLARED',customerReference:reason(payload.reference,200),declaredAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()});
  }else if(['APPROVE','REJECT'].includes(action)){
   admin(actor,o.companyId);if(o.status==='PAID'&&action==='APPROVE'||o.status==='REJECTED'&&action==='REJECT')return mapOrder(o);
   if(o.status!=='DECLARED'||new Date(o.expiresAt)<=new Date())fail(409,'Pembayaran tidak menunggu pemeriksaan.');
   const notes=reason(payload.notes);
   if(action==='APPROVE'){
    if(o.purpose==='FINE'&&o.amount!==balance(demoState.rentals.find(r=>r.id===o.rentalId)))fail(409,'Nominal tagihan berubah; buat tagihan baru.');
    if(o.purpose==='RESERVATION')await simulatePayment(getUser(o.customerId),o.reservationId,o);else await simulateFinePayment(getUser(o.customerId),o.rentalId,o);
   }
   Object.assign(o,{status:action==='APPROVE'?'PAID':'REJECTED',adminNotes:notes,approvedBy:actor.id,approvedAt:new Date().toISOString()});
  }else if(action==='REFUND_ORDER'){
   admin(actor,o.companyId);if(o.status==='REFUNDED')return mapOrder(o);if(o.status!=='REFUND_PENDING')fail(409,'Tidak ada refund menunggu.');
   Object.assign(o,{status:'REFUNDED',payoutReference:reason(payload.reference,200),refundedAt:new Date().toISOString(),refundedBy:actor.id});
   const s=demoState.reservations.find(s=>s.id===o.reservationId);Object.assign(s.cancellation,{refundStatus:'REFUNDED_INTERNAL',payoutReference:o.payoutReference,refundedBy:actor.id,refundedAt:o.refundedAt});demoState.payments.filter(p=>p.reservationId===s.id&&p.status==='PAID').forEach(p=>{p.status='REFUNDED';});
  }else fail(400,'Operasi pembayaran tidak valid.');return mapOrder(o);
 }catch(e){Object.assign(demoState,snapshot);throw e;}
};

const mapDevice=d=>({id:d.id,companyId:d.company_id||d.companyId,deviceCode:d.device_code||d.deviceCode,provider:d.provider,status:d.status});
export const listMaster=async actor=>{
 if(!['RENTAL_ADMIN','CENTRAL_ADMIN'].includes(actor.role))fail(403,'Hanya admin mengelola data master.');
 if(!supabase)return {branches:demoState.branches.filter(b=>actor.role==='CENTRAL_ADMIN'||b.companyId===actor.companyId),devices:demoState.devices.filter(d=>actor.role==='CENTRAL_ADMIN'||d.companyId===actor.companyId),vehicles:await listFleet(actor)};
 let b=supabase.from('branches').select('*').order('name'),d=supabase.from('gps_devices').select('*').order('device_code');if(actor.role!=='CENTRAL_ADMIN'){b=b.eq('company_id',actor.companyId);d=d.eq('company_id',actor.companyId);}
 const [br,dr,vehicles]=await Promise.all([b,d,listFleet(actor)]);return {branches:checked(br).map(mapDbBranch),devices:checked(dr).map(mapDevice),vehicles};
};
export const saveMaster=async(actor,entity,id,payload={})=>{
 const company=actor.role==='CENTRAL_ADMIN'?payload.companyId:actor.companyId;
 if(supabase)return rpc('transrent_master',{p_actor:actor.id,p_entity:entity,p_id:id||null,p_payload:payload});
 if(!['branches','devices','vehicles'].includes(entity))fail(400,'Jenis data master tidak valid.');
 const rows=demoState[entity],row=id?rows.find(r=>r.id===id):null;if(id&&!row)fail(404,'Data tidak ditemukan.');admin(actor,row?.companyId||company);
 if(!demoState.companies.some(c=>c.id===(row?.companyId||company)))fail(404,'Perusahaan tidak ditemukan.');
 const c=row?.companyId||company;
 if(entity==='branches'){
  reason(payload.name,200);reason(payload.address,1000);if(!Number.isFinite(payload.latitude)||!Number.isFinite(payload.longitude)||Math.abs(payload.latitude)>90||Math.abs(payload.longitude)>180)fail(400,'Koordinat cabang tidak valid.');
 }else if(entity==='devices'){
  reason(payload.deviceCode,200);if(!['READY','OFFLINE','FAULTY','INACTIVE'].includes(payload.status))fail(400,'Status GPS tidak valid.');if(rows.some(d=>d.id!==id&&d.deviceCode===payload.deviceCode))fail(409,'Kode GPS sudah ada.');
 }else{
  reason(payload.name,200);reason(payload.plateNumber,100);if(!['CAR','MOTORCYCLE'].includes(payload.type)||!['AVAILABLE','INACTIVE'].includes(payload.status))fail(400,'Jenis/status kendaraan tidak valid.');
  if(payload.seats!==undefined&&(!Number.isInteger(payload.seats)||payload.seats<1||payload.seats>60)||payload.year!==undefined&&(!Number.isInteger(payload.year)||payload.year<1900||payload.year>new Date().getFullYear()+1))fail(400,'Jumlah kursi/tahun tidak valid.');
  if(!Number.isSafeInteger(payload.pricePerDay)||payload.pricePerDay<0||!Number.isSafeInteger(payload.deposit)||payload.deposit<0)fail(400,'Tarif/deposit harus rupiah bulat tidak negatif.');
  if(!demoState.branches.some(b=>b.id===payload.branchId&&b.companyId===c))fail(400,'Cabang harus milik perusahaan yang sama.');
  const d=payload.gpsDeviceId&&demoState.devices.find(d=>d.id===payload.gpsDeviceId&&d.companyId===c);if(payload.gpsDeviceId&&!d)fail(400,'GPS harus milik perusahaan yang sama.');
  if(payload.gpsDeviceId&&rows.some(v=>v.id!==id&&v.gpsDeviceId===payload.gpsDeviceId))fail(409,'GPS sudah terpasang.');
  if(id&&(demoState.rentals.some(r=>r.vehicleId===id&&['SCHEDULED','ACTIVE','RETURN_PENDING_REVIEW'].includes(r.status))||demoState.reservations.some(s=>s.vehicleId===id&&(s.status==='CONFIRMED'||s.status==='PENDING_PAYMENT'&&new Date(s.expiresAt)>new Date()))))fail(409,'Selesaikan transaksi sebelum mengubah kendaraan.');
  if(payload.status==='AVAILABLE'&&(row?.repairRequired||demoState.maintenances.some(m=>m.vehicleId===id&&['SCHEDULED','IN_PROGRESS'].includes(m.status))))fail(409,'Selesaikan repair/maintenance dahulu.');
  payload={...payload,gpsStatus:d?.status||'NOT_INSTALLED'};
 }
 const result={...row,...payload,companyId:c,id:id||randomUUID()};if(row)Object.assign(row,result);else rows.push(result);
 if(entity==='devices')demoState.vehicles.filter(v=>v.gpsDeviceId===id).forEach(v=>{v.gpsStatus=result.status;});return result;
};
