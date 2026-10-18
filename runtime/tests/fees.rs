//! A vote (`record_vote`, about 250 bytes) costs the target fee, in dollars.

use coali_runtime::{AccountId, BuildStorage, Runtime, RuntimeCall, RuntimeGenesisConfig, TransactionPayment, UNIT};
use frame_support::dispatch::GetDispatchInfo;
use sp_core::sr25519;
use sp_runtime::MultiSignature;

#[test]
fn a_vote_costs_the_target_fee() {
	let mut g = RuntimeGenesisConfig::default();
	g.zooz_economy.price_micro_usd = 246_900;
	g.zooz_economy.target_fee_micro_usd = 50_000;
	let mut ext: sp_io::TestExternalities = g.build_storage().unwrap().into();
	ext.execute_with(|| {
		let call = RuntimeCall::CoaliLedger(pallet_coali_ledger::Call::record_vote {
			decision_id: [0; 16],
			voter: AccountId::from([0; 32]),
			commitment: [0; 32],
			kind: pallet_coali_ledger::VoteKind::Direct,
			voter_signature: MultiSignature::Sr25519(sr25519::Signature::from_raw([0; 64])),
		});
		let info = call.get_dispatch_info();
		let fee = TransactionPayment::compute_fee(250, &info, 0);
		let target = pallet_zooz_economy::Pallet::<Runtime>::target_fee();
		let usd = fee as f64 / UNIT as f64 * 0.2469;
		println!("record_vote weight {} ref_time, fee {fee} base units = ${usd:.4} (target {target})", info.total_weight().ref_time());
		assert!((fee as f64 / target as f64 - 1.0).abs() < 0.05, "vote fee {fee} vs target {target}");
	});
}
