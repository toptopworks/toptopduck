import { FormattedMessage, useIntl } from "react-intl";
import { Check, ChevronDown, Info } from "lucide-react";

import { cn } from "@/lib/utils";
import { fmtError } from "../../lib/error-presentation";
import type { SaveError } from "../../types/session";
import type { CatalogModel } from "../../types/runtime";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

// The next-turn posture text button (ADR-0099 Decision 3, issue #574/#573): a
// resident text control seated BEFORE the runtime trigger on the QuestionBar
// row. Its label is the four-state readout computed by the picker (built-in:
// active profile model / "Not configured"; external: "{model} · {strength}"
// when selected, else "Default (recommended)"). Without a catalog (built-in,
// or an external CLI never probed/discovered) it renders as a static
// label with no arrow -- never a button pretending to be clickable; with a
// catalog it opens the cascade menu (dropdown-menu Sub primitive): two
// first-level rows (Model / Thinking) showing the current value inline, each
// opening a second-level list with a leading "Default (recommended)" clearing
// row, a check on the current item, and the honest synthetic row for a held
// value the catalog does not offer (issue #529). Item selection keeps the
// menu open (preventDefault) so the ✓ updates and the fault lines below stay
// visible -- the fault surfaces that rode the old popover's selector body.
export type ComposerPostureTriggerProps = {
  // The four-state display label, already formatted by the picker.
  label: string;
  // The catalog driving the cascade menu; null = static label (no arrow).
  catalog: PostureCatalog | null;
  // The held model / thought-level pair the label + menu reflect (the
  // session's modelConfig, or the cold-start pending ?? backfill posture).
  model: string | null;
  thoughtLevel: string | null;
  onSelectModel: (model: string | null) => void;
  onSelectThoughtLevel: (thoughtLevel: string | null) => void;
  // A model-config read failure (issue #529): rendered as an inline
  // destructive status line instead of a menu -- an IPC failure must not
  // masquerade as "Default (recommended)".
  configFault: unknown;
  // The set-IPC reject (raw) + the persist verdicts from the last
  // successful set (issue #529), rendered inside the menu body.
  setFault: unknown;
  persistFault: SaveError | null;
  persistSuspended: boolean;
  // The honest provenance note (issue #529) for the ACP catalog's source.
  // The two states are complementary predicates over the picker's
  // `discovered` cache (stale requires a session-owned discovery, probe-fed
  // requires none), so they ride one prop: "stale-runtime" renders the
  // inline warning line at the top of the menu; "from-probe" renders the
  // info-icon tooltip on the bar row before the trigger button; null
  // renders nothing.
  catalogNote: CatalogNote;
  disabled: boolean;
};

// The catalog the cascade menu offers, discriminated by source (ADR-0096 D6):
// "acp" is the flat handshake catalog (independent model / thought-level
// lists + the CLI-reported currents); "perModel" is the probe cache's
// per-model catalog, whose thought-level list is the SELECTED model's
// supported efforts in the CLI's declared order.
export type PostureCatalog =
  | {
    kind: "acp";
    models: string[];
    thoughtLevels: string[];
    currentModel: string | null;
    currentThoughtLevel: string | null;
  }
  | { kind: "perModel"; models: CatalogModel[] };

// The catalog provenance note kind (see ComposerPostureTriggerProps):
// which of the two honest-source explanations, if any, applies.
export type CatalogNote = "stale-runtime" | "from-probe" | null;

export function ComposerPostureTrigger({
  label,
  catalog,
  model,
  thoughtLevel,
  onSelectModel,
  onSelectThoughtLevel,
  configFault,
  setFault,
  persistFault,
  persistSuspended,
  catalogNote,
  disabled,
}: ComposerPostureTriggerProps) {
  const intl = useIntl();

  // Honest read failure (issue #529): the inline error line replaces the
  // control entirely -- no menu to build, no default label to fake.
  if (configFault != null) {
    return (
      <span role="status" className="text-destructive max-w-40 truncate text-xs">
        {fmtError(configFault, intl)}
      </span>
    );
  }

  // Static label (ADR-0099 Decision 3): no catalog, no arrow, not a button.
  if (catalog === null) {
    return (
      <span className="text-muted-foreground max-w-44 truncate text-sm">
        {label}
      </span>
    );
  }

  const ariaLabel = intl.formatMessage(
    { id: "composer.postureTrigger.ariaLabel", defaultMessage: "Model: {label}" },
    { label },
  );
  const defaultLabel = intl.formatMessage({
    id: "composer.postureTrigger.default",
    defaultMessage: "Default (recommended)",
  });

  // Normalize the catalog into one directory shape (the acp / perModel
  // dispatch happens once, not per consumer below): the model ids, the
  // CLI-reported current per dimension, and -- perModel only -- the SELECTED
  // model's supported efforts (null/unknown model = none; the flagged
  // default model is the model dimension's effective current).
  let modelIds: string[];
  let currentModel: string | null;
  let levelIds: string[];
  let currentLevel: string | null;
  // perModel without a model pick has no honest level list (issue #537):
  // the row disables with the pick-a-model hint instead of a union list.
  let levelUnavailable = false;
  if (catalog.kind === "acp") {
    modelIds = catalog.models;
    currentModel = catalog.currentModel;
    levelIds = catalog.thoughtLevels;
    currentLevel = catalog.currentThoughtLevel;
  } else {
    modelIds = catalog.models.map((m) => m.id);
    currentModel = catalog.models.find((m) => m.is_default)?.id ?? null;
    const selected =
      model != null ? (catalog.models.find((m) => m.id === model) ?? null) : null;
    levelIds = selected?.supported_reasoning_efforts ?? [];
    currentLevel = selected?.default_reasoning_effort ?? null;
    levelUnavailable = model == null;
  }

  // The synthetic row for a value the catalog does not offer (#529): the
  // HELD value -- the explicit selection, else the CLI-reported current the
  // next turn would actually run (the retired select's held chain). Keeps
  // the menu honest about an active posture it cannot otherwise show, and
  // selectable so the user can adopt it explicitly.
  const heldModel = model ?? currentModel;
  const heldLevel = thoughtLevel ?? currentLevel;
  const unrepresentedModelId =
    heldModel != null && heldModel !== "" && !modelIds.includes(heldModel)
      ? heldModel
      : null;
  const unrepresentedLevelId =
    heldLevel != null && heldLevel !== "" && !levelIds.includes(heldLevel)
      ? heldLevel
      : null;

  // Inline current values for the two first-level rows.
  const modelRowValue = heldModel;
  const levelRowValue = heldLevel;

  // The clearing row at the top of each second-level list: "Default
  // (recommended)" -- annotated with the CLI's reported current so the user
  // can tell what the unselected state would actually run (the SelectorOptions
  // annotation, moved to the clearing row).
  const modelClearLabel =
    currentModel && model == null ? `${defaultLabel} (${currentModel})` : defaultLabel;
  const levelClearLabel =
    currentLevel && thoughtLevel == null
      ? `${defaultLabel} (${currentLevel})`
      : defaultLabel;

  return (
    <>
      {catalogNote === "from-probe" && <ProbeCatalogInfoIcon />}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={ariaLabel}
            className="composer-posture-trigger inline-flex h-9 max-w-52 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-sm text-foreground transition-colors hover:bg-muted cursor-pointer disabled:pointer-events-none disabled:opacity-50"
          >
            {/* Hides the four-state label when the question-bar @container
                drops below the narrow-rail threshold, leaving the
                chevron-only button (aria-label keeps the full readout) --
                the same collapse the auth-mode chip's label performs
                (LABEL_HIDE_NARROW). */}
            <span className="@max-[320px]:hidden truncate">{label}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {catalogNote === "stale-runtime" && (
            <p className="text-warning px-2 py-1 text-xs">
              <FormattedMessage
                id="composer.runtimePicker.staleCatalog"
                defaultMessage="These options were discovered on a different runtime — they will refresh after this runtime's next turn."
              />
            </p>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FormattedMessage
                id="composer.runtimePicker.modelLabel"
                defaultMessage="Model"
              />
              <InlineValue value={modelRowValue} />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <ClearingItem label={modelClearLabel} onClear={() => onSelectModel(null)} />
              {unrepresentedModelId != null && (
                <OptionItem
                  id={unrepresentedModelId}
                  selected={model === unrepresentedModelId}
                  onSelect={() => onSelectModel(unrepresentedModelId)}
                  unrepresented
                />
              )}
              {modelIds.map((id) => (
                <OptionItem
                  key={id}
                  id={id}
                  selected={model === id}
                  onSelect={() => onSelectModel(id)}
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={levelUnavailable}>
              <FormattedMessage
                id="composer.runtimePicker.thoughtLevelLabel"
                defaultMessage="Thinking"
              />
              {levelUnavailable ? (
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-right text-xs">
                  <FormattedMessage
                    id="composer.runtimePicker.pickModelFirst"
                    defaultMessage="Pick a model first."
                  />
                </span>
              ) : (
                <InlineValue value={levelRowValue} />
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {!levelUnavailable && (
                <>
                  <ClearingItem
                    label={levelClearLabel}
                    onClear={() => onSelectThoughtLevel(null)}
                  />
                  {unrepresentedLevelId != null && (
                    <OptionItem
                      id={unrepresentedLevelId}
                      selected={thoughtLevel === unrepresentedLevelId}
                      onSelect={() => onSelectThoughtLevel(unrepresentedLevelId)}
                      unrepresented
                    />
                  )}
                  {levelIds.map((id) => (
                    <OptionItem
                      key={id}
                      id={id}
                      selected={thoughtLevel === id}
                      onSelect={() => onSelectThoughtLevel(id)}
                    />
                  ))}
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <SelectorFaultLines
            setFault={setFault}
            persistFault={persistFault}
            persistSuspended={persistSuspended}
            intl={intl}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

// The probe-catalog provenance glyph seated BEFORE the posture trigger
// button on the bar row: hover (or focus) the info icon to read why the
// directory lists the settings-test catalog. Mounts bare under the
// app-wide TooltipProvider (App.tsx), like every other tooltip site.
function ProbeCatalogInfoIcon() {
  const intl = useIntl();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={intl.formatMessage({
            id: "composer.runtimePicker.catalogFromProbeAria",
            defaultMessage: "Catalog source explanation",
          })}
          className="text-muted-foreground mr-1 flex shrink-0 cursor-default"
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-64">
        <FormattedMessage
          id="composer.runtimePicker.catalogFromProbe"
          defaultMessage="Options from your last settings test — this runtime's live list appears after its next turn."
        />
      </TooltipContent>
    </Tooltip>
  );
}

// The current-value tail on a first-level row (muted, right-aligned inside
// the sub trigger). Two layers: the wrapper takes the row's remaining width
// (so the value hugs the chevron at the right edge), the inner span caps the
// value's own width -- a long model id ellipsizes instead of stretching to
// the row's end.
function InlineValue({ value }: { value: string | null }) {
  if (value == null) return null;
  return (
    <span className="flex min-w-0 flex-1 justify-end">
      <span className="text-muted-foreground max-w-36 truncate text-xs">
        {value}
      </span>
    </span>
  );
}

// One second-level option row: the id plus a check on the current item.
// Selecting keeps the menu open (preventDefault) so the check updates and
// the fault lines below stay in view.
function OptionItem({
  id,
  selected,
  onSelect,
  unrepresented = false,
}: {
  id: string;
  selected: boolean;
  onSelect: () => void;
  unrepresented?: boolean;
}) {
  return (
    <DropdownMenuItem
      data-selected={selected}
      onSelect={(e) => {
        e.preventDefault();
        onSelect();
      }}
    >
      <Check
        className={cn("size-4", !selected && "invisible")}
        aria-hidden
      />
      {unrepresented ? (
        <FormattedMessage
          id="composer.runtimePicker.unrepresentedModel"
          defaultMessage="{id} (not offered by this runtime)"
          values={{ id }}
        />
      ) : (
        id
      )}
    </DropdownMenuItem>
  );
}

// The leading "Default (recommended)" row: clears the dimension's selection
// (the CLI's own default rules the next turn; ADR-0098/0100 anchor the label
// to never-selected-or-cleared).
function ClearingItem({
  label,
  onClear,
}: {
  label: string;
  onClear: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        onClear();
      }}
    >
      {label}
    </DropdownMenuItem>
  );
}

// The set-IPC fault lines (issue #529), carried over from the retired
// popover selector body: one surface for both set IPCs.
function SelectorFaultLines({
  setFault,
  persistFault,
  persistSuspended,
  intl,
}: {
  setFault: unknown;
  persistFault: SaveError | null;
  persistSuspended: boolean;
  intl: ReturnType<typeof useIntl>;
}) {
  return (
    <>
      {setFault != null && (
        <p className="text-destructive px-2 py-1 text-xs">
          <FormattedMessage
            id="composer.runtimePicker.applyError"
            defaultMessage="Could not apply the selection: {reason}"
            values={{ reason: fmtError(setFault, intl) }}
          />
        </p>
      )}
      {persistFault && (
        <p className="text-warning px-2 py-1 text-xs">
          <FormattedMessage
            id="composer.runtimePicker.persistFault"
            defaultMessage="Selection not saved: {reason}"
            values={{ reason: fmtError(persistFault, intl) }}
          />
        </p>
      )}
      {persistSuspended && (
        <p className="text-warning px-2 py-1 text-xs">
          <FormattedMessage
            id="composer.runtimePicker.persistSuspended"
            defaultMessage="Selection not saved: the session file was changed outside the app, so autosave is paused until you resolve the conflict."
          />
        </p>
      )}
    </>
  );
}
