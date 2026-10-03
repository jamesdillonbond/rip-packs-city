// RPCGiveawayPacks_test.cdc
//
// Tests for the DRAFT sealed-pack escrow (cadence/contracts/RPCGiveawayPacks.cdc).
// ExampleNFT stands in for Top Shot; ExampleNFT2 is a second type for the
// mixed-pack refusal.
//
// Run from the repo root (after bash scripts/fetch-cadence-escrow-test-deps.sh):
//   flow test -f cadence/tests/flow.test.json cadence/tests/RPCGiveawayPacks_test.cdc
//
// Accounts:
//   admin    deploys the contracts and mints ExampleNFTs (minter authority)
//   sponsor  seals packs from its own collection
//   winner   a claimer
//   other    a stranger (and a second sponsor)

import Test
import "RPCGiveawayPacks"
import "NonFungibleToken"
import "ExampleNFT"

access(all) let admin = Test.getAccount(0x0000000000000007)
access(all) var sponsor: Test.TestAccount = Test.createAccount()
access(all) var winner: Test.TestAccount = Test.createAccount()
access(all) var other: Test.TestAccount = Test.createAccount()

access(all) fun setup() {
    Test.expect(Test.deployContract(name: "ExampleNFT", path: "../contracts/imports/ExampleNFT.cdc", arguments: []), Test.beNil())
    Test.expect(Test.deployContract(name: "ExampleNFT2", path: "contracts/ExampleNFT2.cdc", arguments: []), Test.beNil())
    // Hybrid Custody (onflow/hybrid-custody main; see contracts/hybrid-custody/README.md)
    for name in ["CapabilityFactory", "CapabilityFilter", "CapabilityDelegator", "HybridCustody"] {
        Test.expect(Test.deployContract(name: name, path: "contracts/hybrid-custody/".concat(name).concat(".cdc"), arguments: []), Test.beNil())
    }
    Test.expect(Test.deployContract(name: "RPCGiveawayPacks", path: "../contracts/RPCGiveawayPacks.cdc", arguments: []), Test.beNil())
    tx("transactions/hc_setup_factory_and_filter.cdc", admin, [])
}

access(all) fun beforeEach() {
    sponsor = Test.createAccount()
    winner = Test.createAccount()
    other = Test.createAccount()
    for a in [sponsor, winner, other] {
        tx("transactions/setup_example_nft_collection.cdc", a, [])
    }
    tx("transactions/giveaway_create_sponsor.cdc", sponsor, [])
    tx("transactions/giveaway_create_sponsor.cdc", other, [])
}

// ── helpers ────────────────────────────────────────────────────────────────

access(all) fun tx(_ path: String, _ signer: Test.TestAccount, _ args: [AnyStruct]) {
    Test.expect(run(path, signer, args), Test.beSucceeded())
}

access(all) fun run(_ path: String, _ signer: Test.TestAccount, _ args: [AnyStruct]): Test.TransactionResult {
    return Test.executeTransaction(Test.Transaction(code: Test.readFile(path), authorizers: [signer.address], signers: [signer], arguments: args))
}

access(all) fun ids(_ of: Test.TestAccount): [UInt64] {
    let r = Test.executeScript(Test.readFile("scripts/get_example_nft_ids.cdc"), [of.address])
    Test.expect(r, Test.beSucceeded())
    return r.returnValue! as! [UInt64]
}

access(all) fun mint(_ to: Test.TestAccount): UInt64 {
    let before = ids(to)
    tx("transactions/mint_example_nft.cdc", admin, [to.address])
    for id in ids(to) {
        if !before.contains(id) { return id }
    }
    panic("mint added nothing")
}

access(all) fun nextPackID(): UInt64 {
    let r = Test.executeScript(Test.readFile("scripts/giveaway_next_pack_id.cdc"), [])
    Test.expect(r, Test.beSucceeded())
    return r.returnValue! as! UInt64
}

access(all) fun getPack(_ id: UInt64): RPCGiveawayPacks.PackView? {
    let r = Test.executeScript(Test.readFile("scripts/giveaway_get_pack.cdc"), [id])
    Test.expect(r, Test.beSucceeded())
    return r.returnValue as! RPCGiveawayPacks.PackView?
}

// Seals `n` freshly minted NFTs from the sponsor; returns (packID, nft ids).
access(all) fun sealPack(_ n: Int): [UInt64] {
    var minted: [UInt64] = []
    var i = 0
    while i < n {
        minted.append(mint(sponsor))
        i = i + 1
    }
    let packID = nextPackID()
    tx("transactions/giveaway_seal_example_nft.cdc", sponsor, ["drop-1", UInt32(1), minted])
    return [packID].concat(minted)
}

// `child` becomes a REDEEMED Hybrid Custody child of `parent` (both sign, as in a real account link).
access(all) fun link(child: Test.TestAccount, parent: Test.TestAccount) {
    let r = Test.executeTransaction(Test.Transaction(
        code: Test.readFile("transactions/hc_link_child_to_parent.cdc"),
        authorizers: [child.address, parent.address],
        signers: [child, parent],
        arguments: [nil as Address?, admin.address, admin.address]
    ))
    Test.expect(r, Test.beSucceeded())
}

access(all) fun linkStatus(child: Test.TestAccount, parent: Test.TestAccount): [Bool] {
    let r = Test.executeScript(Test.readFile("scripts/hc_link_status.cdc"), [child.address, parent.address])
    Test.expect(r, Test.beSucceeded())
    return r.returnValue! as! [Bool]
}

access(all) fun canOpen(_ packID: UInt64, _ opener: Test.TestAccount): Bool {
    let r = Test.executeScript(Test.readFile("scripts/giveaway_can_open.cdc"), [packID, opener.address])
    Test.expect(r, Test.beSucceeded())
    return r.returnValue! as! Bool
}

access(all) fun expectFail(_ r: Test.TransactionResult, _ fragment: String) {
    Test.expect(r, Test.beFailed())
    Test.assert(r.error!.message.contains(fragment), message: "expected '".concat(fragment).concat("' in: ").concat(r.error!.message))
}

// ── tests ──────────────────────────────────────────────────────────────────

access(all) fun testSealMovesNFTsIntoThePack() {
    let s = sealPack(2)
    let packID = s[0]
    for id in s.slice(from: 1, upTo: 3) {
        Test.assert(!ids(sponsor).contains(id), message: "sealed NFT still in the sponsor's account")
    }
    let p = getPack(packID)!
    Test.assertEqual(s.slice(from: 1, upTo: 3), p.momentIDs)
    Test.assertEqual(nil as Address?, p.recipient)
    Test.assertEqual("drop-1", p.dropID)
    Test.assertEqual(UInt32(1), p.packNo)
}

access(all) fun testWinnerOpensToTheirOwnWallet() {
    let s = sealPack(2)
    tx("transactions/giveaway_assign.cdc", sponsor, [s[0], winner.address])
    tx("transactions/giveaway_open_as_winner.cdc", winner, [s[0], winner.address])
    let got = ids(winner)
    Test.assert(got.contains(s[1]) && got.contains(s[2]), message: "winner did not receive the pack")
    Test.assertEqual(nil as RPCGiveawayPacks.PackView?, getPack(s[0]))
}

access(all) fun testWinnerMayDirectTheMomentsToTheirLinkedAccount() {
    // `linked` stands in for the winner's Dapper account, linked to the winner's Flow Wallet
    let linked = Test.createAccount()
    tx("transactions/setup_example_nft_collection.cdc", linked, [])
    link(child: linked, parent: winner)
    let s = sealPack(2)
    tx("transactions/giveaway_assign.cdc", sponsor, [s[0], winner.address])
    tx("transactions/giveaway_open_as_winner.cdc", winner, [s[0], linked.address])
    Test.assert(ids(linked).contains(s[1]) && ids(linked).contains(s[2]), message: "moments did not reach the chosen account")
    Test.assertEqual(0, ids(winner).length)
}

access(all) fun testOnlyTheWinnerCanOpenAs() {
    let s = sealPack(1)
    tx("transactions/giveaway_assign.cdc", sponsor, [s[0], winner.address])
    // a stranger with their own Winner identity cannot open someone else's pack, even to the winner
    expectFail(run("transactions/giveaway_open_as_winner.cdc", other, [s[0], other.address]), "Only this pack's winner")
    expectFail(run("transactions/giveaway_open_as_winner.cdc", other, [s[0], winner.address]), "Only this pack's winner")
    Test.assertEqual([s[1]], getPack(s[0])!.momentIDs)
}

access(all) fun testNoOneElseCanEverOpenIt() {
    // "These packs are only for the recipient": no grace period, no fallback opener
    let s = sealPack(1)
    tx("transactions/giveaway_assign.cdc", sponsor, [s[0], winner.address])
    Test.moveTime(by: 31536000.0) // a year later
    expectFail(run("transactions/giveaway_open_as_winner.cdc", other, [s[0], winner.address]), "Only this pack's winner")
    Test.assertEqual(false, canOpen(s[0], other))
    Test.assertEqual([s[1]], getPack(s[0])!.momentIDs)
}

access(all) fun testLinkedFlowWalletOpensAPackWonByItsDapperAccount() {
    // the pack was assigned to `dapper`; its linked Flow Wallet opens it
    let dapper = Test.createAccount()
    let flowWallet = Test.createAccount()
    tx("transactions/setup_example_nft_collection.cdc", dapper, [])
    link(child: dapper, parent: flowWallet)
    Test.assertEqual([true, true], linkStatus(child: dapper, parent: flowWallet))
    let s = sealPack(2)
    tx("transactions/giveaway_assign.cdc", sponsor, [s[0], dapper.address])
    Test.assertEqual(true, canOpen(s[0], flowWallet))
    // the moments flow straight into the Dapper account
    tx("transactions/giveaway_open_as_winner.cdc", flowWallet, [s[0], dapper.address])
    Test.assert(ids(dapper).contains(s[1]) && ids(dapper).contains(s[2]), message: "moments did not reach the Dapper account")
}

access(all) fun testLinkedFlowWalletMayKeepTheMomentsItself() {
    let dapper = Test.createAccount()
    let flowWallet = Test.createAccount()
    tx("transactions/setup_example_nft_collection.cdc", flowWallet, [])
    link(child: dapper, parent: flowWallet)
    let s = sealPack(1)
    tx("transactions/giveaway_assign.cdc", sponsor, [s[0], dapper.address])
    tx("transactions/giveaway_open_as_winner.cdc", flowWallet, [s[0], flowWallet.address])
    Test.assert(ids(flowWallet).contains(s[1]), message: "moment did not reach the Flow Wallet")
}

access(all) fun testAnOfferedButUnredeemedLinkDoesNotCount() {
    // an offer already lists the parent (and isChildOf() is true); the contract must require a REDEEMED link
    let dapper = Test.createAccount()
    let flowWallet = Test.createAccount()
    tx("transactions/setup_example_nft_collection.cdc", flowWallet, [])
    tx("transactions/hc_offer_only.cdc", dapper, [flowWallet.address, admin.address, admin.address])
    Test.assertEqual([true, false], linkStatus(child: dapper, parent: flowWallet))
    let s = sealPack(1)
    tx("transactions/giveaway_assign.cdc", sponsor, [s[0], dapper.address])
    Test.assertEqual(false, canOpen(s[0], flowWallet))
    expectFail(run("transactions/giveaway_open_as_winner.cdc", flowWallet, [s[0], flowWallet.address]), "Only this pack's winner")
}

access(all) fun testAWalletLinkedToSomeoneElseCannotOpen() {
    let dapper = Test.createAccount()
    let flowWallet = Test.createAccount()
    link(child: dapper, parent: flowWallet)
    let s = sealPack(1)
    tx("transactions/giveaway_assign.cdc", sponsor, [s[0], winner.address])
    expectFail(run("transactions/giveaway_open_as_winner.cdc", flowWallet, [s[0], winner.address]), "Only this pack's winner")
}

access(all) fun testTheMomentsOnlyGoToTheWinnersOwnAccounts() {
    let s = sealPack(1)
    tx("transactions/giveaway_assign.cdc", sponsor, [s[0], winner.address])
    expectFail(run("transactions/giveaway_open_as_winner.cdc", winner, [s[0], other.address]), "winner's own accounts")
    Test.assertEqual([s[1]], getPack(s[0])!.momentIDs)
}

access(all) fun testOpenBeforeAssignFails() {
    let packID = sealPack(1)[0]
    expectFail(run("transactions/giveaway_open_as_winner.cdc", winner, [packID, winner.address]), "no winner yet")
}

access(all) fun testOnlyTheSealingSponsorCanAssignOrReclaim() {
    let packID = sealPack(1)[0]
    expectFail(run("transactions/giveaway_assign.cdc", other, [packID, other.address]), "Only the sponsor that sealed this pack can assign it")
    expectFail(run("transactions/giveaway_reclaim.cdc", other, [packID]), "Only the sponsor that sealed this pack can reclaim it")
}

access(all) fun testAssignIsOnce() {
    let packID = sealPack(1)[0]
    tx("transactions/giveaway_assign.cdc", sponsor, [packID, winner.address])
    expectFail(run("transactions/giveaway_assign.cdc", sponsor, [packID, other.address]), "already has a winner")
    Test.assertEqual(winner.address, getPack(packID)!.recipient!)
}

access(all) fun testUnassignedPackReclaimsToTheSponsor() {
    let s = sealPack(2)
    tx("transactions/giveaway_reclaim.cdc", sponsor, [s[0]])
    Test.assert(ids(sponsor).contains(s[1]) && ids(sponsor).contains(s[2]), message: "reclaim did not return the NFTs")
    Test.assertEqual(nil as RPCGiveawayPacks.PackView?, getPack(s[0]))
}

access(all) fun testAssignedPackReclaimsOnlyAfterTheDelay() {
    let s = sealPack(1)
    tx("transactions/giveaway_assign.cdc", sponsor, [s[0], winner.address])
    expectFail(run("transactions/giveaway_reclaim.cdc", sponsor, [s[0]]), "after the reclaim delay")
    Test.moveTime(by: 2592001.0)
    tx("transactions/giveaway_reclaim.cdc", sponsor, [s[0]])
    Test.assert(ids(sponsor).contains(s[1]), message: "late reclaim did not return the NFT")
}

access(all) fun testOpenFailsCleanlyWhenTheWinnerCannotReceive() {
    let s = sealPack(1)
    let noCollection = Test.createAccount()
    tx("transactions/giveaway_assign.cdc", sponsor, [s[0], noCollection.address])
    expectFail(run("transactions/giveaway_open_as_winner.cdc", noCollection, [s[0], noCollection.address]), "cannot receive")
    // the pack is intact, still sealed
    Test.assertEqual([s[1]], getPack(s[0])!.momentIDs)
}

access(all) fun testSealRefusesMixedTypes() {
    let id1 = mint(sponsor)
    tx("transactions/setup_example_nft2_collection.cdc", sponsor, [])
    let r = Test.executeTransaction(Test.Transaction(code: Test.readFile("transactions/mint_example_nft2.cdc"), authorizers: [admin.address], signers: [admin], arguments: [sponsor.address]))
    Test.expect(r, Test.beSucceeded())
    let s2 = Test.executeScript(Test.readFile("scripts/get_example_nft2_ids.cdc"), [sponsor.address])
    let id2 = (s2.returnValue! as! [UInt64])[0]
    expectFail(run("transactions/giveaway_seal_mixed.cdc", sponsor, [id1, id2]), "same type")
    Test.assert(ids(sponsor).contains(id1), message: "a refused seal must not take the NFT")
}

access(all) fun testSealRefusesAnEmptyPack() {
    expectFail(run("transactions/giveaway_seal_example_nft.cdc", sponsor, ["drop-1", UInt32(1), [] as [UInt64]]), "at least one NFT")
}

access(all) fun testManageNeedsTheEntitlement() {
    let packID = sealPack(1)[0]
    // borrowing the Sponsor without auth(Manage) cannot call assign — a checker error, so the tx fails
    Test.expect(run("transactions/giveaway_borrow_sponsor_unentitled.cdc", sponsor, [packID, other.address]), Test.beFailed())
    Test.assertEqual(nil as Address?, getPack(packID)!.recipient)
}
