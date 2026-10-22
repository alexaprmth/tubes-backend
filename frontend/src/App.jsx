import { PaymentsPage,PaymentDialog,FineCheckout,MasterPage,InvitationsPage,InviteAcceptance } from './BusinessPages.jsx';
import OnlineMouModal from './OnlineMouModal.jsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet';
import {
  addDaysString,
  api,
  downloadFile,
  fileToDataUrl,
  formatCurrency,
  formatDate,
  formatDateTime,
  getSession,
  setSession,
  todayString
} from './api.js';

const DEFAULT_LOCATION = { latitude: -8.68, longitude: 115.21 };

const roleLabels = {
  CUSTOMER: 'Customer',
  STAFF: 'Staff Rental',
  RENTAL_ADMIN: 'Admin Rental',
  CENTRAL_ADMIN: 'Admin Pusat'
};

const statusLabels = {
  PENDING_PAYMENT: 'Menunggu pembayaran',
  CONFIRMED: 'Dikonfirmasi',
  RENTED: 'Sedang disewa',
  EXPIRED: 'Kadaluarsa',
  CANCELLED: 'Dibatalkan',
  ACTIVE: 'Rental aktif',
  RETURN_PENDING_REVIEW: 'Menunggu review return',
  COMPLETED: 'Selesai',
  AVAILABLE: 'Tersedia',
  MAINTENANCE: 'Maintenance',
  RETURN_INSPECTION: 'Inspeksi return',
  READY: 'GPS siap',
  FAULTY: 'GPS bermasalah',
  VERIFIED: 'Terverifikasi',
  PENDING: 'Menunggu verifikasi',
  REJECTED: 'Ditolak',
  ISSUED: 'Diterbitkan',
  DISPUTED: 'Disengketakan',
  OPEN: 'Menunggu keputusan',
  ACCEPTED: 'Sengketa diterima',
  ADJUSTED: 'Disesuaikan',
  APPROVED: 'Disetujui',
  APPROVED_SIMULATED: 'Refund disetujui (simulasi)',
  REFUNDED_SIMULATED: 'Dikembalikan (transaksi demo lama)',
  REFUND_PENDING:'Menunggu pencatatan refund',
  REFUNDED_INTERNAL:'Refund internal tercatat',
  PAID:'Dibayar',
  NOT_REQUIRED: 'Tidak diperlukan'
};

const agreementStatusLabels = {
  DRAFT: 'Draft',
  PENDING: 'Menunggu review',
  ACTIVE: 'Aktif',
  EXPIRED: 'Kadaluarsa',
  REVOKED: 'Dicabut'
};

const navByRole = {
  CUSTOMER: [
    ['SEARCH', 'Cari kendaraan', '⌕'],
    ['RESERVATIONS', 'Reservasi saya', '▤'],
    ['RENTALS', 'Rental & denda', '◉'],
    ['PAYMENTS', 'Transaksi', '▤'],
    ['PROFILE', 'Profil', '◎']
  ],
  STAFF: [
    ['HANDOVER', 'Handover hari ini', '↗'],
    ['RETURNS', 'Return hari ini', '↙'],
    ['TRACKING', 'Tracking kendaraan', '⌁']
  ],
  RENTAL_ADMIN: [
    ['OVERVIEW', 'Overview', '◈'],
    ['PAYMENTS', 'Transaksi', '▤'],
    ['MASTER', 'Cabang, GPS & kendaraan', '▣'],
    ['RESERVATIONS', 'Reservasi masuk', '▤'],
    ['RENTALS', 'Rental berjalan', '◉'],
    ['FLEET', 'Armada & GPS', '▣'],
    ['MAINTENANCE', 'Maintenance', '✦'],
    ['AGREEMENTS', 'MoU layanan', '⌁']
  ],
  CENTRAL_ADMIN: [
    ['OVERVIEW', 'Overview global', '◈'],
    ['PAYMENTS', 'Transaksi global', '▤'],
    ['MASTER', 'Data master', '▣'],
    ['INVITATIONS', 'Undangan admin', '◎'],
    ['RESERVATIONS', 'Reservasi', '▤'],
    ['RENTALS', 'Rental & sengketa', '◉'],
    ['MAINTENANCE', 'Maintenance', '✦'],
    ['CUSTOMERS', 'Verifikasi customer', '◎'],
    ['COMPANIES', 'Perusahaan rental', '▦'],
    ['AGREEMENTS', 'Manajemen MoU GPS', '⌁']
  ]
};

const pageMeta = {
  PAYMENTS:['Transaksi','Tagihan, pemeriksaan pembayaran dan pencatatan refund internal.'],
  MASTER:['Data master','Kelola cabang, perangkat GPS, kendaraan dan tarif.'],
  INVITATIONS:['Undangan admin','Lanjutkan setup dan undang ulang Admin Rental.'],
  SEARCH: ['Cari kendaraan', 'Temukan kendaraan yang tersedia dari perusahaan rental terdekat.'],
  RESERVATIONS: ['Reservasi', 'Pantau pembayaran dan status reservasi TransRent.'],
  RENTALS: ['Rental & penyelesaian', 'Pantau rental, sengketa, pelunasan denda dan refund deposit.'],
  PROFILE: ['Profil akun', 'Kelola informasi customer dan status verifikasi.'],
  HANDOVER: ['Handover hari ini', 'Catat kondisi kendaraan sebelum diserahkan; foto sementara placeholder opsional.'],
  RETURNS: ['Return hari ini', 'Dokumentasikan kondisi kendaraan setelah dikembalikan.'],
  TRACKING: ['Tracking kendaraan', 'Pantau posisi kendaraan dari GPS simulator.'],
  OVERVIEW: ['Overview', 'Ringkasan operasional TransRent.'],
  FLEET: ['Armada & GPS', 'Kelola status kendaraan dan kesiapan perangkat GPS.'],
  MAINTENANCE: ['Maintenance', 'Pantau kendaraan yang perlu perawatan.'],
  CUSTOMERS: ['Verifikasi customer', 'Review dokumen KTP dan SIM customer.'],
  COMPANIES: ['Perusahaan rental', 'Daftar perusahaan dan cabang yang terdaftar.'],
  AGREEMENTS: ['Manajemen MoU GPS', 'Kelola agreement GPS perusahaan rental dan izin tracking.']
};

const humanStatus = (value) => statusLabels[value] || String(value || '').replaceAll('_', ' ');
const humanAgreementStatus = (value) => agreementStatusLabels[value] || humanStatus(value);
const hasInteractiveTarget = (event) => Boolean(event.target.closest('button, a, input, select, textarea'));
const openDetailWithKeyboard = (event, callback) => {
  if (hasInteractiveTarget(event)) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  callback();
};

function App() {
  const [session, setSessionState] = useState(getSession);
  const [invite,setInvite] = useState(()=>{const h=new URLSearchParams(window.location.hash.slice(1)),q=new URLSearchParams(window.location.search);const type=h.get('type')||q.get('type');if(!['invite','recovery'].includes(type))return null;const callback={type,accessToken:h.get('access_token'),refreshToken:h.get('refresh_token'),tokenHash:q.get('token_hash')};window.history.replaceState({},'',window.location.pathname);return callback;});
  useEffect(()=>{const sync=()=>setSessionState(getSession());window.addEventListener('transrent:expired',sync);window.addEventListener('transrent:session',sync);return()=>{window.removeEventListener('transrent:expired',sync);window.removeEventListener('transrent:session',sync);};},[]);


  const logout = () => {
    setSession(null);
    setSessionState(null);
  };

  if (invite) return <InviteAcceptance callback={invite} onClose={()=>{setInvite(null);setSession(null);setSessionState(null);}} />;
  if (!session?.user) return <AuthPage onLoggedIn={setSessionState} />;
  return <Workspace session={session} onLogout={logout} onSessionUpdated={setSessionState} />;
}

function AuthPage({ onLoggedIn }) {
  const [localDemo,setLocalDemo]=useState(false);useEffect(()=>{api('/health').then(h=>setLocalDemo(h.authMode==='demo-in-memory')).catch(()=>{});},[]);
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', phone: '', address: '', ktpNumber: '', simNumber: '' });
  const [ktpFile, setKtpFile] = useState(null);
  const [simFile, setSimFile] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const fillDemo = (email) => {
    setMode('login');
    setField('email', email);
    setField('password', 'demo123');
    setError('');
    setMessage('Akun demo sudah dipilih. Klik Masuk untuk melanjutkan.');
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (mode === 'register') {
        const payload = {
          ...form,
          ktpDocument: ktpFile ? await fileToDataUrl(ktpFile) : null,
          simDocument: simFile ? await fileToDataUrl(simFile) : null
        };
        const registration = await api('/auth/register', { method: 'POST', body: JSON.stringify(payload) });
        setMode('login');
        setMessage(registration.message || 'Akun berhasil dibuat. Tunggu verifikasi Admin Pusat sebelum membayar reservasi.');
      } else {
        const result = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: form.email, password: form.password }) });
        setSession(result);
        onLoggedIn(result);
      }
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-hero">
        <div className="brand-mark large"><span>TR</span></div>
        <p className="eyebrow light">TRANSPORTATION RENTAL</p>
        <h1>Satu ruang kerja untuk rental yang lebih teratur.</h1>
        <p className="hero-copy">TransRent menghubungkan customer, staff, dan perusahaan rental dari pencarian kendaraan sampai tracking kendaraan aktif.</p>
        <div className="hero-points">
          <span><b>01</b> LBS perusahaan rental terdekat</span>
          <span><b>02</b> Inspeksi foto dua sisi</span>
          <span><b>03</b> Tracking kendaraan real-time</span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-card-heading">
            <p className="eyebrow">TRANSRENT</p>
            <h2>{mode === 'login' ? 'Selamat datang kembali' : 'Buat akun customer'}</h2>
            <p>{mode === 'login' ? 'Masuk ke workspace sesuai peranmu.' : 'Dokumen akan direview oleh Admin Pusat.'}</p>
          </div>
          <div className="auth-tabs">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')} type="button">Masuk</button>
            <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')} type="button">Register</button>
          </div>
          {message && <div className="notice success">{message}</div>}
          {error && <div className="notice danger">{error}</div>}
          <form onSubmit={submit} className="stack-form">
            {mode === 'register' && (
              <>
                <Field label="Nama lengkap" value={form.name} onChange={(value) => setField('name', value)} required />
                <div className="form-grid two"><Field label="Nomor telepon" value={form.phone} onChange={(value) => setField('phone', value)} required /><Field label="Alamat" value={form.address} onChange={(value) => setField('address', value)} required /></div>
                <div className="form-grid two"><Field label="Nomor KTP" value={form.ktpNumber} onChange={(value) => setField('ktpNumber', value)} required /><Field label="Nomor SIM" value={form.simNumber} onChange={(value) => setField('simNumber', value)} required /></div>
                <div className="form-grid two"><FileField label="Upload KTP" onChange={setKtpFile} /><FileField label="Upload SIM" onChange={setSimFile} /></div>
              </>
            )}
            <Field label="Email" type="email" value={form.email} onChange={(value) => setField('email', value)} required />
            <Field label="Password" type="password" value={form.password} onChange={(value) => setField('password', value)} required />
            <button className="primary-button wide" disabled={busy}>{busy ? 'Memproses...' : mode === 'login' ? 'Masuk ke TransRent' : 'Buat akun'}</button>
          </form>
          {mode === 'login' && localDemo && (
            <div className="demo-access">
              <div className="section-label">AKUN DEMO LOKAL</div>
              <div className="demo-buttons">
                <button type="button" onClick={() => fillDemo('customer@transrent.demo')}>Customer</button>
                <button type="button" onClick={() => fillDemo('staff@balimove.demo')}>Staff</button>
                <button type="button" onClick={() => fillDemo('admin@balimove.demo')}>Admin Rental</button>
                <button type="button" onClick={() => fillDemo('central@transrent.demo')}>Admin Pusat</button>
              </div>
              <p>Semua password demo: <code>demo123</code></p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function Workspace({ session, onLogout, onSessionUpdated }) {
  const actor = session.user;
  const initialPage = navByRole[actor.role]?.[0]?.[0] || 'SEARCH';
  const [page, setPage] = useState(initialPage);
  const [data, setData] = useState({ reservations: [], rentals: [], tracking: [], summary: null, customers: [], companies: [], fleet: [], maintenance: [], agreements: [], orders: [], loadErrors: [] });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const notify = useCallback((type, text) => {
    setToast({ type, text });
    window.setTimeout(() => setToast(null), 4500);
  }, []);

  const syncSessionUser = useCallback((nextUser) => {
    const currentSession = getSession();
    if (!nextUser || currentSession?.user?.id !== session.user.id || nextUser.id !== session.user.id || JSON.stringify(nextUser) === JSON.stringify(currentSession.user)) return;
    const nextSession = { ...currentSession, user: nextUser };
    setSession(nextSession);
    onSessionUpdated(nextSession);
  }, [onSessionUpdated, session]);

  const loadData = useCallback(async () => {
    if (getSession()?.user?.id !== actor.id) return;
    setBusy(true);
    const isCentral=actor.role==='CENTRAL_ADMIN',isAdmin=['CENTRAL_ADMIN','RENTAL_ADMIN'].includes(actor.role),isOperations=isAdmin||actor.role==='STAFF';
    const requests=[['me','/auth/me','user'],['reservations','/reservations','reservations'],['rentals','/rentals','rentals'],['tracking','/tracking/vehicles','vehicles'],['companies',isCentral?'/admin/companies':'/companies','companies'],
      ...(isAdmin?[['summary','/admin/summary','summary'],['orders','/payment-orders','orders']]:actor.role==='CUSTOMER'?[['orders','/payment-orders','orders']]:[]),
      ...(isCentral?[['customers','/admin/customers','customers']]:[]),...(isOperations?[['fleet','/admin/fleet','fleet'],['maintenance','/maintenance','maintenance']]:[]),
      ...(isAdmin?[['agreements',isCentral?'/admin/gps-agreements':'/rental/gps-agreements','agreements']]:[])];
    const results=await Promise.allSettled(requests.map(([,url])=>api(url)));
    if (getSession()?.user?.id !== actor.id) return;
    const next={},errors=[];
    results.forEach((result,i)=>{const [key,,field]=requests[i];if(result.status==='fulfilled'){if(key==='me')syncSessionUser(result.value.user);else next[key]=result.value[field];}else errors.push(`${key}: ${result.reason.message}`);});
    setData(current=>({...current,...next,loadErrors:errors,agreementError:errors.find(e=>e.startsWith('agreements:'))||null}));
    setLastRefresh(new Date());setBusy(false);
  }, [actor.role, syncSessionUser]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const refreshTimer = window.setInterval(() => {
      loadData();
    }, 10_000);
    return () => window.clearInterval(refreshTimer);
  }, [loadData]);

  const runAction = async (action, successMessage) => {
    try {
      await action();
      notify('success', successMessage);
      await loadData();
    } catch (error) {
      notify('danger', error.message);
    }
  };

  const meta = pageMeta[page] || pageMeta.OVERVIEW;
  const navItems = navByRole[actor.role] || navByRole.CUSTOMER;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand-row"><div className="brand-mark"><span>TR</span></div><div><strong>TransRent</strong><small>Transportation Rental</small></div></div>
          <div className="workspace-chip"><span className="pulse-dot" /> Local demo workspace</div>
        </div>
        <nav className="sidebar-nav">
          <div className="section-label">WORKSPACE</div>
          {navItems.map(([key, label, icon]) => <button key={key} title={label} aria-label={label} className={`nav-button ${page === key ? 'active' : ''}`} onClick={() => setPage(key)}><span className="nav-icon">{icon}</span><span>{label}</span></button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note"><span>⌁</span><div><strong>Transaksi internal</strong><small>Belum terhubung penyedia pembayaran.</small></div></div>
          <div className="user-mini"><div className="avatar">{actor.name?.slice(0, 1).toUpperCase()}</div><div className="user-mini-copy"><strong>{actor.name}</strong><small>{roleLabels[actor.role]}</small></div><button title="Keluar" onClick={onLogout}>↪</button></div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar"><div><p className="eyebrow">{roleLabels[actor.role]} workspace</p><h1>{meta[0]}</h1><p className="page-subtitle">{meta[1]}</p></div><div className="topbar-actions"><span className="last-sync">Sync {lastRefresh.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span><button className="icon-button" onClick={loadData} disabled={busy} title="Refresh data">↻</button><button type="button" className="small-button" onClick={onLogout}>Keluar</button><div className="avatar large-avatar">{actor.name?.slice(0, 1).toUpperCase()}</div></div></header>
        {toast && <div className={`toast ${toast.type}`}>{toast.type === 'success' ? '✓' : '!'} {toast.text}</div>}
        <div className="content-area">
          {data.loadErrors?.length>0&&<div className="notice danger" role="alert"><strong>Sebagian data gagal dimuat; data sebelumnya tetap ditampilkan.</strong><ul>{data.loadErrors.map(e=><li key={e}>{e}</li>)}</ul><button className="small-button" onClick={loadData}>Coba lagi</button></div>}
          {actor.role === 'CUSTOMER' && <CustomerPages page={page} actor={actor} data={data} onRefresh={loadData} onNotify={notify} onCreated={() => { loadData(); setPage('RESERVATIONS'); }} />}
          {actor.role !== 'CUSTOMER' && <OperationsPages page={page} actor={actor} data={data} onRefresh={loadData} onNotify={notify} runAction={runAction} />}
        </div>
      </main>
    </div>
  );
}

function CustomerPages({ page, actor, data, onRefresh, onNotify, onCreated }) {
  if(page==='PAYMENTS')return <PaymentsPage actor={actor} orders={data.orders||[]} onRefresh={onRefresh} onNotify={onNotify} />;
  if (page === 'SEARCH') return <SearchPage onCreated={onCreated} onNotify={onNotify} />;
  if (page === 'RESERVATIONS') return <CustomerReservations reservations={data.reservations} onRefresh={onRefresh} onNotify={onNotify} />;
  if (page === 'RENTALS') return <><RentalFinancePage actor={actor} rentals={data.rentals} onRefresh={onRefresh} onNotify={onNotify} /><TrackingPage tracking={data.tracking} onRefresh={onRefresh} onNotify={onNotify} /></>;
  return <ProfilePage actor={actor} />;
}

function OperationsPages({ page, actor, data, onRefresh, onNotify, runAction }) {
  if(page==='PAYMENTS')return <PaymentsPage actor={actor} orders={data.orders||[]} onRefresh={onRefresh} onNotify={onNotify} />;
  if(page==='MASTER')return <MasterPage actor={actor} companies={data.companies} onRefresh={onRefresh} onNotify={onNotify} />;
  if(page==='INVITATIONS')return <InvitationsPage companies={data.companies} onRefresh={onRefresh} onNotify={onNotify} />;
  if (page === 'OVERVIEW') return <OverviewPage actor={actor} summary={data.summary} reservations={data.reservations} rentals={data.rentals} />;
  if (page === 'HANDOVER') return <HandoverPage reservations={data.reservations} onRefresh={onRefresh} onNotify={onNotify} />;
  if (page === 'RETURNS') return <ReturnPage rentals={data.rentals} onRefresh={onRefresh} onNotify={onNotify} />;
  if (page === 'TRACKING') return <TrackingPage actor={actor} tracking={data.tracking} onRefresh={onRefresh} onNotify={onNotify} />;
  if (page === 'RESERVATIONS') return <AdminReservations reservations={data.reservations} onRefresh={onRefresh} onNotify={onNotify} actor={actor} />;
  if (page === 'RENTALS') return <AdminRentals rentals={data.rentals} onRefresh={onRefresh} onNotify={onNotify} actor={actor} />;
  if (page === 'FLEET') return <FleetPage fleet={data.fleet} />;
  if (page === 'MAINTENANCE') return <MaintenancePage maintenance={data.maintenance} fleet={data.fleet} runAction={runAction} actor={actor} />;
  if (page === 'CUSTOMERS') return <CentralCustomers customers={data.customers} runAction={runAction} />;
  if (page === 'COMPANIES') return <CompaniesPage companies={data.companies} onRefresh={onRefresh} onNotify={onNotify} runAction={runAction} />;
  if (page === 'AGREEMENTS' && actor.role === 'RENTAL_ADMIN') return <OwnerMouPage actor={actor} agreements={data.agreements} loadError={data.agreementError} onRefresh={onRefresh} onNotify={onNotify} />;
  if (page === 'AGREEMENTS') return <GpsAgreementsPage agreements={data.agreements} companies={data.companies} onRefresh={onRefresh} onNotify={onNotify} />;
  return <OverviewPage actor={actor} summary={data.summary} reservations={data.reservations} rentals={data.rentals} />;
}

function SearchPage({ onCreated, onNotify }) {
  const [filters, setFilters] = useState({ latitude: DEFAULT_LOCATION.latitude, longitude: DEFAULT_LOCATION.longitude, startDate: todayString(), endDate: addDaysString(2), type: 'ALL' });
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);

  const update = (key, value) => setFilters((current) => ({ ...current, [key]: value }));
  const useBrowserLocation = () => {
    if (!navigator.geolocation) return onNotify('danger', 'Browser tidak menyediakan Geolocation API.');
    navigator.geolocation.getCurrentPosition((position) => {
      update('latitude', position.coords.latitude);
      update('longitude', position.coords.longitude);
      onNotify('success', 'Lokasi browser berhasil digunakan.');
    }, () => onNotify('danger', 'Lokasi browser tidak dapat diakses.'));
  };
  const search = async (event) => {
    event?.preventDefault();
    setBusy(true);
    try {
      const query = new URLSearchParams(filters).toString();
      const response = await api(`/branches/search?${query}`);
      setResults(response.results || []);
      setSearched(true);
      setSelected(null);
    } catch (error) {
      onNotify('danger', error.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="page-stack">
      <section className="search-hero"><div><span className="mini-kicker">LOCATION-BASED SEARCH</span><h2>Temukan kendaraan yang <em>feasible</em> untukmu.</h2><p>TransRent memeriksa lokasi, periode rental, availability, dan GPS sebelum menampilkan rekomendasi.</p></div><button className="secondary-button" onClick={useBrowserLocation}>⌖ Gunakan lokasi browser</button></section>
      <form className="filter-card" onSubmit={search}><div className="filter-title"><div><span className="section-label">SEARCH PARAMETERS</span><strong>Atur kebutuhan perjalanan</strong></div><span className="location-pill">● {Number(filters.latitude).toFixed(3)}, {Number(filters.longitude).toFixed(3)}</span></div><div className="form-grid search-grid"><label className="field"><span>Mulai rental</span><input type="date" value={filters.startDate} onChange={(event) => update('startDate', event.target.value)} /></label><label className="field"><span>Selesai rental</span><input type="date" value={filters.endDate} onChange={(event) => update('endDate', event.target.value)} /></label><label className="field"><span>Tipe kendaraan</span><select value={filters.type} onChange={(event) => update('type', event.target.value)}><option value="ALL">Semua tipe</option><option value="CAR">Mobil</option><option value="MOTORCYCLE">Motor</option></select></label><button className="primary-button search-button" disabled={busy}>{busy ? 'Mencari...' : 'Cari kendaraan →'}</button></div></form>
      <div className="results-layout"><div className="map-wrap"><MapPanel results={results} /><div className="map-caption"><span className="map-legend blue" /> Cabang feasible <span className="map-legend muted" /> Radius delivery maksimal 15 km</div></div><div className="results-panel"><div className="results-heading"><div><span className="section-label">RECOMMENDATION</span><h3>{searched ? `${results.length} kendaraan ditemukan` : 'Belum ada pencarian'}</h3></div>{searched && <span className="sort-chip">Terdekat dulu</span>}</div>{searched && results.length === 0 && <EmptyState title="Belum ada kendaraan yang cocok" text="Coba ubah tipe atau periode rental." />}{!searched && <EmptyState title="Mulai dari lokasi dan periode" text="Hasil cabang serta kendaraan akan muncul di sini." />}{results.map((vehicle) => <VehicleCard key={vehicle.id} vehicle={vehicle} selected={selected?.id === vehicle.id} onSelect={() => setSelected(vehicle)} />)}</div></div>
      {selected && <ReservationPanel vehicle={selected} filters={filters} onCreated={onCreated} onNotify={onNotify} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ReservationPanel({ vehicle, filters, onCreated, onNotify, onClose }) {
  const [pickupMode, setPickupMode] = useState('PICKUP');
  const [delivery, setDelivery] = useState({ address: '', latitude: filters.latitude, longitude: filters.longitude, recipientPhone: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const days = Math.max(1, Math.ceil((new Date(filters.endDate) - new Date(filters.startDate)) / 86_400_000));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/reservations', { method: 'POST', body: JSON.stringify({ vehicleId: vehicle.id, startDate: filters.startDate, endDate: filters.endDate, pickupMode, deliveryAddress: delivery.address, deliveryLatitude: delivery.latitude, deliveryLongitude: delivery.longitude, recipientPhone: delivery.recipientPhone, deliveryNotes: delivery.notes }) });
      onNotify('success', 'Reservasi dibuat. Silakan selesaikan simulasi pembayaran.');
      onCreated();
    } catch (error) { onNotify('danger', error.message); } finally { setBusy(false); }
  };
  return <div className="drawer-backdrop"><aside className="reservation-drawer"><div className="drawer-header"><div><span className="section-label">CHECKOUT</span><h3>Konfirmasi reservasi</h3></div><button className="close-button" onClick={onClose}>×</button></div><div className="checkout-vehicle"><img src={vehicle.image} alt="" /><div><strong>{vehicle.name}</strong><span>{vehicle.company.name} · {vehicle.branch.name}</span><small>{formatCurrency(vehicle.pricePerDay)}/hari · {days} hari</small></div></div><form className="stack-form" onSubmit={submit}><div className="choice-grid"><button type="button" className={pickupMode === 'PICKUP' ? 'choice active' : 'choice'} onClick={() => setPickupMode('PICKUP')}><strong>Ambil di cabang</strong><small>{vehicle.branch.address}</small></button><button type="button" disabled={!vehicle.deliveryAllowed} className={pickupMode === 'DELIVERY' ? 'choice active' : 'choice'} onClick={() => setPickupMode('DELIVERY')}><strong>Diantar ke saya</strong><small>{vehicle.deliveryAllowed ? `Maks. ${vehicle.deliveryRadiusKm} km · tanpa biaya` : 'Di luar radius delivery'}</small></button></div>{pickupMode === 'DELIVERY' && <div className="delivery-box"><Field label="Alamat lengkap" value={delivery.address} onChange={(value) => setDelivery((current) => ({ ...current, address: value }))} required /><div className="form-grid two"><Field label="Nomor penerima" value={delivery.recipientPhone} onChange={(value) => setDelivery((current) => ({ ...current, recipientPhone: value }))} required /><Field label="Catatan" value={delivery.notes} onChange={(value) => setDelivery((current) => ({ ...current, notes: value }))} /></div><p className="helper-text">Lokasi delivery mengikuti lokasi pencarian: {Number(filters.latitude).toFixed(4)}, {Number(filters.longitude).toFixed(4)}.</p></div>}<div className="checkout-summary"><span>Biaya sewa <b>{formatCurrency(vehicle.pricePerDay * days)}</b></span><span>Deposit <b>{formatCurrency(vehicle.deposit)}</b></span><span className="total-line">Total simulasi <strong>{formatCurrency(vehicle.pricePerDay * days + vehicle.deposit)}</strong></span></div><button className="primary-button wide" disabled={busy}>{busy ? 'Menyimpan...' : 'Buat reservasi →'}</button></form></aside></div>;
}

function VehicleCard({ vehicle, selected, onSelect }) {
  return <article className={`vehicle-card ${selected ? 'selected' : ''}`} onClick={onSelect}><img src={vehicle.image} alt="" /><div className="vehicle-card-body"><div className="vehicle-card-top"><div><span className="vehicle-type">{vehicle.type === 'CAR' ? 'MOBIL' : 'MOTOR'}</span><h4>{vehicle.name}</h4></div><span className="distance-badge">{vehicle.distanceKm} km</span></div><p className="muted-line">{vehicle.company.name} · {vehicle.branch.name}</p><div className="vehicle-specs"><span>◌ {vehicle.transmission}</span><span>♧ {vehicle.seats} kursi</span><span className={vehicle.gpsStatus === 'READY' ? 'gps-ready' : 'gps-warning'}>⌁ {humanStatus(vehicle.gpsStatus)}</span></div><div className="vehicle-card-bottom"><div><strong>{formatCurrency(vehicle.pricePerDay)}</strong><small>/ hari</small></div><button className="small-button">Pilih →</button></div></div></article>;
}

function CustomerReservations({ reservations, onRefresh, onNotify }) {
  const [order,setOrder]=useState(null);
  const [selected, setSelected] = useState(null);
  const [finance, setFinance] = useState(null);
  const pay = async (id) => {
    try {
      const result=await api(`/reservations/${id}/checkout`, { method: 'POST' });setOrder(result.order);
      onNotify('success', 'Tagihan dibuat. Pencatatan customer akan diperiksa admin sebelum dianggap lunas.');
      onRefresh();
      return true;
    } catch (error) {
      onNotify('danger', error.message);
      return false;
    }
  };
  return <div className="page-stack"><SectionIntro eyebrow="MY RESERVATIONS" title="Semua reservasi dalam satu tempat" text="Bayar reservasi yang masih pending atau lihat detail perjalananmu." /><div className="list-stack">{reservations.length === 0 ? <EmptyState title="Belum ada reservasi" text="Cari kendaraan untuk membuat reservasi pertamamu." /> : reservations.map((reservation) => <ReservationRow key={reservation.id} reservation={reservation} onDetail={setSelected} action={<>{reservation.status === 'PENDING_PAYMENT' && <button type="button" className="small-button primary" onClick={() => pay(reservation.id)}>Checkout pembayaran</button>}{['PENDING_PAYMENT','CONFIRMED'].includes(reservation.status) && <button type="button" className="small-button danger" onClick={() => setFinance({ kind: 'CANCEL', target: reservation })}>Batalkan reservasi</button>}</>} />)}</div>{order&&<PaymentDialog actor={{role:"CUSTOMER"}} order={order} onClose={()=>setOrder(null)} onDone={onRefresh} />}{finance && <FinanceModal {...finance} onClose={() => setFinance(null)} onRefresh={onRefresh} onNotify={onNotify} />}{selected && <ReservationDetailDrawer reservation={selected} onClose={() => setSelected(null)} onPay={async () => { if (await pay(selected.id)) setSelected(null); }} />}</div>;
}

function AdminReservations({ reservations, onRefresh, onNotify, actor }) {
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [finance, setFinance] = useState(null);
  const confirmed = reservations.filter((reservation) => reservation.status === 'CONFIRMED');
  return <div className="page-stack"><SectionIntro eyebrow="RESERVATION INBOX" title="Reservasi yang perlu diproses" text="Handover hanya tersedia setelah pembayaran berhasil dan GPS kendaraan READY." /><div className="list-stack">{reservations.length === 0 ? <EmptyState title="Inbox masih kosong" text="Belum ada reservasi dari customer." /> : reservations.map((reservation) => <ReservationRow key={reservation.id} reservation={reservation} onDetail={setDetail} action={<>{reservation.status === 'CONFIRMED' && <button type="button" className="small-button primary" onClick={() => setSelected(reservation)}>Mulai handover</button>}{['PENDING_PAYMENT','CONFIRMED'].includes(reservation.status) && <button type="button" className="small-button danger" onClick={() => setFinance({ kind: 'CANCEL', target: reservation })}>Batalkan reservasi</button>}</>} />)}</div>{finance && <FinanceModal {...finance} onClose={() => setFinance(null)} onRefresh={onRefresh} onNotify={onNotify} />}{detail && <ReservationDetailDrawer reservation={detail} showCustomer onClose={() => setDetail(null)} />}{selected && <InspectionModal mode="BEFORE" target={{ reservation: selected }} onClose={() => setSelected(null)} onDone={() => { setSelected(null); onNotify('success', 'Handover dan inspeksi BEFORE berhasil disimpan.'); onRefresh(); }} actor={actor} />}</div>;
}

function HandoverPage({ reservations, onRefresh, onNotify }) {
  const [selected, setSelected] = useState(null);
  const confirmed = reservations.filter((reservation) => reservation.status === 'CONFIRMED');
  return <div className="page-stack"><SectionIntro eyebrow="STAFF DESK" title="Handover hari ini" text="Isi checklist dan catatan kondisi. Foto/tanda tangan opsional sebagai placeholder, belum diverifikasi." /><div className="action-grid">{confirmed.length === 0 ? <EmptyState title="Tidak ada handover tertunda" text="Reservasi yang sudah dibayar akan muncul di sini." /> : confirmed.map((reservation) => <article className="task-card" key={reservation.id}><div className="task-card-head"><span className="task-icon">↗</span><StatusBadge value={reservation.status} /></div><strong>{reservation.vehicle.name}</strong><span>{reservation.customer.name} · {formatDate(reservation.startDate)}</span><small>{reservation.pickupMode === 'DELIVERY' ? 'Delivery ke customer' : reservation.branch?.name}</small><button className="secondary-button" onClick={() => setSelected(reservation)}>Buka inspeksi BEFORE</button></article>)}</div>{selected && <InspectionModal mode="BEFORE" target={{ reservation: selected }} onClose={() => setSelected(null)} onDone={() => { setSelected(null); onNotify('success', 'Handover berhasil disimpan.'); onRefresh(); }} />}</div>;
}

function ReturnPage({ rentals, onRefresh, onNotify }) {
  const [selected, setSelected] = useState(null);
  const active = rentals.filter((rental) => rental.status === 'ACTIVE');
  return <div className="page-stack"><SectionIntro eyebrow="RETURN DESK" title="Return kendaraan" text="Catat hasil inspeksi dan kerusakan sebelum refund. Foto sementara placeholder opsional." /><div className="action-grid">{active.length === 0 ? <EmptyState title="Tidak ada rental aktif" text="Rental aktif akan muncul di sini saat handover selesai." /> : active.map((rental) => <article className="task-card" key={rental.id}><div className="task-card-head"><span className="task-icon return">↙</span><StatusBadge value={rental.status} /></div><strong>{rental.vehicle.name}</strong><span>{rental.customer.name} · selesai {formatDate(rental.endDate)}</span><small>{rental.vehicle.branch.name}</small><button className="secondary-button" onClick={() => setSelected(rental)}>Buka inspeksi AFTER</button></article>)}</div>{selected && <InspectionModal mode="AFTER" target={{ rental: selected }} onClose={() => setSelected(null)} onDone={() => { setSelected(null); onNotify('success', 'Return dan inspeksi AFTER berhasil disimpan.'); onRefresh(); }} />}</div>;
}

function AdminRentals(props) { return <RentalFinancePage {...props} />; }

function RentalFinancePage({ actor, rentals, onRefresh, onNotify }) {
  const [finance, setFinance] = useState(null);
  const [detail, setDetail] = useState(null);
  const isCustomer = actor.role === 'CUSTOMER';
  const isAdmin = ['RENTAL_ADMIN','CENTRAL_ADMIN'].includes(actor.role);
  return <div className="page-stack"><SectionIntro eyebrow="RENTAL SETTLEMENT" title={isCustomer ? 'Rental, denda dan refund saya' : 'Review return dan penyelesaian sengketa'} text="Deposit digunakan untuk denda. Selesaikan sengketa dan lunasi selisih denda sebelum admin menutup rental. Pembayaran dicatat melalui tagihan internal dan diperiksa admin. Belum terhubung bank/Midtrans." />
    {!rentals.length && <EmptyState title="Belum ada rental" text="Rental muncul setelah handover." />}
    {rentals.map((rental) => <article className="panel" key={rental.id}>
      <div className="panel-heading"><div><h3>{rental.vehicle?.name || rental.id}</h3><p>{rental.customer?.name} · {formatDate(rental.startDate)}—{formatDate(rental.endDate)}</p></div><StatusBadge value={rental.status} /></div>
      <button className="small-button" onClick={() => setDetail(rental)}>Lihat detail rental</button>
      {rental.settlement && <div className="detail-pricing"><DetailPrice label="Deposit" value={rental.reservation?.depositAmount || 0} /><DetailPrice label="Total denda saat ini" value={rental.settlement.fineTotal} /><DetailPrice label="Deposit terpakai" value={rental.settlement.depositApplied} /><DetailPrice label="Selisih belum dibayar" value={rental.settlement.balanceDue} /><DetailPrice label="Sisa deposit untuk refund" value={rental.settlement.refundAmount} /></div>}
      {(rental.fines || []).map((fine) => <div className="detail-section" key={fine.id}><strong>Denda {formatCurrency(fine.amount)} · {humanStatus(fine.status)}</strong><ul>{(fine.damageItems || []).map((item, i) => <li key={i}>{typeof item === 'string' ? item : `${item.label || item.name || item.description || item.type || 'Kerusakan'}: ${formatCurrency(item.amount)}`}</li>)}</ul>
        {isCustomer && rental.status === 'RETURN_PENDING_REVIEW' && !rental.finePayment && ['ISSUED','ADJUSTED'].includes(fine.status) && <button className="small-button" onClick={() => setFinance({ kind: 'DISPUTE', target: fine })}>Ajukan sengketa</button>}
        {(rental.disputes || []).filter((d) => d.fineId === fine.id).map((d) => <div className="notice" key={d.id}><strong>Sengketa: {humanStatus(d.status)}</strong><p>Alasan customer: {d.reason}</p>{d.resolvedAt && <><p>Keputusan admin: {d.resolutionNotes}</p><p>{d.originalAmount != null && d.finalAmount != null ? `${formatCurrency(d.originalAmount)} → ${formatCurrency(d.finalAmount)}` : 'Nominal historis tidak tercatat'} · {formatDateTime(d.resolvedAt)}</p></>}{isAdmin && d.status === 'OPEN' && <button className="small-button primary" onClick={() => setFinance({ kind: 'RESOLVE', target: { ...d, fineAmount: fine.amount } })}>Putuskan sengketa</button>}</div>)}
      </div>)}
      {rental.finePayment && <div className="notice success">Pelunasan tercatat {formatCurrency(rental.finePayment.amount)} · {formatDateTime(rental.finePayment.paidAt)} · Bukti {rental.finePayment.id}</div>}
      {rental.settlement?.disputed && <p className="red-text">Sengketa terbuka: pembayaran selisih dan penutupan rental ditunda.</p>}
      {isCustomer && rental.settlement?.balanceDue > 0 && !rental.settlement.disputed && <button className="primary-button" onClick={() => setFinance({ kind: 'PAY_FINE', target: rental })}>Checkout selisih denda</button>}
      {isAdmin && rental.refund?.status === 'PENDING_CONFIRMATION' && <button className="primary-button" disabled={rental.settlement?.disputed || rental.settlement?.balanceDue > 0} onClick={() => setFinance({ kind: 'REFUND', target: rental })}>Review & setujui penyelesaian</button>}
      {isAdmin&&rental.refund?.provider==='INTERNAL_MANUAL'&&rental.refund?.status==='APPROVED'&&rental.refund.amount>0&&<button className="primary-button" onClick={()=>setFinance({kind:'REFUND_PAID',target:rental})}>Catat pembayaran refund deposit</button>}{rental.refund && <p>Refund: {formatCurrency(rental.refund.amount)} · {rental.refund.provider==='INTERNAL_MANUAL'&&rental.refund.status==='APPROVED'?'Disetujui — menunggu pencatatan pengembalian':humanStatus(rental.refund.status)}</p>}
      {rental.vehicle?.repairRequired && <p className="red-text">Kendaraan perlu REPAIR selesai sebelum tersedia kembali.</p>}
    </article>)}
    {finance && <FinanceModal {...finance} onClose={() => setFinance(null)} onRefresh={onRefresh} onNotify={onNotify} />}
    {detail && <RentalDetailDrawer rental={detail} onClose={() => setDetail(null)} />}
  </div>;
}

function FinanceModal(props) { return props.kind==='PAY_FINE' ? <FineCheckout {...props} actor={{role:'CUSTOMER'}} /> : <FinanceActionModal {...props} />; }
function FinanceActionModal({ kind, target, onClose, onRefresh, onNotify }) {
  const dialogRef = useRef(null);
  const busyRef = useRef(false);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    const controls = () => [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')];
    (controls()[0] || dialog).focus();
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!busyRef.current) onClose(); }
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0]; const last = items[items.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);

  const [reason, setReason] = useState('');
  const [decision, setDecision] = useState('REJECTED');
  const [amount, setAmount] = useState(String(target.fineAmount || 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  busyRef.current = busy;
  const title = { REFUND_PAID:'Catat pembayaran refund deposit', CANCEL: 'Batalkan reservasi', DISPUTE: 'Ajukan sengketa denda', RESOLVE: 'Putuskan sengketa', PAY_FINE: 'Pelunasan selisih denda', REFUND: 'Konfirmasi refund dan penutupan' }[kind];
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    const endpoint = { REFUND_PAID:`/rentals/${target.id}/refund/paid`, CANCEL: `/reservations/${target.id}/cancel`, DISPUTE: `/fines/${target.id}/disputes`, RESOLVE: `/disputes/${target.id}/resolve`, PAY_FINE: `/rentals/${target.id}/fine-payments/simulate`, REFUND: `/rentals/${target.id}/refund/confirm` }[kind];
    const body = kind === 'RESOLVE' ? { decision, notes: reason, ...(decision === 'ADJUSTED' ? { amount: Number(amount) } : {}) } : kind==='REFUND_PAID' ? {reference:reason} : { reason };
    try {
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      onNotify('success', `${title} berhasil disimpan.`); await onRefresh(); onClose();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section ref={dialogRef} tabIndex={-1} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="finance-title" aria-busy={busy}><div className="drawer-header"><h3 id="finance-title">{title}</h3><button type="button" aria-label="Tutup" className="close-button" disabled={busy} onClick={onClose}>×</button></div>
    {error && <div className="notice danger" role="alert">{error}</div>}
    <form className="stack-form" onSubmit={submit}>
      {kind === 'CANCEL' && <p>Hanya sebelum handover. Pembayaran internal yang sudah lunas membuat permintaan refund penuh; admin mencatat pengembaliannya di menu Transaksi. Belum dibayar: tidak ada refund.</p>}
      {kind === 'RESOLVE' && <><p>Alasan customer: {target.reason}. Denda awal {formatCurrency(target.fineAmount)}. Keputusan final dicatat bersama akun admin dan waktu keputusan.</p><label className="field"><span>Keputusan</span><select value={decision} disabled={busy} onChange={(e) => setDecision(e.target.value)}><option value="REJECTED">Tolak sengketa — pertahankan denda</option><option value="ACCEPTED">Terima sengketa — hapus denda</option><option value="ADJUSTED">Sesuaikan nominal denda</option></select></label>{decision === 'ADJUSTED' && <label className="field"><span>Denda akhir (Rp)</span><input type="number" min="0" max={target.fineAmount} step="1" value={amount} required disabled={busy} onChange={(e) => setAmount(e.target.value)} /></label>}<small>Penghapusan denda tidak menghapus kebutuhan perbaikan kendaraan.</small></>}
      {['CANCEL','DISPUTE','RESOLVE','REFUND_PAID'].includes(kind) && <label className="field"><span>{kind==='REFUND_PAID'?'Referensi pembayaran refund':kind === 'RESOLVE' ? 'Alasan keputusan admin' : 'Alasan'}</span><textarea required maxLength={2000} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} /></label>}
      {kind === 'PAY_FINE' && <><p>Total denda {formatCurrency(target.settlement?.fineTotal)}, setelah deposit: bayar {formatCurrency(target.settlement?.balanceDue)} melalui simulator. Tidak ada uang nyata ditransfer.</p><label><input type="checkbox" required disabled={busy} /> Saya menyetujui denda final. Setelah dilunasi, denda ini tidak dapat disengketakan kembali.</label></>}
      {kind === 'REFUND' && <p>Refund deposit {formatCurrency(target.settlement?.refundAmount)} akan disetujui untuk pencatatan refund. Jika nominal refund lebih dari nol, rental menunggu pencatatan pembayaran refund sebelum ditutup. Kendaraan rusak tetap MAINTENANCE sampai REPAIR selesai.</p>}
      <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Kembali</button><button className="primary-button" disabled={busy}>{busy ? 'Memproses...' : title}</button></div>
    </form>
  </section></div>;
}

function TrackingPage({ tracking, onRefresh, onNotify }) {
  const markers = tracking.filter((item) => item.latestLocation).map((item) => ({ latitude: item.latestLocation.latitude, longitude: item.latestLocation.longitude, label: item.vehicle.name, detail: `${item.customer?.name || ''} · ${formatDateTime(item.latestLocation.recordedAt)}` }));
  return <div className="page-stack"><div className="section-split"><SectionIntro eyebrow="LIVE TELEMETRY" title="Tracking kendaraan" text="Lokasi terakhir berasal dari GPS simulator dan tersimpan sebagai histori." /><button className="secondary-button" onClick={onRefresh}>↻ Refresh lokasi</button></div><div className="tracking-layout"><div className="map-wrap tall"><MapPanel locations={markers} /><div className="map-floating"><span className="pulse-dot" /> Auto-refresh 10 detik</div></div><div className="tracking-list"><div className="section-label">ACTIVE RENTALS</div>{tracking.length === 0 ? <EmptyState title="Belum ada kendaraan aktif" text="Lokasi akan muncul setelah handover." /> : tracking.map((item) => <div className="tracking-item" key={item.rentalId}><span className="live-indicator" /><div><strong>{item.vehicle.name}</strong><span>{item.customer?.name}</span><small>{item.latestLocation ? `${item.latestLocation.latitude.toFixed(4)}, ${item.latestLocation.longitude.toFixed(4)}` : 'Menunggu telemetry'}</small></div><span className="tracking-time">{item.latestLocation ? formatDateTime(item.latestLocation.recordedAt) : '-'}</span></div>)}</div></div></div>;
}

function OverviewPage({ actor, summary, reservations, rentals }) {
  const cards = actor.role === 'CENTRAL_ADMIN' ? [['companies', 'Perusahaan rental', '◫'], ['branches', 'Cabang aktif', '⌖'], ['verifiedCustomers', 'Customer verified', '◎'], ['activeRentals', 'Rental aktif', '◉']] : [['availableVehicles', 'Kendaraan tersedia', '▣'], ['pendingReservations', 'Reservasi pending', '▤'], ['activeRentals', 'Rental aktif', '◉'], ['maintenanceVehicles', 'Perlu perhatian', '✦']];
  return <div className="page-stack"><section className="welcome-card"><div><span className="mini-kicker">OPERATIONS SNAPSHOT</span><h2>Selamat datang, {actor.name?.split(' ')[0]}.</h2><p>Monitor alur rental tanpa kehilangan detail penting di lapangan.</p></div><div className="welcome-orb">TR</div></section><div className="metric-grid">{cards.map(([key, label, icon]) => <div className="metric-card" key={key}><span className="metric-icon">{icon}</span><small>{label}</small><strong>{summary?.[key] ?? 0}</strong><span className="metric-note">live dari workspace</span></div>)}</div><div className="two-column"><div className="panel"><div className="panel-heading"><div><span className="section-label">RECENT RESERVATIONS</span><h3>Aktivitas terbaru</h3></div><span className="soft-chip">{reservations.length} total</span></div>{reservations.slice(0, 4).map((reservation) => <ReservationMini key={reservation.id} reservation={reservation} />)}{reservations.length === 0 && <EmptyState title="Belum ada aktivitas" text="Data akan muncul saat customer mulai booking." />}</div><div className="panel accent-panel"><div className="panel-heading"><div><span className="section-label">RENTAL FLOW</span><h3>Alur kerja TransRent</h3></div></div><FlowStep number="01" title="Search & checkout" text="Customer menemukan kendaraan feasible." done={false} /><FlowStep number="02" title="Handover & inspeksi" text="Staff menyimpan foto dan tanda tangan." done={false} /><FlowStep number="03" title="Tracking & return" text="Lokasi dan kondisi tercatat sampai selesai." done={false} /></div></div></div>;
}

function ProfilePage({ actor }) {
  const isVerified = actor.verificationStatus === 'VERIFIED';
  const documentStatus = isVerified ? 'VERIFIED' : actor.verificationStatus;
  const documentLabel = (document) => document || (isVerified ? 'Diverifikasi oleh Admin Pusat' : 'Belum di-upload');
  return <div className="page-stack"><SectionIntro eyebrow="ACCOUNT" title="Profil customer" text="Data identitas digunakan untuk proses verifikasi dan reservasi." /><div className="profile-layout"><div className="profile-card"><div className="profile-avatar">{actor.name?.slice(0, 1).toUpperCase()}</div><h3>{actor.name}</h3><span>{actor.email}</span><StatusBadge value={actor.verificationStatus} /><div className="profile-divider" /><div className="profile-detail"><small>Nomor telepon</small><strong>{actor.phone || '-'}</strong></div><div className="profile-detail"><small>Alamat</small><strong>{actor.address || '-'}</strong></div></div><div className="panel"><div className="panel-heading"><div><span className="section-label">VERIFICATION</span><h3>Status dokumen</h3></div><StatusBadge value={actor.verificationStatus} /></div><p className="panel-copy">Foto KTP/SIM masih placeholder dan belum diverifikasi keasliannya. Persetujuan admin saat ini hanya mengaktifkan akun secara administratif.</p><div className="document-row"><span className="document-icon">▤</span><div><strong>KTP</strong><small>{documentLabel(actor.ktpDocument)}</small></div><StatusBadge value={documentStatus} /></div><div className="document-row"><span className="document-icon">▤</span><div><strong>SIM</strong><small>{documentLabel(actor.simDocument)}</small></div><StatusBadge value={documentStatus} /></div></div></div></div>;
}

function CentralCustomers({ customers, runAction }) {
  const [detail, setDetail] = useState(null);
  return <div className="page-stack"><SectionIntro eyebrow="CENTRAL VERIFICATION" title="Review customer" text="Persetujuan administratif akun customer. Foto KTP/SIM masih placeholder; belum ada verifikasi keaslian dokumen." /><div className="list-stack">{customers.map((customer) => <div className="data-row detail-row" key={customer.id} onClick={(event) => { if (!hasInteractiveTarget(event)) setDetail(customer); }} onKeyDown={(event) => openDetailWithKeyboard(event, () => setDetail(customer))} role="button" tabIndex="0"><div className="row-main"><div className="avatar">{customer.name?.slice(0, 1)}</div><div><strong>{customer.name}</strong><span>{customer.email} · {customer.phone || '-'}</span><small>KTP: {customer.ktpNumber || '-'} · SIM: {customer.simNumber || '-'}</small></div></div><div className="row-side"><StatusBadge value={customer.verificationStatus} /><button type="button" className="small-button detail-button" onClick={() => setDetail(customer)}>Lihat detail</button>{customer.verificationStatus !== 'VERIFIED' && <button type="button" className="small-button primary" onClick={() => runAction(() => api(`/admin/customers/${customer.id}/verification`, { method: 'PATCH', body: JSON.stringify({ status: 'VERIFIED' }) }), `${customer.name} berhasil diverifikasi.`)}>Verifikasi</button>}</div></div>)}{customers.length === 0 && <EmptyState title="Tidak ada customer" text="Customer baru akan muncul di sini." />}</div>{detail && <CustomerDetailDrawer customer={detail} onClose={() => setDetail(null)} />}</div>;
}

function CompaniesPage({ companies, onRefresh, onNotify, runAction }) {
  const [detail, setDetail] = useState(null);
  const updateStatus = (company, status) => runAction(
    () => api(`/admin/companies/${company.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    `${company.name} diperbarui menjadi ${status === 'ACTIVE' ? 'Aktif' : status === 'SUSPENDED' ? 'Suspended' : 'Pending'}.`
  );
  return <div className="page-stack"><div className="section-split"><SectionIntro eyebrow="PLATFORM DIRECTORY" title="Perusahaan rental" text="Kelola perusahaan rental, status operasional, dan hubungan Admin Rental." /><button type="button" className="primary-button" onClick={() => setDetail({ create: true })}>+ Tambah perusahaan</button></div><div className="company-grid">{companies.map((company) => <article className="company-card detail-card" key={company.id} onClick={() => setDetail(company)} onKeyDown={(event) => openDetailWithKeyboard(event, () => setDetail(company))} role="button" tabIndex="0"><div className="company-symbol">{company.name.slice(0, 1)}</div><div><span className={`status-dot ${company.status === 'ACTIVE' ? 'active' : ''}`} /> {company.status}</div><h3>{company.name}</h3><p>{company.description || 'Belum ada deskripsi perusahaan.'}</p><div className="company-meta"><span>{company.branches.length} cabang</span><span>Radius {company.deliveryRadiusKm} km</span></div><div className="branch-list"><span className={company.gpsAgreementStatus === 'ACTIVE' && company.gpsTrackingAllowed ? 'green-text' : 'red-text'}>⌁ MoU GPS {company.gpsAgreementStatus === 'ACTIVE' && company.gpsTrackingAllowed ? 'aktif' : company.gpsAgreementStatus ? humanStatus(company.gpsAgreementStatus) : 'belum ada'}</span>{company.branches.map((branch) => <span key={branch.id}>⌖ {branch.name}</span>)}</div><div className="company-card-actions"><button type="button" className="small-button detail-card-action" onClick={(event) => { event.stopPropagation(); setDetail(company); }}>Lihat detail</button><select aria-label={`Status ${company.name}`} value={company.status} onClick={(event) => event.stopPropagation()} onChange={(event) => { event.stopPropagation(); updateStatus(company, event.target.value); }}><option value="PENDING">Pending</option><option value="ACTIVE">Aktif</option><option value="SUSPENDED">Suspended</option></select></div></article>)}{companies.length === 0 && <EmptyState title="Belum ada perusahaan rental" text="Tambahkan perusahaan rental pertama dari tombol di atas." />}</div>{detail?.create && <CompanyOnboardingModal onClose={() => setDetail(null)} onRefresh={onRefresh} onNotify={onNotify} />}{detail && !detail.create && <CompanyDetailDrawer company={detail} onClose={() => setDetail(null)} />}</div>;
}


function OwnerMouPage({ actor, agreements, loadError, onRefresh, onNotify }) {
  const [online, setOnline] = useState(null);
  const pending = agreements.filter((a) => ['WAITING_OWNER','WAITING_REVIEW','REVISION_REQUIRED'].includes(a.workflowStage));
  const [selected, setSelected] = useState('');
  const selectedAgreement = pending.find((a) => a.id === selected);
  useEffect(() => {
    if (!pending.some((a) => a.id === selected)) setSelected(pending[0]?.id || '');
  }, [agreements, selected]);
  const [file, setFile] = useState(null);
  const [stampType, setStampType] = useState('PHYSICAL');
  const [signedAt, setSignedAt] = useState(todayString());
  const [expiresAt, setExpiresAt] = useState(addDaysString(365));
  const [signed, setSigned] = useState(false);
  const [busy, setBusy] = useState(false);
  const download = (path, name) => downloadFile(path, name).catch((error) => onNotify('danger', error.message));
  const submit = async (event) => {
    event.preventDefault(); setBusy(true);
    try {
      if (!file || file.size > 8 * 1024 * 1024) throw new Error('Pilih PDF final maksimal 8 MB.');
      await api(`/rental/gps-agreements/${selected}/document`, { method: 'POST', body: JSON.stringify({ documentDataUrl: await fileToDataUrl(file), stampType, signedAt, expiresAt, bothPartiesSigned: signed }) });
      setFile(null); setSigned(false); onNotify('success', 'MoU diunggah dan menunggu review Admin Pusat.'); await onRefresh();
    } catch (error) { onNotify('danger', error.message); }
    finally { setBusy(false); }
  };
  return <div className="page-stack"><SectionIntro eyebrow="MOU LAYANAN" title="Permintaan MoU dari Admin Pusat" text="Tanggapi permintaan kerja sama: isi persetujuan online untuk membuat draf, atau unggah PDF final yang ditandatangani untuk direview Admin Pusat." />
    {loadError && <div className="notice danger" role="alert">Daftar MoU gagal dimuat: {loadError}. <button type="button" className="secondary-button" onClick={onRefresh}>Muat ulang</button></div>}
    {!loadError && !pending.length && <div className="notice">Belum ada MoU DRAFT/PENDING. Minta Admin Pusat membuat MoU untuk perusahaan ini melalui menu Manajemen MoU. Template tetap dapat diunduh.</div>}
    <label>MoU untuk diproses<select required value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Pilih MoU pending dari Admin Pusat</option>{pending.map((a) => <option key={a.id} value={a.id}>{a.agreementNumber} · {a.workflowStage}</option>)}</select></label><div className="action-grid"><article className="task-card"><strong>Online - draf MoU</strong><p>Baca dan centang ketentuan. Data perusahaan, persetujuan akun dan ruang meterai ditempatkan otomatis pada PDF; tidak perlu cetak atau upload ulang.</p><button type="button" className="primary-button" disabled={!selectedAgreement || !!selectedAgreement.onlineSimulation} onClick={() => setOnline(selectedAgreement)}>Buka persetujuan online</button><small>{selectedAgreement?.onlineSimulation ? "Draf sudah dibuat; gunakan tombol Download draf online pada daftar di bawah." : "Pilih MoU DRAFT/PENDING untuk membuat draf. Draf tersimpan terpisah dari MoU final."}</small></article>{['fisik', 'digital'].map((type) => <article className="task-card" key={type}><strong>Template {type === 'fisik' ? 'meterai tempel' : 'e-Meterai'}</strong><p>{type === 'fisik' ? 'Cetak, tanda tangan basah, tempel meterai asli Rp10.000, lalu scan seluruh halaman. Simpan dokumen asli.' : 'Ekspor PDF yang sudah diisi, gunakan tanda tangan elektronik dan e-Meterai asli melalui penyedia resmi. Upload PDF final tanpa perubahan.'}</p>{['docx', 'pdf'].map((ext) => <button type="button" className="secondary-button" key={ext} onClick={() => download(`/mou/templates/mou-transrent-${type}.${ext}`, `mou-transrent-${type}.${ext}`)}>Download {ext.toUpperCase()}</button>)}</article>)}</div>
    <div className="notice">Tahap: {selectedAgreement?.workflowStage||'Pilih permintaan'}{selectedAgreement?.revisionReason&&<p>Alasan revisi: {selectedAgreement.revisionReason}</p>}</div><h3>Upload MoU final yang ditandatangani di luar aplikasi</h3><form className="stack-form" onSubmit={submit}>
      <label>Jenis meterai<select value={stampType} onChange={(event) => setStampType(event.target.value)}><option value="PHYSICAL">Meterai tempel Rp10.000</option><option value="E_METERAI">e-Meterai Rp10.000</option></select></label>
      <Field label="Tanggal ditandatangani" type="date" value={signedAt} onChange={setSignedAt} required /><Field label="Berlaku sampai" type="date" value={expiresAt} onChange={setExpiresAt} required />
      <label>PDF final, maksimal 8 MB<input type="file" accept="application/pdf,.pdf" required onChange={(event) => setFile(event.target.files?.[0] || null)} /></label>
      <label><input type="checkbox" checked={signed} required onChange={(event) => setSigned(event.target.checked)} /> Dokumen lengkap, ditandatangani kedua pihak dan dibubuhi meterai asli.</label><button className="primary-button" disabled={busy || !selectedAgreement || selectedAgreement.workflowStage==='WAITING_REVIEW'}>{busy ? 'Mengunggah...' : 'Upload untuk review'}</button>
    </form><div className="list-stack">{agreements.map((a) => <article className="data-row" key={a.id}><strong>{a.agreementNumber}</strong>{a.notes && <small>Catatan Admin Pusat: {a.notes}</small>}<StatusBadge value={a.status} /><small>{a.workflowStage}{a.revisionReason&&` · ${a.revisionReason}`}</small>{a.onlineSimulation && <button type="button" className="small-button" onClick={() => download(`/gps-agreements/${a.id}/online-simulation/document`, "mou-online-draf.pdf")}>Download draf online</button>}{(a.documentVersions||[]).map(v=><button key={v.version} className="small-button" onClick={()=>download(`/gps-agreements/${a.id}/document?version=${v.version}`,`mou-versi-${v.version+1}.pdf`)}>Versi lama {v.version+1}</button>)}{a.documentPath && <button className="small-button" onClick={() => download(`/gps-agreements/${a.id}/document`, 'mou-final.pdf')}>Download PDF final</button>}</article>)}</div>{online && <OnlineMouModal agreement={online} actor={actor} onClose={() => setOnline(null)} onCompleted={async (downloadError) => { setOnline(null); onNotify(downloadError ? "danger" : "success", downloadError ? `Draf MoU tersimpan; download ulang dari daftar MoU. ${downloadError}` : "Draf MoU dibuat dan diunduh. MoU resmi tetap menunggu dokumen final."); await onRefresh(); }} />}</div>;
}

function GpsAgreementsPage({ agreements, companies, onRefresh, onNotify }) {
  const [detail, setDetail] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [review,setReview]=useState(null);const [reviewReason,setReviewReason]=useState('');
  const statusOptions = ['ACTIVE','EXPIRED','REVOKED'];
  const activeCount = agreements.filter((agreement) => agreement.status === 'ACTIVE').length;
  const pendingCount = agreements.filter((agreement) => ['DRAFT', 'PENDING'].includes(agreement.status)).length;
  const attentionCount = agreements.filter((agreement) => ['EXPIRED', 'REVOKED'].includes(agreement.status)).length;

  const updateStatus = (agreement, status, gpsTrackingAllowed = status === 'ACTIVE') => {
    if (status === 'ACTIVE' && !window.confirm('Saya sudah memeriksa PDF final yang diunggah, kewenangan dan tanda tangan kedua pihak, meterai asli, serta masa berlaku. Aktifkan MoU ini?')) return;
    const reason=['REVOKED','EXPIRED'].includes(status)?window.prompt('Alasan penonaktifan/perubahan masa berlaku:'):null; if(['REVOKED','EXPIRED'].includes(status)&&!reason?.trim())return;
    setDetail(null);
    runAction(
      () => api(`/admin/gps-agreements/${agreement.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, reason, gpsTrackingAllowed, reviewed: status === 'ACTIVE', reviewedSha256: agreement.documentMetadata?.sha256 })
      }),
      `${agreement.companyName || 'Agreement'} diperbarui menjadi ${humanAgreementStatus(status)}.`
    );
  };

  return <div className="page-stack"><div className="section-split"><SectionIntro eyebrow="GPS AGREEMENTS" title="Manajemen MoU GPS" text="Kirim permintaan MoU kepada pemilik rental, lalu review dokumen final dan izin GPS." /><button type="button" className="primary-button" onClick={() => setShowCreate(true)} disabled={companies.length === 0}>+ Kirim permintaan MoU</button></div><div className="metric-grid agreement-metrics"><article className="metric-card"><span className="metric-icon">⌁</span><small>Total agreement</small><strong>{agreements.length}</strong><span className="metric-note">seluruh perusahaan</span></article><article className="metric-card"><span className="metric-icon">✓</span><small>MoU aktif</small><strong>{activeCount}</strong><span className="metric-note">GPS dapat digunakan</span></article><article className="metric-card"><span className="metric-icon">◌</span><small>Perlu review</small><strong>{pendingCount}</strong><span className="metric-note">draft atau pending</span></article><article className="metric-card"><span className="metric-icon">!</span><small>Perlu perhatian</small><strong>{attentionCount}</strong><span className="metric-note">expired atau dicabut</span></article></div><div className="agreement-grid">{agreements.map((agreement) => <article className="agreement-card detail-card" key={agreement.id} onClick={() => setDetail(agreement)} onKeyDown={(event) => openDetailWithKeyboard(event, () => setDetail(agreement))} role="button" tabIndex="0"><div className="agreement-card-top"><div><span className="section-label">MOU GPS</span><h3>{agreement.companyName || 'Perusahaan belum tersedia'}</h3></div><StatusBadge value={agreement.status} label={humanAgreementStatus(agreement.status)} /></div><div className="notice"><strong>Tahap: {agreement.workflowStage}</strong>{agreement.revisionReason&&<p>{agreement.revisionReason}</p>}{agreement.workflowStage==='WAITING_REVIEW'&&<button type="button" className="small-button" onClick={event=>{event.stopPropagation();setReview(agreement);setReviewReason('');}}>Minta revisi</button>}</div><div className="agreement-number">{agreement.agreementNumber || 'Nomor agreement belum tersedia'}</div><div className="agreement-meta"><div><span>Ditandatangani</span><strong>{formatDate(agreement.signedAt)}</strong></div><div><span>Berlaku sampai</span><strong>{formatDate(agreement.expiresAt)}</strong></div><span className={`agreement-gps ${agreement.gpsTrackingAllowed ? '' : 'off'}`}>⌁ GPS tracking {agreement.gpsTrackingAllowed ? 'diizinkan' : 'belum diizinkan'}</span></div><div className="agreement-card-footer">{agreement.onlineSimulation && <button type="button" className="small-button" onClick={(event) => { event.stopPropagation(); downloadFile(`/gps-agreements/${agreement.id}/online-simulation/document`, "mou-online-draf.pdf").catch((error) => onNotify("danger", error.message)); }}>Download draf online</button>}{agreement.documentPath && <button type="button" className="small-button" onClick={(event) => { event.stopPropagation(); downloadFile(`/gps-agreements/${agreement.id}/document`, "mou-final.pdf").catch((error) => onNotify("danger", error.message)); }}>Download PDF final</button>}<button type="button" className="small-button detail-card-action" onClick={(event) => { event.stopPropagation(); setDetail(agreement); }}>Lihat detail</button><select aria-label={`Status MoU ${agreement.companyName || ''}`} value={agreement.status} onClick={(event) => event.stopPropagation()} onChange={(event) => { event.stopPropagation(); updateStatus(agreement, event.target.value); }}>{[...new Set([agreement.status,...statusOptions.filter(status=>agreement.workflowStage==='WAITING_REVIEW'?true:agreement.status==='ACTIVE'?status!=='ACTIVE':false)])].map((status) => <option key={status} value={status}>{agreementStatusLabels[status]}</option>)}</select></div></article>)}{agreements.length === 0 && <EmptyState title="Belum ada MoU GPS" text="Agreement perusahaan rental akan muncul di sini." />}</div>{detail && <GpsAgreementDetailDrawer agreement={detail} onClose={() => setDetail(null)} onStatusChange={updateStatus} />}{review&&<div className="modal-backdrop"><section className="modal-card" role="dialog" aria-modal="true" aria-label="Alasan revisi MoU"><h3>Minta revisi MoU</h3><form className="stack-form" onSubmit={async e=>{e.preventDefault();try{await api(`/admin/gps-agreements/${review.id}`,{method:'PATCH',body:JSON.stringify({decision:'REVISION_REQUIRED',reason:reviewReason})});setReview(null);await onRefresh();}catch(err){onNotify('danger',err.message);}}}><label className="field"><span>Alasan revisi</span><textarea required maxLength={2000} value={reviewReason} onChange={e=>setReviewReason(e.target.value)} /></label><button className="primary-button">Kirim revisi</button><button type="button" className="secondary-button" onClick={()=>setReview(null)}>Batal</button></form></section></div>}{showCreate && <GpsAgreementCreateModal companies={companies} onClose={() => setShowCreate(false)} onRefresh={onRefresh} onNotify={onNotify} />}</div>;
}

function CompanyOnboardingModal({ onClose, onRefresh, onNotify }) {
  const [checkpoint]=useState(()=>{try{return JSON.parse(localStorage.getItem('transrent.onboarding')||'null')||{creationKey:crypto.randomUUID()};}catch{return {creationKey:crypto.randomUUID()};}});
  const [form, setForm] = useState(checkpoint.form||{ name: '', legalName: '', email: '', phone: '', description: '', adminName: '', adminEmail: '', notes: '' });
  const [companyId, setCompanyId] = useState(checkpoint.companyId||null);
  const [agreementCreated, setAgreementCreated] = useState(checkpoint.agreementCreated||false);
  const [invitationSent, setInvitationSent] = useState(checkpoint.invitationSent||false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(()=>{localStorage.setItem('transrent.onboarding',JSON.stringify({...checkpoint,companyId,form,agreementCreated,invitationSent}));},[checkpoint,companyId,form,agreementCreated,invitationSent]);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      let company = companyId ? { id: companyId } : null;
      if (!company) {
        const response = await api('/admin/companies', { method: 'POST', body: JSON.stringify({ creationKey:checkpoint.creationKey,name: form.name, legalName: form.legalName, email: form.email, phone: form.phone, description: form.description }) });
        company = response.company;
        setCompanyId(company.id);
      }
      let agreement = null;
      if (!agreementCreated) {
        const agreementResponse = await api(`/admin/companies/${company.id}/agreements`, { method: 'POST', body: JSON.stringify({ notes: form.notes }) });
        agreement = agreementResponse.agreement;
        setAgreementCreated(true);
      }
      let invitation = null;
      if (form.adminEmail && !invitationSent) {
        const response = await api(`/admin/companies/${company.id}/admin-invite`, { method: 'POST', body: JSON.stringify({ name: form.adminName, email: form.adminEmail }) });
        invitation = response.invitation;
        setInvitationSent(true);
      }
      await onRefresh();
      const inviteMessage = invitation?.temporaryPassword ? ` Password demo sementara: ${invitation.temporaryPassword}` : '';
      onNotify('success', `Perusahaan ${form.name || 'rental'} berhasil dibuat. MoU ${agreement?.agreementNumber || 'otomatis'} dikirim sebagai permintaan Pending.${form.adminEmail ? ` Undangan dikirim ke ${form.adminEmail}.` : ''}${inviteMessage}`);
      localStorage.removeItem('transrent.onboarding');onClose();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card wide-modal"><div className="drawer-header"><div><span className="section-label">NEW RENTAL COMPANY</span><h3>Tambah perusahaan rental</h3><p>Perusahaan dibuat Pending sampai disetujui Admin Pusat.</p></div><button type="button" className="close-button" onClick={onClose}>×</button></div>{error && <div className="notice danger">{error}</div>}<form className="stack-form" onSubmit={submit}><div className="onboarding-section"><div className="onboarding-heading"><span className="section-label">01 · PROFIL PERUSAHAAN</span><small>Data dasar perusahaan rental</small></div><div className="form-grid two"><Field label="Nama perusahaan" value={form.name} onChange={(value) => update('name', value)} required /><Field label="Nama legal" value={form.legalName} onChange={(value) => update('legalName', value)} /></div><div className="form-grid two"><Field label="Email perusahaan" type="email" value={form.email} onChange={(value) => update('email', value)} /><Field label="Nomor telepon" value={form.phone} onChange={(value) => update('phone', value)} /></div><Field label="Deskripsi" value={form.description} onChange={(value) => update('description', value)} /></div><div className="onboarding-section"><div className="onboarding-heading"><span className="section-label">02 · ADMIN RENTAL</span><small>Opsional, bisa diundang setelah perusahaan dibuat</small></div><div className="form-grid two"><Field label="Nama PIC" value={form.adminName} onChange={(value) => update('adminName', value)} /><Field label="Email undangan" type="email" value={form.adminEmail} onChange={(value) => update('adminEmail', value)} /></div><p className="helper-text">Admin Pusat tidak membuat password. Sistem mengirim undangan dan Admin Rental membuat password sendiri.</p></div><div className="onboarding-section"><div className="onboarding-heading"><span className="section-label">03 · PERMINTAAN MOU</span><small>Nomor dibuat otomatis oleh sistem</small></div><div className="agreement-auto-number"><span>Nomor MoU</span><strong>Otomatis saat disimpan</strong></div><p className="helper-text">Permintaan akan muncul di menu MoU layanan milik Admin Rental. Pemilik melengkapi persetujuan atau mengunggah PDF final; Admin Pusat mereview setelahnya.</p><Field label="Catatan permintaan MoU" value={form.notes} onChange={(value) => update('notes', value)} /></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={busy}>{busy ? 'Menyimpan...' : companyId ? 'Lanjutkan setup' : 'Buat perusahaan'}</button></div></form></section></div>;
}

function GpsAgreementCreateModal({ companies, onClose, onRefresh, onNotify }) {
  const [companyId, setCompanyId] = useState(companies[0]?.id || '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await api(`/admin/companies/${companyId}/agreements`, { method: 'POST', body: JSON.stringify({ notes }) });
      await onRefresh();
      onNotify('success', `Permintaan MoU ${response.agreement?.agreementNumber || ''} dikirim ke menu MoU layanan perusahaan rental.`);
      onClose();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="modal-card wide-modal" role="dialog" aria-modal="true" aria-labelledby="mou-request-title">
    <div className="drawer-header"><div><span className="section-label">PERMINTAAN MOU</span><h3 id="mou-request-title">Kirim permintaan MoU</h3><p>Pemilik rental melengkapi MoU melalui menu MoU layanan. Admin Pusat mereview dokumen final yang diterima.</p></div><button type="button" className="close-button" aria-label="Tutup" disabled={busy} onClick={onClose}>x</button></div>
    {error && <div className="notice danger" role="alert">{error}</div>}
    <form className="stack-form" onSubmit={submit}>
      <label className="field"><span>Perusahaan tujuan</span><select required value={companyId} disabled={busy} onChange={(event) => setCompanyId(event.target.value)}>{companies.map((company) => <option key={company.id} value={company.id}>{company.name} - {humanStatus(company.status)}</option>)}</select></label>
      <div className="agreement-auto-number"><span>Nomor permintaan MoU</span><strong>Dibuat otomatis saat dikirim</strong></div>
      <label className="field"><span>Catatan untuk pemilik rental</span><textarea value={notes} maxLength={2000} disabled={busy} onChange={(event) => setNotes(event.target.value)} placeholder="Contoh: Mohon lengkapi persetujuan MoU layanan TransRent." /></label>
      <p className="helper-text">Permintaan masuk sebagai PENDING. Tanggal tanda tangan, masa berlaku, dan PDF final dilengkapi oleh pemilik rental. Pengiriman berlangsung melalui aplikasi.</p>
      <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Batal</button><button className="primary-button" disabled={busy || !companyId}>{busy ? 'Mengirim...' : 'Kirim permintaan'}</button></div>
    </form>
  </section></div>;
}

function FleetPage({ fleet }) {
  const [detail, setDetail] = useState(null);
  return <div className="page-stack"><SectionIntro eyebrow="FLEET CONTROL" title="Armada dan kesiapan GPS" text="Kendaraan tanpa GPS READY tidak dapat dipesan atau handover." /><div className="fleet-grid">{fleet.map((vehicle) => <article className="fleet-card detail-card" key={vehicle.id} onClick={() => setDetail(vehicle)} onKeyDown={(event) => openDetailWithKeyboard(event, () => setDetail(vehicle))} role="button" tabIndex="0"><img src={vehicle.image} alt="" /><div className="fleet-card-copy"><div className="fleet-card-top"><span className="vehicle-type">{vehicle.type === 'CAR' ? 'MOBIL' : 'MOTOR'}</span><StatusBadge value={vehicle.status} /></div><h3>{vehicle.name}</h3><p>{vehicle.company.name} · {vehicle.branch.name}</p><div className="fleet-meta"><span>GPS <b className={vehicle.gpsStatus === 'READY' ? 'green-text' : 'red-text'}>{humanStatus(vehicle.gpsStatus)}</b></span><span>{vehicle.plateNumber}</span>{vehicle.repairRequired && <strong className="red-text">Perlu REPAIR</strong>}</div><button type="button" className="small-button detail-card-action" onClick={(event) => { event.stopPropagation(); setDetail(vehicle); }}>Lihat detail</button></div></article>)}</div>{detail && <FleetDetailDrawer vehicle={detail} onClose={() => setDetail(null)} />}</div>;
}

function MaintenancePage({ maintenance, fleet, runAction }) {
  const [vehicleId, setVehicleId] = useState(fleet[0]?.id || '');
  const [title, setTitle] = useState('Servis berkala');
  const [type, setType] = useState('SERVICE');
  const lifecycleAction = (item) => {
    if (item.status === 'SCHEDULED') return <><button className="small-button" onClick={() => runAction(() => api(`/maintenance/${item.id}/start`, { method: 'POST' }), 'Maintenance dimulai.')}>Mulai</button><button className="small-button danger" onClick={() => runAction(() => api(`/maintenance/${item.id}/cancel`, { method: 'POST' }), 'Maintenance dibatalkan.')}>Batalkan</button></>;
    if (item.status === 'IN_PROGRESS') return <><button className="small-button primary" onClick={() => runAction(() => api(`/maintenance/${item.id}/complete`, { method: 'POST' }), 'Maintenance selesai.')}>Selesai</button><button className="small-button danger" onClick={() => runAction(() => api(`/maintenance/${item.id}/cancel`, { method: 'POST' }), 'Maintenance dibatalkan.')}>Batalkan</button></>;
    return null;
  };
  return <div className="page-stack"><SectionIntro eyebrow="FLEET CARE" title="Maintenance kendaraan" text="Kendaraan maintenance otomatis tidak tersedia untuk reservasi." /><div className="two-column"><div className="panel"><div className="panel-heading"><div><span className="section-label">NEW TASK</span><h3>Jadwalkan maintenance</h3></div></div><form className="stack-form" onSubmit={(event) => { event.preventDefault(); runAction(() => api('/maintenance', { method: 'POST', body: JSON.stringify({ vehicleId, title, type }) }), 'Maintenance berhasil dibuat.'); }}><label className="field"><span>Kendaraan</span><select value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}>{fleet.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.name}</option>)}</select></label><label className="field"><span>Jenis pekerjaan</span><select value={type} onChange={(e) => setType(e.target.value)}><option value="SERVICE">SERVICE — perawatan rutin</option><option value="REPAIR">REPAIR — perbaikan kerusakan</option></select></label><p>Kerusakan hanya dinyatakan diperbaiki setelah REPAIR selesai. Membatalkan pekerjaan tidak menghapus kerusakan.</p><Field label="Judul maintenance" value={title} onChange={setTitle} /><button className="primary-button">Simpan maintenance</button></form></div><div className="panel"><div className="panel-heading"><div><span className="section-label">MAINTENANCE QUEUE</span><h3>Daftar pekerjaan</h3></div></div>{maintenance.map((item) => <div className="maintenance-row" key={item.id}><span className="task-icon">✦</span><div><strong>{item.title}</strong><span>{item.vehicle?.name || 'Kendaraan'}</span><small>{item.type} · {item.notes}</small></div><div className="row-side"><StatusBadge value={item.status} /><div className="inline-actions">{lifecycleAction(item)}</div></div></div>)}{maintenance.length === 0 && <EmptyState title="Belum ada maintenance" text="Jadwal servis akan muncul di sini." />}</div></div></div>;
}

function InspectionModal({ mode, target, onClose, onDone }) {
  const isBefore = mode === 'BEFORE';
  const subject = isBefore ? target.reservation : target.rental;
  const [staffPhotos, setStaffPhotos] = useState([]);
  const [customerPhotos, setCustomerPhotos] = useState([]);
  const [signature, setSignature] = useState(null);
  const [notes, setNotes] = useState('');
  const [actualReturnDate, setActualReturnDate] = useState(todayString());
  const [returnMethod, setReturnMethod] = useState('SELF_RETURN');
  const [pickupAddress, setPickupAddress] = useState('');
  const [pickupTime, setPickupTime] = useState('10:00');
  const [damageType, setDamageType] = useState('');
  const [damageAmount, setDamageAmount] = useState('');
  const [checklist, setChecklist] = useState({ body: false, tires: false, lights: false, engine: false, fuel: false, equipment: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const checklistLabels = { body: 'Bodi dan kaca', tires: 'Ban dan velg', lights: 'Lampu', engine: 'Mesin', fuel: 'Bahan bakar', equipment: 'Kelengkapan kendaraan' };
  const readFiles = async (files, setter) => {
    const values = await Promise.all([...files].map((file) => fileToDataUrl(file)));
    setter(values.filter(Boolean));
  };
  const submit = async (event) => {
    event.preventDefault();

    setBusy(true); setError('');
    try {
      const body = { staffChecklist: Object.entries(checklist).filter(([, value]) => value).map(([key]) => checklistLabels[key]), staffPhotos, customerPhotos, customerSignature: signature, notes };
      if (isBefore) await api(`/reservations/${subject.id}/handover`, { method: 'POST', body: JSON.stringify(body) });
      else await api(`/rentals/${subject.id}/return`, { method: 'POST', body: JSON.stringify({ ...body, actualReturnDate, returnMethod, returnSchedule: returnMethod === 'STAFF_PICKUP' ? { date: actualReturnDate, time: pickupTime, address: pickupAddress } : null, damageItems: damageType && damageAmount ? [{ type: damageType, amount: Number(damageAmount) }] : [] }) });
      onDone();
    } catch (submitError) { setError(submitError.message); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section className="modal-card wide-modal"><div className="drawer-header"><div><span className="section-label">{isBefore ? 'HANDOVER / BEFORE' : 'RETURN / AFTER'}</span><h3>{isBefore ? 'Dokumentasi serah-terima' : 'Dokumentasi pengembalian'}</h3><p>{subject.vehicle?.name || subject.vehicle?.name}</p></div><button className="close-button" onClick={onClose}>×</button></div>{error && <div className="notice danger">{error}</div>}<form onSubmit={submit} className="inspection-form"><div className="notice">Foto dan tanda tangan saat ini placeholder opsional, belum diverifikasi keasliannya.</div><div className="inspection-columns"><div><h4>1. Foto staff</h4><FileField label="Upload foto kondisi dari staff" multiple onChange={(files) => readFiles(files, setStaffPhotos)} /><PhotoPreview images={staffPhotos} /></div><div><h4>2. Foto customer</h4><FileField label="Upload foto kondisi dari customer" multiple onChange={(files) => readFiles(files, setCustomerPhotos)} /><PhotoPreview images={customerPhotos} /></div></div><div><h4>3. Checklist staff</h4><div className="checklist-grid">{Object.entries(checklistLabels).map(([key, label]) => <label className="check-item" key={key}><input type="checkbox" checked={checklist[key]} onChange={(event) => setChecklist((current) => ({ ...current, [key]: event.target.checked }))} /><span>{label}</span></label>)}</div></div>{!isBefore && <div className="return-options"><h4>4. Return dan denda</h4><div className="form-grid three"><label className="field"><span>Metode return</span><select value={returnMethod} onChange={(event) => setReturnMethod(event.target.value)}><option value="SELF_RETURN">Kembali ke cabang awal</option><option value="STAFF_PICKUP">Diambil staff</option></select></label><label className="field"><span>Tanggal aktual</span><input type="date" value={actualReturnDate} onChange={(event) => setActualReturnDate(event.target.value)} /></label>{returnMethod === 'STAFF_PICKUP' && <label className="field"><span>Jam pickup</span><input type="time" value={pickupTime} onChange={(event) => setPickupTime(event.target.value)} /></label>}</div>{returnMethod === 'STAFF_PICKUP' && <Field label="Alamat pickup staff" value={pickupAddress} onChange={setPickupAddress} required />}<div className="form-grid two"><label className="field"><span>Jenis kerusakan (opsional)</span><select value={damageType} onChange={(event) => setDamageType(event.target.value)}><option value="">Tidak ada kerusakan</option><option value="BODY">Bodi/kaca</option><option value="TIRE">Ban/velg</option><option value="LIGHT">Lampu</option><option value="ENGINE">Mesin</option><option value="EQUIPMENT">Kelengkapan</option></select></label><Field label="Nominal denda" type="number" value={damageAmount} onChange={setDamageAmount} /></div></div>}<div><h4>{isBefore ? '4' : '5'}. Tanda tangan customer</h4><SignaturePad onChange={setSignature} /></div><label className="field"><span>Catatan inspeksi</span><textarea rows="3" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Tambahkan catatan kondisi..." /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={busy}>{busy ? 'Menyimpan...' : isBefore ? 'Simpan handover' : 'Simpan return'}</button></div></form></section></div>;
}

function SignaturePad({ onChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const point = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const start = (event) => { drawing.current = true; const context = canvasRef.current.getContext('2d'); const p = point(event); context.beginPath(); context.moveTo(p.x, p.y); };
  const move = (event) => { if (!drawing.current) return; const context = canvasRef.current.getContext('2d'); const p = point(event); context.lineWidth = 2; context.lineCap = 'round'; context.strokeStyle = '#17243c'; context.lineTo(p.x, p.y); context.stroke(); };
  const stop = () => { if (!drawing.current) return; drawing.current = false; onChange(canvasRef.current.toDataURL('image/png')); };
  const clear = () => { const canvas = canvasRef.current; canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); onChange(null); };
  return <div className="signature-wrap"><canvas ref={canvasRef} width="560" height="130" onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerLeave={stop} /><div className="signature-footer"><span>Gambar tanda tangan di area ini</span><button type="button" onClick={clear}>Bersihkan</button></div></div>;
}

function MapPanel({ results = [], locations = [] }) {
  const markers = [...results.map((item) => ({ latitude: item.branch.latitude, longitude: item.branch.longitude, label: item.branch.name, detail: `${item.company.name} · ${item.distanceKm} km` })), ...locations];
  const center = markers[0] ? [markers[0].latitude, markers[0].longitude] : [DEFAULT_LOCATION.latitude, DEFAULT_LOCATION.longitude];
  return <MapContainer center={center} zoom={12} scrollWheelZoom className="map"><MapRecenter center={center} /><TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />{markers.map((marker, index) => <CircleMarker key={`${marker.label}-${index}`} center={[marker.latitude, marker.longitude]} radius={8} pathOptions={{ color: locations.length ? '#2e8d79' : '#4c6fff', fillColor: locations.length ? '#4cbea4' : '#6f88ff', fillOpacity: 0.9 }}><Popup><strong>{marker.label}</strong><br />{marker.detail}</Popup></CircleMarker>)}</MapContainer>;
}

function MapRecenter({ center }) { const map = useMap(); useEffect(() => { map.setView(center); }, [center, map]); return null; }

function ReservationDetailDrawer({ reservation, onClose, onPay, showCustomer = false }) {
  const vehicle = reservation.vehicle || {};
  const branch = reservation.branch || vehicle.branch || {};
  const company = reservation.company || vehicle.company || {};
  const customer = reservation.customer || {};
  const isDelivery = reservation.pickupMode === 'DELIVERY';
  const rentalDays = reservation.rentalDays || 0;
  const rentalAmount = reservation.rentalAmount ?? (vehicle.pricePerDay || 0) * rentalDays;
  const depositAmount = reservation.depositAmount ?? vehicle.deposit ?? 0;
  const paymentComplete = Boolean(reservation.paidAt) || ['CONFIRMED', 'RENTED', 'COMPLETED'].includes(reservation.status);

  return <div className="drawer-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="reservation-drawer detail-drawer"><div className="drawer-header"><div><span className="section-label">RESERVATION DETAIL</span><h3>Detail reservasi</h3><p>#{reservation.id}</p></div><button type="button" className="close-button" onClick={onClose}>×</button></div><div className="detail-vehicle"><img src={vehicle.image} alt="" /><div><span className="vehicle-type">{vehicle.type === 'CAR' ? 'MOBIL' : 'MOTOR'}</span><h4>{vehicle.name || 'Kendaraan'}</h4><p>{company.name || '-'} · {branch.name || '-'}</p><StatusBadge value={reservation.status} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">JADWAL PERJALANAN</span><strong>{rentalDays || '-'} hari</strong></div><div className="detail-grid"><DetailItem label="Mulai rental" value={formatDate(reservation.startDate)} /><DetailItem label="Selesai rental" value={formatDate(reservation.endDate)} /><DetailItem label="Dibuat pada" value={formatDateTime(reservation.createdAt)} /><DetailItem label="GPS kendaraan" value={humanStatus(vehicle.gpsStatus || 'READY')} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">LOKASI SERAH TERIMA</span><strong>{isDelivery ? 'Delivery' : 'Pickup cabang'}</strong></div><div className="detail-location"><span className="detail-location-icon">{isDelivery ? '⌖' : '⌂'}</span><div><strong>{isDelivery ? 'Diantar ke alamat customer' : branch.name || 'Cabang rental'}</strong><p>{isDelivery ? reservation.deliveryAddress || 'Alamat belum tersedia' : branch.address || 'Alamat cabang belum tersedia'}</p>{isDelivery && <small>{reservation.recipientPhone ? `Penerima: ${reservation.recipientPhone}` : ''}{reservation.deliveryDistanceKm ? ` · ${reservation.deliveryDistanceKm} km dari cabang` : ''}</small>}{!isDelivery && branch.phone && <small>Telepon cabang: {branch.phone}</small>}</div></div>{isDelivery && reservation.deliveryNotes && <p className="detail-note">Catatan delivery: {reservation.deliveryNotes}</p>}</div>{showCustomer && <div className="detail-section"><div className="detail-section-heading"><span className="section-label">CUSTOMER</span></div><div className="detail-contact"><div className="avatar">{customer.name?.slice(0, 1).toUpperCase() || '?'}</div><div><strong>{customer.name || '-'}</strong><p>{customer.email || '-'}</p><small>{customer.phone || 'Nomor telepon belum tersedia'}</small></div></div></div>}<div className="detail-section"><div className="detail-section-heading"><span className="section-label">RINCIAN PEMBAYARAN</span><strong className={paymentComplete ? 'green-text' : 'yellow-text'}>{paymentComplete ? 'Lunas' : 'Menunggu pembayaran'}</strong></div><div className="detail-pricing"><DetailPrice label={`Sewa kendaraan${rentalDays ? ` · ${rentalDays} hari` : ''}`} value={rentalAmount} /><DetailPrice label="Deposit" value={depositAmount} /><div className="detail-total"><span>Total reservasi</span><strong>{formatCurrency(reservation.totalAmount ?? rentalAmount + depositAmount)}</strong></div></div></div>{reservation.status === 'PENDING_PAYMENT' && reservation.expiresAt && <div className="detail-expiry">Selesaikan pembayaran sebelum <strong>{formatDateTime(reservation.expiresAt)}</strong>.</div>}<div className="detail-actions">{onPay && reservation.status === 'PENDING_PAYMENT' && <button type="button" className="primary-button" onClick={onPay}>Checkout pembayaran</button>}<button type="button" className="secondary-button" onClick={onClose}>Tutup detail</button></div></aside></div>;
}

function DetailDrawerShell({ eyebrow, title, subtitle, onClose, children }) {
  return <div className="drawer-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="reservation-drawer detail-drawer"><div className="drawer-header"><div><span className="section-label">{eyebrow}</span><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="close-button" onClick={onClose}>×</button></div>{children}<div className="detail-actions"><button type="button" className="secondary-button" onClick={onClose}>Tutup detail</button></div></aside></div>;
}

function CustomerDetailDrawer({ customer, onClose }) {
  return <DetailDrawerShell eyebrow="CUSTOMER DETAIL" title="Detail customer" subtitle={`#${customer.id}`} onClose={onClose}><div className="detail-profile-hero"><div className="detail-avatar-large">{customer.name?.slice(0, 1).toUpperCase() || '?'}</div><div><h4>{customer.name || '-'}</h4><p>{customer.email || '-'}</p><StatusBadge value={customer.verificationStatus} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">INFORMASI KONTAK</span></div><div className="detail-grid"><DetailItem label="Nomor telepon" value={customer.phone} /><DetailItem label="Bergabung sejak" value={formatDate(customer.createdAt)} /><div className="detail-item detail-item-wide"><span>Alamat</span><strong>{customer.address || '-'}</strong></div></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">DOKUMEN VERIFIKASI</span><StatusBadge value={customer.verificationStatus} /></div><div className="detail-document-grid"><DetailDocument label="KTP" value={customer.ktpNumber} file={customer.ktpDocument} /><DetailDocument label="SIM" value={customer.simNumber} file={customer.simDocument} /></div></div></DetailDrawerShell>;
}

function CompanyDetailDrawer({ company, onClose }) {
  const branches = company.branches || [];
  const gpsActive = company.gpsAgreementStatus === 'ACTIVE' && company.gpsTrackingAllowed;
  return <DetailDrawerShell eyebrow="RENTAL COMPANY DETAIL" title="Detail perusahaan rental" subtitle={`#${company.id}`} onClose={onClose}><div className="detail-company-hero"><div className="company-symbol">{company.name?.slice(0, 1) || 'R'}</div><div><h4>{company.name || '-'}</h4><p>{company.legalName || 'Badan usaha belum tersedia'}</p><StatusBadge value={company.status} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">PROFIL PERUSAHAAN</span></div><div className="detail-grid"><DetailItem label="Email" value={company.email} /><DetailItem label="Telepon" value={company.phone} /><DetailItem label="Radius delivery" value={`${company.deliveryRadiusKm || '-'} km`} /><DetailItem label="Jumlah cabang" value={`${branches.length} cabang`} /><div className="detail-item detail-item-wide"><span>Deskripsi</span><strong>{company.description || '-'}</strong></div></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">STATUS GPS & AGREEMENT</span><strong className={gpsActive ? 'green-text' : 'red-text'}>{gpsActive ? 'Aktif' : 'Belum aktif'}</strong></div><div className="detail-location"><span className="detail-location-icon">⌁</span><div><strong>GPS tracking {gpsActive ? 'diizinkan' : 'belum diizinkan'}</strong><p>{company.gpsAgreementStatus ? `Status agreement: ${humanStatus(company.gpsAgreementStatus)}` : 'Belum ada agreement GPS aktif.'}</p></div></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">DAFTAR CABANG</span><strong>{branches.length} cabang</strong></div><div className="detail-branch-list">{branches.length ? branches.map((branch) => <div className="detail-branch" key={branch.id}><span className="detail-location-icon">⌖</span><div><strong>{branch.name}</strong><p>{branch.address || '-'}</p>{branch.phone && <small>{branch.phone}</small>}</div></div>) : <p className="helper-text">Belum ada cabang terdaftar.</p>}</div></div></DetailDrawerShell>;
}

function GpsAgreementDetailDrawer({ agreement, onClose, onStatusChange }) {
  const [nextStatus, setNextStatus] = useState(agreement.status);
  const [gpsTrackingAllowed, setGpsTrackingAllowed] = useState(Boolean(agreement.gpsTrackingAllowed));
  const canTrack = nextStatus === 'ACTIVE';
  const save = () => onStatusChange(agreement, nextStatus, canTrack && gpsTrackingAllowed);

  return <DetailDrawerShell eyebrow="GPS AGREEMENT DETAIL" title="Detail MoU GPS" subtitle={`#${agreement.id}`} onClose={onClose}><div className="detail-company-hero"><div className="company-symbol">{agreement.companyName?.slice(0, 1) || 'R'}</div><div><h4>{agreement.companyName || 'Perusahaan belum tersedia'}</h4><p>{agreement.agreementNumber || 'Nomor agreement belum tersedia'}</p><StatusBadge value={agreement.status} label={humanAgreementStatus(agreement.status)} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">INFORMASI AGREEMENT</span><strong className={agreement.gpsTrackingAllowed ? 'green-text' : 'red-text'}>{agreement.gpsTrackingAllowed ? 'GPS diizinkan' : 'GPS tidak diizinkan'}</strong></div><div className="detail-grid"><DetailItem label="Status" value={humanAgreementStatus(agreement.status)} /><DetailItem label="Ditandatangani" value={formatDate(agreement.signedAt)} /><DetailItem label="Berlaku sampai" value={formatDate(agreement.expiresAt)} /><DetailItem label="Diperbarui" value={formatDateTime(agreement.updatedAt)} /><div className="detail-item detail-item-wide"><span>Dokumen</span><strong>{agreement.documentPath ? 'Dokumen tersedia untuk diunduh' : 'Dokumen MoU belum dilampirkan'}</strong></div><div className="detail-item detail-item-wide"><span>Catatan</span><strong>{agreement.notes || 'Tidak ada catatan.'}</strong></div></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">PERUBAHAN STATUS</span></div><div className="agreement-control-box"><label className="field"><span>Status agreement</span><select value={nextStatus} onChange={(event) => setNextStatus(event.target.value)}>{Object.keys(agreementStatusLabels).map((status) => <option key={status} value={status}>{agreementStatusLabels[status]}</option>)}</select></label><label className="agreement-toggle"><input type="checkbox" checked={canTrack && gpsTrackingAllowed} disabled={!canTrack} onChange={(event) => setGpsTrackingAllowed(event.target.checked)} /> Izinkan GPS tracking untuk agreement aktif</label>{!canTrack && <small className="helper-text">GPS otomatis nonaktif selama status agreement belum Aktif.</small>}<button type="button" className="primary-button" onClick={save}>Simpan perubahan</button></div></div></DetailDrawerShell>;
}

function FleetDetailDrawer({ vehicle, onClose }) {
  const branch = vehicle.branch || {};
  const company = vehicle.company || {};
  return <DetailDrawerShell eyebrow="FLEET DETAIL" title="Detail armada" subtitle={`#${vehicle.id}`} onClose={onClose}><div className="detail-vehicle"><img src={vehicle.image} alt="" /><div><span className="vehicle-type">{vehicle.type === 'CAR' ? 'MOBIL' : 'MOTOR'}</span><h4>{vehicle.name || '-'}</h4><p>{company.name || '-'} · {branch.name || '-'}</p><StatusBadge value={vehicle.status} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">SPESIFIKASI KENDARAAN</span></div><div className="detail-grid"><DetailItem label="Nomor polisi" value={vehicle.plateNumber} /><DetailItem label="Tahun" value={vehicle.year} /><DetailItem label="Transmisi" value={vehicle.transmission} /><DetailItem label="Kapasitas" value={vehicle.seats ? `${vehicle.seats} kursi` : '-'} /><DetailItem label="Harga per hari" value={formatCurrency(vehicle.pricePerDay)} /><DetailItem label="Deposit" value={formatCurrency(vehicle.deposit)} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">STATUS GPS</span><strong className={vehicle.gpsStatus === 'READY' ? 'green-text' : 'red-text'}>{humanStatus(vehicle.gpsStatus)}</strong></div><div className="detail-location"><span className="detail-location-icon">⌁</span><div><strong>{vehicle.gpsDeviceId || 'Perangkat GPS belum dipetakan'}</strong><p>{vehicle.gpsStatus === 'READY' ? 'Perangkat siap digunakan untuk tracking.' : 'Kendaraan belum siap untuk reservasi atau handover.'}</p></div></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">LOKASI ARMADA</span></div><div className="detail-location"><span className="detail-location-icon">⌖</span><div><strong>{branch.name || 'Cabang belum tersedia'}</strong><p>{branch.address || '-'}</p>{branch.phone && <small>{branch.phone}</small>}</div></div></div></DetailDrawerShell>;
}

function RentalDetailDrawer({ rental, onClose }) {
  const vehicle = rental.vehicle || {};
  const branch = rental.branch || vehicle.branch || {};
  const company = rental.company || vehicle.company || {};
  const customer = rental.customer || {};
  const reservation = rental.reservation || {};
  const returnMethod = rental.returnMethod === 'STAFF_PICKUP' ? 'Diambil staff' : rental.returnMethod === 'SELF_RETURN' ? 'Kembali ke cabang' : '-';
  return <DetailDrawerShell eyebrow="RENTAL DETAIL" title="Detail rental berjalan" subtitle={`#${rental.id}`} onClose={onClose}><div className="detail-vehicle"><img src={vehicle.image} alt="" /><div><span className="vehicle-type">{vehicle.type === 'CAR' ? 'MOBIL' : 'MOTOR'}</span><h4>{vehicle.name || '-'}</h4><p>{company.name || '-'} · {branch.name || '-'}</p><StatusBadge value={rental.status} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">CUSTOMER</span></div><div className="detail-contact"><div className="avatar">{customer.name?.slice(0, 1).toUpperCase() || '?'}</div><div><strong>{customer.name || '-'}</strong><p>{customer.email || '-'}</p><small>{customer.phone || 'Nomor telepon belum tersedia'}</small></div></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">LINIMASA RENTAL</span></div><div className="detail-grid"><DetailItem label="Mulai rental" value={formatDate(rental.startDate)} /><DetailItem label="Selesai rental" value={formatDate(rental.endDate)} /><DetailItem label="Handover" value={formatDateTime(rental.handoverAt)} /><DetailItem label="Dikembalikan" value={formatDateTime(rental.returnedAt)} /><DetailItem label="Metode return" value={returnMethod} /><DetailItem label="Selesai pada" value={formatDateTime(rental.completedAt)} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">PEMBAYARAN & REFUND</span></div><div className="detail-pricing">{reservation.rentalAmount !== undefined && <DetailPrice label="Biaya sewa" value={reservation.rentalAmount} />}{reservation.depositAmount !== undefined && <DetailPrice label="Deposit" value={reservation.depositAmount} />}{reservation.totalAmount !== undefined && <div className="detail-total"><span>Total reservasi</span><strong>{formatCurrency(reservation.totalAmount)}</strong></div>}{rental.fine && <DetailPrice label="Denda" value={rental.fine.amount} />}{rental.refund && <DetailPrice label="Refund" value={rental.refund.amount} />}</div>{rental.fine?.damageItems?.length > 0 && <p className="detail-note">Item kerusakan: {rental.fine.damageItems.map((item) => typeof item === 'string' ? item : (item.label || item.name || item.description || item.type || 'Kerusakan')).join(', ')}</p>}</div>{rental.latestLocation && <div className="detail-section"><div className="detail-section-heading"><span className="section-label">LOKASI TERAKHIR</span><strong className="green-text">Live telemetry</strong></div><div className="detail-location"><span className="detail-location-icon">⌁</span><div><strong>{rental.latestLocation.latitude.toFixed(4)}, {rental.latestLocation.longitude.toFixed(4)}</strong><p>Kecepatan {rental.latestLocation.speed || 0} km/jam</p><small>Update {formatDateTime(rental.latestLocation.recordedAt)}</small></div></div></div>}</DetailDrawerShell>;
}

function DetailItem({ label, value }) { return <div className="detail-item"><span>{label}</span><strong>{value || '-'}</strong></div>; }
function DetailPrice({ label, value }) { return <div className="detail-price"><span>{label}</span><strong>{formatCurrency(value)}</strong></div>; }
function DetailDocument({ label, value, file }) { return <div className="detail-document"><span className="detail-document-icon">▤</span><div><strong>{label}</strong><p>{value || 'Nomor belum tersedia'}</p><small>{file || 'Dokumen belum tersedia'}</small></div></div>; }

function ReservationRow({ reservation, action, onDetail }) {
  const openDetail = () => onDetail?.(reservation);
  const handleClick = (event) => { if (!event.target.closest('button')) openDetail(); };
  return <div className={`data-row reservation-row ${onDetail ? 'is-clickable' : ''}`} onClick={handleClick} onKeyDown={(event) => { if (hasInteractiveTarget(event)) return; if ((event.key === 'Enter' || event.key === ' ') && onDetail) { event.preventDefault(); openDetail(); } }} role={onDetail ? 'button' : undefined} tabIndex={onDetail ? 0 : undefined}><div className="row-main"><div className="vehicle-avatar"><img src={reservation.vehicle?.image} alt="" /></div><div><strong>{reservation.vehicle?.name}</strong><span>{reservation.company?.name || reservation.vehicle?.company?.name} · {reservation.branch?.name || reservation.vehicle?.branch?.name}</span><small>{formatDate(reservation.startDate)}—{formatDate(reservation.endDate)} · {reservation.pickupMode === 'DELIVERY' ? 'Delivery' : 'Pickup cabang'}</small></div></div><div className="row-side"><strong>{formatCurrency(reservation.totalAmount)}</strong><StatusBadge value={reservation.status} />{reservation.cancellation && <small>Refund {formatCurrency(reservation.cancellation.refundAmount)} · {humanStatus(reservation.cancellation.refundStatus)}<br />{reservation.cancellation.reason}<br />Bukti: {reservation.cancellation.id}</small>}{onDetail && <button type="button" className="small-button detail-button" onClick={openDetail}>Lihat detail</button>}{action}</div></div>;
}

function ReservationMini({ reservation }) { return <div className="mini-row"><span className="mini-index">{reservation.vehicle?.name?.slice(0, 1)}</span><div><strong>{reservation.vehicle?.name}</strong><small>{reservation.customer?.name} · {formatDateTime(reservation.createdAt)}</small></div><StatusBadge value={reservation.status} /></div>; }
function FlowStep({ number, title, text }) { return <div className="flow-step"><span>{number}</span><div><strong>{title}</strong><small>{text}</small></div><i>→</i></div>; }
function SectionIntro({ eyebrow, title, text }) { return <div className="section-intro"><div><span className="section-label">{eyebrow}</span><h2>{title}</h2><p>{text}</p></div></div>; }
function EmptyState({ title, text }) { return <div className="empty-state"><span>◌</span><strong>{title}</strong><p>{text}</p></div>; }
function StatusBadge({ value, label }) { const tone = ['VERIFIED', 'AVAILABLE', 'ACTIVE', 'CONFIRMED', 'APPROVED_SIMULATED', 'READY'].includes(value) ? 'success' : ['MAINTENANCE', 'FAULTY', 'REJECTED', 'RETURN_PENDING_REVIEW', 'EXPIRED', 'REVOKED'].includes(value) ? 'warning' : 'neutral'; return <span className={`status-badge ${tone}`}><i />{label || humanStatus(value)}</span>; }
function Field({ label, value, onChange, type = 'text', required = false }) { return <label className="field"><span>{label}</span><input type={type} value={value ?? ''} onChange={(event) => onChange(event.target.value)} required={required} /></label>; }
function FileField({ label, onChange, multiple = false, accept = 'image/png,image/jpeg' }) { return <label className="file-field"><span>{label}</span><input type="file" accept={accept} multiple={multiple} onChange={(event) => onChange(multiple ? event.target.files : event.target.files?.[0] || null)} /><small>{accept.includes('application/pdf') ? 'PDF/JPG/PNG · upload dari halaman web' : 'JPG/PNG · upload dari halaman web'}</small></label>; }
function PhotoPreview({ images }) { return images.length ? <div className="photo-strip">{images.map((image, index) => <img key={`${image}-${index}`} src={image} alt={`Preview ${index + 1}`} />)}</div> : null; }

export default App;
