import {
  createEmptyRawLcaRequest,
  parseDecryptedFootprintSubmission,
  type AggregateStateHint,
  type DecryptedFootprintSubmission,
  type FootprintIngestionResult,
  type PublicProfile,
} from "./contracts";
import type { DashboardReadModel, WalletProfileSnapshot } from "./adapters";

export type SubmissionStage =
  | "draft"
  | "review"
  | "submitting"
  | "verified"
  | "failed";
export type FeedbackTone = "bonus" | "neutral" | "penalty";

export interface UploadedArtifact {
  artifactId: string;
  fileName: string;
  mimeType: string;
}

export interface OcrArtifact {
  artifactId: string;
  rawText: string;
}

export interface TransientPrivateInputState {
  uploadedArtifacts: UploadedArtifact[];
  rawOcrArtifacts: OcrArtifact[];
}

export interface VerifiedSubmissionSnapshot {
  requestId: string;
  dataHash: string;
  metadataUri: string;
  metadataVersion: number;
  totalEmissionsKgCo2e: number;
  baseReductionKgCo2e: number;
  finalRewards: number;
  multiplierApplied: number;
  categories: string[];
  submittedAtIso: string;
}

export interface SubmissionFlowState {
  stage: SubmissionStage;
  reviewedSubmission?: DecryptedFootprintSubmission;
  transientPrivateState: TransientPrivateInputState;
  verifiedSnapshot?: VerifiedSubmissionSnapshot;
  lastError?: string;
}

const verifiedSnapshotStorageKeyPrefix = "green-reputation:verified-snapshot:";

export function createEmptyAggregateStateHint(): AggregateStateHint {
  return {
    totalEmissionsKgCo2e: 0,
    totalReductionsKgCo2e: 0,
    pendingRewardLamports: 0n,
  };
}

export function createReviewedSubmissionDraft(input: {
  userPubkey: string;
  publicProfile: PublicProfile;
  currentMetadataVersion?: number;
  aggregateStateHint?: AggregateStateHint;
}): DecryptedFootprintSubmission {
  return parseDecryptedFootprintSubmission({
    userPubkey: input.userPubkey,
    currentMetadataVersion: input.currentMetadataVersion ?? 0,
    publicProfile: input.publicProfile,
    aggregateStateHint:
      input.aggregateStateHint ?? createEmptyAggregateStateHint(),
    lca: createEmptyRawLcaRequest(),
  });
}

export function createInitialSubmissionFlowState(): SubmissionFlowState {
  return {
    stage: "draft",
    transientPrivateState: {
      uploadedArtifacts: [],
      rawOcrArtifacts: [],
    },
  };
}

export function withReviewedSubmission(
  state: SubmissionFlowState,
  reviewedSubmission: DecryptedFootprintSubmission,
): SubmissionFlowState {
  return {
    ...state,
    stage: "review",
    reviewedSubmission,
  };
}

export function withPrivateArtifacts(
  state: SubmissionFlowState,
  privateState: Partial<TransientPrivateInputState>,
): SubmissionFlowState {
  return {
    ...state,
    transientPrivateState: {
      ...state.transientPrivateState,
      ...privateState,
    },
  };
}

export function markSubmissionStarted(
  state: SubmissionFlowState,
): SubmissionFlowState {
  const { lastError: _lastError, ...rest } = state;

  return {
    ...rest,
    stage: "submitting",
  };
}

export function markSubmissionSucceeded(
  state: SubmissionFlowState,
  result: FootprintIngestionResult,
  submittedAtIso: string,
): SubmissionFlowState {
  const nextState: SubmissionFlowState = {
    stage: "verified",
    transientPrivateState: {
      uploadedArtifacts: [],
      rawOcrArtifacts: [],
    },
    verifiedSnapshot: {
      requestId: result.requestId,
      dataHash: result.dataHash,
      metadataUri: result.metadata.uri,
      metadataVersion: result.metadata.metadataVersion,
      totalEmissionsKgCo2e: result.aggregateResult.totalEmissionsKgCo2e,
      baseReductionKgCo2e: result.aggregateResult.baseReductionKgCo2e,
      finalRewards: result.aggregateResult.finalRewards,
      multiplierApplied: result.aggregateResult.multiplierApplied,
      categories: result.aggregateResult.categories,
      submittedAtIso,
    },
  };

  if (state.reviewedSubmission) {
    nextState.reviewedSubmission = state.reviewedSubmission;
  }

  return nextState;
}

export function markSubmissionFailed(
  state: SubmissionFlowState,
  message: string,
): SubmissionFlowState {
  return {
    ...state,
    stage: "failed",
    lastError: message,
  };
}

export function deriveFeedbackTone(multiplierApplied: number): FeedbackTone {
  if (multiplierApplied > 1) {
    return "bonus";
  }
  if (multiplierApplied < 1) {
    return "penalty";
  }
  return "neutral";
}

export function createVerifiedSnapshotStorageKey(
  walletAddress: string,
): string {
  return `${verifiedSnapshotStorageKeyPrefix}${walletAddress}`;
}

export function isVerifiedSubmissionSnapshot(
  value: unknown,
): value is VerifiedSubmissionSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.requestId === "string" &&
    typeof candidate.dataHash === "string" &&
    typeof candidate.metadataUri === "string" &&
    typeof candidate.metadataVersion === "number" &&
    typeof candidate.totalEmissionsKgCo2e === "number" &&
    typeof candidate.baseReductionKgCo2e === "number" &&
    typeof candidate.finalRewards === "number" &&
    typeof candidate.multiplierApplied === "number" &&
    Array.isArray(candidate.categories) &&
    candidate.categories.every((category) => typeof category === "string") &&
    typeof candidate.submittedAtIso === "string"
  );
}

export function readStoredVerifiedSnapshot(
  walletAddress: string | undefined,
): VerifiedSubmissionSnapshot | undefined {
  if (!walletAddress || typeof window === "undefined") {
    return undefined;
  }

  try {
    const rawValue = window.localStorage.getItem(
      createVerifiedSnapshotStorageKey(walletAddress),
    );
    if (!rawValue) {
      return undefined;
    }

    const parsedValue: unknown = JSON.parse(rawValue);
    return isVerifiedSubmissionSnapshot(parsedValue) ? parsedValue : undefined;
  } catch {
    return undefined;
  }
}

export function persistVerifiedSnapshot(
  walletAddress: string,
  snapshot: VerifiedSubmissionSnapshot,
): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    createVerifiedSnapshotStorageKey(walletAddress),
    JSON.stringify(snapshot),
  );
}

export function hasSubmittedToday(
  snapshot: VerifiedSubmissionSnapshot | undefined,
  now: Date = new Date(),
): boolean {
  if (!snapshot) {
    return false;
  }

  const submittedAt = new Date(snapshot.submittedAtIso);
  if (Number.isNaN(submittedAt.getTime())) {
    return false;
  }

  return (
    submittedAt.getFullYear() === now.getFullYear() &&
    submittedAt.getMonth() === now.getMonth() &&
    submittedAt.getDate() === now.getDate()
  );
}

export function composeDashboardReadModel(input: {
  wallet?: WalletProfileSnapshot;
  verifiedSnapshot?: VerifiedSubmissionSnapshot;
}): DashboardReadModel {
  const dashboard: DashboardReadModel = {
    totalEmissionsKgCo2e:
      input.verifiedSnapshot?.totalEmissionsKgCo2e ??
      input.wallet?.totalEmissionsKgCo2e ??
      0,
    totalReductionsKgCo2e: input.wallet?.totalReductionsKgCo2e ?? 0,
    pendingRewardLamports: input.wallet?.pendingRewardLamports ?? 0n,
    latestCategories: input.verifiedSnapshot?.categories ?? [],
    hydrationSource:
      input.wallet && input.verifiedSnapshot
        ? "composed"
        : input.wallet
          ? "wallet"
          : "session",
  };

  console.log("Composing dashboard read model with input:", input);

  if (input.wallet?.walletAddress) {
    dashboard.walletAddress = input.wallet.walletAddress;
  }

  if (input.wallet?.publicProfile) {
    dashboard.publicProfile = input.wallet.publicProfile;
  }

  if (input.wallet?.rank) {
    dashboard.rank = input.wallet.rank;
  }

  if (input.verifiedSnapshot?.dataHash) {
    dashboard.latestDataHash = input.verifiedSnapshot.dataHash;
    dashboard.latestDataSourceKind = "hybrid";
  }

  if (input.verifiedSnapshot?.metadataUri) {
    dashboard.latestMetadataUri = input.verifiedSnapshot.metadataUri;
  }

  if (input.verifiedSnapshot?.metadataVersion !== undefined) {
    dashboard.latestMetadataVersion = input.verifiedSnapshot.metadataVersion;
  } else if (input.wallet?.metadataVersion !== undefined) {
    dashboard.latestMetadataVersion = input.wallet.metadataVersion;
  }

  return dashboard;
}
