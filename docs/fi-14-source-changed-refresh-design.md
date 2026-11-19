# FI-14 source-changed refresh: design

Status: design note only. Nothing here is implemented, and no production code, tests, versions or state schema change with this note. Implementation waits for the 0.7.0 UI baseline (PR #29, unmerged) and for state-migration coordination (section 6).

Base: origin/main e98e1ca (v0.6.1). Line references are to that commit unless a path starts with `0.7.0:`, which means `origin/feat/0.7.0-redesign`, read-only and not a base for code.

## The idea

A node's statement changes after cards for it were sent. The plugin already marks the node "Source changed" (0.5.0). FI-14 adds one step: show the old and new statements beside the sent card, and offer to draft a replacement as a new note. The old Anki note is never edited, suspended, deleted or re-sent. The user decides what to do with it in Anki.

## Verified and assumed

Verified (read in code or host docs at the cited place):

- Every generated card keeps a frozen copy of the statement it was written from, including the text (`SourceSnapshot.statement`, `src/generation/types.ts:8-16`; copied onto each card at `src/generation/service.ts:134`).
- Coverage compares hashes of those snapshots with the current graph (`src/coverage/flow.ts:84-93`).
- The review screen already shows the frozen statement and a "source changed" line (`src/main.ts:428-433`), but not the current statement.
- Duplicate check on send is AnkiConnect's default: same `Front`, same deck, same note type (`src/anki/delivery.ts:250`).

Assumed (not tested, flagged where used):

- Unknown extra keys on cards survive a round trip through the state file. `validateState` checks named keys only (`src/anki/state.ts:67-76`) and `replace` clones and writes the whole value (`src/anki/state.ts:196-203`), so this looks true, but there is no test for it.
- A writer can usefully tell "statement changed, the old card is now wrong" from "statement was reworded, the old card is fine". This is a model judgement, unmeasured. The design never lets that judgement clear a warning on its own.

## 1. What is stored today for sent cards

Per card (`src/anki/state.ts:13-33`):

| Field | Present on | Meaning |
|---|---|---|
| `statementHash` | every card (`:17`) | For generated cards, SHA-256 of the statement at drafting. For hand-written cards, a hash of front and back (`src/anki/delivery.ts:196`), not a graph statement. |
| `sourceSnapshot` | generated cards only (`:31`, optional) | `{nodeId, name, statement, statementHash, sessionId, sessionName, source?}`. Holds the full statement text and the teacher passage. |
| `noteId`, `destination`, `deck`, `presence` | sent cards | Where the note went and whether it was last seen in Anki. |

Answer to "is the old statement text available": yes, for every card the generator wrote (0.3.0 onward, schema 2 and later), on the card itself. The hash alone is not what coverage keeps. Hand-written cards have no snapshot, no real node, and are outside this feature, matching the 0.5.0 rule that a legacy card with no snapshot never produces a changed warning (`docs/0.5.0-coverage-design.md`, "Card counts").

So nothing about the old statement needs storing going forward. What is new is only:

1. a link from a replacement to the old cards it replaces;
2. a "still accurate" confirmation bound to a statement hash;
3. refresh intent on the generation record, so a restart or retry keeps it.

Schema implication: all three are optional fields, so the schema stays at 4. Precedent: 0.7.0 added optional `tagTemplate` and `systemTags` to settings without a bump (`0.7.0:src/anki/state.ts:41-42`, validation at `:68`), and `sourceSnapshot`, `generationId`, `presence` are optional card fields today. A new schema version would only be needed for a new top-level collection (the node-level alternative in section 3.4).

| New field | Where | Shape | Validation |
|---|---|---|---|
| `replaces` | `Card` (the replacement) | `string[]`, LH_IDs of the old cards | each a UUID, no duplicates, not its own ID, at most 50 |
| `sourceConfirmed` | `Card` (the old sent card) | `{ statementHash: string; confirmedAt: string }` | 64-hex hash, parseable timestamp, only on non-dropped cards |
| `refreshTargets` | `Generation` | `{ nodeId: string; replaces: string[] }[]` | node IDs are in `nodeIds`, distinct, disjoint from `backfillNodeIds`; `replaces` as above |

Cards sent before this change need no migration. They have snapshots already, and absent optional fields mean "not replaced, not confirmed". A build without the feature loads the file, ignores the fields, and shows the plain warning again. That downgrade path is the assumption above about unknown keys.

## 2. Detection and states

Reuse the 0.5.0 states unchanged. `projectCoverage` already yields `source-changed` when a node has older-hash coverage and no current or unknown-currency coverage (`src/coverage/flow.ts:97-98`). Precedence stays: missing, then changed, then base label (`docs/0.5.0-coverage-design.md`, "Node states and precedence"). Do not add a new `CoverageState` value.

Add a derived block to `Coverage`, computed in the same function from the same loop:

```text
refresh: {
  stale: string[];        // LH_IDs of sent cards (paired destination) with an older trusted hash,
                          // not confirmed for the current hash, not covered by a replacement
  replacementWaiting: number; // non-dropped, unsent cards whose `replaces` names a stale card
}
```

Rules:

- A card is a stale candidate when it is `sent`, matches the paired destination (`:82`), has a snapshot for this node, and the snapshot hash differs from the graph hash (`:92`).
- `sourceConfirmed.statementHash` equal to the current hash removes it from `stale` and counts it as current for the changed test. So "still accurate" clears the node-level warning through the existing `current` counter, not through a second code path.
- A non-dropped replacement (draft, approved, sending or sent) naming it in `replaces` also removes it from `stale`. A waiting replacement is shown as "replacement waiting". Dropping the draft puts the card back in `stale`.
- Refresh is offered when `stale` is non-empty and the node is not missing, not dismissed, not generating, and has no unresolved delivery. This is the existing `selectable` rule (`:99`), so no new gate is needed.

Observed behaviour worth stating (it follows from `:91`, not from this design): any card at the current hash, even a draft, counts as `current` and clears the changed label. Today the warning therefore disappears as soon as a replacement draft exists, and comes back if it is dropped. The new `refresh` block keeps that and adds the "replacement waiting" detail, so the user does not see a bare "Sent" and forget the draft.

Partial cases: when a replacement covers one of two stale cards, the primary label becomes the base label (it has a current card) but `refresh.stale` still lists the other card. The UI shows a secondary line, "1 older card has not been checked", which is the same idea as the existing "older-source cards" count (`src/coverage-ui.ts:148`).

Out of scope, and why:

- Source missing (deleted or recreated IDs). A recreated node has a new ID and starts with no coverage; the old ID's history stays under "missing" (`docs/0.5.0-graph-identity.md`). There is no statement to compare and no trustworthy "new statement for the same idea", and a successful but empty graph read can mimic deletion. Offering replacement would turn a guess into a card. Revisit only if the user wants a "copy cards to a recreated node" tool, which is a different feature.
- Cards whose currency is unknown (no snapshot). They suppress the changed label by design (`:97`, `!unknownSourceCards`), so no refresh is offered for that node. Cost: a node with one legacy card and one stale generated card never shows the warning. Accepted; it is the existing, tested rule.
- Sent-elsewhere cards. They do not contribute to the changed test (`:82`).

## 3. Replacement flow

### 3.1 Selection

The user picks a changed idea in step 1 and chooses "Write a replacement" (placement in section 5). A dialog shows:

- old statement (from the snapshot of the stale cards) and current statement, side by side, as plain text with the host Markdown preview for maths;
- each stale sent card (kind, front, back) with a checkbox, all ticked by default;
- "Show in Anki" for the old notes (existing `show` operation, `src/anki/delivery.ts:286`, queries by `LH_ID`).

The ticked cards become the `replaces` list. Unticked stale cards stay stale and can be confirmed separately (3.4). The node is added to the picker selection with refresh intent, kept apart from backfill and ordinary "another angle" requests, the same way 0.5.0 keeps backfill intent (`docs/0.5.0-coverage-design.md`, "Picker and session flow").

The existing `preflight` input gains an optional `refreshTargets: [{ nodeId, cardIds }]`. It needs no model, and the user still sees the estimate and confirms, as in 0.3.0.

### 3.2 Generation input

Add an optional field to `WriterTarget` (`src/writer/types.ts`):

```text
refresh?: {
  previous: { statement: string; cards: ExistingCard[] }[];  // at most 2 groups, newest first
}
```

- `statement` is the old snapshot statement, `cards` the selected stale cards. Groups exist because a node can change twice with cards sent at each hash. More than two groups: keep the two newest and tell the user the rest stay unreplaced.
- The current `statement` field stays the new statement. Flag notes pass through unchanged (`flagNote`, `src/writer/input.ts:158`).
- `existingCards` holds the node's other non-dropped cards (current-hash drafts, unselected stale cards), still newest first, capped at 6 (`src/generation/service.ts:168`). Stale cards chosen for replacement move to `refresh`, so they are not listed twice.
- `trimToFit` copies the target with a spread (`src/writer/input.ts:189-196`), so `refresh` survives untouched and only counts toward size. A node that cannot fit with its refresh context is skipped with the existing "does not fit" message, never truncated, matching "nothing is truncated" in the card writer contract.
- Old statement and old cards are untrusted data like everything else in the input. The prompt's existing untrusted-JSON rule (`src/writer/prompt.ts:51`) already covers them.

Prompt rule (new, only present when a target has `refresh`): the old cards were written from the previous statement and may already be learned. Write cards that test the new statement. Do not repeat a stale card unchanged. If the change does not affect an old card, return zero cards with a `skipReason` saying why. The existing "write new angles, never repeats" rule (`src/writer/prompt.ts:47`) pulls the other way, so the refresh rule must say it overrides that rule for the refresh cards only.

### 3.3 Validation

Reuse `findProblems` (`src/writer/validate.ts:109-152`) with two changes for refresh targets:

- The duplicate-front check (`:138`) also covers the selected stale cards' fronts. Reason: a replacement with the same `Front` goes to the same note type, and if the user picks the same deck AnkiConnect rejects it as a duplicate (`src/anki/delivery.ts:250`). Rejecting at validation costs a worker retry but saves a send failure that the user could not fix without editing.
- Zero cards plus `skipReason` stays valid. The result is shown as "The writer judged the old cards still accurate: <reason>". It offers "Mark still accurate" but never applies it.

All other checks (kinds, answer leakage, name in front, Mermaid, math rendering, cap) are unchanged. The cap applies to the replacements per node, not per stale card.

### 3.4 Review and send

Replacement drafts are ordinary cards: new UUID (new `LH_ID`), same `nodeId`, snapshot at the new hash, status `draft`. They go through the existing edit, approve and send path with the same destination checks, the same note-type check, the same `sending` crash recovery by `LH_ID` search. Nothing about delivery changes.

Review shows, above the replacement card, the comparison block described in section 5. The old cards are read from `state.cards` by the IDs in `replaces`, so no new public field is needed beyond the current statement text (`sourceChanged` exists today, `src/anki/delivery.ts:88`; the current text is already in `sourceStatements`, `:83`).

Tags: same tags as any card (system tags plus the 0.7.0 template, editable at send, `0.7.0:src/anki/tags.ts`). Open decision D4 asks whether to add one extra tag.

Local link, no Anki edits: `replacement.replaces = [old LH_IDs]`. The Anki note fields are unchanged (`Source`, `LH_ID`, `LH_Node`, `src/anki/delivery.ts:242`). `LH_Node` is the same on old and new notes, so the user can find both in Anki with a `LH_Node` search. Whether `guiBrowse` finds a node ID with unusual characters this way is untested; the plugin's own "Show in Anki" uses `LH_ID` lists instead and can include both the old and the new IDs.

Apply step: in the single commit that stores a worker result (`src/generation/service.ts:128-138`), copy the generation's `refreshTargets[nodeId].replaces` onto each new card. Same atomic write as the drafts, so a restart cannot create unlinked replacements.

### 3.5 How the warning clears

Four ways, all derived or explicit, none touching Anki:

1. Replacement sent. The replacement is sent, current-hash, in the paired destination. The old cards leave `refresh.stale` because a non-dropped replacement names them. The old card is shown as "replaced" in sent history.
2. User confirms "still accurate". A command `confirmSourceAccurate { nodeId, statementHash, cardIds }` sets `sourceConfirmed = { statementHash: <current>, confirmedAt }` on each named stale card. It runs inside `delivery.exclusive`, rereads the graph, and rejects if the node is gone, the hash differs (same message as dismissal: "Source changed. Refresh before ..."), or a named card is not stale. It follows `dismissNode` (`src/coverage/service.ts:40-49`).
   - It is bound to the hash. If the statement changes again, `sourceConfirmed.statementHash` no longer matches and the card is stale again.
   - It is reversible: a sibling command clears the field. It rewrites no status, note ID or snapshot.
3. Replacement dropped. The warning returns, because nothing current remains.
4. Dismissal. A node with only stale sent history may be dismissed for the new statement (`docs/0.5.0-coverage-design.md`, "Dismissal data and actions"). That exists today and keeps working. Dismissal hides the refresh offer; Restore brings it back.

Alternative to per-card confirmation: a node-level `sourceChecks: { nodeId, statementHash, checkedAt }[]` collection beside `dismissals`. Simpler to explain ("I checked this idea against its new statement") but it needs a schema 5 and cannot cover one card of two. Recommended: per-card. See D2.

## 4. Edge cases

| Case | Behaviour |
|---|---|
| Several sent cards for one node | Dialog lists all stale cards. Writer sees the ticked ones. Cap per node still applies, so two stale cards may be replaced by one or two new cards. `replaces` is per generation target, not per card. |
| Partial replacement | Unticked cards stay in `refresh.stale`. The node can show a base label and "1 older card has not been checked". The user may confirm it, replace it later, or leave it. |
| Statement changes again before estimate | Preflight binds `sources` (`src/generation/service.ts:190`), so confirmation fails with the existing "inputs changed, estimate again" path. Stale-card eligibility is recomputed; cards confirmed for the older hash are stale again. |
| Statement changes again during generation | The worker's input is frozen. Drafts are written with snapshot hash H2 while the graph is at H3. Coverage counts them as older (H2 differs from H3), so the node stays changed, and the review block shows "written for an earlier version of this idea". The user can drop them or send them and refresh again. No automatic redraft. |
| Statement changes after replacement is sent | The replacement is now one of the stale sent cards. The same flow applies again. Both generations' cards can appear as stale groups, newest two shown to the writer (3.2). |
| Dismissed node | Not selectable (`:99`), and a current dismissal means no refresh offer. Restore first. A dismissal bound to an older hash expires and the node is changed again. |
| Sent to another destination | Those cards do not count (`:82`). If the user re-pairs to that destination, the node shows changed and refresh is offered there. If the user re-pairs between drafting and sending, the replacement still sends to whatever is paired and counts there; the review block warns that the old cards are in a different profile. |
| Old note deleted in Anki | `presence: "deleted"` still counts as sent (`:83`). Refresh is still offered. The dialog labels the card "deleted in Anki". The user may only want it to confirm and move on. |
| Generation interrupted, cancelled or failed | `refreshTargets` is persisted before any model call, like `backfillNodeIds` (`src/generation/service.ts:240`). Retry keeps intent for unfinished targets and rechecks that each named stale card is still stale; if not, it rejects with a "reselect" message, mirroring the backfill rule (`:154`). Cards already created stay. |
| Send interrupted | The replacement is `sending`, so it blocks more generation for that node (`unresolved`, `:86`). Startup reconciliation by `LH_ID` decides sent or failed. The old cards are never touched. |
| Replacement front equals an old front | Rejected by validation (3.3), or if the user edits it back, AnkiConnect rejects the send as a duplicate; the card shows the existing per-card error. |
| Writer skips ("still accurate") | Shown as a suggestion with "Mark still accurate". Without a click the node stays changed. |
| Old card was edited in Anki | Invisible to the plugin (one-way). The dialog shows what the plugin sent. The user's Anki edits win, as in the base design. |
| Graph read fails | Same as 0.5.0: stale view, refresh actions disabled, no state write. |

## 5. UI placement on the 0.7.0 baseline

The baseline is three numbered steps in `0.7.0:src/main.ts:10-31`: 1 choose ideas, 2 write cards, 3 review and send. Settings hold connection tools. FI-14 adds no step and no setting.

- Step 1, idea rows. A row already shows "Changed since carded" (`0.7.0:src/coverage-ui.ts:21`). Add a menu item to the row menu (`openMenu`, `:140`) when `refresh.stale` is non-empty: "Write a replacement card" and "These cards are still accurate". The row menu is the host `ctx.ui.openMenu`, already used for dismiss and restore. Menu-only is easy to miss, so also add "Changed since carded" to the scope select beside "No cards", with a count. No bulk refresh action: each node needs a look at its old and new statements, and bulk drafting of replacements is a lot of cards at once.
- Step 1, dialog. Use `ctx.ui.openDialog` through the same pattern as `confirmDialog` (`0.7.0:src/ui.ts:73-107`) with a custom body element. Two columns on wide screens, stacked on narrow: old statement, new statement, then the stale-card checklist. Buttons: "Write replacement" (adds the node to the selection with refresh intent, then the user continues in step 2), "Still accurate" (runs the confirm command), "Cancel".
- Step 2, estimate. No new control. The summary line gains "includes 1 replacement for 2 sent cards" so the cost is attributable. Estimate, model choice and confirmation are unchanged.
- Step 3, review. A replacement card gets a comparison block above its fields, built like the existing "Source idea" details (`0.7.0:src/review-ui.ts:297-299`) but open by default: "Idea then" and "Idea now", then the old card or cards (front and back, read only) with "Show in Anki". Notices use the existing `ab-card-warning` slot (`:257-258`). The stale-version notice from section 4 goes there too.
- Step 3, sent history. In "Sent cards" (`:358`), an old card with a replacement shows "Replaced by a newer card" and one with a confirmation shows "Still accurate for the current idea". No Anki call; both read local fields.

Host components only, no raw buttons; this follows the 0.7.0 finding that raw controls missed host styling (plan, "0.7.0 interface redesign").

## 6. Implementation plan

Do not start until PR #29 is merged and the owner of the state-schema queue confirms ordering (below). Files, in order:

1. `src/anki/state.ts`: add `replaces` and `sourceConfirmed` to `Card` and its validation. No version bump. Add to `src/generation/types.ts`: `refreshTargets` on `Generation` plus validation next to `backfillNodeIds` (`:68` area).
2. `src/coverage/flow.ts`: add the `refresh` block to `Coverage`; treat a card with `sourceConfirmed.statementHash === source.statementHash` as current at `:91`; keep the existing precedence. Pure, browser-safe, so the frontend uses the same projection.
3. `src/coverage/service.ts`: `confirmSourceAccurate` and `clearSourceConfirmation` commands, added to `COVERAGE_OPERATIONS`, same writer fence as dismissal.
4. `src/writer/types.ts`, `src/writer/input.ts`, `src/writer/prompt.ts`, `src/writer/validate.ts`: `refresh` field, trim rules, prompt rule, duplicate-front extension.
5. `src/generation/service.ts`: accept `refreshTargets` in `preflight`, validate and bind them, move stale cards from `existingCards` to `refresh`, persist on the generation, copy `replaces` at apply (`:128-138`), keep intent through `retryGeneration`.
6. `src/anki/delivery.ts`: public snapshot exposes the current statement for cards that have a `replaces` list (the text is already read at `:83`).
7. UI on the 0.7.0 layout: `coverage-ui.ts` (menu items, scope, dialog), `drafting-ui.ts` (pass refresh intent with the preflight call, summary line), `review-ui.ts` (comparison block, sent-history labels). Rebase on whatever the merged files look like; the line numbers here are the unmerged branch's.
8. `docs/`: a short contract note beside `generation-contract.md` for the new `preflight` input and commands. A 0.x verification doc after implementation.

State-migration coordination. This design adds only optional fields on `Card` and `Generation`, which is the lowest-conflict shape, but conflicts still exist:

- Other overnight ideas may also edit `validateState` and `migrateState` in `src/anki/state.ts` (FI-12 edit and drop stats and FI-10 recovery are the likely ones), and may bump the schema. If one of them lands first with a bump to 5, FI-14 should not add its own migration step. Its fields then need no migration code at all, only validators.
- Both FI-3 (card repair) and FI-14 draft a replacement beside an old card and send it as a new note. They should share the `replaces` link and the comparison block rather than invent two. FI-3 is blocked on FI-1 (plan, queue item 10), so FI-14 would define the link first. Decide the name now (D5) so FI-3 reuses it.
- `src/coverage/flow.ts` and `src/generation/service.ts` are touched by anything that changes backfill or selection rules. The contract says implementation items that change saved state run one at a time (plan, "Overnight run contract"). Rebase carefully; do not claim integration.

Fake-host tests (no model calls, no real Anki, per the contract; all use `tests/fake-host.ts`, the stub worker and a fake AnkiConnect):

State and projection:
1. Old state files with no new fields load unchanged; round trip keeps unknown optional fields; invalid `replaces`, `sourceConfirmed` and `refreshTargets` are refused without resetting the file.
2. Changed node with one sent card yields `refresh.stale` of that card; unknown-currency, sent-elsewhere and dropped cards never do.
3. Waiting replacement removes the card from `stale` and shows `replacementWaiting`; dropping it restores `stale`.
4. Sent replacement removes `stale`; a second statement change makes the replacement itself stale.
5. `sourceConfirmed` for the current hash clears the changed label; a changed hash makes it stale again.
6. Two stale cards, one replaced: base label plus one remaining stale card.
7. Dismissed, generating, unresolved and missing nodes: no refresh offer.

Writer:
8. `buildTarget` and `pack` carry `refresh`; `trimToFit` never removes it; a target too large with it is skipped, not trimmed.
9. Validation rejects a replacement front equal to a selected stale front; accepts zero cards with a `skipReason`; other rules unchanged.
10. The prompt contains the refresh rule only when a target has `refresh`.

Generation:
11. `preflight` with `refreshTargets` rejects non-stale cards, a node that is also a backfill target, and an unselected node; the binding changes when the stale set or the statement changes.
12. Apply copies `replaces` onto every new card in one commit with the result mark; replay does not duplicate.
13. Interrupted generation, restart and retry keep refresh intent and reject it if a stale card was replaced or confirmed meanwhile.
14. Statement changes during generation: drafts keep their old snapshot and the node stays changed.

Delivery:
15. A replacement sends as a new note with a new `LH_ID`; the fake AnkiConnect records no `updateNoteFields`, `deleteNotes`, `suspend` or similar call for the old note. Assert on the full call log.
16. Same-front replacement in the same deck gets the fake's duplicate error and shows it per card.
17. Crash during `sending`: reconciliation by `LH_ID` ends in sent or failed and the link survives.

UI (fake UI as in `tests/fake-ui.ts`):
18. Row menu shows the two actions only when stale cards exist; scope filter lists changed ideas.
19. Dialog shows old and new statement and the stale-card checklist; "Write replacement" selects the node with refresh intent; "Still accurate" calls the command once.
20. Review shows the comparison block for a replacement and the sent-history labels; stale-version notice after a second change.

Not tested by this plan: writer quality on refresh (needs a budgeted bench), real Anki duplicate behaviour, and the native desktop window.

## 7. Open decisions for the user

D1. Should refresh be offered only for sent cards (recommended), or also for waiting drafts at an old hash? Drafts can already be edited or dropped, so the extra flow adds little.

D2. How should "still accurate" be stored? Recommended: per card, an optional `sourceConfirmed` field, no schema bump, so one of two stale cards can be confirmed. Alternative: a node-level collection like dismissals, simpler wording, needs schema 5 and would conflict with other schema work.

D3. Should a replacement be allowed to keep the old `Front`? Recommended: no, reject at validation, because AnkiConnect rejects same-front notes in the same deck. The cost is that a change affecting only the back must reword the front. Alternative: allow it and let the send error say "duplicate".

D4. Add a system tag such as `learnharness::replacement` to replacement notes? Recommended: yes. It is the only marker visible in Anki and lets the user find replacements to compare against old notes. Cost: one more tag in the editable tag list, and a change to `src/anki/tags.ts`, which exists only on the 0.7.0 branch.

D5. Name of the link field. `replaces` is proposed. If FI-3 should share it, confirm now, and confirm that "repair" and "refresh" are one concept with two triggers (statement changed, many lapses).

D6. Should a "still accurate" confirmation expire when the idea changes again? Recommended: yes, it is bound to the hash (3.5). No other option is offered.

D7. Wording of the row action and dialog. "Write a replacement card" and "These cards are still accurate" are placeholders for copy review; the plan's A/B notes for 0.7.0 (one page or steps, idea rows with or without statements) may change where the dialog lives.

D8. Should the model's "old cards still accurate" skip auto-suggest the confirmation? Recommended: no. Show it, never apply it.
