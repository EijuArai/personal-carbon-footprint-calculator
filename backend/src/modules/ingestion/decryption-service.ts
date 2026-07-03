import crypto from "node:crypto";

import { AppError } from "../../lib/app-error.js";
import type { EncryptedRequest } from "./encrypted-request.js";

export interface DecryptionService {
  exportPublicKeyPem(): string;
  decryptRequest(request: EncryptedRequest): unknown;
}

export interface CreateDecryptionServiceOptions {
  privateKeyPem?: string;
}

export class BackendDecryptionService implements DecryptionService {
  readonly #privateKey: crypto.KeyObject;
  readonly #publicKey: crypto.KeyObject;

  constructor(options: CreateDecryptionServiceOptions = {}) {
    if (options.privateKeyPem) {
      this.#privateKey = crypto.createPrivateKey(options.privateKeyPem);
      this.#publicKey = crypto.createPublicKey(this.#privateKey);
      return;
    }

    const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.#privateKey = pair.privateKey;
    this.#publicKey = pair.publicKey;
  }

  exportPublicKeyPem(): string {
    return this.#publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  decryptRequest(request: EncryptedRequest): unknown {
    try {
      const sessionKey = crypto.privateDecrypt(
        {
          key: this.#privateKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(request.encryptedSessionKey, "base64"),
      );

      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        sessionKey,
        Buffer.from(request.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(request.authTag, "base64"));

      let decryptedData = decipher.update(request.encryptedPayload, "base64", "utf8");
      decryptedData += decipher.final("utf8");

      const calculatedHash = crypto.createHash("sha256").update(decryptedData).digest("hex");
      if (calculatedHash !== request.dataHash) {
        throw new AppError(
          "invalid_payload_hash",
          400,
          "Encrypted payload integrity verification failed.",
        );
      }

      return JSON.parse(decryptedData) as unknown;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("invalid_encrypted_request", 400, "Encrypted request could not be decrypted.");
    }
  }
}