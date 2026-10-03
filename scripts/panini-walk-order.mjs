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
// Each psku appears once, at its earliest position.
/**
 * @param {{ priority?: string[], known?: string[], knownComplete?: boolean, discovered?: string[] }} args
 * @returns {{ pskus: string[], orderMode: string, priorityCount: number, freshCount: number }}
 */
export function buildWalkOrder({ priority = [], known = [], knownComplete = false, discovered = [] }) {
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
  const orderMode = knownComplete
    ? `stalest-first, interleaved (${pri}${freshCount} new + ${known.length} known)`
    : `stalest-first, PARTIAL list (${pri}${known.length} known; new-first promotion disabled)`;
  return { pskus, orderMode, priorityCount, freshCount };
}
