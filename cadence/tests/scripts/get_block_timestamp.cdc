// scripts/get_block_timestamp.cdc
//
// Returns the live chain's current block timestamp. The test file's own
// getCurrentBlock() reflects its import-time snapshot, so expiry math in
// helpers must read the timestamp through a script instead.

access(all) fun main(): UFix64 {
    return getCurrentBlock().timestamp
}
