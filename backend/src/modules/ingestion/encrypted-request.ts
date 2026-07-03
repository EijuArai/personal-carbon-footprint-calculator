import { z } from "zod";

export const encryptedRequestSchema = z.object({
  encryptedSessionKey: z.string().min(1),
  encryptedPayload: z.string().min(1),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  dataHash: z.string().regex(/^[a-f0-9]{64}$/i),
});

export type EncryptedRequest = z.infer<typeof encryptedRequestSchema>;