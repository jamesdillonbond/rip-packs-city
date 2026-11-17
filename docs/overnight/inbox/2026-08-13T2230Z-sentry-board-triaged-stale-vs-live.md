# The Sentry board triaged against the live DB — 2 reds were stale, 3 were fixed today, 6 are real

Claude Code, interactive, 2026-08-13 ~15:30 PT (22:30Z). Read-only verification + two Sentry
resolutions. **No code, DB or prod change in this filing** (the schema-cache fix it references shipped
separately as `4f303102`).

---

## ⚠ The method note first, because it is the reusable part

An earlier sweep this session queried Sentry with `firstSeen:-3d` and found one small issue. **That
filter hid the single largest error on the platform for being a month old.** Dropping it surfaced
`NEXTJS-1Z` at **81 users / 84 events since 2026-07-18**.

**When triaging an error board, sort by frequency and user count — never filter by recency.** Age is
evidence of severity, not of irrelevance.

Second: **every "stale" verdict below was checked against the live database, not inferred from the last-seen
date.** Two of them looked identical from the dashboard (single event, days old) and needed opposite
handling — one was genuinely clean, one is a security assertion whose recurrence must be treated as real.

---

## Triage

| issue | events / users | verdict |
|---|---|---|
| `NEXTJS-1Z` pack detail — schema cache | 84 / **81** | **FIXED TODAY** (`4f303102`) |
| `NEXTJS-26` edition detail — schema cache | 40 / 1 | **FIXED TODAY** (same) |
| `NEXTJS-20` player detail — schema cache | 12 / 1 | **FIXED TODAY** (same) |
| `NEXTJS-25` cursor-stall threshold drift | 49 / 42 | **STALE → resolved** |
| `NEXTJS-1C` RLS on + no anon write | 1 / 1 | **STALE → resolved** |
| `NEXTJS-28` destructive SECDEF anon EXECUTE | 1 / 0 | clean now, **left open** — fired 2 h ago |
| `NEXTJS-14` Pinnacle FMV cross-character leak | 2 / 1 | **LIVE — open, see below** |
| `NEXTJS-1Y` team detail — statement timeout | 30 / 1 | **LIVE** — latest-FMV item |
| `NEXTJS-24` set editions — statement timeout | 7 / 1 | **LIVE** — latest-FMV item |
| `NEXTJS-23` series editions — statement timeout | 6 / 1 | **LIVE** — latest-FMV item |
| `NEXTJS-27` series detail — statement timeout | 2 / 1 | **LIVE** — see [2115Z](2026-08-13T2115Z-series-detail-is-a-live-20s-public-page-and-two-obvious-fixes-are-falsified.md) |
| `NEXTJS-22` set detail — pool acquire | 1 / 1 | **LIVE** — same class |

### `NEXTJS-25` — stale, and the reason is a rename

The guard reported `inlined_threshold` on `public.get_pipeline_alerts()`. Verified live:
`check_cursor_stall_threshold_drift()` now returns **`[]`**. The invariant holds —
`cursor_stall_threshold()` = **06:00:00** and the alert arm still derives from it; the call simply moved
into **`get_pipeline_alerts_core`** during the 2026-08-11 *RENAME + thin wrapper* change, and the checker
has since been taught to follow one delegation hop. `get_pipeline_alerts()` is now a **155-char pure
delegate** whose only interval literal is the unrelated edge-fn 2 h window. Fired 49 times over 3 days
before that; quiet since 08-12 15:26. **Resolved**, because a permanently-red guard cannot signal — it
would have been just as red on the day a real drift appeared.

### `NEXTJS-1C` — stale, but verified as a security assertion

`check_public_security_invariants()` and `check_anon_write_surface()` each return **zero rows**, and **0**
public tables have `rowsecurity=false`. **Resolved** — with the note on the issue that a *recurrence* must
be treated as real until re-verified the same way, because this one is a security claim.

### `NEXTJS-28` — clean, deliberately LEFT OPEN

`check_secdef_anon_execute_violations()` is clean. ⚠ **Reading that required the documented trap:
`count(*)` returns 1 when clean**, because the function returns ONE ROW CONTAINING AN EMPTY ARRAY — the
contents are `[[]]`, i.e. zero violations. Left open anyway: it fired 2 h ago on a single event, which is
too little quiet time to call. Its title is `smoke check could not run:` — the honest `couldNotRun` path,
meaning the check could not evaluate, **not** that the assertion was violated.

---

## The one genuinely live item nobody has taken: `NEXTJS-14`

**"Pinnacle FMV not borrowed across characters (drift guard)"** — 2 events, last seen ~2 h ago, and it is
a **hard** failure, not the soft/inconclusive path. That matters: `app/api/smoke-test/route.ts` already
has a `TRANSIENT_RX` soft branch for pool/statement-timeout errors on this exact check (added for Sentry
NEXTJS-13), so infra load reports SOFT. A hard fail means the assertion itself was violated — i.e. a
Pinnacle deal row carried an FMV **borrowed from a different character**.

**Why I did not chase it here:** reproducing it needs `searchPinnacleDeals(svc, { player: "Goofy", … })`
with a service client, which is a lib + credential path rather than a query I can settle read-only, and
guessing at the leak's definition from the outside is exactly how a wrong fix gets shipped. It wants a
session that can run the lib function.

⚠ **Do not dismiss it as smoke-test flake.** Pinnacle FMV is render-keyed and lives in its own
`pinnacle_fmv_history` plane, and the sibling check
(`Pinnacle searchPinnacleDeals filters character_name correctly`) exists because character filtering has
gone wrong before. An FMV borrowed across characters is a **wrong price on a public surface**, which is a
correctness defect, not a latency one — the only such issue currently open on the board.
