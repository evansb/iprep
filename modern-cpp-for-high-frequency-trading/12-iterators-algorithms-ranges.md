# Chapter 12 — Iterators, Algorithms, and Ranges

An algorithm call expresses more than a loop, but it does not make cost disappear. Iterator capabilities determine which operations are legal, element types determine comparison and movement cost, and a lazy range can either remove temporary storage or repeat expensive work. This chapter separates those semantic contracts from optimizer opportunities and shows how to retain control over allocation, invalidation, determinism, and vectorization.

## 12.1 Iterator Categories and Contiguous Iterators

An **iterator** identifies a position in a sequence and supports operations determined by its category. Algorithms use those capabilities without knowing the container type. In C++20 ranges, iterator concepts express the requirements more accurately than the older category tags, although both systems remain relevant to library interoperability.

The principal progression is:

| Capability | Characteristic operations | Typical source |
|---|---|---|
| Input | Read once, increment | Input stream |
| Output | Write once, increment | Output stream or inserter |
| Forward | Multipass read, increment | `forward_list` |
| Bidirectional | Increment and decrement | `list`, ordered tree |
| Random access | Constant-time jumps, difference, ordering | `deque` |
| Contiguous | Random access plus adjacent objects in memory | Pointer, `array`, `vector`, `span` |

These are semantic promises, not performance rankings. A random-access deque iterator supports `it + n` in constant time but does not promise one contiguous allocation. A forward iterator permits repeated traversal but says nothing about cache locality. A contiguous iterator allows an implementation to derive an address with `std::to_address` and reason about adjacent objects.

```cpp
#include <algorithm>
#include <concepts>
#include <deque>
#include <vector>

static_assert(std::contiguous_iterator<std::vector<int>::iterator>);
static_assert(std::random_access_iterator<std::deque<int>::iterator>);
static_assert(!std::contiguous_iterator<std::deque<int>::iterator>);
```

Complexity requirements depend on categories. `std::advance(it, n)` is constant time for a random-access iterator and linear for a bidirectional or forward iterator. `std::distance(first, last)` has the same distinction. Accidentally placing either inside an outer loop can turn a linear algorithm into a quadratic one.

Iterator validity is a separate concern. A vector iterator is contiguous while valid, yet reallocation invalidates it. An iterator also carries an ownership relationship that its type usually does not encode. It cannot prove that the container remains alive or that another thread does not mutate it.

Single-pass and multipass behavior changes API design. Reading an input iterator can consume data, so an algorithm cannot count elements and then restart unless it first stores them. A forward iterator guarantees that copies can traverse the same sequence independently. Requiring `forward_range` rather than merely `input_range` is therefore a semantic restriction, not a request for a faster increment.

Iterator differences use `iter_difference_t<I>`, a signed type. Distances that do not fit that type cannot be represented by the iterator contract even if a container's unsigned `size_type` is wider. Avoid casual signed/unsigned conversion when computing offsets, and validate external lengths before constructing iterator endpoints.

The optimizer benefits most when iterator abstraction inlines away. With optimized builds, a vector loop commonly becomes pointer arithmetic and may vectorize. Debug iterators, uninlined adapters, or opaque library boundaries can add checks and indirection. Compare optimized assembly before blaming the abstraction itself.

Classic algorithms express requirements through template validity and named legacy categories; ranges algorithms use concepts and can reject a bad call closer to its source. Many ranges overloads also accept a whole range and a projection. These interface improvements do not imply a faster implementation. Given equivalent iterators and an inlined callable, both forms can generate the same loop. Prefer the interface that states ownership and requirements most clearly, then verify code generation when it is on the critical path.

Iterator adaptors can weaken capabilities deliberately. A filtering iterator over a contiguous vector is not itself contiguous because successive accepted elements need not be adjacent. Asking the base container for `data()` therefore says nothing about the filtered range's iterator category.

## 12.2 Sentinels and Proxy Iterators

A **sentinel** marks the end of a range but need not have the same type as its iterator. C++20 range algorithms accept iterator-sentinel pairs, enabling termination conditions that do not require constructing a conventional end iterator.

```cpp
#include <cstddef>
#include <iterator>
#include <ranges>

struct zero_sentinel {};

struct c_string_iterator {
    using value_type = char;
    using difference_type = std::ptrdiff_t;

    const char* p{};
    char operator*() const { return *p; }
    c_string_iterator& operator++() { ++p; return *this; }
    void operator++(int) { ++p; }
    friend bool operator==(c_string_iterator i, zero_sentinel) {
        return *i.p == '\0';
    }
};

static_assert(std::input_iterator<c_string_iterator>);
static_assert(std::sentinel_for<zero_sentinel, c_string_iterator>);
```

The sentinel comparison executes during traversal. A null-terminated sentinel avoids a preliminary length scan, but it moves termination work into every iteration. A **sized sentinel** additionally supports constant-time distance; algorithms can use that to reserve output or select a faster path.

An iterator and sentinel must belong to the same logical range. Equality between positions from unrelated owners is generally outside the operation's contract, just as subtracting pointers into different arrays is invalid. A sentinel containing a length or boundary pointer must remain consistent with the iterator's source for the entire traversal.

A **proxy iterator** returns an object that represents access rather than an actual `value_type&`. `std::vector<bool>::iterator` is the familiar example, but transform, zip, database, and compressed iterators can also yield proxies. Generic code must not assume that `auto& x = *it` binds to a stored `value_type` object.

The C++20 iterator concepts use operations such as `iter_reference_t`, `iter_value_t`, `iter_rvalue_reference_t`, `iter_move`, and `iter_swap` to describe these relationships. Prefer `std::ranges::iter_swap` over hand-written three-step swaps; it can dispatch correctly for proxies.

Proxy access can hide computation, masking, or multiple loads. It may inhibit vectorization if the accessor is opaque, though an inlined bit iterator can also compile to efficient word operations. Semantics establish what a proxy denotes; assembly and counters establish its cost.

Sentinel design also affects generic dispatch. A **common range** uses the same type for iterator and sentinel, which some legacy APIs require. `std::views::common` can adapt a non-common range, but the resulting iterator may need to store a discriminated state. Convert only at the compatibility boundary rather than erasing a useful sentinel distinction throughout a pipeline.

Never cache the address of `*it` without checking the iterator's reference type. A proxy can be a temporary whose address says nothing about the underlying element. Concepts such as `indirectly_writable` and `permutable` let an algorithm state the operation it truly needs instead of demanding a literal `T&`.

## 12.3 Sorting and Selection Algorithms

Sorting algorithms arrange an entire range; selection algorithms compute only the ordering property a consumer requires. Selecting less work often matters more than micro-optimizing comparisons.

`std::sort` requires random-access iterators and performs `O(N log N)` comparisons in the worst case. It is not stable: equivalent elements may change relative order. `std::stable_sort` preserves that order and has different storage and complexity behavior. It may allocate temporary storage; if sufficient extra memory is available, it performs `O(N log N)` comparisons, while a memory-constrained path can require more comparisons.

`std::partial_sort(first, middle, last)` places the smallest `middle - first` elements in sorted order and is approximately `O(N log M)` comparisons for `M` selected elements. `std::nth_element` partitions so that the element at `nth` is the one that would appear there in a fully sorted sequence; elements on either side are not sorted. Its required comparison complexity is linear on average, not a hard linear latency bound.

```cpp
#include <algorithm>
#include <cstdint>
#include <vector>

struct Candidate {
    std::uint64_t order_id;
    std::int32_t score;
    std::uint64_t arrival_seq;
};

void keep_best_eight(std::vector<Candidate>& c) {
    auto better = [](const Candidate& a, const Candidate& b) {
        return a.score > b.score;
    };
    const auto count = std::min<std::size_t>(8, c.size());
    std::partial_sort(c.begin(), c.begin() + count, c.end(), better);
}
```

Every comparator used by ordering algorithms must impose the required strict weak ordering. Returning `a.price <= b.price` is broken because an element compares less than itself. Comparators based on floating-point NaNs require special care: ordinary `<` on values containing NaNs does not produce a total ordering suitable for arbitrary business rules.

Movement can dominate comparison. Sorting large order objects repeatedly copies or moves their payloads and touches more cache lines. Sorting compact indices or pointers reduces movement but adds indirection when keys are read. A structure-of-arrays layout can keep keys compact while a permutation vector preserves identity.

Range versions of sorting algorithms accept projections. `std::ranges::sort(records, {}, &Record::key)` applies the projection for comparisons; it does not promise to cache the projected value. If projection is expensive, precompute it. If it reads mutable external state, the ordering can change during the sort and invalidate the algorithm's precondition.

Stability is a business decision. When two orders have equal price priority, preserving arrival order may be mandatory. `stable_sort` provides relative-order stability but can allocate; adding `arrival_seq` as a tie-breaker makes the order total and permits `sort`, provided that sequence numbers are unique and wraparound is handled. Those designs are not interchangeable if exact duplicates have a defined order.

Do not assume an algorithm allocates merely because it is sophisticated, or that it never allocates because no allocator appears in the signature. The standard specifies allocation-sensitive behavior for some algorithms, including `stable_sort`. Allocation tracing and deliberately constrained memory tests reveal which implementation path is used.

Ranges and classic algorithms can also differ in return types. Range algorithms often return structured result objects containing final input and output iterators, which avoids recomputing positions and supports chained processing. Ignoring the result is fine only when those positions have no semantic value. An iterator returned into a container is still subject to the container's later invalidation rules.

Sorting is mutation. Readers cannot traverse the same storage concurrently without synchronization merely because the comparator is read-only. A common low-latency design sorts or rebuilds a private buffer, then publishes an immutable snapshot; publication ordering and old-buffer reclamation remain separate concurrency problems.

## 12.4 Linear and Binary Searching

A linear search examines elements in sequence until it finds a match or reaches the end. Binary search repeatedly halves a partitioned random-access range. Linear search is `O(N)`; binary search uses `O(log N)` comparisons. That statement alone does not identify the faster operation.

`std::find` and `std::ranges::find` traverse linearly. Their access stream is contiguous for vectors and easily prefetched. Compilers can sometimes vectorize simple predicates. The operation stops early on a hit, so key distribution changes average work.

`std::lower_bound` finds the first position not ordered before a key; `upper_bound` finds the first position ordered after it. The range must already be partitioned according to the same ordering relation. For random-access iterators, comparisons are logarithmic and position jumps are constant time. With a forward iterator, comparisons remain logarithmic but iterator increments can be linear.

```cpp
#include <algorithm>
#include <span>

struct Level { int price; int quantity; };

const Level* find_level(std::span<const Level> levels, int price) {
    auto it = std::ranges::lower_bound(levels, price, {}, &Level::price);
    return it != levels.end() && it->price == price ? &*it : nullptr;
}
```

The projection `&Level::price` avoids a custom comparator and normally inlines to a member load. Binary search accesses positions with decreasing strides. On a large range, those probes can miss cache and take unpredictable branches; for a small range, a straight scan can be faster. Branchless or Eytzinger-layout searches are specialized alternatives, not changes to the standard algorithms' guarantees.

Searching a tree with `std::lower_bound(tree.begin(), tree.end(), key)` is a common error. The generic algorithm cannot use the tree's internal navigation and may perform linear iterator movement. Use `tree.lower_bound(key)`, whose member function uses the tree structure.

Binary-search predicates must match the partition that already exists. Sorting by `(price, venue)` and then applying a comparator that examines venue first gives no useful guarantee even if both comparators are individually valid. Treat the ordering policy as part of the data structure's type-level or module-level invariant.

When repeated queries target immutable data, layout can be tuned separately from updates. Keeping sorted keys in one compact array and payloads in another reduces bytes fetched by misses and can improve branchless search. It adds an index-to-payload load on success. Benchmark hit ratios and unsuccessful searches, because a miss may never need the payload.

`binary_search` returns only whether an equivalent element exists. `equal_range` returns the half-open subrange of all equivalent elements and is useful for duplicated prices or grouped venue records. Avoid calling `lower_bound` and `upper_bound` independently when `equal_range` expresses the requirement and the implementation can share search work.

For very small fixed ranges, linear search can be unrolled or vectorized and has no binary-search branch tree. There is no universal crossover size: element width, comparator cost, hit distribution, and cache residency move it. Benchmark a size sweep and retain the chosen threshold as target-specific policy rather than folklore.

## 12.5 Heap, Partition, Transform, and Reduce

A **heap** is a random-access range satisfying a parent-child ordering property. `make_heap` builds it in linear time; `push_heap` and `pop_heap` restore it in logarithmic time; `sort_heap` completes a heap sort. The standard adaptors use these operations to implement `priority_queue`.

Heap access stays within contiguous indexable storage but jumps between levels. It is effective when the highest-priority element is repeatedly consumed and full sorted order is unnecessary. Equal-priority elements have no stable FIFO guarantee; include an arrival sequence in the key if that rule matters.

Partition algorithms group elements according to a predicate. `partition` need not preserve relative order; `stable_partition` does and may use temporary memory. `partition_point` performs logarithmic predicate applications on an already partitioned range, with iterator-category qualifications similar to binary search.

`transform` maps input elements to output elements. The output range must have sufficient storage unless an insertion iterator is used. A back inserter can trigger repeated growth unless the destination is reserved.

```cpp
#include <algorithm>
#include <span>
#include <vector>

std::vector<int> notionals(std::span<const int> prices,
                           std::span<const int> quantities) {
    const auto n = std::min(prices.size(), quantities.size());
    std::vector<int> out(n); // one allocation for n elements
    std::transform(prices.begin(), prices.begin() + n,
                   quantities.begin(), out.begin(),
                   [](int p, int q) { return p * q; });
    return out;
}
```

Production code must use a type wide enough for the multiplication; signed overflow is undefined behavior. The example keeps the algorithm shape visible, not a complete risk calculation.

`std::accumulate` is a left fold with a specified sequential dependency. `std::reduce` permits regrouping and reordering, which can expose parallelism and vectorization. For floating-point values, different grouping can change rounding; for a non-associative operation, results can change more dramatically. Use `reduce` only when the operation and reproducibility requirements allow that freedom.

Input and output overlap needs an exact contract. Unary `transform` naturally supports writing each result back to the corresponding input position, as in an in-place scale. Arbitrary shifted overlap is not a general memmove facility and can overwrite values before they are read. State whether the operation is in-place, disjoint, or deliberately traversed in a safe direction.

Heap algorithms are not concurrent priority queues. A heap operation mutates multiple array positions and provides no synchronization. If one thread owns the heap, producers can send requests through a bounded queue; adding a lock around every heap operation changes the contention and wakeup model and must be measured as part of the structure.

## 12.6 Comparison, Movement, and Temporary Storage

Algorithm complexity usually counts selected primitive operations—comparisons, predicate calls, swaps, or applications of a function. Those primitives are not unit-cost in real programs. Comparing two integers differs from comparing long strings; moving an index differs from moving a cache-cold record.

A comparator should normally accept references and avoid allocation, I/O, locks, and hidden normalization. Algorithms may call it many times and in an order the program must not depend on. A comparator with mutable external state can violate ordering requirements and create data races under parallel execution.

Projections can reduce repeated work if data is precomputed. Suppose a sort key parses a textual price on every comparison. `O(N log N)` comparisons now repeat parsing. A decorate-sort-undecorate approach computes compact keys once, sorts them with stable IDs, and applies the permutation. It consumes temporary memory but may sharply reduce instruction work.

Movement policy affects exception behavior. Many algorithms use `iter_swap` and move operations. A throwing move can leave values in valid but unspecified states under the operation's documented guarantee. Hot-path value types are easier to reason about when movement is cheap and `noexcept`, but correctness must not depend on an exception never occurring unless the operation is explicitly excluded by contract.

Temporary storage also affects page faults and NUMA placement. Allocating a scratch vector during the first live message can fault pages even if the algorithm is asymptotically optimal. Preallocate and touch reusable scratch space during controlled initialization when capacity is bounded. If an algorithm's standard interface owns its hidden scratch allocation policy, choose another algorithm or implementation when that policy cannot meet the bound.

Verification should count more than wall time. Track allocations, branch misses, cache misses, instructions, and bytes moved. Compare algorithms on identical keys and outputs; otherwise a faster result may simply perform less required work or return a weaker ordering.

Object footprint changes algorithm choice. An indirect sort of 32-bit indices adds an index array but moves four bytes per swap; a direct sort may move a 128-byte record. Indirection then makes comparisons fetch records in a scattered order. A useful experiment measures both the sort and the subsequent consumer, because a permutation left unapplied may impose an extra cache miss on every later access.

Warm scratch buffers before measuring if production warms them, and include cold faults if production does not. Report compiler, library, allocator, data distribution, and comparison count. A stable algorithm taking a low-memory fallback is a different execution regime and should appear as such in tail histograms.

## 12.7 C++17 Sequential and Parallel Execution Policies

C++17 execution policies select permitted execution behavior for algorithms that provide policy overloads. `std::execution::seq` requests sequenced execution, `par` permits parallel execution across threads, and `par_unseq` additionally permits unsequenced execution within a thread. C++20 adds `unseq`, which permits unsequenced execution without requiring multiple threads.

The word “permits” is important. An implementation is not required to create workers or obtain a speedup. Backend availability, input size, iterator category, and library configuration can all affect whether work is parallelized. Some standard-library builds require an external parallel backend; check deployment linkage and behavior rather than assuming a header activates a thread pool.

```cpp
#include <algorithm>
#include <execution>
#include <vector>

void apply_scale(std::vector<double>& values, double scale) {
    std::transform(std::execution::par_unseq,
                   values.begin(), values.end(), values.begin(),
                   [scale](double x) noexcept { return x * scale; });
}
```

The function object must tolerate the policy's invocation rules. Iterations must not race on shared state. Under unsequenced execution, code must not acquire a mutex or rely on ordering between invocations; calls that are not safe to interleave can deadlock or be undefined. Per-element independence is the cleanest design.

Parallel startup, task partitioning, worker wakeups, and final joins add overhead and variance. A large offline calculation may benefit; a tiny operation on a market-data critical path usually has too little work to amortize coordination. Parallel access can also increase shared-cache and memory-bandwidth pressure or place pages on the wrong NUMA node.

Parallelism can introduce false sharing even when each logical element is independent. If adjacent worker partitions update small counters that occupy one cache line, ownership can ping-pong between cores. Chunking ranges on cache-line boundaries or accumulating into per-worker storage can help, but a worker count and partition size chosen by the library may not be directly controllable through the standard policy interface.

Not every algorithm has a policy overload, and ranges algorithms did not gain execution-policy overloads merely because ranges arrived in C++20. Check the exact standard-library interface. Mixing iterator algorithms with views can require extracting `begin` and `end`, possibly adapting a non-common range first.

Execution policy is part of semantics, not just tuning. It changes allowed ordering and, as the next section explains, error behavior. Maintain a sequential reference result and test with thread and undefined-behavior sanitizers where applicable, while recognizing that sanitizer instrumentation changes scheduling and vectorization.

Worker lifetime is not specified as an application-owned pool contract. A library may reuse workers, delegate to a backend, or execute serially. Consequently, the standard policy interface is a poor place to require thread affinity, real-time priority, per-worker arena ownership, or a fixed task count. Use an execution framework with an explicit operational contract when those properties are requirements.

Benchmark at multiple sizes and under system load. Record worker migrations, context switches, CPU utilization, and memory bandwidth alongside elapsed time. A parallel algorithm can improve median completion while worsening the tail through scheduler or shared-resource interference.

## 12.8 Vectorization, Nondeterminism, and Exception Behavior

**Vectorization** executes equivalent operations on multiple data elements with SIMD instructions. A contiguous, independent loop over simple arithmetic is a strong candidate. Aliasing uncertainty, function calls, loop-carried dependencies, irregular control flow, and proxy access can prevent vectorization.

`par_unseq` or `unseq` grants the implementation freedom to interleave invocations and use SIMD. It does not force SIMD. Inspect compiler vectorization remarks and assembly:

```sh
clang++ -std=c++23 -O3 -Rpass=loop-vectorize -Rpass-missed=loop-vectorize file.cpp
g++ -std=c++23 -O3 -fopt-info-vec-optimized -fopt-info-vec-missed file.cpp
```

Nondeterminism comes from more than threads finishing in a different order. Reduction trees group values differently. A stateful predicate can observe an unspecified call order. Competing writes create a data race unless synchronization exists, and synchronization can erase the expected benefit.

For overloads using the standard execution-policy objects, an exception escaping an element-access function leads to `std::terminate`. This differs from ordinary sequential algorithm overloads, which can propagate exceptions. Allocation failure may be reported as `std::bad_alloc` where the specification permits allocation. Do not use a standard parallel policy when per-element failures must be collected through exceptions; return explicit status into preallocated output or validate inputs first.

Termination is especially important because `seq` in an execution-policy overload is not identical to omitting the policy. Both request sequential ordering, but the policy overload uses the execution-policy exception rule. Choose the non-policy overload when ordinary propagation is part of the interface.

Writing error codes into a shared vector requires pre-sizing it so distinct iterations access distinct elements. Calling `push_back` concurrently is a data race even if capacity was reserved; reservation prevents reallocation but does not synchronize mutation of the vector's size. After the algorithm, a sequenced pass can compact or interpret those per-element statuses.

Auto-vectorization without an execution policy can still occur under the as-if rule when observable behavior is preserved. Conversely, strict floating-point semantics can prevent reassociation. Compiler flags such as fast-math broaden transformations beyond ordinary language guarantees and must be evaluated as numerical-policy changes, not harmless speed switches.

SIMD improves element throughput only when memory can supply data and the tail can be handled efficiently. A filter that keeps an unpredictable subset may compile to masks and compress operations on one ISA or scalar control flow on another. Gather instructions can replace scalar loads but still pay for scattered cache lines. Qualify claims by target architecture and generated code.

Alignment is another implementation input, not a property bestowed by a policy. Standard allocators satisfy the element type's alignment, and unaligned vector loads are legal through ordinary compiler code where the ISA supports them. Over-aligning data can help a particular kernel or waste memory and complicate allocation. Let vectorization reports identify the actual obstacle before changing layout.

## 12.9 C++20 Lazy Views and Borrowed Ranges

A C++20 **view** is a range designed for cheap copying or movement, usually with non-owning or otherwise lightweight semantics. View adaptors such as `filter`, `transform`, and `take` build lazy pipelines: they compute elements as iteration requests them rather than materializing an intermediate container.

```cpp
#include <ranges>
#include <span>

struct Update { int price; int quantity; };

auto positive_prices(std::span<const Update> updates) {
    return updates
         | std::views::filter([](const Update& u) { return u.quantity > 0; })
         | std::views::transform(&Update::price);
}
```

The returned pipeline owns its small predicate and projection objects but refers through the span to external elements. It allocates no intermediate vector. The caller must keep the underlying updates alive and unmoved while iterating.

A **borrowed range** is a range whose iterators can remain valid after the range object itself is destroyed. `span` and `string_view` are borrowed ranges because destroying the view does not destroy the elements. A vector is not: destroying it destroys its storage. Borrowed does not mean immortal—the separate owner can still die or reallocate.

Range algorithms make this distinction visible. When an algorithm would return an iterator into a non-borrowed temporary, its result type can be `std::ranges::dangling` rather than an iterator. This prevents one class of immediate misuse at compile time. It does not analyze indirect lifetimes stored inside arbitrary custom views.

Lazy pipelines store adaptors and can compose without allocations, but their object size grows with captured state. Capturing a large lookup table by value copies it into the closure; capturing by reference adds a lifetime constraint. Inspect the resulting view type indirectly with `sizeof` or compiler diagnostics when its footprint matters.

Some views cache traversal state. A filter view commonly needs to find the first satisfying element when `begin()` is requested and may cache that position to meet its range guarantees. Copies, const access, and repeated `begin()` therefore need not have the naive cost inferred from the pipeline spelling. The standard specifies observable range behavior, while the exact cached representation is implementation detail.

Views also differ in whether they can be iterated through a `const` view object. A predicate or underlying range that cannot support const iteration can make `begin() const` unavailable. Generic interfaces should constrain the actual range they receive rather than assuming every cheap-to-copy view behaves like a const container.

## 12.10 Dangling Range Pipelines

A range pipeline dangles when it retains a handle to storage whose lifetime has ended or whose location has been invalidated. Laziness postpones access, so the bug often appears far from pipeline construction.

```cpp
#include <ranges>
#include <vector>

// BROKEN: views::all on this lvalue stores a reference to local storage.
auto positive_local_values() {
    std::vector<int> values{3, -1, 4};
    return values | std::views::filter([](int x) { return x > 0; });
}
```

The local `values` is an lvalue, so the pipeline refers to it. It is destroyed on return. Iterating the result is undefined behavior. Possible corrections are to materialize an owning result, accept caller-owned input as a span, or deliberately move an owning range into a view type whose ownership semantics are understood.

Not every pipeline over a temporary is automatically broken. `views::all` can wrap a movable non-view rvalue in an owning view. That makes slogans such as “views never own” inaccurate. Examine the actual adaptor contract and value category.

Callable captures can dangle independently of the base range. A filter that captures a local threshold by reference remains invalid after the threshold dies even if the elements are owned by the returned view. Capturing a small scalar by value is usually the right contract; capturing a service or table by reference requires the returned view's lifetime to be nested inside that object's lifetime.

Invalidation creates another route to dangling:

```cpp
void invalidation_example() {
    std::vector<int> values{1, 2, 3};
    auto first_two = values | std::views::take(2);
    values.push_back(4); // may reallocate
    // Iterating first_two is unsafe if reallocation occurred.
}
```

Avoid returning a view into local storage, and document whether a returned view borrows from an argument or owns its source. Tests should force owner growth and destruction. AddressSanitizer often detects heap use-after-free, but capacity slack can allow invalid designs to appear correct until a particular input triggers reallocation.

A range-for statement does not make an unsafe view safe. It asks `begin` and `end` from the range expression and then iterates. C++23 extends the lifetime of temporaries within the range initializer in more cases, but it cannot repair a view already returned with references to a destroyed local, nor can it extend an object destroyed inside a by-value function parameter. Design APIs around ownership instead of relying on subtle temporary-lifetime rules.

## 12.11 C++23 `ranges::to`

C++23 `std::ranges::to<C>` materializes an input range as a container `C`. It provides the explicit boundary between a lazy computation and owned storage.

```cpp
#include <ranges>
#include <vector>

std::vector<int> collect_positive(const std::vector<int>& values) {
    return values
         | std::views::filter([](int x) { return x > 0; })
         | std::ranges::to<std::vector>();
}
```

Materialization traverses the range and constructs elements in the destination. It can allocate. When the source is sized and the destination supports reservation, an implementation can reserve appropriately under the facility's specified construction strategy; an unsized filter view cannot generally know its output count without evaluating the predicate.

The destination element type may differ from the source reference type, so conversions, copies, or moves can occur. Nested range conversion is supported by the facility's recursive forms, but nested allocations can be substantial. Make ownership transfer visible in code review and keep it outside a critical path when capacity and allocator behavior are not bounded.

Materialization also fixes an observation point. A lazy view reflects permitted changes to its underlying range when later traversed; an owned container captures the produced values at conversion time. This distinction matters for snapshots. Neither facility adds synchronization, so the source still must not be mutated concurrently without a valid concurrency design.

Container construction can fail through allocation or element construction. If the conversion is used at a recovery or configuration boundary, propagate that error normally. If it is proposed for a no-fail market-data path, replace implicit growth with a preallocated destination and an explicit full result rather than assuming `ranges::to` honors an application capacity bound.

Library support for `ranges::to` arrived unevenly after C++23 publication. Check `__cpp_lib_ranges_to_container`. A portable fallback is an explicit destination, `reserve` when a size is available, and `ranges::copy` to a back inserter; that fallback must reproduce required conversions and allocator choices intentionally.

The target type selects ownership and representation, so make it explicit when deduction would obscure an important choice. Converting to `std::vector` gives contiguous dynamic storage; converting to an ordered set removes duplicates according to its comparison; converting to a string imposes character construction rules. The conversion is not a neutral “collect” step.

## 12.12 C++23 Expanded View Adaptors

C++23 expands the range toolbox with adaptors for common structural operations. Important groups include:

| Adaptor family | Result |
|---|---|
| `zip`, `zip_transform` | Traverse several ranges together |
| `adjacent`, `adjacent_transform` | Fixed-size overlapping tuples |
| `chunk`, `chunk_by` | Nonoverlapping groups |
| `slide` | Overlapping windows |
| `stride` | Every nth element |
| `join_with` | Flatten with a delimiter range |
| `repeat` | Repeated value, optionally bounded |
| `cartesian_product` | Tuple combinations of input elements |

These views express intent and can eliminate handwritten iterator state. They remain lazy: `cartesian_product` does not allocate all combinations, but iterating all of them still performs the product of the input sizes. `slide<4>` does not copy four elements for every window, but downstream work may read overlapping elements repeatedly.

```cpp
// C++23, when the standard library provides views::slide.
// Excerpt: prices is a caller-owned range.
auto windows = prices | std::views::slide(4);
for (auto window : windows) {
    // window is a view of four adjacent prices
}
```

Zip stops according to its specified shortest-range behavior, which can silently ignore a longer input if equality of lengths was a business invariant. Check sizes before constructing the view when mismatched market-data columns indicate corruption.

Adaptor complexity composes. A `stride(8)` view visits roughly one eighth of the source elements, but each iterator increment may calculate or clamp a jump at the end. A `chunk_by` predicate is evaluated between adjacent elements. A Cartesian product of ranges sized `A`, `B`, and `C` exposes `A * B * C` tuples if fully consumed; laziness removes storage for those tuples, not the combinatorial work.

Window adaptors are useful for rolling calculations, but a direct transform over every window can repeat shared arithmetic. For example, summing each window of 100 values performs about 100 additions per output unless the downstream operation carries a rolling sum. The view captures grouping semantics; it does not select an incremental algorithm automatically.

Adaptor availability varies considerably across C++23 standard libraries. Feature-test macros such as those for zip, chunk, slide, and stride are more informative than `-std=c++23` alone. Keep compatibility shims narrow, test their iterator concepts, and avoid giving a fallback stronger lifetime guarantees than the standard facility.

## 12.13 Materialization, Repeated Computation, and Optimization Barriers

Laziness trades storage for deferred work. It wins when a consumer stops early, when intermediate values are cheap, or when a fused loop lets the compiler keep values in registers. It loses when the same view is traversed repeatedly and repeats an expensive predicate or projection.

```cpp
// Excerpt: orders and both callables are supplied by the component.
auto eligible = orders
              | std::views::filter(expensive_risk_check)
              | std::views::transform(compute_score);

auto count = std::ranges::distance(eligible); // evaluates filter
auto best  = std::ranges::max(eligible);      // evaluates it again
```

If both results are required, one materialization may be cheaper and more deterministic. It consumes memory and can allocate, so use a reusable, reserved buffer when the maximum count is known. The choice is not “modern ranges versus old loops”; it is recomputation versus storage under a specific workload.

Pipelines can also form optimizer barriers. A fully inlined chain over contiguous storage may collapse to one vectorized loop. A predicate reached through type erasure, a function pointer, virtual dispatch, or a separately compiled boundary can block inlining. Complex iterator state, uncertain aliasing, and control-heavy filters can further inhibit SIMD.

The reverse is also possible: an eager series of temporary vectors performs allocation and multiple full memory passes, while one lazy chain performs a single pass. Inspect vectorization diagnostics and assembly, then measure instructions, branches, cache misses, allocations, and output equality. Do not infer machine behavior from source elegance.

For predictable systems, make traversal count and ownership boundaries visible. Name a pipeline if it is traversed once; materialize it explicitly if consumers require stable storage or repeated access; reserve capacity from a real bound; and define what happens when that bound is exceeded. Complexity, locality, and lifetime are three independent contracts.

There are three useful implementation shapes for a chain of operations. A fused lazy traversal minimizes intermediate storage and can stop early. A materialized intermediate pays writes and storage but permits reuse, random access, and stable snapshots. A hand-written specialized loop can maintain incremental state or express a capacity check not represented by standard adaptors. Choose among them by required semantics; source brevity is not an acceptance criterion.

Keep verification representative. A filter that accepts every element behaves like a predictable copy; a 50-percent random predicate stresses branches or masks; a filter that accepts one element rewards laziness and early termination. Test each distribution the live system can produce, including empty and full-capacity cases. Confirm the same result order before comparing throughput or tail latency.

Use compiler reports to explain rather than certify performance. An optimizer may report that it vectorized a loop while the operation remains memory-bound, or decline vectorization because a branchy workload is better scalar. Pair the report with generated assembly and counters such as instructions, cycles, branches, cache misses, and page faults. Run enough independent samples to expose allocation and scheduling outliers without fabricating precision from a noisy host.

## 12.14 Interview Check

1. Explain the difference between a random-access iterator and a contiguous iterator. Give a standard container example of each.
2. Why can `std::lower_bound` over a linked container perform logarithmic comparisons yet linear iterator increments? What should be used for `std::map`?
3. Compare `sort`, `stable_sort`, `partial_sort`, and `nth_element` for selecting the best 20 of one million candidates. Include ordering guarantees, temporary storage, and worst-case concerns.
4. A comparator parses a decimal price string on every call. Redesign the operation and explain the memory-versus-computation tradeoff.
5. When is `std::reduce` observably different from `std::accumulate`, even on one thread?
6. What additional semantic freedom does `par_unseq` grant, and why is taking a mutex inside its function object invalid design?
7. Describe exception behavior for a standard algorithm invoked with a standard execution policy. How would you report per-element validation failures safely?
8. Explain why `std::ranges::borrowed_range` does not guarantee that element storage is still alive.
9. Find the lifetime error in a function that returns a filter view over a local vector, then give two valid interface designs.
10. A lazy filter view is counted and then searched. Why might materializing it once be faster, and what new latency risks does materialization introduce?
