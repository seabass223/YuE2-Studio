import { defineConfig } from 'vite'

// MCP_SERVER: the server's Streamable HTTP origin. /mcp is proxied so the page stays same-origin.
const target = process.env.MCP_SERVER ?? 'http://127.0.0.1:7862'

export default defineConfig({
  server: {
    port: 5180,
    proxy: { '/mcp': { target, changeOrigin: true } },
  },
})
