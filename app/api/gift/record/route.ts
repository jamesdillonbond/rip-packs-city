// app/api/gift/record/route.ts
//
// Records a gift transaction for analytics/audit after the client submits (and
// optionally after it seals). Service-role write into moment_gifts. Requires a
// signed-in allow-listed user; user_id is server-resolved, never client-supplied.
//
//   POST { txId, parentAddress, childAddress, momentId, recipient,
//          momentTitle?, serial?, editionExternalId?, recipientLabel?,
//          status?('submitted'|'sealed'|'failed'), error? }
//
// Upserts on txId so a later 'sealed'/'failed' update replaces the 'submitted' row.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";

const ADDR_RE = /^0x[0-9a-f]{16}$/;

function normAddr(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  return ADDR_RE.test(t) ? t : null;
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const parent = normAddr(body?.parentAddress);
  const child = normAddr(body?.childAddress);
  const recipient = normAddr(body?.recipient);
  const momentId =
    typeof body?.momentId === "string" || typeof body?.momentId === "number"
      ? String(body.momentId).trim()
      : null;

  if (!parent || !child || !recipient || !momentId || !/^\d{1,20}$/.test(momentId)) {
    return NextResponse.json({ ok: false, error: "parent/child/recipient/momentId required" }, { status: 400 });
  }

  const status = ["submitted", "sealed", "failed"].includes(body?.status) ? body.status : "submitted";
  const serial =
    typeof body?.serial === "number" && Number.isFinite(body.serial) ? Math.trunc(body.serial) : null;

  const row = {
    user_id: user.id,
    parent_addr: parent,
    child_addr: child,
    moment_id: momentId,
    edition_external_id: typeof body?.editionExternalId === "string" ? body.editionExternalId : null,
    moment_title: typeof body?.momentTitle === "string" ? body.momentTitle.slice(0, 200) : null,
    serial_number: serial,
    recipient_addr: recipient,
    recipient_label: typeof body?.recipientLabel === "string" ? body.recipientLabel.slice(0, 80) : null,
    tx_id: typeof body?.txId === "string" && body.txId ? body.txId.slice(0, 128) : null,
    status,
    error: typeof body?.error === "string" ? body.error.slice(0, 300) : null,
    sealed_at: status === "sealed" ? new Date().toISOString() : null,
  };

  // Upsert on tx_id when present (submitted -> sealed/failed); else plain insert.
  if (row.tx_id) {
    const { error } = await supabase
      .from("moment_gifts")
      .upsert(row, { onConflict: "tx_id" });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  } else {
    const { error } = await supabase.from("moment_gifts").insert(row);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
