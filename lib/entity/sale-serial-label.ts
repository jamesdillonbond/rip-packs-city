// lib/entity/sale-serial-label.ts
// The serial line on an entity page's sale row. Three states, not two: a
// resolved serial ("#7"); a pin that carries NO serial by design — a Disney
// Pinnacle Open / Open Event / Starter Edition, `serial_numbered === false`
// ("unnumbered"); and a numbered sale whose serial is not resolved yet. Before
// 2026-09-28 every Open Edition sale read "serial unresolved" — 14,012 of
// 16,473 Pinnacle sales in 60 days, none of which will ever have a serial.

export function saleSerialLabel(s: { serial_number: number | null | undefined; serial_numbered?: boolean | null }): {
  text: string
  resolved: boolean
} {
  if (s.serial_number != null && s.serial_number > 0) return { text: `#${s.serial_number}`, resolved: true }
  if (s.serial_numbered === false) return { text: "unnumbered", resolved: false }
  return { text: "serial unresolved", resolved: false }
}
