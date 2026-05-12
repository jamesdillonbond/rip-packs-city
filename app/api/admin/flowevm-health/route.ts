import { NextRequest, NextResponse } from "next/server";
import { getChainId, getBlockNumber, getGasPriceWei, FLOW_EVM_MAINNET_CHAIN_ID } from "@/lib/flowevm-rpc";

export const dynamic = "force-dynamic";

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

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const result: Record<string, unknown> = {
    ok: false,
    expectedChainId: FLOW_EVM_MAINNET_CHAIN_ID,
  };

  try {
    const [chainId, blockNumber, gasPriceWei] = await Promise.all([
      getChainId(),
      getBlockNumber(),
      getGasPriceWei(),
    ]);

    const latencyMs = Date.now() - started;
    const chainIdMatches = chainId === FLOW_EVM_MAINNET_CHAIN_ID;
    const gasPriceGwei = Number(gasPriceWei) / 1e9;

    result.ok = chainIdMatches;
    result.chainId = chainId;
    result.chainIdMatches = chainIdMatches;
    result.blockNumber = blockNumber;
    result.gasPriceWei = gasPriceWei.toString();
    result.gasPriceGwei = gasPriceGwei;
    result.latencyMs = latencyMs;
    if (!chainIdMatches) {
      result.error = `Expected chain_id ${FLOW_EVM_MAINNET_CHAIN_ID}, got ${chainId}`;
    }

    return NextResponse.json(result, { status: chainIdMatches ? 200 : 500 });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.latencyMs = Date.now() - started;
    return NextResponse.json(result, { status: 500 });
  }
}
