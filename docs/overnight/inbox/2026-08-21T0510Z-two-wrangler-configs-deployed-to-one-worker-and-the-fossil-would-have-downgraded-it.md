# Two wrangler configs deployed to ONE Cloudflare worker, and the fossil would have silently downgraded the live one

**Filed:** 2026-08-21 ~05:10Z (PT: 2026-08-20 22:10) · **Class:** latent deploy hazard, found while working coverage area (8).
**Status:** hazard CLOSED by rename + a ban at zero. One decision left for Trevor: delete the fossil.

## What area (8) said, and what it actually was

The coverage filing listed this as a measurement gap:

> ⚠ `infrastructure/spork-proxy-worker/index.ts` (75 lines) is outside the workers gate's
> `workers/**` include entirely, and differs from `workers/spork-proxy/index.ts`.

True — but the coverage angle is the least interesting part. **Both directories' `wrangler.toml`
declared `name = "spork-proxy"`**, and `name` is the Cloudflare worker a `wrangler deploy` writes to.
Two divergent sources, one live worker, last deploy wins, and nothing in the repo recording which ran.
Of **19** wrangler configs in the tree, this was the **only** collision.

## Which one is live, established rather than assumed

| | `workers/spork-proxy` | `infrastructure/spork-proxy-worker` |
|---|---|---|
| size | **255 lines** | 75 lines |
| sporks | **mainnet17–27**, per-spork height routing, `?tx=` lookup | mainnet24–27, no routing |
| last touched | **2026-06-25** — *"extend historical floor to mainnet17 (2022-04-06)"* | 2026-04-27 |
| referenced by | `ingest-allday-pack-opens` + `ingest-topshot-pack-opens-history` (*"must match workers/spork-proxy SPORKS"*), `app/api/admin/backfill-topshot-buyers` | **its own README only** |
| test | `__tests__/worker-spork-proxy.test.ts` | none |

Live pipeline evidence, same day: `allday-pack-opens-backfill` has written **1,298 rows** and
`allday-pack-opens-forward` **234**, most recently 04:39Z — the historical path is working.

⚠ **So a `wrangler deploy` run from the `infrastructure/` directory would have replaced the live
worker with the 75-line version — dropping mainnet17–23 and the `?tx=` lookup, and breaking the
pack-opens backfills without changing one line of application code.** Nothing in CI or the repo
would have reported it; the pipelines would simply have stopped finding history. That is the same
"two copies, no instrument saying which is authoritative" shape this repo keeps paying for.

## Shipped

- **Renamed** the fossil's worker to `spork-proxy-legacy-DO-NOT-DEPLOY`, with the reasoning in the
  toml, and marked `index.ts` as superseded. Chosen over deletion because it is **reversible and
  non-destructive** — if the fossil ever turns out to be what is deployed, the source still exists.
- **`__tests__/wrangler-worker-names-are-unique.test.ts`** — a **ban at population zero**: no two
  `wrangler.toml` may claim one `name`. There is no legitimate reason for two, so an exception
  should be argued rather than defaulted to. Proven able to fail: restoring the old name reds two
  arms and prints both paths. The parser ignores a commented-out `name`, which matters because the
  fix put a comment block directly above the live one.

## ⚠ What I could NOT verify, and the one-command operator check

**Which source is actually deployed right now.** Egress to `*.workers.dev` is 403'd from this
sandbox, so I could not probe. **The two versions are trivially distinguishable by their health
response** — the fossil includes a `sporks` array, the live one does not:

```
curl -s https://spork-proxy.<account>.workers.dev/health
#  {"ok":true,"worker":"spork-proxy","sporks":[...4 names]}  -> the FOSSIL is deployed (bad)
#  {"ok":true,"worker":"spork-proxy"}                        -> the maintained one is deployed (expected)
```

All in-repo and pipeline evidence points to the maintained one, and the backfills writing rows is
strong corroboration — but it is corroboration, not the probe.

## The decision left open

**Delete `infrastructure/spork-proxy-worker/` entirely.** It is a fossil with no references, no
test, and a strictly worse implementation. I did not delete it because (a) the probe above is
outstanding and (b) deletion is not reversible in the way a rename is. ⚠ Note that CLAUDE.md's repo
map currently names this directory, so deleting it means editing that line too.
