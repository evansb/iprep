# 6. Errors and Exceptions

An error policy decides which failures become values, which cross function boundaries as exceptions, and which end the process. The right choice follows from the failure contract and from who can take useful action. On latency-sensitive paths, that choice also determines whether failure costs a branch or a cache-cold stack unwind.

## What counts as an error

A **failure contract** states what can fail and how the function reports it. A wide contract defines behavior for every possible input; a narrow contract has preconditions, and violating them can trigger an assertion or undefined behavior.

A failed operation belongs to one of three broad classes:

- A programming bug violates a precondition or invariant. Do not recover locally; fail loudly.
- A recoverable runtime failure includes a missing file, malformed input, or dropped connection. Report it to a caller that can choose another action.
- An unrecoverable environment failure includes exhausted memory or state known to be corrupted. Terminate unless the application has a specifically designed recovery boundary.

The practical question is not “which mechanism is best?” It is “who can act on this failure?” Report the error to the nearest party that can retry, substitute, reject, or inform an operator.

| Mechanism | Signature shape | Happy-path cost | Error-path cost | Composability | Use when |
|---|---|---|---|---|---|
| Exception | `T f()` plus `throw` | No explicit branch | Allocation and unwind | Propagates automatically | Distant caller can recover; failure is uncommon |
| Error code | `bool f(T&, std::error_code&)` | Check or branch | Value construction | Manual checks | Existing non-throwing or system API |
| `std::optional<T>` **(C++17)** | `std::optional<T> f()` | Tag test | Return empty tag | Explicit checks | Failure has one meaning |
| `std::expected<T, E>` **(C++23)** | `std::expected<T, E> f()` | Tag test | Return error value | Explicit checks | Caller needs a reason without throws |
| Assert or terminate | `T f()` with precondition | None or a check | Process stops | Does not compose | Bug or unusable process state |

**Rule.** Put narrow-contract preconditions in the signature or documentation. Never make callers guess whether an invalid argument is rejected, ignored, or undefined.

## Exceptions: throw, catch, unwind

`throw` creates an exception object and transfers control to a matching handler. A `try` block marks the region whose exceptions its `catch` clauses can handle.

Throw exceptions by value and catch them by `const` reference. Catching by value copies the object and can slice a derived exception to its base type, just like other by-value polymorphic operations (Chapter 4).

The standard exception hierarchy has `std::exception` at its root. Its virtual `what()` member returns a diagnostic string. `std::logic_error` represents violated program logic, while `std::runtime_error` represents failures detectable only while the program runs; both have more specific derived classes.

An application exception can carry domain meaning through that hierarchy:

```cpp
#include <exception>
#include <iostream>
#include <stdexcept>
#include <string_view>

class OrderRejected : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class Trace {
public:
    explicit Trace(std::string_view name) : name_(name) {
        std::cout << "enter " << name_ << '\n';
    }

    ~Trace() {
        std::cout << "leave " << name_ << '\n';
    }

private:
    std::string_view name_;
};

void check_risk() {
    Trace trace{"risk"};
    throw OrderRejected{"position limit exceeded"};
}

void match_order() {
    Trace trace{"match"};
    check_risk();
}

void route_order() {
    Trace trace{"route"};
    match_order();
}

int main() {
    try {
        route_order();
    } catch (const std::exception& error) {
        std::cout << "caught: " << error.what() << '\n';
    }
}
```

```text
enter route
enter match
enter risk
leave risk
leave match
leave route
caught: position limit exceeded
```

The search for a handler moves outward through calling functions. Before control enters the handler, **stack unwinding** destroys every fully constructed automatic object between the `throw` expression and that handler, in reverse construction order.

RAII makes unwinding safe: owned resources live in objects whose destructors release them (Chapter 5). C++ needs no `finally` block for ordinary cleanup because cleanup belongs in destructors, not after the code that might throw.

Handlers are tested from top to bottom, and the first type match wins. Put derived exception types before their bases:

```cpp
void handle_order() {
    try {
        route_order();
    } catch (const OrderRejected& error) {
        std::cout << "reject: " << error.what() << '\n';
    } catch (const std::runtime_error& error) {
        std::cout << "runtime failure: " << error.what() << '\n';
    } catch (const std::exception& error) {
        std::cout << "standard exception: " << error.what() << '\n';
    } catch (...) {
        throw;  // rethrow without changing the exception's type
    }
}
```

`catch (...)` matches every exception, including non-standard exception types. Use it at a boundary that can add context, translate the failure, or terminate. An empty `catch (...) {}` silently turns a known failure into unknown state.

**Pitfall.** A destructor that lets an exception escape while another exception is already unwinding causes `std::terminate`. Destructors should not throw; make cleanup operations non-throwing and handle their failures internally.

## What exceptions cost

Mainstream C++ implementations use a table-driven, often called **zero-cost**, exception model. “Zero-cost” describes the normal execution path: entering a `try` block usually adds no branch or register bookkeeping. Metadata in sections such as `.eh_frame` tells the runtime how to unwind if a throw occurs.

Compare a guarded call with the same call without a handler in Compiler Explorer (Chapter 1):

```cpp
int read_quote();  // may throw

int unguarded_quote() {
    return read_quote() + 1;
}

int guarded_quote() {
    try {
        return read_quote() + 1;
    } catch (...) {
        return -1;
    }
}
```

On the normal path, both typically contain the same call and arithmetic. The guarded version also has an out-of-line landing pad and unwind-table entries for the exceptional edge.

Throwing is deliberately expensive. The runtime creates the exception object, walks unwind information frame by frame, runs destructors, and matches a handler using runtime type information. This touches cache-cold code and data; some runtimes can also synchronize while managing exception objects.

Unwind tables increase binary size even when no exception is thrown. Landing pads and supporting code can dilute the instruction cache, although link-time optimization and section garbage collection may remove unreachable pieces.

**Pitfall.** “Exceptions are slow” is too imprecise to guide design. An untaken `try` block usually costs no executed instructions; a `throw` is orders of magnitude more work than a normal function return.

Low-latency systems therefore avoid throwing on the tick-to-trade path, not necessarily exceptions everywhere. Startup, configuration, and reconnection paths are natural places for exceptions when failures are rare and recovery occurs several calls away.

## Exception-safety guarantees

An **exception-safety guarantee** describes the observable program state after an operation throws. Higher levels promise more, but can require extra work or temporary storage.

| Guarantee | Promise after throw | Typical technique |
|---|---|---|
| Nothrow | Operation cannot emit an exception | Non-throwing primitives; `noexcept` |
| Strong | State is unchanged | Prepare separately, then commit |
| Basic | Invariants hold; no resources leak | RAII for every owned resource |
| None | State may violate invariants | Partial mutation without rollback |

`std::vector::push_back` commonly illustrates the strong guarantee: if growth fails, the vector remains unchanged. The exact guarantee has conditions involving element operations; whether a vector can move rather than copy elements depends on `noexcept` (Chapter 7), and growth mechanics belong to Chapter 10.

Suppose an `Order` requires `0 <= filled_quantity <= requested_quantity`. Mutating before validation breaks that invariant if validation throws:

```cpp
struct Order {
    int requested_quantity;
    int filled_quantity;
    double filled_notional;
};

struct Fill {
    int quantity;
    double price;
};

void apply_fill_unsafe(Order& order, Fill fill) {
    order.filled_quantity += fill.quantity;

    if (order.filled_quantity > order.requested_quantity) {
        throw std::runtime_error{"overfill"};
    }

    order.filled_notional += fill.quantity * fill.price;
}
```

After an overfill, `order.filled_quantity` exceeds `order.requested_quantity`. The object is destructible and owns no leaked resources, but its stated invariant is broken, so this operation provides no guarantee.

Prepare the prospective state in local values, validate it, and commit only with non-throwing assignments:

```cpp
void apply_fill(Order& order, Fill fill) {
    const int next_quantity = order.filled_quantity + fill.quantity;
    const double next_notional =
        order.filled_notional + fill.quantity * fill.price;

    if (next_quantity > order.requested_quantity) {
        throw std::runtime_error{"overfill"};
    }

    order.filled_quantity = next_quantity;
    order.filled_notional = next_notional;
}
```

If validation throws, `order` is unchanged: the strong guarantee. Both examples have the narrow precondition that quantities are non-negative and their addition is representable as `int`; violating that signed range would itself be undefined behavior.

The basic guarantee still requires all invariants to hold and all resources to remain managed. RAII delivers it cheaply because there is no separate cleanup sequence for a throw to skip. Strong-guarantee code performs potentially throwing work on the side, then commits using non-throwing operations; copy-and-swap is one form of that pattern, revisited with moves in Chapter 7.

## noexcept and scope guards

`noexcept` is a checked promise that an exception will not escape a function. If one does, the implementation calls `std::terminate`; do not depend on intermediate stack frames being unwound.

```cpp
void close_session() noexcept {
    throw std::runtime_error{"close failed"};  // terminates
}
```

Mark destructors, swaps, and cheap queries `noexcept` when their implementations truly uphold that contract. Destructors are implicitly non-throwing in the usual case. A conditional `noexcept` can make the promise depend on another operation, with its template machinery covered in Chapter 20.

`noexcept` lets callers omit exceptional control-flow paths. Its largest library consequence is that a vector only moves elements during some reallocations when their move operation is non-throwing; Chapter 7 makes that rule precise.

A **scope guard** runs an arbitrary action when control leaves a scope, whether by return or exception. It is useful when cleanup does not yet have a natural owning type.

```cpp
struct ScopeExit {
    void (*action)() noexcept;
    bool active = true;

    ~ScopeExit() noexcept {
        if (active) {
            action();
        }
    }

    void dismiss() noexcept {
        active = false;
    }
};

void begin_book_update();
void apply_book_change();
bool book_is_valid();
void commit_book_update() noexcept;
void rollback_book_update() noexcept;

bool update_book() {
    begin_book_update();
    ScopeExit rollback{rollback_book_update};

    apply_book_change();
    if (!book_is_valid()) {
        return false;  // rollback runs
    }

    commit_book_update();
    rollback.dismiss();
    return true;
}
```

The guard performs rollback on an early return or exception. Calling `dismiss()` after commit prevents rollback on the successful path.

C++23 standardizes `std::scope_exit` in `<scope>`, though library availability can lag the language mode. Older libraries may expose `std::experimental::scope_exit`; that experimental spelling is not standard. Lambdas make stateful guards pleasant, after Chapter 9 introduces them.

**Pitfall.** `noexcept` does not mean “the compiler proved this cannot throw.” It means “terminate if an exception escapes.”

**Pitfall.** A stateful scope guard often stores a pointer or reference to the state it cleans up. The state must outlive the guard, or the cleanup accesses a dangling object (Chapter 5).

## Living without exceptions

Some trading, game, and embedded codebases compile with `-fno-exceptions`. This implementation option is not part of the C++ standard, but GCC and Clang commonly support it.

It can provide:

- No application throw paths or handler landing pads.
- Reduced unwind metadata where the platform and tooling permit its removal.
- A policy that every recoverable failure is visible in a return type.
- Simpler control-flow reasoning at strict latency boundaries.

It also imposes costs:

- Throwing library operations such as `std::vector::at` and `std::stoi` are unusable or terminate, depending on the library and build.
- Allocation failure usually becomes a terminate policy; Chapter 17 covers allocation failure and `std::bad_alloc`.
- A constructor cannot return an error, so fallible setup needs two-phase initialization or a factory.
- Every dependency and ABI boundary must obey a compatible exception policy.
- Error codes and `std::expected` checks spread through call chains; the error has not disappeared.

A factory makes constructor failure explicit:

```cpp
struct Config {
    bool endpoint_is_valid;
};

class Session {
public:
    explicit Session(const Config&) {}
};

[[nodiscard]] std::optional<Session> open_session(const Config& config) {
    if (!config.endpoint_is_valid) {
        return std::nullopt;
    }
    return Session{config};
}
```

The full vocabulary-type treatment of `std::optional` and `std::expected` is in Chapter 14.

**Pitfall.** In a half-disabled build, an exception entering a translation unit compiled without exception support commonly terminates the process. Treat exception mode as a boundary-wide build contract, not a per-file preference.

## Error codes, optional, expected

Legacy C APIs often report failure through `errno`, a thread-local integer flag. The caller must inspect it only after an operation indicates failure; successful operations need not clear it, and another library call can overwrite it.

```cpp
#include <cerrno>
#include <cstdio>
#include <filesystem>
#include <system_error>

bool config_exists_legacy() {
    std::FILE* file = std::fopen("engine.cfg", "rb");
    if (file == nullptr) {
        return false;  // errno ignored: missing and denied look identical
    }
    std::fclose(file);
    return true;
}

void inspect_config_size() {
    std::error_code error;
    const auto bytes = std::filesystem::file_size("engine.cfg", error);
    if (error) {
        std::fprintf(stderr, "size failed: %s\n", error.message().c_str());
    } else {
        std::printf("size: %ju\n", static_cast<std::uintmax_t>(bytes));
    }
}
```

`std::error_code` is a small value containing an integer and an error category. Construction, copying, and tests are non-throwing; it also interoperates with `std::system_error`, the exception wrapper for system-style errors. Filesystem and socket libraries commonly offer overloads that fill an `std::error_code` instead of throwing.

`std::optional<T>` represents either a `T` or no value. Use it when absence needs no explanation:

```cpp
std::optional<int> best_bid(std::string_view symbol);

void show_bid() {
    if (std::optional<int> bid = best_bid("EURUSD"); bid.has_value()) {
        std::cout << *bid << '\n';
    } else {
        std::cout << "no bid\n";
    }

    const int displayed = best_bid("EURUSD").value_or(0);
    std::cout << "displayed: " << displayed << '\n';
}
```

Dereferencing an empty optional with `*` is undefined behavior. Calling `.value()` instead checks and throws `std::bad_optional_access`; choose the operation that fits the surrounding error policy.

`std::expected<T, E>` contains either a successful `T` or an error `E`. It is the modern default for recoverable failures on paths that must not throw because the reason remains part of the return value.

```cpp
#include <cstdint>
#include <expected>
#include <iostream>
#include <limits>
#include <string_view>

struct Price {
    std::int64_t ticks;
};

enum class ParseError {
    empty,
    invalid_character,
    overflow
};

[[nodiscard]] std::expected<Price, ParseError>
parse_price(std::string_view text) {
    if (text.empty()) {
        return std::unexpected(ParseError::empty);
    }

    std::int64_t value = 0;
    for (char character : text) {
        if (character < '0' || character > '9') {
            return std::unexpected(ParseError::invalid_character);
        }

        const std::int64_t digit = character - '0';
        const std::int64_t limit =
            std::numeric_limits<std::int64_t>::max();
        if (value > (limit - digit) / 10) {
            return std::unexpected(ParseError::overflow);
        }
        value = value * 10 + digit;
    }

    return Price{value};
}

std::string_view error_name(ParseError error) {
    switch (error) {
    case ParseError::empty:
        return "empty";
    case ParseError::invalid_character:
        return "invalid character";
    case ParseError::overflow:
        return "overflow";
    }
    return "unknown";
}

int main() {
    for (std::string_view text : {"18750", "18x50"}) {
        const auto price = parse_price(text);
        if (price.has_value()) {
            std::cout << price->ticks << '\n';
        } else {
            std::cout << error_name(price.error()) << '\n';
        }
    }
}
```

```text
18750
invalid character
```

The caller must inspect the tag before dereferencing. Dereferencing an unexpected value is undefined behavior; `.value()` checks and throws `std::bad_expected_access<E>`.

| Question | `std::optional<T>` | `std::expected<T, E>` |
|---|---|---|
| Carries a reason? | No | Yes |
| Error type | None | Caller-selected `E` |
| `*` without a value | Undefined behavior | Undefined behavior |
| Checked access | `.value()` throws | `.value()` throws |
| Prefer when | Absence has one meaning | Caller needs failure detail |

`[[nodiscard]]` asks the compiler to diagnose an ignored result (Chapter 3). Apply it to factories and parsing functions whose errors callers must confront. This chapter composes `std::expected` with explicit checks; monadic operations such as `and_then` and `or_else`, along with the full APIs of both vocabulary types, belong to Chapter 14.

## Termination: when crashing is correct

`std::terminate` is the language runtime's response when exception handling cannot continue, including an exception escaping a `noexcept` function. Its default handler calls `std::abort`.

`std::abort` ends the process abnormally, commonly raising `SIGABRT` and allowing the operating environment to produce a core dump. It does not unwind the stack, run destructors, or guarantee that buffered output is flushed.

`assert(expression)` checks a programmer assumption in builds where assertions are enabled. Defining `NDEBUG` removes the expression completely, so assertions cannot enforce production trust boundaries.

```cpp
#include <cassert>
#include <cstdlib>
#include <iostream>

void send_order(int quantity, bool gateway_is_trusted) {
    assert(quantity > 0);

    if (!gateway_is_trusted) {
        std::cerr << "untrusted gateway state\n";
        std::abort();
    }

    std::cout << "sent " << quantity << '\n';
}
```

For a trading system, silently operating on a corrupted order book can be worse than stopping. A hot-path precondition violation is a bug-class failure: record what is safely available, abort, and let supervision isolate or restart the process. Keep cheap always-on checks at trust boundaries; use assertions liberally for internal invariants during development.

**Pitfall.** Never put required side effects inside `assert`, as in `assert(initialize())`; the call vanishes when `NDEBUG` is defined.

**Rule.** Treat a crash as a designed response only when continuing cannot be made correct. Since abort skips RAII cleanup and buffered writes, external resources are dropped hard and recovery belongs to the surrounding system.

## Latency Lens

- Table-driven exceptions make the non-throwing path branch-free on mainstream ABIs; an untaken `try` block normally adds no executed instructions.
- A throw allocates an exception object, walks unwind tables, runs destructors, and matches handlers through RTTI; keep it off the tick-to-trade path.
- Unwind tables and landing pads enlarge the binary and can dilute the instruction cache even when no exception is thrown.
- `noexcept` lets callers omit exceptional edges and enables move-based vector reallocation when element moves uphold it (Chapter 7).
- `std::expected` returns an error as ordinary value state; propagation costs explicit tests and branches rather than an unwind walk.
- `errno` is thread-local state whose value must be copied before another library call can clobber it, imposing a read-after-call dependency.
- `assert` disappears under `NDEBUG`; cheap always-on invariant checks retain a branch and belong at selected trust boundaries.
- `std::abort` skips destructors and buffered output for the shortest fail-stop path; process supervision, not damaged in-process state, performs recovery.
