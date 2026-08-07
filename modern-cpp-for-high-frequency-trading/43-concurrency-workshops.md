# Chapter 43 — Concurrency Workshops

Concurrency code is not validated by surviving a stress test. Its proof must cover every allowed execution, its memory orders must connect the writes and reads that communicate, and its resource policy must survive a stalled thread. These workshops use bounded storage and narrow type constraints so the concurrency argument remains visible. Where safe reclamation needs infrastructure beyond a short listing, the chapter labels the boundary instead of presenting an unsafe fragment as finished code.

## 43.1 SPSC Ring Buffer With Justified Memory Orders

A **single-producer, single-consumer** (SPSC) ring assigns one thread exclusive write ownership of the producer index and one thread exclusive write ownership of the consumer index. That restriction removes compare-exchange from the common path.

The contract:

- Exactly one producer calls `try_push`; exactly one consumer calls `try_pop`.
- Capacity is `N - 1`; one slot distinguishes full from empty.
- Operations never allocate, block, or throw.
- `T` is default-constructible and nothrow copy-assignable.
- Destruction begins only after both threads stop.
- A failed push leaves the source untouched and a failed pop leaves output untouched.

```cpp
#include <array>
#include <atomic>
#include <cstddef>
#include <type_traits>

template<class T, std::size_t N>
class SpscRing {
    static_assert(N >= 2);
    static_assert(std::is_nothrow_copy_assignable_v<T>);
    static_assert(std::is_default_constructible_v<T>);

public:
    [[nodiscard]] bool try_push(const T& value) noexcept {
        const std::size_t head = head_.value.load(std::memory_order_relaxed);
        const std::size_t next = increment(head);

        if (next == tail_.value.load(std::memory_order_acquire)) {
            return false;
        }

        slots_[head] = value;
        head_.value.store(next, std::memory_order_release);
        return true;
    }

    [[nodiscard]] bool try_pop(T& output) noexcept {
        const std::size_t tail = tail_.value.load(std::memory_order_relaxed);

        if (tail == head_.value.load(std::memory_order_acquire)) {
            return false;
        }

        output = slots_[tail];
        tail_.value.store(increment(tail), std::memory_order_release);
        return true;
    }

    [[nodiscard]] static constexpr std::size_t capacity() noexcept {
        return N - 1;
    }

private:
    static constexpr std::size_t increment(std::size_t index) noexcept {
        return index + 1 == N ? 0 : index + 1;
    }

    // 64 is a deployment hypothesis, not a C++ cache-line guarantee.
    struct alignas(64) Index {
        std::atomic<std::size_t> value{0};
    };

    std::array<T, N> slots_{};
    Index head_{};
    Index tail_{};
};
```

The producer writes `slots_[head]`, then publishes the new head with release. The consumer's acquire load that observes that head synchronizes with it, making the slot assignment visible before the consumer reads. The consumer reads the slot, then release-stores the new tail. The producer acquire-loads tail before reusing that slot, ensuring reuse occurs after the prior read.

```text
producer                                      consumer
slots[h] = value
head.store(next, release)  ----observed---->  head.load(acquire)
                                               output = slots[t]
tail.load(acquire)          <---observes----  tail.store(next, release)
reuse slots[h]
```

The first edge publishes constructed value state. The second edge protects the consumer's read from producer overwrite. Both are required even though only head communicates “not empty” and tail communicates “not full.”

The producer's own head load is relaxed because no other thread writes head. Program order and the release publication provide the required relationship. Tail is symmetric. Replacing the cross-thread acquire loads with relaxed loads creates a data race on slots on weakly ordered machines and is invalid C++, even if an x86-64 test appears stable.

The alignment separates the two index objects under the explicit hypothesis that a cache line is at most 64 bytes and the containing object is suitably placed. C++ guarantees 64-byte alignment, not cache-line size or absence of adjacent allocator interference. `std::hardware_destructive_interference_size` can express an implementation-provided value when available, but build reproducibility and library support need consideration.

The slots are all constructed up front. That gives constant lifetime work but requires `N * sizeof(T)` storage and default-construction cost. A raw-storage version can support move-only types, but it must prove construction/destruction ordering in addition to data visibility.

Each successful operation performs one local relaxed atomic access, one cross-thread acquire, one ordinary assignment, and one release store. Full or empty failure omits assignment and publication. C++ does not specify instruction counts: on x86-64 acquire/release loads and stores commonly use ordinary load/store instructions, while ARM64 commonly uses acquire/release forms. Coherence traffic remains on both.

The queue exposes no exact `size`. Loading head and tail separately cannot form one atomic snapshot and can become stale immediately. Approximate occupancy is useful for metrics if it never controls correctness. If a producer needs high-water marks, it can calculate them from its local head and an acquired tail at enqueue time.

Shutdown requires an external protocol. A `closed` atomic can tell the consumer no more pushes will occur, but the consumer must drain published items before exit. Destroying the queue while either thread can access it is a lifetime race that no head/tail memory order repairs.

Functional tests fill exactly `N - 1`, verify the next push fails, drain in FIFO order, wrap indices repeatedly, and compare millions of generated sequence values. ThreadSanitizer can detect many accidental races:

```sh
c++ -std=c++23 -O1 -g -fsanitize=thread -pthread spsc_test.cpp
c++ -std=c++23 -O3 -pthread spsc_bench.cpp
perf stat -e cycles,instructions,cache-misses ./spsc_bench
```

Sanitizer timing is not production timing. For performance, pin threads only in a controlled experiment, record topology, compare same-core/SMT/different-core placements, and count failed polls as work. A consumer spinning on an empty queue can consume the producer's execution resources.

Acceptance includes a deliberately slow consumer until the queue becomes full and a slow producer until empty. Verify that no element is overwritten or duplicated, and that failure is returned promptly. Add payload fields derived from a sequence number; checking all fields catches publication that exposes only a correct index.

Discussion prompts: Should capacity be `N` with monotonic counters? How is overflow handled? What happens if the producer dies after writing the slot but before publishing head? Which overload policy is acceptable for market data versus orders?

## 43.2 Bounded MPMC Queue Design

A **multiple-producer, multiple-consumer** (MPMC) queue must arbitrate slot ownership among competing threads. The following bounded design uses a sequence number per cell and monotonic enqueue/dequeue tickets. It is a workshop implementation with an explicit operational lifetime: counters must never wrap.

The type is restricted to default-constructible, nothrow copy-assignable `T`. This keeps exceptions from abandoning a claimed cell. Production code can manage raw lifetimes, but that proof is separate.

```cpp
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <type_traits>

template<class T, std::size_t N>
class BoundedMpmc {
    static_assert(N >= 2);
    static_assert(std::is_default_constructible_v<T>);
    static_assert(std::is_nothrow_copy_assignable_v<T>);
    static_assert(std::atomic<std::uint64_t>::is_always_lock_free,
                  "this workshop's lock-free claim requires lock-free 64-bit atomics");

    struct Cell {
        std::atomic<std::uint64_t> sequence{0};
        T data{};
    };

public:
    BoundedMpmc() noexcept {
        for (std::size_t i = 0; i < N; ++i) {
            cells_[i].sequence.store(i, std::memory_order_relaxed);
        }
    }

    [[nodiscard]] bool try_enqueue(const T& value) noexcept {
        std::uint64_t position = enqueue_.load(std::memory_order_relaxed);

        for (;;) {
            if (position > max_position) return false; // service-lifetime limit
            Cell& cell = cells_[position % N];
            const std::uint64_t sequence =
                cell.sequence.load(std::memory_order_acquire);

            if (sequence == position) {
                if (enqueue_.compare_exchange_weak(
                        position, position + 1,
                        std::memory_order_relaxed,
                        std::memory_order_relaxed)) {
                    cell.data = value;
                    cell.sequence.store(position + 1,
                                        std::memory_order_release);
                    return true;
                }
            } else if (sequence < position) {
                return false;
            } else {
                position = enqueue_.load(std::memory_order_relaxed);
            }
        }
    }

    [[nodiscard]] bool try_dequeue(T& output) noexcept {
        std::uint64_t position = dequeue_.load(std::memory_order_relaxed);

        for (;;) {
            if (position > max_position) return false;
            Cell& cell = cells_[position % N];
            const std::uint64_t sequence =
                cell.sequence.load(std::memory_order_acquire);
            const std::uint64_t expected = position + 1;

            if (sequence == expected) {
                if (dequeue_.compare_exchange_weak(
                        position, position + 1,
                        std::memory_order_relaxed,
                        std::memory_order_relaxed)) {
                    output = cell.data;
                    cell.sequence.store(position + N,
                                        std::memory_order_release);
                    return true;
                }
            } else if (sequence < expected) {
                return false;
            } else {
                position = dequeue_.load(std::memory_order_relaxed);
            }
        }
    }

private:
    static constexpr std::uint64_t max_position =
        std::numeric_limits<std::uint64_t>::max() - N - 1;

    std::array<Cell, N> cells_{};
    alignas(64) std::atomic<std::uint64_t> enqueue_{0};
    alignas(64) std::atomic<std::uint64_t> dequeue_{0};
};
```

Each cell cycles through expected sequence values. A producer claims ticket `p` only when cell `p % N` has sequence `p`. It assigns data and release-publishes `p + 1`. A consumer for ticket `p` acquire-observes `p + 1`, copies data, then release-publishes `p + N` to make the cell reusable. These acquire/release pairs protect `data`; ticket CAS operations only allocate unique positions and remain relaxed.

```text
free for producer p: sequence == p
claimed:             enqueue ticket advanced, sequence still p
published:           data written, sequence = p + 1
consumed:            data read, sequence = p + N
```

The claimed intermediate state explains the stalled-thread hazard. Other producers can claim other cells, but FIFO dequeue at this ticket waits for publication.

The `<` comparisons are valid only because the service stops before counter wrap and the sequence values remain in ordinary unsigned order. This is a real constraint. At one billion operations per second, even 64-bit exhaustion is distant, but correctness cannot call it impossible without a service-lifetime policy. A wrap-aware modular comparison needs a separate proof.

This design is bounded in memory but not wait-free. Its lock-free progress discussion applies only on targets where the 64-bit atomics are lock-free; the listing rejects other targets with `is_always_lock_free`. A more portable component can make that a deployment-time `is_lock_free()` check and choose a locked fallback, but it must not advertise one progress guarantee for both implementations. A producer can reserve a position and be preempted before publishing its cell. Later producers may reserve later positions, but a consumer at the stalled cell cannot advance FIFO order. CAS loops can retry without a per-thread bound under contention. Section 43.3 names the progress guarantees carefully.

False “full” or “empty” observations can occur transiently around competing reservations, depending on the exact algorithm and timing. The API is `try_`: it reports inability to complete at that observation, not a linearizable global size snapshot. Do not add `size()` by subtracting approximate counters and use it for correctness.

This simplified unsigned ordering also assumes sequence values never leap ahead in a way that makes `<` ambiguous. The no-wrap operational bound and algorithm initialization establish that condition. Put a startup-calculated maximum session operation count in the design review, expose proximity metrics if remotely relevant, and restart before the invariant expires.

Modulo by compile-time `N` can become a mask when `N` is a power of two or a multiply/shift sequence otherwise. Requiring a power of two simplifies indexing but can waste capacity. Inspect assembly before adding the restriction; coherence and CAS retries usually dominate division for contended queues.

Resource cost is `N * (sizeof(T) + atomic sequence + padding)` plus two counters. Consecutive cell sequences can share cache lines and bounce under contention. Padding every cell can reduce false sharing while multiplying footprint and TLB pressure. Benchmark the actual producer/consumer topology.

Queue construction writes every sequence, touching capacity-sized memory. That is useful preparation if done on the intended NUMA node. A huge queue absorbs bursts but creates more waiting and a wider page footprint. Bound capacity from an overload policy; do not use memory to conceal a service-rate deficit.

A blocking wrapper can wait on an atomic generation or semaphore after `try` fails. It must avoid lost wakeups between observing full/empty and sleeping, and it changes progress from lock-free polling to scheduler-assisted blocking. Keep that layer outside the queue core so callers can choose spin, park, reject, or shed.

Test unique message IDs from several producers, record exactly-once consumption in a preallocated bitmap, and verify per-producer order if the contract requires it. Inject yields after successful reservation to expose stalled-cell behavior. Run ThreadSanitizer and long wrap tests with a test-only eight-bit counter model; the production implementation must still respect its documented limit.

Discussion prompts: Is strict global FIFO required? Would one SPSC queue per producer plus merge be simpler? What happens when a consumer's output assignment could throw? Which queue owns backoff and parking policy?

## 43.3 Progress, Fairness, and Starvation Analysis

A progress claim describes which operations finish under which scheduling assumptions. It does not describe latency by itself.

| Property | Informal requirement |
|---|---|
| blocking | one suspended owner can prevent others |
| obstruction-free | a thread finishes if it eventually runs alone |
| lock-free | system-wide, some operation completes in finite steps |
| wait-free | each operation completes within its own finite-step bound |

The exact proof must refer to the algorithm, not the data structure label. The SPSC ring has bounded code paths when each side calls one `try` operation; it does not guarantee that a retrying caller eventually succeeds if its peer never runs. The MPMC CAS algorithm aims for lock-free position claiming under its constraints, yet a thread that has claimed the next FIFO cell and is preempted can impede consumers. A rigorous production claim must account for that reservation window.

The presented MPMC algorithm should therefore not be advertised simply as wait-free or as having bounded dequeue latency. Position CAS makes system progress under many schedules, but the reserved-cell dependency can stall FIFO consumption. A production team should either prove the precise algorithm variant's formal progress property or use the narrower factual statement about its mechanisms and observed behavior.

**Fairness** describes how opportunities are distributed. A lock-free CAS loop can let one core win repeatedly because its cache line remains local or its timing is favorable. Another valid thread can starve while system-wide progress continues. Lock-free is therefore compatible with unbounded per-operation latency.

Backoff changes contention:

```cpp
// EXCERPT: policy hook inside a failed-CAS loop.
if (failures < spin_limit) {
    cpu_relax();       // target-specific pause/yield hint
} else {
    std::this_thread::yield();
}
```

`cpu_relax` needs a portable wrapper with architecture-specific implementations. `yield` is only a scheduler hint and can return immediately. Sleeping or atomic wait reduces CPU but adds wakeup latency. Randomized/exponential backoff reduces synchronized collision but increases individual delay and complicates bounds.

Analyze four schedules for every algorithm:

1. One thread runs without interference.
2. All threads continuously contend.
3. A thread stops before acquiring ownership.
4. A thread stops after acquiring ownership but before publishing/releasing.

The fourth separates robust designs from optimistic benchmarks. A mutex owner that stops blocks waiters. A reserved MPMC slot can block FIFO progress. An SPSC producer stopped before head publication merely leaves the queue appearing unchanged; stopped after publication is safe because the element is already visible.

OS scheduling remains outside the C++ progress proof. A wait-free function cannot execute while its thread is descheduled. CPU affinity can reduce migrations but risks oversubscription or starvation of kernel work. SMT siblings share execution resources. State the scheduler and topology assumptions with latency results.

Priority inversion can appear without a mutex. A low-priority producer that reserves the next cell can block a high-priority consumer behind publication. The kernel cannot apply mutex priority inheritance to this dependency. Partitioning queues by priority or avoiding cross-priority ownership can be more effective than a lock-free label.

Fair queueing can assign tickets, but ticket order makes a stalled owner visible to everyone. Randomized winner selection reduces convoying at the cost of ordering. Business semantics decide whether strict FIFO, per-producer FIFO, or best-effort fairness is required.

Verification should record attempts per successful operation, maximum retry streak, failed try count, CPU time, voluntary/involuntary switches, and per-thread throughput. Aggregate throughput can hide one starving thread. Use adversarial pauses and randomized schedules, not just symmetric tight loops.

Discussion prompts: Which business operation requires FIFO fairness? Is rejecting immediately fairer than spinning? Can work be partitioned to remove contention rather than tuning backoff?

## 43.4 False-Sharing Diagnosis

**False sharing** occurs when threads modify independent objects that occupy the same coherence granule, commonly a cache line. C++ sees separate objects; hardware transfers ownership of the containing line.

```cpp
#include <atomic>
#include <cstdint>

struct PackedCounters {
    std::atomic<std::uint64_t> feed{0};
    std::atomic<std::uint64_t> orders{0};
};

struct alignas(64) PaddedCounter {
    std::atomic<std::uint64_t> value{0};
};

struct SeparatedCounters {
    PaddedCounter feed;
    PaddedCounter orders;
};
```

If two cores repeatedly increment `PackedCounters` fields, the line can ping-pong even though neither reads the other field. `SeparatedCounters` requests 64-byte alignment and gives each member a size that is a multiple of that alignment on a conforming implementation. The 64-byte value remains a deployment assumption about destructive interference.

First diagnose ownership. Read-only sharing is usually harmless for coherence. A single writer and many readers still transfer data when readers poll aggressively and the writer invalidates their copies. Two writers create stronger ownership traffic.

Inspect addresses and sizes, then measure:

```sh
c++ -std=c++23 -O3 -pthread false_sharing.cpp
perf stat -e cycles,instructions,cache-misses ./false_sharing
perf c2c record ./false_sharing
perf c2c report
```

`perf c2c` availability, permissions, and event support depend on CPU and kernel. Generic cache misses may not directly identify coherence transfers. Compare same workload and topology, and use hardware-specific HITM or snoop events when documented.

Run four controls: both increments on one thread, two threads updating one atomic, two threads updating packed independent atomics, and two threads updating padded atomics. The differences separate ordinary atomic read-modify-write cost, true sharing, and false sharing. Keep total increments equal.

Memory order relaxation does not remove cache-line ownership. `fetch_add(relaxed)` avoids ordering unrelated memory but still performs one atomic modification in the counter's total modification order. Replacing it with a load/add/store is a lost-update bug, not a false-sharing optimization.

Padding trades coherence for memory. One eight-byte metric now occupies at least 64 bytes, reducing cache and TLB density. Thousands of per-symbol padded counters can be worse than per-thread dense counters followed by periodic aggregation. Separate writers by ownership first; pad only genuinely hot shared fields.

Per-thread counters turn updates into ordinary thread-owned increments. A reader can aggregate occasionally after synchronization or use atomics at a much lower frequency. Snapshot consistency then becomes explicit: exact simultaneous totals require coordination, whereas diagnostics often accept a slightly stale sum.

Beware adjacent allocation. Two separately allocated padded types each meet their alignment, but custom allocators must honor over-alignment. Embedding a padded member inside packed or externally mapped layouts can violate the intended deployment assumptions even if the C++ alignment requirement itself is respected.

Layout can regress silently when a class gains a member or allocator placement changes. Add `static_assert(alignof(...))`, optional target-specific size assertions, and a layout benchmark. C++17's interference-size constants can replace magic values where the implementation exposes stable values, but they can create ABI differences across compilation targets.

Discussion prompts: How would you distinguish false sharing from lock contention? Can a reader create the same symptom? Which counter aggregation design removes writes from the critical line entirely?

## 43.5 Broken Publication Diagnosis

**Publication** makes a fully initialized object reachable by another thread through a synchronization relationship. Storing a pointer and hoping construction “happened first” in wall-clock time is not synchronization.

```cpp
// BROKEN: data races on ready and instance.
Widget* instance = nullptr;
bool ready = false;

Widget* get_widget() {
    if (!ready) {
        instance = new Widget(load_config());
        ready = true;
    }
    return instance;
}
```

Concurrent calls race on both variables and can construct twice, observe stale state, or invoke undefined behavior. Making only `ready` atomic with relaxed operations still does not make the `Widget` initialization visible.

A simple standard-correct solution is one-time initialization:

```cpp
// EXCERPT: Widget and load_config are application types/functions.
#include <memory>
#include <mutex>

std::once_flag widget_once;
std::unique_ptr<Widget> widget;

Widget& get_widget() {
    std::call_once(widget_once, [] {
        auto candidate = std::make_unique<Widget>(load_config());
        widget = std::move(candidate);
    });
    return *widget;
}
```

`std::call_once` synchronizes successful execution with returning calls. If the callable throws, the attempt is exceptional and a later call may retry. Memory allocation and configuration loading occur only on initialization, but the function is unsuitable for a first call on a critical path. Initialize during controlled startup.

The candidate `unique_ptr` gives transactional ownership. If configuration loading or construction throws, it cleans up and the global pointer remains empty. Assignment into `widget` occurs only after complete construction. A startup supervisor can bound retries or fail initialization rather than allowing the first market-data thread to retry unpredictably.

An atomic pointer can publish an object when initialization ownership is otherwise controlled:

```cpp
// EXCERPT: publication after application-owned construction.
#include <atomic>

std::atomic<Widget*> published{nullptr};

// Single startup publisher; object lives until all reader threads join.
void publish_widget(Widget* complete_object) noexcept {
    published.store(complete_object, std::memory_order_release);
}

Widget* observe_widget() noexcept {
    return published.load(std::memory_order_acquire);
}
```

If the acquire load observes the released pointer, prior initialization writes happen-before subsequent reader access. The comments are essential: this does not elect one initializer and does not reclaim or replace the object safely. Multiple publishers need compare-exchange plus ownership cleanup; replacement needs a reclamation scheme.

Publishing a pointer does not recursively freeze the object. If a background thread mutates `Widget` after publication, those mutations need their own synchronization. Likewise, a pointer member initialized to an external object is useful only while that referent remains alive. Release/acquire orders writes; it does not create ownership.

An acquire load that returns null does not synchronize with a future publication. The caller must handle “not ready” without dereferencing. Polling null in a tight loop creates coherence traffic once the publisher writes and consumes CPU beforehand; a latch, atomic wait, or startup phase boundary may be better.

The notorious double-checked locking pattern can be made correct with an atomic pointer and a mutex around initialization, but it is easy to mix atomic and non-atomic accesses or delete too early. Prefer a function-local static or `call_once` unless profiling proves their post-initialization guard path matters. C++ guarantees thread-safe initialization of block-scope statics; compiler/ABI implementations commonly use a guard check.

Test publication under ThreadSanitizer, force constructors to throw, and assert one live instance. Inspect optimized assembly to see the acquire load on the target, but do not infer correctness from x86-64's strong ordering. Run on ARM64 or an architecture model checker for weak-order intuition.

Discussion prompts: What exactly is published by the release store? Can the object contain pointers to incompletely initialized subobjects? When and by whom can it be destroyed? How does failure policy affect startup readiness?

## 43.6 Safe Reclamation for a Lock-Free Stack

Removing a node from a lock-free structure does not prove that no thread still holds a pointer to it. **Safe memory reclamation** delays reuse or destruction until every possible reader has stopped accessing the node.

The tempting Treiber pop is broken when it deletes immediately:

```cpp
// BROKEN: another pop can still be reading old_head->next.
Node* old_head = head.load(std::memory_order_acquire);
while (old_head != nullptr &&
       !head.compare_exchange_weak(old_head, old_head->next,
                                   std::memory_order_acq_rel,
                                   std::memory_order_acquire)) {}
if (old_head != nullptr) {
    auto value = old_head->value;
    delete old_head; // use-after-free and ABA risk
    return value;
}
```

Another thread can load `old_head`, pause, and dereference it after deletion. The allocator can reuse the address for a new node, allowing an ABA sequence in which the head pointer value changes A→B→A while the object identity changes.

The failure has two distinct parts. Reclamation creates use-after-free on `old_head->next`. Reuse can create ABA even if the memory happens to remain accessible. A tagged head can detect many ABA cycles but does not by itself prove that dereferencing an unprotected node is safe.

A safe executable baseline uses a mutex and a fixed pool:

```cpp
// SCAFFOLD: depends on the Chapter 42 pool interface and invalid handle policy.
#include <mutex>
#include <optional>
#include <type_traits>
#include <utility>

template<class T, class Pool>
class LockedStack {
    static_assert(std::is_nothrow_move_constructible_v<T>);
    static_assert(std::is_nothrow_destructible_v<T>);
    static_assert(noexcept(std::declval<Pool&>().erase(
        std::declval<typename Pool::Handle>())));

    struct Node {
        T value;
        typename Pool::Handle next;
    };

public:
    bool push(const T& value) {
        std::scoped_lock lock(mutex_);
        auto handle = pool_.create(Node{value, head_});
        if (pool_.get(handle) == nullptr) return false;
        head_ = handle;
        return true;
    }

    std::optional<T> pop() {
        std::scoped_lock lock(mutex_);
        Node* node = pool_.get(head_);
        if (node == nullptr) return std::nullopt;
        std::optional<T> result{node->value}; // copy before mutation may throw
        const auto old = head_;
        head_ = node->next;
        pool_.erase(old);
        return result;
    }

private:
    Pool pool_;
    typename Pool::Handle head_{};
    std::mutex mutex_;
};
```

This excerpt depends on the Chapter 42 pool interface and needs a distinguished invalid handle agreed with that pool. It is a design scaffold, not a standalone listing. It shows the safe default: mutual exclusion protects both reachability and reclamation. The result is constructed before unlink, so a throwing copy leaves the stack unchanged; the static requirements make result movement, pool erase, and destruction nonthrowing after mutation begins.

The mutex version blocks and can suffer contention, convoying, and priority inversion. It also has a compact proof, immediate reclamation, bounded pool memory, and standard tooling. Benchmark it before accepting the complexity of lock-free reclamation. A short critical section over cache-hot nodes can beat repeated hazard publication and scans under moderate contention.

A hazard-pointer design replaces the mutex with a domain protocol:

```text
pop by registered thread r:
  1. load head into candidate
  2. publish candidate in hazard[r] with seq_cst or proven ordering
  3. reload head; if changed, retry from step 1
  4. read candidate->next while hazard remains published
  5. CAS head from candidate to next
  6. clear hazard[r]
  7. append removed candidate to r's retired list
  8. when threshold reached, scan all hazard slots
  9. reclaim only retired nodes absent from a protected snapshot
```

This is deliberately pseudocode. A complete implementation must specify thread registration and deregistration, maximum threads, hazard-slot ownership, exact memory orders, scan synchronization, allocator reuse, ABA handling during CAS, exception behavior, thread death, and shutdown. Omitting any of these can reintroduce use-after-free.

Hazard pointers bound protection slots but not retired memory when a registered thread stalls while protecting a node. A scan is proportional to hazard slots plus retired nodes and creates a latency spike. Threshold scans can move that work to a maintenance thread, but transfer and final shutdown still require synchronization.

Hazard publication ordering is subtle. The reader must make its hazard visible before trusting the candidate is still reachable, hence publish then reload head. A remover must not reclaim until its scan observes no hazard under the domain's specified ordering. Replacing all operations with relaxed atomics because the pointers are atomic destroys the proof.

Thread registration must itself be bounded and race-free. A fixed array of hazard records avoids allocation on pop but needs exclusive slot acquisition and a policy for more threads than records. Thread-local registration cleanup cannot silently disappear if a thread exits with retired nodes or an active hazard.

Epoch reclamation announces that threads are inside read-side critical sections and reclaims nodes only after all earlier readers pass a quiescent state. Its read path can be cheaper, but one stalled reader can retain an unbounded retired set. RCU families have similar grace-period reasoning with environment-specific APIs. Atomic reference counting adds increments, decrements, and contention and still needs care while first acquiring a reference from a shared raw pointer.

For a bounded-lifetime trading process, “never reclaim during the session” can be correct when a preallocated maximum covers all removals and memory is released after threads join. That converts reclamation latency into capacity and shutdown work. The bound, exhaustion policy, and restart procedure must be explicit.

Ownership partitioning can avoid the stack entirely. Give each thread a local free list and return remote frees through bounded SPSC channels. The design may use more memory and delay reuse, but it replaces global CAS and reclamation with simpler ownership transfers. Architecture often beats a more elaborate primitive.

Verification requires more than ThreadSanitizer; use-after-free schedules can be rare and a logically wrong memory order may evade a run. Add adversarial pauses after head load and hazard publication, tiny pools that reuse addresses immediately, generation tags, sanitizer builds, model checking for a reduced state space, and counters for retired backlog and scan duration.

Discussion prompts: Which reclamation scheme tolerates stalled threads? Where is work paid? Is strict lock-free progress worth the memory and verification complexity compared with a mutex or ownership-partitioned SPSC queues?

## 43.7 Interview Check

1. Justify every memory order in the SPSC ring by naming the non-atomic slot accesses it orders.
2. Why is the SPSC capacity `N - 1`, and what alternatives preserve full/empty distinction?
3. Explain the MPMC cell sequence lifecycle. What fails if `T` assignment throws after a producer claims a ticket?
4. Is the presented MPMC queue wait-free, lock-free, or obstruction-free? Analyze a producer preempted after reservation.
5. Design a contention experiment that reports fairness per thread rather than only aggregate throughput.
6. Diagnose false sharing using layout, ownership, hardware counters, and a padding experiment. What alternative avoids shared writes entirely?
7. Why is a relaxed atomic `ready` flag insufficient to publish an object? State the release/acquire happens-before chain.
8. Compare `call_once`, function-local static initialization, and an atomic-pointer publisher in initialization cost, retry behavior, and reclamation.
9. Construct the use-after-free and ABA schedules in the broken Treiber pop.
10. Compare hazard pointers, epochs, reference counting, session-bounded no-reclaim, and a mutex by stalled-thread behavior, memory bound, and tail work.
