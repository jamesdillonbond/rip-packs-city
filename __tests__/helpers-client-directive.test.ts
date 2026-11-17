// __tests__/helpers-client-directive.test.ts
//
// Guards the guard. `isClientSource` decides the POPULATION of three ratchets,
// so a defect here is invisible in exactly the way the bug it replaces was:
// the ratchets keep passing while pages sit outside them.

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { isClientSource } from "./helpers/client-directive"

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8")

const APP_DIR = path.join(process.cwd(), "app")

/** The pattern the four broken guards used, kept only to prove the fix matters. */
const PREFIX_SCAN = /^\s*["']use client["']/

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) tsxFiles(full, out)
    else if (entry.endsWith(".tsx")) out.push(full)
  }
  return out
}

/**
 * An INDEPENDENT second opinion on "is this a client module?", written
 * line-by-line rather than by scanning character indices, so it does not share
 * an implementation with `isClientSource`. Returns the verdict for the first
 * line that survives comment stripping — the directive must be the first
 * statement, so anything else there means this is not a client module.
 */
function isClientByLineScan(src: string): boolean {
  let inBlock = false
  // ⚠ SPLIT ON /\r?\n/, NOT ON "\n". JavaScript's `.` does not match \r, so on a
  // CRLF checkout `/\/\/.*$/` fails to match a line comment — the `.*` stops
  // before the \r and `$` cannot match — and the strip silently no-ops. The scan
  // then returns its verdict off the HEADER COMMENT and reads every commented
  // file as a server module. Measured here 2026-08-23: the control disagreed
  // with the detector on app/global-error.tsx for exactly this reason, on a file
  // byte-identical to the LF copy apart from its line endings. A double-entry
  // control that a line ending can flip is not a second opinion.
  for (const raw of src.split(/\r?\n/)) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf("*/")
      if (end === -1) continue
      line = line.slice(end + 2)
      inBlock = false
    }
    line = line.replace(/\/\*.*?\*\//g, "")
    const open = line.indexOf("/*")
    if (open !== -1) {
      inBlock = true
      line = line.slice(0, open)
    }
    line = line.replace(/\/\/.*$/, "").trim()
    if (!line) continue
    return /^(["'])use client\1\s*;?$/.test(line)
  }
  return false
}

describe("isClientSource", () => {
  it("finds the directive at the very top", () => {
    expect(isClientSource('"use client"\n\nimport x from "y"')).toBe(true)
    expect(isClientSource("'use client';\nimport x from 'y'")).toBe(true)
  })

  it("finds it behind a long header comment — the bug this replaces", () => {
    // The old checks read a 200/300-char prefix with an anchored pattern, so
    // any header comment pushed the directive out of view.
    const header = "// " + "x".repeat(900) + "\n"
    expect(isClientSource(header + '"use client"\nimport a from "b"')).toBe(true)
    expect(isClientSource("/*\n" + " * y\n".repeat(200) + " */\n'use client'\n")).toBe(true)
  })

  it("does NOT match a comment that merely mentions the directive", () => {
    // The `.includes()` spelling got this wrong, and it fails in the direction
    // that invents work: a server page counted into a client-page ratchet.
    const src = '// this page is deliberately NOT "use client" — it is a server page\n' +
      'import { supabaseAdmin } from "@/lib/supabase"\nexport default async function P() {}'
    expect(isClientSource(src)).toBe(false)
  })

  it("does NOT match the directive appearing after real code", () => {
    // Only the FIRST statement is a directive; later occurrences are strings.
    expect(isClientSource('import a from "b"\n"use client"\n')).toBe(false)
  })

  it("returns false for an ordinary server page and for an unterminated comment", () => {
    expect(isClientSource('import { x } from "y"\nexport default async function P() {}')).toBe(false)
    expect(isClientSource("/* never closed\n'use client'")).toBe(false)
  })

  it("agrees with an independent line scan across the whole app tree", () => {
    // ⚠ DERIVED BY WALKING, NOT NAMED — and the reason is that the previous
    // version of this case NAMED its three instances (`app/login/page.tsx`,
    // `app/early-access/page.tsx`, `app/auth/confirm/page.tsx`) and was killed
    // by ENOENT the moment those three pages were converted into `*Client.tsx`.
    // That is the canary-that-dies-on-its-own-success mistake the client-page
    // ratchet already made and had corrected, recurring here because a list of
    // real paths does not LOOK like a canary the way `pages.length > 10` does.
    //
    // Walking is strictly stronger than three names: it is satisfiable at a
    // population of ZERO, it survives any rename, and it covers EVERY file
    // rather than the three that happened to be measured on one afternoon.
    const files = tsxFiles(APP_DIR)
    expect(files.length, "the walk must find real .tsx files at all").toBeGreaterThan(100)

    const hiddenFromPrefixScan: string[] = []
    for (const file of files) {
      const src = readFileSync(file, "utf8")
      const rel = path.relative(process.cwd(), file).split(path.sep).join("/")
      // Double entry: two structurally different implementations (char-index
      // scan vs. line scan) must reach the same verdict on every real file.
      expect(isClientSource(src), `${rel}: detector disagrees with the line scan`).toBe(
        isClientByLineScan(src),
      )
      if (isClientByLineScan(src) && !PREFIX_SCAN.test(src.slice(0, 200))) {
        hiddenFromPrefixScan.push(rel)
      }
    }

    // Reported, never asserted non-empty. Every one of these would have been
    // MISCLASSIFIED by the old prefix scan, so the list is the live evidence
    // that the fix still matters — but requiring it to be non-empty would
    // re-create the canary: a repo that legitimately moved every directive to
    // char 0 must not fail this. The synthetic 900-char-header case above is
    // what pins the property unconditionally.
    expect(Array.isArray(hiddenFromPrefixScan)).toBe(true)
  })

  it("the line-scan oracle is a real second opinion, not a copy of the detector", () => {
    // Guards the guard. If the oracle shared the detector's bug the agreement
    // check above would be vacuous, so pin that the oracle independently gets
    // the two cases the old prefix scan got wrong — in OPPOSITE directions.
    const header = "// " + "x".repeat(900) + "\n"
    // (a) a directive behind a long header: oracle says client, prefix scan does not.
    expect(isClientByLineScan(header + '"use client"\nimport a from "b"')).toBe(true)
    expect(PREFIX_SCAN.test((header + '"use client"').slice(0, 200))).toBe(false)
    // (b) a comment merely mentioning it: oracle says server, `.includes` would not.
    expect(isClientByLineScan('// deliberately not "use client"\nimport a from "b"')).toBe(false)
    expect((header + '"use client"').includes("use client")).toBe(true)
  })

  it("classifies a known server page as not-client", () => {
    expect(isClientSource(read("app/insights/deals/page.tsx"))).toBe(false)
  })
})
