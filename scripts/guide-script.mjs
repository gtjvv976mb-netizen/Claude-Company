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
 */
export const CHAPTERS = [
  { id: "hook", title: "The desk", beats: [
    { say: "Sixteen analysts. One trading desk. Real money on Solana." },
    { say: "This is the fiftieth floor, and everything you're about to see is live.", spot: ".deskline, #deskline" },
  ] },
  { id: "tower", title: "The tower", page: "tower", beats: [
    { say: "Claude Tower. Fifty floors, one desk on each." },
    { say: "The house desk works upstairs on fifty. It studies new coins all day, and publishes the few it would actually trade." },
  ] },
  { id: "lease", title: "Lease a floor", beats: [
    { say: "Any vacant floor can be yours. One floor per wallet.", act: async (p, h) => h.selectVacant() },
    { say: "And right beside the price: the house bot's own record, with the house's own money." },
  ] },
  { id: "enter", title: "Step inside", page: "floor", beats: [
    { say: "Step inside. The house floor is open to everyone, no sign-in needed." },
    { say: "Every character here is an analyst, and every one of them has a job." },
  ] },
  { id: "funnel", title: "The funnel", beats: [
    { say: "Watch the counter along the bottom.", spot: ".deskline, #deskline" },
    { say: "Coins studied today, coins turned down, and the few still on watch. Most of them die right here, and that is the point.", spot: ".deskline, #deskline" },
  ] },
  { id: "callouts", title: "Big Callers", beats: [
    { say: "Big Callers is the raw feed — everything the desk has spotted.", act: async (p, h) => h.tab("callouts") },
    { say: "None of these is a call yet." },
  ] },
  { id: "candidates", title: "Candidates", beats: [
    { say: "Candidates are the shortlist, waiting to be studied.", act: async (p, h) => { await h.tab("calls"); await h.sub("calls", "candidates"); } },
  ] },
  { id: "published", title: "The calls", beats: [
    { say: "A published call carries three numbers.", act: async (p, h) => h.sub("calls", "published") },
    { say: "An entry, a stop, and a target. That is what your bot acts on — nothing vaguer than that." },
  ] },
  { id: "closed", title: "How it ended", beats: [
    { say: "Closed shows how each one ended, and the coins the desk turned down.", act: async (p, h) => h.sub("calls", "closed") },
  ] },
  { id: "overview", title: "The money", beats: [
    { say: "The Overview is the money view.", act: async (p, h) => h.tab("overview") },
    { say: "Profit and loss, straight out of the bot's own journal." },
    { say: "Open positions draw as a bar: where it got in, the stop below, the target above.", act: async (p, h) => h.scroll(".bot-book"), spot: ".bot-book" },
  ] },
  { id: "wallste", title: "WALL-ST-E", beats: [
    { say: "Wall Street E is the bot itself.", act: async (p, h) => h.tab("wallste") },
    { say: "Your wallet, your caps, running on your own machine. The key is made there and never leaves it." },
  ] },
  { id: "hawkai", title: "HAWK-AI", beats: [
    { say: "Hawk A I is the second lane — a sniper that watches brand new launches.", act: async (p, h) => h.tab("hawkai") },
  ] },
  { id: "activity", title: "The receipts", beats: [
    { say: "Activity is the receipt.", act: async (p, h) => h.tab("activity") },
    { say: "The tape, every decision the desk made, and the ledger underneath it." },
  ] },
  { id: "performance", title: "Who is right", beats: [
    { say: "Performance ranks the analysts on one thing: whether they were actually right.", act: async (p, h) => h.tab("performance") },
  ] },
  { id: "team", title: "Your track", beats: [
    { say: "Team is who works your floor.", act: async (p, h) => h.tab("team") },
    { say: "It is also where you choose who runs your bot — and you can run it yourself, with one command.", act: async (p, h) => h.scroll("[data-runner-option], #teamcontrolpanel") },
  ] },
  { id: "board", title: "Big C's board", beats: [
    { say: "And up on the wall, Big C keeps the live book.", act: async (p, h) => h.closeRail() },
    { say: "Every open trade, every close, redrawn every ten seconds." },
  ] },
  { id: "end", title: "Plug in", beats: [
    { say: "Lease a floor. Plug in your own bot. Let it work." },
  ] },
];
