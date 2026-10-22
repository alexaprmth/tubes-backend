import { useEffect, useRef, useState } from 'react';
import { api, downloadFile, addDaysString } from './api.js';

export default function OnlineMouModal({ agreement, actor, onClose, onCompleted }) {
  const [terms, setTerms] = useState(null);
  const [consents, setConsents] = useState({});
  const [meterai, setMeterai] = useState(false);
  const [expiresAt, setExpiresAt] = useState(addDaysString(365));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    let alive = true;
    api('/mou/online-terms').then((result) => { if (alive) setTerms(result); }).catch((err) => { if (alive) setError(err.message); });
    return () => { alive = false; previous?.focus(); };
  }, []);
  const ready = terms && terms.schemaReady && terms.checks.every(({ id }) => consents[id] === true) && meterai && expiresAt;
  const keydown = (event) => {
    if (event.key === 'Escape' && !busy) onClose();
    if (event.key !== 'Tab') return;
    const items = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
    if (!items.length) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === dialog.current)) { event.preventDefault(); items.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
  };
  const submit = async (event) => {
    event.preventDefault(); if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      await api(`/rental/gps-agreements/${agreement.id}/online-simulation`, { method: 'POST', body: JSON.stringify({ termsVersion: terms.version, termsHash: terms.termsHash, consents, includeSimulatedMeterai: meterai, expiresAt }) });
    } catch (err) { setError(err.message); setBusy(false); return; }
    // The receipt is already saved; a failed download must not resubmit consent.
    let downloadError = '';
    try { await downloadFile(`/gps-agreements/${agreement.id}/online-simulation/document`, 'mou-online-draf.pdf'); }
    catch (err) { downloadError = err.message; }
    await onCompleted(downloadError);
  };
  return <div className="modal-backdrop"><section className="modal-card online-mou-modal" role="dialog" aria-modal="true" aria-labelledby="online-mou-title" tabIndex={-1} ref={dialog} onKeyDown={keydown}>
    <div className="drawer-header"><div><h2 id="online-mou-title">Draf MoU online</h2><p>{agreement.agreementNumber} · {agreement.companyName}</p></div><button type="button" className="icon-button" aria-label="Tutup popup" disabled={busy} onClick={onClose}>×</button></div>
    <div className="notice danger">Draf ini menunggu tanda tangan kedua pihak dan meterai resmi. Persetujuan akun tersimpan; aplikasi belum membubuhkan TTD atau e-Meterai resmi.</div>
    <p>Pengelola: TransRent. Pemilik rental: <strong>{actor.name}</strong>. Surat dibuat otomatis dari data perusahaan dan persetujuan akun ini.</p>
    {error && <div className="notice danger" role="alert">{error}</div>}
    {terms?.schemaReady === false && <div className="notice danger" role="alert">Database belum siap: {terms.schemaMessage} Jalankan bundle SQL, kemudian tutup dan buka kembali popup.</div>}
    {!terms ? <p aria-live="polite">{error ? 'Tutup dan buka kembali untuk memuat ketentuan.' : 'Memuat ketentuan...'}</p> : <form onSubmit={submit} className="stack-form">
      <div className="online-mou-terms" tabIndex={0} aria-label="Seluruh syarat dan ketentuan">{terms.clauses.map((clause, index) => <section key={clause.title}><h3>{index + 1}. {clause.title}</h3><p>{clause.text}</p></section>)}<small>Versi: {terms.version}</small></div>
      {terms.checks.map(({ id, label }) => <label className="online-mou-check" key={id}><input type="checkbox" required checked={consents[id] === true} disabled={busy} onChange={(event) => setConsents((values) => ({ ...values, [id]: event.target.checked }))} /><span>{label}</span></label>)}
      <label className="online-mou-check"><input type="checkbox" required checked={meterai} disabled={busy} onChange={(event) => setMeterai(event.target.checked)} /><span>Sediakan ruang meterai Rp10.000 pada draf (belum membeli atau membubuhkan meterai resmi).</span></label>
      <label className="field"><span>Berlaku sampai</span><input type="date" required value={expiresAt} disabled={busy} onChange={(event) => setExpiresAt(event.target.value)} /></label>
      <small>Centang keempat persetujuan dan pilihan ruang meterai, lalu isi tanggal berakhir untuk mengaktifkan tombol.</small>
      <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Batal</button><button className="primary-button" disabled={!ready || busy}>{busy ? 'Membuat surat...' : 'Setuju dan buat PDF draf'}</button></div>
    </form>}
  </section></div>;
}
