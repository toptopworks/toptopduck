import type { ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { ChevronDown, Info } from "lucide-react";

import { fmtError } from "../../lib/error-presentation";
import type { SaveError } from "../../types/session";
import type { CatalogModel } from "../../types/runtime";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

// The next-turn posture text button (ADR-0099 Decision 3, issue #574/#573): a
// resident text control seated BEFORE the runtime trigger on the QuestionBar
// row. Its label is the posture readout computed by the picker (built-in:
// active profile model / "Not configured"; external: "{model} · {strength}",
// either dimension alone, or "Default (recommended)"). The turn-end live
// currents never touch the label (issue #586): while nothing is selected,
// the label keeps its default copy and the tooltip carries what the last
// turn actually ran. Without a catalog
// (built-in,
// or an external CLI never probed/discovered) it renders as a static
// label with no arrow -- never a button pretending to be clickable; with a
// catalog it opens the cascade menu (dropdown-menu Sub primitive): two
// first-level rows (Model / Thinking) showing the current value inline, each
// opening a second-level menuitemradio list (aria-checked carries the
// current selection, issue #584) with a leading "Default (recommended)"
// clearing row and the honest synthetic row for a held value the catalog
// does not offer (issue #529). Item selection keeps the menu open
// (preventDefault) so the checked state updates and the fault lines below
// stay visible -- the fault surfaces that rode the old popover's selector
// body.
export type ComposerPostureTriggerProps = {
  // The posture display label, already formatted by the picker.
  label: string;
  // The catalog driving the cascade menu; null = static label (no arrow).
  catalog: PostureCatalog | null;
  // The turn-end live currents (issue #586): what the last turn actually
  // ran, read off the session discovery cache while nothing is selected.
  // Non-null mounts the tooltip that carries the live readout (the label
  // itself keeps its default copy); null renders no tooltip. An explicit
  // selection outranks the live read.
  liveValue: string | null;
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
  liveValue,
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

  // The trigger button, hoisted so the live state can wrap it in a tooltip
  // without duplicating the markup (the Tooltip > DropdownMenuTrigger
  // composition mirrors the runtime trigger's Tooltip > PopoverTrigger).
  const triggerButton = (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      className="composer-posture-trigger inline-flex h-9 max-w-52 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-sm text-foreground transition-colors hover:bg-muted cursor-pointer disabled:pointer-events-none disabled:opacity-50"
    >
      {/* Hides the posture label when the question-bar @container
          drops below the narrow-rail threshold, leaving the
          chevron-only button (aria-label keeps the full readout) --
          the same collapse the auth-mode chip's label performs
          (LABEL_HIDE_NARROW). */}
      <span className="@max-[320px]:hidden truncate">{label}</span>
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );

  return (
    <>
      {catalogNote === "from-probe" && <ProbeCatalogInfoIcon />}
      <DropdownMenu>
        {liveValue != null ? (
          // The live readout's only surface (issue #586): the label keeps
          // its default copy, so the tooltip carries what the last turn
          // actually ran.
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-64">
              <FormattedMessage
                id="composer.postureTrigger.liveTooltip"
                defaultMessage="{value} (last turn)"
                values={{ value: liveValue }}
              />
            </TooltipContent>
          </Tooltip>
        ) : (
          <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
        )}
        <DropdownMenuContent align="end" className="w-60">
          {catalogNote === "stale-runtime" && (
            <p className="text-warning px-2 py-1 text-xs">
              <FormattedMessage
                id="composer.runtimePicker.staleCatalog"
                defaultMessage="These options were discovered on a different runtime — they will refresh after this runtime's next turn."
              />
            </p>
          )}
          <DimensionSub
            label={(
              <FormattedMessage
                id="composer.runtimePicker.modelLabel"
                defaultMessage="Model"
              />
            )}
            displayValue={heldModel}
            clearLabel={modelClearLabel}
            unrepresentedId={unrepresentedModelId}
            ids={modelIds}
            selectedId={model}
            onSelect={onSelectModel}
          />
          <DimensionSub
            label={(
              <FormattedMessage
                id="composer.runtimePicker.thoughtLevelLabel"
                defaultMessage="Thinking"
              />
            )}
            displayValue={heldLevel}
            clearLabel={levelClearLabel}
            unrepresentedId={unrepresentedLevelId}
            ids={levelIds}
            selectedId={thoughtLevel}
            unavailable={levelUnavailable}
            onSelect={onSelectThoughtLevel}
          />
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

// One cascade dimension (ADR-0099 Decision 3): a first-level row (label +
// the inline current value) opening the second-level radio list -- the
// leading "Default (recommended)" clearing row, the honest synthetic row
// for a held value the directory does not offer (#529), and the directory
// itself as menuitemradio rows whose checked state the group value carries
// (readable to screen readers, unlike the retired aria-hidden check icon,
// issue #584).
function DimensionSub({
  label,
  displayValue,
  clearLabel,
  unrepresentedId,
  ids,
  selectedId,
  onSelect,
  unavailable = false,
}: {
  label: ReactNode;
  displayValue: string | null;
  clearLabel: string;
  unrepresentedId: string | null;
  ids: string[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  unavailable?: boolean;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={unavailable}>
        {label}
        {unavailable ? (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-right text-xs">
            <FormattedMessage
              id="composer.runtimePicker.pickModelFirst"
              defaultMessage="Pick a model first."
            />
          </span>
        ) : (
          <InlineValue value={displayValue} />
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {!unavailable && (
          // Permanently controlled ("" = nothing selected): the radio value
          // must never fall back to an uncontrolled internal state.
          <DropdownMenuRadioGroup value={selectedId ?? ""}>
            <ClearingItem label={clearLabel} onClear={() => onSelect(null)} />
            {unrepresentedId != null && (
              <OptionItem
                id={unrepresentedId}
                onSelect={() => onSelect(unrepresentedId)}
                unrepresented
              />
            )}
            {ids.map((id) => (
              <OptionItem key={id} id={id} onSelect={() => onSelect(id)} />
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// One second-level option row: a menuitemradio whose checked state rides
// the group value. Selecting keeps the menu open (preventDefault) so the
// checked mark updates and the fault lines below stay in view.
function OptionItem({
  id,
  onSelect,
  unrepresented = false,
}: {
  id: string;
  onSelect: () => void;
  unrepresented?: boolean;
}) {
  return (
    <DropdownMenuRadioItem
      value={id}
      onSelect={(e) => {
        e.preventDefault();
        onSelect();
      }}
    >
      {unrepresented ? (
        <FormattedMessage
          id="composer.runtimePicker.unrepresentedModel"
          defaultMessage="{id} (not offered by this runtime)"
          values={{ id }}
        />
      ) : (
        id
      )}
    </DropdownMenuRadioItem>
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
