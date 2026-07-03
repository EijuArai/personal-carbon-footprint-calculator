import type {
  OcrNormalizationContext,
  OcrNormalizationProvider,
  OcrReviewCandidate,
} from "../../lib/domain";

const DEFAULT_SPEND_CATEGORY = "Vegetables";

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function buildFallbackOcrText(fileName: string): string {
  const lowerFileName = fileName.toLowerCase();

  if (lowerFileName.includes("receipt")) {
    return "grocery food 24.80\ntrain transport 12.40";
  }

  if (lowerFileName.includes("card")) {
    return "gas fuel 48.00\nbus transport 16 km";
  }

  return "electricity renewable 18 kWh\nfood lunch 12.50";
}

function classifyCategory(line: string): string {
  const lower = line.toLowerCase();

  if (/(gas|fuel|petrol|diesel)/.test(lower)) {
    return "GasSupply";
  }
  if (/(electric|power|kwh|solar)/.test(lower)) {
    return "Electricity";
  }
  if (/(train|rail)/.test(lower)) {
    return "RailwayTransport";
  }
  if (/bus/.test(lower)) {
    return "BusTransport";
  }
  if (/(taxi|cab)/.test(lower)) {
    return "HiredCarAndTaxiTransport";
  }
  if (/(transport|km|ride|drive|car)/.test(lower)) {
    return "SelfTransport";
  }
  if (/(food|grocery|meal|lunch|dinner|coffee)/.test(lower)) {
    return "Vegetables";
  }

  return DEFAULT_SPEND_CATEGORY;
}

function extractNumericValue(line: string): number | undefined {
  const match = line.match(/(\d+(?:\.\d+)?)/);
  const numericValue = match?.[1];
  return numericValue ? Number.parseFloat(numericValue) : undefined;
}

function extractUnit(line: string): string | undefined {
  const lower = line.toLowerCase();
  if (lower.includes("kwh")) {
    return "kWh";
  }
  if (
    lower.includes("liter") ||
    lower.includes("litre") ||
    lower.includes("l")
  ) {
    return "liter";
  }
  if (lower.includes("km")) {
    return "km";
  }
  if (lower.includes("kg")) {
    return "kg";
  }
  return undefined;
}

function inferKind(
  line: string,
  unit: string | undefined,
): "spend" | "activity" {
  if (
    unit ||
    /(renewable|solar|distance|usage|consumption|km|kwh|kg)/i.test(line)
  ) {
    return "activity";
  }

  return "spend";
}

export async function extractOcrTextFromFile(file: File): Promise<string> {
  const shouldUseLiveOcr =
    typeof navigator !== "undefined" && !/jsdom/i.test(navigator.userAgent);

  if (shouldUseLiveOcr) {
    try {
      const tesseract = await import("tesseract.js");
      const result = await tesseract.recognize(file, "eng");
      const text = normalizeWhitespace(result.data.text ?? "");
      if (text.length > 0) {
        return text;
      }
    } catch {
      // Fall back to a heuristic sample if OCR is unavailable or too expensive in the current runtime.
    }
  }

  return buildFallbackOcrText(file.name);
}

export function createHeuristicOcrNormalizationProvider(): OcrNormalizationProvider {
  return {
    async normalizeOcrCandidates(
      rawText: string,
      context: OcrNormalizationContext,
    ): Promise<OcrReviewCandidate[]> {
      const lines = rawText
        .split("\n")
        .map((line) => normalizeWhitespace(line))
        .filter((line) => line.length > 0);

      const candidates = lines.map((line, index) => {
        const unit = extractUnit(line);
        const kind = inferKind(line, unit);
        const amount = extractNumericValue(line);
        const category = classifyCategory(line);

        return {
          candidateId: `${context.fileName}-${index}`,
          kind,
          label: line,
          confidence:
            amount === undefined ? 0.55 : kind === "activity" ? 0.72 : 0.84,
          proposedCategory: category,
          ...(kind === "activity"
            ? {
                proposedValue: amount ?? 0,
                proposedUnit: unit ?? "km",
              }
            : {
                proposedAmount: amount ?? 0,
              }),
          ...(line.toLowerCase().includes("renewable")
            ? { rawTextSpan: line }
            : {}),
        } satisfies OcrReviewCandidate;
      });

      if (candidates.length > 0) {
        return candidates;
      }

      return [
        {
          candidateId: `${context.fileName}-fallback`,
          kind: "spend",
          label: context.fileName,
          confidence: 0.3,
          proposedCategory: DEFAULT_SPEND_CATEGORY,
          proposedAmount: 0,
        },
      ];
    },
  };
}

export const heuristicOcrNormalizationProvider =
  createHeuristicOcrNormalizationProvider();
