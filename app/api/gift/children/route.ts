// app/api/gift/children/route.ts
//
// Live per-connected-wallet discovery of a parent's Hybrid-Custody child
// accounts, read on-chain (NOT from the linked_accounts index, which only holds
// RPC's discovered subset). Requires a signed-in allow-listed user.
//
//   POST { parentAddress }  ->  200 { ok:true, children:[ "0x…", … ] }
//
// The returned children are the accounts this parent can gift moments out of.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase-server";
import { runLinkedChildren } from "@/lib/chains/flow/gift";

const ADDR_RE = /^0x[0-9a-f]{16}$/;

export async function POST(req: NextRequest) {
  try {
    await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const parent = typeof body?.parentAddress === "string" ? body.parentAddress.trim().toLowerCase() : "";
  if (!ADDR_RE.test(parent)) {
    return NextResponse.json({ ok: false, error: "parentAddress (0x…16) required" }, { status: 400 });
  }

  try {
    const children = await runLinkedChildren(parent);
    return NextResponse.json({ ok: true, parent, children });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "chain_read_failed", detail: String(e?.message ?? e).slice(0, 160) },
      { status: 502 },
    );
  }
}
