// Composer-domain shared visual constants (the QuestionBar trigger row's
// chips and labels). Stateless values only -- no React; mirrors turn-visual.ts
// on the thread side.

// Hides a trigger/chip label when the QuestionBar @container (set on the bar
// form) drops below the narrow-rail threshold, leaving the icon or chevron
// visible (issue #482). Consumed by the auth-mode chip, the MCP and Skills
// triggers, and both posture-trigger label forms. The value must stay a
// single intact string -- Tailwind v4 emits the utility from source scanning,
// so splitting it or deriving it dynamically would drop it from the build.
export const LABEL_HIDE_NARROW = "@max-[320px]:hidden";
