import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { McpServerForm } from "../McpServerForm";
import {
  clearMcpServerHeaderSecret,
  clearMcpServerSecret,
  probeMcpServer,
  setMcpServerHeaderSecret,
  setMcpServerSecret,
  upsertMcpServer,
} from "../../../api";
import type { McpServerConfig, McpProbeResult } from "../../../types/mcp";
import { chooseOption, openSelect } from "./helpers";

// The form drives everything through IPC; mock the API so the test never
// touches Tauri.
vi.mock("../../../api", () => ({
  upsertMcpServer: vi.fn(),
  setMcpServerSecret: vi.fn(),
  setMcpServerHeaderSecret: vi.fn(),
  clearMcpServerSecret: vi.fn(),
  clearMcpServerHeaderSecret: vi.fn(),
  probeMcpServer: vi.fn(),
}));

function makeServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "srv-1",
    display_name: "My Server",
    transport: { type: "stdio", command: "/bin/mcp-server", args: ["--port", "8080"] },
    env: { LOG_LEVEL: "info" },
    keychain_env_keys: ["API_KEY"],
    keychain_header_keys: [],
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
        initialServer={makeServer({ id: "", display_name: "My Server", transport: { type: "sse", url: "", headers: {} } })}
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
          transport: { type: "sse", url: "http://localhost:8080/sse", headers: {} },
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

  // --- Remote transport headers (issue #901) ----------------------------------

  it("shows the headers editor (not env) on a remote transport, pre-filled from transport.headers + keychain_header_keys", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({
          transport: {
            type: "http",
            url: "https://example.com/mcp",
            headers: { "X-Api-Version": "2024-11-05" },
          },
          keychain_header_keys: ["Authorization"],
        })}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Header rows: one plain, one secret (value empty -- keychain is one-way).
    expect(screen.getByDisplayValue("X-Api-Version")).toBeTruthy();
    expect(screen.getByDisplayValue("2024-11-05")).toBeTruthy();
    expect(screen.getByDisplayValue("Authorization")).toBeTruthy();
    // The env face is invisible on a remote transport: the row's env value
    // (LOG_LEVEL=info from makeServer) must not render anywhere.
    expect(screen.queryByDisplayValue("LOG_LEVEL")).toBeNull();
    expect(screen.queryByDisplayValue("info")).toBeNull();
  });

  it("shows the env editor (not headers) on a stdio transport", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // The stdio default from makeServer: env rows render, and the header
    // editor (its distinctive section label) does not.
    expect(screen.getByDisplayValue("LOG_LEVEL")).toBeTruthy();
    expect(screen.queryByText("Request headers (optional)")).toBeNull();
  });

  it("saves remote headers split across transport.headers and keychain_header_keys (issue #901)", async () => {
    // The finalized config Rust hands back carries the saved secret key
    // names (the save loop reads them from the finalized shape).
    vi.mocked(upsertMcpServer).mockResolvedValue(
      makeServer({
        id: "minted",
        keychain_header_keys: ["Authorization"],
      }),
    );
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({
          id: "",
          display_name: "API Server",
          transport: { type: "http", url: "https://example.com/mcp", headers: {} },
          env: {},
          keychain_env_keys: [],
        })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Add one plain header row and one secret header row. Expanding the
    // headers section auto-adds a blank row; fill it as the plain header.
    fireEvent.click(screen.getByText("Request headers (optional)"));
    const nameInputs1 = screen.getAllByPlaceholderText("Header");
    fireEvent.change(nameInputs1[0], { target: { value: "X-Api-Version" } });
    const valueInputs1 = screen.getAllByPlaceholderText("value");
    fireEvent.change(valueInputs1[0], { target: { value: "2024-11-05" } });
    // Second row: the secret header.
    fireEvent.click(screen.getByText("Add header"));
    const nameInputs2 = screen.getAllByPlaceholderText("Header");
    fireEvent.change(nameInputs2[1], { target: { value: "Authorization" } });
    const valueInputs2 = screen.getAllByPlaceholderText("value");
    fireEvent.change(valueInputs2[1], { target: { value: "Bearer abc" } });
    // Tick the second row's Secret checkbox.
    const secretBoxes = screen.getAllByRole("checkbox", {
      name: /Secret \(row 2\)/i,
    });
    fireEvent.click(secretBoxes[0]);

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(upsertMcpServer).toHaveBeenCalledTimes(1));

    const saved = vi.mocked(upsertMcpServer).mock.calls[0][0];
    expect(saved.transport).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { "X-Api-Version": "2024-11-05" },
    });
    expect(saved.keychain_header_keys).toEqual(["Authorization"]);
    expect(saved.keychain_env_keys).toEqual([]);
    // The secret VALUE went to the keychain (header account), never config.
    await waitFor(() =>
      expect(setMcpServerHeaderSecret).toHaveBeenCalledWith(
        "minted",
        "Authorization",
        "Bearer abc",
      ),
    );
    expect(setMcpServerSecret).not.toHaveBeenCalled();
  });

  it("preserves a legacy remote row's dormant env through an edit (issue #901)", async () => {
    vi.mocked(upsertMcpServer).mockResolvedValue(
      makeServer({
        transport: { type: "http", url: "https://example.com/mcp", headers: {} },
      }),
    );
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({
          transport: { type: "http", url: "https://example.com/mcp", headers: {} },
          env: { LEGACY_ENV: "dormant-value" },
          keychain_env_keys: ["LEGACY_SECRET"],
        })}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // The env values render nowhere (dormant), yet the save carries them
    // through verbatim -- no migration, no deletion.
    expect(screen.queryByDisplayValue("LEGACY_ENV")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(upsertMcpServer).toHaveBeenCalledTimes(1));

    const saved = vi.mocked(upsertMcpServer).mock.calls[0][0];
    expect(saved.env).toEqual({ LEGACY_ENV: "dormant-value" });
    expect(saved.keychain_env_keys).toEqual(["LEGACY_SECRET"]);
  });

  it("preserves a legacy remote row's dormant env through a JSON round trip (issue #901)", async () => {
    vi.mocked(upsertMcpServer).mockResolvedValue(
      makeServer({
        transport: { type: "http", url: "https://example.com/mcp", headers: {} },
      }),
    );
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({
          transport: { type: "http", url: "https://example.com/mcp", headers: {} },
          env: { LEGACY_ENV: "dormant-value" },
          keychain_env_keys: ["LEGACY_SECRET"],
        })}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Switch to JSON and back with no edits: the web format has no field for
    // a remote row's env, and that absence must read as "unchanged", not as
    // a deletion -- the save still carries the dormant face verbatim.
    fireEvent.click(screen.getByText("JSON"));
    fireEvent.click(screen.getByText("Form"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(upsertMcpServer).toHaveBeenCalledTimes(1));

    const saved = vi.mocked(upsertMcpServer).mock.calls[0][0];
    expect(saved.env).toEqual({ LEGACY_ENV: "dormant-value" });
    expect(saved.keychain_env_keys).toEqual(["LEGACY_SECRET"]);
  });

  it("preserves a legacy remote row's dormant env on a JSON-mode save (issue #901)", async () => {
    vi.mocked(upsertMcpServer).mockResolvedValue(
      makeServer({
        transport: { type: "http", url: "https://example.com/mcp", headers: {} },
      }),
    );
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({
          transport: { type: "http", url: "https://example.com/mcp", headers: {} },
          env: { LEGACY_ENV: "dormant-value" },
          keychain_env_keys: ["LEGACY_SECRET"],
        })}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Save straight from JSON mode: the parsed draft's empty env face (the
    // web format cannot express it) keeps the ref's dormant face.
    fireEvent.click(screen.getByText("JSON"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(upsertMcpServer).toHaveBeenCalledTimes(1));

    const saved = vi.mocked(upsertMcpServer).mock.calls[0][0];
    expect(saved.env).toEqual({ LEGACY_ENV: "dormant-value" });
    expect(saved.keychain_env_keys).toEqual(["LEGACY_SECRET"]);
  });

  it("blocks a JSON-mode save when a secret HEADER key is detected", async () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({
          id: "",
          display_name: "API Server",
          transport: { type: "http", url: "https://example.com/mcp", headers: {} },
          env: {},
          keychain_env_keys: [],
        })}
        isEdit={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          "api-server": {
            type: "http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer abc" },
          },
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(screen.getByText(/Secret keys detected \(Authorization\)/)).toBeTruthy(),
    );
    expect(upsertMcpServer).not.toHaveBeenCalled();
  });

  // --- Credential lifecycle (issue #904) --------------------------------------

  it("clears the keychain account of a deleted secret row on save (issue #904)", async () => {
    // The finalized config Rust hands back carries the post-deletion shape
    // (no API_KEY), so the save's clear-filter passes the name through.
    vi.mocked(upsertMcpServer).mockResolvedValue(
      makeServer({ env: { LOG_LEVEL: "info" }, keychain_env_keys: [] }),
    );
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // API_KEY rides row 2 (secret). Remove it, then save.
    fireEvent.click(
      screen.getByRole("button", { name: /Remove variable.*row 2/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(upsertMcpServer).toHaveBeenCalledTimes(1));
    expect(vi.mocked(upsertMcpServer).mock.calls[0][0].keychain_env_keys)
      .toEqual([]);
    await waitFor(() =>
      expect(clearMcpServerSecret).toHaveBeenCalledWith("srv-1", "API_KEY"),
    );
    expect(clearMcpServerHeaderSecret).not.toHaveBeenCalled();
  });

  it("keeps the account of a secret name that was deleted then re-added", async () => {
    vi.mocked(upsertMcpServer).mockResolvedValue(
      makeServer({ keychain_env_keys: ["API_KEY"] }),
    );
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Delete the secret row, then re-add the same name as a secret row.
    fireEvent.click(
      screen.getByRole("button", { name: /Remove variable.*row 2/ }),
    );
    fireEvent.click(screen.getByText("Add variable"));
    const nameInputs = screen.getAllByPlaceholderText("KEY");
    fireEvent.change(nameInputs[1], { target: { value: "API_KEY" } });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Secret \(row 2\)/i }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(upsertMcpServer).toHaveBeenCalledTimes(1));

    // The re-added name rides the finalized config, so the clear-filter
    // spares it -- no account wipe under a row the user rebuilt.
    await waitFor(() => expect(probeMcpServer).toHaveBeenCalled());
    expect(clearMcpServerSecret).not.toHaveBeenCalled();
  });

  it("clears nothing when the edit is canceled", () => {
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Remove variable.*row 2/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(clearMcpServerSecret).not.toHaveBeenCalled();
    expect(upsertMcpServer).not.toHaveBeenCalled();
  });

  it("a transport flip to stdio does not clear header credentials (issue #904)", async () => {
    vi.mocked(upsertMcpServer).mockResolvedValue(
      makeServer({
        transport: { type: "stdio", command: "/bin/srv", args: [] },
        env: {},
        keychain_env_keys: [],
        keychain_header_keys: [],
      }),
    );
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({
          transport: {
            type: "sse",
            url: "https://example.com/sse",
            headers: {},
          },
          env: {},
          keychain_env_keys: [],
          keychain_header_keys: ["Authorization"],
        })}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Flip the transport remote → stdio: the headers editor (and its rows)
    // vanish without any row-removal event, so nothing may be cleared --
    // the credentials stay dormant for a flip back.
    const combobox = screen.getByRole("combobox", { name: "Type" });
    openSelect(combobox);
    chooseOption("stdio");
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "/bin/srv" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(upsertMcpServer).toHaveBeenCalledTimes(1));
    expect(vi.mocked(upsertMcpServer).mock.calls[0][0].transport.type)
      .toBe("stdio");
    await waitFor(() => expect(probeMcpServer).toHaveBeenCalled());
    expect(clearMcpServerHeaderSecret).not.toHaveBeenCalled();
    expect(clearMcpServerSecret).not.toHaveBeenCalled();
  });

  it("keeps the stored value when an existing secret row is saved empty (issue #904)", async () => {
    vi.mocked(upsertMcpServer).mockResolvedValue(
      makeServer({ keychain_env_keys: ["API_KEY"] }),
    );
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Save without touching the API_KEY row (value stays empty).
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(upsertMcpServer).toHaveBeenCalledTimes(1));

    // No value entered -> no keychain write; no deletion -> no clear. The
    // stored value is preserved by inaction on both sides.
    await waitFor(() => expect(probeMcpServer).toHaveBeenCalled());
    expect(setMcpServerSecret).not.toHaveBeenCalled();
    expect(clearMcpServerSecret).not.toHaveBeenCalled();
  });

  it("clears the keychain account of a deleted header secret row on save, surviving a mode switch (issue #904)", async () => {
    // The header-face twin of the env clear test, plus the mode-switch
    // survival the module doc claims: the recorded deletion rides the
    // Form -> JSON switch and clears at the JSON-mode save (either mode).
    const sseTransport = {
      type: "sse",
      url: "https://example.com/sse",
      headers: {},
    } as const;
    vi.mocked(upsertMcpServer).mockResolvedValue(
      makeServer({
        transport: sseTransport,
        env: {},
        keychain_env_keys: [],
        keychain_header_keys: [],
      }),
    );
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({
          transport: sseTransport,
          env: {},
          keychain_env_keys: [],
          keychain_header_keys: ["Authorization"],
        })}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Remove the header secret row, then switch to JSON mode before
    // saving: the recorded deletion must survive the mode switch.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove header (row 1)" }),
    );
    fireEvent.click(screen.getByText("JSON"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(upsertMcpServer).toHaveBeenCalledTimes(1));
    expect(
      vi.mocked(upsertMcpServer).mock.calls[0][0].keychain_header_keys,
    ).toEqual([]);
    await waitFor(() =>
      expect(clearMcpServerHeaderSecret).toHaveBeenCalledWith(
        "srv-1",
        "Authorization",
      ),
    );
    expect(clearMcpServerSecret).not.toHaveBeenCalled();
  });

  it("still hands off to the list and warns when a clear fails after the save (issue #904)", async () => {
    // The upsert already committed, so the handoff must still run (the
    // list's mirror must not diverge from disk) and the failure rides the
    // probe result's error channel -- connected stays true, only the
    // cleanup did not land.
    vi.mocked(upsertMcpServer).mockResolvedValue(
      makeServer({ env: { LOG_LEVEL: "info" }, keychain_env_keys: [] }),
    );
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());
    vi.mocked(clearMcpServerSecret).mockRejectedValue(
      new Error("keychain locked"),
    );
    const onSaved = vi.fn();

    renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Remove variable.*row 2/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const [, probeResult] = onSaved.mock.calls[0];
    expect(probeResult.connected).toBe(true);
    expect(probeResult.error).toContain("keychain locked");
  });

  it("shows the keep/clear hint only when a secret row exists (issue #904)", () => {
    const { unmount } = renderWithProviders(
      <McpServerForm
        initialServer={makeServer()}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // The editor carries the API_KEY secret row -> the hint is visible.
    expect(
      screen.getByText(/Leave a secret row's value empty/),
    ).toBeInTheDocument();
    unmount();

    // A fresh render with plain rows only -> no hint (the entry state is
    // mount-initialized, so the no-secret shape needs its own mount).
    renderWithProviders(
      <McpServerForm
        initialServer={makeServer({
          env: { LOG_LEVEL: "info" },
          keychain_env_keys: [],
        })}
        isEdit={true}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.queryByText(/Leave a secret row's value empty/),
    ).not.toBeInTheDocument();
  });
});
