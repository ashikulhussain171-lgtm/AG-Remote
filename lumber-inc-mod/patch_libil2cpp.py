#!/usr/bin/env python3
"""Lumber Inc 1.13.3 (com.lumber.inc, arm64-v8a) currency floor patch for libil2cpp.so.

Rewrites the two currency ValidateNumber(double d, string label) helpers so that every
*balance* (labels "amount", "prevAmount", "newAmount")
of every currency type is clamped to at least FLOOR (1e236). Input amounts (label "value")
pass through unchanged.
Effect: balances load at >= FLOOR, every spend is re-clamped back to >= FLOOR, and the
affordability check (RuntimeResourceSpendable_Basic.RefreshIsSpendable: amount >= cost) passes.

All addresses were measured on this exact build (see EXPECTED_SHA256); the script refuses
any other input.
"""
import hashlib, struct, sys
from keystone import Ks, KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

EXPECTED_SHA256 = "42bea6384d6232a5b6932ab8bef75898900ce7ccbc24b3a8cfc202c2e639c997"
# Requested: 99...9 (224 nines) trillion = 1e236 as a double. Max double is ~1.8e308.
FLOOR = float("9" * 224 + "e12")

# Build: Lumber.Inc 1.13.3, split_config.arm64_v8a.apk -> lib/arm64-v8a/libil2cpp.so
# All values are RVAs (== runtime offset from module base). File offset = RVA - 0x4000
# for the R E segment (vaddr 0x269a484, file offset 0x2696484).
TEXT_VA, TEXT_OFF, TEXT_SZ = 0x269A484, 0x2696484, 0x383107C
# il2cpp string-literal slot pointer for "value" (resolved via R_AARCH64_RELATIVE -> literal 0x65B6788)
LIT_VALUE_PTR = 0x63221F0

TARGETS = [
    # (name, RVA, function size, field holding the currency enum, enum values to floor)
    # kinds=None: every currency type of that class (CurrencyType_2025: Gold 10, Diamond 20, BizPoint 30,
    # Reputation 40, VillageCoin 50, Gear 60; Currency: Gold 1, Diamond 2, BizPoint 16, Reputation 32,
    # VillageCoin 64, old event coins 128+).
    ("CurrencyResourceSelfAmount.ValidateNumber", 0x31552C8, 0x140, 0x6C, None),
    ("CurrencyResourceFromWorld.ValidateNumber",  0x31540E8, 0x140, 0x6C, None),
]

def body(rva, field, kinds):
    if kinds is None:
        cmp_chain = "b floor\n"
    else:
        cmp_chain = "ldr w9, [x0, #%#x]\n" % field + "".join(f"cmp w9, #{k}\n b.eq floor\n" for k in kinds) + "b done\n"
    asm = f"""
        fmov x9, d0
        mvn  x9, x9
        tst  x9, #0x7ff0000000000000
        b.ne finite
        fmov d0, xzr
    finite:
        adrp x9, {LIT_VALUE_PTR & ~0xFFF:#x}
        ldr  x9, [x9, #{LIT_VALUE_PTR & 0xFFF:#x}]
        ldr  x9, [x9]
        cmp  x1, x9
        b.eq done
        {cmp_chain}
    floor:
        ldr  d1, lit
        fmaxnm d0, d0, d1
    done:
        ret
        .align 3
    lit:
        .quad {struct.unpack('<Q', struct.pack('<d', FLOOR))[0]:#x}
    """
    enc, _ = Ks(KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN).asm(asm, rva)
    return bytes(enc)

def main(src, dst):
    data = bytearray(open(src, 'rb').read())
    h = hashlib.sha256(data).hexdigest()
    if h != EXPECTED_SHA256:
        sys.exit(f"refusing: sha256 {h} is not the measured 1.13.3 arm64 libil2cpp.so")
    if data[:4] != b'\x7fELF' or struct.unpack_from('<H', data, 0x12)[0] != 183:
        sys.exit("refusing: not an AArch64 ELF")
    md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
    for name, rva, size, field, kinds in TARGETS:
        assert TEXT_VA <= rva and rva + size <= TEXT_VA + TEXT_SZ
        off = rva - TEXT_VA + TEXT_OFF
        code = body(rva, field, kinds)
        if len(code) > size:
            sys.exit(f"{name}: patch {len(code)} > function size {size}")
        # literal must be 8-byte aligned
        assert (rva + len(code) - 8) % 8 == 0, f"{name}: literal misaligned"
        data[off:off+len(code)] = code
        print(f"[{name}] RVA {rva:#x} file {off:#x} {len(code)} bytes")
        for ins in md.disasm(code[:-8], rva):
            print(f"    {ins.address:08x}: {ins.mnemonic} {ins.op_str}")
    open(dst, 'wb').write(data)
    print("sha256 out:", hashlib.sha256(data).hexdigest())

if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit("usage: patch_libil2cpp.py <orig libil2cpp.so> <out libil2cpp.so>")
    main(sys.argv[1], sys.argv[2])
