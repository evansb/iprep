# 21. Lambdas and Callable Objects in Depth

A lambda is a compiler-written class with a call operator. Its capture list determines the state that class stores; the way you pass it determines whether calls inline, dispatch indirectly, or allocate. Those two facts let you price most callable code by inspection.

## What a closure weighs

Evaluating a lambda expression creates a **closure object** of a unique, unnamed closure type. Each by-value capture behaves like a data member, while implementations normally represent each reference capture with a pointer. The alignment and padding rules from Chapter 16 then determine the total size.

This common 64-bit ABI produces a useful size progression:

```cpp
#include <array>
#include <cstddef>

struct MarketSnapshot {
    std::array<std::byte, 64> bytes;
};

int main() {
    int quantity = 10;
    int price = 101;
    MarketSnapshot snapshot{};

    auto empty = [] {};
    auto one_int = [quantity] { return quantity; };
    auto two_refs = [&quantity, &price] { return quantity * price; };
    auto full_snapshot = [snapshot] { return snapshot.bytes[0]; };

    static_assert(sizeof(empty) == 1);
    static_assert(sizeof(one_int) == 4);
    static_assert(sizeof(two_refs) == 16);
    static_assert(sizeof(full_snapshot) == 64);
}
```

An empty object still needs a nonzero size so separate objects can have distinct addresses. The two reference captures occupy one pointer-sized field each on this ABI; the snapshot capture contains all 64 bytes.

**Note.** Closure member order, padding, and representation are implementation details. The assertions above document the target ABI rather than portable language guarantees; inspect `sizeof` on every production toolchain.

Creating the closure itself never performs a heap allocation. Its bytes live wherever the closure object lives: commonly a stack slot, a register, or inside another object. A wrapper may allocate when it stores that closure.

`[=]` captures only entities odr-used by the body, not every visible local. One new mention can still add a large by-value member and make every closure copy proportionally larger. A reference capture stays pointer-sized regardless of the referent, but retains the dangling risk from Chapter 9.

## Captureless lambdas and function pointers

A captureless lambda has no runtime state and converts implicitly to a pointer to a matching function. This makes it suitable for a C callback slot or a static dispatch table.

```cpp
struct Tick {
    int price;
};

using TickCallback = void (*)(const Tick&);

void publish_price(int price);
void register_tick_callback(TickCallback callback);

void install_callback() {
    auto handler = [](const Tick& tick) {
        publish_price(tick.price);
    };

    static_assert(sizeof(handler) == 1);  // this ABI
    register_tick_callback(+handler);
}
```

Unary `+` forces the function-pointer conversion. Without it, a function template could deduce the unique closure type instead.

The conversion disappears as soon as the lambda captures state:

```cpp
void install_fee_callback() {
    int fee = 2;
    TickCallback callback = [fee](const Tick& tick) {  // error: no conversion
        publish_price(tick.price - fee);
    };
}
```

A function pointer has no ownership or allocation cost. Calling through it is still an indirect call unless optimization can prove the target.

## Init-capture: computed and moved-in state

An init-capture **(C++14)** declares a new closure member with `[name = expression]`. The expression may compute a value, select a subobject, or move ownership into the closure.

Capturing an invoke-later buffer by reference dangles when the registering function returns:

```cpp
struct Order {
    int id;
};

void post(std::function<void()> callback);
void send(const std::vector<Order>& orders);

void queue_orders_badly() {
    std::vector<Order> buffer{{1}, {2}};
    post([&buffer] {
        send(buffer);  // UB when invoked later: buffer is dead
    });
}
```

Move-capture makes the closure own the buffer:

```cpp
void queue_orders() {
    std::vector<Order> buffer{{1}, {2}};

    post([orders = std::move(buffer)] {  // C++14 init-capture
        send(orders);  // closure owns the vector
    });

    // buffer is valid but moved-from here
}
```

The vector's allocation transfers into the closure instead of being copied. The original `buffer` follows the moved-from rules from Chapter 7.

Computed captures help store only what the callback needs:

```cpp
class Session {
public:
    void flush();
};

auto make_length_reader(const std::string& symbol) {
    return [length = symbol.size()] {
        return length;
    };
}

auto make_guarded_callback(std::shared_ptr<Session> session) {
    return [weak = std::weak_ptr{session}] {
        if (auto owner = weak.lock()) {
            owner->flush();
        }
    };
}
```

The first closure stores a size rather than an entire string. The second stores non-owning shared-lifetime state and checks it at invocation, using the ownership model from Chapter 8.

Copying a move-capturing closure copies its captured object if that object is copyable. A closure holding a move-only object is itself move-only.

**Pitfall.** Moving into a closure solves the source object's lifetime, not the closure's copy cost. Passing an owning closure by value can duplicate every captured buffer.

## Capturing `this`

`[this]` stores the current object pointer. `[&]` may capture that pointer when a member is named, and `[=]` historically did the same: none of these forms copies the object.

```cpp
class EventLoop {
public:
    void post(std::function<void()> callback);
    void run_one();
};

class ExchangeSession {
public:
    explicit ExchangeSession(int venue) : venue_(venue) {}

    void register_fill(EventLoop& loop) {
        loop.post([this] { on_fill(42); });
    }

    void register_fill_snapshot(EventLoop& loop);

private:
    void on_fill(int order_id) const;
    int venue_;
};

void demonstrate_dangle(EventLoop& loop) {
    {
        ExchangeSession session{7};
        session.register_fill(loop);
    }                 // session dies
    loop.run_one();   // UB: callback's this pointer dangles
}
```

The event loop is single-threaded; “later” is enough to cause the bug. Callback execution on another thread adds synchronization concerns as well (Chapter 23).

`[*this]` **(C++17)** copies the complete object into the closure:

```cpp
void ExchangeSession::register_fill_snapshot(EventLoop& loop) {
    loop.post([*this] { on_fill(42); });  // C++17
}
```

The callback now observes a snapshot and remains valid after the original object dies. Copying a large session into every callback may be expensive, and later changes to the original are intentionally invisible.

Use these lifetime rules:

- Use `[this]` only when the object provably outlives every invocation.
- Use `[*this]` when an independent snapshot has the right semantics.
- Capture a `std::weak_ptr` and call `lock()` when lifetime is dynamic.
- Write `this` explicitly; implicit `this` capture through `[=]` is deprecated since C++20.

**Interview.** Given `[=] { return member_; }`, identify that member access requires `this` and that the closure stores a pointer, not a copy of `member_`. A strong answer states the lifetime precondition and offers `[*this]` or `weak_ptr` when it cannot be met.

The capture list is an ownership and lifetime declaration. This table summarizes the invoke-later choices:

| Capture | Closure stores | Owns captured state? | Copy cost | Lifetime condition | Typical use |
|---|---|---:|---|---|---|
| `[&value]` | reference-like address | No | pointer-sized | `value` outlives every call | synchronous local algorithm |
| `[value]` | value copy | Yes, its copy | size/copy cost of `value` | closure owns independent value | small immutable snapshot |
| `[value = std::move(value)]` | moved-in value | Yes | move at creation; later copies depend on value | closure owns transferred state | queued buffer or unique handle |
| `[this]` | object pointer | No | pointer-sized | object outlives every call | tightly scoped member callback |
| `[*this]` | complete object copy | Yes, snapshot | size/copy cost of object | independent of original | immutable delayed snapshot |
| `[weak = std::weak_ptr{owner}]` | weak owner handle | No strong ownership | weak-handle bookkeeping | call must successfully `lock()` | cancellable lifetime-bound callback |

```text
register callback                         invoke later

[&value] or [this]  ---- borrowed address ----> owner must still be alive
[value] or [*this]  ---- owned snapshot ------> reads captured copy
[weak]              ---- weak observation ----> lock succeeds or skip work
```

Capture defaults hide this decision across every name used in the body. Explicit captures make review local: each stored member and lifetime contract is visible at the lambda introducer.

**Rule.** For invoke-later code, review the capture list exactly like a class's data members. Every reference-like capture needs a named owner and an invocation deadline.

## Mutable lambdas

A lambda's generated `operator()` is `const` by default. By-value captures are therefore read-only through an ordinary closure object.

`mutable` removes that `const` qualification and permits per-closure state:

```cpp
#include <iostream>

int call_copy(auto counter) {
    return counter();
}

int main() {
    auto generator = [sequence = 0]() mutable {
        return ++sequence;
    };

    auto first = generator;
    auto second = generator;
    std::cout << first() << ' ' << second() << '\n';  // prints: 1 1

    (void)call_copy(generator);
    std::cout << generator() << '\n';                 // prints: 1
}
```

Each copy has its own `sequence` member. Calling the parameter in `call_copy()` mutates only the parameter's copy, not the caller's closure.

Standard algorithms may copy their callable objects, as discussed in Chapter 13. Do not rely on one mutable closure instance accumulating algorithm-wide state. Put shared state outside the closure and capture it by reference with a proven lifetime, or pass an explicit stateful function object through `std::ref` when identity matters.

## `constexpr` lambdas

A lambda whose body can be evaluated at compile time has an implicitly `constexpr` call operator since C++17. Writing `constexpr` explicitly requests that property and produces a diagnostic when the body cannot satisfy it.

`std::sort` became usable during constant evaluation in C++20, so a lambda comparator can build a table before the program starts:

```cpp
#include <algorithm>
#include <array>

constexpr auto sorted_tick_sizes() {
    std::array ticks{25, 1, 10, 5};
    std::sort(ticks.begin(), ticks.end(),
              [](int left, int right) constexpr {  // C++20 constant evaluation
                  return left < right;
              });
    return ticks;
}

constexpr auto tick_sizes = sorted_tick_sizes();
static_assert(tick_sizes == std::array{1, 5, 10, 25});
```

The sorted values reside in the program image; no startup sort runs. Captures are allowed, but every value used during constant evaluation must itself be permitted in a constant expression. Chapter 22 provides the complete rule set.

## Callable wrappers: the cost of type erasure

`std::function<R(Args...)>` owns any copyable callable with the requested call signature. It erases the callable's concrete type, storing an erased invoker alongside either the callable itself or a pointer to it.

Implementations use a small-buffer optimization (SBO), analogous to the string optimization from Chapter 12. A sufficiently small closure fits inside the wrapper; a larger closure requires dynamic allocation. The erased invoker adds an indirect call that the optimizer usually cannot inline through.

**Note.** SBO capacity and eligibility vary among libstdc++, libc++, and MSVC. Inline buffers are commonly in the 16–32 byte range, but that range is an implementation detail, not a contract.

Replacement `operator new` instrumentation from Chapter 17 makes the allocation visible:

```cpp
#include <array>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <new>

std::size_t allocations = 0;

void* operator new(std::size_t bytes) {
    ++allocations;
    if (void* memory = std::malloc(bytes)) {
        return memory;
    }
    throw std::bad_alloc{};
}

void operator delete(void* memory) noexcept {
    std::free(memory);
}

void operator delete(void* memory, std::size_t) noexcept {
    std::free(memory);
}

int main() {
    int bias = 1;
    auto small = [bias](int value) { return value + bias; };
    std::array<char, 64> payload{};
    auto large = [payload](int value) { return value + payload[0]; };

    std::size_t before = allocations;
    std::function<int(int)> small_fn = small;
    std::size_t small_count = allocations - before;

    before = allocations;
    std::function<int(int)> large_fn = large;
    std::size_t large_count = allocations - before;

    std::printf("small allocations: %zu\n", small_count);
    std::puts(large_count > 0 ? "large: allocation observed"
                              : "large: no allocation observed");
}
```

Typical standard libraries report zero for the small closure and an allocation for the 64-byte capture. The observation, not a fixed threshold, is the point. Copying a heap-backed `std::function` allocates new storage and copies the target again.

A non-owning callable view erases only the call operation. Its shape is a pointer to an existing callable plus an erased invoker:

```cpp
class FunctionRef {
public:
    template<class F>
    FunctionRef(F& function) noexcept
        : object_(&function),
          invoke_([](void* object, int value) {
              return (*static_cast<F*>(object))(value);
          }) {}

    int operator()(int value) const {
        return invoke_(object_, value);
    }

private:
    void* object_;
    int (*invoke_)(void*, int);
};
```

This sketch owns nothing and allocates nothing. The referenced callable must outlive every call, exactly as a `std::string_view` must not outlive its characters (Chapter 12). `std::function_ref` **(C++26)** standardizes this category; library availability should be treated as a preview.

Choose a passing mechanism deliberately:

| Mechanism | Call overhead | Ownership | Constraints | Hot-path verdict |
|---|---|---|---|---|
| Template parameter | Usually inline | Caller retains | Definition visible; instantiates per type | Preferred |
| Function pointer | Indirect call | None | Captureless target, fixed signature | Good when target varies |
| `function_ref`-style view | Indirect call | None | Callable must outlive view | Good at non-owning boundary |
| `std::function` | Erased indirect call; possible allocation | Owns copy | Target must be copyable | Cold-path storage |
| `std::move_only_function` (C++23) | Erased indirect call; possible allocation | Owns target | Accepts move-only target | Cold-path move-only storage |

Templates preserve the concrete closure type and let the compiler inline, at the code-size tradeoff from Chapter 20. Function pointers and callable views erase identity without owning state. Owning wrappers are appropriate when configuration code must retain heterogeneous callbacks.

**Rule.** A hot path takes a callable as a template parameter or a measured non-owning view. Keep `std::function` construction and invocation off the tick path.

**Pitfall.** Building an over-SBO `std::function` inside a loop can allocate every iteration. Storing a `FunctionRef` beyond the call can instead dangle; lower overhead does not relax lifetime rules.

## Latency Lens

- Closure size follows the capture list: every by-value capture is a member, so a fat closure makes copies, moves, and wrapper storage proportionally heavier.
- A captureless lambda converts to a function pointer with no state or allocation; an indirect call remains unless optimization proves its target.
- A lambda passed as a template parameter can inline into the algorithm, while the same lambda behind `std::function` normally dispatches through an opaque invoker.
- `std::function` allocates when its target misses the implementation's SBO criteria, and copying a heap-backed wrapper allocates and copies again.
- `[*this]` pays for a full object copy at capture time to remove dependence on the original lifetime; `[this]` stores one pointer but can dangle.
- Explicit capture matrices expose whether each callback owns, borrows, snapshots, or weakly observes its state before the callback crosses an asynchronous boundary.
- Copying a mutable closure duplicates its state, so algorithm copies update separate members rather than one shared counter.
- A compile-time-sorted lookup table moves sorting from startup to translation and stores the result directly in the program image.
- A `function_ref`-style view is typically a callable pointer plus an invoker pointer with no allocation; its cost is strict non-owning lifetime discipline.
