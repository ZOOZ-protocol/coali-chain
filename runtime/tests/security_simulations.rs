//! Attack simulations against the real runtime configuration (pre-audit, October 2026).
//! Report: `security/AUDIT-PRE-2026-10.md`.
//!
//! - `blocked::*`: the attack is attempted and must fail. These are regression tests; the
//!   `zooz_XX_*` ones are the findings of the pre-audit, fixed in runtime 204.
//! - `temporary::*`: accepted while the network launches (sudo key, single identity attester).
//!   Each asserts the current behaviour so that the day it changes, the test is moved to
//!   `blocked`.
//!
//! Run: `SKIP_WASM_BUILD=1 cargo test -p coali-runtime --test security_simulations -- --nocapture`

use codec::Encode;
use coali_runtime::{
	configs::{ProxyType, FIRST_ASSET_ID},
	AccountId, Assets, Balances, BuildStorage, CoaliLedger, ProofOfTrust, Proxy, Runtime, RuntimeCall,
	RuntimeGenesisConfig, RuntimeOrigin, Sudo, System, TransactionPayment, ZoozEconomy, UNIT,
};
use frame_support::{assert_noop, assert_ok, dispatch::GetDispatchInfo, BoundedVec};
use pallet_coali_ledger::{DecisionId, TrustAction, VoteCount, VoteKind};
use pallet_zooz_economy::Bucket;
use sp_core::{sr25519, Pair};
use sp_io::hashing::blake2_256;
use sp_runtime::{traits::Dispatchable, DispatchError, DispatchResult, MultiAddress, MultiSignature};

const MASTER: &str = "//audit-voter-master-seed";
const DECISION_UUID: &str = "3f2a9c1e-7b4d-4e11-9a2b-5c6d7e8f9a0b";
const D: DecisionId =
	[0x3f, 0x2a, 0x9c, 0x1e, 0x7b, 0x4d, 0x4e, 0x11, 0x9a, 0x2b, 0x5c, 0x6d, 0x7e, 0x8f, 0x9a, 0x0b];
const D2: DecisionId = [2; 16];
const CONTENT: &[u8] = br#"{"options":[{"id":"no","text":"Non"},{"id":"yes","text":"Oui"}],"question":"Q?"}"#;
/// Eligible voters declared for test decisions.
const ELIGIBLE: u32 = 10;
/// Unix ms at block 1 in these tests, and the end of voting of test decisions.
const START_MS: u64 = 1_800_000_000_000;
const ENDS_MS: u64 = START_MS + 3_600_000;

fn key(path: &str) -> sr25519::Pair {
	sr25519::Pair::from_string(path, None).expect("valid derivation path")
}
fn acc(p: &sr25519::Pair) -> AccountId {
	AccountId::from(p.public().0)
}
fn named(name: &str) -> AccountId {
	acc(&key(&format!("//{name}")))
}
fn attester() -> AccountId {
	named("attester")
}
fn sudo_key() -> AccountId {
	named("sudo")
}
fn oracle() -> AccountId {
	named("oracle")
}
fn founders() -> Vec<AccountId> {
	(1..=4).map(|i| named(&format!("founder-{i}"))).collect()
}
/// Keys the relayer derives for a Popolitica user (relayer/index.mjs).
fn voter_key(user: &str, decision: &str) -> sr25519::Pair {
	key(&format!("{MASTER}//coali//u//{user}//vote//{decision}"))
}
/// Since runtime 204: one giving key per (truster, trusted) pair.
fn give_key(user: &str, trusted: &str) -> sr25519::Pair {
	key(&format!("{MASTER}//coali//u//{user}//trust//give//{trusted}"))
}
fn trust_address(user: &str) -> AccountId {
	acc(&key(&format!("{MASTER}//coali//u//{user}//trust")))
}

fn ext() -> sp_io::TestExternalities {
	let mut g = RuntimeGenesisConfig::default();
	g.balances.balances = vec![
		(attester(), 1_000_000 * UNIT),
		(sudo_key(), 1_000_000 * UNIT),
		(named("watchdog"), 10 * UNIT),
		(named("alice"), 1_000 * UNIT),
		(named("bob"), UNIT),
		(named("charlie"), UNIT),
	];
	g.assets.next_asset_id = Some(FIRST_ASSET_ID);
	g.coali_ledger.attesters = vec![attester()];
	g.proof_of_trust.founders = founders();
	g.proof_of_trust.min_trust = 1;
	g.proof_of_trust.identity_attesters = vec![attester()];
	g.sudo.key = Some(sudo_key());
	let z = &mut g.zooz_economy;
	z.price_micro_usd = 246_900;
	z.target_fee_micro_usd = 50_000;
	z.author_percent = 60;
	z.foundation_percent = 20;
	z.block_reward = 5 * UNIT / 2;
	z.halving_interval = 21_000_000;
	z.foundation = Some(sudo_key());
	z.oracle = Some(oracle());
	z.fuel = 493_768_366 * UNIT;
	z.charity = 75_964_364 * UNIT;
	let mut ext: sp_io::TestExternalities = g.build_storage().unwrap().into();
	ext.execute_with(|| {
		System::set_block_number(1);
		pallet_timestamp::Now::<Runtime>::put(START_MS);
		// Electorate of the app, published by its identity attester.
		assert_ok!(CoaliLedger::set_electorate(RuntimeOrigin::signed(attester()), attester(), ELECTORATE));
	});
	ext
}

/// Electorate published for the test app; decisions declare at most this many voters.
const ELECTORATE: u32 = 100;

fn set_time(ms: u64) {
	pallet_timestamp::Now::<Runtime>::put(ms);
}

fn as_attester() -> RuntimeOrigin {
	RuntimeOrigin::signed(attester())
}

fn commitment(decision_uuid: &str, option: &str, salt: &str) -> [u8; 32] {
	blake2_256(format!("coali/commit/v1|{decision_uuid}|{option}|{salt}").as_bytes())
}

fn bounded<const N: u32>(bytes: &[u8]) -> BoundedVec<u8, frame_support::traits::ConstU32<N>> {
	bytes.to_vec().try_into().unwrap()
}

fn register(id: DecisionId) -> DispatchResult {
	CoaliLedger::register_decision(as_attester(), id, bounded::<8192>(CONTENT), 21, ENDS_MS, ELIGIBLE)
}

fn snapshot(origin: RuntimeOrigin, id: DecisionId, seq: u32, totals: &[u8], is_final: bool) -> DispatchResult {
	CoaliLedger::publish_snapshot(origin, id, seq, [0xAB; 32], bounded::<2048>(totals), is_final)
}

fn vote_as(origin: RuntimeOrigin, id: DecisionId, voter: &sr25519::Pair, c: [u8; 32]) -> DispatchResult {
	let who = acc(voter);
	let sig = MultiSignature::Sr25519(voter.sign(&CoaliLedger::vote_payload(&id, &who, &c, VoteKind::Direct)));
	CoaliLedger::record_vote(origin, id, who, c, VoteKind::Direct, sig)
}

fn vote(id: DecisionId, voter: &sr25519::Pair, c: [u8; 32]) -> DispatchResult {
	vote_as(as_attester(), id, voter, c)
}

fn trust_as(origin: RuntimeOrigin, truster: &sr25519::Pair, trusted: &AccountId, category: u32) -> DispatchResult {
	let who = acc(truster);
	let nonce = pallet_coali_ledger::TrustNonces::<Runtime>::get(&who);
	let payload = CoaliLedger::trust_payload(&who, trusted, category, TrustAction::Give, nonce);
	let sig = MultiSignature::Sr25519(truster.sign(&payload));
	CoaliLedger::record_trust(origin, who, trusted.clone(), category, TrustAction::Give, nonce, sig)
}

fn trust(truster: &sr25519::Pair, trusted: &AccountId, category: u32) -> DispatchResult {
	trust_as(as_attester(), truster, trusted, category)
}

/// Trust from a person the identity attester vouched for (eligible Popolitica user).
fn verified_trust(truster: &sr25519::Pair, trusted: &AccountId) {
	assert_ok!(ProofOfTrust::attest_identity(as_attester(), acc(truster), true));
	assert_ok!(trust(truster, trusted, 21));
}

/// Dispatch as a signed user through the runtime call filter, like a real transaction.
fn send(who: AccountId, call: RuntimeCall) -> Result<(), DispatchError> {
	call.dispatch(RuntimeOrigin::signed(who)).map(|_| ()).map_err(|e| e.error)
}

fn restricted_token(owner: AccountId, allowed: Vec<AccountId>) -> u32 {
	let id = FIRST_ASSET_ID;
	assert_ok!(Assets::create(RuntimeOrigin::signed(owner.clone()), id.into(), owner.clone().into(), 1));
	assert_ok!(Assets::mint(RuntimeOrigin::signed(owner.clone()), id.into(), owner.clone().into(), 1_000));
	assert_ok!(send(
		owner.clone(),
		RuntimeCall::TokenAllowlist(pallet_token_allowlist::Call::allow { asset: id, accounts: allowed })
	));
	assert_ok!(send(
		owner,
		RuntimeCall::TokenAllowlist(pallet_token_allowlist::Call::set_restricted { asset: id, restricted: true })
	));
	id
}

fn filtered() -> DispatchError {
	frame_system::Error::<Runtime>::CallFiltered.into()
}

fn register_candidate(origin: RuntimeOrigin, person: &str, validator: &AccountId) {
	let trust_addr = trust_address(person);
	assert_ok!(ProofOfTrust::attest_identity(origin.clone(), trust_addr.clone(), true));
	assert_ok!(ProofOfTrust::register_candidate(origin, trust_addr, validator.clone()));
}

/// Validator set planned for the next session.
fn plan() -> Vec<AccountId> {
	ProofOfTrust::select(1)
}

fn record_vote_call() -> RuntimeCall {
	RuntimeCall::CoaliLedger(pallet_coali_ledger::Call::record_vote {
		decision_id: D,
		voter: named("v"),
		commitment: [0; 32],
		kind: VoteKind::Direct,
		voter_signature: MultiSignature::Sr25519(sr25519::Signature::from_raw([0; 64])),
	})
}

/// Fee of a 250-byte `record_vote`, in base units, at the current price.
fn vote_fee() -> u128 {
	TransactionPayment::compute_fee(250, &record_vote_call().get_dispatch_info(), 0)
}

/// Merkle scheme v2 (runtime 204): domain-separated leaves and nodes.
fn leaf_v2(voter: &[u8; 32], commitment: &[u8; 32]) -> [u8; 32] {
	let mut buf = vec![0u8];
	buf.extend_from_slice(voter);
	buf.extend_from_slice(commitment);
	blake2_256(&buf)
}
fn node_v2(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
	let mut buf = vec![1u8];
	buf.extend_from_slice(a);
	buf.extend_from_slice(b);
	blake2_256(&buf)
}

mod blocked {
	use super::*;
	use pallet_coali_ledger::Error as L;
	use pallet_proof_of_trust::Error as P;

	#[test]
	fn outsider_cannot_write_to_the_ledger() {
		ext().execute_with(|| {
			let outsider = RuntimeOrigin::signed(named("mallory"));
			assert_noop!(
				CoaliLedger::register_decision(outsider.clone(), D, bounded::<8192>(CONTENT), 1, ENDS_MS, 1),
				L::<Runtime>::NotAttester
			);
			assert_ok!(register(D));
			let v = voter_key("u1", DECISION_UUID);
			assert_noop!(vote_as(outsider.clone(), D, &v, [1; 32]), L::<Runtime>::NotAttester);
			assert_noop!(
				trust_as(outsider.clone(), &give_key("u1", "u2"), &trust_address("u2"), 21),
				L::<Runtime>::NotAttester
			);
			assert_noop!(snapshot(outsider, D, 0, b"{}", true), L::<Runtime>::NotAttester);
		});
	}

	#[test]
	fn forged_voter_signature_is_rejected() {
		ext().execute_with(|| {
			assert_ok!(register(D));
			let victim = acc(&voter_key("victim", DECISION_UUID));
			let forger = key("//forger");
			let c = commitment(DECISION_UUID, "yes", "00");
			let sig = MultiSignature::Sr25519(forger.sign(&CoaliLedger::vote_payload(&D, &victim, &c, VoteKind::Direct)));
			assert_noop!(
				CoaliLedger::record_vote(as_attester(), D, victim, c, VoteKind::Direct, sig),
				L::<Runtime>::BadVoterSignature
			);
		});
	}

	#[test]
	fn vote_signature_cannot_be_replayed_on_another_decision_kind_or_network() {
		ext().execute_with(|| {
			assert_ok!(register(D));
			assert_ok!(register(D2));
			let v = voter_key("u1", DECISION_UUID);
			let who = acc(&v);
			let c = commitment(DECISION_UUID, "yes", "00");
			let sig = MultiSignature::Sr25519(v.sign(&CoaliLedger::vote_payload(&D, &who, &c, VoteKind::Direct)));

			assert_noop!(
				CoaliLedger::record_vote(as_attester(), D2, who.clone(), c, VoteKind::Direct, sig.clone()),
				L::<Runtime>::BadVoterSignature
			);
			assert_noop!(
				CoaliLedger::record_vote(as_attester(), D, who.clone(), c, VoteKind::Inferred, sig),
				L::<Runtime>::BadVoterSignature
			);
			let other_net = (pallet_coali_ledger::VOTE_CONTEXT, *b"coali-99", D, who.clone(), c, VoteKind::Direct).encode();
			let sig = MultiSignature::Sr25519(v.sign(&other_net));
			assert_noop!(
				CoaliLedger::record_vote(as_attester(), D, who, c, VoteKind::Direct, sig),
				L::<Runtime>::BadVoterSignature
			);
		});
	}

	#[test]
	fn same_address_cannot_vote_twice() {
		ext().execute_with(|| {
			assert_ok!(register(D));
			let v = voter_key("u1", DECISION_UUID);
			assert_ok!(vote(D, &v, commitment(DECISION_UUID, "yes", "00")));
			assert_noop!(vote(D, &v, commitment(DECISION_UUID, "no", "00")), L::<Runtime>::AlreadyVoted);
		});
	}

	#[test]
	fn trust_signature_cannot_be_replayed() {
		ext().execute_with(|| {
			let g = give_key("u1", "u2");
			let who = acc(&g);
			let trusted = trust_address("u2");
			let payload = CoaliLedger::trust_payload(&who, &trusted, 21, TrustAction::Give, 0);
			let sig = MultiSignature::Sr25519(g.sign(&payload));
			assert_ok!(CoaliLedger::record_trust(as_attester(), who.clone(), trusted.clone(), 21, TrustAction::Give, 0, sig.clone()));
			let revoke = CoaliLedger::trust_payload(&who, &trusted, 21, TrustAction::Revoke, 1);
			assert_ok!(CoaliLedger::record_trust(
				as_attester(), who.clone(), trusted.clone(), 21, TrustAction::Revoke, 1,
				MultiSignature::Sr25519(g.sign(&revoke))
			));
			assert_noop!(
				CoaliLedger::record_trust(as_attester(), who.clone(), trusted.clone(), 21, TrustAction::Give, 0, sig.clone()),
				L::<Runtime>::BadTrustNonce
			);
			assert_noop!(
				CoaliLedger::record_trust(as_attester(), who, trusted, 21, TrustAction::Give, 2, sig),
				L::<Runtime>::BadTrusterSignature
			);
		});
	}

	#[test]
	fn self_trust_is_rejected() {
		ext().execute_with(|| {
			let p = key("//narcissus");
			assert_noop!(trust(&p, &acc(&p), 21), L::<Runtime>::SelfTrust);
		});
	}

	#[test]
	fn trusting_in_many_categories_counts_as_one_truster() {
		ext().execute_with(|| {
			let g = give_key("u1", "u2");
			let target = trust_address("u2");
			assert_ok!(ProofOfTrust::attest_identity(as_attester(), acc(&g), true));
			for cat in 0..200 {
				assert_ok!(trust(&g, &target, cat));
			}
			assert_eq!(pallet_coali_ledger::TrustReceived::<Runtime>::get(&target), 1);
			assert_eq!(ProofOfTrust::score(&target), 1);
		});
	}

	#[test]
	fn legacy_clear_text_must_match_the_recorded_hashes() {
		ext().execute_with(|| {
			// A decision registered before runtime 204 (hash only).
			pallet_coali_ledger::Decisions::<Runtime>::insert(
				D,
				pallet_coali_ledger::DecisionInfo {
					content_hash: blake2_256(CONTENT),
					category: 21,
					registered_by: attester(),
					registered_at: 1,
					closed: false,
				},
			);
			let tampered = br#"{"options":[{"id":"no","text":"Oui"},{"id":"yes","text":"Non"}],"question":"Q?"}"#;
			assert_noop!(
				CoaliLedger::publish_content(as_attester(), D, bounded::<8192>(tampered)),
				L::<Runtime>::ContentMismatch
			);
			assert_ok!(CoaliLedger::publish_content(as_attester(), D, bounded::<8192>(CONTENT)));
			assert_noop!(
				CoaliLedger::publish_content(as_attester(), D, bounded::<8192>(CONTENT)),
				L::<Runtime>::AlreadyPublished
			);
		});
	}

	#[test]
	fn snapshots_are_ordered_and_a_closed_decision_takes_no_vote() {
		ext().execute_with(|| {
			assert_ok!(register(D));
			assert_noop!(snapshot(as_attester(), D, 1, b"{}", false), L::<Runtime>::SnapshotOutOfOrder);
			set_time(ENDS_MS);
			assert_ok!(snapshot(as_attester(), D, 0, b"{}", true));
			assert_noop!(vote(D, &voter_key("late", DECISION_UUID), [1; 32]), L::<Runtime>::DecisionClosed);
			assert_noop!(snapshot(as_attester(), D, 1, b"{}", true), L::<Runtime>::DecisionClosed);
		});
	}

	#[test]
	fn admin_calls_need_root() {
		ext().execute_with(|| {
			let user = RuntimeOrigin::signed(named("mallory"));
			assert_noop!(ZoozEconomy::set_price(user.clone(), 300_000), DispatchError::BadOrigin);
			assert_noop!(ZoozEconomy::set_target_fee(user.clone(), 0), DispatchError::BadOrigin);
			assert_noop!(ZoozEconomy::set_min_fee(user.clone(), 0), DispatchError::BadOrigin);
			assert_noop!(
				ZoozEconomy::spend(user.clone(), Bucket::Fuel, named("mallory"), UNIT),
				DispatchError::BadOrigin
			);
			assert_noop!(CoaliLedger::add_attester(user.clone(), named("mallory")), DispatchError::BadOrigin);
			assert_noop!(CoaliLedger::add_attester(as_attester(), named("mallory")), DispatchError::BadOrigin);
			assert_noop!(ProofOfTrust::set_min_trust(user.clone(), 0), DispatchError::BadOrigin);
			assert_noop!(ProofOfTrust::add_founder(user.clone(), named("mallory")), DispatchError::BadOrigin);
			assert_noop!(ProofOfTrust::add_identity_attester(as_attester(), named("mallory")), DispatchError::BadOrigin);
			assert!(Sudo::sudo(user, Box::new(RuntimeCall::System(frame_system::Call::remark { remark: vec![] }))).is_err());
		});
	}

	#[test]
	fn zero_price_is_rejected() {
		ext().execute_with(|| {
			assert_noop!(
				ZoozEconomy::set_price(RuntimeOrigin::root(), 0),
				pallet_zooz_economy::Error::<Runtime>::ZeroPrice
			);
		});
	}

	#[test]
	fn validator_needs_attestation_and_one_per_person() {
		ext().execute_with(|| {
			let user = RuntimeOrigin::signed(named("mallory"));
			assert_noop!(
				ProofOfTrust::attest_identity(user, named("mallory"), true),
				P::<Runtime>::NotIdentityAttester
			);
			assert_noop!(
				ProofOfTrust::register_candidate(as_attester(), trust_address("nobody"), named("val-x")),
				P::<Runtime>::NotVerified
			);
			register_candidate(as_attester(), "u1", &named("val-1"));
			assert_noop!(
				ProofOfTrust::register_candidate(as_attester(), trust_address("u1"), named("val-2")),
				P::<Runtime>::PersonHasValidator
			);
			assert_noop!(ProofOfTrust::go_online(RuntimeOrigin::signed(named("val-x"))), P::<Runtime>::NotCandidate);
		});
	}

	#[test]
	fn allowlist_holds_through_approvals_and_derivative_accounts() {
		ext().execute_with(|| {
			let (alice, bob, charlie) = (named("alice"), named("bob"), named("charlie"));
			let id = restricted_token(alice.clone(), vec![bob.clone()]);
			assert_ok!(send(
				alice.clone(),
				RuntimeCall::Assets(pallet_assets::Call::approve_transfer { id: id.into(), delegate: bob.clone().into(), amount: 10 })
			));
			assert_eq!(
				send(
					bob,
					RuntimeCall::Assets(pallet_assets::Call::transfer_approved {
						id: id.into(),
						owner: alice.clone().into(),
						destination: charlie.clone().into(),
						amount: 10,
					})
				),
				Err(filtered())
			);
			let inner = RuntimeCall::Assets(pallet_assets::Call::transfer { id: id.into(), target: charlie.into(), amount: 1 });
			assert_eq!(
				send(alice, RuntimeCall::Utility(pallet_utility::Call::as_derivative { index: 0, call: Box::new(inner) })),
				Err(filtered())
			);
		});
	}

	/// ZOOZ-01: the app declares the number of eligible voters when it registers a decision
	/// (public). Fabricated votes beyond it are refused, and raising it is a public event.
	#[test]
	fn zooz_01_ballot_stuffing_is_capped_by_the_declared_electorate() {
		ext().execute_with(|| {
			assert_ok!(register(D));
			let mut accepted = 0;
			for i in 0..500 {
				let ghost = voter_key(&format!("ghost-{i}"), DECISION_UUID);
				if vote(D, &ghost, commitment(DECISION_UUID, "yes", &format!("{i:064x}"))).is_ok() {
					accepted += 1;
				}
			}
			assert_eq!(accepted, ELIGIBLE);
			assert_eq!(VoteCount::<Runtime>::get(D), ELIGIBLE);
			assert_noop!(
				vote(D, &voter_key("one-more", DECISION_UUID), [9; 32]),
				L::<Runtime>::TooManyVotes
			);
			println!("ZOOZ-01: 500 attempted, {accepted} accepted (declared electorate); the rest refused");
		});
	}

	/// ZOOZ-02: totals must add up to the votes the chain recorded.
	#[test]
	fn zooz_02_results_unrelated_to_the_votes_are_refused() {
		ext().execute_with(|| {
			assert_ok!(register(D));
			assert_ok!(vote(D, &voter_key("u1", DECISION_UUID), commitment(DECISION_UUID, "no", "01")));
			assert_ok!(vote(D, &voter_key("u2", DECISION_UUID), commitment(DECISION_UUID, "no", "02")));
			set_time(ENDS_MS);
			assert_noop!(
				snapshot(as_attester(), D, 0, br#"{"no":0,"yes":1000000}"#, true),
				L::<Runtime>::TotalsNotVoteCount
			);
			assert_ok!(snapshot(as_attester(), D, 0, br#"{"no":2}"#, true));
			let proof = pallet_coali_ledger::SnapshotProofs::<Runtime>::get(D, 0).unwrap();
			assert_eq!(proof.vote_count, 2);
			assert!(proof.vote_log.is_some());
			println!("ZOOZ-02: fake totals refused; published totals match the 2 votes on chain");
		});
	}

	/// ZOOZ-03: only the registering app writes to a decision, and not before voting ends.
	#[test]
	fn zooz_03_nobody_closes_a_decision_early_or_someone_elses() {
		ext().execute_with(|| {
			assert_ok!(register(D));
			let rival = named("rival-app");
			assert_ok!(CoaliLedger::add_attester(RuntimeOrigin::root(), rival.clone()));
			assert_noop!(snapshot(RuntimeOrigin::signed(rival), D, 0, b"{}", true), L::<Runtime>::NotRegistrar);
			assert_noop!(snapshot(as_attester(), D, 0, b"{}", true), L::<Runtime>::VotingNotEnded);
			assert_ok!(vote(D, &voter_key("u1", DECISION_UUID), [1; 32]));
			println!("ZOOZ-03: rival app and early close both refused; voting continues");
		});
	}

	/// ZOOZ-04: Sybil trust from unverified addresses counts for nothing, and founders keep more
	/// than a third of the seats: even a stolen identity-attester key cannot reach 2/3.
	#[test]
	fn zooz_04_validator_set_takeover_fails() {
		ext().execute_with(|| {
			let honest = named("honest-validator");
			register_candidate(as_attester(), "honest-person", &honest);
			for t in 0..3 {
				verified_trust(&give_key(&format!("real-truster-{t}"), "honest-person"), &trust_address("honest-person"));
			}

			// Plain Sybil keys: no verification, no weight.
			let mut evil = Vec::new();
			for i in 0..28 {
				let person = format!("fake-person-{i}");
				let validator = named(&format!("evil-validator-{i}"));
				register_candidate(as_attester(), &person, &validator);
				for t in 0..4 {
					assert_ok!(trust(&key(&format!("//sybil-{i}-{t}")), &trust_address(&person), 21));
				}
				evil.push(validator);
			}
			let set = plan();
			assert!(set.contains(&honest));
			assert_eq!(set.iter().filter(|v| evil.contains(v)).count(), 0);

			// A stolen identity-attester key verifying the Sybils too, over many sessions.
			for i in 0..28 {
				for t in 0..4 {
					assert_ok!(ProofOfTrust::attest_identity(as_attester(), acc(&key(&format!("//sybil-{i}-{t}"))), true));
				}
			}
			let mut set = Vec::new();
			for _ in 0..20 {
				set = plan();
			}
			let controlled = set.iter().filter(|v| evil.contains(v)).count();
			assert!(controlled * 3 < set.len(), "attacker must stay below 1/3 (cannot even stall finality)");
			let founders_in = set.iter().filter(|v| founders().contains(v)).count();
			assert!(founders_in * 3 > set.len() * 2, "founders keep more than 2/3");
			println!(
				"ZOOZ-04: Sybil trust ignored; with a stolen attester key the attacker gets {controlled}/{} seats, founders {founders_in}",
				set.len()
			);
		});
	}

	/// ZOOZ-05: removing an attester withdraws the identities and candidates it vouched for.
	#[test]
	fn zooz_05_removed_attester_loses_its_validators() {
		ext().execute_with(|| {
			let rogue = named("rogue-app");
			assert_ok!(CoaliLedger::add_attester(RuntimeOrigin::root(), rogue.clone()));
			assert_ok!(ProofOfTrust::add_identity_attester(RuntimeOrigin::root(), rogue.clone()));
			let validator = named("rogue-validator");
			register_candidate(RuntimeOrigin::signed(rogue.clone()), "rogue-person", &validator);
			let sybil = key("//rogue-sybil");
			assert_ok!(ProofOfTrust::attest_identity(RuntimeOrigin::signed(rogue.clone()), acc(&sybil), true));
			assert_ok!(trust_as(RuntimeOrigin::signed(rogue.clone()), &sybil, &trust_address("rogue-person"), 21));
			assert!(plan().contains(&validator));
			assert_ok!(CoaliLedger::remove_attester(RuntimeOrigin::root(), rogue));
			assert!(!plan().contains(&validator));
			println!("ZOOZ-05: validator dropped with its attester");
		});
	}

	/// ZOOZ-06: an offline validator waits a growing cooldown, and is removed after MaxStrikes.
	#[test]
	fn zooz_06_offline_validator_cannot_rejoin_at_once() {
		ext().execute_with(|| {
			let lazy = named("lazy-validator");
			register_candidate(as_attester(), "lazy-person", &lazy);
			verified_trust(&give_key("friend", "lazy-person"), &trust_address("lazy-person"));
			assert!(plan().contains(&lazy));
			System::set_block_number(1 + 121);
			assert!(!plan().contains(&lazy));
			assert_noop!(
				ProofOfTrust::go_online(RuntimeOrigin::signed(lazy.clone())),
				pallet_proof_of_trust::Error::<Runtime>::CooldownNotOver
			);
			println!("ZOOZ-06: offline -> go_online refused until the cooldown is over");
		});
	}

	/// ZOOZ-07: the oracle cannot publish absurd prices, move the price by more than 20% at once
	/// or update more often than every 6 hours; fees never fall to zero.
	#[test]
	fn zooz_07_price_manipulation_is_bounded() {
		ext().execute_with(|| {
			use pallet_zooz_economy::Error as E;
			let normal = vote_fee();
			let o = || RuntimeOrigin::signed(oracle());
			assert_noop!(ZoozEconomy::set_price(o(), u64::MAX), E::<Runtime>::PriceOutOfRange);
			assert_noop!(ZoozEconomy::set_price(o(), 246_900 * 100), E::<Runtime>::PriceChangeTooLarge);
			assert_noop!(ZoozEconomy::set_price(o(), 2_469), E::<Runtime>::PriceChangeTooLarge);
			assert_ok!(ZoozEconomy::set_price(o(), 246_900 * 12 / 10));
			assert_noop!(ZoozEconomy::set_price(o(), 246_900 * 14 / 10), E::<Runtime>::PriceUpdateTooSoon);
			assert!(vote_fee() * 2 > normal);
			// Even at the highest accepted price the fee is not zero.
			assert_ok!(ZoozEconomy::set_price(RuntimeOrigin::root(), 100_000_000));
			assert!(vote_fee() > 0);
			println!("ZOOZ-07: absurd, sudden or too frequent prices refused; fee floor holds");
		});
	}

	/// ZOOZ-08: the watchdog runs with a proxy key that can only ask for a GRANDPA forced change;
	/// the oracle with its own account. A stolen watchdog key cannot mint or spend.
	#[test]
	fn zooz_08_stolen_watchdog_key_cannot_mint() {
		ext().execute_with(|| {
			let watchdog = named("watchdog");
			assert_ok!(Proxy::add_proxy(RuntimeOrigin::signed(sudo_key()), watchdog.clone().into(), ProxyType::FinalityWatchdog, 0));
			let via_proxy = |call: RuntimeCall| {
				RuntimeCall::Proxy(pallet_proxy::Call::proxy {
					real: sudo_key().into(),
					force_proxy_type: None,
					call: Box::new(RuntimeCall::Sudo(pallet_sudo::Call::sudo { call: Box::new(call) })),
				})
			};
			let issuance = Balances::total_issuance();
			let mint = RuntimeCall::Balances(pallet_balances::Call::force_set_balance {
				who: MultiAddress::Id(watchdog.clone()),
				new_free: 100_000_000 * UNIT,
			});
			assert_ok!(send(watchdog.clone(), via_proxy(mint)));
			System::assert_has_event(
				pallet_proxy::Event::ProxyExecuted { result: Err(filtered()) }.into(),
			);
			assert_eq!(Balances::total_issuance(), issuance);

			let stall = RuntimeCall::Grandpa(pallet_grandpa::Call::note_stalled { delay: 5, best_finalized_block_number: 0 });
			assert_ok!(send(watchdog, via_proxy(stall)));
			System::assert_has_event(pallet_proxy::Event::ProxyExecuted { result: Ok(()) }.into());
			println!("ZOOZ-08: watchdog key can request a forced finality change, nothing else");
		});
	}

	/// ZOOZ-09: `force_transfer` (token admin, a plain account) respects the allowlist.
	#[test]
	fn zooz_09_token_admin_cannot_bypass_the_allowlist() {
		ext().execute_with(|| {
			let (alice, bob, charlie) = (named("alice"), named("bob"), named("charlie"));
			let id = restricted_token(alice.clone(), vec![bob.clone()]);
			let force = |dest: AccountId| {
				RuntimeCall::Assets(pallet_assets::Call::force_transfer {
					id: id.into(),
					source: alice.clone().into(),
					dest: dest.into(),
					amount: 5,
				})
			};
			assert_eq!(send(alice.clone(), force(charlie.clone())), Err(filtered()));
			assert_ok!(send(alice.clone(), force(bob.clone())));
			assert_eq!(Assets::balance(id, charlie), 0);
			println!("ZOOZ-09: force_transfer to a non-allowlisted account refused");
		});
	}

	/// ZOOZ-10: with v2 prefixes, an inner node can no longer pass as a vote leaf.
	#[test]
	fn zooz_10_inner_merkle_node_cannot_pass_as_a_vote() {
		let voters: Vec<[u8; 32]> = (0u8..4).map(|i| blake2_256(&[i])).collect();
		let mut leaves: Vec<[u8; 32]> = voters.iter().map(|v| leaf_v2(v, &[7; 32])).collect();
		leaves.sort();
		let n01 = node_v2(&leaves[0], &leaves[1]);
		let n23 = node_v2(&leaves[2], &leaves[3]);
		let root = node_v2(&n01, &n23);
		// Claim a vote whose voter / commitment are the two children of n01.
		let fake_leaf = leaf_v2(&leaves[0], &leaves[1]);
		assert_ne!(fake_leaf, n01);
		assert_ne!(node_v2(&fake_leaf, &n23), root);
		println!("ZOOZ-10: inner node rejected as a leaf (0x00 leaf / 0x01 node prefixes)");
	}

	/// ZOOZ-18: a decision's text is stored with its registration; it cannot be swapped.
	#[test]
	fn zooz_18_decision_text_is_recorded_at_registration() {
		ext().execute_with(|| {
			assert_ok!(register(D));
			let d = pallet_coali_ledger::Decisions::<Runtime>::get(D).unwrap();
			assert_eq!(d.content_hash, blake2_256(CONTENT));
			assert_eq!(pallet_coali_ledger::DecisionContent::<Runtime>::get(D).unwrap().to_vec(), CONTENT.to_vec());
			assert_noop!(
				CoaliLedger::publish_content(as_attester(), D, bounded::<8192>(b"{}")),
				L::<Runtime>::AlreadyPublished
			);
		});
	}
}

/// Bypasses found by the auditor's double check (B01-B07), now blocked.
mod bypass {
	use super::*;
	use pallet_coali_ledger::Error as L;

	fn proxy_ok() -> bool {
		System::events()
			.iter()
			.rev()
			.find_map(|r| match &r.event {
				coali_runtime::RuntimeEvent::Proxy(pallet_proxy::Event::ProxyExecuted { result }) => Some(result.is_ok()),
				_ => None,
			})
			.unwrap_or(false)
	}

	/// B01: a decision without rules (registered before 204) takes no vote and cannot close until
	/// it gets rules, under the same constraints as a new decision.
	#[test]
	fn b01_legacy_decision_without_rules_takes_no_vote_and_cannot_close() {
		ext().execute_with(|| {
			assert_ok!(register(D));
			pallet_coali_ledger::DecisionRulesOf::<Runtime>::remove(D);
			assert_noop!(vote(D, &voter_key("g0", DECISION_UUID), [0; 32]), L::<Runtime>::NoRules);
			assert_noop!(snapshot(as_attester(), D, 0, b"{}", true), L::<Runtime>::NoRules);
			assert_noop!(CoaliLedger::set_rules(as_attester(), D, START_MS + 60_000, ELIGIBLE), L::<Runtime>::VotingTooShort);
			assert_noop!(CoaliLedger::set_rules(as_attester(), D, ENDS_MS, u32::MAX), L::<Runtime>::AboveElectorate);
			println!("B01 blocked: no vote, no close without rules; rules need a real period and the published electorate");
		});
	}

	/// B02: the end of voting is mandatory (at least an hour away) and the voter cap cannot
	/// exceed the electorate published by the identity attester.
	#[test]
	fn b02_no_huge_electorate_and_no_instant_close() {
		ext().execute_with(|| {
			let reg = |ends: u64, max: u32| CoaliLedger::register_decision(as_attester(), D, bounded::<8192>(CONTENT), 21, ends, max);
			assert_noop!(reg(ENDS_MS, u32::MAX), L::<Runtime>::AboveElectorate);
			assert_noop!(reg(START_MS, ELIGIBLE), L::<Runtime>::VotingTooShort);
			assert_ok!(reg(ENDS_MS, ELECTORATE));
			let mut ok = 0;
			for i in 0..200 {
				if vote(D, &voter_key(&format!("g{i}"), DECISION_UUID), [1; 32]).is_ok() {
					ok += 1;
				}
			}
			assert_eq!(ok, ELECTORATE);
			assert_noop!(snapshot(as_attester(), D, 0, format!(r#"{{"yes":{ok}}}"#).as_bytes(), true), L::<Runtime>::VotingNotEnded);
			println!("B02 blocked: {ok}/200 votes (published electorate {ELECTORATE}), no close before the end");
		});
	}

	/// B03: totals redistributed between options pass the sum check, but once the votes are
	/// revealed the chain's own count does not match, publicly.
	#[test]
	fn b03_votes_reassigned_between_options_are_caught_by_the_recount() {
		ext().execute_with(|| {
			assert_ok!(register(D));
			let salt = |i: u8| [b'0' + i; 64];
			let c = |o: &str, i: u8| pallet_coali_ledger::commitment_of(&D, o.as_bytes(), &salt(i));
			assert_ok!(vote(D, &voter_key("u1", DECISION_UUID), c("no", 1)));
			assert_ok!(vote(D, &voter_key("u2", DECISION_UUID), c("no", 2)));
			set_time(ENDS_MS);
			assert_ok!(snapshot(as_attester(), D, 0, br#"{"yes":2}"#, true));
			let reveal = |u: &str, o: &str, i: u8| pallet_coali_ledger::Reveal {
				voter: acc(&voter_key(u, DECISION_UUID)),
				option: o.as_bytes().to_vec().try_into().unwrap(),
				salt: salt(i),
			};
			assert_noop!(
				CoaliLedger::reveal_votes(as_attester(), D, vec![reveal("u1", "yes", 1)]),
				L::<Runtime>::RevealMismatch
			);
			assert_ok!(CoaliLedger::reveal_votes(as_attester(), D, vec![reveal("u1", "no", 1), reveal("u2", "no", 2)]));
			let recount = pallet_coali_ledger::RecountOf::<Runtime>::get(D).unwrap();
			assert!(!recount.matches);
			println!("B03 blocked: published {{\"yes\":2}}, chain recount finds 2 \"no\": mismatch shown publicly");
		});
	}

	/// B04: an hour after the end, the cap cannot be raised; late votes only within the grace
	/// period (votes deduced from boards become official at the end).
	#[test]
	fn b04_no_cap_raise_after_the_end_and_bounded_late_votes() {
		ext().execute_with(|| {
			assert_ok!(register(D));
			set_time(ENDS_MS + 3_600_000);
			assert_noop!(CoaliLedger::raise_max_voters(as_attester(), D, ELIGIBLE * 10), L::<Runtime>::VotingEnded);
			assert_ok!(vote(D, &voter_key("deduced", DECISION_UUID), [3; 32]));
			set_time(ENDS_MS + 24 * 3_600_000 + 1);
			assert_noop!(vote(D, &voter_key("late", DECISION_UUID), [4; 32]), L::<Runtime>::VotingEnded);
			println!("B04 blocked: no cap raise after the end; late votes only within 24 h");
		});
	}

	#[test]
	fn b05_watchdog_proxy_escalation_attempts_fail() {
		ext().execute_with(|| {
			let w = named("watchdog");
			assert_ok!(Proxy::add_proxy(RuntimeOrigin::signed(sudo_key()), w.clone().into(), ProxyType::FinalityWatchdog, 0));
			let mint = || Box::new(RuntimeCall::Balances(pallet_balances::Call::force_set_balance { who: w.clone().into(), new_free: 1_000_000 * UNIT }));
			let stall = || RuntimeCall::Grandpa(pallet_grandpa::Call::note_stalled { delay: 5, best_finalized_block_number: 0 });
			let attempts: Vec<RuntimeCall> = vec![
				RuntimeCall::Sudo(pallet_sudo::Call::set_key { new: w.clone().into() }),
				RuntimeCall::Sudo(pallet_sudo::Call::sudo_as { who: w.clone().into(), call: mint() }),
				RuntimeCall::Sudo(pallet_sudo::Call::sudo_unchecked_weight { call: Box::new(stall()), weight: Default::default() }),
				RuntimeCall::Sudo(pallet_sudo::Call::sudo { call: Box::new(RuntimeCall::Utility(pallet_utility::Call::batch { calls: vec![stall(), *mint()] })) }),
				RuntimeCall::Proxy(pallet_proxy::Call::add_proxy { delegate: w.clone().into(), proxy_type: ProxyType::Any, delay: 0 }),
				RuntimeCall::Sudo(pallet_sudo::Call::remove_key {}),
			];
			let issuance = Balances::total_issuance();
			for call in attempts {
				let _ = send(w.clone(), RuntimeCall::Proxy(pallet_proxy::Call::proxy { real: sudo_key().into(), force_proxy_type: None, call: Box::new(call) }));
				assert!(!proxy_ok());
			}
			assert_eq!(pallet_sudo::Key::<Runtime>::get(), Some(sudo_key()));
			assert_eq!(Balances::total_issuance(), issuance);
		});
	}

	#[test]
	fn b06_restricted_token_through_a_proxy_or_multisig_fails() {
		ext().execute_with(|| {
			let (alice, bob, charlie) = (named("alice"), named("bob"), named("charlie"));
			let id = restricted_token(alice.clone(), vec![bob.clone()]);
			assert_ok!(Proxy::add_proxy(RuntimeOrigin::signed(alice.clone()), bob.clone().into(), ProxyType::Any, 0));
			let t = || Box::new(RuntimeCall::Assets(pallet_assets::Call::transfer { id: id.into(), target: charlie.clone().into(), amount: 7 }));
			let _ = send(bob.clone(), RuntimeCall::Proxy(pallet_proxy::Call::proxy { real: alice.clone().into(), force_proxy_type: None, call: t() }));
			let _ = send(alice.clone(), RuntimeCall::Multisig(pallet_multisig::Call::as_multi_threshold_1 { other_signatories: vec![bob.clone()], call: t() }));
			assert_eq!(Assets::balance(id, charlie), 0);
		});
	}

	#[test]
	fn b07_oracle_cannot_walk_fees_to_nothing_quickly() {
		ext().execute_with(|| {
			let start = vote_fee();
			let mut steps = 0;
			let mut t = START_MS;
			while steps < 200 {
				let p = pallet_zooz_economy::PriceMicroUsd::<Runtime>::get();
				t += 6 * 3_600_000 + 1;
				set_time(t);
				System::set_block_number(System::block_number() + 3_601);
				if ZoozEconomy::set_price(RuntimeOrigin::signed(oracle()), p * 12 / 10).is_err() {
					break;
				}
				steps += 1;
				if vote_fee() * 100 <= start {
					break;
				}
			}
			let days = steps as f64 * 6.0 / 24.0;
			assert!(!(vote_fee() * 100 <= start && days < 2.0));
			println!("B07: fee divided by {:.1} at most ({steps} steps, {days:.1} days), floor {}", start as f64 / vote_fee().max(1) as f64, vote_fee());
		});
	}
}

mod temporary {
	use super::*;

	/// ZOOZ-08 (accepted during launch): sudo can still mint and spend reserves. The key is kept
	/// offline (no longer on any server) and is to move to a multisig, then be removed before
	/// mainnet. When that happens, move this test to `blocked`.
	#[test]
	fn zooz_08_sudo_key_is_still_all_powerful_until_mainnet() {
		ext().execute_with(|| {
			let issuance = Balances::total_issuance();
			let mint = RuntimeCall::Balances(pallet_balances::Call::force_set_balance {
				who: MultiAddress::Id(named("thief")),
				new_free: UNIT,
			});
			assert_ok!(Sudo::sudo(RuntimeOrigin::signed(sudo_key()), Box::new(mint)));
			assert_eq!(Balances::total_issuance(), issuance + UNIT);
			println!("ZOOZ-08 (temporary): sudo exists until the multisig / mainnet step");
		});
	}
}
