//! Token abuse scenarios of the advanced audit (security/AUDIT-AVANCE-2026-10-18.md, T01–T09),
//! each asserting that the attack is now blocked, plus the receiving flow that replaces pushing
//! tokens to strangers (approve, then the receiver accepts and collects).

use coali_runtime::{AccountId, Assets, BuildStorage, Runtime, RuntimeCall, RuntimeGenesisConfig, RuntimeOrigin, System, UNIT};
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
fn asset(n: &str, c: A<Runtime>) -> bool {
	send(n, RuntimeCall::Assets(c))
}
fn rules(n: &str, c: W<Runtime>) -> bool {
	send(n, RuntimeCall::TokenAllowlist(c))
}
fn next_id() -> u32 {
	pallet_assets::NextAssetId::<Runtime>::get().unwrap()
}

/// Creates a token owned by `owner` with `supply` minted to the owner.
fn token(owner: &str, name: &[u8], symbol: &[u8], supply: u128) -> u32 {
	let id = next_id();
	assert!(asset(owner, A::create { id: id.into(), admin: who(owner).into(), min_balance: 1 }));
	assert!(asset(owner, A::set_metadata { id: id.into(), name: name.to_vec(), symbol: symbol.to_vec(), decimals: 0 }));
	if supply > 0 {
		assert!(asset(owner, A::mint { id: id.into(), beneficiary: who(owner).into(), amount: supply }));
	}
	id
}
fn accept(n: &str, id: u32) -> bool {
	asset(n, A::touch { id: id.into() })
}
fn give(from: &str, id: u32, to: &str, amount: u128) -> bool {
	asset(from, A::transfer { id: id.into(), target: who(to).into(), amount })
}
fn bal(id: u32, n: &str) -> u128 {
	Assets::balance(id, who(n))
}

#[test]
fn t01_reserved_names_are_refused() {
	ext().execute_with(|| {
		let id = next_id();
		assert!(asset("mallory", A::create { id: id.into(), admin: who("mallory").into(), min_balance: 1 }));
		let named = |name: &[u8], symbol: &[u8]| {
			asset("mallory", A::set_metadata { id: id.into(), name: name.to_vec(), symbol: symbol.to_vec(), decimals: 0 })
		};
		assert!(!named(b"ZOOZ", b"ZOOZ"));
		assert!(!named(b"Tether USD", b"USDT"));
		assert!(!named(b"My coin", b"z00z"));
		assert!(!named(b"Official Co-ali reward", b"RWD"));
		assert!(!named(b"Wrapped", b"WZOOZ"));
		assert!(!named(b"Bitcoin cash", b"BCH"));
		assert!(named(b"Maison Tel Aviv", b"MTA"));
		// Names use an allowlist of scripts (double check TOK-05, both rounds): look-alikes from any
		// other alphabet or Unicode block, invisible characters, and reserved symbols as whole words
		// of the name are refused; symbols are Latin letters and digits only.
		for (name, symbol) in [
			("ZΟΟZ", "CLB"),
			("Club", "ZООZ"),
			("Tether", "USDТ"),
			("ＺＯＯＺ", "CLB"),
			("ZO\u{200B}OZ", "CLB"),
			("Club\u{202E}", "CLB"),
			("𝐙𝐎𝐎𝐙 fan", "CLB"),
			("Zööz", "CLB"),
			("ᴢᴏᴏᴢ", "ZZ1"),
			("ⓏⓄⓄⓏ", "ZZ2"),
			("ℤ𝕆𝕆ℤ", "ZZ3"),
			("ƵOOƵ", "ZZ4"),
			("ᏃOOᏃ", "ZZ5"),
			("ᶻᵒᵒᶻ", "ZZ6"),
			("Zºº Z", "ZZ7"),
			("Ζωή", "ZOE"),
			("Z\u{FE0F}OOZ", "ZZ8"),
			("USDT", "USDTT"),
			("Wrapped BTC", "WBTCX"),
			("ETH", "ETH2"),
			("Sol club", "SOLC"),
			("Club S0L", "CLB"),
			("US\u{05B0}DT", "AC1"),
			("ET\u{05B0}H", "AC2"),
			("USD₮", "AC3"),
			("₿ Wrapped", "AC4"),
			("Z\u{0665}\u{0665}Z", "AC5"),
			("U.S.D.T", "AC6"),
			("U S D T coin", "AC7"),
			("\u{05B0}Club", "AC8"),
			("Club\u{064E}", "AC9"),
			("Club", "CL B"),
			("Club", "CLÉ"),
			("Club", ""),
		] {
			assert!(!named(name.as_bytes(), symbol.as_bytes()), "{name} / {symbol} should be refused");
		}
		// Real names stay possible: Hebrew, Arabic, accents, punctuation, currency signs, emojis
		// (with their variation selector and joiner), and words that merely contain a coin symbol.
		for (name, symbol) in [
			("Club des élèves", "ELV"),
			("מועדון תל אביב", "TLV"),
			("זוז שלום 🎉", "SHALOM"),
			("نادي يافا", "JAFFA"),
			("Club 🎉", "PARTY"),
			("Amour ❤\u{FE0F}", "LOVE"),
			("Famille 👨\u{200D}👩\u{200D}👧", "FAM"),
			("Café « Le Soleil » – 10 ₪", "CAFE"),
			("Solar Dots", "SOLAR"),
			("שָׁלוֹם", "SHALOM"),
			("مَرْحَبًا", "MARHABA"),
			("Club ٢٠٢٦", "Y2026"),
			("A B Club", "ABC"),
		] {
			assert!(named(name.as_bytes(), symbol.as_bytes()), "{name} / {symbol} should be allowed");
		}
		// The foundation can still name its own tokens, through root.
		assert!(Assets::force_set_metadata(RuntimeOrigin::root(), id.into(), b"ZOOZ".to_vec(), b"ZOOZ".to_vec(), 0, false).is_ok());
	});
}

#[test]
fn t02_junk_tokens_cannot_reach_a_wallet() {
	ext().execute_with(|| {
		let mut refused = 0;
		for i in 0..20 {
			let s = format!("scammer-{i}");
			let _ = pallet_balances::Pallet::<Runtime>::force_set_balance(RuntimeOrigin::root(), who(&s).into(), 1_000 * UNIT);
			let id = token(&s, format!("Junk {i}").as_bytes(), b"JNK", 10);
			// Pushing, minting to, or opening an account for the victim: all refused.
			let pushed = give(&s, id, "victim", 1) ||
				asset(&s, A::mint { id: id.into(), beneficiary: who("victim").into(), amount: 1 }) ||
				asset(&s, A::touch_other { id: id.into(), who: who("victim").into() });
			if !pushed {
				refused += 1;
			}
			// An approval costs the scammer, not the victim, and takes none of the victim's slots.
			assert!(asset(&s, A::approve_transfer { id: id.into(), delegate: who("victim").into(), amount: 1 }));
		}
		assert_eq!(refused, 20);
		assert_eq!(frame_system::Pallet::<Runtime>::consumers(&who("victim")), 0);

		// A real token still arrives once the victim accepts it.
		let legit = token("alice", b"Real", b"REAL", 100);
		assert!(!give("alice", legit, "victim", 5));
		assert!(accept("victim", legit));
		assert!(give("alice", legit, "victim", 5));
		assert_eq!(bal(legit, "victim"), 5);
	});
}

#[test]
fn receiving_flow_approve_then_accept_and_collect() {
	ext().execute_with(|| {
		let id = token("alice", b"Club", b"CLB", 100);
		assert!(asset("alice", A::approve_transfer { id: id.into(), delegate: who("bob").into(), amount: 30 }));
		// One signature for the receiver: accept and collect.
		let collect = RuntimeCall::Utility(pallet_utility::Call::batch_all {
			calls: vec![
				RuntimeCall::Assets(A::touch { id: id.into() }),
				RuntimeCall::Assets(A::transfer_approved {
					id: id.into(),
					owner: who("alice").into(),
					destination: who("bob").into(),
					amount: 30,
				}),
			],
		});
		assert!(send("bob", collect));
		assert_eq!(bal(id, "bob"), 30);
		// From then on, sends arrive directly.
		assert!(give("alice", id, "bob", 1));
		// A holder can always leave a token: burn its balance and get the deposit back.
		assert!(asset("bob", A::refund { id: id.into(), allow_burn: true }));
		assert_eq!(bal(id, "bob"), 0);
		// And can always give it back to the owner.
		assert!(accept("bob", id));
		assert!(give("alice", id, "bob", 2));
		assert!(give("bob", id, "alice", 2));
	});
}

#[test]
fn t03_no_destroy_once_others_hold_it() {
	ext().execute_with(|| {
		let id = token("alice", b"Safe", b"SAFE", 1_000);
		assert!(accept("bob", id));
		assert!(give("alice", id, "bob", 900));
		assert!(!asset("alice", A::start_destroy { id: id.into() }));
		assert_eq!(bal(id, "bob"), 900);
		// Burning someone else's balance is refused too.
		assert!(!asset("alice", A::burn { id: id.into(), who: who("bob").into(), amount: 900 }));
		// The creator can still burn its own balance.
		assert!(asset("alice", A::burn { id: id.into(), who: who("alice").into(), amount: 100 }));

		// A token only its owner holds can still be closed (deposit refunded).
		let solo = token("alice", b"Draft", b"DRF", 10);
		assert!(asset("alice", A::start_destroy { id: solo.into() }));
	});
}

#[test]
fn t04_normal_tokens_cannot_be_frozen() {
	ext().execute_with(|| {
		let id = token("alice", b"Safe", b"SAFE", 1_000);
		assert!(accept("bob", id));
		assert!(give("alice", id, "bob", 500));
		assert!(!asset("alice", A::freeze { id: id.into(), who: who("bob").into() }));
		assert!(!asset("alice", A::block { id: id.into(), who: who("bob").into() }));
		assert!(!asset("alice", A::freeze_asset { id: id.into() }));
		assert!(!asset(
			"alice",
			A::force_transfer { id: id.into(), source: who("bob").into(), dest: who("alice").into(), amount: 500 }
		));
		assert!(accept("victim", id));
		assert!(give("bob", id, "victim", 1));
	});
}

#[test]
fn t05_no_honeypot_restriction_after_distribution() {
	ext().execute_with(|| {
		let id = token("alice", b"Moon", b"MOON", 1_000);
		assert!(rules("alice", W::allow { asset: id, accounts: vec![who("alice")] }));
		assert!(!rules("alice", W::set_restricted { asset: id, restricted: true }));

		// A regulated token is restricted before any unit exists, and may then freeze holders.
		let reg = next_id();
		assert!(asset("alice", A::create { id: reg.into(), admin: who("alice").into(), min_balance: 1 }));
		assert!(rules("alice", W::allow { asset: reg, accounts: vec![who("alice"), who("bob")] }));
		assert!(rules("alice", W::set_restricted { asset: reg, restricted: true }));
		assert!(asset("alice", A::mint { id: reg.into(), beneficiary: who("alice").into(), amount: 100 }));
		assert!(accept("bob", reg));
		assert!(give("alice", reg, "bob", 10));
		assert!(asset("alice", A::freeze { id: reg.into(), who: who("bob").into() }));
	});
}

#[test]
fn t06_no_rename_once_others_hold_it() {
	ext().execute_with(|| {
		let id = token("alice", b"Charity Fund", b"CHRT", 1_000);
		// Renaming while only the creator holds it is fine (typos).
		assert!(asset("alice", A::set_metadata { id: id.into(), name: b"Charity Fund".to_vec(), symbol: b"CHF".to_vec(), decimals: 0 }));
		assert!(accept("bob", id));
		assert!(give("alice", id, "bob", 100));
		assert!(!asset("alice", A::set_metadata { id: id.into(), name: b"Other".to_vec(), symbol: b"OTH".to_vec(), decimals: 0 }));
		assert!(!asset("alice", A::clear_metadata { id: id.into() }));
	});
}

#[test]
fn t07_lock_survives_team_and_owner_changes_and_renounces_everything() {
	ext().execute_with(|| {
		let id = token("alice", b"Fixed", b"FIX", 1_000);
		assert!(rules("alice", W::fix_supply { asset: id }));
		let mint = |n: &str| asset(n, A::mint { id: id.into(), beneficiary: who(n).into(), amount: 1 });
		assert!(!mint("alice"));
		assert!(asset("alice", A::set_team { id: id.into(), issuer: who("mallory").into(), admin: who("mallory").into(), freezer: who("mallory").into() }));
		assert!(!mint("mallory"));
		assert!(asset("alice", A::transfer_ownership { id: id.into(), owner: who("mallory").into() }));
		assert!(!mint("mallory"));
		assert!(!send("mallory", RuntimeCall::Utility(pallet_utility::Call::batch_all {
			calls: vec![RuntimeCall::Assets(A::mint { id: id.into(), beneficiary: who("mallory").into(), amount: 1 })],
		})));
		// Locked: no destroy, rename or restriction either, even with no other holder.
		assert!(!asset("mallory", A::start_destroy { id: id.into() }));
		assert!(!asset("mallory", A::set_metadata { id: id.into(), name: b"X".to_vec(), symbol: b"X".to_vec(), decimals: 0 }));
		assert!(!rules("mallory", W::set_restricted { asset: id, restricted: true }));
		assert_eq!(Assets::total_issuance(id), 1_000);
	});
}

/// Double check TOK-06: locking a regulated token fixes its supply, name and existence, but its
/// creator keeps the regulated powers (freeze, seize, allowlist) — what the sites now say. To
/// renounce those too, the creator lifts the restriction first.
#[test]
fn t07b_locked_regulated_token_keeps_regulated_powers_until_unrestricted() {
	ext().execute_with(|| {
		let id = next_id();
		assert!(asset("alice", A::create { id: id.into(), admin: who("alice").into(), min_balance: 1 }));
		assert!(rules("alice", W::allow { asset: id, accounts: vec![who("alice"), who("bob")] }));
		assert!(rules("alice", W::set_restricted { asset: id, restricted: true }));
		assert!(asset("alice", A::mint { id: id.into(), beneficiary: who("alice").into(), amount: 1_000 }));
		assert!(accept("bob", id));
		assert!(give("alice", id, "bob", 500));
		assert!(rules("alice", W::fix_supply { asset: id }));
		assert!(asset("alice", A::freeze { id: id.into(), who: who("bob").into() }));
		assert!(asset("alice", A::thaw { id: id.into(), who: who("bob").into() }));

		// Lifting the restriction removes the regulated powers for good: it cannot come back.
		assert!(rules("alice", W::set_restricted { asset: id, restricted: false }));
		assert!(!rules("alice", W::set_restricted { asset: id, restricted: true }));
		assert!(!asset("alice", A::freeze { id: id.into(), who: who("bob").into() }));
		assert!(!asset(
			"alice",
			A::force_transfer { id: id.into(), source: who("bob").into(), dest: who("alice").into(), amount: 1 }
		));
		assert!(!asset("alice", A::burn { id: id.into(), who: who("bob").into(), amount: 1 }));
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
		assert_eq!(tries, [false; 7]);
	});
}

#[test]
fn t09_spam_still_costs_a_deposit() {
	ext().execute_with(|| {
		let before = pallet_balances::Pallet::<Runtime>::reserved_balance(who("mallory"));
		token("mallory", b"Spam", b"SPM", 1);
		let locked = pallet_balances::Pallet::<Runtime>::reserved_balance(who("mallory")) - before;
		assert!(locked >= 10 * UNIT);
	});
}
