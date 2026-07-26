/**
 * Server row → API payload serializer.
 *
 * SECURITY: this is an explicit ALLOWLIST. Encrypted columns
 * (sshPasswordEnc, sshPrivateKeyEnc, panelUserEnc, panelPassEnc) and any
 * decrypted secret must NEVER appear here — decrypted panel credentials are
 * only returned by the audited reveal endpoint
 * (GET /api/servers/:id/panel-credential).
 */
import type { Server } from "@prisma/client";

export interface ServerCounts {
  websites: number;
  dbInstances: number;
}

export interface SerializedServer {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  authMethod: Server["authMethod"];
  linkedPanelUrl: string | null;
  hasPanelCredential: boolean;
  bootstrapped: boolean;
  reachable: boolean;
  hostKeyFingerprint: string | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  counts?: ServerCounts;
}

export function serializeServer(
  server: Server & { _count?: { websites: number; dbInstances: number } },
): SerializedServer {
  const out: SerializedServer = {
    id: server.id,
    name: server.name,
    host: server.host,
    sshPort: server.sshPort,
    sshUser: server.sshUser,
    authMethod: server.authMethod,
    linkedPanelUrl: server.linkedPanelUrl,
    hasPanelCredential:
      server.panelUserEnc != null || server.panelPassEnc != null,
    bootstrapped: server.bootstrapped,
    reachable: server.reachable,
    hostKeyFingerprint: server.hostKeyFingerprint,
    tags: server.tags,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
  if (server._count) {
    out.counts = {
      websites: server._count.websites,
      dbInstances: server._count.dbInstances,
    };
  }
  return out;
}
