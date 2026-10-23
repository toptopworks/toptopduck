// The per-turn runtime attribution marker (ADR-0101, issue #818): a muted
// one-line caption opening EVERY external turn's assistant stream, so a
// mid-thread scan can tell who ran each turn (the retired segment-start form
// announced only attribution changes). Only a runtime that can name its
// adapter renders -- the built-in default and both unrecorded shapes stay
// silent, so an unmarked stretch reads as the default runtime. The label is
// a three-tier resolve (issue #1351): the live adapter table's current
// display name (rename follows in real time; the shared adapterKeys.all()
// cache every picker already reads, deduped by key), else the stamp-time
// name persisted on the turn (the tombstone for a deleted or disabled
// adapter), else the raw id (the honest floor -- turns recorded before the
// name rode the wire). No vendor logos (ADR-0101 leaves iconography to
// DESIGN.md). DESIGN.md self-audit: deliberately NOT the badge recipe (its
// capsule + medium weight would shout on every turn head) -- this is the
// drift-badge family of quiet muted captions, tokens only.

import { useQuery } from "@tanstack/react-query";
import { Terminal } from "lucide-react";
import { listAdapters } from "../../api";
import { adapterKeys } from "../../session/queryKeys";

export function RuntimeAttributionMarker({
  adapterId,
  persistedName,
}: {
  adapterId: string;
  persistedName: string | null;
}) {
  const { data: adapters } = useQuery({
    queryKey: adapterKeys.all(),
    queryFn: listAdapters,
  });
  const label =
    adapters?.find((a) => a.id === adapterId)?.display_name ?? persistedName ?? adapterId;
  return (
    <p className="runtime-attribution m-0 mb-0.5 flex items-center gap-1 text-xs text-muted-foreground">
      <Terminal aria-hidden="true" className="h-3 w-3 shrink-0" />
      {label}
    </p>
  );
}
