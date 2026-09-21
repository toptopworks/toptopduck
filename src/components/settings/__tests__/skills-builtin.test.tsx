import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";

import { SkillsSection } from "../SkillsSection";
import { chooseOption, openSelect } from "./helpers";
import { TooltipProvider } from "../../ui/tooltip";
import { listSkills, restoreBuiltinSkill } from "../../../api";
import { baseAppConfig, skillEntry } from "../../../test-fixtures";

// The builtin-skill surface of the settings pane (issue #677): the built-in
// badge + the disabled delete entry, the Edited derivation off the baseline
// side table, the restore confirmation lane, and the locked name in the edit
// drawer.
vi.mock("../../../api", () => ({
  listSkills: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  restoreBuiltinSkill: vi.fn(),
  listSkillSources: vi.fn(),
  importSkills: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

const builtinSkill = skillEntry("pandoc", {
  description: "Convert documents between formats.",
  acquired: "builtin",
  body: "Use the `pandoc` tool…\n",
  content_hash: "hash-of-shipped-body",
});

const restoredConfig = baseAppConfig();

// The pane under test, parameterized by the side table (the Edited
// derivation's anchor). Empty-catalog English IntlProvider: FormattedMessage
// falls back to defaultMessage (the canonical English source, ADR-0052).
function renderSection(baselines: Record<string, { hash: string; locale: string }>) {
  const onSync = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider>
          <SkillsSection
            builtinSkillBaselines={baselines}
            onAppConfigSync={onSync}
          />
        </TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return onSync;
}

describe("SkillsSection builtin rows (issue #677)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkills).mockResolvedValue({
      skills: [builtinSkill],
      ignored: [],
      root_error: null,
    });
  });

  it("shows the system badge and a disabled delete button on a builtin row", async () => {
    renderSection({ pandoc: { hash: "hash-of-shipped-body", locale: "en-US" } });
    const row = await screen.findByTestId("skill-row");
    expect(row).toHaveTextContent("system");
    // Undeletable (issue #677): the trash renders disabled so the row action
    // column stays aligned with deletable rows.
    expect(
      screen.getByRole("button", { name: "Delete skill pandoc" }),
    ).toBeDisabled();
  });

  it("keeps a click on the builtin row's disabled delete from opening the edit drawer", async () => {
    renderSection({ pandoc: { hash: "hash-of-shipped-body", locale: "en-US" } });
    await screen.findByTestId("skill-row");
    // The delete (disabled or not) sits outside the row's open-edit target
    // -- clicking it must never open the drawer.
    fireEvent.click(
      screen.getByRole("button", { name: "Delete skill pandoc" }),
    );
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("explains the disabled delete through the shutdown tooltip (#1015)", async () => {
    renderSection({ pandoc: { hash: "hash-of-shipped-body", locale: "en-US" } });
    const del = await screen.findByRole("button", {
      name: "Delete skill pandoc",
    });
    // Radix Tooltip opens on pointermove (the trigger has no pointerenter
    // open path); delayDuration is 0 under the test's TooltipProvider.
    fireEvent.pointerMove(del);
    expect(
      await screen.findByText(
        "System skills cannot be deleted; disable the skill instead",
      ),
    ).toBeInTheDocument();
  });

  it("shows no Edited badge on a row agreeing with its recorded baseline", async () => {
    renderSection({ pandoc: { hash: "hash-of-shipped-body", locale: "en-US" } });
    const row = await screen.findByTestId("skill-row");
    expect(row).not.toHaveTextContent("Edited");
  });

  it("shows Edited + restore on a drifted hash and restores through the confirm lane", async () => {
    const onSync = renderSection({
      pandoc: { hash: "an-older-recorded-hash", locale: "en-US" },
    });
    const row = await screen.findByTestId("skill-row");
    expect(row).toHaveTextContent("Edited");
    // The restore takes the row-end action slot: no delete beside it.
    expect(
      screen.queryByRole("button", { name: "Delete skill pandoc" }),
    ).toBeNull();
    vi.mocked(restoreBuiltinSkill).mockResolvedValue(restoredConfig);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Restore built-in definition for skill pandoc",
      }),
    );
    // Like the switch and the disabled delete, the restore sits outside
    // the open-edit target: clicking it must not open the drawer.
    expect(screen.queryByLabelText("Name")).toBeNull();
    // The confirm-dialog gate: the IPC fires only after the action.
    expect(restoreBuiltinSkill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => {
      expect(restoreBuiltinSkill).toHaveBeenCalledWith("pandoc");
    });
    await waitFor(() => {
      expect(onSync).toHaveBeenCalledWith(restoredConfig);
    });
  });

  it("locks the name input when editing a builtin skill", async () => {
    renderSection({ pandoc: { hash: "hash-of-shipped-body", locale: "en-US" } });
    fireEvent.click(await screen.findByText("pandoc"));
    const nameInput = await screen.findByLabelText("Name");
    expect(nameInput).toBeDisabled();
    expect(screen.getByText("Built-in skill names are locked")).toBeInTheDocument();
    // The rest of the drawer stays editable (save is present).
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("filters builtin rows through the acquired filter", async () => {
    renderSection({ pandoc: { hash: "hash-of-shipped-body", locale: "en-US" } });
    await screen.findByTestId("skill-row");
    // Radix Select opens on a pointer sequence and commits on an option
    // click (the AgentsSection filter posture) -- fireEvent.change is
    // inert on it.
    const filter = screen.getByLabelText("Filter by skill type");
    openSelect(filter);
    chooseOption("System");
    expect(screen.getByTestId("skill-row")).toBeInTheDocument();
    openSelect(filter);
    chooseOption("Local");
    expect(screen.queryByTestId("skill-row")).toBeNull();
  });
});
