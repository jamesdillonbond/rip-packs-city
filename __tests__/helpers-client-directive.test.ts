// __tests__/helpers-client-directive.test.ts
//
// Guards the guard. `isClientSource` decides the POPULATION of three ratchets,
// so a defect here is invisible in exactly the way the bug it replaces was:
// the ratchets keep passing while pages sit outside them.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { isClientSource } from "./helpers/client-directive"

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8")

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

  it("classifies the three pages the old 200-char slice hid", () => {
    // These are the measured instances. If a future refactor moves their
    // directives to the top this stays green; if the detector regresses to a
    // prefix scan, it reds — which is the point.
    for (const rel of [
      "app/login/page.tsx",
      "app/early-access/page.tsx",
      "app/auth/confirm/page.tsx",
    ]) {
      const src = read(rel)
      expect(isClientSource(src), `${rel} is a client page`).toBe(true)
      // Not vacuous: prove the directive really is beyond the old 200-char
      // window, so this case would have failed under the previous detector.
      expect(
        /^\s*["']use client["']/.test(src.slice(0, 200)),
        `${rel} directive should sit past the old slice`
      ).toBe(false)
    }
  })

  it("classifies a known server page as not-client", () => {
    expect(isClientSource(read("app/insights/deals/page.tsx"))).toBe(false)
  })
})
