import { describe, expect, it } from 'vitest';

import {
  LcaOrchestrator,
  calculateDynamicMultiplier,
  serializeCommitmentPayload,
} from '../../src/modules/lca/index.js';

describe('LcaOrchestrator', () => {
  const orchestrator = new LcaOrchestrator({ now: () => 1_712_345_678_000 });

  it('calculates a spend-only baseline and keeps output aggregate-only', () => {
    const normalized = orchestrator.normalizeInput({
      periodKey: '2026-04',
      spendEntries: [
        {
          spendId: 'txn-electricity',
          category: 'Electricity',
          amount: 10_000,
          source: 'open_banking',
        },
        {
          spendId: 'txn-food',
          category: 'Vegetables',
          amount: 40_000,
          source: 'open_banking',
        },
      ],
      history: { pastAverageMonthlyEmissions: 0 },
    });

    const result = orchestrator.calculateFootprint(
      normalized.spendData,
      normalized.activityData,
      normalized.history,
    );
    const commitment = orchestrator.buildCommitmentPayload(result, normalized);

    expect(normalized.dataSourceKind).toBe('spend');
    expect(result).toEqual({
      totalEmissions: 462.49,
      baseReduction: 0,
      multiplierApplied: 1,
      finalRewards: 0,
      verificationData: {
        emissionFactorDatabase: 'EXIOBASE_Mock_v1',
        timestamp: 1_712_345_678_000,
      },
    });
    expect(commitment).toEqual({
      schemaVersion: 'commitment-preimage@v1',
      periodKey: '2026-04',
      dataSourceKind: 'spend',
      totalEmissionsKgCo2e: 462.49,
      baseReductionKgCo2e: 0,
      finalRewards: 0,
      multiplierApplied: 1,
      historicalBaselineKgCo2e: 0,
      sourceSummary: {
        spendRecordCount: 2,
        activityRecordCount: 0,
        categories: ['Electricity', 'Vegetables'],
        origins: ['open_banking'],
        overriddenCategories: [],
      },
      verificationData: {
        emissionFactorDatabase: 'EXIOBASE_Mock_v1',
        timestamp: 1_712_345_678_000,
      },
    });

    const serialized = serializeCommitmentPayload(commitment);
    expect(serialized).not.toContain('txn-electricity');
    expect(serialized).not.toContain('txn-food');
  });

  it('replaces spend estimates with activity data and tracks positive reductions', () => {
    const normalized = orchestrator.normalizeInput({
      periodKey: '2026-04',
      spendEntries: [
        {
          spendId: 'txn-electricity',
          category: 'Electricity',
          amount: 15_000,
          source: 'open_banking',
        },
        {
          spendId: 'txn-food',
          category: 'Vegetables',
          amount: 40_000,
          source: 'open_banking',
        },
      ],
      activityEntries: [
        {
          activityId: 'meter-reading',
          category: 'Electricity',
          value: 300,
          unit: 'kWh',
          source: 'api_activity',
          isRenewable: true,
          proofHash: 'proof-electricity',
        },
      ],
      history: { pastAverageMonthlyEmissions: 200 },
    });

    const result = orchestrator.calculateFootprint(
      normalized.spendData,
      normalized.activityData,
      normalized.history,
    );

    expect(normalized.dataSourceKind).toBe('hybrid');
    expect(normalized.sourceSummary.overriddenCategories).toEqual([
      'Electricity',
    ]);
    expect(result.totalEmissions).toBe(195.24);
    expect(result.baseReduction).toBe(400.88);
    expect(result.multiplierApplied).toBe(1.0119);
    expect(result.finalRewards).toBe(405.65);
  });

  it('routes manual and receipt inputs into spend/activity domain records', () => {
    const normalized = orchestrator.normalizeInput({
      spendEntries: [
        {
          spendId: 'manual-food',
          category: 'Vegetables',
          amount: 5_000,
          source: 'manual',
        },
        {
          spendId: 'receipt-electricity',
          category: 'Electricity',
          amount: 200,
          source: 'ocr',
          proofHash: 'proof-receipt',
        },
      ],
      activityEntries: [
        {
          activityId: 'manual-transport',
          category: 'RailwayTransportPassengers',
          value: 10,
          unit: 'km',
          source: 'manual',
        },
      ],
      history: { pastAverageMonthlyEmissions: 90 },
    });

    expect(normalized.spendData).toEqual([
      {
        sourceId: 'manual-food',
        category: 'Vegetables',
        amount: 5_000,
        origin: 'manual',
      },
      {
        sourceId: 'receipt-electricity',
        category: 'Electricity',
        amount: 200,
        origin: 'ocr',
      },
    ]);
    expect(normalized.activityData).toEqual([
      {
        sourceId: 'manual-transport',
        category: 'RailwayTransportPassengers',
        value: 10,
        unit: 'km',
        origin: 'manual',
      },
    ]);
    expect(normalized.sourceSummary.origins).toEqual(['manual', 'ocr']);
    expect(normalized.sourceSummary.categories).toEqual([
      'Electricity',
      'RailwayTransportPassengers',
      'Vegetables',
    ]);
  });

  it('applies the minimum multiplier clamp when emissions worsen significantly', () => {
    expect(calculateDynamicMultiplier(400, 100)).toBe(0.5);
  });

  it('keeps the multiplier within the maximum cap and defaults to 1 with no history', () => {
    expect(calculateDynamicMultiplier(-100, 100)).toBe(1.5);
    expect(calculateDynamicMultiplier(50, 0)).toBe(1);
  });

  it('does not treat negative deltas as reductions', () => {
    const normalized = orchestrator.normalizeInput({
      spendEntries: [
        {
          spendId: 'txn-fuel',
          category: 'GasSupply',
          amount: 10,
          source: 'open_banking',
        },
      ],
      activityEntries: [
        {
          activityId: 'fuel-usage',
          category: 'GasSupply',
          value: 200,
          unit: 'liter',
          source: 'api_activity',
        },
      ],
      history: { pastAverageMonthlyEmissions: 20 },
    });

    const result = orchestrator.calculateFootprint(
      normalized.spendData,
      normalized.activityData,
      normalized.history,
    );

    expect(result.totalEmissions).toBe(0);
    expect(result.baseReduction).toBe(0.07);
    expect(result.multiplierApplied).toBe(1.5);
    expect(result.finalRewards).toBe(0.11);
  });
});
