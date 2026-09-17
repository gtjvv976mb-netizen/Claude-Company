/**
 * THE SOCIALS FILTER, TESTED AS AN UNTRUSTED FETCH RATHER THAN AS A PARSER.
 *
 * The owner asked for it after four losing round trips in twenty minutes: only buy a
 * launch whose deployer attached a twitter, telegram or website. Reading that means
 * fetching a document from a URL **chosen by whoever launched the coin**, from a machine
 * holding a funded key — so the assertions below are mostly about the hazard, not the
 * happy path:
 *
 *   · the URL is attacker-chosen, so `file://` and `data:` must never be fetched;
 *   · the host is attacker-chosen, so a hang must end at a deadline;
 *   · the BODY is attacker-chosen, so a huge answer must be abandoned WHILE it arrives
 *     and not after — asserted by counting the bytes the reader actually pulled;
 *   · the JSON is attacker-written, so every field is checked for type and length.
 *
 * And the rule that makes it a filter at all: IT FAILS CLOSED. An unreadable document
 * refuses exactly like an empty one. Both directions are asserted — a document WITH a
 * social must pass, or this file would be green with a function that always says no.
 *
 * Every assertion prints its actual value. No network: `fetch` is injected.
 */
import assert from "node:assert/strict";
import {
  SOCIAL_CLAUSES, SOCIAL_DEFAULTS, SOCIAL_FIELDS,
  fetchableUri, readSocials, socialValue, socialsFromMetadata,
} from "./snipe-socials.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

/** A response double. `body` streams in chunks so the size cap can be tested as it is
 *  meant to work — abandoning the read part-way — rather than after the fact. */
const respond = (text, { status = 200, chunkSize = 16, onPull = () => {} } = {}) => {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0, cancelled = false;
  return {
    ok: status >= 200 && status < 300, status,
    body: {
      getReader: () => ({
        read: async () => {
          if (cancelled || offset >= bytes.length) return { done: true };
          const end = Math.min(offset + chunkSize, bytes.length);
          const value = new Uint8Array(bytes.subarray(offset, end));
          offset = end; onPull(offset);
          return { done: false, value };
        },
        cancel: async () => { cancelled = true; },
      }),
    },
    text: async () => text,
  };
};
const serving = (text, opts) => async () => respond(text, opts);

console.log("\nthe shape of the module");
ok("the clause list is frozen and complete", Object.isFrozen(SOCIAL_CLAUSES) && SOCIAL_CLAUSES.length === 7,
  SOCIAL_CLAUSES.join(", "));
ok("the three fields are the three pump.fun carries",
  SOCIAL_FIELDS.join(",") === "twitter,telegram,website", SOCIAL_FIELDS.join(", "));
ok("the deadline is short, because a launch is decided in seconds",
  SOCIAL_DEFAULTS.timeoutMs <= 3_000, `${SOCIAL_DEFAULTS.timeoutMs}ms`);

console.log("\nwhat counts as a social, and what does not");
ok("a url counts", socialValue("https://x.com/somecoin") === "https://x.com/somecoin");
ok("a bare handle counts — pump.fun's own form accepts one", socialValue("@somecoin") === "@somecoin");
ok("whitespace is trimmed", socialValue("  @coin  ") === "@coin");
ok("an empty string is not a social", socialValue("") === null);
ok("whitespace alone is not a social", socialValue("   ") === null);
ok("a non-string is not a social", socialValue(12345) === null && socialValue({}) === null && socialValue(null) === null);
/* Metadata generators really do emit these, and treating them as links would make the
   filter pass on exactly the launches it exists to refuse. */
for (const junk of ["null", "undefined", "none", "n/a", "N/A", "-"])
  ok(`the string ${JSON.stringify(junk)} is an empty field with extra steps`, socialValue(junk) === null);
ok("a novel in a one-line field is refused rather than logged", socialValue("x".repeat(500)) === null, "500 chars");

console.log("\nreading a document");
ok("a top-level twitter is found", socialsFromMetadata({ twitter: "https://x.com/a" }).any === true);
ok("...and nested under extensions", socialsFromMetadata({ extensions: { telegram: "https://t.me/a" } }).any === true);
ok("...and nested under properties", socialsFromMetadata({ properties: { website: "https://a.io" } }).any === true);
const all3 = socialsFromMetadata({ twitter: "@a", telegram: "@b", website: "https://c.io" });
ok("all three are reported, in a stable order", all3.present.join(",") === "twitter,telegram,website", all3.present.join(", "));
ok("a document with name and image but no links has none",
  socialsFromMetadata({ name: "Coin", symbol: "C", image: "https://i/x.png" }).any === false);
ok("an array is a document with no socials, not a crash", socialsFromMetadata([1, 2, 3]).any === false);
ok("null is likewise", socialsFromMetadata(null).any === false);
ok("a hostile nested shape does not throw",
  socialsFromMetadata({ extensions: "not-an-object", properties: 42, twitter: [] }).any === false);

console.log("\nwhich urls this will fetch at all");
ok("https is fetchable", fetchableUri("https://ipfs.io/ipfs/abc") !== null);
ok("http is fetchable", fetchableUri("http://example.com/a.json") !== null);
/* THE ONE THAT MATTERS. Anybody can launch a coin, so anybody can choose this string, and
   it is handed to a machine holding a funded key. */
ok("file:// is NOT — it would read the operator's disk", fetchableUri("file:///etc/passwd") === null);
ok("data: is NOT — it smuggles a body past every limit", fetchableUri("data:application/json,{}") === null);
ok("ftp:// is NOT", fetchableUri("ftp://h/a.json") === null);
ok("a bare ipfs:// is NOT — nothing here picks a gateway for you", fetchableUri("ipfs://Qm123") === null);
ok("nonsense is NOT", fetchableUri("not a url") === null && fetchableUri("") === null && fetchableUri(null) === null);

console.log("\nreadSocials, end to end");
const run = async (name, args, expect, describe = (r) => r.message) => {
  const r = await readSocials(args);
  const got = r.ok ? "ok" : r.clause;
  ok(name, got === expect, `${got}${got === expect ? "" : ` (wanted ${expect})`} — ${describe(r)?.slice(0, 96)}`);
  return r;
};
await run("a launch with a twitter passes",
  { uri: "https://h/m.json", fetchImpl: serving(JSON.stringify({ name: "C", twitter: "https://x.com/c" })) }, "ok");
await run("a launch with only a website passes",
  { uri: "https://h/m.json", fetchImpl: serving(JSON.stringify({ website: "https://c.io" })) }, "ok");
await run("a launch with no links is refused",
  { uri: "https://h/m.json", fetchImpl: serving(JSON.stringify({ name: "C", image: "https://i/x.png" })) }, "no_socials");
await run("no uri at all is refused", { uri: null, fetchImpl: serving("{}") }, "no_uri");
await run("a file:// uri is refused without fetching",
  { uri: "file:///etc/passwd", fetchImpl: () => { throw new Error("THE FETCH WAS ATTEMPTED"); } }, "uri_not_http");
await run("a 404 is refused", { uri: "https://h/m.json", fetchImpl: serving("{}", { status: 404 }) }, "fetch_failed");
await run("a host that throws is refused",
  { uri: "https://h/m.json", fetchImpl: async () => { throw new Error("ECONNRESET"); } }, "fetch_failed");
await run("a document that is not JSON is refused",
  { uri: "https://h/m.json", fetchImpl: serving("<html>nope</html>") }, "not_json");

/* THE SIZE CAP, MEASURED. Content-Length is a claim by the party that chose the URL, so
   the only honest limit is one enforced on the bytes as they arrive. This asserts the
   reader STOPPED EARLY rather than merely returned the right code. */
let pulled = 0;
const huge = "x".repeat(200_000);
await run("a body over the cap is refused",
  { uri: "https://h/m.json", maxBytes: 1_024,
    fetchImpl: serving(JSON.stringify({ twitter: "@a", pad: huge }), { chunkSize: 256, onPull: (n) => { pulled = n; } }) },
  "too_large");
ok("...and abandoned WHILE it arrived, not after", pulled <= 2_048 && pulled > 0,
  `${pulled} bytes pulled of ${huge.length}+ served, against a 1024 cap`);

/* THE DEADLINE, MEASURED. A host that accepts the socket and then says nothing would
   otherwise hold a launch slot open forever. */
const started = Date.now();
await run("a host that never answers hits the deadline",
  { uri: "https://h/m.json", timeoutMs: 120,
    fetchImpl: (url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }) },
  "fetch_timeout");
const waited = Date.now() - started;
ok("...and it really did stop at the deadline rather than hang", waited < 2_000, `returned after ${waited}ms`);

/* FAILING CLOSED IS THE WHOLE POINT, so it is stated as its own assertion rather than
   left implied by the codes above. */
const closed = ["no_uri", "uri_not_http", "fetch_failed", "fetch_timeout", "too_large", "not_json", "no_socials"];
ok("every way of not seeing a social is a refusal, never a pass",
  closed.every((c) => SOCIAL_CLAUSES.includes(c)) && closed.length === SOCIAL_CLAUSES.length,
  `${closed.length} clauses, none of which returns ok`);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-snipe-socials  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
