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

/** Deep-search a parsed request body for the first `applied_filters` string. */
function findAppliedFilters(o, depth) {
  if (!o || typeof o !== "object" || depth > 6) return null
  if (typeof o.applied_filters === "string") return o.applied_filters
  for (const k in o) {
    const v = o[k]
    if (v && typeof v === "object") {
      const r = findAppliedFilters(v, depth + 1)
      if (r) return r
    }
  }
  return null
}

/** The `sport` value a grid request applied, or null when the body names none. */
export function appliedSportOf(postData) {
  if (typeof postData !== "string" || !postData) return null
  let body
  try { body = JSON.parse(postData) } catch { return null }
  const af = findAppliedFilters(body, 0)
  if (!af) return null
  const q = af.includes("?") ? af.slice(af.indexOf("?") + 1) : af
  for (const part of q.split("&")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    if (part.slice(0, eq).trim().toLowerCase() !== "sport") continue
    let v = part.slice(eq + 1).replace(/\+/g, " ")
    try { v = decodeURIComponent(v) } catch { /* keep the raw value */ }
    v = v.trim()
    return v || null
  }
  return null
}

/** Same sport, ignoring case and spacing ("WOMENS SOCCER" == "Womens Soccer"). */
export function sameSport(a, b) {
  const n = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim()
  return n(a) !== "" && n(a) === n(b)
}
