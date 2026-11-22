// Which sport a marketplace-grid `products` request ACTUALLY applied (2026-11-22), as a pure
// function so it can be tested (the runner needs a logged-in Chrome and cannot run in CI).
//
// The grid op carries its filter as a string, e.g. applied_filters: "marketplace-nfts?sport=Soccer&p=4".
// The runner used to credit every grid item to the sport its LOOP had navigated to. On 2026-11-22 the
// residential runner's "Womens Soccer" pass served the Basketball/WNBA set ids (none of NWSL's
// 2478/2460, 13 new cards in 76 pages) while the same URL served NWSL in a normal Chrome — and the
// sightings relabelled two basketball products (2053, 1981) last_grid_sport = "Womens Soccer". A
// sighting is now credited to the sport the REQUEST applied; the loop's sport is only the fallback
// when the request names none.

// ⚠ 2026-11-22 (read from the laptop's panini-ops-capture.jsonl): applied_filters is NOT a JSON
// field — it sits inside the GraphQL QUERY TEXT, `products(... applied_filters: "marketplace-nfts?
// sport=Basketball&p=1" ...)` with `"variables": {}`. The first version deep-searched the parsed JSON
// for an `applied_filters` key and so returned null for every real request. Read the raw text.
const APPLIED_RE = /applied_filters\s*:\s*\\*"([^"\\]+)/

/** The `sport` value of a Panini filter string or URL ("marketplace-nfts?sport=X&p=2", a page URL). */
export function sportParamOf(s) {
  if (typeof s !== "string" || !s.includes("?")) return null
  for (const part of s.slice(s.indexOf("?") + 1).split("#")[0].split("&")) {
    const eq = part.indexOf("=")
    if (eq < 0 || part.slice(0, eq).trim().toLowerCase() !== "sport") continue
    let v = part.slice(eq + 1).replace(/\+/g, " ")
    try { v = decodeURIComponent(v) } catch { /* keep the raw value */ }
    v = v.trim()
    return v || null
  }
  return null
}

/** The `sport` value a grid request applied, or null when the body names none. */
export function appliedSportOf(postData) {
  if (typeof postData !== "string" || !postData) return null
  // JSON.parse first so escaped quotes in the query text become plain quotes; fall back to the raw text.
  let text = postData
  try { const j = JSON.parse(postData); if (j && typeof j.query === "string") text = j.query + "\n" + JSON.stringify(j.variables ?? {}) } catch { /* raw text */ }
  const m = APPLIED_RE.exec(text) || /"applied_filters"\s*:\s*"([^"]+)"/.exec(text)
  return m ? sportParamOf(m[1].includes("?") ? m[1] : `?${m[1]}`) : null
}

/** Same sport, ignoring case and spacing ("WOMENS SOCCER" == "Womens Soccer"). */
export function sameSport(a, b) {
  const n = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim()
  return n(a) !== "" && n(a) === n(b)
}

// STALE FILTER CACHE (2026-11-22, the NWSL root cause). Panini's SPA keeps its filter metadata
// (the sport list among it) in redux-persist — IndexedDB `localforage` / store `keyvaluepairs` /
// key `reduxPersist:Filters` — versioned by localStorage `filter_timestamp` (+ `pack_filter_timestamp`).
// The residential runner's long-lived profile held a copy from before "Womens Soccer" existed (the
// live stamp, 1795240806911, is the NWSL launch, Nov 20 ~2 PM PT), so `?sport=Womens%20Soccer`
// loaded and the app redirected to `?sport=Basketball` 3 s later (ops capture, 2:14:07 → 2:14:10 PM
// PT) — every "Womens Soccer" grid page was Basketball's. Clearing ONLY these keys makes the app
// refetch its filters; auth, wallet and the rest of the persisted state are untouched.
export const PANINI_FILTER_CACHE = Object.freeze({
  localStorageKeys: ["filter_timestamp", "pack_filter_timestamp"],
  idbName: "localforage",
  idbStore: "keyvaluepairs",
  idbKeys: ["reduxPersist:Filters"],
})

/**
 * Runs IN THE PAGE (Playwright `page.evaluate(clearFilterCacheInPage, PANINI_FILTER_CACHE)`), so it
 * must be self-contained. Resolves to what it removed; never throws.
 */
export async function clearFilterCacheInPage(cfg) {
  const out = { localStorage: [], idb: [], error: null }
  try {
    for (const k of cfg.localStorageKeys) {
      if (localStorage.getItem(k) !== null) { localStorage.removeItem(k); out.localStorage.push(k) }
    }
    // Never CREATE the database: open() on a missing name makes an empty one, which could upset
    // localforage's own versioned open later.
    const known = typeof indexedDB.databases === "function" ? await indexedDB.databases() : null
    if (known && !known.some((d) => d && d.name === cfg.idbName)) return out
    await new Promise((resolve) => {
      const req = indexedDB.open(cfg.idbName)
      req.onerror = () => resolve()
      req.onsuccess = () => {
        const db = req.result
        if (![...db.objectStoreNames].includes(cfg.idbStore)) { db.close(); resolve(); return }
        const tx = db.transaction(cfg.idbStore, "readwrite")
        const store = tx.objectStore(cfg.idbStore)
        for (const k of cfg.idbKeys) { store.delete(k); out.idb.push(k) }
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); resolve() }
      }
    })
  } catch (e) {
    out.error = String(e && e.message ? e.message : e)
  }
  return out
}
