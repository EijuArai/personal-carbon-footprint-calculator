#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

ensure_commands
prepare_local_e2e_materials
wait_for_rpc

export PLAYWRIGHT_SOLANA_RPC_URL="${PLAYWRIGHT_SOLANA_RPC_URL:-$SOLANA_RPC_URL}"
export GREEN_REPUTATION_PROGRAM_ID="${GREEN_REPUTATION_PROGRAM_ID:-$PROGRAM_ID}"

cd "$ROOT_DIR/frontend"

node --input-type=module <<'EOF'
import * as anchor from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const { AnchorProvider, Program } = anchor;
const USER_SBT_MINT_SEED = Buffer.from("user-sbt-mint");
const EMPTY_PUBLIC_KEY = "11111111111111111111111111111111";
const RANK_NAMES = ["Sprout", "Seedling", "Sapling", "Tree", "Forest"];
const DATA_SOURCE_NAMES = ["Manual", "Spend", "Activity", "Receipt", "Hybrid"];

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, "..");
const solanaDir = path.resolve(rootDir, "solana");
const rpcUrl = process.env.PLAYWRIGHT_SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const programId = new PublicKey(
  process.env.GREEN_REPUTATION_PROGRAM_ID ??
    "68EBpJsPtNkbgvF3PhNFQbtnxYvSoBCCN6QoMYGJ8xzi",
);

const idl = JSON.parse(
  readFileSync(path.resolve(solanaDir, "target/idl/green_reputation.json"), "utf8"),
);

const provider = new AnchorProvider(
  new Connection(rpcUrl, "confirmed"),
  createReadonlyWallet(),
  { commitment: "confirmed", preflightCommitment: "confirmed" },
);
const program = new Program(idl, provider);
const connection = provider.connection;

const userProfiles = await program.account.userProfile.all();
const footprintCommitments = await program.account.footprintCommitment.all();

const report = {
  rpcUrl,
  programId: programId.toBase58(),
  fetchedAt: new Date().toISOString(),
  userCount: userProfiles.length,
  users: await Promise.all(
    userProfiles.map(async ({ publicKey: profileAddress, account }) => {
      const walletAddress = account.user;
      const commitmentAccounts = footprintCommitments.filter(({ account: commitment }) =>
        commitment.user.equals(walletAddress),
      );

      const derivedSbtMint = PublicKey.findProgramAddressSync(
        [USER_SBT_MINT_SEED, profileAddress.toBuffer()],
        programId,
      )[0];

      const sbtMintAddress = account.sbtMint;
      const sbtTokenAccountAddress = account.sbtTokenAccount;

      const [userLamports, profileLamports, sbtMintInfo, sbtTokenAccountInfo] = await Promise.all([
        connection.getBalance(walletAddress),
        connection.getBalance(profileAddress),
        readAccount(connection, sbtMintAddress),
        readAccount(connection, sbtTokenAccountAddress),
      ]);

      return {
        walletAddress: walletAddress.toBase58(),
        walletLamports: String(userLamports),
        userProfileAddress: profileAddress.toBase58(),
        userProfileLamports: String(profileLamports),
        userProfile: mapUserProfile(account),
        relatedAccounts: {
          derivedSbtMintAddress: derivedSbtMint.toBase58(),
          sbtMintAddress: sbtMintAddress.toBase58(),
          sbtMintMatchesDerived: derivedSbtMint.equals(sbtMintAddress),
          sbtTokenAccountAddress: sbtTokenAccountAddress.toBase58(),
          sbtMintAccount: sbtMintInfo,
          sbtTokenAccount: sbtTokenAccountInfo,
        },
        footprintCommitments: commitmentAccounts.map(({ publicKey, account: commitment }) => ({
          address: publicKey.toBase58(),
          lamports: undefined,
          account: mapFootprintCommitment(commitment),
        })),
      };
    }),
  ),
};

for (const user of report.users) {
  const balances = await Promise.all(
    user.footprintCommitments.map((commitment) =>
      connection.getBalance(new PublicKey(commitment.address)),
    ),
  );
  user.footprintCommitments = user.footprintCommitments.map((commitment, index) => ({
    ...commitment,
    lamports: String(balances[index] ?? 0),
  }));
}

console.log(JSON.stringify(report, null, 2));

function mapUserProfile(account) {
  return {
    bump: Number(account.bump),
    version: Number(account.version),
    rank: {
      code: Number(account.rank),
      label: RANK_NAMES[Number(account.rank)] ?? `Unknown(${String(account.rank)})`,
    },
    user: account.user.toBase58(),
    sponsor: account.sponsor.toBase58(),
    sbtMint: account.sbtMint.toBase58(),
    sbtTokenAccount: account.sbtTokenAccount.toBase58(),
    totalEmissionsGrams: bnLikeToString(account.totalEmissionsGrams),
    totalReducedGrams: bnLikeToString(account.totalReducedGrams),
    pendingRewardLamports: bnLikeToString(account.pendingRewardLamports),
    totalClaimedLamports: bnLikeToString(account.totalClaimedLamports),
    commitmentCount: bnLikeToString(account.commitmentCount),
    lastVerifiedAt: bnLikeToNumber(account.lastVerifiedAt),
    latestPeriodKey: bnLikeToString(account.latestPeriodKey),
    metadataVersion: Number(account.metadataVersion),
    latestCommitmentHashHex: bytesToHex(account.latestCommitmentHash),
    metadataUriHashHex: bytesToHex(account.metadataUriHash),
    lastMetadataSyncAt: bnLikeToNumber(account.lastMetadataSyncAt),
    sbtMintedAt: bnLikeToNumber(account.sbtMintedAt),
    emissionHistoryBytesHex: bytesToHex(account.emissionHistory),
    emissionHistoryEntries: decodeEmissionHistory(account.emissionHistory),
    publicProfile: {
      displayAlias: String(account.publicProfile?.displayAlias ?? ""),
      countryCode: String(account.publicProfile?.countryCode ?? ""),
      avatarUri: String(account.publicProfile?.avatarUri ?? ""),
    },
    hasMintedSbt: account.sbtMint.toBase58() !== EMPTY_PUBLIC_KEY,
  };
}

function mapFootprintCommitment(account) {
  const sourceKindCode = Number(account.sourceKind);
  return {
    bump: Number(account.bump),
    version: Number(account.version),
    sourceKind: {
      code: sourceKindCode,
      label: DATA_SOURCE_NAMES[sourceKindCode] ?? `Unknown(${String(account.sourceKind)})`,
    },
    user: account.user.toBase58(),
    userProfile: account.userProfile.toBase58(),
    verifier: account.verifier.toBase58(),
    periodKey: bnLikeToString(account.periodKey),
    commitmentHashHex: bytesToHex(account.commitmentHash),
    emissionDeltaGrams: bnLikeToString(account.emissionDeltaGrams),
    reductionDeltaGrams: bnLikeToString(account.reductionDeltaGrams),
    rewardDeltaLamports: bnLikeToString(account.rewardDeltaLamports),
    verifiedAt: bnLikeToNumber(account.verifiedAt),
  };
}

async function readAccount(connection, address) {
  if (!(address instanceof PublicKey) || address.toBase58() === EMPTY_PUBLIC_KEY) {
    return null;
  }

  const [accountInfo, parsedInfo] = await Promise.all([
    connection.getAccountInfo(address, "confirmed"),
    connection.getParsedAccountInfo(address, "confirmed"),
  ]);

  if (!accountInfo) {
    return null;
  }

  return {
    address: address.toBase58(),
    owner: accountInfo.owner.toBase58(),
    lamports: String(accountInfo.lamports),
    executable: accountInfo.executable,
    rentEpoch: String(accountInfo.rentEpoch),
    space: accountInfo.data.length,
    dataBase64: accountInfo.data.toString("base64"),
    parsed: normalizeParsedAccount(parsedInfo.value?.data ?? null),
  };
}

function normalizeParsedAccount(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeParsedAccount(entry));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeParsedAccount(entry)]),
  );
}

function bnLikeToString(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value.toString === "function") {
    return value.toString();
  }
  return "0";
}

function bnLikeToNumber(value) {
  if (typeof value === "number") {
    return value;
  }
  return Number(bnLikeToString(value));
}

function bytesToHex(value) {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  if (Array.isArray(value)) {
    return Buffer.from(value).toString("hex");
  }
  return "";
}

function decodeEmissionHistory(value) {
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value ?? []);
  const entries = [];

  for (let offset = 0; offset + 16 <= bytes.length; offset += 16) {
    const timestampView = bytes.slice(offset, offset + 8);
    const emissionView = bytes.slice(offset + 8, offset + 16);
    entries.push({
      dayStartTimestamp: Number(readBigInt64Le(timestampView)),
      emissionGrams: readBigUInt64Le(emissionView).toString(),
    });
  }

  return entries;
}

function readBigInt64Le(bytes) {
  const buffer = Buffer.from(bytes);
  return buffer.readBigInt64LE(0);
}

function readBigUInt64Le(bytes) {
  const buffer = Buffer.from(bytes);
  return buffer.readBigUInt64LE(0);
}

function createReadonlyWallet() {
  const keypair = Keypair.generate();

  return {
    payer: keypair,
    publicKey: keypair.publicKey,
    async signTransaction(transaction) {
      return transaction;
    },
    async signAllTransactions(transactions) {
      return transactions;
    },
  };
}
EOF