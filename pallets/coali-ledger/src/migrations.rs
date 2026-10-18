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
