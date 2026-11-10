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
  listCandidatesAcross: vi.fn(),
  createDraft: vi.fn(),
  sealDrop: vi.fn(),
  setStatus: vi.fn(),
  deleteDraft: vi.fn(),
  verifyDeliveries: vi.fn(),
  usernameForWallet: vi.fn(),
  },
}))
const { planDelivery, planFunding } = vi.hoisted(() => ({ planDelivery: vi.fn(), planFunding: vi.fn() }))
// instant delivery (2026-11-08): the vault module, and next/server's after() captured so a
// test can see WHETHER a send was scheduled and run it.
const { vault, afterFns } = vi.hoisted(() => ({
  vault: {
    vaultAddress: vi.fn(),
    vaultStatus: vi.fn(),
    setUpVault: vi.fn(),
    confirmFunding: vi.fn(),
    sendFromVault: vi.fn(),
    instantDeliveryEnabled: vi.fn(),
  },
  afterFns: [] as (() => Promise<void>)[],
}))
vi.mock("@/lib/giveaways/vault", () => vault)
vi.mock("next/server", async (orig) => {
  const real = await orig<typeof import("next/server")>()
  return { ...real, after: (fn: () => Promise<void>) => void afterFns.push(fn) }
})
const { acctWallet } = vi.hoisted(() => ({ acctWallet: vi.fn() }))
vi.mock("@/lib/giveaways/account-wallet", () => ({ accountTopShotWallet: (...a: unknown[]) => acctWallet(...a) }))
const { discover } = vi.hoisted(() => ({ discover: vi.fn() }))
const { verifyProof } = vi.hoisted(() => ({ verifyProof: vi.fn() }))
vi.mock("@/lib/giveaways/claim-proof", async (orig) => {
  const real = await orig<typeof import("@/lib/giveaways/claim-proof")>()
  return { ...real, verifyClaimProof: (...a: unknown[]) => verifyProof(...a) }
})
vi.mock("@/lib/giveaways/linked-accounts", () => ({ discoverAccounts: (...a: unknown[]) => discover(...a) }))
vi.mock("@/lib/giveaways/deliver", () => ({ planDelivery: (...a: unknown[]) => planDelivery(...a), planFunding: (...a: unknown[]) => planFunding(...a) }))
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
  deal_mode: "random",
  vault_address: null,
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
  discover.mockReset()
  acctWallet.mockReset()
  acctWallet.mockResolvedValue({ wallet: null, reason: "none" })
  verifyProof.mockReset()
  planFunding.mockReset()
  for (const f of Object.values(vault)) f.mockReset()
  afterFns.length = 0
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

describe("one-click claim with the wallet already on the account (Trevor, 2026-11-10)", () => {
  const url = "http://x/api/giveaways/test-drop"
  beforeEach(() => {
    store.getDrop.mockResolvedValue(DROP)
    getCurrentUser.mockResolvedValue({ id: "u1" })
    store.claimPack.mockResolvedValue({ outcome: "claimed", pack_no: 2 })
    store.getPool.mockResolvedValue([{ moment_id: "1", pack_no: 1, slot: 1, fmv_usd: 2, delivered_at: null, last_checked_at: null }])
    store.getClaims.mockResolvedValue([])
  })

  it("GET carries the account's wallet for a signed-in viewer who has not claimed", async () => {
    acctWallet.mockResolvedValue({ wallet: { address: "0x00000000000000cc", username: "Carol" } })
    const body = await (await publicRoute.GET(new NextRequest(url), slugCtx("test-drop"))).json()
    expect(body.account_wallet).toEqual({ address: "0x00000000000000cc", username: "Carol" })
    expect(body.account_wallet_error).toBe(false)
    expect(acctWallet).toHaveBeenCalledWith({}, "u1", "c")
  })

  it("GET: a failed wallet read is account_wallet_error, never a missing wallet — and the view still loads", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    acctWallet.mockRejectedValue(new Error("saved_wallets read failed: timeout"))
    const res = await publicRoute.GET(new NextRequest(url), slugCtx("test-drop"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.account_wallet).toBeNull()
    expect(body.account_wallet_error).toBe(true)
  })

  it("GET: signed out, or already claimed, reads no wallet", async () => {
    getCurrentUser.mockResolvedValue(null)
    await publicRoute.GET(new NextRequest(url), slugCtx("test-drop"))
    getCurrentUser.mockResolvedValue({ id: "u1" })
    store.getClaims.mockResolvedValue([{ pack_no: 1, user_id: "u1", topshot_username: "x", recipient_address: "0x01", claimed_at: "t" }])
    await publicRoute.GET(new NextRequest(url), slugCtx("test-drop"))
    expect(acctWallet).not.toHaveBeenCalled()
  })

  it("POST { account: true } claims to the account's own wallet, labelled with its saved username", async () => {
    acctWallet.mockResolvedValue({ wallet: { address: "0x00000000000000cc", username: "Carol" } })
    const res = await publicRoute.POST(post(url, { account: true, agree: true }), slugCtx("test-drop"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, outcome: "claimed", pack_no: 2 })
    expect(store.claimPack).toHaveBeenCalledWith({}, ID, "u1", "Carol", "0x00000000000000cc")
    expect(resolve).not.toHaveBeenCalled()
  })

  it("POST { account: true }: the body cannot name the wallet — a smuggled address or username is ignored", async () => {
    acctWallet.mockResolvedValue({ wallet: { address: "0x00000000000000cc", username: null } })
    store.usernameForWallet.mockResolvedValue(null)
    await publicRoute.POST(post(url, { account: true, agree: true, username: "mallory", destination: "0x00000000000000ee" }), slugCtx("test-drop"))
    expect(store.claimPack).toHaveBeenCalledWith({}, ID, "u1", "0x00000000000000cc", "0x00000000000000cc")
  })

  it("POST { account: true }: no wallet or an ambiguous one is a 400 that names the other path; nothing is claimed", async () => {
    const a = await publicRoute.POST(post(url, { account: true, agree: true }), slugCtx("test-drop"))
    expect(a.status).toBe(400)
    expect((await a.json()).code).toBe("no_account_wallet")
    acctWallet.mockResolvedValue({ wallet: null, reason: "ambiguous" })
    const b = await publicRoute.POST(post(url, { account: true, agree: true }), slugCtx("test-drop"))
    expect((await b.json()).error).toMatch(/more than one/)
    expect(store.claimPack).not.toHaveBeenCalled()
  })

  it("POST { account: true }: a failed wallet read is a classified error, never 'no wallet'", async () => {
    acctWallet.mockRejectedValue({ message: "canceling statement due to statement timeout", code: "57014" })
    const res = await publicRoute.POST(post(url, { account: true, agree: true }), slugCtx("test-drop"))
    expect(res.status).toBe(503)
    expect((await res.json()).code).not.toBe("no_account_wallet")
    expect(store.claimPack).not.toHaveBeenCalled()
  })

  it("POST { account: true }: needs the agreement, a signed-in user and an open drop", async () => {
    expect((await publicRoute.POST(post(url, { account: true }), slugCtx("test-drop"))).status).toBe(400)
    store.getDrop.mockResolvedValueOnce({ ...DROP, status: "closed" })
    expect((await publicRoute.POST(post(url, { account: true, agree: true }), slugCtx("test-drop"))).status).toBe(409)
    getCurrentUser.mockResolvedValue(null)
    expect((await publicRoute.POST(post(url, { account: true, agree: true }), slugCtx("test-drop"))).status).toBe(401)
    expect(store.claimPack).not.toHaveBeenCalled()
  })
})

describe("claim with Flow Wallet, proven by account proof (Trevor, 2026-10-03)", () => {
  const url = "http://x/api/giveaways/test-drop"
  const FW = "0x00000000000000f1"
  const DAPPER = "0x00000000000000d2"
  const NOTS = "0x00000000000000e3"
  const PROOF = { address: FW, nonce: "ab".repeat(32), issuedAt: "2026-10-03T17:00:00.000Z", signatures: [] }
  const ACCOUNTS = [
    { address: FW, role: "flow_wallet", topshot_count: 0, name: null, dapper: false },
    { address: DAPPER, role: "linked", topshot_count: 120, name: "Dapper Wallet", dapper: true },
    { address: NOTS, role: "linked", topshot_count: null, name: "Creator Hub", dapper: false },
  ]
  const claim = (body: unknown) => publicRoute.POST(post(url, body), slugCtx("test-drop"))
  const accounts = (proof: unknown = PROOF) => claim({ intent: "accounts", proof })
  beforeEach(() => {
    publicRoute.__resetProofRateLimit()
    store.getDrop.mockResolvedValue(DROP)
    getCurrentUser.mockResolvedValue({ id: "u1" })
    discover.mockResolvedValue(ACCOUNTS)
    verifyProof.mockResolvedValue({ ok: true, address: FW })
    store.usernameForWallet.mockResolvedValue(null)
    store.claimPack.mockResolvedValue({ outcome: "claimed", pack_no: 1 })
  })

  it("claim_nonce: signed in only; a 64-hex nonce bound to the user", async () => {
    getCurrentUser.mockResolvedValueOnce(null)
    expect((await publicRoute.GET(new NextRequest(`${url}?claim_nonce=1`), slugCtx("test-drop"))).status).toBe(401)
    process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(48)
    const res = await publicRoute.GET(new NextRequest(`${url}?claim_nonce=1`), slugCtx("test-drop"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof body.issuedAt).toBe("string")
    expect(store.getDrop).not.toHaveBeenCalled()
  })

  it("accounts: the PROVEN wallet and its linked accounts, checked for this user and this site", async () => {
    const res = await accounts()
    expect(res.status).toBe(200)
    expect(verifyProof).toHaveBeenCalledWith("u1", "http://x", PROOF)
    expect(discover).toHaveBeenCalledWith(FW)
    expect(await res.json()).toEqual({
      wallet: FW,
      accounts: [
        { address: FW, role: "flow_wallet", name: null, dapper: false, can_receive: true },
        { address: DAPPER, role: "linked", name: "Dapper Wallet", dapper: true, can_receive: true },
        { address: NOTS, role: "linked", name: "Creator Hub", dapper: false, can_receive: false },
      ],
    })
  })

  it("accounts: a proof that fails is refused with its reason, and no chain read of accounts happens", async () => {
    verifyProof.mockResolvedValueOnce({ ok: false, code: "proof_mismatch", error: "That Flow Wallet sign-in wasn't made for your RPC account." })
    const res = await accounts()
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "proof_mismatch" })
    expect(discover).not.toHaveBeenCalled()
  })

  it("accounts: a proof check or account read that could not run is a retryable 503, never an empty list", async () => {
    verifyProof.mockRejectedValueOnce(new Error("rest-mainnet 502"))
    const a = await accounts()
    expect(a.status).toBe(503)
    expect(a.headers.get("retry-after")).toBe("30")
    discover.mockRejectedValueOnce(new Error("timeout"))
    const b = await accounts()
    expect(b.status).toBe(503)
    expect((await b.json()).accounts).toBeUndefined()
  })

  it("claim: sends the pack to a LINKED account of the proven wallet, labelled with its known username", async () => {
    store.usernameForWallet.mockResolvedValueOnce("trevor")
    const res = await claim({ proof: PROOF, destination: DAPPER, agree: true })
    expect(res.status).toBe(200)
    expect(discover).toHaveBeenCalledWith(FW)
    expect(store.claimPack).toHaveBeenCalledWith({}, ID, "u1", "trevor", DAPPER)
  })

  it("claim: the Flow Wallet itself; no known username labels it with the address", async () => {
    expect((await claim({ proof: PROOF, destination: FW, agree: true })).status).toBe(200)
    expect(store.claimPack).toHaveBeenCalledWith({}, ID, "u1", FW, FW)
  })

  it("claim: a bare wallet address with no proof is refused — naming someone else's wallet gets nothing", async () => {
    const res = await claim({ wallet: FW, destination: DAPPER, agree: true })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("proof_missing")
    expect(verifyProof).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
    expect(store.claimPack).not.toHaveBeenCalled()
  })

  it("claim: the wallet is the one the proof proves, whatever else the body says", async () => {
    verifyProof.mockResolvedValueOnce({ ok: true, address: "0x00000000000000c4" })
    discover.mockResolvedValueOnce([{ address: "0x00000000000000c4", role: "flow_wallet", topshot_count: 3 }])
    const res = await claim({ proof: PROOF, wallet: FW, destination: DAPPER, agree: true })
    expect(discover).toHaveBeenCalledWith("0x00000000000000c4")
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("not_linked")
    expect(store.claimPack).not.toHaveBeenCalled()
  })

  it("claim: a failed proof stops the claim before any account read", async () => {
    verifyProof.mockResolvedValueOnce({ ok: false, code: "proof_expired", error: "Your Flow Wallet sign-in expired." })
    const res = await claim({ proof: PROOF, destination: DAPPER, agree: true })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("proof_expired")
    expect(discover).not.toHaveBeenCalled()
    expect(store.claimPack).not.toHaveBeenCalled()
  })

  it("claim: refuses an account the wallet has NOT linked, and one that cannot hold Top Shot moments", async () => {
    const a = await claim({ proof: PROOF, destination: "0x00000000000000aa", agree: true })
    expect((await a.json()).code).toBe("not_linked")
    const b = await claim({ proof: PROOF, destination: NOTS, agree: true })
    expect((await b.json()).code).toBe("cannot_receive")
    expect(store.claimPack).not.toHaveBeenCalled()
  })

  it("claim: a chain read that failed is a 503 — never 'not linked'", async () => {
    discover.mockRejectedValueOnce(new Error("timeout"))
    const res = await claim({ proof: PROOF, destination: DAPPER, agree: true })
    expect(res.status).toBe(503)
    expect(JSON.stringify(await res.json())).not.toMatch(/linked to it|can't receive/)
    expect(store.claimPack).not.toHaveBeenCalled()
  })

  it("claim: bad destination, no agreement, signed out, or a drop not open refuse before the proof is checked", async () => {
    expect((await claim({ proof: PROOF, destination: "0xabc", agree: true })).status).toBe(400)
    expect((await claim({ proof: PROOF, destination: DAPPER })).status).toBe(400)
    getCurrentUser.mockResolvedValueOnce(null)
    expect((await claim({ proof: PROOF, destination: DAPPER, agree: true })).status).toBe(401)
    store.getDrop.mockResolvedValueOnce({ ...DROP, status: "closed" })
    expect((await claim({ proof: PROOF, destination: DAPPER, agree: true })).status).toBe(409)
    expect(verifyProof).not.toHaveBeenCalled()
    expect(store.claimPack).not.toHaveBeenCalled()
  })

  it("proof checks are capped per user (each costs a mainnet script)", async () => {
    for (let i = 0; i < 10; i++) expect((await accounts()).status).toBe(200)
    const res = await accounts()
    expect(res.status).toBe(429)
    expect(verifyProof).toHaveBeenCalledTimes(10)
    getCurrentUser.mockResolvedValue({ id: "u2" })
    expect((await accounts()).status).toBe(200)
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
    expect((await adminList.GET(new NextRequest("http://x/api/admin/giveaways?candidates=not%20a%20wallet!", { headers: auth }))).status).toBe(400)
    store.listDrops.mockRejectedValueOnce({ message: "x" })
    expect((await adminList.GET(new NextRequest("http://x/api/admin/giveaways", { headers: auth }))).status).toBe(500)
  })

  it("candidates accepts a Top Shot username and resolves it (2026-10-03)", async () => {
    const checked = { wallet: "0x00000000000000aa", candidates: [], excluded: { locked: 0, not_held: 0 }, cache_count: 0 }
    store.listCheckedCandidates.mockResolvedValue(checked)
    resolve.mockResolvedValueOnce({ found: true, walletAddress: "0x00000000000000AA", username: "jamesdillonbond" })
    const ok = await adminList.GET(new NextRequest("http://x/api/admin/giveaways?candidates=%40jamesdillonbond", { headers: auth }))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ...checked, username: "jamesdillonbond" })
    expect(resolve).toHaveBeenCalledWith({}, "@jamesdillonbond")
    expect(store.listCheckedCandidates).toHaveBeenCalledWith({}, "0x00000000000000aa")

    // an unknown username is a 404 that names it; a FAILED lookup is not "not found"
    resolve.mockResolvedValueOnce({ found: false, reason: "username_not_found_on_topshot" })
    const missing = await adminList.GET(new NextRequest("http://x/api/admin/giveaways?candidates=ghost_user", { headers: auth }))
    expect(missing.status).toBe(404)
    expect((await missing.json()).error).toContain('"ghost_user"')
    resolve.mockResolvedValueOnce({ found: false, reason: "topshot_gql_error", detail: "timeout" })
    const down = await adminList.GET(new NextRequest("http://x/api/admin/giveaways?candidates=jamesdillonbond", { headers: auth }))
    expect(down.status).toBe(502)
    expect((await down.json()).error).not.toMatch(/no top shot account|not found/i)
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

  it("accounts_for: the connected wallet and its linked accounts, giftable moments from each (2026-10-03)", async () => {
    const accounts = [
      { address: "0x00000000000000bb", role: "flow_wallet", topshot_count: 0 },
      { address: "0x00000000000000aa", role: "linked", topshot_count: 15547 },
    ]
    discover.mockResolvedValueOnce(accounts)
    store.listCandidatesAcross.mockResolvedValueOnce({ candidates: [{ moment_id: "1", source_wallet: "0x00000000000000aa" }], accounts: [] })
    const r = await adminList.GET(new NextRequest("http://x/api/admin/giveaways?accounts_for=0x00000000000000BB", { headers: auth }))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ parent: "0x00000000000000bb", candidates: [{ moment_id: "1", source_wallet: "0x00000000000000aa" }], accounts: [] })
    expect(discover).toHaveBeenCalledWith("0x00000000000000bb")
    expect(store.listCandidatesAcross).toHaveBeenCalledWith({}, accounts)
    expect((await adminList.GET(new NextRequest("http://x/api/admin/giveaways?accounts_for=bob", { headers: auth }))).status).toBe(400)
    // the chain read's own message reaches the operator; never an empty account list
    discover.mockRejectedValueOnce(new FlowScriptError("Flow script HTTP 503", 503))
    const down = await adminList.GET(new NextRequest("http://x/api/admin/giveaways?accounts_for=0x00000000000000bb", { headers: auth }))
    expect(down.status).toBe(502)
    expect(await down.json()).toMatchObject({ error: "Flow script HTTP 503" })
    discover.mockRejectedValueOnce(new GiveawayError("The linked-accounts lookup returned an unexpected shape.", 502, "flow_shape"))
    expect((await adminList.GET(new NextRequest("http://x/api/admin/giveaways?accounts_for=0x00000000000000bb", { headers: auth }))).status).toBe(502)
  })

  it("a multi-account draft is created only when every source is the wallet or an account it has linked, read on chain", async () => {
    const body = {
      slug: "fall-drop",
      title: "Fall drop",
      sponsor_name: "Trevor",
      admin_wallet: "0x00000000000000bb",
      pack_count: 1,
      moments_per_pack: 2,
      moment_ids: ["1", "2"],
      source_wallets: ["0x00000000000000aa", "0x00000000000000cc"],
    }
    discover.mockResolvedValueOnce([
      { address: "0x00000000000000bb", role: "flow_wallet", topshot_count: 0 },
      { address: "0x00000000000000aa", role: "linked", topshot_count: 3 },
    ])
    const foreign = await adminList.POST(post("http://x/api/admin/giveaways", body, auth))
    expect(foreign.status).toBe(400)
    expect(await foreign.json()).toMatchObject({ code: "not_linked", error: expect.stringContaining("0x00000000000000cc") })
    expect(store.createDraft).not.toHaveBeenCalled()

    discover.mockResolvedValueOnce([
      { address: "0x00000000000000bb", role: "flow_wallet", topshot_count: 0 },
      { address: "0x00000000000000aa", role: "linked", topshot_count: 3 },
      { address: "0x00000000000000cc", role: "linked", topshot_count: 1 },
    ])
    store.createDraft.mockResolvedValueOnce("new-id")
    const ok = await adminList.POST(post("http://x/api/admin/giveaways", body, auth))
    expect(ok.status).toBe(201)
    expect(discover).toHaveBeenLastCalledWith("0x00000000000000bb")
    expect(store.createDraft).toHaveBeenCalledWith({}, expect.objectContaining({ source_wallets: ["0x00000000000000aa", "0x00000000000000cc"] }))

    discover.mockRejectedValueOnce(new FlowScriptError("Flow script HTTP 503", 503))
    expect((await adminList.POST(post("http://x/api/admin/giveaways", body, auth))).status).toBe(502)
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
    expect(await (await act("seal")).json()).toEqual({ ok: true, seal_hash: "h", pool_fmv_usd: 12, deal_mode: "random" })
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

    // the deal mode (2026-11-08): passed through, and an unknown one is refused before any seal
    store.sealDrop.mockClear()
    store.sealDrop.mockResolvedValueOnce({ hash: "h", check: { pool_fmv_usd: 12 } })
    const bal = await adminOne.POST(post(`http://x/api/admin/giveaways/${ID}`, { action: "seal", deal_mode: "balanced" }, auth), idCtx(ID))
    expect(await bal.json()).toEqual({ ok: true, seal_hash: "h", pool_fmv_usd: 12, deal_mode: "balanced" })
    expect(store.sealDrop.mock.calls[0][3]).toBe("balanced")
    const bad = await adminOne.POST(post(`http://x/api/admin/giveaways/${ID}`, { action: "seal", deal_mode: "fair" }, auth), idCtx(ID))
    expect(bad.status).toBe(400)
    expect(store.sealDrop).toHaveBeenCalledTimes(1)
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

describe("instant delivery from the giveaway vault (2026-11-08)", () => {
  const auth = { authorization: "Bearer tok" }
  const VAULT = "0x00000000000000cc"
  const FUNDED = { ...DROP, vault_address: VAULT }
  const REPORT = { reserved: 1, sent: 1, tx_ids: ["t".repeat(64)], unknown: [], failed: [] }
  const act = (body: Record<string, unknown>) => adminOne.POST(post(`http://x/api/admin/giveaways/${ID}`, body, auth), idCtx(ID))

  it("the vault actions are admin-only", async () => {
    for (const action of ["fund_plan", "confirm_funding", "vault_send", "vault_return"]) {
      expect((await adminOne.POST(post(`http://x/api/admin/giveaways/${ID}`, { action }), idCtx(ID))).status).toBe(401)
    }
    expect((await adminList.GET(new NextRequest("http://x/api/admin/giveaways?vault=1"))).status).toBe(401)
    expect((await adminList.POST(post("http://x/api/admin/giveaways", { action: "vault_setup" }))).status).toBe(401)
    expect(vault.vaultStatus).not.toHaveBeenCalled()
    expect(vault.setUpVault).not.toHaveBeenCalled()
  })

  it("GET ?vault=1 is the vault status, uncached; vault_setup reports the tx or 'already'", async () => {
    vault.vaultStatus.mockResolvedValueOnce({ configured: false, enabled: false })
    const st = await adminList.GET(new NextRequest("http://x/api/admin/giveaways?vault=1", { headers: auth }))
    expect(await st.json()).toEqual({ configured: false, enabled: false })
    expect(st.headers.get("cache-control")).toBe("no-store")

    vault.setUpVault.mockResolvedValueOnce("a".repeat(64))
    expect(await (await adminList.POST(post("http://x/api/admin/giveaways", { action: "vault_setup" }, auth))).json()).toEqual({ ok: true, tx_id: "a".repeat(64), already: false })
    vault.setUpVault.mockResolvedValueOnce(null)
    expect(await (await adminList.POST(post("http://x/api/admin/giveaways", { action: "vault_setup" }, auth))).json()).toEqual({ ok: true, tx_id: null, already: true })
    vault.setUpVault.mockRejectedValueOnce(new GiveawayError("The giveaway vault is not configured.", 409, "vault_unconfigured"))
    const un = await adminList.POST(post("http://x/api/admin/giveaways", { action: "vault_setup" }, auth))
    expect(un.status).toBe(409)
    expect((await un.json()).code).toBe("vault_unconfigured")
    vault.setUpVault.mockRejectedValueOnce(new FlowScriptError("Flow script HTTP 503", 503))
    expect((await adminList.POST(post("http://x/api/admin/giveaways", { action: "vault_setup" }, auth))).status).toBe(502)
  })

  it("fund_plan: refuses with no vault configured, before any plan is built; else plans INTO the vault", async () => {
    store.getDrop.mockResolvedValue(DROP)
    vault.vaultAddress.mockReturnValueOnce(null)
    const un = await act({ action: "fund_plan", parent: "0x00000000000000bb" })
    expect(un.status).toBe(409)
    expect((await un.json()).code).toBe("vault_unconfigured")
    expect(planFunding).not.toHaveBeenCalled()

    vault.vaultAddress.mockReturnValueOnce(VAULT)
    const plan = { parent: "0x00000000000000bb", child: DROP.admin_wallet, providerControllerID: "70", batches: [], skipped: [] }
    planFunding.mockResolvedValueOnce(plan)
    const res = await act({ action: "fund_plan", parent: " 0x00000000000000BB " })
    expect(await res.json()).toEqual({ ok: true, vault: VAULT, plan })
    expect(planFunding).toHaveBeenCalledWith({}, DROP, "0x00000000000000bb", VAULT)
  })

  it("confirm_funding passes the chain-checked result through; a refusal keeps its code", async () => {
    store.getDrop.mockResolvedValue(DROP)
    vault.confirmFunding.mockResolvedValueOnce({ moved: 4 })
    expect(await (await act({ action: "confirm_funding" })).json()).toEqual({ ok: true, moved: 4 })
    vault.confirmFunding.mockRejectedValueOnce(new GiveawayError("The vault does not hold 2 of the pool's Moments.", 409, "vault_incomplete"))
    const bad = await act({ action: "confirm_funding" })
    expect(bad.status).toBe(409)
    expect((await bad.json()).code).toBe("vault_incomplete")
  })

  it("vault_send / vault_return: 200 only when nothing failed and nothing is unconfirmed", async () => {
    store.getDrop.mockResolvedValue(FUNDED)
    vault.sendFromVault.mockResolvedValueOnce(REPORT)
    const ok = await act({ action: "vault_send" })
    expect(ok.status).toBe(200)
    expect(vault.sendFromVault).toHaveBeenLastCalledWith({}, FUNDED, { returnUnclaimed: false })

    vault.sendFromVault.mockResolvedValueOnce({ ...REPORT, unknown: ["t".repeat(64)] })
    const unk = await act({ action: "vault_send" })
    expect(unk.status).toBe(207)
    expect((await unk.json()).ok).toBe(false)

    vault.sendFromVault.mockResolvedValueOnce({ ...REPORT, sent: 0, failed: [{ moment_ids: ["1"], error: "simulation refused" }] })
    expect((await act({ action: "vault_return" })).status).toBe(207)
    expect(vault.sendFromVault).toHaveBeenLastCalledWith({}, FUNDED, { returnUnclaimed: true })
  })

  it("a claim on a FUNDED drop with the switch on schedules this pack's send — after the response", async () => {
    store.getDrop.mockResolvedValue(FUNDED)
    getCurrentUser.mockResolvedValue({ id: "u1" })
    resolve.mockResolvedValue({ found: true, walletAddress: "0x00000000000000BB", username: "Alice" })
    store.claimPack.mockResolvedValue({ outcome: "claimed", pack_no: 2 })
    vault.instantDeliveryEnabled.mockReturnValue(true)
    vault.sendFromVault.mockResolvedValue(REPORT)
    const res = await publicRoute.POST(post("http://x/api/giveaways/test-drop", { username: "alice", agree: true }), slugCtx("test-drop"))
    expect(res.status).toBe(200)
    expect(vault.sendFromVault).not.toHaveBeenCalled() // not before the response
    expect(afterFns).toHaveLength(1)
    await afterFns[0]()
    expect(vault.sendFromVault).toHaveBeenCalledWith({}, FUNDED, { packNo: 2 })
  })

  it("no send is scheduled for an unfunded drop, with the switch off, or for a repeat claim", async () => {
    getCurrentUser.mockResolvedValue({ id: "u1" })
    resolve.mockResolvedValue({ found: true, walletAddress: "0x00000000000000BB", username: "Alice" })
    const claim = () => publicRoute.POST(post("http://x/api/giveaways/test-drop", { username: "alice", agree: true }), slugCtx("test-drop"))

    vault.instantDeliveryEnabled.mockReturnValue(true)
    store.getDrop.mockResolvedValue(DROP)
    store.claimPack.mockResolvedValue({ outcome: "claimed", pack_no: 2 })
    await claim()
    expect(afterFns).toHaveLength(0)

    vault.instantDeliveryEnabled.mockReturnValue(false)
    store.getDrop.mockResolvedValue(FUNDED)
    await claim()
    expect(afterFns).toHaveLength(0)

    vault.instantDeliveryEnabled.mockReturnValue(true)
    store.claimPack.mockResolvedValue({ outcome: "already_claimed", pack_no: 2 })
    await claim()
    expect(afterFns).toHaveLength(0)
  })

  it("a send that throws after the response is logged, never unhandled", async () => {
    store.getDrop.mockResolvedValue(FUNDED)
    getCurrentUser.mockResolvedValue({ id: "u1" })
    resolve.mockResolvedValue({ found: true, walletAddress: "0x00000000000000BB", username: "Alice" })
    store.claimPack.mockResolvedValue({ outcome: "claimed", pack_no: 2 })
    vault.instantDeliveryEnabled.mockReturnValue(true)
    vault.sendFromVault.mockRejectedValueOnce(new Error("vault key rejected"))
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await publicRoute.POST(post("http://x/api/giveaways/test-drop", { username: "alice", agree: true }), slugCtx("test-drop"))
    await expect(afterFns[0]()).resolves.toBeUndefined()
    expect(log.mock.calls.flat().join(" ")).toContain("vault key rejected")
    log.mockRestore()
  })

  it("a claimer viewing an UNDELIVERED pack of a funded drop retries the send; a delivered one does not", async () => {
    store.getDrop.mockResolvedValue(FUNDED)
    store.getClaims.mockResolvedValue([{ pack_no: 2, user_id: "me", topshot_username: "alice", recipient_address: "0x01", claimed_at: "t" }])
    getCurrentUser.mockResolvedValue({ id: "me" })
    vault.instantDeliveryEnabled.mockReturnValue(true)
    store.getPool.mockResolvedValue([{ moment_id: "2", pack_no: 2, slot: 1, fmv_usd: 3, delivered_at: null, last_checked_at: null }])
    const res = await publicRoute.GET(new NextRequest("http://x/api/giveaways/test-drop"), slugCtx("test-drop"))
    expect((await res.json()).drop.instant_delivery).toBe(true)
    expect(afterFns).toHaveLength(1)

    afterFns.length = 0
    store.getPool.mockResolvedValue([{ moment_id: "2", pack_no: 2, slot: 1, fmv_usd: 3, delivered_at: "t", last_checked_at: "t" }])
    await publicRoute.GET(new NextRequest("http://x/api/giveaways/test-drop"), slugCtx("test-drop"))
    expect(afterFns).toHaveLength(0)
  })
})
