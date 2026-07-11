import { z } from 'zod';

const envBoolean = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }

    if (normalized === 'false') {
      return false;
    }
  }

  return value;
}, z.boolean());

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('127.0.0.1'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    BACKEND_PUBLIC_BASE_URL: z.url().default('http://127.0.0.1:3000'),
    SQLITE_PATH: z.string().min(1).default('./db/green-reputation.sqlite'),
    SIWS_JWT_ISSUER: z.string().min(1).default('green-reputation.local'),
    SIWS_JWT_AUDIENCE: z.string().min(1).default('green-reputation.web'),
    SIWS_JWT_SECRET: z
      .string()
      .min(16)
      .default('dev-siws-secret-not-for-production'),
    BACKEND_RSA_PRIVATE_KEY_PEM: z.string().min(1).optional(),
    SOLANA_RPC_URL: z.url().default('http://127.0.0.1:8899'),
    GREEN_REPUTATION_PROGRAM_ID: z
      .string()
      .min(1)
      .default('CYTYoWKNxj4xP1vUPef2HuRb8x8kgrnzpQXMi665Q6ve'),
    METADATA_BASE_URI: z
      .url()
      .default('https://metadata.green-reputation.local'),
    LOCAL_E2E_MODE: envBoolean.default(false),
    LOCAL_E2E_DEV_AUTH_ENABLED: envBoolean.default(false),
    LOCAL_E2E_DEV_AUTH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(86_400)
      .default(900),
    LOCAL_E2E_WORKER_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(25)
      .max(60_000)
      .default(250),
    LOCAL_E2E_WORKER_MAX_JOBS_PER_TICK: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(25),
    SOLANA_VERIFIER_SECRET_KEY_JSON: z.string().min(1).optional(),
    SOLANA_METADATA_AUTHORITY_SECRET_KEY_JSON: z.string().min(1).optional(),
    SOLANA_ADMIN_SECRET_KEY_JSON: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.LOCAL_E2E_DEV_AUTH_ENABLED && !value.LOCAL_E2E_MODE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOCAL_E2E_DEV_AUTH_ENABLED'],
        message:
          'LOCAL_E2E_DEV_AUTH_ENABLED requires LOCAL_E2E_MODE to be enabled.',
      });
    }

    if (
      value.NODE_ENV === 'production' &&
      (value.LOCAL_E2E_MODE || value.LOCAL_E2E_DEV_AUTH_ENABLED)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOCAL_E2E_MODE'],
        message:
          'Local E2E mode and dev auth bridge must not be enabled in production.',
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(source);
}
