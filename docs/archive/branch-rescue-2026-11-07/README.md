# Branch rescue — 2026-11-07

Trevor asked (2026-11-07 ~10:03 AM PT) to delete every stale non-`main` branch on GitHub without losing anything. Before deletion, every line each branch added was compared against `origin/main` (per commit, per file). Anything that existed only on a branch is preserved in this folder.

| Branch | Tip SHA | Behind `main` | Disposition |
|---|---|---|---|
| `claude/adoring-mayer-y2mr9z` | `38744fa19ad1098d87ede221cbf724cef39eaaa4` | 119 | Trophy-cases working branch (11-06). Every file is on `main`; the ~10 differing lines are the later refinements `main` shipped (render-time `Date.now()` removed, branded titles, panel copy). Nothing to rescue. |
| `claude/health-check-cleanup-i3yql2` | `acdb8a317ad0251a196e72fe56c58d50cd5f6f36` | 4,438 | 09-26 "HOLDING BRANCH" for the `fmv_asc` / `discount_asc` market sort. Route change and migration `20260926141315` are on `main`; the test assertions exist on `main` in renamed form (`get_topshot_sniper_deals_v3`, `__tests__/api-market-deep.test.ts`). Nothing to rescue. |
| `claude/todo-implementation-qi4350` | `47d717b04396c02f8737470968c8ec6489d8ede0` | 9,945 | 08-05 Claude Code session that could not push to `main`. Its ledger and code-todos entries reached `main` separately (`ledger-archive-2026-H2.md`, `code-todos.md` #2), and the migration is on `main` as `20260805015722_…` — but only as a 9-line body. **Rescued here:** the two handoff specs, the annotated migration (header + verbatim REVERT DDL that `main`'s copy lacks), and that session's `focus.md`. |

Files in this folder:

- `handoff-2026-08-05-panini-price-capture-outage.md` — historical; Panini pricing has since been restored.
- `handoff-2026-08-05-unmapped-backlog-resolver-reason.md` — historical spec.
- `20260805_retire_deposit_scanner_ownership_scaffold.annotated-with-revert-ddl.sql.txt` — the revert source for the 08-05 scaffold drop. It is `.txt` on purpose: it is not a migration, and must not run.
- `focus-2026-08-05.md` — that session's focus steer, for the record.

If a deleted branch is ever needed again, GitHub can restore it from the repo's Branches page for a while after deletion, and every commit is addressable by the tip SHAs above as long as GitHub retains them.
