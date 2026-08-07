# Chapter 10 — Allocation and Allocator Design

An allocation call that usually takes a short fast path can occasionally acquire a lock, grow an arena, modify page tables, fault in physical memory, or trigger reclaim. That spread, rather than average allocator throughput, is the central issue in low-latency code. This chapter separates C++ allocation semantics from common allocator and Linux implementations, then develops arenas, pools, fixed-capacity storage, polymorphic resources, and explicit overflow policies. The goal is not to make every allocation faster. It is to decide which allocations may exist at all, when memory is committed, and what the program does when capacity is exhausted.

## 10.1 General-Purpose Allocation

A C++ **new-expression** obtains suitably aligned storage and constructs an object in it. A **delete-expression** destroys the object and releases its storage. Allocation and construction are separate semantic steps even when the source contains one expression.

```cpp
Order* order = new Order{id, price, quantity};
delete order;
```

The new-expression first selects an allocation function such as `operator new`, then initializes the object. If construction throws, the language invokes a matching deallocation function for the acquired storage. The delete-expression requires a pointer produced by a compatible allocation and applies destruction before deallocation. Mixing `new` with `free`, or `malloc` with `delete`, is undefined behavior.

The ordinary throwing allocation functions report failure with `std::bad_alloc`. Nothrow forms return null when allocation fails:

```cpp
Order* order = new (std::nothrow) Order{id, price, quantity};
if (order == nullptr) {
    return std::unexpected{SubmitError::out_of_memory};
}
```

Construction can still throw for reasons other than storage exhaustion, so `nothrow` does not make the entire expression non-throwing unless `Order` construction is also non-throwing. A production Linux process may additionally encounter overcommit: reserving virtual address space can succeed, while a later first write faults and cannot obtain physical backing. A null check at allocation time is not a complete memory-availability policy.

`malloc` returns raw storage suitable for any type whose required alignment does not exceed the implementation's fundamental alignment guarantee. It returns null on failure and does not construct objects. Since C++17, aligned allocation interfaces and over-aligned new-expressions support stricter alignment. Use `std::construct_at` and `std::destroy_at` when manually managing object lifetimes in raw C++ storage.

General-purpose allocation has no language-level constant-time guarantee. C++ specifies observable behavior, alignment, failure, and lifetime rules; it does not specify size classes, arenas, locks, or a growth algorithm. A warmed allocation served from a thread-local cache and an allocation that requests new mappings are both conforming.

Deleting a null pointer is a no-op, which makes ownership cleanup simple. Deleting any other invalid pointer—including a pointer into the middle of an allocation, one already deleted, or one obtained from another allocation family—is undefined behavior. The allocator may appear to detect the mistake in a debug run and silently corrupt metadata in production.

Classes can define class-specific `operator new` and `operator delete`, and a program can replace global forms subject to standard restrictions. This changes where storage comes from; it does not change constructor semantics. It also makes allocation behavior less visible at a call site. Prefer an explicit factory or allocator parameter when selecting a pool is part of the operational contract.

The important diagnostic question is not “how fast is `new`?” It is:

```text
request size/alignment
        |
        v
thread cache? -> central allocator? -> arena growth? -> mmap/brk?
        |              |                   |              |
        + metadata     + locks/atomics     + VM work      + page faults later
```

Trace the program on the target allocator and workload. Interposition profilers, heap profilers, eBPF probes, and `perf` can locate allocation sites, but instrumentation changes timing. Count operations first; benchmark their distribution second.

## 10.2 Array Cookies and Sized or Aligned Deletion

An **array cookie** is implementation metadata that can record how many elements an array new-expression constructed. C++ does not require a cookie or specify where one resides. An implementation needs enough information to destroy the right number of non-trivial elements when evaluating `delete[]`.

```cpp
Quote* quotes = new Quote[count];
delete[] quotes; // every constructed Quote must be destroyed
```

A common layout places metadata immediately before the pointer returned to the caller:

```text
implementation-dependent allocation
+----------+---------+---------+-----+---------+
| metadata | padding | Quote 0 | ... | Quote n |
+----------+---------+---------+-----+---------+
                      ^ pointer returned by new[]
```

Trivially destructible arrays may not need an element count, and an allocator can know the total allocation size by another mechanism. Never inspect bytes before the returned pointer. They are outside the array object and touching them is undefined behavior.

Compilers may call a **sized deallocation** overload such as `operator delete(void*, std::size_t)` when the relevant size is available. They may call an alignment-aware overload for an over-aligned type. Providing a replacement allocation function therefore requires a complete and correct family of matching forms for the program's use cases.

```cpp
struct alignas(64) CacheLineState {
    std::uint64_t sequence;
};

auto state = std::make_unique<CacheLineState>();
```

The C++ implementation selects an allocation satisfying the 64-byte alignment. The allocator may round the requested size upward, add metadata, and use a separate path for large alignment. Alignment prevents two chosen objects from sharing a line only when placement and array stride also cooperate; it does not magically isolate adjacent unrelated allocations.

Inspect calls after optimization rather than guessing:

```bash
g++ -std=c++23 -O2 -fsized-deallocation -S allocation.cpp
rg 'new|delete' allocation.s
```

Inlining, dead allocation elimination, and target ABI affect the result. The compiler may eliminate an allocation whose identity and side effects cannot be observed.

Arrays are often the wrong ownership interface for a bounded system. A `std::vector`, `std::unique_ptr<T[]>` plus explicit size, or a fixed-capacity aggregate makes length and invalidation easier to reason about. The hidden cookie is a reminder that source-level syntax can omit memory overhead.

## 10.3 Size Classes, Metadata, Caches, and Locks

A **size class** groups nearby allocation sizes into a common block size. General-purpose allocators commonly round a request to one class, serve small blocks from per-thread or per-CPU caches, obtain batches from central structures, and handle large requests with separate mappings. These are common designs, not requirements of `malloc` or C++.

For a request of 37 bytes, an allocator might reserve a 48- or 64-byte block. Metadata may live in a header beside the object, in a bitmap, or in page-level structures. The program's true footprint can therefore include:

- rounded block size;
- object alignment padding;
- per-block or per-span metadata;
- cached free blocks retained by threads;
- mapped but uncommitted pages; and
- resident pages no longer holding live payload.

The fast path is often a few pointer operations in a local free list. Refill can transfer a batch from a central cache and perform synchronization. Arena growth can create or extend mappings. Freeing to the originating thread may be cheap, while a cross-thread free may enqueue remotely or update shared state.

Locks are only one contention mechanism. A lock-free central free list still uses atomic read-modify-write operations and can bounce a cache line between cores. Metadata adjacent to user blocks can introduce cache pollution. Security hardening such as quarantines, checksums, guard regions, or randomized placement adds deliberate work.

Allocator behavior also depends on history. A benchmark that repeatedly allocates and frees one size on one thread measures a warmed cache, not process startup, a new size class, a burst, or a producer-consumer ownership pattern. Exercise at least:

- cold start and warmed steady state;
- the real size and alignment distribution;
- allocation bursts and high-water marks;
- same-thread and cross-thread frees;
- memory pressure and long runtimes; and
- the production allocator configuration.

Useful observations include allocation call counts, allocator-specific statistics, RSS, page faults, and lock or atomic contention. Do not infer live memory from RSS alone; retained allocator memory can remain resident after objects are freed.

Tail analysis needs a reason code as well as a timestamp. When an allocation sample is slow, determine whether it refilled a local cache, took a central lock, created a mapping, faulted, or ran under system memory pressure. Aggregating all sizes and paths into one histogram hides distinct mechanisms. At the same time, avoid logging synchronously from inside the allocator: recursion into formatting or allocation can deadlock or corrupt the measurement. Fixed per-thread counters and sampled events are safer.

Changing the process allocator through preload or link settings is an operational change. It can alter memory retention, fork behavior, signal safety, and interaction with third-party libraries. Validate startup, shutdown, thread exit, and failure injection in addition to throughput. A faster microbenchmark is not sufficient evidence for deployment.

## 10.4 Internal and External Fragmentation

**Internal fragmentation** is unused space inside an allocated block. **External fragmentation** is free space that exists but cannot satisfy a request because it is divided among unsuitable locations or spans. Both separate live payload from process footprint.

If a 33-byte object receives a 48-byte block, 15 bytes are internally unavailable to other allocations. Alignment can increase that waste. An object pool with 128-byte slots wastes 64 bytes for every 64-byte object even though lookup and allocation are predictable.

External fragmentation depends on allocation order and lifetime:

```text
time 1: [AAAA][BBBB][CCCC][DDDD]
time 2: [free][BBBB][free][DDDD]

Two free regions exist, but neither may satisfy one large contiguous request.
```

Virtual memory lets allocators map new regions, so physical adjacency is not always required for ordinary heap objects. Fragmented allocator spans can still retain many mostly empty pages, increasing RSS and TLB footprint. Large or aligned allocations may need different treatment.

Long-running trading systems often have several lifetime distributions: configuration objects live all day, sessions live minutes, orders live milliseconds to hours, and decode scratch data lives for one message. Mixing them in one allocation stream can strand storage. Regions or pools grouped by lifetime can release or recycle storage together.

Measure fragmentation with more than one number:

```text
live payload <= allocator active bytes <= resident allocator pages <= virtual mappings
```

Exact names differ among allocators. Also inspect `/proc/<pid>/smaps_rollup`, allocator statistics, and high-water behavior under a replay of realistic lifetimes. Returning memory to the OS can itself require unmapping, page-table updates, and TLB shootdowns. Retaining memory improves reuse but raises footprint. There is no universally best trim policy.

Fragmentation also changes cache behavior. Sparse live objects can keep many pages active, enlarge the page-table and TLB working sets, and defeat sequential prefetching. Compacting a general C++ heap is difficult because raw pointers expose object addresses and may be stored anywhere. Region replacement, handle-based storage, and rebuilding an immutable snapshot can achieve application-level compaction with explicit pointer invalidation.

A realistic fragmentation test must preserve lifetimes. Randomly freeing half of uniformly sized blocks says little about a workload where large session objects outlive millions of small orders. Replay allocation size, alignment, ownership thread, and lifetime together, then inspect the footprint after multiple peaks rather than immediately after startup.

## 10.5 Arena and Bump Allocation

An **arena** owns a region from which many objects are allocated and later released together. A **bump allocator** serves each request by aligning and advancing one offset. It does not individually reclaim blocks.

```cpp
#include <cstddef>
#include <bit>
#include <memory>
#include <span>

class BumpArena {
public:
    explicit BumpArena(std::span<std::byte> storage) noexcept
        : storage_{storage} {}

    [[nodiscard]] void* allocate(std::size_t bytes,
                                 std::size_t alignment) noexcept {
        std::size_t space = storage_.size() - used_;
        if (bytes == 0 || !std::has_single_bit(alignment) || bytes > space) {
            return nullptr;
        }

        void* candidate = storage_.data() + used_;
        if (std::align(alignment, bytes, candidate, space) == nullptr) {
            return nullptr;
        }

        auto* aligned = static_cast<std::byte*>(candidate);
        const std::size_t start =
            static_cast<std::size_t>(aligned - storage_.data());
        used_ = start + bytes;
        return aligned;
    }

    void reset() noexcept { used_ = 0; }
    [[nodiscard]] std::size_t used() const noexcept { return used_; }

private:
    std::span<std::byte> storage_;
    std::size_t used_{};
};
```

This fast path performs alignment arithmetic, a bounds check, and an offset update. It is thread-confined; concurrent use would require partitioning or synchronization. It returns null on exhaustion instead of silently falling back to the heap.

`std::align` requires a valid power-of-two alignment supported by the intended objects. The example rejects zero-byte requests and invalid alignment; a typed interface also prevents callers from inventing unsupported requirements:

```cpp
template<class T, class... Args>
T* make(BumpArena& arena, Args&&... args) {
    void* storage = arena.allocate(sizeof(T), alignof(T));
    if (storage == nullptr) return nullptr;
    return std::construct_at(static_cast<T*>(storage),
                             std::forward<Args>(args)...);
}
```

Resetting the offset does not destroy live non-trivial objects. Either restrict the arena to trivially destructible types, record destructor callbacks, or make region lifetime semantics explicit and destroy objects before reset. A constructor that throws also needs care: the offset has already advanced. The arena can accept that small loss until bulk reset, or support a rollback mark.

A mark records an offset before tentative work. Rollback is safe only if every object constructed after the mark has first been destroyed and no pointer into that suffix escaped. A raw `used_ = mark` API cannot enforce either condition. A transaction object can record destructors and release its mark only on commit, trading a little metadata for a stronger interface.

Arena alignment waste accumulates between differently aligned objects. Ordering allocations from stricter to weaker alignment or separating types into pools can reduce gaps. That is a measured layout optimization; it should not leak into an API that relies on a fragile allocation order.

Bulk release makes latency easy to place: one reset replaces many individual deallocations. It does not erase cleanup work for contained resources. An arena full of `std::string` objects may still own separate heap buffers unless those strings use the same region-aware allocator.

The arena's backing pages can fault on first use. Preallocating virtual storage before the session but never touching it does not prepare physical memory. Section 10.15 connects the region to Linux placement and faults.

## 10.6 Monotonic Regions

A **monotonic region** permits allocation but no individual deallocation; memory is recovered when the entire region is released. It is ideal when object lifetimes are nested within a phase, message batch, snapshot build, or request.

C++17 provides `std::pmr::monotonic_buffer_resource`. It can begin with a caller-owned buffer and request additional buffers from an upstream memory resource when exhausted:

```cpp
#include <array>
#include <cstddef>
#include <memory_resource>
#include <vector>

std::array<std::byte, 64 * 1024> bytes;

std::pmr::monotonic_buffer_resource region{
    bytes.data(), bytes.size(), std::pmr::null_memory_resource()
};

std::pmr::vector<Order> batch{&region};
batch.reserve(1024);
```

Using `null_memory_resource` as upstream makes exhaustion deterministic: allocation throws `std::bad_alloc` rather than spilling to the general heap. If the surrounding critical path is no-throw, catch and translate outside it or implement a non-throwing fixed region interface. The standard PMR allocation interface reports failure with exceptions.

The resource's `release()` frees upstream buffers and makes all storage obtained from it reusable, invalidating every object and view in the region. Destroy allocator-aware containers before releasing their resource. A monotonic resource's deallocation operations intentionally do nothing, so repeatedly destroying and rebuilding differently sized objects can consume the region until release.

Growth strategy and buffer sizes are implementation details. A caller-provided initial buffer makes the first capacity explicit, but alignment padding and container growth still consume it. Reserve container capacity when the maximum is known, and test the exact worst-case object mix.

Region ownership must outlive every PMR object using it. Returning a `pmr::vector` whose allocator points to a local resource produces a dangling allocator and storage. This is a lifetime bug, not a performance tradeoff.

## 10.7 Pools, Slabs, and Free Lists

A **pool** manages reusable blocks, commonly of one or a few fixed sizes. A **slab** is a larger region divided into object slots. A **free list** links currently unused slots. Fixed geometry makes the steady-state allocation path predictable.

```text
slab
+--------+--------+--------+--------+
| live A | free --+------->| free --+--> null
+--------+--------+--------+--------+
```

An intrusive free list may store its next pointer inside a free slot. The slot does not simultaneously contain a live `T`; allocation removes the slot from the free list and begins `T`'s lifetime with `std::construct_at`. Deallocation calls `std::destroy_at` before reusing the storage for linkage.

```cpp
// Excerpt: routine headers and domain declarations are omitted.
template<class T, std::size_t N>
class ObjectPool {
    static_assert(N > 0);

    union Slot {
        T value;
        Slot* next;

        Slot() noexcept : next{nullptr} {}
        ~Slot() {} // ObjectPool controls the active member.
    };

public:
    ObjectPool() noexcept {
        for (std::size_t i = 0; i + 1 < N; ++i) slots_[i].next = &slots_[i + 1];
        slots_[N - 1].next = nullptr;
        free_ = &slots_[0];
    }

    template<class... Args>
    T* acquire(Args&&... args) {
        if (free_ == nullptr) return nullptr;
        Slot* slot = std::exchange(free_, free_->next);
        try {
            return std::construct_at(&slot->value,
                                     std::forward<Args>(args)...);
        } catch (...) {
            std::construct_at(&slot->next, free_);
            free_ = slot;
            throw;
        }
    }

    void release(T* object) noexcept {
        std::destroy_at(object);
        auto* slot = reinterpret_cast<Slot*>(object);
        std::construct_at(&slot->next, free_);
        free_ = slot;
    }

private:
    Slot slots_[N];
    Slot* free_{};
};
```

This is a teaching implementation for a thread-confined pool. A union and its member are pointer-interconvertible, which is why `release` can recover the enclosing slot. Production code should still audit every lifetime transition, destroy all live values before destroying the pool, validate that a returned pointer belongs to it, prevent double release, and decide whether construction is allowed to throw. Debug builds can use generation counters and occupancy bits.

Pool handles can use an index rather than a pointer. An index is stable across remapping and makes membership validation cheap. Pairing the index with a generation prevents a stale handle from naming a newly constructed object in the same slot:

```text
handle = { slot: 417, generation: 9 }
slot   = { generation: 10, occupied: true }

The old handle is rejected even though slot 417 is live again.
```

Generation width determines how soon wraparound can make a very old handle appear valid. Select it from reuse rate and maximum handle lifetime, or quarantine wrapped slots. This is another bounded-capacity calculation, not a magic safety stamp.

A concurrent free list is substantially harder. A compare-exchange loop can suffer the ABA problem: the head changes away and back while a thread still holds an old pointer. Tagged indices, hazard pointers, epochs, or locks can solve different parts of the problem. Atomic operations also contend on the head cache line. A separate pool per owning thread is often simpler.

Pools trade generality for bounds. They have fixed maximum live objects, internal waste when `T` is smaller than a slot, and potentially poor locality if the free-list order scatters active objects. Slab layout can group objects by trading instrument or lifetime to improve locality.

## 10.8 Fixed-Capacity and Stack Storage

**Fixed-capacity storage** reserves a maximum amount in the owning object or a caller-provided buffer. It performs no growth allocation, so insertion either succeeds within capacity or follows a defined overflow policy.

`std::array<T, N>` embeds exactly `N` elements and constructs all of them. It works well when every slot is always live. A fixed-capacity vector instead needs raw storage plus a current size so that only the first `size` objects are alive.

```text
FixedVector<Order, 4>
+-------+-------+----------+----------+    size = 2
| live  | live  | raw slot | raw slot |
+-------+-------+----------+----------+
```

The implementation must align each slot, construct on insertion, destroy on removal, and implement copy/move exception safety. `std::array<std::optional<T>, N>` is simpler but pays an engagement discriminator and padding for every slot. Choose clarity unless footprint measurements justify custom lifetime code.

Automatic storage is often described as “stack allocation.” Entering a function commonly adjusts the stack pointer, but large local arrays can touch new stack pages, fault on guard expansion, overflow a configured thread stack, and evict useful data. A 1 MiB scratch array is not predictably cheap merely because it avoids `malloc`.

Embedding capacity in every object multiplies footprint. Ten thousand sessions each carrying a worst-case 64 KiB buffer reserve far more memory than a central bounded pool with measured concurrency. Conversely, a central pool introduces contention and cross-thread ownership. Capacity placement is an architectural decision.

For a fixed-capacity type, publish its invalidation rules. Moving elements during erase can invalidate pointers and references even though no heap reallocation occurs. Stable slot IDs with generation counters may be better than raw pointers for long-lived order handles.

## 10.9 Ring Storage and Object Recycling

A **ring buffer** reuses a fixed sequence of slots by wrapping producer and consumer indices. Capacity, element lifetime, and the meaning of a full ring must all be explicit.

```text
          producer
             v
+----+----+----+----+----+----+
|old |live|free|free|free|old |
+----+----+----+----+----+----+
      ^
   consumer
```

For a single-threaded ring, an insertion constructs in the next free slot and removal destroys the consumed object. A ring that stores trivially copyable records can keep every slot alive and overwrite by assignment. Non-trivial types require exact lifetime transitions.

Full and empty states need an unambiguous representation. Common choices reserve one slot, maintain a separate count, or use monotonically increasing sequence numbers. Wrapped machine integers are well-defined for unsigned types, but subtracting indices and converting widths still need a capacity proof.

**Object recycling** retains an object's allocation and resets its logical state for another use. It can preserve buffer capacity and warmed cache lines:

```cpp
Message message;
for (Packet packet : packets) {
    message.clear_for_reuse(); // must reset every semantic field
    if (decode(packet, message)) consume(message);
}
```

Incomplete reset creates stale-state bugs. Retained `vector` and `string` capacity can be beneficial, but one unusually large message may permanently inflate every recycled object's footprint. Apply an explicit high-water policy if buffers can grow.

In concurrent rings, publication and slot reuse require memory-order reasoning, sequence ownership, and false-sharing control. Chapter 17 develops those protocols. An allocator cannot make an incorrect ring safe.

## 10.10 Per-Thread Allocation and Cross-Thread Frees

**Per-thread allocation** gives each thread local free lists or an arena. It removes allocator sharing from the common path and improves locality when the same thread allocates, uses, and frees an object.

The design fits thread-confined order books and decode scratch storage. It fits poorly when one thread allocates market-data events and another eventually destroys them. A cross-thread free must do one of the following:

- update the originating allocator concurrently;
- enqueue the block back to its owner;
- transfer ownership of an entire region; or
- allow the freeing thread's allocator to adopt it.

Each choice has costs. A remote-free queue consumes bounded capacity and transfers cache lines. Direct updates contend on metadata. Region transfer delays reclamation. Adoption can complicate accounting and NUMA placement.

Thread caches also multiply retained memory. If 32 threads each retain one batch of every size class, process footprint may be much larger than live payload. A thread that exits must drain or transfer cached blocks safely. Dynamic creation of many short-lived threads is therefore hostile to both predictability and memory use.

NUMA adds another dimension. A block first touched by producer A on node 0 remains physically placed there when consumer B on node 1 owns it, unless the kernel migrates it or policy says otherwise. Remote access latency and interconnect bandwidth can outweigh allocator fast-path gains.

Instrument ownership flow. Tag sampled allocations with allocating and freeing thread IDs, count remote frees, and relate them to queue topology. Do not put timestamps or large debug headers on every production block without measuring the observer effect.

## 10.11 C++17 `std::pmr` Resources and Allocators

C++17's `std::pmr` facilities separate an allocator-aware object's type from the concrete allocation strategy. A `std::pmr::polymorphic_allocator<T>` holds a pointer to a `std::pmr::memory_resource`; PMR container aliases use that allocator.

```cpp
std::pmr::unsynchronized_pool_resource pool;
std::pmr::vector<Order> orders{&pool};
```

`memory_resource::allocate` performs argument handling and dispatches to the virtual `do_allocate` of the dynamic resource. Thus a PMR allocation commonly includes an indirect call. Whole-program optimization or a visible final resource type may devirtualize some calls, but the abstraction does not guarantee that. Deallocation similarly dispatches through the resource.

The standard resources have distinct behavior:

| Resource | Important property |
|---|---|
| `monotonic_buffer_resource` | Individual deallocation has no effect; bulk release. |
| `unsynchronized_pool_resource` | Pools blocks; not safe for unsynchronized access by multiple threads. |
| `synchronized_pool_resource` | Supports concurrent access with synchronization cost. |
| `new_delete_resource()` | Uses global new/delete allocation functions. |
| `null_memory_resource()` | Always fails allocation with `bad_alloc`. |

Pool parameters and upstream behavior affect block grouping and retention. Exact size classes and growth are implementation-defined. Both pool resources can hold memory for reuse rather than returning it immediately upstream.

Allocator-aware propagation is transitive only when all nested types participate correctly. A `pmr::vector<pmr::string>` can use one resource for vector storage and strings when constructed through allocator-aware mechanisms. A plain `std::string` nested in a PMR container continues to use its own ordinary allocator.

The default PMR resource is process-global state accessed by `get_default_resource` and changed by `set_default_resource`. Avoid changing it after concurrent work begins. Prefer passing explicit resource pointers so ownership and lifetime are visible.

PMR resource lifetime is critical: the resource must outlive containers that may deallocate through it. Moving a PMR container does not necessarily make resource identity disappear. Verify move and swap behavior before placing such containers behind long-lived interfaces.

`memory_resource` equality is semantic. Two resource objects compare equal through `is_equal` only when either can deallocate memory allocated by the other according to the resource contract. Pointer equality is sufficient for the base implementation but a derived resource may define broader equivalence. False equality risks deallocation through an incompatible resource; false inequality can force unnecessary element-wise operations.

Because the resource pointer is runtime state, two `pmr::vector<Order>` objects have the same C++ type while using different allocation domains. This simplifies generic APIs but makes resource choice invisible in the type system. Document it in factory interfaces and expose diagnostics that identify the active resource.

PMR is a strategy-selection tool, not a deterministic-allocation guarantee. A pool may reach upstream, a monotonic resource may grow, and virtual dispatch may remain. Supply bounded backing storage and an explicit upstream policy when those properties matter.

## 10.12 Custom Allocator Propagation and Equality

A **custom allocator** supplies storage operations to allocator-aware containers. The apparent `allocate` and `deallocate` pair is only the beginning. `std::allocator_traits` queries types and policies that govern rebinding, construction, maximum sizes, equality, and propagation.

Stateful allocators can refer to different arenas. Equality means that memory allocated by one instance can be deallocated by the other. Lying about equality can return storage to the wrong arena; declaring unequal allocators affects container move, assignment, and swap behavior.

The propagation traits are:

- `propagate_on_container_copy_assignment`;
- `propagate_on_container_move_assignment`; and
- `propagate_on_container_swap`.

If an allocator does not propagate and source and destination allocators differ, moving a container may require element-by-element movement into new storage instead of transferring a pointer. That can allocate, throw, and turn an expected constant-time administrative operation into linear work. Swapping containers with incompatible, non-propagating allocators can violate the operation's preconditions.

```cpp
using BookVector = std::vector<Order, ArenaAllocator<Order>>;

BookVector a{ArenaAllocator<Order>{arena_a}};
BookVector b{ArenaAllocator<Order>{arena_b}};

b = std::move(a); // inspect allocator traits; do not assume pointer stealing
```

Allocator interfaces must honor size, alignment, and overflow. Multiplying `n * sizeof(T)` needs a checked bound before allocation. `allocate(0)` has special library-contract considerations and should not be used as a unique sentinel. `deallocate` receives a pointer and element count under the allocator protocol; custom metadata must remain accessible and correctly aligned.

Exception behavior matters. Standard allocator `allocate` reports failure by throwing. Container operations rely on construction and cleanup rules to provide their documented guarantees. A nonstandard allocator that returns null where the contract expects an exception can lead to invalid construction rather than clean failure.

Test custom allocators with unequal state, copy and move assignment, swap, empty containers, over-aligned types, throwing constructors, and maximum-size requests. Sanitizers can find lifetime and alignment mistakes, but they do not prove propagation semantics.

## 10.13 Avoiding Allocation Through Reservation and Reuse

The most predictable hot-path allocation is the one moved out of the hot path. **Reservation** commits container capacity before steady state; **reuse** keeps that capacity for repeated operations.

```cpp
std::vector<Order> batch;
batch.reserve(max_orders_per_packet);

for (;;) {
    batch.clear(); // destroys elements; normally retains vector capacity
    decode_next_packet(batch);
}
```

`reserve` can allocate and move existing elements, so call it during controlled setup. It guarantees capacity of at least the requested size but does not create elements. `clear` destroys elements and normally does not reduce capacity because the standard leaves capacity unchanged. A subsequent insertion beyond capacity can still reallocate.

For strings, `reserve` similarly prepares capacity but exact small-string optimization and growth behavior are implementation-specific. `shrink_to_fit` is non-binding and can allocate or move; it is usually inappropriate in a critical loop.

Other techniques include:

- fixed-capacity containers with an explicit full result;
- inline buffers for the common small case;
- intrusive structures that embed linkage in owned nodes;
- emplacement into preallocated slots;
- batched parsing into one region; and
- recycling network and serialization buffers.

Each changes ownership. An intrusive list does not own its nodes. An inline buffer enlarges every container object. A reserved vector invalidates pointers if an unexpected insertion exceeds capacity. A reused buffer can retain sensitive or stale data unless reset correctly.

Verify “allocation-free” mechanically. Override allocation functions in a test binary, use a counting `memory_resource`, or attach a profiler after initialization. Then exercise worst-case valid inputs, not only typical messages. Compiler optimization can remove test allocations, while logging and test frameworks can add unrelated ones; scope the counter to the thread and interval under study.

Early allocation moves failure and page-touch work to a controlled phase. It also commits memory that may never be used. The next section makes the necessary capacity policy explicit.

## 10.14 Deterministic Capacity and Overflow Policies

A bounded data structure is predictable only if its behavior at capacity is defined. **Overflow policy** answers what happens when demand exceeds reserved storage. Silent heap fallback defeats the bound and places the slowest path at the moment of maximum load.

Common policies are:

| Policy | Suitable use | Main risk |
|---|---|---|
| Reject newest | Commands that caller can retry or fail | Upstream retry storm |
| Drop newest | Loss-tolerant telemetry | Missing recent data |
| Drop oldest/overwrite | Flight recorder or latest-state stream | Loss of history |
| Backpressure/block | Lossless pipeline with bounded producer | Scheduler and queueing latency |
| Disconnect/fail closed | Corrupted session or unsafe risk state | Availability loss |
| Spill to heap/disk | Noncritical batch work | Unbounded latency and footprint |

Expose the outcome in the API:

```cpp
enum class PushResult : unsigned char {
    inserted,
    full,
    closed
};

[[nodiscard]] PushResult try_push(Order order) noexcept;
```

For market data, dropping a packet may require marking the book stale and starting recovery; continuing with an invisible gap is not acceptable. For pre-trade risk, capacity exhaustion commonly needs fail-closed behavior. For metrics, overwrite or sampling may be preferable to blocking the order path.

Capacity derives from a model: maximum venue message size, maximum open orders, burst duration, consumer service rate, and recovery time. Add headroom for alignment and metadata, then test one-past-capacity. A number chosen only from observed average load is not a safety bound.

For a producer rate `P`, consumer service rate `C`, and worst admitted burst duration `B`, `(P - C) * B` is a starting queue-depth estimate when `P > C`. Real systems add scheduling pauses, batching, recovery traffic, and measurement uncertainty. If overload can continue indefinitely, no finite queue makes a lossless non-blocking system possible. The architecture must eventually reject, block, shed, or fail.

Early commitment has operational consequences. Reserving every theoretical maximum can exceed memory limits or reduce cache locality. Hierarchical designs can use a small per-thread bound and a larger explicitly noncritical queue. The boundary between them must still define overload.

Record counters for full events, high-water marks, drops, retries, and time spent blocked. The recording path itself must be bounded and must not allocate in response to exhaustion. This is where deterministic design is most often accidentally undone.

## 10.15 Page Faults, TLBs, NUMA, and First Touch

Allocator storage is backed by virtual memory. A successful allocation may reserve an address range without installing every page-table entry or assigning every physical page. The first access can therefore incur a **page fault**, even when the allocator's own fast path was only pointer arithmetic.

A minor fault requires no storage read but still enters the kernel, allocates or maps a page, updates page tables, and resumes the thread. A major fault waits for storage I/O. Copy-on-write and stack growth are other fault sources. Low-latency steady state aims for no demand faults on critical mappings.

The **translation lookaside buffer (TLB)** caches virtual-to-physical translations. A large, scattered working set can miss in the TLB and require hardware page walks. Huge pages increase translation reach and reduce page-table footprint, but use larger allocation granularity and can introduce compaction, splitting, or configuration risks. Transparent Huge Pages and explicit hugetlb pages have different operational behavior.

Mapping changes can require TLB invalidation on cores that have used the address space. Linux may send inter-processor interrupts so those cores discard stale translations. Repeated mapping, unmapping, or protection changes in a multithreaded process can therefore disturb threads that never called the allocator. Keeping stable mappings through the critical phase avoids this class of cross-core interference.

On a NUMA machine, **first touch** commonly determines which node supplies a physical page under the default Linux policy. Allocating a pool on a startup thread on node 0 and using it on a market-data thread on node 1 can create persistent remote accesses. Pin the intended thread, establish an explicit memory policy where appropriate, and write each required page from that context.

```cpp
void prefault(std::span<std::byte> bytes, std::size_t page_size) {
    for (std::size_t offset = 0; offset < bytes.size(); offset += page_size) {
        bytes[offset] = std::byte{0};
    }
    if (!bytes.empty()) bytes.back() = std::byte{0};
}
```

This example deliberately writes one byte per page. Obtain the actual base page size with `sysconf(_SC_PAGESIZE)` rather than hard-coding 4096. Optimizers must not eliminate preparation; in real code, the memory is subsequently observable, but a standalone benchmark may need a carefully designed barrier. Touching changes logical contents, so initialize through the real object construction path when zero bytes are not a valid representation.

`mlock` and `mlockall` can reduce eviction risk for selected mappings, subject to limits and permissions. They are not substitutes for capacity planning, correct NUMA placement, or avoiding direct reclaim elsewhere in the system. Locking excessive memory can harm the host. `MAP_POPULATE`, `madvise`, explicit huge pages, and NUMA APIs each have kernel-version and policy nuances that require target testing.

Monitor preparation and steady state:

```bash
perf stat -e page-faults,minor-faults,major-faults,dTLB-load-misses \
    ./order_gateway

numastat -p "$(pidof order_gateway)"
rg 'VmRSS|VmLck|voluntary_ctxt_switches|nonvoluntary_ctxt_switches' \
    /proc/"$(pidof order_gateway)"/status
```

Event names and availability vary by CPU and kernel. Correlate faults with allocator expansion, thread migration, reclaim pressure, and mapping changes. RSS proves residency, not locality; NUMA statistics add placement evidence.

A fast pool controls suballocation after its backing region exists. It cannot eliminate the first-touch fault, a TLB miss, remote NUMA access, or kernel reclaim. Prepare the entire chain before the critical phase:

1. establish CPU and memory placement;
2. reserve every bounded region;
3. construct or touch all pages that steady state will use;
4. warm allocator metadata and representative code paths;
5. prevent hot-path growth and mapping changes; and
6. monitor faults, TLB events, RSS, NUMA misses, and pressure continuously.

Allocation strategy ends at the virtual-memory boundary only on paper. In a real low-latency process, page placement and fault behavior are part of the allocator contract.

That contract should be written, tested under pressure, and monitored throughout the trading session.

## 10.16 Interview Check

1. Describe the separate allocation, construction, destruction, and deallocation steps in `new T` and `delete p`. What happens if `T`'s constructor throws?
2. Why may `new T[n]` need an array cookie, and why can user code not rely on its location or existence?
3. Compare a warmed thread-cache allocation with an allocator arena expansion. Which locks, metadata accesses, mappings, and faults might appear on the slow path?
4. Distinguish internal from external fragmentation and explain how both can increase RSS beyond live payload.
5. A bump allocator resets its offset without destroying objects. For which types is that safe, and how would you support non-trivial destructors?
6. Compare `monotonic_buffer_resource`, `unsynchronized_pool_resource`, and `synchronized_pool_resource`. Where can virtual dispatch, upstream allocation, and synchronization occur?
7. Why can moving a container with unequal stateful allocators perform element-wise work instead of transferring one pointer?
8. Design the overflow policy for a bounded market-data queue and for a pre-trade risk queue. Why should the policies differ?
9. A process allocates and prefaults a pool, yet the hot thread observes remote-memory latency. Explain how first-touch placement and thread migration can cause this result.
10. How would you verify that a critical operation performs no allocation and no page faults after initialization without letting the measurement mechanism dominate the result?
