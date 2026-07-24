# 18. Allocator-Aware C++

Containers own their elements but need not hard-code where element storage comes from. An allocator connects `std::vector`, `std::map`, `std::string`, and other containers to the arenas and pools from Chapter 17. The connection can be static through a template argument or dynamic through `std::pmr`.

## Allocation strategy as a container parameter

Container logic and storage policy are orthogonal. A vector manages capacity, contiguous layout, and element movement; its allocator supplies raw storage for that capacity.

Internally, an allocator-aware container performs the split from Chapter 17:

1. Ask its allocator for suitably sized and aligned raw storage.
2. Construct elements in that storage, normally through `std::allocator_traits`.
3. Destroy elements when their lifetimes end.
4. Return raw storage through the same allocator.

`reserve` obtains storage without creating new elements, while `emplace_back` constructs an element in available storage (Chapter 10). A node container asks its allocator for nodes instead of one contiguous buffer.

Given Chapter 17's `Arena` and the adapter from the next section, a vector can place its buffer inside caller-owned bytes:

```cpp
void arena_vector_demo() {
    alignas(std::max_align_t) std::byte storage[4096];
    Arena arena{storage, sizeof(storage)};
    ArenaAllocator<Order> allocator{arena};

    std::vector<Order, ArenaAllocator<Order>> orders{allocator};
    orders.reserve(16);
    orders.emplace_back(1, 100.25);

    auto address = reinterpret_cast<std::uintptr_t>(orders.data());
    auto begin = reinterpret_cast<std::uintptr_t>(storage);
    std::cout << std::boolalpha
              << (address >= begin && address < begin + sizeof(storage))
              << '\n';  // prints: true
}
```

The vector still controls when objects are constructed and destroyed. The arena controls where its capacity bytes live and makes individual deallocation a no-op.

Dynamic sequence containers such as `std::vector`, `std::deque`, and `std::list`, plus associative, unordered, and string containers, are allocator-aware. `std::array` stores elements inline and needs no allocator. The allocator is part of a dynamic container's type and state, so it also affects copying, moving, and swapping.

## The classic allocator interface

A minimal allocator **(C++17)** provides a `value_type`, an `allocate(n)` member, a matching `deallocate(p, n)` member, and equality. A converting constructor from `A<U>` preserves state when a container rebinds the allocator to an internal node type; the template mechanics belong to Chapter 20.

`std::allocator_traits<A>` is the standard adapter around an allocator. It fills in defaults for pointer types, construction, destruction, size limits, and propagation traits. Containers call the traits interface rather than assuming every optional member exists on `A`.

This complete allocator counts allocation and deallocation calls while forwarding storage to the global allocation functions:

```cpp
#include <cstddef>
#include <iostream>
#include <limits>
#include <memory>
#include <new>
#include <type_traits>
#include <vector>

struct AllocationCounts {
    std::size_t allocations{};
    std::size_t deallocations{};
};

inline AllocationCounts default_counts;

template<class T>
class CountingAllocator {
    template<class>
    friend class CountingAllocator;

public:
    using value_type = T;

    CountingAllocator() noexcept : counts_(&default_counts) {}
    explicit CountingAllocator(AllocationCounts& counts) noexcept
        : counts_(&counts) {}

    template<class U>
    CountingAllocator(const CountingAllocator<U>& other) noexcept
        : counts_(other.counts_) {}

    T* allocate(std::size_t count) {
        if (count > std::numeric_limits<std::size_t>::max() / sizeof(T)) {
            throw std::bad_array_new_length{};
        }
        void* storage = ::operator new(count * sizeof(T));
        ++counts_->allocations;
        return static_cast<T*>(storage);
    }

    void deallocate(T* pointer, std::size_t) noexcept {
        ++counts_->deallocations;
        ::operator delete(pointer);
    }

    template<class U>
    bool operator==(const CountingAllocator<U>& other) const noexcept {
        return counts_ == other.counts_;
    }

    template<class U>
    bool operator!=(const CountingAllocator<U>& other) const noexcept {
        return !(*this == other);
    }

private:
    AllocationCounts* counts_;
};

static_assert(std::is_same_v<
    std::vector<int, CountingAllocator<int>>::value_type, int>);

int main() {
    AllocationCounts counts;
    {
        std::vector<int, CountingAllocator<int>> values{
            CountingAllocator<int>{counts}};
        values.reserve(4);
        values.push_back(42);
    }

    std::cout << counts.allocations << ' '
              << counts.deallocations << '\n';  // prints: 1 1
}
```

The counter increments only after `::operator new` succeeds. Allocators normally receive element counts, not byte counts, so `allocate` checks the multiplication before performing it.

An arena adapter has the same interface but delegates to the bump pointer:

```cpp
template<class T>
class ArenaAllocator {
    template<class>
    friend class ArenaAllocator;

public:
    using value_type = T;

    explicit ArenaAllocator(Arena& arena) noexcept : arena_(&arena) {}

    template<class U>
    ArenaAllocator(const ArenaAllocator<U>& other) noexcept
        : arena_(other.arena_) {}

    T* allocate(std::size_t count) {
        if (count > std::numeric_limits<std::size_t>::max() / sizeof(T)) {
            throw std::bad_array_new_length{};
        }
        return static_cast<T*>(
            arena_->allocate(count * sizeof(T), alignof(T)));
    }

    void deallocate(T*, std::size_t) noexcept {}

    template<class U>
    bool operator==(const ArenaAllocator<U>& other) const noexcept {
        return arena_ == other.arena_;
    }

    template<class U>
    bool operator!=(const ArenaAllocator<U>& other) const noexcept {
        return !(*this == other);
    }

private:
    Arena* arena_;
};
```

Two instances compare equal only when either can safely deallocate storage obtained through the other. For this adapter, that means they refer to the same arena. Claiming equality for different arenas can eventually send storage back to the wrong owner.

The `count` passed to `deallocate` matches the allocation being returned; it is not the container's current `.size()`. An arena may ignore both arguments because it reclaims everything together, but a size-class allocator can use them to select the correct free list. The arena itself must not reset while any container still holds its storage.

The allocator type is part of the container type:

```cpp
using Counted = std::vector<int, CountingAllocator<int>>;
using ArenaBacked = std::vector<int, ArenaAllocator<int>>;

static_assert(!std::is_same_v<Counted, ArenaBacked>);
```

An `ArenaBacked` object cannot be passed to a function taking `std::vector<int>&`, and direct assignment between these two types is ill-formed. Runtime-polymorphic allocators solve this type-fragmentation problem in the flagship section.

**Pitfall.** Omitting `value_type` prevents `std::allocator_traits` from adapting the class. More dangerous is an equality operator that lies: containers use equality to decide whether one allocator may release another allocator's storage.

## Propagation and equality — survey level

Allocator state does not automatically travel with every container operation. Three traits control propagation:

| Operation | Trait | If `false` — the default |
|---|---|---|
| Copy assignment | `propagate_on_container_copy_assignment` | keep destination allocator; copy elements |
| Move assignment | `propagate_on_container_move_assignment` | steal if equal; otherwise move elements |
| `swap` | `propagate_on_container_swap` | equal is valid; unequal is UB |

These long names are commonly shortened to POCCA, POCMA, and POCS. `std::allocator_traits` supplies `std::false_type` defaults when an allocator does not declare them.

A move between unequal, non-propagating allocators cannot hand the destination a buffer owned by the source arena:

```cpp
void show_allocator_propagation() {
    alignas(std::max_align_t) std::byte left_bytes[4096];
    alignas(std::max_align_t) std::byte right_bytes[4096];
    Arena left_arena{left_bytes, sizeof(left_bytes)};
    Arena right_arena{right_bytes, sizeof(right_bytes)};

    using Orders = std::vector<Order, ArenaAllocator<Order>>;
    Orders source{ArenaAllocator<Order>{left_arena}};
    Orders destination{ArenaAllocator<Order>{right_arena}};
    source.emplace_back(1, 100.25);

    destination = std::move(source);
    // O(n): elements move into right_arena; no pointer steal

    Orders first{ArenaAllocator<Order>{left_arena}};
    Orders second{ArenaAllocator<Order>{right_arena}};
    first.swap(second);  // UB: unequal, non-propagating allocators
}
```

The element-wise fallback may allocate from the destination, move each element, and destroy the source elements. The familiar constant-time vector move is therefore conditional on allocator propagation or equality.

**Rule.** Make allocator instances always equal only when they are genuinely interchangeable. Otherwise, keep containers tied to one allocator instance and do not swap them across storage domains.

Nested containers add one more handoff. `std::scoped_allocator_adaptor` passes an outer allocator's inner allocator into allocator-aware elements:

```cpp
void build_nested_strings() {
    using CharAllocator = ArenaAllocator<char>;
    using ArenaString =
        std::basic_string<char, std::char_traits<char>, CharAllocator>;
    using OuterAllocator = std::scoped_allocator_adaptor<
        ArenaAllocator<ArenaString>, CharAllocator>;

    alignas(std::max_align_t) std::byte string_bytes[4096];
    Arena string_arena{string_bytes, sizeof(string_bytes)};
    OuterAllocator allocator{
        ArenaAllocator<ArenaString>{string_arena},
        CharAllocator{string_arena}};
    std::vector<ArenaString, OuterAllocator> symbols{allocator};
    symbols.emplace_back("EURUSD");
}
```

Without the adaptor, the outer vector's allocator does not automatically become the inner string's allocator. PMR nested containers propagate their resource through allocator-aware construction by default, which removes most reasons to write this type machinery directly.

**Interview.** “A vector move is constant time” needs a qualifier. A strong answer checks allocator propagation and equality, then distinguishes move construction from move assignment.

## PMR: the practical path

The polymorphic memory-resource library, `std::pmr`, **(C++17)** keeps the allocator type stable while choosing storage policy at runtime. `std::pmr::polymorphic_allocator<T>` stores a pointer to a `std::pmr::memory_resource`, an abstract base class with virtual allocation and deallocation.

`std::pmr::vector<int>` is an alias for:

```cpp
using PmrIntVector =
    std::vector<int, std::pmr::polymorphic_allocator<int>>;

static_assert(std::is_same_v<PmrIntVector, std::pmr::vector<int>>);
```

The type remains the same whether its resource is a bump arena, a pool, or the global heap. `std::pmr` also supplies aliases for strings, ordered and unordered containers, deques, and lists.

A PMR container generally stores one resource pointer as allocator state; exact empty-base and object layout details remain implementation-specific. Nodes need not store another resource pointer, but each node allocation dispatches through the container's resource.

A custom resource derives from `std::pmr::memory_resource` and overrides `do_allocate`, `do_deallocate`, and `do_is_equal`. Chapter 17 supplies the raw strategies those virtual functions can wrap; no allocator rebind machinery is required.

Resource equality carries the same promise as classic allocator equality: either resource may deallocate storage obtained from the other. Identity is the common answer, but `do_is_equal` permits distinct resource objects that genuinely share one storage domain.

The trade is explicit:

| Property | Classic allocator | `std::pmr` allocator |
|---|---|---|
| Strategy selection | compile time | runtime resource pointer |
| Container type | changes with allocator | stable |
| Allocation dispatch | usually inline | virtual resource call |
| Stored allocator state | allocator-dependent | resource pointer |
| Nested propagation | adaptor when needed | resource propagated |

One virtual call per allocation or deallocation is usually noise beside `malloc`, but it can be visible beside an inlined pointer bump (Chapter 4). Containers do not allocate per element when capacity already exists, so correct reservation amortizes that dispatch too.

### Monotonic resources

`std::pmr::monotonic_buffer_resource` is the standard bump arena. It serves aligned allocations in increasing address order, ignores individual deallocations, and releases all owned upstream blocks together.

This message handler uses a stack buffer and refuses to fall back to the heap:

```cpp
struct Fill {
    std::uint64_t order_id;
    std::int64_t price_ticks;
};

std::size_t count_fills(std::span<const std::byte> message) {
    alignas(std::max_align_t) std::byte buffer[4096];
    std::pmr::monotonic_buffer_resource arena{
        buffer,
        sizeof(buffer),
        std::pmr::null_memory_resource()
    };
    std::pmr::vector<Fill> fills{&arena};
    fills.reserve(message.size() / sizeof(Fill));

    for (std::size_t offset = 0;
         offset + sizeof(Fill) <= message.size();
         offset += sizeof(Fill)) {
        Fill fill;
        std::memcpy(&fill, message.data() + offset, sizeof(fill));
        fills.push_back(fill);
    }

    return fills.size();
}  // no individual frees; arena and stack buffer leave scope
```

The initial buffer supplies every successful allocation. If the vector outgrows it, `std::pmr::null_memory_resource()` throws `std::bad_alloc` instead of silently reaching the heap. That makes a capacity assumption executable in tests.

Destroying the vector still destroys its elements. Its calls to deallocate reach the monotonic resource and do nothing; destroying the arena then releases any upstream blocks as one group.

Resources form upstream chains. A resource asks its upstream only when it cannot satisfy a request itself; the default upstream is `std::pmr::new_delete_resource()`.

### Pool resources

A pool resource groups requests into size classes and reuses freed blocks, applying Chapter 17's pool mechanics behind the PMR interface:

```cpp
void build_pooled_orders() {
    alignas(std::max_align_t) std::byte backing[64 * 1024];
    std::pmr::monotonic_buffer_resource arena{
        backing,
        sizeof(backing),
        std::pmr::null_memory_resource()
    };
    std::pmr::pool_options options;
    options.max_blocks_per_chunk = 4;
    options.largest_required_pool_block = 4096;
    std::pmr::unsynchronized_pool_resource pool{options, &arena};

    std::pmr::vector<Order> orders{&pool};
    orders.reserve(256);
}
```

Requests flow from the vector to the pool, then to the monotonic arena when a size-class chunk needs replenishment. The null resource terminates the chain and turns exhaustion into `std::bad_alloc`.

`std::pmr::pool_options` tunes the largest pooled block and the number of blocks obtained per replenishment. Requests larger than `largest_required_pool_block` go directly upstream. Implementations may adjust the requested values; `pool.options()` reports the values actually in force.

`std::pmr::unsynchronized_pool_resource` performs no locking and is for access from one thread. `std::pmr::synchronized_pool_resource` supports shared access by taking a lock; synchronization details wait until Part V. Pools fit heavy allocation churn with clustered sizes and random deallocation, while monotonic resources fit all-at-once reclamation.

A PMR string's ordinary copy construction does not copy its source resource:

```cpp
void copy_pmr_string() {
    std::byte buffer[1024];
    std::pmr::monotonic_buffer_resource arena{buffer, sizeof(buffer)};
    std::pmr::string source{"EURUSD", &arena};

    std::pmr::string accidental = source;
    std::pmr::string intended{source, source.get_allocator()};

    std::cout << std::boolalpha
              << (accidental.get_allocator().resource()
                  == std::pmr::get_default_resource())
              << '\n';  // prints: true
}
```

The destination context chooses the allocator. Likewise, a temporary `std::pmr::vector` constructed without a resource uses the current default resource, normally `new_delete_resource`.

**Pitfall.** Adding `pmr::` to a type name does not select an arena. Pass the intended resource at every ownership boundary, and check copies whose destination context differs.

## Resource lifetime and ownership

`std::pmr::polymorphic_allocator` stores a raw `memory_resource*`; it does not own or extend the resource's lifetime. The resource must outlive every container that uses it, including the container's final deallocation call.

Returning a container backed by a local resource creates two dangling dependencies:

```cpp
std::pmr::vector<int> make_bad_values() {
    std::byte buffer[1024];
    std::pmr::monotonic_buffer_resource arena{
        buffer, sizeof(buffer)};
    std::pmr::vector<int> values{&arena};
    values.push_back(42);
    return values;  // returned allocator and buffer both dangle
}

void use_bad_values() {
    auto values = make_bad_values();
    std::cout << values[0] << '\n';  // UB: local resource is destroyed
}
```

The vector's elements point into a dead stack buffer, and its allocator points to a destroyed resource. AddressSanitizer often catches the element access; the eventual vector destructor can also call through the dangling resource pointer.

Put the resource and its users in one owner. Members are destroyed in reverse declaration order (Chapter 5), so declare the resource first:

```cpp
class SessionBook {
public:
    SessionBook() : orders_(&resource_) {
        orders_.reserve(4096);
    }

    void add(Order order) {
        orders_.push_back(std::move(order));
    }

private:
    std::pmr::unsynchronized_pool_resource resource_;
    std::pmr::vector<Order> orders_;
};
```

`orders_` is destroyed before `resource_`. Reversing the declarations would destroy the resource first and leave the vector's destructor with a dangling allocator.

Choose the resource from the data lifetime:

| Data lifetime | Resource | Reset policy | Owner |
|---|---|---|---|
| Per message | stack `monotonic_buffer_resource` | scope end | handler frame |
| Per session | pool over arena | session teardown | session object; resource first |
| Process lifetime | preallocated pool or startup heap | never during run | `main` or static owner |

Process-static resources need the static-initialization discipline from Chapter 5; Chapter 19 makes the linkage side precise. Returning a PMR container upward is safe only when the receiving scope also owns a resource that remains alive, or when the data is copied into that receiving resource.

**Rule.** Resource lifetime dominates container lifetime. Allocator-aware construction propagates an address, not ownership.

## The allocation-free hot path

An allocation-free steady state is a process structure:

1. **Startup:** create resources and pools, reserve every bounded container to its worst-case capacity, and establish failure policy.
2. **Warm-up:** run representative synthetic flow so pool refills, lazy initialization, and first-touch page faults occur before the session.
3. **Steady state:** reuse capacities and pool blocks without calling global `new` or `malloc`.

The capacity bound is part of correctness. If an input can exceed it, the hot path must reject, truncate, or route that input deliberately rather than surprise-grow a container.

Chapter 17's global allocation counter becomes a tripwire when combined with a scoped flag:

```cpp
bool hot_path_active = false;
std::size_t allocation_count = 0;

class HotPathGuard {
public:
    HotPathGuard() {
        if (hot_path_active) {
            std::abort();
        }
        hot_path_active = true;
    }

    ~HotPathGuard() { hot_path_active = false; }
};

void* operator new(std::size_t bytes) {
    if (hot_path_active) {
        std::abort();  // allocation attempted on hot path
    }
    if (void* pointer = std::malloc(bytes)) {
        ++allocation_count;
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
```

This diagnostic guard is single-threaded; Part V covers thread-local state and synchronization. A production replacement also covers array, aligned, and nothrow forms. `malloc` interposition provides another verification layer (Chapter 19).

The engine reserves and touches its full vector before the hot guard can become active:

```cpp
class Engine {
public:
    static constexpr std::size_t max_fills = 256;

    Engine()
        : arena_(storage_, sizeof(storage_),
                 std::pmr::null_memory_resource()),
          pool_(make_pool_options(), &arena_),
          fills_(&pool_) {
        fills_.reserve(max_fills);
        fills_.resize(max_fills);  // write every element during warm-up
        fills_.clear();
    }

    void on_message(std::span<const Fill> incoming) {
        if (incoming.size() > max_fills) {
            std::abort();
        }

        HotPathGuard guard;
        fills_.clear();
        fills_.insert(fills_.end(), incoming.begin(), incoming.end());
    }

private:
    static std::pmr::pool_options make_pool_options() {
        std::pmr::pool_options options;
        options.max_blocks_per_chunk = 4;
        options.largest_required_pool_block = max_fills * sizeof(Fill);
        return options;
    }

    alignas(std::max_align_t) std::byte storage_[64 * 1024];
    std::pmr::monotonic_buffer_resource arena_;
    std::pmr::unsynchronized_pool_resource pool_;
    std::pmr::vector<Fill> fills_;
};
```

Member order gives `storage_`, `arena_`, and `pool_` lifetimes longer than `fills_`. `reserve` prevents vector growth, while the null upstream makes an underestimated backing store fail during startup. A CI test sends maximum-sized messages under the guard; any hidden new-expression aborts immediately.

Hidden allocation sites include `std::function` targets that outgrow inline storage, `std::string` growth beyond its small-string buffer (Chapter 12), node insertion into `std::map`, and first-use library initialization. Warm-up must exercise the real path, not merely construct the engine.

An arena can **wink out** trivial objects by releasing their storage without visiting each destructor:

```cpp
void wink_out_fills() {
    std::pmr::monotonic_buffer_resource arena;
    std::pmr::polymorphic_allocator<Fill> allocator{&arena};

    Fill* fills = allocator.allocate(256);
    for (std::size_t i = 0; i < 256; ++i) {
        std::construct_at(
            fills + i, Fill{static_cast<std::uint64_t>(i), 0});
    }

    static_assert(std::is_trivially_destructible_v<Fill>);
    arena.release();  // no element destructor calls needed
}
```

Releasing the storage ends the `Fill` lifetimes, and trivial destruction has no side effects to preserve (Chapter 16). For non-trivially-destructible elements, call `std::destroy_at` for every live object before release; otherwise owned resources leak and later destructor calls or accesses have undefined behavior.

**Pitfall.** Never call `release` while a live PMR container still owns allocations from the resource. Even when its element type is trivial, the container retains dangling internal pointers and must later execute its own destruction protocol.

## Auditing hidden library allocation

A counting memory resource turns allocation assumptions into test output without replacing process-wide `operator new`. Route PMR objects through the resource, exercise one operation, then inspect calls and bytes:

```cpp
#include <cstddef>
#include <memory_resource>

class CountingResource final : public std::pmr::memory_resource {
public:
    explicit CountingResource(std::pmr::memory_resource* upstream)
        : upstream_(upstream) {}

    std::size_t allocations() const noexcept { return allocations_; }
    std::size_t bytes() const noexcept { return bytes_; }

private:
    void* do_allocate(std::size_t bytes, std::size_t alignment) override {
        ++allocations_;
        bytes_ += bytes;
        return upstream_->allocate(bytes, alignment);
    }

    void do_deallocate(
        void* pointer, std::size_t bytes, std::size_t alignment) override {
        upstream_->deallocate(pointer, bytes, alignment);
    }

    bool do_is_equal(
        const std::pmr::memory_resource& other) const noexcept override {
        return this == &other;
    }

    std::pmr::memory_resource* upstream_;
    std::size_t allocations_ = 0;
    std::size_t bytes_ = 0;
};
```

The same harness reveals several standard-library allocation shapes:

```cpp
#include <map>
#include <cstdio>
#include <string>
#include <vector>

void allocation_audit() {
    CountingResource counter{std::pmr::new_delete_resource()};

    std::pmr::vector<int> prices{&counter};
    prices.reserve(1'000);       // one planned block
    for (int i = 0; i < 1'000; ++i) {
        prices.push_back(i);     // no further vector allocation
    }

    std::pmr::map<int, int> limits{&counter};
    for (int i = 0; i < 100; ++i) {
        limits.try_emplace(i, i * 10); // normally one node per key
    }

    std::pmr::string message{&counter};
    message.append(200, 'X');    // exceeds ordinary SSO capacities

    std::printf("%zu allocations, %zu bytes\n",
                counter.allocations(), counter.bytes());
}
```

Exact counts and requested sizes are implementation details. The stable conclusions come from how the types store data:

| Operation | Allocation trigger | Audit expectation | Control |
|---|---|---|---|
| `pmr::vector::reserve(n)` | requested capacity exceeds current capacity | one contiguous element block | reserve before steady state |
| `pmr::vector::push_back` | size exceeds capacity | new block plus relocation | enforce capacity bound |
| `pmr::deque::push_back` | current end block or page map is exhausted | another chunk; occasional map growth | use only when segmented growth is required |
| `pmr::list::emplace` | every inserted element | one linked node | pool fixed-size nodes |
| `pmr::map::try_emplace` | new key | one tree node on typical implementations | pool nodes or use flat storage |
| `pmr::unordered_map::try_emplace` | new key; possibly load-factor crossing | node allocation plus occasional bucket-array rehash | reserve keys; consider flat hashing |
| `std::flat_map::insert` | underlying capacity is exhausted | contiguous growth plus suffix movement | bulk-build and reserve underlying storage |
| `pmr::string::append` | result exceeds current capacity and SSO | character buffer growth | reserve bounded message size |
| `std::function` construction | target misses implementation SBO | not visible to a PMR resource | global counter or allocator interposition |

Use this as a test, not a benchmark. Counting changes the allocation path and says nothing about cache misses or elapsed latency. A useful CI test asserts that the count does not change across a warmed steady-state operation; a benchmark measures the uninstrumented release build separately.

**Pitfall.** A PMR audit sees only objects actually given that resource. A nested ordinary `std::string`, a third-party library, or a large `std::function` target can still call the global allocator.

## Latency Lens

- `std::pmr::polymorphic_allocator` normally pays a virtual resource call per allocation and deallocation; that is minor beside `malloc` but visible beside an inlined bump.
- `std::pmr::monotonic_buffer_resource` allocation is a pointer bump and bounds check, while deallocation is a no-op by design.
- Move assignment across unequal, non-propagating allocators degrades from a buffer steal to element-wise moves and possible destination allocation.
- `std::pmr::unsynchronized_pool_resource` keeps size-class blocks reusable without taking the lock required by its synchronized counterpart.
- A PMR container generally carries one resource pointer; node containers dispatch each node allocation through it without necessarily storing a pointer in every node.
- Winking out replaces per-element destructor traversal with one arena release only when element destruction is trivial.
- Warm-up moves first-touch page faults, pool replenishment, and lazy initialization out of the first live message.
- A guarded global `operator new` adds one branch to attempted debug allocations and proves that the steady-state path reaches none.
- A counting resource localizes allocation audits to one object graph, while global replacement or interposition is still required to catch non-PMR nested types and callable-wrapper spills.
