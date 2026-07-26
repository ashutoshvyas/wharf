/**
 * Prisma 6 types Bytes columns as `Uint8Array<ArrayBuffer>`, while Node's
 * Buffer (what lib/crypto seal() returns) is `Buffer<ArrayBufferLike>`.
 * This adapter copies the sealed buffer into a plain Uint8Array so route
 * handlers can assign it to *Enc fields without casts.
 */
import { seal } from "@/lib/crypto";

export function sealBytes(plaintext: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(seal(plaintext));
}
