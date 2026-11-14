// Release-notes body grammar (issue #1577). The updater manifest carries the
// release body (ADR-0143): the canonical shape is `###` section headings with
// `- ` one-line items, an optional `<!-- en -->` comment splitting a Chinese
// segment from an English mirror, per-item `(PR …)` provenance tails, and a
// `---` separator followed by the install-tip footer that belongs to the
// release page only. This module is the total, dependency-free parse that
// turns whatever actually shipped into something renderable; ReleaseNotes.tsx
// draws it. Pure functions only -- the grammar is ours, so no markdown
// library and no HTML surface ever enters the picture.

export type ReleaseNotesSection = {
  readonly title: string;
  readonly items: readonly string[];
};

/** Sections when the canonical grammar is present, else the cleaned text as
 *  plain display lines. An empty parse means "render nothing". */
export type ParsedReleaseNotes =
  | { readonly kind: "sections"; readonly sections: readonly ReleaseNotesSection[] }
  | { readonly kind: "plain"; readonly lines: readonly string[] };

export type ReleaseNotesLang = "zh" | "en";

/** Chinese locales read the Chinese segment; everything else reads English. */
export function releaseNotesLang(locale: string): ReleaseNotesLang {
  return locale === "zh-CN" || locale === "zh-TW" ? "zh" : "en";
}

/** The `<!-- en -->` split marker, tolerant of whitespace inside the comment. */
const EN_MARKER = /<!--\s*en\s*-->/;

/** One canonical entry's provenance tail: from the first ` (PR ` marker to
 *  the end of the line. The strip-to-line-end shape is deliberate -- PR link
 *  syntax nests brackets, so a balanced-paren match truncates mid-tail (the
 *  release-notes counting convention hit the same wall). */
const PR_TAIL = /\s*\(PR .*$/u;

/** Everything from the first line that is exactly `---` onward: the release
 *  page's install-tip footer. */
function cutFooter(text: string): string {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => line.trim() === "---");
  return (end === -1 ? lines : lines.slice(0, end)).join("\n");
}

function stripPrTail(line: string): string {
  return line.replace(PR_TAIL, "").trimEnd();
}

function isEmpty(parsed: ParsedReleaseNotes): boolean {
  return parsed.kind === "plain"
    ? parsed.lines.length === 0
    : parsed.sections.length === 0;
}

function parseBody(text: string): ParsedReleaseNotes {
  // Mutable parse-time shape; the public type exposes readonly arrays.
  const sections: { title: string; items: string[] }[] = [];
  const plainLines: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = stripPrTail(rawLine);
    const heading = line.match(/^###\s+(.*)$/u);
    if (heading) {
      sections.push({ title: heading[1]?.trim() ?? "", items: [] });
    } else if (/^-\s+/u.test(line)) {
      const item = line.replace(/^-\s+/u, "").trim();
      if (sections.length > 0 && item !== "") {
        sections[sections.length - 1]?.items.push(item);
      } else if (sections.length === 0 && item !== "") {
        plainLines.push(item);
      }
    } else if (sections.length === 0 && line.trim() !== "") {
      plainLines.push(line.trim());
    }
  }
  const liveSections = sections.filter((s) => s.items.length > 0);
  if (liveSections.length > 0) {
    return { kind: "sections", sections: liveSections };
  }
  return { kind: "plain", lines: plainLines };
}

/**
 * Parse one release body for display. Splits on the `<!-- en -->` marker and
 * reads the segment for `lang`, cuts the `---` footer, strips PR tails, and
 * classifies the remainder as sections or plain lines. An empty picked
 * segment (a hand-edited mirror that lost its body) falls back to the other
 * segment -- an empty render is the one outcome the pane cannot show.
 */
export function parseReleaseNotes(notes: string, lang: ReleaseNotesLang): ParsedReleaseNotes {
  const segments = notes.split(EN_MARKER);
  const picked = lang === "en" && segments.length > 1 ? 1 : 0;
  const parsed = parseBody(cutFooter(segments[picked] ?? ""));
  if (isEmpty(parsed) && segments.length > 1) {
    return parseBody(cutFooter(segments[picked === 0 ? 1 : 0] ?? ""));
  }
  return parsed;
}
