import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { AnchorProvider, Program, web3 } = anchor;
const { Connection, Keypair, PublicKey, SystemProgram } = web3;

const PROTOCOL_CONFIG_SEED = Buffer.from("protocol-config");
const REWARD_TREASURY_SEED = Buffer.from("reward-treasury");
const REWARD_TREASURY_VAULT_SEED = Buffer.from("reward-treasury-vault");

const rpcUrl = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const programId = new PublicKey(
  process.env.GREEN_REPUTATION_PROGRAM_ID ??
    "68EBpJsPtNkbgvF3PhNFQbtnxYvSoBCCN6QoMYGJ8xzi",
);
const admin = loadKeypairFromFile(requiredEnv("LOCAL_E2E_ADMIN_KEYPAIR_PATH"));
const verifier = loadKeypairFromFile(
  requiredEnv("LOCAL_E2E_VERIFIER_KEYPAIR_PATH"),
);
const metadataAuthority = loadKeypairFromFile(
  requiredEnv("LOCAL_E2E_METADATA_AUTHORITY_KEYPAIR_PATH"),
);
const mintAuthority = loadKeypairFromFile(
  requiredEnv("LOCAL_E2E_MINT_AUTHORITY_KEYPAIR_PATH"),
);

const provider = new AnchorProvider(
  new Connection(rpcUrl, "confirmed"),
  createWallet(admin),
  {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  },
);
anchor.setProvider(provider);

const idl = JSON.parse(
  readFileSync(join(process.cwd(), "target/idl/green_reputation.json"), "utf8"),
);
const program = new Program(idl, provider);

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

const desiredRewardPolicy = {
  lamportsPerKgReduced: new BN(10_000),
  minimumReductionGrams: new BN(100),
  maxLamportsPerPeriod: new BN(50_000),
  maxPendingLamports: new BN(100_000),
};

const desiredRankThresholds = {
  seedlingMinReductionGrams: new BN(1_000),
  saplingMinReductionGrams: new BN(5_000),
  treeMinReductionGrams: new BN(10_000),
  forestMinReductionGrams: new BN(25_000),
};

const targetTreasuryFundingLamports = new BN(200_000);

async function main() {
  const protocolInfo = await fetchNullableAccount(protocolConfig, () =>
    program.account.protocolConfig.fetch(protocolConfig),
  );

  if (!protocolInfo) {
    console.info("Initializing protocol config");
    await program.methods
      .initializeProtocol({
        verifier: verifier.publicKey,
        metadataUpdateAuthority: metadataAuthority.publicKey,
        treasuryAuthority: admin.publicKey,
        sbtMintAuthority: mintAuthority.publicKey,
        rewardPolicy: desiredRewardPolicy,
        rankThresholds: desiredRankThresholds,
        allowThirdPartySponsors: false,
      })
      .accounts({
        admin: admin.publicKey,
        protocolConfig,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await waitForAccount(protocolConfig, () =>
      program.account.protocolConfig.fetch(protocolConfig),
    );
  } else {
    if (!protocolInfo.admin.equals(admin.publicKey)) {
      throw new Error(
        "Existing protocol config is owned by a different admin keypair. Reset the validator before reusing this stack.",
      );
    }

    const updateArgs = {
      verifier: protocolInfo.verifier.equals(verifier.publicKey)
        ? null
        : verifier.publicKey,
      metadataUpdateAuthority: protocolInfo.metadataUpdateAuthority.equals(
        metadataAuthority.publicKey,
      )
        ? null
        : metadataAuthority.publicKey,
      treasuryAuthority: protocolInfo.treasuryAuthority.equals(admin.publicKey)
        ? null
        : admin.publicKey,
      sbtMintAuthority: protocolInfo.sbtMintAuthority.equals(
        mintAuthority.publicKey,
      )
        ? null
        : mintAuthority.publicKey,
      allowThirdPartySponsors:
        protocolInfo.allowThirdPartySponsors === false ? null : false,
      rewardPolicy: rewardPolicyMatches(
        protocolInfo.rewardPolicy,
        desiredRewardPolicy,
      )
        ? null
        : desiredRewardPolicy,
      rankThresholds: rankThresholdsMatch(
        protocolInfo.rankThresholds,
        desiredRankThresholds,
      )
        ? null
        : desiredRankThresholds,
    };

    if (Object.values(updateArgs).some((value) => value !== null)) {
      console.info("Updating protocol config to match local E2E expectations");
      await program.methods
        .updateProtocolConfig(updateArgs)
        .accounts({
          admin: admin.publicKey,
          protocolConfig,
        })
        .rpc();
    }
  }

  const rewardTreasuryInfo = await fetchNullableAccount(rewardTreasury, () =>
    program.account.rewardTreasury.fetch(rewardTreasury),
  );

  if (!rewardTreasuryInfo) {
    console.info("Initializing reward treasury");
    await program.methods
      .initializeRewardTreasury()
      .accounts({
        protocolConfig,
        admin: admin.publicKey,
        rewardTreasury,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await waitForAccount(rewardTreasury, () =>
      program.account.rewardTreasury.fetch(rewardTreasury),
    );
  }

  const currentTreasury = await program.account.rewardTreasury.fetch(
    rewardTreasury,
  );
  const fundedLamports = toBigInt(currentTreasury.totalFundedLamports);
  const disbursedLamports = toBigInt(currentTreasury.totalDisbursedLamports);
  const availableLamports = fundedLamports - disbursedLamports;
  const targetLamports = toBigInt(targetTreasuryFundingLamports);

  if (availableLamports < targetLamports) {
    const topUpAmount = targetLamports - availableLamports;
    console.info(`Funding treasury with ${topUpAmount.toString()} lamports`);
    await program.methods
      .fundTreasury(new BN(topUpAmount.toString()))
      .accounts({
        protocolConfig,
        admin: admin.publicKey,
        rewardTreasury,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  console.info("Local E2E protocol bootstrap complete");
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function loadKeypairFromFile(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));

  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error(
      `${filePath} does not contain a 64-byte Solana secret key array.`,
    );
  }

  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function createWallet(signer) {
  return {
    payer: signer,
    publicKey: signer.publicKey,
    async signTransaction(transaction) {
      if (
        "partialSign" in transaction &&
        typeof transaction.partialSign === "function"
      ) {
        transaction.partialSign(signer);
      } else if (
        "sign" in transaction &&
        typeof transaction.sign === "function"
      ) {
        transaction.sign([signer]);
      }

      return transaction;
    },
    async signAllTransactions(transactions) {
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
          transaction.sign([signer]);
        }
      }

      return transactions;
    },
  };
}

async function fetchNullableAccount(publicKey, fetcher) {
  const info = await provider.connection.getAccountInfo(publicKey);
  if (!info) {
    return null;
  }

  return await fetcher();
}

async function waitForAccount(publicKey, fetcher) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const account = await fetchNullableAccount(publicKey, fetcher);
    if (account) {
      return account;
    }

    await delay(250);
  }

  throw new Error(
    `Account does not exist or has no data ${publicKey.toBase58()}`,
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rewardPolicyMatches(currentPolicy, desiredPolicy) {
  return (
    bnEquals(
      currentPolicy.lamportsPerKgReduced,
      desiredPolicy.lamportsPerKgReduced,
    ) &&
    bnEquals(
      currentPolicy.minimumReductionGrams,
      desiredPolicy.minimumReductionGrams,
    ) &&
    bnEquals(
      currentPolicy.maxLamportsPerPeriod,
      desiredPolicy.maxLamportsPerPeriod,
    ) &&
    bnEquals(currentPolicy.maxPendingLamports, desiredPolicy.maxPendingLamports)
  );
}

function rankThresholdsMatch(currentThresholds, desiredThresholds) {
  return (
    bnEquals(
      currentThresholds.seedlingMinReductionGrams,
      desiredThresholds.seedlingMinReductionGrams,
    ) &&
    bnEquals(
      currentThresholds.saplingMinReductionGrams,
      desiredThresholds.saplingMinReductionGrams,
    ) &&
    bnEquals(
      currentThresholds.treeMinReductionGrams,
      desiredThresholds.treeMinReductionGrams,
    ) &&
    bnEquals(
      currentThresholds.forestMinReductionGrams,
      desiredThresholds.forestMinReductionGrams,
    )
  );
}

function bnEquals(left, right) {
  return toBigInt(left) === toBigInt(right);
}

function toBigInt(value) {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(value);
  }

  return BigInt(value.toString());
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
