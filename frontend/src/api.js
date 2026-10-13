const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4100/api';

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

export async function api(path, options = {}) {
  const session = getSession();
  const headers = { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) };
  if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `Request gagal (${response.status})`);
  return payload;
}

export const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  if (!file) return resolve(null);
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

export const todayString = () => new Date().toISOString().slice(0, 10);
export const addDaysString = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
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
