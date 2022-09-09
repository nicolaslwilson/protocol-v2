import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { PublicKey } from '@solana/web3.js';

import {
	Wallet,
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	Admin,
	ClearingHouse,
	findComputeUnitConsumption,
	convertToNumber,
	MARK_PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	QUOTE_PRECISION,
	ClearingHouseUser,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteAssetBank,
	createUserWithUSDCAndWSOLAccount,
	createWSolTokenAccountForUser,
	initializeSolAssetBank,
	printTxLogs,
	getFeedData,
	getOraclePriceData,
	sleep,
} from './testHelpers';
import { AMM_RESERVE_PRECISION, isVariant, MARGIN_PRECISION } from '../sdk';
import {
	Keypair,
	sendAndConfirmTransaction,
	Transaction,
} from '@solana/web3.js';

async function depositToFeePoolFromIF(
	amount: number,
	clearingHouse: Admin,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());
	const state = await clearingHouse.getStateAccount();
	const tokenIx = Token.createTransferInstruction(
		TOKEN_PROGRAM_ID,
		userUSDCAccount.publicKey,
		state.insuranceVault,
		clearingHouse.provider.wallet.publicKey,
		// usdcMint.publicKey,
		[],
		ifAmount.toNumber()
	);

	await sendAndConfirmTransaction(
		clearingHouse.provider.connection,
		new Transaction().add(tokenIx),
		// @ts-ignore
		[clearingHouse.provider.wallet.payer],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);

	// // send $50 to market from IF
	const txSig00 = await clearingHouse.withdrawFromInsuranceVaultToMarket(
		new BN(0),
		ifAmount
	);
	console.log(txSig00);
}

describe('delist market, liquidation of expired position', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;
	let userUSDCAccount2;
	let userWSOLAccount;

	let clearingHouseLoser: ClearingHouse;
	let clearingHouseLoserUser: ClearingHouseUser;

	let liquidatorClearingHouse: ClearingHouse;
	let liquidatorClearingHouseWSOLAccount: PublicKey;

	let solOracle: PublicKey;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(AMM_RESERVE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(1000 * 10 ** 6);
	const userKeypair = new Keypair();

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(10)),
			provider
		);
		userWSOLAccount = await createWSolTokenAccountForUser(
			provider,
			// @ts-ignore
			provider.wallet,
			ZERO
		);

		solOracle = await mockOracle(43.1337);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0), new BN(1)],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await initializeSolAssetBank(clearingHouse, solOracle);
		await clearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		const periodicity = new BN(0);

		await clearingHouse.initializeMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(43_133),
			undefined,
			1000,
			900 // easy to liq
		);

		// await clearingHouse.updateMarketBaseSpread(new BN(0), 2000);
		// await clearingHouse.updateCurveUpdateIntensity(new BN(0), 100);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		userUSDCAccount2 = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		clearingHouseLoser = new Admin({
			connection,
			wallet: new Wallet(userKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0), new BN(1)],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});
		await clearingHouseLoser.subscribe();
		await clearingHouseLoser.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount2.publicKey
		);

		clearingHouseLoserUser = new ClearingHouseUser({
			clearingHouse: clearingHouseLoser,
			userAccountPublicKey: await clearingHouseLoser.getUserAccountPublicKey(),
		});
		await clearingHouseLoserUser.subscribe();

		// [, whaleAccountPublicKey] =
		// await whaleClearingHouse.initializeUserAccountAndDepositCollateral(
		//     usdcAmountWhale,
		//     whaleUSDCAccount.publicKey
		// );

		// whaleUser = new ClearingHouseUser({
		//     clearingHouse: whaleClearingHouse,
		//     userAccountPublicKey: await whaleClearingHouse.getUserAccountPublicKey(),
		// });

		// await whaleUser.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseLoser.unsubscribe();
		await clearingHouseLoserUser.unsubscribe();
		// await liquidatorClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('put market in big drawdown and net user negative pnl', async () => {
		await depositToFeePoolFromIF(1000, clearingHouse, userUSDCAccount);

		try {
			await clearingHouse.openPosition(
				PositionDirection.SHORT,
				BASE_PRECISION,
				new BN(0),
				new BN(0)
			);
		} catch (e) {
			console.log('clearingHouse.openPosition');

			console.error(e);
		}

		const uL = clearingHouseLoserUser.getUserAccount();
		console.log(
			'uL.bankBalances[0].balance:',
			uL.bankBalances[0].balance.toString()
		);
		assert(uL.bankBalances[0].balance.eq(new BN(1000 * 1e6)));

		const bank0Value = clearingHouseLoserUser.getBankAssetValue(new BN(0));
		console.log('uL.bank0Value:', bank0Value.toString());
		assert(bank0Value.eq(new BN(1000 * 1e6)));

		const clearingHouseLoserUserValue = convertToNumber(
			clearingHouseLoserUser.getTotalCollateral(),
			QUOTE_PRECISION
		);

		console.log('clearingHouseLoserUserValue:', clearingHouseLoserUserValue);
		assert(clearingHouseLoserUserValue == 1000); // ??

		// todo
		try {
			await clearingHouseLoser.openPosition(
				PositionDirection.LONG,
				BASE_PRECISION.mul(new BN(205)),
				new BN(0),
				new BN(0)
			);
		} catch (e) {
			console.log('clearingHouseLoserc.openPosition');

			console.error(e);
		}

		await clearingHouseLoser.fetchAccounts();
		await clearingHouseLoserUser.fetchAccounts();

		const clearingHouseLoserUserLeverage = convertToNumber(
			clearingHouseLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const clearingHouseLoserUserLiqPrice = convertToNumber(
			clearingHouseLoserUser.liquidationPrice({
				marketIndex: new BN(0),
			}),
			MARK_PRICE_PRECISION
		);

		console.log(
			'clearingHouseLoserUser.getLeverage:',
			clearingHouseLoserUserLeverage,
			'clearingHouseLoserUserLiqPrice:',
			clearingHouseLoserUserLiqPrice
		);

		assert(clearingHouseLoserUserLeverage == 8.9209);
		assert(clearingHouseLoserUserLiqPrice < 42.09);
		assert(clearingHouseLoserUserLiqPrice > 42);

		const market00 = clearingHouse.getMarketAccount(new BN(0));
		assert(market00.amm.feePool.balance.eq(new BN(1000000000)));

		// sol tanks 90%
		await clearingHouse.moveAmmToPrice(
			new BN(0),
			new BN(38 * MARK_PRICE_PRECISION.toNumber())
		);
		await setFeedPrice(anchor.workspace.Pyth, 38, solOracle);
		console.log('price move to $38, user should be bankrupt');

		await clearingHouseLoser.fetchAccounts();
		await clearingHouseLoserUser.fetchAccounts();

		const clearingHouseLoserUserLeverage2 = convertToNumber(
			clearingHouseLoserUser.getLeverage(),
			MARGIN_PRECISION
		);
		const clearingHouseLoserUserLiqPrice2 = convertToNumber(
			clearingHouseLoserUser.liquidationPrice({
				marketIndex: new BN(0),
			}),
			MARK_PRICE_PRECISION
		);

		console.log(
			'clearingHouseLoserUser.getLeverage2:',
			clearingHouseLoserUserLeverage2,
			'clearingHouseLoserUserLiqPrice2:',
			clearingHouseLoserUserLiqPrice2
		);

		const solAmount = new BN(1 * 10 ** 9);
		[liquidatorClearingHouse, liquidatorClearingHouseWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[new BN(0)],
				[new BN(0), new BN(1)],
				[
					{
						publicKey: solOracle,
						source: OracleSource.PYTH,
					},
				]
			);
		await liquidatorClearingHouse.subscribe();

		const bankIndex = new BN(1);
		await liquidatorClearingHouse.deposit(
			solAmount,
			bankIndex,
			liquidatorClearingHouseWSOLAccount
		);

		const market0 = clearingHouse.getMarketAccount(new BN(0));
		const winnerUser = clearingHouse.getUserAccount();
		const loserUser = clearingHouseLoser.getUserAccount();
		console.log(winnerUser.positions[0].quoteAssetAmount.toString());
		console.log(loserUser.positions[0].quoteAssetAmount.toString());

		// TODO: quoteAssetAmountShort!= sum of users
		// assert(
		// 	market0.amm.quoteAssetAmountShort.eq(
		// 		winnerUser.positions[0].quoteAssetAmount
		// 	)
		// );

		// assert(
		// 	market0.amm.quoteAssetAmountLong.eq(
		// 		loserUser.positions[0].quoteAssetAmount
		// 	)
		// );

		// const solBorrow = new BN(5 * 10 ** 8);
		// await clearingHouse.withdraw(solBorrow, new BN(1), userWSOLAccount);
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

		const curPrice = (await getFeedData(anchor.workspace.Pyth, solOracle))
			.price;
		console.log('new oracle price:', curPrice);
		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			solOracle
		);

		assert(market.settlementPrice.gt(ZERO));
	});

	it('settle expired market position', async () => {
		const marketIndex = new BN(0);
		const loserUser0 = clearingHouseLoser.getUserAccount();
		assert(loserUser0.positions[0].baseAssetAmount.gt(new BN(0)));
		assert(loserUser0.positions[0].quoteAssetAmount.lt(new BN(0)));
		console.log(loserUser0.positions[0]);

		const txSig = await clearingHouseLoser.settleExpiredPosition(
			await clearingHouseLoser.getUserAccountPublicKey(),
			clearingHouseLoser.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig);

		try {
			await clearingHouse.settlePNL(
				await clearingHouse.getUserAccountPublicKey(),
				clearingHouse.getUserAccount(),
				marketIndex
			);
		} catch (e) {
			// if (!e.toString().search('AnchorError occurred')) {
			// 	assert(false);
			// }
			console.log('Cannot settle pnl under current market status');
		}

		// const settleRecord = eventSubscriber.getEventsArray('SettlePnlRecord')[0];
		// console.log(settleRecord);

		await clearingHouseLoser.fetchAccounts();
		const loserUser = clearingHouseLoser.getUserAccount();
		// console.log(loserUser.positions[0]);
		assert(loserUser.positions[0].baseAssetAmount.eq(new BN(0)));
		assert(loserUser.positions[0].quoteAssetAmount.eq(new BN(0)));
		const marketAfter0 = clearingHouse.getMarketAccount(marketIndex);

		const finalPnlResultMin0 = new BN(1014405836 - 11090);
		const finalPnlResultMax0 = new BN(1014405836 + 11090);

		console.log(marketAfter0.pnlPool.balance.toString());
		assert(marketAfter0.pnlPool.balance.gt(finalPnlResultMin0));
		assert(marketAfter0.pnlPool.balance.lt(finalPnlResultMax0));

		const txSig2 = await clearingHouse.settleExpiredPosition(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig2);
		await clearingHouse.fetchAccounts();
		const winnerUser = clearingHouse.getUserAccount();
		// console.log(winnerUser.positions[0]);
		assert(winnerUser.positions[0].baseAssetAmount.eq(new BN(0)));
		// assert(winnerUser.positions[0].quoteAssetAmount.gt(new BN(0))); // todo they lose money too after fees

		// await clearingHouse.settlePNL(
		// 	await clearingHouseLoser.getUserAccountPublicKey(),
		// 	clearingHouseLoser.getUserAccount(),
		// 	marketIndex
		// );

		const marketAfter = clearingHouse.getMarketAccount(marketIndex);

		const finalPnlResultMin = new BN(1000100666 - 1090);
		const finalPnlResultMax = new BN(1000100666 + 1090);

		console.log('pnlPool:', marketAfter.pnlPool.balance.toString());
		assert(marketAfter.pnlPool.balance.gt(finalPnlResultMin));
		assert(marketAfter.pnlPool.balance.lt(finalPnlResultMax));

		// const ammPnlResult = new BN(0);
		console.log('feePool:', marketAfter.amm.feePool.balance.toString());
		console.log(
			'totalExchangeFee:',
			marketAfter.amm.totalExchangeFee.toString()
		);
		assert(marketAfter.amm.feePool.balance.eq(new BN(21566)));
	});
});