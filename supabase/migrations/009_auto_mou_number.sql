-- Nomor MoU dibuat otomatis oleh database agar aman dari benturan concurrent insert.
create sequence if not exists public.rental_company_agreement_number_seq;

alter table public.rental_company_agreements
  alter column agreement_number set default (
    'MOU-GPS-' || to_char(current_date, 'YYYY') || '-'
    || lpad(nextval('public.rental_company_agreement_number_seq')::text, 6, '0')
  );
