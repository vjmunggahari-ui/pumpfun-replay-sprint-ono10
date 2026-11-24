# HotLaunch — Pump.fun Replay Sprint

![bounty](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/vjmunggahari-ui/pumpfun-replay-sprint-ono10/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/vjmunggahari-ui/pumpfun-replay-sprint-ono10/reward.svg)

A filtered launch-sniper for the Pump.fun Replay Sprint (paper bot, real
ranking). It does not chase momentum and it does not buy dips — both lose
money after fees on the dev window. It buys only the hottest launches, at the
earliest slot the tape allows, and banks the spike with a trailing stop.

## Strategy

**Entry — buy the tape, early.** A coin qualifies the moment its launch tape
shows at least 10 distinct non-creator buyers and at least 2 SOL of buy
volume, with the creator not selling, at any point within 2 slots of its
CreateEvent. Coins that qualify in the create slot itself are bought at once;
the rest are bought at the first later slot where the tape passes. One buy
per coin, sized to the smaller of a 0.5 SOL stake and the protocol's
1%-of-real-reserve cap, never below the 0.01 SOL round-trip floor, at most 5
open positions.

**Exit — bank the spike.** +25% take-profit, −10% stop-loss, and a trailing
stop that arms once the price is +5% above entry and sells on a 5% pullback
from the peak, plus a 200-slot max hold. The trailing stop is what makes the
design work: fixed take-profits alone lose money, because exits slip two
slots and the spike fades fast.

**Why this edge exists (measured, dev window, 1,222 coins):** most coins do
nothing (median max gain from launch 1.33x; only 23% ever 2x). Dip-buying
loses — dips keep falling (median −30% after 600 slots). Momentum-chasing is
a coin flip (43% up after 100 slots). But coins with 10+ distinct buyers in
the first slots are the exception: from an entry a few slots after launch
their median max multiple is 1.29x (p90 2.69x). The edge decays within slots
— entering one slot earlier nearly doubles the result — so the bot decides at
the first passing slot, not at a fixed lag.

## Dev backtest (full 24h dev window, official replay engine, all 3 parts)

| | HotLaunch | momentum pilot | reversion pilot | sniper pilot | hold-cash |
|---|---|---|---|---|---|
| Net PnL after fees | **+0.783 SOL** | −9.387 SOL | −4.016 SOL | −0.489 SOL | 0.000 SOL |
| Distinct coins traded | 49 | 48 | 198 | 354 | 0 |
| Qualifying round trips (≥0.01 SOL) | 49 | 80 | 424 | 269 | 0 |
| Win rate | 59% (29/49) | 6% (5/80) | 26% (111/424) | 13% (45/354) | — |
| Max drawdown | 0.026 | 0.950 | 0.489 | 0.053 | 0.000 |
| Top-3-coin PnL share | 27.2% | 99.9% | 43.9% | 33.9% | — |
| Net PnL without top 3 coins | +0.46 SOL | −10.078 SOL | −5.004 SOL | −0.590 SOL | 0.000 SOL |

The HotLaunch column is the official `grade-local` result (`--driver process`,
two executions, L1 regrade reproduced byte for byte); the baseline columns are
the same full-window replay measured with the kit's own simulation engine.
Grade-local also reports: at 2x fees net PnL stays positive (+0.528 SOL);
90% bootstrap interval +0.231 to +1.341 SOL. Stress test (20 rebuilt copies
of the dev window): median +0.12 SOL, p10 −0.27, p90 +0.43, 7 of 20 copies
lost money — the edge is real but window-dependent, and the dev-window score
sits above all 20 copies, so the final window will likely score below the
dev figure.

Split-half check (same parameters, no re-tuning): first third of the window
+0.156 SOL (15 trips), last two thirds +0.633 SOL (33 trips) — positive in
both halves. Rejected orders: 0. Failed transactions: 0.

## Run

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout (the
vendored `vendor/makefun-bot.ts` shim owns the wire). It is fully
deterministic: every decision is a function of the harness state only — no
randomness, no wall clock, no network — so two runs produce byte-identical
action logs.

## Files

- `main.ts` — entrypoint: wires the strategy to the replay protocol.
- `strategy.ts` — HotLaunch: launch-tape filter, tiered early entry, trailing-stop exits.
- `vendor/makefun-bot.ts` — the competition's replay-protocol shim (vendored, unmodified).
- `LICENSE` — MIT.
