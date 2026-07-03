pub const PROGRAM_VERSION: u16 = 1;

pub const PROTOCOL_CONFIG_SEED: &[u8] = b"protocol-config";
pub const USER_PROFILE_SEED: &[u8] = b"user-profile";
pub const FOOTPRINT_COMMITMENT_SEED: &[u8] = b"footprint-commitment";
pub const REWARD_TREASURY_SEED: &[u8] = b"reward-treasury";
pub const REWARD_TREASURY_VAULT_SEED: &[u8] = b"reward-treasury-vault";
pub const USER_SBT_MINT_SEED: &[u8] = b"user-sbt-mint";

pub const MAX_DISPLAY_ALIAS_LEN: usize = 24;
pub const MAX_COUNTRY_CODE_LEN: usize = 2;
pub const MAX_AVATAR_URI_LEN: usize = 96;
pub const DAILY_EMISSION_HISTORY_DAYS: usize = 30;
pub const DAILY_EMISSION_HISTORY_ENTRY_BYTES: usize = 16;
pub const MAX_DAILY_EMISSION_HISTORY_BYTES: usize =
    DAILY_EMISSION_HISTORY_DAYS * DAILY_EMISSION_HISTORY_ENTRY_BYTES;
pub const SECONDS_PER_DAY: i64 = 86_400;

pub const SBT_DECIMALS: u8 = 0;
pub const SBT_MINT_AMOUNT: u64 = 1;
pub const SBT_METADATA_SYMBOL: &str = "GREP";
