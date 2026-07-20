// Totem's Supabase connection details.
window.TOTEM_CONFIG = {
  SUPABASE_URL: "https://tiieaubyrjcsgiaegikb.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_8negZhlDSfCU9pxz-cfl6g_CD1XP0Mp",

  // Leave this blank until you're ready to actually go public. Once set,
  // every org's free-plan usage clock (days since signup) starts counting
  // from this date instead of their real signup date — so testing/beta
  // accounts created before launch never get unfairly penalized.
  // Format: "YYYY-MM-DD", e.g. "2026-09-01"
  LAUNCH_DATE: "2026-09-15",

  // Shown as a "report this" link when someone hits the duplicate-club-name
  // warning at signup, so a real school wrongly blocked by someone else's
  // mistake has an obvious way to reach you instead of being stuck.
  SUPPORT_EMAIL: "dandanblom@gmail.com"
};
