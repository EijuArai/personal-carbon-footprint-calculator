import type { PropsWithChildren } from "react";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

vi.mock("@solana/react-hooks", () => ({
  SolanaProvider: ({ children }: PropsWithChildren) => children,
}));

vi.mock("../src/lib/solana/client", () => ({
  solanaClient: {},
}));

import App from "../src/App";
import { AppProviders } from "../src/app/providers";
import {
  createMockAuthTokenProvider,
  createMockEncryptedIngestionApi,
  createMockJobStatusProvider,
  createMockWalletProfileAdapter,
} from "./helpers/mock-runtime-fixtures";

function renderWalletApp(walletAdapter = createMockWalletProfileAdapter()) {
  return render(
    <AppProviders walletAdapter={walletAdapter}>
      <App
        authTokenProvider={createMockAuthTokenProvider()}
        ingestionApi={createMockEncryptedIngestionApi()}
        jobStatusProvider={createMockJobStatusProvider()}
        submissionRuntimeNote="Test runtime"
      />
    </AppProviders>,
  );
}

describe("wallet onboarding flow", () => {
  it("loads an existing on-chain profile into the register section after wallet connect", async () => {
    const user = userEvent.setup();

    renderWalletApp(
      createMockWalletProfileAdapter({
        snapshot: {
          walletAddress: "9xQeWvG816bUx9EPjHmaT23yvVM6m8V3sQxDemo22222",
          profileAddress: "profile-9xQeWvG816",
          publicProfile: {
            displayAlias: "Existing User",
            countryCode: "JP",
            avatarUri: "https://example.com/avatar.png",
          },
          isRegistered: true,
          hasMintedSbt: false,
        },
      }),
    );

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/existing on-chain profile detected for this wallet/i),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("Existing User")).toBeInTheDocument();
      expect(screen.getByDisplayValue("JP")).toBeInTheDocument();
      expect(
        screen.getByDisplayValue("https://example.com/avatar.png"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /update public profile/i }),
    ).toBeInTheDocument();
  });

  it("refreshes the green reputation dashboard automatically when the wallet connects", async () => {
    const user = userEvent.setup();

    renderWalletApp(
      createMockWalletProfileAdapter({
        snapshot: {
          walletAddress: "9xQeWvG816bUx9EPjHmaT23yvVM6m8V3sQxDemo22222",
          publicProfile: {
            displayAlias: "Connected User",
            countryCode: "JP",
            avatarUri: "",
          },
          rank: "Seedling",
          isRegistered: true,
          hasMintedSbt: false,
        },
      }),
    );

    expect(
      screen.getAllByText(/wallet: not connected/i).length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));

    expect(
      await screen.findByRole("heading", { level: 4, name: /connected user/i }),
    ).toBeInTheDocument();
  });

  it("connects a wallet, registers a profile, and mints the SBT", async () => {
    const user = userEvent.setup();

    renderWalletApp();

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /wallet connected/i }),
      ).toBeInTheDocument(),
    );

    await user.type(screen.getByLabelText(/display alias/i), "Aoi");
    await user.clear(screen.getByLabelText(/country code/i));
    await user.type(screen.getByLabelText(/country code/i), "jp");

    await user.click(
      screen.getByRole("button", { name: /register public profile/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/public profile registered/i),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /mint user sbt/i }));
    await waitFor(() =>
      expect(screen.getByText(/soulbound token minted/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /sbt minted/i }),
    ).toBeInTheDocument();
  });

  it("claims rewards when the adapter reports claimable lamports", async () => {
    const user = userEvent.setup();

    renderWalletApp(
      createMockWalletProfileAdapter({
        connectionState: {
          phase: "connected",
          walletAddress: "9xQeWvG816bUx9EPjHmaT23yvVM6m8V3sQxDemo22222",
        },
        snapshot: {
          walletAddress: "9xQeWvG816bUx9EPjHmaT23yvVM6m8V3sQxDemo22222",
          publicProfile: {
            displayAlias: "Claimable User",
            countryCode: "JP",
            avatarUri: "",
          },
          isRegistered: true,
          hasMintedSbt: true,
          pendingRewardLamports: 20000n,
          rank: "Seedling",
        },
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /claim reward/i }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /claim reward/i }));

    await waitFor(() =>
      expect(screen.getByText(/reward claimed/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/pending: 0 lamports/i)).toBeInTheDocument();
  });

  it("surfaces adapter errors such as rejected wallet actions", async () => {
    const user = userEvent.setup();
    const failingAdapter = createMockWalletProfileAdapter();
    failingAdapter.connectWallet = async () => {
      throw new Error("User rejected the wallet signature.");
    };

    renderWalletApp(failingAdapter);

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/user rejected the wallet signature/i),
      ).toBeInTheDocument(),
    );
  });
});
