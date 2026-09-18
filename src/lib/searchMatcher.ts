// The shared search-match core (issue #978, ADR-0112 Decision 5): the
// case-insensitive substring match shared by the settings search boxes (a
// pane's searchable text), the composer skill picker (per field), and the
// sidebar's jump-to-session search (a composed per-row haystack, per
// ADR-0072). The match lives in exactly one place so the surfaces cannot
// drift apart -- their callers must not re-implement the normalization
// inline. The query is trimmed and both sides are lower-cased here; an
// empty or whitespace-only query matches everything.
// The picker's hit highlighting rides the same two halves (the needle and
// the lower-cased haystack), so a future core change lands for matching
// and highlighting together.

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
 *  sites pass raw text, the needle as `normalizeSearchQuery` returns it (a
 *  null needle is the match-all query and yields no hits, and so does an
 *  empty one, which would otherwise never advance the scan). Where
 *  lower-casing preserves the haystack's length -- every input except a
 *  handful of special-cased code points -- the returned indices are valid
 *  against `text` itself, which is what lets the picker wrap each hit's
 *  own casing; a fold that changes the length shifts the indices past the
 *  fold point, so it degrades to no hits rather than highlighting the
 *  wrong characters. */
export function findQueryMatches(
  text: string,
  normalizedQuery: string | null,
): number[] {
  if (normalizedQuery == null || normalizedQuery === "") return [];
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return [];
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
