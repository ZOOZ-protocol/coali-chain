//! Storage migrations.

use crate::*;
use alloc::vec::Vec;
use frame_support::{
	migrations::VersionedMigration,
	pallet_prelude::*,
	traits::{Get, UncheckedOnRuntimeUpgrade},
};

/// Version 0 stored `Verified` as `address -> ()`, without the attester that vouched.
mod v0 {
	use super::*;

	#[frame_support::storage_alias]
	pub type Verified<T: Config> =
		StorageMap<Pallet<T>, Blake2_128Concat, <T as frame_system::Config>::AccountId, (), OptionQuery>;
}

/// v0 -> v1 (runtime 204): identity attesters become a list of their own, seeded with `I`;
/// verifications without a known attester are dropped (with the candidates relying on them,
/// since only verified addresses can stand); offline validators start their cooldown now.
pub struct InnerMigrateV0ToV1<T, I>(core::marker::PhantomData<(T, I)>);

impl<T: Config, I: Get<Vec<T::AccountId>>> UncheckedOnRuntimeUpgrade for InnerMigrateV0ToV1<T, I> {
	fn on_runtime_upgrade() -> Weight {
		let mut reads = 0u64;
		let mut writes = 0u64;

		for who in I::get() {
			IdentityAttesters::<T>::insert(&who, ());
			writes += 1;
		}

		let old: Vec<T::AccountId> = v0::Verified::<T>::iter_keys().collect();
		reads += old.len() as u64;
		for address in old {
			v0::Verified::<T>::remove(&address);
			writes += 1;
		}

		let candidates: Vec<(T::AccountId, T::AccountId)> = Candidates::<T>::drain().collect();
		reads += candidates.len() as u64;
		for (validator, trust_address) in candidates {
			ValidatorOf::<T>::remove(&trust_address);
			SelectedSince::<T>::remove(&validator);
			LastAuthored::<T>::remove(&validator);
			Offline::<T>::remove(&validator);
			writes += 5;
		}
		CandidateCount::<T>::put(0);

		let now = frame_system::Pallet::<T>::block_number();
		let offline: Vec<T::AccountId> = Offline::<T>::iter_keys().collect();
		reads += offline.len() as u64;
		for who in offline {
			OfflineSince::<T>::insert(&who, now);
			writes += 1;
		}

		T::DbWeight::get().reads_writes(reads + 1, writes + 1)
	}
}

pub type MigrateV0ToV1<T, I> = VersionedMigration<
	0,
	1,
	InnerMigrateV0ToV1<T, I>,
	Pallet<T>,
	<T as frame_system::Config>::DbWeight,
>;
