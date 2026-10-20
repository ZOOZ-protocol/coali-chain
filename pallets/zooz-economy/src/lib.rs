//! # ZOOZ economy
//!
//! - **Fees pegged to the dollar.** An oracle account appointed by the foundation publishes the
//!   ZOOZ price; a typical transaction (one vote) then costs `TargetFeeMicroUsd` worth of ZOOZ
//!   whatever the market price. Heavier transactions cost proportionally more. The oracle is
//!   held to a price range, a maximum change per update and a minimum time between updates, so
//!   a manipulated market cannot make fees free or unpayable; fees never fall below `MinFee`.
//! - **Fee split.** Each fee goes to the block author, the foundation and the app that generated
//!   the transaction (`FeeSplit`, default 60/20/20). Without a known app, that share refills Fuel.
//! - **Block rewards.** The block author also receives a reward from the Fuel reservoir, sized
//!   to pay each active validator `ValidatorRewardMicroUsd` per month (a server's cost) at the
//!   oracle price, whatever the number of votes. `BlockReward`, halved every `HalvingInterval`
//!   blocks, caps it so a manipulated price cannot drain Fuel. No token is ever minted after
//!   genesis.
//! - **Buckets.** The genesis supply sits in keyless accounts (Fuel, Development, Investors, Team,
//!   Charity) that only the admin origin can spend from, publicly.

#![cfg_attr(not(feature = "std"), no_std)]

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

use core::marker::PhantomData;
use frame_support::{
	traits::{
		fungible::{Balanced, Credit},
		Contains, Get, Imbalance, NoDrop, OnUnbalanced,
	},
	weights::Weight,
};
use pallet_transaction_payment::{FungibleAdapter, OnChargeTransaction, TxCreditHold};
use sp_runtime::traits::{DispatchInfoOf, PostDispatchInfoOf};

pub type CreditOf<T> = Credit<<T as frame_system::Config>::AccountId, <T as Config>::Currency>;

#[frame_support::pallet]
pub mod pallet {
	use super::*;
	use frame_support::{
		pallet_prelude::*,
		traits::{
			fungible::{Inspect, Mutate},
			tokens::{Fortitude, Preservation},
		},
		PalletId,
	};
	use frame_system::pallet_prelude::*;
	use sp_runtime::{
		traits::{AccountIdConversion, Saturating, Zero},
		Percent,
	};

	#[derive(Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	pub struct PriceLimits<BlockNumber> {
		/// Lowest and highest accepted price, in millionths of a dollar.
		pub min_micro_usd: u64,
		pub max_micro_usd: u64,
		/// Largest change the oracle may publish at once, relative to the current price.
		pub max_change: Percent,
		/// Blocks between two oracle updates.
		pub min_interval: BlockNumber,
	}

	/// Where the genesis supply is kept. Each bucket is a keyless account.
	#[derive(
		Encode,
		Decode,
		DecodeWithMemTracking,
		Clone,
		Copy,
		PartialEq,
		Eq,
		Debug,
		TypeInfo,
		MaxEncodedLen,
	)]
	pub enum Bucket {
		/// Block rewards and participation rewards (65% in the white paper).
		Fuel,
		Development,
		Investors,
		Team,
		Charity,
	}

	impl Bucket {
		fn pallet_id(&self) -> PalletId {
			PalletId(match self {
				Bucket::Fuel => *b"fuel/zoz",
				Bucket::Development => *b"devt/zoz",
				Bucket::Investors => *b"invs/zoz",
				Bucket::Team => *b"team/zoz",
				Bucket::Charity => *b"char/zoz",
			})
		}
	}

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		type Currency: Balanced<Self::AccountId, Balance = u128> + Mutate<Self::AccountId>;
		/// Sets prices, parameters and spends from buckets (the foundation).
		type AdminOrigin: EnsureOrigin<Self::RuntimeOrigin>;
		/// Author of the block being built.
		type BlockAuthor: Get<Option<Self::AccountId>>;
		/// Apps approved by the foundation; they receive the app share of fees.
		type IsApp: Contains<Self::AccountId>;
		/// One ZOOZ in base units.
		#[pallet::constant]
		type Unit: Get<u128>;
		/// `ref_time` of a typical transaction (one vote, base weight included); it pays exactly
		/// the target fee.
		#[pallet::constant]
		type ReferenceWeight: Get<u64>;
		/// Validators in the current session; the block reward grows with it.
		type ValidatorCount: Get<u32>;
		/// Blocks in 30 days, to turn the monthly validator reward into a reward per block.
		#[pallet::constant]
		type BlocksPerMonth: Get<u32>;
	}

	/// Price of 1 ZOOZ in millionths of a dollar.
	#[pallet::storage]
	pub type PriceMicroUsd<T> = StorageValue<_, u64, ValueQuery>;

	/// Fee of a typical transaction, in millionths of a dollar.
	#[pallet::storage]
	pub type TargetFeeMicroUsd<T> = StorageValue<_, u64, ValueQuery>;

	/// Share of each fee for (block author, foundation); the app gets the rest.
	#[pallet::storage]
	pub type FeeSplit<T> = StorageValue<_, (Percent, Percent), ValueQuery>;

	/// Highest reward per block before any halving, in base units, paid from Fuel.
	#[pallet::storage]
	pub type BlockReward<T> = StorageValue<_, u128, ValueQuery>;

	#[pallet::type_value]
	pub fn DefaultValidatorReward() -> u64 {
		6_000_000
	}

	/// What each active validator earns per month from block rewards, in millionths of a dollar
	/// (0 = no block reward, validators live on fees only).
	#[pallet::storage]
	pub type ValidatorRewardMicroUsd<T> = StorageValue<_, u64, ValueQuery, DefaultValidatorReward>;

	/// Blocks between two halvings of the block reward (0 = never).
	#[pallet::storage]
	pub type HalvingInterval<T: Config> = StorageValue<_, BlockNumberFor<T>, ValueQuery>;

	#[pallet::storage]
	pub type Foundation<T: Config> = StorageValue<_, T::AccountId, OptionQuery>;

	/// Account allowed to publish the price, besides the admin origin.
	#[pallet::storage]
	pub type Oracle<T: Config> = StorageValue<_, T::AccountId, OptionQuery>;

	/// App chosen by a user; it receives the app share of that user's fees.
	#[pallet::storage]
	pub type UserApp<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, T::AccountId, OptionQuery>;

	#[pallet::type_value]
	pub fn DefaultPriceLimits<T: Config>() -> PriceLimits<BlockNumberFor<T>> {
		PriceLimits {
			min_micro_usd: 1_000,
			max_micro_usd: 100_000_000,
			max_change: Percent::from_percent(20),
			min_interval: 3_600u32.into(),
		}
	}

	/// Limits on prices published by the oracle (the admin is only held to the range).
	#[pallet::storage]
	pub type PriceLimitsOf<T: Config> =
		StorageValue<_, PriceLimits<BlockNumberFor<T>>, ValueQuery, DefaultPriceLimits<T>>;

	/// Block of the last price published by the oracle.
	#[pallet::storage]
	pub type LastOracleUpdate<T: Config> = StorageValue<_, BlockNumberFor<T>, OptionQuery>;

	#[pallet::type_value]
	pub fn DefaultMinFee<T: Config>() -> u128 {
		T::Unit::get() / 50
	}

	/// Lowest fee of a typical transaction, in base units, whatever the price.
	#[pallet::storage]
	pub type MinFee<T: Config> = StorageValue<_, u128, ValueQuery, DefaultMinFee<T>>;

	/// Payer of the fee being settled; only set during fee settlement.
	#[pallet::storage]
	pub type FeePayer<T: Config> = StorageValue<_, T::AccountId, OptionQuery>;

	#[pallet::genesis_config]
	#[derive(frame_support::DefaultNoBound)]
	pub struct GenesisConfig<T: Config> {
		pub price_micro_usd: u64,
		pub target_fee_micro_usd: u64,
		pub author_percent: u8,
		pub foundation_percent: u8,
		pub block_reward: u128,
		pub halving_interval: BlockNumberFor<T>,
		pub validator_reward_micro_usd: u64,
		pub foundation: Option<T::AccountId>,
		pub oracle: Option<T::AccountId>,
		/// Genesis supply of each bucket, in base units.
		pub fuel: u128,
		pub development: u128,
		pub investors: u128,
		pub team: u128,
		pub charity: u128,
	}

	#[pallet::genesis_build]
	impl<T: Config> BuildGenesisConfig for GenesisConfig<T> {
		fn build(&self) {
			assert!(self.author_percent as u16 + self.foundation_percent as u16 <= 100, "fee split above 100%");
			PriceMicroUsd::<T>::put(self.price_micro_usd);
			TargetFeeMicroUsd::<T>::put(self.target_fee_micro_usd);
			FeeSplit::<T>::put((
				Percent::from_percent(self.author_percent),
				Percent::from_percent(self.foundation_percent),
			));
			BlockReward::<T>::put(self.block_reward);
			HalvingInterval::<T>::put(self.halving_interval);
			ValidatorRewardMicroUsd::<T>::put(self.validator_reward_micro_usd);
			if let Some(f) = &self.foundation {
				Foundation::<T>::put(f);
			}
			if let Some(o) = &self.oracle {
				Oracle::<T>::put(o);
			}
			for (bucket, amount) in [
				(Bucket::Fuel, self.fuel),
				(Bucket::Development, self.development),
				(Bucket::Investors, self.investors),
				(Bucket::Team, self.team),
				(Bucket::Charity, self.charity),
			] {
				if amount > 0 {
					T::Currency::mint_into(&Pallet::<T>::bucket_account(bucket), amount)
						.expect("genesis bucket mint");
				}
			}
		}
	}

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		PriceSet { micro_usd: u64 },
		TargetFeeSet { micro_usd: u64 },
		FeeSplitSet { author: Percent, foundation: Percent },
		BlockRewardSet { reward: u128, halving_interval: BlockNumberFor<T> },
		ValidatorRewardSet { micro_usd: u64 },
		FoundationSet { who: T::AccountId },
		OracleSet { who: Option<T::AccountId> },
		Spent { bucket: Bucket, to: T::AccountId, amount: u128 },
		AppChosen { who: T::AccountId, app: Option<T::AccountId> },
		PriceLimitsSet { limits: PriceLimits<BlockNumberFor<T>> },
		MinFeeSet { amount: u128 },
	}

	#[pallet::error]
	pub enum Error<T> {
		ZeroPrice,
		SplitAbove100,
		NotAnApp,
		/// Outside the accepted price range.
		PriceOutOfRange,
		/// The oracle moved the price by more than the allowed change.
		PriceChangeTooLarge,
		/// The oracle published again before the minimum interval.
		PriceUpdateTooSoon,
		BadPriceLimits,
	}

	#[pallet::hooks]
	impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
		fn on_initialize(n: BlockNumberFor<T>) -> Weight {
			Self::reward_author(n);
			T::DbWeight::get().reads_writes(8, 2)
		}
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Publish the ZOOZ price. The admin is held to the price range; the oracle also to the
		/// maximum change and the minimum interval (`PriceLimitsOf`).
		#[pallet::call_index(0)]
		#[pallet::weight(T::DbWeight::get().reads_writes(4, 2))]
		pub fn set_price(origin: OriginFor<T>, micro_usd: u64) -> DispatchResult {
			let by_admin = T::AdminOrigin::try_origin(origin.clone()).is_ok();
			if !by_admin {
				let who = ensure_signed(origin)?;
				ensure!(Oracle::<T>::get().as_ref() == Some(&who), DispatchError::BadOrigin);
			}
			ensure!(micro_usd > 0, Error::<T>::ZeroPrice);
			let limits = PriceLimitsOf::<T>::get();
			ensure!(
				(limits.min_micro_usd..=limits.max_micro_usd).contains(&micro_usd),
				Error::<T>::PriceOutOfRange
			);
			if !by_admin {
				let now = frame_system::Pallet::<T>::block_number();
				if let Some(last) = LastOracleUpdate::<T>::get() {
					ensure!(now >= last.saturating_add(limits.min_interval), Error::<T>::PriceUpdateTooSoon);
				}
				let current = PriceMicroUsd::<T>::get();
				if current > 0 {
					let allowed = limits.max_change.mul_ceil(current);
					ensure!(micro_usd.abs_diff(current) <= allowed, Error::<T>::PriceChangeTooLarge);
				}
				LastOracleUpdate::<T>::put(now);
			}
			PriceMicroUsd::<T>::put(micro_usd);
			Self::deposit_event(Event::PriceSet { micro_usd });
			Ok(())
		}

		#[pallet::call_index(1)]
		#[pallet::weight(T::DbWeight::get().writes(1))]
		pub fn set_target_fee(origin: OriginFor<T>, micro_usd: u64) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			TargetFeeMicroUsd::<T>::put(micro_usd);
			Self::deposit_event(Event::TargetFeeSet { micro_usd });
			Ok(())
		}

		#[pallet::call_index(2)]
		#[pallet::weight(T::DbWeight::get().writes(1))]
		pub fn set_fee_split(origin: OriginFor<T>, author: Percent, foundation: Percent) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			ensure!(
				author.deconstruct() as u16 + foundation.deconstruct() as u16 <= 100,
				Error::<T>::SplitAbove100
			);
			FeeSplit::<T>::put((author, foundation));
			Self::deposit_event(Event::FeeSplitSet { author, foundation });
			Ok(())
		}

		/// Cap on the reward per block (before halvings) and the halving interval.
		#[pallet::call_index(3)]
		#[pallet::weight(T::DbWeight::get().writes(2))]
		pub fn set_block_reward(
			origin: OriginFor<T>,
			reward: u128,
			halving_interval: BlockNumberFor<T>,
		) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			BlockReward::<T>::put(reward);
			HalvingInterval::<T>::put(halving_interval);
			Self::deposit_event(Event::BlockRewardSet { reward, halving_interval });
			Ok(())
		}

		#[pallet::call_index(4)]
		#[pallet::weight(T::DbWeight::get().writes(1))]
		pub fn set_foundation(origin: OriginFor<T>, who: T::AccountId) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			Foundation::<T>::put(&who);
			Self::deposit_event(Event::FoundationSet { who });
			Ok(())
		}

		#[pallet::call_index(5)]
		#[pallet::weight(T::DbWeight::get().writes(1))]
		pub fn set_oracle(origin: OriginFor<T>, who: Option<T::AccountId>) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			Oracle::<T>::set(who.clone());
			Self::deposit_event(Event::OracleSet { who });
			Ok(())
		}

		/// Public spend from a genesis bucket.
		#[pallet::call_index(6)]
		#[pallet::weight(T::DbWeight::get().reads_writes(2, 2).saturating_add(Weight::from_parts(50_000_000, 0)))]
		pub fn spend(origin: OriginFor<T>, bucket: Bucket, to: T::AccountId, amount: u128) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			T::Currency::transfer(&Self::bucket_account(bucket), &to, amount, Preservation::Expendable)?;
			Self::deposit_event(Event::Spent { bucket, to, amount });
			Ok(())
		}

		#[pallet::call_index(8)]
		#[pallet::weight(T::DbWeight::get().writes(1))]
		pub fn set_price_limits(origin: OriginFor<T>, limits: PriceLimits<BlockNumberFor<T>>) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			ensure!(
				limits.min_micro_usd > 0 && limits.min_micro_usd <= limits.max_micro_usd,
				Error::<T>::BadPriceLimits
			);
			PriceLimitsOf::<T>::put(limits.clone());
			Self::deposit_event(Event::PriceLimitsSet { limits });
			Ok(())
		}

		#[pallet::call_index(9)]
		#[pallet::weight(T::DbWeight::get().writes(1))]
		pub fn set_min_fee(origin: OriginFor<T>, amount: u128) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			MinFee::<T>::put(amount);
			Self::deposit_event(Event::MinFeeSet { amount });
			Ok(())
		}

		/// Monthly block reward of each active validator, in millionths of a dollar.
		#[pallet::call_index(10)]
		#[pallet::weight(T::DbWeight::get().writes(1))]
		pub fn set_validator_reward(origin: OriginFor<T>, micro_usd: u64) -> DispatchResult {
			T::AdminOrigin::ensure_origin(origin)?;
			ValidatorRewardMicroUsd::<T>::put(micro_usd);
			Self::deposit_event(Event::ValidatorRewardSet { micro_usd });
			Ok(())
		}

		/// Choose the app that receives the app share of your fees (`None` to clear).
		#[pallet::call_index(7)]
		#[pallet::weight(T::DbWeight::get().reads_writes(1, 1))]
		pub fn choose_app(origin: OriginFor<T>, app: Option<T::AccountId>) -> DispatchResult {
			let who = ensure_signed(origin)?;
			match &app {
				Some(a) => {
					ensure!(T::IsApp::contains(a), Error::<T>::NotAnApp);
					UserApp::<T>::insert(&who, a);
				},
				None => UserApp::<T>::remove(&who),
			}
			Self::deposit_event(Event::AppChosen { who, app });
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		pub fn bucket_account(bucket: Bucket) -> T::AccountId {
			bucket.pallet_id().into_account_truncating()
		}

		/// Fee of a typical transaction, in base units, at the current price, never below `MinFee`.
		pub fn target_fee() -> u128 {
			let price = PriceMicroUsd::<T>::get().max(1) as u128;
			((TargetFeeMicroUsd::<T>::get() as u128).saturating_mul(T::Unit::get()) / price).max(MinFee::<T>::get())
		}

		pub fn weight_fee(ref_time: u64) -> u128 {
			Self::target_fee().saturating_mul(ref_time as u128) / (T::ReferenceWeight::get().max(1) as u128)
		}

		/// About 10% of the target fee for a 200-byte transaction.
		pub fn length_fee(len: u32) -> u128 {
			Self::target_fee().saturating_mul(len as u128) / 2_000
		}

		/// Highest block reward at block `n`, after halvings.
		pub fn reward_cap_at(n: BlockNumberFor<T>) -> u128 {
			let interval = HalvingInterval::<T>::get();
			let halvings: u32 = if interval.is_zero() {
				0
			} else {
				TryInto::<u32>::try_into(n / interval).unwrap_or(u32::MAX)
			};
			if halvings >= 128 {
				0
			} else {
				BlockReward::<T>::get() >> halvings
			}
		}

		/// Reward per block that pays every active validator `ValidatorRewardMicroUsd` a month at
		/// the current price, in base units. Computed in base units so that a fraction of a
		/// micro-dollar per block is not rounded away.
		pub fn usd_reward() -> u128 {
			let monthly = ValidatorRewardMicroUsd::<T>::get() as u128;
			let validators = T::ValidatorCount::get() as u128;
			let price = PriceMicroUsd::<T>::get().max(1) as u128;
			let blocks = (T::BlocksPerMonth::get() as u128).max(1);
			monthly
				.saturating_mul(validators)
				.saturating_mul(T::Unit::get())
				/ blocks.saturating_mul(price)
		}

		/// Block reward at block `n`: the dollar-pegged reward, never above the halved cap.
		pub fn reward_at(n: BlockNumberFor<T>) -> u128 {
			Self::usd_reward().min(Self::reward_cap_at(n))
		}

		fn reward_author(n: BlockNumberFor<T>) {
			let reward = Self::reward_at(n);
			if reward.is_zero() {
				return;
			}
			let Some(author) = T::BlockAuthor::get() else { return };
			let fuel = Self::bucket_account(Bucket::Fuel);
			let available = T::Currency::reducible_balance(&fuel, Preservation::Expendable, Fortitude::Polite);
			let amount = reward.min(available);
			if !amount.is_zero() {
				let _ = T::Currency::transfer(&fuel, &author, amount, Preservation::Expendable);
			}
		}

		/// App credited for fees paid by `payer`: the payer itself if it is an app, else its choice.
		pub fn app_of(payer: &T::AccountId) -> Option<T::AccountId> {
			if T::IsApp::contains(payer) {
				Some(payer.clone())
			} else {
				UserApp::<T>::get(payer)
			}
		}

		pub(crate) fn distribute(fee: CreditOf<T>) {
			let total = fee.peek();
			let (author_share, foundation_share) = FeeSplit::<T>::get();
			let (to_author, rest) = fee.split(author_share * total);
			let (to_foundation, to_app) = rest.split(foundation_share * total);
			let app = FeePayer::<T>::get().and_then(|p| Self::app_of(&p));
			Self::pay(T::BlockAuthor::get(), to_author);
			Self::pay(Foundation::<T>::get(), to_foundation);
			Self::pay(app, to_app);
		}

		/// Pays `to`, or Fuel when `to` is unknown or cannot receive it (below the existential deposit).
		fn pay(to: Option<T::AccountId>, credit: CreditOf<T>) {
			if credit.peek().is_zero() {
				return;
			}
			let fuel = Self::bucket_account(Bucket::Fuel);
			let credit = match to {
				Some(to) => match T::Currency::resolve(&to, credit) {
					Ok(()) => return,
					Err(c) => c,
				},
				None => credit,
			};
			let _ = T::Currency::resolve(&fuel, credit);
		}
	}
}

/// Fee per unit of weight, pegged to the target fee in dollars.
pub struct WeightToFee<T>(PhantomData<T>);
impl<T: Config> frame_support::weights::WeightToFee for WeightToFee<T> {
	type Balance = u128;
	fn weight_to_fee(weight: &Weight) -> u128 {
		Pallet::<T>::weight_fee(weight.ref_time())
	}
}

/// Fee per byte, pegged to the target fee in dollars.
pub struct LengthToFee<T>(PhantomData<T>);
impl<T: Config> frame_support::weights::WeightToFee for LengthToFee<T> {
	type Balance = u128;
	fn weight_to_fee(weight: &Weight) -> u128 {
		Pallet::<T>::length_fee(weight.ref_time().min(u32::MAX as u64) as u32)
	}
}

/// Splits fees and tips between block author, foundation and app.
pub struct DealWithFees<T>(PhantomData<T>);
impl<T: Config> OnUnbalanced<CreditOf<T>> for DealWithFees<T> {
	fn on_nonzero_unbalanced(fee: CreditOf<T>) {
		Pallet::<T>::distribute(fee);
	}
}

/// `FungibleAdapter` that remembers who paid, so the app share can be credited.
pub struct ZoozFeeAdapter<T>(PhantomData<T>);

type Inner<T> = FungibleAdapter<<T as Config>::Currency, DealWithFees<T>>;

impl<T> TxCreditHold<T> for ZoozFeeAdapter<T>
where
	T: Config + pallet_transaction_payment::Config,
{
	type Credit = NoDrop<CreditOf<T>>;
}

impl<T> OnChargeTransaction<T> for ZoozFeeAdapter<T>
where
	T: Config + pallet_transaction_payment::Config,
	T::OnChargeTransaction: TxCreditHold<T, Credit = NoDrop<CreditOf<T>>>,
{
	type Balance = u128;
	type LiquidityInfo = <Inner<T> as OnChargeTransaction<T>>::LiquidityInfo;

	fn withdraw_fee(
		who: &T::AccountId,
		call: &T::RuntimeCall,
		info: &DispatchInfoOf<T::RuntimeCall>,
		fee_with_tip: u128,
		tip: u128,
	) -> Result<Self::LiquidityInfo, frame_support::unsigned::TransactionValidityError> {
		<Inner<T> as OnChargeTransaction<T>>::withdraw_fee(who, call, info, fee_with_tip, tip)
	}

	fn can_withdraw_fee(
		who: &T::AccountId,
		call: &T::RuntimeCall,
		info: &DispatchInfoOf<T::RuntimeCall>,
		fee_with_tip: u128,
		tip: u128,
	) -> Result<(), frame_support::unsigned::TransactionValidityError> {
		<Inner<T> as OnChargeTransaction<T>>::can_withdraw_fee(who, call, info, fee_with_tip, tip)
	}

	fn correct_and_deposit_fee(
		who: &T::AccountId,
		info: &DispatchInfoOf<T::RuntimeCall>,
		post_info: &PostDispatchInfoOf<T::RuntimeCall>,
		corrected_fee_with_tip: u128,
		tip: u128,
		liquidity_info: Self::LiquidityInfo,
	) -> Result<(), frame_support::unsigned::TransactionValidityError> {
		FeePayer::<T>::put(who);
		let result = <Inner<T> as OnChargeTransaction<T>>::correct_and_deposit_fee(
			who,
			info,
			post_info,
			corrected_fee_with_tip,
			tip,
			liquidity_info,
		);
		FeePayer::<T>::kill();
		result
	}

	#[cfg(feature = "runtime-benchmarks")]
	fn endow_account(who: &T::AccountId, amount: u128) {
		<Inner<T> as OnChargeTransaction<T>>::endow_account(who, amount)
	}

	#[cfg(feature = "runtime-benchmarks")]
	fn minimum_balance() -> u128 {
		<Inner<T> as OnChargeTransaction<T>>::minimum_balance()
	}
}
