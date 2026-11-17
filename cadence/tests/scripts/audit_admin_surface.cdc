// scripts/audit_admin_surface.cdc
//
// Returns the manually-curated list of methods reachable through the
// Admin resource. This script is a tripwire: if you add a new admin
// function in RPCTradeEscrow.cdc, you MUST update this list, which
// will cause testAdminCannotDrain to fail and force explicit review.
//
// Cadence does not expose a reflection API to programmatically inspect
// a resource's methods at runtime, so this is the cleanest tripwire we
// have. Treat any diff in this file as a security-relevant change.

access(all) fun main(): [String] {
    return ["setPaused"]
}
