import { useEffect, useState } from "react"

import type { Snapshot } from "@/lib/api"

/** Live backend state over a WebSocket. The open socket also keeps the backend alive. */
export function useBackend() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let socket: WebSocket | null = null
    let retry: number | undefined
    let disposed = false

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws"
      socket = new WebSocket(`${scheme}://${location.host}/api/ws`)
      socket.onopen = () => setConnected(true)
      socket.onmessage = (event) => setSnapshot(JSON.parse(event.data))
      socket.onclose = () => {
        setConnected(false)
        if (!disposed) retry = window.setTimeout(connect, 2000)
      }
    }
    connect()
    return () => {
      disposed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [])

  return { snapshot, connected }
}
