import type {
  ActivityCategory,
  ActivityEntry,
  ActivityUnit,
  OcrReviewCandidate,
  RawLcaRequest,
  SpendCategory,
  SpendEntry,
} from "../../lib/domain";

export type UploadKind = "receipt" | "card-screenshot";
type LocalIdPrefix = "activity" | UploadKind | "review-spend";

export interface UploadedSourceArtifact {
  artifactId: string;
  kind: UploadKind;
  fileName: string;
  mimeType: string;
}

export interface ReviewRow {
  rowId: string;
  artifactId: string;
  sourceKind: UploadKind;
  label: string;
  confidence: number;
  category: SpendCategory;
  amount: number;
  proofHash: string;
}

export interface InputWorkspaceState {
  activityEntries: ActivityEntry[];
  reviewRows: ReviewRow[];
  uploadedArtifacts: UploadedSourceArtifact[];
  rawOcrArtifacts: Array<{ artifactId: string; rawText: string }>;
  idCounters: Record<LocalIdPrefix, number>;
}

function createScopedLocalId(
  counters: Record<LocalIdPrefix, number>,
  prefix: LocalIdPrefix,
): { id: string; counters: Record<LocalIdPrefix, number> } {
  const nextValue = counters[prefix] + 1;

  return {
    id: `${prefix}-${nextValue}`,
    counters: {
      ...counters,
      [prefix]: nextValue,
    },
  };
}

export function createInputWorkspaceState(): InputWorkspaceState {
  return {
    activityEntries: [],
    reviewRows: [],
    uploadedArtifacts: [],
    rawOcrArtifacts: [],
    idCounters: {
      activity: 0,
      receipt: 0,
      "card-screenshot": 0,
      "review-spend": 0,
    },
  };
}

export function addActivityEntry(
  state: InputWorkspaceState,
  input: {
    category: ActivityCategory;
    value: number;
    unit: ActivityUnit;
    isRenewable?: boolean;
  },
): InputWorkspaceState {
  const nextActivityId = createScopedLocalId(state.idCounters, "activity");
  const nextEntry: ActivityEntry = {
    activityId: nextActivityId.id,
    category: input.category,
    value: input.value,
    unit: input.unit,
    source: "manual",
    ...(input.isRenewable === undefined
      ? {}
      : { isRenewable: input.isRenewable }),
  };

  return {
    ...state,
    activityEntries: [...state.activityEntries, nextEntry],
    idCounters: nextActivityId.counters,
  };
}

export function registerUploadedArtifact(
  state: InputWorkspaceState,
  input: { kind: UploadKind; fileName: string; mimeType: string },
): { state: InputWorkspaceState; artifact: UploadedSourceArtifact } {
  const nextArtifactId = createScopedLocalId(state.idCounters, input.kind);
  const artifact: UploadedSourceArtifact = {
    artifactId: nextArtifactId.id,
    kind: input.kind,
    fileName: input.fileName,
    mimeType: input.mimeType,
  };

  return {
    artifact,
    state: {
      ...state,
      uploadedArtifacts: [...state.uploadedArtifacts, artifact],
      idCounters: nextArtifactId.counters,
    },
  };
}

export function attachOcrReviewRows(
  state: InputWorkspaceState,
  input: {
    artifact: UploadedSourceArtifact;
    rawText: string;
    candidates: OcrReviewCandidate[];
  },
): InputWorkspaceState {
  let nextCounters = state.idCounters;
  const reviewRows = input.candidates.map((candidate) => {
    const nextReviewRowId = createScopedLocalId(nextCounters, "review-spend");
    nextCounters = nextReviewRowId.counters;

    return candidateToReviewRow(candidate, input.artifact, nextReviewRowId.id);
  });

  return {
    ...state,
    reviewRows: [
      ...state.reviewRows.filter(
        (row) => row.artifactId !== input.artifact.artifactId,
      ),
      ...reviewRows,
    ],
    rawOcrArtifacts: [
      ...state.rawOcrArtifacts.filter(
        (artifact) => artifact.artifactId !== input.artifact.artifactId,
      ),
      {
        artifactId: input.artifact.artifactId,
        rawText: input.rawText,
      },
    ],
    idCounters: nextCounters,
  };
}

export function updateReviewRow(
  state: InputWorkspaceState,
  rowId: string,
  updates: Partial<
    Omit<ReviewRow, "rowId" | "artifactId" | "sourceKind" | "proofHash">
  >,
): InputWorkspaceState {
  return {
    ...state,
    reviewRows: state.reviewRows.map((row) =>
      row.rowId === rowId ? { ...row, ...updates } : row,
    ),
  };
}

export function removeReviewRow(
  state: InputWorkspaceState,
  rowId: string,
): InputWorkspaceState {
  return {
    ...state,
    reviewRows: state.reviewRows.filter((row) => row.rowId !== rowId),
  };
}

export function buildRawLcaRequestFromWorkspace(
  state: InputWorkspaceState,
): RawLcaRequest {
  const spendEntries: SpendEntry[] = state.reviewRows.map((row) => ({
    spendId: row.rowId,
    category: row.category,
    amount: row.amount,
    source: "ocr",
    proofHash: row.proofHash,
  }));

  return {
    spendEntries,
    activityEntries: state.activityEntries,
    history: {
      pastAverageMonthlyEmissions: 0,
    },
  };
}

export function summarizeWorkspace(state: InputWorkspaceState) {
  return {
    activityEntryCount: state.activityEntries.length,
    spendEntryCount: state.reviewRows.length,
    uploadedArtifactCount: state.uploadedArtifacts.length,
    reviewRowCount: state.reviewRows.length,
    lowConfidenceCount: state.reviewRows.filter((row) => row.confidence < 0.7)
      .length,
  };
}

function candidateToReviewRow(
  candidate: OcrReviewCandidate,
  artifact: UploadedSourceArtifact,
  rowId: string,
): ReviewRow {
  return {
    rowId,
    artifactId: artifact.artifactId,
    sourceKind: artifact.kind,
    label: candidate.label,
    confidence: candidate.confidence,
    category:
      (candidate.proposedCategory as SpendCategory | undefined) ?? "Vegetables",
    amount: candidate.proposedAmount ?? candidate.proposedValue ?? 0,
    proofHash: `local-proof:${artifact.artifactId}`,
  };
}
