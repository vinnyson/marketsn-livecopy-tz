const { TezosRPC } = require("../tezos-rpc");
const { getAccountInfo } = require("../../utils");
const { transactionsModel } = require("../../models/transactions/schema");
const { config } = require("../../config");
const { logger } = require("../../logger");
const { TransactionError } = require("../../errors");
const { Types } = require("mongoose");
const {
  Wallet,
  Context,
  TezosOperationError,
  OpKind,
} = require("@taquito/taquito");
const { InMemorySigner } = require("@taquito/signer");
const {
  MAX_GAS_LIMIT,
  MAX_STORAGE_LIMIT_IN_BYTES,
} = require("../../constants");

class Relayer {
  /**
   * Relayers for sending signed transactions of a different user
   * @param {TezosRPC} tezosRpc
   * @param {Object} relayerAccounts
   */
  constructor(tezosRpc, relayerAccounts) {
    this.tezosRpc = tezosRpc;
    this.availableAccounts = relayerAccounts;

    this.availableGasLimit = MAX_GAS_LIMIT;
    this.availableStorageLimit = MAX_STORAGE_LIMIT_IN_BYTES;
    this.operations = [];
    this.batchTimeout = 30000 / this.availableAccounts.length;
  }

  _chooseRelayer() {
    if (this.availableAccounts.length === 0) return;

    return this.availableAccounts.shift();
  }

  _addBackRelayer(account) {
    if (this.availableAccounts.indexOf(account) > -1) {
      logger.error("Relayer already present in queue");
      return;
    }

    this.availableAccounts.push(account);
  }

  /**
   * Send contract invocation through api account
   *
   * - Try fetching an available api account
   * - Remove that from the queue while submitting a transaction
   * - Add back the account before exiting fn.,
   *   on either successful txn submission or any error
   * @param {Object} transferParams
   */
  async sendContractInvocation(transferParams) {
    const {
      error,
      storageCost,
      gasCost,
    } = await this.tezosRpc.testContractInvocation(
      this.availableAccounts[0].secretKey,
      transferParams
    );

    // Errored, throw back err, add relayer as available and return
    if (error) {
      throw new TransactionError(error);
    }

    // Check gas, storage limits
    if (
      storageCost > this.availableStorageLimit ||
      gasCost > this.availableGasLimit
    ) {
      throw new TransactionError("Cannot process transaction; Try again later");
    }

    // Schedule batch
    if (this.operations.length === 0) {
      setTimeout(this.sendOperationsBatch.bind(this), this.batchTimeout);
    }

    // Queue operation
    const id = Types.ObjectId();
    transferParams.kind = OpKind.TRANSACTION;
    this.operations.push({
      id,
      transferParams,
    });

    // Success, save txn details to db with status as pending
    const transaction = new transactionsModel({
      _id: id,
      networkId: config.networkId,
      status: "pending",
    });
    transaction.save();

    return id;
  }

  async sendOperationsBatch() {
    const relayer = this._chooseRelayer();
    if (!relayer) {
      throw new Error(
        "No proxy account available for executing transaction;" +
          "All are currently busy carrying out transactions"
      );
    }

    const operationsToSend = Object.assign([], this.operations);
    this.operations = [];

    const context = new Context(
      this.tezosRpc.rpcURL,
      new InMemorySigner(relayer.secretKey)
    );
    const wallet = new Wallet(context);
    const batch = wallet.batch([]);

    // Dry run transactions in batch and
    // record failure in db, if any
    const ids = [];
    for (let i = 1; i <= operationsToSend.length; i++) {
      const currOp = operationsToSend[i - 1];
      try {
        await context.estimate.batch([
          ...batch.operations,
          currOp.transferParams,
        ]);
        batch.withTransfer(currOp.transferParams);
        ids.push(currOp.id);
      } catch (error) {
        const errorMessage = error.message || error.id;
        logger.error(`ID: ${currOp.id} failed with error: ${errorMessage}`);
        await this._updateTransactionStatus([currOp.id], "failed", errorMessage);
      }
    }

    try {
      const op = await batch.send();
      const { opHash } = op;
      logger.info(`Transaction hash: ${opHash}`);
      await this._updateTransactionHash(ids, opHash);

      await op.confirmation();
      await this._updateTransactionStatus(ids, "success");
    } catch (error) {
      if (error instanceof TezosOperationError) {
        logger.error(error.message);
      } else {
        logger.error(error);
      }

      await this._updateTransactionStatus(operationsToSend, "failed");
    }

    this._addBackRelayer(relayer);
  }

  async _updateTransactionHash(ids, opHash) {
    let dbOps = ids.map((id) => {
      return {
        updateOne: {
          filter: {
            _id: Types.ObjectId(id),
          },
          update: {
            transactionHash: opHash,
          },
        },
      };
    });
    await transactionsModel.bulkWrite(dbOps);
  }

  async _updateTransactionStatus(ids, status, error = "") {
    let dbOps = ids.map((id) => {
      return {
        updateOne: {
          filter: {
            _id: Types.ObjectId(id),
          },
          update: {
            status,
            error,
          },
        },
      };
    });
    await transactionsModel.bulkWrite(dbOps);
  }
}

/**
 * Initialize relayers class
 * @param {TezosRPC} tezosRpc
 * @param {string[]} privateKeys
 *
 * @returns {Promise<Relayer>}
 */
async function initializeRelayers(tezosRpc, privateKeys) {
  const accounts = [];
  for (const key of privateKeys) {
    const accountInfo = await getAccountInfo(key);
    const isRevealed = tezosRpc.isAccountRevealed(accountInfo.address);
    if (!isRevealed) continue;

    accounts.push(accountInfo);
  }

  return new Relayer(tezosRpc, accounts);
}

module.exports = { initializeRelayers, Relayer };
