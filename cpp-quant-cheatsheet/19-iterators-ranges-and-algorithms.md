# 19. Iterators, ranges, and algorithms

*Part III — Standard library quick reference*

---

**Recall**
- An iterator plus a sentinel describes traversal; a range is just a `begin`/`end` pair whose two types need not match.
- Pick the **weakest** iterator/range contract that expresses the operation — stronger categories reject valid single-pass sources.
- Categories nest: `input` ⊂ `forward` ⊂ `bidirectional` ⊂ `random_access` ⊂ `contiguous`; `output` is orthogonal, not a rung.
- `forward` is exactly the multipass guarantee: two copies over the same range see the same elements.
- `contiguous` adds `std::to_address(i + n) == std::to_address(i) + n`, which is what lets a range become a `span`.
- `*it` need not be `T&` — `vector<bool>`, `views::transform`, and `views::zip` yield proxy references, so constrain on operations, not on `T&`.
- Concept satisfaction includes semantic requirements (complexity, equality domain, multipass) the compiler cannot check.
- `end()` is a position, not an element: comparable, not dereferenceable, not incrementable.
- Algorithms never change a container's size; `remove`/`unique`/`partition` only rearrange and return the new logical boundary.
- Destination capacity is the caller's job — `reserve` gives capacity, not elements, so `copy` into `out.begin()` of an empty vector is UB.
- Ranges algorithms add projections, sentinels, `dangling` protection, and structured results (`.in`, `.out`, `.in1`, `.in2`).
- Projections and comparators may be invoked more than once per element, in an unspecified order — never treat them as preprocessing hooks.
- Ranges algorithms take **no** execution policies; policies belong to the classic `<algorithm>` iterator-pair overloads.
- `par_unseq`/`unseq` invocations may be unsequenced, so locks, allocation, or cross-invocation ordering inside the callable are invalid.
- If a callable invoked under a standard execution policy throws, `std::terminate` is called — no exception escapes.
- Views are lazy composition of traversal, usually non-owning: predicates rerun per traversal, and a copy of a view is not a snapshot.
- `views::filter` caches its first `begin()`; that is why `filter_view::begin()` is not `const` and is amortized O(1) only after the first call.
- `borrowed_range` means iterators may outlive the *range object*, not the backing storage; non-borrowed rvalues yield `ranges::dangling`.
- `ranges::to<C>` (C++23) materializes a pipeline; it does not promise a single allocation nor lossless conversion.
- Fold direction is observable for non-associative operations — floating-point `+` included.
- Algorithms are not inherently faster than loops; they name a precondition and a complexity, which is the actual payoff.

---

## 19.1 Iterator categories and C++20 iterator concepts

```cpp
#include <iterator>
#include <vector>
#include <deque>
#include <list>
#include <forward_list>
#include <map>

// ---- legacy tag hierarchy (still what <algorithm> dispatches on) ---------
std::input_iterator_tag;            // single pass, read
std::output_iterator_tag;           // single pass, write
std::forward_iterator_tag;          // multipass
std::bidirectional_iterator_tag;    // += --
std::random_access_iterator_tag;    // O(1) +n, -, [], <
std::contiguous_iterator_tag;       // C++20: addresses are consecutive

// ---- C++20 concepts (what std::ranges:: dispatches on) ------------------
static_assert(std::contiguous_iterator<std::vector<int>::iterator>);
static_assert(std::contiguous_iterator<int*>);
static_assert(std::random_access_iterator<std::deque<int>::iterator>);
static_assert(!std::contiguous_iterator<std::deque<int>::iterator>);
static_assert(std::bidirectional_iterator<std::list<int>::iterator>);
static_assert(std::bidirectional_iterator<std::map<int,int>::iterator>);
static_assert(!std::random_access_iterator<std::list<int>::iterator>);
static_assert(std::forward_iterator<std::forward_list<int>::iterator>);
static_assert(std::input_iterator<std::istream_iterator<int>>);
static_assert(!std::forward_iterator<std::istream_iterator<int>>);
static_assert(std::output_iterator<std::back_insert_iterator<std::vector<int>>, int>);
```

```cpp
// ---- associated type traits (C++20 spellings) ---------------------------
template<std::input_iterator I>
void inspect(I it) {
    using V = std::iter_value_t<I>;        // value type, no ref/cv
    using R = std::iter_reference_t<I>;    // decltype(*it) — may be a PROXY
    using D = std::iter_difference_t<I>;   // signed, usually ptrdiff_t
    using RR = std::iter_rvalue_reference_t<I>;  // decltype(ranges::iter_move(it))
    using C = std::iter_common_reference_t<I>;   // common ref of V& and R
    static_assert(std::signed_integral<D>);
}
// pre-C++20 spellings: std::iterator_traits<I>::value_type / reference /
// difference_type / pointer / iterator_category
```

```cpp
// ---- writing a conforming iterator (minimum for forward_iterator) -------
struct TickIter {
    using value_type      = int;
    using difference_type = std::ptrdiff_t;
    // opt-in to a stronger concept than the deduced one:
    using iterator_concept  = std::forward_iterator_tag;   // C++20 ranges
    using iterator_category = std::forward_iterator_tag;   // legacy <algorithm>

    int const* p{};
    int operator*() const { return *p; }
    TickIter& operator++() { ++p; return *this; }
    TickIter  operator++(int) { auto t = *this; ++p; return t; }
    bool operator==(TickIter const&) const = default;   // C++20 gives !=
};
static_assert(std::forward_iterator<TickIter>);
// input_iterator alone needs: value_type, difference_type, *it, ++it, it++.
// forward adds: default_initializable, equality_comparable, multipass.
// bidirectional adds --it, it--.  random_access adds +=, -=, +, -, [], <=>.
// contiguous adds std::to_address support and element contiguity.
```

| Concept (`std::`) | Adds over previous | Multipass | Models |
|---|---|---|---|
| `indirectly_readable<I>` | `*i` valid, common reference | — | any readable |
| `indirectly_writable<I,T>` | `*i = t` valid | — | any writable |
| `weakly_incrementable<I>` | `++i`, `i++`, `difference_type` | — | counters |
| `input_or_output_iterator<I>` | `*i` + `weakly_incrementable` | — | root concept |
| `output_iterator<I,T>` | write then advance | No | `back_insert_iterator` |
| `input_iterator<I>` | read, `iterator_concept` tag | No | `istream_iterator` |
| `forward_iterator<I>` | default-init, `==`, multipass | Yes | `forward_list::iterator` |
| `bidirectional_iterator<I>` | `--i`, `i--` | Yes | `list`/`map` iterator |
| `random_access_iterator<I>` | `+= -= + - [] <=>`, O(1) | Yes | `deque` iterator |
| `contiguous_iterator<I>` | `to_address`, address arithmetic | Yes | `T*`, `vector::iterator` |
| `sentinel_for<S,I>` | `i == s` well-formed, semiregular `S` | — | `default_sentinel_t` |
| `sized_sentinel_for<S,I>` | `s - i` in O(1) | — | `int*` vs `int*` |

| Indirect-callable concept | Meaning |
|---|---|
| `indirectly_unary_invocable<F,I>` | `F` callable on `*i` |
| `indirect_unary_predicate<F,I>` | predicate over `*i` |
| `indirect_binary_predicate<F,I1,I2>` | predicate over `*i1,*i2` |
| `indirect_strict_weak_order<F,I1,I2>` | comparator for sorting/search |
| `indirectly_movable<I,O>` / `indirectly_copyable<I,O>` | `*o = ranges::iter_move(i)` / `*o = *i` |
| `indirectly_swappable<I1,I2>` | `ranges::iter_swap` valid |
| `mergeable<I1,I2,O,C,P1,P2>` | precondition bundle for `merge`/`set_*` |
| `sortable<I,C,P>` | `permutable` + `indirect_strict_weak_order` |
| `permutable<I>` | forward + `indirectly_movable_storable` + swappable |

**Traps** — declaring `random_access_iterator_tag` without O(1) jumps is a lie the compiler accepts · `iterator_concept` (ranges) can differ from `iterator_category` (legacy), which is how `deque` stays "random access" for both · a proxy-returning iterator can be `input` only, because `forward` requires `reference` to be a real reference to `value_type` · `operator++(int)` returning `void` is legal for `input_iterator` but kills `forward_iterator`.

---

## 19.2 Iterator operations, sentinels, and invalidation

```cpp
#include <iterator>
#include <ranges>

auto it = v.begin();
++it;                        // preferred: no old-value copy required
it++;                        // needs a copyable old value
auto&& x = *it;              // may be proxy — bind with auto&&

// ---- free operations: classic vs ranges ---------------------------------
std::advance(it, 5);                       // void; O(n) unless random access
auto n2 = std::next(it, 2);                // returns copy
auto p2 = std::prev(it, 2);                // bidirectional only
auto d  = std::distance(first, last);      // O(1) random access, else O(n)

std::ranges::advance(it, 5);               // void
std::ranges::advance(it, last);            // advance to sentinel
auto left = std::ranges::advance(it, 5, last);  // bounded; returns UNMET count
auto nx = std::ranges::next(it);                // +1
auto nx3 = std::ranges::next(it, 3, last);      // bounded, never past last
auto pv = std::ranges::prev(it, 3, first);      // bounded backwards
auto dd = std::ranges::distance(first, last);   // also takes a whole range
auto sz = std::ranges::size(rng);               // O(1) for sized_range
auto ss = std::ranges::ssize(rng);              // signed
auto dp = std::ranges::data(rng);               // contiguous_range only
auto ee = std::ranges::empty(rng);
```

```cpp
// ---- customization points that respect proxies --------------------------
auto&& v1 = std::ranges::iter_move(it);   // rvalue reference / rvalue proxy
std::ranges::iter_swap(i, j);             // works across different iterator types
std::iter_swap(i, j);                     // classic equivalent
```

```cpp
// ---- iterator/sentinel pairs (C++20): end need not be an iterator -------
template<std::input_iterator I, std::sentinel_for<I> S>
std::size_t count_until(I first, S last) {
    std::size_t n = 0;
    for (; first != last; ++first) ++n;    // only i != s is required
    return n;
}

std::default_sentinel_t ds{};                       // "ask the iterator"
std::counted_iterator ci{v.begin(), 3};             // C++20: carries a count
static_assert(std::sentinel_for<std::default_sentinel_t, decltype(ci)>);
std::unreachable_sentinel_t us{};                   // never compares equal
auto forever = std::ranges::subrange(v.begin(), std::unreachable_sentinel);

// a hand-written sentinel: stop at the first NUL
struct NulSentinel {
    bool operator==(char const* p) const { return *p == '\0'; }
};
auto len = count_until("hello", NulSentinel{});     // 5

std::ranges::subrange sub{first, last};             // pack pair into a range
auto [b, e] = sub;                                  // structured binding
std::ranges::subrange sized{first, last, count};    // sized subrange
```

```cpp
// ---- iterator adaptors --------------------------------------------------
std::reverse_iterator ri{v.end()};        // *ri == *(v.end()-1)
auto base = ri.base();                    // the underlying iterator (offset by 1!)
std::make_reverse_iterator(v.end());
std::back_insert_iterator bi{v};          // *o = x  ->  v.push_back(x)
std::back_inserter(v);
std::front_inserter(dq);                  // push_front
std::inserter(v, v.begin() + 2);          // insert(pos, x), pos advances
std::move_iterator mi{v.begin()};         // *mi is an rvalue reference
std::make_move_iterator(v.begin());
std::move_sentinel ms{v.end()};           // C++20
std::counted_iterator cit{v.begin(), 4};  // C++20, pair with default_sentinel
std::common_iterator<It, Sent> cmn{it};   // erase sentinel type for legacy algos
std::istream_iterator<int> in{std::cin}, in_end{};
std::ostream_iterator<int> out{std::cout, ", "};
std::istreambuf_iterator<char> cin_ch{std::cin.rdbuf()};
std::ostreambuf_iterator<char> cout_ch{std::cout};
```

```cpp
// ---- mutation while iterating: the only correct erase loop --------------
for (auto it = v.begin(); it != v.end(); ) {
    if (should_remove(*it)) it = v.erase(it);   // erase RETURNS the next
    else                    ++it;
}
std::erase_if(v, should_remove);                // C++20, one call, O(n)

// node containers: capture next BEFORE erasing
for (auto it = m.begin(); it != m.end(); ) {
    if (drop(*it)) it = m.erase(it);            // map::erase also returns next
    else ++it;
}
```

```cpp
// ---- range-for desugaring (why mutation is UB) --------------------------
{
    auto&& __r = range_expression;              // bound ONCE
    auto __b = std::ranges::begin(__r);         // cached
    auto __e = std::ranges::end(__r);           // cached
    for (; __b != __e; ++__b) { auto&& elem = *__b; body(elem); }
}
for (int x : v) { if (x == 3) v.push_back(4); }  // UB: __b/__e may dangle

// C++23: lifetime of ALL temporaries in the range-expression is extended
for (auto c : get_person().name()) { }           // OK in C++23, UB in C++20
```

| Operation | Random access | Other categories |
|---|---|---|
| `std::advance` / `ranges::advance` | O(1) | O(n) increments |
| `std::distance` / `ranges::distance` | O(1) | O(n) |
| `ranges::size` | O(1) | O(1) only if `sized_range` |
| `next`/`prev` with bound | O(1) | O(n), never overruns bound |
| `it + n` | O(1) | not available |

**Traps** — `reverse_iterator::base()` points one *past* the referenced element · `std::distance` on an input iterator consumes it · comparing/subtracting iterators from different containers is UB · `ranges::advance(it, n, bound)` returns the *unsatisfied* count, not the new position · `back_inserter` allocates and can invalidate every other iterator into the container · `counted_iterator` with a wrong count is UB, not an exception.

---

## 19.3 Algorithm families: search, copy, transform, partition, sort, heap, set, numeric

```cpp
#include <algorithm>
#include <numeric>
#include <functional>

// Every classic algorithm has a std::ranges:: twin taking (range) or
// (iterator, sentinel), plus optional comparator and projection(s).
std::sort(v.begin(), v.end());                          // classic
std::sort(v.begin(), v.end(), std::greater<>{});        // + comparator
std::ranges::sort(v);                                   // range form
std::ranges::sort(v.begin(), v.end());                  // iterator/sentinel form
std::ranges::sort(v, std::greater{});                   // + comparator
std::ranges::sort(orders, std::less{}, &Order::price);  // + projection
std::sort(std::execution::par, v.begin(), v.end());     // policy: classic ONLY
```

**Index — non-modifying sequence operations** (all in `std::` and `std::ranges::` unless noted; *n* = range length)

| Algorithm | Complexity | Notes |
|---|---|---|
| `all_of` / `any_of` / `none_of` | O(n) | short-circuits |
| `for_each` | O(n) | returns `{in, fun}` in ranges form |
| `for_each_n` | O(n) | C++17 |
| `count` / `count_if` | O(n) | returns `difference_type` |
| `mismatch` | O(n) | returns first differing pair |
| `equal` | O(n) | 4-iterator form checks lengths first |
| `find` / `find_if` / `find_if_not` | O(n) | first match |
| `find_last` / `find_last_if` / `find_last_if_not` | O(n) | **C++23, ranges only** |
| `find_end` | O(n·m) | last subsequence occurrence |
| `find_first_of` | O(n·m) | first element present in a set |
| `adjacent_find` | O(n) | first equal (or pred-true) neighbour pair |
| `search` | O(n·m) | first subsequence; searcher overload in `<functional>` |
| `search_n` | O(n) | run of `n` equal values |
| `contains` / `contains_subrange` | O(n) / O(n·m) | **C++23, ranges only** |
| `starts_with` / `ends_with` | O(n) | **C++23, ranges only** |
| `lexicographical_compare` | O(n) | `<` semantics |
| `lexicographical_compare_three_way` | O(n) | C++20, `std::` only |
| `fold_left` / `fold_right` family | O(n) | **C++23, ranges only** — see 19.9 |

**Index — modifying sequence operations**

| Algorithm | Complexity | Notes |
|---|---|---|
| `copy` | O(n) | dest must not be inside `[first,last)` |
| `copy_if` | O(n) | ranges returns `{in, out}` |
| `copy_n` | O(n) | no bound check on source |
| `copy_backward` | O(n) | for right-shifting overlapping ranges |
| `move` | O(n) | source left in valid-but-unspecified state |
| `move_backward` | O(n) | overlapping right shift with moves |
| `swap_ranges` | O(n) | element-wise |
| `transform` (unary/binary) | O(n) | output may alias input positionally |
| `replace` / `replace_if` | O(n) | in place |
| `replace_copy` / `replace_copy_if` | O(n) | to a destination |
| `fill` / `fill_n` | O(n) | assigns, does not construct |
| `generate` / `generate_n` | O(n) | calls a nullary generator |
| `remove` / `remove_if` | O(n) | **does not erase**; returns new logical end |
| `remove_copy` / `remove_copy_if` | O(n) | filtered copy |
| `unique` | O(n) | **adjacent** duplicates only |
| `unique_copy` | O(n) | adjacent dedupe into destination |
| `reverse` | O(n) | bidirectional |
| `reverse_copy` | O(n) | |
| `rotate` | O(n) | returns new position of old first |
| `rotate_copy` | O(n) | |
| `shift_left` / `shift_right` | O(n) | C++20 |
| `sample` | O(n) | C++17; needs a `UniformRandomBitGenerator` |
| `shuffle` | O(n) | needs random access + URBG |
| `random_shuffle` | — | **removed in C++17** |

**Index — partitioning**

| Algorithm | Complexity | Notes |
|---|---|---|
| `is_partitioned` | O(n) | predicate applications |
| `partition` | O(n) swaps | unstable; returns partition point |
| `stable_partition` | O(n log n) swaps, O(n) with buffer | may allocate |
| `partition_copy` | O(n) | writes true-group and false-group separately |
| `partition_point` | O(log n) comparisons | range must already be partitioned |

**Index — sorting and selection** (random access required unless noted)

| Algorithm | Complexity | Stable |
|---|---|---|
| `sort` | O(n log n) comparisons | No |
| `stable_sort` | O(n log n) with buffer, else O(n log²n) | Yes |
| `partial_sort(first, mid, last)` | O(n log k), k = mid−first | No |
| `partial_sort_copy` | O(n log k) | No |
| `nth_element` | O(n) average, O(n log n) worst | No |
| `is_sorted` / `is_sorted_until` | O(n) | — |
| `ranges::sort` on a `list` | ill-formed | use `list::sort` (merge sort, stable) |

**Index — binary search on a sorted/partitioned range**

| Algorithm | Complexity | Returns |
|---|---|---|
| `lower_bound` | O(log n) comparisons | first pos not `< value` |
| `upper_bound` | O(log n) comparisons | first pos `value <` it |
| `equal_range` | O(log n) comparisons | `{lower, upper}` subrange |
| `binary_search` | O(log n) comparisons | `bool` only |

**Index — sorted-range set operations** (both inputs sorted by the same comparator)

| Algorithm | Complexity | Notes |
|---|---|---|
| `merge` | ≤ n1+n2−1 comparisons | stable; separate destination |
| `inplace_merge` | O(n) with buffer, else O(n log n) | merges two sorted halves |
| `includes` | ≤ 2(n1+n2)−1 | subset test |
| `set_union` | ≤ 2(n1+n2)−1 | max multiplicity |
| `set_intersection` | ≤ 2(n1+n2)−1 | min multiplicity |
| `set_difference` | ≤ 2(n1+n2)−1 | in first, not second |
| `set_symmetric_difference` | ≤ 2(n1+n2)−1 | in exactly one |

**Index — heap operations** (max-heap under `std::less`)

| Algorithm | Complexity | Notes |
|---|---|---|
| `make_heap` | O(n) | ≤ 3n comparisons |
| `push_heap` | O(log n) | new element already at back |
| `pop_heap` | O(log n) | max moved to back; still must `pop_back` |
| `sort_heap` | O(n log n) | destroys the heap property |
| `is_heap` / `is_heap_until` | O(n) | |

**Index — min/max and comparison**

| Algorithm | Complexity | Notes |
|---|---|---|
| `min` / `max` / `minmax` | O(1) / O(n) for init-list | returns *references* for the 2-arg form |
| `min_element` / `max_element` | n−1 / n−1 comparisons | first of equals |
| `minmax_element` | ⌈3n/2⌉−2 comparisons | `min` = first, `max` = **last** of equals |
| `clamp` | O(1) | C++17; returns a reference |
| `is_permutation` | O(n²) | forward iterators |
| `next_permutation` / `prev_permutation` | O(n) | lexicographic order |

**Index — uninitialized memory (`<memory>`)**

| Algorithm | Complexity | Notes |
|---|---|---|
| `uninitialized_copy` / `_n` | O(n) | constructs; unwinds on throw |
| `uninitialized_move` / `_n` | O(n) | C++17 |
| `uninitialized_fill` / `_n` | O(n) | |
| `uninitialized_default_construct` / `_n` | O(n) | C++17, indeterminate for trivial |
| `uninitialized_value_construct` / `_n` | O(n) | C++17, zero-initializes trivial |
| `destroy` / `destroy_n` / `destroy_at` | O(n) | |
| `construct_at` | O(1) | C++20, `constexpr`-friendly |
| `ranges::uninitialized_*` | O(n) | C++20 range versions of all of the above |

**Index — `<numeric>`** (no `ranges::` twins except the C++23 folds)

| Algorithm | Complexity | Notes |
|---|---|---|
| `accumulate` | O(n) | **strictly left fold**, sequential, no policy |
| `reduce` | O(n) | C++17; op must be associative + commutative; policy-capable |
| `inner_product` | O(n) | sequential |
| `transform_reduce` | O(n) | C++17; fused map-reduce, policy-capable |
| `partial_sum` | O(n) | inclusive, sequential |
| `inclusive_scan` / `exclusive_scan` | O(n) | C++17, policy-capable |
| `transform_inclusive_scan` / `transform_exclusive_scan` | O(n) | C++17 |
| `adjacent_difference` | O(n) | out[0] == in[0] |
| `iota` | O(n) | `ranges::iota` exists (C++23) |
| `gcd` / `lcm` | O(log n) | C++17 |
| `midpoint` / `lerp` | O(1) | C++20, overflow-safe |
| `saturate_cast` | O(1) | C++26/`<numeric>` adjacent — check support |

```cpp
// ---- destination capacity is the caller's job ---------------------------
std::vector<int> out(input.size());                        // SIZED, not reserved
std::ranges::transform(input, out.begin(), [](int x){ return x * 2; });

std::vector<int> grown;
grown.reserve(input.size());                               // capacity only
std::ranges::copy_if(input, std::back_inserter(grown), is_valid);  // grows safely
// std::ranges::copy(input, grown.begin());                // UB: size() == 0
```

```cpp
// ---- erase-remove, the two spellings ------------------------------------
v.erase(std::remove_if(v.begin(), v.end(), pred), v.end());     // classic
auto tail = std::ranges::remove_if(v, pred);                    // returns subrange
v.erase(tail.begin(), tail.end());                              // ranges
std::erase_if(v, pred);                                         // C++20, best
// [new_end, old_end) holds moved-from, valid-but-unspecified elements.
```

```cpp
// ---- unique removes ADJACENT equivalents only ---------------------------
std::ranges::sort(v);                       // group first if global dedupe wanted
auto dup = std::ranges::unique(v);          // subrange of leftovers
v.erase(dup.begin(), dup.end());
```

```cpp
// ---- selection: nth_element vs partial_sort -----------------------------
auto mid = v.begin() + v.size() / 2;
std::ranges::nth_element(v, mid);           // *mid is the median; sides UNSORTED
std::ranges::partial_sort(v, v.begin() + 10);  // top 10 sorted, rest unspecified
std::ranges::partial_sort_copy(src, dst);      // top dst.size() into dst
```

```cpp
// ---- heap protocol ------------------------------------------------------
std::ranges::make_heap(v);                  // O(n)
v.push_back(x); std::ranges::push_heap(v);  // O(log n) — element already at back
std::ranges::pop_heap(v);                   // max swapped to back
auto top = std::move(v.back()); v.pop_back();
std::ranges::sort_heap(v);                  // now sorted ascending, no longer a heap
```

```cpp
// ---- set operations need both inputs sorted the SAME way ----------------
std::vector<int> both;
std::ranges::set_intersection(a, b, std::back_inserter(both));
std::ranges::set_difference(a, b, std::back_inserter(both), std::less{},
                            &Order::id, &Order::id);   // projections per input
```

```cpp
// ---- searchers for repeated pattern search (<functional>) ---------------
std::boyer_moore_searcher bm{pat.begin(), pat.end()};             // C++17
std::boyer_moore_horspool_searcher bmh{pat.begin(), pat.end()};
std::default_searcher ds{pat.begin(), pat.end()};
auto hit = std::search(hay.begin(), hay.end(), bm);   // amortized sublinear
```

**Traps** — `remove_if` never shrinks the container · `unique` on unsorted data only collapses runs · `copy` into an overlapping destination that moves left is fine, right needs `copy_backward` · `accumulate` with an `int` init over `double` elements silently truncates · `reduce` may reassociate and give a different floating-point sum than `accumulate` · `minmax_element` returns the **last** maximum but the first minimum · `partition_point` on an unpartitioned range compiles and returns garbage.

---

## 19.4 Complexity and projection-aware algorithms

```cpp
struct Order { std::uint64_t id; std::int64_t price; int qty; bool active; };
std::vector<Order> orders;

// ---- every projection form ----------------------------------------------
std::ranges::sort(orders, std::less{}, &Order::price);         // pointer-to-member
std::ranges::sort(orders, {}, &Order::price);                  // {} = std::less
std::ranges::find(orders, 42ULL, &Order::id);                  // search by member
std::ranges::count_if(orders, [](int q){ return q > 100; }, &Order::qty);
std::ranges::max_element(orders, {}, &Order::price);
std::ranges::sort(orders, {}, [](Order const& o){             // callable projection
    return std::pair{o.price, o.id};                          // composite key
});
std::ranges::equal(a, b, {}, &Order::id, &Order::id);          // two projections
std::ranges::find(orders, true, &Order::active);               // member as key
// Projection applies BEFORE comparator/predicate; comparator sees proj(elem).
```

```cpp
// ---- structured results: bind them, don't index them --------------------
auto [in, out]   = std::ranges::copy(src, dst.begin());        // in_out_result
auto [i1, i2]    = std::ranges::mismatch(a, b);                // in_in_result
auto [i, o1, o2] = std::ranges::partition_copy(v, t, f, pred); // in_out_out_result
auto [ino, fun]  = std::ranges::for_each(v, sink);             // in_fun_result
auto [mn, mx]    = std::ranges::minmax_element(v);             // min_max_result
auto sub         = std::ranges::remove_if(v, pred);            // subrange
auto [it, ended] = std::ranges::in_found_result{};             // *_permutation
```

| Result type | Members | Produced by |
|---|---|---|
| `in_fun_result` | `.in .fun` | `for_each`, `for_each_n` |
| `in_in_result` | `.in1 .in2` | `mismatch`, `swap_ranges` |
| `in_out_result` | `.in .out` | `copy`, `move`, `transform`, `unary` forms |
| `in_in_out_result` | `.in1 .in2 .out` | binary `transform`, `merge`, `set_*` |
| `in_out_out_result` | `.in .out1 .out2` | `partition_copy` |
| `min_max_result` | `.min .max` | `minmax`, `minmax_element` |
| `in_found_result` | `.in .found` | `next_permutation`, `prev_permutation` |
| `in_value_result` | `.in .value` | `fold_left_with_iter` (C++23) |
| `borrowed_iterator_t<R>` | iterator or `dangling` | `find`, `min_element`, … |
| `borrowed_subrange_t<R>` | subrange or `dangling` | `remove_if`, `unique`, `equal_range` |

```text
// ---- complexity is measured in more than one currency -------------------
lower_bound(vector)   O(log n) comparisons + O(log n) pointer jumps
lower_bound(list)     O(log n) comparisons + O(n)     increments  ← the real cost
map::lower_bound      O(log n) via tree structure     ← use the member, not std::
find(vector)          O(n) but contiguous, branch-predictable, vectorizable
find(unordered_set)   O(1) average, one hash + one pointer chase, cache-hostile
sort(n=32)            O(n log n) nominal, but insertion sort in practice
```

- The headline counts *comparisons*; swaps, moves, assignments, predicate calls, and iterator increments are separately specified.
- A projection that hashes a string, chases a pointer, takes a lock, or touches cold memory dominates the nominal complexity.
- Projections are invoked inside the comparison pattern, not once per element — call counts and order are unspecified.
- Successful vs failed search changes the constant: `find` failure is always the full *n*.
- `stable_sort` allocates a temporary buffer; on failure it degrades to O(n log²n) with no allocation.
- `stable_partition`, `inplace_merge`, and `stable_sort` are the three allocating algorithms in `<algorithm>`.
- For latency work, benchmark the **worst legal input**, not uniform random data.

**Interview line** — "Ranges projections are not a preprocessing pass: the algorithm may call them several times per element in an unspecified order, so they must be pure and cheap."

**Traps** — a projection returning by value makes every comparison copy · `&Order::price` as a projection is free; `[](auto const& o){ return o.price; }` is too, but `return std::to_string(o.id);` allocates per comparison · comparators must be a strict weak ordering (`comp(a,a)` false, transitive, transitive incomparability) or `sort` walks off the end — that is real, observed UB, not theoretical.

---

## 19.5 Execution policies and parallel algorithm caveats

```cpp
#include <execution>
#include <algorithm>
#include <numeric>

std::execution::seq;        // sequenced in the calling thread
std::execution::unseq;      // C++20: vectorized in the calling thread
std::execution::par;        // parallel across threads, each invocation sequenced
std::execution::par_unseq;  // parallel AND vectorized: invocations interleave

std::sort(std::execution::par, v.begin(), v.end());
std::transform(std::execution::par_unseq, in.begin(), in.end(), out.begin(), f);
std::for_each(std::execution::par, v.begin(), v.end(), mutate);
auto total = std::reduce(std::execution::par, v.begin(), v.end(), 0.0);
auto dot = std::transform_reduce(std::execution::par, a.begin(), a.end(),
                                 b.begin(), 0.0);          // fused map-reduce
std::inclusive_scan(std::execution::par, in.begin(), in.end(), out.begin());

// std::ranges::sort(std::execution::par, v);   // ill-formed: ranges take NO policy
// std::accumulate has NO policy overload — use std::reduce.
```

| Policy | Threads | Invocations interleave | May call a mutex |
|---|---|---|---|
| `seq` | 1 (caller) | no | yes |
| `unseq` (C++20) | 1 (caller) | yes, within the thread | **no** |
| `par` | many | no, each is sequenced | yes (must be race-free) |
| `par_unseq` | many | yes | **no** |

| Type trait / check | Meaning |
|---|---|
| `std::is_execution_policy_v<P>` | `P` is a policy type |
| `__cpp_lib_execution` | feature-test macro for policies |
| `__cpp_lib_parallel_algorithm` | policy overloads of the algorithms |
| libstdc++ backend | needs Intel TBB linked (`-ltbb`) or it silently runs `seq` |

```cpp
// ---- the four canonical parallel bugs -----------------------------------
long count = 0;
std::for_each(std::execution::par, v.begin(), v.end(),
              [&](int x){ if (pred(x)) ++count; });      // DATA RACE

std::atomic<long> acount{0};
std::for_each(std::execution::par, v.begin(), v.end(),
              [&](int x){ if (pred(x)) ++acount; });     // race-free, no scaling

std::mutex m;
std::for_each(std::execution::par_unseq, v.begin(), v.end(),
              [&](int x){ std::scoped_lock lk{m}; sink(x); });  // UB: unseq + lock

std::for_each(std::execution::par, v.begin(), v.end(),
              [](int x){ if (bad(x)) throw Err{}; });    // std::terminate()
```

```cpp
// ---- correct shapes -----------------------------------------------------
auto n = std::count_if(std::execution::par, v.begin(), v.end(), pred);  // reduction
auto s = std::transform_reduce(std::execution::par, v.begin(), v.end(),
                               0.0, std::plus{}, expensive_pure);       // map-reduce
```

- Parallel is *permission*, not a promise: an implementation may run everything sequentially.
- `reduce`/`transform_reduce`/`*_scan` require an **associative and commutative** binary op; `accumulate` does not, which is why it has no policy.
- Floating-point `reduce` results are non-deterministic across runs because grouping is unspecified.
- Element access from the user callable must be race-free; forward iterators are required (`par` needs `forward_iterator` at minimum).
- Exceptions: any user callable throwing under a policy ⇒ `std::terminate`; allocation failure inside the algorithm may throw `std::bad_alloc`.
- Scheduling, partitioning, false sharing, NUMA, and oversubscription dominate below roughly 10⁴–10⁵ elements.
- Parallel algorithms are the wrong default for a latency-critical per-message path; they suit offline batch work with an explicit thread budget.

**Interview line** — "An execution policy grants permission to reorder and interleave; it does not promise threads, speedup, or exception propagation."

**Traps** — `par` with a lambda capturing by reference into shared state is the most common race in review · `unseq` forbids anything vectorization-unsafe: locks, allocation, I/O, or dependence between invocations · policy overloads may silently fall back to serial when the backend is missing · sorting with a policy still needs the same strict weak ordering.

---

## 19.6 Range concepts, views, adaptors, and lazy evaluation

```cpp
#include <ranges>
namespace rv = std::views;
namespace rg = std::ranges;

template<rg::input_range R>
requires std::integral<rg::range_value_t<R>>
std::int64_t sum(R&& r) {
    std::int64_t t = 0;
    for (auto x : r) t += x;
    return t;
}
```

| Range concept (`std::ranges::`) | Meaning |
|---|---|
| `range<R>` | `begin(r)`/`end(r)` valid |
| `borrowed_range<R>` | iterators stay valid after the range object dies |
| `sized_range<R>` | `ranges::size(r)` is O(1) |
| `view<R>` | `range` + `movable` + O(1) move/destroy/copy (enable_view) |
| `input_range` … `contiguous_range` | iterator meets the matching iterator concept |
| `common_range<R>` | `iterator_t<R>` and `sentinel_t<R>` are the same type |
| `viewable_range<R>` | can be turned into a view by `views::all` |
| `constant_range<R>` | C++23: elements are read-only |
| `output_range<R,T>` | writable through |

| Range alias | Yields |
|---|---|
| `ranges::iterator_t<R>` / `sentinel_t<R>` | iterator / sentinel type |
| `ranges::range_value_t<R>` | element value type |
| `ranges::range_reference_t<R>` | `decltype(*begin(r))` |
| `ranges::range_difference_t<R>` / `range_size_t<R>` | difference / size type |
| `ranges::range_rvalue_reference_t<R>` | `iter_move` result |
| `ranges::borrowed_iterator_t<R>` / `borrowed_subrange_t<R>` | iterator or `dangling` |

**Index — `std::views::` adaptors and factories**

| View | Kind | Since | Cost / notes |
|---|---|---|---|
| `views::all(r)` | adaptor | C++20 | `ref_view` for lvalue, `owning_view` for rvalue |
| `views::all_t<R>` | alias | C++20 | the type `all` would produce |
| `views::counted(it, n)` | factory | C++20 | `subrange` or `counted_iterator` pair |
| `views::empty<T>` | factory | C++20 | zero elements of `T` |
| `views::single(v)` | factory | C++20 | exactly one element, owns it |
| `views::iota(a)` / `iota(a, b)` | factory | C++20 | unbounded / bounded increasing sequence |
| `views::repeat(v)` / `repeat(v, n)` | factory | **C++23** | unbounded / bounded repetition |
| `views::istream<T>(is)` | factory | C++20 | input_range, single pass |
| `views::filter(pred)` | adaptor | C++20 | caches `begin()`; **not** a `const` range |
| `views::transform(f)` | adaptor | C++20 | reference is `invoke_result_t`, a prvalue proxy |
| `views::take(n)` | adaptor | C++20 | first `n` (fewer if shorter) |
| `views::take_while(pred)` | adaptor | C++20 | stops at first false; not `sized` |
| `views::drop(n)` | adaptor | C++20 | O(1) for random access, else O(n) on `begin` |
| `views::drop_while(pred)` | adaptor | C++20 | caches `begin()` |
| `views::join` | adaptor | C++20 | flattens a range of ranges one level |
| `views::join_with(delim)` | adaptor | **C++23** | flatten with separator |
| `views::split(delim)` | adaptor | C++20 | forward+; yields subranges, lazy |
| `views::lazy_split(delim)` | adaptor | C++20 | works on input ranges; weaker element type |
| `views::common` | adaptor | C++20 | makes a `common_range` for legacy algorithms |
| `views::reverse` | adaptor | C++20 | bidirectional+; O(1) |
| `views::elements<N>` | adaptor | C++20 | Nth element of each tuple-like |
| `views::keys` / `views::values` | adaptor | C++20 | `elements<0>` / `elements<1>` |
| `views::zip` | adaptor | **C++23** | tuple of parallel elements; stops at shortest |
| `views::zip_transform(f, rs…)` | adaptor | **C++23** | applies `f` to the zipped tuple |
| `views::adjacent<N>` | adaptor | **C++23** | overlapping N-tuples; forward+ |
| `views::pairwise` | adaptor | **C++23** | alias for `adjacent<2>` |
| `views::adjacent_transform<N>(f)` | adaptor | **C++23** | `f` over each sliding N-tuple |
| `views::pairwise_transform(f)` | adaptor | **C++23** | `adjacent_transform<2>` |
| `views::chunk(n)` | adaptor | **C++23** | non-overlapping blocks; `n > 0` |
| `views::chunk_by(pred)` | adaptor | **C++23** | new chunk when `pred(prev,cur)` is false |
| `views::slide(n)` | adaptor | **C++23** | overlapping windows of size `n` |
| `views::stride(n)` | adaptor | **C++23** | every `n`-th element; `n > 0` |
| `views::as_const` | adaptor | **C++23** | `constant_range` view |
| `views::as_rvalue` | adaptor | **C++23** | `*it` becomes an rvalue reference |
| `views::cartesian_product(rs…)` | adaptor | **C++23** | all tuples; size is the product |
| `views::enumerate` | adaptor | **C++23** | yields `{index, reference}` |
| `views::concat(rs…)` | adaptor | C++26 | appends ranges (check support) |
| `views::chunk_by` / `views::stride` deduction | — | — | all adaptors are CPOs, usable as `f(r)` or `r \| f` |

| Range type (not `views::`) | Notes |
|---|---|
| `ranges::subrange<I,S>` | iterator+sentinel pair as a view; borrowed |
| `ranges::ref_view<R>` | non-owning reference to an lvalue range |
| `ranges::owning_view<R>` | takes ownership of an rvalue range |
| `ranges::view_interface<D>` | CRTP base supplying `empty/size/front/back/operator[]` |
| `ranges::dangling` | placeholder result type |
| `ranges::elements_of` | C++23 tag for `co_yield` of a range in generators |
| `std::generator<T>` | C++23 coroutine `input_view` |

```cpp
// ---- pipeline: every composition form ----------------------------------
auto p1 = orders | rv::filter(&Order::active)
                 | rv::transform(&Order::price)
                 | rv::take(10);
auto p2 = rv::take(rv::transform(rv::filter(orders, act), prj), 10);  // nested calls
auto adaptor = rv::filter(act) | rv::take(10);   // composed adaptor, no range yet
auto p3 = orders | adaptor;                      // apply later
for (auto price : p1) consume(price);            // work happens HERE
```

```cpp
// ---- lazy means re-evaluated ---------------------------------------------
int calls = 0;
auto v2 = v | rv::transform([&](int x){ ++calls; return heavy(x); });
auto a = rg::count_if(v2, pos);   // heavy() runs once per element
auto b = rg::count_if(v2, pos);   // heavy() runs AGAIN — calls doubled
auto snapshot = v2 | rg::to<std::vector>();   // C++23: pay once, own the result
```

```cpp
// ---- factories and infinite ranges --------------------------------------
for (int i : rv::iota(0, 10)) {}                       // 0..9
auto evens = rv::iota(0) | rv::filter([](int i){ return i % 2 == 0; })
                         | rv::take(5);                // infinite, bounded by take
auto tenzeros = rv::repeat(0, 10);                     // C++23
auto forever  = rv::repeat(std::string("x"));          // C++23, MUST be bounded
for (auto [i, o] : orders | rv::enumerate) {}          // C++23 index + element
```

```cpp
// ---- const-correctness of views ------------------------------------------
auto f = v | rv::filter(pred);
// rg::begin(std::as_const(f));   // ill-formed: filter_view::begin is non-const
auto t = v | rv::transform(fn);   // transform_view IS const-iterable if fn is
// views are cheap to copy but a COPY IS NOT A SNAPSHOT: it re-runs the pipeline.
```

- A view is `movable`, cheap to copy/destroy, and models `range`; it composes traversal, not storage.
- `filter_view`, `drop_while_view`, `split_view`, `chunk_by_view`, and `reverse_view` (on non-common ranges) cache `begin()`; the first call is O(n).
- A view over a single-pass source stays single-pass; consuming it twice yields nothing the second time.
- `views::transform` never gives you an lvalue back — you cannot write through it unless the callable returns a reference.
- Adaptors are function objects (CPOs); `r | a | b` is `b(a(r))`.
- `views::split` on a `string` yields subranges of `char`, not `string_view` — construct explicitly (`std::string_view(sub)` works in C++23).

**Traps** — mutating the source during pipeline traversal invalidates the whole chain · `filter` + `transform` order matters for both cost and correctness (`transform` first means filtering on transformed values) · `views::drop` on a non-sized non-random-access range is O(n) *every* `begin()` unless cached · `zip` silently truncates to the shortest input · an unbounded `iota`/`repeat` fed to an eager algorithm never returns.

---

## 19.7 Dangling views, borrowed ranges, and `views::all`

```cpp
// ---- views::all dispatch -------------------------------------------------
std::vector<int> v{1, 2, 3};
auto a = rv::all(v);                       // ref_view<vector<int>>  — borrows
auto b = rv::all(std::vector{1, 2, 3});    // owning_view<vector<int>> — MOVES in
auto c = rv::all(std::span{v});            // the view itself, unchanged
auto d = rv::all(std::string_view{"hi"});  // already a view, copied
static_assert(std::same_as<rv::all_t<std::vector<int>&>,
                           rg::ref_view<std::vector<int>>>);
```

```text
lvalue viewable range   → ref_view    (holds a pointer; source must outlive it)
rvalue that is a view   → the view itself (copied/moved)
rvalue owning range     → owning_view (moves the container INTO the pipeline)
```

```cpp
// ---- the classic dangle --------------------------------------------------
auto bad() {
    std::vector<int> local{1, 2, 3};
    return local | rv::filter([](int x){ return x > 1; });   // ref_view of local
}                                        // local destroyed → returned view dangles

auto ok1() {                             // own the data inside the pipeline
    return std::vector{1, 2, 3} | rv::filter([](int x){ return x > 1; });
}                                        // owning_view moved the vector in
auto ok2() {                             // or materialize
    std::vector<int> local{1, 2, 3};
    return local | rv::filter(pos) | rg::to<std::vector>();  // C++23
}
```

```cpp
// ---- borrowed_range and ranges::dangling ---------------------------------
auto r1 = rg::find(std::vector{1, 2, 3}, 2);
static_assert(std::same_as<decltype(r1), rg::dangling>);   // compile-time guard
// *r1;                                    // ill-formed — cannot misuse it

int raw[]{1, 2, 3};
auto r2 = rg::find(std::span{raw}, 2);      // span IS borrowed → real iterator
auto r3 = rg::find(std::string_view{"abc"}, 'b');          // borrowed
std::vector<int> keep{1, 2, 3};
auto r4 = rg::find(keep, 2);                // lvalue → real iterator

static_assert(rg::borrowed_range<std::span<int>>);
static_assert(rg::borrowed_range<std::string_view>);
static_assert(rg::borrowed_range<rg::subrange<int*>>);
static_assert(rg::borrowed_range<std::vector<int>&>);      // lvalue ref: yes
static_assert(!rg::borrowed_range<std::vector<int>>);      // rvalue: no

// opt a custom view in:
template<> inline constexpr bool
std::ranges::enable_borrowed_range<MyView> = true;
template<> inline constexpr bool
std::ranges::enable_view<MyRange> = true;                  // opt into `view`
```

| Type | `borrowed_range` | Why |
|---|---|---|
| `std::vector<T>&` (lvalue) | yes | lvalue references always borrow |
| `std::vector<T>` (rvalue) | **no** | owns its heap block, which dies with it |
| `std::span<T>` | yes | non-owning pointer + extent |
| `std::string_view` | yes | non-owning |
| `std::ranges::subrange` | yes | pair of iterators |
| `std::ranges::ref_view` | yes | pointer to the source |
| `std::ranges::owning_view` | **no** | it owns the container |
| `std::ranges::iota_view` | yes | generates values, stores nothing external |
| `std::ranges::empty_view` | yes | nothing to dangle |
| `std::ranges::repeat_view` | no | holds the value |

- `borrowed_range` says iterators outlive the **range object**, never that the backing storage lives longer.
- `ranges::dangling` is a compile-time trap door: passing an rvalue non-borrowed range to `find`/`min_element`/`remove_if` returns something unusable rather than a stale iterator.
- `owning_view` moves the container in — the pipeline is then safe to return but the source variable is gutted.
- A view holding a lambda by value can still capture references that dangle; `dangling` only guards the *range*, not the callables.

**Interview line** — "`ranges::dangling` converts a lifetime bug into a compile error for the range argument; `borrowed_range` is the opt-in that says my iterators do not point into me."

**Traps** — `auto x = get_vector() | views::filter(p);` is fine (owning_view) but `auto& r = get_vector(); auto x = r | views::filter(p);` after `r` dies is not · returning `views::all(local)` dangles exactly like returning `&local` · `enable_borrowed_range` is a promise the compiler cannot verify.

---

## 19.8 C++23 `ranges::to`, zip-family views, chunk, slide, stride, and repeat

```cpp
// ---- ranges::to: every form ---------------------------------------------
auto v1 = rng | rg::to<std::vector>();                 // deduce element type
auto v2 = rg::to<std::vector<int>>(rng);               // explicit, call form
auto v3 = rng | rg::to<std::vector<int>>();            // explicit, pipe form
auto v4 = rng | rg::to<std::vector>(alloc);            // extra ctor args forwarded
auto s1 = rng | rg::to<std::set>();
auto m1 = pairs | rg::to<std::map<int, std::string>>();
auto st = chars | rg::to<std::string>();
auto nested = mat | rv::transform([](auto row){ return row | rg::to<std::vector>(); })
                  | rg::to<std::vector>();             // recursive materialization
// Strategy order: (1) C(rng, args...) if constructible, (2) C(from_range, rng, ...),
// (3) C(begin, end, ...), (4) default-construct + reserve if sized + insert/push_back.
```

```cpp
// ---- zip family ---------------------------------------------------------
std::vector<double> px{1.5, 2.5, 3.5};
std::vector<int>    qty{10, 20};
for (auto [p, q] : rv::zip(px, qty)) { }               // 2 iterations — SHORTEST wins
auto notional = rv::zip_transform(std::multiplies{}, px, qty);  // lazy products
for (auto&& [p, q] : rv::zip(px, qty)) p *= 2.0;       // writes THROUGH to px

// zip yields std::tuple<double&, int&> — a proxy reference, not an owning tuple
static_assert(std::same_as<rg::range_reference_t<decltype(rv::zip(px, qty))>,
                           std::tuple<double&, int&>>);
```

```cpp
// ---- adjacent / sliding windows -----------------------------------------
for (auto [a, b] : px | rv::adjacent<2>) { }           // tuple<double&,double&>
for (auto [a, b] : px | rv::pairwise) { }              // same thing
auto deltas = px | rv::pairwise_transform(std::minus{});          // b - a? -> f(a,b)
auto mids   = px | rv::adjacent_transform<3>([](auto a, auto b, auto c){
                       return (a + b + c) / 3.0; });   // rolling 3-bar mean

for (auto win : px | rv::slide(3)) { for (double x : win) {} }    // a RANGE per window
// adjacent<N>: tuple of N, N is a compile-time constant, forward_range required
// slide(n):    subrange of n, n is a runtime value
// both yield max(size - n + 1, 0) windows
```

```cpp
// ---- chunk / chunk_by / stride ------------------------------------------
for (auto blk : rv::iota(0, 10) | rv::chunk(3)) { }    // {0,1,2}{3,4,5}{6,7,8}{9}
auto runs = ticks | rv::chunk_by([](auto const& a, auto const& b){
                        return a.symbol == b.symbol; });  // split when pred false
for (int x : rv::iota(0, 10) | rv::stride(3)) { }      // 0,3,6,9
// chunk on an input_range yields single-pass inner ranges consumed in order.
```

```cpp
// ---- repeat / cartesian_product / enumerate / as_rvalue / as_const ------
auto zeros = rv::repeat(0.0, 64);                       // bounded
auto inf   = rv::repeat(std::string("tick")) | rv::take(3);   // bound it!
for (auto [a, b] : rv::cartesian_product(strikes, expiries)) { }
for (auto [i, o] : orders | rv::enumerate) { }          // i is range_difference_t
auto moved = src | rv::as_rvalue | rg::to<std::vector>();   // moves elements out
auto ro    = v | rv::as_const;                          // constant_range
auto flat  = words | rv::join_with(',');                // "a,b,c"
```

| C++23 view | Yields | Precondition | Size |
|---|---|---|---|
| `zip` | `tuple<Refs...>` | — | min of inputs |
| `zip_transform` | `invoke_result` | callable on all refs | min of inputs |
| `adjacent<N>` | `tuple<Ref×N>` | `forward_range`, N > 0 | max(size−N+1, 0) |
| `adjacent_transform<N>` | `invoke_result` | as above | as above |
| `chunk(n)` | subrange / inner view | `n > 0` | ⌈size/n⌉ |
| `chunk_by(pred)` | subrange | `forward_range` | data-dependent |
| `slide(n)` | subrange | `forward_range`, `n > 0` | max(size−n+1, 0) |
| `stride(n)` | element | `n > 0` | ⌈size/n⌉ |
| `repeat(v[, n])` | `const T&` | bounded form needs `n ≥ 0` | `n` or infinite |
| `cartesian_product(rs…)` | `tuple<Refs...>` | all but first `forward_range` | product |
| `enumerate` | `tuple<difference_type, Ref>` | — | same as source |
| `as_rvalue` | rvalue reference | — | same |
| `as_const` | const reference | — | same |
| `join_with(d)` | flattened elements | inner ranges + delimiter | data-dependent |

```cpp
// ---- feature-test macros: library support genuinely lags ----------------
#if __cpp_lib_ranges_zip     >= 202110L   // zip, zip_transform, adjacent
#if __cpp_lib_ranges_chunk   >= 202202L
#if __cpp_lib_ranges_slide   >= 202202L
#if __cpp_lib_ranges_stride  >= 202207L
#if __cpp_lib_ranges_repeat  >= 202207L
#if __cpp_lib_ranges_to_container >= 202202L
#if __cpp_lib_ranges_enumerate    >= 202302L
#if __cpp_lib_ranges_cartesian_product >= 202207L
#if __cpp_lib_ranges_as_rvalue    >= 202207L
#if __cpp_lib_ranges_join_with    >= 202202L
#if __cpp_lib_ranges_fold          >= 202207L
```

**Traps** — `zip` truncation is silent, so a length mismatch becomes lost data, not an error · `adjacent<N>` needs `N` as a template argument, `slide(n)` takes it at runtime — mixing them up is a compile error worth recognizing instantly · `chunk` on an input range gives inner ranges valid only until the outer iterator advances · `ranges::to` does not guarantee one allocation, and `reserve` only happens for `sized_range` sources · `views::repeat` unbounded into `ranges::to` hangs forever · `as_rvalue` leaves the source elements moved-from.

---

## 19.9 C++23 range folds and range-aware container operations

```cpp
#include <algorithm>   // fold_* live in <algorithm>, not <numeric>
#include <functional>

std::vector<double> px{1.5, 2.5, 3.5};

auto s1 = rg::fold_left(px, 0.0, std::plus{});                 // double, init needed
auto s2 = rg::fold_left(px.begin(), px.end(), 0.0, std::plus{});
auto s3 = rg::fold_left_first(px, std::plus{});                // optional<double>
auto s4 = rg::fold_right(px, 0.0, std::plus{});                // right-associative
auto s5 = rg::fold_right_last(px, std::plus{});                // optional<double>
auto s6 = rg::fold_left_with_iter(px, 0.0, std::plus{});       // {.in, .value}
auto s7 = rg::fold_left_first_with_iter(px, std::plus{});      // {.in, .value(optional)}
auto s8 = rg::fold_left(orders, std::int64_t{0},
                        [](std::int64_t acc, Order const& o){ return acc + o.qty; });
if (s3) use(*s3);                                              // empty range → nullopt
```

```text
fold_left  [a,b,c], init z:  ((z op a) op b) op c
fold_right [a,b,c], init z:  a op (b op (c op z))
fold_left_first  [a,b,c]:    (a op b) op c        , empty → nullopt
fold_right_last  [a,b,c]:    a op (b op c)        , empty → nullopt
```

| Fold | Init | Empty range | Return |
|---|---|---|---|
| `fold_left(r, init, f)` | required | `init` | `T` |
| `fold_left_first(r, f)` | none | `nullopt` | `optional<T>` |
| `fold_right(r, init, f)` | required | `init` | `T` |
| `fold_right_last(r, f)` | none | `nullopt` | `optional<T>` |
| `fold_left_with_iter(r, init, f)` | required | `{end, init}` | `in_value_result` |
| `fold_left_first_with_iter(r, f)` | none | `{end, nullopt}` | `in_value_result` |

- Folds accept `input_range`; `fold_right` additionally needs `bidirectional_range` + `common_range` (or a sized/random-access source).
- The accumulator type is deduced from the init, not from the element — `fold_left(px, 0, std::plus{})` accumulates in `int` and truncates.
- `fold_left` is the ranges-native replacement for `accumulate`; it is sequential and does **not** reassociate, so FP results are deterministic.
- `f` must be callable as `f(acc, elem)` for left folds and `f(elem, acc)` for right folds — the argument order flips.
- Folds take no projection parameter; project by piping through `views::transform` first.

```cpp
// ---- fold vs accumulate vs reduce ---------------------------------------
auto a = std::accumulate(px.begin(), px.end(), 0.0);           // sequential left
auto b = std::reduce(px.begin(), px.end(), 0.0);               // may reassociate
auto c = rg::fold_left(px, 0.0, std::plus{});                  // sequential left
// a == c exactly; b may differ in the last FP bits.
```

```cpp
// ---- C++23 range-aware container operations ------------------------------
std::vector<int> v(std::from_range, src);        // tagged range constructor
v.assign_range(src);                             // replace contents
v.append_range(tail);                            // append
v.insert_range(v.begin() + 2, middle);           // insert at position
std::deque<int> d; d.prepend_range(head);        // deque/list/forward_list
std::set<int> s(std::from_range, src);           // associative too
s.insert_range(more);
std::unordered_map<int,int> um(std::from_range, kv_pairs);
std::string str(std::from_range, chars);
std::queue<int> q(std::from_range, src);         // adapters: push_range
q.push_range(more);
std::priority_queue<int> pq(std::from_range, src);   // O(n) heapify
auto out = src | rv::transform(f) | rg::to<std::vector>();
auto ii = rg::iota(v, 0);                        // C++23 ranges::iota → {out, value}
```

| C++23 container operation | Applies to | Notes |
|---|---|---|
| `C(std::from_range, r[, args])` | all containers + adapters | uses cardinality when sized |
| `assign_range(r)` | sequence containers, `string` | replaces contents |
| `append_range(r)` | `vector`, `deque`, `list`, `string` | amortized like repeated append |
| `prepend_range(r)` | `deque`, `list`, `forward_list` | |
| `insert_range(pos, r)` | sequence containers | `insert_range_after` for `forward_list` |
| `insert_range(r)` | associative/unordered | no position |
| `push_range(r)` | `queue`, `stack`, `priority_queue` | `priority_queue` re-heapifies |
| `ranges::to<C>(r)` | any range → any container | see 19.8 |

**Traps** — `fold_left(v, 0, std::plus{})` over `double` silently truncates to `int` · `fold_right`'s callable takes `(elem, acc)`, the reverse of `fold_left` · a range that aliases the destination in `append_range`/`insert_range` has the same UB as a self-referencing `insert` · `from_range` does not change invalidation rules — a growing `vector` still invalidates everything.

---

## 19.10 Hand-written loops versus algorithms: optimization and readability

```cpp
// ---- algorithm: names one operation and its precondition -----------------
auto it = rg::find(orders, target_id, &Order::id);
if (it != orders.end()) fill(*it);

auto n = rg::count_if(orders, [](auto const& o){ return o.active; });
rg::sort(orders, std::greater{}, &Order::price);
auto pos = rg::lower_bound(levels, tick, {}, &Level::tick);   // sorted precondition
```

```cpp
// ---- loop: intertwined state, early exit, multiple outputs ---------------
struct Gap { std::uint64_t expected, got; };
std::optional<Gap> apply_batch(std::span<Event const> batch, std::uint64_t& expected) {
    for (auto const& e : batch) {
        if (e.sequence != expected) return Gap{expected, e.sequence};  // early exit
        apply(e);                                                      // side effect
        ++expected;                                                    // carried state
    }
    return std::nullopt;
}
// No algorithm names "scan while validating a monotonic counter and stop with a
// diagnosis"; expressing it as a pipeline hides the exit condition.
```

```cpp
// ---- one pass, two accumulators: a fold or a loop, not two algorithms ----
auto [sum, cnt] = rg::fold_left(px, std::pair{0.0, 0}, [](auto acc, double x){
    return std::pair{acc.first + x, acc.second + 1};                   // C++23
});
double total = 0; int count = 0;
for (double x : px) { total += x; ++count; }                           // equally clear
// rg::accumulate + rg::count would be TWO passes over the data.
```

```cpp
// ---- when the pipeline actually wins: fused, no temporaries -------------
auto vwap_num = rg::fold_left(rv::zip_transform(std::multiplies{}, px, qty),
                              0.0, std::plus{});     // no intermediate vector
// versus: transform into a temp vector, then accumulate → one extra allocation
```

| Situation | Prefer |
|---|---|
| Operation has a standard name (`find`, `sort`, `partition`) | algorithm |
| Precondition worth documenting in the call (sorted, partitioned, heap) | algorithm |
| Complexity guarantee is the point (`nth_element`, `lower_bound`) | algorithm |
| Parallel or vectorized execution wanted | algorithm + policy |
| Carried state across iterations with early exit | loop |
| Multiple outputs / error diagnosis per element | loop |
| Fused multi-step transform over a large range | view pipeline |
| Result needed more than once, or random access | pipeline + `ranges::to` |
| Hot path with a known layout and a measured budget | loop, then measure |

- Algorithms are not inherently faster: they communicate structure and let the implementation specialize (memmove for trivially copyable, insertion sort for small *n*).
- Views add abstraction layers that most optimizers flatten, but debug builds do not — measure with the flags you ship.
- `filter` + `transform` fuses into one pass; two separate algorithm calls are two passes over memory.
- A raw index loop over a `vector` is the easiest thing for a compiler to vectorize; an iterator loop over the same data is equally easy; a `filter_view` is not.
- Readability argument that actually holds: `rg::sort(v, {}, &Order::price)` states the key; a hand-rolled comparator does not.
- Correctness argument that always holds: an algorithm cannot get the loop bounds or the erase-invalidation wrong.

**Interview line** — "Reach for the algorithm when it names the operation and its precondition; reach for the loop when the loop body carries state the algorithm cannot express — and never claim the algorithm is faster without a measurement."

**Traps** — chasing a one-liner pipeline for logic with early exits produces slower and less readable code · `views` in a debug build can be 10× slower than the loop it replaced · `std::for_each` over a lambda with captured mutable state is a loop wearing a costume · counting on the optimizer to hoist a projection out of a comparator is not a plan.
