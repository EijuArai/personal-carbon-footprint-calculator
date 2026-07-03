use std::convert::TryFrom;

use anchor_lang::prelude::*;

use crate::{
    constants::{
        DAILY_EMISSION_HISTORY_DAYS, DAILY_EMISSION_HISTORY_ENTRY_BYTES, FOOTPRINT_COMMITMENT_SEED,
        MAX_AVATAR_URI_LEN, MAX_COUNTRY_CODE_LEN, MAX_DAILY_EMISSION_HISTORY_BYTES,
        MAX_DISPLAY_ALIAS_LEN, PROGRAM_VERSION, SECONDS_PER_DAY,
    },
    errors::GreenReputationError,
    ID,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DailyEmissionHistoryEntry {
    day_start_timestamp: i64,
    emission_grams: u64,
}

impl DailyEmissionHistoryEntry {
    fn encode_into(&self, bytes: &mut Vec<u8>) {
        bytes.extend_from_slice(&self.day_start_timestamp.to_le_bytes());
        bytes.extend_from_slice(&self.emission_grams.to_le_bytes());
    }

    fn decode_from(chunk: &[u8]) -> Result<Self> {
        require!(
            chunk.len() == DAILY_EMISSION_HISTORY_ENTRY_BYTES,
            GreenReputationError::InvalidEmissionHistory
        );

        let mut timestamp_bytes = [0u8; 8];
        timestamp_bytes.copy_from_slice(&chunk[..8]);

        let mut emission_bytes = [0u8; 8];
        emission_bytes.copy_from_slice(&chunk[8..16]);

        Ok(Self {
            day_start_timestamp: i64::from_le_bytes(timestamp_bytes),
            emission_grams: u64::from_le_bytes(emission_bytes),
        })
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Rank {
    Sprout = 0,
    Seedling = 1,
    Sapling = 2,
    Tree = 3,
    Forest = 4,
}

impl Default for Rank {
    fn default() -> Self {
        Self::Sprout
    }
}

impl Rank {
    pub fn from_reduction_grams(total_reduced_grams: u64, thresholds: &RankThresholds) -> Self {
        if total_reduced_grams >= thresholds.forest_min_reduction_grams {
            Self::Forest
        } else if total_reduced_grams >= thresholds.tree_min_reduction_grams {
            Self::Tree
        } else if total_reduced_grams >= thresholds.sapling_min_reduction_grams {
            Self::Sapling
        } else if total_reduced_grams >= thresholds.seedling_min_reduction_grams {
            Self::Seedling
        } else {
            Self::Sprout
        }
    }
}

impl TryFrom<u8> for Rank {
    type Error = Error;

    fn try_from(value: u8) -> Result<Self> {
        match value {
            0 => Ok(Self::Sprout),
            1 => Ok(Self::Seedling),
            2 => Ok(Self::Sapling),
            3 => Ok(Self::Tree),
            4 => Ok(Self::Forest),
            _ => err!(GreenReputationError::InvalidRank),
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct RankThresholds {
    pub seedling_min_reduction_grams: u64,
    pub sapling_min_reduction_grams: u64,
    pub tree_min_reduction_grams: u64,
    pub forest_min_reduction_grams: u64,
}

impl RankThresholds {
    pub fn validate(&self) -> Result<()> {
        require!(
            self.seedling_min_reduction_grams <= self.sapling_min_reduction_grams
                && self.sapling_min_reduction_grams <= self.tree_min_reduction_grams
                && self.tree_min_reduction_grams <= self.forest_min_reduction_grams,
            GreenReputationError::InvalidRankThresholds
        );

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct RewardPolicy {
    pub lamports_per_kg_reduced: u64,
    pub minimum_reduction_grams: u64,
    pub max_lamports_per_period: u64,
    pub max_pending_lamports: u64,
}

impl RewardPolicy {
    pub fn validate(&self) -> Result<()> {
        require!(
            self.max_pending_lamports >= self.max_lamports_per_period,
            GreenReputationError::InvalidRewardPolicy
        );

        Ok(())
    }

    pub fn quote_reward_lamports(&self, reduction_grams: u64) -> Result<u64> {
        self.validate()?;

        if reduction_grams < self.minimum_reduction_grams {
            return Ok(0);
        }

        Ok(
            (reduction_grams.saturating_mul(self.lamports_per_kg_reduced) / 1_000)
                .min(self.max_lamports_per_period),
        )
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum DataSourceKind {
    #[default]
    Manual = 0,
    Spend = 1,
    Activity = 2,
    Receipt = 3,
    Hybrid = 4,
}

impl TryFrom<u8> for DataSourceKind {
    type Error = Error;

    fn try_from(value: u8) -> Result<Self> {
        match value {
            0 => Ok(Self::Manual),
            1 => Ok(Self::Spend),
            2 => Ok(Self::Activity),
            3 => Ok(Self::Receipt),
            4 => Ok(Self::Hybrid),
            _ => err!(GreenReputationError::InvalidDataSourceKind),
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct PublicProfile {
    #[max_len(24)]
    pub display_alias: String,
    #[max_len(2)]
    pub country_code: String,
    #[max_len(96)]
    pub avatar_uri: String,
}

impl PublicProfile {
    pub fn validate(&self) -> Result<()> {
        let alias = self.display_alias.trim();

        require!(!alias.is_empty(), GreenReputationError::EmptyDisplayAlias);
        require!(
            self.display_alias.len() <= MAX_DISPLAY_ALIAS_LEN,
            GreenReputationError::DisplayAliasTooLong
        );
        require!(
            self.country_code.is_empty() || self.country_code.len() == MAX_COUNTRY_CODE_LEN,
            GreenReputationError::InvalidCountryCode
        );
        require!(
            self.country_code
                .chars()
                .all(|character| character.is_ascii_uppercase()),
            GreenReputationError::InvalidCountryCode
        );
        require!(
            self.avatar_uri.len() <= MAX_AVATAR_URI_LEN,
            GreenReputationError::AvatarUriTooLong
        );

        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub bump: u8,
    pub version: u16,
    pub admin: Pubkey,
    pub verifier: Pubkey,
    pub metadata_update_authority: Pubkey,
    pub treasury_authority: Pubkey,
    pub sbt_mint_authority: Pubkey,
    pub allow_third_party_sponsors: bool,
    pub reward_policy: RewardPolicy,
    pub rank_thresholds: RankThresholds,
    pub reserved: [u8; 32],
}

impl ProtocolConfig {
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        &mut self,
        bump: u8,
        admin: Pubkey,
        verifier: Pubkey,
        metadata_update_authority: Pubkey,
        treasury_authority: Pubkey,
        sbt_mint_authority: Pubkey,
        allow_third_party_sponsors: bool,
        reward_policy: RewardPolicy,
        rank_thresholds: RankThresholds,
    ) {
        self.bump = bump;
        self.version = PROGRAM_VERSION;
        self.admin = admin;
        self.verifier = verifier;
        self.metadata_update_authority = metadata_update_authority;
        self.treasury_authority = treasury_authority;
        self.sbt_mint_authority = sbt_mint_authority;
        self.allow_third_party_sponsors = allow_third_party_sponsors;
        self.reward_policy = reward_policy;
        self.rank_thresholds = rank_thresholds;
        self.reserved = [0; 32];
    }

    pub fn can_sync_metadata(&self, authority: &Pubkey) -> bool {
        *authority == self.admin
            || *authority == self.verifier
            || *authority == self.metadata_update_authority
    }

    pub fn update(
        &mut self,
        verifier: Option<Pubkey>,
        metadata_update_authority: Option<Pubkey>,
        treasury_authority: Option<Pubkey>,
        sbt_mint_authority: Option<Pubkey>,
        allow_third_party_sponsors: Option<bool>,
        reward_policy: Option<RewardPolicy>,
        rank_thresholds: Option<RankThresholds>,
    ) -> Result<()> {
        if let Some(value) = verifier {
            self.verifier = value;
        }
        if let Some(value) = metadata_update_authority {
            self.metadata_update_authority = value;
        }
        if let Some(value) = treasury_authority {
            self.treasury_authority = value;
        }
        if let Some(value) = sbt_mint_authority {
            self.sbt_mint_authority = value;
        }
        if let Some(value) = allow_third_party_sponsors {
            self.allow_third_party_sponsors = value;
        }
        if let Some(value) = reward_policy {
            value.validate()?;
            self.reward_policy = value;
        }
        if let Some(value) = rank_thresholds {
            value.validate()?;
            self.rank_thresholds = value;
        }

        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct UserProfile {
    pub bump: u8,
    pub version: u16,
    pub rank: u8,
    pub user: Pubkey,
    pub sponsor: Pubkey,
    pub sbt_mint: Pubkey,
    pub sbt_token_account: Pubkey,
    pub total_emissions_grams: u64,
    pub total_reduced_grams: u64,
    pub pending_reward_lamports: u64,
    pub total_claimed_lamports: u64,
    pub commitment_count: u64,
    pub last_verified_at: i64,
    pub latest_period_key: u64,
    pub metadata_version: u32,
    pub latest_commitment_hash: [u8; 32],
    pub metadata_uri_hash: [u8; 32],
    pub last_metadata_sync_at: i64,
    pub sbt_minted_at: i64,
    #[max_len(MAX_DAILY_EMISSION_HISTORY_BYTES)]
    pub emission_history: Vec<u8>,
    pub public_profile: PublicProfile,
}

impl UserProfile {
    pub fn initialize(
        &mut self,
        bump: u8,
        user: Pubkey,
        sponsor: Pubkey,
        thresholds: RankThresholds,
        public_profile: PublicProfile,
    ) {
        let rank = Rank::from_reduction_grams(0, &thresholds);

        self.bump = bump;
        self.version = PROGRAM_VERSION;
        self.rank = rank as u8;
        self.user = user;
        self.sponsor = sponsor;
        self.sbt_mint = Pubkey::default();
        self.sbt_token_account = Pubkey::default();
        self.total_emissions_grams = 0;
        self.total_reduced_grams = 0;
        self.pending_reward_lamports = 0;
        self.total_claimed_lamports = 0;
        self.commitment_count = 0;
        self.last_verified_at = 0;
        self.latest_period_key = 0;
        self.metadata_version = 1;
        self.latest_commitment_hash = [0; 32];
        self.metadata_uri_hash = [0; 32];
        self.last_metadata_sync_at = 0;
        self.sbt_minted_at = 0;
        self.emission_history = Vec::new();
        self.public_profile = public_profile;
    }

    pub fn set_public_profile(&mut self, public_profile: PublicProfile) {
        self.public_profile = public_profile;
        self.metadata_version = self.metadata_version.saturating_add(1);
    }

    pub fn admin_seed_emission_history(
        &mut self,
        emission_history: Vec<u8>,
        last_verified_at: i64,
        total_emissions_grams: u64,
        commitment_count: u64,
    ) -> Result<usize> {
        let entries = decode_emission_history(&emission_history)?;
        require!(
            !entries.is_empty() && last_verified_at > 0,
            GreenReputationError::InvalidEmissionHistory
        );

        let mut previous_day_start = i64::MIN;
        for entry in &entries {
            require!(
                entry.day_start_timestamp > previous_day_start,
                GreenReputationError::InvalidEmissionHistory
            );
            previous_day_start = entry.day_start_timestamp;
        }

        let latest_entry = entries
            .last()
            .ok_or(GreenReputationError::InvalidEmissionHistory)?;
        require!(
            latest_entry.day_start_timestamp <= day_bucket_start(last_verified_at),
            GreenReputationError::InvalidEmissionHistory
        );

        self.emission_history = emission_history;
        self.last_verified_at = last_verified_at;
        self.total_emissions_grams = total_emissions_grams;
        self.commitment_count = commitment_count;

        Ok(entries.len())
    }

    pub fn set_sbt_mint(&mut self, sbt_mint: Pubkey) {
        self.sbt_mint = sbt_mint;
        self.metadata_version = self.metadata_version.saturating_add(1);
    }

    pub fn has_sbt(&self) -> bool {
        self.sbt_mint != Pubkey::default()
    }

    pub fn assign_sbt(
        &mut self,
        sbt_mint: Pubkey,
        sbt_token_account: Pubkey,
        minted_at: i64,
    ) -> Result<()> {
        require!(!self.has_sbt(), GreenReputationError::SbtAlreadyMinted);

        self.sbt_mint = sbt_mint;
        self.sbt_token_account = sbt_token_account;
        self.sbt_minted_at = minted_at;
        self.metadata_version = self.metadata_version.saturating_add(1);

        Ok(())
    }

    pub fn sync_sbt_metadata(
        &mut self,
        metadata_version: u32,
        metadata_uri_hash: [u8; 32],
        synced_at: i64,
    ) -> Result<()> {
        require!(self.has_sbt(), GreenReputationError::SbtNotMinted);
        require!(
            metadata_version > self.metadata_version,
            GreenReputationError::MetadataVersionMustIncrease
        );

        self.metadata_version = metadata_version;
        self.metadata_uri_hash = metadata_uri_hash;
        self.last_metadata_sync_at = synced_at;

        Ok(())
    }

    pub fn rank_value(&self) -> Result<Rank> {
        Rank::try_from(self.rank)
    }

    pub fn claimable_reward_lamports(&self) -> u64 {
        self.pending_reward_lamports
    }

    pub fn claim_reward(&mut self) -> Result<u64> {
        let amount = self.claimable_reward_lamports();
        require!(amount > 0, GreenReputationError::NoClaimableReward);

        self.pending_reward_lamports = 0;
        self.total_claimed_lamports = self.total_claimed_lamports.saturating_add(amount);

        Ok(amount)
    }

    pub fn past_month_emissions_grams(&self, as_of_timestamp: i64) -> Result<Option<u64>> {
        let window_start = rolling_window_start(as_of_timestamp);
        let entries = self.active_emission_history(as_of_timestamp)?;
        let Some(first_entry) = entries.first() else {
            return Ok(None);
        };

        if entries.len() < DAILY_EMISSION_HISTORY_DAYS
            || first_entry.day_start_timestamp > window_start
        {
            return Ok(None);
        }

        Ok(Some(entries.iter().fold(0u64, |total, entry| {
            total.saturating_add(entry.emission_grams)
        })))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn apply_verified_footprint(
        &mut self,
        period_key: u64,
        commitment_hash: [u8; 32],
        emission_delta_grams: u64,
        reduction_delta_grams: u64,
        reward_delta_lamports: u64,
        verified_at: i64,
        thresholds: &RankThresholds,
    ) -> Result<()> {
        self.total_emissions_grams = self
            .total_emissions_grams
            .saturating_add(emission_delta_grams);
        self.total_reduced_grams = self
            .total_reduced_grams
            .saturating_add(reduction_delta_grams);
        self.pending_reward_lamports = self
            .pending_reward_lamports
            .saturating_add(reward_delta_lamports);
        self.commitment_count = self.commitment_count.saturating_add(1);
        self.last_verified_at = verified_at;
        self.latest_period_key = period_key;
        self.latest_commitment_hash = commitment_hash;
        self.rank = Rank::from_reduction_grams(self.total_reduced_grams, thresholds) as u8;
        self.record_daily_emission(emission_delta_grams, verified_at)?;

        Ok(())
    }

    fn record_daily_emission(&mut self, emission_delta_grams: u64, verified_at: i64) -> Result<()> {
        let day_start = day_bucket_start(verified_at);
        let mut entries = self.active_emission_history(verified_at)?;

        if let Some(last_entry) = entries.last_mut() {
            if last_entry.day_start_timestamp == day_start {
                last_entry.emission_grams = last_entry
                    .emission_grams
                    .saturating_add(emission_delta_grams);
                self.emission_history = encode_emission_history(&entries)?;
                return Ok(());
            }
        }

        entries.push(DailyEmissionHistoryEntry {
            day_start_timestamp: day_start,
            emission_grams: emission_delta_grams,
        });

        if entries.len() > DAILY_EMISSION_HISTORY_DAYS {
            let overflow = entries.len() - DAILY_EMISSION_HISTORY_DAYS;
            entries.drain(..overflow);
        }

        self.emission_history = encode_emission_history(&entries)?;

        Ok(())
    }

    fn active_emission_history(
        &self,
        as_of_timestamp: i64,
    ) -> Result<Vec<DailyEmissionHistoryEntry>> {
        let window_start = rolling_window_start(as_of_timestamp);
        let mut entries = decode_emission_history(&self.emission_history)?;
        entries.retain(|entry| entry.day_start_timestamp >= window_start);
        Ok(entries)
    }
}

fn rolling_window_start(as_of_timestamp: i64) -> i64 {
    day_bucket_start(as_of_timestamp)
        .saturating_sub((DAILY_EMISSION_HISTORY_DAYS as i64 - 1).saturating_mul(SECONDS_PER_DAY))
}

fn day_bucket_start(timestamp: i64) -> i64 {
    timestamp.div_euclid(SECONDS_PER_DAY) * SECONDS_PER_DAY
}

fn decode_emission_history(bytes: &[u8]) -> Result<Vec<DailyEmissionHistoryEntry>> {
    require!(
        bytes.len() <= MAX_DAILY_EMISSION_HISTORY_BYTES
            && bytes.len() % DAILY_EMISSION_HISTORY_ENTRY_BYTES == 0,
        GreenReputationError::InvalidEmissionHistory
    );

    bytes
        .chunks_exact(DAILY_EMISSION_HISTORY_ENTRY_BYTES)
        .map(DailyEmissionHistoryEntry::decode_from)
        .collect()
}

fn encode_emission_history(entries: &[DailyEmissionHistoryEntry]) -> Result<Vec<u8>> {
    require!(
        entries.len() <= DAILY_EMISSION_HISTORY_DAYS,
        GreenReputationError::InvalidEmissionHistory
    );

    let mut bytes = Vec::with_capacity(entries.len() * DAILY_EMISSION_HISTORY_ENTRY_BYTES);
    for entry in entries {
        entry.encode_into(&mut bytes);
    }

    require!(
        bytes.len() <= MAX_DAILY_EMISSION_HISTORY_BYTES,
        GreenReputationError::InvalidEmissionHistory
    );

    Ok(bytes)
}

#[account]
#[derive(InitSpace, Default)]
pub struct FootprintCommitment {
    pub bump: u8,
    pub version: u16,
    pub source_kind: u8,
    pub user: Pubkey,
    pub user_profile: Pubkey,
    pub verifier: Pubkey,
    pub period_key: u64,
    pub commitment_hash: [u8; 32],
    pub emission_delta_grams: u64,
    pub reduction_delta_grams: u64,
    pub reward_delta_lamports: u64,
    pub verified_at: i64,
}

impl FootprintCommitment {
    pub fn data_source_kind(&self) -> Result<DataSourceKind> {
        DataSourceKind::try_from(self.source_kind)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        &mut self,
        bump: u8,
        source_kind: DataSourceKind,
        user: Pubkey,
        user_profile: Pubkey,
        verifier: Pubkey,
        period_key: u64,
        commitment_hash: [u8; 32],
        emission_delta_grams: u64,
        reduction_delta_grams: u64,
        reward_delta_lamports: u64,
        verified_at: i64,
    ) {
        self.bump = bump;
        self.version = PROGRAM_VERSION;
        self.source_kind = source_kind as u8;
        self.user = user;
        self.user_profile = user_profile;
        self.verifier = verifier;
        self.period_key = period_key;
        self.commitment_hash = commitment_hash;
        self.emission_delta_grams = emission_delta_grams;
        self.reduction_delta_grams = reduction_delta_grams;
        self.reward_delta_lamports = reward_delta_lamports;
        self.verified_at = verified_at;
    }
}

#[account]
#[derive(InitSpace, Default)]
pub struct RewardTreasury {
    pub bump: u8,
    pub version: u16,
    pub authority: Pubkey,
    pub vault: Pubkey,
    pub total_funded_lamports: u64,
    pub total_disbursed_lamports: u64,
    pub total_pending_lamports: u64,
    pub last_funded_at: i64,
    pub reserved: [u8; 32],
}

impl RewardTreasury {
    pub fn initialize(&mut self, bump: u8, authority: Pubkey, vault: Pubkey, initialized_at: i64) {
        self.bump = bump;
        self.version = PROGRAM_VERSION;
        self.authority = authority;
        self.vault = vault;
        self.total_funded_lamports = 0;
        self.total_disbursed_lamports = 0;
        self.total_pending_lamports = 0;
        self.last_funded_at = initialized_at;
        self.reserved = [0; 32];
    }

    pub fn available_lamports(&self) -> u64 {
        self.total_funded_lamports
            .saturating_sub(self.total_disbursed_lamports)
    }

    pub fn record_funding(&mut self, amount_lamports: u64, funded_at: i64) {
        self.total_funded_lamports = self.total_funded_lamports.saturating_add(amount_lamports);
        self.last_funded_at = funded_at;
    }

    pub fn reserve_pending_rewards(&mut self, amount_lamports: u64) -> Result<()> {
        self.total_pending_lamports = self.total_pending_lamports.saturating_add(amount_lamports);
        require!(
            self.total_pending_lamports <= self.available_lamports(),
            GreenReputationError::TreasuryInsufficientFunds
        );

        Ok(())
    }

    pub fn disburse(&mut self, amount_lamports: u64) -> Result<()> {
        require!(
            amount_lamports <= self.total_pending_lamports,
            GreenReputationError::TreasuryInsufficientFunds
        );
        require!(
            amount_lamports <= self.available_lamports(),
            GreenReputationError::TreasuryInsufficientFunds
        );

        self.total_pending_lamports = self.total_pending_lamports.saturating_sub(amount_lamports);
        self.total_disbursed_lamports = self
            .total_disbursed_lamports
            .saturating_add(amount_lamports);

        Ok(())
    }
}

pub fn commitment_pda(user: &Pubkey, period_key: u64, commitment_hash: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            FOOTPRINT_COMMITMENT_SEED,
            user.as_ref(),
            &period_key.to_le_bytes(),
            commitment_hash,
        ],
        &ID,
    )
}
