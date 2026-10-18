use crate as pallet_coali_ledger;
use frame_support::{derive_impl, parameter_types};
use frame_system::EnsureRoot;
use sp_core::{sr25519, Pair};
use sp_runtime::{traits::IdentityLookup, AccountId32, BuildStorage, MultiSignature, MultiSigner};

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
	pub type Ledger = pallet_coali_ledger::Pallet<Test>;
}

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
	type AccountId = AccountId32;
	type Lookup = IdentityLookup<AccountId32>;
}

frame_support::ord_parameter_types! {
	pub const IdentityAttester: AccountId32 = AccountId32::new([42; 32]);
}

pub fn identity_attester() -> AccountId32 {
	AccountId32::new([42; 32])
}

parameter_types! {
	pub const ChainTag: [u8; 8] = *b"coali-t1";
	pub static Now: u64 = 0;
	pub static Removed: Vec<AccountId32> = vec![];
}

/// Unix time in ms set by the tests (`set_now`).
pub struct MockTime;
impl frame_support::traits::UnixTime for MockTime {
	fn now() -> core::time::Duration {
		core::time::Duration::from_millis(Now::get())
	}
}

/// Unix ms at the start of each test.
pub const START: u64 = 1_800_000_000_000;

pub fn set_now(ms: u64) {
	Now::set(ms);
}

pub struct RecordRemoval;
impl pallet_coali_ledger::OnAttesterRemoved<AccountId32> for RecordRemoval {
	fn attester_removed(who: &AccountId32) {
		Removed::mutate(|r| r.push(who.clone()));
	}
}

impl pallet_coali_ledger::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type AdminOrigin = EnsureRoot<AccountId32>;
	type Signature = MultiSignature;
	type Signer = MultiSigner;
	type ChainTag = ChainTag;
	type Time = MockTime;
	type ElectorateOrigin = frame_system::EnsureSignedBy<IdentityAttester, AccountId32>;
	type MinVotingPeriod = frame_support::traits::ConstU64<3_600_000>;
	type VoteGrace = frame_support::traits::ConstU64<86_400_000>;
	type MaxRevealsPerCall = frame_support::traits::ConstU32<100>;
	type OnTrustChanged = ();
	type OnAttesterRemoved = RecordRemoval;
	type WeightInfo = ();
}

pub fn pair(seed: &str) -> sr25519::Pair {
	sr25519::Pair::from_string(&format!("//{seed}"), None).expect("valid seed")
}

pub fn account(p: &sr25519::Pair) -> AccountId32 {
	AccountId32::from(p.public().0)
}

pub fn attester() -> AccountId32 {
	account(&pair("Attester"))
}

pub fn new_test_ext() -> sp_io::TestExternalities {
	let mut storage = frame_system::GenesisConfig::<Test>::default().build_storage().unwrap();
	pallet_coali_ledger::GenesisConfig::<Test> { attesters: vec![attester()] }
		.assimilate_storage(&mut storage)
		.unwrap();
	let mut ext: sp_io::TestExternalities = storage.into();
	// Benchmarks create sr25519 keys through the host keystore.
	ext.register_extension(sp_keystore::KeystoreExt::new(sp_keystore::testing::MemoryKeystore::new()));
	ext.execute_with(|| {
		System::set_block_number(1);
		set_now(START);
		pallet_coali_ledger::Electorate::<Test>::insert(attester(), 1_000);
	});
	ext
}
