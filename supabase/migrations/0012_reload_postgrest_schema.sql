-- Force Supabase PostgREST to see deterministic rate-engine tables/functions
-- immediately after manually applying DDL in the SQL editor.
notify pgrst, 'reload schema';
