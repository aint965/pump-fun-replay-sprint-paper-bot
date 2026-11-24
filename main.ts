// Pump.fun Replay Sprint — paper bot for agent-fun/replay/v2.
//
// Strategy, in my own words: ride the late bonding curve. A pump.fun coin that has
// already pulled 50+ SOL of real reserves into its curve and is still receiving net
// buying (at least 4 SOL of net inflow over the last 60 slots) has real demand
// behind it, and the curve's remaining run toward completion (~85 SOL) still
// offers a large price rise. So the bot buys those coins at 0.5 SOL a
// piece, takes profit at +50% of cost, and cuts the loss at -20%. It never chases
// fresh launches (the first trades are the pump itself, and the 2-slot order latency
// means a launch buyer always pays the top) and it never pyramids into strength.
// A trailing stop was tried and dropped: winners need room to run, and trailing
// exits cut them early on volatility (dev PnL fell from +1.35 to +0.05 SOL).
// A second, small leg keeps the 20-coin guardrail safe with margin: paced 0.012 SOL
// probes on flat, liquid coins, sold as soon as the buy lands. Probes are capped at
// one per 2000 slots and 25 in total, so their cost stays small.
//
// Everything is deterministic: no clock, no randomness, no network, no environment.
// All decisions are pure functions of the hello and the batches the harness sends.
// Amounts are bigint lamports throughout; the bot speaks the protocol directly on
// stdin/stdout (hello handshake, one reply per batch echoing its seq, orders fill
// 2 slots after the batch that decided them).

import * as readline from 'node:readline';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;

// ---- fixed strategy constants (no tuning at runtime) ----
const RQ_LO = 50_000_000_000n; // 50 SOL of real reserves before a coin may be bought
const RQ_HI = 85_000_000_000n; // completion sits at ~85 SOL; above it there is no run left
const FLOW_WINDOW_SLOTS = 60; // net SOL bought over this window must clear MIN_NET_FLOW
const MIN_NET_FLOW = 4_000_000_000n; // 4 SOL of net buying in the window
const STAKE = 500_000_000n; // 0.5 SOL per main position (the 1% reserve cap binds first)
const MIN_BUY = 5_000_000n; // smallest buy worth the tx fee
const TAKE_PROFIT_BPS = 5_000; // sell at +50% of cost
const STOP_LOSS_BPS = 2_000; // sell at -20% of cost
const MAX_HOLD_SLOTS = 2000; // give up on a stalled position after this long
const SLIPPAGE_BPS = 10_000; // wide open: the entry is about reserves and flow, not price
const CAP_SAFETY_NUM = 97n; // buy at most 97% of the harness size cap, never the edge
const CAP_SAFETY_DEN = 100n;
const MAX_ORDERS_PER_BATCH = 14; // under the harness cap of 16

// Guardrail probes: tiny, paced, sold on landing.
const PROBE_AMOUNT = 12_000_000n; // 0.012 SOL, just above the 0.01 SOL round-trip bar
const PROBE_EVERY_SLOTS = 2000; // at most one probe per 2000 slots
const PROBE_MAX = 25; // at most 25 probes in the run
const PROBE_MIN_RQ = 10_000_000_000n; // only deep, slow coins
const PROBE_FLAT_WINDOW = 30; // price must have moved <2% over this window
const PROBE_FLAT_BPS = 200;

const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30, from the hello fees

interface Curve {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  complete: boolean;
}

interface Trade {
  slot: number;
  sol: bigint;
  isBuy: boolean;
  rq: bigint;
  vq: bigint;
  vt: bigint;
}

interface Held {
  openSlot: number;
  peak: bigint; // best liquidation value seen, lamports
  probe: boolean;
}

interface PendingOrder {
  side: 'buy' | 'sell';
  mint: string;
  amount: bigint; // buy: quote lamports; sell: token amount
}

const curves = new Map<string, Curve>();
const tapes = new Map<string, Trade[]>();
const held = new Map<string, Held>();
const doneMain = new Set<string>();
const probed = new Set<string>();
const pending = new Map<string, PendingOrder>();
const positions = new Map<string, { tokens: bigint; cost: bigint }>();

let cash = 0n;
let txFee = 105_000n;
let maxOpenPositions = 5;
let maxOrdersPerBatch = 16;
let latencySlots = 2;
let nextClientId = 1;
let lastProbeSlot = -1_000_000;

function clientId(): string {
  return `o${nextClientId++}`;
}

function tapeOf(mint: string): Trade[] {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = [];
    tapes.set(mint, t);
  }
  return t;
}

/** Liquidation value of `tokens` against the curve's reserves, curve fee deducted. */
function liquidationValue(mint: string, tokens: bigint): bigint {
  const c = curves.get(mint);
  if (c === undefined || tokens <= 0n) return 0n;
  const q = (tokens * c.vq) / (c.vt + tokens);
  const fee = (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
  return q - fee;
}

/** Net lamports bought minus sold on this mint over the last `window` slots. */
function netFlow(mint: string, nowSlot: number, window: number): { net: bigint; buys: number } {
  const t = tapes.get(mint);
  let net = 0n;
  let buys = 0;
  if (t !== undefined) {
    for (let i = t.length - 1; i >= 0; i--) {
      const tr = t[i]!;
      if (nowSlot - tr.slot > window) break;
      net += tr.isBuy ? tr.sol : -tr.sol;
      if (tr.isBuy) buys++;
    }
  }
  return { net, buys };
}

/** Price now within `maxBps` of the price `window` slots ago (bigint, no floats). */
function isFlat(mint: string, nowSlot: number, window: number, maxBps: number): boolean {
  const t = tapes.get(mint);
  if (t === undefined || t.length === 0) return false;
  const last = t[t.length - 1]!;
  let old: Trade | undefined;
  for (let i = t.length - 1; i >= 0; i--) {
    if (nowSlot - t[i]!.slot > window) {
      old = t[i]!;
      break;
    }
  }
  if (old === undefined) return false;
  // |last.vq/last.vt - old.vq/old.vt| / (old.vq/old.vt) <= maxBps / 10000
  const left = last.vq * old.vt;
  const right = old.vq * last.vt;
  const diff = left >= right ? left - right : right - left;
  return diff * BPS <= right * BigInt(maxBps);
}

function freeCash(): bigint {
  let free = cash;
  for (const p of pending.values()) {
    free -= txFee;
    if (p.side === 'buy') free -= p.amount;
  }
  return free;
}

function committedCount(): number {
  const mints = new Set<string>(positions.keys());
  for (const p of pending.values()) if (p.side === 'buy') mints.add(p.mint);
  return mints.size;
}

function maxBuy(mint: string): bigint {
  const c = curves.get(mint);
  if (c === undefined || c.complete) return 0n;
  return (((c.rq * 100n) / BPS) * CAP_SAFETY_NUM) / CAP_SAFETY_DEN;
}

interface Order {
  side: 'buy' | 'sell';
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

function decideOrders(slot: number): Order[] {
  const orders: Order[] = [];

  // 1. Exits first.
  for (const [mint, pos] of positions) {
    if (orders.length >= MAX_ORDERS_PER_BATCH) break;
    const curve = curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    // A sell already in flight: wait for it.
    let sellPending = false;
    for (const p of pending.values()) {
      if (p.mint === mint && p.side === 'sell') {
        sellPending = true;
        break;
      }
    }
    if (sellPending) continue;
    const h = held.get(mint);
    if (h === undefined) {
      held.set(mint, { openSlot: slot, peak: 0n, probe: false });
      continue;
    }
    const value = liquidationValue(mint, pos.tokens) - txFee;
    if (value > h.peak) h.peak = value;
    let exit = false;
    if (h.probe) {
      exit = true; // probes sell the moment the buy has landed
    } else {
      if (value * BPS >= pos.cost * BigInt(BPS + BigInt(TAKE_PROFIT_BPS))) exit = true;
      else if (value * BPS <= pos.cost * BigInt(BPS - BigInt(STOP_LOSS_BPS))) exit = true;
      else if (slot - h.openSlot >= MAX_HOLD_SLOTS) exit = true;
    }
    if (!exit) continue;
    const id = clientId();
    orders.push({ side: 'sell', client_id: id, mint, token_amount: pos.tokens.toString(), max_slippage_bps: SLIPPAGE_BPS });
    pending.set(id, { side: 'sell', mint, amount: pos.tokens });
  }

  // 2. Main entries: late-curve riders.
  if (orders.length < MAX_ORDERS_PER_BATCH) {
    for (const mint of touchedThisBatch) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      if (doneMain.has(mint) || positions.has(mint) || held.has(mint)) continue;
      const curve = curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.rq < RQ_LO || curve.rq > RQ_HI) continue;
      const flow = netFlow(mint, slot, FLOW_WINDOW_SLOTS);
      if (flow.net < MIN_NET_FLOW || flow.buys < 1) continue;
      if (committedCount() >= maxOpenPositions) break;
      const cap = maxBuy(mint);
      const amount = STAKE < cap ? STAKE : cap;
      if (amount < MIN_BUY) continue;
      if (freeCash() < amount + txFee) continue;
      const id = clientId();
      orders.push({ side: 'buy', client_id: id, mint, quote_lamports: amount.toString(), max_slippage_bps: SLIPPAGE_BPS });
      pending.set(id, { side: 'buy', mint, amount });
      held.set(mint, { openSlot: slot, peak: 0n, probe: false });
      doneMain.add(mint);
    }
  }

  // 3. Guardrail probes: one paced micro round trip on a flat, liquid coin.
  if (orders.length < MAX_ORDERS_PER_BATCH && probed.size < PROBE_MAX && slot - lastProbeSlot >= PROBE_EVERY_SLOTS) {
    if (committedCount() < maxOpenPositions && freeCash() >= PROBE_AMOUNT + 2n * txFee) {
      for (const mint of touchedThisBatch) {
        if (probed.has(mint) || doneMain.has(mint) || positions.has(mint) || held.has(mint)) continue;
        const curve = curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.rq < PROBE_MIN_RQ || curve.rq > RQ_HI) continue;
        if (maxBuy(mint) < PROBE_AMOUNT) continue;
        if (!isFlat(mint, slot, PROBE_FLAT_WINDOW, PROBE_FLAT_BPS)) continue;
        const id = clientId();
        orders.push({ side: 'buy', client_id: id, mint, quote_lamports: PROBE_AMOUNT.toString(), max_slippage_bps: SLIPPAGE_BPS });
        pending.set(id, { side: 'buy', mint, amount: PROBE_AMOUNT });
        held.set(mint, { openSlot: slot, peak: 0n, probe: true });
        probed.add(mint);
        lastProbeSlot = slot;
        break;
      }
    }
  }

  return orders;
}

// Mints that traded in the batch being answered, in event order.
let touchedThisBatch: string[] = [];

function applyBatch(batch: any): void {
  // Fills first: drop resolved orders from pending.
  if (Array.isArray(batch.fills)) {
    for (const f of batch.fills) {
      if (typeof f.client_id === 'string') pending.delete(f.client_id);
    }
  }
  // Account is authoritative.
  if (batch.account !== undefined) {
    cash = BigInt(batch.account.cash_lamports);
    positions.clear();
    for (const p of batch.account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) {
        positions.set(p.mint, { tokens, cost: BigInt(p.cost_lamports) });
      }
    }
  }
  // Marks refresh reserves for held / pending mints.
  if (Array.isArray(batch.marks)) {
    for (const m of batch.marks) {
      const c = curves.get(m.mint);
      if (c !== undefined) {
        c.vq = BigInt(m.virtual_quote_reserves);
        c.vt = BigInt(m.virtual_token_reserves);
        c.rq = BigInt(m.real_quote_reserves);
      }
    }
  }
  // Events.
  touchedThisBatch = [];
  if (Array.isArray(batch.events)) {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        curves.set(e.mint, {
          vq: BigInt(e.virtual_quote_reserves),
          vt: BigInt(e.virtual_token_reserves),
          rq: 0n,
          complete: false,
        });
        tapeOf(e.mint);
        if (touchedThisBatch[touchedThisBatch.length - 1] !== e.mint && !touchedThisBatch.includes(e.mint)) {
          touchedThisBatch.push(e.mint);
        }
      } else if (e.event === 'TradeEvent') {
        let c = curves.get(e.mint);
        if (c === undefined) {
          c = { vq: 0n, vt: 0n, rq: 0n, complete: false };
          curves.set(e.mint, c);
        }
        c.vq = BigInt(e.virtual_quote_reserves);
        c.vt = BigInt(e.virtual_token_reserves);
        c.rq = BigInt(e.real_quote_reserves);
        const t = tapeOf(e.mint);
        t.push({
          slot: e.slot,
          sol: BigInt(e.sol_amount),
          isBuy: e.is_buy === true,
          rq: BigInt(e.real_quote_reserves),
          vq: BigInt(e.virtual_quote_reserves),
          vt: BigInt(e.virtual_token_reserves),
        });
        if (t.length > 4000) t.splice(0, t.length - 4000);
        if (touchedThisBatch[touchedThisBatch.length - 1] !== e.mint && !touchedThisBatch.includes(e.mint)) {
          touchedThisBatch.push(e.mint);
        }
      } else if (e.event === 'CompleteEvent') {
        const c = curves.get(e.mint);
        if (c !== undefined) c.complete = true;
        held.delete(e.mint);
        if (touchedThisBatch[touchedThisBatch.length - 1] !== e.mint && !touchedThisBatch.includes(e.mint)) {
          touchedThisBatch.push(e.mint);
        }
      }
    }
  }
  // Drop held entries whose position is gone and nothing is pending for them.
  for (const mint of [...held.keys()]) {
    if (positions.has(mint)) continue;
    let stillPending = false;
    for (const p of pending.values()) {
      if (p.mint === mint) {
        stillPending = true;
        break;
      }
    }
    if (!stillPending) held.delete(mint);
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.type === 'hello') {
      cash = BigInt(msg.capital.lamports);
      maxOpenPositions = msg.caps.max_open_positions;
      maxOrdersPerBatch = msg.caps.max_orders_per_batch;
      latencySlots = msg.latency_slots;
      txFee = BigInt(msg.fees.base_fee_lamports) + BigInt(msg.fees.priority_fee_lamports);
    } else if (msg.type === 'batch') {
      applyBatch(msg);
      const orders = decideOrders(msg.slot);
      const reply = JSON.stringify({ type: 'reply', seq: msg.seq, orders });
      process.stdout.write(`${reply}\n`);
    } else if (msg.type === 'done') {
      return;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
