# Handoff — special-serial category glyphs (#1 / Jersey / Perfect)

Date: 2026-06-30 · Author: Cowork · Ship lane: Claude Code (touches `.tsx`, which Cowork can't push)

Context: on Dapper Market, special serials in the "Special Serials" section carry a small glyph telling you *why* the serial is special (first mint, jersey match, perfect serial). RPC already computes all three (`special_serial_badge` enum `first_serial | jersey_match | perfect_mint`; `get_edition_special_serials`; the `topshot_special_serial_owners` board) but renders them as ALL-CAPS **text pills** only. This adds an original RPC-brand glyph next to each — a pure visual upgrade, no data change.

Glyph set chosen (Trevor delegated the look): **medal (#1) · jersey/kit (Jersey) · bullseye (Perfect)** — original geometry, drawn in `currentColor` so each inherits the pill's existing color (red accent / muted). NOT Dapper's proprietary art.

---

## 1. New file — `components/SpecialSerialGlyph.tsx`

```tsx
import type { CSSProperties } from "react"

// SpecialSerialGlyph — small monochrome icon marking WHY a serial is special:
// first mint (#1), jersey match, or perfect serial (serial == last mint / #N/N).
// Drawn in currentColor so it inherits the surrounding pill color (RPC red accent
// or muted). Original RPC-brand glyphs (medal / jersey / bullseye) — NOT Dapper's
// proprietary art. Accepts either tag vocabulary used across the app:
//   tag form:        "#1" | "jersey" | "last_mint" | "perfect"
//   badge_type enum: "first_serial" | "jersey_match" | "perfect_mint" | "last_serial"
// Returns null for anything unrecognized. (2026-06-30)

type Category = "first" | "jersey" | "perfect"

function categorize(tag: string | null | undefined): Category | null {
  const t = (tag ?? "").toLowerCase().trim()
  if (t === "#1" || t === "first" || t === "first_serial") return "first"
  if (t === "jersey" || t === "jersey_match") return "jersey"
  if (t === "perfect" || t === "last_mint" || t === "perfect_mint" || t === "last_serial") return "perfect"
  return null
}

export default function SpecialSerialGlyph({
  tag,
  size = 13,
  className = "",
}: {
  tag: string | null | undefined
  size?: number
  className?: string
}) {
  const cat = categorize(tag)
  if (!cat) return null

  const style: CSSProperties = { flex: "0 0 auto", display: "inline-block", verticalAlign: "middle" }

  if (cat === "first") {
    // First-place medal: disc + ribbon tails (no numeral, so it reads at any size).
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style} aria-hidden="true"
           fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round">
        <circle cx="12" cy="9" r="6" />
        <path d="M9 14 L8 22 L12 19 L16 22 L15 14" />
        <circle cx="12" cy="9" r="2.1" fill="currentColor" stroke="none" />
      </svg>
    )
  }

  if (cat === "jersey") {
    // Jersey / kit silhouette.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style} aria-hidden="true"
           fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" strokeLinecap="round">
        <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" />
      </svg>
    )
  }

  // perfect — bullseye / target (serial lands on the exact last mint).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style} aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth={1.7}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
```

---

## 2. Wire it into the 3 special-serial surfaces (4 edits)

Add the import to each file:
```tsx
import SpecialSerialGlyph from "@/components/SpecialSerialGlyph"
```

### 2a. `app/special-serial-owners/page.tsx` — the Special Serial Owners board (~line 270)
Replace:
```tsx
<span className="rpc-sso-tag">{tagLabel(r.tag)}</span>
```
with:
```tsx
<span className="rpc-sso-tag" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><SpecialSerialGlyph tag={r.tag} size={12} />{tagLabel(r.tag)}</span>
```

### 2b. `app/(collections)/[collection]/edition/[slug]/page.tsx` — edition "Notable Serials" (~line 1104-1111)
In the label `<span>` style block, after `justifySelf: "start",` add:
```tsx
                        display: "inline-flex", alignItems: "center", gap: 4,
```
Then, immediately before `{notableTagLabel(r.tag)}`, insert:
```tsx
                      <SpecialSerialGlyph tag={r.tag} size={11} />
```

### 2c. `app/moment/[id]/page.tsx` — special-serial pills row (~line 1124)
In the styled `<span>`, add `display: "inline-flex", alignItems: "center", gap: 4,` to its style object, then replace:
```tsx
                  {specialSerialLabel(s.badge_type)}
```
with:
```tsx
                  <SpecialSerialGlyph tag={s.badge_type} size={11} />{specialSerialLabel(s.badge_type)}
```

### 2d. `app/moment/[id]/page.tsx` — notable-serials table (~line 1381)
Replace:
```tsx
                        <span style={{ color: accent ? "var(--rpc-red)" : "var(--rpc-text-primary)" }}>
                          {notableTagLabel(n.tag)}
                        </span>
```
with:
```tsx
                        <span style={{ color: accent ? "var(--rpc-red)" : "var(--rpc-text-primary)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <SpecialSerialGlyph tag={n.tag} size={11} />
                          {notableTagLabel(n.tag)}
                        </span>
```

The component aliases every tag vocabulary in the app (`#1`/`jersey`/`last_mint`/`perfect` and `first_serial`/`jersey_match`/`perfect_mint`/`last_serial`), so all four call sites resolve correctly.

---

## 3. Verify
- `npx tsc --noEmit` clean.
- After deploy: `/special-serial-owners` shows a glyph before each `#1 MINT / PERFECT / JERSEY` tag; a Top Shot edition page's Notable Serials rows and a moment page's special-serial pills each show the matching glyph. Glyphs inherit the red/muted color already on the pill.

## 4. Revert
`git revert` the commit — or delete `components/SpecialSerialGlyph.tsx` and undo the 4 call-site edits. Pure presentational; no data/DB impact.

---

## Context — already shipped live by Cowork (no action needed): Top Shot badge artwork
Separately, Cowork fixed the missing **Top Shot edition badge art** (Top Shot Debut / Championship / Rookie Year / Mint, etc.), which were rendering as text pills while NFL All Day showed real art. Root cause: `badge_art_overrides` had 8 rows for All Day and **zero for Top Shot** (base `badge_taxonomy.icon_url` all null), so `get_badge_display_metadata` returned no `icon_url` for Top Shot → pill fallback. The `/api/badge-image` proxy + the edition/moment pages already handle art correctly.

Shipped (DB, live): migration `audit_20260630_topshot_badge_art_overrides` — 7 override rows for the Top Shot collection mapping each badge `normalized_key` → `/api/badge-image?src=topshot&name=<camelSlug>`. Verified live: the Zion "Denied!" edition page went from 3 text pills to 3 badge artworks.
- Revert: `DELETE FROM public.badge_art_overrides WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd';`
- Note: proxy commit `0944535` (already on `main`) serves those badges as a light Cloudflare 96px webp; until it deploys, prod serves the heavier animated GIF. Deploying this glyph change will also ship `0944535`.

### Optional follow-up (not required) — badge art in grids
`components/BadgeRow.tsx` (the grid/sniper/wallet renderer) calls `useBadgeTaxonomy(titles)` **without** a `collectionId`, so it never resolves collection-scoped art — grids show badge *text pills* for both leagues even though detail pages show art. To also light up grids: add an optional `collectionId` prop to `BadgeRow`, pass it to `useBadgeTaxonomy(titles, collectionId)`, and thread the collection id from the collection-scoped call sites (collection page, sniper rows, wallet rows). Independent of the glyph work above.
