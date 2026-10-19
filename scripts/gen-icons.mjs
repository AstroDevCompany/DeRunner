// Renders branding SVGs to PNGs. Run via `pnpm icons` (then `tauri icon`).
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const render = (svgPath, size) =>
  new Resvg(readFileSync(svgPath), { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' })
    .render()
    .asPng()

mkdirSync('branding', { recursive: true })
mkdirSync('src-tauri/icons', { recursive: true })
writeFileSync('branding/app-icon.png', render('branding/app-icon.svg', 1024))
// App icon = letters on a dark plate. Tray: macOS template (black + alpha) at 44px (22pt @2x); the bare
// coloured monogram for Windows/Linux.
writeFileSync('src-tauri/icons/tray-template.png', render('branding/tray.svg', 44))
writeFileSync('src-tauri/icons/tray-color.png', render('branding/logo.svg', 64))
console.log('icons rendered')
