// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { TIER_NOTES, createRevealSound, readSoundMuted, saveSoundMuted } from "@/lib/giveaways/reveal-sound"

// The opening's sound (2026-11-10). What matters: nothing touches the audio device until a
// sound is asked for; a muted or unsupported browser makes NO nodes and throws nothing; the
// rarer the tier the more notes ring; the mute choice is remembered; close releases the device.

function fakeAudio(opts: { state?: string; throwOnGain?: boolean } = {}) {
  const made = { ctx: 0, osc: [] as { type: string; freqs: number[]; started: number }[], noise: 0, filters: [] as string[], closed: 0, resumed: 0, suspended: 0 }
  const param = (sink?: number[]) => ({
    value: 0,
    setValueAtTime: (v: number) => void sink?.push(v),
    exponentialRampToValueAtTime: (v: number) => void sink?.push(v),
  })
  class Ctx {
    currentTime = 10
    sampleRate = 8000
    state = opts.state ?? "running"
    destination = {}
    constructor() {
      made.ctx++
    }
    createGain() {
      if (opts.throwOnGain) throw new Error("no audio device")
      return { gain: param(), connect() {} }
    }
    createOscillator() {
      const o = { type: "sine", freqs: [] as number[], started: -1 }
      made.osc.push(o)
      return { set type(t: string) { o.type = t }, get type() { return o.type }, frequency: param(o.freqs), connect() {}, start: (t: number) => void (o.started = t), stop() {} }
    }
    createBuffer(_c: number, len: number) {
      return { getChannelData: () => new Float32Array(len) }
    }
    createBufferSource() {
      made.noise++
      return { buffer: null, connect() {}, start() {}, stop() {} }
    }
    createBiquadFilter() {
      const f = { frequency: param(), connect() {} }
      return { set type(t: string) { made.filters.push(t) }, ...f }
    }
    resume() {
      made.resumed++
      return Promise.resolve()
    }
    suspend() {
      made.suspended++
      return Promise.resolve()
    }
    close() {
      made.closed++
      return Promise.resolve()
    }
  }
  vi.stubGlobal("AudioContext", Ctx)
  ;(window as unknown as { AudioContext: unknown }).AudioContext = Ctx
  return made
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as { AudioContext?: unknown }).AudioContext
  delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext
  localStorage.clear()
})

describe("reveal sound", () => {
  it("creates no audio context until the first sound, then reuses one", () => {
    const made = fakeAudio()
    const s = createRevealSound()
    expect(made.ctx).toBe(0)
    s.flip("common")
    s.flip("common")
    expect(made.ctx).toBe(1)
  })

  it("a flip is a swish plus the tier's notes: more notes the rarer the card, each starting later than the last", () => {
    const made = fakeAudio()
    const s = createRevealSound()
    s.flip("common")
    expect(made.noise).toBe(1)
    expect(made.osc.map((o) => o.freqs[0])).toEqual([...TIER_NOTES.common])
    made.osc.length = 0
    s.flip("legendary")
    const main = made.osc.filter((o) => o.type === "triangle")
    expect(main.map((o) => o.freqs[0])).toEqual([...TIER_NOTES.legendary])
    const starts = main.map((o) => o.started)
    expect(starts.slice().sort((a, b) => a - b)).toEqual(starts)
    expect(new Set(starts).size).toBe(starts.length)
    // rare and up also get a quiet octave above each note
    expect(made.osc.filter((o) => o.type === "sine").map((o) => o.freqs[0])).toEqual(TIER_NOTES.legendary.map((hz) => hz * 2))
    const counts = (["common", "fandom", "rare", "legendary", "ultimate"] as const).map((t) => TIER_NOTES[t].length)
    expect(counts.slice().sort((a, b) => a - b)).toEqual(counts)
  })

  it("the tear, the charge, the chase and the summary each make sound; a quick tear is only the rip", () => {
    const made = fakeAudio()
    const s = createRevealSound()
    s.tear()
    expect(made.noise).toBe(3)
    expect(made.osc).toHaveLength(2)
    made.noise = 0
    made.osc.length = 0
    s.tear(true)
    expect(made.noise).toBe(1)
    expect(made.osc).toHaveLength(0)
    s.charge(1100)
    expect(made.osc.map((o) => o.type)).toEqual(["sawtooth", "sine"])
    // the hum rises
    expect(made.osc[0].freqs[1]).toBeGreaterThan(made.osc[0].freqs[0])
    made.osc.length = 0
    s.chase("rare")
    // a falling low hit under the tier's notes
    expect(made.osc[0].freqs[1]).toBeLessThan(made.osc[0].freqs[0])
    expect(made.osc.filter((o) => o.type === "triangle").map((o) => o.freqs[0])).toEqual([...TIER_NOTES.rare])
    made.osc.length = 0
    s.summary()
    expect(made.osc).toHaveLength(3)
  })

  it("muted makes no nodes and no context; unmuting brings sound back; muting a running context suspends it", () => {
    const made = fakeAudio()
    const s = createRevealSound(true)
    s.tear()
    s.flip("ultimate")
    s.chase("ultimate")
    expect(made).toMatchObject({ ctx: 0, noise: 0 })
    s.setMuted(false)
    s.flip("common")
    expect(made.ctx).toBe(1)
    s.setMuted(true)
    expect(made.suspended).toBe(1)
    const before = made.osc.length
    s.flip("common")
    expect(made.osc.length).toBe(before)
  })

  it("a suspended context is resumed when a sound is asked for", () => {
    const made = fakeAudio({ state: "suspended" })
    createRevealSound().flip("common")
    expect(made.resumed).toBe(1)
  })

  it("no Web Audio, or a device that refuses, is silence without an error", () => {
    const none = createRevealSound()
    expect(() => {
      none.tear()
      none.flip("rare")
      none.charge(500)
      none.chase("rare")
      none.summary()
      none.setMuted(true)
      none.close()
    }).not.toThrow()
    const made = fakeAudio({ throwOnGain: true })
    const s = createRevealSound()
    expect(() => s.flip("common")).not.toThrow()
    expect(() => s.flip("common")).not.toThrow()
    // it gave up after the first refusal rather than opening a context per sound
    expect(made.ctx).toBe(1)
  })

  it("the older webkit name works too", () => {
    const made = fakeAudio()
    const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown }
    w.webkitAudioContext = w.AudioContext
    delete w.AudioContext
    createRevealSound().flip("common")
    expect(made.ctx).toBe(1)
  })

  it("close releases the device and nothing sounds afterwards", () => {
    const made = fakeAudio()
    const s = createRevealSound()
    s.flip("common")
    s.close()
    expect(made.closed).toBe(1)
    const before = made.osc.length
    s.flip("common")
    expect(made.osc.length).toBe(before)
    expect(made.ctx).toBe(1)
  })

  it("sound is on until someone turns it off, and the choice is remembered", () => {
    expect(readSoundMuted()).toBe(false)
    saveSoundMuted(true)
    expect(localStorage.getItem("rpc_giveaway_sound")).toBe("off")
    expect(readSoundMuted()).toBe(true)
    saveSoundMuted(false)
    expect(readSoundMuted()).toBe(false)
  })
})
