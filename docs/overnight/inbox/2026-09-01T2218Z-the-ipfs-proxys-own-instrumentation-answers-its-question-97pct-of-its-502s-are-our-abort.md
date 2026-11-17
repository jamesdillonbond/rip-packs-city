> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T2218Z — `/api/public/ipfs-media/[cid]` fails 86 % of the time, and 97 % of those failures are OUR 8-second abort, not ipfs.io saying no

**Pass:** cloud, 22:18Z fire (`18 */2`, `trig_018AyNcnbCZuYb1Ztts6rbBR`). DB `now()` 22:18:53Z = 15:18 PT. No device bridge, no push.
**Instrument:** Vercel runtime logs, production, `group_by` + full-text — not Sentry (org error quota exhausted since 08-18, so Sentry is **dark, not clean**).

---

## Not a new problem — a question the repo asked itself and never came back to answer

The route header records instrumentation added **2026-08-24** for exactly this: its 502 was silent, so its dominant outcome was unattributable. Its own comment says *"'Our 8 s abort fired' and 'ipfs.io answered 5xx' are different problems with different fixes and they were spelled identically"*, and it names the consequence of guessing: *"raising `UPSTREAM_TIMEOUT_MS` only helps the first kind."*

Nobody has read that instrumentation at scale since. Here it is.

## The split, with the denominator carried

Production, 24 h to 2026-09-01 22:35Z, route `/api/public/ipfs-media/[cid]`:

| outcome | count |
|---|---:|
| **502** | **299** |
| 200 | 46 |
| 429 (ipfs.io rate-limiting us, returned through) | 5 |
| 302 (oversize redirect, working as designed) | 1 |

**299 / 351 = 85.2 % of requests fail; 86.7 % of the 200-or-502 pairing.**

Attribution of the 299, by the route's own log lines:

| branch | count | share |
|---|---:|---:|
| `reason=abort_timeout` (**our** `AbortSignal.timeout(8_000)` fired) | **290** | **97.0 %** |
| `reason=transport` (genuine fetch fault) | **0** | 0 % |
| `upstream not ok` (gateway answered and said no) | 5, all HTTP 429 | — |

Every sampled line is the same shape: `elapsedMs` 7,846–8,008, i.e. pinned to the 8 s ceiling.

## It is chronic, not a regression — and roughly flat

| window | 502 | 200 | fail rate |
|---|---:|---:|---:|
| 72 h → 36 h ago | 131 | 14 | 90.3 % |
| last 24 h | 299 | 46 | 86.7 % |
| the route's own 2026-08-24 note | 99 | 26 | ~76 % |

⚠ **The denominator is cache-MISS invocations only.** An edge-cached hit never reaches the function and never logs, so this is *not* the fraction of images users see broken — it is the fraction of *uncached* loads that fail. The route fails soft (502 → `<img onError>` advances to the next candidate), so the user-visible symptom is a placeholder, not an error page.

## What this rules out, which is the point

- ⛔ **Raising `UPSTREAM_TIMEOUT_MS` is not the fix, and the route already knows why.** The platform's own initial-response cutoff is 25 s, and the header records that this timeout *was* 25 s and lost the race to it, making the 502 path unreachable dead code (205 × 504 in one 40-minute window, 2026-07-27). It also records a residential probe seeing **ipfs.io itself return 504 after ~28 s**. Raising our abort converts 502s into platform 504s, not into images.
- ⛔ **It is not a transport fault.** Zero `transport` lines in 24 h. The network is fine; the gateway is slow.
- ⓘ **The 429s are new information, small but real** — ipfs.io is rate-limiting our egress at least occasionally, which a single-gateway design cannot back off from.

## The lever, and why this pass did not take it

The fix is a **different or multiplexed gateway** (race two or three public gateways, first body wins), or pre-caching the ~10,786 IPFS-backed edition assets into our own storage. Both are **route code** — `app/api/public/ipfs-media/[cid]/route.ts` — which a cloud-only pass **cannot push**. Filed for the desktop/Claude Code track.

⚠ Whoever takes it: the route's header already records one refuted lever — *"a promising 'ranged requests succeed where full GETs 504' reading did NOT reproduce on re-test and is deliberately not recorded as a lever."* Do not re-derive it.

## Transferable rule

**Instrumentation is not a finding; reading it is.** This route was made observable eight days ago specifically to answer one binary question, and the answer sat in the logs unread while the class kept being re-filed as "elevated 5xx, upstream IPFS pass-through, fails soft" (08-09, 08-11, 09-01 03:00Z). When a past pass ships observability with a stated question, the next pass that touches the class owes it the query — not another sighting.
