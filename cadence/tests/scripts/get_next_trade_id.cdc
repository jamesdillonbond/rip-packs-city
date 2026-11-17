// scripts/get_next_trade_id.cdc
//
// Returns the id the next proposeTrade() call will assign. Read via a
// script (not a direct contract call from the test file) because direct
// reads of imported-contract state in the test runner reflect the state
// at import time, not the live chain.

import "RPCTradeEscrow"

access(all) fun main(): UInt64 {
    return RPCTradeEscrow.getNextTradeId()
}
