(function(){
  "use strict";

  // ---------- supabase client & auth ----------
  const supabaseClient = window.supabase.createClient(
    window.TOTEM_CONFIG.SUPABASE_URL,
    window.TOTEM_CONFIG.SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: true } } // require login every time the app is opened
  );
  const CLUB_STATE_ROW_ID = 1;
  let currentUser = null;

  function showApp(user){
    currentUser = user;
    document.getElementById("authShell").style.display = "none";
    document.getElementById("appRoot").style.display = "";
    document.getElementById("headerAccount").style.display = "flex";
    document.getElementById("headerAccountEmail").textContent = user.email;
    loadState();
  }
  function showAuth(){
    currentUser = null;
    document.getElementById("appRoot").style.display = "none";
    document.getElementById("headerAccount").style.display = "none";
    document.getElementById("authShell").style.display = "flex";
  }
  function authError(msg){
    const el = document.getElementById("authError");
    el.textContent = msg;
    el.style.display = "block";
  }

  async function handleLogin(){
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;
    document.getElementById("authError").style.display = "none";
    if(!email || !password){ authError("Enter your email and password."); return; }
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if(error){ authError(error.message); return; }
    showApp(data.user);
  }
  document.getElementById("btnLogin").addEventListener("click", handleLogin);
  document.getElementById("authPassword").addEventListener("keydown", (e) => { if(e.key === "Enter") handleLogin(); });
  document.getElementById("btnLogout").addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    showAuth();
  });

  // persistSession is off, so this will normally find nothing and show the
  // login screen — but check anyway in case a session is still live in-memory.
  supabaseClient.auth.getSession().then(({ data }) => {
    if(data.session && data.session.user) showApp(data.session.user);
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

  const DEFAULT_SPORTS = [
    { id:"netball", name:"Netball", icon:"🏐", type:"team", positions:["GS","GA","WA","C","WD","GD","GK"] },
    { id:"hockey", name:"Field Hockey", icon:"🏑", type:"team", positions:["Goalkeeper","Right Back","Left Back","Right Half","Left Half","Right Wing","Centre Forward","Left Wing"] },
    { id:"swimming", name:"Swimming", icon:"🏊", type:"individual", positions:["Freestyle","Backstroke","Breaststroke","Butterfly","Individual Medley"] },
    { id:"athletics", name:"Athletics", icon:"🏃", type:"individual", positions: ATHLETICS_ALL_EVENTS, eventsByAgeGroup: ATHLETICS_EVENTS_BY_AGE_GROUP }
  ];
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
  let dashboardAgeGroup = null;
  let resultDraft = null;

  // ---------- storage ----------
  async function fetchClubState(){
    const { data, error } = await supabaseClient
      .from("club_state")
      .select("data")
      .eq("id", CLUB_STATE_ROW_ID)
      .single();
    if(error){
      console.warn("Totem: could not load club data —", error.message);
      return null;
    }
    return data ? data.data : null;
  }
  async function persistClubState(){
    const { error } = await supabaseClient
      .from("club_state")
      .update({ data: state, updated_at: new Date().toISOString(), updated_by: currentUser ? currentUser.id : null })
      .eq("id", CLUB_STATE_ROW_ID);
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
  function coachFor(sportId, group){
    return state.coaches.find(c => c.sportId === sportId && groupsMatch(c.ageGroup, group));
  }

  function populateCoachAgeGroupSelect(){
    const sport = currentSport();
    const groups = ageGroupsForSport(sport.id);
    const sel = document.getElementById("inCoachAgeGroup");
    const current = sel.value;
    sel.innerHTML = groups.map(g => `<option value="${g}">${g}</option>`).join("");
    sel.value = groups.includes(current) ? current : groups[0];
  }

  function renderCoaches(){
    const sport = currentSport();
    populateCoachAgeGroupSelect();

    const list = coachesForSport(sport.id);
    const orderedGroups = sortAgeGroups(list.map(c => c.ageGroup));
    list.sort((a,b) => orderedGroups.indexOf(a.ageGroup) - orderedGroups.indexOf(b.ageGroup));

    const grid = document.getElementById("coachGrid");

    if(list.length === 0){
      grid.innerHTML = `<div class="roster-empty" style="grid-column:1/-1;">
        <span class="glyph">🧑‍🏫</span>
        <h3>No head coaches assigned</h3>
        <div>Assign a head coach to each age group above so everyone knows who's leading which team.</div>
      </div>`;
      return;
    }

    grid.innerHTML = list.map(c => `
      <div class="pick-card coach-card">
        <div class="pos">${escapeHtml(c.ageGroup)}</div>
        <div class="pname">${escapeHtml(c.name)}</div>
        <div class="page">${escapeHtml(c.email || "")}</div>
        ${c.phone ? `<div class="page">${escapeHtml(c.phone)}</div>` : ""}
        <button class="btn btn-danger btn-small" data-action="remove-coach" data-id="${c.id}" style="margin-top:10px;">Remove</button>
      </div>
    `).join("");

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
    const nameInp = document.getElementById("inCoachName");
    const emailInp = document.getElementById("inCoachEmail");
    const phoneInp = document.getElementById("inCoachPhone");
    const ageGroupVal = ageGroupInp.value.trim();
    const name = nameInp.value.trim();
    const email = emailInp.value.trim();
    const phone = phoneInp.value.trim();

    if(!ageGroupVal){ alert("Enter an age group, e.g. U11 or Senior."); ageGroupInp.focus(); return; }
    if(!name){ alert("Enter the coach's name."); nameInp.focus(); return; }
    if(!email){ alert("Enter the coach's email — it's required so they can receive automatic result notifications."); emailInp.focus(); return; }
    if(!isValidEmail(email)){ alert("Enter a valid email address."); emailInp.focus(); return; }

    const existing = state.coaches.find(c => c.sportId === sport.id && groupsMatch(c.ageGroup, ageGroupVal));
    if(existing){
      existing.name = name;
      existing.email = email;
      existing.phone = phone;
    } else {
      state.coaches.push({ id: uid(), sportId: sport.id, ageGroup: ageGroupVal, name, email, phone });
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
      btn.innerHTML = `<span class="icon">${s.icon || "🏅"}</span><span>${escapeHtml(s.name)}</span>`;
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
    document.getElementById("togglePositions").textContent = `⚙ manage ${noun.toLowerCase()}`;
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
        <span class="glyph">🪵</span>
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
              <div class="meta">${formatDob(p.birthDate)} · ${ageGroupForPlayer(p)}${p.dobEstimated ? ' <span class="dob-estimated" title="Estimated during migration — edit with a real date of birth when convenient">⚠ estimated DOB</span>' : ""}</div>
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
    return `<div class="metrics-panel">${dobRow}${rows}</div>`;
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
        <span class="glyph">🏆</span>
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
        <span class="glyph">🎽</span>
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
      coachBanner.textContent = `🧑‍🏫 Head coach — ${sidesActiveAgeGroup}: ${sidesCoach.name}${sidesCoach.email ? " (" + sidesCoach.email + ")" : ""}`;
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
          <button class="print-btn" data-action="print-team" data-sport="${sport.id}" data-group="${escapeHtml(sidesActiveAgeGroup)}" data-side="${letter}" title="Print team sheet" type="button">🖨</button>
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
        <span class="glyph">🎽</span>
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
      cell.innerHTML = `
        <div class="cal-daynum">${day}${birthdayPlayers.length ? ` <span class="cal-birthday-flag" title="🎂 ${escapeHtml(birthdayPlayers.map(p => p.name + ' (' + ageGroupForPlayer(p) + ')').join(', '))}">🎂</span>` : ""}</div>
        <div class="cal-chips">
          ${dayFixtures.map(f => `<button class="fixture-chip" data-id="${f.id}">${escapeHtml(f.opponent)}</button>`).join("")}
          ${dayTrials.map(t => `<button class="fixture-chip trial-chip" data-trial-id="${t.id}">🏁 ${escapeHtml(t.name)}</button>`).join("")}
        </div>
        ${birthdayPlayers.length ? `<div class="cal-birthday-names">${birthdayPlayers.map(p => escapeHtml(p.name + ' (' + ageGroupForPlayer(p) + ')')).join(", ")}</div>` : ""}
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

  function fixtureEntryChip(sport, f, entry){
    const result = resultFor(f.id, entry.ageGroup, entry.side);
    const entryLabel = seniorSideLabel(sport, entry.ageGroup, entry.side) || `${entry.ageGroup} ${entry.side}`;
    let label, cls;
    if(!result){
      label = `${entryLabel} · Add result`;
      cls = "fx-chip pending";
    } else if(sportType(sport) === "individual"){
      const count = (result.entries || []).length;
      label = `${entryLabel} · ${count} logged`;
      cls = "fx-chip done";
    } else {
      const outcome = result.ourScore > result.theirScore ? "win" : result.ourScore < result.theirScore ? "loss" : "draw";
      const short = outcome === "win" ? "W" : outcome === "loss" ? "L" : "D";
      label = `${entryLabel} · ${short} ${result.ourScore}–${result.theirScore}`;
      cls = `fx-chip done outcome-${outcome}`;
    }
    return `<button class="${cls}" data-fixture="${f.id}" data-group="${escapeHtml(entry.ageGroup)}" data-side="${entry.side}" type="button">${escapeHtml(label)}</button>`;
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
        <span class="glyph">🗓️</span>
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
              <div class="fixture-opp">🏁 ${escapeHtml(t.name)}</div>
              ${t.venue ? `<div class="fixture-venue">${escapeHtml(t.venue)}</div>` : ""}
              <div class="fixture-groups">${t.ageGroups.map(g => trialEntryChip(t, g)).join("")}</div>
            </div>
            <div class="fixture-card-actions">
              <button class="btn btn-ghost btn-small" data-action="view-trial" data-id="${t.id}">${openTrialId === t.id ? "Hide results" : "View results"}</button>
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
            ${f.venue ? `<div class="fixture-venue">${escapeHtml(f.venue)}</div>` : ""}
            <div class="fixture-groups">${f.entries.map(en => fixtureEntryChip(sport, f, en)).join("")}</div>
          </div>
          <div class="fixture-card-actions">
            <button class="btn btn-ghost btn-small" data-action="view-fixture" data-id="${f.id}">${openFixtureId === f.id ? "Hide teams" : "View teams"}</button>
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
          <h2>🏁 ${escapeHtml(t.name)}</h2>
          <span class="sub">${dateLabel}${t.venue ? " · " + escapeHtml(t.venue) : ""}</span>
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
      const groupCoach = coachFor(sport.id, group);
      const slots = groupPositions
        .map(pos => slotEditableHtml(sport.id, group, side, pos, positions[pos]))
        .join("");

      const seniorLabel = seniorSideLabel(sport, group, side);
      const teamSheet = `
        <div class="side-card">
          <div class="side-head">
            <span class="letter">${seniorLabel || (escapeHtml(group) + " · " + side)}</span>
            <span class="side-name">${groupCoach ? "Coach: " + escapeHtml(groupCoach.name) : "Best available team"}</span>
            <button class="print-btn" data-action="print-team" data-sport="${sport.id}" data-group="${escapeHtml(group)}" data-side="${side}" title="Print team sheet" type="button">🖨</button>
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
        <span class="sub">${dateLabel}${f.venue ? " · " + escapeHtml(f.venue) : ""}</span>
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
  function trialEntryChip(t, group){
    const result = trialResultFor(t.id, group);
    const count = result ? (result.entries || []).length : 0;
    const label = count ? `${group} · ${count} logged` : `${group} · Add results`;
    const cls = count ? "fx-chip done" : "fx-chip pending";
    return `<button class="${cls}" data-trial="${t.id}" data-group="${escapeHtml(group)}" type="button">${escapeHtml(label)}</button>`;
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
    showToast(`🏁 Trial results saved for ${trialResultDraft.ageGroup} — team rankings updated.`);
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
        <button class="btn btn-ghost btn-small" data-action="capture-result" data-fixture="${f.id}" data-group="${escapeHtml(group)}" data-side="${side}">Edit result</button>
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
      <button class="btn btn-ghost btn-small" data-action="capture-result" data-fixture="${f.id}" data-group="${escapeHtml(group)}" data-side="${side}">Edit result</button>
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
        warningPrefix = `⚠️ Scorer goals (${scorerTotal}) don't match the score (${resultDraft.ourScore}). `;
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
        <span class="glyph">📊</span>
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
      const coach = coachFor(r.sportId, r.ageGroup);
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
        <span class="glyph">🏅</span>
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
            <span class="clb-name">${i === 0 ? "🏆 " : ""}${escapeHtml(c.name)}<span class="clb-sub">${escapeHtml(c.assignments.join(", "))}</span></span>
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

  function printTeamSheet(title, subtitle, rows, bench){
    const win = window.open("", "_blank", "width=700,height=900");
    if(!win){ alert("Please allow pop-ups to print the team sheet."); return; }
    const rowsHtml = rows.map(r => `<tr><td>${escapeHtml(r.position)}</td><td>${escapeHtml(r.name)}</td></tr>`).join("");
    win.document.write(`<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif; padding:32px; color:#14201A;}
        h1{font-size:22px; margin:0 0 2px;}
        .sub{color:#5B6B63; font-size:13px; margin-bottom:22px;}
        table{width:100%; border-collapse:collapse;}
        td{padding:9px 10px; border-bottom:1px solid #ddd; font-size:14px;}
        td:first-child{font-weight:700; width:130px; color:#5B6B63; text-transform:uppercase; font-size:11px; letter-spacing:0.04em;}
        .bench{margin-top:22px; font-size:13px; color:#5B6B63;}
        .footer{margin-top:36px; font-size:10px; color:#999;}
        @media print{ body{padding:0;} }
      </style></head><body>
      <h1>${escapeHtml(title)}</h1>
      <div class="sub">${escapeHtml(subtitle)}</div>
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
    let subtitle;
    if(fixture){
      const dateLabel = new Date(fixture.date + "T00:00:00").toLocaleDateString(undefined,{weekday:"long", day:"numeric", month:"long", year:"numeric"});
      subtitle = `vs ${fixture.opponent} · ${dateLabel}${fixture.venue ? " · " + fixture.venue : ""}`;
    } else {
      subtitle = "Team Sides";
    }
    printTeamSheet(title, subtitle, rows, bench);
  }

  // ---------- notification preview ----------
  // NOTE: this is a UI preview only — sending real email requires a backend
  // (see the chat writeup for how this plugs into Supabase).
  // ---------- result notification email (real send via Edge Function) ----------
  async function sendResultNotification(sport, fixture, result, warningPrefix){
    const notifyCoach = coachFor(result.sportId, result.ageGroup);
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
      showToast(`${warningPrefix || ""}📧 ${resultLabel} result emailed to${notifyCoach ? " " + notifyCoach.email + " +" : ""} the team.`);
    }catch(e){
      console.warn("Totem: result email failed —", e);
      showToast(`${warningPrefix || ""}⚠️ Result saved, but the notification email failed to send. Check your Edge Function is deployed.`);
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
          <input type="checkbox" data-group="${g}" checked>
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
                <input type="checkbox" data-group="${g}" data-side="${side}" ${side === "A" ? "checked" : ""}>
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

  function openAddFixtureModal(prefillDate){
    const sport = currentSport();
    const isIndividual = sportType(sport) === "individual";
    document.getElementById("fxDate").value = prefillDate || isoDate(new Date());
    document.getElementById("fxOpponent").value = "";
    document.getElementById("fxVenue").value = "";

    document.getElementById("fxTypeField").style.display = isIndividual ? "" : "none";
    const matchRadio = document.querySelector('input[name="fxType"][value="match"]');
    if(matchRadio) matchRadio.checked = true;
    updateFixtureModalForType(sport, "match");

    document.getElementById("fixtureModal").classList.add("open");
  }
  document.querySelectorAll('input[name="fxType"]').forEach(radio => {
    radio.addEventListener("change", (e) => updateFixtureModalForType(currentSport(), e.target.value));
  });

  document.getElementById("btnAddFixture").addEventListener("click", () => openAddFixtureModal());
  document.getElementById("calPrev").addEventListener("click", () => { calendarDate.setMonth(calendarDate.getMonth()-1); renderCalendar(); });
  document.getElementById("calNext").addEventListener("click", () => { calendarDate.setMonth(calendarDate.getMonth()+1); renderCalendar(); });
  document.getElementById("cancelFixture").addEventListener("click", () => document.getElementById("fixtureModal").classList.remove("open"));
  document.getElementById("fixtureModal").addEventListener("click", (e) => { if(e.target.id === "fixtureModal") document.getElementById("fixtureModal").classList.remove("open"); });
  document.getElementById("confirmFixture").addEventListener("click", () => {
    const sport = currentSport();
    const typeInput = document.querySelector('input[name="fxType"]:checked');
    const type = (sportType(sport) === "individual" && typeInput) ? typeInput.value : "match";
    const date = document.getElementById("fxDate").value;
    const label = document.getElementById("fxOpponent").value.trim();
    const venue = document.getElementById("fxVenue").value.trim();

    if(!date){ alert("Pick a date."); return; }
    if(!label){ alert(type === "trial" ? "Enter a name for the trial." : "Enter the opponent's name."); return; }

    if(type === "trial"){
      const ageGroups = Array.from(document.querySelectorAll("#fxAgeGroups input[type=checkbox]:checked")).map(cb => cb.dataset.group);
      if(ageGroups.length === 0){ alert("Select at least one age group."); return; }
      state.trials.push({ id: uid(), sportId: sport.id, date, name: label, venue, ageGroups });
    } else {
      const entries = Array.from(document.querySelectorAll("#fxAgeGroups input[type=checkbox]:checked"))
        .filter(cb => cb.dataset.side)
        .map(cb => ({ ageGroup: cb.dataset.group, side: cb.dataset.side }));
      if(entries.length === 0){ alert("Select at least one age group and side."); return; }
      state.fixtures.push({ id: uid(), sportId: sport.id, date, opponent: label, venue, entries });
    }

    document.getElementById("fixtureModal").classList.remove("open");
    saveState();
    renderCalendar(); renderFixtureList(); renderFixtureDetail();
  });

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
  }

  // ---------- events ----------
  document.getElementById("btnAddPlayer").addEventListener("click", () => {
    const nameInp = document.getElementById("inName");
    const dobInp = document.getElementById("inDob");
    const sport = currentSport();
    const isIndividual = sportType(sport) === "individual";
    const name = nameInp.value.trim();
    const birthDate = dobInp.value;
    const turning = turningAgeFromBirthDate(birthDate);

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
      name, birthDate, positions,
      metrics
    });
    nameInp.value = ""; dobInp.value = "";
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

  function openSportModal(){
    document.getElementById("sportModal").classList.add("open");
    document.getElementById("newSportName").value = "";
    document.getElementById("newSportPositions").value = "";
    const teamRadio = document.querySelector('input[name="newSportType"][value="team"]');
    if(teamRadio) teamRadio.checked = true;
    document.getElementById("newSportPositionsLabel").textContent = "Positions (comma separated)";
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
  document.getElementById("confirmSport").addEventListener("click", () => {
    const name = document.getElementById("newSportName").value.trim();
    const posRaw = document.getElementById("newSportPositions").value.trim();
    if(!name){ alert("Enter a sport name."); return; }
    const positions = posRaw ? posRaw.split(",").map(s => s.trim()).filter(Boolean) : ["Player"];
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g,"-") + "-" + uid().slice(0,4);
    const typeInput = document.querySelector('input[name="newSportType"]:checked');
    const type = typeInput ? typeInput.value : "team";
    state.sports.push({ id, name, icon:"🏅", type, positions });
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
