import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../lib/app-error.js';
import type {
  AuthContext,
  AuthService,
} from '../modules/ingestion/auth-service.js';
import { extractBearerToken } from '../modules/ingestion/auth-service.js';
import type { StateStore } from '../modules/storage/state-store.js';
import logger from '../utils/logger.js';

export interface AuthenticateSiwsDependencies {
  authService: AuthService;
  stateStore: StateStore;
  now?: () => number;
}

declare module 'express-serve-static-core' {
  interface Locals {
    authContext?: AuthContext;
    requestId?: string;
  }
}

export function authenticateSiws(dependencies: AuthenticateSiwsDependencies) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const token = extractBearerToken(request.header('authorization'));
      const authContext =
        await dependencies.authService.verifyBearerToken(token);

      dependencies.stateStore.reserveNonce({
        nonce: authContext.nonce,
        issuer: authContext.issuer,
        audience: authContext.audience,
        subject: authContext.subject,
        expiresAtMs: authContext.expiresAtMs,
        reservedAtMs: dependencies.now?.() ?? Date.now(),
      });

      response.locals.authContext = authContext;
      logger.info(
        {
          requestId: response.locals.requestId,
          method: request.method,
          path: request.originalUrl,
          subject: authContext.subject,
          nonce: authContext.nonce,
        },
        'SIWS authentication succeeded.',
      );
      next();
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: used_nonces\.nonce/.test(error.message)
      ) {
        logger.error(
          {
            err: error,
            requestId: response.locals.requestId,
            method: request.method,
            path: request.originalUrl,
          },
          'JWT nonce has already been used.',
        );
        next(
          new AppError(
            'replayed_nonce',
            409,
            'JWT nonce has already been used.',
          ),
        );
        return;
      }

      next(error);
    }
  };
}
