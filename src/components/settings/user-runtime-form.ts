// Pure form helpers for the user-defined runtime editor (issue #1341).
// Non-component exports live here, not in UserRuntimesSection.tsx, so the
// component file stays react-refresh-clean (the mcp-mirror / settings-filters
// pattern).

/** Split an args input into argv groups: whitespace-separated, with quoted
 *  segments kept together (issue #1341 -- the form's quote-grouped args
 *  parsing). Unbalanced quotes are a form error: returns null so the caller
 *  can block save with a message instead of guessing the user's intent. */
export function parseArgGroups(input: string): string[] | null {
  const out: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let sawQuotes = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === "\"" || ch === "'") {
      quote = ch;
      sawQuotes = true;
    } else if (ch === " " || ch === "\t") {
      if (current || sawQuotes) {
        out.push(current);
        current = "";
        sawQuotes = false;
      }
    } else {
      current += ch;
    }
  }
  if (quote !== null) return null;
  if (current || sawQuotes) out.push(current);
  return out;
}

/** The command field's validity rule, mirrored from the backend boundary:
 *  one non-empty token, no whitespace, no quote characters. */
export function isSingleTokenCommand(command: string): boolean {
  return command.length > 0 && !/[\s"']/.test(command);
}
