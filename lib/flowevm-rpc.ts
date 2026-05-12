const FLOW_EVM_CHAIN_ID = 747;

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

async function flowEvmCall<T>(method: string, params: unknown[] = []): Promise<T> {
  const url = process.env.FLOWEVM_PROXY_URL;
  const secret = process.env.FLOWEVM_PROXY_SECRET;
  if (!url || !secret) {
    throw new Error("FLOWEVM_PROXY_URL and FLOWEVM_PROXY_SECRET must be set");
  }
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
    throw new Error(`flowevm-proxy returned ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as JsonRpcResponse<T>;
  if (json.error) {
    throw new Error(`Flow EVM JSON-RPC error ${json.error.code}: ${json.error.message}`);
  }
  if (json.result === undefined) {
    throw new Error("Flow EVM JSON-RPC returned no result and no error");
  }
  return json.result;
}

function hexToNumber(hex: string): number {
  return Number.parseInt(hex, 16);
}

function hexToBigInt(hex: string): bigint {
  return BigInt(hex);
}

export async function getChainId(): Promise<number> {
  const hex = await flowEvmCall<string>("eth_chainId");
  return hexToNumber(hex);
}

export async function getBlockNumber(): Promise<number> {
  const hex = await flowEvmCall<string>("eth_blockNumber");
  return hexToNumber(hex);
}

export async function getGasPriceWei(): Promise<bigint> {
  const hex = await flowEvmCall<string>("eth_gasPrice");
  return hexToBigInt(hex);
}

export async function getBalanceWei(address: string, block: string = "latest"): Promise<bigint> {
  const hex = await flowEvmCall<string>("eth_getBalance", [address, block]);
  return hexToBigInt(hex);
}

export type EthCallParams = {
  to: string;
  data: string;
  from?: string;
};

export async function ethCall(params: EthCallParams, block: string = "latest"): Promise<string> {
  return await flowEvmCall<string>("eth_call", [params, block]);
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
};

export async function getLogs(filter: GetLogsFilter): Promise<EvmLog[]> {
  return await flowEvmCall<EvmLog[]>("eth_getLogs", [filter]);
}

export const FLOW_EVM_MAINNET_CHAIN_ID = FLOW_EVM_CHAIN_ID;
