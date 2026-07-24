# 25. The C++ Memory Model

Concurrent code needs rules for which writes another thread may observe and in what order. The C++ memory model supplies those rules across compilers and processors. Every atomic ordering is a claim about visibility; if the claim is wrong, the result ranges from stale data to undefined behavior.

## Why a model exists

Consider two variables initially zero and two processors running these operations:

```text
Thread 1                 Thread 2
x = 1                    y = 1
r1 = y                   r2 = x
```

Can both reads produce zero? A source-level interleaving that preserves each column's order cannot explain that result: one store must occur first, apparently forcing the other thread's later load to see it.

Real processors can produce the result. A core may retire its store into a store buffer, perform the following load, and make the buffered store visible to other cores later. On x86, this store-buffering outcome is the important exception to an otherwise strong ordering model.

Plain C++ `int` objects would make the example a data race and therefore undefined behavior. Relaxed atomics preserve the hardware experiment without introducing UB:

```cpp
#include <atomic>
#include <barrier>
#include <iostream>
#include <thread>

int main() {
    constexpr int trials = 200'000;
    std::atomic<int> x{0};
    std::atomic<int> y{0};
    int r1 = 0;
    int r2 = 0;
    int both_zero = 0;
    std::barrier sync_point{3};

    std::thread first{[&] {
        for (int i = 0; i < trials; ++i) {
            sync_point.arrive_and_wait();
            x.store(1, std::memory_order_relaxed);
            r1 = y.load(std::memory_order_relaxed);
            sync_point.arrive_and_wait();
        }
    }};
    std::thread second{[&] {
        for (int i = 0; i < trials; ++i) {
            sync_point.arrive_and_wait();
            y.store(1, std::memory_order_relaxed);
            r2 = x.load(std::memory_order_relaxed);
            sync_point.arrive_and_wait();
        }
    }};

    for (int i = 0; i < trials; ++i) {
        x.store(0, std::memory_order_relaxed);
        y.store(0, std::memory_order_relaxed);
        sync_point.arrive_and_wait();
        sync_point.arrive_and_wait();
        both_zero += r1 == 0 && r2 == 0;
    }
    first.join();
    second.join();
    std::cout << "both-zero observations: " << both_zero << '\n';
    // The count depends on the processor, compiler, and scheduling.
}
```

The compiler is the other reorderer. The as-if rule allows any transformation that preserves the abstract machine's observable behavior. A load may move, a store may sink, and a value may remain in a register if no legal single-threaded observation distinguishes the change.

Threads make some transformations observable. Different cores also may observe writes to different locations in different orders. There is no useful model in which every source operation immediately updates one globally visible “memory.”

The language therefore specifies an abstract machine: a contract describing legal executions rather than a circuit diagram. Correct code targets that contract. The compiler maps it to instructions, and the processor makes those instructions obey the required constraints.

This separation matters when debugging. Disassembly can explain how one build produced an allowed outcome, but it cannot define what another compiler or architecture must do. Conversely, source-level reasoning that ignores the selected memory orders cannot be repaired by pointing to a favorable instruction sequence from today's binary.

Portability starts with the abstract guarantee; instruction inspection verifies its cost on a chosen target.

## Locations, conflicts, and data races — the formal definitions

A **memory location** is either a scalar object or a maximal sequence of adjacent non-zero-width bit-fields. Scalar objects include arithmetic objects, pointers, and enumeration objects. Distinct ordinary members are distinct locations even when they are adjacent in a `struct`.

Bit-fields are the exception:

```cpp
struct Flags {
    unsigned bid_changed : 1;
    unsigned ask_changed : 1;
};

Flags flags{};

void mark_bid() {
    flags.bid_changed = 1;  // races with mark_ask()
}

void mark_ask() {
    flags.ask_changed = 1;  // UB if the functions run concurrently
}
```

The two bit-fields occupy one memory location because they are adjacent and non-zero-width. A zero-width bit-field between them would separate the locations. Better designs avoid concurrent bit-field mutation or protect the whole group with one synchronization mechanism.

Ordinary members do permit independent synchronization:

```cpp
struct TopOfBook {
    int bid = 0;
    int ask = 0;
    std::mutex bid_mutex;
    std::mutex ask_mutex;
};

void update_bid(TopOfBook& book, int value) {
    std::lock_guard lock{book.bid_mutex};
    book.bid = value;
}

void update_ask(TopOfBook& book, int value) {
    std::lock_guard lock{book.ask_mutex};
    book.ask = value;
}
```

Concurrent calls modify distinct locations and are race-free. A function that reads both prices must take both mutexes; the fact that each individual writer is locked does not order an unlocked whole-object snapshot.

Two evaluations **conflict** when one starts or ends an object's lifetime or modifies a memory location, and the other reads, modifies, or performs an overlapping lifetime operation on that location. Two reads do not conflict. Two writes conflict even if both write the same value.

A program execution contains a **data race** when:

- Two potentially concurrent evaluations conflict.
- They occur in different threads, apart from the signal-handler rules.
- At least one evaluation is non-atomic.
- Neither evaluation happens before the other.

A data race causes undefined behavior. This is the precise version of Chapter 23's informal rule.

**Rule.** C++ has no benign data race. If unsynchronized non-atomic accesses meet the definition, hardware behavior cannot rescue the program.

Undefined behavior lets the optimizer assume the race never occurs. A polling loop over a plain `bool` is not merely “possibly stale”:

```cpp
bool done = false;

void wait() {
    while (!done) {
    }
}
```

Once another thread writes `done`, the program has a race. Under the assumption that no race exists, the compiler can reason as if the loop's load never changes:

```text
Source                         Valid transformation after assuming no race
while (!done) {                if (!done) {
}                                 for (;;) {
                                  }
                               }
```

The transformation appears to make the failure happen before the conflicting write. This “time travel” is ordinary optimization applied after the language removes all requirements from a racy execution.

Separate non-bit-field members may be protected independently because they are separate locations. Padding bytes, however, are not spare memory locations with independent object lifetimes; do not appropriate them as unsynchronized side storage.

The **data-race-free sequential-consistency guarantee**, usually shortened to DRF-SC, restores interleaving reasoning under specific conditions. A program that uses mutexes and only sequentially consistent atomic operations to prevent every race behaves as if thread operations were interleaved while preserving each thread's order.

Weaker atomic orderings deliberately weaken that simple guarantee. A program using relaxed atomics can be data-race-free yet admit the both-zero execution from the opening. The rest of this chapter explains exactly which ordering edges weaker operations retain.

ThreadSanitizer from Chapter 23 detects many executed data races by tracking these ordering relationships dynamically. A clean run proves only that the tested execution exposed no race to the tool. It cannot establish that every possible execution is race-free, and it does not diagnose a logically insufficient relaxed ordering when all accesses are atomic.

## Happens-before

Within one thread, **sequenced-before** orders evaluations according to the rules from Chapter 3. If evaluation `A` is sequenced before `B`, `A` completes before `B` begins in the abstract machine. Sequenced-before never crosses a thread boundary.

**Synchronizes-with** supplies cross-thread edges. Common examples include:

- A release store and an acquire load that reads its value or its release sequence.
- An unlock of a mutex and a later successful lock of that mutex.
- Starting a thread and the beginning of its function.
- A thread's completion and a successful `join()` that observes it.

At working precision, **happens-before** is the transitive closure of sequenced-before and synchronizes-with. If `A` is sequenced before `B`, or `A` synchronizes with `B`, or those edges form a chain from `A` to `B`, then `A` happens before `B`.

Keep the model's relations separate:

| Relation | Scope | What creates it | What it answers |
|---|---|---|---|
| sequenced-before | one thread | language evaluation rules | Which evaluation precedes another locally? |
| synchronizes-with | between threads | an observing synchronization pair | Which operation publishes to which observer? |
| happens-before | whole execution | transitive chains of the first two | May conflicting ordinary accesses coexist race-free? |
| modification order | one atomic object | total order of that object's writes and RMWs | Which atomic write precedes another for this object? |
| coherence | one atomic object | consistency rules connecting reads and modification order | Which older or newer value may a load observe? |

```text
sequenced-before -----+
                      |
                      +---- transitive closure ----> happens-before
                      |
synchronizes-with ----+

modification order -----------------------------> one atomic object only
```

Modification order does not by itself publish unrelated data, and happens-before is not one global timestamp order. A relaxed counter has a modification order without creating cross-object happens-before edges. Section 7 develops coherence and release sequences after the ordering operations are in place.

The canonical publication pattern is one chain:

```text
Producer                                      Consumer
data = 42
    | sequenced-before                            ^
    v                                             | happens-before
ready.store(true, release)                        |
    |                                             |
    +--------- synchronizes-with ---------> ready.load(acquire) == true
                                                  |
                                                  | sequenced-before
                                                  v
                                              read data
```

In C++:

```cpp
int data = 0;
std::atomic<bool> ready{false};

void produce() {
    data = 42;  // sequenced-before the release
    ready.store(true, std::memory_order_release);
}

void consume() {
    if (ready.load(std::memory_order_acquire)) {
        int observed = data;  // data write happens-before this read
        assert(observed == 42);
    }
}
```

`data` itself need not be atomic because the happens-before chain orders its conflicting accesses. The release does not “make `data` atomic”; it publishes earlier effects to an acquire operation that observes the release.

Happens-before is transitive across more than two threads. If thread A releases state to an acquiring thread B, and B later releases another atomic observed by thread C, A's earlier state happens before C's later accesses. Many ownership handoffs are chains of the same two-thread publication edge.

The relation is not wall-clock time. An evaluation can physically execute early under speculation, provided the implementation prevents an observation forbidden by happens-before. Reason from the abstract edges, then use architecture details only to estimate cost.

**Pitfall.** The acquire load creates no edge when it reads `false`. Synchronization depends on which write the load observes, not merely on the presence of acquire and release keywords.

Release without a matching acquire also publishes to nobody. The ordering belongs to a communicating pair.

## Atomic types and operations

`std::atomic<T>` provides indivisible accesses and memory-order controls for a trivially copyable `T`, tying the requirement to object representation from Chapter 16. Atomic operations on one object never form a data race with one another.

Atomic does not necessarily mean lock-free. `is_lock_free()` reports the property for a particular object at runtime; `is_always_lock_free` reports whether every object of that specialization is lock-free on the target.

```cpp
using Price = std::uint64_t;
static_assert(std::atomic<Price>::is_always_lock_free);

struct BookImage {
    std::uint64_t words[4];
};

static_assert(std::atomic<BookImage>::is_always_lock_free);  // error: fails on typical targets
```

The `Price` assertion expresses a build requirement and may reject an unusual target. The oversized assertion is a deliberate diagnostic: many implementations accept `std::atomic<BookImage>` but implement its operations with library locks.

Lock freedom may also depend on address and ABI constraints, which is why the runtime query exists. `is_always_lock_free == true` guarantees the runtime query is true for every object of that specialization; `false` means “not guaranteed,” not necessarily “always locked.”

**Pitfall.** A type that is trivially copyable is eligible for `atomic`; that does not promise a lock-free instruction. Put `is_always_lock_free` assertions on atomics whose hot-path latency depends on lock freedom.

### `std::atomic_ref`

`std::atomic_ref<T>` **(C++20)** applies atomic operations to an existing `T` object. It is useful when a shared-memory layout or ring-buffer slot must retain its plain field type, as in Chapter 26.

```cpp
struct Slot {
    alignas(std::atomic_ref<std::uint64_t>::required_alignment)
        std::uint64_t sequence = 0;
};

void publish_next(Slot& slot) {
    std::atomic_ref<std::uint64_t> sequence{slot.sequence};
    sequence.fetch_add(1, std::memory_order_release);
}
```

The referenced object must satisfy `required_alignment`. While any `atomic_ref` exists for an object, all concurrent accesses to that object must use `atomic_ref`; mixing a plain read with an atomic-ref write is still a data race.

### Loads, stores, exchanges, and read-modify-write operations

`load()` observes an atomic value. `store()` replaces it. `exchange()` atomically replaces it and returns the old value.

A **read-modify-write** operation, abbreviated RMW, reads and writes one indivisible atomic event. `fetch_add()`, `fetch_sub()`, `fetch_or()`, and `fetch_and()` are common RMWs. Integral atomics also provide compound assignments and increment operators.

| Operation family | RMW? | Default ordering | Typical x86 implementation |
|---|---:|---|---|
| `load()` | No | `seq_cst` | Ordinary load |
| `store()` | No | `seq_cst` | Ordinary or locked store sequence |
| `exchange()` | Yes | `seq_cst` | Locked exchange |
| `fetch_add()` and peers | Yes | `seq_cst` | Locked RMW |
| `compare_exchange_*()` | Yes on success | `seq_cst` | Locked compare-exchange |

Defaults are sequentially consistent. Explicit ordering appears as the final argument.

Three expressions that look similar have different semantics:

```cpp
std::atomic<int> counter{0};

void increment_three_ways() {
    counter = counter + 1;  // load then store: updates can be lost
    counter += 1;           // one seq_cst RMW
    counter.fetch_add(1, std::memory_order_relaxed);  // relaxed RMW
}
```

The first line's individual accesses are atomic, so it does not itself create a data race. It is not an atomic increment: two threads can load the same value and both store the same successor.

RMW operations return the value from before their modification:

```cpp
std::atomic<unsigned> next_sequence{0};

unsigned reserve_sequence() {
    return next_sequence.fetch_add(
        1, std::memory_order_relaxed);
}
```

Concurrent callers receive different old values. Each RMW reads the modification immediately preceding it, which serializes updates to this one atomic even under relaxed ordering.

`exchange(desired, order)` is also an RMW: it stores unconditionally and returns the prior value. CAS adds the condition needed when overwriting a value observed by another thread would be incorrect.

**Note.** `counter += 1` is convenient but uses the default `seq_cst` ordering. Spell `fetch_add()` when the chosen order is part of the design.

## Compare-exchange

Compare-and-exchange, usually called CAS, conditionally replaces an atomic value. `compare_exchange_weak(expected, desired)` compares the atomic with `expected`. On equality it stores `desired` and returns `true`; on failure it writes the actually observed value back into `expected` and returns `false`.

That update of `expected` drives the canonical retry loop:

```cpp
struct Node {
    int value;
    Node* next;
};

std::atomic<Node*> head{nullptr};

void push(Node* node) {
    Node* expected = head.load(std::memory_order_relaxed);
    do {
        node->next = expected;
    } while (!head.compare_exchange_weak(
        expected, node,
        std::memory_order_release,  // success publishes the node
        std::memory_order_relaxed   // failure only refreshes expected
    ));
}
```

On failure, `expected` already contains the new head, so the next iteration updates `node->next` without a separate load. The success ordering publishes all initialization of `node`. A consumer needs an acquire operation before dereferencing it.

This is only the insertion primitive. ABA and safe reclamation determine whether a complete lock-free stack is correct; both belong to Chapter 26.

`compare_exchange_weak` may fail **spuriously**: it can report failure even when the compared values are equal. That maps naturally to load-linked/store-conditional machines such as ARM, where an interrupt or competing cache event can invalidate the reservation.

| Variant | Spurious failure? | Hardware shape | In retry loop | One-shot attempt |
|---|---:|---|---:|---:|
| `compare_exchange_weak` | Yes | Exposes LL/SC failure | Preferred | Usually wrong |
| `compare_exchange_strong` | No | May retry LL/SC internally | Valid | Preferred |

Use weak CAS inside a loop that retries anyway. Use strong CAS when a false result has standalone meaning and the caller will not retry.

CAS takes separate success and failure orderings because the two paths perform different operations:

| Path | Atomic action | What its ordering may need |
|---|---|---|
| Success | Read old value and write desired value | Acquire observed state; release new state |
| Comparison failure | Read observed value into `expected` | Acquire only if later code dereferences observed state |
| Spurious failure | No write; `expected` remains usable | Same load-side requirement |

In the stack push, failure only supplies a pointer that is copied into `node->next`; it does not dereference published node state. `relaxed` is therefore sufficient. A pop loop that dereferences the head after a successful CAS usually needs acquire semantics on success.

**Pitfall.** Do not reload `expected` after a failed CAS. The operation refreshed it; an extra load wastes work and can break algorithms whose progress argument uses the exact observed value.

The failure ordering cannot be `memory_order_release` or `memory_order_acq_rel`, because failure performs no write to release. Use the weakest failure order that covers what the failed comparison's observed value will be used to do.

## The ordering ladder — centerpiece

An atomic operation's `std::memory_order` controls how non-atomic and atomic operations around it may be observed across threads. The orderings form a practical ladder from atomicity alone to a global agreement, although acquire and release govern opposite directions rather than being strictly stronger than each other.

| Ordering | Guarantee | Reordering still allowed | Typical x86 cost | Typical ARM cost | Canonical use |
|---|---|---|---|---|---|
| `relaxed` | Atomicity; per-object coherence | No cross-object ordering | Plain load/store; locked RMW | Plain load/store; atomic RMW sequence | Statistics, unique tickets |
| `acquire` | Later operations stay after a load | Earlier operations may move later | Plain load | Acquire load such as `ldar` | Consume publication |
| `release` | Earlier operations stay before a store | Later operations may move earlier | Plain store | Release store such as `stlr` | Publish initialized state |
| `acq_rel` | Acquire and release around an RMW | No unrelated global order | Locked RMW | Acquire/release RMW sequence | Transfer ownership/state |
| `seq_cst` | Acquire/release plus one total order for all SC operations | Weaker operations remain outside that order | Loads often plain; stores use exchange/fence strategy | Acquire/release instructions plus barriers as needed | Multi-flag protocols |

These are typical mappings, not standard requirements. The compiler may choose different instructions, and an RMW must still obtain exclusive ownership of its cache line under every ordering.

Two distinct costs hide behind one ordering name:

- The compiler must preserve the abstract ordering, which can block instruction scheduling and common-subexpression optimizations.
- The generated instructions must constrain the processor, which may require an ordered instruction, a locked RMW, or a fence.

x86's ordinary load/store instructions already satisfy acquire/release hardware ordering, but they do not erase the compiler constraint. ARM exposes weaker ordinary ordering and therefore commonly uses distinct acquire and release instructions.

Choose an order by naming the required edge:

1. Use `relaxed` when only this atomic object's value and modification order matter.
2. Use a release/acquire pair to publish earlier state to one or more consumers.
3. Use `acq_rel` for an RMW that both consumes published state and publishes state onward.
4. Use `seq_cst` when operations on independent atomics must share one globally agreed order.

If the proof does not fit one of those statements, keep `seq_cst` and simplify the protocol before weakening it.

### Relaxed ordering

`memory_order_relaxed` guarantees indivisibility and the per-object coherence rules. It creates no synchronizes-with edge and orders no other memory location.

```cpp
std::atomic<std::uint64_t> quote_hits{0};

void record_hit() {
    quote_hits.fetch_add(1, std::memory_order_relaxed);
}
```

Every increment participates in `quote_hits`'s modification order, so none is lost. Nothing about that increment publishes adjacent quote data. This makes relaxed ordering appropriate for a statistic whose final value matters but whose relationship to other state does not.

Relaxed operations also allocate unique tickets:

```cpp
std::uint64_t next_ticket() {
    static std::atomic<std::uint64_t> ticket{0};
    return ticket.fetch_add(1, std::memory_order_relaxed);
}
```

The returned values are distinct. Their relationship to work performed before or after the call needs a separate ordering mechanism.

A relaxed publication flag is broken:

```cpp
int payload = 0;
std::atomic<bool> published{false};

void broken_writer() {
    payload = 42;
    published.store(true, std::memory_order_relaxed);
}

void broken_reader() {
    if (published.load(std::memory_order_relaxed)) {
        std::cout << payload;  // data race: no happens-before edge
    }
}
```

If the reader touches `payload` concurrently, the program has UB, not merely permission to print a stale value. Making `payload` atomic would remove the race but would still allow the reader to observe its old value.

**Pitfall.** “x86 is strong” does not turn relaxed publication into acquire/release. The compiler follows the C++ ordering, and x86 store buffers still permit important hardware reorderings.

### Acquire and release ordering

A release operation prevents earlier operations in its thread from being reordered after it in the abstract execution. An acquire operation prevents later operations from being reordered before it. When an acquire reads from a release or its release sequence on the same atomic object, the release synchronizes with the acquire.

```cpp
void correct_writer() {
    payload = 42;
    published.store(true, std::memory_order_release);
}

void correct_reader() {
    if (published.load(std::memory_order_acquire)) {
        std::cout << payload << '\n';  // prints: 42
    }
}
```

This is the message-passing diagram from the happens-before section. A release makes prior writes visible specifically to a matching acquirer; an acquire makes subsequent reads observe the state ordered before that release.

An RMW that both consumes earlier state and publishes later state commonly uses `memory_order_acq_rel`. It performs an acquire for its read half and a release for its write half.

**Rule.** Justify acquire/release as a pair: name the atomic object, the value read, and the ordinary accesses connected by the resulting happens-before chain.

### Sequential consistency

`memory_order_seq_cst` includes acquire or release behavior appropriate to the operation. It additionally places every sequentially consistent operation and fence into one total order, conventionally called `S`, consistent with the required ordering constraints. All threads agree on that order.

The store-buffering test changes only its orderings:

```cpp
std::atomic<int> sc_x{0};
std::atomic<int> sc_y{0};
int sc_r1 = -1;
int sc_r2 = -1;

void first_thread() {
    sc_x.store(1, std::memory_order_seq_cst);
    sc_r1 = sc_y.load(std::memory_order_seq_cst);
}

void second_thread() {
    sc_y.store(1, std::memory_order_seq_cst);
    sc_r2 = sc_x.load(std::memory_order_seq_cst);
}

// sc_r1 == 0 && sc_r2 == 0 is impossible
```

If both loads read zero, `S` would require each load to precede the other thread's store. Each thread's store must also precede its load. Those four constraints form a cycle, which no total order can contain.

Acquire/release is insufficient here. If each acquire load reads zero, it observes neither release store, so no synchronizes-with edge forms. The both-zero result remains allowed.

Sequential consistency is the correct default until a proof identifies a weaker sufficient order. It is specifically needed for protocols where independent atomic locations must participate in one order: Dekker-style mutual flags, global phase decisions, and tests where readers must agree on the order of unrelated writes.

Only `seq_cst` operations participate in `S`. Mixing a relaxed store into an otherwise sequentially consistent protocol does not quietly promote that store into the total order. Mixed-order proofs must account for both `S` and each object's modification order, which is why an all-`seq_cst` starting point is easier to audit.

On x86, acquire loads and release stores usually use the same instructions as relaxed operations; compiler ordering still differs. Sequentially consistent stores commonly use a locked exchange or a fence strategy that drains the store buffer. On ARM, acquire and release already select ordered load/store instructions, while sequential consistency may require stronger barrier placement.

### Consume ordering

`memory_order_consume` was intended to order only operations dependent on a loaded value. A loaded pointer naturally carries an address dependency into a later dereference, which some processors can preserve more cheaply than a general acquire.

**Note.** Mainstream compilers have long promoted consume to acquire, and `memory_order_consume` is deprecated **(C++26)**. Recognize its dependency-ordering intent in interviews; do not introduce it into production code.

## Coherence, modification order, and release sequences

Every atomic object has its own **modification order**, a total order of all modifications to that object. Even relaxed operations participate. Two threads may disagree about the relative order of writes to different atomics, but they agree on the order of writes to one atomic.

The coherence requirements constrain observations of one object:

- Write-write: happens-before-ordered writes retain that order in modification order.
- Read-read: happens-before-ordered reads cannot observe the object's writes going backward.
- Read-write: a read before a write cannot take its value from that write or a later one.
- Write-read: a read after a write observes that write or a later one.

The practical rule is simpler: an individual thread does not watch one atomic object's history reverse. Relaxed removes cross-object ordering, not single-object coherence.

```cpp
std::atomic<unsigned> version{0};

void observe_twice() {
    unsigned first = version.load(std::memory_order_relaxed);
    unsigned second = version.load(std::memory_order_relaxed);
    assert(second >= first);  // valid if writers only increment version
}
```

The assertion relies on writers never wrapping or storing lower values. Read-read coherence prevents the second sequenced load from observing a modification earlier than the one observed by the first. It says nothing about a separate `generation` atomic.

A **release sequence** is a contiguous subsequence of one atomic's modification order. It starts with a release operation, and every later member is an RMW until a non-RMW breaks the sequence. Those RMWs may be performed by any thread.

An acquire operation that reads a value from any member of the release sequence synchronizes with its head. Reference counting uses this transitive handoff:

```cpp
struct Resource {
    int handle;
};

struct Control {
    std::atomic<std::size_t> references{1};
    Resource resource;
};

void release(Control* control) {
    if (control->references.fetch_sub(
            1, std::memory_order_acq_rel) == 1) {
        // Release publishes this owner's prior effects.
        // Acquire observes effects published by earlier decrements.
        delete control;
    }
}
```

Each RMW reads the immediately preceding value in modification order. Release semantics publish effects before an owner drops its reference; the final decrement's acquire semantics make prior published effects visible before destruction.

Reference counting does not make concurrent unsynchronized writes to the managed object safe. It orders ownership bookkeeping and destruction after otherwise race-free uses.

An equivalent optimized shape makes every decrement a release and pays for acquire only on the path that reaches zero:

```cpp
void release_optimized(Control* control) {
    if (control->references.fetch_sub(
            1, std::memory_order_release) == 1) {
        std::atomic_thread_fence(std::memory_order_acquire);
        delete control;
    }
}
```

**Note.** Standard-library reference-count implementations, including libstdc++ variants, use this release-decrement/acquire-fence idea with implementation-specific fast paths. The fence is useful only because the zero-producing RMW read the preceding release sequence.

**Pitfall.** A purely relaxed final decrement does not acquire effects released by previous owners before invoking destruction.

## Fences

`std::atomic_thread_fence(order)` creates ordering without itself reading or modifying an atomic object. A fence still needs an atomic operation to carry communication between threads.

Three patterns are worth naming precisely:

- **Fence-atomic:** a release fence sequenced before atomic write `X` synchronizes with an acquire read that reads `X`.
- **Atomic-fence:** a release write `X` synchronizes with an acquire fence sequenced after an atomic read that reads `X`.
- **Fence-fence:** a release fence before write `X` synchronizes with an acquire fence after a read of `X`.

For fence-fence synchronization, the write and read may be relaxed. The read must observe the write or a suitable later member of its release sequence; otherwise the fences have no connection.

A batch can use one fence around several relaxed operations:

```cpp
std::array<std::atomic<int>, 4> slots{};
std::atomic<bool> batch_ready{false};

void publish_batch(const std::array<int, 4>& values) {
    for (std::size_t i = 0; i < values.size(); ++i) {
        slots[i].store(values[i], std::memory_order_relaxed);
    }
    std::atomic_thread_fence(std::memory_order_release);
    batch_ready.store(true, std::memory_order_relaxed);
}

int consume_batch() {
    if (!batch_ready.load(std::memory_order_relaxed)) {
        return 0;
    }
    std::atomic_thread_fence(std::memory_order_acquire);
    return slots[0].load(std::memory_order_relaxed);
}
```

The relaxed flag store and load carry the value between the fences. If the load reads `true` from that store, the release fence synchronizes with the acquire fence, ordering all earlier slot stores before all later slot loads. Without that reads-from relationship, an isolated fence publishes nothing.

Fences can reduce instruction-level ordering cost when many operations share one publication point. They also spread the proof across more lines: moving the carrier store above the release fence, or moving a payload load above the acquire fence, destroys the intended edge. Prefer acquire/release directly on the flag unless batching has a measured benefit.

| Mechanism | Stops compiler motion? | Stops CPU motion? | Scope | Typical use |
|---|---:|---:|---|---|
| `atomic_thread_fence` | Yes | When target requires | Between threads | Fence-atomic publication |
| `atomic_signal_fence` | Yes | No | Thread and its signal handler | Signal-visible state |
| `asm volatile("" ::: "memory")` | Yes | No | Compiler extension | Low-level compiler barrier |
| CPU fence instruction | With compiler wrapper | Yes | Hardware cores/devices | Platform synchronization |

`std::atomic_signal_fence` constrains compiler reordering between a thread and a signal handler executing in that thread. It emits no inter-core synchronization and does nothing for another CPU.

GCC and Clang's empty `asm volatile` with a `"memory"` clobber is a compiler barrier, not portable C++. Instructions such as x86 `mfence` and ARM `dmb` constrain processor ordering. Their microarchitectural behavior belongs to *Computer Architecture and Performance Engineering*.

**Pitfall.** A fence does not flush coherent caches. It constrains order; the coherence system propagates ownership and values according to the required order.

## Safe publication patterns

**Safe publication** makes a fully initialized object reachable by another thread through a happens-before edge:

1. Construct and initialize the object completely.
2. Store its pointer or a readiness flag with release semantics.
3. Load that pointer or flag with acquire semantics.
4. Use the object only after the acquire observes the published value.

Publishing the pointer with relaxed ordering can expose a non-null address without publishing the pointee's earlier initialization.

### Double-checked locking

Double-checked locking keeps a read-mostly fast path outside a mutex. Its first check must be an acquire load, and publication must be a release store:

```cpp
struct Config {
    int max_order_size;
};

std::atomic<Config*> current_config{nullptr};
std::mutex config_mutex;

Config& get_config() {
    Config* config =
        current_config.load(std::memory_order_acquire);
    if (config != nullptr) {
        return *config;
    }

    std::lock_guard lock{config_mutex};
    config = current_config.load(std::memory_order_acquire);
    if (config == nullptr) {
        config = new Config{10'000};
        current_config.store(config, std::memory_order_release);
    }
    return *config;
}
```

The second check matters because another thread may initialize the object while this thread waits for the mutex. The release publishes `max_order_size`; a fast-path acquire that sees the pointer can then read the field.

This one-line substitution breaks the fast path:

```cpp
Config* broken_fast_path() {
    // Non-null does not establish visibility of Config's initialization.
    return current_config.load(std::memory_order_relaxed);
}
```

A plain `Config*` is worse. Even though writers hold the mutex, an unlocked fast-path read conflicts with the write and creates a data race.

The example intentionally omits reclamation because the configuration lives until process shutdown. Non-static lifetimes require a safe reclamation design (Chapter 26).

Construction must occur before publication, not merely before the pointer store in source text. Writing fields through the published pointer afterward requires another synchronization protocol:

```cpp
void broken_mutation() {
    Config* config = new Config{10'000};
    current_config.store(config, std::memory_order_release);
    config->max_order_size = 20'000;  // races with readers
}
```

The release covers only operations sequenced before it. Treat a published object as immutable unless later mutations are independently synchronized.

**Rule.** Prefer a function-local `static` for ordinary lazy initialization. Magic statics already provide thread-safe one-time construction (Chapter 5); hand-written double-checked locking is for lifetimes that a static cannot express.

### Atomic shared pointers

`std::atomic<std::shared_ptr<T>>` **(C++20)** atomically replaces shared ownership. A reader can retain an immutable snapshot while a writer publishes a replacement:

```cpp
struct RiskConfig {
    int max_order_size;
};

std::atomic<std::shared_ptr<const RiskConfig>> risk_config{
    std::make_shared<const RiskConfig>(RiskConfig{10'000})
};

int current_limit() {
    auto snapshot = risk_config.load(std::memory_order_acquire);
    return snapshot->max_order_size;
}

void reload(RiskConfig next) {
    auto snapshot =
        std::make_shared<const RiskConfig>(std::move(next));
    risk_config.store(std::move(snapshot), std::memory_order_release);
}
```

Readers need no explicit mutex. The old `RiskConfig` remains alive until the last reader releases its copied `shared_ptr`, applying the ownership rules from Chapter 8.

This does not promise lock-free execution. A `shared_ptr` combines a managed pointer with control-block coordination, and `std::atomic<std::shared_ptr<T>>::is_lock_free()` is typically `false`. Snapshot replacement is suitable for configuration paths; tick-path publication needs the reclamation techniques in Chapter 26.

**Pitfall.** “Atomic shared pointer” describes semantics, not implementation cost. Measure it and query `is_lock_free()` before putting it on a latency-critical path.

## Litmus tests — flagship

A memory-model **litmus test** is a tiny concurrent program paired with a questioned outcome. Interviews use them because an answer must identify ordering edges, not repeat that one ordering is “stronger.”

Use this method:

1. Draw sequenced-before edges down each thread.
2. Add synchronizes-with edges only for acquire operations that read matching releases.
3. Take the transitive happens-before closure.
4. Check data races and each atomic object's modification-order constraints.
5. For `seq_cst`, test whether one total order `S` can satisfy every observation.

If no happens-before, coherence, or `S` constraint forbids an atomic outcome, the C++ model may allow it. A particular processor can still be stronger.

“Allowed” does not mean a test loop must observe the result. Compiler choices, core placement, and hardware strength can make a legal outcome rare or absent on one machine. “Forbidden” is the portable statement: no conforming execution of the defined program may produce it.

Litmus variables holding result registers, such as `sb_r1`, are written by one worker and inspected only after `join()` or a barrier in a runnable harness. The small thread functions below focus on the operations under test; the surrounding synchronization must sit outside the tested interval.

### Message passing

This version keeps `message` atomic so every row in the table is defined:

```cpp
std::atomic<int> message{0};
std::atomic<bool> message_ready{false};
int observed_message = -1;

void mp_writer(std::memory_order flag_order) {
    message.store(42, std::memory_order_relaxed);
    message_ready.store(true, flag_order);
}

void mp_reader(std::memory_order flag_order) {
    if (message_ready.load(flag_order)) {
        observed_message =
            message.load(std::memory_order_relaxed);
    }
}

// Question: message_ready was true, but observed_message == 0?
```

| Outcome | Relaxed flag | Release/acquire flag | `seq_cst` flag | Why |
|---|---:|---:|---:|---|
| Ready `true`, message `0` | Allowed | Forbidden | Forbidden | Acquire reading release orders message store before load |
| Ready `true`, message `42` | Allowed | Allowed | Allowed | Consistent with every ordering |

With relaxed flag operations, the two atomic objects have separate modification orders and no cross-object edge. With release/acquire, the ready store synchronizes with the load that reads `true`, placing the earlier message store before the later message load.

If `message` were an ordinary `int`, the relaxed first row would be UB due to a data race. Release/acquire would make the ordinary accesses race-free.

### Store buffering

Parameterize the store and load order separately because acquire is invalid for a pure store and release is invalid for a pure load:

```cpp
std::atomic<int> sb_x{0};
std::atomic<int> sb_y{0};
int sb_r1 = -1;
int sb_r2 = -1;

void sb_first(std::memory_order store_order,
              std::memory_order load_order) {
    sb_x.store(1, store_order);
    sb_r1 = sb_y.load(load_order);
}

void sb_second(std::memory_order store_order,
               std::memory_order load_order) {
    sb_y.store(1, store_order);
    sb_r2 = sb_x.load(load_order);
}

// Question: sb_r1 == 0 && sb_r2 == 0?
```

| Outcome | Relaxed | Release stores/acquire loads | `seq_cst` | Why |
|---|---:|---:|---:|---|
| `(r1, r2) = (0, 0)` | Allowed | Allowed | Forbidden | Zero reads form no acquire/release edges; SC total order would cycle |
| `(r1, r2) = (1, 0)` | Allowed | Allowed | Allowed | One thread observes the other's store |
| `(r1, r2) = (1, 1)` | Allowed | Allowed | Allowed | Both stores become visible first |

Release/acquire does not ban both zero because neither acquire reads a release value. Sequential consistency adds the missing global constraint.

### Independent reads of independent writes

IRIW asks whether readers can disagree about the order of two independent writes:

```cpp
std::atomic<int> iriw_x{0};
std::atomic<int> iriw_y{0};
int iriw_r1, iriw_r2, iriw_r3, iriw_r4;

void write_x(std::memory_order order) {
    iriw_x.store(1, order);
}
void write_y(std::memory_order order) {
    iriw_y.store(1, order);
}
void read_x_then_y(std::memory_order order) {
    iriw_r1 = iriw_x.load(order);
    iriw_r2 = iriw_y.load(order);
}
void read_y_then_x(std::memory_order order) {
    iriw_r3 = iriw_y.load(order);
    iriw_r4 = iriw_x.load(order);
}

// Question: (r1, r2, r3, r4) == (1, 0, 1, 0)?
```

| Outcome `(r1,r2,r3,r4)` | Relaxed | Release/acquire | `seq_cst` | Why |
|---|---:|---:|---:|---|
| `(1,0,1,0)` | Allowed | Allowed | Forbidden | Acquire/release gives no order between independent writes |
| `(1,1,1,1)` | Allowed | Allowed | Allowed | Both readers observe both writes |

In the questioned outcome, the first reader sees `x` but not `y`; the second sees `y` but not `x`. Acquire reads of the value `1` synchronize with their corresponding release stores, but no edge orders the two writers relative to each other.

Under `seq_cst`, the observations require a cycle in `S`: write `x` before the first reader, that reader before write `y`, write `y` before the second reader, and that reader before write `x`. The single total order forbids the cycle.

**Interview.** For a litmus test, never answer from a guessed wall-clock interleaving. State which reads-from choices create synchronizes-with edges, derive happens-before, then apply modification order and the `seq_cst` order.

## Tearing, alignment, and `volatile`

**Tearing** occurs when another observer sees pieces of one logical value from different writes. The C++ model gives no atomicity guarantee to an ordinary object involved in a race, regardless of the instructions a familiar processor usually emits.

A logical 64-bit value manually split into two locations illustrates the hardware failure:

```cpp
struct SplitPrice {
    std::uint32_t low;
    std::uint32_t high;
};

SplitPrice price{};

void update_price() {
    price.low = 0xAAAAAAAA;
    price.high = 0xBBBBBBBB;
}

std::uint64_t read_price() {
    return (static_cast<std::uint64_t>(price.high) << 32)
         | price.low;  // UB when concurrent with update_price()
}
```

A reader could conceptually combine the new low half with the old high half. At language level the concurrent accesses race, so UB is the stronger conclusion.

Aligned pointer-sized loads and stores commonly compile to single instructions on x86, but that implementation fact does not legalize a C++ race. A wide or misaligned access can require multiple instructions. An access straddling a cache-line boundary can also lose the hardware's ordinary single-access atomicity.

Atomic accesses prevent tearing relative to other atomic accesses to the same object even when the implementation must take a hidden lock. Lock-free and atomic are different promises: lock-free describes progress and implementation strategy; atomic describes indivisible observable behavior.

`std::atomic<T>` gives its object the alignment required by its implementation. `std::atomic_ref<T>` instead places the alignment obligation on the referenced object through `required_alignment`. `alignas` from Chapter 16 can enforce a stronger boundary.

Alignment does not isolate cache lines. Two distinct atomics may be race-free yet share one line, causing the line to bounce between writers. Chapter 26 applies padding to the SPSC ring buffer to address this false-sharing cost.

### `volatile` is not synchronization

C++ `volatile` tells the implementation that accesses are observable side effects that must not simply be removed or merged like ordinary accesses. It is intended for implementation-defined memory-mapped I/O and narrow language facilities such as `volatile std::sig_atomic_t` communication with a signal handler.

Even for memory-mapped I/O, register width, barriers, and device-ordering requirements are platform contracts. `volatile` supplies only the compiler-visible access behavior required by that contract; it does not manufacture the necessary CPU or device fence.

It provides no atomicity, no happens-before edge, and no exemption from the data-race rule:

```cpp
volatile bool stop = false;

void request_stop() {
    stop = true;
}

void poll() {
    while (!stop) {  // still a data race when threads call both functions
    }
}
```

This code can appear to work on x86 and remains UB. Java and C# assign inter-thread semantics to their `volatile` keywords; C++ does not.

| Property | `volatile` | `std::atomic` |
|---|---:|---:|
| Prevents tearing | No | Yes, among atomic accesses |
| Orders other operations | No | According to `memory_order` |
| Makes concurrent access race-free | No | Yes, if all conflicting accesses are atomic |
| Intended use | MMIO, signal rules | Inter-thread communication |
| Necessarily lock-free | Not applicable | No |

`volatile` may be combined with platform-specific device-access rules, but those rules come from the implementation and hardware, not the C++ thread memory model.

**Rule.** Use atomics or locks for threads. Never repair a polling race by adding `volatile`.

## Latency Lens

- On x86, acquire loads and release stores normally use plain load/store instructions; the ordering still constrains compiler motion.
- A `seq_cst` store on x86 commonly uses locked exchange or a fence strategy, draining buffered stores; ARM may need stronger barrier placement.
- A contended `fetch_add` or CAS transfers exclusive ownership of its cache line between cores; the coherence round-trip dominates the arithmetic.
- `compare_exchange_weak` exposes LL/SC failure to an existing retry loop, avoiding the nested retry that strong CAS may require on ARM.
- A relaxed counter uses the weakest RMW ordering, but a heavily updated counter still bounces its cache line.
- Sequenced-before and synchronizes-with compose into happens-before, while modification order remains per atomic object; confusing those scopes invents edges the program does not have.
- One release fence can publish a batch of relaxed stores when one atomic carrier value connects it to the reader's acquire side.
- An oversized `atomic<T>` may call a hidden lock; `is_always_lock_free` turns that latency surprise into a build failure.
- `atomic<shared_ptr<T>>` is typically not lock-free and also updates shared ownership state; reserve it for control and configuration paths.
- Proper alignment prevents a hot atomic from straddling a cache line, while separating independently written atomics prevents false-sharing bounces.
