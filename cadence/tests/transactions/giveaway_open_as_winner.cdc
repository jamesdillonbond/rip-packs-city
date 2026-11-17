// transactions/giveaway_open_as_winner.cdc — the winner opens their pack and picks the destination:
// `to` = their own address (their Flow Wallet) or another account (e.g. their linked Dapper account).
// Creates the signer's Winner identity on first use.
import "NonFungibleToken"
import "ExampleNFT"
import "RPCGiveawayPacks"

transaction(packID: UInt64, to: Address) {
    prepare(signer: auth(BorrowValue, SaveValue) &Account) {
        if signer.storage.borrow<&RPCGiveawayPacks.Winner>(from: RPCGiveawayPacks.WinnerStoragePath) == nil {
            signer.storage.save(<- RPCGiveawayPacks.createWinner(), to: RPCGiveawayPacks.WinnerStoragePath)
        }
        let winner = signer.storage.borrow<auth(RPCGiveawayPacks.Open) &RPCGiveawayPacks.Winner>(from: RPCGiveawayPacks.WinnerStoragePath)!
        let receiver = getAccount(to).capabilities.borrow<&{NonFungibleToken.Receiver}>(ExampleNFT.CollectionPublicPath)
            ?? panic("Destination cannot receive")
        RPCGiveawayPacks.openAs(packID: packID, winner: winner, to: receiver)
    }
}
