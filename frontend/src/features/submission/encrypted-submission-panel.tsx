import { useEffect, useMemo, useState } from "react";

import {
  Alert,
  Button,
  Chip,
  Divider,
  Grid,
  Paper,
  Stack,
  Typography,
} from "@mui/material";

import type {
  AuthTokenProvider,
  DecryptedFootprintSubmission,
  EncryptedIngestionApi,
  FootprintIngestionResult,
  JobStatusProvider,
  JobStatusSnapshot,
  PublicProfile,
  RawLcaRequest,
  VerifiedSubmissionSnapshot,
} from "../../lib/domain";
import {
  createReviewedSubmissionDraft,
  createInitialSubmissionFlowState,
  deriveFeedbackTone,
  hasSubmittedToday,
  markSubmissionFailed,
  markSubmissionStarted,
  markSubmissionSucceeded,
  readStoredVerifiedSnapshot,
} from "../../lib/domain";
import { useWalletFlow } from "../wallet/wallet-flow-provider";

export interface SubmissionWorkspaceSnapshot {
  payloadPreview: RawLcaRequest;
  activityEntryCount: number;
  spendEntryCount: number;
  uploadedArtifactCount: number;
}

interface EncryptedSubmissionPanelProps {
  workspaceSnapshot: SubmissionWorkspaceSnapshot;
  authTokenProvider: AuthTokenProvider;
  ingestionApi: EncryptedIngestionApi;
  jobStatusProvider: JobStatusProvider;
  runtimeNote?: string;
  onVerifiedSnapshotChange?: (
    snapshot: VerifiedSubmissionSnapshot | undefined,
  ) => void;
}

function formatJobLabel(job: {
  id: number;
  kind: string;
  status: string;
}): string {
  return `${job.kind} #${job.id}: ${job.status}`;
}

function buildReviewedSubmission(input: {
  walletAddress: string;
  publicProfile: PublicProfile;
  payloadPreview: RawLcaRequest;
  currentMetadataVersion?: number;
  aggregateStateHint?: {
    totalEmissionsKgCo2e: number;
    totalReductionsKgCo2e: number;
    pendingRewardLamports: bigint;
  };
}): DecryptedFootprintSubmission {
  const draftInput: {
    userPubkey: string;
    publicProfile: PublicProfile;
    currentMetadataVersion?: number;
    aggregateStateHint?: {
      totalEmissionsKgCo2e: number;
      totalReductionsKgCo2e: number;
      pendingRewardLamports: bigint;
    };
  } = {
    userPubkey: input.walletAddress,
    publicProfile: input.publicProfile,
  };

  if (typeof input.currentMetadataVersion === "number") {
    draftInput.currentMetadataVersion = input.currentMetadataVersion;
  }

  if (input.aggregateStateHint) {
    draftInput.aggregateStateHint = input.aggregateStateHint;
  }

  const draft = createReviewedSubmissionDraft(draftInput);

  return {
    ...draft,
    lca: input.payloadPreview,
  };
}

export function EncryptedSubmissionPanel({
  workspaceSnapshot,
  authTokenProvider,
  ingestionApi,
  jobStatusProvider,
  runtimeNote = "Your private data will never be stored Solana on-chain or in our backend.",
  onVerifiedSnapshotChange,
}: EncryptedSubmissionPanelProps) {
  const { connectionState, profileSnapshot } = useWalletFlow();
  const [submissionState, setSubmissionState] = useState(
    createInitialSubmissionFlowState,
  );
  const [jobStatuses, setJobStatuses] = useState<
    Record<number, JobStatusSnapshot>
  >({});
  const connectedWalletAddress =
    profileSnapshot?.walletAddress ?? connectionState.walletAddress;
  const activeVerifiedSnapshot = useMemo(
    () =>
      submissionState.verifiedSnapshot ??
      readStoredVerifiedSnapshot(connectedWalletAddress),
    [connectedWalletAddress, submissionState.verifiedSnapshot],
  );
  const isDailySubmissionLocked = hasSubmittedToday(activeVerifiedSnapshot);
  // const isDailySubmissionLocked = false; // TODO: re-enable daily submission lock after testing

  const canSubmit = useMemo(() => {
    return (
      connectionState.phase === "connected" &&
      Boolean(connectionState.walletAddress) &&
      Boolean(profileSnapshot?.publicProfile) &&
      !isDailySubmissionLocked &&
      (workspaceSnapshot.activityEntryCount > 0 ||
        workspaceSnapshot.spendEntryCount > 0)
    );
  }, [
    connectionState.phase,
    connectionState.walletAddress,
    isDailySubmissionLocked,
    profileSnapshot?.publicProfile,
    workspaceSnapshot.activityEntryCount,
    workspaceSnapshot.spendEntryCount,
  ]);

  const latestResult: FootprintIngestionResult | undefined =
    submissionState.verifiedSnapshot
      ? {
          subject: submissionState.reviewedSubmission?.userPubkey ?? "",
          nonce: "",
          requestId: submissionState.verifiedSnapshot.requestId,
          aggregateResult: {
            totalEmissionsKgCo2e:
              submissionState.verifiedSnapshot.totalEmissionsKgCo2e,
            baseReductionKgCo2e:
              submissionState.verifiedSnapshot.baseReductionKgCo2e,
            finalRewards: submissionState.verifiedSnapshot.finalRewards,
            multiplierApplied:
              submissionState.verifiedSnapshot.multiplierApplied,
            dataSourceKind: "hybrid",
            categories: submissionState.verifiedSnapshot.categories,
          },
          metadata: {
            uri: submissionState.verifiedSnapshot.metadataUri,
            metadataVersion: submissionState.verifiedSnapshot.metadataVersion,
          },
          jobs: [],
          dataHash: submissionState.verifiedSnapshot.dataHash,
        }
      : undefined;

  async function submitForScoring() {
    if (isDailySubmissionLocked) {
      setSubmissionState((current) =>
        markSubmissionFailed(
          current,
          "You can submit environmental activity data only once per day.",
        ),
      );
      return;
    }

    if (
      connectionState.phase !== "connected" ||
      !connectionState.walletAddress ||
      !profileSnapshot?.publicProfile
    ) {
      setSubmissionState((current) =>
        markSubmissionFailed(
          current,
          "Connect a wallet and register a public profile first.",
        ),
      );
      return;
    }

    const reviewedSubmission = buildReviewedSubmission({
      walletAddress: connectionState.walletAddress,
      publicProfile: profileSnapshot.publicProfile,
      payloadPreview: workspaceSnapshot.payloadPreview,
      ...(profileSnapshot.metadataVersion === undefined
        ? {}
        : { currentMetadataVersion: profileSnapshot.metadataVersion }),
      aggregateStateHint: {
        totalEmissionsKgCo2e: profileSnapshot.totalEmissionsKgCo2e ?? 0,
        totalReductionsKgCo2e: profileSnapshot.totalReductionsKgCo2e ?? 0,
        pendingRewardLamports: profileSnapshot.pendingRewardLamports ?? 0n,
      },
    });

    setSubmissionState((current) => ({
      ...markSubmissionStarted(current),
      reviewedSubmission,
    }));

    try {
      await authTokenProvider.getAuthToken();
      const result =
        await ingestionApi.submitEncryptedFootprint(reviewedSubmission);
      setSubmissionState((current) =>
        markSubmissionSucceeded(
          { ...current, reviewedSubmission },
          result,
          new Date().toISOString(),
        ),
      );
      setJobStatuses(
        Object.fromEntries(
          result.jobs.map((job) => [
            job.id,
            { jobId: job.id, kind: job.kind, status: job.status },
          ]),
        ),
      );
    } catch (error) {
      setSubmissionState((current) => ({
        ...markSubmissionFailed(
          current,
          error instanceof Error
            ? error.message
            : "Encrypted submission failed.",
        ),
        reviewedSubmission,
      }));
    }
  }

  async function refreshJob(jobId: number) {
    try {
      const snapshot = await jobStatusProvider.getJobStatus(jobId);
      setJobStatuses((current) => ({
        ...current,
        [jobId]: snapshot,
      }));
    } catch (error) {
      setSubmissionState((current) =>
        markSubmissionFailed(
          current,
          error instanceof Error ? error.message : "Job refresh failed.",
        ),
      );
    }
  }

  const feedbackTone = latestResult
    ? deriveFeedbackTone(latestResult.aggregateResult.multiplierApplied)
    : undefined;

  const exportedVerifiedSnapshot = useMemo(() => {
    if (!submissionState.verifiedSnapshot) {
      return undefined;
    }

    if (
      connectionState.phase !== "connected" ||
      !connectionState.walletAddress
    ) {
      return undefined;
    }

    const submissionWalletAddress =
      submissionState.reviewedSubmission?.userPubkey;
    if (
      submissionWalletAddress &&
      submissionWalletAddress !== connectionState.walletAddress
    ) {
      return undefined;
    }

    return submissionState.verifiedSnapshot;
  }, [
    connectionState.phase,
    connectionState.walletAddress,
    submissionState.reviewedSubmission?.userPubkey,
    submissionState.verifiedSnapshot,
  ]);

  useEffect(() => {
    onVerifiedSnapshotChange?.(exportedVerifiedSnapshot);
  }, [exportedVerifiedSnapshot, onVerifiedSnapshotChange]);

  return (
    <Stack spacing={3}>
      <Stack spacing={1.5}>
        <Typography variant="h2">
          Encrypt and submit your environmental activity to Solana!
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ maxWidth: 760 }}
        >
          Private source images and raw OCR text remain outside the encrypted
          payload and the public feedback surface.
        </Typography>
      </Stack>

      {submissionState.lastError ? (
        <Alert severity="error">{submissionState.lastError}</Alert>
      ) : null}

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, lg: 5 }}>
          <Paper
            elevation={0}
            sx={{
              p: 3,
              borderRadius: 5,
              border: "1px solid",
              borderColor: "divider",
            }}
          >
            <Stack spacing={2}>
              <Typography variant="h3">Submission readiness</Typography>
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                <Chip
                  label={`${workspaceSnapshot.activityEntryCount} activity entries`}
                  variant="outlined"
                />
                <Chip
                  label={`${workspaceSnapshot.spendEntryCount} spend entries`}
                  variant="outlined"
                />
                <Chip
                  label={`${workspaceSnapshot.uploadedArtifactCount} private artifacts`}
                  variant="outlined"
                />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Wallet: {connectionState.walletAddress ?? "not connected"}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Profile:{" "}
                {profileSnapshot?.publicProfile?.displayAlias ??
                  "not registered"}
              </Typography>
              {isDailySubmissionLocked ? (
                <Alert severity="info">
                  Today&apos;s submission is already complete. You can submit
                  the next update tomorrow.
                </Alert>
              ) : null}
              <Button
                variant="contained"
                size="large"
                onClick={() => void submitForScoring()}
                disabled={!canSubmit || submissionState.stage === "submitting"}
              >
                {submissionState.stage === "submitting"
                  ? "Encrypting and submitting..."
                  : "Submit Encrypted Footprint"}
              </Button>
              <Typography variant="caption" color="text.secondary">
                {runtimeNote}
              </Typography>
            </Stack>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, lg: 7 }}>
          <Stack spacing={3}>
            <Paper
              elevation={0}
              sx={{
                p: 3,
                borderRadius: 5,
                border: "1px solid",
                borderColor: "divider",
              }}
            >
              <Stack spacing={2}>
                <Typography variant="h3">Aggregate scoring feedback</Typography>
                {latestResult ? (
                  <>
                    <Stack
                      direction="row"
                      spacing={1}
                      useFlexGap
                      flexWrap="wrap"
                    >
                      <Chip
                        label={`Tone: ${feedbackTone}`}
                        color={
                          feedbackTone === "bonus"
                            ? "success"
                            : feedbackTone === "penalty"
                              ? "warning"
                              : "default"
                        }
                      />
                      <Chip
                        label={`Data hash: ${latestResult.dataHash.slice(0, 12)}...`}
                        variant="outlined"
                      />
                      <Chip
                        label={`Metadata v${latestResult.metadata.metadataVersion}`}
                        variant="outlined"
                      />
                    </Stack>
                    <Grid container spacing={2}>
                      <Grid size={{ xs: 12, md: 4 }}>
                        <Paper
                          elevation={0}
                          sx={{
                            p: 2,
                            borderRadius: 4,
                            bgcolor: "rgba(8,56,28,0.04)",
                          }}
                        >
                          <Typography variant="caption" color="text.secondary">
                            Total emissions
                          </Typography>
                          <Typography variant="h3">
                            {latestResult.aggregateResult.totalEmissionsKgCo2e}{" "}
                            kg
                          </Typography>
                        </Paper>
                      </Grid>
                      <Grid size={{ xs: 12, md: 4 }}>
                        <Paper
                          elevation={0}
                          sx={{
                            p: 2,
                            borderRadius: 4,
                            bgcolor: "rgba(8,56,28,0.04)",
                          }}
                        >
                          <Typography variant="caption" color="text.secondary">
                            Base reduction
                          </Typography>
                          <Typography variant="h3">
                            {latestResult.aggregateResult.baseReductionKgCo2e}{" "}
                            kg
                          </Typography>
                        </Paper>
                      </Grid>
                      <Grid size={{ xs: 12, md: 4 }}>
                        <Paper
                          elevation={0}
                          sx={{
                            p: 2,
                            borderRadius: 4,
                            bgcolor: "rgba(8,56,28,0.04)",
                          }}
                        >
                          <Typography variant="caption" color="text.secondary">
                            Final rewards
                          </Typography>
                          <Typography variant="h3">
                            {latestResult.aggregateResult.finalRewards}
                          </Typography>
                        </Paper>
                      </Grid>
                    </Grid>
                    <Typography variant="body2" color="text.secondary">
                      Multiplier:{" "}
                      {latestResult.aggregateResult.multiplierApplied} |
                      Categories:{" "}
                      {latestResult.aggregateResult.categories.join(", ") ||
                        "none"}
                    </Typography>
                  </>
                ) : (
                  <Alert severity="info">
                    No verified aggregate result yet. Submit the reviewed
                    payload to generate scoring feedback.
                  </Alert>
                )}
              </Stack>
            </Paper>

            <Paper
              elevation={0}
              sx={{
                p: 3,
                borderRadius: 5,
                border: "1px solid",
                borderColor: "divider",
              }}
            >
              <Stack spacing={2}>
                <Typography variant="h3">Job Status</Typography>
                <Typography variant="body2" color="text.secondary">
                  You can check the status of your submission.
                </Typography>
                <Divider />
                <Stack spacing={1.5}>
                  {Object.values(jobStatuses).length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      No backend jobs tracked yet.
                    </Typography>
                  ) : (
                    Object.values(jobStatuses).map((job) => (
                      <Stack
                        key={job.jobId}
                        direction={{ xs: "column", md: "row" }}
                        spacing={1.5}
                        justifyContent="space-between"
                      >
                        <Chip
                          label={formatJobLabel({
                            id: job.jobId,
                            kind: job.kind,
                            status: job.status,
                          })}
                          color={
                            job.status === "completed"
                              ? "success"
                              : job.status === "failed"
                                ? "warning"
                                : "default"
                          }
                        />
                        <Button
                          variant="text"
                          onClick={() => void refreshJob(job.jobId)}
                        >
                          Refresh job status
                        </Button>
                      </Stack>
                    ))
                  )}
                </Stack>
              </Stack>
            </Paper>
          </Stack>
        </Grid>
      </Grid>
    </Stack>
  );
}
