// The chip face (issue #1575): the one class string both chip species
// wear everywhere they mount -- the composer row and the sent bubble's
// question paragraph alike. DESIGN.md's `chip` component entry is the
// canonical description; this constant is its single carrier (the third
// copy triggered the extraction). The bubble-side top-ups (chip spacing
// and vertical alignment) are the question paragraph's own variants,
// never part of the face.

export const CHIP_FACE =
  "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-chip-surface px-1.5 leading-5 text-[13px] font-medium text-secondary-foreground";
