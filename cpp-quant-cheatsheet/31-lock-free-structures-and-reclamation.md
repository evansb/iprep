# 31. Lock-free structures and reclamation

*Part V — Concurrency and the memory model*

---

**Recall**
- Linearizability is a *safety* property: each operation appears to take effect atomically at one instant between its invocation and its response.
- Progress is a *separate* property: obstruction-free < lock-free < wait-free, and a linearizable structure may still be blocking.
- Lock-free means *some* thread makes progress system-wide; wait-free bounds *every* operation in its own steps.
- Naming a CAS is not a linearizability proof — the chosen point must produce the abstract result under every interleaving.
- An SPSC algorithm does not become MPMC by making its indices atomic; restrictions buy exclusive-writer ownership, not thread safety.
- SPSC works because each index has exactly one writer, so arbitration is replaced by ownership transfer.
- Publication order is correctness: construct/write the payload first, then release-store the index or sequence number.
- The consumer's acquire on the producer's index is what makes the payload visible; the reverse edge prevents overwriting an unconsumed slot.
- A thread may load its *own* index relaxed (single writer) but must acquire the *other* side's index.
- Wrapped-index rings sacrifice one slot because equality of the two indices already means empty.
- Monotonic-counter rings rely on unsigned modular arithmetic: `write - read` is valid only while capacity stays far below half the modulus.
- Power-of-two masking (`c & (N-1)`) requires `std::has_single_bit(N)`; never mix logical sequence counters with array indices.
- Nothing is truly unbounded — an "unbounded" queue converts overload into allocation latency, memory growth, or failure.
- Unlinking removes reachability; it does not prove that no thread still holds a pointer, so retire ≠ delete.
- ABA is a *representation* problem (a value returns to A); use-after-free is a *lifetime* problem — a version tag fixes only the first.
- A generation tag detects reuse only until the tag wraps, and loading a tag never keeps the pointed-to storage alive.
- Hazard pointers: publish the candidate pointer, **revalidate** by reloading the source, retry on change, clear when done.
- Epoch/QSBR reclamation is cheap on the read side but one stalled active reader can block an entire retirement backlog.
- RCU-style publication = build a copy, release-publish the new pointer, wait a grace period, then reclaim the old version.
- ISO C++23 has no general standard-library RCU or hazard-pointer facility (both are library-fundamentals TS / third-party).
- Reference counting trades lifetime safety for shared-control-block contention and nondeterministic last-release destruction.
- Acquiring a reference from a raw `atomic<T*>` is racy: the object can hit zero between the load and the increment — use `atomic<shared_ptr<T>>` or another protection scheme.
- Backoff, spinning, and yielding change performance and progress behavior, never linearizability.
- C++23 has no portable CPU-pause intrinsic; `std::this_thread::yield()` is only a scheduler hint and may do nothing.
- A "lock-free queue" claim is void if allocation, a pool mutex, or unbounded retry sits on the path — always state the scope.
- Throughput hides lost and duplicated values; verify exactly-once delivery with unique sequence IDs, not with ops/sec.

---

## 31.1 Progress guarantees and linearizability

```text
abstract object semantics
       │ choose ONE atomic effect per successful operation
       ▼
linearization point ──► operation appears between invocation and response
       ├── ordering proof   : published contents become visible (release→acquire)
       ├── ownership proof  : exactly one thread may mutate each slot/node phase
       ├── progress proof   : blocking | obstruction | lock-free | wait-free
       └── lifetime proof   : unreachable ≠ safe to destroy or reuse
                              └── hazard | epoch | refcount | quiescence
```

| Level | Guarantee | Typical construct |
|---|---|---|
| Blocking | A stalled holder can stall everyone | `mutex`, `scoped_lock` |
| Obstruction-free | A thread finishes if it eventually runs alone | naive CAS loop with no contention manager |
| Lock-free | *Some* thread completes in a bounded number of *system* steps | Treiber stack, Michael–Scott queue |
| Wait-free | *Every* thread completes in a bounded number of *its own* steps | atomic `fetch_add` ticket, SPSC ring ops |

```cpp
#include <atomic>
// ---- wait-free: no loop, one RMW, bounded steps -----------------------
std::atomic<std::uint64_t> seq_{0};
std::uint64_t next() noexcept {
    return seq_.fetch_add(1, std::memory_order_relaxed);  // wait-free
}

// ---- lock-free: loop, but a failed CAS means SOMEONE ELSE succeeded ---
std::atomic<int> best_{0};
void raise_to(int v) noexcept {
    int cur = best_.load(std::memory_order_relaxed);
    while (v > cur &&
           !best_.compare_exchange_weak(cur, v,                 // cur updated on fail
                                        std::memory_order_release,
                                        std::memory_order_relaxed)) {}
}                                                        // lock-free, not wait-free

// ---- obstruction-free only: retry can livelock two mutual helpers -----
// (two threads that keep undoing each other's tentative state)

// ---- C++17: is this type actually lock-free? --------------------------
static_assert(std::atomic<std::uint64_t>::is_always_lock_free); // compile time
bool ok = std::atomic<__int128>{}.is_lock_free();               // run time
```

| Operation | Candidate linearization point |
|---|---|
| Treiber `push` | Successful CAS installing the new head |
| Treiber `pop` | Successful CAS removing the observed head |
| SPSC `try_push` | Release store publishing the advanced write index |
| SPSC `try_pop` | Release store publishing the advanced read index |
| Failed bounded `push` (returns `full`) | The load that proves the capacity state |
| `fetch_add` ticket | The RMW itself (atomic by definition) |

- A completed operation's point must lie inside `[invocation, response]`; non-overlapping calls must keep real-time order.
- A *failed* operation still needs a linearization point — usually the observation that justified the failure.
- Lock-freedom is a property of a *whole* operation including allocation, pool acquisition, and reclamation.

**Interview line** — "A linearization point is the instant between call and return at which the operation can be viewed as taking effect on the abstract object; progress is a separate proof about whether operations finish at all."

**Traps** — claiming lock-freedom while calling `new` · assuming `is_lock_free()` implies address-free (shared-memory safe) · a linearizable structure that is still blocking · a lock-free structure whose values emerge out of order and is therefore not linearizable.

---

## 31.2 SPSC versus MPSC versus SPMC versus MPMC constraints

| Topology | Producers | Consumers | What the restriction buys |
|---|---:|---:|---|
| SPSC | 1 | 1 | Each side exclusively writes its own index and its own slot phase |
| MPSC | many | 1 | Consumer state stays private; producers need arbitration (CAS / `fetch_add` / swap) |
| SPMC | 1 | many | Producer state stays private; consumers need arbitration |
| MPMC | many | many | Both reservation *and* publication/consumption need coordination |

```cpp
// ---- invariant checklist: answer ALL of these BEFORE writing code -----
// I1 which thread may write each field?
// I2 which state means empty / full / reserved / published / retired?
// I3 which operation transfers ownership of a slot or node?
// I4 what is the linearization point of each operation (incl. failures)?
// I5 which acquire reads from which release (draw every edge)?
// I6 when may an object's lifetime begin and end?
// I7 can a counter or tag wrap while an old observation is still live?
// I8 what happens at capacity, at shutdown, and on a partially-written slot?
// I9 does the progress claim include allocation, pooling, and reclamation?
```

```cpp
// ---- MPSC: producers arbitrate by atomic exchange of the head --------
struct Node { std::atomic<Node*> next{nullptr}; Order value; };
std::atomic<Node*> head_{nullptr};

void mpsc_push(Node* n) noexcept {                 // wait-free per producer
    n->next.store(nullptr, std::memory_order_relaxed);
    Node* prev = head_.exchange(n, std::memory_order_acq_rel); // single RMW
    if (prev) prev->next.store(n, std::memory_order_release);  // link after
}
// Consumer may briefly see a NULL next on a node already exchanged in:
// the list is momentarily "broken" between exchange and the link store.

// ---- SPMC / MPMC: consumers must CAS the read index ------------------
std::atomic<std::size_t> read_{0};
bool claim(std::size_t& out) noexcept {
    std::size_t r = read_.load(std::memory_order_relaxed);
    do {
        if (r == published_.load(std::memory_order_acquire)) return false; // empty
    } while (!read_.compare_exchange_weak(r, r + 1,
                 std::memory_order_acquire, std::memory_order_relaxed));
    out = r;                                        // this consumer owns slot r
    return true;
}
```

- Reservation (claiming a position) and publication (payload is readable) are **distinct states**; MPMC rings need a per-slot sequence/generation to distinguish cycles.
- Two producers on an SPSC ring is not "slightly racy" — the producer-private index assumption collapses entirely.
- "Mostly one producer" is still many producers; the correct fix is separate SPSC channels or a proved MPSC algorithm.

**Traps** — atomics on indices do not add arbitration · a single-consumer optimization silently broken by adding a "helper" drain thread · assuming a shutdown/flush thread is not a participant.

---

## 31.3 Ring-buffer sequence and ownership invariants

> The full SPSC ring — both the wrapped-index and monotonic-counter variants, raw-storage
> element lifetime, index caching, batch operations, and the cache-line layout — is built and
> tested in [Chapter 36](/iprep/books/cpp-cheatsheet/36-bounded-spsc-ring-buffer/). What matters *here* is the
> invariant structure that makes it lock-free, and why that structure does not survive the
> jump to multiple producers.

```text
--- proof sketch (the five edges) ---------------------------------------
1 producer exclusively writes write_ and writes only an EMPTY slot
2 consumer's acquire on write_ reads-from producer's release  → payload visible
3 consumer exclusively reads/moves from a FULL slot
4 consumer's release on read_ returns the slot
5 producer's acquire on read_ reads-from that release → no overwrite-before-consume
```

```cpp
// ---- MPMC slot state machine: sequence number per slot ----------------
template<class T> struct Cell {
    std::atomic<std::uint64_t> seq;   // == index      → free to reserve (producer)
    T value;                          // == index + 1  → published (consumer may take)
};
// producer: CAS enqueue_pos; write value; seq.store(pos + 1, release)
// consumer: CAS dequeue_pos; read value; seq.store(pos + N, release)
// The seq store is BOTH the publication and the ABA-free cycle marker.
```

| Design point | SPSC (2 indices) | MPMC (per-slot sequence) |
|---|---|---|
| Capacity vs storage | Wrapped-index: storage `N+1`, capacity `N`; monotonic counters: storage `N`, capacity `N` | storage `N`, capacity `N` |
| Slot ownership | Implied by index order — no per-slot state needed | Explicit: `seq` *is* the slot's state machine |
| Reservation | None — the single writer already owns the slot | CAS on the shared position; may fail and retry |
| Linearization point | The `release` store of the owner's index | The `release` store of `seq` |
| Progress | Wait-free: bounded steps, no CAS loop | Lock-free only: a stalled reserver blocks its slot |
| ABA | Impossible — indices are owned, not contended | Handled by the `+N` cycle marker on `seq` |

- The five edges above hold *because* each index has exactly one writer. Add a second producer and edges 1 and 5 both fail: two threads reserve the same slot, and neither's `release` is ordered against the other's payload write.
- A stalled MPMC producer between "CAS the position" and "store `seq`" leaves a permanent hole that consumers must spin on — which is exactly why MPMC is lock-free but not wait-free.
- The memory-order assignment (own index `relaxed`, other index `acquire`, publication `release`) and its proof are in [§36.4](/iprep/books/cpp-cheatsheet/36-bounded-spsc-ring-buffer/).

**Traps** — reading `size()` and then acting on it · assuming an SPSC correctness argument transfers to MPMC because the code "looks the same" · a per-slot `seq` narrower than the position counter, so the `+N` marker wraps into a live value.

---

## 31.4 Bounded versus unbounded queues

| Property | Bounded ring | Linked "unbounded" queue |
|---|---|---|
| Memory | Fixed, preallocated | Allocation or pool per node |
| Full state | Explicit, in the API | Hidden — becomes `bad_alloc` or OOM |
| Locality | Compact, prefetchable | Pointer chasing, one miss per node |
| Overload | Must be named and handled | Silently absorbed as growth |
| Tail latency | No hot-path allocation if designed so | Allocation and reclamation spikes |
| Progress claim | Can be wait-free (SPSC) | Bounded by the allocator's own guarantees |

```cpp
// ---- naming the full policy is part of the type ----------------------
enum class PushResult { Ok, Full, Stopped };

PushResult publish(Tick const& t) noexcept {
    if (stopped_.load(std::memory_order_acquire)) return PushResult::Stopped;
    return ring_.try_push(t) ? PushResult::Ok : PushResult::Full;
}
// Overload policies, pick ONE and document it (the *waiting* strategies —
// spin, yield, block, semaphore — and their cost table are in §36.9):
//   drop-newest    : return Full, caller retries or accounts a gap
//   drop-oldest    : overwrite (only safe for last-value/conflated feeds)
//   block          : ring_.wait() — no longer lock-free
//   coalesce       : merge into the tail slot (needs slot-level ownership proof)
//   escalate       : increment a loss counter and signal a recovery/snapshot path
```

```cpp
// ---- Michael–Scott style unbounded MPMC queue (sketch of the shape) ---
struct MsNode { std::atomic<MsNode*> next{nullptr}; T value; };
std::atomic<MsNode*> head_, tail_;                  // dummy node always present

void enqueue(T v) {
    auto* n = pool_.acquire(std::move(v));          // <-- progress claim lives HERE
    for (;;) {
        MsNode* t = tail_.load(std::memory_order_acquire);
        MsNode* next = t->next.load(std::memory_order_acquire);
        if (next) { tail_.compare_exchange_weak(t, next,           // help: swing tail
                        std::memory_order_release, std::memory_order_relaxed);
                    continue; }
        if (t->next.compare_exchange_weak(next, n,                 // linearization pt
                std::memory_order_release, std::memory_order_relaxed)) {
            tail_.compare_exchange_strong(t, n,                    // best-effort
                std::memory_order_release, std::memory_order_relaxed);
            return;
        }
    }
}
// Dequeue must NOT free the popped node directly — see 31.5 / 31.7.
```

- The "helping" CAS that swings a lagging `tail_` is what makes the algorithm lock-free rather than obstruction-free.
- A fixed-size node pool restores boundedness and removes the allocator from the progress argument — but reintroduces an explicit exhaustion policy.
- Ordered market-data pipelines almost always want `Full` to trigger explicit backpressure or a snapshot-recovery path, never silent growth.

**Interview line** — "No queue is unbounded; an unbounded API just moves the overload decision from your code into the allocator."

**Traps** — `while (!q.try_push(x));` in a producer converts a bounded design into an unbounded stall · treating `bad_alloc` as unreachable · a "growable" ring whose resize is not linearizable.

---

## 31.5 Intrusive structures and node lifetime

```cpp
struct Node {
    std::atomic<Node*> next{nullptr};   // link is atomic
    Order value;                        // payload is NOT thereby concurrent-safe
};
```

The container does **not** own lifetime; the API must state:

| Question | Must be answered by the type's contract |
|---|---|
| Who constructs and destroys nodes? | Caller, pool, or container |
| May a node be in two structures at once? | Needs distinct link fields per structure |
| When may `next` be mutated? | Only in a stated phase (unlinked / owned) |
| Are addresses stable? | Required for intrusive links; forbids `vector` storage |
| How are removed nodes retired? | Retire list + reclamation scheme |
| How does shutdown drain retirees? | Explicit quiescence + final sweep |

```cpp
// ---- Treiber stack: push is easy, pop is where lifetime breaks --------
std::atomic<Node*> head_{nullptr};

void push(Node* n) noexcept {                        // lock-free
    Node* old = head_.load(std::memory_order_relaxed);
    do { n->next.store(old, std::memory_order_relaxed); }
    while (!head_.compare_exchange_weak(old, n,
               std::memory_order_release,            // publish n->next and payload
               std::memory_order_relaxed));
}

Node* pop_without_reclamation() noexcept {           // *** UNSAFE ***
    Node* old = head_.load(std::memory_order_acquire);
    while (old) {
        Node* next = old->next.load(std::memory_order_relaxed); // (A) DEREFERENCE
        if (head_.compare_exchange_weak(old, next,
                std::memory_order_acquire, std::memory_order_relaxed))
            return old;
    }
    return nullptr;
}
// Between the head load and (A) another thread may pop AND delete `old`:
//   → use-after-free.
// It may also recycle the same address back onto the head:
//   → ABA; the CAS succeeds and installs a stale `next`, losing or
//     resurrecting nodes.
```

```text
unlink        head_ no longer reaches the node          ← reachability
retire        node is queued for eventual destruction   ← intent
reclaim       destructor runs / slot returns to a pool  ← requires a PROOF
```

- Making `next` atomic makes the *link* race-free; it says nothing about `value` or about keeping the node alive.
- Every intrusive design needs a stated "no thread can still be dereferencing this" argument — that is the whole subject of 31.7.
- Node reuse from a pool is *also* reclamation: writing a recycled node's fields while a reader dereferences it is the same bug as `delete`.

**Traps** — `delete old;` immediately after a successful pop CAS · reusing a node from a free list without a grace proof · storing intrusive nodes in a relocating container · sharing one `next` field between two lists.

---

## 31.6 ABA-resistant designs

```cpp
#include <cstdint>
#include <atomic>
#include <type_traits>

// ---- tagged index: pointer replaced by index + generation ------------
struct TaggedIndex {
    std::uint32_t index;        // slot in a fixed pool  → no raw pointers
    std::uint32_t generation;   // bumped on EVERY reuse → detects recycling
};
static_assert(std::is_trivially_copyable_v<TaggedIndex>);
static_assert(sizeof(TaggedIndex) == 8);
std::atomic<TaggedIndex> head_{};                     // usually lock-free at 8 bytes
static_assert(std::atomic<TaggedIndex>::is_always_lock_free);

bool pop(std::uint32_t& out) noexcept {
    TaggedIndex cur = head_.load(std::memory_order_acquire);
    for (;;) {
        if (cur.index == kNil) return false;
        TaggedIndex nxt{pool_[cur.index].next, cur.generation + 1};  // bump tag
        if (head_.compare_exchange_weak(cur, nxt,
                std::memory_order_acquire, std::memory_order_relaxed)) {
            out = cur.index;
            return true;
        }
    }
}

// ---- double-width CAS: 16-byte tagged pointer ------------------------
struct alignas(16) TaggedPtr { Node* p; std::uint64_t tag; };
std::atomic<TaggedPtr> head16_{};
// is_lock_free() is RUNTIME here on many targets; a 16-byte atomic may
// silently degrade to a mutex, destroying the lock-free claim.
bool ok = head16_.is_lock_free();   // check, and check with your real flags

// ---- pointer packing: portable ONLY under stated assumptions ---------
// Stuffing a tag into the unused high bits of a pointer relies on a
// platform address-space guarantee and breaks pointer provenance;
// round-tripping through uintptr_t is implementation-defined.
```

| Technique | Detects reuse until | Protects dereference? | Cost |
|---|---|---|---|
| Version/generation tag | The tag wraps | **No** | Widens the atomic |
| Index into a fixed pool | Tag wraps | No (slot may be rewritten) | Bounds capacity |
| Double-width CAS (`cmpxchg16b`) | 64-bit tag wrap (practically never) | No | May not be lock-free; alignment |
| Packed high-bit tag | Few bits → wraps fast | No | Non-portable, provenance UB |
| Prevent reuse while exposed (hazard/epoch) | n/a — reuse cannot happen | **Yes** | Read-side or reclaim-side work |

- Requirements a tag scheme must satisfy: the atomic must actually be lock-free; *every* reuse increments the tag; the tag cannot wrap while any old observation survives; the tag never keeps storage alive.
- ABA and use-after-free are different bugs — a tag can fix ABA while the program still crashes on the dereference that *reads* `next`.
- Preventing reuse while a reader is exposed solves both problems at once, which is why hazard/epoch schemes usually replace tagging.

**Interview line** — "A generation tag proves the representation changed; it does not prove the storage is still alive, so it is not a reclamation scheme."

**Traps** — assuming 16-byte atomics are lock-free everywhere · bumping the tag on push but not on pool reuse · a 16-bit tag on a hot free list (wraps in microseconds) · `reinterpret_cast` pointer packing.

---

## 31.7 Hazard pointers, epoch reclamation, and read-copy-update concepts

```text
--- hazard-pointer protect loop (the canonical shape) -------------------
repeat:
    p = source.load(acquire)
    if (p == nullptr) return nullptr
    my_hazard.store(p, seq_cst)          // announce BEFORE dereferencing
until p == source.load(acquire)          // REVALIDATE: still reachable?
// p is now protected: no remover may reclaim while a hazard slot holds p
use(p)
my_hazard.store(nullptr, release)        // release protection promptly
```

```cpp
// ---- hazard record + protect helper ----------------------------------
struct HazardSlot { std::atomic<void*> ptr{nullptr}; std::atomic<bool> in_use{false}; };
inline HazardSlot g_hazards[kMaxThreads];

template<class T>
T* protect(std::atomic<T*>& source, HazardSlot& mine) noexcept {
    T* p = source.load(std::memory_order_acquire);
    while (p) {
        mine.ptr.store(p, std::memory_order_seq_cst);   // seq_cst: pairs with the
        T* again = source.load(std::memory_order_acquire); // scanner's seq_cst read
        if (again == p) break;                           // protection is visible
        p = again;                                       // changed → retry
    }
    return p;
}

// ---- remover side ----------------------------------------------------
thread_local std::vector<Node*> t_retired;
void retire(Node* n) {
    t_retired.push_back(n);
    if (t_retired.size() < kBatch) return;               // amortize the scan
    std::vector<void*> protected_now;
    for (auto& h : g_hazards)                            // O(H)
        if (void* p = h.ptr.load(std::memory_order_seq_cst)) protected_now.push_back(p);
    std::ranges::sort(protected_now);                    // O(H log H)
    std::erase_if(t_retired, [&](Node* r) {              // O(R log H)
        if (std::ranges::binary_search(protected_now, r)) return false; // keep
        delete r;                                        // safe: no hazard names it
        return true;
    });
}
```

| Hazard pointers: benefit | Cost / constraint |
|---|---|
| Protects individual nodes precisely | Every protect writes a shared cache line |
| Reclaims despite an unrelated stalled thread | Retire scan is O(H + R log H) unless indexed |
| Bounded memory: retire backlog ≤ threads × hazards + batch | Fixed slot count bounds simultaneously protected nodes |
| No per-node reference count | Thread registration/deregistration and shutdown must be designed |

```text
--- epoch-based reclamation (EBR) ---------------------------------------
reader : announce active(global_epoch) → traverse → announce quiescent
writer : unlink → retire(node, current_epoch) into limbo[epoch % 3]
gc     : if every active reader is at global_epoch, ++global_epoch
         reclaim limbo[(epoch - 2) % 3]     // two full epochs of grace
```

```cpp
// ---- EBR guard: protection is SCOPED, pointers must not escape -------
class EpochGuard {
    ThreadRec& rec_;
public:
    explicit EpochGuard(ThreadRec& r) : rec_(r) {
        rec_.local_epoch.store(g_epoch.load(std::memory_order_acquire) | kActive,
                               std::memory_order_seq_cst);   // announce entry
    }
    ~EpochGuard() { rec_.local_epoch.store(kQuiescent, std::memory_order_release); }
    EpochGuard(EpochGuard const&) = delete;
};
{
    EpochGuard g{my_rec()};
    Node* n = head_.load(std::memory_order_acquire);  // safe INSIDE the scope only
    use(n->value);
}   // returning n past this brace is a use-after-free waiting to happen
```

```text
--- RCU-style copy / publish / grace ------------------------------------
reader : acquire-load current pointer → read IMMUTABLE state → exit section
writer : build a full copy → release-store new pointer
       → synchronize_rcu() / defer → destroy the old version
```

```cpp
// ---- RCU-shaped publication with an owning atomic (portable C++20) ----
std::atomic<std::shared_ptr<Config const>> cfg_;         // C++20
void update(Config c) {
    cfg_.store(std::make_shared<Config const>(std::move(c)),
               std::memory_order_release);               // publish new version
}                                                        // old dies at last release
std::shared_ptr<Config const> read() {
    return cfg_.load(std::memory_order_acquire);         // grace = refcount
}
```

| Scheme | Read-side work | Reclaim delay | Main failure mode |
|---|---|---|---|
| Never reclaim until shutdown | none | whole run | Unbounded retained memory |
| Fixed pool, no reuse while active | index/state check | design-specific | Capacity exhaustion |
| Hazard pointers | publish + revalidate per node | until hazards clear and a scan runs | Slot exhaustion, scan cost |
| Epoch / QSBR | announce active/quiescent | until all old readers quiesce | One stalled reader blocks everything |
| RCU-style copy/publish | acquire-load only | one grace period | Copy cost, retained versions, writer serialization |
| Reference ownership | atomic refcount RMW | until the last owner releases | Contention, cycles, last-release latency |

- **Nothing in ISO C++23** provides hazard pointers or RCU; `std::hazard_pointer` / `std::rcu_domain` are Concurrency TS 2 / C++26 material — name the library you would use (folly, libcds, liburcu).
- The hazard store must be `seq_cst` (or a fence-proved equivalent) because it must be visible to a scanner *before* the revalidating load; a relaxed store is not made safe by a later acquire.
- Epoch protection covers only the announced critical section — returning a raw pointer past the guard is unsafe.
- Advancing an epoch is not `++g_epoch`: it requires observing every registered participant's state with correct ordering.
- "RCU" is never permission to race on ordinary fields; the published version must be immutable to those readers.

**Interview line** — "Hazard pointers bound memory but pay per-node on the read side; epochs are nearly free to read but let one stalled reader pin an unbounded retire backlog."

**Traps** — storing the hazard without revalidating · forgetting to clear the hazard on an early return (use RAII) · a thread that exits without deregistering its epoch record (blocks reclamation forever) · using two epochs of limbo instead of three · dereferencing an epoch-protected pointer after the guard's scope.

---

## 31.8 Reference counting costs and memory ordering

```cpp
#include <atomic>
#include <memory>

// ---- C++20: the only portable, race-free atomic owning handle --------
std::atomic<std::shared_ptr<Book>> book_;              // C++20 partial spec
auto snap = book_.load(std::memory_order_acquire);     // atomically bumps refcount
book_.store(std::make_shared<Book>(next), std::memory_order_release);
auto prev = book_.exchange(fresh, std::memory_order_acq_rel);
book_.compare_exchange_strong(expected, desired,
        std::memory_order_acq_rel, std::memory_order_acquire);
book_.wait(snap, std::memory_order_acquire);           // C++20 wait/notify
book_.notify_all();
// std::atomic_load(&sp) free functions on shared_ptr: DEPRECATED in C++20.

// ---- THE RACE that refcounting does NOT solve on its own -------------
std::atomic<Book*> raw_;
Book* p = raw_.load(std::memory_order_acquire);
// <-- another thread may drop the last reference and destroy *p HERE -->
p->add_ref();                                          // *** use-after-free ***
```

```cpp
// ---- intrusive refcount: the canonical order pattern -----------------
struct RefCounted {
    mutable std::atomic<std::uint32_t> rc{1};

    void add_ref() const noexcept {
        rc.fetch_add(1, std::memory_order_relaxed);    // relaxed: caller ALREADY
    }                                                  // holds a live reference

    void release() const noexcept {
        if (rc.fetch_sub(1, std::memory_order_release) == 1) {  // release: my writes
            std::atomic_thread_fence(std::memory_order_acquire); // see everyone's
            delete this;                               // destructor runs here
        }
    }
};
// Why release-then-acquire-fence: the decrementing threads' prior writes must
// happen-before the destructor; only the thread that observes 1 needs acquire.
```

| Cost | Detail |
|---|---|
| Control-block contention | Every copy/destroy is an RMW on one shared line; readers serialize |
| Footprint | `shared_ptr` is 2 pointers; a separate control block unless `make_shared` |
| `weak_ptr` | Requires a second count and keeps the control block alive after destruction |
| Last-release destruction | Runs on whichever thread hits zero — unbounded, unpredictable latency in a hot loop |
| Cycles | Leak unless one edge is `weak_ptr` |
| `atomic<shared_ptr<T>>` | `is_lock_free()` is usually **false** — typically a spinlock in the implementation |

```cpp
// ---- deferring destruction off the hot path --------------------------
if (auto dead = book_.exchange(nullptr, std::memory_order_acq_rel))
    gc_queue_.push(std::move(dead));   // reclaimer thread runs ~Book, not the hot path
```

- Increment may be `relaxed` **only** because an already-owned live reference proves existence; the increment on a *newly discovered* pointer may not.
- Decrement needs `release` so prior writes are ordered before destruction; the zero-observer needs an `acquire` fence (or a `acq_rel` RMW) before running `~T`.
- Copying an isolated memory-order recipe out of context is unsafe — the whole fence scheme must be proved together.
- Prefer `make_shared` for one allocation, but note it keeps the object storage alive as long as any `weak_ptr` exists.

**Interview line** — "Reference counting makes lifetime correct by construction but pays with shared-line contention on every reader and a destructor that fires on an arbitrary thread."

**Traps** — `shared_ptr` copies in a hot read path · `atomic<shared_ptr<T>>` assumed lock-free · loading a raw pointer then calling `add_ref` · relaxed decrement · `enable_shared_from_this` before the first `shared_ptr` exists.

---

## 31.9 Backoff, spinning, yielding, blocking, and overload policy

```cpp
#include <thread>
#include <atomic>
#include <chrono>

// ---- escalating backoff ladder ---------------------------------------
inline void cpu_relax() noexcept {
#if defined(__x86_64__) || defined(_M_X64)
    __builtin_ia32_pause();                 // PAUSE — non-portable, no C++ standard form
#elif defined(__aarch64__)
    asm volatile("isb" ::: "memory");       // or YIELD
#else
    std::this_thread::yield();
#endif
}

void spin_until_pushed(Ring& r, Tick t) {
    for (unsigned misses = 0; !r.try_push(t); ++misses) {
        if (misses < 64)            cpu_relax();                     // stay hot
        else if (misses < 1024)     std::this_thread::yield();       // hint only
        else                        std::this_thread::sleep_for(std::chrono::microseconds{50});
    }
}

// ---- C++20 atomic wait/notify: park without a condition_variable -----
std::atomic<bool> ready_{false};
void consumer() {
    ready_.wait(false, std::memory_order_acquire);   // blocks while value == false
    consume();
}
void producer() {
    ready_.store(true, std::memory_order_release);
    ready_.notify_one();                             // or notify_all()
}
// wait() may return spuriously; it is a "wait while equal to old" loop internally.
```

| Strategy | Good when | Risk |
|---|---|---|
| Tight spin | Ownership expected in <1 µs; dedicated/isolated core | Burns power and SMT sibling throughput |
| Pause / exponential backoff | Short contention with SMT and cache pressure | Platform-specific tuning; no portable intrinsic |
| `yield()` | A runnable peer should make progress | Behavior fully unspecified; may be a no-op |
| `sleep_for` | Delay is genuinely long | Coarse (≥ tens of µs), jittery wakeup |
| `atomic::wait` / futex | Delay may be unbounded | Wakeup tail latency; needs a notify protocol |
| Fail fast / backpressure | Caller can retry or shed coherently | Pushes overload into the API contract |

- Backoff changes performance and progress behavior only — it can never affect linearizability.
- An unbounded `while (!try_push())` spin turns a bounded structure into an unbounded stall and voids the wait-free claim.
- A CAS retry loop under contention repeatedly invalidates one cache line; throughput can *fall* as threads are added.
- Always benchmark at saturation and report tail percentiles; low-contention throughput hides the failure mode.

**Traps** — `yield()` assumed to be a real sleep · spinning on a shared line without a relaxed load first (`test-and-test-and-set`) · notify without a store (lost wakeup) · missing `notify` after the final store on shutdown.

```cpp
// ---- test-and-test-and-set: don't RMW a contended line in the loop ---
while (flag_.exchange(true, std::memory_order_acquire))       // BAD alone
    while (flag_.load(std::memory_order_relaxed)) cpu_relax(); // GOOD inner spin
```

---

## 31.10 Proving correctness before benchmarking throughput

```text
 1 Write the sequential specification and the invariant list (I1–I9 of 31.2).
 2 Enumerate every state transition and the linearization point of each,
   including failing operations.
 3 Enumerate the actual producer/consumer roles; reject accidental extra
   participants (drain thread, monitor thread, test harness).
 4 Draw every release → acquire reads-from edge; unpaired release is a bug.
 5 Audit lifetime from the FIRST possible pointer observation through retirement.
 6 Prove wraparound and tag bounds numerically, not by "uint64 never wraps".
 7 State the progress scope: does it include allocation, pooling, reclamation, retry?
 8 Only then measure — and measure at saturation with tail latency.
```

```bash
# ---- sanitizers: TSan is the single highest-value tool here ----------
g++ -std=c++23 -O1 -g -fsanitize=thread ring_test.cpp -o ring_tsan
./ring_tsan                                   # detects races, not order bugs
g++ -std=c++23 -O2 -g -fsanitize=address,undefined ring_test.cpp -o ring_asan
ASAN_OPTIONS=detect_stack_use_after_return=1 ./ring_asan
# TSan understands std::atomic; it does NOT understand hand-rolled asm or
# custom reclamation, and it cannot prove the absence of a rare interleaving.

# ---- exhaustive model checking of small litmus cases -----------------
herd7 -conf linux-kernel.cfg mp.litmus     # or `cppmem` for C++ MM questions
# CDSChecker / GenMC / relacy: bounded exploration of real C++ atomics
```

```cpp
// ---- the test that actually catches lost/duplicated values -----------
// Producer pushes strictly increasing ids; consumer asserts exactly-once.
std::vector<std::uint8_t> seen(kTotal, 0);
std::uint64_t last = 0, count = 0;
while (count < kTotal) {
    std::uint64_t v;
    if (!ring.try_pop(v)) { cpu_relax(); continue; }
    assert(!seen[v] && "duplicate delivery");
    seen[v] = 1;
    assert(v > last && "reordered delivery (FIFO violated)");  // SPSC only
    last = v; ++count;
}
// Throughput alone would pass even if 30% of values were dropped.
```

| Test | What it catches |
|---|---|
| Capacity 1 and 2 | Off-by-one in the full/empty distinction |
| Wrap boundary (`push`/`pop` around `N`, and around `UINT64_MAX` in a shrunk counter type) | Modular-arithmetic errors |
| Full/empty race (producer and consumer both at the boundary) | Missing acquire on the opposite index |
| Stop/drain state | Lost tail items, hung consumer, missing `notify` |
| Randomized delays inside the critical window (`sleep`, `sched_yield`) | Windows that never open naturally |
| Multiple architectures (x86 TSO **and** ARM/POWER) | Missing acquire/release that x86 hides for free |
| Model comparison against a `mutex`-protected reference | Linearizability violations |

- x86's TSO silently forgives most missing `acquire`/`release`; a design must be tested on a weakly ordered machine or verified by model checking.
- TSan proves the absence of *observed* races in the schedules it ran, never the absence of races.
- Track unique sequence IDs and assert exactly-once, ordering, capacity, and lifetime — not ops/sec.

**Interview line** — "Before I benchmark I want the sequential spec, the linearization points, every release/acquire edge, the lifetime audit, the wraparound bound, and the exact scope of the progress claim."

```text
--- recall card ---------------------------------------------------------
linearizable   each operation appears atomic between call and return
obstruction    completes when it eventually runs alone
lock-free      some operation always makes system progress
wait-free      every operation completes in bounded own steps

SPSC           one writer per index/slot phase; does NOT generalize
publish slot   construct payload → release-store index/sequence
consume slot   acquire publication → read/destroy → release-store return
bounded queue  capacity and the full policy ARE correctness
ABA            an equal representation can hide a changed history
unlink         removes reachability; does not prove safe destruction
hazard         publish candidate → revalidate → dereference → clear
epoch          reclaim only after every old reader becomes quiescent
RCU-style      copy → publish immutable version → grace period → reclaim
refcount       correct lifetime, paid in contention and last-release latency
```

**Core design sentence** — a correct lock-free structure is not "some atomics around a container"; it is a linearizable state machine with explicit per-phase ownership, a proved progress scope, and a reclamation protocol that prevents every possible dereference from overlapping destruction or reuse.
