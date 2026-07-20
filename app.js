(function(){
  "use strict";

  // ---------- supabase client & auth ----------
  const supabaseClient = window.supabase.createClient(
    window.TOTEM_CONFIG.SUPABASE_URL,
    window.TOTEM_CONFIG.SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: true } } // require login every time the app is opened
  );
  let currentUser = null;
  let currentOrgId = null;
  let currentOrgName = null;
  let currentOrgPlan = "free";
  let currentOrgCreatedAt = null;
  let currentOrgType = "club";
  let currentOrgConsentConfirmed = false;
  let currentOrgConsentDate = null;
  let currentOrgEmblemUrl = null;
  let isPlatformAdmin = false;
  // Free-plan limits. Sports is the real, intentional business lever —
  // players is left generous (not a serious constraint) purely as an
  // anti-abuse ceiling, since schools can genuinely have hundreds of
  // athletes in a single sport and shouldn't be capped on that.
  const PLAN_LIMITS = {
    // Sports is no longer a real business lever — results captured is a
    // cleaner single signal (see below), and it scales with program size
    // regardless of sport count anyway (results are per team per fixture,
    // so a big single-sport school hits the threshold from game volume
    // alone). This ceiling is purely an anti-abuse safety net, like players.
    free: { sports: 50, players: 1000 }
  };
  // Catches small clubs that stay small but keep using Totem free forever.
  // Whichever happens first triggers it — real season-long usage (results
  // captured) is a fairer signal than time alone, but time is the backstop
  // for accounts that barely use it yet never leave either.
  // Results threshold is deliberately different for schools (many teams,
  // naturally rack up results fast) vs a single club/team (fewer games a
  // season) — using the same number for both would be unfair to one side.
  const FREE_PLAN_MAX_DAYS = 270; // ~9 months — a full season/school year
  const FREE_PLAN_MAX_RESULTS_BY_TYPE = { school: 100, club: 20 };
  function freePlanMaxResults(){
    return FREE_PLAN_MAX_RESULTS_BY_TYPE[currentOrgType] ?? FREE_PLAN_MAX_RESULTS_BY_TYPE.club;
  }
  function isFreePlan(){
    return !currentOrgPlan || currentOrgPlan === "free";
  }
  function daysSinceOrgCreated(){
    if(!currentOrgCreatedAt) return 0;
    // The free-plan clock starts from whichever is LATER: the org's actual
    // signup date, or your public launch date (set in config.js). This
    // means any org created during private testing/beta — before you've
    // set a launch date — never gets penalized for existing before launch.
    const created = new Date(currentOrgCreatedAt).getTime();
    const launch = window.TOTEM_CONFIG && window.TOTEM_CONFIG.LAUNCH_DATE
      ? new Date(window.TOTEM_CONFIG.LAUNCH_DATE).getTime()
      : 0;
    const effectiveStart = Math.max(created, launch);
    return (Date.now() - effectiveStart) / 86400000;
  }
  function totalResultsCaptured(){
    return (state.results || []).length + (state.trialResults || []).length;
  }
  function usageConversionDue(){
    if(!isFreePlan()) return false;
    return daysSinceOrgCreated() >= FREE_PLAN_MAX_DAYS || totalResultsCaptured() >= freePlanMaxResults();
  }
  function planLimitReached(kind){
    if(!isFreePlan()) return false;
    const limit = PLAN_LIMITS.free[kind];
    if(limit === undefined) return false;
    if(kind === "players") return state.players.length >= limit;
    if(kind === "sports") return state.sports.length >= limit;
    return false;
  }
  function showUpgradePrompt(message){
    alert(`${message}\n\nUpgrading isn't wired up to real payments yet — this is a placeholder. Contact the Totem team to upgrade for now.`);
  }
  function renderUsageBanner(){
    const el = document.getElementById("usageBanner");
    if(!el) return;
    if(usageConversionDue()){
      const reason = daysSinceOrgCreated() >= FREE_PLAN_MAX_DAYS
        ? `You've been using Totem free for over ${Math.floor(FREE_PLAN_MAX_DAYS / 30)} months`
        : `You've captured ${totalResultsCaptured()} results`;
      el.innerHTML = `${reason} — time to move to a paid plan to keep going. <button type="button" id="usageBannerUpgrade">Upgrade</button>`;
      el.style.display = "flex";
      document.getElementById("usageBannerUpgrade").addEventListener("click", () => {
        showUpgradePrompt("Ready to upgrade?");
      });
    } else {
      el.style.display = "none";
    }
  }
  let currentUserRole = null;
  let authMode = "login"; // 'login' | 'signup'
  let signupType = "create"; // 'create' | 'join'

  function showApp(user, orgName){
    currentUser = user;
    document.getElementById("authShell").style.display = "none";
    document.getElementById("appRoot").style.display = "";
    document.getElementById("headerAccount").style.display = "flex";
    document.getElementById("headerAccountEmail").textContent = user.email;
    const badge = document.getElementById("orgBadge");
    if(orgName){
      badge.textContent = orgName;
      badge.style.display = "";
    } else {
      badge.style.display = "none";
    }
    loadState();
  }
  function showAuth(){
    currentUser = null;
    currentOrgId = null;
    isPlatformAdmin = false;
    document.getElementById("appRoot").style.display = "none";
    document.getElementById("headerAccount").style.display = "none";
    document.getElementById("orgBadge").style.display = "none";
    document.getElementById("btnPlatformAdmin").style.display = "none";
    document.getElementById("accountDropdown").style.display = "none";
    document.getElementById("authShell").style.display = "flex";
  }
  function authError(msg){
    const el = document.getElementById("authError");
    document.getElementById("authInfo").style.display = "none";
    el.textContent = msg;
    el.style.display = "block";
  }
  function authInfoMsg(msg){
    const el = document.getElementById("authInfo");
    document.getElementById("authError").style.display = "none";
    el.textContent = msg;
    el.style.display = "block";
  }

  // Every account belongs to exactly one organization (club/school/team).
  // This looks up which one for the signed-in user, and RLS ensures they
  // can only ever see data belonging to that org.
  async function resolveOrgAndEnter(user){
    const { data, error } = await supabaseClient
      .from("team_members")
      .select("org_id, role, organizations(name, plan, created_at, org_type, consent_attestation_confirmed, consent_attestation_date, emblem_url)")
      .eq("id", user.id)
      .single();
    if(error || !data || !data.org_id){
      console.error("Totem: resolveOrgAndEnter failed — user.id:", user.id, "error:", error, "data:", data);
      authError("Your account isn't linked to a club yet. If you just signed up, this can take a few seconds — try logging in again, or contact your club admin.");
      await supabaseClient.auth.signOut();
      return;
    }
    currentOrgId = data.org_id;
    currentUserRole = data.role;
    currentOrgName = data.organizations ? data.organizations.name : null;
    currentOrgPlan = data.organizations ? data.organizations.plan : "free";
    currentOrgCreatedAt = data.organizations ? data.organizations.created_at : null;
    currentOrgType = data.organizations ? data.organizations.org_type : "club";
    currentOrgConsentConfirmed = data.organizations ? data.organizations.consent_attestation_confirmed : false;
    currentOrgConsentDate = data.organizations ? data.organizations.consent_attestation_date : null;
    currentOrgEmblemUrl = data.organizations ? data.organizations.emblem_url : null;
    document.getElementById("btnInviteStaff").style.display = currentUserRole === "owner" ? "" : "none";
    document.getElementById("btnRenameClub").style.display = currentUserRole === "owner" ? "" : "none";
    checkPlatformAdmin();
    showApp(user, currentOrgName);
  }
  async function checkPlatformAdmin(){
    const { data } = await supabaseClient.from("platform_admins").select("id").eq("id", currentUser.id).maybeSingle();
    isPlatformAdmin = !!data;
    document.getElementById("btnPlatformAdmin").style.display = isPlatformAdmin ? "" : "none";
  }

  function setAuthMode(mode){
    authMode = mode;
    document.querySelectorAll(".auth-toggle button[data-mode]").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
    const isSignup = mode === "signup";
    document.getElementById("signupTypeField").style.display = isSignup ? "" : "none";
    document.getElementById("orgNameField").style.display = (isSignup && signupType === "create") ? "" : "none";
    document.getElementById("duplicateWarningField").style.display = "none";
    document.getElementById("orgTypeField").style.display = (isSignup && signupType === "create") ? "" : "none";
    document.getElementById("consentField").style.display = (isSignup && signupType === "create") ? "" : "none";
    document.getElementById("inviteCodeField").style.display = (isSignup && signupType === "join") ? "" : "none";
    document.getElementById("btnLogin").textContent = isSignup ? "Sign up" : "Log in";
    document.getElementById("authTagline").textContent = isSignup ? "Set up your club's account" : "Sign in to your club account";
    document.getElementById("authHint").textContent = isSignup
      ? "Already have an account? Use the Log in tab above."
      : "Don't have an account? Use the Sign up tab above.";
    document.getElementById("authError").style.display = "none";
    document.getElementById("authInfo").style.display = "none";
  }
  function setSignupType(type){
    signupType = type;
    document.querySelectorAll(".auth-toggle button[data-signup-type]").forEach(b => b.classList.toggle("active", b.dataset.signupType === type));
    document.getElementById("orgNameField").style.display = type === "create" ? "" : "none";
    document.getElementById("duplicateWarningField").style.display = "none";
    document.getElementById("orgTypeField").style.display = type === "create" ? "" : "none";
    document.getElementById("consentField").style.display = type === "create" ? "" : "none";
    document.getElementById("inviteCodeField").style.display = type === "join" ? "" : "none";
  }
  document.querySelectorAll(".auth-toggle button[data-mode]").forEach(b => b.addEventListener("click", () => setAuthMode(b.dataset.mode)));
  document.querySelectorAll(".auth-toggle button[data-signup-type]").forEach(b => b.addEventListener("click", () => setSignupType(b.dataset.signupType)));

  async function checkDuplicateOrgName(){
    const name = document.getElementById("authOrgName").value.trim();
    const warningField = document.getElementById("duplicateWarningField");
    if(!name){ warningField.style.display = "none"; return; }
    const { data, error } = await supabaseClient.rpc("check_org_name_similar", { check_name: name });
    if(error){ console.warn("Totem: duplicate name check failed —", error.message); return; }
    warningField.style.display = data ? "" : "none";
    if(!data) document.getElementById("authDuplicateJustification").value = "";
  }
  document.getElementById("authOrgName").addEventListener("blur", checkDuplicateOrgName);
  document.getElementById("reportDuplicateLink").addEventListener("click", (e) => {
    e.preventDefault();
    const name = document.getElementById("authOrgName").value.trim();
    const supportEmail = (window.TOTEM_CONFIG && window.TOTEM_CONFIG.SUPPORT_EMAIL) || "";
    if(!supportEmail){ alert("Support contact isn't configured yet — ask your Totem administrator directly."); return; }
    const subject = encodeURIComponent(`Club name already registered: ${name}`);
    const body = encodeURIComponent(`Hi,\n\nI tried to register "${name}" as a new club on Totem, but that name is already taken by another account. I believe this is a mistake and that name belongs to us.\n\nPlease could you help resolve this?\n\nThanks`);
    window.location.href = `mailto:${supportEmail}?subject=${subject}&body=${body}`;
  });

  async function handleLogin(){
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;
    document.getElementById("authError").style.display = "none";
    document.getElementById("authInfo").style.display = "none";
    if(!email || !password){ authError("Enter your email and password."); return; }

    if(authMode === "signup"){
      const orgName = document.getElementById("authOrgName").value.trim();
      const inviteCode = document.getElementById("authInviteCode").value.trim();
      const orgTypeInput = document.querySelector('input[name="authOrgType"]:checked');
      const orgType = orgTypeInput ? orgTypeInput.value : "club";
      const consentChecked = document.getElementById("authConsentCheck").checked;
      const duplicateWarningShowing = document.getElementById("duplicateWarningField").style.display !== "none";
      const duplicateJustification = document.getElementById("authDuplicateJustification").value.trim();
      if(signupType === "create" && !orgName){ authError("Enter your club, school, or team's name."); return; }
      if(signupType === "create" && duplicateWarningShowing && !duplicateJustification){ authError("A club with this name already exists — please explain how this is a different club, or switch to \"Join an existing club\"."); return; }
      if(signupType === "create" && !consentChecked){ authError("Please confirm the consent statement before creating your club."); return; }
      if(signupType === "join" && !inviteCode){ authError("Enter the invite code your club admin gave you."); return; }

      if(signupType === "join"){
        const { data: joinOrgName, error: lookupError } = await supabaseClient.rpc("get_org_name_for_invite_code", { code: inviteCode });
        if(lookupError || !joinOrgName){ authError("That invite code wasn't recognized — double check it with your club admin."); return; }
        if(!confirm(`You're about to join: ${joinOrgName}\n\nIs this your club?`)) return;
      }

      const { data, error } = await supabaseClient.auth.signUp({
        email, password,
        options: { data: signupType === "create" ? { org_name: orgName, org_type: orgType, consent_attestation: String(consentChecked), duplicate_justification: duplicateJustification } : { invite_code: inviteCode } }
      });
      if(error){ authError(error.message); return; }
      if(data.user && !data.session){
        authInfoMsg("Check your inbox to confirm your email, then log in.");
        setAuthMode("login");
        return;
      }
      if(data.user) await resolveOrgAndEnter(data.user);
      return;
    }

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if(error){ authError(error.message); return; }
    await resolveOrgAndEnter(data.user);
  }
  document.getElementById("btnLogin").addEventListener("click", handleLogin);
  document.getElementById("authPassword").addEventListener("keydown", (e) => { if(e.key === "Enter") handleLogin(); });

  document.getElementById("btnAccountMenu").addEventListener("click", (e) => {
    e.stopPropagation();
    const dropdown = document.getElementById("accountDropdown");
    dropdown.style.display = dropdown.style.display === "none" ? "flex" : "none";
  });
  document.addEventListener("click", (e) => {
    const dropdown = document.getElementById("accountDropdown");
    if(dropdown.style.display !== "none" && !dropdown.contains(e.target) && e.target.id !== "btnAccountMenu"){
      dropdown.style.display = "none";
    }
  });
  document.getElementById("accountDropdown").addEventListener("click", (e) => {
    if(e.target.tagName === "BUTTON") document.getElementById("accountDropdown").style.display = "none";
  });

  document.getElementById("btnLogout").addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    showAuth();
  });
  document.getElementById("btnInviteStaff").addEventListener("click", async () => {
    const { data, error } = await supabaseClient
      .from("organizations")
      .select("invite_code")
      .eq("id", currentOrgId)
      .single();
    if(error || !data){ alert("Could not load your invite code — try again shortly."); return; }
    alert(`Share this invite code with staff you want to add to ${currentOrgName || "your club"}:\n\n${data.invite_code}\n\nThey pick "Sign up → Join an existing club" and enter it there.`);
  });

  document.getElementById("btnRenameClub").addEventListener("click", () => {
    document.getElementById("renameClubInput").value = currentOrgName || "";
    const typeRadio = document.querySelector(`input[name="renameClubType"][value="${currentOrgType || "club"}"]`);
    if(typeRadio) typeRadio.checked = true;
    document.getElementById("renameClubModal").classList.add("open");
    loadStaffList();
    renderConsentStatus();
    renderEmblemPreview();
  });
  function renderEmblemPreview(){
    const preview = document.getElementById("emblemPreview");
    const removeBtn = document.getElementById("btnRemoveEmblem");
    if(currentOrgEmblemUrl){
      preview.innerHTML = `<img src="${escapeHtml(currentOrgEmblemUrl)}" alt="Club emblem">`;
      removeBtn.style.display = "";
    } else {
      preview.innerHTML = "No emblem uploaded";
      removeBtn.style.display = "none";
    }
  }
  function renderConsentStatus(){
    const box = document.getElementById("consentStatusBox");
    const check = document.getElementById("renameClubConsentCheck");
    check.checked = !!currentOrgConsentConfirmed;
    if(currentOrgConsentConfirmed){
      const dateLabel = currentOrgConsentDate ? new Date(currentOrgConsentDate).toLocaleDateString() : "unknown date";
      box.className = "consent-status-box confirmed";
      box.textContent = `Consent process confirmed on ${dateLabel}.`;
    } else {
      box.className = "consent-status-box unconfirmed";
      box.textContent = "Not yet confirmed — please review before going live with real player data.";
    }
  }

  document.getElementById("btnUploadEmblem").addEventListener("click", () => {
    document.getElementById("emblemFileInput").click();
  });
  document.getElementById("emblemFileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    if(file.size > 2 * 1024 * 1024){ alert("That image is larger than 2MB — please choose a smaller file."); e.target.value = ""; return; }
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const path = `${currentOrgId}.${ext}`;
    document.getElementById("emblemPreview").innerHTML = "Uploading…";

    const { error: uploadError } = await supabaseClient.storage.from("emblems").upload(path, file, { upsert: true });
    if(uploadError){ alert("Could not upload emblem — " + uploadError.message); renderEmblemPreview(); return; }

    const { data: urlData } = supabaseClient.storage.from("emblems").getPublicUrl(path);
    const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`; // cache-bust so a replaced image shows immediately
    const { error: updateError } = await supabaseClient.from("organizations").update({ emblem_url: publicUrl }).eq("id", currentOrgId);
    if(updateError){ alert("Uploaded, but could not save it to your club — " + updateError.message); renderEmblemPreview(); return; }

    currentOrgEmblemUrl = publicUrl;
    e.target.value = "";
    renderEmblemPreview();
    showToast("Club emblem updated.");
  });
  document.getElementById("btnRemoveEmblem").addEventListener("click", async () => {
    if(!confirm("Remove your club's emblem? It will stop appearing on printed sheets.")) return;
    const { error } = await supabaseClient.from("organizations").update({ emblem_url: null }).eq("id", currentOrgId);
    if(error){ alert("Could not remove emblem — " + error.message); return; }
    currentOrgEmblemUrl = null;
    renderEmblemPreview();
    showToast("Club emblem removed.");
  });
  async function loadStaffList(){
    const listEl = document.getElementById("staffList");
    listEl.innerHTML = `<div style="font-size:12px; color:var(--slate);">Loading…</div>`;
    const { data, error } = await supabaseClient
      .from("team_members")
      .select("id, email, role")
      .eq("org_id", currentOrgId);
    if(error){
      listEl.innerHTML = `<div style="font-size:12px; color:var(--clay);">Could not load staff list.</div>`;
      return;
    }
    const owners = data.filter(m => m.role === "owner").length;
    listEl.innerHTML = data.map(m => {
      const isSelf = m.id === currentUser.id;
      const isLastOwner = m.role === "owner" && owners <= 1;
      return `
        <div class="staff-row${isSelf ? " is-self" : ""}">
          <span><span class="staff-email">${escapeHtml(m.email || "(no email)")}</span><span class="staff-role">${escapeHtml(m.role)}</span></span>
          <button type="button" data-remove-staff="${m.id}" data-email="${escapeHtml(m.email || "")}" ${isSelf || isLastOwner ? "disabled title=\"" + (isSelf ? "That's you" : "A club needs at least one owner") + "\"" : ""}>Remove</button>
        </div>`;
    }).join("");
    listEl.querySelectorAll("[data-remove-staff]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if(btn.disabled) return;
        const email = btn.dataset.email;
        if(!confirm(`Remove ${email} from ${currentOrgName || "this club"}? They'll lose access to this club's data immediately — this doesn't delete their login itself.`)) return;
        const { error } = await supabaseClient
          .from("team_members")
          .delete()
          .eq("id", btn.dataset.removeStaff);
        if(error){ alert("Could not remove that person — " + error.message); return; }
        loadStaffList();
      });
    });
  }

  document.getElementById("btnPlatformAdmin").addEventListener("click", () => {
    document.getElementById("platformAdminModal").classList.add("open");
    loadPlatformAdminList();
  });
  document.getElementById("cancelPlatformAdmin").addEventListener("click", () => {
    document.getElementById("platformAdminModal").classList.remove("open");
  });
  document.getElementById("platformAdminModal").addEventListener("click", (e) => {
    if(e.target.id === "platformAdminModal") document.getElementById("platformAdminModal").classList.remove("open");
  });
  async function loadPlatformAdminList(){
    const listEl = document.getElementById("platformAdminList");
    listEl.innerHTML = `<div style="font-size:12px; color:var(--slate);">Loading…</div>`;
    const { data, error } = await supabaseClient
      .from("organizations")
      .select("id, name, org_type, plan, created_at, duplicate_justification, flagged_for_removal, inactivity_warning_sent_at, org_state(updated_at)")
      .order("flagged_for_removal", { ascending: false })
      .order("created_at", { ascending: false });
    if(error){
      listEl.innerHTML = `<div style="font-size:12px; color:var(--clay);">Could not load clubs — ${escapeHtml(error.message)}</div>`;
      return;
    }
    listEl.innerHTML = data.map(org => {
      const dateLabel = org.created_at ? new Date(org.created_at).toLocaleDateString() : "";
      const lastActive = org.org_state ? org.org_state.updated_at : null;
      const activeLabel = lastActive ? `last active ${new Date(lastActive).toLocaleDateString()}` : "no activity recorded";
      const flagNote = org.duplicate_justification ? `<div style="font-size:10px; color:var(--gold-deep); margin-top:2px;">Flagged at signup: "${escapeHtml(org.duplicate_justification)}"</div>` : "";
      let inactivityNote = "";
      if(org.flagged_for_removal){
        inactivityNote = `<div style="font-size:10px; color:var(--clay); font-weight:700; margin-top:2px;">⚠ Flagged for removal — inactive since warning, ready for you to review</div>`;
      } else if(org.inactivity_warning_sent_at){
        inactivityNote = `<div style="font-size:10px; color:var(--gold-deep); margin-top:2px;">Inactivity warning sent ${new Date(org.inactivity_warning_sent_at).toLocaleDateString()}</div>`;
      }
      return `
        <div class="staff-row" style="align-items:flex-start; flex-direction:column; gap:8px; ${org.flagged_for_removal ? "border-color:var(--clay); background:#FBE9E4;" : ""}">
          <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
            <span><span class="staff-email">${escapeHtml(org.name)}</span><span class="staff-role">${escapeHtml(org.org_type)} · ${escapeHtml(org.plan)} · created ${escapeHtml(dateLabel)} · ${escapeHtml(activeLabel)}</span></span>
          </div>
          ${flagNote}
          ${inactivityNote}
          <div style="display:flex; gap:8px;">
            <button type="button" class="btn btn-ghost btn-small" data-admin-rename="${org.id}" data-current-name="${escapeHtml(org.name)}">Rename</button>
            <button type="button" class="btn btn-danger btn-small" data-admin-delete="${org.id}" data-name="${escapeHtml(org.name)}">Delete</button>
          </div>
        </div>`;
    }).join("") || `<div style="font-size:12px; color:var(--slate);">No clubs found.</div>`;

    listEl.querySelectorAll("[data-admin-rename]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const newName = prompt("New name for this club:", btn.dataset.currentName);
        if(!newName || !newName.trim() || newName.trim() === btn.dataset.currentName) return;
        const { error } = await supabaseClient.from("organizations").update({ name: newName.trim() }).eq("id", btn.dataset.adminRename);
        if(error){ alert("Could not rename — " + error.message); return; }
        loadPlatformAdminList();
      });
    });
    listEl.querySelectorAll("[data-admin-delete]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        if(!confirm(`Permanently delete "${name}"?\n\nThis removes the club and ALL its data (players, fixtures, results — everything). Staff logins themselves are not deleted, just their access to this club. This cannot be undone.`)) return;
        if(prompt(`Type the club's name exactly to confirm deletion:`) !== name) { alert("Name didn't match — nothing was deleted."); return; }
        const { error } = await supabaseClient.from("organizations").delete().eq("id", btn.dataset.adminDelete);
        if(error){ alert("Could not delete — " + error.message); return; }
        loadPlatformAdminList();
      });
    });
  }

  document.getElementById("cancelRenameClub").addEventListener("click", () => {
    document.getElementById("renameClubModal").classList.remove("open");
  });
  document.getElementById("renameClubModal").addEventListener("click", (e) => {
    if(e.target.id === "renameClubModal") document.getElementById("renameClubModal").classList.remove("open");
  });
  document.getElementById("confirmRenameClub").addEventListener("click", async () => {
    const newName = document.getElementById("renameClubInput").value.trim();
    if(!newName){ alert("Enter a club name."); return; }
    const typeInput = document.querySelector('input[name="renameClubType"]:checked');
    const newType = typeInput ? typeInput.value : "club";
    const consentChecked = document.getElementById("renameClubConsentCheck").checked;
    const update = { name: newName, org_type: newType, consent_attestation_confirmed: consentChecked };
    if(consentChecked) update.consent_attestation_date = new Date().toISOString();
    const { error } = await supabaseClient
      .from("organizations")
      .update(update)
      .eq("id", currentOrgId);
    if(error){ alert("Could not save your club settings — " + error.message); return; }
    currentOrgName = newName;
    currentOrgType = newType;
    currentOrgConsentConfirmed = consentChecked;
    if(consentChecked) currentOrgConsentDate = update.consent_attestation_date;
    const badge = document.getElementById("orgBadge");
    badge.textContent = newName;
    badge.style.display = "";
    document.getElementById("headerAccountEmail").textContent = currentUser.email;
    document.getElementById("renameClubModal").classList.remove("open");
    renderUsageBanner();
    showToast(`Club settings saved.`);
  });

  // persistSession is off, so this will normally find nothing and show the
  // login screen — but check anyway in case a session is still live in-memory.
  supabaseClient.auth.getSession().then(({ data }) => {
    if(data.session && data.session.user) resolveOrgAndEnter(data.session.user);
    else showAuth();
  });

  // ---------- default data ----------
  // Athletics events differ by age group (younger athletes don't throw a
  // javelin or run 5000m), so unlike other sports it defines events per
  // canonical age group rather than one flat list. This is a sensible school-
  // athletics-style progression — adjust freely to match your exact program.
  const ATHLETICS_EVENTS_BY_AGE_GROUP = {
    "U9":  ["60m","100m","200m","600m","Long Jump","High Jump","Turbo Javelin"],
    "U10": ["60m","100m","200m","600m","800m","Long Jump","High Jump","Turbo Javelin"],
    "U11": ["100m","200m","400m","800m","1500m","Long Jump","High Jump","Turbo Javelin"],
    "U12": ["100m","200m","400m","800m","1500m","Long Jump","High Jump","Shot Put","Turbo Javelin"],
    "U13": ["100m","200m","400m","800m","1500m","80m Hurdles","Long Jump","High Jump","Triple Jump","Shot Put","Discus","Javelin"],
    "U14": ["100m","200m","400m","800m","1500m","3000m","80m Hurdles","Long Jump","High Jump","Triple Jump","Shot Put","Discus","Javelin"],
    "U15": ["100m","200m","400m","800m","1500m","3000m","100m Hurdles","300m Hurdles","Long Jump","High Jump","Triple Jump","Shot Put","Discus","Javelin"],
    "U16": ["100m","200m","400m","800m","1500m","3000m","100m Hurdles","300m Hurdles","Long Jump","High Jump","Triple Jump","Pole Vault","Shot Put","Discus","Javelin","Hammer"],
    "U17": ["100m","200m","400m","800m","1500m","3000m","5000m","110m Hurdles","400m Hurdles","Long Jump","High Jump","Triple Jump","Pole Vault","Shot Put","Discus","Javelin","Hammer"],
    "U18": ["100m","200m","400m","800m","1500m","3000m","5000m","110m Hurdles","400m Hurdles","Long Jump","High Jump","Triple Jump","Pole Vault","Shot Put","Discus","Javelin","Hammer"]
  };
  // Flat fallback list (used before an age is known, or for sports/screens
  // that aren't age-group-aware) — the union of every event across all groups.
  const ATHLETICS_ALL_EVENTS = [...new Set(Object.values(ATHLETICS_EVENTS_BY_AGE_GROUP).flat())];

  const SWIMMING_TEMPLATE = { id:"swimming", name:"Swimming", iconKey:"swimming", type:"individual", positions:["Freestyle","Backstroke","Breaststroke","Butterfly","Individual Medley"] };
  const ATHLETICS_TEMPLATE = { id:"athletics", name:"Athletics", iconKey:"athletics", type:"individual", positions: ATHLETICS_ALL_EVENTS, eventsByAgeGroup: ATHLETICS_EVENTS_BY_AGE_GROUP };
  const DEFAULT_SPORTS = [
    { id:"netball", name:"Netball", iconKey:"netball", type:"team", positions:["GS","GA","WA","C","WD","GD","GK"] },
    { id:"hockey", name:"Field Hockey", iconKey:"hockey", type:"team", positions:["Goalkeeper","Right Back","Left Back","Right Half","Left Half","Right Wing","Centre Forward","Left Wing"] },
    JSON.parse(JSON.stringify(SWIMMING_TEMPLATE)),
    JSON.parse(JSON.stringify(ATHLETICS_TEMPLATE))
  ];
  // Swimming/Athletics templates above are also used by the "Quick add"
  // buttons in the Add Sport modal, for re-adding either one with its full
  // event data intact if it's ever removed from a club's sport list.
  const DEFAULT_FIELDS = [
    {key:"fitness", label:"Fitness"},
    {key:"skill", label:"Skill"},
    {key:"speed", label:"Speed"},
    {key:"strength", label:"Strength"},
    {key:"agility", label:"Agility"},
    {key:"reliability", label:"Reliability"},
    {key:"teamSpirit", label:"Team Spirit"}
  ];

  let state = {
    sports: JSON.parse(JSON.stringify(DEFAULT_SPORTS)),
    metricFields: JSON.parse(JSON.stringify(DEFAULT_FIELDS)),
    players: [],
    fixtures: [],
    coaches: [],
    results: [],
    trials: [],
    trialResults: [],
    teamOverrides: {},
    bench: {},
    unavailable: {},
    venues: [],
    activeSport: "netball"
  };

  let expandedPlayerId = null;
  let storageReady = false;
  const SIDE_LETTERS = ["A","B","C","D","E"];
  // Every sport always presents this fixed set of teams, regardless of who's
  // currently rated — a club plans age groups ahead of having players in them.
  const CANONICAL_AGE_GROUPS = ["U9","U10","U11","U12","U13","U14","U15","U16","U17","U18"];
  // U18 is the club's senior/representative age group — team sports use club
  // terminology ("1st Team", "2nd Team"...) for its sides instead of "A Side".
  const U18_SIDE_NAMES = { A:"1st Team", B:"2nd Team", C:"3rd Team", D:"4th Team", E:"5th Team" };
  function seniorSideLabel(sport, group, side){
    if(sportType(sport) === "team" && groupsMatch(group, "U18")) return U18_SIDE_NAMES[side] || (side + " Team");
    return null;
  }
  let sidesActiveAgeGroup = null;
  let calendarDate = new Date();
  let openFixtureId = null;
  let editingFixtureId = null;
  let editingTrialId = null;
  let dashboardAgeGroup = null;
  let resultDraft = null;

  // ---------- storage ----------
  async function fetchClubState(){
    const { data, error } = await supabaseClient
      .from("org_state")
      .select("data")
      .eq("org_id", currentOrgId)
      .single();
    if(error){
      console.warn("Totem: could not load club data —", error.message);
      return null;
    }
    return data ? data.data : null;
  }
  async function persistClubState(){
    const { error } = await supabaseClient
      .from("org_state")
      .update({ data: state, updated_at: new Date().toISOString(), updated_by: currentUser ? currentUser.id : null })
      .eq("org_id", currentOrgId);
    if(error) console.warn("Totem: could not save —", error.message);
  }

  async function loadState(){
    try{
      const parsed = await fetchClubState();
      if(parsed) state = Object.assign(state, parsed);
    }catch(e){
      // no saved data yet, or a load error — start fresh in memory for this session
      console.warn("Totem: could not load saved data.", e);
    }

    // ---- migrate older saved shapes ----
    // Fixtures used to store a flat ageGroups[] list (implicitly "A side" for
    // each). They now store entries:[{ageGroup,side}] so a specific side can
    // be booked per age group.
    state.fixtures = (state.fixtures || []).map(f => {
      if(f.entries) return f;
      const entries = (f.ageGroups || []).map(g => ({ ageGroup: g, side: "A" }));
      const migrated = Object.assign({}, f, { entries });
      delete migrated.ageGroups;
      return migrated;
    });
    // Results used to be keyed by (fixtureId, ageGroup) only — now also by side.
    state.results = (state.results || []).map(r => r.side ? r : Object.assign({}, r, { side: "A" }));
    state.teamOverrides = state.teamOverrides || {};
    state.bench = state.bench || {};
    state.trials = state.trials || [];
    state.trialResults = state.trialResults || [];
    state.unavailable = state.unavailable || {};

    // Field Hockey's default positions changed from a 4-role placeholder to a
    // real 8-a-side lineup — upgrade it automatically, but only if it still
    // has the old placeholder positions (never touch a club's own customization).
    const OLD_HOCKEY_POSITIONS = JSON.stringify(["Goalkeeper","Defender","Midfielder","Forward"]);
    const hockeySport = state.sports.find(s => s.id === "hockey");
    if(hockeySport && JSON.stringify(hockeySport.positions) === OLD_HOCKEY_POSITIONS){
      hockeySport.positions = JSON.parse(JSON.stringify(DEFAULT_SPORTS.find(s => s.id === "hockey").positions));
    }

    // Players used to store a plain "age" number — now they store a date of
    // birth so age groups update automatically each year. Estimate a DOB that
    // reproduces roughly the same age group as before (month/day unknown, so
    // Jan 1 is used as a placeholder) — flag these for a real DOB when convenient.
    state.players = (state.players || []).map(p => {
      if(p.birthDate) return p;
      if(typeof p.age === "number"){
        const estimatedBirthYear = new Date().getFullYear() - (p.age + 1);
        const migrated = Object.assign({}, p, { birthDate: `${estimatedBirthYear}-01-01`, dobEstimated: true });
        delete migrated.age;
        return migrated;
      }
      return p;
    });

    // Players used to store a single "position" string — now they store a
    // positions array (individual sports allow more than one event per athlete).
    state.players = (state.players || []).map(p => {
      if(p.positions) return p;
      const migrated = Object.assign({}, p, { positions: p.position ? [p.position] : [] });
      delete migrated.position;
      return migrated;
    });

    // U18 is now the oldest/senior age group ("Senior" no longer exists as a
    // separate label) — merge any older saved data that used "Senior" into it.
    state.coaches.forEach(c => { if(groupsMatch(c.ageGroup, "Senior")) c.ageGroup = "U18"; });
    state.fixtures.forEach(f => {
      (f.entries || []).forEach(en => { if(groupsMatch(en.ageGroup, "Senior")) en.ageGroup = "U18"; });
    });
    state.results.forEach(r => { if(groupsMatch(r.ageGroup, "Senior")) r.ageGroup = "U18"; });

    // Add the new Athletics sport for anyone who already has saved data from
    // before it existed (existing sports/players/etc. are left untouched).
    if(!state.sports.find(s => s.id === "athletics")){
      state.sports.push(JSON.parse(JSON.stringify(DEFAULT_SPORTS.find(s => s.id === "athletics"))));
    }

    storageReady = true;
    render();
  }
  async function saveState(){
    await persistClubState();
  }

  // ---------- helpers ----------
  function uid(){ return Math.random().toString(36).slice(2,10); }
  // Age group is based on the age a player TURNS during the current calendar
  // year (standard school-sport age grading), not their exact age today —
  // e.g. someone turning 9 this year plays U9 whether or not their birthday
  // has happened yet. U18 is the oldest group (the senior team), so anyone
  // turning 18 or older this year is capped at U18.
  function ageGroup(turningAgeThisYear){
    if(turningAgeThisYear >= 18) return "U18";
    return "U" + turningAgeThisYear;
  }
  function turningAgeFromBirthDate(birthDate){
    if(!birthDate) return null;
    const birthYear = +String(birthDate).slice(0,4);
    if(!birthYear) return null;
    return new Date().getFullYear() - birthYear;
  }
  function ageGroupForPlayer(player){
    const turning = turningAgeFromBirthDate(player.birthDate);
    return turning === null ? null : ageGroup(turning);
  }
  function formatDob(birthDate){
    if(!birthDate) return "—";
    return new Date(birthDate + "T00:00:00").toLocaleDateString(undefined, { day:"numeric", month:"short", year:"numeric" });
  }
  // Players hold an array of positions/events (most sports use exactly one;
  // individual sports like Athletics allow several disciplines per athlete).
  function playerPositions(p){
    return p.positions && p.positions.length ? p.positions : (p.position ? [p.position] : []);
  }
  // Sorts age-group labels numerically (U9, U10, U11 ... U18).
  function sortAgeGroups(groups){
    return groups.slice().sort((a,b) => (parseInt(a.slice(1),10) || 0) - (parseInt(b.slice(1),10) || 0));
  }
  function currentSport(){
    return state.sports.find(s => s.id === state.activeSport) || state.sports[0];
  }
  function sportType(sport){
    return sport && sport.type === "individual" ? "individual" : "team";
  }
  function playersForSport(sportId){
    return state.players.filter(p => p.sportId === sportId);
  }
  function overallScore(player){
    const fields = state.metricFields;
    if(fields.length === 0) return 0;
    let sum = 0;
    fields.forEach(f => { sum += (player.metrics[f.key] ?? 5); });
    return sum / fields.length;
  }
  function colorForScore(score){
    // 0 -> pale chalk-green, 10 -> deep pitch
    const t = Math.max(0, Math.min(10, score)) / 10;
    const lightness = 88 - t * 58; // 88% -> 30%
    return `hsl(152, 32%, ${lightness}%)`;
  }
  function computeTopPicks(sportId){
    const players = playersForSport(sportId);
    const map = {}; // key: position|ageGroup -> best player for that specific position
    players.forEach(p => {
      const score = overallScore(p);
      playerPositions(p).forEach(position => {
        const key = position + "|" + ageGroupForPlayer(p);
        if(!map[key] || score > map[key].score ||
          (score === map[key].score && (p.metrics.reliability ?? 0) > (map[key].player.metrics.reliability ?? 0))){
          map[key] = { player:p, score, position };
        }
      });
    });
    return map;
  }

  // Ranks players within a sport + age group by position, then slots the
  // ranked order into sides A, B, C, D, E (1st best -> A, 2nd best -> B, etc.)
  // so each side fields its strongest available player per position.
  // Most sports use one flat position list for every age group. A sport can
  // opt into per-age-group lists instead (Athletics does, since events differ
  // by age) via an eventsByAgeGroup map; this resolves whichever applies.
  function positionsForGroup(sport, group){
    if(sport.eventsByAgeGroup && sport.eventsByAgeGroup[group]) return sport.eventsByAgeGroup[group];
    return sport.positions;
  }
  // Keeps a sport's flat "positions" fallback (used before an age is known)
  // representative of its per-age-group events, after any edit to those.
  function recomputeFlatPositions(sport){
    if(!sport.eventsByAgeGroup) return;
    sport.positions = [...new Set(Object.values(sport.eventsByAgeGroup).flat())];
  }

  function computeSides(sportId, group, excludeIds){
    const sport = state.sports.find(s => s.id === sportId) || state.sports[0];
    const players = playersForSport(sportId)
      .filter(p => ageGroupForPlayer(p) === group)
      .filter(p => !excludeIds || !excludeIds.includes(p.id));
    const useTrials = sportType(sport) === "individual";

    const board = {}; // side letter -> { position -> {player, score, trialSeconds?} }
    SIDE_LETTERS.forEach(letter => board[letter] = {});

    positionsForGroup(sport, group).forEach(position => {
      const ranked = players
        .filter(p => playerPositions(p).includes(position))
        .map(p => {
          const trial = useTrials ? bestTrialTime(sportId, p.id, position, group) : null;
          return {
            player: p,
            score: overallScore(p),
            trialSeconds: trial ? trial.seconds : null,
            trialTime: trial ? trial.time : null
          };
        })
        .sort((a,b) => {
          if(useTrials){
            const aHas = a.trialSeconds !== null, bHas = b.trialSeconds !== null;
            if(aHas && bHas) return a.trialSeconds - b.trialSeconds; // faster time wins
            if(aHas !== bHas) return aHas ? -1 : 1; // trialled athletes rank above untested ones
          }
          return b.score - a.score || (b.player.metrics.reliability ?? 0) - (a.player.metrics.reliability ?? 0);
        });

      SIDE_LETTERS.forEach((letter, idx) => {
        board[letter][position] = ranked[idx] || null;
      });
    });

    return board;
  }

  // ---------- manual team-list overrides (injury / illness swaps) ----------
  // Auto-selected sides from computeSides() can be overridden slot-by-slot.
  // Overrides are keyed by sport+age group+side+position so an edit made from
  // either the Team Sides board or a fixture's team sheet is the same edit.
  function slotKey(sportId, group, side, position){
    return sportId + "|" + normalizeGroupLabelKey(group) + "|" + side + "|" + position;
  }
  // Keep the override key's group segment normalized so stray casing on a
  // free-typed age group doesn't split one team into two override buckets.
  function normalizeGroupLabelKey(g){
    return String(g || "").trim();
  }
  function resolvedSlot(sportId, group, side, position, autoEntry){
    const key = slotKey(sportId, group, side, position);
    if(Object.prototype.hasOwnProperty.call(state.teamOverrides, key)){
      const playerId = state.teamOverrides[key];
      if(playerId === null) return null; // explicitly left empty
      const player = state.players.find(p => p.id === playerId);
      if(!player) return null; // overridden player no longer exists
      return { player, score: overallScore(player), overridden: true };
    }
    return autoEntry;
  }
  function eligiblePlayersForSwap(sportId, group){
    return state.players
      .filter(p => p.sportId === sportId && ageGroupForPlayer(p) === group)
      .sort((a,b) => a.name.localeCompare(b.name));
  }
  function slotEditableHtml(sportId, group, side, position, autoEntry){
    const key = slotKey(sportId, group, side, position);
    const hasOverride = Object.prototype.hasOwnProperty.call(state.teamOverrides, key);
    const overridePlayerId = hasOverride ? state.teamOverrides[key] : undefined;
    const resolved = resolvedSlot(sportId, group, side, position, autoEntry);
    const players = eligiblePlayersForSwap(sportId, group);

    const options = [
      `<option value="__auto__" ${!hasOverride ? "selected" : ""}>Auto: ${autoEntry ? escapeHtml(autoEntry.player.name) : "Unfilled"}</option>`,
      `<option value="__empty__" ${hasOverride && overridePlayerId === null ? "selected" : ""}>— Leave empty —</option>`,
      ...players.map(p => `<option value="${p.id}" ${hasOverride && overridePlayerId === p.id ? "selected" : ""}>${escapeHtml(p.name)} (${escapeHtml(playerPositions(p).join(", "))})</option>`)
    ].join("");

    const scoreDisplay = resolved ? (resolved.trialTime ? "⏱ " + escapeHtml(resolved.trialTime) : resolved.score.toFixed(1)) : "";
    return `
      <div class="side-slot${resolved ? "" : " slot-unfilled-row"}">
        <span class="slot-pos">${escapeHtml(position)}</span>
        <select class="slot-select" data-sport="${sportId}" data-group="${escapeHtml(group)}" data-side="${side}" data-position="${escapeHtml(position)}">
          ${options}
        </select>
        <span class="slot-score">${scoreDisplay}</span>
      </div>
    `;
  }
  function wireSlotSelects(container){
    container.querySelectorAll(".slot-select").forEach(sel => {
      sel.addEventListener("change", (e) => {
        const { sport, group, side, position } = e.target.dataset;
        const key = slotKey(sport, group, side, position);
        const val = e.target.value;
        if(val === "__auto__") delete state.teamOverrides[key];
        else if(val === "__empty__") state.teamOverrides[key] = null;
        else state.teamOverrides[key] = val;
        saveState();
        renderSides();
        renderFixtureDetail();
      });
    });
  }

  // ---------- bench (manual, up to 3 per team) ----------
  // Unlike the starting lineup, bench spots are never auto-picked — staff
  // choose them by hand once the algorithm's best XI/team is set.
  function benchKey(sportId, group, side){
    return sportId + "|" + normalizeGroupLabelKey(group) + "|" + side;
  }
  function benchFor(sportId, group, side){
    return state.bench[benchKey(sportId, group, side)] || [];
  }
  function benchEditableHtml(sportId, group, side){
    const bench = benchFor(sportId, group, side);
    const players = eligiblePlayersForSwap(sportId, group);

    const rows = [0, 1, 2].map(i => {
      const current = bench[i] || "";
      const options = [`<option value="">— empty —</option>`]
        .concat(players.map(p => `<option value="${p.id}" ${current === p.id ? "selected" : ""}>${escapeHtml(p.name)} (${escapeHtml(playerPositions(p).join(", "))})</option>`))
        .join("");
      return `
        <div class="side-slot bench-slot">
          <span class="slot-pos">Bench ${i + 1}</span>
          <select class="bench-select" data-sport="${sportId}" data-group="${escapeHtml(group)}" data-side="${side}" data-idx="${i}">
            ${options}
          </select>
        </div>
      `;
    }).join("");

    return `<div class="bench-block">
      <div class="bench-head">Bench <span class="bench-sub">up to 3 — picked manually</span></div>
      ${rows}
    </div>`;
  }
  function wireBenchSelects(container){
    container.querySelectorAll(".bench-select").forEach(sel => {
      sel.addEventListener("change", (e) => {
        const { sport, group, side, idx } = e.target.dataset;
        const key = benchKey(sport, group, side);
        const arr = (state.bench[key] || []).slice();
        arr[+idx] = e.target.value || null;
        state.bench[key] = arr;
        saveState();
        renderSides();
        renderFixtureDetail();
      });
    });
  }

  function ageGroupsForSport(sportId){
    return CANONICAL_AGE_GROUPS.slice();
  }

  // Normalized comparison for age-group labels — coaches/fixtures store free-typed
  // text, so matching must tolerate stray casing/whitespace differences against
  // the canonical "U11"-style labels the algorithm produces.
  function normalizeGroupLabel(g){
    return String(g || "").trim().toLowerCase();
  }
  function groupsMatch(a, b){
    return normalizeGroupLabel(a) === normalizeGroupLabel(b);
  }

  // ---------- head coaches ----------
  function coachesForSport(sportId){
    return state.coaches.filter(c => c.sportId === sportId);
  }
  function coachFor(sportId, group, side){
    if(side){
      const specific = state.coaches.find(c => c.sportId === sportId && groupsMatch(c.ageGroup, group) && c.side === side);
      if(specific) return specific;
    }
    return state.coaches.find(c => c.sportId === sportId && groupsMatch(c.ageGroup, group) && !c.side);
  }

  // ---------- venues (name + optional address, remembered across fixtures) ----------
  function venueAddressFor(name){
    if(!name) return null;
    const v = state.venues.find(v => v.name.toLowerCase() === name.trim().toLowerCase());
    return v ? v.address : null;
  }
  function upsertVenue(name, address){
    const trimmedName = (name || "").trim();
    if(!trimmedName) return;
    const existing = state.venues.find(v => v.name.toLowerCase() === trimmedName.toLowerCase());
    if(existing){
      if(address && address.trim()) existing.address = address.trim();
    } else {
      state.venues.push({ name: trimmedName, address: (address || "").trim() || null });
    }
  }
  function directionsUrl(address){
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  }
  function venueLineHtml(venueName, withSeparator){
    if(!venueName) return "";
    const prefix = withSeparator === false ? "" : " · ";
    const address = venueAddressFor(venueName);
    if(address){
      return `${prefix}${escapeHtml(venueName)} <a href="${directionsUrl(address)}" target="_blank" rel="noopener" class="directions-link" onclick="event.stopPropagation()">${uiIcon("flag", 11)} Directions</a>`;
    }
    return `${prefix}${escapeHtml(venueName)}`;
  }
  function populateVenueDatalist(){
    const el = document.getElementById("venueList");
    if(!el) return;
    el.innerHTML = state.venues.map(v => `<option value="${escapeHtml(v.name)}"></option>`).join("");
  }

  function populateCoachAgeGroupSelect(){
    const sport = currentSport();
    const groups = ageGroupsForSport(sport.id);
    const sel = document.getElementById("inCoachAgeGroup");
    const current = sel.value;
    sel.innerHTML = groups.map(g => `<option value="${g}">${g}</option>`).join("");
    sel.value = groups.includes(current) ? current : groups[0];
    document.getElementById("inCoachSideField").style.display = sportType(sport) === "individual" ? "none" : "";
    populateCoachSideSelect();
  }
  function populateCoachSideSelect(){
    const sport = currentSport();
    const group = document.getElementById("inCoachAgeGroup").value;
    const sideSel = document.getElementById("inCoachSide");
    const current = sideSel.value;
    sideSel.innerHTML = `<option value="">Head coach (all sides)</option>` +
      SIDE_LETTERS.map(side => `<option value="${side}">${escapeHtml(seniorSideLabel(sport, group, side) || side + " side")}</option>`).join("");
    sideSel.value = current || "";
  }
  document.getElementById("inCoachAgeGroup").addEventListener("change", populateCoachSideSelect);

  function renderCoaches(){
    const sport = currentSport();
    populateCoachAgeGroupSelect();

    const list = coachesForSport(sport.id);
    const orderedGroups = sortAgeGroups(list.map(c => c.ageGroup));
    list.sort((a,b) => {
      const groupDiff = orderedGroups.indexOf(a.ageGroup) - orderedGroups.indexOf(b.ageGroup);
      if(groupDiff !== 0) return groupDiff;
      const aSide = a.side || "";
      const bSide = b.side || "";
      return aSide.localeCompare(bSide); // "" (head coach) sorts before "A","B",...
    });

    const grid = document.getElementById("coachGrid");

    if(list.length === 0){
      grid.innerHTML = `<div class="roster-empty" style="grid-column:1/-1;">
        <span class="glyph">${uiIcon("coach", 34)}</span>
        <h3>No coaches assigned</h3>
        <div>Assign a head coach to each age group above so everyone knows who's leading which team.</div>
      </div>`;
      return;
    }

    grid.innerHTML = list.map(c => {
      const sideLabel = c.side ? (seniorSideLabel(sport, c.ageGroup, c.side) || `${c.side} side`) : "Head Coach";
      return `
      <div class="pick-card coach-card">
        <div class="pos">${escapeHtml(c.ageGroup)} · ${escapeHtml(sideLabel)}</div>
        <div class="pname">${escapeHtml(c.name)}</div>
        <div class="page">${escapeHtml(c.email || "")}</div>
        ${c.phone ? `<div class="page">${escapeHtml(c.phone)}</div>` : ""}
        <button class="btn btn-danger btn-small" data-action="remove-coach" data-id="${c.id}" style="margin-top:10px;">Remove</button>
      </div>
    `;}).join("");

    grid.querySelectorAll('[data-action="remove-coach"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        const id = e.target.dataset.id;
        state.coaches = state.coaches.filter(c => c.id !== id);
        saveState(); renderCoaches(); renderSides(); renderFixtureDetail(); renderCoachLeaderboard();
      });
    });
  }

  function isValidEmail(email){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  document.getElementById("btnAddCoach").addEventListener("click", () => {
    const sport = currentSport();
    const ageGroupInp = document.getElementById("inCoachAgeGroup");
    const sideInp = document.getElementById("inCoachSide");
    const nameInp = document.getElementById("inCoachName");
    const emailInp = document.getElementById("inCoachEmail");
    const phoneInp = document.getElementById("inCoachPhone");
    const ageGroupVal = ageGroupInp.value.trim();
    const side = sportType(sport) === "individual" ? "" : sideInp.value;
    const name = nameInp.value.trim();
    const email = emailInp.value.trim();
    const phone = phoneInp.value.trim();

    if(!ageGroupVal){ alert("Enter an age group, e.g. U11 or Senior."); ageGroupInp.focus(); return; }
    if(!name){ alert("Enter the coach's name."); nameInp.focus(); return; }
    if(!email){ alert("Enter the coach's email — it's required so they can receive automatic result notifications."); emailInp.focus(); return; }
    if(!isValidEmail(email)){ alert("Enter a valid email address."); emailInp.focus(); return; }

    const existing = state.coaches.find(c => c.sportId === sport.id && groupsMatch(c.ageGroup, ageGroupVal) && (c.side || "") === side);
    if(existing){
      existing.name = name;
      existing.email = email;
      existing.phone = phone;
    } else {
      state.coaches.push({ id: uid(), sportId: sport.id, ageGroup: ageGroupVal, side: side || null, name, email, phone });
    }
    nameInp.value = ""; emailInp.value = ""; phoneInp.value = "";
    saveState(); renderCoaches(); renderSides(); renderFixtureDetail(); renderCoachLeaderboard();
  });

  // ---------- rendering ----------
  function renderSportTabs(){
    const nav = document.getElementById("sportTabs");
    nav.innerHTML = "";
    state.sports.forEach(s => {
      const btn = document.createElement("button");
      btn.className = "sport-tab" + (s.id === state.activeSport ? " active" : "");
      btn.innerHTML = `<span class="icon">${sportIconHtml(s, 16)}</span><span>${escapeHtml(s.name)}</span>`;
      btn.addEventListener("click", () => { state.activeSport = s.id; expandedPlayerId = null; sidesActiveAgeGroup = null; openFixtureId = null; openTrialId = null; dashboardAgeGroup = null; render(); });
      nav.appendChild(btn);
    });
    const addBtn = document.createElement("button");
    addBtn.className = "sport-tab add";
    addBtn.textContent = "+ Add sport";
    addBtn.addEventListener("click", openSportModal);
    nav.appendChild(addBtn);
  }

  function updateEventsToggleLabel(){
    const count = document.querySelectorAll("#inPositionsMulti input:checked").length;
    const btn = document.getElementById("inPositionsMultiToggle");
    btn.textContent = count === 0 ? "Select events ▾" : `${count} event${count === 1 ? "" : "s"} selected ▾`;
  }

  function renderPositionSelect(){
    const sport = currentSport();
    const dobVal = document.getElementById("inDob").value;
    const turning = turningAgeFromBirthDate(dobVal);
    const positions = turning !== null ? positionsForGroup(sport, ageGroup(turning)) : sport.positions;
    const isIndividual = sportType(sport) === "individual";
    const noun = isIndividual ? "Event" : "Position";

    document.getElementById("inPositionField").style.display = isIndividual ? "none" : "";
    document.getElementById("inPositionsMultiField").style.display = isIndividual ? "" : "none";

    if(isIndividual){
      document.getElementById("inPositionsMultiLabel").textContent = "Events";
      const wrap = document.getElementById("inPositionsMulti");
      const checkedBefore = new Set(Array.from(wrap.querySelectorAll("input:checked")).map(i => i.value));
      wrap.innerHTML = positions.map(p => `
        <label>
          <input type="checkbox" value="${escapeHtml(p)}" ${checkedBefore.has(p) ? "checked" : ""}>
          <span>${escapeHtml(p)}</span>
        </label>
      `).join("");
      updateEventsToggleLabel();
      wrap.querySelectorAll("input").forEach(cb => cb.addEventListener("change", updateEventsToggleLabel));
    } else {
      document.getElementById("inPositionLabel").textContent = "Position";
      const sel = document.getElementById("inPosition");
      const currentVal = sel.value;
      sel.innerHTML = positions.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
      sel.value = positions.includes(currentVal) ? currentVal : positions[0];
    }
  }

  function renderFilters(){
    const sport = currentSport();
    const players = playersForSport(sport.id);

    const ageSel = document.getElementById("filterAge");
    const groups = ageGroupsForSport(sport.id);
    const currentAgeVal = ageSel.value;
    ageSel.innerHTML = `<option value="">All ages</option>` + groups.map(g => `<option value="${g}">${g}</option>`).join("");
    ageSel.value = groups.includes(currentAgeVal) ? currentAgeVal : "";

    // when a specific age group is filtered, narrow the position/event list to
    // what's actually valid for that group (relevant for Athletics-style sports)
    const filterPositions = ageSel.value ? positionsForGroup(sport, ageSel.value) : sport.positions;
    const noun = sportType(sport) === "individual" ? "events" : "positions";
    const posSel = document.getElementById("filterPosition");
    const currentPosVal = posSel.value;
    posSel.innerHTML = `<option value="">All ${noun}</option>` + filterPositions.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
    posSel.value = filterPositions.includes(currentPosVal) ? currentPosVal : "";
  }

  function renderMetricManager(){
    const list = document.getElementById("metricFieldList");
    list.innerHTML = "";
    state.metricFields.forEach((f, idx) => {
      const row = document.createElement("div");
      row.className = "metric-manager-row";
      row.innerHTML = `
        <input type="text" data-idx="${idx}" class="field-rename" value="${escapeHtml(f.label)}">
        <button class="btn btn-danger btn-small" data-idx="${idx}" data-action="remove-field">Remove</button>
      `;
      list.appendChild(row);
    });
    list.querySelectorAll(".field-rename").forEach(inp => {
      inp.addEventListener("change", (e) => {
        const idx = +e.target.dataset.idx;
        state.metricFields[idx].label = e.target.value.trim() || state.metricFields[idx].label;
        saveState(); render();
      });
    });
    list.querySelectorAll('[data-action="remove-field"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        const idx = +e.target.dataset.idx;
        if(state.metricFields.length <= 1){ alert("Keep at least one metric field."); return; }
        state.metricFields.splice(idx,1);
        saveState(); render();
      });
    });
  }

  function renderPositionsManager(){
    const sport = currentSport();
    const isIndividual = sportType(sport) === "individual";
    const noun = isIndividual ? "Events" : "Positions";
    document.getElementById("positionsTitle").textContent = noun;
    document.getElementById("togglePositions").textContent = `Manage ${noun.toLowerCase()}`;
    document.getElementById("newPositionName").placeholder = `Add a new ${isIndividual ? "event" : "position"}`;

    const hasPerGroup = !!sport.eventsByAgeGroup;
    document.getElementById("positionsAgeGroupField").style.display = hasPerGroup ? "" : "none";

    let group = null;
    if(hasPerGroup){
      const groups = ageGroupsForSport(sport.id);
      const sel = document.getElementById("positionsAgeGroupSelect");
      const current = sel.value;
      sel.innerHTML = groups.map(g => `<option value="${g}">${g}</option>`).join("");
      sel.value = groups.includes(current) ? current : groups[0];
      group = sel.value;
    }

    const list = hasPerGroup ? (sport.eventsByAgeGroup[group] || []) : sport.positions;
    const listEl = document.getElementById("positionFieldList");
    listEl.innerHTML = list.map((pos, idx) => `
      <div class="metric-manager-row">
        <input type="text" data-idx="${idx}" class="position-rename" value="${escapeHtml(pos)}">
        <button class="btn btn-danger btn-small" data-idx="${idx}" data-action="remove-position">Remove</button>
      </div>
    `).join("");

    listEl.querySelectorAll(".position-rename").forEach(inp => {
      inp.addEventListener("change", (e) => {
        const idx = +e.target.dataset.idx;
        const newVal = e.target.value.trim();
        const oldVal = list[idx];
        if(!newVal){ e.target.value = oldVal; return; }
        if(newVal === oldVal) return;
        list[idx] = newVal;
        if(hasPerGroup) recomputeFlatPositions(sport);
        // keep affected players' recorded positions in sync with the rename
        state.players.forEach(p => {
          if(p.sportId !== sport.id) return;
          if(hasPerGroup && ageGroupForPlayer(p) !== group) return;
          p.positions = playerPositions(p).map(pp => pp === oldVal ? newVal : pp);
        });
        saveState(); render();
      });
    });
    listEl.querySelectorAll('[data-action="remove-position"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        if(list.length <= 1){ alert(`Keep at least one ${isIndividual ? "event" : "position"}.`); return; }
        const idx = +e.target.dataset.idx;
        const removed = list[idx];
        if(!confirm(`Remove "${removed}"? Players currently assigned to it will keep the label but won't slot into a side until reassigned.`)) return;
        list.splice(idx,1);
        if(hasPerGroup) recomputeFlatPositions(sport);
        saveState(); render();
      });
    });
  }

  function totemBlocks(player, size){
    // size: "mini" or "full"
    const fields = state.metricFields;
    const height = size === "mini" ? 54 : 120;
    const width = size === "mini" ? 9 : 26;
    return fields.map(f => {
      const val = player.metrics[f.key] ?? 5;
      const h = Math.max(6, (val/10) * height);
      const bg = colorForScore(val);
      const label = size === "mini" ? "" : `<div style="font-size:9px;color:var(--slate);margin-top:3px;text-align:center;width:${width}px;">${f.label.slice(0,4)}</div>`;
      return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;">
                <div class="blk" style="width:${width}px;height:${h}px;background:${bg};border-radius:3px;"></div>
                ${label}
              </div>`;
    }).join("");
  }

  function renderRoster(){
    const sport = currentSport();
    document.getElementById("rosterTitle").textContent = sport.name + " roster";
    const ageFilter = document.getElementById("filterAge").value;
    const posFilter = document.getElementById("filterPosition").value;
    const searchTerm = document.getElementById("filterSearch").value.trim().toLowerCase();

    let players = playersForSport(sport.id);
    if(ageFilter) players = players.filter(p => ageGroupForPlayer(p) === ageFilter);
    if(posFilter) players = players.filter(p => playerPositions(p).includes(posFilter));
    if(searchTerm) players = players.filter(p => p.name.toLowerCase().includes(searchTerm));

    document.getElementById("rosterCount").textContent = players.length + (players.length === 1 ? " player" : " players");

    const picks = computeTopPicks(sport.id);
    const pickIds = new Set(Object.values(picks).map(v => v.player.id));

    const grid = document.getElementById("rosterGrid");
    grid.innerHTML = "";

    if(players.length === 0){
      grid.innerHTML = `<div class="roster-empty" style="grid-column:1/-1;">
        <span class="glyph">${uiIcon("playerPlus", 34)}</span>
        <h3>No players yet</h3>
        <div>Add your first ${escapeHtml(sport.name.toLowerCase())} player above to start building the totem.</div>
      </div>`;
      return;
    }

    players
      .slice()
      .sort((a,b) => overallScore(b) - overallScore(a))
      .forEach(p => {
        const score = overallScore(p);
        const isPick = pickIds.has(p.id);
        const card = document.createElement("div");
        card.className = "player-card" + (isPick ? " pick" : "");
        const expanded = expandedPlayerId === p.id;

        card.innerHTML = `
          ${isPick ? `<div class="pick-badge">Totem Pick</div>` : ""}
          <div class="card-head">
            <div>
              <p class="name">${escapeHtml(p.name)}</p>
              <div class="meta">${formatDob(p.birthDate)} · ${ageGroupForPlayer(p)}${p.dobEstimated ? ` <span class="dob-estimated" title="Estimated during migration — edit with a real date of birth when convenient">${uiIcon("warning", 11)} estimated DOB</span>` : ""}</div>
            </div>
          </div>
          <div class="badge-row">
            ${playerPositions(p).map(pos => `<span class="badge">${escapeHtml(pos)}</span>`).join("")}
          </div>
          <div class="card-body">
            <div class="totem-mini">${totemBlocks(p, "mini")}</div>
            <div class="score-box">
              <div class="val">${score.toFixed(1)}</div>
              <div class="lbl">overall</div>
            </div>
            ${(p.vo2max !== null && p.vo2max !== undefined) ? `
            <div class="score-box vo2-box">
              <div class="val">${p.vo2max}</div>
              <div class="lbl">VO2 max</div>
            </div>` : ""}
          </div>
          <div class="card-actions">
            <button class="btn btn-ghost btn-small" data-action="toggle" data-id="${p.id}">${expanded ? "Hide ratings" : "Rate player"}</button>
            <button class="btn btn-danger btn-small" data-action="delete" data-id="${p.id}" style="margin-left:auto;">Remove</button>
          </div>
          ${expanded ? renderMetricsPanel(p) : ""}
        `;
        grid.appendChild(card);
      });

    grid.querySelectorAll('[data-action="toggle"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        const id = e.target.dataset.id;
        expandedPlayerId = expandedPlayerId === id ? null : id;
        render();
      });
    });
    grid.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        const id = e.target.dataset.id;
        const p = state.players.find(pl => pl.id === id);
        if(p && confirm(`Remove ${p.name} from the roster?`)){
          state.players = state.players.filter(pl => pl.id !== id);
          saveState(); render();
        }
      });
    });
    grid.querySelectorAll('input[type="range"]').forEach(inp => {
      inp.addEventListener("input", (e) => {
        const id = e.target.dataset.id;
        const key = e.target.dataset.key;
        const p = state.players.find(pl => pl.id === id);
        p.metrics[key] = +e.target.value;
        const valSpan = e.target.parentElement.querySelector(".m-val");
        if(valSpan) valSpan.textContent = e.target.value;
        // live-update this card's mini totem + score without full re-render for smoothness
        updateCardLive(p);
      });
      inp.addEventListener("change", () => saveState());
    });
    grid.querySelectorAll(".dob-edit").forEach(inp => {
      inp.addEventListener("change", (e) => {
        const id = e.target.dataset.id;
        const p = state.players.find(pl => pl.id === id);
        if(!p || !e.target.value) return;
        p.birthDate = e.target.value;
        delete p.dobEstimated;
        saveState(); render();
      });
    });
    grid.querySelectorAll(".vo2-edit").forEach(inp => {
      inp.addEventListener("change", (e) => {
        const id = e.target.dataset.id;
        const p = state.players.find(pl => pl.id === id);
        if(!p) return;
        p.vo2max = e.target.value ? +e.target.value : null;
        saveState(); render();
      });
    });
  }

  function updateCardLive(p){
    const score = overallScore(p);
    document.querySelectorAll(".player-card").forEach(card => {
      const nameEl = card.querySelector(".name");
      if(nameEl && nameEl.textContent === p.name){
        const valEl = card.querySelector(".score-box .val");
        if(valEl) valEl.textContent = score.toFixed(1);
        const mini = card.querySelector(".totem-mini");
        if(mini) mini.innerHTML = totemBlocks(p, "mini");
      }
    });
  }

  function renderMetricsPanel(p){
    const rows = state.metricFields.map(f => {
      const val = p.metrics[f.key] ?? 5;
      return `
        <div class="metric-row">
          <div class="m-label">${escapeHtml(f.label)}</div>
          <input type="range" min="0" max="10" step="1" value="${val}" data-id="${p.id}" data-key="${f.key}">
          <div class="m-val">${val}</div>
        </div>`;
    }).join("");
    const dobRow = `
      <div class="metric-row">
        <div class="m-label">Date of birth</div>
        <input type="date" class="dob-edit" data-id="${p.id}" value="${p.birthDate || ""}">
      </div>`;
    const vo2Row = `
      <div class="metric-row">
        <div class="m-label">VO2 max</div>
        <input type="number" class="vo2-edit" min="10" max="90" step="0.1" placeholder="e.g. 48.5" data-id="${p.id}" value="${p.vo2max ?? ""}">
      </div>`;
    return `<div class="metrics-panel">${dobRow}${vo2Row}${rows}</div>`;
  }

  function renderTopPicks(){
    const sport = currentSport();
    const noun = sportType(sport) === "individual" ? "event" : "position";
    document.getElementById("picksSub").textContent = `best-rated player per ${noun} & age group`;
    const picks = computeTopPicks(sport.id);
    const grid = document.getElementById("picksGrid");
    grid.innerHTML = "";

    const entries = Object.values(picks).sort((a,b) => {
      const posA = sport.positions.indexOf(a.position);
      const posB = sport.positions.indexOf(b.position);
      if(posA !== posB) return posA - posB;
      return a.player.name.localeCompare(b.player.name);
    });

    if(entries.length === 0){
      grid.innerHTML = `<div class="roster-empty" style="grid-column:1/-1;">
        <span class="glyph">${uiIcon("trophy", 34)}</span>
        <h3>No picks yet</h3>
        <div>Rate a few players and Totem will surface the strongest choice per ${noun} and age group.</div>
      </div>`;
      return;
    }

    entries.forEach(({player, score, position}) => {
      const div = document.createElement("div");
      div.className = "pick-card";
      div.innerHTML = `
        <div class="pos">${escapeHtml(position)}</div>
        <div class="pname">${escapeHtml(player.name)}</div>
        <div class="page">${ageGroupForPlayer(player)} · ${formatDob(player.birthDate)}</div>
        <div class="pscore">${score.toFixed(1)}</div>
      `;
      grid.appendChild(div);
    });
  }

  function renderSides(){
    const sport = currentSport();
    const noun = sportType(sport) === "individual" ? "event" : "position";
    document.getElementById("sidesSub").textContent = `players ranked into A–E sides by ${noun} & age group`;
    const groups = ageGroupsForSport(sport.id);
    const tabsEl = document.getElementById("sidesAgeTabs");
    const boardEl = document.getElementById("sidesBoard");

    if(!groups.includes(sidesActiveAgeGroup)){
      sidesActiveAgeGroup = groups[0] || null;
    }

    if(groups.length === 0){
      tabsEl.innerHTML = "";
      document.getElementById("sidesCoachBanner").textContent = "";
      boardEl.innerHTML = `<div class="roster-empty" style="grid-column:1/-1;">
        <span class="glyph">${uiIcon("jersey", 34)}</span>
        <h3>No sides yet</h3>
        <div>Add and rate a few ${escapeHtml(sport.name.toLowerCase())} players and Totem will slot them into A, B, C, D and E sides by ${noun}.</div>
      </div>`;
      return;
    }

    tabsEl.innerHTML = groups.map(g =>
      `<button class="side-tab${g === sidesActiveAgeGroup ? " active" : ""}" data-group="${g}">${g}</button>`
    ).join("");
    tabsEl.querySelectorAll(".side-tab").forEach(btn => {
      btn.addEventListener("click", (e) => {
        sidesActiveAgeGroup = e.target.dataset.group;
        renderSides();
      });
    });

    const coachBanner = document.getElementById("sidesCoachBanner");
    const sidesCoach = coachFor(sport.id, sidesActiveAgeGroup);
    if(sidesCoach){
      coachBanner.className = "coach-banner";
      coachBanner.textContent = `Head coach — ${sidesActiveAgeGroup}: ${sidesCoach.name}${sidesCoach.email ? " (" + sidesCoach.email + ")" : ""}`;
    } else {
      coachBanner.className = "coach-banner empty";
      coachBanner.textContent = `No head coach assigned for ${sidesActiveAgeGroup} yet.`;
    }

    const board = computeSides(sport.id, sidesActiveAgeGroup);
    boardEl.innerHTML = "";

    const sideNames = { A:"1st choice", B:"2nd choice", C:"3rd choice", D:"4th choice", E:"5th choice" };

    SIDE_LETTERS.forEach(letter => {
      const positions = board[letter];
      const groupPositions = positionsForGroup(sport, sidesActiveAgeGroup);
      const slots = groupPositions
        .map(pos => slotEditableHtml(sport.id, sidesActiveAgeGroup, letter, pos, positions[pos]))
        .join("");
      const hasAny = groupPositions.some(pos => resolvedSlot(sport.id, sidesActiveAgeGroup, letter, pos, positions[pos]));
      if(!hasAny) return;

      const card = document.createElement("div");
      card.className = "side-card";
      const seniorLabel = seniorSideLabel(sport, sidesActiveAgeGroup, letter);
      card.innerHTML = `
        <div class="side-head">
          <span class="letter">${seniorLabel || (letter + " Side")}</span>
          <span class="side-name">${seniorLabel ? "" : (sideNames[letter] || "")}</span>
          <button class="print-btn" data-action="print-team" data-sport="${sport.id}" data-group="${escapeHtml(sidesActiveAgeGroup)}" data-side="${letter}" title="Print team sheet" type="button">${uiIcon("printer", 13)}</button>
        </div>
        <div class="side-body">${slots}</div>
        ${benchEditableHtml(sport.id, sidesActiveAgeGroup, letter)}
      `;
      boardEl.appendChild(card);
    });

    wireSlotSelects(boardEl);
    wireBenchSelects(boardEl);
    boardEl.querySelectorAll('[data-action="print-team"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        printTeamSheetFor(btn.dataset.sport, btn.dataset.group, btn.dataset.side, null);
      });
    });

    if(boardEl.children.length === 0){
      boardEl.innerHTML = `<div class="roster-empty" style="grid-column:1/-1;">
        <span class="glyph">${uiIcon("jersey", 34)}</span>
        <h3>No sides yet</h3>
        <div>Rate at least one player per ${noun} in this age group to fill A side.</div>
      </div>`;
    }
  }

  function pad2(n){ return String(n).padStart(2,"0"); }
  function isoDate(d){ return d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate()); }
  function fixturesForSport(sportId){
    return state.fixtures.filter(f => f.sportId === sportId);
  }

  function renderCalendar(){
    const sport = currentSport();
    document.getElementById("calTitle").textContent = calendarDate.toLocaleDateString(undefined,{month:"long", year:"numeric"});
    document.getElementById("fixturesSub").textContent = sportType(sport) === "individual"
      ? "plan matches, book trials, and auto-build the best team per age group"
      : "plan matches & auto-build the best team per age group";

    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const startOffset = firstDay.getDay();
    const daysInMonth = new Date(year, month+1, 0).getDate();

    const fixturesByDate = {};
    fixturesForSport(sport.id).forEach(f => {
      (fixturesByDate[f.date] = fixturesByDate[f.date] || []).push(f);
    });
    const trialsByDate = {};
    if(sportType(sport) === "individual"){
      trialsForSport(sport.id).forEach(t => {
        (trialsByDate[t.date] = trialsByDate[t.date] || []).push(t);
      });
    }
    const rosterPlayers = playersForSport(sport.id);

    const grid = document.getElementById("calendarGrid");
    grid.innerHTML = "";

    ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach(d => {
      const el = document.createElement("div");
      el.className = "cal-dow";
      el.textContent = d;
      grid.appendChild(el);
    });

    for(let i=0;i<startOffset;i++){
      const el = document.createElement("div");
      el.className = "cal-cell empty";
      grid.appendChild(el);
    }

    const todayIso = isoDate(new Date());

    for(let day=1; day<=daysInMonth; day++){
      const iso = isoDate(new Date(year, month, day));
      const cell = document.createElement("div");
      cell.className = "cal-cell" + (iso === todayIso ? " today" : "");
      const dayFixtures = fixturesByDate[iso] || [];
      const dayTrials = trialsByDate[iso] || [];
      const birthdayPlayers = rosterPlayers.filter(p => {
        if(!p.birthDate || p.dobEstimated) return false;
        const d = new Date(p.birthDate + "T00:00:00");
        return (d.getMonth() + 1) === (month + 1) && d.getDate() === day;
      });
      const allDayItems = [
        ...dayFixtures.map(f => ({ type: "fixture", data: f })),
        ...dayTrials.map(t => ({ type: "trial", data: t }))
      ];
      const chipsToShow = allDayItems.length > 3 ? allDayItems.slice(0, 3) : allDayItems;
      const extraCount = allDayItems.length - chipsToShow.length;
      const chipsHtml = chipsToShow.map(item => {
        if(item.type === "fixture") return `<button class="fixture-chip" data-id="${item.data.id}">${escapeHtml(item.data.opponent)}</button>`;
        return `<button class="fixture-chip trial-chip" data-trial-id="${item.data.id}">${uiIcon("flag", 11)} ${escapeHtml(item.data.name)}</button>`;
      }).join("") + (extraCount > 0 ? `<div class="cal-more">+${extraCount} more</div>` : "");

      const birthdayNamesHtml = birthdayPlayers.length > 3
        ? `<div class="cal-birthday-names">${birthdayPlayers.length} birthdays</div>`
        : (birthdayPlayers.length ? `<div class="cal-birthday-names">${birthdayPlayers.map(p => escapeHtml(p.name + ' (' + ageGroupForPlayer(p) + ')')).join(", ")}</div>` : "");

      cell.innerHTML = `
        <div class="cal-daynum">${day}${birthdayPlayers.length ? ` <span class="cal-birthday-flag" title="Birthday: ${escapeHtml(birthdayPlayers.map(p => p.name + ' (' + ageGroupForPlayer(p) + ')').join(', '))}">${uiIcon("gift", 12)}</span>` : ""}</div>
        <div class="cal-chips">
          ${chipsHtml}
        </div>
        ${birthdayNamesHtml}
      `;
      cell.addEventListener("click", (e) => {
        if(e.target.closest(".fixture-chip")) return;
        openAddFixtureModal(iso);
      });
      grid.appendChild(cell);
    }

    grid.querySelectorAll(".fixture-chip:not(.trial-chip)").forEach(chip => {
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        openFixtureId = chip.dataset.id;
        renderFixtureList(); renderFixtureDetail();
        document.getElementById("fxcard-" + openFixtureId)?.scrollIntoView({behavior:"smooth", block:"nearest"});
      });
    });
    grid.querySelectorAll(".trial-chip").forEach(chip => {
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        openTrialId = chip.dataset.trialId;
        openFixtureId = null;
        renderFixtureList(); renderFixtureDetail();
        document.getElementById("trcard-" + openTrialId)?.scrollIntoView({behavior:"smooth", block:"nearest"});
      });
    });
  }

  function renderFixtureList(){
    const sport = currentSport();
    const isIndividual = sportType(sport) === "individual";
    const entries = [
      ...fixturesForSport(sport.id).map(f => ({ kind:"fixture", date:f.date, item:f })),
      ...(isIndividual ? trialsForSport(sport.id).map(t => ({ kind:"trial", date:t.date, item:t })) : [])
    ].sort((a,b) => a.date.localeCompare(b.date));
    const el = document.getElementById("fixtureList");

    if(entries.length === 0){
      el.innerHTML = `<div class="roster-empty">
        <span class="glyph">${uiIcon("calendar", 34)}</span>
        <h3>No fixtures yet</h3>
        <div>Add a fixture on the calendar above and Totem will build the best team per age group.${isIndividual ? " Booking a time trial uses the same button." : ""}</div>
      </div>`;
      return;
    }

    el.innerHTML = entries.map(entry => {
      const dateLabel = new Date(entry.date + "T00:00:00").toLocaleDateString(undefined,{weekday:"short", day:"numeric", month:"short"});
      if(entry.kind === "trial"){
        const t = entry.item;
        return `
          <div class="fixture-card trial-card" id="trcard-${t.id}">
            <div class="fixture-card-main">
              <div class="fixture-date">${dateLabel}</div>
              <div class="fixture-opp">${uiIcon("flag", 14)} ${escapeHtml(t.name)}</div>
              ${t.venue ? `<div class="fixture-venue">${venueLineHtml(t.venue, false)}</div>` : ""}
            </div>
            <div class="fixture-card-actions">
              <button class="btn btn-ghost btn-small" data-action="view-trial" data-id="${t.id}">${openTrialId === t.id ? "Hide results" : "View results"}</button>
              <button class="btn btn-ghost btn-small" data-action="edit-trial" data-id="${t.id}">Edit</button>
              <button class="btn btn-danger btn-small" data-action="delete-trial" data-id="${t.id}">Remove</button>
            </div>
          </div>
        `;
      }
      const f = entry.item;
      return `
        <div class="fixture-card" id="fxcard-${f.id}">
          <div class="fixture-card-main">
            <div class="fixture-date">${dateLabel}</div>
            <div class="fixture-opp">vs ${escapeHtml(f.opponent)}</div>
            ${f.venue ? `<div class="fixture-venue">${venueLineHtml(f.venue, false)}</div>` : ""}
          </div>
          <div class="fixture-card-actions">
            <button class="btn btn-ghost btn-small" data-action="view-fixture" data-id="${f.id}">${openFixtureId === f.id ? "Hide teams" : "View teams"}</button>
            <button class="btn btn-ghost btn-small" data-action="edit-fixture" data-id="${f.id}">Edit</button>
            <button class="btn btn-danger btn-small" data-action="delete-fixture" data-id="${f.id}">Remove</button>
          </div>
        </div>
      `;
    }).join("");

    el.querySelectorAll(".fx-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        if(chip.dataset.trial) openTrialResultModal(chip.dataset.trial, chip.dataset.group);
        else openResultModal(chip.dataset.fixture, chip.dataset.group, chip.dataset.side);
      });
    });
    el.querySelectorAll('[data-action="view-fixture"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        const id = e.target.dataset.id;
        openFixtureId = openFixtureId === id ? null : id;
        openTrialId = null;
        renderFixtureList(); renderFixtureDetail();
      });
    });
    el.querySelectorAll('[data-action="delete-fixture"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        const id = e.target.dataset.id;
        const f = state.fixtures.find(x => x.id === id);
        if(f && confirm(`Remove the fixture vs ${f.opponent}?`)){
          state.fixtures = state.fixtures.filter(x => x.id !== id);
          if(openFixtureId === id) openFixtureId = null;
          saveState();
          renderCalendar(); renderFixtureList(); renderFixtureDetail();
        }
      });
    });
    el.querySelectorAll('[data-action="edit-fixture"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const f = state.fixtures.find(x => x.id === btn.dataset.id);
        if(f) openAddFixtureModal(f, "fixture");
      });
    });
    el.querySelectorAll('[data-action="view-trial"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        const id = e.target.dataset.id;
        openTrialId = openTrialId === id ? null : id;
        openFixtureId = null;
        renderFixtureList(); renderFixtureDetail();
      });
    });
    el.querySelectorAll('[data-action="delete-trial"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        const id = e.target.dataset.id;
        const t = state.trials.find(x => x.id === id);
        if(t && confirm(`Remove the trial "${t.name}"? Any recorded results for it will also be removed.`)){
          state.trials = state.trials.filter(x => x.id !== id);
          state.trialResults = state.trialResults.filter(r => r.trialId !== id);
          if(openTrialId === id) openTrialId = null;
          saveState();
          renderCalendar(); renderFixtureList(); renderFixtureDetail(); renderSides();
        }
      });
    });
    el.querySelectorAll('[data-action="edit-trial"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const t = state.trials.find(x => x.id === btn.dataset.id);
        if(t) openAddFixtureModal(t, "trial");
      });
    });
  }

  function renderFixtureDetail(){
    const el = document.getElementById("fixtureDetail");

    if(openTrialId){
      const t = state.trials.find(x => x.id === openTrialId);
      if(!t){ el.innerHTML = ""; return; }
      const dateLabel = new Date(t.date + "T00:00:00").toLocaleDateString(undefined,{weekday:"long", day:"numeric", month:"long", year:"numeric"});

      const groupsHtml = t.ageGroups.map(group => {
        const result = trialResultFor(t.id, group);
        const rows = result && result.entries.length ? result.entries.map(en => {
          const player = state.players.find(p => p.id === en.playerId);
          return `<div class="result-line">
            <span class="result-line-name">${escapeHtml(player ? player.name : "Unknown")}</span>
            <span class="result-line-meta">${escapeHtml(en.event)}</span>
            <span class="result-line-time">${escapeHtml(en.time)}${en.place ? " · " + ordinal(en.place) : ""}</span>
          </div>`;
        }).join("") : `<div class="dash-empty">No results captured yet.</div>`;

        return `
          <div class="side-card">
            <div class="side-head">
              <span class="letter">${escapeHtml(group)}</span>
              <span class="side-name">Trial results</span>
            </div>
            <div class="side-body" style="padding:12px 14px;">
              <div class="result-lines">${rows}</div>
            </div>
            <div style="padding:0 14px 14px;">
              <button class="btn btn-ghost btn-small" data-action="edit-trial-result" data-trial="${t.id}" data-group="${escapeHtml(group)}">${result ? "Edit results" : "+ Capture results"}</button>
            </div>
          </div>
        `;
      }).join("");

      el.innerHTML = `
        <div class="section-title">
          <h2>${uiIcon("flag", 18)} ${escapeHtml(t.name)}</h2>
          <span class="sub">${dateLabel}${venueLineHtml(t.venue)}</span>
        </div>
        <div class="sides-board">${groupsHtml}</div>
      `;
      el.querySelectorAll('[data-action="edit-trial-result"]').forEach(btn => {
        btn.addEventListener("click", () => openTrialResultModal(btn.dataset.trial, btn.dataset.group));
      });
      return;
    }

    if(!openFixtureId){ el.innerHTML = ""; return; }
    const f = state.fixtures.find(x => x.id === openFixtureId);
    if(!f){ el.innerHTML = ""; return; }
    const sport = state.sports.find(s => s.id === f.sportId) || currentSport();
    const dateLabel = new Date(f.date + "T00:00:00").toLocaleDateString(undefined,{weekday:"long", day:"numeric", month:"long", year:"numeric"});
    const excludeIds = unavailableIdsFor(f.id);

    const groupsHtml = f.entries.map(({ ageGroup: group, side }) => {
      const board = computeSides(sport.id, group, excludeIds);
      const positions = board[side] || {};
      const groupPositions = positionsForGroup(sport, group);
      const hasAny = groupPositions.some(pos => resolvedSlot(sport.id, group, side, pos, positions[pos]));
      const groupCoach = coachFor(sport.id, group, side);
      const slots = groupPositions
        .map(pos => slotEditableHtml(sport.id, group, side, pos, positions[pos]))
        .join("");

      const seniorLabel = seniorSideLabel(sport, group, side);
      const teamSheet = `
        <div class="side-card">
          <div class="side-head">
            <span class="letter">${seniorLabel || (escapeHtml(group) + " · " + side)}</span>
            <span class="side-name">${groupCoach ? "Coach: " + escapeHtml(groupCoach.name) : "Best available team"}</span>
            <button class="print-btn" data-action="print-team" data-sport="${sport.id}" data-group="${escapeHtml(group)}" data-side="${side}" title="Print team sheet" type="button">${uiIcon("printer", 13)}</button>
          </div>
          <div class="side-body">${hasAny ? slots : `<div class="roster-empty" style="padding:24px 14px;"><div>No rated players in this age group yet.</div></div>`}</div>
          ${hasAny ? benchEditableHtml(sport.id, group, side) : ""}
        </div>
      `;

      const result = resultFor(f.id, group, side);
      const resultPanel = renderResultPanel(sport, f, group, side, result);

      return `<div class="fixture-group-block">${teamSheet}${resultPanel}</div>`;
    }).join("");

    const uniqueGroups = [...new Set(f.entries.map(en => en.ageGroup))];
    const availabilityHtml = uniqueGroups.map(group => availabilityBlockHtml(f.id, sport.id, group)).join("");

    el.innerHTML = `
      <div class="section-title">
        <h2>vs ${escapeHtml(f.opponent)}</h2>
        <span class="sub">${dateLabel}${venueLineHtml(f.venue)}</span>
      </div>
      <div class="sides-board">${groupsHtml}</div>
      ${availabilityHtml}
    `;

    wireSlotSelects(el);
    wireBenchSelects(el);
    wireAvailabilityToggles(el);
    el.querySelectorAll('[data-action="capture-result"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        openResultModal(btn.dataset.fixture, btn.dataset.group, btn.dataset.side);
      });
    });
    el.querySelectorAll('[data-action="print-team"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        printTeamSheetFor(btn.dataset.sport, btn.dataset.group, btn.dataset.side, f);
      });
    });
    el.querySelectorAll('[data-action="print-result"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        printFixtureResult(btn.dataset.sport, btn.dataset.group, btn.dataset.side, f);
      });
    });
  }

  // ---------- trials (individual sports only) ----------
  let openTrialId = null;
  let trialResultDraft = null;

  function trialsForSport(sportId){
    return state.trials.filter(t => t.sportId === sportId);
  }
  function trialResultFor(trialId, group){
    return state.trialResults.find(r => r.trialId === trialId && groupsMatch(r.ageGroup, group));
  }
  // Fastest recorded trial time for a player in a specific event/age group,
  // across every trial captured for that sport — used to rank individual-sport
  // sides by actual performance instead of subjective ratings, once available.
  function bestTrialTime(sportId, playerId, event, group){
    let best = null; // { seconds, time }
    state.trialResults
      .filter(r => r.sportId === sportId && groupsMatch(r.ageGroup, group))
      .forEach(r => {
        (r.entries || []).forEach(en => {
          if(en.playerId !== playerId || en.event !== event || !en.time) return;
          const secs = parseTimeToSeconds(en.time);
          if(!best || secs < best.seconds) best = { seconds: secs, time: en.time };
        });
      });
    return best;
  }
  function syncTrialDraftFromDom(){
    const rows = document.querySelectorAll("#trialResultEntries .result-row");
    trialResultDraft.entries = Array.from(rows).map(row => ({
      playerId: row.querySelector(".entry-player").value || null,
      event: row.querySelector(".entry-event").value,
      time: row.querySelector(".entry-time").value.trim(),
      place: row.querySelector(".entry-place").value ? +row.querySelector(".entry-place").value : null
    }));
    const notesInp = document.getElementById("trialResultNotes");
    trialResultDraft.notes = notesInp ? notesInp.value.trim() : "";
  }

  function renderTrialResultModalBody(){
    const body = document.getElementById("trialResultModalBody");
    const sport = state.sports.find(s => s.id === trialResultDraft.sportId);
    const players = eligiblePlayers(sport.id, trialResultDraft.ageGroup);

    body.innerHTML = `
      <div class="result-entries" id="trialResultEntries">
        ${trialResultDraft.entries.map((en, idx) => resultEntryRow(en, idx, players, sport, trialResultDraft.ageGroup)).join("")}
      </div>
      <button class="btn btn-ghost btn-small" id="btnAddTrialEntry" type="button">+ Add athlete result</button>
      <div class="field" style="margin-top:14px;">
        <label>Notes (optional)</label>
        <input type="text" id="trialResultNotes" value="${escapeHtml(trialResultDraft.notes || "")}" placeholder="e.g. Wind-assisted times excluded">
      </div>
    `;

    document.getElementById("btnAddTrialEntry").addEventListener("click", () => {
      syncTrialDraftFromDom();
      trialResultDraft.entries.push({ playerId:null, event:positionsForGroup(sport, trialResultDraft.ageGroup)[0], time:"", place:null });
      renderTrialResultModalBody();
    });
    document.querySelectorAll('#trialResultEntries [data-action="remove-entry"]').forEach(btn => {
      btn.addEventListener("click", () => {
        syncTrialDraftFromDom();
        trialResultDraft.entries.splice(+btn.dataset.idx, 1);
        renderTrialResultModalBody();
      });
    });
    document.querySelectorAll("#trialResultEntries .entry-player").forEach(sel => {
      sel.addEventListener("change", (e) => {
        const player = players.find(p => p.id === e.target.value);
        if(!player) return;
        const row = e.target.closest(".result-row");
        const eventSel = row.querySelector(".entry-event");
        if(!eventSel) return;
        const validEvents = positionsForGroup(sport, trialResultDraft.ageGroup);
        const ownEvents = playerPositions(player).filter(ev => validEvents.includes(ev));
        const optionsList = ownEvents.length ? ownEvents : validEvents;
        eventSel.innerHTML = optionsList.map(pos => `<option value="${escapeHtml(pos)}">${escapeHtml(pos)}</option>`).join("");
      });
    });
  }

  function openTrialResultModal(trialId, group){
    const t = state.trials.find(x => x.id === trialId);
    if(!t) return;
    const sport = state.sports.find(s => s.id === t.sportId);
    const existing = trialResultFor(trialId, group);

    trialResultDraft = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: null, trialId, sportId: sport.id, ageGroup: group, entries: [], notes: ""
    };
    if(!existing){
      trialResultDraft.entries.push({ playerId:null, event:positionsForGroup(sport, group)[0], time:"", place:null });
    }

    document.getElementById("trialResultModalTitle").textContent = `${sport.name} · ${group} — ${t.name}`;
    renderTrialResultModalBody();
    document.getElementById("trialResultModal").classList.add("open");
  }
  document.getElementById("cancelTrialResult").addEventListener("click", () => document.getElementById("trialResultModal").classList.remove("open"));
  document.getElementById("trialResultModal").addEventListener("click", (e) => { if(e.target.id === "trialResultModal") document.getElementById("trialResultModal").classList.remove("open"); });
  document.getElementById("confirmTrialResult").addEventListener("click", () => {
    syncTrialDraftFromDom();
    trialResultDraft.entries = trialResultDraft.entries.filter(en => en.playerId && en.time);
    if(trialResultDraft.entries.length === 0){ alert("Add at least one athlete result with a time."); return; }

    if(trialResultDraft.id){
      const idx = state.trialResults.findIndex(r => r.id === trialResultDraft.id);
      state.trialResults[idx] = trialResultDraft;
    } else {
      trialResultDraft.id = uid();
      state.trialResults.push(trialResultDraft);
    }
    document.getElementById("trialResultModal").classList.remove("open");
    saveState();
    renderFixtureList(); renderFixtureDetail(); renderSides();
    showToast(`Trial results saved for ${trialResultDraft.ageGroup} — team rankings updated.`);
  });

  // ---------- results ----------
  // ---------- player availability (per fixture, injury/illness) ----------
  // Marking someone unavailable for one specific fixture excludes them from
  // that fixture's auto-selected team (they naturally get replaced by the next
  // best-ranked player) without touching their ratings or any other fixture.
  function unavailableIdsFor(fixtureId){
    return state.unavailable[fixtureId] || [];
  }
  function availabilityBlockHtml(fixtureId, sportId, group){
    const players = eligiblePlayersForSwap(sportId, group);
    if(players.length === 0) return "";
    const unavailable = new Set(unavailableIdsFor(fixtureId));
    const rows = players.map(p => `
      <label class="avail-row${unavailable.has(p.id) ? " is-unavailable" : ""}">
        <input type="checkbox" class="avail-toggle" data-fixture="${fixtureId}" data-player="${p.id}" ${unavailable.has(p.id) ? "checked" : ""}>
        <span>${escapeHtml(p.name)}</span>
      </label>
    `).join("");
    return `
      <div class="panel availability-panel">
        <div class="availability-head">Availability <span class="bench-sub">tick anyone unavailable for this fixture — they'll be skipped automatically</span></div>
        <div class="availability-list">${rows}</div>
      </div>
    `;
  }
  function wireAvailabilityToggles(container){
    container.querySelectorAll(".avail-toggle").forEach(cb => {
      cb.addEventListener("change", (e) => {
        const { fixture, player } = e.target.dataset;
        const list = new Set(state.unavailable[fixture] || []);
        if(e.target.checked) list.add(player); else list.delete(player);
        state.unavailable[fixture] = [...list];
        saveState();
        renderFixtureDetail();
      });
    });
  }

  function resultFor(fixtureId, group, side){
    return state.results.find(r => r.fixtureId === fixtureId && groupsMatch(r.ageGroup, group) && r.side === side);
  }
  function eligiblePlayers(sportId, group){
    return state.players.filter(p => p.sportId === sportId && ageGroupForPlayer(p) === group);
  }
  function parseTimeToSeconds(t){
    if(!t) return Infinity;
    const parts = String(t).split(":").map(Number);
    if(parts.some(isNaN)) return Infinity;
    if(parts.length === 1) return parts[0];
    if(parts.length === 2) return parts[0]*60 + parts[1];
    if(parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
    return Infinity;
  }
  function ordinal(n){
    const s = ["th","st","nd","rd"], v = n % 100;
    return n + (s[(v-20)%10] || s[v] || s[0]);
  }

  function renderResultPanel(sport, f, group, side, result){
    if(!result){
      return `<div class="panel result-panel result-empty">
        <div class="result-empty-msg">No result captured yet.</div>
        <button class="btn btn-ghost btn-small" data-action="capture-result" data-fixture="${f.id}" data-group="${escapeHtml(group)}" data-side="${side}">+ Capture result</button>
      </div>`;
    }

    if(sportType(sport) === "individual"){
      const rows = result.entries.map(en => {
        const player = state.players.find(p => p.id === en.playerId);
        return `<div class="result-line">
          <span class="result-line-name">${escapeHtml(player ? player.name : "Unknown")}</span>
          <span class="result-line-meta">${escapeHtml(en.event)}</span>
          <span class="result-line-time">${escapeHtml(en.time)}${en.place ? " · " + ordinal(en.place) : ""}</span>
        </div>`;
      }).join("");
      return `<div class="panel result-panel">
        <div class="result-lines">${rows || '<div class="dash-empty">No entries logged.</div>'}</div>
        ${result.notes ? `<div class="result-notes">${escapeHtml(result.notes)}</div>` : ""}
        <div style="display:flex; gap:8px;">
          <button class="btn btn-ghost btn-small" data-action="capture-result" data-fixture="${f.id}" data-group="${escapeHtml(group)}" data-side="${side}">Edit result</button>
          <button class="btn btn-ghost btn-small" data-action="print-result" data-sport="${sport.id}" data-group="${escapeHtml(group)}" data-side="${side}" data-fixture="${f.id}">${uiIcon("printer", 13)} Print result</button>
        </div>
      </div>`;
    }

    const outcome = result.ourScore > result.theirScore ? "win" : result.ourScore < result.theirScore ? "loss" : "draw";
    const outcomeLabel = outcome === "win" ? "WON" : outcome === "loss" ? "LOST" : "DRAWN";
    const scorersHtml = (result.scorers || []).map(sc => {
      const player = state.players.find(p => p.id === sc.playerId);
      return `<span class="scorer-chip">${escapeHtml(player ? player.name : "Unknown")}${sc.goals > 1 ? " ×" + sc.goals : ""}</span>`;
    }).join("");

    return `<div class="panel result-panel outcome-${outcome}">
      <div class="result-score-row">
        <span class="result-outcome">${outcomeLabel}</span>
        <span class="result-score">${result.ourScore} – ${result.theirScore}</span>
      </div>
      ${scorersHtml ? `<div class="result-scorers">${scorersHtml}</div>` : ""}
      ${result.notes ? `<div class="result-notes">${escapeHtml(result.notes)}</div>` : ""}
      <div style="display:flex; gap:8px;">
        <button class="btn btn-ghost btn-small" data-action="capture-result" data-fixture="${f.id}" data-group="${escapeHtml(group)}" data-side="${side}">Edit result</button>
        <button class="btn btn-ghost btn-small" data-action="print-result" data-sport="${sport.id}" data-group="${escapeHtml(group)}" data-side="${side}" data-fixture="${f.id}">${uiIcon("printer", 13)} Print result</button>
      </div>
    </div>`;
  }

  function scorerRow(sc, idx, players){
    return `
      <div class="result-row" data-idx="${idx}">
        <select class="scorer-player">
          <option value="">Select player…</option>
          ${players.map(p => `<option value="${p.id}" ${sc.playerId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
        </select>
        <input type="number" class="scorer-goals" min="1" value="${sc.goals || 1}" style="width:70px;">
        <button class="btn btn-danger btn-small" data-action="remove-scorer" data-idx="${idx}" type="button">✕</button>
      </div>
    `;
  }

  function resultEntryRow(en, idx, players, sport, group){
    return `
      <div class="result-row" data-idx="${idx}">
        <select class="entry-player">
          <option value="">Select swimmer…</option>
          ${players.map(p => `<option value="${p.id}" ${en.playerId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
        </select>
        <select class="entry-event">
          ${positionsForGroup(sport, group).map(pos => `<option value="${escapeHtml(pos)}" ${en.event === pos ? "selected" : ""}>${escapeHtml(pos)}</option>`).join("")}
        </select>
        <input type="text" class="entry-time" placeholder="mm:ss.ms" value="${escapeHtml(en.time || "")}" style="width:100px;">
        <input type="number" class="entry-place" placeholder="place" min="1" value="${en.place ?? ""}" style="width:70px;">
        <button class="btn btn-danger btn-small" data-action="remove-entry" data-idx="${idx}" type="button">✕</button>
      </div>
    `;
  }

  function syncDraftFromDom(sport){
    if(sportType(sport) === "individual"){
      const rows = document.querySelectorAll("#resultEntries .result-row");
      resultDraft.entries = Array.from(rows).map(row => ({
        playerId: row.querySelector(".entry-player").value || null,
        event: row.querySelector(".entry-event").value,
        time: row.querySelector(".entry-time").value.trim(),
        place: row.querySelector(".entry-place").value ? +row.querySelector(".entry-place").value : null
      }));
    } else {
      const rows = document.querySelectorAll("#resultScorers .result-row");
      resultDraft.scorers = Array.from(rows).map(row => ({
        playerId: row.querySelector(".scorer-player").value || null,
        goals: +row.querySelector(".scorer-goals").value || 0
      }));
      resultDraft.ourScore = document.getElementById("resultOurScore").value;
      resultDraft.theirScore = document.getElementById("resultTheirScore").value;
    }
    const notesInp = document.getElementById("resultNotes");
    resultDraft.notes = notesInp ? notesInp.value.trim() : "";
  }

  function wireResultModalEvents(players, sport){
    const isIndividual = sportType(sport) === "individual";
    const addBtn = document.getElementById(isIndividual ? "btnAddEntry" : "btnAddScorer");
    if(addBtn){
      addBtn.addEventListener("click", () => {
        syncDraftFromDom(sport);
        if(isIndividual) resultDraft.entries.push({ playerId:null, event:positionsForGroup(sport, resultDraft.ageGroup)[0], time:"", place:null });
        else resultDraft.scorers.push({ playerId:null, goals:1 });
        renderResultModalBody();
      });
    }
    document.querySelectorAll('[data-action="remove-scorer"]').forEach(btn => {
      btn.addEventListener("click", () => {
        syncDraftFromDom(sport);
        resultDraft.scorers.splice(+btn.dataset.idx, 1);
        renderResultModalBody();
      });
    });
    document.querySelectorAll('[data-action="remove-entry"]').forEach(btn => {
      btn.addEventListener("click", () => {
        syncDraftFromDom(sport);
        resultDraft.entries.splice(+btn.dataset.idx, 1);
        renderResultModalBody();
      });
    });
    // convenience: picking an athlete narrows the event list to their own registered events
    document.querySelectorAll("#resultEntries .entry-player").forEach(sel => {
      sel.addEventListener("change", (e) => {
        const player = players.find(p => p.id === e.target.value);
        if(!player) return;
        const row = e.target.closest(".result-row");
        const eventSel = row.querySelector(".entry-event");
        if(!eventSel) return;
        const validEvents = positionsForGroup(sport, resultDraft.ageGroup);
        const ownEvents = playerPositions(player).filter(ev => validEvents.includes(ev));
        const optionsList = ownEvents.length ? ownEvents : validEvents;
        eventSel.innerHTML = optionsList.map(pos => `<option value="${escapeHtml(pos)}">${escapeHtml(pos)}</option>`).join("");
      });
    });
  }

  function renderResultModalBody(){
    const body = document.getElementById("resultModalBody");
    const sport = state.sports.find(s => s.id === resultDraft.sportId);
    const players = eligiblePlayers(sport.id, resultDraft.ageGroup);

    if(sportType(sport) === "individual"){
      body.innerHTML = `
        <div class="result-entries" id="resultEntries">
          ${resultDraft.entries.map((en, idx) => resultEntryRow(en, idx, players, sport, resultDraft.ageGroup)).join("")}
        </div>
        <button class="btn btn-ghost btn-small" id="btnAddEntry" type="button">+ Add swimmer result</button>
        <div class="field" style="margin-top:14px;">
          <label>Notes (optional)</label>
          <input type="text" id="resultNotes" value="${escapeHtml(resultDraft.notes || "")}" placeholder="e.g. Gala at Westville Pool">
        </div>
      `;
    } else {
      body.innerHTML = `
        <div style="display:flex; gap:12px;">
          <div class="field">
            <label>Our score</label>
            <input type="number" id="resultOurScore" value="${resultDraft.ourScore ?? ""}" style="width:90px;">
          </div>
          <div class="field">
            <label>Their score</label>
            <input type="number" id="resultTheirScore" value="${resultDraft.theirScore ?? ""}" style="width:90px;">
          </div>
        </div>
        <div class="section-title" style="margin:12px 0 8px;">
          <h2 style="font-size:16px;">Scorers</h2>
        </div>
        <div class="result-entries" id="resultScorers">
          ${resultDraft.scorers.map((sc, idx) => scorerRow(sc, idx, players)).join("")}
        </div>
        <button class="btn btn-ghost btn-small" id="btnAddScorer" type="button">+ Add scorer</button>
        <div class="field" style="margin-top:14px;">
          <label>Notes (optional)</label>
          <input type="text" id="resultNotes" value="${escapeHtml(resultDraft.notes || "")}" placeholder="e.g. Player of the match: ...">
        </div>
      `;
    }
    wireResultModalEvents(players, sport);
  }

  function openResultModal(fixtureId, group, side){
    const f = state.fixtures.find(x => x.id === fixtureId);
    if(!f) return;
    const sport = state.sports.find(s => s.id === f.sportId);
    const existing = resultFor(fixtureId, group, side);

    resultDraft = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: null, fixtureId, ageGroup: group, side, sportId: sport.id,
      ourScore: "", theirScore: "", scorers: [], entries: [], notes: ""
    };

    // start new captures with one blank row so there's no extra click before typing
    if(!existing){
      if(sportType(sport) === "individual") resultDraft.entries.push({ playerId:null, event:positionsForGroup(sport, group)[0], time:"", place:null });
      else resultDraft.scorers.push({ playerId:null, goals:1 });
    }

    document.getElementById("resultModalTitle").textContent = `${sport.name} · ${seniorSideLabel(sport, group, side) || (group + " (" + side + " side)")} vs ${f.opponent}`;
    renderResultModalBody();
    document.getElementById("resultModal").classList.add("open");
  }

  document.getElementById("cancelResult").addEventListener("click", () => {
    document.getElementById("resultModal").classList.remove("open");
  });
  document.getElementById("resultModal").addEventListener("click", (e) => {
    if(e.target.id === "resultModal") document.getElementById("resultModal").classList.remove("open");
  });
  document.getElementById("confirmResult").addEventListener("click", async () => {
    const sport = state.sports.find(s => s.id === resultDraft.sportId);
    syncDraftFromDom(sport);

    if(sportType(sport) === "individual"){
      resultDraft.entries = resultDraft.entries.filter(en => en.playerId && en.time);
      if(resultDraft.entries.length === 0){ alert("Add at least one swimmer result with a time."); return; }
    } else {
      if(resultDraft.ourScore === "" || resultDraft.theirScore === ""){ alert("Enter both scores."); return; }
      resultDraft.ourScore = +resultDraft.ourScore;
      resultDraft.theirScore = +resultDraft.theirScore;
      resultDraft.scorers = resultDraft.scorers.filter(sc => sc.playerId);
    }

    if(resultDraft.id){
      const idx = state.results.findIndex(r => r.id === resultDraft.id);
      state.results[idx] = resultDraft;
    } else {
      resultDraft.id = uid();
      state.results.push(resultDraft);
    }
    document.getElementById("resultModal").classList.remove("open");
    saveState();
    renderFixtureList();
    renderFixtureDetail();
    renderDashboard();
    renderCoachLeaderboard();

    let warningPrefix = "";
    if(sportType(sport) !== "individual" && resultDraft.scorers.length > 0){
      const scorerTotal = resultDraft.scorers.reduce((sum, sc) => sum + (sc.goals || 0), 0);
      if(scorerTotal !== resultDraft.ourScore){
        warningPrefix = `Note: scorer goals (${scorerTotal}) don't match the score (${resultDraft.ourScore}). `;
      }
    }
    const fixture = state.fixtures.find(x => x.id === resultDraft.fixtureId);
    sendResultNotification(sport, fixture, resultDraft, warningPrefix);
  });

  // ---------- results & stats dashboard ----------
  function resultsForSportGroup(sportId, group){
    return state.results
      .filter(r => r.sportId === sportId && r.ageGroup === group)
      .map(r => ({ ...r, fixture: state.fixtures.find(f => f.id === r.fixtureId) }))
      .filter(r => r.fixture)
      .sort((a,b) => b.fixture.date.localeCompare(a.fixture.date));
  }

  function renderTeamDashboard(results){
    const played = results.length;
    let won = 0, drawn = 0, lost = 0, gf = 0, ga = 0;
    const scorerTotals = {};

    results.forEach(r => {
      gf += r.ourScore; ga += r.theirScore;
      if(r.ourScore > r.theirScore) won++;
      else if(r.ourScore < r.theirScore) lost++;
      else drawn++;
      (r.scorers || []).forEach(sc => {
        if(!sc.playerId) return;
        scorerTotals[sc.playerId] = (scorerTotals[sc.playerId] || 0) + (sc.goals || 0);
      });
    });

    const winPct = played ? Math.round((won/played)*100) : 0;

    const scorerRows = Object.entries(scorerTotals)
      .sort((a,b) => b[1]-a[1])
      .slice(0, 10)
      .map(([playerId, goals]) => {
        const player = state.players.find(p => p.id === playerId);
        return `<div class="leader-row"><span>${escapeHtml(player ? player.name : "Unknown")}</span><span class="mono">${goals}</span></div>`;
      }).join("");

    const resultRows = results.map(r => {
      const outcome = r.ourScore > r.theirScore ? "win" : r.ourScore < r.theirScore ? "loss" : "draw";
      const label = outcome === "win" ? "W" : outcome === "loss" ? "L" : "D";
      const dateLabel = new Date(r.fixture.date + "T00:00:00").toLocaleDateString(undefined,{day:"numeric", month:"short"});
      return `<div class="result-history-row outcome-${outcome}">
        <span class="rh-badge">${label}</span>
        <span class="rh-date">${dateLabel}</span>
        <span class="rh-opp">vs ${escapeHtml(r.fixture.opponent)}</span>
        <span class="rh-score mono">${r.ourScore}–${r.theirScore}</span>
      </div>`;
    }).join("");

    return `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-val">${played}</div><div class="stat-lbl">Played</div></div>
        <div class="stat-card"><div class="stat-val">${won}</div><div class="stat-lbl">Won</div></div>
        <div class="stat-card"><div class="stat-val">${drawn}</div><div class="stat-lbl">Drawn</div></div>
        <div class="stat-card"><div class="stat-val">${lost}</div><div class="stat-lbl">Lost</div></div>
        <div class="stat-card"><div class="stat-val">${gf}–${ga}</div><div class="stat-lbl">Goals F–A</div></div>
        <div class="stat-card"><div class="stat-val">${winPct}%</div><div class="stat-lbl">Win rate</div></div>
      </div>
      <div class="dash-columns">
        <div>
          <h3 class="dash-subhead">Top scorers</h3>
          ${scorerRows ? `<div class="leader-list">${scorerRows}</div>` : `<div class="dash-empty">No scorers logged yet.</div>`}
        </div>
        <div>
          <h3 class="dash-subhead">Recent results</h3>
          ${resultRows ? `<div class="result-history">${resultRows}</div>` : `<div class="dash-empty">No results captured yet.</div>`}
        </div>
      </div>
    `;
  }

  function renderIndividualDashboard(results){
    const bests = {};
    let totalEntries = 0, podiums = 0;

    results.forEach(r => {
      (r.entries || []).forEach(en => {
        if(!en.playerId || !en.time) return;
        totalEntries++;
        if(en.place && en.place <= 3) podiums++;
        const key = en.playerId + "|" + en.event;
        const secs = parseTimeToSeconds(en.time);
        if(!bests[key] || secs < bests[key].seconds){
          bests[key] = { time: en.time, seconds: secs, event: en.event, playerId: en.playerId };
        }
      });
    });

    const bestRows = Object.values(bests)
      .sort((a,b) => {
        const pa = state.players.find(p => p.id === a.playerId)?.name || "";
        const pb = state.players.find(p => p.id === b.playerId)?.name || "";
        return pa.localeCompare(pb) || a.event.localeCompare(b.event);
      })
      .map(b => {
        const player = state.players.find(p => p.id === b.playerId);
        return `<div class="leader-row"><span>${escapeHtml(player ? player.name : "Unknown")} · ${escapeHtml(b.event)}</span><span class="mono">${escapeHtml(b.time)}</span></div>`;
      }).join("");

    const resultRows = results.map(r => {
      const dateLabel = new Date(r.fixture.date + "T00:00:00").toLocaleDateString(undefined,{day:"numeric", month:"short"});
      return `<div class="result-history-row">
        <span class="rh-date">${dateLabel}</span>
        <span class="rh-opp">${escapeHtml(r.fixture.opponent)}</span>
        <span class="rh-score mono">${(r.entries||[]).length} ${(r.entries||[]).length === 1 ? "entry" : "entries"}</span>
      </div>`;
    }).join("");

    return `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-val">${results.length}</div><div class="stat-lbl">Galas</div></div>
        <div class="stat-card"><div class="stat-val">${totalEntries}</div><div class="stat-lbl">Entries</div></div>
        <div class="stat-card"><div class="stat-val">${podiums}</div><div class="stat-lbl">Podiums</div></div>
      </div>
      <div class="dash-columns">
        <div>
          <h3 class="dash-subhead">Personal bests</h3>
          ${bestRows ? `<div class="leader-list">${bestRows}</div>` : `<div class="dash-empty">No times logged yet.</div>`}
        </div>
        <div>
          <h3 class="dash-subhead">Gala history</h3>
          ${resultRows ? `<div class="result-history">${resultRows}</div>` : `<div class="dash-empty">No galas captured yet.</div>`}
        </div>
      </div>
    `;
  }

  function renderDashboard(){
    const sport = currentSport();
    const groups = ageGroupsForSport(sport.id);
    const tabsEl = document.getElementById("dashAgeTabs");
    const bodyEl = document.getElementById("dashBody");

    if(!groups.includes(dashboardAgeGroup)){
      dashboardAgeGroup = groups[0] || null;
    }

    if(groups.length === 0){
      tabsEl.innerHTML = "";
      bodyEl.innerHTML = `<div class="roster-empty">
        <span class="glyph">${uiIcon("barChart", 34)}</span>
        <h3>No stats yet</h3>
        <div>Add players and capture a few fixture results to see season stats here.</div>
      </div>`;
      return;
    }

    tabsEl.innerHTML = groups.map(g => `<button class="side-tab${g === dashboardAgeGroup ? " active" : ""}" data-group="${g}">${g}</button>`).join("");
    tabsEl.querySelectorAll(".side-tab").forEach(btn => {
      btn.addEventListener("click", (e) => { dashboardAgeGroup = e.target.dataset.group; renderDashboard(); });
    });

    const results = resultsForSportGroup(sport.id, dashboardAgeGroup);
    bodyEl.innerHTML = sportType(sport) === "individual" ? renderIndividualDashboard(results) : renderTeamDashboard(results);
  }

  // ---------- coach leaderboard (club-wide, spans every sport) ----------
  function coachPerformance(){
    const map = {}; // key: name+email -> aggregate record

    state.coaches.forEach(c => {
      const key = c.name.trim().toLowerCase() + "|" + (c.email || "").trim().toLowerCase();
      if(!map[key]){
        map[key] = { name: c.name, email: c.email, assignments: [], played: 0, won: 0, drawn: 0, lost: 0 };
      }
      const sport = state.sports.find(s => s.id === c.sportId);
      if(sport) map[key].assignments.push(`${sport.name} ${c.ageGroup}`);
    });

    state.results.forEach(r => {
      const sport = state.sports.find(s => s.id === r.sportId);
      if(!sport || sportType(sport) !== "team") return; // win rate only applies to team sports
      const coach = coachFor(r.sportId, r.ageGroup, r.side);
      if(!coach) return;
      const key = coach.name.trim().toLowerCase() + "|" + (coach.email || "").trim().toLowerCase();
      if(!map[key]) return;
      map[key].played++;
      if(r.ourScore > r.theirScore) map[key].won++;
      else if(r.ourScore < r.theirScore) map[key].lost++;
      else map[key].drawn++;
    });

    return Object.values(map)
      .filter(c => c.played > 0)
      .map(c => ({ ...c, winPct: Math.round((c.won / c.played) * 100) }))
      .sort((a,b) => b.winPct - a.winPct || b.played - a.played);
  }

  function renderCoachLeaderboard(){
    const el = document.getElementById("coachLeaderboard");
    const rows = coachPerformance();

    if(rows.length === 0){
      el.innerHTML = `<div class="roster-empty">
        <span class="glyph">${uiIcon("medal", 34)}</span>
        <h3>No coach results yet</h3>
        <div>Once team-sport results are captured, coaches will be ranked here by win rate.</div>
      </div>`;
      return;
    }

    el.innerHTML = `
      <div class="coach-leaderboard-table">
        <div class="clb-row clb-head">
          <span>Coach</span><span>P</span><span>W</span><span>D</span><span>L</span><span>Win %</span>
        </div>
        ${rows.map((c, i) => `
          <div class="clb-row${i === 0 ? " clb-top" : ""}">
            <span class="clb-name">${i === 0 ? uiIcon("trophy", 13, "clb-trophy") + " " : ""}${escapeHtml(c.name)}<span class="clb-sub">${escapeHtml(c.assignments.join(", "))}</span></span>
            <span class="mono">${c.played}</span>
            <span class="mono">${c.won}</span>
            <span class="mono">${c.drawn}</span>
            <span class="mono">${c.lost}</span>
            <span class="mono clb-pct">${c.winPct}%</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  // ---------- print-friendly team sheets ----------
  const TOTEM_PRINT_LOGO_B64 = "data:image/png;base64,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F88979Env/IPt94pkq/2bjfB5ux3fuixTz/ruOe94YQXvPH6G28loo2bZ0956Ztv/ONtRNzovNR1/S//+dknPPPvH/fMf3jvhz9XVZW1tt8fvOFdHznpua9/4rNf/8FPfK15zVe97cOfP/dCZv7hT3958vPP2jIz0xzOzef68WVXHHnaq570/DccdNIr//XjXyOiq67/40kvecPM7CyA71x4ycve8A4oqRl687s+9KTTX3PyC99w9GmvuuTn1xDR2nUbnvfyN9997wPNJwKwfuOmM89+76kvfuNxz/77j3+hfVL3PvDwc175jme99G1PfNY/XPSTXxHRPfc9+NTnv+7BVWuY+WVvev8H/vsL1CZQ8AMdpDrFvncGb50s8mIoEgQlBlquxDCsO5dwOKNrDAcPpQDlc8zbF9uBdZhhkiahiMocagPMgqzVqNrh6M2cQwGMcQZ5XBjTK2uL9Ws3rl+7fufttzn7NX93+Q++8usff+PaS7/5na985PSnHVcas/bh9Zu2DMiUZWOP0jg8tX9gKTrM/h07fU10ZpiQydDODWv9BgRsFvCt/8wtuffuP7/2had9//P/eegB+5z93k8SUVVVDz28tqpqIpqd669Zs6l5o/XrNzWn4sxc/777V0PwYO+576FNG9b9xzv+4bVnnvHu//rMj376S2aua2uYQXTc4x597z33/fDSKwzzhz75lROPO7wsy49+5uu/ue66c//nfR973xs//PnvXHL51US0Yf3GTRvbBGf9+k1zcwMiuv+BhxePmo+/703/+c9//+Xv/PjiX/6mqQKas/GJjz/iv9/7uhG2jzxg989+6B2PPeKRAN11551vefVzP/0fb/niR991xCMPstYWhfnN7/541x13XvmbP957/8NlWRLRxs2bH3p47dfO+0mT7Hzj299fs3bL5i1zoiJWBPJbb7nt+ac84dPve8Mjdtj+Te//fPMI7ntgdX8wbGIoM//g4p9/6dzzP/dfb/2fD7z5s+f+6H9/9AtjzFe//YOLLrnsqx9/52c++OYPf+YbP7n8CiJatWq1gd24ecvfv/W9b/2Hly5ftrQpZ5p3fPDBh5aM4H/+/U0f/edXf/wbP/rFNTcc+5hDNm3YfO75P2bmD3/886ed+EQTKgsmottvve0lp5/w5f9+54mPf/S7P/SF5pLuve/hxsWmri0zf+rz5/zprtvO+8IHPvjPr/ngp8757Q23MfMHP/bFam7jeV/8wMued/Ir3/L+mdm5Xq/30MNrli1e9J0LfvLba67559e/HKC00o0wM4SqwIUTJIh5d9lIjFJ3w+I5WLEHWLVLOVAehBUrkl4q+0EuhzEzFLQPeBoeupqZrGxEweJVwz83F2OMMaao63rTphk7GK7YZsXTnnTsc57+lBOOPXJ68VIioqo/OTV9+jNPO/2Zp9155x3n/eCn3/3Bpdf+7qbhYDixaHxsdIRga1sTWQahVZb17t2AVjvLQJiU6U4o1Mqnf8KQXvUpQZQbhRgpzS47bbfzjtvsuu2KBx98sPmm8Z4xjns42msn03oFj5Rl8w1jvZJ1nbJi2fThh+5/+KH7X/qray7++dVPOf5xIDCbuq6nFk2e/bIzPv/186YnR9gOXvXiZxLR72646eUvevpee+y61x67Hve4R1/1u1tOPO7IXln6QqdXOrl+W++wcumB++1BRCsWTz60anUb9g0T0T577rrPnrt+4Rvf332XHY4+4uDmnkyMjOz+iO1322mFxfLx8fHmDP/qty94zUufce3v//ydCy79x1c9l4hmt2w5/vC97nv44bvueeDe++5duXTqyOntXa2E9F6N9sw+e+x0wD67Hr7vIzasX09EhmmiV5RF4WP71dfecOKxjz5o/72I6LgjD7v2d7ecfvJxv73+plNOPGbP3R9BRP/93rNXLFtCRGMljfb4fR/61JnPO+2kE55QVVUhtCSZsMM2S/fda5el0+M7L51oCpZ//vsXffIr39tlh5VTU4vOOO0ka9H+CDclEu24wza77bLj9ssXrVw80ny5Zxg2AOp/+MOtp530hB2233aH7bfddcftbrz9T488aK+7/3TP808/cZttlp9xyvG2rhq8Y9n0xO133fPZL57zxY//25LF01VVN0VoIv4731yIGqpiZuWRHuQ+PXW9zHvkdavuC/Akb2ynSPEsIWl44oKf/YhavRHbirM0YIaq2bxqY1EQmZm5wWDLhtGJiccecdizTzvxtJOO2+URjyAislXVn2PDxhRkYes5Ztp99z3eePYeb3zt3/3q6uu/8d0LL7j4F/fc+4ApzaLJ8V5Z1o0yrQilQbVZybmDs1E5cx8RsdqIZOcuyTO008T4okXv/uAnP/Q/3/ztTbec/9l/dxRnDN0xJYmAXtRX+he6AnvY6B0umV68YeMm/9iMMdbi75536o8u+/XL//E9H/nXN42OjBARqnp6aqrJn0fLXr8/bNCBuqqb17SWLDERjY+O3PTHW976zvfft2rtiunR0550dKP82LxvVdfMXA0Hs7P92lpYFIVhNq950/ssl4unx8776sfGx8b6g+ENN978/n969Xbb/e5jn//O6175HGaemZnba9ftD5he/t2LLjP17NOf9qTzLrq6qcsam0ajJSrGJibf+f6Pf/gz5954y+3/88G3NRGTHVmxeWJzs3MTY2NNjTY2Ws7NzhFRWXBhCmttVdXPefpTmldbtnjxZ7/ynU2zmy865zNpj2NycuLX197wlDNedeMd9z7pcYc9/ohD6to+/alPvOiyK1795n//9H/+E7Xz04VfShMTk+//0Kc+9aVv33T7XR957xuIqAZsXVfNLQU3D7SuGjTKFoYHgwERkW2ri6mpiVe++HQi2rBxc68s/uk9H1y+bPrQg/YbVrVEl+ZJ5jk10kAQ4gdTNNoSmRCWkmYDTSAIxK52GgXOlslR4KBISl7WC2EGAdJTKTSdhNQKSwpq5DWSgU7hmiatgJeXf1m/YTNZ2nvPXU856QnPfvpJj3nkwcQFEerBHIiNKYQlChWlISJbD21dl4U5+qgjjj7qiPeuXnXRJT8/57wf/vLK69es2zg6OTLWKy1Z8l7yEfu4nej3nWidaQmFWGFchxx9GxmMJJF468/2zzj1xBc+5xm/ufHmd3z0m0c++lFTiyaLwHxmAje7tHC7iJkMcVmWjfctERnTKt8VRP252XaRoVWitbbu9XpnPu/UP99z/ylPOa5Vhy5KQovhVcNBYRpx3bJwUmNeoRbA9KKpbVcuP/+Hl//0+1+anpqqrTUcCNeFMU2fozCmhmXmwXD4jje98qAD9zeGxkZHiejGP9z68Ko1F138q3vue+COO+/5058f2G2XHYhoy+zsWa94ypmvf98jVk6e+fx3ffncS5u7VzayN7o/OpibO+vM5z7puKNvuOW2//jEt554zFFjoyOGqNFzap7+SK/YMjds7kBpitZ13JRMbIwpS77qtzeuXLFs90fs0N88c9QjD1m+cuq1b3rP+V//ZNT+6PcH+++126c/8p6qrv7hXR89/4eXn3bSsUT0rKc98cY/3nn8sSp6Ng9zOKhe8rzTTzn5yXf++b5/+o/PHH/s4ycnxo3jgJuCiWikLJiNMaYRbGgYzyO9oqprIhoMqhtuvv2Q/fcaHxvdtGnTWWee/s3v/vBTn/v6WS9/gc84mLRHX2yKBM9Gdydw6DQrCzUlbtJubSNRAlYYpW99QGQu7UGrXMw4bQcKo1NmjoQmREN2PpZEDG8EB1zLXvYvpDGnPeW4b3/xI1f/5Nz/+td/eszhh6GqGqNGU/SKgF9wy+Rg0+jBlL0R4qKuBvWwv3zF8hc97/SLvvW5K370lQ+85/X77P6I4bBumrccTc6I6ZOc9a5gRbRNZ9YdwaQTyUy0AFUKdb3LzjvssvP2o2V52623z87NTU8vgh389nc3MfPV1143Ndlr8uFeYZwMBde1XbN2/aZNmzZu3Nhss2pYb5mZvfn2u35y6S+f+LjD46EkouVLl05PTXil3/323eP7P7yMCOs3rL/2uhsOPWB3ItphuxW/u+nmwaC/du2au/90747briAiW9sdt9/xDWe/8vRTnvz+//xEFgkq3B5ovmBBU1OT222zfOmS6aZvctnlVyydmvjVVdc/vHrd8uVTP/n51U0CtXHLzF677cIVTU1OL12ybHZmtkns/3TPA1dce0M0bGItdtlph0fsuN3U+MR999w/GA6NMQTMzfUH/f7Mli0E7Lv37r++6vphNRwOh7+74Q8H7787Ee21285X/eYGIjKGz3zjf1513R+bh7vbLju9/fVn/fnuez7x2a8URSHbH7auF08t2nnH7bbfZuXMppl773/Qb4gVS5foSajQJFqyZHqHbZdPjvb+9Od7Z+bmemUB1Js3be7P9WdmZ4lo3713//kvroSt16xZde/9D+z5iO2JaPttl15z7fXMfPNtd5159ntn5/q9suwxHXPUEe975+v/+5NfuOW2O8uysD4chBGVVLqb9biU4pKpGochzFm0kxvHNibuhyUr2bmZMkclPCT1WTEVOaAunJ1OUMxvrWnFnNK20+q/KHjTlrlHHrDP+V//f8QjGPaHszOmLIzxYsecHawTah5cmIKIUFtbD42hA/bf54D9999rp21Of9lbly5fXMGGkUvfKvWfVPWgVIALfPogdQToZyUnLMRHYzUrCBDz4sVT//Jfn//EOT9+8IH7/usdL99m5XIietvrz3zPhz7/9e9f/tAD93ziA29r3shWfdiaiHq9csPmuWe95G39wWDFyukffvMT42Nj9z647pTnnb1248ZnP/0pp598gm28BeFNXGk4HMxs3AAiwwzgNS9/7gtf/c7HP/3s2cHgSccddeqTj7HWPv2UE779g8uOPvW1NeEpJxx11OEHNBe6cfPGuq5f/5qXHPfU51z28yuOe/xRta0LNh6JGw7nhlXfAy4jo2Ov++ePTS1e9uC6jX93+pPe8trnfv+iS/75za858YRjiWjXr3zv3PN//IoXPR2EzZs3AnjW0x673z57ALRp8+bhsCKib37vkrvve/CoRzXAqkN5euVb3/fxJZ/8xgMP3v+W1zxr6ZLFW2Zmx8ZGz377hyYmFw2qmXM+9b5nP+Mp3//xL0541tm9Xu/QA/d83ulPsda+8DknX/Kr35z4wjcZUx5x8B5PP/FxRAQM169fT0T//u43vu5t7z3xhGP32n1X39mdmlp05XW3nnDG69Zs2rT/rtu95Iyn1dYWxlSDwZZNG7NlwpKliz/48W987ls/Xr127WtfdNqO267csGHj5MT4P73nw2WvnJgc+fpnP/TSlzz78l//5oSnv8aa4nmnn3TsUY8EcNYrXnDWG/7lGS88e92mza980WnTU4vWrl2PevaBBx969OGHPuOUE9/67g9880v/r1eOyDls2dtThsV6gUXpcKRIFDvZW3jwL6+Pgki3XrVJtGykmvaJVFMi6r5QeJOnNlBVVW9k9Fe/uvKJp79ifHy0rmuChWYqyo1qimLzltnDDtjvFxd+hYiLsldIATXmeWu8xP4FIMJwMOBy9LzzLzjjFW9bsny6Hg7Q8hCV0Z5vj5iy2LB20zc+9+HnPfvUQb9f9krHKHPDy+3QMcJ4j/RrEwoDQuwoNge79/4HN2zaYslsv3LpimVLPADy5/sf+uMtdx2y/x7bbbuyCRy33Xn39NSibVcun53rr1qzDpZqC2N4152327hpy/0PreqVvaVLppYtmSbYSNaBmTds3HTnn+4+9OADvaLCYFBd/ftbF09NHLTPrk3FzmwGw+HVv7t1cmLssP33aJbj/fc/uGbd+oMO2JeIbrvjrqIodt/1ET7iNkfObXfcNTExvuP22zW1zb0PPNQYa1W1XTK9aOnU+O//cMv+++5dFgURZucGt91592EH7fvQw6tWrVlz4H771rYuTEGEq39z06677LBy+dLnvvSNrzrzuU98/BF1bT0z5fY779400y975XYr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";

  function collectTeamSheetRows(sportId, group, side, excludeIds){
    const sport = state.sports.find(s => s.id === sportId);
    const positions = positionsForGroup(sport, group);
    const board = computeSides(sportId, group, excludeIds);
    const boardSide = board[side] || {};
    const rows = positions.map(pos => {
      const resolved = resolvedSlot(sportId, group, side, pos, boardSide[pos]);
      return { position: pos, name: resolved ? resolved.player.name : "—" };
    });
    const benchIds = benchFor(sportId, group, side).filter(Boolean);
    const bench = benchIds
      .map(id => { const p = state.players.find(pl => pl.id === id); return p ? p.name : null; })
      .filter(Boolean);
    return { rows, bench };
  }

  function printTeamSheet(title, subtitle, rows, bench, coachName){
    const win = window.open("", "_blank", "width=700,height=900");
    if(!win){ alert("Please allow pop-ups to print the team sheet."); return; }
    const rowsHtml = rows.map(r => `<tr><td>${escapeHtml(r.position)}</td><td>${escapeHtml(r.name)}</td></tr>`).join("");
    win.document.write(`<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif; padding:32px; color:#14201A;}
        .print-header{display:flex; align-items:center; gap:18px; margin-bottom:22px; padding-bottom:16px; border-bottom:2px solid #14201A;}
        .print-header img{height:80px; width:auto; display:block;}
        h1{font-size:22px; margin:0 0 2px;}
        .sub{color:#5B6B63; font-size:13px; margin-bottom:6px;}
        .coach-line{color:#14201A; font-size:13px; font-weight:700; margin-bottom:18px;}
        table{width:100%; border-collapse:collapse;}
        td{padding:9px 10px; border-bottom:1px solid #ddd; font-size:14px;}
        td:first-child{font-weight:700; width:130px; color:#5B6B63; text-transform:uppercase; font-size:11px; letter-spacing:0.04em;}
        .bench{margin-top:22px; font-size:13px; color:#5B6B63;}
        .footer{margin-top:36px; font-size:10px; color:#999;}
        @media print{ body{padding:0;} }
      </style></head><body>
      <div class="print-header">
        ${currentOrgEmblemUrl ? `<img src="${currentOrgEmblemUrl}" alt="${escapeHtml(currentOrgName || "Club emblem")}">` : ""}
        <img src="${TOTEM_PRINT_LOGO_B64}" alt="Totem">
      </div>
      <h1>${escapeHtml(title)}</h1>
      <div class="sub">${escapeHtml(subtitle)}</div>
      ${coachName ? `<div class="coach-line">Coach: ${escapeHtml(coachName)}</div>` : ""}
      <table>${rowsHtml}</table>
      ${bench.length ? `<div class="bench"><strong>Bench:</strong> ${bench.map(escapeHtml).join(", ")}</div>` : ""}
      <div class="footer">Generated by Totem™</div>
      </body></html>`);
    win.document.close();
    win.focus();
    win.print();
  }

  function printTeamSheetFor(sportId, group, side, fixture){
    const sport = state.sports.find(s => s.id === sportId);
    const label = seniorSideLabel(sport, group, side) || `${group} · ${side}`;
    const excludeIds = fixture ? unavailableIdsFor(fixture.id) : null;
    const { rows, bench } = collectTeamSheetRows(sportId, group, side, excludeIds);
    const title = `${sport.name} — ${label}`;
    const groupCoach = coachFor(sportId, group, side);
    let subtitle;
    if(fixture){
      const dateLabel = new Date(fixture.date + "T00:00:00").toLocaleDateString(undefined,{weekday:"long", day:"numeric", month:"long", year:"numeric"});
      subtitle = `vs ${fixture.opponent} · ${dateLabel}${fixture.venue ? " · " + fixture.venue + (venueAddressFor(fixture.venue) ? " (" + venueAddressFor(fixture.venue) + ")" : "") : ""}`;
    } else {
      subtitle = "Team Sides";
    }
    printTeamSheet(title, subtitle, rows, bench, groupCoach ? groupCoach.name : null);
  }

  // ---------- print fixture results & season summaries ----------
  function printFixtureResult(sportId, group, side, fixture){
    const sport = state.sports.find(s => s.id === sportId);
    const result = resultFor(fixture.id, group, side);
    if(!result){ alert("No result captured for this team yet."); return; }
    const label = seniorSideLabel(sport, group, side) || `${group} · ${side}`;
    const groupCoach = coachFor(sportId, group, side);
    const dateLabel = new Date(fixture.date + "T00:00:00").toLocaleDateString(undefined,{weekday:"long", day:"numeric", month:"long", year:"numeric"});
    const subtitle = `vs ${fixture.opponent} · ${dateLabel}${fixture.venue ? " · " + fixture.venue + (venueAddressFor(fixture.venue) ? " (" + venueAddressFor(fixture.venue) + ")" : "") : ""}`;

    let bodyHtml;
    if(sportType(sport) === "individual"){
      const rows = (result.entries || []).map(en => {
        const player = state.players.find(p => p.id === en.playerId);
        return `<tr><td>${escapeHtml(player ? player.name : "Unknown")}</td><td>${escapeHtml(en.event)}</td><td>${escapeHtml(en.time)}${en.place ? " · " + ordinal(en.place) : ""}</td></tr>`;
      }).join("");
      bodyHtml = `<table><tr><th>Athlete</th><th>Event</th><th>Time / place</th></tr>${rows}</table>`;
    } else {
      const outcome = result.ourScore > result.theirScore ? "WON" : result.ourScore < result.theirScore ? "LOST" : "DRAWN";
      const scorers = (result.scorers || []).map(sc => {
        const player = state.players.find(p => p.id === sc.playerId);
        const name = player ? player.name : "Unknown";
        return sc.goals > 1 ? `${name} ×${sc.goals}` : name;
      });
      bodyHtml = `
        <div class="score-line">${outcome} ${result.ourScore} – ${result.theirScore}</div>
        ${scorers.length ? `<div class="scorers-line"><strong>Scorers:</strong> ${scorers.map(escapeHtml).join(", ")}</div>` : ""}
      `;
    }
    if(result.notes) bodyHtml += `<div class="notes-line">${escapeHtml(result.notes)}</div>`;

    const win = window.open("", "_blank", "width=700,height=900");
    if(!win){ alert("Please allow pop-ups to print the result."); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>${escapeHtml(sport.name)} — ${escapeHtml(label)} result</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif; padding:32px; color:#14201A;}
        .print-header{display:flex; align-items:center; gap:18px; margin-bottom:22px; padding-bottom:16px; border-bottom:2px solid #14201A;}
        .print-header img{height:80px; width:auto; display:block;}
        h1{font-size:22px; margin:0 0 2px;}
        .sub{color:#5B6B63; font-size:13px; margin-bottom:6px;}
        .coach-line{font-size:13px; font-weight:700; margin-bottom:18px;}
        .score-line{font-size:26px; font-weight:700; margin:14px 0 8px;}
        .scorers-line, .notes-line{font-size:13px; color:#5B6B63; margin-top:8px;}
        table{width:100%; border-collapse:collapse; margin-top:14px;}
        th{text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:#5B6B63; padding:6px 10px; border-bottom:2px solid #ddd;}
        td{padding:9px 10px; border-bottom:1px solid #ddd; font-size:14px;}
        .footer{margin-top:36px; font-size:10px; color:#999;}
        @media print{ body{padding:0;} }
      </style></head><body>
      <div class="print-header">
        ${currentOrgEmblemUrl ? `<img src="${currentOrgEmblemUrl}" alt="${escapeHtml(currentOrgName || "Club emblem")}">` : ""}
        <img src="${TOTEM_PRINT_LOGO_B64}" alt="Totem">
      </div>
      <h1>${escapeHtml(sport.name)} — ${escapeHtml(label)}</h1>
      <div class="sub">${escapeHtml(subtitle)}</div>
      ${groupCoach ? `<div class="coach-line">Coach: ${escapeHtml(groupCoach.name)}</div>` : ""}
      ${bodyHtml}
      <div class="footer">Generated by Totem™</div>
      </body></html>`);
    win.document.close();
    win.focus();
    win.print();
  }

  function printSeasonSummary(sportId, group){
    const sport = state.sports.find(s => s.id === sportId);
    const results = resultsForSportGroup(sportId, group);
    const groupCoach = coachFor(sportId, group);
    const isIndividual = sportType(sport) === "individual";

    let bodyHtml;
    if(isIndividual){
      const bests = {};
      results.forEach(r => {
        (r.entries || []).forEach(en => {
          if(!en.playerId || !en.time) return;
          const key = en.playerId + "|" + en.event;
          const secs = parseTimeToSeconds(en.time);
          if(!bests[key] || secs < bests[key].seconds) bests[key] = { seconds: secs, time: en.time, event: en.event, playerId: en.playerId };
        });
      });
      const bestRows = Object.values(bests)
        .map(b => {
          const player = state.players.find(p => p.id === b.playerId);
          return `<tr><td>${escapeHtml(player ? player.name : "Unknown")}</td><td>${escapeHtml(b.event)}</td><td>${escapeHtml(b.time)}</td></tr>`;
        }).join("");
      const historyRows = results.map(r => {
        const dateLabel = new Date(r.fixture.date + "T00:00:00").toLocaleDateString(undefined,{day:"numeric", month:"short"});
        return `<tr><td>${escapeHtml(dateLabel)}</td><td>${escapeHtml(r.fixture.opponent)}</td><td>${(r.entries||[]).length} entries</td></tr>`;
      }).join("");
      bodyHtml = `
        <h2>Personal bests</h2>
        <table><tr><th>Athlete</th><th>Event</th><th>Best time</th></tr>${bestRows || "<tr><td colspan=3>No times logged yet.</td></tr>"}</table>
        <h2>Gala history</h2>
        <table><tr><th>Date</th><th>Gala</th><th>Entries</th></tr>${historyRows || "<tr><td colspan=3>No galas captured yet.</td></tr>"}</table>
      `;
    } else {
      let played = 0, won = 0, drawn = 0, lost = 0, gf = 0, ga = 0;
      const scorerTotals = {};
      results.forEach(r => {
        played++; gf += r.ourScore; ga += r.theirScore;
        if(r.ourScore > r.theirScore) won++; else if(r.ourScore < r.theirScore) lost++; else drawn++;
        (r.scorers || []).forEach(sc => {
          if(!sc.playerId) return;
          scorerTotals[sc.playerId] = (scorerTotals[sc.playerId] || 0) + (sc.goals || 0);
        });
      });
      const scorerRows = Object.entries(scorerTotals).sort((a,b) => b[1]-a[1]).map(([playerId, goals]) => {
        const player = state.players.find(p => p.id === playerId);
        return `<tr><td>${escapeHtml(player ? player.name : "Unknown")}</td><td>${goals}</td></tr>`;
      }).join("");
      const historyRows = results.map(r => {
        const outcome = r.ourScore > r.theirScore ? "W" : r.ourScore < r.theirScore ? "L" : "D";
        const dateLabel = new Date(r.fixture.date + "T00:00:00").toLocaleDateString(undefined,{day:"numeric", month:"short"});
        return `<tr><td>${outcome}</td><td>${escapeHtml(dateLabel)}</td><td>vs ${escapeHtml(r.fixture.opponent)}</td><td>${r.ourScore}–${r.theirScore}</td></tr>`;
      }).join("");
      bodyHtml = `
        <div class="stat-grid">
          <div><strong>${played}</strong><span>Played</span></div>
          <div><strong>${won}</strong><span>Won</span></div>
          <div><strong>${drawn}</strong><span>Drawn</span></div>
          <div><strong>${lost}</strong><span>Lost</span></div>
          <div><strong>${gf}–${ga}</strong><span>Goals F–A</span></div>
        </div>
        <h2>Top scorers</h2>
        <table><tr><th>Player</th><th>Goals</th></tr>${scorerRows || "<tr><td colspan=2>No scorers logged yet.</td></tr>"}</table>
        <h2>Results history</h2>
        <table><tr><th></th><th>Date</th><th>Opponent</th><th>Score</th></tr>${historyRows || "<tr><td colspan=4>No results captured yet.</td></tr>"}</table>
      `;
    }

    const win = window.open("", "_blank", "width=760,height=900");
    if(!win){ alert("Please allow pop-ups to print the season summary."); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>${escapeHtml(sport.name)} — ${escapeHtml(group)} season summary</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif; padding:32px; color:#14201A;}
        .print-header{display:flex; align-items:center; gap:18px; margin-bottom:22px; padding-bottom:16px; border-bottom:2px solid #14201A;}
        .print-header img{height:80px; width:auto; display:block;}
        h1{font-size:22px; margin:0 0 2px;}
        h2{font-size:15px; margin:26px 0 8px;}
        .sub{color:#5B6B63; font-size:13px; margin-bottom:6px;}
        .coach-line{font-size:13px; font-weight:700; margin-bottom:10px;}
        .stat-grid{display:flex; gap:18px; margin:18px 0; flex-wrap:wrap;}
        .stat-grid div{text-align:center;}
        .stat-grid strong{display:block; font-size:20px;}
        .stat-grid span{font-size:10px; text-transform:uppercase; color:#5B6B63; letter-spacing:0.04em;}
        table{width:100%; border-collapse:collapse;}
        th{text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:#5B6B63; padding:6px 10px; border-bottom:2px solid #ddd;}
        td{padding:8px 10px; border-bottom:1px solid #ddd; font-size:13px;}
        .footer{margin-top:36px; font-size:10px; color:#999;}
        @media print{ body{padding:0;} }
      </style></head><body>
      <div class="print-header">
        ${currentOrgEmblemUrl ? `<img src="${currentOrgEmblemUrl}" alt="${escapeHtml(currentOrgName || "Club emblem")}">` : ""}
        <img src="${TOTEM_PRINT_LOGO_B64}" alt="Totem">
      </div>
      <h1>${escapeHtml(sport.name)} — ${escapeHtml(group)}</h1>
      <div class="sub">Season summary</div>
      ${groupCoach ? `<div class="coach-line">Coach: ${escapeHtml(groupCoach.name)}</div>` : ""}
      ${bodyHtml}
      <div class="footer">Generated by Totem™</div>
      </body></html>`);
    win.document.close();
    win.focus();
    win.print();
  }

  // ---------- notification preview ----------
  // NOTE: this is a UI preview only — sending real email requires a backend
  // (see the chat writeup for how this plugs into Supabase).
  // ---------- result notification email (real send via Edge Function) ----------
  async function sendResultNotification(sport, fixture, result, warningPrefix){
    const notifyCoach = coachFor(result.sportId, result.ageGroup, result.side);
    const resultLabel = seniorSideLabel(sport, result.ageGroup, result.side) || `${result.ageGroup} ${result.side}`;
    const payload = {
      sportName: sport.name,
      ageGroupLabel: resultLabel,
      opponent: fixture ? fixture.opponent : "",
      date: fixture ? fixture.date : "",
      venue: fixture && fixture.venue ? fixture.venue : null,
      coachEmail: notifyCoach ? notifyCoach.email : null,
      coachName: notifyCoach ? notifyCoach.name : null
    };
    if(sportType(sport) === "individual"){
      payload.entries = (result.entries || []).map(en => {
        const player = state.players.find(p => p.id === en.playerId);
        return { name: player ? player.name : "Unknown", event: en.event, time: en.time, place: en.place || null };
      });
    } else {
      payload.scoreLine = `${result.ourScore} – ${result.theirScore}`;
      payload.outcome = result.ourScore > result.theirScore ? "WON" : result.ourScore < result.theirScore ? "LOST" : "DRAWN";
      payload.scorers = (result.scorers || []).map(sc => {
        const player = state.players.find(p => p.id === sc.playerId);
        const name = player ? player.name : "Unknown";
        return sc.goals > 1 ? `${name} ×${sc.goals}` : name;
      });
    }

    try{
      const { error } = await supabaseClient.functions.invoke("send-result-email", { body: payload });
      if(error) throw error;
      showToast(`${warningPrefix || ""}${resultLabel} result emailed to${notifyCoach ? " " + notifyCoach.email + " +" : ""} the team.`);
    }catch(e){
      console.warn("Totem: result email failed —", e);
      showToast(`${warningPrefix || ""}Result saved, but the notification email failed to send. Check your Edge Function is deployed.`);
    }
  }

  function showToast(message){
    let toast = document.getElementById("totemToast");
    if(!toast){
      toast = document.createElement("div");
      toast.id = "totemToast";
      toast.className = "toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    requestAnimationFrame(() => toast.classList.add("show"));
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove("show"), 6000);
  }

  function renderFxAgeGroupsGrid(sport, type){
    const groups = ageGroupsForSport(sport.id);
    const wrap = document.getElementById("fxAgeGroups");
    if(type === "trial"){
      wrap.innerHTML = groups.map(g => `
        <label class="chip-check">
          <input type="checkbox" data-group="${g}">
          <span>${g}</span>
        </label>
      `).join("");
    } else {
      wrap.innerHTML = groups.map(g => `
        <div class="fx-group-row">
          <span class="fx-group-label">${g}</span>
          <div class="chip-check-row">
            ${SIDE_LETTERS.map(side => `
              <label class="chip-check">
                <input type="checkbox" data-group="${g}" data-side="${side}">
                <span>${seniorSideLabel(sport, g, side) || side}</span>
              </label>
            `).join("")}
          </div>
        </div>
      `).join("");
    }
  }

  function updateFixtureModalForType(sport, type){
    document.getElementById("fixtureModalTitle").textContent = type === "trial" ? "Add a trial" : "Add a fixture";
    document.getElementById("fxOpponentLabel").textContent = type === "trial" ? "Trial name" : "Opponent";
    document.getElementById("fxOpponent").placeholder = type === "trial" ? "e.g. Term 1 Time Trials" : "e.g. St Mary's";
    document.getElementById("fxAgeGroupsLabel").textContent = type === "trial" ? "Age groups trialling" : "Age groups & sides playing";
    document.getElementById("confirmFixture").textContent = type === "trial" ? "Save trial" : "Save fixture";
    renderFxAgeGroupsGrid(sport, type);
  }

  function openAddFixtureModal(prefillDateOrItem, editType){
    const sport = currentSport();
    const isIndividual = sportType(sport) === "individual";
    const isEdit = editType === "fixture" || editType === "trial";
    editingFixtureId = editType === "fixture" ? prefillDateOrItem.id : null;
    editingTrialId = editType === "trial" ? prefillDateOrItem.id : null;
    const item = isEdit ? prefillDateOrItem : null;

    document.getElementById("fxDate").value = item ? item.date : (typeof prefillDateOrItem === "string" ? prefillDateOrItem : isoDate(new Date()));
    document.getElementById("fxOpponent").value = item ? (editType === "trial" ? item.name : item.opponent) : "";
    document.getElementById("fxVenue").value = item ? (item.venue || "") : "";
    document.getElementById("fxVenueAddress").value = item ? (venueAddressFor(item.venue) || "") : "";
    populateVenueDatalist();

    document.getElementById("fxTypeField").style.display = isIndividual ? "" : "none";
    const wantType = editType === "trial" ? "trial" : "match";
    const typeRadio = document.querySelector(`input[name="fxType"][value="${wantType}"]`);
    if(typeRadio) typeRadio.checked = true;
    updateFixtureModalForType(sport, wantType);

    if(item){
      if(editType === "trial"){
        (item.ageGroups || []).forEach(g => {
          const cb = document.querySelector(`#fxAgeGroups input[data-group="${CSS.escape(g)}"]`);
          if(cb) cb.checked = true;
        });
      } else {
        (item.entries || []).forEach(en => {
          const cb = document.querySelector(`#fxAgeGroups input[data-group="${CSS.escape(en.ageGroup)}"][data-side="${en.side}"]`);
          if(cb) cb.checked = true;
        });
      }
    }

    document.getElementById("fixtureModalTitle").textContent = isEdit
      ? (editType === "trial" ? "Edit trial" : "Edit fixture")
      : (wantType === "trial" ? "Add a trial" : "Add a fixture");
    document.getElementById("confirmFixture").textContent = isEdit ? "Save changes" : (wantType === "trial" ? "Save trial" : "Save fixture");

    document.getElementById("fixtureModal").classList.add("open");
  }
  document.getElementById("fxVenue").addEventListener("input", (e) => {
    const address = venueAddressFor(e.target.value);
    if(address) document.getElementById("fxVenueAddress").value = address;
  });
  document.querySelectorAll('input[name="fxType"]').forEach(radio => {
    radio.addEventListener("change", (e) => updateFixtureModalForType(currentSport(), e.target.value));
  });

  document.getElementById("btnAddFixture").addEventListener("click", () => openAddFixtureModal());
  document.getElementById("btnPrintSeason").addEventListener("click", () => {
    if(!dashboardAgeGroup){ alert("No age group selected yet — add some players first."); return; }
    printSeasonSummary(currentSport().id, dashboardAgeGroup);
  });
  document.getElementById("calPrev").addEventListener("click", () => { calendarDate.setMonth(calendarDate.getMonth()-1); renderCalendar(); });
  document.getElementById("calNext").addEventListener("click", () => { calendarDate.setMonth(calendarDate.getMonth()+1); renderCalendar(); });
  document.getElementById("cancelFixture").addEventListener("click", () => {
    editingFixtureId = null; editingTrialId = null;
    document.getElementById("fixtureModal").classList.remove("open");
  });
  document.getElementById("fixtureModal").addEventListener("click", (e) => {
    if(e.target.id === "fixtureModal"){
      editingFixtureId = null; editingTrialId = null;
      document.getElementById("fixtureModal").classList.remove("open");
    }
  });
  document.getElementById("confirmFixture").addEventListener("click", () => {
    const sport = currentSport();
    const typeInput = document.querySelector('input[name="fxType"]:checked');
    const type = (sportType(sport) === "individual" && typeInput) ? typeInput.value : "match";
    const date = document.getElementById("fxDate").value;
    const label = document.getElementById("fxOpponent").value.trim();
    const venue = document.getElementById("fxVenue").value.trim();
    const venueAddress = document.getElementById("fxVenueAddress").value.trim();
    if(venue) upsertVenue(venue, venueAddress);

    if(!date){ alert("Pick a date."); return; }
    if(!label){ alert(type === "trial" ? "Enter a name for the trial." : "Enter the opponent's name."); return; }

    if(type === "trial"){
      const ageGroups = Array.from(document.querySelectorAll("#fxAgeGroups input[type=checkbox]:checked")).map(cb => cb.dataset.group);
      if(ageGroups.length === 0){ alert("Select at least one age group."); return; }

      if(editingTrialId){
        const trial = state.trials.find(t => t.id === editingTrialId);
        if(!trial){ editingTrialId = null; return; }
        const removedGroups = (trial.ageGroups || []).filter(g => !ageGroups.includes(g));
        const groupsWithResults = removedGroups.filter(g => trialResultFor(editingTrialId, g));
        if(groupsWithResults.length > 0){
          const plural = groupsWithResults.length > 1;
          const ok = confirm(`${groupsWithResults.join(", ")} already ${plural ? "have" : "has a"} result captured. Removing ${plural ? "them" : "it"} from this trial will also delete ${plural ? "those results" : "that result"}. Continue?`);
          if(!ok) return;
          state.trialResults = state.trialResults.filter(r => !(r.trialId === editingTrialId && groupsWithResults.includes(r.ageGroup)));
        }
        trial.date = date; trial.name = label; trial.venue = venue; trial.ageGroups = ageGroups;
      } else {
        state.trials.push({ id: uid(), sportId: sport.id, date, name: label, venue, ageGroups });
      }
    } else {
      const entries = Array.from(document.querySelectorAll("#fxAgeGroups input[type=checkbox]:checked"))
        .filter(cb => cb.dataset.side)
        .map(cb => ({ ageGroup: cb.dataset.group, side: cb.dataset.side }));
      if(entries.length === 0){ alert("Select at least one age group and side."); return; }

      if(editingFixtureId){
        const fixture = state.fixtures.find(f => f.id === editingFixtureId);
        if(!fixture){ editingFixtureId = null; return; }
        const stillIncluded = (en) => entries.some(e => e.ageGroup === en.ageGroup && e.side === en.side);
        const removedEntries = (fixture.entries || []).filter(en => !stillIncluded(en));
        const entriesWithResults = removedEntries.filter(en => resultFor(editingFixtureId, en.ageGroup, en.side));
        if(entriesWithResults.length > 0){
          const fixtureSport = state.sports.find(s => s.id === fixture.sportId);
          const labels = entriesWithResults.map(en => seniorSideLabel(fixtureSport, en.ageGroup, en.side) || `${en.ageGroup} ${en.side}`);
          const plural = labels.length > 1;
          const ok = confirm(`${labels.join(", ")} already ${plural ? "have" : "has a"} result captured. Removing ${plural ? "them" : "it"} from this fixture will also delete ${plural ? "those results" : "that result"}. Continue?`);
          if(!ok) return;
          entriesWithResults.forEach(en => {
            state.results = state.results.filter(r => !(r.fixtureId === editingFixtureId && groupsMatch(r.ageGroup, en.ageGroup) && r.side === en.side));
          });
        }
        fixture.date = date; fixture.opponent = label; fixture.venue = venue; fixture.entries = entries;
      } else {
        state.fixtures.push({ id: uid(), sportId: sport.id, date, opponent: label, venue, entries });
      }
    }

    editingFixtureId = null; editingTrialId = null;
    document.getElementById("fixtureModal").classList.remove("open");
    saveState();
    renderCalendar(); renderFixtureList(); renderFixtureDetail(); renderSides(); renderDashboard();
  });

  // ---------- sport icons ----------
  // A curated, consistent icon exists for common sports. Anything else
  // (a club-specific or unusual sport someone adds) automatically falls
  // back to a clean initials badge — never an emoji, never a blank/broken icon.
  const SPORT_ICONS = {
    netball: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18"/>',
    hockey: '<path d="M4 20c4-10 12-10 16-16"/><circle cx="19" cy="5" r="2"/>',
    swimming: '<path d="M3 16c2-2 4 2 6 0s4 2 6 0 4 2 6 0"/><path d="M3 12c2-2 4 2 6 0s4 2 6 0 4 2 6 0"/>',
    athletics: '<path d="M13 3 6 15h5l-1 6 8-12h-5z"/>',
    rugby: '<ellipse cx="12" cy="12" rx="9" ry="5.5"/><path d="M4.5 12h15M9 9.5v5M12 9v6M15 9.5v5"/>',
    cricket: '<path d="M14 3 9 12l3 3 9-5z"/><path d="M9 12l-4.5 6.5"/><circle cx="4" cy="19.5" r="1.8"/>',
    basketball: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5.5 5.5c3.5 3.5 9.5 3.5 13 0M5.5 18.5c3.5-3.5 9.5-3.5 13 0"/>',
    soccer: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5 14.6 9.4 13.6 13H10.4L9.4 9.4Z"/><path d="M12 3.5v4M5 8.5l3.5 1M19 8.5l-3.5 1M8 19l1.3-3.3M16 19l-1.3-3.3"/>',
    tennis: '<circle cx="12" cy="12" r="9"/><path d="M4 6c4 2 4 10 0 12M20 6c-4 2-4 10 0 12"/>',
    volleyball: '<circle cx="12" cy="12" r="9"/><path d="M12 3c3 3 3 15 0 18M3.5 9c4 2 13 2 17 0M3.5 15c4-2 13-2 17 0"/>',
    "cross-country": '<circle cx="15" cy="4.5" r="1.8"/><path d="M12 9l3 1.5 1.5 5-1.5 6M15 10.5l-4 2-2.5 5M12 9 7.5 12"/>',
    chess: '<path d="M9 20h6M10 20v-2.5c0-1 .5-1.8 1-2.5.5.7 1 1.5 1 2.5V20"/><path d="M8.5 15c-.3-3.5 1.5-4.5 1.5-6.5 0-1-1-1-1-2C9 4.7 10.3 3 12 3s3 1.7 3 3.5c0 1-1 1-1 2 0 2 1.8 3 1.5 6.5Z"/>',
    squash: '<ellipse cx="8.5" cy="7.5" rx="4.5" ry="5.5" transform="rotate(-25 8.5 7.5)"/><path d="M11.5 12 18 20"/><circle cx="19.2" cy="5.5" r="1.5"/>',
    golf: '<path d="M6 21V4M6 4l9 3-9 3"/><circle cx="17" cy="18" r="2"/>',
    rowing: '<path d="M4 20 18 6M4 6l14 14"/><circle cx="4" cy="20" r="1.3"/><circle cx="18" cy="6" r="1.3"/><circle cx="4" cy="6" r="1.3"/><circle cx="18" cy="20" r="1.3"/>',
    "water-polo": '<path d="M3 16c2-2 4 2 6 0s4 2 6 0 4 2 6 0"/><circle cx="12" cy="9" r="4"/>'
  };
  const SPORT_ICON_LABELS = {
    netball:"Netball", hockey:"Hockey", swimming:"Swimming", athletics:"Athletics",
    rugby:"Rugby", cricket:"Cricket", basketball:"Basketball", soccer:"Soccer",
    tennis:"Tennis", volleyball:"Volleyball", "cross-country":"Cross Country",
    chess:"Chess", squash:"Squash", golf:"Golf", rowing:"Rowing", "water-polo":"Water Polo"
  };
  function sportInitials(name){
    const words = String(name || "").trim().split(/\s+/).filter(Boolean);
    if(words.length === 0) return "?";
    if(words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  function sportIconHtml(sport, size){
    const px = size || 16;
    if(sport.iconKey && SPORT_ICONS[sport.iconKey]){
      return `<svg class="sport-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:${px}px;height:${px}px;">${SPORT_ICONS[sport.iconKey]}</svg>`;
    }
    return `<span class="sport-icon-badge" style="width:${px}px;height:${px}px;font-size:${Math.max(8, px*0.42)}px;">${escapeHtml(sportInitials(sport.name))}</span>`;
  }

  // ---------- interface icons (replace every remaining emoji, same visual language as sport icons) ----------
  const UI_ICONS = {
    coach: '<circle cx="12" cy="8" r="3.3"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    playerPlus: '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 20a6.3 6.3 0 0 1 12.4 0"/><path d="M18 8v6M15 11h6"/>',
    trophy: '<path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7 5H4.5A2.5 2.5 0 0 0 7 9.5M17 5h2.5A2.5 2.5 0 0 1 17 9.5"/><path d="M12 13v4"/><path d="M9.5 17h5l1 3H8.5z"/>',
    jersey: '<path d="M8.5 4 4.5 7v3H7v10h10V10h2.5V7l-4-3-2.2 2h-3.6z"/>',
    printer: '<path d="M6 9V4h12v5"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><rect x="7.5" y="14" width="9" height="6"/>',
    gift: '<rect x="4" y="10" width="16" height="10" rx="1"/><path d="M4 14h16M12 10v10"/><path d="M12 9.5c-1.6-3-5.2-2.6-5.2-.3S9 9.7 12 9.5zM12 9.5c1.6-3 5.2-2.6 5.2-.3S15 9.7 12 9.5z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2.5 12h3M18.5 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    barChart: '<path d="M4 20V11M10 20V4M16 20v-6M3 20h18"/>',
    medal: '<circle cx="12" cy="15" r="5"/><path d="m9 11-3-8M15 11l3-8M6 3h3l3 4.5L15 3h3"/>',
    envelope: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 6.5 8 6.5 8-6.5"/>',
    flag: '<path d="M5 3v18"/><path d="M5 4c2-1 4-1 6 0s4 1 6 0v8c-2 1-4 1-6 0s-4-1-6 0z"/>',
    warning: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 9.5v4.2M12 17h.01"/>'
  };
  function uiIcon(key, size, extraClass){
    const px = size || 16;
    return `<svg class="ui-icon${extraClass ? " " + extraClass : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:${px}px;height:${px}px;">${UI_ICONS[key] || ""}</svg>`;
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, ch => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
    }[ch]));
  }

  function render(){
    renderSportTabs();
    renderPositionSelect();
    renderFilters();
    renderMetricManager();
    renderPositionsManager();
    renderCoaches();
    renderRoster();
    renderTopPicks();
    renderSides();
    renderCalendar();
    renderFixtureList();
    renderFixtureDetail();
    renderDashboard();
    renderCoachLeaderboard();
    renderUsageBanner();
  }

  // ---------- events ----------
  document.getElementById("btnAddPlayer").addEventListener("click", () => {
    if(planLimitReached("players")){
      showUpgradePrompt(`You've reached the free plan's limit of ${PLAN_LIMITS.free.players} players.`);
      return;
    }
    const nameInp = document.getElementById("inName");
    const dobInp = document.getElementById("inDob");
    const vo2Inp = document.getElementById("inVo2max");
    const sport = currentSport();
    const isIndividual = sportType(sport) === "individual";
    const name = nameInp.value.trim();
    const birthDate = dobInp.value;
    const turning = turningAgeFromBirthDate(birthDate);
    const vo2max = vo2Inp.value ? +vo2Inp.value : null;

    let positions;
    if(isIndividual){
      positions = Array.from(document.querySelectorAll("#inPositionsMulti input:checked")).map(i => i.value);
    } else {
      positions = [document.getElementById("inPosition").value];
    }

    if(!name){ alert("Enter a player name."); nameInp.focus(); return; }
    if(!birthDate || turning === null){ alert("Enter a date of birth."); dobInp.focus(); return; }
    if(turning < 4 || turning > 90){ alert("That date of birth gives an age outside the expected range — double check it."); dobInp.focus(); return; }
    if(positions.length === 0){ alert(isIndividual ? "Select at least one event." : "Select a position."); return; }

    const metrics = {};
    state.metricFields.forEach(f => metrics[f.key] = 5);

    state.players.push({
      id: uid(),
      sportId: state.activeSport,
      name, birthDate, positions, vo2max,
      metrics
    });
    nameInp.value = ""; dobInp.value = ""; vo2Inp.value = "";
    document.querySelectorAll("#inPositionsMulti input:checked").forEach(i => i.checked = false);
    document.getElementById("inPositionsMulti").classList.remove("open");
    updateEventsToggleLabel();
    saveState(); render();
  });

  document.getElementById("inPositionsMultiToggle").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("inPositionsMulti").classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    const wrap = document.getElementById("inPositionsMultiWrap");
    if(!wrap.contains(e.target)) document.getElementById("inPositionsMulti").classList.remove("open");
  });

  document.getElementById("filterAge").addEventListener("change", render);
  document.getElementById("inDob").addEventListener("input", renderPositionSelect);
  document.getElementById("filterPosition").addEventListener("change", render);
  document.getElementById("filterSearch").addEventListener("input", renderRoster);

  document.getElementById("toggleMetrics").addEventListener("click", () => {
    document.getElementById("metricManager").classList.toggle("open");
  });

  document.getElementById("togglePositions").addEventListener("click", () => {
    document.getElementById("positionsManager").classList.toggle("open");
  });
  document.getElementById("positionsAgeGroupSelect").addEventListener("change", renderPositionsManager);
  document.getElementById("btnAddPosition").addEventListener("click", () => {
    const sport = currentSport();
    const isIndividual = sportType(sport) === "individual";
    const inp = document.getElementById("newPositionName");
    const val = inp.value.trim();
    if(!val) return;

    if(sport.eventsByAgeGroup){
      const group = document.getElementById("positionsAgeGroupSelect").value;
      if(!sport.eventsByAgeGroup[group]) sport.eventsByAgeGroup[group] = [];
      if(sport.eventsByAgeGroup[group].includes(val)){ alert(`That ${isIndividual ? "event" : "position"} already exists for this age group.`); return; }
      sport.eventsByAgeGroup[group].push(val);
      recomputeFlatPositions(sport);
    } else {
      if(sport.positions.includes(val)){ alert(`That ${isIndividual ? "event" : "position"} already exists.`); return; }
      sport.positions.push(val);
    }
    inp.value = "";
    saveState(); render();
  });

  document.getElementById("btnAddField").addEventListener("click", () => {
    const inp = document.getElementById("newFieldName");
    const label = inp.value.trim();
    if(!label) return;
    const key = "f_" + uid();
    state.metricFields.push({key, label});
    state.players.forEach(p => { p.metrics[key] = 5; });
    inp.value = "";
    saveState(); render();
  });

  let selectedNewSportIcon = null;
  function renderIconPicker(){
    const wrap = document.getElementById("newSportIconPicker");
    wrap.innerHTML = Object.keys(SPORT_ICONS).map(key => `
      <div class="icon-swatch${selectedNewSportIcon === key ? " selected" : ""}" data-icon="${key}">
        <svg class="sport-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SPORT_ICONS[key]}</svg>
        <span class="label">${escapeHtml(SPORT_ICON_LABELS[key])}</span>
      </div>
    `).join("");
    wrap.querySelectorAll(".icon-swatch").forEach(el => {
      el.addEventListener("click", () => {
        selectedNewSportIcon = selectedNewSportIcon === el.dataset.icon ? null : el.dataset.icon;
        renderIconPicker();
      });
    });
  }

  function openSportModal(){
    document.getElementById("sportModal").classList.add("open");
    document.getElementById("newSportName").value = "";
    document.getElementById("newSportPositions").value = "";
    const teamRadio = document.querySelector('input[name="newSportType"][value="team"]');
    if(teamRadio) teamRadio.checked = true;
    document.getElementById("newSportPositionsLabel").textContent = "Positions (comma separated)";
    selectedNewSportIcon = null;
    renderIconPicker();
  }
  document.querySelectorAll('input[name="newSportType"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      document.getElementById("newSportPositionsLabel").textContent =
        e.target.value === "individual" ? "Events (comma separated)" : "Positions (comma separated)";
    });
  });
  document.getElementById("cancelSport").addEventListener("click", () => {
    document.getElementById("sportModal").classList.remove("open");
  });
  function addSportFromTemplate(template){
    if(planLimitReached("sports")){
      showUpgradePrompt(`You've reached the free plan's limit of ${PLAN_LIMITS.free.sports} sports.`);
      return;
    }
    if(state.sports.find(s => s.id === template.id)){ alert(`${template.name} is already added.`); return; }
    state.sports.push(JSON.parse(JSON.stringify(template)));
    state.activeSport = template.id;
    document.getElementById("sportModal").classList.remove("open");
    saveState(); render();
  }
  document.getElementById("quickAddSwimming").addEventListener("click", () => addSportFromTemplate(SWIMMING_TEMPLATE));
  document.getElementById("quickAddAthletics").addEventListener("click", () => addSportFromTemplate(ATHLETICS_TEMPLATE));

  document.getElementById("confirmSport").addEventListener("click", () => {
    if(planLimitReached("sports")){
      showUpgradePrompt(`You've reached the free plan's limit of ${PLAN_LIMITS.free.sports} sports.`);
      return;
    }
    const name = document.getElementById("newSportName").value.trim();
    const posRaw = document.getElementById("newSportPositions").value.trim();
    if(!name){ alert("Enter a sport name."); return; }
    const positions = posRaw ? posRaw.split(",").map(s => s.trim()).filter(Boolean) : ["Player"];
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g,"-") + "-" + uid().slice(0,4);
    const typeInput = document.querySelector('input[name="newSportType"]:checked');
    const type = typeInput ? typeInput.value : "team";
    state.sports.push({ id, name, iconKey: selectedNewSportIcon, type, positions });
    state.activeSport = id;
    document.getElementById("sportModal").classList.remove("open");
    saveState(); render();
  });
  document.getElementById("sportModal").addEventListener("click", (e) => {
    if(e.target.id === "sportModal") document.getElementById("sportModal").classList.remove("open");
  });

  (function setupDobBounds(){
    const dobInp = document.getElementById("inDob");
    const today = new Date();
    const pad = n => String(n).padStart(2, "0");
    const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
    dobInp.max = iso(today.getFullYear() - 4, today.getMonth() + 1, today.getDate());
    dobInp.min = iso(today.getFullYear() - 90, today.getMonth() + 1, today.getDate());
  })();

  (function setupQuickNav(){
    const navBtns = Array.from(document.querySelectorAll(".quicknav button"));
    const sections = navBtns
      .map(b => document.getElementById(b.dataset.target))
      .filter(Boolean);

    navBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        const target = document.getElementById(btn.dataset.target);
        if(!target) return;
        const navHeight = document.getElementById("quicknav").offsetHeight;
        const top = target.getBoundingClientRect().top + window.pageYOffset - navHeight - 10;
        window.scrollTo({ top, behavior: "smooth" });
      });
    });

    if("IntersectionObserver" in window && sections.length){
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if(!entry.isIntersecting) return;
          const btn = navBtns.find(b => b.dataset.target === entry.target.id);
          if(!btn) return;
          navBtns.forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
        });
      }, { rootMargin: "-56px 0px -70% 0px", threshold: 0 });
      sections.forEach(sec => observer.observe(sec));
    }

    const backBtn = document.getElementById("backToTop");
    window.addEventListener("scroll", () => {
      backBtn.classList.toggle("show", window.scrollY > 600);
    });
    backBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  })();
})();
