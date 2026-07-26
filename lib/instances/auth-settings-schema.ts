/**
 * PATCH /api/db-instances/:id/auth-settings body schema.
 *
 * Everything optional (sparse update, mirrors lib/servers/schema.ts's
 * serverUpdateSchema): secret fields (googleSecret/githubSecret/azureSecret/
 * smtpPass) use the same "empty string means keep the existing stored
 * value" convention, stripped by the transform below so an untouched secret
 * never reaches the update handler.
 *
 * Free-text fields reject line breaks: these values are written verbatim
 * into a .env file with no escaping mechanism, so an embedded newline could
 * terminate a line early and smuggle in an unrelated variable (the same
 * risk lib/provision/render.ts's validateInput() already guards against for
 * generated secrets — this is the same check at the API boundary, so bad
 * input gets a clean 400 instead of surfacing as a 500 from render.ts).
 */
import { z } from "zod";

const NO_LINEBREAK_RE = /^[^\r\n]*$/;
const noLineBreak = (label: string) =>
  z.string().max(1024).regex(NO_LINEBREAK_RE, `${label} must not contain line breaks`);

export const authSettingsUpdateSchema = z
  .object({
    disableSignup: z.boolean().optional(),
    enableEmailSignup: z.boolean().optional(),
    enableEmailAutoconfirm: z.boolean().optional(),
    enablePhoneSignup: z.boolean().optional(),
    enableAnonymousUsers: z.boolean().optional(),
    jwtExpirySeconds: z.number().int().min(300).max(604_800).optional(),
    additionalRedirectUrls: noLineBreak("additionalRedirectUrls").optional(),

    smtpHost: noLineBreak("smtpHost").optional(),
    smtpPort: z.number().int().min(1).max(65_535).optional(),
    smtpUser: noLineBreak("smtpUser").optional(),
    // Empty string = "keep existing secret" (stripped by the transform below).
    smtpPass: z.string().max(1024).optional(),
    smtpSenderName: noLineBreak("smtpSenderName").optional(),
    smtpAdminEmail: noLineBreak("smtpAdminEmail").optional(),

    googleEnabled: z.boolean().optional(),
    googleClientId: noLineBreak("googleClientId").optional(),
    googleSecret: z.string().max(1024).optional(),

    githubEnabled: z.boolean().optional(),
    githubClientId: noLineBreak("githubClientId").optional(),
    githubSecret: z.string().max(1024).optional(),

    azureEnabled: z.boolean().optional(),
    azureClientId: noLineBreak("azureClientId").optional(),
    azureSecret: z.string().max(1024).optional(),
  })
  .transform(({ smtpPass, googleSecret, githubSecret, azureSecret, ...rest }) => ({
    ...rest,
    ...(smtpPass ? { smtpPass } : {}),
    ...(googleSecret ? { googleSecret } : {}),
    ...(githubSecret ? { githubSecret } : {}),
    ...(azureSecret ? { azureSecret } : {}),
  }));

export type AuthSettingsUpdateInput = z.infer<typeof authSettingsUpdateSchema>;
