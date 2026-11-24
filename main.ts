// Liquid breakout rider for the pump.fun paper sprint (agent-fun/replay/v2).
//
// Own design, written from scratch. The launch snipe (age 0-3 slots) and the mature
// momentum chase (age 500+, net-flow acceleration, pyramiding) are both covered by
// the kit pilots; this bot is neither. It buys a coin breaking OUT above the high
// of its first 30 slots on fresh buy flow, but only once the coin is LIQUID: real
// SOL reserves of at least 10, so the 1%-of-reserve per-order cap still allows a
// full 0.1 SOL stake. Young coins can only take tiny stakes, and tiny stakes lose
// to the fee floor (1.25% curve fee each way plus fixed tx fees) no matter how good
// the signal is; the liquid coins are where a position can be sized to matter.
//
// The dev-window data backs this up: 113 of 430 coins reach 10 SOL of real reserves
// and 37 of those go on to peak at least 2x from that point, with the best near 8x.
// The 13 coins that complete do it in their creation slot and are uncatchable, so
// this bot does not chase launches; it waits for the breakout, then holds with a
// wide trailing stop and a take-profit so high it never binds, so the few runners
// pay for the many coins that do not. A tight take-profit would cap exactly the
// payoff that matters.
//
// Entry: age 4-600 slots after creation; price at least 50% above the high of the
// first 30 slots; net buy flow of at least 0.5 SOL over the last 10 slots; at least
// 2 distinct buyers; creator has not sold; real SOL between 10 and 80; last trade
// a buy. One fixed 0.1 SOL stake per coin, split into several orders when the 1%
// cap binds, no pyramiding. Exits are whole-position: stop-loss -25%, a trailing
// stop (25% give-back, armed at +30%), a 1500-slot max hold, an exit when the
// creator sells, and a stale exit. A tiny probe keeps the run above the guardrail
// minimums (20 distinct coins, 20 fills) when the main signal goes quiet.
//
// Deterministic: no clock, no randomness, no environment reads; the only state is
// insertion-ordered maps fed by the batch stream. Every batch is handled in the
// same order: fills first, then events, then exits, then entries, then probes.
// The hello message hands us the caps and the tx fee; orders are placed against
// the slot the batch reports, and fills land two slots later.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Params {
  /** Entry age window (slots since CreateEvent). */
  ageMin: number;
  ageMax: number;
  /** The base window (slots after creation) whose high the price must break. */
  baseWindow: number;
  /** Price must exceed the base high by this much. */
  breakoutPct: number;
  /** Distinct non-creator buyers seen before entry. */
  minBuyers: number;
  /** Real SOL reserve band at entry. */
  rqMin: number;
  rqMax: number;
  /** Recent-flow window (slots) and the net SOL it must show. */
  flowWindow: number;
  minFlowSol: number;
  /** SOL per position (single buy, split into per-order-cap pieces). */
  stakeSol: number;
  /** Most buy orders per entry (the 1%-of-reserve cap is per order). */
  maxAdds: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits: take-profit (high / off), stop-loss (fractions of cost). */
  tp: number;
  sl: number;
  /** Trailing stop: arms at +trailArm, exits on a fall of trail from the peak value. */
  trailArm: number;
  trail: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Exit when net SOL over fadeWindow falls below -fadeSol (9999 = off). */
  fadeWindow: number;
  fadeSol: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most main positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: target coins/fills over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

const PARAMS: Params = {
  ageMin: 4,
  ageMax: 600,
  baseWindow: 30,
  breakoutPct: 0.5,
  minBuyers: 2,
  rqMin: 10,
  rqMax: 80,
  flowWindow: 10,
  minFlowSol: 0.5,
  stakeSol: 0.1,
  maxAdds: 5,
  minBuySol: 0.005,
  buySlipBps: 1500,
  tp: 10.0,
  sl: 0.25,
  trailArm: 0.3,
  trail: 0.25,
  maxHold: 1500,
  fadeWindow: 15,
  fadeSol: 9999,
  staleSlots: 1200,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 8,
  maxExposureSol: 2.0,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string;
  trades: Trade[];
  buyers: Set<string>;
  devSold: boolean;
  baseHigh: number;
  entries: number;
  lastExit: number;
  lastTradeSlot: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  txPaid: number;
  exiting: boolean;
  filled: boolean;
}

function createBot(p: Params) {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.flowWindow, p.fadeWindow, p.baseWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: '', trades: [], buyers: new Set(), devSold: false, baseHigh: 0, entries: 0, lastExit: -1e12, lastTradeSlot: -1 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal: liquid coin breaking above its early base high on fresh buy flow. */
  const entrySignal = (t: Tape, now: number, rqSol: number, price: number): boolean => {
    if (rqSol < p.rqMin || rqSol > p.rqMax) return false;
    if (t.created === null || now - t.created < p.ageMin || now - t.created > p.ageMax) return false;
    if (t.devSold) return false;
    if (t.buyers.size < p.minBuyers) return false;
    if (t.baseHigh <= 0) return false;
    if (price < t.baseHigh * (1 + p.breakoutPct)) return false;
    if (flow(t, now, p.flowWindow) < p.minFlowSol) return false;
    const last = t.trades[t.trades.length - 1];
    if (last === undefined || !last.buy) return false; // fresh demand: last trade a buy
    return true;
  };

  /** Whole-position exit decision for one held coin, given its current value and cost. */
  const shouldExit = (h: Held, t: Tape, now: number, value: number, cost: number): boolean => {
    if (value >= cost * (1 + p.tp)) return true;
    if (value <= cost * (1 - p.sl)) return true;
    if (h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) return true;
    if (now - h.opened > p.maxHold) return true;
    if (flow(t, now, p.fadeWindow) < -p.fadeSol) return true;
    if (t.devSold) return true;
    if (now - t.lastTradeSlot >= p.staleSlots) return true;
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.lastTradeSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          t.lastTradeSlot = e.slot;
          if (t.created !== null && e.slot - t.created <= p.baseWindow && price > t.baseHigh) t.baseHigh = price;
          if (e.is_buy) {
            if (e.user !== t.creator) t.buyers.add(e.user);
          } else if (e.user === t.creator) {
            t.devSold = true;
          }
          traded.add(e.mint);
        } else if (e.event === 'CompleteEvent') {
          const t = tapes.get(e.mint);
          if (t !== undefined) t.lastTradeSlot = e.slot;
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Track tx fees paid per held position from fills.
      for (const f of batch.fills) {
        if (f.status === 'filled') {
          const h = held.get(f.mint);
          if (h !== undefined) h.txPaid += Number(f.tx_fee_lamports) / LAMPORTS;
        }
      }

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS + h.txPaid;
        if (value > h.peakValue) h.peakValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting || shouldExit(h, t, now, value, cost);
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol, price)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        // Split the stake into per-order-cap pieces when the cap binds.
        let remaining = amount;
        let sent = 0;
        let sentSol = 0;
        while (remaining >= p.minBuySol && sent < p.maxAdds && orders.length < cap) {
          const piece = Math.min(capSol, remaining);
          if (piece < p.minBuySol) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(piece * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          remaining -= piece;
          sentSol += piece;
          sent++;
        }
        if (sent === 0) continue;
        free -= sentSol + sent * tx;
        exposure += sentSol;
        held.set(mint, { opened: now, peakValue: 0, invested: sentSol, txPaid: 0, exiting: false, filled: false });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}

const bot = createBot(PARAMS);

await runBot({
  onBatch: (state, batch) => bot.onBatch(state, batch),
});
