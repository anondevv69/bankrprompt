# Bankr Prompt — Club renewer fee flywheel (Base)

Distributes **project-token** trading fees to **Bankr Club members who renewed** in the eligibility window. **All WETH** goes to the ops wallet (`0x374d…`).

```
Clanker/Bankr fees claimed → BankrFeeRouter
    ├─ WETH  → ops wallet (100%)
    └─ token → BankrRenewerDistributor → equal push to renewers
```

Renewer list comes from [Dune query 5839788](https://dune.com/queries/5839788) (`is_renewal = true`).

## Repo layout

| Path | Purpose |
|------|---------|
| `src/` | Solidity contracts (Foundry) |
| `script/Deploy.s.sol` | Base deploy |
| `keeper/` | Railway cron worker — **set Root Directory to `keeper`** |

## 1. Deploy contracts (Base)

```bash
export BASE_RPC_URL=https://mainnet.base.org
export DEPLOYER_KEY=0x...
export PAYOUT_OWNER=0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4
export PAYOUT_KEEPER=0xYourKeeperHotWallet
export PROJECT_TOKEN=0xYourTokenOnBase   # required for router token routing
# optional override:
# export WETH_RECIPIENT=0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_RPC_URL" \
  --broadcast \
  --private-key "$DEPLOYER_KEY"
```

Save the printed `BANKR_FEE_ROUTER` and `BANKR_RENEWER_DISTRIBUTOR` addresses.

### Token launch

Set the Bankr/Clanker **fee recipient** to `BANKR_FEE_ROUTER`:

```bash
bankr launch --name "..." --symbol "..." --fee "0xRouter..." --fee-type wallet -y
```

Or claim fees into the router, then the keeper calls `route()`.

## 2. Railway

1. New service from this repo: https://github.com/anondevv69/bankrprompt
2. **Root Directory:** `keeper`
3. **Cron:** enabled (hourly via `keeper/railway.toml`)
4. Variables from `keeper/.env.example`

| Variable | Notes |
|----------|--------|
| `KEEPER_KEY` | Same as `PAYOUT_KEEPER` — pays gas, runs rounds |
| `BANKR_FEE_ROUTER` | Deployed router |
| `BANKR_RENEWER_DISTRIBUTOR` | Deployed distributor |
| `PROJECT_TOKEN` | Your Base token CA |
| `DUNE_API_KEY` | Dune API key (rotate if exposed) |

## Epochs

| Phase | `EPOCH_MODE` | Who gets token fees |
|-------|----------------|---------------------|
| **Week 1** | `august_backfill` | All `is_renewal` wallets with payment in Aug 2026 |
| **After** | `weekly` | Renewals in the current Mon–Sun UTC week |

Each cron run: `route()` → open round → absorb token balance → equal Merkle split → `payBatch` to all renewers.

## Tests

```bash
forge test
cd keeper && npm install
```

## Ops wallet

WETH recipient is fixed at deploy to `0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4` unless `WETH_RECIPIENT` is set.
