import type { AuthTokenProvider, WalletProfileAdapter } from "../../lib/domain";
import { parseApiErrorEnvelope, toApiErrorMessage } from "../../lib/domain";

interface CreateBackendDevAuthTokenProviderOptions {
  baseUrl: string;
  walletAdapter: WalletProfileAdapter;
  fetchImpl?: typeof fetch;
}

interface WalletAuthChallengeResponse {
  challengeId: string;
  walletAddress: string;
  message: string;
  expiresAtMs: number;
}

interface WalletAuthVerifyResponse {
  token?: string;
  expiresAtMs?: number;
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function parseJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  return JSON.parse(text) as unknown;
}

export function createBackendDevAuthTokenProvider(
  options: CreateBackendDevAuthTokenProviderOptions,
): AuthTokenProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  let cachedToken:
    | {
        token: string;
        expiresAtMs: number;
      }
    | undefined;

  return {
    async getAuthToken() {
      if (cachedToken && cachedToken.expiresAtMs - Date.now() > 5_000) {
        return cachedToken.token;
      }

      const connectionState = await options.walletAdapter.getConnectionState();
      if (
        connectionState.phase !== "connected" ||
        !connectionState.walletAddress
      ) {
        throw new Error("Connect your Solana wallet before signing in.");
      }

      const challengeResponse = await fetchImpl(
        buildUrl(options.baseUrl, "/v1/siws/challenge"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            walletAddress: connectionState.walletAddress,
          }),
        },
      );
      const challengePayload = await parseJsonSafely(challengeResponse);

      if (!challengeResponse.ok) {
        throw new Error(
          toApiErrorMessage(parseApiErrorEnvelope(challengePayload)),
        );
      }

      const challenge = challengePayload as
        | WalletAuthChallengeResponse
        | undefined;
      if (!challenge?.challengeId || !challenge.message) {
        throw new Error(
          "Wallet auth challenge response is missing challenge data.",
        );
      }

      const signature = await options.walletAdapter.signAuthMessage(
        challenge.message,
      );

      const verifyResponse = await fetchImpl(
        buildUrl(options.baseUrl, "/v1/siws/verify"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            challengeId: challenge.challengeId,
            walletAddress: connectionState.walletAddress,
            signature,
          }),
        },
      );
      const verifyPayload = await parseJsonSafely(verifyResponse);

      if (!verifyResponse.ok) {
        throw new Error(
          toApiErrorMessage(parseApiErrorEnvelope(verifyPayload)),
        );
      }

      const token = (verifyPayload as WalletAuthVerifyResponse | undefined)
        ?.token;
      if (!token) {
        throw new Error(
          "Wallet auth verification response is missing a token.",
        );
      }

      const expiresAtMs =
        (verifyPayload as WalletAuthVerifyResponse | undefined)?.expiresAtMs ??
        Date.now() + 60_000;
      cachedToken = {
        token,
        expiresAtMs,
      };

      if (challenge.walletAddress !== connectionState.walletAddress) {
        cachedToken = undefined;
        throw new Error(
          "Wallet auth challenge returned a mismatched wallet address.",
        );
      }

      return token;
    },
  };
}
