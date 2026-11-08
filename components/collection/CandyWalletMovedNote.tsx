// components/collection/CandyWalletMovedNote.tsx
//
// Candy MLB only (2026-11-08). In October Candy locked every collectible after
// SOL was drained from its custodial wallets, then moved every card into a new
// per-user Candy Wallet (powered by MoonPay). A collector who searches the
// address they used before October now finds nothing here — correctly, the
// cards left that address — and the empty state alone reads as "you own no
// ICONs". This note says what happened and asks for the NEW address only.
//
// ⛔ Identifier only (RPC never asks for codes, seed phrases or a wallet
// connection — Candy users are an active phishing target; see
// docs/audits/2026-11-04-ciso-security-audit.md).

export const CANDY_WALLET_MOVED_COPY =
  "Searching the wallet you used before October? Candy moved every collectible to a new Candy Wallet (powered by MoonPay) during its October security lock, so older addresses now hold nothing. Paste your new Candy Wallet address above — you can copy it from wallet.candy.io. RPC only needs the address; never share a sign-in code or recovery phrase with anyone."

export default function CandyWalletMovedNote() {
  return (
    <div
      data-testid="candy-wallet-moved-note"
      className="mt-2 text-xs"
      style={{ color: "var(--rpc-text-muted)", lineHeight: 1.6, maxWidth: 640, marginInline: "auto" }}
    >
      {CANDY_WALLET_MOVED_COPY}
    </div>
  )
}
