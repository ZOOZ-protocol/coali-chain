use crate as pallet_token_allowlist;
use frame_support::{derive_impl, parameter_types};
use sp_runtime::BuildStorage;

type Block = frame_system::mocking::MockBlock<Test>;

#[frame_support::runtime]
mod runtime {
	#[runtime::runtime]
	#[runtime::derive(RuntimeCall, RuntimeEvent, RuntimeError, RuntimeOrigin, RuntimeTask)]
	pub struct Test;

	#[runtime::pallet_index(0)]
	pub type System = frame_system;

	#[runtime::pallet_index(1)]
	pub type TokenAllowlist = pallet_token_allowlist;
}

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
}

/// Account 1 manages every token.
pub struct Managers;
impl crate::TokenManagers<u32, u64> for Managers {
	fn is_manager(_asset: &u32, who: &u64) -> bool {
		*who == 1
	}
}

parameter_types! {
	pub const MaxAccountsPerCall: u32 = 3;
}

impl pallet_token_allowlist::Config for Test {
	type AssetId = u32;
	type Managers = Managers;
	type MaxAccountsPerCall = MaxAccountsPerCall;
}

pub fn new_test_ext() -> sp_io::TestExternalities {
	let mut ext: sp_io::TestExternalities =
		frame_system::GenesisConfig::<Test>::default().build_storage().unwrap().into();
	ext.execute_with(|| System::set_block_number(1));
	ext
}
