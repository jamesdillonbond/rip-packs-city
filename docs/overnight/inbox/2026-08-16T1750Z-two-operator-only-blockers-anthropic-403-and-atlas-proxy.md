# Two operator-only blockers, both currently degrading a live user-facing path

Filed 2026-08-16 ~10:50 PT / 17:50Z, Claude Code interactive session.
Neither is a code defect. Both need a credential/console action I deliberately
did not attempt, and both are currently costing real product function.

---

## 1. Anthropic `403 credit_balance` on the Vercel key — the concierge is degraded

**Symptom.** `/api/support-chat` falls back; `support_conversations` shows
`concierge_unavailable` dominating (150 vs 3 `general` in one 24 h window when
measured, ~780 degraded conversations since 2026-08-02).

**What is established.** Anthropic returns a credit-balance 403 **to this key**.

**What is NOT established, and I was wrong about once.** I initially reported
this as "your credit balance is exhausted". Trevor corrected it: the account
holds **$18.71**, topped up after a previous exhaustion. So the account balance
and this key's spend authority are not the same thing.

**Leading hypothesis: a WORKSPACE-level spend limit.** An Anthropic workspace
can carry its own cap; a key scoped to that workspace 403s on
`credit_balance` while the org balance is healthy. Alternatives, in order:
1. Workspace spend limit reached (check Console → Settings → Workspaces → the
   workspace this key belongs to → spend limit).
2. The Vercel key belongs to a **different org** than the one topped up.
3. Something is draining the balance between top-ups (check Usage by key).

⚠ **Do NOT read the key from Vercel to "check" it** — that echoes a live secret
into a transcript, the failure mode CLAUDE.md records for
`get_edge_function` and the cron-job.org Advanced tab. Compare in the Console
by key NAME, or rotate.

**Detection is now in place** so this cannot repeat silently: the smoke suite
gained a hard check measuring the SHARE of real conversations that got a
fallback (6 h window, 5-conversation floor, keyed on category not copy). The
previous probes were soft AND opt-in — both because a live-LLM probe spends
credits — which is why the concierge was down ~2 weeks with the smoke test
reporting ALL PASSED. **A check that costs money per run will be made optional,
and an optional check is not a monitor.**

---

## 2. `workers/atlas-proxy` is still INERT, and it is starving two live surfaces

**Status.** Shipped 2026-08-09, never `wrangler deploy`'d. Cloudflare-egress to
`api.production.atlas.dapperlabs.com` is UNVERIFIED (a different WAF from the
GQL host), so the probe in `workers/atlas-proxy/README.md` must run BEFORE the
runner is repointed.

**Measured cost, 2026-08-16** (`pipeline_runs_daily`, `topshot-active-listings-ingest`):

| day | runs | ok | rows written |
|---|---|---|---|
| 08-16 | 3 | 1 | 259 |
| 08-15 | 7 | 3 | 766 |
| 08-14 | 5 | 1 | 272 |
| 08-13 | 6 | 1 | 273 |
| **08-12** | **5** | **0** | **0** |
| 08-11 | 10 | 6 | 1,518 |

`last_error` is `egress_blocked` on every failing day — the GHA runner IP is
WAF-blocked, exactly what atlas-proxy exists to bypass.

**Why it matters beyond the pipeline being red.** `topshot_active_listings`
feeds `topshot_underpriced_serials_board`, which is BOTH:
- the concierge's `search_serial_deals`, and
- the **serial pass of the live alert dispatcher** (`dispatch_due_deal_alerts`).

So a blocked ingest silently starves the one active special-serial alert
subscription and makes the bot's "nothing is listed" answer a claim about a
snapshot that can be a day old. Successful-sweep gaps measured over the
~73 h `pipeline_runs` window: **min 3 h / median 6 h / p90 22 h / max 26.7 h**
across only **5 successful sweeps**.

**Mitigated, not fixed (`754c8886`).** `search_serial_deals` now reports
`feed_age_hours` / `feed_stale` / `feed_note` on all four exits and the prompt
requires the age to be stated. That makes the staleness VISIBLE. It does not
feed the pipeline.

⚠ **Do not "fix" this by lowering the staleness threshold to make it alarm.**
`feed_stale` sits at 36 h deliberately — clear of the 26.7 h worst observed
NORMAL gap — because a 24 h ceiling fires during healthy operation, which is the
cry-wolf outcome `ufc_fmv_stale_hours` already cost this repo.

---

## Not an operator item, recorded so it is not re-investigated

**Discord plain DMs cannot reach the concierge, and no code change to this repo
can alter that.** The Discord integration is an Interactions webhook; ordinary
DMs are Gateway `MESSAGE_CREATE` events behind the privileged `MESSAGE_CONTENT`
intent, delivered over a persistent websocket serverless cannot hold. A plain
DM produces **no request to this app at all**. `/ask` is the only path.
Registration was verified complete 2026-08-15 (all four commands registered and
DM-capable), so that is not the cause. An always-on gateway process is a
product/cost decision, not a bug fix.
