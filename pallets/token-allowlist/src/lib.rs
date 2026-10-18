//! # Token allowlist
//!
//! Optional rule for any token: once its manager turns the restriction on, only accounts on the
//! token's allowlist may receive it (transfers and mints to anyone else are refused). Meant for
//! regulated tokens such as real estate shares, where holders must be verified people.
//!
//! A manager can also lock the token for good, renouncing its powers: the runtime then refuses
//! to mint, destroy, rename or restrict it.
//!
//! The pallet only stores the rules; the runtime enforces it on the token calls (see
//! [`Pallet::can_receive`]). Who manages a token is answered by the runtime too
//! ([`Config::Managers`]), so the pallet does not depend on a particular token pallet.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

/// Whether `who` may manage the allowlist of `asset` (its owner or admin).
pub trait TokenManagers<AssetId, AccountId> {
	fn is_manager(asset: &AssetId, who: &AccountId) -> bool;
}

#[frame_support::pallet]
pub mod pallet {
	use super::TokenManagers;
	use frame_support::pallet_prelude::*;
	use frame_system::pallet_prelude::*;
	use alloc::vec::Vec;

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
		type AssetId: Member + Parameter + MaxEncodedLen + Copy;
		type Managers: TokenManagers<Self::AssetId, Self::AccountId>;
		/// Accounts added or removed in one call.
		#[pallet::constant]
		type MaxAccountsPerCall: Get<u32>;
	}

	/// Tokens whose receivers must be on the allowlist.
	#[pallet::storage]
	pub type Restricted<T: Config> = StorageMap<_, Blake2_128Concat, T::AssetId, (), OptionQuery>;

	/// Allowlist of each token.
	#[pallet::storage]
	pub type Allowed<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		T::AssetId,
		Blake2_128Concat,
		T::AccountId,
		(),
		OptionQuery,
	>;

	/// Tokens whose supply is locked forever.
	#[pallet::storage]
	pub type FixedSupply<T: Config> = StorageMap<_, Blake2_128Concat, T::AssetId, (), OptionQuery>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		RestrictionSet { asset: T::AssetId, restricted: bool },
		AccountAllowed { asset: T::AssetId, who: T::AccountId },
		AccountRemoved { asset: T::AssetId, who: T::AccountId },
		SupplyFixed { asset: T::AssetId },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// Only the token's owner or admin can do this.
		NotManager,
		/// Too many accounts in one call.
		TooManyAccounts,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Turn the allowlist rule on or off for a token.
		#[pallet::call_index(0)]
		#[pallet::weight(T::DbWeight::get().reads_writes(2, 1))]
		pub fn set_restricted(origin: OriginFor<T>, asset: T::AssetId, restricted: bool) -> DispatchResult {
			let who = ensure_signed(origin)?;
			ensure!(T::Managers::is_manager(&asset, &who), Error::<T>::NotManager);
			if restricted {
				Restricted::<T>::insert(asset, ());
			} else {
				Restricted::<T>::remove(asset);
			}
			Self::deposit_event(Event::RestrictionSet { asset, restricted });
			Ok(())
		}

		/// Add accounts to a token's allowlist.
		#[pallet::call_index(1)]
		#[pallet::weight(T::DbWeight::get().reads_writes(2, accounts.len() as u64))]
		pub fn allow(origin: OriginFor<T>, asset: T::AssetId, accounts: Vec<T::AccountId>) -> DispatchResult {
			let who = ensure_signed(origin)?;
			ensure!(accounts.len() as u32 <= T::MaxAccountsPerCall::get(), Error::<T>::TooManyAccounts);
			ensure!(T::Managers::is_manager(&asset, &who), Error::<T>::NotManager);
			for account in accounts {
				Allowed::<T>::insert(asset, &account, ());
				Self::deposit_event(Event::AccountAllowed { asset, who: account });
			}
			Ok(())
		}

		/// Remove accounts from a token's allowlist. Their balance stays; they can no longer receive.
		#[pallet::call_index(2)]
		#[pallet::weight(T::DbWeight::get().reads_writes(2, accounts.len() as u64))]
		pub fn remove(origin: OriginFor<T>, asset: T::AssetId, accounts: Vec<T::AccountId>) -> DispatchResult {
			let who = ensure_signed(origin)?;
			ensure!(accounts.len() as u32 <= T::MaxAccountsPerCall::get(), Error::<T>::TooManyAccounts);
			ensure!(T::Managers::is_manager(&asset, &who), Error::<T>::NotManager);
			for account in accounts {
				Allowed::<T>::remove(asset, &account);
				Self::deposit_event(Event::AccountRemoved { asset, who: account });
			}
			Ok(())
		}

		/// Lock a token forever: nobody can mint, destroy, rename or restrict it anymore (enforced
		/// by the runtime). Cannot be undone.
		#[pallet::call_index(3)]
		#[pallet::weight(T::DbWeight::get().reads_writes(2, 1))]
		pub fn fix_supply(origin: OriginFor<T>, asset: T::AssetId) -> DispatchResult {
			let who = ensure_signed(origin)?;
			ensure!(T::Managers::is_manager(&asset, &who), Error::<T>::NotManager);
			FixedSupply::<T>::insert(asset, ());
			Self::deposit_event(Event::SupplyFixed { asset });
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		/// Whether new units of `asset` may still be minted.
		pub fn can_mint(asset: &T::AssetId) -> bool {
			!FixedSupply::<T>::contains_key(asset)
		}

		/// Whether `who` may receive `asset`.
		pub fn can_receive(asset: &T::AssetId, who: &T::AccountId) -> bool {
			!Restricted::<T>::contains_key(asset) || Allowed::<T>::contains_key(asset, who)
		}
	}
}
