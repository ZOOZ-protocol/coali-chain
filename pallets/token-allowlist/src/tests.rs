use crate::{mock::*, Error, Event};
use frame_support::{assert_noop, assert_ok};

#[test]
fn unrestricted_token_accepts_everyone() {
	new_test_ext().execute_with(|| {
		assert!(TokenAllowlist::can_receive(&7, &42));
	});
}

#[test]
fn restricted_token_accepts_only_the_allowlist() {
	new_test_ext().execute_with(|| {
		assert_ok!(TokenAllowlist::set_restricted(RuntimeOrigin::signed(1), 7, true));
		assert!(!TokenAllowlist::can_receive(&7, &42));

		assert_ok!(TokenAllowlist::allow(RuntimeOrigin::signed(1), 7, vec![42, 43]));
		assert!(TokenAllowlist::can_receive(&7, &42));
		assert!(TokenAllowlist::can_receive(&7, &43));
		// The list is per token.
		assert!(TokenAllowlist::can_receive(&8, &44));

		assert_ok!(TokenAllowlist::remove(RuntimeOrigin::signed(1), 7, vec![43]));
		assert!(!TokenAllowlist::can_receive(&7, &43));
		System::assert_last_event(Event::AccountRemoved { asset: 7, who: 43 }.into());

		assert_ok!(TokenAllowlist::set_restricted(RuntimeOrigin::signed(1), 7, false));
		assert!(TokenAllowlist::can_receive(&7, &43));
	});
}

#[test]
fn only_the_manager_changes_the_rules() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			TokenAllowlist::set_restricted(RuntimeOrigin::signed(2), 7, true),
			Error::<Test>::NotManager
		);
		assert_noop!(TokenAllowlist::allow(RuntimeOrigin::signed(2), 7, vec![2]), Error::<Test>::NotManager);
		assert_noop!(TokenAllowlist::remove(RuntimeOrigin::signed(2), 7, vec![2]), Error::<Test>::NotManager);
	});
}

#[test]
fn too_many_accounts_in_one_call() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			TokenAllowlist::allow(RuntimeOrigin::signed(1), 7, vec![2, 3, 4, 5]),
			Error::<Test>::TooManyAccounts
		);
	});
}

#[test]
fn supply_can_be_locked_forever_by_the_manager() {
	new_test_ext().execute_with(|| {
		assert!(TokenAllowlist::can_mint(&7));
		assert_noop!(TokenAllowlist::fix_supply(RuntimeOrigin::signed(2), 7), Error::<Test>::NotManager);
		assert_ok!(TokenAllowlist::fix_supply(RuntimeOrigin::signed(1), 7));
		assert!(!TokenAllowlist::can_mint(&7));
		assert!(TokenAllowlist::can_mint(&8));
		System::assert_last_event(Event::SupplyFixed { asset: 7 }.into());
	});
}
