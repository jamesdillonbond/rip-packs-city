# Cowork sandbox shell — why it is wedged, and how to re-enable it

Written 2026-08-09 (Claude Code, interactive, from Trevor's Windows box) in response to
"explore how we can re-enable shell in Cowork". Read-only investigation; nothing here
was executed against Cowork.

> ⛔ **CORRECTED 2026-08-13 — READ §0 FIRST. The bottom line immediately below is WRONG on the
> two things that matter: `/sessions` is NOT Anthropic-hosted, and it CAN be fixed from Trevor's
> machine. Following §4 Step 1 as written cost roughly six nights of blocked overnight passes.
> The rest of the document (§1–§3, §5) is accurate and worth keeping.**

**Bottom line: this is a disk-capacity failure on the Anthropic-hosted sandbox volume
`/sessions`, and it cannot be fixed from this repo or from Trevor's machine. The one
operator action with a real chance of clearing it is deleting old Cowork sessions.**

---

## 0. CORRECTION (2026-08-13) — what actually clears it

**`/sessions` is a virtual disk inside the local Hyper-V VM the desktop app runs.** It is not
Anthropic-hosted. The fix is renaming one file on Trevor's Windows disk and relaunching.

This was already known and empirically verified on **2026-07-13** — that session located the
`.vhdx`, renamed it, and measured `df -h /sessions` go from **~97% used to 1%**, with bash, git and
clone all restored. This handoff was written 2026-08-09, four weeks later, without that finding.

**Why the original conclusion was wrong, in a way worth generalising:** this document says up
front that it is a read-only investigation and *"nothing here was executed against Cowork."* The
"Anthropic-hosted" claim is therefore an **inference**, and it was placed in the bottom line with
the same confidence as the measured parts (§3's `git ls-files` numbers, which are solid). An
inference and a measurement got the same typographic weight, and the inference was the load-bearing
one. See the memory note `audit-claims-record-vs-generated`.

### The procedure

Locate the disk — package directory names change with app versions, so search rather than assume:

```powershell
gci $env:LOCALAPPDATA\Packages -Recurse -Include *.vhdx -EA SilentlyContinue |
  select FullName, @{n='GB';e={[math]::Round($_.Length/1GB,2)}}
```

Expected under `...\Packages\Claude_<hash>\LocalCache\Roaming\Claude\vm_bundles\claudevm.bundle\`:

| file | role |
|---|---|
| **`sessiondata.vhdx`** | **this is `/sessions`** — ~9.8 GB cap, the one that fills |
| `rootfs.vhdx` | base Linux — leave alone |
| `smol-bin.vhdx` | helper — leave alone |

1. Quit Claude fully **from the tray**, not just the window.
2. Confirm it is down: `Get-Process claude,vmmem -EA SilentlyContinue` returns nothing.
3. `Rename-Item <path>\sessiondata.vhdx sessiondata.vhdx.bak` — reversible; rename back if the app
   won't start.
4. Relaunch. The app recreates an empty disk.
5. Verify in a new session: `df -h /sessions` should read ~1%.
6. Delete the `.bak` to reclaim ~9.5 GB.

### Two things that do NOT work

- ⛔ **Deleting old Cowork sessions in the UI** — §4 Step 1 below. Untested when written, and six
  nights of blocked passes are the evidence against it.
- ⛔ **Rebooting.** The `.vhdx` survives reboots. A full Windows restart on 07-13 returned the
  identical `useradd` error; only the rename cleared it. Do not prescribe "just restart".

### Root cause and recurrence

Known upstream bug — per-session disk leak, no garbage collection of `/sessions/<name>/` dirs
(anthropics/claude-code #59856, closed as duplicate, no fix shipped). §3's inference that the dirs
are not garbage collected was **correct**; only the location was wrong. The fresh disk refills
over many sessions — overnight passes are the heavy consumers — and the same rename clears it each
time. Consider a periodic reset.

---

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

| path | size | reaches a sandbox clone? |
|---|---|---|
| **tracked content** (`git ls-files`) | **33.4 MB** | yes |
| `.git/` | 48 MB | yes |
| `node_modules/` (root) | **811 MB** | only if the session runs `npm install` |
| `workers/` | 362 MB | no — per-worker `node_modules`, ignored |
| `panini-capture.jsonl` | **1,004 MB** | **no — gitignored** (`.gitignore:122`) |
| `coverage/` | 22 MB | no — gitignored (`.gitignore:118`) |

⚠ **The "repo is too big" theory is disproven: a fresh clone is ~82 MB** (33.4 MB of tracked files
plus 48 MB of history), which fits comfortably. The weight is entirely `npm install`.

⚠ **Do not measure this with `du -sh` on a working tree — it overstates a clone by ~18×.** A plain
`du` here reports **1.1–1.5 GB** for the worktree, which looks like it confirms the "repo is too
big" theory. It does not: **1 GB of that is a single gitignored file**, `panini-capture.jsonl`
(the residential Panini runner's local capture), plus another 362 MB of per-worker `node_modules`.
None of it is tracked, so none of it reaches a sandbox clone. The number that matters is
`git ls-files`, not `du`. I nearly recorded the wrong conclusion from exactly this.

**Inferred mechanism (labelled as inference — I cannot see `/sessions` to confirm):** the repo's
own deploy-split rule says never to commit from the mount, *always from a fresh clone*. Each
Cowork session therefore creates a fresh clone under its `/sessions/<session-name>/` home (~82 MB,
harmless), and any session that runs tests or a typecheck adds **~811 MB of `node_modules`** on
top — nearly 10× the clone itself. At roughly 0.9 GB per session, a volume the 08-05 note
describes as "90% full, ~1 GB free" is consumed by about ten sessions' worth of residue.

So the ratio is the actionable part: **the checkout is ~9% of a session's footprint and the
dependency install is ~91%.** Any remedy aimed at the repo is aimed at the wrong 9%.

The load-bearing implication: **`/sessions/<session-name>/` directories appear not to be garbage
collected when a session ends.** If they were, a single session's ~0.9 GB would be reclaimed and
the volume would never creep.

## 4. What to actually do

**Step 1 — ⛔ SUPERSEDED BY §0. Do the `sessiondata.vhdx` rename instead.** Kept as written so the
correction has something to point at.

> ~~**Step 1 — operator, unblocks everything (highest probability, do this first).**
> In the Cowork UI, delete or archive old/finished sessions, especially any that ran builds or
> tests against this repo. Each one plausibly reclaims ~0.9 GB. This is the only step that can
> break the deadlock, because nothing inside the sandbox can run until space exists.~~

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
