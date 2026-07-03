import type {
  AuthTokenProvider,
  DecryptedFootprintSubmission,
  EncryptedIngestionApi,
  JobStatusProvider,
  JobStatusSnapshot,
} from "../domain";
import {
  parseApiErrorEnvelope,
  parseFootprintIngestionResult,
  toApiErrorMessage,
} from "../domain";
import { encryptSubmissionPayload } from "../crypto/browser-hybrid-encryption";

interface CreateFetchEncryptedIngestionApiOptions {
  authTokenProvider: AuthTokenProvider;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
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

export function createFetchEncryptedIngestionApi(
  options: CreateFetchEncryptedIngestionApiOptions,
): EncryptedIngestionApi & JobStatusProvider {
  const baseUrl = options.baseUrl ?? "http://localhost:3000";
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async fetchPublicKeyPem() {
      const response = await fetchImpl(
        buildUrl(baseUrl, "/v1/crypto/public-key"),
        {
          method: "GET",
        },
      );

      const payload = await parseJsonSafely(response);
      if (!response.ok) {
        throw new Error(toApiErrorMessage(parseApiErrorEnvelope(payload)));
      }

      const publicKeyPem = (payload as { publicKeyPem?: string } | undefined)
        ?.publicKeyPem;
      if (!publicKeyPem) {
        throw new Error("Backend public key is missing from the response.");
      }

      return publicKeyPem;
    },
    async submitEncryptedFootprint(payload: DecryptedFootprintSubmission) {
      const bearerToken = await options.authTokenProvider.getAuthToken();
      const publicKeyPem = await this.fetchPublicKeyPem();
      const encryptedRequest = await encryptSubmissionPayload(
        payload,
        publicKeyPem,
      );

      const response = await fetchImpl(
        buildUrl(baseUrl, "/v1/footprints/ingest"),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(encryptedRequest),
        },
      );

      const responseBody = await parseJsonSafely(response);
      if (!response.ok) {
        throw new Error(toApiErrorMessage(parseApiErrorEnvelope(responseBody)));
      }

      return parseFootprintIngestionResult(responseBody);
    },
    async getJobStatus(jobId: number): Promise<JobStatusSnapshot> {
      const response = await fetchImpl(buildUrl(baseUrl, `/v1/jobs/${jobId}`), {
        method: "GET",
      });
      const responseBody = await parseJsonSafely(response);

      if (!response.ok) {
        throw new Error(toApiErrorMessage(parseApiErrorEnvelope(responseBody)));
      }

      const job = (
        responseBody as
          | {
              job?: {
                id?: number;
                kind?: JobStatusSnapshot["kind"];
                status?: JobStatusSnapshot["status"];
                lastErrorCode?: string;
                lastErrorMessage?: string;
              };
            }
          | undefined
      )?.job;
      if (!job || job.id === undefined || !job.kind || !job.status) {
        throw new Error("Job status payload is missing.");
      }

      return {
        jobId: job.id,
        kind: job.kind,
        status: job.status,
        ...(job.lastErrorCode ? { lastErrorCode: job.lastErrorCode } : {}),
        ...(job.lastErrorMessage
          ? { lastErrorMessage: job.lastErrorMessage }
          : {}),
      };
    },
  };
}
