import { NextRequest, NextResponse } from "next/server";
import {
  getChainId,
  getBlockNumber,
  getGasPriceWei,
  getExpectedChainId,
  SUPPORTED_CHAIN_SLUGS,
  type ChainSlug,
} from "@/lib/evm-rpc";

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

function isSupportedChain(value: string): value is ChainSlug {
  return (SUPPORTED_CHAIN_SLUGS as string[]).includes(value);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const requested = req.nextUrl.searchParams.get("chain") ?? "flow_evm_mainnet";
  if (!isSupportedChain(requested)) {
    return NextResponse.json(
      {
        error: `Unsupported chain: ${requested}`,
        supported: SUPPORTED_CHAIN_SLUGS,
      },
      { status: 400 }
    );
  }
  const chainSlug: ChainSlug = requested;
  const expectedChainId = getExpectedChainId(chainSlug);

  const started = Date.now();
  const result: Record<string, unknown> = {
    ok: false,
    chain: chainSlug,
    expectedChainId,
  };

  try {
    const [chainId, blockNumber, gasPriceWei] = await Promise.all([
      getChainId(chainSlug),
      getBlockNumber(chainSlug),
      getGasPriceWei(chainSlug),
    ]);

    const latencyMs = Date.now() - started;
    const chainIdMatches = chainId === expectedChainId;
    const gasPriceGwei = Number(gasPriceWei) / 1e9;

    result.ok = chainIdMatches;
    result.chainId = chainId;
    result.chainIdMatches = chainIdMatches;
    result.blockNumber = blockNumber;
    result.gasPriceWei = gasPriceWei.toString();
    result.gasPriceGwei = gasPriceGwei;
    result.latencyMs = latencyMs;
    if (!chainIdMatches) {
      result.error = `Expected chain_id ${expectedChainId}, got ${chainId}`;
    }

    return NextResponse.json(result, { status: chainIdMatches ? 200 : 500 });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.latencyMs = Date.now() - started;
    return NextResponse.json(result, { status: 500 });
  }
}
