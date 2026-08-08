// lib/safe-lookup.ts
//
// Own-property map read. Returns map[key] ONLY when key is the map's own
// property — never an inherited Object.prototype member. Use for any lookup on a
// plain-object literal (`Record<string, T>`) whose key is externally controlled
// (URL slug, query param, user/DB value): a bare `map[key]` resolves a crafted
// key like "constructor" / "toString" / "hasOwnProperty" / "valueOf" to a truthy
// Object.prototype member, which then defeats a `?? fallback` and surfaces a
// function where a value is expected (a wrong render, or a throw downstream).
//
// This is the shared form of the guard already inlined in lib/market-closed.ts,
// lib/collection-tiers.ts, lib/cosmetics.ts, lib/analytics/format.ts, and
// lib/seo.ts. New code should prefer `ownLookup(MAP, key) ?? fallback`.
export function ownLookup<T>(
  map: Record<string, T>,
  key: string | null | undefined,
): T | undefined {
  if (key == null) return undefined;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}
