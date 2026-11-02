import { cn } from "@/lib/utils"

// [seconds between labels, ticks per label]: the first that leaves at most MAX_LABEL_GAPS gaps is used.
const STEPS: [number, number][] = [
  [0.05, 5],
  [0.1, 4],
  [0.25, 5],
  [0.5, 5],
  [1, 4],
  [2, 4],
  [5, 5],
  [10, 5],
  [20, 4],
  [30, 3],
  [60, 4],
  [120, 4],
  [300, 5],
  [600, 5],
  [1800, 6]
]
const MAX_LABEL_GAPS = 8

function tickLabel(t: number): string {
  if (t < 60) return `${Number(t.toFixed(2))}s`
  const s = Math.round(t % 60)
  return `${Math.floor(t / 60)}:${s < 10 ? "0" : ""}${s}`
}

/** Goes inside the wave view: its ticks straddle the top edge, with the labels above them. */
export function TimeRuler({ duration }: { duration: number }) {
  if (duration <= 0) return null
  const [major, perMajor] = STEPS.find(([gap]) => duration / gap <= MAX_LABEL_GAPS) ?? STEPS[STEPS.length - 1]
  const count = Math.floor((duration / major) * perMajor + 1e-6)
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-0">
      {Array.from({ length: count + 1 }, (_, i) => {
        const t = (i * major) / perMajor
        const frac = t / duration
        const left = `${frac * 100}%`
        if (i % perMajor) return <div key={i} className="absolute top-[-3px] h-[9px] w-px bg-[linear-gradient(#23282c_3px,#1a1f22_3px)]" style={{ left }} />
        return (
          <div key={i}>
            <div className="absolute top-[-8px] h-3.5 w-px bg-[linear-gradient(#434f56_8px,#272f33_8px)]" style={{ left }} />
            {/* The first and last labels stay inside the view. */}
            <span
              className={cn("absolute bottom-[12px] whitespace-nowrap text-[13px] leading-none text-[#afd9e7]", i > 0 && (frac > 0.97 ? "-translate-x-full" : "-translate-x-1/2"))}
              style={{ left }}
            >
              {tickLabel(t)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
