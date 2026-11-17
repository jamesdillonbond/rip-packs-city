# The schema-cache 500s are SELF-INFLICTED: one ~20-second burst of user-facing errors per migration we apply

Claude Code, interactive, 2026-08-13 ~16:20 PT (23:20Z). Read-only measurement + one in-code comment
correction. **No DB or behaviour change.**

⚠ **This also CORRECTS my own report earlier today.** I shipped `4f303102` classifying PGRST002 as
transient and described it as fixing `JAVASCRIPT-NEXTJS-1Z` (81 users). That classification is right, but
the measurement below shows it **does not, on its own, absorb the dominant cause.** Stated plainly here
because the commit message and the ledger entry read more confidently than the evidence now supports.

---

## The measurement

Every schema-cache event in the trailing 24 hours falls inside **one 11-second window**:

| timestamp (UTC) | page |
|---|---|
| 17:20:15 | pack dist, edition ×2 |
| 17:20:21 | edition ×2, player |
| 17:20:23 | pack dist |
| 17:20:26 | edition ×2 |

And from `supabase_migrations.schema_migrations`:

| applied (UTC) | migration |
|---|---|
| **17:20:05** | `audit_20260813_pack_rips_collection_block_height_index` |
| 17:21:35 | `audit_20260813_drop_invalid_pack_rips_block_height_index` |
| 17:31:27 | `audit_20260813_revert_pack_rips_block_height_index_regression` |

**The first user-facing 500 lands 10 seconds after the migration; the last 21 seconds after it.**

Applying a migration invalidates PostgREST's schema cache. While it re-introspects, every request it
serves fails with `PGRST002 — Could not query the database for the schema cache. Retrying.`, which our
entity and pack pages surface as a thrown "… detail unavailable" and a 500.

**These errors are not saturation, not upstream, and not random. We cause them, on purpose, every time we
ship a migration.** That is the whole explanation for 81 users / 84 events accumulating since
2026-07-18 — a handful of real visitors caught in each reload window, across many migrations.

## ⚠ Why the retry I shipped is necessary but NOT sufficient

`rpcWithRetry` runs **3 attempts with 50 ms and 200 ms backoff** — roughly **250 ms** of retrying inside
a 45 s budget. The reload window is **~10-20 seconds**. All three attempts therefore land inside the
first quarter-second of a twenty-second outage and fail together.

So: classifying PGRST002 as transient is correct and should stay (it is genuinely retryable, and it will
absorb the short cases). But **do not treat `NEXTJS-1Z` as closed by that commit**; expect it to keep
firing on the next migration.

## Options, with the trade-off stated rather than hidden

1. **Lengthen the backoff for this class only** — e.g. 50 ms → 200 ms → 800 ms → 3.2 s → 12.8 s, ~17 s of
   coverage, comfortably inside the existing 45 s budget. ⚠ This converts a 500 into a **~20-second page
   render that holds a lambda and a pool slot**, and during a reload *many* concurrent requests would
   hold simultaneously. Better for SEO (a crawler gets content, not a 5xx) and arguably for users, but it
   is a product/cost call, not an obvious win — which is why it is filed, not taken.
2. **Apply migrations in a low-traffic window.** Cheapest fix available and needs no code. Several
   sessions apply migrations through the working day; 3 landed within 11 minutes today.
3. **Accept it.** The blast radius is genuinely small per event — a handful of users per migration.
   Worth stating explicitly so the issue stops being re-investigated as a mystery.

⚠ **Do NOT "fix" this by making the pages fail soft.** The throw is deliberate on all three pages: it
exists so a transient failure renders a retryable error boundary instead of a soft-404 that invites
Google to drop a real page (deep-audit D10). Swapping it for a 404 or an empty state would trade a
visible 20-second blip for silent SEO damage.

## Method note

This was found by correlating two clocks nobody had put side by side: Sentry event timestamps and
`supabase_migrations.schema_migrations.version` (which encodes the applied time as `YYYYMMDDHH24MISS`).
**When an error looks like random infrastructure noise, check whether it correlates with our own
deploys or migrations before concluding it is the platform's fault.**
