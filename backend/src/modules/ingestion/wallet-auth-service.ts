import crypto from 'node:crypto';

import { PublicKey } from '@solana/web3.js';

import { AppError } from '../../lib/app-error.js';
import {
  HmacJwtDevIngestTokenIssuer,
  type IssuedDevIngestToken,
} from './auth-service.js';

export interface WalletAuthChallenge {
  challengeId: string;
  walletAddress: string;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  message: string;
}

export interface IssueWalletAuthChallengeInput {
  walletAddress: string;
}

export interface VerifyWalletAuthChallengeInput {
  challengeId: string;
  walletAddress: string;
  signature: string;
}

export interface WalletAuthService {
  issueChallenge(
    input: IssueWalletAuthChallengeInput,
  ): Promise<WalletAuthChallenge> | WalletAuthChallenge;
  verifyChallenge(
    input: VerifyWalletAuthChallengeInput,
  ): Promise<IssuedDevIngestToken> | IssuedDevIngestToken;
}

export interface CreateWalletAuthServiceOptions {
  issuer: string;
  audience: string;
  sharedSecret: string;
  challengeTtlSeconds: number;
  tokenTtlSeconds: number;
  now?: () => number;
}

interface StoredWalletAuthChallenge extends WalletAuthChallenge {}

function formatMessage(challenge: StoredWalletAuthChallenge, issuer: string) {
  return [
    'Green Reputation Sign-In With Solana',
    `Issuer: ${issuer}`,
    `Wallet: ${challenge.walletAddress}`,
    `Nonce: ${challenge.nonce}`,
    `Challenge ID: ${challenge.challengeId}`,
    `Issued At: ${new Date(challenge.issuedAtMs).toISOString()}`,
    `Expires At: ${new Date(challenge.expiresAtMs).toISOString()}`,
  ].join('\n');
}

export class InMemoryWalletAuthService implements WalletAuthService {
  readonly #issuer: string;
  readonly #challengeTtlMs: number;
  readonly #now: (() => number) | undefined;
  readonly #tokenIssuer: HmacJwtDevIngestTokenIssuer;
  readonly #challenges = new Map<string, StoredWalletAuthChallenge>();

  constructor(options: CreateWalletAuthServiceOptions) {
    this.#issuer = options.issuer;
    this.#challengeTtlMs = options.challengeTtlSeconds * 1000;
    this.#now = options.now;
    this.#tokenIssuer = new HmacJwtDevIngestTokenIssuer({
      issuer: options.issuer,
      audience: options.audience,
      sharedSecret: options.sharedSecret,
      ttlSeconds: options.tokenTtlSeconds,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  issueChallenge(input: IssueWalletAuthChallengeInput): WalletAuthChallenge {
    const walletAddress = normalizeWalletAddress(input.walletAddress);
    const issuedAtMs = this.#now?.() ?? Date.now();
    const challengeId = crypto.randomUUID();
    const challenge: StoredWalletAuthChallenge = {
      challengeId,
      walletAddress,
      nonce: crypto.randomUUID(),
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.#challengeTtlMs,
      message: '',
    };

    const finalizedChallenge = {
      ...challenge,
      message: formatMessage(challenge, this.#issuer),
    };
    this.#pruneExpiredChallenges(issuedAtMs);
    this.#challenges.set(challengeId, finalizedChallenge);
    return finalizedChallenge;
  }

  async verifyChallenge(
    input: VerifyWalletAuthChallengeInput,
  ): Promise<IssuedDevIngestToken> {
    const walletAddress = normalizeWalletAddress(input.walletAddress);
    const challenge = this.#challenges.get(input.challengeId);

    if (!challenge) {
      throw new AppError(
        'wallet_auth_challenge_not_found',
        404,
        'Wallet auth challenge was not found.',
      );
    }

    const nowMs = this.#now?.() ?? Date.now();
    if (challenge.expiresAtMs < nowMs) {
      this.#challenges.delete(challenge.challengeId);
      throw new AppError(
        'wallet_auth_challenge_expired',
        401,
        'Wallet auth challenge has expired.',
      );
    }

    if (challenge.walletAddress !== walletAddress) {
      throw new AppError(
        'wallet_auth_wallet_mismatch',
        401,
        'Wallet address does not match the issued auth challenge.',
      );
    }

    const signatureBytes = decodeBase64(input.signature);
    const messageBytes = new TextEncoder().encode(challenge.message);
    const verified = await verifyWalletSignature(
      walletAddress,
      messageBytes,
      signatureBytes,
    );

    if (!verified) {
      throw new AppError(
        'wallet_auth_signature_invalid',
        401,
        'Wallet signature verification failed.',
      );
    }

    this.#challenges.delete(challenge.challengeId);

    return await this.#tokenIssuer.issueToken({ subject: walletAddress });
  }

  #pruneExpiredChallenges(nowMs: number) {
    for (const [challengeId, challenge] of this.#challenges.entries()) {
      if (challenge.expiresAtMs < nowMs) {
        this.#challenges.delete(challengeId);
      }
    }
  }
}

function normalizeWalletAddress(walletAddress: string): string {
  const normalized = walletAddress.trim();
  try {
    return new PublicKey(normalized).toBase58();
  } catch {
    throw new AppError(
      'invalid_wallet_address',
      400,
      'Wallet address must be a valid Solana public key.',
    );
  }
}

function decodeBase64(signature: string): Uint8Array {
  try {
    return Uint8Array.from(Buffer.from(signature, 'base64'));
  } catch {
    throw new AppError(
      'invalid_wallet_signature',
      400,
      'Wallet signature must be base64 encoded.',
    );
  }
}

async function verifyWalletSignature(
  walletAddress: string,
  messageBytes: Uint8Array,
  signatureBytes: Uint8Array,
): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    'raw',
    new PublicKey(walletAddress).toBytes(),
    'Ed25519',
    false,
    ['verify'],
  );

  return await crypto.subtle.verify(
    'Ed25519',
    publicKey,
    signatureBytes,
    messageBytes,
  );
}
