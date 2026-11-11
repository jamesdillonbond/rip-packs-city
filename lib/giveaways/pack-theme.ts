// lib/giveaways/pack-theme.ts
//
// The pack design a sponsor picks per drop (Trevor, 2026-11-10: "do both" — sound
// and per-drop pack art). A theme only recolours the sealed pack, the card backs,
// the pack wall and the stage's floor glow (the `data-pack-theme` rules in
// app/rpc-tokens.css). It changes nothing about what is in a pack.
//
// The list here is THE list: the database CHECK on giveaway_drops.pack_theme
// (migration audit_20261110_giveaway_drop_pack_theme) and the CSS rules are both
// pinned to it by __tests__/giveaway-pack-theme.test.ts.

export const PACK_THEMES = ["classic", "blackout", "gold", "ice", "emerald", "ember", "royal"] as const

export type PackTheme = (typeof PACK_THEMES)[number]

export const DEFAULT_PACK_THEME: PackTheme = "classic"

/** What the admin picker shows for each theme. */
export const PACK_THEME_LABELS: Record<PackTheme, string> = {
  classic: "Classic red",
  blackout: "Blackout",
  gold: "Gold",
  ice: "Ice blue",
  emerald: "Emerald",
  ember: "Ember orange",
  royal: "Royal purple",
}

export function isPackTheme(v: unknown): v is PackTheme {
  return typeof v === "string" && (PACK_THEMES as readonly string[]).includes(v)
}

/** A stored or received value as a theme; anything unknown renders as the classic pack. */
export function packTheme(v: unknown): PackTheme {
  return isPackTheme(v) ? v : DEFAULT_PACK_THEME
}
