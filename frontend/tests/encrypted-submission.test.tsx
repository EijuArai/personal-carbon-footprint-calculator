import type { PropsWithChildren } from "react";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach } from "vitest";
import { vi } from "vitest";

vi.mock("@solana/react-hooks", () => ({
  SolanaProvider: ({ children }: PropsWithChildren) => children,
}));

vi.mock("../src/lib/solana/client", () => ({
  solanaClient: {},
}));

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

import { createFetchEncryptedIngestionApi } from "../src/lib/api/encrypted-ingestion-client";
import { createSha256Hex } from "../src/lib/crypto/browser-hybrid-encryption";
import * as browserHybridEncryption from "../src/lib/crypto/browser-hybrid-encryption";
import {
  EncryptedSubmissionPanel,
  type SubmissionWorkspaceSnapshot,
} from "../src/features/submission/encrypted-submission-panel";
import { AppProviders } from "../src/app/providers";
import {
  createMockAuthTokenProvider,
  createMockEncryptedIngestionApi,
  createMockJobStatusProvider,
  createMockWalletProfileAdapter,
} from "./helpers/mock-runtime-fixtures";

describe("browser hybrid encryption", () => {
  it("creates a deterministic sha-256 hex digest", async () => {
    await expect(createSha256Hex("green reputation")).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});

describe("fetch encrypted ingestion api", () => {
  it("fetches the public key, posts an encrypted request, and parses the response", async () => {
    const encryptSpy = vi
      .spyOn(browserHybridEncryption, "encryptSubmissionPayload")
      .mockResolvedValue({
        encryptedSessionKey: "session-key",
        encryptedPayload: "ciphertext",
        iv: "iv",
        authTag: "auth-tag",
        dataHash:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ publicKeyPem: TEST_PUBLIC_KEY_PEM }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            subject: "wallet-1",
            nonce: "nonce-1",
            requestId: "req-1",
            aggregateResult: {
              totalEmissionsKgCo2e: 10,
              baseReductionKgCo2e: 1,
              finalRewards: 1.1,
              multiplierApplied: 1.1,
              dataSourceKind: "hybrid",
              categories: ["Vegetables"],
            },
            metadata: {
              uri: "ipfs://metadata.json",
              metadataVersion: 2,
            },
            jobs: [
              { id: 1, kind: "submit_verified_footprint", status: "pending" },
            ],
            dataHash:
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          }),
          { status: 202 },
        ),
      );

    const api = createFetchEncryptedIngestionApi({
      authTokenProvider: createMockAuthTokenProvider("jwt-123"),
      baseUrl: "https://example.test",
      fetchImpl,
    });

    const result = await api.submitEncryptedFootprint({
      userPubkey: "wallet-1",
      currentMetadataVersion: 1,
      publicProfile: { displayAlias: "Aoi", countryCode: "JP", avatarUri: "" },
      aggregateStateHint: {
        totalEmissionsKgCo2e: 0,
        totalReductionsKgCo2e: 0,
        pendingRewardLamports: 0n,
      },
      lca: {
        spendEntries: [
          {
            spendId: "m-1",
            category: "Vegetables",
            amount: 20,
            source: "manual",
          },
        ],
        activityEntries: [],
        history: { pastAverageMonthlyEmissions: 30 },
      },
    });

    expect(result.requestId).toBe("req-1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const requestInit = fetchImpl.mock.calls[1]?.[1];
    expect(requestInit?.headers).toMatchObject({
      Authorization: "Bearer jwt-123",
    });
    const requestBody = JSON.parse(String(requestInit?.body));
    expect(requestBody).toMatchObject({
      encryptedSessionKey: expect.any(String),
      encryptedPayload: expect.any(String),
      iv: expect.any(String),
      authTag: expect.any(String),
      dataHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    encryptSpy.mockRestore();
  });

  it("surfaces backend API errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "ingestion_unavailable",
            message: "Encrypted ingestion service is not configured.",
          },
        }),
        { status: 503 },
      ),
    );

    const api = createFetchEncryptedIngestionApi({
      authTokenProvider: createMockAuthTokenProvider(),
      baseUrl: "https://example.test",
      fetchImpl,
    });

    await expect(api.fetchPublicKeyPem()).rejects.toThrow(
      /encrypted ingestion service is not configured/i,
    );
  });
});

describe("encrypted submission panel", () => {
  it("ignores payload history and stays neutral when the mock has no full on-chain history window", async () => {
    const api = createMockEncryptedIngestionApi();

    const result = await api.submitEncryptedFootprint({
      userPubkey: "wallet-1",
      currentMetadataVersion: 1,
      publicProfile: { displayAlias: "Aoi", countryCode: "JP", avatarUri: "" },
      aggregateStateHint: {
        totalEmissionsKgCo2e: 0,
        totalReductionsKgCo2e: 0,
        pendingRewardLamports: 0n,
      },
      lca: {
        spendEntries: [
          {
            spendId: "m-1",
            category: "Vegetables",
            amount: 50,
            source: "manual",
          },
        ],
        activityEntries: [],
        history: { pastAverageMonthlyEmissions: 999 },
      },
    });

    expect(result.aggregateResult.multiplierApplied).toBe(1);
    expect(result.aggregateResult.finalRewards).toBe(
      result.aggregateResult.baseReductionKgCo2e,
    );
  });

  it("can simulate a full on-chain history window without reading payload history", async () => {
    const api = createMockEncryptedIngestionApi({
      hasFullHistoricalWindow: true,
      onChainPastAverageMonthlyEmissions: 100,
    });

    const result = await api.submitEncryptedFootprint({
      userPubkey: "wallet-1",
      currentMetadataVersion: 1,
      publicProfile: { displayAlias: "Aoi", countryCode: "JP", avatarUri: "" },
      aggregateStateHint: {
        totalEmissionsKgCo2e: 0,
        totalReductionsKgCo2e: 0,
        pendingRewardLamports: 0n,
      },
      lca: {
        spendEntries: [
          {
            spendId: "m-1",
            category: "Vegetables",
            amount: 50,
            source: "manual",
          },
        ],
        activityEntries: [],
        history: { pastAverageMonthlyEmissions: 0 },
      },
    });

    expect(result.aggregateResult.multiplierApplied).toBe(1.12);
  });

  it("submits reviewed input and renders aggregate-only feedback plus tracked jobs", async () => {
    const user = userEvent.setup();

    render(
      <AppProviders
        walletAdapter={createMockWalletProfileAdapter({
          connectionState: {
            phase: "connected",
            walletAddress: "wallet-1",
          },
          snapshot: {
            walletAddress: "wallet-1",
            publicProfile: {
              displayAlias: "Aoi",
              countryCode: "JP",
              avatarUri: "",
            },
            isRegistered: true,
            hasMintedSbt: true,
            pendingRewardLamports: 1000n,
            totalEmissionsKgCo2e: 5,
            totalReductionsKgCo2e: 1,
          },
        })}
      >
        <EncryptedSubmissionPanel
          workspaceSnapshot={{
            payloadPreview: {
              spendEntries: [
                {
                  spendId: "m-1",
                  category: "Vegetables",
                  amount: 50,
                  source: "manual",
                },
                {
                  spendId: "r-1",
                  category: "RailwayTransportPassengers",
                  amount: 12,
                  source: "ocr",
                  proofHash: "proof-1",
                },
              ],
              activityEntries: [],
              history: { pastAverageMonthlyEmissions: 40 },
            },
            activityEntryCount: 0,
            spendEntryCount: 2,
            uploadedArtifactCount: 1,
          }}
          authTokenProvider={createMockAuthTokenProvider()}
          ingestionApi={createMockEncryptedIngestionApi()}
          jobStatusProvider={createMockJobStatusProvider()}
        />
      </AppProviders>,
    );

    const submitButton = screen.getByRole("button", {
      name: /submit encrypted footprint/i,
    });
    await waitFor(() => expect(submitButton).toBeEnabled());
    await user.click(submitButton);
    await waitFor(() =>
      expect(
        screen.getByText(/aggregate scoring feedback/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/multiplier: 1/i)).toBeInTheDocument();
    expect(screen.getByText(/data hash:/i)).toBeInTheDocument();
    expect(screen.getByText(/submit_verified_footprint/i)).toBeInTheDocument();

    const refreshButtons = screen.getAllByRole("button", {
      name: /refresh job status/i,
    });
    const firstRefreshButton = refreshButtons[0];
    if (!firstRefreshButton) {
      throw new Error("Expected at least one refresh button.");
    }
    await user.click(firstRefreshButton);
    await waitFor(() =>
      expect(screen.getByText(/running|completed/i)).toBeInTheDocument(),
    );
  });

  it("surfaces submission errors such as missing SIWS tokens", async () => {
    const user = userEvent.setup();

    render(
      <AppProviders
        walletAdapter={createMockWalletProfileAdapter({
          connectionState: {
            phase: "connected",
            walletAddress: "wallet-2",
          },
          snapshot: {
            walletAddress: "wallet-2",
            publicProfile: {
              displayAlias: "Aoi",
              countryCode: "JP",
              avatarUri: "",
            },
            isRegistered: true,
            hasMintedSbt: true,
          },
        })}
      >
        <EncryptedSubmissionPanel
          workspaceSnapshot={{
            payloadPreview: {
              spendEntries: [
                {
                  spendId: "m-1",
                  category: "Vegetables",
                  amount: 50,
                  source: "manual",
                },
              ],
              activityEntries: [],
              history: { pastAverageMonthlyEmissions: 40 },
            },
            activityEntryCount: 0,
            spendEntryCount: 1,
            uploadedArtifactCount: 0,
          }}
          authTokenProvider={{
            async getAuthToken() {
              throw new Error("SIWS token is unavailable.");
            },
          }}
          ingestionApi={createMockEncryptedIngestionApi()}
          jobStatusProvider={createMockJobStatusProvider()}
        />
      </AppProviders>,
    );

    const submitButton = screen.getByRole("button", {
      name: /submit encrypted footprint/i,
    });
    await waitFor(() => expect(submitButton).toBeEnabled());
    await user.click(submitButton);
    await waitFor(() =>
      expect(
        screen.getByText(/siws token is unavailable/i),
      ).toBeInTheDocument(),
    );
  });

  it("clears the exported verified snapshot when the connected wallet changes", async () => {
    const user = userEvent.setup();
    const onVerifiedSnapshotChange = vi.fn();
    const workspaceSnapshot: SubmissionWorkspaceSnapshot = {
      payloadPreview: {
        spendEntries: [
          {
            spendId: "m-1",
            category: "Vegetables",
            amount: 50,
            source: "manual" as const,
          },
        ],
        activityEntries: [],
        history: { pastAverageMonthlyEmissions: 40 },
      },
      activityEntryCount: 0,
      spendEntryCount: 1,
      uploadedArtifactCount: 0,
    };

    const { rerender } = render(
      <AppProviders
        walletAdapter={createMockWalletProfileAdapter({
          connectionState: {
            phase: "connected",
            walletAddress: "wallet-1",
          },
          snapshot: {
            walletAddress: "wallet-1",
            publicProfile: {
              displayAlias: "Aoi",
              countryCode: "JP",
              avatarUri: "",
            },
            isRegistered: true,
            hasMintedSbt: true,
          },
        })}
      >
        <EncryptedSubmissionPanel
          workspaceSnapshot={workspaceSnapshot}
          authTokenProvider={createMockAuthTokenProvider()}
          ingestionApi={createMockEncryptedIngestionApi()}
          jobStatusProvider={createMockJobStatusProvider()}
          onVerifiedSnapshotChange={onVerifiedSnapshotChange}
        />
      </AppProviders>,
    );

    const submitButton = screen.getByRole("button", {
      name: /submit encrypted footprint/i,
    });
    await waitFor(() => expect(submitButton).toBeEnabled());
    await user.click(submitButton);

    await waitFor(() =>
      expect(onVerifiedSnapshotChange).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: expect.any(String),
          metadataUri: expect.any(String),
        }),
      ),
    );

    onVerifiedSnapshotChange.mockClear();

    rerender(
      <AppProviders
        walletAdapter={createMockWalletProfileAdapter({
          connectionState: {
            phase: "connected",
            walletAddress: "wallet-2",
          },
          snapshot: {
            walletAddress: "wallet-2",
            publicProfile: {
              displayAlias: "Ren",
              countryCode: "JP",
              avatarUri: "",
            },
            isRegistered: true,
            hasMintedSbt: false,
          },
        })}
      >
        <EncryptedSubmissionPanel
          workspaceSnapshot={workspaceSnapshot}
          authTokenProvider={createMockAuthTokenProvider()}
          ingestionApi={createMockEncryptedIngestionApi()}
          jobStatusProvider={createMockJobStatusProvider()}
          onVerifiedSnapshotChange={onVerifiedSnapshotChange}
        />
      </AppProviders>,
    );

    await waitFor(() =>
      expect(onVerifiedSnapshotChange).toHaveBeenCalledWith(undefined),
    );
  });

  it("blocks repeat submissions for the same wallet on the same day", async () => {
    const submittedAtIso = new Date().toISOString();

    window.localStorage.setItem(
      "green-reputation:verified-snapshot:wallet-1",
      JSON.stringify({
        requestId: "req-locked",
        dataHash:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        metadataUri: "ipfs://metadata.json",
        metadataVersion: 2,
        totalEmissionsKgCo2e: 10,
        baseReductionKgCo2e: 1,
        finalRewards: 1,
        multiplierApplied: 1,
        categories: ["Vegetables"],
        submittedAtIso,
      }),
    );

    render(
      <AppProviders
        walletAdapter={createMockWalletProfileAdapter({
          connectionState: {
            phase: "connected",
            walletAddress: "wallet-1",
          },
          snapshot: {
            walletAddress: "wallet-1",
            publicProfile: {
              displayAlias: "Aoi",
              countryCode: "JP",
              avatarUri: "",
            },
            isRegistered: true,
            hasMintedSbt: true,
          },
        })}
      >
        <EncryptedSubmissionPanel
          workspaceSnapshot={{
            payloadPreview: {
              spendEntries: [
                {
                  spendId: "m-1",
                  category: "Vegetables",
                  amount: 50,
                  source: "manual",
                },
              ],
              activityEntries: [],
              history: { pastAverageMonthlyEmissions: 40 },
            },
            activityEntryCount: 0,
            spendEntryCount: 1,
            uploadedArtifactCount: 0,
          }}
          authTokenProvider={createMockAuthTokenProvider()}
          ingestionApi={createMockEncryptedIngestionApi()}
          jobStatusProvider={createMockJobStatusProvider()}
        />
      </AppProviders>,
    );

    await waitFor(() =>
      expect(screen.getByText(/wallet: wallet-1/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/today's submission is already complete/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /submit encrypted footprint/i }),
    ).toBeDisabled();
  });
});

const TEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
TEST
-----END PUBLIC KEY-----`;
