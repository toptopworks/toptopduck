// The round's connective prose paragraph (ADR-0103): always expanded -- prose
// is the conversational discourse, folding it would hide the narrative.
// Shared by the settled round block (TurnCard), the live round block
// (LiveTurnExchange, issue #610), and the Textual outcome's terminal answer
// (TurnCard, issue #827) so the settle swap renders the identical content
// markup -- the live-only animate spans of the word cascade below excepted --
// and the answer rides the same pipeline as the prose.
//
// Rendered as markdown (issue #746) through streamdown (issue #1128): the
// library re-implements the react-markdown pipeline (remark-parse +
// remark-rehype + hast-util-to-jsx-runtime), and its streaming layer adds
// remend -- the pass that completes half-open markers (an unclosed `**`, a
// dangling `[label](url`, a fence still being written) so the raw syntax
// never flashes on screen mid-stream. Rendering stays in React elements (no
// innerHTML); unsafe URLs are kept off anchor elements by the http(s) gate
// in ProseLink -- streamdown's urlTransform passes non-web schemes through
// un-stripped (see ProseLink).
// Embedded HTML never renders and never vanishes either: an empty rehype
// list drops the library's raw/sanitize/harden defaults, and the fork's
// remark-stage substitution flips mdast html nodes to text nodes (raw hast
// nodes never exist), so the tag characters show verbatim -- the safe
// posture plus honest content, pinned by the component tests.
//
// Streaming contract: the plugin lists and the components maps are
// MODULE-LEVEL constants. Streamdown splits the text into blocks and
// memoizes each one, comparing the components/plugin entries by identity --
// a fresh array/object per render would defeat that memo and remount every
// custom component on each streamed delta, dropping interaction state (a
// code block's copy ack). The i18n reads therefore live inside the
// subcomponents so the maps close over nothing. There are two maps --
// settled and live (the streaming mode; ADR-0120's term) -- differing only
// in the `pre` door (the vega-lite fence, ADR-0120 Decision 4); each is its
// own constant, so a mode switch (the settle swap, or a closed round
// flipping to static mid-turn — issue #1161) is the only thing that
// ever changes identity, and within a mode streamed deltas reconcile in
// place. The library's own mode prop stays unset on purpose: its default is
// "streaming", so the remend pass runs on BOTH sides here and what a stream
// completed is exactly what settles -- that parity is the construction
// guarantee (ADR-0103), pinned by the component tests. Forwarding the mode
// through would switch the static branch to the library's untouched
// single-pass path and silently break that parity; do not wire it without
// re-verifying the parity tests.
//
// Error containment stays at the session level by adjudication
// (issue #1132): streamdown has no internal catch, so a pathological
// delta's remend or block-parse throw propagates and degrades the
// whole thread view (the degrade card with its retry), not just the
// offending round -- accepted. A per-round ErrorBoundary was
// rejected: the motivating throw lands on a streamed re-render, a
// query-cache-driven external-store update -- exactly the React 19
// case where the nearest boundary can be skipped and the outer
// per-session boundary catches first (the known limitation recorded
// at the thread boundary in SessionPane; it does not reproduce in
// isolation), so the narrower boundary would pass an isolated test
// yet stay inert in the real tree. The session-level posture is also
// the honest one: the failure is loud (logged plus a visible degrade
// card), vanishingly rare, and cheap to leave behind -- retry remounts
// the thread, and the settle swap replaces the live block with the
// settled round block's own fresh subtree anyway.
//
// A vega-lite fence renders as a chart on the settled side and as a
// placeholder on the streaming side (ADR-0120 Decision 4); the choice is the
// `mode` prop, threaded by the live round block. Every other fence language
// -- and a language-less fence -- stays a plain code block (Decision 6: no
// guessing).
//
// The caret (a block glyph after the last block) is the round-is-alive
// signal: `isAnimating` follows the mode, and the library suppresses the
// glyph while the last block is an unclosed fence.
//
// The word cascade (issue #1137): `animated` rides the boolean default
// (fadeIn 150ms, word separation, the library's stagger defaults), and the
// same isAnimating gate that arms the caret builds the animate plugin --
// live only, so the settle swap renders zero animate spans and the parity
// holds. The plugin skips pre/svg/math/annotation subtrees (code blocks and
// the vega fence body never cascade; markdown never produces the MathML
// annotation); its keyframes live in the library's
// styles.css (imported at the CSS entry) with a prefers-reduced-motion
// cutoff in app.css, which the library ships without.
//
// Direction stays
// untouched: any per-block direction (auto probing included) wraps every
// block in a display-contents div, so the default -- no dir asked for --
// keeps the inherited direction without the wrapper element.

import { memo, useContext, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import type { Components, ExtraProps, StreamdownProps } from "streamdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useIntl } from "react-intl";
import { log } from "../../lib/log";
import { VizFence, VizFencePending } from "../viz/VizFence";
import { VizStageLinkContext, type VizStageLink } from "../viz/viz-stage-link";
import { CopyButton } from "./CopyButton";
import { CODE_BLOCK_REVEAL_CLASS } from "./turn-visual";

// The hast element type streamdown itself hands to components -- derived
// from its own typings so no hast package import is needed.
type HastElement = NonNullable<ExtraProps["node"]>;

// The render-mode vocabulary (issue #1128, replacing `isLive`): "streaming"
// while the round streams, "static" once settled. Exported so the mode prop
// and the test helper spell the vocabulary from one source.
export type RoundProseMode = "streaming" | "static";

// The one fence language that renders as a chart (ADR-0120 Decision 6). Any
// other value -- including a language-less fence -- is not a chart intent.
const VEGA_LITE_FENCE = "vega-lite";

// Module-level constants: see the streaming contract in the file header. An
// empty rehype list replaces the library's raw/sanitize defaults (the
// embedded-HTML posture above); gfm is carried explicitly because the list
// replaces the library's default remark plugins too.
const REMARK_PLUGINS: NonNullable<StreamdownProps["remarkPlugins"]> = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS: NonNullable<StreamdownProps["rehypePlugins"]> = [];

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
// relative refs -- degrades to plain text with the surviving href beside
// the label, so the target never vanishes from the visible surface (a
// [email us](mailto:...) answer stays contentful). A link title rides the
// anchor only -- the degrade lanes drop it, an accepted loss: a plain-text
// span carrying a tooltip would contradict the degradation. Streamdown's
// urlTransform passes non-web schemes through un-stripped, so the unsafe ones
// (javascript:, file:, ...) arrive here whole and the http(s) gate below is
// what keeps them off the anchor element; the library's own
// `streamdown:incomplete-link` placeholder (remend's provisional href for a
// link still being written) is internal noise, never a real target -- it
// degrades to the bare label. An opener rejection surfaces as a
// caption-sized live note beside the link (role=status so screen readers
// announce it): the click already swallowed the default navigation, so
// silence would read as a dead button.
function ProseLink({
  href,
  title,
  children,
}: {
  href?: string;
  title?: string;
  children?: ReactNode;
}) {
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
          title={title}
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
  if (typeof href === "string" && href !== "" && !href.startsWith("streamdown:")) {
    return <span>{children} ({href})</span>;
  }
  return <span>{children}</span>;
}

// The settled `pre` door (ADR-0120): a vega-lite fence hands its body to the
// fence renderer (decode -> chart, or an honest disclosure); every other
// language stays the plain code block. The two doors differ in the vega-lite
// arm only -- the code-block fallback is the same call on both sides.
function SettledPre({ node }: { node?: HastElement }) {
  // The stage link rides context, not a prop: the components map is a
  // module-level constant (the streaming contract above), so the door cannot
  // close over per-render values. Identity = the raw body text, so twin
  // fences sharing a body light together (issue #1093).
  const link = useContext(VizStageLinkContext);
  // The mdast-to-hast conversion appends one trailing newline to the code
  // text (the CodeBlock copy payload drops it the same way); the stage
  // identity and the decode input are the clean body.
  const body = hastTextContent(node).replace(/\n$/, "");
  return codeLanguage(node) === VEGA_LITE_FENCE ? (
    <VizFence
      spec={body}
      onSelectViz={link?.onSelectViz}
      selected={link !== null && link.selectedVizSpec === body}
    />
  ) : (
    <CodeBlock node={node} />
  );
}

// The streaming `pre` door (ADR-0120 Decision 4): a vega-lite fence renders
// as a placeholder only -- no parse, no failure judgment, and never the
// half-streamed source.
function LivePre({ node }: { node?: HastElement }) {
  return codeLanguage(node) === VEGA_LITE_FENCE ? (
    <VizFencePending />
  ) : (
    <CodeBlock node={node} />
  );
}

// Module-level constants: see the streaming contract in the file header.
// The block-level entries that land directly under the root carry no margin
// classes: the root's space-y-4 owns the inter-block rhythm, and Tailwind
// v4's space-y selector sits inside :where() (zero specificity) -- any
// m-0 here would outrank it and flatten the rhythm back to flush blocks.
// (CodeBlock's inner pre keeps a nested m-0, but it sits inside the
// wrapper div, out of the root's space-y reach.)
const BASE_MARKDOWN_COMPONENTS: Components = {
  // The chat-stream heading ladder: full-size document headings would shout
  // over the discourse in the 320px rail, so markdown headings compress -- h1
  // lands at 17px and each level steps down 1px; h4 and below stay at body
  // size and only gain weight. Weight caps at 600 (DESIGN.md forbids 700).
  h1: ({ children }) => <h1 className="text-[1.0625rem] font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[0.9375rem] font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-semibold">{children}</h4>,
  h5: ({ children }) => <h5 className="text-sm font-semibold">{children}</h5>,
  h6: ({ children }) => <h6 className="text-sm font-semibold">{children}</h6>,
  // Bare on purpose: preflight plus the root's rhythm cover the paragraph,
  // and the explicit entry keeps the no-margin contract over its most
  // common block.
  p: ({ children }) => <p>{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="border-l border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  // No `pre` entry here on purpose: the fence door is the one thing the
  // settled and streaming maps differ on (see the file header), so each
  // derived map supplies its own. A base `pre` would be dead weight that
  // silently wins if a future map forgets to override it. The same applies
  // to fenced code's inner element: streamdown routes INLINE code to the
  // `inlineCode` entry, so the muted monospace chip lives there and no
  // `code` entry shadows the library's fenced handling.
  inlineCode: ({ children }) => (
    <code className="rounded-xs bg-muted px-1.5 py-0.5 font-mono text-[13px]">{children}</code>
  ),
  // Bare by design: streamdown replaces some tags with its own styled
  // surface (li item padding with inline inner paragraphs, a span for
  // strong, table-row/-section chrome, text-sm on sup), so the bare
  // entries pin today's preflight-native
  // rendering, picking the attributes the hast conversion actually produces
  // (className on li is the task-list hook; the checkbox triple is a task
  // item's full shape). The input entry exists for readOnly: the library
  // ships no checkbox styling, but a bare input would trip React's
  // controlled-input warning on the checked attribute. em and del carry no
  // library replacement and no attributes, so they need no entries. Two
  // further library keys were evaluated and deliberately left on the
  // library's entry (issue #1130): `sub` is unreachable through this
  // pipeline (no markdown construct produces it, and raw HTML never becomes
  // an element), and `section` is the library's GFM footnote handler --
  // its payload is footnote content collapsing, not styling, so a bare
  // entry would change rendering rather than pin it.
  li: ({ children, className }) => <li className={className}>{children}</li>,
  strong: ({ children }) => <strong>{children}</strong>,
  tr: ({ children }) => <tr>{children}</tr>,
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  sup: ({ children }) => <sup>{children}</sup>,
  input: ({ type, checked, disabled }) => (
    <input type={type} checked={checked} disabled={disabled} readOnly />
  ),
  // The spread arrow keeps the entry's parameter type inferred from the
  // Components map (a direct ProseLink reference fights the map's index
  // signature); the extra renderer props (node) dissolve into the
  // component's own signature.
  a: (props) => <ProseLink {...props} />,
  // Remote images never load (the CSP allows only self/data/blob/asset), so a
  // default img would render as a broken placeholder -- the alt text carries
  // the content with the untransformed URL beside it, so where the image
  // lives never vanishes from the visible surface; an empty alt degrades to
  // the bare URL rather than to nothing (an image-led answer stays visible).
  img: ({ alt, src }) => {
    if (typeof src !== "string" || src === "") {
      return alt ? <span>{alt}</span> : null;
    }
    return <span>{alt ? `${alt} (${src})` : src}</span>;
  },
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-md border border-border">
      {/* min-w-max: w-full alone lets a table whose min-content fits the
          column squeeze down to the column width (cells wrap, no scroll
          range appears); min-width:max-content keeps the table at natural
          width so a wide table gets a real scroll range instead of
          squeezing (issue #860), while narrow tables still fill via
          w-full. */}
      <table className="w-full min-w-max border-collapse [&_tr:last-child>td]:border-b-0">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border bg-muted px-2 py-1 text-left font-semibold align-top">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-b border-border px-2 py-1 align-top">{children}</td>,
  hr: () => <hr className="border-0 border-t border-border" />,
};

// The two doors over the shared map (see the file header): the settled side
// renders a vega-lite fence as a chart, the streaming side as a placeholder.
// Both are module-level constants so neither identity moves across streamed
// deltas.
const SETTLED_MARKDOWN_COMPONENTS: Components = {
  ...BASE_MARKDOWN_COMPONENTS,
  pre: SettledPre,
};

const LIVE_MARKDOWN_COMPONENTS: Components = {
  ...BASE_MARKDOWN_COMPONENTS,
  pre: LivePre,
};

export const RoundProse = memo(function RoundProse({
  text,
  mode = "static",
  onSelectViz,
  selectedVizSpec,
}: {
  text: string;
  /** The render mode (issue #1128, replacing `isLive`): "streaming" while
   * the round streams (the live exchange, issue #610) -- the caret arms.
   * "static" for every settled consumer -- the round block, the textual
   * outcome, the delegation trace, the artifact view -- where a vega-lite
   * fence decodes (ADR-0120 Decision 4). The mode drives only the
   * components door and the caret here; the library's mode prop stays
   * unset (see the file header), so remend runs on both sides and the
   * settle swap keeps the same shape. */
  mode?: RoundProseMode;
  /** Issue #1093: promotes a settled fence's body onto the workspace stage.
   *  Optional (the ArtifactCard read-only precedent): only the TurnCard
   *  stream wires it -- the delegation dialog and the md artifact renderer
   *  mount RoundProse bare, so their fences stay static. */
  onSelectViz?: (spec: string) => void;
  /** Issue #1093: the staged spec text, for the in-stream selection mirror.
   *  null (or an absent handler) = no fence is lit. */
  selectedVizSpec?: string | null;
}) {
  // Stable link value: an absent handler is null (static surface); a wired
  // one mints the link once per handler/selection change, so the provider's
  // consumers re-render only when the mirror actually moves.
  const link = useMemo<VizStageLink | null>(
    () =>
      onSelectViz === undefined
        ? null
        : { onSelectViz, selectedVizSpec: selectedVizSpec ?? null },
    [onSelectViz, selectedVizSpec],
  );
  return (
    <VizStageLinkContext.Provider value={link}>
      {/* round-text is a cross-module stability hook: this suite's own pins
          plus TurnCard/Thread's composition selectors
          (`.turn-outcome.textual .round-text`) query through it. The classes
          merge onto the library's own root (its tailwind-merge dedupes the
          shared space-y-4), so the wrapper div from the react-markdown era
          is gone. max-w-full: on the #847 materialized face the root hangs
          off the stream (flex-col items-start) as a non-stretched flex item,
          so its min-content (a wide markdown table) stretches the whole item
          past the card and the rail's overflow-x crops it -- the #826
          trace-round cap's prose twin (issue #860); the other consumers sit
          inside already-capped containers (.trace-round, .turn-outcome.textual). */}
      <Streamdown
        className="round-text m-0 mt-0.5 max-w-full space-y-4 text-sm leading-[1.75] text-foreground break-words"
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={mode === "streaming" ? LIVE_MARKDOWN_COMPONENTS : SETTLED_MARKDOWN_COMPONENTS}
        caret="block"
        isAnimating={mode === "streaming"}
        animated
      >
        {text}
      </Streamdown>
    </VizStageLinkContext.Provider>
  );
});
