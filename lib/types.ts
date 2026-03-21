export type Badge = {
  type: string;
  iconSvg: string;
};

export type MarketMoment = {
  momentId: string;
  flowId: string | null;
  flowSerialNumber: number | null;
  topshotAsk: number | null;
  flowtyAsk: number | null;
  bestAsk: number | null;
  bestMarket: "Top Shot" | "Flowty" | null;
  lastPurchasePrice: number | null;
  tier: string | null;
  isLocked: boolean | null;
  lockExpiryAt: string | null;
  badges: Badge[];
  editionId: string | null;
  flowtyListingUrl: string | null;
  updatedAt: string | null;
};

export type ResolvedUser = {
  input: string;
  walletAddress: string | null;
  username: string | null;
  dapperId: string | null;
  inputType: "wallet" | "username";
};

export type WalletMoment = {
  momentId: number;
  playerName: string;
  setName: string;
  series: number | null;
  serial: number | null;
  mintSize: number | null;
  flowId: string | null;
  tier: string | null;
  isLocked: boolean;
  lockExpiryAt: string | null;
  badges: Badge[];
  editionId: string | null;
  editionOwnedCount: number;
  topshotAsk: number | null;
  flowtyAsk: number | null;
  bestAsk: number | null;
  bestMarket: "Top Shot" | "Flowty" | null;
  lastPurchasePrice: number | null;
  flowtyListingUrl: string | null;
  updatedAt: string | null;
  thumbnailUrl: string | null;
  specialSerials: Array<"#1 Serial" | "Perfect Mint">;
};