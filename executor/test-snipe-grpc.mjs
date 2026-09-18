/**
 * THE SCHEMA LAYER — the half that can be wrong in a way the codec cannot.
 *
 * grpc-wire.mjs cannot be silently wrong: the protobuf wire format is a specification, and
 * a round trip proves it. snipe-grpc.mjs CAN be silently wrong, because field numbers are
 * a schema, and a schema is a fact about someone else's repository. Get `account_include`
 * wrong and the subscription is accepted, the stream opens, the endpoint bills for it, and
 * not one launch ever arrives — the exact failure that looks like a quiet market.
 *
 * So the field numbers are asserted here as LITERALS, against the published proto:
 *
 *   https://raw.githubusercontent.com/rpcpool/yellowstone-grpc/master/yellowstone-grpc-proto/proto/geyser.proto
 *   https://raw.githubusercontent.com/rpcpool/yellowstone-grpc/master/yellowstone-grpc-proto/proto/solana-storage.proto
 *
 * That looks like testing a constant against itself, and it is not: it is a tripwire on the
 * next edit. Memory says account_include is 4 — it is 3 — and a future change that "fixes"
 * it fails here instead of on the owner's machine at 3am with a stream that says nothing.
 *
 * Everything else is proven the only way it can be without a Geyser server: a message is
 * BUILT with the encoders, decoded with the decoder, and checked. That proves the two
 * halves agree. What it cannot prove is that Helius agrees with the published proto, which
 * is why the transport carries a self-check that fails loudly on drift — and that check is
 * tested here, because a safety net nobody tests is a safety net nobody has.
 *
 *   node test-snipe-grpc.mjs
 */
import fs from "node:fs";
import {
  FIELDS, COMMITMENT, GEYSER_SUBSCRIBE_PATH, SCHEMA_PROBE_UPDATES, SnipeGrpcError,
  encodeSubscribeRequest, encodePingRequest, decodeSubscribeUpdate,
  laserstreamTransport, grpcFromEnv, hexSignature,
} from "./snipe-grpc.mjs";
import {
  decodeFields, readString, readStrings, readSafeInt, readBool, readMessage, readBytes,
  varintField, boolField, bytesField, stringField, messageField, concat,
} from "./grpc-wire.mjs";
import { FEED_SOURCE_KINDS, grpcSubscribeSource } from "./snipe-feed.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const PUMPFUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

console.log("\nTHE TRIPWIRE: every field number, against the published proto");
{
  ok("SubscribeRequest.transactions = 3", FIELDS.request.transactions === 3);
  ok("SubscribeRequest.commitment = 6", FIELDS.request.commitment === 6);
  ok("SubscribeRequest.ping = 9", FIELDS.request.ping === 9);
  ok("SubscribeRequest.from_slot = 11", FIELDS.request.fromSlot === 11);
  ok("a proto3 map entry is key=1, value=2", FIELDS.mapEntry.key === 1 && FIELDS.mapEntry.value === 2);
  ok("FilterTransactions.vote = 1, failed = 2", FIELDS.txFilter.vote === 1 && FIELDS.txFilter.failed === 2);
  ok("FilterTransactions.account_include = 3  (memory says 4; memory is wrong)", FIELDS.txFilter.accountInclude === 3);
  ok("FilterTransactions.account_exclude = 4, signature = 5, account_required = 6",
    FIELDS.txFilter.accountExclude === 4 && FIELDS.txFilter.signature === 5 && FIELDS.txFilter.accountRequired === 6);
  ok("SubscribeUpdate: transaction = 4, ping = 6, pong = 9, created_at = 11",
    FIELDS.update.transaction === 4 && FIELDS.update.ping === 6 && FIELDS.update.pong === 9 && FIELDS.update.createdAt === 11);
  ok("SubscribeUpdateTransaction: transaction = 1, slot = 2",
    FIELDS.updateTx.transaction === 1 && FIELDS.updateTx.slot === 2);
  ok("SubscribeUpdateTransactionInfo: signature = 1, is_vote = 2, meta = 4",
    FIELDS.txInfo.signature === 1 && FIELDS.txInfo.isVote === 2 && FIELDS.txInfo.meta === 4);
  ok("TransactionStatusMeta: err = 1, log_messages = 6", FIELDS.meta.err === 1 && FIELDS.meta.logMessages === 6);
  ok("CommitmentLevel: PROCESSED is 0, which is the only one a sniper can use",
    COMMITMENT.processed === 0 && COMMITMENT.confirmed === 1 && COMMITMENT.finalized === 2);
  ok("the method is the one every Yellowstone endpoint exposes",
    GEYSER_SUBSCRIBE_PATH === "/geyser.Geyser/Subscribe");
}

console.log("\nthe subscribe request says exactly what it means to say");
{
  const req = decodeFields(encodeSubscribeRequest({ label: "launches", accountInclude: [PUMPFUN] }));
  const entry = readMessage(req, FIELDS.request.transactions);
  ok("the transactions map carries one entry", entry !== null);
  ok("...keyed by the label the caller chose", readString(entry, FIELDS.mapEntry.key) === "launches");
  const filter = readMessage(entry, FIELDS.mapEntry.value);
  ok("account_include names the program", readStrings(filter, FIELDS.txFilter.accountInclude).join(",") === PUMPFUN);
  /* Both of these are EMITTED as false rather than omitted, and both are load-bearing.
     Votes are most of Solana's volume and none is a launch; a failed transaction cannot
     have created a coin but its logs can still contain a create that never happened. */
  ok("vote: false is on the wire, not left to the server's default", readBool(filter, FIELDS.txFilter.vote) === false);
  ok("failed: false likewise", readBool(filter, FIELDS.txFilter.failed) === false);
  ok("commitment is processed", readSafeInt(req, FIELDS.request.commitment) === 0);
  ok("no from_slot unless asked — a sniper wants now, not a replay",
    req.has(FIELDS.request.fromSlot) === false);
  const withSlot = decodeFields(encodeSubscribeRequest({ accountInclude: [PUMPFUN], fromSlot: 300_000_000 }));
  ok("...and from_slot rides when it is asked for", readSafeInt(withSlot, FIELDS.request.fromSlot) === 300_000_000);
  ok("confirmed and finalized encode as themselves",
    readSafeInt(decodeFields(encodeSubscribeRequest({ accountInclude: [PUMPFUN], commitment: "finalized" })), FIELDS.request.commitment) === 2);
}

console.log("\nit refuses a request that would subscribe to everything, or to nothing");
{
  const e = threw(() => encodeSubscribeRequest({ accountInclude: [] }));
  ok("an empty filter is refused — an unfiltered Geyser stream is all of Solana",
    e instanceof SnipeGrpcError && e.reason === "filter_empty", e?.message);
  const b = threw(() => encodeSubscribeRequest({ accountInclude: ["not-a-key"] }));
  ok("a key that is not base58 is refused before it reaches the wire",
    b instanceof SnipeGrpcError && b.reason === "filter_invalid", b?.message);
  const c = threw(() => encodeSubscribeRequest({ accountInclude: [PUMPFUN], commitment: "instant" }));
  ok("an invented commitment level is refused rather than silently defaulted",
    c instanceof SnipeGrpcError && c.reason === "commitment_invalid", c?.message);
  const s = threw(() => encodeSubscribeRequest({ accountInclude: [PUMPFUN], fromSlot: -1 }));
  ok("a negative from_slot is refused", s instanceof SnipeGrpcError, s?.message);
}

console.log("\nthe keepalive is a request, not a bespoke frame");
{
  const ping = decodeFields(encodePingRequest(7));
  ok("it rides on SubscribeRequest.ping", ping.has(FIELDS.request.ping));
  ok("...carrying the id the server asked about",
    readSafeInt(readMessage(ping, FIELDS.request.ping), FIELDS.ping.id) === 7);
  ok("a nonsense id falls back to 1 rather than throwing inside a data handler",
    readSafeInt(readMessage(decodeFields(encodePingRequest(NaN)), FIELDS.request.ping), FIELDS.ping.id) === 1);
}

/* ── a transaction update, built with the encoders and read with the decoder ───────── */

const buildTxUpdate = ({
  slot = 372_844_163, signature = Buffer.alloc(64, 7), logs = [], isVote = false, err = null,
  createdAtMs = null, slotAsBigint = null,
} = {}) => {
  const metaParts = [...(err ? [messageField(FIELDS.meta.err, [bytesField(1, err)])] : []),
    ...logs.map((l) => stringField(FIELDS.meta.logMessages, l))];
  const info = [
    bytesField(FIELDS.txInfo.signature, signature),
    boolField(FIELDS.txInfo.isVote, isVote),
    messageField(FIELDS.txInfo.meta, metaParts),
  ];
  const tx = [messageField(FIELDS.updateTx.transaction, info),
    varintField(FIELDS.updateTx.slot, slotAsBigint ?? slot)];
  const parts = [stringField(FIELDS.update.filters, "launches"), messageField(FIELDS.update.transaction, tx)];
  if (createdAtMs != null)
    parts.push(messageField(FIELDS.update.createdAt, [
      varintField(FIELDS.timestamp.seconds, Math.floor(createdAtMs / 1000)),
      varintField(FIELDS.timestamp.nanos, (createdAtMs % 1000) * 1e6),
    ]));
  return concat(parts);
};

console.log("\na transaction update decodes to the three things a launch feed needs");
{
  const u = decodeSubscribeUpdate(buildTxUpdate({
    slot: 372_844_163, logs: ["Program 6EF8… invoke [1]", "Program data: abc", "Program 6EF8… success"],
  }));
  ok("the branch is named", u.kind === "transaction", u.kind);
  ok("the slot comes through", u.slot === 372_844_163, String(u.slot));
  ok("the log lines come through in order, which is what the venue parser needs",
    u.logs.join("|") === "Program 6EF8… invoke [1]|Program data: abc|Program 6EF8… success");
  ok("the signature is the raw 64 bytes", u.signature?.length === 64, String(u.signature?.length));
  ok("...and hexSignature is the dependency-free default rendering",
    hexSignature(u.signature) === "07".repeat(64));
  ok("the filter labels ride along", u.filters.join(",") === "launches");
  ok("nothing here is mutable — a notice the lane can edit is a notice two sources disagree about",
    Object.isFrozen(u) && Object.isFrozen(u.logs));
}

console.log("\nthe things that must NOT be read as launches");
{
  ok("a vote is marked as one", decodeSubscribeUpdate(buildTxUpdate({ isVote: true })).isVote === true);
  const failed = decodeSubscribeUpdate(buildTxUpdate({ err: Buffer.from([1, 2, 3]), logs: ["Program data: abc"] }));
  ok("a transaction with meta.err PRESENT is failed, whatever the filter asked for",
    failed.failed === true, JSON.stringify({ failed: failed.failed }));
  ok("...and a clean one is not", decodeSubscribeUpdate(buildTxUpdate({ logs: ["x"] })).failed === false);
}

console.log("\na slot number is a u64, and a rounded slot is worse than no slot");
{
  const u = decodeSubscribeUpdate(buildTxUpdate({ slotAsBigint: 2n ** 60n }));
  ok("a slot past 2^53 reads null rather than a plausible wrong number", u.slot === null, String(u.slot));
  ok("...and the update is still a transaction, so the launch is not lost with the slot",
    u.kind === "transaction");
}

console.log("\nthe other branches, including the one that means the schema moved");
{
  ok("ping is recognised", decodeSubscribeUpdate(concat([messageField(FIELDS.update.ping, [])])).kind === "ping");
  const pong = decodeSubscribeUpdate(concat([messageField(FIELDS.update.pong, [varintField(FIELDS.pong.id, 3)])]));
  ok("pong is recognised and carries its id", pong.kind === "pong" && pong.pongId === 3);
  const slot = decodeSubscribeUpdate(concat([messageField(FIELDS.update.slot, [varintField(1, 500)])]));
  ok("a slot update is recognised", slot.kind === "slot" && slot.slot === 500);
  const unknown = decodeSubscribeUpdate(concat([messageField(44, [varintField(1, 1)])]));
  ok("a branch this build has no constant for is `unknown` — the drift signal, named",
    unknown.kind === "unknown", unknown.kind);
  ok("an empty update decodes rather than throwing", decodeSubscribeUpdate(Buffer.alloc(0)).kind === "unknown");
}

console.log("\ncreated_at is the SERVER's clock and lands where nothing ranks sources by it");
{
  const u = decodeSubscribeUpdate(buildTxUpdate({ createdAtMs: 1_758_000_123_456 }));
  ok("it decodes to ms", Math.abs(u.createdAtMs - 1_758_000_123_456) < 1000, String(u.createdAtMs));
  ok("...and is exposed as an ORIGIN claim, never as an arrival stamp",
    !("arrivedAtMs" in u) && "createdAtMs" in u);
}

/* ── the transport, driven by a fake stream ────────────────────────────────────────── */

function fakeStream() {
  const sent = [];
  let handlers = null;
  return {
    sent,
    open(opts) { handlers = opts; return { send: (b) => { sent.push(b); return true; }, close: () => { sent.push("CLOSED"); } }; },
    deliver(bytes) { handlers.onMessage(bytes); },
    get headers() { return handlers?.headers; },
    get opts() { return handlers; },
  };
}

console.log("\nthe transport subscribes the way the feed already knows how to drive");
{
  const f = fakeStream();
  const notices = [], errors = [];
  const t = laserstreamTransport({ endpoint: "https://laserstream-mainnet-ewr.example.com", token: "SECRET-TOKEN", openStream: f.open });
  const handle = t.subscribe({ programId: PUMPFUN, commitment: "processed", onNotice: (n, c) => notices.push([n, c]), onError: (e) => errors.push(e) });

  ok("the path is the Geyser Subscribe method", f.opts.path === GEYSER_SUBSCRIBE_PATH);
  ok("the token rides in x-token, which is what Yellowstone reads", f.headers["x-token"] === "SECRET-TOKEN");
  ok("the SubscribeRequest is the first and only thing written", f.sent.length === 1);
  const req = decodeFields(f.sent[0]);
  ok("...and it filters on the program the caller named",
    readStrings(readMessage(readMessage(req, FIELDS.request.transactions), FIELDS.mapEntry.value), FIELDS.txFilter.accountInclude).join(",") === PUMPFUN);

  f.deliver(buildTxUpdate({ slot: 400, logs: ["Program data: create"], signature: Buffer.alloc(64, 9) }));
  ok("a transaction with logs becomes one notice", notices.length === 1);
  ok("...carrying the logs the venue parser needs", notices[0][0].logs.join("") === "Program data: create");
  ok("...the signature, rendered", notices[0][0].signature === "09".repeat(64));
  ok("...and the slot, in the payload AND in the context the feed reads",
    notices[0][0].slot === 400 && notices[0][1].slot === 400);

  handle.unsubscribe();
  ok("unsubscribe closes the stream", f.sent.includes("CLOSED"));
}

console.log("\nthe transport drops what cannot be a launch, and answers what keeps it alive");
{
  const f = fakeStream();
  const notices = [];
  const t = laserstreamTransport({ endpoint: "https://x.example.com", token: "t", openStream: f.open });
  t.subscribe({ programId: PUMPFUN, onNotice: (n) => notices.push(n) });
  const before = f.sent.length;

  f.deliver(buildTxUpdate({ isVote: true, logs: ["x"] }));
  f.deliver(buildTxUpdate({ err: Buffer.from([1]), logs: ["x"] }));
  f.deliver(buildTxUpdate({ logs: [] }));
  ok("a vote, a failed transaction and a transaction with no logs produce nothing",
    notices.length === 0, `${notices.length} notices`);

  f.deliver(concat([messageField(FIELDS.update.ping, [])]));
  ok("a ping is answered — a client that does not answer is disconnected, and a disconnected sniper misses the hour",
    f.sent.length === before + 1);
  const ping = decodeFields(f.sent[f.sent.length - 1]);
  ok("...with a SubscribeRequest carrying a ping, which is what the server expects", ping.has(FIELDS.request.ping));

  f.deliver(buildTxUpdate({ logs: ["Program data: create"] }));
  ok("and a real launch still lands after all of that", notices.length === 1);
}

console.log("\nTHE SELF-CHECK: a stream that talks and says nothing we understand is reported");
{
  const f = fakeStream();
  const errors = [];
  const t = laserstreamTransport({ endpoint: "https://x.example.com", token: "t", openStream: f.open, schemaProbeUpdates: 5 });
  t.subscribe({ programId: PUMPFUN, onNotice: () => {}, onError: (e) => errors.push(e) });
  for (let i = 0; i < 4; i++) f.deliver(concat([messageField(44, [varintField(1, i)])]));
  ok("four unrecognised updates are not yet a verdict", errors.length === 0, `${errors.length}`);
  f.deliver(concat([messageField(44, [varintField(1, 9)])]));
  ok("the fifth trips it", errors.length === 1 && errors[0].reason === "schema_mismatch", errors[0]?.message);
  ok("...and the message says what to go and look at", /geyser\.proto has moved/.test(errors[0].message));
  ok("the default probe window is larger than a healthy stream's opening pings",
    SCHEMA_PROBE_UPDATES >= 20, String(SCHEMA_PROBE_UPDATES));
}

console.log("\n...and a stream that IS understood never trips it, however quiet the market");
{
  const f = fakeStream();
  const errors = [];
  const t = laserstreamTransport({ endpoint: "https://x.example.com", token: "t", openStream: f.open, schemaProbeUpdates: 3 });
  t.subscribe({ programId: PUMPFUN, onNotice: () => {}, onError: (e) => errors.push(e) });
  for (let i = 0; i < 40; i++) f.deliver(concat([messageField(FIELDS.update.slot, [varintField(1, 100 + i)])]));
  ok("forty slot updates and no transactions is a quiet market, not a broken schema",
    errors.length === 0, errors[0]?.message);
}

console.log("\nthe token never leaves through an error, a log, or a URL");
{
  const f = fakeStream();
  const errors = [], logs = [];
  const t = laserstreamTransport({
    endpoint: "https://laserstream.example.com", token: "sk-live-DO-NOT-LEAK",
    openStream: f.open, schemaProbeUpdates: 2, log: (m) => logs.push(m),
  });
  t.subscribe({ programId: PUMPFUN, onNotice: () => {}, onError: (e) => errors.push(e) });
  f.deliver(Buffer.from([0x0c]));           // not protobuf at all
  f.deliver(concat([messageField(44, [])])); // unrecognised branch
  f.deliver(concat([messageField(44, [])]));
  const spilled = [...errors.map((e) => `${e.message} ${JSON.stringify(e)}`), ...logs].join(" ");
  ok("no error or log line contains the token", !spilled.includes("DO-NOT-LEAK"), spilled.slice(0, 120));
  ok("the log names the host, which is the part worth knowing", logs.join("").includes("laserstream.example.com"));
  ok("bytes that are not protobuf are reported rather than decoded onward", errors.length >= 1, errors[0]?.message);
}

console.log("\nit refuses to open a stream it should not");
{
  ok("no token is refused: an unauthenticated Yellowstone stream is a stream that is not ours",
    threw(() => laserstreamTransport({ endpoint: "https://x.example.com" }))?.reason === "token_missing");
  ok("http:// is refused — a token on a plaintext socket is a leaked token",
    threw(() => laserstreamTransport({ endpoint: "http://x.example.com", token: "t" }))?.reason === "endpoint_invalid");
}

console.log("\nthe env dial: both halves or neither, and the owner's quoted values survive");
{
  ok("neither set means no gRPC source at all, which is the shipped default",
    grpcFromEnv({}) === null);
  ok("a URL without a token is refused rather than opening nothing",
    threw(() => grpcFromEnv({ SNIPE_GRPC_URL: "https://x.example.com" }))?.reason === "env_incomplete");
  ok("a token without a URL is refused rather than sitting in an env file for no reason",
    threw(() => grpcFromEnv({ SNIPE_GRPC_TOKEN: "t" }))?.reason === "env_incomplete");
  /* The owner's .cc-executor.env writes values DOUBLE-QUOTED. A URL that arrives as
     "\"https://…\"" fails the https test and, worse, would be sent as a host with quotes in
     it. Stripped here rather than at each use, once. */
  const cfg = grpcFromEnv({ SNIPE_GRPC_URL: '"https://laserstream-mainnet-ewr.example.com"', SNIPE_GRPC_TOKEN: '"abc-123"' });
  ok("surrounding double quotes are stripped from both", cfg.endpoint === "https://laserstream-mainnet-ewr.example.com" && cfg.token === "abc-123");
  ok("commitment defaults to processed", cfg.commitment === "processed");
  ok("...and is validated when set",
    threw(() => grpcFromEnv({ SNIPE_GRPC_URL: "https://x.example.com", SNIPE_GRPC_TOKEN: "t", SNIPE_GRPC_COMMITMENT: "soon" }))?.reason === "commitment_invalid");
  ok("an http endpoint is refused at the env boundary too",
    threw(() => grpcFromEnv({ SNIPE_GRPC_URL: "http://x.example.com", SNIPE_GRPC_TOKEN: "t" }))?.reason === "endpoint_invalid");
}

console.log("\nthe feed knows grpc as its own kind, which is what makes the race measurable");
{
  ok("`grpc` is a source kind", FEED_SOURCE_KINDS.includes("grpc"), FEED_SOURCE_KINDS.join(","));
  ok("...and is NOT folded into `logs`, or there would be nothing to compare",
    FEED_SOURCE_KINDS.includes("logs"));
  const src = grpcSubscribeSource({
    id: "grpc:pumpfun", programId: PUMPFUN, transport: { subscribe: () => ({ unsubscribe() {} }) },
    extractMint: () => null,
  });
  ok("grpcSubscribeSource declares it", src.kind === "grpc", src.kind);
  ok("it still demands an explicit extractMint, exactly as the websocket source does",
    threw(() => grpcSubscribeSource({ id: "g", programId: PUMPFUN, transport: { subscribe: () => ({}) } })) !== null);
  const office = fs.readFileSync(new URL("../src/office.js", import.meta.url), "utf8");
  ok("the desk already accepts `grpc` on the source-race block, so the panel needs no change",
    /\["logs", "poll", "watch", "grpc"\]\.includes/.test(office));
}

console.log("\nit is wired into the runtime, or it is a module nobody loads");
{
  const install = fs.readFileSync(new URL("./install.sh", import.meta.url), "utf8");
  ok("install.sh copies both modules", /grpc-wire\.mjs/.test(install) && /snipe-grpc\.mjs/.test(install));
  ok("...and lists them as runtime files", /RUNTIME_FILES=\([^)]*grpc-wire\.mjs/.test(install) && /RUNTIME_FILES=\([^)]*snipe-grpc\.mjs/.test(install));
  const release = fs.readFileSync(new URL("./macos-release.sh", import.meta.url), "utf8");
  ok("the release ships them", /executor\/grpc-wire\.mjs/.test(release) && /executor\/snipe-grpc\.mjs/.test(release));
  const viewer = fs.readFileSync(new URL("../scripts/build-viewer.mjs", import.meta.url), "utf8");
  ok("the viewer publishes them", /"grpc-wire\.mjs"/.test(viewer) && /"snipe-grpc\.mjs"/.test(viewer));
  const health = fs.readFileSync(new URL("./heartbeat-health.mjs", import.meta.url), "utf8");
  ok("the heartbeat fingerprints them, since the trading process imports them",
    /"grpc-wire\.mjs"/.test(health) && /"snipe-grpc\.mjs"/.test(health));
  const runner = fs.readFileSync(new URL("./launchd-runner.mjs", import.meta.url), "utf8");
  ok("the runner passes the three env vars through, or the dial does nothing under launchd",
    /"SNIPE_GRPC_URL"/.test(runner) && /"SNIPE_GRPC_TOKEN"/.test(runner) && /"SNIPE_GRPC_COMMITMENT"/.test(runner));
  /* THE OTHER HALF OF THAT DECISION, and the half that is silent when it is missed.
     install.sh rebuilds the environment file from scratch on every upgrade and re-emits
     only the dials its carry loop names. A key the runner allows but the carry loop does
     not survives until the next upgrade and then vanishes with no message at all — the
     operator sets the fastest source, sees it work, upgrades, and is quietly back on two
     sources. This shipped exactly that way and is pinned here so it cannot again. */
  const carryList = install.slice(install.indexOf("for dial in"), install.indexOf('upgrade_env_read "$dial"'));
  ok("an upgrade carries the endpoint forward", /\bSNIPE_GRPC_URL\b/.test(carryList));
  ok("...and the token, so a credential is not retyped on every upgrade",
    /\bSNIPE_GRPC_TOKEN\b/.test(carryList));
  ok("...and the commitment", /\bSNIPE_GRPC_COMMITMENT\b/.test(carryList));
  ok("the carry loop never echoes a value, which is what lets a credential ride it",
    /if upgrade_env_read "\$dial" && \[ -n "\$UPGRADE_VALUE" \]; then write_env_line "\$dial" "\$UPGRADE_VALUE"; fi/.test(install));
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("the poller adds the source only when the operator configured one",
    /grpcFromEnv\(/.test(poller) && /grpcSubscribeSource\(/.test(poller));
  /* `off` must cost literally nothing, which is why every lane module is a dynamic import
     inside the branch. test-snipe-wiring.mjs holds that line and caught this one. */
  ok("...and imports it dynamically, inside the lane branch, like every other lane module",
    /import\("\.\/snipe-grpc\.mjs"\)/.test(poller) && !/^import .*snipe-grpc/m.test(poller));
  ok("...and reuses the venue's own verified log decoder rather than parsing logs again",
    /noticesFromLogs\(/.test(poller));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-snipe-grpc  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
