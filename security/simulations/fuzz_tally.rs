//! Fuzzing of the on-chain JSON tally parser: no panic, and anything accepted is canonical.
use pallet_coali_ledger::{parse_tally, parse_totals};

struct Rng(u64);
impl Rng {
	fn next(&mut self) -> u64 {
		self.0 ^= self.0 << 13;
		self.0 ^= self.0 >> 7;
		self.0 ^= self.0 << 17;
		self.0
	}
	fn pick<'a>(&mut self, xs: &'a [&'a [u8]]) -> &'a [u8] {
		xs[(self.next() % xs.len() as u64) as usize]
	}
}

fn canonical(pairs: &[(&[u8], u64)]) -> Vec<u8> {
	let mut s = b"{".to_vec();
	for (i, (k, v)) in pairs.iter().enumerate() {
		if i > 0 { s.push(b','); }
		s.push(b'"'); s.extend_from_slice(k); s.push(b'"'); s.push(b':');
		s.extend_from_slice(v.to_string().as_bytes());
	}
	s.push(b'}');
	s
}

#[test]
fn fuzz_parse_tally() {
	let atoms: &[&[u8]] = &[b"{", b"}", b"\"", b":", b",", b"\\", b"0", b"1", b"9", b"00", b"18446744073709551615",
		b"18446744073709551616", b"a", b"b", b"yes", b"no", b" ", b"\n", b"-", b"+", b"1e3", b".5", b"\xff", b"\x00", b"\xc3\xa9", b"null", b"[]"];
	let mut rng = Rng(0x9E3779B97F4A7C15);
	let (mut accepted, mut total) = (0u64, 0u64);
	for _ in 0..300_000 {
		let n = (rng.next() % 14) as usize;
		let mut input = Vec::new();
		if rng.next() % 3 == 0 {
			// Structured: mostly valid shape with random parts.
			input.extend_from_slice(b"{");
			for k in 0..(rng.next() % 4) {
				if k > 0 { input.extend_from_slice(rng.pick(&[b",", b",", b";", b""])); }
				input.extend_from_slice(b"\"");
				input.extend_from_slice(rng.pick(atoms));
				input.extend_from_slice(rng.pick(&[b"\"", b"\"", b""]));
				input.extend_from_slice(rng.pick(&[b":", b":", b" :"]));
				input.extend_from_slice(rng.pick(atoms));
			}
			input.extend_from_slice(rng.pick(&[b"}", b"}", b"}}", b""]));
		} else {
			for _ in 0..n { input.extend_from_slice(rng.pick(atoms)); }
		}
		total += 1;
		let r = std::panic::catch_unwind(|| parse_tally(&input).map(|p| p.iter().map(|(k, v)| (k.to_vec(), *v)).collect::<Vec<_>>()));
		let parsed = r.unwrap_or_else(|_| panic!("PANIC on input {:?}", String::from_utf8_lossy(&input)));
		if let Some(pairs) = parsed {
			accepted += 1;
			let refs: Vec<(&[u8], u64)> = pairs.iter().map(|(k, v)| (k.as_slice(), *v)).collect();
			assert_eq!(canonical(&refs), input, "non-canonical input accepted: {:?}", String::from_utf8_lossy(&input));
			let _ = parse_totals(&input);
		}
	}
	println!("fuzz: {total} inputs, {accepted} accepted (all canonical), no panic");
}
