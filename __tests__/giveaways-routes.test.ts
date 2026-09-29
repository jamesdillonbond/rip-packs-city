import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// ── mocks: the store (DB), auth, and the username resolver ─────────────────
const { store, getCurrentUser, resolve } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  resolve: vi.fn(),
  store: {
  getDrop: vi.fn(),
  getPool: vi.fn(),
  getClaims: vi.fn(),
  claimPack: vi.fn(),
  listDrops: vi.fn(),
  listCheckedCandidates: vi.fn(),
  createDraft: vi.fn(),
  sealDrop: vi.fn(),
  setStatus: vi.fn(),
  deleteDraft: vi.fn(),
  verifyDeliveries: vi.fn(),
  },
}))
const { planDelivery } = vi.hoisted(() => ({ planDelivery: vi.fn() }))
vi.mock("@/lib/giveaways/deliver", () => ({ planDelivery: (...a: unknown[]) => planDelivery(...a) }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/giveaways/store", async (orig) => {
  const real = await orig<typeof import("@/lib/giveaways/store")>()
  return { ...real, ...store }
})
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: () => getCurrentUser() }))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({ resolveTopShotUsernameCacheAware: (...a: unknown[]) => resolve(...a) }))

import * as publicRoute from "@/app/api/giveaways/[slug]/route"
import * as adminList from "@/app/api/admin/giveaways/route"
import * as adminOne from "@/app/api/admin/giveaways/[id]/route"
import { GiveawayError } from "@/lib/giveaways/store"
import { commitmentHash } from "@/lib/giveaways/seal"
import { FlowScriptError } from "@/lib/giveaways/flow-script"

const ID = "11111111-1111-1111-1111-111111111111"
const DROP = {
  id: ID,
  slug: "test-drop",
  title: "Test drop",
  description: null,
  sponsor_name: "Trevor",
  collection_id: "c",
  admin_wallet: "0x00000000000000aa",
  status: "open",
  pack_count: 2,
  moments_per_pack: 1,
  seal_hash: commitmentHash("aa", "1:1;2:2"),
  seal_salt: "aa",
  sealed_at: "2026-09-29T19:00:00Z",
  opened_at: null,
  closed_at: null,
  created_at: "2026-09-29T18:00:00Z",
}
const slugCtx = (slug: string) => ({ params: Promise.resolve({ slug }) })
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } })

beforeEach(() => {
  for (const f of Object.values(store)) f.mockReset()
  getCurrentUser.mockReset()
  resolve.mockReset()
  process.env.RPC_ADMIN_TOKEN = "tok"
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("GET /api/giveaways/[slug]", () => {
  it("404 for a malformed slug, a missing drop and a draft — the same answer", async () => {
    expect((await publicRoute.GET(new NextRequest("http://x/api/giveaways/A!"), slugCtx("A!"))).status).toBe(404)
    store.getDrop.mockResolvedValueOnce(null)
    expect((await publicRoute.GET(new NextRequest("http://x/api/giveaways/nope"), slugCtx("nope"))).status).toBe(404)
    store.getDrop.mockResolvedValueOnce({ ...DROP, status: "draft" })
    expect((await publicRoute.GET(new NextRequest("http://x/api/giveaways/test-drop"), slugCtx("test-drop"))).status).toBe(404)
  })

  it("returns the public view with signed_in and the viewer's pack", async () => {
    store.getDrop.mockResolvedValue(DROP)
    store.getPool.mockResolvedValue([
      { moment_id: "1", pack_no: 1, slot: 1, fmv_usd: 2, delivered_at: null, last_checked_at: null },
      { moment_id: "2", pack_no: 2, slot: 1, fmv_usd: 3, delivered_at: null, last_checked_at: null },
    ])
    store.getClaims.mockResolvedValue([{ pack_no: 2, user_id: "me", topshot_username: "alice", recipient_address: "0x01", claimed_at: "t" }])
    getCurrentUser.mockResolvedValue({ id: "me" })
    const res = await publicRoute.GET(new NextRequest("http://x/api/giveaways/test-drop"), slugCtx("test-drop"))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(body.signed_in).toBe(true)
    expect(body.me.pack_no).toBe(2)
    expect(body.verification).toBeNull()
  })

  it("a failed read is a classified error, never an empty giveaway", async () => {
    store.getDrop.mockRejectedValue({ message: "canceling statement due to statement timeout", code: "57014" })
    const res = await publicRoute.GET(new NextRequest("http://x/api/giveaways/test-drop"), slugCtx("test-drop"))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })
})

describe("POST /api/giveaways/[slug] (claim)", () => {
  const url = "http://x/api/giveaways/test-drop"
  beforeEach(() => {
    store.getDrop.mockResolvedValue(DROP)
    getCurrentUser.mockResolvedValue({ id: "u1" })
    resolve.mockResolvedValue({ found: true, walletAddress: "0x00000000000000BB", username: "Alice" })
    store.claimPack.mockResolvedValue({ outcome: "claimed", pack_no: 2 })
  })

  it("401 when signed out, before anything else is read", async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await publicRoute.POST(post(url, { username: "alice", agree: true }), slugCtx("test-drop"))
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe("sign_in")
    expect(store.getDrop).not.toHaveBeenCalled()
  })

  it("400 without the 18+/rules agreement, a bad body, or a bad username", async () => {
    expect((await publicRoute.POST(post(url, { username: "alice" }), slugCtx("test-drop"))).status).toBe(400)
    expect((await publicRoute.POST(post(url, "not json"), slugCtx("test-drop"))).status).toBe(400)
    expect((await publicRoute.POST(post(url, { username: "a b c", agree: true }), slugCtx("test-drop"))).status).toBe(400)
    expect(store.claimPack).not.toHaveBeenCalled()
  })

  it("claims with the resolved wallet LOWERCASED and the canonical username", async () => {
    const res = await publicRoute.POST(post(url, { username: "@alice", agree: true }), slugCtx("test-drop"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, outcome: "claimed", pack_no: 2 })
    expect(store.claimPack).toHaveBeenCalledWith({}, ID, "u1", "Alice", "0x00000000000000bb")
  })

  it("an unknown username is a 400; a username lookup that could not run is a retryable 503, never 'not found'", async () => {
    resolve.mockResolvedValueOnce({ found: false, reason: "username_not_found_on_topshot" })
    const a = await publicRoute.POST(post(url, { username: "ghost", agree: true }), slugCtx("test-drop"))
    expect(a.status).toBe(400)
    resolve.mockResolvedValueOnce({ found: false, reason: "topshot_gql_error", detail: "530" })
    const b = await publicRoute.POST(post(url, { username: "alice", agree: true }), slugCtx("test-drop"))
    expect(b.status).toBe(503)
    expect(b.headers.get("retry-after")).toBe("30")
    expect(JSON.stringify(await b.json())).not.toMatch(/couldn't find/)
    expect(store.claimPack).not.toHaveBeenCalled()
  })

  it("a non-Flow resolved address is refused", async () => {
    resolve.mockResolvedValueOnce({ found: true, walletAddress: "0xabc", username: "alice" })
    expect((await publicRoute.POST(post(url, { username: "alice", agree: true }), slugCtx("test-drop"))).status).toBe(400)
  })

  it("a closed or sealed drop refuses before resolving; a draft is a 404", async () => {
    store.getDrop.mockResolvedValueOnce({ ...DROP, status: "closed" })
    const res = await publicRoute.POST(post(url, { username: "alice", agree: true }), slugCtx("test-drop"))
    expect(res.status).toBe(409)
    expect(resolve).not.toHaveBeenCalled()
    store.getDrop.mockResolvedValueOnce({ ...DROP, status: "draft" })
    expect((await publicRoute.POST(post(url, { username: "alice", agree: true }), slugCtx("test-drop"))).status).toBe(404)
    expect((await publicRoute.POST(post(url, { username: "alice", agree: true }), slugCtx("BAD!"))).status).toBe(404)
  })

  it("maps the database's refusals to their copy", async () => {
    store.claimPack.mockResolvedValueOnce({ outcome: "all_claimed", pack_no: null })
    const res = await publicRoute.POST(post(url, { username: "alice", agree: true }), slugCtx("test-drop"))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, code: "all_claimed" })
  })

  it("a failed claim write is a classified error", async () => {
    store.claimPack.mockRejectedValueOnce({ message: "boom" })
    const res = await publicRoute.POST(post(url, { username: "alice", agree: true }), slugCtx("test-drop"))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("boom")
  })
})

describe("/api/admin/giveaways", () => {
  const auth = { authorization: "Bearer tok" }
  it("every method is 401 without the admin token", async () => {
    expect((await adminList.GET(new NextRequest("http://x/api/admin/giveaways"))).status).toBe(401)
    expect((await adminList.POST(post("http://x/api/admin/giveaways", {}))).status).toBe(401)
    expect((await adminOne.GET(new NextRequest(`http://x/api/admin/giveaways/${ID}`), idCtx(ID))).status).toBe(401)
    expect((await adminOne.POST(post(`http://x/api/admin/giveaways/${ID}`, { action: "seal" }), idCtx(ID))).status).toBe(401)
    delete process.env.RPC_ADMIN_TOKEN
    expect((await adminList.GET(new NextRequest("http://x/api/admin/giveaways", { headers: auth }))).status).toBe(401)
  })

  it("lists drops and candidates (lowercasing the wallet; refusing a bad one)", async () => {
    store.listDrops.mockResolvedValue([DROP])
    expect(await (await adminList.GET(new NextRequest("http://x/api/admin/giveaways", { headers: auth }))).json()).toEqual({ drops: [DROP] })
    const checked = { wallet: "0x00000000000000aa", candidates: [{ moment_id: "1", chain: "giftable" }], excluded: { locked: 2, not_held: 0 }, cache_count: 3 }
    store.listCheckedCandidates.mockResolvedValue(checked)
    const c = await adminList.GET(new NextRequest("http://x/api/admin/giveaways?candidates=0x00000000000000AA", { headers: auth }))
    expect(await c.json()).toEqual(checked)
    expect(store.listCheckedCandidates).toHaveBeenCalledWith({}, "0x00000000000000aa")
    store.listCheckedCandidates.mockRejectedValueOnce(new Error("Flow script HTTP 500"))
    expect((await adminList.GET(new NextRequest("http://x/api/admin/giveaways?candidates=0x00000000000000aa", { headers: auth }))).status).toBe(500)
    expect((await adminList.GET(new NextRequest("http://x/api/admin/giveaways?candidates=nope", { headers: auth }))).status).toBe(400)
    store.listDrops.mockRejectedValueOnce({ message: "x" })
    expect((await adminList.GET(new NextRequest("http://x/api/admin/giveaways", { headers: auth }))).status).toBe(500)
  })

  it("creates a draft; a validation or refusal message reaches the operator", async () => {
    const body = { slug: "fall-drop", title: "Fall drop", sponsor_name: "Trevor", admin_wallet: "0x00000000000000aa", pack_count: 1, moments_per_pack: 2, moment_ids: ["1", "2"] }
    store.createDraft.mockResolvedValueOnce("new-id")
    const ok = await adminList.POST(post("http://x/api/admin/giveaways", body, auth))
    expect(ok.status).toBe(201)
    expect(await ok.json()).toEqual({ id: "new-id" })
    const bad = await adminList.POST(post("http://x/api/admin/giveaways", { ...body, moment_ids: ["1"] }, auth))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/need 2/)
    expect((await adminList.POST(post("http://x/api/admin/giveaways", "nope", auth))).status).toBe(400)
    store.createDraft.mockRejectedValueOnce(new GiveawayError("giveaway: locked: 2", 400, "refused"))
    const refused = await adminList.POST(post("http://x/api/admin/giveaways", body, auth))
    expect(await refused.json()).toMatchObject({ error: "giveaway: locked: 2" })
    store.createDraft.mockRejectedValueOnce({ message: "db down" })
    expect((await adminList.POST(post("http://x/api/admin/giveaways", body, auth))).status).toBe(500)
  })

  it("one drop: detail, and each action", async () => {
    expect((await adminOne.GET(new NextRequest("http://x/api/admin/giveaways/nope", { headers: auth }), idCtx("nope"))).status).toBe(400)
    store.getDrop.mockResolvedValueOnce(null)
    expect((await adminOne.GET(new NextRequest(`http://x/api/admin/giveaways/${ID}`, { headers: auth }), idCtx(ID))).status).toBe(404)
    store.getDrop.mockResolvedValue(DROP)
    store.getPool.mockResolvedValue([])
    store.getClaims.mockResolvedValue([])
    expect(await (await adminOne.GET(new NextRequest(`http://x/api/admin/giveaways/${ID}`, { headers: auth }), idCtx(ID))).json()).toEqual({
      drop: DROP,
      pool: [],
      claims: [],
    })

    const act = (action: unknown) => adminOne.POST(post(`http://x/api/admin/giveaways/${ID}`, { action }, auth), idCtx(ID))
    expect((await act("explode")).status).toBe(400)
    expect((await adminOne.POST(post(`http://x/api/admin/giveaways/${ID}`, "nope", auth), idCtx(ID))).status).toBe(400)
    expect((await adminOne.POST(post("http://x/api/admin/giveaways/bad", { action: "seal" }, auth), idCtx("bad"))).status).toBe(400)

    store.sealDrop.mockResolvedValueOnce({ hash: "h", check: { pool_fmv_usd: 12 } })
    expect(await (await act("seal")).json()).toEqual({ ok: true, seal_hash: "h", pool_fmv_usd: 12 })
    expect((await act("open")).status).toBe(200)
    expect(store.setStatus).toHaveBeenLastCalledWith({}, DROP, "open")
    expect((await act("close")).status).toBe(200)
    expect(store.setStatus).toHaveBeenLastCalledWith({}, DROP, "closed")
    expect((await act("delete")).status).toBe(200)

    store.verifyDeliveries.mockResolvedValueOnce({ checked: 2, delivered: 2, pending: 0, missing: 0, failed_recipients: [], written: 2, write_error: null })
    const v = await act("verify")
    expect(v.status).toBe(200)
    expect((await v.json()).ok).toBe(true)

    store.verifyDeliveries.mockResolvedValueOnce({ checked: 1, delivered: 0, pending: 1, missing: 0, failed_recipients: ["0x02"], written: 1, write_error: null })
    const partial = await act("verify")
    expect(partial.status).toBe(207)
    expect((await partial.json()).ok).toBe(false)

    store.sealDrop.mockRejectedValueOnce(new GiveawayError("Locked on chain: 5", 409, "locked"))
    const locked = await act("seal")
    expect(locked.status).toBe(409)
    expect(await locked.json()).toEqual({ error: "Locked on chain: 5", code: "locked" })

    store.sealDrop.mockRejectedValueOnce(new Error("Flow script HTTP 500"))
    expect((await act("seal")).status).toBe(500)

    store.getDrop.mockResolvedValueOnce(null)
    expect((await act("seal")).status).toBe(404)
  })

  it("deliver_plan passes the connected wallet (lowercased) and returns the simulated plan", async () => {
    store.getDrop.mockResolvedValue(DROP)
    const plan = { parent: "0x00000000000000bb", child: DROP.admin_wallet, providerControllerID: "70", batches: [], skipped: [] }
    planDelivery.mockResolvedValueOnce(plan)
    const res = await adminOne.POST(post(`http://x/api/admin/giveaways/${ID}`, { action: "deliver_plan", parent: " 0x00000000000000BB " }, auth), idCtx(ID))
    expect(await res.json()).toEqual({ ok: true, plan })
    expect(planDelivery).toHaveBeenCalledWith({}, DROP, "0x00000000000000bb")
    // a non-string parent is passed as "" (planDelivery refuses it)
    planDelivery.mockRejectedValueOnce(new GiveawayError("not a Flow address", 400, "bad_parent"))
    const bad = await adminOne.POST(post(`http://x/api/admin/giveaways/${ID}`, { action: "deliver_plan", parent: 7 }, auth), idCtx(ID))
    expect(bad.status).toBe(400)
    expect(planDelivery).toHaveBeenLastCalledWith({}, DROP, "")
  })

  it("a Cadence panic from our scripts reaches the operator as a 409 with its message", async () => {
    store.getDrop.mockResolvedValue(DROP)
    planDelivery.mockRejectedValueOnce(new FlowScriptError("Cadence: Cannot withdraw: Moment is locked", 400))
    const res = await adminOne.POST(post(`http://x/api/admin/giveaways/${ID}`, { action: "deliver_plan", parent: "0x00000000000000bb" }, auth), idCtx(ID))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "Cadence: Cannot withdraw: Moment is locked", code: "flow" })
  })
})
