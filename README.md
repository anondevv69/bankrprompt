# Bankr Prompt — Club renewer fee flywheel (Base)

Distributes **project-token** trading fees to **Bankr Club members who renewed** in the eligibility window. **BNKR** (or WETH) paired fees go to the ops wallet (`0x374d…`).

```
ClankerFeeLocker.claim(router, …)
        ↓
BankrFeeRouter
    ├─ BNKR / WETH  → ops wallet (100%)
    └─ project token → BankrRenewerDistributor → equal push to renewers
```

Renewer list: [Dune query 5839788](https://dune.com/queries/5839788) (`is_renewal = true`).

## Live on Base (8453) — v1 deploy

| Contract | Address |
|----------|---------|
| **BankrFeeRouter v1** | `0x1559585655Be00BA4A2BF02B118D559f8190E95D` |
| **BankrRenewerDistributor** | `0x2a3D662ec48498C85FdfdE2C61C88EE19f77BA3B` |
| ClankerFeeLocker | `0xF3622742b1E446D92e45E22923Ef11C2fcD55D68` |
| BNKR (default pair) | `0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b` |

**Router v1** routes WETH → ops but sends **all other tokens (including BNKR) to the distributor**. For BNKR-paired launches, **redeploy router v2** from this repo (includes `PAIRED_TOKEN`) and use the new address as fee recipient.

Distributor v1 is fine — keep `0x2a3D…`.

## Railway (quick start)

1. [New Railway project](https://railway.app) → Deploy from GitHub → `anondevv69/bankrprompt`
2. **Root Directory:** leave as `/` (repo root — `package.json` bootstraps `keeper/`)
3. Add variables from `keeper/.env.example`
4. Deploy — cron runs hourly (`railway.toml` at repo root)

**Alternative:** set Root Directory to `keeper` and use `keeper/railway.toml` instead.

**Test without a launched token:** set `KEEPER_KEY`, router/distributor addresses, `DUNE_API_KEY`. Leave `PROJECT_TOKEN` empty — keeper will claim/route only and skip renewer payouts.

## Token launch

```bash
bankr launch --name "..." --symbol "..." \
  --fee "0xYOUR_ROUTER_ADDRESS" \
  --fee-type wallet -y
```

Use **router v2** address after redeploy for BNKR-paired tokens.

## Redeploy router v2 (BNKR pair)

```bash
export BASE_RPC_URL=https://mainnet.base.org
export DEPLOYER_KEY=...
export PAYOUT_OWNER=0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4
export PAYOUT_KEEPER=0x6eb052b25399809F858Dc1B69b8Ff9225aE44b54
export PAIRED_TOKEN=0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b
export PROJECT_TOKEN=0xYourToken   # optional at deploy

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_RPC_URL" --broadcast --private-key "$DEPLOYER_KEY"
```

Re-use existing distributor: deploy script creates a new one — for v2 router only, deploy router manually or set distributor address in script. *Note: current Deploy.s.sol deploys both; for router-only v2, point constructor at `0x2a3D…` distributor.*

## Epochs

| Phase | `EPOCH_MODE` | Who gets token fees |
|-------|----------------|---------------------|
| Week 1 | `august_backfill` | All Aug 2026 `is_renewal` wallets |
| After | `weekly` | That week's renewals |

## Tests

```bash
forge test
cd keeper && npm install && npm start
```
