const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:4100/api';

export const getSession = () => {
  try {
    return JSON.parse(localStorage.getItem('transrent.session') || 'null');
  } catch {
    return null;
  }
};

export const setSession = (session) => {
  if (session) localStorage.setItem('transrent.session', JSON.stringify(session));
  else localStorage.removeItem('transrent.session');
};

let refreshing = null;
const refreshSession = async () => {
  if (refreshing) return refreshing;
  const previous = getSession();
  if (!previous?.refreshToken) throw new Error('Sesi berakhir. Silakan login ulang.');
  refreshing = (async () => {
    const response = await fetch(`${API_URL}/auth/refresh`, { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken:previous.refreshToken}) });
    const result=await response.json();
    if (getSession()?.refreshToken !== previous.refreshToken) throw new Error('Akun sudah berubah. Ulangi permintaan.');
    if (!response.ok) { setSession(null); window.dispatchEvent(new Event('transrent:expired')); throw new Error(result.message||'Sesi berakhir. Silakan login ulang.'); }
    setSession(result); window.dispatchEvent(new Event('transrent:session')); return result;
  })().finally(()=>{refreshing=null;});
  return refreshing;
};
async function authenticatedFetch(path, options={}) {
  const initialActor=getSession()?.user?.id;let usedToken;
  const isAuth=path.startsWith('/auth/') && !path.startsWith('/auth/me');
  if(!isAuth && getSession()?.refreshToken && getSession().expiresAt && getSession().expiresAt*1000<Date.now()+30000) await refreshSession();
  const send=()=>{if(!isAuth&&getSession()?.user?.id!==initialActor)throw new Error('Akun sudah berubah. Ulangi permintaan.');usedToken=getSession()?.accessToken;return fetch(`${API_URL}${path}`,{...options,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...options.headers,...(!isAuth && getSession()?.accessToken?{Authorization:`Bearer ${getSession().accessToken}`}:{})}});};
  let response=await send();
  if(response.status===401&&!isAuth){
    if(getSession()?.user?.id!==initialActor)throw new Error('Akun sudah berubah. Ulangi permintaan.');
    if(getSession()?.accessToken&&getSession().accessToken!==usedToken)response=await send();
    if(response.status===401&&getSession()?.refreshToken){await refreshSession();response=await send();}
    if(response.status===401){setSession(null);window.dispatchEvent(new Event('transrent:expired'));throw new Error('Sesi berakhir. Silakan login ulang.');}
  }
  return response;
}
export async function api(path,options={}){
  const response=await authenticatedFetch(path,options);
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.message||`Request gagal (${response.status})`);return payload;
}
export async function downloadFile(path,name){
  const response=await authenticatedFetch(path);
  if(!response.ok)throw new Error((await response.json().catch(()=>({}))).message||'Download gagal.');
  const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  if (!file) return resolve(null);
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

export const todayString = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Makassar',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const addDaysString = (days) => {
  const date = new Date(`${todayString()}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export const formatCurrency = (value) => new Intl.NumberFormat('id-ID', {
  style: 'currency', currency: 'IDR', maximumFractionDigits: 0
}).format(Number(value || 0));

export const formatDate = (value) => value ? new Intl.DateTimeFormat('id-ID', {
  day: '2-digit', month: 'short', year: 'numeric'
}).format(new Date(value)) : '-';

export const formatDateTime = (value) => value ? new Intl.DateTimeFormat('id-ID', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
}).format(new Date(value)) : '-';
