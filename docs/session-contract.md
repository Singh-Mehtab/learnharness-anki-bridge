# Session flow contract (0.4.0)

0.4.0 adds flags on teaching replies, the "waiting for extraction" state and session-based node selection. It uses the drafting panel and generation service merged in 0.3.0, PR #5 at `e88f89d`. This page records the boundary between them.

## Backend operations

The frontend calls these through `ctx.call`. Mutations go through the delivery service's writer fence, the same one 0.3.0 generation uses.

| Operation | Input | Result |
| --- | --- | --- |
| `flag` | `{sessionId, messageIds, note?}` | `FlagView` for the stored flag, plus `created` (false when an existing flag was updated) |
| `unflag` | `{id}` | `{removed}` |
| `sessions` | `{}` | `{sessions: SessionSummary[], unresolved: FlagView[]}` |
| `sessionFlow` | `{sessionId}` | `{session, nodes, flags, cardsPerNode, paired}` |

`flag` reads the saved session and checks that every message ID is a saved assistant message with learner-facing prose. Learner messages, tool-only messages and streamed or optimistic messages without a saved ID are refused. Practice sessions are refused. A flag that overlaps an existing flag's messages updates that flag rather than adding a second one. An omitted `note` keeps the existing note, and `note: ""` clears it. Notes are one line of at most 300 characters.

A `FlagView` adds `status` and `nodeIds` to the stored flag:

| Status | Meaning |
| --- | --- |
| `matched` | At least one graph node has provenance `{chatId: sessionId, messageId}` for a flagged message. |
| `waiting` | No node yet, and LearnHarness hasn't recorded the message in `coverage.jsonl`. |
| `no-nodes` | Extraction covered every flagged message and anchored no node to them. |
| `missing` | The session, or one of the flagged messages, is gone from the saved record. |

Flags are never removed automatically. Only `unflag` removes one.

`no-nodes` depends on recomputing the host's coverage fingerprint (LearnHarness 0.6.1 `src/core/coverage.ts`). A test pins the hash against the host's own code. If a later host changes the fingerprint, nothing matches and flags show `waiting`, which is the safe direction.

`sessions` lists teaching sessions, newest first, with node and flag counts. `unresolved` holds every flag that isn't `matched`, including flags on deleted sessions, so none disappear from view.

`sessionFlow` returns the session's nodes in transcript order: a node is in the session when `nodeSessions[nodeId]` includes the session or its provenance names it. Each node carries `flagged`, its flag notes and card counts. `waiting` counts unsent, non-dropped cards. `sent` counts cards sent to the currently paired destination. `sentElsewhere` counts cards sent to another URL or profile, which don't count as coverage.

## What "latest teacher reply" means

One reply can span several assistant messages when the teacher calls tools between them, and extraction anchors nodes to each message separately. The flag action therefore takes every assistant message with prose after the last learner message. If the newest learner message has no prose reply, it uses the previous turn. Prose means text blocks and delivered `send_to_user` calls, the same selection the host's extractor reads. The plan described a single `messageId`; flags store `messageIds` for this reason.

The action is disabled unless the session view reports `status === "ready"` and `reconciliation === "ready"`, so it never reads streamed content.

## Frontend

- **Flag for Anki** sits in the teaching top bar. A click opens a dialog with the reply excerpt and an optional note. The shortcut, default `mod+shift+a`, flags at once and shows a confirmation that closes after 3.5 seconds unless the learner clicks or types in it. The confirmation offers a note field, and Undo when this press created the flag. Pressing the shortcut on an already flagged reply says so and never offers to undo the earlier flag.
- **Make cards** sits in the teaching top bar and opens the Anki Bridge view on that session.
- The view's session panel lists flags and their status, with Refresh and Remove flag. Unresolved flags from other sessions appear above it. The node list ticks flagged nodes by default and greys nodes that already have cards. "Select all uncarded" ticks nodes with no unsent or paired-sent cards.
- Saved generation settings and card mutations refresh session estimates and card counts through `SessionPanelHandle.refresh()`. A refresh requested during a session operation is deferred rather than dropped. Manual node choices survive refresh.
- Extraction has no completion event. While any flag is `waiting`, the panel re-checks one second after an `activity-changed` or `turn-settled` app event. Refresh is the reliable path.

## State

Flags live in the one `state.json`, validated with the rest of the snapshot:

```ts
interface Flag { id: string; sessionId: string; sessionTitle: string; messageIds: string[]; note: string; flaggedAt: string }
```

No two flags may claim the same `(sessionId, messageId)`. The cap is 5,000 flags and 50 message IDs per flag.

State schema is 3. `migrateState` chains the 0.3.0 schema 1 → 2 step, which adds generation settings and batches, with a schema 2 → 3 step adding `flags: []`. Generation settings, completed results, cards and source snapshots are preserved. Validation requires schema 3 and keeps both generation and flag checks. `StateStore.open` writes the migrated snapshot atomically only after validation passes. Malformed and future-version files are refused and left unchanged.

The earlier, unmerged 0.4.0 development branch also called its flags-only layout schema 2. That layout was used only in scratch data and is not a supported migration source. Schema 2 here means the layout shipped by merged 0.3.0.

## Integration with 0.3.0

Both services now run together. The integration follows these four ownership boundaries.

1. **Opening drafting with a session and node IDs.** The session panel calls `onDraft({sessionId, nodeIds})`, with `nodeIds` in display order. `main.ts` awaits `draftingPanel.select(nodeIds)`, then scrolls to and focuses the draft panel. This replaces the selection and clears an old estimate without generating. The learner then estimates and confirms through the existing generation operations.
2. **Flag notes reaching the writer.** `backend.ts` sets `generation.flagNotes = () => session.flagNotes()`. The map joins several notes with " / ". Generation preparation passes each note as the existing writer extra `flagNote`. Notes enter the exact-prompt digest, so changing one invalidates an outstanding estimate. The session panel reads `store.snapshot().generationSettings.cardsPerNode` for its cap.
3. **Persistence.** Flags go through `DeliveryService.exclusive(operation, true)` and `DeliveryService.save`, the same fence and writer as generation. There is no second state file. `delivery.ts` is unchanged from merged 0.3.0. Its second argument is `background`, not the old `wait` parameter. Flags wait for the fence; user delivery calls wait out background commits but refuse a second user operation.
4. **Ownership.** 0.3.0 owns generation operations, the generation schema fields and the draft screen. 0.4.0 owns the `flags` field, the four operations above and the two top-bar actions. Backend handler registration is additive in `src/backend.ts`; disable unregisters both services' handlers and closes both services.

PR #4 is rebased onto merged 0.3.0 and remains unmerged for review.
