import type { CSSProperties } from "react";

type Props = {
  className?: string;
  density?: number;
  style?: CSSProperties;
};

/**
 * PinwheelDivider — barely-perceptible geometric divider for section breaks.
 * Four-blade pinwheels tile horizontally; stroke + fill use --rpc-border-subtle
 * with overall opacity 0.08 so the motif reads as texture, not branding.
 * Server-renderable, no client interactivity.
 */
export default function PinwheelDivider({
  className,
  density = 8,
  style,
}: Props) {
  const tileSize = 60;
  const totalWidth = density * tileSize;

  return (
    <div
      aria-hidden
      className={className}
      style={{
        width: "100%",
        height: 80,
        opacity: 0.08,
        pointerEvents: "none",
        overflow: "hidden",
        ...style,
      }}
    >
      <svg
        viewBox={`0 0 ${totalWidth} 80`}
        preserveAspectRatio="xMidYMid meet"
        width="100%"
        height="100%"
        xmlns="http://www.w3.org/2000/svg"
      >
        {Array.from({ length: density }).map((_, i) => {
          const cx = i * tileSize + tileSize / 2;
          const cy = 40;
          const r = 18;
          return (
            <g
              key={i}
              transform={`translate(${cx} ${cy})`}
              fill="var(--rpc-border-subtle)"
              stroke="var(--rpc-border-subtle)"
              strokeWidth={1}
              strokeLinejoin="round"
            >
              {[0, 90, 180, 270].map((deg) => (
                <path
                  key={deg}
                  transform={`rotate(${deg})`}
                  d={`M 0 0 L ${r} -2 Q ${r * 0.7} ${r * 0.4} 2 ${r} Z`}
                />
              ))}
              <circle cx={0} cy={0} r={2} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
