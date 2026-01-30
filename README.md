# Alchemix V3 Subgraph

General-purpose subgraph for tracking all Alchemix V3 positions, with enhanced support for looper-created positions.

## Features

### Core Position Tracking
- All deposits, withdrawals, borrows, repays
- Position transfers and ownership
- Liquidation events
- Daily position snapshots

### Looper-Enhanced Tracking
Positions created via the Looper contract get special tracking:
- `isLoopedPosition` flag
- Initial deposit vs current value (multiple)
- Total loops executed
- Swap rate across all loops (total minted vs received)
- Peak multiple achieved
- Full loop history

## Schema Highlights

```graphql
type Position {
  # ... standard fields
  isLoopedPosition: Boolean!
  looperData: LooperPositionData  # Only for looped positions
}

type LooperPositionData {
  initialDeposit: BigInt!        # User's original USDC
  initialLeverage: BigDecimal!   # Leverage at creation
  totalLoops: Int!
  totalMinted: BigInt!           # Total alUSD borrowed
  totalSwapped: BigInt!          # Total USDC received
  averageSwapRate: BigDecimal!   # Effective swap rate
  currentMultiple: BigDecimal!   # Current value / initial deposit
  peakMultiple: BigDecimal!      # Highest multiple achieved
}
```

## Example Queries

### Get looped positions for a user
```graphql
{
  positions(where: { owner: "0x...", isLoopedPosition: true }) {
    tokenId
    collateral
    debt
    looperData {
      initialDeposit
      currentMultiple
      totalLoops
      averageSwapRate
    }
  }
}
```

### Calculate virtual APY for a looped position
```graphql
{
  position(id: "123") {
    createdAt
    looperData {
      initialDeposit
      currentMultiple
    }
  }
}
```
Then calculate: `virtualAPY = (currentMultiple ^ (365 / daysElapsed) - 1) * 100`

### Get loop history
```graphql
{
  loopEvents(where: { position: "123" }, orderBy: loopNumber) {
    loopNumber
    borrowAmount
    usdcReceived
    ltvAfter
    timestamp
  }
}
```

### Protocol stats
```graphql
{
  protocolStats(id: "protocol") {
    totalPositions
    totalLoopedPositions
    totalLoopVolume
  }
}
```

## Setup

1. **Install dependencies**
   ```bash
   pnpm install
   ```

2. **Add ABIs**
   - Copy `AlchemistV3.json` to `abis/`
   - Copy `AlchemixLooper.json` to `abis/`

3. **Configure addresses**
   Update `subgraph.yaml` with deployed contract addresses and start blocks.

4. **Generate types**
   ```bash
   pnpm codegen
   ```

5. **Build**
   ```bash
   pnpm build
   ```

6. **Deploy**
   ```bash
   # To Subgraph Studio
   graph auth --studio <deploy-key>
   pnpm deploy alchemix-finance/alchemix-v3
   
   # To hosted service (deprecated)
   pnpm deploy:hosted alchemix-finance/alchemix-v3
   ```

## TODO

- [ ] Add ABIs from deployed contracts
- [ ] Set contract addresses in subgraph.yaml
- [ ] Add vault entity population
- [ ] Add tests with matchstick
- [ ] Deploy to testnet first
- [ ] Multi-chain support (Arbitrum, Optimism)
