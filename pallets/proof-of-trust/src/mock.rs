use crate as pallet_proof_of_trust;
use core::cell::RefCell;
use frame_support::{derive_impl, parameter_types};
use frame_system::EnsureRoot;
use pallet_coali_ledger::OnTrustChanged;
use sp_runtime::BuildStorage;
use std::collections::BTreeSet;

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
	/// (truster, trusted) pairs, standing in for the ledger.
	static TRUST: RefCell<BTreeSet<(u64, u64)>> = RefCell::new(BTreeSet::new());
}

/// `truster` trusts `trusted`, as the ledger would record it (and tell proof of trust).
pub fn trust(truster: u64, trusted: u64) {
	if TRUST.with(|t| t.borrow_mut().insert((truster, trusted))) {
		ProofOfTrust::pair_added(&truster, &trusted);
	}
}

pub fn untrust(truster: u64, trusted: u64) {
	if TRUST.with(|t| t.borrow_mut().remove(&(truster, trusted))) {
		ProofOfTrust::pair_removed(&truster, &trusted);
	}
}

pub struct MockTrust;
impl pallet_coali_ledger::TrustScore<u64> for MockTrust {
	fn trust_received(who: &u64) -> u32 {
		TRUST.with(|t| t.borrow().iter().filter(|(_, b)| b == who).count() as u32)
	}
	fn trusters_of(who: &u64) -> Vec<u64> {
		TRUST.with(|t| t.borrow().iter().filter(|(_, b)| b == who).map(|(a, _)| *a).collect())
	}
	fn trusted_by(who: &u64) -> Vec<u64> {
		TRUST.with(|t| t.borrow().iter().filter(|(a, _)| a == who).map(|(_, b)| *b).collect())
	}
}

pub const ATTESTER: u64 = 100;
pub const FOUNDERS: [u64; 2] = [1, 2];

parameter_types! {
	pub const MaxValidators: u32 = 8;
	pub const MaxCandidates: u32 = 50;
	pub const OfflineAfter: u64 = 30;
	pub const MaxStrikes: u32 = 3;
	pub const StrikeForgiveness: u64 = 1_000;
}

impl pallet_proof_of_trust::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type AdminOrigin = EnsureRoot<u64>;
	type TrustScore = MockTrust;
	type MaxValidators = MaxValidators;
	type MaxCandidates = MaxCandidates;
	type OfflineAfter = OfflineAfter;
	type MaxStrikes = MaxStrikes;
	type StrikeForgiveness = StrikeForgiveness;
}

pub fn new_test_ext() -> sp_io::TestExternalities {
	TRUST.with(|t| t.borrow_mut().clear());
	let mut storage = frame_system::GenesisConfig::<Test>::default().build_storage().unwrap();
	pallet_proof_of_trust::GenesisConfig::<Test> {
		founders: FOUNDERS.to_vec(),
		min_trust: 1,
		identity_attesters: vec![ATTESTER],
	}
	.assimilate_storage(&mut storage)
	.unwrap();
	let mut ext: sp_io::TestExternalities = storage.into();
	ext.execute_with(|| System::set_block_number(1));
	ext
}
