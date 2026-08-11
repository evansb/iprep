# 26. Cache-conscious and data-oriented C++

*Part IV — Memory, representation, and performance*

---

**Recall**
- The C++ standard specifies no cache hierarchy, line size, TLB, NUMA, prefetcher, or miss latency — it gives contiguity, alignment, layout queries, and interference constants.
- Optimize the *bytes and branches actually touched by the dominant operation*, not `sizeof` and not asymptotic complexity.
- Spatial locality = nearby addresses; temporal locality = reuse before eviction; working set = data + metadata + code touched per interval.
- A contiguous walk lets hardware prefetch; a pointer chain serializes because the next address is only known after the current load returns.
- Working set must count parallel arrays, indices, hash metadata, allocator blocks, and touched code — not just the payload.
- AoS wins when one pass consumes most fields of one object; SoA wins when a pass scans one or few columns.
- SoA's invariant (all columns same length, same index meaning) must be enforced by encapsulation — public parallel vectors desynchronize silently.
- Members are laid out in declaration order with padding permitted between and after them; reordering large→small usually shrinks the object on common ABIs but is not portable law.
- `hardware_destructive_interference_size` = recommended *minimum* separation to avoid false sharing; `hardware_constructive_interference_size` = recommended *maximum* span to promote co-location.
- Both constants are implementation-defined, may be conservative, and are ABI-affecting when they appear in `alignas` on a type crossing a boundary.
- False sharing = independent writes to distinct objects sharing one coherence unit; true sharing = actual contention on the same logical state, which padding cannot fix.
- `memory_order_relaxed` changes ordering semantics, never cache-line ownership traffic — a relaxed RMW still invalidates the line everywhere.
- Indices survive container reallocation; pointers and references do not — but indices need bounds, sentinel, and generation rules.
- `[[likely]]`/`[[unlikely]]` are hints on statements/labels with no guaranteed machine-code outcome; "branchless C++" is not a language property.
- A branchless rewrite must never evaluate what the guarded branch would skip: OOB load, divide-by-zero, invalid shift, signed overflow, null deref, side effects.
- C++23 has **no** portable prefetch operation; prefetch is a target intrinsic behind a boundary with a correct no-prefetch fallback.
- Batching amortizes synchronization, call overhead, and bounds checks — while delaying the first element and enlarging the live set; always define a flush deadline.
- Inlining and template specialization improve a kernel and can simultaneously worsen the binary through instruction-cache and branch-target pressure.
- "Zero-cost" means an abstraction *can* compile to the hand-written equivalent, not that every abstraction in every build is free — it is an evidence claim.
- Hot-path rule: make the dominant data contiguous and compact, keep one writer next to its mutable state, split cold payloads out, bound indices, and choose dispatch from measured traffic.

```text
algorithm asks for values
   ├── registers / L1                    cheapest typical case
   ├── contiguous predictable stream      hardware prefetch works
   ├── large working set / TLB pressure   more misses
   └── dependent pointer chain            latency serializes

AoS: [id px qty fl][id px qty fl] ...
SoA: [id id id ...][px px px ...][qty ...][fl ...]

same logical object written by 2 threads      → true sharing
different objects on one coherence unit       → false sharing
```

---

## 26.1 Cache lines, locality, working sets, and memory latency

| Term | Meaning |
|---|---|
| Spatial locality | accessing addresses near recently accessed ones |
| Temporal locality | reusing data before it leaves a fast level |
| Working set | data + metadata + code actively needed over an interval |
| Cache line | hardware transfer/coherence unit; a platform property, not a C++ one |
| TLB reach | virtual address space covered by cached translations |
| MLP | ability to overlap independent misses (breaks with dependent chains) |
| Stride | address delta between successive accesses; 1-element stride is the friendly case |

```cpp
#include <span>
#include <cstdint>
#include <cstddef>
#include <new>          // hardware_*_interference_size
#include <type_traits>

// Contiguous walk: regular pattern, unit stride, independent loads.
std::int64_t sum(std::span<std::int64_t const> values) noexcept {
    std::int64_t total{};
    for (auto v : values) total += v;     // hardware can stream ahead
    return total;
}

// Strided walk: touches one field per object, wastes the rest of each line.
struct Order { std::uint64_t id; std::int64_t price; std::uint32_t qty; std::uint8_t side; bool active; };
std::int64_t sum_prices(std::span<Order const> os) noexcept {
    std::int64_t t{};
    for (auto const& o : os) t += o.price;  // stride == sizeof(Order), not 8
    return t;
}

// Dependent chain: next address unknown until current load retires.
struct Node { Order value; Node* next; };
std::size_t walk(Node const* n) noexcept {
    std::size_t k{};
    for (; n; n = n->next) ++k;             // latency serializes, no MLP
    return k;
}
```

```cpp
// ---- layout introspection: run these on the REAL target build ----------
struct Level {
    std::int64_t  price;
    std::uint64_t quantity;
    std::uint32_t count;
    std::uint32_t flags;
};

static_assert(sizeof(Level)  == 24);              // target-specific: verify, don't assume
static_assert(alignof(Level) == 8);
static_assert(std::is_standard_layout_v<Level>);  // required for offsetof to be well-defined
static_assert(offsetof(Level, count) == 16);      // <cstddef>; standard-layout only

constexpr std::size_t bytes_for_depth(std::size_t depth) noexcept {
    return depth * sizeof(Level);                 // array stride == sizeof, always
}
static_assert(bytes_for_depth(10) == 240);

// Interference constants (C++17, <new>) — implementation constants, often 64.
constexpr std::size_t sep = std::hardware_destructive_interference_size;
constexpr std::size_t tog = std::hardware_constructive_interference_size;
```

| Query | Header | Meaning |
|---|---|---|
| `sizeof(T)` | core | complete-object size **and** array stride (padding included) |
| `alignof(T)` | core | required alignment; `alignas` can raise it |
| `offsetof(T, m)` | `<cstddef>` | byte offset; defined only for standard-layout `T` |
| `std::is_standard_layout_v<T>` | `<type_traits>` | precondition for `offsetof`/wire mapping |
| `std::is_trivially_copyable_v<T>` | `<type_traits>` | `memcpy`-able; precondition for `std::bit_cast` |
| `std::has_unique_object_representations_v<T>` | `<type_traits>` | no padding bits → hashable/comparable byte-wise |
| `std::hardware_destructive_interference_size` | `<new>` | recommended min separation (avoid false sharing) |
| `std::hardware_constructive_interference_size` | `<new>` | recommended max span (promote co-location) |
| `std::align(a, sz, ptr, space)` | `<memory>` | advance `ptr` to an alignment inside a buffer |
| `std::assume_aligned<N>(p)` | `<memory>` | C++20; UB if `p` is not `N`-aligned |
| `alignas(N)` / `alignas(T)` | core | raise alignment; cannot lower it |

```cpp
// C++20 alignment assertion for a hot kernel (UB if the promise is false).
#include <memory>
void kernel(double* raw, std::size_t n) {
    double* p = std::assume_aligned<64>(raw);   // lets the compiler assume aligned loads
    for (std::size_t i = 0; i < n; ++i) p[i] *= 2.0;
}
```

**Traps** — "the payload is only 16 bytes" ignores the 64-byte node, allocator header, and random bucket · `sizeof` measured in a debug build with different flags/ABI is not your production layout · `offsetof` on a non-standard-layout type is conditionally supported · TLB pressure shows up as misses no data-layout metric predicts · a random access with perfect complexity can be slower than a linear scan of a small array.

---

## 26.2 Array of Structs versus Struct of Arrays

```cpp
// ---- AoS: natural when a pass consumes most fields of one object -------
struct Order {
    std::uint64_t id;
    std::int64_t  price;
    std::uint32_t quantity;
    std::uint8_t  side;
    bool          active;
};
std::vector<Order> orders;

for (Order const& o : orders)                     // one fetch reaches every field
    if (o.active) publish(o.id, o.price, o.quantity, o.side);
```

```cpp
// ---- SoA: natural when a pass touches a subset of fields ---------------
class OrdersSoA {
    std::vector<std::uint64_t> ids_;
    std::vector<std::int64_t>  prices_;
    std::vector<std::uint32_t> quantities_;
    std::vector<std::uint8_t>  sides_;
    std::vector<std::uint8_t>  active_;   // NOT vector<bool>: proxy + shared words

public:
    [[nodiscard]] std::size_t size() const noexcept { return ids_.size(); }

    void reserve(std::size_t n) {          // grow every column together
        ids_.reserve(n); prices_.reserve(n); quantities_.reserve(n);
        sides_.reserve(n); active_.reserve(n);
    }

    std::size_t push(Order const& o) {     // single mutation point == the invariant
        ids_.push_back(o.id);
        prices_.push_back(o.price);
        quantities_.push_back(o.quantity);
        sides_.push_back(o.side);
        active_.push_back(o.active);
        return ids_.size() - 1;
    }

    void erase_unordered(std::size_t i) noexcept {   // O(1), destroys order
        auto swap_pop = [i](auto& col) { col[i] = col.back(); col.pop_back(); };
        swap_pop(ids_); swap_pop(prices_); swap_pop(quantities_);
        swap_pop(sides_); swap_pop(active_);
    }

    // Column views: the whole point — contiguous homogeneous scan.
    [[nodiscard]] std::span<std::uint32_t const> quantities() const noexcept {
        return quantities_;
    }
    [[nodiscard]] std::span<std::int64_t> prices() noexcept { return prices_; }
};

std::uint64_t total_quantity(OrdersSoA const& d) noexcept {
    std::uint64_t t{};
    for (std::uint32_t q : d.quantities()) t += q;   // zero bandwidth on cold columns
    return t;
}
```

```cpp
// ---- AoSoA / blocked hybrid: bounded grouping + vector-friendly columns -
template<std::size_t N>
struct OrderBlock {
    std::array<std::uint64_t, N> ids{};
    std::array<std::int64_t,  N> prices{};
    std::array<std::uint32_t, N> quantities{};
    std::size_t size{};                     // N is a tuning parameter, not a formula
};
using Book = std::vector<OrderBlock<16>>;

// ---- hot/cold AoS split (see 26.7) -------------------------------------
struct HotOrder { std::uint64_t id; std::int64_t price; std::uint32_t qty; std::uint32_t cold; };
```

| Access pattern | Often favorable | Reason |
|---|---|---|
| Consume all fields per object | AoS | one compact object fetch; simple API |
| Scan one/few numeric fields | SoA | no bandwidth for cold columns; vectorizes |
| Random update by object id | AoS or hybrid | one index reaches every related field |
| Batch transform one column | SoA | contiguous homogeneous values |
| Frequent insert/erase | AoS | one mutation keeps fields grouped |
| Mixed hot/cold fields | hot AoS + cold side table | keeps the common record small |
| Multi-thread column ownership | SoA | different threads write different arrays |

```cpp
// Encapsulated invariant — the reason not to expose parallel public vectors.
assert(ids_.size() == prices_.size());
assert(ids_.size() == quantities_.size());
```

**Traps** — `std::vector<bool>` as an SoA column gives a proxy, no `data()`, and a data race between distinct bits · a partial mutation (exception between two `push_back`s) desynchronizes columns; grow all columns first, then commit · SoA makes "give me one whole object" a gather across N cache lines · SoA erase must touch every column, so `erase_unordered` cost scales with column count · AoSoA block size is a per-target measurement, never 64/`sizeof(T)` by reflex.

---

## 26.3 Padding, alignment, and cache-line interference constants

```cpp
// ---- declaration order controls padding --------------------------------
struct Loose {                 // 1 + 7 pad + 8 + 1 + 7 pad = 24 on common ABIs
    std::uint8_t  tag;
    std::uint64_t sequence;
    std::uint8_t  side;
};
struct Compact {               // 8 + 1 + 1 + 6 pad = 16 on common ABIs
    std::uint64_t sequence;
    std::uint8_t  tag;
    std::uint8_t  side;
};
static_assert(sizeof(Compact) <= sizeof(Loose));  // true on common ABIs, not universal law

// ---- every alignas spelling --------------------------------------------
struct alignas(64)            A64  { int x; };                 // literal
struct alignas(double)        AD   { char c; };                // borrow another type's alignment
struct alignas(std::hardware_destructive_interference_size) ACL { std::atomic<int> v; };
alignas(32) int buffer[8];                                     // on an object
alignas(16) static thread_local std::byte scratch[256];
struct Over { alignas(16) std::uint32_t a; std::uint32_t b; }; // on a member: forces padding
// struct Under { alignas(1) std::uint64_t v; };                // ill-formed: cannot lower
static_assert(alignof(A64) == 64 && sizeof(A64) == 64);        // size rounds up to alignment
```

```cpp
// ---- over-aligned dynamic allocation (C++17 aligned new) ---------------
auto* p  = new A64;                                  // uses aligned operator new
auto* pa = new A64[16];                              // stride 64, each element aligned
delete p; delete[] pa;
auto up  = std::make_unique<A64[]>(16);              // also aligned-aware
void* raw = ::operator new(1024, std::align_val_t{64});
::operator delete(raw, std::align_val_t{64});        // MUST pass the alignment back
// std::aligned_storage / aligned_union: DEPRECATED in C++23 — use alignas + std::byte[].
alignas(Order) std::byte storage[sizeof(Order)];     // the modern manual-storage spelling
Order* o = std::construct_at(reinterpret_cast<Order*>(storage), Order{});
std::destroy_at(o);
```

```cpp
// ---- interference constants: both directions ---------------------------
#include <new>
#include <atomic>

// destructive: keep these APART
struct alignas(std::hardware_destructive_interference_size) Counter {
    std::atomic<std::uint64_t> value{};
};
static_assert(sizeof(Counter) >= std::hardware_destructive_interference_size);

// constructive: keep these TOGETHER (read as a unit)
struct SharedReadMostly { std::uint64_t version; std::uint64_t count; };
static_assert(sizeof(SharedReadMostly) <= std::hardware_constructive_interference_size);
```

| Facility | Header | Notes |
|---|---|---|
| `alignas(N)` / `alignas(T)` | core | raises alignment; ill-formed if it lowers |
| `alignof(T)` | core | current alignment requirement |
| `std::align_val_t` | `<new>` | tag for over-aligned `operator new`/`delete` |
| `std::hardware_destructive_interference_size` | `<new>` | recommended min offset between independently-written objects |
| `std::hardware_constructive_interference_size` | `<new>` | recommended max size for promoting true sharing |
| `std::align(al, size, ptr, space)` | `<memory>` | in-buffer alignment; updates `ptr`/`space`, returns null on failure |
| `std::assume_aligned<N>(p)` | `<memory>` | C++20 optimizer promise; UB if violated |
| `std::max_align_t` | `<cstddef>` | alignment of the largest scalar; malloc's guarantee |
| `std::aligned_storage`/`_union` | `<type_traits>` | **deprecated C++23**; replace with `alignas` + `std::byte[]` |
| `[[no_unique_address]]` | core | C++20; lets an empty member occupy no space |

```cpp
// [[no_unique_address]]: stateless policy costs zero bytes.
struct EmptyCmp { bool operator()(int a, int b) const noexcept { return a < b; } };
struct Sorted {
    [[no_unique_address]] EmptyCmp cmp{};   // typically 0 bytes
    std::vector<int> data;
};
static_assert(sizeof(Sorted) == sizeof(std::vector<int>));  // common ABIs
```

**Traps** — `alignas` in a struct definition is ABI: changing it breaks every TU that saw the old layout · GCC/Clang have historically reported 64 while `std::hardware_destructive_interference_size` in headers can trigger `-Winterference-size` ABI warnings — pin it in one place · over-aligned types allocated with `::operator new(size)` (non-aligned overload) are UB unless the alignment is `<= __STDCPP_DEFAULT_NEW_ALIGNMENT__` · alignment does not separate array elements unless `sizeof` rounds up, which it does for complete-object arrays but not for a packed manual buffer · bit-fields have implementation-defined allocation and are poor wire formats · shrinking a struct that splits fields consumed together is a pessimization.

---

## 26.4 False sharing and contention-aware layout

```cpp
// ---- the classic defect ------------------------------------------------
struct CountersBad {
    std::atomic<std::uint64_t> producer{};   // same 64-byte line
    std::atomic<std::uint64_t> consumer{};   // → every write invalidates the other core
};

// ---- padded separation -------------------------------------------------
struct CountersSeparated {
    alignas(std::hardware_destructive_interference_size)
        std::atomic<std::uint64_t> producer{};
    alignas(std::hardware_destructive_interference_size)
        std::atomic<std::uint64_t> consumer{};
};
static_assert(sizeof(CountersSeparated) >=
              2 * std::hardware_destructive_interference_size);

// ---- explicit trailing pad (portable, no ABI-visible alignas) ----------
template<class T>
struct PaddedSlot {
    T value{};
    std::byte pad[std::hardware_destructive_interference_size - sizeof(T) % 
                  std::hardware_destructive_interference_size]{};
};

// ---- per-thread sharded counter: no coherence traffic on the hot path --
class ShardedCounter {
    struct alignas(std::hardware_destructive_interference_size) Shard {
        std::atomic<std::uint64_t> v{};
    };
    std::vector<Shard> shards_;
public:
    explicit ShardedCounter(std::size_t n) : shards_(n) {}
    void add(std::size_t shard, std::uint64_t d) noexcept {
        shards_[shard].v.fetch_add(d, std::memory_order_relaxed);  // still coherence-local
    }
    [[nodiscard]] std::uint64_t total() const noexcept {           // cold aggregation
        std::uint64_t t{};
        for (auto const& s : shards_) t += s.v.load(std::memory_order_relaxed);
        return t;   // NOT a consistent snapshot — a sum of independent reads
    }
};
```

```cpp
// ---- relaxed does NOT remove sharing traffic ---------------------------
std::atomic<std::uint64_t> a{}, b{};                 // likely same line
a.fetch_add(1, std::memory_order_relaxed);           // still takes the line EXCLUSIVE
// Relaxed changes ordering/visibility rules, not physical line ownership.

// ---- better first question: does the other thread need to WRITE at all? -
struct SpscIndices {
    alignas(std::hardware_destructive_interference_size)
        std::atomic<std::size_t> write{};   // producer-owned; consumer reads rarely
    alignas(std::hardware_destructive_interference_size)
        std::atomic<std::size_t> read{};    // consumer-owned; producer reads rarely
    alignas(std::hardware_destructive_interference_size)
        std::size_t cached_read{};          // producer-private snapshot: avoids the load
};
```

| Case | Meaning | Response |
|---|---|---|
| True sharing | threads contend on the same logical state | shard, partition, or redesign the protocol; padding cannot help |
| False sharing | independent writes share coherence storage | `alignas`/padding, or thread-local aggregation |
| Read sharing | many threads read immutable data | usually constructive; publish once with release/acquire |
| Read-mostly + rare write | writer invalidates all readers | versioned snapshot, seqlock, or RCU-style publish |

```text
producer core: writes write_index  ─┐
consumer core: writes read_index   ─┴─ same line → ping-pong on every operation
after alignas separation           → each core owns its own line
after index caching                → the cross-line load happens once per batch
```

**Traps** — padding a struct that is *truly* contended just moves the bottleneck · `alignas` inside `std::vector<T>` works because `vector` honors `alignof(T)` since C++17, but a hand-rolled allocator may not · a `std::atomic<T>` in the same struct as its guarded payload re-shares the line · false sharing is a hardware event: prove it with multicore scaling curves plus counters, not by reading the header · `std::atomic_ref` gives no extra separation — the underlying object's address decides · thread-local aggregation trades staleness for throughput; define the flush point.

---

## 26.5 Pointer chasing, indirection, and contiguous alternatives

```cpp
// ---- node-based: stable addresses, dependent misses --------------------
struct Node { Order value; Node* next; };   // per-element allocation + 8B link + miss

// ---- flat pool + index links: relocatable, one allocation --------------
inline constexpr std::uint32_t invalid_index = 0xFFFF'FFFFu;

struct Handle {                              // stable logical identity
    std::uint32_t index{invalid_index};
    std::uint32_t generation{};
    friend constexpr bool operator==(Handle, Handle) = default;
    [[nodiscard]] constexpr bool valid() const noexcept { return index != invalid_index; }
};

struct Slot {
    Order         value{};
    std::uint32_t next{invalid_index};       // index, survives vector reallocation
    std::uint32_t prev{invalid_index};
    std::uint32_t generation{};              // bumped on reuse → detects stale handles
};

class SlotPool {
    std::vector<Slot> slots_;
    std::uint32_t     free_head_{invalid_index};
public:
    explicit SlotPool(std::size_t n) : slots_(n) {          // resize(), not reserve()
        for (std::uint32_t i = 0; i + 1 < n; ++i) slots_[i].next = i + 1;
        slots_.back().next = invalid_index;
        free_head_ = 0;
    }
    [[nodiscard]] Handle acquire(Order const& o) noexcept {
        if (free_head_ == invalid_index) return {};          // exhaustion is YOUR policy
        auto i = free_head_;
        free_head_ = slots_[i].next;
        slots_[i].value = o;
        slots_[i].next = slots_[i].prev = invalid_index;
        return Handle{i, slots_[i].generation};
    }
    void release(Handle h) noexcept {
        if (!alive(h)) return;
        ++slots_[h.index].generation;                        // invalidates old handles
        slots_[h.index].next = free_head_;
        free_head_ = h.index;
    }
    [[nodiscard]] bool alive(Handle h) const noexcept {
        return h.valid() && h.index < slots_.size()
            && slots_[h.index].generation == h.generation;
    }
    [[nodiscard]] Order* get(Handle h) noexcept {
        return alive(h) ? &slots_[h.index].value : nullptr;
    }
};
```

```cpp
// ---- sorted vector instead of a tree (read-dominant) -------------------
#include <algorithm>
#include <ranges>
class FlatMap {
    std::vector<std::int64_t> keys_;     // sorted
    std::vector<Level>        vals_;     // parallel column
public:
    [[nodiscard]] Level* find(std::int64_t k) noexcept {
        auto it = std::ranges::lower_bound(keys_, k);        // O(log n), compact probes
        if (it == keys_.end() || *it != k) return nullptr;
        return &vals_[static_cast<std::size_t>(it - keys_.begin())];
    }
    void insert(std::int64_t k, Level v) {                   // O(n) movement
        auto it  = std::ranges::lower_bound(keys_, k);
        auto pos = it - keys_.begin();
        keys_.insert(it, k);
        vals_.insert(vals_.begin() + pos, v);
    }
};
// C++23 std::flat_map / std::flat_set are exactly this shape, standardized.
```

| Requirement | Contiguous / index design | Cost paid |
|---|---|---|
| Stable logical handle | `{index, generation}` into a fixed pool | bounds + reuse contract |
| Linked ordering | `next`/`prev` indices in a pre-sized vector | manual free list |
| Ordered lookup, read-heavy | sorted vector / `std::flat_map` (C++23) | O(n) insert |
| Dense key range | direct-index array (`price - base_tick`) | wasted space if sparse |
| Sparse + cold payload | compact hot record + side table | one cold indirection |
| Iterate all, delete rarely | vector + tombstone/`erase_unordered` | order not preserved |
| Heterogeneous polymorphic set | one vector per concrete type | loses a single loop |

```cpp
// ---- the fake-contiguity trap ------------------------------------------
std::vector<std::unique_ptr<Order>> ptrs;   // the POINTERS are contiguous
for (auto const& p : ptrs) use(*p);         // each deref is still a random miss
std::vector<Order> flat;                    // the OBJECTS are contiguous
```

**Traps** — a `vector` relocation preserves indices, never pointers/references/iterators · `reserve` alone does not create objects; index-based pools need `resize` · index width (`uint32_t`) is a capacity contract — document and assert it · generation counters wrap; use enough bits or a monotonic 64-bit id · `std::deque`, `std::map`, `std::unordered_map` nodes are separately allocated, so "O(1)" hides a dependent miss · `std::list::splice` is O(1) but each traversal step is a miss.

---

## 26.6 Branch prediction, branchless code, and when branchless loses

```cpp
// ---- source conditional → branch, cmov, predication, or vector mask ----
std::uint64_t sum_positive(std::span<int const> xs) noexcept {
    std::uint64_t s{};
    for (int x : xs)
        if (x > 0) s += static_cast<unsigned>(x);   // lowering is compiler/target/data dependent
    return s;
}

// ---- explicit branchless forms (verify they actually help) -------------
int max_bl(int a, int b) noexcept { return a > b ? a : b; }        // usually a cmov already
std::uint64_t add_masked(std::uint64_t s, int x) noexcept {
    auto mask = static_cast<std::uint64_t>(-(x > 0));               // 0 or all-ones
    return s + (static_cast<std::uint64_t>(static_cast<unsigned>(x)) & mask);
}
int clamp_bl(int v, int lo, int hi) noexcept { return std::min(std::max(v, lo), hi); }
int abs_bl(int v) noexcept { return v < 0 ? -v : v; }               // careful: INT_MIN is UB

// ---- branchless partition (the pattern that actually wins) -------------
std::size_t partition_positive(std::span<int const> in, std::span<int> out) noexcept {
    std::size_t n{};
    for (int x : in) { out[n] = x; n += (x > 0); }   // unconditional store, conditional advance
    return n;                                        // no misprediction; one extra store
}

// ---- attributes: HINTS, not guarantees (C++20) -------------------------
if (rc == 0) [[likely]]   { fast_path(); }
else                      [[unlikely]] { slow_path(); }
switch (op) {
    [[likely]]   case Op::Add: return add();
    [[unlikely]] case Op::Rare: return rare();
    default: return other();
}
[[assume(n > 0)]];                     // C++23: UB if false; can delete a branch entirely
if (!ptr) [[unlikely]] return nullptr; // cold-path bias

// ---- keep the cold path OUT of the hot body ----------------------------
[[noreturn]] void throw_bad(int rc);   // out-of-line, not inlined into the loop
[[gnu::cold]] void log_rare(int rc);   // implementation attribute: separate text section
```

| When a branch is cheap | When branchless can win |
|---|---|
| Outcome is highly predictable (>~95% one way) | Outcome is near-random; misprediction dominates |
| Skipped work is expensive | Both alternatives are cheap **and** safe to evaluate |
| It guards a rare error/cold path | It enables vectorization/masking |
| It prevents a load that must not happen | Data can be partitioned or table-dispatched |
| Branchless would lengthen the dependency chain | The branch sits in an unpredictable inner loop |

```cpp
// ---- branchless correctness traps --------------------------------------
// int r = valid ? table[i] : fallback;              // OK: guarded
// int r = table[i] * valid + fallback * !valid;     // UB if i is out of bounds
// int q = d ? n / d : 0;                            // OK
// int q = (n / d) & -(d != 0);                      // UB: divide by zero still executes
// int s = x << k;                                   // UB if k >= bit width, even masked later
// int m = a * b;                                    // signed overflow is UB in the masked form too
// A branchless rewrite must not evaluate anything the branch would have skipped.
```

```cpp
// Safe branchless helpers that avoid UB entirely.
#include <bit>
#include <cstdint>
std::uint32_t select(bool c, std::uint32_t a, std::uint32_t b) noexcept {
    std::uint32_t m = static_cast<std::uint32_t>(-static_cast<std::int32_t>(c));
    return (a & m) | (b & ~m);                       // unsigned only: wrap is defined
}
int rotate(std::uint32_t v, int k) noexcept { return std::rotl(v, k); }  // C++20, no UB shift
```

**Traps** — "branchless" is not a C++ property; check the actual assembly for the actual flags · `?:` short-circuits, arithmetic masking does not · `[[assume]]` (C++23) is UB when violated and is not a check — never use it on untrusted input · `[[likely]]` on the wrong side can hurt more than no annotation · replacing a 99%-predicted branch with a cmov usually loses · a branchless loop that stores unconditionally may add memory traffic that dwarfs the saved mispredictions · PGO beats hand-annotating branches.

---

## 26.7 Hot/cold splitting and compact identifiers

```cpp
// ---- fat record: bandwidth wasted on fields the hot pass never reads ---
struct FatOrder {
    std::uint64_t id; std::int64_t price; std::uint32_t quantity;   // hot
    std::pmr::string      client_text;                              // cold, allocates
    std::source_location  origin;                                   // cold, C++20
    std::uint64_t         diagnostic_flags;                         // cold
    std::chrono::system_clock::time_point submitted;                // cold
};

// ---- split: compact hot record + index into a cold side table ----------
struct HotOrder {
    std::uint64_t id;
    std::int64_t  price;
    std::uint32_t quantity;
    std::uint32_t cold_index;      // invalid_index when there is no cold payload
};
static_assert(sizeof(HotOrder) == 24);

struct ColdOrder {
    std::pmr::string     client_text;
    std::source_location origin;
    std::uint64_t        diagnostic_flags;
};

std::vector<HotOrder>  hot;        // the only thing the matching loop touches
std::vector<ColdOrder> cold;       // touched on error/report paths only
```

```cpp
// ---- compact identifiers replace strings/pointers in hot records -------
enum class SymbolId : std::uint32_t { invalid = 0xFFFF'FFFFu };   // strong, sentinel-carrying
class SymbolTable {
    std::vector<std::string>                        names_;
    std::unordered_map<std::string_view, SymbolId>  index_;
public:
    SymbolId intern(std::string_view s);                 // cold, setup-time
    [[nodiscard]] std::string_view name(SymbolId id) const noexcept {
        return names_[static_cast<std::uint32_t>(id)];   // cold, reporting-time
    }
};
struct Quote { SymbolId symbol; std::int64_t price; std::uint32_t qty; };  // 16 bytes, no string
```

```cpp
// ---- bit packing: cheaper bytes, costlier access -----------------------
struct PackedFlags {                    // manual masks: portable, explicit
    std::uint32_t bits{};
    static constexpr std::uint32_t kActive = 1u << 0;
    static constexpr std::uint32_t kBuy    = 1u << 1;
    static constexpr std::uint32_t kIoc    = 1u << 2;
    [[nodiscard]] constexpr bool active() const noexcept { return bits & kActive; }
    constexpr void set_active(bool v) noexcept {
        bits = v ? (bits | kActive) : (bits & ~kActive);
    }
};

struct BitFields {                      // implementation-defined allocation/order/straddle
    std::uint32_t side  : 1;
    std::uint32_t type  : 3;
    std::uint32_t venue : 6;
    std::uint32_t rest  : 22;
};
// Bit-fields: no address, no reference binding, adjacent fields are ONE memory location
// for the memory model (C++11+ separates only across a zero-width/aligned boundary),
// so concurrent writes to neighbouring bit-fields can race. Never a wire format.
```

| Split cost | Detail |
|---|---|
| Indirection | every cold access is a second random load |
| Two lifetimes | insertion/erase must keep `hot[i].cold_index` consistent |
| Rollback complexity | a throw between the two pushes desynchronizes |
| Extra allocation | the cold table may allocate per record |
| Handle rules | sentinel value + generation when slots are reused |

**Traps** — splitting when the "cold" field is read 40% of the time doubles the misses · a compact id without an explicit invalid value forces a parallel `bool` and undoes the savings · id reuse without generations resurrects stale references silently · bit-packing turns an independent store into a read-modify-write, which is a race under concurrency and a false-sharing amplifier · `std::vector<bool>`-style packing costs a shift+mask per element in the hot loop · measure whether the smaller record actually reduced *bytes touched by the dominant pass*.

---

## 26.8 Prefetching, batching, and hardware-sensitive assumptions

```cpp
// ---- C++23 has NO portable prefetch. Wrap the intrinsic. ---------------
inline void prefetch_read(void const* p) noexcept {
#if defined(__GNUC__) || defined(__clang__)
    __builtin_prefetch(p, /*rw=*/0, /*locality=*/3);   // 3 = keep in all levels
#elif defined(_MSC_VER) && (defined(_M_X64) || defined(_M_IX86))
    _mm_prefetch(static_cast<char const*>(p), _MM_HINT_T0);
#else
    (void)p;                                           // correct no-prefetch fallback
#endif
}

// Prefetch is useful only with lookahead distance the chain actually allows.
void process_indexed(std::span<Order const> pool, std::span<std::uint32_t const> ids) {
    constexpr std::size_t lookahead = 8;               // tuning parameter, measure it
    for (std::size_t i = 0; i < ids.size(); ++i) {
        if (i + lookahead < ids.size())
            prefetch_read(&pool[ids[i + lookahead]]);  // address known EARLY → can help
        consume(pool[ids[i]]);
    }
}
// A linked list cannot do this: node->next is not known until node arrives.
```

| Manual prefetch helps when | It loses when |
|---|---|
| Future addresses are known far enough ahead | The hint issues too late in a dependent chain |
| Misses are costly and not already overlapped | Hardware prefetch already covers the stream |
| The data is still useful when it lands | Data is evicted before use |
| Spare bandwidth exists | It pollutes cache / adds address-generation work |

```cpp
// ---- batching: amortize per-item overhead ------------------------------
template<class T, std::size_t N>
class Batch {
    std::array<T, N> values_{};
    std::size_t      size_{};
public:
    [[nodiscard]] bool full() const noexcept { return size_ == N; }
    [[nodiscard]] bool empty() const noexcept { return size_ == 0; }
    bool push(T v) noexcept {
        if (size_ == N) return false;
        values_[size_++] = std::move(v);
        return true;
    }
    [[nodiscard]] std::span<T> items() noexcept { return {values_.data(), size_}; }
    void clear() noexcept { size_ = 0; }
};

// Flush policy is part of the design, not an afterthought.
class Batcher {
    Batch<Order, 64> batch_;
    std::chrono::steady_clock::time_point deadline_{};
public:
    void submit(Order o) {
        if (batch_.empty())
            deadline_ = std::chrono::steady_clock::now() + std::chrono::microseconds{50};
        if (!batch_.push(o)) { flush(); batch_.push(o); }        // full
        else if (batch_.full()) flush();
    }
    void poll() { if (!batch_.empty() && std::chrono::steady_clock::now() >= deadline_) flush(); }
    void flush() { publish_all(batch_.items()); batch_.clear(); } // deadline / burst-end / shutdown
};
```

| Batching amortizes | Batching costs |
|---|---|
| Synchronization / queue publication | first item waits for the batch to fill |
| Virtual/function-call overhead | larger live working set |
| Timestamp + telemetry updates | bursty downstream behaviour |
| Loop setup and bounds checks | needs an explicit flush deadline |
| Cache acquisition on shared state | tail-latency spikes at flush |

```cpp
// ---- software pipelining: expose MLP by interleaving independent work --
void lookup_pair(std::span<std::uint32_t const> keys, HashTable const& t) {
    for (std::size_t i = 0; i + 1 < keys.size(); i += 2) {
        auto h0 = t.hash(keys[i]);        // two INDEPENDENT miss streams overlap
        auto h1 = t.hash(keys[i + 1]);
        prefetch_read(t.bucket(h0));
        prefetch_read(t.bucket(h1));
        consume(t.probe(h0, keys[i]));
        consume(t.probe(h1, keys[i + 1]));
    }
    // Increases live registers and code complexity; the compiler may already do this.
}
```

**Traps** — prefetching every node of a linked list issues the hint after the address is already resolved: pure overhead · `__builtin_prefetch` on an invalid address is safe on common targets but the computation of that address may not be · locality hint `0` (non-temporal) evicts rather than retains — wrong for data you re-read · batching without a deadline stalls forever on a quiet channel · batch size that exceeds L1 turns an amortization into a miss generator · `std::this_thread::yield`/sleep inside a flush path destroys the latency budget you were optimizing.

---

## 26.9 Virtual dispatch, type erasure, code size, and instruction cache

| Mechanism | Data/code effect |
|---|---|
| Virtual dispatch | one shared body; vptr per object; indirect branch; devirtualizable when the type is visible |
| `std::variant` + `visit` | closed set; no allocation; generates N (or N×M) visitor specializations |
| Function-pointer table | indexed indirect branch; compact, runtime-configurable |
| Templates / CRTP | full inlining; can duplicate large bodies per instantiation |
| Type erasure (`std::function`) | uniform object; indirect call; may allocate; no SBO guarantee |
| `std::move_only_function` (C++23) | same, move-only, const/noexcept-correct signatures |
| `std::function_ref` / `inplace_function` | non-owning / fixed-storage callable; no allocation |

```cpp
// ---- virtual: one body, indirect call ----------------------------------
struct Strategy {
    virtual ~Strategy() = default;
    virtual void on_tick(Quote const&) = 0;
};
void run(std::span<std::unique_ptr<Strategy>> ss, Quote const& q) {
    for (auto& s : ss) s->on_tick(q);   // indirect branch; predictable if types are homogeneous
}
// Sorting/grouping by concrete type makes the indirect branch predictable AND
// keeps each strategy's instruction footprint resident.

// ---- final enables devirtualization ------------------------------------
struct Passive final : Strategy { void on_tick(Quote const&) override; };
// A `final` class/method lets the compiler resolve the call statically when the
// static type is visible.

// ---- variant: closed set, no allocation, no vtable ---------------------
using Event = std::variant<Add, Cancel, Trade>;
void handle(Event const& e) {
    std::visit([]<class T>(T const& x) {          // C++20 template lambda
        if constexpr (std::same_as<T, Add>)         apply_add(x);
        else if constexpr (std::same_as<T, Cancel>) apply_cancel(x);
        else                                        apply_trade(x);
    }, e);
}
// visit lowers to a jump table over the index; each alternative gets its own body.

// ---- function-pointer table: compact, configurable ---------------------
using Handler = void (*)(void* ctx, Quote const&);
struct Slot { Handler fn; void* ctx; };
std::array<Slot, 8> table;
void dispatch(std::size_t i, Quote const& q) { table[i].fn(table[i].ctx, q); }

// ---- type erasure: allocation is the hidden cost -----------------------
std::function<void(Quote const&)> f = [big = std::array<std::byte, 256>{}](Quote const&) {};
// captures exceed any SBO → heap allocation; std::function has NO SBO guarantee.
std::move_only_function<void(Quote const&) const> g = [](Quote const&) {};   // C++23
```

```cpp
// ---- keep the policy static, keep the BULK body shared -----------------
enum class DecodeMode { Fix, Itch, Ouch };

void decode_bulk(std::span<std::byte const> in, DecodeMode mode);   // ONE out-of-line body

template<DecodeMode Mode>
inline void decode(std::span<std::byte const> in) {
    decode_bulk(in, Mode);            // tiny wrapper; no per-mode duplication of the kernel
}

// Anti-pattern: templating a 2000-line body on a bool.
template<bool Checked> void process_all(std::span<Order> os);   // 2 full copies of everything

// Fix: hoist the invariant check, share the kernel.
void process_all(std::span<Order> os, bool checked) {
    if (checked) validate(os);        // branch once, outside
    process_kernel(os);               // one body
}

// Explicit instantiation moves code out of every TU (declaration in header):
extern template void decode<DecodeMode::Fix>(std::span<std::byte const>);
```

| Code-size lever | Effect |
|---|---|
| `inline` / heavy templates | removes call overhead, duplicates bodies at each site |
| `extern template` | suppresses implicit instantiation per TU; one definition elsewhere |
| `[[gnu::noinline]]` / `[[msvc::noinline]]` | keeps a cold body out of the hot loop |
| `[[gnu::cold]]` / `[[gnu::hot]]` | section placement hints for I-cache locality |
| `-Os` on cold TUs, `-O2/-O3` on hot | per-TU size/speed split |
| LTO + PGO | cross-TU inlining decided by measured hotness, not by guesses |
| Type-erased common core + thin typed shell | one instantiated body, many typed façades |

**Traps** — "virtual calls are slow" is false for homogeneous, predictable dynamic types; heterogeneous interleaved types are the real cost · `std::visit` over a 3×3 variant pair generates 9 bodies · `std::function` copies and may allocate on every assignment in a hot loop · a template kernel instantiated for 20 types can evict the rest of the hot path from L1i · devirtualization needs the definition visible: LTO or a header body · measuring only the microbenchmark hides the whole-binary I-cache regression.

---

## 26.10 Zero-cost abstraction: what must actually be measured

```cpp
// ---- the claim, made checkable at compile time -------------------------
struct PriceTicks {
    std::int64_t value{};
    friend constexpr auto operator<=>(PriceTicks, PriceTicks) = default;
    constexpr PriceTicks& operator+=(PriceTicks o) noexcept { value += o.value; return *this; }
};
static_assert(sizeof(PriceTicks)  == sizeof(std::int64_t));   // no size cost
static_assert(alignof(PriceTicks) == alignof(std::int64_t));
static_assert(std::is_trivially_copyable_v<PriceTicks>);      // memcpy-able, register-passable
static_assert(std::is_trivially_destructible_v<PriceTicks>);
static_assert(std::is_standard_layout_v<PriceTicks>);
static_assert(std::has_unique_object_representations_v<PriceTicks>);  // no padding bits

// ---- an abstraction that is NOT free -----------------------------------
struct Fee { std::function<double(double)> rule; };           // indirect call + possible alloc
static_assert(!std::is_trivially_copyable_v<Fee>);
struct FeeStatic { double rate; double operator()(double x) const noexcept { return x*rate; } };
static_assert(std::is_trivially_copyable_v<FeeStatic>);       // inlines to a multiply
```

```cpp
// ---- views vs owning: the most common hidden copy -----------------------
void take_copy(std::vector<Order> os);        // allocates + copies every call
void take_view(std::span<Order const> os);    // pointer + size, no allocation
void take_str(std::string s);                 // may allocate
void take_sv(std::string_view s);             // no allocation; watch lifetime

// ---- benchmark hygiene: prevent the optimizer from deleting the work ---
template<class T>
inline void do_not_optimize(T const& v) noexcept {
#if defined(__GNUC__) || defined(__clang__)
    asm volatile("" : : "r,m"(v) : "memory");
#else
    volatile auto sink = v; (void)sink;
#endif
}
```

| Evidence a "zero-cost" claim requires | Why |
|---|---|
| Equivalent semantics and safety in both arms | a faster arm that skips a check is not a comparison |
| Production build: same compiler, flags, LTO/PGO, assert/exception mode | debug iterators and `-O0` invert every result |
| Generated code inspected for the hot inner loop | proves inlining/devirtualization actually happened |
| Allocation count + object size/layout audit | catches ownership and SBO surprises |
| End-to-end latency **distribution**, not the mean | tail is where abstraction cost surfaces |
| Hardware counters: cache/TLB misses, branches, instructions | ties the delta to a mechanism |
| Several representative inputs, not a constant-foldable toy | prevents the compiler from evaluating the benchmark |
| Repeat on every supported CPU/toolchain | layout and lowering differ per target |

| Hidden cost to audit | Symptom |
|---|---|
| Abstraction owns instead of views | allocation count scales with call count |
| Callable/type erasure allocates | `operator new` in the hot profile |
| Range pipeline recomputes or blocks vectorization | more instructions, same misses |
| Error/exception representation enlarges hot values | `sizeof` of the return type grew |
| Templates duplicate code excessively | binary size + I-cache misses up |
| Bounds checks not proven redundant | extra compare/branch per element |
| Debug/sanitizer iterators | intentional overhead — never benchmark with them |
| Atomic refcount / `shared_ptr` copies | coherence traffic on the control block |

```text
measurement checklist
workload    realistic sizes, ordering, skew, hit/miss ratio, read/update mix
build       production compiler + flags, LTO/PGO state, asserts/exceptions mode
layout      sizeof/alignof/offsets, live set, bytes touched per operation
latency     full distribution and outliers, not average cycles
counters    cache/TLB misses, branch misses, instructions, coherence events
controls    warmup, CPU affinity, allocator state, dead-code prevention
variants    AoS/SoA/hybrid, branch/branchless — under identical semantics
regression  every supported CPU and toolchain
```

**Interview line** — "Zero-cost abstraction means the abstraction *can* compile to the hand-written equivalent under a production build — it is a claim you demonstrate with equivalent semantics, generated code, an allocation/layout audit, and end-to-end latency distributions, not a property of the keyword."

**Traps** — a counter correlation is not causation: verify only the intended dimension changed · a microbenchmark whose input is constant-foldable measures nothing · comparing an abstraction against an *incorrect* baseline (missing bounds check, missing overflow handling) is a fabricated win · shrinking `sizeof` while splitting co-accessed fields is a regression · aligning every object to a cache line inflates footprint, cuts objects per page, and increases lines touched — separate only independently-written state that evidence shows conflicts · "replace every `map`" is not data-oriented design; start from the actual operations and bounds.
