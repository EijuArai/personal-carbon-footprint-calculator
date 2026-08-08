import type { Express } from 'express';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import { createApp } from '../app/create-app.js';
import type { AppEnv } from '../config/env.js';
import { loadEnv } from '../config/env.js';
import {
  createDatabaseHandle,
  createStateStore,
  type DatabaseHandle,
} from '../db/index.js';
import {
  HmacJwtAuthService,
  HmacJwtDevIngestTokenIssuer,
} from '../modules/ingestion/auth-service.js';
import { BackendDecryptionService } from '../modules/ingestion/decryption-service.js';
import { InMemoryWalletAuthService } from '../modules/ingestion/wallet-auth-service.js';
import { FootprintOrchestrationService } from '../modules/ingestion/footprint-orchestration.js';
import { LcaOrchestrator } from '../modules/lca/index.js';
import {
  InMemoryMetadataStorageProvider,
  JsonMetadataPublisher,
  type MetadataStorageProvider,
} from '../modules/metadata/index.js';
import {
  createAnchorProgramTransport,
  GreenReputationOracleClient,
  type ProgramTransport,
} from '../modules/oracle/index.js';
import logger from '../utils/logger.js';

export interface RuntimeSigners {
  verifier: Keypair;
  metadataAuthority?: Keypair;
  admin?: Keypair;
}

export interface ConfiguredBackendRuntimeResources {
  appEnv: AppEnv;
  app: Express;
  databaseHandle: DatabaseHandle;
  stateStore: ReturnType<typeof createStateStore>;
  decryptionService: BackendDecryptionService;
  authService: HmacJwtAuthService;
  walletAuthService?: InMemoryWalletAuthService;
  lcaOrchestrator: LcaOrchestrator;
  metadataStorageProvider: MetadataStorageProvider;
  metadataPublisher: JsonMetadataPublisher;
  oracleClient: GreenReputationOracleClient;
  connection: Connection;
  programId: PublicKey;
  signers: RuntimeSigners;
}

export interface ConfiguredBackendRuntime {
  app: Express;
  resources: ConfiguredBackendRuntimeResources;
}

export interface CreateConfiguredBackendRuntimeOptions {
  env?: AppEnv;
  databaseHandle?: DatabaseHandle;
  connectionFactory?: (rpcUrl: string) => Connection;
  transportFactory?: (
    options: Parameters<typeof createAnchorProgramTransport>[0],
  ) => ProgramTransport;
  metadataStorageProvider?: MetadataStorageProvider;
  decryptionService?: BackendDecryptionService;
  authService?: HmacJwtAuthService;
  lcaOrchestrator?: LcaOrchestrator;
  now?: () => number;
}

export function createConfiguredBackendRuntime(
  options: CreateConfiguredBackendRuntimeOptions = {},
): ConfiguredBackendRuntime {
  const appEnv = options.env ?? loadEnv();
  const signers = loadRuntimeSigners(appEnv);
  const programId = parseProgramId(appEnv.GREEN_REPUTATION_PROGRAM_ID);
  const connection = (options.connectionFactory ?? createConnection)(
    appEnv.SOLANA_RPC_URL,
  );
  const transport = (options.transportFactory ?? createAnchorProgramTransport)({
    connection,
    programId,
    signer: signers.verifier,
  });
  const oracleClient = new GreenReputationOracleClient({
    programId,
    transport,
  });
  const databaseHandle =
    options.databaseHandle ??
    createDatabaseHandle({ filename: appEnv.SQLITE_PATH });
  const stateStore = createStateStore(databaseHandle);
  const decryptionService =
    options.decryptionService ?? createDecryptionService(appEnv);
  const authService =
    options.authService ??
    new HmacJwtAuthService({
      issuer: appEnv.SIWS_JWT_ISSUER,
      audience: appEnv.SIWS_JWT_AUDIENCE,
      sharedSecret: appEnv.SIWS_JWT_SECRET,
    });
  const walletAuthService = createWalletAuthService(appEnv, options.now);
  const lcaOrchestrator =
    options.lcaOrchestrator ??
    new LcaOrchestrator({ ...(options.now ? { now: options.now } : {}) });
  const metadataStorageProvider =
    options.metadataStorageProvider ??
    new InMemoryMetadataStorageProvider(appEnv.METADATA_BASE_URI);
  const metadataPublisher = new JsonMetadataPublisher(metadataStorageProvider);
  const footprintOrchestrationService = new FootprintOrchestrationService({
    stateStore,
    lcaOrchestrator,
    metadataPublisher,
    oracleClient,
    programId,
    ...(options.now ? { now: options.now } : {}),
  });

  const app = createApp({
    env: appEnv,
    stateStore,
    authService,
    ...(walletAuthService ? { walletAuthService } : {}),
    decryptionService,
    footprintOrchestrationService,
    publicKeyProvider: () => decryptionService.exportPublicKeyPem(),
  });

  logger.info(
    {
      environment: appEnv.NODE_ENV,
      sqlitePath: appEnv.SQLITE_PATH,
      solanaRpcUrl: appEnv.SOLANA_RPC_URL,
      localE2eMode: appEnv.LOCAL_E2E_MODE,
      walletAuthEnabled: Boolean(walletAuthService),
    },
    'Configured backend runtime resources.',
  );

  return {
    app,
    resources: {
      appEnv,
      app,
      databaseHandle,
      stateStore,
      decryptionService,
      authService,
      ...(walletAuthService ? { walletAuthService } : {}),
      lcaOrchestrator,
      metadataStorageProvider,
      metadataPublisher,
      oracleClient,
      connection,
      programId,
      signers,
    },
  };
}

function createConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, 'confirmed');
}

function createWalletAuthService(
  appEnv: AppEnv,
  now?: () => number,
): InMemoryWalletAuthService | undefined {
  if (!appEnv.LOCAL_E2E_MODE || !appEnv.LOCAL_E2E_DEV_AUTH_ENABLED) {
    return undefined;
  }

  return new InMemoryWalletAuthService({
    issuer: appEnv.SIWS_JWT_ISSUER,
    audience: appEnv.SIWS_JWT_AUDIENCE,
    sharedSecret: appEnv.SIWS_JWT_SECRET,
    challengeTtlSeconds: 300,
    tokenTtlSeconds: appEnv.LOCAL_E2E_DEV_AUTH_TOKEN_TTL_SECONDS,
    ...(now ? { now } : {}),
  });
}

function createDecryptionService(appEnv: AppEnv): BackendDecryptionService {
  return appEnv.BACKEND_RSA_PRIVATE_KEY_PEM
    ? new BackendDecryptionService({
        privateKeyPem: appEnv.BACKEND_RSA_PRIVATE_KEY_PEM,
      })
    : new BackendDecryptionService();
}

function loadRuntimeSigners(appEnv: AppEnv): RuntimeSigners {
  const metadataAuthority = appEnv.LOCAL_E2E_MODE
    ? parseRequiredKeypair(
        'SOLANA_METADATA_AUTHORITY_SECRET_KEY_JSON',
        appEnv.SOLANA_METADATA_AUTHORITY_SECRET_KEY_JSON,
      )
    : parseOptionalKeypair(
        'SOLANA_METADATA_AUTHORITY_SECRET_KEY_JSON',
        appEnv.SOLANA_METADATA_AUTHORITY_SECRET_KEY_JSON,
      );
  const admin = parseOptionalKeypair(
    'SOLANA_ADMIN_SECRET_KEY_JSON',
    appEnv.SOLANA_ADMIN_SECRET_KEY_JSON,
  );

  return {
    verifier: parseRequiredKeypair(
      'SOLANA_VERIFIER_SECRET_KEY_JSON',
      appEnv.SOLANA_VERIFIER_SECRET_KEY_JSON,
    ),
    ...(metadataAuthority ? { metadataAuthority } : {}),
    ...(admin ? { admin } : {}),
  };
}

function parseProgramId(value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(
      'GREEN_REPUTATION_PROGRAM_ID must be a valid Solana public key.',
    );
  }
}

function parseRequiredKeypair(
  name: string,
  value: string | undefined,
): Keypair {
  if (!value) {
    throw new Error(
      `${name} is required to assemble the configured backend runtime.`,
    );
  }

  return parseKeypair(name, value);
}

function parseOptionalKeypair(
  name: string,
  value: string | undefined,
): Keypair | undefined {
  if (!value) {
    return undefined;
  }

  return parseKeypair(name, value);
}

function parseKeypair(name: string, value: string): Keypair {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(
      `${name} must be valid JSON containing a 64-byte secret key array.`,
    );
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    parsed.some((entry) => !Number.isInteger(entry))
  ) {
    throw new Error(`${name} must be a JSON array of 64 integers.`);
  }

  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch {
    throw new Error(
      `${name} could not be converted into a valid Solana keypair.`,
    );
  }
}
