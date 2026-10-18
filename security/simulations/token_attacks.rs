//! Token and NFT abuse simulations (zooz.network tokens), runtime 204.
//! Prints PASSES (attack works) or BLOCKED for each scenario.

use coali_runtime::{AccountId, Assets, BuildStorage, RuntimeCall, RuntimeGenesisConfig, RuntimeOrigin, System, UNIT};
use frame_support::traits::fungibles::Inspect;
use pallet_assets::Call as A;
use pallet_token_allowlist::Call as W;
use sp_core::{sr25519, Pair};
use sp_runtime::traits::Dispatchable;

fn who(n: &str) -> AccountId {
	AccountId::from(sr25519::Pair::from_string(&format!("//{n}"), None).unwrap().public().0)
}

fn ext() -> sp_io::TestExternalities {
	let mut g = RuntimeGenesisConfig::default();
	g.balances.balances = ["alice", "bob", "victim", "mallory"].iter().map(|n| (who(n), 10_000 * UNIT)).collect();
	g.assets.next_asset_id = Some(coali_runtime::configs::FIRST_ASSET_ID);
	let mut e: sp_io::TestExternalities = g.build_storage().unwrap().into();
	e.execute_with(|| System::set_block_number(1));
	e
}

fn send(n: &str, call: RuntimeCall) -> bool {
	call.dispatch(RuntimeOrigin::signed(who(n))).is_ok()
}
fn asset(n: &str, c: A<coali_runtime::Runtime>) -> bool {
	send(n, RuntimeCall::Assets(c))
}
fn rules(n: &str, c: W<coali_runtime::Runtime>) -> bool {
	send(n, RuntimeCall::TokenAllowlist(c))
}
fn out(name: &str, works: bool) {
	println!("{} {name}", if works { "PASSES " } else { "BLOCKED" });
}

/// Creates a token owned by `owner` with `supply` minted to the owner.
fn token(owner: &str, name: &[u8], symbol: &[u8], supply: u128) -> u32 {
	let id = pallet_assets::NextAssetId::<coali_runtime::Runtime>::get().unwrap();
	assert!(asset(owner, A::create { id: id.into(), admin: who(owner).into(), min_balance: 1 }));
	assert!(asset(owner, A::set_metadata { id: id.into(), name: name.to_vec(), symbol: symbol.to_vec(), decimals: 0 }));
	if supply > 0 {
		assert!(asset(owner, A::mint { id: id.into(), beneficiary: who(owner).into(), amount: supply }));
	}
	id
}
fn give(from: &str, id: u32, to: &str, amount: u128) -> bool {
	asset(from, A::transfer { id: id.into(), target: who(to).into(), amount })
}
fn bal(id: u32, n: &str) -> u128 {
	Assets::balance(id, who(n))
}

#[test]
fn t01_fake_zooz_token() {
	ext().execute_with(|| {
		let id = token("mallory", b"ZOOZ", b"ZOOZ", 1_000_000_000);
		let id2 = token("mallory", b"Tether USD", b"USDT", 1_000_000_000);
		out(&format!("T01 token named ZOOZ/ZOOZ (#{id}) and USDT (#{id2}) created by anyone"), true);
	});
}

#[test]
fn t02_wallet_bricked_with_junk_tokens() {
	ext().execute_with(|| {
		// One scammer account per junk token, so the scammer's own consumer limit is not the cap.
		let mut junk = Vec::new();
		for i in 0..20 {
			let s = format!("scammer-{i}");
			let _ = pallet_balances::Pallet::<coali_runtime::Runtime>::force_set_balance(
				RuntimeOrigin::root(), who(&s).into(), 1_000 * UNIT,
			);
			let id = pallet_assets::NextAssetId::<coali_runtime::Runtime>::get().unwrap();
			if !asset(&s, A::create { id: id.into(), admin: who(&s).into(), min_balance: 1 }) {
				break;
			}
			let _ = asset(&s, A::set_metadata { id: id.into(), name: format!("Junk {i}").into_bytes(), symbol: b"JNK".to_vec(), decimals: 0 });
			let _ = asset(&s, A::mint { id: id.into(), beneficiary: who(&s).into(), amount: 10 });
			if !give(&s, id, "victim", 1) {
				break;
			}
			let _ = asset(&s, A::freeze { id: id.into(), who: who("victim").into() });
			junk.push(id);
		}
		let legit = token("alice", b"Real", b"REAL", 100);
		let received = give("alice", legit, "victim", 5);
		let escaped = junk.iter().any(|id| give("victim", *id, "mallory", 1));
		out(
			&format!("T02 {} junk tokens forced into the victim's wallet: afterwards a legit token is received {received}, victim can move junk out {escaped}", junk.len()),
			!received,
		);
	});
}

#[test]
fn t03_rug_pull_destroy_with_fixed_supply() {
	ext().execute_with(|| {
		let id = token("alice", b"Safe", b"SAFE", 1_000);
		assert!(rules("alice", W::fix_supply { asset: id }));
		assert!(give("alice", id, "bob", 900));
		let ok = asset("alice", A::start_destroy { id: id.into() })
			&& asset("alice", A::destroy_accounts { id: id.into() })
			&& asset("alice", A::destroy_approvals { id: id.into() })
			&& asset("alice", A::finish_destroy { id: id.into() });
		out(&format!("T03 fixed-supply token destroyed by its creator: done {ok}, bob's 900 now {}", bal(id, "bob")), ok && bal(id, "bob") == 0);
	});
}

#[test]
fn t04_creator_freezes_holders() {
	ext().execute_with(|| {
		let id = token("alice", b"Safe", b"SAFE", 1_000);
		assert!(rules("alice", W::fix_supply { asset: id }));
		assert!(give("alice", id, "bob", 500));
		assert!(asset("alice", A::freeze { id: id.into(), who: who("bob").into() }));
		let one = give("bob", id, "victim", 1);
		assert!(asset("alice", A::thaw { id: id.into(), who: who("bob").into() }));
		assert!(asset("alice", A::freeze_asset { id: id.into() }));
		let all = give("bob", id, "victim", 1);
		out(&format!("T04 creator freezes one holder (bob can still send: {one}) or the whole token (bob can send: {all})"), !one && !all);
	});
}

#[test]
fn t05_honeypot_restriction_after_distribution() {
	ext().execute_with(|| {
		let id = token("alice", b"Moon", b"MOON", 1_000);
		assert!(give("alice", id, "bob", 500));
		assert!(rules("alice", W::allow { asset: id, accounts: vec![who("alice")] }));
		assert!(rules("alice", W::set_restricted { asset: id, restricted: true }));
		let to_other = give("bob", id, "victim", 10);
		let to_creator = give("bob", id, "alice", 10);
		out(&format!("T05 restriction turned on after sale: bob can sell to others {to_other}, only back to creator {to_creator}"), !to_other && to_creator);
	});
}

#[test]
fn t06_bait_and_switch_metadata() {
	ext().execute_with(|| {
		let id = token("alice", b"Charity Fund", b"CHRT", 1_000);
		assert!(give("alice", id, "bob", 100));
		let changed = asset("alice", A::set_metadata { id: id.into(), name: b"ZOOZ".to_vec(), symbol: b"ZOOZ".to_vec(), decimals: 0 });
		out(&format!("T06 name/symbol changed after holders bought: {changed}"), changed);
	});
}

#[test]
fn t07_fixed_supply_survives_team_and_owner_changes() {
	ext().execute_with(|| {
		let id = token("alice", b"Fixed", b"FIX", 1_000);
		assert!(rules("alice", W::fix_supply { asset: id }));
		let a1 = asset("alice", A::mint { id: id.into(), beneficiary: who("alice").into(), amount: 1 });
		assert!(asset("alice", A::set_team { id: id.into(), issuer: who("mallory").into(), admin: who("mallory").into(), freezer: who("mallory").into() }));
		let a2 = asset("mallory", A::mint { id: id.into(), beneficiary: who("mallory").into(), amount: 1 });
		assert!(asset("alice", A::transfer_ownership { id: id.into(), owner: who("mallory").into() }));
		let a3 = asset("mallory", A::mint { id: id.into(), beneficiary: who("mallory").into(), amount: 1 });
		let batch = send("mallory", RuntimeCall::Utility(pallet_utility::Call::batch_all {
			calls: vec![RuntimeCall::Assets(A::mint { id: id.into(), beneficiary: who("mallory").into(), amount: 1 })],
		}));
		out(&format!("T07 mint after fix_supply: owner {a1}, new issuer {a2}, new owner {a3}, in batch {batch}"), a1 || a2 || a3 || batch);
	});
}

#[test]
fn t08_strangers_cannot_touch_someone_elses_token() {
	ext().execute_with(|| {
		let id = token("alice", b"Mine", b"MINE", 1_000);
		let tries = [
			asset("mallory", A::mint { id: id.into(), beneficiary: who("mallory").into(), amount: 1 }),
			asset("mallory", A::freeze { id: id.into(), who: who("alice").into() }),
			asset("mallory", A::force_transfer { id: id.into(), source: who("alice").into(), dest: who("mallory").into(), amount: 1 }),
			asset("mallory", A::start_destroy { id: id.into() }),
			asset("mallory", A::set_metadata { id: id.into(), name: b"x".to_vec(), symbol: b"x".to_vec(), decimals: 0 }),
			rules("mallory", W::set_restricted { asset: id, restricted: true }),
			rules("mallory", W::fix_supply { asset: id }),
		];
		out(&format!("T08 stranger mint/freeze/seize/destroy/rename/restrict/lock: {tries:?}"), tries.iter().any(|x| *x));
	});
}

#[test]
fn t09_spam_cost() {
	ext().execute_with(|| {
		let before = pallet_balances::Pallet::<coali_runtime::Runtime>::reserved_balance(who("mallory"));
		token("mallory", b"Spam", b"SPM", 1);
		let locked = pallet_balances::Pallet::<coali_runtime::Runtime>::reserved_balance(who("mallory")) - before;
		out(&format!("T09 one token locks {} ZOOZ (refunded on destroy)", locked as f64 / UNIT as f64), false);
	});
}
