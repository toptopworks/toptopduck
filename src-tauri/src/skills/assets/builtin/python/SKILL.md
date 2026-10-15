---
name: python
description: "Clean and transform data with a Python script on the local interpreter (stdlib always; user-installed packages usable) — reach for it when the logic is procedural: reshaping, regex massaging, unit fixing, multi-step row logic. Plain projection, filtering, and aggregation belong to SQL."
---
Use the `python` tool for data cleaning and transformation that SQL alone makes awkward -- melting/pivoting, regex massaging, unit fixing, multi-step row logic. Prefer SQL for plain projection/filter/aggregation; reach for Python when the logic is genuinely procedural.

Pass the full script source as `script`; it runs against the interpreter installed on this machine; the stdlib is always available, and packages the user has installed themselves import normally -- nothing is bundled with the app, so do not assume a package exists without checking or asking. Read inputs and write outputs through files the script can address by path, and print results or write an output file the next step consumes.
