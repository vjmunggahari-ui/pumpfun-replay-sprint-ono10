# LeanSnipe v2 — Pump.fun Replay Sprint

A lean, patient launch sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
Paper trading only — 10 SOL of paper money, nothing real.

## Strategy

Most pump.fun coins pump once, fast, then bleed back to their create price. This bot waits
instead of chasing: it buys only a coin that has already attracted at least 2 SOL of real
reserves (so the 1%-of-reserve order cap still lets a buy of 0.02 SOL or more through — below
that size the fixed 105k-lamport tx fee eats the trade), whose creator bought a real but
modest stake of their own coin (0.1–1 SOL: skin in the game, not a bundle), that at least
two other wallets have bought, and whose price has not already run away more than 2x from
create. One buy per coin, no adds: a single 0.05 SOL stake (or the 1% cap, whichever is
smaller). The whole position leaves on the first of +25% take-profit, −15% stop-loss, a
creator sell, or 200 slots held.

## Why v2 is lean

v1 timed out twice on the server's wall budget. This rebuild is built to finish grading:
per batch it touches only the mints that traded in that batch and the (at most five) open
positions — no trade tapes, no per-batch scans of every curve, no sorting. Total entries are
capped at 30 coins and 150 orders for the run, so the fill count stays small. Fully
deterministic: no clock, no randomness, no network.

[![bounty](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/vjmunggahari-ui/pumpfun-replay-sprint-ono10/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/vjmunggahari-ui/pumpfun-replay-sprint-ono10/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
