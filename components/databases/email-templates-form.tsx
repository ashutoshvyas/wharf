"use client";

/**
 * Email templates form — per-flow custom subject + HTML body for
 * GoTrue's 6 auth email flows, following up on Auth settings. Uses the same
 * SettingsShell as Auth settings (left nav flush against content, matching
 * cloud-hosted Studio's own settings-page chrome) — here the nav lists the
 * 6 flows instead of settings sections.
 *
 * No live preview: GoTrue templates use Go's html/template placeholder
 * syntax ({{ .ConfirmationURL }} etc.), and faking a preview is scope this
 * feature doesn't need to work. Saving one flow only ever touches that
 * flow's stored row — every other flow's template is left exactly as-is
 * (lib/provision/auth-settings.ts's "full 6-flow state on every apply,
 * sparse DB write" split).
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { can, type Role } from "@/lib/rbac";
import { useToast } from "@/components/ui/toast";
import { SettingsHeading, SettingsNavItem, SettingsShell } from "./settings-shell";
import {
  fetchAuthSettings,
  fetchEmailTemplateBody,
  updateAuthSettings,
  type EmailTemplateFlow,
  type InstanceDto,
} from "./api";

const FLOWS: { flow: EmailTemplateFlow; label: string }[] = [
  { flow: "confirmation", label: "Confirm signup" },
  { flow: "recovery", label: "Reset password" },
  { flow: "magic_link", label: "Magic link" },
  { flow: "invite", label: "Invite user" },
  { flow: "email_change", label: "Change email address" },
  { flow: "reauthentication", label: "Reauthentication" },
];

const INPUT_CLASSES =
  "h-10 w-full rounded-[6px] border border-neutral-200 bg-white px-3 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none " +
  "disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400";

/** Small "Customised"/"Default" badge, same visual weight as a nav-item pill. */
function FlowBadge({ customised }: { customised: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
        customised ? "bg-[rgba(46,158,107,0.12)] text-[#1d6b46]" : "text-neutral-400",
      )}
    >
      {customised ? "Customised" : "Default"}
    </span>
  );
}

export function EmailTemplatesForm({ instance, role }: { instance: InstanceDto; role: Role }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = can(role, "instance.auth-settings.write");
  const settingsKey = ["auth-settings", instance.id];

  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: () => fetchAuthSettings(instance.id),
  });

  const [selected, setSelected] = useState<EmailTemplateFlow>("confirmation");
  const bodyKey = ["email-template-body", instance.id, selected];
  const body = useQuery({
    queryKey: bodyKey,
    queryFn: () => fetchEmailTemplateBody(instance.id, selected),
  });

  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");

  useEffect(() => {
    if (body.data) {
      setSubject(body.data.subject);
      setBodyHtml(body.data.bodyHtml);
    }
  }, [body.data]);

  const save = useMutation({
    mutationFn: () =>
      updateAuthSettings(instance.id, {
        emailTemplates: [{ flow: selected, subject, bodyHtml }],
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: settingsKey });
      void queryClient.invalidateQueries({ queryKey: bodyKey });
      toast({
        title: result.applied ? "Saved" : "Saved, but the restart failed",
        message: result.applied
          ? `Email template updated — ${instance.name}'s auth container was restarted to apply it.`
          : `The template was saved, but restarting the auth container failed: ${result.applyError ?? "unknown error"}. Retry from here once the server issue clears.`,
        variant: result.applied ? "success" : "danger",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", message: err.message, variant: "danger" });
    },
  });

  if (settings.isPending) {
    return (
      <div className="p-6">
        <Card className="p-5">
          <p className="text-[13px] text-neutral-500">Loading email templates…</p>
        </Card>
      </div>
    );
  }

  if (settings.isError) {
    return (
      <div className="p-6">
        <Alert variant="danger" title="Could not load email templates">
          <p>{settings.error.message}</p>
        </Alert>
      </div>
    );
  }

  const summaries = settings.data.emailTemplates;
  const selectedLabel = FLOWS.find((f) => f.flow === selected)?.label ?? selected;

  return (
    <SettingsShell
      nav={FLOWS.map(({ flow, label }) => {
        const summary = summaries.find((s) => s.flow === flow);
        return (
          <SettingsNavItem
            key={flow}
            label={label}
            active={selected === flow}
            onClick={() => setSelected(flow)}
            badge={<FlowBadge customised={!!summary?.hasBody} />}
          />
        );
      })}
      footer={
        canWrite && !body.isPending && !body.isError ? (
          <Button type="button" variant="accent" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save & restart auth"}
          </Button>
        ) : undefined
      }
    >
      <SettingsHeading
        title={selectedLabel}
        description="Leave the body empty to use GoTrue's own built-in default template for this flow."
      />

      {!canWrite ? (
        <Alert variant="info" className="mb-3.5">
          Viewing only — changing email templates requires the admin role.
        </Alert>
      ) : null}

      {body.isPending ? (
        <p className="text-[13px] text-neutral-500">Loading this template…</p>
      ) : body.isError ? (
        <Alert variant="danger" title="Could not load this template">
          <p>{body.error.message}</p>
        </Alert>
      ) : (
        <div className="flex flex-col gap-3.5">
          <div>
            <label className="label-track mb-1.5 block text-neutral-500">Subject</label>
            <input
              value={subject}
              disabled={!canWrite}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Confirm your signup"
              className={INPUT_CLASSES}
            />
          </div>
          <div>
            <label className="label-track mb-1.5 block text-neutral-500">HTML body</label>
            <textarea
              value={bodyHtml}
              disabled={!canWrite}
              onChange={(e) => setBodyHtml(e.target.value)}
              placeholder="<h2>Confirm your signup</h2>&#10;<p><a href=&quot;{{ .ConfirmationURL }}&quot;>Confirm your email</a></p>"
              rows={16}
              spellCheck={false}
              className={cn(INPUT_CLASSES, "h-auto resize-y py-2 font-mono text-[12.5px] leading-relaxed")}
            />
          </div>
        </div>
      )}
    </SettingsShell>
  );
}
