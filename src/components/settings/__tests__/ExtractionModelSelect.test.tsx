import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { baseAppConfig } from "../../../test-fixtures";
import type { AppConfig } from "../../../types/app-config";
import type { ProviderConfig } from "../../../types/provider";
import { ExtractionModelSelect } from "../ExtractionModelSelect";
import { chooseOption, openSelect, renderSettings } from "./helpers";

// The extraction-model row's contract (issue #1530, ADR-0147 Decision 7):
// the option set (follow-active + the profile pool, active marked), the
// draft + Save gate (a pending pick persists only on Save), the namespaced
// key decoding (`profile:<id>` / follow-active -> null, the Radix
// empty-string-value workaround), the dangling-pointer face, and the
// refusal path (draft survives + inline error).

const provider: ProviderConfig = {
  active_profile: "p2",
  profiles: [
    { id: "p1", display_name: "Cheap profile", protocol: "anthropic", base_url: "https://example.invalid", model: "claude-sonnet-5-5" },
    { id: "p2", display_name: "Main profile", protocol: "anthropic", base_url: "https://example.invalid", model: "claude-sonnet-5-5" },
  ],
};

function renderControl(
  overrides: Partial<React.ComponentProps<typeof ExtractionModelSelect>> = {},
) {
  const props: React.ComponentProps<typeof ExtractionModelSelect> = {
    provider,
    memoryExtractionProfile: null,
    onCommit: vi.fn(async () => null),
    ...overrides,
  };
  return { props, ...renderSettings(<ExtractionModelSelect {...props} />) };
}

/** Run the mutate the commit channel captured against a base config and
 *  return the resulting stored pointer (the write's actual payload). */
function committedProfile(
  onCommit: React.ComponentProps<typeof ExtractionModelSelect>["onCommit"],
): string | null {
  expect(onCommit).toHaveBeenCalledTimes(1);
  const cfg: AppConfig = vi.mocked(onCommit).mock.calls[0][0](baseAppConfig());
  return cfg.memory_extraction_profile;
}

describe("ExtractionModelSelect (issue #1530)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists follow-active plus every profile, marking the active one", async () => {
    renderControl({ memoryExtractionProfile: "p1" });
    const combobox = await screen.findByRole("combobox", {
      name: "Memory extraction model",
    });
    expect(combobox).toHaveTextContent("Cheap profile");

    openSelect(combobox);
    expect(
      screen.getByRole("option", { name: "Follow active profile" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Cheap profile" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Main profile *" }),
    ).toBeInTheDocument();
  });

  it("persists the picked profile only on Save, then drops the draft", async () => {
    const { props } = renderControl({ memoryExtractionProfile: "p1" });
    const combobox = await screen.findByRole("combobox", {
      name: "Memory extraction model",
    });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    openSelect(combobox);
    // A pick equal to the persisted value is no draft; the OTHER profile is.
    chooseOption("Main profile *");
    await waitFor(() => expect(save).toBeEnabled());

    fireEvent.click(save);
    await waitFor(() => expect(props.onCommit).toHaveBeenCalledTimes(1));
    expect(committedProfile(props.onCommit)).toBe("p2");
    // Persisted: the prop carries the value and the draft cleared.
    await waitFor(() => expect(save).toBeDisabled());
  });

  it("persists null when the pick is follow-active", async () => {
    const { props } = renderControl({ memoryExtractionProfile: "p1" });
    const combobox = await screen.findByRole("combobox", {
      name: "Memory extraction model",
    });

    openSelect(combobox);
    chooseOption("Follow active profile");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.onCommit).toHaveBeenCalledTimes(1));
    expect(committedProfile(props.onCommit)).toBeNull();
  });

  it("renders a dangling stored pointer as follow-active", async () => {
    renderControl({ memoryExtractionProfile: "gone" });
    const combobox = await screen.findByRole("combobox", {
      name: "Memory extraction model",
    });
    expect(combobox).toHaveTextContent("Follow active profile");
  });

  it("disarms Save again when the pick returns to the persisted value", async () => {
    const { props } = renderControl({ memoryExtractionProfile: "p1" });
    const combobox = await screen.findByRole("combobox", {
      name: "Memory extraction model",
    });
    const save = screen.getByRole("button", { name: "Save" });

    openSelect(combobox);
    chooseOption("Main profile *");
    await waitFor(() => expect(save).toBeEnabled());
    openSelect(combobox);
    chooseOption("Cheap profile");
    // The pick equals the persisted pointer again: no draft, no commit.
    await waitFor(() => expect(save).toBeDisabled());
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("disables the picker and shows the empty-pool guide", async () => {
    renderControl({ provider: { profiles: [], active_profile: null } });
    const combobox = await screen.findByRole("combobox", {
      name: "Memory extraction model",
    });
    expect(combobox).toBeDisabled();
    expect(
      await screen.findByText("Add a profile above to enable extraction."),
    ).toBeInTheDocument();
  });

  it("keeps the draft and shows the refusal inline when the commit fails", async () => {
    const { props } = renderControl({
      onCommit: vi.fn(async () => "refused"),
    });
    const combobox = await screen.findByRole("combobox", {
      name: "Memory extraction model",
    });

    openSelect(combobox);
    chooseOption("Cheap profile");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("refused")).toBeInTheDocument();
    // The draft survived: Save stays armed for the retry.
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(props.onCommit).toHaveBeenCalledTimes(1);
  });
});
