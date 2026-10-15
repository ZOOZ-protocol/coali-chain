// This is free and unencumbered software released into the public domain.
//
// Anyone is free to copy, modify, publish, use, compile, sell, or
// distribute this software, either in source code form or as a compiled
// binary, for any purpose, commercial or non-commercial, and by any
// means.
//
// In jurisdictions that recognize copyright laws, the author or authors
// of this software dedicate any and all copyright interest in the
// software to the public domain. We make this dedication for the benefit
// of the public at large and to the detriment of our heirs and
// successors. We intend this dedication to be an overt act of
// relinquishment in perpetuity of all present and future rights to this
// software under copyright law.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
// IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
// OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
// ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
// OTHER DEALINGS IN THE SOFTWARE.
//
// For more information, please refer to <http://unlicense.org>

// Substrate and Polkadot dependencies
use frame_support::{
	derive_impl,
	dispatch::DispatchClass,
	parameter_types,
	traits::{
		fungibles::roles::Inspect as TokenRoles, AsEnsureOriginWithArg, ConstBool, ConstU128,
		ConstU32, ConstU64, ConstU8, Contains, VariantCountOf,
	},
	weights::{
		constants::{RocksDbWeight, WEIGHT_REF_TIME_PER_SECOND},
		Weight,
	},
};
use frame_system::{
	limits::{BlockLength, BlockWeights},
	EnsureRoot, EnsureSigned,
};
use pallet_nfts::PalletFeatures;
use pallet_transaction_payment::{ConstFeeMultiplier, Multiplier};
use sp_consensus_aura::sr25519::AuthorityId as AuraId;
use sp_runtime::{
	traits::{One, StaticLookup, Verify},
	Perbill,
};
use sp_version::RuntimeVersion;

// Local module imports
use super::{
	AccountId, Aura, Balance, Balances, Block, BlockNumber, Hash, Nonce, PalletInfo, Runtime,
	RuntimeCall, RuntimeEvent, RuntimeFreezeReason, RuntimeHoldReason, RuntimeOrigin, RuntimeTask,
	Assets, Authorship, OriginCaller, ProofOfTrust, Signature, System, TokenAllowlist, DAYS, EXISTENTIAL_DEPOSIT,
	MILLI_UNIT, SLOT_DURATION, UNIT, VERSION,
};

const NORMAL_DISPATCH_RATIO: Perbill = Perbill::from_percent(75);

parameter_types! {
	pub const BlockHashCount: BlockNumber = 2400;
	pub const Version: RuntimeVersion = VERSION;

	/// We allow for 2 seconds of compute with a 6 second average block time.
	pub RuntimeBlockWeights: BlockWeights = BlockWeights::with_sensible_defaults(
		Weight::from_parts(2u64 * WEIGHT_REF_TIME_PER_SECOND, u64::MAX),
		NORMAL_DISPATCH_RATIO,
	);
	pub RuntimeBlockLength: BlockLength = BlockLength::builder()
		.max_length(5 * 1024 * 1024)
		.modify_max_length_for_class(DispatchClass::Normal, |m| *m = NORMAL_DISPATCH_RATIO * *m)
		.build();
	pub const SS58Prefix: u8 = 42;
}

/// All migrations of the runtime, aside from the ones declared in the pallets.
///
/// This can be a tuple of types, each implementing `OnRuntimeUpgrade`.
#[allow(unused_parens)]
type SingleBlockMigrations =
	(pallet_assets::migration::next_asset_id::SetNextAssetId<FirstAssetId, Runtime>,);

/// The default types are being injected by [`derive_impl`](`frame_support::derive_impl`) from
/// [`SoloChainDefaultConfig`](`struct@frame_system::config_preludes::SolochainDefaultConfig`),
/// but overridden as needed.
#[derive_impl(frame_system::config_preludes::SolochainDefaultConfig)]
impl frame_system::Config for Runtime {
	/// The block type for the runtime.
	type Block = Block;
	/// Block & extrinsics weights: base values and limits.
	type BlockWeights = RuntimeBlockWeights;
	/// The maximum length of a block (in bytes).
	type BlockLength = RuntimeBlockLength;
	/// The identifier used to distinguish between accounts.
	type AccountId = AccountId;
	/// The type for storing how many extrinsics an account has signed.
	type Nonce = Nonce;
	/// The type for hashing blocks and tries.
	type Hash = Hash;
	/// Maximum number of block number to block hash mappings to keep (oldest pruned first).
	type BlockHashCount = BlockHashCount;
	/// The weight of database operations that the runtime can invoke.
	type DbWeight = RocksDbWeight;
	/// Version of the runtime.
	type Version = Version;
	/// The data to be stored in an account.
	type AccountData = pallet_balances::AccountData<Balance>;
	/// This is used as an identifier of the chain. 42 is the generic substrate prefix.
	type SS58Prefix = SS58Prefix;
	type MaxConsumers = frame_support::traits::ConstU32<16>;
	type SingleBlockMigrations = SingleBlockMigrations;
	/// Restricted tokens only reach accounts on their allowlist.
	type BaseCallFilter = TokenTransferRules;
}

impl pallet_aura::Config for Runtime {
	type AuthorityId = AuraId;
	type DisabledValidators = ();
	type MaxAuthorities = ConstU32<32>;
	type AllowMultipleBlocksPerSlot = ConstBool<false>;
	type SlotDuration = pallet_aura::MinimumPeriodTimesTwo<Runtime>;
}

impl pallet_grandpa::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;

	type WeightInfo = ();
	type MaxAuthorities = ConstU32<32>;
	type MaxNominators = ConstU32<0>;
	type MaxSetIdSessionEntries = ConstU64<0>;

	type KeyOwnerProof = sp_core::Void;
	type EquivocationReportSystem = ();
}

impl pallet_timestamp::Config for Runtime {
	/// A timestamp: milliseconds since the unix epoch.
	type Moment = u64;
	type OnTimestampSet = Aura;
	type MinimumPeriod = ConstU64<{ SLOT_DURATION / 2 }>;
	type WeightInfo = ();
}

impl pallet_balances::Config for Runtime {
	type MaxLocks = ConstU32<50>;
	type MaxReserves = ();
	type ReserveIdentifier = [u8; 8];
	/// The type for recording an account's balance.
	type Balance = Balance;
	/// The ubiquitous event type.
	type RuntimeEvent = RuntimeEvent;
	type DustRemoval = ();
	type ExistentialDeposit = ConstU128<EXISTENTIAL_DEPOSIT>;
	type AccountStore = System;
	type WeightInfo = pallet_balances::weights::SubstrateWeight<Runtime>;
	type FreezeIdentifier = RuntimeFreezeReason;
	type MaxFreezes = VariantCountOf<RuntimeFreezeReason>;
	type RuntimeHoldReason = RuntimeHoldReason;
	type RuntimeFreezeReason = RuntimeFreezeReason;
	type DoneSlashHandler = ();
}

parameter_types! {
	pub FeeMultiplier: Multiplier = Multiplier::one();
}

impl pallet_transaction_payment::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type OnChargeTransaction = pallet_zooz_economy::ZoozFeeAdapter<Runtime>;
	type OperationalFeeMultiplier = ConstU8<5>;
	type WeightToFee = pallet_zooz_economy::WeightToFee<Runtime>;
	type LengthToFee = pallet_zooz_economy::LengthToFee<Runtime>;
	type FeeMultiplierUpdate = ConstFeeMultiplier<FeeMultiplier>;
	type WeightInfo = pallet_transaction_payment::weights::SubstrateWeight<Runtime>;
}

impl pallet_sudo::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type WeightInfo = pallet_sudo::weights::SubstrateWeight<Runtime>;
}

parameter_types! {
	/// 5 minutes at 6-second blocks.
	pub const SessionPeriod: BlockNumber = 50;
	pub const SessionOffset: BlockNumber = 0;
	pub const PotMaxValidators: u32 = 32;
	pub const PotMaxCandidates: u32 = 256;
	/// A newly selected validator starts one session later, then has a full session
	/// (at least one Aura slot, since MaxValidators < SessionPeriod) to author.
	pub const PotOfflineAfter: BlockNumber = 120;
}

impl pallet_authorship::Config for Runtime {
	type FindAuthor = pallet_session::FindAccountFromAuthorIndex<Self, Aura>;
	type EventHandler = ProofOfTrust;
}

impl pallet_session::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type ValidatorId = AccountId;
	type ValidatorIdOf = sp_runtime::traits::ConvertInto;
	type ShouldEndSession = pallet_session::PeriodicSessions<SessionPeriod, SessionOffset>;
	type NextSessionRotation = pallet_session::PeriodicSessions<SessionPeriod, SessionOffset>;
	type SessionManager = ProofOfTrust;
	type SessionHandler = <super::SessionKeys as sp_runtime::traits::OpaqueKeys>::KeyTypeIdProviders;
	type Keys = super::SessionKeys;
	type DisablingStrategy = ();
	type WeightInfo = ();
	type Currency = Balances;
	type KeyDeposit = ();
}

impl pallet_proof_of_trust::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type AdminOrigin = frame_system::EnsureRoot<AccountId>;
	type AttesterOrigin = pallet_coali_ledger::EnsureAttester<Runtime>;
	type TrustScore = super::CoaliLedger;
	type MaxValidators = PotMaxValidators;
	type MaxCandidates = PotMaxCandidates;
	type OfflineAfter = PotOfflineAfter;
}

parameter_types! {
	/// Domain separator mixed into every voter/truster signature; must differ per network.
	pub const CoaliChainTag: [u8; 8] = *b"coali-01";
}

impl pallet_coali_ledger::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type AdminOrigin = frame_system::EnsureRoot<AccountId>;
	type Signature = super::Signature;
	type Signer = <super::Signature as sp_runtime::traits::Verify>::Signer;
	type ChainTag = CoaliChainTag;
	type WeightInfo = ();
}

pub struct CurrentAuthor;
impl frame_support::traits::Get<Option<AccountId>> for CurrentAuthor {
	fn get() -> Option<AccountId> {
		Authorship::author()
	}
}

/// Apps approved by the foundation are the ledger attesters.
pub struct ApprovedApps;
impl frame_support::traits::Contains<AccountId> for ApprovedApps {
	fn contains(who: &AccountId) -> bool {
		pallet_coali_ledger::Attesters::<Runtime>::contains_key(who)
	}
}

parameter_types! {
	/// Total weight of a `record_vote` extrinsic (~908M) plus its length fee (~7.5%):
	/// a vote then costs the target fee.
	pub const ZoozReferenceWeight: u64 = 980_000_000;
}

impl pallet_zooz_economy::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type Currency = Balances;
	type AdminOrigin = frame_system::EnsureRoot<AccountId>;
	type BlockAuthor = CurrentAuthor;
	type IsApp = ApprovedApps;
	type Unit = ConstU128<UNIT>;
	type ReferenceWeight = ZoozReferenceWeight;
}

/// Token ids are handed out in order, starting here.
pub const FIRST_ASSET_ID: u32 = 1;

parameter_types! {
	pub const FirstAssetId: u32 = FIRST_ASSET_ID;
	// Deposits are locked while the token or NFT exists and returned when it is destroyed.
	pub const AssetDeposit: Balance = 10 * UNIT;
	pub const AssetAccountDeposit: Balance = 10 * MILLI_UNIT;
	pub const MetadataDepositBase: Balance = 100 * MILLI_UNIT;
	pub const MetadataDepositPerByte: Balance = MILLI_UNIT;
	pub const ApprovalDeposit: Balance = EXISTENTIAL_DEPOSIT;
	pub const CollectionDeposit: Balance = 10 * UNIT;
	pub const ItemDeposit: Balance = 10 * MILLI_UNIT;
	pub NftFeatures: PalletFeatures = PalletFeatures::all_enabled();
	pub const NftMaxDeadline: BlockNumber = 365 * DAYS;
}

impl pallet_assets::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type Balance = Balance;
	type AssetId = u32;
	type AssetIdParameter = codec::Compact<u32>;
	type ReserveData = ();
	type Currency = Balances;
	type CreateOrigin = AsEnsureOriginWithArg<EnsureSigned<AccountId>>;
	type ForceOrigin = EnsureRoot<AccountId>;
	type AssetDeposit = AssetDeposit;
	type AssetAccountDeposit = AssetAccountDeposit;
	type MetadataDepositBase = MetadataDepositBase;
	type MetadataDepositPerByte = MetadataDepositPerByte;
	type ApprovalDeposit = ApprovalDeposit;
	type StringLimit = ConstU32<50>;
	type Holder = ();
	type Freezer = ();
	type Extra = ();
	type CallbackHandle = ();
	type AssetIdAllocator = pallet_assets::AutoIncAssetId<Runtime>;
	type WeightInfo = pallet_assets::weights::SubstrateWeight<Runtime>;
	type RemoveItemsLimit = ConstU32<1000>;
	#[cfg(feature = "runtime-benchmarks")]
	type BenchmarkHelper = ();
}

impl pallet_nfts::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type CollectionId = u32;
	type ItemId = u32;
	type Currency = Balances;
	type ForceOrigin = EnsureRoot<AccountId>;
	type CreateOrigin = AsEnsureOriginWithArg<EnsureSigned<AccountId>>;
	type Locker = ();
	type CollectionDeposit = CollectionDeposit;
	type ItemDeposit = ItemDeposit;
	type MetadataDepositBase = MetadataDepositBase;
	type AttributeDepositBase = MetadataDepositBase;
	type DepositPerByte = MetadataDepositPerByte;
	type StringLimit = ConstU32<256>;
	type KeyLimit = ConstU32<64>;
	type ValueLimit = ConstU32<256>;
	type ApprovalsLimit = ConstU32<20>;
	type ItemAttributesApprovalsLimit = ConstU32<30>;
	type MaxTips = ConstU32<10>;
	type MaxDeadlineDuration = NftMaxDeadline;
	type MaxAttributesPerCall = ConstU32<10>;
	type Features = NftFeatures;
	type OffchainSignature = Signature;
	type OffchainPublic = <Signature as Verify>::Signer;
	type WeightInfo = pallet_nfts::weights::SubstrateWeight<Runtime>;
	#[cfg(feature = "runtime-benchmarks")]
	type Helper = ();
	type BlockNumberProvider = System;
}

impl pallet_utility::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type PalletsOrigin = OriginCaller;
	type WeightInfo = pallet_utility::weights::SubstrateWeight<Runtime>;
}

/// Owner or admin of a token manage its allowlist.
pub struct AssetManagers;
impl pallet_token_allowlist::TokenManagers<u32, AccountId> for AssetManagers {
	fn is_manager(asset: &u32, who: &AccountId) -> bool {
		Assets::owner(*asset).as_ref() == Some(who) || Assets::admin(*asset).as_ref() == Some(who)
	}
}

impl pallet_token_allowlist::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type AssetId = u32;
	type Managers = AssetManagers;
	type MaxAccountsPerCall = ConstU32<100>;
}

/// Refuses token transfers and mints whose receiver is not allowed by the token's allowlist, and
/// mints of tokens whose supply is locked.
/// Root (`force_transfer` through sudo) is not filtered.
pub struct TokenTransferRules;
impl Contains<RuntimeCall> for TokenTransferRules {
	fn contains(call: &RuntimeCall) -> bool {
		use pallet_assets::Call as A;
		let RuntimeCall::Assets(call) = call else { return true };
		let (id, to) = match call {
			A::transfer { id, target, .. } | A::transfer_keep_alive { id, target, .. } => (id, target),
			A::transfer_all { id, dest, .. } => (id, dest),
			A::transfer_approved { id, destination, .. } => (id, destination),
			A::mint { id, beneficiary, .. } => {
				if !TokenAllowlist::can_mint(&id.0) {
					return false;
				}
				(id, beneficiary)
			},
			_ => return true,
		};
		match <Runtime as frame_system::Config>::Lookup::lookup(to.clone()) {
			Ok(who) => TokenAllowlist::can_receive(&id.0, &who),
			Err(_) => true,
		}
	}
}
