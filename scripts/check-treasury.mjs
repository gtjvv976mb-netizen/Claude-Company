#!/usr/bin/env node
/**
 * Verify the treasury is actually ready to receive floor payments.
 *
 * Checks the address is well-formed, that it holds a $CLAUDECO token account (the scanner
 * needs one to watch), and reports the balance. Read-only: this asks the chain questions
 * and never signs anything. It wants a PUBLIC address and nothing else — never paste a
 * private key or seed phrase into this or any other part of this project.
 */
import { cfg } from "../src/config.js";
import { readRpc } from "../src/lib/http.js";
import { isAddress } from "../src/lib/base58.js";

const MINT = process.env.CLAUDECO_MINT || "HRkkxgaFDDmZ3qZX8xP5SiMRBNvFNVUUv4FJUjPCpump";
const treasury = process.argv[2] || process.env.TREASURY_OWNER || "";

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);

console.log("\nClaude Company — treasury check\n");

if (!treasury) {
  bad("No address given.");
  info("Usage:  node scripts/check-treasury.mjs <YOUR_PUBLIC_ADDRESS>");
  info("   or:  set TREASURY_OWNER in .env and run again");
  process.exit(1);
}

if (/[^1-9A-HJ-NP-Za-km-z]/.test(treasury) || !isAddress(treasury)) {
  bad(`"${treasury}" is not a valid Solana address.`);
  info("It should be 32-44 base58 characters, e.g. the address Phantom shows as 'Receive'.");
  process.exit(1);
}
ok(`Address is a valid Solana address: ${treasury}`);

if (treasury.length > 60) {
  bad("That looks far too long for an address — never paste a private key or seed phrase.");
  process.exit(1);
}

const acct = await readRpc(cfg.rpc, "getTokenAccountsByOwner",
  [treasury, { mint: MINT }, { encoding: "jsonParsed", commitment: "finalized" }]);

if (!acct.ok) {
  bad(`Could not reach the chain: ${acct.error}`);
  info(`RPC in use: ${cfg.rpc}`);
  info("The public RPC is heavily rate-limited; set SOLANA_RPC to a Helius/Triton/QuickNode URL.");
  process.exit(1);
}

const found = acct.data?.value?.[0];
if (!found) {
  bad("This wallet has no $CLAUDECO token account yet.");
  info("The scanner watches that account, so it must exist before leasing can open.");
  info("Fix: send any small amount of $CLAUDECO to this wallet once. That creates it.");
  info(`Mint: ${MINT}`);
  process.exit(1);
}

const amount = found.account.data.parsed.info.tokenAmount;
ok(`Holds a $CLAUDECO token account: ${found.pubkey}`);
info(`Balance: ${Number(amount.uiAmountString).toLocaleString()} $CLAUDECO`);

const sigs = await readRpc(cfg.rpc, "getSignaturesForAddress", [found.pubkey, { limit: 1 }]);
if (sigs.ok) ok(`Chain history readable (${sigs.data?.length ? "has activity" : "no activity yet"})`);

console.log(`\n  \x1b[32mReady.\x1b[0m Set this in your environment:\n`);
console.log(`      TREASURY_OWNER=${treasury}\n`);
console.log(`  Local:  add that line to .env`);
console.log(`  Render: Dashboard -> your service -> Environment -> Add Environment Variable\n`);
