# Chapter 2 — Types, Numbers, and Representations

Low-latency systems turn external bytes into prices, quantities, identifiers, timestamps, and decisions. A wrong conversion can corrupt that chain without producing a compiler error; an overflow assumption can let the optimizer remove a check; and a convenient floating-point option can change business logic. This chapter develops the numerical and representation rules needed to reason from C++ source to stored bytes while keeping portable guarantees separate from the properties of a particular target.

## 2.1 Fundamental Types and Implementation-Defined Properties

A **fundamental type** is a built-in C++ type: `void`, `std::nullptr_t`, integral types, floating-point types, and their cv-qualified forms. Their exact properties are not all fixed by C++. A robust program queries or constrains what it needs.

The integral types form families. The standard requires minimum ranges and an ordering of widths, but it does not require `int` to have exactly 32 bits or a byte to contain exactly eight bits. `sizeof(char)` is always 1; that unit contains `CHAR_BIT` bits. On the Linux x86-64 and ARM64 environments commonly used for trading systems, a byte has eight bits, `int` is commonly 32 bits, and `long` and pointers are commonly 64 bits. These are properties of the platform ABI, not universal C++ rules.

```cpp
#include <climits>
#include <cstddef>
#include <iostream>
#include <limits>

int main() {
    std::cout << "bits per byte: " << CHAR_BIT << '\n';
    std::cout << "sizeof(int): " << sizeof(int) << '\n';
    std::cout << "sizeof(long): " << sizeof(long) << '\n';
    std::cout << "sizeof(void*): " << sizeof(void*) << '\n';
    std::cout << "int digits: " << std::numeric_limits<int>::digits << '\n';
}
```

`std::numeric_limits<T>::digits` counts non-sign value bits for integer `T`; it is not necessarily `sizeof(T) * CHAR_BIT`. The latter includes a sign bit and can include padding bits.

The plain character types deserve care. `char`, `signed char`, and `unsigned char` are three distinct types. Whether plain `char` is signed is implementation-defined. Code that stores an octet value such as 200 in `char` and later converts it to `int` can therefore produce different values across targets. Use a representation whose intent is explicit.

`bool` represents `true` and `false`, but its object size and byte representation are implementation properties. Do not lay a C++ `bool` directly over an external protocol flag. Decode the protocol’s specified integer field and validate its permitted values.

The widths of `wchar_t` and the underlying representations of character types also vary. `char8_t`, introduced in C++20, is a distinct type intended for UTF-8 code units; it is not a generic byte type. Protocol parsing normally uses `std::byte` or an unsigned integer type and performs explicit text decoding.

Compile-time assertions can turn an environmental assumption into a build requirement:

```cpp
#include <climits>
#include <cstdint>

static_assert(CHAR_BIT == 8, "wire decoder requires 8-bit bytes");
static_assert(sizeof(std::uint32_t) == 4);
```

The second assertion is redundant once `std::uint32_t` exists: an exact-width type has exactly the named width and no padding bits. Its presence is optional, as Section 2.5 explains. The first assertion documents the protocol decoder’s octet assumption.

Fundamental types affect layout, register use, vector width, and cache density. Making every count 64 bits can increase structure size and bandwidth without improving correctness. Making a value too narrow can require checks or cause wraparound. Choose a type from the domain and range first, then verify how the chosen ABI represents it.

## 2.2 Signed and Unsigned Arithmetic

Unsigned integer arithmetic is defined modulo one more than the maximum representable value. For an unsigned type with `N` value bits, the result is reduced modulo `2^N`. Signed arithmetic does not wrap by C++ contract: a result outside the type’s representable range usually has undefined behavior.

```cpp
#include <cstdint>
#include <limits>

static_assert(std::uint32_t{0} - std::uint32_t{1} ==
              std::numeric_limits<std::uint32_t>::max());
```

Modulo arithmetic is useful for masks, hashes, ring counters, and protocol fields when wraparound is part of the design. It is dangerous when applied accidentally to ordinary quantities:

```cpp
#include <cstdint>

std::uint32_t remaining(std::uint32_t original,
                        std::uint32_t executed) {
    return original - executed; // wraps if executed > original
}
```

If `executed` exceeds `original`, the result becomes a very large quantity. C++ has followed the unsigned contract exactly. Domain validation must precede the subtraction:

```cpp
struct Remaining {
    std::uint32_t value;
    bool valid;
};

Remaining remaining_checked(std::uint32_t original,
                            std::uint32_t executed) noexcept {
    if (executed > original) {
        return {0, false};
    }
    return {original - executed, true};
}
```

Unsigned comparisons become particularly surprising when mixed with signed values. A negative signed operand can be converted to a large unsigned value before comparison:

```cpp
#include <cstddef>

bool plausible_count(int decoded_count, std::size_t capacity) {
    return decoded_count < capacity; // negative values may compare as very large
}
```

The correct interface should represent invalid negative input separately or validate it before conversion:

```cpp
bool plausible_count(int decoded_count, std::size_t capacity) {
    return decoded_count >= 0 &&
           static_cast<std::size_t>(decoded_count) < capacity;
}
```

Do not adopt “use unsigned for every nonnegative number” as a universal rule. An order quantity cannot be negative, but subtraction and validation may be clearer in a signed type with sufficient range. Container sizes use unsigned `size_type`, so interfaces must bridge the two domains deliberately. C++20 comparison helpers such as `std::cmp_less` and `std::in_range` can express mixed-sign checks without the usual surprises:

```cpp
#include <utility>

bool plausible_count(int count, std::size_t capacity) {
    return count >= 0 && std::cmp_less(count, capacity);
}
```

The `std::cmp_*` functions are constrained to standard integer types and account for signedness. Mathematical comparison still says that a negative number is less than a positive capacity, so the domain check remains necessary. The helpers do not validate a business-domain maximum or make a negative value suitable for later conversion.

Modulo behavior is predictable, but its machine cost is not always zero. Arithmetic on native-width unsigned types commonly uses the same add and subtract instructions as signed arithmetic. A remainder operation by a non-power-of-two divisor may require division or a compiler-generated multiply-and-shift sequence. A power-of-two ring can use a mask, provided capacity invariants are enforced. Chapter 17 applies that fact to queues.

## 2.3 Promotions and Usual Arithmetic Conversions

Most integer expressions are not evaluated in the operands’ apparent types. **Integer promotions** first convert types narrower than `int` to `int` if it can represent all their values, otherwise to `unsigned int`. The **usual arithmetic conversions** then find a common type for many binary operators.

This example does not multiply in 16 bits:

```cpp
#include <cstdint>

std::int32_t product(std::int16_t a, std::int16_t b) {
    return a * b; // operands are normally promoted to int
}
```

On a common platform with 32-bit `int`, every `int16_t` value fits in `int`, so multiplication occurs as `int`. The largest product of two signed 16-bit values fits in 32-bit `int`, making this particular operation safe. The reasoning must follow the types and their ranges, not a visual impression of the source.

Promotions also apply to small unsigned types:

```cpp
#include <cstdint>

std::uint8_t distance(std::uint8_t a, std::uint8_t b) {
    return a - b;
}
```

On a platform where `int` represents every `uint8_t` value, subtraction occurs in `int`. If `a < b`, it produces a negative `int`; conversion on return then reduces the value modulo 256 because the destination is `uint8_t`. The wrap happens at conversion, not in the subtraction.

The usual arithmetic conversions become less intuitive when signed and unsigned operands have the same rank. If `int` and `unsigned int` meet, `int` converts to `unsigned int`. For differing ranks, the result depends on whether the signed type can represent every value of the unsigned type. This is why memorizing one slogan is inadequate.

```cpp
#include <cstdint>

bool before(std::int64_t signed_sequence,
            std::uint64_t unsigned_sequence) {
    return signed_sequence < unsigned_sequence;
}
```

Here the signed operand converts to `uint64_t` on typical implementations where the two typedefs name corresponding 64-bit types. A negative sequence then becomes a large positive value. Enable conversion warnings, but do not expect warnings to define policy:

```sh
g++ -std=c++23 -O2 -Wall -Wextra -Wconversion -Wsign-conversion types.cpp
```

The conditional operator can also compute a common type:

```cpp
auto value = condition ? std::uint32_t{1} : -1;
```

On common platforms, `value` is `std::uint32_t`, and the `-1` arm converts to the maximum unsigned value. `auto` accurately preserves the expression type; it does not preserve the programmer’s informal intent.

Use explicit conversion at a validated boundary, not casts scattered after warnings appear. Widen before performing arithmetic:

```cpp
#include <cstdint>

std::int64_t notional(std::int32_t price_ticks,
                      std::uint32_t quantity) noexcept {
    const auto price = static_cast<std::int64_t>(price_ticks);
    const auto qty = static_cast<std::int64_t>(quantity);
    return price * qty;
}
```

Every `uint32_t` value fits in `int64_t`, so the cast of `quantity` is safe. The product of an `int32_t` and a `uint32_t`, once represented as `int64_t`, also fits in `int64_t`. Accumulating many products can still overflow and needs a separate proof or check.

Conversions affect generated code when they change width or signedness. Loading a 16-bit field may require sign or zero extension. Widening from 32 to 64 bits can be free as part of a load or require an instruction, depending on target and context. The important performance result is often not that extension itself, but whether a chosen width enlarges arrays or blocks a SIMD layout. Inspect assembly after establishing correctness.

## 2.4 Narrowing, Overflow, Shifts, and Undefined Behavior

A **narrowing conversion** can lose range, precision, or sign information. Braced initialization rejects many narrowing conversions at compile time:

```cpp
int a = 3.9;    // permitted; a becomes 3
// int b{3.9};  // ill-formed: narrowing

unsigned c = -1;   // permitted conversion to a large unsigned value
// unsigned d{-1}; // ill-formed: narrowing
```

Braces are a useful guard, not complete validation. A runtime integer can still be outside a destination range, and an explicit cast tells the compiler to perform a conversion rather than proving it is meaningful. C++23 does not provide a general checked-arithmetic facility in the standard library. Use range checks, a well-reviewed utility, or compiler builtins behind a portable interface.

```cpp
#include <cstdint>
#include <limits>

bool add_quantity(std::uint32_t a, std::uint32_t b,
                  std::uint32_t& result) noexcept {
    if (b > std::numeric_limits<std::uint32_t>::max() - a) {
        return false;
    }
    result = a + b;
    return true;
}
```

This unsigned check is defined for all inputs. A signed check needs care because evaluating an overflowing expression merely to test it is already undefined:

```cpp
// BROKEN
bool overflowed(std::int32_t a, std::int32_t b) {
    const auto sum = a + b; // UB may occur here
    return sum < a;
}
```

Signed-overflow undefined behavior gives optimizers strong assumptions. For a well-defined execution, `a + 1 > a` is always true for signed `a`; the hypothetical maximum-value case is not a defined counterexample. Flags such as GCC and Clang’s `-fwrapv` request nonstandard implementation semantics for signed overflow in that build. They alter the optimization contract and must be a documented project-wide choice, not an accidental local remedy.

Division has its own invalid cases. Integer division by zero is undefined. Dividing the minimum signed value by `-1` is also unrepresentable and undefined. A decoder or risk calculation must reject both before division.

Shift operators combine promotions with bounds rules. For built-in shifts, the right operand must be nonnegative and less than the number of bits in the promoted left operand; otherwise behavior is undefined. Right-shifting a negative signed value is defined in C++20 and later as arithmetic right shift, rounding toward negative infinity. Left-shifting a negative signed value is undefined, and signed left shift must satisfy the standard’s representability conditions. Unsigned shifts provide the clearest bit manipulation.

```cpp
#include <cstdint>
#include <optional>

std::optional<std::uint32_t> one_bit(unsigned bit) noexcept {
    if (bit >= 32) {
        return std::nullopt;
    }
    return std::uint32_t{1} << bit;
}
```

Do not write `1 << bit` when a 32-bit unsigned mask is intended. The literal `1` has type `int`, so the shift occurs in signed `int`. Starting with `std::uint32_t{1}` establishes unsigned semantics.

Overflow checks add branches or data dependencies, but correctness must not be removed to improve a microbenchmark. Compilers often map checked operations to overflow flags and conditional branches or moves. Whether those branches predict well depends on data. If invalid input is rare, the common path can remain compact; malformed traffic still needs bounded handling. Examine assembly and exercise both valid and invalid paths.

## 2.5 Fixed-Width Integers, `size_t`, and `ptrdiff_t`

The header `<cstdint>` supplies integer types with stated width properties. Exact-width types such as `std::int32_t` and `std::uint64_t` exist only when the implementation has a type with exactly that many bits and no padding bits. They are optional in the C++ standard, though present on mainstream Linux targets.

Use exact-width types for fields whose width is part of an external format or durable schema. A 32-bit sequence field should not be declared `unsigned long`, whose width differs between common ABIs. Exact width does not specify byte order, alignment in a surrounding structure, or permission to reinterpret unaligned input.

The header also provides minimum-width types such as `std::int_least32_t` and usually fastest-width types such as `std::int_fast32_t`. “Fastest” is an implementation choice and may widen storage. A `std::uint_fast16_t` array can consume more than two bytes per element. Inspect `sizeof` before choosing it for dense data.

`std::size_t` is the unsigned result type of `sizeof` and is used for object sizes and standard container indices. It can represent the size in bytes of any object. `std::ptrdiff_t` is a signed integer type used for subtraction of pointers into the same array, when the result is representable.

```cpp
#include <cstddef>
#include <span>

std::ptrdiff_t find_zero(std::span<const int> values) noexcept {
    for (std::size_t i = 0; i < values.size(); ++i) {
        if (values[i] == 0) {
            return static_cast<std::ptrdiff_t>(i);
        }
    }
    return -1;
}
```

This interface has a latent assumption: every possible span size used here fits in `ptrdiff_t`. Standard library ranges provide signed-size utilities such as `std::ssize`, but conversion still rests on representability requirements. A result type such as `std::optional<std::size_t>` avoids the negative sentinel and its mixed-sign interactions:

```cpp
#include <optional>

std::optional<std::size_t> find_zero(std::span<const int> values) noexcept {
    for (std::size_t i = 0; i < values.size(); ++i) {
        if (values[i] == 0) {
            return i;
        }
    }
    return std::nullopt;
}
```

This `optional` is commonly an inline index plus engagement state and padding; its exact layout is not specified. Chapter 9 analyzes result representations.

Pointer width is an ABI property. A 64-bit pointer does not imply that every virtual address bit is used, that every object can approach `2^64` bytes, or that `long` has the same width. Never serialize pointers. Shared-memory structures meant to be mapped at different virtual addresses should use offsets with a deliberately chosen width and validated bounds.

Type width changes memory footprint. Replacing a 32-bit index with `size_t` may add four bytes and padding to every node on a 64-bit ABI. It can be correct and harmless, or it can reduce cache density in a large table. State the maximum capacity. If a fixed 32-bit index suffices, validate that capacity at construction and retain a distinguished invalid value deliberately.

## 2.6 IEEE-754 Values, Rounding, and Exceptions

C++ floating-point types are implementation-defined representations with minimum requirements. Most contemporary x86-64 and ARM64 C++ implementations use IEC 60559, commonly known as IEEE 754, binary32 for `float` and binary64 for `double`. Test the properties your application requires:

```cpp
#include <limits>

static_assert(std::numeric_limits<double>::is_iec559);
static_assert(sizeof(double) == 8);
```

Even on such implementations, compiler modes, evaluation methods, and the floating-point environment affect behavior. A trading protocol should not assume that copying an arbitrary eight-byte field into `double` yields a finite valid price.

Binary floating point represents values as a sign, a significand, and an exponent, together with special encodings. Important values include:

- positive and negative zero;
- positive and negative infinity;
- quiet and signaling NaNs, with implementation details around payloads;
- normal finite values;
- subnormal values near zero.

NaN is unordered. Comparisons other than `!=` are false when an operand is NaN:

```cpp
#include <cmath>

bool valid_price(double price) noexcept {
    return std::isfinite(price) && price > 0.0;
}
```

Checking only `price <= 0.0` and accepting the `else` path would accidentally accept NaN. Validation should positively state the valid domain.

Positive and negative zero compare equal, but their signs can affect operations: `1.0 / +0.0` commonly yields positive infinity and division by `-0.0` negative infinity under IEC 60559 semantics. Hashing, serialization, or bitwise comparison can distinguish their representations. Decide whether a domain canonicalizes zero.

Many decimal fractions are not exactly representable in binary. Repeatedly adding `0.01` does not give an exact decimal accounting system. Prices and quantities defined on discrete venue scales are usually better represented as integer ticks and integer units, with a wider type for products. Floating point remains useful for models, statistics, and values whose domain is naturally approximate.

The active rounding mode affects operations for implementations that honor the floating-point environment. Round-to-nearest with ties to even is the usual default. `<cfenv>` exposes rounding modes and exception flags such as invalid, division by zero, overflow, underflow, and inexact. These **floating-point exceptions** are normally status flags, not C++ exceptions.

```cpp
#include <cfenv>
#include <cmath>

#pragma STDC FENV_ACCESS ON

bool division_was_inexact(double a, double b) {
    std::feclearexcept(FE_ALL_EXCEPT);
    volatile double result = a / b;
    (void)result;
    return std::fetestexcept(FE_INEXACT) != 0;
}
```

Support for `FENV_ACCESS` and dynamic rounding assumptions varies across compilers and modes; confirm the implementation documentation and emitted code. The `volatile` local here forces an access for this diagnostic example but does not provide concurrency semantics.

Floating-point flags are often sticky until cleared. Reading or changing the environment adds work and can inhibit optimization. A hot path normally uses a fixed, documented environment and validates inputs explicitly rather than checking flags after every operation.

## 2.7 Subnormals, Conversions, Division, and Vectorization

**Subnormal numbers** fill the gap between zero and the smallest positive normal floating-point number. They provide gradual underflow: precision decreases near zero instead of values dropping abruptly to zero.

The C++ property `std::numeric_limits<T>::has_denorm` describes implementation support, but runtime processor modes can alter handling. On x86, commonly configured MXCSR modes called flush-to-zero (FTZ) and denormals-are-zero (DAZ) can replace subnormal results or inputs with zero. ARM64 has related floating-point control state. These are hardware/environment settings, not general C++ guarantees, and they change numerical semantics.

Subnormal arithmetic has historically been much slower on some microarchitectures and operations. Other processors handle much of it at normal throughput. Do not quote a timeless penalty. Test representative input on the deployed CPU, and inspect whether libraries or process startup code modify the environment.

Division is another operation whose latency and reciprocal throughput vary by type and microarchitecture. Integer division by a runtime divisor is often a long-latency instruction with a dependency chain. Division by a compile-time constant can be transformed into shifts or multiply-high sequences. Floating division can limit loop throughput even when loads are cache-hot.

```cpp
#include <cstddef>
#include <span>

void normalize(std::span<double> values, double scale) noexcept {
    for (double& value : values) {
        value /= scale;
    }
}
```

A compiler cannot replace division by `scale` with multiplication by `1.0 / scale` under all strict floating-point semantics: rounding and exceptional cases can differ. Some optimization modes permit that transformation. A programmer can compute a reciprocal explicitly after validating `scale`, but that changes the rounding sequence and must meet the application’s error policy.

Conversions can also carry hidden work. Integer-to-floating and floating-to-integer instructions have target-specific latency and range behavior. Converting a floating value outside the destination integer range has undefined behavior in C++. Validate before conversion; merely casting is not saturation.

```cpp
#include <cmath>
#include <cstdint>
#include <limits>
#include <optional>

std::optional<std::int64_t> to_ticks(double price,
                                    double tick_size) noexcept {
    if (!std::isfinite(price) || !std::isfinite(tick_size) ||
        tick_size <= 0.0) {
        return std::nullopt;
    }

    const double scaled = std::round(price / tick_size);
    constexpr auto low = static_cast<double>(
        std::numeric_limits<std::int64_t>::min());
    constexpr auto high = static_cast<double>(
        std::numeric_limits<std::int64_t>::max());

    if (scaled < low || scaled >= high) {
        return std::nullopt;
    }
    return static_cast<std::int64_t>(scaled);
}
```

This illustrates policy but is not a perfect decimal-price converter. Near 64-bit limits, `double` cannot represent every integer, and `static_cast<double>(INT64_MAX)` rounds. A production boundary should use a decimal parser or a narrower explicitly bounded range. The example’s upper comparison is deliberately conservative.

Vectorization requires independent operations, suitable alias information, and semantics that permit reordering or grouping. A loop containing a function call, data-dependent branch, possible floating-point exception observation, or strict reduction order may remain scalar. GCC and Clang can report vectorization decisions:

```sh
g++ -std=c++23 -O3 -fopt-info-vec-all normalize.cpp
clang++ -std=c++23 -O3 -Rpass=loop-vectorize \
    -Rpass-missed=loop-vectorize normalize.cpp
```

The reports explain compiler reasoning for that build. Verify with assembly and representative measurements; a vectorized loop can still lose on small ranges or suffer frequency and memory-bandwidth effects.

## 2.8 Fast-Math Tradeoffs

“Fast math” is a family of compiler permissions that relax strict floating-point behavior. GCC and Clang’s `-ffast-math` enable multiple transformations and assumptions; the exact set is compiler- and version-specific. It is not equivalent to “use the fastest IEEE-754 instructions.”

Possible assumptions include ignoring NaNs and infinities, disregarding signed zero, reassociating expressions, contracting operations, treating the floating-point environment as fixed, or replacing division with reciprocal approximations. These can enable vectorization and shorten dependency chains. They can also invalidate validation code.

```cpp
#include <cmath>

bool acceptable(double value) noexcept {
    return std::isfinite(value) && value >= 0.0;
}
```

If a compilation mode assumes finite inputs, the `isfinite` check may no longer protect an untrusted protocol boundary as intended. Do not compile input validation under assumptions that declare invalid input impossible.

Reassociation changes results because floating-point addition is not associative:

```cpp
double left  = (a + b) + c;
double right = a + (b + c);
```

For some magnitudes, `left != right`. A reduction may produce different answers with vector width, thread count, compiler version, or surrounding code. That can be acceptable for a statistical estimate with a documented tolerance and unacceptable for a risk threshold or replay system that requires bitwise reproduction.

Fused multiply-add computes `a * b + c` with one rounding instead of rounding the multiplication and addition separately. This is often more accurate, but it can differ from the two-operation result. Contracting to FMA is therefore both a performance and numerical choice.

Treat floating-point policy as an interface property:

1. Classify computations: protocol validation, accounting, risk gates, models, diagnostics.
2. Specify exceptional values, rounding, reproducibility, and error tolerance.
3. Apply compiler flags at the narrowest build boundary compatible with that policy.
4. Test edge cases and compare against a high-precision or integer reference.
5. Inspect vectorization and measure representative distributions.

Whole-program `-ffast-math` is especially risky when validation and approximate numerical kernels share translation units. A separately compiled, explicitly documented kernel can make the relaxed contract reviewable. Even then, link-time optimization and header-defined code require care.

Performance gains are workload-specific. If a loop is memory-bandwidth bound, relaxed arithmetic may not improve it. If a division or strict reduction blocks vectorization, it may. The claim needs assembly and end-to-end evidence.

## 2.9 Object and Value Representation

The **object representation** of an object of type `T` is the sequence of `sizeof(T)` `unsigned char` objects that occupies its storage. The **value representation** is the set of bits in that object representation that participate in representing a value of `T`. Other bits are padding bits.

These definitions explain why equal values need not have identical bytes and why copying bytes is not the same as assigning a value. A structure may contain padding between members:

```cpp
#include <cstdint>

struct MessageKey {
    std::uint8_t venue;
    std::uint32_t sequence;
};
```

On a common ABI, `MessageKey` has three padding bytes between its members so that `sequence` is aligned. The standard does not require that layout. Assignment gives the destination members the same values; it need not normalize padding. A bytewise comparison can report different representations for objects whose members compare equal.

```cpp
// BROKEN as general value equality
// return std::memcmp(&a, &b, sizeof a) == 0;

bool equal(const MessageKey& a, const MessageKey& b) noexcept {
    return a.venue == b.venue && a.sequence == b.sequence;
}
```

`std::has_unique_object_representations_v<T>` reports whether every distinct value of `T` has a unique object representation for a trivially copyable type, according to the implementation. It is a useful constraint for some low-level designs, but it does not define an external wire format, byte order, or cross-build ABI.

Object representation is not automatically stable across compilers, targets, build options, or language changes. Never serialize a C++ structure by writing `sizeof(T)` bytes merely because all its members look fixed-width. Padding, alignment, endian order, enum representation, and floating formats remain concerns.

Define a wire format independently:

```text
offset  size  meaning
0       1     venue code
1       4     big-endian sequence
5       4     big-endian quantity
```

Then decode fields by offset with length checks. This format remains meaningful even if the in-memory structure changes for cache efficiency.

For trivially copyable types, C++ permits copying the underlying bytes into an array of `char`, `unsigned char`, or `std::byte`, and copying them back under the standard’s rules. That supports snapshots within a compatible execution environment, diagnostics, and bit-level transforms. It does not solve validation: not every arbitrary byte sequence necessarily denotes a valid value for every type.

Representation choices affect latency through density and access. Padding can improve aligned access while wasting cache capacity. Packed external layouts save bytes but may place fields at unaligned addresses. A good decoder reads from the compact wire representation safely and writes to an internal representation designed for its access pattern.

## 2.10 `char`, `unsigned char`, `std::byte`, and `std::bit_cast`

Objects can be inspected through glvalues of `char`, `unsigned char`, or `std::byte`. This is a special permission in the aliasing rules. It does not mean an arbitrary typed pointer may be formed from packet bytes and dereferenced.

`std::byte`, introduced in C++17, is an enum-like byte type for raw storage. It has bitwise operations but no implicit arithmetic conversion. This prevents accidental treatment of bytes as characters or numbers.

```cpp
#include <array>
#include <cstddef>
#include <cstdint>

std::uint16_t load_be16(const std::byte* p) noexcept {
    const auto high = std::to_integer<std::uint16_t>(p[0]);
    const auto low  = std::to_integer<std::uint16_t>(p[1]);
    return static_cast<std::uint16_t>((high << 8) | low);
}
```

The function reads two byte objects, widens before shifting, and does not require alignment. The caller must still prove that two bytes are accessible. A span interface can carry the length:

```cpp
#include <optional>
#include <span>

std::optional<std::uint16_t> load_be16(
    std::span<const std::byte> input) noexcept {
    if (input.size() < 2) {
        return std::nullopt;
    }
    return load_be16(input.data());
}
```

`std::bit_cast<To>(from)`, introduced in C++20, creates a value of `To` corresponding to the bits of `from`. Source and destination must have equal size and be trivially copyable; additional rules govern whether the resulting bits represent valid objects and values. A conforming implementation commonly compiles a small bit cast to no instructions or a register move.

```cpp
#include <bit>
#include <cstdint>

std::uint32_t float_bits(float value) noexcept {
    static_assert(sizeof(float) == sizeof(std::uint32_t));
    return std::bit_cast<std::uint32_t>(value);
}
```

This is preferable to pointer punning:

```cpp
// BROKEN: violates aliasing rules and may have alignment issues.
std::uint32_t bad(float value) {
    return *reinterpret_cast<std::uint32_t*>(&value);
}
```

`bit_cast` preserves bits; it does not convert numerical value or byte order. Bit-casting four network bytes into `uint32_t` produces a host integer whose value depends on host endianness, assuming the bytes can first be placed into the source object legally. Use an endian-aware load instead.

`std::memcpy` remains a useful primitive for alignment-safe field loading:

```cpp
#include <cstring>

std::uint32_t load_native_u32(const std::byte* p) noexcept {
    std::uint32_t value;
    std::memcpy(&value, p, sizeof value);
    return value;
}
```

For a fixed small size, GCC and Clang commonly inline this into an unaligned-capable load on x86-64 or an appropriate sequence on the target. C++ guarantees the copy semantics, not that instruction selection. The result uses native byte order, and the caller supplies bounds. Inspect assembly rather than replacing the copy with undefined pointer punning.

## 2.11 Padding Bits, Trap Representations, and Alignment

**Padding bits** occupy object storage but do not participate in a type’s value representation. A structure can also have padding bytes between or after members to satisfy alignment and array-stride requirements.

Padding has three practical consequences. It increases footprint, its contents may be indeterminate, and it makes bytewise equality or hashing suspect. Zero-initializing a structure often clears its storage in a particular implementation, but value-initialization semantics and later member assignments should not be treated as a portable wire canonicalization scheme.

A **trap representation** is a bit pattern whose interpretation as a value of a particular type can have undefined behavior. Modern mainstream integer implementations have few surprises here, and C++20 requires two’s-complement representation for standard signed integer types. Other types, padding states, and invalid pointer or floating representations still make “every byte pattern is a valid object” an unsafe general assumption. Exact-width unsigned integer types are particularly useful because their representations have no padding bits.

Alignment is a requirement on an object’s address. `alignof(T)` reports the required alignment of `T`; `alignas` can request stricter alignment within implementation limits.

```cpp
#include <cstddef>
#include <cstdint>

struct alignas(64) PublishedIndex {
    std::uint64_t value;
};

static_assert(alignof(PublishedIndex) >= 64);
```

This type usually occupies at least 64 bytes because array elements must each satisfy the alignment. The intent might be to isolate frequently written indices on cache lines. C++ does not guarantee that the hardware cache line is 64 bytes, nor that two separately allocated objects land on distinct lines. C++17 provides `std::hardware_destructive_interference_size` when the implementation defines it, but support and values are implementation properties.

Misaligned typed access is undefined behavior in C++, even on hardware such as x86-64 that supports many unaligned loads. This packet decoder is broken:

```cpp
// BROKEN: address may be unaligned, lifetime/aliasing is not established,
// and byte order is ignored.
auto quantity = *reinterpret_cast<const std::uint32_t*>(packet + 5);
```

Use bytewise assembly or `memcpy` into an aligned object, then convert endianness. Compilers can optimize the safe idiom.

Over-alignment changes allocation requirements. The language and standard allocation functions support over-aligned types, but custom pools and shared-memory allocators must honor the requested alignment. Wasting a few bytes per object can multiply into pages and TLB entries for large tables. Conversely, compressing a field into an unaligned packed layout can impose extra instructions or faults on targets that forbid the access. Measure the actual access pattern.

Diagnostics help:

```sh
g++ -std=c++23 -O1 -g -fsanitize=undefined alignment.cpp
```

UndefinedBehaviorSanitizer can detect exercised misaligned accesses in an instrumented build. It cannot validate an unexercised packet path, prove external lengths, or establish cross-process layout compatibility.

## 2.12 `std::endian` and C++23 `std::byteswap`

**Endianness** is the order in which the bytes of a multi-byte scalar are arranged in memory. `std::endian`, introduced in C++20, describes the native byte order through constants in `<bit>`.

```cpp
#include <bit>

static_assert(std::endian::native == std::endian::little ||
              std::endian::native == std::endian::big,
              "decoder does not support mixed-endian scalars");
```

Most current x86-64 and mainstream Linux ARM64 systems operate little-endian. Network protocols often define fields in big-endian order. Neither fact should be hidden in a cast.

C++23 `std::byteswap` reverses the bytes of an integer value. Availability depends on the standard-library version even when the compiler accepts `-std=c++23`. The feature-test macro `__cpp_lib_byteswap` can gate a compatibility implementation.

```cpp
#include <bit>
#include <cstdint>

constexpr std::uint32_t from_be32(std::uint32_t value) noexcept {
    if constexpr (std::endian::native == std::endian::little) {
        return std::byteswap(value);
    } else {
        return value;
    }
}
```

To decode an unaligned packet field, first copy its bytes into a native object, then convert its value:

```cpp
#include <cstddef>
#include <cstring>
#include <optional>
#include <span>

std::optional<std::uint32_t> read_be32(
    std::span<const std::byte> input,
    std::size_t offset) noexcept {
    if (offset > input.size() || input.size() - offset < sizeof(std::uint32_t)) {
        return std::nullopt;
    }

    std::uint32_t native;
    std::memcpy(&native, input.data() + offset, sizeof native);
    return from_be32(native);
}
```

The two-part bounds condition avoids overflow in `offset + sizeof(uint32_t)`. The copy establishes an aligned `uint32_t` object without aliasing violations. On a supported target, an optimizing compiler commonly emits one unaligned load plus a byte-swap instruction for the little-endian branch. That is an observation to verify, not a C++ guarantee.

Byte order is a field property, not necessarily a message-wide property. Some venue formats use little-endian integers, single-byte codes, and arrays of raw text in one message. Floating-point fields require a representation specification in addition to byte order. Bit fields in C++ structures are especially unsuitable as wire overlays because allocation order and layout are implementation-defined.

Converting at ingress creates a clear internal invariant: all integer values use native arithmetic representation. Converting repeatedly at each use adds work and invites missed conversions. Alternatively, a strong wrapper type can retain “big-endian encoded” state, but its operators must make conversion and storage costs visible.

Test decoders with known byte arrays on every supported architecture, not just round trips. Encoding and decoding with the same wrong rule can pass a round-trip test.

## 2.13 Scoped Enumerations and C++23 `std::to_underlying`

An enumeration defines a distinct type with a finite set of named constants. An **unscoped enumeration** exports its enumerator names into the surrounding scope and can convert implicitly to an integer. A **scoped enumeration**, declared with `enum class` or `enum struct`, keeps names scoped and does not implicitly convert to an integer.

```cpp
#include <cstdint>

enum class Side : std::uint8_t {
    buy = 1,
    sell = 2
};

enum class OrderState : std::uint8_t {
    pending,
    live,
    filled,
    canceled
};
```

Scoped enums arrived in C++11 and are the default choice for domain tags. The explicit underlying type controls storage range and makes representation intent clearer. It does not make every underlying value a valid enumerator, validate protocol input, or define how a containing structure is packed.

```cpp
#include <optional>

std::optional<Side> decode_side(std::uint8_t raw) noexcept {
    switch (raw) {
    case 1: return Side::buy;
    case 2: return Side::sell;
    default: return std::nullopt;
    }
}
```

`static_cast<Side>(raw)` can produce a value without a named enumerator, subject to the enumeration’s range rules; it is not protocol validation. An exhaustive `switch` without `default` can help compiler warnings when all enum values originate internally, but an enum object decoded from external input needs validation before that invariant holds.

C++23 `std::to_underlying` converts an enumeration value to its underlying type without repeating the type expression:

```cpp
#include <utility>

static_assert(std::to_underlying(Side::sell) == std::uint8_t{2});
```

Before C++23, the equivalent is `static_cast<std::underlying_type_t<Side>>(value)`. Like `byteswap`, library availability may lag language-mode support; check `__cpp_lib_to_underlying` where portable build coverage requires a fallback.

Enums can improve performance indirectly by making invalid combinations harder to express and enabling compact storage. A `uint8_t` underlying type can pack a state array densely, while placing it before a 64-bit field in a structure may introduce padding. Reorder members based on access pattern and layout constraints rather than changing semantic types merely to remove bytes.

Do not use an enum as an array index without checking range or relying on a proven internal invariant:

```cpp
// Requires the invariant that state is one of the four named values.
auto index = static_cast<std::size_t>(std::to_underlying(state));
```

When states have sparse protocol codes, use a `switch` or lookup table with validated bounds. Measure the realistic distribution; a clear switch can compile to comparisons or a jump table, and its predictability depends on inputs.

## 2.14 Aggregates, Uniform Initialization, and Designated Initializers

An **aggregate** is an array or class that satisfies the standard’s version-specific aggregate rules and can be initialized member by member without user-defined constructor machinery. The exact class conditions changed across C++11–23, so a type can gain or lose aggregate status as declarations or language modes change. Query it when a generic facility depends on the property:

```cpp
#include <cstdint>
#include <type_traits>

struct RiskLimits {
    std::int64_t max_notional;
    std::uint32_t max_quantity;
    bool enabled;
};

static_assert(std::is_aggregate_v<RiskLimits>);
```

Braced initialization is often called **uniform initialization** because braces work in many contexts. The underlying rules are not completely uniform. They can perform aggregate initialization, list initialization of constructors, or initialization through `std::initializer_list`; narrowing conversions are rejected.

```cpp
constexpr RiskLimits limits{
    5'000'000'000LL,
    25'000U,
    true
};
```

If fewer initializers are supplied, remaining aggregate members are initialized from default member initializers when present, otherwise from an empty initializer list according to the member’s rules. This can be convenient, but adding or reordering members may silently change positional initialization at call sites.

C++20 designated initializers name members:

```cpp
constexpr RiskLimits limits{
    .max_notional = 5'000'000'000LL,
    .max_quantity = 25'000U,
    .enabled = true
};
```

C++ designated initializers are more constrained than their C counterparts. Designators must name direct non-static data members and appear in declaration order; C++ does not support arbitrary reordering, nested designators, or mixing designated and positional initializers in the same list. These restrictions preserve clear initialization order.

Default member initializers can document policy:

```cpp
struct DecoderConfig {
    std::uint32_t max_messages{1'024};
    bool reject_unknown_types{true};
    bool collect_diagnostics{false};
};

constexpr DecoderConfig config{
    .max_messages = 2'048,
    .collect_diagnostics = true
};
```

`reject_unknown_types` retains its default. Review additions carefully: a new boolean that defaults to `false` can change safety policy at every existing initialization.

Aggregate initialization does not imply a packed or portable layout. `RiskLimits` can contain padding between its members and at the end. It also does not necessarily imply zero runtime work. Initializing a large aggregate or array touches memory proportional to its size; constant initialization may instead place data in the program image, with page residency still determined at runtime.

Adding a private member, a constructor, or certain inheritance features can change aggregate status depending on the language version. Public APIs that rely on positional aggregate initialization are therefore coupled to member order. A constructor or named builder gives stronger compatibility at the possible cost of more code—not necessarily more runtime instructions after inlining.

Initializer-list constructor preference is another trap:

```cpp
#include <vector>

std::vector<int> a(4, 7); // four elements, each 7
std::vector<int> b{4, 7}; // two elements: 4 and 7
```

Both are valid and semantically different. Braces prevent many narrowing conversions, but they do not always select the constructor a reader expects. Chapter 3 examines `std::initializer_list`, temporary arrays, and move inhibition.

For hot-path configuration and messages, favor types whose invariants are clear. An aggregate works well for passive validated data. A type that must reject invalid price scales or keep fields mutually consistent may need a factory or constructor. Zero-cost abstraction begins with a valid abstraction; aggregate status is not a performance target by itself.

## 2.15 Interview Check

1. Which properties of `int`, `long`, `char`, and pointers are guaranteed by C++, and which common properties come from a Linux ABI?
2. Explain exactly where wraparound occurs in `std::uint8_t result = a - b;` on a platform with 32-bit `int`.
3. Why can comparing a negative `int` with a `size_t` produce a surprising result? Give two safe interface designs.
4. Review an expression multiplying a signed 32-bit price by an unsigned 32-bit quantity. How would you prove that the product and an accumulated sum are safe?
5. List the invalid cases for built-in integer shifts and explain why `std::uint32_t{1} << bit` is preferable to `1 << bit` for a mask.
6. When should an exact-width integer be preferred to `size_t`, and how can that choice affect structure footprint?
7. Explain NaN, signed zero, subnormals, and floating-point exception flags. Which of them can invalidate an apparently simple price check?
8. Under what numerical contract could fast-math transformations be acceptable, and how would you verify their effect on both results and performance?
9. Why are `memcmp` equality and raw structure serialization generally invalid even for a structure containing only fixed-width members?
10. Compare pointer punning, `memcpy`, and `std::bit_cast` for examining a floating-point representation.
