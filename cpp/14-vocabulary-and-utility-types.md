# 14. Vocabulary and Utility Types

Standard vocabulary types make an interface describe the shape of its data: all fields, one alternative, an optional value, or an erased type. The same library also supplies portable bit operations, deterministic random streams, and unit-safe time. Choosing these types well removes conventions that callers would otherwise have to guess.

## The Shape of Your Data Decides the Type

A **vocabulary type** is a standard type whose meaning C++ readers recognize at an interface boundary. `std::optional<Fill>` communicates “zero or one fill” directly; a `Fill*` plus a separate `bool` requires a convention.

Data shapes fall into five useful categories:

- A **product type** contains all its parts: a class, `std::pair`, or `std::tuple`.
- A **sum type** contains exactly one alternative from a closed set: `std::variant`.
- A **nullable type** contains either one value or nothing: `std::optional`.
- A **result type** contains either a value or a typed failure: `std::expected`.
- A **type-erased type** contains a runtime-selected value hidden behind one interface: `std::any`.

The same lookup can be represented with very different guarantees:

```cpp
struct Order {
    int quantity;
};

struct NotFound {};

std::pair<Order, bool> product_result;       // value and status coexist
std::variant<Order, NotFound> sum_result;    // exactly one result kind
std::optional<Order> nullable_result;        // order or absence
std::expected<Order, NotFound> result;        // order or typed failure
std::any erased_result;                      // runtime type is unspecified
```

The product form can represent contradictory state, such as `false` beside an apparently valid `Order`. The sum and nullable forms rule out that contradiction. Type erasure accepts more possibilities by discarding compile-time knowledge.

| Need | Type | Example |
|---|---|---|
| All fields at once | Named class, `pair`, or `tuple` | `Order{price, quantity}` |
| Exactly one of known kinds | `std::variant` | Trade, quote, or heartbeat |
| One value or absence | `std::optional` | Maybe-found order |
| Value or typed failure | `std::expected` | Parsed price or parse error |
| Unknown type until runtime | `std::any` | Heterogeneous configuration bag |

Prefer a named class for domain data, a tuple-like type for generic glue, `variant` for a closed alternative set, `optional` at “maybe” boundaries, and `expected` for a value-or-error result. Reach for `any` only when the set of possible types genuinely cannot be stated at compile time.

Vocabulary types also compose across libraries. A caller can inspect an `optional` or visit a `variant` without learning a project-specific status convention. That shared syntax lowers coupling, but it does not replace domain naming: `optional<Order>` is expressive, while `tuple<int, int>` still hides what both integers mean.

## Pair, Tuple, and Unpacking

`std::pair<T, U>` is a two-element anonymous product. `std::tuple<Ts...>` generalizes that shape to any fixed number of elements. “Anonymous” means the elements have positions rather than domain names.

That trade is acceptable in local transformations and generic library machinery. It is poor in a business interface: `std::get<0>(result)` says less than `result.price`.

A map's `value_type` is `std::pair<const Key, T>`, so structured bindings provide the readable access syntax. A structured binding **(C++17)** introduces names for the elements of a tuple-like or class object; Chapter 22 gives its full rules.

```cpp
#include <iostream>
#include <map>
#include <string>

struct OrderBook {
    int best_bid;
};

int main() {
    std::map<std::string, OrderBook> books{
        {"AAPL", {201}},
        {"MSFT", {418}}
    };

    for (const auto& [symbol, book] : books) {
        std::cout << symbol << ' ' << book.best_bid << '\n';
    }
    // prints: AAPL 201
    // prints: MSFT 418
}
```

The `&` matters. `auto [symbol, book]` creates element copies; `const auto& [symbol, book]` views the map entry. A reference binding follows the source object's lifetime, while a value binding owns its copies.

`std::tie` creates a tuple of lvalue references. Its enduring use is concise lexicographic comparison:

```cpp
#include <tuple>

struct QuoteKey {
    int price;
    long sequence;
};

bool operator<(const QuoteKey& left, const QuoteKey& right) {
    return std::tie(left.price, left.sequence) <
           std::tie(right.price, right.sequence);
}
```

Comparison checks `price` first and consults `sequence` only when prices compare equal. Before structured bindings, `tie` also unpacked multiple return values through assignment; structured bindings are clearer for new variables.

`std::apply` performs the inverse operation: it expands tuple elements into a function call.

```cpp
#include <tuple>

void place_order(int price, int quantity, bool buy);

void submit_stored_arguments() {
    auto arguments = std::tuple{101, 50, true};
    std::apply(place_order, arguments);
    // equivalent to place_order(101, 50, true)
}
```

This is generic glue: a scheduler or adapter stores heterogeneous arguments, then invokes a callable without naming each position itself.

**Pitfall.** A `tuple<int, int, bool>` in a public trading API makes callers memorize positions. Name the result class and its invariants.

## `std::optional`: Absence Without Sentinels

`std::optional<T>` contains either one `T` or no `T`. It replaces sentinel values such as `-1`, an empty symbol, or a distinguished “invalid” object with a state the type system exposes.

```cpp
#include <optional>
#include <vector>

using OrderId = int;

struct Order {
    OrderId id;
    int quantity;
};

std::optional<Order> find_order(
    const std::vector<Order>& orders,
    OrderId wanted) {
    for (const Order& order : orders) {
        if (order.id == wanted) {
            return order;
        }
    }
    return std::nullopt;
}

int open_quantity(const std::vector<Order>& orders, OrderId id) {
    if (auto order = find_order(orders, id)) {
        return order->quantity;
    }
    return 0;
}
```

An `optional` is **engaged** when it contains a value. Its Boolean test reports engagement, `operator->` accesses a member, and `operator*` accesses the value.

Dereferencing an empty `optional` has undefined behavior. `.value()` checks and throws `std::bad_optional_access`; `.value_or(default_value)` returns a value in both cases:

```cpp
Order find_or_default(const std::vector<Order>& orders) {
    Order fallback{-1, 0};
    return find_order(orders, 42).value_or(fallback);
}
```

Choose by contract:

- Use an engagement check when absence changes control flow.
- Use `.value()` when absence is a violated recoverable precondition.
- Use `.value_or()` when a natural default exists.
- Use unchecked `*value` only after control flow proves engagement.

`std::optional<T&>` does not exist. A nullable non-owning reference is a raw `T*`, following the borrowing rules from Chapter 8.

C++23 adds monadic operations for composing functions that may produce nothing. `and_then` expects a function returning another optional, `transform` maps an engaged value, and `or_else` handles absence.

```cpp
#include <charconv>
#include <optional>
#include <string_view>

struct Book {
    double best_bid;
};

std::optional<int> parse_book_id(std::string_view text) {
    int id = 0;
    auto [end, error] =
        std::from_chars(text.data(), text.data() + text.size(), id);
    if (error != std::errc{} || end != text.data() + text.size()) {
        return std::nullopt;
    }
    return id;
}

std::optional<Book> lookup_book(int id);

double quoted_bid(std::string_view text) {
    return parse_book_id(text)
        .and_then([](int id) { return lookup_book(id); })
        .transform([](const Book& book) { return book.best_bid; })
        .value_or(0.0);
}
```

Each stage runs only when the previous optional is engaged. The chain states the success path without nesting several `if` blocks; `std::from_chars` parsing was introduced in Chapter 12.

An optional stores the `T` inline plus an engagement discriminant and any padding required by alignment. On common implementations, `optional<double>` occupies twice the bytes of `double`; the exact layout belongs to Chapter 16. Large arrays of optionals can therefore reduce cache density.

Optional ordering defines an empty optional as less than an engaged one. That is consistent and useful for generic code, but it may put missing prices first in a sort when the domain expects them last.

## `std::expected`: A Value or a Typed Failure

`std::expected<T, E>` **(C++23)** contains either a successful `T` or an error `E`. Unlike `optional`, it preserves why an operation failed. Unlike an exception, the failure remains ordinary return-value state that the caller tests and composes explicitly.

The four neighboring vocabulary choices answer different questions:

| Question | Type | Failure or alternative information |
|---|---|---|
| Is a value present? | `std::optional<T>` | No reason; engaged or empty |
| Did the operation succeed? | `std::expected<T, E>` | One caller-selected error value |
| Which domain alternative is present? | `std::variant<Ts...>` | Active alternative is part of the value |
| What runtime type was stored? | `std::any` | Type erased; caller must know what to request |

Use `expected` when callers need a recoverable reason and the path should not throw. The error type can be an enumeration, `std::error_code`, or a richer record containing context.

```cpp
#include <charconv>
#include <cstdint>
#include <expected>
#include <string_view>

struct Price {
    std::int64_t ticks;
};

enum class PriceError {
    invalid_number,
    trailing_characters,
    negative,
    off_tick
};

std::expected<std::int64_t, PriceError>
parse_ticks(std::string_view text) {
    std::int64_t ticks = 0;
    const char* end = text.data() + text.size();
    auto [next, error] = std::from_chars(text.data(), end, ticks);

    if (error != std::errc{}) {
        return std::unexpected(PriceError::invalid_number);
    }
    if (next != end) {
        return std::unexpected(PriceError::trailing_characters);
    }
    return ticks;
}

std::expected<Price, PriceError>
validate_price(std::int64_t ticks) {
    if (ticks < 0) {
        return std::unexpected(PriceError::negative);
    }
    if (ticks % 5 != 0) {
        return std::unexpected(PriceError::off_tick);
    }
    return Price{ticks};
}
```

Construction from `std::unexpected(error)` selects the error state. `has_value()` and the Boolean conversion test success; `error()` accesses a proven error. As with `optional`, unchecked `operator*` and `operator->` require a value, while `.value()` checks and throws `std::bad_expected_access<E>`.

C++23 monadic operations express a success pipeline without nesting tests:

```cpp
void record_parse_error(PriceError);

std::expected<Price, PriceError>
decode_price(std::string_view field) {
    return parse_ticks(field)
        .and_then(validate_price)
        .transform([](Price price) {
            return Price{price.ticks / 5 * 5};
        })
        .or_else([](PriceError error)
            -> std::expected<Price, PriceError> {
            record_parse_error(error);
            return std::unexpected(error);
        });
}
```

`and_then` calls a function that itself returns an `expected`. `transform` maps only the successful value. `or_else` handles only the error. `transform_error` changes the error representation while preserving the success type, which is useful when adapting a low-level parser error to a subsystem error.

Commands that succeed without producing a value use `std::expected<void, E>`:

```cpp
struct Order;

enum class SendError {
    disconnected,
    queue_full
};

std::expected<void, SendError> send_order(const Order& order);
void record_send_failure(SendError);

bool submit(const Order& order) {
    auto sent = send_order(order);
    if (!sent) {
        record_send_failure(sent.error());
        return false;
    }
    return true;
}
```

An `expected<void, E>` still has a success/error tag; success simply carries no payload. This is clearer than returning a dummy Boolean when the failure reason matters.

**Rule.** Keep one error vocabulary at each boundary. Translate errors deliberately with `transform_error`; do not make callers understand every lower layer's enumeration.

**Pitfall.** A long monadic chain does not make work free. Each stage still tests the tag, and a large error object is carried inside every `expected` object even on success.

## `std::variant`: The Type-Safe Tagged Union

`std::variant<Ts...>` stores exactly one active alternative from a closed list. The object holds one buffer large enough for its alternatives plus an index that identifies the live type.

A market-data message naturally forms a sum type:

```cpp
#include <iostream>
#include <variant>
#include <vector>

struct Trade {
    int price;
    int quantity;
};

struct Quote {
    int bid;
    int ask;
};

struct Heartbeat {
    long sequence;
};

using Message = std::variant<Trade, Quote, Heartbeat>;

template<class... Callables>
struct Overloaded : Callables... {
    using Callables::operator()...;
};

void process(const Message& message) {
    std::visit(Overloaded{
        [](const Trade& trade) {
            std::cout << "trade " << trade.quantity << '\n';
        },
        [](const Quote& quote) {
            std::cout << "spread " << quote.ask - quote.bid << '\n';
        },
        [](const Heartbeat& heartbeat) {
            std::cout << "heartbeat " << heartbeat.sequence << '\n';
        }
    }, message);  // index-based dispatch, no vtable
}

int main() {
    std::vector<Message> feed{
        Quote{100, 102},
        Trade{101, 25},
        Heartbeat{9001}
    };

    for (const Message& message : feed) {
        process(message);
    }

    if (std::holds_alternative<Trade>(feed[1])) {
        std::cout << std::get<Trade>(feed[1]).price << '\n';
    }
    // prints: spread 2
    // prints: trade 25
    // prints: heartbeat 9001
    // prints: 101
}
```

`Overloaded` combines several lambdas into one visitor with several call operators. Treat its three lines as a recipe; the parameter-pack expansion is explained in Chapter 20. C++20 aggregate deduction infers its callable types; C++17 code adds a deduction guide.

`std::visit` is the default access operation because it handles every alternative in one place. Leaving out an alternative without providing a generic fallback produces a compile error, turning exhaustive handling into a checked property.

For a known-type test, use `std::holds_alternative<T>` followed by `std::get<T>`. `std::get_if<T>(&variant)` returns a pointer or `nullptr` and avoids an exception. `index()` exposes the numeric alternative index, but type-based access is less coupled to list order.

Calling `std::get<T>` for the wrong active alternative throws `std::bad_variant_access`. A visitor avoids that mismatch.

Variant and virtual dispatch solve related problems with opposite extension models:

| Dimension | `variant` plus visit | Virtual base handle |
|---|---|---|
| Set of types | Closed at compile time | Open to new derived classes |
| Wrapper storage | Alternative stored inline | Commonly pointer to separate object |
| Dispatch | Branch or jump on index | Indirect call through vtable |
| Adding a type | Edit list and visitors; recompile | Add derived class |
| Value semantics | Direct, if alternatives support them | Usually pointer/reference semantics |

The variant wrapper performs no allocation for its own storage, though an alternative such as `std::string` may allocate internally. Every `Message` is large enough for its largest alternative, even when it currently holds a small `Heartbeat`.

Virtual dispatch remains appropriate when independent code must add types without editing a central list (Chapter 4). A variant excels when the alternatives are fixed and operations are added more often than message kinds.

Rarely, an exception during a type-changing operation can leave a variant `valueless_by_exception()`. The state is checkable, and non-throwing moves make it much less likely; ordinary designs should preserve strong operations rather than organize every visit around this rare state.

**Interview.** Explain variant as “one inline buffer plus a tag,” then contrast closed-set exhaustive visitation with an open virtual hierarchy. Mention that neither dispatch strategy is universally faster; representation, branch prediction, and surrounding allocation determine the result.

## `std::any` and `std::reference_wrapper`

`std::any` stores one copyable value while erasing its static type. Retrieval succeeds only when `std::any_cast<T>` names the exact stored type.

```cpp
#include <any>
#include <string>
#include <unordered_map>

using Config = std::unordered_map<std::string, std::any>;

int retry_count(const Config& config) {
    return std::any_cast<int>(config.at("retries"));
}

void configure() {
    Config config{
        {"retries", 3},
        {"venue", std::string{"XNAS"}},
        {"enabled", true}
    };

    int retries = retry_count(config);
    (void)retries;

    std::any_cast<long>(config.at("retries"));
    // throws std::bad_any_cast: stored type is exactly int
}
```

The pointer form, `std::any_cast<T>(&value)`, returns `nullptr` on a mismatch instead of throwing. Either form relies on runtime type identification and makes users know a convention not expressed by the container type.

An implementation may keep small values in an inline buffer and heap-allocate larger ones. Buffer size and eligibility are implementation details, so portable code cannot depend on a particular value avoiding allocation.

Use `any` for a truly heterogeneous configuration layer or plugin boundary. If the alternatives are known, `variant` gives checked visitation, clearer documentation, and inline wrapper storage.

`std::reference_wrapper<T>` is a copyable, assignable object that behaves as a stored reference. It lets containers and by-value callable interfaces carry non-owning views.

```cpp
#include <algorithm>
#include <deque>
#include <functional>
#include <ranges>
#include <vector>

struct Order {
    int price;
};

void prioritize(std::deque<Order>& owned_orders) {
    std::vector<std::reference_wrapper<Order>> hot_orders;
    for (Order& order : owned_orders) {
        if (order.price >= 100) {
            hot_orders.push_back(std::ref(order));
        }
    }

    std::ranges::sort(
        hot_orders,
        std::ranges::less{},
        [](const auto& reference) { return reference.get().price; });
}
```

The vector owns reference wrappers, not orders. `.get()` recovers the referenced `Order`, and the projection lets the range algorithm sort views by price (Chapter 13).

`std::ref` creates a mutable wrapper and `std::cref` creates a read-only wrapper. They also preserve reference intent when a generic interface decay-copies its arguments.

**Pitfall.** A `reference_wrapper` dangles exactly like the reference it contains. Every owner must outlive the wrapper vector and every algorithm using it.

## Bits: `bitset` and the `<bit>` Utilities

`std::bitset<N>` represents a fixed number of Boolean flags. It supports named operations such as `.set()`, `.reset()`, `.test()`, and `.count()`, making it clearer than manual shifting for general flag sets.

```cpp
#include <bitset>

void inspect_venues() {
    std::bitset<64> venue_flags;
    venue_flags.set(3);
    venue_flags.set(7);

    bool venue_three = venue_flags.test(3);  // true
    std::size_t enabled = venue_flags.count();  // 2
    (void)venue_three;
    (void)enabled;
}
```

For a hot mask that fits a machine integer, `<bit>` **(C++20)** exposes operations that map directly to mainstream CPU instructions:

| Operation | Meaning |
|---|---|
| `std::popcount(x)` | Number of set bits |
| `std::countl_zero(x)` | Zero bits before the highest set bit |
| `std::countr_zero(x)` | Zero bits after the lowest set bit |
| `std::bit_ceil(x)` | Smallest power of two not less than `x` |
| `std::bit_floor(x)` | Largest power of two not greater than `x` |
| `std::has_single_bit(x)` | Whether `x` is a power of two |

An order book can use bit `i` to mean price level `i` contains orders:

```cpp
#include <bit>
#include <cstdint>
#include <iostream>

int main() {
    std::uint64_t occupied = 0;
    occupied |= std::uint64_t{1} << 7;
    occupied |= std::uint64_t{1} << 3;
    occupied |= std::uint64_t{1} << 12;

    int best_level = std::countr_zero(occupied);
    int active_levels = std::popcount(occupied);

    std::cout << best_level << ' ' << active_levels << '\n';
    // prints: 3 3

    occupied &= ~(std::uint64_t{1} << 3);
    // next std::countr_zero(occupied) == 7

    constexpr auto capacity = std::bit_ceil(std::uint64_t{1000});
    static_assert(capacity == 1024);
}
```

`std::countr_zero(std::uint64_t{0})` returns `64`. That answer is well-defined but not a valid level index, so check for an empty mask before indexing. Shifting by the type width or more has undefined behavior (Chapter 3), so validate every external level before forming the mask.

`bit_ceil` is useful for power-of-two indexing schemes such as ring buffers; Chapter 26 applies that shape to queues.

**Pitfall.** `bitset::to_ulong()` throws `std::overflow_error` when any set bit does not fit in `unsigned long`. The bitset's compile-time size does not guarantee the conversion fits.

## `std::simd`: Data Parallelism as a Type

The C++26 `<simd>` facility **(C++26)** represents several same-typed lanes in one value. Element-wise operators state data parallelism directly instead of relying on an optimizer to prove that a scalar loop has safe aliasing, trip counts, and floating-point transformations.

The adopted interface is in namespace `std::simd`. `std::simd::vec<float>` selects a native width, while `std::simd::vec<float, 8>` requests eight lanes. Width is part of the type and can depend on target compilation flags for the native form.

```cpp
// C++26: requires <simd>
#if __has_include(<simd>)
#include <simd>
#endif
#include <span>

#if defined(__cpp_lib_simd)
float sum_prices(std::span<const float> prices) {
    using Lanes = std::simd::vec<float>;
    Lanes sums{};
    std::size_t i = 0;

    for (; i + Lanes::size() <= prices.size();
         i += Lanes::size()) {
        auto chunk = std::simd::unchecked_load<Lanes>(
            prices.subspan(i, Lanes::size()));
        sums += chunk;
    }

    float total = std::simd::reduce(sums);
    for (; i < prices.size(); ++i) {
        total += prices[i];
    }
    return total;
}
#endif
```

The load reads one contiguous register-width chunk, addition updates all lanes, and `reduce` combines the lanes to one scalar. The scalar epilogue handles elements after the final complete chunk; masked or partial operations provide another tail strategy.

Floating-point addition is not associative. Grouping inputs into lanes changes intermediate rounding, so the SIMD sum can differ slightly from a left-to-right scalar sum. A backtest that requires bit-for-bit reproducibility must fix its reduction order, compiler flags, and target.

This is a preview. Masking, alignment, instruction throughput, and portable dispatch belong to *Computer Architecture and Performance Engineering*.

## Random Numbers Done Right

The random library separates an **engine**, which produces a deterministic stream of bits, from a **distribution**, which maps those bits to a requested statistical shape.

| Component | Owns evolving state? | Examples | Reuse policy |
|---|---:|---|---|
| Engine | Yes | `mt19937_64`, `minstd_rand` | Keep and advance |
| Distribution | Sometimes caches parameters/results | `uniform_int_distribution`, `normal_distribution` | Reuse or create from stable parameters |
| Seed source | Platform-dependent | `random_device` | Use only when nondeterminism is intended |

`std::mt19937_64` is a practical default engine for simulation. Keep the engine alive and draw repeatedly; its state occupies kilobytes, so construction and seeding are not per-draw operations.

```cpp
#include <iostream>
#include <random>

int main() {
    std::mt19937_64 engine{0xC0FFEE};
    std::uniform_real_distribution<double> jitter{-0.01, 0.01};

    for (int i = 0; i < 10; ++i) {
        std::cout << 100.0 + jitter(engine) << '\n';
    }
    // same sequence on every run with this library implementation
}
```

A fixed seed is the trading default for backtests, simulations, and reproducible tests. Store the seed with the run metadata so a failure can be replayed exactly.

Choose a distribution that states the requested range and shape. `std::uniform_int_distribution<int>{0, venue_count - 1}` handles the engine's range without the modulo bias of hand-written `% venue_count`; a normal distribution carries its mean and standard deviation as typed parameters.

When nondeterministic seeding is actually required:

```cpp
std::random_device source;
std::mt19937_64 engine{source()};
```

`std::random_device` may use operating-system entropy, but the standard permits a deterministic implementation. Check the target platform rather than treating its name as a guarantee.

Do not use `std::rand()`:

- It exposes global mutable state.
- Its range may be small.
- `rand() % n` introduces modulo bias unless the range divides evenly.
- Its quality guarantees are inadequate for serious simulation.

Constructing an engine for every draw wastes setup work and repeatedly restarts streams instead of advancing one designed sequence. Keep an engine as simulation state; later thread-local use requires one engine per thread rather than unsynchronized sharing (Chapter 25).

**Note.** A given engine and seed produce a specified engine sequence, but distribution algorithms may differ between libstdc++, libc++, and MSVC. Identical seeds do not guarantee identical `std::normal_distribution` results across libraries.

## `chrono`: Durations, Time Points, and Clocks

`std::chrono::duration` combines a numeric count with a compile-time unit ratio. A `std::chrono::time_point` is a duration since a particular clock's epoch. These types prevent an unlabelled `long` from silently crossing an interface as nanoseconds in one caller and microseconds in another.

Duration conversions are implicit only when they cannot lose precision. Converting milliseconds to microseconds is safe; converting microseconds to whole milliseconds requires an explicit cast.

```cpp
#include <chrono>

using namespace std::chrono_literals;

constexpr auto timeout = 5ms;
constexpr auto polling = 250us;
constexpr auto truncated =
    std::chrono::duration_cast<std::chrono::milliseconds>(1500us);

static_assert(timeout == std::chrono::milliseconds{5});
static_assert(polling == std::chrono::microseconds{250});
static_assert(truncated.count() == 1);  // fractional millisecond discarded
```

Choose a clock by semantics:

| Clock | Monotonic? | Epoch | Use |
|---|---:|---|---|
| `std::chrono::steady_clock` | Yes | Unspecified | Intervals and latency measurement |
| `std::chrono::system_clock` | No | Unix time since C++20 | Wall timestamps and calendar interop |
| `std::chrono::high_resolution_clock` | Alias | Alias-dependent | Nothing; choose semantics explicitly |

`steady_clock` never moves backward, so it measures elapsed work even while wall time is adjusted. `system_clock` represents civil wall time and can jump under administrative or network time corrections.

`high_resolution_clock` is only an implementation-defined alias for another clock. Its name guarantees neither monotonicity nor a better physical timer, so portable code should not use it.

Timestamp latency boundaries with the same steady clock and subtract the stored time points:

```cpp
#include <chrono>

struct Message {};

void handle(const Message& message);
void record_latency(std::chrono::nanoseconds elapsed);

void on_message(const Message& message) {
    auto packet_in = std::chrono::steady_clock::now();
    handle(message);
    auto order_out = std::chrono::steady_clock::now();

    auto elapsed =
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            order_out - packet_in);
    record_latency(elapsed);
}
```

Subtracting time points produces a duration. Time points from different clocks cannot be subtracted, which turns a meaningless operation into a compile error.

`now()` has a real platform-dependent cost. It may use a vDSO helper, a hardware counter sequence, or a system call, so timestamp path boundaries rather than every inner-loop instruction.

**Pitfall.** Measuring an interval with `system_clock` lets wall-clock adjustment create negative or distorted durations. Use `steady_clock` for elapsed time.

## Calendar and Time Zones

The C++20 calendar types represent civil dates without hand-written month lengths and leap-year rules. `std::chrono::year_month_day`, `weekday`, and `year_month_day_last` cover ordinary trading-calendar calculations.

```cpp
#include <chrono>

using namespace std::chrono;
using namespace std::chrono_literals;

auto today_days = floor<days>(system_clock::now());
year_month_day today{today_days};

year_month_day settlement = 2026y / 7 / 24;
weekday settlement_day{sys_days{settlement}};
year_month_day_last month_end =
    2026y / July / last;
```

An exchange session is defined in a local time zone, while event sequencing needs one global timeline. `std::chrono::zoned_time` pairs a time-zone rule set with a `sys_time`, so New York's `09:30` open converts correctly across daylight-saving transitions.

```cpp
// C++20 timezone support requires an implementation with the tz database API.
#include <chrono>
#include <iostream>

using namespace std::chrono;
using namespace std::chrono_literals;

#if defined(__cpp_lib_chrono) && __cpp_lib_chrono >= 201907L
void print_nyse_open() {
    year_month_day session_date = 2026y / 7 / 24;
    local_time<minutes> local_open =
        local_days{session_date} + 9h + 30min;

    zoned_time ny_open{"America/New_York", local_open};
    sys_time<minutes> utc_timeline = ny_open.get_sys_time();

    std::cout << ny_open << '\n';
    std::cout << utc_timeline << '\n';
}
#endif
```

Represent the LSE open in `Europe/London` the same way, convert both to `sys_time`, then compare. Adding a fixed offset such as five hours fails when daylight-saving rules differ by date.

`utc_time` counts leap seconds; `sys_time` follows the system-clock timeline that does not count them. Market-data APIs commonly use `sys_time` or an equivalent UTC-labelled Unix timestamp.

**Note.** Calendar support is widespread, but standard time-zone database availability still varies by standard-library version and platform. Check the deployment toolchain and its database update path.

## Latency Lens

- `optional<T>` adds a discriminant and padding, so arrays of optional values can carry substantially less payload per cache line.
- `expected<T, E>` reserves inline storage for its larger alternative plus a tag; a large diagnostic error type reduces success-path cache density too.
- `variant` stores alternatives inline and dispatches on an index without a vtable; every object is still as large as its largest alternative.
- `any` may allocate when storing a value and performs runtime type identification on access, making it unsuitable for tick-path data.
- `popcount`, `countr_zero`, and `bit_ceil` map to direct machine operations on mainstream targets, replacing scans and branchy arithmetic.
- C++26 SIMD types make lane-wise execution explicit when aliasing or floating-point rules would prevent scalar-loop vectorization.
- `mt19937_64` carries kilobytes of engine state; construct and seed once, then draw repeatedly.
- `chrono` unit checking occurs at compile time, so duration arithmetic costs the same underlying integer or floating-point operations.
- `steady_clock::now()` is often a vDSO or hardware-counter read but is not free; timestamp path boundaries rather than inner operations.
- A vector of `reference_wrapper<Order>` avoids copying orders but pays one pointer indirection per access and depends on owner lifetime.
