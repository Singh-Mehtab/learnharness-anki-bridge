# Anki Bridge

Unofficial, one-way AnkiConnect plugin for LearnHarness 0.6.1, plugin API v1. Not affiliated with Anki or LearnHarness.

## What 0.2.0 does

This is a testing shell for the Anki connection and delivery path. Write a front, back and optional Extra by hand, save edits, approve the card, pick a deck, then send. It also exposes destination pairing, uncertain-send reconciliation, presence checks and Show in Anki.

There is no graph picker, AI drafting or session flow yet. The separate 0.1.0 writer bench lives in [bench/](bench/README.md). The core Flashcards plugin is independent and can stay enabled.

Anki owns review scheduling. The bridge never updates or deletes Anki notes or their review history. Deleted notes are not offered for resend. Explicit note type repair and styling replacement are separate maintenance actions; styling replacement warns before overwriting Anki-side template edits.

## Safe test setup

Use a throwaway Anki profile. Do not test sends against your real collection.

1. Install Anki and the [AnkiConnect add-on](https://ankiweb.net/shared/info/2055492159). Open the throwaway profile and leave Anki running. Current AnkiConnect builds require Anki 26.08 or later; older compatible add-on builds use the same legacy version-6 API.
2. Run LearnHarness from a checkout with scratch `LH_DATA_DIR` and `LH_AUTH_FILE` paths. Do not point either at your normal LearnHarness data or credentials. No model calls are needed for this shell.
3. Install the built plugin into that scratch app's plugins directory, shown under Settings → Community plugins. Refresh and enable Anki Bridge; discovery alone leaves it disabled.
4. Open Anki Bridge from the sidebar. Set the AnkiConnect root URL and optional API key, save, then test the connection. The default is `http://127.0.0.1:8765`. Check your own port first; another service may use it. This project's local test setup uses port 8766. Prefer `127.0.0.1` over `localhost` to avoid IPv6 failures.
5. Confirm that the displayed profile is the throwaway one, then pair it. Changing the URL or Anki profile blocks sending until the correct destination is restored or you explicitly re-pair.
6. Create a hand-written draft, save any edits, approve it and send it to a scratch deck. The deck input accepts an existing deck or a new name. Use Show in Anki to check the actual card rendering.

The API key is stored in plain text under the installed plugin's `data/` folder. Treat that folder as private. The frontend never reads or displays a saved key; a blank password input keeps it, and the clear checkbox removes it. Use loopback and a trusted local AnkiConnect service. A remote HTTP endpoint can expose card content and the key.

## Build and install

Requires Node 23.6 or later and npm. LearnHarness 0.6.1 supplies Node 24 for the backend.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run install:local -- "/absolute/path/to/scratch/plugins"
```

The build bundles `src/main.ts` as ESM and `src/backend.ts` as CommonJS. Only `dist/` is generated, containing the manifest, bundles, stylesheet, license and notices. The backend must be present in the source checkout. No host dependency tree is needed; `sdk/` contains the official generated type-only SDK from LearnHarness 0.6.1.

The local installer copies `dist/` to `<plugins-directory>/anki-bridge/dist/`. It preserves sibling `data/`. Restart LearnHarness after changing already-loaded plugin code; Refresh is discovery, not hot reload.

For a built copy, put the contents of `dist/` under `anki-bridge/dist/` in the plugins directory. Never distribute `data/`. Builds and the installer refuse a symlinked `dist/` or misplaced `dist/data/` before removing old code. Updates replace only `dist/`, not its sibling `data/`.

## Verification status

Automated UI tests use a mocked public plugin context and a synthetic DOM. Build and installer tests use temporary directories, hand-written fixture code and no Anki connection. They do not prove behavior inside the LearnHarness desktop app or against a real AnkiConnect build.

Before calling 0.2.0 verified, test with throwaway profiles on current and older AnkiConnect builds. Cover a closed profile, wrong service or key, pairing mismatch, note type creation and missing fields, new decks, duplicate rejection, partial failure, restart after an uncertain send, presence checks and Show in Anki. Also check enable/disable and late async cleanup in a scratch LearnHarness instance.

## License

AGPL-3.0-only. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
