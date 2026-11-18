# Install Anki Bridge

Anki Bridge 0.6.1 is a personal-use candidate, not a public release. You need the `anki-bridge-v0.6.1.zip` install archive, not GitHub's automatically generated source zip. The archive contains built plugin code. You don't need Node.js or npm to install it.

## Requirements

- LearnHarness 0.6.1 with community plugin support. The manifest permits newer versions, but that isn't a compatibility guarantee.
- Anki Desktop with [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect) running locally. Earlier scratch tests used Anki 26.08.1 with AnkiConnect 26.10.11.0 and 26.11.15.0. These builds require Anki 26.08 or later. The bridge refuses builds without `getActiveProfile`, which it uses to check the destination before writing.
- A configured LearnHarness model if you want to generate cards. Estimating is free of model calls. Confirming generation uses your selected provider's quota.

LearnHarness community plugins run local code with your app's permissions. Only install a build you trust.

## First install

1. In LearnHarness, open **Settings → Community plugins** and copy the plugins directory path. Quit LearnHarness completely.
2. Extract the zip in a temporary folder. Move the extracted `anki-bridge` folder into the plugins directory. If `anki-bridge` already exists there, follow the upgrade steps instead. Check that the manifest is directly at `<plugins directory>/anki-bridge/dist/manifest.json`.
3. Restart LearnHarness. Anki Bridge should appear in **Community plugins** and starts disabled. Enable it there, then open Anki Bridge from the sidebar. LearnHarness's built-in Flashcards plugin is independent and can stay enabled.

## Upgrade without losing data

1. Wait for any generation or Anki send to finish. Quit LearnHarness completely. Back up `anki-bridge/data/` privately, if present. It holds plugin settings and records, including drafts, flags, delivery history and any saved AnkiConnect key.
2. Extract the new zip separately. Move the old `anki-bridge/dist/` to a backup location outside the plugins directory, then put the extracted `dist/` in its place. **Replace only `dist/`.** Do not replace the `anki-bridge` folder, merge the two code folders or move `data/` into `dist/`.
3. Restart LearnHarness. Check the version in Community plugins and open the sidebar view. Confirm existing drafts and settings are still there. Enable the plugin if it was disabled before the upgrade.

If there is no `dist/` or you find `dist/data/`, stop before moving anything.

To roll back to 0.6.0 or 0.5.0, quit LearnHarness and put back only the old `dist/`. Keep the current `data/`. These versions use the same state format. Use the pre-upgrade data backup only if the current data is missing or damaged. If possible, keep a private copy of the current data first. Restoring the backup loses any newer drafts, settings and delivery records. It does not undo cards already sent to Anki.

## Connect and send a card

1. Open Anki Desktop in the intended profile. For a trial, use a throwaway profile and an isolated AnkiConnect endpoint. If switching from your normal profile, wait for any sends to finish first.
2. In Anki Bridge, save the actual AnkiConnect URL and optional API key. The default is `http://127.0.0.1:8765`, but your AnkiConnect may use another port. Use loopback and a trusted local service. The key is stored in plain text in `anki-bridge/data/`. Never share that directory. A blank key input keeps the saved key only while the URL stays the same. Saving a different URL clears it, so enter the key again if the new endpoint needs one. The clear checkbox removes it.
3. Test the connection and pair the reported profile. Pairing is specific to the URL and profile, not the deck. Do not switch profiles during a send. AnkiConnect cannot make a profile check and a write atomic.
4. Select graph ideas, or use **Flag for Anki** in a teaching session and then **Make cards**. A flag covers all ideas LearnHarness extracts from the latest teaching reply, not a single sentence. Select a model, check the estimate and confirm only if you want it to generate. Review and approve the cards you want, then pick a deck and send. The bridge doesn't update or delete existing Anki notes or change their scheduling.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Plugin doesn't show up | Confirm there is only one `anki-bridge` folder level above `dist/`, that `manifest.json` is inside `dist/`, and that you're on LearnHarness 0.6.1 or later. Restart the app and check Community plugins. |
| Connection fails or the profile is wrong | Check that Anki Desktop and AnkiConnect are running on the configured port, check the key, then test again. Pair only when the reported profile is the one you intend. The bridge blocks sending and reconciliation on a mismatch. |
| A reply is still waiting for extraction | Wait for LearnHarness to finish extraction, then use Refresh. Some replies produce no new ideas. |
| Generation or sending was interrupted | Use Refresh generation to recover completed work or estimate a retry. If a send's result is uncertain, reconnect to the same paired destination and use reconciliation rather than manually resending it. |
| A card looks wrong | Review it before approval. The preview supports maths and fenced code, but not images or Mermaid. The full card-quality benchmark is still open. |

## Build the zip from source

On a development machine with Node.js 23.6 or later, npm and the `zip` command:

```sh
npm ci
npm run package:plugin
```

This rebuilds `dist/` and writes `anki-bridge-v0.6.1.zip` at the repo root. The archive contains only the manifest, bundled code, stylesheet and license notices. It excludes plugin data, credentials, bench results and agent files.
