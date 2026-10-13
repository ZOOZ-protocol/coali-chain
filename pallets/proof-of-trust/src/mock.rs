use crate as pallet_proof_of_trust;
use core::cell::RefCell;
use frame_support::{derive_impl, ord_parameter_types, parameter_types};
use frame_system::{EnsureRoot, EnsureSignedBy};
use sp_runtime::BuildStorage;
use std::collections::BTreeMap;

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
	pub type ProofOfTrust = pallet_proof_of_trust::Pallet<Test>;
}

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
}

thread_local! {
	static TRUST: RefCell<BTreeMap<u64, u32>> = RefCell::new(BTreeMap::new());
}

pub fn set_trust(who: u64, n: u32) {
	TRUST.with(|t| t.borrow_mut().insert(who, n));
}

pub struct MockTrust;
impl pallet_coali_ledger::TrustScore<u64> for MockTrust {
	fn trust_received(who: &u64) -> u32 {
		TRUST.with(|t| t.borrow().get(who).copied().unwrap_or(0))
	}
}

pub const ATTESTER: u64 = 100;
pub const FOUNDERS: [u64; 2] = [1, 2];

ord_parameter_types! {
	pub const Attester: u64 = ATTESTER;
}

parameter_types! {
	pub const MaxValidators: u32 = 4;
	pub const MaxCandidates: u32 = 10;
	pub const OfflineAfter: u64 = 30;
}

impl pallet_proof_of_trust::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type AdminOrigin = EnsureRoot<u64>;
	type AttesterOrigin = EnsureSignedBy<Attester, u64>;
	type TrustScore = MockTrust;
	type MaxValidators = MaxValidators;
	type MaxCandidates = MaxCandidates;
	type OfflineAfter = OfflineAfter;
}

pub fn new_test_ext() -> sp_io::TestExternalities {
	TRUST.with(|t| t.borrow_mut().clear());
	let mut storage = frame_system::GenesisConfig::<Test>::default().build_storage().unwrap();
	pallet_proof_of_trust::GenesisConfig::<Test> { founders: FOUNDERS.to_vec(), min_trust: 1 }
		.assimilate_storage(&mut storage)
		.unwrap();
	let mut ext: sp_io::TestExternalities = storage.into();
	ext.execute_with(|| System::set_block_number(1));
	ext
}
