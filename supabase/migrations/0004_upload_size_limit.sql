-- Allow rate documents up to 100MB in the private uploads bucket.
insert into storage.buckets (id, name, public, file_size_limit)
values ('uploads', 'uploads', false, 104857600)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;
