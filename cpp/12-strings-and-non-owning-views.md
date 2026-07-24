# 12. Strings and Non-Owning Views

Text and binary buffers cross ownership boundaries constantly in market-data and order-entry code. `std::string` owns characters, while `std::string_view` and `std::span` merely describe someone else's storage. Choosing among them controls allocation cost and, more importantly, whether the program has a valid object to read.

## C strings: the legacy floor

A C string is a `char` array whose first `'\0'` byte marks the end. The terminator is its length encoding, so `std::strlen` must scan from the first character to that zero every time: `O(n)` work per query.

```cpp
#include <cstring>
#include <iostream>

int main() {
    const char message[] = "FIX";

    static_assert(sizeof(message) == 4); // includes '\0'
    std::cout << std::strlen(message) << '\n'; // prints: 3
}
```

`sizeof(message)` sees the array type and its full storage. After array-to-pointer decay (Chapter 2), a function receiving `const char*` sees only an address; the size is gone.

String literals are C strings: `"IBM"` has type `const char[4]`, including its terminator. C and operating-system interfaces such as `std::fopen` and `std::getenv` still use null-terminated strings, so C++ code must sometimes meet that contract.

**Pitfall.** Passing `char raw[3]{'F', 'I', 'X'};` to `std::strlen` or another C-string API causes undefined behavior: the function reads past the array while searching for a zero. The same lost-size interface made unchecked functions such as `std::strcpy` a recurring source of buffer overflow.

## std::string: vector<char> with benefits

`std::string` is an owning, contiguous, resizable character sequence. Apply the `std::vector` model from Chapter 10: it has a size and capacity, grows geometrically, offers unchecked `operator[]` and checked `at`, and invalidates pointers and iterators when it reallocates.

Unlike `std::vector<char>`, a string keeps a null terminator at `data()[size()]` (since C++11). It also supplies text operations such as `find`, `compare`, `substr`, and `starts_with` (C++20).

| Property | `std::string` | `std::vector<char>` |
|---|---|---|
| Contiguous storage and growth | Yes | Yes |
| Terminator at `data()[size()]` | Guaranteed | Not supplied |
| `find`, `substr`, text comparison | Yes | No text-specific API |
| Small inline buffer | Typical, implementation detail | No |

Concatenating several strings with `operator+` creates a temporary result at each step. Each result can need a capacity acquisition:

```cpp
void build_messages() {
    std::string begin = "35=D|";
    std::string symbol = "55=IBM|";
    std::string price = "44=100.25";
    std::string checksum = "|10=128";

    std::string eager = begin + symbol + price + checksum;
    // three temporary string results; each can allocate

    std::string reserved;
    reserved.reserve(64);
    reserved.append(begin);
    reserved.append(symbol);
    reserved.append(price);
    reserved.append(checksum);
    // one planned reservation; no growth during these appends

    std::cout << eager << '\n' << reserved << '\n';
}
```

`reserve` changes capacity, not size. It turns repeated geometric growth into one deliberate capacity decision when an upper bound is known.

A pointer returned by `data()` or `c_str()` follows the same invalidation rules as a pointer into a vector. If `message += suffix` reallocates, every saved pointer into the old character buffer dangles.

`std::string::substr` returns a new owning string, so it copies characters and can allocate. Section 4 uses a view when only a non-owning window is needed.

**Pitfall.** `s[index]` is unchecked. Reading `s[s.size()]` returns the terminator, but assigning anything other than `'\0'` through that position causes undefined behavior.

## Small-string optimization

Most implementations store short strings directly inside the `std::string` object. This **small-string optimization**, or SSO, avoids a heap allocation until the content outgrows the inline buffer.

```text
conceptual string object

short mode: [ size + mode ][ inline characters........ ]
long mode:  [ heap pointer ][ size ][ capacity + mode ]
                           mode bit selects interpretation
```

The exact layout and threshold belong to the library ABI. The mode test adds a usually predictable branch to operations such as `data`, `size`, and `append`; that branch is the price of skipping the allocator for short values.

```cpp
void inspect_sso() {
    std::string short_symbol = "IBM"; // typically inline; no allocation
    std::string long_symbol(40, 'X'); // typically heap-backed

    std::cout << short_symbol.capacity() << ' '
              << long_symbol.capacity() << '\n';
    // prints implementation-specific capacities
}
```

**Note.** Common implementations often hold about 15 bytes inline in libstdc++ or 22 in libc++, but neither number is portable. MSVC uses another representation; inspect the exact toolchain used for deployment.

Moving a heap-backed string can transfer its allocation in constant time. Moving an SSO string must copy its inline characters into the destination's inline storage. A pointer into the source's inline buffer still points inside the old object, not the destination, and the moved-from value is valid but unspecified (Chapter 7).

This is the same small-buffer pattern and move caveat introduced for containers in Chapter 10. A string move is cheap, but it does not promise that pointers into the source remain usable.

## std::string_view: the read-only parameter type

`std::string_view` (C++17) is a non-owning view, conceptually a pointer plus a character count and normally represented by two machine words. It does not allocate, does not require a terminator, and is cheap to copy. Pass it by value, not by `const std::string_view&`.

One parameter accepts literals, owning strings, and slices:

```cpp
double parse_px(std::string_view field);

void call_parser() {
    std::string stored = "100.25";
    const char wire[] = {'9', '9', '.', '5', '0', '|'};

    std::cout << parse_px("101.75") << '\n';
    std::cout << parse_px(stored) << '\n';
    std::cout << parse_px(std::string_view{wire, 5}) << '\n';
    // no allocation is required to form any argument view
}
```

A function taking `const std::string&` can also accept a literal, but only by constructing a temporary `std::string`; sufficiently long input can allocate. A view represents the literal directly.

`string_view::substr` performs pointer arithmetic and returns another view in constant time. `remove_prefix` and `remove_suffix` adjust the current window without moving characters:

```cpp
void print_fields(std::string_view message) {
    while (!message.empty()) {
        const std::size_t separator = message.find('|');
        const std::string_view field = message.substr(0, separator);
        std::cout << field << '\n';

        if (separator == std::string_view::npos) {
            break;
        }
        message.remove_prefix(separator + 1);
    }
}

void split_message() {
    print_fields("35=D|55=IBM|44=100.25");
    // prints three fields with zero allocations while splitting
}
```

Views also feed transparent string comparators for allocation-free map lookup (Chapter 11).

**Rule.** Take `std::string_view` for read-only text, store `std::string` when the object must retain text, and normally return `std::string`. Return a view only into storage whose lifetime contract is explicit.

## string_view is not null-terminated

A view's last character need not be followed by `'\0'`. A substring can end in the middle of an owning string, and a pointer-plus-length view can cover an unterminated array.

```cpp
extern "C" void some_c_api(const char*);

void send_symbol() {
    const char message[]{'5', '5', '=', 'I', 'B', 'M'};
    std::string_view symbol{message + 3, 3};

    some_c_api(symbol.data()); // UB: no terminator in the array
}
```

Even when a zero exists later, the C function reads characters outside the logical view and receives the wrong text. If an unavoidable API requires termination, construct `std::string terminated{symbol}` and pass `terminated.c_str()`. That bridge owns and terminates the characters, but it can allocate.

## Lifetime hazards

A `std::string_view` does not extend its source's lifetime. It dangles when the owner dies and when a mutation invalidates the pointer it stores.

```cpp
void temporary_dangle() {
    std::string name = "IBM";
    std::string_view view = name + "_US";
    // temporary result dies at the preceding semicolon

    std::cout << view << '\n'; // UB: view dangles
}
```

The owner can remain alive while its old buffer dies:

```cpp
void reallocation_dangle() {
    std::string owner = "IBM";
    std::string_view view = owner;

    owner += std::string(owner.capacity() + 1, 'X');
    // the append must outgrow the old capacity

    std::cout << view << '\n'; // UB: view points into old storage
}
```

Apply these review rules:

- Bind a view only to an owner that provably outlives every use.
- Never store a view member without documenting who owns the characters and how long they remain stable.
- A class constructed from a by-value `std::string` parameter should store its own `std::string`, not a view into that parameter.
- After any owner mutation, conservatively consider all views into it invalid.
- After a `std::vector<std::string>` reallocation, do not rely on views into its moved elements surviving.

**Rule.** View validity is pointer validity. An owner's continued existence is insufficient if it reallocates or moves the characters.

## std::span: string_view for every T

`std::span<T>` (C++20) is a non-owning pointer-and-length view over contiguous `T` objects. It constructs from arrays, `std::array`, `std::vector`, or a pointer and count. A `span<T>` allows element mutation; `span<const T>` does not.

Like `string_view`, a span is passed by value, never owns its source, and dangles when that source dies or reallocates. `first`, `last`, and `subspan` create allocation-free slices.

| View | Element | Writable? | Typical use |
|---|---|---|---|
| `std::string_view` | `char` | No | Text parameters and parsing |
| `std::span<T>` | Any `T` | Yes | Mutable buffer parameters |
| `std::span<const T>` | Any `T` | No | Read-only buffers |
| `std::span<T, N>` | Any `T`, fixed `N` | Depends on `T` | Fixed-size wire fields |

A fixed extent such as `std::span<const std::byte, 8>` carries its size in the type, so implementations need store only the pointer. Construction from a mismatched array fails at compile time. A pointer-and-count constructor requires the count to equal the extent; violating that precondition is undefined behavior in C++23.

```cpp
#include <cstddef>
#include <iostream>
#include <span>

int main() {
    const std::byte buffer[12]{
        std::byte{8}, std::byte{1}, std::byte{0}, std::byte{0},
        std::byte{'B'}, std::byte{3}, std::byte{9}, std::byte{7},
        std::byte{2}, std::byte{4}, std::byte{6}, std::byte{8}};

    std::span<const std::byte> message{buffer};
    auto header = message.first<4>();
    auto payload = message.subspan(4);

    const int payload_size = std::to_integer<int>(header[0]);
    const char side = std::to_integer<char>(payload[0]);
    const int venue = std::to_integer<int>(payload[1]);

    std::cout << payload_size << ' ' << side << ' '
              << venue << '\n'; // prints: 8 B 3
}
```

This example reads bytes directly. Reinterpreting an arbitrary byte buffer as a struct requires the lifetime, layout, and aliasing rules in Chapter 16.

## std::mdspan in brief

`std::mdspan` (C++23) maps multidimensional indices onto an existing flat buffer without owning or moving its elements. Its extents provide the shape. `std::layout_right` makes the rightmost index contiguous, matching row-major C-style storage; `std::layout_left` makes the leftmost index contiguous, matching column-major Fortran and common BLAS layouts.

```cpp
#include <iostream>
#include <mdspan>
#include <vector>

int main() {
    std::vector<double> prices{100.0, 100.5, 101.0,
                               101.5, 102.0, 102.5};
    std::mdspan grid{prices.data(), 2, 3};

    std::cout << grid[1, 2] << '\n'; // prints: 102.5
}
```

The same six values can be viewed under another layout policy; only the index-to-offset mapping changes. Put the contiguous index in the inner loop when traversal order matters.

## from_chars and to_chars: number conversion for hot paths

`std::from_chars` and `std::to_chars` (C++17) are locale-free, non-allocating, and non-throwing. They report errors explicitly, making them the standard conversion pair suited to hot parsing paths.

`from_chars(first, last, value)` returns a pointer to the first unconsumed character and an `std::errc`. It needs a range, not a null terminator, so `string_view::data()` plus `size()` is exactly the right input.

```cpp
#include <charconv>
#include <expected>
#include <iostream>
#include <string_view>

enum class ParseError {
    invalid,
    out_of_range,
    trailing_characters
};

std::expected<double, ParseError> parse_price(
    std::string_view field) {
    if (field.empty()) {
        return std::unexpected(ParseError::invalid);
    }

    double price;
    const char* end = field.data() + field.size();
    auto [next, error] =
        std::from_chars(field.data(), end, price);

    if (error == std::errc::invalid_argument) {
        return std::unexpected(ParseError::invalid);
    }
    if (error == std::errc::result_out_of_range) {
        return std::unexpected(ParseError::out_of_range);
    }
    if (next != end) {
        return std::unexpected(ParseError::trailing_characters);
    }
    return price;
}

int main() {
    std::string_view field = "44=100.25";
    auto result = parse_price(field.substr(field.find('=') + 1));

    if (result) {
        std::cout << *result << '\n'; // prints: 100.25
    }
}
```

Checking only `error` accepts a valid numeric prefix such as `"100.25oops"`. Checking `next == end` enforces full-field consumption.

Unlike several C conversion routines, `from_chars` does not skip leading whitespace. A space at the beginning produces `std::errc::invalid_argument`, which is useful when a wire grammar forbids it.

`to_chars` mirrors the contract into caller-owned storage:

```cpp
void encode_price() {
    char buffer[32];
    auto [end, error] = std::to_chars(
        buffer, buffer + sizeof(buffer), 100.25);

    if (error == std::errc{}) {
        const auto size = static_cast<std::size_t>(end - buffer);
        std::string_view encoded{buffer, size};
        std::cout << encoded << '\n'; // prints: 100.25
    }
}
```

| Method | Allocates? | Locale-dependent? | Error reporting | Relative overhead |
|---|---|---|---|---|
| `std::atoi` / `std::atof` | No | Yes | None; garbage can become zero | Low but unsafe |
| `std::strtod` | No | Yes | `errno` and end pointer | Moderate |
| `std::stoi` / `std::stod` | Often for a view | Yes | Throws | Moderate |
| `std::stringstream` | Typically | Yes | Stream state | Usually highest |
| `from_chars` | No | No | `errc` and pointer | Usually lowest |

**Note.** Floating-point `from_chars` and `to_chars` support arrived later than the integer overloads in several standard libraries. Verify the deployment library even when the compiler accepts C++17.

## Latency Lens

- `strlen` and every C-string length query scan to a terminator; `std::string` and `std::string_view` return a stored length.
- SSO keeps short strings away from the heap at the cost of an inline-versus-heap branch in common string operations.
- Moving a heap string can steal a pointer, while moving an SSO string copies inline bytes and cannot preserve pointers into the source buffer.
- An `operator+` chain creates a result per addition; `reserve` plus `append` removes repeated capacity growth.
- Passing `string_view` by value transfers a pointer and length; forming it performs no allocation or character copy.
- `string::substr` owns and copies its result, while `string_view::substr` adjusts a pointer and length.
- Constructing `std::string{view}` for a null-terminated C API can allocate; keep that bridge outside the hot path when possible.
- `from_chars` touches no locale, heap, or exception machinery; it scans the supplied range and writes the parsed value.
- A fixed-extent span needs no runtime length field and exposes the bound to compile-time checking and optimization.
