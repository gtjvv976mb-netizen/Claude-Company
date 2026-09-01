import assert from "node:assert/strict";
import {
  RpcBalanceUnavailableError, verifyTrackedBalanceWithFailover,
} from "./balance-verification.mjs";

let failed = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}: ${error.stack || error.message}`);
  }
}

await check("a sufficient primary balance is authoritative and skips the secondary", async () => {
  let secondaryReads = 0;
  const result = await verifyTrackedBalanceWithFailover({
    trackedRaw: "1000",
    readPrimary: async () => 1200n,
    readSecondary: async () => { secondaryReads++; return 0n; },
  });
  assert.equal(result.verified, true);
  assert.equal(result.amountRaw, "1000");
  assert.equal(result.source, "primary");
  assert.equal(secondaryReads, 0);
});

await check("an unavailable primary fails over to an adequate independent secondary", async () => {
  const order = [];
  const result = await verifyTrackedBalanceWithFailover({
    trackedRaw: "1000",
    readPrimary: async () => { order.push("primary"); throw new RpcBalanceUnavailableError("primary timeout"); },
    readSecondary: async () => { order.push("secondary"); return 1000n; },
  });
  assert.deepEqual(order, ["primary", "secondary"]);
  assert.equal(result.verified, true);
  assert.equal(result.amountRaw, "1000");
  assert.equal(result.source, "secondary");
  assert.equal(result.primaryRaw, null);
  assert.equal(result.secondaryRaw, "1000");
});

await check("both RPC failures leave custody unverified", async () => {
  const result = await verifyTrackedBalanceWithFailover({
    trackedRaw: "1000",
    readPrimary: async () => { throw new RpcBalanceUnavailableError("primary timeout"); },
    readSecondary: async () => { throw new Error("secondary timeout"); },
  });
  assert.equal(result.verified, false);
  assert.match(result.reason, /both canonical-ATA balance reads are unavailable/);
  assert.equal(result.primaryRaw, null);
  assert.equal(result.secondaryRaw, null);
});

await check("a secondary under-read cannot authorize a partial exit after primary failure", async () => {
  const result = await verifyTrackedBalanceWithFailover({
    trackedRaw: "1000",
    readPrimary: async () => { throw new RpcBalanceUnavailableError("primary timeout"); },
    readSecondary: async () => 999n,
  });
  assert.equal(result.verified, false);
  assert.match(result.reason, /secondary RPC reports 999 below tracked 1000/);
  assert.equal(result.secondaryRaw, "999");
  assert.equal(result.amountRaw, undefined);
});

await check("conflicting primary and secondary balances fail closed", async () => {
  const result = await verifyTrackedBalanceWithFailover({
    trackedRaw: "1000",
    readPrimary: async () => 500n,
    readSecondary: async () => 1000n,
  });
  assert.equal(result.verified, false);
  assert.match(result.reason, /RPC balance disagreement/);
  assert.equal(result.primaryRaw, "500");
  assert.equal(result.secondaryRaw, "1000");
});

await check("matching under-reads remain a reconciliation state", async () => {
  const result = await verifyTrackedBalanceWithFailover({
    trackedRaw: "1000",
    readPrimary: async () => 500n,
    readSecondary: async () => 500n,
  });
  assert.equal(result.verified, false);
  assert.match(result.reason, /both RPCs report below tracked balance/);
  assert.equal(result.amountRaw, undefined);
});

await check("a secondary error after a primary under-read remains fail closed", async () => {
  const result = await verifyTrackedBalanceWithFailover({
    trackedRaw: "1000",
    readPrimary: async () => 500n,
    readSecondary: async () => { throw new Error("secondary timeout"); },
  });
  assert.equal(result.verified, false);
  assert.match(result.reason, /secondary balance unavailable/);
  assert.match(result.reason, /secondary timeout/);
});

await check("a primary custody-validation failure never falls through to the secondary", async () => {
  let secondaryReads = 0;
  const result = await verifyTrackedBalanceWithFailover({
    trackedRaw: "1000",
    readPrimary: async () => { throw new Error("canonical account owner mismatch"); },
    readSecondary: async () => { secondaryReads++; return 1000n; },
  });
  assert.equal(result.verified, false);
  assert.match(result.reason, /primary canonical-ATA validation failed/);
  assert.equal(secondaryReads, 0);
});

await check("invalid RPC balances fail closed instead of escaping validation", async () => {
  const result = await verifyTrackedBalanceWithFailover({
    trackedRaw: "1000",
    readPrimary: async () => { throw new RpcBalanceUnavailableError("primary timeout"); },
    readSecondary: async () => "not-an-integer",
  });
  assert.equal(result.verified, false);
  assert.match(result.reason, /both canonical-ATA balance reads are unavailable/);
  assert.match(result.reason, /secondary balance must be a non-negative integer/);
});

await check("provider URLs are redacted from reconciliation errors", async () => {
  const result = await verifyTrackedBalanceWithFailover({
    trackedRaw: "1000",
    readPrimary: async () => { throw new RpcBalanceUnavailableError("fetch https://primary.invalid/private-key?token=secret failed"); },
    readSecondary: async () => { throw new Error("fetch https://secondary.invalid/another-secret failed"); },
  });
  assert.equal(result.verified, false);
  assert.doesNotMatch(result.reason, /private-key|token=secret|another-secret/);
  assert.match(result.reason, /\[redacted RPC endpoint\]/);
});

if (failed) {
  console.error(`\n${failed} balance failover test${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
console.log("\nTracked-position custody failover stays primary-first and fail-closed.");
