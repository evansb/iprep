# Chapter 4 — Values, References, Moves, and Special Members

Move semantics is frequently summarized as “moves are cheap,” but C++ promises no such thing. A move begins with an expression category, selects an overload, and then executes whatever that overload defines. References affect aliasing and lifetime without owning storage, while compiler-generated special members can silently disappear when a class changes. This chapter builds the exact model needed to predict copies, moves, elision, and their effects on allocation, cache traffic, and latency tails.

## 4.1 lvalues, xvalues, prvalues, glvalues, and rvalues

Every expression has a type and a **value category**. The category describes how the expression identifies or initializes an object; it is not a property permanently attached to the object's type.

The categories form this hierarchy:

```text
expression
├── glvalue: identifies an object or function
│   ├── lvalue: identity, not expiring
│   └── xvalue: identity, potentially expiring
└── prvalue: computes a value for initialization

rvalue = prvalue or xvalue
```

An **lvalue** has identity and is not designated for resource reuse. A named variable is an lvalue expression even when its declared type is an rvalue reference. An **xvalue** is a glvalue that identifies an object whose resources may be reused. A **prvalue** computes a value, usually to initialize a result object. **glvalue** groups lvalues and xvalues; **rvalue** groups xvalues and prvalues.

```cpp
#include <string>
#include <utility>

std::string make_name();

void categories() {
    std::string name = make_name();
    name;                 // lvalue expression
    std::move(name);      // xvalue expression
    std::string{"ITCH"}; // prvalue expression
}
```

Since C++17, a class prvalue is not generally a separate temporary waiting to be moved. It initializes its result object directly unless materialization is required. This model supports guaranteed copy elision in Section 4.14.

Categories drive overload resolution:

```cpp
void submit(const Order&); // can bind lvalues and rvalues; does not consume
void submit(Order&&);      // can bind rvalues; may consume
```

The second overload is not automatically faster. It merely receives permission to modify an object selected as expiring. Whether it allocates, copies bytes, transfers pointers, or does nothing depends on `Order` and `submit`.

Expression category also does not report whether an object is physically temporary. `std::move(name)` is an xvalue referring to the same named object; no second object appears. Conversely, materializing a prvalue can create storage even though there was no variable name in the source. Keep the source-level category model separate from ABI lowering and storage placement.

Built-in operators have category rules too. Dereferencing a pointer normally produces an lvalue; a function call returning `T&` is an lvalue; one returning `T&&` is an xvalue; one returning `T` is a prvalue. Member access generally follows the category of its object with important exceptions. These facts propagate through generic code before any move constructor is considered.

When diagnosing hidden work, ask three questions: What category does the expression have? Which overload is viable? What does the selected function actually do? Compiler AST dumps and deliberately deleted overloads can confirm answers when source is subtle.

## 4.2 Reference Binding and Collapsing

A reference is an alias established by initialization. It is not an owning object and does not extend lifetime except under specific temporary-binding rules discussed in Section 3.7.

An lvalue reference `T&` normally binds to an lvalue. A `const T&` can also bind to rvalues, materializing a temporary when needed. An rvalue reference `T&&` normally binds to an rvalue.

```cpp
Order order{};
Order& a = order;
const Order& b = Order{}; // extends this temporary to b's lifetime
Order&& c = Order{};      // also extends this temporary locally
```

The reference itself need not occupy storage, but implementations commonly represent reference data members and reference parameters that must survive lowering as addresses. C++ specifies aliasing behavior, not representation or size.

When template substitution or alias composition creates a reference to a reference, **reference collapsing** produces one reference type:

| Written combination | Collapsed type |
|---|---|
| `T& &` | `T&` |
| `T& &&` | `T&` |
| `T&& &` | `T&` |
| `T&& &&` | `T&&` |

Informally, any lvalue reference in the combination wins.

```cpp
template<class T>
using RvalueRef = T&&;

using A = RvalueRef<int>;  // int&&
using B = RvalueRef<int&>; // int& after collapsing
```

References can improve interfaces by avoiding a copy, but they can also introduce dependent loads and inhibit optimization when aliasing is possible. Passing a small scalar by reference may require a load through a pointer where passing it by value would use a register. The correct choice expresses ownership and mutation first; Chapter 6 compares calling costs.

Reference binding can add qualification but cannot discard it. A `const Order&` can observe a mutable `Order`, while an `Order&` cannot bind to a const object. `volatile` is a separate access qualifier and is not a thread-synchronization mechanism.

Reference data members make assignment semantics awkward because a reference cannot be reseated. The compiler commonly deletes default assignment when memberwise assignment would require reseating. A pointer or `std::reference_wrapper` can express a rebindable relationship, but neither owns the target.

## 4.3 Forwarding References

A **forwarding reference** is an rvalue reference to a cv-unqualified template parameter whose type is being deduced in the relevant context. It can bind to either lvalues or rvalues and preserves that information in the deduced type.

```cpp
template<class T>
void relay(T&& value);

Order order;
relay(order);        // T is Order&, parameter collapses to Order&
relay(Order{});      // T is Order, parameter is Order&&
relay(std::move(order)); // T is Order, parameter is Order&&
```

Not every `T&&` is a forwarding reference:

```cpp
template<class T>
struct Box {
    void set(T&&); // T belongs to Box; not deduced by this call

    template<class U>
    void emplace(U&&); // U is deduced; forwarding reference
};

void take(const auto&& value); // const prevents forwarding-reference status
```

C++20 abbreviated function templates such as `void f(auto&& x)` can create forwarding references. They reduce syntax but not instantiation count or semantic complexity.

Forwarding references are useful at a boundary whose job is transparent delegation: container emplacement, factories, and wrapper call operators. They are often unnecessary for domain operations. A `submit(Order)` interface is easier to reason about than a template accepting nearly any type.

Each deduced type can instantiate another function body. That may enable inlining and remove abstraction overhead, but it can also increase compile time and instruction-cache footprint. Measure the final program rather than treating template dispatch as universally free.

Constrain forwarding constructors so they do not hijack copy and move construction:

```cpp
template<class T>
class Wrapper {
public:
    template<class U>
        requires (!std::same_as<std::remove_cvref_t<U>, Wrapper>) &&
                 std::constructible_from<T, U>
    explicit Wrapper(U&& value)
        : value_(std::forward<U>(value)) {}

private:
    T value_;
};
```

C++20 concepts improve overload participation and diagnostics. They do not reduce the construction work selected after a call is accepted.

## 4.4 `std::move` as a Cast

`std::move` does not move an object. It is essentially a cast that turns its argument into an xvalue, allowing overload resolution to select operations that accept rvalues.

```cpp
template<class T>
constexpr std::remove_reference_t<T>&& conceptual_move(T&& value) noexcept {
    return static_cast<std::remove_reference_t<T>&&>(value);
}
```

The actual library declaration has precise constraints and attributes, but the model is sufficient: no bytes move inside `std::move`.

```cpp
std::string source = "venue";
std::string destination = std::move(source); // move constructor does the work
```

After a move, a standard-library object is generally valid but in an unspecified state unless its type gives a stronger postcondition. It may be queried by operations with no precondition, assigned a new value, or destroyed. Do not assume it is empty.

Moving a `const` object usually selects a copy because ordinary move constructors take non-const rvalue references:

```cpp
const std::string source = "venue";
std::string destination = std::move(source); // calls copy constructor
```

`std::move(source)` has type `const std::string&&`; it cannot bind to `std::string&&`, but it can bind to `const std::string&`.

A move can be expensive. Moving `std::array<std::byte, 4096>` copies or moves every element because the storage is embedded. Moving a small string may copy its inline buffer. Moving an allocator-aware container can become element-wise when allocator rules prevent storage transfer. The language grants overload selection, not a complexity bound.

Moving individual members from an object is also a state transition:

```cpp
auto payload = std::move(message.payload);
// message still exists, but its payload is moved from.
```

If other members encode invariants about `payload`, the containing object may no longer satisfy its ordinary domain invariant even though each member remains valid. Either provide a class-level operation that preserves invariants or make the consumed state explicit.

Use `-Wpessimizing-move` and `-Wredundant-move` where supported. They catch casts that block elision or add no value.

## 4.5 `std::forward` and Perfect Forwarding

`std::forward<T>` conditionally casts a named parameter back to the category represented by deduced `T`. A named rvalue-reference parameter is itself an lvalue expression, so forwarding is required to preserve the caller's category.

```cpp
#include <utility>

template<class Handler, class Message>
decltype(auto) dispatch(Handler&& handler, Message&& message) {
    return std::forward<Handler>(handler)(
        std::forward<Message>(message));
}
```

If the caller passes an lvalue message, `Message` is an lvalue-reference type and `forward` produces an lvalue. If the caller passes an rvalue, `Message` is a non-reference type and `forward` produces an xvalue.

Forward the same value at most where consumption is semantically permitted. Forwarding it twice can expose a moved-from object to the second consumer:

```cpp
template<class T>
void broken_fanout(T&& value) {
    first(std::forward<T>(value));
    second(std::forward<T>(value)); // possibly already consumed
}
```

Perfect forwarding is “perfect” only with respect to cv/ref category for expressions that can be deduced. It does not preserve lifetime, solve overload ambiguity, or prevent a callee from copying. Wrapper layers can still inhibit inlining, instantiate excess code, or hide allocation in the final target.

C++23 `std::forward_like<T>(value)` applies the cv/ref pattern of one type to another expression. It is helpful in accessor implementations that must propagate the category of `*this`. Standard-library availability lagged the language release in some toolchains, so check the project's compiler and library feature macros before depending on it.

Forwarding does not create ownership. If `dispatch` stores `message` rather than consuming it synchronously, an rvalue argument can leave a stored reference dangling at the end of the full-expression. The forwarding boundary's documentation must state whether it calls, copies, moves, or retains.

Verify a forwarding wrapper with compile-time probes:

```cpp
static_assert(std::is_same_v<
    decltype(std::forward<Order&>(std::declval<Order&>())), Order&>);
static_assert(std::is_same_v<
    decltype(std::forward<Order>(std::declval<Order&>())), Order&&>);
```

Then inspect construction counts with an instrumented test type. Do not leave such logging in a latency benchmark; I/O overwhelms the operation under study.

## 4.6 `decltype`, `decltype(auto)`, and Return-Type Deduction

`decltype` determines a type from an expression without evaluating it. Its special rule for unparenthesized names differs from its rule for general expressions.

```cpp
int quantity = 10;

static_assert(std::is_same_v<decltype(quantity), int>);
static_assert(std::is_same_v<decltype((quantity)), int&>);
```

For an unparenthesized id-expression or member access, `decltype` yields the declared type. Otherwise it reflects value category: lvalue expressions yield `T&`, xvalues yield `T&&`, and prvalues yield `T`.

Plain `auto` return deduction behaves largely like template type deduction and drops top-level references. `decltype(auto)` applies `decltype` rules and can preserve them.

```cpp
Order global_order;

auto copy_order() { return (global_order); }           // returns Order
decltype(auto) refer_order() { return (global_order); } // returns Order&
```

Parentheses therefore change ownership. This compact but dangerous function returns a dangling reference:

```cpp
decltype(auto) broken() {
    Order local{};
    return (local); // BROKEN: deduces Order&
}
```

Return-type deduction is useful when an expression's exact proxy or reference type matters, as in generic adapters. A domain API should often spell out whether it returns a value, reference, or view. That makes invalidation and lifetime visible.

A trailing return type can express the same exact contract while naming parameters:

```cpp
template<class Container>
auto front(Container& c) -> decltype(c.front()) {
    return c.front();
}
```

This preserves a proxy or reference returned by the container. That fidelity is useful only if callers understand invalidation. Returning a concrete value intentionally severs the dependency at the cost of a copy or move.

No runtime instructions are required merely by `decltype`; it is compile-time machinery. Its consequences determine whether later code copies an object or aliases it. Use `static_assert` to lock important interface types and review any `decltype(auto)` return with special attention to parentheses and source lifetime.

## 4.7 Perfect-Forwarding Failure Cases

Forwarding fails when template argument deduction lacks a single expression type or when the interface accepts a representation that needs separate treatment.

An overload set has no unique type:

```cpp
void decode(int);
void decode(std::string_view);

template<class F>
void install(F&&);

// install(decode); // cannot deduce which overload
install(static_cast<void(*)(int)>(decode));
```

A braced initializer list is not an expression with an ordinary deducible type:

```cpp
template<class T>
void consume(T&&);

// consume({1, 2, 3}); // T cannot be deduced
consume(std::initializer_list<int>{1, 2, 3});
```

Other common failures include bit-fields, `0` or `NULL` where a pointer was intended, static const integral members lacking a required definition in older language modes, and template names whose specialization is not known.

Arrays and functions deserve care because deduction can preserve them when the parameter is a reference, while by-value deduction decays them to pointers. A wrapper that stores `std::decay_t<T>` deliberately owns a decayed value; one that stores `T&&` may retain a reference. `std::remove_cvref_t<T>` removes qualifiers and references without array-to-pointer or function-to-pointer decay. The choice changes ownership, size, and lifetime.

Forwarding can also succeed mechanically and fail semantically. A wrapper may store a forwarded reference to a temporary, producing a dangling member. It may forward into an `initializer_list` path that copies. It may pass a proxy object rather than the value the target expects.

Solve these cases at the interface boundary. Name the desired overload, accept `std::initializer_list<T>` explicitly, use `nullptr`, materialize a value, or constrain the wrapper. Do not add casts until the ownership and target type are clear.

Compiler errors from forwarding are verbose because they report an instantiation chain. Concepts can move the error to the boundary, but they do not change runtime work. Compile-time tests covering lvalue, const lvalue, and rvalue calls keep wrapper behavior stable.

## 4.8 Accidental Copies and Move Inhibition

An accidental copy occurs when code appears to transfer or observe an object but overload resolution or type erasure selects copying. `const`, by-value iteration, non-forwarding wrappers, missing move operations, and library constraints are common causes.

```cpp
std::vector<Order> orders = load_orders();

for (auto order : orders) { // copies each Order
    validate(order);
}

for (const auto& order : orders) { // no element copies
    validate(order);
}
```

Range-for by value is correct for cheap scalar elements or when an independent copy is required. It is not universally a bug. State the semantic intent before changing it.

`const` inhibits ordinary resource-stealing moves, as Section 4.4 showed. Returning `const T` by value is therefore an obsolete and harmful style: it can prevent moving from the result in some contexts without protecting meaningful shared state.

Type erasure can add a copy requirement. `std::function` historically requires its stored target to be copy-constructible; C++23 `std::move_only_function` supports move-only callables. Either wrapper may store a small target inline or allocate for a larger one depending on implementation. Chapter 6 analyzes the dispatch tradeoff.

Structured bindings can hide copies too:

```cpp
for (auto [price, level] : book) {       // copies the pair-like element
    inspect(price, level);
}

for (const auto& [price, level] : book) { // aliases the element
    inspect(price, level);
}
```

The binding form determines whether the hidden binding object is a value or reference. As with range-for, copying may be intentional for isolation; make it visible in review.

```cpp
template<class Queue>
void drain(Queue& input) {
    while (!input.empty()) {
        auto message = std::move(input.front());
        input.pop();
        process(std::move(message));
    }
}
```

Even this code relies on queue and message semantics. A `const` queue front, a message with no move constructor, or allocator mismatch can turn transfer into copying.

Detect copies using a test type with counters, compiler warnings, profiles of copy constructors, and allocation tracing. Inspect representative optimized code: trivial copies may appear as vector loads or `memcpy`, while resource-owning copies often call allocation and element constructors.

## 4.9 Copy and Move Construction

A copy constructor initializes a new object from an existing lvalue-like source. A move constructor initializes a new object from an expiring source, typically transferring resources while leaving the source valid.

```cpp
class Buffer {
public:
    Buffer(std::size_t size)
        : data_(size ? new std::byte[size] : nullptr), size_(size) {}

    Buffer(const Buffer& other)
        : Buffer(other.size_) {
        std::copy_n(other.data_, size_, data_);
    }

    Buffer(Buffer&& other) noexcept
        : data_(std::exchange(other.data_, nullptr)),
          size_(std::exchange(other.size_, 0)) {}

    ~Buffer() { delete[] data_; }

private:
    std::byte* data_{};
    std::size_t size_{};
};
```

This move performs a few scalar loads and stores; the copy allocates and touches `size_` bytes. The exact allocation and instruction sequences are implementation-dependent. The asymptotic difference follows from the class design, not the keywords.

Base classes and members are constructed in declaration-defined order, not the textual order chosen in a constructor initializer list. A generated copy or move follows that structural order. Reordering member declarations can therefore change both layout and operation order; Chapter 5 covers the layout consequences.

A constructor that transfers several resources must remain safe if an earlier member move changes the source and a later member construction throws. Marking the whole move `noexcept` is valid only when all invoked operations support it. Member types with rule-of-zero ownership make this reasoning local.

Memberwise generated moves do not guarantee cheap transfer. An array member moves element by element. A raw pointer member is copied, which is only correct if ownership semantics make that safe. A mutex member prevents ordinary copying and moving.

Moved-from invariants deserve deliberate design. Resetting a buffer to `{nullptr, 0}` gives cheap, clear destruction. Re-establishing a rich default state could allocate inside the move and destroy its latency advantage. Document what operations remain valid beyond the general valid-but-unspecified requirement.

Constructor benchmarks must prevent elision if the goal is to time the constructor; otherwise the optimizer may validly remove the operation. In application code, welcome elision—it is better than even a cheap move.

An instrumented semantic test can count operations without pretending to measure latency:

```cpp
struct Probe {
    inline static int copies = 0;
    inline static int moves = 0;

    Probe() = default;
    Probe(const Probe&) { ++copies; }
    Probe(Probe&&) noexcept { ++moves; }
};
```

Reset the counters, exercise one interface, and assert the permitted result. Remember that compiler-permitted elision can remove calls, and the counters themselves make constructors non-trivial. Use this type to verify overload selection, then use the real type and production optimization for performance work.

For latency verification, separate at least three cases: constructing a value from resident source data, moving into fresh uninitialized storage, and move-assigning over a populated target. Capture allocations separately from elapsed time. Inspect assembly for embedded fixed-size records and profiles for dynamic owners. A single average across mixed cases obscures exactly the tail behavior the type design should control.

## 4.10 Copy and Move Assignment

Assignment changes an already-live target, unlike construction, which initializes new storage. A copy assignment must handle existing target resources and preserve its documented exception guarantee. A move assignment must decide what happens to both the target's old resources and the source.

One copy-assignment design allocates before releasing old state:

```cpp
Buffer& Buffer::operator=(const Buffer& other) {
    if (this == &other) return *this;

    Buffer replacement(other); // may throw; *this unchanged if it does
    swap(replacement);
    return *this;
}
```

Copy-and-swap offers a strong guarantee but may allocate even when existing capacity could be reused. A performance-oriented implementation can reuse capacity and still define a correct failure policy, at the cost of more branches and code.

A move assignment for an exclusive resource often releases the target and transfers the source:

```cpp
Buffer& Buffer::operator=(Buffer&& other) noexcept {
    if (this != &other) {
        delete[] data_;
        data_ = std::exchange(other.data_, nullptr);
        size_ = std::exchange(other.size_, 0);
    }
    return *this;
}
```

Releasing the old resource can dominate latency. Move assignment is not necessarily constant-time if destruction of the old state is expensive. Allocator-aware containers also consult propagation and allocator equality rules; an apparently moving assignment can become element-wise.

Swap-based assignment can centralize resource exchange, but `swap` has its own `noexcept` and allocator rules. A generic algorithm may use `std::swap`, which ordinarily performs moves, unless a more appropriate overload participates. Supply a non-throwing member swap and matching overload when resource exchange is a core class operation, then test that generic calls find it.

Assignment also raises capacity policy. Reusing a target buffer avoids allocation but may retain a large high-water mark. Replacing it via a fresh temporary can return memory but add allocation and page traffic. A trading system may use separate policies for hot steady-state updates and cold administrative replacement.

Test construction and assignment separately. Include different capacities, self-assignment, allocator configurations, and exception injection. A benchmark of assignment into an empty target does not represent replacement of a populated order-book snapshot.

## 4.11 Rule of Zero, Three, and Five

The **rule of zero** says that a class should require no user-declared destructor, copy operation, or move operation because its members already model ownership correctly. This is the preferred design.

```cpp
struct SessionState {
    std::string venue;
    std::vector<Order> pending;
    std::uint64_t next_sequence{};
};
```

The standard-library members manage their resources, and the compiler can generate coherent special members.

The **rule of three** describes older or copy-focused ownership types: if a destructor, copy constructor, or copy assignment is custom, the class often needs all three. The **rule of five** adds move construction and move assignment in C++11 and later.

These are design heuristics, not language laws. A scope guard may deliberately delete copy and move. A polymorphic base may declare a virtual destructor and protected/defaulted copy operations. A memory-mapped region can be move-only.

The important design question is whether identity or value is being modeled. A file descriptor wrapper has unique identity and should normally be move-only. A price level is a value and should normally copy. A live order book may be neither cheaply copyable nor freely movable because external handles depend on its address. Encoding those choices with deleted operations prevents accidental expensive or invalid paths.

Prefer composing a raw resource into a small RAII member, then let higher-level classes return to the rule of zero. This reduces code, exception paths, and testing combinations. It also helps optimizers because defaulted operations expose straightforward memberwise behavior.

The rule of zero does not promise cheap operations. Copying `SessionState` can allocate and copy every order. Interface design must still control when copying is permitted. Delete operations that have no legitimate semantic use.

## 4.12 Implicit Deletion and Suppression

The compiler declares special member functions according to interdependent rules. A declared operation or a non-copyable member can suppress or define another operation as deleted.

A user-declared destructor prevents implicit declaration of move construction and move assignment. This surprises classes whose destructor merely logs or is explicitly defaulted:

```cpp
struct Packet {
    std::vector<std::byte> bytes;
    ~Packet() = default; // user-declared; implicit moves are not generated
};
```

`Packet` remains copyable through the vector, so an rvalue may silently copy. Restore intended moves explicitly or, better, omit the destructor:

```cpp
struct Packet {
    std::vector<std::byte> bytes;
    Packet() = default;
    Packet(const Packet&) = default;
    Packet& operator=(const Packet&) = default;
    Packet(Packet&&) noexcept = default;
    Packet& operator=(Packet&&) noexcept = default;
    ~Packet() = default;
};
```

A generated copy or move is defined as deleted if a base or member cannot perform the required operation. Reference and `const` data members commonly delete assignment. `std::mutex` makes containing classes non-copyable and non-movable by default.

The interaction is easier to control with an explicit contract table in the class definition:

| Intended value kind | Copy | Move | Typical declaration |
|---|---:|---:|---|
| ordinary value | yes | yes | rule of zero |
| unique resource | no | yes | delete copy, define/default move |
| fixed identity | no | no | delete both |
| polymorphic base | restricted | restricted | protected/defaulted or deleted |

This table is a design aid, not a substitute for the detailed standard rules. Type traits report whether an expression is syntactically supported; they do not prove that its semantics are correct or cheap.

```cpp
struct State {
    const std::uint64_t venue_id;
};

static_assert(!std::is_copy_assignable_v<State>);
```

Use `= delete` to make intentional restrictions readable at the first diagnostic. Use `= default` only after verifying that memberwise semantics match ownership. Type traits and compile-time assertions prevent refactors from silently changing a type's copy/move contract.

## 4.13 Trivial and Trivially Copyable Types

A **trivial** special member performs no user-defined semantic work under the standard's detailed conditions. A **trivially copyable** type may have its underlying bytes copied into suitable storage with facilities such as `std::memcpy`, and copied back, while preserving values subject to the representation rules.

```cpp
struct TopOfBook {
    std::int64_t bid_ticks;
    std::int64_t ask_ticks;
    std::uint32_t bid_size;
    std::uint32_t ask_size;
};

static_assert(std::is_trivially_copyable_v<TopOfBook>);
```

Trivially copyable does not mean “safe wire format.” Padding bytes may exist, byte order may differ, integer widths must be fixed deliberately, and not every bit pattern is valid for every member type. Comparing whole objects with `memcmp` can also compare indeterminate or non-value padding.

The destination of a byte copy must have appropriate size, alignment, and lifetime. Overlapping regions require `memmove`, not `memcpy`. Copying bytes over a live non-trivially copyable object can violate its invariant and later cause double release. “The compiler emitted `memcpy` for this copy” is not permission for source code to use `memcpy` on arbitrary types.

Trivial copying gives optimizers freedom to lower transfers to scalar moves, vector moves, or `memcpy`. For small fixed records, code is often a few loads and stores. For large records, cost remains proportional to bytes and cache lines touched.

Adding a virtual function, a non-trivial member, or certain user-provided special members can remove triviality. Lock desired properties with assertions at representation boundaries:

```cpp
static_assert(sizeof(TopOfBook) == 24); // intentional ABI-local contract
static_assert(alignof(TopOfBook) == 8); // verify on supported targets
```

Those size assertions are platform contracts, not universal C++ truths. Chapter 5 examines layout and padding in depth.

## 4.14 Guaranteed Copy Elision and Return-Value Optimization

**Copy elision** constructs a result directly in its destination instead of copying or moving through an intermediate. Since C++17, several prvalue cases require direct construction; this is often called guaranteed copy elision.

```cpp
Order make_order(std::uint64_t id) {
    return Order{id, 10'025, 100}; // direct construction in caller's result
}
```

The type need not have an accessible copy or move constructor for this same-type prvalue return, though its destructor must satisfy the relevant accessibility rules.

Returning a named local is different:

```cpp
Order make_order(bool buy) {
    Order result{};
    result.side = buy ? Side::buy : Side::sell;
    return result; // named RVO is permitted, not universally required
}
```

Compilers commonly perform named return-value optimization (NRVO) when one clear local is returned. Multiple candidate locals or awkward control flow can inhibit it. If NRVO does not occur, implicit move is considered for eligible local variables.

One result object across branches supports elision better than separate named candidates:

```cpp
Order make_order(bool buy) {
    Order result{};
    if (buy) configure_buy(result);
    else     configure_sell(result);
    return result;
}
```

Do not contort clear code solely for NRVO without measuring. An ordinary move may be cheap, while merging branches can lengthen live ranges or complicate initialization. Correctness and explicit ownership remain primary.

Do not write `return std::move(result);`. That changes the expression so NRVO cannot apply and usually forces a move:

```cpp
return std::move(result); // pessimizing move
```

Common ABIs implement large class returns through a hidden result pointer supplied by the caller, allowing construction directly in caller-provided storage. That mechanism is not a C++ guarantee.

Elision can remove not only byte transfer but also observable constructor and destructor side effects; copy elision is one of the language-permitted cases where that change is allowed. Logging from special members is therefore a poor way to infer the abstract machine unless the relevant elision mode is understood.

Verify with `-fno-elide-constructors` only to understand non-mandatory cases; it cannot disable mandatory C++17 elision. Production measurements should use normal optimization. Compiler warnings catch many pessimizing returns.

## 4.15 `noexcept` Moves and Container Behavior

`noexcept` is part of a function's contract: it states that the function will not let an exception escape. If one does, `std::terminate` is called. For move operations, this contract also affects generic library choices.

When `std::vector<T>` reallocates, it must transfer existing elements to new storage. To preserve its exception guarantee, it commonly moves elements when `T` is nothrow move-constructible or when copying is unavailable; otherwise it may copy them.

`std::move_if_noexcept` expresses this selection in generic code: it produces an rvalue reference when moving is non-throwing or copying is unavailable, and otherwise a const lvalue reference. It is a policy adapter, not a runtime exception probe.

```cpp
struct Record {
    std::unique_ptr<std::byte[]> data;
    std::size_t size{};

    Record(Record&&) noexcept = default;
    Record& operator=(Record&&) noexcept = default;
    Record(const Record&) = delete;
    Record& operator=(const Record&) = delete;
};

static_assert(std::is_nothrow_move_constructible_v<Record>);
```

Write conditional `noexcept` for generic wrappers:

```cpp
template<class T>
struct Box {
    T value;

    Box(Box&& other) noexcept(std::is_nothrow_move_constructible_v<T>)
        : value(std::move(other.value)) {}
};
```

Never label a move `noexcept` merely to influence `vector`. First make every operation in the move non-throwing or accept termination as the deliberate policy. Allocator propagation can also affect whether a container move transfers storage without element work.

The exception specification of a defaulted move is derived from its bases and members. Prefer `= default` when memberwise behavior is right; the compiler then keeps the specification aligned with member changes. A hand-written unconditional `noexcept` can become stale when a new member with a throwing move is added.

For a latency-sensitive vector, reserve the validated maximum so steady-state insertion does not reallocate. `noexcept` then still documents semantics but does not replace capacity planning. Test type traits and instrument copies under forced reallocation to verify the intended path.

A useful move-cost audit follows the object graph rather than the class name. For each member, record whether storage is embedded, uniquely owned, shared, or borrowed. Embedded arrays require element transfer. Unique pointers can usually exchange an address. Shared ownership commonly updates reference counts. Borrowed pointers may need no data movement but preserve lifetime dependencies. Then inspect the target's old state: move assignment may release far more than move construction.

| Representation | Typical move work | Tail-latency concern |
|---|---|---|
| fixed inline array | transfer every element | bytes and cache lines touched |
| unique heap buffer | exchange pointer and size | destruction of old target on assignment |
| shared control block | pointer transfer or count operations | contention and last-owner destruction |
| allocator-aware container | possibly steal storage | allocator mismatch can force element moves |
| non-owning span/view | copy pointer and length | referent lifetime remains external |

“Typical” in this table describes ordinary designs, not standard-mandated representations. Confirm the actual class and library implementation.

## 4.16 Self-Assignment and Self-Move

**Self-assignment** occurs when source and target are the same object. Copy assignment is conventionally expected to preserve the value under `x = x`. Move assignment has a weaker practical landscape, but a user-defined operation must at least meet the contract claimed by its type and by algorithms that use it.

A destructive copy assignment is broken:

```cpp
Buffer& Buffer::operator=(const Buffer& other) {
    delete[] data_;
    size_ = other.size_;               // other may be *this; data already lost
    data_ = new std::byte[size_];
    std::copy_n(other.data_, size_, data_);
    return *this;
}
```

An identity check fixes this path; copy-and-swap naturally handles it after creating the independent copy. Capacity-reusing implementations need explicit testing.

For move assignment, an identity check is often cheap and clear:

```cpp
Buffer& Buffer::operator=(Buffer&& other) noexcept {
    if (this == &other) return *this;
    delete[] data_;
    data_ = std::exchange(other.data_, nullptr);
    size_ = std::exchange(other.size_, 0);
    return *this;
}
```

Branch cost is normally predictable, but branch avoidance can be valid if the operation is carefully designed to tolerate aliasing. Do not omit correctness for a speculative cycle saving. Self-move can arise through generic algorithms, aliases, and explicit `x = std::move(x)` even when application code does not write it intentionally.

An alternative move implementation can first steal source state into local temporaries, reset the source, and then release the old target. Under self-move, however, source and target transitions alias, so the ordering must be proved carefully. A one-line identity check is often less code and less proof burden.

Define the postcondition. “Valid but unspecified” means invariants hold and documented no-precondition operations can be called; it does not excuse a dangling pointer or double-owned descriptor. A stronger empty-after-move state can simplify pools and monitoring, provided establishing it stays bounded.

For example, suppose an outbound message contains an inline 64-byte header, a unique variable-size payload, a shared schema descriptor, and a non-owning session pointer. Moving it may copy the header, exchange the payload pointer, transfer or update shared ownership according to the member operation, and copy the session pointer. The source must then represent a valid combination: perhaps an empty payload and no sendable message, while the session pointer remains observable. A hand-written move that clears only half of the header can violate the class invariant even if every pointer is safe.

The same example explains why “one move” is not a useful performance unit. Count transferred bytes, atomic operations, possible deallocation of the target, branches needed to restore invariants, and the source's subsequent use. Verify the intended path with traits, compiler output, allocation instrumentation, and a test that moves both into an empty destination and over a populated one.

Before admitting a type to a critical-path container, record its contract:

1. Is copying meaningful, and what is its maximum work?
2. Is moving non-throwing, and what state does it leave behind?
3. Does assignment release old state synchronously?
4. Can allocator state turn a storage transfer into element-wise work?
5. Are references or handles invalidated when the object moves?
6. Does a generated special member still match the ownership design?

These answers are more stable than an isolated benchmark. The benchmark then verifies the chosen implementation on the target toolchain rather than inventing the semantic model after measuring it.

Container invalidation must be included in that record. Moving an object may preserve an internal heap allocation and therefore preserve pointers to elements, but moving the containing object itself can invalidate pointers to embedded members. Standard containers specify their own post-move and invalidation contracts; user-defined types must state theirs. A cached pointer into an inline message buffer cannot be assumed to follow the buffer when the outer message moves. Recompute such interior pointers, store offsets, or define a move operation that repairs them. Offsets reduce relocation work but still require bounds validation. This is a memory-layout decision with direct correctness and latency consequences, not a detail that `std::move` resolves.

Tests should retain an interior handle across each supported operation and assert the exact documented validity and target identity afterward.

Test self-copy and self-move under sanitizers and with resources that make double release visible. Also test aliases reached through references. The important result is a valid documented state and no leak, double free, or invalid access—not necessarily preservation of the original value after self-move unless that is the class contract.

## 4.17 Interview Check

1. Classify a named `T&&` parameter, `std::move(parameter)`, and `T{}` by value category. Why is the parameter expression not an rvalue?
2. State the reference-collapsing rules and show what `T` becomes when a forwarding-reference parameter receives a const lvalue.
3. Explain why `std::move` performs no transfer by itself and why moving a `const std::string` usually copies.
4. Diagnose a wrapper that calls `first(std::forward<T>(x))` and then `second(std::forward<T>(x))`.
5. Compare `auto` and `decltype(auto)` return deduction. How can parentheses accidentally create a dangling reference?
6. Give three perfect-forwarding failure cases and an explicit interface fix for each.
7. Explain how a user-declared destructor can cause an rvalue to be copied. How would you lock the intended contract at compile time?
8. Compare copy construction, move construction, copy assignment, and move assignment for an already-populated target with an owned buffer.
9. Why is trivially copyable not equivalent to portable network serialization or safe `memcmp` equality?
10. Distinguish mandatory C++17 copy elision from NRVO, and explain why `return std::move(local);` is usually harmful.
