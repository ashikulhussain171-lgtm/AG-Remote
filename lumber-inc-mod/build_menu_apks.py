#!/usr/bin/env python3
"""Build the menu variant of Lumber Inc 1.13.3: original libil2cpp.so (patches are applied at runtime
by the menu), classes13.dex with the ModMenu.start hook in UnityPlayerActivity.onCreate, and the menu
code as an extra classes15.dex. Output APKs are unsigned; zipalign + apksigner both with one key."""
import sys, zipfile
from rebuild_apks import repack

if __name__ == '__main__':
    apks, hooked_classes13, menu_dex, outdir = sys.argv[1:5]
    with zipfile.ZipFile(apks) as z:
        base = z.read('base.apk')
        with zipfile.ZipFile(__import__('io').BytesIO(base)) as b:
            names = b.namelist()
            assert 'classes13.dex' in names and 'classes14.dex' in names and 'classes15.dex' not in names, 'unexpected dex layout'
        repack(base, f'{outdir}/base.unsigned.apk',
               {'classes13.dex': open(hooked_classes13, 'rb').read()},
               extra={'classes15.dex': open(menu_dex, 'rb').read()})
        repack(z.read('split_config.arm64_v8a.apk'), f'{outdir}/split_config.arm64_v8a.unsigned.apk')
    print('ok')
