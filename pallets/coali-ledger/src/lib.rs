//! # Coali ledger
//!
//! Proof ledger for the Coali board protocol (`docs/protocol/coali-trust-protocol.md`
//! in the Popolitica repository). Tallies are computed off-chain; this pallet records
//! what is needed to verify them:
//!
//! - decisions (an id and the hash of the question and options),
//! - one vote commitment per voter address and decision, signed by the voter,
//! - trust given or revoked between trust addresses, signed by the truster,
//! - successive Merkle snapshots of each decision tally; the final one closes it.
//!
//! Only accounts registered as attesters can submit extrinsics. An attester vouches
//! that the voter is eligible; the voter signature proves the voter key holder agreed.
//! No personal data is stored: ids are opaque, votes are commitments.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub mod weights;
pub use weights::WeightInfo;

/// Opaque decision id (the Popolitica decision UUID bytes).
pub type DecisionId = [u8; 16];
/// 32-byte hash (blake2-256 unless stated otherwise).
pub type Hash32 = [u8; 32];

pub const VOTE_CONTEXT: &[u8] = b"coali/vote/v1";
pub const TRUST_CONTEXT: &[u8] = b"coali/trust/v1";

/// Trust an account receives, read by the proof-of-trust validator selection.
pub trait TrustScore<AccountId> {
	/// Number of distinct accounts trusting `who`, in any category.
	fn trust_received(who: &AccountId) -> u32;
}

impl<T: Config> TrustScore<T::AccountId> for Pallet<T> {
	fn trust_received(who: &T::AccountId) -> u32 {
		TrustReceived::<T>::get(who)
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

#[frame_support::pallet]
pub mod pallet {
	use super::*;
	use alloc::vec::Vec;
	use frame_support::pallet_prelude::*;
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

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// Origin allowed to add and remove attesters.
		type AdminOrigin: EnsureOrigin<Self::RuntimeOrigin>;
		/// Signature scheme of voter and truster keys.
		type Signature: Verify<Signer = Self::Signer> + Parameter;
		type Signer: IdentifyAccount<AccountId = Self::AccountId>;
		/// Domain separator included in every signed payload, unique per network.
		#[pallet::constant]
		type ChainTag: Get<[u8; 8]>;
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

	#[pallet::storage]
	pub type LatestSnapshot<T: Config> = StorageMap<_, Blake2_128Concat, DecisionId, u32, OptionQuery>;

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
		}
	}

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		AttesterAdded { who: T::AccountId },
		AttesterRemoved { who: T::AccountId },
		DecisionRegistered { decision_id: DecisionId, content_hash: Hash32, category: u32 },
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

		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::remove_attester())]
		pub fn remove_attester(origin: OriginFor<T>, who: T::AccountId) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			ensure!(Attesters::<T>::contains_key(&who), Error::<T>::UnknownAttester);
			Attesters::<T>::remove(&who);
			Self::deposit_event(Event::AttesterRemoved { who });
			Ok(())
		}

		#[pallet::call_index(2)]
		#[pallet::weight(T::WeightInfo::register_decision())]
		pub fn register_decision(
			origin: OriginFor<T>,
			decision_id: DecisionId,
			content_hash: Hash32,
			category: u32,
		) -> DispatchResult {
			let attester = Self::ensure_attester(origin)?;
			ensure!(!Decisions::<T>::contains_key(decision_id), Error::<T>::DecisionExists);
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
			Self::deposit_event(Event::DecisionRegistered { decision_id, content_hash, category });
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
			Self::ensure_attester(origin)?;
			let decision = Decisions::<T>::get(decision_id).ok_or(Error::<T>::UnknownDecision)?;
			ensure!(!decision.closed, Error::<T>::DecisionClosed);
			ensure!(!Votes::<T>::contains_key(decision_id, &voter), Error::<T>::AlreadyVoted);

			let payload = Self::vote_payload(&decision_id, &voter, &commitment, kind);
			ensure!(voter_signature.verify(&payload[..], &voter), Error::<T>::BadVoterSignature);

			let count = VoteCount::<T>::get(decision_id).checked_add(1).ok_or(Error::<T>::Overflow)?;
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
		#[pallet::weight(T::WeightInfo::record_trust())]
		pub fn record_trust(
			origin: OriginFor<T>,
			truster: T::AccountId,
			trusted: T::AccountId,
			category: u32,
			action: TrustAction,
			nonce: u32,
			truster_signature: T::Signature,
		) -> DispatchResult {
			Self::ensure_attester(origin)?;
			ensure!(truster != trusted, Error::<T>::SelfTrust);
			ensure!(TrustNonces::<T>::get(&truster) == nonce, Error::<T>::BadTrustNonce);

			let payload = Self::trust_payload(&truster, &trusted, category, action, nonce);
			ensure!(truster_signature.verify(&payload[..], &truster), Error::<T>::BadTrusterSignature);

			let key = (truster.clone(), trusted.clone(), category);
			match action {
				TrustAction::Give => {
					ensure!(!TrustEdges::<T>::contains_key(&key), Error::<T>::AlreadyTrusted);
					TrustEdges::<T>::insert(&key, frame_system::Pallet::<T>::block_number());
					let categories = TrustPairs::<T>::get(&trusted, &truster);
					if categories == 0 {
						TrustReceived::<T>::mutate(&trusted, |n| *n = n.saturating_add(1));
					}
					TrustPairs::<T>::insert(&trusted, &truster, categories.saturating_add(1));
				},
				TrustAction::Revoke => {
					ensure!(TrustEdges::<T>::contains_key(&key), Error::<T>::TrustNotFound);
					TrustEdges::<T>::remove(&key);
					let categories = TrustPairs::<T>::get(&trusted, &truster).saturating_sub(1);
					if categories == 0 {
						TrustPairs::<T>::remove(&trusted, &truster);
						TrustReceived::<T>::mutate(&trusted, |n| *n = n.saturating_sub(1));
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

		#[pallet::call_index(5)]
		#[pallet::weight(T::WeightInfo::publish_snapshot())]
		pub fn publish_snapshot(
			origin: OriginFor<T>,
			decision_id: DecisionId,
			seq: u32,
			merkle_root: Hash32,
			totals_hash: Hash32,
			is_final: bool,
		) -> DispatchResult {
			Self::ensure_attester(origin)?;
			let mut decision = Decisions::<T>::get(decision_id).ok_or(Error::<T>::UnknownDecision)?;
			ensure!(!decision.closed, Error::<T>::DecisionClosed);

			let expected = match LatestSnapshot::<T>::get(decision_id) {
				Some(last) => last.checked_add(1).ok_or(Error::<T>::Overflow)?,
				None => 0,
			};
			ensure!(seq == expected, Error::<T>::SnapshotOutOfOrder);

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
			LatestSnapshot::<T>::insert(decision_id, seq);
			if is_final {
				decision.closed = true;
				Decisions::<T>::insert(decision_id, decision);
			}
			Self::deposit_event(Event::SnapshotPublished {
				decision_id,
				seq,
				merkle_root,
				totals_hash,
				is_final,
			});
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		fn ensure_attester(origin: OriginFor<T>) -> Result<T::AccountId, DispatchError> {
			let who = ensure_signed(origin)?;
			ensure!(Attesters::<T>::contains_key(&who), Error::<T>::NotAttester);
			Ok(who)
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
	}
}
