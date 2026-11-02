// Renders assets/icon.svg into the favicon set (frontend/public) and the Windows app icon (assets/app.ico).
// npm run icons
import { copyFile, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pngToIco from "png-to-ico"
import sharp from "sharp"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const svg = await readFile(path.join(root, "assets", "icon.svg"))
const publicDir = path.join(root, "frontend", "public")

const png = (size) => sharp(svg, { density: Math.ceil((72 * size) / 64) * 2 }).resize(size, size).png().toBuffer()

await copyFile(path.join(root, "assets", "icon.svg"), path.join(publicDir, "favicon.svg"))
for (const [name, size] of [["favicon-32.png", 32], ["icon-192.png", 192], ["icon-512.png", 512]]) {
  await writeFile(path.join(publicDir, name), await png(size))
}
await writeFile(path.join(root, "assets", "icon-256.png"), await png(256))

const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
await writeFile(path.join(root, "assets", "app.ico"), await pngToIco(await Promise.all(icoSizes.map(png))))

await writeFile(
  path.join(publicDir, "manifest.webmanifest"),
  JSON.stringify(
    {
      name: "YuE2 Studio",
      short_name: "YuE2",
      start_url: "/",
      display: "standalone",
      background_color: "#15191a",
      theme_color: "#15191a",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    },
    null,
    2,
  ),
)
console.log("Icons written")
