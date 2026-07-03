import { createFetchEncryptedIngestionApi } from "../lib/api/encrypted-ingestion-client";
import type {
  AuthTokenProvider,
  EncryptedIngestionApi,
  JobStatusProvider,
  WalletProfileAdapter,
} from "../lib/domain";
import { createBackendDevAuthTokenProvider } from "../features/submission/backend-dev-auth-token-provider";
import { createLocalE2EWalletProfileAdapter } from "../features/wallet/local-e2e-wallet-profile-adapter";
import type { FrontendRuntimeConfig } from "./runtime-config";

export interface FrontendRuntimeAdapters {
  walletAdapter: WalletProfileAdapter;
  authTokenProvider: AuthTokenProvider;
  ingestionApi: EncryptedIngestionApi;
  jobStatusProvider: JobStatusProvider;
  submissionRuntimeNote: string;
}

interface CreateFrontendRuntimeAdapterDependencies {
  createWalletAdapter?: (config: FrontendRuntimeConfig) => WalletProfileAdapter;
  createAuthTokenProvider?: (
    config: FrontendRuntimeConfig,
  ) => AuthTokenProvider;
  createIngestionApi?: (options: {
    baseUrl: string;
    authTokenProvider: AuthTokenProvider;
  }) => EncryptedIngestionApi & JobStatusProvider;
}

export function createFrontendRuntimeAdapters(
  config: FrontendRuntimeConfig,
  dependencies: CreateFrontendRuntimeAdapterDependencies = {},
): FrontendRuntimeAdapters {
  const localE2E = config.localE2E;
  if (!localE2E.userSecretKeyJson) {
    throw new Error(
      "Local E2E user signer secret is required for the real wallet adapter.",
    );
  }

  if (!localE2E.mintAuthoritySecretKeyJson) {
    throw new Error(
      "Local E2E mint authority signer secret is required for the real wallet adapter.",
    );
  }

  const walletAdapter = (
    dependencies.createWalletAdapter ??
    ((runtimeConfig) =>
      createLocalE2EWalletProfileAdapter({
        rpcUrl: runtimeConfig.solanaRpcUrl,
        programId: runtimeConfig.programId,
        userSecretKeyJson: runtimeConfig.localE2E.userSecretKeyJson,
        mintAuthoritySecretKeyJson:
          runtimeConfig.localE2E.mintAuthoritySecretKeyJson,
      }))
  )(config);
  const authTokenProvider = (
    dependencies.createAuthTokenProvider ??
    ((runtimeConfig) =>
      createBackendDevAuthTokenProvider({
        baseUrl: runtimeConfig.backendBaseUrl,
        walletAdapter,
      }))
  )(config);
  const ingestionApi = (
    dependencies.createIngestionApi ?? createFetchEncryptedIngestionApi
  )({
    baseUrl: config.backendBaseUrl,
    authTokenProvider,
  });

  return {
    walletAdapter,
    authTokenProvider,
    ingestionApi,
    jobStatusProvider: ingestionApi,
    submissionRuntimeNote:
      "Your private data will never be stored Solana on-chain or in our backend.",
  };
}
