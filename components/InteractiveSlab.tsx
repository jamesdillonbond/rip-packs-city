"use client";

// InteractiveSlab — a Moment you can pick up.
//
// 2026-11-25 (Trevor: "Build it"). Collectors asked Top Shot to bring back the
// interactive Moment (@coultin, 11-24). This wraps the /moment/[id] hero media
// in a slab you can drag to spin, flick, flip to its back (serial, set, FMV),
// and on a phone tilt by tilting the phone. It is RPC's own slab, not a copy of
// Top Shot's cube; the face is the Moment's official media, unchanged.
//
// On for everyone since 2026-11-25 (Trevor, "Yes do it all"): a viewer turns it
// off with ?slab=0 (remembered; ?slab=1 turns it back on), and
// NEXT_PUBLIC_MOMENT_SLAB_3D=0 is the kill switch for everyone. When off, the
// front face renders exactly the box the page rendered before — same border,
// same square, same media — and nothing listens for input.
//
// Motion: every frame writes `transform` straight to the DOM from refs, so a
// drag never re-renders React. Reduced motion: no coasting, no idle tilt, no
// phone tilt; a flip lands instantly. touch-action: pan-y keeps vertical page
// scrolling on phones — only a sideways drag spins the slab.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@/lib/a11y/prefers-reduced-motion";
import {
  SLAB_QUERY_PARAM,
  SLAB_STORAGE_KEY,
  FINISH_LABEL,
  clamp,
  flipTarget,
  nearestRest,
  showingBack,
  slabEnabled,
  tiltFromOrientation,
  type SlabFinish,
} from "@/lib/slab-3d";
import type { SlabStatBlock, SlabStats } from "@/lib/slab-stats";
import { track } from "@/lib/telemetry/track";

export type SlabBackRow = { label: string; value: string };

// ── flag (client-only; the server snapshot is "off" so SSR and hydration agree) ──
function readFlag(): boolean {
  if (typeof window === "undefined") return false;
  let query: string | null = null;
  let stored: string | null = null;
  try {
    query = new URLSearchParams(window.location.search).get(SLAB_QUERY_PARAM);
  } catch {
    query = null;
  }
  try {
    stored = window.localStorage.getItem(SLAB_STORAGE_KEY);
  } catch {
    stored = null;
  }
  return slabEnabled({ envDefault: process.env.NEXT_PUBLIC_MOMENT_SLAB_3D, queryValue: query, storedValue: stored });
}
function subscribeFlag(): () => void {
  // Remember an explicit ?slab=1 / ?slab=0 for later page views.
  try {
    const q = new URLSearchParams(window.location.search).get(SLAB_QUERY_PARAM);
    if (q === "1" || q === "0") window.localStorage.setItem(SLAB_STORAGE_KEY, q);
  } catch {
    /* storage can throw in private modes — the query still applies to this view */
  }
  return () => {};
}
// The server renders the default (on, unless the kill switch is set); a viewer's own
// ?slab=0 opt-out applies right after hydration.
const serverFlag = () => slabEnabled({ envDefault: process.env.NEXT_PUBLIC_MOMENT_SLAB_3D, queryValue: null, storedValue: null });

// One physics step is tuned for a 60 Hz frame.
const FRAME_MS = 1000 / 60;

type SlabPhysics = {
  rotY: number;
  rotX: number;
  velY: number;
  targetY: number;
  tiltX: number;
  tiltY: number;
  tiltTargetX: number;
  tiltTargetY: number;
  phase: "rest" | "drag" | "coast" | "settle";
};

// One animation frame of slab physics. Returns whether another frame is needed.
function advance(st: SlabPhysics): boolean {
  // Smooth tilt toward its target.
  st.tiltX += (st.tiltTargetX - st.tiltX) * 0.12;
  st.tiltY += (st.tiltTargetY - st.tiltY) * 0.12;
  if (st.phase === "coast") {
    st.rotY += st.velY;
    st.velY *= 0.95;
    if (Math.abs(st.velY) < 0.9) {
      st.phase = "settle";
      st.targetY = nearestRest(st.rotY);
    }
  }
  if (st.phase === "settle") {
    st.velY += (st.targetY - st.rotY) * 0.06;
    st.velY *= 0.78;
    st.rotY += st.velY;
    if (Math.abs(st.targetY - st.rotY) < 0.05 && Math.abs(st.velY) < 0.05) {
      st.rotY = st.targetY;
      st.velY = 0;
      st.phase = "rest";
    }
  }
  if (st.phase !== "drag") st.rotX += (0 - st.rotX) * 0.14;
  const tiltMoving = Math.abs(st.tiltTargetX - st.tiltX) > 0.02 || Math.abs(st.tiltTargetY - st.tiltY) > 0.02;
  return st.phase === "coast" || st.phase === "settle" || (st.phase !== "drag" && Math.abs(st.rotX) > 0.02) || tiltMoving;
}

type DeviceOrientationCtor = { requestPermission?: () => Promise<"granted" | "denied"> };

export default function InteractiveSlab({
  children,
  frameColor,
  title,
  subtitle,
  serialLine,
  rows,
  finish,
  eyebrow,
  stats,
  badges,
}: {
  children: ReactNode;
  /** The tier colour — the front face's border, as before. */
  frameColor: string;
  /** Back face: subject (player / team / character). */
  title: string;
  /** Back face: one muted line under the title (e.g. "Rare · Series 7"). */
  subtitle?: string | null;
  /** Back face: "#12 / 99", or null on an edition-level page. */
  serialLine?: string | null;
  rows: SlabBackRow[];
  finish: SlabFinish;
  /** Back face: collection label shown at the top. */
  eyebrow?: string | null;
  /** Back face: the player's line from this Moment's game and that season (lib/slab-stats). */
  stats?: SlabStats | null;
  /** Back face: the edition's badges (Rookie Year, Championship Year, …) — up to three shown, then "+N". */
  badges?: string[] | null;
}) {
  const hasStats = !!(stats && (stats.game || stats.season));
  const enabled = useSyncExternalStore(subscribeFlag, readFlag, serverFlag);
  const reducedMotion = usePrefersReducedMotion();

  const cardRef = useRef<HTMLDivElement | null>(null);
  const frontRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLDivElement | null>(null);
  const backInnerRef = useRef<HTMLDivElement | null>(null);

  // Physics state lives in a ref — never in React state.
  const s = useRef({
    rotY: 0,
    rotX: 0,
    velY: 0,
    targetY: 0,
    tiltX: 0,
    tiltY: 0,
    tiltTargetX: 0,
    tiltTargetY: 0,
    phase: "rest" as "rest" | "drag" | "coast" | "settle",
    lastX: 0,
    lastY: 0,
    lastT: 0,
    pointerId: -1,
    raf: 0,
    acc: 0,
    back: false,
    dragDeg: 0,
  });

  // Usage (2026-11-26): whether collectors pick the slab up at all. Each kind is sent at most once
  // per page view, with whether this Moment's back carries stats; nothing about the viewer.
  const sent = useRef<Set<string>>(new Set());
  const report = useCallback(
    (feature: string, meta?: Record<string, unknown>) => {
      if (sent.current.has(feature)) return;
      sent.current.add(feature);
      const path = typeof window !== "undefined" ? window.location.pathname : null;
      track(feature, { path, has_game: !!stats?.game, has_season: !!stats?.season, ...meta });
    },
    [stats],
  );

  const [isBack, setIsBack] = useState(false);
  const [touched, setTouched] = useState(false);
  const [tiltState, setTiltState] = useState<"off" | "on" | "blocked">("off");
  const [canTilt, setCanTilt] = useState(false);
  const tiltBase = useRef<{ beta: number; gamma: number } | null>(null);
  useEffect(() => {
    if (isBack) report("moment-slab-back-seen");
  }, [isBack, report]);

  const paint = useCallback(() => {
    const st = s.current;
    const card = cardRef.current;
    if (!card) return;
    const y = st.rotY + st.tiltY;
    const x = st.rotX + st.tiltX;
    card.style.transform = `rotateX(${x.toFixed(2)}deg) rotateY(${y.toFixed(2)}deg)`;
    // Glare follows the angle: light slides across the face as it turns.
    const gx = 50 + clamp(Math.sin((y * Math.PI) / 180) * 60, -60, 60);
    const gy = 50 - clamp(x * 2, -40, 40);
    card.style.setProperty("--slab-gx", `${gx.toFixed(1)}%`);
    card.style.setProperty("--slab-gy", `${gy.toFixed(1)}%`);
    card.style.setProperty("--slab-ga", (0.08 + Math.min(0.22, (Math.abs(st.tiltX) + Math.abs(st.tiltY) + Math.abs(Math.sin((y * Math.PI) / 180)) * 20) / 120)).toFixed(3));
    const back = showingBack(y);
    if (back !== st.back) {
      st.back = back;
      // iOS Safari can ignore backface-visibility on a <video>; hide the face outright.
      if (frontRef.current) frontRef.current.style.visibility = back ? "hidden" : "visible";
      if (backRef.current) backRef.current.style.visibility = back ? "visible" : "hidden";
      setIsBack(back);
    }
  }, []);

  const kick = useCallback(() => {
    const st = s.current;
    if (st.raf) return;
    let last = -1;
    const tick = (now: number) => {
      st.raf = 0;
      // The physics are tuned per 60 Hz frame. Run as many 60 Hz steps as
      // wall-clock time elapsed (a 120 Hz phone takes a step every other frame,
      // a throttled tab catches up, capped at 4), so the slab spins and settles
      // at the same speed on every display.
      st.acc += last < 0 ? FRAME_MS : Math.min(4 * FRAME_MS, Math.max(0, now - last));
      last = now;
      let more = true;
      while (st.acc >= FRAME_MS && more) {
        st.acc -= FRAME_MS;
        more = advance(st);
      }
      if (!more) st.acc = 0;
      paint();
      if (more) st.raf = requestAnimationFrame(tick);
    };
    st.raf = requestAnimationFrame(tick);
  }, [paint]);

  useEffect(() => {
    const st = s.current;
    return () => {
      if (st.raf) cancelAnimationFrame(st.raf);
    };
  }, []);

  // Fit the back's label inside the square: scale it down (never up) when its content is taller
  // than the face — a long name, a finish badge and two stat lines on a 320 px phone.
  useEffect(() => {
    if (!enabled) return;
    const outer = backRef.current;
    const inner = backInnerRef.current;
    if (!outer || !inner) return;
    const fit = () => {
      // scrollHeight is the LAYOUT height (transforms do not change it), so the drawn height is
      // scrollHeight × k. A narrower k widens the layer, which re-wraps text: iterate to settle.
      let k = 1;
      for (let i = 0; i < 4; i++) {
        inner.style.transform = k === 1 ? "" : `scale(${k.toFixed(4)})`;
        inner.style.width = `${(100 / k).toFixed(3)}%`;
        inner.style.minHeight = `${(100 / k).toFixed(3)}%`;
        const avail = outer.clientHeight;
        const need = inner.scrollHeight;
        if (!avail || !need || need * k <= avail + 0.5) return;
        k = Math.max(0.6, avail / need);
      }
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(outer);
    return () => ro.disconnect();
  }, [enabled, stats, title, rows, serialLine, finish, badges]);

  // Tilt is offered only where it can work: a coarse pointer with orientation events.
  useEffect(() => {
    if (!enabled || reducedMotion) return;
    if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return;
    if (!window.matchMedia?.("(pointer: coarse)").matches) return;
    const id = requestAnimationFrame(() => setCanTilt(true));
    return () => cancelAnimationFrame(id);
  }, [enabled, reducedMotion]);

  useEffect(() => {
    if (tiltState !== "on" || reducedMotion) return;
    const onOrient = (ev: DeviceOrientationEvent) => {
      if (ev.beta == null || ev.gamma == null) return;
      if (!tiltBase.current) tiltBase.current = { beta: ev.beta, gamma: ev.gamma };
      const t = tiltFromOrientation(ev.beta, ev.gamma, tiltBase.current);
      if (st.phase === "drag") return;
      st.tiltTargetX = t.x;
      st.tiltTargetY = t.y;
      kick();
    };
    const st = s.current;
    window.addEventListener("deviceorientation", onOrient);
    return () => {
      window.removeEventListener("deviceorientation", onOrient);
      st.tiltTargetX = 0;
      st.tiltTargetY = 0;
      kick();
    };
  }, [tiltState, reducedMotion, kick]);

  const toggleTilt = useCallback(async () => {
    setTouched(true);
    if (tiltState === "on") {
      setTiltState("off");
      return;
    }
    tiltBase.current = null;
    const ctor = (typeof window !== "undefined" ? (window.DeviceOrientationEvent as unknown as DeviceOrientationCtor) : undefined);
    if (ctor && typeof ctor.requestPermission === "function") {
      try {
        const res = await ctor.requestPermission();
        setTiltState(res === "granted" ? "on" : "blocked");
        if (res === "granted") report("moment-slab-tilt-on");
      } catch {
        setTiltState("blocked");
      }
      return;
    }
    setTiltState("on");
    report("moment-slab-tilt-on");
  }, [tiltState, report]);

  const flip = useCallback(
    (dir: 1 | -1 = 1, via: "button" | "key" = "button") => {
      const st = s.current;
      setTouched(true);
      report("moment-slab-flipped", { via });
      const target = flipTarget(st.phase === "settle" ? st.targetY : st.rotY, dir);
      if (reducedMotion) {
        st.rotY = target;
        st.velY = 0;
        st.phase = "rest";
        paint();
        return;
      }
      st.targetY = target;
      st.phase = "settle";
      kick();
    },
    [reducedMotion, paint, kick, report],
  );

  // ── pointer: drag to spin, flick to coast, hover to tilt (mouse only) ──
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const st = s.current;
    st.phase = "drag";
    st.pointerId = e.pointerId;
    st.lastX = e.clientX;
    st.lastY = e.clientY;
    st.lastT = performance.now();
    st.velY = 0;
    st.dragDeg = 0;
    if (e.pointerType !== "touch") {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety */
      }
    }
    setTouched(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const st = s.current;
    if (st.phase === "drag" && e.pointerId === st.pointerId) {
      const now = performance.now();
      const dx = e.clientX - st.lastX;
      const dy = e.clientY - st.lastY;
      const dt = Math.max(1, now - st.lastT);
      st.rotY += dx * 0.55;
      st.dragDeg += Math.abs(dx * 0.55);
      st.rotX = clamp(st.rotX - dy * 0.35, -28, 28);
      // Velocity in degrees per ~16 ms frame, lightly smoothed.
      st.velY = st.velY * 0.4 + ((dx * 0.55) / dt) * 16 * 0.6;
      st.lastX = e.clientX;
      st.lastY = e.clientY;
      st.lastT = now;
      paint();
      return;
    }
    if (e.pointerType === "mouse" && !reducedMotion && tiltState !== "on") {
      const r = e.currentTarget.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      st.tiltTargetY = clamp(px * 16, -8, 8);
      st.tiltTargetX = clamp(-py * 16, -8, 8);
      kick();
    }
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = s.current;
    if (st.phase !== "drag" || e.pointerId !== st.pointerId) return;
    st.pointerId = -1;
    // a real turn, not a tap or a nudge
    if (st.dragDeg >= 20) report("moment-slab-spun", { pointer: e.pointerType || null });
    // A finger that has not moved for a moment carries no fling.
    if (performance.now() - st.lastT > 90) st.velY = 0;
    if (reducedMotion || Math.abs(st.velY) < 0.9) {
      st.phase = "settle";
      st.targetY = nearestRest(st.rotY);
      st.velY = 0;
    } else {
      st.phase = "coast";
      st.velY = clamp(st.velY, -40, 40);
    }
    kick();
  };
  const onPointerLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    const st = s.current;
    if (tiltState === "on") return;
    st.tiltTargetX = 0;
    st.tiltTargetY = 0;
    kick();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const st = s.current;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      flip(1, "key");
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setTouched(true);
      report("moment-slab-flipped", { via: "key" });
      st.targetY = nearestRest(st.phase === "settle" ? st.targetY : st.rotY) + (e.key === "ArrowRight" ? 180 : -180);
      if (reducedMotion) {
        st.rotY = st.targetY;
        st.phase = "rest";
        paint();
      } else {
        st.phase = "settle";
        kick();
      }
    }
  };

  const finishColor =
    finish === "first" ? "var(--rpc-warning, #F59E0B)" : finish === "jersey" ? "var(--rpc-red-text, #FF4D40)" : finish === "perfect" ? "var(--rpc-silver, #BFC0BF)" : null;

  // Text drawn in the tier / finish colour is mixed toward the theme's text colour so it keeps its
  // contrast in both themes (a bright tier green on the light theme's white face was hard to read).
  // Borders and fills keep the pure colour.
  const textTint = (c: string) => `color-mix(in srgb, ${c} 72%, var(--rpc-text-primary, #F1F1F1))`;

  const faceBase: CSSProperties = {
    position: "absolute",
    inset: 0,
    borderRadius: 12,
    overflow: "hidden",
    backfaceVisibility: "hidden",
    WebkitBackfaceVisibility: "hidden",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          position: "relative",
          aspectRatio: "1 / 1",
          perspective: enabled ? 1100 : undefined,
          touchAction: enabled ? "pan-y" : undefined,
          cursor: enabled ? "grab" : undefined,
          userSelect: enabled ? "none" : undefined,
          WebkitUserSelect: enabled ? "none" : undefined,
          outline: "none",
        }}
        role={enabled ? "group" : undefined}
        aria-roledescription={enabled ? "interactive slab" : undefined}
        aria-label={enabled ? `${title} slab — drag to spin, Enter to flip. Showing the ${isBack ? "back" : "front"}.` : undefined}
        tabIndex={enabled ? 0 : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
        className={enabled ? "rpc-slab3d" : undefined}
      >
        <div
          ref={cardRef}
          style={{
            position: "absolute",
            inset: 0,
            transformStyle: enabled ? "preserve-3d" : undefined,
            willChange: enabled ? "transform" : undefined,
          }}
        >
          {/* FRONT — identical to the pre-slab hero box when the slab is off. */}
          <div
            ref={frontRef}
            style={{
              ...faceBase,
              border: `2px solid ${frameColor}`,
              background: "var(--rpc-surface, #0a0a0a)",
              transform: enabled ? "translateZ(1px)" : undefined,
              boxShadow: enabled && finishColor ? `0 0 0 1px ${finishColor}, 0 10px 40px rgba(0,0,0,0.55)` : enabled ? "0 10px 40px rgba(0,0,0,0.55)" : undefined,
            }}
          >
            {children}
            {enabled ? (
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  inset: 0,
                  pointerEvents: "none",
                  background: "radial-gradient(circle at var(--slab-gx, 50%) var(--slab-gy, 30%), rgba(255,255,255,var(--slab-ga, 0.08)), transparent 55%)",
                  mixBlendMode: "screen",
                }}
              />
            ) : null}
          </div>

          {/* BACK — the slab's label: serial, set, FMV. */}
          {enabled ? (
            <div
              ref={backRef}
              aria-hidden={!isBack}
              style={{
                ...faceBase,
                visibility: "hidden",
                transform: "rotateY(180deg) translateZ(1px)",
                border: `2px solid ${frameColor}`,
                // A faint sheen mixed from the theme's own surface and text colours, so the back reads
                // in the light theme too (a hard-coded near-black middle put dark text on black there).
                background:
                  "linear-gradient(160deg, var(--rpc-surface, #0D0D0D) 0%, color-mix(in srgb, var(--rpc-surface, #0D0D0D) 94%, var(--rpc-text-primary, #F1F1F1)) 55%, var(--rpc-surface, #0D0D0D) 100%)",
                boxShadow: finishColor ? `0 0 0 1px ${finishColor}` : undefined,
              }}
            >
              {/* Scaled down to fit when a long name or a full stat line would overflow (fitBack). */}
              <div
                ref={backInnerRef}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  minHeight: "100%",
                  boxSizing: "border-box",
                  transformOrigin: "top left",
                  display: "flex",
                  flexDirection: "column",
                  padding: hasStats ? "clamp(14px, 4.5%, 24px)" : "clamp(16px, 5%, 28px)",
                  gap: hasStats ? "clamp(6px, 2%, 10px)" : "clamp(8px, 2.5%, 14px)",
                  color: "var(--rpc-text-primary)",
                }}
              >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  color: "var(--rpc-text-muted)",
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{eyebrow ?? ""}</span>
                {finish ? (
                  <span
                    style={{
                      color: finishColor ? textTint(finishColor) : undefined,
                      border: `1px solid ${finishColor}`,
                      borderRadius: 999,
                      padding: "2px 8px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {FINISH_LABEL[finish]}
                  </span>
                ) : null}
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--font-display)",
                      fontSize: hasStats ? "clamp(17px, 5.4vw, 32px)" : "clamp(24px, 7vw, 40px)",
                      lineHeight: 1.05,
                      textTransform: "uppercase",
                    }}
                  >
                    {title}
                  </div>
                  {subtitle ? (
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: hasStats ? 11 : 12, color: "var(--rpc-text-muted)", marginTop: 3 }}>{subtitle}</div>
                  ) : null}
                </div>
                {/* With stats the serial sits beside the name; without, it gets its own line. */}
                {serialLine && hasStats ? (
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "clamp(16px, 5vw, 30px)",
                      lineHeight: 1,
                      color: textTint(finishColor ?? frameColor),
                      whiteSpace: "nowrap",
                    }}
                  >
                    {serialLine}
                  </div>
                ) : null}
              </div>
              {serialLine && !hasStats ? (
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "clamp(28px, 9vw, 52px)",
                    lineHeight: 1,
                    color: textTint(finishColor ?? frameColor),
                    letterSpacing: "0.02em",
                  }}
                >
                  {serialLine}
                </div>
              ) : null}
              {badges && badges.length > 0 ? <BadgeRow badges={badges} /> : null}
              {stats?.game ? <StatBlockView block={stats.game} accent={textTint(finishColor ?? frameColor)} /> : null}
              {stats?.season ? <StatBlockView block={stats.season} accent={null} /> : null}
              <dl
                style={{
                  margin: 0,
                  marginTop: "auto",
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  columnGap: 14,
                  rowGap: hasStats ? 3 : 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: hasStats ? 11 : 12,
                }}
              >
                {rows.map((r) => (
                  <div key={r.label} style={{ display: "contents" }}>
                    <dt style={{ color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.12em" }}>{r.label}</dt>
                    <dd style={{ margin: 0, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.value}</dd>
                  </div>
                ))}
              </dl>
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 12,
                  letterSpacing: "0.3em",
                  color: "var(--rpc-red-text, #FF4D40)",
                  textAlign: "center",
                  paddingTop: 6,
                  borderTop: "1px solid var(--rpc-border, rgba(255,255,255,0.12))",
                }}
              >
                RIP PACKS CITY
              </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {enabled ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          <button type="button" onClick={() => flip(1)} style={slabButton}>
            {isBack ? "Show front" : "Flip"}
          </button>
          {canTilt ? (
            <button
              type="button"
              onClick={toggleTilt}
              aria-pressed={tiltState === "on"}
              style={{ ...slabButton, ...(tiltState === "on" ? { borderColor: "var(--rpc-red-border)", color: "var(--rpc-red-text)" } : null) }}
              disabled={tiltState === "blocked"}
            >
              {tiltState === "on" ? "Tilt on" : tiltState === "blocked" ? "Tilt blocked" : "Tilt"}
            </button>
          ) : null}
          {isBack && stats?.game?.link ? (
            <a href={stats.game.link} target="_blank" rel="noopener noreferrer" onClick={() => report("moment-slab-box-score")} style={{ ...slabButton, display: "inline-flex", alignItems: "center", boxSizing: "border-box", textDecoration: "none" }}>
              {stats.game.linkLabel ?? "ESPN box score"} ↗
            </a>
          ) : null}
          {!touched ? (
            <span style={{ color: "var(--rpc-text-muted)" }}>Drag to spin it</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// The edition's badges on the back: at most three (wrapping), then "+N" for the rest.
const BADGES_SHOWN = 3;
function BadgeRow({ badges }: { badges: string[] }) {
  const unique = Array.from(new Set(badges.map((b) => b.trim()).filter(Boolean)));
  if (unique.length === 0) return null;
  const shown = unique.slice(0, BADGES_SHOWN);
  const more = unique.length - shown.length;
  return (
    <ul aria-label="Badges" style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: 0, padding: 0, listStyle: "none" }}>
      {shown.map((b) => (
        <li
          key={b}
          style={{
            border: "1px solid var(--rpc-border, rgba(255,255,255,0.18))",
            borderRadius: 999,
            padding: "1px 7px",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            color: "var(--rpc-text-primary)",
          }}
        >
          {b}
        </li>
      ))}
      {more > 0 ? (
        <li style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--rpc-text-muted)", alignSelf: "center", whiteSpace: "nowrap" }}>+{more}</li>
      ) : null}
    </ul>
  );
}

// One stat block on the slab's back: a title line ("This game · vs ORL · W 114-109") over a row
// of big numbers with small labels.
function StatBlockView({ block, accent }: { block: SlabStatBlock; accent: string | null }) {
  return (
    <section aria-label={block.title} style={{ borderTop: "1px solid var(--rpc-border, rgba(255,255,255,0.12))", paddingTop: 5 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--rpc-text-muted)",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: accent ?? "var(--rpc-text-muted)" }}>{block.title}</span>
        {block.detail ? <span style={{ overflow: "hidden", textOverflow: "ellipsis", letterSpacing: "0.06em" }}>{block.detail}</span> : null}
      </div>
      <div style={{ display: "flex", gap: "clamp(8px, 3%, 16px)", marginTop: 4 }}>
        {block.chips.map((c) => (
          <div key={c.label} style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span
              style={{ fontFamily: "var(--font-display)", fontSize: "clamp(15px, 4.6vw, 24px)", lineHeight: 1, color: c.aboveAverage ? "var(--rpc-success-text, #34D399)" : undefined }}
            >
              {c.value}
              {c.aboveAverage ? (
                <>
                  <span aria-hidden="true" style={{ fontSize: "0.5em", marginLeft: 2, verticalAlign: "super" }}>▲</span>
                  <span style={SR_ONLY}> (above season average)</span>
                </>
              ) : null}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em", color: "var(--rpc-text-muted)", marginTop: 2 }}>{c.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const slabButton: CSSProperties = {
  font: "inherit",
  letterSpacing: "inherit",
  textTransform: "inherit",
  color: "var(--rpc-text-primary)",
  background: "var(--rpc-surface-raised, rgba(255,255,255,0.03))",
  border: "1px solid var(--rpc-border, rgba(255,255,255,0.12))",
  borderRadius: 999,
  padding: "8px 14px",
  minHeight: 36,
  cursor: "pointer",
};
