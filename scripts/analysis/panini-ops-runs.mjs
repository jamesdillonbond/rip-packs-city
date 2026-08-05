// Segment the ops capture into RUNS (gap > 10 min) and, per run, ask the two
// questions that actually decide the fix:
//   (1) did getCardMarketStats fire at all?
//   (2) when it fired, did it carry payload (item_counts > 0)?
// The runner pushes only `if (d.getCardMarketStats?.data)`, so an op that fires
// with a null/empty data is indistinguishable from one that never fired -- at
// the `cards` array, but NOT here.
import fs from "fs";

const rows = [];
for (const f of process.argv.slice(2)) {
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
}
rows.sort((a, b) => a.ts.localeCompare(b.ts));

const runs = [];
let cur = null;
for (const r of rows) {
  const t = Date.parse(r.ts);
  if (!cur || t - cur.lastT > 10 * 60 * 1000) {
    cur = { start: r.ts, lastT: t, n: 0, cms: 0, cmsWithItems: 0, cmsZeroItems: 0, cmsNon200: 0, pskuList: 0, detail: new Set() };
    runs.push(cur);
  }
  cur.lastT = t; cur.end = r.ts; cur.n++;
  if (r.page && r.page.includes("/marketplace-details/")) cur.detail.add(r.page);
  const keys = r.data_keys || [];
  if (r.op === "getCardMarketStats" || keys.includes("getCardMarketStats")) {
    cur.cms++;
    if (r.status !== 200) cur.cmsNon200++;
    const c = (r.item_counts || {}).getCardMarketStats;
    if (c && c > 0) cur.cmsWithItems++; else cur.cmsZeroItems++;
  }
  if (keys.includes("getPskuTotalCardsList")) cur.pskuList++;
}

console.log("run_start(UTC)          dur_min  lines  detailPages  CMS  CMS_items>0  CMS_items=0  CMS_non200  pskuList");
for (const r of runs) {
  const dur = ((Date.parse(r.end) - Date.parse(r.start)) / 60000).toFixed(1);
  console.log(
    r.start.slice(0, 19).padEnd(22),
    String(dur).padStart(7),
    String(r.n).padStart(6),
    String(r.detail.size).padStart(12),
    String(r.cms).padStart(4),
    String(r.cmsWithItems).padStart(12),
    String(r.cmsZeroItems).padStart(12),
    String(r.cmsNon200).padStart(11),
    String(r.pskuList).padStart(9),
  );
}

// What do the zero-item getCardMarketStats responses look like?
console.log("\n=== sample getCardMarketStats rows, newest 6 ===");
const cms = rows.filter(r => r.op === "getCardMarketStats").slice(-6);
for (const r of cms) {
  console.log(r.ts, "status=" + r.status, "keys=" + JSON.stringify(r.data_keys), "counts=" + JSON.stringify(r.item_counts));
}
