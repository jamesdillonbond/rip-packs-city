# Cowork session close — 2026-08-13 (cloud)

Started as `df -h /sessions`. Ended with a live production auth bypass closed on paper.

## ✅ CLOSED — and my headline for it was FALSE (corrected 2026-08-15)

**The defect was real; the evidence I gave for it was not, and the ⛔ severity was inflated.**

Real: the suffix reached past the wall — proven on evidence no redirect can fake,
`/api/mcp/keys/<uuid>` → 307 `/login` (wall) vs `/api/mcp/keys/<uuid>.png` → **405** (handler; a
wall cannot emit 405). Fixed by a concurrent session in **`89d3536a`**; all 11 probe paths now
gated. **Class: defense-in-depth, not a breach.**

False: *"`/topshot` → /login, `/topshot.png` → the full gated page."* There was **no differential**.
`[collection]/page.tsx:6` redirects to `/<slug>/overview`, and a `proxy.ts` rule has opened
`/^\/[^/]+\/overview$/` to anyone since 2026-05-31 — so `/topshot`, `/topshot.png` and
`/totally-bogus-slug/overview` all render the same public page. The suffix reached *less* than what
was already public.

Three failures made it: a **followed redirect** (I attributed the destination's content to the
source URL), **mismatched instruments** (predicate for the "gated" half, live fetch for the
"bypassed" half, presented as a pair), and **treating a path predicate as a visibility claim**. My
patch was correctly NOT applied — `proxy.ts` had been written 14 seconds earlier by a live
concurrent session whose version was better. Correction filed at `5043f09f`.

## ✅ What the disproof uncovered (the real win)

`/<any-bogus-slug>/overview` returned **200 with `canonical` = itself and `robots: index, follow`**
— an unbounded set of indexable self-canonical duplicates on an SEO-dependent project. Fixed in
**`99f245d0`**: `unknownCollectionMetadata()` across 8 layouts, noindex rather than a canonical
naming a real page (the server can't tell which was meant; a guess published as a directive is
worse), with the mirror assertion that a *resolved* collection must not be noindexed. Ledger
`996f7051`.

Also fixed there: two honesty guards that were green in CI and **dead on Windows** — one collected
0 tests, 0 assertions (`execSync("grep…")` under `cmd.exe`), the other asserted a forward-slash
path against `join()` backslashes. 0 → 4 and 51 → 52.

## ⛔ OPEN — operator only

**`/sessions` disk full**, ~6 nights. `device_bash` failed 3× identically this session.
**The fix is local, not in the Cowork UI:** quit Claude from the tray, rename
`...\Packages\Claude_<hash>\LocalCache\Roaming\Claude\vm_bundles\claudevm.bundle\sessiondata.vhdx`
to `.bak`, relaunch, verify `df -h /sessions` ≈ 1%, delete the `.bak`. Rebooting does nothing;
deleting Cowork sessions does nothing. `docs/handoff-2026-08-09-cowork-shell-recovery.md` has been
corrected in place (§0) — it had prescribed the wrong action in its bottom line, untested.

## Landed earlier this session (verified on `origin/main`)

- `6edea505` / `d5815d66` / `7278aa43` — panini backup bounded (100 MB + rotate) and replay made
  streaming. 1,210 MiB reclaimed. Scripts on `main` byte-identical to the delivered patch.
- `8bb5969f` — handoff corrected: the fix invalidated its own cleanup's safety argument.
- `8a252ac7` / `6e52e4a3` — monitor sweep rescued and both candidates closed.
- `6eb7b0e5` (concurrent session) — brand fonts un-gated; the audit of its own "existing entries
  already carry this property" note is what surfaced the bypass above.

## Corrections made to the record

Four claims of mine were wrong. Each was disproven by evidence already available at the time.

1. **"The ops-capture file is the 1.21 GiB leak."** It wasn't — that one is bounded and working.
   The always-on backup was.
2. **"Safe to delete because the tool can't read it."** Streaming replay, shipped in the same
   change, made it readable at the instant deletion was authorised. Verdict right, reason wrong;
   the honest reason is *already ingested*.
3. **"`/sessions` is Anthropic-hosted; delete old Cowork sessions."** Relayed from a handoff four
   times without checking memory, which held the verified local fix.
4. **"⛔ LIVE auth bypass: `/topshot.png` serves a gated page."** The worst of the four, because I
   escalated it. A followed redirect and a predicate-vs-fetch mismatch manufactured the evidence;
   the rule that actually explained the behaviour was 213 lines above the one I was reading, in a
   file I had open. **The pattern across all four: I stopped measuring at the point the answer
   looked right.** Corrections 1, 2 and 4 were each caught by someone else re-deriving them.

## Memory written

`static-ext-suffix-auth-bypass` · `sessions-disk-is-local-vhdx` · `validate-bytes-not-the-response`
· `safety-net-outgrew-its-reader` · `a-fix-can-invalidate-its-own-cleanup-rationale`, plus index
entries for probing with realistic param values, grepping memory before relaying a handoff's fix,
and checking `origin/main` for a concurrent fix before pushing.
