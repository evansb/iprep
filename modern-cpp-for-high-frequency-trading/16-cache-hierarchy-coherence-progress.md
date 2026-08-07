# Chapter 16 — Cache Hierarchy, Coherence, and Progress

Low-latency code runs on a hierarchy, not on an abstract uniform memory. A load's result may arrive from a register, a private cache, a shared cache, or DRAM; a store may first require another core to relinquish ownership of an entire cache line. The usual mistake is to call an algorithm “lock-free” or its data “in cache” without asking which core owns which line and which operation must eventually finish. This chapter builds a practical cache and coherence model, then connects it to the precise progress vocabulary used for concurrent algorithms.

## 16.1 Registers, Private Caches, LLC, and DRAM

A modern processor exposes a single C++ address space while implementing several layers of storage. **Registers** are named or renamed CPU execution resources. **Private caches** are associated with a core or hardware thread, while the **last-level cache** (LLC) is commonly shared by a group of cores. DRAM sits beyond the on-chip hierarchy. Exact topology, inclusion policy, capacity, and sharing are properties of the target processor, not of C++.

A useful conceptual path is:

```text
execution units
      |
registers and load/store machinery
      |
L1 data cache       private, small, closest
      |
L2 cache            often private; design varies
      |
last-level cache    often shared in slices
      |
memory controller
      |
DRAM                large, distant
```

This is not a rule that every access checks each box in sequence. Caches are probed in parallel in some designs, misses overlap, data may be forwarded from another core, and hardware prefetchers may have started a request before the program executes its load. On multisocket systems, a remote socket adds another on-chip and interconnect path.

C++ lets the compiler keep values in registers under the as-if rule. A local `std::uint64_t` need not occupy memory at all after optimization. `volatile` does not force every abstract variable into a physical register or provide interthread synchronization. Atomics constrain observable memory behavior, but the processor can still use caches and store buffers while satisfying the architecture's memory model.

Consider a hot order counter:

```cpp
#include <cstdint>
#include <span>

std::uint64_t sum_quantities(std::span<const std::uint32_t> quantities) {
    std::uint64_t sum = 0;
    for (auto quantity : quantities) {
        sum += quantity;
    }
    return sum;
}
```

An optimizing compiler commonly keeps `sum` in a register and streams the input. The data's path depends on whether the cache lines are already present, whether prefetching succeeds, and whether another agent is writing them. The loop can become bandwidth-bound even though each addition is cheap.

Cache capacity is not fully usable capacity. Code, stack, allocator metadata, page tables, other processes, SMT siblings, and the kernel compete for the hierarchy. Set associativity, addressed in Section 16.2, can evict data before nominal capacity is reached. A shared LLC can also be occupied by unrelated cores.

DRAM access has variable service time. Open rows, bank conflicts, memory-controller queues, refresh, NUMA location, and competing traffic affect it. Many outstanding requests can hide some individual latency but consume bandwidth and queue entries. Never attach one universal number to “RAM latency.”

Inspect topology on Linux rather than relying on model names alone:

```bash
lscpu -e=CPU,CORE,SOCKET,NODE,CACHE
find /sys/devices/system/cpu/cpu0/cache -maxdepth 2 -type f -print
numactl --hardware
```

The sysfs cache directories report level, type, size, coherency line size, ways, and shared CPU lists where the kernel knows them. Virtual machines may expose incomplete or synthetic topology, so production placement still needs performance-counter validation.

## 16.2 Cache Lines and Associativity

A **cache line** is the granularity at which a cache stores and normally transfers a block of adjacent bytes. Coherence also commonly tracks ownership at line granularity. Many contemporary x86-64 and ARM64 server processors use 64-byte lines, but neither C++ nor these architecture families universally require that value.

If two 32-bit counters occupy different words in the same line, hardware generally cannot give one core ownership of four bytes and another core ownership of the other four for ordinary cached writes. This fact drives false sharing in Section 16.7.

A cache is usually divided into sets. An address maps to a set, and an N-way set-associative cache can hold N matching lines in that set. A schematic four-set, two-way cache looks like this:

```text
set 0: [tag A | line] [tag E | line]
set 1: [tag B | line] [tag F | line]
set 2: [tag C | line] [tag G | line]
set 3: [tag D | line] [tag H | line]
```

Accessing three frequently used addresses that all map to set 0 causes conflict eviction even when other sets have free entries. Real indexing and replacement policies are microarchitecture-specific, and physically indexed caches interact with page translation.

Object layout determines how many lines an operation touches. Suppose an order-book level is 72 bytes. Even one element spans at least two 64-byte lines under the common line-size assumption, and adjacent elements can share boundary lines. Reordering fields or splitting rarely read metadata may reduce the hot working set:

```cpp
#include <cstdint>

struct HotLevel {
    std::int64_t price_ticks;
    std::int64_t bid_quantity;
    std::int64_t ask_quantity;
    std::uint32_t bid_orders;
    std::uint32_t ask_orders;
};

struct ColdLevelMetadata {
    std::uint64_t last_sequence;
    std::uint64_t last_update_timestamp;
};

static_assert(sizeof(HotLevel) == 32); // verify on the supported ABI
```

The assertion deliberately converts an ABI/layout expectation into a build-time check. It still does not prove that an array begins at a cache-line boundary or that two elements occupy distinct lines.

Line count depends on both size and starting offset. A 64-byte object beginning 16 bytes into a line occupies parts of two lines. An aligned array of 64-byte objects can give each element its own line on a 64-byte-line target, but only if the allocation honors the element alignment and no hidden header is inserted into the element storage. Standard containers honor `alignof(T)` for their elements; a custom arena must do so explicitly.

Associativity also explains surprising stride effects. If a benchmark touches addresses separated by a power-of-two stride, many addresses may select the same small group of sets. Adding a few bytes of padding can improve the benchmark by changing the index pattern, but that result is not a portable “magic stride.” Physical-address bits, cache slicing, huge pages, and processor generation can all change the mapping. Test several sizes and offsets so a layout is not tuned to one accidental alignment.

Alignment can control the start of an object. `alignas(64)` expresses a 64-byte alignment requirement, but hard-coding 64 should be a target-specific policy. C++17 provides `std::hardware_destructive_interference_size` and `std::hardware_constructive_interference_size` when the library supplies meaningful values. They are compile-time hints, can be absent or conservative in practice, and cannot adapt one binary to every machine topology.

Alignment may increase footprint. A 16-byte counter padded to 64 bytes uses four times the array storage, touches more pages, consumes more TLB entries, and can reduce cache capacity. Padding is justified when it prevents measured write sharing, not as a blanket annotation.

Use `pahole`, compiler layout dumps, `sizeof`, `alignof`, and `offsetof` to verify representation. Use cache counters to test the behavioral consequence. A layout diagram is a hypothesis until the target ABI and addresses confirm it.

## 16.3 Spatial and Temporal Locality

**Spatial locality** means accessing nearby addresses close together in time. **Temporal locality** means reusing the same data before it is evicted. Contiguous containers usually exploit both better than pointer-linked structures, but the access pattern matters more than the container's name.

Scanning a `std::vector<Level>` accesses predictable adjacent memory. Traversing a tree performs dependent pointer loads: the address of the next node is unknown until the current node arrives. Even if every node was allocated from one arena, traversal order may not follow allocation order.

```cpp
// Excerpt: HotLevel is defined in Section 16.2.
std::int64_t total_bid(const std::vector<HotLevel>& levels) {
    std::int64_t total = 0;
    for (const auto& level : levels) {
        total += level.bid_quantity;
    }
    return total;
}
```

This array-of-structures scan fetches all fields of `HotLevel` even though it uses one. A structure-of-arrays representation can place bid quantities contiguously:

```cpp
#include <cstdint>
#include <vector>

struct BookColumns {
    std::vector<std::int64_t> prices;
    std::vector<std::int64_t> bid_quantities;
    std::vector<std::int64_t> ask_quantities;
};
```

The columnar form improves spatial locality for one-field scans and may vectorize more easily. It makes insertion, synchronized resizing, and whole-record access more complex. Chapter 11 develops this choice from the container perspective; here the important point is bytes fetched per useful operation.

Temporal locality depends on working-set size and reuse distance. A risk table reused for every order may stay hot. A full instrument universe scanned between uses can evict it. Partitioning work by instrument can improve locality by letting one thread repeatedly touch a smaller state set, while random work stealing can destroy that advantage.

Loop interchange and blocking turn distant reuse into near reuse. For a two-dimensional calculation, process tiles that fit a chosen cache level rather than walking a complete large dimension between reuses. The correct tile size depends on element size, associativity, competing data, vector width, and target cache; it is not simply the published cache capacity.

Linked structures may still win when their semantics avoid much larger work. A tree can answer a sparse ordered lookup without scanning an array. A dense direct-indexed price ladder can be excellent when the price range is bounded, but wasteful or impossible for a huge sparse domain. Complexity and locality must be analyzed together.

Measure locality with realistic keys and order flow. A benchmark over sorted, repeated keys can make a hash table or tree look artificially hot. Production-like skew is relevant: a few active instruments may create excellent locality and intense contention simultaneously.

Hardware counters such as cache references and misses are model- and event-specific. Start with `perf stat` and then select documented events for the deployed CPU. A lower miss count is not automatically faster if the new design executes more instructions or serializes threads.

A useful locality experiment compares layouts without changing the logical work. Preconstruct both representations, generate one fixed key sequence, run enough iterations to amortize setup, and consume the result so the compiler cannot remove it. Report element count, key distribution, memory footprint, page size, CPU placement, and compiler flags. Cold-cache and steady-state runs answer different questions; label them rather than blending them into one average.

## 16.4 Hardware Prefetching and Memory-Level Parallelism

A **hardware prefetcher** predicts future memory accesses and requests lines before demand loads need them. **Memory-level parallelism** (MLP) is the ability to have several cache misses in flight. Both hide latency; neither changes the program's C++ semantics.

Sequential and fixed-stride streams are common prefetch-friendly patterns. Pointer chasing is hostile because each next address depends on the prior load:

```text
independent array loads:  A[i]  A[i+1] A[i+2]  -> several requests can overlap
linked traversal:         node -> next -> next  -> dependent chain
```

An out-of-order core can issue later independent loads while an earlier miss is pending, subject to instruction window, load-buffer, miss-status, TLB, and memory-controller resources. A loop with one dependency chain may experience close to the sum of miss latencies; a loop over independent arrays can approach a bandwidth limit instead.

Prefetching has a timeliness problem. Too late, and demand still stalls. Too early, and the line may be evicted before use. Unneeded prefetches consume cache capacity and memory bandwidth, potentially delaying useful demand from this or another core.

Software prefetch intrinsics are nonportable hints with target-dependent behavior. Use them only after the access pattern and counters demonstrate a demand-miss bottleneck. A compiler may ignore the hint, and an address must still be safe to form under C++ rules even if the hardware would not architecturally fault for a hint.

Prefetchers can cross logical record boundaries and fetch data that the program never uses. That is usually only a performance issue for valid mapped memory, but it matters to cache capacity and bandwidth. Page boundaries, protection attributes, and implementation safeguards constrain how prefetch engines behave; application correctness must never rely on a speculative fetch stopping at a particular boundary.

MLP also depends on address translation. Independent data loads can stall behind TLB misses or page walks, and page walks themselves consume cache and memory resources. Huge pages may increase translation reach, while compact data structures reduce both the number of lines and the number of pages. Evaluate these levers together rather than attributing every back-end stall to the data cache.

Batching can expose MLP. Instead of decoding one message through a chain of lookups before starting the next, a batch may first collect or prefetch lookup addresses and then process results. This can improve throughput but increases queueing delay for the first message and may violate strict per-message latency goals. Batch size is therefore a latency policy, not just a throughput knob.

Large pages can reduce TLB misses for large working sets, but they do not make data-cache misses disappear. They change page allocation, fragmentation, and fault behavior. Similarly, a line prefetched into one core's cache can still require coherence work if another core owns it for writing.

Verify MLP by varying the number of independent streams and measuring cycles per element, bandwidth, cache misses, and stall events. Use documented processor events; generic labels such as “backend stalled” combine many causes. A plateau can indicate bandwidth, request-buffer, or execution limits, so change one dimension at a time.

## 16.5 Latency Versus Bandwidth

**Latency** is the time from initiating one operation until its result is available. **Bandwidth** is the amount of work or data completed per unit time once operations overlap. A subsystem can have high latency and high bandwidth simultaneously.

Imagine a memory path that can service many line requests concurrently. One dependent random load still waits for a complete round trip. Sixteen independent streams can keep the path busy and deliver a high aggregate rate. Optimizing the latter does not necessarily improve the former.

Little's Law connects concurrency, throughput, and time in a stable system:

```text
in-flight work = completion rate × average time in system
```

To sustain bandwidth across a long-latency path, enough requests must be in flight. Those requests occupy finite queues. Near saturation, additional work queues rather than completing proportionally faster, so tail latency grows sharply.

This distinction appears throughout HFT systems:

- batching socket operations raises packets per syscall but delays the first packet;
- vectorizing a price calculation raises elements per cycle but may wait for a full batch;
- combining updates reduces coherence handoffs but makes publication less frequent;
- multiple outstanding memory misses raise bandwidth but compete for cache and DRAM queues.

A benchmark that reports only operations per second measures bandwidth. A benchmark that performs one operation at a time with a dependency between iterations measures something closer to latency, but loop overhead and compiler optimization must be controlled. A production pipeline needs both completion rate and a percentile distribution.

Memory bandwidth is shared. A background scan on another core can increase the target thread's DRAM queueing without changing its instruction count. LLC and interconnect bandwidth can be limiting before DRAM channels saturate. NUMA adds local and remote paths with different contention domains.

Avoid interpreting a cache-miss ratio alone. Ten misses among one hundred operations may be more harmful than one hundred overlapped misses among ten thousand operations. Record absolute events, cycles, instructions, achieved bandwidth, and latency distribution. Use a workload whose dependency structure matches production.

Bounded latency often requires operating away from saturation. Capacity planning must reserve headroom for bursts, interrupts, recovery traffic, and degraded states. Maximum benchmark throughput is usually the point with the least useful latency predictability.

## 16.6 MESI-Family Coherence

**Cache coherence** makes cores agree on the order and value of writes to each coherent memory location. Many processors use a protocol described by MESI-like states: Modified, Exclusive, Shared, and Invalid. Actual server processors use variants, extra states, directories, snoop filters, and different interconnects. MESI is a reasoning model, not a promise about hidden hardware state.

The conceptual states are:

| State | Meaning in the simplified model |
|---|---|
| Modified | This cache has the only valid, dirty copy |
| Exclusive | This cache has the only valid, clean copy |
| Shared | One or more caches may hold clean copies |
| Invalid | This cache's copy cannot be used |

A core can read a Shared line locally. To write it, the core normally needs exclusive ownership and must invalidate other cached copies. If another core has a Modified copy, data and ownership must be transferred or written through the hierarchy according to the implementation. That transfer adds interconnect traffic and delay.

Coherence and consistency are different. Coherence concerns the history of an individual location. The C++ memory model determines when operations on different locations are ordered and visible to threads. A coherent machine does not make a data race defined, and “the hardware eventually sees it” is not a C++ synchronization argument.

On x86-64, the architectural memory model is relatively strong, but compilers can reorder ordinary operations and data races remain undefined. ARM64 permits more hardware ordering behaviors and uses appropriate acquire/release instructions or barriers for C++ atomics. Correct portable code starts from Chapter 14's happens-before rules; coherence explains cost after correctness is established.

Even a relaxed atomic read-modify-write needs ownership of its cache line. `memory_order_relaxed` removes ordering constraints beyond atomicity and modification order; it does not turn a shared increment into a private operation. Conversely, an acquire load of a line already held locally may require no special coherence transaction beyond ordinary validation, though exact instructions and hardware behavior vary.

Read-only sharing scales much better than write sharing because many caches can retain Shared copies. Publication patterns exploit this: construct immutable state privately, publish a pointer with release/acquire synchronization, and let readers avoid modifying the object. Reclamation and pointer publication still require a correct lifetime protocol.

Instruction and data caches are distinct on common cores. Self-modifying code and JIT publication need special synchronization rules at the architecture and operating-system layers, but ordinary C++ applications normally rely on the toolchain and loader to establish executable mappings correctly. More routinely, a large template-heavy hot path can miss in the instruction cache while its data remains hot. “Cache optimization” must name the cache and traffic being optimized.

Some systems include non-CPU coherent agents such as devices, while modern server NIC DMA is coordinated through platform and kernel mapping rules. User code must use the driver or kernel interface rather than assuming that a plain C++ fence flushes device buffers or establishes DMA visibility. Language atomics order participating C++ threads; device ownership follows the platform I/O contract.

Inspecting generated assembly can verify which atomic instructions the compiler chose, but assembly cannot by itself predict whether a line is local, shared, or migrating. Hardware counters for cache-to-cache transfers, snoops, or HITM-like events can help on supported processors. Event names and interpretation are model-specific; consult vendor documentation and validate with controlled experiments.

## 16.7 True Sharing and False Sharing

**True sharing** occurs when threads access the same logical value and at least one writes it. **False sharing** occurs when threads write distinct logical values that occupy the same coherence line. Hardware must still transfer line ownership because it does not know that the fields are independent.

```cpp
#include <atomic>
#include <cstdint>

// POSSIBLE FALSE SHARING: layout and line size are target-dependent.
struct Counters {
    std::atomic<std::uint64_t> received{};
    std::atomic<std::uint64_t> decoded{};
};
```

If one core updates `received` and another updates `decoded`, each modification can invalidate the other's line. The atomics prevent data races but do not prevent cache-line ping-pong. Relaxed ordering may be semantically sufficient for independent statistics and still suffer the same ownership cost.

True sharing is not inherently a bug. A queue index or state flag exists to communicate. The goal is to minimize unnecessary writers and publication frequency while preserving semantics. Local aggregation can replace a global atomic increment on every event:

```cpp
#include <cstdint>

// One counter per owning thread; an observer aggregates periodically.
struct alignas(64) LocalCounter {
    std::uint64_t value{};
};
```

This target-specific sketch prevents adjacent objects from beginning within the same 64-byte region when object size is correspondingly rounded, but it assumes a useful line granularity. It also does not make concurrent non-atomic reads safe. Either the owner publishes atomically, the reader samples under a protocol, or approximate racing access is rejected as undefined behavior.

False sharing can arise between unrelated mechanisms:

- a mutex and the data another thread reads;
- adjacent elements assigned to different worker threads;
- allocator metadata and the first user object;
- ring-buffer producer and consumer indices;
- hot statistics beside read-mostly configuration;
- two independent objects that an allocator places adjacently.

It can also disappear accidentally when a compiler, ABI, or allocator changes layout, making benchmark results fragile. Assert offsets or use deliberate wrapper types for supported targets.

Diagnose false sharing by combining ownership knowledge with evidence. Identify which threads write which fields, inspect actual addresses and line boundaries, and use cache-to-cache or coherence counters where available. Then separate or aggregate the writers and retest. A reduction in misses without a reduction in latency may mean another bottleneck dominates.

Do not confuse false sharing with capacity misses. Both can produce cache activity, but the fixes differ. Padding a capacity-bound array makes it worse. Likewise, do not call concurrent reads false sharing: multiple readers of a clean line are ordinary shared caching.

## 16.8 Cache-Line Ownership and Ping-Pong

**Cache-line ping-pong** is repeated transfer of write ownership among cores. It is the dynamic behavior behind both heavily contended true sharing and write/write false sharing.

An atomic global sequence counter illustrates the path:

```cpp
#include <atomic>
#include <cstdint>

std::atomic<std::uint64_t> global_sequence{0};

std::uint64_t next_sequence() noexcept {
    return global_sequence.fetch_add(1, std::memory_order_relaxed);
}
```

Semantically, each call obtains a distinct value in one atomic modification order. Mechanically, every read-modify-write needs exclusive ownership of the counter's line. With one core, the line can remain local. With many cores, ownership moves and operations serialize around the location. Relaxed order does not change this fundamental serialization.

A mutex under contention has similar coordination traffic even before a thread parks. Waiters repeatedly reading or modifying the lock word can contend with the owner. Good implementations try to limit writes by waiting on reads or queueing locally, but algorithm and workload determine the result.

Partition ownership to eliminate handoffs where semantics permit it. A single writer can allocate sequence ranges to producer threads, or each source can have an independent sequence domain. Range allocation reduces ownership transfers but creates gaps when a producer exits and changes the meaning of sequence order. The semantic tradeoff must be explicit.

Batching updates has the same structure. A thread increments a local count and occasionally adds the batch to a global atomic. This divides coherence transfers by the batch size at the cost of stale global observations and a larger loss window on failure. For risk limits, that staleness may be unacceptable; for telemetry, it is often ideal.

Topology affects ping-pong cost. Cores sharing a nearby cache can exchange a line differently from cores across dies or sockets. NUMA policies do not pin a coherent line permanently to one node; ownership can move while the home memory location and directory participate. Cross-socket contention is commonly more variable and consumes interconnect capacity.

Queue locks such as ticket or MCS-family designs illustrate alternative traffic patterns. A ticket lock gives an ordering but makes waiters observe shared state; an MCS-style lock lets each waiter spin mostly on a local node and hands ownership along a queue. These are implementation techniques, not standard C++ mutex guarantees, and their fairness, memory reclamation, preemption behavior, and uncontended overhead differ.

Measure scaling by increasing participating cores and varying topology: same core's SMT siblings, same cache domain, different die, and different socket. Plot throughput and per-operation percentiles. A cliff as writers increase is stronger evidence of an ownership bottleneck than a one-thread cache benchmark.

## 16.9 Padding and Read-Mostly Placement

**Padding** deliberately separates independently written objects so they do not share a coherence line. **Read-mostly placement** groups data that many threads read while separating it from frequently written coordination state.

A portable source-level wrapper can use the standard interference hint when it is available and sensible for the supported library:

```cpp
#include <atomic>
#include <cstddef>
#include <new>

inline constexpr std::size_t destructive_size =
#ifdef __cpp_lib_hardware_interference_size
    std::hardware_destructive_interference_size;
#else
    64; // documented target policy, not a language fact
#endif

struct alignas(destructive_size) PublishedIndex {
    std::atomic<std::size_t> value{};
};

struct QueueIndices {
    PublishedIndex producer;
    PublishedIndex consumer;
};
```

Check `sizeof(PublishedIndex)` and the actual array behavior. Over-aligned allocation has been supported by the language since C++17, but custom allocators and shared-memory layouts must honor the requested alignment. A packed network structure is not an appropriate home for over-aligned synchronization fields.

Padding solves write ownership, not visibility. Atomics or mutexes are still required when threads conflict. Nor does padding protect against adjacent allocation outside the wrapper. If two separately allocated small objects land on one line, type-internal padding may not help unless object alignment and size force separation.

Read-mostly configuration should be immutable after publication when possible. Place version counters, reference counts, timestamps, and mutable statistics elsewhere. A reader that updates “last accessed” metadata converts a scalable read path into a write-sharing path. If observability needs per-read updates, prefer per-thread counters aggregated asynchronously.

Grouping read-mostly fields can improve constructive interference: one fetched line supplies several values used together. The standard's `hardware_constructive_interference_size` is a hint for this goal, but packing too aggressively can mix fields with different lifetimes or expose sensitive data to speculative access. Layout remains a whole-system choice.

Padding has memory-system costs. A million 64-byte padded entries occupy at least about 64 MB before container overhead, versus 8 MB for a million 64-bit values. More lines mean more cache and TLB pressure, page faults, memory bandwidth during initialization, and NUMA placement work. Use padding for the small number of actively shared coordination objects, not every record.

A useful verification loop is: record writer ownership, inspect layout, measure coherence behavior, apply the smallest separation or aggregation, and repeat the same workload. Preserve an assertion or layout test so a future field addition cannot silently reintroduce sharing.

## 16.10 Blocking, Obstruction-Free, Lock-Free, and Wait-Free Progress

A **progress guarantee** states what kind of completion an algorithm ensures under specified execution conditions. It is not a latency measurement and does not imply fairness.

The standard vocabulary used in concurrent algorithm discussions is:

| Class | Progress statement |
|---|---|
| Blocking | A delayed or failed participant can prevent others from completing |
| Obstruction-free | A thread completes if it eventually runs alone long enough |
| Lock-free | The system as a whole continues completing operations |
| Wait-free | Every participating operation completes in a bounded number of its own steps |

A mutex-protected queue is blocking: a thread descheduled while holding the mutex prevents other participants from entering. A CAS loop may be lock-free when an observed value mismatch means another thread changed shared state and therefore made system progress. A weak compare-exchange may also fail spuriously, so not every failed call proves competing progress. The same unlucky thread can fail indefinitely, and the operation is not necessarily wait-free.

Obstruction freedom is weaker. Two threads can repeatedly interfere without either completing; if one pauses, the other eventually finishes. A backoff scheme may improve practical progress without changing the formal class.

Wait freedom requires a bound on the algorithmic steps for every operation under its model. The bound may be large, may depend on participant count or capacity, and does not bound wall-clock time. A thread can be descheduled between any two steps, fault on memory, or be delayed by hardware. “Wait-free” never means “finishes within a fixed number of nanoseconds.”

Progress depends on the components used. If an algorithm requires an atomic type that is not lock-free on the target and the library implements it with a hidden lock, the overall implementation may be blocking. Check `is_always_lock_free` when portability requires a compile-time property and `is_lock_free()` for the actual object implementation. Even a lock-free atomic does not by itself make the surrounding algorithm lock-free.

Memory allocation and reclamation are part of progress. A lock-free linked structure that calls a blocking general-purpose allocator in `push` does not provide a simple lock-free end-to-end operation. A hazard-pointer scheme can make access safe while reclamation scanning has different bounds. Chapter 17 analyzes these structures in detail.

API failure modes matter too. A bounded wait-free queue may return `full` in bounded steps instead of waiting for capacity. That is often the correct HFT contract: admission is predictable and overload is explicit. Claiming wait freedom while hiding retries in the caller merely moves the unbounded work.

State the guarantee with scope and assumptions: “enqueue is lock-free for a fixed participant set when 64-bit atomics are lock-free; allocation is performed during initialization; full queues return failure.” Anything less precise invites overclaiming.

Crash tolerance is another independent property. Lock freedom says what concurrent operations do while participating threads take steps; it does not promise recovery after process death, corrupted shared memory, or power loss. In an interprocess design, a dead process may leave application-level ownership or reclamation metadata permanently occupied even though individual machine atomics are lock-free. Recovery needs generations, leases, journals, or an external supervisor according to the system contract.

Signals and cancellation do not automatically compose with a progress proof either. An operation interrupted after publishing part of a multi-step descriptor may rely on helpers to complete it. That helping can support lock freedom, but it increases per-operation work and complicates ownership. State whether participants may disappear mid-operation and which state remains reachable when they do.

## 16.11 System-Wide Versus Per-Operation Guarantees

Lock freedom is a **system-wide** guarantee: some operation completes despite contention. Wait freedom is a **per-operation** guarantee: each operation has a step bound. This distinction determines whether an individual order or feed can starve.

Consider a shared compare-exchange counter:

```cpp
#include <atomic>
#include <cstdint>

void add_saturating(std::atomic<std::uint32_t>& value,
                    std::uint32_t increment,
                    std::uint32_t limit) noexcept {
    auto current = value.load(std::memory_order_relaxed);
    for (;;) {
        if (current >= limit) return;
        const auto room = limit - current;
        const auto next = current + (increment < room ? increment : room);
        if (value.compare_exchange_weak(current, next,
                                        std::memory_order_relaxed,
                                        std::memory_order_relaxed)) {
            return;
        }
        // On failure, current has been updated. Another writer may have progressed.
    }
}
```

Assuming the atomic itself is lock-free, a failure caused by a value mismatch indicates competing modification; `compare_exchange_weak` may additionally fail spuriously. The arithmetic is unsigned and the `current >= limit` check prevents subtraction underflow; requirements such as whether a zero increment is meaningful still belong to the API. Aggregate completions can remain high while one thread repeatedly loses. A latency histogram aggregated across all threads can hide that starvation. Report per-thread or per-key distributions where fairness matters.

Scheduler progress is separate from algorithmic progress. Formal lock-free analysis usually assumes threads continue taking steps. A pinned high-priority spinner can prevent another required participant from running on an oversubscribed CPU. Conversely, a lock-free algorithm can make progress when a participant is paused if some other participant can complete without it.

Memory reclamation can couple participants. Epoch reclamation may delay freeing memory while one thread remains in an old epoch. Operations may continue, satisfying lock freedom, while unreclaimed memory grows. The system's progress guarantee and its resource-boundedness are different properties.

Fairness is also independent. A fair mutex may provide strong admission ordering while remaining blocking. A lock-free stack may have excellent aggregate throughput and poor per-thread fairness. A wait-free algorithm provides a step bound but can still have different bounds for different operations or participants.

For HFT design, specify several properties separately:

- completion class under contention;
- maximum algorithmic retries or steps;
- behavior when a bounded structure is full or empty;
- reclamation and memory-growth bound;
- scheduler and affinity assumptions;
- fairness by thread, instrument, client, or order;
- observed wall-clock percentile under representative load.

Verification needs adversarial schedules, not only uniform load. Pause one participant, run a writer at a different priority, oversubscribe CPUs, fill the queue, and delay reclamation. Formal reasoning establishes progress class; stress tests reveal whether its assumptions match deployment.

## 16.12 Why Lock-Free Is Not Automatically Faster

A **lock-free** algorithm avoids one class of global blocking, but it can perform more atomic read-modify-write operations, retries, cache-line transfers, metadata accesses, and reclamation work than a mutex-based alternative. Progress and performance answer different questions.

In the uncontended case, a good mutex can take one short atomic fast path and release it. A lock-free structure may require several atomics and pointer operations on every call. Under moderate contention, failed CAS attempts waste work and amplify ownership traffic. Under extreme contention, a queueing mutex can park losers while a lock-free loop keeps every core competing.

Lock-free designs also move complexity into lifetime management. A mutex can protect removal and destruction in one critical section. A lock-free linked structure needs hazard pointers, epochs, reference counting, or bounded non-reclamation. These add reads, writes, scans, delayed destruction, and memory footprint. Bugs can become rare use-after-free failures rather than obvious lock-order failures.

On the other hand, lock-free progress is valuable when a participant may be descheduled or fail while others must continue, and when the workload partitions contention well. An SPSC ring can be both simple and fast because each index has one writer and storage is preallocated. “Lock-free” is not one design category: a contended MPMC queue and an SPSC ring have radically different traffic.

Compare complete operations with equal semantics. A bounded lock-free queue that drops on full is not equivalent to a mutex queue that blocks indefinitely. A mutex snapshot with strict consistency is not equivalent to a lock-free approximate statistic. Align capacity, overload policy, memory reclamation, ordering, and fairness before benchmarking.

Benchmark at least these regimes:

1. one producer and one consumer without contention;
2. realistic producer/consumer counts and topology;
3. bursts that fill the structure;
4. a paused or preempted participant;
5. cross-socket placement;
6. long enough execution to exercise reclamation and allocator behavior.

Record throughput, per-operation percentiles, maximum observed retries, CPU time, context switches, cache-to-cache traffic, allocation, and resident memory. Do not optimize to a single average.

Include an idle case as well. A blocking queue can park with almost no CPU consumption while a polling lock-free queue continuously loads shared indices. The polling version may wake faster from a short idle interval yet heat the package, interfere with SMT siblings, and change frequency behavior. If deployment dedicates a core, that may be intentional; the benchmark report should price the core rather than treating CPU time as free.

Also inspect code size and instruction footprint. Generic lock-free structures often instantiate several complex paths for each element type, while a mutex wrapper may call a compact library slow path. Conversely, an out-of-line mutex function can add call overhead on a tiny fast path. Compile the actual configuration, inspect optimized assembly, and use instruction-cache counters before choosing based on source-level complexity.

A mutex can be the more predictable choice when critical sections are short, contention is rare, ownership is simple, and sleeping under overload is acceptable. A single-writer architecture can outperform both by removing shared mutation. Lock-free is appropriate when its progress property solves a real failure or scheduling requirement and its coherence pattern is favorable.

The durable decision rule uses all five lenses. Prove semantics and lifetime first. Count atomics, retries, line writers, and allocation. State the progress and overload guarantees. Measure tails on the actual topology. Choose the simplest design that satisfies those requirements.

## 16.13 Interview Check

1. Explain why “the data is in cache” is incomplete. Which cache, owned by which core, and in what coherence state might matter?
2. How can a working set smaller than a cache's advertised capacity still suffer conflict misses?
3. Compare a contiguous scan and a linked traversal in spatial locality, prefetchability, and memory-level parallelism.
4. Distinguish memory latency from bandwidth. Why can batching improve one while worsening per-message latency?
5. What does the MESI model help explain, and what C++ synchronization property does it not provide?
6. Two threads update separate relaxed atomic counters. Why can they still interfere, and how would you verify false sharing rather than merely suspect it?
7. When does padding improve latency, and which cache, TLB, page, and memory-footprint costs can it introduce?
8. Distinguish obstruction freedom, lock freedom, and wait freedom. Which guarantees system-wide progress, and which gives a per-operation step bound?
9. A CAS loop is lock-free but one thread's p99.99 latency is extreme. Explain how aggregate progress and individual starvation can coexist.
10. Design a fair comparison between a mutex queue and a lock-free queue, including capacity, overload, reclamation, topology, and measurements.
