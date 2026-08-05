// Analyze the panini ops capture: does getCardMarketStats EVER appear?
// Count by BOTH `op` (operationName, which can be null) and `data_keys`
// (the actual response shape) — counting only by `op` would undercount.
import fs from "fs";

const files = process.argv.slice(2);
const byOp = new Map(), byKey = new Map();
let total = 0, bad = 0, nullOp = 0;
const detailPages = new Map(); // page url -> {ts, keys:Set}
const statuses = new Map();

for (const f of files) {
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { bad++; continue; }
    total++;
    const op = r.op || "(null-operationName)";
    if (!r.op) nullOp++;
    byOp.set(op, (byOp.get(op) || 0) + 1);
    statuses.set(r.status, (statuses.get(r.status) || 0) + 1);
    for (const k of r.data_keys || []) byKey.set(k, (byKey.get(k) || 0) + 1);
    if (r.page && r.page.includes("/marketplace-details/")) {
      if (!detailPages.has(r.page)) detailPages.set(r.page, { first: r.ts, keys: new Set(), ops: new Set() });
      const e = detailPages.get(r.page);
      for (const k of r.data_keys || []) e.keys.add(k);
      e.ops.add(op);
      e.last = r.ts;
    }
  }
}

const show = (m, label) => {
  console.log(`\n=== ${label} ===`);
  [...m.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(7), k));
};
console.log(`files=${files.length} lines=${total} unparseable=${bad} null-operationName=${nullOp}`);
show(statuses, "HTTP status");
show(byOp, "by op (operationName)");
show(byKey, "by data_keys (actual response shape)");

console.log(`\n=== marketplace-details pages: ${detailPages.size} distinct ===`);
const keyHist = new Map();
for (const [, e] of detailPages) {
  const sig = [...e.keys].sort().join(",") || "(no data keys)";
  keyHist.set(sig, (keyHist.get(sig) || 0) + 1);
}
show(keyHist, "per-detail-page union of data_keys");

// The decisive check: any trace of the card-detail op, anywhere, any spelling?
const NEEDLE = /cardmarketstats/i;
let hits = 0;
for (const f of files) {
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (NEEDLE.test(line)) hits++;
  }
}
console.log(`\n=== raw substring /cardmarketstats/i across ALL lines (incl. request payloads): ${hits} ===`);
