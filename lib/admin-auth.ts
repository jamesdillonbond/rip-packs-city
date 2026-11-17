// lib/admin-auth.ts
// Bearer-token check for the Trevor-only /admin/* API routes.
// Deny-by-default: a missing or empty RPC_ADMIN_TOKEN env var means every
// request is rejected, so a misconfigured deployment fails closed.
//
// Accepts the token ONLY as `Authorization: Bearer <token>` (the path the admin
// UI uses via lib/admin-token.ts). The `?token=<token>` query form was retired
// 2026-11-04 (R133: zero callers in 10 days of logs).

import { NextRequest, NextResponse } from "next/server";
import { bearerMatches, tokenMatches } from "@/lib/auth/bearer-secret";
import { verifyAdminSession } from "@/lib/admin-session";

export function verifyAdminRequest(req: NextRequest): boolean {
  // Constant-time, fail-closed (lib/auth/bearer-secret.ts; review S4 2026-10-11).
  // R133 (2026-11-04): the `?token=` form is RETIRED — `[admin-auth] query-token
  // used` logged zero lines 2026-10-25 → 11-04 (Vercel runtime logs). Header only.
  return bearerMatches(req.headers.get("authorization"), "RPC_ADMIN_TOKEN");
}

export function adminUnauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * A bare credential VALUE (a cookie, a form field) — the master token or an
 * unexpired session signed with it (R134 step 2). Constant-time, fail-closed.
 */
export function isAdminCredential(value: string | null | undefined): boolean {
  if (tokenMatches(value, "RPC_ADMIN_TOKEN")) return true;
  return verifyAdminSession(value, process.env.RPC_ADMIN_TOKEN);
}
