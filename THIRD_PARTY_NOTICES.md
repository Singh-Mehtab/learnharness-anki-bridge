# Third-party notices

## LearnHarness

Source: https://github.com/amosblomqvist/learnharness, v0.6.1, AGPL-3.0. Copyright belongs to the LearnHarness contributors.

`scripts/install-plugin-local.mjs` is copied unchanged from LearnHarness's official `scripts/install-plugin-local.mjs` helper. The portable generated type-only declarations and their package metadata under `sdk/` are copied from the authoring bundle shipped with LearnHarness 0.6.1. `sdk/bundle.json` records the producing app, API and SDK versions. These files are used for authoring and are not bundled as runtime code. The AGPL license text is in `LICENSE`.

## Twig and core Flashcards

The card writer and its benchmark adapt card-kind and prompt rules from [Twig](https://github.com/amoghu1s1/twig), by its contributors, and LearnHarness core Flashcards, by the LearnHarness contributors. Both are AGPL-3.0.

## genanki

Source: https://github.com/kerrickstaley/genanki, MIT. `src/anki/apkg.ts` follows genanki's `.apkg` layout: the schema 11 table definitions, the collection configuration, and the deck, deck options and note type defaults. No genanki code is bundled; the TypeScript is a new implementation.

```text
The MIT License

Copyright (c) 2017 Kerrick Staley.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Development dependencies

esbuild and happy-dom are MIT-licensed development tools. They are not runtime imports in the distributed plugin. Their dependency licenses remain in the npm-installed packages. Any license notices for runtime code bundled by esbuild are retained in the generated bundles.
