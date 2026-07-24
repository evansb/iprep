# 2. Types and Conversions

C++ makes type decisions before the program runs, but it also inserts conversions that are easy to miss in source code. Those decisions control object layout, arithmetic, overload selection, and whether a value survives a trip through an expression. Low-latency code depends on choosing representations deliberately: exact-width integers for protocols, scoped enums for domains, and floating point only where its semantics fit.

## The type system

C++ is statically and nominally typed. Every expression has a type known at compile time, and separately declared class or enumeration types remain distinct even when their representations match. A type determines which operations are valid and, for an object type, how much storage and alignment an object requires.

The top-level categories used in this book are:

- Fundamental types
  - arithmetic types: `bool`, character types, integer types, and floating-point types
  - `void`
  - `std::nullptr_t`, the type of `nullptr`
- Compound types
  - pointers and references
  - arrays and functions
  - enumerations
  - classes

An **object type** describes a region of storage that can hold a value. Integers, pointers, arrays, enumerations, and class types are object types; references, functions, and `void` are not.

```cpp
#include <cstddef>
#include <cstdint>
#include <iostream>

std::int64_t quote_to_ticks(double quote) {
    return static_cast<std::int64_t>(quote);
}

int main() {
    std::cout << sizeof(int) << '\n';           // commonly prints: 4
    std::cout << sizeof(double) << '\n';        // commonly prints: 8
    std::cout << sizeof(std::int64_t) << '\n';  // prints: 8
    std::cout << sizeof(void*) << '\n';         // commonly prints: 8

    // sizeof(void);             // error: void has no size
    // sizeof(quote_to_ticks);   // error: function type has no size
}
```

A function type describes a callable signature, not an object. An array therefore cannot contain functions, although it can contain pointers to functions.

`void` means “no value.” A function returning `void` returns no result. A `void*` can hold the address of an object without preserving its object type; allocation APIs use it at low-level boundaries (Chapter 17).

## Fundamental types, fixed-width integers, and literals

The built-in integer types provide minimum ranges, not universally fixed sizes. The data model chosen by the implementation determines their widths.

| Type | LP64 Linux/macOS | LLP64 Windows |
|---|---:|---:|
| `short` | 2 bytes | 2 bytes |
| `int` | 4 bytes | 4 bytes |
| `long` | 8 bytes | 4 bytes |
| `long long` | 8 bytes | 8 bytes |
| pointer | 8 bytes | 8 bytes |

These are common platform choices, not promises made by the type names. In particular, serializing a `long` writes different amounts of data on typical 64-bit Linux and Windows systems.

The exact-width aliases in `<cstdint>` state the representation requirement directly:

```cpp
#include <cstdint>

std::int64_t order_id = 8'204'991;
std::int64_t quantity = 25'000;
std::int32_t price_ticks = 1'987'650;
std::uint16_t message_length = 48;
std::uint8_t message_type = 0x2A;

static_assert(sizeof(std::int64_t) == 8);
static_assert(sizeof(std::uint16_t) == 2);
```

Use `std::int64_t` for application quantities and identifiers unless a narrower range is part of the contract. Use `std::uint8_t`, `std::uint16_t`, or `std::uint32_t` when a wire format defines an unsigned field of that width. A small local loop counter can still be an `int`.

`std::size_t` is an unsigned integer type large enough to represent the size of any object. `sizeof` and container `.size()` return it. `std::ptrdiff_t` is the corresponding signed type used for pointer differences; both are declared in `<cstddef>`.

The spelling of a literal determines its initial type before any surrounding conversion takes place.

| Literal | Type | Meaning |
|---|---|---|
| `42` | `int` | decimal integer |
| `42u` | `unsigned int` | unsigned integer |
| `42l` | `long` | long integer |
| `42ll` | `long long` | long long integer |
| `4.2` | `double` | floating-point |
| `4.2f` | `float` | single-precision floating-point |
| `'a'` | `char` | character |
| `"a"` | `const char[2]` | character array including `'\0'` |
| `42z` | signed counterpart of `std::size_t` | size-related signed integer, **(C++23)** |
| `42uz` | `std::size_t` | size-related unsigned integer, **(C++23)** |

Hexadecimal literals start with `0x`, binary literals start with `0b`, and apostrophes separate digits without changing the value:

```cpp
int permissions = 0b1101;
std::uint32_t mask = 0xFF00'0000u;
std::int64_t notional = 1'000'000'000ll;
double rate = 0.025;  // double, not float
```

**Rule.** Let the protocol choose the width of wire fields. Let the required range choose the width of application integers; do not let a platform-dependent spelling such as `long` choose by accident.

## Const and volatile

`const` prevents modification through the qualified name, pointer, or reference. Read pointer declarations from the identifier outward:

```cpp
void const_pointer_demo() {
    int bid = 100;
    int ask = 101;

    const int* observed = &bid;       // pointer to const int
    int* const fixed = &bid;          // const pointer to int
    const int* const stable = &bid;   // const pointer to const int

    observed = &ask;   // OK: the pointer is not const
    // *observed = 99; // error: pointed-to int is const through observed

    *fixed = 99;       // OK: the pointed-to int is not const
    // fixed = &ask;   // error: fixed itself is const

    // *stable = 99;   // error: pointed-to int is const
    // stable = &ask;  // error: stable itself is const

    std::cout << *observed << ' ' << *fixed << ' ' << *stable << '\n';
    // prints: 101 99 99
}
```

`const` is a compile-time access contract, not a separate kind of storage. Removing it from a pointer does not make an originally `const` object writable.

```cpp
void invalid_const_write() {
    const int hard_limit = 1'000;
    const int* view = &hard_limit;
    int* writable = const_cast<int*>(view);
    *writable = 2'000;  // undefined behavior: hard_limit was created const
}
```

Undefined behavior means the C++ language places no requirements on the program; Chapter 3 makes that definition precise.

`volatile` tells the implementation that each access through the volatile-qualified path is an observable side effect. Its specialist use is access to memory-mapped device registers under a platform contract.

```cpp
volatile std::uint32_t* device_status =
    reinterpret_cast<volatile std::uint32_t*>(0x4000'1000);
std::uint32_t snapshot = *device_status;  // an actual load is required
```

This address is illustrative; valid device addresses and access rules come from the target platform.

**Rule.** `volatile` is not synchronization. It provides neither atomicity nor inter-thread ordering; the memory model supplies those tools (Chapter 25).

## References

A reference is an alias for an existing object. It must be bound when created, cannot be reseated, and is used with the same syntax as the object itself.

```cpp
void reference_demo() {
    int bid = 100;
    int ask = 105;
    int& price = bid;

    price = 101;  // assigns to bid
    price = ask;  // assigns ask's value to bid; does not rebind price

    std::cout << bid << ' ' << ask << ' ' << price << '\n';
    // prints: 105 105 105
}
```

A `const T&` provides read-only access and can bind to both mutable and `const` objects. It can also bind to a temporary in contexts that extend the temporary's lifetime; Chapter 5 gives the exact rules.

Passing a large object by `const` reference avoids copying it:

```cpp
bool is_supported_symbol(const std::string& symbol) {
    return symbol == "EURUSD" || symbol == "USDJPY";
}
```

This is the default read-only parameter style for class objects until Chapter 3 refines parameter passing.

A reference is never a null reference. Trying to manufacture one by dereferencing a null pointer already violates the language rules. References also do not own the object they name, so the object must outlive every use of the reference.

```cpp
const std::string& bad_symbol() {
    std::string symbol = "EURUSD";
    return symbol;  // warning: returns a reference to a local object
}

void publish_bad_symbol() {
    const std::string& symbol = bad_symbol();
    std::cout << symbol << '\n';  // undefined behavior: symbol dangles
}
```

**Pitfall.** A returned reference does not carry the referred object's lifetime with it. Never return a reference to a local object.

## Pointers, arrays, and decay

A pointer stores an address together with a pointed-to type. `&object` takes an address, `*pointer` accesses the pointed-to object, and `nullptr` is the null pointer value to write in modern C++.

```cpp
void pointer_demo() {
    int quantity = 250;
    int* quantity_ptr = &quantity;

    *quantity_ptr += 50;
    std::cout << quantity << '\n';  // prints: 300

    quantity_ptr = nullptr;
    if (quantity_ptr != nullptr) {
        std::cout << *quantity_ptr << '\n';
    }
}
```

A non-null pointer can still be invalid: its object may already have died, its address may be misaligned for the pointed-to type, or it may point at an object of another type. Dereferencing is valid only while an appropriate object exists at that address.

A built-in array has a fixed element count that is part of its type. `int[4]` and `int[8]` are different types. A built-in array has no `.size()` member and cannot be assigned as a whole.

```cpp
void array_demo() {
    int levels[4] = {100, 101, 102, 103};
    static_assert(sizeof(levels) == 4 * sizeof(int));

    levels[2] = 104;
    // levels[4] = 105;  // undefined behavior: index is out of bounds

    int replacement[4] = {};
    // levels = replacement;  // error: arrays are not assignable
    std::cout << levels[2] << ' ' << replacement[0] << '\n';
    // prints: 104 0
}
```

Built-in indexing performs no bounds check and throws no exception. AddressSanitizer from Chapter 1 catches many out-of-bounds accesses in test builds, but it does not turn them into valid operations.

In most expressions, an array name **decays** to a pointer to its first element. The array's bound disappears during that conversion.

```cpp
void inspect_levels(int values[10]) {
    std::cout << sizeof(values) << '\n';  // prints: sizeof(int*)
}

void decay_demo() {
    int values[5] = {};
    int* first = values;

    std::cout << sizeof(values) << '\n';  // commonly prints: 20
    std::cout << sizeof(first) << '\n';   // commonly prints: 8
    inspect_levels(values);               // commonly prints: 8
}
```

The parameter `int values[10]` is adjusted to `int* values`. The `10` documents an intention but enforces nothing: the function accepts an array of five elements, a pointer to one element, or `nullptr`.

Function names undergo a similar conversion to function pointers in most expressions:

```cpp
int compare_prices(int lhs, int rhs) {
    return (lhs > rhs) - (lhs < rhs);
}

void pointer_to_function_demo() {
    int (*compare)(int, int) = compare_prices;
    std::cout << compare(101, 99) << '\n';  // prints: 1
}
```

Chapter 3 develops function-pointer syntax. Prefer `std::array` and `std::vector` to raw arrays for owned sequences (Chapter 10), and `std::span` when passing a contiguous sequence with its length (Chapter 12). Raw arrays remain common at ABI boundaries and inside wire-layout types.

**Pitfall.** An array-looking function parameter is still a pointer. Never infer a runtime bound from `void process(int values[10])`.

## Enumerations

An unscoped `enum` places its enumerator names in the surrounding scope and implicitly converts its values to integers. Both behaviors weaken type checking.

```cpp
enum LegacySide {
    LegacyBuy,
    LegacySell
};

int legacy_code = LegacyBuy + 1;  // allowed: LegacyBuy converts to int
```

A scoped enumeration, spelled `enum class`, keeps names inside the enumeration and does not implicitly convert to an integer. An explicit underlying type fixes its representation.

```cpp
#include <cstdint>
#include <utility>

enum class Side : std::uint8_t {
    Buy = 1,
    Sell = 2
};

Side side = Side::Buy;
// int next = Side::Buy + 1;  // error: no operator+ for Side and int

std::uint8_t wire_value = std::to_underlying(side);  // C++23
Side decoded = static_cast<Side>(wire_value);
```

`std::to_underlying` **(C++23)** expresses the outbound conversion without repeating the underlying type. An inbound `static_cast` to a fixed-underlying-type enumeration produces a value of that enumeration even if no enumerator has the incoming value. Validate that `wire_value` is `1` or `2` before treating it as a meaningful `Side`.

For an enumeration without a fixed underlying type, converting an out-of-range integer to that enumeration is undefined behavior. A fixed underlying type avoids that representation problem, not the need for domain validation.

**Rule.** Use a scoped enumeration with an explicit underlying type for wire-facing states. It fixes layout and prevents unrelated integer arithmetic.

## Character types and encodings

`char` stores character data and individual text bytes. Plain `char` is distinct from both `signed char` and `unsigned char`, and whether it behaves as signed or unsigned in integer conversions is implementation-defined.

```cpp
void char_signedness_demo() {
    char byte = static_cast<char>(0xFF);
    int promoted = byte;
    std::cout << promoted << '\n';  // commonly prints: -1 or 255
}
```

**Note.** Plain `char` is commonly signed on x86 targets and unsigned on many Arm targets, but the implementation decides. Use `std::int8_t` or `std::uint8_t` when numeric sign matters.

The language also provides `wchar_t`, `char8_t`, `char16_t`, and `char32_t`. They represent code units for their associated character encodings; they do not by themselves implement Unicode parsing, normalization, or display.

This book uses UTF-8 stored in `std::string` for text. Raw wire storage uses `char` buffers or `std::byte`, depending on the API.

```cpp
#include <cstddef>

std::byte flags{0b0000'0101};
std::byte urgent = flags & std::byte{0b0000'0001};
// flags + std::byte{1};  // error: std::byte has no arithmetic addition
```

`std::byte` represents raw memory without the accidental arithmetic and signedness of character integer types. Chapter 16 uses it for object representation and wire parsing.

## Implicit conversions

An implicit conversion is a conversion the compiler inserts without cast syntax. Numeric conversions, pointer conversions, promotions, and conversions to `bool` all occur this way.

Some conversions discard information:

```cpp
void numeric_conversion_demo() {
    double raw_ticks = 103.875;
    std::int32_t ticks = raw_ticks;
    std::cout << ticks << '\n';  // prints: 103

    std::int64_t wide = 5'000'000'000;
    std::int32_t narrow = wide;
    std::cout << narrow << '\n';  // prints: 705032704

    // std::int32_t checked{wide};
    // error: narrowing conversion from std::int64_t to std::int32_t
}
```

Floating-to-integer conversion discards the fractional part, truncating toward zero. If the truncated value cannot be represented by the destination integer type, the behavior is undefined. Integer-to-narrower-signed conversion produces the value congruent modulo `2^N` in C++20 and later, where `N` is the destination width.

Brace initialization rejects narrowing conversions that other initialization syntax accepts. Use braces when a narrowing conversion would be a bug.

**Pitfall.** Converting a `double` price to integer ticks truncates; it does not round. A value just below the next tick can become an off-by-one-tick order price.

Arithmetic values, unscoped enumeration values, and pointers convert to `bool` in a Boolean context. Zero and null become `false`; other values become `true`. A scoped enumeration does not implicitly convert to `bool`.

```cpp
void process(const int* quantity, int count) {
    if (quantity) {            // idiomatic pointer test
        std::cout << *quantity << '\n';
    }

    if (count != 0) {          // makes the numeric test explicit
        std::cout << count << '\n';
    }
}
```

The integer literal `0` is also a legacy null pointer constant. `nullptr` has its own type, `std::nullptr_t`, so overload resolution can distinguish a null pointer from an integer.

```cpp
void route(int) {
    std::cout << "integer\n";
}

void route(int*) {
    std::cout << "pointer\n";
}

void null_overload_demo() {
    route(0);        // prints: integer
    route(nullptr);  // prints: pointer
}
```

Write `nullptr`, never `0` or `NULL`, for a null pointer. Conversion from a derived-class pointer to a base-class pointer is another standard implicit conversion; inheritance makes it useful in Chapter 4.

## Promotions and the usual arithmetic conversions

Integer arithmetic does not normally happen in types narrower than `int`. Before the operation, `bool`, character types, and small integer types undergo **integer promotion**.

```cpp
void small_integer_demo() {
    std::uint8_t bid = 200;
    std::uint8_t ask = 100;

    auto sum = bid + ask;              // sum has type int
    std::uint8_t stored = bid + ask;   // 300 converted back modulo 256

    std::cout << sum << ' ' << static_cast<int>(stored) << '\n';
    // prints: 300 44
}
```

Narrow integer types save storage and cache footprint. They do not force the processor to perform narrow arithmetic.

For common platforms with 32-bit `int`, promotions behave as follows:

| Source type | Promoted type |
|---|---|
| `bool` | `int` |
| `char`, `signed char`, `short` | `int` |
| `unsigned char`, `unsigned short` | `int` when all values fit |
| `std::uint8_t`, `std::uint16_t` | usually `int` |
| `int`, `unsigned int` | unchanged |
| `std::int32_t`, `std::uint32_t` | usually unchanged |
| `long`, `long long` | unchanged |

After promotions, binary arithmetic operators convert both operands to a common type using the **usual arithmetic conversions**. The common cases follow this sequence:

1. If either operand is floating point, convert both to the floating type with the greater rank: `long double`, then `double`, then `float`.
2. Otherwise, apply integer promotions to both operands.
3. If the promoted integer types have the same signedness, convert the lower-rank type to the higher-rank type.
4. If the unsigned type has rank at least as high as the signed type, convert the signed operand to the unsigned type.
5. Otherwise, if the signed type can represent every value of the unsigned type, convert the unsigned operand to the signed type.
6. Otherwise, convert both operands to the unsigned counterpart of the signed type.

| Operands on a typical LP64 system | Rule reached | Common type |
|---|---:|---|
| `float` and `int` | 1 | `float` |
| `double` and `std::int64_t` | 1 | `double` |
| `short` and `short` | 2 | `int` |
| `int` and `long` | 3 | `long` |
| `int` and `unsigned int` | 4 | `unsigned int` |
| `long` and `unsigned int` | 5 | `long` |
| `long long` and `unsigned long` | 6 on LP64 | `unsigned long long` |

The exact result depends on the implementation's widths. The signed/unsigned rule produces a famous surprise:

```cpp
void mixed_sign_demo() {
    std::cout << std::boolalpha << (-1 > 0u) << '\n';
    // prints: true
}
```

Both operands have the rank of `int`, and the unsigned operand wins. Converting `-1` to `unsigned int` produces `UINT_MAX`, which is greater than zero.

**Interview.** Given a mixed arithmetic expression, first promote operands narrower than `int`, then determine the common type. A strong answer traces `-1 > 0u` to the signed-to-unsigned conversion instead of saying merely that “unsigned is strange.”

## Signed, unsigned, and overflow

Unsigned arithmetic is defined modulo `2^N`, where `N` is the number of value bits. Subtracting one from zero therefore produces the maximum value of the unsigned type.

That rule breaks a common reverse loop in two places:

```cpp
void print_reverse_bad(const std::vector<int>& values) {
    // Do not run this loop.
    for (unsigned i = values.size() - 1; i >= 0; --i) {
        std::cout << values[i] << '\n';
    }
}
```

If `values` is empty, `values.size() - 1` wraps to `SIZE_MAX` before conversion to `unsigned`. For any input, `i >= 0` is always true, so decrementing zero wraps to the maximum unsigned value and the loop continues. `-Wextra` diagnoses the always-true comparison on major compilers, and signed/unsigned variants commonly trigger `-Wsign-compare`.

Choose a loop whose termination does not depend on unsigned becoming negative:

```cpp
void print_reverse(const std::vector<int>& values) {
    for (auto i = std::ssize(values) - 1; i >= 0; --i) {  // C++20
        std::cout << values[static_cast<std::size_t>(i)] << '\n';
    }

    for (auto i = values.size(); i-- > 0;) {
        std::cout << values[i] << '\n';
    }
}
```

`std::ssize` **(C++20)** returns a signed size. The second idiom tests the old value of `i` before using the decremented value. A forward range-based loop is clearer when reverse order is unnecessary.

Signed integer overflow is undefined behavior. Unsigned overflow is defined wraparound, but defined does not mean desirable.

| Operation | Signed integer | Unsigned integer |
|---|---|---|
| addition, subtraction, multiplication beyond range | undefined behavior | wraps modulo `2^N` |
| division by zero | undefined behavior | undefined behavior |
| minimum value divided by `-1` | undefined behavior | not applicable |
| left shift by a negative or too-large count | undefined behavior | undefined behavior |
| left shift of a negative value | undefined behavior | not applicable |
| left shift whose mathematical result is not permitted | undefined behavior | wraps modulo `2^N` |
| right shift | arithmetic for negative values since C++20 | zero-filling |

Compilers exploit the promise that signed overflow never occurs in a valid program. For example:

```cpp
void clear_prefix(int* values, int n) {
    for (int i = 0; i <= n; ++i) {
        values[i] = 0;
    }
}
```

If `n == INT_MAX`, incrementing `i` would overflow. The compiler may reason only about executions without that undefined operation, which helps it prove loop trip counts, remove impossible branches, and vectorize. An unsigned induction variable has mandatory wraparound, so the compiler must preserve any wraparound behavior that can be observed.

UndefinedBehaviorSanitizer from Chapter 1 catches a signed-overflow execution in a test build:

```cpp
#include <climits>
#include <iostream>

int main() {
    int value = INT_MAX;
    std::cout << value + 1 << '\n';  // runtime error under UBSan
}
```

```sh
clang++ -std=c++23 -Wall -Wextra -fsanitize=undefined overflow.cpp
./a.out
```

```text
runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'
```

**Rule.** Use signed types such as `std::int64_t` for application counts, differences, and arithmetic even when the valid domain is nonnegative. Reserve unsigned types for bit manipulation, modulo arithmetic, and fields whose external representation requires them.

Container APIs still return `std::size_t`, so convert at a checked boundary or use `std::ssize`. Subtraction is the decisive trap: if `received < expected`, the unsigned expression `received - expected` becomes a huge positive value.

## IEEE 754 floating point

Most current C++ targets implement `float` and `double` using IEEE 754 binary floating point. Verify a target rather than assuming:

```cpp
#include <limits>

static_assert(sizeof(float) == 4);
static_assert(sizeof(double) == 8);
static_assert(std::numeric_limits<double>::is_iec559);
```

A normal binary64 `double` is laid out conceptually as:

```text
 63 62                    52 51                              0
+---+-----------------------+----------------------------------+
| S |  exponent: 11 bits    |  fraction: 52 bits               |
+---+-----------------------+----------------------------------+

value = (-1)^S × (1.fraction)₂ × 2^(exponent - 1023)
```

The implicit leading `1` gives normal `double` values 53 bits of significand precision. Binary32 `float` uses 1 sign bit, 8 exponent bits, and 23 stored fraction bits, for 24 bits of significand precision.

Decimal `0.1` has no finite binary expansion, just as one third has no finite decimal expansion. The stored value is the nearest representable binary fraction.

```cpp
#include <iomanip>

void decimal_fraction_demo() {
    std::cout << std::setprecision(17);
    std::cout << 0.1 << '\n';                // prints: 0.10000000000000001
    std::cout << std::boolalpha
              << (0.1 + 0.2 == 0.3) << '\n'; // prints: false
}
```

Do not compare computed floating-point results for exact equality. A useful comparison combines a relative tolerance for ordinary magnitudes with an absolute tolerance near zero:

```cpp
#include <algorithm>
#include <cmath>

bool almost_equal(double lhs, double rhs,
                  double relative_tolerance,
                  double absolute_tolerance) {
    double difference = std::abs(lhs - rhs);
    double scale = std::max(std::abs(lhs), std::abs(rhs));
    return difference <=
           std::max(absolute_tolerance, relative_tolerance * scale);
}
```

The tolerances come from the domain's acceptable error; machine epsilon is not a universal tolerance. `std::numeric_limits<double>::epsilon()` is the gap between `1.0` and the next representable `double`. One **ULP**, or unit in the last place, is the gap between adjacent representable values at a particular magnitude, and that gap grows with magnitude.

Rounding can erase a small contribution before a later subtraction:

```cpp
void cancellation_demo() {
    double large = 1e16;
    double small = 1.0;
    double recovered = (large + small) - large;

    std::cout << recovered << '\n';  // prints: 0, not 1
}
```

This is catastrophic cancellation: nearby rounded values are subtracted, exposing their accumulated error.

IEEE 754 also provides positive and negative infinity and **NaN**, “not a number.” Overflow and division by floating zero can produce infinity. Invalid operations such as zero divided by zero or infinity minus infinity produce NaN under the default IEEE environment.

```cpp
#include <cmath>
#include <limits>

void special_value_demo() {
    double infinity = std::numeric_limits<double>::infinity();
    double nan = std::numeric_limits<double>::quiet_NaN();
    double propagated = nan * 2.0 + 5.0;

    std::cout << std::boolalpha;
    std::cout << (infinity > 1e300) << '\n';  // prints: true
    std::cout << (nan == nan) << '\n';        // prints: false
    std::cout << (nan != nan) << '\n';        // prints: true
    std::cout << std::isnan(propagated) << '\n'; // prints: true
}
```

NaN propagates through ordinary arithmetic. Comparisons `<`, `>`, `<=`, `>=`, and `==` with NaN are false; `!=` is true. The self-comparison `x != x` recognizes NaN, but `std::isnan(x)` states the intent.

A limit check written only around an ordered comparison can accept NaN:

```cpp
bool accept_price(double price, double maximum) {
    if (price > maximum) {
        return false;
    }
    return true;  // a NaN price reaches this line
}
```

Validate `std::isfinite(price)` at ingress before applying range checks. NaN also violates the ordering assumptions expected of keys in ordered containers (Chapter 11).

**Rule.** Never represent executable order prices as `float` or `double`. Use integer ticks or a deliberately designed fixed-point type; *Algorithms and Data Structures for Trading Systems* develops those representations. Floating point belongs in analytics, models, and signals whose error bounds are understood.

## Subnormals and fast math

Normal floating-point values have an implicit leading significand bit. **Subnormal** values fill the interval between zero and the smallest positive normal value by using a leading zero instead. They provide gradual underflow rather than an abrupt jump to zero.

```cpp
#include <cmath>
#include <limits>

void decay_demo() {
    double ewma = 1.0;

    for (int i = 0; i < 1'100; ++i) {
        ewma *= 0.5;  // enters the subnormal range, then becomes zero
    }

    bool tiny = std::fpclassify(ewma) == FP_SUBNORMAL;
    std::cout << std::boolalpha << tiny << '\n';
}
```

The exact iteration at which a real decay enters the subnormal range depends on its initial value and decay factor. On some x86 processors and for some instructions, subnormal inputs or results trigger a microcode assist that is orders of magnitude slower than an ordinary floating operation. A decaying signal can therefore introduce a latency cliff long after startup.

The x86 MXCSR control register provides **FTZ** (flush to zero) for subnormal results and **DAZ** (denormals are zero) for subnormal inputs. Platform intrinsics such as `_mm_setcsr` can set those modes. Some x86 toolchains also arrange FTZ/DAZ under `-ffast-math`; verify the compiler, startup code, and thread environment rather than relying on the flag name.

Flushing removes the assist risk by changing tiny values to zero. It also changes numerical results and abandons gradual underflow.

Fast-math options trade parts of the floating-point contract for optimization freedom:

| Flag or mode | What it licenses | What breaks |
|---|---|---|
| `-ffast-math` | umbrella set of aggressive assumptions | strict IEEE behavior, exceptional-value handling, reproducibility |
| `-fno-math-errno` | math calls need not store an error in `errno` | code that reads `errno` after a math call |
| `-ffinite-math-only` | assume inputs and results are finite | NaN/infinity checks and handling |
| `-fassociative-math` | reassociate additions and multiplications | fixed reduction order, cancellation behavior |
| FTZ/DAZ | replace subnormal results/inputs with zero | gradual underflow and tiny nonzero values |

Reassociation can unlock vectorized reductions because the compiler may change `(a + b) + c` into `a + (b + c)`. Those expressions need not round to the same result.

The finite-only assumption is especially dangerous around validation:

```cpp
#include <cmath>

bool valid_signal(double signal) {
    return !std::isnan(signal);
}
```

With ordinary options, the compiler emits a NaN test. Under `-ffinite-math-only`, it may compile `valid_signal` to an unconditional `true` because the option promises that NaN never occurs. Compiler Explorer from Chapter 1 makes the deleted check visible.

**Interview.** If asked why `std::isnan` “doesn't work” in an optimized build, inspect fast-math flags before blaming the library. `-ffinite-math-only` authorizes the optimizer to assume the condition is impossible.

Apply fast-math only to translation units whose numerical contract permits it, such as a measured analytics kernel. Do not enable it globally for code that validates prices, limits, or risk invariants.

## `auto` and `decltype`

`auto` asks the compiler to deduce a type from an initializer. It removes top-level `const` and reference qualifiers in the plain `auto` form, so a reference initializer can silently produce a copy.

```cpp
void auto_copy_demo() {
    std::string symbol = "EURUSD";
    const std::string& view = symbol;

    auto copy = view;  // std::string, not const std::string&
    copy[0] = 'X';

    std::cout << copy << '\n';    // prints: XURUSD
    std::cout << symbol << '\n';  // prints: EURUSD
}
```

Given an initializer `const std::string& view`, the declaration form controls what is preserved:

| Declaration | Deduced type | Consequence |
|---|---|---|
| `auto value = view;` | `std::string` | copies |
| `auto& value = view;` | `const std::string&` | aliases, read-only |
| `const auto& value = view;` | `const std::string&` | aliases, read-only |
| `auto&& value = view;` | `const std::string&` | binds to this lvalue |
| `auto* value = &view;` | `const std::string*` | requires a pointer initializer |

In a deduction context, `auto&&` can bind to both lvalues and temporary values. It is called a **forwarding reference**; Chapter 20 develops its rules and purpose.

Use `auto` when the right-hand side makes the type obvious, for iterator types, and for lambdas, whose generated types cannot be written directly. Spell the type when it documents representation or range:

```cpp
void deduction_examples() {
    std::int64_t order_id = 8'204'991;
    std::uint16_t payload_length = 48;
    std::vector<int> orders = {101, 102};
    auto iterator = orders.begin();
    auto is_buy = [](Side side) { return side == Side::Buy; };

    std::cout << order_id << ' ' << payload_length << ' '
              << *iterator << ' ' << is_buy(Side::Buy) << '\n';
    // prints: 8204991 48 101 1
}
```

Be wary when an expression returns a proxy object instead of the apparent value. `std::vector<bool>` is the classic case: `auto bit = bits[0];` deduces its proxy reference type, not `bool` (Chapter 10).

`decltype(expression)` reports a type without evaluating the expression. For an unparenthesized name, it reports the declared type. For other expressions, it also reflects whether the expression designates an object.

| Construct | Result for `const int quantity = 10;` | Preserves `const`/reference? |
|---|---|---|
| `auto value = quantity;` | `int` | no top-level `const` |
| `decltype(quantity)` | `const int` | yes |
| `decltype((quantity))` | `const int&` | yes; parenthesized name is an lvalue expression |

`decltype(auto)` applies `decltype` rules to an initializer or return expression:

```cpp
decltype(auto) symbol_alias(std::string& symbol) {
    return (symbol);  // returns std::string&
}

void decltype_auto_demo() {
    std::string symbol = "EURUSD";
    symbol_alias(symbol)[0] = 'X';
    std::cout << symbol << '\n';  // prints: XURUSD
}
```

The parentheses in `return (symbol);` matter: they make `decltype` observe an lvalue expression and therefore deduce a reference. Use `decltype(auto)` only when preserving the exact type is intentional; plain `auto` is safer when a copy is the desired boundary.

## Explicit C++ casts

C++ provides four named casts with different powers. Their spelling advertises the operation to reviewers and makes risky conversions searchable.

| Cast | Can do | Cannot do | Typical use | Runtime cost |
|---|---|---|---|---|
| `static_cast<T>(x)` | numeric, enumeration, related-pointer conversions | remove `const`; reinterpret unrelated pointers | explicit numeric or enum conversion | conversion-dependent |
| `const_cast<T>(x)` | add or remove `const`/`volatile` | change the underlying value representation | legacy API boundary | normally none |
| `reinterpret_cast<T>(x)` | reinterpret pointer or integer representations | make an invalid access valid | ABI or wire boundary | normally none |
| `dynamic_cast<T>(x)` | checked cast in a polymorphic hierarchy | operate on non-polymorphic source classes | checked downcast (Chapter 4) | runtime type check |
| C cast `(T)x` | tries combinations of the above | clearly communicate which power it used | never | hides the requested operation |

`static_cast` performs a conversion allowed by the type system. It is the right cast for intentional numeric narrowing and enumeration conversion:

```cpp
double model_ticks = 104.75;
std::int64_t ticks = static_cast<std::int64_t>(model_ticks);
Side side = static_cast<Side>(std::uint8_t{1});
```

The cast documents intent but does not add range checking. The floating conversion still truncates.

`static_cast` can also perform an unchecked downcast between related pointer types. That operation relies on a class-hierarchy fact the cast cannot verify; Chapter 4 introduces the checked alternative and the cases where a downcast is justified.

`const_cast` changes only cv-qualification:

```cpp
void const_cast_demo() {
    int live_limit = 1'000;
    const int* read_only = &live_limit;
    int* writable = const_cast<int*>(read_only);
    *writable = 1'100;  // valid: the underlying object is not const

    const int fixed_limit = 2'000;
    int* bad = const_cast<int*>(&fixed_limit);
    *bad = 2'100;       // undefined behavior
}
```

`reinterpret_cast` requests a low-level representation reinterpretation:

```cpp
void reinterpret_cast_demo() {
    int quantity = 100;
    int* pointer = &quantity;
    std::uintptr_t address = reinterpret_cast<std::uintptr_t>(pointer);
    int* restored = reinterpret_cast<int*>(address);
    std::cout << *restored << '\n';  // prints: 100
}
```

It does not grant permission to access storage through an incompatible type. Object representation, alignment, strict aliasing, and `std::bit_cast` make this boundary precise in Chapter 16.

For recognition, `dynamic_cast` performs a checked downcast when the source class is polymorphic:

```cpp
struct Instrument {
    virtual ~Instrument() = default;
};

struct Option : Instrument {};

Option* as_option(Instrument* instrument) {
    return dynamic_cast<Option*>(instrument);  // nullptr if it is not an Option
}
```

Chapter 4 explains polymorphism, RTTI, and the full `dynamic_cast` rules.

A C-style cast can silently use more power than its author intended:

```cpp
void c_cast_demo() {
    const int limit = 1'000;
    const int* observed = &limit;
    int* writable = (int*)observed;  // silently casts away const
    *writable = 2'000;               // undefined behavior
}
```

The equivalent `const_cast<int*>(observed)` makes the dangerous operation explicit. A search for `const_cast` or `reinterpret_cast` finds review points; a search for every parenthesized type expression does not.

**Pitfall.** A named cast is not a safety check. It narrows the permission being requested, but the programmer still owns range, lifetime, alignment, and domain validation.

## Latency Lens

- Fixed-width integers stabilize field widths across platforms, a prerequisite for predictable layouts and zero-copy wire parsing (Chapter 16).
- Arithmetic on `std::uint8_t` and `std::uint16_t` normally promotes to `int`; narrow types save memory and cache footprint, not ALU work.
- Signed-overflow undefined behavior lets optimizers assume signed induction variables do not wrap, which can expose trip counts and enable vectorization.
- Unsigned subtraction wraps by definition, so an underflowed size can become a huge loop bound without a branch or exception.
- Subnormal floating-point operands can trigger microcode assists on some x86 paths; clamping a decaying value or deliberately enabling FTZ/DAZ avoids that cliff by changing the numerical contract.
- `-ffinite-math-only` can delete NaN checks at compile time, making it unsuitable for price, limit, and risk validation code.
- Ordered comparisons with NaN take the false result, so a NaN price can pass an inverted limit check quietly; validate finiteness at ingress.
- Named casts add no overhead beyond the conversion requested: qualification and many pointer casts emit nothing, numeric `static_cast` may emit a conversion instruction, and `dynamic_cast` performs a runtime type check.
