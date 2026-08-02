export function getSerialTraits(serial: number, mintSize: number, jersey?: number) {
  const traits: string[] = []

  if (serial === 1) traits.push("#1")
  if (serial === mintSize) traits.push("Perfect Mint")
  if (jersey && serial === jersey) traits.push("Jersey Match")
  if (serial <= Math.max(5, Math.floor(mintSize * 0.01))) traits.push("Low Serial")

  return traits
}

export function getPrimarySerialTrait(traits: string[]) {
  if (traits.includes("#1")) return "#1"
  if (traits.includes("Perfect Mint")) return "Perfect Mint"
  if (traits.includes("Jersey Match")) return "Jersey Match"
  return null
}