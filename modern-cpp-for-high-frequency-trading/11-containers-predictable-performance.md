# Chapter 11 — Containers for Predictable Performance

A container choice is also a memory-layout and latency choice. Big-O notation answers how work grows, but it does not say whether an operation allocates, follows dependent pointers, invalidates a view, or occasionally moves every element. This chapter develops a more useful selection method: start with required semantics, then account for footprint, locality, mutation cost, invalidation, and the worst operation that can occur on the critical path.

## 11.1 `array` and Fixed Inline Storage

`std::array<T, N>` is a fixed-size aggregate containing `N` elements of `T`. Its elements are part of the array object; constructing an `array` does not by itself allocate dynamic storage. The standard requires contiguous storage, so `&a[i + 1] == &a[i] + 1` for valid adjacent elements.

```cpp
#include <array>
#include <cstdint>
#include <tuple>

struct QuoteLevel {
    std::int64_t price_ticks;
    std::int32_t quantity;
};

using TopOfBook = std::array<QuoteLevel, 2>; // bid, ask

static_assert(std::tuple_size_v<TopOfBook> == 2);
```

The elements have no gaps between them beyond padding already present in each `QuoteLevel`; do not turn that statement into a general claim about the complete wrapper object's representation. The object may live on the stack, inside another object, in static storage, or in dynamically allocated storage. “Inline” describes containment, not a promise that the bytes are on the machine stack.

Fixed storage gives strong predictability. The capacity cannot change, iterators are never invalidated by growth, and indexed access is constant time. It also moves cost to object construction and copying: passing a large `array` by value can copy all `N` elements unless the compiler eliminates the copy. A very large automatic `array` can exhaust a thread's finite stack.

Initialization remains explicit. `std::array<int, 1024> a;` default-initializes its integers, leaving indeterminate values, whereas `std::array<int, 1024> a{};` value-initializes them to zero. Zeroing is linear work and writes every cache line. That may be exactly what correctness requires, but it belongs in setup rather than an unexplained first-use path. For class elements, their normal construction and destruction rules apply.

The zero-length specialization deserves care. `array<T, 0>::begin() == end()`, but the value returned by `data()` is not a license to dereference an element. Write generic code in terms of the empty half-open range, not assumptions about whether the pointer is null.

Use `array` when the bound is a property of the type—two sides of a market, a fixed histogram, or a protocol field of known width. If the logical size varies up to a bound, keep a separate size or use a fixed-capacity container with explicit lifetime management. Do not silently treat a sentinel element as “unused” if every bit pattern is meaningful.

## 11.2 `vector` Growth, Invalidation, and Locality

`std::vector<T>` owns a dynamically sized contiguous sequence. A vector has a **size**, the number of live elements, and a **capacity**, the number it can hold before obtaining new storage. `data()` points to the first element when the vector is nonempty; since C++17 it also provides a usable pointer value for the half-open empty range.

A common implementation stores three machine words: begin, end, and end-of-capacity. C++ does not prescribe that representation or a growth factor. It does require contiguous elements and the documented complexity and invalidation rules.

```cpp
#include <cstdint>
#include <vector>

struct Order {
    std::uint64_t id;
    std::int64_t price;
    std::uint32_t quantity;
};

std::vector<Order> make_order_storage() {
    std::vector<Order> orders;
    orders.reserve(4096);         // capacity changes; size remains zero
    for (std::uint64_t id = 0; id != 4096; ++id) {
        orders.push_back({id, 100'000, 10});
    }
    return orders;
}
```

If `push_back` exceeds capacity, the vector obtains a larger allocation, move- or copy-constructs existing elements, constructs the new element, destroys the old elements, and releases the old allocation. This operation is linear in the current size and invalidates every pointer, reference, and iterator into the vector. If no reallocation occurs, insertion at the end preserves existing references and iterators, although the old past-the-end iterator is invalidated.

`reserve(n)` is a capacity operation; `resize(n)` changes the number of live elements. Confusing them can perform unwanted initialization or leave code indexing beyond `size()`, which is undefined behavior. Reserving a proven upper bound during setup removes growth from the steady-state path, at the cost of committing address space and eventually touching more memory. `shrink_to_fit` is a nonbinding request, not a deterministic memory-release mechanism.

Contiguity is valuable even when asymptotic complexity is unchanged. Iteration issues regular loads, hardware prefetchers recognize the stream, and many elements share each cache line and page. A linear scan of a modest vector can beat logarithmic traversal of a pointer-rich tree. Conversely, insertion near the front moves a suffix, and a large element type increases both bandwidth and invalidation costs.

Move behavior matters during growth. If moving `T` may throw and `T` is copyable, an implementation commonly copies to preserve the strong exception guarantee. A correct `noexcept` move constructor can therefore change vector reallocation work. It does not make reallocation bounded or cheap.

Interior insertion and erasure are linear even when capacity is sufficient. Inserting at position `i` shifts the suffix `[i, size())`; erasing shifts the following elements toward the front. For trivially copyable types, an implementation can commonly use bulk movement. For nontrivial types it must respect assignment, construction, destruction, and overlap semantics. The erase-remove idiom and C++20 `std::erase_if` compact survivors in one pass and then destroy a suffix, but they still invalidate handles at and after the first removed position.

`reserve` itself may allocate and move all live elements. Call it only when no retained element handles must survive, normally before publishing the vector. Reserving an extremely loose upper bound can make a container's address range and eventual resident set needlessly large. On Linux, allocation and physical page commitment are distinct; Chapter 13 explains why reserved virtual capacity does not imply that every page has already been faulted in.

Verify assumptions instead of relying on a remembered growth factor:

```cpp
// Excerpt: orders is the vector under observation.
for (std::size_t old = orders.capacity(); /* test bound */; ) {
    orders.push_back({});
    if (orders.capacity() != old) {
        // Record capacity outside a latency-sensitive run.
        old = orders.capacity();
    }
}
```

Allocator tracing can reveal allocations; hardware counters can compare cache misses across layouts. Instrumentation in the hot loop changes the result, so collect such evidence in a controlled experiment.

## 11.3 `string`, Small-String Optimization, and `string_view`

`std::string` is a contiguous, dynamically sized sequence of characters with a null terminator at `data()[size()]`. The terminator is storage, not part of the string's size. Operations that exceed capacity may allocate and invalidate pointers, references, iterators, and views into the old character array.

Many standard-library implementations use **small-string optimization** (SSO): short text is stored inside the string object rather than in a separate allocation. C++ does not require SSO, its capacity, or even a particular object size. Code that depends on a vendor's SSO threshold is both nonportable and vulnerable to an apparently harmless library update.

SSO trades allocations for a larger string object and a representation branch. It is often beneficial for short symbols or venue codes, but a fixed-width identifier can be still more predictable when the protocol supplies a hard limit.

String mutation follows vector-like capacity logic, with extra character semantics. `append`, `insert`, replacement, and concatenation can allocate and copy. Repeated `result = result + field` may construct intermediates; reserving once and appending can remove those temporaries. Locale-aware formatting, Unicode normalization, and numeric conversion are separate sources of work not represented by `string`'s element complexity.

`std::string_view` is a non-owning character range, commonly represented by a pointer and a length. It does not extend lifetime and need not refer to a null-terminated sequence.

```cpp
#include <string>
#include <string_view>

// BROKEN: the returned view refers to a destroyed string.
std::string_view make_symbol_bad() {
    std::string s = "EUR/USD";
    return s;
}

std::string_view symbol_field(std::string_view message) {
    return message.substr(0, 7); // caller must keep message storage alive
}
```

A view into a `string` also dangles after a reallocation, even though the owner is still alive. Treat views as borrowed handles with an explicit lifetime boundary—for example, valid only during parsing of one receive buffer. Copy into owned storage at that boundary when the value must survive.

Comparing two views is lexicographical and can inspect up to the shorter length, followed by a length comparison. Hashing a view reads its characters as well. Replacing an owned string with a view removes ownership and allocation; it does not make content-based lookup constant-cost or preserve the receive buffer.

## 11.4 C++20 `span`

`std::span<T, Extent>` is a non-owning view over contiguous objects. A dynamic-extent span stores a run-time size; a static-extent span encodes its size in the type and may need to store only a pointer. Neither form owns, allocates, or extends the lifetime of its elements.

```cpp
#include <cstddef>
#include <cstdint>
#include <span>

std::uint64_t checksum(std::span<const std::byte> bytes) {
    std::uint64_t result = 0;
    for (std::byte b : bytes) {
        result = (result * 131) + std::to_integer<unsigned char>(b);
    }
    return result;
}
```

Passing a span makes pointer-plus-count semantics explicit and works with arrays, vectors, and other contiguous buffers. `subspan`, `first`, and `last` produce more views; they do not copy elements. Static extent can enable compile-time validation and better optimization, but only when the extent is genuinely fixed.

`operator[]` does not perform required bounds checking in C++20 or C++23. Constructing a span with an incorrect count, or keeping it after its owner reallocates or dies, produces the same hazards as raw pointer arithmetic. A span can be cheap and still be unsafe when its lifetime contract is vague.

## 11.5 C++23 `mdspan`, Layouts, and Multidimensional Access

`std::mdspan` is a C++23 non-owning multidimensional view. It combines a data handle, extents, a layout mapping, and an accessor. The mapping converts multidimensional indices to a one-dimensional offset; the accessor defines how that offset reaches an element.

```cpp
#include <array>
#include <cstddef>
#include <mdspan>

std::array<int, 2 * 8> quantities{};
void update_level() {
    std::mdspan<int, std::extents<std::size_t, 2, 8>> book{quantities.data()};
    book[0, 3] = 25; // side 0, level 3; multidimensional [] is C++23
}
```

`layout_right` makes the rightmost index contiguous, analogous to row-major storage. `layout_left` makes the leftmost index contiguous. `layout_stride` represents general strided mappings. The best layout puts the index traversed in the inner loop next to itself in memory.

An `mdspan` does not allocate or prescribe the backing container. Its object can contain dynamic extents or strides, so size depends on the extents and mapping types. Bounds checking is not generally required. As of C++23 adoption, compiler language support for multidimensional subscripting arrived before complete `<mdspan>` availability in some standard libraries. Check the library feature-test macro `__cpp_lib_mdspan` and provide a tested fallback when targeting older distributions.

Views do not cure poor layouts. A strided traversal can waste cache-line bandwidth and defeat prefetching even though each access is constant time. Inspect loop assembly and cache counters with the actual extents and layout used in production.

A mapping can be unique, exhaustive, or strided, and custom mappings can represent padding or tiled arrangements. Those properties affect whether two index tuples can alias and whether the logical domain fills one compact physical interval. Generic kernels should constrain the properties they need instead of assuming every `mdspan` behaves like a flat array.

Extents are part static and part dynamic. Encoding stable dimensions in the type can remove stored sizes and allow loop specialization; making every dimension static can multiply template instantiations when many shapes occur. The layout decision therefore affects code size as well as data access.

## 11.6 `deque` and Segmented Storage

`std::deque<T>` is a random-access sequence stored in multiple fixed-size blocks managed through an indexing structure. The standard specifies behavior and complexity, not the number of elements per block or the shape of that indexing structure.

Endpoint insertion and removal are constant time and do not require moving all existing elements. Unlike vector growth, adding at an end generally obtains or releases a block and updates bookkeeping. Elements are not globally contiguous: taking `&d[0]` and treating it as an array is invalid, even though `d[i]` supports constant-time access.

Segmentation changes hardware costs. Random access usually needs extra arithmetic and at least one additional lookup. Sequential iteration is regular within a block but crosses block boundaries. The blocks can occupy more pages than an equivalently sized vector and are less suitable for APIs requiring a single contiguous buffer.

Deque invalidation rules depend on the operation and are more nuanced than “references are stable.” Insertion at an end invalidates iterators; references to existing elements remain valid under the standard's specified endpoint cases. Insertion in the middle can invalidate both. Consult the exact operation contract rather than applying a container-wide slogan.

A deque is useful for an unbounded double-ended work queue whose interior handles are not retained. It is not automatically a bounded latency structure: allocating a new block remains possible. A fixed ring buffer is usually a clearer fit when maximum capacity and overload behavior are known.

`deque::shrink_to_fit`, like its vector counterpart, is a nonbinding request. Clearing a deque destroys elements but does not give the application a portable statement about retained blocks. If memory retention after a burst matters, observe the chosen library and allocator, or destroy and reconstruct the deque at a synchronization point where invalidation is explicit.

Benchmark endpoint traffic and traversal separately. A microbenchmark that pushes and pops one element may remain inside already allocated blocks and miss the costly boundary transition. Exercise enough operations to cross block-map growth, and include the element size because implementations commonly choose block capacity from it.

As with every dynamically growing container, “constant-time endpoint insertion” is a complexity statement, not a guarantee that the call cannot allocate, throw, or fault a page.

## 11.7 Lists and Pointer-Chasing

`std::list<T>` is a doubly linked sequence; `std::forward_list<T>` is singly linked. Insertion or erasure at a known position is constant time and does not invalidate iterators or references to other elements. Finding that position remains linear because these are not random-access containers.

A typical list node contains the element plus one or two pointers and allocator metadata outside or around the node. Nodes commonly come from separate allocations. C++ does not require this exact layout, but the semantic requirement that nodes remain stable naturally leads to noncontiguous storage.

Pointer chasing forms a dependent load chain: the address of the next node is unknown until the current node arrives. Hardware prefetchers handle this less effectively than a contiguous stream. Each useful value may bring pointers, allocator metadata, and unused cache-line bytes with it. Branches in traversal and allocation during insertion further increase variance.

Constant-time splice is a real semantic advantage. Moving a range between compatible lists can relink nodes without moving elements; allocator compatibility requirements still apply. Stable addresses also matter when external objects retain element pointers. Those benefits must be required, not merely comforting, because a vector often wins for traversal even when it performs more nominal operations.

## 11.8 Trees: `map` and `set`

`std::map` and `std::set` are ordered associative containers. Lookup, insertion, and erasure are logarithmic in the number of elements. Iteration follows key order, and insertion does not invalidate existing iterators or references; erasure invalidates only handles to erased elements.

Implementations commonly use balanced search trees. A node usually stores child links, a parent or balance field, and the value. The standard does not mandate a red-black tree or its layout. The observable contract is ordering, uniqueness or multiplicity, complexity, and iterator behavior.

A tree lookup performs comparisons along a data-dependent path. For strings or composite keys, each comparison may itself examine multiple bytes. Nodes spread across cache lines and pages; branch direction depends on keys. Thus logarithmic complexity can have an expensive coefficient and variable latency.

Trees remain appropriate when ordered iteration, lower-bound queries, stable element addresses, and frequent interior insertion are all required. Transparent comparators can avoid constructing a temporary key:

```cpp
#include <map>
#include <string>
#include <string_view>

std::map<std::string, int, std::less<>> venue_id;
auto it = venue_id.find(std::string_view{"XNAS"});
```

This avoids one potential construction but not tree traversal. Measure comparison cost, allocation policy, and working-set size separately.

Comparator state is part of the container. Two maps with different stateful ordering policies need not interpret keys identically, and changing ordering-relevant state behind a container breaks its invariant. Keep comparators deterministic and cheap. If business ordering includes arrival priority, encode that priority in the key rather than hoping equivalent keys retain insertion order; use a multimap only when its duplicate-key semantics match the required operations.

Allocation can be addressed with a pool or `pmr` resource, but allocation policy does not restore locality automatically. A pool can place nodes closer together and bound metadata work; traversal still follows links and comparisons. Its capacity and exhaustion result must be explicit.

## 11.9 Hash Tables, Load Factors, Collisions, and Rehashing

`std::unordered_map` and `std::unordered_set` organize elements into buckets selected by a hash. Successful lookup is average constant time under ordinary hash behavior, but worst-case lookup is linear. The standard library containers are node-oriented in common implementations; open-addressing tables from other libraries have different locality and invalidation tradeoffs.

The **load factor** is `size() / bucket_count()`. Raising the maximum load factor can reduce bucket memory while increasing collision-chain work. The hash function itself may dominate for long keys. A precomputed integer instrument ID is often a better hot-path key than repeatedly hashing a symbol string, provided the mapping is established safely outside the path.

When insertion requires more buckets, **rehashing** rebuilds the bucket organization. Rehashing is linear in the number of elements and invalidates iterators, though references and pointers to elements remain valid for standard unordered associative containers. `reserve(n)` requests enough buckets for roughly `n` elements under the current maximum load factor; call it before the critical phase when a reliable bound exists.

```cpp
#include <cstdint>
#include <unordered_map>

std::unordered_map<std::uint64_t, std::uint32_t> order_slot;
void prepare_order_slots() {
    order_slot.max_load_factor(0.7f);
    order_slot.reserve(200'000);
}
```

Average constant time is not a tail guarantee. Adversarial or unlucky collisions create long chains; an unpredictable hash can expose denial-of-service behavior at input boundaries. Bucket allocation, node allocation, page faults, and cache misses add separate sources of variance. Record bucket counts and collision distributions in representative workloads; do not benchmark only uniformly random keys that production never sees.

`reserve` and `rehash` have different units. `reserve(n)` reasons about the intended element count and current maximum load factor; `rehash(b)` requests at least a bucket count. Changing `max_load_factor` after reserving can alter when the next insertion rehashes. Establish all three during construction and test the exact maximum population.

Unordered iteration order is not a persistence or replay format. Rehashing changes it, and different library releases or hashing implementations can produce different orders. If output must be deterministic, collect and sort keys or use an ordered representation. That extra work is a semantic requirement, not a benchmarking accident.

## 11.10 C++17 Node Handles

A C++17 **node handle** transfers an element out of a node-based associative container without copying or destroying its key-value object. `extract` returns an owning handle; `insert` can attach it to a compatible container. The handle's destructor releases the node if it was not reinserted.

```cpp
// Excerpt: order_slot is a unique-key associative container.
auto node = order_slot.extract(old_id);
if (node) {
    node.key() = new_id;
    auto result = order_slot.insert(std::move(node));
    if (!result.inserted) {
        // The returned result still owns the extracted node. Restore it rather
        // than letting the temporary destroy the order on a duplicate new_id.
        result.node.key() = old_id;
        auto restored = order_slot.insert(std::move(result.node));
        if (!restored.inserted)
            std::terminate(); // the component's identity invariant was broken
    }
}
```

Node handles allow changing a map key and moving nodes between containers while avoiding element allocation in compatible cases. Allocator compatibility is part of correctness: inserting a node whose allocator is not compatible can violate preconditions. Uniqueness can also make insertion fail, in which case ownership remains represented in the returned insert result. Ignoring that result can silently destroy the extracted element when the result object leaves scope.

“No element allocation” does not mean “constant cheap work.” Extraction and insertion still perform lookup, tree rebalancing, or bucket operations; an unordered insertion can trigger rehashing. Node handles are best understood as an ownership and transfer facility, not a general latency optimization.

## 11.11 C++23 Flat Associative Containers and Sorted Vectors

`std::flat_map`, `std::flat_set`, and their multikey counterparts are C++23 container adaptors that keep keys—and, for maps, values—in random-access sequence containers. Their ordered lookup is logarithmic, while insertion and erasure can move a linear suffix. Iteration has strong locality compared with node-based trees.

A sorted `vector` implements a related design directly:

```cpp
#include <algorithm>
#include <utility>
#include <vector>

using Level = std::pair<int, int>; // price ticks, quantity
void add_level(std::vector<Level>& levels, int price) {
    auto pos = std::lower_bound(levels.begin(), levels.end(), price,
        [](const Level& level, int p) { return level.first < p; });

    if (pos == levels.end() || pos->first != price) {
        levels.insert(pos, {price, 0});
    }
}
```

Binary search touches logarithmically many positions, but contiguous storage reduces pointer overhead and packs many keys per cache line. Iteration and batch construction are particularly efficient. Insertion shifts elements and may reallocate; references and iterators at or after the insertion point are invalidated, and reallocation invalidates all of them.

Bulk construction changes the tradeoff. Appending unsorted input, sorting once, and resolving duplicates can cost less than performing an ordered insertion for every item. A read-mostly snapshot can be rebuilt in a second vector and published at a safe handoff point, keeping all linear movement off readers. The publication mechanism and reclamation of the old snapshot still require the concurrency design developed in Chapters 14–17.

Flat containers are compelling for read-heavy reference data and small sets. They are less attractive for frequent interior mutation of large sets or when stable addresses are an interface requirement. C++23 library availability lagged the published standard in several widely deployed toolchains. Test `__cpp_lib_flat_map` or `__cpp_lib_flat_set`; a sorted vector or a vetted third-party flat container can be the compatibility path.

## 11.12 Stacks, Queues, and Priority Queues

`std::stack`, `std::queue`, and `std::priority_queue` are **container adaptors**: they restrict the interface of an underlying container. They do not erase its allocation, invalidation, and locality behavior.

`stack<T>` defaults to `deque<T>` and exposes last-in, first-out operations. `queue<T>` also defaults to deque and exposes first-in, first-out operations. Both can use another container satisfying the required operations. A vector-backed stack is contiguous but may reallocate; a fixed-capacity backing store can make capacity explicit.

`priority_queue<T>` defaults to a vector organized as a heap. `push` and `pop` are logarithmic, and `top` is constant time. Heap maintenance follows parent/child indices within contiguous storage, which is generally more local than a pointer tree. The order among equivalent keys is not stable unless the key includes an explicit sequence number.

The underlying-container choice is visible in the adaptor type. A `stack<T, std::vector<T>>` can reserve only by preparing and moving in a vector because the adaptor does not expose `reserve`; a project-specific bounded stack may therefore be clearer. A queue cannot use vector directly because efficient front removal is absent. These constraints prevent semantically incompatible combinations, but they do not choose an application's capacity policy.

`priority_queue::pop` does not return the removed value. Code reads or moves from `top()` and then calls `pop()`. Since `top()` is a const reference, moving a move-only value out is not directly supported by the standard interface. Store compact handles when payload ownership and extraction requirements do not fit the adaptor.

Adapters deliberately hide iteration and arbitrary mutation. If code repeatedly copies the underlying data just to inspect it, the abstraction no longer fits. For HFT queues, also distinguish an in-process sequential adapter from a concurrent queue: standard container adaptors provide no synchronization.

## 11.13 `vector<bool>`, Bitsets, and Proxy References

`std::vector<bool>` is a specialization that may pack booleans into bits. Its reference type is a proxy rather than `bool&`, because an individual bit is not an independently addressable C++ object. Reading or writing one element commonly performs a word load, mask operation, and possibly a read-modify-write.

```cpp
#include <vector>

std::vector<bool> active(1024);
void activate() {
    auto bit = active[7]; // proxy object, not bool&
    active[7] = true;
}
```

Generic code that assumes `*it` is an lvalue reference to `value_type` can fail with proxy iterators. Concurrent writes to different logical bits can race when the bits share an underlying word; the apparent indices do not imply separate memory locations.

`std::bitset<N>` has compile-time capacity and no required dynamic allocation. It supports bulk bitwise operations and counts, although exact instruction selection is implementation- and target-dependent. Dynamic bitsets from external libraries and explicit arrays of machine words make size and atomic-word policy clearer when the set grows at run time.

Bit packing reduces footprint and memory bandwidth. It increases extraction work and complicates concurrency. Use it when density or bulk bitwise operations matter, not as a transparent replacement for independent flags.

An array of `std::uint64_t` words makes bit layout and bulk operations explicit. If concurrent updates are required, an array of `std::atomic<std::uint64_t>` makes the synchronization unit one word; operations on different bits in the same word still contend on that atomic object. One byte per flag increases footprint but can reduce masking and make ownership partitioning simpler. Select the unit based on writers and access patterns, not only the number of bits stored.

## 11.14 Dense, Sparse, Direct-Addressed, and Intrusive Structures

A **direct-addressed table** uses a key, or a simple transformation of it, as an array index. Lookup is constant time with no hash or comparison, but memory consumption follows the key universe rather than the number of live elements. Price levels within a proven narrow band are a common candidate.

Dense representations store active values compactly and often use an auxiliary map from ID to dense position. Removing an item can swap the last value into its slot and update one index. This gives fast traversal but unstable order and addresses. Sparse-set designs pair a dense array with a sparse index and validate generations to reject stale handles.

An **intrusive structure** stores links inside the user object rather than allocating a wrapper node. It can eliminate per-node allocation and reduce indirections, but the object now participates in container invariants. Lifetime is external, an object may need separate hooks to join multiple structures, and erasing or destroying a still-linked object corrupts the structure.

These specialized designs turn domain bounds into performance. The price is stricter invariants and often more complex recovery. State the allowed key range, maximum population, handle lifetime, and overload behavior in the type's contract. Test stale handles, duplicate insertion, and capacity exhaustion—not just the steady-state lookup.

A generation-tagged handle illustrates the contract. Store `{index, generation}` externally; compare the generation against the slot before access; increment it when a slot is reused. This prevents an old handle from silently naming a new order in the same slot, subject to a documented generation-wrap policy. It adds metadata and a comparison but provides a stronger failure mode than a raw index or pointer.

Sparse structures should also define iteration. Walking the entire sparse key universe is predictable but potentially wasteful; maintaining a dense active-index list accelerates scans but makes deletion and order policy more complex. If deterministic replay requires key order, an unsorted dense list needs an explicit sort or a separate ordered snapshot.

## 11.15 Small-Vector Designs

A **small vector** stores up to some number of elements inside its own object and switches to dynamic storage when that inline capacity is exceeded. It combines contiguous iteration with allocation avoidance for small populations. Small-vector types are common in third-party libraries but are not a C++23 standard container.

The inline buffer makes every container object larger, even when empty. Moving a heap-backed small vector may transfer a pointer cheaply; moving an inline-backed one must move its live elements. Crossing the inline boundary can allocate and invalidate every handle. Whether a type returns to inline storage after shrinking is an implementation policy, not a general property.

Choose inline capacity from a measured distribution and object placement. Embedding 256 bytes in every order when almost all orders have zero children can inflate the working set more than it saves allocations. Conversely, an inline capacity that covers the normal case can remove allocator and first-touch variance.

If exceeding the bound is unacceptable on the hot path, prefer a true fixed-capacity vector with an explicit full result. “Usually inline” and “never allocates” are different guarantees.

Exception behavior at the transition matters. If allocation succeeds but moving an inline element throws, the implementation must meet its documented guarantee and may have performed partial work. A type with cheap `noexcept` moves makes this path simpler but still does not bound allocation. Fixed-capacity containers can instead report `full` before moving anything when the operation would exceed capacity.

Small-vector layout is a library ABI detail. Inline capacity, growth, object representation, and even the exact invalidation behavior beyond vector-like fundamentals belong to the selected implementation. Wrap a third-party type behind a project interface if changing vendors or capacities should not ripple through binary boundaries.

## 11.16 Iterator and Reference Invalidation

**Invalidation** means that a pointer, reference, iterator, span, string view, or other handle no longer designates the element it previously denoted. Dereferencing an invalid handle is undefined behavior even if the old bytes still appear unchanged.

The useful rules are operation-specific:

| Structure and operation | Existing handles |
|---|---|
| `array` ordinary element update | Remain valid |
| `vector` reallocation | All element handles invalid |
| `vector` insert without reallocation | At and after insertion invalid; earlier references/iterators remain |
| `vector` erase | Erased and following handles invalid |
| `deque` endpoint insertion | Iterators invalid; references to existing elements remain valid under specified endpoint cases |
| `list` insertion | Existing handles remain valid |
| Ordered associative insertion | Existing handles remain valid |
| Unordered rehash | Iterators invalid; element references and pointers remain valid |
| Flat or sorted-vector insertion | Shifted handles invalid; reallocation invalidates all |

This table is a review aid, not a substitute for the exact overload specification. `swap`, allocator propagation, and container-specific operations add qualifications.

Invalidation is often indirect. A span into a vector becomes invalid when another component grows the vector. A `string_view` can outlive a temporary returned from a helper. A cached unordered-map iterator fails after a reserve performed by unrelated initialization code. Encapsulate mutation with view lifetime, or use stable IDs that are resolved anew.

Handle validity does not grant thread safety. A map reference may remain valid across another insertion according to container rules, yet unsynchronized concurrent access can still form a data race. Likewise, keeping a pointer to a vector element does not permit another thread to mutate that element without the required synchronization. Invalidation and concurrency are independent contracts.

Debug iterators and sanitizers catch some misuse, but optimized production builds commonly remove those checks. Tests should force boundary events—growth, erase, rehash, and inline-to-heap transition—rather than remaining below initial capacity.

## 11.17 Stable, Amortized, Average, and Worst-Case Guarantees

A complexity label states how an abstract operation scales; it does not state its cache cost, allocation behavior, or latency distribution.

**Amortized constant time** means that the total cost of a sequence is linear in the number of operations, allowing occasional expensive operations. Vector `push_back` is the classic example: most pushes construct one element, but a growth step moves or copies all existing elements. Amortization is useful for throughput and insufficient for a deadline unless growth is excluded.

**Average constant time** usually depends on a distributional assumption. Hash-table lookup can be constant on average while a collision chain is linear in the worst case. A malicious peer or a skewed production key set can violate the friendly distribution used in a benchmark.

**Stable** has several meanings and must be qualified. A stable sort preserves the relative order of equivalent elements. A stable address survives unrelated insertions. Stable iteration order is another property again. None implies bounded execution time.

| Claim | What it establishes | What it does not establish |
|---|---|---|
| `O(1)` | Work does not grow asymptotically with `n` | No allocation, branch, lock, or cache miss |
| Amortized `O(1)` | Good total work over a sequence | Every operation is cheap |
| Average `O(1)` | Expected work under assumptions | Adversarial or worst-case bound |
| `O(log n)` | Growth is logarithmic | Better latency than contiguous `O(n)` work |
| Stable iterator | A documented mutation preserves the handle | Owner lifetime is safe or access is synchronized |

For a latency-sensitive component, document both semantic complexity and operational bounds: maximum elements, reserved capacity, maximum probe or chain length if enforced, allocation policy, and behavior when full.

## 11.18 Choosing by Mutation, Lookup, Locality, and Prefetchability

Container selection begins with required operations and invalidation semantics, then uses the workload to choose a representation. A compact decision table is more reliable than a universal ranking:

| Workload property | Likely starting point | Principal risk |
|---|---|---|
| Fixed count known in the type | `array` or fixed-capacity vector | Oversized objects or stack use |
| Append then scan | Reserved `vector` | Growth if the bound is wrong |
| Read-heavy ordered lookup | Flat container or sorted vector | Linear insertion and invalidation |
| Frequent ordered mutation with stable handles | `map`/`set` | Allocation and pointer-chasing |
| Exact integer key in a tight range | Direct-addressed table | Memory follows key range |
| General key, unordered lookup | Reserved hash table | Collisions, hashing, rehashing |
| Double-ended sequential queue | `deque` or bounded ring | Allocation or capacity policy |
| Constant-time relinking at known positions | Intrusive/list structure | Lifetime invariants and locality |

Mutation frequency alone is not enough. Ask where mutation occurs, whether readers retain handles, how often the full structure is scanned, and whether keys arrive in batches that can be sorted. A sorted vector rebuilt off the critical path may be better than a tree updated for every event.

Estimate memory per useful element, including capacity slack, bucket arrays, node links, allocator metadata, and alignment. Then consider access order. Contiguous forward traversal is prefetchable; a tree or chain creates dependent addresses. Random access to a large direct table can still miss caches, but it avoids comparison and hashing work.

Finally, test the actual distribution and the boundary events. Benchmark lookup hits and misses, insertion positions, erase patterns, cold starts, full-capacity behavior, and realistic key skew. Record allocations and page faults, and use cache and branch counters to explain results. The correct container is the one whose contract and worst relevant behavior fit the system—not the one with the shortest complexity label.

Consider an order-ID lookup as a worked decision. If IDs are dense within a bounded session range, a direct array of slots gives one indexed access but consumes memory for absent IDs. If IDs are sparse and updates dominate, a pre-sized hash table avoids ordered comparisons but still needs a collision and full-capacity policy. If readers consume immutable snapshots, sorted compact pairs can provide excellent scanning and reproducible order. The workload has not selected a container until it states the ID distribution, maximum live count, update ownership, snapshot frequency, and failure behavior.

A benchmark should include the enclosing operation. Looking up an order and then touching a large, separately allocated object may dominate differences between lookup structures. Conversely, storing the complete object inline in a hash node can inflate misses during unsuccessful lookups. Measure useful end-to-end work and use isolated microbenchmarks only to explain the result.

## 11.19 Interview Check

1. Explain why a reserved `vector` can provide better tail behavior than an unreserved one without changing `push_back`'s specified amortized complexity.
2. Compare a sorted vector, `std::map`, and `std::unordered_map` for 500 read-mostly instrument records. Include memory footprint, invalidation, lookup work, and update cost.
3. A `std::span` is passed by value and never stored. Can it still dangle during the call? Give two ways the caller could violate its lifetime contract.
4. Why can `std::list::insert` be constant time while inserting into a vector is often faster in a measured small-container workload?
5. Which handles survive an unordered-container rehash, and why is caching an iterator still unsafe?
6. Diagnose a latency spike that occurs at element 65,537 of an order table. What evidence would distinguish vector growth, hash rehashing, and a first-touch page fault?
7. Design a bounded representation for price levels in a known tick range. State its capacity, invalid-key policy, iteration order, and stale-handle behavior.
8. Explain why a small-vector optimization can reduce allocation count yet increase total cache misses in a larger enclosing structure.
9. What does average constant-time lookup guarantee, and what production key distributions could make it misleading?
10. Given a `vector<bool>` used by multiple writer threads, explain why writes to distinct indices can still form a data race and propose a representation with an explicit synchronization unit.
