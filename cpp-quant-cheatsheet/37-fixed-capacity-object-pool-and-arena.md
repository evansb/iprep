# 37. Fixed-capacity object pool and arena

*Part VI-A — Quant blueprints: types, codecs, and core structures*

---

**Recall**
- Storage and object lifetime are separate: a free slot is suitably aligned *bytes*, and it becomes a `T` only when construction begins its lifetime.
- `alignas(T) std::byte storage[sizeof(T)]` is the portable slot; `std::construct_at` starts the lifetime, `std::destroy_at` ends it.
- `std::launder` is required after `reinterpret_cast`ing byte storage to `T*` when you did not keep the pointer returned by `construct_at`.
- Assigning into raw bytes does **not** start a non-implicit-lifetime object's lifetime — it is UB.
- Pool invariant: every slot is free XOR occupied; `live_count + free_count == Capacity`; each free slot appears exactly once in the free list.
- Acquire order: find free slot → construct → *then* unlink and mark occupied, so a throwing constructor leaves the pool untouched (strong guarantee).
- Release order: validate → `destroy_at` → mark free → bump generation → push onto free list; publishing before destroying permits reuse while the destructor still runs.
- A generation-tagged handle (`{index, generation}`) is O(1)-validated by bounds + occupied + generation match; a bare index silently aliases a reused slot.
- Generations are finite and wrap; skipping 0 reserves a null handle, but wrap must have a stated policy (wider counter, quarantine, or terminal).
- Handles do not own: copying a handle does not keep the object alive; the pool is always the owner.
- Delete copy/move on an embedded pool — moving relocates slot storage and dangles every outstanding `T*`.
- An intrusive free link lives *inside* the dead slot's payload bytes: zero metadata overhead, but never readable while a `T` is alive there.
- Exhaustion is part of the type contract: return `std::expected`/null handle, block, spill, evict, or fail fast — silent `new` fallback turns a bound into a hint.
- A bump arena aligns and advances one cursor; individual deallocation is a no-op and `reset()` invalidates the whole phase at once.
- Arena `reset()` is O(1) only for trivially destructible objects; otherwise keep a reverse-order destructor record stack.
- `std::pmr::monotonic_buffer_resource` grows from upstream unless you pass `std::pmr::null_memory_resource()`; destroy containers before releasing the resource.
- A Treiber free-list head has ABA exposure; the object-handle generation is *not* the same tag as the CAS ABA tag.
- Poison only dead storage (after `destroy_at`, before the next `construct_at`); writing poison through a live `T` corrupts it.
- ASan does not flag use-after-return-to-pool by default — the pages stay allocated; use manual poison hooks in debug builds.

---

## 37.1 Slot storage, alignment, and free-list representation

```cpp
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <new>
#include <type_traits>

// ---- (a) metadata beside the storage: simplest, largest stride -----------
template<class T>
struct SidecarSlot {
    alignas(T) std::byte storage[sizeof(T)];   // raw bytes, correctly aligned
    std::uint32_t generation{1};               // 0 reserved for "null handle"
    std::uint32_t next_free{};                 // index link, not a pointer
    bool occupied{false};

    [[nodiscard]] T* raw() noexcept {          // placement-construction target ONLY
        return reinterpret_cast<T*>(storage);  // no object here yet
    }
    [[nodiscard]] T* object() noexcept {       // valid only while occupied
        return std::launder(reinterpret_cast<T*>(storage));
    }
    [[nodiscard]] T const* object() const noexcept {
        return std::launder(reinterpret_cast<T const*>(storage));
    }
};

// ---- (b) union slot: same idea, lets the compiler size/align for you -----
template<class T>
union UnionSlot {
    T value;                     // active only while occupied
    std::uint32_t next_free;     // active only while free
    UnionSlot() noexcept : next_free{} {}   // neither member auto-destroyed
    ~UnionSlot() noexcept {}                // owner must destroy explicitly
};

// ---- (c) intrusive free link stored INSIDE the dead payload bytes --------
//     zero metadata bytes; the link is a real object living in dead storage.
template<class T>
struct IntrusiveSlot {
    static_assert(sizeof(T)  >= sizeof(std::uint32_t));
    static_assert(alignof(T) >= alignof(std::uint32_t));
    alignas(T) std::byte storage[sizeof(T)];

    void link(std::uint32_t next) noexcept {                  // slot is DEAD here
        std::construct_at(reinterpret_cast<std::uint32_t*>(storage), next);
    }
    [[nodiscard]] std::uint32_t unlink() noexcept {           // still DEAD
        auto* p = std::launder(reinterpret_cast<std::uint32_t*>(storage));
        auto next = *p;
        std::destroy_at(p);      // no-op for trivial type, but keeps the model honest
        return next;
    }
};

// ---- (d) separate metadata arrays: dense T storage, hot/cold split -------
template<class T, std::size_t N>
struct SoAPool {
    alignas(T) std::byte storage[N * sizeof(T)];   // dense: stride == sizeof(T)
    std::array<std::uint32_t, N> generation{};     // cold, own cache lines
    std::array<std::uint32_t, N> next_free{};
    std::array<bool, N>          occupied{};
    [[nodiscard]] T* slot(std::size_t i) noexcept {
        return std::launder(reinterpret_cast<T*>(storage + i * sizeof(T)));
    }
};

// ---- (e) bitmap occupancy: 1 bit/slot, O(words) search -------------------
template<std::size_t N>
struct Bitmap {
    static constexpr std::size_t W = (N + 63) / 64;
    std::array<std::uint64_t, W> words{};                 // 1 == free
    [[nodiscard]] std::size_t claim() noexcept {          // first free index
        for (std::size_t w = 0; w != W; ++w)
            if (words[w] != 0) {
                auto b = static_cast<std::size_t>(std::countr_zero(words[w]));
                words[w] &= words[w] - 1;                 // clear lowest set bit
                return w * 64 + b;
            }
        return N;                                         // exhausted sentinel
    }
    void release(std::size_t i) noexcept { words[i / 64] |= std::uint64_t{1} << (i % 64); }
};
```

```cpp
// ---- over-aligned T: the pool inherits alignment through its slot array --
struct alignas(64) CacheLine { std::byte bytes[64]; };
static_assert(alignof(SidecarSlot<CacheLine>) >= alignof(CacheLine));
static_assert(alignof(std::array<SidecarSlot<CacheLine>, 8>) >= 64);
// If pool storage comes from operator new / mmap, that source must honour
// alignof(Slot); ::operator new(sz, std::align_val_t{alignof(Slot)}) does. // C++17
```

```text
free_head ─► 2 ─► 5 ─► none            slot 0 [ live T | gen 7 | occupied ]
             raw    raw                 slot 1 [ live T | gen 4 | occupied ]
```

| Layout | Metadata cost | Find-free | Trap |
|---|---|---|---|
| Sidecar metadata | ~12 B/slot + padding | O(1) head pop | stride > `sizeof(T)`; metadata shares lines with objects |
| Union slot | 0 extra (max of members) | O(1) | you must destroy the active member manually |
| Intrusive link in payload | 0 | O(1) | requires `sizeof(T) >= sizeof(link)`; never read while `T` live |
| Separate metadata arrays | same bytes, cold pages | O(1) | two indexings; keep arrays in sync |
| Bitmap | 1 bit/slot | O(words scanned) | worst case scans whole bitmap |

| Facility | Header | Meaning |
|---|---|---|
| `alignas(T)` | — | raises alignment of the declared object/member |
| `alignof(T)` | — | required alignment in bytes |
| `std::max_align_t` | `<cstddef>` | fundamental alignment only — *not* over-alignment |
| `std::aligned_storage` | `<type_traits>` | **deprecated in C++23** — use `alignas` + `std::byte[]` |
| `std::launder(p)` | `<new>` | refresh a pointer after the object at that address changed |
| `std::align(a, sz, ptr, space)` | `<memory>` | advance `ptr`/shrink `space` to an aligned fit, or `nullptr` |
| `std::assume_aligned<N>(p)` | `<memory>` | C++20 optimizer hint; UB if untrue |
| `std::has_single_bit(a)` | `<bit>` | power-of-two check for alignment arguments |
| `std::countr_zero(x)` | `<bit>` | lowest set bit index for bitmap scans |

**Traps** — `reinterpret_cast<T*>(bytes)` gives a pointer, not an object · reading `next_free` from payload bytes while a `T` lives there is UB · `std::aligned_storage` is deprecated · `alignas(std::max_align_t)` does not guarantee 64-byte alignment · a `bool occupied` per slot inflates stride more than a bitmap.

---

## 37.2 Placement construction and explicit destruction

```cpp
#include <memory>       // construct_at, destroy_at, destroy, destroy_n, uninitialized_*
#include <new>          // placement new, launder, std::align_val_t

alignas(T) std::byte buf[sizeof(T)];

// ---- every spelling of "start a lifetime in raw storage" ----------------
T* a = new (buf) T;                                   // default-init (may be garbage)
T* b = new (buf) T{};                                 // value-init
T* c = new (buf) T(x, y);                             // direct-init
T* d = new (buf) T{x, y};                             // list-init (narrowing checked)
T* e = std::construct_at(reinterpret_cast<T*>(buf), x, y);   // C++20, constexpr-able
T* f = std::ranges::construct_at(reinterpret_cast<T*>(buf)); // same, ranges spelling

// ---- ending the lifetime -----------------------------------------------
std::destroy_at(e);            // calls e->~T(); recurses into arrays element-wise
e->~T();                       // equivalent hand-spelling
std::destroy(first, last);     // range of live objects
std::destroy_n(first, n);
```

```cpp
// ---- uninitialized algorithms: bulk construction into raw storage -------
std::uninitialized_default_construct(first, last);   // T (indeterminate for trivial)
std::uninitialized_value_construct_n(first, n);      // T{}
std::uninitialized_fill(first, last, value);         // copy-construct from value
std::uninitialized_copy(sf, sl, dst);                // returns dst end
std::uninitialized_copy_n(sf, n, dst);
std::uninitialized_move(sf, sl, dst);                // C++17; strong guarantee
std::uninitialized_move_n(sf, n, dst);
// All of these destroy already-constructed elements if one construction throws.
```

```cpp
// ---- the constexpr-vs-runtime split ------------------------------------
constexpr bool ok = [] {
    std::allocator<int> alloc;
    int* p = alloc.allocate(1);        // constexpr since C++20
    std::construct_at(p, 42);          // placement new is NOT constexpr; this is
    bool r = (*p == 42);
    std::destroy_at(p);
    alloc.deallocate(p, 1);
    return r;
}();
static_assert(ok);
```

```cpp
// ---- launder: when you need it -----------------------------------------
struct S { const int value; };
alignas(S) std::byte store[sizeof(S)];
S* p1 = std::construct_at(reinterpret_cast<S*>(store), 1);
std::destroy_at(p1);
S* p2 = std::construct_at(reinterpret_cast<S*>(store), 2);
// int v = p1->value;                       // UB: p1 names the OLD object
int v = std::launder(p1)->value;            // OK: 2
```

```cpp
// ---- transactional acquire: construct BEFORE mutating metadata ---------
// identify free slot  →  construct T  →  unlink head  →  mark occupied  →  handle
// If the constructor throws, nothing above has been published: strong guarantee.

// ---- transactional release: destroy BEFORE publishing free -------------
// validate handle  →  destroy_at  →  occupied=false  →  ++generation  →  push head
// Publishing first lets a reentrant/concurrent acquire reconstruct the slot
// while the old destructor is still touching it.
```

| Facility | Header | Effect | Notes |
|---|---|---|---|
| `new (ptr) T(args)` | `<new>` | placement new, starts lifetime | never `constexpr`; no allocation |
| `std::construct_at(p, args...)` | `<memory>` | C++20 placement construct | `constexpr`; direct-init only (no `{}` list-init of aggregates pre-C++20 rules apply) |
| `std::destroy_at(p)` | `<memory>` | end lifetime | array-aware since C++20 |
| `std::destroy(f, l)` / `_n` | `<memory>` | end lifetimes over a range | |
| `std::uninitialized_*` family | `<memory>` | bulk construct into raw storage | rollback on throw |
| `std::start_lifetime_as<T>(p)` | `<memory>` | C++23; implicit-lifetime types only | no constructor runs |
| `std::launder(p)` | `<new>` | re-derive a valid pointer | needed after reuse of storage |
| `std::allocator<T>::allocate/deallocate` | `<memory>` | raw bytes | `constexpr` since C++20 |
| `std::allocator_traits<A>::construct/destroy` | `<memory>` | allocator-aware forms | what containers actually call |

**Traps** — `std::construct_at` requires `T` be constructible with `(args...)` via *direct* init, so it cannot narrow-check like `T{...}` · a placement-new'd object is never freed by `delete` · `destroy_at` on a never-constructed slot is UB · `new (buf) T[n]` may need unspecified array-cookie overhead — construct elements one at a time instead · a throwing destructor during pool `clear()` calls `std::terminate` if `clear` is `noexcept`.

---

## 37.3 Stable handles, indices, pointers, and generation validation

```cpp
#include <compare>
#include <cstdint>
#include <limits>

struct PoolHandle {
    std::uint32_t index{};
    std::uint32_t generation{};       // 0 == null/never-valid
    [[nodiscard]] constexpr bool is_null() const noexcept { return generation == 0; }
    friend constexpr auto operator<=>(PoolHandle, PoolHandle) = default;  // C++20
    friend constexpr bool operator==(PoolHandle, PoolHandle) = default;
};
static_assert(sizeof(PoolHandle) == 8);

// ---- packed 64-bit variant: one word, atomic-friendly ------------------
struct PackedHandle {
    std::uint64_t bits{};
    static constexpr std::uint64_t index_bits = 24;                  // 16 M slots
    static constexpr std::uint64_t index_mask = (1ULL << index_bits) - 1;
    [[nodiscard]] static constexpr PackedHandle make(std::uint32_t i,
                                                     std::uint64_t g) noexcept {
        return PackedHandle{(g << index_bits) | (i & index_mask)};
    }
    [[nodiscard]] constexpr std::uint32_t index() const noexcept {
        return static_cast<std::uint32_t>(bits & index_mask);
    }
    [[nodiscard]] constexpr std::uint64_t generation() const noexcept {
        return bits >> index_bits;                                   // 40 gen bits
    }
    friend constexpr auto operator<=>(PackedHandle, PackedHandle) = default;
};

// ---- generation advance: skip 0 so a default handle can never validate -
[[nodiscard]] constexpr std::uint32_t advance(std::uint32_t g) noexcept {
    auto next = g + 1;              // unsigned wrap is defined
    return next == 0 ? 1 : next;    // reserve 0 for "null"
}

// ---- validation is three predicates, all O(1) --------------------------
// handle.index < Capacity
// slots_[handle.index].occupied
// slots_[handle.index].generation == handle.generation
```

```cpp
// ---- typed handles: stop cross-pool mixups at compile time -------------
template<class Tag>
struct Handle : PoolHandle {};
using OrderHandle = Handle<struct OrderTag>;      // incomplete tag type is fine
using QuoteHandle = Handle<struct QuoteTag>;
// OrderHandle h = QuoteHandle{};                 // ill-formed
```

```cpp
// ---- RAII lease: unique ownership of one slot --------------------------
template<class Pool>
class PoolLease {
    Pool* pool_{};
    PoolHandle handle_{};
public:
    PoolLease() noexcept = default;
    PoolLease(Pool& p, PoolHandle h) noexcept : pool_{&p}, handle_{h} {}
    PoolLease(PoolLease const&)            = delete;
    PoolLease& operator=(PoolLease const&) = delete;
    PoolLease(PoolLease&& o) noexcept
        : pool_{std::exchange(o.pool_, nullptr)}, handle_{o.handle_} {}
    PoolLease& operator=(PoolLease&& o) noexcept {
        if (this != &o) { reset(); pool_ = std::exchange(o.pool_, nullptr);
                          handle_ = o.handle_; }
        return *this;
    }
    ~PoolLease() { reset(); }
    void reset() noexcept { if (pool_) { (void)pool_->erase(handle_); pool_ = nullptr; } }
    [[nodiscard]] PoolHandle get() const noexcept { return handle_; }
    [[nodiscard]] auto* operator->() const noexcept { return pool_->get(handle_); }
    explicit operator bool() const noexcept { return pool_ != nullptr; }
};
```

| Reference form | Size | Detects stale? | Liability |
|---|---|---|---|
| `T&` | 8 B | no | caller can retain past release; cannot express "gone" |
| `T*` | 8 B | no | same dangling/reuse hazard; nullable only |
| index `uint32` | 4 B | no | in-range after reuse — silently names another object |
| `{index, generation}` | 8 B | yes, until wrap | one branch + metadata load per access |
| packed 64-bit | 8 B | yes | fixed bit budget; atomic-swappable |
| RAII lease | 16 B | n/a | move-only protocol; must outlive nothing, die before pool |
| `shared_ptr<T>` w/ custom deleter | 16 B + ctrl | yes (ownership) | control-block allocation and atomics |

**Interview line** — "A generation handle turns use-after-free into a detectable `nullptr`, but it detects staleness only until the generation counter wraps back onto the same index."

**Traps** — comparing handles from two different pools is meaningless · generation 0 must be unreachable or default handles validate · a `T*` obtained from `get()` is only valid until the next `erase`/`clear` on that slot · `operator<=>` on `PoolHandle` orders by index then generation, which is not a stable identity ordering across pools · a handle is not ownership: two copies can both "release" unless the API forbids it.

---

## 37.4 Single-threaded, thread-local, and concurrent pool variants

```cpp
// ===================== COMPLETE FIXED-CAPACITY POOL ======================
#include <array>
#include <cassert>
#include <compare>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <limits>
#include <memory>
#include <new>
#include <type_traits>
#include <utility>

enum class PoolError : std::uint8_t { exhausted, invalid_handle };

struct PoolHandle {
    std::uint32_t index{};
    std::uint32_t generation{};                      // 0 == null
    [[nodiscard]] constexpr bool is_null() const noexcept { return generation == 0; }
    friend constexpr auto operator<=>(PoolHandle, PoolHandle) = default;
};

template<class T, std::size_t Capacity>
class FixedPool {
    static_assert(Capacity > 0);
    static_assert(Capacity < std::numeric_limits<std::uint32_t>::max());
    static_assert(std::is_nothrow_destructible_v<T>,
                  "release path must not throw");

    static constexpr std::uint32_t none = std::numeric_limits<std::uint32_t>::max();

    struct Slot {
        alignas(T) std::byte storage[sizeof(T)];
        std::uint32_t generation{1};                 // starts at 1, never 0
        std::uint32_t next_free{none};
        bool occupied{false};

        [[nodiscard]] T* raw() noexcept { return reinterpret_cast<T*>(storage); }
        [[nodiscard]] T* object() noexcept {
            return std::launder(reinterpret_cast<T*>(storage));
        }
        [[nodiscard]] T const* object() const noexcept {
            return std::launder(reinterpret_cast<T const*>(storage));
        }
    };

public:
    using value_type = T;
    using handle_type = PoolHandle;

    FixedPool() noexcept {
        for (std::uint32_t i = 0; i != Capacity; ++i)
            slots_[i].next_free = (i + 1 < Capacity) ? i + 1 : none;
    }

    // Embedded storage cannot relocate: any move dangles every outstanding T*.
    FixedPool(FixedPool const&)            = delete;
    FixedPool& operator=(FixedPool const&) = delete;
    FixedPool(FixedPool&&)                 = delete;
    FixedPool& operator=(FixedPool&&)      = delete;

    ~FixedPool() { clear(); }                        // RAII: no leaked destructors

    // ---- acquire ---------------------------------------------------------
    template<class... Args>
    [[nodiscard]] std::expected<PoolHandle, PoolError>
    emplace(Args&&... args)
        noexcept(std::is_nothrow_constructible_v<T, Args...>)
    {
        static_assert(std::is_constructible_v<T, Args...>);
        if (free_head_ == none) return std::unexpected(PoolError::exhausted);

        auto const index = free_head_;
        Slot& s = slots_[index];

        // Construct FIRST: if this throws, free_head_/metadata are untouched.
        std::construct_at(s.raw(), std::forward<Args>(args)...);

        free_head_   = s.next_free;                  // now commit
        s.next_free  = none;
        s.occupied   = true;
        ++live_count_;
        high_water_  = live_count_ > high_water_ ? live_count_ : high_water_;
        return PoolHandle{index, s.generation};
    }

    // ---- resolve ---------------------------------------------------------
    [[nodiscard]] T* get(PoolHandle h) noexcept {
        Slot* s = validate(h);
        return s ? s->object() : nullptr;
    }
    [[nodiscard]] T const* get(PoolHandle h) const noexcept {
        Slot const* s = validate(h);
        return s ? s->object() : nullptr;
    }
    [[nodiscard]] bool contains(PoolHandle h) const noexcept {
        return validate(h) != nullptr;
    }
    // Unchecked fast path: precondition is a valid handle.
    [[nodiscard]] T& operator[](PoolHandle h) noexcept {
        assert(contains(h));
        return *slots_[h.index].object();
    }

    // ---- release ---------------------------------------------------------
    bool erase(PoolHandle h) noexcept {
        Slot* s = validate(h);
        if (s == nullptr) return false;              // double-erase / stale → false

        std::destroy_at(s->object());                // 1. destroy
        s->occupied   = false;                       // 2. mark dead
        s->generation = advance(s->generation);      // 3. invalidate old handles
        s->next_free  = free_head_;                  // 4. link
        free_head_    = h.index;                     // 5. publish
        --live_count_;
        return true;
    }

    // ---- bulk reset ------------------------------------------------------
    void clear() noexcept {
        for (std::uint32_t i = 0; i != Capacity; ++i) {
            Slot& s = slots_[i];
            if (s.occupied) {
                std::destroy_at(s.object());
                s.occupied   = false;
                s.generation = advance(s.generation);
            }
            s.next_free = (i + 1 < Capacity) ? i + 1 : none;   // one canonical list
        }
        free_head_  = 0;
        live_count_ = 0;
    }

    // ---- observers -------------------------------------------------------
    [[nodiscard]] static constexpr std::size_t capacity() noexcept { return Capacity; }
    [[nodiscard]] std::size_t size()        const noexcept { return live_count_; }
    [[nodiscard]] bool        empty()       const noexcept { return live_count_ == 0; }
    [[nodiscard]] bool        full()        const noexcept { return free_head_ == none; }
    [[nodiscard]] std::size_t high_water()  const noexcept { return high_water_; }

    // ---- iterate live objects (dense scan, skips free slots) -------------
    template<class F>
    void for_each(F&& f) {
        for (std::uint32_t i = 0; i != Capacity; ++i)
            if (slots_[i].occupied)
                f(PoolHandle{i, slots_[i].generation}, *slots_[i].object());
    }

private:
    [[nodiscard]] Slot* validate(PoolHandle h) noexcept {
        if (h.index >= Capacity) return nullptr;
        Slot& s = slots_[h.index];
        if (!s.occupied || s.generation != h.generation) return nullptr;
        return &s;
    }
    [[nodiscard]] Slot const* validate(PoolHandle h) const noexcept {
        if (h.index >= Capacity) return nullptr;
        Slot const& s = slots_[h.index];
        if (!s.occupied || s.generation != h.generation) return nullptr;
        return &s;
    }
    [[nodiscard]] static constexpr std::uint32_t advance(std::uint32_t g) noexcept {
        auto next = g + 1;
        return next == 0 ? 1 : next;             // never hand out generation 0
    }

    std::array<Slot, Capacity> slots_{};
    std::uint32_t free_head_{0};
    std::size_t   live_count_{0};
    std::size_t   high_water_{0};
};
```

```cpp
// ---- usage --------------------------------------------------------------
struct Order { std::uint64_t id; std::int64_t px; std::int32_t qty; };
FixedPool<Order, 1024> pool;

auto h = pool.emplace(Order{7, 100'50, 25});
if (!h) { /* deterministic exhaustion: h.error() == PoolError::exhausted */ }
if (Order* o = pool.get(*h)) o->qty -= 5;
bool erased  = pool.erase(*h);      // true
bool again   = pool.erase(*h);      // false — generation already advanced
Order* stale = pool.get(*h);        // nullptr
```

```cpp
// ---- thread-local variant: one pool per owner thread -------------------
thread_local FixedPool<Order, 1024> tls_pool;   // no synchronization needed
// Cross-thread handoff needs an explicit RETURN channel:
//   owner emplaces  → handle crosses SPSC queue → consumer reads object
//   consumer pushes handle back on a second SPSC queue → owner erases
// The object itself must not be touched concurrently during transfer.
```

```cpp
// ---- mutex variant: usually the right first answer ----------------------
#include <mutex>
template<class T, std::size_t N>
class LockedPool {
    mutable std::mutex m_;
    FixedPool<T, N> pool_;
public:
    template<class... Args>
    [[nodiscard]] std::expected<PoolHandle, PoolError> emplace(Args&&... a) {
        std::scoped_lock lk{m_};                    // ctor runs UNDER the lock
        return pool_.emplace(std::forward<Args>(a)...);
    }
    bool erase(PoolHandle h) { std::scoped_lock lk{m_}; return pool_.erase(h); }
    // get() intentionally absent: returning T* out of the lock re-opens the race.
    template<class F>
    auto with(PoolHandle h, F&& f) {
        std::scoped_lock lk{m_};
        return f(pool_.get(h));
    }
};
```

| Model | Sync cost | Correct when | Failure mode if violated |
|---|---|---|---|
| Single-threaded `FixedPool` | none | one thread owns all calls incl. `~FixedPool` | torn free list, double-issued slot |
| `thread_local` pool | none | alloc + free both on owner thread | free from wrong thread corrupts that thread's list |
| Thread-local + return queue | one SPSC push/pop | producer/consumer split known | object touched during transfer |
| Mutex-wrapped | one uncontended lock (~20 ns) | allocation is not the hot path | user ctor/dtor deadlock if it re-enters |
| Sharded (per-core pool + steal) | atomic on steal only | steady per-core load | steal path re-introduces ABA/ordering |
| Lock-free Treiber head | CAS + retry loop | you can prove ABA + lifetime + ordering | ABA reuse, use-after-free, torn publication |

**Interview line** — "A `thread_local` pool with an explicit cross-thread return queue is almost always faster and easier to prove correct than a lock-free free list."

**Traps** — `thread_local` destruction order at exit is unspecified relative to other TLS objects · calling a user constructor while holding the pool mutex risks reentrancy/deadlock · `get()` returning `T*` from a locked pool leaks a reference past the lock · deleting the move constructor is not optional for embedded storage.

---

## 37.5 Intrusive free lists and ABA implications

```cpp
// ---- intrusive: the link lives in the dead object's own bytes ----------
template<class T, std::size_t Capacity>
class IntrusivePool {
    static_assert(sizeof(T)  >= sizeof(std::uint32_t));
    static_assert(alignof(T) >= alignof(std::uint32_t));
    static constexpr std::uint32_t none = std::numeric_limits<std::uint32_t>::max();

    struct Slot { alignas(T) std::byte bytes[sizeof(T)]; };  // ZERO metadata

    std::array<Slot, Capacity> slots_{};
    std::uint32_t free_head_{0};

    [[nodiscard]] std::uint32_t* link(std::uint32_t i) noexcept {
        return std::launder(reinterpret_cast<std::uint32_t*>(slots_[i].bytes));
    }
public:
    IntrusivePool() noexcept {
        for (std::uint32_t i = 0; i != Capacity; ++i)
            std::construct_at(reinterpret_cast<std::uint32_t*>(slots_[i].bytes),
                              (i + 1 < Capacity) ? i + 1 : none);
    }
    template<class... Args>
    [[nodiscard]] T* allocate(Args&&... args) {
        if (free_head_ == none) return nullptr;
        auto const i    = free_head_;
        auto const next = *link(i);            // read link while slot is DEAD
        std::destroy_at(link(i));              // link object's lifetime ends
        T* p = std::construct_at(reinterpret_cast<T*>(slots_[i].bytes),
                                 std::forward<Args>(args)...);
        free_head_ = next;                     // commit only after success
        return p;
    }
    void deallocate(T* p) noexcept {
        auto const i = static_cast<std::uint32_t>(
            reinterpret_cast<Slot*>(p) - slots_.data());   // pointer → index
        std::destroy_at(p);                                // T lifetime ends
        std::construct_at(reinterpret_cast<std::uint32_t*>(slots_[i].bytes),
                          free_head_);                     // link lifetime begins
        free_head_ = i;
    }
};
// Note: no generation → no stale detection. Intrusive buys density, not safety.
```

```cpp
// ---- Treiber stack of free indices, and its ABA hole -------------------
#include <atomic>
std::atomic<std::uint32_t> head_;             // naive: index only

// pop (BROKEN under concurrency):
//   old = head_.load(acquire)
//   next = *link(old)                 <-- another thread may recycle `old` here
//   head_.compare_exchange_weak(old, next, acq_rel)   // CAS "succeeds" wrongly
```

```text
ABA:
  A: reads head == X, reads next(X) == Y, is descheduled
  B: pops X, pops Y, pushes X back        (head == X again, but next(X) == Z)
  A: CAS(head, X → Y) SUCCEEDS            head now points at a freed/wrong node
```

```cpp
// ---- tagged head: 32-bit index + 32-bit ABA counter in one 64-bit word --
struct TaggedHead {
    std::uint32_t index;
    std::uint32_t tag;          // incremented on EVERY successful pop
};
static_assert(sizeof(TaggedHead) == 8);
std::atomic<TaggedHead> free_head_;
static_assert(std::atomic<TaggedHead>::is_always_lock_free);   // 8 B → lock-free

std::uint32_t pop() noexcept {
    TaggedHead old = free_head_.load(std::memory_order_acquire);
    for (;;) {
        if (old.index == none) return none;
        std::uint32_t next = *link(old.index);
        TaggedHead desired{next, old.tag + 1};                 // tag defeats ABA
        if (free_head_.compare_exchange_weak(old, desired,
                std::memory_order_acq_rel,        // success: publish + observe
                std::memory_order_acquire))       // failure: reload old
            return old.index;
    }
}
void push(std::uint32_t i) noexcept {
    TaggedHead old = free_head_.load(std::memory_order_relaxed);
    TaggedHead desired;
    do {
        *link(i) = old.index;                     // write link BEFORE publishing
        desired = TaggedHead{i, old.tag + 1};
    } while (!free_head_.compare_exchange_weak(old, desired,
                 std::memory_order_release, std::memory_order_relaxed));
}
```

```cpp
// ---- 128-bit alternative: DWCAS (needs -mcx16 on x86-64) ---------------
struct alignas(16) WideHead { void* ptr; std::uint64_t tag; };
std::atomic<WideHead> wide_head_;
// is_lock_free() may be FALSE without hardware DWCAS → silent mutex fallback.
```

| ABA defence | Cost | Limit |
|---|---|---|
| Tagged index/pointer (64-bit) | 1 CAS on 8 B, always lock-free | tag wraps after 2³² pops on that head |
| DWCAS (128-bit ptr+tag) | needs `cmpxchg16b`/`casp`; `-mcx16` | may fall back to a lock silently |
| Hazard pointers | per-thread published slots + scan | retire latency, memory overhead |
| Epoch/RCU reclamation | grace-period bookkeeping | deferred free, unbounded batching |
| Never recycle (monotonic) | free | not a pool |

**Interview line** — "The object-handle generation and the free-list ABA tag solve different problems: the generation protects *users* of a slot, the tag protects the *CAS* on the head."

**Traps** — the free-list link and the ABA tag are not the same counter · reading `*link(old.index)` before the CAS is itself a use-after-free window even *with* a tag, unless slots are never unmapped · `compare_exchange_weak` may fail spuriously — always loop · `std::atomic<TaggedHead>` requires a trivially copyable struct with no padding holes · `relaxed` on push publication loses the link write; use `release`.

---

## 37.6 Exhaustion policy and deterministic failure

```cpp
// ---- expected<>: the default, allocation-free, branch-checked ---------
auto h = pool.emplace(args...);
if (!h) {
    switch (h.error()) {
        case PoolError::exhausted:      shed_load(); break;
        case PoolError::invalid_handle: std::unreachable();   // C++23
    }
}
Order& o = *pool.get(h.value_or(PoolHandle{}));   // careful: value_or gives null

// C++23 monadic chaining on expected
auto qty = pool.emplace(args...)
               .transform([&](PoolHandle x) { return pool.get(x)->qty; })
               .value_or(0);
```

```cpp
// ---- optional<handle>: when there is only one failure reason ----------
[[nodiscard]] std::optional<PoolHandle> try_emplace(auto&&... args);

// ---- null handle sentinel: cheapest, no wrapper -----------------------
[[nodiscard]] PoolHandle acquire() noexcept;   // returns {0,0} on exhaustion
// caller checks h.is_null()

// ---- fail fast: capacity is an internal invariant, not user input -----
PoolHandle must_emplace(auto&&... args) {
    auto h = pool.emplace(std::forward<decltype(args)>(args)...);
    if (!h) std::abort();          // or std::terminate / contract violation
    return *h;
}

// ---- spill to heap: explicit, measurable, breaks the tail bound -------
struct Spillable {
    std::expected<PoolHandle, PoolError> pooled;
    std::unique_ptr<Order>               heap;     // allocation on the slow path
};
```

```cpp
// ---- capacity accounting -------------------------------------------------
static_assert(sizeof(FixedPool<Order, 1024>) ==
              1024 * sizeof(/*Slot*/ struct{}) /* illustrative */, "");
// Budget:
//   slot bytes      Capacity * sizeof(Slot)          // includes metadata + padding
//   pool metadata   free_head_ + counters + padding
//   external        T may own heap allocations NOT counted in slot bytes
//   alignment       over-aligned T inflates both Slot and the whole array
```

| Policy | API shape | When | Cost of being wrong |
|---|---|---|---|
| Reject (`expected`/`optional`) | `expected<H, E>` | caller has a shed/retry path | one predictable branch |
| Fail fast (`abort`) | `H` + assertion | capacity is a proved invariant | crash instead of corruption |
| Block/wait | `H wait_acquire()` | producer can be back-pressured | needs release notification **and** a shutdown path |
| Spill to heap | tagged union | soft bound, latency hint only | tail latency and jitter, allocator lock |
| Evict oldest/LRU | `H acquire_evicting()` | cache semantics, legal victim exists | silently invalidates a live handle |
| Grow (chained blocks) | `deque`-of-blocks | "fixed" was never a requirement | address stability across blocks only |

```cpp
// ---- pre-flighting: prove capacity before the hot path ----------------
static_assert(FixedPool<Order, 1024>::capacity() >= kMaxInFlightOrders);
assert(pool.size() + batch.size() <= pool.capacity());   // debug pre-check
```

**Interview line** — "A fixed pool that silently falls back to `new` is not a bound, it is a latency hint — the fallback must be named, measured, and counted."

**Traps** — `value_or` on `expected<PoolHandle,E>` yields a default handle that *looks* usable · blocking acquire without a shutdown wake-up deadlocks on teardown · eviction must destroy the victim and advance its generation, not just relink it · counting only `Capacity * sizeof(T)` ignores metadata, padding, and `T`'s own heap allocations.

---

## 37.7 Bulk reset with monotonic arenas

```cpp
// ===================== COMPLETE BUMP ARENA ==============================
#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <memory>
#include <new>
#include <span>
#include <type_traits>
#include <utility>

template<std::size_t Capacity, std::size_t Align = alignof(std::max_align_t)>
class BumpArena {
    static_assert(std::has_single_bit(Align));
public:
    BumpArena() noexcept = default;
    BumpArena(BumpArena const&)            = delete;
    BumpArena& operator=(BumpArena const&) = delete;

    // ---- raw aligned bytes ----------------------------------------------
    [[nodiscard]] void* allocate_bytes(std::size_t bytes,
                                       std::size_t alignment) noexcept {
        if (bytes == 0 || alignment == 0 || !std::has_single_bit(alignment))
            return nullptr;
        void*       cursor = storage_.data() + offset_;
        std::size_t space  = Capacity - offset_;
        void*       fit    = std::align(alignment, bytes, cursor, space); // <memory>
        if (fit == nullptr) return nullptr;                               // exhausted
        auto* result = static_cast<std::byte*>(fit);
        offset_      = static_cast<std::size_t>(result - storage_.data()) + bytes;
        high_water_  = std::max(high_water_, offset_);
        return result;
    }

    // ---- typed construction, trivially destructible only ----------------
    template<class T, class... Args>
        requires (std::is_trivially_destructible_v<T> &&
                  std::is_nothrow_constructible_v<T, Args...>)
    [[nodiscard]] T* make(Args&&... args) noexcept {
        void* p = allocate_bytes(sizeof(T), alignof(T));
        return p ? std::construct_at(static_cast<T*>(p),
                                     std::forward<Args>(args)...) : nullptr;
    }

    // ---- contiguous array in one bump -----------------------------------
    template<class T>
        requires std::is_trivially_destructible_v<T>
    [[nodiscard]] std::span<T> make_array(std::size_t n) noexcept {
        if (n == 0) return {};
        if (n > Capacity / sizeof(T)) return {};              // overflow guard
        void* p = allocate_bytes(n * sizeof(T), alignof(T));
        if (!p) return {};
        auto* first = static_cast<T*>(p);
        std::uninitialized_value_construct_n(first, n);
        return std::span<T>{first, n};
    }

    // ---- checkpoints: LIFO nested phases --------------------------------
    struct Checkpoint { std::size_t offset; };
    [[nodiscard]] Checkpoint save() const noexcept { return Checkpoint{offset_}; }
    void restore(Checkpoint c) noexcept { offset_ = c.offset; }   // trivial types only

    void reset() noexcept { offset_ = 0; }        // O(1); invalidates EVERYTHING

    [[nodiscard]] std::size_t used()       const noexcept { return offset_; }
    [[nodiscard]] std::size_t remaining()  const noexcept { return Capacity - offset_; }
    [[nodiscard]] std::size_t high_water() const noexcept { return high_water_; }
    [[nodiscard]] static constexpr std::size_t capacity() noexcept { return Capacity; }

private:
    alignas(Align) std::array<std::byte, Capacity> storage_{};
    std::size_t offset_{};
    std::size_t high_water_{};
};
```

```cpp
// ---- nontrivial objects: bounded reverse-order destructor stack --------
template<std::size_t Capacity, std::size_t MaxDtors = 256>
class ScopedArena : public BumpArena<Capacity> {
    struct Record { void* object; void (*destroy)(void*) noexcept; };
    std::array<Record, MaxDtors> dtors_{};
    std::size_t dtor_count_{};
public:
    template<class T, class... Args>
        requires std::is_nothrow_constructible_v<T, Args...>
    [[nodiscard]] T* make(Args&&... args) noexcept {
        static_assert(std::is_nothrow_destructible_v<T>);
        if constexpr (std::is_trivially_destructible_v<T>)
            return BumpArena<Capacity>::template make<T>(std::forward<Args>(args)...);
        else {
            if (dtor_count_ == MaxDtors) return nullptr;   // record space exhausted
            auto save = this->save();                      // transactional across BOTH
            void* p = this->allocate_bytes(sizeof(T), alignof(T));
            if (!p) return nullptr;
            T* obj = std::construct_at(static_cast<T*>(p), std::forward<Args>(args)...);
            dtors_[dtor_count_++] = Record{
                obj, +[](void* v) noexcept { std::destroy_at(static_cast<T*>(v)); }};
            (void)save;
            return obj;
        }
    }
    struct Checkpoint { std::size_t offset; std::size_t dtors; };
    [[nodiscard]] Checkpoint save() const noexcept {
        return {BumpArena<Capacity>::used(), dtor_count_};
    }
    void restore(Checkpoint c) noexcept {                  // reverse order!
        while (dtor_count_ > c.dtors) {
            auto& r = dtors_[--dtor_count_];
            r.destroy(r.object);
        }
        BumpArena<Capacity>::restore({c.offset});
    }
    void reset() noexcept { restore(Checkpoint{0, 0}); }
    ~ScopedArena() { reset(); }
};
```

```cpp
// ---- std::pmr::monotonic_buffer_resource: the standard arena ----------
#include <array>
#include <memory_resource>
#include <vector>
#include <string>

alignas(std::max_align_t) std::array<std::byte, 64 * 1024> buf;

std::pmr::monotonic_buffer_resource arena{
    buf.data(), buf.size(),
    std::pmr::null_memory_resource()};       // HARD bound: overflow throws bad_alloc

std::pmr::monotonic_buffer_resource growing{buf.data(), buf.size()};        // grows
std::pmr::monotonic_buffer_resource fresh{std::pmr::new_delete_resource()}; // no buffer
std::pmr::monotonic_buffer_resource sized{4096};   // initial upstream block size

{
    std::pmr::vector<int>       v{&arena};   // allocator propagated from resource*
    std::pmr::string            s{"hot", &arena};
    std::pmr::vector<std::pmr::string> nested{&arena};   // inner strings share arena
    v.reserve(1024);
    // v's old blocks are ABANDONED on growth — monotonic never reclaims singly.
}                                            // containers destroyed FIRST
arena.release();                             // then bytes recycled/returned

// Other standard resources
std::pmr::memory_resource* d  = std::pmr::get_default_resource();
std::pmr::set_default_resource(&arena);                      // process-wide, careful
std::pmr::synchronized_pool_resource   sync_pool{&arena};    // thread-safe, size classes
std::pmr::unsynchronized_pool_resource fast_pool{&arena};    // single-thread pool
```

| Facility | Header | Semantics |
|---|---|---|
| `monotonic_buffer_resource(buf, n, upstream)` | `<memory_resource>` | bump over `buf`, then upstream blocks |
| `.release()` | | frees all blocks, rewinds to initial buffer; does **not** run destructors |
| `.upstream_resource()` | | the fallback resource pointer |
| `do_deallocate` | | **no-op** — bytes reusable only after `release()`/destruction |
| `null_memory_resource()` | | allocation always throws `bad_alloc` — makes the bound explicit |
| `new_delete_resource()` | | global `operator new`/`delete` |
| `(un)synchronized_pool_resource` | | size-class pools; `unsynchronized` is single-thread only |
| `pmr::polymorphic_allocator<T>` | | type-erased allocator; **does not** propagate on move-assign |
| `std::align(a, sz, ptr&, space&)` | `<memory>` | in-place alignment fit, `nullptr` if it does not fit |

| Property | Fixed typed pool | Monotonic arena |
|---|---|---|
| Object sizes | one `T` / one size class | mixed sizes and alignments |
| Individual release | O(1) free-list push | none — no-op |
| Address stability | until that slot's `erase` | until `reset()` / `release()` |
| Stale detection | generation handle | phase lifetime only |
| Fragmentation | fixed internal slot waste | alignment padding + abandoned growth blocks |
| Destructors | run per `erase`/`clear` | trivial types, or a destructor record stack |
| Allocation order | arbitrary reuse | strictly sequential bump |
| Reset cost | O(Capacity) | O(1) trivial; O(records) otherwise |
| Best fit | long-lived churn of one type | build-then-discard phase graphs |

**Interview line** — "Arena reset is O(1) only because nothing needs destroying; the moment a nontrivial type enters, you owe it either explicit destruction or a reverse-order destructor stack."

**Traps** — `alignas(max_align_t)` is fundamental alignment only, so a 64-byte-aligned request may not fit even with bytes remaining · `std::align` mutates its `ptr` and `space` arguments in place · `restore()` on an arena holding nontrivial objects skips their destructors · a `pmr::vector` growing inside a monotonic arena abandons every previous buffer · destroying the resource before its containers is UB · `set_default_resource` is a global mutation visible to every translation unit.

---

## 37.8 Debug poisoning, leak accounting, and lifetime assertions

```cpp
// ---- poison ONLY dead storage ------------------------------------------
#include <cstring>
inline constexpr std::byte kFreedPoison{0xDD};
inline constexpr std::byte kFreshPoison{0xCD};

void release_debug(Slot& s) noexcept {
    std::destroy_at(s.object());                       // lifetime ENDS here
    std::memset(s.storage, 0xDD, sizeof s.storage);    // now the bytes are just bytes
}
// NEVER: memset over a live T — it corrupts invariants and can race.
// NEVER: read poison through T* — no T exists there.
```

```cpp
// ---- canaries outside the T region -------------------------------------
template<class T>
struct GuardedSlot {
    std::uint64_t front_canary{0xA5A5A5A5A5A5A5A5ULL};
    alignas(T) std::byte storage[sizeof(T)];
    std::uint64_t back_canary{0x5A5A5A5A5A5A5A5AULL};
    [[nodiscard]] bool intact() const noexcept {
        return front_canary == 0xA5A5A5A5A5A5A5A5ULL &&
               back_canary  == 0x5A5A5A5A5A5A5A5AULL;
    }
};
```

```cpp
// ---- owner-thread assertion --------------------------------------------
#include <thread>
#ifndef NDEBUG
  #define POOL_ASSERT_OWNER() assert(std::this_thread::get_id() == owner_)
#else
  #define POOL_ASSERT_OWNER() ((void)0)
#endif
// member: std::thread::id owner_{std::this_thread::get_id()};
```

```cpp
// ---- free-list validation: no cycles, no duplicates, exact length ------
[[nodiscard]] bool validate_free_list() const noexcept {
    std::array<bool, Capacity> seen{};
    std::size_t count = 0;
    for (auto i = free_head_; i != none; i = slots_[i].next_free) {
        if (i >= Capacity)      return false;   // out of range
        if (seen[i])            return false;   // cycle or duplicate
        if (slots_[i].occupied) return false;   // occupied slot on the free list
        seen[i] = true;
        if (++count > Capacity) return false;   // belt and braces
    }
    return count + live_count_ == Capacity;     // invariant I4
}
```

```cpp
// ---- leak accounting at shutdown ---------------------------------------
~InstrumentedPool() {
    assert(validate_free_list());
    if (live_count_ != 0)
        report_leak(live_count_, high_water_);   // clean up AND report
    clear();                                     // RAII safety regardless
}
```

```cpp
// ---- ASan manual poisoning hooks (non-standard, guarded) ---------------
#if defined(__has_feature)
  #if __has_feature(address_sanitizer)
    #define POOL_ASAN 1
  #endif
#elif defined(__SANITIZE_ADDRESS__)
  #define POOL_ASAN 1
#endif

#ifdef POOL_ASAN
extern "C" void __asan_poison_memory_region(void const volatile*, std::size_t);
extern "C" void __asan_unpoison_memory_region(void const volatile*, std::size_t);
  #define POOL_POISON(p, n)   __asan_poison_memory_region((p), (n))
  #define POOL_UNPOISON(p, n) __asan_unpoison_memory_region((p), (n))
#else
  #define POOL_POISON(p, n)   ((void)0)
  #define POOL_UNPOISON(p, n) ((void)0)
#endif

// erase:   destroy_at(obj);  POOL_POISON(s.storage, sizeof s.storage);
// emplace: POOL_UNPOISON(s.storage, sizeof s.storage);  construct_at(s.raw(), ...);
// MUST unpoison before construction or the constructor's own writes trap.
```

```bash
# sanitizers and hardening
g++ -std=c++23 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer pool.cpp
g++ -std=c++23 -O2 -g -fsanitize=thread  concurrent_pool.cpp    # concurrent variants
g++ -std=c++23 -O2 -D_GLIBCXX_ASSERTIONS -fstack-protector-strong pool.cpp
ASAN_OPTIONS=detect_stack_use_after_return=1:strict_init_order=1 ./a.out
UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1 ./a.out
valgrind --tool=memcheck --track-origins=yes ./a.out     # also misses pool reuse
```

| Instrument | Catches | Build |
|---|---|---|
| generation handle | stale handle use after slot reuse | always on (it is the contract) |
| poison `0xDD` in dead slots | reads of freed slot through a stale `T*` | debug |
| ASan manual poison hooks | same, with a real ASan report and stack | `-fsanitize=address` |
| canary words around storage | overrun past `sizeof(T)` | debug |
| owner-thread id assert | cross-thread misuse of a confined pool | debug |
| `validate_free_list()` | cycles, duplicates, occupied slot on free list | debug / after each test |
| live + high-water counters | leaks, capacity sizing evidence | always (cheap) |
| TSan | data races in concurrent variants | `-fsanitize=thread` |

**Testing matrix**

```text
pool    fill exactly Capacity then assert deterministic exhaustion
        erase first / middle / last, then refill every slot
        ctor and dtor call counts balance (instrumented T)
        throwing ctor leaves free_head_, live_count_, free list unchanged
        double erase returns false; stale handle get() returns nullptr
        default/out-of-range handle rejected (index >= Capacity, generation 0)
        generation near UINT32_MAX follows documented wrap policy
        clear() destroys every live object and invalidates every handle
        over-aligned T: assert(reinterpret_cast<uintptr_t>(p) % alignof(T) == 0)
        randomized emplace/erase vs a reference std::map occupancy model
        validate_free_list() after every operation in the fuzz loop
arena   alignment 1,2,4,...,4096 each returns an aligned address or nullptr
        exact-fit allocation succeeds; one more byte fails
        padding counted in used()/high_water()
        reset() rebases; checkpoint restore rewinds bytes AND destructor records
        nontrivial destructor order is exactly reverse of construction
        null upstream pmr throws bad_alloc instead of growing
```

**Interview line** — "AddressSanitizer will not flag use-after-return-to-my-pool by default, because the memory is still allocated — the pool has to poison its own dead slots."

**Traps** — poisoning a live object corrupts it; poison strictly between `destroy_at` and the next `construct_at` · forgetting `POOL_UNPOISON` before construction makes the constructor itself trap · canaries inside the `alignas(T)` region change `sizeof(T)` assumptions — put them outside · `validate_free_list` is O(Capacity) and must never ship in the hot path · a debug-only atomic counter can silently add contention that changes the benchmark you were measuring.

---

**Recall card**

```text
slot            aligned bytes + metadata; NOT a T while free
construct       construct_at / placement new; only after the slot is safe to use
release         destroy_at → occupied=false → ++generation → link → publish head
invariant       occupied XOR on-free-list; live + free == Capacity; each slot once
handle          {index, generation}; validates staleness, does NOT own
pointer         stable until that slot's erase or pool destruction; reuse shares addresses
generation      advance on release, skip 0, finite wrap needs a stated policy
exhaustion      reject | wait | spill | evict | fail-fast — always explicit
intrusive       link lives in dead payload bytes; zero metadata, zero stale detection
ABA             tagged 64-bit head, or DWCAS, or hazard/epoch — not one bare index
arena           align + bump one cursor; individual deallocate is a no-op
trivial reset   rewind offset, O(1); every prior pointer invalid by contract
nontrivial      explicit destruction or reverse-order destructor record stack
pmr monotonic   null_memory_resource() upstream makes the bound real
thread model    confinement is a contract; TLS + return queue beats lock-free
debug           poison dead storage only, count live/high-water, validate free list
```

**Interview line** — "A fixed allocator is correct only when storage state, object lifetime, reference validity, and exhaustion are one explicit protocol: bytes become live objects exactly once, dead slots are recycled exactly once, and bulk reset never skips required destruction."
