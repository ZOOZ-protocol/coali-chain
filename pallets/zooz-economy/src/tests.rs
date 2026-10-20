use crate::{mock::*, Bucket, DealWithFees, Error, FeePayer, Pallet};
use frame_support::{
	assert_noop, assert_ok,
	traits::{fungible::Balanced, tokens::Precision, Hooks, OnUnbalanced},
	weights::{Weight, WeightToFee as _},
};
use sp_runtime::{DispatchError, Percent};

type Economy = Pallet<Test>;

fn fuel() -> u64 {
	Economy::bucket_account(Bucket::Fuel)
}

fn free(who: u64) -> u128 {
	Balances::free_balance(who)
}

#[test]
fn fee_follows_the_dollar() {
	new_test_ext().execute_with(|| {
		// $0.05 at $0.25 per ZOOZ = 0.2 ZOOZ.
		assert_eq!(Economy::target_fee(), UNIT / 5);
		assert_eq!(
			crate::WeightToFee::<Test>::weight_to_fee(&Weight::from_parts(500_000_000, 0)),
			UNIT / 5
		);
		// ZOOZ worth 10x more: the fee in ZOOZ is 10x lower.
		assert_ok!(ZoozEconomy::set_price(RuntimeOrigin::root(), 2_500_000));
		assert_eq!(Economy::target_fee(), UNIT / 50);
		// A 200-byte transaction adds about 10%.
		assert_eq!(Economy::length_fee(200), UNIT / 500);
	});
}

#[test]
fn only_admin_or_oracle_sets_the_price() {
	new_test_ext().execute_with(|| {
		assert_noop!(ZoozEconomy::set_price(RuntimeOrigin::signed(USER), 1), DispatchError::BadOrigin);
		assert_noop!(ZoozEconomy::set_price(RuntimeOrigin::root(), 0), Error::<Test>::ZeroPrice);
		assert_ok!(ZoozEconomy::set_price(RuntimeOrigin::root(), 300_000));
	});
}

#[test]
fn oracle_moves_the_price_within_limits_only() {
	new_test_ext().execute_with(|| {
		let oracle = || RuntimeOrigin::signed(ORACLE);
		// 250_000 -> +20% is the most one update may move.
		assert_noop!(ZoozEconomy::set_price(oracle(), 25_000_000), Error::<Test>::PriceChangeTooLarge);
		assert_noop!(ZoozEconomy::set_price(oracle(), 2_500), Error::<Test>::PriceChangeTooLarge);
		assert_ok!(ZoozEconomy::set_price(oracle(), 300_000));
		// Then it must wait min_interval blocks.
		assert_noop!(ZoozEconomy::set_price(oracle(), 310_000), Error::<Test>::PriceUpdateTooSoon);
		System::set_block_number(1 + 3_600);
		assert_ok!(ZoozEconomy::set_price(oracle(), 240_000));
		// Absurd prices are refused to everyone, the admin included.
		assert_noop!(ZoozEconomy::set_price(RuntimeOrigin::root(), u64::MAX), Error::<Test>::PriceOutOfRange);
		assert_noop!(ZoozEconomy::set_price(RuntimeOrigin::root(), 999), Error::<Test>::PriceOutOfRange);
	});
}

#[test]
fn fees_never_drop_below_the_minimum() {
	new_test_ext().execute_with(|| {
		assert_ok!(ZoozEconomy::set_price(RuntimeOrigin::root(), 100_000_000));
		// $0.05 at $100 would be 0.0005 ZOOZ; the floor is 0.02 ZOOZ.
		assert_eq!(Economy::target_fee(), UNIT / 50);
		assert_noop!(ZoozEconomy::set_min_fee(RuntimeOrigin::signed(ORACLE), 0), DispatchError::BadOrigin);
		assert_ok!(ZoozEconomy::set_min_fee(RuntimeOrigin::root(), UNIT / 10));
		assert_eq!(Economy::target_fee(), UNIT / 10);
	});
}

#[test]
fn admin_sets_price_limits() {
	new_test_ext().execute_with(|| {
		let limits = crate::PriceLimits { min_micro_usd: 10, max_micro_usd: 5, max_change: Percent::from_percent(5), min_interval: 10 };
		assert_noop!(ZoozEconomy::set_price_limits(RuntimeOrigin::root(), limits.clone()), Error::<Test>::BadPriceLimits);
		let limits = crate::PriceLimits { max_micro_usd: 1_000_000, ..limits };
		assert_noop!(ZoozEconomy::set_price_limits(RuntimeOrigin::signed(ORACLE), limits.clone()), DispatchError::BadOrigin);
		assert_ok!(ZoozEconomy::set_price_limits(RuntimeOrigin::root(), limits));
		assert_noop!(ZoozEconomy::set_price(RuntimeOrigin::signed(ORACLE), 270_000), Error::<Test>::PriceChangeTooLarge);
	});
}

#[test]
fn block_reward_cap_halves() {
	new_test_ext().execute_with(|| {
		assert_eq!(Economy::reward_cap_at(0), 2 * UNIT);
		assert_eq!(Economy::reward_cap_at(9), 2 * UNIT);
		assert_eq!(Economy::reward_cap_at(10), UNIT);
		assert_eq!(Economy::reward_cap_at(25), UNIT / 2);
		assert_eq!(Economy::reward_cap_at(10 * 200), 0);
		assert_eq!(Economy::reward_at(10 * 200), 0);
	});
}

#[test]
fn author_is_paid_from_fuel() {
	new_test_ext().execute_with(|| {
		let before = free(fuel());
		Economy::on_initialize(1);
		assert_eq!(free(AUTHOR), 6 * UNIT / 25);
		assert_eq!(free(fuel()), before - 6 * UNIT / 25);
		// No author, no reward.
		set_author(None);
		Economy::on_initialize(2);
		assert_eq!(free(fuel()), before - 6 * UNIT / 25);
	});
}

#[test]
fn reward_grows_with_the_validator_set() {
	new_test_ext().execute_with(|| {
		assert_eq!(Economy::reward_at(1), 6 * UNIT / 25);
		// Five validators share the blocks, so each block pays five times more:
		// every validator still earns $6 a month.
		set_validators(5);
		assert_eq!(Economy::reward_at(1), 6 * UNIT / 5);
	});
}

#[test]
fn reward_follows_the_dollar() {
	new_test_ext().execute_with(|| {
		// ZOOZ worth 10x more: the reward in ZOOZ is 10x lower.
		assert_ok!(ZoozEconomy::set_price(RuntimeOrigin::root(), 2_500_000));
		assert_eq!(Economy::reward_at(1), 6 * UNIT / 250);
	});
}

#[test]
fn reward_never_exceeds_the_cap() {
	new_test_ext().execute_with(|| {
		// 100 validators would need 24 ZOOZ per block; the cap holds at 2, then halves.
		set_validators(100);
		assert_eq!(Economy::reward_at(1), 2 * UNIT);
		assert_eq!(Economy::reward_at(10), UNIT);
		// A crashed price cannot drain Fuel either.
		assert_ok!(ZoozEconomy::set_price(RuntimeOrigin::root(), 1_000));
		set_validators(1);
		assert_eq!(Economy::reward_at(1), 2 * UNIT);
	});
}

#[test]
fn no_validator_reward_means_fees_only() {
	new_test_ext().execute_with(|| {
		assert_noop!(ZoozEconomy::set_validator_reward(RuntimeOrigin::signed(USER), 0), DispatchError::BadOrigin);
		assert_ok!(ZoozEconomy::set_validator_reward(RuntimeOrigin::root(), 0));
		let before = free(fuel());
		Economy::on_initialize(1);
		assert_eq!(free(AUTHOR), 0);
		assert_eq!(free(fuel()), before);
	});
}

#[test]
fn issuance_never_grows_after_genesis() {
	new_test_ext().execute_with(|| {
		let issuance = Balances::total_issuance();
		for n in 1..50 {
			Economy::on_initialize(n);
		}
		assert_eq!(Balances::total_issuance(), issuance);
	});
}

fn pay_fee(payer: u64, amount: u128) {
	let credit = <Balances as Balanced<u64>>::withdraw(
		&payer,
		amount,
		Precision::Exact,
		frame_support::traits::tokens::Preservation::Preserve,
		frame_support::traits::tokens::Fortitude::Polite,
	)
	.unwrap();
	FeePayer::<Test>::put(payer);
	DealWithFees::<Test>::on_unbalanced(credit);
	FeePayer::<Test>::kill();
}

#[test]
fn app_fees_are_split_60_20_20() {
	new_test_ext().execute_with(|| {
		let app_before = free(APP);
		pay_fee(APP, 10 * UNIT);
		assert_eq!(free(AUTHOR), 6 * UNIT);
		assert_eq!(free(FOUNDATION), 102 * UNIT);
		assert_eq!(free(APP), app_before - 10 * UNIT + 2 * UNIT);
	});
}

#[test]
fn user_fees_credit_the_chosen_app_else_fuel() {
	new_test_ext().execute_with(|| {
		let fuel_before = free(fuel());
		pay_fee(USER, 10 * UNIT);
		assert_eq!(free(fuel()), fuel_before + 2 * UNIT);

		assert_noop!(ZoozEconomy::choose_app(RuntimeOrigin::signed(USER), Some(USER)), Error::<Test>::NotAnApp);
		assert_ok!(ZoozEconomy::choose_app(RuntimeOrigin::signed(USER), Some(APP)));
		let app_before = free(APP);
		pay_fee(USER, 10 * UNIT);
		assert_eq!(free(APP), app_before + 2 * UNIT);
	});
}

#[test]
fn split_is_adjustable() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			ZoozEconomy::set_fee_split(RuntimeOrigin::root(), Percent::from_percent(90), Percent::from_percent(20)),
			Error::<Test>::SplitAbove100
		);
		assert_ok!(ZoozEconomy::set_fee_split(
			RuntimeOrigin::root(),
			Percent::from_percent(50),
			Percent::from_percent(30)
		));
		pay_fee(APP, 10 * UNIT);
		assert_eq!(free(AUTHOR), 5 * UNIT);
		assert_eq!(free(FOUNDATION), 103 * UNIT);
	});
}

#[test]
fn buckets_are_spent_only_by_admin() {
	new_test_ext().execute_with(|| {
		let dev = Economy::bucket_account(Bucket::Development);
		assert_eq!(free(dev), 100 * UNIT);
		assert_noop!(
			ZoozEconomy::spend(RuntimeOrigin::signed(FOUNDATION), Bucket::Development, USER, UNIT),
			DispatchError::BadOrigin
		);
		assert_ok!(ZoozEconomy::spend(RuntimeOrigin::root(), Bucket::Development, USER, 10 * UNIT));
		assert_eq!(free(dev), 90 * UNIT);
		assert_eq!(free(USER), 110 * UNIT);
	});
}
