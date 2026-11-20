# Install Anki Bridge

Anki Bridge 0.8.1 is a personal-use candidate, not a public release. Use the `anki-bridge-v0.8.1.zip` install archive, not GitHub's automatically generated source zip. If you don't have the install archive, you can build it using the steps below. The archive contains built plugin code. You don't need Node.js or npm to install it.

## Requirements

- LearnHarness 0.6.1 with community plugin support. The manifest permits newer versions, but that isn't a compatibility guarantee.
- For direct sends and review checks, use Anki Desktop with [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect) running locally. Earlier scratch tests used Anki 26.08.1 with AnkiConnect 26.10.11.0 and 26.11.15.0. These builds require Anki 26.08 or later. The bridge refuses builds without `getActiveProfile`, which it uses to check the destination before writing. Package export doesn't require AnkiConnect.
- A configured LearnHarness model if you want to generate cards. Estimating is free of model calls. Confirming generation uses your selected provider's quota.

LearnHarness community plugins run local code with your app's permissions. Only install a build you trust.

## First install

1. In LearnHarness, open **Settings → Community plugins** and select and copy the plugins directory path. Paste it into Explorer's address bar or Finder's **Go to Folder**. Quit LearnHarness completely. On Mac, use **Quit** or ⌘Q; closing its window is not enough.
2. If the plugins directory already contains `anki-bridge`, stop and follow the upgrade steps instead. Otherwise, extract the zip outside the plugins directory. Windows **Extract All** may create a version-named outer folder: open it and move the inner `anki-bridge` folder into the plugins directory.
3. Check that the manifest is directly at `<plugins directory>/anki-bridge/dist/manifest.json`, not `<plugins directory>/anki-bridge-v0.8.1/anki-bridge/dist/manifest.json`. Renaming the outer folder does not remove the extra level.
4. Restart LearnHarness. Anki Bridge should appear in **Community plugins** and starts disabled. Enable it there, then open Anki Bridge from the sidebar. LearnHarness's built-in Flashcards plugin is independent and can stay enabled.

## Upgrade without losing data

1. Wait for any generation or Anki send to finish. Quit LearnHarness completely. Back up `anki-bridge/data/` privately, if present. It holds plugin settings and records, including drafts, flags, delivery history and any saved AnkiConnect key.
2. Extract the new zip separately. Move the old `anki-bridge/dist/` to a backup location outside the plugins directory, then put the extracted `dist/` in its place. **Replace only `dist/`.** Do not replace the `anki-bridge` folder, merge the two code folders or move `data/` into `dist/`.
3. Restart LearnHarness. Check the version in Community plugins and open the sidebar view. Confirm existing drafts and settings are still there. Enable the plugin if it was disabled before the upgrade.

If there is no `dist/` or you find `dist/data/`, stop before moving anything.

Version 0.8.1 upgrades state to schema 7 so it can record an existing Anki note without claiming to know its deck. It saves the original `state.json` in `data/state.v6.bak` when upgrading from 0.8.0, or `data/state.v5.bak` when upgrading directly from 0.7.2. If a backup of the same name already exists with different contents, the upgrade stops without changing either file. Move that backup to a private location before trying again.

When upgrading from 0.7.2, your drafts, flags, delivery records, card limit and model override carry over. Apply and Contrast move to Settings. Existing Compose cards stay readable, but Write no longer generates them.

### Roll back to 0.8.0 or 0.7.2

1. Quit LearnHarness completely and save a private copy of your current `anki-bridge/data/` before restoring anything.
2. Restore the old `dist/` and the `data/` backup taken before upgrading from that version. If you don't have the full backup, copy the matching migration backup over `data/state.json`: `state.v6.bak` for 0.8.0 or `state.v5.bak` for 0.7.2. A direct upgrade from 0.7.2 does not create a schema 6 backup. If there is no matching backup, keep your state intact and use a compatible build; do not edit the schema number.
3. Restart LearnHarness and check the restored version and data before resuming work. Replacing `dist/` alone won't work: neither old version can read schema 7. Rolling back restores older drafts, settings and delivery history. It does not undo sends to Anki.

## Connect and send a card

1. Install [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect) in Anki Desktop via **Tools → Add-ons → Get Add-ons**, using code `2055492159`. Restart Anki and open the intended profile. For a trial, use a throwaway profile and an isolated AnkiConnect endpoint. If switching from your normal profile, wait for any sends to finish first.
2. In the Anki Bridge settings, save the actual AnkiConnect address and optional API key. The default is `http://127.0.0.1:8765`, but your AnkiConnect may use another port. Use loopback and a trusted local service. The key is stored in plain text in `anki-bridge/data/`. Never share that directory. A blank key input keeps the saved key only while the URL stays the same. Saving a different URL clears it, so enter the key again if the new endpoint needs one. Remove saved key removes it.
3. Test the connection, then choose Use the open profile. Pairing is specific to the URL and profile, not the deck. Do not switch profiles during a send. AnkiConnect cannot make a profile check and a write atomic.
4. Choose ideas from a session or the whole graph, or use **Flag for Anki** in a teaching session and then **Make cards**. A flag covers all ideas LearnHarness extracts from the latest teaching reply, not a single sentence. Leave the model picker blank to use the cheap model or pick one, then press Write cards, check the estimate and press Start writing only if you want it to generate. Review and approve the cards you want, then pick a deck, check the tags and send. The bridge doesn't update or delete existing Anki notes or change their scheduling.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Plugin doesn't show up, or shows `Task recovery failed: Invalid plugin id` or `Missing plugin build` | Check the folder layout above. Quit LearnHarness, move any version-named outer folder outside the plugins directory, preserve any existing `anki-bridge/data/`, and install the inner folder at the correct path. Restart the app and check Community plugins. Do not delete task records or plugin data to fix the folder name. |
| Connection fails or the profile is wrong | Check that Anki Desktop and AnkiConnect are running on the configured port, check the key, then test again. Pair only when the reported profile is the one you intend. The bridge blocks sending and reconciliation on a mismatch. |
| A reply is still waiting for extraction | Wait for LearnHarness to finish extraction, then use Refresh. Some replies produce no new ideas. |
| Generation or sending was interrupted | Reopen the page; finished batches are applied and Retry the rest estimates the remaining ideas. If a send's result is uncertain, reconnect to the same paired destination and use Check unconfirmed sends in the More menu rather than resending it. |
| A card looks wrong | Review it before approval. The preview supports maths and fenced code, but not images or Mermaid. The full card-quality benchmark is still open. |

## Build the zip from source

On a development machine with Node.js 23.6 or later, npm and the `zip` command:

```sh
npm ci
npm run package:plugin
```

This rebuilds `dist/` and writes `anki-bridge-v0.8.1.zip` at the repo root. The archive contains only the manifest, bundled code, stylesheet and license notices. It excludes plugin data, credentials, bench results and agent files.
