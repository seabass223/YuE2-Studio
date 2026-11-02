import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@fontsource-variable/inter"
import "@fontsource-variable/jetbrains-mono"
import "@fontsource/michroma"
import "./index.css"
import App from "./App.tsx"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={400}>
      <App />
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  </StrictMode>,
)
