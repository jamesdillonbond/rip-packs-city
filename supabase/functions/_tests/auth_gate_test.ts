// ─────────────────────────────────────────────────────────────────────────────
// EVERY EDGE FUNCTION REFUSES A CALLER WITHOUT A CREDENTIAL, AND DOES NO WORK
// BEFORE IT REFUSES.
//
// Why this is the property worth a Deno test run of its own:
//   * Every function is deployed `--no-verify-jwt` (edge-fn-deploy.yml asserts
//     it from production), and on 2026-10-02 all 43 in this tree read
//     verify_jwt=false live. So the platform checks NOTHING: anyone who knows
//     a function's URL can call it, and its own first lines are the only gate
//     in front of a service-role client.
//   * Until this file, CI ran `deno check` and `deno lint` on these functions
//     and EXECUTED none of them (edge-functions-have-reachable-tests-ratchet's
//     header: "There is NO Deno test run"). vitest cannot import them. The
//     gate-key tests read SOURCE TEXT (edge-fn-no-hardcoded-gate-keys), which
//     cannot tell a check that runs first from one that runs after a write.
//
// How: harness.ts imports each index.ts with Deno.serve, std's serve(), fetch
// and supabase-js replaced by recorders (deno.json here remaps the imports, so
// no network is touched), gives every env var it reads a value, and sends three
// anonymous requests. Each must answer 4xx and record no database call and no
// fetch. Reading the caller's token (`.auth.*`) or a Vault gate key
// (`rpc(cron_gate_key)`) IS the gate and is not counted as work.
//
// ⭐ MEASURED 2026-10-02 BEFORE THIS WAS WRITTEN: 43/43 functions refuse all
// three probes with zero work (401 / 403; 405 for a GET where only POST is
// served; 410 from the retired sync-nba-games). So this is a ban at zero, and a
// red row is a new function, or a change, that does work for anonymous callers.
//
// ⚠ WHAT IT IS STRUCTURALLY SILENT ABOUT:
//   * That a VALID caller is admitted. Gates differ per function (Bearer
//     INGEST_SECRET_TOKEN, ?key=, Vault keys, dual keys mid-rotation), and the
//     admit path is already proven where it matters, by pipeline_runs rows from
//     the real cron callers.
//   * Work done at MODULE LOAD, before any request. It is recorded but belongs
//     to cold start, not to a caller; the controls show none happens today.
//   * The deployed copy. This runs the repo's source; edge-fn-drift owns
//     repo-versus-deployed.
//   * The 20 deployed functions with no source in the repo (R21's residue).
// ─────────────────────────────────────────────────────────────────────────────
import { anonymousRequests, FN_ROOT, functionNames, install, load, probe, refused } from "./harness.ts"

const names = functionNames()
const FIXTURES = new URL("./fixtures/", import.meta.url)
install([
  ...names.map((n) => new URL(`${n}/index.ts`, FN_ROOT)),
  new URL("gated.ts", FIXTURES),
  new URL("ungated.ts", FIXTURES),
])

// Module load can start timers (a background flush, a keep-alive) that are not
// this test's to own, so op/resource sanitizers are off.
const opts = { sanitizeOps: false, sanitizeResources: false }

Deno.test({
  name: "the sweep finds the whole fleet (a walk that finds nothing passes vacuously)",
  ...opts,
  fn() {
    // 43 on 2026-10-02. A floor, not a pin.
    if (names.length < 35) throw new Error(`found only ${names.length} functions under ${FN_ROOT.pathname}`)
  },
})

Deno.test({
  name: "positive control: a handler that works without checking its caller is flagged",
  ...opts,
  async fn() {
    const h = await load(new URL("ungated.ts", FIXTURES))
    for (const [label, req] of anonymousRequests("fixture-ungated")) {
      const p = await probe(h, label, req)
      if (refused(p)) throw new Error(`the harness passed an UNGATED handler on "${label}" — the recorders are blind`)
      const kinds = new Set(p.work.map((w) => w.kind))
      if (!kinds.has("db") || !kinds.has("fetch")) {
        throw new Error(`expected both a db call and a fetch recorded on "${label}", got ${JSON.stringify(p.work)}`)
      }
    }
  },
})

Deno.test({
  name: "negative control: a handler that refuses first passes",
  ...opts,
  async fn() {
    const h = await load(new URL("gated.ts", FIXTURES))
    for (const [label, req] of anonymousRequests("fixture-gated")) {
      const p = await probe(h, label, req)
      if (!refused(p)) throw new Error(`a correctly gated handler failed "${label}": ${JSON.stringify(p)}`)
    }
  },
})

for (const name of names) {
  Deno.test({
    name: `${name}: refuses anonymous callers before doing any work`,
    ...opts,
    async fn() {
      const h = await load(new URL(`${name}/index.ts`, FN_ROOT))
      const failures: string[] = []
      for (const [label, req] of anonymousRequests(name)) {
        const p = await probe(h, label, req)
        if (!refused(p)) {
          const work = p.work.slice(0, 3).map((w) => `${w.kind}:${w.what}`).join(", ")
          failures.push(`${label} → ${p.status}${work ? ` after ${work}` : ""}`)
        }
      }
      if (failures.length) {
        throw new Error(
          `${name} answered an anonymous caller without refusing first. Its URL is public ` +
            `(verify_jwt=false), so this is reachable by anyone:\n  ${failures.join("\n  ")}`,
        )
      }
    },
  })
}
