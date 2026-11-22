# Development

Notes for working on Anki Bridge itself. For using it, see the [README](../README.md) and the [install guide](install.md).

## Setup

Use Node.js 23.6 or newer, npm, and Info-ZIP-compatible `zip` and `unzip` for the packaging tests. The tests need `unzip -Z1`, which BusyBox `unzip` does not support.

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Inspect batch packing without making model calls:

```sh
npm run bench:run -- --dry-run
```

Dry runs still need the selected fixture sets. The default includes a private `qm` set; [prepare your own fixtures or select synthetic sets](../bench/README.md). The following works with the committed fixtures only:

```sh
npm run bench:run -- --dry-run --sets humanities,programming
```

The bench uses the authenticated Claude Code CLI. In-app drafting uses the LearnHarness cheap model, or the model picked in Anki Bridge, and its provider account, including subscription quota on Claude Code routes. The automated tests and dry runs make no model calls.

## Try the development workflow

For development tests, use a throwaway Anki profile and a LearnHarness checkout with scratch `LH_DATA_DIR` and `LH_AUTH_FILE` paths. Generation consumes your selected provider's quota only after you confirm the preflight.

1. Install [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect) and open the throwaway Anki profile. The tested AnkiConnect builds require Anki 26.08 or later. The bridge also requires `getActiveProfile`; older builds without it are refused.
2. Install the built plugin in the scratch app's plugins directory, shown under Settings → Community plugins:

   ```sh
   npm run install:local -- "/absolute/path/to/scratch/plugins"
   ```

   The installer replaces `anki-bridge/dist/` and preserves its sibling `data/`. Discovery leaves the plugin disabled. Enable it in settings; restart LearnHarness after changing already-loaded plugin code.
3. Open the Anki Bridge settings. Save the AnkiConnect address and optional API key, then test the connection. The default is `http://127.0.0.1:8765`; check your local port first because another service may use it. With Anki open on the throwaway profile, choose Use the open profile.
4. Open Anki Bridge from the sidebar and choose ideas in step 1. In step 2, leave the model picker blank for the cheap model or pick one, review the default card types and cap, then press Write cards. The dialog shows the idea count, card limit, model calls and a dollar estimate when the catalog has pricing. Estimating calls no model. Start writing runs it in the background; you can leave the page. Cancelling keeps cards from finished batches.
5. Review each card. The collapsed Source idea shows the statement captured at drafting. Edit and save as needed; editing an approved card returns it to draft. Length warnings are advisory. Drop unwanted cards, then approve cards one at a time or all together. No generated card is approved automatically.
6. Choose an existing or new deck, check the tags and send approved cards. Check presence or use Show in Anki. URL or profile mismatches block sends and reconciliation; do not switch profiles during a send, since AnkiConnect cannot make a profile check and write atomic.

The writer checks for cards that ask for the same recall task during one Write cards run. It drafts flagged ideas first and gives later requests a bounded list of earlier cards from that run. If overlap leaves an idea with no card, look for the skip reason in the Write cards run summary. This check adds no model calls and does not search Anki or past runs. Check for missed repeats in Review, especially in large runs where the full list may not fit.

Completed worker results are applied at most once. Retry the rest offers a new estimate for unsuccessful batches; it does not regenerate successful ones. Source changes and missing ideas are shown without changing Anki notes. Write a card by hand is in the More menu.

The bridge never updates or deletes existing Anki notes or their review history. Field repair and styling replacement are separate actions; styling replacement can overwrite template edits after confirmation. Close affected Anki editors before either operation.

The optional API key is stored in plain text in the plugin's `data/` directory. Keep it private, use loopback and a trusted local AnkiConnect service, and never distribute `data/`. A remote HTTP endpoint can expose both the key and card content. The saved key is not displayed. A blank key input keeps it only while the URL stays the same; saving a different URL clears it, and Remove saved key removes it.

The opt-in [live integration test](0.2.0-verification.md) requires an isolated profile named `Anki Bridge Test`, leaves notes in that collection, and refuses ports 8765 and 8766. It does not start or stop Anki. The core Flashcards plugin is independent and can remain enabled.

## .apkg export

`src/anki/apkg.ts` writes the package with `node:sqlite` and `node:zlib`, so it needs no npm dependency. Its tests in `tests/apkg.test.ts` read packages back with `node:sqlite`. A real Anki import has not been run; the [.apkg export note](fi-9-apkg-export.md) lists what was tested and a throwaway-profile test to run with approval.

## Cloze cards

The design and its checks are in the [FI-8 spec](fi-8-cloze-design.md). Two scripts check cloze output with Anki's own Python library on a scratch collection, so they never touch a real profile. Run them with the Python that ships with Anki, isolated with `-I`, for example `~/Library/Application Support/AnkiProgramFiles/.venv/bin/python` on macOS:

- `bench/cloze-anki-check.py fields.json` adds each Text field to a scratch collection and checks that it renders as one `c1` blank with the exact expected question and answer HTML. `node bench/cloze-fields.ts --samples` writes the escaping samples; `node bench/cloze-fields.ts bench-output/<run>/run.json` writes the cloze cards of a bench run.
- `bench/cloze-apkg-check.py file.apkg` imports a package and prints each note's type, card count, question and answer. `node bench/cloze-apkg.ts out.apkg` writes a synthetic package with basic and cloze cards.

`npm test` does not run either script, because it can't assume Anki is installed.

## Card-quality evidence

The original core bench failed the zero-answer-leak criterion. The 0.1.1 follow-up produced 32 cards from previously unused QM target nodes in the same lecture. Sol provisionally kept 24 of 32 as-is or with small edits, with no flagged leaks or factual errors among the kept cards. Five rejected cards had factual-error flags.

That is a partial result, **not a full benchmark pass**. Claude's quota stopped both synthetic-subject batches. The fixtures are hand-written and cleaner than real extraction output; the QM sample is not from an independent lecture. Human spot-checks and model scores remain separate.

No further bench run was made before 0.9.0. The author judged card quality from daily use instead, which is not a benchmark result. See the [bench guide](../bench/README.md) and [0.1.1 closeout](../bench/0.1.1-closeout.md) for methods and limitations. Private graph data, generated cards and per-card scores are not committed.

## Earlier verification

The 0.2.0 tests used LearnHarness 0.6.1, Anki 26.08.1 and AnkiConnect builds 26.10.11.0 and 26.11.15.0. They covered note type creation and repair, duplicate rejection, profile mismatches, Show in Anki, and recovery after killing the bridge immediately after a real `addNote`. See [0.2.0 verification](0.2.0-verification.md) and [0.3.0 verification](0.3.0-verification.md).

## Keeping the README current

Every version change, including patches, updates the README in the same PR. The README is the product page. It covers what Anki Bridge does, how to use it with current screenshots, how to install it, its limitations and a short roadmap. Version history goes in `CHANGELOG.md`, and test evidence goes in the version's verification note in `docs/`. Mark unmerged or planned work explicitly.

README images live in `docs/images/readme/`. Screenshots are taken at 2x from a scratch LearnHarness with synthetic data, then framed. The diagrams and frames are rendered from HTML in [docs/images/readme/src](images/readme/src/README.md). When the interface or a status changes, retake the affected screenshots, update the matching diagram text, and check the alt text in the README.
