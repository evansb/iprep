# Chapter 14 — The C++ Memory Model and Atomics

Concurrent code is not defined by what one processor happened to execute during a test. It is defined by relations among evaluations: which operations conflict, which atomic value a load may observe, and which writes become ordered before which reads. Atomics solve two separate problems—indivisible access and interthread ordering—and using one does not imply the other. This chapter builds the C++ model from data races through publication, then connects it carefully to the instructions commonly emitted on x86-64 and ARM64.

## 14.1 Threads of Execution and Conflicting Actions

A **thread of execution** is a sequence of evaluations in a C++ program. Every thread has its own sequenced-before order: if evaluation A is sequenced before evaluation B, A occurs earlier than B within that thread according to the abstract machine.

Two evaluations **conflict** when one starts or ends the lifetime of a memory location or modifies it, and the other reads, modifies, or changes the lifetime of the same overlapping memory location. Two reads do not conflict. A read and a write do. Two writes do.

The relevant unit is a **memory location**, not necessarily a C++ object. Separate non-bit-field scalar objects generally occupy separate memory locations. Adjacent bit-fields can share one memory location, so independently updating them from different threads can conflict. Conversely, two different array elements are distinct memory locations even when they occupy the same cache line.

```cpp
struct State {
    int bid;              // one memory location
    int ask;              // another memory location
    unsigned live : 1;    // these adjacent bit-fields may share
    unsigned halted : 1;  // one memory location
};
```

Conflicts are a language concept. False sharing is a hardware cost. Two threads writing `bid` and `ask` can be data-race-free if each has exclusive ownership, yet still transfer their shared cache line between cores. Two threads writing the bit-fields without synchronization can have a data race even if the processor supports a suitably sized store.

Thread creation and joining establish library-defined ordering. Actions sequenced before constructing a `std::thread` are visible to the new thread according to the thread-start synchronization rules; completion of a thread synchronizes with a successful `join`. These relations make ordinary data safe at the boundary. Long-lived trading threads usually communicate repeatedly, so they require mutexes, atomics, queues, or another synchronization protocol after startup.

Object lifetime participates in conflicts. Reusing storage for a new object while another thread may still read the old object is not merely a stale-value problem; ending and beginning lifetimes can conflict with that access. Lock-free structures therefore need reclamation in addition to atomic pointer updates. An atomic head protects the head value, not the lifetime of the node to which it points.

## 14.2 Data Races as Undefined Behavior

A **data race** occurs when two potentially concurrent evaluations conflict, at least one is not atomic, and neither happens before the other. A C++ data race gives the program undefined behavior.

```cpp
// BROKEN: writer and reader can race on both objects.
struct Snapshot {
    int price;
    bool ready;
};

Snapshot snapshot;

void publish() {
    snapshot.price = 10125;
    snapshot.ready = true;
}

void consume() {
    if (snapshot.ready) {
        use(snapshot.price);
    }
}
```

It is not enough that a naturally aligned `bool` or `int` is written in one machine instruction. The compiler is allowed to assume that a well-defined program has no data race. It may cache a value in a register, combine accesses, remove repeated loads, or reorder independent operations. The hardware may also make stores visible to other cores in an order not anticipated by source-level reasoning.

`volatile` does not repair the example. In C++, `volatile` supports observable access to objects such as memory-mapped I/O; it does not make an access atomic and does not create a happens-before relation between threads.

The smallest correction uses an atomic flag to publish ordinary data:

```cpp
#include <atomic>

struct Snapshot {
    int price;
    std::atomic<bool> ready{false};
};

Snapshot snapshot;

void publish() {
    snapshot.price = 10125;
    snapshot.ready.store(true, std::memory_order_release);
}

void consume() {
    if (snapshot.ready.load(std::memory_order_acquire)) {
        use(snapshot.price); // safe: release/acquire orders this read
    }
}
```

ThreadSanitizer can detect many executed data races:

```bash
clang++ -std=c++23 -O1 -g -fsanitize=thread race.cpp -pthread
./a.out
```

Absence of a report is not proof. A test exercises only some schedules, and ThreadSanitizer does not model every custom synchronization mechanism. Code review must establish the ordering proof for every shared non-atomic access.

## 14.3 Atomicity Versus Ordering

**Atomicity** means an operation on an atomic object participates indivisibly in that object's modification order. **Ordering** constrains how operations on other memory locations relate across threads. They are independent properties.

An atomic relaxed counter provides atomicity without publishing surrounding data:

```cpp
std::atomic<std::uint64_t> messages{0};

void count_one() {
    messages.fetch_add(1, std::memory_order_relaxed);
}
```

No increments are lost, and all modifications of `messages` have one modification order. The operation says nothing about when payload writes by the counting threads become visible to a thread that reads the counter.

A mutex supplies both properties for operations inside its critical section. Unlocking a mutex synchronizes with a later successful lock on the same mutex, ordering ordinary data protected by it. Atomics expose smaller ordering primitives and can avoid kernel blocking on some paths, but require an explicit ownership proof. Replacing a correct mutex with individually atomic fields can lose multi-field invariants even when every access remains indivisible.

Release and acquire operations add ordering. A release store prevents earlier operations in its thread from moving after the publication in the abstract machine. An acquire load that reads from the appropriate release prevents later operations from moving before the observation and makes prior writes happen before those later reads.

The distinction drives API design. A statistics counter generally needs atomicity only. A queue index that transfers ownership of initialized storage needs publication ordering. An atomic variable can serve both roles, but its memory order must match the protocol.

Atomicity also does not mean cheapness. A relaxed load of a lock-free atomic often resembles an ordinary load. A read-modify-write (RMW) such as `fetch_add` must obtain exclusive ownership of the cache line. Under contention, the line moves among cores and serializes progress even though the memory order is relaxed. The source-level order got weaker; the coherence requirement did not disappear.

## 14.4 Modification Order and Visible Side Effects

Every atomic object has a single **modification order** containing all modifications of that object. Stores and successful RMW operations are modifications; loads are not. All threads must observe an order consistent with the C++ rules, although different atomic objects need not share one global order unless sequential consistency imposes additional constraints.

```text
atomic sequence:
initial 0 -> store 1 -> fetch_add (writes 2) -> exchange (writes 7)
             one modification order for this object
```

An atomic load's value is constrained by modification order, happens-before, and coherence requirements. Informal explanations often call the selected write the load's “visible side effect.” Modern standard wording expresses the rules through value computation, happens-before, and write-read coherence. The safe working rule is not “a load gets the latest wall-clock write,” because the model defines no universal wall clock across relaxed operations.

Four coherence requirements constrain one atomic object:

- **write-write:** if write A happens before write B, A precedes B in modification order;
- **read-read:** if load A happens before load B, B cannot observe a modification older than the one A observed;
- **read-write:** if load A happens before write B, the write observed by A precedes B;
- **write-read:** if write A happens before load B, B observes A or a later modification.

These rules permit optimized implementations while preventing an atomic object from appearing to run backward along an established happens-before path.

Modification order is per object. Suppose a writer stores `bid` then `ask`, both relaxed, and a reader loads them in the opposite order. Each atomic has a coherent history, but no cross-object rule forces the reader to see a matching pair. A snapshot requires a stronger protocol: a lock, seqlock-style validation, double-buffer publication, or a single atomic representation if one fits and is appropriate.

Initialization precedes modification order. Construct an atomic with the desired initial value before making it reachable by concurrent threads. Static-duration atomics can be constant-initialized when their initializer permits it. Dynamically allocating an atomic does not publish its address; the pointer still needs a thread-start edge, lock, release/acquire handoff, or another safe publication mechanism.

## 14.5 Happens-Before and Synchronizes-With

**Happens-before** is the central ordering relation that makes one evaluation's effects available to another. Within a thread, sequenced-before contributes to happens-before. Across threads, a **synchronizes-with** edge—created by a matching release/acquire pair or a library operation—can connect the two sides.

For the publication example:

```text
producer thread                         consumer thread

write payload
     |
     | sequenced-before
     v
flag.store(true, release) --reads-from-> flag.load(acquire)
                                            |
                                            | sequenced-before
                                            v
                                       read payload

write payload ----------- happens-before ----------> read payload
```

The acquire load synchronizes with the release store only when it reads the stored value or a value in the relevant release sequence. Merely using acquire and release on the same object is not enough if the load observes an older value.

Happens-before is transitive. If A happens before B and B happens before C, A happens before C. This lets queue stages pass ownership through several threads. The proof must show every link and object lifetime. A relaxed operation may sit inside the chain without breaking it if the surrounding protocol establishes the required relations.

Synchronization does not flush all caches as a separate language operation. C++ specifies observable order. The compiler selects instructions and the hardware coherence protocol supplies the behavior. Thinking in happens-before avoids inventing a fictitious global “flush to RAM,” which would be both inaccurate and slower than actual coherent communication.

A useful review technique writes the edge beside each shared field:

```text
slot.payload: producer-only -> release head -> acquire head -> consumer-only
slot.state:   atomic, modification order identifies ownership phase
```

If an ordinary read lacks a chain from its corresponding write, the design is incomplete.

## 14.6 Release Sequences

A **release sequence** lets an acquire operation synchronize through one or more atomic RMW operations rather than only with the original release write. Under the C++20 model, it is a maximal contiguous subsequence of an atomic object's modification order headed by a release operation, followed by atomic RMW operations.

```cpp
std::atomic<unsigned> tickets{0};
Payload payload;

// Thread A
payload = make_payload();
tickets.store(1, std::memory_order_release);

// Thread B: if this RMW reads 1, it extends the release sequence.
tickets.fetch_add(1, std::memory_order_relaxed);

// Thread C: if this reads the resulting 2, it acquires A's payload.
if (tickets.load(std::memory_order_acquire) == 2) {
    use(payload);
}
```

The RMW itself may be relaxed. Its position in modification order links the value read by Thread C to Thread A's release. This mechanism is important in reference counts, work handoff, and algorithms in which several threads update one atomic state.

Before C++20, the formal definition also allowed a contiguous run of writes by the thread that performed the release before the RMW tail. Code intended for current C++ should reason using the current definition and should not depend on an intervening plain store extending a release sequence.

Release sequences are precise and easy to misuse. The acquire must read a value written by an operation in the sequence. An intervening non-RMW store breaks the sequence. Wraparound or reused state values can make a value comparison insufficient to prove which modification was observed. Sequence counters should use enough width, explicit phases, or per-slot generations to avoid ambiguous reuse.

## 14.7 Sequential Consistency

**Sequential consistency** adds a single total order for all operations performed with `memory_order_seq_cst`, consistent with their required ordering and each thread's sequencing. It supplies a strong default model: reason as though all sequentially consistent atomic operations were interleaved in one order.

The default overloads of atomic operations are sequentially consistent:

```cpp
std::atomic<bool> halted{false};
halted.store(true); // memory_order_seq_cst
```

Sequential consistency does not turn a multi-operation algorithm into one transaction. Two loads from different atomics may still observe a combination produced by valid interleaving. It also does not repair a data race on an adjacent non-atomic object unless a proper happens-before edge orders that access.

Consider the store-buffering test, with `x` and `y` initially zero. Each thread stores one then loads the other. If all four operations are SC, both loads cannot return zero because no single SC order can place each load before the other thread's preceding store. Weakening all four to relaxed can admit that outcome. This small example shows why per-object coherence is weaker than a cross-object total order.

Mixing SC and weaker operations requires care. The single SC order contains only sequentially consistent operations. A relaxed operation remains outside that total order even though per-object modification order still constrains it. Textbook proofs that assume every atomic operation is SC cannot silently weaken selected operations.

SC may require stronger instructions or fences on weakly ordered processors. On x86-64, an SC load can often be an ordinary load, while an SC store needs an implementation strategy that participates in the required global order, commonly a locked instruction or a store plus fencing. Exact emission depends on compiler, target, and surrounding code. On ARM64, SC operations commonly use acquire/release instructions plus barriers where required by the compilation mapping.

Start with SC when developing a nontrivial algorithm unless a well-understood protocol permits weaker orders. Then weaken operations one at a time and document the proof. This is not merely a debugging strategy: the strongest correct version establishes a reference semantics against which performance and generated code can be compared.

## 14.8 Compiler Versus CPU Reordering

**Compiler reordering** changes instruction order while preserving the C++ abstract machine. **CPU reordering** changes when instructions become globally observable or complete while preserving the architecture's memory model. C++ memory orders constrain both through the compiler's target-specific mapping.

The compiler can move, merge, or remove ordinary loads and stores when the as-if rule permits. An acquire operation constrains later operations and a release operation constrains earlier operations in the necessary directions. It does not necessarily emit a standalone hardware barrier.

The CPU contains store buffers, speculative loads, out-of-order execution, and coherent caches. x86-64's TSO-like model forbids many observable reorderings but permits a later load to become visible before an earlier store to a different address. ARM64 permits more load/load, load/store, store/store, and store/load behaviors unless instructions or barriers impose ordering.

Three layers must not be conflated:

| Layer | Contract | Example tool |
|---|---|---|
| C++ | data races, happens-before, atomic orders | source review, ThreadSanitizer |
| compiler mapping | selected machine instructions and barriers | optimized assembly |
| CPU | architectural ordering and coherence | litmus tests, counters, vendor manuals |

Inline assembly with a `"memory"` clobber can act as a compiler barrier for GCC/Clang, but it does not necessarily emit a CPU barrier. Conversely, a hardware barrier hidden from the compiler may not stop compile-time movement. Portable C++ synchronization should use atomics and fences so the compiler knows both requirements.

Inspect emission on each supported target:

```bash
clang++ -std=c++23 -O3 -S -masm=intel atomic.cpp -o atomic-x86.s
clang++ -std=c++23 -O3 -S --target=aarch64-linux-gnu atomic.cpp -o atomic-arm64.s
```

Cross-compilation needs suitable headers and a sysroot for nontrivial programs. Compiler Explorer is also useful, but generated code is evidence about that compiler invocation, not the language guarantee.

## 14.9 `std::atomic<T>` and Lock Freedom

`std::atomic<T>` provides atomic operations on a cv-unqualified, trivially copyable `T` that meets the standard's construction and assignment requirements. The primary template is neither copyable nor movable as an atomic object. Specializations for pointers and integral types add operations such as arithmetic or bitwise RMWs.

An atomic object's size and alignment can exceed those of `T`. Its representation is implementation defined. Do not serialize an atomic object, copy its bytes as a synchronization operation, or place it in packed storage.

Atomic construction does not allocate as a language requirement. Operations on a non-lock-free specialization may enter a library routine with hidden shared state, however, so embedded storage is not proof of a syscall-free or nonblocking path. The five questions remain separate: object footprint, library indirection, contention, progress, and generated instructions.

`is_always_lock_free` is a compile-time property for a type and implementation. `is_lock_free()` reports the property for a particular atomic object at runtime:

```cpp
#include <atomic>
#include <cstdint>
#include <iostream>

int main() {
    std::atomic<std::uint64_t> sequence{0};
    std::cout << std::boolalpha
              << decltype(sequence)::is_always_lock_free << '\n'
              << sequence.is_lock_free() << '\n';
}
```

The C++ standard does not guarantee that a general atomic is lock-free. A non-lock-free implementation may call a runtime library and use locks. That can add blocking, priority inversion, process-local hidden state, and incompatibility with signal handlers or shared-memory IPC. Linkers may require an atomic support library for wide operations on some targets.

Even a lock-free atomic is not necessarily wait-free. A CAS loop may retry indefinitely under contention. A hardware atomic RMW may serialize a hot cache line. “Lock-free” describes a progress property of the operations' implementation; it is not a latency bound.

Check required atomic types at startup or compilation where the design depends on them:

```cpp
static_assert(std::atomic<std::uint64_t>::is_always_lock_free,
              "queue sequence requires lock-free 64-bit atomics");
```

This assertion reduces portability and should be paired with a documented deployment target or a correct fallback. It is preferable to silently assuming an ABI property in an interprocess queue.

## 14.10 Atomic Loads, Stores, Exchanges, and Fetch Operations

An atomic **load** reads a value without modifying the object. A **store** writes a value. `exchange` and `fetch_*` operations are RMWs: each atomically reads the preceding value and writes a new one without another modification intervening.

The allowed order categories follow the operation:

| Operation | Permitted orders |
|---|---|
| load | relaxed, consume, acquire, seq_cst |
| store | relaxed, release, seq_cst |
| RMW | relaxed, consume, acquire, release, acq_rel, seq_cst |

Using release or acquire-release for a load is invalid. Using consume, acquire, or acquire-release for a store is invalid. Prefer the named member functions and explicit order to make review straightforward.

Integral atomics provide `fetch_add`, `fetch_sub`, `fetch_and`, `fetch_or`, and `fetch_xor`; pointer atomics provide pointer arithmetic. C++ defines atomic signed integral arithmetic without undefined signed overflow for these operations, but an application-level sequence or price still needs an intentional wrap policy. Pointer results may be outside an array even though the arithmetic operation itself is defined; dereferencing such a pointer remains invalid.

```cpp
auto previous = write_index.fetch_add(1, std::memory_order_relaxed);
auto slot = previous & (capacity - 1); // valid mask only for power-of-two capacity
```

An RMW often maps to a locked instruction or exclusive-access loop. It requests write ownership even when the program only needs the returned count. If every thread increments one shared metric, coherence makes the line a serialization point. Per-thread counters with periodic aggregation exchange memory for lower contention.

False sharing can make a read-mostly atomic expensive even without logical contention. If a producer updates a neighboring field on the same line, a consumer's loads can repeatedly miss after invalidation. Separate hot writer-owned state when profiling confirms the problem; padding every atomic blindly enlarges working sets and can create additional cache and TLB pressure.

C++20 added `wait`, `notify_one`, and `notify_all` to atomic types. Their blocking behavior and implementation belong in Chapter 15. They do not change the memory order of the value operation: the load or wait order still needs to support the protocol.

## 14.11 Weak and Strong Compare-Exchange

**Compare-exchange** conditionally writes a desired value when the atomic currently equals an expected value. On success it is an RMW. On failure it performs a load and writes the observed value back into the caller's `expected` argument.

```cpp
bool claim(std::atomic<std::uint32_t>& state) {
    std::uint32_t expected = 0;
    return state.compare_exchange_strong(
        expected, 1,
        std::memory_order_acq_rel,
        std::memory_order_acquire);
}
```

If `claim` returns `false`, `expected` contains the value that prevented the transition. This output is useful for state machines and essential to understanding retry loops.

`compare_exchange_weak` may fail **spuriously**: it may report failure even when the value representation compared equal. That makes it appropriate in loops, where another attempt is already expected. `compare_exchange_strong` does not fail spuriously and is convenient for one-shot transitions.

Weak does not mean weaker memory ordering. Both variants accept the same success and failure orders. The difference is permission for spurious failure and, on load-linked/store-conditional architectures, potential code-generation strategy.

Before C++20, comparison was described in terms of object representations, which made padding and multiple representations subtle. Current wording uses value representation. Types with padding or multiple encodings can still make bespoke atomic-state designs awkward; compact integers or enums with controlled representations are easier to reason about.

CAS is optimistic. Under contention, several cores load the same old value, one succeeds, and the others retry after cache-line invalidation. A lock-free loop can therefore have poor tail latency. Measure retry counts and coherence traffic, not merely total operations per second.

## 14.12 CAS Failure, Expected-Value Updates, and Loops

A correct CAS loop treats `expected` as both input and output. It initializes the desired starting value once, recomputes the new value from each observation, and permits weak spurious failure:

```cpp
void update_max(std::atomic<std::uint64_t>& high,
                std::uint64_t candidate) {
    auto observed = high.load(std::memory_order_relaxed);
    while (observed < candidate &&
           !high.compare_exchange_weak(
               observed, candidate,
               std::memory_order_relaxed,
               std::memory_order_relaxed)) {
        // observed has already been replaced with the latest seen value.
    }
}
```

Reloading `observed` manually on every failure is unnecessary and can add work. Resetting it to the original value is usually a bug because it discards information returned by the failed CAS.

The loop above maintains only an independent statistic, so relaxed ordering suffices. A CAS that publishes ownership normally needs release on success; one that acquires ownership normally needs acquire; a transition that does both needs acquire-release. Failure performs no write, so it cannot have release semantics.

CAS loops face three practical hazards:

1. **contention:** repeated invalidations inflate work and tail latency;
2. **ABA:** a value changes from A to B and back to A, fooling a pointer-only comparison;
3. **lifetime:** a successfully observed pointer may refer to storage reclaimed by another thread.

Tagged counters address only some ABA cases and can wrap. Hazard pointers, epochs, or another reclamation scheme are required when object lifetime is at risk, as Chapter 17 explains.

Backoff can reduce simultaneous retries. On x86, a pause hint in a short spin loop can reduce pipeline and SMT penalties; ARM has corresponding wait/yield hints. Backoff changes fairness and latency, and parking introduces scheduler work. A fixed policy should be justified with the expected contention distribution.

## 14.13 C++20 `std::atomic_ref`

C++20 `std::atomic_ref<T>` applies atomic operations to an existing `T` object rather than embedding atomic type in the object's declaration. The reference object does not own the target. The target must remain alive for every operation.

```cpp
#include <atomic>
#include <cstdint>

alignas(std::atomic_ref<std::uint64_t>::required_alignment)
std::uint64_t shared_sequence = 0;

void increment() {
    std::atomic_ref<std::uint64_t> ref{shared_sequence};
    ref.fetch_add(1, std::memory_order_relaxed);
}
```

`T` must be trivially copyable and cv-unqualified except for the supported `const` case for read-only operations. The referenced object's address must satisfy `atomic_ref<T>::required_alignment`, which may be stricter than `alignof(T)`. Packed structures and arbitrary bytes from a wire buffer are therefore unsafe targets.

The access discipline is strict: while any `atomic_ref` instance exists for an object, all accesses to that object must be atomic, and atomic access must go through `atomic_ref` instances. The same restriction applies to overlapping subobjects. Mixing an atomic reference with a plain `std::uint64_t` access is therefore invalid even if a particular execution seems not to overlap. Different `atomic_ref` objects that refer to the same target share the same atomic modification order.

An `atomic_ref` is copyable, but copying it copies the reference, not the target. It can be lock-free or non-lock-free independently of assumptions about embedded atomics; query `is_lock_free()` and use `is_always_lock_free` when the deployment contract requires it.

The facility is useful for retrofitting atomic access into an aligned shared-memory layout or for operating atomically on selected elements of a numeric array. It does not make an on-disk format portable: size, alignment, lock freedom, endianness, process sharing, and crash semantics remain external contracts.

## 14.14 Relaxed, Acquire, Release, and Acquire-Release Ordering

`memory_order_relaxed` guarantees atomic access and per-object modification order, but creates no interthread synchronization. Use it for independent counters, unique ticket allocation when the ticket does not itself publish data, and fields whose ordering comes from another operation.

`memory_order_release` is used on stores or RMWs that publish earlier work. `memory_order_acquire` is used on loads or RMWs that consume published work. When an acquire reads from the release or its release sequence, the release synchronizes with the acquire.

An SPSC queue shows the asymmetry. The producer owns the slot until it publishes the new head. The consumer acquires the head before reading the slot:

```cpp
template<class T, std::size_t N>
struct SpscExcerpt {
    static_assert(N > 0);
    alignas(64) std::atomic<std::size_t> head{0};
    alignas(64) std::atomic<std::size_t> tail{0};
    std::array<T, N> slots;

    // Pseudocode excerpt: full/empty and lifetime details omitted.
};

// producer
slots[h % N] = message;                         // ordinary write
head.store(h + 1, std::memory_order_release);   // publish

// consumer
auto seen = head.load(std::memory_order_acquire);
if (t != seen) {
    consume(slots[t % N]);                      // ordinary read is ordered
}
```

The producer can usually load the consumer-owned tail with acquire when it must observe slot release; its own head load can be relaxed because only the producer writes it. Exact orders depend on the full ownership protocol, not on a blanket rule that all indices use acquire-release.

`memory_order_acq_rel` applies to an RMW that both acquires prior work and releases earlier work. It is invalid for a pure load or store. A successful queue state transition that takes ownership of an old node and publishes a new state can require both directions.

Memory orders primarily affect compiler freedom and architecture mapping. They do not change object size. They can change instruction count and pipeline cost, especially on weakly ordered machines, but contention and cache placement often dominate an RMW. Verify with assembly and counters on every supported architecture.

## 14.15 Sequential Consistency and Practical `consume` Behavior

`memory_order_seq_cst` combines acquire/release effects as applicable with participation in the single SC order. It is the default and the simplest order for cross-object reasoning. Its possible extra cost should be demonstrated, not presumed.

`memory_order_consume` was intended to order only operations dependent on a loaded value. For example, loading a published pointer would order dereferences whose addresses depend on that pointer while allowing unrelated operations more freedom. Formal dependency rules proved difficult to implement and use safely.

Mainstream compilers have historically treated consume as acquire in ordinary code generation. C++26 revises this area, but C++23 portable code should assume acquire-like treatment and should not depend on a performance difference. Use `memory_order_acquire` unless a toolchain-specific, carefully audited design has a compelling reason otherwise.

```cpp
Node* p = published.load(std::memory_order_acquire);
if (p != nullptr) {
    use(p->payload);
}
```

Manually manufacturing dependency tricks is fragile. Optimizers transform values, and operations such as `std::kill_dependency` relate to the language dependency model rather than providing a general hardware barrier. Acquire makes the intended publication explicit and portable.

When optimizing an SC design, first determine whether the algorithm needs a cross-object total order. If it needs only point-to-point publication, release/acquire may suffice. If it uses outcomes across several atomics to exclude a result, weakening can admit that result. Litmus tests document the question, but the proof must be made in the C++ model.

## 14.16 Legal CAS Success and Failure Orders

Compare-exchange accepts separate memory orders because success is an RMW and failure is only a load. The failure order must not contain release semantics and must not be stronger than the success order.

A practical legality table for C++23 is:

| Success order | Useful legal failure orders |
|---|---|
| relaxed | relaxed |
| consume | relaxed, consume |
| acquire | relaxed, consume, acquire |
| release | relaxed |
| acq_rel | relaxed, consume, acquire |
| seq_cst | relaxed, consume, acquire, seq_cst |

`memory_order_release` and `memory_order_acq_rel` are never legal failure orders because failure performs no store. Treat consume as acquire for practical compiler behavior, while retaining its formal place in the API.

The single-order overload derives a valid failure order: an `acq_rel` success uses acquire on failure; a release success uses relaxed on failure; other orders use the specified order. Explicit two-order overloads are clearer when a retry loop needs a relaxed failure path.

```cpp
state.compare_exchange_weak(expected, desired,
                            std::memory_order_release, // success publishes
                            std::memory_order_relaxed);// failure only observes
```

Compilers often warn about invalid constant orders, but a diagnostic is not a substitute for review. Encapsulate transitions in a small API so callers do not choose arbitrary orders. For a template taking an order, constrain or validate the combinations rather than forwarding invalid values to the standard library.

Order arguments are runtime enum values in the API, but many implementations optimize best when they are compile-time constants. More importantly, a runtime-selected order makes a proof configuration dependent. Hot-path abstractions should normally fix their synchronization contract in code; if configuration selects an algorithm, select between separately reviewed implementations rather than changing memory orders ad hoc.

Failure ordering affects what may safely be read after a failed CAS. If failure uses acquire and reads a value from a release sequence, it can acquire associated state. If it uses relaxed, the returned `expected` value may guide another atomic retry, but it does not publish non-atomic payload by itself.

## 14.17 x86-64 and ARM64 Ordering

x86-64 and ARM64 both provide coherent shared memory, but their architectural ordering differs. Portable C++ code states intent with memory orders and lets the compiler choose the mapping.

On x86-64, ordinary aligned loads and stores already have acquire- and release-like ordering for the common cases under the architecture's TSO model. Compilers therefore commonly emit the same `mov` instruction for relaxed and acquire loads, and the same `mov` for relaxed and release stores. This does not make a relaxed C++ operation acquire or release: the compiler ordering and language happens-before relation are still absent.

x86-64 permits store-to-load reordering to different locations through the store buffer. Locked RMW instructions such as `lock xadd` or `lock cmpxchg` obtain exclusive cache-line ownership and provide strong ordering. SC stores commonly need a locked operation or fencing strategy. Exact code depends on compiler and context.

ARM64 has a weaker model. A relaxed load/store commonly uses `ldr`/`str`; acquire and release commonly use `ldar`/`stlr`. RMWs may use load-linked/store-conditional loops (`ldxr`/`stxr` and ordered variants) or Large System Extension atomic instructions on CPUs and targets that support LSE. Sequentially consistent compilation can require additional ordering according to the mapping used.

| C++ operation | Common x86-64 shape | Common ARM64 shape |
|---|---|---|
| relaxed load | `mov` | `ldr` |
| acquire load | `mov` plus compiler constraint | `ldar` |
| relaxed store | `mov` | `str` |
| release store | `mov` plus compiler constraint | `stlr` |
| atomic RMW | locked instruction | LSE atomic or LL/SC loop |

This table is representative, not guaranteed assembly. Width, alignment, target features, compiler version, and surrounding operations change emission.

An algorithm tested only on x86 can appear correct while lacking a C++ synchronization edge. Moving it to ARM may expose the bug more readily, but the original program was already undefined or under-specified. Conversely, adding ad hoc ARM barriers does not repair a C++ data race because the compiler still lacks the required language contract.

Performance comparison must include cache-line topology. An uncontended acquire load can be cheap on either architecture; a contended RMW spanning sockets can be dominated by ownership transfer. Record CPU model, compiler flags, target features, affinity, and contention when benchmarking.

Verification needs several layers. First, compile tiny functions containing one operation and inspect whether the selected instruction matches the expected target mapping. Second, stress the complete protocol with randomized delays and ThreadSanitizer; this can reveal executed races and ownership mistakes. Third, pin realistic producers and consumers and measure retries, cycles, cache misses, and coherence-related events exposed by the CPU. None of the three replaces the source-level proof.

A useful benchmark compares equal semantics: SC against acquire/release for the same publication, or one shared RMW against per-thread relaxed counters plus aggregation. Reporting only the faster path while changing snapshot guarantees answers a different question. Include the uncontended case, expected contention, and an overload case because CAS retry distributions change nonlinearly as more writers arrive.

## 14.18 Fences, Compiler Barriers, and Hardware Barriers

`std::atomic_thread_fence` establishes ordering without itself reading or modifying an atomic object. A fence participates in synchronization only when connected through suitable atomic operations. A fence by itself does not broadcast ordinary writes or cure a data race.

A release-fence publication pattern uses a release fence before a relaxed atomic store; the consumer uses an acquire load that reads that value:

```cpp
// producer
payload = value;
std::atomic_thread_fence(std::memory_order_release);
ready.store(true, std::memory_order_relaxed);

// consumer
if (ready.load(std::memory_order_acquire)) {
    use(payload);
}
```

The standard's fence-atomic synchronization rule connects the release fence to the acquire load through the value written by the atomic store. The more direct `ready.store(..., release)` is usually easier to review and often emits equivalent code.

The dual pattern uses a release store, a relaxed load that reads it, and an acquire fence sequenced after the load. Fence-to-fence synchronization is also possible through an atomic value. These patterns are useful when one fence orders a batch of operations, but their proofs are less local. Keep the atomic carrier and reads-from condition explicit.

`atomic_signal_fence` constrains compiler movement with respect to signal handlers but need not emit a hardware barrier. `atomic_thread_fence` targets interthread ordering and maps to whatever compiler and CPU constraints are required. A GCC/Clang inline-assembly `"memory"` clobber is implementation-specific and generally only a compiler barrier.

Hardware barriers include x86 fence instructions and ARM64 `dmb` variants. Their scopes and ordering strengths are architecture-defined. Linux kernel barrier macros add further contracts for devices, DMA, and kernel concurrency. User-space C++ should not copy a kernel barrier recipe without understanding the different abstract machine.

Fences can inhibit compiler and processor overlap across many independent memory operations. Their pipeline cost varies with architecture, outstanding stores, and surrounding instructions. Measure a realistic protocol, not an isolated fence in an empty loop. Often the larger cost is the cache-line transfer caused by the atomic carrier.

Prefer ordering on the atomic operation that transfers ownership. Use fences when they materially simplify or optimize a proven multi-object protocol, and write the synchronization chain in a comment. If the proof needs the reader to guess which relaxed load observed which write, the design is not ready for a critical path.

Fence placement is also a code-size and maintenance decision. A single fence can order several relaxed stores, but it couples their proofs to one position and makes later refactoring hazardous. Operation-based release/acquire keeps semantics next to the carrier atomic. Choose a fence only when the batched relation is intentional, covered by a litmus test, and documented with the atomic modification that carries synchronization.

## 14.19 Interview Check

1. Define a data race in C++ and explain why an aligned machine-word store does not make a racy program valid.
2. A relaxed atomic counter never loses increments. Why can it still fail to publish a payload written before the increment?
3. Draw the happens-before chain for a release-store/acquire-load publication. What changes if the acquire load reads an earlier value?
4. What is a release sequence in C++20 and later, and which intervening operation breaks it?
5. Compare modification order with the single sequentially consistent order. Which is per object?
6. In a failed compare-exchange, what happens to `expected`, and why is release an illegal failure order?
7. Review an `acq_rel` success with `seq_cst` failure. Is it legal? Choose a legal failure order and explain what it provides.
8. State the lifetime, alignment, and access-discipline requirements for `std::atomic_ref`.
9. Why might relaxed and acquire loads compile to the same x86-64 instruction yet have different C++ semantics? What commonly changes on ARM64?
10. Compare an acquire/release atomic-operation protocol with an equivalent fence-based protocol. Which reads-from edge makes the fences effective?
