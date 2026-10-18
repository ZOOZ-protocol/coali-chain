//! Benchmarks of the ledger calls that apps send in volume.
//!
//! `cargo build --release --features runtime-benchmarks`, then
//! `coali-node benchmark pallet --runtime <wasm> --genesis-builder=runtime --pallet pallet_coali_ledger
//!  --extrinsic '*' --steps 50 --repeat 20 --output pallets/coali-ledger/src/weights.rs
//!  --template .maintain/frame-weight-template.hbs`

use super::*;
use alloc::vec;
use frame_benchmarking::v2::*;
use frame_support::{traits::Get, BoundedVec};
use frame_system::RawOrigin;
use sp_core::{crypto::KeyTypeId, sr25519};
use sp_runtime::traits::IdentifyAccount;

const KEY: KeyTypeId = KeyTypeId(*b"bnch");

fn attester<T: Config>() -> T::AccountId {
	let who: T::AccountId = whitelisted_caller();
	Attesters::<T>::insert(&who, ());
	Electorate::<T>::insert(&who, u32::MAX);
	who
}

/// An end of voting the chain accepts now.
fn ends<T: Config>() -> u64 {
	Pallet::<T>::now().saturating_add(T::MinVotingPeriod::get()).saturating_add(1)
}

/// A fresh sr25519 key in the benchmark keystore, as an account.
fn key<T: Config>() -> (sr25519::Public, T::AccountId)
where
	T::Signer: From<sr25519::Public>,
{
	let public = sp_io::crypto::sr25519_generate(KEY, None);
	(public, T::Signer::from(public).into_account())
}

fn sign<T: Config>(public: &sr25519::Public, msg: &[u8]) -> T::Signature
where
	T::Signature: From<sr25519::Signature>,
{
	sp_io::crypto::sr25519_sign(KEY, public, msg).expect("key in keystore").into()
}

fn content(len: u32) -> BoundedVec<u8, MaxContentLen> {
	vec![b'a'; len as usize].try_into().expect("within MaxContentLen")
}

fn register<T: Config>(who: &T::AccountId, id: DecisionId) {
	Pallet::<T>::register_decision(RawOrigin::Signed(who.clone()).into(), id, content(100), 1, ends::<T>(), u32::MAX)
		.expect("registered");
}

/// Canonical totals of about `len` bytes adding up to `votes`.
fn totals(len: u32, votes: u32) -> BoundedVec<u8, MaxTotalsLen> {
	let mut out = alloc::format!("{{\"a\":{votes}");
	let mut i = 0u32;
	while (out.len() as u32) + 16 < len {
		out.push_str(&alloc::format!(",\"b{i:06}\":0"));
		i += 1;
	}
	out.push('}');
	out.into_bytes().try_into().expect("within MaxTotalsLen")
}

#[benchmarks(where T::Signer: From<sr25519::Public>, T::Signature: From<sr25519::Signature>)]
mod benchmarks {
	use super::*;

	#[benchmark]
	fn register_decision(l: Linear<10, { MaxContentLen::get() }>) {
		let who = attester::<T>();
		#[extrinsic_call]
		_(RawOrigin::Signed(who), [1; 16], content(l), 1, ends::<T>(), 1_000);
		assert!(Decisions::<T>::contains_key([1; 16]));
	}

	#[benchmark]
	fn record_vote() {
		let who = attester::<T>();
		register::<T>(&who, [1; 16]);
		let (public, voter) = key::<T>();
		let commitment = [7u8; 32];
		let sig = sign::<T>(&public, &Pallet::<T>::vote_payload(&[1; 16], &voter, &commitment, VoteKind::Direct));
		#[extrinsic_call]
		_(RawOrigin::Signed(who), [1; 16], voter.clone(), commitment, VoteKind::Direct, sig);
		assert!(Votes::<T>::contains_key([1; 16], &voter));
	}

	#[benchmark]
	fn record_trust() {
		let who = attester::<T>();
		let (public, truster) = key::<T>();
		let trusted: T::AccountId = account("trusted", 0, 0);
		let sig = sign::<T>(&public, &Pallet::<T>::trust_payload(&truster, &trusted, 1, TrustAction::Give, 0));
		#[extrinsic_call]
		_(RawOrigin::Signed(who), truster.clone(), trusted.clone(), 1, TrustAction::Give, 0, sig);
		assert_eq!(TrustReceived::<T>::get(&trusted), 1);
	}

	#[benchmark]
	fn publish_snapshot(l: Linear<10, { MaxTotalsLen::get() }>) {
		let who = attester::<T>();
		register::<T>(&who, [1; 16]);
		VoteCount::<T>::insert([1; 16], 5);
		#[extrinsic_call]
		_(RawOrigin::Signed(who), [1; 16], 0, [3; 32], totals(l, 5), false);
		assert!(Snapshots::<T>::contains_key([1; 16], 0));
	}

	#[benchmark]
	fn publish_content(l: Linear<10, { MaxContentLen::get() }>) {
		let who = attester::<T>();
		let c = content(l);
		Decisions::<T>::insert(
			[1; 16],
			DecisionInfo {
				content_hash: blake2_256(&c),
				category: 1,
				registered_by: who.clone(),
				registered_at: 0u32.into(),
				closed: false,
			},
		);
		#[extrinsic_call]
		_(RawOrigin::Signed(who), [1; 16], c);
		assert!(DecisionContent::<T>::contains_key([1; 16]));
	}

	#[benchmark]
	fn publish_totals(l: Linear<10, { MaxTotalsLen::get() }>) {
		let who = attester::<T>();
		register::<T>(&who, [1; 16]);
		let t = totals(l, 0);
		Snapshots::<T>::insert(
			[1; 16],
			0,
			SnapshotInfo { merkle_root: [0; 32], totals_hash: blake2_256(&t), is_final: false, published_at: 0u32.into() },
		);
		#[extrinsic_call]
		_(RawOrigin::Signed(who), [1; 16], 0, t);
		assert!(SnapshotTotals::<T>::contains_key([1; 16], 0));
	}

	#[benchmark]
	fn raise_max_voters() {
		let who = attester::<T>();
		Pallet::<T>::register_decision(RawOrigin::Signed(who.clone()).into(), [1; 16], content(100), 1, ends::<T>(), 10)
			.expect("registered");
		#[extrinsic_call]
		_(RawOrigin::Signed(who), [1; 16], 20);
		assert_eq!(DecisionRulesOf::<T>::get([1; 16]).map(|r| r.max_voters), Some(20));
	}

	#[benchmark]
	fn set_rules() {
		let who = attester::<T>();
		Decisions::<T>::insert(
			[1; 16],
			DecisionInfo { content_hash: [0; 32], category: 1, registered_by: who.clone(), registered_at: 0u32.into(), closed: false },
		);
		#[extrinsic_call]
		_(RawOrigin::Signed(who), [1; 16], ends::<T>(), 1_000);
		assert!(DecisionRulesOf::<T>::contains_key([1; 16]));
	}

	#[benchmark]
	fn reveal_votes(n: Linear<1, { T::MaxRevealsPerCall::get() }>) {
		let who = attester::<T>();
		Decisions::<T>::insert(
			[1; 16],
			DecisionInfo { content_hash: [0; 32], category: 1, registered_by: who.clone(), registered_at: 0u32.into(), closed: true },
		);
		let mut reveals = vec![];
		for i in 0..n {
			let voter: T::AccountId = account("voter", i, 0);
			let option: BoundedVec<u8, MaxOptionLen> = alloc::format!("option-{}", i % 30).into_bytes().try_into().unwrap();
			let salt = [b'a'; 64];
			Votes::<T>::insert(
				[1; 16],
				&voter,
				VoteRecord { commitment: commitment_of(&[1; 16], &option, &salt), kind: VoteKind::Direct, recorded_at: 0u32.into() },
			);
			reveals.push(Reveal { voter, option, salt });
		}
		VoteCount::<T>::insert([1; 16], n);
		FinalSnapshot::<T>::insert([1; 16], 0);
		SnapshotTotals::<T>::insert([1; 16], 0, totals(1_000, n));
		#[extrinsic_call]
		_(RawOrigin::Signed(who), [1; 16], reveals);
		assert_eq!(RevealedCount::<T>::get([1; 16]), n);
	}

	#[benchmark]
	fn add_attester() {
		let who: T::AccountId = account("app", 0, 0);
		#[extrinsic_call]
		_(RawOrigin::Root, who.clone());
		assert!(Attesters::<T>::contains_key(&who));
	}

	#[benchmark]
	fn remove_attester() {
		let who: T::AccountId = account("app", 0, 0);
		Attesters::<T>::insert(&who, ());
		#[extrinsic_call]
		_(RawOrigin::Root, who.clone());
		assert!(!Attesters::<T>::contains_key(&who));
	}

	impl_benchmark_test_suite!(Pallet, crate::mock::new_test_ext(), crate::mock::Test);
}
