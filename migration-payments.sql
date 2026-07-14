-- ============================================================
-- Totem — payment groundwork
-- Run this once in Supabase SQL Editor. Safe to re-run.
--
-- This does NOT turn on billing — it just adds the columns the
-- Stripe webhook will update once you actually have a Stripe
-- account connected. Until then, every organization stays on
-- plan = 'free' exactly as it already is.
-- ============================================================

alter table public.organizations add column if not exists stripe_customer_id text;
alter table public.organizations add column if not exists stripe_subscription_id text;
alter table public.organizations add column if not exists plan_status text not null default 'active';
-- plan_status values: 'active' (free or paid, in good standing), 'past_due'
-- (payment failed, Stripe is retrying), 'canceled' (subscription ended —
-- app should treat this the same as 'free' until they resubscribe).

create index if not exists organizations_stripe_customer_idx on public.organizations(stripe_customer_id);
