use crate as pallet_zooz_economy;
use core::cell::RefCell;
use frame_support::{
	derive_impl, parameter_types,
	traits::{ConstU128, Contains},
};
use frame_system::EnsureRoot;
use sp_runtime::BuildStorage;

type Block = frame_system::mocking::MockBlock<Test>;

#[frame_support::runtime]
mod runtime {
	#[runtime::runtime]
	#[runtime::derive(
		RuntimeCall,
		RuntimeEvent,
		RuntimeError,
		RuntimeOrigin,
		RuntimeFreezeReason,
		RuntimeHoldReason,
		RuntimeSlashReason,
		RuntimeLockId,
		RuntimeTask,
		RuntimeViewFunction
	)]
	pub struct Test;

	#[runtime::pallet_index(0)]
	pub type System = frame_system::Pallet<Test>;

	#[runtime::pallet_index(1)]
	pub type Balances = pallet_balances::Pallet<Test>;

	#[runtime::pallet_index(2)]
	pub type ZoozEconomy = pallet_zooz_economy::Pallet<Test>;
}

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
	type AccountData = pallet_balances::AccountData<u128>;
}

#[derive_impl(pallet_balances::config_preludes::TestDefaultConfig)]
impl pallet_balances::Config for Test {
	type Balance = u128;
	type AccountStore = System;
	type ExistentialDeposit = ConstU128<ED>;
}

pub const UNIT: u128 = 1_000_000_000;
pub const ED: u128 = 1_000_000;
pub const AUTHOR: u64 = 1;
pub const FOUNDATION: u64 = 2;
pub const APP: u64 = 3;
pub const USER: u64 = 4;
pub const ORACLE: u64 = 5;

thread_local! {
	static BLOCK_AUTHOR: RefCell<Option<u64>> = const { RefCell::new(Some(AUTHOR)) };
	static VALIDATORS: RefCell<u32> = const { RefCell::new(1) };
}

pub fn set_author(a: Option<u64>) {
	BLOCK_AUTHOR.with(|x| *x.borrow_mut() = a);
}

pub fn set_validators(n: u32) {
	VALIDATORS.with(|x| *x.borrow_mut() = n);
}

pub struct ValidatorCount;
impl frame_support::traits::Get<u32> for ValidatorCount {
	fn get() -> u32 {
		VALIDATORS.with(|x| *x.borrow())
	}
}

pub struct Author;
impl frame_support::traits::Get<Option<u64>> for Author {
	fn get() -> Option<u64> {
		BLOCK_AUTHOR.with(|x| *x.borrow())
	}
}

pub struct IsApp;
impl Contains<u64> for IsApp {
	fn contains(who: &u64) -> bool {
		*who == APP
	}
}

parameter_types! {
	pub const Unit: u128 = UNIT;
	pub const ReferenceWeight: u64 = 500_000_000;
	pub const BlocksPerMonth: u32 = 100;
}

impl pallet_zooz_economy::Config for Test {
	type Currency = Balances;
	type AdminOrigin = EnsureRoot<u64>;
	type BlockAuthor = Author;
	type IsApp = IsApp;
	type Unit = Unit;
	type ReferenceWeight = ReferenceWeight;
	type ValidatorCount = ValidatorCount;
	type BlocksPerMonth = BlocksPerMonth;
}

pub fn new_test_ext() -> sp_io::TestExternalities {
	set_author(Some(AUTHOR));
	set_validators(1);
	let mut storage = frame_system::GenesisConfig::<Test>::default().build_storage().unwrap();
	pallet_balances::GenesisConfig::<Test> {
		balances: vec![(USER, 100 * UNIT), (APP, 100 * UNIT), (FOUNDATION, 100 * UNIT)],
		..Default::default()
	}
	.assimilate_storage(&mut storage)
	.unwrap();
	pallet_zooz_economy::GenesisConfig::<Test> {
		price_micro_usd: 250_000,
		target_fee_micro_usd: 50_000,
		author_percent: 60,
		foundation_percent: 20,
		block_reward: 2 * UNIT,
		halving_interval: 10,
		// $6 a month over 100 blocks at $0.25: 0.24 ZOOZ per block and per validator.
		validator_reward_micro_usd: 6_000_000,
		foundation: Some(FOUNDATION),
		oracle: Some(ORACLE),
		fuel: 1_000 * UNIT,
		development: 100 * UNIT,
		investors: 0,
		team: 0,
		charity: 0,
	}
	.assimilate_storage(&mut storage)
	.unwrap();
	storage.into()
}
