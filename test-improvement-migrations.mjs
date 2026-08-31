import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "claude-co-legacy-migration-"));
const dbFile = path.join(sandbox, "legacy.sqlite");

const legacySchema = `
CREATE TABLE decision_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_key TEXT NOT NULL UNIQUE,
  cycle TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  run_kind TEXT NOT NULL DEFAULT 'workup',
  decided_at INTEGER NOT NULL,
  entry_price REAL,
  round_trip_cost_pct REAL,
  size_usd REAL,
  outcome TEXT,
  final_decision TEXT,
  binding_gate TEXT,
  raw_redteam TEXT,
  effective_redteam TEXT,
  redteam_binding INTEGER NOT NULL DEFAULT 0,
  evaluation_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  models_json TEXT NOT NULL,
  config_json TEXT NOT NULL,
  weights_json TEXT NOT NULL,
  attribution_json TEXT,
  record_json TEXT NOT NULL
);
CREATE INDEX idx_decision_runs_mint ON decision_runs(mint, decided_at);

CREATE TABLE forward_marks (
  run_id INTEGER NOT NULL REFERENCES decision_runs(id),
  horizon_min INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  observed_at INTEGER,
  price_mid REAL,
  liquidity_usd REAL,
  mark_method TEXT,
  gross_return_pct REAL,
  net_return_pct REAL,
  mae_pct REAL,
  mfe_pct REAL,
  data_status TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (run_id, horizon_min)
);
CREATE INDEX idx_forward_marks_due ON forward_marks(data_status, due_at);

CREATE TABLE simulated_outcomes (
  run_id INTEGER PRIMARY KEY REFERENCES decision_runs(id),
  policy_version TEXT NOT NULL,
  observed_at INTEGER,
  exit_price REAL,
  exit_reason TEXT,
  gross_return_pct REAL,
  net_return_pct REAL,
  pnl_usd REAL,
  mae_pct REAL,
  mfe_pct REAL,
  data_status TEXT NOT NULL
);

CREATE TABLE llm_spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seat TEXT,
  model TEXT,
  effort TEXT,
  in_tok INTEGER,
  out_tok INTEGER,
  cached_tok INTEGER,
  usd REAL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_spend_ts ON llm_spend(ts);

CREATE TABLE calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  symbol TEXT,
  category TEXT,
  launchpad TEXT,
  status TEXT NOT NULL DEFAULT 'live',
  conviction REAL,
  entry_ref REAL,
  entry_lo REAL,
  entry_hi REAL,
  stop REAL,
  target REAL,
  thesis TEXT,
  invalidation TEXT,
  flags_at_call TEXT,
  liq_at_call REAL,
  rt_loss_at_call REAL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT,
  close_mark REAL,
  report_file TEXT,
  image_url TEXT,
  last_verified_at INTEGER,
  mcap_at_call REAL,
  desk_size_usd REAL,
  desk_risk_usd REAL,
  desk_equity_usd REAL,
  policy_version TEXT
);
CREATE INDEX idx_calls_status ON calls(status, id DESC);
CREATE UNIQUE INDEX ux_calls_live_mint ON calls(mint) WHERE status='live';

CREATE TABLE call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL REFERENCES calls(id),
  kind TEXT NOT NULL,
  detail TEXT,
  mark REAL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_call_events ON call_events(call_id, id DESC);

CREATE TABLE chronicle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  floor INTEGER,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX idx_chronicle_ts ON chronicle(id DESC);
CREATE INDEX idx_chronicle_floor ON chronicle(floor, id DESC);
CREATE INDEX idx_chronicle_type_ts ON chronicle(type, ts);
`;

const legacyRows = `
INSERT INTO decision_runs
  (run_key,cycle,mint,symbol,run_kind,decided_at,entry_price,evaluation_version,
   policy_version,prompt_version,models_json,config_json,weights_json,record_json)
VALUES
  ('legacy:decision','legacy','legacy-decision','OLD','workup',1700000000000,1,
   'old-evaluation','old-policy','old-prompt','{}','{}','{}','{}');
INSERT INTO forward_marks (run_id,horizon_min,due_at) VALUES (1,15,1700000900000);
INSERT INTO simulated_outcomes (run_id,policy_version,data_status)
  VALUES (1,'old-policy','unavailable');
INSERT INTO llm_spend (seat,model,effort,in_tok,out_tok,cached_tok,usd,ts)
  VALUES ('Legacy','old-model','low',1,1,0,1.25,1700000000000);
INSERT INTO calls (mint,symbol,opened_at,policy_version)
  VALUES ('legacy-call','OLD',1700000000000,'old-policy');
INSERT INTO call_events (call_id,kind,detail,ts)
  VALUES (1,'legacy','old event',1700000000000);
INSERT INTO chronicle (ts,floor,type,data)
  VALUES (1700000000000,NULL,'legacy:event','{"type":"legacy:event","ts":1700000000000}');
`;

const moduleUrl = (relativePath) => pathToFileURL(path.join(ROOT, relativePath)).href;
const childSource = `
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const legacy = new DatabaseSync(process.env.CLAUDE_CO_DB);
legacy.exec(${JSON.stringify(legacySchema)});
legacy.exec(${JSON.stringify(legacyRows)});
legacy.close();

const evaluation = await import(${JSON.stringify(moduleUrl("src/evaluation.js"))});
const calls = await import(${JSON.stringify(moduleUrl("src/calls.js"))});
const bus = await import(${JSON.stringify(moduleUrl("src/lib/bus.js"))});
await import(${JSON.stringify(moduleUrl("src/lib/llm.js"))});
const db = (await import(${JSON.stringify(moduleUrl("src/lib/store.js"))})).default;

const columns = (table) => new Set(db.prepare("PRAGMA table_info(" + table + ")").all().map((row) => row.name));
const plainRow = (row) => ({ ...row });
for (const [table, expected] of Object.entries({
  decision_runs: ["floor_no", "evidence_scope", "prompt_manifest_hash", "behavior_fingerprint", "behavior_profile_json", "source_commit", "published_call_id"],
  forward_marks: ["mark_delay_ms"],
  llm_spend: ["floor", "floor_attributed", "evidence_scope"],
  calls: ["source_floor", "source_scope", "source_attributed"],
  chronicle: ["floor_attributed", "evidence_scope"],
})) {
  const actual = columns(table);
  assert.equal(expected.every((name) => actual.has(name)), true, table + " migration columns");
}

assert.deepEqual(
  plainRow(db.prepare("SELECT floor_no,evidence_scope,prompt_manifest_hash,behavior_fingerprint,behavior_profile_json,source_commit,published_call_id FROM decision_runs WHERE run_key='legacy:decision'").get()),
  { floor_no: null, evidence_scope: "unattributed", prompt_manifest_hash: null,
    behavior_fingerprint: null, behavior_profile_json: null, source_commit: null,
    published_call_id: null });
assert.deepEqual(
  plainRow(db.prepare("SELECT mark_delay_ms,data_status FROM forward_marks WHERE run_id=1 AND horizon_min=15").get()),
  { mark_delay_ms: null, data_status: "pending" });
assert.deepEqual(
  plainRow(db.prepare("SELECT floor,floor_attributed,evidence_scope FROM llm_spend WHERE seat='Legacy'").get()),
  { floor: null, floor_attributed: 0, evidence_scope: "unattributed" });
assert.deepEqual(
  plainRow(db.prepare("SELECT source_floor,source_scope,source_attributed FROM calls WHERE mint='legacy-call'").get()),
  { source_floor: null, source_scope: "unattributed", source_attributed: 0 });
assert.deepEqual(
  plainRow(db.prepare("SELECT floor_attributed,evidence_scope FROM chronicle WHERE type='legacy:event'").get()),
  { floor_attributed: 0, evidence_scope: "unattributed" });

const now = 1800000000000;
const decisionId = evaluation.recordDecision("migration-cycle", {
  mint: "new-decision", symbol: "NEW", runKind: "cycle", outcome: "decided",
  finalDecision: "APPROVED",
  ev: { pair: { priceUsd: 1 }, exitProbe: { roundTripLossPct: 1 } },
}, now);
const newDecision = db.prepare("SELECT floor_no,evidence_scope,prompt_manifest_hash,behavior_fingerprint,source_commit FROM decision_runs WHERE id=?").get(decisionId);
assert.equal(newDecision.floor_no, null);
assert.equal(newDecision.evidence_scope, "house");
assert.match(newDecision.prompt_manifest_hash, /^[0-9a-f]{64}$/);
assert.match(newDecision.behavior_fingerprint, /^[0-9a-f]{64}$/);
assert.match(newDecision.source_commit, /^[0-9a-f]{40}$/);

const newCall = calls.openCall({ mint: "new-call", symbol: "NEW",
  sourceFloor: null, sourceScope: "house", sourceAttributed: true });
assert.deepEqual(
  plainRow(db.prepare("SELECT source_floor,source_scope,source_attributed FROM calls WHERE id=?").get(newCall.id)),
  { source_floor: null, source_scope: "house", source_attributed: 1 });
assert.equal(evaluation.linkPublishedCall(decisionId, newCall.id), true);
assert.equal(db.prepare("SELECT published_call_id FROM decision_runs WHERE id=?").get(decisionId).published_call_id,
  newCall.id);

bus.emit("migration:new", { check: true });
assert.deepEqual(
  plainRow(db.prepare("SELECT floor,floor_attributed,evidence_scope FROM chronicle WHERE type='migration:new' ORDER BY id DESC LIMIT 1").get()),
  { floor: null, floor_attributed: 1, evidence_scope: "house" });

const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
for (const name of ["idx_decision_runs_provenance", "idx_decision_runs_behavior",
  "idx_decision_runs_publication", "idx_forward_marks_evaluation", "idx_spend_floor_ts", "idx_calls_provenance",
  "idx_calls_closed_provenance", "idx_chronicle_provenance"]) {
  assert.equal(indexes.has(name), true, name + " exists");
}
db.close();
console.log("legacy schema migrated and current provenance writes succeeded");
`;

console.log("\nLEGACY SQLITE MIGRATIONS ARE FORWARD-SAFE");
try {
  const run = spawnSync(process.execPath, ["--input-type=module", "--eval", childSource], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CLAUDE_CO_DB: dbFile,
      ANTHROPIC_API_KEY: "",
      XAI_API_KEY: "",
      OPENAI_API_KEY: "",
      EXECUTE: "0",
    },
  });
  assert.equal(run.status, 0, [run.stdout, run.stderr].filter(Boolean).join("\n"));
  console.log("  ✓ exact pre-change schemas boot through current migrations");
  console.log("  ✓ historical rows remain explicitly unattributed");
  console.log("  ✓ current decision, call, and chronicle writes retain house provenance");
  console.log("  ✓ provenance indexes are present");
  console.log("\n4 passed, 0 failed\n");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
