import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SmartInputWorkspace } from "../src/features/input/smart-input-workspace";
import { createHeuristicOcrNormalizationProvider } from "../src/features/input/ocr-helpers";
import {
  addActivityEntry,
  attachOcrReviewRows,
  buildRawLcaRequestFromWorkspace,
  createInputWorkspaceState,
  removeReviewRow,
  registerUploadedArtifact,
  updateReviewRow,
} from "../src/features/input/smart-input-model";

describe("smart input model", () => {
  it("maps manual and OCR review rows into a backend-compatible payload", () => {
    let state = createInputWorkspaceState();
    state = addActivityEntry(state, {
      category: "RailwayTransportPassengers",
      value: 16,
      unit: "km",
    });

    const registered = registerUploadedArtifact(state, {
      kind: "receipt",
      fileName: "receipt-food.png",
      mimeType: "image/png",
    });

    state = attachOcrReviewRows(registered.state, {
      artifact: registered.artifact,
      rawText: "grocery food 24.80",
      candidates: [
        {
          candidateId: "receipt-food-1",
          kind: "spend",
          label: "grocery food 24.80",
          confidence: 0.88,
          proposedCategory: "Vegetables",
          proposedAmount: 24.8,
        },
      ],
    });

    const payload = buildRawLcaRequestFromWorkspace(state);

    expect(payload.activityEntries).toHaveLength(1);
    expect(payload.activityEntries[0]).toMatchObject({
      category: "RailwayTransportPassengers",
      value: 16,
      source: "manual",
    });
    expect(payload.spendEntries).toHaveLength(1);
    expect(payload.spendEntries[0]).toMatchObject({
      category: "Vegetables",
      amount: 24.8,
      source: "ocr",
    });
  });

  it("allows editing OCR row titles and removing rows before payload generation", () => {
    let state = createInputWorkspaceState();

    const registered = registerUploadedArtifact(state, {
      kind: "receipt",
      fileName: "receipt-food.png",
      mimeType: "image/png",
    });

    state = attachOcrReviewRows(registered.state, {
      artifact: registered.artifact,
      rawText: "grocery food 24.80\ntrain transport 12 km",
      candidates: [
        {
          candidateId: "receipt-food-1",
          kind: "spend",
          label: "grocery food 24.80",
          confidence: 0.88,
          proposedCategory: "Vegetables",
          proposedAmount: 24.8,
        },
        {
          candidateId: "receipt-transport-1",
          kind: "activity",
          label: "train transport 12 km",
          confidence: 0.83,
          proposedCategory: "RailwayTransport",
          proposedValue: 12,
          proposedUnit: "km",
        },
      ],
    });

    const firstRowId = state.reviewRows[0]?.rowId;
    const secondRowId = state.reviewRows[1]?.rowId;

    expect(firstRowId).toBeDefined();
    expect(secondRowId).toBeDefined();

    state = updateReviewRow(state, firstRowId!, {
      label: "Weekly grocery run",
    });
    state = removeReviewRow(state, secondRowId!);

    expect(state.reviewRows).toHaveLength(1);
    expect(state.reviewRows[0]).toMatchObject({ label: "Weekly grocery run" });

    const payload = buildRawLcaRequestFromWorkspace(state);
    expect(payload.spendEntries).toHaveLength(1);
    expect(payload.activityEntries).toHaveLength(0);
  });

  it("keeps receipt artifact numbering based on uploaded receipts, not OCR row count", () => {
    let state = createInputWorkspaceState();

    const firstRegistered = registerUploadedArtifact(state, {
      kind: "receipt",
      fileName: "receipt-food.png",
      mimeType: "image/png",
    });

    state = attachOcrReviewRows(firstRegistered.state, {
      artifact: firstRegistered.artifact,
      rawText: "grocery food 24.80\ntrain transport 12 km",
      candidates: [
        {
          candidateId: "receipt-food-1",
          kind: "spend",
          label: "grocery food 24.80",
          confidence: 0.88,
          proposedCategory: "Vegetables",
          proposedAmount: 24.8,
        },
        {
          candidateId: "receipt-transport-1",
          kind: "activity",
          label: "train transport 12 km",
          confidence: 0.83,
          proposedCategory: "RailwayTransport",
          proposedValue: 12,
          proposedUnit: "km",
        },
      ],
    });

    const secondRegistered = registerUploadedArtifact(state, {
      kind: "receipt",
      fileName: "receipt-fuel.png",
      mimeType: "image/png",
    });

    expect(firstRegistered.artifact.artifactId).toBe("receipt-1");
    expect(secondRegistered.artifact.artifactId).toBe("receipt-2");
  });
});

describe("smart input workspace", () => {
  it("captures manual entries and keeps the DTO preview updated", async () => {
    const user = userEvent.setup();
    render(<SmartInputWorkspace />);

    await user.clear(screen.getByLabelText(/^Value$/i));
    await user.type(screen.getByLabelText(/^Value$/i), "18");
    await user.click(
      screen.getByRole("button", { name: /add activity entry/i }),
    );

    const payloadPreview = screen.getByTestId("payload-preview");
    expect(
      within(payloadPreview).getByRole("heading", {
        name: /^activity entries$/i,
      }),
    ).toBeInTheDocument();
    expect(
      within(payloadPreview).getByText(/value: 18 km/i),
    ).toBeInTheDocument();
  });

  it("uploads images, generates editable OCR candidates, and omits raw OCR text from the DTO preview", async () => {
    const user = userEvent.setup();
    render(
      <SmartInputWorkspace
        ocrProvider={createHeuristicOcrNormalizationProvider()}
        extractTextFromFile={async () =>
          "grocery food 24.80\ntrain transport 12 km"
        }
      />,
    );

    const receiptInput = document.querySelector<HTMLInputElement>(
      'input[data-artifact-kind="receipt"]',
    );
    expect(receiptInput).not.toBeNull();
    await user.upload(
      receiptInput!,
      new File(["receipt"], "receipt-photo.png", { type: "image/png" }),
    );

    await user.click(
      screen.getByRole("button", { name: /receipt: receipt-photo.png/i }),
    );

    await waitFor(() =>
      expect(screen.getByText(/review rows/i)).toBeInTheDocument(),
    );

    // const privateBuffer = screen.getByTestId("private-review-buffer");
    // expect(
    //   within(privateBuffer).getByText(/grocery food 24.80/i),
    // ).toBeInTheDocument();

    const payloadPreview = screen.getByTestId("payload-preview");
    expect(
      within(payloadPreview).queryByText(/grocery food 24.80/i),
    ).not.toBeInTheDocument();
    expect(
      within(payloadPreview).getByRole("heading", { name: /^spend entries$/i }),
    ).toBeInTheDocument();
    expect(within(payloadPreview).getByText(/vegetables/i)).toBeInTheDocument();
  });

  it("lets users edit OCR titles and delete rows from review", async () => {
    const user = userEvent.setup();
    render(
      <SmartInputWorkspace
        ocrProvider={createHeuristicOcrNormalizationProvider()}
        extractTextFromFile={async () =>
          "grocery food 24.80\ntrain transport 12 km"
        }
      />,
    );

    const receiptInput = document.querySelector<HTMLInputElement>(
      'input[data-artifact-kind="receipt"]',
    );
    expect(receiptInput).not.toBeNull();
    await user.upload(
      receiptInput!,
      new File(["receipt"], "receipt-photo.png", { type: "image/png" }),
    );

    await user.click(
      screen.getByRole("button", { name: /receipt: receipt-photo.png/i }),
    );

    await waitFor(() =>
      expect(screen.getAllByLabelText(/^Title$/i)).toHaveLength(2),
    );

    const titleInputs = screen.getAllByLabelText(/^Title$/i);
    await user.clear(titleInputs[0]!);
    await user.type(titleInputs[0]!, "Weekly grocery run");

    expect(screen.getByDisplayValue("Weekly grocery run")).toBeInTheDocument();

    const deleteButtons = screen.getAllByRole("button", {
      name: /delete row/i,
    });
    await user.click(deleteButtons[1]!);

    await waitFor(() =>
      expect(screen.getAllByLabelText(/^Title$/i)).toHaveLength(1),
    );

    const payloadPreview = screen.getByTestId("payload-preview");
    expect(
      within(payloadPreview).getByRole("heading", { name: /^spend entries$/i }),
    ).toBeInTheDocument();
    expect(
      within(payloadPreview).getByText(
        /no activity entries have been prepared yet/i,
      ),
    ).toBeInTheDocument();
  });

  it("supports both receipt camera uploads and desktop card screenshot uploads", async () => {
    const user = userEvent.setup();
    render(
      <SmartInputWorkspace
        extractTextFromFile={async () => "gas fuel 48.00"}
      />,
    );

    const receiptInput = document.querySelector<HTMLInputElement>(
      'input[data-artifact-kind="receipt"]',
    );
    const cardInput = document.querySelector<HTMLInputElement>(
      'input[data-artifact-kind="card-screenshot"]',
    );
    expect(receiptInput).not.toBeNull();
    expect(cardInput).not.toBeNull();

    await user.upload(
      receiptInput!,
      new File(["r"], "receipt-mobile.png", { type: "image/png" }),
    );
    await user.upload(
      cardInput!,
      new File(["c"], "card-desktop.png", { type: "image/png" }),
    );

    expect(
      screen.getByRole("button", { name: /receipt: receipt-mobile.png/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /card-screenshot: card-desktop.png/i,
      }),
    ).toBeInTheDocument();
  });
});
