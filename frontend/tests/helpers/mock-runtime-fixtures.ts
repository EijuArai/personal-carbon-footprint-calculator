import type {
  AuthTokenProvider,
  DecryptedFootprintSubmission,
  EncryptedIngestionApi,
  FootprintIngestionResult,
  JobStatusProvider,
  JobStatusSnapshot,
  PublicProfile,
  WalletConnectionState,
  WalletProfileAdapter,
  WalletProfileSnapshot,
} from "../../src/lib/domain";

export interface MockWalletProfileAdapterOptions {
  connectionState?: WalletConnectionState;
  snapshot?: Partial<WalletProfileSnapshot>;
}

interface MockEncryptedIngestionApiOptions {
  hasFullHistoricalWindow?: boolean;
  onChainPastAverageMonthlyEmissions?: number;
  bonusMultiplier?: number;
  penaltyMultiplier?: number;
  neutralMultiplier?: number;
}

function normalizeSnapshot(
  snapshot: Partial<WalletProfileSnapshot> | undefined,
): WalletProfileSnapshot {
  const normalized: WalletProfileSnapshot = {
    walletAddress:
      snapshot?.walletAddress ?? "7YpWALLET7ovzXx18M3YvN6mC4x2g3E3h9Z7mDemo111",
    totalEmissionsKgCo2e: snapshot?.totalEmissionsKgCo2e ?? 0,
    totalReductionsKgCo2e: snapshot?.totalReductionsKgCo2e ?? 0,
    pendingRewardLamports: snapshot?.pendingRewardLamports ?? 0n,
    isRegistered: snapshot?.isRegistered ?? false,
    hasMintedSbt: snapshot?.hasMintedSbt ?? false,
  };

  if (snapshot?.profileAddress) {
    normalized.profileAddress = snapshot.profileAddress;
  }

  if (snapshot?.publicProfile) {
    normalized.publicProfile = snapshot.publicProfile;
  }

  if (snapshot?.rank) {
    normalized.rank = snapshot.rank;
  }

  return normalized;
}

function requireConnected(
  state: WalletConnectionState,
): asserts state is WalletConnectionState & { walletAddress: string } {
  if (state.phase !== "connected" || !state.walletAddress) {
    throw new Error("Connect a wallet before continuing.");
  }
}

function createProfileAddress(walletAddress: string): string {
  return `profile-${walletAddress.slice(0, 10)}`;
}

export function createMockWalletProfileAdapter(
  options?: MockWalletProfileAdapterOptions,
): WalletProfileAdapter {
  let connectionState: WalletConnectionState = options?.connectionState ?? {
    phase: "disconnected",
  };
  let snapshot = normalizeSnapshot(options?.snapshot);

  return {
    async getConnectionState() {
      return connectionState;
    },
    async connectWallet() {
      connectionState = {
        phase: "connected",
        walletAddress: snapshot.walletAddress,
      };
      return connectionState;
    },
    async signAuthMessage(message: string) {
      requireConnected(connectionState);
      return Buffer.from(
        `signed:${connectionState.walletAddress}:${message}`,
      ).toString("base64");
    },
    async getProfileSnapshot(walletAddress: string) {
      return {
        ...snapshot,
        walletAddress,
      };
    },
    async registerPublicProfile(input: PublicProfile) {
      requireConnected(connectionState);

      snapshot = {
        ...snapshot,
        walletAddress: connectionState.walletAddress,
        profileAddress: createProfileAddress(connectionState.walletAddress),
        publicProfile: input,
        isRegistered: true,
      };

      return snapshot;
    },
    async mintUserSbt() {
      requireConnected(connectionState);
      if (!snapshot.isRegistered) {
        throw new Error("Register a public profile before minting the SBT.");
      }

      snapshot = {
        ...snapshot,
        walletAddress: connectionState.walletAddress,
        hasMintedSbt: true,
      };

      return snapshot;
    },
    async updatePublicProfile(input: PublicProfile) {
      requireConnected(connectionState);
      if (!snapshot.isRegistered) {
        throw new Error("Register a public profile before updating it.");
      }

      snapshot = {
        ...snapshot,
        walletAddress: connectionState.walletAddress,
        publicProfile: input,
      };

      return snapshot;
    },
    async claimReward() {
      requireConnected(connectionState);
      if ((snapshot.pendingRewardLamports ?? 0n) <= 0n) {
        throw new Error("No claimable reward is available yet.");
      }

      snapshot = {
        ...snapshot,
        walletAddress: connectionState.walletAddress,
        pendingRewardLamports: 0n,
      };

      return snapshot;
    },
  };
}

export function createMockAuthTokenProvider(
  token = "mock-siws-jwt",
): AuthTokenProvider {
  return {
    async getAuthToken() {
      return token;
    },
  };
}

export function createMockEncryptedIngestionApi(
  options: MockEncryptedIngestionApiOptions = {},
): EncryptedIngestionApi {
  let requestCounter = 0;
  const bonusMultiplier = options.bonusMultiplier ?? 1.12;
  const penaltyMultiplier = options.penaltyMultiplier ?? 0.88;
  const neutralMultiplier = options.neutralMultiplier ?? 1;

  return {
    async fetchPublicKeyPem() {
      return "-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----";
    },
    async submitEncryptedFootprint(
      payload: DecryptedFootprintSubmission,
    ): Promise<FootprintIngestionResult> {
      requestCounter += 1;
      const spendTotal = payload.lca.spendEntries.reduce(
        (sum, entry) => sum + entry.amount,
        0,
      );
      const activityTotal = payload.lca.activityEntries.reduce(
        (sum, entry) => sum + entry.value,
        0,
      );
      const totalEmissionsKgCo2e = Number(
        (spendTotal * 0.01 + activityTotal * 0.05).toFixed(2),
      );
      const baseReductionKgCo2e = Number(
        Math.max(activityTotal * 0.08, 0.4).toFixed(2),
      );
      const hasFullHistoricalWindow = options.hasFullHistoricalWindow ?? false;
      const onChainPastAverageMonthlyEmissions = hasFullHistoricalWindow
        ? (options.onChainPastAverageMonthlyEmissions ?? 0)
        : 0;
      const multiplierApplied = !hasFullHistoricalWindow
        ? neutralMultiplier
        : onChainPastAverageMonthlyEmissions > totalEmissionsKgCo2e
          ? bonusMultiplier
          : penaltyMultiplier;
      const finalRewards = Number(
        (baseReductionKgCo2e * multiplierApplied).toFixed(2),
      );

      return {
        subject: payload.userPubkey,
        nonce: `nonce-${requestCounter}`,
        requestId: `req-${requestCounter}`,
        aggregateResult: {
          totalEmissionsKgCo2e,
          baseReductionKgCo2e,
          finalRewards,
          multiplierApplied,
          dataSourceKind:
            payload.lca.spendEntries.length > 0 &&
            payload.lca.activityEntries.length > 0
              ? "hybrid"
              : payload.lca.activityEntries.length > 0
                ? "activity"
                : "spend",
          categories: [
            ...new Set([
              ...payload.lca.spendEntries.map((entry) => entry.category),
              ...payload.lca.activityEntries.map((entry) => entry.category),
            ]),
          ],
        },
        metadata: {
          uri: `ipfs://mock-metadata-${requestCounter}.json`,
          metadataVersion: payload.currentMetadataVersion + 1,
        },
        jobs: [
          {
            id: requestCounter * 10 + 1,
            kind: "submit_verified_footprint",
            status: "pending",
          },
          {
            id: requestCounter * 10 + 2,
            kind: "sync_sbt_state",
            status: "pending",
          },
        ],
        dataHash: `${requestCounter}`.padStart(64, "0"),
      };
    },
  };
}

export function createMockJobStatusProvider(): JobStatusProvider {
  const statusMap = new Map<number, JobStatusSnapshot>();

  return {
    async getJobStatus(jobId: number): Promise<JobStatusSnapshot> {
      const existing = statusMap.get(jobId);
      if (existing) {
        const nextStatus =
          existing.status === "pending" ? "running" : "completed";
        const nextSnapshot: JobStatusSnapshot = {
          ...existing,
          status: nextStatus,
        };
        statusMap.set(jobId, nextSnapshot);
        return nextSnapshot;
      }

      const initial: JobStatusSnapshot = {
        jobId,
        kind: jobId % 2 === 0 ? "sync_sbt_state" : "submit_verified_footprint",
        status: "running",
      };
      statusMap.set(jobId, initial);
      return initial;
    },
  };
}
