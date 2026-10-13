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

parameter_types! {
	pub const ChainTag: [u8; 8] = *b"coali-t1";
}

impl pallet_coali_ledger::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type AdminOrigin = EnsureRoot<AccountId32>;
	type Signature = MultiSignature;
	type Signer = MultiSigner;
	type ChainTag = ChainTag;
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
	ext.execute_with(|| System::set_block_number(1));
	ext
}
