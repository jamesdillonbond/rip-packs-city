// RPCTradeEscrow.cdc
//
// Atomic NFT-for-NFT swap escrow for Rip Packs City (RPC).
//
// PHASE 1 SCOPE
//   - 1:1, 1:N, N:M atomic swaps between two Flow accounts
//   - Generic over any NonFungibleToken-conformant contract
//     (TopShot, AllDay, Pinnacle, Golazos, UFC Strike, future)
//   - Deposit-then-execute pattern: each party signs an independent
//     deposit tx. No envelope coordination required.
//   - Parent-account-only. Hybrid Custody is Phase 2 (adds wrapper
//     transactions that withdraw from a child via HC Manager,
//     contract itself is unchanged).
//
// LIFECYCLE
//   1. proposeTrade()       opens a Trade with both sides' obligations.
//                           Anyone can propose (typically RPC backend).
//                           No NFTs locked yet.
//   2. depositToTrade() x2  each party signs and deposits their NFTs
//                           plus refund + incoming receiver capabilities.
//   3. executeSwap()        anyone (typically backend) triggers once
//                           both sides complete. NFTs route atomically
//                           to incoming receivers.
//   4. cancelTrade()        either party can cancel pre-execute.
//                           Deposited NFTs return to refund receivers.
//   5. reclaimExpired()     anyone can clean up after expiry passes.
//
// SECURITY PROPERTIES
//   - Atomicity. NFT movement is all-or-nothing. Cadence resource
//     semantics enforce this; no manual rollback path exists.
//   - No drain. Contract never owns NFTs outside an active Trade
//     resource. Admin has zero NFT-withdraw authority. Period.
//   - No bait-and-switch. Deposits validate (a) NFT type matches the
//     committed type and (b) every NFT id is in the committed id list.
//   - Replay safety. Trade resources are destroyed on execute or
//     cancel. Trade ids strictly monotonic.
//   - Receiver flexibility. Depositor specifies their own refund and
//     incoming receivers at deposit time. Supports arbitrary account
//     routing, including the Phase 2 Hybrid Custody flow where the
//     parent account receives despite the source being a child.
//   - Liveness via expiry. Stuck trades reclaimable by anyone after
//     expiresAt. No NFT can be locked indefinitely.
//
// DEPLOYMENT
//   Deploy to: a fresh dedicated Flow account controlled by Trevor.
//   Do not deploy to the hot wallet (0x3aa11c84d776838f) — separate
//   blast radius. Suggest a new account paid for from the hot wallet
//   with its own key, used solely for this contract.

import NonFungibleToken from 0x1d7e57aa55817448

access(all) contract RPCTradeEscrow {

    // ────────────────────────────────────────────────────────────────────
    // Paths
    // ────────────────────────────────────────────────────────────────────

    access(all) let RegistryStoragePath: StoragePath
    access(all) let RegistryPublicPath:  PublicPath
    access(all) let AdminStoragePath:    StoragePath

    // ────────────────────────────────────────────────────────────────────
    // Entitlements
    // ────────────────────────────────────────────────────────────────────

    access(all) entitlement AdminOp

    // ────────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────────

    access(self) var nextTradeId: UInt64
    access(all)  var paused: Bool

    // Hard floor on min expiry window prevents short expiries racing seal.
    access(all) let MIN_EXPIRY_SECONDS: UFix64
    // Hard ceiling so trades cannot indefinitely lock NFTs.
    access(all) let MAX_EXPIRY_SECONDS: UFix64

    // ────────────────────────────────────────────────────────────────────
    // Events
    // ────────────────────────────────────────────────────────────────────

    access(all) event ContractInitialized()

    access(all) event TradeProposed(
        tradeId: UInt64,
        partyA: Address,
        partyB: Address,
        partyA_nftType: String,
        partyB_nftType: String,
        partyA_expectedIds: [UInt64],
        partyB_expectedIds: [UInt64],
        expiresAt: UFix64,
        proposedBy: Address
    )

    access(all) event TradeDeposited(
        tradeId: UInt64,
        depositor: Address,
        side: String,
        nftIds: [UInt64]
    )

    access(all) event TradeExecuted(
        tradeId: UInt64,
        partyA: Address,
        partyB: Address,
        partyA_gave: [UInt64],
        partyB_gave: [UInt64]
    )

    access(all) event TradeCancelled(
        tradeId: UInt64,
        cancelledBy: Address,
        reason: String,
        partyA_refundedIds: [UInt64],
        partyB_refundedIds: [UInt64]
    )

    access(all) event PausedStateChanged(paused: Bool)

    // ────────────────────────────────────────────────────────────────────
    // Trade resource
    // ────────────────────────────────────────────────────────────────────

    access(all) resource Trade {
        access(all) let id: UInt64
        access(all) let partyA: Address
        access(all) let partyB: Address
        access(all) let partyA_nftType: Type
        access(all) let partyB_nftType: Type
        access(all) let partyA_expectedIds: [UInt64]
        access(all) let partyB_expectedIds: [UInt64]
        access(all) let expiresAt: UFix64
        access(all) let createdAt: UFix64

        // Receivers set by each side at deposit time.
        // refundReceiver:   where deposited NFTs return on cancel
        // incomingReceiver: where the OTHER side's NFTs go on execute
        access(self) var partyA_refundReceiver:   Capability<&{NonFungibleToken.Receiver}>?
        access(self) var partyA_incomingReceiver: Capability<&{NonFungibleToken.Receiver}>?
        access(self) var partyB_refundReceiver:   Capability<&{NonFungibleToken.Receiver}>?
        access(self) var partyB_incomingReceiver: Capability<&{NonFungibleToken.Receiver}>?

        access(self) var partyA_escrow: @{UInt64: {NonFungibleToken.NFT}}
        access(self) var partyB_escrow: @{UInt64: {NonFungibleToken.NFT}}

        init(
            id: UInt64,
            partyA: Address,
            partyB: Address,
            partyA_nftType: Type,
            partyB_nftType: Type,
            partyA_expectedIds: [UInt64],
            partyB_expectedIds: [UInt64],
            expiresAt: UFix64
        ) {
            self.id = id
            self.partyA = partyA
            self.partyB = partyB
            self.partyA_nftType = partyA_nftType
            self.partyB_nftType = partyB_nftType
            self.partyA_expectedIds = partyA_expectedIds
            self.partyB_expectedIds = partyB_expectedIds
            self.expiresAt = expiresAt
            self.createdAt = getCurrentBlock().timestamp
            self.partyA_refundReceiver = nil
            self.partyA_incomingReceiver = nil
            self.partyB_refundReceiver = nil
            self.partyB_incomingReceiver = nil
            self.partyA_escrow <- {}
            self.partyB_escrow <- {}
        }

        // ── views ──────────────────────────────────────────────────────

        access(all) view fun partyA_depositedIds(): [UInt64] {
            return self.partyA_escrow.keys
        }
        access(all) view fun partyB_depositedIds(): [UInt64] {
            return self.partyB_escrow.keys
        }
        access(all) view fun isExpired(): Bool {
            return getCurrentBlock().timestamp >= self.expiresAt
        }
        access(all) view fun isPartyAComplete(): Bool {
            if self.partyA_incomingReceiver == nil { return false }
            if self.partyA_refundReceiver == nil   { return false }
            for id in self.partyA_expectedIds {
                if self.partyA_escrow[id] == nil { return false }
            }
            return true
        }
        access(all) view fun isPartyBComplete(): Bool {
            if self.partyB_incomingReceiver == nil { return false }
            if self.partyB_refundReceiver == nil   { return false }
            for id in self.partyB_expectedIds {
                if self.partyB_escrow[id] == nil { return false }
            }
            return true
        }
        access(all) view fun isReadyToExecute(): Bool {
            return self.isPartyAComplete()
                && self.isPartyBComplete()
                && !self.isExpired()
        }

        // ── contract-only mutators ─────────────────────────────────────

        access(contract) fun depositSide(
            isPartyA: Bool,
            nfts: @[{NonFungibleToken.NFT}],
            refundReceiver: Capability<&{NonFungibleToken.Receiver}>,
            incomingReceiver: Capability<&{NonFungibleToken.Receiver}>
        ): [UInt64] {
            pre {
                !self.isExpired(): "Trade expired"
                refundReceiver.check():   "Invalid refund receiver capability"
                incomingReceiver.check(): "Invalid incoming receiver capability"
                nfts.length > 0:          "Must deposit at least one NFT"
            }
            let expectedType = isPartyA ? self.partyA_nftType : self.partyB_nftType
            let expectedIds  = isPartyA ? self.partyA_expectedIds : self.partyB_expectedIds

            // Reject duplicate side deposits — re-deposit on the same
            // side after a partial submission must go via cancel + retry.
            if isPartyA {
                assert(
                    self.partyA_refundReceiver == nil,
                    message: "Side A already deposited; cancel to retry"
                )
            } else {
                assert(
                    self.partyB_refundReceiver == nil,
                    message: "Side B already deposited; cancel to retry"
                )
            }

            var idsDeposited: [UInt64] = []
            var nftsRef <- nfts
            while nftsRef.length > 0 {
                let nft <- nftsRef.removeFirst()
                let id = nft.id
                assert(
                    expectedIds.contains(id),
                    message: "NFT ".concat(id.toString())
                        .concat(" not in expected ids for this side")
                )
                assert(
                    nft.getType() == expectedType,
                    message: "NFT type mismatch (got ".concat(nft.getType().identifier)
                        .concat(", expected ").concat(expectedType.identifier).concat(")")
                )
                if isPartyA {
                    assert(self.partyA_escrow[id] == nil, message: "NFT already in escrow")
                    self.partyA_escrow[id] <-! nft
                } else {
                    assert(self.partyB_escrow[id] == nil, message: "NFT already in escrow")
                    self.partyB_escrow[id] <-! nft
                }
                idsDeposited.append(id)
            }
            destroy nftsRef

            // Verify all expected ids were deposited (no partial deposits)
            for id in expectedIds {
                if isPartyA {
                    assert(
                        self.partyA_escrow[id] != nil,
                        message: "Partial deposit: missing id ".concat(id.toString())
                    )
                } else {
                    assert(
                        self.partyB_escrow[id] != nil,
                        message: "Partial deposit: missing id ".concat(id.toString())
                    )
                }
            }

            if isPartyA {
                self.partyA_refundReceiver = refundReceiver
                self.partyA_incomingReceiver = incomingReceiver
            } else {
                self.partyB_refundReceiver = refundReceiver
                self.partyB_incomingReceiver = incomingReceiver
            }

            return idsDeposited
        }

        access(contract) fun execute(): {String: [UInt64]} {
            pre {
                self.isReadyToExecute(): "Trade not ready for execution"
            }
            let aIncoming = self.partyA_incomingReceiver!.borrow()
                ?? panic("partyA incoming receiver no longer valid")
            let bIncoming = self.partyB_incomingReceiver!.borrow()
                ?? panic("partyB incoming receiver no longer valid")

            var aGave: [UInt64] = []
            for id in self.partyA_expectedIds {
                let nft <- self.partyA_escrow.remove(key: id)!
                aGave.append(nft.id)
                bIncoming.deposit(token: <- nft)
            }
            var bGave: [UInt64] = []
            for id in self.partyB_expectedIds {
                let nft <- self.partyB_escrow.remove(key: id)!
                bGave.append(nft.id)
                aIncoming.deposit(token: <- nft)
            }
            return {"a_gave": aGave, "b_gave": bGave}
        }

        access(contract) fun refund(): {String: [UInt64]} {
            var aRefunded: [UInt64] = []
            var bRefunded: [UInt64] = []

            let aKeys = self.partyA_escrow.keys
            if aKeys.length > 0 {
                let aRcv = self.partyA_refundReceiver!.borrow()
                    ?? panic("partyA refund receiver no longer valid")
                for id in aKeys {
                    let nft <- self.partyA_escrow.remove(key: id)!
                    aRefunded.append(nft.id)
                    aRcv.deposit(token: <- nft)
                }
            }
            let bKeys = self.partyB_escrow.keys
            if bKeys.length > 0 {
                let bRcv = self.partyB_refundReceiver!.borrow()
                    ?? panic("partyB refund receiver no longer valid")
                for id in bKeys {
                    let nft <- self.partyB_escrow.remove(key: id)!
                    bRefunded.append(nft.id)
                    bRcv.deposit(token: <- nft)
                }
            }
            return {"a_refunded": aRefunded, "b_refunded": bRefunded}
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Registry resource (held by contract account)
    // ────────────────────────────────────────────────────────────────────

    access(all) resource Registry {
        access(self) var trades: @{UInt64: Trade}

        init() {
            self.trades <- {}
        }

        access(contract) fun add(_ trade: @Trade) {
            let id = trade.id
            assert(self.trades[id] == nil, message: "Duplicate trade id")
            self.trades[id] <-! trade
        }

        access(all) view fun has(id: UInt64): Bool {
            return self.trades[id] != nil
        }

        access(all) view fun listIds(): [UInt64] {
            return self.trades.keys
        }

        access(all) fun borrowTrade(id: UInt64): &Trade? {
            return &self.trades[id] as &Trade?
        }

        access(contract) fun remove(id: UInt64): @Trade {
            let trade <- self.trades.remove(key: id)
                ?? panic("Trade not found: ".concat(id.toString()))
            return <- trade
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Admin resource
    // ────────────────────────────────────────────────────────────────────

    access(all) resource Admin {
        // Pause new proposals & deposits in case of emergency.
        // Does NOT pause cancel or reclaimExpired — users can always
        // recover their NFTs even with a paused contract.
        access(AdminOp) fun setPaused(_ paused: Bool) {
            RPCTradeEscrow.paused = paused
            emit PausedStateChanged(paused: paused)
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Public entry points
    // ────────────────────────────────────────────────────────────────────

    // Propose a new trade. Returns the assigned trade id.
    // Anyone can propose (typically the RPC backend on behalf of users).
    // No NFTs are moved here; this only opens the slot.
    access(all) fun proposeTrade(
        partyA: Address,
        partyB: Address,
        partyA_nftType: Type,
        partyB_nftType: Type,
        partyA_expectedIds: [UInt64],
        partyB_expectedIds: [UInt64],
        expiresAt: UFix64,
        proposedBy: Address
    ): UInt64 {
        pre {
            !RPCTradeEscrow.paused: "Contract is paused"
            partyA != partyB: "Parties must differ"
            partyA_expectedIds.length > 0 || partyB_expectedIds.length > 0:
                "At least one side must contribute NFTs"
            expiresAt >= getCurrentBlock().timestamp + RPCTradeEscrow.MIN_EXPIRY_SECONDS:
                "Expiry too short"
            expiresAt <= getCurrentBlock().timestamp + RPCTradeEscrow.MAX_EXPIRY_SECONDS:
                "Expiry too long"
        }
        let id = RPCTradeEscrow.nextTradeId
        RPCTradeEscrow.nextTradeId = RPCTradeEscrow.nextTradeId + 1

        let trade <- create Trade(
            id: id,
            partyA: partyA,
            partyB: partyB,
            partyA_nftType: partyA_nftType,
            partyB_nftType: partyB_nftType,
            partyA_expectedIds: partyA_expectedIds,
            partyB_expectedIds: partyB_expectedIds,
            expiresAt: expiresAt
        )

        let registry = RPCTradeEscrow.account.storage.borrow<&Registry>(
            from: RPCTradeEscrow.RegistryStoragePath
        ) ?? panic("Registry not found")
        registry.add(<- trade)

        emit TradeProposed(
            tradeId: id,
            partyA: partyA,
            partyB: partyB,
            partyA_nftType: partyA_nftType.identifier,
            partyB_nftType: partyB_nftType.identifier,
            partyA_expectedIds: partyA_expectedIds,
            partyB_expectedIds: partyB_expectedIds,
            expiresAt: expiresAt,
            proposedBy: proposedBy
        )
        return id
    }

    // Deposit NFTs to a trade. Called from the depositor's signed tx.
    // The `depositor` argument MUST be verified against the transaction
    // signer in the tx's prepare phase (see deposit_to_trade.cdc template).
    access(all) fun depositToTrade(
        tradeId: UInt64,
        depositor: Address,
        nfts: @[{NonFungibleToken.NFT}],
        refundReceiver: Capability<&{NonFungibleToken.Receiver}>,
        incomingReceiver: Capability<&{NonFungibleToken.Receiver}>
    ) {
        pre {
            !RPCTradeEscrow.paused: "Contract is paused"
        }
        let registry = RPCTradeEscrow.account.storage.borrow<&Registry>(
            from: RPCTradeEscrow.RegistryStoragePath
        ) ?? panic("Registry not found")
        let trade = registry.borrowTrade(id: tradeId)
            ?? panic("Trade not found: ".concat(tradeId.toString()))

        let isPartyA = depositor == trade.partyA
        let isPartyB = depositor == trade.partyB
        assert(isPartyA || isPartyB, message: "Depositor not party to trade")

        let idsDeposited = trade.depositSide(
            isPartyA: isPartyA,
            nfts: <- nfts,
            refundReceiver: refundReceiver,
            incomingReceiver: incomingReceiver
        )

        emit TradeDeposited(
            tradeId: tradeId,
            depositor: depositor,
            side: isPartyA ? "A" : "B",
            nftIds: idsDeposited
        )
    }

    // Execute a fully-deposited trade. Anyone can call.
    // Outcome is fully deterministic — receivers were committed at deposit.
    access(all) fun executeSwap(tradeId: UInt64) {
        let registry = RPCTradeEscrow.account.storage.borrow<&Registry>(
            from: RPCTradeEscrow.RegistryStoragePath
        ) ?? panic("Registry not found")

        let tradeRef = registry.borrowTrade(id: tradeId)
            ?? panic("Trade not found: ".concat(tradeId.toString()))
        assert(tradeRef.isReadyToExecute(), message: "Trade not ready for execution")

        let partyA = tradeRef.partyA
        let partyB = tradeRef.partyB

        let trade <- registry.remove(id: tradeId)
        let result = trade.execute()

        emit TradeExecuted(
            tradeId: tradeId,
            partyA: partyA,
            partyB: partyB,
            partyA_gave: result["a_gave"]!,
            partyB_gave: result["b_gave"]!
        )
        destroy trade
    }

    // Cancel a pre-execute trade. Only partyA or partyB can cancel.
    // Permitted even while paused (so users can always recover).
    access(all) fun cancelTrade(
        tradeId: UInt64,
        cancelledBy: Address,
        reason: String
    ) {
        let registry = RPCTradeEscrow.account.storage.borrow<&Registry>(
            from: RPCTradeEscrow.RegistryStoragePath
        ) ?? panic("Registry not found")

        let tradeRef = registry.borrowTrade(id: tradeId)
            ?? panic("Trade not found")
        assert(
            cancelledBy == tradeRef.partyA || cancelledBy == tradeRef.partyB,
            message: "Only trade parties can cancel"
        )

        let trade <- registry.remove(id: tradeId)
        let result = trade.refund()

        emit TradeCancelled(
            tradeId: tradeId,
            cancelledBy: cancelledBy,
            reason: reason,
            partyA_refundedIds: result["a_refunded"]!,
            partyB_refundedIds: result["b_refunded"]!
        )
        destroy trade
    }

    // Reclaim an expired trade. Anyone can call after expiresAt.
    // Permitted even while paused.
    access(all) fun reclaimExpired(tradeId: UInt64) {
        let registry = RPCTradeEscrow.account.storage.borrow<&Registry>(
            from: RPCTradeEscrow.RegistryStoragePath
        ) ?? panic("Registry not found")

        let tradeRef = registry.borrowTrade(id: tradeId)
            ?? panic("Trade not found")
        assert(tradeRef.isExpired(), message: "Trade not yet expired")

        let trade <- registry.remove(id: tradeId)
        let result = trade.refund()

        emit TradeCancelled(
            tradeId: tradeId,
            cancelledBy: 0x0,
            reason: "expired",
            partyA_refundedIds: result["a_refunded"]!,
            partyB_refundedIds: result["b_refunded"]!
        )
        destroy trade
    }

    // ────────────────────────────────────────────────────────────────────
    // Public read helpers
    // ────────────────────────────────────────────────────────────────────

    access(all) view fun getNextTradeId(): UInt64 {
        return self.nextTradeId
    }

    access(all) fun borrowRegistry(): &Registry {
        return self.account.storage.borrow<&Registry>(from: self.RegistryStoragePath)
            ?? panic("Registry not found")
    }

    // ────────────────────────────────────────────────────────────────────
    // Init
    // ────────────────────────────────────────────────────────────────────

    init() {
        self.RegistryStoragePath = /storage/RPCTradeEscrowRegistry
        self.RegistryPublicPath  = /public/RPCTradeEscrowRegistry
        self.AdminStoragePath    = /storage/RPCTradeEscrowAdmin

        self.nextTradeId = 1
        self.paused      = false

        self.MIN_EXPIRY_SECONDS = 600.0      // 10 minutes
        self.MAX_EXPIRY_SECONDS = 604800.0   // 7 days

        let registry <- create Registry()
        self.account.storage.save(<- registry, to: self.RegistryStoragePath)

        let cap = self.account.capabilities.storage
            .issue<&Registry>(self.RegistryStoragePath)
        self.account.capabilities.publish(cap, at: self.RegistryPublicPath)

        let admin <- create Admin()
        self.account.storage.save(<- admin, to: self.AdminStoragePath)

        emit ContractInitialized()
    }
}
