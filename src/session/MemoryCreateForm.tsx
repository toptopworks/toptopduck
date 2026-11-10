// The memory panel's create form (issue #1538): three fields (title,
// description, four-way type picker) over the store's `create_entry`. The
// description is a textarea -- the store's body is multi-line-capable, a
// single-line input would say otherwise. The click-to-prefill example sits
// above the fields -- the blank-form kicker, so the first row never starts
// from an empty canvas. Mounted by WorkspaceMemoryDialog in place of the
// list face; the dialog owns the entry points and the saved confirmation.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FormattedMessage, useIntl } from "react-intl";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { log } from "../lib/log";
import { describeError } from "../lib/error-presentation";
import { createWorkspaceMemory } from "../api";
import { workspaceMemoryKeys } from "./queryKeys";
import type { MemoryType } from "../types/workspace-memory";

type MemoryCreateFormProps = {
  workspace: string;
  onCreated: () => void;
  onCancel: () => void;
};

export function MemoryCreateForm({
  workspace,
  onCreated,
  onCancel,
}: MemoryCreateFormProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<MemoryType>("reference");
  const [failure, setFailure] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createWorkspaceMemory(workspace, { title, description, type }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceMemoryKeys.listing(workspace),
      });
      onCreated();
    },
    // The same surfaced-failure posture as the toggles: logged AND shown,
    // never a silently unmoved form.
    onError: (e) => {
      log.warn("WorkspaceMemoryDialog", "create memory failed", e);
      setFailure(describeError(e, intl));
    },
  });

  const applyExample = () => {
    setTitle(
      intl.formatMessage({
        id: "workspace.memory.form.exampleTitle",
        defaultMessage: "Metrics follow the monthly definitions",
      }),
    );
    setDescription(
      intl.formatMessage({
        id: "workspace.memory.form.exampleDescription",
        defaultMessage: "All reports cite the same monthly metric definitions",
      }),
    );
    setType("project");
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        // The store guards the blank title too; this keeps the no-op local.
        if (title.trim().length === 0) return;
        create.mutate();
      }}
    >
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground justify-self-start inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
        onClick={applyExample}
      >
        <FormattedMessage
          id="workspace.memory.form.exampleLabel"
          defaultMessage="Try:"
        />{" "}
        <FormattedMessage
          id="workspace.memory.form.exampleTitle"
          defaultMessage="Quarterly reports use DuckDB"
        />
      </button>
      <div className="grid gap-1.5">
        <Label htmlFor="memory-new-title">
          <FormattedMessage
            id="workspace.memory.form.title"
            defaultMessage="Title"
          />
        </Label>
        <Input
          id="memory-new-title"
          value={title}
          required
          onChange={(e) => setTitle(e.target.value)}
          placeholder={intl.formatMessage({
            id: "workspace.memory.form.titlePlaceholder",
            defaultMessage: "e.g. Reply in Simplified Chinese",
          })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="memory-new-description">
          <FormattedMessage
            id="workspace.memory.form.description"
            defaultMessage="Description"
          />
        </Label>
        <Textarea
          id="memory-new-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={intl.formatMessage({
            id: "workspace.memory.form.descriptionPlaceholder",
            defaultMessage: "e.g. Always reply in Simplified Chinese",
          })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label>
          <FormattedMessage
            id="workspace.memory.form.type"
            defaultMessage="Type"
          />
        </Label>
        <RadioGroup
          value={type}
          onValueChange={(v) => setType(v as MemoryType)}
          className="flex flex-wrap gap-x-4 gap-y-1"
        >
          {/* Four STATIC branches (the catalog guard's literal-id rule). */}
          <label className="flex cursor-pointer items-center gap-1.5 text-sm">
            <RadioGroupItem value="user" />
            <FormattedMessage id="workspace.memory.type.user" defaultMessage="User" />
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm">
            <RadioGroupItem value="feedback" />
            <FormattedMessage id="workspace.memory.type.feedback" defaultMessage="Feedback" />
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm">
            <RadioGroupItem value="project" />
            <FormattedMessage id="workspace.memory.type.project" defaultMessage="Project" />
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm">
            <RadioGroupItem value="reference" />
            <FormattedMessage id="workspace.memory.type.reference" defaultMessage="Reference" />
          </label>
        </RadioGroup>
      </div>
      {failure !== null && (
        <p className="text-destructive m-0 text-sm" role="alert">
          {failure}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
        </Button>
        <Button type="submit" size="sm" disabled={create.isPending}>
          <FormattedMessage id="common.save" defaultMessage="Save" />
        </Button>
      </div>
    </form>
  );
}
