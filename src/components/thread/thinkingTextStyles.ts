// The rendered thinking text block's shared class string (issue #1658):
// the ThinkingFold's expanded body and the activity line's streaming
// block render the identical muted, scroll-capped box -- one constant so
// the two faces cannot drift.

export const THINKING_TEXT_CLASS =
  "round-thinking m-0 mt-0.5 ml-5 rounded-md bg-muted p-2 text-xs text-muted-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto";
