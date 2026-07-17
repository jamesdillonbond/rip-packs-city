// panini-replay.mjs — POST a saved panini-capture.jsonl to the ingest route.
// Use when a runner walk captured data but the POSTs 401'd on a bad token:
//   fix the token, then:  PANINI_BACKUP_FILE=panini-capture.jsonl node scripts/panini-replay.mjs
// Env: RPC_PANINI_INGEST_URL, INGEST_SECRET_TOKEN, PANINI_BACKUP_FILE (default panini-capture.jsonl)
import fs from "node:fs";
const URL = process.env.RPC_PANINI_INGEST_URL;
const TOKEN = process.env.INGEST_SECRET_TOKEN;
const FILE = process.env.PANINI_BACKUP_FILE || "panini-capture.jsonl";
if (!URL || !TOKEN) throw new Error("missing RPC_PANINI_INGEST_URL / INGEST_SECRET_TOKEN");
if (!fs.existsSync(FILE)) throw new Error(`no backup file: ${FILE}`);
const lines = fs.readFileSync(FILE, "utf8").split(/\r?\n/).filter(Boolean);
console.log(`[panini-replay] ${lines.length} batches from ${FILE}`);
let ok = 0, fail = 0;
for (const line of lines) {
  const r = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: line });
  if (r.status === 202) ok++; else { fail++; if (fail <= 3) console.log(`  batch -> ${r.status}`); }
}
console.log(`[panini-replay] done: ${ok} accepted, ${fail} failed`);
if (fail) process.exit(1);
