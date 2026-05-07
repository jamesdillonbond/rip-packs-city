// lib/admin-auth.ts
// Bearer-token check for the Trevor-only /admin/* API routes.
// Deny-by-default: a missing or empty RPC_ADMIN_TOKEN env var means every
// request is rejected, so a misconfigured deployment fails closed.
//
// Accepts the token either as `Authorization: Bearer <token>` (the canonical
// path used by the admin UI via lib/admin-token.ts) or as a `?token=<token>`
// query string (the path cron-job.org GET probes use, since cron-job.org
// can't easily set arbitrary headers).

import { NextRequest, NextResponse } from "next/server";

export function verifyAdminRequest(req: NextRequest): boolean {
  const expected = process.env.RPC_ADMIN_TOKEN;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${expected}`) return true;
  const queryToken = req.nextUrl.searchParams.get("token");
  return queryToken === expected;
}

export function adminUnauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
