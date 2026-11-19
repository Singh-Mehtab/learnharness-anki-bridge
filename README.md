# Anki Bridge

Anki Bridge turns what you learn in [LearnHarness](https://github.com/amosblomqvist/learnharness) into Anki cards. A model drafts cards from the ideas in your knowledge graph. You check and edit each one, and only the cards you approve go to Anki through AnkiConnect.

> Version 0.7.2 is a personal-use candidate. There is no public release yet. Anki Bridge is an unofficial community plugin and is not affiliated with Anki or LearnHarness.

![Anki Bridge in LearnHarness. A Fact draft asks what femto denotes and an Equation draft shows the nuclear radius relation. Both cards are waiting for review.](docs/images/0.7.2-review.png)

## What it does

- Drafts cards from your own graph. The writer works from the ideas LearnHarness extracted while teaching you, with linked ideas as context.
- Sends nothing without your approval. Every card starts as a draft, and editing an approved card makes it a draft again.
- Lets you flag the replies you struggled with. One click in a lesson marks the teacher's reply, and you can leave a note such as "I got the sign wrong" for the writer.
- Writes maths for Anki's MathJax, with equations on their own lines.
- Tags cards to match your collection. A template such as `{deck}::Lecture_01` tags each card by deck and lecture, and you can change the tags before each send.
- Shows what you have already covered. Each idea says whether it has cards in Anki, cards waiting for review, or none, so you can fill the gaps.
- Only adds notes. It never edits or deletes existing Anki notes, and Anki keeps your reviews and scheduling.

## How it works

![Workflow: choose ideas, write cards, review and send, then delivery to Anki.](docs/images/workflow.svg)

The Anki Bridge page has three numbered steps.

### 1. Choose ideas

Under "Ideas from", pick one teaching session or your whole graph. In a session, the ideas from flagged replies start ticked. Each idea shows whether it already has cards, and "Select ideas without cards" ticks the gaps.

![Step 1. A lecture session is chosen, its flag note is shown, and five flagged ideas are ticked in a bordered list with coverage labels.](docs/images/0.7.0-choose-ideas.png)

### 2. Write cards

Fact and Equation are on by default. They ask directly for things worth remembering, such as a unit prefix, a definition or a formula. You can turn on Steps for procedures, Apply for a new example, or Why, Compose and Contrast for reasoning about linked ideas. Turn on numerical constant values if you want to memorise them too. A conversion constant you use in calculations can still get a card with that option off.

Anki Bridge uses LearnHarness's cheap model and its thinking setting unless you pick another model. Set a limit per idea. Flagged ideas can get up to 12 cards even if the normal limit is lower; there is no separate per-session limit.

Write cards shows the size and estimated cost of the run before anything starts. The model drafts in the background, so you can leave the page. Progress also shows under Background agents.

![Write cards settings with Fact and Equation on, the other card types and constant values off, and the LearnHarness cheap model selected.](docs/images/0.7.2-card-types.png)

### 3. Review and send

Each card shows Front, Back and Extra side by side with the maths rendered. Edit opens the TeX source with a live preview underneath. Approve the cards you're happy with, check the deck and tags, then send. The deck field suggests your Anki decks and tells you when a name is new. The tags field suggests tags already in your collection as you type. After a send, a panel says how many cards went to which deck and tags, with a button to show them in Anki.

![Editing a card. The front and back text boxes hold TeX source, the rendered preview sits under each one, and the idea the card was written from is folded away below.](docs/images/0.7.0-edit.png)

## Install

You need LearnHarness 0.6.1 or later, Anki Desktop 26.08 or later with [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect), and a model set up in LearnHarness. Writing cards uses that model provider's quota. Estimates make no model calls.

There is no download yet. Build the install zip from a checkout of this repository with Node.js 23.6 or later:

```sh
npm ci
npm run package:plugin
```

This writes `anki-bridge-v0.7.2.zip` at the repository root. Then:

1. In LearnHarness, open Settings → Community plugins and copy the plugins folder path. Quit LearnHarness.
2. Unzip the archive and move the `anki-bridge` folder into the plugins folder.
3. Restart LearnHarness and enable Anki Bridge under Community plugins.
4. Open Anki with AnkiConnect running. In LearnHarness, open Settings → Anki Bridge. Save the AnkiConnect address, press Test connection, then choose Use the open profile.
5. Open Anki Bridge from the sidebar.

The [install guide](docs/install.md) covers upgrading without losing drafts, rolling back and troubleshooting.

## Flag replies during a lesson

In a teaching session, Flag for Anki in the top bar marks the teacher's latest reply. You can add a note for the writer. `Cmd/Ctrl+Shift+A` flags straight away and offers the note in a short confirmation. After you flag a reply or save a note, the dialog says so and closes itself. Make cards opens Anki Bridge with that session's flagged ideas ticked.

A flag covers every idea LearnHarness extracts from that reply. Extraction runs after the reply finishes, so a new flag can show as waiting for a short time.

![The flag dialog shows a plain-text preview of the teacher's reply and a field for a note to the card writer.](docs/images/0.7.0-flag-dialog.png)

## Tags

Set "Tags for new cards" in the Anki Bridge settings. Separate tags with spaces. `{deck}` becomes the deck name with spaces replaced by underscores. With the template `{deck}::Lecture_01` and the deck `Year 3::Nuclear Physics`, cards get the tag `Year_3::Nuclear_Physics::Lecture_01`. Anki treats tags that differ only in case as the same tag. If your collection already has `YEAR_3::…` tags, the send step shows the tag as `YEAR_3::Nuclear_Physics::Lecture_01` to match.

The send step shows the tags before each send, and you can change them there. As you type, it suggests matching tags from your Anki collection. With an empty field, or after a space, it suggests only the tags under the deck's own tag, such as earlier lectures. Cards also get `learnharness` and a card-type tag such as `learnharness::kind::fact` or `learnharness::kind::equation`. You can turn these off in settings.

## Settings

The Anki Bridge settings hold the AnkiConnect address and optional key, the Anki profile cards go to, the tag template, and repairs for the bridge's note type. Test connection says plainly when Anki is closed or AnkiConnect isn't reachable.

![Anki Bridge settings after a connection test. The Connect to Anki box has the address, key, Save and Test connection, with the result under the buttons. The Anki profile box sits below.](docs/images/0.7.0-settings.png)

## The card writer

- One to four cards per unflagged idea, two by default. This is a limit, not a target. The writer can skip an idea if there is no useful, supported card to make.
- Fact and Equation fronts aim for about 12 words. Give just enough context to identify the answer without giving it away.
- Every variable, symbol and equation is written as maths. Fenced code keeps its indentation. Images and Mermaid diagrams aren't supported in cards.
- Why and Compose cards need a supporting chain of ideas in the graph, and Contrast cards need a similar neighbouring idea. Otherwise the writer skips them.
- If the writer can't check a card's claims, it returns no card for that idea and says why.
- Automatic checks catch broken structure and some answers leaked into questions. Read each card before approving it; the checks cannot prove correctness or spot every repeat.

## Privacy and safety

- Writing cards sends the chosen ideas to the active model provider, along with their linked ideas, an excerpt of the session reply each idea came from (flagged or not), your flag notes and any existing cards for those ideas. The Write cards dialog lists this before anything is sent.
- From Anki, the bridge reads the open profile's name, its deck names and its tag names, for the deck and tag suggestions. It only looks up notes it sent itself, to check they still exist. Anki returns those notes' fields with the answer, and the bridge doesn't use them. It doesn't read your other notes or your review history.
- The optional AnkiConnect key is stored in plain text in the plugin's `data/` folder. Never share that folder. Use AnkiConnect on your own machine.
- Community plugins run local code with LearnHarness's permissions. Install builds you trust.
- Adding missing fields and resetting styling and templates only change the bridge's own note type, and both ask you to confirm first.

## Limitations

- The new writer was tuned using one lecture. In the scored run, 36 of 39 cards were kept as written or with small edits. That's feedback on one set of cards, not a benchmark on new subjects. See [0.7.2 verification](docs/0.7.2-verification.md).
- The 0.7.2 interface was checked in Chromium with synthetic data in a scratch LearnHarness. The new writer has not been tested end to end with a live model and a real Anki profile.
- Tested only on macOS with LearnHarness 0.6.1.

## Roadmap

- Done: drafting from the graph, session flags, coverage labels, delivery to Anki and fact-first drafting. See the [changelog](CHANGELOG.md).
- Next: try the new defaults in daily use and test card quality on material the writer was not tuned on.
- After that: a public release, then a listing in the LearnHarness community plugin list.
- Ideas, not scheduled: sending cards you keep failing in Anki back to LearnHarness as weak spots, and practice sessions aimed at those weak spots.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
```

[Development notes](docs/development.md) cover the scratch test setup, the card-quality bench and earlier verification. The [generation](docs/generation-contract.md) and [session](docs/session-contract.md) contracts describe how the plugin works inside.

## License and acknowledgements

[AGPL-3.0-only](LICENSE).

The writer adapts card-design guidance from [LearnHarness core Flashcards](https://github.com/amosblomqvist/learnharness/tree/v0.6.1/plugins/flashcards), [Twig](https://github.com/amoghu1s1/twig) and the [LearnHarness recall cards proposal](https://github.com/amosblomqvist/learnharness/pull/447), under AGPL-3.0. Anki Bridge uses a different approval-first, one-way delivery design. [AnkiConnect](https://git.sr.ht/~foosoft/anki-connect) provides the local Anki API.
