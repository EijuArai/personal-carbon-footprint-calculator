import { Buffer } from "buffer";
import {
  AnchorProvider,
  Program,
  type Idl,
  type Wallet,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

import type {
  PublicProfile,
  RankCode,
  WalletConnectionState,
  WalletProfileAdapter,
  WalletProfileSnapshot,
} from "../../lib/domain";

const PROTOCOL_CONFIG_SEED = new TextEncoder().encode("protocol-config");
const USER_PROFILE_SEED = new TextEncoder().encode("user-profile");
const USER_SBT_MINT_SEED = new TextEncoder().encode("user-sbt-mint");
const REWARD_TREASURY_SEED = new TextEncoder().encode("reward-treasury");
const REWARD_TREASURY_VAULT_SEED = new TextEncoder().encode(
  "reward-treasury-vault",
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const EMPTY_PUBLIC_KEY = "11111111111111111111111111111111";
const rankCodes: RankCode[] = [
  "Sprout",
  "Seedling",
  "Sapling",
  "Tree",
  "Forest",
];

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

const greenReputationFrontendIdl = {
  address: EMPTY_PUBLIC_KEY,
  metadata: {
    name: "greenReputation",
    version: "0.1.0",
    spec: "0.1.0",
    description: "Frontend minimal IDL for local E2E wallet flows",
  },
  instructions: [
    {
      name: "registerUser",
      discriminator: [2, 241, 150, 223, 99, 214, 116, 97],
      accounts: [
        { name: "protocolConfig" },
        { name: "user", writable: true, signer: true },
        { name: "sponsor", writable: true, signer: true },
        { name: "userProfile", writable: true },
        { name: "systemProgram", address: EMPTY_PUBLIC_KEY },
      ],
      args: [
        { name: "publicProfile", type: { defined: { name: "publicProfile" } } },
      ],
    },
    {
      name: "mintUserSbt",
      discriminator: [183, 162, 26, 53, 60, 235, 188, 188],
      accounts: [
        { name: "protocolConfig" },
        { name: "user", writable: true, signer: true },
        { name: "sponsor", writable: true, signer: true },
        { name: "userProfile", writable: true },
        { name: "mintAuthority", writable: true, signer: true },
        { name: "sbtMint", writable: true },
        { name: "userSbtTokenAccount", writable: true },
        { name: "tokenProgram", address: TOKEN_2022_PROGRAM_ID.toBase58() },
        {
          name: "associatedTokenProgram",
          address: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
        },
        { name: "systemProgram", address: EMPTY_PUBLIC_KEY },
      ],
      args: [],
    },
    {
      name: "updatePublicProfile",
      discriminator: [185, 30, 137, 41, 170, 140, 21, 53],
      accounts: [
        { name: "user", signer: true },
        { name: "userProfile", writable: true },
      ],
      args: [
        { name: "publicProfile", type: { defined: { name: "publicProfile" } } },
      ],
    },
    {
      name: "claimReward",
      discriminator: [149, 95, 181, 242, 94, 90, 158, 162],
      accounts: [
        { name: "user", writable: true, signer: true },
        { name: "userProfile", writable: true },
        { name: "rewardTreasury", writable: true },
        { name: "treasuryVault", writable: true },
        { name: "systemProgram", address: EMPTY_PUBLIC_KEY },
      ],
      args: [],
    },
  ],
  accounts: [
    {
      name: "userProfile",
      discriminator: [32, 37, 119, 205, 179, 180, 13, 194],
    },
  ],
  types: [
    {
      name: "publicProfile",
      type: {
        kind: "struct",
        fields: [
          { name: "displayAlias", type: "string" },
          { name: "countryCode", type: "string" },
          { name: "avatarUri", type: "string" },
        ],
      },
    },
    {
      name: "userProfile",
      type: {
        kind: "struct",
        fields: [
          { name: "bump", type: "u8" },
          { name: "version", type: "u16" },
          { name: "rank", type: "u8" },
          { name: "user", type: "pubkey" },
          { name: "sponsor", type: "pubkey" },
          { name: "sbtMint", type: "pubkey" },
          { name: "sbtTokenAccount", type: "pubkey" },
          { name: "totalEmissionsGrams", type: "u64" },
          { name: "totalReducedGrams", type: "u64" },
          { name: "pendingRewardLamports", type: "u64" },
          { name: "totalClaimedLamports", type: "u64" },
          { name: "commitmentCount", type: "u64" },
          { name: "lastVerifiedAt", type: "i64" },
          { name: "latestPeriodKey", type: "u64" },
          { name: "metadataVersion", type: "u32" },
          { name: "latestCommitmentHash", type: { array: ["u8", 32] } },
          { name: "metadataUriHash", type: { array: ["u8", 32] } },
          { name: "lastMetadataSyncAt", type: "i64" },
          { name: "sbtMintedAt", type: "i64" },
          { name: "emissionHistory", type: "bytes" },
          {
            name: "publicProfile",
            type: { defined: { name: "publicProfile" } },
          },
        ],
      },
    },
  ],
} as const;

export interface LocalE2EWalletProfileAdapterOptions {
  rpcUrl: string;
  programId: string;
  userSecretKeyJson: string;
  mintAuthoritySecretKeyJson: string;
}

interface LocalE2EWalletClient {
  walletAddress: string;
  loadSnapshot(walletAddress: string): Promise<WalletProfileSnapshot>;
  registerPublicProfile(input: PublicProfile): Promise<WalletProfileSnapshot>;
  updatePublicProfile(input: PublicProfile): Promise<WalletProfileSnapshot>;
  mintUserSbt(): Promise<WalletProfileSnapshot>;
  claimReward(): Promise<WalletProfileSnapshot>;
}

interface CreateLocalE2EWalletProfileAdapterDependencies {
  createClient?: (
    options: LocalE2EWalletProfileAdapterOptions,
  ) => LocalE2EWalletClient;
}

export function createLocalE2EWalletProfileAdapter(
  options: LocalE2EWalletProfileAdapterOptions,
  dependencies: CreateLocalE2EWalletProfileAdapterDependencies = {},
): WalletProfileAdapter {
  if (!options.userSecretKeyJson.trim()) {
    throw new Error("Local E2E user signer secret is required.");
  }

  if (!options.mintAuthoritySecretKeyJson.trim()) {
    throw new Error("Local E2E mint authority signer secret is required.");
  }

  const userSigner = parseKeypair(
    "Local E2E user signer",
    options.userSecretKeyJson,
  );
  const client = (
    dependencies.createClient ?? createAnchorLocalE2EWalletClient
  )(options);
  let connectionState: WalletConnectionState = { phase: "disconnected" };

  function requireConnected(): string {
    if (
      connectionState.phase !== "connected" ||
      !connectionState.walletAddress
    ) {
      throw new Error("Connect the local E2E wallet before continuing.");
    }

    return connectionState.walletAddress;
  }

  return {
    async getConnectionState() {
      return connectionState;
    },
    async connectWallet() {
      connectionState = {
        phase: "connected",
        walletAddress: client.walletAddress,
      };
      return connectionState;
    },
    async signAuthMessage(message: string) {
      requireConnected();
      const signature = nacl.sign.detached(
        Uint8Array.from(new TextEncoder().encode(message)),
        Uint8Array.from(userSigner.secretKey),
      );

      return Buffer.from(signature).toString("base64");
    },
    async getProfileSnapshot(walletAddress: string) {
      return await client.loadSnapshot(walletAddress);
    },
    async registerPublicProfile(input) {
      requireConnected();
      return await client.registerPublicProfile(input);
    },
    async mintUserSbt() {
      requireConnected();
      return await client.mintUserSbt();
    },
    async updatePublicProfile(input) {
      requireConnected();
      return await client.updatePublicProfile(input);
    },
    async claimReward() {
      requireConnected();
      return await client.claimReward();
    },
  };
}

function createAnchorLocalE2EWalletClient(
  options: LocalE2EWalletProfileAdapterOptions,
): LocalE2EWalletClient {
  const user = parseKeypair("Local E2E user signer", options.userSecretKeyJson);
  const mintAuthority = parseKeypair(
    "Local E2E mint authority signer",
    options.mintAuthoritySecretKeyJson,
  );
  const connection = new Connection(options.rpcUrl, "confirmed");
  const provider = new AnchorProvider(
    connection,
    createAnchorWallet(user),
    AnchorProvider.defaultOptions(),
  );
  const program = new Program(
    buildFrontendIdl(options.programId),
    provider,
  ) as any;
  const protocolConfig = PublicKey.findProgramAddressSync(
    [PROTOCOL_CONFIG_SEED],
    program.programId,
  )[0];
  const rewardTreasury = PublicKey.findProgramAddressSync(
    [REWARD_TREASURY_SEED],
    program.programId,
  )[0];
  const treasuryVault = PublicKey.findProgramAddressSync(
    [REWARD_TREASURY_VAULT_SEED],
    program.programId,
  )[0];
  const userProfile = PublicKey.findProgramAddressSync(
    [USER_PROFILE_SEED, publicKeyBytes(user.publicKey)],
    program.programId,
  )[0];

  async function loadSnapshot(
    walletAddress: string,
  ): Promise<WalletProfileSnapshot> {
    const walletPublicKey = new PublicKey(walletAddress);
    const profileAddress = PublicKey.findProgramAddressSync(
      [USER_PROFILE_SEED, publicKeyBytes(walletPublicKey)],
      program.programId,
    )[0];
    const profile =
      await program.account.userProfile.fetchNullable(profileAddress);

    console.log("Loaded local E2E wallet profile snapshot:", {
      walletAddress,
      profile: profile
        ? {
            ...profile,
            user: profile.user.toBase58(),
            sponsor: profile.sponsor.toBase58(),
            sbtMint: profile.sbtMint.toBase58(),
            sbtTokenAccount: profile.sbtTokenAccount.toBase58(),
          }
        : null,
    });

    if (!profile) {
      return {
        walletAddress,
        profileAddress: profileAddress.toBase58(),
        totalEmissionsKgCo2e: 0,
        totalReductionsKgCo2e: 0,
        pendingRewardLamports: 0n,
        isRegistered: false,
        hasMintedSbt: false,
      };
    }

    return mapUserProfileSnapshot(walletAddress, profileAddress, profile);
  }

  async function waitForSnapshot(
    predicate: (snapshot: WalletProfileSnapshot) => boolean,
    timeoutMs = 15_000,
  ): Promise<WalletProfileSnapshot> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const snapshot = await loadSnapshot(user.publicKey.toBase58());
      if (predicate(snapshot)) {
        return snapshot;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
      "Timed out waiting for the local E2E wallet profile snapshot to update.",
    );
  }

  return {
    walletAddress: user.publicKey.toBase58(),
    loadSnapshot,
    async registerPublicProfile(input) {
      await program.methods
        .registerUser({
          displayAlias: input.displayAlias,
          countryCode: input.countryCode,
          avatarUri: input.avatarUri,
        })
        .accounts({
          protocolConfig,
          user: user.publicKey,
          sponsor: user.publicKey,
          userProfile,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      return await waitForSnapshot(
        (snapshot) =>
          snapshot.isRegistered &&
          snapshot.publicProfile?.displayAlias === input.displayAlias &&
          snapshot.publicProfile?.countryCode === input.countryCode &&
          snapshot.publicProfile?.avatarUri === input.avatarUri,
      );
    },
    async updatePublicProfile(input) {
      await program.methods
        .updatePublicProfile({
          displayAlias: input.displayAlias,
          countryCode: input.countryCode,
          avatarUri: input.avatarUri,
        })
        .accounts({
          user: user.publicKey,
          userProfile,
        })
        .rpc();

      return await waitForSnapshot(
        (snapshot) =>
          snapshot.isRegistered &&
          snapshot.publicProfile?.displayAlias === input.displayAlias &&
          snapshot.publicProfile?.countryCode === input.countryCode &&
          snapshot.publicProfile?.avatarUri === input.avatarUri,
      );
    },
    async mintUserSbt() {
      const sbtMint = PublicKey.findProgramAddressSync(
        [USER_SBT_MINT_SEED, publicKeyBytes(userProfile)],
        program.programId,
      )[0];
      const userSbtTokenAccount = PublicKey.findProgramAddressSync(
        [
          publicKeyBytes(user.publicKey),
          publicKeyBytes(TOKEN_2022_PROGRAM_ID),
          publicKeyBytes(sbtMint),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID,
      )[0];

      await program.methods
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

      return await waitForSnapshot((snapshot) => snapshot.hasMintedSbt);
    },
    async claimReward() {
      const currentSnapshot = await loadSnapshot(user.publicKey.toBase58());

      await program.methods
        .claimReward()
        .accounts({
          user: user.publicKey,
          userProfile,
          rewardTreasury,
          treasuryVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      return await waitForSnapshot(
        (snapshot) =>
          snapshot.pendingRewardLamports === 0n &&
          snapshot.pendingRewardLamports !==
            currentSnapshot.pendingRewardLamports,
      );
    },
  };
}

export function buildFrontendIdl(programId: string): Idl {
  return {
    ...(greenReputationFrontendIdl as unknown as Idl),
    address: programId,
  };
}

function parseKeypair(label: string, secretKeyJson: string): Keypair {
  let parsed: unknown;

  try {
    parsed = JSON.parse(secretKeyJson) as unknown;
  } catch {
    throw new Error(
      `${label} must be valid JSON containing a 64-byte secret key array.`,
    );
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    parsed.some((entry) => !Number.isInteger(entry))
  ) {
    throw new Error(`${label} must be a JSON array of 64 integers.`);
  }

  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function createAnchorWallet(signer: Keypair): Wallet {
  return {
    payer: signer,
    publicKey: signer.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(
      transaction: T,
    ): Promise<T> {
      if (
        "partialSign" in transaction &&
        typeof transaction.partialSign === "function"
      ) {
        transaction.partialSign(signer);
      } else if (
        "sign" in transaction &&
        typeof transaction.sign === "function"
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
          "partialSign" in transaction &&
          typeof transaction.partialSign === "function"
        ) {
          transaction.partialSign(signer);
        } else if (
          "sign" in transaction &&
          typeof transaction.sign === "function"
        ) {
          (transaction as { sign(signers: Keypair[]): void }).sign([signer]);
        }
      }

      return transactions;
    },
  } as Wallet;
}

function publicKeyBytes(publicKey: PublicKey): Uint8Array {
  return publicKey.toBytes();
}

function mapUserProfileSnapshot(
  walletAddress: string,
  profileAddress: PublicKey,
  profile: Record<string, unknown>,
): WalletProfileSnapshot {
  const publicProfile = profile.publicProfile as
    | Record<string, unknown>
    | undefined;
  const rankIndex = toNumberValue(profile.rank);
  const metadataVersion = toNumberValue(profile.metadataVersion);
  const snapshot: WalletProfileSnapshot = {
    walletAddress,
    profileAddress: profileAddress.toBase58(),
    ...(publicProfile
      ? {
          publicProfile: {
            displayAlias: String(publicProfile.displayAlias ?? ""),
            countryCode: String(publicProfile.countryCode ?? ""),
            avatarUri: String(publicProfile.avatarUri ?? ""),
          },
        }
      : {}),
    ...(typeof rankIndex === "number" && rankCodes[rankIndex]
      ? { rank: rankCodes[rankIndex] }
      : {}),
    totalEmissionsKgCo2e: gramsToKg(toBigIntValue(profile.totalEmissionsGrams)),
    totalReductionsKgCo2e: gramsToKg(toBigIntValue(profile.totalReducedGrams)),
    pendingRewardLamports: toBigIntValue(profile.pendingRewardLamports),
    isRegistered: true,
    hasMintedSbt: publicKeyToBase58(profile.sbtMint) !== EMPTY_PUBLIC_KEY,
  };

  if (metadataVersion !== undefined) {
    snapshot.metadataVersion = metadataVersion;
  }

  return snapshot;
}

function publicKeyToBase58(value: unknown): string {
  if (value instanceof PublicKey) {
    return value.toBase58();
  }

  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toBase58" in value &&
    typeof value.toBase58 === "function"
  ) {
    return (value as { toBase58(): string }).toBase58();
  }

  return EMPTY_PUBLIC_KEY;
}

function toBigIntValue(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(value);
  }

  if (typeof value === "string") {
    return BigInt(value);
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    return BigInt(value.toString());
  }

  return 0n;
}

function toNumberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function gramsToKg(value: bigint): number {
  return Number(value) / 1000;
}
