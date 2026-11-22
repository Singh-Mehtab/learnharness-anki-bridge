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
4. **One possible answer.** The visible text pins down exactly one correct answer. Test: could another correct answer fill the blank? `[...] = J s` fails (it could be \(h\), \(\hbar\) or angular momentum). `[\hbar] = [...]` passes.
5. **No giveaway.** Nothing visible lets the learner read off or trivially derive the blank: no intermediate step, no restatement, no hint about its form. `[t] = [E]^{-1} = [...]` fails because \([E]^{-1}\) gives \(\mathrm{eV^{-1}}\) away.
6. **The visible part is a useful cue.** It is what the learner will have in hand when they need the fact. A name the learner will be given in a problem ("use the de Broglie relation") is a better cue than one side of the equation, so a card that asks for a whole named equation stays basic. Cloze one side of an equation only when the other side is the natural cue, as in \(E_0 = [...]\) for rest energy.
7. **Short.** The whole text is one line, about 12 words or fewer, like a fact front today. The hidden part is about as long as a basic back.
8. **No hint.** The first version has no cloze hint (`::hint`). The existing "no hints" rule applies.

## Prefer basic when

- The answer is a sentence or an explanation.
- The question needs context to say which answer is meant (a condition, a convention, "when does this hold").
- The card asks for a whole equation by name, or by what it relates.
- Blanking would leave an ambiguous statement and fixing it would make the text longer than the question.
- The fact is a value of a constant that the selection rules only allow on request: those cards stay basic so the request is visible on the front ("What is \(\hbar c\) in MeV fm?"). *Open: this rule may be unnecessary.*

## Worked examples

Synthetic. Blank shown as `{{blank}}`, the writer's placeholder (Part B).

| # | Kind | Card | Verdict | Why |
|---|---|---|---|---|
| 1 | fact | `\([\hbar] = {{blank}}\)` / `\(\mathrm{J\,s}\)` | Cloze | Bracket notation already asks for units. |
| 2 | fact | `{{blank}} \(= \mathrm{J\,s}\)` / `\([\hbar]\)` | Reject | Rule 4: \(h\) and angular momentum also fit. |
| 3 | fact | `\([t] = [E]^{-1} = {{blank}}\)` in natural units / `\(\mathrm{eV^{-1}}\)` | Reject | Rule 5: \([E]^{-1}\) gives it away. |
| 4 | fact | In natural units, `\([t] = {{blank}}\)` / `\(\mathrm{eV^{-1}}\)` | Cloze | Convention named, one answer. |
| 5 | fact | `The prefix femto- (f) means {{blank}}.` / `\(10^{-15}\)` | Cloze | One answer, short. |
| 6 | fact | `\(1\ \mathrm{fm} = 10^{{blank}}\ \mathrm{m}\)` / `-15` | Reject | Rule 3: blank is a fragment inside an expression; hide `10^{-15}` instead. |
| 7 | equation | `\(E_0 = {{blank}}\)` for a particle of mass \(m\) / `\(mc^2\)` | Cloze | \(E_0\) is the natural cue. |
| 8 | equation | `State the de Broglie relation.` / `\(\lambda = h/p\)` | Basic | Rule 6: the name is the cue; the whole equation is the answer. |
| 9 | equation | `\(\lambda = {{blank}}\)` / `\(h/p\)` | Reject in `auto` | Rule 6 and context: λ of what? A wavelength could be many things. Acceptable only with context ("de Broglie: ..."). |
| 10 | equation | `\(F = m{{blank}}\)` / `\(a\)` | Reject | Rule 3: lone symbol; nearly given away. |
| 11 | fact | `A {{blank}} is a function that calls itself.` / `recursive function` | Cloze | Term from meaning, one answer. |
| 12 | fact | `\(\hbar c \approx {{blank}}\)` / `\(197\ \mathrm{MeV\,fm}\)` | Basic (open) | Value rule above. |
| 13 | equation | `When does \(T \approx p^2/2m\) hold?` / non-relativistic, \(pc \ll mc^2\) | Basic | Needs a question; answer is a condition. |
| 14 | fact | `\(\vec p = \gamma m {{blank}}\)` / `\(\vec v\)` | Reject | Rule 3. Hide `\gamma m \vec v` with context instead. |

## Deterministic checks (validator)

The validator enforces what can be checked mechanically. Model judgement covers the rest (rules 4 to 6).

- C1. `format` is `basic` or `cloze`. Missing means `basic`.
- C2. `cloze` only when the input's mode is `auto` or `prefer`, and only for `fact` or `equation`.
- C3. A cloze front contains the placeholder `{{blank}}` exactly once. No other field, and no field of a basic card, contains `{{blank}}`. Literal Anki cloze syntax in the text is allowed because rendering escapes it.
- C4. A cloze back (the hidden part) is one line, non-empty, with no block Markdown (lists, headings, fences, display maths).
- C5. The blank is either entirely inside one maths segment or entirely outside maths. Inside maths, the back is raw TeX with no delimiters. Outside maths, any maths in the back is complete.
- C6. The assembled text (placeholder replaced by the back) renders with the existing renderer, and the rendered answer is not split across HTML elements (no partial bold, code or link). A link URL in a cloze card must not contain `}}`, `{{` or `::`.
- C7. The existing leak check applies: `givesAwayAnswer(front without placeholder, back)` must be false.
- C8. No field contains the control characters U+0002 or U+0003 (used as markers when rendering), for any format.

# Part B: how it is built

## Writer contract

- `DraftCard` gains `format?: "basic" | "cloze"`.
- For a cloze card, `front` is the full text with `{{blank}}` where the hidden part goes, and `back` is the hidden part. `extra` keeps its meaning (shown after the answer).
- This keeps the existing card shape, so dedupe, the leak check, existing-card lists and coverage keep working on `front`/`back`. `{{blank}}` is chosen because it is not Anki syntax and the placeholder and the answer are separate strings: the plugin never has to find the end of a blank by counting braces.
- `WriterInput` gains `cloze?: "auto" | "prefer"`. It is absent when the mode is `off`. The prompt line for each task states the mode.
- `existingCards` entries gain `format` so the writer does not repeat a fact in the other format.

## Workers and Off mode

LearnHarness registers worker instructions and schema once (`workers.register`). Distinct definition IDs are allowed.

- Keep `manual-card-writer` byte-identical to today (instructions and schema). Off mode uses it.
- Register `manual-card-writer-cloze` with the same instructions plus a cloze section (Part A, with examples) and a schema whose card items allow `format`. `auto` and `prefer` use it; the mode comes from the task input.
- Generation records keep the `definitionId` they started with. The identity checks in `src/generation/service.ts` accept either ID, matched to the recorded one.
- `validateResult` is shared. It rejects any `format: "cloze"` when the input has no `cloze` mode (C2).

## State

- `Card` gains `format?: "cloze"` (absent means basic). State schema goes from 8 to 9 so an older plugin version refuses the file instead of sending a cloze card through the basic note type. Migration from 8 adds nothing.
- `packageRevision` includes `format`, so a package fingerprint changes if the format changes.
- Edits keep the format. The manual "Write a card" dialog gets a format choice (basic or cloze) with the same validator.

## Anki note type

- New owned note type **LearnHarness Cloze**, created with `isCloze: true`. Fields: `Text`, `Extra`, `Source`, `LH_ID`, `LH_Node`. Front template `{{cloze:Text}}`. Back template `{{cloze:Text}}`, then Extra and Source blocks as in LearnHarness Basic. Same CSS marker scheme, its own style revision. Same ownership, field-repair and styling-update rules as the basic type (`note-type.ts`), parameterised by note type.
- LearnHarness Basic is not changed. Existing notes are not touched.
- Duplicate check uses the first field (`Text`), scoped to the deck and this note type, as basic does.
- `findNotes "LH_ID:<id>"` already works across note types.
- `src/reviews/service.ts` accepts either owned note type when matching a note to a card. It should also check the note type matches the card's format.

## Rendering the Text field

Input: `front` with one `{{blank}}`, and `back`.

1. Replace `{{blank}}` with `\u0002` + back + `\u0003` (control characters the writer can't produce; the validator rejects control characters in fields).
2. Render with `renderMarkdown` as today.
3. Escape every other `}}` as `}<!-- -->}`, every `{{c` followed by a digit as `{<!-- -->{c`, and every `::` between the markers as `:<!-- -->:`. Apply repeatedly so `}}}` becomes `}<!-- -->}<!-- -->}`.
4. Replace `\u0002` with `{{c1::` and `\u0003` with `}}`.

Escaping applies to text and maths, not inside HTML attributes (a link `href` containing `}}` is rejected by the validator instead). One escape form is used everywhere, inside and outside maths, because Anki strips the comment from maths and the comment is invisible outside it. The result must parse in Anki as exactly one cloze (`c1`) whose content is the rendered answer.

AnkiConnect delivery and the `.apkg` writer both call one shared function for this, as they already share `packageFields` for basic cards.

## .apkg export

- Add the LearnHarness Cloze model with its own fixed ID, `type: 1`, one template, its fields, and no `req`.
- A package can contain both note types. Each cloze note gets one card with `ord` 0.
- Same fallback behaviour and import caveats as FI-9.

## Settings and UI

- Settings: a "Cloze cards" control with Off, Writer chooses, Prefer cloze. Stored in `generationSettings.cloze`. Generation history keeps the setting it ran with.
- Review and drafting: a cloze card shows a "Cloze" pill. The preview shows the front with the blank as `[...]` and the back with the full text and the answer emphasised. Editing a cloze card labels the fields "Text" and "Hidden part", and validates with the same checks.
- System tags add `learnharness::format::cloze` for cloze cards. Basic cards keep today's tags.

## Bench

- `bench/run.ts` takes `--cloze off|auto|prefer` (default `off`).
- The scoring page renders cloze cards as front with `[...]` and back with the full text, and adds a tick for "should have been the other format".
- The test set has two parts: real nodes in the ignored `bench/private/` that contain units, constants, named equations and definitions, and synthetic trap targets matching the rejected worked examples.

## Acceptance for the rules (bench)

These are the targets for tuning Part A. Human scores and Sol scores stay in separate files.

- With `--cloze off`, the writer gets today's instructions and schema; the bench's existing pass criteria still hold.
- No cloze card that the user marks as ambiguous (rule 4) or giving the answer away (rule 5).
- At most one in five cloze cards marked "should have been basic"; at most one in five eligible basic cards marked "should have been cloze" in `prefer` mode.
- Every cloze card renders in Anki as one `c1` blank (checked automatically against Anki's library, below).
- At most three rounds of rule changes before the user and I review where things stand.

## Tests

- Unit tests for C1 to C7, the escaping cases above (`}}` inside and outside maths, `}}}`, `{{c1` in text, `::` in the answer, blank inside maths, blank inside bold).
- A test that renders generated Text fields with Anki's Python library on a scratch collection and checks one card, one `c1` blank, and the expected question and answer. It runs where Anki's library is available and is skipped otherwise.
- A test that `manual-card-writer` instructions and schema are unchanged.
- State migration 8 to 9; older-version refusal.
- Fake AnkiConnect: creating and repairing LearnHarness Cloze; sending a mixed batch; review reading for both note types.
- `.apkg` with both note types imports into Anki (manual, throwaway profile).
- Before merging, one live send of cloze cards to a throwaway Anki profile.

## Out of scope for the first version

Multiple blanks per note, hints, cloze for kinds other than fact and equation, converting existing notes, image occlusion.
