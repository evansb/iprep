# 44. Debugging and sanitizers

*Part VII — Correctness, testing, and performance validation*

---

**Recall**
- A clean sanitizer run proves only that *no enabled check fired on the paths actually executed* in *that* instrumented binary — it is evidence, never a proof of absence.
- Warnings are implementation facilities, not standard requirements; the standard mandates a diagnostic only for ill-formed programs.
- Build sanitizers at `-O1 -g -fno-omit-frame-pointer`: `-O0` hides optimizer-exploited UB and destroys timing; `-O2` starts inlining away frames.
- ASan tracks **addressability and lifetime** (shadow memory, red zones, quarantine); MSan tracks **initializedness**; they answer different questions.
- ASan's default `malloc_context_size=30` gives you *three* stacks per report: access, allocation, and deallocation — read the allocation stack first.
- LSan ships inside ASan on Linux (`detect_leaks=1` by default); on macOS it is off by default and must be enabled explicitly.
- A reference cycle of `shared_ptr` is a genuine ownership leak even though every allocation still has an owner — LSan reports it only if nothing reachable points into the cycle.
- Pool/arena allocators hide logical leaks from LSan because the arena stays reachable; add domain accounting (checked-out slots at shutdown).
- UBSan is a *family* of independently enableable checks; `-fsanitize=undefined` is a curated group, not "all UB", and `-fsanitize=integer`/`implicit-conversion` are outside it.
- UBSan recovers and continues by default; `-fno-sanitize-recover=all` turns the first report into a nonzero exit, which is what CI wants.
- `-ftrapv` and `-fsanitize=signed-integer-overflow` differ: the former traps with no diagnostic, the latter prints file/line/values.
- A data race = two potentially concurrent conflicting accesses to the same memory location, at least one non-atomic, with no happens-before edge between them; it is UB, full stop.
- TSan cannot prove a lock-free algorithm correct: it finds races, not linearizability, progress, ABA, or reclamation bugs.
- TSan costs ~5–15× CPU and ~5–10× memory and must instrument *every* participating TU; ASan+TSan in one binary is unsupported.
- MSan demands a fully instrumented dependency stack including libc++ — one uninstrumented library yields false positives *and* false negatives.
- `_GLIBCXX_DEBUG` and `_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG` change container/iterator layout and ABI; every TU that exchanges those types must agree.
- `std::stacktrace` (C++23) needs `-lstdc++exp` on libstdc++ and `_GLIBCXX_HAVE_STACKTRACE`; `std::source_location::current()` as a default argument captures the *caller's* site.
- After corruption or in a signal handler, `malloc`, locks, and iostreams may deadlock — capture a minimal core and symbolize offline.
- Fix the **earliest** report: every later one may be a consequence of the first UB.
- Sanitizer binaries are not benchmarks; validate correctness under instrumentation and latency in a release-like build.

---

## 44.1 Compiler warnings as errors — with deliberate exceptions

```bash
# ---- reviewed baseline (clang and gcc both accept all of these) ----------
clang++ -std=c++23 -g -O2 \
  -Wall -Wextra -Wpedantic \
  -Wconversion -Wsign-conversion \
  -Wshadow -Wold-style-cast -Wcast-qual -Wcast-align \
  -Wdouble-promotion -Wformat=2 -Wnull-dereference \
  -Wnon-virtual-dtor -Woverloaded-virtual \
  -Wunused -Wuninitialized -Wswitch-enum \
  -Werror app.cpp -o app

# ---- gcc-only high-value additions --------------------------------------
g++ -std=c++23 -Wduplicated-cond -Wduplicated-branches -Wlogical-op \
    -Wuseless-cast -Wsuggest-override -Wmisleading-indentation \
    -Wanalyzer-too-complex -fanalyzer app.cpp        # -fanalyzer: GCC static analysis

# ---- clang-only ---------------------------------------------------------
clang++ -Wthread-safety -Wdocumentation -Wimplicit-fallthrough \
        -Wextra-semi -Wrange-loop-analysis app.cpp
clang++ -Weverything -Wno-c++98-compat -Wno-padded ...   # firehose: triage, never ship

# ---- MSVC ---------------------------------------------------------------
cl /std:c++latest /W4 /WX /permissive- /Zc:__cplusplus /analyze app.cpp
```

| Flag | Catches | Typical false-positive source |
|---|---|---|
| `-Wconversion` | `size_t`→`int`, `double`→`float` narrowing | intentional truncation; wrap in a named cast |
| `-Wsign-conversion` | signed↔unsigned index arithmetic | `v[i]` with `int i` — the real fix is `std::size_t` |
| `-Wshadow` | local `qty` hiding member `qty` | ctor parameter idiom; use `-Wshadow=local` on gcc |
| `-Wold-style-cast` | `(int)x` in C++ | C headers via macros |
| `-Wcast-align` | `char*`→`uint32_t*` | correct only under proven alignment |
| `-Wfloat-equal` | `a == b` on floats | exact sentinel comparisons |
| `-Wswitch-enum` | new enumerator not handled | intentional default-handled switches |
| `-Wnull-dereference` | provably-null deref path | optimizer-inferred paths at `-O2`+ |
| `-Wnon-virtual-dtor` | polymorphic delete through base | non-owning base classes |
| `-Wthread-safety` (clang) | lock discipline via annotations | requires `GUARDED_BY` annotations |

```cpp
// ---- narrowest-scope suppression: pragma push/pop ------------------------
// clang accepts the "GCC diagnostic" spelling; _Pragma works inside macros.
#define QS_DIAG_PUSH      _Pragma("GCC diagnostic push")
#define QS_DIAG_POP       _Pragma("GCC diagnostic pop")
#define QS_DIAG_IGNORE(w) _Pragma(QS_STRINGIZE(GCC diagnostic ignored w))
#define QS_STRINGIZE(x)   #x

QS_DIAG_PUSH
QS_DIAG_IGNORE("-Wshadow")            // WHY: ctor parameter deliberately named like member
int shadowing_ok = 0;
QS_DIAG_POP

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wconversion"     // WHY: len proven <= INT_MAX above
int n = static_cast<int>(len);
#pragma GCC diagnostic pop
```

```cpp
// ---- MSVC equivalent ----------------------------------------------------
#pragma warning(push)
#pragma warning(disable : 4244)   // conversion, possible loss of data
int n = (int)len;
#pragma warning(pop)

// ---- treat third-party headers as system headers (silences their warnings)
// clang/gcc: -isystem /opt/boost/include   (NOT -I)
// msvc:      /external:I <dir> /external:W0
```

```cpp
// ---- [[nodiscard]] is a warning you author -------------------------------
[[nodiscard]] bool publish(int event) noexcept;
[[nodiscard("check the ack; a dropped fill is silent")]] Ack send(Order const&);
struct [[nodiscard]] Error {};              // every function returning Error is checked

void process(int e) {
    if (!publish(e)) { retry(e); }          // handled
    (void)publish(e);                       // silences the check — document WHY
    std::ignore = publish(e);               // clearer intent than (void)
}

// ---- other author-side diagnostics ---------------------------------------
[[deprecated("use send_v2")]] void send_v1();
[[maybe_unused]] auto probe = install_hook();          // suppresses -Wunused
switch (s) { case A: f(); [[fallthrough]]; case B: g(); break; }   // -Wimplicit-fallthrough
[[assume(n > 0)]];                                     // C++23: optimizer hint, NOT a check
static_assert(sizeof(Tick) == 16, "layout changed");   // compile-time, not a warning
```

**Warning coverage across configurations** — templates and `#if` branches are only diagnosed when *instantiated/compiled*.

| Axis | Why it must be in CI |
|---|---|
| Debug **and** `-O2`/`-O3` | `-Wnull-dereference`, `-Wmaybe-uninitialized`, `-Warray-bounds` are flow-sensitive and mostly fire only when optimizing |
| gcc **and** clang (**and** MSVC) | disjoint diagnostic sets; two-compiler CI roughly doubles coverage |
| `-fno-exceptions` / `-fno-rtti` builds | otherwise those branches never compile and silently rot |
| Each feature flag / `#ifdef` | a never-compiled `#if` branch is dead code that will break on the day it is needed |
| Every target arch (`-march=`, 32/64-bit) | size/alignment-dependent conversions differ |

**Traps** — `-Werror` in a *released* library breaks downstream builds on newer compilers; gate it to CI (`-DDEV_BUILD=ON`) · `-Weverything` includes mutually contradictory checks · a blanket `(void)` cast is a suppression with no recorded reason · `-Wall` is not "all warnings" · `[[assume]]` violated is UB, not a diagnostic · different `-D` macros per TU is an ODR violation no warning catches.

---

## 44.2 AddressSanitizer and LeakSanitizer

```bash
# ---- canonical ASan build (link and compile with the same flags) ---------
clang++ -std=c++23 -g -O1 -fno-omit-frame-pointer \
        -fsanitize=address app.cpp -o app_asan

# ---- opt-in extras ------------------------------------------------------
-fsanitize-address-use-after-scope        # UAS of locals (on by default in clang now)
-fsanitize-address-use-after-return=always# UAR via fake stack (runtime cost)
-fsanitize=address,undefined              # ASan+UBSan: fully supported together
-shared-libasan                           # dynamic runtime (needed for dlopen'd libs)
-static-libsan                            # ship the runtime inside the binary

# ---- gcc equivalent -----------------------------------------------------
g++ -std=c++23 -g -O1 -fno-omit-frame-pointer -fsanitize=address \
    --param=asan-stack=1 --param=asan-globals=1 app.cpp -o app_asan

# ---- run ----------------------------------------------------------------
ASAN_OPTIONS=detect_leaks=1:abort_on_error=1:symbolize=1 \
ASAN_SYMBOLIZER_PATH=$(which llvm-symbolizer) ./app_asan
```

| `ASAN_OPTIONS=` key | Default | Effect |
|---|---|---|
| `detect_leaks=1` | 1 (Linux), 0 (mac) | run LSan at exit |
| `halt_on_error=0` | 1 | continue after a recoverable error (needs `-fsanitize-recover=address`) |
| `abort_on_error=1` | 0 | `abort()` instead of `_exit` → produces a core dump |
| `detect_stack_use_after_return=1` | 0/1 by version | enable fake-stack UAR detection |
| `detect_odr_violation=2` | 2 | flag duplicate global symbols across TUs |
| `strict_string_checks=1` | 0 | bounds-check `strlen`/`strcpy` family strictly |
| `check_initialization_order=1` | 0 | static init order fiasco detection |
| `strict_init_order=1` | 0 | stronger form of the above |
| `detect_invalid_pointer_pairs=2` | 0 | `p - q` / `p < q` across different objects |
| `malloc_context_size=30` | 30 | frames kept per alloc/free stack |
| `quarantine_size_mb=256` | 256 | delay reuse of freed chunks → deeper UAF window |
| `redzone=16` / `max_redzone=2048` | 16/2048 | bytes of poison around each allocation |
| `allocator_may_return_null=1` | 0 | return `nullptr` on huge alloc instead of aborting |
| `log_path=/tmp/asan` | stderr | one `asan.<pid>` file per process |
| `suppressions=asan.supp` | — | file of `interceptor_name:`/`odr_violation:` rules |
| `print_stats=1`, `verbosity=1` | 0 | runtime diagnostics |
| `fast_unwind_on_malloc=0` | 1 | slower but accurate alloc stacks under `-fomit-frame-pointer` |

```bash
# LSAN_OPTIONS is separate; when LSan runs under ASan it reads BOTH.
LSAN_OPTIONS=suppressions=lsan.supp:print_suppressions=0:report_objects=1 ./app_asan
```

```text
# lsan.supp  — one rule per line, substring match on a frame name
leak:^libcuda\.so
leak:CRYPTO_zalloc
leak:MyIntentionalSingletonCache::instance

# asan.supp
interceptor_name:strlen
odr_violation:MyDuplicatedGlobal
```

```cpp
// ---- UB snippets ASan catches -------------------------------------------
int heap_oob()   { int* p = new int[4]; int v = p[4]; delete[] p; return v; }   // heap-buffer-overflow
int stack_oob()  { int a[4]{}; return a[4]; }                                   // stack-buffer-overflow
int g[4];
int global_oob() { return g[4]; }                                               // global-buffer-overflow
int uaf()        { int* p = new int{1}; delete p; return *p; }                  // heap-use-after-free
void dfree()     { int* p = new int; delete p; delete p; }                      // attempting double-free
void mismatch()  { int* p = new int[4]; delete p; }                             // alloc-dealloc-mismatch
int* uas()       { int* q; { int local = 5; q = &local; } return q; }           // stack-use-after-scope
int const& uar() { int local = 5; return local; }                               // stack-use-after-return

// ---- the container classic: reallocation invalidates references ----------
#include <vector>
int dangling_ref() {
    std::vector<int> v;
    v.push_back(7);
    int& saved = v.front();      // points into the current buffer
    v.push_back(9);              // MAY reallocate → saved dangles
    return saved;                // heap-use-after-free IF it reallocated
}
// Deterministic regression test — never rely on the growth factor:
void force_realloc(std::vector<int>& v) {
    auto const cap = v.capacity();
    while (v.capacity() == cap) v.push_back(0);   // guaranteed to have grown
}
```

```text
==12345==ERROR: AddressSanitizer: heap-use-after-free on address 0x602000000010
READ of size 4 at 0x602000000010 thread T0
    #0 0x4f1a2b in dangling_ref() app.cpp:7:12         <-- the access
  0x602000000010 is located 0 bytes inside of 4-byte region
  freed by thread T0 here:                              <-- READ THIS SECOND
    #0 0x4b9c1d in operator delete(void*)
    #1 0x4f19a4 in std::vector<int>::push_back  app.cpp:6
  previously allocated by thread T0 here:               <-- READ THIS FIRST
    #0 0x4b9411 in operator new(unsigned long)
    #1 0x4f1901 in std::vector<int>::push_back  app.cpp:5
SUMMARY: AddressSanitizer: heap-use-after-free app.cpp:7 in dangling_ref()
Shadow bytes around the buggy address:
=>0x0c047fff8000: fa fa[fd]fd fa fa 00 00 ...
```

| Shadow byte | Meaning |
|---|---|
| `00` | all 8 bytes addressable |
| `01`–`07` | partially addressable (first N bytes valid) |
| `fa` | heap left redzone |
| `fb` | heap right redzone |
| `fd` | freed heap region (quarantine) → **use-after-free** |
| `f1`/`f2`/`f3` | stack left / mid / right redzone |
| `f5` | stack-use-after-return |
| `f8` | stack-use-after-scope |
| `f9` | global redzone |
| `f6` | user-poisoned via manual API |

```cpp
// ---- teaching ASan about a custom allocator ------------------------------
#include <sanitizer/asan_interface.h>       // no-ops when ASan is off
__asan_poison_memory_region(slot, size);    // mark a pool slot as "freed"
__asan_unpoison_memory_region(slot, size);  // mark it as live on check-out
bool bad = __asan_address_is_poisoned(p);
__lsan_ignore_object(cache);                // this allocation is intentional
__lsan_do_leak_check();                     // checkpoint leak check mid-run
int leaks = __lsan_do_recoverable_leak_check();  // returns 1 if leaks found
{ __lsan::ScopedDisabler d; /* allocations here are never leak-reported */ }

// Also usable from ordinary code, guarded:
#if defined(__has_feature)
#  if __has_feature(address_sanitizer)
#    define QS_ASAN 1
#  endif
#endif
#if defined(__SANITIZE_ADDRESS__)           // gcc's spelling
#  define QS_ASAN 1
#endif

// ---- opting a function out (needed for hand-written asm / stack scanning)
__attribute__((no_sanitize("address")))     void raw_scan();
__attribute__((no_sanitize_address))        void raw_scan2();   // older spelling
__attribute__((disable_sanitizer_instrumentation)) void raw_scan3();  // clang, stronger
```

```text
# blacklist / ignorelist file, passed as -fsanitize-ignorelist=ign.txt
[address]
fun:*HotPathMemcpy*
src:third_party/legacy/*
type:LegacyBuffer
```

| ASan **cannot** find | Why |
|---|---|
| Intra-object overflow between members of one struct | both are inside one addressable allocation (partly covered by `-fsanitize-address-field-padding`, ABI-breaking) |
| Use of an invalid pointer that is never dereferenced | no instrumented access occurs |
| Overflow within a custom pool that is one big `malloc` | the arena is addressable end to end unless you poison |
| Data races | no happens-before model — that is TSan |
| Uninitialized reads | memory is addressable but garbage — that is MSan |
| Bugs in uninstrumented `.so`s | instrumentation is per-TU |

**Traps** — you must **link** with `-fsanitize=address` too, not just compile · `LD_PRELOAD` of another malloc breaks the interceptors · `setrlimit`/`RLIMIT_AS` fights ASan's 20 TB shadow reservation → set `ulimit -v unlimited` · `_Exit()`, `std::quick_exit`, or a crash skips the leak pass · `fork()` without `exec` may double-report · overhead ≈ 2× CPU, 3× RSS — never a latency benchmark · ASan under `valgrind` is unsupported.

---

## 44.3 UndefinedBehaviorSanitizer

```bash
# ---- CI-grade UBSan: no recovery, print the stack ------------------------
clang++ -std=c++23 -g -O1 -fno-omit-frame-pointer \
        -fsanitize=undefined \
        -fno-sanitize-recover=undefined \
        app.cpp -o app_ubsan
# add -fsanitize-trap=undefined instead to trap (ud2) with no runtime/message

# ---- the useful groups that are NOT in `undefined` -----------------------
-fsanitize=integer                # unsigned overflow + implicit truncation (clang)
-fsanitize=implicit-conversion    # implicit int truncation/sign-change
-fsanitize=nullability            # _Nonnull violations
-fsanitize=local-bounds           # array bounds the frontend can prove shapes for
-fsanitize=float-divide-by-zero   # removed from the default group

# ---- production-shippable subset: traps, no runtime, ~free ---------------
clang++ -O2 -fsanitize=signed-integer-overflow,bounds,shift,vla-bound \
        -fsanitize-trap=all -fno-sanitize-recover=all app.cpp

# ---- run ----------------------------------------------------------------
UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1:report_error_type=1 ./app_ubsan
```

| Check (`-fsanitize=`) | Fires on | In `undefined` group |
|---|---|---|
| `signed-integer-overflow` | `INT_MAX + 1` | yes |
| `unsigned-integer-overflow` | `0u - 1` (defined but often a bug) | **no** (`integer`) |
| `shift` / `shift-base` / `shift-exponent` | `1 << 32`, `-1 << 1` | yes |
| `integer-divide-by-zero` | `x / 0`, `INT_MIN / -1` | yes |
| `null` | deref / member call on `nullptr` | yes |
| `alignment` | misaligned load/store or `this` | yes |
| `object-size` | access past a size the optimizer knows | yes |
| `bounds` / `array-bounds` | constant-extent array OOB | yes |
| `bool` / `enum` | loading a value outside the valid range | yes |
| `float-cast-overflow` | `double`→`int` out of range | yes |
| `return` | flowing off the end of a non-void function | yes |
| `returns-nonnull-attribute` | returning null from `__attribute__((returns_nonnull))` | yes |
| `vptr` | wrong-type polymorphic call / bad `dynamic_cast` | yes (needs RTTI, no `-fno-rtti`) |
| `unreachable` | reaching `std::unreachable()` / `__builtin_unreachable()` | yes |
| `vla-bound` | non-positive VLA extent | yes |
| `pointer-overflow` | pointer arithmetic that wraps | yes |
| `builtin` | `__builtin_clz(0)` etc. | yes |
| `function` | indirect call through a wrong-type pointer | clang, yes |

```cpp
// ---- one snippet per check ----------------------------------------------
#include <bit>       // std::byteswap, std::bit_cast (C++23/20)
#include <climits>
#include <cstdint>
#include <cstring>
#include <limits>
#include <utility>   // std::unreachable (C++23)

int    ovf()   { auto x = std::numeric_limits<std::int32_t>::max(); return x + 1; }  // signed-integer-overflow
int    shf(int n) { return 1 << n; }            // n>=32 → shift-exponent; n=31 on int → shift-base
int    dv(int a)  { return 1 / a; }             // a==0 → integer-divide-by-zero
int    idm()   { return INT_MIN / -1; }         // integer-divide-by-zero (overflow form)
int    nul(int* p){ return *p; }                // p==nullptr → null
bool   bl(char c) { return *reinterpret_cast<bool*>(&c); }   // c==2 → bool
enum class E : int { A, B };
E      en(int i)  { return *reinterpret_cast<E*>(&i); }      // i==7 → enum
int    fco(double d) { return static_cast<int>(d); }         // d==1e300 → float-cast-overflow
int    bnd()   { int a[4]{}; int i = 4; return a[i]; }       // array-bounds
int    unr(int x) { if (x) return 1; std::unreachable(); }   // C++23; x==0 → unreachable

// misaligned + strict-aliasing load — the classic wire-decode bug
std::uint32_t bad_load(std::byte const* p) {
    return *reinterpret_cast<std::uint32_t const*>(p);       // alignment + aliasing UB
}
// The fix: memcpy into a live trivially copyable object, then convert endianness.
std::uint32_t good_load(std::byte const* p) noexcept {
    std::uint32_t v;                       // lifetime begins here
    std::memcpy(&v, p, sizeof v);          // well-defined; optimizes to one mov
    return std::byteswap(v);               // C++23, <bit> — wire is big-endian
}
// C++20 alternative when the bytes already hold a valid object representation:
// auto v = std::bit_cast<std::uint32_t>(arr4);   // constexpr, same-size, trivially copyable
```

```text
app.cpp:7:22: runtime error: signed integer overflow: 2147483647 + 1 cannot be
              represented in type 'int'
    #0 0x4f13a0 in ovf() app.cpp:7:22
    #1 0x4f1500 in main app.cpp:20:12
SUMMARY: UndefinedBehaviorSanitizer: undefined-behavior app.cpp:7:22
```

| `UBSAN_OPTIONS=` key | Effect |
|---|---|
| `print_stacktrace=1` | include a stack (needs a symbolizer; off by default) |
| `halt_on_error=1` | stop at the first report |
| `report_error_type=1` | print the specific check name in the SUMMARY line |
| `suppressions=ub.supp` | apply a suppression file |
| `silence_unsigned_overflow=1` | keep `integer` on but mute unsigned wrap |
| `log_path=/tmp/ubsan` | per-pid files |

```text
# ub.supp — key must match the check name
signed-integer-overflow:legacy_hash.cpp
alignment:third_party/decoder.h
vptr:LegacyBase
```

```cpp
// ---- recover vs trap ----------------------------------------------------
// -fsanitize-recover=undefined  : report, then CONTINUE (default for most checks)
// -fno-sanitize-recover=undefined: report, then exit nonzero            <-- CI
// -fsanitize-trap=undefined     : `ud2`/`brk`, no message, no runtime   <-- shippable
// Continuing after UB collects more diagnostics; it does not make the program defined.

// ---- per-function opt-out ----------------------------------------------
__attribute__((no_sanitize("undefined")))            void legacy();
__attribute__((no_sanitize("signed-integer-overflow"))) int  hash_mix(int);
[[gnu::no_sanitize("alignment")]] std::uint32_t packed_read(void const*);  // C++11 attr spelling

// ---- unsigned wrap is DEFINED but usually still a bug -------------------
std::size_t n = v.size();
for (std::size_t i = n - 1; i >= 0; --i) {}   // infinite: i wraps to SIZE_MAX, no UB
for (std::size_t i = n; i-- > 0;) {}          // correct reverse loop
```

**Traps** — `-fsanitize=undefined` is not "all UB": it never sees strict-aliasing violations, most lifetime bugs, uninitialized reads, or races · `vptr` needs RTTI and an instrumented runtime, so it is incompatible with `-fno-rtti` · gcc's UBSan check set differs from clang's · a check the optimizer proved impossible is deleted, so `-O2` can *lose* reports · `-ftrapv` is the legacy, message-less alternative to `signed-integer-overflow` · UBSan + `-fvisibility=hidden` can break `vptr` across `.so` boundaries.

---

## 44.4 ThreadSanitizer and concurrency-test limitations

```bash
clang++ -std=c++23 -g -O1 -fno-omit-frame-pointer \
        -fsanitize=thread race.cpp -o race_tsan       # every participating TU!

TSAN_OPTIONS="halt_on_error=1:second_deadlock_stack=1:history_size=7\
:suppressions=tsan.supp:report_atomic_races=1" ./race_tsan
```

| `TSAN_OPTIONS=` key | Default | Effect |
|---|---|---|
| `halt_on_error=1` | 0 | stop at the first race |
| `history_size=N` (0–7) | 2 | per-thread memory-access history; higher = better second stacks, more RAM |
| `second_deadlock_stack=1` | 0 | print both lock-acquisition stacks for lock-order inversion |
| `detect_deadlocks=1` | 1 | lock-order-inversion (potential deadlock) detection |
| `report_thread_leaks=0` | 1 | mute unjoined-thread reports |
| `report_signal_unsafe=0` | 1 | mute async-signal-unsafe call reports |
| `report_atomic_races=0` | 1 | mute races involving atomics (e.g. intentional seqlock) |
| `io_sync=0/1/2` | 1 | how much happens-before to infer from I/O |
| `flush_memory_ms=N` | 0 | periodically drop shadow state on long runs |
| `force_seq_cst_atomics=1` | 0 | debug relaxed-ordering bugs by strengthening everything |
| `atexit_sleep_ms=1000` | 1000 | grace period for background threads at exit |
| `suppressions=tsan.supp` | — | suppression file |

```text
# tsan.supp — the type prefix is mandatory
race:MyLockFreeQueue::push
race:legacy_counter.cpp
deadlock:third_party::Registry::lock
thread:StartLegacyThread
signal:my_signal_handler
mutex:LegacyRecursiveLock
called_from_lib:libgomp.so.1
```

```cpp
// ---- 1. plain data race --------------------------------------------------
#include <thread>
int value = 0;
int main() {
    std::thread a([]{ value = 1; });     // WARNING: data race
    std::thread b([]{ value = 2; });     //          write of size 4 / write of size 4
    a.join(); b.join();
    return value;
}

// ---- 2. race-free but WRONG: relaxed publication -------------------------
#include <atomic>
std::atomic<bool> ready{false};
int payload{};
void producer() {
    payload = 42;                                  // plain write
    ready.store(true, std::memory_order_relaxed);  // NO release edge
}
void consumer() {
    if (ready.load(std::memory_order_relaxed))     // NO acquire edge
        use(payload);                              // data race on `payload` — TSan reports it
}
// Fix — release/acquire creates the happens-before edge:
void producer_ok() { payload = 42; ready.store(true, std::memory_order_release); }
void consumer_ok() { if (ready.load(std::memory_order_acquire)) use(payload); }

// ---- 3. lock-order inversion (TSan finds it WITHOUT deadlocking) --------
std::mutex m1, m2;
void t1() { std::scoped_lock lk(m1, m2); }   // scoped_lock: deadlock-free ordering
void t2() { std::lock_guard a(m2); std::lock_guard b(m1); }  // WARNING: lock-order-inversion

// ---- 4. what TSan will NOT tell you --------------------------------------
// - ABA in a CAS loop           - missing reclamation (hazard pointers / epochs)
// - lost wakeup on a condvar    - linearizability / progress / wait-freedom
// - a race on a path never executed in this run
```

```text
WARNING: ThreadSanitizer: data race (pid=4242)
  Write of size 4 at 0x55a1f0 by thread T2:
    #0 operator() race.cpp:6 (race_tsan+0x4f1)
  Previous write of size 4 at 0x55a1f0 by thread T1:
    #0 operator() race.cpp:5 (race_tsan+0x4d2)
  Location is global 'value' of size 4 at 0x55a1f0
  Thread T2 (tid=4245, running) created by main thread at: ...
SUMMARY: ThreadSanitizer: data race race.cpp:6 in operator()
```

```cpp
// ---- annotating primitives TSan cannot see (inline asm, custom futex) ----
#include <sanitizer/tsan_interface.h>
__tsan_acquire(&addr);                 // "a happens-before edge arrives here"
__tsan_release(&addr);                 // "an edge departs here"
ANNOTATE_HAPPENS_BEFORE(&flag);        // legacy macro spellings
ANNOTATE_HAPPENS_AFTER(&flag);
ANNOTATE_BENIGN_RACE_SIZED(&counter, sizeof counter, "statistics counter");
__tsan_ignore_thread_begin(); /* ... */ __tsan_ignore_thread_end();

__attribute__((no_sanitize("thread"))) void seqlock_read_body();
#if defined(__SANITIZE_THREAD__) || (defined(__has_feature) && __has_feature(thread_sanitizer))
#  define QS_TSAN 1
#endif
```

**Concurrency test design under TSan**

| Do | Instead of |
|---|---|
| Run wraparound/full-capacity transitions | happy-path handoffs only |
| Vary thread count, producer delay, stop timing; replay a recorded seed | one fixed schedule |
| Assert *invariants* (sum conserved, no duplicate seq) | timing/latency assertions instrumentation invalidates |
| Test reclamation separately from index logic | one giant stress test |
| Reduce iteration count 10–100× under TSan; keep the shape | timing out CI |
| Pin the failing seed into a deterministic regression | "it's flaky, rerun" |

| Combination | Supported? |
|---|---|
| ASan + UBSan | **yes** |
| ASan + LSan | yes (LSan is part of ASan) |
| TSan + UBSan | yes |
| **ASan + TSan** | **no** — conflicting shadow-memory layouts and allocators |
| MSan + anything else | no |
| TSan + `fork()` in the child | unsupported/unreliable |

**Traps** — one uninstrumented `.so` in the mix produces both false positives and false negatives · TSan needs `ASLR` disabled on some kernels (`setarch -R`) or its 0x7cf0 mapping fails · ~5–15× CPU, 5–10× RAM, and a hard `history_size` cap on tracked accesses · a race TSan does not report may simply have not interleaved this run · `report_atomic_races=0` is the correct switch for a deliberate seqlock, not a `no_sanitize` on the whole file.

---

## 44.5 MemorySanitizer and uninitialized reads

```bash
# MSan is clang-only and requires EVERY dependency to be instrumented,
# including the C++ standard library.
clang++ -std=c++23 -g -O1 -fno-omit-frame-pointer \
        -fsanitize=memory \
        -fsanitize-memory-track-origins=2 \      # 1=alloc site, 2=full copy chain
        -fsanitize-memory-use-after-dtor \       # reads of a destroyed object
        -fPIE -pie app.cpp -o app_msan

# Instrumented libc++ (the mandatory step everyone forgets):
cmake -G Ninja -S llvm -B build-msan \
  -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi;libunwind" \
  -DLLVM_USE_SANITIZER=MemoryWithOrigins \
  -DCMAKE_BUILD_TYPE=Release && ninja -C build-msan cxx cxxabi
clang++ -stdlib=libc++ -nostdinc++ -isystem build-msan/include/c++/v1 \
        -L build-msan/lib -Wl,-rpath,build-msan/lib -lc++abi \
        -fsanitize=memory app.cpp -o app_msan

MSAN_OPTIONS=poison_in_dtor=1:halt_on_error=1:print_stats=1 ./app_msan
```

```cpp
// ---- UB snippets MSan catches -------------------------------------------
#include <array>
#include <vector>
#include <cstdlib>

int arr()  { std::array<int,4> lv;  return lv[2]; }        // indeterminate (erroneous in C++26)
int mal()  { int* p = (int*)std::malloc(sizeof(int)); int v = *p; std::free(p); return v; }
int par()  { struct S { int a; int b; }; S s; s.a = 1; return s.b; }   // partial init
int rez()  { std::vector<int> v; v.reserve(4); return v.data()[0]; }  // reserve ≠ construct
int brn(bool c) { int x; if (c) x = 1; return x; }        // conditionally-initialized
struct T { ~T(); int v; };
int uad(T* t) { t->~T(); return t->v; }                    // -fsanitize-memory-use-after-dtor

// ---- fixes ---------------------------------------------------------------
std::array<int,4> lv{};                    // value-initialized: all zeros
int x = c ? 1 : 0;                         // no path leaves it indeterminate
std::vector<int> v(4);                     // resize/ctor CONSTRUCTS; reserve does not
```

```text
==7788==WARNING: MemorySanitizer: use-of-uninitialized-value
    #0 0x4f12a0 in arr() app.cpp:6:12
    #1 0x4f1450 in main app.cpp:12:10
  Uninitialized value was created by an allocation of 'lv' in the stack frame
    #0 0x4f1230 in arr() app.cpp:5                      <-- origin, needs track-origins
SUMMARY: MemorySanitizer: use-of-uninitialized-value app.cpp:6:12 in arr()
```

| MSan interface (`<sanitizer/msan_interface.h>`) | Use |
|---|---|
| `__msan_unpoison(p, n)` | assert "these bytes are initialized" (wrapping an uninstrumented lib) |
| `__msan_poison(p, n)` | mark bytes uninitialized (testing your own poisoning) |
| `__msan_check_mem_is_initialized(p, n)` | report *now* if any byte is poisoned |
| `__msan_print_shadow(p, n)` | dump shadow bits for debugging |
| `__msan_allocated_memory(p, n)` | tell MSan a custom allocator just handed out raw bytes |
| `__msan_scoped_disable_interceptor_checks()` | temporarily suspend param checking |
| `__attribute__((no_sanitize("memory")))` | opt one function out |
| `MSAN_OPTIONS=poison_in_malloc=1` (default) | fresh `malloc` is poisoned |
| `MSAN_OPTIONS=exitcode=86` | distinctive CI exit code |

| Property | ASan | MSan |
|---|---|---|
| Question answered | is this address valid *right now*? | is this **value** initialized? |
| Mechanism | 1:8 shadow, red zones, quarantine | 1:1 shadow bit-per-bit + origin map |
| Overhead | ~2× CPU, 3× RAM | ~3× CPU, 2–3× RAM (more with origins) |
| Needs instrumented deps | helpful | **mandatory**, including libc++ |
| Compilers | clang, gcc, MSVC (`/fsanitize=address`) | **clang only** |

```cpp
// ---- padding is not data -------------------------------------------------
struct Quote { std::uint8_t side; /* 3 bytes padding */ std::uint32_t price; };
static_assert(sizeof(Quote) == 8);
Quote q{}; q.side = 1; q.price = 100;
// std::memcmp(&q, &r, sizeof q);          // WRONG: compares indeterminate padding
bool same = q.side == r.side && q.price == r.price;   // or: auto operator<=>(const Quote&) const = default;
std::memcpy(buf, &q, sizeof q);            // legal copy of a trivially copyable object,
                                           // but NEVER a wire format: padding is not stable
```

**Traps** — a single uninstrumented `.so` makes MSan useless (`use-of-uninitialized-value` inside libc is the tell) · MSan and ASan cannot coexist · reading an indeterminate value is UB in C++23 and *erroneous behavior* (diagnosable, not UB) under C++26's `[[indeterminate]]` rules — MSan reports both · `-fsanitize-memory-track-origins=2` is the difference between "somewhere" and "this line" · MSan requires PIE on Linux.

---

## 44.6 Standard-library debug modes and iterator checking

```bash
# ---- libstdc++ (gcc) ----------------------------------------------------
g++ -std=c++23 -D_GLIBCXX_DEBUG app.cpp            # full debug containers: ABI-BREAKING
g++ -std=c++23 -D_GLIBCXX_DEBUG -D_GLIBCXX_DEBUG_PEDANTIC app.cpp   # + non-portable usage
g++ -std=c++23 -D_GLIBCXX_ASSERTIONS app.cpp       # cheap precondition checks, ABI-COMPATIBLE
g++ -std=c++23 -D_GLIBCXX_DEBUG_BACKTRACE app.cpp  # backtrace on failure (GCC 13+)
g++ -std=c++23 -D_GLIBCXX_CONCEPT_CHECKS app.cpp   # legacy concept checking

# ---- libc++ (clang), hardening replaces the old _LIBCPP_DEBUG ------------
clang++ -std=c++23 -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_NONE       app.cpp
clang++ -std=c++23 -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST       app.cpp  # ship this
clang++ -std=c++23 -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE  app.cpp
clang++ -std=c++23 -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG      app.cpp  # ABI-BREAKING

# ---- MSVC STL -----------------------------------------------------------
cl /std:c++latest /MDd /D_ITERATOR_DEBUG_LEVEL=2 app.cpp   # full checked iterators (ABI)
cl /std:c++latest /MD  /D_ITERATOR_DEBUG_LEVEL=1 app.cpp   # checked iterators, release CRT
cl /std:c++latest      /D_ITERATOR_DEBUG_LEVEL=0 app.cpp   # off
cl /D_CONTAINER_DEBUG_LEVEL=1 app.cpp                      # container checks only
```

| Mode | Cost | ABI-safe? | Catches |
|---|---|---|---|
| `_GLIBCXX_ASSERTIONS` | O(1) per call | **yes** | `v[i]` OOB, `front()`/`back()` on empty, `pop_back()` on empty, bad `string` index |
| `_GLIBCXX_DEBUG` | O(1)–O(n) | **no** | above + invalid/singular/mismatched iterators, unordered ranges, invalid ranges |
| `_LIBCPP_HARDENING_MODE_FAST` | O(1) | yes | bounds and simple preconditions; production-suitable |
| `_LIBCPP_HARDENING_MODE_EXTENSIVE` | O(1) heavier | yes | + more preconditions, no O(n) checks |
| `_LIBCPP_HARDENING_MODE_DEBUG` | up to O(n) | **no** | + iterator ownership/validity, `strict_weak_ordering` checks |
| `_ITERATOR_DEBUG_LEVEL=2` | high | **no** | full iterator ownership + range validation |

```cpp
// ---- what a debug container diagnoses -----------------------------------
#include <vector>
#include <algorithm>
std::vector<int> a{1,2,3}, b{4,5,6};

*a.end();                                 // deref of past-the-end iterator
auto it = a.begin(); a.push_back(4); *it; // use of an INVALIDATED iterator
std::sort(a.begin(), b.end());            // iterators from DIFFERENT containers
a.erase(b.begin());                       // erase with a foreign iterator
std::vector<int>::iterator sing; *sing;   // singular (default-constructed) iterator
a[5];                                     // out of range (assertions mode)
a.erase(a.end(), a.begin());              // inverted range
std::lower_bound(a.begin(), a.end(), 3);  // unsorted range (pedantic/debug)
std::sort(v.begin(), v.end(), [](auto x, auto y){ return x <= y; });  // NOT a strict weak
                                          // ordering → UB; libc++ DEBUG diagnoses it
```

```text
/usr/include/c++/13/debug/safe_iterator.h:373:
Error: attempt to dereference a past-the-end iterator.
Objects involved in the operation:
    iterator "this" @ 0x7ffd1234 {
      type = __gnu_debug::_Safe_iterator<...>  (mutable iterator);
      state = past-the-end;
      references sequence with type 'std::__debug::vector<int>' @ 0x7ffd1250
    }
```

```cpp
// ---- checked access is API, not a build mode -----------------------------
v[i];               // precondition i < size(); UB otherwise — hardening may catch it
v.at(i);            // ALWAYS throws std::out_of_range — portable semantics
sp.first<4>();      // std::span, C++20 — extent checked at compile time
sp.subspan(o, c);   // precondition; UB on overflow
std::to_underlying(e);  // C++23, <utility> — no enum-range check
// Prefer at()/span/ranges for *semantics*; use hardening as extra DETECTION.

// ---- assertions you author ----------------------------------------------
#include <cassert>
assert(head_ - tail_ <= capacity_);      // disabled by NDEBUG
#define QS_ASSERT(c) ((c) ? void() : ::qs::fail(#c, std::source_location::current()))
static_assert(std::is_trivially_copyable_v<Tick>);   // compile time, always on
```

**Traps** — `_GLIBCXX_DEBUG` changes `std::vector`'s layout: linking one debug TU against a release `.so` that passes containers is silent ODR corruption, not a link error · Boost, gtest, and any prebuilt library must be rebuilt with the same macro · `_ITERATOR_DEBUG_LEVEL` must match `/MD` vs `/MDd` or you get link errors (which is the *good* case) · debug mode is not a sanitizer: it checks library preconditions, not raw pointers · debug-only success usually means the release build has UB that debug initialization masked.

---

## 44.7 Core dumps, stack traces, symbols, and post-mortem debugging

```bash
# ---- enable and locate cores -------------------------------------------
ulimit -c unlimited
cat /proc/sys/kernel/core_pattern            # often piped to systemd-coredump/apport
sysctl -w kernel.core_pattern='/tmp/core.%e.%p.%t'
coredumpctl list; coredumpctl gdb 4242       # systemd systems
# macOS: cores land in /cores; needs `ulimit -c unlimited` + codesign entitlement

# ---- split debug info: ship stripped, keep symbols ----------------------
g++ -g -O2 app.cpp -o app
objcopy --only-keep-debug app app.debug
objcopy --strip-debug --add-gnu-debuglink=app.debug app
# or in one step:
g++ -g -O2 -gsplit-dwarf app.cpp -o app      # emits app.dwo
readelf -n app | grep -A2 'Build ID'         # the identity that must match the core

# ---- symbolize a raw sanitizer/backtrace address list -------------------
llvm-symbolizer --obj=./app 0x4f13a0 0x4f1500
addr2line -e ./app -f -C -i 0x4f13a0         # -i: expand inlined frames
eu-stack -p 4242                             # live process backtrace (elfutils)
gdb -p 4242 -batch -ex "thread apply all bt full"
```

| gdb | lldb | Purpose |
|---|---|---|
| `gdb ./app core.4242` | `lldb ./app -c core.4242` | open a core |
| `bt` / `bt full` / `bt -20` | `bt` / `bt all` | backtrace, with locals |
| `thread apply all bt` | `thread backtrace all` | every thread |
| `frame 3` / `up` / `down` | `frame select 3` / `up` / `down` | move in the stack |
| `info locals` / `info args` | `frame variable` | frame state |
| `p expr` / `p/x` / `p *this` | `expression expr` / `p` | evaluate |
| `ptype T` / `p sizeof(T)` | `type lookup T` | type layout |
| `x/16xb ptr` | `memory read -c16 -fx -s1 ptr` | hex dump |
| `b file.cpp:42` / `b Cls::fn` | `b -f file.cpp -l 42` / `b -n Cls::fn` | breakpoint |
| `b f if qty > 100` | `b -n f -c 'qty > 100'` | conditional breakpoint |
| `tbreak` | `br set -o true -n f` | one-shot breakpoint |
| `watch obj.seq` | `watchpoint set variable obj.seq` | **data breakpoint on write** |
| `rwatch` / `awatch` | `watchpoint set expression -w read` | read / read-write watch |
| `catch throw` / `catch catch` | `br set -E c++` | break on C++ exception |
| `info watchpoints` / `delete N` | `watchpoint list` / `br delete N` | manage |
| `n` / `s` / `fin` / `c` / `u 60` | `n` / `s` / `finish` / `c` | stepping |
| `set var x = 5` | `expr x = 5` | mutate state |
| `info threads` / `thread 3` | `thread list` / `thread select 3` | threads |
| `info sharedlibrary` | `image list` | loaded modules + load addresses |
| `info symbol 0x4f13a0` | `image lookup -a 0x4f13a0` | address → symbol/line |
| `disassemble /s` | `disassemble -m` | asm interleaved with source |
| `info registers` / `p $rsp` | `register read` | registers |
| `set follow-fork-mode child` | `settings set target.process.follow-fork-mode child` | debug the child |
| `set scheduler-locking on` | `settings set target.process.thread.step-avoid...` | freeze other threads while stepping |
| `record` / `reverse-continue` | (rr) | reverse execution |
| `p $_siginfo` | `p (siginfo_t)$_siginfo` | fault address on SIGSEGV |
| `generate-core-file` | `process save-core` | dump a live process |

```bash
# ---- the highest-leverage post-mortem workflow ---------------------------
rr record ./app --seed 12345          # deterministic record (Linux, Intel/AMD)
rr replay                             # then: reverse-continue, reverse-step, watch
# In gdb under rr: `watch -l corrupt.field` then `reverse-continue`
#   → lands exactly on the instruction that wrote the bad value.

gdb -q ./app -ex 'set pagination off' \
  -ex 'b OrderBook::apply if order.id == 998877' -ex run
```

```cpp
// ---- std::stacktrace (C++23) --------------------------------------------
#include <stacktrace>
#include <print>
// link: g++ -std=c++23 app.cpp -lstdc++exp     (libstdc++ 14+)
//       clang++ -std=c++23 app.cpp -lstdc++_libbacktrace  (varies)
void dump() {
    auto st = std::stacktrace::current();          // whole stack
    auto s2 = std::stacktrace::current(1);         // skip 1 innermost frame
    auto s3 = std::stacktrace::current(1, 16);     // skip 1, keep 16
    std::println("{}", st);                        // formatter provided
    for (auto const& f : st)
        std::println("{} @ {}:{}", f.description(), f.source_file(), f.source_line());
}
```

| `std::stacktrace_entry` member | Returns |
|---|---|
| `description()` | implementation-defined function description (`std::string`) |
| `source_file()` | file name, empty if unavailable |
| `source_line()` | line number, `0` if unavailable |
| `native_handle()` | implementation-defined address (`std::uint_least64_t`) |
| `explicit operator bool()` | true if the entry is non-empty |
| `std::to_string(entry/trace)`, `operator<<`, `std::formatter` | text forms |

```cpp
// ---- std::source_location (C++20): the caller's site, for free ----------
#include <source_location>
void log(std::string_view msg,
         std::source_location loc = std::source_location::current()) {  // caller's site
    std::println("{}:{}:{} {}: {}", loc.file_name(), loc.line(),
                 loc.column(), loc.function_name(), msg);
}
// members: file_name() line() column() function_name(); all constexpr, C++23 adds
// consteval-friendly usage. Capturing it inside the body gives log()'s own site.

// ---- assertion macro that reports the CALLER ----------------------------
struct Check {
    bool ok; std::source_location loc;
    Check(bool v, std::source_location l = std::source_location::current())
        : ok(v), loc(l) {}
};
void require(Check c) { if (!c.ok) throw std::runtime_error(fmt_loc(c.loc)); }
```

```cpp
// ---- crash handler: async-signal-safe only ------------------------------
extern "C" void on_fatal(int sig, siginfo_t* si, void*) {
    // ALLOWED: write(2), _exit(2), pre-formatted buffers, atomic loads.
    // FORBIDDEN: malloc/new, printf, std::mutex, iostreams, std::stacktrace
    //            (it allocates and may deadlock after heap corruption).
    static char const msg[] = "FATAL\n";
    ::write(2, msg, sizeof msg - 1);
    ::signal(sig, SIG_DFL);          // restore default...
    ::raise(sig);                    // ...so the kernel writes a real core dump
}
// Install with sigaltstack() so a stack overflow can still be handled.
```

| Post-mortem obstacle | Consequence | Mitigation |
|---|---|---|
| Stripped binary | addresses only | keep `.debug` with a matching Build ID |
| Build-ID mismatch | wrong line numbers, silently | verify `readelf -n` against the core |
| ASLR / PIE | raw addresses meaningless | symbolize with load bias; gdb handles it from the core |
| Inlining | frames missing | `addr2line -i`, `bt` with `-fno-omit-frame-pointer` |
| Tail calls | caller frame absent | build with `-fno-optimize-sibling-calls` for the repro |
| `<optimized out>` locals | cannot inspect | `-Og`, or `-fvar-tracking-assignments` |
| LTO | function boundaries dissolved | reproduce with `-fno-lto` |
| Hardware watchpoint limit (4 on x86) | `watch` silently degrades to software (1000× slower) | narrow the window with rr/replay first |
| Truncated core (`RLIMIT_CORE`) | unreadable | `ulimit -c unlimited`, tune `coredump_filter` |

**Traps** — `std::stacktrace` availability and cost vary wildly; it is not signal-safe · the crash site is usually *downstream* of the bad write — trace ownership backward · a debugger shows the optimized realization, not the abstract machine · breakpoints change scheduling, so "the race vanished under gdb" proves nothing · always `raise(sig)` after a handler so a core is still produced.

---

## 44.8 Sanitizer incompatibilities and representative build matrices

| Build | Flags | Purpose | Overhead |
|---|---|---|---|
| Warnings | `-O2 -Wall -Wextra -Wconversion -Werror` | every commit, 2 compilers | none |
| Debug + hardened lib | `-Og -g -D_GLIBCXX_ASSERTIONS` (or `_LIBCPP_HARDENING_MODE=…EXTENSIVE`) | unit/integration tests | ~1.1× |
| ASan+UBSan+LSan | `-O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all` | memory/lifetime/UB, fuzz targets | 2–3× CPU, 3× RAM |
| TSan | `-O1 -g -fsanitize=thread` (separate binary) | concurrency stress, reduced iterations | 5–15× CPU, 5–10× RAM |
| MSan | `-O1 -g -fsanitize=memory -fsanitize-memory-track-origins=2` + instrumented libc++ | initializedness | 3× CPU |
| Fuzzing | `-O1 -g -fsanitize=fuzzer,address,undefined` | input-space coverage | — |
| Coverage | `-fprofile-instr-generate -fcoverage-mapping` | prove which paths the above actually ran | — |
| Release-like repro | `-O2 -DNDEBUG -flto -g` symbols split off | reproduction + latency | 1× |

```bash
# ---- CMake: one option per sanitizer, never combined blindly -------------
option(QS_SANITIZER "address|thread|memory|undefined|none" "none")
if(QS_SANITIZER STREQUAL "address")
  add_compile_options(-fsanitize=address,undefined -fno-sanitize-recover=all
                      -fno-omit-frame-pointer -g -O1)
  add_link_options(-fsanitize=address,undefined)
elseif(QS_SANITIZER STREQUAL "thread")
  add_compile_options(-fsanitize=thread -fno-omit-frame-pointer -g -O1)
  add_link_options(-fsanitize=thread)
endif()
# ALWAYS mirror compile flags into link flags — a missing link flag gives
# "undefined reference to __asan_report_load4".

# ---- fuzz target with all the right knobs --------------------------------
clang++ -std=c++23 -g -O1 -fsanitize=fuzzer,address,undefined \
        -fno-sanitize-recover=all -fprofile-instr-generate -fcoverage-mapping \
        fuzz_decode.cpp decoder.cpp -o fuzz_decode
./fuzz_decode corpus/ -max_total_time=300 -rss_limit_mb=4096 -timeout=10 \
              -detect_leaks=1 -print_final_stats=1
./fuzz_decode crash-8f3a...                 # replay one crashing input
llvm-profdata merge -sparse default.profraw -o f.profdata
llvm-cov show ./fuzz_decode -instr-profile=f.profdata decoder.cpp
```

```cpp
// ---- default options compiled into the binary (no env var needed) -------
extern "C" __attribute__((used)) char const* __asan_default_options() {
    return "detect_leaks=1:abort_on_error=1:strict_string_checks=1"
           ":detect_stack_use_after_return=1:check_initialization_order=1";
}
extern "C" __attribute__((used)) char const* __lsan_default_suppressions() {
    return "leak:third_party_cache_init\n";
}
extern "C" __attribute__((used)) char const* __ubsan_default_options() {
    return "print_stacktrace=1:halt_on_error=1";
}
extern "C" __attribute__((used)) char const* __tsan_default_options() {
    return "halt_on_error=1:second_deadlock_stack=1:history_size=7";
}
// Env ASAN_OPTIONS still overrides these; ASAN_DEFAULT_OPTIONS is the weaker default.
```

**Compatibility checklist**

- Compile **and** link every TU with the identical `-fsanitize=` set; a partly instrumented binary reports garbage.
- ASan+UBSan and TSan+UBSan combine; ASan+TSan and MSan+anything do not.
- Runtime library version must match the compiler that instrumented the code (`clang-18` objects + `clang-17` runtime = undefined symbols or crashes).
- macOS: LSan is off by default; TSan/MSan support is partial; codesign/entitlements affect cores.
- Custom allocators, `fork()` without `exec`, `longjmp`, hand-written asm, and signal handlers all need explicit handling or annotation.
- Set `ulimit -v unlimited` and disable `RLIMIT_AS`; sanitizers reserve terabytes of virtual address space.
- Never link instrumented objects into an ordinary ABI: `-fsanitize=address` changes calling behavior around locals, and `_GLIBCXX_DEBUG` changes container layout.
- Suppress only *proven* false positives, in a file, with a comment naming the ticket — never a global `no_sanitize` on a whole file.

```text
Workflow — corrupted hot-path state
1  preserve binary + Build ID + symbols + input capture + full build config
2  reproduce deterministically (fixed seed, recorded input, rr record)
3  assert the invariant EARLIER so detection moves toward the cause
4  classify: bounds/lifetime → ASan | arithmetic/UB → UBSan
             race → TSan     | garbage values → MSan | logic → assertions+replay
5  binary-search the replay prefix for the first failing event N
6  watchpoint the first WRITE to the corrupted field (rr + reverse-continue)
7  fix the ownership/state invariant, not the crash site
8  add a minimal deterministic regression + a broad stress replay
9  rerun the full matrix, then a release-like optimized replay
```

**Interview line** — "A clean sanitizer run means no *enabled* check fired on the paths that particular instrumented binary actually executed; sanitizers are dynamic evidence, and only proofs, exhaustive tests, or the type system give absence."

**Traps** — benchmarking a sanitizer build and reporting the latency · fixing the last report instead of the first · a global suppression that hides tomorrow's real bug · assuming `-fsanitize=undefined` covers strict aliasing or lifetime · concluding "no race" from a TSan run that never hit the interleaving · shipping `-Werror` to downstream consumers.
