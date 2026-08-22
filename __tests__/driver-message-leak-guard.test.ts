import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// `scripts/check-driver-message-leaks.mjs` guards the defect lib/api-error.ts was
// written for: /api/sets caught its error, pulled `err.message`, and returned it to
// the browser, so under the disk-IO band the flagship Set Tracker showed anonymous
// visitors "canceling statement due to statement timeout". The helper existed; the
// discipline of reaching for it did not hold — 73 sites across 57 route files.
//
// ⚠ WHAT MAKES THIS GUARD DIFFERENT FROM A BAN ON THE EXPRESSION, and what these
// tests exist to pin: most of those 73 are CORRECT. Operator surface reached with a
// secret is not browser-reachable, so a driver message there is diagnostic. The
// guard therefore excludes GATED handlers — and the exclusion is PER HANDLER.
// CLAUDE.md records the file-level version of this as a live mistake ("a gated POST
// vouched for the ungated GET beside it"), and it was 4 real handlers here.

const SCRIPT = path.resolve(__dirname, "../scripts/check-driver-message-leaks.mjs")
const REPO = path.resolve(__dirname, "..")

function run(root: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { code: 0, out }
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

/** Build a fixture route tree: { "sub/route.ts": "<source>" }. */
function fixture(routes: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "leakguard-"))
  for (const [rel, body] of Object.entries(routes)) {
    const full = path.join(dir, "app/api", rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

const LEAKY = `return NextResponse.json({ error: err.message }, { status: 500 })`
const GATED = `if (req.headers.get("authorization") !== \`Bearer \${process.env.INGEST_SECRET_TOKEN}\`) return new Response("no", { status: 401 })`

describe("driver-message leak guard — detection", () => {
  it("FAILS on an ungated handler that returns a raw driver message", () => {
    const dir = fixture({
      "x/route.ts": `export async function GET() {\n  ${LEAKY}\n}\n`,
      // a gated sibling file keeps the positive control non-zero
      "y/route.ts": `export async function POST(req) {\n  ${GATED}\n  ${LEAKY}\n}\n`,
    })
    const { code, out } = run(dir)
    expect(code).toBe(1)
    expect(out).toContain("x/route.ts")
  })

  it("PASSES when the only leaks are inside gated handlers", () => {
    const dir = fixture({
      "y/route.ts": `export async function POST(req) {\n  ${GATED}\n  ${LEAKY}\n}\n`,
    })
    expect(run(dir).code).toBe(0)
  })
})

describe("driver-message leak guard — the exclusion is PER HANDLER", () => {
  // ⚠ THE WHOLE REASON THIS GUARD IS HANDLER-SCOPED. A file-level auth grep sees
  // INGEST_SECRET_TOKEN in this file and calls it clean; the GET is wide open.
  // Four real handlers had exactly this shape when the guard was written.
  it("FAILS on an ungated GET even when the POST in the SAME FILE is gated", () => {
    const dir = fixture({
      "mixed/route.ts":
        `export async function GET() {\n  ${LEAKY}\n}\n\n` +
        `export async function POST(req) {\n  ${GATED}\n  ${LEAKY}\n}\n`,
    })
    const { code, out } = run(dir)
    expect(code).toBe(1)
    expect(out).toContain("GET")
    expect(out).toContain("mixed/route.ts")
  })

  it("PASSES when the gate is in the module PREAMBLE, which covers every handler", () => {
    const dir = fixture({
      "pre/route.ts":
        `const TOKEN = process.env.INGEST_SECRET_TOKEN\n\n` +
        `export async function GET() {\n  ${LEAKY}\n}\n` +
        `export async function POST(req) {\n  ${LEAKY}\n}\n`,
    })
    expect(run(dir).code).toBe(0)
  })
})

describe("driver-message leak guard — must not red on correct code", () => {
  it("ignores a handler that uses apiErrorResponse", () => {
    const dir = fixture({
      "ok/route.ts": `export async function GET() {\n  return apiErrorResponse(err, "tag")\n}\n`,
      "y/route.ts": `export async function POST(req) {\n  ${GATED}\n  ${LEAKY}\n}\n`,
    })
    expect(run(dir).code).toBe(0)
  })

  it("ignores a message that is only LOGGED, never returned", () => {
    const dir = fixture({
      "log/route.ts":
        `export async function GET() {\n  console.error(err.message)\n  return apiErrorResponse(err, "t")\n}\n`,
      "y/route.ts": `export async function POST(req) {\n  ${GATED}\n  ${LEAKY}\n}\n`,
    })
    expect(run(dir).code).toBe(0)
  })
})

describe("driver-message leak guard — it cannot pass by inspecting nothing", () => {
  it("FAILS rather than passes when there are no handlers at all", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "leakguard-empty-"))
    const { code, out } = run(dir)
    expect(code).toBe(1)
    expect(out.toLowerCase()).toContain("nothing")
  })
})

describe("driver-message leak guard — it is actually RUN, and the live tree is clean", () => {
  it("is wired into ci.yml as a blocking step", () => {
    const ci = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8")
    expect(ci).toContain("scripts/check-driver-message-leaks.mjs")
  })

  it("the LIVE app/api tree has zero ungated leaks — a ban at population zero", () => {
    let code = 0
    try {
      execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", cwd: REPO, stdio: ["ignore", "pipe", "pipe"] })
    } catch (e: any) {
      code = e.status ?? 1
    }
    expect(code).toBe(0)
  })
})
