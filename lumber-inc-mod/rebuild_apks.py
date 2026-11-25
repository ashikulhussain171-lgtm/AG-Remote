#!/usr/bin/env python3
"""Repack Lumber Inc .apks with a patched libil2cpp.so (unsigned output; sign with apksigner)."""
import re, sys, zipfile, io
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
            zout.writestr(ni, payload, compress_type=info.compress_type, compresslevel=9 if info.compress_type == zipfile.ZIP_DEFLATED else None)
        for name, payload in (extra or {}).items():
            ni = zipfile.ZipInfo(name, (1981, 1, 1, 1, 1, 2))
            zout.writestr(ni, payload, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

if __name__ == '__main__':
    apks, patched_so, outdir = sys.argv[1:4]
    so = open(patched_so, 'rb').read()
    with zipfile.ZipFile(apks) as z:
        names = z.namelist()
        assert set(names) == {'base.apk', 'split_config.arm64_v8a.apk'}, names
        repack(z.read('base.apk'), f'{outdir}/base.unsigned.apk')
        repack(z.read('split_config.arm64_v8a.apk'), f'{outdir}/split_config.arm64_v8a.unsigned.apk',
               {'lib/arm64-v8a/libil2cpp.so': so})
    print('ok')
