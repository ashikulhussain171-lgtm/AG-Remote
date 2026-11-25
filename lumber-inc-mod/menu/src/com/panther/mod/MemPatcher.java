package com.panther.mod;

import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.Arrays;

/** Reads and writes this process's own libil2cpp.so code through /proc/self/mem. */
final class MemPatcher {
    private static final String MODULE = "libil2cpp.so";
    private long base;      // 0 = module not resolved yet
    private long end;

    /** Finds the load base (mapping with file offset 0) and the end of the last mapping. */
    boolean resolve() throws IOException {
        long b = 0, e = 0;
        try (BufferedReader r = new BufferedReader(new FileReader("/proc/self/maps"))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (!line.endsWith("/" + MODULE)) continue;
                String[] f = line.split("\\s+");
                String[] range = f[0].split("-");
                long start = Long.parseLong(range[0], 16), stop = Long.parseLong(range[1], 16);
                long fileOff = Long.parseLong(f[2], 16);
                if (fileOff == 0 && b == 0) b = start;
                if (b != 0 && stop > e) e = stop;
            }
        }
        if (b == 0 || e - b < Patches.MODULE_SIZE_MIN) return false;
        byte[] magic = read(b, 4);
        if (magic[0] != 0x7f || magic[1] != 'E' || magic[2] != 'L' || magic[3] != 'F') return false;
        base = b; end = e;
        return true;
    }

    boolean isResolved() { return base != 0; }

    byte[] read(long addr, int n) throws IOException {
        try (RandomAccessFile f = new RandomAccessFile("/proc/self/mem", "r")) {
            f.seek(addr);
            byte[] buf = new byte[n];
            f.readFully(buf);
            return buf;
        }
    }

    private void write(long addr, byte[] data) throws IOException {
        try (RandomAccessFile f = new RandomAccessFile("/proc/self/mem", "rw")) {
            f.seek(addr);
            f.write(data);
        }
    }

    /**
     * Applies or restores one patch group. Every site is checked first (must hold either the
     * original or the patched bytes of this build); nothing is written if any check fails.
     * If a write fails midway, the sites already written are rolled back.
     */
    synchronized String setGroup(Patches.Group g, boolean on) throws IOException {
        if (base == 0) return "game code not loaded yet";
        java.util.List<Patches.Patch> sites = new java.util.ArrayList<>();
        for (Patches.Patch p : Patches.ALL) {
            if (p.group != g) continue;
            long addr = base + p.rva;
            if (addr + p.orig.length > end) return "address outside libil2cpp: " + p.name;
            byte[] cur = read(addr, p.orig.length);
            if (!Arrays.equals(cur, p.orig) && !Arrays.equals(cur, p.patched))
                return "unexpected bytes at " + p.name + " (different game version?)";
            sites.add(p);
        }
        java.util.List<Patches.Patch> done = new java.util.ArrayList<>();
        try {
            for (Patches.Patch p : sites) {
                write(base + p.rva, on ? p.patched : p.orig);
                done.add(p);
            }
        } catch (IOException ex) {
            for (Patches.Patch p : done) {
                try { write(base + p.rva, on ? p.orig : p.patched); } catch (IOException ignored) { }
            }
            throw ex;
        }
        for (Patches.Patch p : sites) {
            byte[] want = on ? p.patched : p.orig;
            if (!Arrays.equals(read(base + p.rva, want.length), want)) return "write did not stick: " + p.name;
        }
        return null;
    }
}
