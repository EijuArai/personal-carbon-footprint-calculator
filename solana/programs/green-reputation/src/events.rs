use anchor_lang::prelude::*;

#[event]
pub struct ProtocolInitialized {
    pub protocol_config: Pubkey,
    pub admin: Pubkey,
    pub verifier: Pubkey,
    pub metadata_update_authority: Pubkey,
    pub treasury_authority: Pubkey,
}

#[event]
pub struct UserRegistered {
    pub user: Pubkey,
    pub user_profile: Pubkey,
    pub sponsor: Pubkey,
    pub sbt_mint: Pubkey,
    pub rank: u8,
}

#[event]
pub struct PublicProfileUpdated {
    pub user: Pubkey,
    pub user_profile: Pubkey,
    pub metadata_version: u32,
}

#[event]
pub struct EmissionHistorySeeded {
    pub admin: Pubkey,
    pub user: Pubkey,
    pub user_profile: Pubkey,
    pub history_entries: u8,
    pub total_emissions_grams: u64,
    pub last_verified_at: i64,
}

#[event]
pub struct FootprintCommitmentModeled {
    pub user: Pubkey,
    pub user_profile: Pubkey,
    pub period_key: u64,
    pub commitment_hash: [u8; 32],
    pub source_kind: u8,
    pub emission_delta_grams: u64,
    pub reduction_delta_grams: u64,
    pub reward_delta_lamports: u64,
}

#[event]
pub struct SbtMinted {
    pub user: Pubkey,
    pub user_profile: Pubkey,
    pub sponsor: Pubkey,
    pub sbt_mint: Pubkey,
    pub sbt_token_account: Pubkey,
    pub metadata_version: u32,
}

#[event]
pub struct SbtMetadataSynced {
    pub authority: Pubkey,
    pub user: Pubkey,
    pub user_profile: Pubkey,
    pub sbt_mint: Pubkey,
    pub metadata_version: u32,
    pub metadata_uri_hash: [u8; 32],
}

#[event]
pub struct RewardTreasuryInitialized {
    pub authority: Pubkey,
    pub reward_treasury: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct RewardTreasuryFunded {
    pub authority: Pubkey,
    pub reward_treasury: Pubkey,
    pub amount_lamports: u64,
    pub total_funded_lamports: u64,
}

#[event]
pub struct VerifiedFootprintSubmitted {
    pub verifier: Pubkey,
    pub user: Pubkey,
    pub user_profile: Pubkey,
    pub footprint_commitment: Pubkey,
    pub period_key: u64,
    pub commitment_hash: [u8; 32],
    pub reward_delta_lamports: u64,
    pub rank: u8,
}

#[event]
pub struct RewardClaimed {
    pub user: Pubkey,
    pub user_profile: Pubkey,
    pub amount_lamports: u64,
    pub total_claimed_lamports: u64,
}

#[event]
pub struct ProtocolConfigUpdated {
    pub admin: Pubkey,
    pub protocol_config: Pubkey,
}
