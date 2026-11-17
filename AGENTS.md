# Anki Bridge (LearnHarness community plugin)

## Start here

Read the plan before answering project questions or changing anything: `/Users/mehtabsingh/pi/project-plans/learnharness-anki-plugin.md`. It records the design, decisions (with the reasons any differ from the user's first answers), the card writer contract, delivery rules and milestones. It was reviewed over five council rounds on 2026-11-17. Follow the user's current request; the milestone list is not permission to build everything.

- This folder is the Git repository, default branch `main`, remote `origin` = private GitHub repo `Singh-Mehtab/learnharness-anki-bridge` (created 2026-11-17 at the user's request).
- Plugin ID `anki-bridge`, display name Anki Bridge.
- Target: LearnHarness 0.6.1, plugin API v1. Reference clone of the app at tag v0.6.1 may exist at `/tmp/lh-src/repo` (temporary; re-clone `amosblomqvist/learnharness` if missing). Key docs: `docs/plugin-authoring.md`, `docs/plugin-api/`, `plugins/flashcards/`.
- Milestones go by version (0.1.0 bench, 0.2.0 Anki plumbing, 0.3.0 manual drafting, 0.4.0 session flow, 0.5.0 coverage, 0.6.0 first public release). Use version numbers, not "Milestone N".
- Current: 0.1.1 closes out the 0.1.0 writer bench. The original run failed the zero-leak gate; the user's knowledgeable spot-check is finished and unfamiliar cards stay Sol-assessed. Fresh-run generation is blocked by Claude quota after all real QM targets completed. See `bench/0.1.1-closeout.md` for evidence and continuation. Do not call the partial run a pass. Separate 0.2.0 worktrees are out of this chat's scope.

## Rules

- The user wants this released before anyone else ships a LearnHarness Anki plugin. Don't contact other developers (including franco-g-s on issue #197) or post anywhere public.
- Make new changes on a feature branch. Commits and branch pushes are allowed; open a PR when the work is ready and leave it unmerged for the user's review. Don't push new work directly to `main` or merge without approval.
- Don't make the repo public, publish releases or post on Discord or awesome-learnharness without explicit approval. The plan says private until 0.2.0 works.
- Multiline fenced code blocks are allowed in cards. Preserve indentation and escape code as text in previews and Anki HTML. Mermaid and images remain unsupported.
- Real graph content copied for the bench stays out of Git (`bench/private/` and `bench-output/` are ignored), because the repo goes public later.
- LearnHarness data in `~/Library/Application Support/LearnHarness/` is read-only. Never open credential files. For running the plugin, use a LearnHarness checkout with scratch `LH_DATA_DIR` and `LH_AUTH_FILE`. Reading real graph nodes for the Milestone 0 bench is fine; copy them out, don't modify them.
- Anki: never send test cards to the user's real profile. Use a throwaway Anki profile. His AnkiConnect is on `http://127.0.0.1:8766` (8765 is another local service).
- Model calls (the bench, generation tests) use the user's Claude subscription. Say roughly how many calls before running anything large.
- License AGPL-3.0. Attribute anything adapted from Twig (`amoghu1s1/twig`) or core Flashcards.
- Update the plan after a verified milestone or a user decision, separating tested results from assumptions. Keep `~/pi/PROJECTS.md` in step for state changes only.
- Global Pi instructions apply, including the `unslop` writing skill for prose and README text.
