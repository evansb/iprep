# Chapter 37 — Compilation, Optimization, ABI, and Assembly

C++ performance is shaped by a pipeline: preprocessing and translation establish what the optimizer can see, linking combines program fragments, an ABI defines binary boundaries, and the target CPU executes the selected instructions. Source intuition fails when any layer is ignored. This chapter shows how to inspect that pipeline without treating one compiler's current output as a language guarantee.

## 37.1 Translation Units, Headers, and Include Guards

A **translation unit** is the source file produced after preprocessing one implementation file and its included headers. Each translation unit is compiled largely independently unless later whole-program optimization combines intermediate representations.

Headers copy declarations and definitions into every including translation unit. Include guards or `#pragma once` prevent repeated inclusion within one translation unit; they do not reduce parsing across different translation units.

```cpp
#ifndef QUANTBOOK_PRICE_HPP
#define QUANTBOOK_PRICE_HPP

#include <cstdint>

struct price {
    std::int64_t ticks;
};

inline constexpr bool operator<(price a, price b) noexcept {
    return a.ticks < b.ticks;
}

#endif
```

The One Definition Rule governs which entities may have definitions in multiple translation units and when those definitions must be identical. `inline` permits multiple corresponding definitions; it does not command machine-code inlining. Templates normally need definitions visible where instantiated, which can increase parse and instantiation work.

A change to a widely included header can rebuild much of a project. Large headers also consume compiler memory and make macro state part of more files. Use forward declarations where semantically valid, keep implementation details out of stable interfaces, and inspect include cost rather than guessing:

```sh
clang++ -std=c++23 -ftime-trace -c gateway.cpp
g++ -std=c++23 -ftime-report -c gateway.cpp
```

Generated trace data describes that build, compiler, and source graph. It is not a runtime-performance measurement.

ODR violations are especially dangerous when definitions differ only because of macros or build flags. Two translation units can instantiate the same template with textually different configuration and still link after weak-symbol deduplication. Which definition survives is not a supported selection mechanism. Enable available ODR diagnostics under LTO, centralize configuration in generated headers, and avoid ABI-relevant macros that differ across a target.

Explicit template instantiation can move repeated code generation into one translation unit. An `extern template` declaration suppresses implicit instantiation in consumers, and one explicit definition supplies it. This can reduce build work and code duplication, but only for a deliberately supported type set. It may also reduce optimization when callers can no longer see or specialize the body without LTO.

## 37.2 Precompiled Headers and C++20 Modules

A **precompiled header (PCH)** stores compiler-specific parsed state for reuse. It can reduce repeated front-end work for stable, common headers. PCH validity depends on compiler version, flags, macros, language mode, and other environment details; build systems must rebuild it when those inputs change.

C++20 modules provide named importable units with controlled interfaces. They reduce textual inclusion and macro leakage, and implementations can cache compiled module interfaces. Modules do not automatically improve runtime code or remove template instantiation. Toolchain support, dependency scanning, standard-library packaging, and build-system behavior remain version-specific.

```cpp
// instrument.cppm
export module instrument;
import <cstdint>;

export struct instrument_id {
    std::uint32_t value;
};
```

Exact commands for building standard-library header units and module interfaces differ among GCC, Clang, their standard libraries, and build systems. Maintain a small toolchain probe rather than publishing one command as universal.

PCH and modules optimize developer build latency and compiler memory. They can indirectly influence runtime if they change optimization boundaries or cause different definitions to be visible, but that is not their primary contract. Verify reproducibility by building clean and incremental trees in CI.

## 37.3 Separate Compilation and LTO

**Separate compilation** emits an object file for each translation unit. A call to a function defined elsewhere often remains a call because the compiler cannot inspect the body. Visibility attributes and interprocedural summaries can still enable some reasoning.

**Link-time optimization (LTO)** preserves compiler intermediate representation into link time so optimization can cross translation-unit boundaries. GCC and Clang support toolchain-specific full and thin variants. LTO can inline, propagate constants, remove unused code, and devirtualize; it can also increase link time and code growth.

```sh
clang++ -std=c++23 -O3 -flto=thin -c book.cpp -o book.o
clang++ -std=c++23 -O3 -flto=thin book.o main.o -o engine

g++ -std=c++23 -O3 -flto -c book.cpp -o book.o
g++ -std=c++23 -O3 -flto book.o main.o -o engine
```

Use one compatible compiler toolchain for compile and link steps. Plugins, archivers, linkers, and cached objects must understand the selected LTO format. Treat mixed-version LTO objects as unsupported unless the vendor documents compatibility.

LTO may remove a call benchmarked in a non-LTO build or duplicate a hot function into many callers. Compare final binaries: size, symbols, disassembly, startup, and latency distributions. The linked executable is the performance artifact.

```text
source + headers -> preprocess -> frontend/IR -> object
                                              |
other objects + archives ---------------------+
                                              v
                                   linker or LTO optimizer
                                              |
                                              v
                              executable + dynamic dependencies
```

At each arrow, record flags and tool identity. Archive extraction can omit unreferenced members; symbol resolution can select a weak definition; LTO can import and clone bodies; the dynamic loader can resolve remaining symbols at startup or first call. Inspecting pre-link assembly answers only the frontend portion of this flow.

Thin-style LTO commonly stores summaries and imports selected bodies rather than merging all intermediate representation into one monolithic optimizer invocation. This can improve parallelism and incremental build behavior, but exact algorithms and cache formats are toolchain details. A remote build cache key must include compiler identity, flags, target features, and LTO inputs.

Linker garbage collection can remove unused sections when compilation emits suitable section granularity and the link enables collection. Constructors, registration tables, reflection-like mechanisms, and symbols found indirectly by `dlsym` can require explicit retention. A smaller binary obtained by accidentally discarding registration is not an optimization success; test startup registries and plugin discovery.

## 37.4 Dead-Code Elimination and Constant Propagation

The **as-if rule** permits any transformation that preserves the C++ program's observable behavior. Dead-code elimination removes computations whose results cannot affect that behavior. Constant propagation evaluates expressions or branches when their inputs are known.

```cpp
int classify(int quantity) {
    constexpr int maximum = 10'000;
    if (maximum == 0)             // known false
        return -1;
    return quantity <= maximum;
}
```

An optimizer can erase the false branch. If a benchmark calculates a result and never consumes it, the complete calculation may disappear. Volatile is not a general optimization barrier or inter-thread primitive. A benchmark should make the result observably consumed outside the measured kernel while preserving normal optimization inside it.

Undefined behavior expands optimizer freedom. If signed overflow is impossible in every defined execution, the compiler may simplify checks that assume it occurs. Do not disable semantics to obtain faster code; express checked arithmetic or use an appropriate unsigned representation.

Inspect optimization remarks and final assembly:

```sh
clang++ -std=c++23 -O3 '-Rpass=.*' '-Rpass-missed=.*' -c risk.cpp
g++ -std=c++23 -O3 -fopt-info-optimized -fopt-info-missed -c risk.cpp
objdump -drC engine
```

Remarks can be verbose and compiler-specific. Use them to locate decisions, then verify actual behavior.

## 37.5 Escape Analysis, Inlining, and Devirtualization

An object **escapes** when the optimizer must assume it remains observable beyond a local region, for example through an unknown call or stored pointer. Proving non-escape can enable scalar replacement, removal of temporary storage, or allocation elimination. C++ does not guarantee a named escape-analysis pass or heap-allocation elision in general.

Inlining replaces a call site with the callee's body. It removes call/return work and exposes further constant propagation, but duplicates code and increases register pressure. `inline`, `always_inline`, and link-time inlining are different concepts; compiler attributes are nonportable requests and may still be rejected.

**Devirtualization** replaces virtual dispatch with a direct call when the dynamic type is provably known. `final`, internal visibility, whole-program information, or a locally constructed object can help. C++ guarantees virtual semantics, not a vtable or an indirect call.

```cpp
struct check {
    virtual bool admit(int) const noexcept = 0;
    virtual ~check() = default;
};

struct fixed_check final : check {
    bool admit(int q) const noexcept override { return q <= 1'000; }
};
```

GCC or Clang may devirtualize a call through `fixed_check` when type information is visible. A call crossing a shared-library boundary with symbol interposition may remain indirect. Flags that change interposition assumptions change binary semantics and deployment compatibility; document them.

Use `-fno-inline` only as a diagnostic comparison. A useful review asks whether inlining shortened a critical dependency chain or merely enlarged the caller.

## 37.6 Vectorization, Unrolling, Alias Analysis, and PGO

Loop vectorization executes several iterations with SIMD operations when dependencies, aliasing, alignment, exception behavior, and arithmetic semantics permit it. Unrolling duplicates a loop body to reduce control overhead and expose independent work.

Possible aliasing is a common blocker. Standard C++ pointers may refer to overlapping objects unless types, lifetime, or program structure prove otherwise. GCC and Clang support `__restrict` as an extension, but violating its promise produces undefined behavior. Prefer interfaces whose ownership implies non-overlap; use extensions only with an enforced contract.

Profile-guided optimization (PGO) collects execution profiles and uses them in a second build to guide layout, inlining, branch probabilities, and other decisions.

```sh
clang++ -std=c++23 -O3 -fprofile-instr-generate app.cpp -o app.profile
LLVM_PROFILE_FILE=run.profraw ./app.profile workload
llvm-profdata merge -output=app.profdata run.profraw
clang++ -std=c++23 -O3 -fprofile-instr-use=app.profdata app.cpp -o app
```

The training workload becomes a build input. If it omits reject paths, recovery, or a new message mix, layout decisions may harm production tails. Record profile provenance and warn on stale or mismatched profiles.

Vectorization and unrolling trade throughput against setup, tails, code size, and single-item latency. Request diagnostics, inspect the binary, and benchmark the production trip-count distribution. Chapter 18 provides the hardware model.

## 37.7 Code Growth and Instruction-Cache Pressure

Code growth consumes instruction-cache, instruction-TLB, decode, and branch-predictor resources. Templates, inlining, unrolling, function multiversioning, and duplicated error paths can make each local function faster while the complete workload becomes less stable.

A hot-path executable alternates among decoders, risk checks, book updates, and logging guards. An isolated benchmark keeps one kernel resident and can hide conflict. Measure the combined call mix.

Alignment and function ordering also influence instruction-cache sets and branch addresses. A small source change can move unrelated functions and change a benchmark. This does not make measurement futile; it means tiny differences near noise level require repeated layouts or link-order controls before assigning cause. PGO and linker order files can cluster frequently connected functions when supported.

Cold outlining is not free. A reject path moved out of line adds a taken branch and call when exercised. If rejects become common during a market event, the formerly cold block can become hot and scattered. Profile normal and stressed regimes rather than optimizing one average profile.

Useful size views include:

```sh
size engine
nm -S --size-sort -C engine | tail
objdump -h engine
perf stat -e instructions,cycles ./engine workload
```

Hardware instruction-cache event names differ by processor; inspect `perf list` and vendor documentation before selecting them. Sampling can identify scattered hot blocks, but debug information and symbolization must match the binary.

Outline cold error handling, constrain gratuitous template variation, and compare LTO/inlining configurations. Do not minimize binary size blindly: a well-inlined tiny risk predicate may be worth its duplicate bytes.

## 37.8 Calling Conventions and Stack Alignment

A **calling convention** defines how a platform ABI passes arguments and results, preserves registers, aligns the stack, and performs calls. C++ itself does not specify register names or stack layout.

Under the System V AMD64 ABI commonly used by Linux x86-64, initial integer or pointer arguments normally use a sequence of general registers, floating arguments use vector registers, and the stack has a required alignment at call boundaries. Large or nontrivial returns may use caller-provided storage. Microsoft x64 and AArch64 ABIs differ.

Small aggregate classification is ABI-specific. Changing a struct's fields can change whether it travels in registers or memory. Passing by value is not inherently slower than passing by reference: a small value may remain in registers, while a reference adds a load and aliasing possibilities.

Variadic C interfaces, member functions, vector types, and over-aligned aggregates add calling-convention rules that are easy to violate in handwritten assembly or JIT code. The compiler is the reference producer: compile a probe declaration and inspect both sides. Save every callee-preserved register you modify, maintain required stack alignment at nested calls, and supply unwind metadata if exceptions or stack walking can cross the frame.

Tail-call optimization can replace a call followed by return with a jump when ABI, cleanup, and semantic constraints permit it. C++ does not guarantee this optimization. Destructors, stack adjustments, instrumentation, or incompatible return conventions can prevent it. Coroutine symmetric transfer from Chapter 19 solves a related control-flow problem through language machinery, not a universal tail-call promise.

A prologue may adjust the stack, save callee-preserved registers, establish a frame pointer, or reserve local spill space. Optimized leaf functions can have no visible frame. Stack protectors, sanitizers, variable-size objects, and instrumentation change prologues.

Inspect both caller and callee. A callee that looks free may require the caller to copy an aggregate into ABI-defined temporary storage. Verify stack alignment before using assembly or intrinsics that require stronger alignment.

## 37.9 Name Mangling and Binary Interfaces

**Name mangling** encodes information such as namespaces, overload parameter types, and templates into linker symbol names. The encoding is an ABI convention, not a C++ language format.

```sh
nm engine | head
nm -C engine | head
c++filt '_Z...'
readelf -Ws engine
```

`extern "C"` requests C language linkage and commonly suppresses C++ mangling, but it does not make C++ classes, exceptions, templates, or standard-library objects portable through a C ABI. A stable boundary uses fixed-width representations, explicit ownership, versioned structures, and documented alignment.

Changing parameter types, namespace, exception specification where encoded, class layout, compiler ABI settings, or visibility can break binary compatibility without a source error in consumers. Symbol versioning and compatibility shims are linker/platform mechanisms requiring deliberate release policy.

Shared-library calls can pass through procedure-linkage indirection and lazy binding depending on platform and linker options. Measure startup and steady-state separately. Eager binding trades startup work for avoiding first-call resolution later.

Visibility controls which definitions are exported and interposable. Hiding internal symbols can improve optimization and reduce dynamic symbol tables, but it changes plugin and preload behavior. Use an explicit export list and test the supported extension surface. Flags such as semantic interposition changes are deployment contracts, not harmless speed switches.

Opaque handles make evolution easier:

```c
/* C boundary: fixed ownership operations, no C++ object layout exposed. */
#include <stddef.h>

typedef struct risk_engine risk_engine;

risk_engine* risk_engine_create(const void* config, size_t bytes);
int risk_engine_check(risk_engine*, const void* order, size_t bytes);
void risk_engine_destroy(risk_engine*);
```

The real interface still needs versioned byte schemas, alignment rules, error codes, thread-safety, and allocator ownership. The side that creates an object should normally destroy it, avoiding mismatched runtimes.

## 37.10 Vtable, Exception, and Standard-Library ABI

C++ specifies virtual dispatch behavior but not vptr location or vtable layout. A common Itanium C++ ABI implementation used by GCC and Clang on many Unix-like targets defines compatible conventions for virtual tables, RTTI, base adjustment, and exception metadata. “Common” is not “universal.”

Adding a virtual function, changing inheritance, or reordering data members can break class ABI. Inline functions in headers can embed behavior in consumers, making a library replacement behaviorally mixed even when symbols still resolve.

Many GCC/Clang targets implement exceptions with unwind tables and no branch on the ordinary path, while throwing searches metadata, runs cleanup, and can allocate. Other targets use different models. Exceptions crossing module boundaries require compatible runtime, RTTI, unwind, and object-lifetime conventions. Do not let exceptions escape a C boundary.

Standard-library types are not stable wire or plugin ABIs by language guarantee. `std::string`, containers, iostreams, debug modes, allocator settings, and implementation namespaces can differ across vendors or ABI configurations. Keep them behind a boundary compiled as one compatibility unit, or expose opaque handles and C-style operations.

Inspect dynamic dependencies and version needs for an artifact you built or otherwise trust. Do not use `ldd` on an untrusted executable; historical implementations and loader behavior can make inspection execute code from the target:

```sh
ldd engine
readelf --version-info engine
readelf -d engine
```

These commands report one built artifact; deployment images remain the final compatibility environment.

## 37.11 Compiler and Library Compatibility

Compatibility has several axes: source language version, compiler frontend, C++ ABI, standard-library implementation, runtime libraries, C library, linker, target ISA, and kernel interfaces. Passing `-std=c++23` addresses only the first category and does not guarantee every C++23 library facility exists.

Clang can use libc++ or libstdc++; the compiler banner alone does not identify the library. GCC and Clang object files may interoperate on an ABI-compatible platform for supported constructs, but LTO intermediate formats generally require matching toolchains.

`-march=native` selects features of the build host. A binary built that way can execute illegal instructions on an older deployment CPU. Build for the fleet baseline or use explicit function multiversioning and startup dispatch. Record the target triple and flags in artifact metadata.

Maintain an ABI smoke test that compiles a consumer against the published interface, links it to the candidate library, and exercises allocation and destruction on the correct side of the boundary. Tools such as ABI comparison checkers can supplement, not replace, contract tests.

Reproducible builds should pin compiler, library, linker, and dependencies. Rebuild and benchmark when any changes; an optimizer upgrade can alter code layout without source changes.

## 37.12 Debug, Release, Assertions, and Instrumentation

A debug build is designed for diagnosis, not production latency. It may disable optimization, materialize temporaries, preserve variables, add iterator checks, and call functions that release builds inline or eliminate. Never extrapolate hot-path timing from it.

“Release” is not one standardized mode. Define flags explicitly. Useful variants include optimized-with-symbols, optimized assertions, sanitizer builds, coverage/PGO generation, and final production. Keep debug information in separate files if deployment size matters; symbols do not inherently slow execution when not mapped into hot code.

Assertions are executable policy. Compiling `assert` out with `NDEBUG` can remove expression evaluation and side effects, so assertion expressions must not perform required work. Critical input validation cannot disappear in release. Internal invariant checks can be sampled or moved to replay tooling when their cost is unacceptable.

AddressSanitizer, UndefinedBehaviorSanitizer, ThreadSanitizer, coverage, and debug iterators change memory layout, synchronization, code, and timing. They discover classes of bugs; they do not predict production latency. Run them on representative tests and retain a separate production-shaped performance build.

Frame pointers improve stack sampling on many Linux setups but consume a register or change code on some targets. Modern unwind information may suffice in other cases. Compare `-fno-omit-frame-pointer` on the actual architecture and profiler.

Sanitizer combinations have constraints. ThreadSanitizer is generally run separately from AddressSanitizer in common toolchains. UndefinedBehaviorSanitizer checks are selectable; recovery mode can continue after a finding, while trap or abort modes change failure behavior. Document the exact set rather than saying a binary is “sanitized.”

Optimization should remain enabled in at least one correctness configuration. Bugs involving lifetime, aliasing, or undefined arithmetic can disappear at `-O0` and emerge when transformations exploit their contracts. An `-O1` or `-O2` sanitizer build often provides a useful balance, while final confirmation uses the documented supported flags.

## 37.13 Reading Loads, Stores, Branches, and Prologues

Assembly literacy begins by mapping data flow, not memorizing every mnemonic. Identify arguments, result, loads, stores, comparisons, control transfers, and stack changes.

A schematic x86-64 pattern makes the method concrete:

```asm
; Representative only; register assignment and spelling vary.
mov     rax, [rdi]       ; load current value through first pointer argument
add     rax, rsi         ; candidate depends on loaded value and delta
jo      .overflow        ; signed-overflow failure edge
cmp     rax, rdx         ; compare candidate with limit
jg      .reject          ; conditional control transfer
mov     [rdi], rax       ; commit store
mov     eax, 1           ; boolean result
ret
```

The load/store pair suggests mutable state, `jo` exposes checked arithmetic, and the store occurs only after both branches. This is not promised output for any C++ function. On AArch64, equivalent work uses different instructions and overflow flags; a compiler might use conditional selection instead of a branch.

```cpp
bool within_limit(std::int64_t position,
                  std::int64_t delta,
                  std::int64_t limit) noexcept {
    if (delta > 0 && position > limit - delta)
        return false;
    return position + delta >= -limit;
}
```

This example itself requires preconditions: `limit - delta`, `position + delta`, and `-limit` must be representable. Assembly inspection cannot repair an invalid arithmetic contract.

Compile focused functions with stable names:

```sh
clang++ -std=c++23 -O3 -S -masm=intel -fno-asynchronous-unwind-tables probe.cpp
g++ -std=c++23 -O3 -S -masm=intel probe.cpp
objdump -drC probe.o
```

Do not use flags that alter production code merely to make assembly prettier when drawing performance conclusions. Source assembly lacks final addresses and link-time transformations; object and executable disassembly answer different questions.

On x86-64, `mov` spellings cover register moves, loads, and stores; operand syntax determines direction. `cmp` or `test` commonly sets flags consumed by conditional branches or conditional moves. On AArch64, load/store and conditional instruction names differ. A back-edge branch often identifies a loop.

Read prologue and epilogue with unwind and calling-convention rules. Stack slots can hold genuine locals, spills caused by register pressure, saved registers, or ABI call arguments. Debug builds exaggerate them.

## 37.14 Recognizing Atomics, Vectors, Division, Virtual Calls, and Hidden Copies

Atomic source operations map according to operation, memory order, target architecture, and compiler. On x86-64, a relaxed atomic load may look like an ordinary load, while a read-modify-write may use a locked instruction. On AArch64, acquire/release instruction forms or exclusive loops are common, with optional large-system extensions on supported targets. Absence of a `lock` prefix does not prove non-atomicity.

Compare source variants in one reproducible probe:

```sh
for opt in O0 O2 O3; do
  clang++ -std=c++23 -$opt -c probe.cpp -o probe.$opt.o
  objdump -drC probe.$opt.o > probe.$opt.dis
done
clang++ -std=c++23 -O3 -flto=thin probe.cpp main.cpp -o probe.lto
objdump -drC probe.lto > probe.lto.dis
```

Do not compare line counts blindly. Search for the named operation, follow relocations and callees, and confirm the harness consumes its result. Pair the inspection with optimization remarks and a production-shaped benchmark.

Vector instructions operate on packed lanes. Register names and mnemonics can indicate SSE, AVX, AVX-512, NEON, or SVE families, but verify target flags and tails. Scalar instructions can also use vector registers. Look for loop trip increments and the number of elements covered per body.

Integer division may appear as a division instruction or as multiply/shift sequences for known divisors. Floating division can become reciprocal approximations only under permitted semantics and target choices. Count dependency chains, not just instructions.

A virtual call commonly loads a function address through object-associated metadata and calls indirectly under vtable-based ABIs. A function pointer or type-erased callable can look similar. Devirtualization removes that pattern when proven.

Hidden copies appear as sequences of loads/stores, `memcpy` calls, copy-constructor calls, or caller-created return storage. Redundant zeroing can arise from value initialization, security hardening, aggregate construction, or compiler inability to prove overwrite. Determine which source lifetime requires it before removing initialization.

Cleanup paths may be placed in cold blocks or exception landing pads. They still affect binary size and can dominate failure latency. Disassemble with relocations and demangled names, then use source interleaving carefully:

```sh
objdump -drC -S engine > engine.disassembly.txt
perf annotate --stdio --symbol=hot_function
```

Never infer cost from instruction count alone. Loads can hit different cache levels, branches can predict differently, and independent instructions overlap. Assembly tells you what work is possible; hardware measurement tells you how this workload executes it.

### Worked investigation: a disappearing risk check

Suppose a microbenchmark reports that a new risk check takes almost no cycles. The check accepts a `const limits&`, an order, and current exposure, then returns an enum. The benchmark uses the same compile-time order in every iteration and counts no reject reasons.

Begin at the final binary, not the source. Locate the benchmark symbol with `nm -C`, disassemble it with relocations, and search for calls or inlined comparisons. If the loop is absent, inspect how its result is consumed. A local enum overwritten on every iteration and never observed permits dead-code elimination. A constant input can also let the compiler evaluate the answer once and remove repeated work.

Repair the harness by constructing runtime inputs before timing and accumulating results into a checksum consumed after the timed loop. Keep the checksum dependency outside individual operations where possible so it does not serialize the kernel being measured. Compile again and verify that the loop now contains the expected loads and comparisons.

Next compare ordinary and LTO builds. In the ordinary build, `check_order` may remain a direct call because its definition is in another translation unit. LTO may inline it, propagate a constant limit version, and delete unused reject-detail construction. Both binaries implement the same benchmark semantics, but they execute different work because the harness exposed constants. Decide whether production sees those constants before deciding which version is representative.

Inspect the calling convention at the remaining boundary. A small `order` aggregate may arrive in registers; a larger diagnostic return may use caller-provided memory. Adding a `std::string` to the result can introduce construction, destruction, and exception cleanup even when the accepted path never populates text. Replacing hot-path diagnostics with an enum and formatting later changes both ownership and ABI.

Now enable optimization remarks. They may report a missed inline due to growth, a vectorization refusal due to aliasing, or devirtualization after type propagation. Validate every interesting remark against linked assembly. A function reported inlined before LTO can be transformed further or removed at link time.

Build a size comparison:

```sh
clang++ -std=c++23 -O3 -g app.cpp risk.cpp -o no_lto
clang++ -std=c++23 -O3 -g -flto=thin app.cpp risk.cpp -o thin_lto
size no_lto thin_lto
nm -S --size-sort -C thin_lto | tail -30
objdump -drC --disassemble=benchmark thin_lto
```

The commands intentionally show no expected output. Binary size alone cannot tell whether hot code grew; map files, symbol sizes, and profiles add location. Stripped and unstripped artifacts should be compared consistently.

Then check target portability. If the build used `-march=native`, record the instructions selected and the build CPU. Rebuild for the fleet baseline. A faster local binary that cannot run on another production host is not an optimization. If multiversioning is used, force each dispatch choice in a test and verify unsupported paths never execute.

Run the optimized benchmark with realistic accepted and rejected distributions. Pin it according to the measurement policy in Chapter 38, pre-touch data, and collect cycles, instructions, branches, and misses in small coherent event groups. Inspect page faults and migrations. Retain raw latency samples and report the final compiler, standard library, linker, flags, profile, and binary build ID.

Finally, compare a production-shaped end-to-end path. The isolated inlined check may fit entirely in the instruction cache, while the application alternates among parsers, books, limit types, and error paths. LTO or templating can duplicate the check across many call sites. If instruction-front-end pressure rises in the combined workload, selectively outlining cold or large pieces may outperform maximal inlining.

### A binary-review checklist

Before accepting a compiler-output claim, answer:

1. Which artifact was inspected: source assembly, object, shared library, or final executable?
2. Which compiler, standard library, linker, target, optimization, LTO, PGO, and sanitizer settings produced it?
3. Are symbol interposition, visibility, and shared-library boundaries the same as deployment?
4. Does the code preserve defined C++ semantics for all admitted inputs?
5. Are loads and stores ordinary data, atomic operations, spills, copies, or ABI traffic?
6. Which instructions form the critical dependency chain, and which can overlap?
7. What data and branch distributions were measured?
8. Did code growth move cost into the instruction cache or callers?
9. Are cleanup, reject, allocation-failure, and exception paths bounded as required?
10. Can the claim be reproduced from a build ID and recorded commands?

Assembly review is most useful when it connects a semantic question to a measurement. “The compiler emitted five instructions” is trivia. “The checked multiply became one overflow-reporting instruction and a predicted reject branch, and replay confirms overflow inputs take the bounded failure path” is engineering evidence.

## 37.15 Interview Check

1. Distinguish the One Definition Rule meaning of `inline` from optimizer inlining.
2. What can LTO expose, and how can it worsen instruction-cache behavior?
3. Why can a benchmarked calculation disappear, and why is `volatile` usually the wrong repair?
4. Compare inlining and devirtualization as language-preserving transformations with different prerequisites.
5. How do aliasing promises affect vectorization, and what happens if a restrict-style promise is false?
6. Explain why passing a small struct by value may be cheaper than passing it by reference under a particular ABI.
7. Design a stable plugin boundary that cannot expose `std::string` or C++ exceptions directly.
8. Which build variants would you use for sanitizers, profiling, and production latency, and why must their timings remain separate?
9. Given assembly containing an indirect call, how would you distinguish a virtual call, function pointer, and PLT call?
10. What evidence would you collect before claiming an atomic, hidden copy, or integer division is expensive in one hot path?
