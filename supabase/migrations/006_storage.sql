-- Private bucket untuk dokumen identitas, foto inspeksi, dan tanda tangan.
-- Backend mengunggah file memakai SUPABASE_SERVICE_ROLE_KEY; file tidak dibuat
-- public agar dokumen customer tidak dapat diakses tanpa kontrol backend.

insert into storage.buckets (id, name, public)
values ('transrent-files', 'transrent-files', false)
on conflict (id) do update set public = false;

