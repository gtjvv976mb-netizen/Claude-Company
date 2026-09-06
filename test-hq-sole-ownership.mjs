import assert from "node:assert/strict";
import fs from "node:fs";

/* ── THE PENTHOUSE HAS ONE OWNER ──────────────────────────────────────────────
 * HQ standing is not cosmetic: holdsFloor(50) gates the house desk's settings and
 * hands over the executor secret the bot authenticates with. It used to be granted
 * to the deed holder OR the TREASURY_OWNER wallet, so two wallets held it.
 *
 * office.js carried a comment reading "SOLE OWNERSHIP … the deed alone, asserted
 * on every boot" directly above its call into this function, while the function
 * still ORed in the treasury. The comment described behaviour the code did not
 * have, and nothing tested it. This is that test.
 *
 * TREASURY_OWNER is deliberately set to a DIFFERENT wallet here: if the OR is ever
 * reinstated, this file fails rather than the comment quietly lying again. */
if (!process.env.CLAUDE_CO_DB) throw new Error("test runner must provide CLAUDE_CO_DB");

const DEED = "3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3";     // the dev wallet
const TREASURY = "TREASURYwa11etThatMustNotHoldTheHQ1111111111";
process.env.TREASURY_OWNER = TREASURY;

const tower = await import("./src/tower.js");

assert.equal(tower.hqOwnerWallet(), DEED, "the dev wallet holds the deed on floor 50");
assert.equal(tower.isHqOwner(DEED), true, "the deed holder owns the HQ");

assert.equal(tower.isHqOwner(TREASURY), false,
  "the treasury wallet must NOT hold the penthouse — it is where lease payments land, not an identity");
assert.equal(process.env.TREASURY_OWNER, TREASURY,
  "the treasury really was configured, so the check above proves something");

for (const nobody of ["", null, undefined, 0, false,
  "SomeOtherWa11et1111111111111111111111111111", DEED + "x", DEED.slice(0, -1)])
  assert.equal(tower.isHqOwner(nobody), false, `not an owner: ${JSON.stringify(nobody)}`);

/* The floor is not leasable, so the deed is the only way to hold it. */
const leasing = await import("./src/leasing.js");
const attempt = leasing.quote ? null : null;   // shape varies; the refusal below is the contract
assert.match(fs.readFileSync(new URL("./src/leasing.js", import.meta.url), "utf8"),
  /if \(floorNo === HQ_FLOOR\) return \{ ok: false, error: "the penthouse is not for lease" \}/,
  "floor 50 cannot be leased into a second holder");
void attempt;

/* No source file may name a standing owner outside the deed. A retired HQ_OWNER
 * list sat in office.js, read by nothing, still naming a wallet — dead code that
 * names an owner reads like policy. */
const office = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
assert.doesNotMatch(office, /HQ_OWNER_LIST_RETIRED/, "the retired owner list is gone");
assert.doesNotMatch(office, new RegExp(DEED),
  "no wallet address is hardcoded in office.js; the deed is the single source");

/* And the function itself must not consult the treasury at all. */
const towerSrc = fs.readFileSync(new URL("./src/tower.js", import.meta.url), "utf8");
const fn = towerSrc.slice(towerSrc.indexOf("export const isHqOwner"),
  towerSrc.indexOf("export function listFloors"));
assert.doesNotMatch(fn, /TREASURY/, "isHqOwner must not read the treasury");

console.log("HQ sole ownership: the deed alone, treasury refused, no hardcoded owner list");
