# 17. Sequence containers and adapters

*Part III — Standard library quick reference*

---

**Recall**
- Default to `vector`; pick another container only when a *measured* need for stability, both-end insertion, splice, or fixed extent exists.
- `vector` is the only sequence container with contiguous storage plus dynamic size — `data()` + `size()` is a valid `span`.
- Amortized O(1) `push_back` is a sequence-level guarantee, not a per-call latency bound: one append can allocate and relocate everything.
- Vector reallocation invalidates *every* iterator, pointer, and reference; non-reallocating `push_back` invalidates only the old `end()`.
- `reserve(n)` changes capacity only; `resize(n)` constructs/destroys elements — writing `v[i]` into reserved-but-unconstructed space is UB.
- Vector relocates with move only when the move is `noexcept` (`move_if_noexcept`); a throwing move forces copies.
- `emplace_back` constructs in place and forwards args, but it is not universally faster and it bypasses `explicit` visibility.
- `remove_if` does not erase — it partitions and returns the new logical end; `erase` or C++20 `std::erase_if` does the shrinking.
- `vector<bool>` is a bit-packed specialization whose `operator[]` yields a proxy, not `bool&`.
- `deque` end-insertion keeps *references* valid but invalidates *iterators*; it has no `reserve` and no contiguity.
- `list`/`forward_list` give O(1) splice and stable handles, paying one allocation, two link words, and a cache miss per element.
- List member algorithms (`sort`, `merge`, `unique`, `remove_if`, `reverse`) exist because `std::sort` requires random access.
- Adapters (`stack`, `queue`, `priority_queue`) expose no iterators; `pop()` returns `void` so no throwing copy happens after state changed.
- `priority_queue` with default `std::less` is a **max**-heap; `std::greater<>` makes it a min-heap; there is no decrease-key.
- C++23 adds `std::from_range` construction and `append_range`/`insert_range`/`assign_range`/`prepend_range`.
- Hot-path designs prefer pre-sized flat storage plus indices/generation handles over node containers with per-element allocation.

---

## 17.1 C arrays and `std::array`

```cpp
#include <array>

int raw[4]{};                          // zero-initialized C array
int raw2[]{1, 2, 3};                   // extent deduced: int[3]
int raw3[3] = {1};                     // {1, 0, 0} — rest value-initialized
auto n = std::size(raw);               // 4        (C++17, <iterator>)
auto d = std::ssize(raw);              // 4 as ptrdiff_t (C++20)
int* p = raw;                          // decays to pointer — extent lost

std::array<int, 4> a;                  // elements INDETERMINATE for trivial T
std::array<int, 4> b{};                // value-initialized: all zeros
std::array<int, 4> c{1, 2};            // {1, 2, 0, 0} — aggregate init
auto e = std::array{4, 1, 3, 2};       // CTAD → std::array<int, 4>
auto f = std::to_array("hi");          // std::array<char, 3> (C++20, incl. '\0')
auto g = std::to_array<long>({1, 2});  // std::array<long, 2>
std::array<int, 0> z;                  // legal; begin() == end(); front() is UB

constexpr std::array<int, 5> lv{101, 102, 103, 104, 105};
static_assert(lv.size() == 5 && lv[2] == 103);

constexpr auto sorted = [] {           // constexpr sort via IIFE (C++20)
    auto t = std::array{4, 1, 3, 2};
    std::ranges::sort(t);
    return t;
}();
static_assert(sorted.front() == 1);

auto [w, x, y, zz] = e;                // structured binding over array
auto&& [w2, x2, y2, z2] = e;           // bind by reference
```

| Member | Meaning | Complexity |
|---|---|---|
| `at(i)` | checked; throws `std::out_of_range` | O(1) |
| `operator[](i)` | unchecked; `i < N` is a precondition | O(1) |
| `front()` / `back()` | first / last; UB when `N == 0` | O(1) |
| `data()` | pointer to contiguous storage | O(1) |
| `begin/end/cbegin/cend/rbegin/rend` | iterators | O(1) |
| `empty()` / `size()` / `max_size()` | `size()` is `N`, `constexpr` | O(1) |
| `fill(v)` | assign `v` to all elements | O(N) |
| `swap(other)` | element-wise swap (**not** pointer swap) | O(N) |
| `std::get<I>(a)` | tuple interface, compile-time index | O(1) |
| `a <=> b` | lexicographic three-way (C++20) | O(N) |

**Traps** — `std::array<T,N> a;` leaves trivial elements indeterminate · passing by value copies all `N` elements · `swap` is O(N) and keeps iterators pointing at *positions* · `data()` on a zero-extent array is not a portable sentinel · raw arrays decay, `array` does not.

---

## 17.2 `std::vector`: growth, capacity, reservation, invalidation, emplacement

```cpp
#include <vector>

std::vector<int> v;                          // empty, capacity unspecified (often 0)
std::vector<int> a(5);                       // five value-initialized zeros
std::vector<int> b(5, 7);                    // five copies of 7
std::vector<int> c{5, 7};                    // TWO elements — init-list wins
std::vector<int> d(a.begin(), a.end());      // iterator pair
std::vector<int> e(other);                   // copy
std::vector<int> f(std::move(other));        // move — O(1), steals buffer
auto g = std::vector{1, 2, 3};               // CTAD → vector<int>
std::vector<int> h(std::from_range, rng);    // C++23
auto i = rng | std::ranges::to<std::vector>();  // C++23

v.assign(4, 9);                              // replace contents: {9,9,9,9}
v.assign(first, last);
v.assign({1, 2, 3});
v.assign_range(rng);                         // C++23
v = {1, 2, 3};                               // initializer_list assignment
```

```cpp
// ---- size vs capacity ------------------------------------------------
// [ live ][ live ][ live ][ raw, unconstructed capacity ]
//  ^data()        ^end()==data()+size()      ^data()+capacity()
v.reserve(8);        // capacity >= 8; size unchanged; relocates if it grows
// v[0] = 42;        // UB: size() == 0, that slot holds no object
v.push_back(42);     // constructs the element — now v[0] is live
v.resize(4);         // size 4; new ints value-initialized to 0
v.resize(6, -1);     // new elements copy-initialized from -1
v.shrink_to_fit();   // NON-BINDING request; may allocate + relocate
v.clear();           // size 0, destructors run, capacity RETAINED
```

```cpp
// ---- element access ---------------------------------------------------
v[0];                 // unchecked
v.at(0);              // throws std::out_of_range
v.front(); v.back();  // UB when empty
v.data();             // T* — contiguous, valid for [data(), data()+size())
std::span<int> s{v};  // C++20 view over the whole vector
```

```cpp
// ---- mutation ---------------------------------------------------------
v.push_back(x);                  // copy
v.push_back(std::move(x));       // move
int& r = v.emplace_back(1, 2);   // in-place construct; returns T& since C++17
v.pop_back();                    // O(1); UB when empty
auto it = v.insert(v.begin() + 1, 42);          // single
v.insert(v.end(), 3, 7);                        // n copies
v.insert(v.end(), first, last);                 // range
v.insert(v.end(), {1, 2, 3});                   // init-list
v.emplace(v.begin(), 1, 2);                     // in-place at position
v.insert_range(v.begin() + 2, rng);             // C++23
v.append_range(rng);                            // C++23
v.erase(v.begin());                             // single → iterator to next
v.erase(v.begin(), v.begin() + 2);              // range
v.swap(other);                                  // O(1) pointer swap
```

```cpp
// ---- push_back vs emplace_back ---------------------------------------
struct Order { Order(std::uint64_t id, int qty); };
orders.push_back(Order{id, qty});   // build temporary, then move
orders.emplace_back(id, qty);       // construct directly in storage
// emplace_back: forwards args, returns T&, does NOT avoid reallocation,
// and silently uses explicit constructors that push_back would reject.
```

```cpp
// ---- erase-remove -----------------------------------------------------
v.erase(std::remove_if(v.begin(), v.end(), pred), v.end());  // classic
v.erase(std::remove(v.begin(), v.end(), 7), v.end());
std::erase_if(v, pred);      // C++20, one call, returns count removed
std::erase(v, 7);            // C++20

// ---- O(1) unordered erase (order is destroyed) ------------------------
template<class T>
void erase_unordered(std::vector<T>& v, std::size_t i) {
    assert(i < v.size());
    if (i + 1 != v.size()) v[i] = std::move(v.back());
    v.pop_back();
}
```

| Member | Complexity | Notes |
|---|---|---|
| `operator[]` / `at` / `front` / `back` / `data` | O(1) | `at` throws |
| `push_back` / `emplace_back` | amortized O(1) | O(n) on realloc |
| `pop_back` | O(1) | + destructor |
| `insert(pos, …)` / `emplace(pos, …)` | O(n − pos) | O(n) on realloc |
| `erase(pos)` / `erase(first, last)` | O(n − pos) | never reallocates |
| `reserve(n)` | O(size) when growing | never shrinks capacity |
| `resize(n)` | O(\|Δsize\|) + realloc | constructs/destroys |
| `clear()` | O(size) | capacity retained |
| `shrink_to_fit()` | O(size), may allocate | non-binding |
| `swap` | O(1) | allocator caveats |
| `size` / `capacity` / `empty` / `max_size` | O(1) | |

**Invalidation table — memorize this**

| Operation | Reallocation occurs | No reallocation |
|---|---|---|
| `reserve` / `shrink_to_fit` | all iterators, pointers, references | nothing |
| `push_back` / `emplace_back` | all | only old `end()` |
| `insert` / `emplace` at `pos` | all | at and after `pos`, incl. old `end()` |
| `erase(pos)` | n/a | at and after `pos`, incl. old `end()` |
| `resize` larger | all | existing survive; `end()` moves |
| `resize` smaller | n/a | at and after new end |
| `clear` | n/a | all elements; capacity kept |

```cpp
// ---- classic dangling reference ---------------------------------------
std::vector<Order> orders;
orders.reserve(8);
orders.push_back(first);
Order& saved = orders.front();
for (int i = 0; i != 8; ++i) orders.push_back(make_order(i)); // may reallocate
use(saved);   // UB — saved may dangle
// Fixes: reserve a proven max · store indices · use a pool with stable slots.
```

```cpp
// ---- quadratic reserve anti-pattern -----------------------------------
for (auto const& x : input) {
    output.reserve(output.size() + 1);   // BAD: can force O(n²) relocation
    output.push_back(x);
}
output.reserve(output.size() + input.size());          // GOOD
output.insert(output.end(), input.begin(), input.end());
```

```cpp
// ---- relocation uses move only when noexcept ---------------------------
struct Record {
    Record(Record const&);              // available
    Record(Record&&) noexcept;          // cheap AND non-throwing → used
};
// std::move_if_noexcept picks copy when the move can throw, to keep the
// strong guarantee during reallocation.
```

**Traps** — `{5, 7}` vs `(5, 7)` · `reserve` then `v[i] =` is UB · `shrink_to_fit` may allocate · iterators taken before any `push_back` are suspect · `emplace_back` hides `explicit` · `remove_if` does not shrink.

---

## 17.3 `std::vector<bool>` proxy specialization

```cpp
std::vector<bool> flags(8);
flags[0] = true;
auto proxy = flags[0];        // std::vector<bool>::reference — a PROXY
bool value = flags[0];        // converted copy
// bool& ref = flags[0];      // ill-formed: no bool& exists
// bool* p  = &flags[0];      // ill-formed: not individually addressable
flags.flip();                 // flips all bits
flags[0].flip();              // flips one bit via the proxy
// flags.data();              // does NOT exist
std::vector<bool>::reference::swap(flags[0], flags[1]);
```

- Generic code requiring a true `T&` breaks on this specialization.
- Distinct elements may share one memory word → concurrent writes to *different* bits are a data race.
- Alternatives: `std::vector<std::uint8_t>` (addressable), `std::array<bool, N>`, `std::bitset<N>` (fixed count), or a purpose-built bitmap.

**Interview line** — "`vector<bool>` satisfies a bit-container use case, but it is not a normal instantiation and its `operator[]` does not return `bool&`."

---

## 17.4 `std::deque`: segmented storage and invalidation

```cpp
#include <deque>
std::deque<Event> q;
q.push_back(last);
q.push_front(first);
q.emplace_back(args...);
q.emplace_front(args...);
q.pop_front(); q.pop_back();
Event& e = q[5];                 // O(1) but via an index block, not one array
q.prepend_range(rng);            // C++23
q.append_range(rng);             // C++23
// q.reserve(n);                 // does NOT exist
// q.data();                     // does NOT exist — storage is not contiguous
```

| Property | Guarantee |
|---|---|
| Random access | O(1), one extra indirection vs `vector` |
| Push/pop at either end | amortized O(1) |
| Insert/erase in middle | O(n) |
| Contiguous storage | **no** — cannot `span` the whole deque |
| `reserve` / `capacity` | **absent** |
| End insertion: references/pointers | remain **valid** |
| End insertion: iterators | **invalidated** |
| Middle insert/erase | invalidates all iterators *and* references |
| `clear` | invalidates everything |

```text
vector end insertion: references may dangle (realloc)
deque  end insertion: references stay valid, iterators do not
```

**Traps** — reaching for `deque` as a "ring buffer": it has no fixed capacity, no overwrite/backpressure policy, no contiguous batch, and allocates.

---

## 17.5 `std::list` and `std::forward_list`: splice and locality costs

```cpp
#include <list>
std::list<Order> active;
auto it = active.insert(active.end(), order);   // O(1) given the position
active.erase(it);                               // O(1)
active.emplace_back(args...); active.emplace_front(args...);
active.splice(active.end(), other);             // whole list, O(1), no element moves
active.splice(active.end(), other, it);         // one node, O(1)
active.splice(active.end(), other, f, l);       // range; O(1) if same list, else O(dist)
active.sort(cmp);        // merge sort, stable, O(n log n), no random access needed
active.merge(other, cmp);// both must already be sorted
active.unique(eq);       // removes ADJACENT equivalents only
active.remove(value); active.remove_if(pred);
active.reverse();
// std::ranges::sort(active);  // ill-formed: needs random-access iterators
```

```cpp
#include <forward_list>
std::forward_list<int> xs{1, 2, 3};
auto before = xs.before_begin();
xs.insert_after(before, 0);       // 0,1,2,3
xs.erase_after(before);           // 1,2,3
xs.emplace_after(before, 9);
xs.splice_after(before, other);
xs.push_front(0); xs.pop_front();
// no size(), no back(), no push_back(), no reverse iterators
```

- **Stability** is the only real reason to choose a node container: insert/erase/splice never invalidates handles to *other* elements.
- Cost per element: one allocation, two (or one) link pointers, a likely cache miss, no prefetch, no bulk-algorithm vectorization.
- For small trivially movable elements, `vector` insertion that shifts thousands of bytes often beats `list` insertion that is "O(1)".

---

## 17.6 `std::stack`, `std::queue`, and `std::priority_queue`

```cpp
#include <stack>
std::stack<int> s;                       // over std::deque<int> by default
std::stack<int, std::vector<int>> sv;    // vector-backed
s.push(1); s.emplace(2);
int& t = s.top();
s.pop();                                 // returns void
s.size(); s.empty();
// requires back(), push_back(), pop_back() on the container
```

```cpp
#include <queue>
std::queue<Message> q;                   // over std::deque<Message>
q.push(m); q.emplace(args...);
Message& n = q.front(); Message& b = q.back();
q.pop();                                 // void
// requires front(), back(), push_back(), pop_front()
```

```cpp
std::priority_queue<int> max_heap;                                  // std::less → MAX-heap
std::priority_queue<int, std::vector<int>, std::greater<>> min_heap;
std::priority_queue pq(cmp, std::vector<int>{4, 1, 3});             // O(n) heapify, CTAD
max_heap.push(3); max_heap.emplace(7);
max_heap.top();                          // O(1), largest under std::less
max_heap.pop();                          // O(log n)
// no iteration, no erase, no decrease-key
```

| Operation | Complexity |
|---|---|
| `top()` | O(1) |
| `push` / `emplace` | O(log n) + possible container realloc |
| `pop()` | O(log n) |
| Range/iterator-pair construction | O(n) heapify |

```cpp
// Why pop() returns void: access and removal are separated so no potentially
// throwing copy happens AFTER the container state already changed.
auto value = std::move(q.front());
q.pop();
```

**Traps** — adapters expose no iterators, are not thread-safe, allocate through their default `deque`/`vector`, and give no bounded-capacity or backpressure semantics.

---

## 17.7 C++23 range insertion and construction

```cpp
auto v = std::vector<int>(std::from_range, source);   // tagged range ctor
v.assign_range(replacement);
v.insert_range(v.begin() + 2, middle);
v.append_range(tail);
std::deque<int> d;
d.prepend_range(prefix);
d.append_range(suffix);

auto out = source | std::views::transform(project)
                  | std::ranges::to<std::vector>();   // materialize
```

- Accepts ranges that no same-type iterator pair describes, and lets the container use the range's cardinality/category.
- Repeals nothing: invalidation, allocation, aliasing, and conversion rules are unchanged; a lazy range may be single-pass or alias the destination.
- "Ranges" does not mean "no allocation."

---

## 17.8 Flat storage, stable addresses, and index-based designs

```cpp
// Dense price ladder: pre-sized once, O(1) index, contiguous scan.
struct Level { std::int64_t quantity{}; std::uint32_t order_count{}; };

class DenseLadder {
    std::vector<Level> levels_;   // resize(), not reserve() — elements must exist
    std::int64_t base_tick_{};
public:
    explicit DenseLadder(std::size_t ticks) : levels_(ticks) {}
    Level& at_tick(std::int64_t t) { return levels_[std::size_t(t - base_tick_)]; }
};
```

```cpp
// Stable order storage without per-order allocation: pool + intrusive indices.
struct OrderNode {
    Order order;
    std::uint32_t next{};        // index, not pointer — survives relocation
    std::uint32_t prev{};
    std::uint32_t generation{};  // detects stale handles after slot reuse
};
std::vector<OrderNode> pool;     // resized to fixed capacity before the hot path
```

```cpp
// Fixed-capacity batch with no dynamic allocation at all.
template<class T, std::size_t N>
struct Batch {
    std::array<T, N> storage;
    std::size_t size{};
    bool push(T value) {
        if (size == N) return false;
        storage[size++] = std::move(value);
        return true;
    }
    std::span<T> elements() noexcept { return {storage.data(), size}; }
};
```

```cpp
// pmr: draw early allocations from a stack buffer.
#include <memory_resource>
std::array<std::byte, 4096> buf;
std::pmr::monotonic_buffer_resource arena{buf.data(), buf.size()};
std::pmr::vector<int> values{&arena};
values.reserve(256);
// monotonic never reclaims individually; it falls back upstream when exhausted;
// an allocator does not make a container thread-safe.
```

**Selection guide**

| Need | Choice | Qualification |
|---|---|---|
| Runtime-sized contiguous | `vector` | best locality, O(1) index, amortized append |
| Fixed size, contiguous | `array` | size is part of the type, no allocation |
| Non-owning contiguous view | `span` | not a container: pointer + extent |
| Efficient both ends | `deque` | random access, segmented, no `reserve` |
| Stable handles + O(1) splice | `list` | node allocation and cache misses dominate |
| Singly linked, minimal node | `forward_list` | no `size()`, no `back()` |
| LIFO / FIFO interface | `stack` / `queue` | adapters, no iteration |
| Repeated max/min | `priority_queue` | max-heap by default, no decrease-key |
| Bounded, allocation-free, stable | pre-sized `vector`/`array` + indices | you own free-list and exhaustion policy |
