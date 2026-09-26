// Tests for the rail artifact card (ADR-0124 Decision 3, issue #1088): the
// manifest renders as one row per delivered file, a click selects that file
// onto the workspace stage, the viewed row mirrors active, a stale turn
// dashes the card, and a row whose file no longer exists degrades to the
// not-openable state (existence is a render-time fact, the manifest is never
// rewritten). artifactExists crosses IPC, so the api module is mocked; the
// exists query needs a QueryClientProvider.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";
import { catalogFor } from "../../../i18n";
import { artifactExists } from "../../../api";
import { ArtifactCard } from "../ArtifactCard";
import type { TurnArtifact } from "../../../types/thread";

vi.mock("../../../api", () => ({
  artifactExists: vi.fn(),
}));

const entry = (path: string, fileName: string): TurnArtifact => ({
  path,
  file_name: fileName,
  durable: true,
});

function renderCard(
  artifacts: TurnArtifact[],
  { activePath = null, stale = false }: { activePath?: string | null; stale?: boolean } = {},
) {
  const onSelectFile = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
        <ArtifactCard
          artifacts={artifacts}
          activePath={activePath}
          stale={stale}
          onSelectFile={onSelectFile}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { onSelectFile };
}

describe("ArtifactCard", () => {
  it("renders one row per manifest entry with the delivered-files label", () => {
    vi.mocked(artifactExists).mockResolvedValue(true);
    renderCard([entry("/a/report.pdf", "report.pdf"), entry("/a/page.html", "page.html")]);
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("page.html")).toBeInTheDocument();
    expect(screen.getByText(/交付文件/)).toBeInTheDocument();
  });

  it("a row click selects that file (the caller moves the stage)", async () => {
    vi.mocked(artifactExists).mockResolvedValue(true);
    const { onSelectFile } = renderCard([entry("/a/report.pdf", "report.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: /report\.pdf/ }));
    expect(onSelectFile).toHaveBeenCalledWith("/a/report.pdf");
  });

  it("mirrors the viewed file onto its row (dual-view linkage)", () => {
    vi.mocked(artifactExists).mockResolvedValue(true);
    renderCard([entry("/a/report.pdf", "report.pdf")], { activePath: "/a/report.pdf" });
    expect(screen.getByRole("button", { name: /report\.pdf/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("degrades a missing file to the not-openable row and keeps the entry", async () => {
    vi.mocked(artifactExists).mockResolvedValue(false);
    renderCard([entry("/gone.pdf", "gone.pdf")]);
    // The row is no longer a button -- nothing to click -- and the name
    // stays (the manifest is never rewritten, ADR-0124 Decision 2).
    const missing = await screen.findByTestId("artifact-row-missing");
    expect(missing).toHaveTextContent("gone.pdf");
    expect(screen.queryByRole("button", { name: /gone\.pdf/ })).not.toBeInTheDocument();
  });

  it("dashes the card on a stale turn", () => {
    vi.mocked(artifactExists).mockResolvedValue(true);
    renderCard([entry("/a/report.pdf", "report.pdf")], { stale: true });
    expect(document.querySelector(".artifacts-card")).toHaveAttribute("data-stale", "true");
    expect(document.querySelector(".artifacts-card")).toHaveClass("border-dashed");
  });

  it("renders read-only when no handler is wired (honest degrade)", () => {
    vi.mocked(artifactExists).mockResolvedValue(true);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <ArtifactCard
            artifacts={[entry("/a/report.pdf", "report.pdf")]}
            activePath={null}
            stale={false}
          />
        </IntlProvider>
      </QueryClientProvider>,
    );
    // The row still renders; the click is simply unwired.
    expect(screen.getByRole("button", { name: /report\.pdf/ })).toBeInTheDocument();
  });
});
