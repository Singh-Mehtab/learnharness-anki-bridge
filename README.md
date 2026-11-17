# Anki Bridge

Unofficial, one-way AnkiConnect plugin for LearnHarness 0.6.1, plugin API v1. Not affiliated with Anki or LearnHarness.

## What 0.2.0 does

This is a testing shell for the Anki connection and delivery path. Write a front, back and optional Extra by hand, save edits, approve the card, pick a deck, then send. It also exposes destination pairing, uncertain-send reconciliation, presence checks and Show in Anki.

There is no graph picker, AI drafting or session flow yet. The separate 0.1.0 writer bench lives in [bench/](bench/README.md). The core Flashcards plugin is independent and can stay enabled.

Anki owns review scheduling. The bridge never updates or deletes Anki notes or their review history. Deleted notes are not offered for resend. Explicit note type repair and styling replacement are separate maintenance actions; styling replacement warns before overwriting Anki-side template edits.

## Safe test setup

Use a throwaway Anki profile. Do not test sends against your real collection.

1. Install Anki and the [AnkiConnect add-on](https://ankiweb.net/shared/info/2055492159). Open the throwaway profile and leave Anki running. Current AnkiConnect builds require Anki 26.08 or later. The bridge uses the legacy version-6 API and also requires `getActiveProfile` for destination safety. Tested add-on builds are 26.10.11.0 and 26.11.15.0. Archived 23.10.29.0 and 2025 GitHub builds lack profile identity support and are refused.
2. Run LearnHarness from a checkout with scratch `LH_DATA_DIR` and `LH_AUTH_FILE` paths. Do not point either at your normal LearnHarness data or credentials. No model calls are needed for this shell.
3. Install the built plugin into that scratch app's plugins directory, shown under Settings → Community plugins. Refresh and enable Anki Bridge; discovery alone leaves it disabled.
4. Open Anki Bridge from the sidebar. Set the AnkiConnect root URL and optional API key, save, then test the connection. The default is `http://127.0.0.1:8765`. Check your own port first; another service may use it. Use a separate port for isolated compatibility tests, such as 18765 or 18766. Never point an automated test at your usual profile. Prefer `127.0.0.1` over `localhost` to avoid IPv6 failures.
5. Confirm that the displayed profile is the throwaway one, then pair it. Changing the URL or Anki profile blocks sending until the correct destination is restored or you explicitly re-pair. Do not switch profiles during a send. Legacy AnkiConnect cannot make a profile check and a write one atomic operation.
6. Create a hand-written draft, save any edits, approve it and send it to a scratch deck. The deck input accepts an existing deck or a new name. Use Show in Anki to check the actual card rendering.

Close affected Anki editors before repairing fields or replacing styling. AnkiConnect refuses these writes while an editor is open; the bridge reports that refusal without bypassing it.

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

The automated suite covers delivery persistence, profile/URL guards, connection failures, rendering, UI behavior, build/install safety and restart recovery. UI unit tests use a synthetic DOM. Build and installer tests use temporary directories.

Real Anki 26.08.1 integration passed against AnkiConnect 26.10.11.0 and 26.11.15.0 in separate throwaway bases. Both runs covered note type creation and field repair, new decks, duplicate rejection with the next card succeeding, stored math/code HTML, presence checks, styling replacement and Show in Anki. A real bridge process was killed after Anki accepted a note and before the state write; restart recovered one note by UUID on both builds.

Run that opt-in test only against an isolated profile named `Anki Bridge Test`, with no Anki editors open:

```sh
npm run test:anki-live -- --url http://127.0.0.1:18766 \
  --profile "Anki Bridge Test" --confirm-scratch-profile
```

The test leaves hand-written notes in the throwaway collection and removes its temporary bridge state. It refuses ports 8765 and 8766. It does not install, start or stop Anki.

Scratch LearnHarness 0.6.1 browser verification also passed discovery, enable/disable, persistence and an end-to-end approved send to the throwaway Anki profile. See [verification details and screenshot](docs/0.2.0-verification.md). Packaged Electron-specific behavior and user acceptance remain unverified.

## License

AGPL-3.0-only. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
