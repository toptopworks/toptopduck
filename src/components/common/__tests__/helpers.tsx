import { render } from "@testing-library/react";
import { createIntl, IntlProvider, type IntlShape } from "react-intl";
import type { ReactElement } from "react";
import type embedType from "vega-embed";
import { vi } from "vitest";
import { TooltipProvider } from "../../ui/tooltip";
import { catalogFor, FALLBACK_LOCALE, type EffectiveLocale } from "../../../i18n";

// The i18n test seam (ADR-0052): the shared interface for react-intl in
// tests (issue #216 split, #1100 convergence); pre-seam inline provider
// wraps migrate here on next touch. Two postures, picked by
// what a suite asserts:
// - Asserting rendered wording -> the REAL catalog, so the pin tracks catalog
//   edits. Component trees wrap via withIntl / renderI18n (zh-CN) or
//   withIntlAt (parameterized locale); non-React consumers (fmtError and
//   friends) take catalogIntl(locale) and assert against the catalog keys
//   (e.g. en["error.x"]) -- a mistyped key fails to compile, and a catalog
//   wording change moves the pin instead of silently passing, which is what
//   the retired hand-copied mirrors failed to do through #1096/#1098.
// - Asserting descriptor ids or wording-independent behavior -> flatIntl():
//   a formatMessage spy returning a fixed "err" for every descriptor, so
//   assertions anchor on the id (#1080 posture).
//
// withIntl wraps a node for a render or rerender call (RTL's rerender
// replaces the whole tree, so it must re-provide the provider); renderI18n
// is the render-time convenience. Lives in the common base so the domains
// share one wrapper instead of each inline-copying it (issue #216 split).
//
// The TooltipProvider mirrors the app tree (App mounts the one app-wide
// provider; Radix tooltip consumers below it must not grow their own) -- so
// tests for components that render Tooltips (the working-set rows since #865)
// get the same ancestor instead of each suite hand-wrapping one.

/** A minimal successful Vega-Embed Result for suites that mock vega-embed
 * (jsdom has no canvas): the members the chart surfaces touch -- `finalize`
 * always, plus the view resize behind the unhide path (guarded off under the
 * never-firing jsdom observer today, but a suite stubbing a firing
 * ResizeObserver would hit it). Shared so the chart surfaces -- the result
 * card, the vega-lite fence (ADR-0120) -- script the same stub shape instead
 * of each hand-copying the cast. */
export const embedOk = () =>
  ({ finalize: vi.fn(), view: { resize: vi.fn() } }) as unknown as Awaited<
    ReturnType<typeof embedType>
  >;

export function withIntl(ui: ReactElement) {
  return withIntlAt("zh-CN", ui);
}

export function renderI18n(ui: ReactElement) {
  return render(withIntl(ui));
}

/** Locale-parameterized sibling of withIntl for suites that exercise more
 * than the default zh-CN test locale (App.test's en-US arm): IntlProvider
 * over the real catalog with the app tree's defaultLocale, TooltipProvider
 * inside. Suites needing a QueryClient compose it around this wrap. */
export function withIntlAt(locale: EffectiveLocale, ui: ReactElement) {
  return (
    <IntlProvider locale={locale} messages={catalogFor(locale)} defaultLocale={FALLBACK_LOCALE}>
      <TooltipProvider>{ui}</TooltipProvider>
    </IntlProvider>
  );
}

/** An IntlShape over the REAL catalog for non-React consumers (fmtError,
 * formatTurnFailure, and friends): ids resolve through catalogFor, so
 * wording assertions track catalog edits. Callers assert against the catalog
 * keys via catalogFor(locale)["..."] -- literal, compile-checked keys. */
export function catalogIntl(locale: EffectiveLocale): IntlShape {
  return createIntl({ locale, messages: catalogFor(locale) });
}

/** Flattened intl stub: formatMessage is a spy returning a fixed "err" for
 * every descriptor, so assertions anchor on the descriptor id or the call
 * args, never on wording (the #1080 posture). */
export function flatIntl(): IntlShape {
  return { formatMessage: vi.fn(() => "err") } as unknown as IntlShape;
}
