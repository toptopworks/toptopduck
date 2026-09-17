// The shared search-match core (issue #978, ADR-0112 Decision 5): the
// case-insensitive substring match that the settings search boxes apply to
// a pane's searchable text and the composer skill picker applies per field.
// The match lives in exactly one place so the surfaces cannot drift apart --
// callers must not re-implement the normalization inline. The query is
// trimmed and both sides are lower-cased here; an empty or whitespace-only
// query matches everything.
export function searchMatcher(query: string): (text: string) => boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return () => true;
  return (text) => text.toLowerCase().includes(q);
}
