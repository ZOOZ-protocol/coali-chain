mod lookalikes_v2 {
	use super::*;

	#[test]
	fn y01_more_lookalikes() {
		ext().execute_with(|| {
			let id = next_id();
			assert!(asset("mallory", A::create { id: id.into(), admin: who("mallory").into(), min_balance: 1 }));
			let tries: &[(&str, &str, &str)] = &[
				("small capitals", "ᴢᴏᴏᴢ", "ZZ1"),
				("circled letters", "ⓏⓄⓄⓏ", "ZZ2"),
				("double-struck Z (letterlike block)", "ℤ𝕆𝕆ℤ", "ZZ3"),
				("Z with stroke", "ƵOOƵ", "ZZ4"),
				("Cherokee Z", "ᏃOOᏃ", "ZZ5"),
				("modifier letters", "ᶻᵒᵒᶻ", "ZZ6"),
				("name 'USDT', other symbol", "USDT", "USDTT"),
				("name 'Wrapped BTC'", "Wrapped BTC", "WBTCX"),
				("name 'ETH', symbol ETH2", "ETH", "ETH2"),
				("Hebrew + emoji (must pass)", "זוז שלום 🎉", "SHALOM"),
			];
			for (label, name, symbol) in tries {
				let ok = asset("mallory", A::set_metadata { id: id.into(), name: name.as_bytes().to_vec(), symbol: symbol.as_bytes().to_vec(), decimals: 0 });
				println!("{} {label}: {name} / {symbol}", if ok { "ACCEPTED" } else { "REFUSED " });
			}
		});
	}
}
