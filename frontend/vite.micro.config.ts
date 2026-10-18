// The MCP micro UI (ui://yue2/song.html): one self-contained HTML file, since MCP Apps hosts render
// it in a sandboxed iframe that cannot load anything from this server.
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  publicDir: false,
  build: {
    outDir: 'dist-micro',
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(import.meta.dirname, 'micro.html') },
  },
})
