# Agent instructions for toptopduck

## Agent skills

### Issue tracker

Issues live in the repo's GitHub Issues via the `gh` CLI; external PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Branching

Git-flow (AVH edition): `main` + `develop`, with `feature/ bugfix/ release/ hotfix/` prefixes. Features tie to a GitHub issue number. See `docs/agents/git-flow.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
