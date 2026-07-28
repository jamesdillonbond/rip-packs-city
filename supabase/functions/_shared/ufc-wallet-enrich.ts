// Shared pure logic for enrich-ufc-wallet — the edge fn that reads a UFC Strike
// moment's on-chain Display/Editions metadata and writes the fighter name, tier,
// and edition key into wallet_moments_cache. Its parse/decode core decides WHAT
// NAME and WHAT TIER land on a collector's moment, so a regression here either
// (a) persists mojibake for any accented fighter (José Aldo / Michał class — the
// same latin1-atob corruption that hit sibling paths on 2026-07-25/27) or
// (b) mis-scores an edition's tier, which feeds scarcity into FMV/pack-EV — the
// fabricated-data class.
//
// Ported VERBATIM from enrich-ufc-wallet/index.ts. The deployed edge fn still
// carries inline copies; the source-drift guard in __tests__/edge-ufc-wallet-
// enrich.test.ts fails CI if an inline copy is edited without mirroring it here.
// atob / TextDecoder are globals in both Deno and Node ≥16, so this imports
// cleanly under vitest.

/**
 * base64 → JS string, UTF-8 CORRECT. Plain `atob` returns latin1 (one byte = one
 * char), double-encoding every multi-byte UTF-8 sequence ("José" → "JosÃ©"); on
 * this path that would persist mojibake into wallet_moments_cache.player_name.
 * Pure-ASCII payloads decode identically, so this is a no-op for them.
 */
export function b64ToUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder("utf-8").decode(bytes)
}

/**
 * UFC Strike tier from an edition's max circulation. The ladder is
 * max-circulation banded; a mis-band mis-scores scarcity, which flows into FMV
 * and pack-EV. NULL / 0 max (no edition info) → FANDOM (the safe base tier).
 */
export function inferTier(max: number | null): string {
  if (!max || max === 0) return "FANDOM"
  if (max <= 10) return "ULTIMATE"
  if (max <= 99) return "CHAMPION"
  if (max <= 999) return "CHALLENGER"
  if (max <= 25000) return "CONTENDER"
  return "FANDOM"
}

/** Slug-style edition key: name → dash-collapsed + "-" + max (0 when absent). */
export function makeEditionKey(name: string, max: number | null): string {
  return name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + (max ?? 0)
}

/**
 * Cadence Flow-REST `{String: String}` → JS dict. A malformed entry is skipped
 * only insofar as it is absent; this mirrors the edge fn exactly (it trusts the
 * `raw.value` array shape), so keep the two in lockstep via the drift guard.
 */
export function parseResult(raw: any): Record<string, string> {
  const f: Record<string, string> = {}
  if (raw?.value) for (const e of raw.value) f[e.key.value] = e.value.value
  return f
}

/** Title-case a whitespace-separated string (empty words preserved). */
export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}
