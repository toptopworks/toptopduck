import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { ChevronDown, Info } from "lucide-react";

import { fmtError } from "../../lib/error-presentation";
import { usePointerCloseIntent } from "../../lib/usePointerCloseIntent";
import type { SaveError } from "../../types/session";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { Input } from "../ui/input";
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
import { LABEL_HIDE_NARROW } from "./composer-visual";
import {
  deriveDimensionRows,
  derivePostureDirectory,
  type CatalogNote,
  type PostureCatalog,
} from "./posture-directory";

// The next-turn posture text button (ADR-0099 Decision 3, issue #574/#573):
// a resident text control seated BEFORE the runtime trigger on the
// QuestionBar row. Its label is the posture readout computed by the picker
// (built-in: held pair / active profile model / "Not configured"; external:
// "{model} · {strength}", either dimension alone, or "Default
// (recommended)"). The turn-end live currents never touch the label (issue
// #586): while nothing is selected, the label keeps its default copy and the
// tooltip carries what the last turn actually ran. Without a catalog (zero
// profiles, or an external CLI never probed/discovered) it renders as a
// static label with no arrow -- never a button pretending to be clickable;
// with a catalog it opens the cascade menu (dropdown-menu Sub primitive):
// two first-level rows (Model / Thinking) showing the held value inline,
// each opening a second-level menuitemradio list (aria-checked carries the
// held value -- the next turn's actual model/strength -- issue #584 as
// re-anchored by #1648) with a leading "Default (recommended)"
// clearing row and the honest synthetic row for a held value the catalog
// does not offer (issue #529). All rows render bare ids -- the one name
// form across the menu, the button, and the settings page (issue #1648).
// The built-in catalog (issue #1639) rides the same form with three honest
// deltas: the strength seat's availability is a directory ruling owned by
// posture-directory.ts, while the placeholder row and the no-model-clearing-
// row gate are component rulings over the same family flag the directory
// exports (isBuiltin).
// Item selection keeps the menu open (preventDefault) so the checked state
// updates and the fault lines below stay visible -- the fault surfaces that
// rode the old popover's selector body.
export type ComposerPostureTriggerProps = {
  // The posture display label, already formatted by the picker.
  label: string;
  // The catalog driving the cascade menu; null = static label (no arrow).
  catalog: PostureCatalog | null;
  // The turn-end live currents (issue #586): what the last turn actually
  // ran, read off the session discovery cache while nothing is selected.
  // Non-null mounts the tooltip that carries the live readout (the label
  // itself keeps its default copy); null renders no tooltip. An explicit
  // selection outranks the live read. The picker emits a non-null value
  // only alongside a non-null catalog -- the static-label early return
  // below carries no tooltip, so a live read never reaches it.
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
  // Fires once per menu OPEN (not per render): the picker's lazy-probe arm
  // (issue #1639) -- the only event that may trigger the built-in catalog's
  // first-hand list fetch. Every other path stays zero-egress.
  onMenuOpen?: () => void;
  disabled: boolean;
};

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
  onMenuOpen,
  disabled,
}: ComposerPostureTriggerProps) {
  const intl = useIntl();
  // Menu closes restore focus to the trigger; when that restore was
  // pointer-initiated it must be dropped -- the Tooltip wrapper would
  // focus-open and strand (usePointerCloseIntent).
  const pointerCloseRef = usePointerCloseIntent();

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
  // Hides on the same narrow-rail threshold as the trigger button's label
  // below (LABEL_HIDE_NARROW), so both runtime postures collapse their label
  // identically instead of this one degrading to an ellipsis.
  if (catalog === null) {
    return (
      <span className={`${LABEL_HIDE_NARROW} text-muted-foreground max-w-44 truncate text-sm`}>
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

  // The directory projection (posture-directory.ts) owns the family
  // dispatch and the held chain; the clearing-row labels stay here -- they
  // compose the localized default label.
  const {
    isBuiltin,
    modelIds,
    currentModel,
    levelIds,
    currentLevel,
    levelUnavailable,
    heldModel,
    heldLevel,
    builtinLoading,
  } = derivePostureDirectory({ catalog, model, thoughtLevel });

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
      className="composer-posture-trigger inline-flex h-9 max-w-52 min-w-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-sm text-foreground transition-colors hover:bg-transit disabled:pointer-events-none disabled:opacity-50"
    >
      {/* Hides the posture label when the question-bar @container
          drops below the narrow-rail threshold, leaving the
          chevron-only button (aria-label keeps the full readout) --
          the same collapse the auth-mode chip's label performs
          (LABEL_HIDE_NARROW). */}
      <span className={`${LABEL_HIDE_NARROW} truncate`}>{label}</span>
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );

  return (
    <>
      {catalogNote === "from-probe" && <ProbeCatalogInfoIcon />}
      <DropdownMenu
        onOpenChange={(o) => {
          // The lazy-probe arm (issue #1639): the menu's open is the one
          // event that may fire the built-in catalog fetch.
          if (o) onMenuOpen?.();
        }}
      >
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
        <DropdownMenuContent
          align="end"
          className="w-60"
          onCloseAutoFocus={(e) => {
            if (pointerCloseRef.current) e.preventDefault();
          }}
        >
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
                id="common.model"
                defaultMessage="Model"
              />
            )}
            displayValue={heldModel}
            clearLabel={modelClearLabel}
            // The gateway-length lists (issue #1645) ride the filter row;
            // the discrete, short strength list does not.
            searchable
            ids={modelIds}
            loading={builtinLoading}
            onSelect={onSelectModel}
            isBuiltinModelDimension={isBuiltin}
          />
          {/* The strength row is a permanent seat (issue #1648 feedback):
              unavailable (a held model with no discrete tiers, nothing
              held) renders the disabled hint instead of the row vanishing
              -- the probe placeholder seating it then hiding it flickered. */}
          <DimensionSub
            label={(
              <FormattedMessage
                id="composer.runtimePicker.thoughtLevelLabel"
                defaultMessage="Thinking"
              />
            )}
            displayValue={heldLevel}
            clearLabel={levelClearLabel}
            ids={levelIds}
            unavailable={levelUnavailable}
            unavailableMessage={
              isBuiltin ? (
                <FormattedMessage
                  id="composer.runtimePicker.noLevelsForModel"
                  defaultMessage="No thinking levels"
                />
              ) : undefined
            }
            loading={builtinLoading}
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
// the inline held value) opening the second-level radio list -- the leading
// "Default (recommended)" clearing row (absent on the builtin model
// dimension), the honest synthetic row
// for a held value the directory does not offer (#529), and the directory
// itself as menuitemradio rows whose checked state the group value carries
// (readable to screen readers, unlike the retired aria-hidden check icon,
// issue #584).
function DimensionSub({
  label,
  displayValue,
  clearLabel,
  ids,
  onSelect,
  unavailable = false,
  unavailableMessage,
  loading = false,
  isBuiltinModelDimension,
  searchable = false,
}: {
  label: ReactNode;
  displayValue: string | null;
  clearLabel: string;
  ids: readonly string[];
  onSelect: (id: string | null) => void;
  unavailable?: boolean;
  // The hint text when unavailable, right-aligned in the trigger row: the
  // built-in no-tiers case says "no levels for this model" where the
  // external empty-directory case says "pick a model first" (issue #1648
  // feedback).
  unavailableMessage?: ReactNode;
  // The built-in probe's in-flight window (issue #1648): the list seats a
  // disabled placeholder row and the strength row stays seated instead of
  // hiding -- an honest wait replaces the settle-and-pop. External catalogs
  // never load (cache-fed), absent = false.
  loading?: boolean;
  // True on the built-in model dimension, absent on the external ones
  // (ADR-0154). The flag is what drops the leading clearing row and keeps a
  // held id outside the list on the bare-name synthetic row instead of the
  // runtime-omission warning -- the built-in runtime has no CLI to "not
  // offer" anything. Only the model dimension rides it: the built-in
  // strength dimension stays external-shaped, so a held level the tier list
  // no longer carries still earns the "(not offered by this runtime)"
  // warning (intentional, test-pinned).
  isBuiltinModelDimension?: boolean;
  // Seats the filter row above the list (issue #1645, the model dimension
  // only): typing filters the directory rows by id. The clearing +
  // synthetic rows stay unfiltered -- they are state readouts, not catalog
  // entries. The query resets on submenu close.
  searchable?: boolean;
}) {
  const intl = useIntl();
  const [query, setQuery] = useState("");
  // The row-set projection (posture-directory.ts) owns the filter view, the
  // no-match gate, and the synthetic row; this component keeps the query
  // state, the filter input's key handling, and the radio group's fallback
  // chain.
  const { filteredIds, showNoMatch, unrepresentedId, note: syntheticNote } =
    deriveDimensionRows({
      ids,
      displayValue,
      query,
      loading,
      searchable,
      isBuiltinModel: isBuiltinModelDimension,
    });

  // The filter input's key handling (issue #1645): character keys never
  // bubble into the content's typeahead (each keystroke would otherwise
  // yank focus to a matching row mid-word), while ArrowDown moves focus to
  // the first focusable menu row -- the same Tab order Radix's own roving
  // focus would enter, so the rest of the keyboard path is native.
  const handleFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const rows = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
        "[role='menuitem']:not([aria-disabled='true']), [role='menuitemradio']:not([aria-disabled='true'])",
      );
      rows?.[0]?.focus();
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.stopPropagation();
    }
  };

  return (
    <DropdownMenuSub
      onOpenChange={(open) => {
        // Every open starts unfiltered: the previous query never survives a
        // close. Load-bearing -- the query state lives on this wrapper and
        // survives the content unmount for as long as the root menu stays
        // open, so this reset is the only mechanism, not a backstop for one.
        if (!open) setQuery("");
      }}
    >
      <DropdownMenuSubTrigger disabled={unavailable}>
        {label}
        {unavailable ? (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-right text-xs">
            {unavailableMessage ?? (
              <FormattedMessage
                id="composer.runtimePicker.pickModelFirst"
                defaultMessage="Pick a model first."
              />
            )}
          </span>
        ) : (
          <InlineValue value={displayValue} />
        )}
      </DropdownMenuSubTrigger>
      {/* Width pinned on both dimensions (issue #1648): a content-sized
          submenu lets long ids stretch it wide enough for the popper's
          collision avoidance to flip it to the trigger's far side -- a
          constant width holds the cascade geometry stable instead. */}
      <DropdownMenuSubContent className="w-72">
        {!unavailable && (
          <>
            {searchable && (
              // The text-input copy-in riding the compact variant recorded in
              // DESIGN.md Inputs: h-7 + px-2 over the standard token set.
              <Input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleFilterKeyDown}
                placeholder={intl.formatMessage({
                  id: "composer.runtimePicker.filterModels",
                  defaultMessage: "Filter models…",
                })}
                aria-label={intl.formatMessage({
                  id: "composer.runtimePicker.filterModelsAria",
                  defaultMessage: "Filter models",
                })}
                className="mb-1 h-7 px-2"
              />
            )}
            {/* Permanently controlled ("" = nothing selected): the radio value
                must never fall back to an uncontrolled internal state. The
                held value is the fallback (issue #1648): the checkmark names
                the row the NEXT turn would actually run -- the same source
                the button and the first-level annotation read -- instead of
                vanishing whenever nothing was explicitly picked. */}
            <DropdownMenuRadioGroup value={displayValue ?? ""}>
              {!isBuiltinModelDimension && (
                <ClearingItem label={clearLabel} onClear={() => onSelect(null)} />
              )}
              {loading && (
                // The probe's in-flight placeholder (issue #1648): a disabled
                // row that says the wait out loud, INSTEAD of the rows --
                // a background re-probe (empty-answer re-ask, endpoint
                // switch) must not seat stale rows beside "fetching".
                // Failure keeps the settled silence (#1639).
                <DropdownMenuItem disabled>
                  <span className="min-w-0 truncate">
                    <FormattedMessage
                      id="composer.runtimePicker.catalogLoading"
                      defaultMessage="Fetching model list…"
                    />
                  </span>
                </DropdownMenuItem>
              )}
              {unrepresentedId != null && (
                <OptionItem
                  id={unrepresentedId}
                  onSelect={() => onSelect(unrepresentedId)}
                  note={syntheticNote}
                />
              )}
              {!loading &&
                filteredIds.map((id) => (
                  <OptionItem key={id} id={id} onSelect={() => onSelect(id)} />
                ))}
            </DropdownMenuRadioGroup>
            {showNoMatch && (
              <p className="text-muted-foreground px-2 py-1.5 text-xs">
                <FormattedMessage
                  id="composer.runtimePicker.noModelMatch"
                  defaultMessage="No matching models"
                />
              </p>
            )}
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// One second-level option row: a menuitemradio whose checked state rides
// the group value. Selecting keeps the menu open (preventDefault) so the
// checked mark updates and the fault lines below stay in view. The note,
// when present, is the runtime-omission warning (issue #529): absent on an
// ordinary catalog row, and a built-in held id outside the list rides the
// bare name too -- the pinned-default note retired (issue #1648 feedback).
function OptionItem({
  id,
  onSelect,
  note,
}: {
  id: string;
  onSelect: () => void;
  note?: "runtime";
}) {
  // Rows render the bare id (issue #1648): the one name form across the
  // menu, the button readout, and the settings field. The only annotation
  // left is the runtime-omission warning.
  const content: ReactNode =
    note === "runtime" ? (
      <FormattedMessage
        id="composer.runtimePicker.unrepresentedModel"
        defaultMessage="{id} (not offered by this runtime)"
        values={{ id }}
      />
    ) : (
      id
    );
  return (
    <DropdownMenuRadioItem
      value={id}
      title={id}
      onSelect={(e) => {
        e.preventDefault();
        onSelect();
      }}
    >
      <span className="min-w-0 truncate">{content}</span>
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
      title={label}
      onSelect={(e) => {
        e.preventDefault();
        onClear();
      }}
    >
      <span className="min-w-0 truncate">{label}</span>
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
