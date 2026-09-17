// The shared search-match core (issue #978, ADR-0112 Decision 5): the
// case-insensitive substring match that the settings search boxes apply to
// a pane's searchable text and the composer skill picker applies per field.
// The match lives in exactly one place so the surfaces cannot drift apart --
// callers must not re-implement the normalization inline. The query is
// trimmed and both sides are lower-cased here; an empty or whitespace-only
// query matches everything. The picker's hit highlighting rides the same
// two halves (the needle and the lower-cased haystack), so a future core
// change lands for matching and highlighting together.

/** The normalized needle behind a raw search query: trimmed and
 *  lower-cased. null marks the empty / whitespace-only query that matches
 *  everything and highlights nothing. */
export function normalizeSearchQuery(query: string): string | null {
  const q = query.trim().toLowerCase();
  return q === "" ? null : q;
}

/** The first case-insensitive occurrence of the normalized query in `text`,
 *  or -1. `text` is lower-cased here -- call sites pass raw text. */
function findQueryMatch(text: string, normalizedQuery: string): number {
  return text.toLowerCase().indexOf(normalizedQuery);
}

/** Every case-insensitive occurrence of the normalized query in `text`, in
 *  order. `text` is lower-cased once here, whatever the hit count -- call
 *  sites pass raw text. The returned indices are valid against `text`
 *  itself, which is what lets the picker wrap each hit's own casing. */
export function findQueryMatches(
  text: string,
  normalizedQuery: string,
): number[] {
  const lower = text.toLowerCase();
  const hits: number[] = [];
  let at = lower.indexOf(normalizedQuery);
  while (at !== -1) {
    hits.push(at);
    at = lower.indexOf(normalizedQuery, at + normalizedQuery.length);
  }
  return hits;
}

/** The boolean face of the core: whether `text` contains the raw query,
 *  case-insensitively. An empty or whitespace-only query matches
 *  everything. */
export function searchMatcher(query: string): (text: string) => boolean {
  const q = normalizeSearchQuery(query);
  if (q === null) return () => true;
  return (text) => findQueryMatch(text, q) !== -1;
}
