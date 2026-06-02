-- Private upload bucket policies.
-- The app stores files under: uploads/{auth.uid()}/{uuid}-{filename}

insert into storage.buckets (id, name, public, file_size_limit)
values ('uploads', 'uploads', false, 104857600)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "users can upload own files" on storage.objects;
drop policy if exists "users can read own files" on storage.objects;
drop policy if exists "users can update own files" on storage.objects;
drop policy if exists "users can delete own files" on storage.objects;

create policy "users can upload own files"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'uploads'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "users can read own files"
on storage.objects for select
to authenticated
using (
  bucket_id = 'uploads'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "users can update own files"
on storage.objects for update
to authenticated
using (
  bucket_id = 'uploads'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'uploads'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "users can delete own files"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'uploads'
  and (storage.foldername(name))[1] = auth.uid()::text
);
