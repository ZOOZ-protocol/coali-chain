//! Storage migrations.

use crate::*;
use frame_support::{migrations::VersionedMigration, pallet_prelude::*, traits::UncheckedOnRuntimeUpgrade};

/// v0 -> v1: records the storage layout of runtime 204 (decision rules, vote log, snapshot
/// proofs, electorate, reveals). That upgrade only added items and left the existing ones as they
/// were, so there is nothing to translate; decisions registered before it get their rules through
/// `set_rules`.
pub struct InnerMigrateV0ToV1<T>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV0ToV1<T> {
	fn on_runtime_upgrade() -> Weight {
		Weight::zero()
	}
}

pub type MigrateV0ToV1<T> =
	VersionedMigration<0, 1, InnerMigrateV0ToV1<T>, Pallet<T>, <T as frame_system::Config>::DbWeight>;

/// v1 -> v2 (runtime 207): the category registry is seeded with `DEFAULT_CATEGORIES` (ids
/// already registered are kept) and the per-category trust counts are computed from the trust
/// edges. Trust in a position recorded before belongs to the app that recorded it; edges do not
/// say which, so with a single attester (the testnet today) it is that one, otherwise those
/// edges are counted like domains (and leave that count when revoked).
pub struct InnerMigrateV1ToV2<T>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV1ToV2<T> {
	fn on_runtime_upgrade() -> Weight {
		let mut reads = 0u64;
		let mut writes = 0u64;

		for (id, key, domain) in DEFAULT_CATEGORIES {
			reads += 1;
			if Categories::<T>::contains_key(id) {
				continue;
			}
			let kind = if domain.is_some() { CategoryKind::Position } else { CategoryKind::Domain };
			let key = BoundedVec::truncate_from(key.to_vec());
			Categories::<T>::insert(id, CategoryInfo { kind, domain: *domain, key });
			writes += 1;
		}

		let mut attesters = Attesters::<T>::iter_keys();
		let sole_app = match (attesters.next(), attesters.next()) {
			(Some(app), None) => Some(app),
			_ => None,
		};
		reads += 2;

		let edges: alloc::vec::Vec<_> = TrustEdges::<T>::iter_keys().collect();
		reads += edges.len() as u64;
		for (truster, trusted, category) in edges {
			let key = (truster, trusted, category);
			match &sole_app {
				Some(app) => Pallet::<T>::count_trust(&key, Some(app)),
				None => {
					CategoryUse::<T>::mutate(category, |n| *n = n.saturating_add(1));
					TrustReceivedIn::<T>::mutate(&key.1, category, |n| *n = n.saturating_add(1));
				},
			}
			reads += 2;
			writes += 3;
		}
		T::DbWeight::get().reads_writes(reads, writes)
	}
}

pub type MigrateV1ToV2<T> =
	VersionedMigration<1, 2, InnerMigrateV1ToV2<T>, Pallet<T>, <T as frame_system::Config>::DbWeight>;
