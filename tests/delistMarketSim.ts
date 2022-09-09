import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import {
	BN,
	calculatePrice,
	getMarketOrderParams,
	OracleSource,
	BID_ASK_SPREAD_PRECISION,
	PEG_PRECISION,
	QUOTE_ASSET_BANK_INDEX,
	getTokenAmount,
	BankBalanceType,
	ZERO,
} from '../sdk';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
	Keypair,
	sendAndConfirmTransaction,
	Transaction,
} from '@solana/web3.js';
import { Program } from '@project-serum/anchor';

import {
	Admin,
	ClearingHouseUser,
	// MARK_PRICE_PRECISION,
	AMM_RESERVE_PRECISION,
	QUOTE_PRECISION,
	// calculateMarkPrice,
	PositionDirection,
	EventSubscriber,
	convertToNumber,
	calculateBidAskPrice,
	calculateUpdatedAMM,
	calculateSpread,
	calculateSpreadBN,
	isVariant,
} from '../sdk/src';

import {
	getFeedData,
	initUserAccounts,
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
	getOraclePriceData,
	initializeQuoteAssetBank,
	sleep,
	printTxLogs,
} from './testHelpers';

describe('delist market sim', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	// let userAccountPublicKey: PublicKeys;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	// const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetAmount = new anchor.BN(94).mul(
		AMM_RESERVE_PRECISION
	);
	const ammInitialBaseAssetAmount = new anchor.BN(94).mul(
		AMM_RESERVE_PRECISION
	);

	const usdcAmount = new BN(10000 * 10 ** 6);

	let marketIndexes;
	let bankIndexes;
	let oracleInfos;
	let btcUsd;
	const mockOracles = [];

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)),
			provider
		);

		btcUsd = await mockOracle(21966);
		mockOracles.push(btcUsd);
		for (let i = 1; i <= 4; i++) {
			// init more oracles
			const thisUsd = await mockOracle(i);
			mockOracles.push(thisUsd);
		}

		bankIndexes = [new BN(0)];
		marketIndexes = mockOracles.map((_, i) => new BN(i));
		oracleInfos = mockOracles.map((oracle) => {
			return { publicKey: oracle, source: OracleSource.PYTH };
		});

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: marketIndexes,
			bankIndexes: bankIndexes,
			oracleInfos: oracleInfos,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.updateAuctionDuration(0, 0);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR
		// BTC
		await clearingHouse.initializeMarket(
			btcUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(21_966_868),
			undefined,
			500,
			333
		);
		await clearingHouse.updateMarketBaseSpread(new BN(0), 250);
		await clearingHouse.updateCurveUpdateIntensity(new BN(0), 100);

		for (let i = 1; i <= 4; i++) {
			// init more markets
			const thisUsd = mockOracles[i];
			await clearingHouse.initializeMarket(
				thisUsd,
				ammInitialBaseAssetAmount,
				ammInitialQuoteAssetAmount,
				periodicity,
				new BN(1_000 * i),
				undefined,
				1000
			);
			await clearingHouse.updateMarketBaseSpread(new BN(i), 2000);
			await clearingHouse.updateCurveUpdateIntensity(new BN(i), 100);
		}

		const [, _userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('5 users, 20 trades, single market, user net win, check invariants', async () => {
		// create <NUM_USERS> users with 10k that collectively do <NUM_EVENTS> actions
		const clearingHouseOld = clearingHouse;

		const [_userUSDCAccounts, _user_keys, clearingHouses, _userAccountInfos] =
			await initUserAccounts(
				5,
				usdcMint,
				usdcAmount,
				provider,
				marketIndexes,
				bankIndexes,
				[]
			);
		let count = 0;
		let btcPrice = 19790;
		while (count < 20) {
			console.log(count);

			if (count % 3 == 0) {
				btcPrice *= 1.075;
				// btcPrice *= 1.001;
			} else {
				btcPrice *= 0.999;
				// btcPrice *= 0.925;
			}
			await setFeedPrice(anchor.workspace.Pyth, btcPrice, btcUsd);
			const oraclePriceData = await getOraclePriceData(
				anchor.workspace.Pyth,
				btcUsd
			);

			const market0 = clearingHouse.getMarketAccount(0);
			const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);
			const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);
			const longSpread = calculateSpread(
				prepegAMM,
				PositionDirection.LONG,
				oraclePriceData
			);
			const shortSpread = calculateSpread(
				prepegAMM,
				PositionDirection.SHORT,
				oraclePriceData
			);
			console.log('spreads:', longSpread, shortSpread);
			console.log(
				'bid/oracle/ask:',
				convertToNumber(bid),
				btcPrice,
				convertToNumber(ask)
			);
			let tradeSize =
				0.053 * ((count % 7) + 1) * AMM_RESERVE_PRECISION.toNumber();
			let tradeDirection;
			if (count % 2 == 0) {
				tradeDirection = PositionDirection.LONG;
				tradeSize *= 2;
			} else {
				tradeDirection = PositionDirection.SHORT;
			}

			const orderParams = getMarketOrderParams({
				marketIndex: new BN(0),
				direction: tradeDirection,
				baseAssetAmount: new BN(tradeSize),
			});

			await clearingHouses[count % 5].placeAndTake(orderParams);
			count += 1;
		}

		let allUserCollateral = 0;
		let allUserUnsettledPnl = 0;

		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();
		const userCollateral = convertToNumber(
			clearingHouseUser.getBankAssetValue(),
			QUOTE_PRECISION
		);

		const userUnsettledPnl = convertToNumber(
			clearingHouseUser
				.getUserAccount()
				.positions.reduce((unsettledPnl, position) => {
					return unsettledPnl.add(
						position.quoteAssetAmount.add(position.quoteEntryAmount)
					);
				}, ZERO),
			QUOTE_PRECISION
		);
		console.log('unsettle pnl', userUnsettledPnl);
		allUserCollateral += userCollateral;
		allUserUnsettledPnl += userUnsettledPnl;
		console.log(
			'user',
			0,
			':',
			'$',
			userCollateral,
			'+',
			userUnsettledPnl,
			'(unsettled)'
		);
		await clearingHouseUser.unsubscribe();

		for (let i = 0; i < clearingHouses.length; i++) {
			const clearingHouseI = clearingHouses[i];
			const clearingHouseUserI = _userAccountInfos[i];

			try {
				await clearingHouseI.settlePNL(
					await clearingHouseI.getUserAccountPublicKey(),
					clearingHouseI.getUserAccount(),
					new BN(0)
				);
			} catch (e) {
				console.error(e);
			}
			await sleep(1000);
			await clearingHouseI.fetchAccounts();
			await clearingHouseUserI.fetchAccounts();
			const userCollateral = convertToNumber(
				clearingHouseUserI.getBankAssetValue(),
				QUOTE_PRECISION
			);

			const unsettledPnl = clearingHouseUserI
				.getUserAccount()
				.positions.reduce((unsettledPnl, position) => {
					return unsettledPnl.add(
						position.quoteAssetAmount.add(position.quoteEntryAmount)
					);
				}, ZERO);
			console.log('unsettled pnl', unsettledPnl.toString());
			const userUnsettledPnl = convertToNumber(unsettledPnl, QUOTE_PRECISION);
			allUserCollateral += userCollateral;
			allUserUnsettledPnl += userUnsettledPnl;
			console.log(
				'user',
				i + 1,
				':',
				'$',
				userCollateral,
				'+',
				userUnsettledPnl,
				'(unsettled)'
			);
			await clearingHouseI.unsubscribe();
			await clearingHouseUserI.unsubscribe();
		}

		const market0 = clearingHouseOld.getMarketAccount(0);

		console.log('total Fees:', market0.amm.totalFee.toString());
		console.log(
			'total Fees minus dist:',
			market0.amm.totalFeeMinusDistributions.toString()
		);

		const bankAccount = clearingHouseOld.getBankAccount(QUOTE_ASSET_BANK_INDEX);

		const pnlPoolBalance = convertToNumber(
			getTokenAmount(
				market0.pnlPool.balance,
				bankAccount,
				BankBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		const feePoolBalance = convertToNumber(
			getTokenAmount(
				market0.amm.feePool.balance,
				bankAccount,
				BankBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		const usdcDepositBalance = convertToNumber(
			getTokenAmount(
				bankAccount.depositBalance,
				bankAccount,
				BankBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		const usdcBorrowBalance = convertToNumber(
			getTokenAmount(
				bankAccount.borrowBalance,
				bankAccount,
				BankBalanceType.DEPOSIT
			),
			QUOTE_PRECISION
		);

		console.log(
			'usdc balance:',
			usdcDepositBalance.toString(),
			'-',
			usdcBorrowBalance.toString()
		);

		const sinceStartTFMD = convertToNumber(
			market0.amm.totalFeeMinusDistributions,
			QUOTE_PRECISION
		);

		// assert(allUserCollateral == 60207.47732500001);
		// assert(pnlPoolBalance == 0);
		// assert(feePoolBalance == 0);
		// assert(allUserUnsettledPnl == 599.427406);
		// assert(usdcDepositBalance == 60207.477325);
		// assert(sinceStartTFMD == -601.216949);

		console.log(
			'sum all money:',
			allUserCollateral,
			'+',
			pnlPoolBalance,
			'+',
			feePoolBalance,
			'+',
			allUserUnsettledPnl,
			'+',
			sinceStartTFMD,
			'==',
			usdcDepositBalance - usdcBorrowBalance
		);

		assert(
			Math.abs(
				allUserCollateral +
					pnlPoolBalance +
					feePoolBalance -
					(usdcDepositBalance - usdcBorrowBalance)
			) < 1e-7
		);

		assert(!market0.amm.netBaseAssetAmount.eq(new BN(0)));

		// console.log(market0);

		// todo: doesnt add up perfectly (~$2 off), adjust peg/k not precise?
		// assert(
		// 	Math.abs(
		// 		allUserUnsettledPnl +
		// 			(sinceStartTFMD - (pnlPoolBalance + feePoolBalance))
		// 	) < 2
		// );
	});

	it('put market in reduce only mode', async () => {
		const marketIndex = new BN(0);
		const slot = await connection.getSlot();
		const now = await connection.getBlockTime(slot);
		const expiryTs = new BN(now + 3);

		// await clearingHouse.moveAmmToPrice(
		// 	new BN(0),
		// 	new BN(43.1337 * MARK_PRICE_PRECISION.toNumber())
		// );

		const market0 = clearingHouse.getMarketAccount(marketIndex);
		assert(market0.expiryTs.eq(ZERO));

		await clearingHouse.updateMarketExpiry(marketIndex, expiryTs);
		await sleep(1000);
		clearingHouse.fetchAccounts();

		const market = clearingHouse.getMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'reduceOnly'));
		console.log(
			'market.expiryTs == ',
			market.expiryTs.toString(),
			'(',
			expiryTs.toString(),
			')'
		);
		assert(market.expiryTs.eq(expiryTs));

		console.log('totalExchangeFee:', market.amm.totalExchangeFee.toString());
		console.log('totalFee:', market.amm.totalFee.toString());
		console.log('totalMMFee:', market.amm.totalMmFee.toString());
		console.log(
			'totalFeeMinusDistributions:',
			market.amm.totalFeeMinusDistributions.toString()
		);

		// should fail
		// try {
		// 	await clearingHouseLoser.openPosition(
		// 		PositionDirection.LONG,
		// 		new BN(10000000),
		// 		new BN(0),
		// 		new BN(0)
		// 	);
		// 	assert(false);
		// } catch (e) {
		// 	console.log(e);

		// 	if (!e.toString().search('AnchorError occurred')) {
		// 		assert(false);
		// 	}
		// 	console.log('risk increase trade failed');
		// }

		// should succeed
		// await clearingHouseLoser.openPosition(
		// 	PositionDirection.SHORT,
		// 	new BN(10000000),
		// 	new BN(0),
		// 	new BN(0)
		// );
	});

	it('put market in settlement mode', async () => {
		const marketIndex = new BN(0);
		let slot = await connection.getSlot();
		let now = await connection.getBlockTime(slot);

		const market0 = clearingHouse.getMarketAccount(marketIndex);
		console.log('market0.status:', market0.status);
		while (market0.expiryTs.gte(new BN(now))) {
			console.log(market0.expiryTs.toString(), '>', now);
			await sleep(1000);
			slot = await connection.getSlot();
			now = await connection.getBlockTime(slot);
		}

		// try {
		const txSig = await clearingHouse.settleExpiredMarket(marketIndex);
		// } catch (e) {
		// 	console.error(e);
		// }
		await printTxLogs(connection, txSig);

		clearingHouse.fetchAccounts();

		const market = clearingHouse.getMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'settlement'));
		console.log(
			'market.settlementPrice:',
			convertToNumber(market.settlementPrice)
		);

		const curPrice = (await getFeedData(anchor.workspace.Pyth, btcUsd)).price;
		console.log('new oracle price:', curPrice);
		// const oraclePriceData = await getOraclePriceData(
		// 	anchor.workspace.Pyth,
		// 	btcUsd
		// );

		assert(market.settlementPrice.gt(ZERO));
	});
});