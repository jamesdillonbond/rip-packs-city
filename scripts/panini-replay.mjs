// panini-replay.mjs — POST a saved panini-capture.jsonl to the ingest route.
// Use when a runner walk captured data but the POSTs 401'd on a bad token:
//   fix the token, then:  PANINI_BACKUP_FILE=panini-capture.jsonl node scripts/panini-replay.mjs
// Env: RPC_PANINI_INGEST_URL, INGEST_SECRET_TOKEN, PANINI_BACKUP_FILE (default panini-capture.jsonl)
//
// ⚠ STREAMS line-by-line (2026-08-13). This used to be readFileSync(FILE, "utf8"), which
// materializes the whole backup as ONE string — and Node caps a single string at 536,870,888
// bytes on 64-bit. The runner appended to that file unbounded, so it reached 1.27 GB, at which
// point this script threw before POSTing a single batch: the recovery tool could not read the
// file it exists to recover. The runner now bounds the backup, but streaming is what makes this
// script independent of that bound rather than merely lucky.
//
// ⚠ Replays the ROTATED generation first. The runner rotates BACKUP_FILE -> BACKUP_FILE + ".1"
// when it hits its cap, so the batches you are trying to recover may well be in ".1" — reading
// only the live file would silently skip them, which is the same failure this rewrite removes.
import fs from "node:fs";
import readline from "node:readline";
const URL = process.env.RPC_PANINI_INGEST_URL;
const TOKEN = process.env.INGEST_SECRET_TOKEN;
const FILE = process.env.PANINI_BACKUP_FILE || "panini-capture.jsonl";
if (!URL || !TOKEN) throw new Error("missing RPC_PANINI_INGEST_URL / INGEST_SECRET_TOKEN");

// Oldest first, so batches replay in capture order.
const FILES = [FILE + ".1", FILE].filter((f) => fs.existsSync(f));
if (!FILES.length) throw new Error(`no backup file: ${FILE} (nor ${FILE}.1)`);

let ok = 0, fail = 0, n = 0;
for (const f of FILES) {
  const bytes = fs.statSync(f).size;
  console.log(`[panini-replay] streaming ${f} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  const rl = readline.createInterface({ input: fs.createReadStream(f, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    n++;
    const r = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: line });
    if (r.status === 202) ok++;
    else {
      fail++;
      if (fail <= 3) console.log(`  batch -> ${r.status}`);
    }
    if (n % 500 === 0) console.log(`[panini-replay] ${n} batches (${ok} accepted, ${fail} failed)`);
  }
}
console.log(`[panini-replay] done: ${n} batches, ${ok} accepted, ${fail} failed`);
if (fail) process.exit(1);
