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

**Removing staff:** run `migration-staff-management.sql` once (SQL Editor → New query → Run) to enable this — it lets an owner see and remove people from **Club settings → Staff**. This only revokes their access to your club's data; it doesn't delete their login entirely (that still needs Authentication → Users → delete, if you want the email address freed up for reuse elsewhere). Built-in safeguards: you can't remove yourself, and a club can't be left with zero owners.

## Part 7 — POPIA groundwork (South African data protection law)

**This is technical scaffolding, not legal compliance on its own — read the caveat below before treating this as "done."**

Because players (and their parents/guardians) never log into Totem themselves, consent has to be gathered by each Organization through their own enrollment process, outside the software. What's built here supports that:

1. Run `migration-popia-consent.sql` once — adds a consent attestation record to each organization.
2. **New signups** ("Create a new club") now require checking a box confirming the club has, or will put in place, a parental/guardian consent process — timestamped automatically.
3. **`privacy.html`** — a draft Privacy Policy, linked from the signup screen. It has several `[bracketed placeholders]` that need real answers (your registered entity name, data retention period, contact email, Information Officer details, confirmed Supabase hosting region) — **do not publish this as final without a lawyer reviewing it,** it says so at the top of the page itself.
4. **`parental-consent-form-template.docx`** — a ready-to-use, printable consent form a club can hand out at enrollment/tryouts and keep on file themselves (Totem doesn't store signed copies — that's intentionally outside the software, since it's paper the club administers). Also linked from the signup screen.
5. **Club Settings → Data & privacy** — shows the attestation status/date, and lets a club re-confirm at any time.

**Before September 15, get a real South African lawyer or POPIA consultant to review this properly** — specifically: whether the consent language is legally sufficient, whether your club's situation might qualify for a different Section 35 exception instead of consent, whether your Supabase hosting region (currently the EU) needs specific cross-border-transfer handling for children's data, and Information Officer registration. This groundwork makes that conversation easier to have, it doesn't replace it.

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

**Duplicate club detection:** run `migration-duplicate-check.sql` once. When someone types a club name during "Create a new club" that exactly matches (case/whitespace-insensitive) an existing club, they get a clear warning suggesting they use "Join an existing club" instead, and must type a short explanation before they can proceed anyway (e.g., a genuinely different, unrelated club that happens to share a name). That explanation is saved on the new organization's `duplicate_justification` column — worth glancing at occasionally in Table Editor to catch anything that slipped through. This deliberately only catches close/exact name matches, not loosely similar ones (e.g. "Kingsmead" vs "Kingsmead School" would **not** trigger it) — to avoid annoying genuinely new clubs with false positives.

**Fixing a wrongly-named or bogus club, plus join confirmation:** run `migration-platform-admin.sql` once. This adds three things:
1. **"Join an existing club" now shows the real club name and asks you to confirm** before finalizing — so a wrong or leaked invite code can't silently put someone in the wrong organization.
2. **A "contact us" link** on the duplicate-name warning — set `SUPPORT_EMAIL` in `config.js` to a real address you'll actually check (it currently defaults to your own email, worth pointing it somewhere more permanent/monitored before launch).
3. **A new "Platform Admin" capability** — one tier above club owner, for you specifically, letting you see, rename, or permanently delete *any* organization (not just one you belong to). This is exactly the tool for fixing a wrongly-registered club name. **After running the migration, grant yourself access** by running (with your real email):
   ```sql
   insert into public.platform_admins (id, email)
   select id, email from auth.users where email = 'your-real-email@example.com'
   on conflict (id) do nothing;
   ```
   Log out and back in, and a **"Platform Admin"** button appears in the header. Deleting a club there removes all its data permanently (players, fixtures, results) but does **not** delete any staff logins — only their access to that specific club.

**Inactive account cleanup:** run `migration-inactive-accounts.sql`, then deploy a new Edge Function — this is a bigger setup step than most, since it introduces something genuinely new: a job that runs on a schedule, not triggered by anyone clicking anything.

1. Deploy the function: `supabase functions deploy check-inactive-accounts --no-verify-jwt`
2. Set a secret it uses to authenticate itself: `supabase secrets set CRON_SECRET=<make up a long random string>` (it reuses your existing `RESEND_API_KEY`/`RESEND_FROM_ADDRESS`, no need to set those again)
3. In the migration file, replace `YOUR-PROJECT-REF` and `YOUR_CRON_SECRET` with your real values before running the scheduling part at the bottom

**How it behaves:** a club inactive for 365 days (no player/fixture/result changes by any staff member) gets a warning email to its owner(s). If there's still no activity 30 days after that, the club is flagged — a second, final-notice email goes out, and the club shows up clearly highlighted at the top of **Platform Admin**, along with its actual last-activity date. **Deletion is never automatic** — a flagged club just sits there waiting for you to review and decide, using the same Delete button as fixing a wrongly-named club. Any real activity at any point clears a warning automatically, no confirmation link or action needed beyond just using the app normally.

## Header account menu

The header buttons (Invite staff, Club settings, Platform Admin, Log out) are now tucked behind a single **"[email] ▾"** button instead of sitting in a row — mainly to stop them crowding on mobile. No migration needed, pure code change.

## Club/school emblem on printed sheets

Run `migration-club-emblem.sql` once — this creates a new Supabase Storage bucket (`emblems`) alongside the usual database changes, so it's worth a quick look afterwards: **Storage** in the left sidebar should show an `emblems` bucket.

**How it works:** a club owner uploads their emblem from **Club settings → Club/school emblem** (PNG or JPG, up to 2MB). It's stored per-club, publicly readable (needed so it can load in a printed sheet without requiring login), but only that club's owner can upload or replace it — enforced the same way as everything else, via Row Level Security, just applied to file storage this time instead of database rows. Once uploaded, it automatically appears next to the Totem logo at the top of every printed team sheet, result, and season summary for that club — no further setup needed per print.

## Practice sessions & attendance-driven reliability

No migration needed — this lives entirely in the same JSON blob everything else already uses.

**Booking a practice:** "+ Add practice" next to the calendar — date, optional time, optional venue, and which age group(s) are attending. Unlike fixtures, practices aren't per-side — they're for a whole age group at once.

**Taking attendance:** each practice session has a "Take attendance" button (also reachable by clicking its chip directly on the calendar) — a simple checklist of every eligible player, check who showed up, save.

**How it affects ratings:** once a player has at least one *past* practice logged for their age group, their **Reliability** rating on the roster stops being a manual slider and becomes automatically calculated from real attendance — linear, 100% attendance = 10, 10% attendance = 1 (i.e. rating = attendance % ÷ 10). The ratings panel shows this clearly, with the actual attendance percentage next to it, rather than silently overriding what a coach typed in. Only *past* sessions count — a practice that hasn't happened yet never drags anyone's rating down, and a player with zero practice history yet keeps their existing manual rating until real data exists.

**One honest limitation worth knowing:** this doesn't currently account for when a player joined the roster — someone added partway through a season will show as having "missed" every practice before they existed. Fine for most cases, but worth being aware of for a player who joined recently and appears to have unfairly low reliability at first.
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
