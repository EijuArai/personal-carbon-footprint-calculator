import crypto from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

import { AppError } from '../../lib/app-error.js';
import logger from '../../utils/logger.js';

export interface AuthContext {
  issuer: string;
  audience: string;
  subject: string;
  nonce: string;
  expiresAtMs: number;
}

export interface AuthService {
  verifyBearerToken(token: string): Promise<AuthContext> | AuthContext;
}

export interface CreateAuthServiceOptions {
  issuer: string;
  audience: string;
  sharedSecret: string;
}

export interface IssueDevIngestTokenInput {
  subject?: string;
}

export interface IssuedDevIngestToken {
  token: string;
  issuer: string;
  audience: string;
  subject: string;
  nonce: string;
  expiresAtMs: number;
}

export interface DevIngestTokenIssuer {
  issueToken(
    input?: IssueDevIngestTokenInput,
  ): Promise<IssuedDevIngestToken> | IssuedDevIngestToken;
}

export interface CreateDevIngestTokenIssuerOptions extends CreateAuthServiceOptions {
  ttlSeconds: number;
  defaultSubject?: string;
  now?: () => number;
}

export class HmacJwtAuthService implements AuthService {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #sharedSecret: Uint8Array;

  constructor(options: CreateAuthServiceOptions) {
    this.#issuer = options.issuer;
    this.#audience = options.audience;
    this.#sharedSecret = new TextEncoder().encode(options.sharedSecret);
  }

  async verifyBearerToken(token: string): Promise<AuthContext> {
    try {
      const { payload } = await jwtVerify(token, this.#sharedSecret, {
        issuer: this.#issuer,
        audience: this.#audience,
        algorithms: ['HS256'],
      });

      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        logger.error(
          {
            payload,
          },
          'JWT payload is missing subject claim',
        );
        throw new AppError(
          'invalid_token_subject',
          401,
          'JWT subject is required.',
        );
      }

      if (typeof payload.nonce !== 'string' || payload.nonce.length === 0) {
        logger.error(
          {
            payload,
          },
          'JWT payload is missing nonce claim',
        );
        throw new AppError(
          'invalid_token_nonce',
          401,
          'JWT nonce is required.',
        );
      }

      if (typeof payload.exp !== 'number') {
        logger.error(
          {
            payload,
          },
          'JWT payload is missing exp claim',
        );
        throw new AppError('invalid_token_exp', 401, 'JWT expiry is required.');
      }

      return {
        issuer: this.#issuer,
        audience: this.#audience,
        subject: payload.sub,
        nonce: payload.nonce,
        expiresAtMs: payload.exp * 1000,
      };
    } catch (error) {
      if (error instanceof AppError) {
        logger.error(
          {
            token,
            error,
          },
          'Token verification failed with AppError',
        );
        throw error;
      }

      logger.error(
        {
          token,
          error,
        },
        'Token verification failed with unexpected error',
      );
      throw new AppError('invalid_token', 401, 'JWT verification failed.');
    }
  }
}

export class HmacJwtDevIngestTokenIssuer implements DevIngestTokenIssuer {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #sharedSecret: Uint8Array;
  readonly #ttlSeconds: number;
  readonly #defaultSubject: string;
  readonly #now: (() => number) | undefined;

  constructor(options: CreateDevIngestTokenIssuerOptions) {
    this.#issuer = options.issuer;
    this.#audience = options.audience;
    this.#sharedSecret = new TextEncoder().encode(options.sharedSecret);
    this.#ttlSeconds = options.ttlSeconds;
    this.#defaultSubject = options.defaultSubject?.trim() || 'local-e2e-user';
    this.#now = options.now;
  }

  async issueToken(
    input: IssueDevIngestTokenInput = {},
  ): Promise<IssuedDevIngestToken> {
    const subject = input.subject?.trim() || this.#defaultSubject;
    if (!subject) {
      throw new AppError(
        'invalid_dev_auth_subject',
        400,
        'Subject is required for dev ingest token issuance.',
      );
    }

    const issuedAtMs = this.#now?.() ?? Date.now();
    const issuedAtSeconds = Math.floor(issuedAtMs / 1000);
    const expiresAtMs = (issuedAtSeconds + this.#ttlSeconds) * 1000;
    const nonce = crypto.randomUUID();
    const token = await new SignJWT({ nonce })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.#issuer)
      .setAudience(this.#audience)
      .setSubject(subject)
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + this.#ttlSeconds)
      .sign(this.#sharedSecret);

    return {
      token,
      issuer: this.#issuer,
      audience: this.#audience,
      subject,
      nonce,
      expiresAtMs,
    };
  }
}

export function extractBearerToken(headerValue: string | undefined): string {
  if (!headerValue) {
    throw new AppError(
      'missing_authorization',
      401,
      'Authorization header is required.',
    );
  }

  const [scheme, token] = headerValue.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AppError(
      'invalid_authorization',
      401,
      'Authorization header must be a Bearer token.',
    );
  }

  return token;
}
