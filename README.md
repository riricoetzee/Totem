# Totem™ — Deployment Guide

**Stack:** Supabase (database + login + email) + GitHub Pages (free static hosting).

No server to manage, no build step. Updating the app is just editing files and pushing to GitHub.

---

## Part 1 — Set up Supabase (database + login)

1. Go to [supabase.com](https://supabase.com), sign up, and create a **New project**.
   - Pick any name (e.g. `totem-club`), a strong database password (save it), and a region close to you.
2. Once ready, open **SQL Editor** (left sidebar) → **New query**.
3. Paste in the entire contents of `schema.sql` (included in this package) and click **Run**. This creates the `team_members` and `club_state` tables and locks them down so only logged-in staff can touch them.
4. Go to **Authentication → Providers → Email**, and turn **OFF** "Allow new users to sign up." Only you should be able to create staff accounts.
5. Go to **Authentication → Users → Add user**, and create one login per staff member (email + password) — up to 8. You can change passwords later from the same screen.
6. Back in **SQL Editor**, run this (with your real staff emails) to grant them access to the club's data:
   ```sql
   insert into public.team_members (id, email)
   select id, email from auth.users
   where email in (
     'coach1@yourclub.com',
     'coach2@yourclub.com'
     -- add all your staff emails here
   )
   on conflict (id) do nothing;
   ```
   Without this step, a staff member can log in but will see an empty app — this is what actually grants access to the shared data.
7. Go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key — you'll need both next.

---

## Part 1.5 — Multi-tenant migration (multiple clubs, self-service signup)

Skip this section if you're only ever running Totem for a single club. Run it if you want Totem to support multiple separate clubs/schools/teams signing up on their own, each fully isolated from the others — the groundwork for eventually charging for it.

1. **SQL Editor → New query.** Paste in the entire contents of `migration-multitenant.sql` and run it.
   - This is safe to run even if you already have real data — it automatically moves your existing club's data into its own organization and keeps your current staff logins working, no re-entry needed.
   - It adds a `plan` field (defaulting to `'free'`) to every organization, so nothing needs to change in the database again once you're ready to introduce paid tiers.
2. **Authentication → Providers → Email → turn "Allow new users to sign up" back ON.**
   - This was deliberately off in Part 1 for the single-club model. It's safe to turn back on now — every new signup creates (or joins) their own isolated organization, so a stranger signing up only ever gets their own empty club, never access to yours.
3. **Authentication → Settings → turn ON "Confirm email."** Recommended now that signup is public, so people can't create an account with an email address that isn't theirs.

**How signup works now, from a user's point of view:**
- **"Create a new club"** — they type their club/school/team's name, pick an email + password, and get their own private Totem instance immediately, as the club's owner.
- **"Join an existing club"** — they need an 8-character invite code from that club's owner. The owner finds this by clicking **Invite staff** in the app header (top right, only visible to the owner) once logged in.

**Renaming a club:** the owner can also click **Rename club** in that same header spot to change their club's name any time — useful right after the migration above, since auto-migrated clubs get a generic placeholder name ("My Club") that you'll want to change to your real club name. This needs one more small migration first:

1. **SQL Editor → New query**, paste in `migration-club-settings.sql`, run it. This grants club owners permission to update their own organization's name (locked down to owners only, and only their own club).
2. That's it — the Rename Club button will work from then on, no more manual SQL needed for this.



1. Open `config.js` in this package.
2. Replace the two placeholder values with what you copied in step 7 above:
   ```js
   window.TOTEM_CONFIG = {
     SUPABASE_URL: "https://xxxxxxxx.supabase.co",
     SUPABASE_ANON_KEY: "eyJhbGciOi..."
   };
   ```
3. Save the file. That's the only code edit required for the app itself.

*(The anon key is meant to be public/visible in frontend code — it can't read or write anything by itself because of the security policies in `schema.sql`. Only a logged-in, team_members-listed account can.)*

---

## Part 3 — Set up real result-notification emails

This is the one part with a few more steps, because sending email needs to happen from a server, not the browser.

1. Sign up at [resend.com](https://resend.com) (free tier covers a club easily) and grab an **API key** (Dashboard → API Keys).
   - For quick testing, you can send from Resend's shared address (`onboarding@resend.dev`) without any extra setup.
   - For a proper "from your club" sender, verify your own domain in Resend first (Domains → Add Domain, follow their DNS steps), then use an address on that domain.
2. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) if you don't have it, then from this project folder:
   ```bash
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF
   supabase secrets set RESEND_API_KEY=re_your_key_here
   supabase secrets set RESEND_FROM_ADDRESS="Totem <onboarding@resend.dev>"
   supabase functions deploy send-result-email
   ```
   (Your project ref is the part of your Supabase URL before `.supabase.co`.)
3. That's it — the app already calls this function automatically every time a fixture result is captured.

**Test it:** capture a result for any fixture in the app and check the recipient inboxes (coach's email + every staff email in `team_members`). If it doesn't arrive, check **Supabase Dashboard → Edge Functions → send-result-email → Logs** for the error.

---

## Part 4 — Put the code on GitHub and turn on GitHub Pages

1. Create a free GitHub account if you don't have one, then create a **new repository** — e.g. `totem-app`.
2. Upload all files from this package into the repository (`index.html`, `styles.css`, `app.js`, `config.js` with your real keys, `schema.sql`, and the `supabase/` folder). Easiest way: on the repo page, click **Add file → Upload files**, drag them in, and commit.
   - The `supabase/functions/` folder is only needed for the `supabase functions deploy` step in Part 3 — it doesn't need to be uploaded to GitHub for the site itself to work, but there's no harm keeping it in the repo for reference.
3. Go to the repo's **Settings → Pages**.
   - Under "Build and deployment," set **Source** to `Deploy from a branch`, branch `main`, folder `/ (root)`. Save.
   - GitHub will publish the site at `https://<your-username>.github.io/totem-app/` within a minute or two.
4. If you have your own domain, add it under **Custom domain** on that same Pages settings screen, and point your domain's DNS at GitHub Pages (A records to GitHub's IPs, or a CNAME if using a subdomain) — see [GitHub's custom domain docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site) for the exact records.

---

## Part 5 — Test before you rely on it

1. Visit your `github.io` URL (or custom domain).
2. Log in with one of the staff accounts from Part 1.
3. Add a test sport/player, capture a fixture result, confirm the email arrives.
4. Log in as a different staff member (or an incognito window) and confirm they see the same data — it's shared across the team.
5. Once you're happy, that's your real URL — share it with staff.

---

## Ongoing maintenance

- **Adding/removing staff:** Supabase Dashboard → Authentication → Users to add/remove the login, then re-run the `insert into team_members` snippet from Part 1 step 6 for new staff (or `delete from team_members where email = '...'` to revoke someone without deleting their login).
- **Updating the app:** edit files in GitHub (or push from your computer) — GitHub Pages redeploys automatically within a minute.
- **Backups:** Supabase takes automatic daily backups on the free tier. For extra peace of mind, you can export the single `club_state` row's `data` column from the Table Editor any time — it's your entire season's data in one JSON value.
- **Costs:** Supabase, GitHub Pages, and Resend's free tiers comfortably cover 8 users and a club's worth of data/email.

---

## Part 6 — Payments groundwork (not live yet — for when you're ready)

This is already built into the app, but **dormant** until you create a real Stripe account — nothing charges anyone until you complete the steps below.

**What's already working right now, with zero Stripe account needed:**
- Every organization has a `plan` (defaults `'free'`), `plan_status`, and Stripe ID columns — run `migration-payments.sql` once to add these.
- Every organization also has an `org_type` (`'club'` or `'school'`) — run `migration-org-type.sql` once to add this. Captured at signup, editable later via **Club settings**.
- **The conversion trigger is a single, clean metric: results captured** — once a free-plan org passes **270 days since signup (~9 months) OR their type's results threshold** (100 for a school, 20 for a club/single team — whichever comes first), a banner appears prompting them to upgrade. Results is the meaningful signal — it means real season-long usage, not just an account existing — time is the backstop for accounts that barely use it yet never leave either. There's deliberately **no limit on sports or players** — setup work (adding sports, rosters, scheduling fixtures) costs nothing toward the limit, only actual captured match results count, and results scale with program size regardless of how many sports a club runs (they're counted per team per fixture, so a big single-sport school still hits the threshold from game volume alone). This keeps free-tier onboarding completely unrestricted — a school can set up their entire multi-sport program on day one — while still converting genuinely active clubs fairly.
- This is currently a **visible banner, not a hard block** — since there's no live payment link yet, actually locking someone out before they can pay would be counterproductive. Once Stripe is wired up, this is the natural point to make it a hard block instead (see `renderUsageBanner()` in `app.js`).
- **Important:** this clock starts the moment an organization is created — including any testing/beta accounts made before a real public launch. `LAUNCH_DATE` in `config.js` is already set — every org's clock starts counting from that date instead of their real signup date, so nothing done during testing counts against anyone.
- Org type (school vs. club/single team) is set at signup and editable any time via **Club settings** in the header.
- `supabase/functions/stripe-webhook/index.ts` is fully written and ready to deploy — it listens for Stripe subscription events and keeps `organizations.plan` in sync automatically. It just has nothing to listen to yet.

**What only you can do, once you're ready to actually charge money:**
1. Create a Stripe account (stripe.com) — this needs your real business/bank details, same as any payment processor.
2. In Stripe, create a Product + Price for your paid plan.
3. Set up a Checkout flow (or the simpler no-code **Payment Link**, quick to test with) — either way, the `client_reference_id` needs to be set to the organization's id, so Stripe can tell this function which club just paid. Full instructions are in the comments at the top of `stripe-webhook/index.ts`.
4. Deploy the webhook function and set its two secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) — same `supabase functions deploy` / `supabase secrets set` pattern you already know from setting up email.
5. Swap the placeholder `showUpgradePrompt()` alert in the app for a real link to your Stripe Checkout/Payment Link.

**Worth deciding before you flip this on:** 270 days / 100 / 20 are starting recommendations, not fixed — easy to adjust via `FREE_PLAN_MAX_DAYS` and `FREE_PLAN_MAX_RESULTS_BY_TYPE` in `app.js` once you've seen real signup behavior.

## If something doesn't work

- **Login screen shows but login fails:** double check the email/password in Supabase → Authentication → Users, and that `config.js` has the correct URL/key (no extra quotes or spaces).
- **Logged in but the app looks empty / nothing saves:** the account isn't in `team_members` yet — re-run the insert snippet from Part 1 step 6 with that person's email.
- **Blank page / console errors:** open browser dev tools (F12) → Console tab, most commonly a typo in `config.js`.
- **Result emails don't arrive:** check Supabase Dashboard → Edge Functions → `send-result-email` → Logs for the actual error (missing secret, bad Resend key, or an unverified sending domain are the usual culprits).
