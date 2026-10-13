//! # Proof of trust
//!
//! Chooses the block producers (Aura) and finality voters (GRANDPA) at every session,
//! through `pallet_session::SessionManager`. No stake is involved:
//!
//! - **Founders** (set at genesis, managed by the admin origin) validate without trust
//!   requirements; they bootstrap the network.
//! - **Candidates** are people: an attester (the Coali server) vouches that a trust
//!   address belongs to an identity-verified user, then links it to one validator
//!   account. One validator per person.
//! - A candidate validates while its trust address is trusted by at least `MinTrust`
//!   distinct accounts on chain (public trusts recorded by `pallet-coali-ledger`).
//! - Liveness: a selected validator (founder or candidate) that authored no block for
//!   `OfflineAfter` blocks is set aside until its account calls `go_online`, so dead nodes
//!   cannot keep GRANDPA below its 2/3 threshold. If every validator is offline, the
//!   founders are kept.
//!
//! Validators still need session keys (`session.set_keys`); without keys,
//! `pallet_session` leaves them out.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

#[frame_support::pallet]
pub mod pallet {
	use alloc::vec::Vec;
	use frame_support::pallet_prelude::*;
	use frame_system::pallet_prelude::*;
	use pallet_coali_ledger::TrustScore;
	use sp_runtime::traits::Saturating;
	use sp_staking::SessionIndex;

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// Sets the trust threshold and manages founders.
		type AdminOrigin: EnsureOrigin<Self::RuntimeOrigin>;
		/// Vouches for identities and registers candidates.
		type AttesterOrigin: EnsureOrigin<Self::RuntimeOrigin, Success = Self::AccountId>;
		/// On-chain trust received by a trust address.
		type TrustScore: TrustScore<Self::AccountId>;
		/// Maximum validators in a session (must not exceed Aura and GRANDPA limits).
		#[pallet::constant]
		type MaxValidators: Get<u32>;
		/// Maximum registered candidates.
		#[pallet::constant]
		type MaxCandidates: Get<u32>;
		/// Blocks without authoring after which a selected candidate is set offline.
		#[pallet::constant]
		type OfflineAfter: Get<BlockNumberFor<Self>>;
	}

	/// Minimum number of distinct trusters required to validate.
	#[pallet::storage]
	pub type MinTrust<T: Config> = StorageValue<_, u32, ValueQuery>;

	#[pallet::storage]
	pub type Founders<T: Config> =
		StorageValue<_, BoundedVec<T::AccountId, T::MaxValidators>, ValueQuery>;

	/// Trust addresses whose owner passed identity verification.
	#[pallet::storage]
	pub type Verified<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, (), OptionQuery>;

	/// Validator account -> trust address of the person running it.
	#[pallet::storage]
	pub type Candidates<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, T::AccountId, OptionQuery>;

	/// Trust address -> its validator account (one validator per person).
	#[pallet::storage]
	pub type ValidatorOf<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, T::AccountId, OptionQuery>;

	#[pallet::storage]
	pub type CandidateCount<T: Config> = StorageValue<_, u32, ValueQuery>;

	#[pallet::storage]
	pub type Offline<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, (), OptionQuery>;

	/// Block at which a candidate was last selected after being out of the set.
	#[pallet::storage]
	pub type SelectedSince<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, BlockNumberFor<T>, OptionQuery>;

	#[pallet::storage]
	pub type LastAuthored<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, BlockNumberFor<T>, OptionQuery>;

	#[pallet::genesis_config]
	#[derive(frame_support::DefaultNoBound)]
	pub struct GenesisConfig<T: Config> {
		pub founders: Vec<T::AccountId>,
		pub min_trust: u32,
	}

	#[pallet::genesis_build]
	impl<T: Config> BuildGenesisConfig for GenesisConfig<T> {
		fn build(&self) {
			let founders: BoundedVec<_, _> =
				self.founders.clone().try_into().expect("too many founders");
			Founders::<T>::put(founders);
			MinTrust::<T>::put(self.min_trust);
		}
	}

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		MinTrustSet { min_trust: u32 },
		FounderAdded { who: T::AccountId },
		FounderRemoved { who: T::AccountId },
		IdentityAttested { trust_address: T::AccountId, verified: bool },
		CandidateRegistered { validator: T::AccountId, trust_address: T::AccountId },
		CandidateRemoved { validator: T::AccountId },
		CandidateOffline { validator: T::AccountId },
		CandidateOnline { validator: T::AccountId },
		ValidatorsPlanned { session: SessionIndex, founders: u32, candidates: u32 },
	}

	#[pallet::error]
	pub enum Error<T> {
		NotVerified,
		AlreadyFounder,
		NotFounder,
		TooManyFounders,
		AlreadyCandidate,
		PersonHasValidator,
		NotCandidate,
		TooManyCandidates,
		NotOffline,
	}

	const BASE: u64 = 20_000_000;

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		#[pallet::call_index(0)]
		#[pallet::weight(Weight::from_parts(BASE, 1_000).saturating_add(T::DbWeight::get().writes(1)))]
		pub fn set_min_trust(origin: OriginFor<T>, min_trust: u32) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			MinTrust::<T>::put(min_trust);
			Self::deposit_event(Event::MinTrustSet { min_trust });
			Ok(())
		}

		#[pallet::call_index(1)]
		#[pallet::weight(Weight::from_parts(BASE, 4_000).saturating_add(T::DbWeight::get().reads_writes(2, 1)))]
		pub fn add_founder(origin: OriginFor<T>, who: T::AccountId) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			ensure!(!Candidates::<T>::contains_key(&who), Error::<T>::AlreadyCandidate);
			Founders::<T>::try_mutate(|f| {
				ensure!(!f.contains(&who), Error::<T>::AlreadyFounder);
				f.try_push(who.clone()).map_err(|_| Error::<T>::TooManyFounders)
			})?;
			Self::deposit_event(Event::FounderAdded { who });
			Ok(())
		}

		#[pallet::call_index(2)]
		#[pallet::weight(Weight::from_parts(BASE, 4_000).saturating_add(T::DbWeight::get().reads_writes(1, 1)))]
		pub fn remove_founder(origin: OriginFor<T>, who: T::AccountId) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			Founders::<T>::try_mutate(|f| {
				let pos = f.iter().position(|x| x == &who).ok_or(Error::<T>::NotFounder)?;
				f.remove(pos);
				Ok::<_, Error<T>>(())
			})?;
			Offline::<T>::remove(&who);
			SelectedSince::<T>::remove(&who);
			LastAuthored::<T>::remove(&who);
			Self::deposit_event(Event::FounderRemoved { who });
			Ok(())
		}

		/// Vouch (or stop vouching) that `trust_address` belongs to a verified person.
		/// Withdrawing verification also removes that person's candidate.
		#[pallet::call_index(3)]
		#[pallet::weight(Weight::from_parts(BASE, 2_000).saturating_add(T::DbWeight::get().reads_writes(2, 4)))]
		pub fn attest_identity(
			origin: OriginFor<T>,
			trust_address: T::AccountId,
			verified: bool,
		) -> DispatchResult {
			T::AttesterOrigin::ensure_origin(origin)?;
			if verified {
				Verified::<T>::insert(&trust_address, ());
			} else {
				Verified::<T>::remove(&trust_address);
				if let Some(validator) = ValidatorOf::<T>::get(&trust_address) {
					Self::drop_candidate(&validator);
				}
			}
			Self::deposit_event(Event::IdentityAttested { trust_address, verified });
			Ok(())
		}

		#[pallet::call_index(4)]
		#[pallet::weight(Weight::from_parts(BASE, 4_000).saturating_add(T::DbWeight::get().reads_writes(5, 3)))]
		pub fn register_candidate(
			origin: OriginFor<T>,
			trust_address: T::AccountId,
			validator: T::AccountId,
		) -> DispatchResult {
			T::AttesterOrigin::ensure_origin(origin)?;
			ensure!(Verified::<T>::contains_key(&trust_address), Error::<T>::NotVerified);
			ensure!(!ValidatorOf::<T>::contains_key(&trust_address), Error::<T>::PersonHasValidator);
			ensure!(!Candidates::<T>::contains_key(&validator), Error::<T>::AlreadyCandidate);
			ensure!(!Founders::<T>::get().contains(&validator), Error::<T>::AlreadyFounder);
			let count = CandidateCount::<T>::get();
			ensure!(count < T::MaxCandidates::get(), Error::<T>::TooManyCandidates);

			Candidates::<T>::insert(&validator, &trust_address);
			ValidatorOf::<T>::insert(&trust_address, &validator);
			CandidateCount::<T>::put(count + 1);
			Self::deposit_event(Event::CandidateRegistered { validator, trust_address });
			Ok(())
		}

		#[pallet::call_index(5)]
		#[pallet::weight(Weight::from_parts(BASE, 4_000).saturating_add(T::DbWeight::get().reads_writes(1, 6)))]
		pub fn remove_candidate(origin: OriginFor<T>, validator: T::AccountId) -> DispatchResult {
			T::AttesterOrigin::ensure_origin(origin)?;
			ensure!(Candidates::<T>::contains_key(&validator), Error::<T>::NotCandidate);
			Self::drop_candidate(&validator);
			Ok(())
		}

		/// A candidate leaves by itself.
		#[pallet::call_index(6)]
		#[pallet::weight(Weight::from_parts(BASE, 4_000).saturating_add(T::DbWeight::get().reads_writes(1, 6)))]
		pub fn withdraw(origin: OriginFor<T>) -> DispatchResult {
			let validator = ensure_signed(origin)?;
			ensure!(Candidates::<T>::contains_key(&validator), Error::<T>::NotCandidate);
			Self::drop_candidate(&validator);
			Ok(())
		}

		/// A validator (candidate or founder) set offline asks to be selected again.
		#[pallet::call_index(7)]
		#[pallet::weight(Weight::from_parts(BASE, 2_000).saturating_add(T::DbWeight::get().reads_writes(2, 1)))]
		pub fn go_online(origin: OriginFor<T>) -> DispatchResult {
			let validator = ensure_signed(origin)?;
			ensure!(Self::is_validator(&validator), Error::<T>::NotCandidate);
			ensure!(Offline::<T>::take(&validator).is_some(), Error::<T>::NotOffline);
			Self::deposit_event(Event::CandidateOnline { validator });
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		fn drop_candidate(validator: &T::AccountId) {
			if let Some(trust_address) = Candidates::<T>::take(validator) {
				ValidatorOf::<T>::remove(&trust_address);
				CandidateCount::<T>::mutate(|c| *c = c.saturating_sub(1));
			}
			Offline::<T>::remove(validator);
			SelectedSince::<T>::remove(validator);
			LastAuthored::<T>::remove(validator);
			Self::deposit_event(Event::CandidateRemoved { validator: validator.clone() });
		}

		/// Whether a candidate currently meets identity and trust requirements.
		pub fn is_eligible(validator: &T::AccountId) -> bool {
			Candidates::<T>::get(validator).is_some_and(|trust_address| {
				Verified::<T>::contains_key(&trust_address) &&
					T::TrustScore::trust_received(&trust_address) >= MinTrust::<T>::get()
			}) && !Offline::<T>::contains_key(validator)
		}

		/// Liveness check for a validator that would be selected now. Returns false (and sets
		/// it offline) when it authored nothing for `OfflineAfter` blocks while selected.
		fn still_alive(validator: &T::AccountId, now: BlockNumberFor<T>) -> bool {
			if Offline::<T>::contains_key(validator) {
				return false;
			}
			match SelectedSince::<T>::get(validator) {
				Some(since) => {
					let last = LastAuthored::<T>::get(validator).map_or(since, |s| s.max(since));
					if now.saturating_sub(last) > T::OfflineAfter::get() {
						Offline::<T>::insert(validator, ());
						SelectedSince::<T>::remove(validator);
						Self::deposit_event(Event::CandidateOffline { validator: validator.clone() });
						return false;
					}
				},
				None => SelectedSince::<T>::insert(validator, now),
			}
			true
		}

		/// Live founders, then eligible live candidates by decreasing trust, capped at
		/// MaxValidators. Offline validators are left out so that they cannot stall GRANDPA
		/// finality; if nobody is left, all founders are kept.
		pub fn select(session: SessionIndex) -> Vec<T::AccountId> {
			let now = frame_system::Pallet::<T>::block_number();
			let all_founders = Founders::<T>::get().into_inner();
			let founders: Vec<T::AccountId> =
				all_founders.iter().filter(|f| Self::still_alive(f, now)).cloned().collect();
			let mut picked: Vec<(u32, T::AccountId)> = Vec::new();

			for (validator, trust_address) in Candidates::<T>::iter() {
				if !Self::is_eligible(&validator) {
					SelectedSince::<T>::remove(&validator);
					continue;
				}
				if !Self::still_alive(&validator, now) {
					continue;
				}
				picked.push((T::TrustScore::trust_received(&trust_address), validator));
			}

			picked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
			let room = (T::MaxValidators::get() as usize).saturating_sub(founders.len());
			let candidates = picked.len().min(room);

			if founders.is_empty() && candidates == 0 {
				for f in &all_founders {
					Offline::<T>::remove(f);
					SelectedSince::<T>::insert(f, now);
				}
				Self::deposit_event(Event::ValidatorsPlanned {
					session,
					founders: all_founders.len() as u32,
					candidates: 0,
				});
				return all_founders;
			}

			Self::deposit_event(Event::ValidatorsPlanned {
				session,
				founders: founders.len() as u32,
				candidates: candidates as u32,
			});
			founders.into_iter().chain(picked.into_iter().take(room).map(|(_, v)| v)).collect()
		}

		fn is_validator(who: &T::AccountId) -> bool {
			Candidates::<T>::contains_key(who) || Founders::<T>::get().contains(who)
		}
	}

	impl<T: Config> pallet_session::SessionManager<T::AccountId> for Pallet<T> {
		fn new_session(new_index: SessionIndex) -> Option<Vec<T::AccountId>> {
			let set = Self::select(new_index);
			if set.is_empty() {
				None
			} else {
				Some(set)
			}
		}
		fn end_session(_: SessionIndex) {}
		fn start_session(_: SessionIndex) {}
	}

	impl<T: Config> pallet_authorship::EventHandler<T::AccountId, BlockNumberFor<T>> for Pallet<T> {
		fn note_author(author: T::AccountId) {
			if Self::is_validator(&author) {
				LastAuthored::<T>::insert(&author, frame_system::Pallet::<T>::block_number());
			}
		}
	}
}
