//! Conservative hand-set weights, to be replaced by benchmarked values before mainnet.

use frame_support::weights::{constants::RocksDbWeight, Weight};

pub trait WeightInfo {
	fn add_attester() -> Weight;
	fn remove_attester() -> Weight;
	fn register_decision() -> Weight;
	fn record_vote() -> Weight;
	fn record_trust() -> Weight;
	fn publish_snapshot() -> Weight;
}

/// sr25519 verification is about 50 µs; doubled for margin.
const SIGNATURE_CHECK: u64 = 100_000_000;
const BASE: u64 = 20_000_000;

impl WeightInfo for () {
	fn add_attester() -> Weight {
		Weight::from_parts(BASE, 2_000).saturating_add(RocksDbWeight::get().reads_writes(1, 1))
	}
	fn remove_attester() -> Weight {
		Weight::from_parts(BASE, 2_000).saturating_add(RocksDbWeight::get().reads_writes(1, 1))
	}
	fn register_decision() -> Weight {
		Weight::from_parts(BASE, 4_000).saturating_add(RocksDbWeight::get().reads_writes(2, 1))
	}
	fn record_vote() -> Weight {
		Weight::from_parts(BASE + SIGNATURE_CHECK, 6_000)
			.saturating_add(RocksDbWeight::get().reads_writes(4, 2))
	}
	fn record_trust() -> Weight {
		Weight::from_parts(BASE + SIGNATURE_CHECK, 6_000)
			.saturating_add(RocksDbWeight::get().reads_writes(3, 2))
	}
	fn publish_snapshot() -> Weight {
		Weight::from_parts(BASE, 4_000).saturating_add(RocksDbWeight::get().reads_writes(3, 3))
	}
}
