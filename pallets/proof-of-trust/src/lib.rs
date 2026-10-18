//! # Proof of trust
//!
//! Chooses the block producers (Aura) and finality voters (GRANDPA) at every session,
//! through `pallet_session::SessionManager`. No stake is involved:
//!
//! - **Founders** (set at genesis, managed by the admin origin) validate without trust
//!   requirements; they bootstrap the network. While the network is young they keep more than
//!   two thirds of the seats (`FounderShare`, 67% by default; lowered by the admin as the network
//!   grows), so that candidates, even all vouched for by a stolen identity key, can neither
//!   finalize, rewrite nor stall finality.
//! - **Identity attesters** (managed by the admin origin, kept apart from the ledger's
//!   relayer key) vouch that an address belongs to an identity-verified person.
//! - **Candidates** are people: a verified trust address linked to one validator account.
//!   One validator per person.
//! - A candidate validates while its trust address is trusted by at least `MinTrust`
//!   distinct **verified** addresses (public trusts recorded by `pallet-coali-ledger`).
//!   Trust from addresses nobody vouched for does not count.
//! - At most `MaxNewPerSession` candidates enter the set per session; the most trusted first.
//! - Liveness: a selected validator (founder or candidate) that authored no block for
//!   `OfflineAfter` blocks is set aside and gets a strike. It can ask to come back with
//!   `go_online` after a cooldown that doubles with each strike; a candidate reaching
//!   `MaxStrikes` is removed. Strikes are forgiven after `StrikeForgiveness` blocks without a
//!   new one. If every validator is offline, the founders are kept.
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

pub mod migrations;

/// Origin check: a signed origin from an identity attester (e.g. to publish an app's electorate
/// in the ledger).
pub struct EnsureIdentityAttester<T>(core::marker::PhantomData<T>);

impl<T: Config> frame_support::traits::EnsureOrigin<T::RuntimeOrigin> for EnsureIdentityAttester<T> {
	type Success = T::AccountId;

	fn try_origin(o: T::RuntimeOrigin) -> Result<T::AccountId, T::RuntimeOrigin> {
		match frame_system::ensure_signed(o.clone()) {
			Ok(who) if IdentityAttesters::<T>::contains_key(&who) => Ok(who),
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
	use alloc::vec::Vec;
	use frame_support::pallet_prelude::*;
	use frame_system::pallet_prelude::*;
	use pallet_coali_ledger::TrustScore;
	use sp_runtime::{traits::Saturating, Percent};
	use sp_staking::SessionIndex;

	pub(crate) const STORAGE_VERSION: StorageVersion = StorageVersion::new(1);

	#[pallet::pallet]
	#[pallet::storage_version(STORAGE_VERSION)]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// Sets the trust threshold and selection limits, manages founders and identity attesters.
		type AdminOrigin: EnsureOrigin<Self::RuntimeOrigin>;
		/// Trust recorded on chain between addresses.
		type TrustScore: TrustScore<Self::AccountId>;
		/// Maximum validators in a session (must not exceed Aura and GRANDPA limits).
		#[pallet::constant]
		type MaxValidators: Get<u32>;
		/// Maximum registered candidates.
		#[pallet::constant]
		type MaxCandidates: Get<u32>;
		/// Blocks without authoring after which a selected validator is set offline.
		#[pallet::constant]
		type OfflineAfter: Get<BlockNumberFor<Self>>;
		/// Strikes after which a candidate is removed.
		#[pallet::constant]
		type MaxStrikes: Get<u32>;
		/// Blocks without a new strike after which strikes are forgiven.
		#[pallet::constant]
		type StrikeForgiveness: Get<BlockNumberFor<Self>>;
	}

	#[pallet::type_value]
	pub fn DefaultFounderShare() -> Percent {
		Percent::from_percent(67)
	}

	#[pallet::type_value]
	pub fn DefaultMaxNewPerSession() -> u32 {
		2
	}

	/// Minimum number of distinct verified trusters required to validate.
	#[pallet::storage]
	pub type MinTrust<T: Config> = StorageValue<_, u32, ValueQuery>;

	/// Minimum share of the seats kept by live founders (0 = no minimum).
	#[pallet::storage]
	pub type FounderShare<T: Config> = StorageValue<_, Percent, ValueQuery, DefaultFounderShare>;

	/// Maximum number of candidates entering the set at one session.
	#[pallet::storage]
	pub type MaxNewPerSession<T: Config> = StorageValue<_, u32, ValueQuery, DefaultMaxNewPerSession>;

	#[pallet::storage]
	pub type Founders<T: Config> =
		StorageValue<_, BoundedVec<T::AccountId, T::MaxValidators>, ValueQuery>;

	/// Accounts allowed to vouch for identities and register candidates.
	#[pallet::storage]
	pub type IdentityAttesters<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, (), OptionQuery>;

	/// Address of an identity-verified person -> the identity attester that vouched for it.
	#[pallet::storage]
	pub type Verified<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, T::AccountId, OptionQuery>;

	/// (identity attester, address) for every address it vouched for.
	#[pallet::storage]
	pub type VerifiedBy<T: Config> =
		StorageDoubleMap<_, Blake2_128Concat, T::AccountId, Blake2_128Concat, T::AccountId, (), OptionQuery>;

	/// Number of distinct verified addresses trusting an address (in any category).
	#[pallet::storage]
	pub type VerifiedTrust<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

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

	/// Block at which a validator was set offline.
	#[pallet::storage]
	pub type OfflineSince<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, BlockNumberFor<T>, OptionQuery>;

	/// Validator -> (strikes, block of the last strike).
	#[pallet::storage]
	pub type Strikes<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, (u32, BlockNumberFor<T>), OptionQuery>;

	/// Block at which a validator entered the set (present while it is in the set).
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
		pub identity_attesters: Vec<T::AccountId>,
	}

	#[pallet::genesis_build]
	impl<T: Config> BuildGenesisConfig for GenesisConfig<T> {
		fn build(&self) {
			let founders: BoundedVec<_, _> =
				self.founders.clone().try_into().expect("too many founders");
			Founders::<T>::put(founders);
			MinTrust::<T>::put(self.min_trust);
			for who in &self.identity_attesters {
				IdentityAttesters::<T>::insert(who, ());
			}
		}
	}

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		MinTrustSet { min_trust: u32 },
		SelectionLimitsSet { founder_share: Percent, max_new_per_session: u32 },
		FounderAdded { who: T::AccountId },
		FounderRemoved { who: T::AccountId },
		IdentityAttesterAdded { who: T::AccountId },
		IdentityAttesterRemoved { who: T::AccountId },
		IdentityAttested { trust_address: T::AccountId, verified: bool },
		CandidateRegistered { validator: T::AccountId, trust_address: T::AccountId },
		CandidateRemoved { validator: T::AccountId },
		CandidateOffline { validator: T::AccountId },
		CandidateOnline { validator: T::AccountId },
		ValidatorStruck { validator: T::AccountId, strikes: u32 },
		/// Reported for signing two conflicting votes (equivocation).
		ValidatorEquivocated { validator: T::AccountId },
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
		NotIdentityAttester,
		AlreadyIdentityAttester,
		/// The cooldown after going offline is not over.
		CooldownNotOver,
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
		#[pallet::weight(Weight::from_parts(BASE, 4_000).saturating_add(T::DbWeight::get().reads_writes(1, 5)))]
		pub fn remove_founder(origin: OriginFor<T>, who: T::AccountId) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			Founders::<T>::try_mutate(|f| {
				let pos = f.iter().position(|x| x == &who).ok_or(Error::<T>::NotFounder)?;
				f.remove(pos);
				Ok::<_, Error<T>>(())
			})?;
			Self::clear_liveness(&who);
			Self::deposit_event(Event::FounderRemoved { who });
			Ok(())
		}

		/// Vouch (or stop vouching) that `trust_address` belongs to a verified person. Its trust
		/// then counts (or stops counting) for validator selection. Withdrawing verification also
		/// removes that person's candidate.
		#[pallet::call_index(3)]
		#[pallet::weight(Weight::from_parts(BASE * 4, 4_000).saturating_add(T::DbWeight::get().reads_writes(8, 8)))]
		pub fn attest_identity(
			origin: OriginFor<T>,
			trust_address: T::AccountId,
			verified: bool,
		) -> DispatchResult {
			let attester = Self::ensure_identity_attester(origin)?;
			if verified {
				Self::verify(&attester, &trust_address);
			} else {
				Self::unverify(&trust_address);
			}
			Self::deposit_event(Event::IdentityAttested { trust_address, verified });
			Ok(())
		}

		#[pallet::call_index(4)]
		#[pallet::weight(Weight::from_parts(BASE, 4_000).saturating_add(T::DbWeight::get().reads_writes(6, 3)))]
		pub fn register_candidate(
			origin: OriginFor<T>,
			trust_address: T::AccountId,
			validator: T::AccountId,
		) -> DispatchResult {
			Self::ensure_identity_attester(origin)?;
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
		#[pallet::weight(Weight::from_parts(BASE, 4_000).saturating_add(T::DbWeight::get().reads_writes(1, 8)))]
		pub fn remove_candidate(origin: OriginFor<T>, validator: T::AccountId) -> DispatchResult {
			Self::ensure_identity_attester(origin)?;
			ensure!(Candidates::<T>::contains_key(&validator), Error::<T>::NotCandidate);
			Self::drop_candidate(&validator);
			Ok(())
		}

		/// A candidate leaves by itself.
		#[pallet::call_index(6)]
		#[pallet::weight(Weight::from_parts(BASE, 4_000).saturating_add(T::DbWeight::get().reads_writes(1, 8)))]
		pub fn withdraw(origin: OriginFor<T>) -> DispatchResult {
			let validator = ensure_signed(origin)?;
			ensure!(Candidates::<T>::contains_key(&validator), Error::<T>::NotCandidate);
			Self::drop_candidate(&validator);
			Ok(())
		}

		/// A validator (candidate or founder) set offline asks to be selected again, once its
		/// cooldown is over.
		#[pallet::call_index(7)]
		#[pallet::weight(Weight::from_parts(BASE, 2_000).saturating_add(T::DbWeight::get().reads_writes(4, 2)))]
		pub fn go_online(origin: OriginFor<T>) -> DispatchResult {
			let validator = ensure_signed(origin)?;
			ensure!(Self::is_validator(&validator), Error::<T>::NotCandidate);
			ensure!(Offline::<T>::contains_key(&validator), Error::<T>::NotOffline);
			let now = frame_system::Pallet::<T>::block_number();
			if let Some(since) = OfflineSince::<T>::get(&validator) {
				ensure!(now >= since.saturating_add(Self::cooldown(&validator)), Error::<T>::CooldownNotOver);
			}
			Offline::<T>::remove(&validator);
			OfflineSince::<T>::remove(&validator);
			Self::deposit_event(Event::CandidateOnline { validator });
			Ok(())
		}

		#[pallet::call_index(8)]
		#[pallet::weight(Weight::from_parts(BASE, 2_000).saturating_add(T::DbWeight::get().reads_writes(1, 1)))]
		pub fn add_identity_attester(origin: OriginFor<T>, who: T::AccountId) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			ensure!(!IdentityAttesters::<T>::contains_key(&who), Error::<T>::AlreadyIdentityAttester);
			IdentityAttesters::<T>::insert(&who, ());
			Self::deposit_event(Event::IdentityAttesterAdded { who });
			Ok(())
		}

		/// Removes an identity attester and withdraws every identity it vouched for.
		#[pallet::call_index(9)]
		#[pallet::weight(Weight::from_parts(BASE + 2_000_000_000, 2_000).saturating_add(T::DbWeight::get().reads_writes(1, 1)))]
		pub fn remove_identity_attester(origin: OriginFor<T>, who: T::AccountId) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			ensure!(IdentityAttesters::<T>::contains_key(&who), Error::<T>::NotIdentityAttester);
			Self::withdraw_attester(&who);
			Ok(())
		}

		#[pallet::call_index(10)]
		#[pallet::weight(Weight::from_parts(BASE, 1_000).saturating_add(T::DbWeight::get().writes(2)))]
		pub fn set_selection_limits(
			origin: OriginFor<T>,
			founder_share: Percent,
			max_new_per_session: u32,
		) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			FounderShare::<T>::put(founder_share);
			MaxNewPerSession::<T>::put(max_new_per_session);
			Self::deposit_event(Event::SelectionLimitsSet { founder_share, max_new_per_session });
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		fn ensure_identity_attester(origin: OriginFor<T>) -> Result<T::AccountId, DispatchError> {
			let who = ensure_signed(origin)?;
			ensure!(IdentityAttesters::<T>::contains_key(&who), Error::<T>::NotIdentityAttester);
			Ok(who)
		}

		fn verify(attester: &T::AccountId, address: &T::AccountId) {
			match Verified::<T>::get(address) {
				Some(previous) if &previous == attester => return,
				Some(previous) => VerifiedBy::<T>::remove(&previous, address),
				None => {
					for trusted in T::TrustScore::trusted_by(address) {
						VerifiedTrust::<T>::mutate(&trusted, |n| *n = n.saturating_add(1));
					}
				},
			}
			Verified::<T>::insert(address, attester);
			VerifiedBy::<T>::insert(attester, address, ());
		}

		fn unverify(address: &T::AccountId) {
			let Some(attester) = Verified::<T>::take(address) else { return };
			VerifiedBy::<T>::remove(&attester, address);
			for trusted in T::TrustScore::trusted_by(address) {
				VerifiedTrust::<T>::mutate(&trusted, |n| *n = n.saturating_sub(1));
			}
			if let Some(validator) = ValidatorOf::<T>::get(address) {
				Self::drop_candidate(&validator);
			}
		}

		/// Removes an identity attester and every identity it vouched for.
		pub(crate) fn withdraw_attester(who: &T::AccountId) {
			if IdentityAttesters::<T>::take(who).is_some() {
				Self::deposit_event(Event::IdentityAttesterRemoved { who: who.clone() });
			}
			let addresses: Vec<T::AccountId> = VerifiedBy::<T>::iter_key_prefix(who).collect();
			for address in addresses {
				Self::unverify(&address);
				Self::deposit_event(Event::IdentityAttested { trust_address: address, verified: false });
			}
		}

		fn clear_liveness(validator: &T::AccountId) {
			Offline::<T>::remove(validator);
			OfflineSince::<T>::remove(validator);
			Strikes::<T>::remove(validator);
			SelectedSince::<T>::remove(validator);
			LastAuthored::<T>::remove(validator);
		}

		fn drop_candidate(validator: &T::AccountId) {
			if let Some(trust_address) = Candidates::<T>::take(validator) {
				ValidatorOf::<T>::remove(&trust_address);
				CandidateCount::<T>::mutate(|c| *c = c.saturating_sub(1));
			}
			Self::clear_liveness(validator);
			Self::deposit_event(Event::CandidateRemoved { validator: validator.clone() });
		}

		/// Trust that counts for validation: distinct verified addresses trusting `who`.
		pub fn score(who: &T::AccountId) -> u32 {
			VerifiedTrust::<T>::get(who)
		}

		/// Whether a candidate currently meets identity and trust requirements.
		pub fn is_eligible(validator: &T::AccountId) -> bool {
			Candidates::<T>::get(validator).is_some_and(|trust_address| {
				Verified::<T>::contains_key(&trust_address) &&
					Self::score(&trust_address) >= MinTrust::<T>::get()
			}) && !Offline::<T>::contains_key(validator)
		}

		/// Cooldown before an offline validator may come back: `OfflineAfter` doubled for each
		/// strike after the first.
		pub fn cooldown(validator: &T::AccountId) -> BlockNumberFor<T> {
			let strikes = Strikes::<T>::get(validator).map_or(0, |s| s.0);
			let mut cooldown = T::OfflineAfter::get();
			for _ in 1..strikes.min(16) {
				cooldown = cooldown.saturating_add(cooldown);
			}
			cooldown
		}

		/// Sets a validator offline and gives it a strike; a candidate reaching `MaxStrikes` is
		/// removed.
		fn strike(validator: &T::AccountId, now: BlockNumberFor<T>) {
			let strikes = Strikes::<T>::get(validator).map_or(0, |s| s.0).saturating_add(1);
			Self::deposit_event(Event::ValidatorStruck { validator: validator.clone(), strikes });
			if strikes >= T::MaxStrikes::get() && Candidates::<T>::contains_key(validator) {
				Self::drop_candidate(validator);
				return;
			}
			Strikes::<T>::insert(validator, (strikes, now));
			Offline::<T>::insert(validator, ());
			OfflineSince::<T>::insert(validator, now);
			SelectedSince::<T>::remove(validator);
			Self::deposit_event(Event::CandidateOffline { validator: validator.clone() });
		}

		/// Liveness check for a validator currently in the set. Returns false (and strikes it)
		/// when it authored nothing for `OfflineAfter` blocks. Forgives old strikes.
		fn still_alive(validator: &T::AccountId, now: BlockNumberFor<T>) -> bool {
			if Offline::<T>::contains_key(validator) {
				return false;
			}
			let Some(since) = SelectedSince::<T>::get(validator) else { return true };
			let last = LastAuthored::<T>::get(validator).map_or(since, |s| s.max(since));
			if now.saturating_sub(last) > T::OfflineAfter::get() {
				Self::strike(validator, now);
				return false;
			}
			if let Some((_, at)) = Strikes::<T>::get(validator) {
				if now.saturating_sub(at) >= T::StrikeForgiveness::get() {
					Strikes::<T>::remove(validator);
				}
			}
			true
		}

		/// Seats candidates may take next to `founders` live founders.
		fn candidate_room(founders: usize) -> usize {
			let room = (T::MaxValidators::get() as usize).saturating_sub(founders);
			let share = FounderShare::<T>::get().deconstruct() as usize;
			if share == 0 {
				return room;
			}
			// founders / (founders + candidates) >= share  <=>  candidates <= founders * (100 - share) / share
			room.min(founders.saturating_mul(100usize.saturating_sub(share)) / share)
		}

		/// Live founders, then eligible live candidates by decreasing verified trust, within the
		/// seats left by `FounderShare` and `MaxValidators`, with at most `MaxNewPerSession`
		/// newcomers. Offline validators are left out so that they cannot stall GRANDPA finality;
		/// if nobody is left, all founders are kept.
		pub fn select(session: SessionIndex) -> Vec<T::AccountId> {
			let now = frame_system::Pallet::<T>::block_number();
			let all_founders = Founders::<T>::get().into_inner();
			let founders: Vec<T::AccountId> =
				all_founders.iter().filter(|f| Self::still_alive(f, now)).cloned().collect();
			for f in &founders {
				if !SelectedSince::<T>::contains_key(f) {
					SelectedSince::<T>::insert(f, now);
				}
			}

			let mut ranked: Vec<(u32, T::AccountId, bool)> = Vec::new();
			for (validator, trust_address) in Candidates::<T>::iter() {
				if !Self::is_eligible(&validator) {
					SelectedSince::<T>::remove(&validator);
					continue;
				}
				let incumbent = SelectedSince::<T>::contains_key(&validator);
				if incumbent && !Self::still_alive(&validator, now) {
					continue;
				}
				ranked.push((Self::score(&trust_address), validator, incumbent));
			}
			ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

			let room = Self::candidate_room(founders.len());
			let mut newcomers = MaxNewPerSession::<T>::get();
			let mut chosen: Vec<T::AccountId> = Vec::new();
			for (_, validator, incumbent) in ranked {
				let fits = chosen.len() < room && (incumbent || newcomers > 0);
				if !fits {
					SelectedSince::<T>::remove(&validator);
					continue;
				}
				if !incumbent {
					newcomers -= 1;
					SelectedSince::<T>::insert(&validator, now);
				}
				chosen.push(validator);
			}

			if founders.is_empty() && chosen.is_empty() {
				for f in &all_founders {
					Offline::<T>::remove(f);
					OfflineSince::<T>::remove(f);
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
				candidates: chosen.len() as u32,
			});
			founders.into_iter().chain(chosen).collect()
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

	impl<T: Config> pallet_coali_ledger::OnTrustChanged<T::AccountId> for Pallet<T> {
		fn pair_added(truster: &T::AccountId, trusted: &T::AccountId) {
			if Verified::<T>::contains_key(truster) {
				VerifiedTrust::<T>::mutate(trusted, |n| *n = n.saturating_add(1));
			}
		}
		fn pair_removed(truster: &T::AccountId, trusted: &T::AccountId) {
			if Verified::<T>::contains_key(truster) {
				VerifiedTrust::<T>::mutate(trusted, |n| *n = n.saturating_sub(1));
			}
		}
	}

	impl<T: Config> pallet_coali_ledger::OnAttesterRemoved<T::AccountId> for Pallet<T> {
		fn attester_removed(who: &T::AccountId) {
			Self::withdraw_attester(who);
		}
	}

	/// Proven misbehaviour (GRANDPA equivocation, reported through `pallet_offences`): there is no
	/// stake to slash, so a candidate loses its seat for good and a founder is set offline with the
	/// longest cooldown.
	impl<T: Config, F> sp_staking::offence::OnOffenceHandler<T::AccountId, (T::AccountId, F), Weight>
		for Pallet<T>
	{
		fn on_offence(
			offenders: &[sp_staking::offence::OffenceDetails<T::AccountId, (T::AccountId, F)>],
			_slash_fraction: &[sp_runtime::Perbill],
			_session: SessionIndex,
		) -> Weight {
			let now = frame_system::Pallet::<T>::block_number();
			for details in offenders {
				let who = &details.offender.0;
				Self::deposit_event(Event::ValidatorEquivocated { validator: who.clone() });
				if Candidates::<T>::contains_key(who) {
					Self::drop_candidate(who);
				} else if Founders::<T>::get().contains(who) {
					Strikes::<T>::insert(who, (T::MaxStrikes::get(), now));
					Offline::<T>::insert(who, ());
					OfflineSince::<T>::insert(who, now);
					SelectedSince::<T>::remove(who);
				}
			}
			T::DbWeight::get().reads_writes(4, 6).saturating_mul(offenders.len() as u64)
		}
	}
}
