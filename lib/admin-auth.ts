// lib/admin-auth.ts
// Bearer-token check for the Trevor-only /admin/* API routes.
// Deny-by-default: a missing or empty RPC_ADMIN_TOKEN env var means every
// request is rejected, so a misconfigured deployment fails closed.

import { NextRequest, NextResponse } from "next/server";

export function verifyAdminRequest(req: NextRequest): boolean {
  const expected = process.env.RPC_ADMIN_TOKEN;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${expected}`;
}

export function adminUnauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
