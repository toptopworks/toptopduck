// The round's connective prose paragraph (ADR-0103): always expanded -- prose
// is the conversational discourse, folding it would hide the narrative.
// Shared by the settled round block (TurnCard) and the live round block
// (LiveTurnExchange, issue #610) so the settle swap renders the identical
// markup instead of a copy kept in sync by discipline.
//
// Rendered as markdown (issue #746): agent answers carry headings, lists,
// code fences, tables, and inline emphasis. react-markdown renders to React
// elements (no innerHTML); URLs pass the library's default urlTransform
// allowlist. Embedded HTML never renders and never vanishes either: the
// library's own post transform flips raw hast nodes to text, so the tag
// characters show verbatim -- the safe posture plus honest content, pinned
// by the component tests.
//
// Streaming contract: the plugin list and the components map are MODULE-LEVEL
// constants. A fresh array/object identity per render would make
// react-markdown unmount and remount every custom component on each streamed
// delta, dropping interaction state (a code block's copy ack). The i18n reads
// therefore live inside the subcomponents so the map closes over nothing.

import { memo, useState, type MouseEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components, ExtraProps, Options } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useIntl } from "react-intl";
import { log } from "../../lib/log";
import { CopyButton } from "./CopyButton";
import { CODE_BLOCK_REVEAL_CLASS } from "./turn-visual";

// The hast element type react-markdown itself hands to components -- derived
// from its own typings so no hast package import is needed.
type HastElement = NonNullable<ExtraProps["node"]>;

// Module-level constant: see the streaming contract in the file header.
const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm, remarkBreaks];

// The hast subtree's concatenated text (a fence's code text lives in one
// text node under pre > code, but walk generically).
function hastTextContent(node: HastElement | undefined): string {
  if (node === undefined) return "";
  let text = "";
  for (const child of node.children) {
    if (child.type === "text") text += child.value;
    else if (child.type === "element") text += hastTextContent(child);
  }
  return text;
}

// The fence language, read from the inner code element's `language-*` class.
function codeLanguage(pre: HastElement | undefined): string | null {
  const code = pre?.children.find(
    (child): child is HastElement => child.type === "element" && child.tagName === "code",
  );
  const classes = code?.properties.className ?? [];
  const list = Array.isArray(classes) ? classes : [classes];
  for (const entry of list) {
    if (typeof entry === "string" && entry.startsWith("language-")) {
      return entry.slice("language-".length);
    }
  }
  return null;
}

// A fenced code block: {typography.code} monospace on a {colors.muted}
// surface that follows the theme, the fence language as a
// {typography.caption} label at the right of the header row, and the shared
// CopyButton (issue #609) revealed on hover/focus. No syntax highlighting,
// no long-block folding (issue #746 v1 scope). The copy label lives here (a
// static literal for @formatjs/cli extract) so the module-level components
// map closes over nothing.
function CodeBlock({ node }: { node?: HastElement }) {
  const intl = useIntl();
  const copyLabel = intl.formatMessage({
    id: "thread.copy.code",
    defaultMessage: "Copy code",
  });
  // The mdast-to-hast conversion appends one trailing newline to the code
  // text; the copy payload drops it so a paste carries no ghost line.
  const text = hastTextContent(node).replace(/\n$/, "");
  const language = codeLanguage(node);
  return (
    <div className="group/code-block rounded-md bg-muted">
      <div className="flex items-center justify-end gap-1 px-2 pt-1.5">
        {language !== null && (
          <span className="text-xs leading-[1.4] text-muted-foreground">{language}</span>
        )}
        <span className={CODE_BLOCK_REVEAL_CLASS}>
          <CopyButton text={text} label={copyLabel} />
        </span>
      </div>
      <pre className="m-0 overflow-x-auto px-2 pb-2 pt-1">
        <code className="font-mono text-[13px] leading-[1.5]">{text}</code>
      </pre>
    </div>
  );
}

// http(s) links open in the OS default browser through the opener plugin --
// the WebView has no navigation handler for plain anchors (the same channel
// ProviderKeyField's get-key link uses). Every other shape -- mailto:,
// relative refs, or what the default urlTransform stripped to empty
// (javascript:, file:, ...) -- degrades to plain text instead of a dead
// link. An opener rejection surfaces as a caption-sized live note beside
// the link (role=status so screen readers announce it): the click already
// swallowed the default navigation, so silence would read as a dead button.
function ProseLink({ href, children }: { href?: string; children?: ReactNode }) {
  const intl = useIntl();
  const [failed, setFailed] = useState(false);
  if (typeof href === "string" && /^https?:\/\//i.test(href)) {
    const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault();
      openUrl(href)
        .then(() => {
          setFailed(false);
        })
        .catch((e: unknown) => {
          log.warn("RoundProse", "openUrl failed", e);
          setFailed(true);
        });
    };
    return (
      <>
        <a
          href={href}
          className="text-primary underline decoration-primary/50 underline-offset-2 hover:decoration-primary"
          onClick={handleClick}
        >
          {children}
        </a>
        {failed && (
          <span role="status" className="ml-1 align-baseline text-xs text-destructive">
            {intl.formatMessage({
              id: "thread.link.openFailed",
              defaultMessage: "Could not open link",
            })}
          </span>
        )}
      </>
    );
  }
  return <span>{children}</span>;
}

// Module-level constant: see the streaming contract in the file header.
const MARKDOWN_COMPONENTS: Components = {
  // The chat-stream heading ladder: full-size document headings would shout
  // over the discourse in the 320px rail, so markdown headings compress -- h1
  // lands at 17px and each level steps down 1px; h4 and below stay at body
  // size and only gain weight. Weight caps at 600 (DESIGN.md forbids 700).
  h1: ({ children }) => <h1 className="m-0 text-[1.0625rem] font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="m-0 text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="m-0 text-[0.9375rem] font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="m-0 text-sm font-semibold">{children}</h4>,
  h5: ({ children }) => <h5 className="m-0 text-sm font-semibold">{children}</h5>,
  h6: ({ children }) => <h6 className="m-0 text-sm font-semibold">{children}</h6>,
  p: ({ children }) => <p className="m-0">{children}</p>,
  ul: ({ children }) => <ul className="m-0 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="m-0 list-decimal space-y-1 pl-5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="m-0 border-l border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  pre: CodeBlock,
  code: ({ children }) => (
    <code className="rounded-xs bg-muted px-1.5 py-0.5 font-mono text-[13px]">{children}</code>
  ),
  a: ProseLink,
  // Remote images never load (the CSP allows only self/data/blob/asset), so a
  // default img would render as a broken placeholder -- the alt text carries
  // the content the way every other degraded shape here does.
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse [&_tr:last-child>td]:border-b-0">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border bg-muted px-2 py-1 text-left font-semibold align-top">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-b border-border px-2 py-1 align-top">{children}</td>,
  hr: () => <hr className="m-0 border-0 border-t border-border" />,
};

export const RoundProse = memo(function RoundProse({ text }: { text: string }) {
  return (
    <div className="round-text m-0 mt-0.5 space-y-2 text-sm leading-snug text-foreground break-words">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
});
