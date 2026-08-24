import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { McpServerForm } from "../McpServerForm";
import { probeMcpServer, setMcpServerSecret, upsertMcpServer } from "../../../api";
import type { McpServerConfig, McpProbeResult } from "../../../types/mcp";

// The form drives everything through IPC; mock the API so the test never
// touches Tauri.
vi.mock("../../../api", () => ({
  upsertMcpServer: vi.fn(),
  setMcpServerSecret: vi.fn(),
  probeMcpServer: vi.fn(),
}));

function makeServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "srv-1",
    display_name: "My Server",
    transport: { type: "stdio", command: "/bin/mcp-server", args: ["--port", "8080"] },
    env: { LOG_LEVEL: "info" },
    keychain_env_keys: ["API_KEY"],
    timeout_ms: null,
    enabled: true,
    ...overrides,
  };
}

function makeProbeResult(overrides: Partial<McpProbeResult> = {}): McpProbeResult {
  return { connected: true, tools: [], error: null, ...overrides };
}

// Empty-catalog English IntlProvider: FormattedMessage falls back to
// defaultMessage (the canonical English source, ADR-0052), so assertions anchor
// on stable English strings.
function renderWithProviders(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

describe("McpServerForm (issue #388)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the add title for a new server", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ id: "", display_name: "" })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("New MCP server")).toBeInTheDocument();
  });

  it("disables Add button when required fields are empty", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ id: "", display_name: "", transport: { type: "stdio", command: "", args: [] } })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Add")).toBeDisabled();
  });

  it("enables Add button when name + command are filled (stdio)", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ id: "", display_name: "My Server", transport: { type: "stdio", command: "/bin/mcp", args: [] } })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Add")).not.toBeDisabled();
  });

  it("disables Add when name is filled but url is empty (sse)", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ id: "", display_name: "My Server", transport: { type: "sse", url: "" } })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Add")).toBeDisabled();
  });

  it("renders the edit title for an existing server", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Edit MCP server")).toBeInTheDocument();
  });

  it("shows the back link", () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByText("Back to MCP list"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("pre-fills existing server fields in edit mode", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "My Server",
    );
    expect((screen.getByLabelText("Command") as HTMLInputElement).value).toBe(
      "/bin/mcp-server",
    );
    expect((screen.getByLabelText("Arguments (space-separated)") as HTMLInputElement).value).toBe(
      "--port 8080",
    );
  });

  it("pre-fills env entries from env + keychain_env_keys", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Non-secret env: LOG_LEVEL=info
    expect(screen.getByDisplayValue("LOG_LEVEL")).toBeInTheDocument();
    expect(screen.getByDisplayValue("info")).toBeInTheDocument();
    // Secret env: API_KEY (value empty — keychain is one-way)
    expect(screen.getByDisplayValue("API_KEY")).toBeInTheDocument();
  });

  it("conditionally renders url field for sse transport", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({
          transport: { type: "sse", url: "http://localhost:8080/sse" },
        })}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("URL")).toBeInTheDocument();
    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe(
      "http://localhost:8080/sse",
    );
    // Command field should NOT be present for sse.
    expect(screen.queryByLabelText("Command")).not.toBeInTheDocument();
  });

  it("adds a new env entry on Add variable click", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ env: {}, keychain_env_keys: [] })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Env editor is collapsed by default when empty — click to expand
    // (auto-adds a blank row).
    fireEvent.click(screen.getByText(/Environment variables/));

    fireEvent.click(screen.getByText("Add variable"));

    // Expand auto-adds one blank row, then Add variable adds another.
    expect(screen.queryAllByPlaceholderText("KEY")).toHaveLength(2);
    expect(screen.queryAllByPlaceholderText("value")).toHaveLength(2);
  });

  it("switching to JSON shows web-format config with secret keys blanked", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("JSON"));

    const textarea = screen.getByTestId("mcp-json-editor").querySelector("textarea")!;
    const json = textarea.value;

    // The JSON is in the common web format (bare server map)...
    expect(json).toContain("My Server");
    expect(json).toContain("command");
    expect(json).toContain("LOG_LEVEL");
    expect(json).toContain("info");
    // ...with flat transport fields, NOT our internal "transport" wrapper.
    expect(json).not.toContain("transport");
    expect(json).not.toContain("keychain_env_keys");
    // Secret keys appear with blanked values (actual values in keychain).
    const parsed = JSON.parse(json);
    const entry = parsed["My Server"];
    expect(entry.env).toEqual({ LOG_LEVEL: "info", API_KEY: "" });
  });

  it("switching JSON → Form reflects JSON edits in form fields", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Switch to JSON.
    fireEvent.click(screen.getByText("JSON"));
    const textarea = screen.getByTestId("mcp-json-editor").querySelector("textarea")!;
    // Edit the JSON: rename the server key (web format uses the key as name).
    const edited = JSON.parse(textarea.value);
    const oldKey = Object.keys(edited)[0];
    edited["Renamed Server"] = edited[oldKey];
    delete edited[oldKey];
    fireEvent.change(textarea, { target: { value: JSON.stringify(edited, null, 2) } });

    // Switch back to Form.
    fireEvent.click(screen.getByText("Form"));

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Renamed Server",
    );
  });

  it("blocks JSON → Form switch when JSON is invalid", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Switch to JSON.
    fireEvent.click(screen.getByText("JSON"));
    const textarea = screen.getByTestId("mcp-json-editor").querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "{ invalid json" } });

    // Attempt to switch back to Form.
    fireEvent.click(screen.getByText("Form"));

    // Still in JSON mode with error shown.
    expect(screen.getByText(/Invalid JSON/)).toBeInTheDocument();
    expect(textarea).toBeInTheDocument();
  });

  it("save calls upsert → secrets → probe → onSaved", async () => {
    const finalized = makeServer({ id: "minted-id" });
    const probeResult = makeProbeResult({
      tools: [{ name: "search", description: "Search" }],
    });
    vi.mocked(upsertMcpServer).mockResolvedValue(finalized);
    vi.mocked(setMcpServerSecret).mockResolvedValue(undefined);
    vi.mocked(probeMcpServer).mockResolvedValue(probeResult);

    const onSaved = vi.fn();
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledOnce();
    });

    // Upsert called with the form config.
    expect(upsertMcpServer).toHaveBeenCalledOnce();
    const sentConfig = vi.mocked(upsertMcpServer).mock.calls[0][0];
    expect(sentConfig.display_name).toBe("My Server");

    // setMcpServerSecret is NOT called when the secret value is empty
    // (the initialServer's keychain value is unknown — keychain is one-way).
    // Only non-empty secrets are written to the keychain.
    expect(setMcpServerSecret).not.toHaveBeenCalled();

    // Probe called with the finalized config.
    expect(probeMcpServer).toHaveBeenCalledWith(finalized);

    // onSaved receives finalized config + probe result.
    expect(onSaved).toHaveBeenCalledWith(finalized, probeResult);
  });

  it("preserves a disabled server's enablement through an edit (ADR-0106)", async () => {
    // The form never edits `enabled` (the settings row owns it): an edit of
    // a disabled server must save disabled -- a placeholder regression here
    // would re-arm the server through an innocent edit.
    const finalized = makeServer({ id: "srv-1", enabled: false });
    vi.mocked(upsertMcpServer).mockResolvedValue(finalized);
    vi.mocked(setMcpServerSecret).mockResolvedValue(undefined);
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ enabled: false })}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(upsertMcpServer).toHaveBeenCalledOnce();
    });
    expect(vi.mocked(upsertMcpServer).mock.calls[0][0].enabled).toBe(false);
  });

  it("saves a new server enabled (ADR-0106 Decision 4)", async () => {
    vi.mocked(upsertMcpServer).mockResolvedValue(makeServer({ id: "minted-id" }));
    vi.mocked(setMcpServerSecret).mockResolvedValue(undefined);
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ id: "" })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Add"));

    await waitFor(() => {
      expect(upsertMcpServer).toHaveBeenCalledOnce();
    });
    expect(vi.mocked(upsertMcpServer).mock.calls[0][0].enabled).toBe(true);
  });

  it("writes secret values to keychain when user enters them", async () => {
    const finalized = makeServer({ id: "minted-id", keychain_env_keys: ["API_KEY"] });
    vi.mocked(upsertMcpServer).mockResolvedValue(finalized);
    vi.mocked(setMcpServerSecret).mockResolvedValue(undefined);
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Type a secret value into the API_KEY row's value field (password input).
    const secretInput = screen.getByDisplayValue("API_KEY")
      .closest("div")
      ?.querySelector("input[type=\"password\"]") as HTMLInputElement;
    expect(secretInput).toBeTruthy();
    fireEvent.change(secretInput, { target: { value: "sk-secret-123" } });

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(setMcpServerSecret).toHaveBeenCalledWith(
        "minted-id",
        "API_KEY",
        "sk-secret-123",
      );
    });
  });

  it("shows error when upsert fails", async () => {
    vi.mocked(upsertMcpServer).mockRejectedValue(new Error("disk full"));

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("disk full")).toBeInTheDocument();
    });
  });

  it("disables Save and Cancel while saving", async () => {
    // Make upsert hang to keep saving=true.
    vi.mocked(upsertMcpServer).mockReturnValue(
      new Promise(() => {}),
    );

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saving…")).toBeInTheDocument();
    });
    expect(screen.getByText("Cancel")).toBeDisabled();
  });

  // --- Review fix tests (PR #393 review) ------------------------------------

  it("persists minted id after upsert so retry is idempotent (C1)", async () => {
    const finalized = makeServer({ id: "minted-id", keychain_env_keys: ["API_KEY"] });
    vi.mocked(upsertMcpServer).mockResolvedValue(finalized);
    // Secret write fails to simulate partial failure.
    vi.mocked(setMcpServerSecret).mockRejectedValueOnce(new Error("keychain locked"));
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ id: "", keychain_env_keys: ["API_KEY"] })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Type a secret value so setMcpServerSecret is called.
    const secretInput = screen.getByDisplayValue("API_KEY")
      .closest("div")
      ?.querySelector("input[type=\"password\"]") as HTMLInputElement;
    fireEvent.change(secretInput, { target: { value: "sk-secret" } });

    fireEvent.click(screen.getByText("Add"));

    await waitFor(() => {
      expect(screen.getByText("keychain locked")).toBeInTheDocument();
    });

    // First upsert sent id="" (new server).
    expect(vi.mocked(upsertMcpServer).mock.calls[0][0].id).toBe("");

    // Fix the secret mock and retry.
    vi.mocked(setMcpServerSecret).mockResolvedValue(undefined);
    fireEvent.click(screen.getByText("Add"));

    await waitFor(() => {
      expect(upsertMcpServer).toHaveBeenCalledTimes(2);
    });

    // Retry sent the minted id, not "" — no duplicate server.
    expect(vi.mocked(upsertMcpServer).mock.calls[1][0].id).toBe("minted-id");
  });

  it("commits config even when probe fails after successful upsert (C2)", async () => {
    const finalized = makeServer({ id: "minted-id" });
    vi.mocked(upsertMcpServer).mockResolvedValue(finalized);
    vi.mocked(setMcpServerSecret).mockResolvedValue(undefined);
    vi.mocked(probeMcpServer).mockRejectedValue(new Error("probe timeout"));

    const onSaved = vi.fn();
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledOnce();
    });

    // onSaved receives a disconnected probe result with the error.
    const [, probeResult] = onSaved.mock.calls[0];
    expect(probeResult.connected).toBe(false);
    expect(probeResult.error).toContain("probe timeout");
  });

  it("preserves secret values across Form→JSON→Form round-trip (H2)", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Type a secret value into the API_KEY row.
    const secretInput = screen.getByDisplayValue("API_KEY")
      .closest("div")
      ?.querySelector("input[type=\"password\"]") as HTMLInputElement;
    fireEvent.change(secretInput, { target: { value: "sk-preserve-me" } });

    // Switch to JSON then back to Form.
    fireEvent.click(screen.getByText("JSON"));
    fireEvent.click(screen.getByText("Form"));

    // The secret value should be preserved.
    const restoredInput = screen.getByDisplayValue("API_KEY")
      .closest("div")
      ?.querySelector("input[type=\"password\"]") as HTMLInputElement;
    expect(restoredInput.value).toBe("sk-preserve-me");
  });

  it("removes the correct env entry when trash button is clicked (H1)", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({
          env: { FIRST: "1", SECOND: "2" },
          keychain_env_keys: [],
        })}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue("FIRST")).toBeInTheDocument();
    expect(screen.getByDisplayValue("SECOND")).toBeInTheDocument();

    // Remove the first row (row 1).
    fireEvent.click(screen.getByRole("button", { name: /Remove variable.*row 1/ }));

    // FIRST is gone, SECOND remains — stable keys ensured correct removal.
    expect(screen.queryByDisplayValue("FIRST")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("SECOND")).toBeInTheDocument();
  });

  // --- Web-format JSON paste (common online formats) -------------------------

  it("accepts Claude Desktop format {mcpServers: {...}} in JSON mode", () => {
    vi.mocked(upsertMcpServer).mockResolvedValue(makeServer({
      id: "new-id",
      display_name: "filesystem",
      transport: { type: "stdio", command: "npx", args: ["-y", "@pkg/fs"] },
      env: {},
      keychain_env_keys: [],
    }));
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ id: "", display_name: "" })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("JSON"));
    const textarea = screen.getByTestId("mcp-json-editor").querySelector("textarea")!;
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          mcpServers: {
            filesystem: {
              command: "npx",
              args: ["-y", "@pkg/fs"],
            },
          },
        }, null, 2),
      },
    });

    // Add button is enabled (valid config).
    const addBtn = screen.getByText("Add");
    expect(addBtn).not.toBeDisabled();
  });

  it("accepts bare server map {name: {...}} in JSON mode", () => {
    vi.mocked(upsertMcpServer).mockResolvedValue(makeServer({
      id: "new-id",
      display_name: "my-server",
      transport: { type: "stdio", command: "node", args: ["server.js"] },
      env: {},
      keychain_env_keys: [],
    }));
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ id: "", display_name: "" })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("JSON"));
    const textarea = screen.getByTestId("mcp-json-editor").querySelector("textarea")!;
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          "my-server": { command: "node", args: ["server.js"] },
        }, null, 2),
      },
    });

    expect(screen.getByText("Add")).not.toBeDisabled();
  });

  it("syncs web-format JSON to Form fields on mode switch", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ id: "", display_name: "" })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("JSON"));
    const textarea = screen.getByTestId("mcp-json-editor").querySelector("textarea")!;
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          mcpServers: {
            "web-server": {
              command: "uvicorn",
              args: ["main:app"],
              env: { PORT: "8000" },
            },
          },
        }, null, 2),
      },
    });

    // Switch back to Form — fields should reflect the pasted JSON.
    fireEvent.click(screen.getByText("Form"));

    expect(screen.getByDisplayValue("web-server")).toBeInTheDocument();
    expect(screen.getByDisplayValue("uvicorn")).toBeInTheDocument();
    expect(screen.getByDisplayValue("main:app")).toBeInTheDocument();
    expect(screen.getByDisplayValue("PORT")).toBeInTheDocument();
    expect(screen.getByDisplayValue("8000")).toBeInTheDocument();
  });

  it("routes secret env keys to keychain in web-format JSON", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ id: "", display_name: "" })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("JSON"));
    const textarea = screen.getByTestId("mcp-json-editor").querySelector("textarea")!;
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          "secret-server": {
            command: "npx",
            args: ["-y", "@pkg/server"],
            env: {
              LOG_LEVEL: "info",
              API_KEY: "sk-xxx",
            },
          },
        }, null, 2),
      },
    });

    // Switch to Form — API_KEY should appear as a Secret row.
    fireEvent.click(screen.getByText("Form"));

    // API_KEY is in the env editor as a secret (password type input).
    const apiKeyInput = screen.getByDisplayValue("API_KEY");
    const row = apiKeyInput.closest("div");
    const secretCheckbox = row?.querySelector("input[type=\"checkbox\"]") as HTMLInputElement;
    expect(secretCheckbox.checked).toBe(true);

    // LOG_LEVEL is a non-secret env var.
    expect(screen.getByDisplayValue("LOG_LEVEL")).toBeInTheDocument();
  });

  it("blocks JSON-mode save when secret keys are detected", () => {
    const onSaved = vi.fn();
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({ id: "", display_name: "" })}
        isEdit={false}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("JSON"));
    const textarea = screen.getByTestId("mcp-json-editor").querySelector("textarea")!;
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          "secret-server": {
            command: "npx",
            args: ["-y", "@pkg/server"],
            env: {
              API_KEY: "sk-xxx",
            },
          },
        }, null, 2),
      },
    });

    // Click Add — save should be blocked with an error.
    fireEvent.click(screen.getByText("Add"));

    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByText(/Secret keys detected/)).toBeInTheDocument();
  });

  it("does not restore deleted secret keys when switching JSON to Form", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({
          id: "",
          display_name: "",
          env: { LOG_LEVEL: "info" },
          keychain_env_keys: ["API_KEY"],
        })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Switch to JSON — captures pendingSecrets with API_KEY.
    fireEvent.click(screen.getByText("JSON"));
    const textarea = screen.getByTestId("mcp-json-editor").querySelector("textarea")!;

    // Edit JSON: remove API_KEY from the serialized config.
    const edited = JSON.parse(textarea.value);
    const key = Object.keys(edited)[0];
    delete edited[key].env.API_KEY;
    fireEvent.change(textarea, { target: { value: JSON.stringify(edited, null, 2) } });

    // Switch back to Form.
    fireEvent.click(screen.getByText("Form"));

    // API_KEY should NOT be present — user deleted it from JSON.
    expect(screen.queryByDisplayValue("API_KEY")).not.toBeInTheDocument();
  });
});
