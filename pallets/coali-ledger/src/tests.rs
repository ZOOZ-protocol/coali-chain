use crate::{
	mock::*, DecisionContent, Decisions, Error, Event, LatestSnapshot, SnapshotTotals, TrustAction,
	TrustEdges, TrustNonces, VoteCount, VoteKind, Votes,
};
use frame_support::{assert_noop, assert_ok};
use sp_core::Pair;
use sp_runtime::{DispatchError, MultiSignature};

const D1: [u8; 16] = [1; 16];

fn origin() -> RuntimeOrigin {
	RuntimeOrigin::signed(attester())
}

fn register(id: [u8; 16]) {
	assert_ok!(Ledger::register_decision(origin(), id, [9; 32], 21));
}

fn signed_vote(seed: &str, decision: [u8; 16], commitment: [u8; 32], kind: VoteKind) -> (sp_runtime::AccountId32, MultiSignature) {
	let p = pair(seed);
	let voter = account(&p);
	let payload = Ledger::vote_payload(&decision, &voter, &commitment, kind);
	(voter, MultiSignature::Sr25519(p.sign(&payload)))
}

fn signed_trust(
	truster_seed: &str,
	trusted: &sp_runtime::AccountId32,
	category: u32,
	action: TrustAction,
	nonce: u32,
) -> (sp_runtime::AccountId32, MultiSignature) {
	let p = pair(truster_seed);
	let truster = account(&p);
	let payload = Ledger::trust_payload(&truster, trusted, category, action, nonce);
	(truster, MultiSignature::Sr25519(p.sign(&payload)))
}

#[test]
fn only_attesters_can_write() {
	new_test_ext().execute_with(|| {
		let stranger = RuntimeOrigin::signed(account(&pair("Stranger")));
		assert_noop!(Ledger::register_decision(stranger, D1, [0; 32], 1), Error::<Test>::NotAttester);
	});
}

#[test]
fn admin_manages_attesters() {
	new_test_ext().execute_with(|| {
		let who = account(&pair("Second"));
		assert_noop!(
			Ledger::add_attester(RuntimeOrigin::signed(attester()), who.clone()),
			DispatchError::BadOrigin
		);
		assert_ok!(Ledger::add_attester(RuntimeOrigin::root(), who.clone()));
		assert_noop!(Ledger::add_attester(RuntimeOrigin::root(), who.clone()), Error::<Test>::AttesterExists);
		assert_ok!(Ledger::register_decision(RuntimeOrigin::signed(who.clone()), D1, [0; 32], 1));
		assert_ok!(Ledger::remove_attester(RuntimeOrigin::root(), who.clone()));
		assert_noop!(
			Ledger::register_decision(RuntimeOrigin::signed(who), [2; 16], [0; 32], 1),
			Error::<Test>::NotAttester
		);
	});
}

#[test]
fn decision_registers_once() {
	new_test_ext().execute_with(|| {
		register(D1);
		assert_eq!(Decisions::<Test>::get(D1).unwrap().category, 21);
		assert_noop!(Ledger::register_decision(origin(), D1, [0; 32], 1), Error::<Test>::DecisionExists);
	});
}

#[test]
fn vote_is_recorded_once_with_valid_signature() {
	new_test_ext().execute_with(|| {
		register(D1);
		let (voter, sig) = signed_vote("v1", D1, [7; 32], VoteKind::Direct);
		assert_ok!(Ledger::record_vote(origin(), D1, voter.clone(), [7; 32], VoteKind::Direct, sig.clone()));
		assert_eq!(Votes::<Test>::get(D1, &voter).unwrap().commitment, [7; 32]);
		assert_eq!(VoteCount::<Test>::get(D1), 1);
		System::assert_last_event(
			Event::VoteRecorded { decision_id: D1, voter: voter.clone(), commitment: [7; 32], kind: VoteKind::Direct }
				.into(),
		);
		assert_noop!(
			Ledger::record_vote(origin(), D1, voter, [7; 32], VoteKind::Direct, sig),
			Error::<Test>::AlreadyVoted
		);
	});
}

#[test]
fn vote_signature_must_match_every_field() {
	new_test_ext().execute_with(|| {
		register(D1);
		let (voter, sig) = signed_vote("v1", D1, [7; 32], VoteKind::Direct);
		assert_noop!(
			Ledger::record_vote(origin(), D1, voter.clone(), [8; 32], VoteKind::Direct, sig.clone()),
			Error::<Test>::BadVoterSignature
		);
		assert_noop!(
			Ledger::record_vote(origin(), D1, voter.clone(), [7; 32], VoteKind::Inferred, sig.clone()),
			Error::<Test>::BadVoterSignature
		);
		let other = account(&pair("v2"));
		assert_noop!(
			Ledger::record_vote(origin(), D1, other, [7; 32], VoteKind::Direct, sig),
			Error::<Test>::BadVoterSignature
		);
	});
}

#[test]
fn vote_needs_open_known_decision() {
	new_test_ext().execute_with(|| {
		let (voter, sig) = signed_vote("v1", D1, [7; 32], VoteKind::Direct);
		assert_noop!(
			Ledger::record_vote(origin(), D1, voter.clone(), [7; 32], VoteKind::Direct, sig.clone()),
			Error::<Test>::UnknownDecision
		);
		register(D1);
		assert_ok!(Ledger::publish_snapshot(origin(), D1, 0, [1; 32], [2; 32], true));
		assert_noop!(
			Ledger::record_vote(origin(), D1, voter, [7; 32], VoteKind::Direct, sig),
			Error::<Test>::DecisionClosed
		);
	});
}

#[test]
fn snapshots_are_sequential_and_final_closes() {
	new_test_ext().execute_with(|| {
		register(D1);
		assert_noop!(
			Ledger::publish_snapshot(origin(), D1, 1, [1; 32], [2; 32], false),
			Error::<Test>::SnapshotOutOfOrder
		);
		assert_ok!(Ledger::publish_snapshot(origin(), D1, 0, [1; 32], [2; 32], false));
		assert_ok!(Ledger::publish_snapshot(origin(), D1, 1, [3; 32], [4; 32], true));
		assert_eq!(LatestSnapshot::<Test>::get(D1), Some(1));
		assert!(Decisions::<Test>::get(D1).unwrap().closed);
		assert_noop!(
			Ledger::publish_snapshot(origin(), D1, 2, [5; 32], [6; 32], true),
			Error::<Test>::DecisionClosed
		);
	});
}

fn bounded<S: frame_support::traits::Get<u32>>(b: &[u8]) -> frame_support::BoundedVec<u8, S> {
	b.to_vec().try_into().unwrap()
}

#[test]
fn content_is_accepted_only_if_it_matches_the_hash() {
	new_test_ext().execute_with(|| {
		let content = br#"{"options":[{"id":"yes","text":"Yes"}],"question":"Q?"}"#;
		let hash = sp_io::hashing::blake2_256(content);
		assert_noop!(
			Ledger::publish_content(origin(), D1, bounded(content)),
			Error::<Test>::UnknownDecision
		);
		assert_ok!(Ledger::register_decision(origin(), D1, hash, 21));
		assert_noop!(
			Ledger::publish_content(RuntimeOrigin::signed(account(&pair("Eve"))), D1, bounded(content)),
			Error::<Test>::NotAttester
		);
		assert_noop!(
			Ledger::publish_content(origin(), D1, bounded(b"{\"question\":\"other\"}")),
			Error::<Test>::ContentMismatch
		);
		assert_ok!(Ledger::publish_content(origin(), D1, bounded(content)));
		assert_eq!(DecisionContent::<Test>::get(D1).unwrap().to_vec(), content.to_vec());
		System::assert_last_event(Event::ContentPublished { decision_id: D1 }.into());
		assert_noop!(
			Ledger::publish_content(origin(), D1, bounded(content)),
			Error::<Test>::AlreadyPublished
		);
	});
}

#[test]
fn totals_are_accepted_only_if_they_match_the_snapshot() {
	new_test_ext().execute_with(|| {
		register(D1);
		let totals = br#"{"no":1,"yes":2}"#;
		let hash = sp_io::hashing::blake2_256(totals);
		assert_noop!(
			Ledger::publish_totals(origin(), D1, 0, bounded(totals)),
			Error::<Test>::UnknownSnapshot
		);
		assert_ok!(Ledger::publish_snapshot(origin(), D1, 0, [1; 32], hash, true));
		assert_noop!(
			Ledger::publish_totals(origin(), D1, 0, bounded(br#"{"no":0,"yes":3}"#)),
			Error::<Test>::TotalsMismatch
		);
		// Allowed after the final snapshot closed the decision.
		assert_ok!(Ledger::publish_totals(origin(), D1, 0, bounded(totals)));
		assert_eq!(SnapshotTotals::<Test>::get(D1, 0).unwrap().to_vec(), totals.to_vec());
		System::assert_last_event(Event::TotalsPublished { decision_id: D1, seq: 0 }.into());
		assert_noop!(
			Ledger::publish_totals(origin(), D1, 0, bounded(totals)),
			Error::<Test>::AlreadyPublished
		);
	});
}

#[test]
fn trust_give_and_revoke_with_nonces() {
	new_test_ext().execute_with(|| {
		let trusted = account(&pair("Rep"));
		let (truster, sig0) = signed_trust("Citizen", &trusted, 21, TrustAction::Give, 0);
		assert_ok!(Ledger::record_trust(origin(), truster.clone(), trusted.clone(), 21, TrustAction::Give, 0, sig0.clone()));
		assert!(TrustEdges::<Test>::contains_key((truster.clone(), trusted.clone(), 21)));
		assert_eq!(TrustNonces::<Test>::get(&truster), 1);

		assert_noop!(
			Ledger::record_trust(origin(), truster.clone(), trusted.clone(), 21, TrustAction::Give, 0, sig0),
			Error::<Test>::BadTrustNonce
		);

		let (_, sig1) = signed_trust("Citizen", &trusted, 21, TrustAction::Give, 1);
		assert_noop!(
			Ledger::record_trust(origin(), truster.clone(), trusted.clone(), 21, TrustAction::Give, 1, sig1),
			Error::<Test>::AlreadyTrusted
		);

		let (_, sig1r) = signed_trust("Citizen", &trusted, 21, TrustAction::Revoke, 1);
		assert_ok!(Ledger::record_trust(origin(), truster.clone(), trusted.clone(), 21, TrustAction::Revoke, 1, sig1r));
		assert!(!TrustEdges::<Test>::contains_key((truster.clone(), trusted.clone(), 21)));

		let (_, sig2) = signed_trust("Citizen", &trusted, 21, TrustAction::Revoke, 2);
		assert_noop!(
			Ledger::record_trust(origin(), truster, trusted, 21, TrustAction::Revoke, 2, sig2),
			Error::<Test>::TrustNotFound
		);
	});
}

#[test]
fn trust_rejects_bad_signature_and_self_trust() {
	new_test_ext().execute_with(|| {
		let trusted = account(&pair("Rep"));
		let (truster, sig) = signed_trust("Citizen", &trusted, 21, TrustAction::Give, 0);
		assert_noop!(
			Ledger::record_trust(origin(), truster.clone(), trusted, 5, TrustAction::Give, 0, sig),
			Error::<Test>::BadTrusterSignature
		);
		let (_, self_sig) = signed_trust("Citizen", &truster, 21, TrustAction::Give, 0);
		assert_noop!(
			Ledger::record_trust(origin(), truster.clone(), truster, 21, TrustAction::Give, 0, self_sig),
			Error::<Test>::SelfTrust
		);
	});
}

#[test]
fn trust_received_counts_distinct_trusters() {
	new_test_ext().execute_with(|| {
		use crate::TrustScore;
		let rep = account(&pair("Rep"));
		let give = |seed: &str, category: u32, action: TrustAction, nonce: u32| {
			let (truster, sig) = signed_trust(seed, &rep, category, action, nonce);
			assert_ok!(Ledger::record_trust(origin(), truster, rep.clone(), category, action, nonce, sig));
		};
		give("a", 1, TrustAction::Give, 0);
		give("a", 2, TrustAction::Give, 1);
		assert_eq!(Ledger::trust_received(&rep), 1);
		give("b", 1, TrustAction::Give, 0);
		assert_eq!(Ledger::trust_received(&rep), 2);
		give("a", 1, TrustAction::Revoke, 2);
		assert_eq!(Ledger::trust_received(&rep), 2);
		give("a", 2, TrustAction::Revoke, 3);
		assert_eq!(Ledger::trust_received(&rep), 1);
	});
}
