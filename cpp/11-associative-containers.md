# 11. Associative Containers

Associative containers retrieve values by key rather than by position. C++ offers ordered trees, standard chained hash tables, and C++23 flat containers; widely used third-party libraries add open-addressed hash tables. Choosing among them requires looking past big-O notation to allocations, pointer chasing, reference stability, and mutation patterns.

## Associative lookup and what keys must provide

An ordered container sorts keys with a comparator. An unordered container places keys according to a hash function and confirms matches with equality.

| Family | Examples | Key supplies |
|---|---|---|
| Ordered | `std::map`, `std::set` | strict weak ordering |
| Unordered | `std::unordered_map`, `std::unordered_set` | hash and equality |

A **strict weak ordering** behaves like a consistent “comes before” relation. For a comparator `comp`, it must satisfy:

- Irreflexive: `comp(a, a)` is false.
- Asymmetric: if `comp(a, b)` is true, `comp(b, a)` is false.
- Transitive: if `a` precedes `b` and `b` precedes `c`, then `a` precedes `c`.
- Transitive incomparability: keys equivalent under `comp` form consistent groups.

Using `a <= b` as a comparator fails the first rule. Ordinary floating-point `<` also fails to order a domain containing NaNs. Supplying a comparator that does not meet the container's requirements makes the container's behavior undefined (Chapter 3).

Ordered containers define key equivalence through the comparator, not necessarily through `operator==`. Two keys are equivalent when both `comp(a, b)` and `comp(b, a)` are false. The container treats equivalent keys as the same key in `std::map` and `std::set`.

A user-defined key can provide `operator<`, or the container's third template argument can be a function-object comparator (Chapter 9). Three-way comparison offers another route in Chapter 22.

`std::less<>` is a **transparent comparator**: it can compare compatible types without first converting both to the key type. Its nested `is_transparent` marker opts the container into heterogeneous lookup.

```cpp
#include <cstdint>
#include <functional>
#include <iostream>
#include <map>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include <string_view>
#include <unordered_map>

struct Symbol {
    std::uint16_t exchange;
    std::uint32_t id;

    bool operator==(const Symbol&) const = default;
};

template <>
struct std::hash<Symbol> {
    std::size_t operator()(const Symbol& symbol) const noexcept {
        const auto h1 = std::hash<std::uint16_t>{}(symbol.exchange);
        const auto h2 = std::hash<std::uint32_t>{}(symbol.id);
        return h1 * 0x9e3779b1U ^ h2;
    }
};

int main() {
    std::map<std::string, int, std::less<>> venue_codes{
        {"IBM", 1}, {"MSFT", 2}
    };
    auto pos = venue_codes.find(std::string_view{"IBM"}); // no temporary string

    std::unordered_map<Symbol, double> prices;
    prices.emplace(Symbol{7, 42}, 101.25);
    std::cout << pos->second << ' ' << prices.at({7, 42}) << '\n';
} // prints: 1 101.25
```

The specialization of `std::hash<Symbol>` combines both fields. The essential contract is:

> If `a == b`, then `std::hash<Symbol>{}(a) == std::hash<Symbol>{}(b)`.

Unequal keys may hash alike; that is a collision. Hashing only `exchange` would be legal, but every symbol on one exchange would collide and lookup would degrade.

**Pitfall.** A key must not change in a way that changes its ordering, hash, or equality while stored. Container keys are exposed as `const` for this reason; ordering by mutable outside state creates the same problem indirectly.

## Ordered maps and sets in practice

The ordered family has four members:

- `std::map<Key, T>` stores one mapped value per unique key.
- `std::set<Key>` stores unique keys without mapped values.
- `std::multimap<Key, T>` and `std::multiset<Key>` permit duplicate keys.
- `equal_range(key)` returns the subrange containing all equivalent keys.

Iteration follows comparator order. `lower_bound(key)` returns the first element whose key is not less than `key`; the related free algorithms appear in Chapter 13.

```cpp
std::map<std::string, int, std::less<>> trade_counts;

for (std::string_view symbol : {"AAPL", "IBM", "AAPL", "MSFT"}) {
    ++trade_counts[std::string{symbol}];
}

auto [it, inserted] = trade_counts.emplace("IBM", 99);
std::cout << std::boolalpha << inserted << ' ' << it->second << '\n';
// prints: false 1

std::cout << trade_counts.contains("MSFT") << '\n'; // C++20; prints: true
auto first_not_less = trade_counts.lower_bound("IBM");
std::cout << first_not_less->first << '\n'; // prints: IBM
trade_counts.erase("MSFT");

for (const auto& [symbol, count] : trade_counts) {
    std::cout << symbol << ": " << count << '\n'; // sorted by symbol
}
```

`insert` and `emplace` on a unique-key container return a `std::pair<iterator, bool>`. The iterator denotes the existing or inserted element; the Boolean reports whether insertion happened. The structured binding syntax above was used informally in Chapter 1 and is formalized in Chapter 22.

`operator[]` is both lookup and mutation. On a miss it inserts the key with a value-initialized mapped value, then returns a reference to that value. That is convenient for counting:

```cpp
std::map<std::string, int> counts{{"AAPL", 4}, {"IBM", 2}};
const auto old_size = counts.size();

if (counts["GOOG"] != 0) {
    std::cout << "traded\n";
}

std::cout << old_size << ' ' << counts.size() << '\n';
// prints: 2 3 -- the query inserted {"GOOG", 0}
```

Use `contains` when only existence matters, `find` when an iterator is needed, and `at` when a missing key should throw `std::out_of_range` (Chapter 6). `operator[]` also requires the mapped type to be default-constructible.

**Pitfall.** A map element has type `std::pair<const Key, T>`. Writing `for (const std::pair<Key, T>& entry : map)` constructs a converted temporary for every element; use `const auto&` or the exact `const Key` type.

## Lookup, insertion, and node transfer

Map operations with similar names have materially different miss and duplicate behavior. Choose the operation that states whether the call is a query, an insertion attempt, or an update.

| Operation | On missing key | On existing key | Mapped construction or assignment |
|---|---|---|---|
| `contains(key)` | returns `false` | returns `true` | none |
| `find(key)` | returns `end()` | returns iterator | none |
| `at(key)` | throws | returns mapped reference | none |
| `operator[](key)` | inserts value-initialized mapped value | returns mapped reference | default construction on miss |
| `insert(value)` | inserts complete value | leaves old value | value exists before the call |
| `emplace(args...)` | constructs and inserts | leaves old value | an attempted element may be constructed |
| `try_emplace(key, args...)` | constructs mapped value in the node | leaves old value | mapped object constructed only on insertion |
| `insert_or_assign(key, value)` | inserts | assigns replacement | exactly one of construction or assignment |

`try_emplace` is the insertion operation for an expensive mapped object whose constructor arguments are already available:

```cpp
#include <map>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

class OrderBook {
public:
    OrderBook(std::size_t levels, int tick_size)
        : levels_(levels), tick_size_(tick_size) {}

private:
    std::vector<int> levels_;
    int tick_size_;
};

void ensure_book(
    std::map<std::string, OrderBook, std::less<>>& books) {
    auto [book, inserted] =
        books.try_emplace("AAPL", 1'024, 5);
    // OrderBook{1'024, 5} is constructed only if AAPL was absent.
}
```

The constructor arguments are still evaluated before the call. Passing `make_large_book()` would build that temporary even when the key exists; pass the underlying constructor arguments when deferred construction matters.

Use `insert_or_assign` when replacement is the intended contract:

```cpp
struct Limits {
    int max_position;
};

void record_limit_update(std::string_view);

void update_limit(
    std::map<std::string, Limits, std::less<>>& venue_limits) {
    auto [position, inserted] =
        venue_limits.insert_or_assign("XNAS", Limits{25'000});

    if (!inserted) {
        record_limit_update(position->first);
    }
}
```

This avoids the accidental default construction performed by `operator[]` and distinguishes a new key from an update through the returned Boolean.

A **node handle** owns one extracted container node. Extraction removes the element without destroying or deallocating its key and mapped object; reinsertion can attach that allocation to a compatible container.

```cpp
void quarantine(
    std::map<std::string, OrderBook, std::less<>>::node_type);

void rename_book(
    std::map<std::string, OrderBook, std::less<>>& active) {
    active.try_emplace("FB", 512, 5);

    auto node = active.extract("FB");
    if (!node.empty()) {
        node.key() = "META";
        auto result = active.insert(std::move(node));
        if (!result.inserted) {
            // result.node still owns the uninserted node.
            quarantine(std::move(result.node));
        }
    }
}
```

Ordinary map keys are `const` while stored because changing one would break tree order. An extracted node is outside the tree, so its `key()` is mutable. The insertion searches under the new key and restores the ordering invariant.

`merge(source)` attempts the same transfer for every source node. Unique-key destinations leave colliding nodes in the source; non-colliding nodes move without constructing new elements. Allocator compatibility remains a precondition.

**Rule.** Use node handles for ownership transfer or key replacement when preserving the existing allocation and object identity matters. For ordinary insertion, the simpler value operations communicate intent better.

## The tree underneath and what it costs

Standard ordered associative containers are normally implemented as red-black trees, a kind of self-balancing binary search tree. Lookup is `O(log n)`, but each step loads a separately allocated node, compares its key, and follows one child pointer.

```text
Scattered tree nodes

         [K|L|R] @ 0x9100
          /            \
 [K|L|R] @ 0x1240 --> [K|L|R] @ 0xE800
       \                    /
       [K|L|R] @ 0x5700

Each arrow = a dependent pointer load to another heap location.

Flat array

 [K0][K1][K2][K3][K4][K5][K6][K7]
  --------------------------------->
          one contiguous sweep
```

A lookup in a million-node balanced tree takes roughly twenty dependent steps. The processor cannot issue the next node load until the previous node reveals its child pointer, and a scattered node is likely to require a cache miss.

| Operation | Complexity | Memory behavior |
|---|---:|---|
| `find` | `O(log n)` | `log n` dependent node loads |
| `insert` | `O(log n)` plus rebalance | one node allocation |
| `erase` | `O(log n)` | one node deallocation |
| In-order scan | `O(n)` | pointer chase per element |
| Range query of `k` results | `O(log n + k)` | starts by key, then walks sorted nodes |

The cost buys sorted iteration, efficient range queries through `lower_bound` and `upper_bound`, and strong stability. An insertion does not invalidate iterators, pointers, or references; an erase invalidates only those that denote the erased element. There is no occasional whole-container rehash.

Node handles preserve these node allocations during compatible transfers. They are useful in specialized ownership moves, not a reason to choose a tree.

## Unordered maps and sets: buckets and chains

`std::unordered_map`, `std::unordered_set`, and their `multi` variants remove sorted order. Lookup and insertion are average `O(1)` and worst-case `O(n)`. Iteration order is unspecified and can change after a rehash.

The standard interface and stability guarantees lead implementations to a bucket array plus separately allocated nodes:

```text
bucket array
  [0] ----> [AAPL, 4] ----> [MSFT, 1] ----> null
  [1] ----> null
  [2] ----> [IBM, 2] ---------------------> null
  [3] ----> [ORCL, 3] ----> [SAP, 5] -----> null

hash(key) selects a bucket; equality checks walk its chain.
```

One `find` hashes the key, computes a bucket index, loads the bucket head, then walks nodes until equality succeeds or the chain ends. Each collision adds a dependent pointer load and a key comparison.

The bucket interface makes this structure observable:

```cpp
std::unordered_map<std::string, int> counts{
    {"AAPL", 4}, {"IBM", 2}, {"MSFT", 1}
};

const std::string key = "IBM";
const auto bucket = counts.bucket(key);

std::cout << counts.bucket_count() << '\n'; // implementation-specific
std::cout << bucket << ' ' << counts.bucket_size(bucket) << '\n';
// prints: an implementation-specific bucket index and chain length
```

| Strategy | Where colliding keys live | Memory | Reference stability |
|---|---|---|---|
| Separate chaining | nodes on a bucket list | allocation per element | stable across rehash |
| Open addressing | other slots in one array | no per-element allocation | elements move on rehash |

Why can `std::unordered_map` be slower than a modern flat table? Its contract preserves pointers and references across rehash, and erasing one element does not invalidate the others. Node-based chaining supports those guarantees, at the price of a node allocation per element and pointer chasing during lookup.

**Interview.** A strong answer to “why is `std::unordered_map` slow?” connects API guarantees to representation. It mentions node stability, separate chaining, per-element allocation, pointer chasing, and collision-dependent work rather than merely saying that hashing is expensive.

## Load factor and rehashing

The **load factor** is `size() / bucket_count()`. An insertion that would exceed `max_load_factor()` causes a **rehash**: the container allocates a new bucket array and relinks every node into its new bucket.

```cpp
std::unordered_map<int, int> values;
auto previous = values.bucket_count();

for (int key = 0; key < 1000; ++key) {
    values.emplace(key, key);
    if (values.bucket_count() != previous) {
        previous = values.bucket_count();
        std::cout << previous << ' ';
    }
}
// possible libstdc++ output: 13 29 59 127 257 541 1109
// growth points and bucket counts are implementation-specific
```

A rehash invalidates every iterator, but pointers and references to elements remain valid because the nodes are relinked rather than moved. This differs from `std::vector` growth, which invalidates all three (Chapter 10).

Rehashing touches the whole table inside one otherwise ordinary insertion. Reserve enough element capacity before a latency-sensitive phase:

```cpp
std::unordered_map<int, int> values;
values.reserve(1000); // element capacity, not an exact bucket count
const auto prepared_buckets = values.bucket_count();

for (int key = 0; key < 1000; ++key) {
    values.emplace(key, key);
}

std::cout << (values.bucket_count() == prepared_buckets) << '\n';
// prints: 1 with the unchanged default max_load_factor
```

`reserve(n)` prepares for at least `n` elements under the current maximum load factor. `rehash(b)` requests at least `b` buckets. Lowering `max_load_factor` spends memory to shorten chains, though a flat table is usually a better hot-path design.

Both preparation calls may themselves rehash, so run them before capturing iterators and before the timed phase. Reserving is capacity planning, not a permanent ceiling: inserting beyond the prepared element count can still trigger later growth.

**Pitfall.** Never retain an iterator across an insertion that may rehash. Do not predict safe insertion counts from one library's observed bucket sequence; growth policies differ among implementations.

## Open addressing

An open-addressed table stores every element in the bucket array itself. On collision it follows a deterministic **probe sequence** until it finds the key or an empty slot.

```text
index:      4       5       6       7       8       9
state:    EMPTY   [IBM]   [SAP]   [DEL]   [ORCL]  EMPTY
hash(ORCL) --------^       |       |       |
linear probe:      5 ----> 6 ----> 7 ----> 8  found

hash(NEW)  --------^ ----> 6 ----> 7 ----> 8 ----> 9  empty
                              tombstone is not an empty stop
```

Each slot needs a state such as empty, full, or deleted. Erasing a full slot cannot simply mark it empty: a lookup for a key placed later in the probe run would stop too early. A **tombstone** records deletion while preserving the search path. Accumulated tombstones lengthen probes until a rehash cleans them away.

| Probe scheme | Sequence | Main consequence |
|---|---|---|
| Linear | next slot | excellent locality; primary clustering |
| Quadratic | widening offsets | less clustering; weaker locality |
| Double hashing | second hash gives stride | good distribution; scattered loads |

Linear probing often wins on real processors because nearby probes occupy the same cache line or the next one, where hardware prefetch can help. Double hashing can turn each additional probe into an unrelated cache miss.

Open addressing removes per-element allocation and keeps storage dense. Its costs are weaker reference stability and rapidly increasing probe lengths as the array fills; implementations normally maintain meaningful empty capacity instead of approaching a load factor of one.

## Robin Hood and the modern flat tables

Robin Hood hashing adds one rule to open addressing: the element farther from its home bucket wins a contested slot. Insertion may displace a resident element with a shorter probe distance, which is then inserted farther along.

This policy reduces variance in probe lengths. Lookups can also stop when their current probe distance exceeds that of the resident element, because the sought key could not occur later under the invariant. The benefit for latency-sensitive code is a tighter tail, not a different average-complexity label.

Modern flat hash maps such as `absl::flat_hash_map` and `boost::unordered_flat_map` combine open addressing with compact metadata. A representative Swiss-table layout stores a small hash fragment and slot state in each metadata byte:

```text
meta:   [h7][h7][EMPTY][h7][DEL][h7][EMPTY][h7] ...
slots:  [K,V][K,V][  -- ][K,V][ --][K,V][  -- ][K,V] ...
         <------ a group of metadata bytes compared together ------>

Most misses are rejected from metadata without loading keys or values.
```

Some implementations compare a group of 16 metadata bytes at once using SIMD instructions. That detail is implementation-specific; explicit SIMD programming appears in Chapter 14.

Their basic use resembles `std::unordered_map`:

```cpp
#include <absl/container/flat_hash_map.h>
#include <string>

absl::flat_hash_map<std::string, int> counts;
counts["AAPL"] = 4;
```

**Rule.** Assume a flat hash table provides no iterator, pointer, or reference stability across insertion. Rehashing physically moves elements; copy small values, retain stable IDs, or store owning `std::unique_ptr` values when the pointed-to objects must stay put.

**Interview.** Contrast `std::unordered_map` with a flat hash map by mechanism: chaining and stable nodes versus open addressing and group-tested metadata. The former allocates each element; the latter trades stability for dense storage and fewer cache misses.

## Sorted vectors: `flat_map` and `flat_set`

`std::flat_map` and `std::flat_set` are C++23 container adapters over sorted random-access storage. A `std::flat_map` uses separate contiguous key and value containers—a structure-of-arrays layout—rather than an array of pairs.

Lookup performs binary search in `O(log n)`, as a tree does, but steps through contiguous key storage instead of chasing node pointers. Iteration is sorted, while the keys and values each occupy contiguous arrays; the logical key-value iterator may expose a pair-like proxy rather than an actual array-of-pairs reference.

```cpp
#include <cstdint>
#include <flat_map> // C++23
#include <utility>
#include <vector>

struct Symbol {
    std::uint32_t id;

    bool operator<(const Symbol& other) const {
        return id < other.id;
    }
};

struct Limits {
    int max_position;
};

std::vector<std::pair<Symbol, Limits>> rows{
    {{42}, {1'000}}, {{7}, {500}}, {{19}, {750}}
};

std::flat_map<Symbol, Limits> limits(rows.begin(), rows.end());
// build once at startup: O(n log n)

const int cap = limits.at(Symbol{19}).max_position;
// query all day: O(log n), no pointer chasing; cap == 750
```

**Note.** `std::flat_map` is standard C++23, but standard-library releases shipped it at different times. A compiler accepting `-std=c++23` may still have an older library without `<flat_map>`.

Insertion or erasure shifts a tail of elements and is `O(n)`. Repeated one-at-a-time insertion can therefore become `O(n²)`; bulk-construct or range-insert instead. The ideal workload is a symbol table built from reference data at startup, then queried without intraday mutation. For only tens of entries, contiguous scanning and compact storage can also beat tree or hash overhead despite less attractive asymptotic notation.

## Choosing ordered versus hash-based containers

Choose by the guarantees the workload needs, then by memory behavior. “Fast lookup” alone is not enough information.

| Need | Container | Mechanism |
|---|---|---|
| Sorted iteration or range queries | `std::map` / `std::set` | red-black tree |
| Sorted, read-mostly, bulk-built data | `std::flat_map` / `std::flat_set` (C++23) | sorted contiguous storage |
| Fast point lookup, standard library only | `std::unordered_map` / `std::unordered_set` | chained hash table |
| Fast point lookup on a hot path | Abseil or Boost flat hash map | open addressing and compact metadata |
| Stable references with hashing | `std::unordered_map` | separately allocated nodes |
| Duplicate keys | `std::multimap` / `std::multiset` | `equal_range` identifies duplicates |
| Tiny collection | `std::flat_map` or sorted vector | cache-friendly contiguous scan |

Use `std::map` when order, range queries, or stable elements justify tree traversal. Use `std::unordered_map` when standard-only hashing plus stable references matters. For hot point lookup, a flat hash map is the usual default; for static sorted data, prefer `std::flat_map`.

## Latency Lens

- A `std::map` lookup performs `log n` dependent node loads; each possible cache miss must resolve before the next child address is known.
- `std::unordered_map` pays a node allocation per element and at least one pointer chase per lookup to provide its stability guarantees.
- A rehash relinks every node inside one insertion, creating an `O(n)` latency spike; call `reserve` before the burst as with `std::vector` growth.
- Transparent lookup avoids constructing a temporary `std::string`, removing its possible allocation and character copy from each find.
- `try_emplace` avoids constructing the mapped object on a duplicate key; `operator[]` instead inserts a default mapped value on every miss.
- `extract` and `merge` transfer existing nodes without allocating replacements when allocators are compatible.
- Linear probing keeps collisions on nearby cache lines, while double hashing can make every additional probe an independent cache miss.
- Robin Hood displacement compresses long probe runs toward the mean, improving the tail behavior that latency budgets care about.
- Flat hash maps reject most absent keys by scanning compact metadata before loading element storage.
- `std::flat_map` binary search touches contiguous keys; it has the tree's `O(log n)` comparisons without the tree's dependent node loads.
- Hash quality is a latency control: a weak multi-field hash creates long chains or probe runs even though the API still advertises average `O(1)`.
