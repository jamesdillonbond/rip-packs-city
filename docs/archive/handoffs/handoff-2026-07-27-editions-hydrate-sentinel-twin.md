# Handoff 2026-07-27 — the third copy of `pickPlayerName`, still unguarded

## Context

`b6871e28` fixed the `<invalid Value>` compose-fallback in **two** places:
`supabase/functions/topshot-stub-resolver/index.ts` and
`supabase/functions/_shared/topshot-stub-parse.ts`. Both verified fixed on `main` (re-cloned at
`4a4c533`) — they carry the `clean()` helper that strips the sentinel from FirstName/LastName.

**There is a third copy, and it is the one that already fired.**

Cowork has already shipped the DB repair (migrations
`audit_20260727_null_invalid_value_player_names` + `audit_20260727_invalid_value_revert_lock_down`).
This handoff is the remaining code change, which Cowork cannot push.

---

## The finding

`lib/editions-hydrate.ts::pickTsPlayerName` (~L309-315) is byte-identical to the **pre-fix** body:

```ts
function pickTsPlayerName(meta: Record<string, string>): string | null {
  const full = meta.FullName
  if (full && full !== "<invalid Value>" && full.trim() !== "") return full.trim()
  const first = (meta.FirstName ?? "").trim()   // ← sentinel passes straight through
  const last = (meta.LastName ?? "").trim()     // ← sentinel passes straight through
  const composed = [first, last].filter(Boolean).join(" ")
  return composed || null
}
```

Verified as the only remaining unguarded copy — `grep -rn "FirstName" lib/ app/ supabase/ workers/`
returns just this one plus the two fixed edge-fn copies. (`golazos-listing-cache` and
`allday-listing-cache` also compose first+last, but from Flowty **traits**, not Top Shot on-chain
metadata, so the sentinel class does not apply there.)

### It was not latent — it fired months ago

The claim that this "never fired only because the queue was stuck" holds for the *edge-fn* path. This
Vercel-side copy is on a different trigger and wrote corrupt data on **2026-04-04**:

| location | rows carrying the sentinel |
|---|---|
| `editions.player_name` | 1 — `141:5156`, the doubled form `"<invalid Value> <invalid Value>"` |
| `players.name` | 4 |
| `wallet_moments_cache.player_name` | **941** (933 single + 8 doubled, 93 wallets, 44 edition_keys) |

`141:5156` is not an obscure row: **FANDOM tier, 2,948 circulation, 415 sales, 51 FMV snapshots** —
a fully-trafficked live edition page rendering `<invalid Value> <invalid Value>` as its player name.

### Ground truth (read from chain 2026-07-27, `TopShot.getPlayMetaData`)

```
FullName = "<invalid Value>"   FirstName = "<invalid Value>"   LastName = "<invalid Value>"
TeamAtMoment = "Denver Nuggets"   PlayType = "Redemption"   SetName = "The Champion's Path 2024"
```

All three name fields are the sentinel. It is a genuine player-less redemption moment — **NULL is the
correct value, verified, not assumed.** This also confirms the ~88% team-moment read: the sentinel and
the missing-player case are the same population.

---

## The change

Port the shipped `clean()` guard into `lib/editions-hydrate.ts::pickTsPlayerName` so all three copies
agree. Full-file replacement per CLAUDE.md; the edited function should end up as:

```ts
function pickTsPlayerName(meta: Record<string, string>): string | null {
  const full = meta.FullName
  if (full && full !== "<invalid Value>" && full.trim() !== "") return full.trim()
  // FirstName/LastName carry the SAME sentinel — guarding only FullName let the
  // compose path write the literal "<invalid Value> <invalid Value>" (live on
  // editions 141:5156 from 2026-04-04 until the 2026-07-27 repair).
  const clean = (v: string | undefined): string => {
    const t = (v ?? "").trim()
    return t === "<invalid Value>" ? "" : t
  }
  const first = clean(meta.FirstName)
  const last = clean(meta.LastName)
  const composed = [first, last].filter(Boolean).join(" ")
  return composed || null
}
```

Best would be to **import `pickPlayerName` from the shared module** rather than keep a third copy —
three copies of one predicate is what caused this. Only worth it if the edge-fn `_shared/` module is
reachable from the Next build; if it is not, keep the local copy and add a comment on each pointing at
the other two.

**Worth a test mirroring the two you shipped:** `pickTsPlayerName({FullName:'<invalid Value>',
FirstName:'<invalid Value>', LastName:'<invalid Value>'})` must return `null`. Prove it fails against
pre-fix code first, same as you did edge-side.

---

## Already shipped by Cowork (no action needed, listed for the ledger)

`audit_20260727_null_invalid_value_player_names`
- Captured all 942 prior values into `public.audit_20260727_invalid_value_revert` (`src`, `row_id`,
  `old_player_name`, `old_player_id`) before touching anything.
- `editions.player_name = NULL, player_id = NULL` for the 1 row; `wallet_moments_cache.player_name =
  NULL` for the 941.
- **The 4 `players` rows named `<invalid Value>` were deliberately left alone** — 3 are orphans
  (0 editions linked) and 1 (`f4861581-04c2-4008-b74a-b82aa2446414`) was linked only to `141:5156` and
  is now unlinked. Deleting rows from a table with an inbound FK from `editions` is an owner call, not
  an autonomous one. They currently render nowhere via editions, but they are still in `players`.

`audit_20260727_invalid_value_revert_lock_down`
- The new `audit_*` table landed with **anon SELECT true** — the standing RPC trap (RLS is self-healed
  hourly at :47, but the GRANT is not). Revoked from `anon` + `authenticated`, `service_role` retained.
- Verified after: `anon_select=false, auth_select=false, svc_select=true`.

Post-flight: `check_public_security_invariants()` → `[]`. Revert SQL for both is in the migration
headers.

---

## Guardrails

- Direct to `main`, no branches, no PRs. If a `claude/*` branch is checked out, switch first.
- Commit via PowerShell `git`; re-verify with `git rev-list --count origin/main..HEAD` (expect 0).
- CRLF: full-file writes, not string-replace patching.
- Docs-only tip commits skip the code deploy — land the code change as the **tip**.

**Claude Code's direct file inspection wins over this doc on any disagreement.**

## Expected end state

One commit on `main`, deploy READY, all three copies of the predicate guarding FirstName/LastName, and
this query staying at 0 permanently:

```sql
SELECT count(*) FROM editions WHERE player_name ILIKE '%invalid Value%';
```
