import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import stripComments from "../scripts/lib/strip-comments.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// A QUOTA THAT COUNTS EVENTS MUST HAVE SOMETHING THAT WRITES THEM.
//
// ⭐ THE INCIDENT, 2026-09-03. `check_feature_quota(wallet, feature)` counts
// `usage_events WHERE feature_name = p_feature` over 24h and returns
// `allowed = used_today < daily_limit`. The MCP worker gates every authed
// request on it with `p_feature: "mcp_query"`, and `workers/rpc-mcp-proxy/
// README.md` advertises a `429 Retry-After` at the cap.
//
// **Nothing writes `mcp_query`.** The logger — `mcp_log_tool_call` — writes
// `feature_name = 'mcp_' || p_tool_name`, so a call lands as `mcp_get_fmv`,
// `mcp_lookup_wallet` and so on. The counted key and the written keys are
// disjoint, `used_today` is pinned at 0, and the cap cannot fire for ANY plan —
// including `free`, whose 100/day cap is the anonymous-abuse surface.
//
// 🚨 WHY THIS IS A GUARD AND NOT A NOTE: the failure is SILENT IN THE DIRECTION
// OF PERMISSION. A rate limiter that never fires looks exactly like a rate
// limiter nobody has hit, on every instrument — the route 200s, the quota RPC
// answers `allowed:true`, `pipeline_runs` is untouched, no error is logged
// anywhere. It is the `?? 0`-on-a-count shape one level up: the guard fails
// OPEN and publishes the failure as a measured "within quota".
//
// ⚠ NOT EVERY CHECKED FEATURE IS EVENT-COUNTED, and assuming so would have made
// this guard wrong in the other direction. `saved_wallets_max` reads ONLY
// `quota.daily_limit` and counts the user's rows itself (see
// `lib/profile/saved-wallet-quota.ts`) — it is a cardinality cap wearing the
// quota RPC's shape, and it never needed a writer. That is why the exemption
// below is a SUPPRESSION LIST WITH REASONS rather than the property being
// weakened for everyone.
//
// ⚠ WHAT THIS GUARD IS STRUCTURALLY BLIND TO, stated because the blindness is
// the defect's own mechanism: it matches STRING LITERALS. `mcp_log_tool_call`
// composes its feature name (`'mcp_' || p_tool_name`), so a literal scan cannot
// see it as a writer of anything — which is exactly how the counted key and the
// written keys drifted apart unnoticed. A future writer that composes its name
// will be invisible here too and will read as "no writer". The last case below
// pins that the composed form is still what ships, so the blindness is recorded
// against the real DDL rather than only in this comment.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..")

/** Features whose quota row is a CARDINALITY cap or which are knowingly broken. */
const SUPPRESSED: Record<string, string> = {
  // Reads `quota.daily_limit` only, as a max-at-any-time cap, and counts the
  // user's saved_wallets rows itself. `allowed` / `used_today` are never read,
  // so there is nothing for a writer to feed.
  saved_wallets_max: "cardinality cap — consumes daily_limit only, never allowed/used_today",

  // ⚠ WRITTEN, BUT FROM SQL — so this scan cannot see it, and that is the ONLY
  // reason it is here. `mcp_log_tool_call` writes the `mcp_query` row (migration
  // `20260903164254`, applied and verified live the same day: two tool calls took
  // `used_today` 0 → 2). It is a `plpgsql` INSERT, not a `recordFeatureUsage`
  // call, so a TypeScript literal scan is blind to it BY CONSTRUCTION.
  //
  // ⛔ Do NOT "fix" this by teaching the scan to read migrations. Migrations are
  // append-only history: a literal in ANY past migration would count as a live
  // writer, so the scan would bank credit from DDL that has since been replaced —
  // exactly the shape that lets a guard pass on a property that stopped holding.
  // The DB half has its own instrument, which runs against a real Postgres and
  // asserts the property rather than the spelling:
  // `supabase/tests/mcp_log_tool_call.sql` fails if `used_today` stays 0.
  //
  // Until 2026-09-03 this entry read "OPEN — needs a wrangler deploy". That was
  // the right call for a Worker-side fix and the wrong diagnosis: the Worker
  // already calls `mcp_log_tool_call` on every tool call, so the write belonged
  // in the function it was already calling, and no deploy was needed at all.
  mcp_query: "written from plpgsql, invisible to a TS scan — pinned by supabase/tests/mcp_log_tool_call.sql",
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue
    const abs = path.join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(abs)
  }
  return out
}

const SOURCES = ["app", "lib", "workers"].flatMap((d) => walk(path.join(ROOT, d)))

/** Read a source file with comments removed, and prove the strip did something sane. */
function code(abs: string): string {
  const raw = readFileSync(abs, "utf8")
  const stripped = stripComments(raw)
  // ⚠ CLAUDE.md: "USING the stripper is not a guarantee it stripped — blind
  // THREE times". A blanked file reads as a file with no call sites, i.e. a
  // silent pass. Length is a crude canary but it is the one that catches the
  // recorded failure (a `${` nesting bug that BLANKED code), and it costs
  // nothing. It is asserted per-file in its own case below, not swallowed here.
  return stripped
}

function collect(re: RegExp, src: string, into: Set<string>) {
  for (const m of src.matchAll(re)) into.add(m[1])
}

function scan() {
  const checked = new Set<string>()
  const written = new Set<string>()
  for (const abs of SOURCES) {
    const src = code(abs)
    if (!src.includes("eatureQuota") && !src.includes("feature_quota") && !src.includes("eatureUsage") && !src.includes("feature_usage")) continue
    // TS helper form: checkFeatureQuota(wallet, "feature") / recordFeatureUsage(...)
    collect(/checkFeatureQuota\(\s*[^,()]+,\s*["']([\w-]+)["']/g, src, checked)
    collect(/recordFeatureUsage\(\s*[^,()]+,\s*["']([\w-]+)["']/g, src, written)
    // Raw RPC form, as the Worker uses: the rpc name, then its p_feature literal.
    collect(/["']check_feature_quota["'][\s\S]{0,300}?p_feature:\s*["']([\w-]+)["']/g, src, checked)
    collect(/["']record_feature_usage["'][\s\S]{0,300}?p_feature:\s*["']([\w-]+)["']/g, src, written)
  }
  return { checked, written }
}

describe("a quota that counts usage_events has something that writes them", () => {
  it("finds the call sites at all — the population is not empty", () => {
    // ⚠ The control that gives every case below meaning. A broken walk, a
    // renamed helper or a stripper that blanked the files would leave both sets
    // empty, and an empty population satisfies "every checked feature has a
    // writer" vacuously. Pinned as NAMES, not a count, so adding a feature does
    // not force an edit here.
    const { checked, written } = scan()
    expect([...checked].sort()).toContain("concierge_messages")
    expect([...checked].sort()).toContain("saved_wallets_max")
    expect([...checked].sort()).toContain("mcp_query")
    expect([...written]).toContain("concierge_messages")
  })

  it("every event-counted feature that is CHECKED is also WRITTEN", () => {
    const { checked, written } = scan()
    const orphans = [...checked].filter((f) => !written.has(f) && !(f in SUPPRESSED)).sort()
    expect(
      orphans,
      "these features gate a request on `allowed`/`used_today` but nothing writes a usage_events row " +
        "for them, so used_today is pinned at 0 and the cap can never fire. Either write the row where " +
        "the feature is served, or add it to SUPPRESSED with the reason it is not event-counted.",
    ).toEqual([])
  })

  it("a suppression is removed when it stops being true — the list cannot rot", () => {
    // ⚠ Two-way, like RAW_FMV_DESC_ALLOWLIST. A suppression that silently
    // becomes unnecessary is how a curated list turns into a permanent hole:
    // once the Worker ships its `mcp_query` write, this case goes RED and forces
    // the entry out, which is the only thing that will make anyone delete it.
    const { checked, written } = scan()
    for (const [feature, reason] of Object.entries(SUPPRESSED)) {
      expect(
        checked.has(feature),
        `${feature} is suppressed but nothing checks it any more — delete the entry (${reason})`,
      ).toBe(true)
      expect(
        written.has(feature),
        `${feature} now HAS a writer, so the suppression is stale — delete it and let the property hold (${reason})`,
      ).toBe(false)
    }
  })

  it("the stripper did not blank the files the population was read from", () => {
    // The canary for the recorded blind-strip failures. Checked on the files
    // that actually carry call sites, because those are the ones whose silence
    // would be read as "no quota checks here".
    // ⚠ Normalised to forward slashes before the regex: `path.join` emits
    // backslashes on Windows, so `support-chat\/route\.ts$` matched 1 of 3 on
    // Trevor's box (2026-09-03) while CI (Linux) was green.
    const carriers = SOURCES.filter((abs) =>
      /pro-tier\.ts$|support-chat\/route\.ts$|rpc-mcp-proxy\/index\.ts$/.test(abs.replace(/\\/g, "/")),
    )
    expect(carriers.length, "the three known call-site files were not found by the walk").toBe(3)
    for (const abs of carriers) {
      const raw = readFileSync(abs, "utf8")
      const stripped = stripComments(raw)
      expect(
        stripped.length / raw.length,
        `${path.relative(ROOT, abs)} lost most of its bytes to the stripper — a blanked file has no call sites and passes silently`,
      ).toBeGreaterThan(0.3)
    }
  })

  it("the MCP logger writes BOTH keys — the suppression's justification, pinned against the DDL", () => {
    // ⚠ The suppression above claims `mcp_query` IS written, just not from
    // TypeScript. A claim in a comment is worth nothing, so it is asserted here
    // against the migration that is actually live: the logger must still compose
    // the per-tool key (`'mcp_' || p_tool_name`, the breakdown
    // `v_mcp_usage_today` groups on) AND write the literal `'mcp_query'` the
    // quota counts. If a later change drops the second insert, this reds — and so
    // does `supabase/tests/mcp_log_tool_call.sql`, which asserts the behaviour
    // rather than the text.
    const ddl = readFileSync(
      path.join(
        ROOT,
        "supabase/migrations/20260903164254_audit_20260903_mcp_log_tool_call_writes_the_quota_key.sql",
      ),
      "utf8",
    )
    expect(ddl).toMatch(/'mcp_'\s*\|\|\s*p_tool_name/)
    // ⚠ Scoped to the FUNCTION BODY, not the file. The same migration seeds
    // `feature_quotas` rows keyed `'mcp_query'` — that is quota CONFIG, and a
    // file-wide `includes` reads those as proof the logger writes the key, which
    // is the exact confusion this whole test exists to pin. The claim is about
    // what lands in `usage_events`, so it has to be asserted where that INSERT is.
    // ⚠ Scoped to the FUNCTION BODY, not the file. A file-wide `includes` would
    // also match the `feature_quotas` seed rows keyed `'mcp_query'` in the 2026-05
    // migration — that is quota CONFIG, and reading it as proof the logger writes
    // the key is the exact confusion this whole test exists to pin. The claim is
    // about what lands in `usage_events`, so it has to be asserted where the
    // INSERT is. (That mistake was made once while writing this file.)
    const start = ddl.indexOf("FUNCTION public.mcp_log_tool_call")
    expect(start, "mcp_log_tool_call is no longer defined in this migration").toBeGreaterThan(-1)
    const body = ddl.slice(start, ddl.indexOf("$function$;", start))
    const inserts = body.match(/insert into public\.usage_events/g) ?? []
    expect(inserts.length, "the logger must write BOTH the per-tool row and the quota row").toBe(2)
    expect(body, "the per-tool breakdown key is still composed from the tool name").toMatch(
      /'mcp_'\s*\|\|\s*p_tool_name/,
    )
    expect(
      body.includes("'mcp_query'"),
      "the logger no longer writes the key the quota counts — used_today goes back to being pinned at 0 " +
        "and the cap stops firing for every plan",
    ).toBe(true)
  })
})
