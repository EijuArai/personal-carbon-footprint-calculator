import { vi } from "vitest";
import { Keypair } from "@solana/web3.js";

import { loadFrontendRuntimeConfig } from "../src/app/runtime-config";
import type { WalletProfileAdapter } from "../src/lib/domain";
import { createFrontendRuntimeAdapters } from "../src/app/runtime-adapters";
import { createFetchEncryptedIngestionApi } from "../src/lib/api/encrypted-ingestion-client";
import { createBackendDevAuthTokenProvider } from "../src/features/submission/backend-dev-auth-token-provider";
import {
  buildFrontendIdl,
  createLocalE2EWalletProfileAdapter,
} from "../src/features/wallet/local-e2e-wallet-profile-adapter";

describe("loadFrontendRuntimeConfig", () => {
  it("requires local-e2e to be selected explicitly", () => {
    expect(() => loadFrontendRuntimeConfig({} as ImportMetaEnv)).toThrow(
      /VITE_FRONTEND_RUNTIME_MODE=local-e2e/i,
    );
  });

  it("builds a local-e2e runtime config with local defaults", () => {
    expect(
      loadFrontendRuntimeConfig({
        VITE_FRONTEND_RUNTIME_MODE: "local-e2e",
        VITE_LOCAL_E2E_USER_SECRET_KEY_JSON: " [1,2,3] ",
        VITE_LOCAL_E2E_MINT_AUTHORITY_SECRET_KEY_JSON: " [4,5,6] ",
      } as ImportMetaEnv),
    ).toEqual({
      mode: "local-e2e",
      backendBaseUrl: "http://127.0.0.1:3000",
      solanaRpcUrl: "http://127.0.0.1:8899",
      programId: "68EBpJsPtNkbgvF3PhNFQbtnxYvSoBCCN6QoMYGJ8xzi",
      localE2E: {
        userSecretKeyJson: "[1,2,3]",
        mintAuthoritySecretKeyJson: "[4,5,6]",
      },
    });
  });
});

describe("createFrontendRuntimeAdapters", () => {
  it("switches to local E2E adapters when runtime mode is enabled", async () => {
    const walletAdapter = {
      connectWallet: vi.fn(),
      getConnectionState: vi.fn(),
      signAuthMessage: vi.fn(),
    } as unknown as WalletProfileAdapter;
    const authTokenProvider = { getAuthToken: vi.fn() };
    const ingestionApi = {
      fetchPublicKeyPem: vi.fn(),
      submitEncryptedFootprint: vi.fn(),
      getJobStatus: vi.fn(),
    };

    const runtime = createFrontendRuntimeAdapters(
      {
        mode: "local-e2e",
        backendBaseUrl: "http://127.0.0.1:3000",
        solanaRpcUrl: "http://127.0.0.1:8899",
        programId: "68EBpJsPtNkbgvF3PhNFQbtnxYvSoBCCN6QoMYGJ8xzi",
        localE2E: {
          userSecretKeyJson: JSON.stringify(
            Array.from({ length: 64 }, (_, index) => index + 1),
          ),
          mintAuthoritySecretKeyJson: JSON.stringify(
            Array.from({ length: 64 }, (_, index) => index + 2),
          ),
        },
      },
      {
        createWalletAdapter: () => walletAdapter,
        createAuthTokenProvider: () => authTokenProvider,
        createIngestionApi: () => ingestionApi,
      },
    );

    expect(runtime.walletAdapter).toBe(walletAdapter);
    expect(runtime.authTokenProvider).toBe(authTokenProvider);
    expect(runtime.ingestionApi).toBe(ingestionApi);
    expect(runtime.jobStatusProvider).toBe(ingestionApi);
    expect(runtime.submissionRuntimeNote).toMatch(/private data/i);
  });

  it("fails fast when local E2E runtime is missing required signer secrets", () => {
    expect(() =>
      createFrontendRuntimeAdapters({
        mode: "local-e2e",
        backendBaseUrl: "http://127.0.0.1:3000",
        solanaRpcUrl: "http://127.0.0.1:8899",
        programId: "68EBpJsPtNkbgvF3PhNFQbtnxYvSoBCCN6QoMYGJ8xzi",
        localE2E: {
          userSecretKeyJson: JSON.stringify(
            Array.from({ length: 64 }, (_, index) => index + 1),
          ),
          mintAuthoritySecretKeyJson: "",
        },
      }),
    ).toThrow(/mint authority/i);
  });
});

describe("createBackendDevAuthTokenProvider", () => {
  it("requests a signed wallet auth token from the backend bridge", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            challengeId: "eb5e00af-e787-4655-b779-ff96d39476db",
            walletAddress: "wallet-1",
            message: "Sign this challenge",
            expiresAtMs: Date.now() + 30_000,
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "jwt-123",
            subject: "wallet-1",
            expiresAtMs: Date.now() + 30_000,
          }),
          { status: 201 },
        ),
      );
    const walletAdapter = {
      getConnectionState: vi.fn(async () => ({
        phase: "connected",
        walletAddress: "wallet-1",
      })),
      signAuthMessage: vi.fn(async () => "signed-payload"),
    } as unknown as WalletProfileAdapter;

    const provider = createBackendDevAuthTokenProvider({
      baseUrl: "http://127.0.0.1:3000",
      walletAdapter,
      fetchImpl,
    });

    await expect(provider.getAuthToken()).resolves.toBe("jwt-123");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/v1/siws/challenge",
      expect.objectContaining({ method: "POST" }),
    );
    expect(walletAdapter.signAuthMessage).toHaveBeenCalledWith(
      "Sign this challenge",
    );

    await expect(provider.getAuthToken()).resolves.toBe("jwt-123");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces backend bridge failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "route_not_found", message: "Not found." },
        }),
        { status: 404 },
      ),
    );
    const walletAdapter = {
      getConnectionState: vi.fn(async () => ({
        phase: "connected",
        walletAddress: "wallet-1",
      })),
      signAuthMessage: vi.fn(async () => "signed-payload"),
    } as unknown as WalletProfileAdapter;

    const provider = createBackendDevAuthTokenProvider({
      baseUrl: "http://127.0.0.1:3000",
      walletAdapter,
      fetchImpl,
    });

    await expect(provider.getAuthToken()).rejects.toThrow(/not found/i);
  });

  it("rejects auth token requests while the wallet is disconnected", async () => {
    const provider = createBackendDevAuthTokenProvider({
      baseUrl: "http://127.0.0.1:3000",
      walletAdapter: {
        getConnectionState: async () => ({ phase: "disconnected" }),
        connectWallet: vi.fn(),
        signAuthMessage: vi.fn(),
        getProfileSnapshot: vi.fn(),
        registerPublicProfile: vi.fn(),
        mintUserSbt: vi.fn(),
        updatePublicProfile: vi.fn(),
        claimReward: vi.fn(),
      },
      fetchImpl: vi.fn<typeof fetch>(),
    });

    await expect(provider.getAuthToken()).rejects.toThrow(
      /connect your solana wallet/i,
    );
  });
});

describe("createFetchEncryptedIngestionApi", () => {
  it("maps backend job status payloads to the frontend job snapshot shape", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          job: {
            id: 42,
            kind: "submit_verified_footprint",
            status: "completed",
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        }),
        { status: 200 },
      ),
    );

    const api = createFetchEncryptedIngestionApi({
      baseUrl: "http://127.0.0.1:3000",
      authTokenProvider: { getAuthToken: vi.fn() },
      fetchImpl,
    });

    await expect(api.getJobStatus(42)).resolves.toEqual({
      jobId: 42,
      kind: "submit_verified_footprint",
      status: "completed",
    });
  });
});

describe("createLocalE2EWalletProfileAdapter", () => {
  it("keeps emission history in the frontend userProfile IDL before publicProfile", () => {
    const idl = buildFrontendIdl(
      "68EBpJsPtNkbgvF3PhNFQbtnxYvSoBCCN6QoMYGJ8xzi",
    ) as {
      types?: Array<{
        name: string;
        type?: { fields?: Array<{ name: string }> };
      }>;
    };

    const userProfileType = idl.types?.find(
      (type) => type.name === "userProfile",
    );
    const fieldNames =
      userProfileType?.type?.fields?.map((field) => field.name) ?? [];

    expect(fieldNames.slice(-2)).toEqual(["emissionHistory", "publicProfile"]);
  });

  it("uses the injected client to drive wallet actions without mock defaults", async () => {
    const userSigner = Keypair.generate();
    const mintAuthoritySigner = Keypair.generate();
    const loadSnapshot = vi.fn(async () => ({
      walletAddress: "wallet-1",
      isRegistered: true,
      hasMintedSbt: true,
      totalEmissionsKgCo2e: 12.5,
      totalReductionsKgCo2e: 2,
      pendingRewardLamports: 5000n,
      publicProfile: { displayAlias: "Aoi", countryCode: "JP", avatarUri: "" },
    }));
    const client = {
      walletAddress: "wallet-1",
      loadSnapshot,
      registerPublicProfile: vi.fn(async () => loadSnapshot()),
      updatePublicProfile: vi.fn(async () => loadSnapshot()),
      mintUserSbt: vi.fn(async () => loadSnapshot()),
      claimReward: vi.fn(async () => loadSnapshot()),
    };

    const adapter = createLocalE2EWalletProfileAdapter(
      {
        rpcUrl: "http://127.0.0.1:8899",
        programId: "68EBpJsPtNkbgvF3PhNFQbtnxYvSoBCCN6QoMYGJ8xzi",
        userSecretKeyJson: JSON.stringify(Array.from(userSigner.secretKey)),
        mintAuthoritySecretKeyJson: JSON.stringify(
          Array.from(mintAuthoritySigner.secretKey),
        ),
      },
      {
        createClient: () => client,
      },
    );

    await expect(adapter.connectWallet()).resolves.toEqual({
      phase: "connected",
      walletAddress: "wallet-1",
    });
    await expect(adapter.signAuthMessage("hello")).resolves.toEqual(
      expect.any(String),
    );
    await expect(adapter.getProfileSnapshot("wallet-1")).resolves.toMatchObject(
      {
        walletAddress: "wallet-1",
        isRegistered: true,
        hasMintedSbt: true,
      },
    );
    await expect(adapter.claimReward()).resolves.toMatchObject({
      walletAddress: "wallet-1",
    });
  });
});
