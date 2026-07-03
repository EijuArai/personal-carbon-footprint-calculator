import express, { type Express } from 'express';
import { z } from 'zod';
import cors from 'cors';

import { AppError, isAppError } from '../lib/app-error.js';
import { createRequestId } from '../lib/request-id.js';
import type { AppEnv } from '../config/env.js';
import { authenticateSiws } from '../middleware/authenticate-siws.js';
import type { AuthService } from '../modules/ingestion/auth-service.js';
import type { DecryptionService } from '../modules/ingestion/decryption-service.js';
import { encryptedRequestSchema } from '../modules/ingestion/encrypted-request.js';
import type { WalletAuthService } from '../modules/ingestion/wallet-auth-service.js';
import type { FootprintOrchestrationService } from '../modules/ingestion/footprint-orchestration.js';
import type { StateStore } from '../modules/storage/state-store.js';

export interface AppDependencies {
  env: AppEnv;
  publicKeyProvider?: () => Promise<string> | string;
  authService?: AuthService;
  decryptionService?: DecryptionService;
  footprintOrchestrationService?: Pick<
    FootprintOrchestrationService,
    'ingestDecryptedPayload'
  >;
  stateStore?: StateStore;
  walletAuthService?: WalletAuthService;
  requestIdProvider?: () => string;
}

const walletAuthChallengeRequestSchema = z.object({
  walletAddress: z.string().trim().min(32).max(64),
});

const walletAuthVerifyRequestSchema = z.object({
  challengeId: z.string().uuid(),
  walletAddress: z.string().trim().min(32).max(64),
  signature: z.string().trim().min(1),
});

function buildPublicKeyProvider(
  dependencies: AppDependencies,
): () => Promise<string> {
  const fallback = 'UNCONFIGURED_PUBLIC_KEY';

  return async () => {
    if (!dependencies.publicKeyProvider) {
      return fallback;
    }

    return await dependencies.publicKeyProvider();
  };
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  const publicKeyProvider = buildPublicKeyProvider(dependencies);
  const requestIdProvider = dependencies.requestIdProvider ?? createRequestId;
  const decryptionService = dependencies.decryptionService;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(
    cors({
      origin: 'http://127.0.0.1:4173',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      credentials: true,
    }),
  );

  const ingestEncryptedPayload = async (
    request: express.Request,
    response: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const parsed = encryptedRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          'invalid_encrypted_request',
          400,
          'Request body does not match the encrypted payload contract.',
        );
      }

      if (!decryptionService || !dependencies.footprintOrchestrationService) {
        throw new AppError(
          'ingestion_unavailable',
          503,
          'Encrypted ingestion service is not configured.',
        );
      }

      const decrypted = decryptionService.decryptRequest(parsed.data);
      const requestId = requestIdProvider();
      const result =
        await dependencies.footprintOrchestrationService.ingestDecryptedPayload(
          decrypted,
          response.locals.authContext ??
            (() => {
              throw new AppError(
                'missing_auth_context',
                500,
                'Authenticated request context is missing.',
              );
            })(),
          requestId,
        );

      response.status(202).json({
        ...result,
        dataHash: parsed.data.dataHash,
      });
    } catch (error) {
      next(error);
    }
  };

  app.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      service: 'green-reputation-backend',
      environment: dependencies.env.NODE_ENV,
    });
  });

  app.get('/v1/crypto/public-key', async (_request, response, next) => {
    try {
      const publicKeyPem = await publicKeyProvider();
      response.json({ publicKeyPem });
    } catch (error) {
      next(error);
    }
  });

  if (dependencies.stateStore) {
    app.get('/v1/jobs/:jobId', (request, response, next) => {
      try {
        const jobId = Number.parseInt(request.params.jobId, 10);
        if (!Number.isInteger(jobId) || jobId <= 0) {
          throw new AppError(
            'invalid_job_id',
            400,
            'Job id must be a positive integer.',
          );
        }

        const job = dependencies.stateStore?.findOracleJobById(jobId);
        if (!job) {
          throw new AppError('job_not_found', 404, 'Job not found.');
        }

        response.json({
          job: {
            id: job.id,
            kind: job.kind,
            status: job.status,
            runAfterMs: job.runAfterMs,
            completedAtMs: job.completedAtMs,
            lastErrorCode: job.lastErrorCode,
            lastErrorMessage: job.lastErrorMessage,
          },
        });
      } catch (error) {
        next(error);
      }
    });
  }

  if (dependencies.walletAuthService) {
    const walletAuthService = dependencies.walletAuthService;

    app.post('/v1/siws/challenge', async (request, response, next) => {
      try {
        const parsed = walletAuthChallengeRequestSchema.safeParse(
          request.body ?? {},
        );
        if (!parsed.success) {
          throw new AppError(
            'invalid_wallet_auth_request',
            400,
            'Wallet auth request body is invalid.',
          );
        }

        const challenge = await walletAuthService.issueChallenge({
          walletAddress: parsed.data.walletAddress,
        });

        response.status(201).json(challenge);
      } catch (error) {
        next(error);
      }
    });

    app.post('/v1/siws/verify', async (request, response, next) => {
      try {
        const parsed = walletAuthVerifyRequestSchema.safeParse(
          request.body ?? {},
        );
        if (!parsed.success) {
          throw new AppError(
            'invalid_wallet_auth_verify_request',
            400,
            'Wallet auth verification request body is invalid.',
          );
        }

        const token = await walletAuthService.verifyChallenge(parsed.data);

        response.status(201).json(token);
      } catch (error) {
        next(error);
      }
    });
  }

  if (
    dependencies.authService &&
    dependencies.stateStore &&
    decryptionService
  ) {
    app.post(
      '/v1/ingestion/decrypt',
      authenticateSiws({
        authService: dependencies.authService,
        stateStore: dependencies.stateStore,
      }),
      ingestEncryptedPayload,
    );

    app.post(
      '/v1/footprints/ingest',
      authenticateSiws({
        authService: dependencies.authService,
        stateStore: dependencies.stateStore,
      }),
      ingestEncryptedPayload,
    );
  }

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      const statusCode = isAppError(error) ? error.statusCode : 500;
      const code = isAppError(error) ? error.code : 'internal_error';
      const message = isAppError(error)
        ? error.message
        : 'Internal Server Error';

      response.status(statusCode).json({
        error: {
          code,
          message,
        },
      });
    },
  );

  return app;
}
