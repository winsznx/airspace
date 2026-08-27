// FLIGHTPATH live spike driver -- Somnia Shannon (chainId 50312).
//
// Runs the full owner/agent lifecycle against the REAL deployed DreamDEX Event
// Contracts and writes evidence/live-run.json. Nothing is mocked.
//
//   node script/live.mjs
//
// Positive legs are broadcast transactions. Negative legs are executed as
// eth_call against live state -- the same bytecode, the same storage, the same
// block -- and a few are additionally broadcast so the rejection is on-chain.

import { createPublicClient, createWalletClient, http, parseAbi, decodeErrorResult, keccak256, toBytes, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

const RPC = "https://dream-rpc.somnia.network";
const CHAIN = { id: 50312, name: "Somnia Shannon", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };

const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
const OUTCOME = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9";
const TUSDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const MARKET_CREATOR = "0x94D963B6670AB96E78C8d0C46ca35D196d606EFE";
const FACTORY = process.env.FACTORY ?? "0x96F5f7aCED65149440dC8807C2CD2f66514fc2a2";
const INDEXER = "https://dev.smk.somnia.host/v1/graphql";

const wallets = JSON.parse(fs.readFileSync(".wallets.json", "utf8"));
const OWNER = privateKeyToAccount(wallets.OWNER.private_key);
const AGENT = privateKeyToAccount(wallets.AGENT.private_key);

const art = (n) => JSON.parse(fs.readFileSync(`out/${n}.sol/${n}.json`, "utf8")).abi;
const ACCOUNT_ABI = art("FlightAccount");
const FACTORY_ABI = art("FlightFactory");

const moduleAbi = parseAbi([
  "function markets(bytes32 marketId) view returns (uint256 oracleQuestionId, uint8 outcomeSlotCount, uint8 voidPolicy, address collateral, uint32 originOperatorId, bytes32 originVenueId, address oracleAdapter, address creator, address market, address pool, uint256 yesId, uint256 noId, uint64 tradingStart, uint64 expiry)",
]);
const poolAbi = parseAbi([
  "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  "function marketNonce() view returns (uint64)",
  "function marketExpiryNs() view returns (uint64)",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function faucet(uint256)"]);
const erc6909 = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)"]);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const ownerW = createWalletClient({ account: OWNER, chain: CHAIN, transport: http(RPC) });
const agentW = createWalletClient({ account: AGENT, chain: CHAIN, transport: http(RPC) });

const ev = { chainId: 50312, startedAt: new Date().toISOString(), protocol: { MODULE, OUTCOME, TUSDC, MARKET_CREATOR, FACTORY }, actors: { owner: OWNER.address, agent: AGENT.address }, steps: [] };
const log = (name, data) => { console.log(`\n[${name}]`, JSON.stringify(data, (k, v) => (typeof v === "bigint" ? v.toString() : v), 1)); ev.steps.push({ name, ...JSON.parse(JSON.stringify(data, (k, v) => (typeof v === "bigint" ? v.toString() : v))) }); };

async function send(w, req, label) {
  const hash = await w.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${label}: ${hash} status=${r.status}`);
  return { hash, status: r.status, gasUsed: r.gasUsed, blockNumber: r.blockNumber };
}

function decodeRevert(err) {
  // viem wraps the revert several layers deep and usually decodes custom errors
  // itself when the ABI carries them; fall back to raw selector decoding.
  const seen = [];
  let e = err;
  for (let i = 0; i < 8 && e; i++) {
    seen.push(e);
    if (e.name === "ContractFunctionRevertedError" && e.data?.errorName) {
      return { error: e.data.errorName, raw: e.signature ?? null };
    }
    e = e.cause;
  }
  for (const c of seen) {
    const raw = typeof c?.data === "string" ? c.data : c?.data?.data ?? c?.raw;
    if (typeof raw === "string" && raw.startsWith("0x") && raw.length >= 10) {
      try {
        const d = decodeErrorResult({ abi: ACCOUNT_ABI, data: raw });
        return { error: d.errorName, raw };
      } catch { return { error: "undecoded", raw }; }
    }
  }
  const m = /Error:\s*([A-Za-z0-9_]+)\(\)/.exec(err?.message ?? "");
  if (m) return { error: m[1], raw: null };
  return { error: "unknown", raw: null };
}

/** Simulate an agent call and REQUIRE it to revert with `expected`. */
async function expectRevert(label, expected, call) {
  try {
    await pub.simulateContract(call);
    throw new Error(`${label}: expected revert ${expected} but the call SUCCEEDED`);
  } catch (e) {
    if (e.message?.includes("but the call SUCCEEDED")) throw e;
    const d = decodeRevert(e);
    const ok = d.error === expected;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${label}: got ${d.error} (expected ${expected})`);
    if (!ok) throw new Error(`${label}: expected ${expected}, got ${d.error} (${d.raw})`);
    return { label, expected, got: d.error, selector: d.raw?.slice(0, 10) ?? null };
  }
}

// ---------------------------------------------------------------------------

async function pickMarket() {
  const q = `{ Market(where:{marketType:{_eq:"BINARY"}, clobStatus:{_eq:"Trading"}, finalized:{_eq:false}}, order_by:{expiry:desc}, limit:40){ marketId asset intervalSec expiry binaryPoolAddress } }`;
  const res = await fetch(INDEXER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) }).then((r) => r.json());
  const now = Math.floor(Date.now() / 1000);
  // Indexer status lags, so the chain is the arbiter: we only shortlist here.
  const cands = res.data.Market.filter((m) => Number(m.expiry) - now > 900).sort((a, b) => Number(a.expiry) - Number(b.expiry));
  for (const c of cands) {
    const id = `0x${BigInt(c.marketId).toString(16).padStart(64, "0")}`;
    const rec = await pub.readContract({ address: MODULE, abi: moduleAbi, functionName: "markets", args: [id] });
    if (rec[9] === "0x0000000000000000000000000000000000000000") continue;
    const asks = await pub.readContract({ address: rec[9], abi: poolAbi, functionName: "getBookLevels", args: [false, 3n] });
    if (asks.length === 0) continue;
    return { id, asset: c.asset, intervalSec: Number(c.intervalSec), rec, asks };
  }
  throw new Error("no live market with a resting ask found");
}

(async () => {
  console.log("=== FLIGHTPATH live spike ===");

  const m = await pickMarket();
  const [, , , collateral, , , , creator, market, pool, yesId, noId, tradingStart, expiry] = m.rec;
  const marketNonce = await pub.readContract({ address: pool, abi: poolAbi, functionName: "marketNonce" });
  const marketExpiryNs = await pub.readContract({ address: pool, abi: poolAbi, functionName: "marketExpiryNs" });
  const grid = await pub.readContract({ address: pool, abi: poolAbi, functionName: "getOrderBookParameters" });
  const now = Math.floor(Date.now() / 1000);

  log("00-market-selected", { marketId: m.id, asset: m.asset, intervalSec: m.intervalSec, pool, market, creator, collateral, marketNonce, tradingStart, expiry, secondsLeft: Number(expiry) - now, cadenceOnChain: Number(expiry) - Number(tradingStart), yesId, noId, grid, bestAsk: m.asks[0] });

  // --- 1. owner creates the account -----------------------------------------
  const salt = keccak256(toBytes(`flightpath-spike-${Date.now()}`));
  const { request: cr } = await pub.simulateContract({ account: OWNER, address: FACTORY, abi: FACTORY_ABI, functionName: "createAccount", args: [OWNER.address, AGENT.address, salt] });
  const crTx = await send(ownerW, cr, "createAccount");
  const acct = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: "accountFor", args: [OWNER.address, salt] });
  log("01-account-created", { account: acct, salt, ...crTx });

  // --- 2. owner funds the account (faucet credits msg.sender = the account) --
  const faucetData = { abi: erc20, functionName: "faucet", args: [2000n * 10n ** 6n] };
  const { request: fr } = await pub.simulateContract({ account: OWNER, address: acct, abi: ACCOUNT_ABI, functionName: "ownerCall", args: [TUSDC, 0n, "0x57915897" + (2000n * 10n ** 6n).toString(16).padStart(64, "0")] });
  const frTx = await send(ownerW, fr, "fund via ownerCall(faucet)");
  const funded = await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [acct] });
  log("02-account-funded", { account: acct, tUSDC: funded, ...frTx });

  // --- 3. owner installs the policy ----------------------------------------
  const seriesId = { "BTC:900": 1, "ETH:900": 2, "BTC:3600": 3, "ETH:3600": 4, "BTC:14400": 5, "ETH:14400": 6, "BTC:86400": 7, "ETH:86400": 8, "BTC:300": 10, "ETH:300": 11 }[`${m.asset}:${m.intervalSec}`] ?? 0;
  const askPrice = m.asks[0].price;
  const policy = {
    mode: 0, // EXACT
    marketId: m.id,
    marketCreator: MARKET_CREATOR,
    seriesId,
    assetHash: keccak256(toBytes(m.asset)),
    collateral,
    intervalSec: BigInt(Number(expiry) - Number(tradingStart)),
    maxOrderNotional: 500n * 10n ** 6n,
    maxExposure: 1000n * 10n ** 6n,
    maxBuyPrice: askPrice,
    minSellPrice: 300000n,
    minHeadroomSec: 300n,
    cooldownSec: 0n,
    policyExpiry: BigInt(now + 3600),
  };
  const { request: pr } = await pub.simulateContract({ account: OWNER, address: acct, abi: ACCOUNT_ABI, functionName: "setPolicy", args: [policy] });
  const prTx = await send(ownerW, pr, "setPolicy");
  const policyHash = await pub.readContract({ address: acct, abi: ACCOUNT_ABI, functionName: "policyHash" });
  log("03-policy-set", { policyHash, policy, ...prTx });

  // --- 4. agent executes a real trade --------------------------------------
  const qty = m.asks[0].quantity < 200000000n ? m.asks[0].quantity : 200000000n;
  const intent = { marketId: m.id, pool, marketNonce, kind: 0, price: askPrice, quantity: qty, expireTimestampNs: marketExpiryNs, orderType: 2, nonce: 1n, strategyVersion: keccak256(toBytes("flightpath-spike/v1")) };

  const preState = await pub.readContract({ address: acct, abi: ACCOUNT_ABI, functionName: "preTradeStateHash", args: [intent] });
  const intentHash = await pub.readContract({ address: acct, abi: ACCOUNT_ABI, functionName: "hashIntent", args: [intent] });
  const collBefore = await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [acct] });

  const { request: xr } = await pub.simulateContract({ account: AGENT, address: acct, abi: ACCOUNT_ABI, functionName: "execute", args: [intent] });
  const xrTx = await send(agentW, xr, "AGENT execute");

  const collAfter = await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [acct] });
  const yesAcct = await pub.readContract({ address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [acct, yesId] });
  const yesAgent = await pub.readContract({ address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [AGENT.address, yesId] });
  const yesOwner = await pub.readContract({ address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [OWNER.address, yesId] });
  const collAgent = await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [AGENT.address] });

  log("04-agent-trade", {
    intent, intentHash, policyHash, preTradeStateHash: preState, ...xrTx,
    collateralSpent: collBefore - collAfter,
    resultingExposure: { account_YES: yesAcct, agent_YES: yesAgent, ownerEOA_YES: yesOwner, agent_tUSDC: collAgent },
    custodyAssertion: yesAcct > 0n && yesAgent === 0n && yesOwner === 0n && collAgent === 0n ? "POSITION HELD BY EXECUTION ACCOUNT ONLY" : "CUSTODY ASSERTION FAILED",
  });
  if (!(yesAcct > 0n && yesAgent === 0n && collAgent === 0n)) throw new Error("custody assertion failed");

  // --- 5. live negative proofs ---------------------------------------------
  const negs = [];
  const A = (over) => ({ account: AGENT.address, address: acct, abi: ACCOUNT_ABI, functionName: "execute", args: [{ ...intent, ...over }] });

  negs.push(await expectRevert("N-replay (same nonce)", "IntentReplayed", A({})));
  negs.push(await expectRevert("N-wrong-marketId", "MarketNotBound", A({ marketId: `0x${(BigInt(m.id) - 1n).toString(16).padStart(64, "0")}`, nonce: 2n })));
  negs.push(await expectRevert("N-stale-generation", "GenerationMismatch", A({ marketNonce: marketNonce - 1n, nonce: 3n })));
  negs.push(await expectRevert("N-pool-substitution", "PoolMismatch", A({ pool: "0x000000000000000000000000000000000000dEaD", nonce: 4n })));
  negs.push(await expectRevert("N-price-outside-policy", "PriceOutsidePolicy", A({ price: askPrice + BigInt(grid.tickSize), nonce: 5n })));
  negs.push(await expectRevert("N-off-tick-grid", "OffTickGrid", A({ price: askPrice - 1n, nonce: 6n })));
  negs.push(await expectRevert("N-agent-cannot-withdraw", "NotOwner", { account: AGENT.address, address: acct, abi: ACCOUNT_ABI, functionName: "withdraw", args: [TUSDC, AGENT.address, 1n] }));
  negs.push(await expectRevert("N-agent-cannot-withdraw-outcome", "NotOwner", { account: AGENT.address, address: acct, abi: ACCOUNT_ABI, functionName: "withdrawOutcome", args: [yesId, AGENT.address, 1n] }));
  negs.push(await expectRevert("N-agent-cannot-ownerCall", "NotOwner", { account: AGENT.address, address: acct, abi: ACCOUNT_ABI, functionName: "ownerCall", args: [TUSDC, 0n, "0x"] }));
  negs.push(await expectRevert("N-agent-cannot-setAgent", "NotOwner", { account: AGENT.address, address: acct, abi: ACCOUNT_ABI, functionName: "setAgent", args: [AGENT.address] }));
  log("05-negatives-simulated-live", { count: negs.length, negs });

  // Broadcast two rejections so the refusal is itself on-chain evidence.
  const broadcastNegs = [];
  for (const [label, over] of [["over-order-notional", { nonce: 20n }], ["agent-withdraw", null]]) {
    try {
      let hash;
      if (over) {
        // tighten the policy so the SAME order is now over the cap
        const tight = { ...policy, maxOrderNotional: 1n * 10n ** 6n };
        const { request } = await pub.simulateContract({ account: OWNER, address: acct, abi: ACCOUNT_ABI, functionName: "setPolicy", args: [tight] });
        await send(ownerW, request, "setPolicy(tight)");
        hash = await agentW.writeContract({ address: acct, abi: ACCOUNT_ABI, functionName: "execute", args: [{ ...intent, nonce: 20n }], gas: 900000n });
      } else {
        hash = await agentW.writeContract({ address: acct, abi: ACCOUNT_ABI, functionName: "withdraw", args: [TUSDC, AGENT.address, 1n], gas: 200000n });
      }
      const r = await pub.waitForTransactionReceipt({ hash });
      broadcastNegs.push({ label, hash, status: r.status });
      console.log(`  broadcast ${label}: ${hash} status=${r.status} (expected reverted)`);
    } catch (e) {
      broadcastNegs.push({ label, error: String(e.message).slice(0, 200) });
      console.log(`  broadcast ${label}: rejected pre-flight -> ${String(e.message).slice(0, 120)}`);
    }
  }
  log("06-negatives-broadcast", { broadcastNegs });

  // --- 6. owner recovery, agent fully revoked -------------------------------
  const { request: sa } = await pub.simulateContract({ account: OWNER, address: acct, abi: ACCOUNT_ABI, functionName: "setAgent", args: ["0x0000000000000000000000000000000000000000"] });
  const saTx = await send(ownerW, sa, "setAgent(0) -- revoke agent");

  const idle = await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [acct] });
  const { request: wr } = await pub.simulateContract({ account: OWNER, address: acct, abi: ACCOUNT_ABI, functionName: "withdraw", args: [TUSDC, OWNER.address, idle] });
  const wrTx = await send(ownerW, wr, "owner withdraw collateral");

  const posn = await pub.readContract({ address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [acct, yesId] });
  const { request: wo } = await pub.simulateContract({ account: OWNER, address: acct, abi: ACCOUNT_ABI, functionName: "withdrawOutcome", args: [yesId, OWNER.address, posn] });
  const woTx = await send(ownerW, wo, "owner withdraw outcome tokens");

  log("07-owner-recovery", {
    agentRevoked: true, revokeTx: saTx,
    collateralRecovered: idle, collateralTx: wrTx,
    positionRecovered: posn, positionTx: woTx,
    accountResidualCollateral: await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [acct] }),
    accountResidualPosition: await pub.readContract({ address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [acct, yesId] }),
    ownerHoldsPosition: await pub.readContract({ address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [OWNER.address, yesId] }),
  });

  ev.finishedAt = new Date().toISOString();
  fs.mkdirSync("evidence", { recursive: true });
  fs.writeFileSync("evidence/live-run.json", JSON.stringify(ev, null, 2));
  console.log("\n=== wrote evidence/live-run.json ===");
})().catch((e) => { console.error("\nFATAL:", e.message); ev.fatal = e.message; fs.mkdirSync("evidence", { recursive: true }); fs.writeFileSync("evidence/live-run.json", JSON.stringify(ev, null, 2)); process.exit(1); });
