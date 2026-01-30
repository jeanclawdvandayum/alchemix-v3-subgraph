import { BigInt, BigDecimal, Bytes } from "@graphprotocol/graph-ts";
import {
  LoopedPositionCreated,
  LoopExecuted,
  MultiLoopExecuted,
} from "../generated/AlchemixLooper/AlchemixLooper";
import {
  Position,
  LooperPositionData,
  LoopEvent,
  ProtocolStats,
} from "../generated/schema";
import { getOrCreatePosition, getOrCreateProtocolStats, BD_ZERO, BI_ZERO } from "./helpers";

// =============================================================================
// Event Handlers
// =============================================================================

export function handleLoopedPositionCreated(event: LoopedPositionCreated): void {
  let tokenId = event.params.tokenId;
  let position = getOrCreatePosition(tokenId, event.block.timestamp);
  
  // Mark as looped position
  position.isLoopedPosition = true;
  
  // Create looper-specific data
  let looperData = new LooperPositionData(tokenId.toString());
  looperData.position = position.id;
  looperData.initialDeposit = event.params.initialUsdc;
  looperData.initialCollateral = event.params.finalShares;
  looperData.initialDebt = event.params.totalBorrowed;
  
  // Calculate initial leverage: collateral / (collateral - debt)
  // Using shares as proxy for collateral value
  let collateralValue = event.params.finalShares;
  let debt = event.params.totalBorrowed;
  if (collateralValue.gt(debt)) {
    let equity = collateralValue.minus(debt);
    looperData.initialLeverage = collateralValue.toBigDecimal().div(equity.toBigDecimal());
  } else {
    looperData.initialLeverage = BD_ZERO;
  }
  
  looperData.totalLoops = event.params.loopsExecuted.toI32();
  looperData.totalMinted = event.params.totalBorrowed;
  looperData.totalSwapped = event.params.totalUsdcSwapped;
  
  // Average swap rate
  if (looperData.totalMinted.gt(BI_ZERO)) {
    looperData.averageSwapRate = looperData.totalSwapped.toBigDecimal()
      .div(looperData.totalMinted.toBigDecimal());
  } else {
    looperData.averageSwapRate = BD_ZERO;
  }
  
  looperData.createdAt = event.block.timestamp;
  looperData.createdTxHash = event.transaction.hash;
  looperData.lastLoopAt = event.block.timestamp;
  
  // Initial multiple is 1 (just created)
  looperData.currentMultiple = BigDecimal.fromString("1");
  looperData.peakMultiple = BigDecimal.fromString("1");
  
  looperData.save();
  
  // Link to position
  position.looperData = looperData.id;
  position.collateral = event.params.finalShares;
  position.debt = event.params.totalBorrowed;
  position.updatedAt = event.block.timestamp;
  position.save();
  
  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalLoopedPositions = stats.totalLoopedPositions + 1;
  stats.totalLoopVolume = stats.totalLoopVolume.plus(event.params.totalBorrowed);
  stats.updatedAt = event.block.timestamp;
  stats.save();
}

export function handleLoopExecuted(event: LoopExecuted): void {
  let tokenId = event.params.tokenId;
  let position = Position.load(tokenId.toString());
  
  if (!position) return;
  
  let looperData = LooperPositionData.load(tokenId.toString());
  if (!looperData) {
    // Position exists but wasn't created via looper - create looper data now
    looperData = new LooperPositionData(tokenId.toString());
    looperData.position = position.id;
    looperData.initialDeposit = position.collateral; // Best estimate
    looperData.initialCollateral = position.collateral;
    looperData.initialDebt = position.debt;
    looperData.initialLeverage = BD_ZERO;
    looperData.totalLoops = 0;
    looperData.totalMinted = BI_ZERO;
    looperData.totalSwapped = BI_ZERO;
    looperData.averageSwapRate = BD_ZERO;
    looperData.createdAt = event.block.timestamp;
    looperData.createdTxHash = event.transaction.hash;
    looperData.lastLoopAt = event.block.timestamp;
    looperData.currentMultiple = BigDecimal.fromString("1");
    looperData.peakMultiple = BigDecimal.fromString("1");
    
    position.isLoopedPosition = true;
    position.looperData = looperData.id;
  }
  
  // Create loop event
  let loopEventId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let loopEvent = new LoopEvent(loopEventId);
  loopEvent.position = position.id;
  loopEvent.looperData = looperData.id;
  loopEvent.loopNumber = looperData.totalLoops + 1;
  loopEvent.borrowAmount = event.params.borrowAmount;
  loopEvent.usdcReceived = event.params.usdcReceived;
  loopEvent.sharesDeposited = event.params.sharesDeposited;
  
  // Update position state
  let newCollateral = position.collateral.plus(event.params.sharesDeposited);
  let newDebt = position.debt.plus(event.params.borrowAmount);
  
  loopEvent.collateralAfter = newCollateral;
  loopEvent.debtAfter = newDebt;
  
  // Calculate LTV
  if (newCollateral.gt(BI_ZERO)) {
    loopEvent.ltvAfter = newDebt.toBigDecimal()
      .div(newCollateral.toBigDecimal())
      .times(BigDecimal.fromString("100"));
  } else {
    loopEvent.ltvAfter = BD_ZERO;
  }
  
  loopEvent.timestamp = event.block.timestamp;
  loopEvent.txHash = event.transaction.hash;
  loopEvent.blockNumber = event.block.number;
  loopEvent.save();
  
  // Update looper data
  looperData.totalLoops = looperData.totalLoops + 1;
  looperData.totalMinted = looperData.totalMinted.plus(event.params.borrowAmount);
  looperData.totalSwapped = looperData.totalSwapped.plus(event.params.usdcReceived);
  looperData.lastLoopAt = event.block.timestamp;
  
  // Recalculate average swap rate
  if (looperData.totalMinted.gt(BI_ZERO)) {
    looperData.averageSwapRate = looperData.totalSwapped.toBigDecimal()
      .div(looperData.totalMinted.toBigDecimal());
  }
  
  // Update current multiple
  if (looperData.initialDeposit.gt(BI_ZERO)) {
    looperData.currentMultiple = newCollateral.toBigDecimal()
      .div(looperData.initialDeposit.toBigDecimal());
    
    if (looperData.currentMultiple.gt(looperData.peakMultiple)) {
      looperData.peakMultiple = looperData.currentMultiple;
    }
  }
  
  looperData.save();
  
  // Update position
  position.collateral = newCollateral;
  position.debt = newDebt;
  position.updatedAt = event.block.timestamp;
  position.save();
  
  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalLoopVolume = stats.totalLoopVolume.plus(event.params.borrowAmount);
  stats.updatedAt = event.block.timestamp;
  stats.save();
}

export function handleMultiLoopExecuted(event: MultiLoopExecuted): void {
  let tokenId = event.params.tokenId;
  let position = Position.load(tokenId.toString());
  
  if (!position) return;
  
  let looperData = LooperPositionData.load(tokenId.toString());
  if (!looperData) return;
  
  // For multi-loop, we create a single summary event
  let loopEventId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let loopEvent = new LoopEvent(loopEventId);
  loopEvent.position = position.id;
  loopEvent.looperData = looperData.id;
  loopEvent.loopNumber = looperData.totalLoops + event.params.loopsExecuted.toI32();
  loopEvent.borrowAmount = event.params.totalBorrowed;
  loopEvent.usdcReceived = event.params.totalUsdcReceived;
  loopEvent.sharesDeposited = event.params.totalSharesDeposited;
  
  // Update position state
  let newCollateral = position.collateral.plus(event.params.totalSharesDeposited);
  let newDebt = position.debt.plus(event.params.totalBorrowed);
  
  loopEvent.collateralAfter = newCollateral;
  loopEvent.debtAfter = newDebt;
  
  if (newCollateral.gt(BI_ZERO)) {
    loopEvent.ltvAfter = newDebt.toBigDecimal()
      .div(newCollateral.toBigDecimal())
      .times(BigDecimal.fromString("100"));
  } else {
    loopEvent.ltvAfter = BD_ZERO;
  }
  
  loopEvent.timestamp = event.block.timestamp;
  loopEvent.txHash = event.transaction.hash;
  loopEvent.blockNumber = event.block.number;
  loopEvent.save();
  
  // Update looper data
  looperData.totalLoops = looperData.totalLoops + event.params.loopsExecuted.toI32();
  looperData.totalMinted = looperData.totalMinted.plus(event.params.totalBorrowed);
  looperData.totalSwapped = looperData.totalSwapped.plus(event.params.totalUsdcReceived);
  looperData.lastLoopAt = event.block.timestamp;
  
  if (looperData.totalMinted.gt(BI_ZERO)) {
    looperData.averageSwapRate = looperData.totalSwapped.toBigDecimal()
      .div(looperData.totalMinted.toBigDecimal());
  }
  
  if (looperData.initialDeposit.gt(BI_ZERO)) {
    looperData.currentMultiple = newCollateral.toBigDecimal()
      .div(looperData.initialDeposit.toBigDecimal());
    
    if (looperData.currentMultiple.gt(looperData.peakMultiple)) {
      looperData.peakMultiple = looperData.currentMultiple;
    }
  }
  
  looperData.save();
  
  // Update position
  position.collateral = newCollateral;
  position.debt = newDebt;
  position.updatedAt = event.block.timestamp;
  position.save();
  
  // Update protocol stats
  let stats = getOrCreateProtocolStats();
  stats.totalLoopVolume = stats.totalLoopVolume.plus(event.params.totalBorrowed);
  stats.updatedAt = event.block.timestamp;
  stats.save();
}
