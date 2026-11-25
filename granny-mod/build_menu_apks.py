#!/usr/bin/env python3
"""Build Granny: Chapter Two 1.2.8 with the Panther Mods menu: original libil2cpp.so, classes5.dex with
ModMenu.start hooked into UnityPlayerActivity.onCreate, the menu as classes7.dex, and libpanther.so in
the arm64 split. Output APKs are unsigned; zipalign + apksigner both with one key."""
import io, re, sys, zipfile
SIG = re.compile(r'^META-INF/([^/]+\.(SF|RSA|DSA|EC)|MANIFEST\.MF)$')

def repack(src_bytes, dst, replace=None, extra=None):
    with zipfile.ZipFile(io.BytesIO(src_bytes)) as zin, zipfile.ZipFile(dst, 'w') as zout:
        for info in zin.infolist():
            if SIG.match(info.filename):
                continue
            payload = replace[info.filename] if replace and info.filename in replace else zin.read(info.filename)
            ni = zipfile.ZipInfo(info.filename, info.date_time)
            ni.compress_type = info.compress_type
            ni.external_attr = info.external_attr
            zout.writestr(ni, payload, compress_type=info.compress_type,
                          compresslevel=9 if info.compress_type == zipfile.ZIP_DEFLATED else None)
        for name, payload in (extra or {}).items():
            zout.writestr(zipfile.ZipInfo(name, (1981, 1, 1, 1, 1, 2)), payload, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

if __name__ == '__main__':
    apks, hooked_classes5, menu_dex, native_so, outdir = sys.argv[1:6]
    with zipfile.ZipFile(apks) as z:
        assert set(z.namelist()) == {'base.apk', 'split_config.arm64_v8a.apk'}, z.namelist()
        base = z.read('base.apk')
        names = zipfile.ZipFile(io.BytesIO(base)).namelist()
        assert 'classes6.dex' in names and 'classes7.dex' not in names, 'unexpected dex layout'
        repack(base, f'{outdir}/base.unsigned.apk', {'classes5.dex': open(hooked_classes5, 'rb').read()},
               extra={'classes7.dex': open(menu_dex, 'rb').read()})
        repack(z.read('split_config.arm64_v8a.apk'), f'{outdir}/split_config.arm64_v8a.unsigned.apk',
               extra={'lib/arm64-v8a/libpanther.so': open(native_so, 'rb').read()})
    print('ok')
