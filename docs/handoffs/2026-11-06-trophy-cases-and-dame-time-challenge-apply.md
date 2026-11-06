# Handoff → Cowork: apply the multiple-trophy-cases migration, then land the code

**Filed:** 2026-11-06, ~12:30 PM PT, by a Claude Code cloud session, at Trevor's request ("do option 2 and hand it off to cowork").
**Why Cowork:** the Supabase MCP `apply_migration` in that session asks a confirmation question that never reached Trevor (it timed out twice at 60 s, so nothing was applied). Trevor chose to have the SQL run another way.
**Status at filing:** production is UNCHANGED. Everything below is written, tested and pushed to the branch **`claude/adoring-mayer-y2mr9z`** (tip `e2cc24b2f`). `main` has only this document.

## What it is

Trevor asked for (1) multiple trophy cases per collector and (2) challenge cases. The first challenge is **Dame Time**: favorite Damian Lillard Top Shot Moments and Panini cards. Only pieces the collector holds can go in, and that is checked server-side.

- **DB:** `trophy_cases`, `trophy_challenges` (seeded with `dame-time`), and `trophy_moments.case_id` (NULL = the main case, so all existing pins are untouched).
- **Routes:**
  - `/api/profile/trophy` (GET/POST/PATCH/DELETE) takes an optional `caseId` and scopes every slot read and write by case.
  - `/api/profile/trophy/reorder` takes `caseId`.
  - `/api/profile/trophy-cases` is new: list, create, enter a challenge, rename, delete.
  - New public reads: `/api/public/trophy-cases?username=` and `/api/public/trophy-challenges/<slug>`.
- **UI:**
  - The dashboard has a "More Trophy Cases" panel with a Dame Time "Enter" prompt.
  - `/profile/<u>` shows a collector's extra cases.
  - `/trophy-challenges/dame-time` is a new public board (noindex).

## Step 0 — re-read the base (two minutes, do not skip)

The migration replaces three live objects. Confirm nobody changed them since 2026-11-06 ~11:45 AM PT:

```sql
select proname, md5(trim(regexp_replace(prosrc,'\s+',' ','g'))) from pg_proc
where pronamespace='public'::regnamespace and proname in ('get_trophy_slab_data','reorder_trophy_slots','trophy_case_milestones_track')
union all select 'view', md5(pg_get_viewdef('public.trophy_case_campaign_users'::regclass));
```

Expected values:

| object | md5 |
|---|---|
| `get_trophy_slab_data` | `15bc4194ca1826fc825f6c298f91c699` |
| `reorder_trophy_slots` | `21838f39543b29327efa510f9699eb69` |
| `trophy_case_milestones_track` | `8c64dae7071af4010f659507a6d5224b` |
| `view` | `6660eea25d661d559236ff433e3200c3` |

⛔ **If any value differs, STOP.** Another session changed that object, and applying this would silently revert its work (`CREATE OR REPLACE` is a full-body write). Report back rather than apply.

## Step 1 — apply migration 1

Use the file **verbatim**. Get it from the branch:
`git show origin/claude/adoring-mayer-y2mr9z:supabase/migrations/20261106194000_audit_20261106_multiple_trophy_cases_and_challenges.sql`

Either route works:
- **Preferred:** Supabase MCP `apply_migration` with name `audit_20261106_multiple_trophy_cases_and_challenges` and the whole file as the query. This records it in `schema_migrations`.
- **Or** paste the whole file into the Supabase SQL editor (project `bxcqstmqfzmuolpuynti`) and run it once. It runs as one transaction: it either all applies or none of it does.

It is **backward compatible with the code live right now.** The old `(user_id, slot)` unique constraint is kept, and both changed functions gain a parameter that defaults to NULL (= the main case). The live site keeps working between this step and the deploy.

## Step 2 — verify migration 1 (separate step from applying)

```sql
select proname, md5(trim(regexp_replace(prosrc,'\s+',' ','g'))) from pg_proc
where pronamespace='public'::regnamespace and proname in
 ('get_trophy_slab_data','reorder_trophy_slots','trophy_case_milestones_track','trophy_moments_case_owner_check',
  'get_trophy_cases_for_user','get_trophy_cases_by_username','get_trophy_challenge_entries')
order by 1;
```

Expected values (computed from the file; a mismatch means the SQL was altered in transit):

| function | md5 |
|---|---|
| `get_trophy_cases_by_username` | `45630eb00899c2bf03439640a0344f73` |
| `get_trophy_cases_for_user` | `438660bb3717e706c481ed22accda803` |
| `get_trophy_challenge_entries` | `982bb3e3075008fcbb22b806b6ce87e1` |
| `get_trophy_slab_data` | `4b3bc36db488961e4dc271557a81a438` |
| `reorder_trophy_slots` | `b53f111d6f56f6f2fa65a272f1835b4f` |
| `trophy_case_milestones_track` | `ab05616bf450ac221bc08a5ada7b420e` |
| `trophy_moments_case_owner_check` | `4f459fbf8d154a1053e020a36aff83fa` |

Run one query per item below (the MCP returns only the last result of a multi-statement call):

- **Exactly one signature each.** `select proname, pg_get_function_identity_arguments(oid) from pg_proc where proname in ('get_trophy_slab_data','reorder_trophy_slots') and pronamespace='public'::regnamespace;`
  - Expect `get_trophy_slab_data(p_user_id uuid, p_case_id uuid)` and `reorder_trophy_slots(p_user_id uuid, p_ordered_ids bigint[], p_case_id uuid)`, one row each.
- **Grants, read with `has_function_privilege`.**
  - anon must be **false** on `get_trophy_slab_data(uuid,uuid)`, `reorder_trophy_slots(uuid,bigint[],uuid)` and `get_trophy_cases_for_user(uuid)`.
  - anon must be **true** on `get_trophy_slab_data_by_username(text)`, `get_trophy_cases_by_username(text)` and `get_trophy_challenge_entries(text,int)`.
  - Then `select * from check_secdef_anon_execute_violations();` must return `[]`.
- **The main case reads unchanged.** `select jsonb_array_length(public.get_trophy_slab_data_by_username('<any username with pins>'));` must equal that user's `select count(*) from trophy_moments where user_id=… ` (every row is `case_id IS NULL` at this point).
- **The seed landed.** `select slug, rules from trophy_challenges;` must return one row, `dame-time`.
- `select count(*) from trophy_moments where case_id is not null;` must return **0**.

## Step 3 — land the code on `main`

The branch is one or more commits ahead of `8b559a72b`; `main` will have moved on since. From a push-capable clone:

```bash
git fetch origin main claude/adoring-mayer-y2mr9z
git checkout -B land origin/claude/adoring-mayer-y2mr9z
git rebase origin/main          # only docs/other files moved; conflicts not expected
npm ci && npm run preflight     # must be green; tsc runs with --max-old-space-size=3072
```

Then:
1. Commit the **ledger entry first** and the code commit last, so the code commit is the tip and auto-deploys (a docs-only tip suppresses the Vercel deploy).
2. Push to `main`.
3. Check the Vercel deploy **for that commit** reaches READY.

Ledger text (adapt the times to PT):

> 2026-11-06 · Multiple trophy cases + challenge cases ("Dame Time": Damian Lillard Top Shot + Panini, held-only, server-checked). DB: `audit_20261106_multiple_trophy_cases_and_challenges` (trophy_cases, trophy_challenges, trophy_moments.case_id NULL=main; slab/reorder fns gain p_case_id; milestones + campaign view main-case only; RLS: browser writes main case only). Code: case-scoped trophy routes, /api/profile/trophy-cases, public cases + challenge reads, dashboard panel, profile cases, /trophy-challenges/[slug]. Then `audit_20261106_trophy_moments_drop_user_slot_key`. Revert: code = revert the commit by message; DB = re-add the (user_id, slot) constraint (follow-up file header), then the revert block in the first migration's header.

## Step 4 — after the deploy is READY: apply migration 2

Apply `supabase/migrations/20261106194500_audit_20261106_trophy_moments_drop_user_slot_key.sql` (one statement: drop `trophy_moments_user_slot_key`).

⚠ **ORDER MATTERS.**
- Before the deploy, the live route upserts `onConflict: "user_id,slot"`, and dropping the constraint first makes every pin fail (42P10).
- Until migration 2 is applied, a pin into slot N of a challenge case collides with main-case slot N, so the challenge cannot be filled. Apply it promptly after READY.

Verify: `select conname from pg_constraint where conrelid='public.trophy_moments'::regclass and contype='u';` must list only `trophy_moments_user_case_slot_key`.

## Step 5 — live smoke (rendered DOM, not HTTP 200)

1. `https://www.rippackscity.com/api/public/trophy-challenges/dame-time` must return 200 with `challenge.title = "Dame Time"` and `entry_count: 0`.
2. `/trophy-challenges/dame-time` must render the title and "No entries yet — be the first." Read the DOM, not the status code.
3. `/profile/<a username with a full case>` must render the main case exactly as before, and **no** "More trophy cases" block (nobody has one yet).
4. Signed in on `/dashboard`:
   - The "More Trophy Cases" panel shows a **Challenge · Dame Time** row with **Enter**.
   - Enter it, then pin a held Dame Moment. It should land.
   - Try to pin a non-Dame Moment into the same case. It must be refused with "Dame Time is Damian Lillard only — that Moment is …".
   - Remove the test pin afterwards, or keep it as the first entry if it was Trevor's own.
5. Main-case regression check: pin, unpin and caption a main-case slot on the dashboard, and confirm the main case still shows 6 slots with nothing borrowed from the Dame case.

## What was tested before filing

- **Migration, on a local scratch Postgres 16 with a fixture schema:**
  - It applies cleanly.
  - Main and case reads stay separate, and reorder of the main case leaves the case's rows alone.
  - A foreign `case_id` is refused (23514), and a browser (authenticated RLS) write of a case row is refused.
  - Deleting a case cascades its pins. Grants match the table above.
- **Pinned DB test:** `supabase/tests/get_trophy_slab_data.sql` was re-pointed with 6 new case-scoping assertions and passes. The drift guard is re-pointed to the new migration.
- **`tsc --noEmit`:** clean.
- **Tests:** the trophy, proxy, dashboard and profile suites are green. 27 new tests cover:
  - the rule check, where a failed read is reported as unchecked (503), never as "not Dame", and the player comes from the server, not the request body
  - the case cap and one entry per challenge
  - a failed cases read returns a 503, never an empty list
  - every main-case write is scoped to `case_id IS NULL`.
- **Full `npm run preflight` is GREEN at `e2cc24b2f`:** tsc, ci:guards, lint:ratchet, related and tree-walking tests (4,649), the component coverage gate, migration parse and the DB-invariant SQL tests. Re-run it after the rebase in Step 3.
