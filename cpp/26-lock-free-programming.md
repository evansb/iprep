# 26. Lock-Free Programming

Lock-free code replaces ownership of a critical section with atomic state transitions and explicit progress proofs. That trade can remove scheduler-driven tail spikes, but it also exposes contention, lifetime, and intermediate-state bugs that a mutex would have contained. The useful structures are the ones whose topology makes their correctness argument small.

## Blocking, non-blocking, and the progress ladder

A blocking algorithm can stop because another thread stopped. If a lock holder is preempted, incurs a page fault, or suffers priority inversion, every thread waiting for that lock inherits the delay.

A **non-blocking** algorithm prevents one suspended thread from stopping all other threads. That statement describes progress, not speed.

| Guarantee | Definition | Individual-thread guarantee | Example |
|---|---|---|---|
| blocking | progress may require another thread to run | none while holder stalls | spin-under-lock |
| obstruction-free | completes after enough isolated execution | none under interference | transactional retry |
| lock-free | the system continually completes operations | starvation allowed | CAS-retry stack |
| wait-free | every operation completes in bounded steps | completion for every thread | bounded SPSC `push`/`pop` |

The levels form a strict ladder: wait-free implies lock-free, and lock-free implies obstruction-free. The reverse implications do not hold.

Progress and safety are separate properties. An algorithm can be wait-free yet return corrupt results, or linearizable yet block forever behind a lock holder. A complete argument states both what histories are legal and who must make progress.

“Bounded steps” counts algorithmic steps taken by a scheduled thread, not wall-clock time. A wait-free operation can still suffer preemption, a cache miss, or an interrupt; it simply does not retry indefinitely because of another participant.

A spinlock uses atomics but remains blocking:

```cpp
#include <atomic>
#include <iostream>

class SpinLock {
public:
    void lock() {
        while (held_.test_and_set(std::memory_order_acquire)) {}
    }

    void unlock() {
        held_.clear(std::memory_order_release);
    }

private:
    std::atomic_flag held_ = ATOMIC_FLAG_INIT;
};

int main() {
    SpinLock lock;
    lock.lock();
    std::cout << "critical section\n";  // prints: critical section
    lock.unlock();
}
```

If the thread inside the critical section is descheduled, every spinner waits. Removing `std::mutex` did not remove a holder.

An uncontended mutex also commonly takes a short atomic fast path (Chapter 23). Lock-free algorithms can lose on throughput because retries and cache-line transfers cost more than that path. Their advantage is immunity to a stalled lock holder and, for stronger designs, a bound on operation steps.

**Rule.** Call an algorithm lock-free only after stating its global progress argument. “Contains no mutex” is not a progress proof.

## Linearizability and its limits

A concurrent operation is **linearizable** when it appears to take effect at one instant between invocation and return. That instant is its **linearization point**. Ordering all operations by those points must produce a legal sequential history while respecting operations that did not overlap.

The CAS-based stack insertion from Chapter 25 has a concrete point:

```cpp
struct Node {
    int value;
    Node* next;
};

std::atomic<Node*> head{nullptr};

void push(Node* node) {
    Node* expected = head.load(std::memory_order_relaxed);
    for (;;) {
        node->next = expected;
        if (head.compare_exchange_weak(
                expected, node,
                std::memory_order_release,
                std::memory_order_relaxed)) {  // linearization point
            return;
        }
    }
}
```

Before the successful CAS, `node` is not in the stack. After it, an acquire load of `head` can observe the fully initialized node. Failed attempts do not change the abstract stack.

Each atomic transition must preserve the structure's invariants because other threads can observe state between any two instructions. A CAS should move from one valid state to another, never into a “temporarily broken” state that a later store repairs.

The stack invariant is small: `head` is either null or points to a fully initialized node whose `next` chain is valid. Preparing `node->next` before the release CAS preserves it. Publishing `node` first and filling `next` afterward would expose an invalid chain even if the gap lasted one instruction.

Linearizable operations do not automatically make a linearizable compound action:

```cpp
class ConcurrentMap {
public:
    bool contains(int key) const;
    void insert(int key, int value);
    bool insert_if_absent(int key, int value);
};

void broken_create(ConcurrentMap& map, int key, int value) {
    if (!map.contains(key)) {
        map.insert(key, value);  // another thread may insert between calls
    }
}
```

```text
Thread 1                         Thread 2
contains(7) -> false
                                 contains(7) -> false
insert(7, first)
                                 insert(7, second)
```

Both calls can be individually linearizable while the check-then-act pair violates uniqueness. Use one compound `insert_if_absent` operation, or protect the pair with a lock.

Even a linearizable `size()` is stale as soon as another operation linearizes. Treat aggregate observations as snapshots with an explicit semantic, not facts that remain true after return.

Linearizability is composable at the object-operation level: a system of independently linearizable objects still has a history that respects each operation. It does not turn a client-side sequence of several operations into one atomic transaction. The missing boundary in check-then-act is a new operation, not a stronger memory order.

**Interview.** For a lock-free structure, identify the linearization point for success, empty/full failure, and retry. Then state the invariant immediately before and after each point.

## Contention and retry reality

A successful CAS needs exclusive ownership of its cache line. Under contention, several cores repeatedly request that ownership, invalidate one another's copies, fail, and retry.

Lock-free progress can therefore be expensive: some thread completes, but the group spends substantial work moving one line. The MESI-level mechanism belongs to *Computer Architecture and Performance Engineering*.

Backoff reduces the request rate after failures:

```cpp
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <thread>

std::atomic<std::uint64_t> counter{0};

void backoff(unsigned failures) {
    unsigned shift = std::min(failures, 8u);
    unsigned spins = 1u << shift;
    for (unsigned i = 0; i < spins; ++i) {
        std::atomic_signal_fence(std::memory_order_seq_cst);
    }
    if (failures > 8) {
        std::this_thread::yield();
    }
}

void increment() {
    std::uint64_t expected = counter.load(std::memory_order_relaxed);
    for (unsigned failures = 0;
         !counter.compare_exchange_weak(
             expected, expected + 1,
             std::memory_order_relaxed);
         ++failures) {
        backoff(failures);
    }
}
```

The failed CAS refreshes `expected`; the next attempt computes a desired value from that observation. The bounded exponential delay spreads retries, and `yield` eventually asks the scheduler to run another thread.

`std::atomic_signal_fence` prevents the empty spin from disappearing but is not a processor pause instruction. Production code normally uses a target-specific pause or yield instruction behind a portability wrapper, then escalates to scheduler yielding only after measurement.

Backoff trades individual latency for less coherence traffic. Jitter can keep synchronized contenders from waking together, but constants tuned on one processor, core count, or scheduler are not universal. Structural reduction—sharding state or replacing many producers with SPSC handoffs—usually beats retry tuning.

CAS fairness is not guaranteed. One core can repeatedly win ownership while another repeatedly refreshes `expected`, so a lock-free loop can starve a particular caller without violating its progress guarantee. Backoff can improve observed fairness but cannot promote the algorithm to wait-free.

**Pitfall.** A single-thread benchmark measures the path with no failed CAS and no line migration. It says almost nothing about a contended lock-free algorithm.

## Seqlocks

A seqlock fits a single writer publishing a small snapshot to many readers. Readers never block the writer; they detect an overlapping write and retry.

The sequence counter is even when the payload is stable and odd while the writer is changing it:

1. The writer changes the counter from even to odd.
2. The writer updates every payload field.
3. The writer changes the counter from odd to the next even value.
4. A reader accepts data only when equal even values bracket its payload reads.

Plain payload fields would race with the writer even if a reader later discarded a torn snapshot. The implementation below uses relaxed atomic fields, making every conflicting access atomic while the sequence protocol supplies snapshot consistency.

```cpp
struct Quote {
    std::int64_t bid_ticks;
    std::int64_t ask_ticks;
    std::uint64_t exchange_time;
};

class QuoteSeqLock {
public:
    void store(const Quote& quote) {
        sequence_.fetch_add(1, std::memory_order_relaxed);  // enter odd
        std::atomic_thread_fence(std::memory_order_release);
        bid_.store(quote.bid_ticks, std::memory_order_relaxed);
        ask_.store(quote.ask_ticks, std::memory_order_relaxed);
        time_.store(quote.exchange_time, std::memory_order_relaxed);
        sequence_.fetch_add(1, std::memory_order_release);  // publish even
    }

    Quote load() const {
        for (;;) {
            std::uint64_t before =
                sequence_.load(std::memory_order_acquire);
            if ((before & 1u) != 0) {
                continue;
            }

            Quote quote{
                bid_.load(std::memory_order_relaxed),
                ask_.load(std::memory_order_relaxed),
                time_.load(std::memory_order_relaxed)};

            std::atomic_thread_fence(std::memory_order_acquire);
            std::uint64_t after =
                sequence_.load(std::memory_order_relaxed);
            if (before == after) {
                return quote;
            }
        }
    }

private:
    std::atomic<std::uint64_t> sequence_{0};
    std::atomic<std::int64_t> bid_{0};
    std::atomic<std::int64_t> ask_{0};
    std::atomic<std::uint64_t> time_{0};
};
```

Only one thread may call `store`. Its relaxed odd increment is sequenced before a release fence, so a reader that observes a new payload field and executes its acquire fence cannot subsequently accept the older even sequence. The final release increment publishes all payload stores.

The reader's first acquire handles the other case: if it observes the writer's final even value, the following relaxed payload loads observe that publication or later values. The acquire fence after the payload loads participates in the fence-to-fence check against a writer entering the odd state. The final relaxed sequence load then detects overlap.

The proof has two directions. Observing a completed even generation publishes the corresponding payload; observing any field from an in-progress generation forces the final sequence check to observe the odd generation or something later. Equal even counters therefore bracket a payload that belongs to one stable generation.

This proof depends on payload accesses being atomic. `std::atomic_ref` **(C++20)** can apply the same relaxed operations to suitably aligned fields in an existing wire-layout type, but every concurrent access to those fields must then use `atomic_ref` (Chapter 25). Production also verifies that the selected atomic field types are lock-free on the target.

Keep seqlock payloads small and trivially copyable. Variable-size state, pointer-rich graphs, and operations with side effects do not fit a retrying snapshot reader.

Real-world seqlocks sometimes read and write plain payload bytes and rely on compiler extensions or platform behavior. In standard C++, those concurrent plain accesses form a data race and the retry does not repair the undefined behavior.

The sequence counter must not complete a full wrap between the reader's two counter loads. A wide unsigned counter makes that impossible within any realistic read operation, but the condition remains part of the proof rather than a property granted by seqlocks.

| Property | `std::shared_mutex` | Seqlock |
|---|---|---|
| reader cost | lock/unlock; shared count writes | atomic reads; possible retry |
| writer blocked by readers | yes | no |
| reader starvation | implementation-dependent | possible during write bursts |
| payload constraints | arbitrary protected state | small atomic-field snapshot |
| best fit | longer reads; multiple writers | one-writer quote snapshot |

Seqlock readers do not modify shared synchronization state, avoiding the bouncing reader count of a shared mutex. Large payloads widen the overlap window and turn write bursts into retry storms.

**Pitfall.** Reading the payload once without rechecking the sequence is not a seqlock. Multiple writers also require a separate writer-serialization mechanism.

## ABA and tagged pointers

CAS compares bits, not the history that produced them. If a pointer leaves a structure and the same address later returns with a different meaning, CAS cannot distinguish the two lifetimes.

A vulnerable pop has this shape:

```cpp
bool try_pop(Node*& result) {
    Node* observed = head.load(std::memory_order_acquire);
    while (observed != nullptr) {
        Node* next = observed->next;
        if (head.compare_exchange_weak(
                observed, next,
                std::memory_order_acq_rel,
                std::memory_order_acquire)) {
            result = observed;
            return true;
        }
    }
    return false;
}
```

The destructive interleaving is:

| Step | Thread 1 | Thread 2 | `head` |
|---:|---|---|---|
| 1 | reads `A`; saves `A->next == B` | | `A` |
| 2 | suspended | pops `A` | `B` |
| 3 | | pops `B`; unsafely frees `A` and `B` | `C` |
| 4 | | allocator reuses address `A`; pushes new node there | `A` |
| 5 | CAS expects address `A`, writes stale `B`; succeeds | | dangling `B` |

Thread 1's expected pointer equals the new head bit-for-bit. The successful CAS proves only equality at that instant, not that the node is the one Thread 1 inspected.

A **tagged pointer** compares an address and a generation together. Every head mutation increments the generation, so reuse of the same address no longer recreates the same CAS value.

```cpp
struct TaggedPointer {
    static constexpr std::uint64_t address_mask =
        (std::uint64_t{1} << 48) - 1;

    static std::uint64_t pack(Node* pointer, std::uint16_t tag) {
        auto address = reinterpret_cast<std::uintptr_t>(pointer);
        return (std::uint64_t{tag} << 48) | (address & address_mask);
    }

    static Node* pointer(std::uint64_t packed) {
        auto address = static_cast<std::uintptr_t>(packed & address_mask);
        return reinterpret_cast<Node*>(address);
    }

    static std::uint16_t tag(std::uint64_t packed) {
        return static_cast<std::uint16_t>(packed >> 48);
    }
};
```

This layout assumes usable pointers fit in the low 48 bits and round-trip after masking. That is a deployment-specific x86-64 lower-address convention, not a portable C++ property. Five-level paging, hardware pointer tags, capability pointers, and different virtual-address layouts invalidate the assumption.

**Note.** A 128-bit `{pointer, generation}` pair avoids stealing address bits, but lock-free double-width CAS support is implementation- and target-dependent. Check `is_lock_free()`; an `std::atomic` representation may call a library lock even when the type exists.

A 16-bit generation eventually wraps and can recreate the old packed value. The proof must bound mutations during the lifetime of any outstanding observation, not merely call wraparound unlikely.

Tagging fixes identity comparison; it does not make dereferencing an unlinked node safe. Thread 1 still needs a reclamation protocol to keep `observed` alive while reading `observed->next`. Tagged pointers and safe reclamation solve different halves of the stack problem.

Per-slot sequence numbers apply the same fix without packing a pointer. The MPMC ring in Section 9 versions each slot as it cycles through generations.

## Safe memory reclamation

Unlinking a node does not prove that no reader still holds its address. Freeing it too early turns a later dereference into use-after-free; postponing every free forever turns correctness into a leak.

This is the safe-memory-reclamation tax of pointer-based lock-free structures. The algorithm must prove both logical removal and physical lifetime.

A tracing garbage collector keeps reachable nodes alive automatically. C++ makes reclamation timing and its hot-path cost part of the structure's design.

### Hazard pointers

A hazard pointer is a per-thread publication saying, “this node may be dereferenced.” A reader publishes its candidate, rechecks that the shared pointer still names it, and only then dereferences.

```cpp
class HazardSlot {
public:
    void publish(Node* node) {
        protected_.store(node, std::memory_order_seq_cst);
    }

    void clear() {
        protected_.store(nullptr, std::memory_order_seq_cst);
    }

    Node* get() const {
        return protected_.load(std::memory_order_seq_cst);
    }

private:
    std::atomic<Node*> protected_{nullptr};
};

std::optional<int> read_head(HazardSlot& hazard) {
    for (;;) {
        Node* node = head.load(std::memory_order_acquire);
        hazard.publish(node);
        if (node != head.load(std::memory_order_acquire)) {
            continue;
        }
        if (node == nullptr) {
            hazard.clear();
            return std::nullopt;
        }
        int value = node->value;
        hazard.clear();
        return value;
    }
}
```

A reclaimer places unlinked nodes on a retired list, scans every hazard slot, and frees only nodes absent from the scan. Publishing before validation is essential: validating first leaves a window in which the node can be removed and freed before the hazard becomes visible.

Hazard pointers add a shared store and ordering cost to each protection. In return, periodic scans can bound unreclaimed memory when the number of registered threads and retirement threshold are bounded.

A typical thread accumulates a small retired batch before scanning, amortizing the scan across several removals. The bound therefore depends on participant count, hazard slots per participant, and the scan threshold; it is an engineering bound, not zero garbage.

The complete stack shape connects protection, removal, retirement, and scanning. This compact domain assigns one hazard slot to each registered thread:

```cpp
#include <array>
#include <atomic>
#include <optional>
#include <vector>

class HazardDomain {
public:
    static constexpr std::size_t max_threads = 64;

    void publish(std::size_t slot, Node* node) {
        hazards_[slot].store(node, std::memory_order_seq_cst);
    }

    void clear(std::size_t slot) {
        hazards_[slot].store(nullptr, std::memory_order_seq_cst);
    }

    bool protects(Node* node) const {
        for (const auto& hazard : hazards_) {
            if (hazard.load(std::memory_order_seq_cst) == node) {
                return true;
            }
        }
        return false;
    }

private:
    std::array<std::atomic<Node*>, max_threads> hazards_{};
};
```

The stack publishes a candidate before reading through it, validates that the candidate is still the head, then attempts removal:

```cpp
class HazardStack {
public:
    explicit HazardStack(HazardDomain& hazards)
        : hazards_(hazards) {}

    void push(int value) {
        Node* node = new Node{value, nullptr};
        node->next = head_.load(std::memory_order_relaxed);
        while (!head_.compare_exchange_weak(
                node->next, node,
                std::memory_order_release,
                std::memory_order_relaxed)) {
        }
    }

    std::optional<int> try_pop(
        std::size_t hazard_slot,
        std::vector<Node*>& retired) {
        for (;;) {
            Node* node = head_.load(std::memory_order_acquire);
            hazards_.publish(hazard_slot, node);

            if (node != head_.load(std::memory_order_acquire)) {
                continue; // publish and validate the new candidate
            }
            if (node == nullptr) {
                hazards_.clear(hazard_slot);
                return std::nullopt;
            }

            Node* next = node->next; // protected dereference
            if (!head_.compare_exchange_strong(
                    node, next,
                    std::memory_order_acq_rel,
                    std::memory_order_acquire)) {
                continue;
            }

            int value = node->value;
            hazards_.clear(hazard_slot);
            retire(node, retired);
            return value;
        }
    }

private:
    void retire(Node* node, std::vector<Node*>& retired) {
        retired.push_back(node);
        if (retired.size() < 2 * HazardDomain::max_threads) {
            return;
        }

        auto keep = retired.begin();
        for (Node* candidate : retired) {
            if (hazards_.protects(candidate)) {
                *keep++ = candidate;
            } else {
                delete candidate;
            }
        }
        retired.erase(keep, retired.end());
    }

    HazardDomain& hazards_;
    std::atomic<Node*> head_{nullptr};
};
```

Each participating thread owns one distinct `hazard_slot` and one private retired vector. The successful pop clears its own hazard before retiring the node, but another thread may still publish that node; the scan retains it until every slot has cleared.

The proof has four steps:

1. Publish the candidate.
2. Re-read `head`; retry if removal happened before publication became established.
3. Dereference and unlink only while the hazard remains published.
4. Reclaim only after a scan sees no published hazard for the retired node.

Registration, slot reuse after thread exit, allocation failure, shutdown, and final draining still need an owning domain in production. Shutdown normally stops and joins every participant, then reclaims the remaining stack and retired lists with no concurrent readers.

**Pitfall.** The retired vector can allocate during `try_pop`. A bounded low-latency implementation preallocates retirement storage or uses a fixed-capacity per-thread batch; reclamation correctness does not imply an allocation-free operation.

### Epoch-based reclamation

Epoch-based reclamation tracks whether each reader is inside a protected region. An unlinked node is tagged with the current epoch and freed only after every reader that could have observed it leaves that epoch.

Entering and leaving can be cheaper than publishing every pointer, and one region can protect many dereferences. A stalled reader, however, prevents the grace period from completing; deferred lists can grow without bound even while operations continue.

### Read-copy-update

Read-copy-update (RCU) makes read-side regions extremely cheap. A writer copies or builds replacement state, publishes it, then waits for a grace period before reclaiming the old state.

RCU moves work and storage to writers. It fits read-mostly structures whose readers can finish without blocking, but its grace-period and callback behavior belong to the chosen library and operating environment.

Epoch reclamation and RCU both require disciplined read-side registration. A thread that keeps a raw pointer after leaving its protected region defeats the grace-period proof just as surely as clearing a hazard pointer too early.

| Scheme | Mechanism | Read-side cost | Reclamation latency | Memory bound | Complexity |
|---|---|---|---|---|---|
| hazard pointers | publish pointer; scan slots | store plus ordering per protection | scan threshold | bounded with bounded participants | high |
| epoch-based | enter/exit epoch | small region bookkeeping | slowest reader | unbounded if reader stalls | medium |
| RCU | read-side region; grace period | very low | grace period | workload/library-dependent | high |
| pool plus index | never free slots; version reuse | ordinary indexed access | none on hot path | fixed pool capacity | low after design shift |

**Note.** The C++26 working draft contains standard hazard-pointer and RCU facilities, adopted from P2530 and P2545, but C++23 libraries do not provide them and implementation availability can lag. Folly's `hazptr` and userspace `liburcu` are established production implementations.

The strongest simplification is to avoid reclamation. A preallocated pool can keep every slot alive for the process, identify it by index, and increment a slot generation on reuse. Lifetime reclamation and pointer ABA both disappear from the hot path; capacity becomes an explicit system limit (Chapter 17).

**Pitfall.** One stalled epoch reader can retain every subsequently retired node. Hazard pointers avoid that failure only when readers publish, validate, clear, and reclaim according to the complete protocol.

## Queue topologies

Queue topology determines which threads contend on each end. Choosing the narrowest topology is a system design decision, not a container substitution.

| Topology | Producer-end contention | Consumer-end contention | Complexity | Typical trading use |
|---|---|---|---|---|
| SPSC | none | none | lowest | market data to strategy; async logging |
| MPSC | CAS among producers | none | medium | many strategies to one journaler |
| MPMC | CAS among producers | CAS among consumers | highest | general worker pool |

A single-producer, single-consumer (SPSC) queue gives each index exactly one writer. It is the natural handoff from a market-data decoder to one strategy and fulfills the asynchronous logging queue introduced in Chapter 15.

A multiple-producer, single-consumer (MPSC) queue serializes producer claims at its tail while the consumer owns its head. It suits aggregation when changing the upstream thread graph is more expensive than producer contention.

MPSC is often the right boundary for centralized journaling: many producers pay one tail claim, while the only consumer writes records in queue order. If each producer can instead own an SPSC queue, the journaler can poll those queues and remove producer-to-producer contention at the cost of an explicit merge policy.

Multiple-producer, multiple-consumer (MPMC) queues contend at both ends and usually carry per-slot synchronization as well. They fit general executors (Chapters 23 and 24), but they are an expensive default for a stream that is structurally SPSC.

**Rule.** Engineer SPSC edges between stages where possible. Do not buy MPMC coordination for producers or consumers the architecture does not have.

## Bounded SPSC ring buffer

A bounded ring preallocates every slot and returns failure when full or empty. Monotonically increasing counters describe logical positions; masking maps a position to a physical slot.

For a power-of-two capacity `N`, `position & (N - 1)` equals `position % N` without division. Only the array access wraps. Unsigned subtraction `tail - head` remains the occupancy while the invariant keeps it between zero and `N`, including across counter wrap.

```cpp
template<class T, std::size_t N>
requires (std::is_nothrow_move_constructible_v<T> &&
          std::is_nothrow_move_assignable_v<T> &&
          std::is_nothrow_destructible_v<T>)
class SpscRing {
    static_assert(N > 0 && (N & (N - 1)) == 0);
    static_assert(std::atomic<std::uint64_t>::is_always_lock_free);

public:
    bool push(T&& value) noexcept {
        std::uint64_t tail =
            tail_.load(std::memory_order_relaxed);  // producer-owned
        if (tail - cached_head_ == N) {
            cached_head_ =
                head_.load(std::memory_order_acquire);  // observe frees
            if (tail - cached_head_ == N) {
                return false;
            }
        }

        slots_[tail & (N - 1)].emplace(std::move(value));
        tail_.store(tail + 1, std::memory_order_release);  // publish item
        return true;
    }

    bool pop(T& value) noexcept {
        std::uint64_t head =
            head_.load(std::memory_order_relaxed);  // consumer-owned
        if (cached_tail_ == head) {
            cached_tail_ =
                tail_.load(std::memory_order_acquire);  // observe items
            if (cached_tail_ == head) {
                return false;
            }
        }

        auto& slot = slots_[head & (N - 1)];
        value = std::move(*slot);
        slot.reset();
        head_.store(head + 1, std::memory_order_release);  // publish free
        return true;
    }

private:
    alignas(64) std::atomic<std::uint64_t> head_{0};
    std::uint64_t cached_tail_{0};

    alignas(64) std::atomic<std::uint64_t> tail_{0};
    std::uint64_t cached_head_{0};

    alignas(64) std::array<std::optional<T>, N> slots_{};
};
```

Only the producer writes `tail_`, so its own load is relaxed. The consumer's acquire load of `tail_` reads the producer's release publication before touching the slot. The consumer destroys the moved-from element before its release store to `head_`; the producer's acquire load of `head_` observes that slot as reusable.

The cached peer index makes the common path cheaper. The producer refreshes `head_` only when its stale cache says full; a stale lower head is conservative. The consumer refreshes `tail_` only when its stale cache says empty.

There is no wasted slot and no separate full flag. A `size()` computed from independent head and tail loads would be advisory because the other thread can advance between the observations.

The `alignas(64)` boundaries separate producer-written state, consumer-written state, and storage under the deployment assumption of 64-byte destructive-interference lines. `std::hardware_destructive_interference_size` **(C++17)** expresses an implementation value when available, but compiler support and stability across build targets require care.

The queue algorithm contains no retry loop: each call performs a fixed amount of work and returns `false` instead of waiting. Its operations are wait-free on a target where 64-bit atomic loads and stores, plus `T`'s move and destruction, complete in bounded steps. `is_always_lock_free` is a necessary deployment check here, but the standard's lock-free label alone is not a formal wait-free guarantee.

The non-throwing constraints keep a slot from becoming engaged or half-consumed while its index remains unpublished. A production interface can add copy and in-place construction paths, but each must preserve the same publication protocol (Chapter 7).

**Pitfall.** Masking silently fails for a non-power-of-two capacity, which is why the condition is a `static_assert`. Do not remove the acquire/release pair because a favorable x86 disassembly appears to use plain loads and stores.

## MPMC and per-slot sequences

An MPMC ring cannot give one thread ownership of either global index. Producers compete for tail tickets, consumers compete for head tickets, and each reusable slot carries its own generation.

The producer half of a bounded Vyukov-style queue shows the core:

```cpp
struct Order {
    std::uint64_t id;
};

struct Cell {
    std::atomic<std::size_t> sequence{0};
    std::optional<Order> value;
};

template<std::size_t N>
class MpmcPushCore {
    static_assert(N > 0 && (N & (N - 1)) == 0);

public:
    MpmcPushCore() {
        for (std::size_t i = 0; i < N; ++i) {
            cells_[i].sequence.store(i, std::memory_order_relaxed);
        }
    }

    bool try_push(Order&& order) {
        std::size_t ticket = enqueue_.load(std::memory_order_relaxed);
        for (;;) {
            Cell& cell = cells_[ticket & (N - 1)];
            std::size_t sequence =
                cell.sequence.load(std::memory_order_acquire);
            auto difference =
                static_cast<std::intptr_t>(sequence - ticket);

            if (difference == 0 &&
                enqueue_.compare_exchange_weak(
                    ticket, ticket + 1,
                    std::memory_order_relaxed)) {  // claim ticket
                cell.value.emplace(std::move(order));
                cell.sequence.store(
                    ticket + 1, std::memory_order_release);  // publish
                return true;
            }
            if (difference == 0) {
                continue;  // failed CAS refreshed ticket
            }
            if (difference < 0) {
                return false;  // earlier generation still owns the slot
            }
            ticket = enqueue_.load(std::memory_order_relaxed);
        }
    }

private:
    std::array<Cell, N> cells_{};
    alignas(64) std::atomic<std::size_t> enqueue_{0};
};
```

Each initial `cell.sequence` equals its slot index. The ticket CAS is relaxed because it reserves a position; the per-cell acquire/release pair publishes the element. The signed `difference` interpretation assumes the counters never separate by half their range, which follows from the bounded-capacity invariant and operational counter-width assumption.

The consumer mirrors the protocol. It claims a dequeue ticket when `cell.sequence == ticket + 1`, moves and destroys the value, then stores `ticket + N` with release semantics. The next producer generation waits for exactly that value, so the slot's sequence prevents ABA across wraparound.

Both ends pay CAS retries, and every item transfers ownership of a per-slot sequence line. Restructuring one MPMC edge into SPSC pairs removes those shared ticket contests.

Per-slot sequences separate “slot zero in this lap” from “slot zero in a later lap.” The global counter may map to the same array index, but the expected generation differs, so stale claims fail rather than confusing recycled storage for the old state.

**Note.** If a producer claims the next FIFO ticket and is suspended before publishing its cell, consumers stop at that hole even if later producers filled later cells. This bounded design is commonly called lock-free, but under the strict progress definition from Section 1, that stalled claimant prevents global completion once the ring fills.

## Backpressure and the close

A full bounded queue is not merely a container condition. It forces a policy decision about what the data means.

| Policy | Data-loss semantics | Producer latency | Consumer view | Market-data fit | Order-flow fit |
|---|---|---|---|---|---|
| drop new | lose latest arrival | bounded | gap; older backlog retained | sometimes | prohibited |
| drop old | lose oldest queued item | bounded | newer state favored | good for replaceable quotes | prohibited |
| conflate/overwrite | replace state for one key | bounded | latest state, not every transition | excellent for quotes | prohibited |
| return failure | caller decides explicitly | bounded | unchanged | good with metrics | good if failure is fatal/escalated |
| spin | no loss while consumer recovers | unbounded CPU time | every item eventually | short controlled bursts | risky |
| block | no loss | scheduler-dependent | every item eventually | usually poor | possible with explicit upstream contract |

Quotes are often conflatable because a newer top-of-book supersedes an older one. Orders, acknowledgements, and fills are an event history; silently dropping any of them is a correctness and compliance failure. Conflation also needs a synchronization design for the overwritten slot—it is not permission to race a consumer.

Drop-old cannot be bolted onto the SPSC implementation by letting the producer advance `head_`: that would violate the single-writer invariant for the consumer-owned index. Implement consumer cooperation or use a purpose-built conflation slot with its own publication protocol.

**Pitfall.** Silent drop-new on an order path is a compliance incident, not a harmless queue optimization. Blocking a producer preserves data but reintroduces the scheduling coupling the queue was meant to remove.

## Putting the pieces together: decode and hand off

A bounded ingress path combines the book's library and concurrency contracts. The packet is a non-owning span, parsing returns a typed error, the decoded message is a closed variant, and the SPSC queue makes overload visible.

This compact wire example accepts `T|price|quantity` and `Q|price|quantity`:

```cpp
#include <charconv>
#include <expected>
#include <span>
#include <string_view>
#include <utility>
#include <variant>

struct Trade {
    int price;
    int quantity;
};

struct Quote {
    int price;
    int quantity;
};

using Message = std::variant<Trade, Quote>;

enum class DecodeError {
    short_message,
    unknown_kind,
    missing_separator,
    invalid_number
};

std::expected<int, DecodeError> parse_int(std::string_view field) {
    int value = 0;
    const char* end = field.data() + field.size();
    auto [next, error] =
        std::from_chars(field.data(), end, value);
    if (error != std::errc{} || next != end) {
        return std::unexpected(DecodeError::invalid_number);
    }
    return value;
}

std::expected<Message, DecodeError>
decode(std::span<const char> packet) {
    std::string_view text{packet.data(), packet.size()};
    if (text.size() < 5 || text[1] != '|') {
        return std::unexpected(DecodeError::short_message);
    }

    const std::size_t separator = text.find('|', 2);
    if (separator == std::string_view::npos) {
        return std::unexpected(DecodeError::missing_separator);
    }

    auto price = parse_int(text.substr(2, separator - 2));
    auto quantity = parse_int(text.substr(separator + 1));
    if (!price || !quantity) {
        return std::unexpected(DecodeError::invalid_number);
    }

    if (text[0] == 'T') {
        return Trade{*price, *quantity};
    }
    if (text[0] == 'Q') {
        return Quote{*price, *quantity};
    }
    return std::unexpected(DecodeError::unknown_kind);
}
```

The producer inspects the variant without virtual dispatch, then transfers the value into the preallocated queue:

```cpp
template<class... Functions>
struct Overloaded : Functions... {
    using Functions::operator()...;
};

void record_trade();
void record_quote();
void record_decode_error(DecodeError);
void record_queue_full();

class Ingress {
public:
    explicit Ingress(SpscRing<Message, 1'024>& output)
        : output_(output) {}

    void on_packet(std::span<const char> packet) {
        auto decoded = decode(packet);
        if (!decoded) {
            record_decode_error(decoded.error());
            return;
        }

        Message message = std::move(*decoded);
        std::visit(Overloaded{
            [](const Trade&) { record_trade(); },
            [](const Quote&) { record_quote(); }
        }, message);

        if (!output_.push(std::move(message))) {
            record_queue_full();
        }
    }

private:
    SpscRing<Message, 1'024>& output_;
};
```

No owner is hidden:

- The packet owner outlives `decode`; no view escapes the call.
- `expected` owns either the variant or the decode error.
- The local variant owns the decoded fields.
- A successful `push` moves ownership into one ring slot.
- A full queue returns `false`; the caller records or escalates the overload policy.

The parsing and visitation still perform branches, and metrics must themselves be allocation-free if this is a hot path. The important property is structural: no failure silently grows storage, blocks a thread, or discards an order-like event.

The bounded ring is the book's pieces in one type: value semantics and moves transfer elements, library vocabulary shapes its interface, layout and preallocated storage control its footprint, templates specialize capacity at compile time, and the memory model proves publication and reuse. That combination is the practical standard for the rest of the system: make cost, lifetime, and concurrency contracts visible in the code that depends on them.

## Latency Lens

- Lock-free progress removes holder stalls, not contention; a retrying CAS can cost more than an uncontended mutex fast path.
- Every failed CAS can require another exclusive cache-line transfer, while backoff trades immediate latency for a more stable ownership pattern.
- Seqlock readers perform no writes to synchronization state, avoiding the shared-reader-count traffic of `std::shared_mutex`.
- The SPSC hot path uses owner-relaxed index access and one release publication; cached peer indexes avoid acquire loads until apparent full or empty.
- Separating `head_`, `tail_`, and slots with `alignas(64)` prevents unrelated producer and consumer writes from sharing their synchronization lines on the assumed target.
- Pool-and-index designs remove both reclamation scans and pointer ABA from the hot path by keeping slot lifetime fixed and versioning reuse.
- Hazard-pointer readers publish an ordered shared store per protection; epoch readers are cheaper but a stalled participant retains deferred memory.
- A complete hazard-protected pop performs publish, validate, unlink, clear, retire, and eventual scan; omitting a stage permits either reuse-before-read or permanent retention.
- MPMC pays CAS contention at both ticket counters plus per-slot sequence coherence; SPSC topology removes both contests.
- Conflation keeps producer latency bounded under quote bursts, but the same policy is invalid for orders, acknowledgements, and fills.
- A span-to-expected-to-variant ingress path keeps borrowing, typed failure, value ownership, and bounded queue overload visible at each handoff.
