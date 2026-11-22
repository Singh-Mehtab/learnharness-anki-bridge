# FI-8: Cloze cards (design spec, draft)

Status: draft for review. Nothing here is implemented. The rules in Part A are expected to change after bench testing; Part B should not depend on them.

A cloze card shows a statement with one part hidden, `[ħ] = [...]`, and reveals it on the back, `[ħ] = J s`. For short facts written in notation the learner already reads, this is shorter than a question and trains the exact form the learner meets in lectures. It is worse for named equations, for answers that need a question to set the context, and for any statement where the visible text gives the hidden part away.

Cloze is a card **format**, separate from the card **kind**. The kind says what a card tests (fact, equation, why, ...). The format says how it is shown: `basic` (front and back, as today) or `cloze`.

## Assumptions awaiting the user's decision

- Default mode is **Writer chooses** (`auto`). The alternative is Off.
- Only `fact` and `equation` cards may be cloze. Steps (short ordered lists) is out of scope for the first version.

## Evidence this spec relies on

Checked on 2026-11-22 against Anki 25.09.4 (the user's version) by adding notes to a scratch collection with Anki's own Python library and reading the rendered question and answer HTML.

- Anki ends a cloze at the first `}}`, even inside MathJax. `{{c1::\(\frac{1}{\sqrt{2}}\)}}` breaks.
- `}<!-- -->}` fixes it. Inside `\(...\)` and `\[...\]` Anki removes the comment when rendering, so the TeX is unchanged. Outside maths the comment stays in the HTML and is invisible.
- `{<!-- -->{c2::...}}` is not read as a cloze opener. `:<!-- -->:` inside a cloze is not read as the hint separator.
- A cloze inside maths works: `\(E_0 = {{c1::mc^2}}\)` shows `\(E_0 = [...]\)`.
- Anki PR #4612 (in 26.11 beta, not in any stable release yet) stops a `}}` inside maths from closing a cloze opened outside it. A cloze opened inside maths still closes at the first `}}`. The escaping below works on both old and new versions.

# Part A: when a card is cloze

## Modes

The mode is a generation setting with three values.

| Mode | Behaviour |
|---|---|
| `off` | No cloze cards. The writer gets exactly today's instructions and schema. |
| `auto` | The writer uses cloze for a fact or equation card when every eligibility rule holds **and** the cloze reads more clearly than a question: the notation already says what is asked, so the question would only repeat it. When unsure, basic. |
| `prefer` | The writer uses cloze for a fact or equation card whenever every eligibility rule holds. |

The learner can still edit or reject any draft. There is no automatic convert button in the first version (a good conversion needs a rewrite, which means another model call).

## Eligibility rules

A card may be cloze only when all of these hold.

1. **Kind.** The kind is `fact` or `equation`.
2. **One blank.** The text has exactly one hidden part.
3. **Whole answer hidden.** The blank holds the smallest self-contained expression that contains the whole fact: a unit expression, a value with its unit, a term, or one complete side of an equation. Never a lone symbol, sign, exponent or operator from inside a longer expression unless that piece is itself the entire fact.
4. **One possible answer.** The visible text pins down exactly one correct answer. Test: could another correct answer fill the blank? `[...] = J s` fails (it could be \(h\), \(\hbar\) or angular momentum). `[\hbar] = [...]` in SI units passes. Equivalent forms of the same answer (\(\mathrm{J\,s}\) and \(\mathrm{kg\,m^2\,s^{-1}}\)) count as one answer.
5. **No giveaway.** Nothing visible lets the learner read off or trivially derive the blank: no intermediate step, no restatement, no hint about its form. `[t] = [E]^{-1} = [...]` fails because \([E]^{-1}\) gives \(\mathrm{eV^{-1}}\) away.
6. **The visible part is a useful cue.** It is what the learner will have in hand when they need the fact. A name the learner will be given in a problem ("use the de Broglie relation") is a better cue than one side of the equation, so a card that asks for a whole named equation stays basic. Cloze one side of an equation only when the other side is the natural cue, as in \(E_0 = [...]\) for rest energy.
7. **Short.** The whole text is one line, about 12 words or fewer, like a fact front today. The hidden part is about as long as a basic back.
8. **No hint.** The first version has no cloze hint (`::hint`). The existing "no hints" rule applies.

## Prefer basic when

- The answer is a sentence or an explanation.
- The question needs context to say which answer is meant (a condition, a convention, "when does this hold").
- The card asks for a whole equation by name, or by what it relates.
- Blanking would leave an ambiguous statement and fixing it would make the text longer than the question.
- The fact is the numerical value of a constant, whether carded on request or as a conversion constant the lesson uses. The existing rule to ask for it directly (`src/writer/prompt.ts`) stays in force, so these cards are always basic ("What is \(\hbar c\) in MeV fm?"). Whether to card the value at all is still decided by the existing selection rules.

## Worked examples

Synthetic. The Front and Back columns are the exact `front` and `back` strings the writer returns (after JSON decoding), with `{{blank}}` as the placeholder (Part B). When the blank is inside maths, the back is raw TeX without delimiters (C5). Verdicts hold in both `auto` and `prefer` unless stated.

| # | Kind | Front | Back | Verdict | Why |
|---|---|---|---|---|---|
| 1 | fact | `In SI units, \([\hbar] = {{blank}}\)` | `\mathrm{J\,s}` | Cloze | Bracket notation asks for units; the convention is named. |
| 2 | fact | `{{blank}} \(= \mathrm{J\,s}\)` | `\([\hbar]\)` | Reject | Rule 4: \([h]\) and angular momentum also fit. |
| 3 | fact | `In natural units with energy in eV, \([t] = [E]^{-1} = {{blank}}\)` | `\mathrm{eV^{-1}}` | Reject | Rule 5: \([E]^{-1}\) with energy in eV gives it away. |
| 4 | fact | `In natural units with energy in eV, \([t] = {{blank}}\)` | `\mathrm{eV^{-1}}` | Cloze | Convention and base unit named, so one answer. |
| 5 | fact | `The prefix femto- (f) means {{blank}}.` | `\(10^{-15}\)` | Cloze in `prefer`; `auto` may keep basic | Blank outside maths, so the back carries its own complete maths. One answer. The question form is equally short. |
| 6 | fact | `\(1\ \mathrm{fm} = 10^{{blank}}\ \mathrm{m}\)` | `-15` | Reject | Rule 3: a fragment of an expression. Hide `10^{-15}` instead. |
| 7 | equation | `Rest energy of a particle of mass \(m\): \(E_0 = {{blank}}\)` | `mc^2` | Cloze | \(E_0\) and the setting are the natural cue. |
| 8 | equation | `State the de Broglie relation.` | `\(\lambda = h/p\)` | Basic | Rule 6: the name is the cue and the whole equation is the answer. |
| 9 | equation | `\(\lambda = {{blank}}\)` | `h/p` | Reject | Rule 4: a wavelength of what? Ambiguous in every mode. |
| 10 | equation | `\(F = m{{blank}}\)` | `a` | Reject | Rule 3: a lone symbol, nearly given away. |
| 11 | fact | `A function that calls itself is a {{blank}} function.` | `recursive` | Cloze in `prefer`; basic in `auto` | A term from its meaning, which the fact kind allows. One answer. "What is a function that calls itself called?" is just as clear. |
| 12 | fact | `What is \(\hbar c\) in MeV fm?` | `\(\hbar c \approx 197\ \mathrm{MeV\,fm}\)` | Basic in every mode | Numerical value of a constant ("Prefer basic when"). |
| 13 | equation | `When does \(T \approx p^2/2m\) hold?` | `When \(pc \ll mc^2\) (non-relativistic).` | Basic | Needs a question; the answer is a condition. |
| 14 | fact | `\(\vec p = \gamma m {{blank}}\)` | `\vec v` | Reject | Rule 3. Hide `\gamma m \vec v` with context instead. |

## Deterministic checks (validator)

The validator enforces what can be checked mechanically. Model judgement covers the rest (rules 4 to 6).

- C1. `format` is `basic` or `cloze`. Missing means `basic`.
- C2. `cloze` only for `fact` or `equation`. This is a content rule and applies everywhere: writer output, manual cards and edits.
- C2a. Mode gate, writer output only: a `format: "cloze"` card is rejected when the task input has no `cloze` mode. Manual creation and editing are not gated by the current generation setting, so a saved cloze card stays editable after the setting is switched Off.
- C3. A cloze front contains the placeholder `{{blank}}` exactly once, and the cloze back and extra contain none. Basic cards have no placeholder rule, so a basic card may mention `{{blank}}` literally (a template answer, say). Literal Anki cloze syntax in the text is allowed because rendering escapes it.
- C4. A cloze back (the hidden part) is one line, non-empty, with no block Markdown (lists, headings, fences, display maths).
- C5. The blank is either entirely inside one maths segment or entirely outside maths. Inside maths, the back is raw TeX with no delimiters. Outside maths, any maths in the back is complete.
- C6. For a cloze card, this assembled check replaces the existing standalone rendering checks on `front` and `back`, because a raw-TeX back is not valid Markdown on its own (`n![z^n]F(z)` hits the image rejection in `src/anki/render.ts`). One shared function runs it at all four entry points: worker validation, result application, manual creation and editing. `extra` and basic cards keep the standalone checks. Render the marked assembly (Part B, step 1). Both markers must appear exactly once in the output, in text content (not in an attribute such as a link URL, and not dropped with Markdown syntax), and the range between them must not cut through markup: complete inline elements inside the answer are allowed (an inline-code back such as `` `None` `` renders as a whole `<code>` element, which Anki 25.09.4 shows correctly inside a cloze), but a range that opens or closes inside an element (partial bold, code or link) is rejected. Stripping the markers from that output must give the same HTML as rendering the unmarked assembly; otherwise the markers changed how the text parses and the card is rejected. A link URL in a cloze card must not contain `}}`, `{{` or `::`.
- C7. Leak check, by blank position:
  - Blank outside maths: the existing `givesAwayAnswer(front, back)`, with the placeholder replaced by a space.
  - Blank inside maths: compare the back as one maths segment. It leaks if its normalised TeX (the same normalisation `answerSegments` uses) appears in any visible maths segment, where the blank's own segment is checked with the placeholder replaced by a separator that can't join tokens on either side. Very short backs (under 3 characters) must match a whole visible segment or a whole side of an `=`, as in the existing check.
- C8. No field of a cloze card contains the control characters U+0002 or U+0003 (used as markers when rendering). Basic cards are unchanged, so legacy and Off-mode results keep today's contract.

# Part B: how it is built

## Writer contract

- `DraftCard` gains `format?: "basic" | "cloze"`.
- For a cloze card, `front` is the full text with `{{blank}}` where the hidden part goes, and `back` is the hidden part. `extra` keeps its meaning (shown after the answer).
- This keeps the existing card shape, so dedupe, the leak check, existing-card lists and coverage keep working on `front`/`back`. `{{blank}}` is chosen because it is not Anki syntax and the placeholder and the answer are separate strings: the plugin never has to find the end of a blank by counting braces.
- `WriterInput` gains `cloze?: "auto" | "prefer"`. It is absent when the mode is `off`. The prompt line for each task states the mode.
- `existingCards` entries gain `format` so the writer does not repeat a fact in the other format.
- Exact-duplicate keys include `format ?? "basic"` (`src/writer/validate.ts`, `src/writer/dedupe.ts`, `src/generation/service.ts`), so a basic card that mentions `{{blank}}` literally is never treated as a duplicate of a cloze card with the same fields. Omitted and explicit `basic` stay equal.

## Workers and Off mode

LearnHarness registers worker instructions and schema once (`workers.register`). Distinct definition IDs are allowed.

- Keep `manual-card-writer` byte-identical to today (instructions and schema). Off mode uses it.
- Register `manual-card-writer-cloze` with a schema whose card items allow `format`, and instructions built from today's sections plus a cloze section (Part A, with the worked examples). `auto` and `prefer` use it; the mode comes from the task input.
- The cloze section states which existing rules it replaces for cloze cards, because several conflict with Part A (`src/writer/prompt.ts`):
  - "Asked as a closed question" and "Ask plainly and briefly" apply to basic cards. A cloze card is a statement with one blank.
  - The equation kind's "ask for it by name or by what it relates" applies to basic equation cards. A cloze equation card hides one side and shows the cue (rule 6).
  - "Prefer display maths" does not apply to cloze text. The text is one line with inline maths.
  - The units format `\([t] = [E]^{-1} = \mathrm{eV^{-1}}\)` is for basic backs. In a cloze, show only the bracket and the blank (example 4), never the intermediate step (rule 5).
  - "Do not define the answer and then ask for its label" still applies, except for the fact kind's term-from-meaning card (example 11), which the fact kind already allows.
  - The fact kind's "one fact asked directly" means one fact per card; a cloze card states it with one blank instead of asking.
  - "Every expression goes inside maths delimiters" applies to `front` and to a back whose blank is outside maths. When the blank is inside maths, the back is raw TeX without delimiters (C5).
  - "No hints" and the leak rules apply unchanged.
- `GenerationTask` gains `definitionId`, saved before the worker starts. A task without one (saved by schema 8 or earlier) is treated as `manual-card-writer`. The identity checks in `src/generation/service.ts` (worker lookup, result recovery, start) compare against the task's own ID. A successful schema-8 task that is waiting for recovery must still apply after the upgrade.
- Validation follows the definition. Results for `manual-card-writer` are validated with today's contract plus the C2a gate (no cloze without a mode). Cloze rules C2 to C7 apply to cloze cards only, so a legacy basic result is never rejected by them.
- Preflight chooses the definition from the current setting before packing, and estimates tokens from that definition's instructions, schema and task prompt (`src/generation/service.ts`, where the overhead is computed today). The same definition is used to start the task. Changing the setting invalidates saved preflights, as other generation settings do.

## State

- `Card` gains `format?: "cloze"` (absent means basic). State schema goes from 8 to 9 so an older plugin version refuses the file instead of sending a cloze card through the basic note type. Migration from 8 adds nothing to cards.
- `generationSettings.cloze` is absent in schema-8 files. In the active settings a missing value resolves to the default chosen by the user (pending; see the top of this spec). In generation history and saved task inputs, a missing value means Off, because those runs predate cloze. Neither case rewrites stored history.
- `packageRevision` includes `format`, so a package fingerprint changes if the format changes.
- Edits keep the format. The manual "Write a card" dialog gets a format choice (basic or cloze). Manual cards and edits use the content checks (C2 to C8) and are not gated by the generation setting (C2a).

## Anki note type

- New owned note type **LearnHarness Cloze**, created with `isCloze: true`. Fields: `Text`, `Extra`, `Source`, `LH_ID`, `LH_Node`. Front template `{{cloze:Text}}`. Back template `{{cloze:Text}}`, then Extra and Source blocks as in LearnHarness Basic. Same CSS marker scheme, its own style revision. Same ownership, field-repair and styling-update rules as the basic type (`note-type.ts`), parameterised by note type. The Settings actions "Add missing fields" and "Update styling" (and the delivery operations behind them) take an explicit note type, default LearnHarness Basic for existing callers, and name the chosen note type in their confirmations, so a damaged LearnHarness Cloze can be repaired from Settings.
- LearnHarness Basic is not changed. Existing notes are not touched.
- Duplicate check uses the first field (`Text`), scoped to the deck and this note type, as basic does.
- `findNotes "LH_ID:<id>"` already works across note types.
- `src/reviews/service.ts` accepts either owned note type when matching a note to a card, and checks the note type matches the card's format.
- Review evidence carries `format` through to its consumers (`src/reviews/signals.ts`, Topics in `src/topics-ui.ts`). Topics renders cloze cards with the same format-aware preview as the review page, so the user never sees `{{blank}}` or undelimited TeX.

## Rendering the Text field

Input: `front` with one `{{blank}}`, and `back`.

1. Replace `{{blank}}` with `\u0002` + back + `\u0003` (control characters the writer can't produce; the validator rejects control characters in fields).
2. Render with `renderMarkdown` as today.
3. Escape every other `}}` as `}<!-- -->}`, every `{{c` followed by a digit as `{<!-- -->{c`, and every `::` between the markers as `:<!-- -->:`. Apply repeatedly so `}}}` becomes `}<!-- -->}<!-- -->}`.
4. If the character before `\u0003` is `}`, insert `<!-- -->` before `\u0003`. If the character after `\u0002` is `:`, insert `<!-- -->` after `\u0002` (as a precaution, so the opener's `::` never runs into the answer). Without the first rule, the answer's last `}` and the closing `}}` form `}}}`, and Anki closes the cloze one brace early. Verified on Anki 25.09.4: `\(\vec{p} = {{c1::\gamma m \vec{v}<!-- -->}}\)` shows `\(\vec{p} = [...]\)` and answers `\(\vec{p} = \gamma m \vec{v}\)`; without the comment the question has a stray `}`.
5. Replace `\u0002` with `{{c1::` and `\u0003` with `}}`.

Escaping applies to text and maths, not inside HTML attributes (a link `href` containing `}}` is rejected by the validator instead). One escape form is used everywhere, inside and outside maths, because Anki strips the comment from maths and the comment is invisible outside it. The result must parse in Anki as exactly one cloze (`c1`) whose content is the rendered answer.

AnkiConnect delivery and the `.apkg` writer both call one shared function for this, as they already share `packageFields` for basic cards.

## .apkg export

- Add the LearnHarness Cloze model with its own fixed ID, `type: 1`, one template, its fields, and no `req`.
- A package can contain both note types. Each cloze note gets one card with `ord` 0.
- Same fallback behaviour and import caveats as FI-9.

## Settings and UI

- Settings: a "Cloze cards" slider with three labelled stops, Off, Writer chooses, Prefer cloze, and a one-line description under the selected stop:
  - Off: "Every card is a question and answer."
  - Writer chooses: "Cloze where the notation already says what is asked, such as \([\hbar] = [\ldots]\)."
  - Prefer cloze: "Cloze for every fact and equation card that can be one."
  The control is a native range input (`min 0`, `max 2`, `step 1`) or equivalent, keyboard-operable, with the stop name as its accessible value text. Stored in `generationSettings.cloze` (`off`, `auto`, `prefer`). Generation history keeps the setting it ran with.
- Review and drafting: a cloze card shows a "Cloze" pill. The preview shows the front with the blank as `[...]` and the back with the full text and the answer emphasised. Editing a cloze card labels the fields "Text" and "Hidden part", and validates with the same checks.
- System tags add `learnharness::format::cloze` for cloze cards. Basic cards keep today's tags.

## Bench

- `bench/run.ts` takes `--cloze off|auto|prefer` (default `off`). The bench builds its own instructions and schema today, so the flag must select the shared writer variant (basic or cloze instructions and schema) and set `batch.input.cloze` for `auto` and `prefer`. A no-model check prints or asserts the instructions, schema and task payload for each mode.
- The run records the mode, and each card record carries its `format`. `bench/run.ts` builds those records field by field, so this needs explicit changes there, not just in the writer types.
- The scoring page renders cloze cards as front with `[...]` and back with the full text, and adds a tick for "should have been the other format" on every fact and equation card, cloze or basic.
- The test set includes positive fixtures where cloze is clearly better than a question (units in bracket notation, as in example 1, and a rest-energy cue as in example 7). An `auto` run passes only if at least one cloze card is accepted on those fixtures.
- It also has two other parts: real nodes in the ignored `bench/private/` that contain units, constants, named equations and definitions, and synthetic trap targets matching the rejected worked examples.

## Acceptance for the rules (bench)

These are the targets for tuning Part A. Human scores and Sol scores stay in separate files.

- With `--cloze off`, the writer gets today's instructions and schema; the bench's existing pass criteria still hold.
- The format thresholds below apply to `auto` and `prefer` runs only. An Off run is judged by the existing criteria alone.
- No cloze card that the user marks as ambiguous (rule 4) or giving the answer away (rule 5).
- At most one in five cloze cards marked "should have been basic".
- In `prefer` runs, at most one in five basic fact and equation cards marked "should have been cloze". The denominator is all basic cards of those kinds, judged by the scorer, not cards the writer considered eligible.
- Every cloze card renders in Anki as one `c1` blank (checked automatically against Anki's library, below).
- At most three rounds of rule changes before the user and I review where things stand.

## Tests

- Unit tests for C1 to C8, including the leak cases `\(E_0 = mc^2 = {{blank}}\)` / `mc^2` (leak) and `\(E_0 = {{blank}}\)` / `mc^2` (no leak), a blank inside a link URL (rejected), and manual cloze edits with the setting Off (allowed).
- Escaping cases: `}}` inside and outside maths, `}}}`, an answer ending in `}` (`\gamma m \vec{v}`, `\mathrm{J\,s}`), an answer starting with `:`, `{{c1` in text, `::` in the answer, a blank inside maths, a blank inside bold (rejected), an inline-code back (allowed).
- Settings: a schema-8 file with no `cloze` value reads as the chosen default in active settings and as Off in history, without rewriting history. Duplicate keys: a basic and a cloze card with identical fields are both kept.
- A test that renders generated Text fields with Anki's Python library on a scratch collection and checks one card, one `c1` blank, and the exact expected question and answer HTML, not just the card count (a broken cloze can still make one card). It runs where Anki's library is available and is skipped otherwise.
- Generation: a successful schema-8 task without `definitionId` recovers and applies after the upgrade; preflight uses the cloze definition's size when the setting is on; a cloze card from the basic worker is rejected.
- A test that `manual-card-writer` instructions and schema are unchanged.
- State migration 8 to 9; older-version refusal.
- Fake AnkiConnect: creating and repairing LearnHarness Cloze; sending a mixed batch; review reading for both note types.
- `.apkg` with both note types imports into Anki (manual, throwaway profile).
- Before merging, one live send of cloze cards to a throwaway Anki profile.

## Out of scope for the first version

Multiple blanks per note, hints, cloze for kinds other than fact and equation, converting existing notes, image occlusion.
