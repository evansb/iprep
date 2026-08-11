# 16. Standard-library vocabulary and complexity

*Part III — Standard library quick reference*

---

**Recall**
- A library specification is a contract over types, iterators, ownership, complexity, invalidation, exception safety, and thread safety — "it compiles" satisfies only the first clause.
- Complexity bounds count *abstract operations* (comparisons, swaps, applications of a function), never cache misses, allocations, syscalls, or contention.
- `value_type` is not always `decltype(*it)` — proxy iterators (`vector<bool>`, `zip_view`) return prvalue proxies, so spell `auto&&`.
- `size()` returns unsigned `size_type`; iterator distances are signed `difference_type` — use `std::ssize` when subtracting.
- A sentinel only needs `it == sent` to be valid; it need not have the iterator's type, and `sized_sentinel_for` is what makes `last - first` O(1).
- Iterator concepts stack: input ⊂ forward (multipass) ⊂ bidirectional (`--`) ⊂ random access (O(1) `+n`, `<`) ⊂ contiguous (addressable, spannable).
- Allocator *identity* and *propagation traits* decide whether container move-assign is O(1) buffer steal or O(n) element-wise move.
- `pmr` changes where storage comes from — not complexity, not invalidation, not thread safety; the `memory_resource` must outlive every client.
- Ordered containers and `sort` require a **strict weak ordering**: irreflexive, asymmetric, transitive, with transitive incomparability.
- Unordered containers require `key_equal(a,b) ⇒ hash(a) == hash(b)`; the converse (collisions) is allowed and expected.
- Mutating a key's ordering/hash value while it sits in a container silently corrupts the container — extract, mutate, reinsert.
- Amortized O(1) bounds a *sequence*, average O(1) bounds an *expected input*; neither bounds an individual call's latency.
- An iterator is valid only while its storage lives *and* no operation has invalidated it — `end()` is invalidated far more often than references.
- Views borrow: copying a view copies a handle, extends no lifetime, freezes no mutation; returning a view into a local dangles.
- `borrowed_range` means iterators survive destruction of the *range object*, not of the underlying elements; non-borrowed temporaries yield `std::ranges::dangling`.
- Vector reallocation prefers copy over a throwing move (`move_if_noexcept`) to preserve the strong guarantee.
- Baseline thread safety: concurrent `const` access on one object is fine, concurrent mutation is not; distinct elements may be written concurrently except in packed/proxy containers.
- Generic swap is `using std::swap; swap(a,b);` — never a qualified `std::swap` in a template.
- Transparent comparators/hashes (`is_transparent`) enable heterogeneous lookup: find by `string_view` without materializing a `std::string`.
- Container choice comes from access pattern, mutation location, locality, stability, and capacity policy — not from one Big-O cell.

---

## 16.1 Value types, iterators, sentinels, allocators, comparators, and hashes

```cpp
// ---- container nested typedefs: the vocabulary ------------------------
using C  = std::vector<Order>;
using V  = C::value_type;        // Order
using R  = C::reference;         // Order&        (proxy for vector<bool>)
using CR = C::const_reference;   // Order const&
using P  = C::pointer;           // allocator_traits<A>::pointer
using S  = C::size_type;         // unsigned, implementation-defined
using D  = C::difference_type;   // signed
using I  = C::iterator;          // contiguous_iterator for vector
using A  = C::allocator_type;    // std::allocator<Order>

// associative extras
using K   = std::map<int, Order>::key_type;      // int
using M   = std::map<int, Order>::mapped_type;   // Order
using VT  = std::map<int, Order>::value_type;    // std::pair<const int, Order>
using CMP = std::map<int, Order>::key_compare;   // std::less<int>
using H   = std::unordered_map<int, Order>::hasher;     // std::hash<int>
using EQ  = std::unordered_map<int, Order>::key_equal;  // std::equal_to<int>
```

```cpp
// ---- iterator / range traits (prefer these in generic code) ----------
#include <iterator>
using Val  = std::iter_value_t<It>;            // the *value*  (no reference)
using Ref  = std::iter_reference_t<It>;        // decltype(*it) — may be a proxy
using RRef = std::iter_rvalue_reference_t<It>; // decltype(ranges::iter_move(it))
using Dif  = std::iter_difference_t<It>;
using Com  = std::iter_common_reference_t<It>;

using RV = std::ranges::range_value_t<Rng>;
using RR = std::ranges::range_reference_t<Rng>;
using RD = std::ranges::range_difference_t<Rng>;
using RS = std::ranges::range_size_t<Rng>;

// Legacy spelling (pre-C++20, still everywhere):
using LV = std::iterator_traits<It>::value_type;
using LC = std::iterator_traits<It>::iterator_category;
```

```cpp
// ---- proxy-safe element binding --------------------------------------
for (auto&& x : rng) use(x);        // OK for proxies AND real references
// for (T& x : rng) ...             // ill-formed for vector<bool>, zip_view
auto v = *it;                       // copy of the value — decays a proxy? NO:
auto p = *it;                       // for vector<bool> this is the PROXY type
bool b = *it;                       // explicit target type collapses the proxy
auto val = std::iter_value_t<It>(*it);   // guaranteed a real value
```

```cpp
// ---- sentinels ---------------------------------------------------------
template<std::input_iterator I, std::sentinel_for<I> S>
std::size_t count_items(I first, S last) {          // iterator + sentinel pair
    std::size_t n = 0;
    for (; first != last; ++first) ++n;
    return n;
}

std::ranges::subrange sr{first, last};              // pairs them into a range
std::counted_iterator ci{first, 10};                // C++20
auto stop = std::default_sentinel;                  // compares via i.count()==0
std::unreachable_sentinel;                          // never equal — infinite range

static_assert(std::sized_sentinel_for<int*, int*>); // last - first is O(1)
auto d1 = std::distance(f, l);      // O(1) random access, else O(n)
auto d2 = std::ranges::distance(r); // O(1) if sized_range/sized_sentinel
```

| Concept | Adds over previous | Enables |
|---|---|---|
| `input_iterator` | single-pass read, `*i`, `++i` | one-shot algorithms; copies share position |
| `output_iterator<T>` | `*i = t` | `back_inserter`, `ostream_iterator` |
| `forward_iterator` | multipass, equality-preserving, default-constructible | two-pass algorithms, `unique`, `rotate` |
| `bidirectional_iterator` | `--i` | `reverse`, `prev`, reverse adaptors |
| `random_access_iterator` | `i += n`, `i[n]`, `i - j`, `<=>` in O(1) | `sort`, `nth_element`, heap ops, binary search *movement* |
| `contiguous_iterator` | `std::to_address(i)`, elements adjacent | `span`, C APIs, memcpy/SIMD |

```cpp
// ---- iterator adaptors -----------------------------------------------
std::back_inserter(v); std::front_inserter(d); std::inserter(s, s.begin());
std::move_iterator{first};                    // *it yields T&&
std::reverse_iterator{v.end()};               // base() is one past the target
std::istream_iterator<int>{std::cin};          // sentinel: default-constructed
std::ostream_iterator<int>{std::cout, ","};
std::common_iterator<I, S>{first};             // erase sentinel type for legacy API
```

```cpp
// ---- allocator protocol (all access via allocator_traits) -------------
template<class T, class Alloc = std::allocator<T>>
class Buffer {
    using Traits = std::allocator_traits<Alloc>;
    using Ptr    = typename Traits::pointer;
    [[no_unique_address]] Alloc alloc_{};
    Ptr   data_{};
    std::size_t size_{}, cap_{};
public:
    void grow(std::size_t n) {
        Ptr p = Traits::allocate(alloc_, n);              // storage only
        for (std::size_t i = 0; i < size_; ++i)
            Traits::construct(alloc_, std::to_address(p + i),
                              std::move_if_noexcept(data_[i]));  // object lifetime
        for (std::size_t i = size_; i-- > 0;)
            Traits::destroy(alloc_, std::to_address(data_ + i));
        if (data_) Traits::deallocate(alloc_, data_, cap_);
        data_ = p; cap_ = n;
    }
};
```

| `allocator_traits` member | Meaning |
|---|---|
| `allocate(a, n)` / `deallocate(a, p, n)` | raw storage; `n` must match on release |
| `allocate_at_least(a, n)` | C++23 — returns `{ptr, count}` with `count >= n` |
| `construct(a, p, args...)` / `destroy(a, p)` | object lifetime, allocator-aware |
| `rebind_alloc<U>` | allocator for a different type (node containers need it) |
| `select_on_container_copy_construction(a)` | which allocator the copy gets |
| `propagate_on_container_copy_assignment` | POCCA |
| `propagate_on_container_move_assignment` | POCMA — **false ⇒ move-assign may be O(n)** |
| `propagate_on_container_swap` | POCS — false + unequal allocators ⇒ swap is UB |
| `is_always_equal` | all instances compare equal ⇒ cheap moves/swaps |
| `max_size(a)` | upper bound on `allocate` |

```cpp
// ---- pmr: same containers, different storage source -------------------
#include <memory_resource>
std::array<std::byte, 8192> stack_buf;
std::pmr::monotonic_buffer_resource arena{stack_buf.data(), stack_buf.size(),
                                          std::pmr::null_memory_resource()};
std::pmr::vector<Event> events{&arena};       // allocator = polymorphic_allocator
std::pmr::unsynchronized_pool_resource pool{&arena};   // NOT thread-safe
std::pmr::synchronized_pool_resource   spool;          // thread-safe, locks
std::pmr::set_default_resource(&arena);       // process-wide default
auto* def = std::pmr::get_default_resource(); // originally new_delete_resource()
// null_memory_resource(): allocate() always throws bad_alloc — proves no fallback.
```

```cpp
// ---- comparator: strict weak ordering ---------------------------------
// irreflexive:   !comp(x, x)
// asymmetric:    comp(x,y) ⇒ !comp(y,x)
// transitive:    comp(x,y) && comp(y,z) ⇒ comp(x,z)
// incomparability transitive: (!comp(x,y) && !comp(y,x)) is an equivalence
struct ByPriceThenId {
    bool operator()(Order const& a, Order const& b) const noexcept {
        return std::tie(a.price, a.id) < std::tie(b.price, b.id);   // total, strict
    }
};
struct Desc { bool operator()(int a, int b) const noexcept { return b < a; } };

// BROKEN comparators — each is UB when handed to sort/map:
// return a.price <= b.price;                 // not irreflexive
// return std::abs(a.p - b.p) < eps;          // incomparability not transitive
// return a.k < b.k && a.id < b.id;           // not a total order (both false both ways)
// double keys with NaN: every comparison false ⇒ equivalence class explodes
```

```cpp
// ---- hash + equality contract -----------------------------------------
struct SymbolHash {
    using is_transparent = void;                      // enables heterogeneous lookup
    std::size_t operator()(Symbol const& s)   const noexcept { return (*this)(s.view()); }
    std::size_t operator()(std::string_view s) const noexcept {
        return std::hash<std::string_view>{}(s);
    }
};
struct SymbolEqual {
    using is_transparent = void;
    bool operator()(Symbol const& a, Symbol const& b)      const noexcept;
    bool operator()(Symbol const& a, std::string_view b)   const noexcept;
    bool operator()(std::string_view a, Symbol const& b)   const noexcept;
};
std::unordered_map<Symbol, Book, SymbolHash, SymbolEqual> books;

// Combining hashes (std has no hash_combine; write one):
constexpr std::size_t hash_combine(std::size_t seed, std::size_t h) noexcept {
    return seed ^ (h + 0x9e3779b97f4a7c15ULL + (seed << 6) + (seed >> 2));
}
```

**Traps** — `iterator_category` (legacy tag) ≠ iterator *concept* · `std::distance` on an input range consumes it · comparing iterators from different containers is UB · `std::hash<T>` is not specialized for `std::pair`/`std::tuple` · a `size_t` loop counting down with `i >= 0` never terminates.

---

## 16.2 Big-O guarantees versus actual constant factors

| Guarantee | Promises | Omits |
|---|---|---|
| O(1) | counted work independent of `n` | allocation, cache miss, lock, syscall, cost of one `T` operation |
| Amortized O(1) | average over a *sequence* of operations | magnitude and placement of the spike |
| Average O(1) | expectation under the specified input model | adversarial collisions, tail latency, rehash |
| O(log n) | comparison/traversal *count* | pointer chasing, comparator cost, node allocation |
| O(n) | linear counted work | contiguous+vectorized vs random pointer chase |
| O(n log n) | comparisons | moves, projections, memory traffic, branch misses |

```text
standard complexity   (counted operations)
  + cost of one value operation      (long-string compare, deep copy)
  + allocation behavior              (malloc, page fault, arena contention)
  + locality                         (L1/L2/LLC/TLB misses, prefetchability)
  + branch predictability
  + synchronization / system effects
  = observed latency distribution on ONE build/platform/workload
```

| Operation | Stated bound | What actually happens |
|---|---|---|
| `vector::push_back` | amortized O(1) | one call may allocate + relocate all `n` elements |
| `vector::insert(mid)` | O(n) | contiguous `memmove` — often faster than a "O(1)" list insert |
| `list::insert(it, v)` | O(1) | *given* `it`; finding it is O(n), plus one node allocation + cache miss |
| `unordered_map::find` | average O(1) | worst case O(n) on a degenerate bucket; hash of a string is O(len) |
| `unordered_map::insert` | amortized average O(1) | rehash is O(n) and re-hashes every key |
| `map::find` | O(log n) comparisons | log n dependent loads, each a likely cache miss |
| `sort` | O(n log n) comparisons | introsort: quicksort + heapsort fallback + insertion sort tail |
| `stable_sort` | O(n log n), or O(n log² n) if no memory | allocates a temporary buffer |
| `deque::operator[]` | O(1) | two indirections (map block → chunk) |
| `string == string` | O(n) | length check first, then `memcmp` |

```cpp
// ---- comparator cost dominates the complexity class -------------------
std::map<std::string, Level> byname;   // O(log n) comparisons ...
byname.find(long_key);                 // ... each comparison is O(len) memcmp
std::map<std::uint32_t, Level> byid;   // O(log n) single-word compares

// ---- measured reality: linear scan beats the tree at small n ----------
// 64 contiguous uint32 keys: one or two cache lines, vectorizable, no branches
// 64-node red-black tree: ~6 dependent random loads = ~6 cache misses
std::vector<std::pair<std::uint32_t, Level>> flat;   // sorted, contiguous
auto it = std::ranges::lower_bound(flat, key, {}, &std::pair<std::uint32_t, Level>::first);
```

```cpp
// ---- amortization is not a latency bound ------------------------------
v.reserve(expected_max);        // moves the spike to setup
// or: fixed-capacity design that REJECTS overflow instead of reallocating
if (v.size() == v.capacity()) return Status::Full;   // deterministic
```

**Interview line** — "Amortized constant bounds a sequence, average constant bounds an expected input, and neither is a worst-case latency bound for the call I am about to make on the hot path."

**Traps** — quoting O(1) for `unordered_map` under adversarial or clustered keys · assuming `reserve` prevents all future allocation (it does not survive `shrink_to_fit`, `clear`+refill is fine) · counting comparisons while the comparator allocates · `shrink_to_fit` can itself allocate.

---

## 16.3 Invalidations, ownership, views, and borrowed ranges

- A handle is usable only while (a) the referred storage is alive and (b) no operation has invalidated it.
- `end()` is an iterator and changes on nearly every size-changing operation, even when element references survive.

| Storage model | Insert | Erase | Notes |
|---|---|---|---|
| Contiguous dynamic (`vector`, `string`) | realloc ⇒ **all** handles die; else at/after `pos` | at/after `pos`, incl. old `end()` | `data()` changes on realloc |
| Segmented (`deque`) | at ends: **iterators** die, references live; middle: all die | ends: only erased element + iterators; middle: all | no `reserve`, no `data()` |
| Node ordered (`map`, `set`, `list`) | nothing invalidated | only the erased node | `splice`/`extract` transfer nodes intact |
| Node unordered (`unordered_map`) | rehash ⇒ **iterators** die, references/pointers live | only the erased element | `reserve`/`max_load_factor` control rehash |
| Adapters (`stack`, `queue`, `priority_queue`) | n/a — no iterators exposed | n/a | |
| Views | follow the underlying range + cached state | | `filter_view` caches `begin()` |

```cpp
// ---- the canonical dangling reference ---------------------------------
std::vector<Event> events;
events.push_back(a);
Event* saved = &events.front();
events.push_back(b);          // MAY reallocate
use(*saved);                  // UB
// Fixes: reserve a proven bound · store an index · use a pool with stable slots.
```

```cpp
// ---- erase-while-iterating: correct spellings -------------------------
for (auto it = v.begin(); it != v.end(); )
    it = pred(*it) ? v.erase(it) : std::next(it);        // vector: erase returns next
for (auto it = m.begin(); it != m.end(); )
    if (pred(*it)) it = m.erase(it); else ++it;          // node containers, C++11+
std::erase_if(v, pred);       // C++20 — vector/deque/list/string
std::erase_if(m, pred);       // C++20 — map/set/unordered_*
```

```cpp
// ---- node handles: move an element without copying or reallocating ----
auto node = src.extract(key);          // key_type is MUTABLE through the handle
node.key() = new_key;
auto res = dst.insert(std::move(node));// res.inserted, res.position, res.node
dst.merge(src);                        // splices all transferable nodes
// Handles keep the element's address; allocators must be equal.
```

```cpp
// ---- owning types vs views -------------------------------------------
std::vector<std::byte> owned;
std::span<std::byte const> bytes = owned;   // borrows pointer + size
std::string text;
std::string_view sv = text;                 // borrows pointer + size

std::string_view bad = std::string{"tmp"};  // DANGLES immediately
auto f() { std::vector<int> v{1,2,3}; return std::span{v}; }   // DANGLES on return
// Copying a view copies a handle: no lifetime extension, no snapshot, no COW.
```

```cpp
// ---- borrowed_range ---------------------------------------------------
static_assert( std::ranges::borrowed_range<std::span<int>>);
static_assert( std::ranges::borrowed_range<std::string_view>);
static_assert( std::ranges::borrowed_range<std::ranges::subrange<int*>>);
static_assert( std::ranges::borrowed_range<std::vector<int>&>);   // lvalue ref
static_assert(!std::ranges::borrowed_range<std::vector<int>>);    // rvalue: no

auto r1 = std::ranges::find(std::vector{1,2,3}, 2);
static_assert(std::same_as<decltype(r1), std::ranges::dangling>); // compile-time guard

int data[]{1,2,3};
auto r2 = std::ranges::find(std::span{data}, 2);   // real iterator into `data`

// Opt in for your own type:
template<> inline constexpr bool std::ranges::enable_borrowed_range<MyView> = true;
```

**Traps** — holding `end()` across `push_back` · `string_view` from a temporary `std::string` in a function argument default · `data()` cached across `reserve` · `unordered_map` iterators across an insert that rehashes · assuming `clear()` frees capacity.

---

## 16.4 Exception-safety guarantees

> The four levels are defined in [§15.3](/iprep/books/cpp-cheatsheet/15-error-handling-and-contracts-by-convention/),
> along with the per-container guarantee table and its element-type qualifications. This
> section covers what the *library* adds on top: what actually downgrades a guarantee, and
> which accessors trade a throw for UB.

```cpp
// ---- the strong guarantee costs moves ---------------------------------
struct Record {
    Record(Record const&);            // available
    Record(Record&&);                 // NOT noexcept
};
// vector reallocation uses std::move_if_noexcept:
//   move ctor noexcept        -> move  (fast, strong guarantee still held)
//   move may throw + copyable -> COPY  (slow, preserves strong guarantee)
//   move may throw + move-only-> move  (guarantee drops to basic)
static_assert(std::is_nothrow_move_constructible_v<Order>);  // assert it, always
```

```cpp
// ---- conditional noexcept and the swap trait --------------------------
template<class T>
void exchange_objects(T& a, T& b) noexcept(std::is_nothrow_swappable_v<T>) {
    using std::swap; swap(a, b);
}
static_assert(std::is_nothrow_swappable_v<MyType>);
static_assert(std::is_nothrow_move_assignable_v<MyType>);
// The trait reports an expression property; it does not prove semantic correctness.
```

```cpp
// ---- checked vs unchecked access -------------------------------------
v[i];            // precondition i < size(); violation is UB, NOT an exception
v.at(i);         // throws std::out_of_range
m[key];          // DEFAULT-CONSTRUCTS a missing value; not const-callable
m.at(key);       // throws std::out_of_range; has a const overload
s.substr(pos);   // throws std::out_of_range if pos > size()
sv.substr(pos);  // same throw; but sv[i] out of range is UB
std::get<I>(tup);                 // compile-time checked
std::get<T>(var);                 // throws std::bad_variant_access
opt.value();                      // throws std::bad_optional_access
*opt;                             // UB when empty
exp.value();                      // throws std::bad_expected_access<E>  // C++23
std::any_cast<T>(a);              // throws std::bad_any_cast
dynamic_cast<T&>(r);              // throws std::bad_cast
sp->f();                          // UB when null; no exception
```

| Throwing source | Consequence |
|---|---|
| `operator new` / allocator | `std::bad_alloc`; container operations give strong guarantee |
| `T` copy/move constructor | may downgrade strong → basic (see `move_if_noexcept`) |
| comparator / hash / predicate / projection | algorithm gives basic guarantee at best; container may be left valid-but-unspecified |
| destructor | `noexcept` by default ⇒ `std::terminate` |
| callback under `std::execution::par` | `std::terminate` |
| `T` in a `variant` valuelesss transition | `variant` becomes `valueless_by_exception()` |

**Traps** — `noexcept` on a function that can throw ⇒ `terminate`, not a compile error · `throw` from a destructor during unwinding ⇒ `terminate` · `at()` on `unordered_map` throws, `operator[]` inserts · assuming `insert(first,last)` rolls back (it does not for sequence containers).

---

## 16.5 Thread-safety guarantees

- Concurrent calls on **distinct** objects are safe unless they share user-supplied state (a common allocator, a `memory_resource`, a stateful comparator).
- Concurrent **read-only** (`const`) operations on the same object are safe; the library will not race internally on a `const` member.
- Concurrent **mutation** of the same object requires external synchronization — no standard container is internally synchronized.
- Distinct **elements** of the same container may be written concurrently — except packed/proxy elements sharing a word (`vector<bool>`, `bitset` writes).
- Structural mutation (insert/erase/rehash/reserve) races with *any* concurrent access, including a non-dereferencing iterator advance.

```cpp
std::vector<int> v(2);
// Thread A: v[0] = 1;   Thread B: v[1] = 2;      // OK — distinct objects
// Thread A: v.push_back(3);  Thread B: v[0];      // DATA RACE — structural

std::vector<bool> bits(2);
// Thread A: bits[0] = true;  Thread B: bits[1] = true;  // RACE — one word
std::vector<std::uint8_t> flags(2);                      // fix: addressable bytes
```

```cpp
// ---- "const" is only as safe as everything it touches -----------------
struct CachingCmp {                 // const member call, mutable shared state
    mutable std::size_t calls_{};   // RACE under concurrent const map::find
    bool operator()(int a, int b) const { ++calls_; return a < b; }
};
// Same hazard: stateful allocators, locale facets, streambufs, memoized hashes.
```

| Facility | Concurrency rule |
|---|---|
| `shared_ptr` control block | refcount updates on *distinct* `shared_ptr` objects are atomic |
| same `shared_ptr` object | concurrent non-const access is a race — use `std::atomic<std::shared_ptr<T>>` (C++20) |
| pointee `T` | gets **no** synchronization from shared ownership |
| `std::cout` / `cerr` | writes are data-race-free but interleaving is unspecified; `std::osyncstream` (C++20) fixes order |
| `std::rand`, `strtok`, `localtime` | not thread-safe; use `<random>` engines per thread, `localtime_r` |
| `static` local init | thread-safe (magic statics), guarded once |
| function-scope `std::random_device` | may block on entropy |
| `std::pmr::unsynchronized_pool_resource` | single-threaded only |
| `std::pmr::synchronized_pool_resource` | thread-safe, takes a lock |
| parallel algorithms | element access functions must be race-free; throwing ⇒ `std::terminate` |

```cpp
// ---- execution policies -----------------------------------------------
#include <execution>
std::sort(std::execution::seq,        b, e);   // sequential, as if no policy
std::sort(std::execution::par,        b, e);   // parallel; user ops must be safe
std::sort(std::execution::par_unseq,  b, e);   // parallel + vectorized: NO locks,
                                               // no allocation, no order dependence
std::for_each(std::execution::unseq, b, e, f); // C++20, vectorized single thread
// Parallelism is not automatic latency improvement: thread pool startup,
// false sharing, and NUMA effects can dominate at small n.
```

**Interview line** — "The standard gives baseline data-race freedom: distinct objects and concurrent `const` calls are safe, everything else is my problem."

**Traps** — a `const&` to a container does not stop another thread from resizing it · reference-counting a `shared_ptr` is atomic but reading the pointee is not · `vector<bool>` false sharing at the bit level · assuming `par` implies thread-safe `T`.

---

## 16.6 `swap`, comparison, hashing, and heterogeneous lookup

```cpp
// ---- the two-step swap idiom ------------------------------------------
template<class T>
void generic(T& a, T& b) {
    using std::swap;      // fallback
    swap(a, b);           // ADL finds a better swap if the type provides one
}
// std::swap(a, b);       // WRONG in a template: hides the ADL customization
std::ranges::swap(a, b);  // C++20 CPO: array-aware, ADL-aware, constrained

// Providing swap for your type — a hidden friend is the canonical form:
struct Book {
    friend void swap(Book& a, Book& b) noexcept { /* member-wise */ }
};
```

| Swap flavor | Behavior |
|---|---|
| `std::swap(T&, T&)` | three moves; `noexcept` iff move-construct and move-assign are |
| `std::swap(T(&)[N], T(&)[N])` | element-wise, O(N) |
| container `a.swap(b)` | O(1) pointer swap for most; `array::swap` is O(N) |
| `std::ranges::swap` | CPO: ADL `swap` → array element-wise → move-based fallback |
| after container swap | iterators/references still name the same elements, now owned by the other container; `end()` does not transfer |
| allocator caveat | POCS false + unequal allocators ⇒ **undefined behavior** |

```cpp
// ---- equivalence notions differ ---------------------------------------
// sequence  ==            : element-wise ==, in order, sizes must match
// ordered key equivalence : !comp(a,b) && !comp(b,a)      <- NOT operator==
// unordered key equality  : key_equal(a,b), consistent with hash
// algorithms              : supplied predicate/projection, else ==
std::map<std::string, int, CaseInsensitiveLess> m;
m["ABC"] = 1; m["abc"] = 2;    // ONE element — equivalent under the comparator
```

```cpp
// ---- three-way comparison ---------------------------------------------
struct Px {
    double v;
    auto operator<=>(Px const&) const = default;   // std::partial_ordering (NaN!)
};
struct Id {
    std::uint64_t v;
    auto operator<=>(Id const&) const = default;   // std::strong_ordering
};
std::strong_ordering  so = 1 <=> 2;      // substitutable equality
std::weak_ordering    wo = /* case-insensitive compare */;
std::partial_ordering po = 1.0 <=> nan;  // unordered
(po == std::partial_ordering::unordered);
std::is_lt(so); std::is_gteq(so);        // helper predicates
std::compare_three_way{}(a, b);          // CPO; total order over pointers
std::strong_order(x, y);                 // total order over floats (-0 < +0, NaNs ordered)
// A defaulted <=> also synthesizes <, <=, >, >=; == must be defaulted separately.
```

| Comparison cost | Complexity |
|---|---|
| `std::vector<T>::operator==` | O(1) size check, then O(n) element compares |
| `a <=> b` on containers | O(n) lexicographic |
| `std::string ==` | O(n) `memcmp` after size check |
| `std::lexicographical_compare_three_way` | O(min(n,m)) |
| deep/nested containers | product of the levels — never "one operator" |

```cpp
// ---- std::hash surface -------------------------------------------------
std::hash<int>{}(x);  std::hash<std::string>{}(s);  std::hash<std::string_view>{}(sv);
std::hash<T*>{}(p);   std::hash<std::bitset<N>>{};  std::hash<std::type_index>{};
std::hash<std::shared_ptr<T>>{}; std::hash<std::unique_ptr<T>>{};
std::hash<std::optional<T>>{};   std::hash<std::variant<Ts...>>{};
// NOT provided: pair, tuple, array, vector, span. Write your own:
template<> struct std::hash<Key> {
    std::size_t operator()(Key const& k) const noexcept {
        std::size_t h = std::hash<std::uint64_t>{}(k.id);
        return hash_combine(h, std::hash<std::string_view>{}(k.name));
    }
};
// Guarantee required: a == b  ⇒  hash(a) == hash(b). Collisions are legal.
// std::hash for strings is NOT required to be stable across runs or builds.
```

```cpp
// ---- heterogeneous lookup: ordered ------------------------------------
std::map<std::string, Instrument, std::less<>> instruments;   // <> = transparent
std::string_view key = "EURUSD";
auto it = instruments.find(key);          // no temporary std::string constructed
instruments.count(key); instruments.contains(key);            // C++20
instruments.lower_bound(key); instruments.upper_bound(key); instruments.equal_range(key);
instruments.erase(key);                   // C++23 heterogeneous erase

// ---- heterogeneous lookup: unordered (C++20) --------------------------
std::unordered_map<std::string, Instrument, SymbolHash, std::equal_to<>> byname;
byname.find(std::string_view{"EURUSD"});  // needs BOTH hash and equal transparent
// C++26/impl-specific: heterogeneous insert-or-assign; not portable yet.
```

| Requirement for heterogeneous `Q` against stored `K` | Why |
|---|---|
| cross-type comparison agrees with stored-key equivalence | otherwise lookup misses a present key |
| `equal(k, q) ⇒ hash(k) == hash(q)` | otherwise the wrong bucket is probed |
| both the comparator/hash *and* the equality declare `is_transparent` | overload set is SFINAE-gated on it |
| the argument stays valid for the whole call | `string_view` into a dying buffer |
| it avoids a *temporary*, not the comparison cost | `memcmp` is still O(len) |

**Traps** — `std::less<std::string>` (no `<>`) silently constructs a `std::string` per lookup · transparent hash without transparent equality does not compile the heterogeneous overload · defaulted `<=>` on a class with a `double` yields `partial_ordering`, breaking `std::sort` on NaN input · `std::hash` values are not portable or persistable.

---

## 16.7 Choosing a container from access pattern, mutation, locality, and stability

| Dominant requirement | Start with | Reconsider when |
|---|---|---|
| Contiguous iteration / indexing | `vector` | stable references or cheap front-growth is mandatory |
| Compile-time fixed extent | `array` | logical size varies independently of capacity |
| Non-owning contiguous window | `span` / `mdspan` (C++23) | you need ownership |
| Both-end growth + random access | `deque` | whole-range contiguity or `reserve` is required |
| Stable nodes, O(1) splice | `list` / `forward_list` | locality and per-node allocation dominate |
| Ordered lookup + range queries | `map` / `set` | mutation is rare ⇒ sorted `vector` wins |
| Average-fast exact lookup | `unordered_map` / `unordered_set` | collision tails, rehash spikes, or iteration locality matter |
| Sorted, contiguous, read-mostly | sorted `vector` or `std::flat_map`/`flat_set` (C++23) | frequent middle insertion dominates |
| LIFO / FIFO / repeated max | `stack` / `queue` / `priority_queue` | iteration or arbitrary update is needed |
| Bounded, allocation-free, stable addresses | pre-sized `vector`/`array` + index handles | you must own free-list and exhaustion policy |

**Ten questions before you pick**
- Is the extent fixed, bounded, or unbounded?
- Is iteration or lookup dominant, and at what `n`?
- Must storage be contiguous for cache, SIMD, or a C API?
- Where do inserts/erases happen, and how is the position found?
- Which handles must survive which mutations?
- Is order semantic, presentational, or irrelevant?
- Can all steady-state storage be reserved during setup?
- What is the policy at capacity or on allocation failure?
- Does the key comparison or hash allocate or scan variable-length data?
- Is concurrency external synchronization or a design property?

```cpp
// ---- read-mostly: sorted vector beats std::map ------------------------
struct Entry { std::uint32_t key; Level value; };
std::vector<Entry> table;                             // built once, then sorted
std::ranges::sort(table, {}, &Entry::key);
auto it = std::ranges::lower_bound(table, k, {}, &Entry::key);
bool hit = it != table.end() && it->key == k;
// log2(n) contiguous probes, prefetchable, no node allocation, no pointer chase.

// C++23 equivalent with a map interface over two contiguous vectors:
std::flat_map<std::uint32_t, Level> fm;               // keys and values split
fm.insert(...);                                       // O(n) — read-mostly only
std::flat_set<std::uint32_t> fs;
// flat_map invalidates ALL iterators on any insert/erase; iteration is contiguous.
```

```cpp
// ---- stability externalized: pool + generation handles ----------------
struct Handle { std::uint32_t index{}; std::uint32_t generation{}; };
struct Slot   { Order order; std::uint32_t generation{}; std::uint32_t next_free{}; };

class OrderPool {
    std::vector<Slot> slots_;               // resize()d once, never grows again
    std::uint32_t     free_head_{};
public:
    explicit OrderPool(std::size_t n) : slots_(n) { /* link the free list */ }
    Order* get(Handle h) noexcept {
        Slot& s = slots_[h.index];
        return s.generation == h.generation ? &s.order : nullptr;  // stale-safe
    }
};
// Buys: contiguous storage, no per-element allocation, addresses stable forever.
// Costs: manual exhaustion policy, manual free list, ABA avoided by generation.
```

```cpp
// ---- hot-path ledger: cost every operation ---------------------------
```
```text
lookup             comparisons/hash count + per-key cost + collisions + layout
insert             lookup + allocation + construct + shift/rotate/rehash
erase              lookup + destroy + shift/relink + reclamation
append             capacity check + construct + possible relocate-all
iteration          bytes touched + indirections + predicate/projection cost
swap / move        allocator equality + propagation traits + element ops
view construction  free now — where does the lazy work and the lifetime live?
```

**Deterministic-processing checklist**
- Establish a hard logical capacity, not a hopeful `reserve`.
- Warm first-use library state (first `printf`, first locale, first allocation) before the measured phase.
- Keep error formatting, logging, and node allocation off the critical path.
- Record invalidation assumptions in the API contract and assert them in tests.
- Test collision-heavy inputs, the reallocation boundary, and allocator mismatch.
- Measure the distribution (p50/p99/p99.9/max) and the allocation count, not average throughput.

**Interview line** — "I choose from access pattern, mutation location, stability requirements, and capacity policy; the complexity table is a filter, not the decision."

```text
value_type          stored value; dereference may yield a proxy
iterator/sentinel   position + possibly differently-typed end marker
allocator           storage protocol + identity + propagation traits
comparator          strict weak ordering; the laws are preconditions
hash/equality       equal ⇒ equal hash; collisions are legal
O(1)                counted work, not one instruction
amortized O(1)      sequence average; one call may be O(n)
average O(1)        expected input; worst chain may be O(n)
invalidation        per-operation; end() counts as an iterator
view                lazy, borrowing; prove the underlying lifetime
borrowed_range      iterators outlive the range object, not the owner
exception safety    no-throw / strong / basic, conditional on T and allocator
thread safety       distinct objects and const reads; mutation needs sync
heterogeneous find  is_transparent avoids the temporary key, not the compare
selection           access + mutation + locality + stability + capacity
```

**Traps** — picking `list` for "O(1) insert" when finding the position is O(n) · `unordered_map` on the hot path without `reserve` ⇒ rehash spikes · `flat_map` in a write-heavy loop ⇒ O(n) per insert · choosing a node container purely for stable addresses when a pool + handles is faster and bounded.
