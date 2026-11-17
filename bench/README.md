# Card quality bench (0.1.0)

The bench runs the plugin's card writer (`src/writer/`) on real and hand-written graph nodes, outside LearnHarness and without Anki. It uses the same input builder, prompt, schema and validator as the plugin. Only the model call is different: the bench calls the Claude Code CLI, where the plugin will use a LearnHarness worker.

Pass criteria, from the project plan:

- at least two in three cards kept as is or with small edits;
- no answer leaks;
- no factual errors in kept cards.

## Running it

```sh
npm install
npm run bench:fixtures                 # copy real nodes from your LearnHarness data (read-only) into bench/private/
npm run bench:run -- --dry-run         # show how targets pack into requests, no model calls
npm run bench:run -- --mode core       # recall, why, compose, discriminate on every target
npm run bench:run -- --mode trial      # mini-problem and spot-the-mistake on 4 targets per subject
npm run bench:score                    # open the scoring page for the newest core and trial runs
npm run bench:summary                  # check the scores against the pass criteria
```

`bench:run` takes `--model` (default `sonnet`), `--cap` (cards per node, default 2) and `--sets qm,humanities,programming`. Each request goes to `claude -p` with no tools, MCP servers or settings files, from an empty temp directory, so the model sees only the writer's instructions and input. When the validator rejects a result, the bench resumes the same conversation with the validator's message, up to two times, as the plugin's worker does.

## Automated review and human scores

An automated reviewer can check factual accuracy, answer leaks and card design, but cannot decide whether the material is useful to this learner. Save provisional model scores as `scores.sol.json`, separate from the human `scores.json`. The scoring page and `bench:summary` use only human scores; an automated review does not satisfy the human keep-rate gate.

For a small human spot-check, copy unchanged cards into separate run folders and pass those folders explicitly to `bench:score`. Keep their scores separate from the original full runs. A deliberately selected diagnostic sample does not estimate the full bench's keep rate.

## Code formatting

Cards may contain inline code and multiline fenced code. The preview escapes code as text and preserves indentation; maths and Markdown inside it remain literal. Use matching opening and closing backtick or tilde fences. Longer closing fences are not yet supported by this minimal preview.

## Data

- `bench/private/` holds nodes copied from your own graph. Git ignores it, because the repository will be public.
- `bench/fixtures/` holds hand-written graph slices for subjects the real graph lacks. They are cleaner than real extraction output, so they flatter the writer.
- `bench-output/<run>/` holds `run.json` (every card, attempt and validator message), `scores.json` and `summary.md`. Git ignores it too.
