// __tests__/helpers/admin-req.ts
// Shared fake-request builder for the /api/admin/* route integration tests.
// Not a *.test.ts file, so vitest's include glob never runs it as a suite.
//
// Mirrors ONLY the surface the admin routes touch on a NextRequest:
//   - req.headers.get("authorization")   (verifyAdminRequest / custom bearer checks)
//   - req.nextUrl.searchParams            (verifyAdminRequest ?token= + query params)
//   - req.url                             (new URL(req.url).origin in after() paths)
//   - req.json()                          (POST body parsing)
// Everything the routes read fails-closed against a missing Authorization header.

export function adminReq(
  url: string,
  opts: { authorization?: string; body?: unknown; noBody?: boolean } = {}
): any {
  return {
    url,
    method: "POST",
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "authorization" ? opts.authorization ?? null : null,
    },
    nextUrl: new URL(url),
    json: async () => {
      if (opts.noBody) throw new Error("invalid json")
      return opts.body ?? {}
    },
  }
}
