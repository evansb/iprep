# 18. Ordered and unordered associative containers

*Part III — Standard library quick reference*

---

**Recall**
- Ordered containers (`set`/`map`/`multiset`/`multimap`) keep keys sorted by `Compare` and give O(log n) lookup, bounds, and range queries.
- Unordered containers hash into buckets: average O(1) lookup, worst-case O(n), and no defined iteration order.
- Flat containers (C++23) are sorted-sequence adaptors: O(log n) lookup, O(n) mutation, and the best traversal locality.
- The standard specifies complexity and behaviour, never red-black trees, bucket layout, growth policy, or a hash algorithm.
- Key equivalence in an ordered container is `!comp(a,b) && !comp(b,a)` — not `operator==`.
- `Compare` must be a strict weak ordering; `<=` as a comparator is the classic UB-shaped bug.
- Keys are `const` through iterators; only `extract`'s node handle lets you mutate a key legally.
- `map::operator[]` is a *mutation*: on a miss it inserts a value-initialized mapped value and may allocate.
- `try_emplace` leaves an existing mapped value alone; `insert_or_assign` overwrites it; both still evaluate their arguments.
- Heterogeneous lookup needs a transparent comparator (`is_transparent`) — for unordered, transparent hash **and** equality (C++20).
- `if eq(a,b) then h(a)==h(b)` is a hard requirement; the converse (collisions) is allowed and expected.
- Ordered insert invalidates nothing; ordered erase invalidates only handles to the erased element.
- Unordered rehash invalidates **all iterators** but keeps references and pointers to elements valid.
- `reserve(n)` on an unordered container prepares buckets for `n` elements under the current `max_load_factor` — set the load factor first.
- `merge` moves nodes without copying elements; keys the destination rejects stay in the source.
- Flat containers give no node handles, no `extract`/`merge`, and no reference stability under mutation.
- Dense bounded integer keys usually beat every associative container: index a `vector` directly.
- Average O(1) is not a latency bound — rehash, collisions, and allocation own the tail.

---

## 18.1 `std::set`, `multiset`, `map`, and `multimap`

```cpp
#include <map>
#include <set>

// ---- construction -----------------------------------------------------
std::set<int> s;                                   // default Compare = std::less<int>
std::set<int> s2{3, 1, 2, 1};                      // {1,2,3} — duplicate dropped
std::set<int, std::greater<>> desc{1, 2, 3};       // descending, transparent
std::set<int> s3(first, last);                     // iterator pair, O(n log n)
std::set<int> s4(first, last, cmp, alloc);
std::set<int> s5(std::from_range, rng);            // C++23
auto s6 = rng | std::ranges::to<std::set<int>>();  // C++23
auto s7 = std::set{1, 2, 3};                       // CTAD → set<int>

std::multiset<int> ms{1, 1, 2};                    // keeps both 1s, adjacent
std::map<std::string, int> m{{"a", 1}, {"b", 2}};
std::map<std::string, int> m2(m.begin(), m.end());
std::multimap<int, std::uint64_t> mm{{101, 7}, {101, 9}};

// ---- nested types -----------------------------------------------------
using K  = std::map<std::uint64_t, int>::key_type;     // std::uint64_t
using T  = std::map<std::uint64_t, int>::mapped_type;  // int
using V  = std::map<std::uint64_t, int>::value_type;   // pair<const uint64_t, int>
using C  = std::map<std::uint64_t, int>::key_compare;  // std::less<uint64_t>
using VC = std::map<std::uint64_t, int>::value_compare;// compares by .first
using NH = std::map<std::uint64_t, int>::node_type;    // node handle (C++17)
// set<K>::value_type == K; set iterators are always const-access
```

```cpp
// ---- map insertion: every spelling -------------------------------------
std::map<std::string, int> q;

auto [it1, ok1] = q.insert({"a", 1});                 // pair<iterator,bool>
auto [it2, ok2] = q.insert(std::pair{"a", 2});        // ok2 == false, no overwrite
q.insert({{"b", 2}, {"c", 3}});                       // initializer_list
q.insert(first, last);                                // range
q.insert(q.begin(), {"d", 4});                        // with hint → iterator
q.insert_range(rng);                                  // C++23

auto [it3, ok3] = q.emplace("e", 5);                  // constructs value_type
q.emplace(std::piecewise_construct,                   // multi-arg both sides
          std::forward_as_tuple("f"),
          std::forward_as_tuple(6));
q.emplace_hint(q.end(), "g", 7);                      // returns iterator only

auto [it4, ok4] = q.try_emplace("h", 8);              // C++17: no-op if present
q.try_emplace(q.begin(), "i", 9);                     // hinted overload
auto [it5, ok5] = q.insert_or_assign("a", 42);        // C++17: overwrite on hit
q.insert_or_assign(q.begin(), "a", 43);               // hinted

q["z"] = 1;                                           // INSERTS on miss
q.at("z") = 2;                                        // throws if missing
// q.at("nope");                                      // std::out_of_range
```

```cpp
// ---- lookup ------------------------------------------------------------
auto f  = q.find("a");            // iterator or end()
bool c  = q.contains("a");        // C++20
auto n  = q.count("a");           // 0 or 1 for unique; #matches for multi
auto lo = q.lower_bound("b");     // first key NOT LESS than "b"
auto hi = q.upper_bound("b");     // first key GREATER than "b"
auto [b, e] = q.equal_range("b"); // [lower_bound, upper_bound)

// ---- ordered range scan (the reason to pick a tree) --------------------
std::map<int, int> depth{{100, 4}, {102, 7}, {105, 2}};
for (auto it = depth.lower_bound(101); it != depth.upper_bound(105); ++it)
    consume(it->first, it->second);

// ---- multimap group iteration -----------------------------------------
auto [gb, ge] = mm.equal_range(101);
for (; gb != ge; ++gb) consume(gb->second);   // insertion order preserved
```

```cpp
// ---- erasure -----------------------------------------------------------
q.erase(it1);                          // iterator → iterator to next, amortized O(1)
q.erase(first, last);                  // range
auto removed = q.erase("a");           // by key → count erased
std::erase_if(q, [](auto const& kv) { return kv.second == 0; });  // C++20
q.clear();

// ---- mutation through iterators ---------------------------------------
auto it = depth.find(102);
it->second += 10;      // OK: mapped value is mutable
// it->first = 7;      // ill-formed: key_type is const
// *set_it = 9;        // ill-formed: set iterators are const_iterator
```

| Member | `set`/`multiset` | `map`/`multimap` | Complexity | Notes |
|---|---|---|---|---|
| `insert(v)` | yes | yes | O(log n) | unique: `pair<it,bool>`; multi: `iterator` |
| `insert(hint, v)` | yes | yes | amortized O(1) with correct hint | else O(log n) |
| `insert(first,last)` / `insert(il)` | yes | yes | O(k log(n+k)) | O(k) if sorted-appended |
| `insert_range(rng)` | yes | yes | O(k log(n+k)) | C++23 |
| `emplace(args…)` | yes | yes | O(log n) | may construct then discard on duplicate |
| `emplace_hint(hint,args…)` | yes | yes | amortized O(1) | returns `iterator` only |
| `try_emplace(k,args…)` | — | unique map only | O(log n) | mapped value not constructed on hit |
| `insert_or_assign(k,v)` | — | unique map only | O(log n) | assigns on hit; iterators stay valid |
| `operator[](k)` | — | unique map only | O(log n) | **inserts** value-initialized on miss |
| `at(k)` | — | map/multimap | O(log n) | throws `std::out_of_range` |
| `find(k)` / `contains(k)` | yes | yes | O(log n) | `contains` C++20 |
| `count(k)` | yes | yes | O(log n + k) | 0/1 for unique |
| `lower_bound` / `upper_bound` | yes | yes | O(log n) | comparator ordering, not `==` |
| `equal_range(k)` | yes | yes | O(log n) | pair of bounds |
| `erase(it)` / `erase(first,last)` | yes | yes | amortized O(1) / O(dist) | returns next iterator |
| `erase(k)` | yes | yes | O(log n + k) | returns count erased |
| `extract(k)` / `extract(it)` | yes | yes | O(log n) / amortized O(1) | C++17 node handle |
| `insert(node_type&&)` | yes | yes | O(log n) | amortized O(1) with hint |
| `merge(other)` | yes | yes | O(k log(n+k)) | node transfer, no element copy |
| `key_comp()` / `value_comp()` | yes | yes | O(1) | container owns the comparator value |
| `begin/end/rbegin/rend` | yes | yes | O(1) | bidirectional, sorted order |
| `size` / `empty` / `max_size` | yes | yes | O(1) | |
| `swap(other)` | yes | yes | O(1) | comparators swap too |
| `clear()` | yes | yes | O(n) | |
| `std::erase_if(c,pred)` | yes | yes | O(n) | C++20, returns count |

**Interview line** — "`operator[]` is never a read: on a miss it default-constructs a mapped value, inserts it, and returns a reference — use `find`/`contains`/`at` when absence must not mutate."

**Traps** — `try_emplace(k, expensive())` still calls `expensive()`; the saving is that it does not construct *inside* the container · a wrong hint costs a full O(log n) · `count` on a multimap is O(log n + matches), not O(1) · `set` iterators are const even in non-const containers · `map::at` throws, `operator[]` never does.

---

## 18.2 Ordering, strict weak ordering, and comparator correctness

```text
Strict weak ordering, comp(a,b):
  irreflexive       comp(x, x) == false
  asymmetric        comp(a, b) implies !comp(b, a)
  transitive        comp(a,b) && comp(b,c) implies comp(a,c)
  equivalence       eq(a,b) := !comp(a,b) && !comp(b,a)
  eq transitive     eq(a,b) && eq(b,c) implies eq(a,c)
A unique ordered container holds ONE element per equivalence class.
```

```cpp
// ---- broken comparators -------------------------------------------------
struct BadLE { bool operator()(int a, int b) const { return a <= b; } };  // !irreflexive
struct BadPartial {                                                       // NaN → not SWO
    bool operator()(double a, double b) const { return a < b; }           // NaN breaks all axioms
};
struct BadUnstable {                       // depends on mutable outside state
    int const* pivot;
    bool operator()(int a, int b) const { return (a ^ *pivot) < (b ^ *pivot); }
};
// Consequence of any of these: UB-shaped behaviour — lost elements, find() misses,
// infinite loops inside algorithms. Not diagnosed.
```

```cpp
// ---- correct comparators ------------------------------------------------
struct ByPriceThenTime {                             // lexicographic, strict
    bool operator()(Order const& a, Order const& b) const noexcept {
        return std::tie(a.price, a.timestamp) < std::tie(b.price, b.timestamp);
    }
};

struct DescendingPrice {                             // reversed but still strict
    bool operator()(std::int64_t a, std::int64_t b) const noexcept { return a > b; }
};
std::set<std::int64_t, std::greater<>> bids;         // same, via std library functor

// C++20: derive the comparator from <=>
struct Tick {
    std::int64_t px; std::uint64_t ts;
    auto operator<=>(Tick const&) const = default;   // strong_ordering → SWO for free
    bool operator==(Tick const&) const = default;
};
std::set<Tick> ticks;                                // std::less<Tick> uses operator<

// Floating point with NaN in the domain: canonicalize or use a total order
std::set<double, decltype([](double a, double b) noexcept {
    return std::strong_order(a, b) < 0;              // C++20 <compare>: total order
})> prices;
```

```cpp
// ---- stateful comparator: legal, but its policy is frozen ----------------
struct ByMask {
    unsigned mask;
    bool operator()(unsigned a, unsigned b) const noexcept {
        return (a & mask) < (b & mask);
    }
};
std::set<unsigned, ByMask> buckets{ByMask{0xFF00u}};
auto policy = buckets.key_comp();     // container owns a COPY of the comparator
// Mutating the state the ordering depends on does not re-sort the tree:
// rebuild the container under the new policy instead.

// value_comp() on a map compares value_type by key only:
std::map<int, int> mp;
auto vc = mp.value_comp();
bool less = vc(std::pair<const int,int>{1,99}, std::pair<const int,int>{2,0});  // true
```

| Requirement | Checked by the compiler? | Failure mode |
|---|---|---|
| Irreflexivity | no | duplicates admitted / elements unreachable |
| Asymmetry | no | inconsistent `equal_range`, lost inserts |
| Transitivity | no | tree invariant broken, `find` misses present keys |
| Transitivity of equivalence | no | equivalence classes fragment |
| Total over the key domain (NaN!) | no | UB in `sort`/`set` internals |
| `Compare` copy-constructible & callable as `const` | yes | compile error |

**Traps** — `<=`/`>=` as comparator · comparing floats with `<` when NaN can occur · comparator that reads global/mutable state · comparator that throws (leaves the container in a valid but unspecified-content state; strong guarantee only for single-element insert) · assuming `!(a<b) && !(b<a)` implies `a == b`.

---

## 18.3 Node handles, `merge`, and heterogeneous lookup

```cpp
// ---- node handles (C++17): move an element without copying it -----------
std::map<std::string, int, std::less<>> a{{"old", 7}};
std::map<std::string, int, std::less<>> b;

auto node = a.extract("old");        // by key: O(log n), returns empty handle if absent
auto node2 = a.extract(a.begin());   // by iterator: amortized O(1), always non-empty
if (!node.empty()) {                 // operator bool() is the same test
    node.key()    = "new";           // LEGAL key mutation — only while detached
    node.mapped() = 8;
    auto ator = node.get_allocator();
    auto res = b.insert(std::move(node));       // insert_return_type
    if (!res.inserted) {
        auto recovered = std::move(res.node);   // rejected node still owns the element
        auto clash     = res.position;          // iterator to the blocking element
    }
}
// set node: node.value() instead of key()/mapped()
std::set<std::string> ss{"x"};
auto sn = ss.extract("x");
sn.value() = "y";
ss.insert(std::move(sn));
// A non-empty handle destroyed without reinsertion DESTROYS the element.
```

```cpp
// ---- merge: bulk node transfer, no element copy/move --------------------
std::map<std::string, int, std::less<>> dst{{"k", 1}};
std::map<std::string, int, std::less<>> src{{"k", 2}, {"n", 3}};
dst.merge(src);          // "n" moves; "k" is rejected and REMAINS in src
// src.size() == 1

std::multimap<std::string, int, std::less<>> mdst;
mdst.merge(src);         // ordered unique ↔ multi with the SAME key_compare is allowed
// Preconditions: same key_type/mapped_type/allocator-compatible; comparators may
// differ in type only where the overload permits (unique↔multi of the same family).
```

| Node-handle API | Meaning |
|---|---|
| `extract(k)` / `extract(pos)` | detach node; O(log n) / amortized O(1) |
| `empty()` / `explicit operator bool()` | handle owns a node? |
| `key()` (map) | mutable reference to the key while detached |
| `mapped()` (map) | mutable reference to the mapped value |
| `value()` (set) | mutable reference to the element |
| `get_allocator()` | the node's allocator |
| `insert(node_type&&)` | unique: `insert_return_type{position, inserted, node}`; multi: `iterator` |
| `merge(source)` | transfer all acceptable nodes; O(k log(n+k)) |

- No memory is allocated or freed by `extract` + `insert`: allocation happened once, at original insertion.
- References/pointers/iterators to a transferred element stay valid; an iterator into the source now iterates the destination.
- Unordered `merge` may rehash the destination — that invalidates *all* destination iterators.

```cpp
// ---- heterogeneous lookup: ordered (C++14) ------------------------------
using Table = std::map<std::string, int, std::less<>>;   // std::less<> is TRANSPARENT
Table symbols{{"AAPL", 1}, {"MSFT", 2}};
std::string_view key = "MSFT";
auto it = symbols.find(key);                 // NO temporary std::string constructed
symbols.contains(key); symbols.count(key);
symbols.lower_bound(key); symbols.equal_range(key);
symbols.erase(key);                          // C++23 heterogeneous erase overload
// std::map<std::string,int> plain;  plain.find(key);   // would construct a std::string

struct SymbolLess {
    using is_transparent = void;             // the opt-in marker; type is irrelevant
    bool operator()(std::string_view a, std::string_view b) const noexcept { return a < b; }
};
std::set<std::string, SymbolLess> names;
names.contains(std::string_view{"IBM"});
```

```cpp
// ---- heterogeneous lookup: unordered (C++20) ---------------------------
struct StringHash {
    using is_transparent = void;
    std::size_t operator()(std::string_view s) const noexcept {
        return std::hash<std::string_view>{}(s);       // MUST agree with string's use
    }
    std::size_t operator()(char const* s) const noexcept { return (*this)(std::string_view{s}); }
    std::size_t operator()(std::string const& s) const noexcept { return (*this)(std::string_view{s}); }
};
struct StringEq {
    using is_transparent = void;
    bool operator()(std::string_view a, std::string_view b) const noexcept { return a == b; }
};
std::unordered_map<std::string, int, StringHash, StringEq> ids;
auto u = ids.find(std::string_view{"ABC"});    // requires BOTH to be transparent
ids.contains("ABC"); ids.count("ABC"); ids.equal_range("ABC");
// ids.erase(sv);   // heterogeneous erase for unordered: C++23
```

| Family | Enabled by | Since | Applies to |
|---|---|---|---|
| Ordered | `Compare::is_transparent` | C++14 | `find`, `count`, `contains`, `lower/upper_bound`, `equal_range` |
| Ordered erase / extract | `Compare::is_transparent` | C++23 | `erase(K&&)`, `extract(K&&)` |
| Unordered | `Hash::is_transparent` **and** `KeyEqual::is_transparent` | C++20 | `find`, `count`, `contains`, `equal_range` |
| Unordered erase / extract | both transparent | C++23 | `erase(K&&)`, `extract(K&&)` |

**Traps** — `std::less<std::string>` is *not* transparent (`std::less<>` is) · transparent hash must produce the same value for every representation `KeyEqual` calls equal · heterogeneous lookup removes a temporary allocation, it does not fix a dangling `string_view` · `operator[]`/`insert`/`try_emplace` are *not* heterogeneous — they need a real `key_type` · a moved-from-and-dropped node handle silently destroys the element.

---

## 18.4 `std::unordered_*`: buckets, load factor, `reserve`, and rehash

```cpp
#include <unordered_map>
#include <unordered_set>

std::unordered_map<std::uint64_t, int> by_id;
std::unordered_map<std::uint64_t, int> by_id2(1024);                  // bucket count hint
std::unordered_map<std::uint64_t, int> by_id3(1024, hash, eq, alloc);
std::unordered_set<int> us{1, 2, 3};
std::unordered_multimap<int, int> umm{{1, 1}, {1, 2}};
std::unordered_map<int, int> u4(std::from_range, rng);                // C++23

// ---- sizing policy: order matters --------------------------------------
by_id.max_load_factor(0.7f);      // set the POLICY first
by_id.reserve(100'000);           // then size for the element count under that policy
by_id.rehash(262'144);            // request >= n buckets (and enough for max LF)
// reserve(n) is equivalent to rehash(ceil(n / max_load_factor()))
```

```text
load_factor()  = size() / bucket_count()
max_load_factor() default 1.0; exceeding it triggers a rehash on insert
rehash(n)      >= n buckets, and enough that load_factor() <= max_load_factor()
reserve(n)     bucket_count sized so n elements fit without rehashing
Growth sequence, bucket count, and the hash function are IMPLEMENTATION CHOICES.
```

```cpp
// ---- bucket interface (diagnostics only) --------------------------------
auto nb  = by_id.bucket_count();
auto mb  = by_id.max_bucket_count();
auto idx = by_id.bucket(42);                 // bucket holding key 42, if present
auto sz  = by_id.bucket_size(idx);
for (auto it = by_id.begin(idx); it != by_id.end(idx); ++it) inspect(*it);  // local_iterator
auto lf  = by_id.load_factor();

// collision histogram — the honest way to judge a hash
std::vector<std::size_t> hist(by_id.bucket_count());
for (std::size_t i = 0; i < by_id.bucket_count(); ++i) hist[i] = by_id.bucket_size(i);
```

```cpp
// ---- API mirrors the ordered families, minus ordering -------------------
auto [it, ok] = by_id.emplace(7, 1);
by_id.try_emplace(8, 2);                 // C++17
by_id.insert_or_assign(8, 3);            // C++17
by_id[9] = 4;                            // inserts on miss, like std::map
by_id.at(9);                             // throws std::out_of_range
by_id.find(9); by_id.contains(9); by_id.count(9);
auto [b, e] = by_id.equal_range(9);      // useful for unordered_multimap
by_id.erase(9); by_id.erase(it); by_id.erase(first, last);
std::erase_if(by_id, [](auto const& kv) { return kv.second == 0; });  // C++20
by_id.extract(9); by_id.merge(other);    // node handles work here too
// NO lower_bound / upper_bound / rbegin — there is no order.
```

| Member | Average | Worst case | Notes |
|---|---|---|---|
| `find` / `contains` / `count` | O(1) | O(n) | `contains` C++20 |
| `equal_range(k)` | O(1) | O(n) | contiguous within a bucket |
| `operator[]` / `at` | O(1) | O(n) | `[]` inserts; `at` throws |
| `insert` / `emplace` / `try_emplace` / `insert_or_assign` | O(1) | O(n) + rehash O(n) | rehash when LF would be exceeded |
| `emplace_hint` | O(1) | O(n) | hint is ignorable, usually useless |
| `insert(first,last)` / `insert_range` | O(k) | O(k·n) | C++23 `insert_range` |
| `erase(it)` | O(1) | O(1) | returns next iterator |
| `erase(k)` | O(1) | O(n) | returns count erased |
| `extract` / `insert(node)` / `merge` | O(1) | O(n) | merge may rehash destination |
| `rehash(n)` / `reserve(n)` | O(n) | O(n²) | invalidates all iterators |
| `bucket_count` / `bucket_size` / `bucket` / `load_factor` | O(1) | O(1) | `bucket_size` is O(bucket size) |
| `begin(b)` / `end(b)` (local iterators) | O(1) | O(1) | forward iterators only |
| `max_load_factor()` / `max_load_factor(z)` | O(1) | O(1) | set before `reserve` |
| `hash_function()` / `key_eq()` | O(1) | O(1) | returns copies of the policies |
| `clear` / `swap` / `size` / `empty` | O(n) / O(1) | | `swap` does not rehash |

- All standard `unordered_*` are node-based with bucket lists: element addresses are stable across rehash.
- Iteration is a single pass over all elements (implementations chain the nodes), so `begin()..end()` is O(n), not O(bucket_count).
- Iteration order is unspecified and may change on rehash, across runs, and between implementations.

**Interview line** — "`reserve` prepares buckets for a given element count under the current `max_load_factor`; it does not make insertion worst-case O(1) and it does rehash, invalidating every iterator."

**Traps** — calling `reserve` before `max_load_factor` (the reserve is then sized under the old policy) · treating `reserve` as a hard capacity — exceeding it is legal and rehashes · depending on iteration order for serialization or hashing of the container · `bucket()` on an absent key is only meaningful as "where it would go" · local iterators are forward-only.

---

## 18.5 Hash/equality consistency and collision behaviour

```text
REQUIRED:  eq(a, b) == true   ⇒   h(a) == h(b)
ALLOWED:   h(a) == h(b)       with   eq(a, b) == false     (a collision)
Both h and eq must be stable for as long as keys are stored.
```

```cpp
// ---- named hasher (preferred: explicit, multiple policies possible) -----
struct OrderId {
    std::uint64_t value{};
    friend bool operator==(OrderId, OrderId) = default;
};
struct OrderIdHash {
    using is_transparent = void;                                    // optional
    std::size_t operator()(OrderId id) const noexcept {
        return std::hash<std::uint64_t>{}(id.value);
    }
};
std::unordered_map<OrderId, int, OrderIdHash> orders;

// ---- std::hash specialization (must live in namespace std) --------------
template<>
struct std::hash<OrderId> {
    std::size_t operator()(OrderId id) const noexcept {
        return std::hash<std::uint64_t>{}(id.value);
    }
};
std::unordered_set<OrderId> ids;      // now works with the default hasher
```

```cpp
// ---- composite key: hash and equality must agree on the SAME fields -----
struct Key {
    std::uint32_t venue{};
    std::uint64_t id{};
    friend bool operator==(Key, Key) = default;   // C++20: memberwise
};
struct KeyHash {
    std::size_t operator()(Key k) const noexcept {
        std::size_t h = std::hash<std::uint32_t>{}(k.venue);
        hash_combine(h, std::hash<std::uint64_t>{}(k.id));
        return h;
    }
    static void hash_combine(std::size_t& h, std::size_t v) noexcept {
        h ^= v + 0x9e3779b97f4a7c15ULL + (h << 6) + (h >> 2);   // boost-style, NOT a guarantee
    }
};
std::unordered_map<Key, int, KeyHash> book;

// ---- trivially-hashable key: mix the bits, don't return them raw --------
struct IdentityHash {                       // legal, but pathological on a
    std::size_t operator()(std::uint64_t k) const noexcept { return k; }  // power-of-two
};                                          // bucket count with strided keys
struct SplitMix64 {                         // cheap avalanche
    std::size_t operator()(std::uint64_t x) const noexcept {
        x += 0x9e3779b97f4a7c15ULL;
        x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ULL;
        x = (x ^ (x >> 27)) * 0x94d049bb133111ebULL;
        return static_cast<std::size_t>(x ^ (x >> 31));
    }
};
```

```cpp
// ---- classic inconsistency bug ------------------------------------------
struct CiEq {                                 // case-INsensitive equality
    bool operator()(std::string_view a, std::string_view b) const {
        return std::ranges::equal(a, b, [](char x, char y) {
            return std::tolower((unsigned char)x) == std::tolower((unsigned char)y);
        });
    }
};
// std::unordered_set<std::string, std::hash<std::string>, CiEq> bad;   // BROKEN:
// "abc" and "ABC" compare equal but hash differently → duplicates, missed finds.
struct CiHash {                               // the fix: hash the canonical form
    std::size_t operator()(std::string_view s) const noexcept {
        std::size_t h = 1469598103934665603ULL;             // FNV-1a over lowered bytes
        for (unsigned char c : s) { h ^= std::tolower(c); h *= 1099511628211ULL; }
        return h;
    }
};
std::unordered_set<std::string, CiHash, CiEq> ok;
```

| Requirement on `Hash` / `KeyEqual` | Consequence of violation |
|---|---|
| `eq(a,b) ⇒ h(a)==h(b)` | duplicates stored, `find` misses live keys |
| `eq` is an equivalence relation (reflexive/symmetric/transitive) | undefined container behaviour |
| Both are deterministic for stored keys | elements stranded in the wrong bucket |
| Neither depends on mutable external state | same |
| Both copy-constructible, callable as `const`, ideally `noexcept` | compile error / lost `noexcept` propagation |
| Good bit distribution over the real key set | O(n) lookups; rehash storms |

- `std::hash` is required only to be deterministic within one execution; it is not stable across runs, builds, or standard libraries.
- `std::hash<std::string>` may be seeded per-process — never persist or shard on it.
- A hash quality bug shows as a *tail-latency* problem, not a correctness one: measure `bucket_size` maxima, not just throughput.
- Adversarial input (attacker-chosen keys) turns average O(1) into O(n) — use a keyed/seeded hash when input is untrusted.

**Traps** — specializing `std::hash` for a type you do not own · hashing only some of the fields `operator==` compares · returning the key itself as the hash · a hasher that throws (insert then offers only the basic guarantee) · assuming `size_t` truncation on 32-bit preserves your mixing.

---

## 18.6 Iterator/reference invalidation

**Ordered (`set`, `multiset`, `map`, `multimap`) — node containers**

| Operation | Iterators | References / pointers |
|---|---|---|
| `find` / `count` / bounds / traversal | valid | valid |
| `insert` / `emplace` / `try_emplace` / `operator[]` | **all valid** | **all valid** |
| `insert_or_assign` on an existing key | valid | valid (mapped value is assigned in place) |
| `erase(k)` / `erase(it)` | only the erased element's | only the erased element's |
| `extract` | extracted element's iterator invalid | references/pointers to it stay valid via the handle |
| `merge` (as destination or source) | transferred elements' iterators now belong to the destination | valid |
| `swap` | valid, but now refer into the other container; end iterators unspecified | valid |
| `clear` / destruction | all invalid | all invalid |

**Unordered (`unordered_*`) — bucket + node containers**

| Operation | Iterators | References / pointers |
|---|---|---|
| `find` / `count` / `contains` / traversal | valid | valid |
| Insert **without** rehash | valid | valid |
| Insert **causing** rehash | **all invalid** | **valid** |
| `rehash` / `reserve` that changes bucket count | **all invalid** | **valid** |
| `max_load_factor(z)` alone | valid (no rehash by itself) | valid |
| `erase(k)` / `erase(it)` | only the erased element's | only the erased element's |
| `extract` / `merge` | destination may rehash → all destination iterators invalid | valid |
| `swap` | valid, associated with the other container | valid |
| `clear` | all invalid | all invalid |

**Flat (`flat_set`, `flat_map`, …) — sequence adaptors**

| Operation | Iterators | References / pointers |
|---|---|---|
| Lookup / traversal | valid | valid |
| Any insert or erase | **all invalid** (treat as such) | **all invalid** |
| `reserve` | all invalid if it reallocates | all invalid if it reallocates |
| `swap` / `extract` (steals the containers) | all invalid | all invalid |

```cpp
// ---- the rehash trap ----------------------------------------------------
auto it = by_id.find(id);
by_id.emplace(other_id, 1);   // MAY rehash
// use(it);                   // possibly dangling iterator
int& v = by_id.at(id);        // reference survives a rehash…
by_id.emplace(third_id, 2);
v = 5;                        // …still valid: the NODE did not move
by_id.erase(id);
// v = 6;                     // NOW UB: the element was destroyed

// ---- safe erase-while-iterating (all associative containers) ------------
for (auto i = m.begin(); i != m.end(); ) {
    if (drop(*i)) i = m.erase(i);   // erase returns the next iterator
    else          ++i;
}
std::erase_if(m, drop);             // C++20 one-liner, same semantics

// ---- ordered insert is free of invalidation ----------------------------
auto keep = tree.find(k);
tree.emplace(k2, v2);          // guaranteed not to disturb `keep`
use(keep);                     // OK
```

- Node stability is a *memory* guarantee, not a *logical* one: an iterator can survive while the order it points to has been cancelled by application protocol.
- Never cache an unordered iterator across a mutation unless a proven `reserve` bound makes rehash impossible.
- Caching a `T*`/`T&` into an unordered map's mapped value is the rehash-safe pattern; caching the iterator is not.

**Traps** — `reserve` on an unordered container silently invalidates every iterator · flat containers invalidate on *any* mutation, unlike every other associative container · `swap` leaves old `end()` iterators unspecified · a reference obtained via `operator[]` dies with `erase`, not with a rehash.

---

## 18.7 C++23 `std::flat_set`, `flat_map`, and multi variants

```cpp
#include <flat_map>
#include <flat_set>
// Adaptors, not containers: sorted sequence storage + associative interface.
// flat_map keeps TWO parallel containers: keys and values.

std::flat_map<int, int> levels{{101, 4}, {103, 8}};        // sorts + dedups on construction
std::flat_set<int> fs{3, 1, 2, 1};                          // {1,2,3}
std::flat_multimap<int, int> fmm{{1, 1}, {1, 2}};
std::flat_multiset<int> fms{1, 1, 2};

// underlying container types are template parameters
std::flat_set<int, std::less<int>, std::vector<int>>            fv;
std::flat_set<int, std::less<int>, std::deque<int>>             fd;   // stable-ish addresses? no
std::flat_map<int, int, std::less<int>,
              std::vector<int>, std::vector<int>>               fm;
using KC = std::flat_map<int,int>::key_container_type;         // vector<int> by default
using MC = std::flat_map<int,int>::mapped_container_type;

// ---- sorted bulk construction: the tag is a PROMISE, not a request ------
std::vector<int> keys{1, 2, 3};                 // must already be sorted & unique
std::vector<int> vals{10, 20, 30};
std::flat_map<int, int> quick(std::sorted_unique, std::move(keys), std::move(vals));
std::flat_multiset<int> qm(std::sorted_equivalent, {1, 1, 2});
// Violating the precondition is UB — nothing sorts or checks for you.

// ---- steal / install the underlying storage -----------------------------
auto [k, v] = std::move(quick).extract();       // returns containers; leaves it empty
quick.replace(std::move(k), std::move(v));      // reinstall (same preconditions)
```

```cpp
// ---- interface: same names as std::map, different costs -----------------
levels.emplace(102, 5);                 // O(n): binary search + shift, may reallocate
levels.insert({104, 6});
levels.insert(std::sorted_unique, first, last);  // bulk, cheaper merge path
levels.try_emplace(105, 7);
levels.insert_or_assign(103, 9);
levels[106] = 1;                        // inserts on miss, like std::map
levels.at(103);
auto it = levels.lower_bound(102);      // O(log n) comparisons, contiguous probes
auto [b, e] = levels.equal_range(103);
levels.erase(101);                      // O(n) shift
levels.reserve(1024);                   // forwards to the underlying containers
std::erase_if(levels, [](auto kv) { return kv.second == 0; });

// ---- flat_map iteration yields a PAIR OF REFERENCES, not pair<const K,T>&
for (auto&& [key, value] : levels) value += 1;    // key is const&, value is T&
// auto* p = &*levels.begin();     // NOT a pair<const int,int>* — do not assume
auto const& kc = levels.keys();     // const ref to the key container (contiguous!)
auto const& mc = levels.values();   // const ref to the mapped container

#ifdef __cpp_lib_flat_map            // library support can lag the language mode
    // guard conditional use; likewise __cpp_lib_flat_set
#endif
```

| Member | flat_set / flat_multiset | flat_map / flat_multimap | Complexity |
|---|---|---|---|
| `find` / `contains` / `count` | yes | yes | O(log n) comparisons |
| `lower_bound` / `upper_bound` / `equal_range` | yes | yes | O(log n) |
| `at(k)` / `operator[](k)` | — | unique map only | O(log n) + O(n) if inserting |
| `insert` / `emplace` / `insert_or_assign` / `try_emplace` | yes (set: no mapped ops) | yes | O(n) element movement |
| `insert(sorted_unique, first, last)` | yes | yes | O(n + k) merge |
| `insert_range` / `emplace_hint` | yes | yes | O(n) |
| `erase(k)` / `erase(it)` / `erase(first,last)` | yes | yes | O(n) |
| `extract()` (no arg) | yes | yes | O(1) — moves out the containers |
| `replace(cont…)` | yes | yes | O(1) — installs sorted containers |
| `keys()` / `values()` | `keys()` only via iteration | yes | O(1), const access |
| `reserve` / `capacity`-like | forwards to underlying | forwards | as underlying |
| `key_comp()` / `value_comp()` | yes | yes | O(1) |
| `begin/end/rbegin/rend` | yes | yes | random access, sorted |
| `extract(k)` / node handles / `merge` | **absent** | **absent** | not a node container |
| `swap` / `clear` / `size` / `empty` | yes | yes | O(1) / O(n) |

| Property | Flat containers |
|---|---|
| Lookup / bounds | O(log n) comparisons, few cache lines |
| Traversal | contiguous (with `vector` storage) — the main win |
| Insert / erase | O(n) moves, possible reallocation |
| Reference & iterator stability | none across mutation |
| Node handles / `extract(key)` / `merge` | not provided |
| Per-element memory overhead | none beyond spare capacity |
| Exception guarantee on insert | weaker: a throwing move can leave the adaptor **empty** (`clear()`ed) |

**Interview line** — "`flat_map` trades O(n) mutation and all reference stability for contiguous, allocation-light storage — it wins on small, read-mostly, iteration-heavy tables."

**Traps** — `sorted_unique`/`sorted_equivalent` are unchecked preconditions · `flat_map` does not store `pair<const K,T>`, so generic node-map code breaks · an exception during a flat insert may clear the whole container · no `extract(key)`/`merge` · `reserve` still leaves insertion O(n) — it only removes the reallocation.

---

## 18.8 Tree versus hash table versus sorted vector for latency-sensitive lookup

| Dimension | Ordered node (`map`/`set`) | Unordered node (`unordered_*`) | Flat / sorted `vector` |
|---|---|---|---|
| Exact lookup | O(log n), ~log n cache misses | avg O(1), worst O(n) | O(log n), few cache lines |
| Range / bounds / nearest | native | **unsupported** | native |
| Ordered traversal | native, pointer-chasing | must sort first | native, streaming |
| Insert cost | allocation + rebalance | allocation + occasional O(n) rehash | O(n) shift, occasional realloc |
| Reference stability | strong except erase | strong across rehash, except erase | none |
| Iterator stability | strong except erase | destroyed by rehash | none |
| Tail latency | tight log bound | rehash and collision spikes | predictable linear shift |
| Memory overhead | 3 pointers + colour per node | bucket array + node per element | spare capacity only |
| Allocation count | 1 per element | 1 per element + bucket array | amortized, bulk |
| Best at | ordered queries, stable handles | large exact-match tables | small/read-mostly, iteration-heavy |

```cpp
// ---- the fastest associative container is usually not one ---------------
// Dense bounded integer key → direct indexing beats every hash.
class DenseIndex {
public:
    explicit DenseIndex(std::size_t max_id) : slots_(max_id + 1) {}
    int* find(std::size_t id) noexcept {
        if (id >= slots_.size() || !slots_[id]) return nullptr;
        return &*slots_[id];
    }
    void insert(std::size_t id, int v) { slots_[id] = v; }   // O(1), no hashing
private:
    std::vector<std::optional<int>> slots_;                  // memory ∝ key domain
};

// Sparse but small → sorted vector + binary search, built once.
template<class K, class V>
class SortedTable {
public:
    void build(std::vector<std::pair<K, V>> rows) {
        std::ranges::sort(rows, {}, &std::pair<K, V>::first);
        rows_ = std::move(rows);
    }
    V const* find(K const& k) const noexcept {
        auto it = std::ranges::lower_bound(rows_, k, {}, &std::pair<K, V>::first);
        return (it != rows_.end() && it->first == k) ? &it->second : nullptr;
    }
private:
    std::vector<std::pair<K, V>> rows_;
};
```

```cpp
// ---- hot-path allocation policy ----------------------------------------
#include <memory_resource>
std::pmr::unsynchronized_pool_resource pool;
std::pmr::unordered_map<std::uint64_t, Order> orders{&pool};
orders.max_load_factor(0.7f);      // policy first
orders.reserve(max_orders);        // then capacity — one rehash, at setup

std::array<std::byte, 1 << 20> buf;
std::pmr::monotonic_buffer_resource arena{buf.data(), buf.size()};
std::pmr::map<std::uint64_t, Level> ladder{&arena};   // erased nodes are NOT reclaimed
// A pool amortizes allocation. It does not create a hard capacity, prevent a
// rehash past the bound, or make anything thread-safe.
```

**Latency checklist**

1. Reserve and construct during setup; enforce a logical maximum in code.
2. Set `max_load_factor` **before** `reserve`.
3. Never use `operator[]` on a lookup-only path.
4. Use heterogeneous lookup to kill temporary `std::string` keys.
5. Keep hash/comparator cheap, `noexcept`, and free of external mutable state.
6. Measure the failed-lookup ratio and the maximum bucket size, not just the mean.
7. Never hold an iterator across a mutation whose invalidation you cannot prove.
8. For n ≲ 100 and read-mostly access, benchmark a sorted `vector` before reaching for a hash map.
9. Benchmark p99/p99.9 with realistic key distributions, not random uniform keys.

**Interview line** — "Pick ordered for range queries and stable handles, unordered for large exact-match tables with an allocation budget, flat for small read-mostly sets — and a plain indexed `vector` whenever the key domain is dense and bounded."

```text
map/set           sorted, unique, O(log n), nodes stable except erase
multi             equivalent keys adjacent; cost includes the match count
equivalence       !comp(a,b) && !comp(b,a) — not operator==
SWO               irreflexive + asymmetric + transitive + transitive equivalence
operator[]        lookup-or-INSERT; never a read
try_emplace       construct mapped value only on a miss
insert_or_assign  overwrite on a hit, iterators survive
node handle       owns an extracted node; detached key mutation is legal

unordered         avg O(1), worst O(n); iteration order unspecified
eq ⇒ equal hash   mandatory; collisions are allowed
reserve(elements) buckets for n elements under the current max_load_factor
rehash            invalidates ALL iterators; references/pointers survive
transparent       ordered: C++14 comparator; unordered: C++20 hash + eq

flat_*            C++23 sorted contiguous adaptor; O(log n) lookup,
                  O(n) mutation, no stability, no node handles
dense key         index a vector — beats every container above
```
