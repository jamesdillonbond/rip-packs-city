# Cleanup + decisions — packaged for Trevor (2026-06-01)

Decision-ready writeup of the deferred housekeeping the weekly health report keeps surfacing. Nothing here is auto-shipped; each needs a go/no-go or a small CC change. Verified against the live DB + repo this session.

## 1. Flowty teardown (Prioritized Action #1) — recommend: KEEP FROZEN, downgrade the priority

The teardown has been "Priority #1" for weeks, but the audit shows **nothing is safe to auto-drop**, and the framing needs correcting.

Live DB inventory (verified): `flowty_loan_events` (13.9K rows / 23 MB), `flowty_transactions` (7.7K / 11 MB), `flowty_loans` (5.3K / 5.4 MB), `flowty_scanner_state` (1), `flowty_excluded_addresses` (7), `marketplace_offers` (585K rows of Flowty offer history, `edition_id` NULL on every row), `offers` (0 rows). Total ~45 MB on a 5.9 GB DB.

The trap (your own correction, 2026-06-01): these are **not dead** — the `offers` table is read by the `analytics_listings_open_loan_offers` RPC, and the `flowty_*` tables back the **live** Flowty analytics dashboard + methodology + pulse + error-triage surfaces. So a real teardown means **retiring those admin surfaces first**, then dropping the tables. The code (`flowty-proxy` edge function + ~10 `lib/`/`app/` Flowty helpers) is the other half (see `docs/audits/flowty-teardown-plan-2026-05.md`).

Two clean paths:
- **A (recommend) — keep frozen, close the priority.** Leave the ~45 MB of Flowty history + its read-only admin surfaces in place; they're inert, cost ~nothing, and occasionally useful as historical reference. Downgrade "Flowty teardown" from Prioritized Action #1 to "decided: keep frozen" so it stops topping the list. Zero work.
- **B — full retire.** Only if you want the dead admin surfaces gone: (1) retire the Flowty analytics dashboard/methodology/pulse/error-triage routes + the `flowty-proxy` edge function + the ~10 helpers (CC); (2) THEN a teardown migration dropping `analytics_listings_open_loan_offers` + `offers`, then `flowty_*` + `marketplace_offers`, each after a `count(*)` confirm. Reclaims ~45 MB + removes dead code. Bigger; reversible only from backup once dropped.

**My recommendation: A.** The space is trivial and the surfaces are live; the win from B is small and the risk (dropping referenced objects) is real. Closing the priority is the higher-value move.

## 2. Dead scaffold — `lib/pro/gate.tsx` — recommend: delete (small CC)

Verified imported by nothing (`rg "pro/gate"` returns only its own header). Carries a misleading `// TODO: wire Stripe subscription check` in unused code. The real Pro gate is `components/ProGate.tsx`. Delete-candidate — a one-line CC `git rm lib/pro/gate.tsx` + confirm tsc clean. Removes a misleading monetization TODO from the tree (and you've tabled monetization until 50+ WAU anyway).

## 3. Phase-D chain-rename shims (18 files) — recommend: defer, it's safe debt

Each relocated Flow primitive left a 1-line re-export shim at its old path with `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim` (full list in PROJECT_HEALTH §5a). Bulletproof by design — zero caller breakage across 833 `@/lib/...` imports. Cleanup = repoint 833 imports in batches, then delete the 18 shims (MIND the `lib/flow.ts` default-export trap: its shim needs `export { default }` alongside `export *`). Unblocks Phase F (`ALTER COLUMN chain DROP DEFAULT`). This is a large mechanical CC refactor with low payoff — **defer until you're touching those files anyway.** Not worth a dedicated pass pre-traction.

## 4. CLAUDE.md drift to correct (operator/CC — Cowork left it alone)

The weekly report flagged stale values in CLAUDE.md (Cowork didn't edit it — the nightly pass had it mid-edit, uncommitted): (a) Known-issue #14 cites `sniper/page.tsx` at ~2,485 lines — it's **2,070** post the May-23 reframe; (b) #15 says "11 fixtures still git-tracked" — `git ls-files` confirms **none** are tracked; (c) the 18 Phase-D shims + Trade Hub aren't in the known-issues list (Trade Hub now is, via your Open #3). Fix opportunistically next time you're editing CLAUDE.md.

---

Net: the only items I'd actually action soon are **#1 (just decide "keep frozen" and close the priority — zero work)** and **#2 (delete one dead file)**. #3 and #4 are safe to leave. This clears the "housekeeping" column of the health report down to a single decision.
