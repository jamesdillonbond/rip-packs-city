import { describe, it, expect } from "vitest"

// GET /.well-known/security.txt (app/.well-known/security.txt/route.ts) — the
// RFC 9116 disclosure file. Asserts the BYTES a scanner parses, not a status:
// a 200 carrying an HTML login page (what the proxy serves for a gated path)
// would pass a status check and read as "no security.txt" to every tool.
//
// The route's `Expires` is derived at request time (+1 year) because it is the
// one field that goes stale on its own; the test pins that it is a parseable
// ISO timestamp in the future, not a literal that someone forgets.

import { GET } from "@/app/.well-known/security.txt/route"

describe("GET /.well-known/security.txt", () => {
  it("serves a plain-text RFC 9116 file with Contact, a future Expires and a Canonical", async () => {
    const res = GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/plain")
    const body = await res.text()
    const lines = body.trimEnd().split("\n")
    const field = (name: string) => lines.find((l) => l.startsWith(name + ": "))?.slice(name.length + 2)

    expect(field("Contact")).toMatch(/^https:\/\//)
    expect(field("Canonical")).toBe("https://www.rippackscity.com/.well-known/security.txt")
    expect(field("Preferred-Languages")).toBe("en")

    const expires = field("Expires")!
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    const msAhead = new Date(expires).getTime() - Date.now()
    expect(msAhead).toBeGreaterThan(300 * 24 * 3600 * 1000)
    expect(msAhead).toBeLessThan(400 * 24 * 3600 * 1000)

    // No HTML, no BOM, every line is a `Field: value` or blank — what a parser expects.
    expect(body).not.toMatch(/<!doctype|<html/i)
    for (const l of lines) expect(l, l).toMatch(/^[A-Za-z-]+: \S/)
  })
})
