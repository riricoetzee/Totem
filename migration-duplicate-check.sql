-- ============================================================
-- Totem — duplicate club name detection at signup
-- Run this once in Supabase SQL Editor. Safe to re-run.
-- ============================================================

alter table public.organizations add column if not exists duplicate_justification text;
-- Filled in only when someone creates a club whose name closely matches an
-- existing one and chooses to proceed anyway — lets you spot-check for real
-- duplicates later (Table Editor → organizations) without adding friction
-- to genuinely new signups.

-- A person hasn't got an account yet at the exact moment they're choosing a
-- club name, so normal permissions (which require being a member of an org)
-- can't apply. This function is deliberately narrow: it runs with elevated
-- access internally, but only ever returns a plain yes/no — never any real
-- club data — so it's safe to expose to anyone, signed in or not.
create or replace function public.check_org_name_similar(check_name text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organizations
    where lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = lower(regexp_replace(trim(check_name), '\s+', ' ', 'g'))
  );
$$;

grant execute on function public.check_org_name_similar(text) to anon, authenticated;

-- Update the signup trigger to also store the justification, when given.
create or replace function public.handle_new_user()
returns trigger as $$
declare
  target_org_id uuid;
  meta_org_name text;
  meta_invite_code text;
  meta_org_type text;
  meta_consent text;
  meta_justification text;
begin
  meta_org_name := new.raw_user_meta_data->>'org_name';
  meta_invite_code := new.raw_user_meta_data->>'invite_code';
  meta_org_type := new.raw_user_meta_data->>'org_type';
  meta_consent := new.raw_user_meta_data->>'consent_attestation';
  meta_justification := new.raw_user_meta_data->>'duplicate_justification';

  if meta_invite_code is not null and meta_invite_code <> '' then
    select id into target_org_id from public.organizations where invite_code = meta_invite_code;
    if target_org_id is null then
      raise exception 'That club invite code was not recognized.';
    end if;
    insert into public.team_members (id, email, org_id, role) values (new.id, new.email, target_org_id, 'member');
  else
    insert into public.organizations (name, plan, org_type, consent_attestation_confirmed, consent_attestation_date, duplicate_justification)
    values (
      coalesce(nullif(meta_org_name, ''), 'My Club'),
      'free',
      coalesce(nullif(meta_org_type, ''), 'club'),
      coalesce(meta_consent, 'false')::boolean,
      case when coalesce(meta_consent, 'false')::boolean then now() else null end,
      nullif(meta_justification, '')
    )
    returning id into target_org_id;
    insert into public.team_members (id, email, org_id, role) values (new.id, new.email, target_org_id, 'owner');
    insert into public.org_state (org_id, data) values (target_org_id, '{}'::jsonb);
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
