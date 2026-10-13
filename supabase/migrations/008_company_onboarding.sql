-- Menjamin satu perusahaan hanya memiliki satu MoU GPS aktif.
-- Histori MoU lama tetap disimpan sebagai EXPIRED atau REVOKED.
create unique index if not exists rental_company_one_active_agreement_idx
  on public.rental_company_agreements(company_id)
  where status = 'ACTIVE';

alter table public.rental_company_agreements
  drop constraint if exists rental_company_agreements_valid_dates;

alter table public.rental_company_agreements
  add constraint rental_company_agreements_valid_dates
  check (expires_at is null or signed_at is null or expires_at > signed_at);
