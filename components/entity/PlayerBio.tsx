// components/entity/PlayerBio.tsx — the player page's "Bio" section (2026-11-08): date of birth,
// birthplace, citizenship and college, from ESPN's athlete record with Top Shot on-chain metadata
// and nflverse as fallbacks (lib/player-bio.ts).
//
// States: a failed read renders SectionUnavailable; no source stating anything renders nothing (an
// absence is not a claim — "no college" is never printed); otherwise one row per stated field.
// Citizenship is labelled as citizenship, never as a country of birth.

import { Section, SectionUnavailable } from "@/components/entity/_shared"
import { buildPlayerBio, type PlayerBioResult } from "@/lib/player-bio"

export default function PlayerBio({ result, ok, playerName }: { result: PlayerBioResult | null; ok: boolean; playerName: string }) {
  if (!ok) {
    return (
      <Section title="Bio">
        <SectionUnavailable noun={`${playerName}’s bio`} />
      </Section>
    )
  }
  const bio = buildPlayerBio(result)
  if (!bio) return null

  const rows: Array<[string, string]> = []
  if (bio.dateOfBirth) rows.push(["Born", bio.dateOfBirthConflict ? `${bio.dateOfBirth} (sources differ: ${bio.dateOfBirthConflict})` : bio.dateOfBirth])
  if (bio.birthplace) rows.push(["Birthplace", bio.birthplace])
  if (bio.citizenship) rows.push(["Citizenship", bio.citizenship])
  if (bio.college) rows.push(["College", bio.college])

  return (
    <Section
      title="Bio"
      action={
        <span className="rpc-mono" data-testid="player-bio-source" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.06em" }}>
          {bio.sources.join(" · ")}
        </span>
      }
    >
      <dl data-testid="player-bio" style={{ display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: 16, rowGap: 6, margin: 0, fontFamily: "var(--font-mono)", fontSize: 12 }}>
        {rows.map(([label, value]) => (
          <div key={label} data-testid="player-bio-row" style={{ display: "contents" }}>
            <dt style={{ color: "var(--rpc-text-muted)" }}>{label}</dt>
            <dd style={{ margin: 0, color: "var(--rpc-text-primary)" }}>{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}
