import { useEffect, useRef, useState } from "react"
import { Knob } from "@/components/knob"
import { cn } from "@/lib/utils"

/** A select or other control sitting in a row of knobs: label beside it, or above it when the panel is tight. */
export const FIELD = "flex min-w-0 items-center gap-3 param-tight:flex-col param-tight:items-stretch param-tight:gap-0.5"
export const FIELD_TRIGGER = "h-10 w-full bg-panel param-tight:data-[size=default]:h-[30px]"

interface ParamKnobProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  log?: boolean
  defaultValue?: number
  unit?: string
  decimals?: number
  disabled?: boolean
  hint?: string
  onChange(value: number): void
  /** Optional element shown inside the value box (e.g. the seed dice). */
  adornment?: React.ReactNode
  display?: string
  className?: string
}

/** Label + knob + editable value box, as in the mockup's parameter row. */
export function ParamKnob({
  label, value, min, max, step = 0.1, log, defaultValue, unit, decimals = 1, disabled, hint, onChange, adornment, display, className
}: ParamKnobProps) {
  const [text, setText] = useState("")
  const [editing, setEditing] = useState(false)
  const focused = useRef("")
  useEffect(() => {
    if (!editing) setText(display ?? value.toFixed(decimals))
  }, [value, decimals, editing, display])

  const commit = (): void => {
    setEditing(false)
    // Just clicking in and out changes nothing: "Random" and "Auto" have no number to commit.
    if (text === focused.current) return
    const n = Number.parseFloat(text)
    if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)))
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-2.5 param-tight:grid param-tight:grid-cols-[auto_minmax(0,1fr)] param-tight:gap-y-0.5", className)} title={hint}>
      <span className="label-caps shrink-0 leading-tight param-tight:col-start-2 param-tight:row-start-1">{label}</span>
      <Knob
        className="relative z-10 -my-1.5 size-[66px] param-tight:col-start-1 param-tight:row-span-2 param-tight:row-start-1 param-tight:my-0 param-tight:size-[46px]"
        value={value}
        min={min}
        max={max}
        step={step}
        log={log}
        defaultValue={defaultValue}
        disabled={disabled}
        onChange={onChange}
        title={label}
      />
      <div className={cn("panel-inset -ml-5 flex h-[46px] min-w-[90px] flex-1 items-center gap-1 pl-7 pr-2.5 param-tight:col-start-2 param-tight:row-start-2 param-tight:ml-0 param-tight:h-[30px] param-tight:min-w-[70px] param-tight:pl-2.5", disabled && "opacity-50")}>
        <input
          className="w-full min-w-0 bg-transparent text-center text-[15px] font-medium tabular-nums text-foreground outline-none"
          value={text}
          disabled={disabled}
          onFocus={(e) => {
            setEditing(true)
            // "Random" and "Auto" stay as they are until typed over: there's no number behind them yet.
            focused.current = display && Number.isNaN(Number.parseFloat(display)) ? display : value.toFixed(decimals)
            setText(focused.current)
            e.target.select()
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur()
            if (e.key === "Escape") {
              setEditing(false)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
        {adornment}
      </div>
    </div>
  )
}
