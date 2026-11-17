# Third-party notices

## LearnHarness

Source: https://github.com/amosblomqvist/learnharness, v0.6.1, AGPL-3.0. Copyright belongs to the LearnHarness contributors.

`scripts/install-plugin-local.mjs` is copied unchanged from LearnHarness's official `scripts/install-plugin-local.mjs` helper. The portable generated type-only declarations and their package metadata under `sdk/` are copied from the authoring bundle shipped with LearnHarness 0.6.1. `sdk/bundle.json` records the producing app, API and SDK versions. These files are used for authoring and are not bundled as runtime code. The AGPL license text is in `LICENSE`.

## Twig and core Flashcards

The existing card writer bench adapts card-kind and prompt rules from [Twig](https://github.com/amoghu1s1/twig), by its contributors, and LearnHarness core Flashcards, by the LearnHarness contributors. Both are AGPL-3.0. The 0.2.0 frontend does not run that writer or generate cards.

## Development dependencies

esbuild and happy-dom are MIT-licensed development tools. They are not runtime imports in the distributed plugin. Their dependency licenses remain in the npm-installed packages. Any license notices for runtime code bundled by esbuild are retained in the generated bundles.
