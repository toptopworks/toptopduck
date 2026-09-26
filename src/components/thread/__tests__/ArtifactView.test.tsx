// Tests for the workspace artifact stage (ADR-0124 Decision 4, issue #1088):
// the render matrix. The load-bearing pin is the iframe's sandbox attribute
// -- exactly "allow-scripts", never allow-same-origin -- the trust boundary
// that keeps agent-generated HTML executable but opaque-origin. The IPC
// reads (artifactExists / readArtifactText) and the OS opener are mocked;
// convertFileSrc is a pure transform and stays real.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";
import { openPath } from "@tauri-apps/plugin-opener";
import { catalogFor } from "../../../i18n";
import { artifactExists, readArtifactText } from "../../../api";
import { ArtifactView } from "../ArtifactView";
import { TooltipProvider } from "../../ui/tooltip";

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

const DUCK = "C:/sessions/s1/session.duck";

function renderView(path: string, renderKind: "html" | "markdown" | "card", duckPath = DUCK) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
        <TooltipProvider>
          <ArtifactView
            artifact={{ path, file_name: path.split("/").pop() ?? path }}
            render={renderKind}
            duckPath={duckPath}
          />
        </TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe("ArtifactView", () => {
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

    it("degrades out-of-scope HTML (a user-directory original) to the card", () => {
      vi.mocked(artifactExists).mockResolvedValue(true);
      renderView("C:/Users/me/report.html", "html");
      expect(screen.getByTestId("artifact-card")).toBeInTheDocument();
      expect(screen.queryByTestId("artifact-frame")).not.toBeInTheDocument();
    });

    it("degrades a missing in-scope HTML file to the not-openable card", async () => {
      // The iframe gate shares the exists cache entry: a deleted file must
      // render the card, not a WebView denial inside the opaque origin.
      vi.mocked(artifactExists).mockResolvedValue(false);
      renderView("C:/sessions/s1/artifacts/gone.html", "html");
      expect(await screen.findByTestId("artifact-card")).toBeInTheDocument();
      expect(screen.getByText(/已不在磁盘上|no longer on disk/)).toBeInTheDocument();
      expect(screen.queryByTestId("artifact-frame")).not.toBeInTheDocument();
    });
  });

  describe("markdown branch (IPC text + prose renderer)", () => {
    it("renders the read text through the shared prose pipeline", async () => {
      vi.mocked(readArtifactText).mockResolvedValue("# Heading\n\nBody text");
      renderView("C:/sessions/s1/artifacts/notes.md", "markdown");
      expect(await screen.findByText("Body text")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1, name: "Heading" })).toBeInTheDocument();
    });

    it("degrades a refused read (over the size cap) to the card", async () => {
      vi.mocked(readArtifactText).mockRejectedValue(new Error("exceeds cap"));
      vi.mocked(artifactExists).mockResolvedValue(true);
      renderView("C:/sessions/s1/artifacts/huge.md", "markdown");
      expect(await screen.findByTestId("artifact-card")).toBeInTheDocument();
    });
  });

  describe("card branch (pdf/docx/xlsx/pptx + degrades)", () => {
    it("offers the external open for a file that exists", async () => {
      vi.mocked(artifactExists).mockResolvedValue(true);
      vi.mocked(openPath).mockResolvedValue(undefined);
      renderView("C:/sessions/s1/artifacts/report.pdf", "card");
      fireEvent.click(await screen.findByRole("button", { name: /外部打开|externally/ }));
      await waitFor(() => expect(openPath).toHaveBeenCalledWith("C:/sessions/s1/artifacts/report.pdf"));
    });

    it("renders the not-openable state when the file is gone", async () => {
      vi.mocked(artifactExists).mockResolvedValue(false);
      renderView("C:/sessions/s1/artifacts/gone.pdf", "card");
      expect(await screen.findByText(/已不在磁盘上|no longer on disk/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /外部打开|externally/ })).not.toBeInTheDocument();
    });

    it("surfaces an opener failure as a live note", async () => {
      vi.mocked(artifactExists).mockResolvedValue(true);
      vi.mocked(openPath).mockRejectedValue(new Error("no association"));
      renderView("C:/sessions/s1/artifacts/report.pdf", "card");
      fireEvent.click(await screen.findByRole("button", { name: /外部打开|externally/ }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        /无法在外部打开|Could not open/,
      );
    });
  });
});
