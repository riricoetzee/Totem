-- ============================================================
-- Totem — club emblem upload (appears next to the Totem logo on
-- printed sheets)
-- Run this once in Supabase SQL Editor. Safe to re-run.
-- ============================================================

alter table public.organizations add column if not exists emblem_url text;

-- Storage bucket for emblem images. Public read (so it can load in a
-- printed sheet without needing auth), but only a club's own owner can
-- upload/replace their emblem.
insert into storage.buckets (id, name, public, file_size_limit)
values ('emblems', 'emblems', true, 2097152) -- 2MB limit
on conflict (id) do nothing;

drop policy if exists "emblem_public_read" on storage.objects;
create policy "emblem_public_read" on storage.objects
  for select using (bucket_id = 'emblems');

-- Files are named "{org_id}.{extension}" — this checks the uploader is
-- the OWNER of the org whose id matches the filename they're uploading.
drop policy if exists "emblem_owner_upload" on storage.objects;
create policy "emblem_owner_upload" on storage.objects
  for insert
  with check (
    bucket_id = 'emblems'
    and exists (
      select 1 from public.team_members tm
      where tm.id = auth.uid() and tm.role = 'owner' and tm.org_id::text = split_part(name, '.', 1)
    )
  );

drop policy if exists "emblem_owner_update" on storage.objects;
create policy "emblem_owner_update" on storage.objects
  for update
  using (
    bucket_id = 'emblems'
    and exists (
      select 1 from public.team_members tm
      where tm.id = auth.uid() and tm.role = 'owner' and tm.org_id::text = split_part(name, '.', 1)
    )
  );

drop policy if exists "emblem_owner_delete" on storage.objects;
create policy "emblem_owner_delete" on storage.objects
  for delete
  using (
    bucket_id = 'emblems'
    and exists (
      select 1 from public.team_members tm
      where tm.id = auth.uid() and tm.role = 'owner' and tm.org_id::text = split_part(name, '.', 1)
    )
  );
