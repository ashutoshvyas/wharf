/**
 * PATCH /api/db-instances/:id/auth-settings body schema.
 *
 * Everything optional (sparse update, mirrors lib/servers/schema.ts's
 * serverUpdateSchema): secret fields (googleSecret/githubSecret/azureSecret/
 * appleSecret/smtpPass) use the same "empty string means keep the existing
 * stored value" convention, stripped by the transform below so an untouched
 * secret never reaches the update handler.
 *
 * Free-text fields reject line breaks: these values are written verbatim
 * into a .env file with no escaping mechanism, so an embedded newline could
 * terminate a line early and smuggle in an unrelated variable (the same
 * risk lib/provision/render.ts's validateInput() already guards against for
 * generated secrets — this is the same check at the API boundary, so bad
 * input gets a clean 400 instead of surfacing as a 500 from render.ts).
 *
 * `emailTemplates` is the one exception to both rules above:
 * `bodyHtml` is never written into .env at all (it's served over its own
 * HTTP route, see app/api/db-instances/[id]/email-template/[flow]/route.ts)
 * so it must allow multi-line content, and neither field is a secret, so
 * there's no "empty means keep existing" — an omitted field per-flow keeps
 * the stored value, but an explicitly empty one clears it.
 */
import { z } from "zod";
import { SMS_PROVIDERS } from "@/lib/provision/render";

const NO_LINEBREAK_RE = /^[^\r\n]*$/;
// `max` is a parameter rather than a chained .max() at the call site: zod
// keeps every max check that's added, so chaining a larger one onto the
// default would leave the smaller cap still enforced.
const noLineBreak = (label: string, max = 1024) =>
  z.string().max(max).regex(NO_LINEBREAK_RE, `${label} must not contain line breaks`);

/**
 * An absolute http(s) URL, or empty to fall back to the instance's own API
 * origin (lib/provision/render.ts resolves the fallback — the derived value is
 * never stored, so an instance's URLs stay correct if its subdomain changes).
 *
 * Validated rather than passed through: both of these silently break sign-in
 * when malformed, and the failure surfaces at the OAuth provider or in a dead
 * post-login redirect rather than anywhere near this form.
 */
const absoluteUrlOrEmpty = (label: string) =>
  noLineBreak(label).refine(
    (v) => {
      if (v === "") return true;
      let parsed: URL;
      try {
        parsed = new URL(v);
      } catch {
        return false;
      }
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    },
    `${label} must be an absolute http(s) URL, or empty to use this instance's own origin`,
  );

// Mirrors lib/provision/render.ts's EMAIL_TEMPLATE_FLOWS — kept as a literal
// tuple here (rather than imported) so z.enum can narrow the type properly.
const emailTemplateEntrySchema = z.object({
  flow: z.enum([
    "confirmation",
    "recovery",
    "magic_link",
    "invite",
    "email_change",
    "reauthentication",
  ]),
  subject: noLineBreak("subject").optional(),
  bodyHtml: z.string().max(100_000).optional(),
});

export const authSettingsUpdateSchema = z
  .object({
    disableSignup: z.boolean().optional(),
    enableEmailSignup: z.boolean().optional(),
    enableEmailAutoconfirm: z.boolean().optional(),
    enablePhoneSignup: z.boolean().optional(),
    enablePhoneAutoconfirm: z.boolean().optional(),
    enableAnonymousUsers: z.boolean().optional(),
    manualLinkingEnabled: z.boolean().optional(),
    jwtExpirySeconds: z.number().int().min(300).max(604_800).optional(),
    additionalRedirectUrls: noLineBreak("additionalRedirectUrls").optional(),
    siteUrl: absoluteUrlOrEmpty("siteUrl").optional(),
    oauthCallbackUrl: absoluteUrlOrEmpty("oauthCallbackUrl").optional(),

    smtpHost: noLineBreak("smtpHost").optional(),
    smtpPort: z.number().int().min(1).max(65_535).optional(),
    smtpUser: noLineBreak("smtpUser").optional(),
    // Empty string = "keep existing secret" (stripped by the transform below).
    smtpPass: z.string().max(1024).optional(),
    smtpSenderName: noLineBreak("smtpSenderName").optional(),
    smtpAdminEmail: noLineBreak("smtpAdminEmail").optional(),

    // SMS. The secret fields follow the same "empty string = keep the
    // stored value" convention as the OAuth secrets, stripped by the transform.
    smsProvider: z.enum(SMS_PROVIDERS).optional(),
    smsOtpExp: z.number().int().min(10).max(86_400).optional(),
    // GoTrue clamps anything outside 6..10 back to 6, so reject it here where
    // the operator can still see why rather than letting it be silently reset.
    smsOtpLength: z.number().int().min(6).max(10).optional(),
    // A Go duration literal, the unit being mandatory ("60" is not 60s).
    smsMaxFrequency: noLineBreak("smsMaxFrequency", 32)
      .regex(/^\d+(ns|us|ms|s|m|h)([\d.]+(ns|us|ms|s|m|h))*$/, "smsMaxFrequency must be a duration like 1m0s or 30s")
      .optional(),
    smsTemplate: noLineBreak("smsTemplate", 2048).optional(),
    smsTwilioAccountSid: noLineBreak("smsTwilioAccountSid").optional(),
    smsTwilioAuthToken: z.string().max(1024).optional(),
    smsTwilioMessageServiceSid: noLineBreak("smsTwilioMessageServiceSid").optional(),
    smsTwilioDeliveryChannel: z.enum(["sms", "whatsapp"]).optional(),
    smsTwilioWhatsappSender: noLineBreak("smsTwilioWhatsappSender").trim()
      .regex(/^(?:|(?:whatsapp:)?\+[1-9]\d{1,14})$/, "Use an international WhatsApp sender number, e.g. +14155551234").optional(),
    smsTwilioContentSid: noLineBreak("smsTwilioContentSid").trim()
      .regex(/^(?:|HX[0-9a-fA-F]{32})$/, "Use a Twilio Content SID starting with HX followed by 32 hex characters").optional(),
    smsTwilioSmsFallback: z.boolean().optional(),
    smsMsg91AuthKey: z.string().max(1024).optional(),
    smsMsg91TemplateId: noLineBreak("smsMsg91TemplateId").optional(),
    smsMsg91SenderId: noLineBreak("smsMsg91SenderId").optional(),
    // Substituted into an MSG91 payload as a JSON key, so keep it to the
    // identifier shape their templates actually use.
    smsMsg91OtpVariable: noLineBreak("smsMsg91OtpVariable", 64)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "smsMsg91OtpVariable must be a plain identifier")
      .optional(),

    googleEnabled: z.boolean().optional(),
    // A comma-separated list of client ids, not just one — GoTrue parses this
    // into a []string so native/One Tap clients can ride along with the web
    // OAuth client. Several ids run past the other providers' 1024 cap.
    googleClientId: noLineBreak("googleClientId", 4096).optional(),
    googleSecret: z.string().max(1024).optional(),
    googleSkipNonceCheck: z.boolean().optional(),
    googleEmailOptional: z.boolean().optional(),

    githubEnabled: z.boolean().optional(),
    githubClientId: noLineBreak("githubClientId").optional(),
    githubSecret: z.string().max(1024).optional(),

    azureEnabled: z.boolean().optional(),
    azureClientId: noLineBreak("azureClientId").optional(),
    azureSecret: z.string().max(1024).optional(),

    appleEnabled: z.boolean().optional(),
    // A Services ID, or a comma-separated list of them plus native bundle IDs.
    appleClientId: noLineBreak("appleClientId").optional(),
    // An ES256 JWT rather than a short opaque secret — three base64url segments
    // run well past the 1024 the other providers get, so this cap is larger.
    appleSecret: z.string().max(4096).optional(),
    appleEmailOptional: z.boolean().optional(),

    emailTemplates: z.array(emailTemplateEntrySchema).max(6).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.emailTemplates) return;
    const seen = new Set<string>();
    for (const entry of v.emailTemplates) {
      if (seen.has(entry.flow)) {
        ctx.addIssue({
          code: "custom",
          path: ["emailTemplates"],
          message: `duplicate flow '${entry.flow}' in emailTemplates`,
        });
      }
      seen.add(entry.flow);
    }
  })
  .transform(
    ({
      smtpPass,
      googleSecret,
      githubSecret,
      azureSecret,
      appleSecret,
      smsTwilioAuthToken,
      smsMsg91AuthKey,
      ...rest
    }) => ({
      ...rest,
      ...(smtpPass ? { smtpPass } : {}),
      ...(googleSecret ? { googleSecret } : {}),
      ...(githubSecret ? { githubSecret } : {}),
      ...(azureSecret ? { azureSecret } : {}),
      ...(appleSecret ? { appleSecret } : {}),
      ...(smsTwilioAuthToken ? { smsTwilioAuthToken } : {}),
      ...(smsMsg91AuthKey ? { smsMsg91AuthKey } : {}),
    }),
  );

export type AuthSettingsUpdateInput = z.infer<typeof authSettingsUpdateSchema>;
