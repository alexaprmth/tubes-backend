import test from 'node:test';
import assert from 'node:assert/strict';
import {api,setSession,getSession} from './api.js';
const values=new Map();globalThis.localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};globalThis.window=new EventTarget();
const response=(status,payload)=>({status,ok:status<400,json:async()=>payload});
test('concurrent requests share one refresh and use the rotated session',async()=>{
 values.clear();setSession({user:{id:'synthetic'},accessToken:'old',refreshToken:'refresh-old',expiresAt:1});let refreshes=0,requests=0;
 globalThis.fetch=async(url,options)=>{if(url.endsWith('/auth/refresh')){refreshes++;await Promise.resolve();return response(200,{user:{id:'synthetic'},accessToken:'new',refreshToken:'refresh-new',expiresAt:9999999999});}requests++;assert.equal(options.headers.Authorization,'Bearer new');return response(200,{ok:true});};
 await Promise.all([api('/reservations'),api('/rentals')]);assert.equal(refreshes,1);assert.equal(requests,2);assert.equal(getSession().accessToken,'new');
});
test('expired refresh logs out and surfaces an error instead of empty data',async()=>{
 setSession({accessToken:'old',refreshToken:'invalid',expiresAt:1});let expired=0;const listener=()=>expired++;window.addEventListener('transrent:expired',listener);
 globalThis.fetch=async()=>response(401,{message:'Expired'});await assert.rejects(()=>api('/reservations'),/Expired/);assert.equal(getSession(),null);assert.equal(expired,1);window.removeEventListener('transrent:expired',listener);
});
test('late refresh never restores an account after logout or account switch',async()=>{
 setSession({accessToken:'first',refreshToken:'refresh-first',expiresAt:1});let finish;globalThis.fetch=()=>new Promise(resolve=>{finish=resolve;});const pending=api('/rentals');
 setSession({accessToken:'second',refreshToken:'refresh-second',expiresAt:9999999999});finish(response(200,{accessToken:'unexpected',refreshToken:'unexpected',user:{id:'first'}}));await assert.rejects(()=>pending,/Akun sudah berubah/);assert.equal(getSession().accessToken,'second');
});
