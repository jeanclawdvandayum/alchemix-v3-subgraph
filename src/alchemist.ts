import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts";
import {
  Deposit,
  Withdraw,
  Mint,
  Burn,
  Repay,
  Liquidated,
  ForceRepay,
} from "../generated/AlchemistV3/AlchemistV3";
import {
  Position,
  User,
  Vault,
  DepositEvent,
  BorrowEvent,
  RepayEvent,
  WithdrawalEvent,
  LiquidationEvent,
  DailyPositionSnapshot,
  LooperPositionData,
} from "../generated/schema";
import {
  getOrCreateUser,
  getOrCreatePosition,
  getOrCreateProtocolStats,
  getDayId,
  BI_ZERO,
  BD_ZERO,
  calculateLeverage,
} from "./helpers";

// =============================================================================
// Core Alchemist Event Handlers
// =============================================================================

// Deposit(uint256 amount, uint256 indexed recipientId)
export function handleDeposit(event: Deposit): void {
  let tokenId = event.params.recipientId;
  let position = getOrCreatePosition(tokenId, event.block.timestamp);
  
  // Create deposit event
  let depositId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let depositEvent = new DepositEvent(depositId);
  depositEvent.position = position.id;
  depositEvent.amount = event.params.amount;
  depositEvent.shares = event.params.amount; // Note: V3 may not emit shares separately
  depositEvent.depositor = event.transaction.from;
  depositEvent.timestamp = event.block.timestamp;
  depositEvent.txHash = event.transaction.hash;
  depositEvent.blockNumber = event.block.number;
  depositEvent.isLoopDeposit = false;
  depositEvent.save();
  
  // Update position collateral
  position.collateral = position.collateral.plus(event.params.amount);
  position.updatedAt = event.block.timestamp;
  position.save();
  
  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalCollateral = stats.totalCollateral.plus(event.params.amount);
  stats.updatedAt = event.block.timestamp;
  stats.save();
  
  createDailySnapshot(position, event.block.timestamp);
}

// Withdraw(uint256 amount, uint256 indexed tokenId, address recipient)
export function handleWithdraw(event: Withdraw): void {
  let tokenId = event.params.tokenId;
  let position = Position.load(tokenId.toString());
  
  if (!position) return;
  
  // Create withdrawal event
  let withdrawId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let withdrawEvent = new WithdrawalEvent(withdrawId);
  withdrawEvent.position = position.id;
  withdrawEvent.shares = event.params.amount;
  withdrawEvent.amount = event.params.amount;
  withdrawEvent.recipient = event.params.recipient;
  withdrawEvent.timestamp = event.block.timestamp;
  withdrawEvent.txHash = event.transaction.hash;
  withdrawEvent.blockNumber = event.block.number;
  withdrawEvent.save();
  
  // Update position
  position.collateral = position.collateral.minus(event.params.amount);
  position.updatedAt = event.block.timestamp;
  position.save();
  
  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalCollateral = stats.totalCollateral.minus(event.params.amount);
  stats.updatedAt = event.block.timestamp;
  stats.save();
  
  updateLooperMultiple(position);
  createDailySnapshot(position, event.block.timestamp);
}

// Mint(uint256 indexed tokenId, uint256 amount, address recipient)
export function handleMint(event: Mint): void {
  let tokenId = event.params.tokenId;
  let position = Position.load(tokenId.toString());
  
  if (!position) return;
  
  // Create borrow event
  let borrowId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let borrowEvent = new BorrowEvent(borrowId);
  borrowEvent.position = position.id;
  borrowEvent.amount = event.params.amount;
  borrowEvent.recipient = event.params.recipient;
  borrowEvent.timestamp = event.block.timestamp;
  borrowEvent.txHash = event.transaction.hash;
  borrowEvent.blockNumber = event.block.number;
  borrowEvent.isLoopBorrow = false;
  borrowEvent.save();
  
  // Update position
  position.debt = position.debt.plus(event.params.amount);
  position.updatedAt = event.block.timestamp;
  position.save();
  
  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalDebt = stats.totalDebt.plus(event.params.amount);
  stats.updatedAt = event.block.timestamp;
  stats.save();
  
  createDailySnapshot(position, event.block.timestamp);
}

// Burn(address indexed sender, uint256 amount, uint256 indexed recipientId)
export function handleBurn(event: Burn): void {
  let tokenId = event.params.recipientId;
  let position = Position.load(tokenId.toString());
  
  if (!position) return;
  
  // Create repay event (Burn = user burns alUSD to reduce debt)
  let repayId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let repayEvent = new RepayEvent(repayId);
  repayEvent.position = position.id;
  repayEvent.amount = event.params.amount;
  repayEvent.payer = event.params.sender;
  repayEvent.timestamp = event.block.timestamp;
  repayEvent.txHash = event.transaction.hash;
  repayEvent.blockNumber = event.block.number;
  repayEvent.save();
  
  // Update position
  position.debt = position.debt.minus(event.params.amount);
  position.updatedAt = event.block.timestamp;
  position.save();
  
  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalDebt = stats.totalDebt.minus(event.params.amount);
  stats.updatedAt = event.block.timestamp;
  stats.save();
  
  updateLooperMultiple(position);
  createDailySnapshot(position, event.block.timestamp);
}

// Repay(address indexed sender, uint256 amount, uint256 indexed recipientId, uint256 actualAmount)
export function handleRepay(event: Repay): void {
  let tokenId = event.params.recipientId;
  let position = Position.load(tokenId.toString());
  
  if (!position) return;
  
  // Create repay event
  let repayId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let repayEvent = new RepayEvent(repayId);
  repayEvent.position = position.id;
  repayEvent.amount = event.params.actualAmount; // Use actualAmount for the effective repay
  repayEvent.payer = event.params.sender;
  repayEvent.timestamp = event.block.timestamp;
  repayEvent.txHash = event.transaction.hash;
  repayEvent.blockNumber = event.block.number;
  repayEvent.save();
  
  // Update position debt
  position.debt = position.debt.minus(event.params.actualAmount);
  position.updatedAt = event.block.timestamp;
  position.save();
  
  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalDebt = stats.totalDebt.minus(event.params.actualAmount);
  stats.updatedAt = event.block.timestamp;
  stats.save();
  
  updateLooperMultiple(position);
  createDailySnapshot(position, event.block.timestamp);
}

// Liquidated(uint256 indexed accountId, address liquidator, uint256 amount, uint256 feeInYield, uint256 feeInUnderlying)
export function handleLiquidated(event: Liquidated): void {
  let tokenId = event.params.accountId;
  let position = Position.load(tokenId.toString());
  
  if (!position) return;
  
  // Create liquidation event
  let liqId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let liqEvent = new LiquidationEvent(liqId);
  liqEvent.position = position.id;
  liqEvent.collateralLiquidated = event.params.feeInYield.plus(event.params.feeInUnderlying);
  liqEvent.debtRepaid = event.params.amount;
  liqEvent.liquidator = event.params.liquidator;
  liqEvent.timestamp = event.block.timestamp;
  liqEvent.txHash = event.transaction.hash;
  liqEvent.blockNumber = event.block.number;
  liqEvent.save();
  
  // Update position
  let totalFees = event.params.feeInYield.plus(event.params.feeInUnderlying);
  position.collateral = position.collateral.minus(totalFees);
  position.debt = position.debt.minus(event.params.amount);
  position.updatedAt = event.block.timestamp;
  position.save();
  
  updateLooperMultiple(position);
  createDailySnapshot(position, event.block.timestamp);
}

// ForceRepay(uint256 indexed tokenId, uint256 amount, uint256 earmarked, uint256 newDebt)
export function handleForceRepay(event: ForceRepay): void {
  let tokenId = event.params.tokenId;
  let position = Position.load(tokenId.toString());
  
  if (!position) return;
  
  // Create repay event for force repay
  let repayId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let repayEvent = new RepayEvent(repayId);
  repayEvent.position = position.id;
  repayEvent.amount = event.params.amount;
  repayEvent.payer = Address.zero(); // Force repay is system-initiated
  repayEvent.timestamp = event.block.timestamp;
  repayEvent.txHash = event.transaction.hash;
  repayEvent.blockNumber = event.block.number;
  repayEvent.save();
  
  // Update position with new debt value directly
  position.debt = event.params.newDebt;
  position.updatedAt = event.block.timestamp;
  position.save();
  
  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalDebt = stats.totalDebt.minus(event.params.amount);
  stats.updatedAt = event.block.timestamp;
  stats.save();
  
  updateLooperMultiple(position);
  createDailySnapshot(position, event.block.timestamp);
}

// =============================================================================
// Helper Functions
// =============================================================================

function updateLooperMultiple(position: Position): void {
  if (!position.isLoopedPosition) return;
  
  let looperData = LooperPositionData.load(position.id);
  if (!looperData) return;
  
  if (looperData.initialDeposit.gt(BI_ZERO)) {
    looperData.currentMultiple = position.collateral.toBigDecimal()
      .div(looperData.initialDeposit.toBigDecimal());
    
    if (looperData.currentMultiple.gt(looperData.peakMultiple)) {
      looperData.peakMultiple = looperData.currentMultiple;
    }
    
    looperData.save();
  }
}

function createDailySnapshot(position: Position, timestamp: BigInt): void {
  let dayId = getDayId(timestamp);
  let snapshotId = position.id + "-" + dayId.toString();
  
  let snapshot = new DailyPositionSnapshot(snapshotId);
  snapshot.position = position.id;
  snapshot.date = dayId;
  snapshot.collateral = position.collateral;
  snapshot.debt = position.debt;
  snapshot.leverage = calculateLeverage(position.collateral, position.debt);
  
  // Add multiple for looped positions
  if (position.isLoopedPosition) {
    let looperData = LooperPositionData.load(position.id);
    if (looperData) {
      snapshot.multiple = looperData.currentMultiple;
    }
  }
  
  snapshot.save();
}
