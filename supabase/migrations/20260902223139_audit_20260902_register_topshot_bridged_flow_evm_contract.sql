-- Register NBA Top Shot's bridged ERC-721 on Flow EVM so evm-transfers-ingest
-- has something to walk. The table held exactly one row (a Base/Beezie contract,
-- is_active=false, and Beezie is retired), so this pipeline had no active work at
-- all -- one of two reasons it has never run. The other was lib/evm-rpc.ts
-- refusing to call Flow EVM without a proxy secret, fixed in the same commit.
--
-- Constants verified by direct on-chain read, not from docs:
--   chain 747, eth_chainId -> 0x2eb
--   name() = "NBA Top Shot", symbol() = "TOPSHOT", totalSupply() = 62,843
--     (OpenSea independently reports 62,844)
--   start_block 18620723 = the FIRST block at which the address has code, found
--     by binary search on eth_getCode over the full range in 26 calls. The block
--     timestamp is 2025-02-24T22:08:07Z, which matches Dapper's EVM-bridging
--     launch. Starting later would silently forfeit history; starting at 0 would
--     burn ~3,700 empty windows before reaching it.
--
-- Deliberately does NOT touch the Beezie row: it stays is_active=false.
insert into public.evm_nft_contracts
  (chain_id, contract_address, label, start_block, is_active)
values
  (747, '0x84c6a2e6765e88427c41bb38c82a78b570e24709', 'topshot_bridged_flow_evm', 18620723, true)
on conflict (chain_id, contract_address) do update
  set label = excluded.label,
      start_block = excluded.start_block,
      is_active = excluded.is_active,
      updated_at = now();