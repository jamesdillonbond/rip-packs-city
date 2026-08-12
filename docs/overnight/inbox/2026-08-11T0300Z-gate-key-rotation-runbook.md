# The gate-key rotation — sized, and an ordering that does NOT reproduce the outage

Cowork cloud session, 2026-08-10 ~20:00 PT. **Read-only; nothing applied.** Follow-up to the
24-hour silent ingest outage and the "rotation is still owed to Trevor" item.

> ## ⚠ ASSESSED + CORRECTED 2026-08-11 20:54 PT (Claude Code, interactive)
>
> The finding's **mechanism and its core recommendation are both CORRECT and were adopted** — the
> dual-accept step is now shipped in code. Two claims were **wrong** and one footgun was **missed**;
> the original text is kept struck-through so the record shows what was claimed.
>
> 1. **⛔ The exposure is 9 jobs / 6 functions, NOT 14 jobs / 11 functions.** Five of the eleven
>    functions tabulated below — `backfill-allday-dist-opened`, `backfill-allday-pack-sales`,
>    `backfill-topshot-pack-sales`, `resolve-allday-pull-editions`, `resolve-allday-rip-dist-api` —
>    have **zero commits, ever** (`git log --all -- supabase/functions/<fn>/*` → 0). They are
>    deployed-only functions that D2 never touched, so **their gate keys were never in git history
>    and are not publicly exposed.** Repointing them as part of this rotation would 403 them for no
>    reason: there is no matching `*_GATE_KEY` secret for any of them. The rotation scope is exactly
>    the jobids CLAUDE.md already records — **15, 16, 20, 42, 44, 55, 56, 83, 84**.
> 2. **The 8 secrets ≠ the 9 jobs.** Two of the eight (`ALLDAY_PACK_SUPPLY_GATE_KEY`,
>    `PACK_OPENS_API_GATE_KEY`) gate functions with **no cron job at all** — set them for
>    completeness, but they have no tick to break and need no cron repoint.
> 3. **✅ The exposure claim itself is CONFIRMED for all 6 cron-driven functions.** Verified by
>    fingerprint (md5, values never echoed): the literal at `b4e46435^` matches the key live in
>    `cron.job` today for all six. Deployed source re-read via MCP — still the pre-D2 hardcoded
>    `const GATE = "…"`, confirming the rollback left old code live.
> 4. **⚠ MISSED FOOTGUN — step 2 would break for a reason that has nothing to do with keys.** The
>    repo functions import by **bare specifier** (`from "@supabase/supabase-js"`, resolved by
>    `supabase/functions/deno.json`), but the live deployment reports **`import_map: false`** and
>    still carries an inline `https://esm.sh/@supabase/supabase-js@2.45.0` URL. Deploying repo code
>    without the import map resolving is a **boot failure, not a 403** — a different outage, and one
>    `check_edge_fn_http_failures()` cannot see (it is scoped to 4xx by design). See "Pre-flight".
>
> **Adopted with one change:** the transitional key is read from a **second secret**, never a
> literal. Code shipped this session; the rotation itself remains operator-gated.

## The exposure, sized

**The repo is public — three independent confirmations:**
1. I cloned it **unauthenticated** at the start of this session (`git clone https://github.com/…`,
   no credentials, succeeded).
2. Vercel deployment metadata reports `githubRepoVisibility: "public"` on every deployment.
3. The edge-function source says so itself: *"Cron gate key is a Supabase edge SECRET, never
   hardcoded (**this repo is PUBLIC**)."*

**What the pre-rotation literals currently gate — ~~14 active cron jobs~~ → 9 (corrected), all write-path:**

| edge function | jobs | in public git history? |
|---|---|---|
| `ingest-pinnacle-mints` | 2 (83 `6,16,…`, 84 `*/2`) | ✅ EXPOSED |
| `ingest-allday-pack-opens` | 2 (20, 55) | ✅ EXPOSED |
| `ingest-topshot-pack-opens-history` | 1 (56) | ✅ EXPOSED |
| `backfill-topshot-pack-supply` | 2 (15, 16) | ✅ EXPOSED |
| `compute-pinnacle-pack-ev` | 1 (42) | ✅ EXPOSED |
| `compute-golazos-pack-ev` | 1 (44) | ✅ EXPOSED |
| ~~`backfill-topshot-pack-sales`~~ (29) | ~~1 (`1-58/3`)~~ | ❌ never committed — not exposed, not in scope |
| ~~`backfill-allday-pack-sales`~~ (25) | ~~1 (`*/3`)~~ | ❌ never committed — not exposed, not in scope |
| ~~`backfill-allday-dist-opened`~~ (27) | ~~1 (`2-58/4`)~~ | ❌ never committed — not exposed, not in scope |
| ~~`resolve-allday-pull-editions` (22), `resolve-allday-rip-dist-api` (26)~~ | ~~2~~ | ❌ never committed — not exposed, not in scope |
| `backfill-allday-pack-supply`, `backfill-pack-opens-api` | **0** | secret exists, **no cron job to repoint** |

Every one ingests, backfills or computes — i.e. **writes to the database and consumes disk IO** on an
instance whose binding constraint has been disk IO all week. **The realistic impact of the exposure
is not data theft, it is availability**: an unauthenticated party who reads git history can invoke
these at will and exhaust the IO budget that the public boards depend on.

⚠ **"No new exposure" is correct and I am not disputing it** — the rollback restored a pre-existing
state and was the right call, because it restored service. The point is only that the window is still
open and closing it needs Supabase secrets, which neither agent can set.

## ✅ Checked for the worse failure mode — it is not there

If the new code fell back to an *empty* gate when the secret is unset and then compared permissively,
deploying before setting secrets would have produced an **open door** rather than a 403. It does not:

```ts
// Fail CLOSED when unset: the guard below rejects every request rather than
// accepting an empty ?key=.
const GATE = Deno.env.get("PINNACLE_MINTS_GATE_KEY") ?? ""
```

**Deliberately fail-closed, and documented as such.** That is why the half-completed rotation
produced a 24-hour outage instead of a breach — the design worked, it just failed loudly in a place
nothing was listening.

## ⛔ …but fail-closed is exactly why the stated ordering has an unavoidable gap

> *"set the 8 `*_GATE_KEY` secrets → deploy the env-var functions → repoint the cron keys together.
> Any subset reproduces this outage."*

The gap is **between steps 2 and 3**: once the env-var function is deployed, cron is still sending the
**old literal**, and the new code fails closed against it → **403 on every tick until step 3 lands.**
That is not a subset problem — it is the full sequence, executed correctly, still breaking. The
window is however long deploy-then-repoint takes, across ~~8 keys and ~10 functions~~ 6 keys / 9 jobs.

⚠ **Corrected justification (2026-08-11) — the conclusion holds, the reasoning does not.** The
finding prices the gap in *missed ticks*. That part is weak: every one of these is a **cursored
walk**, so a missed tick delays but does not lose — a few minutes' gap self-heals on the next run.
**The real reason to close the gap is INTERRUPTIBILITY.** Under a strict cutover every intermediate
state is broken, so an operator interrupted between deploy and repoint — or who repoints 5 of 9 jobs
and stops — lands back in a silent-403 state. That is not hypothetical: **it is precisely what
happened on 08-11.** Designing so that every partial state is safe is the correct response to a
rotation that has already been abandoned halfway once.

## ✅ Refined ordering — no intermediate state breaks, and no literal ever enters the repo

⚠ The finding proposed carrying the outgoing key as a **literal** in the repo for steps 2–3, removed
at step 4. **Rejected:** that re-introduces exactly what D2 removed, and the demonstrated failure
mode here is *not finishing multi-step rotations* — if step 4 were dropped the way step 3 was, the
repo would permanently regain a hardcoded key. The finding's own alternative is taken instead: the
outgoing key is read from a **second secret**.

**Shipped 2026-08-11** in all 8 functions (`deno check` clean; truth table exercised against the
real generated code, not a re-implementation):

```ts
const GATE     = Deno.env.get("PINNACLE_MINTS_GATE_KEY") ?? ""
const GATE_OLD = Deno.env.get("PINNACLE_MINTS_GATE_KEY_OLD") ?? ""
function gateKeyOk(k: string | null): boolean {
  return !!k && ((GATE !== "" && k === GATE) || (GATE_OLD !== "" && k === GATE_OLD))
}
```

1. **Set the 6 new `*_GATE_KEY` secrets** (+2 for the cron-less pair) **and the 6 `*_GATE_KEY_OLD`
   secrets** to the *current* literals. Nothing reads them yet — no behaviour change.
2. **Deploy the 8 functions** (see Pre-flight). Both keys are then accepted and cron keeps working on
   the old one. **One deploy, not two.**
3. **Repoint the 9 pg_cron `?key=` values — one job at a time**, verifying each. Both keys are
   accepted, so **the "all together" constraint disappears** and a partial repoint is safe.
4. **Delete the 6 `*_GATE_KEY_OLD` secrets.** **No redeploy, no code change** — which is the whole
   point, because it is the step most likely to be dropped. If it *is* dropped, the exposure is
   simply unchanged from today; it never gets worse.

**Truth table, verified against the shipped code:**

| `*_GATE_KEY` | `*_GATE_KEY_OLD` | new key | old key | wrong / empty / absent |
|---|---|---|---|---|
| unset | unset | ✗ | ✗ | ✗ ← **still fails CLOSED** |
| set | unset | ✓ | ✗ | ✗ |
| set | set | ✓ | ✓ | ✗ ← the transitional window |
| unset | set | ✗ | ✓ | ✗ ← step 1 can even be OLD-only and stay safe |

## ⚠ Pre-flight for step 2 — the deploy itself carries two documented footguns

- **Import resolution.** Repo code imports by bare specifier via `supabase/functions/deno.json`; the
  live deployment has `import_map: false` and an inline esm.sh URL. **Confirm the import map is
  applied at deploy time, or the function will not boot.** `deno check --config
  supabase/functions/deno.json` passing locally (it does) proves the *types*, not the deploy-time
  resolution. This failure mode is a 5xx/boot error, so `check_edge_fn_http_failures()` — 4xx-scoped
  by design — will **not** catch it. Verify with a `mode=probe` call, not by watching the alert arm.
- **`verify_jwt`.** There is no `supabase/config.toml`, so a bare `supabase functions deploy`
  defaults `verify_jwt=true`, breaking every custom-auth cron fn. **Pass `--no-verify-jwt` per
  function** (or deploy via MCP, which sets it explicitly).

**Verification between each step** — the same read-only probe that settled the outage: call one
function with `mode=probe` and confirm 200. After step 3, confirm a `pipeline_runs` row appears
(**not** `cron.job_run_details`, which reports dispatch and cannot distinguish a 403 from a completed
no-op walk — that is what hid this for 24 hours).

## Two smaller notes

- **`check_edge_fn_http_failures()` now closes the detection gap** that let this run 24 h. Worth
  confirming it survives the rotation window itself — during step 3 it will legitimately see 403s
  from any not-yet-repointed job, so expect noise proportional to how long step 3 takes.
  ⚠ **Under the dual-accept ordering it should see NO 403s at all** — both keys are live throughout,
  so any 403 during step 3 is a real defect rather than expected noise. That makes it a *usable*
  signal during the rotation instead of something to mute.
- **jobid 44 `rpc-compute-golazos-pack-ev`** (LaLiga Golazos) is in the gate-keyed set above and was
  flagged silent ~22 h with a literal key, i.e. a different cause. It is worth re-checking **after**
  the rotation, since it will be touched by step 3 regardless.
