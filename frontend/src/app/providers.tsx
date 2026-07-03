import type { PropsWithChildren } from "react";

import { CssBaseline, ThemeProvider } from "@mui/material";
import { SolanaProvider } from "@solana/react-hooks";

import type { WalletProfileAdapter } from "../lib/domain";
import { WalletFlowProvider } from "../features/wallet/wallet-flow-provider";
import { greenReputationTheme } from "../lib/theme/theme";
import { solanaClient } from "../lib/solana/client";

interface AppProvidersProps extends PropsWithChildren {
  walletAdapter: WalletProfileAdapter;
}

export function AppProviders({ children, walletAdapter }: AppProvidersProps) {
  return (
    <SolanaProvider client={solanaClient}>
      <ThemeProvider theme={greenReputationTheme}>
        <CssBaseline enableColorScheme />
        <WalletFlowProvider walletAdapter={walletAdapter}>
          {children}
        </WalletFlowProvider>
      </ThemeProvider>
    </SolanaProvider>
  );
}
