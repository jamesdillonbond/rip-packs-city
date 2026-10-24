// A collection (or verdict / tier) ACCENT painted as TEXT.
//
// ⛔ WHY (2026-10-18, known-issues #194): accents are brand fills. Used raw as a
// text colour, Top Shot's #E03A2F read 4.15–4.40:1 on the dark canvases, two
// others failed on accent-tinted chips (#A855F7 4.12, #EF4444 4.33), and in
// light mode EVERY accent failed on white (2.15–4.36:1) because the registry
// has one value per collection and no light-mode shade.
//
// Borders, fills and tints keep the raw accent. Text goes through here:
//   · the brand red (#E03A2F or var(--rpc-red) — lib/marketplace-status-banner
//     passes the token) → var(--rpc-red-text), the existing text-safe red
//     (#FF4D40 dark / #B52A21 light) — red TEXT already had a token;
//   · a tier or semantic fill token (var(--tier-rare), var(--rpc-success) …) →
//     its TEXT twin (var(--tier-rare-text) …): same colour in dark, a text-safe
//     shade in light, fills unchanged (#194, decided 2026-10-18);
//   · any other CSS variable → unchanged (it is already a themed token);
//   · any other colour → color-mix toward the theme's --rpc-accent-text-mix by
//     --rpc-accent-text-amt (app/rpc-tokens.css: 12 % white dark, 55 % black
//     light — the smallest amounts that clear 4.5:1 for every registry accent
//     on every canvas axe named).
//
// ⚠ NOT for OG image routes or email HTML: Satori and mail clients resolve
// neither var() nor color-mix(). Those paint fixed dark cards and keep the raw
// accent.
const BRAND_RED = /^#?e03a2f$/i
// Fill tokens that have a TEXT twin in app/rpc-tokens.css (#194, 2026-10-18):
// the twin equals the fill in dark and is a text-safe shade in light.
const HAS_TEXT_TWIN = /^var\(--((?:tier-(?:legendary|ultimate|rare|fandom|uncommon|common|champion|challenger|contender|epic))|(?:rpc-(?:success|warning|danger|info)))\)$/

export function accentText(accent: string): string
export function accentText(accent: string | null | undefined): string | undefined
export function accentText(accent: string | null | undefined): string | undefined {
  if (!accent) return accent ?? undefined
  const a = accent.trim()
  if (BRAND_RED.test(a) || a === "var(--rpc-red)") return "var(--rpc-red-text)"
  const twin = a.match(HAS_TEXT_TWIN)
  if (twin) return `var(--${twin[1]}-text)`
  if (a.startsWith("var(")) return a
  return `color-mix(in srgb, ${a}, var(--rpc-accent-text-mix) var(--rpc-accent-text-amt))`
}

/**
 * A chip STYLE whose text sits on its own TRANSLUCENT tint (e.g. `{ background:
 * "rgba(16,185,129,0.2)", color: "rgb(110,231,183)" }`). In light theme that tint
 * is light, so the pastel text must take the theme shade — but the background and
 * border stay exactly as built (fills identical in both themes). An OPAQUE or
 * dark fill is left alone: its text was designed against that fill.
 * Apply at the CONSUMER (`style={textSafeChip(coverageChipClass(x))}`), never inside
 * the builder — a builder's `color` may also feed a border or gradient (10-18).
 */
export function textSafeChip<T extends { color?: unknown; background?: unknown }>(style: T): T {
  if (!style || typeof style.color !== "string" || !style.color) return style
  const bg = style.background == null ? "" : String(style.background)
  const translucent = bg === "" || bg === "transparent" || /rgba\([^)]*,\s*0?\.[0-3]\d*\s*\)/.test(bg)
  return translucent ? { ...style, color: accentText(style.color as string) } : style
}

/**
 * The label colour for text ON a collection-accent FILL (a button). White reads
 * 2.2–4.0:1 on every non-red registry accent; near-black #0B0B0D reads 5.0–9.2:1
 * (measured 2026-10-18). The brand red keeps white, painted on accentFill()'s
 * deeper --rpc-red-fill (2026-10-24: white on #E03A2F itself is 4.36:1). The overview's accent buttons already used #0B0B0D; this makes it
 * the rule. Theme-independent on purpose: the fill is identical in both themes.
 */
/**
 * The FILL to paint under a labelOn() label. The brand red under white reads
 * 4.36:1 (under AA's 4.5); --rpc-red-fill is the same red one step deeper
 * (4.68:1). Every other accent passes through unchanged — labelOn() gives it
 * near-black. Pair the two: `background: accentFill(a), color: labelOn(a)`.
 */
export function accentFill(fill: string): string {
  const f = fill.trim()
  return BRAND_RED.test(f) || /^var\(--rpc-red(\s*,[^)]*)?\)$/.test(f) ? "var(--rpc-red-fill)" : fill
}

export function labelOn(fill: string | null | undefined): string {
  if (!fill) return "#fff"
  const f = fill.trim()
  return BRAND_RED.test(f) || /^var\(--rpc-red(\s*,[^)]*)?\)$/.test(f) ? "#fff" : "#0B0B0D"
}

function hexLum(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

/** WCAG contrast ratio of two #rrggbb colours; null when either is not a hex colour. */
export function contrastRatio(a: string, b: string): number | null {
  const la = hexLum(a), lb = hexLum(b)
  if (la === null || lb === null) return null
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Text colour for a label on a DATA-DEFINED fill (a team's primary colour):
 * the preferred colour (a team's secondary) when it reads at >= 4.5:1, else
 * near-black or white, whichever reads better (2026-10-24 — 76 team chips on
 * /teams read 2.6:1, e.g. Hawks volt #C1D32F on red #E03A3E).
 */
export function readableOn(fill: string | null | undefined, preferred?: string | null): string {
  if (!fill) return preferred || "#fff"
  if (preferred && (contrastRatio(fill, preferred) ?? 0) >= 4.5) return preferred
  const dark = contrastRatio(fill, "#0B0B0D"), light = contrastRatio(fill, "#FFFFFF")
  if (dark === null || light === null) return preferred || "#fff"
  return dark >= light ? "#0B0B0D" : "#FFFFFF"
}

/**
 * A DATA-DEFINED fill (a team's primary colour) that some label can read on.
 * Mid-tone reds/oranges sit near 4.4:1 against BOTH white and near-black
 * (Rayo Vallecano #E53027: 4.47 / 4.21), so no text colour clears AA. Such a
 * fill is darkened toward black in 4 % steps until white reads >= 4.5:1 — the
 * smallest change that keeps the club's colour recognisable. Any fill that
 * already has a readable label, and any non-hex value, passes through.
 */
export function readableFill(fill: string | null | undefined): string | null | undefined {
  if (!fill) return fill
  const m = /^#?([0-9a-f]{6})$/i.exec(fill.trim())
  if (!m) return fill
  const best = Math.max(contrastRatio(fill, "#0B0B0D") ?? 0, contrastRatio(fill, "#FFFFFF") ?? 0)
  if (best >= 4.5) return fill
  const n = parseInt(m[1], 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  for (let k = 0.96; k > 0.4; k -= 0.04) {
    const hex = "#" + rgb.map((v) => Math.round(v * k).toString(16).padStart(2, "0")).join("").toUpperCase()
    if ((contrastRatio(hex, "#FFFFFF") ?? 0) >= 4.5) return hex
  }
  return fill
}
