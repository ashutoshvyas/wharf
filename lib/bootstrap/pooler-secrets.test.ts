import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto", () => ({
  seal: (plaintext: string) => Buffer.from(`sealed:${plaintext}`),
  open: (buf: Uint8Array) => Buffer.from(buf).toString().replace(/^sealed:/, ""),
}));

const serverFindUnique = vi.fn();
const serverUpdate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    server: {
      findUnique: (...a: unknown[]) => serverFindUnique(...a),
      update: (...a: unknown[]) => serverUpdate(...a),
    },
  },
}));

import { ensurePoolerSecrets } from "./pooler-secrets";

beforeEach(() => {
  vi.clearAllMocks();
  serverUpdate.mockResolvedValue({});
});

describe("ensurePoolerSecrets", () => {
  it("generates and persists secrets once when none exist yet", async () => {
    serverFindUnique.mockResolvedValue({ poolerSecretsEnc: null });

    const secrets = await ensurePoolerSecrets("srv-1");

    expect(secrets.poolerDbPassword).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(secrets.secretKeyBase.length).toBeGreaterThanOrEqual(64);
    expect(secrets.vaultEncKey).toHaveLength(32);
    expect(secrets.apiJwtSecret.length).toBeGreaterThanOrEqual(32);
    expect(secrets.metricsJwtSecret.length).toBeGreaterThanOrEqual(32);
    expect(secrets.apiJwtSecret).not.toBe(secrets.metricsJwtSecret);

    expect(serverUpdate).toHaveBeenCalledTimes(1);
    const [{ data }] = serverUpdate.mock.calls[0] as [{ data: { poolerSecretsEnc: Uint8Array } }];
    expect(JSON.parse(Buffer.from(data.poolerSecretsEnc).toString().replace(/^sealed:/, ""))).toEqual(
      secrets,
    );
  });

  it("reuses already-persisted secrets rather than generating new ones", async () => {
    const existing = {
      poolerDbPassword: "existing-pw",
      secretKeyBase: "x".repeat(64),
      vaultEncKey: "y".repeat(32),
      apiJwtSecret: "z".repeat(40),
      metricsJwtSecret: "w".repeat(40),
    };
    serverFindUnique.mockResolvedValue({
      poolerSecretsEnc: Buffer.from(`sealed:${JSON.stringify(existing)}`),
    });

    const secrets = await ensurePoolerSecrets("srv-1");

    expect(secrets).toEqual(existing);
    expect(serverUpdate).not.toHaveBeenCalled();
  });

  it("throws when the server row is gone", async () => {
    serverFindUnique.mockResolvedValue(null);
    await expect(ensurePoolerSecrets("srv-missing")).rejects.toThrow(/Server srv-missing not found/);
  });
});
