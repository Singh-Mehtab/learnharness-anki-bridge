# FI-1 weak-spots view: design note

Status: design only. No plugin code changes. Nothing here is scheduled or approved for merge.

Base: origin/main e98e1ca (v0.6.1). UI placement targets the unmerged 0.7.0 redesign (PR #29, branch `origin/feat/0.7.0-redesign`), read-only. Anki side evidence comes from the SourceHut AnkiConnect repository (`https://git.sr.ht/~foosoft/anki-connect`), read at tags 26.10.11.0 (`f69c9e4`) and 26.11.15.0 (`ee75fcf`). No real Anki, AnkiConnect instance, LearnHarness data or model was used.

## What the view is

An opt-in, on-demand, read-only page. For notes the bridge itself sent to the paired Anki profile, it reads review results from Anki and groups them by source idea (graph node): lapse counts, recent Again presses, leech tags. Each group shows the cards and the session they came from. It never changes scheduling, tags, suspension or note content.

A lapse is a signal to inspect, not proof of an understanding gap. It can also mean a badly written card, an ordinary memory lapse, or a card that is hard to word. The view shows the evidence and does not name a gap.

This changes a stated rule. The plan's Design decisions table ("Direction" row) says the plugin "never reads or changes scheduling or review history", and the README (line 122) says the bridge never updates or deletes existing notes or their review history. The second statement stays true. The first needs an explicit amendment before implementation (open decision 1).

## 1. AnkiConnect actions

### Allowlist

The weak-spots read path may send exactly these five actions, all with `version: 6` and the optional `key` as `AnkiClient.call` already does (`src/anki/client.ts:86-103`):

| Action | Request fields used | Response fields used |
| --- | --- | --- |
| `version` | none | `6` (liveness only, as today) |
| `getActiveProfile` | none | profile name or `null` |
| `notesInfo` | `notes`: array of Anki note IDs from local records (never `query`) | per note: `noteId`, `profile`, `tags`, `fields.LH_ID.value`, `modelName`, `cards`; `{}` for a missing note |
| `cardsInfo` | `cards`: array of card IDs from `notesInfo.cards` | per card: `cardId`, `note`, `lapses`, `reps`, `interval`, `type`, `queue`, `due`, `factor`, `mod`, `deckName`; `{}` for a missing card |
| `getReviewsOfCards` | `cards`: array of card IDs | object keyed by card ID string; each entry is an array of `{id, ease, type, ivl, lastIvl, time}`; `id` is review time in Unix milliseconds |

The reader is a small class that holds this set and throws before any request if given another action name. It is the only code path the weak-spots service uses to talk to Anki. A test also scans every request a fake AnkiConnect receives and fails on anything outside the set.

No write or scheduling action is ever called. In particular the view never sends `answerCards`, `suspend`, `unsuspend`, `forgetCards`, `relearnCards`, `setDueDate`, `setEaseFactors`, `setSpecificValueOfCard`, `addTags`, `removeTags`, `updateNoteTags`, `deleteNotes`, `insertReviews`, or any `gui*` action. The existing "Show in Anki" button (`guiBrowse`) stays a separate, user-clicked action and is not part of a refresh.

### Considered and left out

- `findCards` and `findNotes`: not needed. The join is by the Anki note IDs the bridge already saved (section 2). A query like `note:"LearnHarness Basic" tag:leech` would also find notes the local state does not know about, which is FI-10 territory (recover from Anki), not this view.
- `getNoteTags`: `notesInfo.tags` already returns tags in the same call.
- `cardReviews`, `getLatestReviewID`: both can create a missing deck. In 26.11.15.0 `cardReviews` calls `decks.create` (`plugin/legacy.py:1037`), and `API_LEGACY.md` says "A missing deck is created" for both `cardReviews` (line 3575) and `getLatestReviewID` (line 3620). A read feature must not use them.
- `areSuspended`, `getIntervals`, `getEaseFactors`, `cardsToNotes`: `cardsInfo` carries `queue`, `interval`, `factor` and `note` already.

### Existence and shape on the two supported builds

Both builds expose every allowlisted action. Verified by reading the code, not by running the add-on.

| Action | 26.10.11.0 (`f69c9e4`) | 26.11.15.0 (`ee75fcf`) |
| --- | --- | --- |
| `getActiveProfile` | `plugin/__init__.py:297`; `plugin/legacy.py:247` | `plugin/__init__.py:265`; `plugin/legacy.py:485` |
| `notesInfo(notes=None, query=None)` | `plugin/__init__.py:645`; projection `plugin/legacy.py:551-570`; note record `218-224` | `plugin/__init__.py:526`; projection `plugin/legacy.py:908-932`; note record `436-443` |
| `cardsInfo` | `plugin/__init__.py:601` as `cardsInfo(self, cards)`; card record `plugin/legacy.py:225-234` | `plugin/__init__.py:493` as `cardsInfo(self, cards, fields=None)`; `card_info` `plugin/legacy.py:446-473` |
| `getReviewsOfCards(cards)` | `plugin/__init__.py:625`; `plugin/legacy.py:663-677` | `plugin/__init__.py:511`; `plugin/legacy.py:1035-1051` |
| Underlying v1 methods | `cards.getMany`, `notes.get`, `reviews.list`, `scheduling.predict`: effect `read` in `api-v1.schema.json` (`x-methods` at lines 14085, 15157, 14279 and the notes entries) | same methods: effect `read` (lines 14305, 15431, 14525) |

Details that shape the design:

- Both builds return the same legacy envelope the client already validates (`{result, error}`), and the legacy projection is the same for the fields we use: `lapses`, `reps`, `interval`, `type`, `queue`, `due`, `factor`, `note`, `deckName` on cards; `tags`, `modelName`, `fields`, `cards`, `profile` on notes (`plugin/legacy.py:223-234` and `441-461`).
- `notesInfo` also returns the profile name per note (`profile`, `legacy.py:222` in 26.10.11.0 and `legacy.py:441` in 26.11.15.0). That gives a second destination check inside the same response as the data.
- A missing note or card comes back as `{}` on both builds (`legacy.py:569`, `legacy.py:929`), so a deleted card is distinguishable and not an error.
- `cardsInfo` in 26.10.11.0 always renders the card and predicts next intervals (`legacy.py:227-228`). Both methods are marked `read`, and prediction only describes states (`scheduling.predict`, note: "Tokens are invalidated by relevant writes", same text on both builds). It is slower than needed but does not write.
- The `fields` option of `cardsInfo` exists only in 26.11.15.0 (`__init__.py:493`, `API_LEGACY.md:596-614`). On 26.10.11.0 an unknown parameter makes `inspect.signature(method).bind(**params)` raise (`plugin/__init__.py:112-120`), so the call fails. Decision: send the same request on both builds, without `fields`. Cost is more work per card on the AnkiConnect side, handled by small batches (section 4). Using `fields` where available is an optimisation for later.
- `getReviewsOfCards` on 26.11.15.0 tolerates deleted cards (`cards.getMany` with `missing=True`, `legacy.py:1040`). On 26.10.11.0 it passes the IDs straight to `reviews.list` (`legacy.py:664`), whose schema lists a `notFound` error. The plugin therefore passes only card IDs that `cardsInfo` just returned as non-empty, and retries once from `cardsInfo` if a `notFound`-type error still comes back.
- `reviews.list` returns at most 1000 rows per page and the add-on follows cursors itself (`all_pages`, `legacy.py:46-54`); a `staleCursor` error is possible if the collection changes mid-read. Treat it as retry once, then report.
- Review rows carry `ease` 1 to 4 (1 is Again, `RATINGS = ('again','hard','good','easy')`, `plugin/services.py:19`) and `type` 0 to 5 (`KINDS = ('learning','review','relearning','filtered','manual','rescheduled')`, `services.py:20`), returned as the index. Manual and rescheduled entries have `ease` 0.
- A newer tag, 26.11.18.0 (`a08d4d5`), also exists upstream. It changes `plugin/__init__.py` by 14 lines against 26.11.15.0 and keeps the same three signatures (`__init__.py:499`, `517`, `532`). It is not one of the two supported builds and was not checked further.

### Not verified

- Nothing was run. Behaviour on a real collection (timing, memory, real `staleCursor` or `busy` replies) is untested. The 0.2.0 verification covered connection actions on Anki 26.08.1 only (`docs/0.2.0-verification.md`); review actions are new.
- The meaning of `type`, `queue` and `lapses` is Anki's own card model passed through AnkiConnect. Documented Anki behaviour (queue -1 is suspended, review type 1 failures are lapses, revlog type values) was not re-verified against Anki source here. The leech behaviour was checked against the Anki manual (`https://docs.ankiweb.net/leeches.html`, fetched 2026-11-19): at the lapse threshold (default 8) Anki tags the note `leech` and, by default, suspends the card; both settings are deck options.
- Whether `getReviewsOfCards` errors on a card deleted between calls on 26.10.11.0 is inferred from the schema error list, not observed.
- Behaviour on the archived 23.10.29.0 and 2025 GitHub builds is out of scope: they lack `getActiveProfile` and are already refused (plan, "Compatibility").

## 2. Scope and joins

### Destination scope

The view uses the same destination rule as delivery and `presence`:

1. The saved pairing must exist and its URL must equal the current settings URL (`delivery.ts:122-125`).
2. `getActiveProfile` must return the paired profile name (`delivery.ts:126-131`). A null profile or a different one stops the read.
3. The check runs before and after each batch, as `presence` does around each `notesInfo` (`delivery.ts:279-283`). A result is discarded if the pairing or profile changed during the read.
4. Each returned note's `profile` must equal the paired profile name. A mismatch discards the batch.

Only local cards that meet all of these are read: `status === "sent"`, a `noteId`, and `sameDestination(card.destination, paired)` (`state.ts`/`destination.ts`). Cards sent to another destination ("sent elsewhere" in coverage) are never read.

### Owned note type

Scope is by local record, not by search. After `notesInfo`, a note is accepted only if:

- `modelName === "LearnHarness Basic"` (`MODEL_NAME`, `note-type.ts:3`), and
- `fields.LH_ID.value === card.id` (the local delivery UUID).

A mismatch (note edited, field blanked, or a different note at that ID) excludes the card and counts it as "changed in Anki". Anki edits win; the view does not repair anything.

### Joining local records to card IDs

| Local record (`Card`, `state.ts:11-30`) | Anki | Use |
| --- | --- | --- |
| `noteId` | `notesInfo[i].noteId` | note lookup; must equal |
| `id` (LH_ID) | `notesInfo[i].fields.LH_ID.value` | identity check |
| none | `notesInfo[i].cards` (card IDs) | input to `cardsInfo` and `getReviewsOfCards` |
| none | `cardsInfo[j].note` | must equal the note ID; otherwise drop |
| `nodeId`, `nodeName` | none | grouping key and label |
| `sessionId`, `sessionName` | none | session label and "Open session" |

The note type has one template, so each note has one card. If a user adds templates in Anki, all cards of the note are summed and shown as one entry. Legacy hand-written cards with pseudo node IDs group under their saved `nodeId` and name; they are not graph nodes (0.5.0 coverage design, "Card counts"). The graph is read only to mark a node "no longer in graph".

## 3. Signals, grouping, ordering and wording

### Per card

| Signal | Source | Rule |
| --- | --- | --- |
| Lapses | `cardsInfo.lapses` | lifetime count Anki keeps; summed over the note's cards |
| Recent failures | `getReviewsOfCards` | rows with `ease === 1` and `type` 1 (review) or 2 (relearning), `id` within the last 30 days (rolling, from the refresh time) |
| Leech | `notesInfo.tags` | contains `leech`, compared case-insensitively |
| Suspended | `cardsInfo.queue === -1` | context only; never a signal. Anki suspends leeches by default |
| Not reviewed | `cardsInfo.reps === 0` | no signal; counted in the node summary |

Again on a learning step (`type` 0) is not counted: a new card normally takes several. Filtered, manual and rescheduled entries (`type` 3 to 5) are not counted. These type meanings come from the add-on's `KINDS` list; Anki's own definition was not rechecked.

A card is "worth a look" if any of: leech tag, lapses at least 3, or at least 2 recent failures. These numbers are starting points with no evidence behind them (open decision 3). They sit in one constants object so they are easy to change. Anki's own leech default of 8 is later than the first threshold on purpose: the view is meant to surface a card earlier than Anki does.

### Per node

Group "worth a look" cards by `nodeId`. Per node show: card count in Anki, cards worth a look, total lapses, recent failures, last failure date (latest failing review `id`), leech count, and the session name(s) from the cards. Nodes with cards but no flagged ones collapse into one line, "N ideas with no flags", and nodes whose cards have never been reviewed are counted separately ("N not reviewed yet").

Ordering of flagged nodes: recent failures descending, then total lapses descending, then node name. Within a node the same keys apply to cards. This is a plain, explainable sort. It is not a ranking of how well the learner knows the idea.

### Wording

- Heading: "Cards worth a look". Not "weak spots" or "gaps" in the interface text. The feature ID stays FI-1.
- Row text states counts and dates only: "3 lapses on 2 cards. 2 Again presses in the last 30 days. Tagged leech in Anki."
- One standing note under the heading: "A missed card can mean the card is unclear, the idea needs practice, or an ordinary memory lapse. Check the card and its source before deciding."
- The view must not say "you don't understand", "gap", "weak" or "struggling with" about the idea. It must not sort by a score.
- Show the evidence beside each card: lapses, reps, recent failure dates, leech, suspended, deck, and the card's Front and Back as saved locally.
- Add per-card actions only for the user to inspect: "Show in Anki" (existing `show`) and "Open session" (`ctx.app.openSession(sessionId)`, SDK `sdk/src/core/plugins.d.ts:386`).

## 4. Opt-in, privacy, storage, refresh and errors

### Setting and privacy text

A single boolean, off by default, in Settings: "Read review results from Anki".

Text beside it:

> Anki Bridge can read how you did on the cards it sent: lapse counts, Again presses in the last 30 days, and the leech tag. It reads only notes of the type "LearnHarness Basic" that were sent to the paired Anki profile, and only when you press Refresh on the Cards worth a look page. Results stay in memory until you press Clear or close LearnHarness. They are not saved to disk, not sent to a model, and not shared. Nothing in Anki is changed: no scheduling, suspending, tagging or editing.

The backend refuses the read operation when the setting is off. Hiding the page is not the check.

### What is stored

Nothing is persisted except the boolean.

- Results live in memory in the backend service and are cleared on: Clear, setting turned off, re-pairing, URL or key change, and deactivation. The frontend keeps nothing between view mounts beyond asking the backend for the last result.
- No cache file and no new `state.json` fields besides the setting. Review data never goes into worker prompts, flags or logs.
- The setting is an optional key under `settings` (`weakSpots?: boolean`). 0.7.0 set the precedent for optional settings keys at schema 4 (`tagTemplate?` and `systemTags?`, `origin/feat/0.7.0-redesign:src/anki/state.ts:41-42` and validation at line 68). No schema bump and no migration are needed. A state file with the key opened by 0.6.1 still validates, because 0.6.1 checks only its own settings keys (`state.ts:67`). A later save by the older version may drop the key, which resets the setting to off.
- If a later iteration wants a persisted cache (for example last-refresh time only), that would be a state change needing coordination with other state work and a clear button. Not proposed.

### Refresh behaviour

- Refresh is a button. There is no timer, no read on startup, and no read when the page opens; the page shows "Not read yet" with the privacy line.
- One refresh at a time. A second press while one runs is ignored with a message. The refresh is abortable by plugin disable (the existing lifetime signal).
- It does not take the delivery writer fence, because it writes no state. This keeps sends and generation commits from waiting on a long read. It discards its result if the pairing changes while it runs (open decision 4 asks whether to use the fence like `presence` instead).
- Requests go in small batches. Proposed: 50 note IDs per `notesInfo`, 25 card IDs per `cardsInfo` (the heaviest, since 26.10.11.0 renders each card), 50 per `getReviewsOfCards`. The existing 10 s per-request timeout stays. A 300-card deck needs about 25 requests. Batch sizes are unmeasured guesses and should be tuned only against a fake plus, later, a throwaway profile.
- The view shows "Read at HH:MM" and the counts of cards read, skipped and missing.

### Error states

| Situation | Detection | Message and behaviour |
| --- | --- | --- |
| Setting off | backend check | "Turn on Read review results from Anki in Settings." No request. |
| Not paired, or URL differs from pairing | `destination` check | "Pair Anki Bridge with this URL and profile first." No request beyond the check. |
| Anki closed or AnkiConnect not running | `AnkiError` kind `refused` | "Anki isn't running or AnkiConnect isn't reachable." Keep the previous result, marked stale with its time. |
| Timeout, transport failure | `timeout`, `transport` | "Anki did not answer in time. Try again." Keep stale result. |
| Not AnkiConnect, key rejected | `not-anki-connect`, `key-rejected` | Reuse the existing connection messages. |
| No profile open | `getActiveProfile` null | "Open a profile in Anki." |
| Wrong profile | profile differs from pairing | "Open the paired profile "X" or re-pair in Settings." Clear the in-memory result. |
| Old build without profile identity | existing refusal in `getActiveProfile` error text | Existing upgrade text. |
| Build without review history | `api` error with text like "unsupported action" for `getReviewsOfCards` or `cardsInfo` | "This AnkiConnect build cannot return review history. Upgrade AnkiConnect." Show lapses only if `cardsInfo` worked. |
| Anki busy (sync, profile switch) | `api` error, add-on kind `busy` | "Anki is busy. Try again in a moment." |
| `staleCursor`, `notFound` mid-read | `api` error text | Retry the batch once, then show the error. |
| Note edited or field changed | `LH_ID` or note type mismatch | Counted under "changed in Anki"; excluded. |
| Note or card deleted | `{}` entry | Counted under "deleted in Anki"; excluded. Not written to local `presence`. |
| No sent cards | local filter | "No cards have been sent to this profile yet." |

The client's `validResult` (`client.ts:42-69`) returns true for unknown actions. Implementation adds cases for `cardsInfo` and `getReviewsOfCards` so a malformed reply from a non-AnkiConnect service on the port reports `not-anki-connect`.

## 5. UI placement on the 0.7.0 baseline

The 0.7.0 main page is three numbered steps: 1 Choose ideas, 2 Write cards, 3 Review and send (`origin/feat/0.7.0-redesign:src/main.ts:16-40`), with connection and note type tools in Settings only. Weak spots is a feedback loop, not a step before sending, so it should not be a fourth numbered step.

Proposal:

- A second plugin view, "Cards worth a look", registered with `ctx.registerView` beside the existing `bridge` view, opened from a second `registerAction` and `placeAction` (sidebar), and from step 3's "More" menu (`moreMenu`, `review-ui.ts:178`) as "See how sent cards are going". The menu item is disabled while the setting is off.
- The setting and privacy text go in Settings as a new `ab-panel` section titled "Review results" (same pattern as the Connection, Anki profile and Tags panels, `settings-ui.ts:41-77`), with a link or note pointing to the page.
- The page uses the 0.7.0 helpers: `button` (host `mountButton`), `status`, `pill`, `plural`, `RenderScope`, `confirmDialog` for Clear (`ui.ts`). Controls come from the host UI kit, layout from scoped `ab-` classes and host theme variables.
- Page layout: heading, privacy line, a Refresh button with the read time, then rows by node (name, pills for lapses, recent failures, leech; session names) that expand to cards with the evidence and the two buttons.
- No weak-spot pills in step 1's idea rows in v1. They would need data on every picker render, which breaks "read only on demand". If the user wants them later, show them only from the in-memory result of the last refresh and label them with its time (open decision 6).

Implementation of UI waits for PR #29 to merge. The backend and fake-AnkiConnect tests can be built before it.

## 6. Implementation plan

Order of work. Backend first, UI after the 0.7.0 baseline merges.

### Files

| File | Change |
| --- | --- |
| `src/anki/client.ts` | Add `validResult` cases for `cardsInfo` and `getReviewsOfCards`; extend the `notesInfo` case to accept a `profile` string if present. |
| `src/anki/review-reader.ts` (new) | `ReviewReader`: allowlist set, batching, shape checks, join checks, per-batch destination guard. The only code that calls Anki for this feature. |
| `src/weak-spots/signals.ts` (new) | Pure functions and constants: classify cards, group by node, sort, build the result type. No I/O, injectable `now`. |
| `src/weak-spots/service.ts` (new) | Backend operations `weakSpots` (refresh, returns the result), `weakSpotsLast` (returns the in-memory result without reading), `clearWeakSpots`. Checks the setting. Holds the in-memory result and single-flight flag. |
| `src/anki/delivery.ts` | Expose the existing private destination check (`destination()`, lines 122-132) for reuse without changing its behaviour; accept the `weakSpots` boolean in `settings` and expose it in `PublicSnapshot`. |
| `src/anki/state.ts` | Optional `settings.weakSpots?: boolean` and its validation. No schema bump. |
| `src/backend.ts` | Register the three operations. |
| `src/weak-spots-ui.ts` (new, after 0.7.0) | The "Cards worth a look" view. |
| `src/main.ts`, `src/settings-ui.ts`, `src/styles.css` (after 0.7.0) | Second view, action, "Review results" settings panel, styles. |
| `docs/plumbing-contract.md` and README | Document the new operations and the amended read rule (only after the decision). |

Shared-file risk: `state.ts` and `delivery.ts` are also edited by PR #29 (settings keys `tagTemplate` and `systemTags`). The overnight contract serialises state-touching work, so implement after #29 merges or rebase onto it.

### Tests (fake AnkiConnect)

Build one shared fake, `tests/fake-anki-connect.ts`, on the existing pattern: a Node `createServer` on port 0 on 127.0.0.1 (as in `tests/delivery.test.ts:30-69`; never 8765 or 8766). It holds in-memory notes, cards and a revlog and returns the real response shapes read from `legacy.py` above. Options: build variant (`26.10.11.0` rejects `fields`; `26.11.15.0` accepts it), active profile, refuse, delay, per-action error strings. It records every request and fails the test on any action outside the allowlist, so a regression that adds a write action is caught.

Cases:

- Allowlist: the reader throws on `suspend`, `answerCards`, `cardReviews`; a full refresh sends only the five actions.
- Join: LH_ID match, mismatched `LH_ID`, wrong `modelName`, note deleted (`{}`), card deleted, `cardsInfo.note` mismatch, multi-card note summed.
- Destination: unpaired, URL changed, null profile, wrong profile, profile switch between batches discards the result, `notesInfo.profile` mismatch, cards sent elsewhere never requested.
- Signals: boundary values (lapses 2/3, failures 1/2, window edges at 30 days using an injected clock), learning-step Agains not counted, leech tag case, suspended context only, `reps` 0.
- Grouping and order: two cards per node, tie breaks, legacy pseudo-node IDs, node missing from graph.
- Wording: snapshot test that the rendered text has none of "gap", "weak", "struggling", "don't understand".
- Setting: off refuses with no request; turning off or re-pairing clears memory; nothing written to `state.json` by a refresh (compare file bytes).
- Errors: refused, timeout (small `timeoutMs`), not AnkiConnect, key rejected, busy, "unsupported action" for review actions, `staleCursor` retry, malformed `getReviewsOfCards` body.
- Single-flight: second refresh while one runs.
- UI (after baseline): fake host tests like `tests/review-ui.test.ts`: opt-in off state, not-read-yet state, stale result, Clear confirm.

Checks before commit: `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`.

### How FI-2 and FI-3 would consume it

The `weakSpots` result is the shared interface:

```text
{ readAt, destination, windowDays, thresholds,
  nodes: [{ nodeId, nodeName, inGraph, sessions: [{ id, name }],
            totals: { lapses, recentFailures, leech, cards },
            cards: [{ lhId, noteId, cardId, lapses, reps, recentFailureDates,
                      leech, suspended, deck }] }],
  excluded: { changed, deleted, notReviewed } }
```

- FI-2 (practice handoff) takes node IDs the user ticks in this view. It must not read the result on its own or on a timer. It turns chosen nodes into practice focus using the current graph statement, not review data. If a later design wants to put counts into practice instructions, those go to a model, which this view's privacy text says they do not. That needs its own consent line. The spike must also settle FI-2's open questions about targeting one session and clearing stale focus.
- FI-3 (card repair) takes one card record. It already has local `front`, `back`, `sourceSnapshot` and the source node from the saved `Card` found by `lhId`. It drafts a new note and sends through the normal send flow. It never edits, suspends or deletes the old note; the user does that in Anki. If it needs the note's current Anki text, it does its own `notesInfo` read through the same reader. The result's card shape deliberately carries no card text, so review data and card text stay separate.
- FI-3 depends on FI-1 being merged. This note does not satisfy that dependency.

## 7. Open decisions for the user

1. Amend the plan's "Direction" row from "never reads ... review history" to a bounded read: opt-in, bridge-owned notes only, on demand, in memory. README gets a matching sentence. Without this, FI-1 should not be implemented.
2. Name and entry point: "Cards worth a look" as a second view (proposed) versus a fourth numbered step, versus a panel inside step 3.
3. Thresholds: 30-day window, 3 lapses, 2 recent failures, leech tag. All are guesses; no data supports them. Choose them, or make them settings.
4. Writer fence: read without the fence (proposed, so sends are not blocked) or inside `exclusive` like `presence`.
5. `cardsInfo` cost: accept full records on both builds (proposed) or probe for 26.11.15.0 and send `fields` there. The probe adds a capability check the add-on does not expose directly.
6. Whether idea rows in step 1 may show a pill from the last in-memory refresh.
7. Whether "Open session" should link only the card's saved session or also other sessions from `GraphSnapshot.nodeSessions`.
8. Whether a persisted last-refresh time is worth a state change. Proposed: no.

## Verified and unverified

Verified by reading code or docs (file and line cited above): the five actions exist on both builds; their request parameters and legacy response fields; that `cardsInfo` `fields` exists only on 26.11.15.0; that `cardReviews` creates a deck on 26.11.15.0 and `getLatestReviewID` creates one per its docs; that the underlying v1 methods are marked `read`; local join fields in `Card`; the existing destination guard; the 0.7.0 UI structure and optional-settings precedent; leech behaviour per the Anki manual.

Unverified: any behaviour on a running Anki or AnkiConnect; timing and batch sizes; meaning of review `type` and card `queue` values beyond the add-on's code; `getReviewsOfCards` behaviour for a deleted card on 26.10.11.0; whether the thresholds are useful; whether the UI reads well. No tests were added or run for this note because it contains no code.
