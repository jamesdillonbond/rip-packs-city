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
// Each psku appears once, at its earliest position.

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
  const fresh = knownComplete ? discovered.filter((p) => !knownSet.has(p)) : [];
  const seen = new Set();
  const pskus = [];
  let priorityCount = 0;
  let freshCount = 0;
  for (const p of priority) if (!seen.has(p)) { seen.add(p); pskus.push(p); priorityCount++; }
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
