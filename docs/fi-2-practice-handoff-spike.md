# FI-2 practice handoff: research spike

Status: research only. No plugin code, no LearnHarness server run, no model calls, no real Anki, no real LearnHarness data.

Question: can the plugin turn selected weak spots (FI-1) into practice focus for one user-started practice session, without changing every practice turn?

## Answer

Not with `registerInstructions`. Instruction text is a fixed string and the host filters it by agent kind only, so it can never be limited to one practice session. A plugin can still get focus into one session by other routes. Two are viable, and one needs no plugin code:

1. **Pick-based handoff (no plugin code).** The home page already starts a practice session from picked graph nodes. The picks become the session's first message and carry node ids that the practice agent tags its problems with. The plugin only has to show the user which nodes to pick. This is scoped by construction, has no stale state, and adds nothing to the prompt of any other session.
2. **One-shot text interceptor (small prototype).** A frontend `registerSubmissionInterceptor` hook can prepend a short focus note to the opening message of a new practice session, then disarm itself when the host acknowledges the send. Scoped by construction, self-clearing, no model-mediated step. Cost: the note becomes part of the learner's saved message.

A per-session tool (`registerTools` keyed on chat id) works but is model-mediated, so it is the fallback, not the first choice.

## Conventions and evidence

Host paths are in the LearnHarness repo at tag v0.6.1 (`src/...`, `docs/...`, `components/...`, `app/...`). `file:line` refers to that tag. "Verified" means I read the code or doc at that line. "Assumption" means I did not verify it. Unmerged upstream PRs #728 and #709 were read only and nothing here depends on them.

## 1. Instruction text: static or per turn?

Verified:

| Fact | Evidence |
| --- | --- |
| Registration stores a fixed string and an agent-kind set. There is no chat id, no callback, no function-valued text. | `src/server/plugin-host.ts:54`, `:251-257`; type `src/core/plugins.ts:118-121` (`agents`, `text: string`) |
| The text must be a nonempty string at registration time. | `plugin-host.ts:254` |
| Each turn takes one snapshot of the registered lists and selects instructions with `item.agents.has(turn.agent)`. Nothing else is consulted. | `plugin-host.ts:410-415`, `:419` |
| The per-turn context holds only `{chatId, agent}`, and it reaches tool factories, not instructions. | `plugin-host.ts:407`, `:424`; `src/core/plugins.ts:122-125` |
| Text is not evaluated per turn, but the registration set is read per turn. A plugin can change what the next turn sees by calling the returned unregister handle and registering again. | `plugin-host.ts:257` (handle), `:410-415` (snapshot); `docs/plugin-authoring.md:545` ("Unregister affects future turns"); `src/core/plugins.ts:161-163` |
| A registration made during turn N is visible from turn N+1 and does not change turn N's snapshot. | `tests/plugin-contributions.test.ts:102-120` |
| The system prompt is the built-in prompt plus the instruction texts, joined with `---`. The agent is rebuilt on every POST, so the prompt is recomposed each turn. | `src/agent/teacher-agent.ts:236-238`; rebuild: `teacher-agent.ts:34-37`, `src/server/chat-handler.ts:652-655`, `:734-737` |
| Instructions never appear as transcript messages. | `docs/plugin-authoring.md:536` |
| Disable and restart clear all registrations. A restarted backend must register again. | `plugin-host.ts:209-216` |
| The only shipped practice instruction (core coding-questions plugin) is registered once at activation and unregistered at cleanup. | `plugins/coding-questions/src/backend.ts:32-35` |

Consequences:

- The text cannot see the session id. A plugin could keep a map from session id to focus, but nothing hands that map to the instruction text.
- Unregistering and re-registering from a backend operation changes the prompt of every later practice turn in every practice session, including sessions that are already running and sessions the user never wanted to focus. This is the "unconditional instructions on every practice turn" case the brief calls wrong.
- Assumption: changing the system prompt between turns invalidates provider prompt caching for the session. Not verified and provider specific.

## 2. Mechanisms for session-scoped focus

How the plugin learns the session id (verified): the frontend session action context has `sessionId` and `kind` (`src/core/plugins.ts:208-211`), and the submission target has `sessionId` and `sessionKind` (`src/core/plugin-submissions.ts:48-49`). Both are the chat id: `components/chat.tsx:347`, `:1576`; creation in `app/api/chats/route.ts:28`, `:68`. The tool factory's `chatId` is the same value (`chat-handler.ts:723`, `teacher-agent.ts:229`). The frontend reaches backend state through `ctx.call` (`src/core/plugins.ts:332`) and a backend `handle` (`plugins.ts:179`, `plugin-host.ts:297`).

What cannot be done (verified): a plugin cannot create or start a session or send a message. `app.openSession(id)` navigates only (`plugins.ts:358-359`; `docs/plugin-authoring.md:259-261`). There is no graph-selection access (`plugin-authoring.md:260-261`). So the user always starts the session and sends the opening message.

### A. Pick-based handoff (native graph picks)

- How it works: the home page practice mode lets the user pick nodes. Creation posts `graphContext.propositions` (`components/home.tsx:150-158`; `components/new-session.tsx:62`). The server writes a graph-context marker as message 0, with each pick's id, name, statement and the chains among them (`app/api/chats/route.ts:22-68`; `src/core/native-messages.ts:322-340`). The practice prompt calls picks the primary path and tells the model to pose from them immediately (`src/agent/prompts/practice/00-base.md:9-12`). `problem` targets are normalized to the canonical node ids (`src/agent/tools/practice.ts:99-114`).
- Plugin role: show weak-spot node names in the FI-1 view with an instruction such as "start a Practice session and pick these". No hook, no backend state.
- Scope: this session only. Nothing is registered anywhere else.
- Clearing: nothing to clear. The marker lives in that session's history, as with any pick.
- Failure modes: the user must find and pick the nodes by hand, up to 64 (`route.ts:60`). The plugin cannot preselect them. The picker's usability for many nodes is not verified.
- Extra model step: none. No prompt change in any other session.
- Bonus: the session's `problem` calls carry the picked node ids as targets, which gives FI-1 and FI-17 a join key back to Anki's `LH_Node` field (see section 4).

### B. One-shot text interceptor (frontend)

- How it works: `registerSubmissionInterceptor` runs on every text send, including the opening message, before the POST (`docs/plugin-session-extension-contract.md:103-127`; `components/chat.tsx:805-820`, `:823-848`). The hook receives `{type: "text", content: {text, images}}` plus a context that carries `sessionId`, `sessionKind` and read-only `messages` (`docs/plugin-session-extension-contract.md:24-26`, `:46-47`, `:62-66`; `src/core/plugin-submissions.ts:49`, `:59`). It may return a replacement of the same type, or nothing to pass through (`docs/plugin-session-extension-contract.md:92-94`).
- Design: the user arms a focus in the plugin (node ids, names and statements, plus an optional note). The hook acts only when `sessionKind` is `practice` and `context.messages` has no learner message yet. It prepends a short bracketed block, then returns. `context.onAccepted` (`docs/plugin-session-extension-contract.md:68-73`) disarms it once the host acknowledges the POST.
- Scope: the opening message of the session the user was in when they sent it. The check on kind and empty history guards against arming leaking into an existing session.
- Clearing: on acknowledged acceptance, on explicit disarm, on a time limit chosen by the user (decision 3), and when the plugin is disabled. Lost acknowledgements never fire `onAccepted`, so the arm survives a failed send and the retry carries the note (`docs/plugin-session-extension-contract.md:70-71`).
- Failure modes:
  - A throw or invalid return blocks the user's message with "Could not prepare submission" (`docs/plugin-session-extension-contract.md:92-93`, `:128`). The hook must be total: catch everything and return nothing on any doubt.
  - The note is saved as the learner's own message text, so it is visible in the transcript and counts toward context. Assumption: it renders as a normal user message. The host's own session context marker uses a bracket convention for exactly this reason (`native-messages.ts:329-334`), so copy that style.
  - Only the window with the plugin frontend active can intercept. A session started elsewhere gets no note.
  - Assumption: the arm must live in plugin data to survive a window reload, and the frontend and backend must agree on it.
- Extra model step: none. The model sees one longer opening message. No tool, no instruction change, other sessions untouched.

### C. Practice-agent tool keyed on the session id (`registerTools`)

- How it works: `create({chatId, agent})` runs every turn for the matching agent kind, synchronously, on a fresh snapshot (`plugin-host.ts:424-428`; `src/core/plugins.ts:127-132`; `plugin-authoring.md:534-535`). A factory can return `[]` for sessions with no binding, so unbound sessions pay nothing. A top-bar action placed with `sessions: ["practice"]` (`plugins.ts:233-235`; `plugin-authoring.md:263-273`) reads `context.sessionId` and calls a backend `bind` operation. The factory then returns one tool, for example `anki_bridge_focus`, only for bound chat ids. Its result gives the model the focus text.
- Clearing: explicit action, a time limit, or when `getSession(id)` returns null for a deleted chat (`plugins.ts:78`). Practice sessions have no "finished" event, and they can be resumed later, so without a time limit the binding stays for the life of the session. Events available: `turn-started`, `turn-settled`, `chats-changed`, `record-changed` (`src/core/events.ts:10-38`). None says a session ended.
- Failure modes:
  - Model-mediated. The model has to decide to call the tool. Built-in tool descriptions here carry mechanics only and leave method to the prompt (`practice.ts:11-14`), so a description cannot be relied on to instruct.
  - A factory that throws, returns a non-array, or collides on a name removes the whole package's contribution for that turn, including its instructions (`plugin-host.ts:402`, `:428`, `:432`, `:497-505`).
  - The tool result is saved in the transcript, so later turns see it until compaction. How compaction treats plugin tool results was not verified.
  - Tool names must avoid the reserved set (`teacher-agent.ts:61-64`).
- Extra model step: yes, on the bound session. At least one tool call on the first turn, more if the model re-reads. Zero on unbound sessions. The tool definition adds tokens to every turn of the bound session.
- Variant C2, putting the focus text in the tool `description` so no call is needed: it evaluates per turn, but it uses a description as an instruction. That is undocumented and provider dependent. Not recommended.

### D. Dynamic `registerInstructions` toggled by a backend operation

- Feasible mechanically (section 1) but plugin-wide, not per session. It could be made conditional only by telling the model "apply this only if the transcript contains a marker", which costs prompt tokens on every practice turn and relies on the model reading the condition. Rejected for the reason in the brief.
- Precedent, for information only: unmerged #709 re-registers its instructions when its settings change, with a comment that changes apply from the next turn (diff of `plugins/listening/src/backend.ts`, around lines 3203-3217 of `gh pr diff 709`). That shows the pattern, not a per-session scope.

### E. View context only

`context.view` is read-only and cannot write into a session (`plugin-authoring.md:285-292`). It tells the plugin about a session (messages, `phase: "practice"`, `composer.text`, `status`) but gives no way to inject focus. Useful as a guard for B and C, not as a mechanism.

### Comparison

| | Scoped to one session | Cleared by | Model-mediated step | Other sessions affected | Needs plugin code |
| --- | --- | --- | --- | --- | --- |
| A. Picks | Yes, by construction | Nothing to clear | No | No | No |
| B. Interceptor | Yes, by kind and empty history | Accepted send, disarm, time limit | No | No | Frontend hook and a small store |
| C. Tool | Yes, by chat id in the factory | Explicit, time limit, chat deleted | Yes | No, but a factory error drops the package's turn contribution | Backend factory, action, operations |
| D. Instructions | No | Unregister | No | Every practice session | Backend |

## 3. What the practice agent sees

Verified:

- System prompt: the practice prompt only (`src/agent/prompts/practice/00-base.md`, `10-doctrine.md`), then plugin instructions for `practice`, joined with `---` (`teacher-agent.ts:236-238`). Practice composes only its own directory, no teaching segments (`teacher-agent.ts:55-56`).
- Tools: `problem`, `conclude`, `read`, `ls`, `find`, `grep`, plus `research` and `pdf` jobs and the graph readers `list_sessions`, `list_propositions` when the settings gate allows (`src/agent/tools/practice.ts:208-218`; `00-base.md:33`). Then plugin tools, plugin question ledger tools and plugin problem tools (`teacher-agent.ts:251`).
- Messages: the saved session record. For a pick-started session, message 0 is the graph-context marker, flattened to a user-role message (`native-messages.ts:322-340`). Then learner text, tool calls, thinking traces and answer commits, labelled (`practice.ts:85-88`), and conclude results.
- Instructions are rebuilt every turn (section 1). The agent is stateless between POSTs and rebuilt from the record (`teacher-agent.ts:34-37`).
- The practice agent can read the map on demand through the graph readers (`practice.ts:217`; enabled at `chat-handler.ts:756`), so a focus note naming nodes does not widen what it can read, when that setting is on.

Not verified:

- Whether the model sees learner-visible text differently from the saved text for a transformed message. Chat code sends `prepared.content.text` (`components/chat.tsx:819`), so the transformed text is what is posted.
- How compaction summarizes an opening message or a plugin tool result.

Privacy: anything in the focus note goes to the model provider the session uses. Restrict it to node ids, names and statements, which the practice agent can already read. Do not include Anki card text, lapse counts or review history unless the user opts in (decision 2).

## 4. Reading practice outcomes back

Verified:

- A plugin can read the full saved session with `learning.getSession(id)`, which returns messages for practice sessions too (`src/core/plugins.ts:76-78`; `docs/plugin-authoring.md:525-528` says transcripts preserve learner answers and mistakes that the graph does not).
- Outcomes live in the transcript, not the graph. Practice settlement skips extraction and "practice outcomes are session evidence, not graph mastery" (`docs/architecture.md:82`).
- `conclude` calls carry `outcome` (`solved`, `solvedWithHints`, `movedOn`, `surrendered`, `dismissed`), `verdict`, `rung`, `missClass` and `retest` (`practice.ts:136-166`). `problem` calls carry `statement`, `mode`, `modelSolution` and canonical node ids in `target` (`practice.ts:99-114`; `native-messages.ts:502-534`). A dismissal appears as a synthesized conclude with outcome `dismissed` (`native-messages.ts:391-426`).
- A plugin backend can learn that a turn finished from `turn-settled {chatId}` (`src/core/events.ts:14-16`; `plugins.ts:185`), then re-read the session. The event does not carry the result.
- The record is the tool-call and tool-result shape of `LhMessage` (`native-messages.ts:508-526`). The plugin has to fold `problem` and `conclude` pairs itself, because the host helpers (`problemInputForConclude`) are not part of the plugin SDK. The SDK is type-only (`sdk/README.md:3`).

Assumptions:

- The record's tool-call shape is stable across host releases. The plugin API docs promise `getSession` but do not document the practice call schema. A reader must tolerate unknown shapes and report "not understood" rather than guess.
- Join key: `target` ids equal graph node ids equal the `LH_Node` ids the bridge writes to Anki. Picks and name normalization make this likely (`practice.ts:109-114`), but an untagged problem has no target (`practice.ts:96-98`), so outcomes are per problem, not per node, whenever the model leaves `target` out.
- A `missClass` is the model's own classification, not ground truth. Show it with the verdict text and let the user decide, consistent with the plan's rule that a lapse or a miss is a signal.

Unmerged, not relied on: #728 adds a mistakes store (`data/mistakes.json`, a `mistakes-changed` event, practice conclude parsing in `src/core/mistakes.ts`). If it merges it could replace a hand-rolled fold. Recheck then.

## 5. Recommendation and prototype

Recommend, in order:

1. **Ship A first, inside FI-1.** In the weak-spots view, list the nodes with names and the session each came from, and tell the user how to start a Practice session with those picks. No new API surface, no risk to other sessions, and the resulting `problem` targets make outcomes joinable. It fits the 0.7.0 layout as one more section after the three numbered steps (`origin/feat/0.7.0-redesign:src/main.ts:16`, `:20`, `:25`, step headings from `src/ui.ts:62`), not as a fourth step of the card pipeline. That placement is a design choice for the FI-1 work, not settled here.
2. **Prototype B only if the user wants less friction than picking by hand.** It is the smallest mechanism that is scoped and self-clearing without a model-mediated step.
3. **Keep C as the fallback** if putting plugin text in the learner's message is unacceptable, and accept the model-mediated cost on the bound session.
4. **Do not build D.**

### Minimal prototype for B

Pieces: a plugin-owned armed focus (ids, names, statements, created time, optional note) in backend state; a frontend interceptor (`registerSubmissionInterceptor`, `hasPendingInput` left unset so it never blocks readiness); a way to arm and disarm from the weak-spots view; time limit enforcement on read.

What it must test:

1. Applies only to `sessionKind: "practice"` and only before the first learner message. Teaching sessions, later practice messages, steers and non-text inputs pass through unchanged.
2. Output is exactly one bracketed block plus the learner's original text, unchanged, with no trimming of the learner's words.
3. `onAccepted` disarms. A refused or failed send leaves it armed. A retry carries it once.
4. Time-limited arm expires and passes through.
5. The hook never throws: corrupt or missing arm data returns nothing.
6. No change to the system prompt or tool list of any session (byte-equal against a no-plugin baseline).

### Scratch-host test plan (not run)

Stage 1, host fixture, no server (reuse the host's own pattern):

- Build a host fixture like `tests/plugin-contributions.test.ts` (`f.host.agentContributions`, `:102-120`) and drive a practice agent with `createFauxCore` as in `tests/plugin-contributions.test.ts:222-235`. The faux engine is the stub model: it records the request context it receives and replays scripted responses.
- For B: assert the recorded first request has the focus block in the first user message, once, and that `agentContributions` for the same chat shows zero instructions and zero tools from the plugin.
- For C, if built: bind chat A, assert A's contributions include the tool and B's do not, a factory throw drops only that turn's contribution, and unbind removes it on the next turn.
- For outcomes: script a faux sequence `problem` (with `target`) then `conclude` (with `missClass`), persist, and run the plugin's fold over `getSession` output. Assert outcome, miss class and target ids, and that an unknown shape yields "not understood".

Stage 2, scratch server, only with explicit user approval because it starts LearnHarness:

- Set `LH_DATA_DIR` and `LH_AUTH_FILE` to a fresh temp directory (`docs/development.md:51-52`, `:78-79`) so no real data or credential is touched. Install a built Anki Bridge into that scratch plugins directory.
- Use a stub model, not a real provider. How the server is pointed at a stub is not verified here. The host's browser smoke opens a practice fixture offline (`scripts/smoke-plugin-browser.mjs:1963-1969`), and its model wiring should be read before any attempt.
- Walk: start a practice session, arm focus, send the opening message, confirm the focus block in the saved record, a second message without it, a second practice session without it, and a reload with the arm still set. Check that no real Anki is contacted (use the fake AnkiConnect).

## 6. Open questions and decisions for the user

Decisions:

1. **Is plugin text in the learner's saved opening message acceptable?** B needs it. If not, the choice is A only, or C with a model-mediated step.
2. **What may the focus note contain?** Recommended default: node ids, names and statements only. Whether to add "why" (lapse counts, last lapse date) is a privacy and honesty trade-off: it sends review history to the model provider but supports the plan's "show the evidence" rule.
3. **Time limit for an armed focus.** A plain default such as 24 hours versus "until used or cleared". Practice sessions can be resumed days later, so a stale arm is the main risk.
4. **Should the plugin ever offer to arm for a resumed practice session,** or only new ones? B as designed handles new sessions only. Resumed sessions would need C.
5. **Where the entry point lives** in the 0.7.0 layout, and whether a practice top-bar action is wanted at all for B (B can be armed from the plugin view alone).

Unverified, to check before building:

- How the picker behaves with many weak nodes (cap is 64).
- How compaction handles a transformed opening message and plugin tool results.
- Whether a transformed opening message displays as the learner's own text.
- Whether the opening prompt can be sent with empty text when only picks exist (chat.tsx:813 rejects empty text; that suggests no).
- The stability of the `problem` and `conclude` record shapes across host versions.
- Provider prompt-cache effects of any per-turn system prompt change.

Possible upstream request, not made here: a per-session or callback-based instruction hook. It would remove the need for B and C. Posting or contacting upstream is outside this run's rules and would need the user's go-ahead.
