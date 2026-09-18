/**
 * THE WIRE — proving a codec without a server.
 *
 * grpc-wire.mjs exists so the sniper can speak to a Yellowstone endpoint without adding
 * fifty transitive packages to a repository whose production deploy runs `npm ci && npm
 * test` as its build command. The price of writing a codec by hand is that it has to be
 * proven by hand, and there is no Geyser server in CI to prove it against.
 *
 * What CAN be proven offline is everything that matters:
 *
 *   · ROUND-TRIP. Encode, decode, compare. A codec that round-trips every shape the schema
 *     layer emits is a codec that cannot be silently wrong about the encoding — the only
 *     remaining question is what the fields MEAN, and that is snipe-grpc.mjs's problem.
 *   · THE 64-BIT BOUNDARY. A slot number is a u64. Number loses precision above 2^53, and a
 *     slot that reads 372844163891052400 instead of ...447 is a number nobody notices is
 *     wrong. The codec carries BigInt and hands back null rather than a rounded integer.
 *   · HOSTILE CHUNK BOUNDARIES. A TCP read is not a message. The framer is fed a length
 *     prefix split across two reads, three messages in one read, and a stream delivered one
 *     byte at a time — the cases that break hand-rolled framers, and the cases a real
 *     socket produces under exactly the load a sniper cannot afford to miss.
 *   · TERMINATION. A varint of all-continuation bytes must throw, not spin. A hang here
 *     would present as a feed that went quiet, which is the one failure this whole
 *     subsystem is built to make impossible.
 *
 *   node test-grpc-wire.mjs
 */
import { EventEmitter } from "node:events";
import {
  GrpcWireError, GrpcStatusError, GRPC_STATUS,
  encodeVarint, readVarint, encodeTag, varintField, boolField, bytesField, stringField,
  messageField, concat, decodeFields, readU64, readSafeInt, readBool, readBytes, readString,
  readStrings, readMessage, frame, createFrameReader, openGrpcStream,
  GRPC_FRAME_HEADER_BYTES, WIRE_VARINT, WIRE_BYTES,
} from "./grpc-wire.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

console.log("\nvarints round-trip, including the ones that do not fit in a Number");
{
  const cases = [0n, 1n, 127n, 128n, 300n, 16_383n, 16_384n, 2n ** 32n, 2n ** 53n, 2n ** 63n, 2n ** 64n - 1n];
  let allBack = true, worst = null;
  for (const v of cases) {
    const back = readVarint(encodeVarint(v)).value;
    if (back !== v) { allBack = false; worst = `${v} → ${back}`; }
  }
  ok("every value comes back exactly", allBack, worst ?? `${cases.length} values including 2^64-1`);
  ok("the encoding is the canonical one (300 is 0xac 0x02)",
    encodeVarint(300).toString("hex") === "ac02", encodeVarint(300).toString("hex"));
  ok("one byte for anything under 128", encodeVarint(127).length === 1);
  ok("two bytes at 128", encodeVarint(128).length === 2);
  ok("ten bytes at the u64 ceiling", encodeVarint(2n ** 64n - 1n).length === 10);
}

console.log("\na varint that cannot terminate throws instead of spinning");
{
  const e = threw(() => readVarint(Buffer.alloc(16, 0xff)));
  ok("all-continuation bytes are an error, not a hang", e instanceof GrpcWireError, e?.message);
  const t = threw(() => readVarint(Buffer.from([0x80, 0x80])));
  ok("a varint truncated by the end of the buffer is an error", t instanceof GrpcWireError, t?.message);
  const n = threw(() => encodeVarint(-1));
  ok("a negative value is refused rather than wrapped", n instanceof GrpcWireError, n?.message);
}

console.log("\ntags carry the field number and the wire type, and refuse nonsense");
{
  const tag = readVarint(encodeTag(3, WIRE_BYTES)).value;
  ok("field 3 / wire 2 encodes as 0x1a", Number(tag) === 26, `0x${Number(tag).toString(16)}`);
  ok("field 30 survives (token_accounts is field 30 in the real proto)",
    Number(readVarint(encodeTag(30, WIRE_VARINT)).value >> 3n) === 30);
  ok("field 0 is refused", threw(() => encodeTag(0, WIRE_VARINT)) instanceof GrpcWireError);
  ok("wire type 3 (deprecated groups) is refused", threw(() => encodeTag(1, 3)) instanceof GrpcWireError);
}

console.log("\na message round-trips through every field shape the schema layer emits");
{
  const inner = concat([varintField(1, 42), stringField(2, "hello")]);
  const message = concat([
    varintField(1, 2n ** 60n),
    boolField(2, false),
    boolField(3, true),
    stringField(4, "pump"),
    bytesField(5, Buffer.from([0xde, 0xad, 0xbe, 0xef])),
    messageField(6, [varintField(1, 42), stringField(2, "hello")]),
    stringField(7, "one"), stringField(7, "two"), stringField(7, "three"),
  ]);
  const f = decodeFields(message);
  ok("a u64 above 2^53 survives as a BigInt", readU64(f, 1) === 2n ** 60n, String(readU64(f, 1)));
  ok("...and readSafeInt refuses to round it rather than returning a wrong number",
    readSafeInt(f, 1) === null, String(readSafeInt(f, 1)));
  ok("false is EMITTED, not omitted — presence is the point on an optional field",
    readBool(f, 2) === false, JSON.stringify(readBool(f, 2)));
  ok("true round-trips", readBool(f, 3) === true);
  ok("a string round-trips", readString(f, 4) === "pump");
  ok("bytes round-trip", readBytes(f, 5)?.toString("hex") === "deadbeef");
  ok("a nested message round-trips whole",
    readMessage(f, 6) && readString(readMessage(f, 6), 2) === "hello" && readSafeInt(readMessage(f, 6), 1) === 42);
  ok("...and equals the same bytes encoded standalone", readBytes(f, 6).equals(inner));
  ok("a repeated field comes back as every occurrence, in order",
    readStrings(f, 7).join(",") === "one,two,three", readStrings(f, 7).join(","));
  ok("an absent field reads null rather than throwing", readString(f, 99) === null);
  ok("a field read at the wrong wire type reads null rather than garbage",
    readString(f, 1) === null && readU64(f, 4) === null);
}

console.log("\nmalformed bytes are an error, never a plausible structure");
{
  /* Wire type 4 (end-group) is not something this codec emits or accepts. Skipping past an
     unknown WIRE TYPE — as opposed to an unknown field — means decoding noise. */
  ok("an unknown wire type is fatal", threw(() => decodeFields(Buffer.from([0x0c]))) instanceof GrpcWireError);
  const over = Buffer.concat([encodeTag(1, WIRE_BYTES), encodeVarint(99), Buffer.alloc(3)]);
  const e = threw(() => decodeFields(over));
  ok("a length that runs past the end is an error", e instanceof GrpcWireError, e?.message);
  ok("an empty buffer decodes to an empty map, which is a valid proto3 message",
    decodeFields(Buffer.alloc(0)).size === 0);
  const capped = threw(() => decodeFields(Buffer.concat([bytesField(1, Buffer.alloc(64))]), { maxDepthBytes: 8 }));
  ok("a nested block over the ceiling is refused before it is read", capped instanceof GrpcWireError);
}

console.log("\nframing: one byte of flag, four big-endian bytes of length, then the body");
{
  const f = frame(Buffer.from("abc"));
  ok("the header is five bytes", f.length === GRPC_FRAME_HEADER_BYTES + 3, `${f.length}`);
  ok("the compression flag is zero", f[0] === 0);
  ok("the length is big-endian", f.readUInt32BE(1) === 3, String(f.readUInt32BE(1)));
  ok("an empty message is a legal frame", frame(Buffer.alloc(0)).length === 5);
}

console.log("\nthe framer survives every chunk boundary a real socket produces");
{
  const wire = Buffer.concat([frame(Buffer.from("one")), frame(Buffer.from("two")), frame(Buffer.from("three"))]);

  const whole = createFrameReader().push(wire).map((m) => m.toString());
  ok("three messages in one read come out as three", whole.join(",") === "one,two,three", whole.join(","));

  const r2 = createFrameReader();
  const a = r2.push(wire.subarray(0, 3)); // the length prefix, cut in half
  const b = r2.push(wire.subarray(3));
  ok("a length prefix split across two reads loses nothing",
    a.length === 0 && b.map((m) => m.toString()).join(",") === "one,two,three", `${a.length} then ${b.length}`);
  ok("...and the framer says how much it is holding mid-frame", r2.pendingBytes() === 0);

  const r3 = createFrameReader();
  const out = [];
  for (const byte of wire) out.push(...r3.push(Buffer.from([byte])));
  ok("a stream delivered one byte at a time still yields whole messages",
    out.map((m) => m.toString()).join(",") === "one,two,three", out.length + " messages");

  const r4 = createFrameReader();
  r4.push(wire.subarray(0, 7));
  ok("a body split mid-message is held, not emitted short", r4.pendingBytes() === 7, `${r4.pendingBytes()} bytes held`);
  ok("...and completes on the next read", r4.push(wire.subarray(7, 8)).map((m) => m.toString()).join(",") === "one");
}

console.log("\nthe framer refuses what it cannot read, rather than dropping it quietly");
{
  const compressed = Buffer.concat([Buffer.from([1, 0, 0, 0, 3]), Buffer.from("abc")]);
  const e = threw(() => createFrameReader().push(compressed));
  ok("a compressed frame is an ERROR — a frame silently skipped is a launch silently missed",
    e instanceof GrpcWireError, e?.message);
  const huge = Buffer.from([0, 0xff, 0xff, 0xff, 0xff]);
  const h = threw(() => createFrameReader({ maxMessageBytes: 1024 }).push(huge));
  ok("a length prefix over the ceiling is refused BEFORE a byte of it is buffered",
    h instanceof GrpcWireError, h?.message);
}

/* ── the HTTP/2 stream, driven by a fake that never opens a socket ─────────────────── */

function fakeHttp2() {
  const stream = new EventEmitter();
  stream.written = [];
  stream.write = (b) => { stream.written.push(Buffer.from(b)); return true; };
  stream.close = () => { stream.closedCount = (stream.closedCount ?? 0) + 1; };
  const session = new EventEmitter();
  session.requested = null;
  session.request = (headers) => { session.requested = headers; return stream; };
  session.close = () => { session.closedCount = (session.closedCount ?? 0) + 1; };
  return {
    stream, session,
    module: { connect: (url) => { session.url = url; return session; } },
  };
}

console.log("\nthe call is opened the way gRPC requires, and the request is written LAST");
{
  const fake = fakeHttp2();
  const got = [];
  const h = openGrpcStream({
    url: "https://laserstream-mainnet-ewr.example.com", path: "/geyser.Geyser/Subscribe",
    headers: { "x-token": "tok" }, http2: fake.module, onMessage: (m) => got.push(m.toString()),
  });
  const hdr = fake.session.requested;
  ok("POST, because a gRPC call is always a POST", hdr[":method"] === "POST");
  ok("the path names the service and the method", hdr[":path"] === "/geyser.Geyser/Subscribe");
  ok("content-type marks it as gRPC over protobuf", hdr["content-type"] === "application/grpc+proto");
  ok("`te: trailers` — without it a server may not send the status at all", hdr.te === "trailers");
  ok("identity encoding is advertised, matching what the framer can read",
    hdr["grpc-encoding"] === "identity" && hdr["grpc-accept-encoding"] === "identity");
  ok("the caller's auth header rides along", hdr["x-token"] === "tok");
  ok("nothing is written until the caller sends", fake.stream.written.length === 0);

  h.send(Buffer.from("req"));
  ok("a send is framed on the way out",
    fake.stream.written[0].equals(frame(Buffer.from("req"))), fake.stream.written[0]?.toString("hex"));

  fake.stream.emit("response", { ":status": 200 });
  fake.stream.emit("data", Buffer.concat([frame(Buffer.from("u1")), frame(Buffer.from("u2"))]));
  ok("updates arrive one call per message, not one per TCP read", got.join(",") === "u1,u2", got.join(","));

  h.close();
  ok("close() closes the stream and the session", fake.stream.closedCount === 1 && fake.session.closedCount === 1);
  ok("...and a send afterwards is a no-op rather than a throw", h.send(Buffer.from("x")) === false);
}

console.log("\nevery way the call can fail is reported exactly once");
{
  /* A gRPC error commonly arrives as a TRAILERS-ONLY response: HTTP 200 with grpc-status in
     the headers. Reading status only from the trailers misses every auth failure, which is
     the single most likely thing to go wrong with a brand-new token. */
  const fake = fakeHttp2();
  const errors = [];
  openGrpcStream({
    url: "https://x.example.com", path: "/p", http2: fake.module,
    onMessage: () => {}, onError: (e) => errors.push(e),
  });
  fake.stream.emit("response", { ":status": 200, "grpc-status": "16", "grpc-message": "invalid x-token" });
  ok("a trailers-only UNAUTHENTICATED is caught at the headers", errors.length === 1 && errors[0] instanceof GrpcStatusError);
  ok("...with the code and the name, so a log says what to fix",
    errors[0]?.code === 16 && errors[0]?.status === "UNAUTHENTICATED", errors[0]?.message);
  fake.stream.emit("error", new Error("socket reset"));
  fake.stream.emit("end");
  ok("and nothing after it is reported twice — one socket, one death", errors.length === 1, `${errors.length} errors`);
}

console.log("\na stream that ENDS is a dead source, not a quiet one");
{
  const fake = fakeHttp2();
  const errors = [], ends = [];
  openGrpcStream({
    url: "https://x.example.com", path: "/p", http2: fake.module,
    onMessage: () => {}, onError: (e) => errors.push(e), onEnd: () => ends.push(1),
  });
  fake.stream.emit("response", { ":status": 200 });
  fake.stream.emit("end");
  ok("onEnd fires", ends.length === 1);
  ok("...and it is ALSO an error, so health says dead now rather than after a silence timer",
    errors.length === 1 && /ended/.test(errors[0].message), errors[0]?.message);
}

console.log("\nnon-OK trailers and non-200 status are both surfaced");
{
  const fake = fakeHttp2();
  const errors = [];
  openGrpcStream({ url: "https://x.example.com", path: "/p", http2: fake.module, onMessage: () => {}, onError: (e) => errors.push(e) });
  fake.stream.emit("response", { ":status": 200 });
  fake.stream.emit("trailers", { "grpc-status": "8", "grpc-message": "quota" });
  ok("RESOURCE_EXHAUSTED in the trailers is an error with its name",
    errors[0] instanceof GrpcStatusError && errors[0].status === GRPC_STATUS[8], errors[0]?.message);

  const f2 = fakeHttp2();
  const e2 = [];
  openGrpcStream({ url: "https://x.example.com", path: "/p", http2: f2.module, onMessage: () => {}, onError: (e) => e2.push(e) });
  f2.stream.emit("response", { ":status": 502 });
  ok("an HTTP 502 from a proxy in front of the endpoint is named as HTTP, not as gRPC",
    e2[0] instanceof GrpcWireError && e2[0].httpStatus === 502, e2[0]?.message);
}

console.log("\nbad bytes on the stream kill the call rather than being decoded onward");
{
  const fake = fakeHttp2();
  const errors = [];
  openGrpcStream({ url: "https://x.example.com", path: "/p", http2: fake.module, onMessage: () => {}, onError: (e) => errors.push(e) });
  fake.stream.emit("response", { ":status": 200 });
  fake.stream.emit("data", Buffer.from([1, 0, 0, 0, 1, 0xff])); // compressed flag set
  ok("a compressed frame ends the call with the reason named",
    errors.length === 1 && /compressed/.test(errors[0].message), errors[0]?.message);
}

console.log("\na handler that throws costs the call, never the process");
{
  const fake = fakeHttp2();
  const errors = [];
  openGrpcStream({
    url: "https://x.example.com", path: "/p", http2: fake.module,
    onMessage: () => { throw new Error("parser blew up"); }, onError: (e) => errors.push(e),
  });
  fake.stream.emit("response", { ":status": 200 });
  const e = threw(() => fake.stream.emit("data", frame(Buffer.from("x"))));
  ok("the throw does not escape the data handler", e === null, e?.message);
  ok("...it is reported as the call's error", errors.length === 1 && /parser blew up/.test(errors[0].message));
}

console.log("\nit refuses to open anything it should not");
{
  ok("http:// is refused — a token on a plaintext socket is a leaked token",
    threw(() => openGrpcStream({ url: "http://x.example.com", path: "/p", onMessage: () => {} })) instanceof GrpcWireError);
  ok("a path that is not a path is refused",
    threw(() => openGrpcStream({ url: "https://x.example.com", path: "geyser", onMessage: () => {} })) instanceof GrpcWireError);
  ok("no onMessage is refused: a subscription nobody reads is a socket held open for nothing",
    threw(() => openGrpcStream({ url: "https://x.example.com", path: "/p" })) instanceof GrpcWireError);
}

console.log("\na connect that never answers fails in seconds, not in silence");
{
  const fake = fakeHttp2();
  const errors = [];
  openGrpcStream({
    url: "https://x.example.com", path: "/p", http2: fake.module,
    onMessage: () => {}, onError: (e) => errors.push(e), connectTimeoutMs: 1,
  });
  await new Promise((r) => setTimeout(r, 12));
  ok("the timer fires and names the endpoint", errors.length === 1 && /did not produce headers/.test(errors[0].message), errors[0]?.message);

  const f2 = fakeHttp2();
  const e2 = [];
  openGrpcStream({
    url: "https://y.example.com", path: "/p", http2: f2.module,
    onMessage: () => {}, onError: (e) => e2.push(e), connectTimeoutMs: 1,
  });
  f2.stream.emit("response", { ":status": 200 });
  await new Promise((r) => setTimeout(r, 12));
  ok("...and a stream that DID answer is never failed by it", e2.length === 0, e2[0]?.message);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} test-grpc-wire  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
