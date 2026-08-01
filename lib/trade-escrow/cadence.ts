// lib/trade-escrow/cadence.ts
//
// Cadence transaction templates for the RPCTradeEscrow lifecycle, built for
// FCL from three grounded sources:
//   1. the deployed-contract interface in cadence/contracts/RPCTradeEscrow.cdc
//      (function names, arg types, event shapes),
//   2. the proven test templates under cadence/tests/transactions/*.cdc
//      (16/16 green `flow test` against ExampleNFT — same NFT standard), and
//   3. the production-proven NFT-standard Cadence in
//      lib/chains/flow/cadence/break-transactions.ts (the exact
//      `auth(NonFungibleToken.Withdraw)` withdraw + `&{NonFungibleToken.
//      Receiver}` deposit patterns, live on mainnet today).
//
// ⚠ UNVERIFIED AGAINST A DEPLOYED CONTRACT — MUST TESTNET DRY-RUN FIRST.
// RPCTradeEscrow is not on Flow mainnet yet, so the Cadence-MCP-against-
// mainnet verification that CLAUDE.md ("Cadence Work") mandates could not be
// run (the MCP has no undeployed contract to fetch). These templates are
// correct-by-construction against the sources above, but every one MUST be
// dry-run on testnet against the real deployed contract before go-live. They
// are only reachable once RPC_TRADE_ESCROW_ADDRESS is set; the whole Trade
// Hub surface 503s / notFound()s in production today.
//
// IMPORT CONVENTION: this repo's FCL Cadence uses hardcoded mainnet address
// imports (see break-transactions.ts), NOT string imports, so no FCL import-
// map config is required. RPCTradeEscrow's address is injected at call time
// from RPC_TRADE_ESCROW_ADDRESS (server) / NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS
// (client). NonFungibleToken is the mainnet standard at 0x1d7e57aa55817448
// (same address break-transactions.ts uses).

// Mainnet NonFungibleToken standard — identical to break-transactions.ts.
const NON_FUNGIBLE_TOKEN_ADDR = "0x1d7e57aa55817448";

function withPrefix(addr: string): string {
  return addr.startsWith("0x") ? addr : `0x${addr}`;
}

// A Cadence path literal is `/storage/Foo` or `/public/Foo` — never quoted.
// COLLECTION_META supplies these strings; guard against an accidental quote
// or a malformed path being spliced into transaction source.
function assertPathLiteral(p: string, label: string): string {
  if (!/^\/(storage|public)\/[A-Za-z0-9_]+$/.test(p)) {
    throw new Error(`Invalid Cadence ${label} path literal: ${JSON.stringify(p)}`);
  }
  return p;
}

// §3a — propose. Universal template: NFT types arrive as identifier strings
// and are rebuilt on-chain with CompositeType(). Signed by the RPC hot wallet
// acting as proposer. Mirrors cadence/tests/transactions/propose_trade.cdc.
export function proposeTradeCadence(escrowAddr: string): string {
  return `import RPCTradeEscrow from ${withPrefix(escrowAddr)}

transaction(
    partyA: Address,
    partyB: Address,
    partyA_nftTypeIdentifier: String,
    partyB_nftTypeIdentifier: String,
    partyA_expectedIds: [UInt64],
    partyB_expectedIds: [UInt64],
    expiresAt: UFix64
) {
    prepare(proposer: auth(BorrowValue) &Account) {
        let aType = CompositeType(partyA_nftTypeIdentifier)
            ?? panic("Invalid A type identifier: ".concat(partyA_nftTypeIdentifier))
        let bType = CompositeType(partyB_nftTypeIdentifier)
            ?? panic("Invalid B type identifier: ".concat(partyB_nftTypeIdentifier))

        let tradeId = RPCTradeEscrow.proposeTrade(
            partyA: partyA,
            partyB: partyB,
            partyA_nftType: aType,
            partyB_nftType: bType,
            partyA_expectedIds: partyA_expectedIds,
            partyB_expectedIds: partyB_expectedIds,
            expiresAt: expiresAt,
            proposedBy: proposer.address
        )
        log("Proposed trade id ".concat(tradeId.toString()))
    }
}
`;
}

// §3b — deposit. ONE universal template parameterised by paths, not one file
// per collection: the escrow validates NFT type + ids on-chain (see
// depositSide() in the contract), so the transaction only needs the generic
// NonFungibleToken.Provider / Receiver interfaces — no per-collection contract
// import. `storagePath` is where the depositor's collection lives; `refundPath`
// is their receiver for their OWN NFTs (cancel/expiry return); `incomingPath`
// is their receiver for the OTHER side's NFT type (execute delivery). Paths
// come from COLLECTION_META (documented as the conventional values these
// collections' Cadence path constants resolve to; a wrong path fails the
// borrow cleanly with a panic — no asset can be lost).
export function depositToTradeCadence(
  escrowAddr: string,
  storagePath: string,
  refundPath: string,
  incomingPath: string
): string {
  const s = assertPathLiteral(storagePath, "storage");
  const r = assertPathLiteral(refundPath, "refund public");
  const i = assertPathLiteral(incomingPath, "incoming public");
  return `import NonFungibleToken from ${NON_FUNGIBLE_TOKEN_ADDR}
import RPCTradeEscrow from ${withPrefix(escrowAddr)}

transaction(tradeId: UInt64, nftIds: [UInt64]) {
    prepare(
        signer: auth(BorrowValue, IssueStorageCapabilityController, PublishCapability) &Account
    ) {
        // 1. Provider: withdraw the NFTs from the depositor's collection.
        let provider = signer.storage.borrow<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>(
            from: ${s}
        ) ?? panic("Could not borrow a Withdraw Provider from ${s}")

        let withdrawn: @[{NonFungibleToken.NFT}] <- []
        for id in nftIds {
            withdrawn.append(<- provider.withdraw(withdrawID: id))
        }

        // 2. Refund receiver: the depositor's own collection (issue+publish a
        //    public receiver cap if one isn't already there).
        var refundCap = signer.capabilities.get<&{NonFungibleToken.Receiver}>(${r})
        if !refundCap.check() {
            let issued = signer.capabilities.storage
                .issue<&{NonFungibleToken.Receiver}>(${s})
            signer.capabilities.publish(issued, at: ${r})
            refundCap = signer.capabilities.get<&{NonFungibleToken.Receiver}>(${r})
        }
        assert(refundCap.check(), message: "Refund receiver invalid at ${r}")

        // 3. Incoming receiver: where the OTHER side's NFTs land on execute.
        //    Must already exist — the depositor set up that collection before
        //    proposing (pre-checked client-side).
        let incomingCap = signer.capabilities.get<&{NonFungibleToken.Receiver}>(${i})
        assert(incomingCap.check(), message: "Incoming receiver not configured at ${i}")

        // 4. Submit to escrow. depositor is asserted == signer.address on-chain.
        RPCTradeEscrow.depositToTrade(
            tradeId: tradeId,
            depositor: signer.address,
            nfts: <- withdrawn,
            refundReceiver: refundCap,
            incomingReceiver: incomingCap
        )
    }
}
`;
}

// §3c — execute. Anyone can call; the RPC hot wallet pays so users don't.
// Outcome is fully deterministic (receivers committed at deposit time).
export function executeSwapCadence(escrowAddr: string): string {
  return `import RPCTradeEscrow from ${withPrefix(escrowAddr)}

transaction(tradeId: UInt64) {
    prepare(signer: &Account) {}
    execute {
        RPCTradeEscrow.executeSwap(tradeId: tradeId)
    }
}
`;
}

// §3d — cancel. Signed by the cancelling party (their address must match
// partyA/partyB on-chain). Mirrors cadence/tests/transactions/cancel_trade.cdc.
export function cancelTradeCadence(escrowAddr: string): string {
  return `import RPCTradeEscrow from ${withPrefix(escrowAddr)}

transaction(tradeId: UInt64, reason: String) {
    prepare(signer: &Account) {
        RPCTradeEscrow.cancelTrade(
            tradeId: tradeId,
            cancelledBy: signer.address,
            reason: reason
        )
    }
}
`;
}

// §3e — reclaim expired. Anyone can call after expiresAt (janitor role); the
// RPC hot wallet signs. Refunds both sides. Mirrors reclaim_expired.cdc.
export function reclaimExpiredCadence(escrowAddr: string): string {
  return `import RPCTradeEscrow from ${withPrefix(escrowAddr)}

transaction(tradeId: UInt64) {
    prepare(signer: &Account) {}
    execute {
        RPCTradeEscrow.reclaimExpired(tradeId: tradeId)
    }
}
`;
}
