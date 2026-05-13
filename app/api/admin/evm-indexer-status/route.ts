// app/api/admin/evm-indexer-status/route.ts
//
// Per-contract status snapshot for the generic ERC-721 indexer.
// Returns cursor position, lag from sealed tip, total transfers indexed,
// last advance time. Lets us verify cursor advancement is healthy after a
// cron tick.
//
// Auth: Bearer RPC_ADMIN_TOKEN (also accepts ?token=).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getBlockNumber,
  SUPPORTED_CHAIN_SLUGS,
  type ChainSlug,
} from "@/lib/evm-rpc";

export const dynamic = "force-dynamic";

const CHAIN_SLUG_BY_ID: Record<number, ChainSlug> = {
  747: "flow_evm_mainnet",
  8453: "base_mainnet",
};

function authorized(req: NextRequest): boolean {
  const expected = process.env.RPC_ADMIN_TOKEN;
  if (!expected) return false;
  const bearer = req.headers.get("authorization");
  if (bearer && bearer.startsWith("Bearer ") && bearer.slice(7) === expected) {
    return true;
  }
  const qp = req.nextUrl.searchParams.get("token");
  return qp === expected;
}

interface ContractRow {
  chain_id: number;
  contract_address: string;
  label: string;
  start_block: number;
  is_active: boolean;
}

interface CursorRow {
  chain_id: number;
  contract_address: string;
  last_processed_block: number;
  last_advanced_at: string;
  total_transfers_indexed: number;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: contracts, error: contractsErr } = await (supabaseAdmin as any)
    .from("evm_nft_contracts")
    .select("chain_id, contract_address, label, start_block, is_active")
    .order("id", { ascending: true });

  if (contractsErr) {
    return NextResponse.json(
      { ok: false, error: `registry_read_failed: ${contractsErr.message}` },
      { status: 500 }
    );
  }

  const rows = (contracts ?? []) as ContractRow[];
  const { data: cursorRows, error: cursorErr } = await (supabaseAdmin as any)
    .from("evm_indexer_cursors")
    .select("chain_id, contract_address, last_processed_block, last_advanced_at, total_transfers_indexed");

  if (cursorErr) {
    return NextResponse.json(
      { ok: false, error: `cursor_read_failed: ${cursorErr.message}` },
      { status: 500 }
    );
  }

  const cursorByKey = new Map<string, CursorRow>();
  for (const cr of (cursorRows ?? []) as CursorRow[]) {
    cursorByKey.set(`${cr.chain_id}:${cr.contract_address.toLowerCase()}`, cr);
  }

  // Pull sealed tip once per distinct chain.
  const activeChainIds = Array.from(
    new Set(rows.filter((r) => r.is_active).map((r) => r.chain_id))
  );
  const tipByChain = new Map<number, number | null>();
  await Promise.all(
    activeChainIds.map(async (cid) => {
      const slug = CHAIN_SLUG_BY_ID[cid];
      if (!slug || !(SUPPORTED_CHAIN_SLUGS as string[]).includes(slug)) {
        tipByChain.set(cid, null);
        return;
      }
      try {
        const tip = await getBlockNumber(slug);
        tipByChain.set(cid, tip);
      } catch {
        tipByChain.set(cid, null);
      }
    })
  );

  const contractsOut = rows.map((c) => {
    const key = `${c.chain_id}:${c.contract_address.toLowerCase()}`;
    const cursor = cursorByKey.get(key) ?? null;
    const tip = tipByChain.has(c.chain_id) ? tipByChain.get(c.chain_id)! : null;
    const lastBlock = cursor ? Number(cursor.last_processed_block) : c.start_block - 1;
    const lag = tip !== null ? tip - lastBlock : null;
    return {
      chain_id: c.chain_id,
      chain_slug: CHAIN_SLUG_BY_ID[c.chain_id] ?? null,
      contract_address: c.contract_address,
      label: c.label,
      is_active: c.is_active,
      start_block: c.start_block,
      cursor_block: lastBlock,
      sealed_tip: tip,
      lag_blocks: lag,
      cursor_initialized: cursor !== null,
      total_transfers_indexed: cursor ? Number(cursor.total_transfers_indexed) : 0,
      last_advanced_at: cursor ? cursor.last_advanced_at : null,
    };
  });

  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    contracts: contractsOut,
  });
}
