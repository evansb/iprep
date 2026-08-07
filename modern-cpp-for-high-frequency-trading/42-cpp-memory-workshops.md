# Chapter 42 — C++ and Memory Workshops

These workshops turn the object model and memory hierarchy into code that can be defended under review. Each exercise begins with a contract, makes capacity and failure explicit, and ends with measurements that can falsify the proposed cost model. The implementations are educational but standards-correct within their stated constraints; production versions would add broader interfaces, diagnostics, and project-specific policies rather than weaken the invariants.

## 42.1 Fixed-Capacity Vector

A **fixed-capacity vector** stores up to `N` objects inline, constructs only live elements, and never allocates. The workshop contract is deliberately smaller than `std::vector`: no copying, insertion only at the end, reverse destruction, stable element addresses until erasure, and a null result when full.

Requirements:

- Capacity is a compile-time positive constant.
- `emplace_back` constructs one element or reports full.
- A throwing constructor does not change `size`.
- `pop_back` and destruction end each live lifetime exactly once.
- No operation returns an iterator or pointer that survives removal of its element.
- Storage meets `T`'s alignment without assuming `T` is trivial.

Separate slots avoid pretending that the raw storage is already a `T[N]` array. Iteration therefore uses an index-aware iterator rather than pointer arithmetic across independently created objects.

```cpp
#include <cstddef>
#include <iterator>
#include <memory>
#include <new>
#include <type_traits>
#include <utility>

template<class T, std::size_t N>
class FixedVector {
    static_assert(N > 0);

    struct Slot {
        alignas(T) std::byte bytes[sizeof(T)];
    };

    T* address(std::size_t index) noexcept {
        return reinterpret_cast<T*>(slots_[index].bytes);
    }

    T* pointer(std::size_t index) noexcept {
        return std::launder(address(index));
    }

    const T* pointer(std::size_t index) const noexcept {
        return std::launder(reinterpret_cast<const T*>(slots_[index].bytes));
    }

public:
    FixedVector() noexcept = default;
    FixedVector(const FixedVector&) = delete;
    FixedVector& operator=(const FixedVector&) = delete;
    FixedVector(FixedVector&&) = delete;
    FixedVector& operator=(FixedVector&&) = delete;

    ~FixedVector() { clear(); }

    [[nodiscard]] static constexpr std::size_t capacity() noexcept { return N; }
    [[nodiscard]] std::size_t size() const noexcept { return size_; }
    [[nodiscard]] bool empty() const noexcept { return size_ == 0; }
    [[nodiscard]] bool full() const noexcept { return size_ == N; }

    template<class... Args>
    T* emplace_back(Args&&... args) {
        if (full()) {
            return nullptr;
        }
        T* result = std::construct_at(
            address(size_), std::forward<Args>(args)...);
        ++size_; // only after successful construction
        return result;
    }

    void pop_back() noexcept(std::is_nothrow_destructible_v<T>) {
        // Precondition: !empty().
        --size_;
        std::destroy_at(pointer(size_));
    }

    void clear() noexcept(std::is_nothrow_destructible_v<T>) {
        while (!empty()) {
            pop_back();
        }
    }

    T& operator[](std::size_t index) noexcept {
        // Precondition: index < size().
        return *pointer(index);
    }

    const T& operator[](std::size_t index) const noexcept {
        return *pointer(index);
    }

    template<bool IsConst>
    class BasicIterator {
        using Owner = std::conditional_t<IsConst, const FixedVector, FixedVector>;
        Owner* owner_{};
        std::size_t index_{};

    public:
        using iterator_category = std::forward_iterator_tag;
        using value_type = T;
        using difference_type = std::ptrdiff_t;
        using reference = std::conditional_t<IsConst, const T&, T&>;

        BasicIterator() = default;
        BasicIterator(Owner* owner, std::size_t index) noexcept
            : owner_(owner), index_(index) {}

        reference operator*() const noexcept { return (*owner_)[index_]; }
        BasicIterator& operator++() noexcept { ++index_; return *this; }
        BasicIterator operator++(int) noexcept {
            BasicIterator previous = *this;
            ++*this;
            return previous;
        }

        friend bool operator==(const BasicIterator&, const BasicIterator&) = default;
    };

    using iterator = BasicIterator<false>;
    using const_iterator = BasicIterator<true>;

    iterator begin() noexcept { return {this, 0}; }
    iterator end() noexcept { return {this, size_}; }
    const_iterator begin() const noexcept { return {this, 0}; }
    const_iterator end() const noexcept { return {this, size_}; }

private:
    Slot slots_[N];
    std::size_t size_{};
};
```

`std::construct_at` and `std::destroy_at` were added in C++20. The call to `address(size_)` forms a suitably aligned candidate address; no `T` may be accessed there until construction succeeds. `size_` counts exactly the live prefix.

The container occupies approximately `N * sizeof(Slot) + sizeof(size_t)`, plus outer padding. Over-aligned `T` can make every slot larger. Capacity is paid even when empty, which is desirable for bounded latency and expensive for sparse objects.

Complexity is exact enough to state directly:

| Operation | Work | Failure |
|---|---|---|
| `emplace_back` | one capacity branch and one construction | null when full; target exception otherwise |
| `operator[]` | slot address plus dereference | precondition violation is undefined behavior |
| `pop_back` | one destruction | precondition violation; throwing destructor terminates in common use |
| `clear` | linear in live elements | destructor policy |
| iteration | linear, with index-aware iterator work | invalid after referenced element dies |

The class advertises conditional `noexcept` for destruction helpers, but C++ destructors are normally nonthrowing by default and throwing during stack unwinding terminates. Low-latency value types should make cleanup nonthrowing and bounded. If destruction performs I/O, releases the last shared owner, or returns memory to a contended allocator, fixed insertion capacity has not made cleanup predictable.

Object construction order also matters for cache state. Slots occupy inline pages before becoming live, but the first write can still fault. Value construction may touch external allocations even though the vector itself does not. Test a trivially stored order record separately from a record containing `std::string` or `std::shared_ptr`.

The implementation deliberately deletes moves. A production move must decide whether moving the container preserves element addresses; inline storage generally means it cannot. Element-wise moving is linear and can fail unless constrained. Hiding that choice behind a default-looking move would make both invalidation and exception behavior unclear.

Test with a counting type whose constructor can throw at a selected call. Assert that live-count equals `size`, failed construction leaves size unchanged, destruction is reverse order, and full insertion returns null. Run:

```sh
c++ -std=c++23 -O2 -Wall -Wextra -Wconversion -pedantic fixed_vector.cpp
c++ -std=c++23 -O1 -g -fsanitize=address,undefined fixed_vector.cpp
```

Benchmark against a reserved `std::vector` under equal capacity and element work. Count allocations separately. The expected benefit is deterministic embedded storage, not automatically faster iteration; `std::vector` has truly contiguous `T` elements and a simpler raw-pointer iterator.

Acceptance tests should include compile-time alignment checks for over-aligned test types, exact destructor order, iterator traversal before and after wrap-free insertions, and a type that is neither default-constructible nor assignable. The last case verifies that raw storage actually avoids unnecessary type requirements.

Discussion prompts: Should full insertion return null, `expected`, or terminate? Is checked indexing on the hot path required? How would erase preserve exception safety? Which API makes address invalidation impossible to misunderstand?

## 42.2 Arena Allocator

An **arena** serves aligned subranges from one backing region and releases them together. Allocation is a pointer adjustment; individual deallocation is absent. This version constructs only trivially destructible objects so `reset` cannot silently skip required cleanup.

```cpp
#include <cstddef>
#include <memory>
#include <span>
#include <type_traits>
#include <utility>

class Arena {
public:
    explicit Arena(std::span<std::byte> storage) noexcept
        : storage_(storage) {}

    [[nodiscard]] void* allocate(std::size_t bytes,
                                 std::size_t alignment) noexcept {
        if (bytes == 0 || alignment == 0 ||
            (alignment & (alignment - 1)) != 0) {
            return nullptr;
        }
        if (used_ >= storage_.size()) {
            return nullptr;
        }

        void* current = storage_.data() + used_;
        std::size_t space = storage_.size() - used_;
        void* aligned = std::align(alignment, bytes, current, space);
        if (aligned == nullptr) {
            return nullptr;
        }

        const auto start = static_cast<std::byte*>(aligned) - storage_.data();
        used_ = static_cast<std::size_t>(start) + bytes;
        return aligned;
    }

    template<class T, class... Args>
    T* make(Args&&... args) {
        static_assert(std::is_trivially_destructible_v<T>,
                      "this arena does not record destructors");
        const std::size_t checkpoint = used_;
        void* memory = allocate(sizeof(T), alignof(T));
        if (memory == nullptr) {
            return nullptr;
        }
        try {
            return std::construct_at(static_cast<T*>(memory),
                                     std::forward<Args>(args)...);
        } catch (...) {
            used_ = checkpoint;
            throw;
        }
    }

    void reset() noexcept { used_ = 0; }
    [[nodiscard]] std::size_t used() const noexcept { return used_; }
    [[nodiscard]] std::size_t remaining() const noexcept {
        return storage_.size() - used_;
    }

private:
    std::span<std::byte> storage_;
    std::size_t used_{};
};
```

The caller owns the backing bytes and must keep them alive and unmoved. Every pointer returned by the arena becomes invalid at `reset` or backing-storage destruction. Reset does not end nontrivial lifetimes, which is why `make` rejects such types. Raw `allocate` remains an expert interface: its caller must establish and end any object lifetime correctly.

Arena ownership should be lexical or phase-based. A parser can create one arena per packet batch, return owning decoded values elsewhere, then reset only after all views are consumed. Returning an arena-backed span from that phase violates the contract even if the bytes have not yet been overwritten. Debug builds can attach an epoch to handles and reject access after reset.

`std::align` handles padding and capacity without overflowing `used + padding + bytes`. The failure path leaves state unchanged. Allocation is constant work for a fixed alignment calculation, but touching newly allocated pages can still fault. Prepare and first-touch the backing region on the intended NUMA node when the operational policy requires it.

A destructor-recording arena can push `(destroy_fn, pointer)` entries into a second bounded stack and run them in reverse at reset. That consumes metadata and makes reset linear with potentially variable destructors. A monotonic parser arena often accepts only trivial decoded nodes instead.

The arena is not thread-safe. Giving each thread its own region removes allocator locks and usually improves locality. Transferring arena-backed objects to another NUMA node retains their original page placement; per-thread ownership does not guarantee consumer-local memory. A shared atomic bump pointer can allocate unique ranges, but reset, construction publication, capacity contention, and wasted alignment gaps need new proofs.

Checkpoint rollback is safe only because no later allocation can interleave on this single-threaded arena. A public checkpoint API would let callers roll back over live objects and create dangling pointers. Keep rollback private to an operation whose allocations have not escaped.

`std::pmr::monotonic_buffer_resource` can use a caller buffer and then request upstream blocks when exhausted. Supplying `std::pmr::null_memory_resource()` as upstream turns exhaustion into `std::bad_alloc`; that exception policy differs from this arena's null result. Compare semantics before comparing speed.

Test every offset and power-of-two alignment in a deliberately misaligned span, capacity exhaustion, constructor throw rollback, and reuse after reset. Compare allocated addresses as integers only for alignment checking; do not subtract unrelated pointers. Measure bytes lost to padding for the actual allocation sequence.

Discussion prompts: Should allocation of zero bytes succeed? Is reset allowed while readers retain views? Does per-message reset create a useful lifetime boundary? Would `std::pmr::monotonic_buffer_resource` meet the contract, and what does it do when its initial buffer fills?

## 42.3 Fixed-Size Object Pool

A **fixed-size object pool** owns `N` equal slots and recycles them in constant time. Raw pointers make stale-reference bugs hard to diagnose, so this workshop returns a handle containing an index and generation.

```cpp
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <new>
#include <type_traits>
#include <utility>

template<class T, std::size_t N>
class ObjectPool {
    static_assert(N > 0);
    static_assert(N < std::numeric_limits<std::uint32_t>::max());
    static_assert(std::is_nothrow_destructible_v<T>,
                  "pool elements must have nothrow destruction");

    struct Slot {
        alignas(T) std::byte storage[sizeof(T)];
        std::uint32_t next{};
        std::uint32_t generation{1};
        bool live{};
    };

public:
    struct Handle {
        std::uint32_t index{};
        std::uint32_t generation{};
    };

    ObjectPool() noexcept {
        for (std::size_t i = 0; i < N; ++i) {
            slots_[i].next = static_cast<std::uint32_t>(i + 1);
        }
        slots_[N - 1].next = invalid;
    }

    ObjectPool(const ObjectPool&) = delete;
    ObjectPool& operator=(const ObjectPool&) = delete;

    ~ObjectPool() noexcept {
        for (Slot& slot : slots_) {
            if (slot.live) {
                std::destroy_at(pointer(slot));
            }
        }
    }

    template<class... Args>
    Handle create(Args&&... args) {
        if (free_head_ == invalid) {
            return {invalid, 0};
        }
        const std::uint32_t index = free_head_;
        Slot& slot = slots_[index];
        free_head_ = slot.next;
        try {
            std::construct_at(address(slot), std::forward<Args>(args)...);
            slot.live = true;
            ++live_count_;
            return {index, slot.generation};
        } catch (...) {
            slot.next = free_head_;
            free_head_ = index;
            throw;
        }
    }

    T* get(Handle handle) noexcept {
        if (handle.index >= N) return nullptr;
        Slot& slot = slots_[handle.index];
        if (!slot.live || slot.generation != handle.generation) return nullptr;
        return pointer(slot);
    }

    bool erase(Handle handle) noexcept {
        T* object = get(handle);
        if (object == nullptr) return false;
        Slot& slot = slots_[handle.index];
        std::destroy_at(object);
        slot.live = false;
        ++slot.generation; // wrap policy discussed below
        slot.next = free_head_;
        free_head_ = handle.index;
        --live_count_;
        return true;
    }

    [[nodiscard]] std::size_t size() const noexcept { return live_count_; }

private:
    static constexpr std::uint32_t invalid =
        std::numeric_limits<std::uint32_t>::max();

    static T* address(Slot& slot) noexcept {
        return reinterpret_cast<T*>(slot.storage);
    }

    static T* pointer(Slot& slot) noexcept {
        return std::launder(address(slot));
    }

    std::array<Slot, N> slots_{};
    std::uint32_t free_head_{};
    std::size_t live_count_{};
};
```

The live/free invariant is exclusive: every slot is either reachable exactly once from the free list or contains one live `T`. Failed construction returns its slot. Erase rejects a stale generation and double erase.

Generation wrap reintroduces an ABA-like stale-handle match after `2^32` reuse cycles of one slot. Production policy can use 64-bit generations, stop before wrap, or combine a wider session epoch. No finite tag makes arbitrary stale retention impossible forever.

The pool uses `sizeof(Slot) * N` inline bytes. `bool`, generation, and next metadata can add substantial padding for small `T`. A separate metadata array improves payload density but touches another cache line. Free-list reuse tends to use recently freed slots; that can help locality or concentrate false sharing across threads. This implementation is single-threaded. Adding atomics to `free_head_` does not make object lifetime and reclamation thread-safe.

Allocation and erase are constant-step operations excluding `T` construction/destruction. `get` performs bounds, live, and generation checks. Those branches are usually predictable for valid handles, but stale-message traffic can change the distribution. A raw-pointer pool removes checks while moving stale-use detection out of the type system.

The pool destructor scans all `N` slots, not only live ones. That gives simple cleanup but makes shutdown linear in capacity. Maintaining a live list can reduce sparse shutdown work at the cost of per-operation links and another invariant. Shutdown is outside the trading path in many systems, yet failover time can still make it operationally important.

The generation increment occurs after destruction and before the slot returns to the free list. A new handle therefore cannot equal the immediately erased handle. The class-level nothrow-destructor constraint is part of the pool's invariant: it prevents `erase` or pool shutdown from observing an ended object lifetime while the metadata still says the slot is live.

Test exhaustion, randomized create/erase against a reference model, throwing constructors, stale handles, generation increment, and destructor counts. A million-operation fuzz test is useful but does not replace invariant assertions. Run AddressSanitizer and UndefinedBehaviorSanitizer; use a small generation type in a test-only version to force wrap.

Track pool high-water mark and allocation failures in production without placing one contended atomic on every allocation. Per-thread counters or owner-thread metrics preserve the single-threaded contract. Capacity should be selected from a workload bound plus recovery policy, not from one historical maximum.

Discussion prompts: Does the caller need a stable pointer or only a handle? Which thread owns erase? What should full mean for an order table? Would per-core pools and remote-free queues reduce contention?

## 42.4 Small-Buffer Callable Wrapper

A **small-buffer callable wrapper** type-erases a callable into inline storage when it fits. This workshop implements a move-only, fixed-storage function. It never allocates and rejects targets that are too large, over-aligned, or potentially throwing on move.

```cpp
#include <cstddef>
#include <concepts>
#include <functional>
#include <memory>
#include <new>
#include <type_traits>
#include <utility>

template<class Signature, std::size_t Bytes>
class FixedFunction;

template<class R, std::size_t Bytes, class... Args>
class FixedFunction<R(Args...), Bytes> {
    static_assert(Bytes > 0);
    using Invoke = R (*)(void*, Args&&...);
    using Destroy = void (*)(void*) noexcept;
    using Move = void (*)(void*, void*) noexcept;

public:
    FixedFunction() noexcept = default;
    FixedFunction(std::nullptr_t) noexcept {}

    template<class F>
        requires (!std::same_as<std::remove_cvref_t<F>, FixedFunction> &&
                  std::is_invocable_r_v<R, std::decay_t<F>&, Args...>)
    FixedFunction(F&& function) {
        using Target = std::decay_t<F>;
        static_assert(sizeof(Target) <= Bytes, "callable exceeds inline capacity");
        static_assert(alignof(Target) <= alignof(Storage), "callable is over-aligned");
        static_assert(std::is_nothrow_move_constructible_v<Target>,
                      "nothrow wrapper move requires nothrow target move");
        static_assert(std::is_nothrow_destructible_v<Target>,
                      "wrapper reset requires nothrow target destruction");

        std::construct_at(reinterpret_cast<Target*>(&storage_),
                          std::forward<F>(function));
        invoke_ = [](void* p, Args&&... args) -> R {
            return std::invoke(*static_cast<Target*>(p),
                               std::forward<Args>(args)...);
        };
        destroy_ = [](void* p) noexcept {
            std::destroy_at(static_cast<Target*>(p));
        };
        move_ = [](void* from, void* to) noexcept {
            auto* source = static_cast<Target*>(from);
            std::construct_at(static_cast<Target*>(to), std::move(*source));
            std::destroy_at(source);
        };
    }

    FixedFunction(const FixedFunction&) = delete;
    FixedFunction& operator=(const FixedFunction&) = delete;

    FixedFunction(FixedFunction&& other) noexcept { move_from(other); }

    FixedFunction& operator=(FixedFunction&& other) noexcept {
        if (this != &other) {
            reset();
            move_from(other);
        }
        return *this;
    }

    ~FixedFunction() { reset(); }

    explicit operator bool() const noexcept { return invoke_ != nullptr; }

    R operator()(Args... args) {
        if (invoke_ == nullptr) throw std::bad_function_call{};
        return invoke_(&storage_, std::forward<Args>(args)...);
    }

    void reset() noexcept {
        if (destroy_ != nullptr) destroy_(&storage_);
        invoke_ = nullptr;
        destroy_ = nullptr;
        move_ = nullptr;
    }

private:
    struct alignas(std::max_align_t) Storage {
        std::byte bytes[Bytes];
    };

    void move_from(FixedFunction& other) noexcept {
        if (!other) return;
        other.move_(&other.storage_, &storage_);
        invoke_ = std::exchange(other.invoke_, nullptr);
        destroy_ = std::exchange(other.destroy_, nullptr);
        move_ = std::exchange(other.move_, nullptr);
    }

    Storage storage_;
    Invoke invoke_{};
    Destroy destroy_{};
    Move move_{};
};
```

The wrapper’s size is `Bytes` rounded for `max_align_t`, plus three function pointers and padding. Invocation performs an indirect call. There is no universal “small buffer” size; 32 embedded bytes can make every callback record much larger even when most targets are empty.

The storage bytes are intentionally not value-initialized. An empty wrapper has no live target, so clearing its inline capacity would spend memory bandwidth without changing semantics. The operation pointers are initialized to null and determine whether storage may be accessed.

The target constructor may throw, but the wrapper has not published its operation table then, so ordinary object construction unwinds safely. Wrapper movement cannot throw because targets are constrained. Target invocation retains its own exception behavior. A hot-path interface can choose a `noexcept` signature and constrain `is_nothrow_invocable`, but this implementation does not pretend all callbacks are nonthrowing.

Operation-table installation occurs after successful construction. Move constructs the target before transferring the three function pointers; the nothrow constraint means it cannot leave two wrappers believing they own one target. `reset` destroys before nulling pointers, which is sound because accepted targets are statically required to have nonthrowing destructors.

This wrapper is move-only, matching ownership of a captured `unique_ptr`. Copy support would require a fourth clone function and a policy for targets whose copy throws. `std::function` provides copyable type erasure and may allocate depending on target and implementation; C++23 `std::move_only_function` provides a standard move-only abstraction but does not guarantee a fixed inline capacity or no allocation.

The constructor uses the C++20 `std::same_as` concept to exclude accidental self-wrapping. Header self-sufficiency is part of the wrapper's contract; every non-core name used by the listing is included directly.

Test empty call, mutable lambdas, move-only captures, destructor counts, constructor failure, move chains, reference and value arguments, void and non-void results, and compile-time rejection of oversize targets. Compare against `std::function` and C++23 `std::move_only_function`, inspecting allocation with a test allocator and code size with `size`/`nm`.

Inspect one invocation in optimized assembly. Expect loading an invoke pointer and an indirect call unless the compiler can see through the wrapper and devirtualize under whole-program optimization. Verify the target object begins at suitably aligned storage and that no heap symbols appear in construction for accepted callables.

Discussion prompts: Should empty invocation terminate instead of throw? Should over-aligned targets be supported with larger storage alignment? When does one indirect call cost less than template-instantiated code growth?

## 42.5 AoS and SoA Order-Book Comparison

An **array of structures** (AoS) stores complete records together; a **structure of arrays** (SoA) stores each field in a separate contiguous sequence. Compare them by operation, not by slogan.

```cpp
#include <array>
#include <cstddef>
#include <cstdint>

constexpr std::size_t levels = 1'024;

struct Level {
    std::int64_t price_ticks;
    std::uint32_t quantity;
    std::uint32_t order_count;
};

using AoSBook = std::array<Level, levels>;

struct SoABook {
    std::array<std::int64_t, levels> prices;
    std::array<std::uint32_t, levels> quantities;
    std::array<std::uint32_t, levels> order_counts;
};

std::uint64_t total_quantity(const AoSBook& book) noexcept {
    std::uint64_t total = 0;
    for (const Level& level : book) total += level.quantity;
    return total;
}

std::uint64_t total_quantity(const SoABook& book) noexcept {
    std::uint64_t total = 0;
    for (std::uint32_t quantity : book.quantities) total += quantity;
    return total;
}
```

Both books contain the same logical values. The AoS quantity scan fetches price and count bytes that it does not use. SoA exposes a dense four-byte stream and is easier to vectorize. An update that reads and writes all fields at one level can favor AoS because one or adjacent cache lines contain the record.

State the invariants before benchmarking. Prices are ordered or mapped by a separate index; array position has defined meaning; unused levels have a sentinel or active mask; totals use a wide enough accumulator. A representation benchmark that skips validation required by one layout is not equal work.

Requirements for a fair benchmark:

- Generate identical values and validate equal results.
- Measure scans, point updates, best-level lookup, and snapshots separately.
- Prevent constant folding and dead-code removal.
- Warm or cold both representations under the same policy.
- Report `sizeof`, alignment, pages, compiler, flags, and vectorization reports.
- Randomize test order and use a realistic level-access distribution.

Compile diagnostics:

```sh
c++ -std=c++23 -O3 -march=TARGET -fopt-info-vec-all layout.cpp
perf stat -e cycles,instructions,cache-misses ./layout_bench
```

Replace `TARGET` with the documented deployment ISA; do not publish `-march=native` binaries without controlling hosts. Counter names and access depend on the CPU and kernel.

SoA uses three base addresses and can increase address-generation work for multi-field updates. It also lets cold fields move to another array or NUMA policy. AoS makes one record copy convenient and defines one coherence unit only accidentally: hardware transfers cache lines, not C++ structures.

Snapshot cost differs. Copying one AoS array moves all fields in one contiguous range. SoA can copy only fields requested by a consumer, but a consistent multi-array snapshot needs versioning or single-writer coordination. Reading prices from epoch A and quantities from epoch B is a semantic failure, not a cache optimization.

An active bitmap can let either representation skip empty levels, adding branches or bit scanning. Dense scans have predictable work; sparse scans reduce bytes only when the index itself is efficient. Use the venue's price range and occupancy distribution.

Add capacity utilization. A fixed 1,024-level book pays for every level, while a sparse tree pays nodes, pointers, allocator metadata, and cache misses. The benchmark comparison is valid only for markets and price mappings where dense fixed indexing is semantically appropriate.

Discussion prompts: Would an array-of-small-structures grouping hot fields be better? Which representation minimizes bytes for risk scans? Which creates false sharing when one thread updates quantities and another reads prices?

## 42.6 Lifetime, Aliasing, and Exception-Safety Bug Hunts

A bug hunt is complete only when it names the violated rule, supplies a corrected ownership or transaction boundary, and explains why optimization can expose the failure.

**Bug 1: dangling view.**

```cpp
// BROKEN
std::string_view symbol() {
    std::string text = "EUR/USD";
    return text;
}
```

The view does not own bytes; destruction of `text` ends their lifetime. Return an owning `std::string`, a view into static storage, or a view whose owner is passed by the caller. Small-string optimization does not help: it makes the view point into the destroyed local object.

**Bug 2: packet overlay.**

```cpp
// BROKEN
const auto* header = reinterpret_cast<const Header*>(packet.data() + 1);
return header->sequence;
```

The address may be misaligned, no `Header` lifetime has been established, aliasing can be invalid, structure padding is not a wire format, and byte order is ignored. Check bounds, `memcpy` each fixed-width field into an aligned integer, then convert endianness. Compilers commonly optimize small constant-size copies.

**Bug 3: published before construction commits.**

```cpp
// BROKEN scaffold
Widget* p = pool.reserve();
registry.insert(id, p);       // can throw; p is not a live Widget
std::construct_at(p, args);   // can throw after publication
```

Construct first under a reservation guard that returns the slot on failure. Insert a handle only after construction succeeds. If registry insertion throws, destroy the object and release the slot. The transaction commits by publishing the handle last.

**Bug 4: invalidated element pointer.**

```cpp
// BROKEN
auto* best = &levels.front();
levels.push_back(new_level); // may reallocate
use(*best);
```

Reserve enough capacity before taking the pointer, use an index and reacquire after growth, choose a fixed-capacity container, or redesign ownership. Reserving is a runtime invariant; another path must not exceed it.

**Bug 5: exception-unsafe replacement.**

```cpp
// BROKEN for throwing assignment policy
delete current;
current = new Widget(config); // current dangles if allocation/construction throws
```

Construct into `std::unique_ptr<Widget> replacement` first, then swap ownership. This gives the strong guarantee when construction does not mutate shared state. On a nonthrowing hot path, a bounded pool and fallible factory can express the same commit order without heap allocation.

Verification combines compiler warnings, sanitizers, failure injection, and code review:

```sh
c++ -std=c++23 -O1 -g -fsanitize=address,undefined bug_hunts.cpp
c++ -std=c++23 -O1 -g -D_GLIBCXX_ASSERTIONS bug_hunts.cpp
```

Sanitizers find exercised faults, not all lifetime or exception paths. Force every constructor and registry operation to fail at each step, count live objects, and assert that ownership graphs return to their initial state.

Compile broken and corrected variants at `-O0` and `-O3`. The dangling or aliasing bug may appear stable without optimization and fail after inlining or load elimination; that difference is evidence of undefined behavior, not an optimizer defect. Enable `-Werror=return-local-addr` and lifetime diagnostics available in the selected compiler, while recognizing that views can hide the returning local from simple analysis.

For exception safety, draw states and commit points:

```text
free slot -> constructed but private -> registry published
    ^              | failure                 |
    +-- rollback --+                         +-- normal erase -> destroyed -> free
```

Every arrow must either complete or leave a state the cleanup code understands. Logging or metrics inside rollback can throw or allocate too; keep recovery primitives simpler than the operation they protect.

Discussion prompts: Which fixes allocate? Which preserve pointer stability? Can a compiler warning catch the problem? What is the hot-path tail when the correction’s failure branch executes?

## 42.7 Interview Check

1. State the lifetime invariant of `FixedVector`. Why is incrementing size before construction incorrect?
2. What iterator and pointer invalidation rules should a fixed-capacity vector publish, and how do they differ from `std::vector`?
3. Why does the arena restrict `make` to trivially destructible types? Design bounded destructor recording.
4. Compare arena exhaustion policies for packet parsing: null result, exception, upstream rejection, and fallback allocation.
5. Prove the object pool’s live/free invariant. How does constructor failure restore it?
6. Why does a finite generation counter mitigate rather than eliminate stale-handle ABA?
7. Calculate the exact footprint of `FixedFunction<void(), 32>` on the target ABI and identify each indirect operation.
8. Design tests that prove the callable wrapper destroys each target once across moves and exceptions.
9. Predict whether AoS or SoA wins for quantity scans, full-level updates, and cross-core snapshots; then specify counters that test the prediction.
10. Repair each bug hunt while stating ownership, lifetime, failure guarantee, and resulting hot-path work.
