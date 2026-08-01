import { useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { testProfile } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import type { ProfileTestOutcome, ProviderProfile } from "../../types/provider";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

// Model field + connection preflight atom (issue #236, ADR-0070). Lifts the
// model input OUT of ProviderEndpointFields so this atom owns the ADR-0070
// preflight surface: a "Test connection" button that fires the test_profile IPC
// (Rust reads the profile's stored key from the OS keychain + probes the
// endpoint), classifies the result into ADR-0044's five states, and feeds the
// listed models to a dropdown when the probe succeeds. The model list is held
// IN-MEMORY here only -- it never enters app-config (ADR-0038 stores
// preferences, not probe snapshots); list failure or "not yet probed" falls back
// to the hand-typed input (the #1 shape).
//
// The IPC takes the profile's CURRENT endpoint values (protocol + base_url +
// model from the edit form), so a user who edits base_url and re-tests does not
// have to save first (ADR-0070 Why 3). The key alone is read from the keychain
// by profile id -- it never crosses IPC (ADR-0029 invariant 3).

type ProviderModelFieldProps = {
  // The profile being edited. protocol + base_url drive the probe; id indexes
  // the keychain key; model is the ping payload + the dropdown selection.
  profile: ProviderProfile;
  // Immutable model update (coding-style: never mutate). Fired when the user
  // types (input mode) or selects from the probed dropdown.
  onUpdate: (patch: Partial<ProviderProfile>) => void;
  disabled: boolean;
  // Notified imperatively at probe IPC boundaries (true on start, false in the
  // finally) so ESC / Back / Cancel are blocked while a preflight IPC is in
  // flight. Imperative -- NOT state -> effect -- because the finally runs even
  // after this node unmounts (a section switch mid-probe), where the setTestBusy
  // mirror would no-op and never report "settled" upward. Mirrors
  // ProviderKeyField's onBusyChange contract.
  onBusyChange?: (busy: boolean) => void;
};

export function ProviderModelField({
  profile,
  onUpdate,
  disabled,
  onBusyChange,
}: ProviderModelFieldProps) {
  const intl = useIntl();
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
      );
      setTestResult(result);
    } catch (e) {
      setTestError(fmtError(e, intl));
    } finally {
      setTestBusy(false);
      onBusyChange?.(false);
    }
  }

  // Dropdown shows only when the probe listed at least one model. An Ok with an
  // empty list (the ping fallback succeeded but /models is unimplemented) falls
  // back to the hand-typed input (ADR-0070: "list failure or not-yet-probed ->
  // hand-typed").
  const okResult = testResult?.kind === "Ok" ? testResult : null;
  const hasDropdown = okResult !== null && okResult.data.models.length > 0;
  // The dropdown lists the probed models, always keeping the current model
  // selectable (prepend it when it is not in the list) so the <select> never
  // silently snaps to the first option when the user's hand-typed model is not
  // one the endpoint advertises.
  const options = hasDropdown
    ? Array.from(new Set([profile.model, ...okResult.data.models]))
    : [];

  const fieldDisabled = disabled || testBusy;

  return (
    <fieldset className="grid gap-2 border-0 p-0 m-0">
      <Label className="grid gap-1">
        <FormattedMessage id="settings.profiles.model" defaultMessage="Model" />
        {hasDropdown ? (
          <select
            value={profile.model}
            onChange={(e) => onUpdate({ model: e.target.value })}
            disabled={fieldDisabled}
            className="border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <Input
            type="text"
            value={profile.model}
            onChange={(e) => onUpdate({ model: e.target.value })}
            disabled={fieldDisabled}
          />
        )}
      </Label>

      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="outline"
          onClick={handleTest}
          disabled={fieldDisabled}
        >
          {testBusy ? (
            <FormattedMessage
              id="settings.profiles.test.testing"
              defaultMessage="Testing…"
            />
          ) : (
            <FormattedMessage
              id="settings.profiles.test.action"
              defaultMessage="Test connection"
            />
          )}
        </Button>
        {testResult && <PreflightResult outcome={testResult} />}
        {testError && <p className="text-destructive text-sm">{testError}</p>}
      </div>
    </fieldset>
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
        <p className="text-muted-foreground text-sm">
          <FormattedMessage
            id="settings.profiles.test.okModels"
            defaultMessage="Connected — {count, plural, one {# model} other {# models}} available."
            values={{ count: outcome.data.models.length }}
          />
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
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
