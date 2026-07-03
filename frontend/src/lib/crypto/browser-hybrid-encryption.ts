import type { EncryptedRequest } from "../domain";

function encodeUtf8(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function chunkToBinary(value: Uint8Array): string {
  let binary = "";
  for (const chunk of value) {
    binary += String.fromCharCode(chunk);
  }
  return binary;
}

function toBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return btoa(chunkToBinary(bytes));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");

  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

async function importRsaPublicKey(publicKeyPem: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "spki",
    pemToArrayBuffer(publicKeyPem),
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["encrypt"],
  );
}

export async function createSha256Hex(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encodeUtf8(payload));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function encryptSubmissionPayload(payload: unknown, publicKeyPem: string): Promise<EncryptedRequest> {
  const serializedPayload = JSON.stringify(payload, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  const dataHash = await createSha256Hex(serializedPayload);

  const sessionKey = await crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256,
    },
    true,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedPayload = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      tagLength: 128,
    },
    sessionKey,
    encodeUtf8(serializedPayload),
  );

  const encryptedBytes = new Uint8Array(encryptedPayload);
  const authTag = encryptedBytes.slice(encryptedBytes.length - 16);
  const cipherText = encryptedBytes.slice(0, encryptedBytes.length - 16);

  const rawSessionKey = await crypto.subtle.exportKey("raw", sessionKey);
  const importedPublicKey = await importRsaPublicKey(publicKeyPem);
  const encryptedSessionKey = await crypto.subtle.encrypt(
    {
      name: "RSA-OAEP",
    },
    importedPublicKey,
    rawSessionKey,
  );

  return {
    encryptedSessionKey: toBase64(encryptedSessionKey),
    encryptedPayload: toBase64(cipherText),
    iv: toBase64(iv),
    authTag: toBase64(authTag),
    dataHash,
  };
}