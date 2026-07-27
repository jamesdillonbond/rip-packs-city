// Shared pure logic for topshot-stub-resolver — the edge fn that resolves
// integer-pair TopShot edition stubs (player_name / set_name NULL) via the
// on-chain TopShot contract and writes the resolved names straight into
// `editions` (upsert_topshot_edition_metadata). Its parse/decode core decides
// WHAT NAME lands on a collector's moment, and it carries the exact mojibake trap
// (atob is latin1-only, so a base64 UTF-8 name double-encodes: "Dončić" →
// "DonÄiÄ‡") that already corrupted 846-edition-class rows on sibling paths.
//
// Ported VERBATIM from topshot-stub-resolver/index.ts (function_version 3). The
// deployed edge fn still carries inline copies; the source-drift guard in
// __tests__/edge-topshot-stub-parse.test.ts fails CI if an inline copy is edited
// without mirroring it here. btoa/atob/TextDecoder are globals in both Deno and
// Node ≥16, so this module imports cleanly under vitest.

/** JS string → base64, UTF-8 safe (the inverse of b64ToUtf8). */
export function b64Utf8(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
}

/**
 * base64 → JS string, UTF-8 CORRECT. Plain `atob` returns latin1 (one byte = one
 * char), double-encoding every multi-byte UTF-8 sequence; on this path that would
 * corrupt player/set/team names on their way into `editions`. Pure-ASCII payloads
 * decode identically, so this is a no-op for them.
 */
export function b64ToUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder("utf-8").decode(bytes)
}

/**
 * Cadence's Flow REST encoding for `{String: String}` returns a `value` array of
 * `{key: {value, type}, value: {value, type}}` entries. Flatten to a JS dict,
 * keeping only string→string pairs (a malformed entry is skipped, never throws).
 */
export function flattenCadenceDict(parsed: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  // deno-lint-ignore no-explicit-any
  const v = (parsed as any)?.value
  if (!Array.isArray(v)) return out
  for (const entry of v) {
    const k = entry?.key?.value
    const val = entry?.value?.value
    if (typeof k === "string" && typeof val === "string") out[k] = val
  }
  return out
}

/** The literal sentinel Top Shot stores on chain for an absent name field. */
const INVALID_ONCHAIN = "<invalid Value>"

/**
 * Top Shot's on-chain FullName is occasionally the literal string
 * "<invalid Value>" — fall back to FirstName/LastName when that happens. Returns
 * null when nothing usable exists (a play with no player, e.g. team-moment sets),
 * so the caller can skip the write instead of stamping an empty name.
 *
 * FirstName/LastName carry the SAME sentinel, and guarding only FullName let the
 * fallback compose the literal string "<invalid Value> <invalid Value>" and write
 * it to editions.player_name. Measured 2026-07-27: 4 of 42 sampled stub targets
 * (set 141, Champion's Path 2024) return exactly that shape, so this is a live
 * corruption path, not a theoretical one — it had simply never fired because the
 * queue was stuck on its first 50 rows and never reached them.
 */
export function pickPlayerName(meta: Record<string, string>): string | null {
  const full = meta.FullName
  if (full && full !== "<invalid Value>" && full.trim() !== "") return full.trim()
  const clean = (v: string | undefined): string => {
    const t = (v ?? "").trim()
    return t === INVALID_ONCHAIN ? "" : t
  }
  const first = clean(meta.FirstName)
  const last = clean(meta.LastName)
  const composed = [first, last].filter(Boolean).join(" ")
  return composed || null
}

export interface ResolvedMeta {
  playerName: string | null
  setName: string | null
  circulation: number | null
  team: string | null
  /** numeric on-chain series (UInt32 → JS number); display mapping is at render time */
  series: number | null
}

/**
 * Shape a flattened Cadence meta dict into the ResolvedMeta the resolver writes.
 * Mirrors resolveViaCadence's tail exactly: series/circulation are numeric ONLY
 * when finite (a non-numeric on-chain value → null, never NaN into a smallint
 * column); setName/team are trimmed and empty → null.
 */
export function parseResolvedMeta(meta: Record<string, string>): ResolvedMeta {
  const seriesRaw = meta.__SetSeries ?? null
  const series =
    seriesRaw != null && Number.isFinite(Number(seriesRaw)) ? Number(seriesRaw) : null

  const circRaw = meta.__Circulation ?? null
  const circulation =
    circRaw != null && Number.isFinite(Number(circRaw)) ? Number(circRaw) : null

  return {
    playerName: pickPlayerName(meta),
    setName: meta.__SetName?.trim() || null,
    circulation,
    team: meta.TeamAtMoment?.trim() || null,
    series,
  }
}
