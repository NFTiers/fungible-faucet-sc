const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	Hbar,
	ContractExecuteTransaction,
	HbarUnit,
	ContractFunctionParameters,
	ContractInfoQuery,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const readlineSync = require('readline-sync');
const Web3 = require('web3');
const web3 = new Web3();
let abi;

// Get operator from .env file
const operatorKey = PrivateKey.fromString(process.env.PRIVATE_KEY);
const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
const contractName = process.env.CONTRACT_NAME ?? null;
const tierTokenId = process.env.TOKEN_ID;

const contractId = ContractId.fromString(process.env.CONTRACT_ID);

const env = process.env.ENVIRONMENT ?? null;
let client;

// check-out the deployed script - test read-only method
const main = async () => {

	if (getArgFlag('h')) {
		console.log('Usage: withdrawToWallet.js -[hbar|tier] -wallet WWWW -amount AA');
		return;
	}

	if (contractName === undefined || contractName == null) {
		console.log('Environment required, please specify CONTRACT_NAME for ABI in the .env file');
		return;
	}


	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());

	if (env.toUpperCase() == 'TEST') {
		client = Client.forTestnet();
		console.log('interacting in *TESTNET*');
	}
	else if (env.toUpperCase() == 'MAIN') {
		client = Client.forMainnet();
		console.log('interacting in *MAINNET*');
	}
	else {
		console.log('ERROR: Must specify either MAIN or TEST as environment in .env file');
		return;
	}

	client.setOperator(operatorId, operatorKey);

	// import ABI
	const json = JSON.parse(fs.readFileSync(`./artifacts/contracts/${contractName}.sol/${contractName}.json`, 'utf8'));
	abi = json.abi;
	console.log('\n -Loading ABI...\n');

	client.setOperator(operatorId, operatorKey);
	let [contractLazyBal, contractHbarBal] = await getContractBalance(contractId);
	console.log('Contract starting hbar balance:', contractHbarBal.toString());
	console.log('Contract starting TIER balance:', contractLazyBal.toString());

	const wallet = AccountId.fromString(getArg('wallet'));
	const amount = Number(getArg('amount'));

	if (getArgFlag('hbar')) {

		const outputStr = 'Do you wish to withdraw ' + (new Hbar(amount)).toString() + ' to ' + wallet + ' ?';
		const proceed = readlineSync.keyInYNStrict(outputStr);
		if (proceed) {
			console.log(await transferHbarFromContract(wallet, amount));
		}
		else {
			console.log('User aborted');
			return;
		}
	}
	else if (getArgFlag('tier')) {

		const outputStr = 'Do you wish to withdraw ' + amount / 10 + ' $LAZY to ' + wallet + ' ?';
		const proceed = readlineSync.keyInYNStrict(outputStr);

		if (proceed) {
			console.log(await retrieveLazyFromContract(wallet, amount));
		}
		else {
			console.log('User aborted');
			return;
		}
	}
	else {
		console.log('No valid switch given, run with -h for usage pattern');
		return;
	}

	[contractLazyBal, contractHbarBal] = await getContractBalance(contractId);
	console.log('Contract ending hbar balance:', contractHbarBal.toString());
	console.log('Contract ending TIER balance:', contractLazyBal.toString());
};

/**
 * Helper function to get the Lazy, hbar & minted NFT balance of the contract
 * @returns {[number | Long.Long, Hbar, number | Long.Long]} The balance of the FT (without decimals), Hbar & NFT at the SC
 */
async function getContractBalance() {

	const query = new ContractInfoQuery()
		.setContractId(contractId);

	const info = await query.execute(client);

	let balance;

	const tokenMap = info.tokenRelationships;
	const tokenBal = tokenMap.get(tierTokenId.toString());
	if (tokenBal) {
		balance = tokenBal.balance;
	}
	else {
		balance = -1;
	}

	return [balance, info.balance];
}

/**
 * Decodes the result of a contract's function execution
 * @param functionName the name of the function within the ABI
 * @param resultAsBytes a byte array containing the execution result
 */
function decodeFunctionResult(functionName, resultAsBytes) {
	const functionAbi = abi.find(func => func.name === functionName);
	const functionParameters = functionAbi.outputs;
	const resultHex = '0x'.concat(Buffer.from(resultAsBytes).toString('hex'));
	const result = web3.eth.abi.decodeParameters(functionParameters, resultHex);
	return result;
}

main()
	.then(() => {
		// eslint-disable-next-line no-useless-escape
		process.exit(0);
	})
	.catch(error => {
		console.error(error);
		process.exit(1);
	});

/**
 * Helper method to transfer FT using HTS
 * @param {AccountId} receiver
 * @param {number} amount amount of the FT to transfer (adjusted for decimal)
 * @returns {any} expected to be a string 'SUCCESS' implies it worked
 */
async function retrieveLazyFromContract(receiver, amount) {

	const gasLim = 200000;
	const params = new ContractFunctionParameters()
		.addAddress(tierTokenId.toSolidityAddress())
		.addAddress(receiver.toSolidityAddress())
		.addInt64(amount);
	const [tokenTransferRx, , ] = await contractExecuteFcn(contractId, gasLim, 'transferHTS', params);
	const tokenTransferStatus = tokenTransferRx.status;

	return tokenTransferStatus.toString();
}

/**
 * Helper function for calling the contract methods
 * @param {ContractId} cId the contract to call
 * @param {number | Long.Long} gasLim the max gas
 * @param {string} fcnName name of the function to call
 * @param {ContractFunctionParameters} params the function arguments
 * @param {string | number | Hbar | Long.Long | BigNumber} amountHbar the amount of hbar to send in the methos call
 * @returns {[TransactionReceipt, any, TransactionRecord]} the transaction receipt and any decoded results
 */
async function contractExecuteFcn(cId, gasLim, fcnName, params, amountHbar) {
	const contractExecuteTx = await new ContractExecuteTransaction()
		.setContractId(cId)
		.setGas(gasLim)
		.setFunction(fcnName, params)
		.setPayableAmount(amountHbar)
		.execute(client);

	// get the results of the function call;
	const record = await contractExecuteTx.getRecord(client);
	const contractResults = decodeFunctionResult(fcnName, record.contractFunctionResult.bytes);
	const contractExecuteRx = await contractExecuteTx.getReceipt(client);
	return [contractExecuteRx, contractResults, record];
}

/**
 * Request hbar from the contract
 * @param {AccountId} wallet
 * @param {number} amount
 * @param {HbarUnit=} units defaults to Hbar as the unit type
 */
async function transferHbarFromContract(wallet, amount, units = HbarUnit.Hbar) {
	const gasLim = 400000;
	const params = new ContractFunctionParameters()
		.addAddress(wallet.toSolidityAddress())
		.addUint256(new Hbar(amount, units).toTinybars());
	const [callHbarRx, , ] = await contractExecuteFcn(contractId, gasLim, 'transferHbar', params);
	return callHbarRx.status.toString();
}

function getArg(arg) {
	const customidx = process.argv.indexOf(`-${arg}`);
	let customValue;

	if (customidx > -1) {
		// Retrieve the value after --custom
		customValue = process.argv[customidx + 1];
	}

	return customValue;
}

function getArgFlag(arg) {
	const customIndex = process.argv.indexOf(`-${arg}`);

	if (customIndex > -1) {
		return true;
	}

	return false;
}