// app/api/wallet/capability/route.ts
//
// Resolves what a connected Flow wallet is allowed to DO, from
// public.v_wallet_capability_tier (Hybrid-Custody parent => advanced/transacting;
// Dapper-custodial child => read-only). See lib/wallet-capability.ts.
//
//   POST { address }  ->  200 { ok:true, capability:{ tier, role, canTransact, … } }
//
// Sign-in required: this reads the wallet-link graph,
// which is internal (the view is anon-SELECT-revoked and read via supabaseAdmin).
// The route is NOT in proxy.ts's PUBLIC_READ_APIS, so it is gated there too.
//
// ⚠ A wallet absent from the index resolves to tier "unknown", NOT "read_only" —
// never treat a 502 or an unknown tier as a denial.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase-server";
import { getWalletCapability } from "@/lib/wallet-capability";

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

  try {
    const capability = await getWalletCapability(body?.address);
    return NextResponse.json({ ok: true, capability });
  } catch (e: any) {
    // Logged, never published: this is upstream Flow/Cadence text, and truncating
    // it to 160 chars made it shorter, not safe. The 502 is kept deliberately —
    // it says the failure is upstream, which is what tells an operator whether
    // WE broke; routing this through apiErrorResponse would flatten it to 500.
    console.log("[wallet/capability] read failed:", String(e?.message ?? e).slice(0, 300));
    return NextResponse.json(
      { ok: false, error: "capability_read_failed" },
      { status: 502 },
    );
  }
}
