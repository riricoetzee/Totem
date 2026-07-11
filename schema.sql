-- ============================================================
-- Totem — Supabase schema
-- Safe to re-run any time (every statement is idempotent).
-- Run in: Supabase Dashboard → SQL Editor → New query → paste → Run
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- team_members: the allowlist that grants access ----------
-- Every one of your (up to 8) staff accounts needs a row here, matched by
-- their auth.users id, or they'll be able to log in but see nothing.
create table if not exists public.team_members (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  added_at timestamptz default now()
);

-- ---------- club_state: the entire app's data, as one JSON row ----------
-- Totem keeps all its data (sports, players, fixtures, results, etc.) as a
-- single JSON blob, synced as one unit — simple, reliable, and easy to
-- back up (just export this one row) for a small shared team of 8 users.
create table if not exists public.club_state (
  id int primary key default 1,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  updated_by uuid references auth.users(id)
);

-- seed the single row if it doesn't exist yet
insert into public.club_state (id, data)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

create index if not exists team_members_id_idx on public.team_members(id);

-- ============================================================
-- Row Level Security — only signed-in accounts listed in team_members
-- can read or write the club's data. Nobody else, even if they somehow
-- get a valid login, can see anything without being added here too.
-- ============================================================
alter table public.team_members enable row level security;
alter table public.club_state enable row level security;

drop policy if exists "team_members_self_read" on public.team_members;
create policy "team_members_self_read" on public.team_members
  for select using (auth.uid() = id);

drop policy if exists "club_state_team_access" on public.club_state;
create policy "club_state_team_access" on public.club_state
  for all
  using (exists (select 1 from public.team_members tm where tm.id = auth.uid()))
  with check (exists (select 1 from public.team_members tm where tm.id = auth.uid()));

-- ============================================================
-- After creating each staff login in Authentication → Users, run this
-- (with their real emails) to grant them access to the club's data:
--
--   insert into public.team_members (id, email)
--   select id, email from auth.users
--   where email in (
--     'coach1@yourclub.com',
--     'coach2@yourclub.com',
--     'coach3@yourclub.com'
--     -- add up to 8 total
--   )
--   on conflict (id) do nothing;
--
-- Re-run any time you add a new staff member.
-- ============================================================
