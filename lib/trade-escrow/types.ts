// NEXT_STEPS — Off-chain types for the RPCTradeEscrow trade-chain pipeline.
// Mirrors §3 (transaction signatures) and §4 (trade_chain_state table) of
// RPCTradeEscrow_DEPLOYMENT.md at the repo root. The contract address is
// supplied at runtime via the RPC_TRADE_ESCROW_ADDRESS env var; this file
// does not import it.
//
// CollectionMeta values come straight from §3a (type identifiers) and the
// §3b storage/public path table. Keep in lockstep with that doc when the
// contract is deployed and per-collection deposit transactions are wired.

// Short-form collection slugs used in flowty_*-style tables. Matches the
// SHORT-form vocabulary documented in RPC_DESIGN_SYSTEM.md §4.
export type TradeCollection = "topshot" | "allday" | "pinnacle" | "golazos" | "ufc";

export type ChainTradeStatus =
  | "proposed"
  | "partial_a"
  | "partial_b"
  | "ready"
  | "executed"
  | "cancelled"
  | "expired"
  | "failed";

// Row shape of public.trade_chain_state. Column names are snake_case to match
// the table — the API routes pass these through to/from Supabase unchanged.
// Note: PostgreSQL folds unquoted identifiers to lowercase, so columns named
// `partyA_*` in the SQL DDL are addressed as `partya_*` from the JS client.
// See RPCTradeEscrow_DEPLOYMENT.md §4 for the source SQL.
export interface TradeChainState {
  id: string;
  trade_match_id: string;
  chain_trade_id: number | null;
  partya_address: string;
  partyb_address: string;
  partya_nft_type: string;
  partyb_nft_type: string;
  partya_expected_ids: number[];
  partyb_expected_ids: number[];
  expires_at: string;
  propose_tx_id: string | null;
  partya_deposit_tx_id: string | null;
  partyb_deposit_tx_id: string | null;
  execute_tx_id: string | null;
  cancel_tx_id: string | null;
  status: ChainTradeStatus;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CollectionMeta {
  slug: TradeCollection;
  nft_type_identifier: string;
  storage_path: string;
  public_path: string;
  collection_uuid: string;
}

// Mainnet values — source of truth is RPCTradeEscrow_DEPLOYMENT.md §3a (type
// identifiers) and §3b (storage/public paths). Collection UUIDs are from
// RPC_DESIGN_SYSTEM.md §4. On-chain verification done 2026-05-13 via
// rest-mainnet.onflow.org — see the verification banner at the top of the
// deployment guide.
//
// Note on storage_path / public_path strings: TopShot uses literal paths;
// the other four collections expose `<Contract>.CollectionStoragePath` and
// `CollectionPublicPath` access(all) constants. The §3b deposit-tx
// templates should reference those Cadence constants directly rather than
// passing the literal strings. The values below are kept for dev/QA
// display only (see TradeChainPanel debug footer) and as best-effort
// fallbacks if a transaction template ever needs the resolved path
// string. They mirror the conventional values these constants resolve to
// but are NOT canonical — the Cadence constants are.
export const COLLECTION_META: Record<TradeCollection, CollectionMeta> = {
  topshot: {
    slug: "topshot",
    nft_type_identifier: "A.0b2a3299cc857e29.TopShot.NFT",
    storage_path: "/storage/MomentCollection",
    public_path: "/public/MomentCollection",
    collection_uuid: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  },
  allday: {
    slug: "allday",
    nft_type_identifier: "A.e4cf4bdc1751c65d.AllDay.NFT",
    storage_path: "/storage/AllDayNFTCollection",
    public_path: "/public/AllDayNFTCollection",
    collection_uuid: "dee28451-5d62-409e-a1ad-a83f763ac070",
  },
  pinnacle: {
    slug: "pinnacle",
    nft_type_identifier: "A.edf9df96c92f4595.Pinnacle.NFT",
    storage_path: "/storage/PinnacleNFTCollection",
    public_path: "/public/PinnacleNFTCollection",
    collection_uuid: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
  },
  golazos: {
    slug: "golazos",
    // Address verified 2026-05-13 against the Supabase `collections` row.
    // The original deployment-doc draft had 0x87ca73a41bb50c5e — a typo;
    // correct mainnet address ends in `ad5`.
    nft_type_identifier: "A.87ca73a41bb50ad5.Golazos.NFT",
    storage_path: "/storage/GolazosNFTCollection",
    public_path: "/public/GolazosNFTCollection",
    collection_uuid: "06248cc4-b85f-47cd-af67-1855d14acd75",
  },
  ufc: {
    slug: "ufc",
    nft_type_identifier: "A.329feb3ab062d289.UFC_NFT.NFT",
    storage_path: "/storage/UFC_NFTCollection",
    public_path: "/public/UFC_NFTCollection",
    collection_uuid: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
  },
};

const UUID_TO_SLUG = new Map<string, TradeCollection>(
  (Object.values(COLLECTION_META) as CollectionMeta[]).map((m) => [m.collection_uuid, m.slug])
);

// Resolve a `collections.id` UUID to a short-form TradeCollection slug.
// Returns null if the UUID does not match one of the 5 supported collections.
export function collectionFromUuid(uuid: string | null | undefined): TradeCollection | null {
  if (!uuid) return null;
  return UUID_TO_SLUG.get(uuid) ?? null;
}

// Strongly-typed transaction submission args — mirrored by lib/trade-escrow/
// fcl-submit.ts. Numeric on-chain IDs are kept as strings on the wire because
// UInt64 / numeric Cadence args must be `String(v)` per RPC_DESIGN_SYSTEM.md
// §8 and the auto-memory note on Flow REST encoding.

export interface ProposeTradeArgs {
  partyA: string;
  partyB: string;
  partyA_nft_type: string;
  partyB_nft_type: string;
  partyA_expected_ids: string[];
  partyB_expected_ids: string[];
  expires_at_unix_sec: string;
}

export interface DepositToTradeArgs {
  chain_trade_id: string;
  depositor: string;
  side: "A" | "B";
  nft_ids: string[];
  collection: TradeCollection;
  // The other party's NFT type — the depositor must already have a receiver
  // capability at COLLECTION_META[other].public_path. Pre-checked client-side.
  incoming_collection: TradeCollection;
}

export interface ExecuteSwapArgs {
  chain_trade_id: string;
}

export interface CancelTradeArgs {
  chain_trade_id: string;
  cancelled_by: string;
  reason: string;
}

export interface ReclaimExpiredArgs {
  chain_trade_id: string;
}

export interface SubmittedTx {
  tx_id: string;
  sealed: boolean;
}
