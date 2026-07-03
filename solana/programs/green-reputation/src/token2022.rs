use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token_2022::spl_token_2022::extension::ExtensionType,
    token_interface::{find_mint_account_size, ExtensionsVec},
};

use crate::{constants::USER_SBT_MINT_SEED, ID};

pub const SBT_MINT_EXTENSIONS: [ExtensionType; 1] = [ExtensionType::NonTransferable];

pub fn sbt_mint_space() -> Result<usize> {
    let extensions: ExtensionsVec = SBT_MINT_EXTENSIONS.to_vec();
    find_mint_account_size(Some(&extensions))
}

pub fn user_sbt_mint_pda(user_profile: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[USER_SBT_MINT_SEED, user_profile.as_ref()], &ID)
}

pub fn expected_user_sbt_token_address(
    user: &Pubkey,
    sbt_mint: &Pubkey,
    token_program: &Pubkey,
) -> Pubkey {
    get_associated_token_address_with_program_id(user, sbt_mint, token_program)
}

pub const fn metadata_symbol() -> &'static str {
    crate::constants::SBT_METADATA_SYMBOL
}
