use anchor_lang::prelude::*;

#[account(zero_copy)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(packed)]
pub struct InsuranceFundStake {
    pub authority: Pubkey,
    pub bank_index: u64,

    pub lp_shares: u128,
    pub expo: u128, // exponent for lp_shares decimal places (for rebase)
    pub last_valid_ts: i64,

    pub last_withdraw_request_shares: u128, // get zero as 0 when not in escrow
    pub last_withdraw_request_value: u64,
    pub last_withdraw_request_ts: i64,

    pub cost_basis: i128,
}