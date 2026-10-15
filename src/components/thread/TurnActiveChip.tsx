// The dataset active chip (ADR-0047): the app's read that the question
// explicitly named a working-set dataset, rendered as a badge chip in the
// stream header. Shared by the settled stream header (TurnCard) and the live
// exchange's header (issue #620) so the settle swap keeps the chip in place
// instead of inserting it at settle time.

import { FormattedMessage } from "react-intl";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DatasetLabel } from "./turn-visual";

export function TurnActiveChip({ dataset }: { dataset: DatasetLabel }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Badge default = teal --primary (ADR-0050 active semantic); the
            turn-active-chip class carries layout only (flex-shrink,
            8rem tail-ellipsis + the test selector), the variant owns the
            color so the chip recolors with .dark alongside the token. */}
        <Badge variant="default" className="turn-active-chip shrink-0 max-w-32 truncate">
          →{dataset.display_name}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <FormattedMessage
          id="thread.activeChip.title"
          defaultMessage={`Question names "{name}"`}
          values={{ name: dataset.display_name }}
        />
      </TooltipContent>
    </Tooltip>
  );
}
