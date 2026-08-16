import { describe, it, expect } from "vitest"
import {
  ADMIN_ERROR_BODY_CHARS,
  ADMIN_TOKEN_KEY,
  classifyAdminResponse,
} from "@/lib/admin/use-admin-resource"

// The pure half of the admin shell that seven `app/admin/*/page.tsx` pages each carried a
// byte-identical copy of. These three branches decide what an operator is TOLD when an
// admin route fails, and an operator acting on a wrong signal is how this repo's own
// incident log says false conclusions get drawn about the platform.

const res = (over: Partial<{ ok: boolean; status: number; text: string; json: unknown }>) => ({
  ok: over.ok ?? true,
  status: over.status ?? 200,
  text: async () => over.text ?? "",
  json: async () => over.json ?? {},
})

describe("classifyAdminResponse", () => {
  it("returns the parsed payload on success", async () => {
    const out = await classifyAdminResponse<{ rows: number[] }>(res({ json: { rows: [1, 2] } }))
    expect(out).toEqual({ kind: "ok", data: { rows: [1, 2] } })
  })

  // ⚠ 401 is a SEPARATE kind from any other failure, and the difference is what the caller
  // must DO, not the wording. A 401 means the stored credential is wrong and has to be
  // discarded; every other failure means the credential is fine and the route is not.
  // Collapsing them either strands an operator holding a dead token, or throws away a good
  // token every time the route hiccups.
  it("classifies 401 as unauthorized, with copy that tells the operator what to do", async () => {
    const out = await classifyAdminResponse(res({ ok: false, status: 401, text: "nope" }))
    expect(out.kind).toBe("unauthorized")
    expect(out).toMatchObject({ message: expect.stringMatching(/re-enter/i) })
  })

  it("does NOT read the body on a 401 — the message is fixed, not the route's", async () => {
    let read = false
    const out = await classifyAdminResponse({
      ok: false,
      status: 401,
      text: async () => {
        read = true
        return "Bearer token rejected by upstream"
      },
      json: async () => ({}),
    })
    expect(out.kind).toBe("unauthorized")
    expect(read).toBe(false)
  })

  // ⚠ The body echo is DELIBERATE and must stay. It is the driver-message leak banned
  // everywhere else in this codebase, and CLAUDE.md's own rule carves out exactly this
  // case: the only routes where a driver message is acceptable are ones gated on a shared
  // OPERATOR SECRET, where the reader is holding the token. It is the sole diagnostic these
  // pages have. Hardening it into "Something went wrong" would be a regression.
  it("surfaces the response body on a non-401 failure, with the status", async () => {
    const out = await classifyAdminResponse(
      res({ ok: false, status: 500, text: "canceling statement due to statement timeout" }),
    )
    expect(out.kind).toBe("http-error")
    expect(out).toMatchObject({ message: expect.stringContaining("HTTP 500") })
    expect(out).toMatchObject({ message: expect.stringContaining("statement timeout") })
  })

  it("truncates a long body rather than pasting an entire stack trace on screen", async () => {
    const huge = "x".repeat(5_000)
    const out = await classifyAdminResponse(res({ ok: false, status: 502, text: huge }))
    if (out.kind !== "http-error") throw new Error("wrong kind")
    // The prefix is "HTTP 502: ", so the message is that plus exactly the cap.
    expect(out.message.length).toBe("HTTP 502: ".length + ADMIN_ERROR_BODY_CHARS)
    expect(out.message.endsWith("x")).toBe(true)
  })

  it("treats a 2xx as success even with an empty body, rather than inventing a failure", async () => {
    const out = await classifyAdminResponse(res({ ok: true, status: 204, json: null }))
    expect(out.kind).toBe("ok")
  })

  // A 403 is NOT a 401. The route distinguishes "your token is wrong" from "your token is
  // right and you may not do this", and discarding a valid credential on a 403 would log
  // the operator out of a page they can legitimately read after the underlying grant is fixed.
  it("does not treat 403 as a bad token", async () => {
    const out = await classifyAdminResponse(res({ ok: false, status: 403, text: "forbidden" }))
    expect(out.kind).toBe("http-error")
  })
})

describe("ADMIN_TOKEN_KEY", () => {
  // All seven admin pages read and write this one key, so a rename is a silent logout
  // across every admin surface at once — the operator is not told, the pages simply show
  // their entry form again.
  it("is the key every admin page already stores its token under", () => {
    expect(ADMIN_TOKEN_KEY).toBe("rpc_admin_token")
  })
})
