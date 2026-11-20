// Render an art page's #art element to PNG. Usage: node render.mjs <page.html?query> <out.png> [dpr]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [pageArg, out, dpr = '2'] = process.argv.slice(2);
const [file, query = ''] = pageArg.split('?');
const url = pathToFileURL(path.resolve(import.meta.dirname, file)).href + (query ? '?' + query : '');
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), headless: true, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1800, height: 1400 }, deviceScaleFactor: Number(dpr) });
page.on('pageerror', e => console.error('pageerror', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('console', m.text()); });
await page.goto(url, { waitUntil: 'load' });
await page.evaluate(async () => { await document.fonts.ready; if (window.MathJax?.startup) await window.MathJax.startup.promise; });
if (process.env.BG) await page.evaluate(bg => { document.querySelector('#art').style.background = bg; }, process.env.BG);
await page.waitForTimeout(300);
await page.locator('#art').screenshot({ path: path.resolve(out), omitBackground: true });
console.log('wrote', out);
await browser.close();
