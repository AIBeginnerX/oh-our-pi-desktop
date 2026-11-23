import { RegistryContext } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  MAX_SCHEDULED_PROMPTS,
  type EnvironmentId,
  type ProjectId,
  type ScheduledPrompt,
  type ScheduledPromptOperation,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useContext, useId, useRef, useState } from "react";
import { useT } from "../../i18n";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { scheduledPromptWrite } from "./scopedSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function formatTime({ hour, minute }: Pick<ScheduledPrompt, "hour" | "minute">): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function ProjectScheduledPromptsSettings() {
  const t = useT();
  const { scope, targets } = useSettingsScope();
  if (scope.kind !== "project" && scope.kind !== "checkout") return null;
  const target = targets[0];

  return (
    <SettingsSection id="project-scheduled-prompts" title={t("Scheduled prompts")}>
      {scope.environmentIds.length > 1 ? (
        <SettingsRow title={t("Choose one environment to manage scheduled prompts.")} />
      ) : scope.members.length > 1 ? (
        <SettingsRow title={t("Choose one checkout to manage scheduled prompts.")} />
      ) : target?.projectId ? (
        <ScheduledPromptList
          key={`${target.environmentId}:${target.projectId}`}
          environmentId={target.environmentId}
          projectId={target.projectId}
          entries={target.settings.scheduledPrompts}
        />
      ) : (
        <SettingsRow title={t("Connect to this environment to manage scheduled prompts.")} />
      )}
    </SettingsSection>
  );
}

function ScheduledPromptList({
  environmentId,
  projectId,
  entries,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  entries: readonly ScheduledPrompt[];
}) {
  const t = useT();
  const registry = useContext(RegistryContext);
  const updateSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "scheduled prompts update",
  );
  const [editor, setEditor] = useState<{ entry: ScheduledPrompt; adding: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  async function persist(operation: Exclude<ScheduledPromptOperation, { type: "removeProject" }>) {
    if (savingRef.current) return;
    const current = registry.get(serverEnvironment.configValueAtom(environmentId))?.settings
      .scheduledPrompts;
    const patch = current ? scheduledPromptWrite(current, operation) : null;
    if (!patch) {
      toastManager.add({ type: "error", title: t("Could not save scheduled prompts.") });
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch },
      });
      const saved =
        result._tag === "Success" &&
        result.value.scheduledPrompts.find(
          ({ id }) => id === (operation.type === "upsert" ? operation.entry.id : operation.id),
        );
      const applied =
        operation.type === "remove"
          ? saved === undefined
          : saved &&
            Object.entries(operation.type === "upsert" ? operation.entry : operation.changes).every(
              ([key, value]) => saved[key as keyof ScheduledPrompt] === value,
            );
      if (result._tag === "Success" && applied) {
        setEditor(null);
      } else if (!isAtomCommandInterrupted(result)) {
        toastManager.add({ type: "error", title: t("Could not save scheduled prompts.") });
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <SettingsRow
        title={t("Runs daily at the environment’s local time while its OOP server is running.")}
        control={
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={saving || entries.length >= MAX_SCHEDULED_PROMPTS}
            onClick={() =>
              setEditor({
                adding: true,
                entry: {
                  id: randomUUID(),
                  projectId,
                  title: "",
                  prompt: "",
                  hour: 9,
                  minute: 0,
                  enabled: true,
                },
              })
            }
          >
            <PlusIcon className="size-3.5" />
            {t("Add scheduled prompt")}
          </Button>
        }
      />
      {entries
        .filter((entry) => entry.projectId === projectId)
        .map((entry) => (
          <SettingsRow
            key={entry.id}
            title={entry.title}
            description={formatTime(entry)}
            control={
              <div className="flex items-center gap-2">
                <Switch
                  size="sm"
                  aria-label={t("Enable scheduled prompt {title}", { title: entry.title })}
                  checked={entry.enabled}
                  disabled={saving}
                  onCheckedChange={(enabled) =>
                    void persist({ type: "update", id: entry.id, changes: { enabled } })
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={saving}
                  onClick={() => setEditor({ entry, adding: false })}
                >
                  {t("Edit")}
                </Button>
              </div>
            }
          />
        ))}
      {editor && (
        <ScheduledPromptEditor
          initial={editor.entry}
          adding={editor.adding}
          saving={saving}
          onClose={() => setEditor(null)}
          onSave={(entry) => {
            if (editor.adding) {
              void persist({ type: "upsert", entry });
              return;
            }
            const initial = editor.entry;
            void persist({
              type: "update",
              id: entry.id,
              changes: {
                ...(entry.title !== initial.title ? { title: entry.title } : {}),
                ...(entry.prompt !== initial.prompt ? { prompt: entry.prompt } : {}),
                ...(entry.enabled !== initial.enabled ? { enabled: entry.enabled } : {}),
                ...(entry.hour !== initial.hour || entry.minute !== initial.minute
                  ? { hour: entry.hour, minute: entry.minute }
                  : {}),
              },
            });
          }}
          onDelete={() => void persist({ type: "remove", id: editor.entry.id })}
        />
      )}
    </>
  );
}

function ScheduledPromptEditor({
  initial,
  adding,
  saving,
  onClose,
  onSave,
  onDelete,
}: {
  initial: ScheduledPrompt;
  adding: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (entry: ScheduledPrompt) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [draft, setDraft] = useState(initial);
  const [time, setTime] = useState(formatTime(initial));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {adding ? t("Add scheduled prompt") : t("Edit scheduled prompt")}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (saving || !draft.title.trim() || !draft.prompt.trim()) return;
              onSave({
                ...draft,
                title: draft.title.trim(),
                hour: Number(time.slice(0, 2)),
                minute: Number(time.slice(3, 5)),
              });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-title`}>{t("Title")}</Label>
              <Input
                id={`${formId}-title`}
                value={draft.title}
                required
                maxLength={80}
                disabled={saving}
                onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-prompt`}>{t("Prompt")}</Label>
              <Textarea
                id={`${formId}-prompt`}
                value={draft.prompt}
                required
                maxLength={8_000}
                rows={6}
                disabled={saving}
                onChange={(event) => setDraft({ ...draft, prompt: event.currentTarget.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-time`}>{t("Time of day")}</Label>
              <Input
                id={`${formId}-time`}
                type="time"
                value={time}
                required
                disabled={saving}
                onChange={(event) => setTime(event.currentTarget.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id={`${formId}-enabled`}
                size="sm"
                checked={draft.enabled}
                disabled={saving}
                onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
              />
              <Label htmlFor={`${formId}-enabled`}>{t("Enabled")}</Label>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          {adding ? null : (
            <Button type="button" variant="destructive" disabled={saving} onClick={onDelete}>
              {t("Delete")}
            </Button>
          )}
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={saving || !draft.title.trim() || !draft.prompt.trim() || !time}
          >
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
