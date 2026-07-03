import type { PropsWithChildren } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import type {
  PublicProfile,
  WalletConnectionState,
  WalletProfileAdapter,
  WalletProfileSnapshot,
} from "../../lib/domain";
import { canClaimReward } from "../../lib/domain";

type WalletActionName = "connect" | "register" | "update" | "mint" | "claim";

interface WalletFlowContextValue {
  connectionState: WalletConnectionState;
  profileSnapshot: WalletProfileSnapshot | undefined;
  pendingAction: WalletActionName | undefined;
  actionError: string | undefined;
  lastCompletedAction: WalletActionName | undefined;
  connectWallet(): Promise<void>;
  savePublicProfile(input: PublicProfile): Promise<void>;
  mintUserSbt(): Promise<void>;
  claimReward(): Promise<void>;
  clearActionError(): void;
  canRegisterProfile: boolean;
  canMintSbt: boolean;
  canClaimRewards: boolean;
}

const WalletFlowContext = createContext<WalletFlowContextValue | undefined>(
  undefined,
);

interface WalletFlowProviderProps extends PropsWithChildren {
  walletAdapter: WalletProfileAdapter;
}

export function WalletFlowProvider({
  children,
  walletAdapter,
}: WalletFlowProviderProps) {
  const [connectionState, setConnectionState] = useState<WalletConnectionState>(
    { phase: "disconnected" },
  );
  const [profileSnapshot, setProfileSnapshot] = useState<
    WalletProfileSnapshot | undefined
  >();
  const [pendingAction, setPendingAction] = useState<
    WalletActionName | undefined
  >();
  const [actionError, setActionError] = useState<string | undefined>();
  const [lastCompletedAction, setLastCompletedAction] = useState<
    WalletActionName | undefined
  >();

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const nextConnectionState = await walletAdapter.getConnectionState();
      if (cancelled) {
        return;
      }

      setConnectionState(nextConnectionState);
    }

    bootstrap().catch((error: unknown) => {
      if (!cancelled) {
        setActionError(
          error instanceof Error
            ? error.message
            : "Failed to initialize wallet flow.",
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [walletAdapter]);

  useEffect(() => {
    let cancelled = false;

    async function syncProfileSnapshot() {
      if (
        connectionState.phase !== "connected" ||
        !connectionState.walletAddress
      ) {
        setProfileSnapshot(undefined);
        return;
      }

      setProfileSnapshot((current) =>
        current?.walletAddress === connectionState.walletAddress
          ? current
          : undefined,
      );

      try {
        const snapshot = await walletAdapter.getProfileSnapshot(
          connectionState.walletAddress,
        );
        if (!cancelled) {
          setProfileSnapshot(snapshot);
        }
      } catch (error) {
        if (!cancelled) {
          setProfileSnapshot(undefined);
          setActionError(
            error instanceof Error
              ? error.message
              : "Failed to load wallet profile.",
          );
        }
      }
    }

    void syncProfileSnapshot();

    return () => {
      cancelled = true;
    };
  }, [connectionState.phase, connectionState.walletAddress, walletAdapter]);

  async function runAction(
    actionName: WalletActionName,
    action: () => Promise<WalletProfileSnapshot | WalletConnectionState>,
  ) {
    setPendingAction(actionName);
    setActionError(undefined);

    try {
      const result = await action();
      if ("phase" in result) {
        setConnectionState(result);
        if (result.phase !== "connected" || !result.walletAddress) {
          setProfileSnapshot(undefined);
        }
      } else {
        setProfileSnapshot(result);
      }

      setLastCompletedAction(actionName);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Wallet action failed.",
      );
    } finally {
      setPendingAction(undefined);
    }
  }

  const value = useMemo<WalletFlowContextValue>(
    () => ({
      connectionState,
      profileSnapshot,
      pendingAction,
      actionError,
      lastCompletedAction,
      async connectWallet() {
        await runAction("connect", () => walletAdapter.connectWallet());
      },
      async savePublicProfile(input) {
        const operation = profileSnapshot?.isRegistered ? "update" : "register";
        await runAction(operation, () =>
          profileSnapshot?.isRegistered
            ? walletAdapter.updatePublicProfile(input)
            : walletAdapter.registerPublicProfile(input),
        );
      },
      async mintUserSbt() {
        await runAction("mint", () => walletAdapter.mintUserSbt());
      },
      async claimReward() {
        await runAction("claim", () => walletAdapter.claimReward());
      },
      clearActionError() {
        setActionError(undefined);
      },
      canRegisterProfile: connectionState.phase === "connected",
      canMintSbt:
        connectionState.phase === "connected" &&
        Boolean(profileSnapshot?.isRegistered) &&
        !profileSnapshot?.hasMintedSbt,
      canClaimRewards:
        connectionState.phase === "connected" &&
        Boolean(profileSnapshot?.hasMintedSbt) &&
        Boolean(profileSnapshot && canClaimReward(profileSnapshot)),
    }),
    [
      actionError,
      connectionState,
      lastCompletedAction,
      pendingAction,
      profileSnapshot,
      walletAdapter,
    ],
  );

  return (
    <WalletFlowContext.Provider value={value}>
      {children}
    </WalletFlowContext.Provider>
  );
}

export function useWalletFlow() {
  const context = useContext(WalletFlowContext);
  if (!context) {
    throw new Error("useWalletFlow must be used inside WalletFlowProvider.");
  }

  console.log("Wallet flow context value:", context);

  return context;
}
