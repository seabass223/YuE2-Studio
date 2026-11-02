// Waveforms are decoded in the browser, since tracks carry no peak data. The rate is low because the audio
// is only drawn: a 6:00 song stays around 40 MB in memory.
const DECODE_RATE = 12000
const PEAK_COUNT = 240
const PEAKS_KEY = "yue2-peaks:"

export async function decodeChannels(url: string, signal?: AbortSignal): Promise<Float32Array[]> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(res.statusText)
  const audio = await new OfflineAudioContext(2, 1, DECODE_RATE).decodeAudioData(await res.arrayBuffer())
  const channels = [audio.getChannelData(0)]
  if (audio.numberOfChannels > 1) channels.push(audio.getChannelData(1))
  return channels
}

function peaksOf(channels: Float32Array[]): number[] {
  const len = channels[0].length
  return Array.from({ length: PEAK_COUNT }, (_, i) => {
    let peak = 0
    const end = Math.floor(((i + 1) * len) / PEAK_COUNT)
    for (let s = Math.floor((i * len) / PEAK_COUNT); s < end; s++) {
      for (const channel of channels) peak = Math.max(peak, Math.abs(channel[s]))
    }
    return Math.round(peak * 100) / 100
  })
}

const pending = new Map<string, Promise<number[]>>()
let queue: Promise<unknown> = Promise.resolve()

/** A track's peak envelope for the song cards, kept in localStorage. Decodes one track at a time. */
export function trackPeaks(id: string, url: string): Promise<number[]> {
  const known = pending.get(id)
  if (known) return known
  const saved = localStorage.getItem(PEAKS_KEY + id)
  if (saved) return Promise.resolve(JSON.parse(saved))
  const job = queue.then(async () => {
    const peaks = peaksOf(await decodeChannels(url))
    try {
      localStorage.setItem(PEAKS_KEY + id, JSON.stringify(peaks))
    } catch {
      /* storage full: it decodes again next session */
    }
    return peaks
  })
  queue = job.catch(() => {})
  pending.set(id, job)
  return job
}
