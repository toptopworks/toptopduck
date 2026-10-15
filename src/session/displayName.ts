import type { IntlShape } from "react-intl";

/** Resolve a session's display name, falling back to the localized default
 *  ("New session") when blank (ADR-0060). Shared by the sidebar + the search
 *  modal so the fallback string + message id live in one place instead of a
 *  per-surface helper. */
export function resolveDisplayName(name: string, intl: IntlShape): string {
  return (
    name || intl.formatMessage({ id: "session.defaultName", defaultMessage: "New session" })
  );
}
