// transactions/propose_trade.cdc
//
// Universal propose transaction. Uses CompositeType(_:) to translate
// the human-readable type identifier strings into runtime Type values.
// Per RPCTradeEscrow_DEPLOYMENT.md §3a.

import "RPCTradeEscrow"

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
