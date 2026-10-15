import { FormattedMessage } from "react-intl";

// The tiered elapsed face (" · 12s" / " · 12秒"): the display form of a
// turn-clock second count -- the unit spelling lives in the locale catalog,
// the tier math here (issue #1264/#1280). A pure face, no clock: the ticking
// wait-status suffix and the settled process head's frozen duration (issue
// #1282) hand in their own seconds. The face never reads zero (issue #1280's
// first-second floor): a fresh ask's first tick reads 1s, and a sub-second
// settled turn rounds up. Units below the tier's leading one are zero-padded
// ("5m 07s", "2h 05m 09s"); the bare seconds tier keeps its unpadded face.
// The pad is numeric formatting, not unit spelling -- that stays in the
// catalog. The whole face rides one `whitespace-pre` span: hosts lay it into
// flex rows, and an anonymous flex item's leading/trailing whitespace is
// stripped -- the separator's spaces belong to the face, not the host's gap.
export function ElapsedFace({ seconds }: { seconds: number }) {
  const s = Math.max(1, seconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const padded = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="whitespace-pre">
      {" · "}
      {hours > 0 ? (
        <FormattedMessage
          id="common.waitElapsedHours"
          defaultMessage="{hours}h {minutes}m {seconds}s"
          values={{ hours, minutes: padded(minutes), seconds: padded(secs) }}
        />
      ) : minutes > 0 ? (
        <FormattedMessage
          id="common.waitElapsedMinutes"
          defaultMessage="{minutes}m {seconds}s"
          values={{ minutes, seconds: padded(secs) }}
        />
      ) : (
        <FormattedMessage id="common.waitElapsed" defaultMessage="{seconds}s" values={{ seconds: secs }} />
      )}
    </span>
  );
}
