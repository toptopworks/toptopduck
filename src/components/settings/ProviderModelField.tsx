import { useId, useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Check, ChevronDown } from "lucide-react";

import { testProfile } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import type { ProfileTestOutcome, ProviderProfile } from "../../types/provider";
import { Button } from "../ui/button";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { SettingsRow } from "./settings-chrome";

// Model field + connection preflight atom (issue #236, ADR-0070; combobox
// shape issue #735). Lifts the model input OUT of ProviderEndpointFields so
// this atom owns the ADR-0070 preflight surface: a "Test connection" button
// that fires the test_profile IPC (Rust probes the endpoint), classifies the
// result into ADR-0044's six states, and feeds the listed models to a
// dropdown when the probe succeeds. The model list is held IN-MEMORY here
// only -- it never enters app-config (ADR-0038 stores preferences, not probe
// snapshots).
//
// SHAPE (issue #735): an editable combobox -- the input is ALWAYS the
// hand-typed value surface, and the probe list is a side dropdown panel
// (Popover + cmdk Command) opened by a chevron button in the same row. List
// selection and hand typing are therefore permanently co-available; the
// pre-upgrade "swap Input for Select after a successful probe" shape (and
// its prepend-the-current-model-into-the-options hack) is retired. With no
// list yet, the panel opens to a hint pointing at the Test connection button
// instead of being disabled -- the fetch affordance stays discoverable.
//
// The IPC takes the profile's CURRENT endpoint values (protocol + base_url +
// model from the edit form), so a user who edits base_url and re-tests does not
// have to save first (ADR-0070 Why 3). In add mode the caller additionally
// passes the buffered draft key (`probeKey`): the profile -- and its keychain
// entry -- does not exist yet, so the probe carries the key one-shot
// (frontend -> Rust, never persisted, never echoed back; ADR-0070
// calibration, issue #735). Edit mode omits it and Rust reads the stored key
// from the keychain (ADR-0029 -- the stored key never crosses IPC to the
// frontend).

type ProviderModelFieldProps = {
  // The profile being edited. protocol + base_url drive the probe; id indexes
  // the keychain key (edit mode); model is the ping payload + the combobox
  // value.
  profile: ProviderProfile;
  // Immutable model update (coding-style: never mutate). Fired when the user
  // types (the input) or selects from the probed dropdown panel.
  onUpdate: (patch: Partial<ProviderProfile>) => void;
  disabled: boolean;
  // Notified imperatively at probe IPC boundaries (true on start, false in the
  // finally) so ESC / Back / Cancel are blocked while a preflight IPC is in
  // flight. Imperative -- NOT state -> effect -- because the finally runs even
  // after this node unmounts (a section switch mid-probe), where the setTestBusy
  // mirror would no-op and never report "settled" upward. Mirrors
  // ProviderKeyField's onBusyChange contract.
  onBusyChange?: (busy: boolean) => void;
  // Mirrors the probed-models panel's open state upward so the parent's
  // commit-on-blur can hold back while the portalized option list owns focus
  // (the panel sits OUTSIDE the edit form's DOM subtree).
  onSelectOpenChange?: (open: boolean) => void;
  // One-shot probe key (issue #735): the add form's buffered draft key,
  // threaded through ProviderEndpointFields. Omitted in edit mode, where the
  // probe reads the stored key instead.
  probeKey?: string;
  // Field-level validation error for the model value (issue #735): rendered
  // under the input, drives its aria-invalid + aria-describedby. Owned by
  // ProfilesSection's validateProfile -- never the probe result.
  error?: string | null;
};

export function ProviderModelField({
  profile,
  onUpdate,
  disabled,
  onBusyChange,
  onSelectOpenChange,
  probeKey,
  error,
}: ProviderModelFieldProps) {
  const intl = useIntl();
  const modelId = useId();
  const [listOpen, setListOpen] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<ProfileTestOutcome | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // A probe result is valid only for the endpoint it probed. Clear it when
  // protocol/base_url changes so a stale model list never feeds the dropdown;
  // model edits do NOT clear it (the listed models are a function of the
  // endpoint, not the model -- ADR-0070). Same render-time "adjust state when a
  // value changes" pattern as ProviderKeyField's profile-id reset, avoiding the
  // set-state-in-effect lint. See
  // https://react.dev/learn/you-might-not-need-an-effect
  const [probedEndpoint, setProbedEndpoint] = useState({
    protocol: profile.protocol,
    base_url: profile.base_url,
  });
  if (
    profile.protocol !== probedEndpoint.protocol ||
    profile.base_url !== probedEndpoint.base_url
  ) {
    setProbedEndpoint({ protocol: profile.protocol, base_url: profile.base_url });
    setTestResult(null);
    setTestError(null);
  }

  async function handleTest() {
    setTestBusy(true);
    onBusyChange?.(true);
    setTestError(null);
    try {
      const result = await testProfile(
        profile.id,
        profile.protocol,
        profile.base_url,
        profile.model,
        probeKey,
      );
      setTestResult(result);
    } catch (e) {
      setTestError(fmtError(e, intl));
    } finally {
      setTestBusy(false);
      onBusyChange?.(false);
    }
  }

  function handleListOpenChange(open: boolean) {
    setListOpen(open);
    onSelectOpenChange?.(open);
  }

  // The panel lists the probed models only when the probe listed at least one.
  // An Ok with an empty list (the ping fallback succeeded but /models is
  // unimplemented) leaves the panel in its hint state (ADR-0070: "list failure
  // or not-yet-probed -> hand-typed"). The current model value is NOT merged
  // into the options: the input already holds it, so selection and typing stay
  // two independent paths to the same value.
  const okResult = testResult?.kind === "Ok" ? testResult : null;
  const models = okResult?.data.models ?? [];

  const fieldDisabled = disabled || testBusy;

  return (
    <SettingsRow
      dense
      title={(
        <Label htmlFor={modelId} className="text-muted-foreground">
          <FormattedMessage id="settings.profiles.model" defaultMessage="Model" />
        </Label>
      )}
    >
      <div className="grid gap-2">
        <div className="flex items-center gap-2">
          <Input
            id={modelId}
            type="text"
            value={profile.model}
            onChange={(e) => onUpdate({ model: e.target.value })}
            disabled={fieldDisabled}
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${modelId}-error` : undefined}
          />
          {/* The list panel rides a Popover so its focus-trap/ESC/outside-click
              dismissal matches the preset select's, and so the parent's
              commit-on-blur hold-back (onSelectOpenChange) covers it -- the
              portalized panel sits outside the edit form's DOM subtree. */}
          <Popover open={listOpen} onOpenChange={handleListOpenChange}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={fieldDisabled}
                aria-label={intl.formatMessage({
                  id: "settings.profiles.model.listTrigger",
                  defaultMessage: "Select model from list",
                })}
              >
                <ChevronDown className="size-4" aria-hidden />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-0">
              {models.length > 0 ? (
                <Command>
                  <CommandInput
                    placeholder={intl.formatMessage({
                      id: "settings.profiles.model.searchPlaceholder",
                      defaultMessage: "Search models…",
                    })}
                  />
                  <CommandList>
                    {models.map((m) => (
                      <CommandItem
                        key={m}
                        value={m}
                        onSelect={() => {
                          onUpdate({ model: m });
                          handleListOpenChange(false);
                        }}
                      >
                        {/* Model ids are identifiers -- the system monospace
                            stack (DESIGN.md typography.code), not the sans UI
                            stack. */}
                        <span className="font-mono text-[0.82rem]">{m}</span>
                        {m === profile.model && (
                          <Check className="ms-auto size-3.5" aria-hidden />
                        )}
                      </CommandItem>
                    ))}
                  </CommandList>
                </Command>
              ) : (
                <p className="text-muted-foreground px-3 py-3 text-sm">
                  <FormattedMessage
                    id="settings.profiles.model.listHint"
                    defaultMessage="No model list yet. Click Test connection to fetch one."
                  />
                </p>
              )}
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={fieldDisabled}
            className="shrink-0"
          >
            {testBusy ? (
              <FormattedMessage
                id="common.testing"
                defaultMessage="Testing…"
              />
            ) : (
              <FormattedMessage
                id="settings.profiles.test.action"
                defaultMessage="Test connection"
              />
            )}
          </Button>
        </div>
        {error && (
          <p id={`${modelId}-error`} className="text-destructive text-sm">
            {error}
          </p>
        )}
        {testResult && <PreflightResult outcome={testResult} />}
        {testError && <p className="text-destructive text-sm">{testError}</p>}
      </div>
    </SettingsRow>
  );
}

// Renders the six-state preflight classification (ADR-0044 axis). Each state
// has a fixed locale message; KeychainUnavailable + InvalidEndpoint +
// Incompatible additionally fold the technical English detail (a keychain error
// string / the bad-scheme reason / an upstream HTTP body string) under a
// <details> so the user can drill in without it dominating the form. The switch
// is exhaustive -- a future ProfileTestOutcome variant fails the `never`
// assignment here.
function PreflightResult({ outcome }: { outcome: ProfileTestOutcome }) {
  switch (outcome.kind) {
    case "Ok":
      return outcome.data.models.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          <FormattedMessage
            id="settings.profiles.test.okModels"
            defaultMessage="Connected — {count, plural, one {# model} other {# models}} available."
            values={{ count: outcome.data.models.length }}
          />
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          <FormattedMessage
            id="settings.profiles.test.okPing"
            defaultMessage="Connected — the endpoint responds. It did not list models, so type one by hand."
          />
        </p>
      );
    case "KeyRejected":
      return (
        <p className="text-destructive text-sm">
          <FormattedMessage
            id="settings.profiles.test.keyRejected"
            defaultMessage="Key rejected — no key stored, or the endpoint rejected it (401/403)."
          />
        </p>
      );
    case "KeychainUnavailable":
      return (
        <DetailFold detail={outcome.data.detail}>
          <FormattedMessage
            id="settings.profiles.test.keychainUnavailable"
            defaultMessage="Keychain unavailable — the OS keychain could not be read. Check the OS keychain, then test again."
          />
        </DetailFold>
      );
    case "EndpointUnreachable":
      return (
        <p className="text-destructive text-sm">
          <FormattedMessage
            id="settings.profiles.test.endpointUnreachable"
            defaultMessage="Could not reach the endpoint (DNS / network / TLS)."
          />
        </p>
      );
    case "InvalidEndpoint":
      // Issue #279: a non-http/https scheme is a configuration error, not a
      // transport fault -- direct the user at the protocol, not DNS/TLS. The
      // technical reason (which scheme / the http(s) policy) folds under the
      // summary like KeychainUnavailable + Incompatible.
      return (
        <DetailFold detail={outcome.data.detail}>
          <FormattedMessage
            id="settings.profiles.test.invalidEndpoint"
            defaultMessage="The endpoint protocol must be http or https."
          />
        </DetailFold>
      );
    case "Incompatible":
      return (
        <DetailFold detail={outcome.data.detail}>
          <FormattedMessage
            id="settings.profiles.test.incompatible"
            defaultMessage="Incompatible — the endpoint responded but cannot serve a turn."
          />
        </DetailFold>
      );
    default: {
      const _exhaustive: never = outcome;
      void _exhaustive;
      return null;
    }
  }
}

// The fold chrome KeychainUnavailable + Incompatible share: a locale summary
// over the technical English detail, drilled via <details> so the detail does
// not dominate the form. The <FormattedMessage> literals stay at the call
// sites -- formatjs extract statically scans for <FormattedMessage> JSX with
// literal id/defaultMessage (scripts/check-i18n.mjs), so wrapping the literal
// inside a helper would hide it from the scanner and drop both ids from the
// catalog guard.
function DetailFold({ children, detail }: { children: ReactNode; detail: string }) {
  return (
    <details className="text-destructive text-sm">
      <summary className="cursor-pointer">{children}</summary>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs">{detail}</pre>
    </details>
  );
}
