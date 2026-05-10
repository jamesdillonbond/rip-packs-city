// lib/cadence/break-transactions.ts
//
// Cadence scripts/transactions for the v0 pack-breaks feature.
//
// BREAK_VALIDATE_RECIPIENTS_TS — script. Given a list of buyer addresses,
//   returns a parallel array of bools indicating whether each address has a
//   public TopShot collection capability. Used pre-lock to surface buyers
//   who never set up their wallet so the operator can chase them before the
//   draft.
//
// BREAK_MULTI_TRANSFER_TS — transaction. Hot-wallet-signed batch transfer
//   of TopShot moments. Pairs recipients[i] with momentIds[i]; lengths must
//   match. Withdraws each moment from the hot wallet's MomentCollection and
//   deposits into the recipient's public collection capability. Chunked
//   upstream into ~30-recipient/moment groups by /api/breaks/[id]/distribute
//   to stay within Flow's per-tx compute budget.
//
// BREAK_RANDOM_SOURCE — script. Reads RandomBeaconHistory.sourceOfRandomness
//   at a target sealed block height and returns the entropy bytes. The
//   draft route waits until the locked-break's target height is sealed,
//   pulls the entropy here, and feeds it to deterministicShuffle to assign
//   teams to spots. RandomBeaconHistory.sourceOfRandomness is the canonical
//   on-chain VRF source on Flow mainnet (contract 0xe467b9dd11fa00df).

export const BREAK_VALIDATE_RECIPIENTS_TS = `
import TopShot from 0x0b2a3299cc857e29
import NonFungibleToken from 0x1d7e57aa55817448

access(all) fun main(addrs: [Address]): [Bool] {
  let result: [Bool] = []
  for addr in addrs {
    let cap = getAccount(addr)
      .capabilities
      .borrow<&{NonFungibleToken.CollectionPublic}>(/public/MomentCollection)
    result.append(cap != nil)
  }
  return result
}
`

export const BREAK_MULTI_TRANSFER_TS = `
import TopShot from 0x0b2a3299cc857e29
import NonFungibleToken from 0x1d7e57aa55817448

transaction(recipients: [Address], momentIds: [UInt64]) {
  let collection: auth(NonFungibleToken.Withdraw) &TopShot.Collection

  prepare(signer: auth(BorrowValue) &Account) {
    assert(
      recipients.length == momentIds.length,
      message: "recipients and momentIds length mismatch"
    )
    self.collection = signer.storage.borrow<auth(NonFungibleToken.Withdraw) &TopShot.Collection>(
      from: /storage/MomentCollection
    ) ?? panic("hot wallet has no TopShot collection")
  }

  execute {
    var i = 0
    while i < momentIds.length {
      let receiver = getAccount(recipients[i])
        .capabilities
        .borrow<&{NonFungibleToken.CollectionPublic}>(/public/MomentCollection)
        ?? panic("recipient ".concat(recipients[i].toString()).concat(" missing TopShot capability"))
      let nft <- self.collection.withdraw(withdrawID: momentIds[i])
      receiver.deposit(token: <-nft)
      i = i + 1
    }
  }
}
`

export const BREAK_RANDOM_SOURCE = `
import RandomBeaconHistory from 0xe467b9dd11fa00df

access(all) fun main(blockHeight: UInt64): [UInt8] {
  let entry = RandomBeaconHistory.sourceOfRandomness(atBlockHeight: blockHeight)
  return entry.value
}
`
