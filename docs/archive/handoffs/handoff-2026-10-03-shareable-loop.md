# Handoff — close the acquisition loop on the existing /share surface

**Author:** Cowork (monthly-strategy-review pass, 2026-10-03 ~07:46 PDT)
**Status:** DESIGN + BUILD SPEC. Nothing shipped. Route/.tsx code → Claude Code on your box.
**Push path from authoring session:** none (verified). Commit direct to `main`.

> Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.

---

## 1. Context — the surface exists; the *loop* doesn't

The monthly review's "shareable insight surface" recommendation turned out to be **already built**: `app/share/[wallet]/page.tsx` renders a wallet "Collection Card" with a real OG image (`app/api/og/share/route.tsx`, which honestly withholds figures on a failed read — good), a sign-up CTA, and funnel tracking. So this is **not a new build** — it is closing the loop so the surface actually drives acquisition.

Why it matters: the funnel this month shows the activation loop *works* — `wallet_paste` 56 → `trophy_pinned` 44 — but `account_created` is 2 and signups are flat. People get value anonymously and leave. The product converts the few who arrive; the gap is **arrivals**, and the cheapest arrival source is an existing user's own shared card. Today that path is lossy and unmeasurable.

## 2. The two concrete gaps (verified by grep 2026-10-03)

**Gap A — `ShareButton` is clipboard-only, emits no event, and adds no attribution.**
`app/share/[wallet]/ShareButton.tsx` does exactly one thing: `navigator.clipboard.writeText(window.location.href)`. So:
- there is **no `share_click` funnel event** (we have inbound `share_view` = 86 but cannot tie visits to shares, so virality is invisible);
- the copied URL carries **no `?ref=` param**, so an inbound visit from a shared card is indistinguishable from any other;
- on mobile (where most Discord/Twitter sharing happens) it does not use the native share sheet.

**Gap B — the share prompt is not surfaced at the activation moment.**
A user who just pasted a wallet and pinned trophies on the dashboard/trophy case is never nudged to share their card. `/share/[wallet]` is reachable but not offered where activation happens.

## 3. Build spec

**A. Instrument + strengthen `ShareButton` (`app/share/[wallet]/ShareButton.tsx`):**
- On click, emit a funnel event `share_click` via the existing `lib/track-funnel.ts` (same path `ShareButton`/pages already use — confirm the helper signature; `lib/trophy/funnel-event.ts` exists too).
- Build the shared URL with an attribution param, e.g. `?ref=share` (and optionally `&w=<wallet-hash>`); the share page / middleware should record `funnel_events` `event_type='share_referral_visit'` when a visit carries `ref=share`, so share→visit is measurable end to end. Keep it anon-safe.
- Use `navigator.share({ url, title, text })` when available (mobile native sheet), falling back to the current clipboard copy. Guard with `typeof navigator.share === 'function'`.
- Keep the brand-exception white-on-red styling; do not hardcode new hexes (use `var(--rpc-red)` as it already does).

**B. Surface the share nudge at activation:**
- After a successful wallet paste + at least one trophy pin, show a lightweight "Share your collection card" affordance linking to `/share/[wallet]` (prefilled with the pasted wallet). Candidate homes: the dashboard trophy-case client and the collection `collection` tab client (both already import `/share/` per grep: `app/(collections)/[collection]/collection/CollectionTabClient.tsx`, `overview/CollectionOverviewClient.tsx`). Put it where `trophy_pinned` is emitted so the moment is right.
- Copy stays honest and beta-framed (the share page already says "free snapshot … free during beta").

**C. (Optional, measures the payoff):** a tiny admin tile or an addition to `rpc_ops_snapshot()` / the existing admin analytics showing `share_click` → `share_referral_visit` → `account_created` over 30d, so the loop's conversion is visible next review.

## 4. Files touched

- **Edit** `app/share/[wallet]/ShareButton.tsx` (event + attribution + native share).
- **Edit** the activation client(s) that emit `trophy_pinned` — add the share nudge (grep for `trophy_pinned` emitters: `app/api/profile/trophy/route.ts`, `lib/trophy/funnel-event.ts`, and the trophy-case client).
- **Edit** `lib/track-funnel.ts` only if a new `event_type` needs registering; confirm whether `funnel_events.event_type` is a free text column or enum-constrained before adding `share_click`/`share_referral_visit` (if constrained, a migration adds the values — standard header + revert).
- **Verify** no honesty regression on `app/api/og/share/route.tsx` (leave its withhold-on-failed-read behaviour intact).

## 5. Revert path

Revert the commit(s). No destructive DB ops. If `funnel_events.event_type` needed new enum values, the inverse is leaving them unused (harmless) — do not drop enum values.

## 6. Verification

`npx tsc --noEmit` clean · Vercel deploy READY · emit a `share_click` from the deployed share page and confirm the row lands in `funnel_events` · load `/share/<wallet>?ref=share` and confirm the referral visit is recorded · the OG card still renders (and still withholds on a failed read — mutation-check by pointing it at a wallet with no snapshot).

## Guardrails
- Direct to `main`, no branches/PRs; switch off any pre-checked `claude/*` branch first.
- PowerShell `git` on Windows; verify `git rev-list --count origin/main..HEAD` == 0.
- Vercel Pro `maxDuration` cap 800s; CRLF → full-file writes.
- No-push note is specific to the Cowork cloud session; your box pushes normally. Never re-embed a PAT in `remote.origin.pushurl`.

**End state:** share clicks and share-driven visits are tracked and attributed, mobile uses the native share sheet, and users are nudged to share at the moment they pin — turning the proven activation loop into a measurable acquisition channel, with no promo spend and no paywall. Ledger entry per shipped piece.

---

## Disposition — SHIPPED, narrowed after re-deriving (Claude Code, 2026-10-03 ~8:00 AM PT)

Two of the spec's premises were already built: **Gap B** (share nudge at activation) exists as the dashboard's `PublicProfileCard` (→ `ShareProfileButtons`) and the collection tab's post-search Share button; and **share→visit attribution** exists — `lib/track-funnel.ts` records an arrival's `utm_*` and `share_ref` on every funnel event of that session, so no `share_referral_visit` event or `funnel_events` CHECK migration is needed. The real gap was narrower: the two **anonymous `/share/<wallet>` card buttons** copied a bare URL (the card page copied `window.location.href`, re-sharing the copier's own utm), so a card-share visit was the one share arrival that could not be attributed — and both said "copied" even when the copy failed.

Shipped: `lib/share-link.ts` (`walletShareUrl` → `?utm_source=share&utm_medium=copy|native`, same vocabulary as the profile path; `shareWalletCard` → native share sheet on touch devices only, clipboard otherwise, honest outcome), used by `app/share/[wallet]/ShareButton.tsx` and the collection tab. Test: `__tests__/lib-share-link.test.tsx` (planted "always copied" defect reds 2).
**Not built:** a `share_click` event (needs a CHECK migration; inbound `utm_source=share` already measures what shares produce). Read: `funnel_events` rows whose `referrer` contains `utm_source=share&utm_medium=copy|native` on a `share_view` surface.
