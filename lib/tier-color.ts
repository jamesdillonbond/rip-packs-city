// lib/tier-color.ts
//
// Shared tier-colour plumbing for the four surfaces that used to carry their
// own HARDCODED hex tier palettes (dashboard, grails view, pack simulator,
// trophy picker) while the other four (market, moment-detail, special-serial
// owners, sniper) already read the `--tier-*` design tokens. The split meant a
// brand-palette edit in app/rpc-tokens.css silently desynced half the app —
// exactly what RPC_DESIGN_SYSTEM.md's "no literal hex outside rpc-tokens.css"
// rule exists to prevent.
//
// ── Why this module exists at all (the alpha-suffix trap) ───────────────────
// Moving a hex palette onto tokens is NOT a pure find/replace: several call
// sites build a translucent variant by string-concatenating a 2-digit alpha
// onto the hex ("#EC4899" + "66"). `var(--tier-ultimate)66` is not valid CSS
// and the declaration is dropped silently — a hex→token swap alone would have
// blanked those backgrounds/borders with no error anywhere. `tierColorAlpha`
// is the token-safe replacement, using the same `color-mix(in srgb, …)` form
// already shipped in components/packs/PackHeroArt.tsx.

/** Neutral used for an unknown/absent tier. Matches lib/market-format. */
export const NEUTRAL_TIER_COLOR = "var(--rpc-text-muted)"

/**
 * Translucent variant of a tier colour, safe for CSS-variable inputs.
 *
 * Replaces the `${hex}66` concatenation pattern. Percentages are the decimal
 * equivalents of the old 2-digit hex alphas (0x66/255 ≈ 40%, 0x55 ≈ 33%,
 * 0x26 ≈ 15%, 0x1A ≈ 10%, 0x11 ≈ 7%).
 */
export function tierColorAlpha(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}
