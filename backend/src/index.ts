export { createApp, type AppDependencies } from "./app/create-app.js";
export { loadEnv, type AppEnv } from "./config/env.js";
export { createDatabaseHandle, createStateStore } from "./db/index.js";
export { HmacJwtAuthService, extractBearerToken, type AuthContext, type AuthService } from "./modules/ingestion/auth-service.js";
export { BackendDecryptionService, type DecryptionService } from "./modules/ingestion/decryption-service.js";
export { encryptedRequestSchema, type EncryptedRequest } from "./modules/ingestion/encrypted-request.js";
export {
	FootprintOrchestrationService,
	decryptedFootprintSubmissionSchema,
	type DecryptedFootprintSubmission,
	type FootprintIngestionResult,
	type FootprintOrchestrationDependencies,
} from "./modules/ingestion/footprint-orchestration.js";
export {
	OracleRetryRunner,
	RetryableJobError,
	TerminalJobError,
	classifyJobError,
	type MetadataSyncPreparationResult,
	type RetryRunnerDependencies,
	type RunDueJobsResult,
} from "./modules/jobs/index.js";
export {
	LcaOrchestrator,
	calculateDynamicMultiplier,
	rawLcaRequestSchema,
	serializeCommitmentPayload,
	type CommitmentPreimageV1,
	type LcaResult,
	type NormalizedLcaInput,
	type RawLcaRequest,
	type RawLcaRequestInput,
} from "./modules/lca/index.js";
export {
	InMemoryMetadataStorageProvider,
	JsonMetadataPublisher,
	type AggregateStateSnapshot,
	type MetadataDocumentV1,
	type MetadataPublisher,
	type PublicProfileSnapshot,
	type PublishMetadataResult,
} from "./modules/metadata/index.js";
export {
	GreenReputationOracleClient,
	createAnchorProgramTransport,
	findFootprintCommitmentPda,
	findProtocolConfigPda,
	findRewardTreasuryPda,
	findTreasuryVaultPda,
	findUserProfilePda,
	hashCommitmentPreimage,
	quoteRewardLamports,
	type OracleSubmissionResult,
	type ProgramTransport,
	type ProtocolConfigSnapshot,
	type RewardPolicySnapshot,
	type SubmitVerifiedFootprintJobPayload,
	type SubmitVerifiedFootprintPayload,
	type SyncSbtStatePayload,
} from "./modules/oracle/index.js";