-- ============================================================
-- Totem — inactive account detection & warning emails
-- Run this once in Supabase SQL Editor.
--
-- Activity = any real save by any staff member (already tracked via
-- org_state.updated_at — no new tracking needed for that part).
--
-- Flow: 365 days inactive → warning email to owner(s). 30 more days with
-- still no activity → flagged for removal + final-notice email. Actual
-- deletion is NEVER automatic — a flagged club just shows up clearly in
-- Platform Admin for you to review and delete yourself, same tool as
-- fixing a wrongly-named club.
-- ============================================================

alter table public.organizations add column if not exists inactivity_warning_sent_at timestamptz;
alter table public.organizations add column if not exists flagged_for_removal boolean not null default false;

-- Let platform admins see last-activity dates for every club (needed for
-- the Platform Admin panel to show this — same admin-only access pattern
-- already used for organizations itself).
drop policy if exists "org_state_admin_read_all" on public.org_state;
create policy "org_state_admin_read_all" on public.org_state
  for select using (public.is_platform_admin());

-- ============================================================
-- The actual checking runs in a scheduled Edge Function (see
-- supabase/functions/check-inactive-accounts/index.ts) — deploy it with:
--
--   supabase functions deploy check-inactive-accounts --no-verify-jwt
--   supabase secrets set CRON_SECRET=<make up a long random string>
--
-- (It already has access to RESEND_API_KEY / RESEND_FROM_ADDRESS from
-- when you set up result-notification emails — no need to set those again.)
--
-- Then schedule it to actually run daily. This needs two Postgres
-- extensions enabled once, then a cron job pointing at your deployed
-- function — replace YOUR-PROJECT-REF and YOUR_CRON_SECRET below with
-- your real values before running this part.
-- ============================================================

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'check-inactive-accounts-daily',
  '0 3 * * *', -- 3am UTC, every day
  $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/check-inactive-accounts',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'YOUR_CRON_SECRET'),
    body := '{}'::jsonb
  );
  $$
);

-- To check it's scheduled: select * from cron.job;
-- To remove it later if needed: select cron.unschedule('check-inactive-accounts-daily');
