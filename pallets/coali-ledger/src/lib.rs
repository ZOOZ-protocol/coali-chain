//! # Coali ledger
//!
//! Proof ledger for the Coali board protocol (`docs/protocol/coali-trust-protocol.md`
//! in the Popolitica repository). Tallies are computed off-chain; this pallet records
//! what is needed to verify them:
//!
//! - decisions: an id, the clear question and options, the time voting ends and the number
//!   of eligible voters the app declares (it can only raise it, publicly),
//! - one vote commitment per voter address and decision, signed by the voter, at most the
//!   declared number of eligible voters, chained into an on-chain vote log,
//! - trust given or revoked between trust addresses, signed by the truster, in a category: a
//!   domain (economy, justice…), counted across every app, or a position (prime minister…),
//!   counted per app since a position belongs to the country or community of the app,
//! - successive result snapshots: clear totals that must add up to the votes recorded on
//!   chain, the vote log at that point and a Merkle root of the votes. The final one closes
//!   the decision, and cannot come before voting ends.
//!
//! Only accounts registered as attesters (approved apps) can submit extrinsics, and only the
//! attester that registered a decision can write to it. An attester vouches that the voter
//! is eligible; the voter signature proves the voter key holder agreed. No personal data is
//! stored: ids are opaque, votes are commitments.
//!
//! Decisions registered before runtime 204 have no end time, voter cap or vote log; their
//! text and totals were published separately (`publish_content`, `publish_totals`).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

pub mod migrations;
pub mod weights;
pub use weights::WeightInfo;

/// Opaque decision id (the Popolitica decision UUID bytes).
pub type DecisionId = [u8; 16];
/// 32-byte hash (blake2-256 unless stated otherwise).
pub type Hash32 = [u8; 32];

/// Max size of a category key (`economy`, `prime_minister`…).
pub type MaxCategoryKeyLen = frame_support::traits::ConstU32<32>;

/// The common category list (`docs/CATEGORIES.md`), seeded by the v1 -> v2 migration:
/// (id, key, domain of a position). Ids are the ones Popolitica already used on chain.
pub const DEFAULT_CATEGORIES: &[(u32, &[u8], Option<u32>)] = &[
	(1, b"economy", None),
	(2, b"security", None),
	(3, b"education", None),
	(4, b"health", None),
	(5, b"justice", None),
	(6, b"environment", None),
	(7, b"transport", None),
	(8, b"housing", None),
	(9, b"technology", None),
	(10, b"agriculture", None),
	(11, b"energy", None),
	(12, b"culture", None),
	(13, b"sports", None),
	(14, b"tourism", None),
	(15, b"science", None),
	(16, b"media", None),
	(17, b"welfare", None),
	(18, b"interior", None),
	(19, b"foreign", None),
	(20, b"family", None),
	(21, b"general", None),
	(22, b"politics", None),
	(23, b"ai", None),
	(24, b"prime_minister", Some(22)),
	(25, b"supreme_court_president", Some(5)),
	(26, b"supreme_court_justice", Some(5)),
	(27, b"attorney_general", Some(5)),
	(28, b"state_attorney", Some(5)),
	(29, b"justice_minister", Some(5)),
	(30, b"public_diplomacy", None),
	(31, b"national_hasbara_head", Some(30)),
	(32, b"foreign_minister", Some(19)),
	(33, b"un_ambassador", Some(19)),
	(34, b"us_ambassador", Some(19)),
	(35, b"diaspora_minister", Some(19)),
	(36, b"army_spokesperson", Some(2)),
];

/// Max size of a decision's canonical JSON content (question and options).
pub type MaxContentLen = frame_support::traits::ConstU32<8192>;
/// Max size of a snapshot's canonical JSON totals ({ option id: votes }).
pub type MaxTotalsLen = frame_support::traits::ConstU32<2048>;

fn blake2_256(data: &[u8]) -> Hash32 {
	<sp_runtime::traits::BlakeTwo256 as sp_runtime::traits::Hash>::hash(data).0
}

pub const VOTE_CONTEXT: &[u8] = b"coali/vote/v1";
pub const TRUST_CONTEXT: &[u8] = b"coali/trust/v1";
pub const VOTE_LOG_CONTEXT: &[u8] = b"coali/votelog/v1";
/// Merkle scheme of snapshots published from runtime 204: leaf = blake2(0x00 ‖ voter ‖
/// commitment), node = blake2(0x01 ‖ left ‖ right). Older snapshots used version 1 (no prefix).
pub const MERKLE_VERSION: u8 = 2;

/// Trust an account receives, read by the proof-of-trust validator selection.
pub trait TrustScore<AccountId> {
	/// Number of distinct accounts trusting `who`, in any category.
	fn trust_received(who: &AccountId) -> u32;
	/// Distinct accounts trusting `who`, in any category.
	fn trusters_of(who: &AccountId) -> alloc::vec::Vec<AccountId>;
	/// Distinct accounts that `who` trusts, in any category.
	fn trusted_by(who: &AccountId) -> alloc::vec::Vec<AccountId>;
}

/// Told when the first trust from `truster` to `trusted` appears (in any category) and when the
/// last one goes.
pub trait OnTrustChanged<AccountId> {
	fn pair_added(truster: &AccountId, trusted: &AccountId);
	fn pair_removed(truster: &AccountId, trusted: &AccountId);
}

impl<AccountId> OnTrustChanged<AccountId> for () {
	fn pair_added(_: &AccountId, _: &AccountId) {}
	fn pair_removed(_: &AccountId, _: &AccountId) {}
}

/// Told when an attester is removed, so that what it vouched for elsewhere can be withdrawn.
pub trait OnAttesterRemoved<AccountId> {
	fn attester_removed(who: &AccountId);
}

impl<AccountId> OnAttesterRemoved<AccountId> for () {
	fn attester_removed(_: &AccountId) {}
}

impl<T: Config> TrustScore<T::AccountId> for Pallet<T> {
	fn trust_received(who: &T::AccountId) -> u32 {
		TrustReceived::<T>::get(who)
	}
	fn trusters_of(who: &T::AccountId) -> alloc::vec::Vec<T::AccountId> {
		TrustPairs::<T>::iter_key_prefix(who).collect()
	}
	fn trusted_by(who: &T::AccountId) -> alloc::vec::Vec<T::AccountId> {
		let mut out: alloc::vec::Vec<T::AccountId> =
			TrustEdges::<T>::iter_key_prefix((who,)).map(|(trusted, _)| trusted).collect();
		out.sort();
		out.dedup();
		out
	}
}

/// Origin check: a signed origin from a registered attester.
pub struct EnsureAttester<T>(core::marker::PhantomData<T>);

impl<T: Config> frame_support::traits::EnsureOrigin<T::RuntimeOrigin> for EnsureAttester<T> {
	type Success = T::AccountId;

	fn try_origin(o: T::RuntimeOrigin) -> Result<T::AccountId, T::RuntimeOrigin> {
		match frame_system::ensure_signed(o.clone()) {
			Ok(who) if Attesters::<T>::contains_key(&who) => Ok(who),
			_ => Err(o),
		}
	}

	#[cfg(feature = "runtime-benchmarks")]
	fn try_successful_origin() -> Result<T::RuntimeOrigin, ()> {
		Err(())
	}
}

/// Parses canonical totals JSON, `{"<option id>":<votes>,...}` with keys in strictly increasing
/// byte order, no spaces, printable ASCII keys without `"` or `\\`, and integers without leading
/// zeros: the output of the protocol's canonical JSON for a tally. Returns (option, votes) pairs.
pub fn parse_tally(json: &[u8]) -> Option<alloc::vec::Vec<(&[u8], u64)>> {
	let mut out = alloc::vec::Vec::new();
	let mut i = 0usize;
	let next = |i: &mut usize| -> Option<u8> {
		let c = *json.get(*i)?;
		*i += 1;
		Some(c)
	};
	if next(&mut i)? != b'{' {
		return None;
	}
	if json.get(i) == Some(&b'}') {
		return (i + 1 == json.len()).then_some(out);
	}
	loop {
		if next(&mut i)? != b'"' {
			return None;
		}
		let start = i;
		loop {
			match next(&mut i)? {
				b'"' => break,
				b'\\' => return None,
				0x20..=0x7e => {},
				_ => return None,
			}
		}
		let key = &json[start..i - 1];
		if key.is_empty() || out.last().is_some_and(|(p, _): &(&[u8], u64)| *p >= key) {
			return None;
		}
		if next(&mut i)? != b':' {
			return None;
		}
		let digits = i;
		let mut value: u64 = 0;
		while let Some(c @ b'0'..=b'9') = json.get(i).copied() {
			value = value.checked_mul(10)?.checked_add((c - b'0') as u64)?;
			i += 1;
		}
		let len = i - digits;
		if len == 0 || (len > 1 && json[digits] == b'0') {
			return None;
		}
		out.push((key, value));
		match next(&mut i)? {
			b',' => continue,
			b'}' => return (i == json.len()).then_some(out),
			_ => return None,
		}
	}
}

/// Sum of the votes in canonical totals JSON (see `parse_tally`).
pub fn parse_totals(json: &[u8]) -> Option<u64> {
	parse_tally(json)?.iter().try_fold(0u64, |sum, (_, n)| sum.checked_add(*n))
}

/// Vote commitment, as computed by the app: blake2_256("coali/commit/v1|<uuid>|<option>|<salt hex>"),
/// where <uuid> is the decision id in lowercase 8-4-4-4-12 form.
pub fn commitment_of(decision_id: &DecisionId, option: &[u8], salt_hex: &[u8]) -> Hash32 {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut buf = alloc::vec::Vec::with_capacity(16 + 36 + option.len() + salt_hex.len() + 2);
	buf.extend_from_slice(b"coali/commit/v1|");
	for (i, b) in decision_id.iter().enumerate() {
		if matches!(i, 4 | 6 | 8 | 10) {
			buf.push(b'-');
		}
		buf.push(HEX[(b >> 4) as usize]);
		buf.push(HEX[(b & 15) as usize]);
	}
	buf.push(b'|');
	buf.extend_from_slice(option);
	buf.push(b'|');
	buf.extend_from_slice(salt_hex);
	blake2_256(&buf)
}

/// Option id of a revealed vote.
pub type MaxOptionLen = frame_support::traits::ConstU32<64>;
/// Salt of a revealed vote, as 64 lowercase hex characters.
pub type SaltHex = [u8; 64];

#[frame_support::pallet]
pub mod pallet {
	use super::*;
	use alloc::vec::Vec;
	use frame_support::{pallet_prelude::*, traits::UnixTime};
	use frame_system::pallet_prelude::*;
	use sp_runtime::traits::{IdentifyAccount, Verify};

	#[derive(
		Encode, Decode, DecodeWithMemTracking, Clone, Copy, PartialEq, Eq, Debug, TypeInfo,
		MaxEncodedLen,
	)]
	pub enum VoteKind {
		/// The voter chose the option.
		Direct,
		/// Deduced from the voter's board, then confirmed or past its change window.
		Inferred,
	}

	#[derive(
		Encode, Decode, DecodeWithMemTracking, Clone, Copy, PartialEq, Eq, Debug, TypeInfo,
		MaxEncodedLen,
	)]
	pub enum TrustAction {
		Give,
		Revoke,
	}

	#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	pub struct DecisionInfo<AccountId, BlockNumber> {
		pub content_hash: Hash32,
		pub category: u32,
		pub registered_by: AccountId,
		pub registered_at: BlockNumber,
		pub closed: bool,
	}

	/// Rules of a decision registered from runtime 204.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	pub struct DecisionRules {
		/// Unix time (ms) when voting ends; no final snapshot before. `None`: no end set.
		pub ends_at: Option<u64>,
		/// Eligible voters declared by the app; no more votes than this are accepted.
		pub max_voters: u32,
	}

	#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	pub struct VoteRecord<BlockNumber> {
		pub commitment: Hash32,
		pub kind: VoteKind,
		pub recorded_at: BlockNumber,
	}

	#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	pub struct SnapshotInfo<BlockNumber> {
		pub merkle_root: Hash32,
		pub totals_hash: Hash32,
		pub is_final: bool,
		pub published_at: BlockNumber,
	}

	#[derive(
		Encode, Decode, DecodeWithMemTracking, Clone, Copy, PartialEq, Eq, Debug, TypeInfo,
		MaxEncodedLen,
	)]
	pub enum CategoryKind {
		/// A field of expertise, the same in every country: its trust is counted across apps.
		Domain,
		/// A post one runs for (prime minister…), within a domain; its trust is counted per app.
		Position,
	}

	#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	pub struct CategoryInfo {
		pub kind: CategoryKind,
		/// The domain of a position (`None` for a domain).
		pub domain: Option<u32>,
		pub key: BoundedVec<u8, MaxCategoryKeyLen>,
	}

	/// One vote opened after the decision closed: its option and salt, checked against the
	/// commitment recorded at voting time.
	#[derive(Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo)]
	pub struct Reveal<AccountId> {
		pub voter: AccountId,
		pub option: BoundedVec<u8, MaxOptionLen>,
		pub salt: SaltHex,
	}

	/// Result of the chain's own count, once every vote of a closed decision was revealed.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	pub struct Recount {
		/// The final totals published by the app equal the chain's count, option by option.
		pub matches: bool,
		pub votes: u32,
	}

	/// What the chain itself checked when a snapshot was published (runtime 204 and later).
	#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	pub struct SnapshotProof {
		/// Votes recorded on chain for the decision; the totals add up to this.
		pub vote_count: u32,
		/// The decision's vote log at that point (`None` for decisions registered before 204).
		pub vote_log: Option<Hash32>,
		/// Merkle scheme of `merkle_root` (see `MERKLE_VERSION`).
		pub merkle_version: u8,
	}

	/// 1: the storage layout of runtime 204; 2: categories and trust counted per category
	/// (runtime 207). See `migrations`.
	pub(crate) const STORAGE_VERSION: StorageVersion = StorageVersion::new(2);

	#[pallet::pallet]
	#[pallet::storage_version(STORAGE_VERSION)]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		/// Origin allowed to add and remove attesters.
		type AdminOrigin: EnsureOrigin<Self::RuntimeOrigin>;
		/// Signature scheme of voter and truster keys.
		type Signature: Verify<Signer = Self::Signer> + Parameter;
		type Signer: IdentifyAccount<AccountId = Self::AccountId>;
		/// Domain separator included in every signed payload, unique per network.
		#[pallet::constant]
		type ChainTag: Get<[u8; 8]>;
		/// Current time, to enforce decision end times.
		type Time: UnixTime;
		/// Publishes the electorate of each app (identity attesters, a key apart from the apps'
		/// relayers); it caps the voters an app can declare for a decision.
		type ElectorateOrigin: EnsureOrigin<Self::RuntimeOrigin, Success = Self::AccountId>;
		/// Shortest voting period from registration (or from rules set on an older decision), ms.
		#[pallet::constant]
		type MinVotingPeriod: Get<u64>;
		/// How long after the end votes are still accepted (votes deduced from a board become
		/// official at the end and reach the chain shortly after), ms.
		#[pallet::constant]
		type VoteGrace: Get<u64>;
		/// Votes revealed per call.
		#[pallet::constant]
		type MaxRevealsPerCall: Get<u32>;
		type OnTrustChanged: OnTrustChanged<Self::AccountId>;
		type OnAttesterRemoved: OnAttesterRemoved<Self::AccountId>;
		type WeightInfo: WeightInfo;
	}

	#[pallet::storage]
	pub type Attesters<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, (), OptionQuery>;

	#[pallet::storage]
	pub type Decisions<T: Config> = StorageMap<
		_,
		Blake2_128Concat,
		DecisionId,
		DecisionInfo<T::AccountId, BlockNumberFor<T>>,
		OptionQuery,
	>;

	/// End time and voter cap of decisions registered from runtime 204.
	#[pallet::storage]
	pub type DecisionRulesOf<T: Config> =
		StorageMap<_, Blake2_128Concat, DecisionId, DecisionRules, OptionQuery>;

	#[pallet::storage]
	pub type Votes<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		DecisionId,
		Blake2_128Concat,
		T::AccountId,
		VoteRecord<BlockNumberFor<T>>,
		OptionQuery,
	>;

	#[pallet::storage]
	pub type VoteCount<T: Config> = StorageMap<_, Blake2_128Concat, DecisionId, u32, ValueQuery>;

	/// Running hash of the votes of a decision, in recording order:
	/// `log = blake2(VOTE_LOG_CONTEXT ‖ log ‖ voter ‖ commitment ‖ kind)`, starting from zero.
	/// Kept for decisions registered from runtime 204.
	#[pallet::storage]
	pub type VoteLog<T: Config> = StorageMap<_, Blake2_128Concat, DecisionId, Hash32, OptionQuery>;

	/// (truster, trusted, category) -> block of the trust.
	#[pallet::storage]
	pub type TrustEdges<T: Config> = StorageNMap<
		_,
		(
			NMapKey<Blake2_128Concat, T::AccountId>,
			NMapKey<Blake2_128Concat, T::AccountId>,
			NMapKey<Twox64Concat, u32>,
		),
		BlockNumberFor<T>,
		OptionQuery,
	>;

	/// Next expected trust nonce per truster (replay protection).
	#[pallet::storage]
	pub type TrustNonces<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

	/// (trusted, truster) -> number of categories in which truster trusts trusted.
	#[pallet::storage]
	pub type TrustPairs<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		T::AccountId,
		Blake2_128Concat,
		T::AccountId,
		u32,
		ValueQuery,
	>;

	/// Number of distinct trusters of an account, whatever the category.
	#[pallet::storage]
	pub type TrustReceived<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

	/// The category registry (`DEFAULT_CATEGORIES` at genesis or by the v1 -> v2 migration, then
	/// the admin origin). New trusts must name a registered category (runtime 208); trusts
	/// recorded before in an unregistered id were counted like domains and can still be revoked.
	#[pallet::storage]
	pub type Categories<T: Config> = StorageMap<_, Twox64Concat, u32, CategoryInfo, OptionQuery>;

	/// Trusts currently recorded in a category (every app, every trusted address).
	#[pallet::storage]
	pub type CategoryUse<T: Config> = StorageMap<_, Twox64Concat, u32, u32, ValueQuery>;

	/// (trusted, domain) -> distinct trusters of `trusted` in that domain, through any app.
	#[pallet::storage]
	pub type TrustReceivedIn<T: Config> =
		StorageDoubleMap<_, Blake2_128Concat, T::AccountId, Twox64Concat, u32, u32, ValueQuery>;

	/// (trusted, app, position) -> distinct trusters of `trusted` for that position in that app.
	#[pallet::storage]
	pub type TrustReceivedFor<T: Config> = StorageNMap<
		_,
		(
			NMapKey<Blake2_128Concat, T::AccountId>,
			NMapKey<Blake2_128Concat, T::AccountId>,
			NMapKey<Twox64Concat, u32>,
		),
		u32,
		ValueQuery,
	>;

	/// (truster, trusted, position) -> the app (attester) that recorded a trust in a position,
	/// whose count it belongs to. Trusts in a domain have none.
	#[pallet::storage]
	pub type TrustEdgeApp<T: Config> = StorageNMap<
		_,
		(
			NMapKey<Blake2_128Concat, T::AccountId>,
			NMapKey<Blake2_128Concat, T::AccountId>,
			NMapKey<Twox64Concat, u32>,
		),
		T::AccountId,
		OptionQuery,
	>;

	#[pallet::storage]
	pub type Snapshots<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		DecisionId,
		Twox64Concat,
		u32,
		SnapshotInfo<BlockNumberFor<T>>,
		OptionQuery,
	>;

	/// Checks made by the chain on snapshots published from runtime 204.
	#[pallet::storage]
	pub type SnapshotProofs<T: Config> =
		StorageDoubleMap<_, Blake2_128Concat, DecisionId, Twox64Concat, u32, SnapshotProof, OptionQuery>;

	#[pallet::storage]
	pub type LatestSnapshot<T: Config> = StorageMap<_, Blake2_128Concat, DecisionId, u32, OptionQuery>;

	/// Electorate of an app (eligible voters), published by an identity attester. No decision of
	/// that app may declare more voters.
	#[pallet::storage]
	pub type Electorate<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

	/// Votes of a closed decision already revealed.
	#[pallet::storage]
	pub type Revealed<T: Config> =
		StorageDoubleMap<_, Blake2_128Concat, DecisionId, Blake2_128Concat, T::AccountId, (), OptionQuery>;

	#[pallet::storage]
	pub type RevealedCount<T: Config> = StorageMap<_, Blake2_128Concat, DecisionId, u32, ValueQuery>;

	/// The chain's own count of revealed votes, per option.
	#[pallet::storage]
	pub type RevealedTally<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		DecisionId,
		Blake2_128Concat,
		BoundedVec<u8, MaxOptionLen>,
		u32,
		ValueQuery,
	>;

	/// Set once every vote of a closed decision is revealed.
	#[pallet::storage]
	pub type RecountOf<T: Config> = StorageMap<_, Blake2_128Concat, DecisionId, Recount, OptionQuery>;

	/// Sequence number of a decision's final snapshot.
	#[pallet::storage]
	pub type FinalSnapshot<T: Config> = StorageMap<_, Blake2_128Concat, DecisionId, u32, OptionQuery>;

	/// Clear content of a decision, matching its `content_hash`.
	#[pallet::storage]
	pub type DecisionContent<T: Config> =
		StorageMap<_, Blake2_128Concat, DecisionId, BoundedVec<u8, MaxContentLen>, OptionQuery>;

	/// Clear totals of a snapshot, matching its `totals_hash`.
	#[pallet::storage]
	pub type SnapshotTotals<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		DecisionId,
		Twox64Concat,
		u32,
		BoundedVec<u8, MaxTotalsLen>,
		OptionQuery,
	>;

	#[pallet::genesis_config]
	#[derive(frame_support::DefaultNoBound)]
	pub struct GenesisConfig<T: Config> {
		pub attesters: Vec<T::AccountId>,
	}

	#[pallet::genesis_build]
	impl<T: Config> BuildGenesisConfig for GenesisConfig<T> {
		fn build(&self) {
			for who in &self.attesters {
				Attesters::<T>::insert(who, ());
			}
			for (id, key, domain) in DEFAULT_CATEGORIES {
				let kind = if domain.is_some() { CategoryKind::Position } else { CategoryKind::Domain };
				let key = BoundedVec::truncate_from(key.to_vec());
				Categories::<T>::insert(id, CategoryInfo { kind, domain: *domain, key });
			}
		}
	}

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		AttesterAdded { who: T::AccountId },
		AttesterRemoved { who: T::AccountId },
		DecisionRegistered { decision_id: DecisionId, content_hash: Hash32, category: u32 },
		/// Rules of a decision registered from runtime 204 (also emitted when the cap is raised).
		DecisionRulesSet { decision_id: DecisionId, ends_at: Option<u64>, max_voters: u32 },
		VoteRecorded { decision_id: DecisionId, voter: T::AccountId, commitment: Hash32, kind: VoteKind },
		TrustRecorded {
			truster: T::AccountId,
			trusted: T::AccountId,
			category: u32,
			action: TrustAction,
			nonce: u32,
		},
		SnapshotPublished {
			decision_id: DecisionId,
			seq: u32,
			merkle_root: Hash32,
			totals_hash: Hash32,
			is_final: bool,
		},
		/// Checked by the chain for snapshots published from runtime 204.
		SnapshotChecked {
			decision_id: DecisionId,
			seq: u32,
			vote_count: u32,
			vote_log: Option<Hash32>,
			merkle_version: u8,
		},
		ContentPublished { decision_id: DecisionId },
		TotalsPublished { decision_id: DecisionId, seq: u32 },
		ElectorateSet { app: T::AccountId, voters: u32 },
		VotesRevealed { decision_id: DecisionId, count: u32 },
		/// Every vote revealed: the chain's count, compared with the final totals.
		ResultRecounted { decision_id: DecisionId, votes: u32, matches: bool },
		CategorySet { id: u32, kind: CategoryKind, domain: Option<u32> },
	}

	#[pallet::error]
	pub enum Error<T> {
		NotAttester,
		AttesterExists,
		UnknownAttester,
		DecisionExists,
		UnknownDecision,
		DecisionClosed,
		AlreadyVoted,
		BadVoterSignature,
		BadTrusterSignature,
		BadTrustNonce,
		SelfTrust,
		AlreadyTrusted,
		TrustNotFound,
		SnapshotOutOfOrder,
		Overflow,
		UnknownSnapshot,
		ContentMismatch,
		TotalsMismatch,
		AlreadyPublished,
		/// Only the attester that registered the decision can write to it.
		NotRegistrar,
		/// More votes than the eligible voters declared for the decision.
		TooManyVotes,
		/// The voter cap can only go up.
		CapLowered,
		/// A final snapshot before the decision's end time.
		VotingNotEnded,
		/// Totals are not canonical JSON `{"option":votes,...}`.
		BadTotals,
		/// The totals do not add up to the votes recorded on chain.
		TotalsNotVoteCount,
		/// Only for decisions or snapshots from before runtime 204.
		NotLegacy,
		/// More voters than the app's published electorate.
		AboveElectorate,
		/// The end of voting must leave at least `MinVotingPeriod`.
		VotingTooShort,
		/// The decision has no rules yet (registered before 204): set them first.
		NoRules,
		/// Rules are already set.
		RulesExist,
		/// Voting ended (grace period included), or the cap cannot change after the end.
		VotingEnded,
		/// Votes are revealed once the decision is closed.
		NotClosed,
		UnknownVote,
		AlreadyRevealed,
		/// The option and salt do not match the commitment recorded for this vote.
		RevealMismatch,
		TooManyReveals,
		/// A position needs a registered domain; a domain has none.
		BadDomain,
		/// A category in use (trusts recorded) cannot change kind.
		CategoryInUse,
		/// Trust is given in categories of the registry only.
		UnknownCategory,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::add_attester())]
		pub fn add_attester(origin: OriginFor<T>, who: T::AccountId) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			ensure!(!Attesters::<T>::contains_key(&who), Error::<T>::AttesterExists);
			Attesters::<T>::insert(&who, ());
			Self::deposit_event(Event::AttesterAdded { who });
			Ok(())
		}

		/// Removes an attester and withdraws what it vouched for (`OnAttesterRemoved`).
		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::remove_attester())]
		pub fn remove_attester(origin: OriginFor<T>, who: T::AccountId) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			ensure!(Attesters::<T>::contains_key(&who), Error::<T>::UnknownAttester);
			Attesters::<T>::remove(&who);
			T::OnAttesterRemoved::attester_removed(&who);
			Self::deposit_event(Event::AttesterRemoved { who });
			Ok(())
		}

		/// Registers a decision with its clear content (canonical JSON of the question and
		/// options, hashed on chain), the time voting ends (at least `MinVotingPeriod` from now)
		/// and the number of eligible voters (at most the app's published electorate).
		#[pallet::call_index(2)]
		#[pallet::weight(T::WeightInfo::register_decision(content.len() as u32))]
		pub fn register_decision(
			origin: OriginFor<T>,
			decision_id: DecisionId,
			content: BoundedVec<u8, MaxContentLen>,
			category: u32,
			ends_at: u64,
			max_voters: u32,
		) -> DispatchResult {
			let attester = Self::ensure_attester(origin)?;
			ensure!(!Decisions::<T>::contains_key(decision_id), Error::<T>::DecisionExists);
			Self::check_rules(&attester, ends_at, max_voters)?;
			let ends_at = Some(ends_at);
			let content_hash = blake2_256(&content);
			Decisions::<T>::insert(
				decision_id,
				DecisionInfo {
					content_hash,
					category,
					registered_by: attester,
					registered_at: frame_system::Pallet::<T>::block_number(),
					closed: false,
				},
			);
			DecisionRulesOf::<T>::insert(decision_id, DecisionRules { ends_at, max_voters });
			VoteLog::<T>::insert(decision_id, [0u8; 32]);
			DecisionContent::<T>::insert(decision_id, content);
			Self::deposit_event(Event::DecisionRegistered { decision_id, content_hash, category });
			Self::deposit_event(Event::DecisionRulesSet { decision_id, ends_at, max_voters });
			Self::deposit_event(Event::ContentPublished { decision_id });
			Ok(())
		}

		#[pallet::call_index(3)]
		#[pallet::weight(T::WeightInfo::record_vote())]
		pub fn record_vote(
			origin: OriginFor<T>,
			decision_id: DecisionId,
			voter: T::AccountId,
			commitment: Hash32,
			kind: VoteKind,
			voter_signature: T::Signature,
		) -> DispatchResult {
			let attester = Self::ensure_attester(origin)?;
			let decision = Decisions::<T>::get(decision_id).ok_or(Error::<T>::UnknownDecision)?;
			ensure!(decision.registered_by == attester, Error::<T>::NotRegistrar);
			ensure!(!decision.closed, Error::<T>::DecisionClosed);
			ensure!(!Votes::<T>::contains_key(decision_id, &voter), Error::<T>::AlreadyVoted);

			let count = VoteCount::<T>::get(decision_id).checked_add(1).ok_or(Error::<T>::Overflow)?;
			let rules = DecisionRulesOf::<T>::get(decision_id).ok_or(Error::<T>::NoRules)?;
			ensure!(count <= rules.max_voters, Error::<T>::TooManyVotes);
			if let Some(ends_at) = rules.ends_at {
				ensure!(Self::now() <= ends_at.saturating_add(T::VoteGrace::get()), Error::<T>::VotingEnded);
			}

			let payload = Self::vote_payload(&decision_id, &voter, &commitment, kind);
			ensure!(voter_signature.verify(&payload[..], &voter), Error::<T>::BadVoterSignature);

			if let Some(log) = VoteLog::<T>::get(decision_id) {
				VoteLog::<T>::insert(decision_id, Self::next_vote_log(&log, &voter, &commitment, kind));
			}
			Votes::<T>::insert(
				decision_id,
				&voter,
				VoteRecord { commitment, kind, recorded_at: frame_system::Pallet::<T>::block_number() },
			);
			VoteCount::<T>::insert(decision_id, count);
			Self::deposit_event(Event::VoteRecorded { decision_id, voter, commitment, kind });
			Ok(())
		}

		#[pallet::call_index(4)]
		#[pallet::weight(T::WeightInfo::record_trust().saturating_add(T::DbWeight::get().reads_writes(3, 3)))]
		pub fn record_trust(
			origin: OriginFor<T>,
			truster: T::AccountId,
			trusted: T::AccountId,
			category: u32,
			action: TrustAction,
			nonce: u32,
			truster_signature: T::Signature,
		) -> DispatchResult {
			let app = Self::ensure_attester(origin)?;
			ensure!(truster != trusted, Error::<T>::SelfTrust);
			ensure!(TrustNonces::<T>::get(&truster) == nonce, Error::<T>::BadTrustNonce);

			let payload = Self::trust_payload(&truster, &trusted, category, action, nonce);
			ensure!(truster_signature.verify(&payload[..], &truster), Error::<T>::BadTrusterSignature);

			let key = (truster.clone(), trusted.clone(), category);
			match action {
				TrustAction::Give => {
					ensure!(Categories::<T>::contains_key(category), Error::<T>::UnknownCategory);
					ensure!(!TrustEdges::<T>::contains_key(&key), Error::<T>::AlreadyTrusted);
					TrustEdges::<T>::insert(&key, frame_system::Pallet::<T>::block_number());
					Self::count_trust(&key, Some(&app));
					let categories = TrustPairs::<T>::get(&trusted, &truster);
					TrustPairs::<T>::insert(&trusted, &truster, categories.saturating_add(1));
					if categories == 0 {
						TrustReceived::<T>::mutate(&trusted, |n| *n = n.saturating_add(1));
						T::OnTrustChanged::pair_added(&truster, &trusted);
					}
				},
				TrustAction::Revoke => {
					ensure!(TrustEdges::<T>::contains_key(&key), Error::<T>::TrustNotFound);
					TrustEdges::<T>::remove(&key);
					Self::count_trust(&key, None);
					let categories = TrustPairs::<T>::get(&trusted, &truster).saturating_sub(1);
					if categories == 0 {
						TrustPairs::<T>::remove(&trusted, &truster);
						TrustReceived::<T>::mutate(&trusted, |n| *n = n.saturating_sub(1));
						T::OnTrustChanged::pair_removed(&truster, &trusted);
					} else {
						TrustPairs::<T>::insert(&trusted, &truster, categories);
					}
				},
			}
			let next = nonce.checked_add(1).ok_or(Error::<T>::Overflow)?;
			TrustNonces::<T>::insert(&truster, next);
			Self::deposit_event(Event::TrustRecorded { truster, trusted, category, action, nonce });
			Ok(())
		}

		/// Publishes a result snapshot with its clear totals. The totals must add up to the
		/// votes recorded on chain; the chain stores their hash, the vote count and the vote
		/// log beside the Merkle root (`MERKLE_VERSION`). The final snapshot closes the decision
		/// and is refused before the decision's end time.
		#[pallet::call_index(5)]
		#[pallet::weight(T::WeightInfo::publish_snapshot(totals.len() as u32))]
		pub fn publish_snapshot(
			origin: OriginFor<T>,
			decision_id: DecisionId,
			seq: u32,
			merkle_root: Hash32,
			totals: BoundedVec<u8, MaxTotalsLen>,
			is_final: bool,
		) -> DispatchResult {
			let attester = Self::ensure_attester(origin)?;
			let mut decision = Decisions::<T>::get(decision_id).ok_or(Error::<T>::UnknownDecision)?;
			ensure!(decision.registered_by == attester, Error::<T>::NotRegistrar);
			ensure!(!decision.closed, Error::<T>::DecisionClosed);

			let expected = match LatestSnapshot::<T>::get(decision_id) {
				Some(last) => last.checked_add(1).ok_or(Error::<T>::Overflow)?,
				None => 0,
			};
			ensure!(seq == expected, Error::<T>::SnapshotOutOfOrder);

			if is_final {
				let rules = DecisionRulesOf::<T>::get(decision_id).ok_or(Error::<T>::NoRules)?;
				if let Some(ends_at) = rules.ends_at {
					ensure!(Self::now() >= ends_at, Error::<T>::VotingNotEnded);
				}
			}

			let vote_count = VoteCount::<T>::get(decision_id);
			let sum = parse_totals(&totals).ok_or(Error::<T>::BadTotals)?;
			ensure!(sum == vote_count as u64, Error::<T>::TotalsNotVoteCount);

			let totals_hash = blake2_256(&totals);
			let vote_log = VoteLog::<T>::get(decision_id);
			Snapshots::<T>::insert(
				decision_id,
				seq,
				SnapshotInfo {
					merkle_root,
					totals_hash,
					is_final,
					published_at: frame_system::Pallet::<T>::block_number(),
				},
			);
			SnapshotProofs::<T>::insert(
				decision_id,
				seq,
				SnapshotProof { vote_count, vote_log, merkle_version: MERKLE_VERSION },
			);
			SnapshotTotals::<T>::insert(decision_id, seq, totals);
			LatestSnapshot::<T>::insert(decision_id, seq);
			if is_final {
				decision.closed = true;
				Decisions::<T>::insert(decision_id, decision);
				FinalSnapshot::<T>::insert(decision_id, seq);
			}
			Self::deposit_event(Event::SnapshotPublished {
				decision_id,
				seq,
				merkle_root,
				totals_hash,
				is_final,
			});
			Self::deposit_event(Event::SnapshotChecked {
				decision_id,
				seq,
				vote_count,
				vote_log,
				merkle_version: MERKLE_VERSION,
			});
			Self::deposit_event(Event::TotalsPublished { decision_id, seq });
			Ok(())
		}

		/// Publishes the clear content of a decision registered before runtime 204. Rejected
		/// unless its blake2-256 equals the decision's `content_hash`.
		#[pallet::call_index(6)]
		#[pallet::weight(T::WeightInfo::publish_content(content.len() as u32))]
		pub fn publish_content(
			origin: OriginFor<T>,
			decision_id: DecisionId,
			content: BoundedVec<u8, MaxContentLen>,
		) -> DispatchResult {
			let attester = Self::ensure_attester(origin)?;
			let decision = Decisions::<T>::get(decision_id).ok_or(Error::<T>::UnknownDecision)?;
			ensure!(decision.registered_by == attester, Error::<T>::NotRegistrar);
			ensure!(!DecisionContent::<T>::contains_key(decision_id), Error::<T>::AlreadyPublished);
			ensure!(blake2_256(&content) == decision.content_hash, Error::<T>::ContentMismatch);
			DecisionContent::<T>::insert(decision_id, content);
			Self::deposit_event(Event::ContentPublished { decision_id });
			Ok(())
		}

		/// Publishes the clear totals of a snapshot published before runtime 204. Rejected
		/// unless their blake2-256 equals the snapshot's `totals_hash`.
		#[pallet::call_index(7)]
		#[pallet::weight(T::WeightInfo::publish_totals(totals.len() as u32))]
		pub fn publish_totals(
			origin: OriginFor<T>,
			decision_id: DecisionId,
			seq: u32,
			totals: BoundedVec<u8, MaxTotalsLen>,
		) -> DispatchResult {
			let attester = Self::ensure_attester(origin)?;
			let decision = Decisions::<T>::get(decision_id).ok_or(Error::<T>::UnknownDecision)?;
			ensure!(decision.registered_by == attester, Error::<T>::NotRegistrar);
			let snapshot = Snapshots::<T>::get(decision_id, seq).ok_or(Error::<T>::UnknownSnapshot)?;
			ensure!(!SnapshotTotals::<T>::contains_key(decision_id, seq), Error::<T>::AlreadyPublished);
			ensure!(blake2_256(&totals) == snapshot.totals_hash, Error::<T>::TotalsMismatch);
			SnapshotTotals::<T>::insert(decision_id, seq, totals);
			Self::deposit_event(Event::TotalsPublished { decision_id, seq });
			Ok(())
		}

		/// Raises the declared number of eligible voters of an open decision (registrar only).
		/// Public: every change is an event.
		#[pallet::call_index(8)]
		#[pallet::weight(T::WeightInfo::raise_max_voters())]
		pub fn raise_max_voters(origin: OriginFor<T>, decision_id: DecisionId, max_voters: u32) -> DispatchResult {
			let attester = Self::ensure_attester(origin)?;
			let decision = Decisions::<T>::get(decision_id).ok_or(Error::<T>::UnknownDecision)?;
			ensure!(decision.registered_by == attester, Error::<T>::NotRegistrar);
			ensure!(!decision.closed, Error::<T>::DecisionClosed);
			let mut rules = DecisionRulesOf::<T>::get(decision_id).ok_or(Error::<T>::NoRules)?;
			ensure!(max_voters >= rules.max_voters, Error::<T>::CapLowered);
			ensure!(max_voters <= Electorate::<T>::get(&attester), Error::<T>::AboveElectorate);
			if let Some(ends_at) = rules.ends_at {
				ensure!(Self::now() < ends_at, Error::<T>::VotingEnded);
			}
			rules.max_voters = max_voters;
			let ends_at = rules.ends_at;
			DecisionRulesOf::<T>::insert(decision_id, rules);
			Self::deposit_event(Event::DecisionRulesSet { decision_id, ends_at, max_voters });
			Ok(())
		}

		/// Publishes the electorate of an app (identity attester only).
		#[pallet::call_index(9)]
		#[pallet::weight(T::WeightInfo::set_electorate())]
		pub fn set_electorate(origin: OriginFor<T>, app: T::AccountId, voters: u32) -> DispatchResult {
			T::ElectorateOrigin::ensure_origin(origin)?;
			Electorate::<T>::insert(&app, voters);
			Self::deposit_event(Event::ElectorateSet { app, voters });
			Ok(())
		}

		/// Gives a decision registered before runtime 204 its end time and voter cap, under the
		/// same constraints as a new decision. Until then it takes no vote and cannot close.
		#[pallet::call_index(10)]
		#[pallet::weight(T::WeightInfo::set_rules())]
		pub fn set_rules(origin: OriginFor<T>, decision_id: DecisionId, ends_at: u64, max_voters: u32) -> DispatchResult {
			let attester = Self::ensure_attester(origin)?;
			let decision = Decisions::<T>::get(decision_id).ok_or(Error::<T>::UnknownDecision)?;
			ensure!(decision.registered_by == attester, Error::<T>::NotRegistrar);
			ensure!(!decision.closed, Error::<T>::DecisionClosed);
			ensure!(!DecisionRulesOf::<T>::contains_key(decision_id), Error::<T>::RulesExist);
			Self::check_rules(&attester, ends_at, max_voters)?;
			ensure!(VoteCount::<T>::get(decision_id) <= max_voters, Error::<T>::TooManyVotes);
			DecisionRulesOf::<T>::insert(decision_id, DecisionRules { ends_at: Some(ends_at), max_voters });
			Self::deposit_event(Event::DecisionRulesSet { decision_id, ends_at: Some(ends_at), max_voters });
			Ok(())
		}

		/// Opens votes of a closed decision: each option and salt must match the commitment
		/// recorded at voting time. When every vote is revealed, the chain compares its own count
		/// with the final totals (`RecountOf`).
		#[pallet::call_index(11)]
		#[pallet::weight(T::WeightInfo::reveal_votes(reveals.len() as u32))]
		pub fn reveal_votes(
			origin: OriginFor<T>,
			decision_id: DecisionId,
			reveals: alloc::vec::Vec<Reveal<T::AccountId>>,
		) -> DispatchResult {
			let attester = Self::ensure_attester(origin)?;
			ensure!(reveals.len() as u32 <= T::MaxRevealsPerCall::get(), Error::<T>::TooManyReveals);
			let decision = Decisions::<T>::get(decision_id).ok_or(Error::<T>::UnknownDecision)?;
			ensure!(decision.registered_by == attester, Error::<T>::NotRegistrar);
			ensure!(decision.closed, Error::<T>::NotClosed);
			for r in &reveals {
				let vote = Votes::<T>::get(decision_id, &r.voter).ok_or(Error::<T>::UnknownVote)?;
				ensure!(!Revealed::<T>::contains_key(decision_id, &r.voter), Error::<T>::AlreadyRevealed);
				ensure!(commitment_of(&decision_id, &r.option, &r.salt) == vote.commitment, Error::<T>::RevealMismatch);
				Revealed::<T>::insert(decision_id, &r.voter, ());
				RevealedTally::<T>::mutate(decision_id, &r.option, |n| *n = n.saturating_add(1));
			}
			let revealed = RevealedCount::<T>::get(decision_id).saturating_add(reveals.len() as u32);
			RevealedCount::<T>::insert(decision_id, revealed);
			Self::deposit_event(Event::VotesRevealed { decision_id, count: reveals.len() as u32 });
			let votes = VoteCount::<T>::get(decision_id);
			if revealed == votes {
				let matches = FinalSnapshot::<T>::get(decision_id)
					.and_then(|seq| SnapshotTotals::<T>::get(decision_id, seq))
					.and_then(|t| {
						parse_tally(&t).map(|pairs| {
							pairs.iter().all(|(option, n)| {
								BoundedVec::<u8, MaxOptionLen>::try_from(option.to_vec())
									.map(|o| RevealedTally::<T>::get(decision_id, &o) as u64 == *n)
									.unwrap_or(false)
							}) && pairs.iter().map(|(_, n)| *n).sum::<u64>() == votes as u64
						})
					})
					.unwrap_or(false);
				RecountOf::<T>::insert(decision_id, Recount { matches, votes });
				Self::deposit_event(Event::ResultRecounted { decision_id, votes, matches });
			}
			Ok(())
		}

		/// Adds or updates a category of the common list (admin origin). A position names its
		/// domain. A category with trusts recorded keeps its kind, so that its counts stay right.
		#[pallet::call_index(12)]
		#[pallet::weight(Weight::from_parts(20_000_000, 1_000).saturating_add(T::DbWeight::get().reads_writes(3, 1)))]
		pub fn set_category(
			origin: OriginFor<T>,
			id: u32,
			kind: CategoryKind,
			domain: Option<u32>,
			key: BoundedVec<u8, MaxCategoryKeyLen>,
		) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			match (kind, domain) {
				(CategoryKind::Domain, None) => {},
				(CategoryKind::Position, Some(d)) => ensure!(
					Categories::<T>::get(d).is_some_and(|c| c.kind == CategoryKind::Domain),
					Error::<T>::BadDomain
				),
				_ => return Err(Error::<T>::BadDomain.into()),
			}
			let was = Categories::<T>::get(id).map_or(CategoryKind::Domain, |c| c.kind);
			ensure!(was == kind || CategoryUse::<T>::get(id) == 0, Error::<T>::CategoryInUse);
			Categories::<T>::insert(id, CategoryInfo { kind, domain, key });
			Self::deposit_event(Event::CategorySet { id, kind, domain });
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		pub(crate) fn now() -> u64 {
			T::Time::now().as_millis().min(u64::MAX as u128) as u64
		}

		fn check_rules(attester: &T::AccountId, ends_at: u64, max_voters: u32) -> DispatchResult {
			ensure!(ends_at >= Self::now().saturating_add(T::MinVotingPeriod::get()), Error::<T>::VotingTooShort);
			ensure!(max_voters <= Electorate::<T>::get(attester), Error::<T>::AboveElectorate);
			Ok(())
		}

		fn ensure_attester(origin: OriginFor<T>) -> Result<T::AccountId, DispatchError> {
			let who = ensure_signed(origin)?;
			ensure!(Attesters::<T>::contains_key(&who), Error::<T>::NotAttester);
			Ok(who)
		}

		/// Whether trust in `category` is counted per app (a registered position).
		pub fn is_position(category: u32) -> bool {
			Categories::<T>::get(category).is_some_and(|c| c.kind == CategoryKind::Position)
		}

		/// Counts a trust edge given (`app`: the attester recording it) or revoked (`None`) in
		/// the per-category counters. A revoked edge leaves the count it was added to.
		pub(crate) fn count_trust(key: &(T::AccountId, T::AccountId, u32), app: Option<&T::AccountId>) {
			let (truster, trusted, category) = key;
			let category = *category;
			match app {
				Some(app) => {
					CategoryUse::<T>::mutate(category, |n| *n = n.saturating_add(1));
					if Self::is_position(category) {
						TrustEdgeApp::<T>::insert(key, app);
						TrustReceivedFor::<T>::mutate((trusted, app, category), |n| *n = n.saturating_add(1));
					} else {
						TrustReceivedIn::<T>::mutate(trusted, category, |n| *n = n.saturating_add(1));
					}
				},
				None => {
					CategoryUse::<T>::mutate_exists(category, |n| Self::decrement(n));
					match TrustEdgeApp::<T>::take((truster, trusted, category)) {
						Some(app) => TrustReceivedFor::<T>::mutate_exists((trusted, &app, category), |n| Self::decrement(n)),
						None => TrustReceivedIn::<T>::mutate_exists(trusted, category, |n| Self::decrement(n)),
					}
				},
			}
		}

		/// Lowers a counter by one, removing it at zero.
		fn decrement(n: &mut Option<u32>) {
			*n = n.map(|v| v.saturating_sub(1)).filter(|v| *v > 0);
		}

		/// Bytes the voter key signs for `record_vote`.
		pub fn vote_payload(
			decision_id: &DecisionId,
			voter: &T::AccountId,
			commitment: &Hash32,
			kind: VoteKind,
		) -> Vec<u8> {
			(VOTE_CONTEXT, T::ChainTag::get(), decision_id, voter, commitment, kind).encode()
		}

		/// Bytes the truster key signs for `record_trust`.
		pub fn trust_payload(
			truster: &T::AccountId,
			trusted: &T::AccountId,
			category: u32,
			action: TrustAction,
			nonce: u32,
		) -> Vec<u8> {
			(TRUST_CONTEXT, T::ChainTag::get(), truster, trusted, category, action, nonce).encode()
		}

		/// Next value of a decision's vote log.
		pub fn next_vote_log(log: &Hash32, voter: &T::AccountId, commitment: &Hash32, kind: VoteKind) -> Hash32 {
			let mut buf = Vec::with_capacity(VOTE_LOG_CONTEXT.len() + 32 + 32 + 32 + 1);
			buf.extend_from_slice(VOTE_LOG_CONTEXT);
			buf.extend_from_slice(log);
			buf.extend_from_slice(voter.encode().as_slice());
			buf.extend_from_slice(commitment);
			buf.extend_from_slice(&kind.encode());
			blake2_256(&buf)
		}
	}
}
