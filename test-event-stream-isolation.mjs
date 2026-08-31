import { backlog, emit, runFor } from "./src/lib/bus.js";
import {
  eventVisibleOnFloor,
  mayReadEventStream,
  requestedEventFloor,
} from "./src/event-stream-policy.js";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nTENANT EVENT STREAMS NEVER FALL THROUGH TO THE GLOBAL BACKLOG");
const noFloor = requestedEventFloor(new URL("https://office.example.test/events"));
const floorSeven = requestedEventFloor(new URL("https://office.example.test/events?floor=7"));
const invalid = requestedEventFloor(new URL("https://office.example.test/events?floor=all"));
ok("a missing floor resolves to HQ rather than the internal global stream", noFloor === 50);
ok("an explicit tenant floor remains exact", floorSeven === 7);
ok("an invalid floor fails closed", invalid == null);

ok("a leased tenant cannot read HQ by omitting the floor",
  !mayReadEventStream({ floor: noFloor, wallet: "tenant", hqOwner: "owner", leaseWallet: "tenant" }));
ok("only the deed owner can read HQ",
  mayReadEventStream({ floor: 50, wallet: "owner", hqOwner: "owner" }));
ok("the tenant can read its own explicit floor",
  mayReadEventStream({ floor: 7, wallet: "tenant", hqOwner: "owner", leaseWallet: "tenant" }));
ok("another tenant cannot read that floor",
  !mayReadEventStream({ floor: 7, wallet: "intruder", hqOwner: "owner", leaseWallet: "tenant" }));

runFor(null, () => emit("house:fixture", { public: true }));
runFor(7, () => emit("tenant:seven-fixture", { private: "seven" }));
runFor(8, () => emit("tenant:eight-fixture", { private: "eight" }));
const hqTypes = backlog(50).map((event) => event.type);
const sevenTypes = backlog(7).map((event) => event.type);
ok("the HQ replay cannot include any tenant floor",
  hqTypes.includes("house:fixture") && !hqTypes.includes("tenant:seven-fixture") &&
    !hqTypes.includes("tenant:eight-fixture"), hqTypes.join(","));
ok("a tenant replay includes house and its own activity only",
  sevenTypes.includes("house:fixture") && sevenTypes.includes("tenant:seven-fixture") &&
    !sevenTypes.includes("tenant:eight-fixture"), sevenTypes.join(","));
ok("the live filter enforces the same boundary",
  eventVisibleOnFloor(7, {}) && eventVisibleOnFloor(7, { floor: 7 }) &&
    !eventVisibleOnFloor(7, { floor: 8 }) && !eventVisibleOnFloor(null, {}));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
