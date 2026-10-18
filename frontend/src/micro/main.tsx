import { createRoot } from "react-dom/client"

import "../index.css"
import { MicroApp } from "./micro-app"

// No StrictMode: its double-mounted effects would open two host connections from one iframe.
createRoot(document.getElementById("root")!).render(<MicroApp />)
