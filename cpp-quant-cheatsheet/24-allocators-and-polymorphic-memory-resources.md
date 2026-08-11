# 24. Allocators and polymorphic memory resources

*Part IV — Memory, representation, and performance*

---

**Recall**
- An allocator owns *storage policy*; the container still begins and ends element lifetimes — releasing memory never runs destructors.
- `allocate(n)` returns raw, uninitialized storage for `n` objects; `construct`/`construct_at` is what starts an object's lifetime.
- Always go through `std::allocator_traits<A>` in generic code: it supplies defaults for every optional member and centralizes rebinding.
- C++23 `allocate_at_least(a, n)` returns `{ptr, count}` with `count >= n`, exposing size-class rounding the allocator already paid for.
- `deallocate(a, p, n)` must be called with the same `n` the allocation contract produced (`result.count` for `allocate_at_least`).
- Allocator *equality* means "storage from one can be freed through the other" — never claim equality just because the types match.
- POCCA/POCMA/POCS plus `is_always_equal` decide whether copy-assign, move-assign, and `swap` transfer the allocator or the storage.
- Move assignment is **not** guaranteed O(1): unequal, non-propagating allocators force allocation plus element-wise move.
- `swap` on containers with unequal, non-propagating allocators is undefined behavior, not merely slow.
- `std::pmr` trades a compile-time allocator type for a runtime `memory_resource*` behind virtual calls — type-erased, one pointer of state.
- A `memory_resource*` is **non-owning**: every container, string, and node using it must be destroyed before the resource dies.
- `monotonic_buffer_resource` bumps a pointer, ignores individual `deallocate`, and reclaims only on `release()`/destruction.
- Pool resources bin by implementation-defined size class and *do* reuse freed blocks; `unsynchronized_pool_resource` is single-thread-only.
- A stack buffer alone is not a hard bound — pass `std::pmr::null_memory_resource()` upstream to make exhaustion throw deterministically.
- `std::pmr::vector<std::vector<int>>` does *not* give the inner vectors the resource; only allocator-aware inner types or `scoped_allocator_adaptor` propagate.
- Growth still reallocates under an arena: abandoned buffers are retained until reset, so `reserve` a proven count.
- `v.clear()` keeps capacity; `arena.release()` invalidates that capacity — the two are not interchangeable.
- Thread-confined arenas remove shared free-list metadata from the hot path but create remote-free ownership rules and shutdown ordering.
- Benchmark lifetime, thread pattern, refill/release spikes, and peak retained bytes — not a loop of isolated `allocate(64)` calls.
- **Interview line** — "An allocator decides where bytes come from; it never decides when objects live or die."

---

## 24.1 Allocator model and `std::allocator_traits`

```cpp
#include <memory>
#include <vector>

using A  = std::allocator<int>;
using AT = std::allocator_traits<A>;
A a;

int* p = AT::allocate(a, 4);        // raw storage for 4 ints — NO int exists yet
std::construct_at(p, 7);            // C++20: begins one int's lifetime, value 7
std::destroy_at(p);                 // ends it
AT::deallocate(a, p, 4);            // n MUST match the allocation contract

int* q = AT::allocate(a, 4, p);     // optional locality hint (may be ignored)
AT::construct(a, q, 1);             // hook; defaults to construct_at
AT::destroy(a, q);                  // hook; defaults to destroy_at
AT::deallocate(a, q, 4);

std::uninitialized_fill_n(p, 4, 0); // <memory> raw-storage algorithms
std::uninitialized_value_construct_n(p, 4);
std::uninitialized_default_construct_n(p, 4);
std::uninitialized_move_n(src, 4, p);
std::destroy_n(p, 4);
```

```cpp
// ---- C++23 allocate_at_least ------------------------------------------
auto r = AT::allocate_at_least(a, 100);   // std::allocation_result<int*, std::size_t>
// r.ptr   : int*        storage for r.count objects
// r.count : std::size_t >= 100 — the allocator's real size class
AT::deallocate(a, r.ptr, r.count);        // deallocate with r.count, NOT 100

auto s = a.allocate_at_least(100);        // std::allocator member form (C++23)
```

```cpp
// ---- minimal conforming allocator: value_type + allocate/deallocate + == ----
template<class T>
struct Mallocator {
    using value_type = T;
    Mallocator() = default;
    template<class U> constexpr Mallocator(Mallocator<U> const&) noexcept {}

    [[nodiscard]] T* allocate(std::size_t n) {
        if (n > std::numeric_limits<std::size_t>::max() / sizeof(T))
            throw std::bad_array_new_length{};
        if (void* v = std::malloc(n * sizeof(T))) return static_cast<T*>(v);
        throw std::bad_alloc{};
    }
    void deallocate(T* p, std::size_t) noexcept { std::free(p); }

    template<class U> bool operator==(Mallocator<U> const&) const noexcept { return true; }
};
static_assert(std::is_same_v<
    std::allocator_traits<Mallocator<int>>::rebind_alloc<double>, Mallocator<double>>);
```

| `allocator_traits<A>` member | Meaning / default when `A` omits it |
|---|---|
| `value_type` | `A::value_type` — required, no default |
| `pointer` / `const_pointer` | `A::pointer` else `value_type*`; may be a *fancy pointer* |
| `void_pointer` / `const_void_pointer` | rebound void pointer types |
| `difference_type` / `size_type` | from `pointer_traits`; `size_type` defaults to `make_unsigned_t<difference_type>` |
| `rebind_alloc<U>` / `rebind_traits<U>` | `A<U, Args...>` — how containers get node allocators |
| `propagate_on_container_copy_assignment` | `false_type` |
| `propagate_on_container_move_assignment` | `false_type` |
| `propagate_on_container_swap` | `false_type` |
| `is_always_equal` | `is_empty<A>` |
| `allocate(a, n)` / `allocate(a, n, hint)` | raw storage; may throw `std::bad_alloc` |
| `allocate_at_least(a, n)` | C++23; defaults to `{allocate(a,n), n}` |
| `deallocate(a, p, n)` | must not throw; no destruction |
| `construct(a, p, args...)` | `a.construct(...)` else `std::construct_at(p, args...)` |
| `destroy(a, p)` | `a.destroy(p)` else `std::destroy_at(p)` |
| `max_size(a)` | `a.max_size()` else `numeric_limits<size_type>::max() / sizeof(value_type)` |
| `select_on_container_copy_construction(a)` | that member else a copy of `a` |

| Free function (`<memory>`) | Effect |
|---|---|
| `std::construct_at(p, args...)` | placement-new, `constexpr`-usable (C++20) |
| `std::destroy_at(p)` / `destroy(f,l)` / `destroy_n(f,n)` | run destructors, no deallocation |
| `std::uninitialized_copy / _n` | copy-construct into raw storage, rollback on throw |
| `std::uninitialized_move / _n` | move-construct into raw storage |
| `std::uninitialized_fill / _n` | copy-construct `n` from one value |
| `std::uninitialized_default_construct / _n` | default-init (indeterminate for trivial types) |
| `std::uninitialized_value_construct / _n` | value-init (zeroes trivial types) |
| `std::addressof(x)` | true address even with overloaded `operator&` |
| `std::to_address(p)` | raw pointer from a fancy pointer/iterator (C++20) |
| `std::assume_aligned<N>(p)` | alignment promise to the optimizer (C++20) |

**Traps** — `allocate` does not construct and `deallocate` does not destroy · mismatched `n` on `deallocate` is UB · `allocate_at_least` must be freed with `.count` · `max_size` is a type limit, not a capacity or latency promise · a "toy" allocator that only forwards `allocate`/`deallocate` can still be wrong on propagation, rebind, and equality.

---

## 24.2 Stateful allocators and propagation traits

```cpp
class Arena;   // owns bytes; see 24.6

template<class T>
class ArenaAllocator {
public:
    using value_type = T;
    // Opt-in propagation: state travels with the container.
    using propagate_on_container_copy_assignment = std::true_type;
    using propagate_on_container_move_assignment = std::true_type;
    using propagate_on_container_swap            = std::true_type;
    using is_always_equal                        = std::false_type; // stateful!

    explicit ArenaAllocator(Arena& arena) noexcept : arena_{&arena} {}
    template<class U>
    ArenaAllocator(ArenaAllocator<U> const& o) noexcept : arena_{o.arena()} {}

    [[nodiscard]] T* allocate(std::size_t n);
    void deallocate(T* p, std::size_t n) noexcept;

    [[nodiscard]] Arena* arena() const noexcept { return arena_; }

    template<class U>
    bool operator==(ArenaAllocator<U> const& rhs) const noexcept {
        return arena_ == rhs.arena();     // identity == mutual deallocatability
    }
private:
    Arena* arena_;
    template<class> friend class ArenaAllocator;
};
```

```cpp
// ---- move assignment is not automatically O(1) -------------------------
std::vector<Order, ArenaAllocator<Order>> a{alloc_a};
std::vector<Order, ArenaAllocator<Order>> b{alloc_b};

b = std::move(a);   // POCMA true  -> steal buffer AND allocator, O(1)
                    // POCMA false + a==b -> steal buffer, O(1)
                    // POCMA false + a!=b -> allocate in b, move each element, O(n)

b.swap(a);          // POCS true  -> swap buffers + allocators, O(1)
                    // POCS false + a==b -> swap buffers, O(1)
                    // POCS false + a!=b -> UNDEFINED BEHAVIOR
```

| Trait | `true` | `false` |
|---|---|---|
| `propagate_on_container_copy_assignment` (POCCA) | destination adopts source's allocator (deallocating old storage with the *old* allocator first) | destination keeps its allocator; elements copied into its own storage |
| `propagate_on_container_move_assignment` (POCMA) | allocator moves with the storage — O(1) steal | steal only if allocators compare equal, else element-wise move |
| `propagate_on_container_swap` (POCS) | allocators are swapped too | allocators must compare equal or behavior is undefined |
| `is_always_equal` | all instances interchangeable; enables `noexcept` move/swap | runtime `==` decides |

| Container operation | Resulting allocator |
|---|---|
| Copy ctor `C(other)` | `select_on_container_copy_construction(other.get_allocator())` |
| Copy ctor `C(other, alloc)` | the supplied `alloc` |
| Move ctor `C(std::move(other))` | move-constructed from `other`'s; storage always stolen, O(1), `noexcept` |
| Move ctor `C(std::move(other), alloc)` | `alloc`; steals only if `alloc == other.get_allocator()`, else O(n) |
| Copy assignment | POCCA decides replacement |
| Move assignment | POCMA + equality decide steal vs element-move |
| `swap` | POCS + equality; unequal & non-propagating ⇒ UB |

```cpp
// ---- noexcept consequences --------------------------------------------
static_assert(std::is_nothrow_move_constructible_v<std::vector<int>>);
// Move ASSIGNMENT is noexcept only when
//   allocator_traits<A>::propagate_on_container_move_assignment::value
//   || allocator_traits<A>::is_always_equal::value
static_assert(std::is_nothrow_move_assignable_v<std::vector<int>>);   // std::allocator: empty
```

**Traps** — equal types ≠ equal allocators · declaring `is_always_equal` on a stateful allocator routes frees to the wrong arena (corruption) · `operator!=` is auto-generated in C++20, don't hand-write an inconsistent one · a container's `get_allocator()` returns a *copy*, mutating it does not affect the container · POCCA `true` means the destination frees its old storage before adopting the new allocator.

---

## 24.3 Allocator-aware containers and `uses_allocator` construction

```cpp
#include <memory>
#include <memory_resource>
#include <scoped_allocator>

// A type is allocator-aware if it exposes allocator_type and accepts an
// allocator either LEADING (allocator_arg_t, a, args...) or TRAILING (args..., a).
struct Buffer {
    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;

    explicit Buffer(std::size_t n, allocator_type a = {})            // trailing form
        : bytes(n, a) {}
    Buffer(std::allocator_arg_t, allocator_type a, std::size_t n)    // leading form
        : bytes(n, a) {}
    Buffer(Buffer const& o, allocator_type a) : bytes(o.bytes, a) {} // alloc-extended copy
    Buffer(Buffer&& o, allocator_type a)      : bytes(std::move(o.bytes), a) {}

    std::pmr::vector<std::byte> bytes;
};
static_assert(std::uses_allocator_v<Buffer, std::pmr::polymorphic_allocator<std::byte>>);
```

```cpp
// ---- the standard plumbing (C++20) ------------------------------------
std::pmr::polymorphic_allocator<> pa{res};

auto args = std::uses_allocator_construction_args<Buffer>(pa, 64);  // tuple of ctor args
Buffer b1 = std::make_obj_using_allocator<Buffer>(pa, 64);          // construct a value
alignas(Buffer) std::byte raw[sizeof(Buffer)];
Buffer* b2 = std::uninitialized_construct_using_allocator(
                 reinterpret_cast<Buffer*>(raw), pa, 64);           // into raw storage

// polymorphic_allocator members that do the same job:
Buffer* b3 = pa.new_object<Buffer>(64);   // C++20: allocate + alloc-aware construct
pa.delete_object(b3);                     // destroy + deallocate
Buffer* b4 = pa.allocate_object<Buffer>(1);
pa.construct(b4, 64);                     // uses-allocator construction, propagates res
pa.destroy(b4);
pa.deallocate_object(b4, 1);
std::byte* raw2 = pa.allocate_bytes(1024, 64);   // sized+aligned raw bytes
pa.deallocate_bytes(raw2, 1024, 64);
```

```cpp
// ---- pair gets special treatment ---------------------------------------
std::pmr::vector<std::pair<std::pmr::string, std::pmr::vector<int>>> v{res};
v.emplace_back();          // BOTH pair members receive res via piecewise construction
std::pmr::map<std::pmr::string, std::pmr::string> m{res};
m.emplace("k", "v");       // key and mapped value both allocate from res
```

```cpp
// ---- the nested-container trap ----------------------------------------
std::pmr::vector<std::vector<int>>      bad{res};   // inner vectors use std::allocator!
std::pmr::vector<std::pmr::vector<int>> good{res};  // inner vectors inherit res
good.emplace_back();                                // propagated: no global new

// ---- scoped_allocator_adaptor: same job for non-pmr allocators ---------
using Inner = ArenaAllocator<char>;
using Str   = std::basic_string<char, std::char_traits<char>, Inner>;
using Outer = std::scoped_allocator_adaptor<ArenaAllocator<Str>, Inner>;
std::vector<Str, Outer> names{Outer{outer_alloc, inner_alloc}};
names.emplace_back("AAPL");   // string's allocator comes from the adaptor's inner level
```

| Facility | Purpose |
|---|---|
| `std::uses_allocator<T, A>` / `_v` | true if `T::allocator_type` is convertible from `A` (or `T` specializes the trait) |
| `std::allocator_arg` / `std::allocator_arg_t` | tag selecting the leading-allocator constructor |
| `std::uses_allocator_construction_args<T>(a, args...)` | C++20; builds the correct arg tuple (leading/trailing/none, pair-aware) |
| `std::make_obj_using_allocator<T>(a, args...)` | C++20; returns a `T` constructed with `a` |
| `std::uninitialized_construct_using_allocator(p, a, args...)` | C++20; constructs at `p` |
| `std::scoped_allocator_adaptor<Outer, Inner...>` | propagates allocators down nesting levels |
| `polymorphic_allocator::construct(p, args...)` | performs uses-allocator construction with `*this` |

**Traps** — outer PMR does not rewrite inner `std::vector`/`std::string` · `std::string` and `std::pmr::string` are different types, conversion copies · a type with `allocator_type` but no allocator-extended copy ctor silently loses the resource on container copies · `scoped_allocator_adaptor` is verbose and largely superseded by PMR · a function returning `std::vector<T>` cannot preserve a `pmr::vector<T>`'s storage — put the resource in the interface.

---

## 24.4 `std::pmr::memory_resource` and polymorphic allocators

```cpp
#include <memory_resource>

void process(std::pmr::memory_resource* res) {     // policy is a runtime argument
    std::pmr::vector<int>  values{res};
    std::pmr::string       label{"symbol", res};
    std::pmr::unordered_map<int, std::pmr::string> idx{res};
}
```

```cpp
// ---- the public interface (non-virtual) --------------------------------
void*  p  = res->allocate(1024, alignof(std::max_align_t));  // may throw bad_alloc
res->deallocate(p, 1024, alignof(std::max_align_t));          // must not throw; size+align must match
bool   eq = res->is_equal(*other);                            // mutually deallocatable?
bool   e2 = (*res == *other);                                 // operator== => this==&o || is_equal
```

```cpp
// ---- writing a resource: override the three do_ functions ---------------
class CountingResource final : public std::pmr::memory_resource {
public:
    explicit CountingResource(std::pmr::memory_resource* up =
                              std::pmr::get_default_resource()) noexcept : up_{up} {}
    std::size_t live() const noexcept { return live_; }
    std::size_t peak() const noexcept { return peak_; }
private:
    void* do_allocate(std::size_t bytes, std::size_t align) override {
        void* p = up_->allocate(bytes, align);          // propagate bad_alloc
        live_ += bytes; peak_ = std::max(peak_, live_);
        return p;
    }
    void do_deallocate(void* p, std::size_t bytes, std::size_t align) override {
        live_ -= bytes;
        up_->deallocate(p, bytes, align);               // noexcept required
    }
    bool do_is_equal(std::pmr::memory_resource const& o) const noexcept override {
        return this == &o;                              // identity-only equality
    }
    std::pmr::memory_resource* up_;
    std::size_t live_{}, peak_{};
};
```

```cpp
// ---- polymorphic_allocator is a one-pointer handle ----------------------
static_assert(sizeof(std::pmr::polymorphic_allocator<int>) == sizeof(void*));
std::pmr::polymorphic_allocator<int> pa{res};
std::pmr::polymorphic_allocator<int> def{};        // uses get_default_resource()
std::pmr::memory_resource* r = pa.resource();

// Propagation traits are ALL false and is_always_equal is false:
using PT = std::allocator_traits<std::pmr::polymorphic_allocator<int>>;
static_assert(!PT::propagate_on_container_copy_assignment::value);
static_assert(!PT::propagate_on_container_move_assignment::value);
static_assert(!PT::propagate_on_container_swap::value);
// => select_on_container_copy_construction returns a DEFAULT-resource allocator,
//    so a copy of a pmr container does NOT inherit the source's resource.
std::pmr::vector<int> src{res};
std::pmr::vector<int> cpy = src;          // cpy uses get_default_resource()!
std::pmr::vector<int> cpy2{src, res};     // explicit: keeps res
```

```cpp
// ---- lifetime: the pointer is borrowed ---------------------------------
std::pmr::vector<int> escaped;             // default resource
{
    std::pmr::monotonic_buffer_resource arena;
    std::pmr::vector<int> local{&arena};
    local.push_back(1);
    // escaped = std::move(local);         // BUG: steals a pointer into a dying arena
}                                          // arena destroyed -> local's bytes gone
```

| PMR alias | Underlying |
|---|---|
| `std::pmr::vector<T>` | `std::vector<T, polymorphic_allocator<T>>` |
| `std::pmr::string` / `u8string` / `wstring` | `basic_string<..., polymorphic_allocator<CharT>>` |
| `std::pmr::deque/list/forward_list<T>` | corresponding sequence containers |
| `std::pmr::map/set/multimap/multiset<...>` | ordered associatives |
| `std::pmr::unordered_map/set/...` | unordered associatives |
| `std::pmr::match_results`, `std::pmr::stacktrace` (C++23) | library types with allocators |

| `memory_resource` member | Notes |
|---|---|
| `allocate(bytes, align = alignof(max_align_t))` | `[[nodiscard]]`; throws on failure; align must be a power of two |
| `deallocate(p, bytes, align)` | `bytes`/`align` must match the allocation; must not throw |
| `is_equal(other)` const noexcept | virtual dispatch to `do_is_equal` |
| `operator==` / `operator!=` (free) | `&a == &b \|\| a.is_equal(b)` |
| protected `~memory_resource()` is public virtual | derived classes are deletable through the base |

**Traps** — copying a pmr container silently switches it to the default resource · `deallocate` with a different size/alignment than `allocate` is UB · virtual call per allocation (usually noise next to the allocation itself, but not free) · `do_is_equal` returning `true` too broadly is the PMR version of lying allocator equality · a resource must outlive every container, every node, and every deferred free.

---

## 24.5 Monotonic, pool, synchronized, and unsynchronized resources

```cpp
// ---- global resources (never destroyed; safe for concurrent use) --------
std::pmr::memory_resource* nd   = std::pmr::new_delete_resource();  // ::operator new/delete
std::pmr::memory_resource* null = std::pmr::null_memory_resource(); // allocate() always throws
std::pmr::memory_resource* cur  = std::pmr::get_default_resource(); // process-wide default
std::pmr::memory_resource* prev = std::pmr::set_default_resource(nd); // returns the old one
```

```cpp
// ---- monotonic: bump + bulk release -----------------------------------
std::pmr::monotonic_buffer_resource m1;                       // upstream = default
std::pmr::monotonic_buffer_resource m2{upstream};             // explicit upstream
std::pmr::monotonic_buffer_resource m3{8192};                 // initial upstream chunk size
std::pmr::monotonic_buffer_resource m4{8192, upstream};
std::pmr::monotonic_buffer_resource m5{buf, sizeof buf};      // caller-owned initial buffer
std::pmr::monotonic_buffer_resource m6{buf, sizeof buf,
                                       std::pmr::null_memory_resource()}; // HARD bound
m6.release();                                                 // return all upstream blocks, reset
std::pmr::memory_resource* up = m6.upstream_resource();
```

```cpp
// ---- pool resources ---------------------------------------------------
std::pmr::pool_options opt{
    .max_blocks_per_chunk        = 256,   // 0 = implementation default
    .largest_required_pool_block = 512    // larger requests go straight upstream
};
std::pmr::unsynchronized_pool_resource up1{opt};              // single-threaded
std::pmr::synchronized_pool_resource   sp1{opt, upstream};    // internally locked
std::pmr::unsynchronized_pool_resource up2{&arena};           // pool over an arena

up1.release();                     // free all pooled chunks to upstream
auto o = up1.options();            // possibly clamped by the implementation
std::pmr::list<Order> orders{&up1};
```

| Resource | Allocation | Individual `deallocate` | `release()` | Thread safety |
|---|---|---|---|---|
| `new_delete_resource()` | `::operator new(size, align_val_t)` | yes | n/a (singleton) | safe for concurrent calls |
| `null_memory_resource()` | always throws `std::bad_alloc` | no-op contract | n/a | safe |
| `monotonic_buffer_resource` | pointer bump in current buffer; geometric upstream chunks | **ignored** (no reclaim) | returns everything, resets to initial buffer | **not** synchronized |
| `unsynchronized_pool_resource` | size-class free lists; oversize → upstream | returns block to its pool | frees all chunks | **not** synchronized |
| `synchronized_pool_resource` | same, with internal locking | yes | frees all chunks | synchronized |

```text
Upstream chains define overflow and release semantics:

  pmr::vector → monotonic(stack buffer) → null_memory_resource
                                          hard bound; overflow throws bad_alloc

  pmr::vector → unsynchronized_pool → monotonic(1 MB) → new_delete_resource
                                          reuse by size class, bulk reset, heap fallback

  pmr::vector → monotonic(stack buffer)          [default upstream!]
                                          NOT bounded — silently heap-allocates on overflow
```

```cpp
// ---- composing: pool over an arena over a fixed slab -------------------
alignas(64) static std::array<std::byte, 1 << 20> slab;
std::pmr::monotonic_buffer_resource   arena{slab.data(), slab.size(),
                                            std::pmr::null_memory_resource()};
std::pmr::unsynchronized_pool_resource pool{{.max_blocks_per_chunk = 1024,
                                             .largest_required_pool_block = 256}, &arena};
std::pmr::unordered_map<std::uint64_t, Order> book{&pool};
// Destruction order is reverse of declaration: book, then pool, then arena. Correct.
```

**Traps** — `set_default_resource` is global mutable policy, not a substitute for passing a resource · a pool's size classes are unspecified, so `pool_options` is a hint · `synchronized_pool_resource` makes the *resource* thread-safe, never the containers using it · `release()` on a pool invalidates every block handed out · `monotonic_buffer_resource{buf, n}` without a null upstream is a heap allocator wearing a stack-buffer costume.

---

## 24.6 Arena/bump allocators and bulk release

```cpp
#include <array>
#include <cstddef>
#include <memory_resource>

alignas(std::max_align_t) std::array<std::byte, 64 * 1024> bytes{};
std::pmr::monotonic_buffer_resource arena{
    bytes.data(), bytes.size(), std::pmr::null_memory_resource()};

std::pmr::vector<int> batch{&arena};
batch.reserve(1024);          // one bump; no per-push allocation afterwards
```

- Allocation is `align_up(cursor, align)` then `cursor += bytes` — a few instructions, no free list.
- `deallocate` is a no-op; memory returns only via `release()` or destruction.
- The caller-supplied initial buffer is never deallocated by the resource.
- Exhaustion goes upstream; with `null_memory_resource()` that is a deterministic `std::bad_alloc`.
- Not synchronized: one arena per thread, or external locking.

```cpp
// ---- a hand-rolled bump arena (what monotonic does) --------------------
class BumpArena final : public std::pmr::memory_resource {
public:
    BumpArena(std::byte* base, std::size_t size) noexcept
        : base_{base}, cur_{base}, end_{base + size} {}
    void reset() noexcept { cur_ = base_; }              // bulk release, NO destructors
    std::size_t used() const noexcept { return std::size_t(cur_ - base_); }
private:
    void* do_allocate(std::size_t bytes, std::size_t align) override {
        auto  space = std::size_t(end_ - cur_);
        void* p     = cur_;
        if (!std::align(align, bytes, p, space)) throw std::bad_alloc{};  // <memory>
        cur_ = static_cast<std::byte*>(p) + bytes;
        return p;
    }
    void do_deallocate(void*, std::size_t, std::size_t) override {}       // no reclaim
    bool do_is_equal(std::pmr::memory_resource const& o) const noexcept override {
        return this == &o;
    }
    std::byte *base_{}, *cur_{}, *end_{};
};
```

```cpp
// ---- correct phase ordering -------------------------------------------
std::pmr::monotonic_buffer_resource arena{buf, sizeof buf};   // declared FIRST
{
    std::pmr::vector<NonTrivial> values{&arena};
    values.emplace_back(/*...*/);
}                       // scope end: elements destroyed, THEN storage is stale
arena.release();        // now safe; release() itself runs NO destructors

// ---- per-request reuse pattern ----------------------------------------
for (auto const& request : requests) {
    std::pmr::monotonic_buffer_resource scratch{buf, sizeof buf,
                                                std::pmr::null_memory_resource()};
    handle(request, &scratch);      // all scratch state dies at the end of the iteration
}                                   // (or hoist the arena and call release() per loop)
```

```cpp
// ---- growth still wastes arena space -----------------------------------
std::pmr::vector<int> v{&arena};
for (int i = 0; i != 1024; ++i) v.push_back(i);
// Each reallocation abandons the previous buffer; the monotonic resource never
// reclaims it. Total arena consumption ≈ 2× final capacity. Fix:
std::pmr::vector<int> w{&arena};
w.reserve(1024);                    // one buffer, one bump
```

| Arena fit | Verdict |
|---|---|
| Per-request / per-tick / per-batch scratch that all dies together | ideal |
| Parse trees, temporary graphs, snapshot construction | ideal |
| Long-lived objects with independent, unpredictable lifetimes | poor — use a pool |
| Cross-thread deallocation | poor — unsynchronized, and frees do nothing anyway |
| High-churn same-size nodes | poor — pool reuses, monotonic only grows |

**Traps** — `release()` invalidates capacity but runs no destructors · declaring the arena *after* its containers reverses destruction order into UB · `clear()` ≠ `release()` · a moved-from pmr container still points at the old resource · the initial buffer's storage duration must outlive the resource.

---

## 24.7 Fixed-block pools, freelists, alignment, and lifetime

```cpp
// ---- fixed-capacity slot pool with generation handles -------------------
#include <bit>
#include <cstdint>
#include <new>
#include <vector>

template<class T, std::uint32_t Capacity>
class SlotPool {
    static_assert(Capacity > 0);
    struct Slot {
        alignas(T) std::byte storage[sizeof(T)];   // raw bytes, NOT a T
        std::uint32_t next{};                      // free-list link (index, not pointer)
        std::uint32_t generation{1};               // odd = free, even = occupied
        T* ptr() noexcept { return std::launder(reinterpret_cast<T*>(storage)); }
    };
public:
    struct Handle { std::uint32_t index{}; std::uint32_t generation{}; };

    SlotPool() noexcept {
        for (std::uint32_t i = 0; i + 1 < Capacity; ++i) slots_[i].next = i + 1;
        slots_[Capacity - 1].next = kNone;
    }
    ~SlotPool() { clear(); }

    template<class... Args>
    [[nodiscard]] Handle create(Args&&... args) {          // returns {} on exhaustion
        if (head_ == kNone) return {};
        std::uint32_t i = head_;
        Slot& s = slots_[i];
        std::construct_at(s.ptr(), std::forward<Args>(args)...);  // may throw:
        head_ = s.next;                                            // pop AFTER success
        ++s.generation;                                            // now even = live
        ++live_;
        return {i, s.generation};
    }
    void destroy(Handle h) noexcept {
        if (!valid(h)) return;                       // stale/double-free rejected
        Slot& s = slots_[h.index];
        std::destroy_at(s.ptr());                    // end T's lifetime FIRST
        ++s.generation;                              // odd again; old handles now stale
        s.next = head_; head_ = h.index;             // only now reuse the bytes
        --live_;
    }
    [[nodiscard]] bool valid(Handle h) const noexcept {
        return h.index < Capacity && h.generation != 0
            && slots_[h.index].generation == h.generation && (h.generation % 2 == 0);
    }
    [[nodiscard]] T* get(Handle h) noexcept { return valid(h) ? slots_[h.index].ptr() : nullptr; }
    void clear() noexcept {
        for (std::uint32_t i = 0; i != Capacity; ++i)
            if (slots_[i].generation % 2 == 0) { std::destroy_at(slots_[i].ptr()); ++slots_[i].generation; }
        head_ = 0; live_ = 0;
        for (std::uint32_t i = 0; i + 1 < Capacity; ++i) slots_[i].next = i + 1;
        slots_[Capacity - 1].next = kNone;
    }
    std::uint32_t size() const noexcept { return live_; }
private:
    static constexpr std::uint32_t kNone = ~std::uint32_t{0};
    std::array<Slot, Capacity> slots_{};
    std::uint32_t head_{0}, live_{0};
};
```

```cpp
// ---- fixed-block memory_resource (size class = one block) ---------------
class FixedBlockResource final : public std::pmr::memory_resource {
public:
    FixedBlockResource(void* base, std::size_t block, std::size_t align, std::size_t count) noexcept
        : block_{block}, align_{align} {
        auto* p = static_cast<std::byte*>(base);
        for (std::size_t i = 0; i != count; ++i, p += block) {  // thread free list through blocks
            auto* node = reinterpret_cast<void**>(p);
            *node = free_; free_ = node;
        }
    }
private:
    void* do_allocate(std::size_t bytes, std::size_t align) override {
        if (bytes > block_ || align > align_ || !free_) throw std::bad_alloc{};
        void* p = free_; free_ = static_cast<void**>(*free_);   // pop
        return p;
    }
    void do_deallocate(void* p, std::size_t, std::size_t) override {
        auto* node = static_cast<void**>(p); *node = free_; free_ = node;  // push
    }
    bool do_is_equal(std::pmr::memory_resource const& o) const noexcept override {
        return this == &o;
    }
    void** free_{}; std::size_t block_, align_;
};
```

```cpp
// ---- alignment API surface ---------------------------------------------
alignof(T); alignas(64) struct Padded { int x; };
std::align(align, size, ptr, space);                       // <memory>, advances ptr/space
std::assume_aligned<64>(p);                                // C++20 optimizer hint
::operator new(n, std::align_val_t{64});                   // C++17 over-aligned new
::operator delete(p, n, std::align_val_t{64});             // MUST match
auto* q = new (std::align_val_t{64}) Node;                 // aligned new-expression
std::aligned_alloc(64, 128);                               // C: size must be a multiple of align
static_assert(std::has_single_bit(64u));                   // alignments are powers of two (C++20)
constexpr auto max_align = alignof(std::max_align_t);
constexpr auto interference = std::hardware_destructive_interference_size;  // C++17
```

**Rules a fixed pool must answer explicitly**

| Question | Consequence if unanswered |
|---|---|
| Slot alignment and stride | misaligned `T` → UB on over-aligned types |
| Which slots are live | destructor pass on release is impossible |
| Rollback if `T`'s constructor throws | leaked slot or half-live block |
| Destruction on reset | non-trivial destructors silently skipped |
| Exhaustion result (throw / null / handle{}) | hot path takes an unplanned exception |
| Double-free and stale-handle detection | reuse-after-free corruption |
| Address vs index stability | dangling pointers after growth |
| Owning thread / remote free policy | data race on the free-list head |
| Generation wraparound | ABA: a stale handle validates against a reused slot |

**Traps** — overlaying the free-list link on bytes that still hold a live `T` violates lifetime and aliasing rules: `destroy_at` first · `reinterpret_cast` from `std::byte*` needs `std::launder` after placement-new through a different type · pop the free list only after construction succeeds · `sizeof(T) < sizeof(void*)` breaks intrusive free lists · a generation counter must be wide enough that wraparound outlives every stored handle.

---

## 24.8 False sharing and thread-local allocation

```text
thread A allocate/free ─┐
                        ├── shared free-list head / size-class counters
thread B allocate/free ─┘        one cache line → RFO ping-pong → tail latency
```

```cpp
// ---- pad shared allocator metadata -------------------------------------
struct alignas(std::hardware_destructive_interference_size) ShardedFreeList {
    void** head{};
    std::size_t count{};
    // padding to a full cache line is implied by alignas on the type
};
static_assert(sizeof(ShardedFreeList) % std::hardware_destructive_interference_size == 0);

// ---- thread-confined arena --------------------------------------------
thread_local std::pmr::monotonic_buffer_resource tls_arena{64 * 1024};
std::pmr::memory_resource* scratch() noexcept { return &tls_arena; }
// No locks, no shared metadata, no cross-thread frees allowed.
```

```cpp
// ---- explicit per-thread resources beat thread_local for shutdown order --
struct ThreadContext {
    alignas(std::hardware_destructive_interference_size)
    std::array<std::byte, 1 << 16>        slab;
    std::pmr::monotonic_buffer_resource   arena{slab.data(), slab.size(),
                                                std::pmr::null_memory_resource()};
    std::pmr::unsynchronized_pool_resource pool{&arena};
};
// One ThreadContext per worker, owned by the worker, destroyed by the worker.
```

| Remote-free policy | Tradeoff |
|---|---|
| Free only on the owning thread (return queue / handoff) | fastest steady state; needs an MPSC return path and drain point |
| Central `synchronized_pool_resource` | arbitrary free anywhere; lock contention and jitter |
| Per-thread cache + central refill | amortized sharing; refill/flush spikes, more state |
| Never free individually within a phase (monotonic) | fastest possible; memory retained until reset |

- Padding *your* resource object does not remove contention inside its upstream resource.
- Placing unrelated per-thread allocators in one cache line creates false sharing even though they never share a block.
- `hardware_destructive_interference_size` avoids sharing; `hardware_constructive_interference_size` promotes it (co-locate related fields).
- A resource must outlive every deferred/remote return: shutdown ordering is part of allocator correctness.
- `thread_local` destruction order relative to a global resource is fragile — prefer an explicitly owned per-thread context.

**Traps** — `thread_local` with a non-trivial destructor adds a TLS guard check on every access in some ABIs · a `synchronized_pool_resource` still funnels all threads through one lock · atomics on the free-list head turn a 2 ns bump into a contended RMW · false sharing shows up in p99, never in the mean.

---

## 24.9 Benchmarking allocators honestly

```cpp
// ---- keep the work observable ------------------------------------------
#include <benchmark/benchmark.h>

static void BM_ArenaVector(benchmark::State& st) {
    alignas(64) static std::array<std::byte, 1 << 20> slab;
    for (auto _ : st) {
        std::pmr::monotonic_buffer_resource arena{slab.data(), slab.size(),
                                                  std::pmr::null_memory_resource()};
        std::pmr::vector<Order> v{&arena};
        v.reserve(st.range(0));
        for (int i = 0; i != st.range(0); ++i) v.emplace_back(make_order(i));
        benchmark::DoNotOptimize(v.data());     // pointer escapes → work survives
        benchmark::ClobberMemory();             // flush stores
    }                                            // destruction IS part of the measurement
    st.SetItemsProcessed(st.iterations() * st.range(0));
}
BENCHMARK(BM_ArenaVector)->Range(64, 65536);
```

```cpp
// ---- instrument the resource, don't just time it -----------------------
class StatsResource final : public std::pmr::memory_resource {
public:
    struct Stats { std::size_t requested{}, upstream_calls{}, live{}, peak{}, failures{}; };
    Stats const& stats() const noexcept { return s_; }
private:
    void* do_allocate(std::size_t n, std::size_t a) override {
        ++s_.upstream_calls; s_.requested += n;
        try { void* p = up_->allocate(n, a); s_.live += n;
              s_.peak = std::max(s_.peak, s_.live); return p; }
        catch (...) { ++s_.failures; throw; }
    }
    void do_deallocate(void* p, std::size_t n, std::size_t a) override {
        s_.live -= n; up_->deallocate(p, n, a);
    }
    bool do_is_equal(std::pmr::memory_resource const& o) const noexcept override { return this == &o; }
    std::pmr::memory_resource* up_ = std::pmr::new_delete_resource();
    Stats s_{};
};
```

```bash
# real-world instrumentation
perf stat -e cache-misses,LLC-load-misses,page-faults ./bench
perf record -e cycles:pp ./bench && perf report
valgrind --tool=massif ./app           # heap profile over time
heaptrack ./app                        # allocation counts + backtraces
/usr/bin/time -v ./app                 # maximum resident set size
env MALLOC_ARENA_MAX=1 ./app           # glibc arena count sanity check
clang++ -fsanitize=address -fsanitize-address-use-after-scope   # arena UAF after release()
```

**Workload dimensions to vary**

- request-size and alignment distribution (not a single fixed size);
- allocation/free ordering and live-set high-water mark;
- single-thread vs allocate-here/free-there;
- cold start, replenishment, steady reuse, and exhaustion;
- object construction/destruction cost separated from storage cost;
- the full upstream chain and its hard-bound behavior;
- fragmentation after a realistic phase change;
- median **plus** p99/p99.9/max, not throughput alone.

| Benchmark error | Why it misleads |
|---|---|
| Loop whose pointers never escape | optimizer deletes the allocation entirely (C++14 allows elision) |
| Only same-size LIFO free order | flatters the free list; production is neither |
| Exclude refill / `release()` | hides exactly the spikes that show in p99 |
| Arena allocation vs general-allocator destruction | different semantic work, not comparable |
| Ignore resident/retained bytes | "fast" via unbounded retention is not free |
| One shared RNG or counter across threads | measures the harness's contention |
| Warm arena reused across iterations | first-touch page faults never counted |
| Fixed CPU frequency not pinned | run-to-run variance swamps the effect |

**Report alongside timing** — bytes requested, bytes obtained upstream, upstream/refill call count, peak live bytes, unused retained bytes, failure/exhaustion count.

**Interview line** — "I benchmark an allocator by its lifetime pattern and its tail, and I report peak retained bytes next to the latency — a bump allocator wins every microbenchmark and can still lose on memory."

**Traps** — `DoNotOptimize` on the container but not its data lets the buffer be elided · measuring `allocate` without the matching `deallocate` measures half the design · comparing PMR against `malloc` without the virtual-call path in both · first-touch page faults attributed to the allocator instead of the OS.
