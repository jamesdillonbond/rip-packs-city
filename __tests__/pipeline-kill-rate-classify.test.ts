import { describe, it, expect } from 'vitest'
import {
  classifyKillRecord,
  correlateRuns,
  RECOVERY_P_THRESHOLD,
  type KillTick,
} from '@/lib/pipeline/kill-rate'

// Build a tick sequence from a pattern string, oldest-first.
// 'x' = killed, '.' = completed. One tick per hour, so ordering is unambiguous.
function seq(pattern: string): KillTick[] {
  const base = Date.parse('2026-08-25T00:00:00Z')
  return [...pattern].map((c, i) => ({
    startedAt: new Date(base + i * 3_600_000),
    killed: c === 'x',
  }))
}

describe('classifyKillRecord — the verdicts', () => {
  it('calls a clean record healthy', () => {
    const r = classifyKillRecord('p', seq('..........'))
    expect(r.verdict).toBe('healthy')
    expect(r.killRatePct).toBe(0)
  })

  it('calls it failing when the MOST RECENT tick was killed, however low the rate', () => {
    const r = classifyKillRecord('p', seq('.................x'))
    expect(r.verdict).toBe('failing')
    // The discriminator is recency, not the rate: this record is only 5.6% killed.
    expect(r.killRatePct).toBeLessThan(10)
  })

  it('does NOT call an absent record healthy — no ticks is not evidence of health', () => {
    const r = classifyKillRecord('p', [])
    expect(r.verdict).not.toBe('healthy')
    expect(r.verdict).toBe('intermittent')
    expect(r.note).toMatch(/nothing is known/i)
  })

  it('leaves a genuinely interleaved record intermittent rather than recovered', () => {
    // fmv-recalc's shape: kills throughout, a short clean tail that proves nothing.
    const r = classifyKillRecord('p', seq('x.xx.x.xx.x.xx.x.xx.x.xx.x.xx..'))
    expect(r.verdict).toBe('intermittent')
    expect(r.cleanTicks).toBe(2)
    expect(r.chanceRunIsLuck).toBeGreaterThan(RECOVERY_P_THRESHOLD)
  })
})

describe('classifyKillRecord — the defect it exists to prevent', () => {
  // 2026-08-28: candy-listings-indexer, verbatim from pipeline_runs.
  // 16 pre-fix ticks with 14 kills, then the 08-27 03:48Z deploy, then 9 clean.
  // Pooled that is 14/25 = 56% killed, which was filed as an ongoing failure.
  //
  // ⚠ The clean RUN is 10, not 9: the last pre-fix tick (08-27 03:35Z) also
  // completed, at the quiet hour, in 252 s of a 300 s wall. That is the honest
  // shape of the evidence — the classifier reads the RECORD, and the record's
  // break does not land exactly on the deploy. Naming the deploy as the cause
  // is a separate claim, made by a human, from the git log.
  const CANDY = seq('x.xxxxxxxxxxxxx.' + '.........')

  it('reproduces the pooled rate that misled — the input really is 56% killed', () => {
    const r = classifyKillRecord('candy-listings-indexer', CANDY)
    expect(r.ticks).toBe(25)
    expect(r.killed).toBe(14)
    expect(r.killRatePct).toBe(56)
  })

  it('🚨 nevertheless calls it RECOVERED, because the kills are a block that ended', () => {
    const r = classifyKillRecord('candy-listings-indexer', CANDY)
    expect(r.verdict).toBe('recovered')
    expect(r.cleanTicks).toBe(10)
    expect(r.chanceRunIsLuck).toBeLessThan(RECOVERY_P_THRESHOLD)
  })

  it('and its note REFUSES to let the historical rate be reported as current', () => {
    const r = classifyKillRecord('candy-listings-indexer', CANDY)
    // Assert the ABSENCE of the false claim, not merely the presence of a caveat:
    // the note must not offer "56% killed" as a bare present-tense fact.
    expect(r.note).toMatch(/HISTORICAL/)
    expect(r.note).not.toMatch(/^56% killed/)
  })

  it('NEGATIVE CONTROL: the same 14 kills placed at the END are NOT recovered', () => {
    // Same tick count, same kill count, same pooled rate — only the order differs.
    // This is the whole point: a rate cannot separate these two records, and the
    // classifier must. If this ever passes as `recovered`, recency has stopped
    // being consulted and the module is back to reporting a bare percentage.
    const reversed = seq('.........' + 'x.xxxxxxxxxxxxx.'.split('').reverse().join(''))
    const r = classifyKillRecord('candy-listings-indexer', reversed)
    expect(r.killed).toBe(14)
    expect(r.killRatePct).toBe(56)
    expect(r.verdict).not.toBe('recovered')
    expect(r.verdict).toBe('failing')
  })
})

describe('classifyKillRecord — the recovery test is a test, not a threshold', () => {
  it('needs FEWER clean ticks to clear a badly-broken record than a mildly-broken one', () => {
    // Six clean ticks after an 80%-killed record: decisive.
    const badlyBroken = classifyKillRecord('p', seq('xxxxxxxx' + '......'))
    // The same six clean ticks after a lightly-killed record: proves nothing.
    // ⚠ The pattern must END in a kill, or the clean run runs back through it.
    const mildlyBroken = classifyKillRecord('p', seq('x......x......x' + '......'))

    expect(badlyBroken.cleanTicks).toBe(mildlyBroken.cleanTicks)
    expect(badlyBroken.verdict).toBe('recovered')
    expect(mildlyBroken.verdict).toBe('intermittent')
  })

  it('pools CONSERVATIVELY — the clean era deflates the null rate, so recovery is harder', () => {
    const r = classifyKillRecord('p', seq('xxxxxxxxxxxxxx..' + '.........'))
    // The broken era ran at 87.5%; pooled it reads 56%. p must be computed at
    // the LOWER (pooled) rate, i.e. must exceed what the broken era would give.
    const pAtBrokenEraRate = Math.pow(1 - 0.875, r.cleanTicks)
    expect(r.chanceRunIsLuck!).toBeGreaterThan(pAtBrokenEraRate)
  })
})

describe('classifyKillRecord — input handling', () => {
  it('is order-independent: newest-first input gives the same verdict', () => {
    const oldestFirst = seq('x.xxxxxxxxxxxxx.' + '.........')
    const newestFirst = [...oldestFirst].reverse()
    expect(classifyKillRecord('p', newestFirst)).toEqual(classifyKillRecord('p', oldestFirst))
  })

  it('does not mutate the caller array', () => {
    const ticks = seq('x..x.')
    const before = ticks.map((t) => t.startedAt.getTime())
    classifyKillRecord('p', ticks)
    expect(ticks.map((t) => t.startedAt.getTime())).toEqual(before)
  })
})

describe('correlateRuns — the step that was re-derived by hand and got it wrong', () => {
  // The real candy-listings-indexer record, transcribed from `pipeline_runs` on
  // 2026-08-28: 25 three-hourly heartbeats, of which 11 have a terminal row.
  // Kept as raw rows so the correlation itself is under test, not just the maths.
  const KILLED_AT = [
    '2026-08-25T03:35:09Z', '2026-08-25T12:35:09Z', '2026-08-25T15:35:09Z',
    '2026-08-25T18:35:09Z', '2026-08-25T21:35:09Z', '2026-08-26T00:35:09Z',
    '2026-08-26T03:35:09Z', '2026-08-26T06:35:09Z', '2026-08-26T09:35:09Z',
    '2026-08-26T12:35:09Z', '2026-08-26T15:35:09Z', '2026-08-26T18:35:09Z',
    '2026-08-26T21:35:09Z', '2026-08-27T00:35:09Z',
  ]
  const COMPLETED_AT = [
    '2026-08-25T06:35:09Z', '2026-08-27T03:35:09Z', '2026-08-27T04:36:09Z',
    '2026-08-27T06:35:09Z', '2026-08-27T09:35:09Z', '2026-08-27T12:35:09Z',
    '2026-08-27T15:35:09Z', '2026-08-27T18:35:09Z', '2026-08-27T21:35:09Z',
    '2026-08-28T00:35:09Z', '2026-08-28T03:35:09Z',
  ]
  const ROWS = [
    ...[...KILLED_AT, ...COMPLETED_AT].map((t) => ({
      pipeline: 'candy-listings-indexer-heartbeat',
      started_at: t,
    })),
    // Terminal rows land a few hundred ms after the heartbeat, inside the window.
    ...COMPLETED_AT.map((t) => ({
      pipeline: 'candy-listings-indexer',
      started_at: new Date(Date.parse(t) + 340).toISOString(),
    })),
  ]

  it('reproduces the live record: 25 ticks, 14 killed, and calls it RECOVERED', () => {
    const [r] = correlateRuns(ROWS)
    expect(r.pipeline).toBe('candy-listings-indexer')
    expect(r.ticks).toBe(25)
    expect(r.killed).toBe(14)
    expect(r.verdict).toBe('recovered')
  })

  it('POSITIVE CONTROL: deleting the terminal rows makes every tick read as killed', () => {
    // Without this, a correlation that matched NOTHING would also report 14 kills
    // for the wrong reason, and the test above would pass on a broken join.
    const noTerminals = ROWS.filter((r) => r.pipeline.endsWith('-heartbeat'))
    const [r] = correlateRuns(noTerminals)
    expect(r.killed).toBe(25)
    expect(r.verdict).toBe('failing')
  })

  it('NEGATIVE CONTROL: a terminal row OUTSIDE the window does not clear a kill', () => {
    const late = ROWS.map((r) =>
      r.pipeline.endsWith('-heartbeat')
        ? r
        : { ...r, started_at: new Date(Date.parse(r.started_at) + 60_000).toISOString() }
    )
    const [r] = correlateRuns(late)
    expect(r.killed).toBe(25)
  })

  it('does not confuse one pipeline with another that shares a name prefix', () => {
    const mixed = [
      ...ROWS,
      { pipeline: 'candy-listings-indexer-retry-heartbeat', started_at: '2026-08-28T03:35:09Z' },
    ]
    const byName = Object.fromEntries(correlateRuns(mixed).map((r) => [r.pipeline, r]))
    expect(Object.keys(byName).sort()).toEqual([
      'candy-listings-indexer',
      'candy-listings-indexer-retry',
    ])
    // The sibling's lone heartbeat has no terminal row of its own, and must NOT
    // have been cleared by the base pipeline's terminal row at the same instant.
    expect(byName['candy-listings-indexer-retry'].killed).toBe(1)
    expect(byName['candy-listings-indexer'].ticks).toBe(25)
  })

  it('ranks a failing pipeline above a recovered one regardless of rate', () => {
    const mixed = [
      ...ROWS,
      { pipeline: 'other-heartbeat', started_at: '2026-08-28T01:00:00Z' },
    ]
    const out = correlateRuns(mixed)
    expect(out[0].pipeline).toBe('other')
    expect(out[0].verdict).toBe('failing')
    // ...even though `other` is 1 tick and candy pooled 56%.
    expect(out[1].pipeline).toBe('candy-listings-indexer')
  })
})
