// RPCGiveawayPacks.cdc
//
// Sealed giveaway packs for Rip Packs City community drops (Trevor,
// 2026-10-03: "Would we ever be able to do an actual pack?" → "Do it all").
// DRAFT — not deployed. Mainnet deployment needs Trevor's go-ahead and an
// external audit first (docs/strategy/free-packs-reassessment-2026-09-29.md §9).
//
// WHAT IT ADDS OVER THE CURRENT FLOW
//   Today a sponsor's moments stay in the sponsor's account until "Deliver all".
//   Here the sponsor SEALS each pack on chain: the moments leave the sponsor's
//   account and sit inside a Pack held by this contract. From that moment no
//   one, the sponsor included, can swap or sell what is inside.
//
// LIFECYCLE
//   1. seal()     A Sponsor deposits 1..MAX_MOMENTS_PER_PACK NFTs of ONE type
//                 into a new Pack. The sponsor names the public path where a
//                 winner's collection receives that type (Top Shot:
//                 /public/MomentCollection).
//   2. assign()   The SAME sponsor names the pack's winner (an address). Once.
//   3. openAs()   The WINNER opens their own pack, signing in their own Flow
//                 Wallet, and CHOOSES where the NFTs go: their Flow Wallet, or
//                 their linked Dapper account (Trevor, 2026-10-03: "an option
//                 before opening the pack ... directly to their linked dapper
//                 wallet"). The winner proves who they are with a Winner
//                 resource stored in their own account (borrowed with the Open
//                 entitlement, which only that account's signer can do).
//   4. open()     Liveness fallback: ANYONE may open an assigned pack once
//                 OPEN_GRACE has passed since assignment; the NFTs can only go
//                 to the winner's receiver at the pack's path. Before the grace
//                 period no one but the winner can open it, so nobody can take
//                 the destination choice (or the reveal) away from them.
//   5. reclaim()  The sponsor takes the NFTs back from a pack that is
//                 UNASSIGNED, or ASSIGNED but unopened for RECLAIM_DELAY
//                 seconds (a winner whose collection can't receive).
//
// WHY THE WINNER NEVER HOLDS A NEW TOKEN TYPE
//   A pack is not an NFT in the winner's account; it lives here and opens
//   straight into the winner's EXISTING collection. A Dapper custodial account
//   therefore needs no new collection set up, and an unopened pack cannot be
//   listed or traded (a tradeable sealed random bundle is the lottery-shaped
//   design the legal read rules out, reassessment §2.3).
//
// SECURITY PROPERTIES
//   - No admin, no drain: nothing in this contract lets the contract account,
//     RPC, or any caller withdraw a pack's NFTs except openAs() (the winner,
//     to a destination the winner signs for), open() (to the winner, after the
//     grace period) and reclaim() (to the sealing sponsor, under the rules above).
//   - The winner's destination is the winner's call: a signed openAs() may send
//     the NFTs to any receiver, exactly as the winner could after receiving
//     them. The pack itself still can't be transferred or traded.
//   - Sponsor binding: every pack records the uuid of the Sponsor resource that
//     sealed it; assign() and reclaim() require that same resource, reached
//     through the Manage entitlement (only its owner can borrow it so).
//   - One type per pack: seal() refuses mixed types, so the receiver path is
//     meaningful for every NFT in the pack.
//   - Visible contents: a pack's NFT ids are public on chain from sealing.
//     Fairness therefore depends on WHO gets WHICH pack being random at claim
//     time (RPC's claim draws a random unclaimed pack), not on hiding contents.
//   - Upgrade risk: whoever holds the deploying account's keys can update the
//     contract. Deploy to a dedicated account and consider revoking its keys
//     after the audit, so the rules above cannot change under a sealed pack.

import "NonFungibleToken"

access(all) contract RPCGiveawayPacks {

    // ── Paths, entitlements, limits ────────────────────────────────────────
    access(all) let SponsorStoragePath: StoragePath
    access(all) let WinnerStoragePath: StoragePath
    access(all) entitlement Manage
    access(all) entitlement Open

    access(all) let MAX_MOMENTS_PER_PACK: Int
    access(all) let RECLAIM_DELAY: UFix64
    access(all) let OPEN_GRACE: UFix64

    // ── State ──────────────────────────────────────────────────────────────
    access(self) let packs: @{UInt64: Pack}
    access(all) var nextPackID: UInt64

    // ── Events ─────────────────────────────────────────────────────────────
    access(all) event PackSealed(packID: UInt64, sponsorID: UInt64, dropID: String, packNo: UInt32, nftType: String, momentIDs: [UInt64])
    access(all) event PackAssigned(packID: UInt64, recipient: Address)
    access(all) event PackOpened(packID: UInt64, recipient: Address, deliveredTo: Address?, openedByWinner: Bool, momentIDs: [UInt64])
    access(all) event PackReclaimed(packID: UInt64, sponsorID: UInt64, momentIDs: [UInt64])

    // ── Read model ─────────────────────────────────────────────────────────
    access(all) struct PackView {
        access(all) let id: UInt64
        access(all) let sponsorID: UInt64
        access(all) let dropID: String
        access(all) let packNo: UInt32
        access(all) let nftType: String
        access(all) let receiverPath: PublicPath
        access(all) let momentIDs: [UInt64]
        access(all) let recipient: Address?
        access(all) let assignedAt: UFix64?

        init(_ p: &Pack) {
            self.id = p.id
            self.sponsorID = p.sponsorID
            self.dropID = p.dropID
            self.packNo = p.packNo
            self.nftType = p.nftType.identifier
            self.receiverPath = p.receiverPath
            self.momentIDs = p.getIDs()
            self.recipient = p.recipient
            self.assignedAt = p.assignedAt
        }
    }

    // ── Pack ───────────────────────────────────────────────────────────────
    access(all) resource Pack {
        access(all) let id: UInt64
        access(all) let sponsorID: UInt64
        access(all) let dropID: String
        access(all) let packNo: UInt32
        access(all) let nftType: Type
        access(all) let receiverPath: PublicPath
        access(all) var recipient: Address?
        access(all) var assignedAt: UFix64?
        access(self) var nfts: @[{NonFungibleToken.NFT}]

        init(id: UInt64, sponsorID: UInt64, dropID: String, packNo: UInt32, receiverPath: PublicPath, nfts: @[{NonFungibleToken.NFT}]) {
            pre {
                nfts.length > 0: "A pack needs at least one NFT"
                nfts.length <= RPCGiveawayPacks.MAX_MOMENTS_PER_PACK: "Too many NFTs for one pack"
            }
            let t = nfts[0].getType()
            var i = 1
            while i < nfts.length {
                assert(nfts[i].getType() == t, message: "Every NFT in a pack must be the same type")
                i = i + 1
            }
            self.id = id
            self.sponsorID = sponsorID
            self.dropID = dropID
            self.packNo = packNo
            self.nftType = t
            self.receiverPath = receiverPath
            self.recipient = nil
            self.assignedAt = nil
            self.nfts <- nfts
        }

        access(all) view fun getIDs(): [UInt64] {
            var ids: [UInt64] = []
            var i = 0
            while i < self.nfts.length {
                ids = ids.concat([self.nfts[i].id])
                i = i + 1
            }
            return ids
        }

        access(contract) fun assign(_ recipient: Address) {
            pre { self.recipient == nil: "This pack already has a winner" }
            self.recipient = recipient
            self.assignedAt = getCurrentBlock().timestamp
        }

        // Moves every NFT into `receiver`; the caller destroys the empty pack.
        access(contract) fun drainTo(_ receiver: &{NonFungibleToken.Receiver}): [UInt64] {
            let ids = self.getIDs()
            while self.nfts.length > 0 {
                receiver.deposit(token: <- self.nfts.removeFirst())
            }
            return ids
        }
    }

    // ── Sponsor ────────────────────────────────────────────────────────────
    access(all) resource Sponsor {

        access(Manage) fun seal(
            dropID: String,
            packNo: UInt32,
            receiverPath: PublicPath,
            nfts: @[{NonFungibleToken.NFT}]
        ): UInt64 {
            let id = RPCGiveawayPacks.nextPackID
            RPCGiveawayPacks.nextPackID = id + 1
            let pack <- create Pack(id: id, sponsorID: self.uuid, dropID: dropID, packNo: packNo, receiverPath: receiverPath, nfts: <- nfts)
            emit PackSealed(packID: id, sponsorID: self.uuid, dropID: dropID, packNo: packNo, nftType: pack.nftType.identifier, momentIDs: pack.getIDs())
            RPCGiveawayPacks.packs[id] <-! pack
            return id
        }

        access(Manage) fun assign(packID: UInt64, recipient: Address) {
            let pack = RPCGiveawayPacks.borrowPack(packID) ?? panic("No such pack")
            assert(pack.sponsorID == self.uuid, message: "Only the sponsor that sealed this pack can assign it")
            pack.assign(recipient)
            emit PackAssigned(packID: packID, recipient: recipient)
        }

        access(Manage) fun reclaim(packID: UInt64, to: &{NonFungibleToken.Receiver}) {
            let pack = RPCGiveawayPacks.borrowPack(packID) ?? panic("No such pack")
            assert(pack.sponsorID == self.uuid, message: "Only the sponsor that sealed this pack can reclaim it")
            if let at = pack.assignedAt {
                assert(
                    getCurrentBlock().timestamp >= at + RPCGiveawayPacks.RECLAIM_DELAY,
                    message: "An assigned pack can only be reclaimed after the reclaim delay"
                )
            }
            let p <- RPCGiveawayPacks.packs.remove(key: packID)!
            let ids = p.drainTo(to)
            destroy p
            emit PackReclaimed(packID: packID, sponsorID: self.uuid, momentIDs: ids)
        }
    }

    access(all) fun createSponsor(): @Sponsor {
        return <- create Sponsor()
    }

    // ── Winner identity ────────────────────────────────────────────────────
    // Holds nothing; its OWNER is the proof. A reference with the Open
    // entitlement can only come from the storing account's own signer (or a
    // capability that account deliberately issued).
    access(all) resource Winner {}

    access(all) fun createWinner(): @Winner {
        return <- create Winner()
    }

    // ── Open by the winner, to the destination they choose ─────────────────
    access(all) fun openAs(packID: UInt64, winner: auth(Open) &Winner, to: &{NonFungibleToken.Receiver}) {
        let pack = self.borrowPack(packID) ?? panic("No such pack")
        let recipient = pack.recipient ?? panic("This pack has no winner yet")
        let caller = winner.owner?.address ?? panic("The Winner resource must be stored in the winner's account")
        assert(caller == recipient, message: "Only this pack's winner can open it")
        let p <- self.packs.remove(key: packID)!
        let ids = p.drainTo(to)
        destroy p
        emit PackOpened(packID: packID, recipient: recipient, deliveredTo: to.owner?.address, openedByWinner: true, momentIDs: ids)
    }

    // ── Open by anyone after the grace period, destination fixed ───────────
    access(all) fun open(packID: UInt64) {
        let pack = self.borrowPack(packID) ?? panic("No such pack")
        let recipient = pack.recipient ?? panic("This pack has no winner yet")
        assert(
            getCurrentBlock().timestamp >= pack.assignedAt! + self.OPEN_GRACE,
            message: "Only the winner can open this pack until the grace period ends"
        )
        let receiver = getAccount(recipient).capabilities
            .borrow<&{NonFungibleToken.Receiver}>(pack.receiverPath)
            ?? panic("The winner's account cannot receive this pack's NFTs yet")
        let p <- self.packs.remove(key: packID)!
        let ids = p.drainTo(receiver)
        destroy p
        emit PackOpened(packID: packID, recipient: recipient, deliveredTo: recipient, openedByWinner: false, momentIDs: ids)
    }

    // ── Reads ──────────────────────────────────────────────────────────────
    access(contract) view fun borrowPack(_ id: UInt64): &Pack? {
        return &self.packs[id] as &Pack?
    }

    access(all) view fun getPackIDs(): [UInt64] {
        return self.packs.keys
    }

    access(all) fun getPack(_ id: UInt64): PackView? {
        if let p = self.borrowPack(id) {
            return PackView(p)
        }
        return nil
    }

    init() {
        self.SponsorStoragePath = /storage/RPCGiveawayPacksSponsor
        self.WinnerStoragePath = /storage/RPCGiveawayPacksWinner
        self.MAX_MOMENTS_PER_PACK = 50
        self.RECLAIM_DELAY = 2592000.0 // 30 days
        self.OPEN_GRACE = 1209600.0 // 14 days
        self.packs <- {}
        self.nextPackID = 1
    }
}
