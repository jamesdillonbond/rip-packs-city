// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import PackSimulatorClient from "@/app/(collections)/[collection]/packs/simulator/[distId]/PackSimulatorClient"
import ApiKeysClient from "@/app/dashboard/api-keys/ApiKeysClient"

// Two more client pages converted to `*Client.tsx` so the component gate measures them.
//
// ⚠ THE SIMULATOR CARRIED A LIVE DEFECT and it is the strongest form of this class: the
// false claim is SPECIFIC and it CONCLUDES. On any failure — a 503, a route-level `error`,
// a thrown fetch — it rendered "Drop pool not indexed — usually because it's sold out and
// being secondary-traded", a factual claim about the collector's pack manufactured entirely
// from our own outage. And it is a dead end: it says the simulator will never work for this
// pack, so they leave rather than retry. `error` was set only by the catch, so every non-2xx
// fell straight through to it.
//
// `ApiKeysClient` was already CLEAN (it consults `loadError` before its empty state), so
// there it is coverage rather than a fix — recorded so nobody re-sweeps it.

// ApiKeysClient mounts MobileNav + SupportChatConnected, which reach for the app router;
// without this the whole describe dies on "invariant expected app router to be mounted",
// which reads like a component fault rather than a missing harness.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/dashboard/api-keys",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}))

vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}))

const TS = "nba-top-shot"

function json(status: number, body: unknown, ok = status < 400) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

const POOL = [
  {
    edition_id: "e1", edition_slug: "lillard", player_name: "Damian Lillard", set_name: "Archive",
    tier: "legendary", circulation_count: 1000, thumbnail_url: null, drop_weight: 1,
    hit_probability: 0.5, fmv_usd: 600,
  },
  {
    edition_id: "e2", edition_slug: "curry", player_name: "Stephen Curry", set_name: "Base",
    tier: "common", circulation_count: 12000, thumbnail_url: null, drop_weight: 1,
    hit_probability: 0.5, fmv_usd: 5,
  },
]

const SIM = (over: Record<string, unknown> = {}) => ({
  pack: {
    dist_id: "77", title: "Series 5 Base", image_url: null, pack_type: "base", tier: null,
    slots: 2, retail_price_usd: 9, total_minted: 100, total_opened: 40, total_sealed: 60,
    depletion_pct: 40,
  },
  pool: POOL,
  metrics: {
    ev_per_slot: 302.5, edition_count_pullable: 2, fmv_coverage_pct: 100,
    prob_grail_25_per_slot: 0.5, prob_grail_100_per_slot: 0.5,
    prob_grail_500_per_slot: 0.5, prob_grail_1000_per_slot: 0,
    grails_25: 1, grails_100: 1, grails_500: 1, grails_1000: 0,
    max_pull_fmv: 600, max_pull_player: "Damian Lillard", max_pull_tier: "legendary",
    max_pull_thumbnail: null,
  },
  ...over,
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
describe("PackSimulatorClient — failed read vs un-indexed pool", () => {
  const mount = (r: () => Response | Promise<Response>) => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => r()))
    render(<PackSimulatorClient collectionSlug={TS} distId="77" />)
  }

  // ⚠ THE DEFECT. Three failure shapes, one assertion each, because they reach the branch
  // by three different routes and only one of them was ever going to be noticed.
  it.each([
    // ⚠ THE FIRST CASE CARRIES NO `error` FIELD, DELIBERATELY. A 503 whose body is an HTML
    // error page or an empty object is the realistic shape, and with a fixture that also
    // set `json.error` the two halves of `!res.ok || json.error` MASKED EACH OTHER —
    // mutation-confirmed: dropping the `!res.ok` half left the suite green.
    ["a non-2xx with no error field", () => json(503, {}, false)],
    ["a non-2xx carrying an error field", () => json(503, { error: "unavailable" }, false)],
    ["a 200 carrying a route-level error", () => json(200, { error: "statement timeout" })],
    ["a thrown fetch", () => { throw new Error("network down") }],
  ])("does not claim the pool is un-indexed after %s", async (_label, r) => {
    mount(r as () => Response)
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn’t load this pack/))
    expect(document.body.textContent).not.toMatch(/Drop pool not indexed/)
    expect(document.body.textContent).not.toMatch(/sold out and being secondary-traded/)
    // The copy must leave a retry open — the un-indexed copy is terminal by design.
    expect(document.body.textContent).toMatch(/try again/i)
  })

  // ⚠ THE MIRROR DIRECTION. An OK response with an empty pool IS the un-indexed case, and
  // it must keep saying so — a fix that turns every empty state into "couldn't load" only
  // moves the dishonesty and cries wolf on the system working correctly.
  it("still says the pool is un-indexed when the read succeeded with an empty pool", async () => {
    mount(() => json(200, { ...SIM(), pool: [] }))
    await waitFor(() => expect(document.body.textContent).toMatch(/Drop pool not indexed/))
    expect(document.body.textContent).not.toMatch(/Couldn’t load this pack/)
  })

  it("treats an unknown collection slug as a fact about the URL, not a read failure", async () => {
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => json(200, SIM()))
    vi.stubGlobal("fetch", f)
    render(<PackSimulatorClient collectionSlug="not-a-collection" distId="77" />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Drop pool not indexed/))
    // And it must not have gone to the network at all — there is no collection to ask about.
    expect(f).not.toHaveBeenCalled()
  })
})

describe("PackSimulatorClient — the simulation", () => {
  const mount = async (payload: unknown = SIM()) => {
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => json(200, payload))
    vi.stubGlobal("fetch", f)
    render(<PackSimulatorClient collectionSlug={TS} distId="77" />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    return f
  }

  it("requests the pool for the collection's UUID, not its slug", async () => {
    const f = await mount()
    const url = String(f.mock.calls[0][0])
    // The route keys on a UUID; sending the slug returns nothing and the page would render
    // the un-indexed claim about a perfectly well-indexed pack.
    expect(url).toMatch(/collectionId=[0-9a-f]{8}-[0-9a-f]{4}/)
    expect(url).toMatch(/distId=77/)
  })

  it("renders the pack header and its metrics", async () => {
    await mount()
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/PACK RIP SIMULATOR/)
    expect(body).toMatch(/Damian Lillard/)
    expect(body).toMatch(/2 editions/)
  })

  // ⚠ A pack whose slot count is unknown is APPROXIMATED at 5, and the approximation is
  // disclosed with a "~". Without the marker a collector reads a made-up slot count as the
  // pack's real one, and every EV figure below it inherits that.
  it("marks an approximated slot count rather than presenting it as known", async () => {
    await mount(SIM({ pack: { ...SIM().pack, slots: null } }))
    await waitFor(() => expect(document.body.textContent).toMatch(/5 ~/))
  })

  it("does not mark a slot count the pack actually carries", async () => {
    await mount()
    expect(document.body.textContent).not.toMatch(/2 ~/)
  })

  it("renders an em-dash rather than a number for an unknown depletion", async () => {
    await mount(SIM({ pack: { ...SIM().pack, depletion_pct: null, retail_price_usd: null } }))
    await waitFor(() => expect(document.body.textContent).toMatch(/Series 5 Base/))
    expect(document.body.textContent).toMatch(/—/)
  })

  // ── The rip aggregate ──────────────────────────────────────────────────────
  // ⚠ THE FMV-COVERAGE LINE IS THE HONEST HALF OF THE WHOLE SIMULATOR. Slots pulled without
  // an FMV count as $0 toward the pack value, so an un-priced pool produces a simulated
  // value that is a FLOOR, not an estimate — and a collector reading "Avg pack value $2.50"
  // against a $9 retail decides not to buy. The disclosure is what makes that number
  // interpretable.
  it("discloses how many simulated pulls carried an FMV", async () => {
    await mount(SIM({
      pool: [{ ...POOL[0], fmv_usd: null }, { ...POOL[1], fmv_usd: null }],
      metrics: { ...SIM().metrics, fmv_coverage_pct: 0 },
    }))
    fireEvent.click(screen.getAllByRole("button").find((b) => /rip 1 pack/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/0 \/ 2 pulls had FMV/))
  })

  it("does not print the coverage caveat when every pull was priced", async () => {
    await mount()
    fireEvent.click(screen.getAllByRole("button").find((b) => /rip 1 pack/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Aggregate/))
    expect(document.body.textContent).not.toMatch(/pulls had FMV/)
  })

  // ⚠ 10 and 100 rips take a DIFFERENT animation path from a single rip (the 1–10 branch
  // steps the flip index one slot at a time; above 10 it jumps straight to the end), so a
  // test that only ever rips once leaves the whole large-run path unmeasured.
  it("aggregates a 100-rip run and reports the slot count", async () => {
    await mount()
    fireEvent.click(screen.getAllByRole("button").find((b) => /rip 100/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Aggregate · 100 rips · 200 slots/))
    expect(document.body.textContent).toMatch(/Avg pack value/)
    expect(document.body.textContent).toMatch(/Std dev/)
  })

  it("uses the singular for a single rip", async () => {
    await mount()
    fireEvent.click(screen.getAllByRole("button").find((b) => /rip 1 pack/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Aggregate · 1 rip · 2 slots/))
    expect(document.body.textContent).not.toMatch(/1 rips/)
  })

  // ⚠ "% beat retail" is the buy/no-buy number, and it MUST be withheld when the pack has no
  // retail price — a reward pack has none, and computing against 0 would report that every
  // rip beat retail.
  it("withholds the beat-retail rate for a pack with no retail price", async () => {
    await mount(SIM({ pack: { ...SIM().pack, retail_price_usd: null } }))
    fireEvent.click(screen.getAllByRole("button").find((b) => /rip 1 pack/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Aggregate/))
    expect(document.body.textContent).not.toMatch(/% beat retail/)
  })

  it("reports the beat-retail rate when the pack has one", async () => {
    await mount()
    fireEvent.click(screen.getAllByRole("button").find((b) => /rip 10\b/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/% beat retail/))
  })

  it("counts threshold and tier hits across a run", async () => {
    await mount()
    fireEvent.click(screen.getAllByRole("button").find((b) => /rip 100/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Aggregate/))
    // The pool is one $600 LEGENDARY and one $5 COMMON at equal weight, so a 200-slot run
    // must record legendary and $500+ hits; a run recording none would mean the sampler is
    // returning one edition only.
    expect(document.body.textContent).toMatch(/Legendary/)
    expect(document.body.textContent).toMatch(/\$500\+/)
  })

  it("resets the run", async () => {
    await mount()
    fireEvent.click(screen.getAllByRole("button").find((b) => /rip 1 pack/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Aggregate/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /^reset$/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).not.toMatch(/Aggregate/))
  })

  it("renders the pool note and the computed-at stamp when the payload carries them", async () => {
    await mount(SIM({ note: "pool sampled at index time", computed_at: new Date().toISOString() }))
    expect(document.body.textContent).toMatch(/pool sampled at index time/)
    expect(document.body.textContent).toMatch(/Pool computed:/)
  })

  it("rips a pack and reports as many pulls as the pack has slots", async () => {
    await mount()
    const rip = screen.getAllByRole("button").find((b) => /^rip 1\b/i.test(b.textContent ?? ""))
      ?? screen.getAllByRole("button").find((b) => /rip 1/i.test(b.textContent ?? ""))!
    fireEvent.click(rip)
    // Both editions carry an FMV, so a 2-slot rip must report full coverage — the number
    // that tells a collector whether the simulated value is complete or a floor.
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard|Stephen Curry/))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("ApiKeysClient", () => {
  const KEY = (over: Record<string, unknown> = {}) => ({
    key_id: "k1",
    key_prefix: "rpc_live_abcd",
    label: "laptop",
    wallet_address: "0xabcdef0123456789",
    created_at: new Date().toISOString(),
    last_used_at: null,
    ...over,
  })

  /**
   * ⚠ ROUTED BY URL AND METHOD, NOT BY CALL SEQUENCE. `ApiKeysClient` mounts MobileNav and
   * SupportChatConnected, which make their own requests, so a positional response array is
   * consumed by whichever component happens to fetch first — the list read then receives a
   * fixture written for the POST, and the failure looks like the page not rendering.
   */
  function mount(opts: { list?: () => Response; post?: () => Response; del?: () => Response }) {
    const f = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? "GET").toUpperCase()
      if (url.includes("/api/mcp/keys")) {
        if (method === "POST") return (opts.post ?? (() => json(200, {})))()
        if (method === "DELETE") return (opts.del ?? (() => json(200, { ok: true })))()
        return (opts.list ?? (() => json(200, { ok: true, keys: [] })))()
      }
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<ApiKeysClient />)
    return f
  }

  it("lists the keys it loaded", async () => {
    mount({ list: () => json(200, { ok: true, keys: [KEY(), KEY({ key_id: "k2", key_prefix: "rpc_live_wxyz", label: null })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/rpc_live_abcd/))
    expect(document.body.textContent).toMatch(/rpc_live_wxyz/)
    expect(document.body.textContent).toMatch(/laptop/)
  })

  // ⚠ Already correct before the conversion, pinned so it stays that way. "No keys yet.
  // Click Create new key to issue one." is a claim about the reader's own account, and it
  // INVITES A DUPLICATE — the same shape as the /alerts defect this repo has already paid
  // for. Here the duplicate is a live credential.
  it.each([
    ["a 401", () => json(401, {}, false), /sign in/i],
    ["a non-2xx", () => json(500, { error: "boom" }, false), /boom/],
    ["ok:false at HTTP 200", () => json(200, { ok: false, error: "not authorised" }), /not authorised/],
  ])("does not say the account has no keys after %s", async (_l, r, expected) => {
    mount({ list: r as () => Response })
    await waitFor(() => expect(document.body.textContent).toMatch(expected as RegExp))
    expect(document.body.textContent).not.toMatch(/No keys yet/)
  })

  it("does not say the account has no keys after a thrown fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => {
      throw new Error("network down")
    }))
    render(<ApiKeysClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/network down/))
    expect(document.body.textContent).not.toMatch(/No keys yet/)
  })

  it("does say the account has no keys when the read succeeded and returned none", async () => {
    mount({ list: () => json(200, { ok: true, keys: [] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/No keys yet/))
  })

  it("shows the raw key exactly once, on creation", async () => {
    const f = mount({
      list: () => json(200, { ok: true, keys: [] }),
      post: () => json(200, { key_id: "k9", raw_key: "rpc_live_SECRETVALUE", key_prefix: "rpc_live_SECR", wallet_address: "0xabc", label: "ci" }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/No keys yet/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /create new key/i.test(b.textContent ?? ""))!)
    fireEvent.click(screen.getAllByRole("button").find((b) => /^generate/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/rpc_live_SECRETVALUE/))
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true)
  })

  // ⚠ An incomplete issuance response must NOT be presented as a created key. A row would
  // appear for a credential the caller never received, and they cannot tell it apart from
  // one they simply failed to copy.
  it("refuses an issuance response missing the raw key", async () => {
    mount({
      list: () => json(200, { ok: true, keys: [] }),
      post: () => json(200, { key_id: "k9", key_prefix: "rpc_live_SECR", wallet_address: "0xabc" }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/No keys yet/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /create new key/i.test(b.textContent ?? ""))!)
    fireEvent.click(screen.getAllByRole("button").find((b) => /^generate/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/incomplete response/i))
  })

  it("states an issuance failure rather than silently closing", async () => {
    mount({
      list: () => json(200, { ok: true, keys: [] }),
      post: () => json(429, { message: "rate limited" }, false),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/No keys yet/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /create new key/i.test(b.textContent ?? ""))!)
    fireEvent.click(screen.getAllByRole("button").find((b) => /^generate/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/rate limited/))
  })

  it("asks before revoking, and does nothing when the operator declines", async () => {
    const f = mount({ list: () => json(200, { ok: true, keys: [KEY()] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/rpc_live_abcd/))
    vi.stubGlobal("confirm", vi.fn(() => false))
    const before = f.mock.calls.length
    fireEvent.click(screen.getAllByRole("button").find((b) => /revoke/i.test(b.textContent ?? ""))!)
    expect(f.mock.calls.length).toBe(before)
    expect(document.body.textContent).toMatch(/rpc_live_abcd/)
  })

  // ⚠ THE OPTIMISTIC REMOVAL MUST BE ROLLED BACK. Revocation is irreversible and the row is
  // dropped before the server answers, so a failed DELETE that left the row hidden would
  // tell the reader a live credential is dead — they stop rotating it, and it keeps working.
  it("restores the row when the revoke fails", async () => {
    mount({
      list: () => json(200, { ok: true, keys: [KEY()] }),
      del: () => json(500, { error: "revoke failed" }, false),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/rpc_live_abcd/))
    vi.stubGlobal("confirm", vi.fn(() => true))
    fireEvent.click(screen.getAllByRole("button").find((b) => /revoke/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/revoke failed/))
    expect(document.body.textContent).toMatch(/rpc_live_abcd/)
    // And it must not have fallen through to the empty state, which would read as "you have
    // no keys" after a failure to remove one.
    expect(document.body.textContent).not.toMatch(/No keys yet/)
  })

  it("keeps the row removed when the revoke succeeds", async () => {
    mount({
      list: () => json(200, { ok: true, keys: [KEY()] }),
      del: () => json(200, { ok: true }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/rpc_live_abcd/))
    vi.stubGlobal("confirm", vi.fn(() => true))
    fireEvent.click(screen.getAllByRole("button").find((b) => /revoke/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).not.toMatch(/rpc_live_abcd/))
  })

  it("percent-encodes the key id in the revoke URL", async () => {
    const f = mount({
      list: () => json(200, { ok: true, keys: [KEY({ key_id: "a/b?c" })] }),
      del: () => json(200, { ok: true }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/rpc_live_abcd/))
    vi.stubGlobal("confirm", vi.fn(() => true))
    fireEvent.click(screen.getAllByRole("button").find((b) => /revoke/i.test(b.textContent ?? ""))!)
    await waitFor(() =>
      expect(f.mock.calls.some((c) => String(c[0]).includes("a%2Fb%3Fc"))).toBe(true),
    )
    // The un-encoded form would address a different path entirely.
    expect(f.mock.calls.every((c) => !String(c[0]).endsWith("/a/b?c"))).toBe(true)
  })

  // ── The row's own fields ───────────────────────────────────────────────────
  // ⚠ "Never" is a real state and must not read as a formatting failure: a key that has
  // never been used is exactly what an operator looks for before revoking one.
  it.each([
    ["never used", null, /Never/],
    ["seconds", new Date(Date.now() - 5_000).toISOString(), /\d+s ago/],
    ["minutes", new Date(Date.now() - 5 * 60_000).toISOString(), /\d+m ago/],
    ["hours", new Date(Date.now() - 5 * 3_600_000).toISOString(), /\d+h ago/],
    ["days", new Date(Date.now() - 5 * 86_400_000).toISOString(), /\d+d ago/],
    ["months", new Date(Date.now() - 120 * 86_400_000).toISOString(), /\d+mo ago/],
  ])("renders last-used as %s", async (_l, iso, expected) => {
    mount({ list: () => json(200, { ok: true, keys: [KEY({ last_used_at: iso })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(expected as RegExp))
  })

  // A clock-skewed future timestamp must not render as a negative age, which reads as a
  // corrupted record rather than a fresh one.
  it("renders a future last-used as 'Just now' rather than a negative age", async () => {
    mount({ list: () => json(200, { ok: true, keys: [KEY({ last_used_at: new Date(Date.now() + 60_000).toISOString() })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Just now/))
    expect(document.body.textContent).not.toMatch(/-\d/)
  })

  // ⚠ The wallet is TRUNCATED for display, never altered. Showing head and tail is what lets
  // an operator recognise their own address; a middle-elided form that dropped the tail would
  // make two of Trevor's wallets indistinguishable.
  it("truncates a long wallet to head and tail, and leaves a short one alone", async () => {
    mount({ list: () => json(200, { ok: true, keys: [KEY({ wallet_address: "0x1234567890abcdef" })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/0x1234…cdef/))
    cleanup()
    mount({ list: () => json(200, { ok: true, keys: [KEY({ key_id: "k2", wallet_address: "0xabc" })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/0xabc/))
  })

  // ── The created-key modal ──────────────────────────────────────────────────
  async function issue(post: () => Response) {
    const f = mount({ list: () => json(200, { ok: true, keys: [] }), post })
    await waitFor(() => expect(document.body.textContent).toMatch(/No keys yet/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /create new key/i.test(b.textContent ?? ""))!)
    fireEvent.click(screen.getAllByRole("button").find((b) => /^generate/i.test(b.textContent ?? ""))!)
    return f
  }
  const ISSUED = () => json(200, {
    key_id: "k9", raw_key: "rpc_live_SECRETVALUE", key_prefix: "rpc_live_SECR",
    wallet_address: "0x1234567890abcdef", label: "ci",
  })

  // ⚠ The one-time warning is the entire contract of this modal. Without it a collector
  // closes the dialog assuming they can come back for the key, and the credential is gone.
  it("warns that the key is shown only once", async () => {
    await issue(ISSUED)
    await waitFor(() => expect(document.body.textContent).toMatch(/only time you.{0,3}ll see this key/i))
  })

  // Until 2026-09-03 this shell closed only by backdrop click. It now shares
  // lib/hooks/useModalA11y with every other dialog: Escape closes, focus lands inside.
  it("Escape closes the create-key dialog", async () => {
    mount({ list: () => json(200, { ok: true, keys: [] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/No keys yet/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /create new key/i.test(b.textContent ?? ""))!)
    const dialog = await waitFor(() => screen.getByRole("dialog"))
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("copies the raw key and confirms it", async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    await issue(ISSUED)
    await waitFor(() => expect(document.body.textContent).toMatch(/rpc_live_SECRETVALUE/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /copy to clipboard/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Copied to clipboard/))
    // ⚠ The RAW key, never the prefix — a confirmed copy of the wrong string is worse than
    // no copy, because the reader stops looking at the screen.
    expect(writeText).toHaveBeenCalledWith("rpc_live_SECRETVALUE")
  })

  // ⚠ A failed clipboard write must NOT confirm. This is the only moment the key exists on
  // screen, so a false "Copied" sends them away without it.
  it("does not claim a copy that failed, and says what to do instead", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => { throw new Error("denied") }) },
      configurable: true,
    })
    await issue(ISSUED)
    await waitFor(() => expect(document.body.textContent).toMatch(/rpc_live_SECRETVALUE/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /copy to clipboard/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/select the text manually/i))
    expect(document.body.textContent).not.toMatch(/✓ Copied to clipboard/)
  })

  it("reloads the list after a key was created, so the new row appears", async () => {
    const f = await issue(ISSUED)
    await waitFor(() => expect(document.body.textContent).toMatch(/rpc_live_SECRETVALUE/))
    const listReads = () => f.mock.calls.filter(
      (c) => String(c[0]).includes("/api/mcp/keys") && ((c[1] as RequestInit | undefined)?.method ?? "GET") === "GET",
    ).length
    const before = listReads()
    fireEvent.click(screen.getAllByRole("button").find((b) => /^done|^close/i.test(b.textContent ?? ""))
      ?? screen.getAllByRole("button")[screen.getAllByRole("button").length - 1])
    await waitFor(() => expect(listReads()).toBeGreaterThan(before))
  })

  // Cancelling before generating must NOT reload — there is nothing new to show, and a
  // needless refetch on a page an operator opens repeatedly is pure cost.
  it("does not reload when the modal is cancelled without generating", async () => {
    const f = mount({ list: () => json(200, { ok: true, keys: [] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/No keys yet/))
    const before = f.mock.calls.length
    fireEvent.click(screen.getAllByRole("button").find((b) => /create new key/i.test(b.textContent ?? ""))!)
    fireEvent.click(screen.getAllByRole("button").find((b) => /^cancel$/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/No keys yet/))
    expect(f.mock.calls.length).toBe(before)
  })

  it("sends the typed label, and omits it when blank rather than sending an empty string", async () => {
    const f = mount({ list: () => json(200, { ok: true, keys: [] }), post: ISSUED })
    await waitFor(() => expect(document.body.textContent).toMatch(/No keys yet/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /create new key/i.test(b.textContent ?? ""))!)
    fireEvent.click(screen.getAllByRole("button").find((b) => /^generate/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true))
    const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({})
  })
})

