// This file is part of Substrate.

// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// 	http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use crate::{
	configs::FIRST_ASSET_ID, AccountId, AssetsConfig, BalancesConfig, CoaliLedgerConfig, ProofOfTrustConfig, RuntimeGenesisConfig, SessionConfig,
	SessionKeys, SudoConfig, ZoozEconomyConfig, UNIT,
};

/// 770M ZOOZ cap minus the 10,356,360 already burned on BSC.
pub const TOTAL_SUPPLY: u128 = 759_643_640 * UNIT;
const ENDOWMENT: u128 = 1_000_000 * UNIT;

use alloc::{vec, vec::Vec};
use frame_support::build_struct_json_patch;
use serde_json::Value;
use sp_consensus_aura::sr25519::AuthorityId as AuraId;
use sp_consensus_grandpa::AuthorityId as GrandpaId;
use sp_genesis_builder::{self, PresetId};
use sp_keyring::Sr25519Keyring;

// Returns the genesis config presets populated with given parameters.
fn testnet_genesis(
	initial_authorities: Vec<(AccountId, AuraId, GrandpaId)>,
	endowed_accounts: Vec<AccountId>,
	root: AccountId,
) -> Value {
	build_struct_json_patch!(RuntimeGenesisConfig {
		balances: BalancesConfig {
			balances: endowed_accounts.iter().cloned().map(|k| (k, ENDOWMENT)).collect::<Vec<_>>(),
		},
		// White paper split; test endowments are carved out of Development.
		zooz_economy: ZoozEconomyConfig {
			price_micro_usd: 246_900,
			target_fee_micro_usd: 50_000,
			author_percent: 60,
			foundation_percent: 20,
			// Each active validator earns $6 a month from block rewards (a server's cost);
			// block_reward is only the cap.
			validator_reward_micro_usd: 6_000_000,
			block_reward: 5 * UNIT / 2,
			halving_interval: 21_000_000,
			foundation: Some(root.clone()),
			fuel: TOTAL_SUPPLY * 65 / 100,
			development: TOTAL_SUPPLY * 10 / 100 - ENDOWMENT * endowed_accounts.len() as u128,
			investors: TOTAL_SUPPLY * 3 / 100,
			team: TOTAL_SUPPLY * 12 / 100,
			charity: TOTAL_SUPPLY * 10 / 100,
		},
		// Aura and GRANDPA authorities come from the session keys of the founders.
		session: SessionConfig {
			keys: initial_authorities
				.iter()
				.map(|(acc, aura, grandpa)| {
					(acc.clone(), acc.clone(), SessionKeys { aura: aura.clone(), grandpa: grandpa.clone() })
				})
				.collect::<Vec<_>>(),
		},
		proof_of_trust: ProofOfTrustConfig {
			founders: initial_authorities.iter().map(|x| x.0.clone()).collect::<Vec<_>>(),
			min_trust: 1,
			identity_attesters: vec![root.clone()],
		},
		sudo: SudoConfig { key: Some(root.clone()) },
		coali_ledger: CoaliLedgerConfig { attesters: vec![root] },
		assets: AssetsConfig { next_asset_id: Some(FIRST_ASSET_ID) },
	})
}

/// Return the development genesis config.
pub fn development_config_genesis() -> Value {
	testnet_genesis(
		vec![(
				Sr25519Keyring::Alice.to_account_id(),
				sp_keyring::Sr25519Keyring::Alice.public().into(),
				sp_keyring::Ed25519Keyring::Alice.public().into(),
			)],
		vec![
			Sr25519Keyring::Alice.to_account_id(),
			Sr25519Keyring::Bob.to_account_id(),
			Sr25519Keyring::AliceStash.to_account_id(),
			Sr25519Keyring::BobStash.to_account_id(),
		],
		sp_keyring::Sr25519Keyring::Alice.to_account_id(),
	)
}

/// Return the local genesis config preset.
pub fn local_config_genesis() -> Value {
	testnet_genesis(
		vec![
			(
				Sr25519Keyring::Alice.to_account_id(),
				sp_keyring::Sr25519Keyring::Alice.public().into(),
				sp_keyring::Ed25519Keyring::Alice.public().into(),
			),
			(
				Sr25519Keyring::Bob.to_account_id(),
				sp_keyring::Sr25519Keyring::Bob.public().into(),
				sp_keyring::Ed25519Keyring::Bob.public().into(),
			),
			(
				Sr25519Keyring::Charlie.to_account_id(),
				sp_keyring::Sr25519Keyring::Charlie.public().into(),
				sp_keyring::Ed25519Keyring::Charlie.public().into(),
			),
		],
		Sr25519Keyring::iter()
			.filter(|v| v != &Sr25519Keyring::One && v != &Sr25519Keyring::Two)
			.map(|v| v.to_account_id())
			.collect::<Vec<_>>(),
		Sr25519Keyring::Alice.to_account_id(),
	)
}

/// Provides the JSON representation of predefined genesis config for given `id`.
pub fn get_preset(id: &PresetId) -> Option<Vec<u8>> {
	let patch = match id.as_ref() {
		sp_genesis_builder::DEV_RUNTIME_PRESET => development_config_genesis(),
		sp_genesis_builder::LOCAL_TESTNET_RUNTIME_PRESET => local_config_genesis(),
		_ => return None,
	};
	Some(
		serde_json::to_string(&patch)
			.expect("serialization to json is expected to work. qed.")
			.into_bytes(),
	)
}

/// List of supported presets.
pub fn preset_names() -> Vec<PresetId> {
	vec![
		PresetId::from(sp_genesis_builder::DEV_RUNTIME_PRESET),
		PresetId::from(sp_genesis_builder::LOCAL_TESTNET_RUNTIME_PRESET),
	]
}
