// transactions/giveaway_open.cdc — anyone opens an assigned pack (NFTs go to its winner only).
import "RPCGiveawayPacks"

transaction(packID: UInt64) {
    prepare(signer: &Account) {}
    execute {
        RPCGiveawayPacks.open(packID: packID)
    }
}
