/* libpanther.so — in-process code patcher for the Panther Mods menu (Android arm64).
 * Freestanding: no libc, raw syscalls, so it builds without the NDK.
 * JNI table slots (JNI spec order): GetArrayLength 171, NewByteArray 176,
 * GetByteArrayRegion 200, SetByteArrayRegion 208. */
typedef unsigned long  u64;
typedef long           i64;
typedef int            i32;
typedef signed char    i8;

typedef void *jobject;
typedef void **JNIEnv;          /* JNIEnv* points at a pointer to the function table */

typedef i32     (*GetArrayLength_t)(JNIEnv *, jobject);
typedef jobject (*NewByteArray_t)(JNIEnv *, i32);
typedef void    (*ByteArrayRegion_t)(JNIEnv *, jobject, i32, i32, i8 *);

#define FN(env, idx) ((*(void ***)(env))[idx])

#define SYS_mprotect 226
#define PROT_READ  1
#define PROT_WRITE 2
#define PROT_EXEC  4
#define MAX_PATCH  4096

static i64 sys3(i64 nr, i64 a, i64 b, i64 c) {
    register i64 x8 __asm__("x8") = nr;
    register i64 x0 __asm__("x0") = a;
    register i64 x1 __asm__("x1") = b;
    register i64 x2 __asm__("x2") = c;
    __asm__ volatile("svc #0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2) : "memory");
    return x0;
}

static void sync_icache(u64 start, u64 end) {
    u64 ctr;
    __asm__ volatile("mrs %0, ctr_el0" : "=r"(ctr));
    u64 dline = 4ul << ((ctr >> 16) & 0xf), iline = 4ul << (ctr & 0xf);
    for (u64 p = start & ~(dline - 1); p < end; p += dline) __asm__ volatile("dc cvau, %0" :: "r"(p) : "memory");
    __asm__ volatile("dsb ish" ::: "memory");
    for (u64 p = start & ~(iline - 1); p < end; p += iline) __asm__ volatile("ic ivau, %0" :: "r"(p) : "memory");
    __asm__ volatile("dsb ish\n\tisb" ::: "memory");
}

/* Writes data into code at addr. Returns 0, or a negative errno from mprotect,
 * or -1000 for bad arguments. Pages are made RWX for the copy and set back to R-X. */
__attribute__((visibility("default")))
i32 Java_com_panther_mod_MemPatcher_nativeWrite(JNIEnv *env, jobject cls, i64 addr, jobject arr, i64 pageSize) {
    (void)cls;
    if (!arr || addr <= 0 || pageSize <= 0 || (pageSize & (pageSize - 1))) return -1000;
    i32 len = ((GetArrayLength_t)FN(env, 171))(env, arr);
    if (len <= 0 || len > MAX_PATCH) return -1000;
    i8 buf[MAX_PATCH];
    ((ByteArrayRegion_t)FN(env, 200))(env, arr, 0, len, buf);

    u64 start = (u64)addr & ~((u64)pageSize - 1);
    u64 end = ((u64)addr + (u64)len + (u64)pageSize - 1) & ~((u64)pageSize - 1);
    i64 r = sys3(SYS_mprotect, (i64)start, (i64)(end - start), PROT_READ | PROT_WRITE | PROT_EXEC);
    if (r < 0) return (i32)r;
    volatile i8 *dst = (volatile i8 *)addr;
    for (i32 i = 0; i < len; i++) dst[i] = buf[i];
    sync_icache((u64)addr, (u64)addr + (u64)len);
    r = sys3(SYS_mprotect, (i64)start, (i64)(end - start), PROT_READ | PROT_EXEC);
    return r < 0 ? (i32)r : 0;
}

/* Copies len bytes from addr (a readable mapping checked by the caller via /proc/self/maps). */
__attribute__((visibility("default")))
jobject Java_com_panther_mod_MemPatcher_nativeRead(JNIEnv *env, jobject cls, i64 addr, i32 len) {
    (void)cls;
    if (addr <= 0 || len <= 0 || len > MAX_PATCH) return 0;
    jobject arr = ((NewByteArray_t)FN(env, 176))(env, len);
    if (!arr) return 0;
    ((ByteArrayRegion_t)FN(env, 208))(env, arr, 0, len, (i8 *)addr);
    return arr;
}
