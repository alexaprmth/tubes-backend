import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet';
import {
  addDaysString,
  api,
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
  REJECTED: 'Ditolak'
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
    ['RENTALS', 'Rental aktif', '◉'],
    ['PROFILE', 'Profil', '◎']
  ],
  STAFF: [
    ['HANDOVER', 'Handover hari ini', '↗'],
    ['RETURNS', 'Return hari ini', '↙'],
    ['TRACKING', 'Tracking kendaraan', '⌁']
  ],
  RENTAL_ADMIN: [
    ['OVERVIEW', 'Overview', '◈'],
    ['RESERVATIONS', 'Reservasi masuk', '▤'],
    ['RENTALS', 'Rental berjalan', '◉'],
    ['FLEET', 'Armada & GPS', '▣'],
    ['MAINTENANCE', 'Maintenance', '✦']
  ],
  CENTRAL_ADMIN: [
    ['OVERVIEW', 'Overview global', '◈'],
    ['CUSTOMERS', 'Verifikasi customer', '◎'],
    ['COMPANIES', 'Perusahaan rental', '▦'],
    ['AGREEMENTS', 'Manajemen MoU GPS', '⌁']
  ]
};

const pageMeta = {
  SEARCH: ['Cari kendaraan', 'Temukan kendaraan yang tersedia dari perusahaan rental terdekat.'],
  RESERVATIONS: ['Reservasi', 'Pantau pembayaran dan status reservasi TransRent.'],
  RENTALS: ['Rental aktif', 'Lihat status rental dan lokasi kendaraan saat ini.'],
  PROFILE: ['Profil akun', 'Kelola informasi customer dan status verifikasi.'],
  HANDOVER: ['Handover hari ini', 'Dokumentasikan kondisi kendaraan sebelum diserahkan.'],
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

  const logout = () => {
    setSession(null);
    setSessionState(null);
  };

  if (!session?.user) return <AuthPage onLoggedIn={setSessionState} />;
  return <Workspace session={session} onLogout={logout} onSessionUpdated={setSessionState} />;
}

function AuthPage({ onLoggedIn }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: 'customer@transrent.demo', password: 'demo123', name: '', phone: '', address: '', ktpNumber: '', simNumber: '' });
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
          {mode === 'login' && (
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
  const [data, setData] = useState({ reservations: [], rentals: [], tracking: [], summary: null, customers: [], companies: [], fleet: [], maintenance: [], agreements: [] });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const notify = useCallback((type, text) => {
    setToast({ type, text });
    window.setTimeout(() => setToast(null), 4500);
  }, []);

  const syncSessionUser = useCallback((nextUser) => {
    if (!nextUser || JSON.stringify(nextUser) === JSON.stringify(session.user)) return;
    const nextSession = { ...session, user: nextUser };
    setSession(nextSession);
    onSessionUpdated(nextSession);
  }, [onSessionUpdated, session]);

  const loadData = useCallback(async () => {
    setBusy(true);
    const agreementRequest = actor.role === 'CENTRAL_ADMIN'
      ? api('/admin/gps-agreements').catch(() => ({ agreements: [] }))
      : Promise.resolve({ agreements: [] });
    const companyRequest = actor.role === 'CENTRAL_ADMIN'
      ? api('/admin/companies').catch(() => ({ companies: [] }))
      : api('/companies').catch(() => ({ companies: [] }));
    const [me, reservations, rentals, tracking, summary, customers, companies, fleet, maintenance, agreements] = await Promise.all([
      api('/auth/me').catch(() => null),
      api('/reservations').catch(() => ({ reservations: [] })),
      api('/rentals').catch(() => ({ rentals: [] })),
      api('/tracking/vehicles').catch(() => ({ vehicles: [] })),
      api('/admin/summary').catch(() => ({ summary: null })),
      api('/admin/customers').catch(() => ({ customers: [] })),
      companyRequest,
      api('/admin/fleet').catch(() => ({ fleet: [] })),
      api('/maintenance').catch(() => ({ maintenance: [] })),
      agreementRequest
    ]);
    syncSessionUser(me?.user);
    setData({ reservations: reservations.reservations || [], rentals: rentals.rentals || [], tracking: tracking.vehicles || [], summary: summary.summary || null, customers: customers.customers || [], companies: companies.companies || [], fleet: fleet.fleet || [], maintenance: maintenance.maintenance || [], agreements: agreements.agreements || [] });
    setLastRefresh(new Date());
    setBusy(false);
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
          {navItems.map(([key, label, icon]) => <button key={key} className={`nav-button ${page === key ? 'active' : ''}`} onClick={() => setPage(key)}><span className="nav-icon">{icon}</span><span>{label}</span></button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note"><span>⌁</span><div><strong>Demo mode</strong><small>Data tersimpan di memory backend.</small></div></div>
          <div className="user-mini"><div className="avatar">{actor.name?.slice(0, 1).toUpperCase()}</div><div className="user-mini-copy"><strong>{actor.name}</strong><small>{roleLabels[actor.role]}</small></div><button title="Keluar" onClick={onLogout}>↪</button></div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar"><div><p className="eyebrow">{roleLabels[actor.role]} workspace</p><h1>{meta[0]}</h1><p className="page-subtitle">{meta[1]}</p></div><div className="topbar-actions"><span className="last-sync">Sync {lastRefresh.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span><button className="icon-button" onClick={loadData} disabled={busy} title="Refresh data">↻</button><div className="avatar large-avatar">{actor.name?.slice(0, 1).toUpperCase()}</div></div></header>
        {toast && <div className={`toast ${toast.type}`}>{toast.type === 'success' ? '✓' : '!'} {toast.text}</div>}
        <div className="content-area">
          {actor.role === 'CUSTOMER' && <CustomerPages page={page} actor={actor} data={data} onRefresh={loadData} onNotify={notify} onCreated={() => { loadData(); setPage('RESERVATIONS'); }} />}
          {actor.role !== 'CUSTOMER' && <OperationsPages page={page} actor={actor} data={data} onRefresh={loadData} onNotify={notify} runAction={runAction} />}
        </div>
      </main>
    </div>
  );
}

function CustomerPages({ page, actor, data, onRefresh, onNotify, onCreated }) {
  if (page === 'SEARCH') return <SearchPage onCreated={onCreated} onNotify={onNotify} />;
  if (page === 'RESERVATIONS') return <CustomerReservations reservations={data.reservations} onRefresh={onRefresh} onNotify={onNotify} />;
  if (page === 'RENTALS') return <TrackingPage actor={actor} tracking={data.tracking} onRefresh={onRefresh} onNotify={onNotify} />;
  return <ProfilePage actor={actor} />;
}

function OperationsPages({ page, actor, data, onRefresh, onNotify, runAction }) {
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
  const [selected, setSelected] = useState(null);
  const pay = async (id) => {
    try {
      await api(`/reservations/${id}/payments/simulate`, { method: 'POST' });
      onNotify('success', 'Pembayaran simulasi berhasil. Reservasi dikonfirmasi.');
      onRefresh();
      return true;
    } catch (error) {
      onNotify('danger', error.message);
      return false;
    }
  };
  return <div className="page-stack"><SectionIntro eyebrow="MY RESERVATIONS" title="Semua reservasi dalam satu tempat" text="Bayar reservasi yang masih pending atau lihat detail perjalananmu." /><div className="list-stack">{reservations.length === 0 ? <EmptyState title="Belum ada reservasi" text="Cari kendaraan untuk membuat reservasi pertamamu." /> : reservations.map((reservation) => <ReservationRow key={reservation.id} reservation={reservation} onDetail={setSelected} action={reservation.status === 'PENDING_PAYMENT' ? <button type="button" className="small-button primary" onClick={() => pay(reservation.id)}>Bayar simulasi</button> : null} />)}</div>{selected && <ReservationDetailDrawer reservation={selected} onClose={() => setSelected(null)} onPay={async () => { if (await pay(selected.id)) setSelected(null); }} />}</div>;
}

function AdminReservations({ reservations, onRefresh, onNotify, actor }) {
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const confirmed = reservations.filter((reservation) => reservation.status === 'CONFIRMED');
  return <div className="page-stack"><SectionIntro eyebrow="RESERVATION INBOX" title="Reservasi yang perlu diproses" text="Handover hanya tersedia setelah pembayaran berhasil dan GPS kendaraan READY." /><div className="list-stack">{reservations.length === 0 ? <EmptyState title="Inbox masih kosong" text="Belum ada reservasi dari customer." /> : reservations.map((reservation) => <ReservationRow key={reservation.id} reservation={reservation} onDetail={setDetail} action={reservation.status === 'CONFIRMED' ? <button type="button" className="small-button primary" onClick={() => setSelected(reservation)}>Mulai handover</button> : null} />)}</div>{detail && <ReservationDetailDrawer reservation={detail} showCustomer onClose={() => setDetail(null)} />}{selected && <InspectionModal mode="BEFORE" target={{ reservation: selected }} onClose={() => setSelected(null)} onDone={() => { setSelected(null); onNotify('success', 'Handover dan inspeksi BEFORE berhasil disimpan.'); onRefresh(); }} actor={actor} />}</div>;
}

function HandoverPage({ reservations, onRefresh, onNotify }) {
  const [selected, setSelected] = useState(null);
  const confirmed = reservations.filter((reservation) => reservation.status === 'CONFIRMED');
  return <div className="page-stack"><SectionIntro eyebrow="STAFF DESK" title="Handover hari ini" text="Lengkapi foto, checklist, dan tanda tangan sebelum kendaraan diserahkan." /><div className="action-grid">{confirmed.length === 0 ? <EmptyState title="Tidak ada handover tertunda" text="Reservasi yang sudah dibayar akan muncul di sini." /> : confirmed.map((reservation) => <article className="task-card" key={reservation.id}><div className="task-card-head"><span className="task-icon">↗</span><StatusBadge value={reservation.status} /></div><strong>{reservation.vehicle.name}</strong><span>{reservation.customer.name} · {formatDate(reservation.startDate)}</span><small>{reservation.pickupMode === 'DELIVERY' ? 'Delivery ke customer' : reservation.branch?.name}</small><button className="secondary-button" onClick={() => setSelected(reservation)}>Buka inspeksi BEFORE</button></article>)}</div>{selected && <InspectionModal mode="BEFORE" target={{ reservation: selected }} onClose={() => setSelected(null)} onDone={() => { setSelected(null); onNotify('success', 'Handover berhasil disimpan.'); onRefresh(); }} />}</div>;
}

function ReturnPage({ rentals, onRefresh, onNotify }) {
  const [selected, setSelected] = useState(null);
  const active = rentals.filter((rental) => rental.status === 'ACTIVE');
  return <div className="page-stack"><SectionIntro eyebrow="RETURN DESK" title="Return kendaraan" text="Ambil foto sisi staff dan customer, lalu review kerusakan sebelum refund." /><div className="action-grid">{active.length === 0 ? <EmptyState title="Tidak ada rental aktif" text="Rental aktif akan muncul di sini saat handover selesai." /> : active.map((rental) => <article className="task-card" key={rental.id}><div className="task-card-head"><span className="task-icon return">↙</span><StatusBadge value={rental.status} /></div><strong>{rental.vehicle.name}</strong><span>{rental.customer.name} · selesai {formatDate(rental.endDate)}</span><small>{rental.vehicle.branch.name}</small><button className="secondary-button" onClick={() => setSelected(rental)}>Buka inspeksi AFTER</button></article>)}</div>{selected && <InspectionModal mode="AFTER" target={{ rental: selected }} onClose={() => setSelected(null)} onDone={() => { setSelected(null); onNotify('success', 'Return dan inspeksi AFTER berhasil disimpan.'); onRefresh(); }} />}</div>;
}

function AdminRentals({ rentals, onRefresh, onNotify, actor }) {
  const [detail, setDetail] = useState(null);
  const confirm = async (id) => {
    try { await api(`/rentals/${id}/refund/confirm`, { method: 'POST' }); onNotify('success', 'Refund disimulasikan dan kendaraan kembali tersedia.'); onRefresh(); } catch (error) { onNotify('danger', error.message); }
  };
  return <div className="page-stack"><SectionIntro eyebrow="RENTAL OPERATIONS" title="Rental berjalan dan refund" text="Admin Rental mengonfirmasi hasil inspeksi sebelum rental ditutup." /><div className="list-stack">{rentals.length === 0 ? <EmptyState title="Belum ada rental" text="Rental akan muncul setelah proses handover." /> : rentals.map((rental) => <div className="data-row detail-row" key={rental.id} onClick={(event) => { if (!hasInteractiveTarget(event)) setDetail(rental); }} onKeyDown={(event) => openDetailWithKeyboard(event, () => setDetail(rental))} role="button" tabIndex="0"><div className="row-main"><div className="vehicle-avatar"><img src={rental.vehicle.image} alt="" /></div><div><strong>{rental.vehicle.name}</strong><span>{rental.customer.name} · {formatDate(rental.startDate)}—{formatDate(rental.endDate)}</span><small>{rental.vehicle.company.name} · {rental.vehicle.branch.name}</small></div></div><div className="row-side"><StatusBadge value={rental.status} />{rental.refund?.status === 'PENDING_CONFIRMATION' && actor.role !== 'STAFF' && <button type="button" className="small-button primary" onClick={() => confirm(rental.id)}>Konfirmasi refund</button>}{rental.fine && <small className="fine-text">Denda {formatCurrency(rental.fine.amount)}</small>}</div></div>)}</div>{detail && <RentalDetailDrawer rental={detail} onClose={() => setDetail(null)} />}</div>;
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
  return <div className="page-stack"><SectionIntro eyebrow="ACCOUNT" title="Profil customer" text="Data identitas digunakan untuk proses verifikasi dan reservasi." /><div className="profile-layout"><div className="profile-card"><div className="profile-avatar">{actor.name?.slice(0, 1).toUpperCase()}</div><h3>{actor.name}</h3><span>{actor.email}</span><StatusBadge value={actor.verificationStatus} /><div className="profile-divider" /><div className="profile-detail"><small>Nomor telepon</small><strong>{actor.phone || '-'}</strong></div><div className="profile-detail"><small>Alamat</small><strong>{actor.address || '-'}</strong></div></div><div className="panel"><div className="panel-heading"><div><span className="section-label">VERIFICATION</span><h3>Status dokumen</h3></div><StatusBadge value={actor.verificationStatus} /></div><p className="panel-copy">KTP dan SIM diverifikasi oleh Admin Pusat. Data dokumen tidak dapat diubah langsung setelah dikirim.</p><div className="document-row"><span className="document-icon">▤</span><div><strong>KTP</strong><small>{documentLabel(actor.ktpDocument)}</small></div><StatusBadge value={documentStatus} /></div><div className="document-row"><span className="document-icon">▤</span><div><strong>SIM</strong><small>{documentLabel(actor.simDocument)}</small></div><StatusBadge value={documentStatus} /></div></div></div></div>;
}

function CentralCustomers({ customers, runAction }) {
  const [detail, setDetail] = useState(null);
  return <div className="page-stack"><SectionIntro eyebrow="CENTRAL VERIFICATION" title="Review customer" text="Admin Pusat memastikan dokumen customer sebelum pembayaran diizinkan." /><div className="list-stack">{customers.map((customer) => <div className="data-row detail-row" key={customer.id} onClick={(event) => { if (!hasInteractiveTarget(event)) setDetail(customer); }} onKeyDown={(event) => openDetailWithKeyboard(event, () => setDetail(customer))} role="button" tabIndex="0"><div className="row-main"><div className="avatar">{customer.name?.slice(0, 1)}</div><div><strong>{customer.name}</strong><span>{customer.email} · {customer.phone || '-'}</span><small>KTP: {customer.ktpNumber || '-'} · SIM: {customer.simNumber || '-'}</small></div></div><div className="row-side"><StatusBadge value={customer.verificationStatus} /><button type="button" className="small-button detail-button" onClick={() => setDetail(customer)}>Lihat detail</button>{customer.verificationStatus !== 'VERIFIED' && <button type="button" className="small-button primary" onClick={() => runAction(() => api(`/admin/customers/${customer.id}/verification`, { method: 'PATCH', body: JSON.stringify({ status: 'VERIFIED' }) }), `${customer.name} berhasil diverifikasi.`)}>Verifikasi</button>}</div></div>)}{customers.length === 0 && <EmptyState title="Tidak ada customer" text="Customer baru akan muncul di sini." />}</div>{detail && <CustomerDetailDrawer customer={detail} onClose={() => setDetail(null)} />}</div>;
}

function CompaniesPage({ companies, onRefresh, onNotify, runAction }) {
  const [detail, setDetail] = useState(null);
  const updateStatus = (company, status) => runAction(
    () => api(`/admin/companies/${company.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    `${company.name} diperbarui menjadi ${status === 'ACTIVE' ? 'Aktif' : status === 'SUSPENDED' ? 'Suspended' : 'Pending'}.`
  );
  return <div className="page-stack"><div className="section-split"><SectionIntro eyebrow="PLATFORM DIRECTORY" title="Perusahaan rental" text="Kelola perusahaan rental, status operasional, dan hubungan Admin Rental." /><button type="button" className="primary-button" onClick={() => setDetail({ create: true })}>+ Tambah perusahaan</button></div><div className="company-grid">{companies.map((company) => <article className="company-card detail-card" key={company.id} onClick={() => setDetail(company)} onKeyDown={(event) => openDetailWithKeyboard(event, () => setDetail(company))} role="button" tabIndex="0"><div className="company-symbol">{company.name.slice(0, 1)}</div><div><span className={`status-dot ${company.status === 'ACTIVE' ? 'active' : ''}`} /> {company.status}</div><h3>{company.name}</h3><p>{company.description || 'Belum ada deskripsi perusahaan.'}</p><div className="company-meta"><span>{company.branches.length} cabang</span><span>Radius {company.deliveryRadiusKm} km</span></div><div className="branch-list"><span className={company.gpsAgreementStatus === 'ACTIVE' && company.gpsTrackingAllowed ? 'green-text' : 'red-text'}>⌁ MoU GPS {company.gpsAgreementStatus === 'ACTIVE' && company.gpsTrackingAllowed ? 'aktif' : company.gpsAgreementStatus ? humanStatus(company.gpsAgreementStatus) : 'belum ada'}</span>{company.branches.map((branch) => <span key={branch.id}>⌖ {branch.name}</span>)}</div><div className="company-card-actions"><button type="button" className="small-button detail-card-action" onClick={(event) => { event.stopPropagation(); setDetail(company); }}>Lihat detail</button><select aria-label={`Status ${company.name}`} value={company.status} onClick={(event) => event.stopPropagation()} onChange={(event) => { event.stopPropagation(); updateStatus(company, event.target.value); }}><option value="PENDING">Pending</option><option value="ACTIVE">Aktif</option><option value="SUSPENDED">Suspended</option></select></div></article>)}{companies.length === 0 && <EmptyState title="Belum ada perusahaan rental" text="Tambahkan perusahaan rental pertama dari tombol di atas." />}</div>{detail?.create && <CompanyOnboardingModal onClose={() => setDetail(null)} onRefresh={onRefresh} onNotify={onNotify} />}{detail && !detail.create && <CompanyDetailDrawer company={detail} onClose={() => setDetail(null)} />}</div>;
}

function GpsAgreementsPage({ agreements, companies, onRefresh, onNotify }) {
  const [detail, setDetail] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const statusOptions = Object.keys(agreementStatusLabels);
  const activeCount = agreements.filter((agreement) => agreement.status === 'ACTIVE').length;
  const pendingCount = agreements.filter((agreement) => ['DRAFT', 'PENDING'].includes(agreement.status)).length;
  const attentionCount = agreements.filter((agreement) => ['EXPIRED', 'REVOKED'].includes(agreement.status)).length;

  const updateStatus = (agreement, status, gpsTrackingAllowed = status === 'ACTIVE') => {
    setDetail(null);
    runAction(
      () => api(`/admin/gps-agreements/${agreement.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, gpsTrackingAllowed })
      }),
      `${agreement.companyName || 'Agreement'} diperbarui menjadi ${humanAgreementStatus(status)}.`
    );
  };

  return <div className="page-stack"><div className="section-split"><SectionIntro eyebrow="GPS AGREEMENTS" title="Manajemen MoU GPS" text="Kelola agreement perusahaan rental, masa berlaku, dan izin GPS tracking kendaraan." /><button type="button" className="primary-button" onClick={() => setShowCreate(true)} disabled={companies.length === 0}>+ Tambah MoU</button></div><div className="metric-grid agreement-metrics"><article className="metric-card"><span className="metric-icon">⌁</span><small>Total agreement</small><strong>{agreements.length}</strong><span className="metric-note">seluruh perusahaan</span></article><article className="metric-card"><span className="metric-icon">✓</span><small>MoU aktif</small><strong>{activeCount}</strong><span className="metric-note">GPS dapat digunakan</span></article><article className="metric-card"><span className="metric-icon">◌</span><small>Perlu review</small><strong>{pendingCount}</strong><span className="metric-note">draft atau pending</span></article><article className="metric-card"><span className="metric-icon">!</span><small>Perlu perhatian</small><strong>{attentionCount}</strong><span className="metric-note">expired atau dicabut</span></article></div><div className="agreement-grid">{agreements.map((agreement) => <article className="agreement-card detail-card" key={agreement.id} onClick={() => setDetail(agreement)} onKeyDown={(event) => openDetailWithKeyboard(event, () => setDetail(agreement))} role="button" tabIndex="0"><div className="agreement-card-top"><div><span className="section-label">MOU GPS</span><h3>{agreement.companyName || 'Perusahaan belum tersedia'}</h3></div><StatusBadge value={agreement.status} label={humanAgreementStatus(agreement.status)} /></div><div className="agreement-number">{agreement.agreementNumber || 'Nomor agreement belum tersedia'}</div><div className="agreement-meta"><div><span>Ditandatangani</span><strong>{formatDate(agreement.signedAt)}</strong></div><div><span>Berlaku sampai</span><strong>{formatDate(agreement.expiresAt)}</strong></div><span className={`agreement-gps ${agreement.gpsTrackingAllowed ? '' : 'off'}`}>⌁ GPS tracking {agreement.gpsTrackingAllowed ? 'diizinkan' : 'belum diizinkan'}</span></div><div className="agreement-card-footer"><button type="button" className="small-button detail-card-action" onClick={(event) => { event.stopPropagation(); setDetail(agreement); }}>Lihat detail</button><select aria-label={`Status MoU ${agreement.companyName || ''}`} value={agreement.status} onClick={(event) => event.stopPropagation()} onChange={(event) => { event.stopPropagation(); updateStatus(agreement, event.target.value); }}>{statusOptions.map((status) => <option key={status} value={status}>{agreementStatusLabels[status]}</option>)}</select></div></article>)}{agreements.length === 0 && <EmptyState title="Belum ada MoU GPS" text="Agreement perusahaan rental akan muncul di sini." />}</div>{detail && <GpsAgreementDetailDrawer agreement={detail} onClose={() => setDetail(null)} onStatusChange={updateStatus} />}{showCreate && <GpsAgreementCreateModal companies={companies} onClose={() => setShowCreate(false)} onRefresh={onRefresh} onNotify={onNotify} />}</div>;
}

function CompanyOnboardingModal({ onClose, onRefresh, onNotify }) {
  const [form, setForm] = useState({ name: '', legalName: '', email: '', phone: '', description: '', adminName: '', adminEmail: '', signedAt: '', expiresAt: '', notes: '' });
  const [documentFile, setDocumentFile] = useState(null);
  const [companyId, setCompanyId] = useState(null);
  const [agreementCreated, setAgreementCreated] = useState(false);
  const [invitationSent, setInvitationSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      let company = companyId ? { id: companyId } : null;
      if (!company) {
        const response = await api('/admin/companies', { method: 'POST', body: JSON.stringify({ name: form.name, legalName: form.legalName, email: form.email, phone: form.phone, description: form.description }) });
        company = response.company;
        setCompanyId(company.id);
      }
      let agreement = null;
      if (!agreementCreated) {
        const agreementResponse = await api(`/admin/companies/${company.id}/agreements`, { method: 'POST', body: JSON.stringify({ status: 'PENDING', signedAt: form.signedAt || null, expiresAt: form.expiresAt || null, notes: form.notes, documentDataUrl: documentFile ? await fileToDataUrl(documentFile) : null }) });
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
      onNotify('success', `Perusahaan ${form.name || 'rental'} berhasil dibuat. MoU ${agreement?.agreementNumber || 'otomatis'} tersimpan sebagai Pending.${form.adminEmail ? ` Undangan dikirim ke ${form.adminEmail}.` : ''}${inviteMessage}`);
      onClose();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card wide-modal"><div className="drawer-header"><div><span className="section-label">NEW RENTAL COMPANY</span><h3>Tambah perusahaan rental</h3><p>Perusahaan dibuat Pending sampai disetujui Admin Pusat.</p></div><button type="button" className="close-button" onClick={onClose}>×</button></div>{error && <div className="notice danger">{error}</div>}<form className="stack-form" onSubmit={submit}><div className="onboarding-section"><div className="onboarding-heading"><span className="section-label">01 · PROFIL PERUSAHAAN</span><small>Data dasar perusahaan rental</small></div><div className="form-grid two"><Field label="Nama perusahaan" value={form.name} onChange={(value) => update('name', value)} required /><Field label="Nama legal" value={form.legalName} onChange={(value) => update('legalName', value)} /></div><div className="form-grid two"><Field label="Email perusahaan" type="email" value={form.email} onChange={(value) => update('email', value)} /><Field label="Nomor telepon" value={form.phone} onChange={(value) => update('phone', value)} /></div><Field label="Deskripsi" value={form.description} onChange={(value) => update('description', value)} /></div><div className="onboarding-section"><div className="onboarding-heading"><span className="section-label">02 · ADMIN RENTAL</span><small>Opsional, bisa diundang setelah perusahaan dibuat</small></div><div className="form-grid two"><Field label="Nama PIC" value={form.adminName} onChange={(value) => update('adminName', value)} /><Field label="Email undangan" type="email" value={form.adminEmail} onChange={(value) => update('adminEmail', value)} /></div><p className="helper-text">Admin Pusat tidak membuat password. Sistem mengirim undangan dan Admin Rental membuat password sendiri.</p></div><div className="onboarding-section"><div className="onboarding-heading"><span className="section-label">03 · MOU GPS</span><small>Nomor dibuat otomatis oleh sistem</small></div><div className="agreement-auto-number"><span>Nomor MoU</span><strong>Otomatis saat disimpan</strong></div><FileField label="Dokumen MoU" accept="application/pdf,image/png,image/jpeg" onChange={setDocumentFile} /><div className="form-grid two"><label className="field"><span>Tanggal tanda tangan</span><input type="date" value={form.signedAt} onChange={(event) => update('signedAt', event.target.value)} /></label><label className="field"><span>Berlaku sampai</span><input type="date" value={form.expiresAt} onChange={(event) => update('expiresAt', event.target.value)} /></label></div><Field label="Catatan MoU" value={form.notes} onChange={(value) => update('notes', value)} /></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={busy}>{busy ? 'Menyimpan...' : companyId ? 'Lanjutkan setup' : 'Buat perusahaan'}</button></div></form></section></div>;
}

function GpsAgreementCreateModal({ companies, onClose, onRefresh, onNotify }) {
  const [form, setForm] = useState({ companyId: companies[0]?.id || '', status: 'PENDING', signedAt: '', expiresAt: '', notes: '' });
  const [documentFile, setDocumentFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await api(`/admin/companies/${form.companyId}/agreements`, { method: 'POST', body: JSON.stringify({ status: form.status, signedAt: form.signedAt || null, expiresAt: form.expiresAt || null, notes: form.notes, documentDataUrl: documentFile ? await fileToDataUrl(documentFile) : null }) });
      await onRefresh();
      onNotify('success', `MoU ${response.agreement?.agreementNumber || 'baru'} berhasil ditambahkan.`);
      onClose();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(false);
    }
  };
  return <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card wide-modal"><div className="drawer-header"><div><span className="section-label">NEW GPS AGREEMENT</span><h3>Tambah MoU GPS</h3><p>Nomor MoU dibuat otomatis. MoU baru dimulai sebagai Pending dan harus direview sebelum diaktifkan.</p></div><button type="button" className="close-button" onClick={onClose}>×</button></div>{error && <div className="notice danger">{error}</div>}<form className="stack-form" onSubmit={submit}><label className="field"><span>Perusahaan rental</span><select value={form.companyId} onChange={(event) => update('companyId', event.target.value)} required>{companies.map((company) => <option key={company.id} value={company.id}>{company.name} · {humanStatus(company.status)}</option>)}</select></label><div className="form-grid two"><div className="agreement-auto-number"><span>Nomor MoU</span><strong>Otomatis saat disimpan</strong></div><label className="field"><span>Status awal</span><select value={form.status} onChange={(event) => update('status', event.target.value)}>{Object.keys(agreementStatusLabels).map((status) => <option key={status} value={status}>{agreementStatusLabels[status]}</option>)}</select></label></div><div className="form-grid two"><label className="field"><span>Tanggal tanda tangan</span><input type="date" value={form.signedAt} onChange={(event) => update('signedAt', event.target.value)} /></label><label className="field"><span>Berlaku sampai</span><input type="date" value={form.expiresAt} onChange={(event) => update('expiresAt', event.target.value)} /></label></div><FileField label="Dokumen MoU" accept="application/pdf,image/png,image/jpeg" onChange={setDocumentFile} /><Field label="Catatan" value={form.notes} onChange={(value) => update('notes', value)} /><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={busy}>{busy ? 'Menyimpan...' : 'Simpan MoU'}</button></div></form></section></div>;
}

function FleetPage({ fleet }) {
  const [detail, setDetail] = useState(null);
  return <div className="page-stack"><SectionIntro eyebrow="FLEET CONTROL" title="Armada dan kesiapan GPS" text="Kendaraan tanpa GPS READY tidak dapat dipesan atau handover." /><div className="fleet-grid">{fleet.map((vehicle) => <article className="fleet-card detail-card" key={vehicle.id} onClick={() => setDetail(vehicle)} onKeyDown={(event) => openDetailWithKeyboard(event, () => setDetail(vehicle))} role="button" tabIndex="0"><img src={vehicle.image} alt="" /><div className="fleet-card-copy"><div className="fleet-card-top"><span className="vehicle-type">{vehicle.type === 'CAR' ? 'MOBIL' : 'MOTOR'}</span><StatusBadge value={vehicle.status} /></div><h3>{vehicle.name}</h3><p>{vehicle.company.name} · {vehicle.branch.name}</p><div className="fleet-meta"><span>GPS <b className={vehicle.gpsStatus === 'READY' ? 'green-text' : 'red-text'}>{humanStatus(vehicle.gpsStatus)}</b></span><span>{vehicle.plateNumber}</span></div><button type="button" className="small-button detail-card-action" onClick={(event) => { event.stopPropagation(); setDetail(vehicle); }}>Lihat detail</button></div></article>)}</div>{detail && <FleetDetailDrawer vehicle={detail} onClose={() => setDetail(null)} />}</div>;
}

function MaintenancePage({ maintenance, fleet, runAction }) {
  const [vehicleId, setVehicleId] = useState(fleet[0]?.id || '');
  const [title, setTitle] = useState('Servis berkala');
  const lifecycleAction = (item) => {
    if (item.status === 'SCHEDULED') return <><button className="small-button" onClick={() => runAction(() => api(`/maintenance/${item.id}/start`, { method: 'POST' }), 'Maintenance dimulai.')}>Mulai</button><button className="small-button danger" onClick={() => runAction(() => api(`/maintenance/${item.id}/cancel`, { method: 'POST' }), 'Maintenance dibatalkan.')}>Batalkan</button></>;
    if (item.status === 'IN_PROGRESS') return <><button className="small-button primary" onClick={() => runAction(() => api(`/maintenance/${item.id}/complete`, { method: 'POST' }), 'Maintenance selesai.')}>Selesai</button><button className="small-button danger" onClick={() => runAction(() => api(`/maintenance/${item.id}/cancel`, { method: 'POST' }), 'Maintenance dibatalkan.')}>Batalkan</button></>;
    return null;
  };
  return <div className="page-stack"><SectionIntro eyebrow="FLEET CARE" title="Maintenance kendaraan" text="Kendaraan maintenance otomatis tidak tersedia untuk reservasi." /><div className="two-column"><div className="panel"><div className="panel-heading"><div><span className="section-label">NEW TASK</span><h3>Jadwalkan maintenance</h3></div></div><form className="stack-form" onSubmit={(event) => { event.preventDefault(); runAction(() => api('/maintenance', { method: 'POST', body: JSON.stringify({ vehicleId, title, type: 'SERVICE' }) }), 'Maintenance berhasil dibuat.'); }}><label className="field"><span>Kendaraan</span><select value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}>{fleet.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.name}</option>)}</select></label><Field label="Judul maintenance" value={title} onChange={setTitle} /><button className="primary-button">Simpan maintenance</button></form></div><div className="panel"><div className="panel-heading"><div><span className="section-label">MAINTENANCE QUEUE</span><h3>Daftar pekerjaan</h3></div></div>{maintenance.map((item) => <div className="maintenance-row" key={item.id}><span className="task-icon">✦</span><div><strong>{item.title}</strong><span>{item.vehicle?.name || 'Kendaraan'}</span><small>{item.notes}</small></div><div className="row-side"><StatusBadge value={item.status} /><div className="inline-actions">{lifecycleAction(item)}</div></div></div>)}{maintenance.length === 0 && <EmptyState title="Belum ada maintenance" text="Jadwal servis akan muncul di sini." />}</div></div></div>;
}

function InspectionModal({ mode, target, onClose, onDone }) {
  const isBefore = mode === 'BEFORE';
  const subject = isBefore ? target.reservation : target.rental;
  const [staffPhotos, setStaffPhotos] = useState([]);
  const [customerPhotos, setCustomerPhotos] = useState([]);
  const [signature, setSignature] = useState(null);
  const [notes, setNotes] = useState('');
  const [actualReturnDate, setActualReturnDate] = useState(subject.endDate || todayString());
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
    if (!signature || customerPhotos.length === 0 || staffPhotos.length === 0) {
      setError('Foto staff, foto customer, dan tanda tangan wajib diisi.');
      return;
    }
    setBusy(true); setError('');
    try {
      const body = { staffChecklist: Object.entries(checklist).filter(([, value]) => value).map(([key]) => checklistLabels[key]), staffPhotos, customerPhotos, customerSignature: signature, notes };
      if (isBefore) await api(`/reservations/${subject.id}/handover`, { method: 'POST', body: JSON.stringify(body) });
      else await api(`/rentals/${subject.id}/return`, { method: 'POST', body: { ...body, actualReturnDate, returnMethod, returnSchedule: returnMethod === 'STAFF_PICKUP' ? { date: actualReturnDate, time: pickupTime, address: pickupAddress } : null, damageItems: damageType && damageAmount ? [{ type: damageType, amount: Number(damageAmount) }] : [] } });
      onDone();
    } catch (submitError) { setError(submitError.message); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section className="modal-card wide-modal"><div className="drawer-header"><div><span className="section-label">{isBefore ? 'HANDOVER / BEFORE' : 'RETURN / AFTER'}</span><h3>{isBefore ? 'Dokumentasi serah-terima' : 'Dokumentasi pengembalian'}</h3><p>{subject.vehicle?.name || subject.vehicle?.name}</p></div><button className="close-button" onClick={onClose}>×</button></div>{error && <div className="notice danger">{error}</div>}<form onSubmit={submit} className="inspection-form"><div className="inspection-columns"><div><h4>1. Foto staff</h4><FileField label="Upload foto kondisi dari staff" multiple onChange={(files) => readFiles(files, setStaffPhotos)} /><PhotoPreview images={staffPhotos} /></div><div><h4>2. Foto customer</h4><FileField label="Upload foto kondisi dari customer" multiple onChange={(files) => readFiles(files, setCustomerPhotos)} /><PhotoPreview images={customerPhotos} /></div></div><div><h4>3. Checklist staff</h4><div className="checklist-grid">{Object.entries(checklistLabels).map(([key, label]) => <label className="check-item" key={key}><input type="checkbox" checked={checklist[key]} onChange={(event) => setChecklist((current) => ({ ...current, [key]: event.target.checked }))} /><span>{label}</span></label>)}</div></div>{!isBefore && <div className="return-options"><h4>4. Return dan denda</h4><div className="form-grid three"><label className="field"><span>Metode return</span><select value={returnMethod} onChange={(event) => setReturnMethod(event.target.value)}><option value="SELF_RETURN">Kembali ke cabang awal</option><option value="STAFF_PICKUP">Diambil staff</option></select></label><label className="field"><span>Tanggal aktual</span><input type="date" value={actualReturnDate} onChange={(event) => setActualReturnDate(event.target.value)} /></label>{returnMethod === 'STAFF_PICKUP' && <label className="field"><span>Jam pickup</span><input type="time" value={pickupTime} onChange={(event) => setPickupTime(event.target.value)} /></label>}</div>{returnMethod === 'STAFF_PICKUP' && <Field label="Alamat pickup staff" value={pickupAddress} onChange={setPickupAddress} required />}<div className="form-grid two"><label className="field"><span>Jenis kerusakan (opsional)</span><select value={damageType} onChange={(event) => setDamageType(event.target.value)}><option value="">Tidak ada kerusakan</option><option value="BODY">Bodi/kaca</option><option value="TIRE">Ban/velg</option><option value="LIGHT">Lampu</option><option value="ENGINE">Mesin</option><option value="EQUIPMENT">Kelengkapan</option></select></label><Field label="Nominal denda" type="number" value={damageAmount} onChange={setDamageAmount} /></div></div>}<div><h4>{isBefore ? '4' : '5'}. Tanda tangan customer</h4><SignaturePad onChange={setSignature} /></div><label className="field"><span>Catatan inspeksi</span><textarea rows="3" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Tambahkan catatan kondisi..." /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={busy}>{busy ? 'Menyimpan...' : isBefore ? 'Simpan handover' : 'Simpan return'}</button></div></form></section></div>;
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

  return <div className="drawer-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="reservation-drawer detail-drawer"><div className="drawer-header"><div><span className="section-label">RESERVATION DETAIL</span><h3>Detail reservasi</h3><p>#{reservation.id}</p></div><button type="button" className="close-button" onClick={onClose}>×</button></div><div className="detail-vehicle"><img src={vehicle.image} alt="" /><div><span className="vehicle-type">{vehicle.type === 'CAR' ? 'MOBIL' : 'MOTOR'}</span><h4>{vehicle.name || 'Kendaraan'}</h4><p>{company.name || '-'} · {branch.name || '-'}</p><StatusBadge value={reservation.status} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">JADWAL PERJALANAN</span><strong>{rentalDays || '-'} hari</strong></div><div className="detail-grid"><DetailItem label="Mulai rental" value={formatDate(reservation.startDate)} /><DetailItem label="Selesai rental" value={formatDate(reservation.endDate)} /><DetailItem label="Dibuat pada" value={formatDateTime(reservation.createdAt)} /><DetailItem label="GPS kendaraan" value={humanStatus(vehicle.gpsStatus || 'READY')} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">LOKASI SERAH TERIMA</span><strong>{isDelivery ? 'Delivery' : 'Pickup cabang'}</strong></div><div className="detail-location"><span className="detail-location-icon">{isDelivery ? '⌖' : '⌂'}</span><div><strong>{isDelivery ? 'Diantar ke alamat customer' : branch.name || 'Cabang rental'}</strong><p>{isDelivery ? reservation.deliveryAddress || 'Alamat belum tersedia' : branch.address || 'Alamat cabang belum tersedia'}</p>{isDelivery && <small>{reservation.recipientPhone ? `Penerima: ${reservation.recipientPhone}` : ''}{reservation.deliveryDistanceKm ? ` · ${reservation.deliveryDistanceKm} km dari cabang` : ''}</small>}{!isDelivery && branch.phone && <small>Telepon cabang: {branch.phone}</small>}</div></div>{isDelivery && reservation.deliveryNotes && <p className="detail-note">Catatan delivery: {reservation.deliveryNotes}</p>}</div>{showCustomer && <div className="detail-section"><div className="detail-section-heading"><span className="section-label">CUSTOMER</span></div><div className="detail-contact"><div className="avatar">{customer.name?.slice(0, 1).toUpperCase() || '?'}</div><div><strong>{customer.name || '-'}</strong><p>{customer.email || '-'}</p><small>{customer.phone || 'Nomor telepon belum tersedia'}</small></div></div></div>}<div className="detail-section"><div className="detail-section-heading"><span className="section-label">RINCIAN PEMBAYARAN</span><strong className={paymentComplete ? 'green-text' : 'yellow-text'}>{paymentComplete ? 'Lunas' : 'Menunggu pembayaran'}</strong></div><div className="detail-pricing"><DetailPrice label={`Sewa kendaraan${rentalDays ? ` · ${rentalDays} hari` : ''}`} value={rentalAmount} /><DetailPrice label="Deposit" value={depositAmount} /><div className="detail-total"><span>Total reservasi</span><strong>{formatCurrency(reservation.totalAmount ?? rentalAmount + depositAmount)}</strong></div></div></div>{reservation.status === 'PENDING_PAYMENT' && reservation.expiresAt && <div className="detail-expiry">Selesaikan pembayaran sebelum <strong>{formatDateTime(reservation.expiresAt)}</strong>.</div>}<div className="detail-actions">{onPay && reservation.status === 'PENDING_PAYMENT' && <button type="button" className="primary-button" onClick={onPay}>Bayar simulasi</button>}<button type="button" className="secondary-button" onClick={onClose}>Tutup detail</button></div></aside></div>;
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

  return <DetailDrawerShell eyebrow="GPS AGREEMENT DETAIL" title="Detail MoU GPS" subtitle={`#${agreement.id}`} onClose={onClose}><div className="detail-company-hero"><div className="company-symbol">{agreement.companyName?.slice(0, 1) || 'R'}</div><div><h4>{agreement.companyName || 'Perusahaan belum tersedia'}</h4><p>{agreement.agreementNumber || 'Nomor agreement belum tersedia'}</p><StatusBadge value={agreement.status} label={humanAgreementStatus(agreement.status)} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">INFORMASI AGREEMENT</span><strong className={agreement.gpsTrackingAllowed ? 'green-text' : 'red-text'}>{agreement.gpsTrackingAllowed ? 'GPS diizinkan' : 'GPS tidak diizinkan'}</strong></div><div className="detail-grid"><DetailItem label="Status" value={humanAgreementStatus(agreement.status)} /><DetailItem label="Ditandatangani" value={formatDate(agreement.signedAt)} /><DetailItem label="Berlaku sampai" value={formatDate(agreement.expiresAt)} /><DetailItem label="Diperbarui" value={formatDateTime(agreement.updatedAt)} /><div className="detail-item detail-item-wide"><span>Dokumen</span><strong>{agreement.documentPath || 'Dokumen MoU belum dilampirkan'}</strong></div><div className="detail-item detail-item-wide"><span>Catatan</span><strong>{agreement.notes || 'Tidak ada catatan.'}</strong></div></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">PERUBAHAN STATUS</span></div><div className="agreement-control-box"><label className="field"><span>Status agreement</span><select value={nextStatus} onChange={(event) => setNextStatus(event.target.value)}>{Object.keys(agreementStatusLabels).map((status) => <option key={status} value={status}>{agreementStatusLabels[status]}</option>)}</select></label><label className="agreement-toggle"><input type="checkbox" checked={canTrack && gpsTrackingAllowed} disabled={!canTrack} onChange={(event) => setGpsTrackingAllowed(event.target.checked)} /> Izinkan GPS tracking untuk agreement aktif</label>{!canTrack && <small className="helper-text">GPS otomatis nonaktif selama status agreement belum Aktif.</small>}<button type="button" className="primary-button" onClick={save}>Simpan perubahan</button></div></div></DetailDrawerShell>;
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
  return <DetailDrawerShell eyebrow="RENTAL DETAIL" title="Detail rental berjalan" subtitle={`#${rental.id}`} onClose={onClose}><div className="detail-vehicle"><img src={vehicle.image} alt="" /><div><span className="vehicle-type">{vehicle.type === 'CAR' ? 'MOBIL' : 'MOTOR'}</span><h4>{vehicle.name || '-'}</h4><p>{company.name || '-'} · {branch.name || '-'}</p><StatusBadge value={rental.status} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">CUSTOMER</span></div><div className="detail-contact"><div className="avatar">{customer.name?.slice(0, 1).toUpperCase() || '?'}</div><div><strong>{customer.name || '-'}</strong><p>{customer.email || '-'}</p><small>{customer.phone || 'Nomor telepon belum tersedia'}</small></div></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">LINIMASA RENTAL</span></div><div className="detail-grid"><DetailItem label="Mulai rental" value={formatDate(rental.startDate)} /><DetailItem label="Selesai rental" value={formatDate(rental.endDate)} /><DetailItem label="Handover" value={formatDateTime(rental.handoverAt)} /><DetailItem label="Dikembalikan" value={formatDateTime(rental.returnedAt)} /><DetailItem label="Metode return" value={returnMethod} /><DetailItem label="Selesai pada" value={formatDateTime(rental.completedAt)} /></div></div><div className="detail-section"><div className="detail-section-heading"><span className="section-label">PEMBAYARAN & REFUND</span></div><div className="detail-pricing">{reservation.rentalAmount !== undefined && <DetailPrice label="Biaya sewa" value={reservation.rentalAmount} />}{reservation.depositAmount !== undefined && <DetailPrice label="Deposit" value={reservation.depositAmount} />}{reservation.totalAmount !== undefined && <div className="detail-total"><span>Total reservasi</span><strong>{formatCurrency(reservation.totalAmount)}</strong></div>}{rental.fine && <DetailPrice label="Denda" value={rental.fine.amount} />}{rental.refund && <DetailPrice label="Refund" value={rental.refund.amount} />}</div>{rental.fine?.damageItems?.length > 0 && <p className="detail-note">Item kerusakan: {rental.fine.damageItems.join(', ')}</p>}</div>{rental.latestLocation && <div className="detail-section"><div className="detail-section-heading"><span className="section-label">LOKASI TERAKHIR</span><strong className="green-text">Live telemetry</strong></div><div className="detail-location"><span className="detail-location-icon">⌁</span><div><strong>{rental.latestLocation.latitude.toFixed(4)}, {rental.latestLocation.longitude.toFixed(4)}</strong><p>Kecepatan {rental.latestLocation.speed || 0} km/jam</p><small>Update {formatDateTime(rental.latestLocation.recordedAt)}</small></div></div></div>}</DetailDrawerShell>;
}

function DetailItem({ label, value }) { return <div className="detail-item"><span>{label}</span><strong>{value || '-'}</strong></div>; }
function DetailPrice({ label, value }) { return <div className="detail-price"><span>{label}</span><strong>{formatCurrency(value)}</strong></div>; }
function DetailDocument({ label, value, file }) { return <div className="detail-document"><span className="detail-document-icon">▤</span><div><strong>{label}</strong><p>{value || 'Nomor belum tersedia'}</p><small>{file || 'Dokumen belum tersedia'}</small></div></div>; }

function ReservationRow({ reservation, action, onDetail }) {
  const openDetail = () => onDetail?.(reservation);
  const handleClick = (event) => { if (!event.target.closest('button')) openDetail(); };
  return <div className={`data-row reservation-row ${onDetail ? 'is-clickable' : ''}`} onClick={handleClick} onKeyDown={(event) => { if (hasInteractiveTarget(event)) return; if ((event.key === 'Enter' || event.key === ' ') && onDetail) { event.preventDefault(); openDetail(); } }} role={onDetail ? 'button' : undefined} tabIndex={onDetail ? 0 : undefined}><div className="row-main"><div className="vehicle-avatar"><img src={reservation.vehicle?.image} alt="" /></div><div><strong>{reservation.vehicle?.name}</strong><span>{reservation.company?.name || reservation.vehicle?.company?.name} · {reservation.branch?.name || reservation.vehicle?.branch?.name}</span><small>{formatDate(reservation.startDate)}—{formatDate(reservation.endDate)} · {reservation.pickupMode === 'DELIVERY' ? 'Delivery' : 'Pickup cabang'}</small></div></div><div className="row-side"><strong>{formatCurrency(reservation.totalAmount)}</strong><StatusBadge value={reservation.status} />{onDetail && <button type="button" className="small-button detail-button" onClick={openDetail}>Lihat detail</button>}{action}</div></div>;
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
