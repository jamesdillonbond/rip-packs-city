// Deterministic 4x4 colored-grid identicon derived from a Flow address.
// No external library required — every pair of hex chars seeds one cell's
// fill state plus a primary/secondary color. Mirrored horizontally for
// symmetry, which makes the result visually distinctive at small sizes.

interface WalletIdenticonProps {
  addr: string
  size?: number
  className?: string
}

// Pull a stable color from the address bytes.
function colorFromHex(hex: string, light = false): string {
  const r = parseInt(hex.slice(0, 2) || "10", 16)
  const g = parseInt(hex.slice(2, 4) || "b9", 16)
  const b = parseInt(hex.slice(4, 6) || "81", 16)
  if (light) {
    // shift toward background by mixing with slate-900 (#0f172a)
    const mix = (c: number) => Math.round(c * 0.55 + 15 * 0.45)
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`
  }
  return `rgb(${r},${g},${b})`
}

export default function WalletIdenticon({
  addr,
  size = 48,
  className,
}: WalletIdenticonProps) {
  const hex = (addr || "").replace(/[^0-9a-f]/gi, "").padEnd(16, "0")
  const primary = colorFromHex(hex.slice(0, 6))
  const secondary = colorFromHex(hex.slice(6, 12), true)

  // Generate 4x2 grid then mirror across the vertical axis. Each pair of
  // hex chars (i.e. one byte) decides whether the cell is "filled" with
  // primary or "empty" (secondary background).
  const cells: boolean[] = []
  for (let i = 0; i < 8; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2) || "00", 16)
    cells.push((byte & 1) === 1)
  }

  const grid: boolean[][] = []
  for (let row = 0; row < 4; row++) {
    const left = [cells[row * 2], cells[row * 2 + 1]]
    const right = [...left].reverse()
    grid.push([...left, ...right])
  }

  const cellSize = size / 4

  return (
    <div
      className={
        "rounded-md ring-1 ring-slate-700 overflow-hidden flex-shrink-0 " +
        (className ?? "")
      }
      style={{ width: size, height: size, background: secondary }}
      aria-hidden="true"
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {grid.map((row, ri) =>
          row.map((on, ci) =>
            on ? (
              <rect
                key={`${ri}-${ci}`}
                x={ci * cellSize}
                y={ri * cellSize}
                width={cellSize}
                height={cellSize}
                fill={primary}
              />
            ) : null
          )
        )}
      </svg>
    </div>
  )
}
