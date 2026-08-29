import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  fallback,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { buildMerkle, equalSplit } from "./merkle.js";
import { fetchRenewers } from "./dune.js";
import { claimDopplerIfAvailable } from "./doppler.js";

const BATCH = Number(process.env.PAY_BATCH_SIZE || "40");
const WETH = "0x4200000000000000000000000000000000000006";
const DEFAULT_BNKR = "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b";
const CLANKER_FEE_LOCKER =
  process.env.CLANKER_FEE_LOCKER || "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68";

const feeLockerAbi = parseAbi([
  "function claim(address feeOwner, address token) external",
  "function availableFees(address feeOwner, address token) view returns (uint256)",
]);
const routerAbi = parseAbi([
  "function route() returns (uint256 opsAmount, uint256 tokenAmount)",
  "function routeToken(address token) returns (uint256 amount)",
  "function PROJECT_TOKEN() view returns (address)",
]);
const erc20Abi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const distributorAbi = parseAbi([
  "function roundCount() view returns (uint256)",
  "function openRound(address token) returns (uint256 roundId)",
  "function absorbBalance(uint256 roundId) returns (uint256 added)",
  "function lockRound(uint256 roundId, bytes32 merkleRoot, uint32 recipientCount)",
  "function payBatch(uint256 roundId, address[] recipients, uint256[] amounts, bytes32[][] proofs)",
  "function roundInfo(uint256 roundId) view returns (address token, uint32 recipientCount, uint32 paidCount, uint256 payoutAmount, uint256 paidOut, bytes32 merkleRoot, uint8 phase)",
  "event RoundOpened(uint256 indexed roundId, address indexed token)",
]);

const PHASE_OPEN = 0;
const PHASE_LOCKED = 1;

function env(name, fallback = "") {
  const v = String(process.env[name] || fallback).trim();
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

function envMaybe(name, fallback = "") {
  const v = String(process.env[name] || fallback).trim();
  return v ? getAddress(v.toLowerCase()) : "";
}

function envAddr(name) {
  return getAddress(env(name).toLowerCase());
}

function key() {
  const raw = env("KEEPER_KEY");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function dryRun() {
  return process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
}

function testWallets() {
  const raw = String(process.env.TEST_WALLETS || "").trim();
  if (!raw) return null;
  return raw.split(/[,\s]+/).filter(Boolean).map((w) => getAddress(w.toLowerCase()));
}

function buildEntries(wallets, total) {
  const n = BigInt(wallets.length);
  const { each, remainder } = equalSplit(BigInt(total), n);
  const entries = wallets.map((who, i) => ({
    who: getAddress(who),
    amt: each + (BigInt(i) < remainder ? 1n : 0n),
  }));
  return entries.filter((e) => e.amt > 0n);
}

function roundField(info, name, index) {
  const value = info?.[name] ?? info?.[index];
  return value;
}

function roundPhase(info) {
  return Number(roundField(info, "phase", 6));
}

function sortWallets(wallets) {
  return wallets.map((w) => getAddress(w.toLowerCase())).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function waitForRoundLocked(publicClient, distributor, roundId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const info = await readRoundInfo(publicClient, distributor, roundId);
    if (roundPhase(info) === PHASE_LOCKED) return info;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`round ${roundId} did not reach Locked phase`);
}

function roundPayout(info) {
  const raw = roundField(info, "payoutAmount", 3);
  return raw == null ? 0n : BigInt(raw);
}

function rpcUrls() {
  const custom = String(process.env.BASE_RPC_URL || "").trim();
  const fallbacks = [
    "https://base.llamarpc.com",
    "https://1rpc.io/base",
    "https://mainnet.base.org",
  ];
  // Dedicated provider (Alchemy, etc.) first; skip bare mainnet.base.org as primary.
  if (custom && !fallbacks.includes(custom)) {
    return [custom, ...fallbacks];
  }
  return fallbacks;
}

function makeTransport() {
  const urls = [...new Set(rpcUrls())];
  if (urls.length === 1) return http(urls[0]);
  return fallback(urls.map((url) => http(url)));
}

function isRateLimitError(err) {
  const msg = String(err?.shortMessage || err?.message || err?.details || err);
  return msg.includes("rate limit") || msg.includes("-32016");
}

async function withRpcRetry(fn, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || i === attempts - 1) throw err;
      const delayMs = 1500 * (i + 1);
      console.log(`rpc rate limited, retry ${i + 1}/${attempts - 1} in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

async function readRoundInfo(publicClient, distributor, roundId) {
  return withRpcRetry(() =>
    publicClient.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "roundInfo",
      args: [roundId],
    }),
  );
}

async function waitForRoundFunding(publicClient, distributor, roundId, { poll = false } = {}) {
  let result = await readRoundInfo(publicClient, distributor, roundId).then((info) => ({
    info,
    payoutAmount: roundPayout(info),
  }));
  if (result.payoutAmount > 0n || !poll) return result;

  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    result = await readRoundInfo(publicClient, distributor, roundId).then((info) => ({
      info,
      payoutAmount: roundPayout(info),
    }));
    if (result.payoutAmount > 0n) return result;
  }
  return result;
}

async function payAll(wallet, publicClient, roundId, merkle, startIndex = 0) {
  for (let i = startIndex; i < merkle.leaves.length; i += BATCH) {
    const slice = merkle.leaves.slice(i, i + BATCH);
    const recipients = slice.map((l) => l.who);
    const amounts = slice.map((l) => l.amt);
    const proofs = merkle.proofs.slice(i, i + BATCH);
    const hash = await wallet.writeContract({
      address: envAddr("BANKR_RENEWER_DISTRIBUTOR"),
      abi: distributorAbi,
      functionName: "payBatch",
      args: [roundId, recipients, amounts, proofs],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log("payBatch", hash, "paid", slice.length);
  }
}

async function tokenBalance(publicClient, token, holder) {
  return withRpcRetry(() =>
    publicClient.readContract({
      address: getAddress(token),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(holder)],
    }),
  );
}

function isNothingToRoute(err) {
  const msg = String(err?.shortMessage || err?.message || err?.cause?.signature || err);
  return msg.includes("NothingToRoute") || msg.includes("0x37f4322d");
}

async function routeTokenIfHeld(wallet, publicClient, router, token) {
  const bal = await tokenBalance(publicClient, token, router);
  if (bal === 0n) return 0n;
  try {
    const hash = await wallet.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "routeToken",
      args: [getAddress(token)],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log("routeToken", token, hash, receipt.status, "amount", bal.toString());
    return bal;
  } catch (e) {
    if (isNothingToRoute(e)) return 0n;
    throw e;
  }
}

async function routeFees(wallet, publicClient, router, paired, projectToken) {
  if (dryRun()) {
    console.log("dryRun route()");
    if (projectToken) console.log("dryRun routeToken", projectToken);
    return;
  }

  try {
    const hash = await wallet.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "route",
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log("route", hash, receipt.status);
  } catch (e) {
    const msg = String(e?.shortMessage || e?.message || e);
    if (!isNothingToRoute(e)) console.log("route skipped:", msg);
  }

  // route() already forwards WETH + PAIRED_TOKEN + the router's immutable PROJECT_TOKEN.
  // Only routeToken when env PROJECT_TOKEN differs (e.g. t4 vs TEST baked into router).
  if (!projectToken) return;

  const routerProject = await publicClient.readContract({
    address: router,
    abi: routerAbi,
    functionName: "PROJECT_TOKEN",
  });
  if (getAddress(routerProject) === getAddress(projectToken)) return;

  const stuck = await tokenBalance(publicClient, projectToken, router);
  if (stuck === 0n) return;

  console.log(
    "router PROJECT_TOKEN mismatch:",
    routerProject,
    "env",
    projectToken,
    "routing",
    stuck.toString(),
  );
  await routeTokenIfHeld(wallet, publicClient, router, projectToken);
}

async function findActiveRound(publicClient, distributor, projectToken) {
  const count = BigInt(
    await publicClient.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "roundCount",
    }),
  );
  for (let roundId = count - 1n; roundId >= 0n; roundId--) {
    const info = await readRoundInfo(publicClient, distributor, roundId);
    if (getAddress(roundField(info, "token", 0)) !== getAddress(projectToken)) continue;
    const phase = roundPhase(info);
    const paidCount = Number(roundField(info, "paidCount", 2) ?? 0);
    const recipientCount = Number(roundField(info, "recipientCount", 1) ?? 0);
    if (phase === PHASE_OPEN) {
      return { roundId, phase, info, paidCount, recipientCount };
    }
    if (phase === PHASE_LOCKED && paidCount < recipientCount) {
      return { roundId, phase, info, paidCount, recipientCount };
    }
  }
  return null;
}

async function findOpenRound(publicClient, distributor, projectToken) {
  const count = BigInt(
    await publicClient.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "roundCount",
    }),
  );
  for (let roundId = count - 1n; roundId >= 0n; roundId--) {
    const info = await publicClient.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "roundInfo",
      args: [roundId],
    });
    if (info[6] === PHASE_OPEN && getAddress(info[0]) === getAddress(projectToken)) {
      return roundId;
    }
  }
  return null;
}

function roundIdFromReceipt(receipt) {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: distributorAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "RoundOpened") return decoded.args.roundId;
    } catch {
      // not our event
    }
  }
  return null;
}

async function claimIfAvailable(publicClient, wallet, feeLocker, router, claimToken) {
  const available = await publicClient.readContract({
    address: feeLocker,
    abi: feeLockerAbi,
    functionName: "availableFees",
    args: [router, claimToken],
  });
  if (available === 0n) return;
  if (dryRun()) {
    console.log("dryRun feeLocker.claim", claimToken, available.toString());
    return;
  }
  const claimHash = await wallet.writeContract({
    address: feeLocker,
    abi: feeLockerAbi,
    functionName: "claim",
    args: [router, claimToken],
  });
  await publicClient.waitForTransactionReceipt({ hash: claimHash });
  console.log("feeLocker.claim", claimToken, claimHash, available.toString());
}

export async function run() {
  const transport = makeTransport();
  const account = privateKeyToAccount(key());
  const publicClient = createPublicClient({ chain: base, transport });
  const wallet = createWalletClient({ account, chain: base, transport });

  const paired = envMaybe("PAIRED_TOKEN", DEFAULT_BNKR);
  const projectToken = envMaybe("PROJECT_TOKEN");
  const router = envAddr("BANKR_FEE_ROUTER");
  const distributor = envAddr("BANKR_RENEWER_DISTRIBUTOR");

  console.log("keeper", account.address);
  console.log("dryRun", dryRun());
  console.log("epoch", process.env.EPOCH_MODE || "august_backfill");
  console.log("paired", paired || "(none)");
  console.log("project", projectToken || "(none — claim/route only)");

  const feeLocker = getAddress(CLANKER_FEE_LOCKER.toLowerCase());
  const claimTokens = [WETH, paired, projectToken].filter(Boolean);
  for (const claimToken of claimTokens) {
    await claimIfAvailable(publicClient, wallet, feeLocker, router, claimToken);
  }

  if (projectToken && !dryRun()) {
    try {
      await claimDopplerIfAvailable(publicClient, wallet, router, projectToken);
    } catch (e) {
      const msg = String(e?.shortMessage || e?.message || e);
      console.log("doppler claim skipped:", msg);
    }
  } else if (projectToken && dryRun()) {
    console.log("dryRun doppler claim for", projectToken);
  }

  await routeFees(wallet, publicClient, router, paired, projectToken);

  if (!projectToken) {
    console.log("no PROJECT_TOKEN — skipping renewer distribution");
    return;
  }

  const { wallets: duneWallets, window } = await fetchRenewers({
    apiKey: env("DUNE_API_KEY"),
    epochMode: process.env.EPOCH_MODE || "august_backfill",
    epochStart: process.env.EPOCH_START || "2026-08-01",
    epochEnd: process.env.EPOCH_END || "2026-08-28",
  });

  const rawWallets = testWallets() ?? duneWallets;
  if (rawWallets.length === 0) {
    console.log("no renewers in window", window);
    return;
  }
  console.log("renewers", rawWallets.length, window, testWallets() ? "(TEST_WALLETS override)" : "");

  if (dryRun()) {
    console.log("dryRun would openRound, absorb, lock, payBatch for", rawWallets.length, "wallets");
    return;
  }

  const active = await findActiveRound(publicClient, distributor, projectToken);
  const resumingLocked = active?.phase === PHASE_LOCKED;
  const wallets = resumingLocked ? rawWallets.map((w) => getAddress(w.toLowerCase())) : sortWallets(rawWallets);

  let roundId;
  let payoutAmount;
  let paidCount = 0;

  if (active) {
    roundId = active.roundId;
    payoutAmount = roundPayout(active.info);
    paidCount = active.paidCount;
    console.log(
      resumingLocked ? "resume locked round" : "resume open round",
      roundId.toString(),
      paidCount > 0 ? `(paid ${paidCount}/${active.recipientCount})` : "",
    );
  } else {
    const openHash = await wallet.writeContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "openRound",
      args: [projectToken],
    });
    const openReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash });
    console.log("openRound", openHash);
    roundId = roundIdFromReceipt(openReceipt);
    if (roundId === null) {
      const count = BigInt(
        await publicClient.readContract({
          address: distributor,
          abi: distributorAbi,
          functionName: "roundCount",
        }),
      );
      if (count === 0n) throw new Error("openRound succeeded but roundCount is still 0");
      roundId = count - 1n;
    }
    payoutAmount = 0n;
  }

  if (!resumingLocked) {
    ({ payoutAmount } = await waitForRoundFunding(publicClient, distributor, roundId));
    if (payoutAmount === 0n) {
      const distributorBal = await tokenBalance(publicClient, projectToken, distributor);
      const routerBal = await tokenBalance(publicClient, projectToken, router);
      if (distributorBal === 0n && routerBal > 0n) {
        console.log("routing project token to distributor before absorb", routerBal.toString());
        await routeTokenIfHeld(wallet, publicClient, router, projectToken);
      }

      try {
        const absorbHash = await wallet.writeContract({
          address: distributor,
          abi: distributorAbi,
          functionName: "absorbBalance",
          args: [roundId],
        });
        await publicClient.waitForTransactionReceipt({ hash: absorbHash });
        console.log("absorbBalance", absorbHash);
      } catch (e) {
        const msg = String(e?.shortMessage || e?.message || e);
        const distBal = await tokenBalance(publicClient, projectToken, distributor);
        const rtrBal = await tokenBalance(publicClient, projectToken, router);
        console.log("absorbBalance failed", msg, { distributorBal: distBal.toString(), routerBal: rtrBal.toString() });
        throw e;
      }

      ({ payoutAmount } = await waitForRoundFunding(publicClient, distributor, roundId, {
        poll: true,
      }));
    } else {
      console.log("round already funded", payoutAmount.toString());
    }

    if (payoutAmount === 0n) {
      console.log("no token fees to distribute this run");
      return;
    }
  }

  const entries = buildEntries(wallets, payoutAmount);
  const merkle = buildMerkle(entries);
  console.log("payout", payoutAmount.toString(), "root", merkle.root);

  if (!resumingLocked) {
    const lockHash = await wallet.writeContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "lockRound",
      args: [roundId, merkle.root, entries.length],
    });
    await publicClient.waitForTransactionReceipt({ hash: lockHash });
    console.log("lockRound", lockHash);
    await waitForRoundLocked(publicClient, distributor, roundId);
  } else {
    const lockedRoot = roundField(active.info, "merkleRoot", 5);
    if (merkle.root !== lockedRoot) {
      throw new Error(
        `merkle root mismatch for round ${roundId}: rebuilt ${merkle.root} != locked ${lockedRoot}`,
      );
    }
  }

  await payAll(wallet, publicClient, roundId, merkle, paidCount);
  console.log("done round", roundId.toString());
}

console.log("bankrprompt-keeper starting", new Date().toISOString());

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
