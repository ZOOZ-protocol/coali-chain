mod lookalikes_v3 {
	use super::*;
	fn try_name(id: u32, name: &str, symbol: &str) -> bool {
		asset("mallory", A::set_metadata { id: id.into(), name: name.as_bytes().to_vec(), symbol: symbol.as_bytes().to_vec(), decimals: 0 })
	}
	#[test]
	fn z01_harder_impersonations() {
		ext().execute_with(|| {
			let id = next_id();
			assert!(asset("mallory", A::create { id: id.into(), admin: who("mallory").into(), min_balance: 1 }));
			// (label, name, symbol, should_be_accepted)
			let cases: &[(&str, &str, &str, bool)] = &[
				("v2 small caps", "ᴢᴏᴏᴢ", "AA1", false),
				("v2 circled", "ⓏⓄⓄⓏ", "AA2", false),
				("v2 double-struck", "ℤ𝕆𝕆ℤ", "AA3", false),
				("v2 Z-stroke", "ƵOOƵ", "AA4", false),
				("v2 Cherokee", "ᏃOOᏃ", "AA5", false),
				("v2 superscript", "ᶻᵒᵒᶻ", "AA6", false),
				("name USDT other symbol", "USDT", "AA7", false),
				("name ETH", "ETH", "AA8", false),
				("name Wrapped BTC", "Wrapped BTC", "AA9", false),
				("ZOOZ split by spaces", "Z O O Z", "AB1", false),
				("ZOOZ split by emoji", "Z😀O😀O😀Z", "AB2", false),
				("ZOOZ accented", "Zóòz", "AB3", false),
				("ETH whole word in phrase", "Buy ETH today", "AB4", false),
				("S0L zero-as-O", "Best S0L ever", "AB5", false),
				("usdt lowercase symbol", "Nice coin", "usdt", false),
				("IPA g (U+0261)", "ɡood coin", "AB6", false),
				("Latin-B capital", "ƉOOZ", "AB7", false),
				("Zoozle substring", "Zoozle", "AB8", false),
				("Hebrew + emoji (ok)", "זוז שלום 🎉", "SHALOM", true),
				("Arabic (ok)", "عملة جيدة", "ARB", true),
				("accents + quotes (ok)", "Café « Le Soleil » – 10 ₪", "CAFE", true),
				("family ZWJ emoji (ok)", "Family 👨‍👩‍👧 fund", "FAM", true),
				("Solar Dots (ok, not SOL/DOT words)", "Solar Dots", "SLD", true),
			];
			let mut wrong = 0;
			for (label, name, symbol, want) in cases {
				let got = try_name(id, name, symbol);
				let ok = got == *want;
				if !ok { wrong += 1; }
				println!("{} {label}: {} (wanted {})", if ok { "ok  " } else { "WRONG" }, if got { "ACCEPTED" } else { "refused" }, if *want { "accept" } else { "refuse" });
			}
			assert_eq!(wrong, 0, "{wrong} cases behaved wrong");
		});
	}
}

mod lookalikes_v4 {
	use super::*;
	#[test]
	fn z02_edge_cases() {
		ext().execute_with(|| {
			let id = next_id();
			assert!(asset("mallory", A::create { id: id.into(), admin: who("mallory").into(), min_balance: 1 }));
			for (label, name, symbol) in [
				("Hebrew point splits USDT", "US\u{05B0}DT", "AC1"),
				("Hebrew point splits ETH", "ET\u{05B0}H", "AC2"),
				("Tether sign USD₮", "USD₮", "AC3"),
				("Bitcoin sign ₿", "₿ Wrapped", "AC4"),
				("Arabic-Indic five as o", "Z\u{0665}\u{0665}Z", "AC5"),
				("dotted USDT", "U.S.D.T", "AC6"),
			] {
				let ok = asset("mallory", A::set_metadata { id: id.into(), name: name.as_bytes().to_vec(), symbol: symbol.as_bytes().to_vec(), decimals: 0 });
				println!("{} {label}: {name}", if ok { "ACCEPTED" } else { "refused " });
			}
		});
	}
}
