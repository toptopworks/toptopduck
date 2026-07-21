import { useIntl } from "react-intl";
import { Alert } from "../components/ui/alert";
import type { ResumeStatus } from "./useShellSessions";

// Resume progress status (ADR-0034). ResumeStatus is a structured discriminated
// union produced by useShellSessions (openPersisted's Source/Replay events) --
// not a pre-baked string. App sits above <IntlProvider> and cannot format
// messages itself, so ResumeProgress (a child inside the provider) renders the
// union into the active locale. Each intl.formatMessage id is a STATIC literal
// so @formatjs/cli extract resolves them.
export function ResumeProgress({ status }: { status: ResumeStatus }) {
  const intl = useIntl();
  const text = (() => {
    switch (status.kind) {
      case "opening":
        return intl.formatMessage({ id: "resume.opening", defaultMessage: "Opening…" });
      case "source":
        return intl.formatMessage(
          { id: "resume.source", defaultMessage: "Verifying source {index}/{total}: {name}" },
          { index: status.index, total: status.total, name: status.name },
        );
      case "replay":
        return intl.formatMessage(
          { id: "resume.replay", defaultMessage: "Replaying {index}/{total}: {name}" },
          { index: status.index, total: status.total, name: status.name },
        );
    }
  })();
  // ADR-0067 (issue #182): the .resume-progress bespoke tint (hardcoded
  // #eef6ff bg + #b6d4ff border + 6px radius + 0.4/0.8 padding) retired from
  // styles.css onto a shadcn Alert default variant -- the "shadcn info surface"
  // per alert-variants.ts (bg-card + border + rounded-lg). The legacy tint was
  // a v0-scaffold Bootstrap-style blue with no matching ADR-0050 token; landing
  // on Alert default retires it onto the same info surface other disclosures
  // use, eliminating the cross-surface drift ADR-0067 Decision 1 targets. The
  // transient info-line weight is preserved (single short status line, polite
  // aria-live + role=status override the Alert's assertive default). The
  // .resume-progress class hook stays on the Alert for selector stability and
  // for the .shell > .resume-progress grid placement (still in styles.css as
  // layout-only, grid-column/grid-row).
  return (
    <Alert
      className="resume-progress my-1.5"
      role="status"
      aria-live="polite"
    >
      {text}
    </Alert>
  );
}
