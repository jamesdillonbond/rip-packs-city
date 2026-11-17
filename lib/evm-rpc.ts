const SUPPORTED_CHAINS = {
  flow_evm_mainnet: {
    chainId: 747,
    legacyEnvPrefix: "FLOWEVM",
    // Flow EVM mainnet publishes a free, keyless, read-only JSON-RPC endpoint.
    // A proxy still WINS when configured (below) — this is only the fallback.
    //
    // ⛔ Why this exists: requiring a proxy for public read-only chain data kept
    // an entire built pipeline dark. `EVM_PROXY_URL_FLOW_EVM_MAINNET` is present
    // but its value is 2 characters — effectively blank — so every Flow EVM call
    // threw at config time, `evm_nft_transfers` sat at 0 rows, and no `%evm%`
    // pipeline ever recorded a single start. Failing closed protects a secret;
    // there is no secret here, so it bought darkness and nothing else.
    publicRpcUrl: "https://mainnet.evm.nodes.onflow.org",
  },
  base_mainnet: {
    chainId: 8453,
    legacyEnvPrefix: null,
    // ⚠ Deliberately none. Base is rate-limit sensitive and the proxy is what
    // carries the quota; it must keep failing closed rather than silently
    // hammering a public endpoint.
    publicRpcUrl: null,
  },
} as const;

export type ChainSlug = keyof typeof SUPPORTED_CHAINS;

export const SUPPORTED_CHAIN_SLUGS: ChainSlug[] = Object.keys(
  SUPPORTED_CHAINS
) as ChainSlug[];

export function getExpectedChainId(slug: ChainSlug): number {
  return SUPPORTED_CHAINS[slug].chainId;
}

function envVarName(slug: ChainSlug, kind: "URL" | "SECRET"): string {
  return `EVM_PROXY_${kind}_${slug.toUpperCase()}`;
}

function legacyEnvVarName(slug: ChainSlug, kind: "URL" | "SECRET"): string | null {
  const prefix = SUPPORTED_CHAINS[slug].legacyEnvPrefix;
  if (!prefix) return null;
  return `${prefix}_PROXY_${kind}`;
}

function getProxyConfig(slug: ChainSlug): { url: string; secret: string | null } {
  const primaryUrlVar = envVarName(slug, "URL");
  const primarySecretVar = envVarName(slug, "SECRET");
  const legacyUrlVar = legacyEnvVarName(slug, "URL");
  const legacySecretVar = legacyEnvVarName(slug, "SECRET");

  const url =
    process.env[primaryUrlVar] ||
    (legacyUrlVar ? process.env[legacyUrlVar] : undefined);
  const secret =
    process.env[primarySecretVar] ||
    (legacySecretVar ? process.env[legacySecretVar] : undefined);

  if (!url || !secret) {
    // Proxy incomplete — fall back to a public endpoint if this chain has one.
    // Both halves must be present to use the proxy: a URL without its secret
    // would send unauthenticated requests to a private proxy and 401.
    const publicUrl = SUPPORTED_CHAINS[slug].publicRpcUrl;
    if (publicUrl) return { url: publicUrl, secret: null };

    const tried = legacyUrlVar
      ? `${primaryUrlVar} or ${legacyUrlVar}`
      : primaryUrlVar;
    throw new Error(
      `EVM proxy not configured for ${slug}. Set ${tried} and matching secret env var.`
    );
  }
  return { url, secret };
}

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
};

type JsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

let requestId = 0;
function nextId(): number {
  requestId = (requestId + 1) % 1_000_000;
  return requestId;
}

async function evmCall<T>(
  chainSlug: ChainSlug,
  method: string,
  params: unknown[] = []
): Promise<T> {
  const { url, secret } = getProxyConfig(chainSlug);
  const payload: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: nextId(),
    method,
    params,
  };
  // Only send the proxy secret to a proxy. On the public fallback there is no
  // secret, and attaching a header named like one to a third-party endpoint is
  // how credentials leak to hosts that were never meant to see them.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret !== null) headers["X-Proxy-Secret"] = secret;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(
      `${chainSlug} ${secret === null ? "public RPC" : "proxy"} returned ${res.status}: ${await res.text()}`
    );
  }
  const json = (await res.json()) as JsonRpcResponse<T>;
  if (json.error) {
    throw new Error(
      `${chainSlug} JSON-RPC error ${json.error.code}: ${json.error.message}`
    );
  }
  if (json.result === undefined) {
    throw new Error(`${chainSlug} JSON-RPC returned no result and no error`);
  }
  return json.result;
}

function hexToNumber(hex: string): number {
  return Number.parseInt(hex, 16);
}

function hexToBigInt(hex: string): bigint {
  return BigInt(hex);
}

export async function getChainId(chainSlug: ChainSlug): Promise<number> {
  const hex = await evmCall<string>(chainSlug, "eth_chainId");
  return hexToNumber(hex);
}

export async function getBlockNumber(chainSlug: ChainSlug): Promise<number> {
  const hex = await evmCall<string>(chainSlug, "eth_blockNumber");
  return hexToNumber(hex);
}

export async function getGasPriceWei(chainSlug: ChainSlug): Promise<bigint> {
  const hex = await evmCall<string>(chainSlug, "eth_gasPrice");
  return hexToBigInt(hex);
}

export async function getBalanceWei(
  chainSlug: ChainSlug,
  address: string,
  block: string = "latest"
): Promise<bigint> {
  const hex = await evmCall<string>(chainSlug, "eth_getBalance", [
    address,
    block,
  ]);
  return hexToBigInt(hex);
}

export type EthCallParams = {
  to: string;
  data: string;
  from?: string;
};

export async function ethCall(
  chainSlug: ChainSlug,
  params: EthCallParams,
  block: string = "latest"
): Promise<string> {
  return await evmCall<string>(chainSlug, "eth_call", [params, block]);
}

export type GetLogsFilter = {
  fromBlock?: string;
  toBlock?: string;
  address?: string | string[];
  topics?: (string | string[] | null)[];
};

export type EvmLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  logIndex: string;
  removed: boolean;
  blockTimestamp?: string;
};

export async function getLogs(
  chainSlug: ChainSlug,
  filter: GetLogsFilter
): Promise<EvmLog[]> {
  return await evmCall<EvmLog[]>(chainSlug, "eth_getLogs", [filter]);
}

export type EvmBlockHeader = {
  number: string;
  hash: string;
  timestamp: string;
};

export async function getBlockByNumber(
  chainSlug: ChainSlug,
  blockNumberHex: string
): Promise<EvmBlockHeader | null> {
  return await evmCall<EvmBlockHeader | null>(
    chainSlug,
    "eth_getBlockByNumber",
    [blockNumberHex, false]
  );
}
