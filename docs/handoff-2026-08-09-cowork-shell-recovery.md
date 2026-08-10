# Cowork sandbox shell — why it is wedged, and how to re-enable it

Written 2026-08-09 (Claude Code, interactive, from Trevor's Windows box) in response to
"explore how we can re-enable shell in Cowork". Read-only investigation; nothing here
was executed against Cowork.

**Bottom line: this is a disk-capacity failure on the Anthropic-hosted sandbox volume
`/sessions`, and it cannot be fixed from this repo or from Trevor's machine. The one
operator action with a real chance of clearing it is deleting old Cowork sessions.**

---

## 1. What is actually failing

Two consecutive overnight passes died the same way:

```
ensure user: useradd failed … cannot create directory /sessions/<session-name>: no space left on device
```

`useradd` runs during sandbox provisioning, **before any user code executes**, and it needs to
create the session's home directory under `/sessions`. With zero bytes free it fails, so the
shell never comes up at all.

Everything that does *not* need the shell kept working on both nights: Supabase MCP (read +
`apply_migration`), Vercel MCP, Sentry MCP, and the file tools (Read/Write/Glob against the
mounted tree via Windows paths). Only `mcp__workspace__bash` — and therefore all of git — was
lost.

## 2. The escalation, and why the known workaround stopped working

This is the part worth internalising, because it explains why "just do what the earlier passes
did" is not available.

| date | symptom | workaround | outcome |
|---|---|---|---|
| 08-05 | `/sessions` ~90% full, could not hold a checkout | clone into `/tmp` (root fs, 4 GB free) | **git fully functional** |
| 08-07 | same | same | **git fully functional** |
| 08-08 | `mkdir /sessions/<sess>/mnt: no space left on device` | none reachable | shell dead, NO-PUSH |
| 08-09 | `useradd failed … /sessions … no space left on device` | none reachable | shell dead, NO-PUSH |

⚠ **The proven `/tmp` fallback is now structurally unreachable.** Using `/tmp` requires a shell,
and the failure has moved *upstream of the shell* — provisioning dies while creating the user.
So no in-sandbox remedy, prompt change, or retry can recover it. The volume has to be freed from
outside.

That is also why retrying is pure waste: the 08-09 pass failed identically on resume, on create,
and on re-resume.

## 3. What is consuming the volume

Measured on this box (2026-08-09):

| path | size |
|---|---|
| `node_modules/` | **811 MB** |
| `.git/` | 48 MB |
| `docs/` | 13 MB |
| `.next/` | 0 (not built here) |

⚠ **The "repo is too big" theory is disproven** — a bare checkout of this repo is well under
100 MB, which comfortably fits. The weight is entirely `npm install`.

**Inferred mechanism (labelled as inference — I cannot see `/sessions` to confirm):** the repo's
own deploy-split rule says never to commit from the mount, *always from a fresh clone*. Each
Cowork session therefore creates a fresh clone under its `/sessions/<session-name>/` home, and any
session that runs tests or a typecheck adds ~811 MB of `node_modules` on top. At roughly
0.9 GB per session, a volume the 08-05 note describes as "90% full, ~1 GB free" is consumed by
about ten sessions' worth of residue.

The load-bearing implication: **`/sessions/<session-name>/` directories appear not to be garbage
collected when a session ends.** If they were, a single session's ~0.9 GB would be reclaimed and
the volume would never creep.

## 4. What to actually do

**Step 1 — operator, unblocks everything (highest probability, do this first).**
In the Cowork UI, delete or archive old/finished sessions, especially any that ran builds or
tests against this repo. Each one plausibly reclaims ~0.9 GB. This is the only step that can
break the deadlock, because nothing inside the sandbox can run until space exists.

**Step 2 — verify the fix took.** Start any Cowork session and run `df -h /sessions` plus
`du -sh /sessions/* | sort -h`. That single command pair confirms both that the shell is back and
which directories were the hogs — worth capturing into the ledger the first time it succeeds,
since nobody has yet seen the actual breakdown.

**Step 3 — stop it recurring.** The scheduled task prompts live in Cowork (Scheduled), *not in
this repo*, so they cannot be edited from here. When they are next edited, the durable fixes in
priority order:

1. **Clone to `/tmp`, not `$HOME`.** Already proven to work on 08-05 and 08-07, and `/tmp` is the
   larger 4 GB root fs. This alone keeps the heavy artefacts off `/sessions`.
2. **`rm -rf node_modules` at the end of every run**, or skip `npm install` entirely on passes
   that ship nothing. Most read-only monitor runs never need it.
3. Prefer `npm ci --omit=dev` where a run genuinely needs deps but not the test toolchain.

**Step 4 — report it.** A provisioning volume that fills up and then blocks `useradd` is an
Anthropic-side bug, not a user misconfiguration: the failure is pre-shell, gives no actionable
message to the operator, and has no in-product remedy. Worth reporting with the two error strings
in §1.

## 5. What this does NOT affect

Do not let a NO-PUSH night be mistaken for a broken repo or a broken credential:

- **Trevor's Windows box pushes fine.** The PAT lives in `remote.origin.pushurl`; this session
  pushed normally. ⚠ An inherited "cannot push" claim from a Cowork handoff is about the *cloud
  sandbox's* git proxy and does **not** apply here — verify the actual remote before believing it
  (this exact false inference has now cost time twice).
- **Supabase/Vercel/Sentry MCP are unaffected**, so DB migrations and health triage continue.
- **Nothing was lost.** The 08-08 and 08-09 passes wrote their outputs to the mount; they were
  simply unpushed until a session with git picked them up.
