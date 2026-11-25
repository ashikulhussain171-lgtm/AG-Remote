# Lumber Inc 1.13.3 currency mod

Target: `com.lumber.inc` 1.13.3, `split_config.arm64_v8a.apk` → `lib/arm64-v8a/libil2cpp.so`
(sha256 `42bea638…c997`, Unity IL2CPP metadata v31). Other builds are refused by the patcher.

## What is patched (measured on this build)

| Method | RVA | File offset |
|---|---|---|
| `Lumber.CurrencyResourceSelfAmount.ValidateNumber(double, string)` | `0x31552C8` | `0x31512C8` |
| `Lumber.CurrencyResourceFromWorld.ValidateNumber(double, string)` | `0x31540E8` | `0x31500E8` |

Both helpers are the only place currency balances are written through: `ValidateCurrentAmount`
(on load, label `"amount"`), `DoAddAmount` (`"value"`, `"newAmount"`) and `DoRemoveAmount`
(`"value"`, `"prevAmount"`, `"newAmount"`). The replacement keeps the original non-finite → 0
rule, passes inputs (label `"value"`, literal slot pointer at `0x63221F0`) through unchanged,
and clamps every currency balance to ≥ `FLOOR` = 1e236 (224 nines × 10^12, as a double). That
covers all `CurrencyType_2025` values (Gold 10, Diamond 20, BizPoint 30, Reputation 40,
VillageCoin 50, Gear 60) and all legacy `Currency` values (Gold 1, Diamond 2, BizPoint 16,
Reputation 32, VillageCoin 64, event coins 128+). `TARGETS` can still restrict it to a type list.

The "NOT ENOUGH DIAMOND" popup (`NotEnoughDiamondPopup.OpenPopup`) is reached from spend-failed
handlers; the failing condition is `RuntimeResourceSpendable_Basic.RefreshIsSpendable`
(`0x3156294`): `IsSpendable = resource.Amount >= spendAmount` (`fcmp d8, d9; cset ge` at `0x3156480`).
`World.get_Diamond` etc. read the same resource amount, so one patch covers both paths.

## Rebuild

```
python3 patch_libil2cpp.py <orig libil2cpp.so> libil2cpp.so          # needs keystone-engine, capstone
python3 rebuild_apks.py Lumber.Inc_1.13.3.apks libil2cpp.so <outdir>  # writes *.unsigned.apk
zipalign -f -p 4 X.unsigned.apk X.aligned.apk && apksigner sign --ks <ks> --out X.apk X.aligned.apk  # both APKs, same key
```

`release/` holds the signed `.apks` as a two-volume 7z (GitHub 100 MB limit); the
`lumber-mod-release` workflow extracts it and publishes the GitHub release.
