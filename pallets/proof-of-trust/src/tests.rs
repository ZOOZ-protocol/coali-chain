use crate::{mock::*, Candidates, Error, IdentityAttesters, Offline, Strikes, Verified, VerifiedTrust};
use frame_support::{assert_noop, assert_ok, traits::OnRuntimeUpgrade};
use pallet_authorship::EventHandler;
use pallet_session::SessionManager;
use sp_runtime::{DispatchError, Percent};

fn attester() -> RuntimeOrigin {
	RuntimeOrigin::signed(ATTESTER)
}

/// Person `trust` (trust address) runs validator `validator`.
fn enroll(trust: u64, validator: u64) {
	assert_ok!(ProofOfTrust::attest_identity(attester(), trust, true));
	assert_ok!(ProofOfTrust::register_candidate(attester(), trust, validator));
}

/// `n` verified people (addresses `base`, `base + 1`, ...) trust `trusted`.
fn verified_trusters(base: u64, n: u64, trusted: u64) {
	for t in base..base + n {
		assert_ok!(ProofOfTrust::attest_identity(attester(), t, true));
		trust(t, trusted);
	}
}

fn planned() -> Vec<u64> {
	ProofOfTrust::new_session(1).unwrap_or_default()
}

/// Founders' share and newcomer limit for tests about candidates (the default 67% leaves two
/// founders no candidate seat).
fn limits(founder_share: u8, max_new: u32) {
	assert_ok!(ProofOfTrust::set_selection_limits(RuntimeOrigin::root(), Percent::from_percent(founder_share), max_new));
}

fn no_founder_share() {
	assert_ok!(ProofOfTrust::set_selection_limits(RuntimeOrigin::root(), Percent::zero(), 10));
}

#[test]
fn founders_alone_bootstrap_the_network() {
	new_test_ext().execute_with(|| {
		assert_eq!(planned(), FOUNDERS.to_vec());
	});
}

#[test]
fn only_identity_attesters_vouch_and_register() {
	new_test_ext().execute_with(|| {
		assert_noop!(ProofOfTrust::attest_identity(RuntimeOrigin::signed(7), 10, true), Error::<Test>::NotIdentityAttester);
		assert_noop!(ProofOfTrust::register_candidate(attester(), 10, 20), Error::<Test>::NotVerified);
		enroll(10, 20);
		assert_noop!(ProofOfTrust::register_candidate(attester(), 10, 21), Error::<Test>::PersonHasValidator);
		assert_ok!(ProofOfTrust::attest_identity(attester(), 11, true));
		assert_noop!(ProofOfTrust::register_candidate(attester(), 11, 20), Error::<Test>::AlreadyCandidate);
		assert_noop!(ProofOfTrust::register_candidate(attester(), 11, 1), Error::<Test>::AlreadyFounder);
		assert_noop!(ProofOfTrust::add_identity_attester(attester(), 7), DispatchError::BadOrigin);
	});
}

#[test]
fn only_trust_from_verified_people_counts() {
	new_test_ext().execute_with(|| {
		limits(0, 10);
		enroll(10, 20);
		// Sybil trust from addresses nobody vouched for.
		for sybil in 500..510 {
			trust(sybil, 10);
		}
		assert_eq!(ProofOfTrust::score(&10), 0);
		assert_eq!(planned(), vec![1, 2]);

		// Verifying a truster after it trusted counts it; before, too.
		assert_ok!(ProofOfTrust::attest_identity(attester(), 500, true));
		assert_eq!(ProofOfTrust::score(&10), 1);
		verified_trusters(600, 1, 10);
		assert_eq!(ProofOfTrust::score(&10), 2);
		assert_eq!(planned(), vec![1, 2, 20]);

		assert_ok!(ProofOfTrust::set_min_trust(RuntimeOrigin::root(), 3));
		assert_eq!(planned(), vec![1, 2]);
		verified_trusters(700, 1, 10);
		assert_eq!(planned(), vec![1, 2, 20]);

		untrust(700, 10);
		assert_ok!(ProofOfTrust::attest_identity(attester(), 600, false));
		assert_eq!(ProofOfTrust::score(&10), 1);
		assert_eq!(planned(), vec![1, 2]);
	});
}

#[test]
fn removing_an_identity_attester_withdraws_its_people() {
	new_test_ext().execute_with(|| {
		limits(0, 10);
		let rogue = 101;
		assert_ok!(ProofOfTrust::add_identity_attester(RuntimeOrigin::root(), rogue));
		assert_ok!(ProofOfTrust::attest_identity(RuntimeOrigin::signed(rogue), 10, true));
		assert_ok!(ProofOfTrust::register_candidate(RuntimeOrigin::signed(rogue), 10, 20));
		for t in 800..803 {
			assert_ok!(ProofOfTrust::attest_identity(RuntimeOrigin::signed(rogue), t, true));
			trust(t, 10);
		}
		assert_eq!(planned(), vec![1, 2, 20]);

		assert_ok!(ProofOfTrust::remove_identity_attester(RuntimeOrigin::root(), rogue));
		assert!(!IdentityAttesters::<Test>::contains_key(rogue));
		assert!(!Verified::<Test>::contains_key(10));
		assert!(!Candidates::<Test>::contains_key(20));
		assert_eq!(VerifiedTrust::<Test>::get(10), 0);
		assert_eq!(planned(), vec![1, 2]);
	});
}

#[test]
fn removing_a_ledger_attester_also_withdraws_its_people() {
	new_test_ext().execute_with(|| {
		limits(34, 2);
		use pallet_coali_ledger::OnAttesterRemoved;
		enroll(10, 20);
		verified_trusters(600, 1, 10);
		ProofOfTrust::attester_removed(&ATTESTER);
		assert!(Candidates::<Test>::iter().next().is_none());
		assert_eq!(planned(), vec![1, 2]);
	});
}

#[test]
fn founders_keep_a_blocking_share_and_newcomers_come_in_slowly() {
	new_test_ext().execute_with(|| {
		for (i, score) in [(0u64, 1u64), (1, 5), (2, 3), (3, 4), (4, 2)] {
			enroll(10 + i, 20 + i);
			verified_trusters(1000 + 100 * i, score, 10 + i);
		}
		// By default (67%) two founders keep every seat.
		assert_eq!(planned(), vec![1, 2]);
		// With a 34% share they leave 3 seats; 2 newcomers per session.
		limits(34, 2);
		assert_eq!(planned(), vec![1, 2, 21, 23]);
		assert_eq!(planned(), vec![1, 2, 21, 23, 22]);
		assert_eq!(planned(), vec![1, 2, 21, 23, 22]);
		// Lifting the limits lets the rest in.
		no_founder_share();
		assert_eq!(planned(), vec![1, 2, 21, 23, 22, 24, 20]);
	});
}

#[test]
fn candidates_left_out_for_lack_of_room_are_not_struck() {
	new_test_ext().execute_with(|| {
		limits(34, 2);
		for i in 0..5u64 {
			enroll(10 + i, 20 + i);
			verified_trusters(1000 + 100 * i, 5 - i, 10 + i);
		}
		assert_eq!(planned(), vec![1, 2, 20, 21]);
		System::set_block_number(100);
		for v in [1, 2, 20, 21] {
			ProofOfTrust::note_author(v);
		}
		System::set_block_number(120);
		planned();
		assert!(Strikes::<Test>::iter().next().is_none());
	});
}

#[test]
fn losing_identity_or_leaving_removes_the_candidate() {
	new_test_ext().execute_with(|| {
		limits(34, 2);
		enroll(10, 20);
		enroll(11, 21);
		verified_trusters(600, 1, 10);
		verified_trusters(700, 1, 11);
		assert_ok!(ProofOfTrust::attest_identity(attester(), 10, false));
		assert!(!Candidates::<Test>::contains_key(20));
		assert_ok!(ProofOfTrust::withdraw(RuntimeOrigin::signed(21)));
		assert_eq!(planned(), vec![1, 2]);
		enroll(11, 25);
	});
}

#[test]
fn offline_validators_wait_longer_each_time_then_are_removed() {
	new_test_ext().execute_with(|| {
		limits(34, 2);
		enroll(10, 20);
		verified_trusters(600, 1, 10);
		assert_eq!(planned(), vec![1, 2, 20]);
		let keep_founders_alive = |n: u64| {
			System::set_block_number(n);
			ProofOfTrust::note_author(1);
			ProofOfTrust::note_author(2);
		};

		// Strike 1: cooldown of OfflineAfter (30) blocks.
		keep_founders_alive(40);
		assert_eq!(planned(), vec![1, 2]);
		assert!(Offline::<Test>::contains_key(20));
		assert_eq!(Strikes::<Test>::get(20).unwrap().0, 1);
		assert_noop!(ProofOfTrust::go_online(RuntimeOrigin::signed(20)), Error::<Test>::CooldownNotOver);
		keep_founders_alive(70);
		assert_ok!(ProofOfTrust::go_online(RuntimeOrigin::signed(20)));
		assert_eq!(planned(), vec![1, 2, 20]);

		// Strike 2: cooldown doubles.
		keep_founders_alive(110);
		assert_eq!(planned(), vec![1, 2]);
		keep_founders_alive(150);
		assert_noop!(ProofOfTrust::go_online(RuntimeOrigin::signed(20)), Error::<Test>::CooldownNotOver);
		keep_founders_alive(170);
		assert_ok!(ProofOfTrust::go_online(RuntimeOrigin::signed(20)));
		assert_eq!(planned(), vec![1, 2, 20]);

		// Strike 3 (MaxStrikes): removed.
		keep_founders_alive(210);
		assert_eq!(planned(), vec![1, 2]);
		assert!(!Candidates::<Test>::contains_key(20));
	});
}

#[test]
fn strikes_are_forgiven_after_a_long_good_run() {
	new_test_ext().execute_with(|| {
		limits(34, 2);
		enroll(10, 20);
		verified_trusters(600, 1, 10);
		assert_eq!(planned(), vec![1, 2, 20]);
		System::set_block_number(40);
		for f in FOUNDERS {
			ProofOfTrust::note_author(f);
		}
		planned();
		System::set_block_number(70);
		assert_ok!(ProofOfTrust::go_online(RuntimeOrigin::signed(20)));
		planned();
		for n in (80..=1_100).step_by(20) {
			System::set_block_number(n);
			for v in [1, 2, 20] {
				ProofOfTrust::note_author(v);
			}
			planned();
		}
		assert!(Strikes::<Test>::get(20).is_none());
	});
}

#[test]
fn silent_founders_go_offline_too() {
	new_test_ext().execute_with(|| {
		assert_eq!(planned(), vec![1, 2]);
		System::set_block_number(25);
		ProofOfTrust::note_author(1);
		System::set_block_number(40);
		assert_eq!(planned(), vec![1]);
		assert!(Offline::<Test>::contains_key(2));
		System::set_block_number(70);
		ProofOfTrust::note_author(1);
		assert_ok!(ProofOfTrust::go_online(RuntimeOrigin::signed(2)));
		assert_eq!(planned(), vec![1, 2]);
	});
}

#[test]
fn founders_are_kept_when_everyone_is_offline() {
	new_test_ext().execute_with(|| {
		assert_eq!(planned(), vec![1, 2]);
		System::set_block_number(40);
		assert_eq!(planned(), vec![1, 2]);
		assert!(!Offline::<Test>::contains_key(1));
		assert!(!Offline::<Test>::contains_key(2));
	});
}

#[test]
fn admin_manages_founders() {
	new_test_ext().execute_with(|| {
		assert_noop!(ProofOfTrust::add_founder(attester(), 3), DispatchError::BadOrigin);
		assert_ok!(ProofOfTrust::add_founder(RuntimeOrigin::root(), 3));
		assert_noop!(ProofOfTrust::add_founder(RuntimeOrigin::root(), 3), Error::<Test>::AlreadyFounder);
		assert_ok!(ProofOfTrust::remove_founder(RuntimeOrigin::root(), 1));
		assert_eq!(planned(), vec![2, 3]);
	});
}

#[test]
fn equivocating_validators_are_removed_or_benched() {
	new_test_ext().execute_with(|| {
		limits(34, 2);
		use sp_staking::offence::{OffenceDetails, OnOffenceHandler};
		enroll(10, 20);
		verified_trusters(600, 1, 10);
		assert_eq!(planned(), vec![1, 2, 20]);
		let report = |who: u64| OffenceDetails { offender: (who, ()), reporters: vec![] };
		<ProofOfTrust as OnOffenceHandler<u64, (u64, ()), _>>::on_offence(
			&[report(20), report(2)],
			&[sp_runtime::Perbill::zero(); 2],
			1,
		);
		assert!(!Candidates::<Test>::contains_key(20));
		assert!(Offline::<Test>::contains_key(2));
		assert_eq!(planned(), vec![1]);
		System::set_block_number(40);
		assert_noop!(ProofOfTrust::go_online(RuntimeOrigin::signed(2)), Error::<Test>::CooldownNotOver);
	});
}

frame_support::parameter_types! {
	pub InitialIdentityAttesters: Vec<u64> = vec![ATTESTER, 102];
}

#[test]
fn migration_to_v1_drops_unattributed_verifications() {
	new_test_ext().execute_with(|| {
		use frame_support::{storage::unhashed, traits::StorageVersion};
		StorageVersion::new(0).put::<ProofOfTrust>();
		IdentityAttesters::<Test>::remove(ATTESTER);
		// A v0 verification (value `()`) and a candidate relying on it.
		let key = Verified::<Test>::hashed_key_for(10);
		unhashed::put_raw(&key, &[]);
		Candidates::<Test>::insert(20, 10);
		crate::ValidatorOf::<Test>::insert(10, 20);
		crate::CandidateCount::<Test>::put(1);
		Offline::<Test>::insert(2, ());

		crate::migrations::MigrateV0ToV1::<Test, InitialIdentityAttesters>::on_runtime_upgrade();

		assert!(IdentityAttesters::<Test>::contains_key(ATTESTER));
		assert!(IdentityAttesters::<Test>::contains_key(102));
		assert!(unhashed::get_raw(&key).is_none());
		assert!(Candidates::<Test>::iter().next().is_none());
		assert_eq!(crate::CandidateCount::<Test>::get(), 0);
		assert!(crate::OfflineSince::<Test>::contains_key(2));
		assert_eq!(StorageVersion::get::<ProofOfTrust>(), 1);
	});
}

fn plan(session: u32) -> Vec<u64> {
	ProofOfTrust::new_session(session).unwrap_or_default()
}

/// Six candidates 20..=25 (person 10 + i runs 20 + i), 20 the most trusted, 25 the least,
/// each with a recent heartbeat; two founders leave them 3 seats at a 34% founder share.
fn six_candidates(max_new: u32) {
	limits(34, max_new);
	for i in 0..6u64 {
		enroll(10 + i, 20 + i);
		verified_trusters(1000 + 100 * i, 6 - i, 10 + i);
		assert_ok!(ProofOfTrust::heartbeat(RuntimeOrigin::signed(20 + i)));
	}
}

fn rotation(core_seats: u32, period: u32) {
	assert_ok!(ProofOfTrust::set_rotation(RuntimeOrigin::root(), core_seats, period));
}

#[test]
fn without_rotation_the_most_trusted_keep_their_seats() {
	new_test_ext().execute_with(|| {
		six_candidates(10);
		assert_noop!(ProofOfTrust::set_rotation(attester(), 1, 1), DispatchError::BadOrigin);
		for session in [1, 12, 24] {
			assert_eq!(plan(session), vec![1, 2, 20, 21, 22]);
		}
	});
}

#[test]
fn rotating_seats_give_every_trusted_candidate_a_turn() {
	new_test_ext().execute_with(|| {
		six_candidates(10);
		rotation(1, 1);
		// 20 holds the core seat; the two others go to whoever served least recently.
		assert_eq!(plan(1), vec![1, 2, 20, 21, 22]);
		assert_eq!(plan(2), vec![1, 2, 20, 23, 24]);
		assert_eq!(plan(3), vec![1, 2, 20, 25, 21]);
		assert_eq!(plan(4), vec![1, 2, 20, 22, 23]);
	});
}

#[test]
fn rotating_seats_change_only_at_each_rotation() {
	new_test_ext().execute_with(|| {
		six_candidates(10);
		rotation(1, 3);
		assert_eq!(plan(1), vec![1, 2, 20, 21, 22]);
		assert_eq!(plan(2), vec![1, 2, 20, 21, 22]);
		assert_eq!(plan(3), vec![1, 2, 20, 23, 24]);
		assert_eq!(plan(4), vec![1, 2, 20, 23, 24]);
	});
}

#[test]
fn rotation_respects_the_newcomer_limit_and_the_founder_share() {
	new_test_ext().execute_with(|| {
		six_candidates(1);
		rotation(1, 1);
		// One newcomer per session: seats fill, then turn over one at a time.
		assert_eq!(plan(1), vec![1, 2, 20]);
		assert_eq!(plan(2), vec![1, 2, 20, 21]);
		assert_eq!(plan(3), vec![1, 2, 20, 22, 21]);
		assert_eq!(plan(4), vec![1, 2, 20, 23, 21]);
		// Founders back to two thirds: no candidate seat to rotate.
		limits(67, 1);
		assert_eq!(plan(5), vec![1, 2]);
	});
}

#[test]
fn leaving_by_rotation_is_not_a_strike() {
	new_test_ext().execute_with(|| {
		six_candidates(10);
		rotation(1, 1);
		let mut set = plan(1);
		for (session, block) in [(2u32, 20u64), (3, 60), (4, 100), (5, 140), (6, 180)] {
			System::set_block_number(block);
			for v in &set {
				ProofOfTrust::note_author(*v);
			}
			set = plan(session);
		}
		assert!(Strikes::<Test>::iter().next().is_none());
		assert!(Offline::<Test>::iter().next().is_none());
		assert_eq!(set.len(), 5);
		assert_ok!(ProofOfTrust::withdraw(RuntimeOrigin::signed(21)));
		assert!(!crate::LastServed::<Test>::contains_key(21));
	});
}

#[test]
fn no_rotation_below_the_validator_threshold() {
	new_test_ext().execute_with(|| {
		six_candidates(10);
		rotation(1, 1);
		// Two founders and six candidates: 8 validators, one short of the threshold.
		RotationMinValidators::set(9);
		for session in [1, 2, 3] {
			assert_eq!(plan(session), vec![1, 2, 20, 21, 22]);
		}
		RotationMinValidators::set(8);
		assert_eq!(plan(4), vec![1, 2, 20, 23, 24]);
	});
}

#[test]
fn a_newcomer_takes_a_rotating_seat_only_when_seen_online() {
	new_test_ext().execute_with(|| {
		six_candidates(10);
		rotation(1, 1);
		crate::LastHeartbeat::<Test>::remove(23);
		assert_eq!(plan(1), vec![1, 2, 20, 21, 22]);
		// 23 never served but gave no sign of life: its turn goes to the next in line.
		assert_eq!(plan(2), vec![1, 2, 20, 24, 25]);
		assert_ok!(ProofOfTrust::heartbeat(RuntimeOrigin::signed(23)));
		assert_eq!(plan(3), vec![1, 2, 20, 23, 21]);
		// A heartbeat older than `RecentlySeen` no longer counts.
		System::set_block_number(1 + RecentlySeen::get() + 1);
		for v in [1, 2, 20, 23, 21] {
			ProofOfTrust::note_author(v);
		}
		assert!(!ProofOfTrust::recently_seen(&24, System::block_number()));
		assert!(ProofOfTrust::recently_seen(&23, System::block_number()));
	});
}

#[test]
fn only_validators_send_heartbeats() {
	new_test_ext().execute_with(|| {
		assert_noop!(ProofOfTrust::heartbeat(RuntimeOrigin::signed(7)), Error::<Test>::NotCandidate);
		// A validator account without session keys cannot claim to be online.
		WithoutKeys::set(vec![1]);
		assert_noop!(ProofOfTrust::heartbeat(RuntimeOrigin::signed(1)), Error::<Test>::NoSessionKeys);
		WithoutKeys::set(vec![]);
		assert_ok!(ProofOfTrust::heartbeat(RuntimeOrigin::signed(1)));
		enroll(10, 20);
		assert_ok!(ProofOfTrust::heartbeat(RuntimeOrigin::signed(20)));
		assert!(crate::LastHeartbeat::<Test>::contains_key(20));
		assert_ok!(ProofOfTrust::withdraw(RuntimeOrigin::signed(20)));
		assert!(!crate::LastHeartbeat::<Test>::contains_key(20));
	});
}
