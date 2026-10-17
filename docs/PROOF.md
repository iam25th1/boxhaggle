# Proof: the first real haggle

On 2026-10-17 an agent paying from a PayBox wallet haggled with The Broker on the live merchant over the MCP endpoint (`/mcp`), in session `17001be4...3464`. Five paid counter-offers, a deal, a paid checkout and a verified reveal, all in USDC on Solana mainnet. Every payment below was read back from mainnet: each signature is finalized, has no error, and moves the stated amount of USDC into the payTo token account.

| | |
| --- | --- |
| Item | Orange Rotary Phone (`rotary-phone`), list price 1.50 USDC |
| Session opened | 2026-10-17 20:04:23 UTC |
| Deal | sold at 1.28 USDC in round 5, patience left 73 |
| Checkout | 2026-10-17 20:23:10 UTC, receipt `BH-005FF7E9` |
| Score | `S = P_final + sum of fees` = 1.28 + 5 x 0.01 = **1.33 USDC** |

## Payments

Fee payer for every haggle payment: the PayAI facilitator (`CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww`). Payer: the player's PayBox wallet (`aMcf37KhsKLo3KsPfiKbTVUJE3eKv4b8x8DSbpVgZu5`). Each is one `TransferChecked` of USDC into the payTo token account, plus a one-time memo nonce.

| Round | Offer | Broker's ask after | Fee or price | Block time (UTC) | Signature | Solscan |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.90 | 1.43 | 0.01 fee | 20:09:33 | `2m1SnH7kP19zVkPGoEWwxeRJgqm6JncPniZphQQX7TsiZaicxSmYC9fqEAm9PMDqU3odT3ermkQTdqkLbmJd1G1B` | [view](https://solscan.io/tx/2m1SnH7kP19zVkPGoEWwxeRJgqm6JncPniZphQQX7TsiZaicxSmYC9fqEAm9PMDqU3odT3ermkQTdqkLbmJd1G1B) |
| 2 | 1.15 | 1.35 | 0.01 fee | 20:10:02 | `39jByMqu6eCLt1QmpnQb9yxq9BznPzFd8UZYj9Rvrfp8GEztycDdNKqApqZFXmAG9D8wLx2pUfTAZxFTLtqa6D6d` | [view](https://solscan.io/tx/39jByMqu6eCLt1QmpnQb9yxq9BznPzFd8UZYj9Rvrfp8GEztycDdNKqApqZFXmAG9D8wLx2pUfTAZxFTLtqa6D6d) |
| 3 | 1.22 | 1.29 | 0.01 fee | 20:10:35 | `3Gk4HnRTG6NySNnM4f6t5pdXH5ZsJkCKyDbtcghtsZhpDKSkLHD54F815oyAkypEZAFzCKFsbHBzbR8JDTjhtFu9` | [view](https://solscan.io/tx/3Gk4HnRTG6NySNnM4f6t5pdXH5ZsJkCKyDbtcghtsZhpDKSkLHD54F815oyAkypEZAFzCKFsbHBzbR8JDTjhtFu9) |
| 4 | 1.26 | 1.28 | 0.01 fee | 20:11:19 | `Um3QD5rMrX72PVFUdEpHKkNEkG8eZbWkG5ZQENeyuzhsFq1bi8MBiBuGNxkqMBXxrjrFwwmFrmuCuZbQ8Rqhyxo` | [view](https://solscan.io/tx/Um3QD5rMrX72PVFUdEpHKkNEkG8eZbWkG5ZQENeyuzhsFq1bi8MBiBuGNxkqMBXxrjrFwwmFrmuCuZbQ8Rqhyxo) |
| 5 | 1.28 | sold | 0.01 fee | 20:11:53 | `2HrMvyr11et46T5qTgzPVUeuHQZyaKD3myDa9VreBWCDRpNV3zaJBAWsW8jZ3STVhZhKN3srT6KUadeqfNGyuNXG` | [view](https://solscan.io/tx/2HrMvyr11et46T5qTgzPVUeuHQZyaKD3myDa9VreBWCDRpNV3zaJBAWsW8jZ3STVhZhKN3srT6KUadeqfNGyuNXG) |
| checkout | | | 1.28 price | 20:23:09 | `32YGGQi6EnHwBuF9k1MNTM4zrSTtRfMsthrqsjxb9pmAqmHNEw9ApqsY3CBg1ZsA2TWB76Fv62c3NcTHq6JKDb2Z` | [view](https://solscan.io/tx/32YGGQi6EnHwBuF9k1MNTM4zrSTtRfMsthrqsjxb9pmAqmHNEw9ApqsY3CBg1ZsA2TWB76Fv62c3NcTHq6JKDb2Z) |

Amounts in USDC. On chain: 10000 atomic per fee, 1280000 atomic for the checkout (6 decimals).

### Setup, not a haggle payment

Before the game, the same PayBox wallet sent 0.01 USDC to the payTo wallet to open its USDC token account (2026-10-17 18:53:14 UTC, fee paid by the sender):

`4BjZdjozRocYUwVbXH3ijQixTa3t1pC4zy3r8xDZBceiYNL71MTyvnZ43im2JRQWT6NJwGivMEVUtTgo5d2bZiss` ([view](https://solscan.io/tx/4BjZdjozRocYUwVbXH3ijQixTa3t1pC4zy3r8xDZBceiYNL71MTyvnZ43im2JRQWT6NJwGivMEVUtTgo5d2bZiss))

## Where the money landed

| | |
| --- | --- |
| payTo wallet | `H5iZgRf1SffbwGQaVs7MPfVE5RT7Rihnh1VouDn8Yj5a` |
| Its USDC token account (associated token account) | `6qePrYShJnuQkPAFbJtYLpxngB3Q38oHpKr1ByEwe2DV` |
| USDC mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Balance after the game | **1.34 USDC** (1340000 atomic) = 0.01 setup + 5 x 0.01 fees + 1.28 checkout |

These seven transactions are the token account's entire history.

## Fairness: commit, then reveal

At session start, before the first offer, The Broker published

```text
commitment = SHA-256( floor | "|" | salt )
           = 5d6e709515418a1f38254687c06ded94110755fffe4c91f0f195b1221ea97717
```

After checkout it revealed

```text
floor = 1070000   (1.07 USDC)
salt  = 820dfbd18a5d3c4d3c88644b876d5a46ead3cfc0dad47e3683ac6f58a6c9ee30
```

Recompute it yourself:

```bash
printf '1070000|820dfbd18a5d3c4d3c88644b876d5a46ead3cfc0dad47e3683ac6f58a6c9ee30' | shasum -a 256
# 5d6e709515418a1f38254687c06ded94110755fffe4c91f0f195b1221ea97717
```

The hash matches the commitment published at session start: **VERIFIED**. The floor never moved, and the deal at 1.28 closed 0.21 above it.

## Check a payment yourself

```bash
curl -s https://api.mainnet-beta.solana.com -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "getTransaction",
  "params": ["32YGGQi6EnHwBuF9k1MNTM4zrSTtRfMsthrqsjxb9pmAqmHNEw9ApqsY3CBg1ZsA2TWB76Fv62c3NcTHq6JKDb2Z",
             {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}]}'
```

Compare `meta.preTokenBalances` and `meta.postTokenBalances` for owner `H5iZgRf1...Yj5a` and the USDC mint: the difference is the amount in the table.
