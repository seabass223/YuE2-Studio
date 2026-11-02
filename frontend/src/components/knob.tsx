import { useCallback, useRef } from "react"
import { ramp } from "@/lib/wave"
import { cn } from "@/lib/utils"

interface KnobProps {
  value: number
  min: number
  max: number
  step?: number
  /** Map the knob travel logarithmically (good for durations). */
  log?: boolean
  defaultValue?: number
  disabled?: boolean
  onChange(value: number): void
  /** Must set the size: everything inside scales with it. */
  className?: string
  title?: string
}

const SWEEP = 270
const START = -135
// Drawn in a 66 unit box, with sizes and colours measured off the mockup. The glow and cast shadow paint outside it.
const SIZE = 66
const C = SIZE / 2
const ARC_R = 26.05
// The mockup's arc sits a touch high on the knob: further from the cap at the top than down the sides.
const ARC_Y = C - 0.4
const FILTER_AREA = { filterUnits: "userSpaceOnUse", x: -24, y: -24, width: SIZE + 48, height: SIZE + 48, colorInterpolationFilters: "sRGB" } as const
// Lit arc by distance from its tip in degrees. Orange body: distance, r, g, b, stroke width.
const BODY = [
  [0, 65, 192, 248, 4.8],
  [30, 65, 192, 248, 4.3],
  [55, 66, 189, 250, 3.8],
  [82, 67, 183, 252, 3.3],
  [102, 60, 171, 253, 3.1],
  [122, 52, 161, 243, 3],
  [150, 50, 153, 235, 3]
]
// White-hot centre: distance, r, g, b, opacity.
const HOT = [
  [0, 225, 254, 255, 1],
  [12, 170, 248, 252, 1],
  [22, 158, 247, 252, 1],
  [32, 135, 245, 251, 1],
  [42, 125, 241, 250, 0.95],
  [52, 110, 227, 250, 0.85],
  [62, 85, 210, 250, 0.45],
  [72, 72, 195, 250, 0]
]
// Light the arc throws, strongest near the tip: distance, opacity on the bezel, opacity on the cap.
const GLOW = [
  [0, 1, 0.95],
  [30, 0.9, 0.9],
  [60, 0.55, 0.7],
  [90, 0.25, 0.52],
  [150, 0.2, 0.5]
]

function toNorm(v: number, min: number, max: number, log?: boolean): number {
  if (log) return (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min))
  return (v - min) / (max - min)
}

function fromNorm(n: number, min: number, max: number, log?: boolean): number {
  const c = Math.min(1, Math.max(0, n))
  if (log) return Math.exp(Math.log(min) + c * (Math.log(max) - Math.log(min)))
  return min + c * (max - min)
}

function quantize(v: number, step: number, min: number, max: number): number {
  const q = Math.round(v / step) * step
  return Math.min(max, Math.max(min, Number(q.toFixed(6))))
}

function arcPoint(a: number): [number, number] {
  const rad = ((a - 90) * Math.PI) / 180
  return [C + ARC_R * Math.cos(rad), ARC_Y + ARC_R * Math.sin(rad)]
}

function arc(a0: number, a1: number): string {
  const [x0, y0] = arcPoint(a0)
  const [x1, y1] = arcPoint(a1)
  return `M ${x0} ${y0} A ${ARC_R} ${ARC_R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`
}

function rgb(stops: number[][], dist: number): string {
  return `rgb(${Math.round(ramp(stops, dist, 1))} ${Math.round(ramp(stops, dist, 2))} ${Math.round(ramp(stops, dist, 3))})`
}

/** The lit arc in short runs, coolest first: SVG has no conic gradient, so colour follows the tip run by run. */
function runs(tip: number, step: number): { d: string; dist: number }[] {
  const out = []
  for (let a0 = START; a0 < tip; a0 += step) {
    const a1 = Math.min(tip, a0 + step)
    // Each run reaches a little into the next, so no seams show between them.
    out.push({ d: arc(a0, Math.min(tip, a1 + 0.6)), dist: tip - (a0 + a1) / 2 })
  }
  return out
}

/** Rotary knob: drag vertically (Shift = fine), mouse wheel, double-click to reset. */
export function Knob({ value, min, max, step = 0.01, log, defaultValue, disabled, onChange, className, title }: KnobProps) {
  const drag = useRef<{ y: number; n: number } | null>(null)
  const norm = Math.min(1, Math.max(0, toNorm(Math.max(value, log ? min : -Infinity), min, max, log)))
  const angle = START + norm * SWEEP

  const commit = useCallback(
    (n: number) => onChange(quantize(fromNorm(n, min, max, log), step, min, max)),
    [onChange, min, max, log, step]
  )

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (disabled) return
    // On the root: the arc's runs come and go during the drag, and a removed element would lose the capture.
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, n: norm }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag.current) return
    const range = e.shiftKey ? 800 : 180
    commit(drag.current.n + (drag.current.y - e.clientY) / range)
  }
  const onPointerUp = (): void => {
    drag.current = null
  }
  const onWheel = (e: React.WheelEvent): void => {
    if (disabled) return
    commit(norm + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.02))
  }

  const lit = norm > 0.001
  const span = angle - START
  const [tipX, tipY] = arcPoint(angle)
  const [startX, startY] = arcPoint(START)
  const glowRuns = lit ? runs(angle, 12) : []
  const fineRuns = lit ? runs(angle, 3) : []
  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      // Dimmed, not faded: the value box runs behind the knob and mustn't show through it.
      className={cn("shrink-0 cursor-ns-resize touch-none select-none overflow-visible", disabled && "cursor-default brightness-[.55] saturate-[.35]", className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={() => defaultValue !== undefined && !disabled && onChange(defaultValue)}
      role="slider"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={title}
    >
      <title>{title}</title>
      <defs>
        <filter id="knob-shadow" {...FILTER_AREA}>
          <feGaussianBlur stdDeviation={2.9} />
        </filter>
        <filter id="knob-halo" {...FILTER_AREA}>
          <feGaussianBlur stdDeviation={2} />
        </filter>
        <filter id="knob-spill" {...FILTER_AREA}>
          <feGaussianBlur stdDeviation={4.5} />
        </filter>
        <filter id="knob-bloom" {...FILTER_AREA}>
          <feGaussianBlur stdDeviation={7} />
        </filter>
        <clipPath id="knob-cap">
          <circle cx={C} cy={C} r={23.5} />
        </clipPath>
        <radialGradient id="knob-face">
          <stop offset="0" stopColor="rgb(24 29 30)" />
          <stop offset="0.25" stopColor="rgb(23 28 28)" />
          <stop offset="0.55" stopColor="rgb(23 27 28)" />
          <stop offset="0.7" stopColor="rgb(25 29 30)" />
          <stop offset="0.85" stopColor="rgb(27 31 33)" />
          <stop offset="1" stopColor="rgb(30 34 36)" />
        </radialGradient>
        <linearGradient id="knob-rim" x1="0.8" y1="0" x2="0.4" y2="0.8">
          <stop offset="0.1" stopColor="rgb(88 104 110)" />
          <stop offset="0.3" stopColor="rgb(50 59 62)" />
          <stop offset="0.4" stopColor="rgb(39 45 46)" />
          <stop offset="0.8" stopColor="rgb(33 37 38)" />
          <stop offset="1.1" stopColor="rgb(39 47 50)" />
        </linearGradient>
        <linearGradient id="knob-ring" x1="0.8" y1="0" x2="0.4" y2="0.8">
          <stop offset="0.12" stopColor="rgb(50 64 70)" />
          <stop offset="0.23" stopColor="rgb(35 45 48)" />
          <stop offset="0.33" stopColor="rgb(25 31 32)" />
          <stop offset="0.4" stopColor="rgb(19 23 24)" />
          <stop offset="0.7" stopColor="rgb(8 10 10)" />
          <stop offset="1" stopColor="rgb(8 10 12)" />
        </linearGradient>
        <linearGradient id="knob-reflection" x1="0" y1="1" x2="0" y2="0.8">
          <stop offset="0" stopColor="rgb(180 238 255)" stopOpacity={0.09} />
          <stop offset="1" stopColor="rgb(180 238 255)" stopOpacity={0} />
        </linearGradient>
        <linearGradient id="knob-trail" gradientUnits="userSpaceOnUse" x1={C} y1={C - 13} x2={C} y2={C - 4}>
          <stop offset="0" stopColor="rgb(115 211 255)" stopOpacity={0.28} />
          <stop offset="1" stopColor="rgb(115 211 255)" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Cast shadow, dark bezel, grip ring with two staggered rows of knurling. */}
      <circle cx={C} cy={C + 7} r={31} opacity={0.95} filter="url(#knob-shadow)" />
      <circle cx={C} cy={C} r={33.1} fill="rgb(4 6 6)" />
      <circle cx={C} cy={C} r={26.8} fill="none" stroke="url(#knob-ring)" strokeWidth={5.6} />
      <circle cx={C} cy={C} r={25.2} fill="none" stroke="url(#knob-reflection)" strokeWidth={2.6} />
      <g fill="none" stroke="#000" strokeOpacity={0.45} strokeWidth={1.6}>
        <circle cx={C} cy={C} r={25.4} pathLength={90} strokeDasharray="0.5 0.5" />
        <circle cx={C} cy={C} r={27.9} pathLength={90} strokeDasharray="0.5 0.5" strokeDashoffset={0.5} />
      </g>

      {/* The arc's light on the bezel and the panel: the cap stands in its way. */}
      {lit && (
        <g filter="url(#knob-bloom)" fill="none" stroke="rgb(16 144 255)" strokeWidth={8}>
          {glowRuns.map((r, i) => (
            <path key={i} d={r.d} strokeOpacity={ramp(GLOW, r.dist, 1)} />
          ))}
          <circle cx={tipX} cy={tipY} r={5} fill="rgb(16 144 255)" stroke="none" />
        </g>
      )}

      {/* Cap and its rim. */}
      <circle cx={C} cy={C} r={22.6} fill="url(#knob-face)" stroke="url(#knob-rim)" strokeWidth={1.7} />

      {/* Lit arc: a little light over the cap, a tight halo, the orange body, then its white-hot centre near the tip. */}
      {lit && (
        <>
          <g clipPath="url(#knob-cap)">
            <g filter="url(#knob-spill)" fill="none" stroke="rgb(30 154 255)" strokeWidth={5}>
              {glowRuns.map((r, i) => (
                <path key={i} d={r.d} strokeOpacity={ramp(GLOW, r.dist, 2)} />
              ))}
            </g>
          </g>
          <g filter="url(#knob-halo)" fill="none" stroke="rgb(25 144 255)" strokeOpacity={0.85} strokeWidth={4}>
            {glowRuns.map((r, i) => (
              <path key={i} d={r.d} />
            ))}
          </g>
          <circle cx={startX} cy={startY} r={ramp(BODY, span, 4) / 2} fill={rgb(BODY, span)} />
          <g fill="none">
            {fineRuns.map((r, i) => (
              <path key={i} d={r.d} stroke={rgb(BODY, r.dist)} strokeWidth={ramp(BODY, r.dist, 4)} />
            ))}
          </g>
          <circle cx={tipX} cy={tipY} r={ramp(BODY, 0, 4) / 2} fill={rgb(BODY, 0)} />
          <g fill="none">
            {fineRuns.map((r, i) => (
              <path key={i} d={r.d} stroke={rgb(HOT, r.dist)} strokeOpacity={ramp(HOT, r.dist, 4)} strokeWidth={2.1} />
            ))}
          </g>
          <circle cx={tipX} cy={tipY} r={1.05} fill={rgb(HOT, 0)} />
        </>
      )}

      {/* Pointer, with its glow and a faint trail towards the centre. */}
      <g transform={`rotate(${angle} ${C} ${C})`} strokeLinecap="round">
        <line x1={C} y1={C - 4} x2={C} y2={C - 13} stroke="url(#knob-trail)" strokeWidth={3.5} filter="url(#knob-halo)" />
        <line x1={C} y1={C - 14.4} x2={C} y2={C - 19.9} stroke="rgb(40 169 255)" strokeOpacity={0.6} strokeWidth={3.4} filter="url(#knob-halo)" />
        <line x1={C} y1={C - 14.4} x2={C} y2={C - 19.9} stroke="rgb(148 223 238)" strokeWidth={2.3} />
      </g>
    </svg>
  )
}
