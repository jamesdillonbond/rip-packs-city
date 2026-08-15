# Cowork session close — 2026-08-13 (cloud)

Started as `df -h /sessions`. Ended with a live production auth bypass closed on paper.

## ⛔ OPEN — highest priority, unpushed

**A static-extension suffix bypasses the entire auth wall. Verified live on production.**

```
GET https://www.rippackscity.com/topshot      → /login          (gated, correct)
GET https://www.rippackscity.com/topshot.png  → the full page   (bypass, anonymous)
```

On disk, ready to apply — patch re-verified against `main` @ `c8efe60`:

| file | path |
|---|---|
| patch | `rip-packs-city\proxy-static-ext-bypass-2026-08-13.patch` |
| handoff | `rip-packs-city\docs\handoff-2026-08-13-static-ext-auth-bypass.md` |
| ledger (paste-ready) | `rip-packs-city\ledger-entry-static-ext-bypass-PASTE-READY.md` |

`STATIC_EXT_RX` → `STATIC_ROOT_ASSETS` (exact `Set`). **411** predicate-level bypasses closed, **0**
still open, **0** asset regressions. ⛔ Anchoring the regex to one root segment closes only 384 and
leaves `/topshot.png` — the confirmed case — open; the patch comment and the tests both block that
weaker fix. ⚠ End-to-end anonymous data return was confirmed for exactly one route; treat the
other 410 as "the wall does not stand", not "confirmed leaking". Re-check `/api/mcp/keys/[keyId]`
(API key management, GET/POST/DELETE) by hand.

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

Three claims were wrong and were corrected on contact, each disproven by something in the same
session:

1. **"The ops-capture file is the 1.21 GiB leak."** It wasn't — that one is bounded and working.
   The always-on backup was.
2. **"Safe to delete because the tool can't read it."** Streaming replay, shipped in the same
   change, made it readable at the instant deletion was authorised. Verdict right, reason wrong;
   the honest reason is *already ingested*.
3. **"`/sessions` is Anthropic-hosted; delete old Cowork sessions."** Relayed from a handoff four
   times without checking memory, which held the verified local fix.

## Memory written

`static-ext-suffix-auth-bypass` · `sessions-disk-is-local-vhdx` · `validate-bytes-not-the-response`
· `safety-net-outgrew-its-reader` · `a-fix-can-invalidate-its-own-cleanup-rationale`, plus index
entries for probing with realistic param values, grepping memory before relaying a handoff's fix,
and checking `origin/main` for a concurrent fix before pushing.
