import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { buildMerkle, equalSplit } from "./merkle.js";
import { fetchRenewers } from "./dune.js";

const BATCH = Number(process.env.PAY_BATCH_SIZE || "40");

const routerAbi = parseAbi([
  "function route() returns (uint256 wethAmount, uint256 tokenAmount)",
]);
const distributorAbi = parseAbi([
  "function roundCount() view returns (uint256)",
  "function openRound(address token) returns (uint256 roundId)",
  "function absorbBalance(uint256 roundId) returns (uint256 added)",
  "function lockRound(uint256 roundId, bytes32 merkleRoot, uint32 recipientCount)",
  "function payBatch(uint256 roundId, address[] recipients, uint256[] amounts, bytes32[][] proofs)",
  "function roundInfo(uint256 roundId) view returns (address token, uint32 recipientCount, uint32 paidCount, uint256 payoutAmount, uint256 paidOut, bytes32 merkleRoot, uint8 phase)",
]);

function env(name, fallback = "") {
  const v = String(process.env[name] || fallback).trim();
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

function envAddr(name) {
  return getAddress(env(name).toLowerCase());
}

function key() {
  const raw = env("KEEPER_KEY");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
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

async function payAll(wallet, publicClient, roundId, merkle) {
  for (let i = 0; i < merkle.leaves.length; i += BATCH) {
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

export async function run() {
  const rpc = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const account = privateKeyToAccount(key());
  const publicClient = createPublicClient({ chain: base, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain: base, transport: http(rpc) });

  const token = envAddr("PROJECT_TOKEN");
  const router = envAddr("BANKR_FEE_ROUTER");
  const distributor = envAddr("BANKR_RENEWER_DISTRIBUTOR");

  console.log("keeper", account.address);
  console.log("epoch", process.env.EPOCH_MODE || "august_backfill");

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
    if (!msg.includes("NothingToRoute")) console.log("route skipped:", msg);
  }

  const { wallets, window } = await fetchRenewers({
    apiKey: env("DUNE_API_KEY"),
    epochMode: process.env.EPOCH_MODE || "august_backfill",
    epochStart: process.env.EPOCH_START || "2026-08-01",
    epochEnd: process.env.EPOCH_END || "2026-08-31",
  });

  if (wallets.length === 0) {
    console.log("no renewers in window", window);
    return;
  }
  console.log("renewers", wallets.length, window);

  const openHash = await wallet.writeContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "openRound",
    args: [token],
  });
  await publicClient.waitForTransactionReceipt({ hash: openHash });
  console.log("openRound", openHash);

  let openedRoundId = await publicClient.readContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "roundCount",
  });
  openedRoundId -= 1n;

  const absorbHash = await wallet.writeContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "absorbBalance",
    args: [openedRoundId],
  });
  await publicClient.waitForTransactionReceipt({ hash: absorbHash });
  console.log("absorbBalance", absorbHash);

  const info = await publicClient.readContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "roundInfo",
    args: [openedRoundId],
  });
  const payoutAmount = info[3];
  if (payoutAmount === 0n) {
    console.log("no token fees to distribute this run");
    return;
  }

  const entries = buildEntries(wallets, payoutAmount);
  const merkle = buildMerkle(entries);
  console.log("payout", payoutAmount.toString(), "root", merkle.root);

  const lockHash = await wallet.writeContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "lockRound",
    args: [openedRoundId, merkle.root, entries.length],
  });
  await publicClient.waitForTransactionReceipt({ hash: lockHash });
  console.log("lockRound", lockHash);

  await payAll(wallet, publicClient, openedRoundId, merkle);
  console.log("done round", openedRoundId.toString());
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
