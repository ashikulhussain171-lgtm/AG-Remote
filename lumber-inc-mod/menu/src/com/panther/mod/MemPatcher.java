package com.panther.mod;

import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Patches this process's own libil2cpp.so code. Android does not let apps write
 * /proc/self/mem, so reads and writes go through libpanther.so (mprotect + copy + icache sync).
 */
final class MemPatcher {
    interface Io {
        byte[] read(long addr, int len) throws IOException;
        void write(long addr, byte[] data) throws IOException;
    }

    private static final String MODULE = "libil2cpp.so";
    private final Io io;
    private long base;      // 0 = module not resolved yet
    private long end;

    MemPatcher(Io io) { this.io = io; }

    /** Finds the load base (mapping with file offset 0) and the end of the module's last mapping. */
    boolean resolve() throws IOException {
        long b = 0, e = 0;
        try (BufferedReader r = new BufferedReader(new FileReader("/proc/self/maps"))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (!line.endsWith("/" + MODULE)) continue;
                String[] f = line.trim().split("\\s+");
                String[] range = f[0].split("-");
                long start = Long.parseLong(range[0], 16), stop = Long.parseLong(range[1], 16);
                long fileOff = Long.parseLong(f[2], 16);
                if (fileOff == 0 && b == 0) b = start;
                if (b != 0 && stop > e) e = stop;
            }
        }
        if (b == 0 || e - b < Patches.MODULE_SIZE_MIN) return false;
        byte[] magic = io.read(b, 4);
        if (magic[0] != 0x7f || magic[1] != 'E' || magic[2] != 'L' || magic[3] != 'F') return false;
        base = b; end = e;
        return true;
    }

    boolean isResolved() { return base != 0; }

    /**
     * Applies or restores one patch group. Every site is checked first (must hold either the
     * original or the patched bytes of this build); nothing is written if any check fails.
     * If a write fails midway, the sites already written are rolled back.
     */
    synchronized String setGroup(Patches.Group g, boolean on) throws IOException {
        if (base == 0) return "game code not loaded yet";
        List<Patches.Patch> sites = new ArrayList<>();
        for (Patches.Patch p : Patches.ALL) {
            if (p.group != g) continue;
            long addr = base + p.rva;
            if (addr + p.orig.length > end) return "address outside libil2cpp: " + p.name;
            byte[] cur = io.read(addr, p.orig.length);
            if (!Arrays.equals(cur, p.orig) && !Arrays.equals(cur, p.patched))
                return "unexpected bytes at " + p.name + " (different game version?)";
            sites.add(p);
        }
        List<Patches.Patch> done = new ArrayList<>();
        try {
            for (Patches.Patch p : sites) {
                io.write(base + p.rva, on ? p.patched : p.orig);
                done.add(p);
            }
        } catch (IOException ex) {
            for (Patches.Patch p : done) {
                try { io.write(base + p.rva, on ? p.orig : p.patched); } catch (IOException ignored) { }
            }
            throw ex;
        }
        for (Patches.Patch p : sites) {
            byte[] want = on ? p.patched : p.orig;
            if (!Arrays.equals(io.read(base + p.rva, want.length), want)) return "write did not stick: " + p.name;
        }
        return null;
    }

    // ---- native backend (libpanther.so) ----

    private static native int nativeWrite(long addr, byte[] data, long pageSize);
    private static native byte[] nativeRead(long addr, int len);

    static Io nativeIo() throws IOException {
        try {
            System.loadLibrary("panther");
        } catch (Throwable t) {
            throw new IOException("libpanther.so not loaded: " + t);
        }
        final long pageSize = android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE);
        return new Io() {
            @Override public byte[] read(long addr, int len) throws IOException {
                byte[] b = nativeRead(addr, len);
                if (b == null || b.length != len) throw new IOException("read failed at 0x" + Long.toHexString(addr));
                return b;
            }
            @Override public void write(long addr, byte[] data) throws IOException {
                int r = nativeWrite(addr, data, pageSize);
                if (r == -13) throw new IOException("mprotect denied (EACCES)");
                if (r != 0) throw new IOException("patch write failed, code " + r);
            }
        };
    }
}
