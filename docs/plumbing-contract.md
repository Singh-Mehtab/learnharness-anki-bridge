# Plumbing contract for 0.3.0

0.2.0 handles hand-written drafts and delivery. It does not read the graph, call a model or implement coverage. This document describes the boundary that manual drafting can use next.

## Backend operations

The frontend calls these names through `ctx.call`. Inputs and outputs are JSON-compatible. All mutations are serialized by the backend, and competing operations fail with a busy message rather than racing a send.

| Operation | Input | Result |
| --- | --- | --- |
| `snapshot` | none | Public state snapshot |
| `settings` | optional `url`, `apiKey` | Snapshot; omit key to keep it, use empty string to clear it |
| `connection` | none | `{profile, decks}`; profile can be null |
| `pair` | `{confirmed: true}` | Snapshot with durable URL/profile pairing |
| `draft` | `{front, back, extra?, kind?, nodeId?, nodeName?, sessionId?, sessionName?, statementHash?}` | Snapshot with a new draft and durable UUID |
| `edit` | `{id, front, back, extra?}` | Snapshot; resets approval |
| `approve` | `{ids}` | Snapshot; explicit user approval is required |
| `send` | `{ids, deck}` | Snapshot; accepts approved/failed cards, skips notes already sent |
| `reconcile` | none | Snapshot after checking interrupted deliveries by UUID |
| `presence` | none | Snapshot with sent notes marked present/deleted |
| `show` | `{ids}` | Opens the paired notes in Anki's browser |
| `repairFields` | none | Adds missing fields only; never reorders fields or replaces templates |
| `updateStyling` | `{confirmed: true}` | Replaces owned styling/templates after the UI's explicit warning |

A snapshot contains `settings: {url, lastDeck, hasApiKey}`, `destination`, `cards` and an optional activation `recoveryError`. It never returns the stored API key. Each card records its source identifiers, kind, Markdown content, status, target deck, destination and Anki note ID when available.

## State and delivery rules

`StateStore` owns one versioned `state.json` in the plugin data directory. Writes use a private temporary file, file sync, atomic rename and directory sync. A process lock rejects another active backend. A dead process's lock is reclaimed at startup; unreadable locks and unsupported snapshots are refused without resetting data.

`DeliveryService` persists draft UUIDs, approvals and the paired destination before sending. It sends one card at a time. The `sending` snapshot commits before `addNote`; a returned Anki ID commits before the next card. Transport failures remain unresolved until reconciliation. Restart reconciliation checks the original URL/profile before searching `LH_ID`.

Editing an unsent card returns it to `draft`. Sent cards cannot be edited through the bridge, even if Anki deleted the note. A failed card retains approval for retry. Re-pairing does not erase sent history and cannot bypass an unresolved delivery at another destination.

Only the delivery service sends notes. No operation updates/deletes existing Anki notes or accesses scheduling. Coverage must count sent cards only when their recorded destination matches the current pairing.

## Integration work still needed

0.3.0 should supply real source metadata in `draft` calls and display the review UI before `approve`. The worker result and its applied request ID must be persisted in one transaction when batching is added. Repeated `draft` calls alone do not provide exactly-once application of a worker result.

Generation batches, flags, dismissal and graph coverage are not part of this state format yet. Extend it with a migration and tests; do not replace the snapshot with an independent second writer.
