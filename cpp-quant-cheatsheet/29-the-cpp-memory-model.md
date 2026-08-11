# 29. The C++ memory model

*Part V — Concurrency and the memory model*

---

**Recall**
- The standard defines an abstract machine; compilers and CPUs may transform anything provided every *defined* program keeps an allowed observable behavior.
- A **memory location** is one scalar object or one maximal sequence of adjacent non-zero-width bit-fields.
- Two evaluations **conflict** if they access overlapping storage and at least one is a write or a lifetime transition (construction/destruction).
- A **data race** is: conflicting actions, potentially concurrent, in different threads, at least one non-atomic, with neither happens-before the other — and it is undefined behavior, not "a wrong value".
- **Sequenced-before** is within-thread ordering only; it grants nothing across threads.
- **Synchronizes-with** edges come only from operations the standard names (release/acquire pair, mutex unlock/lock, `join`, future/promise, `latch`/`barrier`, thread start).
- **Happens-before** = sequenced-before ∪ inter-thread synchronization, closed transitively.
- Each atomic object has one total **modification order**; there is no inherent order *across* different atomic objects (except the single total order over all `seq_cst` operations).
- Acquire does **not** force a load to observe the newest store — it only supplies ordering *if* the load reads from the relevant release or its release sequence.
- Release publishes everything sequenced before it; it does not transfer ownership or extend lifetime.
- A **release sequence** is the release head plus a contiguous run of RMWs in the modification order; since C++20 a plain store by another thread breaks it.
- `memory_order_consume` is unimplemented as specified — write `memory_order_acquire`; `std::kill_dependency` is deprecated in C++26.
- `volatile` is neither atomic nor synchronizing; "aligned word writes are atomic" is a hardware fact, not a C++ guarantee.
- Non-atomic accesses to *distinct* struct members are race-free but may false-share; false sharing is a latency bug, not UB.
- Adjacent non-zero-width bit-fields share a memory location, so concurrent non-atomic writes to them race; a `: 0` bit-field splits the location.
- Data-race freedom does **not** imply sequential consistency; relaxed/acq-rel programs admit outcomes no single interleaving explains.
- The model guarantees no fairness, no progress, no bounded visibility delay, no cache-line size, and no lock-freedom for a given type.
- Atomic reachability is not lifetime: reclamation needs a separate proof (hazard pointers, epochs, refcounts, quiescence).
- Interview proof order: name the conflicting evaluations → exhibit a happens-before path or atomicity for each → prove lifetime → only then discuss fences and cache cost.

---

## 29.1 Abstract machine, threads of execution, and evaluations

```cpp
#include <thread>
#include <atomic>

// A "thread of execution" starts at:
int main();                                  // the initial thread
std::thread  t1{[]{ /* body */ }};           // new thread; ctor synchronizes with body start
std::jthread t2{[](std::stop_token st){}};   // C++20: joins in dtor, passes stop_token
// ... plus implementation-defined entries (signal handlers, runtime callbacks).

// An "evaluation" = value computation + initiation of the side effect.
// The abstract machine orders evaluations; it does NOT order machine instructions.
```

```cpp
// ---- sequencing vocabulary, all three forms --------------------------------
int i = 0;
int x = 0, y = 0;

x = 1;                 // sequenced-before the next full-expression
y = 2;                 // ...but this says nothing about any other thread

// int bad = i++ + i++;      // UB: unsequenced modifications of one scalar
// int bad2 = i + i++;       // UB: unsequenced read and modification
int ok  = (i = 1, i + 1);    // comma operator: left sequenced-before right
int ok2 = i++ + (i = 3);     // still UB — '+' operands are unsequenced

f(i++, i++);           // C++17: arguments INDETERMINATELY sequenced — no overlap,
                       // order unspecified; well-defined, but unspecified result
a[i] = i++;            // C++17: RHS of '=' sequenced-before LHS → defined
std::cout << i++ << i++;   // C++17: operator<< chain is left-to-right sequenced
```

| Relation | Meaning | Example |
|---|---|---|
| `A` sequenced-before `B` | asymmetric within-thread order | `;` between statements, `,`, `&&`, `\|\|`, `?:` |
| Indeterminately sequenced | `A` before `B` **or** `B` before `A`, never overlapping | function arguments (C++17) |
| Unsequenced | may interleave; conflicting side effects are UB | operands of `+`, `*`, `<<` (non-stream) |
| Happens-before | sequenced-before + inter-thread edges, transitive | cross-thread proof unit |

```cpp
// ---- what the abstract machine permits an implementation to do -------------
int g;
void sink(int);
void demo() {
    g = 1;            // may be eliminated, merged, sunk, or hoisted
    g = 2;            // only the observable behavior of a DEFINED program is fixed
}
// Legal transformations include: reordering non-conflicting accesses, keeping a
// value in a register across a loop, introducing speculative reads to
// non-volatile objects that are already read on some path, and removing
// entire code paths that would be UB.
```

**Traps** — "the compiler emitted the stores in order" is not a guarantee · signal handlers see a restricted subset (only `atomic` lock-free ops and `volatile sig_atomic_t` are safe) · `std::thread` ctor already gives you a synchronizes-with edge, so args copied before launch are visible · a destroyed `std::thread` that was never joined calls `std::terminate` (use `jthread`).

---

## 29.2 Conflicting actions, data races, and happens-before

```cpp
// ---- the canonical race ----------------------------------------------------
int  payload = 0;
bool ready   = false;

void producer() {
    payload = 42;
    ready   = true;        // non-atomic write
}
void consumer() {
    while (!ready) {}      // non-atomic read: DATA RACE with producer -> UB
    consume(payload);      // second race, and no ordering even if it "worked"
}
// A real compiler may hoist `ready` into a register and emit an infinite loop.
```

Conflicting evaluations are exactly:

| Pair | Conflict? |
|---|---|
| write vs. read of overlapping storage | yes |
| write vs. write of overlapping storage | yes |
| read vs. read | **no** |
| lifetime start/end vs. any access to overlapping storage | yes |
| two overlapping lifetime transitions | yes |
| accesses to disjoint memory locations | no (may still false-share) |

```cpp
// ---- four race-free designs ------------------------------------------------
// 1. Confinement: one thread owns the object; transfer by move + publication.
// 2. Mutex: every access participating in the invariant is under the SAME mutex.
#include <mutex>
std::mutex m;
int shared = 0;
void guarded() { std::lock_guard lk{m}; shared += 1; }   // CTAD, C++17

// 3. Atomics with an ordering protocol.
std::atomic<int> counter{0};
void bumped() { counter.fetch_add(1, std::memory_order_relaxed); }

// 4. Immutability: fully build, publish once, never mutate again.
```

```cpp
// ---- atomicity alone is NOT ordering ---------------------------------------
int payload2 = 0;
std::atomic<bool> flag{false};
void bad_publish() {
    payload2 = 42;
    flag.store(true, std::memory_order_relaxed);   // no release: payload2 unordered
}
void bad_consume() {
    if (flag.load(std::memory_order_relaxed))
        use(payload2);      // DATA RACE: no happens-before edge to the write
}
```

**Interview line** — "A data race is potentially concurrent conflicting actions in different threads, at least one non-atomic, unordered by happens-before; the whole program is then undefined, so no observed value is meaningful."

**Traps** — "it works in release builds" is UB-compatible · sleeping, a debugger breakpoint, or printf does not create happens-before · one aligned machine word does not make a C++ access atomic · `volatile` does not fix any of this · racing on a `bool` is exactly as undefined as racing on a `std::string`.

---

## 29.3 Sequenced-before, synchronizes-with, and inter-thread happens-before

```cpp
#include <atomic>

int payload;                        // ordinary, non-atomic
std::atomic<bool> ready{false};

void publish() {
    payload = 42;                                    // A
    ready.store(true, std::memory_order_release);    // B   (A sequenced-before B)
}
void consume_when_ready() {
    if (ready.load(std::memory_order_acquire)) {     // C   (reads B's value)
        use(payload);                                // D   (C sequenced-before D)
    }
}
// B synchronizes-with C  =>  A happens-before D. The ordinary read of `payload`
// is race-free ON THE PATH WHERE C OBSERVED TRUE. Nothing is promised otherwise.
```

> The per-order API surface (`relaxed`/`acquire`/`release`/`acq_rel`/`seq_cst` on each
> operation, CAS success-vs-failure order rules) is enumerated in
> [§30.4](/iprep/books/cpp-cheatsheet/30-atomics-and-ordering/) and [§30.2](/iprep/books/cpp-cheatsheet/30-atomics-and-ordering/); the fence
> spellings and the fence-fence / fence-atomic / atomic-fence pairings are in
> [§30.5](/iprep/books/cpp-cheatsheet/30-atomics-and-ordering/). This chapter stays on the *model* that makes them mean
> something: which edges exist, and what composes them.

| Synchronizes-with source | Destination |
|---|---|
| Release store / RMW on atomic `M` | acquire load on `M` reading that value or its release sequence |
| `mutex::unlock()` | next successful `lock()` / `try_lock()` on the same mutex |
| `std::thread` / `jthread` constructor | start of the new thread's callable |
| End of a thread's execution | successful return from `join()` |
| `promise::set_value` (state made ready) | `future::get()` / `wait()` observing readiness |
| `std::latch::count_down` | `latch::wait()` returning |
| `std::barrier::arrive` | completion of the phase / `wait()` return |
| `std::counting_semaphore::release` | successful `acquire()` |
| `notify_one/all` + predicate + mutex on a `condition_variable` | waiter reacquiring the mutex |
| `std::atomic<T>::notify_one/all` (C++20) | returning `wait()` |
| `call_once` completing the callable | all other `call_once` calls on the same `once_flag` |
| Completion of a static local's initialization | other threads' entry past that declaration |

**Traps** — happens-before is **not** transitive through a *load that read a different store* · a relaxed load can never be the destination of a synchronizes-with edge · a release store with no matching acquire publishes nothing · release/acquire pair must be on the *same* atomic object · a `try_lock` that *fails* creates no edge · the mutex edge exists only if both sides use the same mutex object.

---

## 29.4 Modification order and visible side effects

```cpp
std::atomic<int> seq{0};
// Every store and RMW to `seq` sits in ONE total order (its modification order).
// Different atomic objects have unrelated modification orders.
// Non-atomic objects have no modification order at all.
```

Four coherence rules for a single atomic object `M` (memorize; they hold even for `relaxed`):

| Rule | Statement |
|---|---|
| write-write | if write `W1` happens-before `W2`, then `W1` precedes `W2` in `M`'s modification order |
| read-read | if load `L1` happens-before `L2`, `L2` cannot read a value *earlier* in the order than `L1` did |
| read-write | a write happening-after a load must follow, in the order, the write that load observed |
| write-read | a load happening-after a write reads that write or a later one in the order |

```cpp
// ---- coherence gives per-object monotonicity, not global snapshots ---------
std::atomic<int> x{0}, y{0};
// T0: x.store(1, relaxed); r1 = y.load(relaxed);
// T1: y.store(1, relaxed); r2 = x.load(relaxed);
// r1 == 0 && r2 == 0 is PERMITTED (store buffering). Two objects, two orders.

// Make it forbidden by joining one global total order:
// T0: x.store(1, std::memory_order_seq_cst); r1 = y.load(std::memory_order_seq_cst);
// T1: y.store(1, std::memory_order_seq_cst); r2 = x.load(std::memory_order_seq_cst);
// Now r1 == 0 && r2 == 0 is impossible: seq_cst ops share ONE total order S,
// consistent with happens-before and with each object's modification order.
```

```cpp
// ---- relaxed is still coherent: this loop must terminate -------------------
std::atomic<int> c{0};
void writer() { c.store(1, std::memory_order_relaxed); }
void reader() { while (c.load(std::memory_order_relaxed) == 0) {} }
// Not a race (both atomic) and implementations must make stores visible in
// finite time — but the standard offers no BOUND on that delay.

// ---- but relaxed publishes nothing ordinary --------------------------------
// Anything sequenced before the relaxed store may be observed after it.
```

For ordinary (non-atomic) reads in a race-free program, the **visible side effect** is the unique write that happens-before the read with no intervening write also happening-before it; if two candidate writes are unordered, the program was already racy and the question is void.

**Traps** — "all my fields are atomic so the struct is consistent" — individual atomicity is not a transaction · a `seq_cst` op mixed with weaker ops on the same object still only totally orders the `seq_cst` ones · `atomic<T>` for large `T` may be lock-based (`is_lock_free()` / `is_always_lock_free`) · `atomic<double>` has no `fetch_add` before C++20 · `atomic_ref<T>` (C++20) imposes the model on an existing object *only while every access goes through refs*.

---

## 29.5 Release sequences and dependency ordering

```cpp
// ---- release sequence: head release + contiguous RMWs -----------------------
std::atomic<int> count{0};
int payload;

// Thread A
payload = 7;
count.store(1, std::memory_order_release);        // HEAD of the release sequence

// Thread B
count.fetch_add(1, std::memory_order_relaxed);    // RMW: stays IN the sequence
                                                  // (relaxed RMW is fine here)

// Thread C
if (count.load(std::memory_order_acquire) == 2)
    use(payload);       // synchronizes with A's HEAD release -> payload visible
```

```cpp
// ---- what breaks the sequence (C++20 rule) ----------------------------------
count.store(5, std::memory_order_relaxed);  // plain STORE by another thread:
                                            // sequence ends here; later acquires
                                            // no longer sync with the head.
// Pre-C++20 the head thread's own plain stores stayed in the sequence; C++20
// simplified this to "release head + RMWs only".
```

The classic application is refcount release — `fetch_sub(release)` on every dropper plus a
single `atomic_thread_fence(acquire)` on the last one. The chain of relaxed/release RMWs is
exactly the release sequence above, which is why the destructor sees every other thread's
writes; the code is in [§30.4](/iprep/books/cpp-cheatsheet/30-atomics-and-ordering/).

```cpp
// ---- consume: specified, unusable, avoid ------------------------------------
std::atomic<Node*> head{nullptr};
Node* p = head.load(std::memory_order_consume);   // dependency-ordered-before
if (p) use(p->value);                             // only DEPENDENT reads ordered
// Every mainstream implementation promotes consume to acquire. Write:
Node* q = head.load(std::memory_order_acquire);   // portable and correct
if (q) use(q->value);
// std::kill_dependency(e)  // deprecated in C++26; never a synchronization tool
// [[carries_dependency]]   // attribute, likewise ignored in practice
```

| Concept | Reliable form in C++23 |
|---|---|
| Publish a pointer + its pointee's init | release store / acquire load |
| Cheap chain of decrements | `fetch_sub(release)` + one `atomic_thread_fence(acquire)` |
| Dependency ordering | use acquire; do not hand-roll with pointer arithmetic |

**Traps** — the acquire must read a value produced *within* the sequence, not merely a later unrelated value · an intervening non-RMW store from any thread cuts the chain · a relaxed RMW carries the sequence but itself synchronizes with nothing · `compare_exchange_weak` that *fails* performs only a load, so it does not extend a release sequence.

---

## 29.6 Memory locations, bit-fields, and adjacent data

```cpp
// ---- distinct scalar members = distinct memory locations --------------------
struct Counters { int bid; int ask; };
Counters c{};
// Thread 1: c.bid = 1;   Thread 2: c.ask = 2;    // NO data race.
// Writing the whole object (c = Counters{...}) touches both locations -> race.
```

```cpp
// ---- bit-fields: adjacent non-zero-width ones share ONE location ------------
struct Flags {
    unsigned bid : 1;      // \
    unsigned ask : 1;      // /  same memory location -> concurrent writes RACE
};

struct SplitFlags {
    unsigned bid : 1;
    unsigned     : 0;      // zero-width: forces a new allocation unit
    unsigned ask : 1;      // now a separate memory location
};
```

```cpp
// ---- false sharing: legal but slow ------------------------------------------
#include <new>
struct alignas(std::hardware_destructive_interference_size) Padded {  // C++17
    std::atomic<long> value{0};
};
Padded producer_seq, consumer_seq;   // guaranteed on distinct cache lines
// std::hardware_constructive_interference_size: max size to keep TOGETHER.
// Both are implementation-defined constants; some libstdc++ builds warn on ABI.

// Manual fallback when the constants are unavailable:
struct alignas(64) PaddedManual { std::atomic<long> v{0}; char pad[64 - sizeof(std::atomic<long>)]; };
```

| Storage shape | One memory location? | Concurrent non-atomic writes |
|---|---|---|
| `int a; int b;` in a struct | no — two | race-free |
| `unsigned a:1; unsigned b:1;` adjacent | **yes — one** | data race |
| separated by `unsigned :0;` | no — two | race-free |
| `std::vector<bool>` elements | share a word | data race |
| `char` array elements `buf[0]`, `buf[1]` | distinct locations | race-free |
| distinct elements of `std::array<T,N>` | distinct | race-free |
| same element via two references | same | race |

```cpp
// ---- lifetime transitions conflict with accesses ----------------------------
alignas(Node) std::byte storage[sizeof(Node)];
Node* n = std::construct_at(reinterpret_cast<Node*>(storage));  // C++20: lifetime BEGINS
std::destroy_at(n);                                             // lifetime ENDS
// Either transition conflicts with ANY concurrent access to that storage,
// even a read, even if all data members were atomic.
```

**Traps** — a whole-object assignment or a memcpy touches every member's location · `vector<bool>` bit writes to different indices are a genuine data race · packed structs can merge what looked like separate locations · the compiler may not invent a write to an object the abstract machine would not write, so "read-modify-write widening" of a neighbouring field is forbidden — but bit-fields are exempt because they legitimately share the location.

---

## 29.7 Compiler versus CPU reordering

Three layers that must never be conflated:

| Layer | Question it answers |
|---|---|
| C++ abstract machine | Is the program defined, and which results are permitted? |
| Compiler mapping | Which instructions/fences implement those semantics on this target? |
| Hardware memory model | How do cores make stores visible, and which instructions order them? |

```cpp
// ---- same source, different code, identical language guarantee --------------
std::atomic<int> a{0};
int x = a.load(std::memory_order_acquire);
// x86-64 (TSO): plain `mov` — acquire is free on loads.
// AArch64:      `ldar`, or `ldapr` where available.
// POWER:        `lwz` + `lwsync`/isync-branch idiom.
a.store(1, std::memory_order_release);
// x86-64: plain `mov`.        AArch64: `stlr`.
a.store(1, std::memory_order_seq_cst);
// x86-64: `xchg` or `mov`+`mfence` — the ONLY order that costs on x86 stores.
```

| Mechanism | What it orders |
|---|---|
| `asm volatile("" ::: "memory")` | compiler only; emits no instruction; no cross-core guarantee |
| `std::atomic_signal_fence` | compiler only; portable spelling of the above |
| `std::atomic_thread_fence` | compiler **and** hardware, per the requested order |
| CPU fence instruction (`mfence`, `dmb ish`) | hardware only; the compiler may still reorder around inline asm |
| `volatile` load/store | forbids compiler elision/duplication/reordering *with other volatiles*; no atomicity, no cross-thread ordering |

```cpp
// ---- "the CPU doesn't reorder x86 stores, so I'm safe" is wrong -------------
bool ready = false;                     // NON-atomic
void spin() { while (!ready) {} }       // compiler may hoist the load:
                                        //   if (!ready) for(;;);
// The compiler, not the CPU, broke it. UB also lets the compiler delete
// null checks, unroll into unreachable code, and assume loops terminate.
```

**Interview line** — "Compiler reordering and CPU reordering are two different layers; the C++ memory model constrains the *composition* of both, so an absent fence instruction never proves an acquire was ignored, and a strong CPU never repairs a data race."

**Traps** — seeing no `mfence` on x86 does not mean the acquire was dropped · benchmarking one target teaches you nothing about ARM/POWER visibility · `volatile` on a shared flag compiles to "the right instruction" on x86 and is still UB by the language · `-O0` hides races that `-O2` exposes.

---

## 29.8 Out-of-thin-air prohibition and memory-model limits

```cpp
// ---- the OOTA shape the model forbids ---------------------------------------
std::atomic<int> x{0}, y{0};
// T0: r1 = x.load(relaxed);  y.store(r1, relaxed);
// T1: r2 = y.load(relaxed);  x.store(r2, relaxed);
// r1 == r2 == 42 would be self-justifying: no store of 42 exists except one
// justified by the read of 42. Forbidden in intent; the formal rule is a
// prohibition on such causal cycles, and remains imperfectly formalized.
```

Interview-safe reasoning:

- An atomic load reads a value written by *some* store to that object (or its initialization) that is permitted by the modification order and the memory orders involved.
- Never justify a read by a cycle of speculative reads and writes.
- Race-free does **not** imply sequentially consistent — only *`seq_cst`-only, race-free* programs get "as if one interleaving".
- Relaxed executions can be deeply counterintuitive and still never invent values.

The memory model does **not** guarantee:

| Not guaranteed | Consequence |
|---|---|
| thread scheduling, fairness, preemption | a spin loop can starve; use `yield`/`wait` |
| a bound on store visibility delay | "eventually" only; no latency number |
| forward progress of another thread | lock-free ≠ wait-free; no deadlock detection |
| cache-line size, coherence protocol, instruction selection | tune per target, prove per standard |
| lock-freedom of any `std::atomic<T>` | check `is_always_lock_free` |
| one globally newest view across unrelated atomics | no cross-object snapshot without `seq_cst` or a lock |
| anything after lifetime ends | reclamation is a separate proof obligation |

```cpp
static_assert(std::atomic<int>::is_always_lock_free);       // compile-time, C++17
static_assert(std::atomic<std::uint64_t>::is_always_lock_free);
struct Big { long a, b, c; };
// std::atomic<Big> would typically be mutex-backed: is_lock_free() == false.
std::atomic<Big> big{};
bool lf = big.is_lock_free();      // runtime query
// ATOMIC_INT_LOCK_FREE etc. are the C-style macros: 0 never, 1 sometimes, 2 always.
```

```cpp
// ---- spin politely; the model promises no fairness ---------------------------
#include <thread>
while (!flag.load(std::memory_order_acquire)) {
    std::this_thread::yield();          // or __builtin_ia32_pause() / __yield()
}
flag.wait(false, std::memory_order_acquire);   // C++20: blocking, no spin at all
flag.notify_one();                             // C++20 wake
```

**Traps** — "lock-free" means no lock, not fast and not wait-free · a `seq_cst` sprinkle does not linearize a multi-word update · `is_lock_free()` may differ per object due to alignment · assuming a relaxed loop terminates "quickly" is a latency assumption, not a correctness one.

---

## 29.9 Publication, ownership transfer, and reclamation

```cpp
// ---- publish once, then immutable -------------------------------------------
struct Snapshot { long bid; long ask; };

Snapshot snapshot;                       // ordinary object
std::atomic<bool> published{false};

void writer() {
    snapshot = Snapshot{100, 102};                      // A
    published.store(true, std::memory_order_release);   // B
}
void reader() {
    if (published.load(std::memory_order_acquire)) {    // C
        Snapshot copy = snapshot;                       // D — ordered after A
        consume(copy);
    }
}
// Correct ONLY while the writer never mutates `snapshot` again. Publication
// orders initialization; it does not grant exclusivity.
```

```cpp
// ---- pointer publication (ordering, not lifetime) ---------------------------
std::atomic<Node*> root{nullptr};

void install(Node* fully_initialized) {
    root.store(fully_initialized, std::memory_order_release);
}
Node* observe() {
    return root.load(std::memory_order_acquire);   // pointee's init is visible
}
// Unlinking from `root` does NOT prove no reader still holds the pointer.
// `delete p;` here is a lifetime-vs-access conflict = data race = UB.
```

```cpp
// ---- immutable snapshot with shared ownership (atomic<shared_ptr>, C++20) ---
#include <memory>
std::atomic<std::shared_ptr<const Snapshot>> current;   // C++20 specialization

void update() {
    auto next = std::make_shared<const Snapshot>(101L, 103L);
    current.store(std::move(next), std::memory_order_release);   // old freed when
}                                                                // last ref drops
void read_it() {
    auto snap = current.load(std::memory_order_acquire);  // owning copy: SAFE
    if (snap) consume(*snap);                             // lifetime held by refcount
}
// Also: current.exchange(p), current.compare_exchange_strong(exp, des),
//       current.wait(old), current.notify_one().
// Usually NOT lock-free; correctness first, then measure.
// The deprecated free functions std::atomic_load(&sp)/atomic_store(&sp, p)
// are removed in C++26 — use std::atomic<std::shared_ptr<T>>.
```

```cpp
// ---- ownership transfer checklist -------------------------------------------
// 1  producer has exclusive access while constructing
// 2  producer releases: publishes a value or token
// 3  consumer acquires: observes that publication
// 4  producer stops touching the transferred state entirely
// 5  consumer is now exclusive owner, or a documented sharing protocol applies
// 6  return/reclamation gets its OWN synchronization and lifetime proof
```

| Reclamation scheme | Mechanism | Cost / caveat |
|---|---|---|
| `shared_ptr` refcount | atomic RMW per copy | contention on the control block; cycles leak |
| `atomic<shared_ptr>` | as above + atomic slot | typically lock-based load |
| Hazard pointers | reader announces the pointer it is using | per-read store + fence; retire list scan |
| Epoch / RCU | readers pin an epoch; free after grace period | one lagging reader stalls all reclamation |
| Quiescent state | free only when all threads are known idle | needs a real quiescence point |
| Deferred / never | arena or pool never returns memory | trivially correct, bounded memory only |

**Traps** — a seqlock-style reader that does *ordinary* concurrent reads and then discards the copy has already executed a data race; validating afterwards cannot undo UB (use `atomic_ref` or `memcpy` of atomics) · "removed from the map, so it's safe to delete" ignores readers holding the raw pointer · a release store publishes construction, never destruction · `shared_ptr` refcounting is atomic but the *pointee* is not · ABA is a correctness bug orthogonal to ordering — a tagged pointer or `compare_exchange` on a versioned word is the fix.

**Interview line** — "Publication is release/acquire; reclamation is a separate proof — atomic reachability never implies lifetime."
