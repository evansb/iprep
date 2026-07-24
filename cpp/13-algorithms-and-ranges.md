# 13. Algorithms and Ranges

Standard algorithms separate what a computation does from how a container stores its elements. Their preconditions and complexity guarantees are part of the interface, not documentation trivia. Ranges add constrained whole-range calls, projections, and lazy pipelines while preserving the same underlying iterator model.

## The iterator model

An **iterator** is a pointer-like abstraction through which algorithms traverse containers. It supports some combination of dereference, increment, comparison, and movement; every standard container from Chapters 10–12 exposes iterators through `begin()` and `end()`.

Algorithms normally consume a **half-open range** written `[first, last)`: `first` is included and `last` is excluded.

```cpp
#include <cstdint>
#include <iostream>
#include <vector>

struct Price {
    std::int64_t ticks;
};

int main() {
    std::vector<Price> prices{{101}, {102}, {103}};

    auto first = prices.begin();
    auto last = prices.end();
    for (auto current = first; current != last; ++current) {
        std::cout << current->ticks << ' ';
    }
    std::cout << '\n';  // prints: 101 102 103
}
```

The half-open convention removes boundary special cases:

- An empty range has `first == last`.
- `last` can be the valid one-past position; it must never be dereferenced.
- `std::distance(first, last)` is the range length.
- Any iterator `middle` in the range splits it into `[first, middle)` and `[middle, last)`.

The two endpoints need not have the same type. A **sentinel** **(C++20)** marks the end and only needs to support comparison with the iterator.

```cpp
struct NullSentinel {};  // C++20

bool operator==(const char* current, NullSentinel) {
    return *current == '\0';
}

void sentinel_demo() {
    const char* text = "ITCH";
    auto found = std::ranges::find(text, NullSentinel{}, 'C');

    std::cout << *found << '\n';  // prints: C
}
```

The algorithm tests each character against `NullSentinel`; it does not first call `std::strlen` to construct an end pointer. `std::unreachable_sentinel` is available when some other condition guarantees that an iterator loop stops before an end comparison becomes necessary.

A sentinel is still part of the range contract. If comparison never becomes true and no earlier condition stops traversal, the iterator eventually leaves valid storage and dereference has undefined behavior.

Iterator categories form capability tiers:

| Category | Operations and guarantees | Example | Algorithms unlocked |
|---|---|---|---|
| input | `++`, read once | `std::istream_iterator` | `copy`, `find` |
| forward | multi-pass traversal | `std::forward_list` | `adjacent_find`, `partition` |
| bidirectional | forward plus `--` | `std::list`, `std::map` | reverse traversal |
| random access | `it + n`, `it[n]`, ordering | `std::deque` | `sort`, binary search |
| contiguous | `&*it` follows array layout | `std::vector`, `std::array`, `std::span` | contiguous-memory optimizations |

Every stronger category provides the weaker category's capabilities. `std::ranges::find` needs only input traversal; `std::ranges::sort` needs random access because it jumps within the range.

**Pitfall.** The endpoints of one iterator range must describe one valid sequence. Combining `first` from one `std::vector` with `last` from another violates the algorithm's range precondition and has undefined behavior.

Iterator validity remains the container's responsibility. An algorithm does not insulate an iterator from the invalidation rules in Chapters 10 and 11; mutating the traversed container from a predicate is therefore usually invalid as well as difficult to reason about.

## Predicates, comparators, and projections

A **predicate** is a callable whose result can be tested as `bool`. Unary predicates classify one element for algorithms such as `find_if`; binary predicates compare two values.

```cpp
struct Order {
    std::int64_t price_ticks;
    std::int64_t quantity;
};

void find_large_order(const std::vector<Order>& orders) {
    auto large = std::ranges::find_if(orders, [](const Order& order) {
        return order.quantity >= 1'000;
    });

    if (large != orders.end()) {
        std::cout << large->price_ticks << '\n';
    }
}
```

A sorting comparator must impose a **strict weak ordering**. That contract has four practical properties:

- Irreflexive: `compare(a, a)` is `false`.
- Asymmetric: if `compare(a, b)` is `true`, `compare(b, a)` is `false`.
- Transitive: `a < b` and `b < c` imply `a < c`.
- Transitive incomparability: equivalence induced by neither value preceding the other is transitive.

Use `<`, not `<=`, in an ascending comparator:

```cpp
void comparator_demo(std::vector<Order>& orders) {
    std::ranges::sort(orders, [](const Order& lhs, const Order& rhs) {
        return lhs.price_ticks < rhs.price_ticks;
    });
}

void broken_comparator(std::vector<Order>& orders) {
    std::ranges::sort(orders, [](const Order& lhs, const Order& rhs) {
        return lhs.price_ticks <= rhs.price_ticks;  // undefined behavior
    });
}
```

The second comparator violates irreflexivity. The precondition failure gives `std::ranges::sort` undefined behavior; real manifestations include a wrong order, an infinite loop, or an out-of-bounds access inside a library implementation.

Strict weak ordering permits equivalent but unequal values. Two orders at the same price are equivalent under a price comparator because neither precedes the other. `sort` may reorder that equivalence class, while `stable_sort` preserves its prior order.

A **projection** **(C++20)** maps an element to the value an algorithm should compare. Range algorithms apply the projection before their predicate or comparator:

```cpp
void projection_demo(std::vector<Order>& orders) {
    std::ranges::sort(orders, {}, &Order::price_ticks);  // C++20 projection

    auto largest = std::ranges::max_element(
        orders, {}, &Order::quantity);

    if (largest != orders.end()) {
        std::cout << largest->quantity << '\n';
    }
}
```

The `{}` selects the default `std::ranges::less` comparator. A pointer to data member projects each `Order` to the named field, removing a boilerplate lambda and making the compared key explicit.

**Rule.** Prefer a range algorithm with a projection for member-key operations. Keep predicates cheap and free of side effects; algorithms may copy them and need not call them in an order useful to application state.

A comparator that chooses different keys in different branches can be non-transitive even if every branch uses `<`. Test the ordering properties, not just representative output.

## The contract: preconditions and complexity

Every algorithm has semantic preconditions. The library generally does not check them, and violation is often undefined behavior rather than an exception.

```cpp
void search_contract_demo() {
    std::vector<int> values{1, 9, 3, 7};

    // bool present = std::ranges::binary_search(values, 3);
    // undefined behavior: values is not partitioned for the search

    std::ranges::sort(values);
    bool present = std::ranges::binary_search(values, 3);
    std::cout << std::boolalpha << present << '\n';  // prints: true
}
```

“Partitioned for this search” is the precise requirement; a range sorted with the same ordering satisfies it. A successful result on one unsorted input does not make the call valid.

| Call | Required condition | Typical manifestation when violated |
|---|---|---|
| `lower_bound`, `binary_search` | partitioned for comparator and key | wrong result or undefined behavior |
| `sort` | strict weak ordering | crash, hang, corrupted traversal |
| `[first, last)` algorithm | valid range in one sequence | invalid memory access |
| `copy` | destination start not inside source range | overwritten source; undefined behavior |
| `partition_point` | already partitioned | wrong boundary or undefined behavior |
| `unique` expecting global deduplication | equal values adjacent | logic bug, not undefined behavior |

Use `copy_backward` when shifting a range right into overlapping storage. `std::unique` only coalesces adjacent equivalent elements, so sort first when global deduplication is the intended operation.

Complexity is part of the standard contract:

| Algorithm family | Guarantee | Important qualification |
|---|---|---|
| `sort` | `O(N log N)` comparisons, worst case | unstable |
| `stable_sort` | `O(N log N)` with buffer; up to `O(N log² N)` otherwise | may allocate |
| `nth_element` | `O(N)` comparisons on average | tail remains unsorted |
| `partial_sort` | approximately `O(N log K)` | sorts first `K` |
| `lower_bound`, `upper_bound`, `equal_range` | `O(log N)` comparisons | up to `O(N)` iterator steps without random access |
| `find`, `count`, `partition` | `O(N)` | predicate dominates inner loop |
| `rotate` | `O(N)` swaps or moves | no allocation required |

The comparison/step distinction matters for a `std::list`: `lower_bound` performs logarithmically many comparisons but advances a non-random-access iterator linearly overall. A sorted `std::vector` gets both logarithmic comparisons and constant-time jumps.

Complexity guarantees count abstract operations, not elapsed time. Two `O(N log N)` sorts can differ materially when one comparator reads a compact integer and the other chases pointers or performs string collation. Choose the right algorithm first, then keep its repeated operation cheap.

**Pitfall.** Precondition bugs often survive debug tests and appear under optimization or larger inputs. “It returned the expected answer once” is not evidence that the call is defined.

## Sorting, selection, and partial sorting

`std::sort` and `std::ranges::sort` are unstable: equivalent elements may change relative order. Implementations commonly use introsort, combining quicksort-style partitioning with a worst-case fallback.

`stable_sort` preserves the relative order of equivalent elements. That matters when orders were already in arrival order and sorting by price must retain time priority within each price.

Selection avoids ordering data the caller will not inspect:

- `nth_element` places the selected element where a full sort would put it and partitions values around it.
- `partial_sort` orders only the requested prefix, commonly using a heap of size `K`.
- `is_sorted` checks an ordering assumption before a later operation relies on it.

The three approaches to selecting the ten highest-priced orders have different contracts:

```cpp
std::vector<Order> full_sort_top_ten(const std::vector<Order>& input) {
    auto orders = input;
    std::ranges::sort(
        orders, std::ranges::greater{}, &Order::price_ticks);
    orders.resize(10);
    return orders;  // O(N log N): orders every element
}

std::vector<Order> nth_top_ten(const std::vector<Order>& input) {
    auto orders = input;
    auto middle = orders.begin() + 10;
    std::ranges::nth_element(
        orders, middle, std::ranges::greater{}, &Order::price_ticks);
    std::ranges::sort(
        orders.begin(), middle,
        std::ranges::greater{}, &Order::price_ticks);
    orders.erase(middle, orders.end());
    return orders;  // average O(N), then sorts ten
}

std::vector<Order> partial_top_ten(const std::vector<Order>& input) {
    auto orders = input;
    auto middle = orders.begin() + 10;
    std::ranges::partial_sort(
        orders, middle,
        std::ranges::greater{}, &Order::price_ticks);
    orders.erase(middle, orders.end());
    return orders;  // approximately O(N log 10)
}
```

These functions require at least ten input elements. With one million inputs, full sort establishes an order among all elements even though the caller reads only ten. `nth_element` minimizes selection work and then sorts the chosen prefix; `partial_sort` directly maintains a sorted prefix.

`nth_element` guarantees partitioning, not order, on either side of its selected position. Reading its tail as though it were sorted is a logic bug.

Choose based on the output contract:

| Required result | Algorithm |
|---|---|
| every element ordered | `sort` |
| every element ordered; equal keys stable | `stable_sort` |
| element at rank `K`; partitions sufficient | `nth_element` |
| sorted best `K` only | `partial_sort` |

**Interview.** For a top-`K` question, ask whether the best `K` must themselves be sorted. Use `nth_element` for selection plus a small prefix sort, or `partial_sort` when a sorted prefix is the direct deliverable.

**Note.** `stable_sort` may allocate a temporary buffer. Its stability contract can therefore introduce a heap operation into code that otherwise looks like pure comparison and movement.

## Binary search on sorted data

Binary-search algorithms are the lookup half of the flat-container pattern from Chapter 11. They work especially well on sorted contiguous storage.

| Algorithm | Result |
|---|---|
| `lower_bound` | first element not less than the key |
| `upper_bound` | first element greater than the key |
| `equal_range` | half-open pair of both boundaries |
| `binary_search` | whether an equivalent element exists |

The iterator is usually more useful than a Boolean because it identifies the element or insertion position:

```cpp
void binary_search_demo(std::vector<Order>& orders,
                        std::int64_t target_price) {
    std::ranges::sort(orders, {}, &Order::price_ticks);

    auto first_at_or_above = std::ranges::lower_bound(
        orders, target_price, {}, &Order::price_ticks);

    auto matches = std::ranges::equal_range(
        orders, target_price, {}, &Order::price_ticks);

    std::cout << std::ranges::distance(matches) << '\n';
    // matches is the half-open range [first equal, first greater)

    Order incoming{target_price, 100};
    orders.insert(first_at_or_above, incoming);
}
```

Insertion invalidates iterators according to the `std::vector` rules from Chapter 10, so do not use `first_at_or_above` afterward. The resulting vector remains sorted because insertion occurs at the lower bound.

For duplicate keys, `[lower_bound(key), upper_bound(key))` contains exactly the equivalent run. `equal_range` computes both boundaries under one interface, which makes the half-open result directly usable by another algorithm.

Repeated `lower_bound` plus `vector::insert` still shifts a suffix on every insertion. For a batch, appending all new values and sorting once can do less total movement while producing the same final ordering.

The classic iterator API can require a heterogeneous comparator that accepts both `(element, key)` and `(key, element)` argument orders, depending on the operation. A range call with a projection compares projected keys and avoids that asymmetric overload set.

## Partitioning

Partitioning groups elements by a Boolean property without fully sorting either group. `partition` may reorder freely; `stable_partition` retains original order within both groups and may allocate a buffer.

```cpp
struct WorkingOrder {
    std::int64_t id;
    bool active;
};

void partition_demo(std::vector<WorkingOrder>& orders) {
    auto cancelled = std::ranges::partition(
        orders, &WorkingOrder::active);
    auto partition = cancelled.begin();

    for (auto current = orders.begin(); current != partition; ++current) {
        std::cout << current->id << ' ';
    }
    std::cout << '\n';

    auto rediscovered = std::ranges::partition_point(
        orders, &WorkingOrder::active);
    std::cout << (rediscovered == partition) << '\n';  // prints: 1
}
```

The returned subrange is `[partition_point, end)`, so its beginning marks the first cancelled order. `partition_point` finds that boundary later in logarithmically many predicate applications, but only because the range is already partitioned for the same predicate.

The partition point is an ordinary iterator and composes with half-open algorithms. For example, `std::ranges::sort(orders.begin(), partition, comparator)` sorts only active orders after the single partitioning pass.

**Pitfall.** Partitioning is not sorting. Active and cancelled orders each appear in unspecified internal order after `partition`; use `stable_partition` only when preserving those orders justifies its additional work and possible allocation.

## Transformation and accumulation

`transform` maps input elements into an output range. The destination must have enough existing space, or use an inserter that grows a container:

```cpp
void transform_demo(const std::vector<Order>& orders) {
    std::vector<std::int64_t> quantities;
    quantities.reserve(orders.size());

    std::ranges::transform(
        orders,
        std::back_inserter(quantities),
        &Order::quantity);

    std::cout << quantities.size() << '\n';
}
```

The `reserve` prevents `back_inserter` from triggering repeated growth as Chapter 10 described.

Unary `transform` may write back to the same positions it reads, enabling in-place mapping. Arbitrary partial overlap is not a general guarantee; choose an output range whose writes cannot destroy unread inputs.

`std::accumulate` performs a left fold in iterator order. Its initial value determines both the accumulator type and the result type:

```cpp
void accumulator_type_demo() {
    std::vector<double> values{1.1, 1.2, 0.4};

    auto truncated = std::accumulate(values.begin(), values.end(), 0);
    auto precise = std::accumulate(values.begin(), values.end(), 0.0);

    std::cout << truncated << '\n';  // prints: 2
    std::cout << precise << '\n';    // prints: 2.7
}
```

With `0`, every partial result converts back to `int` before the next addition. The fix is not a cast at the end; choose an initial value of the intended accumulator type.

`std::reduce` **(C++17)** also combines values but may regroup operations, enabling parallel or vectorized evaluation. Its operation must tolerate that reordering. Integer addition without overflow is associative; floating-point addition is not, so regrouping can change rounded results.

The reduction operation must also accept values in the combinations permitted by its overload, not merely `(accumulator, element)`. `accumulate` has the simpler ordered fold contract when the types or operation are directional.

`inner_product` and its generalized cousin `transform_reduce` **(C++17)** express a dot-product shape. Order-book notional is a transformed reduction:

```cpp
std::int64_t total_notional(const std::vector<Order>& orders) {
    return std::transform_reduce(
        orders.begin(),
        orders.end(),
        std::int64_t{0},
        std::plus<>{},
        [](const Order& order) {
            return order.price_ticks * order.quantity;
        });  // C++17
}
```

The multiplication and sum must fit in `std::int64_t`; signed overflow would be undefined behavior. A production notional calculation chooses units and range checks from its domain contract.

**Rule.** Use `accumulate` when deterministic left-to-right grouping matters. Use `reduce` or `transform_reduce` only when the operation's algebra and reproducibility requirements permit regrouping.

## Heap, merge, set, and compaction algorithms

Several standard algorithm families are easy to reimplement accidentally. Their range preconditions and output shapes are the useful part to remember.

| Need | Algorithms | Required input shape | Result shape |
|---|---|---|---|
| Repeated access to one extreme | `make_heap`, `push_heap`, `pop_heap`, `sort_heap` | random-access range | heap in the same storage |
| Combine two sorted streams | `merge` | both inputs sorted compatibly | sorted output containing both |
| Set union, intersection, or difference | `set_union`, `set_intersection`, `set_difference` | both inputs sorted compatibly | sorted mathematical set operation |
| Remove values while preserving a container | `remove`, `remove_if` plus container `erase` | writable range | retained prefix plus unspecified tail |
| Coalesce adjacent duplicates | `unique` plus container `erase` | equivalent values adjacent | unique prefix plus unspecified tail |

Heap algorithms expose the structure underneath `std::priority_queue` from Chapter 10 while leaving the vector available to the surrounding algorithm:

```cpp
#include <algorithm>
#include <vector>

struct Deadline {
    long timestamp_ns;
    int order_id;
};

auto later = [](const Deadline& left, const Deadline& right) {
    return left.timestamp_ns > right.timestamp_ns;
};

void expire(int order_id);

void process_deadlines(std::vector<Deadline>& heap, long now_ns) {
    std::ranges::make_heap(heap, later);

    while (!heap.empty() && heap.front().timestamp_ns <= now_ns) {
        std::ranges::pop_heap(heap, later);
        Deadline due = heap.back();
        heap.pop_back();
        expire(due.order_id);
    }
}
```

`pop_heap` moves the selected extreme to the end and restores the heap property in the preceding range; `vector::pop_back` then destroys it. Calling `pop_back` first would remove an arbitrary leaf rather than the selected deadline.

Sorted set algorithms are especially useful for reference-data deltas:

```cpp
std::vector<int> added_symbols() {
    std::vector<int> yesterday{1, 2, 4, 8};
    std::vector<int> today{2, 3, 4, 9};
    std::vector<int> added;

    std::ranges::set_difference(
        today, yesterday, std::back_inserter(added));
    return added; // {3, 9}
}
```

Both inputs must be sorted under the same ordering. Reserve the output when a useful bound is known; a set union can contain as many elements as both inputs combined.

Compaction algorithms move retained values to the front but cannot change a container's size. The container owns destruction, so erasure is a second operation:

```cpp
void compact_orders(std::vector<WorkingOrder>& orders) {
    auto [new_end, old_end] =
        std::ranges::remove_if(orders, [](const WorkingOrder& order) {
            return !order.active;
        });
    orders.erase(new_end, old_end);

    std::ranges::sort(orders, {}, &WorkingOrder::id);
    auto duplicate_tail =
        std::ranges::unique(orders, {}, &WorkingOrder::id);
    orders.erase(duplicate_tail.begin(), duplicate_tail.end());
}
```

`std::erase_if` packages the first pattern for standard containers. Sorting before `unique` makes equal IDs adjacent; without that preparation, only consecutive duplicates coalesce.

**Pitfall.** Heap and set algorithms trust their structural preconditions. Applying `push_heap` to a prefix that was not already a heap, or a set algorithm to unsorted inputs, violates the algorithm contract.

## Range algorithms and range concepts

Classic algorithms take iterator pairs. Range algorithms **(C++20)** accept a whole range, use concepts to reject missing capabilities, and commonly support projections.

```cpp
void algorithm_style_demo(std::vector<Order>& orders) {
    std::sort(
        orders.begin(),
        orders.end(),
        [](const Order& lhs, const Order& rhs) {
            return lhs.price_ticks < rhs.price_ticks;
        });

    std::ranges::sort(orders, {}, &Order::price_ticks);
}
```

The range call has no endpoint pair to mismatch. The classic form remains useful for an iterator subrange and for older algorithms whose range counterpart is not available.

Ranges compose with non-owning sequence views such as `std::span`:

```cpp
void sort_prefix(std::span<Order> orders, std::size_t count) {
    if (count > orders.size()) {
        throw std::out_of_range{"prefix exceeds span"};
    }

    std::span<Order> prefix = orders.first(count);
    std::ranges::sort(prefix, {}, &Order::price_ticks);
}
```

Working range vocabulary is small:

| Concept | Working meaning | Examples |
|---|---|---|
| `range` | `begin` and `end` form an iterable sequence | containers, `std::span`, views |
| `view` | range with constant-time move; often refers to other storage | adaptor views, `std::span`, `owning_view` |
| `borrowed_range` | iterators can survive the range object | `std::span`, `std::string_view` |

Views are not universally non-owning: `std::ranges::owning_view` can own an rvalue container. Most adaptor pipelines over lvalue containers instead keep a reference-like upstream view. A borrowed iterator still depends on the underlying character or element storage remaining alive; only the small range wrapper may disappear. Concepts get full treatment in Chapter 20.

Range algorithm return types account for lifetime. Several return `std::ranges::dangling` instead of an iterator when given a temporary non-borrowed range:

```cpp
std::vector<int> make_values() {
    return {4, 8, 15, 16};
}

void borrowed_result_demo() {
    auto result = std::ranges::find(make_values(), 15);
    static_assert(std::same_as<
                  decltype(result),
                  std::ranges::dangling>);
}
```

The temporary `std::vector` dies at the end of the call, so returning its iterator would be immediately unsafe. A range sort returns its end iterator for a borrowed lvalue range and `dangling` for such a temporary.

**Note.** Prefer the `std::ranges` family within new code and qualify it explicitly. Mixing classic and range overload sets in one unqualified expression makes lookup and diagnostics harder to read.

## Lazy views and pipelines

A range adaptor builds a **view** whose work is lazy. `filter` searches for accepted elements during iteration, `transform` computes values on dereference, and `take` stops after a count; no intermediate container is created.

This cookbook summarizes the common adaptor shapes:

| Adaptor | Work performed during iteration | Preserves source size? | Preserves contiguity? | Typical use |
|---|---|---:|---:|---|
| `transform` | map each dereference | Yes | No as a range concept | Compute a derived field |
| `filter` | scan until predicate succeeds | No | No | Select matching orders |
| `take` / `drop` | stop early or skip prefix | Sometimes | Source-dependent | Bound or offset a pipeline |
| `zip` **(C++23)** | advance several ranges together | Shortest input | No | Pair prices with quantities |
| `enumerate` **(C++23)** | produce index-value pairs | Yes | No | Attach sequence positions |
| `chunk` **(C++23)** | expose non-overlapping groups | Number of groups differs | No | Batch records |
| `slide` **(C++23)** | expose overlapping windows | Number of windows differs | No | Rolling statistics |
| `join` | traverse nested ranges as one | Usually no | No | Flatten message batches |

“Lazy” means the adaptor itself does not allocate an output collection. It does not mean constant work: a filtered increment can test many source elements, a sliding window exposes overlapping work, and a second traversal repeats transformations.

```cpp
enum class Side {
    Buy,
    Sell
};

struct BookOrder {
    Side side;
    std::int64_t price_ticks;
    std::int64_t quantity;
};

void pipeline_demo(const std::vector<BookOrder>& orders) {
    auto notionals =
        orders
        | std::views::filter([](const BookOrder& order) {
              return order.side == Side::Buy;
          })
        | std::views::transform([](const BookOrder& order) {
              return order.price_ticks * order.quantity;
          })
        | std::views::take(100);

    for (std::int64_t notional : notionals) {
        std::cout << notional << '\n';
    }
}
```

The pipe operator feeds one range into the next adaptor. Iteration pulls one order through all stages before advancing the source.

The equivalent loop makes the control flow explicit:

```cpp
void loop_demo(const std::vector<BookOrder>& orders) {
    int emitted = 0;
    for (const BookOrder& order : orders) {
        if (order.side != Side::Buy) {
            continue;
        }

        std::cout << order.price_ticks * order.quantity << '\n';
        if (++emitted == 100) {
            break;
        }
    }
}
```

Both versions inspect source elements until they emit 100 buys or reach the end. The pipeline stores no notionals.

Materialize a pipeline when storage, random access, or repeated traversal is required:

```cpp
std::vector<std::int64_t> buy_notionals(
        const std::vector<BookOrder>& orders) {
    auto pipeline =
        orders
        | std::views::filter([](const BookOrder& order) {
              return order.side == Side::Buy;
          })
        | std::views::transform([](const BookOrder& order) {
              return order.price_ticks * order.quantity;
          });

    return pipeline | std::ranges::to<std::vector>();  // C++23
}
```

`std::ranges::to` **(C++23)** performs the allocation and element construction. Building `pipeline` itself does neither.

For a sized source, an implementation can reserve the destination once. A filtered source is generally not sized, so materialization may grow the destination as accepted elements arrive. Reserve manually through an explicit loop when allocation count is part of the path's contract.

A filtered view generally has no constant-time `size()` because counting requires running the predicate. Traversing a lazy transform twice computes every transformed value twice; materialize when that recomputation costs more than storing the result.

## View lifetimes and view costs

A view's lifetime safety depends on its upstream range. A pipeline built from an lvalue container usually refers to that container and must not outlive it.

```cpp
auto dangling_orders() {
    std::vector<BookOrder> local{
        {Side::Buy, 100, 10},
        {Side::Sell, 101, 20}
    };

    return local | std::views::filter([](const BookOrder& order) {
        return order.side == Side::Buy;
    });
}

void dangling_view_demo() {
    auto orders = dangling_orders();
    // std::cout << orders.begin()->quantity;  // undefined behavior: dangling
    (void)orders;
}
```

This is the same lifetime disease as a dangling `std::string_view` from Chapter 12. Keep the source in the receiving scope:

```cpp
std::vector<BookOrder> get_orders() {
    return {{Side::Buy, 100, 10}, {Side::Sell, 101, 20}};
}

void safe_view_demo() {
    auto orders = get_orders();
    auto buys = orders | std::views::filter([](const BookOrder& order) {
        return order.side == Side::Buy;
    });

    std::cout << buys.begin()->quantity << '\n';  // prints: 10
}
```

**Note.** A direct pipeline over an rvalue container, such as `get_orders() | std::views::filter(...)`, is safe in C++23 because `views::all` wraps the rvalue container in an owning view. Returning a pipeline over a local lvalue, as above, is not.

`filter_view` over a forward range may cache its first satisfying iterator. Mutating through the view can make that cached element fail the predicate:

```cpp
void filter_mutation_demo() {
    std::vector<Order> orders{{100, 10}, {101, 20}};
    auto positive = orders | std::views::filter([](const Order& order) {
        return order.quantity > 0;
    });

    auto first = positive.begin();
    first->quantity = 0;

    std::cout << positive.begin()->quantity << '\n';  // prints: 0
}
```

The view no longer reliably represents “orders with positive quantity.” Nothing reallocated, but the cached position and predicate have diverged. Avoid mutations that change membership while a filtered view is in use.

Views also have execution costs:

- `filter` turns increment into a predicate-driven scan with a branch per candidate.
- Filtering removes the contiguous-range property even when the source is a `std::vector`.
- Lazy transforms repeat their computation on each traversal.
- Layers normally inline away, but only measurement confirms the generated loop.

A dense raw loop can preserve straightforward vectorization and prefetching where a filtered pipeline cannot. Use views for clarity in noncritical code; compare generated code and benchmark measured hot paths using *Computer Architecture and Performance Engineering*.

**Pitfall.** A view stored as a class member often outlives its source. An `auto&&` binding or range-for extends a top-level temporary only for its local use, not for storage beyond that scope.

## Parallel algorithms and execution policies

Execution policies **(C++17)** are first arguments to classic algorithms. `std::execution::seq` requests sequenced execution, `par` permits multiple threads, and `par_unseq` permits both parallel and unsequenced execution; `unseq` **(C++20)** permits unsequenced execution within the calling thread.

| Policy | Multiple threads permitted? | Unsequenced/vectorized calls? | Typical intent |
|---|---|---|---|
| `seq` | no | no | deterministic ordinary call |
| `unseq` | no requirement | yes | SIMD-friendly loop |
| `par` | yes | no within each thread | throughput across cores |
| `par_unseq` | yes | yes | maximum implementation freedom |

```cpp
void offline_sort(std::vector<std::int64_t>& values) {
#if defined(__cpp_lib_parallel_algorithm)
    std::sort(std::execution::par, values.begin(), values.end());  // C++17
#else
    std::sort(values.begin(), values.end());
#endif
    // suitable only after measurement on a large offline workload
}
```

**Note.** Execution-policy support remains incomplete in some standard-library distributions, including some Apple `libc++` releases. The feature-test branch keeps the example buildable and selects the sequential call when `<execution>` does not provide the policies.

The caller owns data-race freedom. The library does not synchronize side effects inside predicates, transforms, or comparators; Chapter 25 defines a data race precisely.

Unsequenced policies require vectorization-safe operations. Locking a mutex or otherwise blocking inside a `par_unseq` callback is unsafe and can deadlock. If an exception escapes an algorithm invoked with a standard execution policy, the implementation calls `std::terminate`.

Parallel algorithms prioritize throughput. Scheduling overhead, nondeterministic reduction grouping, and lack of application-level core placement make them a poor fit for a latency-critical tick path. They can fit large offline analytics or backtests; Chapter 23 develops the thread machinery behind `par`.

Policy overloads are not promises that useful parallelism occurs. The implementation may execute sequentially, and the caller still pays the semantic cost of allowing reordering. Benchmark the complete workload rather than assuming the policy name guarantees a speedup.

## Latency Lens

- A sort comparator runs `O(N log N)` times; an extra branch or non-inlined call inside it multiplies across the algorithm.
- An unsorted binary search or non-strict comparator violates a precondition, so optimization can expose crashes or silent corruption rather than merely slower execution.
- `nth_element` and `partial_sort` avoid ordering unused tails, an algorithmic reduction in work that dominates instruction-level tuning for top-`K`.
- `stable_sort` and `stable_partition` may allocate temporary buffers, putting a heap operation inside an otherwise computational call.
- `lower_bound` on a sorted vector makes logarithmic comparisons over contiguous storage, but its data-dependent probes remain difficult branches to predict.
- An incorrectly typed `accumulate` initial value narrows every partial result inside the loop as well as producing the wrong answer.
- `views::filter` replaces contiguous iteration with a branchy scan, blocking contiguous-range optimizations and often hindering vectorization.
- Traversing a lazy pipeline twice performs its predicate and transformation work twice; `ranges::to` trades materialization storage and possible allocations for reuse.
- `zip`, `chunk`, and `slide` express multi-range and windowed traversal without intermediate containers, but their proxy and repeated-window work still belong in the measured loop.
- Parallel policies trade scheduling, core-placement control, and deterministic grouping for throughput, usually the wrong exchange on a tick path.
