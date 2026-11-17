# `migration-parity` is RED on 11 files right now — and the queued anon-TRUNCATE revoke would close almost nothing

**Filed 2026-08-29 ~18:00Z (11:00 PT). Status: MEASURED. Nothing shipped, and the
reason for NOT shipping either half is stated.**

The sentinel says `Detector Health (GitHub Actions): [NOT CONFIGURED]` — the three
daily detectors (`edge-fn-drift`, `db-pin-staleness`, `migration-parity`) are
unwatched, and its own warning is that *"a correct one can stay red indefinitely with
nobody reading it."* So I ran one instead of noting it. **It is red.**

## 11 migrations are applied in production with no committed file

Names in `supabase_migrations.schema_migrations` with no matching
`supabase/migrations/*_<name>.sql` in `git ls-tree HEAD`, all applied today between
**05:08Z and 17:17Z**:

```
audit_20260829_board_liveness_probe_hour_aliasing_note          05:08Z
audit_20260829_board_liveness_note_revert_line_exact_version    05:09Z
audit_20260829_relallvisible_is_a_frozen_statistic_not_a_vm_reading   07:07Z
audit_20260829_leaderboard_fix_is_real_but_not_sufficient_under_a_ten_wide_sweep  09:09Z
audit_20260829_sales_2026_insert_autovacuum_sized_from_measured_vm_decay          11:11Z
audit_20260829_sales_2026_vm_falsifier_met_and_inserts_are_not_the_driver         15:09Z
audit_20260829_grant_maintain_sales_2026_to_cron_heavy          17:08Z
audit_20260829_anon_write_surface_arm_is_blind_to_truncate      17:10Z
audit_20260829_leaderboard_sweep_fails_on_a_fresh_visibility_map 17:11Z
audit_20260829_vm_decay_is_diurnal_and_the_insert_trigger_fired 17:15Z
audit_20260829_detect_stalled_pipelines_count_star_always_reads_one 17:17Z
```

**Whose:** not mine — every commit on `main` in the last 10 hours is from this session,
while these 11 landed alongside. This is the exact scenario `check-migration-parity.mjs`
documents: a session with `apply_migration` access and **no push**.

⚠ **Compare on NAME, never version** — `apply_migration` stamps its own version at apply
time, which never equals the author's filename timestamp. I compared on version first and
got **24 false "missing" plus 21 false "not applied"**; the script's header warns about
this in as many words. On name the real count is 11.

## What they actually change — three do, eight are metadata

Classifying by verb at LINE level, excluding whole-line `--` comments (a naive
whole-string regex reported GRANT/ALTER on five of them — those verbs appear inside long
prose headers, and that is a false positive, not a finding):

| version | real change |
|---|---|
| `20260829170822` | `GRANT MAINTAIN ON TABLE public.sales_2026 TO cron_heavy;` |
| `20260829171533` | `ALTER TABLE public.sales_2026 SET (autovacuum_vacuum_scale_factor = 0.05);` |
| `20260829050847` · `20260829070701` | `COMMENT ON` only |
| the other seven | metadata only — they append dated sections to object comments |

⭐ **That comment-as-durable-store pattern is the point, not an accident.** A session that
cannot push is writing its findings into `pg_class` / `pg_proc` comments, which it CAN
write. So its work is not at risk in the way an uncommitted file usually is — but the
repo still cannot describe production, which is what the detector exists to say.

⛔ **NOT recovered into files this pass, deliberately.** The statements ARE recoverable
byte-exact — I proved it on `20260829050909` (863 chars, md5 `2d15969f…` round-tripped
exactly) — but committing another live session's in-flight work under *my* choice of
filename timestamps risks duplicate files if it later lands its own. The recipe is:
`SELECT encode(convert_to(array_to_string(statements, E';\n'),'UTF8'),'base64')`, decode,
then verify against `md5(array_to_string(statements, E';\n'))`. **Name the file with the
APPLIED version** — one of these very migrations exists to correct a hand-stamped
timestamp and calls that the seventh instance of the habit in 24 h.

## 🚨 The half that needs Trevor: the queued anon-TRUNCATE revoke is scoped too narrowly

`audit_20260829_anon_write_surface_arm_is_blind_to_truncate` (17:10Z) found that the
anon-write-surface arm cannot see TRUNCATE, and **deliberately queued rather than shipped**
the fix, in its own words: *"THE FIX IS QUEUED, NOT SHIPPED, AND DELIBERATELY SO. A
146-table REVOKE crosses a scope boundary the ledger records as a deliberate decision
taken with Trevor's explicit 'Proceed'."* **That judgment is right** and this filing does
not override it — security posture is off-limits for autonomous shipping.

⚠ **I nearly filed this as a broken security fix.** The line
`REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon;` appears in that migration and
I measured 146 tables still truncatable afterwards — which reads exactly like a revoke
that failed. It is **indented text inside the COMMENT the migration installs**, i.e. the
queued statement, never executed. Checking the surrounding lines before filing is the only
reason this is an addition rather than a false alarm.

⭐ **The independent measurement CONFIRMS their 146** — different session, different query
(`has_table_privilege`, not acl text), same number. That is the positive control.

⭐ **AND IT ADDS ONE THEY DID NOT HAVE. The queued statement names `anon` only:**

| role | tables with TRUNCATE (of 379 in `public`) |
|---|---|
| `anon` | **146** |
| `authenticated` | **152** |
| `PUBLIC` | 0 |
| both anon **and** authenticated | **146** |
| authenticated only | 6 |

**Every one of the 146 anon tables is also truncatable by `authenticated`.** So the queued
anon-only revoke leaves all 152 reachable by any signed-in user — and on a product where
signing up makes you `authenticated`, it closes close to nothing. This is CLAUDE.md's own
recorded rule firing: *"Revoke `FROM PUBLIC, anon, authenticated` in ONE statement — either
half alone leaves a grant."*

👉 **The statement to put in front of Trevor is the three-role form, not the queued one:**

```sql
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
-- revert: GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
```

⚠ **Verify by `has_table_privilege`, never the acl text** (the repo's standing rule), and
re-run `check_secdef_anon_exec_drift()` afterwards. The queued note's own exit condition —
*"the anon TRUNCATE count above must read 0"* — is necessary but **not sufficient**: it
would read 0 while `authenticated` still held 152. **Add the authenticated count to that
exit condition or the fix will verify green while open.**

⛔ **NOT established:** whether any of the 152 grants are load-bearing. The queued note
argues the June anon carve-outs are INSERT paths that never truncate, which is sound for
`anon`; **nobody has made that argument for `authenticated`**, and it is the argument the
wider revoke needs before it ships.
