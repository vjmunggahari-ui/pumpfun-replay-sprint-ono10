// HotLaunch — a filtered launch-sniper for the pump.fun replay sprint.
//
// Design (measured on the 24h dev window, 1,222 universe coins; NOT copied from
// any baseline):
//   * Most coins do nothing (median max gain from launch 1.33x; only 23% ever
//     2x). Dip-buying loses (dips keep falling: median -30% after 600 slots)
//     and momentum-chasing is a coin flip (43% up after 100 slots), so neither
//     reversion nor momentum entries carry an edge after the ~2.5% round-trip
//     fee drag. The edge is in the launch tape itself, and it decays within
//     slots: the earlier the entry, the better the result.
//   * Entry: a coin qualifies the moment its launch tape shows >=10 distinct
//     non-creator buyers AND >=2 SOL of buy volume, with the creator not
//     selling, at any point within 2 slots of its CreateEvent. Coins that
//     qualify in the create slot itself are bought at once; the rest are
//     bought at the first later slot where the tape passes. One buy per coin,
//     sized to the smaller of a 0.5 SOL stake and the protocol's 1%-of-real-
//     reserve cap, never below the 0.01 SOL round-trip floor, at most 5 open
//     positions. (A looser >=8-buyer filter dilutes the edge to ~zero; a
//     second tranche into a rising position also loses; both were measured
//     and rejected.)
//   * Exit: +25% take-profit, -10% stop-loss, and a trailing stop that arms
//     once the price is +5% above entry and sells on a 5% pullback from the
//     peak, plus a 200-slot max hold. The trailing stop is what makes the
//     design work: fixed take-profits alone lose money, because exits slip
//     two slots and the spike fades fast. The trailing stop banks the spike
//     instead of waiting for a take-profit that slips away.
//   * Fully deterministic: every decision is a function of the harness state
//     only. No randomness, no wall clock, no network.

import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot';

export interface HotLaunchParams {
  /** Tape window after a coin's CreateEvent, in slots (also the decision window). */
  tapeSlots: number;
  /** Latest slot (create slot + this) at which a buy may still be decided. */
  decideBySlots: number;
  /** Minimum distinct non-creator buyers inside the tape window. */
  minBuyers: number;
  /** Minimum total buy volume inside the tape window, in SOL. */
  minBuySol: number;
  /** Fixed stake per qualifying coin, in SOL (capped by the 1% rule). */
  stakeSol: number;
  /** Smallest buy that counts as a round trip, in SOL. */
  minRoundTripSol: number;
  /** Maximum open positions (protocol cap is 5). */
  maxPositions: number;
  /** Take-profit, as a fraction above the entry price. */
  takeProfit: number;
  /** Stop-loss, as a fraction below the entry price. */
  stopLoss: number;
  /** Forced exit, in slots after the entry fill. */
  maxHoldSlots: number;
  /** Trailing-stop arm, as a fraction above entry (0 disables trailing). */
  trailArm: number;
  /** Trailing-stop drop, as a fraction below the peak price. */
  trailDrop: number;
  /** Slippage tolerance on buys, in bps (10_000 = accept the fill as quoted). */
  buySlippageBps: number;
}

export const DEFAULT_HOTLAUNCH: HotLaunchParams = {
  tapeSlots: 2,
  decideBySlots: 2,
  minBuyers: 10,
  minBuySol: 2,
  stakeSol: 0.5,
  minRoundTripSol: 0.01,
  maxPositions: 5,
  takeProfit: 0.25,
  stopLoss: 0.1,
  maxHoldSlots: 200,
  trailArm: 0.05,
  trailDrop: 0.05,
  buySlippageBps: 10_000,
};

interface Tape {
  createSlot: number;
  creator: string;
  buyers: Set<string>;
  buyLamports: bigint;
  devSold: boolean;
  decided: boolean;
  bought: boolean;
}

interface Entry {
  entryPrice: number;
  entrySlot: number;
  peakPrice: number;
}

export function createHotLaunchBot(partial?: Partial<HotLaunchParams>): Bot {
  const p: HotLaunchParams = { ...DEFAULT_HOTLAUNCH, ...partial };
  const tapes = new Map<string, Tape>();
  const entries = new Map<string, Entry>();
  const pendingBuy = new Set<string>();

  const priceOf = (state: BotState, mint: string): number => {
    const c = state.curves.get(mint);
    if (c === undefined || c.virtual_token_reserves === 0n) return 0;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];

      // 1. Fold this batch's fills into entry records.
      for (const f of batch.fills) {
        if (f.side === 'buy' && f.status === 'filled') {
          const tok = BigInt(f.token_amount);
          const quote = BigInt(f.quote_lamports);
          if (tok > 0n && quote > 0n && !entries.has(f.mint)) {
            entries.set(f.mint, {
              entryPrice: Number(quote) / Number(tok),
              entrySlot: f.slot,
              peakPrice: Number(quote) / Number(tok),
            });
          }
          pendingBuy.delete(f.mint);
        } else if (f.side === 'buy' && f.status !== 'filled') {
          pendingBuy.delete(f.mint);
        }
      }

      // 2. Update launch tapes from this batch's events.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!tapes.has(e.mint)) {
            tapes.set(e.mint, {
              createSlot: e.slot,
              creator: e.creator,
              buyers: new Set<string>(),
              buyLamports: 0n,
              devSold: false,
              decided: false,
              bought: false,
            });
          }
        } else if (e.event === 'TradeEvent') {
          const t = tapes.get(e.mint);
          if (t === undefined) continue;
          if (e.slot - t.createSlot > p.tapeSlots) continue;
          if (e.is_buy) {
            t.buyLamports += BigInt(e.sol_amount);
            if (e.user !== t.creator) t.buyers.add(e.user);
          } else if (e.user === t.creator) {
            t.devSold = true;
          }
        }
      }

      // 3. Exits first: TP / SL / trailing / max-hold on every held position.
      const pendingSell = new Set<string>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }
      for (const [mint, pos] of state.positions) {
        if (pendingSell.has(mint)) continue;
        const entry = entries.get(mint);
        if (entry === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const px = priceOf(state, mint);
        if (px <= 0) continue;
        if (px > entry.peakPrice) entry.peakPrice = px;
        const gain = px / entry.entryPrice - 1;
        let exit = false;
        if (gain >= p.takeProfit) exit = true;
        else if (gain <= -p.stopLoss) exit = true;
        else if (p.trailArm > 0 && entry.peakPrice >= entry.entryPrice * (1 + p.trailArm) && px <= entry.peakPrice * (1 - p.trailDrop)) exit = true;
        else if (batch.slot - entry.entrySlot >= p.maxHoldSlots) exit = true;
        if (exit) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        }
      }

      // 4. Drop entry records whose position is gone (sold or harness-closed).
      for (const mint of [...entries.keys()]) {
        if (!state.positions.has(mint) && !pendingBuy.has(mint)) entries.delete(mint);
      }

      // Cash available for any buy decided this batch.
      let freeCash = state.freeCashLamports();
      const txFee = state.txFeeLamports();
      const floor = BigInt(Math.round(p.minRoundTripSol * 1e9));

      // 5. New entries: a tape is decided at the FIRST batch where its tape
      // passes (or expires once the decision window closes). Buying at the
      // earliest passing slot matters: each slot of delay costs heavily,
      // because the launch spike runs in the first few slots.
      if (state.committedPositionCount() < p.maxPositions) {
        for (const [mint, t] of tapes) {
          if (t.decided || t.bought) continue;
          if (batch.slot > t.createSlot + p.decideBySlots) {
            t.decided = true;
            continue;
          }
          if (t.devSold) continue;
          if (t.buyers.size < p.minBuyers) continue;
          if (t.buyLamports < BigInt(Math.round(p.minBuySol * 1e9))) continue;
          if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= p.maxPositions) break;
          const cap = state.maxBuyLamports(mint);
          if (cap <= 0n) continue;
          let stake = BigInt(Math.round(p.stakeSol * 1e9));
          if (stake > cap) stake = cap;
          if (stake < floor) continue;
          if (stake + txFee > freeCash) continue;
          freeCash -= stake + txFee;
          t.bought = true;
          pendingBuy.add(mint);
          orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: p.buySlippageBps });
        }
      }

      return orders;
    },
  };
}
