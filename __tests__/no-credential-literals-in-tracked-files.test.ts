import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"

// ─────────────────────────────────────────────────────────────────────────────
// NO LIVE CREDENTIAL LITERAL IN ANY TRACKED FILE — docs/, scripts, workflows,
// fixtures and code alike.
//
// This repo is PUBLIC, and both of its credential incidents were in files no
// guard read:
//   * D2 — `rpc_pls_…` cron gate keys hardcoded in eight edge functions were
//     "mirrored into ~9 committed docs". `edge-fn-no-hardcoded-gate-keys` was
//     written for it and walks `supabase/functions/*/index.ts` ONLY, so the
//     docs half — the larger half — sat outside it BY CONSTRUCTION.
//   * #22 — a live `github_pat_…` reached the history (the 2026-08-03
//     filter-repo; residue still open). No guard anywhere matched a GitHub token.
// Until this file, NOTHING in CI scanned the tracked tree for a credential
// shape: no gitleaks, no trufflehog, no CodeQL, no test (measured 2026-10-02).
//
// ⭐ BAN AT ZERO, MEASURED 2026-10-02: 7,067 tracked text files, 0 hits for
// every pattern below. So any hit is a new leak, never debt.
//
// ⛔ THE REPORT NEVER CONTAINS THE MATCH. A CI log is as public as the repo; a
// guard that echoes the token it found is a second leak channel. Offenders are
// reported as `file:line pattern len=N` and the planted-defect cases below
// assert the secret text is absent from that report.
//
// ⚠ WHAT IT IS STRUCTURALLY SILENT ABOUT — know this before trusting a pass:
//   * A credential with no distinctive PREFIX. The Flow hot-wallet private key
//     is 64 hex characters, the same shape as every tx hash and sha256 in the
//     tree (78 such strings 2026-10-02), and Vercel / Resend / QuickNode keys
//     carry no reliable prefix. Not attempted — a pattern that fires on every
//     tx hash is permanently red and therefore unread.
//   * History. This reads the CHECKED-OUT tree; a key added and removed in one
//     push lands in history and passes here. Rotation is the only fix for that.
//   * Untracked and ignored files (`.env.local` and friends) — by design.
//
// ⚠ A placeholder (`rpc_pls_…`, `github_pat_<redacted>`) does not match: every
// pattern demands a run of real token characters long enough to be a key.
// ─────────────────────────────────────────────────────────────────────────────

type Pattern = { name: string; re: RegExp }

/** High-confidence credential shapes only — each is a vendor-assigned prefix. */
const PATTERNS: Pattern[] = [
  { name: "github-fine-grained-pat", re: /github_pat_[A-Za-z0-9_]{40,}/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-project-key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
  { name: "rpc-gate-key", re: /\brpc_pls_[A-Za-z0-9_]{8,}/g },
  { name: "supabase-secret-key", re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g },
  { name: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "stripe-live-key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g },
  { name: "telegram-bot-token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { name: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  // A Supabase service-role key is a JWT. Zero JWTs of ANY role are committed
  // (2026-10-02), so all are banned: even the public anon key belongs in env,
  // and a committed one needs a SUPPRESSIONS entry that says so.
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
]

/**
 * `file|pattern` → why the literal is not a credential. Empty on purpose: the
 * tree is clean. ⛔ A suppression is a claim that the GUARD is wrong about this
 * file — never use it to keep a real key "for now". Rotate, then delete it.
 */
const SUPPRESSIONS: Record<string, string> = {}

/** Files larger than this are generated data, not prose or code. */
const MAX_BYTES = 8 * 1024 * 1024

interface Hit {
  file: string
  line: number
  pattern: string
  length: number
}

function scanText(file: string, text: string): Hit[] {
  const hits: Hit[] = []
  for (const { name, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (SUPPRESSIONS[`${file}|${name}`]) continue
      const line = text.slice(0, m.index).split("\n").length
      hits.push({ file, line, pattern: name, length: m[0].length })
    }
  }
  return hits
}

/** Location only — the matched text never leaves scanText. */
function report(hits: Hit[]): string[] {
  return hits.map((h) => `${h.file}:${h.line} ${h.pattern} len=${h.length}`)
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter(Boolean)
}

describe("no credential literal in any tracked file", () => {
  const files = trackedFiles()
  let scanned = 0
  let scannedUnderDocs = 0
  const hits: Hit[] = []
  for (const file of files) {
    let buf: Buffer
    try {
      if (statSync(file).size > MAX_BYTES) continue
      buf = readFileSync(file)
    } catch {
      continue // deleted in the working tree but still in the index
    }
    if (buf.includes(0)) continue // binary
    scanned++
    if (file.startsWith("docs/")) scannedUnderDocs++
    hits.push(...scanText(file, buf.toString("utf8")))
  }

  it("inspects the whole tree, docs/ included (a sweep that reads nothing passes vacuously)", () => {
    // 7,067 text files and ~2,900 of them under docs/ on 2026-10-02. Floors,
    // not pins: they only have to prove the walk reached the tree.
    expect(files.length).toBeGreaterThan(3000)
    expect(scanned).toBeGreaterThan(3000)
    expect(scannedUnderDocs).toBeGreaterThan(500)
  })

  it("finds no credential-shaped literal", () => {
    expect(report(hits)).toEqual([])
  })

  it("has no stale suppression (each must still name a tracked file)", () => {
    const tracked = new Set(files)
    const stale = Object.keys(SUPPRESSIONS).filter((k) => !tracked.has(k.split("|")[0]))
    expect(stale).toEqual([])
  })
})

describe("the scanner fires on each pattern and never echoes the secret (planted defects)", () => {
  // Built at runtime so this file holds no credential-shaped literal itself —
  // otherwise it would trip the tree scan above and GitHub push protection.
  const run = (n: number, alphabet = "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z") =>
    Array.from({ length: n }, (_, i) => alphabet[(i * 7) % alphabet.length]).join("")
  const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")

  const PLANTS: Record<string, string> = {
    "github-fine-grained-pat": "github_" + "pat_" + run(82),
    "github-token": "gh" + "p_" + run(36),
    "anthropic-key": "sk-" + "ant-api03-" + run(40),
    "openai-project-key": "sk-" + "proj-" + run(40),
    "rpc-gate-key": "rpc_" + "pls_" + run(24),
    "supabase-secret-key": "sb_" + "secret_" + run(32),
    "aws-access-key-id": "AKIA" + run(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
    "stripe-live-key": "sk_" + "live_" + run(24),
    "slack-token": "xo" + "xb-" + run(30),
    "telegram-bot-token": "123456789:" + "AA" + run(33),
    "private-key-block": "-----BEGIN " + "PRIVATE KEY-----",
    jwt: [b64url({ alg: "HS256", typ: "JWT" }), b64url({ role: "service_role", iss: "supabase" }), run(43)].join("."),
  }

  it("has one plant per pattern (a new pattern without a plant is unproven)", () => {
    expect(Object.keys(PLANTS).sort()).toEqual(PATTERNS.map((p) => p.name).sort())
  })

  for (const [name, secret] of Object.entries(PLANTS)) {
    it(`catches ${name} in prose, and the report omits the secret`, () => {
      const text = `# runbook\n\nexport TOKEN="${secret}" # pasted by mistake\n`
      const hits = scanText("docs/plant.md", text)
      expect(hits.map((h) => h.pattern)).toContain(name)
      expect(hits.find((h) => h.pattern === name)?.line).toBe(3)
      const out = report(hits).join("\n")
      expect(out).not.toContain(secret)
      // Not even a recognisable fragment of the token body.
      expect(out).not.toContain(secret.slice(-12))
    })
  }

  it("does not fire on the redacted placeholders the docs use", () => {
    const text = [
      "the gate key (`rpc_pls_…`) was rotated",
      "GITHUB_TOKEN=github_pat_<redacted>",
      "ANTHROPIC_API_KEY=sk-ant-...",
      "sb_secret_xxx in the dashboard",
      "a 64-hex tx hash " + "ab".repeat(32),
    ].join("\n")
    expect(scanText("docs/placeholders.md", text)).toEqual([])
  })
})
