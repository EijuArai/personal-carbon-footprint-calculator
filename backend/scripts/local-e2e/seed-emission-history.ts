import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  AnchorProvider,
  Program,
  type Idl,
  type Wallet,
} from '@coral-xyz/anchor';
import BN from 'bn.js';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';

import greenReputationIdl from '../../../solana/target/idl/green_reputation.json' with { type: 'json' };

const PROTOCOL_CONFIG_SEED = Buffer.from('protocol-config');
const USER_PROFILE_SEED = Buffer.from('user-profile');
const USER_SBT_MINT_SEED = Buffer.from('user-sbt-mint');
const REWARD_TREASURY_SEED = Buffer.from('reward-treasury');
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
const EMPTY_PUBLIC_KEY = '11111111111111111111111111111111';
const DEFAULT_HISTORY_DAYS = 30;
const DEFAULT_DAILY_EMISSION_GRAMS = 25_000; // Average daily emissions of a Japanese citizen in grams of CO2e according to National Institute for Environmental Studies.

interface SeedOptions {
  rpcUrl: string;
  programId: PublicKey;
  userKeypairPath: string;
  adminKeypairPath: string;
  mintAuthorityKeypairPath: string;
  days: number;
  dailyEmissionGrams: bigint;
  displayAlias: string;
  countryCode: string;
  avatarUri: string;
}

interface UserProfileSnapshot {
  metadataVersion: number;
  commitmentCount: bigint;
  totalEmissionsGrams: bigint;
  emissionHistory: Uint8Array;
  hasMintedSbt: boolean;
}

interface RuntimeClients {
  connection: Connection;
  userProgram: any;
  adminProvider: AnchorProvider;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const user = loadKeypairFromFile(options.userKeypairPath);
  const admin = loadKeypairFromFile(options.adminKeypairPath);
  const mintAuthority = loadKeypairFromFile(options.mintAuthorityKeypairPath);
  const { connection, userProgram, adminProvider } = createRuntimeClients(
    options,
    user,
    admin,
  );

  if (!userProgram.programId.equals(options.programId)) {
    throw new Error(
      `Program id mismatch. Expected ${options.programId.toBase58()} but IDL is for ${userProgram.programId.toBase58()}.`,
    );
  }

  const protocolConfig = PublicKey.findProgramAddressSync(
    [PROTOCOL_CONFIG_SEED],
    options.programId,
  )[0];
  const rewardTreasury = PublicKey.findProgramAddressSync(
    [REWARD_TREASURY_SEED],
    options.programId,
  )[0];
  const userProfile = PublicKey.findProgramAddressSync(
    [USER_PROFILE_SEED, user.publicKey.toBuffer()],
    options.programId,
  )[0];
  const sbtMint = PublicKey.findProgramAddressSync(
    [USER_SBT_MINT_SEED, userProfile.toBuffer()],
    options.programId,
  )[0];
  const userSbtTokenAccount = PublicKey.findProgramAddressSync(
    [
      user.publicKey.toBuffer(),
      TOKEN_2022_PROGRAM_ID.toBuffer(),
      sbtMint.toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];

  console.log(`RPC: ${options.rpcUrl}`);
  console.log(`Program: ${options.programId.toBase58()}`);
  console.log(`User: ${user.publicKey.toBase58()}`);
  console.log(
    `Seeding ${options.days} days at ${options.dailyEmissionGrams.toString()} gCO2e/day`,
  );

  await assertAccountExists(connection, protocolConfig, 'protocol config');
  await assertAccountExists(connection, rewardTreasury, 'reward treasury');

  let startingSnapshot = await fetchUserProfileSnapshot(
    userProgram,
    userProfile,
  );

  if (!startingSnapshot) {
    console.log('Registering local E2E user profile');
    const signature = await userProgram.methods
      .registerUser({
        displayAlias: options.displayAlias,
        countryCode: options.countryCode,
        avatarUri: options.avatarUri,
      })
      .accounts({
        protocolConfig,
        user: user.publicKey,
        sponsor: user.publicKey,
        userProfile,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await waitForSignatureFinalized(connection, signature, 'user registration');
    startingSnapshot = await waitForUserProfile(userProgram, userProfile);
  }

  if (!startingSnapshot.hasMintedSbt) {
    console.log('Minting local E2E SBT');
    const signature = await userProgram.methods
      .mintUserSbt()
      .accounts({
        protocolConfig,
        user: user.publicKey,
        sponsor: user.publicKey,
        userProfile,
        mintAuthority: mintAuthority.publicKey,
        sbtMint,
        userSbtTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([mintAuthority])
      .rpc();
    await waitForSignatureFinalized(connection, signature, 'SBT mint');
    startingSnapshot = await waitForUserProfile(
      userProgram,
      userProfile,
      (snapshot) => snapshot.hasMintedSbt,
    );
  }

  const existingHistoryEntries = decodeEmissionHistory(
    startingSnapshot.emissionHistory,
  ).length;
  if (existingHistoryEntries > 0) {
    console.log(
      `Existing emission history detected (${existingHistoryEntries} entries). The seeded history will overwrite the current rolling window.`,
    );
  }

  const endTimestamp = Math.floor(Date.now() / 1000);
  const historyBytes = createDailyEmissionHistory(
    options.days,
    options.dailyEmissionGrams,
    endTimestamp,
  );
  const totalEmissionsGrams = options.dailyEmissionGrams * BigInt(options.days);

  console.log(`Seeding ${options.days} history entries directly`);
  const seedSignature = await sendAdminSeedEmissionHistory({
    provider: adminProvider,
    programId: options.programId,
    args: {
      emissionHistory: historyBytes,
      lastVerifiedAt: endTimestamp,
      totalEmissionsGrams,
      commitmentCount: BigInt(options.days),
    },
    accounts: {
      protocolConfig,
      admin: admin.publicKey,
      userProfile,
    },
  });
  await waitForSignatureFinalized(
    connection,
    seedSignature,
    'emission history seeding',
  );

  const latestSnapshot = await waitForUserProfile(
    userProgram,
    userProfile,
    (snapshot) =>
      decodeEmissionHistory(snapshot.emissionHistory).length === options.days &&
      snapshot.totalEmissionsGrams === totalEmissionsGrams &&
      snapshot.commitmentCount === BigInt(options.days),
  );

  const finalHistory = decodeEmissionHistory(latestSnapshot.emissionHistory);
  const trailingMonthEmissionsGrams = finalHistory.reduce(
    (total, entry) => total + entry.emissionGrams,
    0n,
  );

  console.log('');
  console.log('Seed complete');
  console.log(`  history entries: ${finalHistory.length}`);
  console.log(
    `  commitmentCount: ${latestSnapshot.commitmentCount.toString()}`,
  );
  console.log(
    `  trailing 30-day emissions: ${gramsToKg(trailingMonthEmissionsGrams).toFixed(2)} kgCO2e`,
  );
  console.log(
    '  next step: run the reward verification submission right away on this local validator day',
  );
}

function createRuntimeClients(
  options: SeedOptions,
  user: Keypair,
  admin: Keypair,
): RuntimeClients {
  const connection = new Connection(options.rpcUrl, 'confirmed');
  const userProvider = new AnchorProvider(
    connection,
    createWallet(user),
    AnchorProvider.defaultOptions(),
  );
  const adminProvider = new AnchorProvider(
    connection,
    createWallet(admin),
    AnchorProvider.defaultOptions(),
  );
  const userProgram = new Program(
    greenReputationIdl as Idl,
    userProvider,
  ) as any;

  if (!userProgram.programId.equals(options.programId)) {
    throw new Error(
      `Program id mismatch. Expected ${options.programId.toBase58()} but IDL is for ${userProgram.programId.toBase58()}.`,
    );
  }

  return {
    connection,
    userProgram,
    adminProvider,
  };
}

function parseOptions(argv: string[]): SeedOptions {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unknown positional argument: ${argument}`);
    }

    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }

    values.set(name, value);
    index += 1;
  }

  const rpcUrl = values.get('rpc-url') ?? requiredEnv('SOLANA_RPC_URL');
  const programId = new PublicKey(
    values.get('program-id') ?? requiredEnv('GREEN_REPUTATION_PROGRAM_ID'),
  );
  const days = parsePositiveInteger(
    values.get('days') ?? String(DEFAULT_HISTORY_DAYS),
    '--days',
  );
  if (days > DEFAULT_HISTORY_DAYS) {
    throw new Error(`--days must be ${DEFAULT_HISTORY_DAYS} or less.`);
  }
  const dailyEmissionGrams = parsePositiveBigInt(
    values.get('daily-emission-grams') ?? String(DEFAULT_DAILY_EMISSION_GRAMS),
    '--daily-emission-grams',
  );
  const displayAlias = (values.get('display-alias') ?? 'local-e2e-user').trim();
  const countryCode = (values.get('country-code') ?? 'JP').trim().toUpperCase();
  const avatarUri = (values.get('avatar-uri') ?? '').trim();

  if (!displayAlias) {
    throw new Error('--display-alias must not be empty.');
  }

  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) {
    throw new Error(
      '--country-code must be empty or two uppercase ASCII letters.',
    );
  }

  return {
    rpcUrl,
    programId,
    userKeypairPath:
      values.get('user-keypair') ?? requiredEnv('LOCAL_E2E_USER_KEYPAIR_PATH'),
    adminKeypairPath:
      values.get('admin-keypair') ??
      requiredEnv('LOCAL_E2E_ADMIN_KEYPAIR_PATH'),
    mintAuthorityKeypairPath:
      values.get('mint-authority-keypair') ??
      requiredEnv('LOCAL_E2E_MINT_AUTHORITY_KEYPAIR_PATH'),
    days,
    dailyEmissionGrams,
    displayAlias,
    countryCode,
    avatarUri,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parsePositiveInteger(rawValue: string, flagName: string): number {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function parsePositiveBigInt(rawValue: string, flagName: string): bigint {
  let parsed: bigint;

  try {
    parsed = BigInt(rawValue);
  } catch {
    throw new Error(`${flagName} must be an integer.`);
  }

  if (parsed <= 0n) {
    throw new Error(`${flagName} must be greater than zero.`);
  }

  return parsed;
}

function loadKeypairFromFile(filePath: string): Keypair {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    parsed.some((entry) => !Number.isInteger(entry))
  ) {
    throw new Error(`${filePath} must contain a 64-byte secret key array.`);
  }

  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function createWallet(signer: Keypair): Wallet {
  return {
    payer: signer,
    publicKey: signer.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(
      transaction: T,
    ): Promise<T> {
      if (
        'partialSign' in transaction &&
        typeof transaction.partialSign === 'function'
      ) {
        transaction.partialSign(signer);
      } else if (
        'sign' in transaction &&
        typeof transaction.sign === 'function'
      ) {
        (transaction as { sign(signers: Keypair[]): void }).sign([signer]);
      }
      return transaction;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      transactions: T[],
    ): Promise<T[]> {
      for (const transaction of transactions) {
        if (
          'partialSign' in transaction &&
          typeof transaction.partialSign === 'function'
        ) {
          transaction.partialSign(signer);
        } else if (
          'sign' in transaction &&
          typeof transaction.sign === 'function'
        ) {
          (transaction as { sign(signers: Keypair[]): void }).sign([signer]);
        }
      }
      return transactions;
    },
  } as Wallet;
}

async function assertAccountExists(
  connection: Connection,
  address: PublicKey,
  label: string,
) {
  const account = await connection.getAccountInfo(address);
  if (!account) {
    throw new Error(
      `Missing ${label} account ${address.toBase58()}. Run bash scripts/local-e2e/up.sh first.`,
    );
  }
}

async function fetchUserProfileSnapshot(
  program: any,
  userProfile: PublicKey,
): Promise<UserProfileSnapshot | null> {
  const profile = await program.account.userProfile.fetchNullable(userProfile);
  if (!profile) {
    return null;
  }

  return {
    metadataVersion: Number(profile.metadataVersion ?? 0),
    commitmentCount: toBigInt(profile.commitmentCount),
    totalEmissionsGrams: toBigInt(profile.totalEmissionsGrams),
    emissionHistory: normalizeByteArray(profile.emissionHistory),
    hasMintedSbt: publicKeyToBase58(profile.sbtMint) !== EMPTY_PUBLIC_KEY,
  };
}

async function waitForUserProfile(
  program: any,
  userProfile: PublicKey,
  predicate: (snapshot: UserProfileSnapshot) => boolean = () => true,
  timeoutMs = 15_000,
): Promise<UserProfileSnapshot> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await fetchUserProfileSnapshot(program, userProfile);
    if (snapshot && predicate(snapshot)) {
      return snapshot;
    }
    await sleep(500);
  }

  throw new Error('Timed out waiting for the user profile to update.');
}

function decodeEmissionHistory(bytes: Uint8Array) {
  if (bytes.length === 0) {
    return [] as Array<{ dayStartTimestamp: number; emissionGrams: bigint }>;
  }

  if (bytes.length % 16 !== 0) {
    throw new Error('Emission history bytes are malformed.');
  }

  const entries: Array<{ dayStartTimestamp: number; emissionGrams: bigint }> =
    [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
    entries.push({
      dayStartTimestamp: Number(view.getBigInt64(0, true)),
      emissionGrams: view.getBigUint64(8, true),
    });
  }
  return entries;
}

function normalizeByteArray(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }

  return new Uint8Array();
}

function publicKeyToBase58(value: unknown): string {
  if (value instanceof PublicKey) {
    return value.toBase58();
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'toBase58' in value &&
    typeof value.toBase58 === 'function'
  ) {
    return (value as { toBase58(): string }).toBase58();
  }

  if (typeof value === 'string') {
    return value;
  }

  return EMPTY_PUBLIC_KEY;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    return BigInt(value);
  }

  if (typeof value === 'string') {
    return BigInt(value);
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    return BigInt(value.toString());
  }

  return 0n;
}

function gramsToKg(value: bigint): number {
  return Number(value) / 1000;
}

async function waitForSignatureFinalized(
  connection: Connection,
  signature: string,
  label: string,
) {
  console.log(`  waiting for ${label} to finalize`);
  const result = await connection.confirmTransaction(signature, 'finalized');
  if (result.value.err) {
    throw new Error(
      `${label} failed before finalization: ${JSON.stringify(result.value.err)}`,
    );
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendAdminSeedEmissionHistory(input: {
  provider: AnchorProvider;
  programId: PublicKey;
  args: {
    emissionHistory: Uint8Array;
    lastVerifiedAt: number;
    totalEmissionsGrams: bigint;
    commitmentCount: bigint;
  };
  accounts: {
    protocolConfig: PublicKey;
    admin: PublicKey;
    userProfile: PublicKey;
  };
}) {
  const instruction = new TransactionInstruction({
    programId: input.programId,
    keys: [
      {
        pubkey: input.accounts.protocolConfig,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: input.accounts.admin,
        isSigner: true,
        isWritable: true,
      },
      {
        pubkey: input.accounts.userProfile,
        isSigner: false,
        isWritable: true,
      },
    ],
    data: encodeAdminSeedEmissionHistoryArgs(input.args),
  });

  const transaction = new Transaction().add(instruction);
  return await input.provider.sendAndConfirm(transaction, []);
}

function encodeAdminSeedEmissionHistoryArgs(args: {
  emissionHistory: Uint8Array;
  lastVerifiedAt: number;
  totalEmissionsGrams: bigint;
  commitmentCount: bigint;
}) {
  const discriminator = instructionDiscriminator('admin_seed_emission_history');
  const historyLength = Buffer.alloc(4);
  historyLength.writeUInt32LE(args.emissionHistory.length, 0);

  const lastVerifiedAt = Buffer.alloc(8);
  lastVerifiedAt.writeBigInt64LE(BigInt(args.lastVerifiedAt), 0);

  const totalEmissionsGrams = new BN(
    args.totalEmissionsGrams.toString(),
  ).toArrayLike(Buffer, 'le', 8);
  const commitmentCount = new BN(args.commitmentCount.toString()).toArrayLike(
    Buffer,
    'le',
    8,
  );

  return Buffer.concat([
    discriminator,
    historyLength,
    Buffer.from(args.emissionHistory),
    lastVerifiedAt,
    totalEmissionsGrams,
    commitmentCount,
  ]);
}

function instructionDiscriminator(name: string) {
  return crypto
    .createHash('sha256')
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

function createDailyEmissionHistory(
  days: number,
  dailyEmissionGrams: bigint,
  endTimestamp: number,
): Uint8Array {
  const bytes = new Uint8Array(days * 16);
  const endDayStart = Math.floor(endTimestamp / 86_400) * 86_400 - 86_400;

  for (let index = 0; index < days; index += 1) {
    const dayStart = endDayStart - (days - 1 - index) * 86_400;
    const view = new DataView(bytes.buffer, index * 16, 16);
    view.setBigInt64(0, BigInt(dayStart), true);
    view.setBigUint64(8, dailyEmissionGrams, true);
  }

  return bytes;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
