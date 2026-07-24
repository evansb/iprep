# 16. Object Representation and Layout

An object is both a typed value and a region of bytes. Parts I and II used the value view; Part III adds the byte view that explains padding, legal binary copying, wire formats, and the optimizer's aliasing assumptions. The two views must agree, or apparently harmless low-level code becomes undefined behavior.

## The second pass: objects as bytes

Every object has an address, a size, a type, and a lifetime. `&object` finds its address, `sizeof(T)` reports the size of its storage, and a `const std::byte*` view exposes that storage one byte at a time without changing its type.

The **object representation** of a type `T` is all `sizeof(T)` bytes occupied by a `T`. Its **value representation** is the subset of bits that participates in representing a value. Padding belongs to the object representation but carries no value.

C++ defines a byte as the size of `char`, so `sizeof(char)` is always 1. A byte is eight bits on the targets used throughout this book, but the language permits wider bytes. `std::byte` represents raw storage rather than a character or an integer; `std::to_integer` performs the explicit conversion needed for printing.

This helper turns the bytes from a `std::span` (Chapter 12) into hexadecimal:

```cpp
#include <cstddef>
#include <cstring>
#include <format>
#include <iostream>
#include <span>

void dump_bytes(std::span<const std::byte> bytes) {
    for (std::byte byte : bytes) {
        std::cout << std::format(
            "{:02x} ", std::to_integer<unsigned int>(byte));
    }
    std::cout << '\n';
}

struct Quote {
    char side;
    int quantity;
};

int main() {
    Quote first;
    Quote second;
    std::memset(&first, 0xAA, sizeof(first));
    std::memset(&second, 0x55, sizeof(second));

    first.side = second.side = 'B';
    first.quantity = second.quantity = 100;

    dump_bytes(std::as_bytes(std::span{&first, 1}));
    dump_bytes(std::as_bytes(std::span{&second, 1}));

    std::cout << std::boolalpha
              << (first.side == second.side &&
                  first.quantity == second.quantity) << '\n'; // prints: true
    std::cout << (std::memcmp(&first, &second, sizeof(Quote)) == 0)
              << '\n'; // not guaranteed to print: true
}
```

On a typical ABI, `Quote` contains padding between `side` and `quantity`. The two objects have equal members, but those unused bytes can differ. Ordinary initialization and member assignment do not promise any particular padding contents.

`std::memcmp` compares the entire object representation, so it is not a value-equality operation for a padded type. Memberwise copy also need not preserve padding bytes even though it preserves the value.

The byte view is observational: it does not change the object's declared type or create a second object over the same storage. A writable `std::byte` view can alter representation bytes, but reading the typed value afterward is valid only if the resulting representation denotes a valid value.

Equal values are not generally required to have one unique object representation. Padding is the common reason, and some scalar types can also have multiple representations of a value. Binary formats therefore need an explicitly defined encoding rather than “whatever bytes this compiler used.”

**Pitfall.** Hashing a struct by hashing all `sizeof(T)` bytes has the same defect as `memcmp`: equal keys can produce different hashes because padding differs. Hash the members, or define a canonical byte encoding with no implicit padding.

## Size, alignment, and padding

Every complete object type has an alignment requirement, reported by `alignof(T)`. An object's address must satisfy that alignment. `sizeof(T)` includes padding and is a multiple of `alignof(T)`, which keeps every element of a `T` array correctly aligned.

A struct's alignment is normally the strictest alignment among its members. Non-zero-sized members appear in declaration order, and the implementation inserts padding before a member when the next offset would violate that member's alignment.

Predict a conventional struct layout with four steps:

1. Start the next offset at zero.
2. Round that offset up to the next member's alignment, then place the member.
3. Advance by the member's `sizeof` and repeat in declaration order.
4. Round the final offset up to the struct's alignment to obtain `sizeof`.

This algorithm describes mainstream ABIs for ordinary members. Empty subobjects, bit-fields, inheritance, and explicit packing add rules discussed separately.

Consider this common x86-64 ABI layout:

```cpp
struct OrderWide {
    char side;
    double price;
    int quantity;
};

static_assert(alignof(OrderWide) == 8);
static_assert(sizeof(OrderWide) == 24);
```

```text
offset   0  1  2  3  4  5  6  7 | 8  9 10 11 12 13 14 15 |16 17 18 19|20 21 22 23
        |S |<----- padding ----->|<------ price -------->|<- quantity ->|<- tail ->|
```

`side` occupies offset 0. Seven padding bytes bring `price` to an address divisible by 8, and `quantity` occupies offsets 16–19. Four bytes of **tail padding** make the total size a multiple of 8.

Reordering the same members removes eight wasted bytes:

```cpp
struct OrderCompact {
    double price;
    int quantity;
    char side;
};

static_assert(alignof(OrderCompact) == 8);
static_assert(sizeof(OrderCompact) == 16);
```

```text
offset   0  1  2  3  4  5  6  7 | 8  9 10 11|12|13 14 15
        |<------ price -------->|<- quantity ->|S |<- tail ->|
```

A useful first pass is to declare members in decreasing alignment order. Semantic grouping and ABI compatibility can outweigh that rule, but accidental padding should be a conscious choice.

Tail padding preserves alignment between adjacent array elements:

```cpp
OrderWide orders[4]{};

static_assert(sizeof(orders) == 4 * sizeof(OrderWide));
static_assert(sizeof(orders) == 96);
```

Arrays contain no gap beyond each element's `sizeof(T)`. The tail padding is therefore repeated inside every element.

The address stride makes this visible:

```cpp
void show_stride() {
    OrderWide pair[2]{};
    OrderWide* second = pair + 1;

    std::cout << (second == &pair[1]) << ' '
              << sizeof(OrderWide) << '\n'; // prints: 1 24
}
```

Adding one to an `OrderWide*` advances by `sizeof(OrderWide)`, including tail padding. Pointer arithmetic scales automatically; it does not land immediately after the last value-carrying member.

Fundamental sizes are implementation-defined. These are common values for the x86-64 Linux LP64 ABI, not portable language constants:

| Type | `sizeof` | `alignof` |
|---|---:|---:|
| `bool` | 1 | 1 |
| `char` | 1 | 1 |
| `short` | 2 | 2 |
| `int` | 4 | 4 |
| `long` | 8 | 8 |
| `long long` | 8 | 8 |
| `float` | 4 | 4 |
| `double` | 8 | 8 |
| `long double` | 16 | 16 |
| `void*` | 8 | 8 |
| `std::int32_t` | 4 | 4 |
| `std::int64_t` | 8 | 8 |

Windows commonly uses the LLP64 model: pointers are 8 bytes while `long` remains 4. `long double` also differs across major ABIs. Fixed-width integer types from Chapter 2 fix the width when those optional aliases exist, but their alignment is still an implementation choice.

Padding bytes can hold indeterminate or otherwise unspecified bit patterns after initialization and assignment. They are storage, not spare application fields; only explicit members can carry a protocol value.

**Pitfall.** A badly ordered hot struct silently inflates every array containing it. Check `sizeof` and member offsets on the target ABI instead of estimating from the sum of member sizes.

## Empty members cost nothing (if you ask)

A complete empty class still needs nonzero size so two distinct objects can have distinct addresses. On common implementations its size is 1, and using it as an ordinary member can trigger enough padding to cost much more than one byte.

The empty-base optimization, or EBO, lets an empty base subobject overlap storage used by the derived object. Standard-library implementations traditionally use this technique for stateless comparators and allocators.

EBO requires a base suitable for overlap; an empty class marked `final` cannot be used as a base. Encoding a storage optimization through inheritance also complicates a class design when the policy is conceptually a member.

The `[[no_unique_address]]` attribute (C++20) requests the same storage reuse for a member:

```cpp
struct Less {};

struct NaivePolicy {
    Less compare;
    double price;
};

struct EboPolicy : Less {
    double price;
};

struct ModernPolicy {
    [[no_unique_address]] Less compare;
    double price;
};

static_assert(sizeof(NaivePolicy) == 16);
static_assert(sizeof(EboPolicy) == 8);
static_assert(sizeof(ModernPolicy) == 8);
```

These assertions pin the common ABI used by the example. `[[no_unique_address]]` permits overlap; it does not require an implementation to produce the smallest conceivable layout.

The member still exists. Its constructor and destructor run, its name participates in overload resolution, and taking its address produces a pointer to a real subobject. Only the requirement for a unique address is relaxed.

Two potentially overlapping members of the same empty type must still have distinct addresses:

```cpp
struct TwoPolicies {
    [[no_unique_address]] Less first;
    [[no_unique_address]] Less second;
    double price;
};

constexpr TwoPolicies policies{};
static_assert(&policies.first != &policies.second);
```

The layout rule prevents both `Less` subobjects from occupying the same address, though either may overlap another member of a different type.

**Note.** MSVC ABI behavior has varied by toolset. Code supporting older MSVC releases may need `[[msvc::no_unique_address]]`; verify both attributes and `sizeof` in that compiler's ABI build.

**Pitfall.** The attribute does not make a stateful policy free, and adding state later can enlarge every enclosing object. Keep the `sizeof` assertion beside performance-sensitive policy wrappers.

## The type property ladder

Several type properties answer different byte-level questions. They are not four perfectly nested categories: trivial implies trivially copyable, but standard-layout is largely an independent property.

| Property | Working qualification | What it licenses |
|---|---|---|
| Trivial | Trivial eligible default construction and trivial copy/lifetime operations | Default initialization does no work |
| Trivially copyable | Trivial eligible copy/move operations and trivial non-deleted destructor | `memcpy` copy; round-trip through bytes |
| Standard-layout | C-like organization; no virtual machinery; uniform member access | `offsetof`; common initial sequence; C interop building block |
| Implicit-lifetime | Scalar, or class meeting the implicit-lifetime rules | Selected allocation and byte-copy operations can begin lifetime |

A user-provided destructor disqualifies triviality and trivial copyability. Virtual functions and virtual bases disqualify all the class properties relevant to a wire record. Mixed access control among data members disqualifies standard-layout; a reference member also prevents standard-layout.

No single folk test such as “has no virtual functions” is enough. Ask for the exact property required by the operation.

The useful containment relationship is:

```text
trivial class  ──implies──>  trivially copyable  ──implies──>  implicit-lifetime
                                      │
standard-layout  <──── largely independent ─────┘
```

A type intended for a C ABI or binary schema usually requires both the trivially-copyable and standard-layout checks. A local numeric type that only needs fast relocation may require trivial copying but not a specified member layout.

A market-data value type usually wants both trivial copying and standard layout:

```cpp
#include <cstdint>
#include <type_traits>

struct Tick {
    std::int64_t timestamp;
    double price;
    std::int32_t quantity;
};

static_assert(std::is_trivial_v<Tick>);
static_assert(std::is_trivially_copyable_v<Tick>);
static_assert(std::is_standard_layout_v<Tick>);
```

`std::is_trivially_copyable_v<Tick>` licenses copying a `Tick` between two live `Tick` objects with `std::memcpy`. It also licenses copying its bytes into a `char`, `unsigned char`, or `std::byte` buffer and later copying them back into a `Tick`; the original value is restored.

```cpp
void copy_tick() {
    Tick source{1'000, 101.25, 200};
    Tick destination{};

    std::memcpy(&destination, &source, sizeof(Tick));
    std::cout << destination.price << ' '
              << destination.quantity << '\n'; // prints: 101.25 200
}
```

This is a native object copy, not portable serialization. The copied bytes can include padding, native endianness, and implementation-chosen floating-point representation. Pointers copied this way still point into the original process; they do not become meaningful wire values.

Trivial default initialization does not mean “all bits zero.” `Tick tick;` performs no initialization of its scalar members, so reading them is undefined behavior. Value initialization supplies the zeros:

```cpp
void initialize_ticks() {
    // Tick uninitialized; // members would be indeterminate
    Tick zeroed{};          // scalar members are zero-initialized

    std::cout << zeroed.quantity << '\n'; // prints: 0
}
```

`std::memset(&object, 0, sizeof object)` is not a portable replacement for value initialization. All-bits-zero is not guaranteed to represent a null pointer or floating-point zero on every C++ implementation, and it writes padding as well.

Maintenance edits should break the build when a wire type loses its required properties:

```cpp
struct RichTick {
    std::int64_t timestamp;
    double price;
    std::int32_t quantity;

private:
    std::string symbol;
};

static_assert(std::is_trivially_copyable_v<RichTick>); // error: string copy is non-trivial
static_assert(std::is_standard_layout_v<RichTick>);     // error: mixed member access
```

For a public `std::string` member, trivial copying still fails, while the standard-layout trait can differ with the library's `std::string` representation. Either way, a library-owned string representation is not a stable wire format.

The two failing assertions form a maintenance tripwire. Keep them positive in production code: a change that adds ownership, virtual dispatch, or incompatible member access then fails at the type definition rather than in a feed handler.

An implicit-lifetime type can have its lifetime begun by specified operations such as `std::malloc` and `std::memcpy` when doing so yields defined behavior (C++20). This formalizes common C-style handling for suitable records; it does not make an arbitrary class safe to manufacture from bytes.

Bit-fields affect layout, but their allocation order and packing remain implementation-defined as described in Chapter 4. They are poor wire-format fields unless the ABI itself is the protocol.

**Interview.** If asked whether a type is “POD,” retire the old label. State whether the operation needs trivial copying, standard layout, trivial default construction, or implicit lifetime, then name the trait or rule that establishes it.

## Lifetime, storage reuse, and unions

Storage is not automatically an object. An object's lifetime begins when suitably aligned storage is obtained and its initialization completes; its lifetime ends when destruction starts or when its storage is released or reused by another object.

Implicit-lifetime types have carefully limited shortcuts. If a byte sequence is a valid `Tick` representation for the current ABI, allocation and copying can create a `Tick` in raw storage:

```cpp
Tick decode_native(
    std::span<const std::byte, sizeof(Tick)> bytes) {
    void* storage = std::malloc(sizeof(Tick));
    if (storage == nullptr) {
        throw std::bad_alloc{};
    }

    std::memcpy(storage, bytes.data(), sizeof(Tick));
    Tick result = *static_cast<Tick*>(storage);
    std::free(storage);
    return result;
}
```

The precondition matters: the bytes must come from a compatible `Tick` object representation. Network input with a specified field encoding should be decoded field by field or through the asserted wire record in the final section.

For a class with a non-trivial constructor or destructor, owning raw bytes still does not create the class object. Reusing storage ends the previous object's lifetime. Placement construction and the rare cases requiring `std::launder` belong in Chapter 17.

A union reserves enough aligned storage for its largest member, but only one member is active at a time:

```cpp
union Number {
    int integer;
    float real;
};

int pun_badly(float value) {
    Number number;
    number.real = value;    // real becomes active
    return number.integer;  // UB in C++: integer is inactive
}
```

C permits this style of representation reinterpretation with caveats; C++ does not. The fact that one compiler emits the expected bits does not establish defined C++ behavior.

There is one narrow inspection exception. If two standard-layout struct members of a union share a **common initial sequence**—corresponding initial members with layout-compatible types—the common initial members may be inspected through either struct. That exception supports tagged C-compatible records, not general type punning.

```cpp
struct Add {
    int kind;
    int quantity;
};

struct Cancel {
    int kind;
    std::uint64_t order_id;
};

union Message {
    Add add;
    Cancel cancel;
};

int inspect_kind(const Message& message) {
    return message.cancel.kind; // OK if add is active: kind is common
}
```

Only `kind` belongs to the common initial sequence. Reading `cancel.order_id` while `add` is active remains undefined behavior.

`std::variant` tracks and constructs the active alternative safely (Chapter 14). Use a raw union only when its explicit lifetime and representation rules are part of the design.

**Pitfall.** Union punning often survives debug builds and fails after optimization or inlining because the optimizer may assume an inactive member is never read. Replace it with `std::bit_cast` or `std::memcpy`.

## Pointers: arithmetic, provenance, aliasing

Pointer arithmetic is defined within one array object and at its one-past-the-end position. A non-array object acts like an array of length one for this rule. The one-past pointer is a sentinel that may be compared but not dereferenced.

```cpp
void print_values() {
    int values[3]{10, 20, 30};
    int* current = values;
    int* finish = values + 3;

    while (current != finish) {
        std::cout << *current << '\n';
        ++current;
    }

    std::cout << (current == finish) << '\n'; // prints: 1
    // std::cout << *finish; // UB: dereferences one-past
}
```

Adding an offset that takes a pointer outside the array, except exactly one-past, is undefined behavior even if no dereference follows. Subtracting pointers from different arrays is also undefined behavior.

Built-in ordering comparisons such as `<` between pointers to unrelated objects have an unspecified result. Equality is normally defined, with a narrow unspecified case when one pointer is one-past an object and the other points to a different object at that same address. `std::less` supplies a strict total order when code genuinely needs to order unrelated pointers.

**Provenance** is a useful model for the history attached to a pointer. A pointer is not merely its numeric address: the object or allocation from which it was derived constrains the storage it may access. If arrays happen to be adjacent, walking one-past the first does not grant access to the second.

Converting pointers to integers, doing address arithmetic, and converting back is not a portable way to escape those constraints. Optimizers reason about the originating allocation even when two pointer values appear to contain the same address bits.

For example, two independent arrays can end up adjacent in one execution:

```cpp
int left[4]{};
int right[4]{};
int* end = left + 4;

// end may have the same numeric address as right on a particular run.
// *end is still UB: end is one-past left, not a pointer into right.
```

The source-level array boundary controls the arithmetic. Physical adjacency supplies no additional element.

Type accessibility adds another boundary, commonly called the **strict-aliasing rule**. An object's stored value may be accessed through its own or a similar cv-qualified type, corresponding signed or unsigned forms, permitted containing aggregates and base classes, or a `char`, `unsigned char`, or `std::byte` view. Those byte types can inspect representation; they do not turn that storage into an object of another type.

```cpp
std::uint32_t illegal_bits(float value) {
    auto* integer = reinterpret_cast<std::uint32_t*>(&value);
    return *integer; // UB: accesses a float object through uint32_t
}
```

`reinterpret_cast` only computes the pointer. Dereferencing it through a type that cannot access the object is the undefined operation. Code can appear correct at `-O0` and change at `-O2` after alias analysis and inlining.

The permitted byte aliases are deliberately one-way. A `std::byte*` can inspect or copy a `float` representation, but casting that same address to `std::uint32_t*` does not create a `std::uint32_t` there. `const` and `volatile` qualification do not change the underlying accessible type.

GCC and Clang offer `-fno-strict-aliasing` as a whole-translation-unit escape hatch for legacy code. It does not make every pointer cast semantically portable, and it prevents optimizations that depend on proving differently typed accesses do not alias.

**Rule.** Pointer arithmetic stays within one array; typed access stays within the permitted alias set. Use byte views to inspect and `std::memcpy` or `std::bit_cast` to convert representations.

## Punning done right

Type punning interprets one type's object representation as a value of another type. C++ provides three legal tools:

- `std::memcpy` copies representation into an existing destination object.
- `std::bit_cast` creates a destination value with corresponding bits.
- `char`, `unsigned char`, and `std::byte` views inspect individual bytes.

The compiler recognizes fixed-size `std::memcpy` calls and normally removes the library call. The safe spelling does not require a runtime loop:

```cpp
#include <bit>
#include <cstdint>
#include <cstring>

std::uint32_t bits_with_memcpy(float value) {
    static_assert(sizeof(value) == sizeof(std::uint32_t));
    std::uint32_t result;
    std::memcpy(&result, &value, sizeof(result));
    return result;
}

std::uint32_t bits_with_bit_cast(float value) {
    return std::bit_cast<std::uint32_t>(value);
}

// Both functions typically compile to one register-transfer instruction.
```

`std::bit_cast` (C++20) is `constexpr` when its types satisfy the facility's constant-evaluation restrictions. Source and destination must have equal size, and both must be trivially copyable. It is the clearest default for fixed-size value-to-value punning.

It is a representation conversion, not a numeric conversion:

```cpp
void show_float_image() {
    float value = 1.0F;
    std::uint32_t image = std::bit_cast<std::uint32_t>(value);

    std::cout << value << ' ' << image << '\n';
    // prints the numeric float and an integer describing the same bits
}
```

The integer is not `1`; on an IEEE-754 target it is the encoding of `1.0F`. The exact result remains tied to the target's floating-point representation.

The destination representation must still denote a valid value. Converting arbitrary bytes to a type that has invalid or indeterminate representations is not made safe merely by choosing `std::bit_cast`.

| Technique | Legal C++? | `constexpr` in C++23? | Requirements | Use |
|---|---|---|---|---|
| `std::memcpy` | Yes | No | Suitable objects and sizes | Dynamic sizes; pre-C++20 style |
| `std::bit_cast` | Yes | Yes, with restrictions | Same size; both trivially copyable | Fixed-size default |
| `reinterpret_cast` then dereference | No for punning | No | — | Never for wrong-type access |
| Read inactive union member | No | No | — | Porting C only |
| `std::byte` inspection | Yes | Limited by operation | Valid object lifetime | Inspect or serialize bytes |

Pointer-to-pointer `reinterpret_cast` still has legitimate low-level uses, including pointer-value round trips and APIs that traffic in opaque addresses. It does not license wrong-type dereferencing.

**Pitfall.** Replacing a union pun with a `reinterpret_cast` only changes the spelling of the undefined behavior. Use `std::bit_cast` for equal-size values and `std::memcpy` when sizes or storage are dynamic.

## Byte order

Endianness determines the order in which a multi-byte value's bytes appear at increasing addresses. Little-endian stores the least-significant byte first; big-endian stores the most-significant byte first. Network byte order is big-endian, while mainstream x86-64 and ARM64 systems are little-endian.

`std::endian` (C++20) reports the native order. `std::byteswap` (C++23) reverses the bytes of an integer:

```cpp
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <span>

std::uint32_t read_be32(
    std::span<const std::byte, 4> bytes) {
    static_assert(
        std::endian::native == std::endian::little ||
        std::endian::native == std::endian::big);

    std::uint32_t value;
    std::memcpy(&value, bytes.data(), sizeof(value));
    if constexpr (std::endian::native == std::endian::little) {
        value = std::byteswap(value);
    }
    return value;
}

int main() {
    const std::byte wire[]{
        std::byte{0x00}, std::byte{0x01},
        std::byte{0x86}, std::byte{0xA0}};

    std::cout << read_be32(wire) << '\n'; // prints: 100000
}
```

The older socket APIs expose conversions such as `htonl`; `std::endian` and `std::byteswap` generalize the operation without tying code to the socket API.

Do not byteswap a floating-point value numerically. Treat its representation as an integer of the same size, swap that integer, then use `std::bit_cast` to recover the floating-point value.

```cpp
float read_be_float(std::span<const std::byte, 4> bytes) {
    const std::uint32_t image = read_be32(bytes);
    return std::bit_cast<float>(image);
}
```

This assumes the protocol and host agree on the floating-point representation, commonly IEEE-754 binary32. Endianness conversion alone cannot bridge different numeric formats.

**Pitfall.** Protocol order comes from the feed specification, not from habit. Some modern exchange feeds use little-endian fields; swapping those on a little-endian host corrupts them, while swapping an already converted field restores the wrong order.

## Pinning layout: offsetof and the wire flagship

`offsetof(T, member)` reports a member's byte offset from the start of `T`. It is guaranteed for standard-layout types and only conditionally supported otherwise, so pair offset assertions with `std::is_standard_layout_v<T>`.

Two standard-layout struct types can be layout-compatible when their corresponding members meet the language's compatibility rules. Their common initial sequence is the longest compatible run from the first member; this supports the narrow union inspection rule from the lifetime section, not arbitrary cross-casting.

A wire record should make every byte deliberate:

```cpp
#include <cstddef>
#include <cstdint>
#include <type_traits>

struct MdAddOrder {
    std::uint64_t sequence;
    std::uint64_t order_id;
    std::uint32_t price;
    std::uint32_t quantity;
    std::uint16_t symbol_id;
    std::byte side;
    std::byte flags;
    std::uint16_t participant_id;
    std::byte reserved[2];
};

static_assert(std::is_trivially_copyable_v<MdAddOrder>);
static_assert(std::is_standard_layout_v<MdAddOrder>);
static_assert(sizeof(MdAddOrder) == 32);
static_assert(alignof(MdAddOrder) == 8);
static_assert(offsetof(MdAddOrder, sequence) == 0);
static_assert(offsetof(MdAddOrder, order_id) == 8);
static_assert(offsetof(MdAddOrder, price) == 16);
static_assert(offsetof(MdAddOrder, quantity) == 20);
static_assert(offsetof(MdAddOrder, symbol_id) == 24);
static_assert(offsetof(MdAddOrder, side) == 26);
static_assert(offsetof(MdAddOrder, flags) == 27);
static_assert(offsetof(MdAddOrder, participant_id) == 28);
static_assert(offsetof(MdAddOrder, reserved) == 30);
```

The last two explicit reserved bytes occupy what would otherwise be tail padding. The assertions pin this translation target to the protocol ABI; a compiler or target with different integer alignment fails at build time instead of decoding silently.

Every field offset is asserted, not only the total size. A compiler could preserve `sizeof(MdAddOrder) == 32` while moving internal padding between fields; the offset checks catch that incompatible layout. The final offset plus the two-byte reserved field also proves that no unaccounted tail bytes remain on the accepted ABI.

Fixed-width integers fix field width, not byte order. Receive bytes into the trivially copyable object with `std::memcpy`, then convert every multi-byte field according to the protocol:

```cpp
MdAddOrder parse_add_order(std::span<const std::byte> buffer) {
    if (buffer.size() < sizeof(MdAddOrder)) {
        throw std::invalid_argument{"short add-order message"};
    }

    MdAddOrder message;
    std::memcpy(&message, buffer.data(), sizeof(message));

    message.price = read_be32(std::span<const std::byte, 4>{
        buffer.data() + offsetof(MdAddOrder, price), 4});
    message.quantity = read_be32(std::span<const std::byte, 4>{
        buffer.data() + offsetof(MdAddOrder, quantity), 4});

    if constexpr (std::endian::native == std::endian::little) {
        message.sequence = std::byteswap(message.sequence);
        message.order_id = std::byteswap(message.order_id);
        message.symbol_id = std::byteswap(message.symbol_id);
        message.participant_id = std::byteswap(message.participant_id);
    }
    return message;
}
```

Never obtain `MdAddOrder*` with `reinterpret_cast` from `buffer.data()` and dereference it. The buffer address may be insufficiently aligned, and its storage holds byte objects rather than a live `MdAddOrder`. `std::memcpy` into the local object is fully defined and is normally optimized into direct loads.

The bounds check happens before any pointer arithmetic that will be dereferenced. All integer fields are unsigned fixed-width types, so every incoming bit pattern represents a value; validation of semantic ranges such as side, quantity, and reserved flags is a separate protocol step.

Compiler packing extensions solve a different problem:

| Layout approach | Size control | Member access cost | Maintenance safety |
|---|---|---|---|
| Implicit padding | ABI-controlled | Naturally aligned | Low without assertions |
| Explicit padding plus assertions | Protocol-controlled | Naturally aligned | High; edits fail the build |
| `#pragma pack(1)` / `[[gnu::packed]]` | Byte-tight | Members may be unaligned | Extension-dependent |

Packed records can reduce bytes on the wire or in storage, but taking the address of an unaligned member and treating it as an aligned `T*` is invalid. Unaligned scalar loads are often supported on x86, with extra cost when they cross boundaries; stricter targets can require fixups or fault. Atomic alignment adds further rules (Chapter 25).

Packing can also spread the cost into callers. A compiler may generate bytewise loads or copy a packed member into aligned temporary storage before passing it by reference. Inspect generated code and measure the complete access path before trading alignment for density.

The same asserted layout discipline applies to an interprocess shared-memory ring: the record is mapped into two processes instead of received from a socket. Mapping mechanics belong in the Linux book in this series, and synchronization belongs in Part V.

**Pitfall.** A producer and consumer built from different struct revisions can agree on the C++ type name while disagreeing on every later offset. Version the protocol and keep size, alignment, property, and offset assertions beside the definition.

## Latency Lens

- Reordering `OrderWide` from 24 bytes to 16 packs more objects into each cache line, reducing bytes fetched by scans over hot arrays.
- Padding is dead weight that caches and prefetchers still move; explicit layout checks expose those unused bytes before deployment.
- EBO and `[[no_unique_address]]` can keep stateless comparators and allocators from increasing object size or forcing extra padding.
- Trivially copyable records can move through optimized block copies without per-element copy-constructor calls.
- Packed members can create unaligned loads; x86 pays most visibly on boundary splits, while stricter architectures may require fixups or fault.
- Disabling strict aliasing forfeits proofs that let a compiler hoist or reuse loads, so a legacy workaround can slow otherwise unrelated loops in the translation unit.
- `std::bit_cast` and fixed-size `std::memcpy` normally reduce to the same register transfer as an undefined pointer pun.
- Compilers map `std::byteswap` to a native byte-reversal instruction when the target provides one, making conversion cheaper than a hand-written byte loop.
- An asserted wire layout reduces parsing to bounded copying and byte swaps; it avoids per-field dispatch while rejecting incompatible ABI builds at compile time.
