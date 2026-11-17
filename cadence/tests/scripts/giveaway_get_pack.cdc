// scripts/giveaway_get_pack.cdc
import "RPCGiveawayPacks"

access(all) fun main(packID: UInt64): RPCGiveawayPacks.PackView? {
    return RPCGiveawayPacks.getPack(packID)
}
