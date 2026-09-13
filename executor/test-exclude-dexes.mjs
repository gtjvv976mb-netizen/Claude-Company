/**
 * JUPITER_EXCLUDE_DEXES — the venues the bot never asks Jupiter for.
 *
 * Measured 2026-09-13: every readiness rehearsal at 0.5 SOL that Jupiter routed through
 * HumidiFi created a program-owned account and funded it from the wallet, 13,045,440
 * lamports nobody quoted. The custody rule refused the route (correctly), the bot never
 * proved readiness, and the desk withheld every call. The fix is not a wider band: the
 * venue is left out of the order request, which Jupiter honours. These checks pin that
 * the label rides every order URL by default, that an empty setting sends nothing, and
 * that the dial survives the runner's allow-list and an installer upgrade.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JupiterV2Executor } from "./jupiter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const orderUrlWith = async (config) => {
  let seen = null;
  const executor = new JupiterV2Executor({
    connection: {}, keypair: { publicKey: { toBase58: () => "TakerWallet" } }, journal: {}, apiKey: "test-key",
    fetchFn: async (url) => { seen = new URL(String(url)); return new Response("{}", { status: 200 }); },
    config,
  });
  await executor.order({ inputMint: WSOL, outputMint: USDC, amountRaw: "500000000" });
  return seen;
};

console.log("\n1. THE ORDER REQUEST");
{
  const byDefault = await orderUrlWith({});
  ok("HumidiFi is excluded by default", byDefault.searchParams.get("excludeDexes") === "HumidiFi", byDefault.search);
  ok("…beside the routers that were already excluded", byDefault.searchParams.get("excludeRouters") === "jupiterz,dflow,okx");
  ok("…and the taker still rides the request", byDefault.searchParams.get("taker") === "TakerWallet");
  const two = await orderUrlWith({ excludeDexes: "HumidiFi,SolFi V2" });
  ok("a comma-separated list is sent as given", two.searchParams.get("excludeDexes") === "HumidiFi,SolFi V2", two.search);
  const none = await orderUrlWith({ excludeDexes: "" });
  ok("an empty setting sends no excludeDexes at all", !none.searchParams.has("excludeDexes"), none.search);
}

console.log("\n2. THE DIAL, END TO END");
{
  const poller = fs.readFileSync(path.join(HERE, "poller.mjs"), "utf8");
  const runner = fs.readFileSync(path.join(HERE, "launchd-runner.mjs"), "utf8");
  const install = fs.readFileSync(path.join(HERE, "install.sh"), "utf8");
  const readme = fs.readFileSync(path.join(HERE, "README.md"), "utf8");
  ok("the poller defaults JUPITER_EXCLUDE_DEXES to HumidiFi", /process\.env\.JUPITER_EXCLUDE_DEXES === undefined \? "HumidiFi"/.test(poller));
  ok("…and refuses a label that is not a plain route label", /JUPITER_EXCLUDE_DEXES must be up to 20 comma-separated Jupiter route labels/.test(poller));
  ok("the runner allows the dial through", /"JUPITER_EXCLUDE_DEXES"/.test(runner));
  /* THE BLOCK, NOT THE LINE. This pinned the carry list's exact line break and broke the
     moment another dial joined the list (2026-09-13, twice) — a green test turning red
     for a change it does not care about, which blocked every deploy for six hours,
     because the desk's Render build runs this suite as its build step. Assert that the
     dial is IN the block. */
  const carryList = install.slice(install.indexOf("for dial in"), install.indexOf('upgrade_env_read "$dial"'));
  ok("an installer upgrade carries it forward", /\bJUPITER_EXCLUDE_DEXES\b/.test(carryList));
  ok("the README documents it with the measurement", /`JUPITER_EXCLUDE_DEXES` \| `HumidiFi`/.test(readme));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
