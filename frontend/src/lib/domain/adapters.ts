import type {
  ApiErrorEnvelope,
  CanonicalDataSourceKind,
  DecryptedFootprintSubmission,
  FootprintIngestionResult,
  OracleJobKind,
  OracleJobStatus,
  PublicProfile,
  RankCode,
} from "./contracts";

export type WalletConnectionPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";
export type SbtLifecycleState =
  | "unregistered"
  | "registered"
  | "minting"
  | "minted"
  | "claimable";
export type DashboardHydrationSource =
  | "session"
  | "wallet"
  | "metadata"
  | "composed";
export type OcrCandidateKind = "spend" | "activity" | "unknown";
export type JobTrackingMode = "disabled" | "internal-only" | "user-safe";

export interface WalletProfileSnapshot {
  walletAddress: string;
  profileAddress?: string;
  publicProfile?: PublicProfile;
  rank?: RankCode;
  metadataVersion?: number;
  totalEmissionsKgCo2e?: number;
  totalReductionsKgCo2e?: number;
  pendingRewardLamports?: bigint;
  isRegistered: boolean;
  hasMintedSbt: boolean;
}

export interface WalletConnectionState {
  phase: WalletConnectionPhase;
  walletAddress?: string;
  error?: string;
}

export interface DashboardReadModel {
  walletAddress?: string;
  publicProfile?: PublicProfile;
  rank?: RankCode;
  totalEmissionsKgCo2e: number;
  totalReductionsKgCo2e: number;
  pendingRewardLamports: bigint;
  latestDataHash?: string;
  latestMetadataUri?: string;
  latestMetadataVersion?: number;
  latestDataSourceKind?: CanonicalDataSourceKind;
  latestCategories: string[];
  hydrationSource: DashboardHydrationSource;
}

export interface DashboardContext {
  walletAddress?: string;
  profileAddress?: string;
  latestDataHash?: string;
}

export interface OcrReviewCandidate {
  candidateId: string;
  kind: OcrCandidateKind;
  label: string;
  confidence: number;
  proposedCategory?: string;
  proposedAmount?: number;
  proposedValue?: number;
  proposedUnit?: string;
  proofHash?: string;
  rawTextSpan?: string;
}

export interface OcrNormalizationContext {
  fileName: string;
  mimeType: string;
}

export interface JobStatusSnapshot {
  jobId: number;
  kind: OracleJobKind;
  status: OracleJobStatus;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface FrontendFeatureFlags {
  allowUserSafeJobPolling: boolean;
  allowMetadataHydration: boolean;
  allowMockAuthToken: boolean;
}

export interface AuthTokenProvider {
  getAuthToken(): Promise<string>;
}

export interface EncryptedIngestionApi {
  fetchPublicKeyPem(): Promise<string>;
  submitEncryptedFootprint(
    payload: DecryptedFootprintSubmission,
  ): Promise<FootprintIngestionResult>;
}

export interface JobStatusProvider {
  getJobStatus(jobId: number): Promise<JobStatusSnapshot>;
}

export interface WalletProfileAdapter {
  getConnectionState(): Promise<WalletConnectionState>;
  connectWallet(): Promise<WalletConnectionState>;
  signAuthMessage(message: string): Promise<string>;
  getProfileSnapshot(walletAddress: string): Promise<WalletProfileSnapshot>;
  registerPublicProfile(input: PublicProfile): Promise<WalletProfileSnapshot>;
  mintUserSbt(): Promise<WalletProfileSnapshot>;
  updatePublicProfile(input: PublicProfile): Promise<WalletProfileSnapshot>;
  claimReward(): Promise<WalletProfileSnapshot>;
}

export interface OcrNormalizationProvider {
  normalizeOcrCandidates(
    rawText: string,
    context: OcrNormalizationContext,
  ): Promise<OcrReviewCandidate[]>;
}

export interface DashboardReadModelProvider {
  getDashboardState(context: DashboardContext): Promise<DashboardReadModel>;
}

export function resolveJobTrackingMode(
  flags: FrontendFeatureFlags,
): JobTrackingMode {
  if (flags.allowUserSafeJobPolling) {
    return "user-safe";
  }

  return "internal-only";
}

export function toApiErrorMessage(
  error: ApiErrorEnvelope | Error | string,
): string {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return error.error.message;
}

export function canClaimReward(snapshot: WalletProfileSnapshot): boolean {
  return (snapshot.pendingRewardLamports ?? 0n) > 0n;
}
