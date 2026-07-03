use anchor_lang::prelude::*;

#[error_code]
pub enum GreenReputationError {
    #[msg("Display alias must not be empty.")]
    EmptyDisplayAlias,
    #[msg("Display alias is too long.")]
    DisplayAliasTooLong,
    #[msg("Country code must be a 2-letter ISO code when provided.")]
    InvalidCountryCode,
    #[msg("Avatar URI is too long.")]
    AvatarUriTooLong,
    #[msg("Rank thresholds must be sorted in ascending order.")]
    InvalidRankThresholds,
    #[msg("Reward policy limits are inconsistent.")]
    InvalidRewardPolicy,
    #[msg("The selected sponsor is not authorized for this profile.")]
    InvalidSponsor,
    #[msg("The signer is not authorized to update this profile.")]
    UnauthorizedUser,
    #[msg("Rank value is out of range.")]
    InvalidRank,
    #[msg("Data source kind is out of range.")]
    InvalidDataSourceKind,
    #[msg("This user already has a soulbound token.")]
    SbtAlreadyMinted,
    #[msg("This user does not have a soulbound token yet.")]
    SbtNotMinted,
    #[msg("The provided mint authority is not authorized by the protocol config.")]
    InvalidMintAuthority,
    #[msg("The derived associated token account does not match the provided account.")]
    InvalidAssociatedTokenAccount,
    #[msg("The provided SBT mint account is invalid for this user profile.")]
    InvalidSbtMint,
    #[msg("Metadata sync authority is not authorized.")]
    InvalidMetadataAuthority,
    #[msg("Metadata version must increase monotonically.")]
    MetadataVersionMustIncrease,
    #[msg("The signer is not authorized to administer protocol settings.")]
    UnauthorizedAdmin,
    #[msg("The signer is not authorized to submit verified footprint data.")]
    UnauthorizedVerifier,
    #[msg("Reward delta exceeds the protocol policy.")]
    RewardAmountTooHigh,
    #[msg("Pending rewards exceed the protocol maximum.")]
    PendingRewardLimitExceeded,
    #[msg("Reward treasury does not have enough available lamports.")]
    TreasuryInsufficientFunds,
    #[msg("There is no claimable reward for this user profile.")]
    NoClaimableReward,
    #[msg("Emission history bytes are invalid or exceed the configured bounds.")]
    InvalidEmissionHistory,
}
