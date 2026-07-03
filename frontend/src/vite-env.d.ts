/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FRONTEND_RUNTIME_MODE?: "local-e2e";
  readonly VITE_BACKEND_BASE_URL?: string;
  readonly VITE_SOLANA_RPC_URL?: string;
  readonly VITE_SOLANA_WS_URL?: string;
  readonly VITE_GREEN_REPUTATION_PROGRAM_ID?: string;
  readonly VITE_LOCAL_E2E_USER_SECRET_KEY_JSON?: string;
  readonly VITE_LOCAL_E2E_MINT_AUTHORITY_SECRET_KEY_JSON?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
