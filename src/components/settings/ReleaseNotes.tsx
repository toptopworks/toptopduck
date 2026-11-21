import { useIntl } from "react-intl";

import { parseReleaseNotes, releaseNotesLang } from "./release-notes";

/** The About pane's rendered release notes (issue #1577). The updater
 *  manifest's `notes` field (the release body) goes through the
 *  `release-notes` grammar parse -- locale segment pick, PR-tail strip,
 *  footer cut -- and draws as native settings-styled nodes: muted section
 *  titles over compact item lines, or plain lines when the body is not in
 *  the canonical shape. No markdown library and no HTML surface: every node
 *  here is a React text node, so the manifest payload cannot inject
 *  markup. Renders nothing for an empty parse. */
export function ReleaseNotes({ notes }: { notes: string }) {
  const intl = useIntl();
  const parsed = parseReleaseNotes(notes, releaseNotesLang(intl.locale));
  if (parsed.kind === "sections") {
    return (
      <div className="grid gap-2">
        {parsed.sections.map((section, index) => (
          <div key={index} className="grid gap-1">
            <p className="text-muted-foreground text-xs font-medium leading-relaxed">
              {section.title}
            </p>
            <ul className="grid gap-1">
              {/* Index keys: the list is a static derivation of one immutable
               * `notes` string -- it never reorders, and repeated item text
               * would collide a content key. */}
              {section.items.map((item, index) => (
                <li key={index} className="text-foreground text-xs leading-relaxed">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }
  if (parsed.lines.length === 0) return null;
  return (
    <div className="grid gap-1">
      {parsed.lines.map((line, index) => (
        <p key={index} className="text-foreground text-xs leading-relaxed">
          {line}
        </p>
      ))}
    </div>
  );
}
