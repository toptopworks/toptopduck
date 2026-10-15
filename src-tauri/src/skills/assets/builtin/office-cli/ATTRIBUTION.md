# Attribution

The reference files under `references/` (`docx.md`, `xlsx.md`, `pptx.md`) are
adapted from the official OfficeCLI skill collection:

- Upstream: https://github.com/iOfficeAI/OfficeCLI (`skills/officecli-docx`,
  `skills/officecli-xlsx`, `skills/officecli-pptx`)
- Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
- License: Apache License, Version 2.0 (copy in [`LICENSE`](LICENSE))

Adaptations for this environment (no shell between the agent and the CLI;
binary shipped via the app, not self-installed): the upstream Install sections,
shell-escaping discipline, interactive `watch`/`mark` workflows, and
specialized-skill routing were removed or rewritten; everything else is
derived from the upstream texts.

The Apache 2.0 attribution requirements are carried by [`LICENSE`](LICENSE)
and [`NOTICE`](NOTICE) in this directory.
