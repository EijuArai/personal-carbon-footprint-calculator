import { describe, expect, it } from "vitest";

import {
  composeDashboardReadModel,
  createInitialSubmissionFlowState,
  createReviewedSubmissionDraft,
  deriveFeedbackTone,
  markSubmissionStarted,
  markSubmissionSucceeded,
  parseDecryptedFootprintSubmission,
  parseFootprintIngestionResult,
  publicProfileSchema,
  resolveJobTrackingMode,
  withPrivateArtifacts,
  withReviewedSubmission,
} from "../src/lib/domain";

describe("domain contracts", () => {
  it("parses backend-compatible decrypted submissions", () => {
    const submission = parseDecryptedFootprintSubmission({
      userPubkey: "11111111111111111111111111111111",
      publicProfile: {
        displayAlias: "Aoi",
        countryCode: "JP",
        avatarUri: "https://example.com/avatar.png",
      },
      lca: {
        spendEntries: [
          {
            spendId: "entry-1",
            category: "Vegetables",
            amount: 1200,
            source: "manual",
          },
        ],
      },
    });

    expect(submission.aggregateStateHint.pendingRewardLamports).toBe(0n);
    expect(submission.lca.spendEntries).toHaveLength(1);
  });

  it("rejects invalid lowercase country codes", () => {
    expect(() =>
      publicProfileSchema.parse({
        displayAlias: "Aoi",
        countryCode: "jp",
        avatarUri: "",
      }),
    ).toThrow(/countryCode/i);
  });

  it("parses ingestion responses including data hash and jobs", () => {
    const result = parseFootprintIngestionResult({
      subject: "user-1",
      nonce: "nonce-1",
      requestId: "req-1",
      aggregateResult: {
        totalEmissionsKgCo2e: 12.4,
        baseReductionKgCo2e: 1.1,
        finalRewards: 1.32,
        multiplierApplied: 1.2,
        dataSourceKind: "spend",
        categories: ["Vegetables", "RailwayTransport"],
      },
      metadata: {
        uri: "ipfs://metadata.json",
        metadataVersion: 2,
      },
      jobs: [
        {
          id: 1,
          kind: "submit_verified_footprint",
          status: "pending",
        },
      ],
      dataHash:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });

    expect(result.jobs[0]?.status).toBe("pending");
    expect(result.dataHash).toHaveLength(64);
  });
});

describe("domain state helpers", () => {
  it("clears transient private artifacts after a successful submission", () => {
    const reviewedSubmission = createReviewedSubmissionDraft({
      userPubkey: "11111111111111111111111111111111",
      publicProfile: {
        displayAlias: "Aoi",
        countryCode: "JP",
        avatarUri: "",
      },
    });

    const reviewedState = withReviewedSubmission(
      withPrivateArtifacts(createInitialSubmissionFlowState(), {
        uploadedArtifacts: [
          {
            artifactId: "img-1",
            fileName: "receipt.png",
            mimeType: "image/png",
          },
        ],
        rawOcrArtifacts: [{ artifactId: "ocr-1", rawText: "milk 300" }],
      }),
      reviewedSubmission,
    );

    const submittingState = markSubmissionStarted(reviewedState);
    const verifiedState = markSubmissionSucceeded(
      submittingState,
      parseFootprintIngestionResult({
        subject: "user-1",
        nonce: "nonce-1",
        requestId: "req-1",
        aggregateResult: {
          totalEmissionsKgCo2e: 12.4,
          baseReductionKgCo2e: 1.1,
          finalRewards: 1.32,
          multiplierApplied: 0.8,
          dataSourceKind: "hybrid",
          categories: ["Vegetables"],
        },
        metadata: {
          uri: "ipfs://metadata.json",
          metadataVersion: 2,
        },
        jobs: [
          {
            id: 1,
            kind: "sync_sbt_state",
            status: "running",
          },
        ],
        dataHash:
          "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      }),
      "2026-04-19T00:00:00.000Z",
    );

    expect(verifiedState.stage).toBe("verified");
    expect(verifiedState.transientPrivateState.uploadedArtifacts).toHaveLength(
      0,
    );
    expect(verifiedState.transientPrivateState.rawOcrArtifacts).toHaveLength(0);
    expect(verifiedState.verifiedSnapshot?.dataHash).toMatch(/[a-f0-9]{64}/i);
  });

  it("composes a public dashboard model from wallet and verified session data", () => {
    const dashboard = composeDashboardReadModel({
      wallet: {
        walletAddress: "wallet-1",
        publicProfile: {
          displayAlias: "Aoi",
          countryCode: "JP",
          avatarUri: "",
        },
        rank: "Seedling",
        totalEmissionsKgCo2e: 100,
        totalReductionsKgCo2e: 15,
        pendingRewardLamports: 5000n,
        isRegistered: true,
        hasMintedSbt: true,
      },
      verifiedSnapshot: {
        requestId: "req-1",
        dataHash:
          "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        metadataUri: "ipfs://metadata.json",
        metadataVersion: 2,
        totalEmissionsKgCo2e: 12.4,
        baseReductionKgCo2e: 1.1,
        finalRewards: 1.32,
        multiplierApplied: 1.1,
        categories: ["Vegetables"],
        submittedAtIso: "2026-04-19T00:00:00.000Z",
      },
    });

    expect(dashboard.hydrationSource).toBe("composed");
    expect(dashboard.rank).toBe("Seedling");
    expect(dashboard.totalEmissionsKgCo2e).toBe(12.4);
    expect(dashboard.totalReductionsKgCo2e).toBe(15);
    expect(dashboard.latestDataHash).toBeDefined();
  });

  it("derives bonus or penalty tone from the multiplier", () => {
    expect(deriveFeedbackTone(1.1)).toBe("bonus");
    expect(deriveFeedbackTone(1)).toBe("neutral");
    expect(deriveFeedbackTone(0.9)).toBe("penalty");
  });

  it("keeps job polling internal unless a safe flag is enabled", () => {
    expect(
      resolveJobTrackingMode({
        allowUserSafeJobPolling: false,
        allowMetadataHydration: false,
        allowMockAuthToken: true,
      }),
    ).toBe("internal-only");
  });
});
