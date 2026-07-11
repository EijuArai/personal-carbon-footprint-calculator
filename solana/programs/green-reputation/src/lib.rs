use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount};
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    token_2022::{self, spl_token_2022::instruction::AuthorityType, Token2022},
    token_2022_extensions::non_transferable,
};

declare_id!("CYTYoWKNxj4xP1vUPef2HuRb8x8kgrnzpQXMi665Q6ve");

pub mod constants;
pub mod errors;
pub mod events;
pub mod state;
pub mod token2022;

use constants::PROTOCOL_CONFIG_SEED;
use errors::GreenReputationError;
use events::{
    EmissionHistorySeeded, ProtocolConfigUpdated, ProtocolInitialized, PublicProfileUpdated,
    RewardClaimed, RewardTreasuryFunded, RewardTreasuryInitialized, SbtMetadataSynced, SbtMinted,
    UserRegistered, VerifiedFootprintSubmitted,
};
use state::{
    DataSourceKind, FootprintCommitment, ProtocolConfig, PublicProfile, RankThresholds,
    RewardPolicy, RewardTreasury, UserProfile,
};

#[program]
pub mod green_reputation {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        args: InitializeProtocolArgs,
    ) -> Result<()> {
        args.reward_policy.validate()?;
        args.rank_thresholds.validate()?;

        let protocol_config = &mut ctx.accounts.protocol_config;
        protocol_config.initialize(
            ctx.bumps.protocol_config,
            ctx.accounts.admin.key(),
            args.verifier,
            args.metadata_update_authority,
            args.treasury_authority,
            args.sbt_mint_authority,
            args.allow_third_party_sponsors,
            args.reward_policy,
            args.rank_thresholds,
        );

        emit!(ProtocolInitialized {
            protocol_config: protocol_config.key(),
            admin: protocol_config.admin,
            verifier: protocol_config.verifier,
            metadata_update_authority: protocol_config.metadata_update_authority,
            treasury_authority: protocol_config.treasury_authority,
        });

        Ok(())
    }

    pub fn register_user(ctx: Context<RegisterUser>, public_profile: PublicProfile) -> Result<()> {
        public_profile.validate()?;

        let protocol_config = &ctx.accounts.protocol_config;
        let sponsor = ctx.accounts.sponsor.key();
        let user = ctx.accounts.user.key();

        require!(
            protocol_config.allow_third_party_sponsors || sponsor == user,
            GreenReputationError::InvalidSponsor
        );

        let user_profile = &mut ctx.accounts.user_profile;
        user_profile.initialize(
            ctx.bumps.user_profile,
            user,
            sponsor,
            protocol_config.rank_thresholds,
            public_profile.clone(),
        );

        emit!(UserRegistered {
            user,
            user_profile: user_profile.key(),
            sponsor,
            sbt_mint: user_profile.sbt_mint,
            rank: user_profile.rank,
        });

        Ok(())
    }

    pub fn update_public_profile(
        ctx: Context<UpdatePublicProfile>,
        public_profile: PublicProfile,
    ) -> Result<()> {
        public_profile.validate()?;

        let user_profile = &mut ctx.accounts.user_profile;
        user_profile.set_public_profile(public_profile);

        emit!(PublicProfileUpdated {
            user: ctx.accounts.user.key(),
            user_profile: user_profile.key(),
            metadata_version: user_profile.metadata_version,
        });

        Ok(())
    }

    pub fn admin_seed_emission_history(
        ctx: Context<AdminSeedEmissionHistory>,
        args: AdminSeedEmissionHistoryArgs,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.protocol_config.admin,
            ctx.accounts.admin.key(),
            GreenReputationError::UnauthorizedAdmin
        );

        let entry_count = ctx.accounts.user_profile.admin_seed_emission_history(
            args.emission_history,
            args.last_verified_at,
            args.total_emissions_grams,
            args.commitment_count,
        )?;

        emit!(EmissionHistorySeeded {
            admin: ctx.accounts.admin.key(),
            user: ctx.accounts.user_profile.user,
            user_profile: ctx.accounts.user_profile.key(),
            history_entries: entry_count as u8,
            total_emissions_grams: ctx.accounts.user_profile.total_emissions_grams,
            last_verified_at: ctx.accounts.user_profile.last_verified_at,
        });

        Ok(())
    }

    pub fn mint_user_sbt(ctx: Context<MintUserSbt>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.protocol_config.sbt_mint_authority,
            ctx.accounts.mint_authority.key(),
            GreenReputationError::InvalidMintAuthority
        );
        require_keys_eq!(
            ctx.accounts.user_profile.sponsor,
            ctx.accounts.sponsor.key(),
            GreenReputationError::InvalidSponsor
        );
        require!(
            !ctx.accounts.user_profile.has_sbt(),
            GreenReputationError::SbtAlreadyMinted
        );

        let expected_mint = token2022::user_sbt_mint_pda(&ctx.accounts.user_profile.key()).0;
        require_keys_eq!(
            expected_mint,
            ctx.accounts.sbt_mint.key(),
            GreenReputationError::InvalidSbtMint
        );

        let expected_token_account = token2022::expected_user_sbt_token_address(
            &ctx.accounts.user.key(),
            &ctx.accounts.sbt_mint.key(),
            &ctx.accounts.token_program.key(),
        );
        require_keys_eq!(
            expected_token_account,
            ctx.accounts.user_sbt_token_account.key(),
            GreenReputationError::InvalidAssociatedTokenAccount
        );

        let mint_space = token2022::sbt_mint_space()?;
        let mint_rent = Rent::get()?.minimum_balance(mint_space);
        let user_profile_key = ctx.accounts.user_profile.key();
        let mint_seeds = &[
            constants::USER_SBT_MINT_SEED,
            user_profile_key.as_ref(),
            &[ctx.bumps.sbt_mint],
        ];
        let signer_seeds = &[&mint_seeds[..]];

        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.sponsor.to_account_info(),
                    to: ctx.accounts.sbt_mint.to_account_info(),
                },
                signer_seeds,
            ),
            mint_rent,
            mint_space as u64,
            &ctx.accounts.token_program.key(),
        )?;

        non_transferable::non_transferable_mint_initialize(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            non_transferable::NonTransferableMintInitialize {
                token_program_id: ctx.accounts.token_program.to_account_info(),
                mint: ctx.accounts.sbt_mint.to_account_info(),
            },
        ))?;

        token_2022::initialize_mint2(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token_2022::InitializeMint2 {
                    mint: ctx.accounts.sbt_mint.to_account_info(),
                },
            ),
            constants::SBT_DECIMALS,
            &ctx.accounts.mint_authority.key(),
            None,
        )?;

        associated_token::create_idempotent(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            associated_token::Create {
                payer: ctx.accounts.sponsor.to_account_info(),
                associated_token: ctx.accounts.user_sbt_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
                mint: ctx.accounts.sbt_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;

        token_2022::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token_2022::MintTo {
                    mint: ctx.accounts.sbt_mint.to_account_info(),
                    to: ctx.accounts.user_sbt_token_account.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
            ),
            constants::SBT_MINT_AMOUNT,
        )?;

        token_2022::set_authority(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token_2022::SetAuthority {
                    current_authority: ctx.accounts.mint_authority.to_account_info(),
                    account_or_mint: ctx.accounts.sbt_mint.to_account_info(),
                },
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        let minted_at = Clock::get()?.unix_timestamp;
        let user_profile = &mut ctx.accounts.user_profile;
        user_profile.assign_sbt(
            ctx.accounts.sbt_mint.key(),
            ctx.accounts.user_sbt_token_account.key(),
            minted_at,
        )?;

        emit!(SbtMinted {
            user: ctx.accounts.user.key(),
            user_profile: user_profile.key(),
            sponsor: ctx.accounts.sponsor.key(),
            sbt_mint: ctx.accounts.sbt_mint.key(),
            sbt_token_account: ctx.accounts.user_sbt_token_account.key(),
            metadata_version: user_profile.metadata_version,
        });

        Ok(())
    }

    pub fn sync_sbt_state(ctx: Context<SyncSbtState>, args: SyncSbtStateArgs) -> Result<()> {
        require!(
            ctx.accounts
                .protocol_config
                .can_sync_metadata(&ctx.accounts.authority.key()),
            GreenReputationError::InvalidMetadataAuthority
        );

        let user_profile = &mut ctx.accounts.user_profile;
        user_profile.sync_sbt_metadata(
            args.metadata_version,
            args.metadata_uri_hash,
            Clock::get()?.unix_timestamp,
        )?;

        emit!(SbtMetadataSynced {
            authority: ctx.accounts.authority.key(),
            user: user_profile.user,
            user_profile: user_profile.key(),
            sbt_mint: user_profile.sbt_mint,
            metadata_version: user_profile.metadata_version,
            metadata_uri_hash: user_profile.metadata_uri_hash,
        });

        Ok(())
    }

    pub fn initialize_reward_treasury(ctx: Context<InitializeRewardTreasury>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.protocol_config.admin,
            ctx.accounts.admin.key(),
            GreenReputationError::UnauthorizedAdmin
        );

        let vault_rent = Rent::get()?.minimum_balance(0);
        let vault_seeds = &[
            constants::REWARD_TREASURY_VAULT_SEED,
            &[ctx.bumps.treasury_vault],
        ];
        let vault_signer = &[&vault_seeds[..]];

        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.admin.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                },
                vault_signer,
            ),
            vault_rent,
            0,
            &system_program::ID,
        )?;

        ctx.accounts.reward_treasury.initialize(
            ctx.bumps.reward_treasury,
            ctx.accounts.protocol_config.treasury_authority,
            ctx.accounts.treasury_vault.key(),
            Clock::get()?.unix_timestamp,
        );

        emit!(RewardTreasuryInitialized {
            authority: ctx.accounts.protocol_config.treasury_authority,
            reward_treasury: ctx.accounts.reward_treasury.key(),
            vault: ctx.accounts.treasury_vault.key(),
        });

        Ok(())
    }

    pub fn fund_treasury(ctx: Context<FundTreasury>, amount_lamports: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.protocol_config.admin,
            ctx.accounts.admin.key(),
            GreenReputationError::UnauthorizedAdmin
        );

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                },
            ),
            amount_lamports,
        )?;

        ctx.accounts
            .reward_treasury
            .record_funding(amount_lamports, Clock::get()?.unix_timestamp);

        emit!(RewardTreasuryFunded {
            authority: ctx.accounts.admin.key(),
            reward_treasury: ctx.accounts.reward_treasury.key(),
            amount_lamports,
            total_funded_lamports: ctx.accounts.reward_treasury.total_funded_lamports,
        });

        Ok(())
    }

    pub fn submit_verified_footprint(
        ctx: Context<SubmitVerifiedFootprint>,
        args: SubmitVerifiedFootprintArgs,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.protocol_config.verifier,
            ctx.accounts.verifier.key(),
            GreenReputationError::UnauthorizedVerifier
        );
        require_keys_eq!(
            ctx.accounts.user_profile.user,
            ctx.accounts.user.key(),
            GreenReputationError::UnauthorizedUser
        );

        let quoted_reward = ctx
            .accounts
            .protocol_config
            .reward_policy
            .quote_reward_lamports(args.reduction_delta_grams)?;
        require!(
            args.reward_delta_lamports <= quoted_reward,
            GreenReputationError::RewardAmountTooHigh
        );
        require!(
            ctx.accounts.user_profile.pending_reward_lamports + args.reward_delta_lamports
                <= ctx
                    .accounts
                    .protocol_config
                    .reward_policy
                    .max_pending_lamports,
            GreenReputationError::PendingRewardLimitExceeded
        );

        ctx.accounts
            .reward_treasury
            .reserve_pending_rewards(args.reward_delta_lamports)?;

        let verified_at = Clock::get()?.unix_timestamp;
        ctx.accounts.user_profile.apply_verified_footprint(
            args.period_key,
            args.commitment_hash,
            args.emission_delta_grams,
            args.reduction_delta_grams,
            args.reward_delta_lamports,
            verified_at,
            &ctx.accounts.protocol_config.rank_thresholds,
        )?;

        ctx.accounts.footprint_commitment.initialize(
            ctx.bumps.footprint_commitment,
            args.source_kind,
            ctx.accounts.user.key(),
            ctx.accounts.user_profile.key(),
            ctx.accounts.verifier.key(),
            args.period_key,
            args.commitment_hash,
            args.emission_delta_grams,
            args.reduction_delta_grams,
            args.reward_delta_lamports,
            verified_at,
        );

        emit!(VerifiedFootprintSubmitted {
            verifier: ctx.accounts.verifier.key(),
            user: ctx.accounts.user.key(),
            user_profile: ctx.accounts.user_profile.key(),
            footprint_commitment: ctx.accounts.footprint_commitment.key(),
            period_key: args.period_key,
            commitment_hash: args.commitment_hash,
            reward_delta_lamports: args.reward_delta_lamports,
            rank: ctx.accounts.user_profile.rank,
        });

        Ok(())
    }

    pub fn claim_reward(ctx: Context<ClaimReward>) -> Result<()> {
        let amount_lamports = ctx.accounts.user_profile.claim_reward()?;
        ctx.accounts.reward_treasury.disburse(amount_lamports)?;

        let vault_seeds = &[
            constants::REWARD_TREASURY_VAULT_SEED,
            &[ctx.bumps.treasury_vault],
        ];
        let vault_signer = &[&vault_seeds[..]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.treasury_vault.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                vault_signer,
            ),
            amount_lamports,
        )?;

        emit!(RewardClaimed {
            user: ctx.accounts.user.key(),
            user_profile: ctx.accounts.user_profile.key(),
            amount_lamports,
            total_claimed_lamports: ctx.accounts.user_profile.total_claimed_lamports,
        });

        Ok(())
    }

    pub fn update_protocol_config(
        ctx: Context<UpdateProtocolConfig>,
        args: UpdateProtocolConfigArgs,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.protocol_config.admin,
            ctx.accounts.admin.key(),
            GreenReputationError::UnauthorizedAdmin
        );

        ctx.accounts.protocol_config.update(
            args.verifier,
            args.metadata_update_authority,
            args.treasury_authority,
            args.sbt_mint_authority,
            args.allow_third_party_sponsors,
            args.reward_policy,
            args.rank_thresholds,
        )?;

        emit!(ProtocolConfigUpdated {
            admin: ctx.accounts.admin.key(),
            protocol_config: ctx.accounts.protocol_config.key(),
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeProtocolArgs {
    pub verifier: Pubkey,
    pub metadata_update_authority: Pubkey,
    pub treasury_authority: Pubkey,
    pub sbt_mint_authority: Pubkey,
    pub reward_policy: RewardPolicy,
    pub rank_thresholds: RankThresholds,
    pub allow_third_party_sponsors: bool,
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterUser<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub sponsor: Signer<'info>,
    #[account(
        init,
        payer = sponsor,
        space = 8 + UserProfile::INIT_SPACE,
        seeds = [constants::USER_PROFILE_SEED, user.key().as_ref()],
        bump
    )]
    pub user_profile: Account<'info, UserProfile>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePublicProfile<'info> {
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [constants::USER_PROFILE_SEED, user.key().as_ref()],
        bump = user_profile.bump,
        has_one = user @ GreenReputationError::UnauthorizedUser
    )]
    pub user_profile: Account<'info, UserProfile>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AdminSeedEmissionHistoryArgs {
    pub emission_history: Vec<u8>,
    pub last_verified_at: i64,
    pub total_emissions_grams: u64,
    pub commitment_count: u64,
}

#[derive(Accounts)]
pub struct AdminSeedEmissionHistory<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub user_profile: Account<'info, UserProfile>,
}

#[derive(Accounts)]
pub struct MintUserSbt<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub sponsor: Signer<'info>,
    #[account(
        mut,
        seeds = [constants::USER_PROFILE_SEED, user.key().as_ref()],
        bump = user_profile.bump,
        has_one = user @ GreenReputationError::UnauthorizedUser
    )]
    pub user_profile: Account<'info, UserProfile>,
    #[account(
        mut,
        constraint = mint_authority.key() == protocol_config.sbt_mint_authority @ GreenReputationError::InvalidMintAuthority
    )]
    pub mint_authority: Signer<'info>,
    /// CHECK: PDA mint created and initialized as a Token-2022 mint in the handler.
    #[account(
        mut,
        seeds = [constants::USER_SBT_MINT_SEED, user_profile.key().as_ref()],
        bump
    )]
    pub sbt_mint: UncheckedAccount<'info>,
    /// CHECK: ATA is derived and validated against the user + mint + Token-2022 program id.
    #[account(mut)]
    pub user_sbt_token_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SyncSbtStateArgs {
    pub metadata_version: u32,
    pub metadata_uri_hash: [u8; 32],
}

#[derive(Accounts)]
pub struct SyncSbtState<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub user_profile: Account<'info, UserProfile>,
}

#[derive(Accounts)]
pub struct InitializeRewardTreasury<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + RewardTreasury::INIT_SPACE,
        seeds = [constants::REWARD_TREASURY_SEED],
        bump
    )]
    pub reward_treasury: Account<'info, RewardTreasury>,
    /// CHECK: System-owned PDA vault used to hold lamports for claims.
    #[account(
        mut,
        seeds = [constants::REWARD_TREASURY_VAULT_SEED],
        bump
    )]
    pub treasury_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundTreasury<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [constants::REWARD_TREASURY_SEED],
        bump = reward_treasury.bump
    )]
    pub reward_treasury: Account<'info, RewardTreasury>,
    /// CHECK: PDA vault address is validated by seeds and stored treasury config.
    #[account(
        mut,
        seeds = [constants::REWARD_TREASURY_VAULT_SEED],
        bump,
        constraint = treasury_vault.key() == reward_treasury.vault @ GreenReputationError::TreasuryInsufficientFunds
    )]
    pub treasury_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SubmitVerifiedFootprintArgs {
    pub period_key: u64,
    pub commitment_hash: [u8; 32],
    pub source_kind: DataSourceKind,
    pub emission_delta_grams: u64,
    pub reduction_delta_grams: u64,
    pub reward_delta_lamports: u64,
}

#[derive(Accounts)]
#[instruction(args: SubmitVerifiedFootprintArgs)]
pub struct SubmitVerifiedFootprint<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub verifier: Signer<'info>,
    /// CHECK: Verified against the user profile authority field.
    pub user: UncheckedAccount<'info>,
    #[account(mut)]
    pub user_profile: Account<'info, UserProfile>,
    #[account(
        mut,
        seeds = [constants::REWARD_TREASURY_SEED],
        bump = reward_treasury.bump
    )]
    pub reward_treasury: Account<'info, RewardTreasury>,
    #[account(
        init,
        payer = verifier,
        space = 8 + FootprintCommitment::INIT_SPACE,
        seeds = [
            constants::FOOTPRINT_COMMITMENT_SEED,
            user.key().as_ref(),
            &args.period_key.to_le_bytes(),
            &args.commitment_hash,
        ],
        bump
    )]
    pub footprint_commitment: Account<'info, FootprintCommitment>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [constants::USER_PROFILE_SEED, user.key().as_ref()],
        bump = user_profile.bump,
        has_one = user @ GreenReputationError::UnauthorizedUser
    )]
    pub user_profile: Account<'info, UserProfile>,
    #[account(
        mut,
        seeds = [constants::REWARD_TREASURY_SEED],
        bump = reward_treasury.bump
    )]
    pub reward_treasury: Account<'info, RewardTreasury>,
    /// CHECK: PDA vault address is validated by seeds and stored treasury config.
    #[account(
        mut,
        seeds = [constants::REWARD_TREASURY_VAULT_SEED],
        bump,
        constraint = treasury_vault.key() == reward_treasury.vault @ GreenReputationError::TreasuryInsufficientFunds
    )]
    pub treasury_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct UpdateProtocolConfigArgs {
    pub verifier: Option<Pubkey>,
    pub metadata_update_authority: Option<Pubkey>,
    pub treasury_authority: Option<Pubkey>,
    pub sbt_mint_authority: Option<Pubkey>,
    pub allow_third_party_sponsors: Option<bool>,
    pub reward_policy: Option<RewardPolicy>,
    pub rank_thresholds: Option<RankThresholds>,
}

#[derive(Accounts)]
pub struct UpdateProtocolConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

#[cfg(test)]
mod tests {
    use super::state::{
        commitment_pda, DataSourceKind, FootprintCommitment, PublicProfile, Rank, RankThresholds,
        RewardPolicy, RewardTreasury, UserProfile,
    };
    use super::token2022::{metadata_symbol, user_sbt_mint_pda, SBT_MINT_EXTENSIONS};
    use anchor_lang::{prelude::Pubkey, Space};

    #[test]
    fn derives_rank_from_thresholds() {
        let thresholds = RankThresholds {
            seedling_min_reduction_grams: 10_000,
            sapling_min_reduction_grams: 50_000,
            tree_min_reduction_grams: 100_000,
            forest_min_reduction_grams: 250_000,
        };

        assert_eq!(Rank::from_reduction_grams(0, &thresholds), Rank::Sprout);
        assert_eq!(
            Rank::from_reduction_grams(10_000, &thresholds),
            Rank::Seedling
        );
        assert_eq!(
            Rank::from_reduction_grams(250_000, &thresholds),
            Rank::Forest
        );
    }

    #[test]
    fn validates_rank_thresholds_are_sorted() {
        let thresholds = RankThresholds {
            seedling_min_reduction_grams: 20_000,
            sapling_min_reduction_grams: 10_000,
            tree_min_reduction_grams: 100_000,
            forest_min_reduction_grams: 250_000,
        };

        assert!(thresholds.validate().is_err());
    }

    #[test]
    fn commitment_pda_depends_on_period_and_hash() {
        let user = Pubkey::new_unique();
        let period_key = 202604u64;
        let commitment_hash = [7u8; 32];
        let other_hash = [8u8; 32];

        let (first_pda, _) = commitment_pda(&user, period_key, &commitment_hash);
        let (same_pda, _) = commitment_pda(&user, period_key, &commitment_hash);
        let (different_pda, _) = commitment_pda(&user, period_key, &other_hash);

        assert_eq!(first_pda, same_pda);
        assert_ne!(first_pda, different_pda);
    }

    #[test]
    fn account_spaces_are_bounded() {
        assert!(PublicProfile::INIT_SPACE > 0);
        assert!(UserProfile::INIT_SPACE > PublicProfile::INIT_SPACE);
        assert!(FootprintCommitment::INIT_SPACE > RewardPolicy::INIT_SPACE);
    }

    #[test]
    fn data_source_kind_is_enum_backed() {
        assert_eq!(DataSourceKind::Hybrid as u8, 4);
    }

    #[test]
    fn sbt_mint_pda_is_stable_per_profile() {
        let profile = Pubkey::new_unique();
        let (first, _) = user_sbt_mint_pda(&profile);
        let (second, _) = user_sbt_mint_pda(&profile);

        assert_eq!(first, second);
    }

    #[test]
    fn sbt_mint_space_includes_non_transferable_extension() {
        let mint_space = super::token2022::sbt_mint_space().unwrap();

        assert_eq!(SBT_MINT_EXTENSIONS.len(), 1);
        assert!(mint_space > 82);
    }

    #[test]
    fn user_profile_rejects_double_sbt_assignment() {
        let thresholds = RankThresholds {
            seedling_min_reduction_grams: 10_000,
            sapling_min_reduction_grams: 50_000,
            tree_min_reduction_grams: 100_000,
            forest_min_reduction_grams: 250_000,
        };
        let mut profile = UserProfile {
            bump: 1,
            version: 1,
            rank: Rank::Sprout as u8,
            user: Pubkey::new_unique(),
            sponsor: Pubkey::new_unique(),
            sbt_mint: Pubkey::default(),
            sbt_token_account: Pubkey::default(),
            total_emissions_grams: 0,
            total_reduced_grams: 0,
            pending_reward_lamports: 0,
            total_claimed_lamports: 0,
            commitment_count: 0,
            last_verified_at: 0,
            latest_period_key: 0,
            metadata_version: 1,
            latest_commitment_hash: [0; 32],
            metadata_uri_hash: [0; 32],
            last_metadata_sync_at: 0,
            sbt_minted_at: 0,
            emission_history: Vec::new(),
            public_profile: PublicProfile {
                display_alias: "Eiju".into(),
                country_code: "JP".into(),
                avatar_uri: String::new(),
            },
        };

        profile.initialize(
            1,
            profile.user,
            profile.sponsor,
            thresholds,
            profile.public_profile.clone(),
        );

        let mint = Pubkey::new_unique();
        let token_account = Pubkey::new_unique();

        assert!(profile.assign_sbt(mint, token_account, 123).is_ok());
        assert!(profile
            .assign_sbt(Pubkey::new_unique(), Pubkey::new_unique(), 456)
            .is_err());
    }

    #[test]
    fn metadata_sync_requires_monotonic_version() {
        let thresholds = RankThresholds {
            seedling_min_reduction_grams: 10_000,
            sapling_min_reduction_grams: 50_000,
            tree_min_reduction_grams: 100_000,
            forest_min_reduction_grams: 250_000,
        };
        let user = Pubkey::new_unique();
        let sponsor = Pubkey::new_unique();
        let public_profile = PublicProfile {
            display_alias: "Eiju".into(),
            country_code: "JP".into(),
            avatar_uri: String::new(),
        };
        let mut profile = UserProfile {
            bump: 0,
            version: 0,
            rank: 0,
            user,
            sponsor,
            sbt_mint: Pubkey::default(),
            sbt_token_account: Pubkey::default(),
            total_emissions_grams: 0,
            total_reduced_grams: 0,
            pending_reward_lamports: 0,
            total_claimed_lamports: 0,
            commitment_count: 0,
            last_verified_at: 0,
            latest_period_key: 0,
            metadata_version: 0,
            latest_commitment_hash: [0; 32],
            metadata_uri_hash: [0; 32],
            last_metadata_sync_at: 0,
            sbt_minted_at: 0,
            emission_history: Vec::new(),
            public_profile: public_profile.clone(),
        };

        profile.initialize(1, user, sponsor, thresholds, public_profile);
        profile
            .assign_sbt(Pubkey::new_unique(), Pubkey::new_unique(), 111)
            .unwrap();

        assert!(profile.sync_sbt_metadata(3, [9u8; 32], 222).is_ok());
        assert!(profile.sync_sbt_metadata(3, [8u8; 32], 333).is_err());
    }

    #[test]
    fn metadata_symbol_is_fixed() {
        assert_eq!(metadata_symbol(), "GREP");
    }

    #[test]
    fn verified_footprint_updates_profile_totals_rank_and_pending_rewards() {
        let thresholds = RankThresholds {
            seedling_min_reduction_grams: 10_000,
            sapling_min_reduction_grams: 50_000,
            tree_min_reduction_grams: 100_000,
            forest_min_reduction_grams: 250_000,
        };
        let reward_policy = RewardPolicy {
            lamports_per_kg_reduced: 20,
            minimum_reduction_grams: 1_000,
            max_lamports_per_period: 500,
            max_pending_lamports: 1_000,
        };
        let user = Pubkey::new_unique();
        let sponsor = Pubkey::new_unique();
        let mut profile = base_profile(user, sponsor, thresholds);

        profile
            .apply_verified_footprint(
                202604,
                [5u8; 32],
                12_500,
                55_000,
                reward_policy.quote_reward_lamports(55_000).unwrap(),
                1_710_385_200,
                &thresholds,
            )
            .unwrap();

        assert_eq!(profile.total_emissions_grams, 12_500);
        assert_eq!(profile.total_reduced_grams, 55_000);
        assert_eq!(profile.pending_reward_lamports, 500);
        assert_eq!(profile.commitment_count, 1);
        assert_eq!(profile.latest_period_key, 202604);
        assert_eq!(profile.rank_value().unwrap(), Rank::Sapling);
        assert_eq!(
            profile.past_month_emissions_grams(1_710_385_200).unwrap(),
            None
        );
    }

    #[test]
    fn past_month_emissions_requires_full_30_day_history() {
        let thresholds = RankThresholds {
            seedling_min_reduction_grams: 10_000,
            sapling_min_reduction_grams: 50_000,
            tree_min_reduction_grams: 100_000,
            forest_min_reduction_grams: 250_000,
        };
        let user = Pubkey::new_unique();
        let sponsor = Pubkey::new_unique();
        let mut profile = base_profile(user, sponsor, thresholds);
        let end_timestamp = 1_710_385_200;

        for day_offset in 1..30 {
            let verified_at = end_timestamp - ((30 - day_offset) as i64 * 86_400);
            profile
                .apply_verified_footprint(
                    202604,
                    [day_offset as u8; 32],
                    1_000,
                    0,
                    0,
                    verified_at,
                    &thresholds,
                )
                .unwrap();
        }

        assert_eq!(
            profile.past_month_emissions_grams(end_timestamp).unwrap(),
            None
        );

        profile
            .apply_verified_footprint(202604, [31u8; 32], 1_000, 0, 0, end_timestamp, &thresholds)
            .unwrap();

        assert_eq!(
            profile.past_month_emissions_grams(end_timestamp).unwrap(),
            Some(30_000)
        );
    }

    #[test]
    fn past_month_emissions_prunes_entries_older_than_window() {
        let thresholds = RankThresholds {
            seedling_min_reduction_grams: 10_000,
            sapling_min_reduction_grams: 50_000,
            tree_min_reduction_grams: 100_000,
            forest_min_reduction_grams: 250_000,
        };
        let user = Pubkey::new_unique();
        let sponsor = Pubkey::new_unique();
        let mut profile = base_profile(user, sponsor, thresholds);
        let end_timestamp = 1_710_385_200;

        profile
            .apply_verified_footprint(
                202603,
                [1u8; 32],
                9_000,
                0,
                0,
                end_timestamp - (31 * 86_400),
                &thresholds,
            )
            .unwrap();

        for day_offset in 0..30 {
            let verified_at = end_timestamp - ((29 - day_offset) as i64 * 86_400);
            profile
                .apply_verified_footprint(
                    202604,
                    [day_offset as u8 + 2; 32],
                    1_000,
                    0,
                    0,
                    verified_at,
                    &thresholds,
                )
                .unwrap();
        }

        assert_eq!(
            profile.past_month_emissions_grams(end_timestamp).unwrap(),
            Some(30_000)
        );
    }

    #[test]
    fn reward_policy_caps_reward_and_rejects_small_reductions() {
        let reward_policy = RewardPolicy {
            lamports_per_kg_reduced: 25,
            minimum_reduction_grams: 1_000,
            max_lamports_per_period: 400,
            max_pending_lamports: 900,
        };

        assert_eq!(reward_policy.quote_reward_lamports(500).unwrap(), 0);
        assert_eq!(reward_policy.quote_reward_lamports(30_000).unwrap(), 400);
    }

    #[test]
    fn treasury_disbursement_is_bounded_by_available_and_pending() {
        let mut treasury = RewardTreasury::default();
        let authority = Pubkey::new_unique();
        let vault = Pubkey::new_unique();

        treasury.initialize(1, authority, vault, 100);
        treasury.record_funding(1_500, 1_710_385_200);
        treasury.reserve_pending_rewards(500).unwrap();

        assert!(treasury.disburse(600).is_err());
        assert!(treasury.disburse(500).is_ok());
        assert_eq!(treasury.total_disbursed_lamports, 500);
        assert_eq!(treasury.total_pending_lamports, 0);
        assert_eq!(treasury.available_lamports(), 1_000);
    }

    #[test]
    fn claiming_reward_clears_pending_balance() {
        let thresholds = RankThresholds {
            seedling_min_reduction_grams: 10_000,
            sapling_min_reduction_grams: 50_000,
            tree_min_reduction_grams: 100_000,
            forest_min_reduction_grams: 250_000,
        };
        let user = Pubkey::new_unique();
        let sponsor = Pubkey::new_unique();
        let mut profile = base_profile(user, sponsor, thresholds);
        profile.pending_reward_lamports = 700;

        assert_eq!(profile.claimable_reward_lamports(), 700);
        assert_eq!(profile.claim_reward().unwrap(), 700);
        assert_eq!(profile.pending_reward_lamports, 0);
        assert_eq!(profile.total_claimed_lamports, 700);
    }

    fn base_profile(user: Pubkey, sponsor: Pubkey, thresholds: RankThresholds) -> UserProfile {
        let public_profile = PublicProfile {
            display_alias: "Eiju".into(),
            country_code: "JP".into(),
            avatar_uri: String::new(),
        };
        let mut profile = UserProfile {
            bump: 0,
            version: 0,
            rank: 0,
            user,
            sponsor,
            sbt_mint: Pubkey::default(),
            sbt_token_account: Pubkey::default(),
            total_emissions_grams: 0,
            total_reduced_grams: 0,
            pending_reward_lamports: 0,
            total_claimed_lamports: 0,
            commitment_count: 0,
            last_verified_at: 0,
            latest_period_key: 0,
            metadata_version: 0,
            latest_commitment_hash: [0; 32],
            metadata_uri_hash: [0; 32],
            last_metadata_sync_at: 0,
            sbt_minted_at: 0,
            emission_history: Vec::new(),
            public_profile: public_profile.clone(),
        };

        profile.initialize(1, user, sponsor, thresholds, public_profile);
        profile
    }
}
