export type FrontendRuntimeMode = "local-e2e";

export interface FrontendLocalE2EConfig {
  userSecretKeyJson: string;
  mintAuthoritySecretKeyJson: string;
}

export interface FrontendRuntimeConfig {
  mode: FrontendRuntimeMode;
  backendBaseUrl: string;
  solanaRpcUrl: string;
  programId: string;
  localE2E: FrontendLocalE2EConfig;
}

const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_LOCAL_SOLANA_RPC_URL = "http://127.0.0.1:8899";
const DEFAULT_PROGRAM_ID = "CYTYoWKNxj4xP1vUPef2HuRb8x8kgrnzpQXMi665Q6ve";

export function loadFrontendRuntimeConfig(
  env: ImportMetaEnv = import.meta.env,
): FrontendRuntimeConfig {
  if (env.VITE_FRONTEND_RUNTIME_MODE !== "local-e2e") {
    throw new Error(
      "VITE_FRONTEND_RUNTIME_MODE=local-e2e is required for frontend startup.",
    );
  }

  const mode = env.VITE_FRONTEND_RUNTIME_MODE;
  const backendBaseUrl = env.VITE_BACKEND_BASE_URL ?? DEFAULT_BACKEND_BASE_URL;
  const programId = env.VITE_GREEN_REPUTATION_PROGRAM_ID ?? DEFAULT_PROGRAM_ID;
  const solanaRpcUrl = env.VITE_SOLANA_RPC_URL ?? DEFAULT_LOCAL_SOLANA_RPC_URL;
  const userSecretKeyJson = env.VITE_LOCAL_E2E_USER_SECRET_KEY_JSON?.trim();
  const mintAuthoritySecretKeyJson =
    env.VITE_LOCAL_E2E_MINT_AUTHORITY_SECRET_KEY_JSON?.trim();

  if (!userSecretKeyJson) {
    throw new Error(
      "VITE_LOCAL_E2E_USER_SECRET_KEY_JSON is required when VITE_FRONTEND_RUNTIME_MODE=local-e2e.",
    );
  }

  if (!mintAuthoritySecretKeyJson) {
    throw new Error(
      "VITE_LOCAL_E2E_MINT_AUTHORITY_SECRET_KEY_JSON is required when VITE_FRONTEND_RUNTIME_MODE=local-e2e.",
    );
  }

  return {
    mode,
    backendBaseUrl,
    solanaRpcUrl,
    programId,
    localE2E: {
      userSecretKeyJson,
      mintAuthoritySecretKeyJson,
    },
  };
}
