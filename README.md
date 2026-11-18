# gta6-twitch-forecast

Forecast GTA VI's launch-day Twitch viewers hour by hour — an entry for the
[make.fun bounty](https://make.fun/bounty/gta6-twitch-ccu-forecast-01).

![bounty](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)
![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/abduljunior425/gta6-twitch-forecast/rank.svg)
![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/abduljunior425/gta6-twitch-forecast/reward.svg)

## What it does

`main.ts` reads every `*.in` case in `$MAKEFUN_INPUT_DIR` (else `/input`) and
writes one forecast per case to `$MAKEFUN_OUTPUT_DIR` (else `/output`): for
each of hours 2–24 of the release day, five quantiles (5% / 25% / 50% / 75% /
95%) of the Twitch category's concurrent viewers. Run it with:

```sh
node main.ts
```

Node 22+, standard library only, no network, no randomness — two runs on the
same case are byte-identical.

## Model

A comparables-based forecaster, built from the case's own data at run time:

1. **Family.** Every comparable launch's release-day hourly curve is
   normalised by its hour-1 print. Only the "still ramping" family is kept:
   launches whose hour-1 print is 8%–75% of their release-day peak. Those
   are the rolling midnight-local launches — the US unlocks hours later —
   the same shape family GTA VI belongs to. Launches already at peak in
   hour 1 (simultaneous global unlock) and launches that unlock later in the
   day (tiny hour 1) are left out, and so is the GTA VI pre-release category
   entry.
2. **Size regression.** For each hour, the log ratio
   `ln(viewers_h / viewers_1)` is regressed on `ln(hour-1 print)` across
   the family (ordinary least squares). Big launches ramp less than small
   ones (correlation ≈ −0.7 in the kit's practice comparables), so the
   hour-1 print itself predicts how much the curve still has to climb. The
   query's `ln(hour-1)` is clamped to the family's observed range, so a
   record-size hour 1 never extrapolates the fit past the launches it was
   fit on.
3. **Spread.** Quantiles are log-normal around the regression prediction,
   with the residual standard deviation of that hour's regression, shrunk by
   0.85 and floored at 0.12 in log terms.

## Practice result

Scored locally against the four practice launches' historical hourly counts
(fetched from the source the kit's `input/NOTICE.txt` documents):

| model | mean pinball loss | typical miss | 90% coverage |
| --- | --- | --- | --- |
| this entry | **0.202** | 39.4% | 0.86 |
| house baseline (starter) | 0.387 | 90.2% | 0.78 |

Per-case loss: Wolverine 0.300, Red Dead Redemption 2 0.190, God of War
Ragnarök 0.140, Spider-Man 2 0.178. All four cases valid, and two runs
produce byte-identical outputs.

## Files

- `main.ts` — the entrypoint (Node 22, stdlib only)
- `LICENSE` — MIT
