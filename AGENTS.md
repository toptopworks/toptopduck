# Agent instructions for toptopduck

## Agent skills

### Issue tracker

Issues live in the repo's GitHub Issues via the `gh` CLI; external PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Branching

Git-flow (AVH edition): `main` + `develop`, with `feature/ bugfix/ release/ hotfix/` prefixes. Features tie to a GitHub issue number. See `docs/agents/git-flow.md`.

### Design system

For all UI generation, follow the design system in `DESIGN.md`. Before writing `.tsx`/`.css`, read the relevant sections; after writing, self-audit colors, typography, radius, shadows, borders, spacing, and states against the tokens defined there.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
