const SUPPORTED_CHAINS = {
  flow_evm_mainnet: {
    chainId: 747,
    legacyEnvPrefix: "FLOWEVM",
  },
  base_mainnet: {
    chainId: 8453,
    legacyEnvPrefix: null,
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

function getProxyConfig(slug: ChainSlug): { url: string; secret: string } {
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
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Proxy-Secret": secret,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(
      `${chainSlug} proxy returned ${res.status}: ${await res.text()}`
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
