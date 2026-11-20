# Manual generation contract (0.3.0)

This document records the 0.3.0 contract. For the current defaults, flags and state format, see [0.7.2 verification](0.7.2-verification.md) and the [README](../README.md).

All calls use `ctx.call`. In 0.3.0, no call silently selects a model and no session flags or coverage are implemented. Existing delivery operations remain available.

## Operations

| Operation | Input | Output |
| --- | --- | --- |
| `generationContext` | `{}` | `{nodes: [{id, name, statement}], catalog}`; catalog is the host's current model catalog |
| `generationSettings` | Partial `{cardsPerNode, enabledKinds, model}`, or `toggleKind: {kind, enabled}` instead of `enabledKinds` | Snapshot; cap is an integer 1–4, kinds are a nonempty distinct subset of `fact`, `equation`, `why`, `steps`, `apply`, `discriminate`; model is `{provider,id}`, or `null` for the host's cheap slot. `toggleKind` switches one kind against the saved set inside the mutation fence, so Write and Settings can't undo each other's changes; turning off the last kind is refused |
| `preflight` | `{nodeIds: string[]}` | Preflight described below; selected IDs must be distinct, present, 1–1000 nodes |
| `generate` | `{preflightId}` | Snapshot after durable acceptance, not completion |
| `generationStatus` | `{}` | Snapshot, including durable task states |
| `cancelGeneration` | `{id}` | Snapshot; completed task results are applied, unfinished tasks are cancelled, already created drafts remain |
| `retryGeneration` | `{id}` | New preflight for unfinished task nodes using the current settings, not the batch's frozen ones. Not a model call; confirm with `generate` |
| `drop` | `{ids: string[]}` | Snapshot; only unsent editable cards may be dropped, preserving their history |

Setting model to null clears the choice. The default cap is 2, with all four kinds enabled and no model selected. Model limits and costs may be null. Null limits use the writer's fixed budgets, not a fabricated limit; null cost produces no dollar estimate. Availability requires the selected model and its available provider in the catalog. No catalog defaults, slots or role pins select a model for this feature.

A preflight returns:

- `preflightId`, `nodeIds`, `nodeCount`, `maximumCards` (eligible targets times cap).
- `inputTokens`, `outputTokens` (approximate, including prompt/schema overhead), `estimatedCost` (USD or null).
- `model: {provider,id}`, `settings: {cardsPerNode,enabledKinds,model}`.
- `batches: [{nodeIds,inputTokens,outputAllowance}]`, `skipped: [{nodeId,reason}]`.

Preflights are ephemeral, bound to graph, source passages, current nondropped cards, settings and selected catalog entry. Changed inputs require a new preflight. At most 32 unconfirmed preflights are retained. Repeated confirmation of an accepted ID is idempotent, including after restart. Only one generation runs at a time. Worker calls use purpose `user`, 3 turns, a three-minute timeout, and the explicit reserved output allowance. Packed chunks start sequentially; no call starts until durable acceptance.

## Snapshot additions

Top-level `generationSettings` has the settings shape above. `generations` contains:

- `id` (the accepted preflight ID), `createdAt`, `nodeIds`, frozen `settings`, `skipped`.
- `status`: `running`, `completed`, `cancelled`, `interrupted`, `failed`. Once no task is pending or running, the batch takes the first that applies: `cancelled` if any task was cancelled, then `interrupted`, then `failed`, else `completed`.
- `tasks`: `{requestId, taskId?, status, input, sources, outputAllowance, result?, error?}`.
- Task status: `pending`, `running`, `applied`, `failed`, `cancelled`, `interrupted`. `applied` means a complete validated worker result was atomically applied. A result may legitimately contain zero cards with an explicit skip reason; consult `result.targets`.

Generated cards retain all existing delivery fields plus `generationId`, `requestId`, and `sourceSnapshot: {nodeId,name,statement,statementHash,sessionId,sessionName,source?}`. Hashes are SHA-256 of the frozen statement. The public card also exposes `sourceStatement` (frozen statement), `sourceChanged` (current statement differs), and `sourceMissing` (node absent). These indicators are computed on each snapshot; missing does not also mean changed. Old hand-written cards have no snapshot/indicators. No graph data is modified.

## Persistence and lifecycle

Schema 1 migrates to schema 2 through the existing locked, atomic `StateStore`, preserving settings, pairing and cards. Unsupported or malformed data is refused without resetting. Schema 6 (#37, #38) drops the constant-values toggle and `compose` from the top-level settings, falling back to `fact` and `equation` if no kind is left; generation history keeps its frozen settings and inputs, and `compose` cards stay readable. Persisted applied results get a shape check (targets from the input, card fields and core kinds). Writer content rules run once, at apply time, so a later stricter rule never makes old state unreadable.

Delivery and generation share one mutation fence. Background work (activation recovery, the generation driver) waits for it. A UI call waits out a background hold, but still gets the busy error if another UI operation holds the fence, which keeps double-clicked sends from running twice. Worker partial/streaming text is never a draft.

If the driver fails unexpectedly, for example on a storage error, it reports a recovery error, cancels any running worker and marks the batch's open tasks `interrupted`. A batch is never left `running` without a driver, because that would block new generations.

The authoritative complete result, its request's `applied` status, and all new draft UUIDs commit together in one snapshot. Replay cannot recreate dropped or edited drafts. Worker identity and frozen input must match the saved request. On activation, pending requests are compared with host worker history, including requests whose acceptance was saved before their task ID. Finished results are applied; all others become interrupted and require a new preflight to retry. Activation never starts model work.

Disable unregisters handlers and the worker definition, aborts waiters and waits for plugin callbacks before closing the store. Unfinished persisted requests are recovered next activation. Finished host results survive disable and are applied on the next activation if not yet committed. No model calls or live Anki access are needed to test this flow.

## Seams for 0.4.0

These match points 1 and 2 of 0.4.0's `docs/session-contract.md`.

- `mountDrafting(...)` returns `{select(nodeIds), dispose()}`. `select` replaces the drafting selection and discards any visible estimate. It never starts generation; the learner still estimates and confirms. The main view keeps the handle as `draftingPanel`, so a session panel's `onDraft({sessionId, nodeIds})` can call `draftingPanel.select(nodeIds)`.
- `GenerationService.flagNotes?: () => Map<nodeId, note>`. When set, `prepare` passes each note to the writer as `flagNote`. Notes are part of the prompt, so changing one makes an outstanding preflight stale. 0.4.0 sets it from `SessionService.flagNotes()` in `backend.ts`.
- `exclusive` and `save` are public on both branches, but the 0.4.0 contract's "same text, no conflict" assumption no longer holds: review changed `exclusive` here. The second argument is now `background` instead of `wait`, and a `busyOwner` field lets user calls wait out background commits while still failing fast on another user operation. 0.4.0's `exclusive(op, true)` for flags still means "wait for the fence", so its call sites need no change. Expect a conflict in `delivery.ts` on rebase (the `exclusive` body, plus `snapshot`/`PublicSnapshot` and the new `drop` operation). Keep this branch's version and re-add nothing from 0.4.0's copy.
- 0.3.0 takes state schema 2. Flags become schema 3.
