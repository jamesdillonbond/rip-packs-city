// Shared fake-NextRequest builder for the cron route-integration tests.
// It exposes the union of request accessors the cron handlers actually touch:
//   - req.headers.get("authorization") / ("x-ingest-token")
//   - req.nextUrl.searchParams  (URL)
//   - req.url                   (string, for `new URL(req.url)` handlers)
//   - req.method
//   - req.json()                (POST body; can be made to throw for bad-json paths)
// Not imported by vitest as a test (filename lacks `.test.ts`).

export interface MakeReqOpts {
  url?: string
  method?: string
  auth?: string
  xIngest?: string
  token?: string
  body?: any
  badJson?: boolean
}

export function makeReq(opts: MakeReqOpts = {}): any {
  const base = opts.url ?? "https://t/api/cron/x"
  const withToken = opts.token
    ? base + (base.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(opts.token)
    : base
  const u = new URL(withToken)
  const headers = new Headers()
  if (opts.auth) headers.set("authorization", opts.auth)
  if (opts.xIngest) headers.set("x-ingest-token", opts.xIngest)
  return {
    method: opts.method ?? "POST",
    url: u.toString(),
    nextUrl: u,
    headers,
    json: async () => {
      if (opts.badJson) throw new Error("bad json")
      return opts.body ?? {}
    },
  }
}
