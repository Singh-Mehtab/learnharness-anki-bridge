# FI-9: .apkg export

Download .apkg saves approved cards as an Anki package. It is a fallback for when AnkiConnect isn't available: Anki can be closed and no profile is paired. AnkiConnect stays the main route, and its delivery code is unchanged.

## What a download does

- The backend operation `exportPackage` takes `{ ids, deck, tags }`. It accepts only cards that are approved or failed and have no Anki note ID, the same set Send to Anki uses. Deck and tag rules match a send. Without `tags`, the saved tag template is used.
- It reads saved state and writes nothing to it. No card is marked sent, so coverage still counts these cards as waiting for review, not in Anki. There is no schema change.
- It runs inside the delivery writer fence, so a package can't catch a card halfway through a send.
- The result is the `.apkg` as base64 with the file name, deck, tags and card IDs. The page saves it with a Blob link, as LearnHarness does for its own downloads.
- After a download, a panel says the download was requested (the page gets no signal that the file was saved, so it doesn't claim it was) and that the cards are not sent and warns about duplicates and updates on import. Download again saves the same bytes without a new export. The button stays available, so the same approved batch can be downloaded again later.

## Package contents

- A zip with `collection.anki2` (Anki's legacy schema 11 collection) and `media` (`{}`). Current and older Anki versions import this layout. The schema and collection defaults follow genanki (MIT, see `THIRD_PARTY_NOTICES.md`).
- SQLite comes from `node:sqlite`. No dependency was added. The zip writer uses `node:zlib`.
- One note type, LearnHarness Basic, with a fixed ID (`1794873600000`) and the same fields, templates and CSS marker as the note type AnkiConnect creates.
- One deck with an ID derived from its name, plus Anki's Default deck entry. A deck named Default, in any case, uses the Default entry (ID 1) instead of a second deck.
- Per card, one note and one new card. Fields and tags are the values delivery sends with `addNote`. The note GUID is the card's Anki Bridge ID, which is also in `LH_ID`. Cards keep review order in `due`.

## What Anki may do on import

This is what to expect, not what has been checked:

- A note that AnkiConnect already added has a GUID Anki made up, so importing a package with the same card is likely to add a duplicate. Anki Bridge doesn't block or detect this.
- Importing a later package with the same Bridge IDs may update or skip notes from an earlier one, depending on Anki's import options.
- If the collection has a LearnHarness Basic note type made through AnkiConnect, its ID differs from the package's, so Anki may add a second note type.
- After an import, Send to Anki looks up each card's `LH_ID` before adding, so it may find the imported note and record the card as sent. Not tested against a real Anki.

## Verification

Tested, with synthetic cards only:

- `tests/apkg.test.ts` unzips the package with CRC checks, opens the collection with `node:sqlite` and checks: integrity, schema 11 tables and indexes, note type fields, templates and CSS, deck, GUIDs equal to Bridge IDs, field values including escaped code with indentation and MathJax delimiters, tags with and without the learnharness tags, and new-card rows. It checks that only approved, unsent cards are accepted and that bad input gets a clear error. It checks that `state.json` is unchanged after two downloads and that both packages hold the same notes. One test sends the same cards through `DeliveryService` with a fake AnkiConnect and compares its `addNote` fields and tags with the package.
- `tests/backend.test.ts` calls `exportPackage` through the activated backend while unpaired, with `fetch` set to throw. The download works and `state.json` is unchanged.
- `tests/plugin-ui.test.ts` clicks Download .apkg while unpaired. It checks the call, the saved file name and zip bytes, the not-sent text and the import warning, that no send was made, that cards stay approved, and that Download again saves identical bytes without a second export.
- The built `dist/backend.cjs`, loaded with Node's native `require` as LearnHarness loads plugins, exported a synthetic card under Node 26 and under LearnHarness 0.6.1's bundled runtime (Electron 44.9.3, Node 24.22.0, run with `ELECTRON_RUN_AS_NODE=1` and a scratch data directory). Python's `zipfile` and `sqlite3` read both packages; `PRAGMA integrity_check` returned `ok`.

Not tested:

- Importing a package into Anki, and importing it a second time. This needs a separately approved test in a throwaway Anki profile.
- Downloading from the LearnHarness desktop window or a browser tab. The DOM test covers the Blob link, not a real browser's save prompt.

## Throwaway-profile test (needs approval)

1. In a new Anki profile with no LearnHarness Basic note type, import a package of two synthetic cards. Check the deck, both cards, rendered maths and code, tags, and the `LH_ID` field.
2. Import the same file again. Note whether Anki reports updated, skipped or new notes.
3. Edit one card in Anki Bridge, approve it, download again and import. Note whether the note updates.
4. Pair the profile and Send to Anki for an imported card. Check whether it is recorded as sent without adding a note.
5. Download a package with a new approved card, then send that card through AnkiConnect, then import the saved package. Note whether a duplicate appears.
