// scripts/giveaway_next_pack_id.cdc
import "RPCGiveawayPacks"

access(all) fun main(): UInt64 {
    return RPCGiveawayPacks.nextPackID
}
