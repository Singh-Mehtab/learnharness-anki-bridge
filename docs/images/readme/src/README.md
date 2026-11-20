# README image sources

The README's diagrams and screenshot frames are HTML pages rendered to PNG at 2x with Chromium.

| Page | Output |
| --- | --- |
| `banner.html` | `banner-dark.png`, `banner-light.png` (`?theme=light`) |
| `workflow.html` | `how-it-works-dark.png`, `how-it-works-light.png` |
| `card-types.html` | `card-types-dark.png`, `card-types-light.png` |
| `frame.html` | Window frames around screenshots: `hero.png`, `choose-ideas.png`, `flag.png`, `write.png`, `edit.png`, `code.png`, `sent.png`, `settings.png` |

## Fonts

The pages use the typefaces of the LearnHarness interface. Copy them into a `fonts/` folder here, which Git ignores:

- `fonts/cmunbx.ttf`: CMU Serif Bold Extended, from `public/fonts/` in the LearnHarness app or source tree.
- `fonts/jbmono-latin.woff2`: JetBrains Mono, Latin subset.
- `fonts/sourcesans-latin.woff2`: Source Sans 3, Latin subset.
- `fonts/tex-svg.js`: MathJax 3, from `node_modules/mathjax/es5/tex-svg.js`.

All three typefaces are under the SIL Open Font License.

## Render

Install `playwright-core` somewhere, then:

```sh
PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs CHROME="/path/to/chrome" \
  node render.mjs "workflow.html?theme=light" ../how-it-works-light.png
```

`frame.html` takes query parameters: `src` (screenshot path), `crop=x,y,w,h` in CSS pixels of a 1440 by 900 viewport, `chrome=0` to drop the title bar, `pad=top,right,bottom,left`, and `over`, `ocrop` and `opos=x,y` to float a cropped dialog over the frame.

## Screenshots

Take screenshots at 2x device scale from a scratch LearnHarness 0.6.1 server with scratch `LH_DATA_DIR` and `LH_AUTH_FILE`, synthetic sessions and a fake AnkiConnect. Never use real graph data or a real Anki profile. The current set uses invented sessions on heat engines, enzyme kinetics and sorting.
