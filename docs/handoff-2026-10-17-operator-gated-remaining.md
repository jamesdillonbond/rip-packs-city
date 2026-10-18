# Handoff — operator-gated items still open (2026-10-17 PT)

Written by the daytime monitor (Cowork cloud linked to the laptop) after clearing the FMV-recalc sweep wedge and confirming the two parked perf items + the superseded-index drop all landed. These are the only RPC items left that a session **cannot** ship autonomously — each needs an action only Trevor can take (a Vercel env var, or a click in the Supabase SQL editor on his own data). Nothing here is urgent; the platform is green.

---

## 1. `OPENSEA_API_KEY` — one Vercel env var (known-issues #58)

**Why it's yours:** only an account owner can create an OpenSea API key, and it's set in Vercel env, which a session can't write. Candy MLB has recorded **0 sales since 2026-10-12** because Magic Eden's Candy activity feed went silent — indistinguishable from volume moving to OpenSea (Candy's launch partner) while OpenSea is unindexed here. The public surfaces say so honestly ("No sales indexed"), so this is a coverage gap, not a breakage.

**Steps:**
1. opensea.io → sign in with a wallet → **Settings → Developer** (opensea.io/settings/developer) → verify email → request access (read-only Candy MLB listings/sales/offers on Solana).
2. After approval, create and name a key. ⛔ **Do NOT use the "instant" SDK/MCP key** — it expires after 7 days and the lanes would go silently dark again. Keys from the normal flow don't expire (max 3/account).
3. Vercel → project `rip-packs-city` → Settings → Environment Variables → add `OPENSEA_API_KEY` to **all three** environments, mark **Sensitive**, then **redeploy** (env applies to new builds only).
4. Repo re-enable (two lines, a session can do this part once the key exists): restore the three `candy-opensea-*` cron lines in `vercel.json` and delete `__tests__/candy-opensea-schedules-are-parked-until-a-key-exists.test.ts`.

**Done-check:** `pipeline_runs.extra` for the `candy-opensea-*` lanes shows `slug`, `protocols`, `matched_me_pda`, sales `windows_completed`/`caught_up` on the first tick; Candy Market Pulse starts recording sales again.
**Revert:** unset the env var + re-park the cron lines (re-add the pin test). No data risk — read-only lanes.

---

## 2. `drop_scratch.sql` — reclaim ~185 MB of your Flowty-export scratch (optional)

**Why it's yours:** the `flowty_archive.scratch_*` objects (16 tables + 15 functions, ~185 MB) are the one-off results of **your** 2026-10-02/03 Flowty export. A session won't drop your data on its own, and the DROPs hit the same SQL-editor destructive-dialog hold as any other DROP.

**If you want the space back:** run `scripts/flow-wallet-walk/drop_scratch.sql` in the Supabase SQL editor (project `bxcqstmqfzmuolpuynti`). It drops only the `scratch_*` functions and tables; the function bodies are preserved in `scripts/flow-wallet-walk/scratch_functions.sql`, so it's re-creatable.
**Keep (do NOT drop):** `flowty_archive.storefront_purchased_listings_2023` and `storefront_sales_2023_flowty_index` — those are migrations, not scratch.
**Revert:** none needed (scratch data, re-creatable from the preserved functions). Leaving it in place is also fine — it isn't anon-reachable and costs only the ~185 MB.

---

## Already done (no action needed) — recorded here so they're not re-carried
- **FMV-recalc sweep wedge** — fixed in `main` `9c1a184a9`, deployed, CI #7829 green, trust arm `fmv_sweep_wedge_hours` back to ok; the sweep resumed normal advancing runs.
- **Thin-FMV guard / FMV display guard / Atlas-drain open-listing count** — all three applied from the SQL editor (`20261017235000`, `20261018000700`, `20261018001100`).
- **Superseded `idx_tame_open_listing_by_seen` drop** — applied; verified gone, covering index `idx_tame_open_listing_seen_cover` valid and serving (1,168+ scans). ~183 MB reclaimed.
