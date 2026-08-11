# 30. Atomics and ordering

*Part V — Concurrency and the memory model*

---

**Recall**
- An atomic operation is indivisible with respect to other atomic operations on the *same object*; it says nothing about lifetime, progress, or latency.
- Every atomic object has a **modification order** — a single total order of all writes to it — which even `relaxed` respects.
- `relaxed` gives atomicity + modification order only; it creates no *synchronizes-with* edge and publishes no other data.
- A `release` store *synchronizes with* an `acquire` load that reads that value (or a value from its release sequence), making everything sequenced before the store visible after the load.
- `acq_rel` is legal only on an RMW; `store` cannot be `acquire`/`consume`/`acq_rel`, `load` cannot be `release`/`acq_rel`.
- `seq_cst` adds one global total order over all `seq_cst` operations — it does *not* make a sequence of atomic operations indivisible.
- `memory_order_consume` is discouraged and implemented as `acquire` by every mainstream compiler; do not rely on dependency ordering.
- CAS failure performs a load only: the failure order cannot be `release`/`acq_rel` and (pre-C++17 rule, still good practice) must not be stronger than success.
- CAS **overwrites `expected`** on failure with the observed value — recompute `desired` inside the loop or the loop is a no-op.
- `compare_exchange_weak` may fail spuriously and is the loop form; `strong` never fails spuriously and is the single-shot form.
- Default `memory_order` on every member is `seq_cst`; that is the correctness baseline, weaken only with a written happens-before proof.
- `is_lock_free()` describes the primitive, not your algorithm; `is_always_lock_free` is a compile-time constant usable in `if constexpr`.
- `atomic<T>` is neither copy-constructible nor copy-assignable — load then store.
- `atomic_ref<T>` atomically accesses a *pre-existing* object: alignment `required_alignment`, object must outlive the ref, and all concurrent access must go through refs.
- `wait(old)` blocks until the value's *representation* differs from `old`; `notify_one/all` take no memory order and are not state.
- A fence needs an atomic read-from carrier to synchronize; a fence "next to" plain data proves nothing.
- `atomic_signal_fence` orders only w.r.t. signal handlers on the same thread — no inter-thread effect, no instruction emitted.
- ABA: CAS compares a representation, not history — tag, hazard-pointer, or epoch-protect anything you recycle.
- Weakening the order never removes cache-line contention; a hot atomic serializes its line regardless of `relaxed`.
- False sharing is fixed by layout (`alignas(hardware_destructive_interference_size)`), not by memory order.

---

## 30.1 `std::atomic<T>` requirements and specializations

```cpp
#include <atomic>
#include <cstdint>
#include <memory>
#include <type_traits>

// ---- type requirements for the primary template ------------------------
// T must be trivially copyable, copy-constructible, move-constructible,
// copy-assignable, move-assignable, and non-cv-qualified.
struct Top { std::int32_t bid; std::int32_t ask; };
static_assert(std::is_trivially_copyable_v<Top>);
static_assert(std::is_copy_constructible_v<Top>);

std::atomic<Top>   top{};             // legal; NOT necessarily lock-free
std::atomic<int>   n{0};              // integral specialization: arithmetic + bitwise
std::atomic<int*>  p{nullptr};        // pointer specialization: fetch_add/sub in elements
std::atomic<double> d{0.0};           // floating specialization (C++20): fetch_add/sub
std::atomic<bool>  b{false};          // no arithmetic
std::atomic<std::shared_ptr<Top>> sp; // C++20 specialization; refcount cost remains
std::atomic<std::weak_ptr<Top>>   wp; // C++20

// ---- construction / init ----------------------------------------------
std::atomic<int> a;                   // C++20: value-initialized (was indeterminate)
std::atomic<int> a2{7};               // initializing ctor — NOT atomic, no ordering
std::atomic<int> a3 = 7;              // same (converting ctor is not explicit)
// std::atomic<int> a4 = a3;          // ill-formed: copy ctor is DELETED
// a4 = a3;                           // ill-formed: copy assign is DELETED
int v0 = a3;                          // operator T()  == load(seq_cst)
a3 = 9;                               // operator=(T)  == store(seq_cst), returns T (not ref)

// ---- lock-freedom ------------------------------------------------------
bool           rt = top.is_lock_free();                       // runtime, per object
constexpr bool ct = std::atomic<Top>::is_always_lock_free;    // C++17, compile time
static_assert(std::atomic<std::uint64_t>::is_always_lock_free);
if constexpr (std::atomic<Top>::is_always_lock_free) { /* CAS path */ }

// ---- ABI/size probes ---------------------------------------------------
using V = std::atomic<int>::value_type;          // int
using D = std::atomic<int*>::difference_type;    // std::ptrdiff_t
using DI = std::atomic<int>::difference_type;    // int (integral specializations)
```

```cpp
// ---- C-compatibility macros / free functions (still valid C++23) -------
std::atomic<int> c1 = ATOMIC_VAR_INIT(1);      // deprecated C++20, removed-ish; avoid
std::atomic_flag f = ATOMIC_FLAG_INIT;         // still the portable flag initializer
// Every member has a free-function twin taking atomic<T>* (or volatile atomic<T>*):
std::atomic_store_explicit(&n, 5, std::memory_order_release);
int got = std::atomic_load_explicit(&n, std::memory_order_acquire);
bool lf = std::atomic_is_lock_free(&n);
// ATOMIC_INT_LOCK_FREE / ATOMIC_POINTER_LOCK_FREE == 0 never, 1 sometimes, 2 always
static_assert(ATOMIC_POINTER_LOCK_FREE == 2);
```

| Specialization | Extra operations |
|---|---|
| `atomic<Integral>` | `fetch_add/sub/and/or/xor`, `++ -- += -= &= \|= ^=`, `fetch_max/min` (C++26) |
| `atomic<Floating>` | `fetch_add/sub`, `+= -=` (C++20); FP environment may differ from thread's |
| `atomic<T*>` | `fetch_add/sub` in **element units**, `++ -- += -=` |
| `atomic<bool>` | load/store/exchange/CAS only |
| `atomic<shared_ptr<T>>` | `load/store/exchange/compare_exchange_*/wait/notify`; usually lock-free-*false* |
| `atomic<T>` (primary) | load/store/exchange/CAS/wait/notify only |

| Query | Kind | Meaning |
|---|---|---|
| `is_lock_free()` | runtime, `noexcept` | this object's operations avoid locks in this implementation |
| `is_always_lock_free` | `static constexpr bool` | true for **every** object of the type, on this implementation |
| `required_alignment` (on `atomic_ref`) | `static constexpr size_t` | ≥ `alignof(T)`; may be larger |
| `ATOMIC_*_LOCK_FREE` | macro | `0` never / `1` sometimes / `2` always |

**Traps** — the initializing constructor is not an atomic operation and orders nothing · `atomic<T>` is not copyable, so it cannot live in a `vector` that reallocates via copy · a lock-free-*false* `atomic<T>` may take a lock inside a signal handler → deadlock · `sizeof(atomic<T>)` may exceed `sizeof(T)` · `atomic<Big>` silently degrades to a mutex table on many implementations · trivially copyable does not mean *padding-free*, and padding wrecks CAS.

---

## 30.2 Atomic load, store, exchange, and compare-exchange

```cpp
std::atomic<std::uint64_t> seq{0};

// ---- load: every legal order ------------------------------------------
auto x1 = seq.load();                                   // seq_cst (default)
auto x2 = seq.load(std::memory_order_relaxed);          // atomicity + mod order only
auto x3 = seq.load(std::memory_order_consume);          // deprecated; == acquire in practice
auto x4 = seq.load(std::memory_order_acquire);          // later ops cannot move before
auto x5 = seq.load(std::memory_order_seq_cst);          // joins the total order
// seq.load(std::memory_order_release);                 // UB: precondition violated
// seq.load(std::memory_order_acq_rel);                 // UB
auto x6 = seq.operator std::uint64_t();                 // implicit conversion == load(seq_cst)

// ---- store: every legal order -----------------------------------------
seq.store(1);                                           // seq_cst
seq.store(1, std::memory_order_relaxed);
seq.store(1, std::memory_order_release);                // publishes prior writes
seq.store(1, std::memory_order_seq_cst);
// seq.store(1, std::memory_order_acquire);             // UB
// seq.store(1, std::memory_order_consume);             // UB
// seq.store(1, std::memory_order_acq_rel);             // UB
seq = 1;                                                // operator=(T) → store(seq_cst)

// ---- non-atomic composite: LOST UPDATE --------------------------------
auto cur = seq.load(std::memory_order_relaxed);
seq.store(cur + 1, std::memory_order_relaxed);          // BUG: two ops, not one RMW

// ---- exchange: unconditional RMW, returns the PREVIOUS value ----------
auto prev = seq.exchange(0);                            // seq_cst
prev = seq.exchange(0, std::memory_order_relaxed);
prev = seq.exchange(0, std::memory_order_acquire);      // legal on RMW
prev = seq.exchange(0, std::memory_order_release);
prev = seq.exchange(0, std::memory_order_acq_rel);      // consume + publish

// ---- arithmetic / bitwise RMW (integral specialization) ---------------
std::atomic<std::int64_t> k{0};
auto o1 = k.fetch_add(5, std::memory_order_relaxed);    // returns value BEFORE
auto o2 = k.fetch_sub(2, std::memory_order_acq_rel);
auto o3 = k.fetch_and(0xFF, std::memory_order_relaxed);
auto o4 = k.fetch_or(0x1,  std::memory_order_release);
auto o5 = k.fetch_xor(0x1, std::memory_order_acquire);
auto n1 = ++k;   auto n2 = k++;   // pre/post increment: ALWAYS seq_cst, return T (not T&)
auto n3 = --k;   auto n4 = k--;
k += 3; k -= 3; k &= ~0; k |= 0; k ^= 0;                // all seq_cst, return T

// ---- pointer arithmetic (element-scaled) ------------------------------
int buf[64];
std::atomic<int*> cursor{buf};
int* was = cursor.fetch_add(4, std::memory_order_relaxed);  // advances 4 *ints*
cursor -= 4;                                                // seq_cst
// atomic pointer arithmetic is defined as a computation; the RESULT may be an
// invalid address — dereferencing it is still UB.

// ---- floating (C++20) --------------------------------------------------
std::atomic<double> acc{0.0};
acc.fetch_add(1.5, std::memory_order_relaxed);          // no fetch_and/or/xor
```

```cpp
// ---- compare-exchange: all four overloads ------------------------------
std::atomic<int> state{0};
int expected = 0;

// (1) two-order strong
state.compare_exchange_strong(expected, 1,
                              std::memory_order_acq_rel,   // success
                              std::memory_order_acquire);  // failure (load only)
// (2) one-order strong: failure order DERIVED from success
state.compare_exchange_strong(expected, 1, std::memory_order_acq_rel);
//     acq_rel  → acquire   release → relaxed   seq_cst → seq_cst
// (3) default: both seq_cst
state.compare_exchange_strong(expected, 1);
// (4) weak variants: identical signatures, may fail spuriously
state.compare_exchange_weak(expected, 1, std::memory_order_release,
                                         std::memory_order_relaxed);
state.compare_exchange_weak(expected, 1, std::memory_order_acq_rel);
state.compare_exchange_weak(expected, 1);

// ILLEGAL failure orders (UB / ill-formed precondition):
// state.compare_exchange_strong(expected, 1, mo_acq_rel, mo_release);   // no
// state.compare_exchange_strong(expected, 1, mo_acq_rel, mo_acq_rel);   // no
// state.compare_exchange_strong(expected, 1, mo_relaxed, mo_seq_cst);   // stronger than success
```

```cpp
// ---- semantics, written out --------------------------------------------
// bool compare_exchange_strong(T& expected, T desired, mo succ, mo fail) {
//     if (value_representation_of(*this) == value_representation_of(expected)) {
//         atomically store desired with order `succ`;   // this is an RMW
//         return true;
//     } else {
//         expected = load(*this) with order `fail`;     // this is a LOAD
//         return false;
//     }
// }
```

| Member | Returns | Kind | Legal orders |
|---|---|---|---|
| `load(mo = seq_cst) const noexcept` | `T` | read | relaxed, consume, acquire, seq_cst |
| `store(T, mo = seq_cst) noexcept` | `void` | write | relaxed, release, seq_cst |
| `operator T() const noexcept` | `T` | read | seq_cst |
| `operator=(T) noexcept` | `T` (by value) | write | seq_cst |
| `exchange(T, mo = seq_cst) noexcept` | previous `T` | RMW | all six |
| `compare_exchange_weak(T&, T, mo, mo) noexcept` | `bool` | RMW on success, load on failure | success: all; failure: no release/acq_rel |
| `compare_exchange_strong(T&, T, mo, mo) noexcept` | `bool` | same, no spurious failure | same |
| `fetch_add/sub(A, mo = seq_cst) noexcept` | previous `T` | RMW | all six |
| `fetch_and/or/xor(T, mo = seq_cst) noexcept` | previous `T` | RMW | all six |
| `++ -- += -= &= \|= ^=` | new value (`T`) | RMW | seq_cst only |
| `wait(T old, mo = seq_cst) const noexcept` | `void` | blocking load loop | load orders only |
| `notify_one() / notify_all() noexcept` | `void` | — | none (no `mo` parameter) |
| `is_lock_free() const noexcept` | `bool` | — | — |

- All atomic member functions are `noexcept`; none allocate for lock-free specializations.
- `fetch_*` returns the value **before** modification; compound operators return the value **after**.
- The compound assignment operators and `++/--` have **no** memory-order overload — they are always `seq_cst`.

| Order | Load | Store | RMW | Effect |
|---|:-:|:-:|:-:|---|
| `relaxed` | ✓ | ✓ | ✓ | atomicity + this object's modification order |
| `consume` | ✓ | — | ✓ | dependency ordering; deprecated, treat as acquire |
| `acquire` | ✓ | — | ✓ | nothing after may move before; pairs with a release it reads |
| `release` | — | ✓ | ✓ | nothing before may move after; publishes prior writes |
| `acq_rel` | — | — | ✓ | both halves on one RMW |
| `seq_cst` | ✓ | ✓ | ✓ | acq/rel as applicable **+** one global total order |

**Traps** — `a = a + 1` on an atomic is a load, an add, and a store: three operations · `++a` costs a full `seq_cst` barrier where `fetch_add(1, relaxed)` costs none · `fetch_add` on `atomic<T*>` scales by `sizeof(T)` · `exchange` return value is the *old* value, easy to invert · passing `expected` by value into a helper loses the refresh · `operator=` returns `T`, so `x = y = 1` on atomics does two stores and one implicit load.

---

## 30.3 Weak versus strong CAS and expected-value update semantics

```cpp
// ---- canonical weak-CAS retry loop: recompute desired every iteration --
std::atomic<std::uint64_t> total{0};

void add_scaled(std::uint64_t v) noexcept {
    auto cur = total.load(std::memory_order_relaxed);
    std::uint64_t next;
    do {
        next = cur * 2 + v;                      // desired DEPENDS on cur
    } while (!total.compare_exchange_weak(
                 cur, next,
                 std::memory_order_release,      // success publishes
                 std::memory_order_relaxed));    // failure just refreshes cur
}
```

```cpp
// ---- Treiber-push: producer needs release only ------------------------
struct Node { Node* next; int value; };
std::atomic<Node*> head{nullptr};

void push(Node* node) noexcept {
    Node* observed = head.load(std::memory_order_relaxed);
    do {
        node->next = observed;                   // must be redone after failure
    } while (!head.compare_exchange_weak(observed, node,
                                         std::memory_order_release,
                                         std::memory_order_relaxed));
}

// ---- pop needs acquire (it dereferences what it reads) ----------------
Node* pop() noexcept {
    Node* observed = head.load(std::memory_order_acquire);
    while (observed &&
           !head.compare_exchange_weak(observed, observed->next,   // ← ABA + UAF risk
                                       std::memory_order_acq_rel,
                                       std::memory_order_acquire)) {}
    return observed;   // NOT safe without reclamation (see 30.9 / ch31)
}
```

```cpp
// ---- strong CAS: single-shot claim, no loop ---------------------------
std::atomic<int> owner{-1};
bool try_claim(int me) noexcept {
    int free_val = -1;
    return owner.compare_exchange_strong(free_val, me,
                                         std::memory_order_acq_rel,
                                         std::memory_order_relaxed);
}

// ---- strong CAS in a loop is also fine, just possibly slower on LL/SC --
// weak on ARM/POWER maps to one LL/SC attempt; strong adds an inner retry loop.

// ---- CAS-based max (no fetch_max before C++26) ------------------------
void atomic_max(std::atomic<std::int64_t>& a, std::int64_t v) noexcept {
    auto cur = a.load(std::memory_order_relaxed);
    while (cur < v && !a.compare_exchange_weak(cur, v,
                                               std::memory_order_relaxed,
                                               std::memory_order_relaxed)) {}
}

// ---- CAS as a pure load (idiom for reading a lock-free-false atomic) --
Top read_top(std::atomic<Top>& t) noexcept {
    Top e{};
    t.compare_exchange_strong(e, e, std::memory_order_acquire,
                                    std::memory_order_acquire);
    return e;   // e now holds the observed value either way
}
```

| Aspect | `compare_exchange_weak` | `compare_exchange_strong` |
|---|---|---|
| Spurious failure | permitted (LL/SC reservation loss, interrupt, cache event) | never |
| Typical codegen | one LL/SC pair | LL/SC pair inside an implementation loop |
| Use when | already inside a retry loop | no loop, or retry cost is high |
| `expected` on real failure | overwritten with observed | overwritten with observed |
| `expected` on spurious failure | overwritten with the (equal) observed value | n/a |
| x86 | both are `lock cmpxchg`; identical | identical |

**Comparison is on the value representation, not `operator==`:**

```cpp
struct Padded { std::uint8_t tag; /* 3 bytes padding */ std::uint32_t n; };
std::atomic<Padded> pad{};    // CAS may fail FOREVER: padding bits differ
// Fix: pack into a single integer, or use [[no_unique_address]]/explicit fields
// so the type has no padding. C++20 clears padding on atomic construction/store,
// but a locally-constructed `expected` on the stack may still carry garbage.
struct Packed { std::uint32_t tag; std::uint32_t n; };   // no padding → safe
static_assert(sizeof(Packed) == 8 && std::has_unique_object_representations_v<Packed>);
```

**Interview line** — "A failed compare-exchange overwrites `expected` with what it actually saw, so the loop body must recompute `desired` from that refreshed value; failure is a load and therefore can never be `release` or `acq_rel`."

**Traps** — `while (!cas(expected, desired))` with `desired` computed *outside* the loop is a silent lost-update bug · re-reading with `load()` inside the loop is redundant and adds a race window · `float`/`double` CAS on `-0.0` vs `+0.0` compares representations, not values · NaN never equals itself under `==` but its representation does compare equal · a CAS loop is not lock-free-in-practice if the retry rate is unbounded under contention.

---

## 30.4 Relaxed, acquire, release, acq_rel, and seq_cst

```cpp
// ================= relaxed: statistics only ============================
std::atomic<std::uint64_t> dropped{0};
void record_drop() noexcept { dropped.fetch_add(1, std::memory_order_relaxed); }
// Guarantees: unique increments, no lost updates, coherent per-object order.
// Does NOT: publish any other write, or order this counter against anything.
```

```cpp
// ================= release/acquire publication =========================
struct Quote { std::int64_t bid, ask; };
Quote slot;                                   // ORDINARY, non-atomic
std::atomic<bool> full{false};

void producer(Quote q) noexcept {
    slot = q;                                          // A: plain writes
    full.store(true, std::memory_order_release);       // B: publishes A
}
bool consumer(Quote& out) noexcept {
    if (!full.load(std::memory_order_acquire)) return false;  // C: reads B ⇒ sync
    out = slot;                                        // D: sees A, no race
    return true;
}
// Edge: A sequenced-before B; C reads-from B ⇒ B synchronizes-with C
//       ⇒ A happens-before D.  Break ANY link and it is a data race.
```

```text
one-shot only. Reuse needs the reverse edge:
  producer: write payload -> release full=true
  consumer: acquire full==true -> read payload -> release full=false
  producer: acquire full==false -> owns empty slot again
The flag is the ownership token, not just a boolean.
```

```cpp
// ================= acq_rel on an RMW ===================================
// (An acquire load also synchronizes with a release store it does not read
//  directly, provided it reads a value from that store's *release sequence* —
//  the chain of RMWs headed by it. Defined in §29.5; that rule is what makes
//  the refcount idiom below correct.)
std::atomic<int> refcount{1};
void release_ref(Resource* r) noexcept {
    if (refcount.fetch_sub(1, std::memory_order_acq_rel) == 1) delete r;
}
// Cheaper canonical form: release on the decrement, acquire fence on the last one.
void release_ref_fast(Resource* r) noexcept {
    if (refcount.fetch_sub(1, std::memory_order_release) == 1) {
        std::atomic_thread_fence(std::memory_order_acquire);   // only the destroyer pays
        delete r;
    }
}
```

```cpp
// ================= seq_cst: the only order with a GLOBAL total order ===
std::atomic<bool> x{false}, y{false};
// T0: x.store(true, seq_cst); r1 = y.load(seq_cst);
// T1: y.store(true, seq_cst); r2 = x.load(seq_cst);
// r1 == false && r2 == false is FORBIDDEN.  With relaxed or even
// release/acquire it is ALLOWED (neither acquire reads the other's release).
```

| Question about your invariant | Order |
|---|---|
| Only this object's numeric evolution matters | `relaxed` |
| This store must publish earlier plain writes | `release` |
| This load must consume someone's publication | `acquire` |
| This RMW consumes and publishes | `acq_rel` |
| Two threads must agree on the *global order* of independent objects | `seq_cst` |
| Unsure | `seq_cst` (or a mutex) until you can draw the graph |

| Order pair | Establishes happens-before? |
|---|---|
| release store → acquire load *that reads it* | yes |
| release store → acquire load reading an older value | no |
| release store → relaxed load | no |
| relaxed store → acquire load | no |
| seq_cst store → seq_cst load reading it | yes (+ total order) |
| release RMW → acquire load reading it | yes |
| release RMW reading X | does **not** acquire X's associated data |

**Cost model (typical):**

| Target | relaxed load | acquire load | release store | seq_cst store | RMW |
|---|---|---|---|---|---|
| x86-64 | `mov` | `mov` (free) | `mov` (free) | `xchg`/`mov`+`mfence` | `lock`-prefixed |
| AArch64 | `ldr` | `ldar` | `stlr` | `stlr` (+`dmb` for older mappings) | `ldaxr`/`stlxr` loop |
| POWER | `ld` | `ld;isync` | `lwsync;st` | `hwsync;st` | `lwarx`/`stwcx.` loop |

**Traps** — release/acquire is *pairwise*, so three threads can disagree on order without `seq_cst` · a relaxed counter used as a readiness flag publishes nothing · `consume` silently becomes `acquire`, so code "proved" with consume is only accidentally right · seq_cst on a *subset* of the operations does not restore SC for the whole program · SC does not make `load(); store();` indivisible.

---

## 30.5 Fences and why they are harder to use correctly

```cpp
#include <atomic>

// ---- all fence spellings ----------------------------------------------
std::atomic_thread_fence(std::memory_order_relaxed);   // NO-OP by definition
std::atomic_thread_fence(std::memory_order_acquire);   // acquire fence
std::atomic_thread_fence(std::memory_order_release);   // release fence
std::atomic_thread_fence(std::memory_order_acq_rel);   // both
std::atomic_thread_fence(std::memory_order_seq_cst);   // joins the SC total order
std::atomic_thread_fence(std::memory_order_consume);   // == acquire fence

std::atomic_signal_fence(std::memory_order_acq_rel);   // COMPILER barrier only,
                                                       // zero instructions emitted
```

```cpp
// ---- fence-atomic message passing --------------------------------------
std::atomic<bool> ready{false};
int payload;

void producer() {
    payload = 42;
    std::atomic_thread_fence(std::memory_order_release);   // F_rel
    ready.store(true, std::memory_order_relaxed);          // X: the CARRIER
}
void consumer() {
    if (ready.load(std::memory_order_relaxed)) {           // Y: reads X
        std::atomic_thread_fence(std::memory_order_acquire); // F_acq
        use(payload);                                      // ordered
    }
}
// Rule: F_rel sequenced-before X, Y reads-from X, Y sequenced-before F_acq
//       ⇒ F_rel synchronizes-with F_acq.  Remove the atomic and NOTHING holds.
```

```cpp
// ---- the three hybrid forms, all valid ---------------------------------
// fence-fence : release fence + relaxed store | relaxed load + acquire fence
// fence-atomic: release fence + relaxed store | acquire LOAD
// atomic-fence: release STORE                 | relaxed load + acquire fence

// ---- prefer the direct form when it expresses the protocol -------------
ready.store(true, std::memory_order_release);
if (ready.load(std::memory_order_acquire)) use(payload);
```

```cpp
// ---- where a fence genuinely earns its place ---------------------------
// 1) Amortize: many relaxed stores, ONE release fence before publishing.
for (std::size_t i = 0; i < n; ++i) buffer[i].store(v[i], std::memory_order_relaxed);
std::atomic_thread_fence(std::memory_order_release);
head.store(n, std::memory_order_relaxed);

// 2) Pay only on the rare path (refcount destructor, seqlock reader retry).
// 3) Seqlock: reader needs an acquire fence between payload read and seq re-check.
// 4) Dekker/store-buffer: a seq_cst FENCE between the store and the load.
std::atomic_thread_fence(std::memory_order_seq_cst);
```

```cpp
// ---- signal fence: same thread, handler vs mainline --------------------
volatile std::sig_atomic_t flag = 0;
std::atomic<int> data{0};
void handler(int) {                       // async-signal context
    data.store(1, std::memory_order_relaxed);
    std::atomic_signal_fence(std::memory_order_release);
    flag = 1;
}
// No inter-THREAD guarantee whatsoever; use atomic_thread_fence for that.
```

| Facility | Scope | Codegen | Needs an atomic carrier? |
|---|---|---|---|
| `atomic_thread_fence(mo)` | inter-thread | may emit a hardware barrier | **yes** — a read-from edge |
| `atomic_signal_fence(mo)` | this thread vs its signal handlers | none (compiler only) | no |
| `volatile` | none (device I/O / no elision) | prevents removal/reordering *of volatiles* | not a substitute |
| inline `asm ::: "memory"` | compiler only, non-portable | none | no |
| CPU intrinsic (`_mm_mfence`) | hardware only | one instruction | not modeled by C++ |

**Interview line** — "A fence has no operand, so it cannot carry a synchronizes-with edge by itself — the edge always comes from an atomic whose value one thread reads from the other."

**Traps** — a `relaxed` fence is a no-op, not "a cheap fence" · `atomic_signal_fence` provides zero inter-thread ordering despite compiling · counting emitted instructions is a cost study, not a proof; x86 emits nothing for acquire/release · a fence *after* the store or *before* the load in the MP pattern proves nothing · `volatile` is not atomic, not ordered, and not a fence.

---

## 30.6 `std::atomic_ref` alignment and lifetime requirements

```cpp
#include <atomic>
#include <span>
#include <vector>

// ---- basic use: atomically touch an ordinary object -------------------
alignas(std::atomic_ref<std::uint64_t>::required_alignment)
std::uint64_t counter{};

void increment() noexcept {
    std::atomic_ref ref{counter};                       // CTAD → atomic_ref<uint64_t>
    ref.fetch_add(1, std::memory_order_relaxed);
}

// ---- construction forms ------------------------------------------------
std::uint64_t obj{};
std::atomic_ref<std::uint64_t>       r1{obj};           // explicit ctor from T&
std::atomic_ref<std::uint64_t>       r2{r1};            // copy ctor — refers to the SAME object
std::atomic_ref<const std::uint64_t> rc{obj};           // C++26: read-only ref
// std::atomic_ref<std::uint64_t> r3;                   // ill-formed: no default ctor
// r1 = r2;                                             // operator=(atomic_ref) is deleted;
r1 = 5;                                                 // operator=(T) → store(seq_cst)

// ---- constants ---------------------------------------------------------
constexpr bool always = std::atomic_ref<std::uint64_t>::is_always_lock_free;
constexpr std::size_t align = std::atomic_ref<std::uint64_t>::required_alignment;
static_assert(align >= alignof(std::uint64_t));

// ---- full member surface mirrors atomic<T> -----------------------------
std::atomic_ref<std::uint64_t> a{obj};
a.store(1, std::memory_order_release);
auto v = a.load(std::memory_order_acquire);
auto p = a.exchange(2, std::memory_order_acq_rel);
std::uint64_t exp = 2;
a.compare_exchange_weak(exp, 3, std::memory_order_acq_rel, std::memory_order_acquire);
a.compare_exchange_strong(exp, 4, std::memory_order_seq_cst);
a.fetch_add(1, std::memory_order_relaxed);
a.fetch_sub(1); a.fetch_and(~0ull); a.fetch_or(0); a.fetch_xor(0);
++a; a += 1;                                            // seq_cst
a.wait(4, std::memory_order_acquire);
a.notify_one(); a.notify_all();
bool lf = a.is_lock_free();

// ---- the realistic motivation: atomics over a plain buffer ------------
void parallel_accumulate(std::span<std::int64_t> bins, std::size_t i, std::int64_t d) {
    std::atomic_ref{bins[i]}.fetch_add(d, std::memory_order_relaxed);
}
// bins stays a plain vector<int64_t>: copyable, resizable, memcpy-able,
// and readable non-atomically once all refs are gone and threads joined.
```

```cpp
// ---- alignment failure is UB, not a diagnostic ------------------------
struct Bad { char c; std::uint64_t n; };     // n at offset 8 here, but packed types vary
#pragma pack(push, 1)
struct Packed1 { char c; std::uint64_t n; }; // n at offset 1 → misaligned
#pragma pack(pop)
// std::atomic_ref{packed.n};                // UB: violates required_alignment
```

| Requirement | Consequence of violating it |
|---|---|
| `T` trivially copyable | ill-formed |
| Object aligned to `required_alignment` | **UB** |
| Object outlives every `atomic_ref` and every operation on it | **UB** (dangling) |
| While any ref exists, all access to that object goes through refs | **data race** |
| Refs must target the same complete object, not overlapping subobjects | UB for most `T` |
| `atomic_ref<const T>` | loads/wait only; no store/RMW |
| `T` may be `volatile`-qualified? | no — non-const, non-volatile `T` |

| vs `atomic<T>` | `atomic<T>` | `atomic_ref<T>` |
|---|---|---|
| Owns storage | yes | no — references existing `T` |
| Copyable/movable | no | the *ref* is copyable; both alias the same object |
| Fixed atomic-ness | whole lifetime | only while a ref exists |
| Usable in `vector` | awkward (not copyable) | yes — `vector<T>` + refs |
| Layout/ABI change | may change size/alignment | none on `T` (may require stricter alignment) |
| Lock-free | per type | per type, same table |

**Interview line** — "`atomic_ref` gives an *existing* object atomic access for a bounded window, at the price of proving alignment, lifetime, and that no plain access to that object overlaps the window."

**Traps** — a hidden non-atomic reader elsewhere in the codebase silently reintroduces the race · a ref to `v[i]` dangles the instant `v` reallocates · `required_alignment` can exceed `alignof(T)` (e.g. 16 for a 16-byte struct) so `alignas` is mandatory, not decorative · CTAD deduces `atomic_ref<T>` from `T&` but `atomic_ref<const T>` only in C++26 · copying an `atomic_ref` does not copy the value.

---

## 30.7 Atomic wait/notify and blocking implementations

```cpp
#include <atomic>

std::atomic<std::uint64_t> epoch{0};

// ---- waiter ------------------------------------------------------------
void wait_for_change(std::uint64_t old) {
    epoch.wait(old, std::memory_order_acquire);   // blocks WHILE value == old
    // on return, the observed value differs from `old` (or it was a spurious wake
    // that re-checked and found a difference)
}

// ---- notifier ----------------------------------------------------------
void publish_epoch(std::uint64_t next) {
    epoch.store(next, std::memory_order_release);  // change the value FIRST
    epoch.notify_all();                            // then wake — no mo parameter
}

// ---- the whole API -----------------------------------------------------
epoch.wait(0);                                   // seq_cst default
epoch.wait(0, std::memory_order_relaxed);        // load orders only
epoch.wait(0, std::memory_order_acquire);
epoch.notify_one();                              // wake at least one waiter
epoch.notify_all();                              // wake all waiters
// free-function forms:
std::atomic_wait(&epoch, 0ull);
std::atomic_wait_explicit(&epoch, 0ull, std::memory_order_acquire);
std::atomic_notify_one(&epoch);
std::atomic_notify_all(&epoch);
```

```cpp
// ---- exact semantics ---------------------------------------------------
// wait(old, mo) ≈ {
//   while (true) {
//     T cur = this->load(mo);
//     if (representation(cur) != representation(old)) return;  // value COMPARISON
//     platform_block_until_notified();                         // may wake spuriously
//   }
// }
// Consequence: notify with an UNCHANGED value does not release the waiter.
```

```cpp
// ---- binary semaphore built from wait/notify ---------------------------
class Event {
    std::atomic<std::uint32_t> gen_{0};
public:
    std::uint32_t snapshot() const noexcept { return gen_.load(std::memory_order_acquire); }
    void wait(std::uint32_t seen) const noexcept { gen_.wait(seen, std::memory_order_acquire); }
    void signal() noexcept {
        gen_.fetch_add(1, std::memory_order_release);   // MONOTONIC → immune to ABA
        gen_.notify_all();
    }
};
// Take the snapshot BEFORE checking your condition, or you race the notifier.
```

```cpp
// ---- atomic_flag: the guaranteed-lock-free, always-available atomic ----
std::atomic_flag lock = ATOMIC_FLAG_INIT;    // or just: std::atomic_flag lock;  (C++20)

lock.test_and_set(std::memory_order_acquire);   // set to true, return PREVIOUS
lock.clear(std::memory_order_release);          // set to false
bool cur = lock.test(std::memory_order_relaxed);// C++20: read WITHOUT setting
lock.wait(true, std::memory_order_relaxed);     // C++20
lock.notify_one(); lock.notify_all();           // C++20
// free functions: atomic_flag_test_and_set[_explicit], atomic_flag_clear[_explicit],
//                 atomic_flag_test[_explicit], atomic_flag_wait/notify_one/all

// ---- TAS spinlock with a relaxed test-test-and-set inner loop ----------
class SpinLock {
    std::atomic_flag f_ = ATOMIC_FLAG_INIT;
public:
    void lock() noexcept {
        while (f_.test_and_set(std::memory_order_acquire))
            while (f_.test(std::memory_order_relaxed))   // read-only spin: no RFO storm
                ;                                        // + pause/yield in production
    }
    bool try_lock() noexcept { return !f_.test_and_set(std::memory_order_acquire); }
    void unlock() noexcept { f_.clear(std::memory_order_release); }
};

// ---- blocking spinlock: park instead of burning cycles ----------------
class ParkingLock {
    std::atomic_flag f_;
public:
    void lock() noexcept {
        while (f_.test_and_set(std::memory_order_acquire))
            f_.wait(true, std::memory_order_relaxed);    // sleeps
    }
    void unlock() noexcept { f_.clear(std::memory_order_release); f_.notify_one(); }
};
```

| Member | Type | Guarantee |
|---|---|---|
| `atomic_flag::test_and_set(mo)` | RMW | **always lock-free**, returns previous value |
| `atomic_flag::clear(mo)` | store | `release` typical; `acquire`/`acq_rel` are UB |
| `atomic_flag::test(mo) const` | load | C++20; non-mutating read |
| `atomic_flag::wait/notify_*` | — | C++20 |
| `atomic<T>::wait(old, mo)` | blocking load | returns only when the representation differs |
| `atomic<T>::notify_one/all()` | — | no memory order, no fairness, no wake bound |

- `wait` may spin, may park in a futex/OS primitive, and may wake spuriously — always in a loop conceptually.
- `notify_*` has no ordering effect of its own: visibility comes from the store/RMW that changed the value.
- A notify that runs before the waiter blocks is not lost, because `wait` re-checks the value first — provided you changed the value.

**Traps** — `notify_all()` without changing the value wakes nobody usefully · ABA (`A→B→A`) between two `wait` checks is invisible: use a monotonic generation counter · `wait` compares *representations*, so padding garbage or `-0.0`/`+0.0` can behave surprisingly · no timed `wait` exists — use `condition_variable`/`counting_semaphore` when you need a deadline · `atomic_flag` had no `test()` before C++20, which is why the old TTAS idiom used `atomic<bool>`.

---

## 30.8 Lock-free, sometimes-lock-free, and wait-free distinctions

| Progress property | Definition | Failure mode it still permits |
|---|---|---|
| Blocking | a suspended holder can stall everyone | priority inversion, convoy, deadlock |
| Obstruction-free | a thread finishes if it eventually runs alone | livelock under contention |
| Lock-free | *some* thread completes in a bounded number of steps | individual starvation, unbounded retries for one thread |
| Wait-free | *every* thread completes in a bounded number of **its own** steps | still not fast; bound may be large |
| Wait-free population-oblivious | bound independent of thread count | — |

```cpp
// Lock-free (system-wide progress) but NOT wait-free: one thread can lose forever.
while (!head.compare_exchange_weak(observed, node,
                                   std::memory_order_release,
                                   std::memory_order_relaxed)) {}

// Wait-free: no loop, one RMW, bounded steps.
auto ticket = next.fetch_add(1, std::memory_order_relaxed);

// Wait-free single-writer publication (seqlock write side is NOT wait-free for readers).
value.store(v, std::memory_order_release);
```

```cpp
// ---- what is_lock_free() actually claims ------------------------------
static_assert(std::atomic<std::uint64_t>::is_always_lock_free);   // the PRIMITIVE
// It does NOT claim: your algorithm avoids locks, avoids allocation, avoids
// reclamation stalls, terminates, or is fast.
struct Big { double a[8]; };
// std::atomic<Big> almost certainly takes a hidden mutex/lock table:
static_assert(!std::atomic<Big>::is_always_lock_free);
// ⇒ signal-handler use of atomic<Big> can DEADLOCK; only atomic_flag and
//   lock-free atomics are async-signal-safe.
```

**Things that silently destroy a "lock-free" claim:** `new`/`delete`, `malloc`, `std::function`, `shared_ptr` refcount contention, `std::string`, virtual dispatch through cold pages, page faults, `mmap`, logging, and any container that can reallocate.

**Interview line** — "Lock-free is a *progress* property of the whole algorithm; `is_lock_free()` is a *codegen* property of one atomic type — a lock-free CAS loop that calls `new` is not a lock-free algorithm."

**Traps** — "lock-free" ≠ "fast": an uncontended `std::mutex` often beats a contended CAS loop · lock-free code can still be starved indefinitely · wait-free bounds are step bounds, not time bounds (a cache miss is one step) · `is_lock_free()` may differ per *object* (alignment) on some implementations, which is why it is not `static`.

---

## 30.9 ABA, version tags, and wraparound

```text
T0 loads head = A
T0 is preempted
T1 pops A, pops B, frees A, allocates a new node at the SAME address, pushes it as A
T0 resumes: CAS(head, expected=A, desired=A->next_stale) SUCCEEDS
⇒ head now points at a freed or wrong node. CAS compared bits, not history.
```

```cpp
// ---- mitigation 1: tagged index (portable, no pointer packing) --------
struct TaggedIndex {
    std::uint32_t index;        // slot in a pre-sized pool
    std::uint32_t tag;          // bumped on EVERY publication
};
static_assert(sizeof(TaggedIndex) == 8);
static_assert(std::has_unique_object_representations_v<TaggedIndex>);  // no padding

std::atomic<TaggedIndex> head{TaggedIndex{npos, 0}};
static_assert(std::atomic<TaggedIndex>::is_always_lock_free);   // 8 bytes → yes

void push(std::uint32_t slot, std::vector<Node>& pool) noexcept {
    TaggedIndex cur = head.load(std::memory_order_relaxed);
    TaggedIndex next;
    do {
        pool[slot].next = cur.index;
        next = TaggedIndex{slot, cur.tag + 1};    // tag ALWAYS increments
    } while (!head.compare_exchange_weak(cur, next,
                                         std::memory_order_release,
                                         std::memory_order_relaxed));
}
```

```cpp
// ---- mitigation 2: double-width CAS on {pointer, tag} -----------------
struct alignas(16) TaggedPtr { Node* ptr; std::uintptr_t tag; };
std::atomic<TaggedPtr> head16{};
// is_always_lock_free only if the target has CMPXCHG16B / LDXP+STXP and the
// implementation enables it (-mcx16 on some toolchains). Otherwise it LOCKS.
static_assert(std::atomic<TaggedPtr>::is_always_lock_free);   // verify per target!
```

```cpp
// ---- mitigation 3: pointer packing (NOT portable) ---------------------
// 16 spare high bits on current x86-64 user-space + 3 low bits from 8-byte
// alignment. Breaks under 5-level paging, pointer authentication (ARM PAC),
// MTE tagging, sanitizers, and any provenance-tracking implementation.
std::uintptr_t packed = (std::uintptr_t(ptr) & 0x0000'FFFF'FFFF'FFF8ull)
                      | (tag & 0x7);

// ---- mitigation 4: don't recycle while observable ---------------------
// hazard pointers, epoch-based reclamation, RCU, deferred free lists → ch31.

// ---- mitigation 5: an invariant that tolerates ABA --------------------
// e.g. a monotonically increasing sequence number can never return to a prior value.
```

**Wraparound arithmetic:**

```cpp
// Unsigned wraparound is well-defined; SIGNED overflow is UB, so use unsigned
// for sequence/tag/index comparisons.
std::uint32_t head, tail;
bool nonempty = (std::uint32_t)(head - tail) > 0;   // wrap-safe difference
// Ring index masking requires a power-of-two capacity:
std::uint32_t idx = seq & (capacity - 1);           // capacity must be 2^k
// A 32-bit tag at 100M publications/s wraps in ~43 s; prove no observation
// outlives a full tag cycle, or use 64 bits.
```

| Mitigation | Cost | Portability |
|---|---|---|
| Tagged index (32+32 in one 64-bit atomic) | one 8-byte CAS, needs a pool | fully portable |
| Double-width CAS `{ptr, tag}` | 16-byte CAS, may not be lock-free | target-dependent |
| Pointer packing | free bits, one 8-byte CAS | not portable; hostile to PAC/MTE/sanitizers |
| Hazard pointers | per-read publish + scan on retire | portable, more code |
| Epoch/RCU | cheap reads, deferred frees | portable, memory-growth risk |
| ABA-tolerant invariant | zero | design-specific |

**Traps** — a tag that only increments on *push* still allows ABA via pop · padding inside the tagged struct makes CAS never succeed · `atomic<TaggedPtr>` compiling does not mean it is lock-free — assert `is_always_lock_free` · reusing a slot index without bumping the generation reintroduces ABA one level up · signed indices + overflow = UB, and the optimizer will exploit it.

---

## 30.10 False sharing, padding, and contended atomics

> The layout technique — padded counters, `PaddedSlot`, sharded aggregation, and the
> true/false/read-sharing taxonomy — is covered once in [§26.4](/iprep/books/cpp-cheatsheet/26-cache-conscious-and-data-oriented-cpp/).
> This section adds only what is specific to **atomics**: why weakening the order does not
> help, and how contention shows up in the RMW itself.

```cpp
#include <new>       // std::hardware_destructive_interference_size (C++17)
#include <atomic>

#ifdef __cpp_lib_hardware_interference_size
inline constexpr std::size_t kLine = std::hardware_destructive_interference_size;
#else
inline constexpr std::size_t kLine = 64;      // libstdc++ warns/omits it; fall back
#endif

// ---- constructive interference: pack things read TOGETHER --------------
struct HotPair {
    alignas(std::hardware_constructive_interference_size)
    struct { std::int64_t bid; std::int64_t ask; } top;   // one line, one miss
};
```

```cpp
// ---- verify at runtime, do not assume ---------------------------------
assert(reinterpret_cast<std::uintptr_t>(&c.produced) / kLine
    != reinterpret_cast<std::uintptr_t>(&c.consumed) / kLine);
```

```cpp
// ---- batch locally, publish rarely ------------------------------------
thread_local std::uint64_t local_drops = 0;
void record_drop() noexcept {
    if (++local_drops % 1024 == 0)
        global_drops.fetch_add(1024, std::memory_order_relaxed);
}
```

| Symptom | Cause | Fix |
|---|---|---|
| Throughput *falls* as threads are added | false sharing | `alignas(kLine)` per hot field |
| `relaxed` did not help contention | coherence traffic is independent of order | shard / batch / single-writer |
| Spin loop saturates the bus | `test_and_set` in the inner loop (RFO per iteration) | TTAS: relaxed `test()` inner spin |
| High `MACHINE_CLEARS.MEMORY_ORDERING` | store-buffer / SC fences | reduce seq_cst, reduce shared writes |
| Reader stalls behind a writer | shared line ownership | seqlock, or reader-private snapshot |

- `hardware_destructive_interference_size` is a *hint*; libstdc++ warns under `-Winterference-size` because the value is ABI-frozen and may not match the deployment CPU.
- Weakening from `seq_cst` to `relaxed` removes barriers and compiler restrictions but never removes cache-line ownership transfer for writes.
- A read-only atomic shared by many cores is nearly free (shared state); one writer among readers is what costs.

**Traps** — `alignas` on the *member* without `alignas` on the *struct* leaves arrays of the struct misaligned · heap allocation only guarantees `__STDCPP_DEFAULT_NEW_ALIGNMENT__` unless the type is over-aligned (C++17 aligned `new` handles it) · padding inside a struct you also CAS breaks compare-exchange · `thread_local` access has its own (small) cost in shared libraries · adjacent objects in a `vector<atomic<T>>` share lines unless `T` is padded.

---

## 30.11 Litmus tests: message passing, store buffering, and Dekker-style patterns

```cpp
// ==================== MP — message passing =============================
#include <atomic>
#include <cassert>
#include <thread>

int data = 0;                                   // plain, non-atomic
std::atomic<bool> ready{false};

void mp_writer() {
    data = 7;                                            // W1
    ready.store(true, std::memory_order_release);        // W2 publishes W1
}
void mp_reader() {
    if (ready.load(std::memory_order_acquire))           // R1 reads W2 ⇒ sync
        assert(data == 7);                               // R2 — CANNOT fire
}
// Allowed outcomes: reader sees ready==false (returns), or ready==true && data==7.
// FORBIDDEN: ready==true && data!=7.

void mp_writer_broken() {
    data = 7;
    ready.store(true, std::memory_order_relaxed);        // no publication
}
void mp_reader_broken() {
    if (ready.load(std::memory_order_relaxed))
        assert(data == 7);   // MAY FIRE, and reading `data` is a DATA RACE (UB)
}
```

```cpp
// ==================== SB — store buffering =============================
std::atomic<int> x{0}, y{0};
int r1 = 0, r2 = 0;

// --- relaxed / release-acquire: r1 == 0 && r2 == 0 is ALLOWED ----------
void sb_t0_relaxed() { x.store(1, std::memory_order_relaxed);
                       r1 = y.load(std::memory_order_relaxed); }
void sb_t1_relaxed() { y.store(1, std::memory_order_relaxed);
                       r2 = x.load(std::memory_order_relaxed); }
// Release store + acquire load is ALSO insufficient: each acquire reads the
// INITIAL value 0, so it reads-from nothing released ⇒ no synchronizes-with edge.

// --- seq_cst: r1 == 0 && r2 == 0 is FORBIDDEN -------------------------
void sb_t0_sc() { x.store(1, std::memory_order_seq_cst);
                  r1 = y.load(std::memory_order_seq_cst); }
void sb_t1_sc() { y.store(1, std::memory_order_seq_cst);
                  r2 = x.load(std::memory_order_seq_cst); }
// Proof: in the single total order, one store precedes the other; whichever
// load comes last in that order must observe the earlier store.

// --- relaxed + seq_cst FENCE: also forbidden, sometimes cheaper -------
void sb_t0_fence() { x.store(1, std::memory_order_relaxed);
                     std::atomic_thread_fence(std::memory_order_seq_cst);
                     r1 = y.load(std::memory_order_relaxed); }
void sb_t1_fence() { y.store(1, std::memory_order_relaxed);
                     std::atomic_thread_fence(std::memory_order_seq_cst);
                     r2 = x.load(std::memory_order_relaxed); }

// --- an RMW also drains the store buffer on x86 ------------------------
void sb_t0_rmw() { x.exchange(1, std::memory_order_acq_rel);
                   r1 = y.load(std::memory_order_relaxed); }
```

```text
Why SB is real hardware, not a compiler joke:
  core0: [store x=1] -> store buffer (not yet visible)
         [load  y  ] -> misses the buffer, reads memory  => 0
  core1: symmetric                                        => 0
x86-TSO permits exactly this one reordering (store→load). ARM/POWER permit more.
```

```cpp
// ==================== IRIW — independent reads of independent writes ===
std::atomic<int> a{0}, b{0};
// T0: a.store(1, seq_cst);
// T1: b.store(1, seq_cst);
// T2: ra1 = a.load(seq_cst); rb1 = b.load(seq_cst);   // sees a then b
// T3: rb2 = b.load(seq_cst); ra2 = a.load(seq_cst);   // sees b then a
// (ra1==1 && rb1==0 && rb2==1 && ra2==0) is FORBIDDEN under seq_cst,
// ALLOWED under release/acquire — this is what "pairwise" costs you.
```

```cpp
// ==================== Dekker-style mutual exclusion ====================
std::atomic<bool> want0{false}, want1{false};
std::atomic<int>  turn{0};

// --- WRONG: release/acquire does NOT give mutual exclusion ------------
void enter0_broken() {
    want0.store(true, std::memory_order_release);
    while (want1.load(std::memory_order_acquire)) { /* spin */ }
    // BOTH threads can read false here: neither acquire read the other's
    // release (each read the INITIAL value) ⇒ both enter. Broken.
}

// --- CORRECT (1): all seq_cst + a turn tie-breaker --------------------
void enter0() {
    want0.store(true, std::memory_order_seq_cst);
    turn.store(1, std::memory_order_seq_cst);              // yield to the other
    while (want1.load(std::memory_order_seq_cst) &&
           turn.load(std::memory_order_seq_cst) == 1) { /* spin */ }
}
void exit0() { want0.store(false, std::memory_order_release); }

void enter1() {
    want1.store(true, std::memory_order_seq_cst);
    turn.store(0, std::memory_order_seq_cst);
    while (want0.load(std::memory_order_seq_cst) &&
           turn.load(std::memory_order_seq_cst) == 0) { /* spin */ }
}
void exit1() { want1.store(false, std::memory_order_release); }

// --- CORRECT (2): relaxed stores/loads + a seq_cst FENCE between them --
void enter0_fence() {
    want0.store(true, std::memory_order_relaxed);
    std::atomic_thread_fence(std::memory_order_seq_cst);   // kills store→load reorder
    turn.store(1, std::memory_order_relaxed);
    std::atomic_thread_fence(std::memory_order_seq_cst);
    while (want1.load(std::memory_order_relaxed) &&
           turn.load(std::memory_order_relaxed) == 1)
        std::atomic_thread_fence(std::memory_order_seq_cst);
}

// --- in production: just use std::mutex, or one atomic_flag TAS lock ---
```

```cpp
// ==================== LB — load buffering ==============================
// T0: r1 = x.load(relaxed); y.store(1, relaxed);
// T1: r2 = y.load(relaxed); x.store(1, relaxed);
// r1 == 1 && r2 == 1 is ALLOWED on relaxed (and on real ARM/POWER),
// FORBIDDEN once either thread uses acquire on its load or release on its store.
```

```cpp
// ==================== Relaxed ticket allocation ========================
std::atomic<std::uint64_t> next{0};
std::uint64_t take_ticket() noexcept {
    return next.fetch_add(1, std::memory_order_relaxed);   // unique + totally ordered
}
// Guaranteed: no two threads get the same ticket; the values follow `next`'s
// modification order. NOT guaranteed: anything the ticket "refers to" is visible.

// ==================== Coherence (CoRR) — always holds ==================
// Two loads of the SAME atomic by one thread never go backwards in that
// object's modification order, even with relaxed:
auto v1 = next.load(std::memory_order_relaxed);
auto v2 = next.load(std::memory_order_relaxed);
// v2 >= v1 is guaranteed for a monotonically-incremented counter.
```

| Litmus | Relaxed | Rel/Acq | Seq_cst | Real hardware that shows it |
|---|:-:|:-:|:-:|---|
| MP (`data==7` when `ready`) | broken | **safe** | safe | ARM, POWER, and compilers |
| SB (`r1==0 && r2==0`) | allowed | allowed | **forbidden** | x86-TSO, ARM, POWER |
| LB (`r1==1 && r2==1`) | allowed | forbidden | forbidden | ARM, POWER (not x86) |
| IRIW (disagreeing observers) | allowed | allowed | **forbidden** | POWER, ARM |
| Dekker entry | broken | broken | **safe** | x86-TSO already breaks rel/acq here |
| CoRR (same-object monotonicity) | safe | safe | safe | — |

**Interview line** — "Store buffering and Dekker fail under acquire/release because each thread's load reads the *initial* value, so there is no reads-from edge to synchronize with — only `seq_cst` (or a `seq_cst` fence between the store and the load) forbids the both-zero outcome."

**Cost-aware workflow**

1. State the invariant and the ownership transitions in one sentence each.
2. List every conflicting *ordinary* (non-atomic) access.
3. Pick the atomic whose observed value carries each synchronization edge.
4. Draw sequenced-before → reads-from → synchronizes-with → happens-before.
5. Choose CAS success and failure orders independently.
6. Prove lifetime/reclamation and progress as separate obligations.
7. Test with TSan (`-fsanitize=thread`) and stress — they find bugs, never prove absence.
8. Benchmark contention on the real target before weakening anything.

```cpp
// Encode intent in names; scattered raw load(relaxed) calls are unauditable.
void publish(Quote q) noexcept;        // "release: ownership transfers out"
bool try_consume(Quote& out) noexcept; // "acquire: observation of a publication"
```

**Traps** — TSan does not model weak hardware and will miss ARM-only bugs found on x86-compiled tests · "it works on x86" hides every LB and IRIW bug · a `seq_cst` load paired with a `release` store gives you acquire semantics but **not** SC-total-order membership for the store · adding `volatile` to fix a litmus test fixes nothing · assertions inside a racing read are themselves UB, so the test harness must use atomics for every shared object.
