# ⛔ `atlas-proxy` is DEPLOYED, and the lane it exists to open is MEASURED DEAD — Cloudflare egress is Atlas-WAF-blocked, 46 of 46

**Filed 2026-08-31 08:21 PT (15:21Z) by the Claude Code interactive session, on Trevor's box. SHIPPED (a Cloudflare Worker deploy) + MEASURED. The answer is NEGATIVE, and that closes a question that has been open since 2026-08-09.**

**Task:** *"Deploy `workers/atlas-proxy` — follow the inbox 2026-08-30T1610Z plan."* Done. The plan's own decision rule is what this filing executes: the README says a **403 / Cloudflare-challenge body ⇒ this lane is dead too.** It returned exactly that, and not once.

---

## 1. What shipped

| step | result |
|---|---|
| `wrangler deploy` (wrangler 4.84.0, this box's existing OAuth) | ✅ `https://atlas-proxy.tdillonbond.workers.dev`, version `9435469c-1ecc-49b5-87e4-cbc2c833d1de` |
| `wrangler secret put PROXY_SECRET` | ✅ set, piped from `TS_PROXY_SECRET` — never echoed |
| worker health `GET /` | ✅ `200 atlas-proxy ok` |
| unauthenticated `POST` | ✅ `401` (the auth gate works) |
| **authenticated `POST` → Atlas** | ⛔ **`403`, Cloudflare `<title>Just a moment...</title>` interstitial — 46 of 46** |

⚠ **The deploy changed no production behaviour.** `ATLAS_PROXY_URL` is set **nowhere** — not in `.env.local`, `.env.production`, `.env.example`, not in `.github/workflows/topshot-active-listings-ingest.yml`, not in any `.ps1`/`.mjs`. Verified by a full-tree grep, both variable names. `scripts/ingest-topshot-active-listings.mjs:69` gates on `ATLAS_PROXY_URL !== ""`, so the ingest is still byte-identically on the direct-curl path. **The worker is deployed and inert**, which is the same operational state as before, minus the open question.

## 2. The measurement, with its control

Every probe used the **byte-identical body the production runner builds** (`scripts/ingest-topshot-active-listings.mjs:106-115` — `product:"nba"`, `sortByOption:"SERIAL_NUMBER"`, `limit:"1"`, `offers:false`) against **six `atlas_edition_id`s that the board ingest itself saw listed at 2026-08-31 13:31Z**, so a non-empty answer was the expected result.

| lane | probes | HTTP 200 with `transactions` | HTTP 403 Cloudflare challenge |
|---|---:|---:|---:|
| **worker** (Cloudflare egress) | **46** | **0** | **46** |
| **direct curl, same box, same minute, same bodies** (positive control) | **6** | **6** | 0 |

The control is not incidental — it is what makes the null readable. Both lanes were fired **in the same loop iteration**, so upstream health, edition liveness, body shape and wall-clock are all held constant and **egress is the only variable**. The control returned real rows every time: ed 6125 `serial=1 cents=40000`, 1131 `serial=8 cents=99900`, 7917 `serial=6 cents=6666600`.

⭐ **The failure is LOUD, not silent.** It is the same `403` Cloudflare interstitial the 1610Z filing measured on `pg_net` — *not* the feared HTTP-200-with-empty-results soft-throttle. It could never have caused the ask-wipe that filing warns about, because it is trivially distinguishable from "no listing".

### The obvious cheaper explanation was tested first, and is FALSIFIED

The 1610Z filing's own mechanism — *"`pg_net` is libcurl, and **Atlas allows curl**"* — implies a testable alternative: maybe the block is the **Chrome User-Agent arriving from a datacentre IP**, not the IP itself. That is a header-shaped defect and would be a one-line fix, so it was worth 5 minutes before condemning the lane.

A temporary probe build was deployed that let the caller select the outbound header set, then reverted:

| outbound header set from the worker | probes | 200 | 403 |
|---|---:|---:|---:|
| `chrome` (the committed set: browser UA + `Origin`/`Referer`) | 5 | 0 | 5 |
| `curl` (`User-Agent: curl/8.7.1`, `Origin`/`Referer` kept) | 5 | 0 | 5 |
| `bare` (no UA, no `Origin`, no `Referer`) | 5 | 0 | 5 |
| `curlbare` (curl UA, no `Origin`/`Referer`) | 5 | 0 | 5 |

**All four 403.** ⛔ **So the block is EGRESS-shaped, not header-shaped.** No header set reaches Atlas from Cloudflare, including the exact one that succeeds from this box. The temporary build was reverted and the committed `index.js` redeployed; **`git status` on `workers/atlas-proxy/` is clean, so the deployed artifact is `main`'s source** (md5 `2fc30eec22f51c3a11395cfec98c8d35`).

⚠ **Firing N and counting is what makes this safe to conclude.** At the ~10% challenge rate the 1610Z filing measured on `pg_net`, a single probe would have had a ~90% chance of *passing* and this lane would have been wired live on a false green. 46 straight 403s against 6 straight control successes is not a bad window.

## 3. What this closes, and what it does NOT

- ✅ **known-issues #20 is ANSWERED and can stop being carried as a needs-Trevor item.** It is filed as *"needs an operator `wrangler deploy` + a Cloudflare-egress probe."* **Both were done. The probe says no.** It is not blocked on an absent operator any more — it is finished, negatively.
- ⛔ **The 1610Z filing's raised prior is REFUTED.** It reasoned: *"Atlas evidently does not blanket-block datacentre IPs, since Supabase's works … the README's one-line probe is now much more likely to succeed."* It explicitly hedged (*"Not proof — different provider, different WAF verdict"*), and **the hedge was the correct half**. Atlas's verdict is **per-provider**: Supabase's libcurl egress passes at ~90%, Cloudflare's passes at 0%. ⭐ **"Provider A's datacentre IPs are allowed" carries NO information about provider B's.**
- ✅ **Nothing is worse off, and nothing was at risk.** The residential arm is the feeder and is unaffected — it was **18/18** in the 1610Z correction and returned live rows in this very measurement.
- ⚠ **This does NOT resolve the thing that actually matters**, which the 1610Z correction already named: **the board's only working feeder is a scheduled task on Trevor's personal desktop that runs only while he is logged on.** #20 existed to give that a second, always-on lane. **That need is unchanged; only this candidate lane is eliminated.** The surviving candidate is `pg_net` from the database — measured working, and its cost objection (a saturated, IO-bound instance) is unchanged.

## 4. Should the worker be deleted?

**Left deployed, deliberately, and this is the argument rather than the verdict.** It costs nothing (zero invocations — nothing routes to it), it is behind a shared secret, and it is now a **standing one-curl re-test** if Atlas's WAF posture ever changes. Deleting it would only reclaim a name. ⚠ **But it is now a deployed artifact whose README must not read like an untested hypothesis**, or a future session repeats this afternoon — that README is updated in the same commit. **Trevor's call if he would rather it not exist:** `npx wrangler delete` in `workers/atlas-proxy`.

## 5. Reproduce / revert

```bash
# re-test the lane in one call (needs TS_PROXY_SECRET)
curl -s -X POST https://atlas-proxy.tdillonbond.workers.dev \
  -H "content-type: application/json" -H "X-Proxy-Secret: $TS_PROXY_SECRET" \
  --data-binary '{"product":"nba","completed":false,"editionId":"6125","sortByOption":"SERIAL_NUMBER","sortByDirection":"ASC","limit":"1","offset":"0","offers":false}'
# 403 + "Just a moment..." => still dead.  JSON with "transactions" => the WAF posture changed.
```

**Revert:** `npx wrangler delete` in `workers/atlas-proxy` (removes the deployed worker and its secret). No repo revert is needed — **no code changed**; this commit is documentation only.

## 6. Durable lessons

- ⭐ **An egress allow-list is per-provider, and one provider's success raises NO prior for another's.** Supabase 90% / Cloudflare 0% against the same WAF, the same day, the same request bytes.
- ⭐ **Before condemning a lane, test the cheapest alternative explanation the record itself supplies** — here the filing's own *"Atlas allows curl"* line generated a header-shaped hypothesis that was falsified in 20 probes. Cheap to run, and it is the difference between "this is dead" and "we never tried the obvious thing".
- ⚠ **A hedged claim's hedge is the part to re-test.** 1610Z said *"much more likely to succeed"* and *"not proof"* in consecutive sentences; the confident half was wrong and the cautious half was right.

## 7. ⚠ POST-FILING, AND IT IS THE MOST EXPENSIVE PART: THIS ANSWER WAS ALREADY ON RECORD, FROM 2026-06-17

After filing, a grep of the memory store turned up `atlas-undici-403-and-edition-map`, written **2026-06-16/17**, which already says:

> *"this is the INVERSE of Trevor's same-day AllDay finding (`5f1a28d`: nflallday WAF passes Vercel, **403s Cloudflare Workers**), so **a Worker proxy isn't a safe bet for Atlas either**"* … *"Vercel + GH runner + **(almost certainly) Cloudflare Workers** all 403/block"*

**The prediction was right, it was specific, it named the mechanism, and it cited a measured sibling case.** `atlas-proxy` was written anyway on 2026-08-09, filed as **#20**, carried in CLAUDE.md's *"Needs TREVOR"* bullet for **75 days**, and on 2026-08-30 the 1610Z filing *raised* the prior on it — reasoning from Supabase's success to Cloudflare's likely success, which is the exact inference this record already contradicted.

🚨 **So the durable rule is wider than the recorded one.** The store's existing lesson is *grep memory before publishing a MEASUREMENT* ([[grep-the-memory-store-before-publishing-a-measurement]]). This case says: **grep it before OPENING an item, before RAISING a prior on one, and before doing the operator work — the cheapest possible refutation is a store that already ran the experiment on a sibling upstream.**

⭐ **The 46/46 was still worth doing.** The June note said *"almost certainly"* and reasoned by analogy from a different WAF; #20 could not be closed on that. But it should have been carried as **"likely dead, one probe to confirm"** — a five-minute task — rather than as a blocking operator item behind an absent human for two and a half months. ⚠ **The cost of a hedged prediction filed as a maybe is that it reads as unknown.**
