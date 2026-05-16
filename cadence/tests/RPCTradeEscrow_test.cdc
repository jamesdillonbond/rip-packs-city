// RPCTradeEscrow_test.cdc
//
// Test suite for RPCTradeEscrow.cdc, covering all 12 audit scenarios from
// RPCTradeEscrow_DEPLOYMENT.md §5 plus a few extras.
//
// Run with:
//   flow test cadence/tests/RPCTradeEscrow_test.cdc
//
// Layout assumed (matches flow.json conventions):
//   cadence/
//     contracts/
//       RPCTradeEscrow.cdc
//     tests/
//       RPCTradeEscrow_test.cdc
//
// Dependencies (auto-loaded by `flow test`):
//   - NonFungibleToken     standard contract, system-deployed in emulator
//   - ExampleNFT           standard example contract, system-deployed
//   - Test                 testing framework
//   - BlockchainHelpers    helpers like createAccount, getCurrentBlock,
//                          tickClock (Cadence 1.0)
//
// Test accounts:
//   - admin    contract deployer, also acts as backend/payer in tests
//   - alice    party A in trades
//   - bob      party B in trades
//   - carol    third-party (e.g. cancel attempts she shouldn't be able to do)

import Test
import BlockchainHelpers
import "RPCTradeEscrow"
import "NonFungibleToken"
import "ExampleNFT"
import "MetadataViews"

// ────────────────────────────────────────────────────────────────────────────
// Test accounts (lazily created in beforeEach)
// ────────────────────────────────────────────────────────────────────────────

access(all) let admin = Test.getAccount(0x0000000000000007)
access(all) var alice: Test.TestAccount = Test.createAccount()
access(all) var bob:   Test.TestAccount = Test.createAccount()
access(all) var carol: Test.TestAccount = Test.createAccount()

// ────────────────────────────────────────────────────────────────────────────
// Setup
// ────────────────────────────────────────────────────────────────────────────

access(all) fun setup() {
    // The emulator pre-deploys NonFungibleToken and ExampleNFT.
    // We only need to deploy RPCTradeEscrow under admin.
    let err = Test.deployContract(
        name: "RPCTradeEscrow",
        path: "../contracts/RPCTradeEscrow.cdc",
        arguments: []
    )
    Test.expect(err, Test.beNil())

    // Give each test account an ExampleNFT collection + a handful of NFTs.
    // Reset between tests via fresh account creation in beforeEach.
}

access(all) fun beforeEach() {
    alice = Test.createAccount()
    bob   = Test.createAccount()
    carol = Test.createAccount()

    setupExampleNFTCollection(account: alice)
    setupExampleNFTCollection(account: bob)
    setupExampleNFTCollection(account: carol)
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

// Mint and deposit an ExampleNFT into the recipient's collection,
// returning the new NFT id. Signed by admin (minter authority).
access(all) fun mintExampleNFT(to: Test.TestAccount): UInt64 {
    let txResult = Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/mint_example_nft.cdc"),
            authorizers: [admin.address],
            signers: [admin],
            arguments: [to.address]
        )
    )
    Test.expect(txResult, Test.beSucceeded())

    // The mint tx emits ExampleNFT.Minted with the new id.
    let events = txResult.events
    for evt in events {
        if evt.type == Type<ExampleNFT.Deposit>() {
            // Deposit event includes id field
            let raw = evt as! ExampleNFT.Deposit
            return raw.id
        }
    }
    panic("Mint event not found")
}

access(all) fun setupExampleNFTCollection(account: Test.TestAccount) {
    let txResult = Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/setup_example_nft_collection.cdc"),
            authorizers: [account.address],
            signers: [account],
            arguments: []
        )
    )
    Test.expect(txResult, Test.beSucceeded())
}

access(all) fun proposeTrade(
    partyA: Address,
    partyB: Address,
    partyAExpectedIds: [UInt64],
    partyBExpectedIds: [UInt64],
    expirySeconds: UFix64
): UInt64 {
    let nftType = Type<@ExampleNFT.NFT>().identifier
    let now = getCurrentBlock().timestamp
    let expiresAt = now + expirySeconds

    let txResult = Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/propose_trade.cdc"),
            authorizers: [admin.address],
            signers: [admin],
            arguments: [
                partyA, partyB,
                nftType, nftType,
                partyAExpectedIds, partyBExpectedIds,
                expiresAt
            ]
        )
    )
    Test.expect(txResult, Test.beSucceeded())

    // The TradeProposed event includes the assigned tradeId.
    for evt in txResult.events {
        if evt.type == Type<RPCTradeEscrow.TradeProposed>() {
            let raw = evt as! RPCTradeEscrow.TradeProposed
            return raw.tradeId
        }
    }
    panic("TradeProposed event not found")
}

access(all) fun depositToTrade(
    signer: Test.TestAccount,
    tradeId: UInt64,
    nftIds: [UInt64]
): Test.TransactionResult {
    return Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/deposit_to_trade_example_nft.cdc"),
            authorizers: [signer.address],
            signers: [signer],
            arguments: [tradeId, nftIds]
        )
    )
}

access(all) fun executeSwap(tradeId: UInt64): Test.TransactionResult {
    return Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/execute_swap.cdc"),
            authorizers: [admin.address],
            signers: [admin],
            arguments: [tradeId]
        )
    )
}

access(all) fun cancelTrade(
    signer: Test.TestAccount,
    tradeId: UInt64,
    reason: String
): Test.TransactionResult {
    return Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/cancel_trade.cdc"),
            authorizers: [signer.address],
            signers: [signer],
            arguments: [tradeId, reason]
        )
    )
}

access(all) fun reclaimExpired(tradeId: UInt64): Test.TransactionResult {
    return Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/reclaim_expired.cdc"),
            authorizers: [admin.address],
            signers: [admin],
            arguments: [tradeId]
        )
    )
}

access(all) fun collectionIds(of: Test.TestAccount): [UInt64] {
    let result = Test.executeScript(
        Test.readFile("scripts/get_example_nft_ids.cdc"),
        [of.address]
    )
    Test.expect(result, Test.beSucceeded())
    return result.returnValue! as! [UInt64]
}

access(all) fun tradeIdExists(tradeId: UInt64): Bool {
    let result = Test.executeScript(
        Test.readFile("scripts/trade_id_exists.cdc"),
        [tradeId]
    )
    Test.expect(result, Test.beSucceeded())
    return result.returnValue! as! Bool
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 1: Happy path 1:1
//   Both parties deposit single NFTs, execute, verify routing + cleanup.
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testHappyPathOneForOne() {
    let aliceNftId = mintExampleNFT(to: alice)
    let bobNftId   = mintExampleNFT(to: bob)

    let tradeId = proposeTrade(
        partyA: alice.address,
        partyB: bob.address,
        partyAExpectedIds: [aliceNftId],
        partyBExpectedIds: [bobNftId],
        expirySeconds: 3600.0
    )

    Test.expect(depositToTrade(signer: alice, tradeId: tradeId, nftIds: [aliceNftId]), Test.beSucceeded())
    Test.expect(depositToTrade(signer: bob,   tradeId: tradeId, nftIds: [bobNftId]),   Test.beSucceeded())
    Test.expect(executeSwap(tradeId: tradeId), Test.beSucceeded())

    // Post-execute: alice now holds bob's NFT, bob holds alice's NFT.
    Test.assertEqual([bobNftId],   collectionIds(of: alice))
    Test.assertEqual([aliceNftId], collectionIds(of: bob))
    // Trade resource destroyed.
    Test.assertEqual(false, tradeIdExists(tradeId: tradeId))
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 2: Happy path N:M
//   Alice deposits 3 NFTs for Bob's 2. All move atomically.
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testHappyPathManyForMany() {
    let aliceIds = [mintExampleNFT(to: alice), mintExampleNFT(to: alice), mintExampleNFT(to: alice)]
    let bobIds   = [mintExampleNFT(to: bob),   mintExampleNFT(to: bob)]

    let tradeId = proposeTrade(
        partyA: alice.address,
        partyB: bob.address,
        partyAExpectedIds: aliceIds,
        partyBExpectedIds: bobIds,
        expirySeconds: 3600.0
    )

    Test.expect(depositToTrade(signer: alice, tradeId: tradeId, nftIds: aliceIds), Test.beSucceeded())
    Test.expect(depositToTrade(signer: bob,   tradeId: tradeId, nftIds: bobIds),   Test.beSucceeded())
    Test.expect(executeSwap(tradeId: tradeId), Test.beSucceeded())

    // Alice received bob's 2; bob received alice's 3.
    let aliceFinal = collectionIds(of: alice)
    let bobFinal   = collectionIds(of: bob)
    Test.assertEqual(2, aliceFinal.length)
    Test.assertEqual(3, bobFinal.length)
    for id in bobIds   { Test.assertEqual(true, aliceFinal.contains(id)) }
    for id in aliceIds { Test.assertEqual(true, bobFinal.contains(id))   }
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 3: Wrong id rejection
//   Alice tries to deposit an NFT whose id is not in expectedIds.
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testWrongIdRejection() {
    let aliceCommittedId = mintExampleNFT(to: alice)
    let aliceExtraId     = mintExampleNFT(to: alice)  // not in trade
    let bobNftId         = mintExampleNFT(to: bob)

    let tradeId = proposeTrade(
        partyA: alice.address, partyB: bob.address,
        partyAExpectedIds: [aliceCommittedId],
        partyBExpectedIds: [bobNftId],
        expirySeconds: 3600.0
    )

    let result = depositToTrade(signer: alice, tradeId: tradeId, nftIds: [aliceExtraId])
    Test.expect(result, Test.beFailed())
    // Reverts mean alice still holds both her originals.
    let aliceIds = collectionIds(of: alice)
    Test.assertEqual(true, aliceIds.contains(aliceCommittedId))
    Test.assertEqual(true, aliceIds.contains(aliceExtraId))
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 4: Partial deposit rejection
//   Alice commits 2 ids but only deposits 1 in the tx — must revert.
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testPartialDepositRejection() {
    let id1 = mintExampleNFT(to: alice)
    let id2 = mintExampleNFT(to: alice)
    let bobId = mintExampleNFT(to: bob)

    let tradeId = proposeTrade(
        partyA: alice.address, partyB: bob.address,
        partyAExpectedIds: [id1, id2],
        partyBExpectedIds: [bobId],
        expirySeconds: 3600.0
    )

    // Deposit only id1, missing id2.
    let result = depositToTrade(signer: alice, tradeId: tradeId, nftIds: [id1])
    Test.expect(result, Test.beFailed())
    // Both NFTs still in alice's collection (reverted).
    let aliceIds = collectionIds(of: alice)
    Test.assertEqual(true, aliceIds.contains(id1))
    Test.assertEqual(true, aliceIds.contains(id2))
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 5: Cancel path
//   Alice deposits, then cancels. Her NFTs return.
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testCancelReturnsDeposits() {
    let aliceId = mintExampleNFT(to: alice)
    let bobId   = mintExampleNFT(to: bob)

    let tradeId = proposeTrade(
        partyA: alice.address, partyB: bob.address,
        partyAExpectedIds: [aliceId],
        partyBExpectedIds: [bobId],
        expirySeconds: 3600.0
    )

    Test.expect(depositToTrade(signer: alice, tradeId: tradeId, nftIds: [aliceId]), Test.beSucceeded())
    // Alice no longer holds her NFT.
    Test.assertEqual(false, collectionIds(of: alice).contains(aliceId))

    Test.expect(cancelTrade(signer: alice, tradeId: tradeId, reason: "changed mind"), Test.beSucceeded())
    // Refunded.
    Test.assertEqual(true, collectionIds(of: alice).contains(aliceId))
    // Bob untouched (never deposited).
    Test.assertEqual(true, collectionIds(of: bob).contains(bobId))
    // Trade destroyed.
    Test.assertEqual(false, tradeIdExists(tradeId: tradeId))
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 6: Non-party cancel rejection
//   Carol (unrelated) tries to cancel a trade between alice and bob.
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testNonPartyCancelRejected() {
    let aliceId = mintExampleNFT(to: alice)
    let bobId   = mintExampleNFT(to: bob)

    let tradeId = proposeTrade(
        partyA: alice.address, partyB: bob.address,
        partyAExpectedIds: [aliceId],
        partyBExpectedIds: [bobId],
        expirySeconds: 3600.0
    )

    Test.expect(depositToTrade(signer: alice, tradeId: tradeId, nftIds: [aliceId]), Test.beSucceeded())

    let result = cancelTrade(signer: carol, tradeId: tradeId, reason: "griefing")
    Test.expect(result, Test.beFailed())
    // Trade still exists, alice's NFT still escrowed.
    Test.assertEqual(true, tradeIdExists(tradeId: tradeId))
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 7: Expiry reclaim
//   Alice deposits, expiry passes, anyone calls reclaim. Alice's NFTs return.
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testExpiryReclaim() {
    let aliceId = mintExampleNFT(to: alice)
    let bobId   = mintExampleNFT(to: bob)

    // Use minimum expiry (10 min = 600 sec) per contract MIN_EXPIRY.
    let tradeId = proposeTrade(
        partyA: alice.address, partyB: bob.address,
        partyAExpectedIds: [aliceId],
        partyBExpectedIds: [bobId],
        expirySeconds: 600.0
    )
    Test.expect(depositToTrade(signer: alice, tradeId: tradeId, nftIds: [aliceId]), Test.beSucceeded())

    // Advance block time past expiry.
    Test.moveTime(by: 700.0)

    // Anyone — even carol — can reclaim. Use admin for convenience.
    Test.expect(reclaimExpired(tradeId: tradeId), Test.beSucceeded())
    Test.assertEqual(true, collectionIds(of: alice).contains(aliceId))
    Test.assertEqual(false, tradeIdExists(tradeId: tradeId))
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 8: Premature reclaim rejected
//   reclaimExpired before expiry should fail.
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testPrematureReclaimRejected() {
    let aliceId = mintExampleNFT(to: alice)
    let bobId   = mintExampleNFT(to: bob)

    let tradeId = proposeTrade(
        partyA: alice.address, partyB: bob.address,
        partyAExpectedIds: [aliceId],
        partyBExpectedIds: [bobId],
        expirySeconds: 3600.0
    )

    let result = reclaimExpired(tradeId: tradeId)
    Test.expect(result, Test.beFailed())
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 9: Re-execute attempt rejected
//   Execute a trade, then try executing the same tradeId. Must fail.
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testReExecuteRejected() {
    let aliceId = mintExampleNFT(to: alice)
    let bobId   = mintExampleNFT(to: bob)

    let tradeId = proposeTrade(
        partyA: alice.address, partyB: bob.address,
        partyAExpectedIds: [aliceId],
        partyBExpectedIds: [bobId],
        expirySeconds: 3600.0
    )
    Test.expect(depositToTrade(signer: alice, tradeId: tradeId, nftIds: [aliceId]), Test.beSucceeded())
    Test.expect(depositToTrade(signer: bob,   tradeId: tradeId, nftIds: [bobId]),   Test.beSucceeded())
    Test.expect(executeSwap(tradeId: tradeId), Test.beSucceeded())

    let result = executeSwap(tradeId: tradeId)
    Test.expect(result, Test.beFailed())
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 10: Re-deposit attempt rejected
//   Alice deposits, then tries to deposit again on same side without cancel.
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testRedepositRejected() {
    let aliceId1 = mintExampleNFT(to: alice)
    let aliceId2 = mintExampleNFT(to: alice)
    let bobId    = mintExampleNFT(to: bob)

    let tradeId = proposeTrade(
        partyA: alice.address, partyB: bob.address,
        partyAExpectedIds: [aliceId1],
        partyBExpectedIds: [bobId],
        expirySeconds: 3600.0
    )

    Test.expect(depositToTrade(signer: alice, tradeId: tradeId, nftIds: [aliceId1]), Test.beSucceeded())
    // Even though aliceId2 is not committed (wrong-id will fire first),
    // the contract's "Side A already deposited" check must protect even
    // a notionally-valid retry. To force that path, propose a NEW trade
    // and re-attempt with the right side already filled.
    //
    // Cleaner: same-side re-deposit with the already-deposited id.
    let result = depositToTrade(signer: alice, tradeId: tradeId, nftIds: [aliceId1])
    Test.expect(result, Test.beFailed())
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 11: Paused contract
//   Pause: proposeTrade and depositToTrade reject; cancel/reclaim still work.
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testPausedContractBehavior() {
    let aliceId = mintExampleNFT(to: alice)
    let bobId   = mintExampleNFT(to: bob)

    // Create a trade and deposit before pause so we can verify cancel works.
    let tradeId = proposeTrade(
        partyA: alice.address, partyB: bob.address,
        partyAExpectedIds: [aliceId],
        partyBExpectedIds: [bobId],
        expirySeconds: 600.0
    )
    Test.expect(depositToTrade(signer: alice, tradeId: tradeId, nftIds: [aliceId]), Test.beSucceeded())

    // Now pause via admin resource.
    let pauseResult = Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/admin_set_paused.cdc"),
            authorizers: [admin.address],
            signers: [admin],
            arguments: [true]
        )
    )
    Test.expect(pauseResult, Test.beSucceeded())

    // Bob's deposit must now fail (contract paused).
    let depResult = depositToTrade(signer: bob, tradeId: tradeId, nftIds: [bobId])
    Test.expect(depResult, Test.beFailed())

    // New proposeTrade must fail.
    let newAliceId = mintExampleNFT(to: alice)
    let newBobId   = mintExampleNFT(to: bob)
    let nftType    = Type<@ExampleNFT.NFT>().identifier
    let now        = getCurrentBlock().timestamp
    let proposeResult = Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/propose_trade.cdc"),
            authorizers: [admin.address],
            signers: [admin],
            arguments: [
                alice.address, bob.address,
                nftType, nftType,
                [newAliceId], [newBobId],
                now + 3600.0
            ]
        )
    )
    Test.expect(proposeResult, Test.beFailed())

    // Cancel still works even while paused — users must always be able
    // to recover.
    Test.expect(cancelTrade(signer: alice, tradeId: tradeId, reason: "paused"), Test.beSucceeded())
    Test.assertEqual(true, collectionIds(of: alice).contains(aliceId))

    // Unpause for hygiene.
    let unpauseResult = Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/admin_set_paused.cdc"),
            authorizers: [admin.address],
            signers: [admin],
            arguments: [false]
        )
    )
    Test.expect(unpauseResult, Test.beSucceeded())
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 12: Invalid expiry rejection (below MIN, above MAX)
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testInvalidExpiryRejected() {
    let aliceId = mintExampleNFT(to: alice)
    let bobId   = mintExampleNFT(to: bob)
    let nftType = Type<@ExampleNFT.NFT>().identifier
    let now     = getCurrentBlock().timestamp

    // Too short (< 600 sec / 10 min)
    let tooShort = Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/propose_trade.cdc"),
            authorizers: [admin.address],
            signers: [admin],
            arguments: [
                alice.address, bob.address,
                nftType, nftType,
                [aliceId], [bobId],
                now + 60.0  // 1 minute — too short
            ]
        )
    )
    Test.expect(tooShort, Test.beFailed())

    // Too long (> 604800 sec / 7 days)
    let tooLong = Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/propose_trade.cdc"),
            authorizers: [admin.address],
            signers: [admin],
            arguments: [
                alice.address, bob.address,
                nftType, nftType,
                [aliceId], [bobId],
                now + 1209600.0  // 14 days — too long
            ]
        )
    )
    Test.expect(tooLong, Test.beFailed())
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 13 (bonus): Same-party trade rejection
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testSamePartyTradeRejected() {
    let id1 = mintExampleNFT(to: alice)
    let id2 = mintExampleNFT(to: alice)
    let nftType = Type<@ExampleNFT.NFT>().identifier
    let now     = getCurrentBlock().timestamp

    let result = Test.executeTransaction(
        Test.Transaction(
            code: Test.readFile("transactions/propose_trade.cdc"),
            authorizers: [admin.address],
            signers: [admin],
            arguments: [
                alice.address, alice.address,  // SAME
                nftType, nftType,
                [id1], [id2],
                now + 3600.0
            ]
        )
    )
    Test.expect(result, Test.beFailed())
}

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 14 (bonus): Type mismatch
//   Alice commits an ExampleNFT type but tries to deposit a different NFT type.
//   We don't have a second NFT contract available in the emulator by default,
//   so this is left as a TODO requiring a second example contract or skipped.
// ────────────────────────────────────────────────────────────────────────────

// TODO: testTypeMismatchRejected
//   Needs a second NonFungibleToken-conforming contract in the test env.
//   Either deploy a tiny ExampleNFT2.cdc fixture or skip until real-collection
//   testnet exercise.

// ────────────────────────────────────────────────────────────────────────────
// SCENARIO 15 (bonus): Admin cannot drain an active trade
//   Verifies the no-drain security property by exhaustively probing every
//   public Admin entry. Currently Admin only exposes setPaused(_:); if more
//   admin functions are added, this test must be extended.
// ────────────────────────────────────────────────────────────────────────────

access(all) fun testAdminCannotDrain() {
    let aliceId = mintExampleNFT(to: alice)
    let bobId   = mintExampleNFT(to: bob)

    let tradeId = proposeTrade(
        partyA: alice.address, partyB: bob.address,
        partyAExpectedIds: [aliceId],
        partyBExpectedIds: [bobId],
        expirySeconds: 3600.0
    )
    Test.expect(depositToTrade(signer: alice, tradeId: tradeId, nftIds: [aliceId]), Test.beSucceeded())

    // Admin's only published method is setPaused. There is no
    // adminWithdraw / forceCancel / drain in the contract by design.
    // This test simply documents that and will start failing if such
    // a method is ever added without explicit review.
    let result = Test.executeScript(
        Test.readFile("scripts/audit_admin_surface.cdc"),
        []
    )
    Test.expect(result, Test.beSucceeded())
    let exposedMethods = result.returnValue! as! [String]
    // Permitted set:
    Test.assertEqual(["setPaused"], exposedMethods)
}
