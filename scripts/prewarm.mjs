#!/usr/bin/env node
/* global window */
/**
 * Pre-warms the showroom's frame store: opens the deployed app in Chrome with `?prewarm=…`,
 * which steps through the popular designs (src/render/prewarm.ts) and renders every angle's
 * still on the cloud GPUs, and waits until it reports finished.
 *
 *   npm run prewarm -- https://<your-deploy>.vercel.app              # everything, one page
 *   npm run prewarm -- https://<your-deploy>.vercel.app --pages 3    # three pages, one GPU each
 *   npm run prewarm -- https://<your-deploy>.vercel.app --range 0-40
 *
 * Needs Playwright with Chrome (`npx playwright install chrome`), a build with
 * VITE_CLOUD_RENDER_URL set, and a Modal deploy with FURY_MAX_SESSIONS at least `--pages`. Runs
 * headed: WebGPU and the exposure meter need a real GPU-backed browser. Expect roughly 10 s of GPU
 * time per design (8 previews, 8 finals); 840 designs is about 2.5 hours per page, so three pages
 * finish overnight. The cost cap is the Modal workspace spending limit.
 */

import { chromium } from 'playwright'

const args = process.argv.slice(2)
const url = args.find((a) => !a.startsWith('--'))
if (!url) {
  console.error('usage: prewarm.mjs <app url> [--pages N] [--range from-to]')
  process.exit(2)
}
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const pages = Number(option('pages', '1'))
const range = option('range', null)

const browser = await chromium.launch({ channel: 'chrome', headless: false })

/** Reads the design count from one page, so the work can be split evenly. */
async function total() {
  const page = await browser.newPage()
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}prewarm=0-0&traceStats=1`)
  await page.waitForFunction(() => window.__furyPrewarm !== undefined, null, { timeout: 60_000 })
  const n = await page.evaluate(() => window.__furyPrewarm.total)
  await page.close()
  return n
}

const designs = await total()
const slices = range
  ? [range]
  : Array.from({ length: pages }, (_, i) => {
      const from = Math.floor((designs * i) / pages)
      const to = Math.floor((designs * (i + 1)) / pages)
      return `${from}-${to}`
    })
console.log(`${designs} designs in ${slices.length} page(s): ${slices.join(', ')}`)

await Promise.all(
  slices.map(async (slice, i) => {
    const page = await browser.newPage()
    page.on('console', (message) => {
      const text = message.text()
      if (text.startsWith('[prewarm]') || text.startsWith('[showroom]'))
        console.log(`[page ${i + 1}] ${text}`)
    })
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}prewarm=${slice}&traceStats=1`)
    await page.waitForFunction(() => window.__furyPrewarm?.finished === true, null, {
      timeout: 0,
      polling: 2000,
    })
    const result = await page.evaluate(() => window.__furyPrewarm)
    console.log(`[page ${i + 1}] done: ${result.done} designs, ${result.timedOut.length} timed out`)
    if (result.timedOut.length)
      console.log(`[page ${i + 1}] timed out: ${result.timedOut.join('; ')}`)
    await page.close()
  }),
)
await browser.close()
