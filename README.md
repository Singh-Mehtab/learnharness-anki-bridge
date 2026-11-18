# Anki Bridge

An unofficial LearnHarness community plugin in development. The goal is to draft cards from your knowledge graph, let you edit and approve them, and send them to Anki through AnkiConnect. Delivery is one-way; Anki keeps responsibility for reviews and scheduling. This project is not affiliated with Anki or LearnHarness.

**Version 0.3.0, proposed in this PR.** Select graph nodes, confirm a generation estimate, review and edit the model's drafts, then explicitly approve and send them to Anki. Interrupted generation can recover completed results after restart. There is no public release yet.

![Target workflow: graph selection, card writing, approval, then delivery to Anki. Each step shows its implementation status.](docs/images/workflow.svg)

The diagram shows the manual drafting workflow implemented on this branch. Session flags and coverage filtering are planned for later versions.

## What's done

| Version | Status | Work completed |
| --- | --- | --- |
| 0.1.0 | Merged | Shared writer input builder, graph context, batching, prompts, result schema and validation. Sonnet bench with real QM nodes and labelled synthetic fixtures. Local browser scoring, JSON results and per-run reports. |
| 0.1.1 | Merged in [PR #1](https://github.com/Singh-Mehtab/learnharness-anki-bridge/pull/1) | Multiline code support, stronger accuracy and answer-leak guidance, soft word targets, a hard generation-call budget, and separate automated/human scoring. 22 tests, typecheck and browser checks passed. Sol approved the code. |
| 0.2.0 | Merged in [PR #2](https://github.com/Singh-Mehtab/learnharness-anki-bridge/pull/2) | Connection/profile pairing, owned Basic note type, approval, durable delivery, interrupted-send recovery, presence checks and Show in Anki. Final merged head passed 77 tests, build and typecheck. Real AnkiConnect and scratch LearnHarness checks predate the final renderer fixes and main merge. |
| 0.3.0 | Implemented on this branch, pending review | Native graph and model pickers, configurable card kinds and cap, confirmed preflight, worker generation, source-aware editable review with previews, bulk approval/send, dropping cards and generation recovery. See [verification and limits](docs/0.3.0-verification.md). |

### Card writer

- Core kinds: recall, why, compose and discriminate. Why/compose need supporting chains; discriminate needs a relevant neighbour.
- Up to two cards per node, not a quota. Prefer one useful card over a near-duplicate pair.
- Soft targets of 30 front words and 15 back words. Correctness and necessary assumptions take priority.
- Maths, inline code and multiline fenced code. Images and Mermaid are unsupported in cards.
- Deterministic checks for structure, allowed kinds, duplicates and surface answer leaks. These checks cannot guarantee factual accuracy or detect every semantic leak.

Mini-problem and spot-the-mistake kinds remain experimental and off by default.

### Quality evidence and limits

The original core bench failed the zero-answer-leak criterion. The 0.1.1 follow-up produced 32 cards from previously unused QM target nodes in the same lecture. Sol provisionally kept 24 of 32 as-is or with small edits, with no flagged leaks or factual errors among the kept cards. Five rejected cards had factual-error flags.

That is a partial result, **not a full benchmark pass**. Claude's quota stopped both synthetic-subject batches. The fixtures are hand-written and cleaner than real extraction output; the QM sample is not from an independent lecture. Human spot-checks and model scores remain separate.

Additional card-quality validation is deferred until before public release. No automatic rerun is scheduled. See the [bench guide](bench/README.md) and [0.1.1 closeout](bench/0.1.1-closeout.md) for methods and limitations. Private graph data, generated cards and per-card scores are not committed.

## Development preview

![Anki Bridge in a scratch LearnHarness host, showing a hand-written test card sent to a throwaway Anki profile and found in Anki.](docs/images/0.2.0-scratch-host.png)

Actual 0.2.0 integration-test screenshot, not a mockup. It uses synthetic cards, an empty scratch LearnHarness environment and a throwaway Anki profile. The screenshot demonstrates 0.2.0 manual delivery, not graph-based generation.

The 0.2.0 tests used LearnHarness 0.6.1, Anki 26.08.1 and AnkiConnect builds 26.10.11.0 and 26.11.15.0. They covered note type creation and repair, duplicate rejection, profile mismatches, Show in Anki, and recovery after killing the bridge immediately after a real `addNote`. Scratch browser tests covered enabling the plugin, manual approval, sending and data preservation after disable/re-enable. The live checks predate the renderer-only review fixes. See [verification details](docs/0.2.0-verification.md).

## Development setup

Use Node.js 23.6 or newer and npm:

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

Dry runs still need the selected fixture sets. The default includes a private `qm` set; [prepare your own fixtures or select synthetic sets](bench/README.md). The following works with the committed fixtures only:

```sh
npm run bench:run -- --dry-run --sets humanities,programming
```

The bench uses the authenticated Claude Code CLI. In-app drafting uses your explicitly selected LearnHarness model and its provider account, including subscription quota on Claude Code routes. The automated tests and dry runs make no model calls.

### Try the 0.3.0 workflow

For development tests, use a throwaway Anki profile and a LearnHarness checkout with scratch `LH_DATA_DIR` and `LH_AUTH_FILE` paths. Generation consumes your selected provider's quota only after you confirm the preflight.

1. Install [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect) and open the throwaway Anki profile. The tested AnkiConnect builds require Anki 26.08 or later. The bridge also requires `getActiveProfile`; older builds without it are refused.
2. Install the built plugin in the scratch app's plugins directory, shown under Settings → Community plugins:

   ```sh
   npm run install:local -- "/absolute/path/to/scratch/plugins"
   ```

   The installer replaces `anki-bridge/dist/` and preserves its sibling `data/`. Discovery leaves the plugin disabled. Enable it in settings; restart LearnHarness after changing already-loaded plugin code.
3. Open Anki Bridge from the sidebar. Save the AnkiConnect URL and optional API key, then test the connection. The default is `http://127.0.0.1:8765`; check your local port first because another service may use it. Use a separate port for isolated tests.
4. Choose graph nodes using the knowledge picker and select a configured model. Set the maximum cards per node and enabled kinds. Request a preflight and check the node count, maximum cards, task count and token estimate. A dollar estimate appears only when the model catalog supplies pricing. Confirm to start. Cancellation keeps drafts from completed tasks.
5. Review each card beside the source statement captured at drafting. Check correctness and assumptions, edit as needed and save. The live preview supports maths and code. Length warnings are advisory. Drop unwanted cards, then approve cards individually or confirm bulk approval. Editing clears approval. No generation result is approved automatically.
6. Test and pair the displayed throwaway Anki profile. Choose an existing or new deck and send approved cards. Check presence or use Show in Anki. URL or profile mismatches block sends and reconciliation; do not switch profiles during a send, since AnkiConnect cannot make a profile check and write atomic.

Use Refresh generation to inspect running or interrupted tasks. Completed worker results are applied at most once. Retry offers a new preflight for unsuccessful tasks; it does not regenerate successful tasks. Source changes and missing nodes are shown without changing Anki notes. Writing a card by hand is still available in a collapsed section.

The bridge never updates or deletes existing Anki notes or their review history. Field repair and styling replacement are separate actions; styling replacement can overwrite template edits after confirmation. Close affected Anki editors before either operation.

The optional API key is stored in plain text in the plugin's `data/` directory. Keep it private, use loopback and a trusted local AnkiConnect service, and never distribute `data/`. A remote HTTP endpoint can expose both the key and card content. The saved key is not displayed; a blank key input keeps it, and the clear checkbox removes it.

The opt-in [live integration test](docs/0.2.0-verification.md) requires an isolated profile named `Anki Bridge Test`, leaves notes in that collection, and refuses ports 8765 and 8766. It does not start or stop Anki. The core Flashcards plugin is independent and can remain enabled. A public installation guide will accompany a release.

## Next versions

| Version | Planned scope |
| --- | --- |
| 0.4.0 | Session workflow and session-based card generation. |
| 0.5.0 | Card coverage and no-cards filtering. |
| 0.6.0 | First public release, after validation and explicit publication approval. |

These are plans, not shipped features or promised dates. The design is one-way and approval-first: the plugin must not update or delete existing Anki notes or change scheduling. Anki edits win.

## Keeping this page current

Every version change, including patches, must update this README in the same PR. Keep the current version, completed work, test evidence, limitations and screenshots accurate. Mark unmerged or planned work explicitly. Repository instructions enforce this rule for coding agents.

## License and acknowledgements

[AGPL-3.0-only](LICENSE).

The writer adapts card-design guidance from [LearnHarness core Flashcards](https://github.com/amosblomqvist/learnharness/tree/v0.6.1/plugins/flashcards) and [Twig](https://github.com/amoghu1s1/twig), under AGPL-3.0. Anki Bridge uses a different approval-first, one-way delivery design. [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect) provides the local Anki API.
