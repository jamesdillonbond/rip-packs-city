// scripts/giveaway_can_open.cdc
import "RPCGiveawayPacks"

access(all) fun main(packID: UInt64, opener: Address): Bool {
    return RPCGiveawayPacks.canOpen(packID: packID, opener: opener)
}
