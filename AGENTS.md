# Anki Bridge (LearnHarness community plugin)

## Start here

Read the plan before answering project questions or changing anything: `/Users/mehtabsingh/pi/project-plans/learnharness-anki-plugin.md`. It records the design, decisions (with the reasons any differ from the user's first answers), the card writer contract, delivery rules and milestones. It was reviewed over five council rounds on 2026-11-17. Follow the user's current request; the milestone list is not permission to build everything.

- This folder is the Git repository (local only, branch `main`, no remote).
- Plugin ID `anki-bridge`, display name Anki Bridge, future GitHub repo `Singh-Mehtab/learnharness-anki-bridge`.
- Target: LearnHarness 0.6.1, plugin API v1. Reference clone of the app at tag v0.6.1 may exist at `/tmp/lh-src/repo` (temporary; re-clone `amosblomqvist/learnharness` if missing). Key docs: `docs/plugin-authoring.md`, `docs/plugin-api/`, `plugins/flashcards/`.
- Next milestone: 0, the card quality bench (shared pure writer module plus a script, no UI, no Anki).

## Rules

- The user wants this released before anyone else ships a LearnHarness Anki plugin. Don't contact other developers (including franco-g-s on issue #197) or post anywhere public.
- Don't create the GitHub repo, add a remote, push, publish releases or post on Discord or awesome-learnharness without explicit approval. The plan says private until Milestone 1 works.
- LearnHarness data in `~/Library/Application Support/LearnHarness/` is read-only. Never open credential files. For running the plugin, use a LearnHarness checkout with scratch `LH_DATA_DIR` and `LH_AUTH_FILE`. Reading real graph nodes for the Milestone 0 bench is fine; copy them out, don't modify them.
- Anki: never send test cards to the user's real profile. Use a throwaway Anki profile. His AnkiConnect is on `http://127.0.0.1:8766` (8765 is another local service).
- Model calls (the bench, generation tests) use the user's Claude subscription. Say roughly how many calls before running anything large.
- License AGPL-3.0. Attribute anything adapted from Twig (`amoghu1s1/twig`) or core Flashcards.
- Update the plan after a verified milestone or a user decision, separating tested results from assumptions. Keep `~/pi/PROJECTS.md` in step for state changes only.
- Global Pi instructions apply, including the `unslop` writing skill for prose and README text.
