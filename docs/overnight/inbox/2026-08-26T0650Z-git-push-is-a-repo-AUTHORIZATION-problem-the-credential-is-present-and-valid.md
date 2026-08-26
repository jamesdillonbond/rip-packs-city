# ⛔ Git push from a Cowork cloud session — the credential is PRESENT AND VALID; the repo is not in the session's authorized set

**Filed:** 2026-08-25 ~23:50 PT (2026-08-26 06:50Z) · **By:** Claude (Cowork cloud), interactive
**Answers:** Trevor's standing question, and it CORRECTS the shape of the existing note in CLAUDE.md
**Status:** diagnosed to the layer · **not fixable from inside a running session** · the fix is at session creation

## 1. The measurement

`git push --dry-run origin main` from the cloud container:

```
remote: access denied by the git proxy: jamesdillonbond/rip-packs-city is not in this
session's authorized repository set, so the proxy will not inject a credential for it.
To fix, add the repository to the session's sources.
fatal: … The requested URL returned error: 403
```

⭐ **And the decisive control, which is the part that was never measured before:**

| request (same session, same token) | result |
|---|---|
| `GET https://api.github.com/user` | **200** — `{"login":"jamesdillonbond", …}` |
| `GET https://api.github.com/repos/jamesdillonbond/rip-packs-city` | **403** |
| `GET https://api.github.com/repos/anthropics/claude-code` (public, unrelated) | **403** |

**The credential is present, valid, and is Trevor's own GitHub identity.** It authenticates fine
against an identity endpoint and is refused on *every* repository endpoint, including an unrelated
public repo. **The block is a per-repository allowlist applied ahead of the credential, not a
missing or expired token.**

⚠ **This corrects the framing in CLAUDE.md.** That section already says the refusal happens *"at
the repository-authorization layer, before any credential is evaluated"* — correct — but the
surrounding advice reads as a credential problem to a session that meets it at 3am. The `/user`
200 is the one-line test that settles it, and it should be the first thing a blocked session runs.

## 2. What does NOT work, tested rather than assumed

- **The device bridge.** The Linux VM that mounts Trevor's folders **can reach github.com** (a
  `git fetch origin main` succeeds — it is a public repo) but has **no credential helper**:
  `git push` there fails `could not read Username for 'https://github.com'`. `gh` is not installed
  in that VM. ⚠ **That VM is not the Windows box** — Windows' credential manager and its
  authenticated `gh` are on the other side of the mount and are not reachable from it.
- **An `add_repo` tool.** The proxy's own error names one. **It is not available in this session**
  (`ToolSearch` for it returns nothing). So the remedy the error suggests cannot be executed from
  inside the session it is telling.
- ⛔ **Routing around it was NOT attempted, deliberately.** `~/.ccr/README.md` says: *"do not retry
  organization policy denials (403/407) — report them instead."* And CLAUDE.md's standing rule is
  never to "fix" a 403 by re-embedding a PAT — that burned a real token on 2026-08-16.
- ⚠ **The Project's GitHub sync is a different system.** This session's claude.ai Project lists
  `jamesdillonbond/rip-packs-city` as a synced source. That is the Projects knowledge connector
  (read-only document sync). It has **no relationship** to the git proxy's authorized repository
  set, and its presence is exactly the kind of thing that makes a session assume it has access.

## 3. What actually restores it

**Add the repository as a SOURCE when the session is created.** Authorization is decided at
session creation, so nothing done inside a running session can change it — which is why every
attempt to fix it mid-session has failed and will keep failing.

In practice, one of:
1. **Start the Cowork cloud session with the repo attached as a source** (the desktop app's
   session sources / "add repository"). This is the direct fix.
2. **`/web-setup` in a real terminal Claude Code session** — already recorded in CLAUDE.md; it
   authorizes at creation, so it fixes the NEXT session, not the current one.
3. **Run the task from the desktop** ("Run this task"), which executes against the box that has
   the credential.

**Until then the proven delivery path is `git format-patch`,** which is what tonight's work uses:
patches are written into the connected folder on Trevor's own disk, and one `git am … && git push`
lands them from the box that is authorized.

## 4. ⭐ The second gate, which is separate and is NOT about git at all

Even with push restored, a no-push session's DB reach is narrower than "apply_migration works":

> **A pinned SQL function is PUSH-GATED.** `supabase/tests/<fn>.sql` embeds a verbatim copy of the
> body and `db-pin-staleness` compares it to live daily. Changing the function without committing
> the re-pointed pin turns that check red the next morning, and CLAUDE.md is explicit that
> re-pointing is part of shipping, not a chore.
>
> **A no-push session's real DB levers are: pg_cron schedules, indexes, and brand-new objects.**

⚠ **And `apply_migration` itself creates a push obligation.** Every call writes a row to
`supabase_migrations.schema_migrations`, and `migration-parity` (daily, **enforcing** since
2026-08-20 — its `|| true` was removed) requires a **committed** file for every recent name. So a
no-push session that applies a migration reds a CI check by construction.

⭐ **Sharper rule, learned the hard way tonight:** CLAUDE.md says *"`apply_migration` for DDL;
`execute_sql` for reads/verification."* Read literally, that sends **diagnostic scratch DDL**
through `apply_migration` — and three throwaway probe migrations
(`tmp_pg17_*`) now hold permanent parity obligations for a table that was created and dropped in
the same session. **Use `apply_migration` for DDL that should be part of the schema record; use
`execute_sql` for scratch DDL that exists only to answer a question.** (Record files were written
for all three so parity is satisfiable — see `supabase/migrations/20260826052557…`.)
