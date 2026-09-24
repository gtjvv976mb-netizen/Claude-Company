/**
 * THE STALL EXIT MUST BE ON WHEN NOBODY TYPED IT.
 *
 * SNIPE_LANE_DEFAULTS.stallMs is `null` — "snipe-policy's own default", which is 90000 and
 * was set by the record (18 positions ran to the ten-minute clock, none won). Before
 * 2026-09-24, effectiveLaneConfig() read that null through Number(), got 0, and folded a
 * stallMs of 0 into the policy: the one dial whose zero means OFF was the one dial whose
 * absence read as zero. Every lane that had not typed SNIPE_STALL_MS ran without a stall
 * exit while the README said it had one.
 *
 * Every assertion prints the value it measured, so a pass says what the determiner sees.
 */
import { snipeLaneConfig, effectiveLaneConfig, SNIPE_LANE_DEFAULTS } from "./snipe-lane.mjs";
import { SNIPE_DEFAULTS, snipePolicy, freshSnipe } from "./snipe-policy.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const seen = (cfg) => ({ ...SNIPE_DEFAULTS, ...(effectiveLaneConfig(cfg).policy ?? {}) });

console.log("\nTHE STALL DIAL, UNSET\n────────────────────");
ok("the lane's own default for stallMs is null, meaning the policy's own", SNIPE_LANE_DEFAULTS.stallMs === null,
  `SNIPE_LANE_DEFAULTS.stallMs = ${SNIPE_LANE_DEFAULTS.stallMs}`);
for (const lane of ["observe", "execute"]) {
  const cfg = snipeLaneConfig({ SNIPE_LANE: lane });
  const eff = effectiveLaneConfig(cfg);
  ok(`${lane}: an unset stall folds nothing into the policy`, eff.policy === undefined || eff.policy.stallMs === undefined,
    `policy = ${JSON.stringify(eff.policy)}`);
  const p = seen(cfg);
  ok(`${lane}: the determiner sees the policy's own ${SNIPE_DEFAULTS.stallMs}ms stall`, p.stallMs === SNIPE_DEFAULTS.stallMs,
    `stallMs = ${p.stallMs}`);
  ok(`${lane}: the other unset dials fold nothing either`,
    p.takeAtEntryX === SNIPE_DEFAULTS.takeAtEntryX && p.stopFrac === SNIPE_DEFAULTS.stopFrac
      && p.timeStopMs === SNIPE_DEFAULTS.timeStopMs && p.stallAtX === SNIPE_DEFAULTS.stallAtX,
    `take ${p.takeAtEntryX} stop ${p.stopFrac} timeStop ${p.timeStopMs} stallAt ${p.stallAtX}`);
}

console.log("\nTHE STALL DIAL, TYPED\n────────────────────");
{
  const on = seen(snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_STALL_MS: "45000" }));
  ok("SNIPE_STALL_MS=45000 reaches the determiner", on.stallMs === 45_000, `stallMs = ${on.stallMs}`);
  const off = seen(snipeLaneConfig({ SNIPE_LANE: "observe", SNIPE_STALL_MS: "0" }));
  ok("SNIPE_STALL_MS=0 still turns the stall off — zero typed is zero", off.stallMs === 0, `stallMs = ${off.stallMs}`);
  const blank = seen(effectiveLaneConfig({ lane: "observe", stallMs: "" }));
  ok("an empty string reads as unset, not as zero", blank.stallMs === SNIPE_DEFAULTS.stallMs, `stallMs = ${blank.stallMs}`);
  const undef = seen(effectiveLaneConfig({ lane: "observe", stallMs: undefined }));
  ok("undefined reads as unset", undef.stallMs === SNIPE_DEFAULTS.stallMs, `stallMs = ${undef.stallMs}`);
}

console.log("\nWHAT IT MEANS FOR A POSITION\n───────────────────────────");
{
  /* The scenario the record described: flat at ninety seconds. With the default policy the
     stall fires; with the bug's stallMs of 0 it held to the 180s time stop. */
  const T0 = 1_757_000_000_000;
  const position = freshSnipe({ entry: 1, openedAt: T0, sizeSol: 0.1, feeSolPerLeg: 0.0005 });
  const cfg = seen(snipeLaneConfig({ SNIPE_LANE: "execute" }));
  const atNinety = snipePolicy({ position, mark: 0.97, nowMs: T0 + 90_000, config: cfg });
  ok("a launch flat at 90s leaves on the stall under the unset default", atNinety.action === "sell" && /stall/.test(atNinety.reason),
    `${atNinety.action}: ${atNinety.reason}`);
  const bugged = snipePolicy({ position, mark: 0.97, nowMs: T0 + 90_000, config: { ...cfg, stallMs: 0 } });
  ok("the same launch under the bug's stallMs=0 would have held on", bugged.action === "hold", `${bugged.action}: ${bugged.reason}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
