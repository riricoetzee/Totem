// Supabase Edge Function: send-result-email
//
// Called from the app right after a fixture result is saved. Looks up every
// staff email from team_members, adds the relevant coach's email if one is
// set, and sends a result summary via Resend.
//
// Deploy with:
//   supabase functions deploy send-result-email
//
// Required secrets (set once with `supabase secrets set KEY=value`):
//   RESEND_API_KEY       — from resend.com (free tier is enough for a club)
//   RESEND_FROM_ADDRESS  — e.g. "Totem <results@yourclub.com>" (must be a
//                           domain you've verified in Resend, or use their
//                           shared onboarding@resend.dev sender for testing)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — already set automatically by
//                           Supabase for every Edge Function, no action needed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatDateLabel(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function buildEmailHtml(payload: any): string {
  const dateLabel = formatDateLabel(payload.date);
  const heading = `${payload.sportName} — ${payload.ageGroupLabel}`;
  const sub = `vs ${payload.opponent}${dateLabel ? " · " + dateLabel : ""}${payload.venue ? " · " + payload.venue : ""}`;

  let body = "";
  if (payload.entries && payload.entries.length) {
    // individual sport: list of athlete/event/time/place
    const rows = payload.entries
      .map((en: any) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${en.name}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${en.event}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${en.time}${en.place ? " · " + en.place + getOrdinalSuffix(en.place) : ""}</td></tr>`)
      .join("");
    body = `<table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>`;
  } else {
    // team sport: score + outcome + scorers
    const outcomeColor = payload.outcome === "WON" ? "#1F5C43" : payload.outcome === "LOST" ? "#C1542E" : "#B9840F";
    body = `
      <p style="font-size:20px;font-weight:700;margin:0 0 6px;">
        <span style="color:${outcomeColor};">${payload.outcome}</span>
        &nbsp;${payload.scoreLine}
      </p>
      ${payload.scorers && payload.scorers.length ? `<p style="font-size:14px;color:#5B6B63;margin:0;"><strong>Scorers:</strong> ${payload.scorers.join(", ")}</p>` : ""}
    `;
  }

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#14201A;max-width:520px;">
      <h2 style="margin:0 0 2px;">${heading}</h2>
      <p style="color:#5B6B63;font-size:13px;margin:0 0 18px;">${sub}</p>
      ${body}
      <p style="color:#999;font-size:11px;margin-top:28px;">Sent automatically by Totem™.</p>
    </div>
  `;
}

function getOrdinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload = await req.json();

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Gather recipients: every staff member's email + the specific coach's
    // email if one was captured for this age group (deduplicated).
    const { data: members, error: membersError } = await supabaseAdmin
      .from("team_members")
      .select("email");
    if (membersError) throw membersError;

    const recipients = new Set<string>();
    (members || []).forEach((m: any) => { if (m.email) recipients.add(m.email); });
    if (payload.coachEmail) recipients.add(payload.coachEmail);

    if (recipients.size === 0) {
      return new Response(JSON.stringify({ warning: "No recipients found — is team_members populated?" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const fromAddress = Deno.env.get("RESEND_FROM_ADDRESS") || "Totem <onboarding@resend.dev>";
    if (!resendApiKey) throw new Error("RESEND_API_KEY secret is not set.");

    const html = buildEmailHtml(payload);
    const subject = `${payload.sportName} ${payload.ageGroupLabel} vs ${payload.opponent}${payload.scoreLine ? " — " + payload.scoreLine : ""}`;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [...recipients],
        subject,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      throw new Error(`Resend API error: ${resendRes.status} ${errText}`);
    }

    return new Response(JSON.stringify({ sent: true, recipients: [...recipients] }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
