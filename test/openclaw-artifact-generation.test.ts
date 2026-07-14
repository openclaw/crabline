import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  publishOpenClawCrablineArtifactGeneration,
  readOpenClawCrablineArtifactPointer,
} from "../src/openclaw/artifact-generation.js";
import {
  OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH,
  OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
  resolveOpenClawCrablineChannelDriverSelection,
  type CrablineServerManifest,
} from "../src/index.js";
import {
  acquireOpenClawCrablineSmokeRunLock,
  type OpenClawCrablineSmokeRunLock,
} from "../src/openclaw/smoke-lock.js";
import { createTempDir, disposeTempDir } from "./test-helpers.js";

const manifest: CrablineServerManifest = {
  adminToken: "crabline-admin-token",
  baseUrl: "http://127.0.0.1:1234",
  botToken: "424242:crabline-telegram-token",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:1234/crabline/telegram/inbound",
    apiRoot: "http://127.0.0.1:1234",
  },
  env: {
    TELEGRAM_BOT_TOKEN: "424242:crabline-telegram-token",
  },
  provider: "telegram",
  recorderPath: "/tmp/crabline/telegram.jsonl",
  version: 1,
};

const mattermostManifest = {
  adminToken: "sample",
  baseUrl: "http://127.0.0.1:9753",
  botToken: "sample",
  botUserId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
  endpoints: {
    adminInboundUrl: "http://127.0.0.1:9753/crabline/mattermost/inbound",
    apiRoot: "http://127.0.0.1:9753/api/v4",
    websocketUrl: "ws://127.0.0.1:9753/api/v4/websocket",
  },
  env: {
    MATTERMOST_BOT_TOKEN: "sample",
    MATTERMOST_URL: "http://127.0.0.1:9753",
  },
  provider: "mattermost",
  recorderPath: "/tmp/crabline/mattermost.jsonl",
  version: 1,
} satisfies CrablineServerManifest;

function createLock(): OpenClawCrablineSmokeRunLock & {
  assertOwned: ReturnType<typeof vi.fn<() => Promise<void>>>;
  commitFileAtomically: ReturnType<
    typeof vi.fn<OpenClawCrablineSmokeRunLock["commitFileAtomically"]>
  >;
} {
  return {
    assertOwned: vi.fn(async () => undefined),
    commitFileAtomically: vi.fn(async ({ contents, destinationPath, stageFile }) => {
      await stageFile(destinationPath, contents);
    }),
    release: vi.fn(async () => undefined),
  };
}

function publishParams(outputDir: string, lock = createLock()) {
  return {
    capabilityReport: { result: { selectedChannel: "telegram" } },
    lock,
    manifest,
    outputDir,
    selection: resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" }),
    providerReadiness: {
      result: providerReadinessResult(),
    },
  };
}

function providerReadinessResult(extra: Record<string, unknown> = {}) {
  return {
    endpoints: manifest.endpoints,
    ok: true,
    probe: {
      ok: true,
      result: {
        first_name: "Crabline",
        id: 424_242,
        is_bot: true,
      },
    },
    proof: "provider-api-probe",
    provider: "telegram",
    ready: true,
    ...extra,
  };
}

function publishParamsWithRecorderSnapshot(outputDir: string, lock = createLock()) {
  return {
    ...publishParams(outputDir, lock),
    recorderSnapshot: {
      contents: '{"accepted":true}\n',
      fileName: "telegram-fake-provider.jsonl",
    },
  };
}

function mattermostPublishParams(outputDir: string) {
  return {
    capabilityReport: { result: { selectedChannel: "mattermost" } },
    lock: createLock(),
    manifest: mattermostManifest,
    outputDir,
    selection: resolveOpenClawCrablineChannelDriverSelection({ channel: "mattermost" }),
    providerReadiness: {
      result: {
        endpoints: mattermostManifest.endpoints,
        ok: true,
        probe: {
          id: mattermostManifest.botUserId,
          update_at: 0,
          username: " \n\t",
        },
        proof: "provider-api-probe",
        provider: "mattermost",
        ready: true,
      },
    },
  };
}

describe("OpenClaw artifact generation publication", () => {
  it("documents runtime pruning of abandoned artifact generations", async () => {
    const channelSetup = await fs.readFile(
      path.join(process.cwd(), "docs/channel-setup.md"),
      "utf8",
    );

    expect(channelSetup).toMatch(
      /the next lock-owning\s+publisher prunes any leftovers before staging a new generation/u,
    );
    expect(channelSetup).toMatch(
      /Post-commit\s+cleanup retains only the current and previous pointer generations/u,
    );
    expect(channelSetup).not.toContain("not removed automatically");
  });

  it("reads legacy smoke-only artifact pointers", async () => {
    const outputDir = await createTempDir();
    try {
      const result = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      const pointerPath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH);
      const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8")) as Record<string, unknown>;
      delete pointer.providerReadinessArtifactPath;
      delete pointer.recorderSnapshotPath;
      pointer.version = 1;
      await fs.writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);

      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toMatchObject({
        providerReadinessArtifactPath: result.providerReadinessArtifactPath,
        smokeArtifactPath: result.smokeArtifactPath,
        version: 1,
      });
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("validates every existing section in legacy smoke-only generations", async () => {
    const outputDir = await createTempDir();
    try {
      const first = await publishOpenClawCrablineArtifactGeneration(
        publishParamsWithRecorderSnapshot(outputDir),
        { createGenerationId: () => "11111111-1111-4111-8111-111111111111" },
      );
      const pointerPath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH);
      const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8")) as Record<string, unknown>;
      delete pointer.providerReadinessArtifactPath;
      delete pointer.recorderSnapshotPath;
      pointer.version = 1;
      await fs.writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);

      const readinessPath = path.join(outputDir, first.smokeArtifactPath);
      const readiness = JSON.parse(await fs.readFile(readinessPath, "utf8")) as {
        providerReadiness?: unknown;
        smoke: { result: Record<string, unknown> };
      };
      delete readiness.providerReadiness;
      delete readiness.smoke.result.proof;
      delete readiness.smoke.result.ready;
      const validSmokeOnlyReadiness = `${JSON.stringify(readiness, null, 2)}\n`;
      readiness.smoke.result.endpoints = {};
      await fs.writeFile(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);

      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
          createGenerationId: () => "22222222-2222-4222-8222-222222222222",
        }),
      ).rejects.toThrow("OpenClaw Crabline current artifact generation is incomplete.");

      await fs.writeFile(readinessPath, validSmokeOnlyReadiness);
      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
          createGenerationId: () => "22222222-2222-4222-8222-222222222222",
        }),
      ).resolves.toMatchObject({
        previousGeneration: first.generation,
        version: 2,
      });
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("rejects whitespace-only Mattermost usernames in readiness evidence", async () => {
    const outputDir = await createTempDir();
    try {
      await expect(
        publishOpenClawCrablineArtifactGeneration(mattermostPublishParams(outputDir), {
          createGenerationId: () => "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toThrow("OpenClaw Crabline current artifact generation is incomplete.");
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toBeNull();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("normalizes non-object artifact pointer failures", async () => {
    const outputDir = await createTempDir();
    try {
      const pointerPath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH);
      await fs.mkdir(path.dirname(pointerPath), { recursive: true });
      await fs.writeFile(pointerPath, "null\n");

      await expect(readOpenClawCrablineArtifactPointer(outputDir)).rejects.toThrow(
        "OpenClaw Crabline artifact pointer is malformed.",
      );
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it.each(["manifestPath", "providerReadinessArtifactPath"] as const)(
    "requires explicit v2 artifact pointer %s",
    async (field) => {
      const outputDir = await createTempDir();
      try {
        await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
          createGenerationId: () => "11111111-1111-4111-8111-111111111111",
        });
        const pointerPath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH);
        const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8")) as Record<
          string,
          unknown
        >;
        delete pointer[field];
        await fs.writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);

        await expect(readOpenClawCrablineArtifactPointer(outputDir)).rejects.toThrow(
          "OpenClaw Crabline artifact pointer is malformed.",
        );
      } finally {
        await disposeTempDir(outputDir);
      }
    },
  );

  it("rejects caller-controlled artifact paths before creating the store", async () => {
    const outputDir = await createTempDir();
    const params = publishParams(outputDir);
    try {
      await expect(
        publishOpenClawCrablineArtifactGeneration({
          ...params,
          selection: {
            ...params.selection,
            capabilityMatrixPath: "../escaped.json",
          } as unknown as typeof params.selection,
        }),
      ).rejects.toThrow("OpenClaw Crabline artifact selection paths are malformed.");
      await expect(
        fs.access(path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("publishes one complete owner-only generation behind an atomic pointer", async () => {
    const outputDir = await createTempDir();
    const lock = createLock();
    const syncedPaths: string[] = [];
    try {
      const result = await publishOpenClawCrablineArtifactGeneration(
        publishParams(outputDir, lock),
        {
          createGenerationId: () => "11111111-1111-4111-8111-111111111111",
          platform: "linux",
          syncParent: async (filePath) => {
            syncedPaths.push(filePath);
          },
        },
      );

      expect(result).toMatchObject({
        generation: "generation-11111111-1111-4111-8111-111111111111",
        providerReadiness: {
          manifestPath: result.manifestPath,
          result: {
            proof: "provider-api-probe",
            provider: "telegram",
            ready: true,
          },
        },
      });
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toEqual({
        capabilityMatrixPath: result.capabilityMatrixPath,
        generation: result.generation,
        manifestPath: result.manifestPath,
        providerReadinessArtifactPath: result.providerReadinessArtifactPath,
        recorderSnapshotPath: null,
        smokeArtifactPath: result.providerReadinessArtifactPath,
        version: 2,
      });
      for (const artifactPath of [
        result.manifestPath,
        result.capabilityMatrixPath,
        result.providerReadinessArtifactPath,
      ]) {
        expect((await fs.stat(path.join(outputDir, artifactPath))).mode & 0o777).toBe(0o600);
      }
      await expect(
        fs.readFile(path.join(outputDir, result.manifestPath), "utf8"),
      ).resolves.not.toContain("recorderPath");
      expect(
        (
          await fs.stat(
            path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY, result.generation),
          )
        ).mode & 0o777,
      ).toBe(0o700);
      expect(lock.assertOwned).toHaveBeenCalledTimes(3);
      expect(lock.commitFileAtomically).toHaveBeenCalledTimes(1);
      expect(syncedPaths).toContain(
        path.join(
          outputDir,
          OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
          "generation-11111111-1111-4111-8111-111111111111",
        ),
      );
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("removes recorder references when publishing without a snapshot", async () => {
    const outputDir = await createTempDir();
    const params = publishParams(outputDir);
    const paramsWithRecorderReference = {
      ...params,
      providerReadiness: {
        result: providerReadinessResult({
          recorderPath: "/tmp/crabline/telegram.jsonl",
        }),
      },
    };
    try {
      const first = await publishOpenClawCrablineArtifactGeneration(paramsWithRecorderReference, {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      const readiness = JSON.parse(
        await fs.readFile(path.join(outputDir, first.providerReadinessArtifactPath), "utf8"),
      ) as {
        providerReadiness: { result: Record<string, unknown> };
        smoke: { result: Record<string, unknown> };
      };
      expect(readiness.providerReadiness.result).not.toHaveProperty("recorderPath");
      expect(readiness.smoke.result).not.toHaveProperty("recorderPath");

      await expect(
        publishOpenClawCrablineArtifactGeneration(paramsWithRecorderReference, {
          createGenerationId: () => "22222222-2222-4222-8222-222222222222",
        }),
      ).resolves.toMatchObject({
        previousGeneration: first.generation,
        recorderSnapshotPath: null,
        version: 2,
      });
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("replaces a legacy generation with an external recorder path", async () => {
    const outputDir = await createTempDir();
    try {
      const first = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      const pointerPath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH);
      const legacyPointer = JSON.parse(await fs.readFile(pointerPath, "utf8")) as Record<
        string,
        unknown
      >;
      delete legacyPointer.recorderSnapshotPath;
      legacyPointer.version = 1;
      await fs.writeFile(pointerPath, `${JSON.stringify(legacyPointer, null, 2)}\n`);

      const legacyManifestPath = path.join(outputDir, first.manifestPath);
      const legacyManifest = JSON.parse(await fs.readFile(legacyManifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      legacyManifest.recorderPath = "/tmp/crabline/legacy-telegram.jsonl";
      await fs.writeFile(legacyManifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);

      const replacement = await publishOpenClawCrablineArtifactGeneration(
        publishParams(outputDir),
        { createGenerationId: () => "22222222-2222-4222-8222-222222222222" },
      );

      expect(replacement).toMatchObject({
        previousGeneration: first.generation,
        version: 2,
      });
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toMatchObject({
        generation: replacement.generation,
        previousGeneration: first.generation,
        version: 2,
      });
      await expect(
        fs.readFile(path.join(outputDir, replacement.manifestPath), "utf8"),
      ).resolves.not.toContain("recorderPath");
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("replaces a legacy generation without recorder evidence", async () => {
    const outputDir = await createTempDir();
    try {
      const first = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      const pointerPath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH);
      const legacyPointer = JSON.parse(await fs.readFile(pointerPath, "utf8")) as Record<
        string,
        unknown
      >;
      delete legacyPointer.recorderSnapshotPath;
      legacyPointer.version = 1;
      await fs.writeFile(pointerPath, `${JSON.stringify(legacyPointer, null, 2)}\n`);

      const replacement = await publishOpenClawCrablineArtifactGeneration(
        publishParams(outputDir),
        { createGenerationId: () => "22222222-2222-4222-8222-222222222222" },
      );

      expect(replacement).toMatchObject({
        previousGeneration: first.generation,
        version: 2,
      });
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("rejects a current pointer downgraded without a legacy manifest shape", async () => {
    const outputDir = await createTempDir();
    try {
      await publishOpenClawCrablineArtifactGeneration(
        publishParamsWithRecorderSnapshot(outputDir),
        {
          createGenerationId: () => "11111111-1111-4111-8111-111111111111",
        },
      );
      const pointerPath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH);
      const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8")) as Record<string, unknown>;
      pointer.version = 1;
      await fs.writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);

      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParamsWithRecorderSnapshot(outputDir), {
          createGenerationId: () => "22222222-2222-4222-8222-222222222222",
        }),
      ).rejects.toThrow("OpenClaw Crabline artifact pointer is malformed.");
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("rejects publication when the current generation lost its recorder snapshot", async () => {
    const outputDir = await createTempDir();
    const firstGeneration = "generation-11111111-1111-4111-8111-111111111111";
    const secondGeneration = "generation-22222222-2222-4222-8222-222222222222";
    try {
      const first = await publishOpenClawCrablineArtifactGeneration(
        publishParamsWithRecorderSnapshot(outputDir),
        { createGenerationId: () => firstGeneration.slice("generation-".length) },
      );
      const second = await publishOpenClawCrablineArtifactGeneration(
        publishParamsWithRecorderSnapshot(outputDir),
        { createGenerationId: () => secondGeneration.slice("generation-".length) },
      );
      const secondManifest = JSON.parse(
        await fs.readFile(path.join(outputDir, second.manifestPath), "utf8"),
      ) as { recorderPath: string };
      await fs.rm(path.join(outputDir, secondManifest.recorderPath));

      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParamsWithRecorderSnapshot(outputDir), {
          createGenerationId: () => "33333333-3333-4333-8333-333333333333",
        }),
      ).rejects.toThrow("OpenClaw Crabline current artifact generation is incomplete.");

      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toMatchObject({
        generation: secondGeneration,
        previousGeneration: firstGeneration,
      });
      await expect(fs.stat(path.join(outputDir, first.manifestPath))).resolves.toBeDefined();
      await expect(fs.stat(path.join(outputDir, second.manifestPath))).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it.each([
    ["manifest", "manifestPath"],
    ["capability matrix", "capabilityMatrixPath"],
    ["provider readiness", "providerReadinessArtifactPath"],
  ] as const)("normalizes missing current %s artifact errors", async (_label, field) => {
    const outputDir = await createTempDir();
    try {
      const current = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      await fs.rm(path.join(outputDir, current[field]));

      const publication = publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "22222222-2222-4222-8222-222222222222",
      });
      await expect(publication).rejects.toMatchObject({
        message: "OpenClaw Crabline current artifact generation is incomplete.",
        cause: { code: "ENOENT" },
      });
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("rejects a corrupt current capability matrix without pruning retained generations", async () => {
    const outputDir = await createTempDir();
    try {
      const first = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      const second = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "22222222-2222-4222-8222-222222222222",
      });
      await fs.writeFile(path.join(outputDir, second.capabilityMatrixPath), "{");

      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
          createGenerationId: () => "33333333-3333-4333-8333-333333333333",
        }),
      ).rejects.toThrow("OpenClaw Crabline current artifact generation is incomplete.");

      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toMatchObject({
        generation: second.generation,
        previousGeneration: first.generation,
      });
      await expect(fs.stat(path.join(outputDir, first.manifestPath))).resolves.toBeDefined();
      await expect(fs.stat(path.join(outputDir, second.manifestPath))).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("rejects a non-object capability report without pruning retained generations", async () => {
    const outputDir = await createTempDir();
    try {
      const first = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      const second = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "22222222-2222-4222-8222-222222222222",
      });
      const capabilityMatrixPath = path.join(outputDir, second.capabilityMatrixPath);
      const capabilityMatrix = JSON.parse(
        await fs.readFile(capabilityMatrixPath, "utf8"),
      ) as Record<string, unknown>;
      capabilityMatrix.report = null;
      await fs.writeFile(capabilityMatrixPath, JSON.stringify(capabilityMatrix));

      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
          createGenerationId: () => "33333333-3333-4333-8333-333333333333",
        }),
      ).rejects.toThrow("OpenClaw Crabline current artifact generation is incomplete.");

      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toMatchObject({
        generation: second.generation,
        previousGeneration: first.generation,
      });
      await expect(fs.stat(path.join(outputDir, first.manifestPath))).resolves.toBeDefined();
      await expect(fs.stat(path.join(outputDir, second.manifestPath))).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it.each([
    {
      label: "empty manifest",
      path: "manifestPath",
      corrupt: () => ({}),
    },
    {
      label: "empty readiness artifact",
      path: "providerReadinessArtifactPath",
      corrupt: () => ({}),
    },
    {
      label: "manifest with empty endpoint metadata",
      path: "manifestPath",
      corrupt: (artifact: Record<string, unknown>) => ({
        ...artifact,
        endpoints: {},
      }),
    },
    {
      label: "manifest with mismatched environment credentials",
      path: "manifestPath",
      corrupt: (artifact: Record<string, unknown>) => ({
        ...artifact,
        env: {
          ...(artifact.env as Record<string, unknown>),
          TELEGRAM_BOT_TOKEN: "placeholder",
        },
      }),
    },
    {
      label: "readiness artifact with an empty result",
      path: "providerReadinessArtifactPath",
      corrupt: (artifact: Record<string, unknown>) => ({
        ...artifact,
        providerReadiness: {
          ...(artifact.providerReadiness as Record<string, unknown>),
          result: {},
        },
      }),
    },
    {
      label: "readiness artifact with a malformed probe",
      path: "providerReadinessArtifactPath",
      corrupt: (artifact: Record<string, unknown>) => {
        const providerReadiness = artifact.providerReadiness as Record<string, unknown>;
        return {
          ...artifact,
          providerReadiness: {
            ...providerReadiness,
            result: {
              ...(providerReadiness.result as Record<string, unknown>),
              probe: null,
            },
          },
        };
      },
    },
    {
      label: "readiness artifact with the wrong source",
      path: "providerReadinessArtifactPath",
      corrupt: (artifact: Record<string, unknown>) => ({
        ...artifact,
        source: "other/source",
      }),
    },
    {
      label: "readiness artifact with a mismatched manifest path",
      path: "providerReadinessArtifactPath",
      corrupt: (artifact: Record<string, unknown>) => ({
        ...artifact,
        manifestPath: "other-manifest.json",
      }),
    },
    {
      label: "provider readiness with a mismatched manifest reference",
      path: "providerReadinessArtifactPath",
      corrupt: (artifact: Record<string, unknown>) => ({
        ...artifact,
        providerReadiness: {
          ...(artifact.providerReadiness as Record<string, unknown>),
          manifestPath: "other-manifest.json",
        },
      }),
    },
    {
      label: "smoke readiness with a mismatched manifest reference",
      path: "providerReadinessArtifactPath",
      corrupt: (artifact: Record<string, unknown>) => ({
        ...artifact,
        smoke: {
          ...(artifact.smoke as Record<string, unknown>),
          manifestPath: "other-manifest.json",
        },
      }),
    },
  ] as const)(
    "rejects a generated $label before pointer publication",
    async ({ corrupt, path: field }) => {
      const outputDir = await createTempDir();
      try {
        await expect(
          publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
            beforePointerSwitch: async (pointer) => {
              const artifactPath = path.join(outputDir, pointer[field]);
              const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8")) as Record<
                string,
                unknown
              >;
              await fs.writeFile(artifactPath, `${JSON.stringify(corrupt(artifact), null, 2)}\n`);
            },
            createGenerationId: () => "11111111-1111-4111-8111-111111111111",
          }),
        ).rejects.toThrow("OpenClaw Crabline current artifact generation is incomplete.");

        await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toBeNull();
        await expect(
          fs.readdir(path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY)),
        ).resolves.toEqual([]);
      } finally {
        await disposeTempDir(outputDir);
      }
    },
  );

  it("rejects publication when current recorder references are removed", async () => {
    const outputDir = await createTempDir();
    try {
      const current = await publishOpenClawCrablineArtifactGeneration(
        publishParamsWithRecorderSnapshot(outputDir),
        { createGenerationId: () => "11111111-1111-4111-8111-111111111111" },
      );
      const manifestPath = path.join(outputDir, current.manifestPath);
      const currentManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      delete currentManifest.recorderPath;
      await fs.writeFile(manifestPath, `${JSON.stringify(currentManifest, null, 2)}\n`);

      const readinessPath = path.join(outputDir, current.providerReadinessArtifactPath);
      const readiness = JSON.parse(await fs.readFile(readinessPath, "utf8")) as {
        providerReadiness: { result: Record<string, unknown> };
        smoke: { result: Record<string, unknown> };
      };
      delete readiness.providerReadiness.result.recorderPath;
      delete readiness.smoke.result.recorderPath;
      await fs.writeFile(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);

      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParamsWithRecorderSnapshot(outputDir), {
          createGenerationId: () => "22222222-2222-4222-8222-222222222222",
        }),
      ).rejects.toThrow("OpenClaw Crabline current artifact generation is incomplete.");
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("rejects recorder references redirected outside the current generation", async () => {
    const outputDir = await createTempDir();
    try {
      const first = await publishOpenClawCrablineArtifactGeneration(
        publishParamsWithRecorderSnapshot(outputDir),
        { createGenerationId: () => "11111111-1111-4111-8111-111111111111" },
      );
      const second = await publishOpenClawCrablineArtifactGeneration(
        publishParamsWithRecorderSnapshot(outputDir),
        { createGenerationId: () => "22222222-2222-4222-8222-222222222222" },
      );
      const firstManifest = JSON.parse(
        await fs.readFile(path.join(outputDir, first.manifestPath), "utf8"),
      ) as { recorderPath: string };
      const secondManifestPath = path.join(outputDir, second.manifestPath);
      const secondManifest = JSON.parse(await fs.readFile(secondManifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      secondManifest.recorderPath = firstManifest.recorderPath;
      await fs.writeFile(secondManifestPath, `${JSON.stringify(secondManifest)}\n`);

      const readinessPath = path.join(outputDir, second.providerReadinessArtifactPath);
      const readiness = JSON.parse(await fs.readFile(readinessPath, "utf8")) as {
        providerReadiness: { result: { recorderPath: string } };
        smoke: { result: { recorderPath: string } };
      };
      readiness.providerReadiness.result.recorderPath = firstManifest.recorderPath;
      readiness.smoke.result.recorderPath = firstManifest.recorderPath;
      await fs.writeFile(readinessPath, `${JSON.stringify(readiness)}\n`);

      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParamsWithRecorderSnapshot(outputDir), {
          createGenerationId: () => "33333333-3333-4333-8333-333333333333",
        }),
      ).rejects.toThrow("OpenClaw Crabline current artifact generation is incomplete.");
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a current generation redirected through a directory symlink",
    async () => {
      const outputDir = await createTempDir();
      const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
      try {
        const current = await publishOpenClawCrablineArtifactGeneration(
          publishParamsWithRecorderSnapshot(outputDir),
          { createGenerationId: () => "11111111-1111-4111-8111-111111111111" },
        );
        const generationPath = path.join(storePath, current.generation);
        const displacedPath = `${generationPath}.displaced`;
        await fs.rename(generationPath, displacedPath);
        await fs.symlink(displacedPath, generationPath, "dir");

        await expect(
          publishOpenClawCrablineArtifactGeneration(publishParamsWithRecorderSnapshot(outputDir), {
            createGenerationId: () => "22222222-2222-4222-8222-222222222222",
          }),
        ).rejects.toThrow("OpenClaw Crabline current artifact generation is incomplete.");
      } finally {
        await disposeTempDir(outputDir);
      }
    },
  );

  it("preserves a generation when pointer publication fails after the rename", async () => {
    const outputDir = await createTempDir();
    const lock = createLock();
    const commitFailure = new Error("post-rename verification failed");
    lock.commitFileAtomically.mockImplementation(
      async ({ contents, destinationPath, stageFile }) => {
        await stageFile(destinationPath, contents);
        throw commitFailure;
      },
    );
    try {
      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir, lock), {
          createGenerationId: () => "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toBe(commitFailure);

      const pointer = await readOpenClawCrablineArtifactPointer(outputDir);
      expect(pointer?.generation).toBe("generation-11111111-1111-4111-8111-111111111111");
      await expect(fs.stat(path.join(outputDir, pointer!.manifestPath))).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("rolls back the installed generation when parent sync fails", async () => {
    const outputDir = await createTempDir();
    const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    const generationPath = path.join(storePath, "generation-11111111-1111-4111-8111-111111111111");
    const syncFailure = new Error("directory sync failed");
    try {
      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
          createGenerationId: () => "11111111-1111-4111-8111-111111111111",
          syncParent: async (filePath) => {
            if (filePath === generationPath) {
              throw syncFailure;
            }
          },
        }),
      ).rejects.toBe(syncFailure);

      await expect(fs.stat(generationPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(storePath)).resolves.toEqual([]);
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("preserves a generation retained as a successor pointer rollback", async () => {
    const outputDir = await createTempDir();
    const lock = createLock();
    const commitFailure = new Error("successor replaced the pointer");
    const successorGeneration = "generation-22222222-2222-4222-8222-222222222222";
    lock.commitFileAtomically.mockImplementation(
      async ({ contents, destinationPath, stageFile }) => {
        await stageFile(destinationPath, contents);
        const pointer = JSON.parse(contents) as Record<string, unknown>;
        const generation = String(pointer.generation);
        await fs.writeFile(
          destinationPath,
          `${JSON.stringify(
            {
              ...pointer,
              capabilityMatrixPath: String(pointer.capabilityMatrixPath).replace(
                generation,
                successorGeneration,
              ),
              generation: successorGeneration,
              manifestPath: String(pointer.manifestPath).replace(generation, successorGeneration),
              previousGeneration: generation,
              providerReadinessArtifactPath: String(pointer.providerReadinessArtifactPath).replace(
                generation,
                successorGeneration,
              ),
              smokeArtifactPath: String(pointer.smokeArtifactPath).replace(
                generation,
                successorGeneration,
              ),
            },
            null,
            2,
          )}\n`,
        );
        throw commitFailure;
      },
    );
    try {
      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir, lock), {
          createGenerationId: () => "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toBe(commitFailure);

      const pointer = await readOpenClawCrablineArtifactPointer(outputDir);
      expect(pointer).toMatchObject({
        generation: successorGeneration,
        previousGeneration: "generation-11111111-1111-4111-8111-111111111111",
      });
      await expect(
        fs.stat(
          path.join(
            outputDir,
            OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
            pointer!.previousGeneration!,
          ),
        ),
      ).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("retains the committed generation when the pointer disappears before pruning", async () => {
    const outputDir = await createTempDir();
    const lock = createLock();
    lock.commitFileAtomically.mockImplementation(
      async ({ contents, destinationPath, stageFile }) => {
        await stageFile(destinationPath, contents);
        await fs.rm(destinationPath);
      },
    );
    try {
      const result = await publishOpenClawCrablineArtifactGeneration(
        publishParams(outputDir, lock),
        { createGenerationId: () => "11111111-1111-4111-8111-111111111111" },
      );

      expect(result.warnings).toEqual([
        "OpenClaw Crabline artifact retention cleanup failed: OpenClaw Crabline artifact pointer is missing after publication.",
      ]);
      await expect(fs.stat(path.join(outputDir, result.manifestPath))).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("fences an expired owner without touching a successor's uncommitted generation", async () => {
    const outputDir = await createTempDir();
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    const successorGeneration = "generation-22222222-2222-4222-8222-222222222222";
    const successorGenerationPath = path.join(
      outputDir,
      OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
      successorGeneration,
    );
    let now = 1_000;
    let resumeSuccessor: (() => void) | undefined;
    let successorInstalled: (() => void) | undefined;
    const resumeSuccessorPromise = new Promise<void>((resolve) => {
      resumeSuccessor = resolve;
    });
    const successorInstalledPromise = new Promise<void>((resolve) => {
      successorInstalled = resolve;
    });
    const disableHeartbeat = () => ({
      assertHealthy() {},
      async settle() {},
      async stop() {},
    });
    let expiredLock: OpenClawCrablineSmokeRunLock | undefined;
    let successorLock: OpenClawCrablineSmokeRunLock | undefined;
    let successorPublication:
      | ReturnType<typeof publishOpenClawCrablineArtifactGeneration>
      | undefined;
    try {
      expiredLock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => now,
          pid: 4_242,
          processStartedAtMs: 100,
          startHeartbeat: disableHeartbeat,
        },
      );

      now = 2_001;
      successorLock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => now,
          pid: 5_252,
          processStartedAtMs: 200,
          startHeartbeat: disableHeartbeat,
        },
      );
      successorPublication = publishOpenClawCrablineArtifactGeneration(
        {
          capabilityReport: { result: { generation: "successor" } },
          lock: successorLock,
          manifest,
          outputDir,
          selection,
          providerReadiness: { result: providerReadinessResult({ generation: "successor" }) },
        },
        {
          beforePointerSwitch: async () => {
            successorInstalled?.();
            await resumeSuccessorPromise;
          },
          createGenerationId: () => "22222222-2222-4222-8222-222222222222",
        },
      );

      await successorInstalledPromise;
      await expect(fs.stat(successorGenerationPath)).resolves.toBeDefined();
      await expect(
        publishOpenClawCrablineArtifactGeneration(
          {
            capabilityReport: { result: { generation: "expired" } },
            lock: expiredLock,
            manifest,
            outputDir,
            selection,
            providerReadiness: { result: providerReadinessResult({ generation: "expired" }) },
          },
          { createGenerationId: () => "11111111-1111-4111-8111-111111111111" },
        ),
      ).rejects.toThrow("OpenClaw Crabline smoke lock ownership was lost.");
      await expect(fs.stat(successorGenerationPath)).resolves.toBeDefined();

      resumeSuccessor?.();
      const successor = await successorPublication;
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toMatchObject({
        generation: successor.generation,
      });
      await expect(fs.stat(path.join(outputDir, successor.manifestPath))).resolves.toBeDefined();
    } finally {
      resumeSuccessor?.();
      await successorPublication?.catch(() => undefined);
      await expiredLock?.release();
      await successorLock?.release();
      await disposeTempDir(outputDir);
    }
  });

  it("prevents an expired fenced owner from overwriting a successor pointer", async () => {
    const outputDir = await createTempDir();
    const selection = resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" });
    let now = 1_000;
    let resumeOldOwner: (() => void) | undefined;
    let oldOwnerFenced: (() => void) | undefined;
    const resumeOldOwnerPromise = new Promise<void>((resolve) => {
      resumeOldOwner = resolve;
    });
    const oldOwnerFencedPromise = new Promise<void>((resolve) => {
      oldOwnerFenced = resolve;
    });
    const disableHeartbeat = () => ({
      assertHealthy() {},
      async settle() {},
      async stop() {},
    });
    let oldLock: OpenClawCrablineSmokeRunLock | undefined;
    let successorLock: OpenClawCrablineSmokeRunLock | undefined;
    try {
      oldLock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          beforeCommitFileRename: async () => {
            oldOwnerFenced?.();
            await resumeOldOwnerPromise;
          },
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => now,
          pid: 4_242,
          processStartedAtMs: 100,
          startHeartbeat: disableHeartbeat,
        },
      );
      const oldPublication = publishOpenClawCrablineArtifactGeneration(
        {
          capabilityReport: { result: { generation: "old" } },
          lock: oldLock,
          manifest,
          outputDir,
          selection,
          providerReadiness: { result: providerReadinessResult({ generation: "old" }) },
        },
        { createGenerationId: () => "11111111-1111-4111-8111-111111111111" },
      );

      await oldOwnerFencedPromise;
      now = 2_001;
      successorLock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          isProcessAlive: () => true,
          leaseMs: 1_000,
          now: () => now,
          pid: 5_252,
          processStartedAtMs: 200,
          startHeartbeat: disableHeartbeat,
        },
      );
      const successor = await publishOpenClawCrablineArtifactGeneration(
        {
          capabilityReport: { result: { generation: "successor" } },
          lock: successorLock,
          manifest,
          outputDir,
          selection,
          providerReadiness: { result: providerReadinessResult({ generation: "successor" }) },
        },
        { createGenerationId: () => "22222222-2222-4222-8222-222222222222" },
      );

      resumeOldOwner?.();
      await expect(oldPublication).rejects.toThrow(
        "OpenClaw Crabline smoke lock ownership was lost.",
      );
      await expect(readOpenClawCrablineArtifactPointer(outputDir)).resolves.toMatchObject({
        generation: successor.generation,
      });
    } finally {
      resumeOldOwner?.();
      await oldLock?.release();
      await successorLock?.release();
      await disposeTempDir(outputDir);
    }
  });

  it("keeps the prior generation visible until the single pointer switch", async () => {
    const outputDir = await createTempDir();
    let resumeSwitch: (() => void) | undefined;
    let switchStarted: (() => void) | undefined;
    const switchBlocked = new Promise<void>((resolve) => {
      resumeSwitch = resolve;
    });
    const atSwitch = new Promise<void>((resolve) => {
      switchStarted = resolve;
    });
    try {
      const first = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      const secondPromise = publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        beforePointerSwitch: async () => {
          switchStarted?.();
          await switchBlocked;
        },
        createGenerationId: () => "22222222-2222-4222-8222-222222222222",
      });

      await atSwitch;
      const visibleBeforeSwitch = await readOpenClawCrablineArtifactPointer(outputDir);
      expect(visibleBeforeSwitch?.generation).toBe(first.generation);
      expect(
        JSON.parse(await fs.readFile(path.join(outputDir, first.manifestPath), "utf8")),
      ).toMatchObject({ provider: "telegram" });
      expect(
        await fs.stat(
          path.join(
            outputDir,
            OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY,
            "generation-22222222-2222-4222-8222-222222222222",
          ),
        ),
      ).toBeDefined();

      resumeSwitch?.();
      const second = await secondPromise;
      expect((await readOpenClawCrablineArtifactPointer(outputDir))?.generation).toBe(
        second.generation,
      );
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("does not commit a pointer after the verified artifact store is replaced", async () => {
    const outputDir = await createTempDir();
    const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    const displacedStorePath = `${storePath}.displaced`;
    let lock: OpenClawCrablineSmokeRunLock | undefined;
    try {
      lock = await acquireOpenClawCrablineSmokeRunLock(
        { channel: "telegram", outputDir },
        {
          beforeCommitFileRename: async () => {
            await fs.rename(storePath, displacedStorePath);
            await fs.mkdir(storePath, { mode: 0o700 });
          },
        },
      );

      await expect(
        publishOpenClawCrablineArtifactGeneration({
          capabilityReport: { result: { ok: true } },
          lock,
          manifest,
          outputDir,
          selection: resolveOpenClawCrablineChannelDriverSelection({ channel: "telegram" }),
          providerReadiness: {
            result: providerReadinessResult(),
          },
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await expect(
        fs.access(path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_POINTER_PATH)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(storePath)).resolves.toEqual([]);
    } finally {
      await lock?.release();
      await disposeTempDir(outputDir);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects output directory replacement before publishing secret artifacts",
    async () => {
      const outputDir = await createTempDir();
      const displacedOutputDir = `${outputDir}.displaced`;
      const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
      try {
        await expect(
          publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
            createGenerationId: () => "11111111-1111-4111-8111-111111111111",
            platform: "win32",
            secureWindowsDirectory: async (directoryPath) => {
              if (directoryPath !== storePath) {
                return;
              }
              await fs.rename(outputDir, displacedOutputDir);
              await fs.symlink(displacedOutputDir, outputDir, "dir");
            },
            secureWindowsFile: async () => undefined,
          }),
        ).rejects.toThrow("Private directory path identity changed during publication.");

        await expect(
          fs.readdir(path.join(displacedOutputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY)),
        ).resolves.toEqual([]);
      } finally {
        await fs.rm(outputDir, { force: true });
        await fs.rename(displacedOutputDir, outputDir).catch(() => undefined);
        await disposeTempDir(outputDir);
      }
    },
  );

  it("removes failed staging and retains only the current and previous generations", async () => {
    const outputDir = await createTempDir();
    const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    const abandonedGeneration = "generation-22222222-2222-4222-8222-222222222222";
    try {
      const first = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      const publicationFailure = new Error("crash before pointer switch");
      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
          beforePointerSwitch: async () => {
            throw publicationFailure;
          },
          createGenerationId: () => "22222222-2222-4222-8222-222222222222",
        }),
      ).rejects.toBe(publicationFailure);
      await fs.mkdir(path.join(storePath, ".staging-33333333-3333-4333-8333-333333333333"), {
        mode: 0o700,
      });

      expect((await readOpenClawCrablineArtifactPointer(outputDir))?.generation).toBe(
        first.generation,
      );
      const third = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "44444444-4444-4444-8444-444444444444",
      });

      await expect(fs.stat(path.join(storePath, abandonedGeneration))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.stat(path.join(storePath, ".staging-33333333-3333-4333-8333-333333333333")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readOpenClawCrablineArtifactPointer(outputDir))?.generation).toBe(
        third.generation,
      );

      const fourth = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "55555555-5555-4555-8555-555555555555",
      });
      await expect(fs.stat(path.join(storePath, first.generation))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(path.join(storePath, third.generation))).resolves.toBeDefined();
      await expect(fs.stat(path.join(storePath, fourth.generation))).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("reclaims interrupted artifact removal tombstones", async () => {
    const outputDir = await createTempDir();
    const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    const tombstoneName =
      ".generation-22222222-2222-4222-8222-222222222222.4242.33333333-3333-4333-8333-333333333333.remove";
    try {
      await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      await fs.mkdir(path.join(storePath, tombstoneName), { mode: 0o700 });
      await fs.writeFile(path.join(storePath, tombstoneName, "stale.json"), "{}\n");

      await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "44444444-4444-4444-8444-444444444444",
      });

      await expect(fs.stat(path.join(storePath, tombstoneName))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await fs.readdir(storePath)).some((entry) => entry.endsWith(".remove"))).toBe(false);
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("keeps removal tombstones recognizable when reclamation is interrupted", async () => {
    const outputDir = await createTempDir();
    const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    const tombstoneBaseName = "generation-22222222-2222-4222-8222-222222222222";
    const tombstoneName = `.${tombstoneBaseName}.4242.33333333-3333-4333-8333-333333333333.remove`;
    const removalFailure = new Error("simulated interrupted tombstone removal");
    let rmSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      });
      await fs.mkdir(path.join(storePath, tombstoneName), { mode: 0o700 });
      await fs.writeFile(path.join(storePath, tombstoneName, "stale.json"), "{}\n");

      const originalRm = fs.rm.bind(fs);
      let interruptRemoval = true;
      rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (candidatePath, options) => {
        if (interruptRemoval && String(candidatePath).endsWith(".remove")) {
          interruptRemoval = false;
          throw removalFailure;
        }
        await originalRm(candidatePath, options);
      });
      await expect(
        publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
          createGenerationId: () => "44444444-4444-4444-8444-444444444444",
        }),
      ).rejects.toBe(removalFailure);
      rmSpy.mockRestore();
      rmSpy = undefined;

      const retainedTombstones = (await fs.readdir(storePath)).filter((entry) =>
        entry.endsWith(".remove"),
      );
      expect(retainedTombstones).toHaveLength(1);
      expect(retainedTombstones[0]).toMatch(
        new RegExp(`^\\.${tombstoneBaseName}\\.\\d+\\.[0-9a-f-]{36}\\.remove$`, "u"),
      );

      await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "55555555-5555-4555-8555-555555555555",
      });
      expect((await fs.readdir(storePath)).some((entry) => entry.endsWith(".remove"))).toBe(false);
    } finally {
      rmSpy?.mockRestore();
      await disposeTempDir(outputDir);
    }
  });

  it("removes staging when artifact serialization fails", async () => {
    const outputDir = await createTempDir();
    const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    try {
      await expect(
        publishOpenClawCrablineArtifactGeneration(
          {
            ...publishParams(outputDir),
            capabilityReport: { unsupported: 1n },
          },
          { createGenerationId: () => "11111111-1111-4111-8111-111111111111" },
        ),
      ).rejects.toThrow(/BigInt/u);
      await expect(fs.readdir(storePath)).resolves.toEqual([]);
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("preserves publication and rollback cleanup failures", async () => {
    const outputDir = await createTempDir();
    const storePath = path.join(outputDir, OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    const generation = "generation-11111111-1111-4111-8111-111111111111";
    const generationPath = path.join(storePath, generation);
    const displacedPath = `${generationPath}.displaced`;
    const publicationError = new Error("pointer switch failed");
    try {
      const failure = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        beforePointerSwitch: async () => {
          await fs.rename(generationPath, displacedPath);
          await fs.mkdir(generationPath);
          throw publicationError;
        },
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).toBe(publicationError);
      expect((failure as AggregateError).errors[1]).toBeInstanceOf(Error);
      await expect(fs.stat(generationPath)).resolves.toBeDefined();
      await expect(fs.stat(displacedPath)).resolves.toBeDefined();
    } finally {
      await disposeTempDir(outputDir);
    }
  });

  it("establishes the Windows directory ACL before creating sensitive files", async () => {
    const outputDir = await createTempDir();
    const events: string[] = [];
    const securedDirectories = new Set<string>();
    try {
      const result = await publishOpenClawCrablineArtifactGeneration(publishParams(outputDir), {
        createGenerationId: () => "11111111-1111-4111-8111-111111111111",
        platform: "win32",
        secureWindowsDirectory: async (directoryPath) => {
          events.push(`directory:${path.basename(directoryPath)}`);
          expect(await fs.readdir(directoryPath)).toEqual([]);
          securedDirectories.add(directoryPath);
        },
        secureWindowsFile: async (filePath) => {
          events.push(`file:${path.basename(filePath)}`);
          expect(securedDirectories.has(path.dirname(filePath))).toBe(true);
          expect(await fs.readFile(filePath, "utf8")).toBe("");
        },
      });

      expect(events[0]).toBe(`directory:${OPENCLAW_CRABLINE_ARTIFACT_STORE_DIRECTORY}`);
      expect(events[1]).toBe("directory:.staging-11111111-1111-4111-8111-111111111111");
      expect(events.filter((event) => event.startsWith("file:"))).toHaveLength(4);
      expect(await fs.readFile(path.join(outputDir, result.manifestPath), "utf8")).toContain(
        "crabline-admin-token",
      );
    } finally {
      await disposeTempDir(outputDir);
    }
  });
});
