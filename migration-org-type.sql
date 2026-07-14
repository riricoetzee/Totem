-- ============================================================
-- Totem — distinguish schools (multiple teams) from a single club/team
-- Run this once in Supabase SQL Editor. Safe to re-run.
-- ============================================================

alter table public.organizations add column if not exists org_type text not null default 'club';
-- org_type values: 'club' (a single team/club) or 'school' (multiple teams/sports).
-- Self-reported at signup, editable later via the app's Rename Club settings.

-- Update the signup trigger so new "create a new club" signups also store
-- the org_type the person picked (existing orgs are untouched — they stay
-- on the 'club' default until someone changes it via the app).
create or replace function public.handle_new_user()
returns trigger as $$
declare
  target_org_id uuid;
  meta_org_name text;
  meta_invite_code text;
  meta_org_type text;
begin
  meta_org_name := new.raw_user_meta_data->>'org_name';
  meta_invite_code := new.raw_user_meta_data->>'invite_code';
  meta_org_type := new.raw_user_meta_data->>'org_type';

  if meta_invite_code is not null and meta_invite_code <> '' then
    select id into target_org_id from public.organizations where invite_code = meta_invite_code;
    if target_org_id is null then
      raise exception 'That club invite code was not recognized.';
    end if;
    insert into public.team_members (id, email, org_id, role) values (new.id, new.email, target_org_id, 'member');
  else
    insert into public.organizations (name, plan, org_type)
    values (coalesce(nullif(meta_org_name, ''), 'My Club'), 'free', coalesce(nullif(meta_org_type, ''), 'club'))
    returning id into target_org_id;
    insert into public.team_members (id, email, org_id, role) values (new.id, new.email, target_org_id, 'owner');
    insert into public.org_state (org_id, data) values (target_org_id, '{}'::jsonb);
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
