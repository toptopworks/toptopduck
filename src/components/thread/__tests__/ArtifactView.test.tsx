// Tests for the workspace artifact stage (ADR-0124 Decision 4, issue #1088):
// the render matrix under the persistent file header (issue #1199). The
// load-bearing pins are the two iframe trust postures -- html sandboxed to
// exactly "allow-scripts", pdf UNSANDBOXED (the built-in viewer is a document
// renderer, not agent HTML) -- and the header chrome that survives every
// degrade. The IPC reads (artifactExists / readArtifactText) and the OS
// opener are mocked; convertFileSrc is a pure transform and stays real.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";
import { openPath } from "@tauri-apps/plugin-opener";
import embed from "vega-embed";
import { catalogFor } from "../../../i18n";
import { artifactExists, readArtifactText } from "../../../api";
import { ArtifactView } from "../ArtifactView";

vi.mock("../../../api", () => ({
  artifactExists: vi.fn(),
  readArtifactText: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
}));
// convertFileSrc reads window.__TAURI_INTERNALS__ (absent in jsdom); a pure
// stand-in keeps the src assertion observable.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => "asset://mock/" + p,
}));
// A fence chart may ride an md artifact's prose; jsdom cannot run
// vega-embed, so its render is mocked -- the static pin below is then
// meaningful (chart draws, affordance absent), not vacuous.
vi.mock("vega-embed", () => ({
  default: vi.fn().mockResolvedValue({ finalize: vi.fn(), view: { resize: vi.fn() } }),
}));

const DUCK = "C:/sessions/s1/session.duck";

function renderView(
  path: string,
  renderKind: "html" | "pdf" | "markdown" | "card",
  duckPath = DUCK,
) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
        <ArtifactView
          artifact={{ path, file_name: path.split("/").pop() ?? path }}
          render={renderKind}
          duckPath={duckPath}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe("ArtifactView", () => {
  // Reset implementations too (resetAllMocks, not clearAllMocks): without
  // it, a persistent mockResolvedValue from an earlier case (e.g. the
  // pdf-missing exists -> false) bleeds into later cases that never set
  // their own. Every case below sets what its assertions depend on.
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("file header (the persistent stage chrome)", () => {
    it("shows the file name and the external-open action for an existing file", async () => {
      vi.mocked(artifactExists).mockResolvedValue(true);
      renderView("C:/sessions/s1/artifacts/report.pdf", "pdf");
      expect(screen.getByTestId("artifact-header")).toHaveTextContent("report.pdf");
      expect(await screen.findByRole("button", { name: /外部打开|externally/ })).toBeInTheDocument();
    });

    it("keeps the header name above the markdown prose", async () => {
      vi.mocked(readArtifactText).mockResolvedValue("# Heading\n\nBody text");
      renderView("C:/sessions/s1/artifacts/notes.md", "markdown");
      expect(screen.getByTestId("artifact-header")).toHaveTextContent("notes.md");
      expect(await screen.findByRole("heading", { level: 1, name: "Heading" })).toBeInTheDocument();
    });

    it("swaps the action for the missing note when the file is gone", async () => {
      vi.mocked(artifactExists).mockResolvedValue(false);
      renderView("C:/sessions/s1/artifacts/gone.pdf", "pdf");
      expect(await screen.findByText(/已不在磁盘上|no longer on disk/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /外部打开|externally/ })).not.toBeInTheDocument();
    });

    it("surfaces an opener failure as a live note", async () => {
      vi.mocked(artifactExists).mockResolvedValue(true);
      vi.mocked(openPath).mockRejectedValue(new Error("no association"));
      renderView("C:/sessions/s1/artifacts/report.pdf", "pdf");
      fireEvent.click(await screen.findByRole("button", { name: /外部打开|externally/ }));
      // Scoped to the header: the frame's loading indicator is a status
      // region too (issue #1201), and jsdom never fires load so both
      // coexist here.
      const header = screen.getByTestId("artifact-header");
      expect(await within(header).findByRole("status")).toHaveTextContent(
        /无法在外部打开|Could not open/,
      );
    });

    it("clears the failure note when a retry opens successfully", async () => {
      vi.mocked(artifactExists).mockResolvedValue(true);
      // Fresh Error instances per Once-stage: a reused instance keeps
      // rejecting through later stages.
      vi.mocked(openPath)
        .mockRejectedValueOnce(new Error("no association"))
        .mockResolvedValueOnce(undefined);
      renderView("C:/sessions/s1/artifacts/report.pdf", "pdf");
      const open = await screen.findByRole("button", { name: /外部打开|externally/ });
      fireEvent.click(open);
      const header = screen.getByTestId("artifact-header");
      expect(await within(header).findByRole("status")).toBeInTheDocument();
      fireEvent.click(open);
      // The still-mounted loading indicator (jsdom never fires load) is a
      // status region outside the header -- only the note vanishing from
      // the header is the signal.
      await waitFor(() =>
        expect(within(header).queryByRole("status")).not.toBeInTheDocument(),
      );
    });
  });

  describe("html branch (the isolated shell)", () => {
    it("renders the asset-protocol iframe with sandbox pinned to allow-scripts only", () => {
      renderView("C:/sessions/s1/artifacts/page.html", "html");
      const frame = screen.getByTestId("artifact-frame");
      // THE trust-boundary pin (ADR-0124 Decision 4): scripts execute, but
      // the opaque origin holds -- allow-same-origin must never appear.
      expect(frame).toHaveAttribute("sandbox", "allow-scripts");
      expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
      // The asset URL routes through convertFileSrc (the asset protocol).
      expect(frame.getAttribute("src")).toContain("page.html");
      expect(frame.getAttribute("title")).toBe("page.html");
    });

    it("degrades out-of-scope HTML (a user-directory original) to the face", async () => {
      vi.mocked(artifactExists).mockResolvedValue(true);
      renderView("C:/Users/me/report.html", "html");
      // findBy waits out the exists query so the assertions land on the
      // resolved state, not the optimistic pending render.
      expect(await screen.findByTestId("artifact-face")).toBeInTheDocument();
      expect(screen.queryByTestId("artifact-frame")).not.toBeInTheDocument();
      // The degrade never eats the chrome: name + open stay in the header.
      expect(screen.getByTestId("artifact-header")).toHaveTextContent("report.html");
      expect(await screen.findByRole("button", { name: /外部打开|externally/ })).toBeInTheDocument();
    });

    it("degrades a missing in-scope HTML file to the face, not a denial frame", async () => {
      // The iframe gate shares the exists cache entry: a deleted file must
      // render the face, not a WebView denial inside the opaque origin.
      vi.mocked(artifactExists).mockResolvedValue(false);
      renderView("C:/sessions/s1/artifacts/gone.html", "html");
      expect(await screen.findByTestId("artifact-face")).toBeInTheDocument();
      expect(screen.queryByTestId("artifact-frame")).not.toBeInTheDocument();
      expect(await screen.findByText(/已不在磁盘上|no longer on disk/)).toBeInTheDocument();
    });
  });

  describe("pdf branch (the unsandboxed viewer, issue #1199)", () => {
    it("renders the asset-protocol iframe with NO sandbox attribute", async () => {
      vi.mocked(artifactExists).mockResolvedValue(true);
      renderView("C:/sessions/s1/artifacts/report.pdf", "pdf");
      const frame = await screen.findByTestId("artifact-frame");
      // The inverse of the html trust boundary pin: the built-in viewer is
      // a document renderer, not executable agent HTML -- sandbox must be
      // absent entirely (an empty value would disable the frame).
      expect(frame).not.toHaveAttribute("sandbox");
      expect(frame.getAttribute("src")).toContain("report.pdf");
      expect(frame.getAttribute("title")).toBe("report.pdf");
    });

    it("degrades an out-of-scope pdf to the face", async () => {
      vi.mocked(artifactExists).mockResolvedValue(true);
      renderView("C:/Users/me/report.pdf", "pdf");
      expect(await screen.findByTestId("artifact-face")).toBeInTheDocument();
      expect(screen.queryByTestId("artifact-frame")).not.toBeInTheDocument();
    });

    it("degrades a missing pdf to the face, never an empty frame", async () => {
      vi.mocked(artifactExists).mockResolvedValue(false);
      renderView("C:/sessions/s1/artifacts/gone.pdf", "pdf");
      expect(await screen.findByTestId("artifact-face")).toBeInTheDocument();
      expect(screen.queryByTestId("artifact-frame")).not.toBeInTheDocument();
      expect(await screen.findByText(/已不在磁盘上|no longer on disk/)).toBeInTheDocument();
    });
  });

  describe("iframe loading indicator (issue #1201)", () => {
    it("shows the centered indicator until the pdf frame's load fires", async () => {
      vi.mocked(artifactExists).mockResolvedValue(true);
      renderView("C:/sessions/s1/artifacts/report.pdf", "pdf");
      const frame = await screen.findByTestId("artifact-frame");
      // jsdom never fires an iframe load on its own, so the indicator is up
      // at mount; the manual event stands in for the WebView's first paint.
      expect(screen.getByRole("status", { name: /正在加载|Loading/ })).toBeInTheDocument();
      fireEvent.load(frame);
      expect(
        screen.queryByRole("status", { name: /正在加载|Loading/ }),
      ).not.toBeInTheDocument();
    });

    it("covers the html branch identically, sandbox pin riding along untouched", async () => {
      vi.mocked(artifactExists).mockResolvedValue(true);
      renderView("C:/sessions/s1/artifacts/page.html", "html");
      expect(await screen.findByTestId("artifact-frame")).toBeInTheDocument();
      expect(screen.getByRole("status", { name: /正在加载|Loading/ })).toBeInTheDocument();
      fireEvent.load(screen.getByTestId("artifact-frame"));
      // Firing load removed the indicator and nothing else: the trust
      // posture is the same DOM as before the overlay existed.
      expect(screen.getByTestId("artifact-frame")).toHaveAttribute("sandbox", "allow-scripts");
      expect(
        screen.queryByRole("status", { name: /正在加载|Loading/ }),
      ).not.toBeInTheDocument();
    });
  });

  describe("markdown branch (IPC text + prose renderer)", () => {
    it("renders the read text through the shared prose pipeline", async () => {
      vi.mocked(readArtifactText).mockResolvedValue("# Heading\n\nBody text");
      renderView("C:/sessions/s1/artifacts/notes.md", "markdown");
      expect(await screen.findByText("Body text")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1, name: "Heading" })).toBeInTheDocument();
    });

    it("degrades a refused read (over the size cap) to the face under the intact header", async () => {
      vi.mocked(readArtifactText).mockRejectedValue(new Error("exceeds cap"));
      vi.mocked(artifactExists).mockResolvedValue(true);
      renderView("C:/sessions/s1/artifacts/huge.md", "markdown");
      expect(await screen.findByTestId("artifact-face")).toBeInTheDocument();
      expect(screen.getByTestId("artifact-header")).toHaveTextContent("huge.md");
    });

    it("keeps a vega-lite fence in an md artifact static (issue #1093 pin)", async () => {
      // MarkdownArtifact mounts RoundProse bare -- never through Thread's
      // stage link -- so a delivered report's fences are static content even
      // while the chart itself draws. The embed implementation is re-set
      // here: the suite-wide resetAllMocks clears the module factory's.
      vi.mocked(embed).mockResolvedValue({ finalize: vi.fn(), view: { resize: vi.fn() } } as never);
      vi.mocked(readArtifactText).mockResolvedValue(
        "# Report\n\n```vega-lite\n{\"mark\": \"bar\"}\n```",
      );
      renderView("C:/sessions/s1/artifacts/report.md", "markdown");
      await waitFor(() => expect(vi.mocked(embed)).toHaveBeenCalledTimes(1));
      expect(
        screen.queryByRole("button", { name: "在结果页查看图表" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("card branch (docx/xlsx/pptx + the unknown-format fallthrough)", () => {
    it("renders the idle face and fires the header's external open", async () => {
      vi.mocked(artifactExists).mockResolvedValue(true);
      vi.mocked(openPath).mockResolvedValue(undefined);
      renderView("C:/sessions/s1/artifacts/table.xlsx", "card");
      expect(screen.getByTestId("artifact-face")).toBeInTheDocument();
      fireEvent.click(await screen.findByRole("button", { name: /外部打开|externally/ }));
      await waitFor(() => expect(openPath).toHaveBeenCalledWith("C:/sessions/s1/artifacts/table.xlsx"));
    });
  });
});
