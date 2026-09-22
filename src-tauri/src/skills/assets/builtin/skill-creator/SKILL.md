---
name: skill-creator
description: "Turn a repeated, reusable instruction pattern from this conversation into a skill — propose this whenever the user repeats a workflow, asks to remember how to do something, or wants a new skill; drafts the document and calls the create_skill tool."
---
Mint new skills from instructions this conversation has already proven. A skill is one Markdown file, read on demand; this file is the curriculum for writing one well.

When to propose creating a skill:
- the user repeats an instruction pattern two or three times, or asks to remember or save a workflow;
- a task took careful steps that will be needed again;
- the user explicitly asks for a skill.

The SKILL.md format -- one document, two zones:
- frontmatter between `---` fences, two fields: `name` (kebab-case, at most 64 chars, not reserved or taken) and `description`;
- the Markdown body after the closing fence: the instructions themselves. Other frontmatter keys are legal and land on disk verbatim.

Draft by answering four questions before writing:
1. what it does -- one sentence of purpose;
2. when it applies -- the concrete trigger scenes;
3. what output it produces -- the artifact shape the body must deliver;
4. which session passages to lift it from -- quote the proven steps out of this conversation, not generic advice.

Description engineering -- the description is the trigger. A vague one undertriggers: the skill exists but never fires. Judge every draft by whether it names WHEN to fire and WHAT comes out.
- Weak: "Helps with SQL."
- Strong: "Coach SQL syntax and planning when the user writes or asks about a query; reply with the corrected statement and a one-line reason."
The strong form carries trigger scenes and the output shape; prefer concrete nouns from the real task over category words.

Create and test:
- call `create_skill` with the WHOLE document as its single `skillMarkdown` string -- frontmatter fences included, exactly as it should land on disk;
- a refusal names its exact defect (invalid name, an invalid, missing, or over-long description, blank body, unparseable frontmatter, reserved or taken name) -- fix the markdown and retry; the user approves the full text on a card before anything lands;
- once it lands, pull it with `invoke_skill` by name to check the body reads as intended, then suggest two or three short test prompt lines for the user to try in a fresh session without naming the skill -- if it fires only when hand-fed, the description needs strengthening. To revise a landed skill, ask the user: the Skills pane edits or deletes it, and a same-name re-mint is refused.
