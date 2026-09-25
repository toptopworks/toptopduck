import { FormattedMessage, useIntl } from "react-intl";
import { Puzzle, Trash2 } from "lucide-react";

import type { SkillAcquired, SkillEntry } from "../../types/skills";
import { Switch } from "../ui/switch";
import { NameBadge, RowActionButton } from "./settings-chrome";

// The skills pane's row-render family (issue #1083): the normal row, the
// acquired-axis label it shares with the detail dialog, and the
// materialization-failure stand-in row. Pure presentation -- every write
// rides the container's callbacks.

// The row is list chrome (hover highlight + layout); the text block is the
// detail affordance (click / Enter opens the read-only dialog) and every
// write action lives in the row-end cluster -- never on the text block.
const ROW_CLASS = "hover:bg-accent flex items-center gap-3 px-4 py-3";

/** The acquired axis's locale label: the row badge and the detail dialog's
 *  scope value share the one vocabulary -- no second word for the same
 *  axis. */
export function AcquiredLabel({ acquired }: { acquired: SkillAcquired }) {
  return acquired === "linked" ? (
    <FormattedMessage
      id="settings.skills.acquiredLinked"
      defaultMessage="linked"
    />
  ) : acquired === "builtin" ? (
    <FormattedMessage
      id="settings.skills.acquiredBuiltin"
      defaultMessage="system"
    />
  ) : (
    <FormattedMessage
      id="settings.skills.acquiredLocal"
      defaultMessage="local"
    />
  );
}

type SkillRowProps = {
  skill: SkillEntry;
  /** The enablement switch is mid-flight on this row: gate this row's
   *  switch (the per-row gate, the AgentsSection #932 precedent). */
  busy?: boolean;
  /** Flip the row's enablement axis (issue #961). */
  onToggleEnabled: (enabled: boolean) => void;
  /** Open the row's read-only detail dialog (name + description + the
   *  SKILL.md path bar). */
  onOpen: () => void;
  /** Undefined on builtin rows (issue #677): the delete button then renders
   *  disabled, keeping every row's action column aligned. */
  onDelete?: () => void;
};

export function SkillRow({
  skill,
  busy = false,
  onToggleEnabled,
  onOpen,
  onDelete,
}: SkillRowProps) {
  const intl = useIntl();
  return (
    <div
      data-testid="skill-row"
      // Dormant-on-disable gray-out (issue #961): the whole row reads
      // faded, switch and actions dimmed with it (management stays
      // operable -- disabling hides from discovery, not from management)
      // and carries data-disabled as the test/styling hook.
      className={`${ROW_CLASS} ${skill.enabled ? "" : "opacity-60"}`}
      data-disabled={skill.enabled ? undefined : "true"}
    >
      <Puzzle className="text-muted-foreground size-4 shrink-0" aria-hidden />
      {/* The detail target is the text block alone (the retired edit
          drawer's old posture, now opening a read-only face): the row's
          clickable area stops before the action cluster. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className="min-w-0 flex-1 cursor-pointer outline-none focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          <NameBadge>
            <AcquiredLabel acquired={skill.acquired} />
          </NameBadge>
          {skill.covers_builtin && (
            <NameBadge>
              <FormattedMessage
                id="settings.skills.coversBuiltin"
                defaultMessage="covers built-in"
              />
            </NameBadge>
          )}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {skill.description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Switch
          className="mr-1.5"
          checked={skill.enabled}
          disabled={busy}
          onCheckedChange={onToggleEnabled}
          aria-label={intl.formatMessage(
            {
              id: "settings.skills.enabledLabel",
              defaultMessage: "Enable skill {name}",
            },
            { name: skill.name },
          )}
        />
        {/* The row-end delete renders in every state (disabled on builtin,
            issue #677) so the switch column never shifts across rows. The
            external-edit channel lives in the detail dialog's SKILL.md path
            bar (issue #1033) -- the row itself stays management-only. */}
        <RowActionButton
          destructive
          disabled={!onDelete}
          label={intl.formatMessage(
            {
              id: "settings.skills.deleteLabel",
              defaultMessage: "Delete skill {name}",
            },
            { name: skill.name },
          )}
          icon={Trash2}
          onClick={onDelete}
          // The shutdown guidance at the real touchpoint (#1015): the
          // disabled delete explains itself instead of dead-ending --
          // the reachable off-action is the enablement-axis switch on
          // this row (ADR-0118), true for every builtin (knowledge-only
          // skills like vega-chart have no companion CLI to point at).
          tooltip={
            skill.acquired === "builtin"
              ? intl.formatMessage({
                  id: "settings.skills.deleteDisabledHint",
                  defaultMessage:
                    "System skills cannot be deleted; disable the skill instead",
                })
              : undefined
          }
        />
      </div>
    </div>
  );
}

/** One materialization-failure row (issue #1016): the CLI pane's
 *  conflict-row shape (issue #675) carried over as the skills pane's
 *  warning lane -- the #937 agents-pane precedent for surfacing
 *  materialization failures. The skill never landed on disk, so the
 *  listing has no row for it -- this one stands in with the failure
 *  category and the self-heal hint. No open/edit affordance: there is
 *  nothing on disk to edit. */
export function SkillMaterializeFailureRow({ name }: { name: string }) {
  return (
    <div
      data-testid={`skill-materialize-failure-row-${name}`}
      className={ROW_CLASS}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{name}</div>
        <p className="text-destructive mt-1 text-xs">
          <FormattedMessage
            id="settings.skills.materializeFailureHint"
            defaultMessage="Couldn't write this built-in skill to disk. Check that the skills folder is writable and has disk space; the next scan retries."
          />
        </p>
      </div>
      {/* The DESIGN.md badge token (the CLI conflict row's shape):
       * typography.badge on rounded.md, the destructive coloring marking
       * the failed write. */}
      <span className="bg-muted text-destructive shrink-0 rounded-md px-2 py-0.5 text-xs font-medium leading-none">
        <FormattedMessage
          id="settings.skills.materializeFailureBadge"
          defaultMessage="Write failed"
        />
      </span>
    </div>
  );
}
