import { describe, it, expect, beforeEach, vi } from "vitest"

// Unit tests for lib/alerts.ts — the service-role wrapper around the
// omni-channel alerts DB functions. Pins the pure guards (isChannel / CHANNELS /
// COLLECTION_UUID_BY_SLUG) exactly, then drives every RPC wrapper by mocking
// @/lib/supabase: asserting the RPC name + arg mapping and both the success and
// error return shapes (null / {error} / [] / sentinel fallbacks). Also covers
// the resolveChannelOwnerUsername saved_wallets -> profile_bio -> null ladder
// and its best-effort catch.

const state: {
  rpcCalls: Array<{ name: string; args: any }>
  rpcResults: Record<string, { data: any; error: any }>
  fromResults: Record<string, any>
} = { rpcCalls: [], rpcResults: {}, fromResults: {} }

vi.mock("@/lib/supabase", () => {
  const client: any = {
    rpc: async (name: string, args: any) => {
      state.rpcCalls.push({ name, args })
      return state.rpcResults[name] ?? { data: null, error: null }
    },
    from: (table: string) => {
      const b: any = {}
      for (const m of ["select", "eq", "in", "order", "limit", "is", "not", "ilike", "gte", "lt", "neq"]) {
        b[m] = () => b
      }
      b.maybeSingle = async () => {
        const r = state.fromResults[table]
        if (r === "THROW") throw new Error("boom-from")
        return r ?? { data: null, error: null }
      }
      b.then = (resolve: any) => resolve(state.fromResults[table] ?? { data: null, error: null })
      return b
    },
  }
  return { supabase: client, supabaseAdmin: client }
})

import {
  isChannel,
  CHANNELS,
  COLLECTION_UUID_BY_SLUG,
  createChannelLinkCode,
  claimChannelLink,
  resolveChannelOwner,
  resolveChannelOwnerUsername,
  getOwnerChannelTargets,
  buildDealAlertsForSubscription,
  dispatchDueDealAlerts,
  dispatchTriggeredFmvAlerts,
  claimPendingDeliveries,
  markDeliverySent,
  markDeliveryFailed,
} from "@/lib/alerts"

beforeEach(() => {
  state.rpcCalls = []
  state.rpcResults = {}
  state.fromResults = {}
})

const lastCall = () => state.rpcCalls[state.rpcCalls.length - 1]

describe("pure guards + constants", () => {
  it("isChannel accepts only the three known channels", () => {
    expect(isChannel("email")).toBe(true)
    expect(isChannel("telegram")).toBe(true)
    expect(isChannel("discord")).toBe(true)
    expect(isChannel("twitter")).toBe(false)
    expect(isChannel("")).toBe(false)
    expect(isChannel(5)).toBe(false)
    expect(isChannel(null)).toBe(false)
    expect(isChannel(undefined)).toBe(false)
    expect(isChannel({})).toBe(false)
  })

  it("CHANNELS is the canonical ordered list", () => {
    expect(CHANNELS).toEqual(["email", "telegram", "discord"])
  })

  it("COLLECTION_UUID_BY_SLUG carries the five published collection UUIDs", () => {
    expect(COLLECTION_UUID_BY_SLUG.nba_top_shot).toBe("95f28a17-224a-4025-96ad-adf8a4c63bfd")
    expect(COLLECTION_UUID_BY_SLUG.nfl_all_day).toBe("dee28451-5d62-409e-a1ad-a83f763ac070")
    expect(COLLECTION_UUID_BY_SLUG.laliga_golazos).toBe("06248cc4-b85f-47cd-af67-1855d14acd75")
    expect(COLLECTION_UUID_BY_SLUG.ufc_strike).toBe("9b4824a8-736d-4a96-b450-8dcc0c46b023")
    expect(COLLECTION_UUID_BY_SLUG.disney_pinnacle).toBe("7dd9dd11-e8b6-45c4-ac99-71331f959714")
    expect(Object.keys(COLLECTION_UUID_BY_SLUG)).toHaveLength(5)
  })
})

describe("createChannelLinkCode", () => {
  it("maps args (channelUserId defaults to null) and returns data on success", async () => {
    const payload = { ok: true, channel: "email", code: "AB12CD34", expires_at: "2026-01-01T00:00:00Z" }
    state.rpcResults["create_channel_link_code"] = { data: payload, error: null }
    const out = await createChannelLinkCode("owner-1", "email")
    expect(out).toEqual(payload)
    expect(lastCall()).toEqual({
      name: "create_channel_link_code",
      args: { p_owner_key: "owner-1", p_channel: "email", p_channel_user_id: null },
    })
  })

  it("passes a provided channelUserId through", async () => {
    state.rpcResults["create_channel_link_code"] = { data: { ok: true }, error: null }
    await createChannelLinkCode("owner-1", "email", "user@example.com")
    expect(lastCall().args.p_channel_user_id).toBe("user@example.com")
  })

  it("returns null on RPC error", async () => {
    state.rpcResults["create_channel_link_code"] = { data: null, error: { message: "nope" } }
    expect(await createChannelLinkCode("owner-1", "telegram")).toBeNull()
  })
})

describe("claimChannelLink", () => {
  it("maps args and returns data on success", async () => {
    state.rpcResults["claim_channel_link"] = { data: { ok: true, owner_key: "u9", channel: "telegram" }, error: null }
    const out = await claimChannelLink("telegram", "tg-123", "tguser", "CODE1234")
    expect(out).toEqual({ ok: true, owner_key: "u9", channel: "telegram" })
    expect(lastCall()).toEqual({
      name: "claim_channel_link",
      args: { p_channel: "telegram", p_channel_user_id: "tg-123", p_channel_username: "tguser", p_code: "CODE1234" },
    })
  })

  it("returns {error: server_error} on RPC error", async () => {
    state.rpcResults["claim_channel_link"] = { data: null, error: { message: "db down" } }
    expect(await claimChannelLink("telegram", "tg-123", null, "CODE1234")).toEqual({ error: "server_error" })
  })
})

describe("resolveChannelOwner", () => {
  it("returns data on success", async () => {
    state.rpcResults["resolve_channel_owner"] = { data: { linked: true, owner_key: "u1" }, error: null }
    const out = await resolveChannelOwner("discord", "dc-1")
    expect(out).toEqual({ linked: true, owner_key: "u1" })
    expect(lastCall()).toEqual({
      name: "resolve_channel_owner",
      args: { p_channel: "discord", p_channel_user_id: "dc-1" },
    })
  })

  it("returns {linked:false} on RPC error", async () => {
    state.rpcResults["resolve_channel_owner"] = { data: null, error: { message: "err" } }
    expect(await resolveChannelOwner("discord", "dc-1")).toEqual({ linked: false })
  })
})

describe("resolveChannelOwnerUsername", () => {
  it("returns null when the channel is not linked", async () => {
    state.rpcResults["resolve_channel_owner"] = { data: { linked: false }, error: null }
    expect(await resolveChannelOwnerUsername("telegram", "tg-1")).toBeNull()
  })

  it("returns lowercased saved_wallets username when present", async () => {
    state.rpcResults["resolve_channel_owner"] = { data: { linked: true, owner_key: "u1" }, error: null }
    state.fromResults["saved_wallets"] = { data: { username: "TrevorX" }, error: null }
    expect(await resolveChannelOwnerUsername("telegram", "tg-1")).toBe("trevorx")
  })

  it("falls back to profile_bio username when saved_wallets has none", async () => {
    state.rpcResults["resolve_channel_owner"] = { data: { linked: true, owner_key: "u1" }, error: null }
    state.fromResults["saved_wallets"] = { data: null, error: null }
    state.fromResults["profile_bio"] = { data: { username: "BioHandle" }, error: null }
    expect(await resolveChannelOwnerUsername("telegram", "tg-1")).toBe("biohandle")
  })

  it("returns null when neither source has a username", async () => {
    state.rpcResults["resolve_channel_owner"] = { data: { linked: true, owner_key: "u1" }, error: null }
    state.fromResults["saved_wallets"] = { data: null, error: null }
    state.fromResults["profile_bio"] = { data: null, error: null }
    expect(await resolveChannelOwnerUsername("telegram", "tg-1")).toBeNull()
  })

  it("swallows errors and returns null (best-effort)", async () => {
    state.rpcResults["resolve_channel_owner"] = { data: { linked: true, owner_key: "u1" }, error: null }
    state.fromResults["saved_wallets"] = "THROW"
    expect(await resolveChannelOwnerUsername("telegram", "tg-1")).toBeNull()
  })
})

describe("getOwnerChannelTargets", () => {
  it("returns rows on success and maps a null channel", async () => {
    const rows = [{ channel: "email", channel_user_id: "a@b.co", channel_username: null }]
    state.rpcResults["get_owner_channel_targets"] = { data: rows, error: null }
    expect(await getOwnerChannelTargets("owner-1")).toEqual(rows)
    expect(lastCall()).toEqual({
      name: "get_owner_channel_targets",
      args: { p_owner_key: "owner-1", p_channel: null },
    })
  })

  it("passes an explicit channel through", async () => {
    state.rpcResults["get_owner_channel_targets"] = { data: [], error: null }
    await getOwnerChannelTargets("owner-1", "discord")
    expect(lastCall().args.p_channel).toBe("discord")
  })

  it("returns [] on error", async () => {
    state.rpcResults["get_owner_channel_targets"] = { data: null, error: { message: "x" } }
    expect(await getOwnerChannelTargets("owner-1")).toEqual([])
  })

  it("returns [] when data is null on success", async () => {
    state.rpcResults["get_owner_channel_targets"] = { data: null, error: null }
    expect(await getOwnerChannelTargets("owner-1")).toEqual([])
  })
})

describe("buildDealAlertsForSubscription", () => {
  it("returns data on success", async () => {
    state.rpcResults["build_deal_alerts_for_subscription"] = { data: { deals_count: 2, deals: [] }, error: null }
    expect(await buildDealAlertsForSubscription("sub-1")).toEqual({ deals_count: 2, deals: [] })
    expect(lastCall()).toEqual({
      name: "build_deal_alerts_for_subscription",
      args: { p_subscription_id: "sub-1" },
    })
  })

  it("returns null on error", async () => {
    state.rpcResults["build_deal_alerts_for_subscription"] = { data: null, error: { message: "x" } }
    expect(await buildDealAlertsForSubscription("sub-1")).toBeNull()
  })
})

describe("dispatchDueDealAlerts", () => {
  it("returns data with the default max", async () => {
    state.rpcResults["dispatch_due_deal_alerts"] = { data: { subscriptions_scanned: 3, enqueued: 1 }, error: null }
    expect(await dispatchDueDealAlerts()).toEqual({ subscriptions_scanned: 3, enqueued: 1 })
    expect(lastCall()).toEqual({ name: "dispatch_due_deal_alerts", args: { p_max: 1000 } })
  })

  it("returns {error: message} on error and honors a custom max", async () => {
    state.rpcResults["dispatch_due_deal_alerts"] = { data: null, error: { message: "kaboom" } }
    expect(await dispatchDueDealAlerts(50)).toEqual({ error: "kaboom" })
    expect(lastCall().args.p_max).toBe(50)
  })
})

describe("dispatchTriggeredFmvAlerts", () => {
  it("returns data with the default max", async () => {
    state.rpcResults["dispatch_triggered_fmv_alerts"] = { data: { scanned: 5, enqueued: 2 }, error: null }
    expect(await dispatchTriggeredFmvAlerts()).toEqual({ scanned: 5, enqueued: 2 })
    expect(lastCall()).toEqual({ name: "dispatch_triggered_fmv_alerts", args: { p_max: 200 } })
  })

  it("returns {error: message} on error", async () => {
    state.rpcResults["dispatch_triggered_fmv_alerts"] = { data: null, error: { message: "fail" } }
    expect(await dispatchTriggeredFmvAlerts(10)).toEqual({ error: "fail" })
  })
})

describe("claimPendingDeliveries", () => {
  it("returns the claimed batch with the default max", async () => {
    const batch = { channel: "email", count: 2, deliveries: [{ id: "d1" }, { id: "d2" }] }
    state.rpcResults["claim_pending_deliveries"] = { data: batch, error: null }
    expect(await claimPendingDeliveries("email")).toEqual(batch)
    expect(lastCall()).toEqual({ name: "claim_pending_deliveries", args: { p_channel: "email", p_max: 50 } })
  })

  it("returns an empty batch sentinel on error", async () => {
    state.rpcResults["claim_pending_deliveries"] = { data: null, error: { message: "x" } }
    expect(await claimPendingDeliveries("telegram", 5)).toEqual({ channel: "telegram", count: 0, deliveries: [] })
    expect(lastCall().args.p_max).toBe(5)
  })
})

describe("markDeliverySent / markDeliveryFailed", () => {
  it("markDeliverySent calls the RPC with the id", async () => {
    state.rpcResults["mark_delivery_sent"] = { error: null }
    await markDeliverySent("del-1")
    expect(lastCall()).toEqual({ name: "mark_delivery_sent", args: { p_id: "del-1" } })
  })

  it("markDeliverySent swallows an RPC error", async () => {
    state.rpcResults["mark_delivery_sent"] = { error: { message: "x" } }
    await expect(markDeliverySent("del-1")).resolves.toBeUndefined()
  })

  it("markDeliveryFailed truncates the error message to 500 chars", async () => {
    state.rpcResults["mark_delivery_failed"] = { error: null }
    await markDeliveryFailed("del-2", "e".repeat(900))
    expect(lastCall().name).toBe("mark_delivery_failed")
    expect(lastCall().args.p_id).toBe("del-2")
    expect(lastCall().args.p_error).toHaveLength(500)
  })

  it("markDeliveryFailed swallows an RPC error", async () => {
    state.rpcResults["mark_delivery_failed"] = { error: { message: "x" } }
    await expect(markDeliveryFailed("del-2", "short")).resolves.toBeUndefined()
  })
})
