# Handoff 2026-06-15 — UX: cleaned price-range beside a high-volume LOW/MEDIUM confidence badge

Context. The dense-LOW investigation (docs/handoff-2026-06-15-dense-low-fmv-findings.md) confirmed the FMV gate is HONEST — high-volume editions read LOW because their real sale spread is genuinely wide (e.g. a 125-sale Playoffs common ranges $0.42–$30). The labels are correct, but to a collector watching that moment trade constantly, a bare "LOW" reads as RPC being wrong. This optional UX touch turns the label into a trust signal by showing the cleaned price RANGE beside it. It is DISPLAY-ONLY — no FMV value or confidence-gate change. (Trevor greenlit it; it's the one remaining FMV polish item.)

HEAD at write time: origin/main = 6c54162. No pricing logic touched by this work.

---

Item 1 — moment page (render-first, data largely present)

File: app/moment/[id]/page.tsx (the public moment detail page; the serial-FMV line already renders here).

The page already shows CURRENT FMV + a confidence label + a "RECENT ACTIVITY" table of individual sales with prices. When the confidence is LOW or MEDIUM AND the edition is high-volume (sales_count_30d ≥ ~10), render a compact "trades $X–$Y" beside the confidence label, computed from recent sales.

CLEANING (critical — match the gate so the shown range agrees with the confidence): drop sub-$0.50 dust and trim outliers the SAME way the gate does (the dense-low findings established production drops <$0.50 dust + removes outliers; the cleaned p10–p90 band is the honest range). Show the cleaned band (p10–p90, or min–max after dust+outlier removal), NOT the raw min–max — a single $50 moonshot must not define the range.

Copy direction: e.g. "LOW · actively traded · ranges $1–$8 (125 sales/30d)" — frames LOW as "real, wide market," not "no data."

If the cleaned band isn't cheaply derivable client-side from the recent-activity rows already fetched, add a `price_band_30d` {low, high} to get_moment_detail (cleaned p10/p90 over 30d sales) — additive DB-side, my lane to add if you want it pre-built; flag me.

Item 2 — grid tiles / collection grid (phase 2, optional)

The tiles (get_wallet_moments_with_fmv) don't fetch recent sales, so the badge there needs a backing field: a cleaned `price_band_30d` (LATERAL p10/p90 over 30d sales, computed only for high-volume LOW/MEDIUM rows to bound cost). Defer until the moment-page version lands well; it's the lower-value surface for this.

---

Guardrails
- DISPLAY ONLY — never touches the FMV number or the confidence gate (the gate was confirmed correct; this just explains its output).
- Use the SAME dust ($0.50) + outlier cleaning as the gate so the shown range is consistent with the LOW/MEDIUM label — never show a raw range that contradicts the confidence logic.
- Only on high-volume (sales_count_30d ≥ ~10) LOW/MEDIUM editions — don't clutter thin editions, and HIGH editions already read confidently so they don't need it.
- Direct-to-main, no branches/PRs. PowerShell git on Windows; re-verify push with git rev-list --count origin/main..HEAD (expect 0). Full-file writes (CRLF). Vercel maxDuration cap 800s.
- Claude Code's direct file inspection wins over this doc — adapt to the actual moment-page shape.

Expected end state: high-volume LOW/MEDIUM moment pages show a cleaned price range beside the confidence label, turning a confusing "LOW" into an honest "actively traded, wide range" signal. Additive, reversible (git revert; any DB field is drop-able).
