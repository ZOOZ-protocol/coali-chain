use crate::{
	commitment_of, mock::*, parse_totals, DecisionContent, DecisionInfo, DecisionRules, DecisionRulesOf,
	Decisions, Electorate, Error, Event, LatestSnapshot, RecountOf, Reveal, SnapshotInfo, SnapshotProofs,
	SnapshotTotals, Snapshots, TrustAction, TrustEdges, TrustNonces, VoteCount, VoteKind, VoteLog, Votes,
	MERKLE_VERSION, Categories, CategoryInfo, CategoryKind, CategoryUse, TrustEdgeApp, TrustReceivedFor,
	TrustReceivedIn, DEFAULT_CATEGORIES,
};
use frame_support::{assert_noop, assert_ok, traits::Get, BoundedVec};
use sp_core::Pair;
use sp_runtime::{AccountId32, DispatchError, MultiSignature};

const D1: [u8; 16] = [1; 16];
const CONTENT: &[u8] = br#"{"options":[{"id":"no","text":"No"},{"id":"yes","text":"Yes"}],"question":"Q?"}"#;

fn origin() -> RuntimeOrigin {
	RuntimeOrigin::signed(attester())
}

fn bounded<S: Get<u32>>(b: &[u8]) -> BoundedVec<u8, S> {
	b.to_vec().try_into().unwrap()
}

/// End of voting of test decisions: two hours after the start.
const ENDS: u64 = START + 7_200_000;

fn register_with(id: [u8; 16], ends_at: u64, max_voters: u32) {
	assert_ok!(Ledger::register_decision(origin(), id, bounded(CONTENT), 21, ends_at, max_voters));
}

fn register(id: [u8; 16]) {
	register_with(id, ENDS, 1_000);
}

fn after_end() {
	set_now(ENDS);
}

/// A decision as registered before runtime 204: hash only, no rules, no vote log.
fn register_legacy(id: [u8; 16], content_hash: [u8; 32]) {
	Decisions::<Test>::insert(
		id,
		DecisionInfo { content_hash, category: 21, registered_by: attester(), registered_at: 1, closed: false },
	);
}

fn signed_vote(seed: &str, decision: [u8; 16], commitment: [u8; 32], kind: VoteKind) -> (AccountId32, MultiSignature) {
	let p = pair(seed);
	let voter = account(&p);
	let payload = Ledger::vote_payload(&decision, &voter, &commitment, kind);
	(voter, MultiSignature::Sr25519(p.sign(&payload)))
}

fn vote(seed: &str, decision: [u8; 16], commitment: [u8; 32]) -> sp_runtime::DispatchResult {
	let (voter, sig) = signed_vote(seed, decision, commitment, VoteKind::Direct);
	Ledger::record_vote(origin(), decision, voter, commitment, VoteKind::Direct, sig)
}

fn snapshot(id: [u8; 16], seq: u32, totals: &[u8], is_final: bool) -> sp_runtime::DispatchResult {
	Ledger::publish_snapshot(origin(), id, seq, [1; 32], bounded(totals), is_final)
}

fn signed_trust(
	truster_seed: &str,
	trusted: &AccountId32,
	category: u32,
	action: TrustAction,
	nonce: u32,
) -> (AccountId32, MultiSignature) {
	let p = pair(truster_seed);
	let truster = account(&p);
	let payload = Ledger::trust_payload(&truster, trusted, category, action, nonce);
	(truster, MultiSignature::Sr25519(p.sign(&payload)))
}

fn second_attester() -> AccountId32 {
	let who = account(&pair("Second"));
	assert_ok!(Ledger::add_attester(RuntimeOrigin::root(), who.clone()));
	who
}

#[test]
fn only_attesters_can_write() {
	new_test_ext().execute_with(|| {
		let stranger = RuntimeOrigin::signed(account(&pair("Stranger")));
		assert_noop!(
			Ledger::register_decision(stranger, D1, bounded(CONTENT), 1, ENDS, 10),
			Error::<Test>::NotAttester
		);
	});
}

#[test]
fn admin_manages_attesters_and_removal_is_reported() {
	new_test_ext().execute_with(|| {
		let who = account(&pair("Second"));
		assert_noop!(
			Ledger::add_attester(RuntimeOrigin::signed(attester()), who.clone()),
			DispatchError::BadOrigin
		);
		assert_ok!(Ledger::add_attester(RuntimeOrigin::root(), who.clone()));
		assert_noop!(Ledger::add_attester(RuntimeOrigin::root(), who.clone()), Error::<Test>::AttesterExists);
		Electorate::<Test>::insert(&who, 10);
		assert_ok!(Ledger::register_decision(RuntimeOrigin::signed(who.clone()), D1, bounded(CONTENT), 1, ENDS, 10));
		assert_ok!(Ledger::remove_attester(RuntimeOrigin::root(), who.clone()));
		assert_eq!(Removed::get(), vec![who.clone()]);
		assert_noop!(
			Ledger::register_decision(RuntimeOrigin::signed(who), [2; 16], bounded(CONTENT), 1, ENDS, 10),
			Error::<Test>::NotAttester
		);
	});
}

#[test]
fn decision_registers_once_with_content_and_rules() {
	new_test_ext().execute_with(|| {
		register_with(D1, ENDS, 42);
		let d = Decisions::<Test>::get(D1).unwrap();
		assert_eq!(d.category, 21);
		assert_eq!(d.content_hash, sp_io::hashing::blake2_256(CONTENT));
		assert_eq!(DecisionContent::<Test>::get(D1).unwrap().to_vec(), CONTENT.to_vec());
		assert_eq!(DecisionRulesOf::<Test>::get(D1), Some(DecisionRules { ends_at: Some(ENDS), max_voters: 42 }));
		assert_eq!(VoteLog::<Test>::get(D1), Some([0; 32]));
		System::assert_has_event(Event::DecisionRulesSet { decision_id: D1, ends_at: Some(ENDS), max_voters: 42 }.into());
		assert_noop!(
			Ledger::register_decision(origin(), D1, bounded(CONTENT), 1, ENDS, 10),
			Error::<Test>::DecisionExists
		);
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
		assert_noop!(vote("v1", D1, [7; 32]), Error::<Test>::UnknownDecision);
		register(D1);
		after_end();
		assert_ok!(snapshot(D1, 0, b"{}", true));
		assert_noop!(vote("v1", D1, [7; 32]), Error::<Test>::DecisionClosed);
	});
}

#[test]
fn only_the_registrar_writes_to_its_decision() {
	new_test_ext().execute_with(|| {
		register(D1);
		let rival = RuntimeOrigin::signed(second_attester());
		let (voter, sig) = signed_vote("v1", D1, [7; 32], VoteKind::Direct);
		assert_noop!(
			Ledger::record_vote(rival.clone(), D1, voter, [7; 32], VoteKind::Direct, sig),
			Error::<Test>::NotRegistrar
		);
		assert_noop!(
			Ledger::publish_snapshot(rival.clone(), D1, 0, [0; 32], bounded(b"{}"), true),
			Error::<Test>::NotRegistrar
		);
		assert_noop!(Ledger::raise_max_voters(rival, D1, 5_000), Error::<Test>::NotRegistrar);
	});
}

#[test]
fn votes_are_capped_at_the_declared_eligible_voters() {
	new_test_ext().execute_with(|| {
		register_with(D1, ENDS, 2);
		assert_ok!(vote("v1", D1, [1; 32]));
		assert_ok!(vote("v2", D1, [2; 32]));
		assert_noop!(vote("v3", D1, [3; 32]), Error::<Test>::TooManyVotes);
		assert_noop!(Ledger::raise_max_voters(origin(), D1, 1), Error::<Test>::CapLowered);
		assert_ok!(Ledger::raise_max_voters(origin(), D1, 3));
		System::assert_last_event(Event::DecisionRulesSet { decision_id: D1, ends_at: Some(ENDS), max_voters: 3 }.into());
		assert_ok!(vote("v3", D1, [3; 32]));
	});
}

#[test]
fn the_vote_log_chains_every_vote_in_order() {
	new_test_ext().execute_with(|| {
		register(D1);
		let (a, _) = signed_vote("v1", D1, [1; 32], VoteKind::Direct);
		let (b, _) = signed_vote("v2", D1, [2; 32], VoteKind::Direct);
		assert_ok!(vote("v1", D1, [1; 32]));
		assert_ok!(vote("v2", D1, [2; 32]));
		let expected = Ledger::next_vote_log(&Ledger::next_vote_log(&[0; 32], &a, &[1; 32], VoteKind::Direct), &b, &[2; 32], VoteKind::Direct);
		assert_eq!(VoteLog::<Test>::get(D1), Some(expected));
	});
}

#[test]
fn snapshots_are_sequential_and_final_closes() {
	new_test_ext().execute_with(|| {
		register(D1);
		assert_noop!(snapshot(D1, 1, b"{}", false), Error::<Test>::SnapshotOutOfOrder);
		assert_ok!(snapshot(D1, 0, b"{}", false));
		assert_ok!(vote("v1", D1, [1; 32]));
		after_end();
		assert_ok!(snapshot(D1, 1, br#"{"yes":1}"#, true));
		assert_eq!(LatestSnapshot::<Test>::get(D1), Some(1));
		assert!(Decisions::<Test>::get(D1).unwrap().closed);
		assert_noop!(snapshot(D1, 2, br#"{"yes":1}"#, true), Error::<Test>::DecisionClosed);
	});
}

#[test]
fn snapshot_totals_must_add_up_to_the_votes_on_chain() {
	new_test_ext().execute_with(|| {
		register(D1);
		assert_ok!(vote("v1", D1, [1; 32]));
		assert_ok!(vote("v2", D1, [2; 32]));
		assert_noop!(snapshot(D1, 0, br#"{"no":0,"yes":1000000}"#, false), Error::<Test>::TotalsNotVoteCount);
		assert_noop!(snapshot(D1, 0, br#"{"yes":1}"#, false), Error::<Test>::TotalsNotVoteCount);
		assert_noop!(snapshot(D1, 0, br#"{"yes": 2}"#, false), Error::<Test>::BadTotals);
		let totals = br#"{"no":2}"#;
		assert_ok!(snapshot(D1, 0, totals, false));
		let info = Snapshots::<Test>::get(D1, 0).unwrap();
		assert_eq!(info.totals_hash, sp_io::hashing::blake2_256(totals));
		assert_eq!(SnapshotTotals::<Test>::get(D1, 0).unwrap().to_vec(), totals.to_vec());
		let proof = SnapshotProofs::<Test>::get(D1, 0).unwrap();
		assert_eq!(proof.vote_count, 2);
		assert_eq!(proof.vote_log, VoteLog::<Test>::get(D1));
		assert_eq!(proof.merkle_version, MERKLE_VERSION);
	});
}

#[test]
fn final_snapshot_waits_for_the_end_of_voting() {
	new_test_ext().execute_with(|| {
		register_with(D1, ENDS, 10);
		assert_ok!(snapshot(D1, 0, b"{}", false));
		assert_noop!(snapshot(D1, 1, b"{}", true), Error::<Test>::VotingNotEnded);
		after_end();
		assert_ok!(snapshot(D1, 1, b"{}", true));
	});
}

#[test]
fn legacy_content_is_accepted_only_if_it_matches_the_hash() {
	new_test_ext().execute_with(|| {
		let hash = sp_io::hashing::blake2_256(CONTENT);
		assert_noop!(Ledger::publish_content(origin(), D1, bounded(CONTENT)), Error::<Test>::UnknownDecision);
		register_legacy(D1, hash);
		let rival = second_attester();
		assert_noop!(
			Ledger::publish_content(RuntimeOrigin::signed(account(&pair("Eve"))), D1, bounded(CONTENT)),
			Error::<Test>::NotAttester
		);
		assert_noop!(
			Ledger::publish_content(RuntimeOrigin::signed(rival), D1, bounded(CONTENT)),
			Error::<Test>::NotRegistrar
		);
		assert_noop!(
			Ledger::publish_content(origin(), D1, bounded(b"{\"question\":\"other\"}")),
			Error::<Test>::ContentMismatch
		);
		assert_ok!(Ledger::publish_content(origin(), D1, bounded(CONTENT)));
		assert_eq!(DecisionContent::<Test>::get(D1).unwrap().to_vec(), CONTENT.to_vec());
		assert_noop!(Ledger::publish_content(origin(), D1, bounded(CONTENT)), Error::<Test>::AlreadyPublished);
		// A decision registered from 204 already carries its content.
		register([2; 16]);
		assert_noop!(Ledger::publish_content(origin(), [2; 16], bounded(CONTENT)), Error::<Test>::AlreadyPublished);
	});
}

#[test]
fn legacy_totals_are_accepted_only_if_they_match_the_snapshot() {
	new_test_ext().execute_with(|| {
		register_legacy(D1, [9; 32]);
		let totals = br#"{"no":1,"yes":2}"#;
		assert_noop!(Ledger::publish_totals(origin(), D1, 0, bounded(totals)), Error::<Test>::UnknownSnapshot);
		Snapshots::<Test>::insert(
			D1,
			0,
			SnapshotInfo { merkle_root: [1; 32], totals_hash: sp_io::hashing::blake2_256(totals), is_final: true, published_at: 1 },
		);
		assert_noop!(
			Ledger::publish_totals(origin(), D1, 0, bounded(br#"{"no":0,"yes":3}"#)),
			Error::<Test>::TotalsMismatch
		);
		assert_ok!(Ledger::publish_totals(origin(), D1, 0, bounded(totals)));
		assert_eq!(SnapshotTotals::<Test>::get(D1, 0).unwrap().to_vec(), totals.to_vec());
		assert_noop!(Ledger::publish_totals(origin(), D1, 0, bounded(totals)), Error::<Test>::AlreadyPublished);
	});
}

#[test]
fn legacy_decisions_need_rules_before_votes_or_closing() {
	new_test_ext().execute_with(|| {
		register_legacy(D1, [9; 32]);
		assert_noop!(vote("v1", D1, [1; 32]), Error::<Test>::NoRules);
		assert_noop!(snapshot(D1, 0, b"{}", true), Error::<Test>::NoRules);
		assert_noop!(Ledger::raise_max_voters(origin(), D1, 10), Error::<Test>::NoRules);
		// Rules obey the same constraints as a new decision, and are set once.
		assert_noop!(Ledger::set_rules(origin(), D1, START + 60_000, 10), Error::<Test>::VotingTooShort);
		assert_noop!(Ledger::set_rules(origin(), D1, ENDS, 5_000), Error::<Test>::AboveElectorate);
		assert_ok!(Ledger::set_rules(origin(), D1, ENDS, 10));
		assert_noop!(Ledger::set_rules(origin(), D1, ENDS, 10), Error::<Test>::RulesExist);
		assert_ok!(vote("v1", D1, [1; 32]));
		assert_eq!(VoteLog::<Test>::get(D1), None);
		assert_noop!(snapshot(D1, 0, br#"{"yes":1}"#, true), Error::<Test>::VotingNotEnded);
		after_end();
		assert_ok!(snapshot(D1, 0, br#"{"yes":1}"#, true));
		assert_eq!(SnapshotProofs::<Test>::get(D1, 0).unwrap().vote_log, None);
	});
}

#[test]
fn decisions_need_a_real_voting_period_and_an_electorate() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			Ledger::register_decision(origin(), D1, bounded(CONTENT), 21, START + 60_000, 10),
			Error::<Test>::VotingTooShort
		);
		assert_noop!(
			Ledger::register_decision(origin(), D1, bounded(CONTENT), 21, ENDS, u32::MAX),
			Error::<Test>::AboveElectorate
		);
		register_with(D1, ENDS, 1_000);
		assert_noop!(Ledger::raise_max_voters(origin(), D1, 1_001), Error::<Test>::AboveElectorate);
		// Only an identity attester publishes the electorate.
		assert_noop!(Ledger::set_electorate(origin(), attester(), 5_000), DispatchError::BadOrigin);
		assert_ok!(Ledger::set_electorate(RuntimeOrigin::signed(identity_attester()), attester(), 5_000));
		assert_ok!(Ledger::raise_max_voters(origin(), D1, 5_000));
	});
}

#[test]
fn late_votes_and_cap_changes_are_refused() {
	new_test_ext().execute_with(|| {
		register_with(D1, ENDS, 10);
		after_end();
		assert_noop!(Ledger::raise_max_voters(origin(), D1, 20), Error::<Test>::VotingEnded);
		// Votes deduced from boards become official at the end: a bounded grace period.
		assert_ok!(vote("v1", D1, [1; 32]));
		set_now(ENDS + 86_400_000 + 1);
		assert_noop!(vote("v2", D1, [2; 32]), Error::<Test>::VotingEnded);
	});
}

fn reveal(seed: &str, option: &str, salt: u8) -> Reveal<AccountId32> {
	Reveal { voter: account(&pair(seed)), option: bounded(option.as_bytes()), salt: [b'0' + salt; 64] }
}

fn vote_for(seed: &str, option: &str, salt: u8) {
	assert_ok!(vote(seed, D1, commitment_of(&D1, option.as_bytes(), &[b'0' + salt; 64])));
}

#[test]
fn the_chain_recounts_revealed_votes() {
	new_test_ext().execute_with(|| {
		register(D1);
		vote_for("v1", "no", 1);
		vote_for("v2", "no", 2);
		after_end();
		assert_noop!(Ledger::reveal_votes(origin(), D1, vec![reveal("v1", "no", 1)]), Error::<Test>::NotClosed);
		assert_ok!(snapshot(D1, 0, br#"{"no":2}"#, true));
		assert_noop!(Ledger::reveal_votes(origin(), D1, vec![reveal("v1", "yes", 1)]), Error::<Test>::RevealMismatch);
		assert_ok!(Ledger::reveal_votes(origin(), D1, vec![reveal("v1", "no", 1)]));
		assert_noop!(Ledger::reveal_votes(origin(), D1, vec![reveal("v1", "no", 1)]), Error::<Test>::AlreadyRevealed);
		assert_eq!(RecountOf::<Test>::get(D1), None);
		assert_ok!(Ledger::reveal_votes(origin(), D1, vec![reveal("v2", "no", 2)]));
		assert_eq!(RecountOf::<Test>::get(D1).map(|r| (r.matches, r.votes)), Some((true, 2)));
	});
}

#[test]
fn redistributed_totals_are_caught_by_the_recount() {
	new_test_ext().execute_with(|| {
		register(D1);
		vote_for("v1", "no", 1);
		vote_for("v2", "no", 2);
		after_end();
		// Two "no" votes published as two "yes": the sum matches, the recount does not.
		assert_ok!(snapshot(D1, 0, br#"{"yes":2}"#, true));
		assert_ok!(Ledger::reveal_votes(origin(), D1, vec![reveal("v1", "no", 1), reveal("v2", "no", 2)]));
		assert_eq!(RecountOf::<Test>::get(D1).map(|r| r.matches), Some(false));
		System::assert_last_event(Event::ResultRecounted { decision_id: D1, votes: 2, matches: false }.into());
	});
}

#[test]
fn commitment_matches_the_app_format() {
	// Same string as the relayer: "coali/commit/v1|<uuid>|<option>|<salt hex>".
	let id = [0x3f, 0x2a, 0x9c, 0x1e, 0x7b, 0x4d, 0x4e, 0x11, 0x9a, 0x2b, 0x5c, 0x6d, 0x7e, 0x8f, 0x9a, 0x0b];
	let salt = [b'a'; 64];
	let expected = sp_io::hashing::blake2_256(
		format!("coali/commit/v1|3f2a9c1e-7b4d-4e11-9a2b-5c6d7e8f9a0b|yes|{}", "a".repeat(64)).as_bytes(),
	);
	assert_eq!(commitment_of(&id, b"yes", &salt), expected);
}

#[test]
fn totals_parser_accepts_only_canonical_tallies() {
	assert_eq!(parse_totals(b"{}"), Some(0));
	assert_eq!(parse_totals(br#"{"no":1,"yes":2}"#), Some(3));
	assert_eq!(parse_totals(br#"{"option-0":10,"option-1":0}"#), Some(10));
	for bad in [
		&br#"{"yes":2,"no":1}"#[..],
		br#"{"no":1,"no":2}"#,
		br#"{"no":01}"#,
		br#"{"no":-1}"#,
		br#"{"no":1.5}"#,
		br#"{"n\"o":1}"#,
		br#"{"":1}"#,
		br#"{"no":1}x"#,
		br#"{"no":1,}"#,
		br#"{ "no":1}"#,
		b"{",
		b"",
		br#"{"no":99999999999999999999999}"#,
	] {
		assert_eq!(parse_totals(bad), None, "{}", core::str::from_utf8(bad).unwrap_or("?"));
	}
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
		assert_eq!(Ledger::trusted_by(&account(&pair("a"))), vec![rep.clone()]);
		give("b", 1, TrustAction::Give, 0);
		assert_eq!(Ledger::trust_received(&rep), 2);
		assert_eq!(Ledger::trusters_of(&rep).len(), 2);
		give("a", 1, TrustAction::Revoke, 2);
		assert_eq!(Ledger::trust_received(&rep), 2);
		give("a", 2, TrustAction::Revoke, 3);
		assert_eq!(Ledger::trust_received(&rep), 1);
		assert!(Ledger::trusted_by(&account(&pair("a"))).is_empty());
	});
}

fn seed_categories() {
	use frame_support::traits::UncheckedOnRuntimeUpgrade;
	crate::migrations::InnerMigrateV1ToV2::<Test>::on_runtime_upgrade();
}

/// `truster` gives (or revokes) trust to `trusted` in `category`, through `app`.
fn trust_via(app: &AccountId32, truster: &str, trusted: &AccountId32, category: u32, action: TrustAction) {
	let nonce = TrustNonces::<Test>::get(account(&pair(truster)));
	let (who, sig) = signed_trust(truster, trusted, category, action, nonce);
	assert_ok!(Ledger::record_trust(RuntimeOrigin::signed(app.clone()), who, trusted.clone(), category, action, nonce, sig));
}

const ECONOMY: u32 = 1;
const EDUCATION: u32 = 3;
const JUSTICE: u32 = 5;
const POLITICS: u32 = 22;
const PRIME_MINISTER: u32 = 24;

#[test]
fn trust_is_counted_per_domain_and_in_all() {
	new_test_ext().execute_with(|| {
		use crate::TrustScore;
		seed_categories();
		let rep = account(&pair("Rep"));
		// 3 people trust Rep in economy, 5 in education; the 3 are among the 5.
		for i in 0..5 {
			let who = format!("p{i}");
			trust_via(&attester(), &who, &rep, EDUCATION, TrustAction::Give);
			if i < 3 {
				trust_via(&attester(), &who, &rep, ECONOMY, TrustAction::Give);
			}
		}
		assert_eq!(TrustReceivedIn::<Test>::get(&rep, ECONOMY), 3);
		assert_eq!(TrustReceivedIn::<Test>::get(&rep, EDUCATION), 5);
		assert_eq!(Ledger::trust_received(&rep), 5);
		assert_eq!(CategoryUse::<Test>::get(ECONOMY), 3);

		// A domain counts across apps: the same person through another app is not counted twice
		// (the edge exists), a new person is.
		let other = second_attester();
		trust_via(&other, "p9", &rep, ECONOMY, TrustAction::Give);
		assert_eq!(TrustReceivedIn::<Test>::get(&rep, ECONOMY), 4);

		trust_via(&attester(), "p0", &rep, ECONOMY, TrustAction::Revoke);
		assert_eq!(TrustReceivedIn::<Test>::get(&rep, ECONOMY), 3);
		assert_eq!(Ledger::trust_received(&rep), 6);
		for i in 1..3 {
			trust_via(&attester(), &format!("p{i}"), &rep, ECONOMY, TrustAction::Revoke);
		}
		trust_via(&other, "p9", &rep, ECONOMY, TrustAction::Revoke);
		assert!(!TrustReceivedIn::<Test>::contains_key(&rep, ECONOMY));
		assert!(!CategoryUse::<Test>::contains_key(ECONOMY));
	});
}

#[test]
fn trust_in_a_position_is_counted_per_app() {
	new_test_ext().execute_with(|| {
		seed_categories();
		let rep = account(&pair("Rep"));
		let israel = attester();
		let france = second_attester();
		trust_via(&israel, "a", &rep, PRIME_MINISTER, TrustAction::Give);
		trust_via(&israel, "b", &rep, PRIME_MINISTER, TrustAction::Give);
		trust_via(&france, "c", &rep, PRIME_MINISTER, TrustAction::Give);
		assert_eq!(TrustReceivedFor::<Test>::get((&rep, &israel, PRIME_MINISTER)), 2);
		assert_eq!(TrustReceivedFor::<Test>::get((&rep, &france, PRIME_MINISTER)), 1);
		// Not a domain count, not the domain of the position either.
		assert_eq!(TrustReceivedIn::<Test>::get(&rep, PRIME_MINISTER), 0);
		assert_eq!(TrustReceivedIn::<Test>::get(&rep, POLITICS), 0);

		// Revoked through another app, the trust leaves the count of the app that recorded it.
		trust_via(&france, "a", &rep, PRIME_MINISTER, TrustAction::Revoke);
		assert_eq!(TrustReceivedFor::<Test>::get((&rep, &israel, PRIME_MINISTER)), 1);
		assert_eq!(TrustReceivedFor::<Test>::get((&rep, &france, PRIME_MINISTER)), 1);
		assert!(!TrustEdgeApp::<Test>::contains_key((account(&pair("a")), &rep, PRIME_MINISTER)));
	});
}

#[test]
fn the_admin_keeps_the_category_registry() {
	new_test_ext().execute_with(|| {
		seed_categories();
		let key = |k: &[u8]| BoundedVec::truncate_from(k.to_vec());
		assert_eq!(Categories::<Test>::get(PRIME_MINISTER).map(|c| (c.kind, c.domain)), Some((CategoryKind::Position, Some(POLITICS))));
		assert_eq!(Categories::<Test>::get(JUSTICE).map(|c| c.kind), Some(CategoryKind::Domain));
		assert_eq!(Categories::<Test>::iter().count(), DEFAULT_CATEGORIES.len());

		assert_noop!(
			Ledger::set_category(origin(), 40, CategoryKind::Domain, None, key(b"defense")),
			DispatchError::BadOrigin
		);
		let root = || RuntimeOrigin::root();
		assert_noop!(Ledger::set_category(root(), 40, CategoryKind::Position, None, key(b"mayor")), Error::<Test>::BadDomain);
		assert_noop!(
			Ledger::set_category(root(), 40, CategoryKind::Position, Some(PRIME_MINISTER), key(b"mayor")),
			Error::<Test>::BadDomain
		);
		assert_noop!(Ledger::set_category(root(), 40, CategoryKind::Domain, Some(POLITICS), key(b"mayor")), Error::<Test>::BadDomain);
		assert_ok!(Ledger::set_category(root(), 40, CategoryKind::Position, Some(POLITICS), key(b"mayor")));

		// A category in use keeps its kind (its counts would be wrong), but can be renamed.
		let rep = account(&pair("Rep"));
		trust_via(&attester(), "a", &rep, ECONOMY, TrustAction::Give);
		assert_noop!(
			Ledger::set_category(root(), ECONOMY, CategoryKind::Position, Some(POLITICS), key(b"economy")),
			Error::<Test>::CategoryInUse
		);
		assert_ok!(Ledger::set_category(root(), ECONOMY, CategoryKind::Domain, None, key(b"economics")));
	});
}

#[test]
fn migration_counts_existing_trusts_and_keeps_the_registry() {
	new_test_ext().execute_with(|| {
		use frame_support::traits::{GetStorageVersion, OnRuntimeUpgrade, StorageVersion};
		let rep = account(&pair("Rep"));
		trust_via(&attester(), "a", &rep, ECONOMY, TrustAction::Give);
		trust_via(&attester(), "b", &rep, ECONOMY, TrustAction::Give);
		trust_via(&attester(), "a", &rep, PRIME_MINISTER, TrustAction::Give);
		// Back to the runtime 206 layout: edges only, no registry and no counts.
		let _ = TrustReceivedIn::<Test>::clear(u32::MAX, None);
		let _ = TrustReceivedFor::<Test>::clear(u32::MAX, None);
		let _ = TrustEdgeApp::<Test>::clear(u32::MAX, None);
		let _ = CategoryUse::<Test>::clear(u32::MAX, None);
		let _ = Categories::<Test>::clear(u32::MAX, None);
		Categories::<Test>::insert(ECONOMY, CategoryInfo { kind: CategoryKind::Domain, domain: None, key: BoundedVec::truncate_from(b"economics".to_vec()) });
		StorageVersion::new(1).put::<Ledger>();

		crate::migrations::MigrateV1ToV2::<Test>::on_runtime_upgrade();

		assert_eq!(Ledger::on_chain_storage_version(), 2);
		assert_eq!(Categories::<Test>::get(ECONOMY).unwrap().key.to_vec(), b"economics".to_vec());
		assert_eq!(Categories::<Test>::iter().count(), DEFAULT_CATEGORIES.len());
		assert_eq!(TrustReceivedIn::<Test>::get(&rep, ECONOMY), 2);
		// One attester: the position trust is that app's.
		assert_eq!(TrustReceivedFor::<Test>::get((&rep, &attester(), PRIME_MINISTER)), 1);
		assert_eq!(CategoryUse::<Test>::get(PRIME_MINISTER), 1);
		trust_via(&attester(), "a", &rep, PRIME_MINISTER, TrustAction::Revoke);
		assert_eq!(TrustReceivedFor::<Test>::get((&rep, &attester(), PRIME_MINISTER)), 0);
		// Run again: nothing changes.
		crate::migrations::MigrateV1ToV2::<Test>::on_runtime_upgrade();
		assert_eq!(TrustReceivedIn::<Test>::get(&rep, ECONOMY), 2);
	});
}

#[test]
fn trust_needs_a_registered_category_but_old_ones_can_be_revoked() {
	new_test_ext().execute_with(|| {
		let rep = account(&pair("Rep"));
		let nonce = TrustNonces::<Test>::get(account(&pair("a")));
		let (who, sig) = signed_trust("a", &rep, 99, TrustAction::Give, nonce);
		assert_noop!(
			Ledger::record_trust(origin(), who.clone(), rep.clone(), 99, TrustAction::Give, nonce, sig),
			Error::<Test>::UnknownCategory
		);
		// A trust recorded in id 99 before runtime 208 (counted like a domain) is revoked as usual.
		TrustEdges::<Test>::insert((who.clone(), rep.clone(), 99u32), 1u64);
		TrustReceivedIn::<Test>::insert(&rep, 99u32, 1u32);
		CategoryUse::<Test>::insert(99u32, 1u32);
		trust_via(&attester(), "a", &rep, 99, TrustAction::Revoke);
		assert!(!TrustReceivedIn::<Test>::contains_key(&rep, 99u32));
		assert!(!CategoryUse::<Test>::contains_key(99u32));
	});
}
