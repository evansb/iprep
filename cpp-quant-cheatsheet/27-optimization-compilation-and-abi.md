# 27. Optimization, compilation, and ABI

*Part IV — Memory, representation, and performance*

---

**Recall**
- The as-if rule lets an implementation emit anything whose *observable behavior* matches the abstract machine; source statements are not instructions.
- Observable behavior = volatile accesses, I/O through standard facilities, atomic/synchronization effects, and program termination — everything else is fair game to delete or reorder.
- The optimizer assumes UB never occurs, so a check placed *after* the UB (null test after a dereference, bounds test after a subscript) may legally vanish.
- Signed overflow, out-of-bounds, use-after-free, data races, strict-aliasing violations, and misalignment are all *premises*, not merely "bugs that might crash".
- Optimization levels (`-O0/-O1/-O2/-O3/-Os/-Oz/-Og`) are toolchain policy, not C++ language modes; the standard never mentions them.
- `-ffast-math` and friends change the *semantic contract* (no NaN/Inf, reassociation allowed, FTZ/DAZ set globally by a linked object) — record them or your "release" build is undefined.
- `inline` is an ODR facility (multiple identical definitions permitted, entity gets vague linkage); machine-code inlining is an unrelated optimizer decision.
- Devirtualization is *possible* with `final`, visible dynamic type, or LTO — never *promised*; heterogeneous call sites keep the indirect branch legitimately.
- LTO defers codegen to link time so the optimizer sees across TUs; PGO feeds measured branch/call frequencies into layout, inlining, and cloning.
- A PGO profile trained on a happy-path microbenchmark can pessimize the rare, latency-critical recovery path — validate on held-out workloads and tails.
- Name mangling, calling conventions, vtable layout, and exception unwind are Itanium/MSVC ABI, not ISO C++; `extern "C"` fixes only the symbol name and function type, not layout or ownership.
- Hidden visibility (`-fvisibility=hidden` + explicit export macros) shrinks the dynamic symbol table, kills interposition, and enables internalization/devirtualization.
- Adding, removing, or reordering non-static data members changes `sizeof`/offsets and breaks shared-library ABI; pImpl freezes the public size at one pointer.
- pImpl costs one allocation, one indirection, out-of-line special members, and total loss of inlining — good for a subsystem handle, bad for a hot per-event type.
- `extern template` suppresses implicit instantiation in consumers; exactly one `template class X<T>;` definition must exist or you get a link error.
- `std::unreachable()` (C++23) is UB if reached; `[[assume(expr)]]` (C++23) is an *unevaluated* premise whose falsity is UB — neither is a runtime check.
- Assembly answers "what did this exact build emit", never "is this fast"; keep compiler, version, triple, flags, and calling context attached to every conclusion.
- Sanitizers are dynamic instrumentation over executed paths: clean ASan/UBSan/TSan runs are evidence, not proof, and sanitizer throughput is not production throughput.
- Reproducible builds require pinning compiler/linker/libstdc++/flags/profile data and purging `__DATE__`, `__TIME__`, absolute paths, and unstable ordering.
- Performance claims are only meaningful bound to source revision, compiler+version, flags, libraries, target, workload, and environment.

---

## 27.1 The as-if rule and observable behavior

```cpp
// ---- what the optimizer is allowed to do ------------------------------
int square_then_add(int x) noexcept {
    int y = x * x;      // y need never exist in a register or on the stack
    return y + 3;       // may become lea/imul pair, or fold entirely at a call site
}

int unused(int x) {
    int y = expensive(x);   // deleted IF expensive() is provably side-effect-free
    (void)y;
    return 0;
}
```

```cpp
// ---- observable behavior: the four categories --------------------------
volatile int mmio;                 // 1. volatile glvalue access: count & order preserved
mmio = 1;                          //    exactly one store, not merged with the next
mmio = 2;                          //    exactly one store, not reordered w.r.t. above

std::fputs("x", stdout);           // 2. I/O through standard facilities
std::atomic<int> a{0};
a.store(1, std::memory_order_release);  // 3. atomic/synchronization side effects
std::exit(0);                      // 4. termination and externally visible results
// NOT observable: stack traffic, register choice, instruction order of pure ops,
// intermediate temporaries, allocation elision (P0593/[expr.new] allows merging).
```

```cpp
// ---- volatile is NOT atomic and NOT a fence ---------------------------
volatile int flag = 0;   // no cross-thread ordering, no atomicity, may tear
std::atomic<int> ok{0};  // the correct tool for inter-thread communication
// volatile: "this access is observable"; atomic: "this access participates in
// the happens-before graph".
```

```cpp
// ---- UB timing: the check is too late ---------------------------------
int f(int* p) {
    int x = *p;                 // premise: p points to a live int
    if (p == nullptr) return 0; // DEAD: no defined execution reaches here with p==null
    return x;
}
// Fix: check first.
int g(int* p) { return p ? *p : 0; }
```

```cpp
// ---- benchmark dead-code elimination ----------------------------------
for (std::size_t i = 0; i != n; ++i)
    auto r = decode(input);          // whole loop may be deleted

// google/benchmark: force the value to be considered observable
for (auto _ : state) {
    auto r = decode(input);
    benchmark::DoNotOptimize(r);     // "assume r escapes to memory"
    benchmark::ClobberMemory();      // "assume all memory was written"
}

// Hand-rolled equivalent (GCC/Clang, inline asm, non-portable):
template<class T>
inline void do_not_optimize(T const& v) {
    asm volatile("" : : "r,m"(v) : "memory");   // value escapes + memory clobber
}
inline void clobber() { asm volatile("" : : : "memory"); }
```

| Construct | Preserved? | Why |
|---|---|---|
| `volatile` load/store | count + relative order | abstract-machine observable |
| `std::atomic` op | order per memory model | synchronization side effect |
| `printf` / `ostream` write | yes | I/O facility |
| Non-`volatile` local write | no | not observable |
| `new`/`delete` pair | may be elided/merged | [expr.new] allowance |
| Copy of a returned prvalue | mandatory elision (C++17) | no copy exists to preserve |
| Infinite loop with no side effects | may be assumed to terminate | [intro.progress] forward progress |
| Signal-unsafe reordering | target-dependent | outside abstract machine |

**Traps** — `volatile` is not thread synchronization · a loop whose body has no observable effect may be deleted entirely, including an intentional spin · marking the *pointer* volatile is not the same as marking the *pointee* volatile · empty infinite loops are UB in C++ (unlike C) unless they have volatile/atomic/IO effects.

**Interview line** — "The as-if rule says the implementation may do anything at all, provided the defined observable behavior of the abstract machine is preserved."

---

## 27.2 Optimization levels, debug/release differences, and UB exploitation

```bash
# GCC / Clang
-O0     # no optimization; every variable has a stack slot; fastest compile, best debugging
-O1     # cheap local optimizations, no big code-size growth
-O2     # the production default: inlining, GVN, SROA, vectorization, loop transforms
-O3     # -O2 + more aggressive vectorization/unrolling/inline thresholds (can be slower)
-Os     # -O2 tuned for size
-Oz     # aggressive size (Clang; GCC has -Oz since 12)
-Og     # optimize but keep debuggability — the correct "debug build" for realistic timing
-g      # DWARF debug info; ORTHOGONAL to -O — always ship -O2 -g and split symbols
-fno-omit-frame-pointer   # keeps profilers/unwinders honest, costs ~1 register
-march=native -mtune=native   # target features; breaks portability of the binary
-fno-exceptions -fno-rtti     # ABI-affecting dialect changes, not "optimizations"
```

```bash
# MSVC
/Od  /O1  /O2  /Ob2  /GL (LTCG)  /Oi (intrinsics)  /Zi (PDB)  /GR- (no RTTI)  /EHsc
```

```cpp
// ---- what actually differs between -O0 and -O2 ------------------------
// inlining · dead store/code elimination · vectorization · unrolling
// loop rotation/invariant hoisting · register allocation vs stack slots
// frame-pointer omission · tail-call conversion · constant folding
// assert() compiled out by NDEBUG · _GLIBCXX_ASSERTIONS / _ITERATOR_DEBUG_LEVEL
// libstdc++ debug mode ABI change · allocator fill patterns
// timing shifts that expose or hide races
```

```cpp
// ---- UB as optimization input: signed overflow ------------------------
bool always_true(int x) { return x + 1 > x; }   // may compile to `mov eax,1`
// INT_MAX + 1 is UB, so the optimizer proves the inequality.

unsigned wrap(unsigned x) { return x + 1; }      // defined: modulo 2^N
int checked(int x) {
    int r;
    if (__builtin_add_overflow(x, 1, &r)) return INT_MAX;   // GCC/Clang builtin
    return r;
}
// C++26 has <numeric> saturating ops; today: cast to unsigned, or use builtins.
```

```cpp
// ---- UB: out-of-bounds and lifetime -----------------------------------
int read(std::span<int const> v, std::size_t i) {
    int x = v[i];                    // premise: i < v.size()
    if (i >= v.size()) return 0;     // may be deleted
    return x;
}

int const& dangle() { int local = 1; return local; }  // UB on use; may "work" at -O0
```

```cpp
// ---- UB: strict aliasing ----------------------------------------------
float bad(int& i) { return *reinterpret_cast<float*>(&i); }  // UB: type punning
float good(int i) { return std::bit_cast<float>(i); }        // C++20, defined
float ok2(int i)  { float f; std::memcpy(&f, &i, sizeof f); return f; }  // defined
// -fno-strict-aliasing suppresses ONE class of exploitation; it does not fix
// alignment, lifetime, race, or overflow UB.
```

```cpp
// ---- UB: data race ----------------------------------------------------
int counter = 0;
void t1() { ++counter; }   // unsynchronized conflicting access from 2 threads = UB
std::atomic<int> ok_counter{0};
void t2() { ok_counter.fetch_add(1, std::memory_order_relaxed); }
```

| Flag | Contract change | Risk |
|---|---|---|
| `-ffast-math` | implies the six below | non-conforming FP; `isnan` may fold to false |
| `-ffinite-math-only` | assumes no NaN/Inf | comparisons/guards deleted |
| `-fno-signed-zeros` | `-0.0 == 0.0` interchangeable | sign-of-zero logic breaks |
| `-freciprocal-math` | `a/b` → `a * (1/b)` | accuracy loss |
| `-fassociative-math` | reassociates FP sums | non-reproducible reductions |
| `-ffp-contract=fast` | forms FMA freely | different rounding (default in GCC) |
| `-funsafe-math-optimizations` | umbrella | as above |
| `-fno-strict-aliasing` | disables TBAA | slower; hides not fixes UB |
| `-fwrapv` | signed overflow = 2's complement | disables a real optimization class |
| `-ftrapv` | traps on signed overflow | runtime cost, aborts |
| `-fno-semantic-interposition` | own symbols not interposable | breaks `LD_PRELOAD` patching |
| `-fno-plt` | direct calls into shared libs | requires no interposition |

```bash
# Gotcha: linking any object built with -ffast-math pulls in crtfastmath.o on
# GCC/x86, which sets FTZ/DAZ in MXCSR for the WHOLE process at startup.
```

**Traps** — an optimized-only failure is evidence of UB/race/ODR/ABI, not of a broken optimizer · `-O0` timings predict nothing · `NDEBUG` silently removes `assert` and any side effects inside it · `-D_GLIBCXX_DEBUG` changes libstdc++ ABI so every TU and library must agree · `-march=native` on a build machine produces `SIGILL` on an older production host.

---

## 27.3 Inlining, LTO, PGO, and devirtualization

```cpp
// ---- inline is an ODR facility ----------------------------------------
inline int add_ticks(int a, int b) noexcept { return a + b; }
// Effects: (1) definition may appear in every TU, must be token-identical;
//          (2) entity gets vague/COMDAT linkage, linker folds copies;
//          (3) ONE address across the program; static locals are shared.
inline constexpr int k = 42;      // C++17 inline variable — one object program-wide
// Implicitly inline: member functions defined in-class, constexpr functions,
// templates (not "inline" but similarly ODR-relaxed), C++20 module-linkage rules differ.
```

```cpp
// ---- forcing / forbidding, all non-standard ---------------------------
[[gnu::always_inline]] inline int hot(int x) { return x * 3; }   // GCC/Clang attr
__attribute__((always_inline)) inline int hot2(int x);           // classic spelling
[[gnu::noinline]]      int cold(int x);                          // keep out of line
[[gnu::flatten]]       int wrapper();     // inline everything it calls, recursively
[[msvc::forceinline]]  int hot3(int x);   // MSVC attribute spelling (C++20 style)
__forceinline int hot4(int x);            // MSVC keyword
__declspec(noinline) int cold2(int x);    // MSVC
[[gnu::hot]] void fast_path();            // layout hint: put in .text.hot
[[gnu::cold]] void error_path();          // layout hint + assumes rarely taken
[[likely]] / [[unlikely]]                 // C++20 standard branch hints (on statements)
```

```cpp
if (x == 0) [[unlikely]] { handle_error(); }   // C++20
else        [[likely]]   { fast(); }
// or the GCC builtin, still common:
if (__builtin_expect(x == 0, 0)) handle_error();
if (__builtin_expect_with_probability(c, 1, 0.99)) hot();   // GCC 9+
```

| Inlining enables | Inlining costs |
|---|---|
| constant propagation into the body | duplicated code, larger `.text` |
| removal of call/prologue/epilogue | i-cache and iTLB pressure |
| SROA: struct fields → registers | branch-predictor table pressure |
| bounds/null-check elimination | register pressure → spills |
| escape analysis, allocation removal | compile-time blowup |
| devirtualization then more inlining | worse profiler attribution |

```cpp
// ---- devirtualization ---------------------------------------------------
struct Handler { virtual void on(int) = 0; virtual ~Handler() = default; };

struct Counter final : Handler {          // `final` on the CLASS: no further override
    void on(int x) override { total += x; }
    int total{};
};
struct Base2 { virtual void f() final; };  // `final` on the FUNCTION

void direct() {
    Counter c;          // exact dynamic type visible → call devirtualized + inlined
    c.on(1);
}
void via_ref(Counter& c) { c.on(1); }         // `final` class → devirtualizable
void via_base(Handler& h) { h.on(1); }        // indirect call; LTO/PGO may speculate
// Speculative devirtualization (PGO): if (vptr == &Counter_vtable) inlined_body;
//                                     else indirect_call;
```

```bash
# ---- LTO -----------------------------------------------------------------
g++   -O2 -flto=auto -fuse-linker-plugin -c a.cpp b.cpp
g++   -O2 -flto=auto a.o b.o -o app          # SAME flags at compile AND link
clang++ -O2 -flto=thin -c a.cpp              # ThinLTO: parallel, incremental, cacheable
clang++ -O2 -flto=thin -Wl,--thinlto-cache-dir=.lto-cache a.o b.o -o app
clang++ -O2 -flto        # "full"/monolithic LTO: best info, worst link time/memory
cl /GL a.cpp b.cpp /link /LTCG               # MSVC
ar rcs lib.a a.o  →  use gcc-ar / llvm-ar    # plain ar loses the LTO plugin index
```

| LTO benefit | LTO cost/risk |
|---|---|
| cross-TU inlining and constant propagation | long, memory-hungry serial link (full LTO) |
| whole-program dead code/data elimination | build caches and distcc lose effectiveness |
| devirtualization with global class hierarchy | plugin/version mismatch (`gcc-ar`, `lld`) |
| symbol internalization → better regalloc | debug info and profile attribution degrade |
| ICF-style body merging | one bad inline decision inflates code size |

```bash
# ---- PGO: instrumentation-based ------------------------------------------
clang++ -O2 -fprofile-generate=prof.d app.cpp -o app.inst
./app.inst  <representative workload>            # writes prof.d/*.profraw
llvm-profdata merge -output=app.profdata prof.d/*.profraw
clang++ -O2 -fprofile-use=app.profdata app.cpp -o app

# GCC
g++ -O2 -fprofile-generate app.cpp -o app.inst && ./app.inst
g++ -O2 -fprofile-use -fprofile-correction app.cpp -o app

# ---- PGO: sampling-based (no instrumented build) -------------------------
perf record -b -e cycles:u -- ./app             # LBR/branch stacks
create_llvm_prof --binary=./app --out=app.prof  # AutoFDO
clang++ -O2 -fprofile-sample-use=app.prof app.cpp -o app

# ---- post-link layout ----------------------------------------------------
llvm-bolt ./app -o ./app.bolt -data=perf.fdata -reorder-blocks=ext-tsp \
          -reorder-functions=hfsort -split-functions -icf=1
```

| PGO decision improved | Failure mode |
|---|---|
| branch probabilities / block layout | profile trained only on the happy path |
| hot/cold function splitting | rare recovery path becomes cold and slow |
| indirect-call promotion (speculative devirt) | production type mix differs from training |
| inlining thresholds per call site | stale profile after refactor (silent, no error) |
| loop unroll/peel counts | training run too short to reach steady state |
| register allocation, spill placement | instrumented build too slow to run realistically |

**Traps** — `inline` never guarantees machine inlining and `always_inline` can *hurt* a hot loop via i-cache pressure · LTO requires identical flags at compile and link and `gcc-ar`/`llvm-ar` for static archives · a `-fprofile-use` build silently ignores a stale profile · `final` helps devirtualization only when the static type is the final class or below it · defining a virtual function in every TU still leaves the vtable emitted in the TU of the first non-inline virtual (the "key function") on Itanium ABI.

**Interview line** — "LTO gives the optimizer visibility across translation units; PGO gives it measured frequencies — one changes what it can see, the other what it believes."

---

## 27.4 Symbol visibility, name mangling, and calling conventions

```cpp
// ---- mangling encodes namespace, name, and parameter types --------------
namespace qs {
    void decode(std::span<std::byte const>);
    void decode(std::string_view);
    template<class T> T load(T const&);
}
// _ZN2qs6decodeESt4spanIKSt4byteLm18446744073709551615EE   (Itanium)
// Return type is NOT mangled for ordinary functions (it IS for templates).
// cv/ref-qualifiers, noexcept (since C++17, part of the type), and template
// arguments all participate.
```

```bash
c++filt _ZN2qs6decodeESt17basic_string_viewIcSt11char_traitsIcEE   # demangle
nm -C --defined-only libqs.so | head          # -C = demangle
nm -D --defined-only libqs.so                 # dynamic symbol table only
readelf -Ws libqs.so | grep GLOBAL            # binding + visibility columns
objdump -T libqs.so                           # dynamic symbols with versions
```

```cpp
// ---- runtime demangling -------------------------------------------------
#include <cxxabi.h>
#include <typeinfo>
int status{};
char* n = abi::__cxa_demangle(typeid(x).name(), nullptr, nullptr, &status);
std::string pretty = n ? n : typeid(x).name();
std::free(n);
```

```cpp
// ---- extern "C": language linkage ---------------------------------------
extern "C" int qs_decode(void const* data, std::size_t size) noexcept;  // unmangled
extern "C" {                       // block form
    struct qs_buffer { unsigned char* data; std::size_t size; };
    int qs_load(qs_buffer out, std::size_t* written) noexcept;
}
extern "C++" void cpp_linkage();   // the default; useful inside an extern "C" block

// What extern "C" DOES: unmangled symbol name + C function type/calling convention.
// What it does NOT do: overloading (one symbol per name), templates, exceptions
// across the boundary, class layout portability, integer-width or endianness
// agreement, ownership rules, or a stable struct ABI.
```

```cpp
// ---- exceptions must not escape a C boundary ---------------------------
extern "C" int qs_apply(void* h, void const* ev) noexcept {   // noexcept → terminate
    try { static_cast<Book*>(h)->apply(*static_cast<Event const*>(ev)); return 0; }
    catch (std::exception const&) { return -1; }              // translate to codes
    catch (...) { return -2; }
}
```

```cpp
// ---- visibility: the portable export macro ------------------------------
#if defined(_WIN32)
#  ifdef QS_BUILDING
#    define QS_API __declspec(dllexport)
#  else
#    define QS_API __declspec(dllimport)
#  endif
#  define QS_LOCAL
#else
#  define QS_API   __attribute__((visibility("default")))
#  define QS_LOCAL __attribute__((visibility("hidden")))
#endif

class QS_API Book { /* ... */ };            // exports vtable, typeinfo, members
QS_API void qs_init();
QS_LOCAL void internal_helper();

// Or scope it:
#pragma GCC visibility push(hidden)
void helper();
#pragma GCC visibility pop
namespace [[gnu::visibility("hidden")]] detail { void h(); }   // attribute on namespace
```

```bash
-fvisibility=hidden               # default everything to hidden; opt in via QS_API
-fvisibility-inlines-hidden       # inline member fns hidden (huge .dynsym reduction)
-Wl,--exclude-libs,ALL            # do not re-export symbols from static archives
-Wl,--version-script=qs.map       # explicit exported surface + symbol versioning
-Wl,--gc-sections -ffunction-sections -fdata-sections   # drop unreferenced sections
-Wl,--icf=all                     # identical code folding (lld/gold)
```

```text
# qs.map — version script
QS_1.0 { global: qs_*; local: *; };
QS_1.1 { global: qs_new_api; } QS_1.0;
```

| Visibility / binding | Meaning | Effect |
|---|---|---|
| `default` | exported, interposable | full `.dynsym` entry, PLT/GOT call |
| `hidden` | not in dynamic table | direct call, internalizable, devirtualizable |
| `internal` | hidden + never referenced externally | strongest, rarely needed |
| `protected` | exported but not interposable | fragile/buggy on some toolchains |
| weak symbol | may be overridden at link | inhibits many optimizations |
| `static` / anon namespace | internal linkage in the TU | best for TU-local helpers |

```cpp
// ---- interposition inhibits optimization --------------------------------
// A default-visibility function in a shared object may be replaced (LD_PRELOAD,
// or an earlier object in link order), so the compiler cannot inline it or
// assume its body — even within the same .so. Cures: hidden visibility,
// -fno-semantic-interposition, or an anonymous-namespace/static definition.
```

```cpp
// ---- calling conventions (all non-standard, all target-specific) --------
// SysV AMD64: integer args RDI RSI RDX RCX R8 R9, FP args XMM0-7, return RAX:RDX /
//   XMM0:XMM1, callee-saved RBX RBP R12-R15, 16-byte stack alignment at call,
//   128-byte red zone below RSP in leaf functions.
// Win64: RCX RDX R8 R9 / XMM0-3, 32-byte shadow space, no red zone,
//   >8-byte or non-power-of-2 aggregates passed BY HIDDEN POINTER.
// AAPCS64: X0-X7 / V0-V7, X8 indirect result register.

void __cdecl a();      void __stdcall b();     // MSVC x86 only
void __fastcall c();   void __vectorcall d();
[[gnu::sysv_abi]] void e();   [[gnu::ms_abi]] void f();   // GCC/Clang x86-64
[[gnu::regparm(3)]] void g(); // i386 only
```

```cpp
// ---- how the ABI classifies a return value -----------------------------
struct P2 { double x, y; };      // 16 bytes, SSE class → returned in XMM0:XMM1
struct P3 { double x, y, z; };   // 24 bytes → MEMORY class: hidden sret pointer
struct NT { NT(NT const&); double x; };  // non-trivially-copyable → ALWAYS memory
// A user-provided copy ctor/dtor changes the return convention. This is why
// adding a destructor to a POD-like struct is an ABI break.
```

**Traps** — `extern "C"` functions cannot be overloaded and only the *name* is C-compatible · a class exported with `__declspec(dllexport)` exports its inline members and pins their bodies into the ABI · `-fvisibility=hidden` without export macros yields "undefined symbol" only at *load* time for lazily-bound symbols · `protected` visibility is subtly broken on GNU/Linux, prefer `hidden` + explicit exports · symbol versioning must be added *before* the first release or it is useless.

---

## 27.5 ABI stability, pImpl, and shared-library boundaries

```cpp
// ---- what changes shared-library ABI -----------------------------------
class Book {
public:
    void apply(Event const&);
private:
    std::vector<Level> levels_;   // sizeof(Book) and the layout of libstdc++'s
};                                // vector are both baked into every caller
```

| Change | Source-compatible | ABI-compatible |
|---|---|---|
| Add/remove/reorder non-static data member | maybe | **no** (`sizeof`, offsets) |
| Change a member's type | maybe | **no** |
| Add a virtual function | yes | **no** (vtable slots shift) |
| Reorder virtual functions | yes | **no** |
| Add a *non-virtual* member function | yes | yes (new symbol only) |
| Add a base class | yes | **no** |
| Add/remove `final` on a class | yes | yes (but changes devirt) |
| Change a function's parameter/return type | maybe | **no** (mangled name changes) |
| Add a default argument | yes | **no** for existing callers' behavior (baked in at call site) |
| Change an inline function's body | yes | **no** (old body still inlined into callers) |
| Change an `enum` enumerator's value | yes | **no** (constant inlined) |
| Change underlying type of an enum | yes | **no** |
| Add an enumerator (no value change) | yes | yes, unless callers `switch` exhaustively |
| Change `noexcept` on a function | maybe | **no** (part of the type since C++17) |
| Rename a template parameter | yes | yes |
| Change a template's *definition* | yes | **no** (instantiations already emitted in callers) |
| Change exception type thrown | yes | risky (RTTI identity across .so needs default visibility) |
| Switch `_GLIBCXX_USE_CXX11_ABI` | yes | **no** (`std::string`/`list` layout) |
| Switch `-D_GLIBCXX_DEBUG` | yes | **no** |
| Switch compiler family (GCC↔MSVC) | yes | **no** |

```cpp
// ---- pImpl: freeze the public representation ----------------------------
// book.hpp
class Book {
public:
    Book();
    ~Book();                                   // MUST be out-of-line: Impl incomplete
    Book(Book&&) noexcept;
    Book& operator=(Book&&) noexcept;
    Book(Book const&);                         // deep copy needs manual plumbing
    Book& operator=(Book const&);

    void apply(Event const&);
    [[nodiscard]] std::int64_t best_bid() const;
private:
    class Impl;
    std::unique_ptr<Impl> impl_;               // sizeof(Book) == sizeof(void*), forever
};
```

```cpp
// book.cpp
class Book::Impl {
public:
    void apply(Event const&);
    std::vector<Level> levels_;
};
Book::Book() : impl_(std::make_unique<Impl>()) {}
Book::~Book() = default;                          // defined HERE, where Impl is complete
Book::Book(Book&&) noexcept = default;
Book& Book::operator=(Book&&) noexcept = default;
Book::Book(Book const& o) : impl_(std::make_unique<Impl>(*o.impl_)) {}
Book& Book::operator=(Book const& o) { *impl_ = *o.impl_; return *this; }
void Book::apply(Event const& e) { impl_->apply(e); }   // one indirection, no inlining
```

```cpp
// ---- fast pImpl: inline storage, no allocation, still opaque ------------
class FastBook {
public:
    FastBook(); ~FastBook();
    void apply(Event const&);
private:
    static constexpr std::size_t kSize  = 256;   // asserted in the .cpp
    static constexpr std::size_t kAlign = 16;
    alignas(kAlign) std::byte storage_[kSize];
};
// book.cpp: static_assert(sizeof(Impl) <= FastBook::kSize);
//           static_assert(alignof(Impl) <= FastBook::kAlign);
// Trades: no allocation/indirection, but the SIZE is now the ABI promise.
```

```cpp
// ---- versioned C boundary: the durable shape ---------------------------
extern "C" {
typedef struct qs_book qs_book;                  // opaque handle

typedef struct qs_book_vtable_v1 {
    uint32_t struct_size;                        // versioning by size
    uint32_t abi_version;
    qs_book* (*create)(uint32_t capacity);
    void     (*destroy)(qs_book*);               // paired with create — same allocator
    int32_t  (*apply)(qs_book*, void const* event, size_t len);
    int32_t  (*best_bid)(qs_book const*, int64_t* out);
} qs_book_vtable_v1;

QS_API qs_book_vtable_v1 const* qs_get_vtable_v1(void);
QS_API char const* qs_strerror(int32_t code);
}
// Rules: caller allocates nothing the callee frees (and vice versa) unless the
// API pairs them explicitly; no C++ types cross; no exceptions cross;
// error codes not errno; struct_size guards forward compatibility.
```

```cpp
// ---- C++20 inline namespaces: ABI-tagged versioning ---------------------
namespace qs {
inline namespace v2 {                 // qs::Book resolves to qs::v2::Book
    class Book { /* new layout */ };
}
namespace v1 { class Book { /* old layout */ }; }   // both coexist in one binary
}
[[gnu::abi_tag("cxx11")]] std::string make();   // libstdc++'s own technique
```

| Boundary style | ABI durability | Cost |
|---|---|---|
| C++ classes with STL members in headers | none across toolchains | zero, fastest |
| C++ classes + pImpl | stable size, unstable vtable/inline | 1 alloc + 1 indirection |
| Pure abstract interface + factory | stable if vtable is append-only-forbidden | virtual call |
| `extern "C"` opaque handle + functions | high | marshalling, no inlining |
| `extern "C"` versioned vtable struct | highest | indirection + version checks |

**Traps** — `~Book() = default;` *in the header* fails to compile with an incomplete `Impl` (`unique_ptr`'s deleter needs a complete type) · `unique_ptr<Impl>` makes `Book` move-only unless you write the copies · default arguments are evaluated at the *call site*, so changing one does nothing for already-compiled callers · returning `std::vector<std::string>` across a .so boundary requires identical libstdc++ ABI *and* one shared allocator/heap · throwing across a .so needs the exception type's typeinfo at default visibility or `catch` silently fails · mixing `_GLIBCXX_USE_CXX11_ABI=0` and `=1` links but corrupts `std::string` at runtime.

**Interview line** — "pImpl buys you a stable object size and a header firewall, and you pay one allocation, one indirection, and the complete loss of inlining across that boundary."

---

## 27.6 Template instantiation, code size, and build-time control

```cpp
// ---- explicit instantiation declaration and definition -----------------
// decoder.hpp
template<class Policy>
class Decoder {
public:
    void run(std::span<std::byte const>);
private:
    Policy policy_;
};
extern template class Decoder<FastPolicy>;        // DECLARATION: do not instantiate here
extern template void sink<int>(int);              // works for functions too
extern template struct std::vector<MyType>;       // legal for library templates

// decoder.cpp
template class Decoder<FastPolicy>;               // DEFINITION: emit it exactly once
template void sink<int>(int);
// Exactly one definition program-wide; a missing one is an undefined-symbol link error.
// `extern template` does NOT prevent instantiation of members used in constant
// expressions or of inline members the compiler still needs.
```

```cpp
// ---- the full instantiation vocabulary ---------------------------------
template<class T> struct S { void f(); };
template struct S<int>;                  // explicit instantiation definition (all members)
template void S<double>::f();            // instantiate one member only
template<> struct S<char> { void f(); }; // explicit (full) SPECIALIZATION — different thing
template<class T> struct S<T*> { };      // partial specialization
template<class T> void g(T);
template void g<int>(int);               // explicit instantiation, args deduced
template<> void g<char>(char) { }        // explicit specialization with a body
```

```cpp
// ---- reduce instantiations: hoist the non-dependent work ---------------
// BAD: whole body duplicated per T
template<class T>
void process_all(std::span<T> items) {
    validate_header(/* big non-dependent logic */);      // duplicated N times
    for (auto& i : items) transform(i);
}
// GOOD: one shared body + a thin dependent kernel
void validate_header_impl(std::span<std::byte const>);   // in a .cpp
template<class T>
void process_all(std::span<T> items) {
    validate_header_impl(raw_bytes(items));              // one copy program-wide
    for (auto& i : items) transform(i);
}
```

```cpp
// ---- type erasure collapses N instantiations into 1 --------------------
template<class Handler>
void run_typed(Message const&, Handler&);            // one body per Handler

using HandlerFn = std::function<void(Message const&)>;   // allocating, indirect
void run_erased(Message const&, HandlerFn);              // ONE body
void run_view(Message const&, std::move_only_function<void(Message const&)>); // C++23
// Non-owning, non-allocating erasure (the hot-path choice):
struct HandlerRef {
    void* obj;
    void (*call)(void*, Message const&);
    template<class H> HandlerRef(H& h) : obj(&h),
        call([](void* o, Message const& m) { (*static_cast<H*>(o))(m); }) {}
    void operator()(Message const& m) const { call(obj, m); }
};
```

```cpp
// ---- combinatorial explosion -------------------------------------------
template<Side S, bool Validate, class Handler>
void process(Message const&, Handler&);
// 2 sides x 2 validate x K handlers = 4K emitted bodies.
// Fix: make Side and Validate runtime parameters for the cold 95% of the body,
// keep the template only around the measured-hot kernel.
```

```bash
# ---- measuring template/build cost --------------------------------------
clang++ -ftime-trace foo.cpp        # emits foo.json → chrome://tracing / speedscope
clang++ -ftime-report               # per-pass timing
g++     -ftime-report -fmem-report
nm -C --size-sort -S app | tail -40           # biggest symbols
bloaty app -d compileunits,symbols            # size attribution
llvm-nm --print-size app | c++filt | sort -k2 # per-symbol size
readelf -S app | grep -E 'text|rodata'        # section sizes
```

| Technique | Benefit | Tradeoff |
|---|---|---|
| Move non-dependent code to a `.cpp` | one body program-wide | call boundary, no inlining |
| `extern template` in the header | no repeated instantiation per TU | link obligation; hides body from optimizer |
| Explicit instantiation in one `.cpp` | centralized, faster builds | fixed supported type set |
| Type erasure (`function_ref`, vtable) | 1 body for N types | indirect call, possible allocation |
| `std::function` → `move_only_function` (C++23) | no copyability requirement | still type-erased/indirect |
| Concepts to constrain, not to branch | better errors, no extra bodies | none |
| `if constexpr` instead of tag overloads | fewer symbols, one function | still one body per instantiation |
| Modules (C++20) / PCH | parse once, not per TU | build-system and toolchain maturity |
| `-Wl,--icf=all`, LTO body merging | folds identical instantiations | link cost; not guaranteed; breaks fn-pointer identity |
| `-ffunction-sections -Wl,--gc-sections` | drop unreferenced instantiations | none material |

```cpp
// ---- C++20 modules: build-time, not ABI --------------------------------
// qs.decoder.cppm
export module qs.decoder;
export template<class P> class Decoder { public: void run(); };
// consumer
import qs.decoder;
// Modules remove repeated parsing/instantiation of the interface, give real
// isolation from macros, and change name *linkage* (module linkage), but they
// do NOT define a stable binary ABI and BMIs are compiler-and-flag specific.
```

**Traps** — `extern template` with no matching definition is a *link*-time error, often only in release builds · explicit instantiation of a class instantiates *every* member, including ones that would not compile for that type · `--icf=all` merges identical functions so distinct function pointers can compare equal · a header-only library's build cost is paid by every consumer, every TU · `std::function` allocates when the callable exceeds the SBO budget and its call is always indirect.

---

## 27.7 Compiler intrinsics, `std::unreachable`, and assumption facilities

```cpp
// ---- std::unreachable (C++23, <utility>) --------------------------------
#include <utility>
enum class Side : std::uint8_t { bid, ask };

constexpr int sign(Side s) noexcept {
    switch (s) {
        case Side::bid: return  1;
        case Side::ask: return -1;
    }
    std::unreachable();      // UB if reached; deletes the default-path code
}
// Pre-C++23 equivalents:
// __builtin_unreachable();        (GCC/Clang)
// __assume(false);                (MSVC)
```

```cpp
// ---- the proof obligation is REAL --------------------------------------
Side s = static_cast<Side>(byte_from_wire);   // value need not be 0 or 1!
int v = sign(s);                              // UB if the wire byte was 7
// Correct: validate at the trust boundary, THEN rely on the invariant.
std::optional<Side> parse_side(std::uint8_t b) noexcept {
    switch (b) { case 0: return Side::bid; case 1: return Side::ask; }
    return std::nullopt;
}
```

```cpp
// ---- [[assume]] (C++23) --------------------------------------------------
int sum_nonempty(std::span<int const> v) {
    auto const n = v.size();
    [[assume(n != 0)]];              // unevaluated premise; enables loop peeling
    [[assume(n % 8 == 0)]];          // lets the vectorizer drop the scalar epilogue
    int t = 0;
    for (auto x : v) t += x;
    return t;
}
void aligned(float* p) {
    [[assume(reinterpret_cast<std::uintptr_t>(p) % 64 == 0)]];  // aligned loads
}
// The expression is NOT evaluated: side effects are discarded, and calls in it
// need not be defined. Falsity where the compiler relies on it is UB.
// Pre-C++23: __builtin_assume(c) [Clang], if(!(c)) __builtin_unreachable() [GCC],
//            __assume(c) [MSVC].
```

```cpp
// ---- assume vs assert vs contract --------------------------------------
assert(n != 0);          // checked in debug, VANISHES under NDEBUG, no optimizer info
[[assume(n != 0)]];      // never checked, always an optimizer premise, UB if false
if (n == 0) throw std::invalid_argument{"empty"};   // always checked, defined behavior
// Safe pattern: check at the boundary, assume only inside the proven core.
#ifdef NDEBUG
#  define QS_ASSUME(c) [[assume(c)]]
#else
#  define QS_ASSUME(c) assert(c)          // verify the premise in test builds
#endif
```

| Facility | Std | Evaluated? | If violated |
|---|---|---|---|
| `assert(c)` | C | yes unless `NDEBUG` | `abort()` (or nothing) |
| `[[assume(c)]]` | C++23 | **no** | UB |
| `std::unreachable()` | C++23 | n/a | UB |
| `[[noreturn]]` | C++11 | n/a | UB if it returns |
| `[[likely]]`/`[[unlikely]]` | C++20 | n/a | only a hint, never UB |
| `std::terminate()` | C++98 | yes | defined: terminates |
| `__builtin_trap()` | GCC/Clang | yes | defined: `ud2`/SIGILL |

```cpp
// ---- portable-shaped intrinsic wrappers ---------------------------------
namespace platform {

[[noreturn]] inline void impossible() noexcept {
#if defined(__cpp_lib_unreachable)
    std::unreachable();
#elif defined(__GNUC__)
    __builtin_unreachable();
#elif defined(_MSC_VER)
    __assume(false);
#else
    std::abort();
#endif
}

inline void prefetch_read(void const* p) noexcept {
#if defined(__GNUC__)
    __builtin_prefetch(p, /*rw=*/0, /*locality=*/3);   // 3 = keep in all caches
#elif defined(_MSC_VER)
    _mm_prefetch(static_cast<char const*>(p), _MM_HINT_T0);
#else
    (void)p;
#endif
}

inline std::uint64_t timestamp() noexcept {
#if defined(__x86_64__)
    unsigned aux;  return __rdtscp(&aux);   // serializing-ish; not wall clock
#elif defined(__aarch64__)
    std::uint64_t v; asm volatile("mrs %0, cntvct_el0" : "=r"(v)); return v;
#else
    return std::chrono::steady_clock::now().time_since_epoch().count();
#endif
}

inline int ctz(std::uint64_t x) noexcept { return std::countr_zero(x); }  // C++20 <bit>

} // namespace platform
```

```cpp
// ---- prefer the standard <bit> facilities over builtins (C++20) --------
#include <bit>
std::countl_zero(x); std::countr_zero(x); std::popcount(x);   // → lzcnt/tzcnt/popcnt
std::has_single_bit(x); std::bit_ceil(x); std::bit_floor(x); std::bit_width(x);
std::rotl(x, 3); std::rotr(x, 3);        // real rotate instructions, no UB
std::byteswap(x);                        // C++23 → bswap
std::bit_cast<float>(bits);              // C++20, constexpr, no aliasing UB
if consteval { /* C++23 */ } else { /* runtime intrinsic path */ }
```

```cpp
// ---- runtime CPU dispatch (better than -march=native for shipped binaries)
[[gnu::target("avx2")]]        void kernel_avx2(std::span<float>);
[[gnu::target("default")]]     void kernel_base(std::span<float>);
[[gnu::target_clones("avx2","sse4.2","default")]] void kernel(std::span<float>);
// ifunc/target_clones resolve once at load; __builtin_cpu_supports("avx2") at runtime.
```

**Traps** — `[[assume]]` with a function call discards the call, so `[[assume(v.pop() > 0)]]` silently does nothing · `std::unreachable()` in a `switch` over an enum whose value came off the wire is UB, not defensive · `rdtsc` counts reference cycles, not instructions, and needs fences plus a calibrated frequency · `-march=native` at build time trades portability for the same benefit `target_clones` gives at runtime · `__builtin_expect` on an already-well-predicted branch is worthless and can hurt layout.

**Interview line** — "`[[assume]]` is a promise, not a check: it costs nothing at runtime and costs you the whole program if it is ever false."

---

## 27.8 Reading generated assembly without overfitting to it

```bash
# ---- getting the assembly ------------------------------------------------
g++ -O2 -S -masm=intel -fverbose-asm foo.cpp -o -        # source → asm, Intel syntax
clang++ -O2 -S -emit-llvm foo.cpp -o -                   # LLVM IR (often more readable)
objdump -drwC -Mintel app | less                         # disassemble, demangled
objdump -dS app                                          # interleave source (needs -g)
llvm-objdump -d --x86-asm-syntax=intel --demangle app
llvm-mca -mcpu=skylake kernel.s                          # static throughput/port model
perf annotate -s hot_function                            # asm + sampled cycle counts
# Compiler Explorer (godbolt.org) for one function with exact flags pinned.
```

```bash
# ---- optimization remarks: ask the compiler why ------------------------
clang++ -O2 -Rpass=inline -Rpass-missed=inline -Rpass-analysis=inline foo.cpp
clang++ -O2 -Rpass=loop-vectorize -Rpass-missed=loop-vectorize
clang++ -O2 -fsave-optimization-record          # foo.opt.yaml → opt-viewer.py
g++ -O2 -fopt-info-vec -fopt-info-vec-missed -fopt-info-inline foo.cpp
```

```cpp
// ---- keeping a function inspectable in isolation ----------------------
// Godbolt idiom: prevent the whole body from being folded away.
int kernel(int const* p, std::size_t n);         // declared, not defined → real call
extern "C" int measured(int const* p, std::size_t n) { return kernel(p, n); }
// Or mark [[gnu::noinline, gnu::used]] and take its address.
```

```text
Signals worth reading                     What they look like
inlined?                     no `call` to the helper; body appears in the caller
bounds check retained?       `cmp`+`jae` to a throw/ud2 block inside the loop
vectorized?                  xmm/ymm/zmm regs, movups/vpaddd, 4-8x unrolled body
strength reduction?          `div` gone; `imul`+`shr` magic-number sequence
devirtualized?               direct `call sym` instead of `call qword ptr [rax+16]`
spills?                      repeated `mov [rsp+N], reg` / `mov reg, [rsp+N]` in loop
memcpy of known size?        a few `mov`/`movups` pairs, no `call memcpy`
tail call?                   `jmp sym` at the end instead of `call`+`ret`
PLT call (interposable)?     `call sym@PLT`
code-size blowup?            the same shape repeated per template instantiation
```

```text
# ---- record this with every assembly conclusion ------------------------
compiler + exact version        g++ (GCC) 14.2.0
target triple / -march          x86_64-pc-linux-gnu, -march=haswell
optimization + LTO + PGO        -O2 -flto=auto -fprofile-use=app.profdata
exception/RTTI/dialect flags    -fexceptions -frtti -std=c++23 -D_GLIBCXX_ASSERTIONS
standard library + ABI          libstdc++ 14, _GLIBCXX_USE_CXX11_ABI=1
source revision                 git sha
calling context                 inlined into Feed::on_message, n known == 64
```

**Traps** — a standalone function optimizes completely differently once inlined into a real caller · constant toy arguments delete the work you meant to measure · fewer instructions ≠ lower latency (dependency chains, port pressure, µop cache) · assembly shows nothing about cache misses, branch mispredicts, contention, or allocator state · comparing `-O2` asm of two versions proves emitted-code difference, not runtime difference · `-O0` and sanitizer builds emit deliberately different code and are not evidence about release.

**Interview line** — "Assembly proves what one exact build emitted; it never proves what a program will cost on real inputs."

---

## 27.9 Sanitizer-build versus production-build behavior

```bash
# ---- AddressSanitizer + LeakSanitizer ------------------------------------
clang++ -O1 -g -fsanitize=address -fno-omit-frame-pointer app.cpp -o app.asan
ASAN_OPTIONS=detect_leaks=1:detect_stack_use_after_return=1:abort_on_error=1 ./app.asan
ASAN_OPTIONS=halt_on_error=0:log_path=asan.log ./app.asan
# ~2x slowdown, ~3x memory. Finds: heap/stack/global OOB, UAF, double free,
# use-after-return/scope, leaks, memcpy overlap. Misses: uninitialized reads,
# intra-object OOB (unless -fsanitize-address-field-padding), races.

# ---- UndefinedBehaviorSanitizer ------------------------------------------
clang++ -O2 -g -fsanitize=undefined -fno-sanitize-recover=all app.cpp -o app.ubsan
clang++ -fsanitize=signed-integer-overflow,bounds,null,alignment,vptr,return,shift
UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1 ./app.ubsan
# ~0-20% slowdown. `vptr` needs RTTI; `-fsanitize-trap=undefined` gives ud2 with no runtime.

# ---- ThreadSanitizer -----------------------------------------------------
clang++ -O2 -g -fsanitize=thread app.cpp -o app.tsan
TSAN_OPTIONS=halt_on_error=1:second_deadlock_stack=1:history_size=7 ./app.tsan
# 5-15x slowdown, 5-10x memory. Finds data races, some deadlocks, some misuse.
# Needs ALL code instrumented; hand-written asm/atomics-as-volatile fool it.

# ---- MemorySanitizer (uninitialized reads) -------------------------------
clang++ -O2 -g -fsanitize=memory -fsanitize-memory-track-origins=2 app.cpp -o app.msan
# Requires the WHOLE dependency stack (incl. libc++) instrumented, or false positives.

# ---- production hardening (cheap, ship-able) -----------------------------
-D_FORTIFY_SOURCE=3 -O2            # checked str/mem builtins
-fstack-protector-strong -fstack-clash-protection -fcf-protection=full
-D_GLIBCXX_ASSERTIONS              # libstdc++ precondition checks (operator[], etc.)
-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST   # libc++ hardening
-Wl,-z,relro,-z,now -fPIE -pie
# ASan/TSan/MSan are mutually exclusive; ASan+UBSan combine fine.
```

```cpp
// ---- suppressing known/unfixable reports --------------------------------
__attribute__((no_sanitize("address")))   void raw_probe();
__attribute__((no_sanitize("thread")))    void benign_by_design();
[[gnu::no_sanitize("undefined")]]         void checked_by_hand();
// or: ASAN_OPTIONS=suppressions=asan.supp ; TSAN_OPTIONS=suppressions=tsan.supp
#if defined(__has_feature)
#  if __has_feature(address_sanitizer)
#    define QS_UNDER_ASAN 1
#  endif
#endif
#if defined(__SANITIZE_ADDRESS__)   // GCC spelling
#  define QS_UNDER_ASAN 1
#endif
```

| Build | Finds | Cost | Blind spots |
|---|---|---|---|
| ASan+LSan | OOB, UAF/UAR, double free, leaks | 2x time, 3x RAM | races, uninit, intra-object OOB |
| UBSan | overflow, bad shift, null, misalign, bad enum/bool, bad vptr | 0–20% | only enabled checks, only executed paths |
| TSan | data races, some deadlocks | 5–15x time | needs full instrumentation; huge timing shift |
| MSan | uninitialized reads | 3x time | needs instrumented libc++ and deps |
| Valgrind memcheck | uninit + heap errors, no rebuild | 20–50x | serializes threads, hides races |
| `_GLIBCXX_ASSERTIONS` | STL precondition violations | small | not a UB detector |
| Fuzzing (`-fsanitize=fuzzer`) | input-driven paths | n/a | needs a corpus and a harness |

```bash
# ---- the build matrix a real project keeps -------------------------------
1. -O0 -g                       fast iteration, breakpoints
2. -Og -g -D_GLIBCXX_ASSERTIONS everyday dev build, realistic-ish
3. -O1 -g -fsanitize=address,undefined     CI on every PR
4. -O2 -g -fsanitize=thread                CI nightly, concurrency suites
5. -O2 -g -flto -march=<baseline>          release candidate
6. release + -fprofile-use                 shipped artifact
# Rule: keep at least one OPTIMIZED sanitizer config — -O0 hides optimizer-
# sensitive symptoms and changes code shape completely.
```

```text
Production-only failure? audit in this order:
  UB exploited at -O2   →  rebuild with -O2 -fsanitize=undefined
  data race             →  TSan on the same workload
  ODR violation         →  -Wodr with LTO, or gold --detect-odr-violations
  ABI/flag mismatch     →  compare _GLIBCXX_USE_CXX11_ABI, exceptions, RTTI, march
  assert compiled out   →  NDEBUG removed a side effect
  CPU feature dispatch  →  different -march path taken on prod hardware
  stale PGO profile     →  rebuild without -fprofile-use and re-measure
```

**Traps** — a clean sanitizer run only covers the paths that executed with the inputs you used · sanitizer timing suppresses many real races · ASan's redzones change layout so a heap-overflow bug may relocate rather than vanish · TSan cannot see races in uninstrumented third-party libraries or hand-written asm · never report sanitizer-build latency as product latency · `-fsanitize=undefined` defaults to *recovering* and continuing, so add `-fno-sanitize-recover=all` in CI.

---

## 27.10 Reproducible builds and compiler/version pinning

```bash
# ---- sources of nondeterminism and their fixes --------------------------
-ffile-prefix-map=/abs/build=.        # normalize __FILE__, DWARF, and asserts
-fdebug-prefix-map=/abs/src=/src      # DWARF paths only
-fmacro-prefix-map=/abs/src=/src      # __FILE__ only
-Wdate-time                           # warn on __DATE__/__TIME__/__TIMESTAMP__
-frandom-seed=<stable>                # GCC: stabilize internal symbol name hashes
-no-canonical-prefixes                # keep driver paths symbolic
export SOURCE_DATE_EPOCH=1700000000   # honored by GCC/Clang and many archivers
export TZ=UTC LC_ALL=C LANG=C         # locale/time-zone affect generators + sorting
ar --deterministic rcs lib.a *.o      # or `ar rcsD`: zero uid/gid/mtime/mode
-Wl,--build-id=sha1                   # content-derived, reproducible build ID
strip --strip-debug; objcopy --only-keep-debug app app.dbg
                     objcopy --add-gnu-debuglink=app.dbg app
```

```cpp
// ---- source-level nondeterminism to purge -------------------------------
char const* built = __DATE__ " " __TIME__;   // NEVER in a reproducible build
char const* file  = __FILE__;                // absolute path leaks; use prefix-map
// std::unordered_map iteration order        // stable per-run, but not across libs
// pointer-value sorting / std::sort on ties // use stable_sort or a total order
// filesystem::directory_iterator order      // sort explicitly before use
// parallel reductions over floating point   // non-associative → different results
// std::type_info::name() ordering            // implementation-defined
```

```text
# ---- the pin manifest: what a build record must contain ----------------
source            git sha + dirty flag + submodule shas
compiler          g++ 14.2.0 (exact package hash), linker: lld 19.1.0, ar/nm/objcopy
std library       libstdc++ 14.2, _GLIBCXX_USE_CXX11_ABI=1
language mode     -std=c++23, -fexceptions, -frtti
flags             full command line, per TU, including -D and -I
target            x86_64, -march=x86-64-v3, -mtune=skylake
LTO / PGO         -flto=thin, profile sha + provenance + training workload id
dependencies      lockfile with content hashes (not version ranges)
environment       SOURCE_DATE_EPOCH, TZ, LC_ALL, PATH, container image digest
outputs           binary sha256 + build-id + debuginfo sha256
```

```bash
# ---- verifying reproducibility ------------------------------------------
sha256sum app                     # build twice in different dirs/times, compare
diffoscope app.a app.b            # structural diff of two binaries
readelf -n app | grep 'Build ID'  # stable across identical builds?
strings app | grep -E '/home/|/tmp/'   # leaked absolute paths
```

| Why quant/HFT pins builds | Consequence if unpinned |
|---|---|
| Performance attribution across releases | a latency regression is unassignable |
| Deterministic incident replay | cannot reproduce the failing artifact |
| ABI compatibility across shared libraries | silent runtime corruption |
| Audit and regulatory traceability | cannot prove what ran |
| Instant rollback to a known artifact | must rebuild and hope |
| Cache hits in distributed builds | slow builds, flaky CI |

**Traps** — reproducibility proves *identity*, never correctness or performance · a version *range* in a lockfile is not a pin · `-march=native` makes the output depend on the build machine's CPU · PGO profiles are build inputs and must be versioned like source · debug info is part of the artifact when you ship split symbols for a symbolizer · plain `ar` records timestamps and uids, breaking bit-identity even when every object is identical.

**Interview line** — "Same source is not the same executable: the compiler, flags, standard library, target features, and profile data are all inputs to the artifact."

---

**Recall card**

```text
as-if            preserve observable behavior only: volatile, IO, atomics, termination
UB               a premise, not a bug — checks after UB may be deleted
-O0/-O2/-O3      toolchain policy, never a C++ language mode
fast-math        a semantic contract change; record it or the build is undefined
inline           ODR facility + one address; machine inlining is separate
final            enables devirtualization, never promises it
LTO              defer codegen to link → cross-TU inlining, internalization, ICF
PGO              measured frequencies → layout, inlining, indirect-call promotion
mangling         Itanium/MSVC ABI, not ISO C++; c++filt to read it
extern "C"       fixes the symbol name and function type; nothing about layout
visibility       hidden by default + explicit export macro + version script
calling conv     SysV: RDI RSI RDX RCX R8 R9 / XMM0-7; >16B aggregates via sret
ABI break        any data member, virtual, inline body, enum value, default arg
pImpl            stable size, 1 alloc + 1 indirection, out-of-line special members
extern template  suppress implicit instantiation; define the specialization once
unreachable      C++23; reaching it is UB
[[assume]]       C++23; unevaluated premise; false premise is UB
assembly         evidence for one exact build, in one exact calling context
sanitizers       dynamic, path-limited diagnostics; never production performance
reproducible     pin toolchain + flags + libs + target + profile + environment
```
