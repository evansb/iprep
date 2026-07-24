# 15. Formatting and I/O

I/O performance depends on representation, conversion, buffering, and the point at which the operating system becomes involved. Modern C++ makes ordinary text output concise and checked, but a latency-sensitive path often should not format or write at all. The right layer follows from what must happen now and what can be deferred.

## A Map of I/O

Three independent axes describe an I/O design:

| Axis | Option A | Option B | Cost driver |
|---|---|---|---|
| Representation | Text | Binary | Conversion now versus decoder tooling |
| Transfer | Formatted | Raw | Per-value formatting versus byte copy |
| Buffering | Buffered | Unbuffered | Memory copy versus write system call |

Text represents a `double` such as `42.5` as characters. Binary representation writes bytes chosen by a data format or the object's representation. Text is inspectable and portable across many tools; binary needs a decoder and careful representation rules.

Formatted transfer converts each value according to a format specification. Raw transfer moves bytes without interpreting them. Buffering accumulates several transfers in memory so one operating-system write can carry a batch.

The same order can take a text path and a raw binary path:

```cpp
#include <array>
#include <cstdint>
#include <cstdio>
#include <string_view>

#if __has_include(<print>)
#include <print>
#endif

struct Order {
    std::array<char, 4> symbol;
    double price;
    std::uint32_t quantity;
};

void write_order(std::FILE* binary_file, const Order& order) {
#if defined(__cpp_lib_print)
    std::println("{} {:.2f} x{}",
                 std::string_view{order.symbol.data(),
                                  order.symbol.size()},
                 order.price,
                 order.quantity);
    // human-readable, variable byte count
#endif

    std::fwrite(&order, sizeof order, 1, binary_file);
    // decoder-readable, exactly sizeof(Order) bytes
}
```

The raw recipe is appropriate only for an agreed representation. Whether a class may be copied as bytes, how padding behaves, and how byte order crosses machines are Chapter 16 topics.

Text conversion costs work per value. Binary defers that conversion but adds schema, versioning, and decoder obligations. Deferred-format logging chooses binary, raw, and buffered: record now, format later.

## Streams, Buffers, and the Price of Iostreams

An output stream is a formatting state machine layered over a stream buffer:

```text
application
    |
    v
std::ostream       formatting, sentry, state, locale
    |
    v
std::streambuf     buffered characters, virtual overflow()
    |
    v
OS file descriptor or device
```

Each formatted insertion such as `stream << number` constructs a **sentry**, an object that checks stream state, performs tie-related work, and prepares the operation. Numeric conversion consults locale facets and shared formatting flags. The stream buffer exposes a virtual interface when its buffer must interact with the device.

This flexibility stacks several mechanisms before bytes move:

- Sentry construction and stream-state checks.
- Reading sticky width, base, precision, and alignment state.
- Locale-facet lookup and virtual conversion machinery.
- Stream-buffer dispatch and eventual device write.

Formatting manipulators can mutate state that later callers inherit:

```cpp
#include <iomanip>
#include <iostream>

int main() {
    int order_id = 255;
    int quantity = 42;

    std::cout << std::hex << order_id << '\n';
    std::cout << quantity << '\n';
    // prints: ff
    // prints: 2a
}
```

The quantity is correct but rendered under the leaked hexadecimal state. Saving and restoring `stream.flags()` can contain legacy stream formatting; a self-contained `std::format` call is simpler.

Buffering matters independently of formatting. `'\n'` inserts one character, while `std::endl` inserts a newline and flushes:

```cpp
void write_rows() {
    for (int row = 0; row < 100; ++row) {
        std::cout << row << '\n';       // buffer may batch writes
    }
    std::cout << "done" << std::endl;   // newline, then flush
}
```

A flush asks the library to push buffered characters toward the operating system. Repeating `std::endl` in a loop defeats batching and can produce a write system call per line.

`std::cerr` has the `unitbuf` flag set, so normal insertions flush eagerly. `std::clog` uses buffered behavior and is the better classic stream for batched diagnostics.

**Pitfall.** `std::cout` is process-wide mutable formatting state. One helper that forgets to restore `std::hex`, precision, or alignment changes unrelated output later.

## File and String Streams

`std::ifstream` and `std::ofstream` own file handles through RAII (Chapter 5). Destruction closes the file, including on early return. Constructors do not throw on an ordinary open failure unless an exception mask was configured, so check the stream.

Use streams for line transport and `std::from_chars` for locale-free conversion (Chapter 12):

```cpp
#include <charconv>
#include <fstream>
#include <string>
#include <string_view>
#include <vector>

struct Tick {
    long sequence;
    double price;
};

std::vector<Tick> read_ticks() {
    std::ifstream input{"ticks.csv"};
    if (!input) {
        return {};
    }

    std::vector<Tick> ticks;
    std::string line;
    while (std::getline(input, line)) {
        std::string_view view{line};
        std::size_t comma = view.find(',');
        if (comma == std::string_view::npos) {
            continue;
        }

        Tick tick{};
        auto sequence = view.substr(0, comma);
        auto price = view.substr(comma + 1);
        auto seq_result = std::from_chars(
            sequence.data(), sequence.data() + sequence.size(),
            tick.sequence);
        auto price_result = std::from_chars(
            price.data(), price.data() + price.size(), tick.price);

        if (seq_result.ec == std::errc{} &&
            price_result.ec == std::errc{}) {
            ticks.push_back(tick);
        }
    }
    return ticks;
}  // input closes here
```

Production parsing should also require each result pointer to reach the field end; otherwise a valid numeric prefix can hide trailing garbage. The example keeps transport and conversion visibly separate.

`std::stringstream` is an in-memory iostream. It remains common in legacy parsers and is convenient for quick adapters, but it retains locale and formatting machinery. Construction can allocate, and `.str()` returns a string copy of the whole accumulated buffer.

For new parsing code, split a `std::string_view` and call `from_chars`. For new formatting code, use `std::format`; neither carries sticky stream state.

**Pitfall.** An `ofstream` destructor closes the file, but closing is not the same as guaranteeing persistence on physical storage. Durability requires an operating-system-level policy.

## C Stdio and the Two-Worlds Problem

C stdio remains common in systems code. `std::printf` and `std::fprintf` format text into `FILE*` streams; `std::fwrite` moves raw bytes. Their formatting state is carried in each call rather than left sticky on a C++ stream.

The formatted functions use C variadic arguments, so the format string does not carry static argument types. Passing a `long` to `%d` has undefined behavior, not merely incorrect output. Compilers can diagnose many mismatches when the format string is a literal.

By default, the standard synchronizes the eight standard C++ streams with their corresponding C streams. That permits coordinated use of `std::cout` and `stdout`, but adds coordination to stream operations.

Two calls remove common sources of overhead:

```cpp
#include <iostream>

void configure_fast_standard_io() {
    std::ios::sync_with_stdio(false);  // unlink C++ and C buffers
    std::cin.tie(nullptr);             // input no longer flushes cout
}
```

A **tied** input stream flushes its output stream before each input operation, ensuring a prompt is visible before a blocking read. Untying removes that implicit flush.

After disabling synchronization, do not mix `std::printf` and `std::cout` on the same destination and expect program-order output. Their independent buffers can flush in a different order.

**Rule.** Pick C stdio or C++ streams for each underlying destination. If code must mix them, leave synchronization enabled and accept its cost.

## `std::format` and `std::print`: The Modern Default

`std::format` **(C++20)** returns a `std::string` from a Python-style replacement-field specification. `std::print` and `std::println` **(C++23)** send formatted output directly to standard output or a `FILE*`. They do not expose the iostream state machine, so each call is self-contained.

```cpp
#if __has_include(<print>)
#include <print>
#endif
#include <string_view>

struct Order {
    std::string_view symbol;
    double price;
    int quantity;
};

void print_order(const Order& order) {
#if defined(__cpp_lib_print)
    std::println("{} {:>8.2f} x{:<5}",
                 order.symbol, order.price, order.quantity);
    // prints: AAPL   201.25 x50    (for {"AAPL", 201.25, 50})
#endif
}
```

A literal format string is checked at compile time against its arguments. `std::format("{:d}", "text")` is ill-formed because integer presentation does not accept a string argument.

The useful format vocabulary is small:

| Element | Syntax | Example |
|---|---|---|
| Fill and alignment | `<`, `>`, `^` after `:` | `{:*>8}` |
| Width | Integer | `{:8}` |
| Precision | `.N` | `{:.2f}` |
| Presentation type | `d`, `x`, `f`, `e`, `g`, `s`, `b` | `{:x}` |
| Literal braces | `{{` and `}}` | `{{price}}` |

A user-defined type participates by specializing `std::formatter`. Treat this as a cookbook shape; specialization syntax belongs to Chapter 20.

```cpp
#if __has_include(<format>)
#include <format>
#endif

#if defined(__cpp_lib_format)
template<>
struct std::formatter<Order> {
    constexpr auto parse(std::format_parse_context& context) {
        return context.begin();
    }

    auto format(const Order& order,
                std::format_context& context) const {
        return std::format_to(
            context.out(), "{} {:.2f}@{}",
            order.symbol, order.price, order.quantity);
    }
};
#endif
```

After this definition, `std::println("{}", order)` uses the custom formatter. The `parse` member accepts no custom specification and returns the first unconsumed character; `format` writes to the caller's output iterator.

Runtime-supplied format strings cannot receive the same literal compile-time checking. Use `std::vformat` with explicit format arguments; `std::runtime_format` **(C++26)** is a convenience. Runtime parsing can throw `std::format_error`.

**Pitfall.** Formatting a dangling `std::string_view` remains undefined behavior. A safer formatting API cannot repair the source lifetime error from Chapter 12.

## Formatting into caller-owned storage

`std::format` returns an owning `std::string`, which is convenient but can allocate. The iterator-oriented formatting functions write into storage chosen by the caller.

| Facility | Destination | Bounds behavior | Allocation controlled by |
|---|---|---|---|
| `std::format` | returned `std::string` | grows as needed | formatting function |
| `std::format_to` | output iterator | destination decides | destination |
| `std::format_to_n` | output iterator and maximum count | writes at most `n`; reports full size | destination |
| `std::formatted_size` | no output | returns required character count | caller after sizing |
| `std::print` | `stdout` or `FILE*` | library-managed transfer | library stream |

`format_to_n` supports a fixed-capacity record with explicit overflow handling:

```cpp
#include <array>
#include <format>
#include <optional>
#include <string_view>

struct LogLine {
    std::array<char, 128> bytes;
    std::size_t size;
};

std::optional<LogLine> make_fill_line(
    std::string_view symbol, int quantity, double price) {
    LogLine line{};
    auto result = std::format_to_n(
        line.bytes.begin(), line.bytes.size(),
        "fill symbol={} quantity={} price={:.2f}\n",
        symbol, quantity, price);

    if (result.size > line.bytes.size()) {
        return std::nullopt;
    }

    line.size = static_cast<std::size_t>(
        result.out - line.bytes.begin());
    return line;
}
```

`result.size` is the number of characters the complete output required, while `result.out` marks the end actually written. No terminator is added; the `size` field carries the record boundary. A full buffer is not silently accepted as a complete log record.

When exact sizing is preferable, `formatted_size(format, args...)` computes the required count before a later `format_to`. That normally performs format processing twice, once to count and once to write. It is useful for a cold path that wants one exact allocation, not for a hot path whose fixed upper bound is already known.

A pre-reserved `std::string` or `std::pmr::string` can also receive `format_to(std::back_inserter(buffer), ...)`. The destination controls growth, but writing past its reserved capacity can still allocate. Reserve is an optimization promise only until the bound is exceeded.

Concurrent stream insertion has another problem: pieces from different threads can interleave. `std::osyncstream` **(C++20)** buffers one logical emission and transfers its characters to the wrapped stream as a group:

```cpp
#include <iostream>

#if __has_include(<syncstream>)
#include <syncstream>
#endif

#if defined(__cpp_lib_syncbuf)
void report_worker(int worker, int completed) {
    std::osyncstream{std::cout}
        << "worker=" << worker
        << " completed=" << completed << '\n';
} // buffered characters emit together here
#endif
```

This prevents character-level interleaving, not contention or formatting cost. Each wrapper has a synchronization buffer that can allocate, and final emission still serializes on the destination. It belongs on diagnostic and control paths, not on a per-tick producer.

**Rule.** For a bounded hot-path record, write into caller-owned fixed storage and make overflow a visible policy. For ordinary application text, prefer the simpler owning or direct-output interface.

## Locales: The Hidden Tax

Classic-stream numeric conversion consults the stream's locale. Facet lookup, virtual calls, grouping, and decimal-point rules remain part of the path even under the default `"C"` locale.

`imbue` installs a locale when localized human output is genuinely required:

```cpp
#include <locale>
#include <sstream>

#if __has_include(<format>)
#include <format>
#endif

void render_number(double value) {
    std::ostringstream localized;
    localized.imbue(std::locale{"de_DE.UTF-8"});
    localized << value;  // may produce 1.234,5-style output

#if defined(__cpp_lib_format)
    auto stable = std::format("{}", value);
    (void)stable;  // locale-independent by default
#endif
}
```

Locale names and installed locale data are platform-dependent, and constructing `std::locale{""}` consults the environment. A missing named locale can throw `std::runtime_error`.

`std::format` is locale-independent by default, which makes machine-consumed output deterministic across hosts. Localized formatting is an explicit opt-in using a locale argument and the `L` presentation modifier.

For logs and protocols, locale independence is correctness. A host that changes `42.5` to `42,5` can break a downstream parser even when both programs are individually following their locale settings.

`std::from_chars` and `std::to_chars` are also locale-free (Chapter 12). That property and their direct buffer interface make them the default conversion layer for machine data.

## Stream Errors and Partial I/O

Iostreams record failure in state bits:

| Bit | Meaning |
|---|---|
| `eofbit` | Input reached end of file |
| `failbit` | An operation failed, such as numeric parsing |
| `badbit` | The stream lost integrity, such as a device error |

Streams do not throw for ordinary state changes by default. Once failure is set, later operations usually do nothing until `.clear()` resets the state.

The checked-read idiom lets extraction and the loop condition share one operation:

```cpp
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

void read_prices() {
    std::istringstream input{"101.5 102.0 bad 103.0"};
    std::vector<double> prices;
    double price = 0.0;

    while (input >> price) {
        prices.push_back(price);
    }

    if (input.eof()) {
        std::cout << "clean end\n";
    } else if (input.fail()) {
        input.clear();
        std::string bad_token;
        input >> bad_token;  // consume "bad" before resuming
        std::cout << bad_token << '\n';
    }
    // prints: bad
}
```

Testing `eof()` before extraction is wrong because end-of-file is discovered by attempting a read. `while (input >> value)` processes each successfully extracted value once and stops on either malformed input or end.

`.exceptions(mask)` can make selected state bits throw `std::ios_base::failure`. It is rarely used; the error-code style aligns naturally with partial input, and Chapter 6's error-strategy tradeoffs still apply.

A successful buffered insertion means the data reached a library buffer. `flush()` asks the library to write toward the OS, but even an accepted OS write may not yet be durable on storage. Durability requires facilities such as `fsync`, covered with filesystem and operating-system behavior elsewhere in the series.

A crash can leave a file with only a prefix of a logical record. File formats and logging designs therefore need framing, recovery, or an explicit willingness to lose the tail.

**Pitfall.** Ignoring an `ofstream`'s state after writes turns a full disk or device failure into silent data loss.

## Asynchronous Logging: Formatting Off the Hot Path

A trading hot thread should perform no text formatting, dynamic allocation, or output system call for each log event. It records a fixed-size event into preallocated storage and lets a colder consumer pay the expensive work.

The event contains raw values and a log-site identifier:

```cpp
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <span>
#include <string>
#include <vector>

#if __has_include(<format>)
#include <format>
#endif

struct LogEvent {
    std::chrono::steady_clock::time_point timestamp;
    std::uint32_t site;
    double price;
    std::uint32_t quantity;
};

class EventBuffer {
public:
    explicit EventBuffer(std::size_t capacity)
        : slots_(capacity) {}

    bool log_event(std::uint32_t site,
                   double price,
                   std::uint32_t quantity) noexcept {
        if (size_ == slots_.size()) {
            return false;
        }
        slots_[size_++] = {
            std::chrono::steady_clock::now(),
            site,
            price,
            quantity
        };
        return true;  // no format, allocation, or output syscall
    }

    std::span<const LogEvent> events() const noexcept {
        return {slots_.data(), size_};
    }

private:
    std::vector<LogEvent> slots_;
    std::size_t size_ = 0;
};
```

The constructor allocates storage before the hot path. `log_event` writes into an existing slot instead of calling `push_back`, so capacity never grows (Chapter 10). A full buffer returns `false`; the caller needs an explicit loss or backpressure policy.

The cold path maps `site` to a format schema, converts values, and writes:

```cpp
#if defined(__cpp_lib_format)
void drain(const EventBuffer& buffer, std::FILE* output) {
    for (const LogEvent& event : buffer.events()) {
        std::string line;
        if (event.site == 1) {
            line = std::format(
                "order price={:.2f} quantity={}\n",
                event.price, event.quantity);
        } else {
            line = std::format(
                "event={} price={:.2f} quantity={}\n",
                event.site, event.price, event.quantity);
        }
        std::fwrite(line.data(), 1, line.size(), output);
    }
}
#endif
```

Formatting and allocation still exist, but they run away from the critical producer. A production design places a bounded single-producer/single-consumer queue between producer and consumer. Thread lifecycle belongs to Chapter 23; the queue and its backpressure policy belong to Chapter 26.

NanoLog-style designs store binary arguments and defer formatting. `spdlog` async mode is a buffered-text middle ground: enqueue a prepared message and defer the physical write.

| Approach | Hot-path cost | Crash durability | Tooling |
|---|---|---|---|
| Direct flushed text | Format plus write/flush | Best tail visibility; not necessarily disk-durable | None |
| Buffered text | Format plus enqueue | Buffered tail may be lost | Little |
| Binary deferred format | Timestamp plus fixed-size copy | Queued tail may be lost | Schema and decoder |

The fixed event itself can later be copied into binary storage if it meets the representation rules in Chapter 16. The decoder needs a versioned mapping from site IDs to format strings.

**Pitfall.** Storing an arbitrary string in each hot-path event reintroduces allocation and variable-size copying. Store IDs and fixed-size values, then resolve text in the consumer.

**Pitfall.** An unbounded log queue turns sustained overload into memory growth. A bounded queue forces the system to choose blocking, dropping, sampling, or shutdown explicitly (Chapter 26).

## Latency Lens

- Each iostream insertion can pay for a sentry, shared-state checks, locale facets, and stream-buffer virtual dispatch before bytes move.
- `std::endl` flushes, so using it per record can turn one buffered batch into a write system call per line; `'\n'` preserves batching.
- Default `cout` and `stdout` synchronization coordinates two buffering systems; `sync_with_stdio(false)` removes that bridge when code uses only one.
- Classic-stream numeric output consults locale machinery even in the `"C"` locale, while `std::format` is locale-independent by default.
- Compile-time format checking moves literal format/type mismatches from runtime into compilation.
- `std::print` avoids iostream's shared formatting state and virtual stream-buffer formatting path when text output is required.
- `format_to_n` bounds writes into caller-owned storage and reports the complete required size, turning record overflow into an explicit branch instead of hidden growth.
- `osyncstream` prevents interleaved multi-threaded records by buffering each emission, but its buffer and serialized transfer keep it off the tick path.
- `std::fwrite` of an eligible fixed-size record to a buffered `FILE*` reduces transfer to a byte copy into a C buffer; eligibility and portability depend on Chapter 16's representation rules.
- A successful buffered write has not necessarily reached the OS or durable storage; flush frequency trades batching latency against tail visibility.
- Deferred-format logging reduces producer work to a clock read and fixed-size stores; formatting and writes move to a non-critical consumer.
