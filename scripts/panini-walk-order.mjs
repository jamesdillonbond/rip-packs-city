// The residential Panini runner's walk ORDER, as a pure function so it can be tested (the runner
// itself needs a logged-in Chrome and cannot run in CI). Extracted from
// scripts/ingest-panini-runner.mjs 2026-09-29.
//
// Three sources, walked in this order:
//
//   1. PRIORITY — pskus the route names explicitly (`priority_pskus`: editions a walked collector
//      HOLDS in an admitted product that have no catalogue row yet). Added 2026-09-29 after the
//      route began prepending them to `pskus`: that put them at the front of the KNOWN list, but
//      the runner walks brand-new grid discoveries BEFORE the known list, and with 1,464–3,900 new
//      per run against ~660 walked per ~4 h run, not one of 136 held editions was walked. They
//      are an explicit list, so they need no completeness test and go first unconditionally.
//   2. FRESH — enumerated this run and absent from the catalogue. "Absent" means brand new ONLY
//      when the catalogue list is COMPLETE; on a partial list every recently-walked edition is
//      also absent, so promotion is gated on `knownComplete`.
//   3. KNOWN (stalest first), then anything else enumerated.
//
// ⚠ 2026-10-02: FRESH and KNOWN are INTERLEAVED 1:1, not fresh-then-known. Admitting 22 products put
// ~4,400 brand-new discoveries in front of the known list at ~600 cards a run: about a day with ZERO
// refresh of the existing catalogue, while 4,837 editions were already 4+ days old. Interleaving
// keeps both moving: new cards still enter at half the walk rate, and the stalest known card is never
// more than one slot behind a discovery.
//
// ⚠ 2026-10-18: PRICED PRODUCTS GET MORE OF THE KNOWN SLOTS. With 35,646 walked pskus across every
// admitted product, stalest-first spread the walk so thin that World Cup Prizm — the ONLY product
// with an FMV model — went from ~30 h to 77 h median age (p90 106 h), and 2,630 WC editions sat on
// the old engine for 4 days. `isPriced` + `pricedPerOther` reorder the KNOWN list as a weighted
// merge: N priced (stalest first) per 1 other (stalest first), so priced cards refresh ~N× faster and
// every other product still advances every run (no starvation: a strict "priced first" would park
// the other 30k forever, since the order is rebuilt from scratch each run). Off unless both are given.
//
// ⚠ 2026-11-08: FRESH IS ROUND-ROBINED ACROSS PRODUCTS. Discovery order is GRID order (Soccer first,
// Entertainment last of seven), and a full run walks only ~250 fresh cards after the held-priority
// list — so the last grid's products sat at the tail of 8,769 fresh pskus, about a week of full runs
// (walk runs never add fresh). Measured that day: The Rolling Stones (2130), Moonbirds (850178) and
// Sunnyside Silvershells (850179) admitted at noon, seen in the 2:00 PM grid, 0 cards walked. Now the
// fresh list takes one psku per product in turn (products in first-seen order, each product's own
// order kept), so a newly admitted product gets a fresh slot every cycle. Ids that name no product
// (`packcard-<set>_…` absent) share one bucket, so their order is exactly what it was.
//
// ⚠ 2026-11-08 (evening): HELD-PRIORITY AND FRESH ALTERNATE 1:1. The round-robin above never ran: a
// FULL run spends ~85 min of its 2 h slot on the seven grids and walks only ~260 cards, and the
// held-priority list (2,153 → 1,807 across 6 h) is always longer than that — so the 6:00 PM run walked
// 260 priority cards and 0 of 9,221 fresh. Priority-first was decided 09-29 because held cards got 0
// of ~660 slots behind fresh; 1:1 still gives them half of every full run and ALL of a walk run (walk
// runs enumerate nothing, so fresh is empty there and priority stays strictly first). Once priority
// runs out, the remaining fresh and the known list alternate 1:1 as before.
//
// Each psku appears once, at its earliest position.

/** `packcard-2130_415500_32` → "2130"; anything else → "" (one shared bucket). */
function productKeyOf(psku) {
  const m = /^packcard-([0-9]+)_/.exec(String(psku));
  return m ? m[1] : "";
}

/** One psku per product in turn; products in first-seen order, each product's own order kept. */
export function roundRobinByProduct(list) {
  const buckets = new Map();
  for (const p of list) {
    const k = productKeyOf(p);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }
  const queues = [...buckets.values()];
  const out = [];
  for (let i = 0; out.length < list.length; i++) {
    for (const q of queues) if (i < q.length) out.push(q[i]);
  }
  return out;
}

/** Weighted merge preserving each list's own order: `n` from `a`, then 1 from `b`, repeat. */
export function weightedMerge(a, b, n) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    for (let k = 0; k < n && i < a.length; k++) out.push(a[i++]);
    if (j < b.length) out.push(b[j++]);
  }
  return out;
}

/**
 * @param {{ priority?: string[], known?: string[], knownComplete?: boolean, discovered?: string[],
 *           isPriced?: (psku: string) => boolean, pricedPerOther?: number }} args
 * @returns {{ pskus: string[], orderMode: string, priorityCount: number, freshCount: number }}
 */
export function buildWalkOrder({ priority = [], known: knownIn = [], knownComplete = false, discovered = [], isPriced, pricedPerOther = 0 }) {
  const weighted = typeof isPriced === "function" && Number.isInteger(pricedPerOther) && pricedPerOther > 0;
  const known = weighted
    ? weightedMerge(knownIn.filter((p) => isPriced(p)), knownIn.filter((p) => !isPriced(p)), pricedPerOther)
    : knownIn;
  const knownSet = new Set(known);
  const fresh = knownComplete ? roundRobinByProduct(discovered.filter((p) => !knownSet.has(p))) : [];
  const seen = new Set();
  const pskus = [];
  let priorityCount = 0;
  let freshCount = 0;
  // Priority and fresh alternate 1:1 while priority lasts (2026-11-08, see the header).
  const prioritySet = new Set(priority);
  const freshQ = fresh.filter((p) => !prioritySet.has(p));
  let fi = 0;
  for (const p of priority) {
    if (seen.has(p)) continue;
    seen.add(p); pskus.push(p); priorityCount++;
    while (fi < freshQ.length && seen.has(freshQ[fi])) fi++;
    if (fi < freshQ.length) { const f = freshQ[fi++]; seen.add(f); pskus.push(f); freshCount++; }
  }
  const freshLeft = fresh.filter((p) => !seen.has(p));
  const knownLeft = known.filter((p) => !seen.has(p));
  for (let i = 0; i < Math.max(freshLeft.length, knownLeft.length); i++) {
    const f = freshLeft[i];
    if (f !== undefined && !seen.has(f)) { seen.add(f); pskus.push(f); freshCount++; }
    const k = knownLeft[i];
    if (k !== undefined && !seen.has(k)) { seen.add(k); pskus.push(k); }
  }
  for (const p of [...known, ...discovered]) if (!seen.has(p)) { seen.add(p); pskus.push(p); }
  const pri = priorityCount ? `${priorityCount} held-priority + ` : "";
  const w = weighted ? `, priced ${pricedPerOther}:1 (${knownIn.filter((p) => isPriced(p)).length} priced)` : "";
  const orderMode = knownComplete
    ? `stalest-first, interleaved (${pri}${freshCount} new + ${known.length} known${w})`
    : `stalest-first, PARTIAL list (${pri}${known.length} known${w}; new-first promotion disabled)`;
  return { pskus, orderMode, priorityCount, freshCount };
}
