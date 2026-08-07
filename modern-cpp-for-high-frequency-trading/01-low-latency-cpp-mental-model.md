# Chapter 1 — The Low-Latency C++ Mental Model

Low-latency programming is not a collection of clever C++ tricks. It is the disciplined study of what a program must do, where that work happens, and how unusually slow executions arise. A fast-looking expression may allocate, fault in a page, contend on a cache line, enter the kernel, or wait behind another packet. This chapter establishes a model that separates language semantics from implementations and replaces folklore with testable explanations. Later chapters supply the details; here we learn how to ask the right questions.

## 1.1 Language, Library, ABI, Operating System, and Hardware

A C++ program executes through several contracts. **Language semantics** define the meaning of source constructs. A library specification defines facilities such as `std::vector`. An application binary interface, or **ABI**, defines how separately compiled code interoperates. The operating system supplies processes, virtual memory, scheduling, files, and networking. Finally, the processor and devices execute instructions and move data.

These layers answer different questions. Consider a virtual call:

```cpp
struct Strategy {
    virtual ~Strategy() = default;
    virtual int quote(int market_price) const = 0;
};

int make_quote(const Strategy& s, int price) {
    return s.quote(price);
}
```

C++ guarantees dynamic dispatch to the final overrider. It does not require a vtable, a vptr in each object, or a particular number of instructions. A common Itanium C++ ABI implementation used by GCC and Clang represents the call through a function pointer in a vtable. An optimizing compiler may nevertheless devirtualize the call when it proves the concrete type. The processor may predict the indirect target successfully—or not. Those are four distinct claims.

The same separation applies to a container operation. C++ specifies that `std::vector` stores elements contiguously and gives complexity and invalidation rules for growth. It does not prescribe a growth factor, allocator implementation, or virtual-memory behavior. A common allocator may serve a request from a thread-local cache. Linux may already have mapped the backing pages, or the first write may incur a minor page fault. The memory controller may then fetch a cache line from local or remote NUMA memory.

Use qualified statements:

| Layer | Defensible statement |
|---|---|
| C++ | `vector` elements are contiguous, and reallocation invalidates references. |
| Library implementation | This build grows this capacity from 1,024 to 2,048 elements. |
| ABI/compiler | This optimized build passes the first integer arguments in registers. |
| Linux | This mapping is populated on first touch under the observed configuration. |
| Hardware | This load missed the last-level cache in the measured run. |

Do not slide from one row to another. “References are implemented as pointers” may describe emitted code in a particular case, but it is not a C++ object-model guarantee. “A function call costs five cycles” ignores inlining, calling convention, prediction, cache state, and the callee itself.

This distinction improves both correctness and performance work. It tells you which property is portable, which assumption belongs in a build configuration, and which hypothesis requires measurement on the production machine.

It also clarifies ownership of a regression. Suppose a release gains 20 microseconds at p99.9 after a compiler and kernel upgrade. The C++ source may be unchanged. A compiler could have made a different inlining decision, enlarging a hot instruction path. The dynamic linker could resolve a symbol differently. Linux could schedule network softirq work on the application core. A microcode update could change speculation behavior. The layers provide an investigation tree instead of a guess.

Record dependencies accordingly. A reproducible latency build needs more than a source revision: compiler and standard-library versions, flags, target ISA, linked objects, kernel, firmware, CPU topology, NIC firmware, and relevant runtime configuration all matter. Not every difference is causal, but an unrecorded difference cannot be ruled out efficiently.

Headers and inline functions blur source and binary boundaries. Updating a standard library can change template instantiations in the executable even when the dynamically linked library is unchanged. Link-time optimization can erase ordinary translation-unit boundaries. None of this alters the basic discipline: identify the contract at each layer, then inspect what the selected toolchain produced.

## 1.2 Throughput, Latency, and Tail Latency

**Latency** is the elapsed time for one operation or event to travel between two defined boundaries. **Throughput** is the amount of work completed per unit time. They interact, but they are not interchangeable.

Suppose a market-data handler processes packets in batches of 32. The batch may improve throughput by amortizing a system call and enabling tighter loops. The first packet, however, waits while the batch fills and while earlier packets are processed. A throughput win can therefore increase single-packet latency.

Always state the boundaries. “Order latency” might mean any of these:

```text
feed NIC -> application receives packet
application receives packet -> strategy decision
strategy decision -> send syscall
send syscall -> transmit NIC timestamp
feed NIC -> transmit NIC timestamp
```

These measurements answer different questions. The end-to-end interval contains all of the components and their interactions; the small intervals help localize a change. A measurement without explicit start and end events is not reproducible.

An average also hides the behavior that often matters most. If 99,999 events complete quickly and one event waits for a page fault, a lock owner, or scheduler preemption, the mean barely moves while the unlucky order may miss its opportunity. A **latency distribution** records the range of observations. Tail percentiles such as p99 and p99.9 describe points in that distribution, but they need a sample count, time window, traffic model, and percentile method.

Maxima are useful but sensitive to measurement duration. A one-minute maximum and a week-long maximum are not comparable. Percentiles can also mislead: at p99.999, a run of 50,000 samples contains too little information for a stable estimate. Report counts and histograms, not only a percentile label.

Queueing couples throughput to tail latency. When arrivals temporarily exceed service capacity, a queue grows:

```text
arrival burst ---> [ q q q q q ] ---> handler
                   waiting time       service time
```

Larger buffers can prevent immediate loss, but they do not create capacity. They convert overload into waiting and memory use. A low-latency system therefore needs an explicit overload policy: drop, reject, coalesce, overwrite stale state, shed optional work, or accept unbounded delay. “The queue is large enough” is not a policy.

For each benchmark, record at least:

- the exact interval measured;
- the arrival pattern and offered load;
- warm or cold state;
- distribution, sample count, and run duration;
- whether drops and errors are included;
- CPU placement, build, and machine configuration.

Throughput should also have a denominator that matches the system. Messages per second, packets per second, bytes per second, and orders per second stress different resources. One Ethernet packet can contain several application messages; one message can update several book levels. Reporting only “events per second” makes capacity planning ambiguous.

Service time and response time are different. **Service time** is time spent actively processing an item. **Response time** includes waiting before service. A handler can retain the same service-time distribution while response time explodes because arrival bursts build a queue. Instrumenting only function entry and exit misses the wait before entry. Sequence numbers and receive timestamps can reveal it, provided their clock domains and capture points are understood.

Tail latency composes poorly. If an order passes through ten stages, each having a rare slow event, the probability that at least one stage is slow can be much higher than the probability for any individual stage. Percentiles cannot generally be added: the events may correlate through CPU contention, traffic bursts, or shared locks. Measure end to end, then use component measurements to explain it.

Warm-state measurements and cold-state measurements both matter. A hot benchmark answers how the steady critical path behaves after code, data, translations, and branch predictors have been exercised. A restart, failover, symbol change, or morning-open burst can expose cold behavior. Label the state rather than averaging the two into a number that represents neither.

Chapter 38 develops measurement methodology. For now, remember that optimizing throughput at saturation is not the same problem as minimizing tail latency below saturation.

## 1.3 Semantics Before Optimization

An optimization is valid only if the program remains correct under the applicable contracts. This sounds obvious, yet many “fast” C++ fragments rely on signed overflow, out-of-bounds access, a dangling view, a data race, or an invalid alias. Such a program has undefined behavior; its measured success does not establish correctness.

Take sequence comparison in a protocol with a 32-bit counter. This tempting code is broken:

```cpp
// BROKEN: conversion and overflow assumptions are not a protocol specification.
bool is_newer(std::uint32_t incoming, std::uint32_t current) {
    return static_cast<std::int32_t>(incoming - current) > 0;
}
```

Whether this implements the intended wrap rule depends on constraints that are absent: how far apart sequence values may be, what happens at exactly half the range, and whether conversion of an out-of-range unsigned value behaves as assumed. A correct design first states the protocol invariant, for example that valid forward distance is at most `2^31 - 1`, then expresses and tests that invariant deliberately.

Correctness properties often help the optimizer. If two spans do not overlap, expressing that at an interface or choosing a representation that makes it apparent can enable vectorization. If an object has one clear owner, the program may avoid reference-count updates. If a queue has a fixed capacity and a single producer, its invariants can eliminate allocation and simplify synchronization.

Conversely, weakening semantics can make a benchmark meaningless. Replacing atomic communication with ordinary loads and stores may remove instructions in one build, but it creates a data race. Removing bounds checks may appear faster until malformed input corrupts memory. Enabling floating-point reassociation may alter a risk threshold. Performance engineering includes the failure path.

The safe order of work is:

1. State the observable behavior and invariants.
2. Choose a representation and algorithm that meet them.
3. Identify the expensive work on the relevant path.
4. Change the implementation without changing required semantics.
5. Verify correctness and performance independently.

This also prevents premature focus on syntax. Replacing a range loop with pointer arithmetic rarely matters if the loop blocks on a mutex or follows cache-cold pointers. A clearer formulation can give the compiler more information and make the real bottleneck visible.

Compilation options are part of the semantics boundary. `-O3` changes optimization effort, not the C++ abstract behavior of a well-defined program. Options such as `-ffast-math` relax important floating-point assumptions; they are not merely stronger optimization levels. Architecture flags can introduce instructions unsupported on another deployment host. Record them as requirements, not trivia.

Data validity is another semantics boundary. A decoder that assumes every message type is known might be valid behind a prior validation stage. Move it to a raw socket and the same assumption becomes unsafe. Eliminating duplicate checks is a legitimate optimization only when the interface makes the validated state durable—for example by returning a distinct parsed type that cannot be constructed from unchecked bytes.

Error behavior belongs in the contract. If a bounded queue fills, does an operation return failure, overwrite an old item, block, or terminate? If arithmetic overflows, is the order rejected, saturated, or routed to a slow diagnostic path? Leaving the behavior implicit produces exactly the rare executions that dominate the tail.

Tests should attack invariants, not just examples. For sequence arithmetic, test values around zero, maximum, wrap boundaries, and the largest permitted distance. For a parser, generate truncated lengths and invalid tags. For concurrency, use race detectors where applicable and reason separately about executions the tests did not schedule. A fast common-case test cannot legitimize a missing semantic case.

## 1.4 The Critical Path

The **critical path** is the chain of dependent work that determines when a result becomes available. Work outside that chain may consume resources, but shortening it does not necessarily shorten the event being optimized.

Consider a simplified quote decision:

```text
packet
  |
decode sequence -----> detect gap ---------> recovery signal
  |
decode best price --> update book --> compute quote --> risk check --> send
                              |
                              +------------> diagnostic counter
```

If the immediate objective is feed-to-send latency, the lower chain is critical. The recovery signal may become critical only when a gap occurs. A diagnostic counter is off the dependency chain, but it can still perturb the path through cache-line contention or code footprint.

Dependencies exist inside instructions as well as between functions. In this loop, every iteration depends on the previous value of `sum`:

```cpp
std::uint64_t checksum(const std::uint32_t* p, std::size_t n) {
    std::uint64_t sum = 0;
    for (std::size_t i = 0; i != n; ++i) {
        sum += p[i];
    }
    return sum;
}
```

An out-of-order processor may load several elements ahead, and a compiler may create multiple partial sums or vectorize the reduction. But the final result still requires a reduction chain. If exact arithmetic order is observable—as it can be for floating point—the compiler has less freedom.

The longest-latency instruction is not always the critical path. An independent cache miss can overlap useful computation. A sequence of medium-latency dependent operations may dominate instead. This is why summing instruction-table latencies usually gives a poor model.

Shared resources create dynamic critical paths. A producer may normally publish an item with a cache-hot store. If the consumer repeatedly writes the same cache line, ownership must move between cores, extending publication latency. A logger on another thread may not be logically required for an order, yet a full logging queue can make the producer block. Off-path work has joined the critical path through policy.

Draw the data flow before optimizing. Mark:

- true data dependencies;
- branches that choose a path;
- memory loads and their likely locality;
- synchronization and ownership transfers;
- operations that may allocate, fault, throw, block, or enter the kernel;
- optional work and overload behavior.

The drawing need not model every instruction. Its purpose is to expose which changes can affect the chosen boundary and which merely move cost elsewhere.

Critical paths can change with input. A normal market-data update may touch one book level; a delete can empty that level and update the best-price index; a sequence gap can invoke recovery. Treat these as separate path classes rather than averaging their work. The highest business impact may lie on a rare but valid path.

They can also change with compiler transformations. Inlining removes call/return work and exposes optimization, but it brings the callee’s instructions into the caller. A large cold error path inlined beside the common path can increase instruction-cache pressure. The source-level call graph is a starting point; the optimized control-flow graph is closer to what the processor sees.

When independent work exists, the processor can overlap it. Two independent pointer chains may expose memory-level parallelism; one chain in which every address comes from the previous load cannot. Restructuring a lookup around dense indices may reduce both misses and dependencies. This is usually a larger effect than saving an arithmetic instruction.

Do not remove correctness checks merely because they appear on the diagram. A bounds check may be required on ingress and provably redundant in an internal validated loop. Move or consolidate it only while preserving the invariant. Compilers can often eliminate a repeated check when loop bounds and container extents are visible.

## 1.5 Work, Bounds, and Predictability

A latency explanation should describe both the usual work and its bounds. **Predictability** is the degree to which work and interference remain controlled across valid inputs and operating conditions.

Complexity notation is necessary but insufficient. Hash-table lookup has average constant complexity under suitable assumptions, yet a collision chain can be linear. Insertion may occasionally trigger rehashing, allocate a new bucket array, move or relink elements, and touch many cache lines. A vector append is amortized constant time, but the reallocating append performs work proportional to the current size.

For a hot path, ask what can make one invocation exceptional:

| Operation | Common work | Tail event |
|---|---|---|
| `vector::push_back` with spare capacity | construct at end | none from growth |
| `vector::push_back` at capacity | allocate and relocate | allocator contention or page fault |
| mutex acquisition | atomic fast path | wait, scheduler involvement, convoy |
| socket send | copy/queue data | buffer full, block or `EAGAIN` |
| map lookup | tree traversal | cache/TLB misses along pointer chain |
| log call | format and enqueue | allocation, lock, full queue, I/O |

Bounded work does not mean small work. Scanning a fixed array of one million elements is bounded but unsuitable for a microsecond path. Conversely, an unbounded specification may behave quickly during a short test. Both the bound and its magnitude matter.

Preallocation trades memory and startup work for steadier operation. A fixed-capacity order table can touch and initialize its storage before trading begins, eliminating growth on the live path. It then needs an explicit answer when full. Rejecting a new order is deterministic but may be unacceptable to the business; overwriting an existing entry is likely incorrect. Capacity policy is part of system semantics.

Predictability also depends on other software and hardware. A constant-instruction loop can be interrupted, migrated, throttled, or delayed by a cache miss. The objective is not to promise zero variation. It is to remove avoidable unbounded work, control placement and ownership where operationally justified, and observe residual sources.

Be suspicious of claims such as “lock-free means deterministic” or “no syscalls means no jitter.” A lock-free algorithm can retry indefinitely under contention. A user-space load can page fault. A preempted producer can stall a consumer despite wait-free consumer code. Progress guarantees, memory residency, and scheduling are separate properties.

Amortization deserves special attention. It proves a total cost over a sequence, not a bound on each operation. That is excellent for many applications and inadequate when one order must never pay for earlier cheap operations. Reserve capacity, split maintenance from publication, or select a data structure with an acceptable per-operation bound. Then include the cost of preparation and unused memory in the design review.

Input-dependent work can be bounded at system ingress. A protocol may permit 65,535 entries while the application supports at most 1,024 per packet. Rejecting a larger count before a loop gives the inner code a meaningful bound. The check should use overflow-safe length arithmetic and the rejection path must itself avoid unbounded logging or allocation.

Background maintenance does not become free because it runs on another core. Rehashing a shadow table, rotating a log, reclaiming retired objects, or refreshing a snapshot consumes shared cache, memory bandwidth, and possibly storage bandwidth. Schedule and measure it under representative load. Isolation reduces some interference; it does not create independent memory controllers.

Predictable designs expose capacity through metrics. Monitor queue occupancy, pool high-water marks, rejection counts, page faults, scheduler migrations, and recovery frequency. A capacity limit without a signal turns a controlled failure into a mysterious one.

## 1.6 Memory Hierarchy as Part of the Program

Memory access is not a uniform operation. Registers, core-private caches, shared caches, DRAM, and storage-backed faults differ drastically in work and contention. A program’s data layout therefore participates in its algorithm.

Consider two ways to store active orders:

```cpp
struct Order {
    std::uint64_t id;
    std::int64_t price_ticks;
    std::uint32_t quantity;
    std::uint32_t flags;
};

std::vector<Order> orders;                 // array of structures

struct OrderColumns {
    std::vector<std::uint64_t> ids;
    std::vector<std::int64_t> prices;
    std::vector<std::uint32_t> quantities;
    std::vector<std::uint32_t> flags;
};                                         // structure of arrays
```

If a risk pass reads every quantity and nothing else, the columnar representation transfers fewer irrelevant bytes and may vectorize more easily. If an update uses every field of one order, the array of structures can have better spatial locality. Neither form is universally faster; access pattern decides.

A cache stores fixed-size lines, not individual C++ objects. Reading one byte usually brings its containing line into a cache. Two cores writing different objects that occupy the same line can repeatedly transfer ownership—a phenomenon called false sharing. Padding can separate them, but padding increases memory footprint and can create more cache and TLB pressure. Chapter 16 treats coherence in detail.

Virtual memory adds pages and translation. A pointer-heavy structure can touch one useful value per cache line and one node per page. The same asymptotic lookup in a sorted contiguous array may use cache lines and hardware prefetching far more effectively. Big-O analysis does not account for representation density.

Allocation is also memory-hierarchy behavior. Obtaining an address from an allocator and accessing the page behind that address are distinct events. A pool can make allocation a free-list pop while the first access still faults. “Allocated at startup” is weaker than “written and resident on the intended NUMA node.”

When reviewing a structure, calculate rather than guess:

1. `sizeof` and alignment of each element.
2. Elements per cache line and page.
3. Bytes touched for the common operation.
4. Pointer indirections and dependent loads.
5. Metadata and unused capacity.
6. Which cores read or write each line.
7. Page placement and expected working-set size.

Tools later make this model testable. Compiler layout dumps can expose padding. `perf stat` can count cache and TLB events, subject to hardware support and sampling limitations. `numastat` and Linux page information can help verify placement. Counters support a causal argument; they do not replace one.

The translation lookaside buffer, or TLB, caches virtual-to-physical address translations. A data set can fit in the last-level cache and still suffer TLB misses if it is scattered over many pages. Huge pages increase translation coverage but use larger allocation units and bring operational tradeoffs such as reservation, compaction, and NUMA placement. Chapter 13 treats these choices as Linux memory policy rather than a universal optimization.

Writes have additional costs. A store can require the core to obtain exclusive ownership of a cache line. Writing a field that will not be read soon can evict useful data. Clearing a large buffer touches each line and can trigger page allocation; reserving virtual address space alone usually does not perform that work. Initialization strategy therefore affects both startup latency and steady-state residency.

Prefetchers recognize some regular access patterns, but they cannot generally chase an arbitrary linked list. Software prefetch instructions add work and can fetch unused lines or arrive too late. First improve representation and remove dependent loads. Use prefetch only after a workload-specific measurement identifies enough computation between address discovery and use.

The memory model should be expressed in bytes, lines, and pages for the target configuration. “This object is small” is weaker than “the common lookup reads two adjacent 64-byte lines and one 4 KiB page after warmup.” The second statement is still a hypothesis, but it can be checked.

## 1.7 Compilation and the As-If Rule

The **as-if rule** permits an implementation to transform a program in any way that preserves the observable behavior required by C++. Source statements do not map one-for-one to machine instructions.

For example:

```cpp
int scaled_price(int price) {
    int x = price * 4;
    return x + 7;
}
```

The compiler may combine operations, use an addressing instruction, inline the function, constant-fold a call, or remove it when its result is unused. There is no abstract C++ requirement to create storage for `x`.

This freedom depends on correct semantics. Because signed overflow is undefined, the optimizer may reason that a well-defined execution never overflows `price * 4`. Changing the parameter to an unsigned type gives modulo arithmetic and therefore different permitted transformations. Undefined behavior is not a hidden fast mode; it destroys the contract used to interpret results.

Observable behavior includes interactions such as volatile accesses under the language’s limited volatile rules, file output through the C++ library, and atomic operations as constrained by the memory model. `volatile` does not make ordinary data atomic, establish inter-thread ordering, or generally mean “keep this value in memory.” It is not a benchmarking primitive.

Optimization occurs at several scopes. The front end understands source types and language rules. Middle-end passes propagate constants, remove dead code, simplify control flow, and vectorize loops. The back end selects and schedules target instructions. Link-time optimization can see across translation units; profile-guided optimization supplies observations about likely paths. Each can change code shape and instruction-cache footprint.

Inspecting assembly answers “what did this build emit?”, not “what does C++ always do?” Use an optimized build with realistic target flags:

```sh
g++ -std=c++23 -O3 -march=x86-64-v3 -S -masm=intel example.cpp
clang++ -std=c++23 -O3 -Rpass=loop-vectorize example.cpp
```

Do not copy `-march=native` blindly into release builds. It allows the build host’s instruction set and tuning choices, which may not match deployment machines. Prefer a documented target baseline.

Assembly inspection is especially useful for checking hidden copies, division, indirect calls, vectorization, atomic instruction selection, and unexpected initialization. It does not reveal cache residency, branch outcomes, or scheduler interference. Those require runtime evidence.

Templates and `constexpr` computation can move work from runtime to compilation, but they may create many specialized instruction bodies. A lookup table generated at compile time avoids runtime construction yet occupies the executable and pages that must be mapped and cached. “Compile-time” describes when a value is computed, not whether its bytes disappear at runtime.

Inlining has the same two-sided character. It can remove a call, expose constants, and enable scalar replacement. Excessive inlining duplicates code and can make the instruction working set larger. Profile-guided optimization may improve the decision when training traffic resembles production; unrepresentative profiles can emphasize the wrong paths.

Separate compilation hides facts. A call through a function in another translation unit may remain opaque without link-time optimization. This can be an intentional build-time and ABI boundary. Do not enable LTO solely because a microbenchmark improves: verify link time, binary size, debug and profiling quality, startup behavior, and end-to-end latency.

Compiler diagnostics are evidence too. Optimization records can explain why a loop did not vectorize or why an inline decision failed. Treat the explanation as specific to the compiler version and flags. A source change that persuades one optimizer may be irrelevant to another, so keep the clearer semantic formulation when performance is equal.

## 1.8 Observing Without Distorting

Measurement changes the program being measured. **Observer effect** is the perturbation introduced by timing, logging, tracing, counters, or altered build configuration.

The simplest microbenchmark is often broken:

```cpp
// BROKEN: the optimizer can remove the entire calculation.
void trial() {
    int sum = 0;
    for (int i = 0; i != 1'000; ++i) {
        sum += i;
    }
}
```

Because `sum` has no observable use, an optimized compiler may eliminate the loop. Printing `sum` inside every iteration prevents elimination but measures formatting, locking, buffering, and I/O. A benchmark harness must keep the result alive with minimal interference and inspect the generated code.

Timing calls have cost and ordering semantics. A wall clock can be adjusted and is generally wrong for duration measurement. `std::chrono::steady_clock` is monotonic by contract, but its resolution and implementation are platform properties. Reading a hardware counter such as the x86 time-stamp counter can reduce overhead, yet ordering, clock domain, migration, and frequency properties must be handled. Chapter 18 discusses these mechanics.

Sampling profilers interrupt periodically and attribute observations to code. They usually perturb less than logging every event, but short functions can be underrepresented and skid can move samples. Hardware performance counters can count events such as cycles and cache misses, though multiplexing, speculative execution, privilege settings, and model-specific definitions complicate interpretation.

Use multiple views:

- source invariants and a work model;
- optimized assembly for instruction shape;
- a controlled microbenchmark for a local hypothesis;
- an end-to-end distribution for system impact;
- counters or traces for the proposed mechanism;
- correctness tests and sanitizers in suitable non-production builds.

Instrumentation should have an overload policy too. A per-thread binary ring with overwrite semantics may preserve recent events without blocking the hot path. It still writes memory, changes cache use, and can lose history. An asynchronous logger removes file I/O from the producer but not formatting, queue publication, or full-queue behavior.

Never infer production latency from a debug or sanitizer build. Such builds are valuable for correctness and diagnosis, but their instruction sequences, layout, allocator behavior, and timing differ. Likewise, a release benchmark that omits validation, logging, or synchronization performed in production is measuring another program.

Warmup can hide or expose the wrong mechanism. Repeating one tiny input makes code, data, translations, and predictors unrealistically hot. Feeding random data may destroy locality that production deliberately maintains. Build a distribution from captured or generated workload characteristics while avoiding proprietary data in reusable tests.

Benchmark order can bias results. Running implementation A and then B lets frequency, temperature, background work, and allocator state differ. Interleave or randomize trials where appropriate, run long enough to expose periodic activity, and retain the raw distribution. Rebooting between every trial changes another set of conditions; experimental control means documenting choices, not seeking an imaginary perfectly neutral machine.

Counters should agree with the proposed mechanism. If a layout change is claimed to reduce cache misses, look for fewer relevant misses and reduced cycles under equal work. A falling miss count with unchanged latency may mean the path is limited elsewhere. A faster result with more instructions can be entirely plausible when independent instructions replace a dependent memory access.

Production observation needs timestamps and identifiers that can be correlated across stages. Sequence numbers, bounded event records, and clock-domain metadata are more useful than formatted prose on the hot path. The later logging and timestamping chapters build a full design around this principle.

## 1.9 The Five-Question Analysis Method

The book uses five questions to analyze a C++ or systems mechanism. They correspond to semantics, latency, memory, predictability, and verification.

**1. What is guaranteed?** State the language, library, ABI, kernel, protocol, or hardware contract. Include ownership, lifetime, synchronization, errors, and invalidation. Do not begin with an assumed instruction sequence.

**2. What work occurs?** Identify instructions, branches, dependency chains, calls, copies, allocation, syscalls, cache-line transfers, and waits. Separate work required by the contract from a common implementation.

**3. What storage and traffic result?** Calculate object size, metadata, capacity, pages, cache lines, buffers, and data movement. Ask where the bytes reside and who reads or writes them.

**4. What makes an execution unusually slow?** Look for input-dependent loops, reallocation, collision chains, page faults, contention, preemption, queueing, retransmission, thermal throttling, and error recovery. State bounds and overload behavior.

**5. How will we verify the explanation?** Choose evidence that can distinguish the hypothesis: diagnostics, assembly, layout inspection, tests, sanitizers, benchmarks, counters, traces, packet captures, or kernel statistics.

Apply the method to `std::shared_ptr` copying:

| Question | Analysis |
|---|---|
| Guarantee | The new smart pointer shares ownership; destruction releases ownership. |
| Work | A common implementation updates a control-block reference count, often atomically. |
| Storage | The pointer object commonly holds one or two machine pointers; the control block is separate or co-allocated. Neither layout is specified. |
| Tail | Contention on the count’s cache line and destruction of the final owner can add variable work. |
| Verify | Inspect object size and assembly, then benchmark the actual sharing pattern with pinned threads and counters. |

This method avoids one-word verdicts. “`shared_ptr` is slow” is not useful. A non-final copy on one core, a contended copy across sockets, and final destruction of a large ownership graph are different operations.

It also produces better interview answers. Start with semantics, describe the likely implementation with qualifications, trace the critical path, name the failure modes, and propose an experiment. The result is both technically defensible and operationally useful.

## 1.10 Building and Inspecting the First C++23 Program

Our first program models a bounded operation: compute a quantity-weighted sum for a fixed view of orders. It performs no allocation and makes overflow policy explicit.

```cpp
#include <cstdint>
#include <iostream>
#include <limits>
#include <span>

struct Order {
    std::int32_t price_ticks;
    std::uint32_t quantity;
};

struct NotionalResult {
    std::int64_t value;
    bool overflow;
};

NotionalResult total_notional(std::span<const Order> orders) noexcept {
    std::int64_t total = 0;

    for (const Order& order : orders) {
        const auto price = static_cast<std::int64_t>(order.price_ticks);
        const auto quantity = static_cast<std::int64_t>(order.quantity);
        const auto term = price * quantity;

        if ((term > 0 && total > std::numeric_limits<std::int64_t>::max() - term) ||
            (term < 0 && total < std::numeric_limits<std::int64_t>::min() - term)) {
            return {total, true};
        }
        total += term;
    }

    return {total, false};
}

int main() {
    constexpr Order orders[]{{10'025, 100}, {10'026, 75}, {10'024, 40}};
    const auto result = total_notional(orders);
    std::cout << result.value << ' ' << result.overflow << '\n';
}
```

Build it with warnings and optimization:

```sh
g++ -std=c++23 -O3 -Wall -Wextra -Wconversion -Wshadow \
    -pedantic first.cpp -o first
./first
```

The code uses `std::span`, introduced in C++20, as a non-owning contiguous view. The span does not own the array and must not outlive it. Constructing the span here does not allocate. Its representation is implementation-defined, commonly a pointer and a size for dynamic extent.

The loop count is bounded by `orders.size()`, but the function itself does not impose a maximum. A caller that requires a strict service bound should pass a fixed-extent span or validate the count at an ingress boundary. The function is `noexcept`; it reports arithmetic failure as data. That choice does not make all machine failures impossible, but it rules out C++ exception propagation from this body.

The multiplication is safe because every `int32_t` value and every `uint32_t` value fits in `int64_t`, and their product fits within the signed 64-bit range. The accumulation can overflow, so the code checks before addition. Chapter 2 develops the conversion and overflow rules behind this reasoning.

Generate assembly for the function:

```sh
g++ -std=c++23 -O3 -DNDEBUG -S -masm=intel first.cpp
```

Look for a compact loop containing loads, a signed multiply, overflow comparisons, an addition, and a branch back. Exact instructions vary with compiler version, options, and target. The I/O machinery in `main` is irrelevant to the function’s hot-path model and should not be included in a microbenchmark interval.

Then create a diagnostic build:

```sh
g++ -std=c++23 -O1 -g -fsanitize=address,undefined \
    -fno-omit-frame-pointer first.cpp -o first-sanitized
./first-sanitized
```

Sanitizers do not prove absence of defects and this build is not suitable for latency measurement. They can expose classes of invalid memory use and undefined behavior on exercised paths.

Finally apply the five questions:

- The function reads a valid span and either returns a sum or reports overflow.
- Work is linear in the number of orders, with arithmetic checks per element.
- It reads contiguous `Order` objects and uses constant local storage.
- Cold pages, cache misses, branch outcomes, and an unexpectedly large span can extend latency.
- Warnings, tests at arithmetic boundaries, sanitizer runs, assembly, and a controlled benchmark verify different parts of the claim.

That is the working habit for the rest of the book: make semantics explicit, model the bytes and instructions, identify the tail, and measure the proposed cause.

Keep the command lines, inputs, and observations with the experiment. A conclusion that cannot be reproduced after the next compiler, kernel, or machine change is a useful anecdote, not durable engineering evidence.

## 1.11 Interview Check

1. Why is “a virtual call costs one pointer load and one indirect branch” not a complete statement about C++ or performance?
2. Define latency boundaries for feed-to-trade measurement, and explain why an application timestamp and a NIC hardware timestamp answer different questions.
3. Give an example in which batching improves throughput while worsening latency for an individual event.
4. A vector normally has spare capacity but occasionally grows. Analyze `push_back` using the five-question method.
5. Why can work that is logically off the critical path still affect the critical path?
6. Compare a fixed-capacity queue with a dynamically growing queue in terms of semantics, memory commitment, overload behavior, and tail latency.
7. Why can the compiler remove a benchmark loop, and why is printing inside the loop a poor remedy?
8. What evidence would distinguish branch misprediction from cache misses as the cause of a latency regression?
9. Explain why lock-free progress, memory residency, and scheduler isolation are separate properties.
10. Review `total_notional`: what assumptions bound its work, and what tests would you add at the numerical limits?
