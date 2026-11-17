# Card quality bench (0.1.x)

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
npm run bench:run -- --mode core --max-calls 15 # core kinds, hard CLI-call budget including retries
npm run bench:run -- --mode trial      # mini-problem and spot-the-mistake on 4 targets per subject
npm run bench:score                    # open the scoring page for the newest core and trial runs
npm run bench:summary                  # check the scores against the pass criteria
```

`bench:run` takes `--model` (default `sonnet`), `--cap` (cards per node, default 2), `--sets qm,humanities,programming` and an optional `--max-calls` positive integer. The call budget is shared across concurrent batches and includes correction calls. A budget refusal is recorded as a failed batch, not a model call. Each request goes to `claude -p` with no tools, MCP servers or settings files, from an empty temp directory, so the model sees only the writer's instructions and input. When the validator rejects a result, the bench resumes the same conversation with the validator's message, up to two times, as the plugin's worker does.

## Automated review and human scores

An automated reviewer can check factual accuracy, answer leaks and card design, but cannot decide whether the material is useful to this learner. Save provisional model scores as `scores.sol.json`, separate from the human `scores.json`. The scoring page and `bench:summary` default to human scores. Use `npm run bench:summary -- --scores sol <run-directory>` to explicitly evaluate `scores.sol.json` and write a separate `summary.sol.md`. It never fills human blanks with model scores. For this bench the user chose Sol evaluation with human checks only where they can judge the subject. Label that provenance rather than calling model scores human acceptance.

A run cannot pass with no cards, failed or unvalidated generation, packer skips, unapproved model skips, incomplete card scoring, any answer leak, or a factual error in a kept card. Model-score files use the same `cards` and `skips` maps as human files. Preserve the evaluator identity and reasons alongside them.

For a small human spot-check, copy unchanged cards into separate run folders and pass those folders explicitly to `bench:score`. Keep their scores separate from the original full runs. A deliberately selected diagnostic sample does not estimate the full bench's keep rate.

## Defaults settled in 0.1.1

- Enable recall, why, compose and discriminate. Trial kinds remain off by default. Mini-problems need independent answer checking; spot-the-mistake remains experimental.
- Two cards per node is a maximum. Prefer one useful card over two near-duplicates; zero is valid with an assessed reason.
- Soft length targets are 30 front / 15 back words. Necessary assumptions and correctness take priority over brevity. These are not validator limits.
- Prompt checks cover source support, complete premises, explicit assumptions, checked examples, accurate Extra text and semantic answer leakage. Deterministic validation only catches structural and surface problems; it cannot certify truth or semantic non-leakage.

See [the 0.1.1 closeout](0.1.1-closeout.md) for the frozen fresh-run evidence and any unresolved blocker.

## Code formatting

Cards may contain inline code and multiline fenced code. The preview escapes code as text and preserves indentation; maths and Markdown inside it remain literal. Use matching opening and closing backtick or tilde fences. Longer closing fences are not yet supported by this minimal preview.

## Data

- `bench/private/` holds nodes copied from your own graph. Git ignores it, because the repository will be public.
- `bench/fixtures/` holds hand-written graph slices for subjects the real graph lacks. They are cleaner than real extraction output, so they flatter the writer.
- `bench-output/<run>/` holds `run.json` (every card, attempt and validator message), `scores.json` and `summary.md`. Git ignores it too.
