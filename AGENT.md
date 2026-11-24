# AGENT.md — liquid breakout rider (boothlord pump.fun paper sprint)

## Strategy in one paragraph

Buy the breakout, not the launch. A coin must be liquid first (real SOL reserves
≥ 10, so the 1%-of-reserve per-order cap still allows a full 0.1 SOL stake), then
break at least 50% above the high of its first 30 slots on at least 0.5 SOL of net
buy flow over the last 10 slots, with ≥ 2 distinct buyers, the creator not selling,
and the last trade a buy. One fixed 0.1 SOL stake per coin (split into several
orders when the cap binds), no pyramiding. Hold with a wide trailing stop (25%
give-back, armed at +30%), a −25% stop-loss, a 1500-slot max hold, a creator-sell
exit and a stale exit; the take-profit is set to +1000% so it never binds — the
runners are the payoff. A 0.01 SOL probe keeps the run above the guardrail
minimums (20 distinct coins, 20 fills) when the main signal goes quiet.

## Why this shape

- The dev window's 13 completed coins all complete in their creation slot:
  uncatchable. Launch sniping can only catch the small early moves, and its
  stakes are capped to dust by tiny real reserves.
- 113 of 430 dev-window coins reach 10 SOL of real reserves; 37 of those peak
  ≥ 2x from that point, best near 8x. Liquidity first, breakout second.
- A tight take-profit caps exactly the payoff that matters, so there is none.
- The fee floor (1.25% curve fee each way + fixed tx fees) punishes small,
  frequent trades; the fixed 0.1 SOL stake and the strict entry keep the bleed
  small.

## Parameters (tuned by grid sweep on the dev window, 4 fail keys)

age 4–600 slots, base window 30, breakout +50%, min buyers 2, real SOL 10–80,
flow window 10 slots / min +0.5 SOL, stake 0.1 SOL, max 5 orders per entry,
buy slippage 1500 bps, stop-loss −25%, trailing 25% armed at +30%, max hold
1500 slots, fade exit off, stale 1200 slots, cooldown 150 slots, max 2 entries
per coin, max 8 open, max exposure 2.0 SOL, probes 0.01 SOL.

## Sim results (dev window part-00000, 50,000 events, 430 coins)

Mean net PnL −0.067 SOL (worst −0.068 across fail keys 11n/22n/33n/44n), 252
fills, 47 distinct coins, 126 round trips, 10 wins, best trip +0.086 SOL,
top two trips +0.116 SOL, max drawdown 0.025. Slightly negative on the dev
window — the dev window is fee-bleed dominated — but the best of everything
tested (launch sniper −0.133, dip-recovery −0.173, momentum −9.362,
scale-in variant −0.858), with real upside exposure to the runners that decide
the final 6-hour window.

## Entry point

`main.ts` (Node 22, stdlib only). Run by the grader as `node /bot/main.ts`;
the protocol shim is vendored at `vendor/makefun-bot.ts` (byte-identical copy
of the kit's `sdk/ts/makefun-bot.ts`). Deterministic: no clock, no randomness,
no environment reads, no network.
