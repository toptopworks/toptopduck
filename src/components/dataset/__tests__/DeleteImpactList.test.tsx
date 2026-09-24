import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeleteImpactList } from "../DeleteImpactList";
import type { DeleteImpactEntry } from "../../../types/dataset";
import { renderI18n } from "../../common/__tests__/helpers";

// Runs offline via vi.mock on the api entry (the partial-mock pattern from
// useWorkingSet.test): the list reads `preview_delete_impact` and nothing
// else.
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return { ...actual, previewDeleteImpact: vi.fn() };
});

import { previewDeleteImpact } from "../../../api";

// The dialog suites need a QueryClient ancestor the shared i18n wrapper
// doesn't provide; retry:false keeps the failure test single-shot.
function renderImpact(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderI18n(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const entry = (reference_name: string, display_name: string): DeleteImpactEntry => ({
  reference_name,
  display_name,
});

describe("DeleteImpactList (issue #1063)", () => {
  // Clear call history between tests (the module-mock spy is shared across
  // the suite; restore would strip the impls the per-test mockResolvedValue
  // re-seeds anyway, but only clear wipes the call record).
  afterEach(() => vi.clearAllMocks());

  it("lists each affected result by display name under the impact title", async () => {
    vi.mocked(previewDeleteImpact).mockResolvedValue([
      entry("result_1", "销量汇总"),
      entry("result_2", "Orders by month"),
    ]);
    renderImpact(<DeleteImpactList sessionId="s1" referenceName="people" />);

    await waitFor(() => expect(screen.getByText("受影响的结果")).toBeInTheDocument());
    expect(screen.getByText("销量汇总")).toBeInTheDocument();
    expect(screen.getByText("Orders by month")).toBeInTheDocument();
  });

  it("renders nothing when the removal affects no results", async () => {
    vi.mocked(previewDeleteImpact).mockResolvedValue([]);
    const { container } = renderImpact(
      <DeleteImpactList sessionId="s1" referenceName="people" />,
    );

    // The empty closure keeps the whole section out of the dialog: silence
    // reads faster than a line the user must parse to learn the delete is
    // safe. The loading line withdraws once the empty preview lands.
    await waitFor(() =>
      expect(
        screen.queryByText("正在检查受影响的结果…"),
      ).not.toBeInTheDocument(),
    );
    expect(container.textContent).toBe("");
  });

  it("degrades to one error line when the preview fails -- the delete stays executable", async () => {
    // A typed SessionError render through the shared locale channel (the
    // same presentation the rest of the error surface uses), not a raw
    // string.
    vi.mocked(previewDeleteImpact).mockRejectedValue({ kind: "NotFound" });
    renderImpact(<DeleteImpactList sessionId="s1" referenceName="people" />);

    await waitFor(() =>
      expect(screen.getByText("会话不存在或已关闭")).toBeInTheDocument(),
    );
    // No list, no empty-state claim: the failure must not masquerade as
    // "nothing is affected".
    expect(screen.queryByText("不影响任何结果。")).not.toBeInTheDocument();
    expect(screen.queryByText("受影响的结果")).not.toBeInTheDocument();
  });

  it("shows the checking line while the preview query is in flight", async () => {
    // Deferred promise: the query stays pending until the test resolves it
    // (readRows was called != returned, issue #1061).
    let resolve!: (entries: DeleteImpactEntry[]) => void;
    vi.mocked(previewDeleteImpact).mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }),
    );
    renderImpact(<DeleteImpactList sessionId="s1" referenceName="people" />);

    expect(screen.getByText("正在检查受影响的结果…")).toBeInTheDocument();

    resolve([entry("result_1", "销量汇总")]);
    await waitFor(() => expect(screen.getByText("销量汇总")).toBeInTheDocument());
    expect(screen.queryByText("正在检查受影响的结果…")).not.toBeInTheDocument();
  });

  it("never fetches while its gates are closed (no dialog open)", () => {
    // Disabled query: no IPC, and the entries fallback renders the empty
    // line -- a state unreachable in production, where the list only mounts
    // with a dialog target in hand.
    renderImpact(<DeleteImpactList sessionId="s1" referenceName={null} />);
    expect(previewDeleteImpact).not.toHaveBeenCalled();
  });
});
