/**
 * PATCH /api/db-instances/:id/analytics-settings body schema.
 *
 * Trivial by design: there's nothing to configure besides on/off — MinIO's
 * root password, the Iceberg catalog's bearer token, and Lakekeeper's own
 * encryption key are all derived from the instance's existing jwtSecret
 * (lib/provision/secrets.ts's deriveAnalyticsSecrets), never operator-supplied.
 */
import { z } from "zod";

export const analyticsSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
});

export type AnalyticsSettingsUpdateInput = z.infer<typeof analyticsSettingsUpdateSchema>;
