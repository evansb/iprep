# 17. Raw Allocation

Allocation obtains storage; construction starts an object's lifetime; initialization determines its initial state. A `new` expression normally bundles these operations, but containers and custom allocators separate them. That separation exposes both the sharpest lifetime bugs and the allocation strategies used in latency-sensitive systems.

## Three separate events

Raw memory work asks three distinct questions:

1. **Allocation:** where do suitably sized and aligned bytes come from?
2. **Construction:** when does an object begin its lifetime in those bytes?
3. **Initialization:** what initial value or invariant does construction establish?

Construction and initialization commonly occur in the same expression, but they remain different from obtaining storage. Assignment after construction is not initialization; it changes an object whose lifetime has already begun.

```cpp
#include <cstddef>
#include <iostream>
#include <memory>
#include <new>

struct Order {
    int id;
    double price;

    Order(int order_id, double order_price)
        : id(order_id), price(order_price) {}
};

int main() {
    void* storage = ::operator new(sizeof(Order));  // allocate bytes

    Order* order = std::construct_at(               // construct and initialize
        static_cast<Order*>(storage), 42, 101.25);
    std::cout << order->id << ' ' << order->price << '\n';
    // prints: 42 101.25

    std::destroy_at(order);                         // end object lifetime
    ::operator delete(storage);                     // deallocate bytes
}
```

Between `operator new` and `std::construct_at`, the storage contains no `Order`. Calling an `Order` member through `storage` during that interval would have undefined behavior. After `std::destroy_at`, the bytes still exist, but the `Order` does not.

The APIs in this chapter deliberately cover different columns:

| Operation | Obtains storage | Starts lifetime | Establishes initial value | Releases storage |
|---|---:|---:|---:|---:|
| `new T{args}` | yes | yes | yes | no |
| `delete p` | no | ends it | no | yes |
| `::operator new(bytes)` | yes | no | no | no |
| `::operator delete(p)` | no | no | no | yes |
| `std::malloc(bytes)` | yes | implicit-lifetime types only | no | no |
| placement new / `std::construct_at` | no | yes | yes | no |
| `std::destroy_at(p)` | no | ends it | no | no |

The `malloc` row depends on the implicit-lifetime rules from Chapter 16. It does not generalize to classes that require a non-trivial constructor. Likewise, `operator delete` accepts storage, not an instruction to destroy whatever object might occupy it.

Storage duration describes how long an object's storage lasts:

| Duration | Where it comes from | Begins and ends | Typical use |
|---|---|---|---|
| Automatic | block-local declaration | block entry to exit | local working state |
| Static | namespace scope or `static` | program start to termination | process-wide state |
| Thread | `thread_local` declaration | thread start to exit | per-thread state; Part V |
| Dynamic | allocation request | explicit allocation to deallocation | variable-sized or externally managed lifetime |

RAII (Chapter 5) normally couples a resource to an automatic object's lifetime even when the resource itself uses dynamic storage. This chapter deliberately exposes the lower layer.

The C++ standard traditionally associates `new` and `delete` with the **free store**. Programmers use **heap** more broadly for dynamically allocated memory, especially the territory managed by `malloc`. Implementations commonly put both families over the same underlying allocator, but that does not make their APIs interchangeable.

**Interview.** “Stack versus heap” is useful shorthand, not the standard's lifetime model. A strong answer names storage durations, separates storage from object lifetime, and still recognizes “heap allocation” as ordinary engineering terminology.

## `new`, `delete`, and what they expand to

A **new-expression** performs two layers of work: it calls an allocation function named `operator new`, then initializes an object in the returned storage. A **delete-expression** runs the destructor, then calls a deallocation function named `operator delete`.

```cpp
Order* direct = new Order{7, 99.75};
std::cout << direct->price << '\n';  // prints: 99.75
delete direct;
```

The mechanics are approximately this:

```cpp
void* raw = ::operator new(sizeof(Order));
Order* split = nullptr;

try {
    split = std::construct_at(static_cast<Order*>(raw), 7, 99.75);
} catch (...) {
    ::operator delete(raw);
    throw;
}

std::cout << split->price << '\n';  // prints: 99.75
std::destroy_at(split);
::operator delete(raw);
```

The real new-expression performs the same essential cleanup if construction throws. The two-layer design lets allocation functions change without changing constructors, and lets containers allocate storage before deciding which objects to construct in it.

Initialization syntax matters even for a scalar:

```cpp
int* indeterminate = new int;  // default-initialized; value is indeterminate
int* zero = new int{};         // value-initialized to 0
int* seven = new int(7);       // initialized to 7

std::cout << *zero << ' ' << *seven << '\n';  // prints: 0 7
delete indeterminate;  // deleting is valid; reading its value would be UB
delete zero;
delete seven;
```

Allocation succeeded in all three cases, and three `int` lifetimes began. Only the chosen initialization forms differ.

The array form constructs multiple objects:

```cpp
Order* orders = new Order[2]{
    {1, 100.10},
    {2, 100.20}
};

std::cout << orders[1].id << '\n';  // prints: 2
delete[] orders;
```

An implementation may reserve hidden space near the allocation for an **array cookie**, such as the element count needed to run destructors. `new T[n]` must pair with `delete[]`; plain `delete` may read the wrong metadata or destroy the wrong number of elements.

If element construction throws partway through an array new-expression, the language destroys the elements already constructed and releases the allocation. This cleanup is another reason to use the expression rather than manually reproducing an array cookie.

```cpp
Order* batch = new Order[2]{{1, 100.10}, {2, 100.20}};
delete batch;  // UB: delete does not match new[]
```

AddressSanitizer detects many `new`/`delete[]` mismatches. Detection does not make the mismatch valid or reliably recoverable.

Both `delete nullptr;` and `delete[] nullptr;` are valid no-ops. That rule simplifies cleanup paths, but it does not rescue a dangling non-null pointer or a mismatched allocation family.

Deallocation also needs the correct object type. Calling `::operator delete` directly on storage that still contains a live object skips its destructor; deleting through an unrelated pointer type has undefined behavior. A `void*` cannot be the operand of a standard delete-expression because it carries no destructor information.

**Rule.** Match `new` with `delete`, and `new[]` with `delete[]`. In application code, prefer `std::unique_ptr` and standard containers (Chapter 8); use raw forms only where ownership machinery is being implemented.

## The C allocation family and interop

The C allocation functions manage bytes:

- `std::malloc(bytes)` allocates uninitialized storage.
- `std::calloc(count, bytes_each)` allocates storage and sets every byte to zero.
- `std::realloc(pointer, new_bytes)` resizes a block, possibly by moving its bytes.
- `std::free(pointer)` releases storage from this family.

Their failure and sizing behavior differ:

| Call | Existing contents | Failure result | Key obligation |
|---|---|---|---|
| `std::malloc(n)` | none | `nullptr` | initialize before reading |
| `std::calloc(count, size)` | all bytes zero | `nullptr` | zero bits must suit the type |
| `std::realloc(p, n)` | prefix preserved | `nullptr`, old block retained | replace pointers only on success |
| `std::free(p)` | not applicable | not applicable | `p` came from C family |

`std::free(nullptr)` is a no-op. A successful zero-size request may return `nullptr` or a distinct pointer that can be passed to `std::free`; do not dereference it or infer usable capacity from non-nullness.

`calloc` checks the `count * bytes_each` size calculation for overflow before allocating. Zero bytes are not a general substitute for C++ initialization: an all-zero object representation is not promised to establish every class invariant or every possible value type.

For an implicit-lifetime type, allocation by `malloc` can implicitly start an object's lifetime when subsequent typed access requires it, as established in Chapter 16:

```cpp
struct Tick {
    std::uint64_t sequence;
    std::int64_t price_ticks;
};

Tick* tick = static_cast<Tick*>(std::malloc(sizeof(Tick)));
if (tick == nullptr) {
    throw std::bad_alloc{};
}

tick->sequence = 9001;
tick->price_ticks = 10'025;
std::cout << tick->sequence << '\n';  // prints: 9001
std::free(tick);
```

`Tick` is an implicit-lifetime, trivially copyable type. A class such as `std::string` still needs construction; casting a `malloc` result does not call its constructor.

`realloc` preserves the old bytes up to the smaller of the old and new sizes. It may return a different address:

```cpp
std::size_t capacity = 64;
Tick* ticks = static_cast<Tick*>(std::malloc(capacity * sizeof(Tick)));
if (ticks == nullptr) {
    throw std::bad_alloc{};
}

capacity *= 2;
void* grown = std::realloc(ticks, capacity * sizeof(Tick));
if (grown == nullptr) {
    std::free(ticks);  // failure leaves the old block allocated
    throw std::bad_alloc{};
}

ticks = static_cast<Tick*>(grown);  // old pointer and interior pointers invalid
std::free(ticks);
```

On success, the pointer passed to `realloc` is invalid even if the returned address happens to compare equal. Every pointer, reference, iterator, or view into the old block must be treated as invalidated.

Assigning the result directly back to the only pointer loses the old allocation on failure:

```cpp
Tick* ticks = static_cast<Tick*>(std::malloc(64 * sizeof(Tick)));
ticks = static_cast<Tick*>(
    std::realloc(ticks, 128 * sizeof(Tick)));  // leak if this returns nullptr
```

The temporary `grown` in the previous example preserves the original pointer until success is known. Real code also checks the multiplication before computing a byte count, because unsigned `std::size_t` arithmetic wraps modulo its range.

Never use `realloc` for a live non-trivially-copyable C++ object. A move performed as raw bytes does not run move constructors, repair internal pointers, or end the old objects' lifetimes correctly. `std::vector` grows by constructing elements in new storage and then destroying the old elements (Chapter 10).

Allocation and deallocation must stay in one API family and form:

| Allocated with | Freed with | Verdict |
|---|---|---|
| `new T` | `delete` | OK |
| `new T[n]` | `delete[]` | OK |
| `std::malloc` / `std::calloc` / `std::realloc` | `std::free` | OK |
| `new T` | `std::free` | UB |
| `std::malloc` | `delete` | UB |
| `new T[n]` | `delete` | UB |

A C API may return a string or buffer that its own documented function must release. Do not guess that `delete` or `std::free` is correct. Wrap the result in `std::unique_ptr` with the required custom deleter (Chapter 8).

**Pitfall.** `std::unique_ptr<T>` uses `delete` by default. Putting a pointer from `std::malloc` into it without a `std::free` deleter merely automates undefined behavior.

## When allocation fails

An ordinary new-expression reports allocation failure by throwing `std::bad_alloc` (Chapter 6). The `std::nothrow` form returns `nullptr` instead:

```cpp
void submit_with_nothrow() {
    Order* order = new (std::nothrow) Order{5, 102.25};
    if (order == nullptr) {
        std::cerr << "allocation failed\n";
        return;
    }

    std::cout << order->id << '\n';  // prints: 5
    delete order;
}

void submit_with_exception() {
    try {
        Order* order = new Order{6, 102.50};
        std::cout << order->id << '\n';  // prints: 6
        delete order;
    } catch (const std::bad_alloc&) {
        std::cerr << "allocation failed\n";
    }
}
```

`std::nothrow` does not remove failure handling. It replaces an exception path with a nullable result, and every caller must check that result before dereferencing it.

The nothrow form changes allocation failure, not constructor behavior. If `Order` construction itself throws for a reason other than obtaining its storage, that exception still propagates and the new-expression releases the storage automatically.

Failure policy is an interface decision:

| Policy | Signal | Suitable boundary |
|---|---|---|
| Throwing `new` | `std::bad_alloc` | ordinary RAII code |
| Nothrow `new` | `nullptr` | explicitly nullable low-level API |
| Fixed-capacity pool | `nullptr`, status, or assertion | bounded subsystem |
| Startup reservation | startup failure | session-critical memory |

**Note.** On a default-configured Linux system with memory overcommit, `malloc` or `new` can appear to succeed before physical backing is available. A later first write can fault and provoke the OOM killer. Allocation failure policy therefore depends partly on operating-system configuration; the Linux book in this series covers that layer.

Low-latency processes usually reserve their bounded working memory during startup. Capacity errors then appear before the session begins, rather than as an exception, null check, page fault, or process termination in a hot path. Chapter 18 turns that policy into allocation-free container usage.

## Placement new, `launder`, and the explicit-lifetime API

Placement new constructs an object at an address supplied by the caller:

```cpp
void* raw = ::operator new(sizeof(Order));
Order* order = ::new (raw) Order{12, 103.75};

std::cout << order->price << '\n';  // prints: 103.75
order->~Order();
::operator delete(raw);
```

The leading `::` requests the standard non-allocating placement overload rather than a class-specific overload. Placement new does not allocate and has no matching placement delete-expression. The caller must run the destructor explicitly, then release or reuse the underlying storage.

The placement argument is an address, not a capacity. The language does not check that the region is large enough, suitably aligned, writable, or currently free of a live object whose lifetime cannot be ended. Those conditions are the caller's contract.

`std::construct_at` and `std::destroy_at` **(C++20)** express the same lifetime operations as constexpr-friendly library functions. They are the clean spelling for allocator implementations:

```cpp
alignas(Order) std::byte buffer[sizeof(Order)];

Order* first = std::construct_at(
    reinterpret_cast<Order*>(buffer), 21, 104.00);
std::cout << first->id << '\n';  // prints: 21
std::destroy_at(first);

Order* second = std::construct_at(
    reinterpret_cast<Order*>(buffer), 22, 104.25);
std::cout << second->id << '\n';  // prints: 22
std::destroy_at(second);
```

`alignas(Order)` is load-bearing. Without it, the array is only guaranteed byte alignment, and constructing an `Order` at a misaligned address has undefined behavior. `std::construct_at` returns a pointer to the newly created object; retain that pointer rather than recovering one from old state.

Destruction runs code but does not overwrite bytes. Inspecting those bytes as if the old `Order` remained alive is still invalid, even when they retain the previous bit pattern. A later construction may reuse the representation for a completely different value.

Storage reuse sometimes needs `std::launder`. An old pointer is not automatically usable for every replacement object, notably when transparent replacement rules do not apply. A complete `const` object is one such case:

```cpp
struct Ticket {
    const int id;
};

void* raw = ::operator new(sizeof(Ticket));
const Ticket* old = ::new (raw) const Ticket{1};
std::cout << old->id << '\n';  // prints: 1
std::destroy_at(old);

::new (raw) const Ticket{2};
const Ticket* current = std::launder(old);
std::cout << current->id << '\n';  // prints: 2

std::destroy_at(current);
::operator delete(raw);
```

The complete `const Ticket` has dynamic storage duration, so its storage may be reused. The original pointer does not automatically retarget the replacement complete `const` object; `std::launder` produces a usable pointer at the same address. Retaining the pointer returned by the second placement-new expression would avoid the need for `std::launder`.

Types with reference or `const` members also make storage-reuse reasoning easy to get wrong when pointers name subobjects. Apply Chapter 16's transparent-replacement rules, and prefer the newly returned pointer whenever construction provides one.

**Pitfall.** Failing to destroy a non-trivial object before abandoning or reusing its storage leaks whatever its destructor owns. Destroying twice, or constructing at an address that does not meet `alignof(T)`, has undefined behavior.

## Hooking the allocator: overloaded allocation functions

A class can provide allocation and deallocation functions. A new-expression first performs class-scope lookup, so every `new Order` can route through storage dedicated to `Order` without changing call sites.

```cpp
class OrderMemory {
public:
    static void* allocate(std::size_t bytes) {
        return ::operator new(bytes);  // pool hook for now
    }

    static void deallocate(void* pointer) noexcept {
        ::operator delete(pointer);
    }
};

struct PooledOrder {
    int id;
    double price;

    static void* operator new(std::size_t bytes) {
        return OrderMemory::allocate(bytes);
    }

    static void operator delete(void* pointer) noexcept {
        OrderMemory::deallocate(pointer);
    }
};
```

If a `PooledOrder` constructor throws, the new-expression finds the matching class-local `operator delete` and returns the storage. Defining only `operator new` while relying on an incompatible deallocation path breaks this symmetry.

The `bytes` argument can exceed the apparent class size when allocation serves a derived object through an inherited allocation function. A class-specific allocator must either support the requested size or reject it deliberately; assuming `bytes == sizeof(PooledOrder)` without checking is unsafe.

Scalar and array allocation functions are separate names. `new PooledOrder[n]` looks for `operator new[]`, not the scalar `operator new` above, and must eventually reach a matching `operator delete[]`.

A program may replace the global allocation functions for diagnostics or policy. This minimal counter uses `std::malloc` internally so the replacement does not recursively call itself:

```cpp
std::size_t allocation_count = 0;

void* operator new(std::size_t bytes) {
    ++allocation_count;
    if (void* pointer = std::malloc(bytes)) {
        return pointer;
    }
    throw std::bad_alloc{};
}

void operator delete(void* pointer) noexcept {
    std::free(pointer);
}

void operator delete(void* pointer, std::size_t) noexcept {
    std::free(pointer);
}

int main() {
    void* block = ::operator new(64);
    std::printf("allocations: %zu\n", allocation_count);
    // prints: allocations: 1
    ::operator delete(block);
}
```

This counter is intentionally single-threaded; Part V supplies synchronization. Production replacements must provide every relevant form, obey alignment and failure contracts, and avoid operations that allocate through `new`. Chapter 18 uses counting as a tripwire for accidental hot-path allocation, while Chapter 19 covers process-level interposition.

Several deallocation signatures carry extra information:

| Form | First standardized | What it supplies |
|---|---:|---|
| `operator delete(void*, std::size_t)` | C++14 | allocation size |
| `operator new(std::size_t, std::align_val_t)` | C++17 | requested extended alignment |
| `operator delete(void*, std::align_val_t)` | C++17 | matching extended alignment |
| destroying `operator delete(T*, std::destroying_delete_t)` | C++20 | destruction delegated to deallocator |

A sized delete can select a size class without recovering the allocation size from separate metadata. The implementation is not required to choose the sized overload at every call site, so a replacement provides the unsized form too.

Lookup considers class-local functions before global ones. Declaring one class-local form can hide global candidates, including aligned forms; an over-aligned class that customizes allocation must provide the signatures its new-expressions require.

An over-aligned new-expression passes `std::align_val_t` and requires a matching aligned deallocation path. A **destroying delete** runs destruction inside the deallocation function rather than before it; it is a niche tool for objects whose dynamic layout affects how they must be destroyed.

**Pitfall.** A global `operator new` that logs through an allocating stream or builds a `std::string` can call itself recursively. Keep the lowest allocation layer independent of allocating facilities.

## Alignment on demand

The ordinary global allocation function returns storage aligned for types whose alignment is at most `__STDCPP_DEFAULT_NEW_ALIGNMENT__`, commonly 16 on 64-bit implementations. A type with stricter **extended alignment** automatically selects the aligned allocation overloads **(C++17)**:

```cpp
struct alignas(64) HotCounter {
    std::uint64_t value{};
};

HotCounter* counter = new HotCounter{};
auto address = reinterpret_cast<std::uintptr_t>(counter);
std::cout << address % 64 << '\n';  // prints: 0
delete counter;
```

Alignment is part of the type, so the matching delete-expression carries the same alignment automatically. Cache-line alignment can isolate frequently modified objects from neighboring data; false-sharing mechanics receive full treatment in Chapters 25–26.

`alignof(T)` reports a type's alignment requirement. Valid object addresses are multiples of that alignment, and array stride preserves it for every element. Over-alignment usually increases `sizeof(T)` through padding so adjacent array elements remain correctly aligned.

The C family provides `std::aligned_alloc`. Its size argument must be an integral multiple of the requested alignment:

```cpp
constexpr std::size_t alignment = 64;
constexpr std::size_t bytes = 128;  // multiple of 64

void* storage = std::aligned_alloc(alignment, bytes);
if (storage == nullptr) {
    throw std::bad_alloc{};
}

auto address = reinterpret_cast<std::uintptr_t>(storage);
std::cout << address % alignment << '\n';  // prints: 0
std::free(storage);
```

Do not assume `std::malloc` supplies 64-byte alignment. It supplies alignment suitable for ordinary fundamental types, not every over-aligned type.

Allocator alignment values are normally powers of two. That property turns rounding into masking arithmetic, but a hand-written bump allocator should still accept alignment as an explicit contract and validate any untrusted value before passing it to `std::align`.

**Pitfall.** Passing a size that is not a multiple of the alignment violates `std::aligned_alloc`'s requirements. Libraries differ in how visibly they report unsupported alignment requests, so round the size deliberately and check for `nullptr`.

`std::hardware_destructive_interference_size` from `<new>` is the standard library's compile-time estimate of spacing that avoids destructive cache-line sharing. It is a portable spelling for an implementation-provided guess, not runtime discovery of the exact machine topology.

## Inside a general-purpose allocator

A general-purpose allocator must handle arbitrary request sizes and deallocation orders. Common designs round small requests into **size classes**, keep a free list per class, and send large requests to operating-system mappings.

| Requested bytes | Illustrative size class | Internal waste |
|---:|---:|---:|
| 24 | 32 | 8 |
| 100 | 112 | 12 |
| 1000 | 1024 | 24 |

These classes are illustrative; real tables are allocator-specific. Rounding lets every block in one free list have the same size, making allocation a fast removal from that list.

Allocators such as tcmalloc and jemalloc add thread caches. A request satisfied from the current thread's cache can avoid a shared lock; refilling or draining that cache may reach shared allocator state. The synchronization details belong to Part V.

Freed small blocks normally remain committed to an allocator rather than returning immediately to the operating system. That choice makes reuse fast, but process-resident memory can stay high after a burst. A thread cache can also strand reusable blocks away from a thread that currently needs them.

Large requests often bypass small size classes and use an operating-system mapping directly. Fresh pages can still fault on first touch, and returning memory may involve page bookkeeping or decommit work.

**Internal fragmentation** is unused space inside an allocated block:

```text
32-byte size-class block
+------------------------+--------+
| 24 bytes requested     | 8 waste|
+------------------------+--------+
```

**External fragmentation** is free space split into holes that cannot satisfy a larger contiguous request:

```text
heap address order
+------+-------+------+-------+------+
| used | free  | used | free  | used |
+------+-------+------+-------+------+
        neither hole alone fits a larger request
```

The total free space can exceed the request while no suitable block exists. A general-purpose allocator may split blocks, coalesce neighboring free blocks, request new pages, or maintain metadata to recover size classes.

Metadata itself consumes memory and cache lines. It may live beside each block, in a page header, or in a separate mapping indexed by address. The placement changes locality and corruption exposure, but the allocator still needs enough information to validate or classify a returned pointer.

Those mechanisms optimize broad workloads, not a strict upper bound for one call. An allocation can encounter a lock, trigger coalescing, request or decommit pages, or fault in fresh physical memory. Tail latency comes from these occasional paths even when the average call is fast.

## The custom-allocator gallery

A custom allocator exploits a restricted allocation pattern. Fewer supported patterns mean less metadata and more predictable operations.

| Allocator | Allocation pattern | Free pattern | Fragmentation | Use when |
|---|---|---|---|---|
| Arena | any size | all at once | alignment padding only | per-batch scratch |
| Stack | any size | LIFO | alignment padding only | nested scratch |
| Free list | one size | random | none between blocks | steady object churn |
| Slab | few sizes | random | per-page slack | many small objects |
| Fixed pool | one type | random | bounded slot slack | bounded live set, hot path |

Every implementation below owns or receives raw bytes. Callers still construct objects with `std::construct_at` and destroy them with `std::destroy_at`.

### Arena and bump allocators

An **arena**, or **bump allocator**, advances one cursor through a buffer. Individual deallocation does nothing; `reset` makes the whole region reusable.

```cpp
class Arena {
public:
    Arena(std::byte* data, std::size_t capacity)
        : begin_(data), capacity_(capacity) {}

    void* allocate(std::size_t bytes, std::size_t alignment) {
        void* candidate = begin_ + used_;
        std::size_t space = capacity_ - used_;
        void* aligned = std::align(alignment, bytes, candidate, space);
        if (aligned == nullptr) {
            throw std::bad_alloc{};
        }
        used_ = static_cast<std::byte*>(aligned) - begin_ + bytes;
        return aligned;
    }

    void reset() noexcept { used_ = 0; }

private:
    std::byte* begin_;
    std::size_t capacity_;
    std::size_t used_{};
};
```

Allocation is alignment arithmetic, an addition, and a bounds check. A market-data batch can allocate temporary decoded fields from one arena, destroy any non-trivial objects, then reset after the batch:

```cpp
alignas(64) std::byte scratch[4096];
Arena arena{scratch, sizeof(scratch)};

void* storage = arena.allocate(sizeof(Order), alignof(Order));
Order* order = std::construct_at(
    static_cast<Order*>(storage), 31, 105.25);
std::cout << order->id << '\n';  // prints: 31
std::destroy_at(order);
arena.reset();
```

A pointer into the arena dangles logically as soon as `reset` permits its bytes to be reused. Capacity and arena lifetime must cover every consumer.

The arena does not remember object boundaries or destructors. That omission is the source of its speed and its main restriction: use trivially destructible scratch values, or keep a separate destruction discipline before reset. Alignment padding and an exhausted tail are reclaimed together, so no holes accumulate between batches.

### Stack allocators

A stack allocator adds a **marker**, an offset that can be restored. Allocations after a marker are discarded in last-in, first-out order:

```cpp
class StackAllocator {
public:
    StackAllocator(std::byte* data, std::size_t capacity)
        : begin_(data), capacity_(capacity) {}

    std::size_t marker() const noexcept { return used_; }

    void* allocate(std::size_t bytes, std::size_t alignment) {
        void* candidate = begin_ + used_;
        std::size_t space = capacity_ - used_;
        void* aligned = std::align(alignment, bytes, candidate, space);
        if (aligned == nullptr) {
            throw std::bad_alloc{};
        }
        used_ = static_cast<std::byte*>(aligned) - begin_ + bytes;
        return aligned;
    }

    void rewind(std::size_t marker) noexcept { used_ = marker; }

private:
    std::byte* begin_;
    std::size_t capacity_;
    std::size_t used_{};
};
```

Nested parsing or pricing calculations can save a marker, create scratch objects, destroy them in reverse order, and rewind. Rewinding past a still-live object makes subsequent reuse violate that object's lifetime.

```cpp
alignas(64) std::byte scratch[4096];
StackAllocator stack{scratch, sizeof(scratch)};

std::size_t outer = stack.marker();
void* storage = stack.allocate(sizeof(Order), alignof(Order));
Order* order = std::construct_at(
    static_cast<Order*>(storage), 32, 105.50);

std::destroy_at(order);
stack.rewind(outer);
```

A marker belongs to one allocator state. Passing an offset from another stack, rewinding forward, or rewinding in non-LIFO order violates the allocator's contract even if the integer fits.

### Free-list allocators

A free list uses each available block to store the pointer to the next block. Allocation pops the head; deallocation pushes a block back.

```cpp
template<class T, std::size_t N>
class FreeList {
    static_assert(N > 0);

    union Slot {
        T object;
        Slot* next;

        Slot() : next(nullptr) {}
        ~Slot() {}
    };

public:
    FreeList() : head_(&slots_[0]) {
        for (std::size_t i = 0; i + 1 < N; ++i) {
            slots_[i].next = &slots_[i + 1];
        }
    }

    void* allocate() {
        if (head_ == nullptr) {
            throw std::bad_alloc{};
        }
        Slot* result = head_;
        head_ = head_->next;  // pop head: O(1)
        return &result->object;
    }

    void deallocate(void* pointer) noexcept {
        Slot* slot = reinterpret_cast<Slot*>(pointer);
        slot->next = head_;    // push head: O(1)
        head_ = slot;
    }

private:
    Slot slots_[N];
    Slot* head_;
};
```

The union makes every slot large and aligned enough for either `T` or a pointer. The caller constructs `T` after `allocate` and destroys it before `deallocate`. A raw byte-block implementation must enforce `block_size >= sizeof(void*)`; otherwise writing the next pointer overruns the block.

This design supports random release order but only one object type and a fixed capacity. It suits steady-state churn of orders or callbacks when a bounded maximum is known.

```cpp
FreeList<Order, 256> free_list;

void* storage = free_list.allocate();
Order* order = std::construct_at(
    static_cast<Order*>(storage), 33, 105.75);

std::destroy_at(order);
free_list.deallocate(order);
```

Neither `allocate` nor `deallocate` checks ownership. Returning a stack address, an interior pointer, or a slot from another free list corrupts the head chain and typically fails later, far from the bad call.

### Slab allocators

A **slab** groups equal-sized slots into pages and tracks live slots per page. Allocation still uses a free list, but an empty page can be returned to the slab's upstream source.

```cpp
template<class T, std::size_t N>
class SlabPage {
    static_assert(N > 0);

    union Slot {
        T object;
        Slot* next;

        Slot() : next(nullptr) {}
        ~Slot() {}
    };

public:
    SlabPage() : free_(&slots_[0]) {
        for (std::size_t i = 0; i + 1 < N; ++i) {
            slots_[i].next = &slots_[i + 1];
        }
    }

    void* allocate() noexcept {
        if (free_ == nullptr) {
            return nullptr;
        }
        Slot* result = free_;
        free_ = free_->next;
        ++live_;
        return &result->object;
    }

    void deallocate(void* pointer) noexcept {
        Slot* slot = reinterpret_cast<Slot*>(pointer);
        slot->next = free_;
        free_ = slot;
        --live_;
    }

    bool empty() const noexcept { return live_ == 0; }

private:
    Slot slots_[N];
    Slot* free_;
    std::size_t live_{};
};
```

A full slab allocator keeps multiple `SlabPage` objects for each supported size and alignment. It selects a page with a free slot, and may return a page only when `empty()` proves that no objects remain. This page-level granularity reduces metadata per object while allowing unused pages to leave the working set.

```cpp
SlabPage<Order, 128> page;
void* storage = page.allocate();
if (storage != nullptr) {
    Order* order = std::construct_at(
        static_cast<Order*>(storage), 34, 106.00);
    std::destroy_at(order);
    page.deallocate(order);
}

std::cout << std::boolalpha << page.empty() << '\n';  // prints: true
```

Grouping pages by size class makes a slab allocator more general than a single typed free list, but less general than `malloc`. Per-page live counts and free-list heads are its deliberate metadata cost.

### Fixed-block and object pools

A fixed-block pool preallocates `N` equal blocks and makes exhaustion behavior explicit. This version returns `nullptr`; another design might assert or divert to a slower allocator.

```cpp
template<std::size_t BlockSize,
         std::size_t BlockAlignment,
         std::size_t N>
class FixedBlockPool {
    static_assert(BlockSize >= sizeof(void*));
    static_assert(N > 0);

    struct alignas(BlockAlignment) Block {
        std::byte bytes[BlockSize];
    };

public:
    static constexpr std::size_t block_size = BlockSize;
    static constexpr std::size_t block_alignment = BlockAlignment;

    FixedBlockPool() : head_(&blocks_[0]) {
        for (std::size_t i = 0; i + 1 < N; ++i) {
            write_next(&blocks_[i], &blocks_[i + 1]);
        }
        write_next(&blocks_[N - 1], nullptr);
    }

    void* allocate() noexcept {
        if (head_ == nullptr) {
            return nullptr;
        }
        Block* result = head_;
        head_ = read_next(head_);  // O(1), no syscall, no lock
        return result->bytes;
    }

    void deallocate(void* pointer) noexcept {
        Block* block = reinterpret_cast<Block*>(pointer);
        write_next(block, head_);  // O(1), no size lookup
        head_ = block;
    }

private:
    static Block* read_next(const Block* block) noexcept {
        Block* next;
        std::memcpy(&next, block->bytes, sizeof(next));
        return next;
    }

    static void write_next(Block* block, Block* next) noexcept {
        std::memcpy(block->bytes, &next, sizeof(next));
    }

    Block blocks_[N];
    Block* head_;
};
```

An **object pool** adds typed lifetime operations over those raw blocks:

```cpp
template<std::size_t N>
class OrderPool {
    using Storage =
        FixedBlockPool<sizeof(Order), alignof(Order), N>;

    static_assert(sizeof(Order) <= Storage::block_size);
    static_assert(alignof(Order) <= Storage::block_alignment);

public:
    Order* acquire(int id, double price) {
        void* block = storage_.allocate();
        if (block == nullptr) {
            return nullptr;  // explicit exhaustion policy
        }

        try {
            return std::construct_at(
                static_cast<Order*>(block), id, price);
        } catch (...) {
            storage_.deallocate(block);
            throw;
        }
    }

    void release(Order* order) noexcept {
        std::destroy_at(order);
        storage_.deallocate(order);
    }

private:
    Storage storage_;
};
```

The pool pays for all slots when it is created. Each steady-state `acquire` is a head-pointer pop plus construction; each `release` is destruction plus a head-pointer push. A bounded order-object pool is a standard trading-system pattern because capacity, allocation cost, and exhaustion policy are all visible.

The fixed pool neither searches by size nor coalesces neighbors. Its maximum live-object count is exactly `N`, so overload is observable rather than converted into unbounded heap growth. The owner must ensure the pool itself outlives every acquired object.

```cpp
OrderPool<1024> orders;

Order* order = orders.acquire(44, 106.50);
if (order != nullptr) {
    std::cout << order->price << '\n';  // prints: 106.5
    orders.release(order);
}
```

These allocators trade generality for contracts:

- Never return a block to a different allocator or pool, even if its size matches.
- Never retain a pointer across an arena reset or stack rewind that covers its allocation.
- Destroy every live non-trivial object before releasing or reusing its block.
- Include alignment padding when advancing through byte storage.
- Decide whether exhaustion returns `nullptr`, throws, asserts, or enters a measured fallback path.

## Arenas on huge pages

Every memory access starts with virtual-to-physical address translation. The processor caches recent translations in a translation lookaside buffer, or **TLB**. A multi-gibibyte arena split into 4 KiB pages needs far more translations than a TLB can hold; a TLB miss triggers a page-table walk involving several dependent memory accesses.

Huge pages reduce the number of translations. A 2 MiB page covers 512 times as much memory as a 4 KiB page, and a 1 GiB page covers 262,144 times as much. The benefit depends on access pattern, working-set size, page-walk caches, and actual huge-page placement, so measure it rather than inferring it from allocation size.

The trade is granularity. Reserving a huge page for a sparsely used arena can waste physical memory, and explicit huge-page allocation can fail when a suitable contiguous page is unavailable. Startup code needs a deliberate fail-or-fallback policy; silently changing page strategy can change latency behavior.

Linux exposes explicit huge pages through `mmap` with `MAP_HUGETLB`, and can request or choose transparent huge pages through `madvise` and system policy. Reservation, NUMA placement, prefaulting, privileges, fallback behavior, and measurement belong to the Linux book in this series.

A common low-latency layout reserves and touches a huge-page-backed arena at startup, then carves arenas or fixed pools from it. Chapter 18 connects those storage strategies to allocator-aware standard containers.

## Latency Lens

- A general-purpose allocation can encounter a lock, coalescing work, a mapping operation, or a first-touch page fault; rare paths create tail-latency spikes.
- A new-expression combines allocation and construction; with a pool, its allocation half can reduce to a free-list head pop.
- Bump allocation performs alignment arithmetic, a pointer advance, and a bounds check; its restriction is all-at-once reclamation.
- A free-list release is a pointer push with no coalescing or size lookup, giving constant work by construction.
- Sized delete can hand the allocation size back to an allocator, avoiding a metadata lookup when the implementation uses the information.
- Size-class rounding creates internal fragmentation that occupies cache capacity and memory bandwidth despite carrying no payload.
- A successful moving `realloc` copies the existing bytes and invalidates every pointer into the old block; reserving capacity avoids surprise growth (Chapter 10).
- Cache-line alignment spends padding to separate hot objects; Chapters 25–26 cover when that prevents false sharing.
- Huge-page-backed arenas need fewer TLB entries for the same virtual range, reducing page-table walks when translation reach is the bottleneck.
- Handling capacity failure during startup keeps allocation checks, unwinding, and page commitment away from the session's hot path.
