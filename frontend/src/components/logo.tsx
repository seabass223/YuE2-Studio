/** Waveform glyph + "YUE2 STUDIO" wordmark, as in StableSFX Studio. */
export function LogoMark({ className = "size-10" }: { className?: string }) {
  const bars = [4, 9, 15, 24, 34, 22, 12, 28, 38, 26, 14, 20, 10, 5]
  return (
    <svg viewBox="0 0 64 48" className={className} aria-hidden>
      <defs>
        <linearGradient id="logo-g" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#66e8ff" />
          <stop offset="1" stopColor="#1a9de2" />
        </linearGradient>
        <filter id="logo-glow">
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
      </defs>
      <g filter="url(#logo-glow)" opacity="0.7">
        {bars.map((h, i) => (
          <rect key={i} x={3 + i * 4.2} y={24 - h / 2} width={2.2} height={h} rx={1.1} fill="#1fccff" />
        ))}
      </g>
      {bars.map((h, i) => (
        <rect key={i} x={3 + i * 4.2} y={24 - h / 2} width={2.2} height={h} rx={1.1} fill="url(#logo-g)" />
      ))}
    </svg>
  )
}

/** The mockup's four-point star with two small companions. */
export function SparkIcon({ className }: { className?: string }) {
  const star = (cx: number, cy: number, r: number): string => {
    const k = r * 0.14
    return `M${cx} ${cy - r}Q${cx + k} ${cy - k} ${cx + r} ${cy}Q${cx + k} ${cy + k} ${cx} ${cy + r}Q${cx - k} ${cy + k} ${cx - r} ${cy}Q${cx - k} ${cy - k} ${cx} ${cy - r}Z`
  }
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d={star(9.5, 12, 9.5)} />
      <path d={star(19.5, 6, 3)} />
      <path d={star(19.5, 18, 3)} />
    </svg>
  )
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-3">
      <LogoMark className="h-11 w-14" />
      <div className="leading-none">
        <div className="wordmark whitespace-nowrap text-[20px]">
          <span className="text-[#d4e8ef]">YUE2</span> <span className="glow-text text-primary">STUDIO</span>
        </div>
        <div className="mt-1.5 whitespace-nowrap text-[10.5px] tracking-[0.2em] text-muted-foreground">Powered by YuE2</div>
      </div>
    </div>
  )
}
