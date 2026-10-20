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
	AccountId, Aura, Balance, Balances, Block, BlockNumber, Hash, Historical, Nonce, Offences, PalletInfo,
	Runtime, RuntimeCall, RuntimeEvent, RuntimeFreezeReason, RuntimeHoldReason, RuntimeOrigin, RuntimeTask,
	Assets, Authorship, OriginCaller, ProofOfTrust, Signature, System, Timestamp, TokenAllowlist,
	UncheckedExtrinsic, DAYS, EXISTENTIAL_DEPOSIT, MILLI_UNIT, SLOT_DURATION, UNIT, VERSION,
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
type SingleBlockMigrations = (
	pallet_assets::migration::next_asset_id::SetNextAssetId<FirstAssetId, Runtime>,
	pallet_proof_of_trust::migrations::MigrateV0ToV1<Runtime, LedgerAttesters>,
	pallet_coali_ledger::migrations::MigrateV0ToV1<Runtime>,
	pallet_coali_ledger::migrations::MigrateV1ToV2<Runtime>,
);

/// Identity attesters at the 204 upgrade: the ledger attesters (one key for now; to be moved to
/// a separate key, see security/AUDIT-PRE-2026-10.md, ZOOZ-04).
pub struct LedgerAttesters;
impl frame_support::traits::Get<alloc::vec::Vec<AccountId>> for LedgerAttesters {
	fn get() -> alloc::vec::Vec<AccountId> {
		pallet_coali_ledger::Attesters::<Runtime>::iter_keys().collect()
	}
}

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

parameter_types! {
	/// GRANDPA set ids kept to check equivocation proofs (one per session: about 14 hours).
	pub const MaxSetIdSessionEntries: u64 = 168;
	/// Blocks an equivocation report stays valid in the pool.
	pub const ReportLongevity: u64 = 168 * 50;
}

impl pallet_grandpa::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;

	type WeightInfo = ();
	type MaxAuthorities = ConstU32<32>;
	type MaxNominators = ConstU32<0>;
	type MaxSetIdSessionEntries = MaxSetIdSessionEntries;

	// A validator signing two conflicting finality votes is reported (by any node, unsigned) and
	// handled by proof of trust through pallet_offences.
	type KeyOwnerProof = sp_session::MembershipProof;
	type EquivocationReportSystem =
		pallet_grandpa::EquivocationReportSystem<Self, Offences, Historical, ReportLongevity>;
}

impl pallet_session::historical::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type FullIdentification = ();
	type FullIdentificationOf = UnitIdentification;
}

pub struct UnitIdentification;
impl sp_runtime::traits::Convert<AccountId, Option<()>> for UnitIdentification {
	fn convert(_: AccountId) -> Option<()> {
		Some(())
	}
}

impl pallet_offences::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type IdentificationTuple = pallet_session::historical::IdentificationTuple<Self>;
	type OnOffenceHandler = ProofOfTrust;
}

/// Proof of trust as the historical session manager (no full identification to keep).
pub struct ProofOfTrustHistorical;
impl pallet_session::SessionManager<AccountId> for ProofOfTrustHistorical {
	fn new_session(new_index: u32) -> Option<alloc::vec::Vec<AccountId>> {
		<ProofOfTrust as pallet_session::SessionManager<AccountId>>::new_session(new_index)
	}
	fn end_session(index: u32) {
		<ProofOfTrust as pallet_session::SessionManager<AccountId>>::end_session(index)
	}
	fn start_session(index: u32) {
		<ProofOfTrust as pallet_session::SessionManager<AccountId>>::start_session(index)
	}
}
impl pallet_session::historical::SessionManager<AccountId, ()> for ProofOfTrustHistorical {
	fn new_session(new_index: u32) -> Option<alloc::vec::Vec<(AccountId, ())>> {
		<ProofOfTrust as pallet_session::SessionManager<AccountId>>::new_session(new_index)
			.map(|set| set.into_iter().map(|v| (v, ())).collect())
	}
	fn end_session(index: u32) {
		<ProofOfTrust as pallet_session::SessionManager<AccountId>>::end_session(index)
	}
	fn start_session(index: u32) {
		<ProofOfTrust as pallet_session::SessionManager<AccountId>>::start_session(index)
	}
}

impl<LocalCall> frame_system::offchain::CreateTransactionBase<LocalCall> for Runtime
where
	RuntimeCall: From<LocalCall>,
{
	type Extrinsic = UncheckedExtrinsic;
	type RuntimeCall = RuntimeCall;
}

impl<LocalCall> frame_system::offchain::CreateBare<LocalCall> for Runtime
where
	RuntimeCall: From<LocalCall>,
{
	fn create_bare(call: RuntimeCall) -> UncheckedExtrinsic {
		UncheckedExtrinsic::new_bare(call)
	}
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
	pub const PotMaxStrikes: u32 = 5;
	pub const PotStrikeForgiveness: BlockNumber = 7 * DAYS;
	/// No seat rotation while every validator fits in the set.
	pub const PotRotationMinValidators: u32 = 32;
	/// A newcomer takes a rotating seat if it showed it is online within the last day.
	pub const PotRecentlySeen: BlockNumber = DAYS;
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
	type SessionManager = pallet_session::historical::NoteHistoricalRoot<Self, ProofOfTrustHistorical>;
	type SessionHandler = <super::SessionKeys as sp_runtime::traits::OpaqueKeys>::KeyTypeIdProviders;
	type Keys = super::SessionKeys;
	type DisablingStrategy = ();
	type WeightInfo = ();
	type Currency = Balances;
	type KeyDeposit = ();
}

impl pallet_proof_of_trust::Config for Runtime {
	type AdminOrigin = frame_system::EnsureRoot<AccountId>;
	type TrustScore = super::CoaliLedger;
	type MaxValidators = PotMaxValidators;
	type MaxCandidates = PotMaxCandidates;
	type OfflineAfter = PotOfflineAfter;
	type MaxStrikes = PotMaxStrikes;
	type StrikeForgiveness = PotStrikeForgiveness;
	type RotationMinValidators = PotRotationMinValidators;
	type RecentlySeen = PotRecentlySeen;
}

parameter_types! {
	/// Domain separator mixed into every voter/truster signature; must differ per network.
	pub const CoaliChainTag: [u8; 8] = *b"coali-01";
}

impl pallet_coali_ledger::Config for Runtime {
	type AdminOrigin = frame_system::EnsureRoot<AccountId>;
	type Signature = super::Signature;
	type Signer = <super::Signature as sp_runtime::traits::Verify>::Signer;
	type ChainTag = CoaliChainTag;
	type Time = Timestamp;
	// The electorate of each app is published by identity attesters, a key apart from the relayer.
	type ElectorateOrigin = pallet_proof_of_trust::EnsureIdentityAttester<Runtime>;
	type MinVotingPeriod = ConstU64<{ 3_600 * 1_000 }>;
	type VoteGrace = ConstU64<{ 24 * 3_600 * 1_000 }>;
	type MaxRevealsPerCall = ConstU32<100>;
	type OnTrustChanged = ProofOfTrust;
	type OnAttesterRemoved = ProofOfTrust;
	type WeightInfo = pallet_coali_ledger::weights::Margin<pallet_coali_ledger::weights::SubstrateWeight<Runtime>, 3>;
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

/// Validators of the current session, which share the block rewards.
pub struct SessionValidatorCount;
impl frame_support::traits::Get<u32> for SessionValidatorCount {
	fn get() -> u32 {
		pallet_session::Validators::<Runtime>::decode_len().unwrap_or(0) as u32
	}
}

parameter_types! {
	/// Calibrated so that a 250-byte `record_vote` (1,656M ref_time with the benchmarked weights
	/// and their margin, plus the extrinsic base weight and the length fee) costs the target fee;
	/// checked by runtime/tests/fees.rs.
	pub const ZoozReferenceWeight: u64 = 1_997_000_000;
	pub const ZoozBlocksPerMonth: u32 = 30 * DAYS;
}

impl pallet_zooz_economy::Config for Runtime {
	type Currency = Balances;
	type AdminOrigin = frame_system::EnsureRoot<AccountId>;
	type BlockAuthor = CurrentAuthor;
	type IsApp = ApprovedApps;
	type Unit = ConstU128<UNIT>;
	type ReferenceWeight = ZoozReferenceWeight;
	type ValidatorCount = SessionValidatorCount;
	type BlocksPerMonth = ZoozBlocksPerMonth;
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
	type AssetId = u32;
	type Managers = AssetManagers;
	type MaxAccountsPerCall = ConstU32<100>;
}

/// Symbols nobody may give a token, nor use as a word of its name, and words its name may not
/// contain (compared after [`name_skeleton`]):
/// fake ZOOZ, stablecoins and major coins are the usual scam on a new chain. Root (through
/// `force_set_metadata`) can still name the foundation's own tokens.
const RESERVED_SYMBOLS: &[&str] = &[
	"ZOOZ", "COALI", "USDT", "USDC", "BUSD", "DAI", "BTC", "WBTC", "ETH", "WETH", "BNB", "DOT", "KSM",
	"SOL", "XRP", "TRUVOT",
];
const RESERVED_WORDS: &[&str] =
	&["ZOOZ", "COALI", "TETHER", "USDCOIN", "BITCOIN", "ETHEREUM", "POLKADOT", "BINANCE", "TRUVOT", "POPOLITICA"];

/// Latin capitals that the letters U+00C0–U+00FF stand for (`*` marks × and ÷, not letters).
const LATIN_1: &[u8; 64] = b"AAAAAAACEEEEIIIIDNOOOOO*OUUUUYTSAAAAAAACEEEEIIIIDNOOOOO*OUUUUYTY";
/// Latin capitals that the letters U+0100–U+017F (Latin Extended-A) stand for.
const LATIN_EXT_A: &[u8; 128] =
	b"AAAAAACCCCCCCCDDDDEEEEEEEEEEGGGGGGGGHHHHIIIIIIIIIIIIJJKKKLLLLLLLLLLNNNNNNNNNOOOOOOOORRRRRRSSSSSSSSTTTTTTUUUUUUUUUUUUWWYYYZZZZZZS";

/// What a character of a token name is, for the name rule.
#[derive(Clone, Copy, PartialEq)]
enum NameChar {
	/// A Latin letter or digit (or a sign that reads as one), as the capital or digit it shows.
	Latin(u8),
	/// A space: ends a word and a group of letters.
	Space,
	/// Punctuation, currency sign: ends a word, not a group of letters.
	Other,
	HebrewLetter,
	/// Hebrew points and accents, allowed only after a Hebrew letter.
	HebrewMark,
	ArabicLetter,
	/// Arabic vowel signs and marks, allowed only after an Arabic letter.
	ArabicMark,
	Emoji,
	/// Variation selector or zero-width joiner, allowed only inside an emoji sequence.
	Joiner,
}

/// Names use an allowlist of scripts: ASCII, accented Latin (read as plain Latin), Hebrew,
/// Arabic, punctuation, currency signs and emojis. Everything else (look-alike letters from other
/// alphabets or Unicode blocks, invisible and control characters) is refused.
fn name_char(c: char) -> Option<NameChar> {
	use NameChar::*;
	let cp = c as u32;
	// Arabic-Indic digits read as digits, except those that pass for letters (٥ for O, ٧ for V).
	let arabic_digit = |d: u32| match d {
		5 => Latin(b'O'),
		7 => Latin(b'V'),
		d => Latin(b'0' + d as u8),
	};
	Some(match cp {
		0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A => Latin((cp as u8).to_ascii_uppercase()),
		0x20 | 0xA0 => Space,
		0x21..=0x7E => Other,
		0xAA | 0xAD | 0xB2 | 0xB3 | 0xB5 | 0xB9 | 0xBA => return None,
		0xA1..=0xBF => Other,
		0xC0..=0xFF => match LATIN_1[(cp - 0xC0) as usize] {
			b'*' => Other,
			b => Latin(b),
		},
		0x100..=0x17F => Latin(LATIN_EXT_A[(cp - 0x100) as usize]),
		0x591..=0x5BD | 0x5BF | 0x5C1 | 0x5C2 | 0x5C4 | 0x5C5 | 0x5C7 => HebrewMark,
		0x5BE | 0x5C0 | 0x5C3 | 0x5C6 | 0x5F3 | 0x5F4 => Other,
		0x5D0..=0x5EA | 0x5EF..=0x5F2 => HebrewLetter,
		0x660..=0x669 => arabic_digit(cp - 0x660),
		0x6F0..=0x6F9 => arabic_digit(cp - 0x6F0),
		0x610..=0x61A | 0x64B..=0x65F | 0x670 | 0x6D6..=0x6DC | 0x6DF..=0x6E4 | 0x6E7 | 0x6E8 |
		0x6EA..=0x6ED => ArabicMark,
		0x606..=0x60F | 0x61B | 0x61D..=0x61F | 0x66A..=0x66D | 0x6D4 | 0x6DE | 0x6E9 | 0x6FD | 0x6FE =>
			Other,
		0x620..=0x64A | 0x66E | 0x66F | 0x671..=0x6D3 | 0x6D5 | 0x6E5 | 0x6E6 | 0x6EE | 0x6EF |
		0x6FA..=0x6FC | 0x6FF => ArabicLetter,
		// ₮ is Tether's sign; ₿ is Bitcoin's.
		0x20AE => Latin(b'T'),
		0x20BF => return None,
		0x2010..=0x2027 | 0x2030..=0x205E | 0x20A0..=0x20C0 => Other,
		0x2600..=0x27BF | 0x1F300..=0x1FAFF => Emoji,
		0x200D | 0xFE0F => Joiner,
		_ => return None,
	})
}

/// The Latin words of a name and all its Latin letters run together (digits 0 and 1 read as O
/// and I). Words are split by anything that is not a Latin letter; groups of letters only by
/// spaces (so `U.S.D.T` is the word USDT), and runs of single letters are joined (`U S D T`).
/// None if the name is not valid UTF-8 or uses a character outside the allowlist.
fn name_skeleton(text: &[u8]) -> Option<(alloc::vec::Vec<alloc::vec::Vec<u8>>, alloc::vec::Vec<u8>)> {
	use alloc::vec::Vec;
	use NameChar::*;
	let text = core::str::from_utf8(text).ok()?;
	let (mut words, mut all, mut word, mut group, mut groups) =
		(Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::<Vec<u8>>::new());
	let mut prev: Option<NameChar> = None;
	for c in text.chars() {
		let class = name_char(c)?;
		let follows = |allowed: &[NameChar]| prev.is_some_and(|p| allowed.contains(&p));
		match class {
			Joiner if !follows(&[Emoji, Joiner]) => return None,
			HebrewMark if !follows(&[HebrewLetter, HebrewMark]) => return None,
			ArabicMark if !follows(&[ArabicLetter, ArabicMark]) => return None,
			_ => {},
		}
		if let Latin(b) = class {
			let b = match b {
				b'0' => b'O',
				b'1' => b'I',
				b => b,
			};
			word.push(b);
			group.push(b);
			all.push(b);
		} else {
			if !word.is_empty() {
				words.push(core::mem::take(&mut word));
			}
			if class == Space && !group.is_empty() {
				groups.push(core::mem::take(&mut group));
			}
		}
		prev = Some(class);
	}
	if !word.is_empty() {
		words.push(word);
	}
	if !group.is_empty() {
		groups.push(group);
	}
	let mut single_letters = Vec::new();
	for g in groups {
		if g.len() == 1 {
			single_letters.extend_from_slice(&g);
			continue;
		}
		if single_letters.len() > 1 {
			words.push(core::mem::take(&mut single_letters));
		}
		single_letters.clear();
		words.push(g);
	}
	if single_letters.len() > 1 {
		words.push(single_letters);
	}
	Some((words, all))
}

/// Whether a token may take this name and symbol: the symbol is 1 to 12 Latin letters or digits,
/// the name only uses allowed scripts, and neither passes for a reserved name: no reserved word
/// anywhere in their Latin letters, no reserved symbol as a whole word of the name.
fn token_name_allowed(name: &[u8], symbol: &[u8]) -> bool {
	if symbol.is_empty() || symbol.len() > 12 || !symbol.iter().all(u8::is_ascii_alphanumeric) {
		return false;
	}
	let (Some((words, name)), Some((_, symbol))) = (name_skeleton(name), name_skeleton(symbol)) else {
		return false
	};
	let contains = |text: &[u8], word: &str| text.windows(word.len()).any(|w| w == word.as_bytes());
	!RESERVED_SYMBOLS.iter().any(|s| symbol == s.as_bytes() || words.iter().any(|w| w == s.as_bytes())) &&
		!RESERVED_WORDS.iter().any(|w| contains(&name, w) || contains(&symbol, w))
}

/// Rules on the token calls of plain accounts (root, through sudo, is not filtered):
/// - a token only arrives in an account that accepted it first (`assets.touch`), or with its
///   owner, so nobody can fill an account's 16 token slots with junk; a sender who wants to give a
///   token to someone new approves it (`approve_transfer`) and the receiver accepts and collects
///   it (`touch` + `transfer_approved`);
/// - receivers must be on the allowlist of restricted tokens, and locked tokens cannot be minted;
/// - freezing, blocking, seizing (`force_transfer`) and burning someone else's balance are only
///   for restricted (regulated) tokens, which are restricted before any unit exists;
/// - once anyone but the owner holds a token, it can no longer be destroyed or renamed;
/// - a locked token (`fix_supply`, the creator renouncing) can no longer be minted, destroyed,
///   renamed or restricted;
/// - reserved names and symbols are refused, including look-alikes in other alphabets, and
///   symbols are Latin letters and digits only.
pub struct TokenTransferRules;
impl Contains<RuntimeCall> for TokenTransferRules {
	fn contains(call: &RuntimeCall) -> bool {
		use pallet_assets::Call as A;
		use pallet_token_allowlist::Call as L;
		let lookup = |to: &<<Runtime as frame_system::Config>::Lookup as StaticLookup>::Source| {
			<Runtime as frame_system::Config>::Lookup::lookup(to.clone()).ok()
		};
		let details = |id: u32| pallet_assets::Asset::<Runtime>::get(id);
		let restricted = |id: u32| pallet_token_allowlist::Restricted::<Runtime>::contains_key(id);
		let locked = |id: u32| !TokenAllowlist::can_mint(&id);
		// Whether accounts other than the owner hold the token.
		let held_by_others = |id: u32| {
			details(id).is_some_and(|d| {
				let owner_holds = pallet_assets::Account::<Runtime>::contains_key(id, &d.owner);
				d.accounts > owner_holds as u32
			})
		};
		let may_receive = |id: u32, who: &AccountId| {
			TokenAllowlist::can_receive(&id, who) &&
				(pallet_assets::Account::<Runtime>::contains_key(id, who) ||
					details(id).is_some_and(|d| &d.owner == who))
		};

		match call {
			RuntimeCall::TokenAllowlist(L::set_restricted { asset, restricted: true }) =>
				!locked(*asset) && details(*asset).is_some_and(|d| d.supply == 0),
			RuntimeCall::Assets(call) => match call {
				A::transfer { id, target, .. } | A::transfer_keep_alive { id, target, .. } =>
					lookup(target).is_some_and(|to| may_receive(id.0, &to)),
				A::transfer_all { id, dest, .. } => lookup(dest).is_some_and(|to| may_receive(id.0, &to)),
				A::transfer_approved { id, destination, .. } =>
					lookup(destination).is_some_and(|to| may_receive(id.0, &to)),
				A::mint { id, beneficiary, .. } =>
					!locked(id.0) && lookup(beneficiary).is_some_and(|to| may_receive(id.0, &to)),
				A::force_transfer { id, dest, .. } =>
					restricted(id.0) && lookup(dest).is_some_and(|to| may_receive(id.0, &to)),
				A::burn { id, who, .. } =>
					restricted(id.0) ||
						lookup(who).is_some_and(|w| details(id.0).is_some_and(|d| d.admin == w)),
				A::freeze { id, .. } | A::block { id, .. } => restricted(id.0),
				A::freeze_asset { id } => restricted(id.0),
				A::touch_other { .. } => false,
				A::start_destroy { id } => !locked(id.0) && !held_by_others(id.0),
				A::set_metadata { id, name, symbol, .. } =>
					!locked(id.0) && !held_by_others(id.0) && token_name_allowed(name, symbol),
				A::clear_metadata { id } => !locked(id.0) && !held_by_others(id.0),
				_ => true,
			},
			_ => true,
		}
	}
}

parameter_types! {
	// Deposits locked while a multisig operation or a proxy exists.
	pub const MultisigDepositBase: Balance = 100 * MILLI_UNIT;
	pub const MultisigDepositFactor: Balance = 10 * MILLI_UNIT;
	pub const ProxyDepositBase: Balance = 100 * MILLI_UNIT;
	pub const ProxyDepositFactor: Balance = 10 * MILLI_UNIT;
	pub const AnnouncementDepositBase: Balance = 100 * MILLI_UNIT;
	pub const AnnouncementDepositFactor: Balance = 10 * MILLI_UNIT;
}

/// Several keys approving one call: the target home of the sudo key (and later of governance).
impl pallet_multisig::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type Currency = Balances;
	type DepositBase = MultisigDepositBase;
	type DepositFactor = MultisigDepositFactor;
	type MaxSignatories = ConstU32<16>;
	type WeightInfo = pallet_multisig::weights::SubstrateWeight<Runtime>;
	type BlockNumberProvider = System;
}

/// What a proxy key may do on behalf of its account.
#[derive(
	Copy, Clone, Eq, PartialEq, Ord, PartialOrd, codec::Encode, codec::Decode,
	codec::DecodeWithMemTracking, codec::MaxEncodedLen, Debug, scale_info::TypeInfo, Default,
)]
pub enum ProxyType {
	/// Everything.
	#[default]
	Any,
	/// Only `sudo(grandpa.note_stalled)`: lets the finality watchdog run with a key that can do
	/// nothing else, while the sudo key stays offline.
	FinalityWatchdog,
}

impl frame_support::traits::InstanceFilter<RuntimeCall> for ProxyType {
	fn filter(&self, call: &RuntimeCall) -> bool {
		match self {
			ProxyType::Any => true,
			ProxyType::FinalityWatchdog => matches!(
				call,
				RuntimeCall::Sudo(pallet_sudo::Call::sudo { call })
					if matches!(**call, RuntimeCall::Grandpa(pallet_grandpa::Call::note_stalled { .. }))
			),
		}
	}
	fn is_superset(&self, other: &Self) -> bool {
		self == &ProxyType::Any || self == other
	}
}

impl pallet_proxy::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type Currency = Balances;
	type ProxyType = ProxyType;
	type ProxyDepositBase = ProxyDepositBase;
	type ProxyDepositFactor = ProxyDepositFactor;
	type MaxProxies = ConstU32<8>;
	type WeightInfo = pallet_proxy::weights::SubstrateWeight<Runtime>;
	type MaxPending = ConstU32<8>;
	type CallHasher = sp_runtime::traits::BlakeTwo256;
	type AnnouncementDepositBase = AnnouncementDepositBase;
	type AnnouncementDepositFactor = AnnouncementDepositFactor;
	type BlockNumberProvider = System;
}
