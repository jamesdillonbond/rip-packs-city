import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Route integration tests for the Phase 1 gifting endpoints:
//   /api/gift/quote, /api/gift/children, /api/gift/record
// All three are requireUser-gated. We exercise the REAL lib/chains/flow/gift
// reads (proxy call + JSON-CDC decode) by mocking global fetch to return canned
// base64 responses — so gift.ts's encode/decode paths are covered, not stubbed.

// gift.ts reads INGEST_SECRET_TOKEN at import time — set it before imports.
vi.hoisted(() => {
  process.env.INGEST_SECRET_TOKEN = "test-proxy-secret";
});

const state: {
  user: any;
  quoteNode: any;
  childrenNode: any;
  httpOk: boolean;
} = { user: null, quoteNode: null, childrenNode: null, httpOk: true };

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    return state.user;
  },
}));

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, insert: async () => ({ error: null }), upsert: async () => ({ error: null }),
      or: () => b, ilike: () => b, eq: () => b, not: () => b, limit: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    return b;
  };
  const client: any = { from: () => build() };
  return { supabase: client, supabaseAdmin: client };
});

import { POST as QUOTE } from "@/app/api/gift/quote/route";
import { POST as CHILDREN } from "@/app/api/gift/children/route";
import { POST as RECORD } from "@/app/api/gift/record/route";

const A = "0xaa40b06e5c62d145";
const CHILD = "0xf0b0962e08150ca3";
const RECIP = "0x0b2a3299cc857e29";

// --- JSON-CDC builders -------------------------------------------------------
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const dictNode = (entries: Record<string, { type: string; value: unknown }>) => ({
  type: "Dictionary",
  value: Object.entries(entries).map(([k, v]) => ({
    key: { type: "String", value: k }, value: v,
  })),
});
const arrAddr = (addrs: string[]) => ({
  type: "Array", value: addrs.map((a) => ({ type: "Address", value: a })),
});
const goodQuoteDict = () =>
  dictNode({
    parent_has_manager: { type: "Bool", value: true },
    child_is_linked: { type: "Bool", value: true },
    provider_controller_exists: { type: "Bool", value: true },
    provider_controller_id: { type: "UInt64", value: "76" },
    withdraw_permitted: { type: "Bool", value: true },
    child_owns_moment: { type: "Bool", value: true },
    recipient_ready: { type: "Bool", value: true },
  });

// fetch mock: decode the posted Cadence, pick the canned response.
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
    if (!state.httpOk) {
      return { ok: false, status: 502, text: async () => "boom" } as any;
    }
    const body = JSON.parse(init.body);
    const cadence = Buffer.from(body.script, "base64").toString();
    const node = cadence.includes(": [Address] {")
      ? state.childrenNode
      : state.quoteNode;
    // worker returns the Flow REST /v1/scripts shape: a JSON string of base64
    return { ok: true, status: 200, text: async () => JSON.stringify(b64(node)) } as any;
  }));
}

const req = (body?: any, throws = false) =>
  ({ json: async () => { if (throws) throw new Error("bad json"); return body; } }) as any;

beforeEach(() => {
  state.user = null;
  state.quoteNode = null;
  state.childrenNode = null;
  state.httpOk = true;
  installFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/gift/quote", () => {
  it("401s when unauthenticated", async () => {
    const res = await QUOTE(req({ parentAddress: A, childAddress: CHILD, momentId: "1", recipient: RECIP }));
    expect(res.status).toBe(401);
  });

  it("400s on bad address", async () => {
    state.user = { id: "u1" };
    const res = await QUOTE(req({ parentAddress: "nope", childAddress: CHILD, momentId: "1", recipient: RECIP }));
    expect(res.status).toBe(400);
  });

  it("400s on non-numeric momentId", async () => {
    state.user = { id: "u1" };
    const res = await QUOTE(req({ parentAddress: A, childAddress: CHILD, momentId: "abc", recipient: RECIP }));
    expect(res.status).toBe(400);
  });

  it("returns ok:false recipient_is_sender when recipient == child", async () => {
    state.user = { id: "u1" };
    const res = await QUOTE(req({ parentAddress: A, childAddress: CHILD, momentId: "1", recipient: CHILD }));
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.reason).toBe("recipient_is_sender");
  });

  it("returns ok:false moment_not_owned when the chain says so", async () => {
    state.user = { id: "u1" };
    const d = goodQuoteDict();
    // flip child_owns_moment to false
    d.value.find((e: any) => e.key.value === "child_owns_moment")!.value = { type: "Bool", value: false };
    state.quoteNode = d;
    const res = await QUOTE(req({ parentAddress: A, childAddress: CHILD, momentId: "1", recipient: RECIP }));
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.reason).toBe("moment_not_owned");
  });

  it("returns ok:true args on the happy path (real decode)", async () => {
    state.user = { id: "u1" };
    state.quoteNode = goodQuoteDict();
    const res = await QUOTE(req({ parentAddress: A, childAddress: CHILD, momentId: "51492551", recipient: RECIP }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.args.providerControllerID).toBe(76);
    expect(j.args.recipient).toBe(RECIP);
    expect(j.recipientReady).toBe(true);
  });

  it("502s when the proxy read fails", async () => {
    state.user = { id: "u1" };
    state.httpOk = false;
    const res = await QUOTE(req({ parentAddress: A, childAddress: CHILD, momentId: "1", recipient: RECIP }));
    expect(res.status).toBe(502);
  });
});

describe("POST /api/gift/children", () => {
  it("401s when unauthenticated", async () => {
    const res = await CHILDREN(req({ parentAddress: A }));
    expect(res.status).toBe(401);
  });

  it("400s on bad address", async () => {
    state.user = { id: "u1" };
    const res = await CHILDREN(req({ parentAddress: "x" }));
    expect(res.status).toBe(400);
  });

  it("returns children on success (real decode)", async () => {
    state.user = { id: "u1" };
    state.childrenNode = arrAddr([CHILD]);
    const res = await CHILDREN(req({ parentAddress: A }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.children).toEqual([CHILD]);
  });
});

describe("POST /api/gift/record", () => {
  it("401s when unauthenticated", async () => {
    const res = await RECORD(req({ parentAddress: A, childAddress: CHILD, recipient: RECIP, momentId: "1" }));
    expect(res.status).toBe(401);
  });

  it("400s when required fields missing", async () => {
    state.user = { id: "u1" };
    const res = await RECORD(req({ parentAddress: A }));
    expect(res.status).toBe(400);
  });

  it("200s on a valid submitted record", async () => {
    state.user = { id: "u1" };
    const res = await RECORD(req({
      txId: "abc123", parentAddress: A, childAddress: CHILD, recipient: RECIP,
      momentId: "51492551", status: "submitted",
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
  });
});
