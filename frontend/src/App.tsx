import { useState } from "react";

import { Box, Container, Paper, Stack, Typography } from "@mui/material";

import { GreenReputationDashboard } from "./features/dashboard/green-reputation-dashboard";
import { SmartInputWorkspace } from "./features/input/smart-input-workspace";
import {
  EncryptedSubmissionPanel,
  type SubmissionWorkspaceSnapshot,
} from "./features/submission/encrypted-submission-panel";
import { WalletOnboardingPanel } from "./features/wallet/wallet-onboarding-panel";
import type {
  AuthTokenProvider,
  EncryptedIngestionApi,
  JobStatusProvider,
  VerifiedSubmissionSnapshot,
} from "./lib/domain";

interface AppProps {
  authTokenProvider: AuthTokenProvider;
  ingestionApi: EncryptedIngestionApi;
  jobStatusProvider: JobStatusProvider;
  submissionRuntimeNote: string;
}

const emptyWorkspaceSnapshot: SubmissionWorkspaceSnapshot = {
  payloadPreview: {
    spendEntries: [],
    activityEntries: [],
    history: {
      pastAverageMonthlyEmissions: 0,
    },
  },
  activityEntryCount: 0,
  spendEntryCount: 0,
  uploadedArtifactCount: 0,
};

export default function App({
  authTokenProvider,
  ingestionApi,
  jobStatusProvider,
  submissionRuntimeNote,
}: AppProps) {
  const [workspaceSnapshot, setWorkspaceSnapshot] =
    useState<SubmissionWorkspaceSnapshot>(emptyWorkspaceSnapshot);
  const [verifiedSnapshot, setVerifiedSnapshot] = useState<
    VerifiedSubmissionSnapshot | undefined
  >();

  return (
    <Box sx={{ minHeight: "100vh", py: { xs: 3, md: 5 } }}>
      <Container maxWidth="lg">
        <Paper
          elevation={0}
          sx={{
            overflow: "hidden",
            borderRadius: 6,
            border: "1px solid",
            borderColor: "divider",
            background:
              "linear-gradient(135deg, rgba(237,248,239,0.94) 0%, rgba(247,252,248,0.96) 52%, rgba(255,255,255,0.98) 100%)",
          }}
        >
          <Stack spacing={4} sx={{ p: { xs: 3, md: 6 } }}>
            <WalletOnboardingPanel />
            <SmartInputWorkspace onWorkspaceChange={setWorkspaceSnapshot} />
            <EncryptedSubmissionPanel
              workspaceSnapshot={workspaceSnapshot}
              authTokenProvider={authTokenProvider}
              ingestionApi={ingestionApi}
              jobStatusProvider={jobStatusProvider}
              runtimeNote={submissionRuntimeNote}
              onVerifiedSnapshotChange={setVerifiedSnapshot}
            />
            <GreenReputationDashboard
              {...(verifiedSnapshot ? { verifiedSnapshot } : {})}
            />
          </Stack>
        </Paper>
      </Container>
    </Box>
  );
}
