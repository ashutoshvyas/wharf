"use client";

/**
 * Email templates form — per-flow custom subject + HTML body for
 * GoTrue's 6 auth email flows, following up on Auth settings.
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
import { Mail } from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/ui/toast";
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

  return (
    <div className="mx-auto flex max-w-[880px] gap-5 p-6">
      <Card className="h-fit w-[220px] shrink-0 p-2">
        {FLOWS.map(({ flow, label }) => {
          const summary = summaries.find((s) => s.flow === flow);
          return (
            <button
              key={flow}
              type="button"
              onClick={() => setSelected(flow)}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 rounded-[6px] px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400",
                selected === flow ? "bg-cobalt-50 text-cobalt-700" : "text-ink hover:bg-neutral-50",
              )}
            >
              <span className="text-[13px] font-medium">{label}</span>
              <span className="text-[11.5px] text-neutral-400">
                {summary?.hasBody ? "Customised" : "Default"}
              </span>
            </button>
          );
        })}
      </Card>

      <Card className="min-w-0 flex-1 p-5">
        <div className="mb-4 flex items-start gap-2.5">
          <div className="mt-0.5 text-neutral-400">
            <Mail size={18} strokeWidth={1.75} />
          </div>
          <div>
            <h3 className="text-[14.5px] font-semibold text-ink">
              {FLOWS.find((f) => f.flow === selected)?.label}
            </h3>
            <p className="mt-0.5 text-[13px] text-neutral-500">
              Leave the body empty to use GoTrue&apos;s own built-in default template for this
              flow.
            </p>
          </div>
        </div>

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
                rows={14}
                spellCheck={false}
                className={cn(INPUT_CLASSES, "h-auto resize-y py-2 font-mono text-[12.5px] leading-relaxed")}
              />
            </div>
            {canWrite ? (
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="accent"
                  disabled={save.isPending}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? "Saving…" : "Save & restart auth"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}
