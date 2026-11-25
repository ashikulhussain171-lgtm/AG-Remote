# Granny: Chapter Two 1.2.8 — Panther Mods menu

Target: `com.dvloper.grannychaptertwo` 1.2.8, `split_config.arm64_v8a.apk` → `lib/arm64-v8a/libil2cpp.so`
(sha256 `d9f316b7…f7ec`, Unity IL2CPP, metadata v31). Same runtime menu as `lumber-inc-mod/`:
original library on disk, code patched in memory by `libpanther.so` only while a switch is on.

| Switch | Site (RVA) | Change |
|---|---|---|
| God Mode | `0x130F784` | `EnemyAIGranny.FixedUpdate`: `b.pl` after `fcmp distance(0x170), attackDistance(0x174)` → `b` (catch block at `0x1310588` never entered) |
| | `0x130710C` | `EnemyAIGrandpa.FixedUpdate`: same check on `0x210`/`0x214` → `b` |
| Invisible | `0x1381C94` | `EnemyEye.Update` → `ret` (it sets `EnemyAIGranny.seePlayer` at `+0x160`) |
| | `0x13821DC` | `EnemyEyeGranpa.Update` → `ret` |
| | `0x1384B04` | `grannySeePlayerTrigger.OnTriggerStay` → `ret` |
| Silent | `0x1383C58` | `GrannyHear.OnTriggerEnter` → `ret` |
| Freeze | `0x130D6BC`, `0x1305894` | `EnemyAIGranny/EnemyAIGrandpa.FixedUpdate` → `ret` |
| No Ads | `0x2023F48` | `MaxSdkAndroid.ShowInterstitial` → `ret` |

Hook: `UnityPlayerActivity.onCreate` in `classes5.dex` calls `ModMenu.start(this)` after `setContentView`;
menu code ships as `classes7.dex`; `libpanther.so` (from `menu/jni/panther.c`) in the arm64 split.

Not done yet (need a runtime il2cpp call bridge in libpanther, not byte patches): ESP, teleport, noclip,
super jump, speed, give items / open doors, weapons, infinite days, fun effects.

```
python3 gen_patches.py <orig libil2cpp.so> menu/src/com/panther/mod/Patches.java
javac --release 8 -cp android-23/android.jar -d classes menu/src/com/panther/mod/*.java
dalvik-exchange --dex --min-sdk-version=24 --output=panther.dex classes
# classes5.dex: apktool d -> add invoke-static ModMenu.start after setContentView -> apktool b
python3 build_menu_apks.py Granny.Chapter.Two_1.2.8.apks classes5_hooked.dex panther.dex libpanther.so <outdir>
```
