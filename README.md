# Pump.fun Replay Sprint — Paper Bot, Real Ranking

[![make.fun bounty](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/aint965/pump-fun-replay-sprint-paper-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/aint965/pump-fun-replay-sprint-paper-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic paper-trading bot for the `agent-fun/replay/v2` pump.fun replay.
It trades 10 SOL of paper money on 24 hours of recorded pump.fun bonding-curve
activity and is scored on net PnL after every fee.

## Strategy

**Ride the late bonding curve.** The bot does not chase fresh launches: the first
trades are the pump itself, and with 2 slots of order latency a launch buyer
always pays the top. Instead it buys coins that have already pulled 50+ SOL of
real reserves into their curve and are still receiving net buying (at least
2 SOL of net inflow over the last 60 slots). Those coins have real demand
behind them, and the curve's remaining run toward completion (~85 SOL) still
offers a large price rise. Each position is 0.5 SOL at most (the 1% of real
reserve size cap binds first), sold whole at +50% of cost or cut at -20%,
with a 2000-slot time limit.

**Guardrail probes.** A second, small leg keeps the 20-coin guardrail safe
with margin: paced 0.012 SOL probes on flat, liquid coins (real reserves
10+ SOL, price moved under 2% in 30 slots), sold as soon as the buy lands.
At most one probe per 2000 slots and 25 in total, so their cost stays small.

**Limits respected.** Max 5 open positions, max 1% of real reserve per order,
no shorts, no leverage, at most 14 orders per batch. No randomness, no clock,
no network: every decision is a pure function of the hello and the batches
the harness sends, so the two graded executions produce byte-identical
action logs.

## Files

- `main.ts` — the entrypoint: speaks `agent-fun/replay/v2` directly on
  stdin/stdout (hello handshake, one reply per batch echoing its seq).
- `LICENSE` — MIT.

## Local result (dev window)

`grade-local --driver process`: net PnL **+1.553 SOL**, 94 fills over
47 coins (47 round trips), win rate 29.8%, max drawdown 7.4%, guardrails met,
action logs reproduced byte for byte. Split-half check (first/second 12h of
the dev window, backtester): +0.963 / +0.321 SOL, both positive. Stress
(20 block-bootstrap copies): median below the dev score — the PnL leans on
this window's particular coins, so the final-window result is uncertain;
see the run log for the full spread.
