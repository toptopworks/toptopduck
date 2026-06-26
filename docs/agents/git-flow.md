# Branching: git flow

This repo uses the git-flow branching model (git-flow **AVH edition**) on top of GitHub issues. Use the `git flow` subcommands rather than hand-rolling branch plumbing — the prefixes below are what the repo is initialized with (`gitflow.prefix.*`), so don't override them ad hoc.

## Model

Two long-lived branches; everything else is short-lived and merges back.

| Branch              | Branches off | Merges into        | Tags |
| ------------------- | ------------ | ------------------ | ---- |
| `main`              | —            | —                  | yes  |
| `develop`           | `main`       | —                  | no   |
| `feature/<name>`    | `develop`    | `develop`          | no   |
| `bugfix/<name>`     | `develop`    | `develop`          | no   |
| `release/<version>` | `develop`    | `main` + `develop` | yes  |
| `hotfix/<version>`  | `main`       | `main` + `develop` | yes  |

`support/*` is configured but unused in v1.

## Naming

- Tie every feature/bugfix to a GitHub issue: `feature/<issue#>-<slug>`, e.g. `feature/42-excel-rectify`. If there's genuinely no issue (pure refactor, docs), drop the number: `feature/adr-git-flow`.
- `<version>` is semantic versioning with **no `v` prefix** (the version-tag prefix is empty): `release/0.2.0` → tag `0.2.0`.

## Lifecycle (common commands)

Start / finish a feature tied to issue #42:

```sh
git flow feature start 42-excel-rectify
# …work, commit…
git flow feature finish 42-excel-rectify
```

Cut a release (bumps toward a shipped version):

```sh
git flow release start 0.2.0
# …bump version, finalize changelog…
git flow release finish 0.2.0   # merges into main + develop, tags 0.2.0
```

Hotfix off production:

```sh
git flow hotfix start 0.2.1
git flow hotfix finish 0.2.1
```

`git flow feature publish` / `git flow feature pull` push and track the branch on `origin` when collaborating.

## Commits

Conventional Commits — `type(scope): subject` — matching the existing log (`docs(adr): ...`, `feat(engine): ...`). A feature branch need not be one-commit-per-issue; merging back into `develop` is what closes the loop.

## Pull requests

- PRs target `develop` (features/bugfixes) or `main` (hotfixes). `main` and `develop` are never committed to directly.
- External PRs are **not** a triage surface (see `issue-tracker.md`); only internal branches use this flow.
- Close the linked issue via the PR body (`Closes #42`) — don't close issues by hand after merge.

## When a skill says…

- _"start work on issue N"_ → `git flow feature start <N>-<slug>` off `develop`.
- _"cut a release"_ → `git flow release start <version>` then `release finish`.
- _"hotfix production"_ → `git flow hotfix start <version>` off `main`.

## Architecture changes

If a branch's work reverses or establishes a recorded decision, open or update an ADR in `docs/adr/` **before** merge — flag conflicts with existing ADRs rather than silently overriding (see `domain.md`).
