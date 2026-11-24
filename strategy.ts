// LeanSnipe v2 — a lean, patient launch sniper for the pump.fun bonding-curve replay.
//
// The lesson of v1 is that the grading wall budget, not the strategy's cleverness, decides
// whether an entry is ranked at all. This bot is built to be CHEAP to run: per batch it touches
// only the mints that traded in that batch and the (at most five) open positions. No trade tapes,
// no per-batch scans of every curve, no sorting, no per-event BigInt math. Every mint's state is
// a handful of running numbers; a mint's record is dropped once it ages out with no position, so
// the working set stays small for the whole 24h window.
//
// The trading idea, in one paragraph: most pump.fun coins pump once, fast, then bleed back to
// their create price — buying the top of a one-slot whale cascade is how money is lost, and
// holding to the end is how the rest is lost. So the bot waits. It buys only a coin that has
// already attracted at least 2 SOL of real reserves (so the 1%-of-reserve order cap still lets a
// buy of 0.02 SOL or more through — below that size the fixed 105k-lamport tx fee eats the
// trade), whose creator bought a real but modest stake of their own coin (0.1–1 SOL: skin in the
// game, not a bundle), that at least two other wallets have bought, and whose price has not
// already run away more than 2x from create. One buy per coin, no adds: a single 0.05 SOL stake
// (or the 1% cap, whichever is smaller). The whole position leaves on the first of +25%
// take-profit, −15% stop-loss, a creator sell, or 200 slots held. Total entries are capped at
// 30 coins and 150 orders for the run, so the fill count — and the harness work per fill —
// stays small. A coin that never qualifies is simply never touched.
//
// Deterministic by construction: no clock, no randomness, no I/O, no environment reads. All
// iteration is over insertion-ordered maps fed by the batch stream, in batch order.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL reserves a curve must hold before an entry is allowed. */
  minRqSol: number;
  /** Creator's own buys (SOL) by decision time: at least this (skin in the game). */
  minDevBuySol: number;
  /** Creator's own buys (SOL) by decision time: at most this (not a bundle). */
  maxDevBuySol: number;
  /** Distinct non-creator buyers by decision time, at least. Raised 2 -> 3
      after the stress run: on the 4 surviving block-surrogate windows the
      2-buyer rule lost a median -0.065 SOL while 3 buyers lost -0.035, and
      dev improved too (+0.0129 vs +0.0109 SOL). The third buyer is the
      cheapest real-demand confirmation we have; two-buyer coins were the
      marginal losers. */
  minBuyers: number;
  /** Oldest age (slots since CreateEvent) at which a first buy may still be decided. */
  maxAge: number;
  /** Price now over create price, minus 1: at least this (allows a small dip). */
  minUp: number;
  /** Price now over create price, minus 1: at most this (never chase a runaway). */
  maxUp: number;
  /** SOL to put into one position (capped by 1% of real reserves and by free cash). */
  stakeSol: number;
  /** Smallest buy worth paying the tx fee for. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Take profit: sell value over cost, minus 1. */
  takeProfit: number;
  /** Stop loss: sell value under cost, as a share. */
  stopLoss: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Most coins entered over the whole run. */
  maxCoins: number;
  /** Most orders sent over the whole run (buys + sells). */
  maxOrders: number;
}

export const DEFAULT_PARAMS: Params = {
  minRqSol: 2,
  minDevBuySol: 0.1,
  maxDevBuySol: 1,
  minBuyers: 3,
  maxAge: 60,
  minUp: -0.05,
  maxUp: 1,
  stakeSol: 0.05,
  minBuySol: 0.02,
  buySlipBps: 1500,
  takeProfit: 0.25,
  stopLoss: 0.15,
  maxHold: 200,
  maxCoins: 30,
  maxOrders: 150,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Mint {
  created: number;
  creator: Pubkey;
  /** Create-time price (virtual quote / virtual token), as a plain number. */
  price0: number;
  devBuy: number;
  devSold: boolean;
  /** Distinct non-creator buyers, counted with a small set (dropped with the record). */
  buyers: Set<Pubkey>;
  /** True once this mint has been entered (one buy per coin, ever). */
  entered: boolean;
  /** True once this mint is disqualified for good (creator sold, aged out, completed). */
  done: boolean;
}

interface Held {
  opened: number;
  /** SOL sent in the buy, fees included (cost basis for TP/SL). */
  costSol: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const mints = new Map<Pubkey, Mint>();
  const held = new Map<Pubkey, Held>();
  let coinsEntered = 0;
  let ordersSent = 0;

  const mintOf = (mint: Pubkey, slot: number, creator: Pubkey, price0: number): Mint => {
    let m = mints.get(mint);
    if (m === undefined) {
      m = { created: slot, creator, price0, devBuy: 0, devSold: false, buyers: new Set(), entered: false, done: false };
      mints.set(mint, m);
    }
    return m;
  };

  /** Sell value of `tokens` against the curve's current reserves, curve fee deducted, in SOL. */
  const sellValueSol = (tokens: bigint, vq: bigint, vt: bigint): number => {
    if (tokens <= 0n || vt <= 0n) return 0;
    const t = Number(tokens);
    const q = (t * Number(vq)) / (Number(vt) + t);
    return (q / LAMPORTS) * (1 - CURVE_FEE);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;
      const traded = new Set<Pubkey>();

      // Fold this batch's events into the running per-mint numbers. O(events in this batch).
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          mintOf(e.mint, e.slot, e.creator, Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves));
          traded.add(e.mint);
        } else if (e.event === 'TradeEvent') {
          const m = mints.get(e.mint);
          if (m === undefined) continue;
          traded.add(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          if (e.is_buy) {
            if (e.user === m.creator) m.devBuy += sol;
            else m.buyers.add(e.user);
          } else if (e.user === m.creator) {
            m.devSold = true;
          }
        } else {
          const m = mints.get(e.mint);
          if (m !== undefined) m.done = true;
        }
      }

      // Exits first: at most five open positions, each a few arithmetic ops.
      const pendingSell = new Set<Pubkey>();
      const pendingMint = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingMint.add(po.order.mint);
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingMint.has(mint)) {
            held.delete(mint);
            const m = mints.get(mint);
            if (m !== undefined) m.done = true;
          }
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingSell.has(mint)) continue;
        const value = sellValueSol(BigInt(pos.token_amount), curve.virtual_quote_reserves, curve.virtual_token_reserves) - txSol;
        const m = mints.get(mint);
        let exit = false;
        if (value >= h.costSol * (1 + p.takeProfit)) exit = true;
        else if (value <= h.costSol * (1 - p.stopLoss)) exit = true;
        else if (now - h.opened > p.maxHold) exit = true;
        else if (m !== undefined && m.devSold) exit = true;
        if (!exit) continue;
        if (orders.length >= cap || ordersSent >= p.maxOrders) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        ordersSent++;
      }

      // Entries: only mints that traded in this batch, only while caps allow.
      if (coinsEntered < p.maxCoins && ordersSent < p.maxOrders) {
        const free = Number(state.freeCashLamports()) / LAMPORTS;
        const slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
        if (slotsLeft > 0 && free > p.minBuySol + txSol) {
          let spent = 0;
          for (const mint of traded) {
            if (orders.length >= cap || ordersSent >= p.maxOrders || coinsEntered >= p.maxCoins) break;
            const m = mints.get(mint);
            if (m === undefined || m.done || m.entered || m.devSold) continue;
            if (held.has(mint)) continue;
            if (now - m.created > p.maxAge) {
              m.done = true;
              continue;
            }
            if (m.devBuy < p.minDevBuySol || m.devBuy > p.maxDevBuySol) continue;
            if (m.buyers.size < p.minBuyers) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
            if (rqSol < p.minRqSol) continue;
            const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
            const up = price / m.price0 - 1;
            if (up < p.minUp || up > p.maxUp) continue;
            // Size: stake, capped by 1% of real reserves and by free cash; skip if fee-inefficient.
            const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
            let amount = Math.min(p.stakeSol, capSol, free - spent - txSol);
            if (amount < p.minBuySol) continue;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            ordersSent++;
            spent += amount + txSol;
            coinsEntered++;
            m.entered = true;
            held.set(mint, { opened: now, costSol: amount + txSol });
          }
        }
      }

      // Age-out: drop records for mints too old to ever enter, keeping the map small. Only
      // mints that traded this batch are candidates for the check, so this stays O(traded).
      for (const mint of traded) {
        const m = mints.get(mint);
        if (m === undefined) continue;
        if (!held.has(mint) && now - m.created > p.maxAge + p.maxHold) mints.delete(mint);
      }

      return orders;
    },
  };
}
