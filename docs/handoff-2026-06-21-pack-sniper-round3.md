# Handoff — Pack Sniper round 3: mobile cards, 24h-low surfacing, pack-alerts spec (2026-06-21)

## Context

Rounds 1–2 shipped the live "as they get listed" feed + Sniper controls + the clamp fix, all verified green in Chrome (TS recency 140/140, AllDay 16/16, #418 gone — SSR renders "Updated —", cron `snapshot-pack-asks` 13/13 ok). This round is the remaining work I identified, after a deeper QA pass and after building the DB foundation for the 24h-low trend.

**Already shipped LIVE by Cowork (DB), ready for the code below:**
- `audit_20260621_get_pack_ask_state_map_rpc` — the clamp-proof recency map RPC (round 2, already consumed by the reader).
- `audit_20260621_pack_ask_hourly_low_trend` — **NEW.** Table `public.pack_ask_hourly_low` (internal, RLS on, no anon), SECDEF fn `roll_pack_ask_hourly_low()` (service_role only), and **`pack_ask_state.low_ask_24h` / `low_ask_7d`** columns. A pg_cron job `rpc-roll-pack-ask-hourly-low` (`7,22,37,52 * * * *`, every 15 min) samples `pack_ask_state.lowest_ask` into hourly buckets, prunes to 7 days, and refreshes the two rolling-low columns. **It does NOT touch the live `upsert_pack_ask_state` cron writer** — if it ever errors, the recency feed is unaffected. Verified live: all 2,882 listed dists have `low_ask_24h`/`low_ask_7d`, and **`get_pack_ask_state_map` already returns both keys per dist** (so Item B is a pure read-and-render). `check_public_security_invariants()` = 0, `check_secdef_anon_execute_violations()` = `[]`. Values currently equal `lowest_ask` (one bucket so far); they become meaningful as buckets accumulate over 24h/7d.

**This handoff = code only.** Priority: A (mobile UX, the column-hide turned out insufficient) → B (cheap, DB already done) → C (spec for a larger feature, your scope call).

> **Claude Code's direct file inspection wins over this doc.** Paths verified live 2026-06-21.

## Guardrails
Direct-to-`main`, no branches/PRs. PowerShell `git`; `git rev-list --count origin/main..HEAD` → 0. `npx tsc --noEmit` clean; deploy READY; smoke the 3 pack-sniper endpoints (200). Full-file writes, not CRLF patches.

---

## Item A — [UX, HIGH] Mobile/tablet: deal table still overflows; the "View Listing" CTA scrolls off-screen

**Measured live (Chrome).** Round 2's column-hide (`rpc-ps-col-optional` + `@media (max-width:900px)`) helped, but I measured the table at **910px wide even with both optional columns hidden** — the Pack `min-width` (280px / 200px under 760px) plus the 3-link Actions cell dominate. So on tablet (768px) and phone (390px) the table horizontal-scrolls and the primary **View Listing ↗** CTA is off-screen until the user scrolls. The conversion action shouldn't require scrolling — so the card layout I marked "optional" in round 2 is actually needed.

**Fix: render `processed` as stacked cards under ~760px instead of the table.** In `app/insights/pack-sniper/PackSniperClient.tsx`:

1. Add an SSR-safe narrow-viewport flag (default `false` so SSR + first client render = the table = no hydration mismatch; mobile swaps to cards after mount):

```ts
  const [isNarrow, setIsNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)")
    const on = () => setIsNarrow(mq.matches)
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
```

2. In the table section, branch: when `isNarrow`, render a cards container instead of `<table>` (reuse the same `processed`, badges, and action links). Sketch:

```tsx
        ) : isNarrow ? (
          <div className="rpc-ps-cards">
            {processed.map((d) => (
              <div key={`${collection}-${d.distId}`} className="rpc-ps-card">
                <Link href={d.detailHref} className="rpc-ps-card-head">
                  {d.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={d.imageUrl} alt={d.title} className="rpc-ps-pack-img" loading="lazy" />
                  ) : (
                    <div className="rpc-ps-pack-img rpc-ps-pack-img-empty" aria-hidden="true" />
                  )}
                  <span className="rpc-ps-pack-meta">
                    <span className="rpc-ps-pack-title">{d.title.trim() || "—"}</span>
                    <span className="rpc-ps-pack-sub">
                      <span>{d.slots} {d.slots === 1 ? "slot" : "slots"}</span>
                      <span className="rpc-ps-tier-chip" style={{ color: tierColor(d.tier) }}>{(d.tier ?? "—").toUpperCase()}</span>
                      {d.isNew ? <span className="rpc-ps-new-chip">NEW</span>
                        : d.isPriceDrop ? <span className="rpc-ps-drop-chip">▼ {d.askDropPct != null ? `${Math.round(d.askDropPct*100)}%` : "drop"}</span> : null}
                      {mounted && d.askChangedAt ? <span className="rpc-ps-listed-rel">{relTime(d.askChangedAt)}</span> : null}
                    </span>
                  </span>
                </Link>
                <div className="rpc-ps-card-stats">
                  <div><span>Live ask</span><b className="rpc-ps-td-emph">{fmtUsd(d.lowestAsk)}</b></div>
                  <div><span>EV / ask</span><b className="rpc-ps-td-emph">{fmtRatio(d.liveValueRatio)}</b></div>
                  <div><span>Gross EV</span><b>{fmtUsd(d.grossEV)}</b></div>
                  <div><span>FMV cov.</span><b>{d.fmvCoveragePct}%</b></div>
                </div>
                <div className="rpc-ps-card-actions">
                  <TrackedOutboundLink href={d.buyUrl} payload={{ surface:"pack-sniper", destination:"topshot", setName:d.title.trim()||null, tier:d.tier??null, askPrice:Number.isFinite(d.lowestAsk)?d.lowestAsk:null, fmv:Number.isFinite(d.grossEV)?d.grossEV:null, discount:Number.isFinite(d.discountPct)?d.discountPct:null, buyUrl:d.buyUrl }} className="rpc-ps-act rpc-ps-act-buy">View Listing ↗</TrackedOutboundLink>
                  <Link href={d.simulatorHref} className="rpc-ps-act">Simulate</Link>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <table className="rpc-ps-table"> … existing table unchanged … </table>
        )}
```

3. CSS (append to the `CSS` template):

```css
.rpc-ps-cards { display: flex; flex-direction: column; }
.rpc-ps-card { border-bottom: 1px solid var(--rpc-border-subtle); padding: 14px 12px; display: flex; flex-direction: column; gap: 12px; }
.rpc-ps-card-head { display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; }
.rpc-ps-card-stats { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 8px; }
.rpc-ps-card-stats > div { display: flex; flex-direction: column; gap: 2px; }
.rpc-ps-card-stats span { font-family: var(--font-mono); font-size: 9px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-ps-card-stats b { font-family: var(--font-mono); font-size: 14px; color: var(--rpc-text-primary); }
.rpc-ps-card-actions { display: flex; gap: 10px; align-items: center; }
.rpc-ps-card-actions .rpc-ps-act-buy { flex: 1; text-align: center; padding: 10px; }
```

This keeps the desktop table intact and gives mobile a thumb-friendly card with the CTA always visible. (The round-2 `rpc-ps-col-optional` + 900px rule can stay for the 760–900px tablet-landscape band, or be removed since cards now cover ≤760px — your call; harmless to leave.)

**Revert:** `git revert`.

---

## Item B — [FEATURE, MED] Surface the 24h low ("near its recent low" signal). DB is already shipped.

`get_pack_ask_state_map` now returns `low_ask_24h` + `low_ask_7d` per dist (live). The reader already spreads the map value into `askByDist`, so these are present at runtime — just type them, map them onto `PackDeal`, and render. All in two files.

**`lib/packs/pack-deals.ts`:**
1. Add to the `AskStateRow` type: `low_ask_24h: number | null` and `low_ask_7d: number | null`.
2. Add to the `PackDeal` type: `lowAsk24h: number | null`, `lowAsk7d: number | null`, `atLow24h: boolean`.
3. In the deal loop (where recency is computed), read + compute:
```ts
    const lowAsk24h = askState?.low_ask_24h != null ? Number(askState.low_ask_24h) : null
    const lowAsk7d = askState?.low_ask_7d != null ? Number(askState.low_ask_7d) : null
    // "at its 24h low" — current ask is at/below the rolling 24h min (small epsilon for float).
    const atLow24h = lowAsk24h != null && lst.lowestAsk <= lowAsk24h + 0.001
```
   and add `lowAsk24h, lowAsk7d, atLow24h` to the pushed deal object.

**`app/insights/pack-sniper/PackSniperClient.tsx`:**
1. Mirror the three fields on the client `Deal` type.
2. Render an "AT 24H LOW" chip in the pack sub-line (next to NEW/▼), gated so it only shows once there's real history — i.e., when `d.atLow24h && d.lowAsk7d != null && d.lowAsk7d < d.lowestAsk` (the `<` guard means at least one cheaper bucket existed, so the "low" is informative, not just the cold-start `low==ask`). Use a distinct muted style, e.g. `rpc-ps-low-chip` with `color: var(--rpc-info)`.
3. Optional: a small "24h low $X" subtitle on the Live-ask cell/cards when `d.lowAsk24h != null && d.lowAsk24h < d.lowestAsk`.

Honesty note for the methodology copy: the low is RPC-snapshot-derived (15-min sampling) over a rolling window that fills in over 24h/7d — same caveat as the recency flags.

**Revert:** `git revert` (DB stays; columns are inert without the UI).

---

## Item C — [FEATURE, LARGE — spec only, your scope call] Pack deal alerts

Let users subscribe to "alert me when a sealed pack lists below X% of EV (or at a 24h low)." This is a **real feature spanning DB + dispatch + UI + formatter**, not a quick edit — flagging the integration design so you can scope it as its own task.

**How the existing alerts system works (verified in `lib/alerts.ts` + `app/api/alerts/*`):**
- `alert_subscriptions` (owner_key = session user id; filter prefs in the row).
- `build_deal_alerts_for_subscription(p_subscription_id)` — matcher + preview count.
- `dispatch_due_deal_alerts(p_max)` — scans due subs, enqueues deliveries. It already fans in **two** deal sources, both `alert_kind='deal'`: edition-level (`cross_collection_deals_board`) and per-serial (`topshot_underpriced_serials_board`). The shared `DealPayload` carries source-specific optional fields; `lib/alerts/format.ts` resolves the headline with per-source fallbacks (no discriminator branch).
- `claim_pending_deliveries` / `mark_delivery_sent|failed` — per-channel senders (Telegram/Discord/email) drain the outbox.

**Recommended integration (pack deals = a third source):**
1. **DB matcher** — a `build_pack_deal_alerts_for_subscription(p_subscription_id)` (or extend the existing) that evaluates the pack deal feed **server-side in SQL** — `pack_table_rows` (gated EV) joined to `pack_ask_state` (live ask + recency + `low_ask_24h`), mirroring `lib/packs/pack-deals.ts`'s gates (EV>ask, coverage≥80, fresh, depletion<90, high-variance flag) — against the sub's filters (collection, tier, min EV/ask, max price, and a new "pack" subscription flag).
2. **Dispatch** — enqueue pack matches in `dispatch_due_deal_alerts` (or a sibling `dispatch_due_pack_deal_alerts`) with `alert_kind='deal'` and a pack payload (pack title, dist_id, slots, lowest ask, gross EV, EV/ask, the `topshotPackUrl` buy link). Add the pack-specific optional fields to `DealPayload` + a `format.ts` branch for the pack headline.
3. **UI** — `/alerts` gains a "Sealed packs" subscription type (collection + tier + min EV/ask + max price; reuse the existing channel-link flow). The security invariant holds: `owner_key` is always the session user id, never a body field.
4. **Cadence** — the existing `alerts-dispatch` cron already runs the deal dispatch; if pack matching is folded into `dispatch_due_deal_alerts` it rides along; mind the function's statement-timeout budget (it grew once already — see the deal-board timeout history).

**Why it's its own task:** it touches the pricing-adjacent alert dispatch (off-limits to autonomous passes), the subscription schema, the formatter, and the UI, and it needs a product call on what pack-alert filters to expose. Best built deliberately, not bundled with the polish above.

---

## QA / verification after A+B ship
- `npx tsc --noEmit` clean; deploy READY.
- Smoke: `/insights/pack-sniper` 200, `/api/og/insights/pack-sniper` 200, `/api/public/insights/pack-sniper` 200 JSON (deals still carry `isNew`/`askChangedAt`; now also `lowAsk24h`/`atLow24h`).
- Resize to 390px: cards render, View Listing visible without horizontal scroll, no `#418` in console.
- The "AT 24H LOW" chip stays hidden until buckets accumulate (cold-start `low == ask`), then appears on genuine lows.

## Expected end state
One commit on `main`, deploy READY, tsc clean. Mobile shows thumb-friendly deal cards with the CTA always visible; deals show an "at 24h low" signal once history fills (DB already feeding it). Pack deal alerts remain a logged, scoped spec for a future build.

### Revert
`git revert <commit>` reverts A+B. DB objects (`pack_ask_hourly_low`, `roll_pack_ask_hourly_low`, the two columns, the pg_cron job, the `get_pack_ask_state_map` extra keys) can stay inert, or to remove: `SELECT cron.unschedule('rpc-roll-pack-ask-hourly-low'); DROP FUNCTION public.roll_pack_ask_hourly_low(); DROP TABLE public.pack_ask_hourly_low; ALTER TABLE public.pack_ask_state DROP COLUMN low_ask_24h, DROP COLUMN low_ask_7d;` (and re-CREATE `get_pack_ask_state_map` without the two keys).
