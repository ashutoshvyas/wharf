import { z } from "zod";

/** Clone requests contain managed instance identities, never connection secrets. */
export const startCloneSchema = z.object({
  targetInstanceId: z.uuid("targetInstanceId must be a UUID"),
  confirmName: z.string().min(1, "confirmName is required").max(64),
}).strict();

export type StartCloneInput = z.infer<typeof startCloneSchema>;
