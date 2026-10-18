//! Tokens, allowlist and NFTs through the real runtime configuration.

use coali_runtime::{
	configs::FIRST_ASSET_ID, AccountId, Assets, Balances, BuildStorage, Nfts, Runtime, RuntimeCall,
	RuntimeGenesisConfig, RuntimeOrigin, System, UNIT,
};
use frame_support::{
	assert_noop, assert_ok,
	traits::{fungibles::Inspect, Currency},
};
use sp_keyring::Sr25519Keyring;
use sp_runtime::{traits::Dispatchable, DispatchError, MultiAddress};

fn alice() -> AccountId {
	Sr25519Keyring::Alice.to_account_id()
}
fn bob() -> AccountId {
	Sr25519Keyring::Bob.to_account_id()
}
fn charlie() -> AccountId {
	Sr25519Keyring::Charlie.to_account_id()
}

fn new_ext() -> sp_io::TestExternalities {
	let mut genesis = RuntimeGenesisConfig::default();
	genesis.balances.balances = vec![(alice(), 1_000 * UNIT), (bob(), UNIT), (charlie(), UNIT)];
	genesis.assets.next_asset_id = Some(FIRST_ASSET_ID);
	let mut ext: sp_io::TestExternalities = genesis.build_storage().unwrap().into();
	ext.execute_with(|| System::set_block_number(1));
	ext
}

/// Dispatch as a signed user, through the runtime call filter like a real transaction.
fn send(who: AccountId, call: RuntimeCall) -> Result<(), DispatchError> {
	call.dispatch(RuntimeOrigin::signed(who)).map(|_| ()).map_err(|e| e.error)
}

fn transfer(id: u32, to: AccountId, amount: u128) -> RuntimeCall {
	RuntimeCall::Assets(pallet_assets::Call::transfer {
		id: id.into(),
		target: MultiAddress::Id(to),
		amount,
	})
}

fn create_token(owner: AccountId) -> u32 {
	let id = FIRST_ASSET_ID;
	assert_ok!(Assets::create(RuntimeOrigin::signed(owner.clone()), id.into(), owner.clone().into(), 1));
	assert_ok!(Assets::set_metadata(
		RuntimeOrigin::signed(owner.clone()),
		id.into(),
		b"Maison Tel Aviv".to_vec(),
		b"MTA".to_vec(),
		2
	));
	assert_ok!(Assets::mint(RuntimeOrigin::signed(owner), id.into(), alice().into(), 1_000_000));
	id
}

#[test]
fn anyone_creates_a_token_paying_a_deposit_in_zooz() {
	new_ext().execute_with(|| {
		let id = create_token(alice());
		assert_eq!(Assets::total_issuance(id), 1_000_000);
		assert_eq!(Assets::balance(id, alice()), 1_000_000);
		// 10 ZOOZ for the token, plus the metadata deposit.
		assert!(Balances::reserved_balance(alice()) >= 10 * UNIT);

		// The next token gets the next id, nobody picks ids by hand.
		assert_noop!(
			Assets::create(RuntimeOrigin::signed(alice()), (id + 5).into(), alice().into(), 1),
			pallet_assets::Error::<Runtime>::BadAssetId
		);
		assert_ok!(Assets::create(RuntimeOrigin::signed(alice()), (id + 1).into(), alice().into(), 1));
	});
}

#[test]
fn without_enough_zooz_no_token() {
	new_ext().execute_with(|| {
		let poor: AccountId = Sr25519Keyring::Dave.to_account_id();
		let _ = Balances::deposit_creating(&poor, UNIT);
		assert!(Assets::create(RuntimeOrigin::signed(poor.clone()), FIRST_ASSET_ID.into(), poor.into(), 1)
			.is_err());
	});
}

fn accept(who: AccountId, id: u32) {
	assert_ok!(send(who, RuntimeCall::Assets(pallet_assets::Call::touch { id: id.into() })));
}

#[test]
fn tokens_move_freely_to_accounts_that_accepted_them() {
	new_ext().execute_with(|| {
		let id = create_token(alice());
		let filtered: DispatchError = frame_system::Error::<Runtime>::CallFiltered.into();
		assert_eq!(send(alice(), transfer(id, bob(), 100)), Err(filtered));
		accept(bob(), id);
		assert_ok!(send(alice(), transfer(id, bob(), 100)));
		assert_eq!(Assets::balance(id, bob()), 100);
	});
}

#[test]
fn restricted_token_only_reaches_the_allowlist() {
	new_ext().execute_with(|| {
		let id = FIRST_ASSET_ID;
		assert_ok!(Assets::create(RuntimeOrigin::signed(alice()), id.into(), alice().into(), 1));
		assert_ok!(send(
			alice(),
			RuntimeCall::TokenAllowlist(pallet_token_allowlist::Call::allow { asset: id, accounts: vec![alice(), bob()] })
		));
		assert_ok!(send(
			alice(),
			RuntimeCall::TokenAllowlist(pallet_token_allowlist::Call::set_restricted { asset: id, restricted: true })
		));
		assert_ok!(send(
			alice(),
			RuntimeCall::Assets(pallet_assets::Call::mint { id: id.into(), beneficiary: alice().into(), amount: 1_000 })
		));
		accept(bob(), id);
		accept(charlie(), id);

		assert_ok!(send(alice(), transfer(id, bob(), 100)));
		let filtered: DispatchError = frame_system::Error::<Runtime>::CallFiltered.into();
		assert_eq!(send(alice(), transfer(id, charlie(), 100)), Err(filtered));
		assert_eq!(send(bob(), transfer(id, charlie(), 10)), Err(filtered));
		assert_eq!(
			send(
				alice(),
				RuntimeCall::Assets(pallet_assets::Call::mint {
					id: id.into(),
					beneficiary: charlie().into(),
					amount: 5
				})
			),
			Err(filtered)
		);

		// Only the token's owner changes its rules.
		assert!(send(
			bob(),
			RuntimeCall::TokenAllowlist(pallet_token_allowlist::Call::allow { asset: id, accounts: vec![charlie()] })
		)
		.is_err());

		assert_ok!(send(
			alice(),
			RuntimeCall::TokenAllowlist(pallet_token_allowlist::Call::allow { asset: id, accounts: vec![charlie()] })
		));
		assert_ok!(send(bob(), transfer(id, charlie(), 10)));
		assert_eq!(Assets::balance(id, charlie()), 10);
	});
}

#[test]
fn zooz_transfers_are_not_affected() {
	new_ext().execute_with(|| {
		let before = Balances::free_balance(bob());
		assert_ok!(send(
			alice(),
			RuntimeCall::Balances(pallet_balances::Call::transfer_keep_alive {
				dest: bob().into(),
				value: UNIT
			})
		));
		assert_eq!(Balances::free_balance(bob()), before + UNIT);
	});
}

#[test]
fn anyone_creates_an_nft_collection_and_mints() {
	new_ext().execute_with(|| {
		let free = Balances::free_balance(alice());
		assert_ok!(Nfts::create(RuntimeOrigin::signed(alice()), alice().into(), Default::default()));
		assert_eq!(Balances::free_balance(alice()), free - 10 * UNIT);
		assert_ok!(Nfts::mint(RuntimeOrigin::signed(alice()), 0, 1, bob().into(), None));
		assert_eq!(Nfts::owner(0, 1), Some(bob()));
		assert_ok!(Nfts::transfer(RuntimeOrigin::signed(bob()), 0, 1, charlie().into()));
		assert_eq!(Nfts::owner(0, 1), Some(charlie()));
	});
}

#[test]
fn locked_supply_cannot_grow() {
	new_ext().execute_with(|| {
		let id = create_token(alice());
		let mint = || {
			RuntimeCall::Assets(pallet_assets::Call::mint { id: id.into(), beneficiary: alice().into(), amount: 1 })
		};
		assert_ok!(send(alice(), mint()));
		assert_ok!(send(
			alice(),
			RuntimeCall::TokenAllowlist(pallet_token_allowlist::Call::fix_supply { asset: id })
		));
		let filtered: DispatchError = frame_system::Error::<Runtime>::CallFiltered.into();
		assert_eq!(send(alice(), mint()), Err(filtered));
		assert_eq!(Assets::total_issuance(id), 1_000_001);
		// Transfers still work.
		accept(bob(), id);
		assert_ok!(send(alice(), transfer(id, bob(), 1)));
	});
}

#[test]
fn a_batch_creates_a_token_in_one_signature_and_still_obeys_the_rules() {
	new_ext().execute_with(|| {
		let id = FIRST_ASSET_ID;
		let calls = vec![
			RuntimeCall::Assets(pallet_assets::Call::create { id: id.into(), admin: alice().into(), min_balance: 1 }),
			RuntimeCall::Assets(pallet_assets::Call::set_metadata {
				id: id.into(),
				name: b"Club".to_vec(),
				symbol: b"CLB".to_vec(),
				decimals: 0,
			}),
			RuntimeCall::TokenAllowlist(pallet_token_allowlist::Call::allow { asset: id, accounts: vec![alice()] }),
			RuntimeCall::TokenAllowlist(pallet_token_allowlist::Call::set_restricted { asset: id, restricted: true }),
			RuntimeCall::Assets(pallet_assets::Call::mint { id: id.into(), beneficiary: alice().into(), amount: 100 }),
		];
		assert_ok!(send(alice(), RuntimeCall::Utility(pallet_utility::Call::batch_all { calls })));
		assert_eq!(Assets::balance(id, alice()), 100);

		// The allowlist applies inside batches too.
		let filtered: DispatchError = frame_system::Error::<Runtime>::CallFiltered.into();
		let sneak = RuntimeCall::Utility(pallet_utility::Call::batch_all { calls: vec![transfer(id, bob(), 1)] });
		assert_eq!(send(alice(), sneak), Err(filtered));
	});
}
