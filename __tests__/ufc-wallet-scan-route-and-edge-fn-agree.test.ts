// /api/ufc-wallet-scan calls the scan-ufc-wallet edge function as GET ?wallet=…, but the function
// read the wallet ONLY from a JSON body, so every binder scan got "Missing wallet" (400) and the
// route answered 502 (found 2026-11-16; its metadata script also no longer type-checked). Each side
// was tested alone and both were green. This pins the CONTRACT between them.
import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"

const route = readFileSync("app/api/ufc-wallet-scan/route.ts", "utf8")
const scanFn = readFileSync("supabase/functions/scan-ufc-wallet/index.ts", "utf8")
const enrichFn = readFileSync("supabase/functions/enrich-ufc-wallet/index.ts", "utf8")

describe("UFC wallet scan: the route and the edge functions agree on where the wallet goes", () => {
  it("the route passes the wallet as a query parameter to both functions", () => {
    expect(route).toMatch(/scan-ufc-wallet\?wallet=\$\{encodeURIComponent\(wallet\)\}/)
    expect(route).toMatch(/enrich-ufc-wallet\?wallet=\$\{encodeURIComponent\(wallet\)\}/)
  })

  it("both functions read the wallet from the query string", () => {
    expect(scanFn).toMatch(/url\.searchParams\.get\("wallet"\)/)
    expect(enrichFn).toMatch(/url\.searchParams\.get\("wallet"\)/)
  })

  it("the route never puts the shared ingest token in a URL", () => {
    const urls = [...route.matchAll(/const url = `([^`]+)`/g)].map((m) => m[1])
    expect(urls.length).toBe(2)
    for (const u of urls) expect(u).not.toMatch(/[?&]token=/)
    expect(route).toMatch(/Authorization: `Bearer \$\{TOKEN\}`/)
  })
})
