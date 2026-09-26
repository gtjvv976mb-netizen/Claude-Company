export const meta = {
  name: 'review-pr45-bagwork',
  description: 'Exhaustive adversarially-verified review of PR #45 (fee claim, fee lane, market floor, volume spike, config/install, agent pages)',
  whenToUse: 'Pre-merge review of a large multi-subsystem PR where false positives are costly',
  phases: [
    { title: 'Find', detail: 'two finders per area, then loop-until-dry rounds' },
    { title: 'Verify', detail: 'three lenses per finding: reproduce, refute, impact' },
    { title: 'Critic', detail: 'what did nobody check?' },
    { title: 'Gaps', detail: 'targeted find + verify on the critic\u2019s gaps' },
  ],
}

const CONTEXT = `
REPO: /home/user/claude-company  (NOT the session's primary directory). Branch claude/eloquent-mayer-3jwcyb.
The PR under review is the range 5646b1c..a8d885e (base main = 5646b1c, head = a8d885e, which is the current checkout).
Use: git -C /home/user/claude-company diff 5646b1c a8d885e -- <files>   and read the full current files.

SYSTEM: "Claude Co". A desk API (src/, Node, SQLite via src/lib/store.js, deployed on Render; entry src/index.js office -> src/office.js startOffice) and a
self-hosted trading executor (executor/, runs on the owner's Mac under launchd; entry executor/poller.mjs). HAWK-AI is the pump.fun launch sniper lane
(executor/snipe-*.mjs). The PR adds: pump.fun creator-fee claim (executor/pumpfun-fees.mjs, src/fee-claim.js, viewer/fees.html — the OWNER signs in
their own browser wallet, nothing server-side signs), a fee lane that only READS vaults (executor/fee-lane.mjs, FEE_CLAIM=dry), a market floor gate +
momentum feed source (executor/snipe-market.mjs), a volume-spike gate (executor/snipe-volume.mjs), env/install plumbing, and public agent pages with
levels/rewards/strategy builder (src/agent-desk.js, src/agent-store.js, viewer/agent.html, routes in src/office.js).

INTENDED DESIGN (not bugs by themselves — report only if the code FAILS its own stated intent, or the intent causes concrete harm):
- "Unknown is never zero": unmeasured values are null, and an armed threshold judging a null REFUSES.
- New dials ship OFF (SNIPE_MARKET_FLOOR=off, SNIPE_MIN_VOLUME_SPIKE unset, FEE_CLAIM=off). FEE_CLAIM=live is deliberately refused forever.
- /api/fees/* routes are deliberately ungated (public on-chain facts, only the creator can sign). Fee revenue and trading P&L are never summed.

HOW TO RUN THINGS:
- Root tests: cd /home/user/claude-company && node test-xxx.mjs.  Executor tests: cd /home/user/claude-company/executor && node test-xxx.mjs.
- @solana/web3.js and bs58 resolve ONLY from executor/node_modules. An ad-hoc script needing them must live INSIDE /home/user/claude-company/executor/
  (name it .review-<yourlabel>-<n>.mjs) and you MUST delete it when done. Scripts importing src/ must set CLAUDE_CO_DB to a throwaway file
  (e.g. $(mktemp -d)/x.db) — never the live DB.
- You may boot the desk locally to check a route at runtime (import src/office.js and call startOffice(<free port>) with CLAUDE_CO_DB set, then curl it;
  kill it after). You may run a headless browser only if trivial; otherwise reason from the code.
- Network: read-only public RPC (https://api.mainnet-beta.solana.com) and HTTP GETs are fine. NEVER sign or send a transaction. NEVER print env secrets.
- DO NOT modify, stage, commit or push any tracked file. Leave the working tree exactly as you found it.
`

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string', description: 'repo-relative path, e.g. executor/fee-lane.mjs' },
          line: { type: 'number', description: '1-indexed line in the CURRENT tree' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string' },
          scenario: { type: 'string', description: 'concrete inputs/state -> wrong outcome' },
          evidence: { type: 'string', description: 'quoted code and/or output of what you ran' },
          suggested_fix: { type: 'string' },
        },
        required: ['title', 'file', 'line', 'severity', 'scenario', 'evidence'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    reproduced: { type: 'boolean', description: 'true only if you demonstrated it by running code' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'not-a-bug'] },
    reasoning: { type: 'string' },
  },
  required: ['real', 'severity', 'reasoning'],
}

const GAPS = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          what: { type: 'string', description: 'the unchecked thing' },
          why: { type: 'string', description: 'why it could hide a real defect' },
          files: { type: 'array', items: { type: 'string' } },
          how_to_check: { type: 'string' },
        },
        required: ['what', 'why', 'files', 'how_to_check'],
      },
    },
  },
  required: ['gaps'],
}

const AREAS = [
  {
    key: 'fee-claim',
    files: ['executor/pumpfun-fees.mjs', 'src/fee-claim.js', 'viewer/fees.html', 'src/office.js (routes /api/fees/claimable and /api/fees/claim-ticket, and /api/pay/blockhash)', 'test-fee-claim.mjs', 'executor/test-pumpfun-fees.mjs'],
    hints: `This path moves real money. Check: account order and signer/writable flags of every instruction against the landed mainnet transactions the tests cite;
the wrapped-SOL create/close legs; rent arithmetic; how the query flags curve/amm reach claimTicket; and ESPECIALLY viewer/fees.html's browser runtime —
which globals actually exist in a browser (compare with how viewer/tower.html builds and sends a transaction), how wallet-standard wallets are really
discovered, how legacy Phantom's signAndSendTransaction is called, how signatures are encoded, and whether the creator/wallet mismatch guard can be bypassed
by clicking in a different order.`,
  },
  {
    key: 'fee-lane',
    files: ['executor/fee-lane.mjs', 'executor/poller.mjs (FEE_CLAIM block, feeStatus, feeHeartbeat)', 'executor/shadow-sink.mjs (feeBookPath)', 'src/office.js (sanitizeExecutorFees, heartbeat intake of fees, the "fees" emit)', 'executor/test-fee-lane.mjs'],
    hints: `Check the poller block at runtime order: are kp, conn, hardStop, STATE_DB, EXECUTE, log defined and initialised where the FEE_CLAIM block runs?
Does readTokenAmount/getBalance distinguish absent vs failed correctly for real RPC responses? Does feeHeartbeat ever throw into the heartbeat? Does the desk's
"new claim" detection double-emit or miss when the bot restarts (counters reset to 0)? Does the fee book grow without bound? Are FEE_CLAIM_* dials actually
carried by install.sh and allowed by launchd-runner.mjs?`,
  },
  {
    key: 'market-floor',
    files: ['executor/snipe-market.mjs', 'executor/snipe-entry.mjs (market_floor gate, snipeContract signature)', 'executor/snipe-lane.mjs (marketReader/solUsdReader ports, marketPromise, marketReadFor, snipeLaneConfig floor assembly, construction refusal)', 'executor/snipe-feed.mjs (pumpfunListingFetcher sort/order, pumpfunRowToNotice, pollSource, the feed dedupe/staleness/source-health logic)', 'executor/poller.mjs (momentum source, momentumDedupeConflict guard, dexPairsFor import)', 'executor/dexscreener-consensus.mjs (pairsFor)', 'executor/test-snipe-market.mjs'],
    hints: `Trace a momentum-source candidate END TO END: listing row -> pumpfunRowToNotice (originAtMs = created_timestamp, hours ago) -> feed (does any feed logic
treat a very old originAtMs as stale, lagging, or a degraded source?) -> lane.handleNotice -> gates (notice_stale uses which timestamp?) -> market_floor.
When the floor is armed it applies to LAUNCH notices too — what does that cost per minute in DexScreener requests at ~29 launches/min, and is any of it
wasted? Check units (ms vs s, lamports vs SOL, USD), the SOL/USD derivation, and every place a missing value could become 0 or NaN.`,
  },
  {
    key: 'volume-spike',
    files: ['executor/snipe-volume.mjs', 'executor/snipe-entry.mjs (volume_spike gate)', 'executor/snipe-lane.mjs (flowTape wiring, flow.observe/measure)', 'executor/snipe-feed.mjs (logsSubscribeSource observe hook)', 'executor/poller.mjs (createTradeTap, grpc source observe, eventsFromLogs import)', 'executor/snipe-shadow.mjs (volume_spike proxy)', 'executor/grade-entry-gates.mjs', 'executor/test-snipe-volume.mjs'],
    hints: `Check that the tape's samples (TradeEvent realQuoteRaw via the tap, and the account-decoded curve.realQuoteRaw via the lane) are the same quantity in
the same units; bucket coalescing with out-of-order or same-ms samples; measureSpike's window boundaries; memory bounds under ~29 launches/min all day;
that the gRPC notification objects the tap receives really carry .logs in the shape eventsFromLogs expects (read executor/snipe-grpc.mjs); and whether the
shadow-book proxy's inverted flag and the scorecard treat null correctly.`,
  },
  {
    key: 'config-install',
    files: ['executor/snipe-lane.mjs (SNIPE_ENV, snipeLaneConfig, MARKET_FLOOR_PRESETS)', 'executor/launchd-runner.mjs (ALLOWED_ENV, runtime file list)', 'executor/install.sh (carry loop, source_file loop, RUNTIME_FILES, CONTROLLER_DIR banner)', 'executor/macos-release.sh (RUNTIME_PATHS, the release-already-exists message)', 'executor/macos-launchagent.sh (ENV_CANDIDATES)', 'executor/heartbeat-health.mjs (fingerprint list)', 'scripts/build-viewer.mjs (EXECUTOR_FILES, PAGES)', 'executor/test-install.mjs', 'executor/test-launchd.mjs', 'executor/test-snipe-lane.mjs'],
    hints: `heartbeat-health.mjs says its list "must match what is loaded EXACTLY, in both directions" — does adding fee-lane.mjs / pumpfun-fees.mjs / snipe-market.mjs /
snipe-volume.mjs (some loaded only when a lane is on) break that on an install where the lane is off? Run bash -n on every changed shell file. Check the printf
usage in macos-release.sh (format strings, % in paths, newlines inside $(...) passed to fail). Is CONTROLLER_DIR set before the banner on BOTH platforms and on
upgrade vs fresh install? Could the new "preset" parse kind break any generic consumer of SNIPE_ENV that switches on spec.parse?`,
  },
  {
    key: 'agent-pages',
    files: ['src/agent-desk.js', 'src/agent-store.js', 'src/office.js (/api/agent/:floor routes, NAMED_EVENT_KINDS SSE naming, levelup/reward emits, heartbeat intake, houseBotPublic)', 'viewer/agent.html', 'test-agent-desk.mjs', 'test-agent-page.mjs'],
    hints: `The route tests are mostly source-greps, so a runtime ReferenceError would pass them: check that every identifier the new routes use (floorPrivate,
holdsFloor, me, readBody, json, houseBotPublic, tower, HQ_FLOOR, emit, leasing) is actually in scope at that point in the handler, ideally by booting the desk and
curling /api/agent/50 and /api/agent/50/strategy. Check the book field names the route reads against what sanitizeExecutorSnipe really emits. Check XSS in
agent.html (innerHTML with server data), the reward idempotency under concurrent requests, SSE event naming vs existing clients, and whether a signed-out
visitor can trigger DB writes or events on floors they cannot read.`,
  },
]

const norm = (p) => String(p || '').replace(/^\/home\/user\/claude-company\//, '').replace(/^\.\//, '').replace(/\s*\(.*$/, '').trim()
const words = (t) => new Set(String(t || '').toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 3))
const overlap = (a, b) => {
  const A = words(a), B = words(b)
  if (!A.size || !B.size) return 0
  let n = 0
  for (const w of A) if (B.has(w)) n++
  return n / Math.min(A.size, B.size)
}
const isDup = (f, seen) => seen.some((s) => norm(s.file) === norm(f.file) && Math.abs(Number(s.line) - Number(f.line)) <= 4 && overlap(s.title, f.title) >= 0.25)
const brief = (f) => `- [${f.severity}] ${norm(f.file)}:${f.line} — ${f.title}`

const finderPrompt = (area, angle, seen) => `${CONTEXT}
You are a code reviewer. AREA: ${area.key}. Review angle: ${angle}.

Files in scope (read the PR diff for them AND the full current files, plus any callers/callees you need):
${area.files.map((f) => '  - ' + f).join('\n')}

Area-specific things worth checking:
${area.hints}

Report only REAL defects: wrong behaviour, crashes, money loss or mis-accounting, security/privacy leaks, silent failures, broken wiring between modules,
or tests that assert the wrong thing so a real bug passes. NOT style, naming, comment wording, or "could be cleaner". Each finding needs the exact file and
line in the current tree, a concrete failure scenario, and evidence — quote the code, and prefer to RUN something that shows it. If you find nothing real,
return an empty list; an empty list is a good answer.
${seen.length ? `\nALREADY REPORTED for this area (do NOT repeat these or trivial variants of them — find different issues):\n${seen.map(brief).join('\n')}\n` : ''}`

const LENSES = [
  { key: 'reproduce', prompt: 'Your job is to REPRODUCE it. Demonstrate the failure concretely — run code if at all possible (a small script, a test, booting the server). Set reproduced=true only if you actually demonstrated it. Set real=true only if you reproduced it or traced the exact path with certainty.' },
  { key: 'refute', prompt: 'Your job is to REFUTE it. Look for a guard elsewhere, an unreachable path, a misread of the code, a wrong assumption about a library or API, or intended documented design. If you are uncertain, answer real=false.' },
  { key: 'impact', prompt: 'Assume the mechanism is exactly as described. Judge whether it causes an actual wrong outcome in PRODUCTION for this deployment (desk on Render, executor on the owner\u2019s Mac, pump.fun on mainnet, real browsers and wallets). real=false if it is harmless, cosmetic, or only reachable by the operator deliberately misconfiguring something they were warned about.' },
]

const verify = (f, areaKey) => parallel(LENSES.map((lens) => () =>
  agent(`${CONTEXT}
You are verifying ONE code-review finding from area ${areaKey}. ${lens.prompt}

FINDING:
title: ${f.title}
file: ${norm(f.file)}:${f.line}
claimed severity: ${f.severity}
scenario: ${f.scenario}
evidence: ${f.evidence}
${f.suggested_fix ? 'suggested fix: ' + f.suggested_fix : ''}

Read the actual code yourself; do not trust the evidence text. Return your verdict and, if real, the severity you would assign.`,
  { label: `verify:${lens.key}:${norm(f.file).split('/').pop()}:${f.line}`, phase: 'Verify', schema: VERDICT })))
  .then((votes) => {
    const v = votes.filter(Boolean)
    const yes = v.filter((x) => x.real)
    const order = { critical: 4, high: 3, medium: 2, low: 1, 'not-a-bug': 0 }
    const sev = yes.length ? yes.map((x) => x.severity).sort((a, b) => (order[a] || 0) - (order[b] || 0))[Math.floor((yes.length - 1) / 2)] : 'not-a-bug'
    return {
      ...f, file: norm(f.file), area: areaKey,
      confirmed: yes.length >= 2,
      votes: v.map((x, i) => ({ lens: LENSES[i] ? LENSES[i].key : '?', real: x.real, reproduced: !!x.reproduced, severity: x.severity, reasoning: x.reasoning })),
      reproduced: v.some((x) => x.reproduced && x.real),
      verifiedSeverity: sev,
    }
  })

const MAX_ROUNDS = 4

async function reviewArea(area) {
  const seen = []
  const verifications = []
  const rounds = []
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const angles = round === 1
      ? ['LOGIC — trace data flow, invariants, arithmetic, units, null/undefined handling and ordering inside these modules',
         'INTEGRATION & RUNTIME — how these modules connect to their callers and to each other at runtime (scope, imports, names, init order), hostile or edge inputs, and production conditions (restarts, outages, rate limits, real browsers/wallets)']
      : [`FRESH EYES (round ${round}) — anything real the already-reported list misses; pick a part of the scope nobody has covered yet`]
    const results = await parallel(angles.map((angle, i) => () =>
      agent(finderPrompt(area, angle, seen), { label: `find:${area.key}:r${round}${angles.length > 1 ? (i ? 'b' : 'a') : ''}`, phase: 'Find', schema: FINDINGS })))
    const found = results.filter(Boolean).flatMap((r) => r.findings || [])
    const fresh = []
    for (const f of found) if (!isDup(f, seen) && !isDup(f, fresh)) fresh.push(f)
    rounds.push({ round, found: found.length, fresh: fresh.length })
    log(`${area.key} round ${round}: ${found.length} found, ${fresh.length} new`)
    if (!fresh.length) break
    fresh.forEach((f) => seen.push(f))
    for (const f of fresh) verifications.push(verify(f, area.key))
    if (round === MAX_ROUNDS) log(`${area.key}: stopped at the ${MAX_ROUNDS}-round cap while still finding new issues — coverage may be incomplete`)
  }
  const judged = await Promise.all(verifications)
  return { area: area.key, rounds, judged }
}

phase('Find')
const areaResults = (await pipeline(AREAS, (a) => reviewArea(a))).filter(Boolean)
const allJudged = areaResults.flatMap((r) => r.judged)
let confirmed = allJudged.filter((f) => f.confirmed)
const rejected = allJudged.filter((f) => !f.confirmed)
log(`${allJudged.length} findings judged: ${confirmed.length} confirmed, ${rejected.length} rejected`)

phase('Critic')
const critic = await agent(`${CONTEXT}
You are the COMPLETENESS CRITIC for a review of this PR. Six areas were reviewed: ${AREAS.map((a) => a.key).join(', ')}.
Files per area:
${AREAS.map((a) => `  ${a.key}: ${a.files.join('; ')}`).join('\n')}

Confirmed findings so far:
${confirmed.map(brief).join('\n') || '(none)'}

Rejected findings (verifiers did not agree they were real):
${rejected.map(brief).join('\n') || '(none)'}

Per-area rounds: ${areaResults.map((r) => `${r.area}: ${r.rounds.map((x) => `r${x.round} ${x.fresh} new`).join(', ')}`).join(' | ')}

Identify what NOBODY actually checked that could hide a real defect: files in the diff that no area covered (run git diff --stat 5646b1c a8d885e yourself),
behaviours only asserted by source-grep tests rather than exercised, runtime modalities never used (booting the desk, running a page's browser JS,
running the poller with a lane enabled against fakes), cross-area interactions (e.g. market floor x volume spike x shadow scorecard, fee lane heartbeat x agent page),
and claims in the PR description that no test proves. Return at most 8 gaps, most dangerous first. Return an empty list if coverage is genuinely complete.`,
  { label: 'critic', phase: 'Critic', schema: GAPS })

const gaps = (critic && critic.gaps) ? critic.gaps : []
const MAX_GAPS = 8
if (gaps.length > MAX_GAPS) log(`critic named ${gaps.length} gaps; only the first ${MAX_GAPS} are investigated`)

phase('Gaps')
const seenAll = [...allJudged]
const gapJudged = (await pipeline(gaps.slice(0, MAX_GAPS),
  (g, _item, i) => agent(`${CONTEXT}
A completeness critic found a GAP in the review of this PR. Investigate it directly and report any REAL defects it hides.

GAP: ${g.what}
WHY IT MATTERS: ${g.why}
FILES: ${(g.files || []).join(', ')}
HOW TO CHECK: ${g.how_to_check}

Actually do the check (run code, boot the server, exercise the path) rather than re-reading. Report only real defects with exact file:line, a concrete
scenario and evidence. An empty list is a good answer.
ALREADY REPORTED (do not repeat):
${seenAll.map(brief).join('\n') || '(none)'}`, { label: `gap:${i + 1}`, phase: 'Gaps', schema: FINDINGS }),
  (r, g, i) => {
    const fresh = []
    for (const f of (r && r.findings) || []) if (!isDup(f, seenAll) && !isDup(f, fresh)) fresh.push(f)
    return Promise.all(fresh.map((f) => verify(f, `gap-${i + 1}`)))
  })).filter(Boolean).flat()

const allConfirmed = [...confirmed, ...gapJudged.filter((f) => f.confirmed)]
const order = { critical: 4, high: 3, medium: 2, low: 1, 'not-a-bug': 0 }
allConfirmed.sort((a, b) => (order[b.verifiedSeverity] || 0) - (order[a.verifiedSeverity] || 0))

return {
  summary: {
    judged: allJudged.length + gapJudged.length,
    confirmed: allConfirmed.length,
    rejected: allJudged.length + gapJudged.length - allConfirmed.length,
    rounds: areaResults.map((r) => ({ area: r.area, rounds: r.rounds })),
    gapsInvestigated: Math.min(gaps.length, MAX_GAPS), gapsNamed: gaps.length,
  },
  confirmed: allConfirmed.map((f) => ({
    severity: f.verifiedSeverity, area: f.area, file: f.file, line: f.line, title: f.title,
    scenario: f.scenario, evidence: f.evidence, suggested_fix: f.suggested_fix || null,
    reproduced: f.reproduced, votes: f.votes,
  })),
  rejected: [...allJudged, ...gapJudged].filter((f) => !f.confirmed).map((f) => ({
    area: f.area, file: f.file, line: f.line, title: f.title, claimed: f.severity,
    votes: (f.votes || []).map((v) => `${v.lens}:${v.real ? 'real' : 'no'}`).join(' '),
  })),
  gaps,
}
