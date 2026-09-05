# Needs Trevor — 2026-09-05, after the four delegated decisions

**Short version: nothing here is blocking. All four open items are decided and shipped.** This file exists so the decisions are readable in one place, and so the two things that are genuinely yours are not buried in a ledger with 1,689 headings.

Authority for deciding rather than re-queueing: *"Before I archive this thread — address the issues that were unresolved, and make decisions on those open items based upon what's best for RPC long term and for our users."*

---

## The two things that are actually yours

### 1. One heading I will not write into

The `mv_pack_ev_latest` rewrite is **declined**, and I filed it as a normal dated ledger entry rather than under **"Declined — do not re-suggest"** — because that heading is yours to edit and I am not going to put words under it.

**If you agree it should never be raised again, move that entry there.** Until you do, a future pass may legitimately re-derive it; if it does, the numbers to re-check first are jobid 73 at **48 runs / 0 failed / avg 5.8 s** (the benefit) and **68 dependents behind a `DROP … CASCADE`** (the cost).

### 2. A watch you should not dismiss on its first firing

The unmapped-drain alarm has a new arm, and it has **never fired correctly before**. At close, `drain_quiet_hours` for `nfl_all_day` read **9.64 h** against a 12 h threshold — and against a historical maximum *closed* gap of **6.00 h**. The resolver has already been quieter than it has ever been.

⛔ **If you see "the resolver is QUIET" on that pipeline, that is a true positive.** The old arm cried wolf 45.8% of the time and three passes learned to skim past it; the new one is calibrated to fire zero times against the entire historical gap distribution. Its first firing means the `nfl_all_day` resolver genuinely stopped.

---

## What was decided, and why

### Item 1 — the three dead Top Shot pipelines · **SUPPRESSED, with predicates**

`topshot-catalog-backfill`, `ingest-topshot-challenges`, `topshot-misattrib-drain` each ran **3 times / 0 ok / 0 rows in 30 days**. Three passes read that, called it benign, and left it. An arm dismissed every time is an arm nobody reads.

Each was chased to the thing that took its job over, and the replacement was **measured**:

| pipeline | what took over | proof |
|---|---|---|
| `topshot-catalog-backfill` | the Dapper Atlas walk | 6,967 Top Shot editions updated inside 24 h |
| `ingest-topshot-challenges` | pg_cron **jobid 87 `rpc-refresh-challenge-costs`** (`20 7 * * *`) | all 31 rows touched in 30 d, newest 2026-09-05 07:20:00Z — matching that schedule to the minute |
| `topshot-misattrib-drain` | nothing; it caught up | 410 open of 20,128 candidates (98.0% mapped) |

⛔ **Each reason carries a runnable predicate, not a conclusion.** `pipeline_alert_suppression` has no predicate column, so the discipline lives in the text: the SQL, the threshold, the value measured at apply time, and a sentence saying that **a predicate returning false makes the suppression wrong — delete it, do not renew it.** This repo has already paid for the alternative: a free-text label got a 24-hour silent outage dismissed five consecutive times.

⚠ **Deliberately NOT the `sentinel_threshold_config` ack mechanism.** Migration `20260903163248` records twice that using the ack is your call. An ack carries a reason string; a suppression here carries a predicate that can prove itself wrong. Nothing was unscheduled — all three still fire; only the alert is quiet, and only until **2026-12-05**.

### Item 2 — `mv_pack_ev_latest` rewrite · **DECLINED**

Benefit gone (jobid 73: 48/48 ok, avg 5.8 s), cost real (`DROP … CASCADE` across a public read surface with 68 dependents). The win that was actually available was taken earlier tonight on `pack_ev_latest` itself — **707,048 → 10,898 buffers**.

⚠ Carry forward the trap: `pack_ev_latest` (relkind `v`) and `mv_pack_ev_latest` (relkind `m`) are different objects, and an `ILIKE '%pack_ev_latest%'` caller search matches the MV **as a substring**. Resolve callers from `pg_depend`.

### Item 3 — `cloudflare-ipfs.com` in the CSP · **REMOVED**, and it exposed something bigger

The host is decommissioned — **0/8 CIDs, DNS fails in under 0.1 s** — and **zero rows** reference it across every `url`/`image`/`avatar`/`media`/`art`/`thumbnail` text column of every live public table. Gone from `img-src` and `media-src`.

⭐ **The finding is the second one.** `lib/media/avatar-proxy.ts` keeps `CSP_ALLOWED_IMAGE_HOSTS`, a hand-copy of that directive, and its comment said a test kept the two in sync. **No test in the repo read that constant.** The mirror had drifted **four hosts** behind: `gateway.pinata.cloud`, `*.supabase.co`, `arweave.net`, `*.arweave.net`.

That is user-visible. `canDisplayAvatarUrl()` returning false swaps a perfectly renderable avatar for the monogram default — **and the Arweave pair was moved INTO the CSP on 2026-09-04 specifically so that art would hotlink, while this file went on hiding it.** The existing disjointness test could never have caught it: *disjointness is satisfied by a mirror that is empty.*

Fixed, wildcards added as suffixes **with the leading dot** (bare `arweave.net` would also admit `evilarweave.net`, which anyone can register), and the sync test the comment falsely claimed now genuinely exists.

⚠ `cloudflare-ipfs.com` **stays** in `IPFS_GATEWAY_RE` and `isBareIpfsGatewayUrl` on purpose — matching it *rewrites* a legacy URL onto our own proxy, so deleting it would leave that URL hotlinking a dead host. Removing it there makes the failure worse, not cleaner.

### Item 4 — the unmapped-drain stall test · **REPLACED**

`outflow_3h * 16 < outflow_24h` is a ratio of two trailing counts and reads **TRUE 45.8% of the resolver's life**. Its only effect is to null the ETA, so the ETA was suppressed half the time by an alarm carrying no information.

⛔ **I tested my own first fix and it is worse.** The obvious retune (`12h × 2`) measures **60.4%**. Refuted before shipping, not after.

Replaced with liveness — nothing resolved in 12 h — calibrated on **5,571 consecutive gaps, max 6.00 h, p99 0.74 h, zero over 6 h**, so it would have fired zero times historically.

⭐ **And the ETA stopped pretending to be a point estimate, which is the bigger half.** Both windows are honest arithmetic over the same table and they disagree by 50×: `24h net = 16/day → ~2,627 d`, `7d net = 778/day → ~54 d`. The resolver works in **bulk sweeps** (4,297 rows on 09-02, 899, 43, 8 — against a ~60–110/day baseline). Publishing either alone is a failed read rendered as an answer, so the payload now carries both, and when they diverge more than 3× the alert prints the range and says the rate is not stationary.

---

## Shipped tonight against these four

| what | where |
|---|---|
| three suppressions with predicates | migration `20260905162923` |
| drain liveness + honest ETA (both functions, one transaction) | migration `20260905163444` |
| CSP narrowing + the mirror fix + the sync test | commit `e900d58` |
| four ledger entries (3 shipped, 1 declined) | `docs/overnight/ledger.md`, headings 1685 → 1689 |

Health at close: security invariants **0 rows**, SECDEF anon-execute violations **0**, pipeline alerts **7 → 4**, criticals **0**, `check_pipelines_running_but_not_succeeding()` **1 → 0**, Atlas sets stale over 6 h **0 of 266**.
