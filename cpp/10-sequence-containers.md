# 10. Sequence Containers

Sequence containers own elements in an order you control. Their interfaces look similar, but their storage layouts produce radically different allocation, locality, and invalidation behavior. `std::vector` is the default; every other choice needs a stated reason.

## What sequence containers promise

A sequence container stores owned objects in a programmer-chosen order. Inserting an object copies or moves it into the container; erasing it destroys that stored object. The container then destroys all remaining elements when its own lifetime ends, following RAII (Chapter 5).

```cpp
#include <iostream>
#include <vector>

int main() {
    std::vector<int> prices;
    prices.push_back(101);
    prices.push_back(103);
    prices.push_back(102);

    std::cout << prices.size() << ' ' << prices.front()
              << ' ' << prices.back() << '\n';  // prints: 3 101 102
    for (int price : prices) {
        std::cout << price << ' ';                // prints: 101 103 102
    }
}
```

The common vocabulary includes `size()`, `empty()`, `front()`, `back()`, `push_back()`, `insert()`, `erase()`, `clear()`, `begin()`, and `end()`. Not every container supports every operation: a fixed-size `std::array` cannot grow, and `std::forward_list` has no `back()`.

The decisive difference is storage layout:

- Contiguous containers place elements next to one another: `std::array` and `std::vector`.
- `std::deque` uses multiple contiguous chunks connected through a small index structure.
- Node-based containers allocate separate linked nodes: `std::list` and `std::forward_list`.

Contiguous storage turns traversal into predictable address arithmetic. One cache-line fetch supplies several nearby elements, and hardware prefetch recognizes the stride. A linked list instead loads a pointer before it knows the address of the next node.

| Operation | `array` | `vector` | `deque` | `list` |
|---|---:|---:|---:|---:|
| Index with `[]` | O(1) | O(1) | O(1) | — |
| `push_back` | — | Amortized O(1) | O(1) | O(1) |
| `push_front` | — | O(n) | O(1) | O(1) |
| Insert in middle | — | O(n) | O(n) | O(1), given position |
| Erase in middle | — | O(n) | O(n) | O(1), given position |
| Traversal layout | Contiguous | Contiguous | Chunked | Pointer chase |

The element type generally must support the moves or copies needed by the operation. An insertion into the middle of a `vector`, for example, shifts later elements.

## `std::vector` — the default

A `std::vector<T>` owns a dynamically sized contiguous array of `T`. Indexing is cheap, traversal has excellent locality, and `data()` exposes a pointer to the first element. Start with `vector` unless a requirement rules it out.

A typical implementation stores three pointers:

```text
              begin          end                  capacity end
                |             |                        |
                v             v                        v
storage:      [ Tick | Tick | Tick | uninitialized | uninitialized ]
```

`size()` is the distance from `begin` to `end`; `capacity()` is the distance from `begin` to the capacity end. The object itself is typically three pointers wide, while its elements live in a separate heap allocation. The representation and exact size are implementation details.

```cpp
std::vector<int> values;
std::cout << values.size() << ' ' << values.capacity() << '\n';
// prints: 0 0 on common implementations

values.push_back(7);
values.push_back(9);
std::cout << values.size() << ' ' << values.capacity() << '\n';
// size is 2; capacity is at least 2
```

`values[i]` performs no bounds check. `values.at(i)` checks the index and throws `std::out_of_range` on failure, using the exception mechanism from Chapter 6. Hot code commonly uses `operator[]` after validating the index at a boundary, with an assertion preserving the assumption in debug builds.

**Note.** `std::vector<bool>` is a packed-bit specialization, not an ordinary `vector` of `bool` objects. Its `operator[]` returns a proxy rather than `bool&`; avoid it when ordinary element semantics matter, using `std::vector<char>` or the fixed-size facilities in Chapter 14.

The allocator parameter in `std::vector<T, Allocator>` controls how storage is acquired. Allocator-aware containers belong to Chapter 18.

## Growth, capacity, and `reserve`

When `size() == capacity()`, another insertion cannot fit. The vector allocates a larger block, constructs every existing element in the new block by moving or copying it, destroys the old elements, and releases the old block.

Capacity grows geometrically, commonly by a factor between 1.5 and 2; the factor is an implementation detail. Consequently, `n` calls to `push_back()` perform O(n) total relocation work, making each insertion amortized O(1). An individual insertion that grows the vector is still an O(n) latency spike; the full amortized analysis appears in *Algorithms*.

This trace exposes the relocation waves:

```cpp
#include <cstdio>
#include <vector>

struct Tick {
    int price;

    explicit Tick(int p) : price{p} { std::puts("construct"); }
    Tick(const Tick& other) : price{other.price} { std::puts("copy"); }
    Tick(Tick&& other) noexcept : price{other.price} {
        std::puts("move");
    }
};

int main() {
    std::puts("growing:");
    std::vector<Tick> growing;
    for (int price = 100; price < 105; ++price) {
        growing.emplace_back(price);
    }

    std::puts("reserved:");
    std::vector<Tick> reserved;
    reserved.reserve(5);
    for (int price = 100; price < 105; ++price) {
        reserved.emplace_back(price);
    }
    // The reserved section prints five "construct" lines and no moves.
}
```

The exact unreserved trace depends on the implementation's growth policy. Each capacity change prints one `move` for every element already stored. Because `Tick` has a `noexcept` move constructor, `vector` can relocate with moves while preserving its exception guarantee.

If the move constructor might throw and copying is available, `vector` generally copies during growth:

```cpp
struct CopyFallback {
    CopyFallback() = default;
    CopyFallback(const CopyFallback&) { std::puts("copy"); }
    CopyFallback(CopyFallback&&) { std::puts("move"); }  // not noexcept
};

std::vector<CopyFallback> items;
items.reserve(1);
items.emplace_back();
items.emplace_back();  // prints: copy
```

This is the performance consequence of `noexcept` move construction introduced in Chapter 7.

Call `reserve(n)` when an upper bound or good estimate is available. It performs at most one allocation immediately and guarantees that insertion cannot reallocate until the size exceeds `n`.

`reserve()` and `resize()` answer different questions:

| Operation | Changes `size()` | Constructs elements | May allocate |
|---|---:|---:|---:|
| `reserve(n)` | No | No | Yes |
| `resize(n)` | Yes | Yes when growing | Yes |

```cpp
std::vector<int> quantities;
quantities.reserve(100);
quantities[5] = 42;  // UB: size() is still zero

quantities.resize(100);
quantities[5] = 42;  // valid
```

**Pitfall.** Capacity is raw storage, not a collection of live objects. `operator[]` requires an index below `size()`, regardless of `capacity()`.

`shrink_to_fit()` is a non-binding request to reduce capacity. It may reallocate and move every element, invalidating all positions and references, or it may do nothing.

## Iterator invalidation — the centerpiece

An iterator denotes a position in a container; pointers and references can denote its elements directly. An operation invalidates one of these handles when the storage is released or an element shifts away from that position. Using an invalid handle has undefined behavior.

For `vector`, a reallocation invalidates every iterator, pointer, and reference. Without reallocation, insertion invalidates handles at or after the insertion point, and erasure invalidates handles at or after the erased element.

| Container and operation | Iterators | References and pointers |
|---|---|---|
| `vector`, growth | All invalid | All invalid |
| `vector`, insert without growth | At/after point invalid | At/after point invalid |
| `vector`, erase | At/after point invalid | At/after point invalid |
| `vector`, `reserve` that reallocates | All invalid | All invalid |
| `array` | Never, while array lives | Never, while array lives |
| `deque`, push at either end | All invalid | Existing elements remain valid |
| `deque`, insert in middle | All invalid | All invalid |
| `list`, insert | None | None |
| `list`, erase | Erased elements only | Erased elements only |
| `forward_list`, insert | None | None |
| `forward_list`, erase | Erased elements only | Erased elements only |

Saving `data()` does not bypass these rules:

```cpp
std::vector<int> prices{100, 101};
int* first = prices.data();

prices.push_back(102);  // may reallocate
std::cout << *first;    // UB if reallocation occurred
```

The same trap applies to an iterator saved before a reallocating `reserve()`. Reserve first, then take addresses or positions.

Erasing while a loop retains an invalidated iterator is another classic failure:

```cpp
for (auto it = orders.begin(); it != orders.end(); ++it) {
    if (it->filled) {
        orders.erase(it);  // UB: loop increments an invalid iterator
    }
}
```

The old spelling compacts the retained elements, then erases the tail:

```cpp
orders.erase(
    std::remove_if(orders.begin(), orders.end(),
                   [](const Order& order) { return order.filled; }),
    orders.end());
```

C++20 adds `std::erase_if`, the direct expression of that intent:

```cpp
std::erase_if(orders, [](const Order& order) {
    return order.filled;
});
```

The erase-remove pattern and iterators are formalized in Chapter 13.

**Rule.** After any structural container operation, prove that every retained iterator, pointer, and reference survives according to that container's invalidation rules.

## `std::array` — fixed size, zero overhead

`std::array<T, N>` wraps a built-in array without losing its size or value semantics. `N` is part of the type, so `std::array<int, 4>` and `std::array<int, 8>` are different types. It allocates nothing; its elements live inside the `array` object, whether that object is local, static, or a class member.

```cpp
#include <array>
#include <iostream>

std::array<double, 2> spread() {
    return {99.95, 100.05};
}

int main() {
    std::array<double, 4> depths{12.0, 8.0, 5.0, 3.0};
    static_assert(sizeof(depths) == 4 * sizeof(double));

    auto [bid, ask] = spread();
    std::cout << bid << ' ' << ask << '\n';  // prints: 99.95 100.05
}
```

An `array` is copyable and comparable, supports the usual container operations, and does not decay to a pointer when passed to a function. It solves the built-in array decay problem from Chapter 2 with the same storage cost. `std::get<I>` and the tuple protocol provide compile-time indexed access; structured bindings receive formal treatment in Chapter 22.

```cpp
void clear_depths(std::array<int, 64>& depths) {
    depths.fill(0);
}

void prepare_depths() {
    std::array<int, 64> bad;       // local elements have indeterminate values
    bad[0] = 1;                    // only this element is now initialized
    std::array<int, 64> good{};    // all elements are zero
    clear_depths(good);            // no 64-element argument copy
}
```

**Pitfall.** Default initialization does not zero the scalar elements of a local `std::array`. Use `{}` when zero initialization is required, and pass large arrays by reference unless a copy is intentional.

## Fixed capacity and small-vector: the low-latency workhorses

`std::inplace_vector<T, N>` **(C++26)** presents a vector-like interface with capacity fixed at compile time. Its element storage sits inside the object, so it never allocates and never invalidates handles through reallocation. Middle insertion and erasure still shift elements and invalidate handles from the changed position onward.

```cpp
#include <inplace_vector>  // C++26

struct Order {
    int id;
    int quantity;
};

std::inplace_vector<Order, 8> book_level;  // C++26: inline storage

bool add_order(Order order) {
    if (!book_level.try_push_back(order)) {
        return false;  // full; no exception and order was not inserted
    }
    return true;
}
```

Ordinary insertion past capacity throws `std::bad_alloc`; the `try_` form reports a full container without throwing. Bounded book depth, per-message scratch data, and fixed fan-out are natural uses: the capacity limit is both a domain invariant and an allocation guarantee.

The allocator parameter is deliberately absent. Custom fixed-capacity vector types exist for C++23 codebases, but their exact APIs are library-specific.

A small-vector stores its first `N` elements inline and spills to heap storage only when it outgrows that buffer. The standard library has no small-vector type; widely used implementations include `boost::container::small_vector` and `folly::small_vector`.

```text
inline mode
[ size | inline Tick | inline Tick | unused ]

spilled mode
[ size | heap pointer | heap capacity ] ----> [ Tick | Tick | Tick | ... ]
```

This hybrid wins when sizes are usually at most `N`, elements are small, and containers are frequently created and destroyed. The common case avoids allocation and keeps element zero inside the owning object.

Inline storage changes move cost. A heap-backed `vector` can usually transfer ownership by swapping pointers, but an inline small-vector cannot point into the old object's interior. Moving it must move each live element, making the move O(n), and every address into the inline buffer changes.

**Pitfall.** Inline capacity contributes directly to object size. Passing `small_vector<T, 64>` by value may copy or move a large inline population and places a large object wherever the container itself lives.

## `std::deque` — chunked, stable ends

A `std::deque<T>` uses an indexed collection of fixed-size chunks. It behaves like random-access storage without requiring one large contiguous block.

```text
page map:  [ * ] [ * ] [ * ]
              |     |     |
              v     v     v
pages:     [T T T] [T T T] [T T T]
```

The chunked layout supports O(1) insertion and removal at both ends. Inserting at an end invalidates iterators, but references and pointers to existing elements remain valid. There is no single giant reallocation that moves every element.

The price is more complicated access. Indexing first locates a page and then an element inside it; traversal crosses page boundaries, and growing the deque can allocate more pages. A contiguous `vector` usually scans faster.

```cpp
struct Trade {
    int price;
    int quantity;
};

void record(std::deque<Trade>& window, Trade trade, std::size_t limit) {
    window.push_back(trade);
    if (window.size() > limit) {
        window.pop_front();
    }
}
```

Choose `deque` for a genuine double-ended FIFO that is too large or unpredictable to reserve. `std::queue` uses `deque` as its default underlying container. Otherwise, a reserved `vector` plus an index often wins; lock-free ring buffers appear in Chapter 26.

## `std::list` and `std::forward_list` — the cache poison

A `std::list<T>` node holds a `T` plus links to the previous and next nodes. A `std::forward_list<T>` keeps only the next link. Each node is normally a separate allocation.

```text
vector:
[T][T][T][T][T]

list:
[prev|T|next] -->       [prev|T|next] --> [prev|T|next]
       ^                         scattered heap nodes
```

List traversal is a dependent pointer chase: the processor cannot issue the load for the next node until it has loaded the current node's link. Scattered allocations make a cache miss at each hop plausible, while `vector` shifts contiguous bytes that caches and prefetchers handle well.

The advertised O(1) insertion or erasure assumes the position is already known. Finding that position is O(n), with poor locality at every step. For realistic element counts, `vector` often wins in elapsed time even when it moves many elements.

Lists have legitimate uses:

- Iterators and references must survive arbitrary insertions and unrelated erasures.
- Whole elements or ranges must move between lists without moving the elements.
- The element type cannot be moved or copied.

`splice()` relinks nodes between compatible lists:

```cpp
std::list<int> active{1, 2};
std::list<int> pending{3, 4};

active.splice(active.begin(), pending);
// O(1), no element moves or copies; active is {3, 4, 1, 2}
```

`std::forward_list` removes the back link and even omits `size()`. Its interface uses `insert_after()` and `erase_after()` because a singly linked node cannot reach its predecessor. The smaller node is useful only in narrow cases.

Intrusive lists put the link fields inside the element and perform no per-node allocation. That is the linked structure more often found in low-latency systems; intrusive containers are covered in *Algorithms*.

**Interview.** “Insertion is O(1)” is not a sufficient reason to choose `list`. A strong answer includes the cost of finding the position, per-node allocation, pointer chasing, invalidation requirements, and a measurement against `vector`.

`std::list` supplies its own `sort()` because `std::sort` requires random access, which a linked list cannot provide.

## Container adaptors: restricting an underlying sequence

`std::stack`, `std::queue`, and `std::priority_queue` are **container adaptors**. They own an underlying sequence container but expose only the operations required by one abstract access pattern.

| Adaptor | Default underlying container | Access discipline | Principal operations | Arbitrary iteration or erase? |
|---|---|---|---|---:|
| `std::stack<T>` | `std::deque<T>` | last in, first out | `push`, `emplace`, `top`, `pop` | No |
| `std::queue<T>` | `std::deque<T>` | first in, first out | `push`, `emplace`, `front`, `back`, `pop` | No |
| `std::priority_queue<T>` | `std::vector<T>` | greatest-priority element first | `push`, `emplace`, `top`, `pop` | No |

The adaptor deliberately hides iterators. If callers need to scan, remove an arbitrary element, or retain positions, the adaptor is the wrong interface even when its underlying container could perform that work.

```cpp
#include <queue>
#include <string>

struct Event {
    long deadline_ns;
    std::string name;
};

struct EarlierDeadline {
    bool operator()(const Event& left, const Event& right) const {
        return left.deadline_ns > right.deadline_ns;
    }
};

using DeadlineQueue =
    std::priority_queue<Event, std::vector<Event>, EarlierDeadline>;

void dispatch(const Event&);

void run_due(DeadlineQueue& events, long now_ns) {
    while (!events.empty() && events.top().deadline_ns <= now_ns) {
        Event event = events.top();
        events.pop();
        dispatch(event);
    }
}
```

`priority_queue` is a max-heap by default. Reversing the comparison above makes the earliest deadline appear at `top()`, producing a min-heap. Reading `top()` is O(1); insertion and removal are O(log n). The underlying vector remains contiguous, but a growth event can still allocate and relocate its elements.

There is no operation that removes a queued event by ID or decreases one event's priority in place. A cancellation-heavy scheduler can keep a separate ID table and mark events cancelled lazily, or use an indexed heap whose position map supports updates. The adaptor is best when work enters, the current extreme leaves, and arbitrary mutation is not part of the contract.

`stack` and `queue` accept another compatible underlying container as their second template argument. A `queue<T, std::list<T>>` is legal but buys per-node allocation and pointer chasing without changing the FIFO interface. The default `deque` normally provides the useful balance of O(1) operations at both ends and chunked growth.

**Pitfall.** `pop()` returns `void`. Read from `top()` or move from a mutable `front()` before calling `pop()`; the removal destroys that element. A `priority_queue` exposes its top as `const T&`, so extracting it normally copies unless the design adds indirection.

**Rule.** Choose an adaptor when its restricted interface expresses the invariant. Choose the underlying container directly when the algorithm genuinely needs iteration or arbitrary mutation.

## Choosing a sequence container

Start with `std::vector`; move down this table only when a requirement names the reason.

| Need | Container | Why |
|---|---|---|
| Default | `vector` | Contiguous; cheapest scans; amortized growth |
| Size known at compile time | `array` | Zero overhead; no allocation |
| Hard capacity bound, no heap | `inplace_vector` **(C++26)** | Inline storage; no growth invalidation |
| Usually small, occasionally large | Boost/Folly `small_vector` | No allocation in common case |
| Fast push/pop at both ends | `deque` | Stable end references; chunked pages |
| Stable handles and O(1) splice | `list` | Per-node allocation buys stability |
| Minimal node, forward-only | `forward_list` | One link per node; niche |
| LIFO access only | `stack` adaptor | Makes the restricted access discipline explicit |
| FIFO access only | `queue` adaptor | Hides all operations except the two ends |
| Repeated access to one extreme | `priority_queue` adaptor | Heap-backed O(1) top and O(log n) push/pop |

A per-symbol trade history normally uses `vector`. Reserve the session's expected upper bound before the hot path, append trades, and scan contiguous records.

A book level with a protocol-defined maximum depth uses `inplace_vector` **(C++26)** or a project fixed-capacity equivalent. The type records the bound, and overflow takes an explicit failure path instead of allocating.

## Latency Lens

- `vector` scans exploit contiguous elements: one cache line supplies multiple values, and hardware prefetch sees the stride.
- Each `list` or `forward_list` hop is a dependent load; the next address is unknown until the current node arrives.
- `vector` growth performs an allocation, O(n) element relocations, and a free; `reserve()` before the hot loop removes those spikes until capacity is exhausted.
- Growth moves elements only when their move construction is `noexcept`; otherwise an available copy can silently replace each move.
- `inplace_vector` and inline-mode small-vectors avoid heap allocation and keep the first element inside the owner.
- Moving an inline small-vector is O(n) element work, unlike transferring a heap-backed `vector`'s pointers.
- `deque` adds page lookup and breaks a scan's contiguous stride at page boundaries; it buys efficient operations at both ends.
- Per-node list allocation adds allocator metadata and fragmentation, scattering nodes further as heap state evolves.
- `priority_queue` keeps a heap in contiguous storage, but vector growth still creates an allocation-and-relocation spike; bounded schedulers should reserve through a deliberately constructed underlying container.
- `shrink_to_fit()` may perform a complete allocate-move-free cycle and invalidate every handle; keep it off hot paths.
