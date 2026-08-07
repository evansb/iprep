# Chapter 18 — CPU Execution and SIMD

Source code does not execute one operator at a time. A modern core decodes instructions into internal operations, predicts control flow, executes independent work out of order, and waits on dependencies that the source may barely reveal. SIMD can multiply useful work per instruction, but only when layout, dependencies, and memory bandwidth cooperate. This chapter builds a practical model without pretending that one microarchitecture's port map or cycle count applies to every deployment CPU.

## 18.1 Pipelines and Out-of-Order Execution

A **pipeline** divides instruction processing into stages so several instructions can be in flight at once. A contemporary high-performance CPU typically fetches and predicts instructions, decodes them, renames architectural registers, schedules ready operations, executes them, and retires their results in program order.

Out-of-order execution changes *when* independent operations use execution units, not the C++ observable behavior. Register renaming removes false name dependencies. A reorder buffer tracks speculative work until it can retire safely. If an older instruction faults or a prediction fails, younger speculative results are discarded.

```text
fetch -> decode -> rename -> schedule -> execute -> retire
                    |           ^           |
                    +-- dependency graph ---+
```

This machinery hides latency only when independent work exists. Four independent cache-resident loads may overlap. A pointer-chasing list forces each address to wait for the preceding load:

```cpp
// Dependent: the next address is data returned by this load.
for (node* p = head; p != nullptr; p = p->next)
    sum += p->value;
```

A cache miss can occupy tracking resources while other work proceeds, but the number of outstanding misses is finite. A full reorder buffer, load queue, store queue, or miss-status structure stops further progress. Tail latency therefore depends on both the slow event and the independent work available to cover it.

Use source-level reasoning to find dependency chains, then verify. `perf stat` can report cycles, instructions, stalled-cycle events, and cache misses when the processor exposes suitable counters. Event names and meanings vary by CPU model; `perf list` is the local source of truth.

The retirement rule is a useful boundary between speculation and program state. A younger load may execute and fill a cache before an older branch resolves, but its register result cannot retire after a misprediction. Precise exceptions likewise appear as though instructions completed in program order. This illusion costs bookkeeping capacity; a long-latency oldest instruction can prevent retirement while the back end fills with younger work.

Front-end stalls and back-end stalls need different remedies. Shrinking code or improving branch locality helps a front end that cannot deliver operations. Adding independent accumulators does little there. Reducing dependent cache misses helps a back end waiting for data. A single “cycles per item” number does not identify which side is limiting.

## 18.2 Superscalar Issue and Execution Ports

A **superscalar** core can start multiple operations in one cycle. Internal operations are dispatched to **execution ports** connected to functional units such as integer ALUs, address-generation units, vector units, and load/store pipelines.

Width is not one number. A core can have different limits for fetch, decode, rename, dispatch, loads, stores, branches, and retirement. An instruction may decode into several micro-operations, and a micro-operation may be eligible for only a subset of ports. Two otherwise independent expressions can contend for the same unit.

For example, a loop may be limited by load ports rather than arithmetic:

```cpp
for (std::size_t i = 0; i != n; ++i)
    out[i] = bid[i] + ask[i];
```

Each iteration needs two loads and one store as well as an addition. Once vectorized, arithmetic may become cheap enough that address generation or memory traffic is the bottleneck.

Port assignments are implementation facts for a particular microarchitecture. Do not describe “x86” as having a single port map. Intel and AMD families differ, as do generations within each family. Static tools such as `llvm-mca` can estimate throughput for a named CPU model; hardware counters validate the complete loop, including front-end and memory behavior.

```sh
clang++ -std=c++23 -O3 -march=native -S -masm=intel loop.cpp
llvm-mca -mcpu=native loop.s
perf stat -e cycles,instructions,branches,branch-misses ./loop_bench
```

Static analysis assumes a model and usually ideal cache conditions. It is a question generator, not a benchmark replacement.

Instruction-cache and decoded-operation-cache capacity place another bound on unrolling and template specialization. Duplicating a small loop for several message types can eliminate branches but enlarge the hot instruction footprint. An isolated benchmark may keep one specialization resident; production may alternate among dozens and miss in the front end. Collect instruction-cache and front-end delivery events where the CPU provides reliable ones.

## 18.3 Data Dependencies and Instruction-Level Parallelism

**Instruction-level parallelism (ILP)** is the amount of independent work a core can execute concurrently. True data dependencies constrain ILP even when abundant functional units are idle.

This reduction has one loop-carried dependency:

```cpp
std::int64_t sum = 0;
for (std::int32_t x : values)
    sum += x;                 // each addition waits for the previous sum
```

Several partial accumulators break the chain:

```cpp
std::int64_t s0 = 0, s1 = 0, s2 = 0, s3 = 0;
for (std::size_t i = 0; i + 3 < n; i += 4) {
    s0 += values[i + 0];
    s1 += values[i + 1];
    s2 += values[i + 2];
    s3 += values[i + 3];
}
const auto sum = (s0 + s1) + (s2 + s3);
```

The transformation changes the grouping of additions. For integers, ensure that no signed intermediate can overflow; signed overflow is undefined. For floating point, regrouping can change rounding and is not generally permitted without an associative-math assumption. Compilers need semantic permission before they make the same change.

ILP can also be exposed by processing several independent messages together. That may improve throughput but delay the first message while a batch forms. HFT code must distinguish single-message latency from steady-state throughput.

## 18.4 Branch Prediction and Speculation

A **branch predictor** guesses control flow before the branch condition has finished computing. A correct guess keeps the front end supplied. A wrong guess discards younger work and redirects fetch, creating a pipeline-recovery penalty whose size depends on the processor and surrounding code.

Predictability depends on data history and code placement, not merely on the fraction of true outcomes. A stable bounds check is easy; a branch driven by near-random order side may not be. Replacing it with arithmetic or a conditional move can help, but branchless code executes work for both logical outcomes and can lengthen dependency chains.

```cpp
// A branch may avoid the expensive path when rejects are rare.
if (quantity > remaining_limit)
    reject(order);
else
    send(order);
```

Speculative execution can issue loads before an older branch retires. Architecturally discarded results can still affect caches and other microarchitectural state. This matters for security-sensitive bounds checks and for measurement: a cache event does not prove that the corresponding source path retired.

Measure `branches` and `branch-misses`, but interpret them with the exact CPU's counter documentation. Compare implementations using the same input distribution and code layout. Profile-guided optimization can improve placement and branch probabilities, yet a production distribution shift can invalidate that training.

Branch hints such as C++20 `[[likely]]` influence optimization rather than forcing a hardware prediction. Compilers may use them for block placement or choose between branch and conditional execution. They are most defensible for strong semantic asymmetry, such as a validated error path, and least useful as a substitute for measured probabilities.

Misprediction counts also need normalization. Ten misses in a hundred branches and ten misses in a million branches represent different predictors and workloads. Report misses per branch and per business operation, then examine whether the miss is on the critical dependency chain.

## 18.5 Micro-Operations, Latency, and Throughput

Instruction **latency** is the delay from an operation's inputs becoming ready to its result becoming available. **Reciprocal throughput** describes how often independent operations of that kind can begin under specified conditions. They answer different questions.

If an integer multiply has several cycles of latency but the core can start one each cycle, a chain of dependent multiplies pays the latency repeatedly; several independent chains can approach the throughput limit. Division often has both higher latency and lower throughput, but exact behavior varies by operand type and CPU.

An architectural instruction may become zero, one, or several micro-operations. Register-to-register moves can sometimes be eliminated during rename. A load combined with arithmetic may split into load and ALU work. Some instruction forms require microcode assistance. Code size and decode-cache behavior can matter even when the execution back end has spare capacity.

When reviewing assembly, ask:

1. What is the longest dependency chain?
2. How many loads, stores, and branches occur per item?
3. Which operations compete for limited units?
4. Does the front end deliver micro-operations fast enough?
5. Is the loop actually waiting for memory?

Vendor optimization manuals and measured instruction databases describe particular processors. C++ makes no latency or throughput guarantee.

### Reading a dependency graph

Consider a normalization kernel:

```cpp
void normalize(const std::int64_t* price,
               const std::int64_t* base,
               std::int64_t* out,
               std::size_t n,
               std::int64_t tick) {
    // Preconditions established by the caller:
    //   tick > 0
    //   every price[i] - base[i] is representable in int64_t
    for (std::size_t i = 0; i != n; ++i)
        out[i] = (price[i] - base[i]) / tick;
}
```

Each iteration has two independent loads followed by a subtraction and a division dependent on that subtraction. The example is a kernel with explicit preconditions, not a checked public API: without them, subtraction can overflow and a zero divisor is invalid. A positive `tick` also rules out the `INT64_MIN / -1` overflow case. Validate these conditions outside the measured loop or use checked/wider arithmetic when the input boundary cannot prove them. Different iterations are independent. If `tick` is a runtime value, integer division may dominate; if it is a compile-time positive constant, a compiler can often replace division with multiplication by a precomputed reciprocal plus shifts and corrections. Signed values and rounding toward zero constrain the transformation.

Compile several versions and inspect the loop. Do not conclude that source `/` always emits a division instruction, or that reciprocal replacement is always cheaper. The compiler may hoist invariant setup outside the loop, vectorize a supported constant divisor, or leave scalar division because the target lacks an efficient vector sequence.

Now suppose `price` and `out` overlap. The iterations may no longer be independent: a store can change a later load. The optimizer may emit a runtime overlap check, choose a safe iteration direction, or decline vectorization. This is why ownership and aliasing appear in a CPU chapter. The hardware cannot recover parallelism that language semantics deny the compiler.

To analyze the emitted code, first count operations per vector or scalar item. Then draw only true result dependencies. Finally compare that graph with resource demand: loads, stores, divisions, and branch operations. Static throughput estimates assume cache hits; a separate working-set experiment decides whether those assumptions apply.

Unrolling exposes more independent iterations but increases live registers. Once register allocation spills an intermediate, the added stack loads and stores can outweigh the ILP gain. Compare `-fno-unroll-loops` only as a diagnostic; production selection should be based on the normal optimizer and representative code context.

## 18.6 Auto-Vectorization

**Auto-vectorization** is a compiler transformation that applies one SIMD instruction to several loop iterations. It is legal only when the compiler can preserve the program's semantics.

```cpp
void scale(const int* __restrict in,
           int* __restrict out,
           std::size_t n,
           int factor) {
    for (std::size_t i = 0; i != n; ++i)
        out[i] = in[i] * factor;
}
```

The non-standard but widely supported `__restrict` qualifier tells GCC or Clang that relevant accesses do not alias. A portable interface can instead enforce disjoint buffers structurally, but C++23 has no standard `restrict`. A false promise is undefined behavior, not a hint the compiler may ignore.

Compilers may generate a scalar prologue, a vector body, and a scalar or masked tail. They may also emit runtime alias or alignment checks and select a vector path only when safe. These checks add branches and code size, though their cost can be amortized over a large range.

Request vectorization diagnostics:

```sh
clang++ -std=c++23 -O3 -march=native \
  -Rpass=loop-vectorize -Rpass-missed=loop-vectorize scale.cpp

g++ -std=c++23 -O3 -march=native \
  -fopt-info-vec-optimized -fopt-info-vec-missed scale.cpp
```

Common blockers include possible aliasing, unknown trip count profitability, function calls with unavailable bodies, loop-carried dependencies, exception behavior, and strict floating-point rules. Inspect diagnostics before rewriting source around a guessed limitation.

Auto-vectorization can improve bulk throughput while making a one- or two-element call slower because of checks and setup. Benchmark the production size distribution.

The compiler may use **loop versioning**: one scalar version handles possible overlap or poor alignment, while a guarded vector version handles the favorable case. If the interface can guarantee alignment and non-overlap, communicating those facts can remove guards. Compiler-specific assumptions such as `__builtin_assume_aligned` become correctness obligations. Assert them in debug and validate allocation paths rather than trusting every caller.

Inlining often determines whether vectorization sees enough information. A small parsing helper compiled in another translation unit may hide aliasing or side effects; LTO can expose it. On the other hand, force-inlining every helper can enlarge code and harm instruction locality. Use optimization remarks and compare LTO builds instead of applying an unconditional attribute.

## 18.7 Explicit SIMD Intrinsics

An **intrinsic** exposes a target instruction family through compiler-provided functions and vector types. Intrinsics provide control over operations and widths but tie code to an ISA and often to a minimum CPU feature set.

```cpp
#include <immintrin.h>
#include <cstddef>

// x86 AVX2 implementation; caller must dispatch only on supported CPUs.
void add8(const int* a, const int* b, int* out) {
    const __m256i va = _mm256_loadu_si256(
        reinterpret_cast<const __m256i*>(a));
    const __m256i vb = _mm256_loadu_si256(
        reinterpret_cast<const __m256i*>(b));
    const __m256i vc = _mm256_add_epi32(va, vb);
    _mm256_storeu_si256(reinterpret_cast<__m256i*>(out), vc);
}
```

The unaligned load/store forms remove an alignment precondition, not all costs associated with crossing cache-line or page boundaries. Compiler intrinsics define the access behavior supported by that compiler; do not generalize the `reinterpret_cast` pattern to ordinary type-punning code.

Production binaries can compile separate scalar, AVX2, and other target versions and dispatch after CPU-feature detection. Per-call indirect dispatch may be undesirable in a tiny hot function, so select a function pointer once during initialization or let the build target a homogeneous fleet.

Explicit SIMD increases maintenance surface: scalar fallback, feature detection, tail handling, testing for every path, and potential numerical differences. C++23 does not include standard `std::simd`; implementations may offer experimental facilities, and a standardized SIMD library arrives in a later language/library revision. State the required compiler and library when using one.

Intrinsics do not guarantee the compiler emits exactly one named instruction. Constant folding, register allocation, instruction selection, and target features still apply. Conversely, several intrinsics can fuse into a more capable instruction. Inspect optimized assembly and test for spills: a theoretically wide calculation can lose when register pressure sends vectors to the stack.

Integer lane width is part of correctness. Eight 32-bit quantity products can overflow independently even when the later 64-bit reduction type is wide. Widen before multiplying, or prove a bound for every lane. Saturating arithmetic is available in some SIMD instruction families, but saturation is usually not the business rule for notional or risk calculations; silently clamping a limit check is dangerous.

### Worked design: validating message lengths

Suppose a packet contains sixteen fixed-endian 16-bit message lengths. The decoder must reject zero, values greater than a protocol maximum, and a sum that extends beyond the packet. This looks ideal for SIMD, but validation and navigation have different dependencies.

Loading and byte-swapping sixteen lengths can be vectorized. Lane-wise comparisons can produce a mask for zero or oversized values. Reducing that mask answers whether any lane is invalid. Computing message offsets, however, needs a prefix sum: each offset depends on earlier lengths. SIMD prefix algorithms exist, but they require lane shifts and additions and must carry totals between vectors.

A safe design first checks that a full length table lies inside the packet, then loads it. It treats lengths as unsigned values and widens before summing so intermediate arithmetic cannot wrap. It rejects before forming any payload pointer beyond the validated packet span. Vector loads use unaligned forms unless the packet-buffer API provides a proven alignment.

The scalar reference is short and authoritative:

```cpp
bool valid_lengths(std::span<const std::uint16_t> lengths,
                   std::size_t payload_bytes,
                   std::uint16_t maximum) {
    std::size_t total = 0;
    for (std::uint16_t length : lengths) {
        if (length == 0 || length > maximum)
            return false;
        if (length > payload_bytes - total)
            return false;
        total += length;
    }
    return total == payload_bytes;
}
```

The subtraction is safe because the invariant `total <= payload_bytes` holds initially and after each accepted iteration. A SIMD version must preserve the first-invalid behavior only if the API exposes an error position; if it returns one boolean, it may compare lanes in parallel. Semantics determine available parallelism.

Test all lane positions, maximum boundaries, byte-swapped values, truncated tables, sums one byte below and above payload size, and packet addresses near a page boundary. Compare every generated case with the scalar reference under AddressSanitizer and UndefinedBehaviorSanitizer. Fuzz the dispatch layer so unsupported CPUs never enter the wide path.

For performance, separate table validation from payload parsing and retain realistic counts. If most packets contain two messages, dispatch and horizontal reduction can overwhelm the saved comparisons. If tables are large, the prefix dependency or packet memory may dominate. Report latency by message count rather than one blended average.

The vectorized validator may also read a full vector where the scalar loop would stop at the first invalid length. Bounds must make that load safe, and the extra work can hurt rejection latency. This is a concrete example of throughput optimization changing failure-path behavior without changing the final boolean result.

## 18.8 Alignment, Gathers, Scatters, Reductions, and Tails

Vector width does not make irregular memory contiguous. A **gather** loads lanes from several addresses; a **scatter** stores lanes to several addresses. They can be useful, but their latency and throughput vary sharply across instruction sets and CPU generations, and cache misses remain cache misses.

Alignment affects both correctness and performance. An aligned intrinsic requires its documented alignment. C++ allocation must provide that alignment, for example with `alignas(32)`, an aligned allocator, or aligned `operator new`. A pointer that merely happens to be aligned in one test does not establish an API contract.

Reductions combine lanes into one result. Their horizontal dependency tree and lane-crossing operations can make them more expensive than independent lane arithmetic. Integer overflow and floating-point reassociation rules still apply.

Tail strategies include:

- a scalar cleanup loop;
- masked vector operations where the ISA supports them;
- padding to a full vector under a documented allocation bound;
- overlapping the final full-width vector, only when duplicate processing is semantically safe.

Masked access is not permission to form or touch invalid addresses unless the intrinsic and target guarantee fault suppression for disabled lanes. Keep allocation boundaries explicit and use sanitizers on scalar and SIMD paths.

Gathering indices from untrusted packets requires bounds validation before the gather. A masked gather can sometimes suppress disabled lanes architecturally, yet speculation and side-channel policy still matter. In ordinary portable C++, an out-of-range pointer or reference can violate language rules before any instruction masking is considered. Convert and validate indices in a representation that cannot overflow, then form addresses.

For short ranges, a scalar path may be both faster and more predictable. Dispatch on `n` only after measuring the crossover and include the branch in the result. If most calls contain one market-data entry, optimizing a 1,024-entry vector loop solves the wrong distribution.

## 18.9 AoS and SoA Revisited

An **array of structures (AoS)** places all fields of one record together. A **structure of arrays (SoA)** places each field in its own contiguous array.

```text
AoS: [px qty side flags][px qty side flags][px qty side flags]
SoA: [px px px ...][qty qty qty ...][side side side ...]
```

AoS favors operations that consume most fields of one order. SoA favors bulk operations over one field, such as comparing eight prices or summing quantities. SoA can load more useful lanes per cache line and avoids dragging cold flags into a price scan.

The choice changes ownership and mutation complexity. Inserting one logical record into SoA updates several arrays consistently. References and iterators no longer identify a complete object. An array-of-structures-of-arrays layout groups a small block of records, balancing vector access with record locality.

Padding is visible differently in the two layouts. An AoS record `{int64_t price; int32_t qty; char side;}` will commonly contain trailing padding to satisfy array element alignment. A SoA stores dense side bytes and dense quantity words separately. The footprint improvement can reduce cache and TLB misses even when no SIMD instruction is used.

SoA also permits different alignment and capacity for each field, which complicates allocation and exception safety. A fixed-capacity HFT structure can allocate one slab and partition it into aligned arrays at startup. Record the partition offsets and assert that total size arithmetic cannot overflow.

Measure representative kernels, not isolated loads. Include cache footprint, update cost, vectorization diagnostics, and the distribution of operations. A limit-order book that updates one level at a time may prefer a different layout from a risk sweep over every instrument.

## 18.10 Wide-Vector Frequency Effects

Wide-vector-heavy execution can alter core frequency or power behavior on some processors. The effect depends on CPU model, instruction mix, active cores, temperature, firmware, and power limits. It is not an inherent property of every AVX2 or AVX-512 instruction.

A throughput improvement inside one vector loop can therefore affect later scalar code or sibling workloads. Frequency transitions may also have hysteresis. Comparing only cycles can hide a lower clock rate; comparing only wall time can hide increased resource occupancy.

A suitable experiment alternates scalar and vector phases of controlled duration while a second pinned thread measures a stable scalar kernel. Record the vector worker's throughput, the observer's latency, core and reference cycles, and package telemetry. Include idle gaps to expose transition recovery. Repeat with one active core and the production number of active cores.

Interpret frequency effects alongside memory bottlenecks. A memory-bound loop may use wide vector instructions but spend most cycles waiting for data, producing little additional power pressure. A compute-dense fused-multiply loop is different. Instruction width alone does not predict the outcome.

Run long enough to reach thermal and frequency steady state, then record both reference cycles and core cycles where supported. Monitor frequency, package power, and throttling with platform tools. Test the complete process mix on deployment-class machines. Do not disable power or thermal controls merely to obtain a cleaner benchmark without understanding operational risk.

## 18.11 Cache Conflicts and Write Allocation

A set-associative cache maps many addresses to the same **set** and can hold only a fixed number of lines from that set. If a working set repeatedly touches more conflicting lines than the associativity permits, lines evict one another even though total capacity appears sufficient. This is a conflict miss.

Power-of-two strides and similarly aligned arrays can create unfortunate set mappings. Padding or changing base alignment may help, but physical indexing and undocumented hash functions make simplistic set calculations incomplete on many processors. Hardware counters and controlled address experiments are more reliable.

Ordinary cached stores commonly use **write allocate**: a store miss obtains the whole cache line in exclusive ownership before modifying it. On common x86 write-back caches this often appears as a read-for-ownership transaction. Initializing a large output array therefore consumes bandwidth for ownership acquisition as well as eventual eviction, unless the architecture can optimize the case.

Cache conflict and write-allocation behavior are hardware properties. They do not change C++ semantics, but they affect whether a theoretically linear pass has stable latency.

A controlled conflict experiment changes one variable at a time: working-set size, stride, base offset, or array count. Use large pages only as an explicit second experiment because they change TLB behavior and physical-address bits together. Randomized address order can distinguish hardware prefetch effects from set conflicts, though it also changes dependency and locality patterns.

## 18.12 Store Buffers and Load/Store Forwarding

A **store buffer** holds retired or nearly retired stores while the cache hierarchy obtains ownership and drains them. It allows later independent execution to continue, but its capacity is finite. A stream of stores can eventually stall when buffers or write-combining resources fill.

A later load may receive data directly from an older buffered store. This **store-to-load forwarding** works best when address, size, and alignment match supported cases. Partial overlap, mismatched widths, or certain boundary crossings can cause a forwarding delay or replay.

```cpp
struct fields {
    std::uint32_t low;
    std::uint32_t high;
};

// Writing one member and immediately loading a wider overlapping object
// through type-punning would be both a semantic and microarchitectural problem.
```

First preserve C++ object and aliasing rules. Then use a microbenchmark with generated assembly to investigate a suspected forwarding stall. Processor-specific performance-monitoring events may expose replays or blocked loads, but event definitions vary.

Store buffers do not make inter-thread communication safe. Visibility and ordering still require C++ atomics or locks. A plain flag after plain data is a data race regardless of how the target drains stores.

## 18.13 Non-Temporal Stores and Software Prefetching

A **non-temporal store** hints that written data is unlikely to be reused soon and should avoid normal cache residency. On supported hardware it can reduce cache pollution and write-allocate traffic for large streaming outputs.

It is a poor default for small or soon-read data. Non-temporal paths have alignment, granularity, and ordering considerations; partial lines may perform badly. On x86, streaming stores are weakly ordered relative to some other memory operations and normally require an appropriate fence before publishing completion to another agent. Use the intrinsic's architecture documentation and then perform C++ synchronization for inter-thread publication.

A **software prefetch** requests a line before ordinary execution needs it. It is only useful when the program can compute the future address early enough and hardware prefetchers do not already cover the pattern. Prefetches consume instruction, cache, translation, and bandwidth resources even when they do not block.

Pointer chasing limits prefetch distance because the next address becomes known late. Processing several independent chains can expose addresses earlier. Keep prefetch targets within valid allocation and mapping assumptions; avoid turning an optimization into speculative access to unmapped or lifetime-ended storage.

Non-temporal stores work best when the application writes complete streams and will not read them before they reach memory coherently. A producer that streams a message into a buffer and immediately hands it to a consumer may force the consumer to wait for write-combining buffers and fetch data that deliberately bypassed its cache. Ordinary cached stores are usually better for small handoff records.

Software prefetch hints can also increase TLB pressure because address translation is part of bringing data closer. Prefetching many future pages may evict translations for present work. Page and cache behavior must be measured together.

## 18.14 Prefetch Distance and Bandwidth Saturation

**Prefetch distance** is the amount of useful work between requesting data and consuming it. Too short, and the demand load still waits. Too long, and the line may be evicted before use or displace more valuable data.

An approximate starting model is:

```text
distance in iterations ~= memory latency / time per iteration
```

Both quantities change with cache level, contention, vector width, frequency, and outstanding requests. Tune across the production working-set range rather than selecting one magic distance.

Prefetching cannot exceed sustainable memory bandwidth. It can merely move requests earlier and increase memory-level parallelism. Once channels or cache-fill resources saturate, more prefetching increases interference. In a multi-core trading system, one background scan can evict hot book state or consume bandwidth needed by packet processing.

Measure bytes processed, cache misses, prefetch-related events where reliable, and latency of co-running critical tasks. A local throughput gain is not a system-level win if it worsens tail latency elsewhere.

## 18.15 `steady_clock`, TSC, Serialization, and Timing Overhead

`std::chrono::steady_clock` is a clock whose reported time does not go backward and whose tick period is constant. C++ does not specify its epoch, implementation, resolution, accuracy, or call cost. On Linux it is commonly backed by a monotonic kernel clock and often served through the vDSO, but verify the standard library and kernel in use.

The x86 **time-stamp counter (TSC)** is a hardware counter read by `RDTSC` or `RDTSCP`. An invariant TSC commonly advances at a constant reference rate independent of normal core-frequency changes. Invariance does not by itself guarantee synchronization across every socket, virtual machine, firmware configuration, or migration event.

`RDTSC` is not a serializing instruction. Out-of-order execution can move measured work across a timestamp unless the program adds suitable ordering. `RDTSCP` waits for older instructions to reach defined completion conditions before returning and reports an auxiliary value commonly used for CPU identity, but it is not a full serializing barrier for all surrounding work. Common x86 measurement sequences use an `LFENCE` with `RDTSC` at the start and `RDTSCP` followed by `LFENCE` at the end; stronger `CPUID`-based sequences cost more. Exact recommendations depend on CPU vendor and generation.

Compiler ordering matters too. An inline-assembly timestamp helper needs a compiler barrier or accurate operands/clobbers so the optimizer cannot move the code being measured. The safest approach is a reviewed platform utility rather than ad hoc inline assembly in each benchmark.

For either clock:

1. measure the empty harness distribution;
2. subtracting a median overhead is not enough for individual tail samples;
3. prevent the measured work from being optimized away;
4. pin the thread or record migration/CPU identity;
5. convert TSC ticks with a calibrated or system-provided ratio, not current turbo frequency;
6. compare against a monotonic reference over long intervals.

Very short regions are strongly perturbed by timestamp instructions, fences, loop control, and cache state. Batch repeated independent operations when measuring throughput. For single-operation latency, retain raw distributions and disclose the harness. A number with more decimal places is not necessarily a more accurate measurement.

### A measurement design for a SIMD risk kernel

Suppose a pre-trade check computes `price_ticks[i] * quantity[i]` for a batch and compares total notional with a limit. Begin with a scalar reference using checked 64- or wider-bit intermediates. Generate adversarial values near numeric bounds and confirm the vector path produces identical accept/reject results. Correctness comes before throughput.

Create separate datasets for hot L1-sized batches, LLC-sized batches, and streams larger than LLC. Include the production distribution of batch lengths, especially zero, one, and tail-sized inputs. Randomize only dimensions that are random in production; randomizing a normally contiguous array measures a different algorithm.

For each implementation, record:

- wall-clock distributions for complete checks;
- cycles and instructions per checked order;
- branch misses and vector path selection;
- cache and TLB misses for each working-set class;
- CPU affinity, SMT placement, frequency state, compiler flags, and target ISA;
- allocation and page-fault counts, which should be zero in the measured region.

Warm code, data, and page tables deliberately, but also run a cold-start experiment if session startup latency matters. Alternate implementation order or use separate processes to avoid always giving the second version warmer predictor and cache state. Keep raw samples so multimodal behavior is not hidden by an average.

Finally, inspect assembly for overflow semantics, vector width, scalar tails, spills, and runtime checks. A result is credible only when the measured binary performs the intended work. If the vector path changes the grouping of floating-point operations or assumes signed overflow cannot occur, it is not equivalent merely because ordinary test values match.

### Verification traps

Microbenchmarks often measure a transformed question. If the result is unused, dead-code elimination can remove the kernel. If every input is compile-time visible, constant propagation can precompute it. If one small buffer is reused, the test measures hot-cache steady state. If samples are timed one by one, clock serialization can dominate.

A defensible harness passes runtime data into a separately observable result, while still allowing normal optimization inside the kernel. A checksum consumed after the timed batch is often enough, provided its dependency does not serialize each iteration. Inspect the measured function in the final linked binary, not only compiler-generated assembly before LTO.

Counter multiplexing is another trap. Requesting more hardware events than available programmable counters makes Linux rotate groups, reducing simultaneous coverage and scaling counts. Run coherent small groups, record the reported time-enabled/time-running values, and avoid comparing heavily multiplexed results as if they were exact. System activity, skid, and speculative counting also limit attribution.

Counter names such as “cache references” are not portable semantic categories. Some count requests at one cache level, some count fills, and some include speculative operations. Use model-specific event documentation and corroborate with controlled changes. If doubling the working set across a predicted cache boundary does not affect the alleged miss event, investigate the event before explaining the program.

Benchmark process placement is part of the input. Pin the benchmark, record its NUMA memory placement, and inspect interrupts and sibling activity. Pinning to a CPU whose sibling runs a busy kernel thread can be less stable than leaving the scheduler some freedom. The purpose is controlled placement, not pinning for its own sake.

Tail samples require diagnosis rather than deletion. Correlate long observations with migrations, page faults, interrupts, frequency changes, and cache misses when tools permit it. Excluding outliers because they are inconvenient destroys the property HFT measurement is meant to reveal. If a separate “isolated hardware” experiment removes them, report both environments and the exact controls.

Finally, compare system impact. Run the optimized kernel beside representative packet and book threads, not only alone. Record their latency while the kernel executes. SIMD that reduces its own CPU time can free shared resources; SIMD that saturates bandwidth or changes frequency can do the opposite. The system result decides.

## 18.16 Interview Check

1. Distinguish instruction latency from reciprocal throughput with an example involving dependent and independent operations.
2. Why can a loop be arithmetic-light yet limited by execution ports or address-generation resources?
3. What semantic conditions commonly prevent a compiler from auto-vectorizing a reduction?
4. Compare scalar cleanup, masked tails, and padded storage for a vector loop that parses network fields.
5. When would SoA improve an order-book calculation, and what update complexity does it introduce?
6. How would you determine whether wide-vector frequency behavior matters on a particular server fleet?
7. Explain write allocation and why a streaming store can consume more memory bandwidth than the payload size suggests.
8. A load immediately follows an overlapping store and is unexpectedly slow. What semantic and microarchitectural checks would you perform?
9. Why can software prefetching improve one benchmark while degrading the latency of a co-located trading thread?
10. Design a defensible short-interval timing harness using `steady_clock` or the TSC, including ordering, migration, and overhead checks.
