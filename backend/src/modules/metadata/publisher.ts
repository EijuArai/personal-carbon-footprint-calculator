import crypto from 'node:crypto';

import type { CommitmentPreimageV1 } from '../lca/index.js';

export interface PublicProfileSnapshot {
  displayAlias: string;
  countryCode: string;
  avatarUri: string;
}

export interface AggregateStateSnapshot {
  totalEmissionsKgCo2e: number;
  totalReductionsKgCo2e: number;
  pendingRewardLamports: bigint;
  rank: string;
  latestPeriodKey?: string;
}

export interface MetadataDocumentV1 {
  schemaVersion: 'green-reputation-metadata@v1';
  profile: PublicProfileSnapshot;
  aggregateState: {
    totalEmissionsKgCo2e: number;
    totalReductionsKgCo2e: number;
    pendingRewardLamports: string;
    rank: string;
    latestPeriodKey?: string;
  };
  latestCommitment: CommitmentPreimageV1;
}

export interface PublishMetadataResult {
  uri: string;
  metadataVersion: number;
  metadataUriHash: Uint8Array;
}

export interface MetadataStorageProvider {
  putObject(
    key: string,
    body: string,
  ): Promise<{ uri: string }> | { uri: string };
}

export interface MetadataPublisher {
  buildMetadataDocument(
    profile: PublicProfileSnapshot,
    aggregateState: AggregateStateSnapshot,
    latestCommitment: CommitmentPreimageV1,
  ): MetadataDocumentV1;
  publishMetadata(
    document: MetadataDocumentV1,
    metadataVersion: number,
  ): Promise<PublishMetadataResult>;
}

export class JsonMetadataPublisher implements MetadataPublisher {
  readonly #storageProvider: MetadataStorageProvider;

  constructor(storageProvider: MetadataStorageProvider) {
    this.#storageProvider = storageProvider;
  }

  buildMetadataDocument(
    profile: PublicProfileSnapshot,
    aggregateState: AggregateStateSnapshot,
    latestCommitment: CommitmentPreimageV1,
  ): MetadataDocumentV1 {
    return {
      schemaVersion: 'green-reputation-metadata@v1',
      profile,
      aggregateState: {
        totalEmissionsKgCo2e: aggregateState.totalEmissionsKgCo2e,
        totalReductionsKgCo2e: aggregateState.totalReductionsKgCo2e,
        pendingRewardLamports: aggregateState.pendingRewardLamports.toString(),
        rank: aggregateState.rank,
        ...(aggregateState.latestPeriodKey === undefined
          ? {}
          : { latestPeriodKey: aggregateState.latestPeriodKey }),
      },
      latestCommitment,
    };
  }

  async publishMetadata(
    document: MetadataDocumentV1,
    metadataVersion: number,
  ): Promise<PublishMetadataResult> {
    const body = JSON.stringify(document);
    const digest = crypto.createHash('sha256').update(body).digest();
    const key = `${digest.toString('hex')}.json`;
    const uploaded = await this.#storageProvider.putObject(key, body);

    return {
      uri: uploaded.uri,
      metadataVersion,
      metadataUriHash: new Uint8Array(
        crypto.createHash('sha256').update(uploaded.uri).digest(),
      ),
    };
  }
}

export class InMemoryMetadataStorageProvider implements MetadataStorageProvider {
  readonly objects = new Map<string, string>();
  readonly #baseUri: string;

  constructor(baseUri = 'http://localhost:8000/metadata') {
    this.#baseUri = baseUri.replace(/\/$/, '');
  }

  putObject(key: string, body: string): { uri: string } {
    this.objects.set(key, body);
    return { uri: `${this.#baseUri}/${key}` };
  }
}
