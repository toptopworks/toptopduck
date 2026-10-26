// The workspace-name guard shared by the two naming faces (issue #1393's
// create modal in the selector, issue #1392's rename modal in the sidebar):
// the frontend mirror of the backend's mint_named_workspace validation.
// The trust boundary splits by face: the MINT path re-validates the full
// rule server-side (the name becomes a directory); rename_workspace
// re-validates trim + non-empty only (the title is display-only), so on
// the rename face THIS guard is the full rule's only enforcer. Rejecting
// beats rewriting -- a rewritten name would not match the directory the
// user expects to find.

/** The name cap for a named workspace (issue #1393). */
const WORKSPACE_NAME_MAX_CHARS = 64;

/** Whether a name carries a control or path-illegal character (issue
 *  #1393): a code-point walk, not a regex -- the control range is a linted
 *  pattern face better kept explicit. The control set mirrors Rust's
 *  char::is_control(): C0, DEL, and C1. */
function hasIllegalWorkspaceNameChar(name: string): boolean {
  for (const c of name) {
    const code = c.codePointAt(0)!;
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      "\\/:*?\"<>|".includes(c)
    ) {
      return true;
    }
  }
  return false;
}

/** The full naming guard (issue #1393, trailing dot added by the #1393
 *  review): empty after trimming, over the cap, ending in a dot, or
 *  carrying a path-illegal/control character. */
export function isInvalidWorkspaceName(name: string): boolean {
  return (
    name.length === 0 ||
    // Code points, matching the backend's chars().count().
    [...name].length > WORKSPACE_NAME_MAX_CHARS ||
    // A trailing dot: dot-only names resolve to the root or its parent, and
    // Win32 strips a trailing dot at create time (the disk would disagree
    // with the recorded title).
    name.endsWith(".") ||
    hasIllegalWorkspaceNameChar(name)
  );
}
