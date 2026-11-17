// scripts/trade_id_exists.cdc
//
// Returns true iff the registry currently holds a Trade with this id.
// Trades are destroyed on execute / cancel / reclaim, so this is the
// canonical "is the trade still live" check.

import "RPCTradeEscrow"

access(all) fun main(tradeId: UInt64): Bool {
    let registry = RPCTradeEscrow.borrowRegistry()
    return registry.has(id: tradeId)
}
