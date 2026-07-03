import { useEffect } from "react";

import {
  Alert,
  Avatar,
  Chip,
  Grid,
  Paper,
  Stack,
  Typography,
} from "@mui/material";

import {
  composeDashboardReadModel,
  deriveFeedbackTone,
  persistVerifiedSnapshot,
  readStoredVerifiedSnapshot,
  type VerifiedSubmissionSnapshot,
} from "../../lib/domain";
import { useWalletFlow } from "../wallet/wallet-flow-provider";

interface GreenReputationDashboardProps {
  verifiedSnapshot?: VerifiedSubmissionSnapshot;
}

function createAvatarFallbackLabel(displayAlias: string | undefined): string {
  const normalizedAlias = displayAlias?.trim();
  if (!normalizedAlias) {
    return "?";
  }

  return normalizedAlias.slice(0, 1).toUpperCase();
}

function formatWalletAddress(walletAddress: string | undefined): string {
  if (!walletAddress) {
    return "Not connected";
  }

  return `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;
}

function formatLamports(value: bigint): string {
  return `${value.toString()} lamports`;
}

function toneHeading(
  tone: ReturnType<typeof deriveFeedbackTone> | undefined,
): string {
  if (tone === "bonus") {
    return "Bonus momentum";
  }
  if (tone === "penalty") {
    return "Penalty pressure";
  }
  return "Steady pacing";
}

function toneMessage(input: {
  tone: ReturnType<typeof deriveFeedbackTone> | undefined;
  multiplierApplied?: number;
}): string {
  if (input.tone === "bonus") {
    return `${input.multiplierApplied?.toFixed(1) ?? "1.0"}x multiplier kept more of this month's reduction.`;
  }
  if (input.tone === "penalty") {
    return "The multiplier fell below 1.0 because this period outpaced your historical baseline.";
  }
  return "Your reduction held steady against the historical baseline, so the multiplier stayed neutral.";
}

export function GreenReputationDashboard({
  verifiedSnapshot,
}: GreenReputationDashboardProps) {
  const { connectionState, profileSnapshot } = useWalletFlow();
  const connectedWalletAddress =
    profileSnapshot?.walletAddress ?? connectionState.walletAddress;
  const activeVerifiedSnapshot =
    verifiedSnapshot ?? readStoredVerifiedSnapshot(connectedWalletAddress);

  useEffect(() => {
    if (!connectedWalletAddress || !verifiedSnapshot) {
      return;
    }

    persistVerifiedSnapshot(connectedWalletAddress, verifiedSnapshot);
  }, [connectedWalletAddress, verifiedSnapshot]);

  const dashboard = composeDashboardReadModel({
    ...(profileSnapshot ? { wallet: profileSnapshot } : {}),
    ...(activeVerifiedSnapshot
      ? { verifiedSnapshot: activeVerifiedSnapshot }
      : {}),
  });
  console.log("Composed dashboard read model:", dashboard);
  const feedbackTone = activeVerifiedSnapshot
    ? deriveFeedbackTone(activeVerifiedSnapshot.multiplierApplied)
    : undefined;
  const scoreMessage = toneMessage(
    activeVerifiedSnapshot
      ? {
          tone: feedbackTone,
          multiplierApplied: activeVerifiedSnapshot.multiplierApplied,
        }
      : { tone: feedbackTone },
  );

  return (
    <Stack spacing={3}>
      <Stack spacing={1.5}>
        <Typography variant="h2">Green reputation dashboard</Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ maxWidth: 760 }}
        >
          This is the public dashboard. It uses only wallet profile state,
          aggregate scoring results, metadata references, and hashes.
        </Typography>
      </Stack>

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
              <Typography variant="h3">Public profile</Typography>
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                <Chip label={dashboard.rank ?? "Unranked"} color="success" />
                <Chip
                  label={`${dashboard.hydrationSource} read model`}
                  variant="outlined"
                />
              </Stack>
              <Stack direction="row" spacing={2} alignItems="center">
                <Avatar
                  src={dashboard.publicProfile?.avatarUri || undefined}
                  alt={
                    dashboard.publicProfile?.displayAlias || "Public profile"
                  }
                  slotProps={{
                    img: {
                      loading: "lazy",
                      referrerPolicy: "no-referrer",
                    },
                  }}
                  sx={{ width: 56, height: 56 }}
                >
                  {createAvatarFallbackLabel(
                    dashboard.publicProfile?.displayAlias,
                  )}
                </Avatar>
                <Typography variant="h4">
                  {dashboard.publicProfile?.displayAlias ??
                    "Register a public profile"}
                </Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Country: {dashboard.publicProfile?.countryCode || "Not set"}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Wallet: {formatWalletAddress(connectedWalletAddress)}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Pending rewards:{" "}
                {formatLamports(dashboard.pendingRewardLamports)}
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
                borderColor:
                  feedbackTone === "penalty"
                    ? "warning.light"
                    : feedbackTone === "bonus"
                      ? "success.light"
                      : "divider",
                background:
                  feedbackTone === "penalty"
                    ? "linear-gradient(135deg, rgba(255,244,229,0.9) 0%, rgba(255,250,245,0.96) 100%)"
                    : feedbackTone === "bonus"
                      ? "linear-gradient(135deg, rgba(232,245,233,0.96) 0%, rgba(245,252,247,0.98) 100%)"
                      : "linear-gradient(135deg, rgba(245,247,250,0.96) 0%, rgba(255,255,255,0.98) 100%)",
              }}
            >
              <Stack spacing={2}>
                <Typography variant="h3">
                  {toneHeading(feedbackTone)}
                </Typography>
                <Typography variant="body1">{scoreMessage}</Typography>
                <Grid container spacing={2}>
                  <Grid size={{ xs: 12, md: 4 }}>
                    <Paper
                      elevation={0}
                      sx={{
                        p: 2,
                        borderRadius: 4,
                        bgcolor: "rgba(255,255,255,0.72)",
                      }}
                    >
                      <Typography variant="caption" color="text.secondary">
                        Base reduction
                      </Typography>
                      <Typography variant="h3">
                        {activeVerifiedSnapshot?.baseReductionKgCo2e ?? 0} kg
                      </Typography>
                    </Paper>
                  </Grid>
                  <Grid size={{ xs: 12, md: 4 }}>
                    <Paper
                      elevation={0}
                      sx={{
                        p: 2,
                        borderRadius: 4,
                        bgcolor: "rgba(255,255,255,0.72)",
                      }}
                    >
                      <Typography variant="caption" color="text.secondary">
                        Multiplier
                      </Typography>
                      <Typography variant="h3">
                        {activeVerifiedSnapshot?.multiplierApplied?.toFixed(
                          1,
                        ) ?? "0.0"}
                        x
                      </Typography>
                    </Paper>
                  </Grid>
                  <Grid size={{ xs: 12, md: 4 }}>
                    <Paper
                      elevation={0}
                      sx={{
                        p: 2,
                        borderRadius: 4,
                        bgcolor: "rgba(255,255,255,0.72)",
                      }}
                    >
                      <Typography variant="caption" color="text.secondary">
                        Final rewards
                      </Typography>
                      <Typography variant="h3">
                        {activeVerifiedSnapshot?.finalRewards ?? 0}
                      </Typography>
                    </Paper>
                  </Grid>
                </Grid>
                <Typography variant="body2" color="text.secondary">
                  Categories reflected in the public score:{" "}
                  {dashboard.latestCategories.join(", ") || "none"}
                </Typography>
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
                <Typography variant="h3">
                  Aggregate reputation surface
                </Typography>
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
                        Cumulative emissions
                      </Typography>
                      <Typography variant="h3">
                        {dashboard.totalEmissionsKgCo2e} kg
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
                        Cumulative reductions
                      </Typography>
                      <Typography variant="h3">
                        {dashboard.totalReductionsKgCo2e} kg
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
                        Metadata version
                      </Typography>
                      <Typography variant="h3">
                        v{dashboard.latestMetadataVersion ?? 0}
                      </Typography>
                    </Paper>
                  </Grid>
                </Grid>
                <Stack spacing={1}>
                  <Typography variant="body2">
                    <strong>Data hash</strong>:{" "}
                    {dashboard.latestDataHash ?? "No verified submission yet"}
                  </Typography>
                  <Typography variant="body2">
                    <strong>Metadata URI</strong>:{" "}
                    {dashboard.latestMetadataUri ?? "No metadata published yet"}
                  </Typography>
                </Stack>
              </Stack>
            </Paper>
          </Stack>
        </Grid>
      </Grid>

      {!activeVerifiedSnapshot ? (
        <Alert severity="info">
          No verified aggregate score yet. Submit an encrypted footprint to
          populate the public reputation surface.
        </Alert>
      ) : null}
    </Stack>
  );
}
