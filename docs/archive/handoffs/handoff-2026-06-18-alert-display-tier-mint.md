# Handoff 2026-06-18 — Enrich the alert line with tier + mint (the "parallel type" ask, part 1: display now)

Plain text. Claude Code's direct file inspection wins over this doc. Small, high-value formatter-only change. Ship now.

## Why

A live end-to-end test fired 2026-06-17 (Wembanyama deals, all 3 channels delivered + confirmed). The alert line currently reads e.g. "Victor Wembanyama / Metallic Gold LE · NBA Top Shot / $98 ask · 82% below FMV $538.33" — it names the SET but omits the rarity TIER and the MINT/circulation, which a Top Shot collector needs to value a deal. Trevor: "include the parallel type." Finding (measured): Top Shot's FORMAL parallel field (`badge_editions.parallel_id`/`parallel_name`, `ts_listings.parallel_id`) is 0/"Standard"/empty for 99.97% of editions — only 3 carry a real named parallel (Galactic ×2, Diced ×1). So the SET NAME is the meaningful "parallel/variant" today, and the real display gap is tier + mint. (The rare formal parallels are part 2 — see the separate queued handoff.)

## The change (one function, no DB work — the payload already carries both fields)

`lib/alerts/format.ts`, the `dealSubline(d)` helper (~L56). It currently builds:
  [dealSerialTag(d), d.set_name, d.collection_name]
Add tier + mint so the line states the full edition identity:
  [dealSerialTag(d), <tier>, d.set_name, <mint>, d.collection_name].filter(Boolean).join(" · ")
where `<tier>` = a title-cased `d.tier` (the payload sends the enum upper-case, e.g. "RARE" → render "Rare"; your call on casing) and `<mint>` = `d.circulation_count ? "/" + d.circulation_count : ""`.

Result: edition deal → "Rare · Metallic Gold LE · /222 · NBA Top Shot"; serial deal → "#1 · Rare · Metallic Gold LE · /222" (serial tag present, collection omitted by the existing logic). This flows to all three renderers (Telegram, Discord embed description, email row) since they all call `dealSubline`.

## Already verified for you

Both deal-payload shapes already carry these — no dispatcher/board change needed:
- Edition-level (Pass 1 of `dispatch_due_deal_alerts`): emits 'tier' + 'circulation_count'.
- Per-serial (Pass 2): emits 'tier' + 'circulation_count'.
The only code risk is the TS type: add `tier?: string | null` and `circulation_count?: number | null` to the `Deal` type (`DealPayload["deal"]` in `lib/alerts.ts`) if they aren't already declared, so `d.tier` / `d.circulation_count` typecheck.

## Verify

Create a deal sub at /alerts that matches a current deal (or seed one), let `alerts-dispatch` + `alerts-send` run, and confirm the alert line now shows tier + /mint on all three channels. (cross_collection_deals_board has live deals right now — e.g. Wembanyama Metallic Gold LE, RARE, /222.)

## Revert

Restore the prior `dealSubline` body (drop the tier + mint parts).
