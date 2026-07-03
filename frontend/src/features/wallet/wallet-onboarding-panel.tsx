import { useEffect, useState } from "react";

import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Grid,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";

import type { PublicProfile } from "../../lib/domain";
import { useWalletFlow } from "./wallet-flow-provider";

function createDefaultProfile(profile?: PublicProfile): PublicProfile {
  return {
    displayAlias: profile?.displayAlias ?? "",
    countryCode: profile?.countryCode ?? "JP",
    avatarUri: profile?.avatarUri ?? "",
  };
}

function formatLamports(value: bigint | undefined): string {
  return new Intl.NumberFormat("en-US").format(Number(value ?? 0n));
}

export function WalletOnboardingPanel() {
  const {
    actionError,
    canClaimRewards,
    canMintSbt,
    canRegisterProfile,
    claimReward,
    clearActionError,
    connectWallet,
    connectionState,
    lastCompletedAction,
    mintUserSbt,
    pendingAction,
    profileSnapshot,
    savePublicProfile,
  } = useWalletFlow();
  const [formState, setFormState] = useState<PublicProfile>(
    createDefaultProfile(),
  );

  useEffect(() => {
    setFormState(createDefaultProfile(profileSnapshot?.publicProfile));
  }, [profileSnapshot?.publicProfile]);

  const isConnected = connectionState.phase === "connected";
  const isRegistered = Boolean(profileSnapshot?.isRegistered);
  const isMinted = Boolean(profileSnapshot?.hasMintedSbt);

  return (
    <Stack spacing={3}>
      <Stack spacing={1.5}>
        <Typography variant="h1" sx={{ maxWidth: 820 }}>
          Green Reputation
        </Typography>
        <Typography
          variant="body1"
          color="text.secondary"
          sx={{ maxWidth: 760 }}
        >
          This app lets you record the amount of carbon dioxide you emit in your
          daily life on the Solana on-chain and share it with other users. Your
          daily efforts to reduce carbon dioxide emissions will be rewarded with
          Solana native token(SOL). You can also earn badges based on your
          cumulative carbon dioxide reduction, allowing you to proudly showcase
          your efforts. Start building your Green Reputation today!
        </Typography>
      </Stack>

      {actionError ? (
        <Alert severity="error" onClose={clearActionError}>
          {actionError}
        </Alert>
      ) : null}
      {lastCompletedAction ? (
        <Alert severity="success">
          {lastCompletedAction === "connect" && "Wallet connected."}
          {lastCompletedAction === "register" && "Public profile registered."}
          {lastCompletedAction === "update" && "Public profile updated."}
          {lastCompletedAction === "mint" && "Soulbound token minted."}
          {lastCompletedAction === "claim" && "Reward claimed."}
        </Alert>
      ) : null}

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <Stack spacing={3}>
            <Paper
              elevation={0}
              sx={{
                p: 3,
                borderRadius: 5,
                border: "1px solid",
                borderColor: "divider",
                background:
                  "linear-gradient(135deg, rgba(255,255,255,0.86) 0%, rgba(236,247,236,0.9) 100%)",
              }}
            >
              <Stack spacing={2}>
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  spacing={1.5}
                  justifyContent="space-between"
                >
                  <Box>
                    <Typography variant="h2">Connect wallet</Typography>
                    <Typography variant="body2" color="text.secondary">
                      To start Green Reputation, connect your Solana wallet!
                    </Typography>
                  </Box>
                  <Chip
                    color={isConnected ? "success" : "default"}
                    label={isConnected ? "Connected" : "Disconnected"}
                    sx={{ alignSelf: "flex-start", fontWeight: 700 }}
                  />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {connectionState.walletAddress ?? "No wallet connected yet."}
                </Typography>
                <Button
                  variant="contained"
                  size="large"
                  onClick={() => void connectWallet()}
                  disabled={pendingAction === "connect" || isConnected}
                >
                  {pendingAction === "connect"
                    ? "Connecting..."
                    : isConnected
                      ? "Wallet Connected"
                      : "Connect Wallet"}
                </Button>
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
                <Typography variant="h2">Register public profile</Typography>
                <Typography variant="body2" color="text.secondary">
                  Only display alias, country code, and avatar URI are stored on
                  chain.
                </Typography>
                {isRegistered ? (
                  <Alert severity="info">
                    Existing on-chain profile detected for this wallet.
                    {profileSnapshot?.profileAddress
                      ? ` Profile: ${profileSnapshot.profileAddress}`
                      : ""}
                  </Alert>
                ) : null}
                <TextField
                  label="Display alias"
                  value={formState.displayAlias}
                  onChange={(event) =>
                    setFormState((current) => ({
                      ...current,
                      displayAlias: event.target.value,
                    }))
                  }
                  disabled={
                    !canRegisterProfile ||
                    pendingAction === "register" ||
                    pendingAction === "update"
                  }
                  helperText={
                    isRegistered
                      ? "Loaded from the existing on-chain profile."
                      : " "
                  }
                />
                <TextField
                  label="Country code"
                  inputProps={{ maxLength: 2 }}
                  value={formState.countryCode}
                  onChange={(event) =>
                    setFormState((current) => ({
                      ...current,
                      countryCode: event.target.value.toUpperCase(),
                    }))
                  }
                  disabled={
                    !canRegisterProfile ||
                    pendingAction === "register" ||
                    pendingAction === "update"
                  }
                  helperText={
                    isRegistered
                      ? "Update the stored country code if needed."
                      : " "
                  }
                />
                <TextField
                  label="Avatar URI"
                  value={formState.avatarUri}
                  onChange={(event) =>
                    setFormState((current) => ({
                      ...current,
                      avatarUri: event.target.value,
                    }))
                  }
                  disabled={
                    !canRegisterProfile ||
                    pendingAction === "register" ||
                    pendingAction === "update"
                  }
                  helperText={
                    isRegistered
                      ? "Update the existing avatar URI if needed."
                      : " "
                  }
                />
                <Button
                  variant="outlined"
                  size="large"
                  onClick={() => void savePublicProfile(formState)}
                  disabled={
                    !canRegisterProfile ||
                    formState.displayAlias.trim().length === 0 ||
                    Boolean(pendingAction)
                  }
                >
                  {pendingAction === "register" || pendingAction === "update"
                    ? "Saving profile..."
                    : isRegistered
                      ? "Update Public Profile"
                      : "Register Public Profile"}
                </Button>
              </Stack>
            </Paper>
          </Stack>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          <Stack spacing={3}>
            <Paper
              elevation={0}
              sx={{
                p: 3,
                borderRadius: 5,
                border: "1px solid",
                borderColor: "divider",
                bgcolor: "rgba(8,56,28,0.94)",
                color: "common.white",
              }}
            >
              <Stack spacing={2}>
                <Typography variant="h2" sx={{ color: "common.white" }}>
                  Mint user Soul Bound Token(SBT)
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ color: "rgba(255,255,255,0.78)" }}
                >
                  Mint your SBT! This token represents your identity in the
                  Green Reputation ecosystem.
                </Typography>
                <Chip
                  label={
                    isMinted
                      ? "SBT Minted"
                      : isRegistered
                        ? "Ready to Mint"
                        : "Register First"
                  }
                  color={isMinted ? "success" : "default"}
                  sx={{ alignSelf: "flex-start", fontWeight: 700 }}
                />
                <Button
                  variant="contained"
                  color="secondary"
                  size="large"
                  onClick={() => void mintUserSbt()}
                  disabled={!canMintSbt || Boolean(pendingAction)}
                >
                  {pendingAction === "mint"
                    ? "Minting..."
                    : isMinted
                      ? "SBT Minted"
                      : "Mint User SBT"}
                </Button>
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
                <Typography variant="h2">Claim rewards</Typography>
                <Typography variant="body2" color="text.secondary">
                  You can receive rewards based on the amount of carbon dioxide
                  emissions you reduce! (You will receive your first reward 30
                  days after you start recording.)
                </Typography>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  <Chip
                    label={`Pending: ${formatLamports(profileSnapshot?.pendingRewardLamports)} lamports`}
                    variant="outlined"
                  />
                  <Chip
                    label={
                      profileSnapshot?.rank
                        ? `Rank: ${profileSnapshot.rank}`
                        : "Rank pending"
                    }
                    variant="outlined"
                  />
                </Stack>
                <Button
                  variant="contained"
                  size="large"
                  onClick={() => void claimReward()}
                  disabled={!canClaimRewards || Boolean(pendingAction)}
                >
                  {pendingAction === "claim" ? "Claiming..." : "Claim Reward"}
                </Button>
              </Stack>
            </Paper>

            {/* <Paper
              elevation={0}
              sx={{
                p: 3,
                borderRadius: 5,
                border: "1px solid",
                borderColor: "divider",
              }}
            >
              <Stack spacing={2}>
                <Typography variant="h2">
                  Backend-managed verification
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  The following actions are intentionally out of this wallet
                  flow because they are not user-signed instructions.
                </Typography>
                <Divider />
                <Stack component="ul" spacing={1.25} sx={{ m: 0, pl: 2.5 }}>
                  <Typography component="li" variant="body2">
                    submit_verified_footprint runs behind the verifier boundary.
                  </Typography>
                  <Typography component="li" variant="body2">
                    sync_sbt_state runs behind metadata authority and backend
                    metadata publication.
                  </Typography>
                </Stack>
              </Stack>
            </Paper> */}
          </Stack>
        </Grid>
      </Grid>
    </Stack>
  );
}
