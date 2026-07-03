import { render, screen } from "@testing-library/react";
import { beforeEach } from "vitest";
import { vi } from "vitest";

import { GreenReputationDashboard } from "../src/features/dashboard/green-reputation-dashboard";
import type { VerifiedSubmissionSnapshot } from "../src/lib/domain";
import type {
  WalletConnectionState,
  WalletProfileSnapshot,
} from "../src/lib/domain";

let walletFlowMock: {
  connectionState: WalletConnectionState;
  profileSnapshot: WalletProfileSnapshot | undefined;
} = {
  connectionState: { phase: "disconnected" },
  profileSnapshot: undefined,
};

vi.mock("../src/features/wallet/wallet-flow-provider", () => ({
  useWalletFlow: () => walletFlowMock,
}));

beforeEach(() => {
  window.localStorage.clear();
});

describe("green reputation dashboard", () => {
  it("renders a bonus-oriented dashboard from wallet and verified aggregate state", () => {
    walletFlowMock = {
      connectionState: {
        phase: "connected",
        walletAddress: "wallet-1",
      },
      profileSnapshot: {
        walletAddress: "wallet-1",
        publicProfile: {
          displayAlias: "Aoi",
          countryCode: "JP",
          avatarUri: "https://example.com/aoi.png",
        },
        rank: "Sapling",
        totalEmissionsKgCo2e: 61,
        totalReductionsKgCo2e: 13,
        pendingRewardLamports: 2400n,
        isRegistered: true,
        hasMintedSbt: true,
      },
    };

    render(
      <GreenReputationDashboard
        verifiedSnapshot={createVerifiedSnapshot({
          multiplierApplied: 1.3,
          finalRewards: 5.2,
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /green reputation dashboard/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 4, name: /aoi/i }),
    ).toBeInTheDocument();
    expect(screen.getByAltText(/aoi/i)).toHaveAttribute(
      "src",
      expect.stringContaining("https://example.com/aoi.png"),
    );
    expect(screen.getByText(/sapling/i)).toBeInTheDocument();
    expect(screen.getByText(/bonus momentum/i)).toBeInTheDocument();
    expect(
      screen.getByText(/1\.3x multiplier kept more of this month's reduction/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/data hash/i)).toBeInTheDocument();
    expect(screen.getByText(/2400 lamports/i)).toBeInTheDocument();
    expect(screen.getByText(/composed read model/i)).toBeInTheDocument();
    expect(screen.getByText(/^19 kg$/i)).toBeInTheDocument();
    expect(screen.getByText(/^13 kg$/i)).toBeInTheDocument();
    expect(screen.getByText(/^5\.2$/i)).toBeInTheDocument();
  });

  it("renders a penalty-oriented explanation without exposing raw input detail", () => {
    walletFlowMock = {
      connectionState: {
        phase: "connected",
        walletAddress: "wallet-2",
      },
      profileSnapshot: {
        walletAddress: "wallet-2",
        publicProfile: {
          displayAlias: "Ren",
          countryCode: "JP",
          avatarUri: "",
        },
        rank: "Seedling",
        totalEmissionsKgCo2e: 88,
        totalReductionsKgCo2e: 9,
        pendingRewardLamports: 0n,
        isRegistered: true,
        hasMintedSbt: true,
      },
    };

    render(
      <GreenReputationDashboard
        verifiedSnapshot={createVerifiedSnapshot({
          multiplierApplied: 0.7,
          finalRewards: 1.4,
          categories: ["RailwayTransport"],
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 4, name: /ren/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/penalty pressure/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /the multiplier fell below 1\.0 because this period outpaced your historical baseline/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/railwaytransport/i)).toBeInTheDocument();
    expect(screen.queryByText(/manualentries/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/receiptentries/i)).not.toBeInTheDocument();
  });

  it("restores the aggregate reputation surface from persisted wallet data after reload", () => {
    const walletAddress = "wallet-3";
    walletFlowMock = {
      connectionState: {
        phase: "connected",
        walletAddress,
      },
      profileSnapshot: {
        walletAddress,
        publicProfile: {
          displayAlias: "Mika",
          countryCode: "JP",
          avatarUri: "",
        },
        rank: "Tree",
        totalEmissionsKgCo2e: 120,
        totalReductionsKgCo2e: 40,
        pendingRewardLamports: 900n,
        isRegistered: true,
        hasMintedSbt: true,
      },
    };

    window.localStorage.setItem(
      `green-reputation:verified-snapshot:${walletAddress}`,
      JSON.stringify(
        createVerifiedSnapshot({
          requestId: "req-restored",
          metadataVersion: 7,
          metadataUri: "ipfs://restored-metadata.json",
          dataHash:
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          baseReductionKgCo2e: 3.4,
          finalRewards: 4.1,
          multiplierApplied: 1.2,
          categories: ["Vegetables", "RailwayTransport"],
        }),
      ),
    );

    render(<GreenReputationDashboard />);

    expect(
      screen.getByText(/vegetables, railwaytransport/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/3.4 kg/i)).toBeInTheDocument();
    expect(screen.getByText(/40 kg/i)).toBeInTheDocument();
    expect(screen.getByText(/^4.1$/i)).toBeInTheDocument();
    expect(
      screen.getByText(/1.2x multiplier kept more of this month's reduction/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/v7/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/ipfs:\/\/restored-metadata\.json/i),
    ).toBeInTheDocument();
  });

  it("falls back to the wallet metadata version after reload when no verified snapshot is restored", () => {
    walletFlowMock = {
      connectionState: {
        phase: "connected",
        walletAddress: "wallet-4",
      },
      profileSnapshot: {
        walletAddress: "wallet-4",
        publicProfile: {
          displayAlias: "Sora",
          countryCode: "JP",
          avatarUri: "",
        },
        rank: "Seedling",
        metadataVersion: 5,
        totalEmissionsKgCo2e: 42,
        totalReductionsKgCo2e: 11,
        pendingRewardLamports: 300n,
        isRegistered: true,
        hasMintedSbt: true,
      },
    };

    render(<GreenReputationDashboard />);

    expect(screen.getByText(/wallet read model/i)).toBeInTheDocument();
    expect(screen.getByText(/^v5$/i)).toBeInTheDocument();
    expect(
      screen.getByText(/no verified aggregate score yet/i),
    ).toBeInTheDocument();
  });
});

function createVerifiedSnapshot(
  overrides?: Partial<VerifiedSubmissionSnapshot>,
): VerifiedSubmissionSnapshot {
  return {
    requestId: overrides?.requestId ?? "req-1",
    dataHash:
      overrides?.dataHash ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    metadataUri: overrides?.metadataUri ?? "ipfs://metadata.json",
    metadataVersion: overrides?.metadataVersion ?? 2,
    totalEmissionsKgCo2e: overrides?.totalEmissionsKgCo2e ?? 19,
    baseReductionKgCo2e: overrides?.baseReductionKgCo2e ?? 4,
    finalRewards: overrides?.finalRewards ?? 4.8,
    multiplierApplied: overrides?.multiplierApplied ?? 1.2,
    categories: overrides?.categories ?? ["Vegetables", "Electricity"],
    submittedAtIso: overrides?.submittedAtIso ?? "2026-04-19T00:00:00.000Z",
  };
}
