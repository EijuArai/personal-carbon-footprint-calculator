import { useEffect, useMemo, useState } from "react";

import {
  Alert,
  Button,
  Chip,
  Divider,
  Grid,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";

import type {
  ActivityCategory,
  ActivityUnit,
  OcrNormalizationProvider,
  SpendCategory,
} from "../../lib/domain";
import {
  activityCategories,
  activityUnits,
  spendCategories,
} from "../../lib/domain";
import {
  addActivityEntry,
  attachOcrReviewRows,
  buildRawLcaRequestFromWorkspace,
  createInputWorkspaceState,
  removeReviewRow,
  registerUploadedArtifact,
  summarizeWorkspace,
  updateReviewRow,
  type UploadKind,
} from "./smart-input-model";
import {
  extractOcrTextFromFile,
  heuristicOcrNormalizationProvider,
} from "./ocr-helpers";
import type { SubmissionWorkspaceSnapshot } from "../submission/encrypted-submission-panel";

interface SmartInputWorkspaceProps {
  ocrProvider?: OcrNormalizationProvider;
  extractTextFromFile?: (file: File) => Promise<string>;
  onWorkspaceChange?: (snapshot: SubmissionWorkspaceSnapshot) => void;
}

function formatPreviewLabel(value: string): string {
  return value.replace(/-/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function formatEntrySource(source: string): string {
  return source.slice(0, 1).toUpperCase() + source.slice(1);
}

export function SmartInputWorkspace({
  ocrProvider = heuristicOcrNormalizationProvider,
  extractTextFromFile: extractText = extractOcrTextFromFile,
  onWorkspaceChange,
}: SmartInputWorkspaceProps) {
  const [workspaceState, setWorkspaceState] = useState(
    createInputWorkspaceState,
  );
  const [manualActivityCategory, setManualActivityCategory] =
    useState<ActivityCategory>("RailwayTransportPassengers");
  const [manualActivityValue, setManualActivityValue] = useState("0");
  const [manualActivityUnit, setManualActivityUnit] =
    useState<ActivityUnit>("km");
  const [workspaceError, setWorkspaceError] = useState<string | undefined>();
  const [reviewingArtifactId, setReviewingArtifactId] = useState<
    string | undefined
  >();

  const summary = useMemo(
    () => summarizeWorkspace(workspaceState),
    [workspaceState],
  );
  const payloadPreview = useMemo(
    () => buildRawLcaRequestFromWorkspace(workspaceState),
    [workspaceState],
  );

  useEffect(() => {
    onWorkspaceChange?.({
      payloadPreview,
      activityEntryCount: summary.activityEntryCount,
      spendEntryCount: summary.spendEntryCount,
      uploadedArtifactCount: summary.uploadedArtifactCount,
    });
  }, [
    onWorkspaceChange,
    payloadPreview,
    summary.activityEntryCount,
    summary.spendEntryCount,
    summary.uploadedArtifactCount,
  ]);

  function handleFileUpload(kind: UploadKind, fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) {
      return;
    }

    setWorkspaceError(undefined);
    setWorkspaceState(
      (current) =>
        registerUploadedArtifact(current, {
          kind,
          fileName: file.name,
          mimeType: file.type || "image/*",
        }).state,
    );
  }

  async function reviewArtifact(artifactId: string) {
    const artifact = workspaceState.uploadedArtifacts.find(
      (entry) => entry.artifactId === artifactId,
    );
    if (!artifact) {
      return;
    }

    const fileInput = document.querySelector<HTMLInputElement>(
      `input[data-artifact-kind="${artifact.kind}"]`,
    );
    const file = fileInput?.files?.[0];
    if (!file) {
      setWorkspaceError("Select an image before starting OCR review.");
      return;
    }

    setWorkspaceError(undefined);
    setReviewingArtifactId(artifactId);

    try {
      const rawText = await extractText(file);
      const candidates = await ocrProvider.normalizeOcrCandidates(rawText, {
        fileName: artifact.fileName,
        mimeType: artifact.mimeType,
      });

      setWorkspaceState((current) =>
        attachOcrReviewRows(current, {
          artifact,
          rawText,
          candidates,
        }),
      );
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : "OCR review failed.",
      );
    } finally {
      setReviewingArtifactId(undefined);
    }
  }

  return (
    <Stack spacing={3}>
      <Stack spacing={1.5}>
        <Typography variant="h2">
          Submit your environmental activity data!
        </Typography>
      </Stack>

      {workspaceError ? (
        <Alert severity="error" onClose={() => setWorkspaceError(undefined)}>
          {workspaceError}
        </Alert>
      ) : null}

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, xl: 5 }}>
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
              <Typography variant="h3">Activity entry</Typography>
              <Typography variant="body2" color="text.secondary">
                Enter your environmental activities manually by selecting a
                category, entering a value and choosing the appropriate unit.
                This is ideal for activities like travel or energy use. This
                value will override any automatically extracted candidates of
                the same category.
              </Typography>
              <TextField
                select
                label="Category"
                value={manualActivityCategory}
                onChange={(event) =>
                  setManualActivityCategory(
                    event.target.value as ActivityCategory,
                  )
                }
              >
                {activityCategories.map((category) => (
                  <MenuItem key={category} value={category}>
                    {category}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                label="Value"
                type="number"
                value={manualActivityValue}
                onChange={(event) => setManualActivityValue(event.target.value)}
              />
              <TextField
                select
                label="Unit"
                value={manualActivityUnit}
                onChange={(event) =>
                  setManualActivityUnit(event.target.value as ActivityUnit)
                }
              >
                {activityUnits.map((unit) => (
                  <MenuItem key={unit} value={unit}>
                    {unit}
                  </MenuItem>
                ))}
              </TextField>
              <Button
                variant="outlined"
                onClick={() =>
                  setWorkspaceState((current) =>
                    addActivityEntry(current, {
                      category: manualActivityCategory,
                      value: Number.parseFloat(manualActivityValue || "0"),
                      unit: manualActivityUnit,
                    }),
                  )
                }
              >
                Add activity entry
              </Button>
            </Stack>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, xl: 7 }}>
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
                <Typography variant="h3">
                  Image capture and OCR review
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  On mobile you can tap camera upload for a receipt. On desktop
                  you can choose existing receipt or card-history screenshots
                  and review each extracted spend row before submission.
                </Typography>
                <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                  <Button component="label" variant="contained">
                    Upload receipt image
                    <input
                      hidden
                      accept="image/*"
                      capture="environment"
                      data-artifact-kind="receipt"
                      type="file"
                      onChange={(event) =>
                        handleFileUpload("receipt", event.target.files)
                      }
                    />
                  </Button>
                  <Button component="label" variant="outlined">
                    Upload card screenshot
                    <input
                      hidden
                      accept="image/*"
                      data-artifact-kind="card-screenshot"
                      type="file"
                      onChange={(event) =>
                        handleFileUpload("card-screenshot", event.target.files)
                      }
                    />
                  </Button>
                </Stack>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  {workspaceState.uploadedArtifacts.map((artifact) => (
                    <Chip
                      key={artifact.artifactId}
                      label={`${artifact.kind}: ${artifact.fileName}`}
                      onClick={() => void reviewArtifact(artifact.artifactId)}
                      color={
                        reviewingArtifactId === artifact.artifactId
                          ? "secondary"
                          : "default"
                      }
                    />
                  ))}
                </Stack>
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
                <Stack
                  direction={{ xs: "column", md: "row" }}
                  spacing={1}
                  justifyContent="space-between"
                >
                  <Typography variant="h3">
                    Review extracted candidates
                  </Typography>
                  <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                    <Chip
                      label={`${summary.reviewRowCount} review rows`}
                      variant="outlined"
                    />
                    <Chip
                      label={`${summary.lowConfidenceCount} low-confidence`}
                      variant="outlined"
                    />
                  </Stack>
                </Stack>

                {workspaceState.reviewRows.length === 0 ? (
                  <Alert severity="info">
                    Upload an image and tap its chip to generate editable OCR
                    candidates.
                  </Alert>
                ) : (
                  <Stack spacing={2}>
                    {workspaceState.reviewRows.map((row) => (
                      <Paper
                        key={row.rowId}
                        elevation={0}
                        sx={{
                          p: 2,
                          borderRadius: 4,
                          border: "1px solid",
                          borderColor: "divider",
                        }}
                      >
                        <Stack spacing={2}>
                          <Stack
                            direction={{ xs: "column", md: "row" }}
                            spacing={1}
                            justifyContent="space-between"
                          >
                            <TextField
                              fullWidth
                              label="Title"
                              value={row.label}
                              onChange={(event) =>
                                setWorkspaceState((current) =>
                                  updateReviewRow(current, row.rowId, {
                                    label: event.target.value,
                                  }),
                                )
                              }
                            />
                            <Stack
                              direction={{ xs: "row", md: "column" }}
                              spacing={1}
                              sx={{
                                alignSelf: { xs: "stretch", md: "flex-start" },
                              }}
                            >
                              <Chip
                                label={`Confidence ${Math.round(row.confidence * 100)}%`}
                                color={
                                  row.confidence >= 0.7 ? "success" : "warning"
                                }
                                sx={{ alignSelf: "flex-start" }}
                              />
                              <Button
                                color="error"
                                onClick={() =>
                                  setWorkspaceState((current) =>
                                    removeReviewRow(current, row.rowId),
                                  )
                                }
                                sx={{ alignSelf: "flex-start" }}
                                variant="text"
                              >
                                Delete row
                              </Button>
                            </Stack>
                          </Stack>
                          <Grid container spacing={2}>
                            <Grid size={{ xs: 12, md: 4 }}>
                              <TextField
                                select
                                fullWidth
                                label="Category"
                                value={row.category}
                                onChange={(event) =>
                                  setWorkspaceState((current) =>
                                    updateReviewRow(current, row.rowId, {
                                      category: event.target
                                        .value as SpendCategory,
                                    }),
                                  )
                                }
                              >
                                {spendCategories.map((category) => (
                                  <MenuItem key={category} value={category}>
                                    {category}
                                  </MenuItem>
                                ))}
                              </TextField>
                            </Grid>
                            <Grid size={{ xs: 12, md: 8 }}>
                              <TextField
                                fullWidth
                                label="Amount"
                                type="number"
                                value={row.amount}
                                onChange={(event) =>
                                  setWorkspaceState((current) =>
                                    updateReviewRow(current, row.rowId, {
                                      amount: Number.parseFloat(
                                        event.target.value || "0",
                                      ),
                                    }),
                                  )
                                }
                              />
                            </Grid>
                          </Grid>
                        </Stack>
                      </Paper>
                    ))}
                  </Stack>
                )}
              </Stack>
            </Paper>

            <Grid container spacing={3}>
              {/* <Grid size={{ xs: 12, md: 5 }}>
                <Paper
                  data-testid="private-review-buffer"
                  elevation={0}
                  sx={{
                    p: 3,
                    borderRadius: 5,
                    border: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <Stack spacing={2}>
                    <Typography variant="h3">Private review buffer</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Raw OCR text for review and debugging.
                    </Typography>
                    <Stack spacing={1.25}>
                      {workspaceState.rawOcrArtifacts.length === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                          No OCR text captured yet.
                        </Typography>
                      ) : (
                        workspaceState.rawOcrArtifacts.map((artifact) => (
                          <Paper
                            key={artifact.artifactId}
                            elevation={0}
                            sx={{
                              p: 2,
                              borderRadius: 3,
                              bgcolor: "rgba(8,56,28,0.04)",
                            }}
                          >
                            <Typography
                              variant="caption"
                              color="text.secondary"
                            >
                              {artifact.artifactId}
                            </Typography>
                            <Typography
                              variant="body2"
                              sx={{ whiteSpace: "pre-wrap" }}
                            >
                              {artifact.rawText}
                            </Typography>
                          </Paper>
                        ))
                      )}
                    </Stack>
                  </Stack>
                </Paper>
              </Grid> */}
              <Grid size={{ xs: 12, md: 12 }}>
                <Paper
                  data-testid="payload-preview"
                  elevation={0}
                  sx={{
                    p: 3,
                    borderRadius: 5,
                    border: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <Stack spacing={2}>
                    <Typography variant="h3">
                      Backend-ready payload preview
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      The following entries will be sent to the backend. Private
                      source images and raw OCR text stay outside this payload.
                    </Typography>
                    <Stack
                      direction="row"
                      spacing={1}
                      useFlexGap
                      flexWrap="wrap"
                    >
                      <Chip
                        label={`${payloadPreview.spendEntries.length} spend entries`}
                        variant="outlined"
                      />
                      <Chip
                        label={`${payloadPreview.activityEntries.length} activity entries`}
                        variant="outlined"
                      />
                    </Stack>
                    <Divider />
                    {payloadPreview.spendEntries.length === 0 &&
                    payloadPreview.activityEntries.length === 0 ? (
                      <Alert severity="info">
                        No structured entries yet. Add an activity entry or
                        review OCR candidates to build the backend payload.
                      </Alert>
                    ) : (
                      <Stack spacing={2.5}>
                        <Stack spacing={1.5}>
                          <Typography variant="h4">Spend entries</Typography>
                          {payloadPreview.spendEntries.length === 0 ? (
                            <Typography variant="body2" color="text.secondary">
                              No spend entries have been prepared yet.
                            </Typography>
                          ) : (
                            <Stack spacing={1.25}>
                              {payloadPreview.spendEntries.map((entry) => (
                                <Paper
                                  key={entry.spendId}
                                  elevation={0}
                                  sx={{
                                    p: 2,
                                    borderRadius: 3,
                                    bgcolor: "rgba(13,71,161,0.04)",
                                    border: "1px solid",
                                    borderColor: "divider",
                                  }}
                                >
                                  <Stack spacing={1.25}>
                                    <Stack
                                      direction={{ xs: "column", sm: "row" }}
                                      spacing={1}
                                      justifyContent="space-between"
                                    >
                                      <Stack spacing={0.5}>
                                        <Typography variant="subtitle1">
                                          {formatPreviewLabel(entry.category)}
                                        </Typography>
                                        <Typography
                                          variant="body2"
                                          color="text.secondary"
                                        >
                                          Spend ID: {entry.spendId}
                                        </Typography>
                                      </Stack>
                                      <Chip
                                        label={formatEntrySource(entry.source)}
                                        size="small"
                                        sx={{ alignSelf: "flex-start" }}
                                      />
                                    </Stack>
                                    <Typography variant="body1">
                                      Amount: {entry.amount}
                                    </Typography>
                                  </Stack>
                                </Paper>
                              ))}
                            </Stack>
                          )}
                        </Stack>

                        <Stack spacing={1.5}>
                          <Typography variant="h4">Activity entries</Typography>
                          {payloadPreview.activityEntries.length === 0 ? (
                            <Typography variant="body2" color="text.secondary">
                              No activity entries have been prepared yet.
                            </Typography>
                          ) : (
                            <Stack spacing={1.25}>
                              {payloadPreview.activityEntries.map((entry) => (
                                <Paper
                                  key={entry.activityId}
                                  elevation={0}
                                  sx={{
                                    p: 2,
                                    borderRadius: 3,
                                    bgcolor: "rgba(8,56,28,0.04)",
                                    border: "1px solid",
                                    borderColor: "divider",
                                  }}
                                >
                                  <Stack spacing={1.25}>
                                    <Stack
                                      direction={{ xs: "column", sm: "row" }}
                                      spacing={1}
                                      justifyContent="space-between"
                                    >
                                      <Stack spacing={0.5}>
                                        <Typography variant="subtitle1">
                                          {formatPreviewLabel(entry.category)}
                                        </Typography>
                                        <Typography
                                          variant="body2"
                                          color="text.secondary"
                                        >
                                          Activity ID: {entry.activityId}
                                        </Typography>
                                      </Stack>
                                      <Chip
                                        label={formatEntrySource(entry.source)}
                                        size="small"
                                        sx={{ alignSelf: "flex-start" }}
                                      />
                                    </Stack>
                                    <Typography variant="body1">
                                      Value: {entry.value} {entry.unit}
                                    </Typography>
                                  </Stack>
                                </Paper>
                              ))}
                            </Stack>
                          )}
                        </Stack>
                      </Stack>
                    )}
                  </Stack>
                </Paper>
              </Grid>
            </Grid>
          </Stack>
        </Grid>
      </Grid>
    </Stack>
  );
}
