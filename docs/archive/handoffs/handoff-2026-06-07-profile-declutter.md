# Handoff — public profile declutter (/profile/[username]) — 2026-06-07

PLAIN TEXT (iPhone copy-paste). No triple-backticks. Claude Code's direct file inspection wins on any disagreement. Direct to main, no branches/PRs. Push anything pending first (explicit-path staging).

================================================================
CONTEXT
================================================================
Trevor reviewed his live public profile (screenshots 2026-06-07) and wants the same declutter treatment /dashboard got: fewer sections, trophies front and center. All in app/profile/[username]/page.tsx (single file; section anchors below from a live grep). Follow the /dashboard precedent: UNMOUNT sections, keep the code/components in the repo — do not delete logic, do not re-add later without Trevor asking.

DO NOT TOUCH: the avatar border / banner cosmetic rendering (equipped_border/equipped_banner — just shipped in 7ede297/cc82283 and confirmed rendering correctly — the gold ring on his avatar), the achievements chips, Collection Breakdown, Top Movers, Cost Basis, the Tools row, or the "Build your own profile" CTA.

Current section order in the file: KPI row (Portfolio FMV / Moments / Badges, Badges at ~L439-445) -> Portfolio Value · 30D sparkline -> Cost Basis + Tier Breakdown (~L456) -> Collection Breakdown (~L464) -> Top Movers (~L471) -> Trophy Case (~L478, show-all toggle ~L515) -> Saved Wallets (~L542) -> Live Sniper Deals (~L580).

================================================================
ITEM 1 — Trophy Case: all 6, directly under the KPI row
================================================================
- Move the Trophy Case section to sit IMMEDIATELY after the KPI row (before Cost Basis).
- Render ALL pinned trophies (6/6) — remove the SHOW ALL TROPHIES / HIDE EXTRA TROPHIES toggle (~L515) and the showAllSlabs state; straight grid of all slabs.
- Grid rule (established repo convention): use gridTemplateColumns with minmax(0,1fr) — NEVER bare 1fr (mobile right-edge bleed; see the rpc-dashboard-profile-ui precedent). 3-up desktop, 2-up tablet, 1-up mobile is fine.

================================================================
ITEM 2 — Remove four sections (unmount, keep code)
================================================================
2a. Badges KPI card (~L439-445) — the KPI row becomes two cards: PORTFOLIO FMV + MOMENTS (keep the "N wallets" subline). Remove the totalBadges computation only if now unused.
2b. PORTFOLIO VALUE · 30D sparkline section (the "Sparkline builds as you load wallets" placeholder) — empty promise on a public page; unmount until there's real history to show.
2c. TIER BREAKDOWN — it shares the two-column section with Cost Basis (~L456): remove the tier half, keep Cost Basis (full-width or single column, match surrounding cards).
2d. LIVE SNIPER DEALS (~L580+) — gone entirely from the public profile.

================================================================
ITEM 3 — Saved Wallets: organize by collection, not tier
================================================================
Currently each row shows the wallet nickname + a TIER pill (LEGENDARY/ULTIMATE/RARE/STANDARD via cached_top_tier) — reads like grouping by tier, which is weird. Change to collection-first:
- Each row's pill/label = the COLLECTION name (resolve collection_id through lib/collections.ts registry — display name, e.g. "NBA Top Shot"; null/unknown -> "Multi").
- Sort/group rows by collection (then FMV desc within).
- Tier can survive as small muted secondary text or be dropped — Trevor's words: "having saved wallets by tier instead of collection is weird," so collection is the organizing label.

================================================================
RESULTING ORDER
================================================================
Hero (avatar+cosmetics, name, team chips, Team Captain, achievements) -> KPI row (FMV + Moments) -> TROPHY CASE (all 6) -> Cost Basis -> Collection Breakdown -> Top Movers -> Saved Wallets (by collection) -> Tools -> Build-your-own CTA.

================================================================
GUARDRAILS + VERIFICATION
================================================================
- tsc --noEmit clean; deploy READY; corruption-guard clean; explicit-path staging.
- This is a server component page — keep generateMetadata exports intact; don't introduce "use client" at page level.
- Verify live on /profile/jamesdillonbond: all 6 trophies visible without a click, directly under the two KPI cards; no Badges card, no sparkline, no tier breakdown, no sniper deals; saved wallets labeled NBA Top Shot / NFL All Day / etc.; avatar border still renders; mobile width (390px) shows no right-edge bleed on the trophy grid.
Revert: git revert the commit (single-file change).

================================================================
END STATE
================================================================
The public profile reads as: who this collector is, what their collection is worth, and their six grails — then the deeper breakdowns. No empty or internal-tool noise on the public surface.
