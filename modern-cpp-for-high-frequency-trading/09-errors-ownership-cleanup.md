# Chapter 9 — Errors, Ownership, and Deterministic Cleanup

An error path can be rare and still determine whether a trading process is safe to operate. The common mistake is to choose an error representation from its syntax alone: exceptions look invisible, integer codes look cheap, and smart pointers look automatic. The important questions are what state survives failure, where cleanup runs, who owns each resource, and whether the slow path can appear on a latency-critical thread. This chapter develops those answers from C++ semantics through common ABI implementations and ends with resource wrappers suitable for Linux systems code.

## 9.1 Exceptions and Stack Unwinding

An **exception** transfers control from a `throw` expression to a matching handler. The transfer is not an ordinary branch. Before entering the handler, C++ destroys every fully constructed automatic object whose scope is exited. This process is **stack unwinding**.

```cpp
#include <stdexcept>
#include <string>

class Session {
public:
    explicit Session(std::string endpoint) : endpoint_(std::move(endpoint)) {}
    ~Session() noexcept { disconnect(); }

private:
    void disconnect() noexcept;
    std::string endpoint_;
};

void load_reference_data() {
    Session session{"primary"};
    throw std::runtime_error{"reference data checksum failed"};
    // session is destroyed before a matching outer handler runs.
}
```

Only completed subobjects are destroyed. If construction of an object fails, its already-constructed bases and members are destroyed in reverse construction order, but the destructor of the incomplete most-derived object is not called. This rule is why a constructor should put each acquired resource immediately into a member that owns it.

```cpp
class Feed {
public:
    Feed() : socket_{open_socket()}, buffer_{allocate_buffer()} {}
    // If allocate_buffer throws, socket_ is still destroyed.

private:
    unique_fd socket_;
    unique_buffer buffer_;
};
```

A handler matches by type. Catch polymorphic exceptions by reference so that the object is not copied or sliced:

```cpp
try {
    load_reference_data();
} catch (const std::system_error& e) {
    report(e.code(), e.what());
} catch (const std::exception& e) {
    report({}, e.what());
}
```

`throw;` rethrows the currently handled exception. `throw e;` instead throws a new object initialized from `e`, which may slice a derived exception and changes where diagnostic information appears to originate.

Destructors are implicitly `noexcept` in the usual case. If a destructor lets an exception escape while another exception is already unwinding, the runtime calls `std::terminate`. Cleanup code therefore needs its own failure policy: close a descriptor, record a best-effort diagnostic, or mark a component unhealthy, but do not start a second unwinding operation.

Exceptions do not provide rollback by themselves. Unwinding merely invokes destructors. If a function has already published half an order-book update to shared state, destruction of local objects cannot unpublish it. State changes must be staged or guarded explicitly, as Section 9.2 shows.

The thrown object has a lifetime independent of the local operand used to initialize it. Throwing a local object does not leave the handler referring to a destroyed stack variable. `std::exception_ptr` can retain and later rethrow the current exception, which is useful for transferring a failure out of a worker thread. It also extends the exception object's lifetime and preserves exception-based failure semantics at the destination; it is not a bounded serialization format or a cross-process result.

Catch ordering matters. A handler for a base type placed before one for a derived type makes the derived handler unreachable. Catch-all handlers are appropriate at thread and ABI boundaries, but swallowing an unknown exception without restoring an invariant merely hides corruption. A top-level thread function should translate, publish a component failure state, and then either stop that component or terminate according to policy.

## 9.2 Exception Guarantees

An **exception guarantee** states what remains true when an operation fails. It is a semantic contract, not a claim about the speed of throwing.

| Guarantee | State after failure |
|---|---|
| No-throw | The operation does not let an exception escape. |
| Strong | The observable state is unchanged, as if the operation had not begun. |
| Basic | Invariants hold and resources do not leak, but values may have changed. |
| None | The operation may leave state unusable, though language rules still apply. |

The strong guarantee is commonly implemented as prepare, then commit. All potentially failing work occurs on private state; the final commit is non-throwing.

```cpp
#include <cstdint>
#include <unordered_map>

struct Order {
    std::uint64_t id;
    std::int64_t quantity;
};

class Orders {
public:
    void replace(Order order) {
        auto copy = by_id_;              // can allocate and throw
        copy.insert_or_assign(order.id, order); // can throw
        by_id_.swap(copy);               // required noexcept for this allocator case
    }

private:
    std::unordered_map<std::uint64_t, Order> by_id_;
};
```

This example is deliberately unsuitable for a hot order path: it copies the entire table. It cleanly demonstrates the contract, however. A production design might preallocate a replacement node or modify an intrusive structure under a rollback guard. The important property is that no throwing operation occurs after the commit becomes externally visible.

`noexcept` participates in both correctness and optimization. If an exception escapes a `noexcept` function, C++ calls `std::terminate`; the caller cannot recover. Standard containers may prefer a `noexcept` move constructor during reallocation because copying can preserve the old elements if construction of the new range fails. Mark a move `noexcept` only when all operations it performs truly cannot throw.

```cpp
class Message {
public:
    Message(Message&&) noexcept = default;
    Message& operator=(Message&&) noexcept = default;
    // std::vector can normally relocate Message by moving it.
};
```

A `noexcept` declaration can remove exception-handling edges and expose optimization opportunities, but it does not promise a particular instruction sequence. Destructors, deallocation, logging, and kernel calls inside the function still cost work. Nor does `noexcept` mean wait-free or bounded.

For latency-sensitive APIs, document two contracts separately:

- the state guarantee if the operation fails; and
- the mechanism by which failure is reported.

An `expected`-returning function can offer the strong guarantee. A throwing function can offer only the basic guarantee. Error representation and exception safety are related, but they are not the same property.

Library documentation often phrases guarantees conditionally. A container operation may provide the strong guarantee only if `T` has a non-throwing move constructor or the allocator satisfies particular propagation rules. If the fallback is copying, the supposedly faster move path may never be selected. Treat those conditions as part of the type's interface and test them with `static_assert(std::is_nothrow_move_constructible_v<T>)` where the design depends on them.

The no-throw guarantee also has two forms in practice. A function declared `noexcept` is enforced by termination on escape. A function that simply happens not to throw has no such type-level contract. Function pointer and callable types can distinguish `noexcept`, so adding or removing the specification can affect overload resolution and ABI-facing declarations. Keep declarations consistent across translation units.

## 9.3 Common Zero-Cost Exception Models

A **zero-cost exception model** moves much of the work from the non-throwing path into metadata and the throwing path. “Zero cost” does not mean zero bytes, zero optimization effect, or cheap failure. It means that ordinary execution commonly does not perform a dynamic handler-registration operation at every `try` block.

On ELF systems using a common Itanium C++ ABI implementation, the compiler emits call-site tables, type information, and unwind descriptions. A throw generally proceeds in two phases:

```text
throw expression
      |
      v
allocate and initialize exception object
      |
      v
phase 1: search stack frames for a matching handler
      |
      v
phase 2: revisit frames, run cleanup landing pads
      |
      v
enter handler
```

The exact representation and algorithm are ABI and toolchain choices, not C++ guarantees. Windows targets commonly use different metadata and unwinder interfaces. A compiler built with exceptions disabled may reject `throw` or arrange termination rather than normal propagation.

On the ordinary path, a call inside a `try` region can be nearly identical to the same call outside it. The executable still carries unwind tables and language-specific data. Those bytes consume file space, mapped pages, and potentially instruction or data-cache capacity. Additional control-flow edges can also constrain optimization, although compilers are often good at keeping landing pads cold.

Inspect both code and metadata instead of assuming:

```bash
g++ -std=c++23 -O3 -fno-omit-frame-pointer -c errors.cpp -o errors.o
objdump -dr errors.o
readelf --unwind errors.o
readelf --sections errors.o | rg 'eh_frame|gcc_except_table'
```

The output is compiler-, target-, and flag-dependent. Compare object size and assembly with a design that returns an explicit result, but make sure both variants perform equal validation and diagnostics. Removing exceptions while silently removing error handling is not a meaningful benchmark.

Unwind information serves more than C++ exceptions. Debuggers, profilers, and crash unwinding may use frame information, and some targets need parts of it even for code compiled without language exceptions. Consequently, `-fno-exceptions` does not imply that every unwind-related section disappears. `-fno-unwind-tables` and `-fno-asynchronous-unwind-tables` have separate effects and can degrade observability. Such flags are toolchain contracts with operational consequences, not general C++ optimization advice.

Code with cleanup may have landing pads even when it has no local `catch`, because unwinding must call destructors. C APIs called from C++ do not become exception-aware, and a plain C function does not automatically supply C++ cleanup metadata. Whether unwinding can traverse any particular foreign frame is an ABI question. The safe interface rule is addressed in Section 9.5.

## 9.4 Throw-Path Latency and Unwind Tables

The **throw path** performs work proportional to the exception machinery and the dynamic call stack it traverses. It may allocate or obtain storage for an exception object, search metadata, compare types, restore register state, invoke cleanup code, and execute diagnostics. None of this has a useful small upper bound for a general call stack.

A common Itanium ABI runtime obtains an exception object through functions such as `__cxa_allocate_exception`, but the C++ standard does not specify this interface or the allocator behind it. Implementations may keep emergency storage for low-memory situations. User code must not infer that throwing is allocation-free, nor that `std::bad_alloc` cannot itself be represented when the heap is exhausted.

Unwinding also makes rarely touched code and metadata suddenly hot. Page faults, instruction-cache misses, symbol lookup in logging, locks in telemetry, and destructor side effects can dominate the runtime. A destructor can close a socket or release a final `shared_ptr`; those actions may cross into the kernel or destroy an entire object graph. An exception latency measurement that catches immediately in the same function omits much of the operational risk.

For a realistic experiment, vary stack depth and the number of live cleanup objects. Pre-touch the benchmark's own buffers, prevent the compiler from proving away the operation, and report a distribution rather than one average:

```bash
perf stat -e cycles,instructions,branches,branch-misses,page-faults \
    ./exception_bench --depth 32 --cleanups 8
```

Do not fabricate an event rate that makes exceptions look acceptable. Instead, ask whether a corrupt packet, disconnect storm, or dependency failure can produce a burst of throws. A mechanism used once during startup and a mechanism reachable for every malformed market-data message have different predictability requirements.

Many low-latency systems prohibit exceptions on the steady-state critical path while retaining them for configuration, startup, and tooling. That policy works only when boundaries are explicit. Catch before entering the hot loop, translate failures into bounded result types, and ensure callbacks invoked by the loop cannot throw through it.

```cpp
void run_hot_loop() noexcept {
    for (;;) {
        // Every reachable operation must honor the no-throw contract.
        process_one_message();
    }
}
```

This declaration converts an accidental escape into termination. It does not verify the latency of destructors or error reporting, so tests and code review remain necessary.

## 9.5 Exceptions Across ABI Boundaries

An **ABI boundary** is an interface at which separately compiled components must agree on calling convention, object layout, symbol naming, runtime support, and unwinding. C++ does not guarantee that an exception can cross a C function, a plugin built with another runtime, a process boundary, or even arbitrary C++ shared libraries.

Two libraries can often exchange exceptions when they use compatible compiler ABIs, standard-library ABIs, runtime versions, flags, and type definitions. “Often” is not an interface contract. RTTI identity, exception class layout, unwinder personality routines, and ownership of the exception object all matter. Mixing `-fno-exceptions` code into a propagation path adds another hazard.

Never allow a C++ exception to escape an `extern "C"` callback. Catch at the boundary and translate it into an agreed representation:

```cpp
#include <exception>

extern "C" int feed_on_packet(const unsigned char* data,
                              unsigned long size) noexcept {
    try {
        return decode_packet(data, size) ? 0 : 1;
    } catch (const std::exception& e) {
        record_boundary_error(e.what());
        return 2;
    } catch (...) {
        record_boundary_error("unknown C++ exception");
        return 3;
    }
}
```

The reverse boundary needs the same care: a C callback may use `longjmp`, thread cancellation, or another mechanism that does not run C++ destructors. Do not place owning automatic objects across such a transfer unless the foreign API explicitly guarantees compatible unwinding.

Process, RPC, and exchange-protocol boundaries should carry stable error data: a numeric category, code, retry classification, and bounded diagnostic fields. They cannot carry a live `std::exception_ptr` meaningfully across address spaces. Plugin APIs likewise benefit from opaque handles plus create/destroy functions owned by the same module, preventing mismatched allocators and standard libraries.

At a shared-library boundary, test at least:

- compatible and deliberately incompatible build settings;
- destruction in the module that allocated the object;
- thrown and translated errors;
- unload while handles or callbacks remain; and
- symbol-version and RTTI behavior.

The portable baseline is simple: exceptions stop at the component boundary. Internally, each component may use exceptions if its latency and safety requirements permit them.

## 9.6 Error Codes, Booleans, and Sentinels

An **explicit error result** makes failure part of a function's normal return flow. The simplest forms are a Boolean, an integer code, or a sentinel value. They are easy to transport across ABIs, but their meaning must be unambiguous.

```cpp
enum class DecodeError : unsigned char {
    truncated,
    bad_type,
    bad_length,
    bad_sequence
};

[[nodiscard]] DecodeError decode(const std::byte* first,
                                 const std::byte* last,
                                 Message& out) noexcept;
```

This interface has a flaw: it cannot represent success without reserving an enum value. A Boolean avoids that issue but loses diagnostic information. An integer convention such as zero-for-success works across C but permits invalid values and accidental neglect. `[[nodiscard]]` asks the compiler to diagnose discarded results; implementations may still permit the program after a warning.

A sentinel consumes no separate result storage when one payload value is genuinely impossible. `find_order` might return `nullptr`; a sequence lookup might return a reserved index. The cost is ambiguity if the domain later expands. Returning `-1` from a function whose valid type is unsigned is a particularly error-prone mix of sentinel and conversion.

The C convention of returning `-1` and setting `errno` has additional state. `errno` is thread-local, may be overwritten by a later call, and is meaningful only when the API says the return indicates failure. Save it immediately:

```cpp
int fd = ::open(path, O_RDONLY | O_CLOEXEC);
if (fd == -1) {
    const int error = errno;
    return OpenError{error};
}
```

Explicit propagation introduces branches and source-level checking at each layer. Those branches are usually predictable when errors are rare, but predictability changes during an incident. Code size from repeated checks can matter. Exceptions concentrate the rare path in handlers; result types expose it locally. Measure the whole design, including diagnostics and cleanup.

Out-parameters deserve special caution. If a function returns an error code and writes through several output pointers, its failure contract must state which outputs changed. Returning one aggregate result makes partial initialization harder to observe. When an ABI requires out-parameters, initialize into local state and copy to caller storage only after validation succeeds.

Error domains should remain stable and mechanically comparable. A small enum is well suited to decisions in the critical path; rich context can be recorded separately in a bounded per-thread event buffer. Formatting a dynamic message at every layer both allocates work and duplicates text. Preserve the original code and add fixed-size context such as message type, sequence number, and byte offset.

Error codes require a composition discipline. Preserve the original category, attach context without allocation on the critical path, and never reuse a partially written output object unless the API defines its state. Prefer returning the value and error together, which is the purpose of `optional` and `expected` in the next sections.

## 9.7 `std::optional` Representation

`std::optional<T>` contains either a `T` value or no value. It owns an inline `T`; it does not normally allocate merely because it is optional. The standard specifies behavior, not a particular byte layout.

A common representation is payload storage plus an engagement discriminator:

```text
possible optional<OrderId> representation
+----------------------+---------+---------+
| storage for OrderId  | engaged | padding |
+----------------------+---------+---------+
```

Padding can make `sizeof(std::optional<T>)` substantially larger than `sizeof(T) + 1`. An implementation may exploit spare representation states where permitted, but user code cannot rely on that. Verify the actual target:

```cpp
static_assert(sizeof(std::optional<std::uint64_t>) >=
              sizeof(std::uint64_t));

std::printf("value=%zu optional=%zu align=%zu\n",
            sizeof(std::uint64_t),
            sizeof(std::optional<std::uint64_t>),
            alignof(std::optional<std::uint64_t>));
```

Access through `operator*` or `operator->` requires engagement; violating the precondition is erroneous program logic. `value()` checks and throws `std::bad_optional_access` when empty. A hot path that uses `value()` has a failure edge into exception machinery even if correct inputs never take it.

```cpp
if (auto order = lookup(id)) {
    consume(*order);
}
```

The engagement test introduces a branch. It may compile to a branch or conditional selection depending on the following work. A vector of optional large objects embeds every payload slot even when most slots are empty, which can waste cache capacity. A separate bitmap plus dense values, or a sentinel representation, may fit sparse high-volume data better.

`optional` represents absence, not an explanation. It is a good return for “order not found” when absence is expected and no reason is needed. It is poor for “packet rejected” when operators need to distinguish truncation, sequence failure, and unsupported type.

Beware `value_or`: its argument is evaluated before the call, even when the optional is engaged. A fallback that allocates or performs a lookup pays that work eagerly. C++23 monadic operations make lazy composition easier.

## 9.8 C++23 Monadic `optional` Operations

C++23 adds monadic operations that transform an engaged optional and bypass work when it is empty. `and_then` chains a function returning another optional, `transform` wraps a plain result, and `or_else` handles absence.

```cpp
#include <optional>

std::optional<Order> find_order(std::uint64_t id);
std::optional<Price> validated_price(const Order& order);

std::optional<std::int64_t> price_ticks(std::uint64_t id) {
    return find_order(id)
        .and_then(validated_price)
        .transform([](Price price) { return price.ticks(); })
        .or_else([id] {
            note_lookup_miss(id); // runs only on the empty path
            return std::optional<std::int64_t>{};
        });
}
```

These operations do not add asynchronous behavior, hidden ownership, or required allocation. They are ordinary function calls on an inline discriminated object. Lambdas can normally be inlined, but this is not guaranteed. Long chains instantiate distinct templates, which can increase compile time and code size.

The value category of the optional controls whether the contained value is passed as an lvalue or rvalue. Moving a contained value does not automatically disengage the source optional; it remains engaged with a moved-from `T`. This surprises code that treats movement as consumption.

```cpp
auto a = std::optional<std::string>{"ABC"};
auto b = std::move(a).transform(
    [](std::string text) { return text + "-ITCH"; });
// a.has_value() is still true; its string has a valid but unspecified value.
```

Feature availability depends on the standard-library release, not only `-std=c++23`. Check `__cpp_lib_optional` and the compiler's library documentation when supporting older deployment images.

Monadic syntax improves local composition, but it does not add diagnostics. A failure at any stage is still simply “empty.” Use `expected` when the error is part of the domain.

## 9.9 C++23 `std::expected` and Its Monadic Operations

`std::expected<T, E>` contains either a value of type `T` or an error of type `E`. Both alternatives are stored within the object; no allocation is required by the abstraction itself. As with `variant` and `optional`, the standard does not specify the discriminator layout or exact size.

```cpp
#include <expected>
#include <span>

enum class ParseError : unsigned char {
    truncated,
    unknown_type,
    bad_length
};

std::expected<Message, ParseError>
parse(std::span<const std::byte> packet) noexcept {
    if (packet.size() < header_size) {
        return std::unexpected{ParseError::truncated};
    }
    // Validate before constructing Message.
    return Message{/* decoded fields */};
}
```

`expected<void, E>` represents success without a value. `std::unexpected<E>` makes the error alternative explicit at construction. Choose a bounded, cheap error type on a hot path: an enum plus fixed fields rather than a heap-owning diagnostic string.

`operator*` and `operator->` access the value under a precondition that it exists. `value()` performs a check and throws `std::bad_expected_access<E>` when the object holds an error. Thus, choosing `expected` does not make exceptions impossible if callers use its throwing accessor.

Monadic operations express propagation without repeated manual tests:

```cpp
std::expected<Header, ParseError> parse_header(PacketView);
std::expected<Order, ParseError> parse_order(Header);
std::expected<CheckedOrder, RiskError> check(Order);

auto decoded = parse_header(packet)
    .and_then(parse_order)
    .transform([](Order order) {
        order.normalize();
        return order;
    });
```

An error-type change needs deliberate translation; this prevents accidental loss of domain information. `transform_error` can map one bounded error representation into another. `or_else` can perform recovery, but recovery itself should have a clear latency budget.

Compared with exceptions, `expected` usually pays a discriminator test and explicit propagation on the ordinary path. It avoids stack unwinding and makes error paths visible to callers. Compared with an out-parameter plus code, it can improve type safety and return-value optimization. Large `T` or `E` alternatives increase every result object's footprint because storage must accommodate the larger alternative plus alignment and discrimination.

Some major libraries delivered `expected` and its monadic members at different times. Guard deployment support with feature-test macros and CI against the production standard library. Do not substitute a subtly incompatible third-party type at an ABI boundary.

## 9.10 Assertions, Termination, and Impossible Invariants

An **assertion** checks a programmer assumption, not an expected operational error. A malformed network packet, a full bounded queue, and a disconnected peer are possible inputs; they require defined handling. A negative internal reference count or impossible state-machine transition may justify termination.

The C `assert` macro is normally removed when `NDEBUG` is defined. Therefore its expression must not contain required work:

```cpp
// BROKEN: behavior changes in release builds.
assert(remove_order(id));

// CORRECT: perform work, then check the invariant.
const bool removed = remove_order(id);
assert(removed);
```

Production assertions may record a bounded crash event and call `std::terminate` or `std::abort`. Such a handler must assume damaged state. Avoid general heap allocation, locks that may already be held, and unbounded formatting. Whether to terminate the process, isolate a feed, or reject one message is an operational policy, not a language rule.

C++23 `std::unreachable()` tells the implementation that control cannot reach that point. Reaching it produces undefined behavior. It is an optimization assertion, not a safe failure handler:

```cpp
switch (side) {
case Side::buy:  return +1;
case Side::sell: return -1;
}
std::unreachable(); // valid only if every possible Side value was validated
```

An enum can still contain a value not named by an enumerator after decoding or casting. Validate external bytes before relying on exhaustiveness. Similarly, compiler assumptions can remove defensive branches and amplify an input-validation bug into arbitrary behavior.

Use three distinct mechanisms:

- ordinary result types for anticipated failures;
- assertions for development-time invariant detection; and
- a controlled fatal path for a process that cannot continue safely.

Measure the fatal path only to ensure it records sufficient evidence without hanging. It does not belong in a steady-state latency percentile.

## 9.11 RAII and Scope Guards

**Resource Acquisition Is Initialization (RAII)** binds a resource's lifetime to an object's lifetime. Construction establishes ownership; destruction releases it. Cleanup then occurs on every normal return and during exception unwinding.

```cpp
#include <cstdio>
#include <memory>

using file_ptr = std::unique_ptr<std::FILE, decltype(&std::fclose)>;

file_ptr open_file(const char* path) {
    if (std::FILE* f = std::fopen(path, "rb")) {
        return file_ptr{f, &std::fclose};
    }
    return file_ptr{nullptr, &std::fclose};
}
```

Deterministic does not mean cheap. Destruction may flush a stream, unmap pages, release the final shared owner, wake a waiter, close a descriptor, or return memory to a contended allocator. A local owner makes the time of cleanup predictable in control flow but not necessarily bounded in duration.

A **scope guard** runs a supplied action when a scope exits. C++23 standardizes `std::scope_exit`, with related success/failure guards subject to library support. A small local equivalent is useful when deployment libraries lag:

```cpp
auto rollback = std::scope_exit([&] noexcept {
    book.restore(old_level);
});

book.apply(update);       // may fail
publish(book.snapshot());
rollback.release();       // commit
```

The guard captures by reference, so every referenced object must outlive it. The cleanup callable should normally be non-throwing. Its storage is embedded in the guard; whether a different type-erased guard allocates depends on that implementation.

In a critical loop, consider moving expensive retirement off the parsing thread. Transfer ownership into a bounded reclamation queue and let a designated thread destroy it. That change is not free: it introduces queue capacity, cross-core cache traffic, and an overload policy. RAII still defines ownership, while architecture chooses the destruction context.

## 9.12 Raw Pointers, References, and Non-Owning Semantics

A raw pointer or reference normally expresses access, not ownership. This is a convention enforced by interface design and review; the type `T*` itself does not say whether it owns, may be null, refers to one object, or begins an array.

```cpp
void apply(const Order& order, Book& book);       // non-null objects
Order* find(OrderId id) noexcept;                 // nullable observer
void decode(std::span<const std::byte> bytes);    // bounded sequence view
```

A pointer is commonly one machine word and copying it performs no reference-count bookkeeping. A reference often uses the same representation in generated code, but C++ describes references semantically and does not require an object layout. Neither extends the pointee's lifetime.

Non-owning handles become invalid when the owner is destroyed, storage is reallocated, or an operation applies its documented invalidation rule. `string_view` into a temporary string and `span` into a growing vector are compact but dangling:

```cpp
// BROKEN
std::string_view venue() {
    return std::string{"XNAS"};
}

// BROKEN after a capacity-changing insertion
std::span<Order> view = orders;
orders.push_back(new_order);
use(view);
```

References cannot be reseated and are intended to refer to an object; use a pointer for optional access. `std::reference_wrapper<T>` is copyable and reseatable as a wrapper, but remains non-owning. `std::span<T>` carries pointer and length, typically two machine words for dynamic extent; fixed-extent spans may store only a pointer in common implementations.

Document the lifetime in API structure: keep observers within a lexical operation, return IDs instead of long-lived pointers when storage moves, and use generation counters for reusable slots. The cheapest handle is not cheap if validating its lifetime requires a cache miss or global lock.

## 9.13 `std::unique_ptr`, `make_unique`, and Custom Deleters

`std::unique_ptr<T, D>` owns one object exclusively and invokes its deleter when destroyed or reset. It is movable but not copyable. The handle does not allocate by itself; the usual allocation occurs in `new`, `make_unique`, or a factory called before construction of the handle.

```cpp
auto order = std::make_unique<Order>(id, price, quantity);
consume(std::move(order)); // ownership transfer is explicit
```

`make_unique` combines allocation and construction in one expression and immediately produces an owner. It does not combine object storage with separate metadata because `unique_ptr` has no control block. `make_unique<T[]>` supports arrays; the specialization uses `delete[]` and does not provide scalar dereference operators.

The deleter is part of the pointer's type. A stateless deleter often occupies no extra bytes through empty-base or compressed-member techniques, but exact layout is implementation-dependent. A stateful deleter, function pointer, or alignment requirement can enlarge every handle.

```cpp
struct MmapDeleter {
    std::size_t size{};
    void operator()(std::byte* p) const noexcept {
        if (p != nullptr) ::munmap(p, size);
    }
};

using mapped_bytes = std::unique_ptr<std::byte, MmapDeleter>;

static_assert(sizeof(std::unique_ptr<int>) >= sizeof(int*));
// Print sizeof(mapped_bytes) on the target; do not assume one word.
```

`release()` gives up ownership without deleting; it is a sharp tool for transferring into an API that assumes responsibility. `reset()` destroys the currently owned object before adopting the new pointer. `get()` observes without transferring.

Destruction can be expensive. `delete` runs `T`'s destructor and deallocates storage; either step may touch many cache lines or interact with allocator state. A `unique_ptr` to an incomplete type is useful in implementation-hiding patterns, but destruction must occur where the deleter can see a complete type for the default delete expression.

For objects allocated from a pool, use a deleter that returns the slot to that pool. Then the pool must outlive every pointer, and destruction may cross a thread boundary. Encoding a raw pool pointer in each deleter adds footprint; encoding ownership by region can be smaller and easier to audit.

## 9.14 `std::shared_ptr`, Control Blocks, and Contention

`std::shared_ptr<T>` provides shared ownership through a **control block**. A common control block contains strong and weak reference counts, type-erased destruction operations, and possibly an allocator or deleter. This is an implementation model, not a standard layout requirement.

```text
shared_ptr<T> object                     common control block
+----------------+                      +--------------------+
| stored pointer |--------------------->| strong count       |
| control pointer|------------------+   | weak count/state   |
+----------------+                  |   | deleter/allocator  |
                                    +-->| object or pointer  |
                                        +--------------------+
```

A `shared_ptr` is commonly two machine words. Copies update shared ownership state, generally with atomic operations because different `shared_ptr` objects sharing a control block may be manipulated by different threads. The standard's thread-safety rules do not make the pointed-to `T` safe for concurrent access.

Implementations need not expose how the two logical counts are encoded. A weak count may include an implicit contribution while strong ownership exists, and decrement operations may use different memory orders from increments. Those choices are designed to make destruction correctly observe prior writes while keeping increments relatively cheap. Do not reach into a control block or imitate guessed memory orders in a custom reference counter.

Atomic reference-count updates create a read-modify-write dependency on one cache line. When ownership copies occur on several cores, that line migrates between caches. Even uncontended increments add instructions and inhibit some compiler motion. Copying a `shared_ptr` per packet or per order is therefore very different from copying it once during configuration.

The last strong release destroys `T`; the last weak release frees the control block. Which thread performs either action depends on runtime ownership history. This makes final destruction unpredictable:

```cpp
void publish(std::shared_ptr<const Snapshot> next) {
    current.store(std::move(next), std::memory_order_release);
    // Replacing current may eventually cause a large old snapshot to be
    // destroyed on this thread or on a later reader thread.
}
```

`std::atomic<std::shared_ptr<T>>` makes publication and acquisition of the smart pointer atomic. It does not promise a lock-free implementation. Query `is_lock_free()` on the deployed library, and still account for control-block traffic.

The **aliasing constructor** creates a shared pointer that owns through one control block but stores a pointer to a subobject or related object. This is useful but separates “what `get()` points to” from “what keeps storage alive,” which can obscure retention. `enable_shared_from_this` similarly depends on an object already owned by a compatible `shared_ptr`; constructing a second control block from the same raw pointer causes double deletion.

Use shared ownership when ownership is truly shared and lifetime cannot be structured more simply. Prefer immutable snapshots, pass `const shared_ptr&` when a called function need not retain ownership, and avoid moving reference counts through the critical path merely for convenience.

Passing by `const shared_ptr&` introduces its own lifetime requirement: the referenced smart-pointer object must remain alive for the call. Passing the pointee by `const T&` communicates even more clearly when the callee neither retains nor changes ownership. At asynchronous boundaries, however, a genuine ownership copy may be necessary. Optimize the architecture, not one increment in isolation.

## 9.15 `make_shared`, Weak References, and Delayed Reclamation

`std::make_shared<T>` commonly allocates the object and control block together. Compared with `shared_ptr<T>{new T(...)}`, this usually performs one allocation, improves locality between the object and control data, and closes a historical exception-safety gap in more complex expressions.

The combined layout changes reclamation. When the final strong owner disappears, `T` is destroyed, but the allocation containing its storage may remain until all `weak_ptr` instances disappear. A large object embedded in that combined allocation can therefore retain substantial memory after its logical lifetime.

With separate allocations, final strong release can deallocate `T` while the smaller control block remains for weak observers. Choose based on object size, weak-reference lifetime, allocation behavior, and cache footprint rather than a blanket rule.

`std::allocate_shared` supplies an allocator for the combined allocation. This can place both object and control data in an arena or pool, but the allocator resource must remain valid until the last weak owner releases the control block. Bulk-resetting that arena while weak pointers survive is a lifetime violation. Pooling control blocks also does not remove the atomic reference-count traffic.

`std::weak_ptr<T>` observes the control block without extending the object's lifetime. `lock()` atomically attempts to create a strong owner:

```cpp
if (auto snapshot = weak_snapshot.lock()) {
    consume(*snapshot);
} else {
    request_refresh();
}
```

The attempt involves synchronization on shared control state. It can fail legitimately when destruction races with the observer. `expired()` followed by constructing or locking is a check-then-act error; the state may change between operations. Use one `lock()` and test its result.

Cycles of strong references never reach a zero strong count. Break ownership cycles with weak edges or, better, redesign the graph so that ownership direction is explicit. `weak_ptr` is not a general lock-free reclamation scheme; its counters and final deallocation still have implementation-dependent synchronization costs.

For large immutable market snapshots, alternatives include epoch reclamation, RCU-style quiescence, or a bounded generation ring. Those techniques move cost and complexity rather than eliminating it. They are developed in Chapter 17.

## 9.16 RAII for Descriptors, Sockets, Mappings, Locks, and Affinity

A Linux resource wrapper should be move-only, recognize its invalid state, release exactly once, and make the failure policy of cleanup explicit. File descriptors use `-1` as the invalid value, not zero.

```cpp
#include <unistd.h>
#include <utility>

class unique_fd {
public:
    unique_fd() noexcept = default;
    explicit unique_fd(int fd) noexcept : fd_{fd} {}

    unique_fd(const unique_fd&) = delete;
    unique_fd& operator=(const unique_fd&) = delete;

    unique_fd(unique_fd&& other) noexcept
        : fd_{std::exchange(other.fd_, -1)} {}

    unique_fd& operator=(unique_fd&& other) noexcept {
        if (this != &other) {
            reset();
            fd_ = std::exchange(other.fd_, -1);
        }
        return *this;
    }

    ~unique_fd() noexcept { reset(); }

    [[nodiscard]] int get() const noexcept { return fd_; }
    [[nodiscard]] explicit operator bool() const noexcept { return fd_ != -1; }
    [[nodiscard]] int release() noexcept { return std::exchange(fd_, -1); }

    void reset(int replacement = -1) noexcept {
        const int old = std::exchange(fd_, replacement);
        if (old != -1) {
            // close errors cannot be retried blindly: the descriptor number
            // may already have been reused after an implementation reports EINTR.
            (void)::close(old);
        }
    }

private:
    int fd_{-1};
};
```

Socket ownership is descriptor ownership, but protocol shutdown is separate from `close`. A wrapper should not silently perform a blocking graceful shutdown in its destructor. Put that policy in an explicit operation.

A mapping wrapper needs both address and length for `munmap`. It must distinguish `MAP_FAILED` from null, preserve page-alignment requirements, and consider whether unmapping on the critical thread can trigger page-table work and TLB shootdowns. Huge-page mappings add configuration and release constraints; RAII cannot make those operations cheap.

Standard lock guards are RAII wrappers too. `std::lock_guard` unlocks at scope exit, while `std::unique_lock` stores additional state so it can defer, release, and reacquire. Neither bounds contention. Destroying a guard at an unexpected return point can wake a waiter and alter scheduling.

An affinity guard that temporarily changes a thread's CPU mask must save and restore the old mask. Restoration can fail, and a destructor cannot report that naturally. Such wrappers need an explicit `restore()` that returns an error plus a best-effort non-throwing destructor. The same pattern applies to scheduler policy and memory-policy state.

The design review for every wrapper is short but strict:

- What exact value means “no resource”?
- Is ownership movable, shareable, or thread-affine?
- Can release block, allocate, invoke the kernel, or fail?
- On which thread does destruction occur?
- Does the resource outlive callbacks and non-owning views?
- Is cleanup during process termination useful or misleading?

RAII gives deterministic control flow and leak resistance. A bounded system still has to place cleanup deliberately.

## 9.17 Interview Check

1. During stack unwinding, which subobjects are destroyed if a constructor throws halfway through construction, and why is the most-derived destructor not called?
2. Compare the strong and basic exception guarantees for an order-book update. How would you structure a non-throwing commit?
3. What does “zero-cost exceptions” usually mean under a table-driven ABI, and which memory and binary-size costs remain on the non-throwing path?
4. Why is allowing exceptions to cross an `extern "C"` callback unsafe even when the surrounding application is written mostly in C++?
5. When would `std::optional<Order>` have a worse cache footprint than a sentinel or a separate presence bitmap?
6. Read a monadic `optional` or `expected` chain and identify which lambdas run on the value path, which run on the error path, and whether any fallback is evaluated eagerly.
7. Explain why `std::shared_ptr` makes ownership thread-safe without making the owned object thread-safe. Where can cache-line contention arise?
8. Compare `make_shared` with separate object and control-block allocations when long-lived weak references observe a large object.
9. A descriptor wrapper receives `EINTR` from `close`. Why can blindly retrying be dangerous, and what cleanup policy would you adopt?
10. A hot thread releases the final owner of a large snapshot and misses its latency budget. Redesign the ownership and reclamation path while specifying queue capacity and overload behavior.
