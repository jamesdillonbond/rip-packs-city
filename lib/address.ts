const CADENCE_ADDRESS_REGEX = /^0x[a-fA-F0-9]{16}$/;
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export type AddressChain = "cadence" | "evm" | "unknown";

export function isCadenceAddress(value: string): boolean {
  return CADENCE_ADDRESS_REGEX.test(value.trim());
}

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS_REGEX.test(value.trim());
}

export function detectAddressChain(value: string): AddressChain {
  const trimmed = value.trim();
  if (isCadenceAddress(trimmed)) return "cadence";
  if (isEvmAddress(trimmed)) return "evm";
  return "unknown";
}
