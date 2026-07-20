-- ============================================================
-- Totem — platform admin tools + join confirmation
-- Run this once in Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- ---------- fix: deleting an organization should clean up after itself ----------
-- org_state already cascades correctly. team_members didn't, which would have
-- blocked deleting a wrongly-created org until this is fixed.
do $$
declare
  fkname text;
begin
  select con.conname into fkname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_attribute att on att.attrelid = rel.oid and att.attnum = any(con.conkey)
  where rel.relname = 'team_members' and att.attname = 'org_id' and con.contype = 'f';

  if fkname is not null then
    execute format('alter table public.team_members drop constraint %I', fkname);
  end if;
end $$;

alter table public.team_members
  add constraint team_members_org_id_fkey foreign key (org_id) references public.organizations(id) on delete cascade;

-- ---------- platform_admins: a short allowlist of who can manage ANY club ----------
-- This is a different, higher tier than "owner" — an owner only manages their
-- own club; a platform admin (you) can see/rename/remove any organization,
-- specifically for fixing a wrongly-named or bogus signup.
create table if not exists public.platform_admins (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  added_at timestamptz default now()
);
alter table public.platform_admins enable row level security;

drop policy if exists "platform_admins_self_read" on public.platform_admins;
create policy "platform_admins_self_read" on public.platform_admins
  for select using (auth.uid() = id);

create or replace function public.is_platform_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_admins where id = auth.uid());
$$;

drop policy if exists "organizations_admin_read_all" on public.organizations;
create policy "organizations_admin_read_all" on public.organizations
  for select using (public.is_platform_admin());

drop policy if exists "organizations_admin_update" on public.organizations;
create policy "organizations_admin_update" on public.organizations
  for update using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists "organizations_admin_delete" on public.organizations;
create policy "organizations_admin_delete" on public.organizations
  for delete using (public.is_platform_admin());

-- ---------- let someone preview a club's name before joining it ----------
-- Same reasoning as check_org_name_similar: this runs before the person has
-- an account, so normal permissions don't apply yet. Deliberately narrow —
-- only ever returns the name for a matching invite code, nothing else.
create or replace function public.get_org_name_for_invite_code(code text)
returns text
language sql
security definer
set search_path = public
as $$
  select name from public.organizations where invite_code = code;
$$;

grant execute on function public.get_org_name_for_invite_code(text) to anon, authenticated;

-- ============================================================
-- IMPORTANT — one manual step: grant yourself platform admin access.
-- Replace with your real email, then run:
--
--   insert into public.platform_admins (id, email)
--   select id, email from auth.users where email = 'your-real-email@example.com'
--   on conflict (id) do nothing;
--
-- Once run, log out and back in — a new "Platform Admin" button will
-- appear in the header, letting you see, rename, or remove any club.
-- ============================================================
