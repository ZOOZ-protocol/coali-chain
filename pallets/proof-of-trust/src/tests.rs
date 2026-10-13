use crate::{mock::*, Candidates, Error, Offline};
use frame_support::{assert_noop, assert_ok};
use pallet_authorship::EventHandler;
use pallet_session::SessionManager;
use sp_runtime::DispatchError;

fn attester() -> RuntimeOrigin {
	RuntimeOrigin::signed(ATTESTER)
}

/// Person `trust` (trust address) runs validator `validator`.
fn enroll(trust: u64, validator: u64) {
	assert_ok!(ProofOfTrust::attest_identity(attester(), trust, true));
	assert_ok!(ProofOfTrust::register_candidate(attester(), trust, validator));
}

fn planned() -> Vec<u64> {
	ProofOfTrust::new_session(1).unwrap_or_default()
}

#[test]
fn founders_alone_bootstrap_the_network() {
	new_test_ext().execute_with(|| {
		assert_eq!(planned(), FOUNDERS.to_vec());
	});
}

#[test]
fn only_attesters_vouch_and_register() {
	new_test_ext().execute_with(|| {
		assert_noop!(ProofOfTrust::attest_identity(RuntimeOrigin::signed(7), 10, true), DispatchError::BadOrigin);
		assert_noop!(ProofOfTrust::register_candidate(attester(), 10, 20), Error::<Test>::NotVerified);
		enroll(10, 20);
		assert_noop!(ProofOfTrust::register_candidate(attester(), 10, 21), Error::<Test>::PersonHasValidator);
		assert_ok!(ProofOfTrust::attest_identity(attester(), 11, true));
		assert_noop!(ProofOfTrust::register_candidate(attester(), 11, 20), Error::<Test>::AlreadyCandidate);
		assert_noop!(ProofOfTrust::register_candidate(attester(), 11, 1), Error::<Test>::AlreadyFounder);
	});
}

#[test]
fn trust_threshold_decides_who_validates() {
	new_test_ext().execute_with(|| {
		enroll(10, 20);
		assert_eq!(planned(), vec![1, 2]);
		set_trust(10, 1);
		assert_eq!(planned(), vec![1, 2, 20]);
		assert_ok!(ProofOfTrust::set_min_trust(RuntimeOrigin::root(), 2));
		assert_eq!(planned(), vec![1, 2]);
		set_trust(10, 2);
		assert_eq!(planned(), vec![1, 2, 20]);
	});
}

#[test]
fn most_trusted_fill_the_free_seats() {
	new_test_ext().execute_with(|| {
		for (trust, validator, score) in [(10, 20, 1), (11, 21, 5), (12, 22, 3)] {
			enroll(trust, validator);
			set_trust(trust, score);
		}
		assert_eq!(planned(), vec![1, 2, 21, 22]);
	});
}

#[test]
fn losing_identity_or_leaving_removes_the_candidate() {
	new_test_ext().execute_with(|| {
		enroll(10, 20);
		enroll(11, 21);
		set_trust(10, 1);
		set_trust(11, 1);
		assert_ok!(ProofOfTrust::attest_identity(attester(), 10, false));
		assert!(!Candidates::<Test>::contains_key(20));
		assert_ok!(ProofOfTrust::withdraw(RuntimeOrigin::signed(21)));
		assert_eq!(planned(), vec![1, 2]);
		enroll(11, 25);
	});
}

#[test]
fn silent_candidates_go_offline_until_they_come_back() {
	new_test_ext().execute_with(|| {
		enroll(10, 20);
		enroll(11, 21);
		set_trust(10, 1);
		set_trust(11, 1);
		assert_eq!(planned(), vec![1, 2, 20, 21]);

		System::set_block_number(25);
		ProofOfTrust::note_author(20);
		System::set_block_number(40);
		assert_eq!(planned(), vec![1, 2, 20]);
		assert!(Offline::<Test>::contains_key(21));

		assert_noop!(ProofOfTrust::go_online(RuntimeOrigin::signed(20)), Error::<Test>::NotOffline);
		assert_ok!(ProofOfTrust::go_online(RuntimeOrigin::signed(21)));
		assert_eq!(planned(), vec![1, 2, 20, 21]);
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
