import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { createHash as createNodeHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import * as web3 from "@solana/web3.js";

const GREEN_REPUTATION_IDL = JSON.parse(
  readFileSync(join(process.cwd(), "target/idl/green_reputation.json"), "utf8")
);
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } = web3;

const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

const PROTOCOL_CONFIG_SEED = Buffer.from("protocol-config");
const USER_PROFILE_SEED = Buffer.from("user-profile");
const FOOTPRINT_COMMITMENT_SEED = Buffer.from("footprint-commitment");
const REWARD_TREASURY_SEED = Buffer.from("reward-treasury");
const REWARD_TREASURY_VAULT_SEED = Buffer.from("reward-treasury-vault");
const USER_SBT_MINT_SEED = Buffer.from("user-sbt-mint");

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = new anchor.Program(GREEN_REPUTATION_IDL, provider);
const accounts = program.account as any;

const admin = provider.wallet.publicKey;
const protocolConfig = PublicKey.findProgramAddressSync(
  [PROTOCOL_CONFIG_SEED],
  program.programId
)[0];
const rewardTreasury = PublicKey.findProgramAddressSync(
  [REWARD_TREASURY_SEED],
  program.programId
)[0];
const treasuryVault = PublicKey.findProgramAddressSync(
  [REWARD_TREASURY_VAULT_SEED],
  program.programId
)[0];

const rewardPolicy = {
  lamportsPerKgReduced: new BN(10_000),
  minimumReductionGrams: new BN(100),
  maxLamportsPerPeriod: new BN(50_000),
  maxPendingLamports: new BN(100_000),
};

const rankThresholds = {
  seedlingMinReductionGrams: new BN(1_000),
  saplingMinReductionGrams: new BN(5_000),
  treeMinReductionGrams: new BN(10_000),
  forestMinReductionGrams: new BN(25_000),
};

const createHash = (label: string): number[] =>
  Array.from(createNodeHash("sha256").update(label).digest());

const findUserProfilePda = (user: web3.PublicKey): web3.PublicKey =>
  PublicKey.findProgramAddressSync(
    [USER_PROFILE_SEED, user.toBuffer()],
    program.programId
  )[0];

const findSbtMintPda = (userProfile: web3.PublicKey): web3.PublicKey =>
  PublicKey.findProgramAddressSync(
    [USER_SBT_MINT_SEED, userProfile.toBuffer()],
    program.programId
  )[0];

const findFootprintCommitmentPda = (
  user: web3.PublicKey,
  periodKey: BN,
  commitmentHash: number[]
): web3.PublicKey =>
  PublicKey.findProgramAddressSync(
    [
      FOOTPRINT_COMMITMENT_SEED,
      user.toBuffer(),
      periodKey.toArrayLike(Buffer, "le", 8),
      Buffer.from(commitmentHash),
    ],
    program.programId
  )[0];

const findAssociatedTokenAddress = (
  owner: web3.PublicKey,
  mint: web3.PublicKey
): web3.PublicKey =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];

const airdrop = async (
  recipient: web3.PublicKey,
  amountLamports = LAMPORTS_PER_SOL
) => {
  const signature = await provider.connection.requestAirdrop(
    recipient,
    amountLamports
  );
  await provider.connection.confirmTransaction(signature, "confirmed");
};

const expectProgramError = async (
  promise: Promise<unknown>,
  expectedCode: number,
  expectedName: string
) => {
  try {
    await promise;
    expect.fail(`Expected ${expectedName} (${expectedCode})`);
  } catch (error) {
    const candidate = error as {
      error?: { errorCode?: { code?: string; number?: number } };
      errorCode?: { code?: string; number?: number };
      message?: string;
      toString(): string;
    };
    const code =
      candidate.error?.errorCode?.number ?? candidate.errorCode?.number;
    const name = candidate.error?.errorCode?.code ?? candidate.errorCode?.code;
    const text = candidate.message ?? candidate.toString();

    if (code !== undefined) {
      expect(code).to.equal(expectedCode);
      expect(name).to.equal(expectedName);
      return;
    }

    expect(text).to.include(expectedName);
  }
};

describe("green-reputation", () => {
  const primaryUser = Keypair.generate();
  const sponsoredUser = Keypair.generate();
  const sponsor = Keypair.generate();
  const fakeAdmin = Keypair.generate();
  const fakeVerifier = Keypair.generate();

  const primaryUserProfile = findUserProfilePda(primaryUser.publicKey);
  const primaryUserSbtMint = findSbtMintPda(primaryUserProfile);
  const primaryUserTokenAccount = findAssociatedTokenAddress(
    primaryUser.publicKey,
    primaryUserSbtMint
  );

  const sponsoredUserProfile = findUserProfilePda(sponsoredUser.publicKey);

  before(async () => {
    await Promise.all([
      airdrop(primaryUser.publicKey),
      airdrop(sponsoredUser.publicKey),
      airdrop(sponsor.publicKey, 2 * LAMPORTS_PER_SOL),
      airdrop(fakeAdmin.publicKey),
      airdrop(fakeVerifier.publicKey),
    ]);

    await program.methods
      .initializeProtocol({
        verifier: admin,
        metadataUpdateAuthority: admin,
        treasuryAuthority: admin,
        sbtMintAuthority: admin,
        rewardPolicy,
        rankThresholds,
        allowThirdPartySponsors: false,
      })
      .accounts({
        admin,
        protocolConfig,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .initializeRewardTreasury()
      .accounts({
        protocolConfig,
        admin,
        rewardTreasury,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .fundTreasury(new BN(200_000))
      .accounts({
        protocolConfig,
        admin,
        rewardTreasury,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("rejects third-party sponsors until admin enables them", async () => {
    await expectProgramError(
      program.methods
        .registerUser({
          displayAlias: "sponsored-user",
          countryCode: "JP",
          avatarUri: "",
        })
        .accounts({
          protocolConfig,
          user: sponsoredUser.publicKey,
          sponsor: sponsor.publicKey,
          userProfile: sponsoredUserProfile,
          systemProgram: SystemProgram.programId,
        })
        .signers([sponsoredUser, sponsor])
        .rpc(),
      6006,
      "InvalidSponsor"
    );

    await program.methods
      .updateProtocolConfig({
        verifier: null,
        metadataUpdateAuthority: null,
        treasuryAuthority: null,
        sbtMintAuthority: null,
        allowThirdPartySponsors: true,
        rewardPolicy: null,
        rankThresholds: null,
      })
      .accounts({
        admin,
        protocolConfig,
      })
      .rpc();

    await program.methods
      .registerUser({
        displayAlias: "sponsored-user",
        countryCode: "JP",
        avatarUri: "",
      })
      .accounts({
        protocolConfig,
        user: sponsoredUser.publicKey,
        sponsor: sponsor.publicKey,
        userProfile: sponsoredUserProfile,
        systemProgram: SystemProgram.programId,
      })
      .signers([sponsoredUser, sponsor])
      .rpc();

    const profile = await accounts.userProfile.fetch(sponsoredUserProfile);
    expect(profile.user.toBase58()).to.equal(
      sponsoredUser.publicKey.toBase58()
    );
    expect(profile.sponsor.toBase58()).to.equal(sponsor.publicKey.toBase58());
  });

  it("registers a self-sponsored user and mints a Token-2022 soulbound token", async () => {
    await program.methods
      .registerUser({
        displayAlias: "primary-user",
        countryCode: "JP",
        avatarUri: "",
      })
      .accounts({
        protocolConfig,
        user: primaryUser.publicKey,
        sponsor: primaryUser.publicKey,
        userProfile: primaryUserProfile,
        systemProgram: SystemProgram.programId,
      })
      .signers([primaryUser])
      .rpc();

    await program.methods
      .mintUserSbt()
      .accounts({
        protocolConfig,
        user: primaryUser.publicKey,
        sponsor: primaryUser.publicKey,
        userProfile: primaryUserProfile,
        mintAuthority: admin,
        sbtMint: primaryUserSbtMint,
        userSbtTokenAccount: primaryUserTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([primaryUser])
      .rpc();

    const profile = await accounts.userProfile.fetch(primaryUserProfile);
    expect(profile.sbtMint.toBase58()).to.equal(primaryUserSbtMint.toBase58());
    expect(profile.sbtTokenAccount.toBase58()).to.equal(
      primaryUserTokenAccount.toBase58()
    );
    expect(profile.metadataVersion).to.equal(2);

    const mintInfo = await provider.connection.getParsedAccountInfo(
      primaryUserSbtMint
    );
    const parsedMint = mintInfo.value?.data as web3.ParsedAccountData;
    const extensions =
      (
        parsedMint?.parsed as {
          info?: { extensions?: Array<{ extension?: string }> };
        }
      )?.info?.extensions ?? [];
    expect(mintInfo.value?.owner.toBase58()).to.equal(
      TOKEN_2022_PROGRAM_ID.toBase58()
    );
    expect(
      extensions.some((entry) => entry.extension === "nonTransferable")
    ).to.equal(true);

    const tokenBalance = await provider.connection.getTokenAccountBalance(
      primaryUserTokenAccount
    );
    expect(tokenBalance.value.amount).to.equal("1");
  });

  it("rejects a second soulbound mint for the same user", async () => {
    await expectProgramError(
      program.methods
        .mintUserSbt()
        .accounts({
          protocolConfig,
          user: primaryUser.publicKey,
          sponsor: primaryUser.publicKey,
          userProfile: primaryUserProfile,
          mintAuthority: admin,
          sbtMint: primaryUserSbtMint,
          userSbtTokenAccount: primaryUserTokenAccount,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([primaryUser])
        .rpc(),
      6010,
      "SbtAlreadyMinted"
    );
  });

  it("submits a verified footprint, updates aggregates, and rejects duplicate commitments", async () => {
    const periodKey = new BN(202604);
    const commitmentHash = createHash("primary-user:202604:verified-1");
    const footprintCommitment = findFootprintCommitmentPda(
      primaryUser.publicKey,
      periodKey,
      commitmentHash
    );

    await program.methods
      .submitVerifiedFootprint({
        periodKey,
        commitmentHash,
        sourceKind: { activity: {} },
        emissionDeltaGrams: new BN(12_500),
        reductionDeltaGrams: new BN(2_000),
        rewardDeltaLamports: new BN(20_000),
      })
      .accounts({
        protocolConfig,
        verifier: admin,
        user: primaryUser.publicKey,
        userProfile: primaryUserProfile,
        rewardTreasury,
        footprintCommitment,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const profile = await accounts.userProfile.fetch(primaryUserProfile);
    const treasury = await accounts.rewardTreasury.fetch(rewardTreasury);
    const commitment = await accounts.footprintCommitment.fetch(
      footprintCommitment
    );

    expect(profile.totalEmissionsGrams.toNumber()).to.equal(12_500);
    expect(profile.totalReducedGrams.toNumber()).to.equal(2_000);
    expect(profile.pendingRewardLamports.toNumber()).to.equal(20_000);
    expect(profile.commitmentCount.toNumber()).to.equal(1);
    expect(profile.latestPeriodKey.toNumber()).to.equal(202604);
    expect(Array.from(profile.latestCommitmentHash)).to.deep.equal(
      commitmentHash
    );
    expect(profile.rank).to.equal(1);
    expect(treasury.totalPendingLamports.toNumber()).to.equal(20_000);
    expect(commitment.user.toBase58()).to.equal(
      primaryUser.publicKey.toBase58()
    );
    expect(commitment.rewardDeltaLamports.toNumber()).to.equal(20_000);

    try {
      await program.methods
        .submitVerifiedFootprint({
          periodKey,
          commitmentHash,
          sourceKind: { activity: {} },
          emissionDeltaGrams: new BN(12_500),
          reductionDeltaGrams: new BN(2_000),
          rewardDeltaLamports: new BN(20_000),
        })
        .accounts({
          protocolConfig,
          verifier: admin,
          user: primaryUser.publicKey,
          userProfile: primaryUserProfile,
          rewardTreasury,
          footprintCommitment,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Expected duplicate commitment PDA creation to fail");
    } catch (error) {
      expect(String(error)).to.include("already in use");
    }
  });

  it("rejects unapproved verifiers and unauthorized admins", async () => {
    const periodKey = new BN(202605);
    const commitmentHash = createHash("primary-user:202605:unauthorized");
    const footprintCommitment = findFootprintCommitmentPda(
      primaryUser.publicKey,
      periodKey,
      commitmentHash
    );

    await expectProgramError(
      program.methods
        .submitVerifiedFootprint({
          periodKey,
          commitmentHash,
          sourceKind: { manual: {} },
          emissionDeltaGrams: new BN(100),
          reductionDeltaGrams: new BN(100),
          rewardDeltaLamports: new BN(1_000),
        })
        .accounts({
          protocolConfig,
          verifier: fakeVerifier.publicKey,
          user: primaryUser.publicKey,
          userProfile: primaryUserProfile,
          rewardTreasury,
          footprintCommitment,
          systemProgram: SystemProgram.programId,
        })
        .signers([fakeVerifier])
        .rpc(),
      6018,
      "UnauthorizedVerifier"
    );

    await expectProgramError(
      program.methods
        .updateProtocolConfig({
          verifier: null,
          metadataUpdateAuthority: null,
          treasuryAuthority: null,
          sbtMintAuthority: null,
          allowThirdPartySponsors: false,
          rewardPolicy: null,
          rankThresholds: null,
        })
        .accounts({
          admin: fakeAdmin.publicKey,
          protocolConfig,
        })
        .signers([fakeAdmin])
        .rpc(),
      6017,
      "UnauthorizedAdmin"
    );
  });

  it("claims pending rewards once and then rejects a second claim", async () => {
    const beforeBalance = await provider.connection.getBalance(
      primaryUser.publicKey
    );

    await program.methods
      .claimReward()
      .accounts({
        user: primaryUser.publicKey,
        userProfile: primaryUserProfile,
        rewardTreasury,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([primaryUser])
      .rpc();

    const afterBalance = await provider.connection.getBalance(
      primaryUser.publicKey
    );
    const profile = await accounts.userProfile.fetch(primaryUserProfile);
    const treasury = await accounts.rewardTreasury.fetch(rewardTreasury);

    expect(afterBalance).to.be.greaterThan(beforeBalance);
    expect(profile.pendingRewardLamports.toNumber()).to.equal(0);
    expect(profile.totalClaimedLamports.toNumber()).to.equal(20_000);
    expect(treasury.totalPendingLamports.toNumber()).to.equal(0);
    expect(treasury.totalDisbursedLamports.toNumber()).to.equal(20_000);

    await expectProgramError(
      program.methods
        .claimReward()
        .accounts({
          user: primaryUser.publicKey,
          userProfile: primaryUserProfile,
          rewardTreasury,
          treasuryVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([primaryUser])
        .rpc(),
      6022,
      "NoClaimableReward"
    );
  });
});
