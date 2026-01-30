import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts";
import {
  Deposit,
  Withdraw,
  Mint,
  Burn,
  Liquidate,
  Transfer,
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

export function handleDeposit(event: Deposit): void {
  let tokenId = event.params.tokenId;
  let position = getOrCreatePosition(tokenId, event.block.timestamp);
  
  // Create deposit event
  let depositId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let depositEvent = new DepositEvent(depositId);
  depositEvent.position = position.id;
  depositEvent.amount = event.params.amount;
  depositEvent.shares = event.params.shares;
  depositEvent.depositor = event.params.sender;
  depositEvent.timestamp = event.block.timestamp;
  depositEvent.txHash = event.transaction.hash;
  depositEvent.blockNumber = event.block.number;
  
  // Check if this deposit is part of a loop (from looper contract)
  // This would be determined by checking if msg.sender is the looper
  // For now, default to false - looper.ts will handle loop deposits
  depositEvent.isLoopDeposit = false;
  depositEvent.save();
  
  // Update position
  position.collateral = position.collateral.plus(event.params.shares);
  position.updatedAt = event.block.timestamp;
  position.save();
  
  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalCollateral = stats.totalCollateral.plus(event.params.shares);
  stats.updatedAt = event.block.timestamp;
  stats.save();
  
  // Create daily snapshot
  createDailySnapshot(position, event.block.timestamp);
}

export function handleWithdraw(event: Withdraw): void {
  let tokenId = event.params.tokenId;
  let position = Position.load(tokenId.toString());
  
  if (!position) return;
  
  // Create withdrawal event
  let withdrawId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let withdrawEvent = new WithdrawalEvent(withdrawId);
  withdrawEvent.position = position.id;
  withdrawEvent.shares = event.params.shares;
  withdrawEvent.amount = event.params.amount;
  withdrawEvent.recipient = event.params.recipient;
  withdrawEvent.timestamp = event.block.timestamp;
  withdrawEvent.txHash = event.transaction.hash;
  withdrawEvent.blockNumber = event.block.number;
  withdrawEvent.save();
  
  // Update position
  position.collateral = position.collateral.minus(event.params.shares);
  position.updatedAt = event.block.timestamp;
  position.save();
  
  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalCollateral = stats.totalCollateral.minus(event.params.shares);
  stats.updatedAt = event.block.timestamp;
  stats.save();
  
  // Update looper multiple if applicable
  updateLooperMultiple(position);
  
  createDailySnapshot(position, event.block.timestamp);
}

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
  borrowEvent.isLoopBorrow = false; // Will be set by looper handler
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

export function handleBurn(event: Burn): void {
  let tokenId = event.params.tokenId;
  let position = Position.load(tokenId.toString());
  
  if (!position) return;
  
  // Create repay event
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
  
  // Update looper multiple if applicable
  updateLooperMultiple(position);
  
  createDailySnapshot(position, event.block.timestamp);
}

export function handleLiquidate(event: Liquidate): void {
  let tokenId = event.params.tokenId;
  let position = Position.load(tokenId.toString());
  
  if (!position) return;
  
  // Create liquidation event
  let liqId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let liqEvent = new LiquidationEvent(liqId);
  liqEvent.position = position.id;
  liqEvent.collateralLiquidated = event.params.shares;
  liqEvent.debtRepaid = event.params.amount;
  liqEvent.liquidator = event.params.liquidator;
  liqEvent.timestamp = event.block.timestamp;
  liqEvent.txHash = event.transaction.hash;
  liqEvent.blockNumber = event.block.number;
  liqEvent.save();
  
  // Update position
  position.collateral = position.collateral.minus(event.params.shares);
  position.debt = position.debt.minus(event.params.amount);
  position.updatedAt = event.block.timestamp;
  position.save();
  
  // Update looper multiple if applicable
  updateLooperMultiple(position);
  
  createDailySnapshot(position, event.block.timestamp);
}

export function handlePositionTransfer(event: Transfer): void {
  let tokenId = event.params.tokenId;
  let position = Position.load(tokenId.toString());
  
  // New position being minted
  if (event.params.from.equals(Address.zero())) {
    position = getOrCreatePosition(tokenId, event.block.timestamp);
    
    let user = getOrCreateUser(event.params.to, event.block.timestamp);
    user.totalPositions = user.totalPositions + 1;
    user.save();
    
    position.owner = user.id;
    position.save();
    
    let stats = getOrCreateProtocolStats();
    stats.totalPositions = stats.totalPositions + 1;
    stats.updatedAt = event.block.timestamp;
    stats.save();
    
    return;
  }
  
  // Position being burned
  if (event.params.to.equals(Address.zero())) {
    if (position) {
      let oldOwner = User.load(position.owner);
      if (oldOwner) {
        oldOwner.totalPositions = oldOwner.totalPositions - 1;
        oldOwner.save();
      }
    }
    
    let stats = getOrCreateProtocolStats();
    stats.totalPositions = stats.totalPositions - 1;
    if (position && position.isLoopedPosition) {
      stats.totalLoopedPositions = stats.totalLoopedPositions - 1;
    }
    stats.updatedAt = event.block.timestamp;
    stats.save();
    
    return;
  }
  
  // Regular transfer
  if (position) {
    let oldOwner = User.load(position.owner);
    if (oldOwner) {
      oldOwner.totalPositions = oldOwner.totalPositions - 1;
      oldOwner.save();
    }
    
    let newOwner = getOrCreateUser(event.params.to, event.block.timestamp);
    newOwner.totalPositions = newOwner.totalPositions + 1;
    newOwner.save();
    
    position.owner = newOwner.id;
    position.updatedAt = event.block.timestamp;
    position.save();
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

import { LooperPositionData } from "../generated/schema";

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
