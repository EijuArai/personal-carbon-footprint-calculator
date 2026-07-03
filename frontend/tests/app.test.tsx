import type { PropsWithChildren } from "react";
import { useEffect } from "react";

import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

vi.mock("@solana/react-hooks", () => ({
  SolanaProvider: ({ children }: PropsWithChildren) => children,
}));

vi.mock("../src/lib/solana/client", () => ({
  solanaClient: {},
}));

vi.mock("../src/features/wallet/wallet-onboarding-panel", () => ({
  WalletOnboardingPanel: () => <section>User-signed wallet onboarding</section>,
}));

vi.mock("../src/features/input/smart-input-workspace", () => ({
  SmartInputWorkspace: ({
    onWorkspaceChange,
  }: {
    onWorkspaceChange?: (snapshot: unknown) => void;
  }) => {
    useEffect(() => {
      onWorkspaceChange?.({
        payloadPreview: {
          spendEntries: [],
          activityEntries: [
            {
              activityId: "a-1",
              category: "RailwayTransport",
              value: 42.5,
              unit: "km",
              source: "manual",
            },
          ],
          history: { pastAverageMonthlyEmissions: 30 },
        },
        activityEntryCount: 1,
        spendEntryCount: 0,
        uploadedArtifactCount: 0,
      });
    }, [onWorkspaceChange]);

    return <section>Smart input workspace</section>;
  },
}));

vi.mock("../src/features/submission/encrypted-submission-panel", () => ({
  EncryptedSubmissionPanel: ({
    workspaceSnapshot,
    authTokenProvider,
    ingestionApi,
    jobStatusProvider,
    runtimeNote,
    onVerifiedSnapshotChange,
  }: {
    workspaceSnapshot: { activityEntryCount: number };
    authTokenProvider: unknown;
    ingestionApi: unknown;
    jobStatusProvider: unknown;
    runtimeNote?: string;
    onVerifiedSnapshotChange?: (snapshot: unknown) => void;
  }) => {
    useEffect(() => {
      onVerifiedSnapshotChange?.({
        requestId: "req-1",
        dataHash:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        metadataUri: "ipfs://metadata.json",
        metadataVersion: 2,
        totalEmissionsKgCo2e: 12.4,
        baseReductionKgCo2e: 1.1,
        finalRewards: 1.32,
        multiplierApplied: 1.1,
        categories: ["Vegetables"],
        submittedAtIso: "2026-04-19T00:00:00.000Z",
      });
    }, [onVerifiedSnapshotChange]);

    return (
      <section>
        Encrypted submission activity rows:{" "}
        {workspaceSnapshot.activityEntryCount}
        {" | injected: "}
        {String(
          Boolean(
            authTokenProvider &&
            ingestionApi &&
            jobStatusProvider &&
            runtimeNote,
          ),
        )}
      </section>
    );
  },
}));

vi.mock("../src/features/dashboard/green-reputation-dashboard", () => ({
  GreenReputationDashboard: ({
    verifiedSnapshot,
  }: {
    verifiedSnapshot?: { requestId: string };
  }) => (
    <section>
      Green reputation dashboard request:{" "}
      {verifiedSnapshot?.requestId ?? "none"}
    </section>
  ),
}));

import App from "../src/App";
import { AppProviders } from "../src/app/providers";
import {
  createMockAuthTokenProvider,
  createMockEncryptedIngestionApi,
  createMockJobStatusProvider,
  createMockWalletProfileAdapter,
} from "./helpers/mock-runtime-fixtures";

describe("App foundation", () => {
  it("wires workspace state into submission and verified state into the dashboard", async () => {
    render(
      <AppProviders walletAdapter={createMockWalletProfileAdapter()}>
        <App
          authTokenProvider={createMockAuthTokenProvider()}
          ingestionApi={createMockEncryptedIngestionApi()}
          jobStatusProvider={createMockJobStatusProvider()}
          submissionRuntimeNote="App test runtime"
        />
      </AppProviders>,
    );

    expect(
      await screen.findByText(/user-signed wallet onboarding/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/smart input workspace/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /encrypted submission activity rows: 1 \| injected: true/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/green reputation dashboard request: req-1/i),
    ).toBeInTheDocument();
  });
});
