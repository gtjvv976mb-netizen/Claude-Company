/* WHAT THE GUIDE SAYS, AND WHAT THE CAMERA DOES WHILE IT SAYS IT.
 *
 * Its own module, with NO imports at all, and that is the whole point: test-guide.mjs
 * checks the committed recording still says what this script says, and when this data
 * lived inside record-guide.mjs that check dragged in `playwright` with it. Playwright is
 * not a dependency of this project — it is installed by hand to re-record — so the test
 * passed on a machine that happened to have it and threw ERR_MODULE_NOT_FOUND under
 * `npm ci`. That took the whole suite down, and because the suite is the site's build
 * step and Render's buildCommand, it froze the deploy (pages.yml run 503, 2026-09-14).
 *
 * A beat is one spoken sentence, the camera move it describes, and the element it is
 * about. `act` receives the page and the recorder's helpers; it never imports a browser.
 *
 * THE COMPREHENSIVE CUT (owner, 2026-09-15: "the most comprehensive guide ever … actually
 * follows what the narrative teaches"). Every tab and every subview, in the order a new
 * tenant meets them, and nothing named that is not on screen while it is named: a
 * subview beat clicks that subview, a "three numbers" beat rings the call sheet, the
 * sniper's "is he running" beat rings the live block that answers it. Each sentence is
 * one idea, spoken, not written — a viewer should be able to look up from the phone at
 * any beat and see exactly the thing being talked about.
 *
 * Selectors and subview names are the page's own (DASHBOARD_PANEL ids, data-*-view
 * attributes) and every helper exists in record-guide.mjs; a beat that names a thing the
 * page does not have is a beat the spotlight silently skips, so keep them real.
 */
export const CHAPTERS = [
  /* ── ACT ONE · THE HOOK, AND WHAT THIS PLACE IS ─────────────────────────────────── */
  { id: "hook", title: "The desk", beats: [
    { say: "Sixteen analysts. One trading desk. Real money on Solana." },
    { say: "This is the fiftieth floor, and everything you're about to see is live right now.", spot: ".deskline, #deskline" },
    { say: "In three minutes you'll know how a coin becomes a call, how a call becomes a trade, and how to run the whole thing yourself." },
  ] },
  { id: "tower", title: "The tower", page: "tower", beats: [
    { say: "Claude Tower. Fifty floors, one desk on each." },
    { say: "The house desk works upstairs on fifty. It studies new coins all day and publishes only the few it would actually trade." },
    { say: "Every other floor is a tenant running that same desk, on their own wallet." },
  ] },
  { id: "lease", title: "Lease a floor", beats: [
    { say: "Any vacant floor can be yours. One floor per wallet.", act: async (p, h) => h.selectVacant() },
    { say: "Here's the price, and right beside it the house bot's own record — its real trades, with the house's own money." },
    { say: "Nothing on this card is a promise. It's a journal." },
  ] },

  /* ── ACT TWO · THE FLOOR, AND HOW A CALL IS MADE ────────────────────────────────── */
  { id: "enter", title: "Step inside", page: "floor", beats: [
    { say: "Step inside. The house floor is open to everyone, no sign-in needed." },
    { say: "Every character here is an analyst, and every one of them has a job — reading launches, checking holders, hunting for the reasons to say no." },
  ] },
  { id: "funnel", title: "The funnel", beats: [
    { say: "Watch the counter along the bottom. That's the funnel, and it's the heart of the desk.", spot: ".deskline, #deskline" },
    { say: "Coins studied today. Coins turned down. And the few still on watch.", spot: ".deskline, #deskline" },
    { say: "Most coins die right here, on purpose. The desk's job is refusal, not speed." },
  ] },
  { id: "callouts", title: "Big Callers", beats: [
    { say: "Big Callers is the raw feed — everything the desk has spotted, before anyone has judged it.", act: async (p, h) => h.tab("callouts"), spot: "#calloutspanel" },
    { say: "None of these is a call yet. Think of it as the in-tray." },
  ] },
  { id: "candidates", title: "Candidates", beats: [
    { say: "Candidates are the shortlist — coins that survived the first cut and are waiting to be studied.", act: async (p, h) => { await h.tab("calls"); await h.sub("calls", "candidates"); }, spot: "#callsworkspace" },
    { say: "Still not calls. Still no money. Just the ones worth a closer look." },
  ] },
  { id: "published", title: "The calls", beats: [
    { say: "And this is a published call. It carries three numbers, and only three.", act: async (p, h) => h.sub("calls", "published"), spot: "#callsworkspace" },
    { say: "An entry. A stop below it. A target above it." },
    { say: "That's what your bot acts on. Nothing vaguer than that, ever." },
  ] },
  { id: "closed", title: "How it ended", beats: [
    { say: "Closed shows how every call ended — and the coins the desk turned down, so you can see what it refused as well as what it took.", act: async (p, h) => h.sub("calls", "closed"), spot: "#callsworkspace" },
  ] },

  /* ── ACT THREE · THE MONEY, AND THE TWO BOTS ────────────────────────────────────── */
  { id: "overview", title: "The money", beats: [
    { say: "The Overview is the money view.", act: async (p, h) => h.tab("overview"), spot: "#overviewpanel" },
    { say: "Profit and loss, straight out of the bot's own journal — not the desk's paper, the bot's actual fills." },
    { say: "Every open position draws as a bar: where it got in, the stop below, the target above, and a dot for where the coin is now.", act: async (p, h) => h.scroll(".bot-book"), spot: ".bot-book" },
    { say: "Closed trades draw the same way, so you can see at a glance how far each one ran, and which way." },
  ] },
  { id: "wallste", title: "WALL-ST-E", beats: [
    { say: "Wall Street E is the bot itself — the thing that takes the calls.", act: async (p, h) => h.tab("wallste"), spot: "#wallstepanel" },
    { say: "It runs on your own machine, with a wallet whose key is made there and never leaves it. The desk never holds it." },
    { say: "You set the caps: how much per trade, how much per day, and where it stops if a day goes badly." },
    { say: "Those caps are hard ceilings in the code, not suggestions on a screen." },
  ] },
  { id: "hawkai", title: "HAWK-AI", beats: [
    { say: "Hawk A I is the second lane — a sniper aimed at brand-new launches in their first seconds.", act: async (p, h) => h.tab("hawkai"), spot: "#hawkaipanel" },
    { say: "Two dials: how much per trade, and the multiple of your entry at which he sells. Both refused if they don't add up." },
    { say: "And this box answers the question every floor asks — is he actually running, and if not, why not.", act: async (p, h) => h.scroll(".hawk-live"), spot: ".hawk-live" },
    { say: "A sniper that stopped tells you here, in its own words. It never goes quiet." },
  ] },

  /* ── ACT FOUR · THE RECEIPTS, AND WHO IS RIGHT ──────────────────────────────────── */
  { id: "activity", title: "The receipts", beats: [
    { say: "Activity is the receipt for everything.", act: async (p, h) => h.tab("activity"), spot: "#activityworkspace" },
    { say: "The Tape is the live stream — every move the floor makes, as it makes it.", act: async (p, h) => h.sub("activity", "tape"), spot: "#activityworkspace" },
    { say: "Decisions is every verdict an analyst reached, and the reason they gave.", act: async (p, h) => h.sub("activity", "decisions"), spot: "#activityworkspace" },
    { say: "And the Ledger is the money underneath it all, line by line.", act: async (p, h) => h.sub("activity", "ledger"), spot: "#activityworkspace" },
  ] },
  { id: "performance", title: "Who is right", beats: [
    { say: "Performance keeps score.", act: async (p, h) => h.tab("performance"), spot: "#performanceworkspace" },
    { say: "The Building is the whole tower's record — calls published, calls live, and the realised result across every floor.", act: async (p, h) => h.sub("performance", "building"), spot: "#performanceworkspace" },
    { say: "And the Leaderboard ranks the analysts on one thing only: whether they were actually right.", act: async (p, h) => h.sub("performance", "ranks"), spot: "#performanceworkspace" },
  ] },

  /* ── ACT FIVE · YOUR FLOOR ──────────────────────────────────────────────────────── */
  { id: "team", title: "Your track", beats: [
    { say: "Team is who works your floor — the sixteen analysts and the boss who signs off.", act: async (p, h) => h.tab("team"), spot: "#teampanel" },
    { say: "It's also where you choose who runs your bot. You can run it yourself, with one command, on a Mac or a small Linux server you own.", act: async (p, h) => h.scroll("[data-runner-option], #teamcontrolpanel") },
  ] },
  { id: "settings", title: "Settings", beats: [
    { say: "Settings holds your floor's own switches — what it takes, what it skips, and the pause that stops new buys without touching what's open.", act: async (p, h) => h.tab("settings"), spot: "#settingspanel" },
  ] },
  { id: "stops", title: "What stops it", beats: [
    { say: "Two files on your machine stop everything. One pauses new entries and lets open trades exit. The other halts the lot." },
    { say: "Both bots obey the same two files. Drop one, and both stop. That's the only rule worth remembering under pressure." },
  ] },
  { id: "board", title: "Big C's board", beats: [
    { say: "And up on the wall, Big C keeps the live book.", act: async (p, h) => h.closeRail() },
    { say: "Every open trade, every close, the day's result — redrawn every ten seconds, for anyone standing on the floor." },
  ] },
  { id: "end", title: "Plug in", beats: [
    { say: "So: the desk finds the coin. The call gives your bot three numbers. Your bot trades them with your money, on your machine." },
    { say: "Lease a floor. Plug in. Let it work." },
  ] },
];
