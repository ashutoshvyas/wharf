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
  .transform(({ smtpPass, googleSecret, githubSecret, azureSecret, appleSecret, ...rest }) => ({
    ...rest,
    ...(smtpPass ? { smtpPass } : {}),
    ...(googleSecret ? { googleSecret } : {}),
    ...(githubSecret ? { githubSecret } : {}),
    ...(azureSecret ? { azureSecret } : {}),
    ...(appleSecret ? { appleSecret } : {}),
  }));

export type AuthSettingsUpdateInput = z.infer<typeof authSettingsUpdateSchema>;
