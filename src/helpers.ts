import { BigInt, BigDecimal, Bytes } from "@graphprotocol/graph-ts";
import { Position, User, ProtocolStats } from "../generated/schema";

// =============================================================================
// Constants
// =============================================================================

export let BI_ZERO = BigInt.fromI32(0);
export let BI_ONE = BigInt.fromI32(1);
export let BD_ZERO = BigDecimal.fromString("0");
export let BD_ONE = BigDecimal.fromString("1");

// =============================================================================
// Entity Getters
// =============================================================================

export function getOrCreateUser(address: Bytes, timestamp: BigInt): User {
  let id = address;
  let user = User.load(id);
  
  if (!user) {
    user = new User(id);
    user.totalPositions = 0;
    user.createdAt = timestamp;
    user.save();
  }
  
  return user;
}

export function getOrCreatePosition(tokenId: BigInt, timestamp: BigInt): Position {
  let id = tokenId.toString();
  let position = Position.load(id);
  
  if (!position) {
    position = new Position(id);
    position.tokenId = tokenId;
    position.collateral = BI_ZERO;
    position.debt = BI_ZERO;
    position.createdAt = timestamp;
    position.updatedAt = timestamp;
    position.isLoopedPosition = false;
    // owner and vault must be set by caller
  }
  
  return position;
}

export function getOrCreateProtocolStats(): ProtocolStats {
  let id = "protocol";
  let stats = ProtocolStats.load(id);
  
  if (!stats) {
    stats = new ProtocolStats(id);
    stats.totalPositions = 0;
    stats.totalLoopedPositions = 0;
    stats.totalCollateral = BI_ZERO;
    stats.totalDebt = BI_ZERO;
    stats.totalLoopVolume = BI_ZERO;
    stats.updatedAt = BI_ZERO;
    stats.save();
  }
  
  return stats;
}

// =============================================================================
// Math Helpers
// =============================================================================

export function calculateLeverage(collateral: BigInt, debt: BigInt): BigDecimal {
  if (collateral.le(debt)) {
    return BD_ZERO;
  }
  let equity = collateral.minus(debt);
  return collateral.toBigDecimal().div(equity.toBigDecimal());
}

export function calculateLTV(collateral: BigInt, debt: BigInt): BigDecimal {
  if (collateral.equals(BI_ZERO)) {
    return BD_ZERO;
  }
  return debt.toBigDecimal()
    .div(collateral.toBigDecimal())
    .times(BigDecimal.fromString("100"));
}

export function calculateMultiple(current: BigInt, initial: BigInt): BigDecimal {
  if (initial.equals(BI_ZERO)) {
    return BD_ZERO;
  }
  return current.toBigDecimal().div(initial.toBigDecimal());
}

// =============================================================================
// Time Helpers
// =============================================================================

export function getDayId(timestamp: BigInt): i32 {
  return timestamp.toI32() / 86400;
}

export function getDayStartTimestamp(dayId: i32): BigInt {
  return BigInt.fromI32(dayId * 86400);
}
