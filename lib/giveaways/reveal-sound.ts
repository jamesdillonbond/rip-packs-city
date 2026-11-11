// lib/giveaways/reveal-sound.ts
//
// Sound for the pack opening (Trevor, 2026-11-10: "do both" — sound and per-drop
// pack art). Every sound is synthesised with the Web Audio API at the moment it
// plays: no audio files, nothing to download, nothing before the first tap (the
// AudioContext is created inside the tap that tears the pack, which is also what
// browsers require). A browser without Web Audio, or one that refuses to start
// it, gets silence and no error.
//
// The claimer can switch sound off; the choice is remembered for this browser.
// Phones on silent stay silent (Web Audio follows the ringer switch on iOS).

import type { tierKey } from "@/lib/giveaways/reveal"

type Tier = ReturnType<typeof tierKey>

const MUTE_KEY = "rpc_giveaway_sound"

/** Whether this browser has switched the opening's sound off. Sound is on until someone turns it off. */
export function readSoundMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "off"
  } catch {
    return false
  }
}

export function saveSoundMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "off" : "on")
  } catch {
    // private mode / blocked storage: the choice lasts for this page only
  }
}

/** The notes (Hz) a flipped card rings, by tier: one soft note for a common, a longer rising run the rarer it is. */
export const TIER_NOTES: Record<Tier, readonly number[]> = {
  common: [523.25],
  fandom: [587.33, 783.99],
  rare: [659.25, 783.99, 1046.5],
  legendary: [659.25, 830.61, 987.77, 1318.51],
  ultimate: [698.46, 880, 1046.5, 1396.91, 1760],
}

export interface RevealSound {
  /** The pack tearing open. `quick` (reduced motion: the tear is instant) plays only the rip. */
  tear(quick?: boolean): void
  /** A card turning over, then its tier's notes. */
  flip(tier: Tier): void
  /** The rising hum while the chase card charges, lasting `ms`. */
  charge(ms: number): void
  /** The chase card landing: a low hit under its tier's notes. */
  chase(tier: Tier): void
  /** The whole pack laid out. */
  summary(): void
  setMuted(muted: boolean): void
  /** Stops everything and releases the audio device. */
  close(): void
}

type Ctor = new () => AudioContext

function audioContextCtor(): Ctor | null {
  if (typeof window === "undefined") return null
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

const MASTER = 0.22

/**
 * The opening's sounds. Nothing is created until the first sound is asked for, so
 * constructing this is free and safe during render.
 */
export function createRevealSound(startMuted = false): RevealSound {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let noiseBuf: AudioBuffer | null = null
  let muted = startMuted
  let dead = false

  /** The running context, or null when sound is off, unsupported or refused. */
  const live = (): AudioContext | null => {
    if (muted || dead) return null
    try {
      if (!ctx) {
        const C = audioContextCtor()
        if (!C) {
          dead = true
          return null
        }
        ctx = new C()
        master = ctx.createGain()
        master.gain.value = MASTER
        master.connect(ctx.destination)
      }
      if (ctx.state === "suspended") void ctx.resume().catch(() => {})
      return ctx
    } catch {
      dead = true
      return null
    }
  }

  const noise = (c: AudioContext): AudioBuffer => {
    if (noiseBuf) return noiseBuf
    const len = Math.floor(c.sampleRate * 1.2)
    const buf = c.createBuffer(1, len, c.sampleRate)
    const data = buf.getChannelData(0)
    // a fixed pseudo-random sequence: the same hiss every time, no Math.random
    let s = 22222
    for (let i = 0; i < len; i++) {
      s = (s * 16807) % 2147483647
      data[i] = (s / 2147483647) * 2 - 1
    }
    noiseBuf = buf
    return buf
  }

  /** One enveloped oscillator: `from` Hz gliding to `to` over `dur` seconds, starting `at` seconds from now. */
  const tone = (c: AudioContext, o: { at: number; dur: number; from: number; to?: number; type?: OscillatorType; peak: number; attack?: number }) => {
    const t0 = c.currentTime + o.at
    const osc = c.createOscillator()
    const g = c.createGain()
    osc.type = o.type ?? "sine"
    osc.frequency.setValueAtTime(o.from, t0)
    if (o.to != null) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + o.dur)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(o.peak, t0 + (o.attack ?? 0.01))
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur)
    osc.connect(g)
    g.connect(master as GainNode)
    osc.start(t0)
    osc.stop(t0 + o.dur + 0.05)
  }

  /** One enveloped, filtered burst of hiss; the filter sweeps `from` → `to` Hz. */
  const hiss = (c: AudioContext, o: { at: number; dur: number; from: number; to: number; filter: BiquadFilterType; peak: number; attack?: number }) => {
    const t0 = c.currentTime + o.at
    const src = c.createBufferSource()
    src.buffer = noise(c)
    const f = c.createBiquadFilter()
    f.type = o.filter
    f.frequency.setValueAtTime(o.from, t0)
    f.frequency.exponentialRampToValueAtTime(o.to, t0 + o.dur)
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(o.peak, t0 + (o.attack ?? 0.015))
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur)
    src.connect(f)
    f.connect(g)
    g.connect(master as GainNode)
    src.start(t0)
    src.stop(t0 + o.dur + 0.05)
  }

  const notes = (c: AudioContext, tier: Tier, at: number, peak: number) => {
    const run = TIER_NOTES[tier]
    run.forEach((hz, i) => {
      tone(c, { at: at + i * 0.085, dur: 0.5 + run.length * 0.06, from: hz, type: "triangle", peak })
      // a quiet octave above gives the rarer tiers their shimmer
      if (run.length > 2) tone(c, { at: at + i * 0.085, dur: 0.3, from: hz * 2, type: "sine", peak: peak * 0.3 })
    })
  }

  const play = (fn: (c: AudioContext) => void) => {
    const c = live()
    if (!c) return
    try {
      fn(c)
    } catch {
      // a refused node or a closed context: stay silent rather than break the opening
    }
  }

  return {
    tear(quick = false) {
      play((c) => {
        // timed to the tear's keyframes when it runs in full: the strip peels at ~0.33 s, the flash peaks at ~1.2 s
        const rip = quick ? 0 : 0.33
        hiss(c, { at: rip, dur: 0.5, from: 900, to: 5200, filter: "bandpass", peak: 0.9 })
        if (quick) return
        hiss(c, { at: 0, dur: 0.3, from: 300, to: 500, filter: "lowpass", peak: 0.25 })
        hiss(c, { at: 0.75, dur: 0.6, from: 400, to: 7000, filter: "highpass", peak: 0.5, attack: 0.4 })
        tone(c, { at: 1.15, dur: 0.7, from: 392, type: "triangle", peak: 0.4 })
        tone(c, { at: 1.15, dur: 0.7, from: 587.33, type: "triangle", peak: 0.3 })
      })
    },
    flip(tier) {
      play((c) => {
        hiss(c, { at: 0, dur: 0.16, from: 2400, to: 700, filter: "bandpass", peak: 0.5 })
        notes(c, tier, 0.3, tier === "common" ? 0.35 : 0.5)
      })
    },
    charge(ms) {
      play((c) => {
        const dur = Math.max(0.2, ms / 1000)
        tone(c, { at: 0, dur, from: 82, to: 330, type: "sawtooth", peak: 0.28, attack: dur * 0.9 })
        tone(c, { at: 0, dur, from: 164, to: 660, type: "sine", peak: 0.3, attack: dur * 0.9 })
        hiss(c, { at: 0, dur, from: 300, to: 6000, filter: "bandpass", peak: 0.3, attack: dur * 0.9 })
      })
    },
    chase(tier) {
      play((c) => {
        tone(c, { at: 0.3, dur: 0.9, from: 110, to: 38, type: "sine", peak: 1, attack: 0.005 })
        hiss(c, { at: 0.3, dur: 0.9, from: 9000, to: 1500, filter: "highpass", peak: 0.45 })
        notes(c, tier, 0.36, 0.6)
      })
    },
    summary() {
      play((c) => {
        ;[523.25, 659.25, 783.99].forEach((hz, i) => tone(c, { at: i * 0.07, dur: 0.7, from: hz, type: "triangle", peak: 0.3 }))
      })
    },
    setMuted(m) {
      muted = m
      if (m && ctx && ctx.state === "running") void ctx.suspend().catch(() => {})
    },
    close() {
      dead = true
      const c = ctx
      ctx = null
      master = null
      if (c) {
        try {
          void c.close().catch(() => {})
        } catch {
          // already closed
        }
      }
    },
  }
}
