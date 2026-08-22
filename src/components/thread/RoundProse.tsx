// The round's connective prose paragraph (ADR-0103): always expanded -- prose
// is the conversational discourse, folding it would hide the narrative.
// Shared by the settled round block (TurnCard) and the live round block
// (LiveTurnExchange, issue #610) so the settle swap renders the identical
// markup instead of a copy kept in sync by discipline.

export function RoundProse({ text }: { text: string }) {
  return (
    <p className="round-text m-0 mt-0.5 text-sm leading-snug text-foreground whitespace-pre-wrap break-words">
      {text}
    </p>
  );
}
