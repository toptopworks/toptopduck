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

/** The inverse of `parseArgGroups`: re-quote each token so the text parses
 *  back to the same argv (an open-edit-save round-trip must not silently
 *  regroup `["two words"]` into two tokens). Wraps in the quote character
 *  the token does not itself contain; a token carrying BOTH quote kinds has
 *  no lossless spelling in this syntax (hand-edited JSON only) and degrades
 *  to whatever `parseArgGroups` makes of the emitted text, visibly. */
export function formatArgGroups(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg.includes(`"`)) return `'${arg}'`;
      if (arg.length === 0 || /[\s']/.test(arg)) return `"${arg}"`;
      return arg;
    })
    .join(" ");
}
