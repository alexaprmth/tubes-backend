import { supabase, newAuthClient } from './db.js';
import { demoState } from './data/demoData.js';
import { randomUUID } from 'node:crypto';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
demoState.adminInvites ||= [];
const view=row=>({id:row.id,companyId:row.company_id||row.companyId,email:row.email,name:row.name,status:row.status,lastError:row.last_error||row.lastError||null,updatedAt:row.updated_at||row.updatedAt});
export const listInvites=async actor=>{
 if(actor.role!=='CENTRAL_ADMIN')fail(403,'Hanya Admin Pusat melihat undangan.');
 if(!supabase)return demoState.adminInvites.map(view);
 const {data,error}=await supabase.from('company_admin_invites').select('id,company_id,email,name,status,last_error,updated_at').order('updated_at',{ascending:false});if(error)fail(502,error.message);return data.map(view);
};
export const requestInvite=async(actor,companyId,payload={})=>{
 if(actor.role!=='CENTRAL_ADMIN')fail(403,'Hanya Admin Pusat mengundang admin.');
 const email=String(payload.email||'').trim().toLowerCase(),name=String(payload.name||'').trim();
 if(!/^\S+@\S+\.\S+$/.test(email)||name.length>200)fail(400,'Email/nama Admin Rental tidak valid.');
 if(!supabase){
  if(!demoState.companies.some(c=>c.id===companyId))fail(404,'Perusahaan tidak ditemukan.');
  let row=demoState.adminInvites.find(i=>i.email===email);if(row&&row.companyId!==companyId)fail(409,'Undangan email ini milik perusahaan lain.');
  if(demoState.users.some(u=>u.email===email)&&!row)fail(409,'Akun existing tidak diubah perannya lewat undangan.');
  if(!row){row={id:randomUUID(),companyId,email,name:name||email.split('@')[0],status:'PREPARING'};demoState.adminInvites.push(row);}
  if(row.status==='ACCEPTED')return view(row);row.status='SENT';row.updatedAt=new Date().toISOString();return {...view(row),invitationStatus:'SENT',message:'Mode lokal tidak mengirim email. Callback undangan memakai Supabase Auth pada deployment terkonfigurasi.'};
 }
 const company=await supabase.from('rental_companies').select('id').eq('id',companyId).maybeSingle();if(company.error)fail(502,company.error.message);if(!company.data)fail(404,'Perusahaan tidak ditemukan.');
 let result=await supabase.from('company_admin_invites').select('*').eq('email',email).maybeSingle();if(result.error)fail(502,result.error.message);let row=result.data;
 if(row&&row.company_id!==companyId)fail(409,'Email sudah terikat undangan perusahaan lain.');
 if(row?.status==='ACCEPTED')return view(row);
 if(!row){
  const existing=await supabase.from('profiles').select('id').ilike('email',email).limit(1);if(existing.error)fail(502,existing.error.message);if(existing.data?.length)fail(409,'Akun existing tidak diubah perannya lewat undangan.');
  result=await supabase.from('company_admin_invites').insert({company_id:companyId,email,name:name||email.split('@')[0],created_by:actor.id}).select('*').single();if(result.error)fail(result.error.code==='23505'?409:502,result.error.message);row=result.data;
 }
 const previousStatus=row.status,lease=randomUUID();
 const claimed=await supabase.from('company_admin_invites').update({processing_token:lease,processing_until:new Date(Date.now()+300000).toISOString()}).eq('id',row.id).or(`processing_until.is.null,processing_until.lt.${new Date().toISOString()}`).select('*').maybeSingle();
 if(claimed.error)fail(502,claimed.error.message);if(!claimed.data)fail(409,'Undangan sedang diproses. Coba lagi setelah proses selesai.');row=claimed.data;
 // Persist the Auth identity before the profile step, so a failed profile can be retried safely.
 const save=async patch=>{const r=await supabase.from('company_admin_invites').update({...patch,updated_at:new Date().toISOString()}).eq('id',row.id).eq('processing_token',lease).select('*').single();if(r.error)fail(502,r.error.message);row=r.data;};
 try{
  if(!row.user_id){
   const candidates=await supabase.from('profiles').select('id').ilike('email',email).limit(2);
   if(candidates.error)throw new Error(candidates.error.message);
   if(candidates.data?.length===1){const existing=await supabase.auth.admin.getUserById(candidates.data[0].id);const user=existing.data?.user;
    if(!existing.error&&user?.email?.toLowerCase()===email&&user.invited_at&&new Date(user.invited_at)>=new Date(row.created_at))await save({user_id:user.id});
    else fail(409,'Ada akun existing yang belum dapat dikaitkan ke undangan; perlu review manual.');
   }
  }
  if(!row.user_id){
   const invite=await supabase.auth.admin.inviteUserByEmail(email,{redirectTo:process.env.FRONTEND_ORIGIN||'http://localhost:5174',data:{name:row.name}});
   if(invite.error||!invite.data?.user)throw new Error(invite.error?.message||'User belum dibuat.');
   await save({user_id:invite.data.user.id});
  }
  const existing=await supabase.from('profiles').select('role,company_id').eq('id',row.user_id).maybeSingle();if(existing.error)throw new Error(existing.error.message);
  if(existing.data&&existing.data.role!=='CUSTOMER'&&(existing.data.role!=='RENTAL_ADMIN'||existing.data.company_id!==companyId))fail(409,'Profil memiliki peran/perusahaan lain; perlu review manual.');
  const profile=await supabase.from('profiles').upsert({id:row.user_id,name:row.name,email,role:'RENTAL_ADMIN',company_id:companyId,verification_status:'VERIFIED',updated_at:new Date().toISOString()});if(profile.error)throw new Error(profile.error.message);
  if(payload.resend===true||previousStatus==='FAILED'){
   const resend=await newAuthClient().auth.resetPasswordForEmail(email,{redirectTo:process.env.FRONTEND_ORIGIN||'http://localhost:5174'});if(resend.error)throw new Error(resend.error.message);
  }
  await save({status:'SENT',last_error:null,processing_until:null,processing_token:null});return {...view(row),invitationStatus:'SENT'};
 }catch(error){await save({status:'FAILED',last_error:String(error.message).slice(0,500),processing_until:null,processing_token:null});fail(error.status||502,'Undangan belum selesai. Gunakan Lanjutkan/Undang ulang pada perusahaan ini. '+error.message);}
};

export const acceptInvite=async(payload={})=>{
 if(!supabase)fail(503,'Undangan memerlukan Supabase Auth terkonfigurasi.');
 if(typeof payload.password!=='string'||payload.password.length<8||payload.password.length>128)fail(400,'Password harus 8–128 karakter.');
 const client=newAuthClient();let session;
 if(payload.tokenHash&&['invite','recovery'].includes(payload.type)){
  const r=await client.auth.verifyOtp({token_hash:payload.tokenHash,type:payload.type});if(r.error||!r.data.session)fail(401,'Tautan undangan tidak valid/kedaluwarsa.');session=r.data.session;
 }else if(typeof payload.accessToken==='string'&&typeof payload.refreshToken==='string'){
  const r=await client.auth.setSession({access_token:payload.accessToken,refresh_token:payload.refreshToken});if(r.error||!r.data.session)fail(401,'Sesi undangan tidak valid/kedaluwarsa.');session=r.data.session;
 }else fail(400,'Buka tautan undangan dari email.');
 const row=await supabase.from('company_admin_invites').select('*').eq('user_id',session.user.id).maybeSingle();if(row.error)fail(502,row.error.message);
 if(!row.data||!['SENT','FAILED','ACCEPTED'].includes(row.data.status)||row.data.email!==session.user.email?.toLowerCase())fail(403,'Sesi ini tidak terikat undangan Admin Rental.');
 const profile=await supabase.from('profiles').select('role,company_id').eq('id',session.user.id).maybeSingle();if(profile.error)fail(502,profile.error.message);
 if(profile.data?.role!=='RENTAL_ADMIN'||profile.data.company_id!==row.data.company_id)fail(409,'Profil undangan belum siap. Minta Admin Pusat melanjutkan setup.');
 const updated=await client.auth.updateUser({password:payload.password});if(updated.error)fail(400,updated.error.message);
 const marked=await supabase.from('company_admin_invites').update({status:'ACCEPTED',accepted_at:new Date().toISOString(),updated_at:new Date().toISOString(),last_error:null}).eq('id',row.data.id);if(marked.error)fail(502,'Password tersimpan tetapi checkpoint undangan belum tersimpan; buka kembali tautan untuk melanjutkan.');
 return {message:'Password tersimpan. Silakan login dengan email undangan.'};
};
