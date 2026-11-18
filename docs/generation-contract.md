# Manual generation contract (0.3.0)

All calls use `ctx.call`. No call silently selects a model. No session flags or coverage are implemented. Existing delivery operations remain available.

## Operations

| Operation | Input | Output |
| --- | --- | --- |
| `generationContext` | `{}` | `{nodes: [{id, name, statement}], catalog}`; catalog is the host's current model catalog |
| `generationSettings` | Partial `{cardsPerNode, enabledKinds, model}` | Snapshot; cap is an integer 1–4, kinds are a nonempty distinct subset of `recall`, `why`, `compose`, `discriminate`; model is `{provider,id}` or `null` |
| `preflight` | `{nodeIds: string[]}` | Preflight described below; selected IDs must be distinct, present, 1–1000 nodes |
| `generate` | `{preflightId}` | Snapshot after durable acceptance, not completion |
| `generationStatus` | `{}` | Snapshot, including durable task states |
| `cancelGeneration` | `{id}` | Snapshot; completed task results are applied, unfinished tasks are cancelled, already created drafts remain |
| `retryGeneration` | `{id}` | New preflight for unfinished task nodes, not an automatic model call; confirm with `generate` |
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
- `status`: `running`, `completed`, `cancelled`, `interrupted`, `failed`.
- `tasks`: `{requestId, taskId?, status, input, sources, outputAllowance, result?, error?}`.
- Task status: `pending`, `running`, `applied`, `failed`, `cancelled`, `interrupted`. `applied` means a complete validated worker result was atomically applied. A result may legitimately contain zero cards with an explicit skip reason; consult `result.targets`.

Generated cards retain all existing delivery fields plus `generationId`, `requestId`, and `sourceSnapshot: {nodeId,name,statement,statementHash,sessionId,sessionName,source?}`. Hashes are SHA-256 of the frozen statement. The public card also exposes `sourceStatement` (frozen statement), `sourceChanged` (current statement differs), and `sourceMissing` (node absent). These indicators are computed on each snapshot; missing does not also mean changed. Old hand-written cards have no snapshot/indicators. No graph data is modified.

## Persistence and lifecycle

Schema 1 migrates to schema 2 through the existing locked, atomic `StateStore`, preserving settings, pairing and cards. Unsupported or malformed data is refused without resetting. Delivery and generation share the delivery service's mutation fence; background result applications wait for the fence, while competing UI mutations receive the existing busy error. Worker partial/streaming text is never a draft.

The authoritative complete result, its request's `applied` status, and all new draft UUIDs commit together in one snapshot. Replay cannot recreate dropped or edited drafts. Worker identity and frozen input must match the saved request. On activation, pending requests are compared with host worker history, including requests whose acceptance was saved before their task ID. Finished results are applied; all others become interrupted and require a new preflight to retry. Activation never starts model work.

Disable unregisters handlers and the worker definition, aborts waiters and waits for plugin callbacks before closing the store. Unfinished persisted requests are recovered next activation. Finished host results survive disable and are applied on the next activation if not yet committed. No model calls or live Anki access are needed to test this flow.
