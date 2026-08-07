# Chapter 17 — Lock-Free Structures and Reclamation

Lock-free code removes a particular source of blocking; it does not remove coordination, cache misses, retries, or lifetime problems. A queue can publish values correctly and still corrupt memory when a node is reclaimed too early. This chapter builds several bounded structures from explicit invariants, then separates access synchronization from reclamation. The recurring questions are simple: who may mutate each word, what event publishes data, and what proves that storage is no longer reachable?

## 17.1 SPSC Ring-Buffer Invariants

A **single-producer, single-consumer ring buffer** has exactly one thread that advances the write index and exactly one thread that advances the read index. That restriction is the source of its simplicity. Neither index needs a read-modify-write operation because it has only one writer.

Consider a ring with `N` slots and monotonically interpreted positions `head` and `tail`:

```text
producer owns head                         consumer owns tail
        |                                          |
        v                                          v
  [used][used][free][free][free][free][used][used]
              ^                             wrap --+
```

The invariants are:

- the producer writes a slot before publishing the new `head`;
- the consumer observes the published `head` before reading that slot;
- the consumer finishes reading before publishing the new `tail`;
- the producer observes the published `tail` before reusing that slot.

Here is a fixed-capacity implementation that deliberately leaves one slot unused. It therefore stores at most `N - 1` elements. `N` must be a power of two so masking can replace remainder division.

```cpp
#include <array>
#include <atomic>
#include <cstddef>
#include <utility>

template<class T, std::size_t N>
class spsc_ring {
    static_assert(N >= 2 && (N & (N - 1)) == 0);

public:
    bool try_push(T value) {
        const auto h = head_.load(std::memory_order_relaxed);
        const auto next = (h + 1) & mask;
        if (next == tail_.load(std::memory_order_acquire))
            return false;

        slots_[h] = std::move(value);
        head_.store(next, std::memory_order_release);
        return true;
    }

    bool try_pop(T& out) {
        const auto t = tail_.load(std::memory_order_relaxed);
        if (t == head_.load(std::memory_order_acquire))
            return false;

        out = std::move(slots_[t]);
        tail_.store((t + 1) & mask, std::memory_order_release);
        return true;
    }

private:
    static constexpr std::size_t mask = N - 1;
    std::array<T, N> slots_{};
    alignas(64) std::atomic<std::size_t> head_{0};
    alignas(64) std::atomic<std::size_t> tail_{0};
};
```

This version constructs all `T` objects with the ring. That is convenient but may do unwanted initialization and requires `T` to be default-constructible and assignable. A production ring can instead keep raw, suitably aligned storage and start and end object lifetimes explicitly. Such a change is not merely an optimization: it adds exception and lifetime obligations. Hot-path rings commonly restrict `T` to nothrow construction and destruction.

The ring's indexing and synchronization perform a bounded number of steps and contain no allocation. The complete generic operations inherit the behavior of `T`: argument construction and move assignment may allocate, block, or throw. A hot-path instantiation therefore needs a documented, usually nothrow and allocation-free element contract. Even then, the calls are not wait-free in the application-level sense of “eventually succeeds”: `try_push` may keep reporting full, and `try_pop` may keep reporting empty. Each call completes in a bounded number of queue-bookkeeping steps.

The fixed array also makes object destruction predictable: destroying the ring destroys all `N` slot objects, including logically empty ones. If `T` owns memory, cleanup can be substantial. A raw-storage version destroys each element on pop instead, but then shutdown must visit any elements still logically present. Capacity, construction policy, and shutdown behavior should be selected together.

An SPSC claim is a type-level contract, not a hope about deployment. Accidentally attaching two producers makes the relaxed load and store of `head_` lose updates even though `head_` itself is atomic. Consider binding producer and consumer endpoints into distinct non-copyable types so only the producer endpoint exposes `try_push` and only the consumer endpoint exposes `try_pop`.

## 17.2 Acquire/Release Publication

A **release operation** makes preceding actions in its thread available to an acquiring observer that reads from the release or its release sequence. An **acquire operation** prevents subsequent actions from being observed as if they occurred before the synchronization.

In `try_push`, the ordinary assignment to `slots_[h]` is sequenced before the release store to `head_`. When the consumer's acquire load observes that store, the slot assignment happens-before the consumer's read. The reverse handshake uses `tail_`: the consumer reads the slot before its release store, and an acquiring producer observes that the slot may be reused.

```text
Producer                                  Consumer
--------                                  --------
slot = value                              h = head.load(acquire)
head.store(next, release)  ----------->   read slot

t = tail.load(acquire)     <-----------   tail.store(next, release)
reuse slot                                finished with slot
```

The owner's load of its own index is relaxed because no other thread writes that index. Changing every access to sequential consistency can make the code easier to review initially, but it does not repair a missing invariant. Conversely, changing all operations to relaxed creates a formal C++ data race on `slots_`, even if a particular x86-64 test appears to work.

On x86-64, acquire loads and release stores commonly compile to ordinary loads and stores because the hardware memory model already supplies the required load/store ordering. On ARM64, GCC or Clang commonly uses acquire and release instruction forms such as `ldar` and `stlr`. These are implementation observations, not permission to weaken the source program.

Use ThreadSanitizer to test the implementation, but do not treat a clean run as proof:

```sh
clang++ -std=c++23 -O1 -g -fsanitize=thread ring_test.cpp -pthread
```

A stress test should vary producer and consumer pacing, force index wraparound repeatedly, and verify a monotonically increasing sequence number in every payload.

Release/acquire synchronization is conditional on what the acquire observes. If a consumer reads an older head value and reports empty, no publication edge has been established for a newer item; that is allowed for a nonblocking poll. The next poll will try again. The algorithm never reads a slot merely because “the producer probably wrote it by now.” It first observes the publishing index.

This distinction is useful during code review. Mark each ordinary memory access, then draw the exact atomic edge that orders it. If an access has no edge, making a nearby atomic stronger may still leave it unordered. The proof should name the release operation, the acquire operation, and the value relation connecting them.

## 17.3 Index Separation, Capacity, and Wraparound

An index design must distinguish full from empty and must remain correct when its integer representation wraps. There are two common designs.

The first stores masked slot indices and reserves one slot. `head == tail` means empty; advancing `head` into `tail` means full. Its usable capacity is `N - 1`, as in Section 17.1.

The second stores monotonically increasing unsigned tickets. The slot is `ticket & (N - 1)`, empty means `head == tail`, and full means `head - tail == N`. Unsigned subtraction is defined modulo `2^w`; correctness requires the live distance never to approach the ambiguity boundary. A 64-bit counter makes physical wraparound remote, but “remote” is not a proof. State the bound and test a reduced-width model that wraps frequently.

Separating the index atomics onto different cache lines prevents the producer's writes to `head` from invalidating the consumer's line containing `tail`. `alignas(64)` is an x86-oriented choice, not a universal cache-line guarantee. C++17 provides `std::hardware_destructive_interference_size` when the implementation defines it usefully, but build configuration and target hardware still matter.

Capacity is an overload policy. A bounded ring must say what happens when full: reject, overwrite the oldest value, spin for a bounded interval, or divert to a slower path. Silent overwrite is especially dangerous for order and risk messages. The chosen behavior belongs in the interface—`try_push` makes rejection explicit.

Index types affect memory footprint and generated code. Two 64-bit counters are insignificant alone but padding them to separate lines consumes at least two lines per queue. Thousands of per-instrument queues can turn padding into a large LLC and TLB footprint. Group queues by active ownership and measure whether avoiding false sharing is worth the extra residency; alignment is not free.

## 17.4 Bounded MPMC Queues

A **multiple-producer, multiple-consumer queue** permits several threads to claim positions concurrently. Producer- and consumer-owned plain indices are no longer sufficient. Threads need atomic claims, and each slot needs a state that distinguishes different trips around the ring.

A common bounded design assigns a monotonically increasing ticket with `fetch_add` or compare-exchange and gives every slot a sequence number:

```text
enqueue ticket p
  slot = cells[p % N]
  wait until slot.sequence == p
  construct value
  slot.sequence = p + 1          // publish to consumers

dequeue ticket c
  slot = cells[c % N]
  wait until slot.sequence == c + 1
  consume and destroy value
  slot.sequence = c + N          // publish reusable slot
```

The sequence number prevents a producer from confusing “this slot was free one lap ago” with “this slot is free for my ticket.” Publication uses release stores; observation uses acquire loads. Position claims are often relaxed because per-slot sequences carry the data synchronization, but that conclusion depends on the complete algorithm.

This sketch omits important policy. An unconditional `fetch_add` can reserve a position even when the queue is full, potentially forcing a caller to wait behind its reservation. A nonblocking `try_enqueue` commonly uses compare-exchange after inspecting slot state so it can report full without leaving a hole. Exception-throwing construction can also strand a claimed cell. Production variants normally require nothrow payload construction or encode an explicit cancelled state.

Queue linearizability must be stated. A successful enqueue commonly linearizes when its slot sequence is published, not when it first claims a ticket. This matters if a slower producer claims an earlier position and a faster producer fills a later one. A FIFO consumer may be forced to wait at the earlier hole even though later data is ready. The queue remains ordered, but head-of-line blocking appears without a mutex.

That behavior can be desirable for order preservation and undesirable for independent market-data channels. Sharding by symbol or producer can replace one contended MPMC queue with several SPSC queues and an explicit merge. The merge then owns fairness and ordering policy rather than hiding both in compare-exchange contention.

MPMC queues trade memory for concurrency. Each slot contains payload storage and a sequence atomic; padding slots to avoid false sharing may greatly increase footprint. More producers also contend on an enqueue position or adjacent sequence lines. Measure both total throughput and per-thread tail latency under the intended producer/consumer ratio.

## 17.5 Per-Slot Sequences, Contention, Fairness, and Starvation

A per-slot sequence is both a generation tag and a small state machine. Its comparisons must be defined across wraparound. Avoid casually converting a large unsigned difference to a signed type: the result may be implementation-defined when it is not representable. Either use a proven modular comparison with a documented maximum live distance or use sufficiently wide counters and test the formal boundary separately.

Lock-free progress does not imply fairness. One producer can repeatedly win compare-exchange while another repeatedly reloads and retries. Cache topology, SMT siblings, preemption, and NUMA placement can amplify this imbalance. Even when the queue as a whole makes progress, an individual operation may starve.

Instrument retries per operation rather than reporting only aggregate operations per second. Useful measurements include:

- a histogram of compare-exchange failures;
- maximum time or attempts before success;
- throughput and percentile latency per thread;
- cache-to-cache transfers, where supported by `perf c2c`;
- migrations, involuntary context switches, and CPU affinity.

Batching can reduce contention by claiming several consecutive tickets at once, but it weakens fairness and increases the time a partially filled batch blocks later positions. The optimal batch size is workload-specific.

## 17.6 Treiber Stacks and ABA

A **Treiber stack** stores an atomic pointer to the top node. Push links a new node to the observed top and replaces the top with compare-exchange. Pop replaces the observed top with its successor.

```cpp
struct node {
    int value;
    node* next;
};

std::atomic<node*> top{nullptr};

void push(node* n) noexcept {
    n->next = top.load(std::memory_order_relaxed);
    while (!top.compare_exchange_weak(
        n->next, n,
        std::memory_order_release,
        std::memory_order_relaxed)) {
    }
}
```

The matching pop is not safe merely because the compare-exchange is correct. Suppose thread A reads top pointer `A` and `A->next`. Thread B pops `A`, pops another node, and pushes the same address `A` again. Thread A's compare-exchange sees the expected address and succeeds, although the logical stack changed from A to B and back to A. This is the **ABA problem**.

Worse, B might free `A` before A dereferences `A->next`. That is a use-after-free independent of ABA. A correct stack needs both logical-change detection where necessary and safe reclamation. Hazard pointers, epochs, or a bounded no-reuse policy address lifetime; a tag can help detect ABA.

An interleaving makes the distinction concrete:

| Step | Thread A | Thread B | Top |
|---|---|---|---|
| 1 | load `A`; plan replacement `B` | | `A -> B -> C` |
| 2 | pauses | pop `A` | `B -> C` |
| 3 | | pop `B` | `C` |
| 4 | | push address `A` with new contents | `A -> C` |
| 5 | CAS expected `A`, desired old `B` succeeds | | `B -> C` (corrupt) |

The address comparison missed logical change, so this is ABA. If B also deleted address `A` at step 2, A's earlier read of `A->next` may already be a lifetime violation; a tag on `top` alone would detect the failed CAS but would not make that dereference safe.

A safe pop with hazard pointers first protects the observed top, validates that top is still the same, and only then reads `next`. After a successful CAS it retires the removed node rather than deleting it. With epochs, the traversal and CAS occur inside a protected epoch, and deletion waits for a grace period. The linearization point and reclamation point are different events.

Test stacks with aggressive address reuse. A general allocator may not quickly reuse the same address, allowing ABA bugs to hide. A test pool that cycles two or three nodes forces the vulnerable pattern. Combine that with delayed threads and a small version tag in a model build to expose both ABA and tag wraparound.

## 17.7 Tagged Pointers and Width Constraints

A **tagged pointer** atomically compares a pointer together with a version counter. Every successful top change increments the version, so `(address A, version 7)` differs from `(address A, version 9)`.

```text
atomic head word
+-------------------------+-------------+
| pointer representation  | generation  |
+-------------------------+-------------+
```

C++ does not guarantee unused pointer bits, a particular canonical-address rule, or that a pointer-plus-counter structure is lock-free. Packing a pointer into an integer requires `std::uintptr_t` to exist and still does not make arbitrary bit stealing portable. On systems with pointer authentication, memory tagging, capability pointers, or wider virtual addresses, a once-valid encoding may fail.

An `std::atomic<tagged_head>` is the portable expression of intent, but `is_always_lock_free` may be false and operations may call a hidden library lock. A double-width compare-exchange instruction may be available only with alignment and CPU-feature constraints. Verify all three layers:

```cpp
static_assert(std::is_trivially_copyable_v<tagged_head>);
static_assert(std::atomic<tagged_head>::is_always_lock_free,
              "this deployment requires lock-free tagged heads");
```

Then inspect the linked binary for helper calls such as atomic library routines and test deployment CPUs. Tag wraparound remains possible. The maximum number of reuse cycles while a stale observer can remain active must be less than the tag's unambiguous range.

Alignment-based packing deserves the same caution as high-bit packing. If nodes are aligned to 16 bytes, their low four address bits are zero and can often carry a tag in a deployment-specific representation. But converting back must reconstruct exactly the original pointer representation, the allocator must preserve the promised alignment, and sanitizers or pointer-tagging hardware may change assumptions. Encapsulate packing in one platform layer with static and startup checks.

A wider tag expands a bound; it does not replace one. If a thread can be stopped indefinitely while other threads recycle a node without bound, every finite tag can wrap. Reclamation that prevents reuse while a stale observer exists can remove the need for a large tag, depending on the structure's ABA sensitivity.

## 17.8 Seqlocks and Standards-Correct Readers

A **sequence lock** lets a writer bracket an update with an odd/even sequence counter. A reader accepts its snapshot only if it observed the same even counter before and after copying the fields.

The classic kernel pattern copies non-atomic fields concurrently with a writer. Transcribed directly into C++, that program has a data race and undefined behavior. The final sequence check does not erase the race. A standards-correct C++ implementation must make concurrently accessed fields atomic, protect them with another mechanism, or publish immutable objects.

This simplified form assumes writers are externally serialized:

```cpp
struct quote_snapshot {
    std::atomic<unsigned> sequence{0};
    std::atomic<int> bid_ticks{0};
    std::atomic<int> ask_ticks{0};
};

void write(quote_snapshot& q, int bid, int ask) {
    q.sequence.fetch_add(1, std::memory_order_seq_cst); // odd
    q.bid_ticks.store(bid, std::memory_order_seq_cst);
    q.ask_ticks.store(ask, std::memory_order_seq_cst);
    q.sequence.fetch_add(1, std::memory_order_seq_cst); // even
}

struct quote { int bid_ticks; int ask_ticks; };

quote read(const quote_snapshot& q) {
    for (;;) {
        const auto before = q.sequence.load(std::memory_order_seq_cst);
        if (before & 1U)
            continue;

        quote result{
            q.bid_ticks.load(std::memory_order_seq_cst),
            q.ask_ticks.load(std::memory_order_seq_cst)
        };
        const auto after = q.sequence.load(std::memory_order_seq_cst);
        if (before == after)
            return result;
    }
}
```

The field atomics eliminate formal data races; the conservative sequentially consistent order establishes one total order in which an accepted snapshot cannot straddle the odd/even update. Weaker orders are possible only with a complete proof that accounts for observations across all atomic fields; casually changing the field operations to relaxed can admit mixed snapshots even though it remains data-race-free. This reader is not automatically wait-free: it can retry indefinitely under a busy or preempted writer. Atomic fields can also be more expensive than a kernel-style seqlock on some targets. Inspect generated code on x86-64 and ARM64 and measure retry counts.

Sequence wraparound is another bound. A reader must not pause long enough for the counter to complete a full cycle and return to its original value. Use a wide counter and state the operational assumption.

## 17.9 Double Buffering and Snapshot Publication

**Double buffering** prepares a complete state in an inactive buffer and then publishes which buffer is active. Readers obtain a coherent snapshot without watching fields change individually.

```text
writer: update B completely -> publish active=B -> later reuse A
reader: load active ---------> read that buffer ------> finish
```

The word “later” hides the lifetime problem. With exactly two buffers, a fast writer can publish B and begin rewriting A while a slow reader still reads A. An atomic active index alone does not prevent this race.

Safe variants include reader acknowledgements, per-buffer reader counts, epochs, or immutable heap objects published through `std::atomic<std::shared_ptr<const State>>`. Atomic shared ownership is easy to reason about but adds reference-count traffic and may defer destruction onto an unlucky reader. A fixed pool plus explicit grace-period protocol gives tighter bounds but is harder to prove.

Snapshot publication is attractive when writes are less frequent than reads and copying the state is affordable. For a large order book, copying every level may dominate. Publish smaller immutable components or a compact derived top-of-book state instead.

## 17.10 RCU and Quiescent-State Concepts

**Read-copy-update (RCU)** lets readers traverse an old version while a writer creates and publishes a replacement. The writer reclaims the old version only after a **grace period** proves that all readers that could have seen it have left their read-side critical sections.

Publication and reclamation are separate:

```text
copy/modify new state
        |
        v
release-publish pointer ---- readers acquire and traverse
        |
        v
retire old state ---- wait for grace period ---- reclaim
```

A **quiescent state** is a point at which a thread holds no reference protected by the scheme. A context switch is not automatically a C++ application quiescent state; the library or application protocol must define and report it. Long-running readers, blocked threads, and threads that exit without deregistering can extend the grace period indefinitely.

Linux kernel RCU has implementation and scheduler integration that ordinary C++ code does not acquire by naming a design “RCU.” User-space libraries provide specific APIs and memory-order contracts. Follow those contracts rather than assembling a protocol from intuition.

RCU makes the read path exceptionally small—often an acquire load plus bookkeeping that can be per-thread. Its costs move to writers: copying, retirement lists, grace-period detection, and retained memory. Measure maximum retired bytes as well as read latency.

## 17.11 Hazard Pointers

A **hazard pointer** is a per-thread atomic slot announcing, “I may dereference this object.” A reclaimer scans all hazard slots and frees only retired objects that appear in none of them.

Protection requires a validation loop:

```cpp
// Excerpt: hp is this thread's registered hazard slot.
node* protect_top(std::atomic<node*>& top,
                  std::atomic<node*>& hp) {
    node* p;
    do {
        p = top.load(std::memory_order_acquire);
        hp.store(p, std::memory_order_seq_cst);
        // top may have changed between the load and publication.
    } while (p != top.load(std::memory_order_seq_cst));
    return p;
}
```

After validation, the thread may inspect `p`; before reusing the hazard slot, it clears the slot. The exact memory orders are part of the complete hazard-pointer algorithm. Do not weaken the schematic code without a proof: the reclaimer's scan must not miss a protection that logically precedes reclamation.

Pop removes a node from reachability and places it on a private retired list. Once the list reaches a threshold, the thread gathers all hazard values, scans the retired nodes, and deletes unprotected ones. This makes reclamation amortized rather than constant per pop. A scan touches memory proportional to registered hazard slots and can produce a latency spike.

Retirement is usually local to the removing thread. If every pop immediately scanned every hazard slot, sparse removals would pay a fixed global cost. A threshold amortizes scans but temporarily retains more memory. Let `H` be the maximum registered hazard slots and `R` the retire threshold. A simple unsorted scan can cost proportional to `H * R`; collecting hazards into a sorted array or hash set changes constants, allocation requirements, and cache behavior. Preallocate all scan scratch space if the scan can occur on the critical path.

Hazard publication also has a progress consequence. A thread can repeatedly lose the validation loop because the top changes, even while the stack makes progress. The reclamation scheme protects safety; it does not upgrade the stack to wait-free progress.

Registration, maximum threads, hazard slots per thread, thread exit, and stalled owners all need explicit bounds. A stalled thread protects only the few nodes in its slots, unlike epoch reclamation, which may retain an unbounded stream of later retirements. C++26 standardizes hazard-pointer facilities; for a C++23 book, use a vetted library or a carefully specified local implementation and document availability.

## 17.12 Epoch Reclamation

**Epoch-based reclamation** groups retirements by generation. A thread announces the epoch in which it may access shared nodes. An object retired in epoch `e` can be reclaimed only after every participating thread has either left its critical section or advanced beyond the epoch that could observe the object.

The read-side fast path can be a few per-thread stores and loads. Reclamation scans thread records less often and frees whole batches. This usually has better cache behavior than publishing a hazard for each pointer traversal.

The retention failure mode is more severe. A preempted, blocked, or forgotten participant can pin an epoch while writers continue retiring objects. Memory use then grows with the retirement rate and stall duration. A low-latency design must bound both, add monitoring, or provide an operational response. “No locks” is irrelevant if memory pressure later causes allocator expansion or page faults.

Epoch nesting and pointer escape are correctness hazards. A protected pointer must not survive beyond the announced critical section. Thread deregistration must prove that the thread holds no protected reference. Tests should deliberately pause a reader while writers retire many objects and verify both safety and the expected memory bound.

Epoch advancement is a distributed agreement. It often reads all participant records, which can touch one cache line per thread and cross NUMA nodes. Do not place every record in a compact array if active threads update adjacent fields and create false sharing. Conversely, giving every record a whole line can enlarge each scan. The registration limit and scan frequency determine the better layout.

Operational monitoring should expose the oldest active epoch, the identity and age of its participant, retired objects and bytes per epoch, and reclamation batch duration. Without those signals, a pinned epoch first appears as allocator pressure far from the cause.

## 17.13 Atomic Reference Counting

**Atomic reference counting** reclaims an object when the last shared owner releases it. `std::shared_ptr` supplies this ownership model, and C++20 permits atomic operations on `shared_ptr` through `std::atomic<std::shared_ptr<T>>`.

Reference counting is not a general replacement for hazard protection. To increment a count safely, a thread must already possess a valid way to reach the control block. Loading an atomic `shared_ptr` provides that combined operation; loading a raw pointer and then constructing ownership may race with deletion.

Every shared copy normally modifies a control-block count. Readers on different cores therefore contend for cache-line ownership. The final decrement can run an arbitrary destructor and deallocation on the releasing thread, producing a large tail event. Cycles are not reclaimed without `weak_ptr` or an explicit ownership break.

Atomic shared ownership remains useful for read-mostly configuration snapshots because it offers a compact, auditable lifetime contract. Measure copy frequency, control-block cache transfers, and destruction placement. If those costs matter, a single-writer deferred-destruction queue can move cleanup away from the critical path while preserving ownership semantics.

## 17.14 Bounded Never-Reclaim Designs

A **never-reclaim design** keeps removed objects allocated until a known terminal event, often process shutdown or session reset. This can be the simplest correct reclamation policy when the memory bound is strict and small.

For example, an order gateway may allocate one node per order from a pool sized to the venue's maximum live orders plus a bounded recovery margin. Cancelled nodes return to a logical free list only when the algorithm can safely reuse them; alternatively, they remain retired until the session ends. If the total is 200,000 fixed-size nodes, the maximum footprint can be calculated before startup.

The policy is unacceptable when input can create unbounded retired objects or when an adversary can force exhaustion. Capacity failure must be explicit and safe. Never silently fall back to the general heap on a latency-critical path unless that is an intentional, measured overload route.

The virtue is proof economy: no hazard scan, epoch grace period, or reference-count decrement is needed. Memory that is deliberately retained under a demonstrated bound is not a leak. Memory whose bound exists only in a comment is.

### Choosing a reclamation policy

The access pattern narrows the choices:

| Pattern | Plausible policy | Main fast-path cost | Main failure mode |
|---|---|---|---|
| one writer publishes immutable configuration | atomic shared ownership | reference-count updates | contended count and last-owner destruction |
| many short traversals, rare stalled readers | epochs or quiescent states | enter/leave bookkeeping | stalled participant pins many retirements |
| arbitrary pointer traversal with potentially stalled threads | hazard pointers | publish and validate hazards | scans and a bounded set of protected leaks |
| fixed session maximum and controlled restart | never reclaim until reset | retained fixed storage | capacity exhaustion |

The table is not an algorithm-selection shortcut. It identifies which proof and tail event deserve attention. Mixing policies is possible—for example, epochs for most nodes and reference counting for objects that escape—but mixed ownership makes review harder.

Consider a market-data decoder that builds a new immutable instrument-definition table before the session opens. Updates are rare; lookups occur for every message. Atomic shared ownership may be entirely adequate during the update window, after which each worker can cache a stable `shared_ptr` and avoid per-message count changes. A low-level lock-free map with hazard pointers would solve a harder problem than the application has.

## 17.15 Pause Instructions, Exponential Backoff, Yield, and Park

A **backoff policy** controls what a thread does after a failed attempt. It changes cache traffic, fairness, CPU occupancy, power, and wakeup latency; it does not change the synchronization proof.

| Response | Typical mechanism | Benefit | Risk |
|---|---|---|---|
| tight retry | reload/CAS loop | lowest handoff delay when contention is brief | saturates execution and coherence resources |
| pause hint | x86 `pause`, ARM `yield` hint | improves spin-loop behavior on supported cores | still consumes a hardware thread |
| exponential delay | increasing pause count | reduces synchronized retry storms | adds variable delay and can hurt fairness |
| scheduler yield | `std::this_thread::yield()` | lets another runnable thread execute | scheduler behavior is weakly specified |
| park | atomic wait, futex, condition variable | low CPU use for long waits | syscall/scheduler path and wakeup tail |

Hybrid policies spin for a measured interval and then park. The interval should follow the distribution of actual handoff time, not folklore. On an isolated core, yielding may hand time to an unrelated task; on an SMT sibling, a pause can materially help the thread holding the needed line.

A bounded adaptive loop can make its stages visible:

```cpp
// Pseudocode: cpu_pause and park_until_changed are platform facilities.
for (unsigned attempt = 0; ; ++attempt) {
    if (operation_succeeds())
        break;
    if (attempt < spin_limit) {
        const unsigned width = std::numeric_limits<unsigned>::digits;
        const unsigned safe_max = std::min(max_shift, width - 1);
        const unsigned pauses = 1U << std::min(attempt, safe_max);
        for (unsigned i = 0; i != pauses; ++i)
            cpu_pause();
    } else {
        park_until_changed();
    }
}
```

The shifting expression must itself be bounded to less than the width of `unsigned`; constraining only `attempt` is insufficient when `max_shift` comes from configuration. `park_until_changed` must use a predicate loop because notification and observation can race. C++20 atomic wait/notify is a natural building block when waiting on one atomic value; its implementation may spin before entering a Linux futex path.

Benchmark backoff under realistic placement and oversubscription. Report CPU time and energy or frequency effects alongside latency. A policy that wins an unloaded median but consumes every spare core may degrade the complete trading process.

Correctness testing needs more than a long random run. Use reduced counter widths to force wraparound, insert scheduler yields at publication boundaries, run sanitizers, and model small algorithms with an interleaving checker where feasible. Fault-inject allocation failure and participant stalls in reclamation schemes. Performance testing begins only after these cases preserve sequence, uniqueness, and lifetime invariants.

### Worked design: a market-data handoff

Suppose one network thread decodes exchange messages and one book thread applies them. The maximum burst is bounded by configuration, messages are fixed-size values, order must be preserved, and losing a message requires recovery. This is an SPSC problem; an MPMC queue would add claims and contention without adding useful capability.

Define the contract before choosing memory orders:

- the decoder is the only producer and the book is the only consumer;
- queue capacity is a power of two selected from measured burst depth plus a safety margin;
- `try_push` returns false when full and increments a nonblocking overflow counter;
- overflow transitions the channel to a gap-recovery state rather than overwriting data;
- neither endpoint can be copied or invoked from another thread;
- payload move, assignment, and destruction are nothrow and allocate nothing.

The payload should contain a source sequence number. The consumer checks that number even when the queue itself is correct, because loss can occur at the NIC, socket, decoder, or queue boundary. A queue position is not an exchange sequence.

```cpp
struct book_update {
    std::uint64_t source_sequence;
    std::uint32_t instrument;
    std::int64_t price_ticks;
    std::int32_t quantity;
    std::uint8_t side;
    std::uint8_t action;
};

static_assert(std::is_trivially_copyable_v<book_update>);
```

Inspect `sizeof(book_update)` and its padding on supported ABIs. Reordering fields may reduce the slot footprint, but protocol decoding should not copy raw packet bytes into this native structure: endianness, alignment, and representation remain separate concerns. Decode fields explicitly, then enqueue the normalized value.

The synchronization proof contains two cycles. For production, slot assignment is sequenced before release publication of `head`; the consumer's acquire observation of that head happens before its slot read. For reuse, the consumer's slot read is sequenced before release publication of `tail`; the producer acquires that tail before overwriting the slot. No slot is read and written concurrently.

Shutdown adds another state transition. A stop flag alone can make the consumer exit while published messages remain. One policy is: stop accepting network input, publish a terminal marker through the same queue, consume through that marker, join the consumer, and only then destroy the ring. If an external stop token is needed for failure shutdown, specify whether pending updates are discarded and how recovery state records the incomplete sequence.

Capacity testing should replay recorded and synthetic bursts without claiming the recording represents every future market. Report the maximum observed occupancy, duration above selected thresholds, overflow count, and consumer service-time distribution. Then inject a deliberately stalled consumer to confirm overflow is detected at the specified boundary and does not allocate or overwrite.

For timing, place timestamps outside the payload only if clock reads would distort the hot path. A lower-impact option samples one in every fixed number of messages and records producer publication and consumer observation using a calibrated clock. Sampling must not change queue ownership or block on a logging sink.

Hardware-counter runs can compare adjacent versus separated indices. Pin the endpoints first; migrations can dominate the comparison. Measure cache-to-cache transfers, cycles, instructions, and occupancy distribution. Repeat with endpoints on the same core's SMT threads, different cores in one socket, and different NUMA nodes if those placements are operationally possible.

Finally, test the assumptions as failures. Attempt to construct a second producer endpoint; the code should reject it structurally or at startup. Force counters to wrap in a test specialization. Make payload assignment throw in a test type and verify the production template constraint rejects it. Run ThreadSanitizer with randomized pauses and a payload checksum. These tests turn the three-line memory-order argument into an auditable component.

## 17.16 Interview Check

1. State the ownership and publication invariants of an SPSC ring. Why are relaxed loads sufficient for each thread's own index?
2. What formal error exists in a seqlock whose readers copy ordinary non-atomic fields while a writer modifies them?
3. Explain the difference between ABA and premature reclamation in a Treiber stack.
4. Compare hazard pointers and epoch reclamation for a workload with rare but very long reader stalls.
5. A bounded MPMC queue has strong aggregate throughput but one producer's p99.99 latency is extreme. What would you instrument first?
6. Why can a two-buffer snapshot scheme race even when the active index is atomic?
7. Under what precise bound can deliberately never reclaiming nodes be a sound production design?
8. How would you verify that `std::atomic<tagged_head>` is actually lock-free on the deployment target?
9. Design an overload policy for a full order-entry queue and explain why silent overwrite is or is not acceptable.
10. Compare tight spinning, pause-based backoff, and parking in terms of handoff latency, CPU occupancy, and tail predictability.
