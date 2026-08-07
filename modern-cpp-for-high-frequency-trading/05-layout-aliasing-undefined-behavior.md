# Chapter 5 — Layout, Aliasing, and Undefined Behavior

Low-latency code often treats objects as bytes, places them in cache-conscious structures, and asks the optimizer to remove every redundant load. Those techniques are sound only when the program respects C++ object layout, alignment, lifetime, and aliasing rules. A layout that looks obvious in a debugger can still be nonportable; a cast that works in a debug build can make an optimized build meaningless. This chapter establishes what C++ actually guarantees, which properties belong to a particular ABI, and how to improve density without turning undefined behavior into an accidental dependency.

## 5.1 Standard-Layout and Trivial Types

A **standard-layout type** has a representation constrained enough for selected C-style layout operations. A **trivial type** is a scalar type, a trivial class, an array of such a type, or a cv-qualified version of one. A **trivially copyable type** may have its underlying bytes copied to and from byte arrays without changing its value, subject to the rules about potentially overlapping subobjects.

These properties overlap, but none implies all the others.

```cpp
#include <type_traits>

struct Quote {
    long price_ticks;
    int quantity;
};

struct Initialized {
    int value = 0;                 // nontrivial default construction
};

struct Polymorphic {
    virtual ~Polymorphic() = default;
    int value;
};

static_assert(std::is_standard_layout_v<Quote>);
static_assert(std::is_trivially_copyable_v<Quote>);
static_assert(std::is_trivially_copyable_v<Initialized>);
static_assert(!std::is_trivially_default_constructible_v<Initialized>);
static_assert(!std::is_standard_layout_v<Polymorphic>);
```

Standard layout is useful when interoperating with a documented C ABI or when `offsetof` is needed. It does not mean that padding disappears, that the byte order is fixed, or that a structure is a network wire format. Trivial copyability is the central property for copying an object representation with `std::memcpy` or `std::bit_cast`; it does not make arbitrary byte sequences valid values of the type.

The exact standard-layout rules cover bases, access control, non-static data members, virtual functions, and repeated base types. Do not memorize an informal approximation and then build a protocol around it. Ask the compiler:

```cpp
static_assert(std::is_standard_layout_v<Quote>);
static_assert(std::is_trivially_copyable_v<Quote>);
```

Those assertions verify the implementation compiling the program. They do not define a stable ABI across compilers, standard-library versions, flags, or architectures. A persistent or wire representation needs explicit field sizes, byte order, offsets, and versioning even when its in-memory helper type is standard-layout.

Standard-layout classes also support a pointer-interconvertibility guarantee between the complete object and its first non-static data member under the applicable rules. That narrow facility helps C interoperation, but it does not imply that every member can be reached by guessed offsets. Base subobjects, `[[no_unique_address]]`, and ABI padding make such arithmetic brittle. Prefer ordinary member access and confine any C boundary to a statically checked adapter.

Traits are especially useful in generic storage. A ring that copies slots with `memcpy` can reject unsuitable payloads with `static_assert(std::is_trivially_copyable_v<T>)`. A ring supporting arbitrary `T` must instead construct, move, destroy, and synchronize the object lifetime. The faster-looking byte copy is valid only when the payload contract permits it.

## 5.2 `sizeof`, `alignof`, `offsetof`, and Padding

`sizeof(T)` is the number of bytes occupied by a complete object of type `T`, including internal and trailing padding. `alignof(T)` is the alignment requirement for that type. Neither operator measures heap allocations referenced by the object.

```cpp
#include <cstddef>
#include <cstdint>

struct Event {
    std::uint8_t kind;       // offset 0
    std::uint64_t sequence;  // commonly offset 8
    std::uint16_t venue;     // commonly offset 16
};

static_assert(offsetof(Event, kind) == 0);
// The remaining values are implementation properties, not portable constants.
```

On a common 64-bit ABI, `Event` has seven padding bytes before `sequence` and six trailing bytes after `venue`, for a total size of 24 bytes. C++ does not require those particular offsets. It does require every array element to be properly aligned, so `sizeof(T)` is always a multiple of `alignof(T)` for an object type that can be used as an array element.

`offsetof(T, member)` is conditionally supported when `T` is not standard-layout. Restrict portable uses to standard-layout types. The result is an offset in bytes from the enclosing object, not a license to manufacture member pointers from unrelated storage.

Arrays and pointers reveal a frequent accounting error. `sizeof(events)` yields the complete byte size only while `events` is an array in that expression. After array-to-pointer conversion, `sizeof(pointer)` is only the pointer size. A parameter written as `Event events[100]` is adjusted to `Event*`; the bound is not carried into the function. Use `std::span<Event, 100>` when a fixed extent belongs in the contract.

Bit-fields may appear to pack flags efficiently, but their allocation order, allocation unit, and alignment are implementation-defined. An ordinary pointer cannot point to a bit-field, and neighboring fields may occupy one storage unit. A persistent protocol is clearer when it uses an explicitly sized integer and named masks.

Padding has direct capacity costs. One million 24-byte events occupy roughly 24 million bytes; a 16-byte representation occupies roughly 16 million. The denser representation fits more elements in every cache line and page and reduces memory bandwidth. Yet eliminating padding with a packed-layout extension can introduce misaligned loads, split cache-line accesses, or faults on architectures that reject some unaligned operations. Density and access cost must be evaluated together.

Packed attributes and pragmas are compiler extensions, not standard C++. They can also change the type's ABI when a header is included under different packing state. If an external binary format has packed fields, an explicit byte decoder usually gives the optimizer more freedom: it can use target-appropriate unaligned loads or copies while keeping the domain object naturally aligned.

`sizeof` is a compile-time constant for complete non-variable-length C++ types, but a compact type does not guarantee a compact allocation. Allocators round sizes into classes and store metadata; containers may reserve excess capacity. For a data structure, report live payload bytes, reserved capacity, and allocator-resident bytes separately.

Cache-line occupancy should likewise use the actual stride. A 24-byte element does not divide a common 64-byte line, so some elements cross line boundaries and a scan's line count depends on the array's starting alignment. Do not round “elements per line” down and stop there. Model several consecutive elements or measure the complete array.

Inspect layout rather than guessing:

```sh
clang++ -std=c++23 -Xclang -fdump-record-layouts -c event.cpp
g++ -std=c++23 -Wpadded -c event.cpp
```

Compiler diagnostics and layout dumps are implementation evidence. Keep `static_assert(sizeof(Event) == expected)` only at boundaries whose ABI is deliberately fixed, and qualify the supported targets.

## 5.3 Tail Padding and Object Footprint

**Tail padding** is unused storage between the last member and the end of an object. It normally makes the next array element correctly aligned.

```text
common 64-bit layout of Event

byte:  0       1.......7  8........15  16..17  18.....23
       kind    padding    sequence       venue   tail padding
```

For an array, the stride is exactly `sizeof(Event)`. Tail padding therefore consumes cache and memory bandwidth for every element:

```cpp
Event events[2];
auto* first  = reinterpret_cast<std::byte*>(&events[0]);
auto* second = reinterpret_cast<std::byte*>(&events[1]);
// second - first == sizeof(Event)
```

A common C++ ABI may reuse a base-class subobject's tail padding when laying out a derived object. The C++ language does not prescribe a universal derived-object layout, and ordinary array elements never overlap. Code must not hide application data in padding. Padding bytes can change when members are assigned, and their values may be indeterminate. Comparing entire structures with `std::memcmp` can consequently report inequality even when all member values compare equal.

Raw hashing has the same problem. Hashing `sizeof(T)` bytes includes padding, so equal values can hash differently and stale storage can leak into diagnostics. Hash members individually, or encode them into a fully initialized canonical byte representation. Zero-initializing an object can make one build more repeatable, but it does not create a cross-ABI format.

Object footprint includes more than `sizeof`. A `std::vector<Event>` object is commonly a small fixed-size handle, while its elements reside in a separate allocation. A polymorphic object may commonly include a hidden virtual-table pointer. An owning wrapper may refer to allocator metadata outside its object. Report both the inline representation and reachable allocations when analyzing memory.

For hot arrays, useful measurements include elements per cache line, pages in the working set, cache-miss rates, and bytes read per operation. `perf stat` can compare representations:

```sh
perf stat -e cycles,instructions,cache-references,cache-misses,dTLB-load-misses \
  ./layout_benchmark
```

The benchmark must perform equal logical work and use realistic access patterns. A sequential scan can favor both representations and conceal the latency of random page and cache misses.

## 5.4 Empty-Base Optimization and `[[no_unique_address]]`

An empty class still has nonzero size as a complete object so that distinct live objects of the same type can have distinct addresses. An implementation may, under the language rules, avoid allocating separate storage for an empty base subobject. This is commonly called the **empty-base optimization**.

```cpp
#include <cstddef>

struct StatelessDeleter {
    void operator()(int*) const noexcept {}
};

template<class T, class Deleter>
struct Handle : private Deleter {
    T* pointer;
};

static_assert(sizeof(Handle<int, StatelessDeleter>) >= sizeof(int*));
```

The assertion deliberately does not require equality. Equality is common when the empty-base optimization applies, but object size remains an implementation property.

C++20 introduced `[[no_unique_address]]`, which permits a non-static data member to overlap another member or tail padding when the address-identity rules permit it:

```cpp
template<class T, class Policy>
struct Field {
    [[no_unique_address]] Policy policy;
    T value;
};

struct NoCheck {};
static_assert(sizeof(Field<std::uint64_t, NoCheck>) >= sizeof(std::uint64_t));
```

The attribute is permission, not a size guarantee. Two subobjects of the same type may still require distinct addresses, and ABI choices affect layout. It also changes reasoning about member addresses: an annotated member may have the same address as another part of the object.

This facility is valuable for allocators, deleters, stateless comparators, and policy objects. It can make a zero-state abstraction consume zero additional bytes. It does not help a stateful policy, and proliferating distinct policy instantiations can increase code size even while reducing data size. Verify both:

```sh
g++ -std=c++23 -O2 -c policies.cpp
size policies.o
```

## 5.5 Member Ordering and Cache Density

The compiler inserts padding to satisfy each member's alignment while preserving the ordering constraints required by C++. Reordering members manually can reduce internal padding.

```cpp
#include <cstdint>

struct Sparse {
    std::uint8_t  side;
    std::uint64_t order_id;
    std::uint8_t  flags;
    std::uint32_t quantity;
};

struct Dense {
    std::uint64_t order_id;
    std::uint32_t quantity;
    std::uint8_t  side;
    std::uint8_t  flags;
};
```

On a common 64-bit layout, `Sparse` is larger than `Dense`. Grouping highly aligned members first often reduces padding, but smallest size is not always the best hot-path layout.

Member order also determines which fields share cache lines. If matching logic reads `price`, `quantity`, and `side` on every update but reads audit metadata only on rejection, put the hot fields together and consider moving cold metadata to a separate structure. A hot structure smaller than one line avoids fetching irrelevant bytes and can keep multiple orders in the same line.

Concurrency changes the answer. Placing two frequently written atomic counters next to each other may reduce size but force unrelated cores to exchange ownership of one cache line. Chapter 16 develops this false-sharing problem. A compact read-mostly quote and a deliberately padded inter-thread cursor serve different purposes.

Member order is observable through offsets and normally forms part of an ABI. Reordering fields in a public shared library, mapped file, or shared-memory record can break existing consumers. Treat it as an interface change unless the type is entirely private.

Field width matters as well. Narrow fields can save cache capacity but require extension, masking, or partial stores. Machine-word flags simplify some operations but waste space in large arrays. Choose widths from the value domain, then inspect loads and stores. A hot/cold split can make the critical record denser, but the cold lookup introduces another index or pointer and often another cache miss.

Measure representative operations, not size alone. Report `sizeof`, fields touched per operation, cache-line transfers, and page footprint. A useful layout review asks: which members are read together, which are written by different cores, and which are absent from the critical path?

## 5.6 Array of Structures Versus Structure of Arrays

An **array of structures** (AoS) stores all fields of one record together. A **structure of arrays** (SoA) stores each field in a separate contiguous array.

```cpp
#include <cstddef>
#include <cstdint>
#include <vector>

struct Level {
    std::int64_t price;
    std::int32_t quantity;
    std::uint32_t orders;
};

struct LevelsSoA {
    std::vector<std::int64_t> prices;
    std::vector<std::int32_t> quantities;
    std::vector<std::uint32_t> order_counts;
};

std::int64_t total_quantity(const LevelsSoA& levels) {
    std::int64_t sum = 0;
    for (std::int32_t q : levels.quantities) {
        sum += q;
    }
    return sum;
}
```

AoS favors operations that consume most fields of one record, such as sending a complete top-of-book snapshot. SoA favors operations that scan one or two fields across many records, such as summing quantities or comparing prices. SoA reduces bytes fetched for a narrow scan and often exposes simple, contiguous loops to vectorization.

The tradeoff is not merely theoretical:

| Property | AoS | SoA |
|---|---|---|
| Whole-record access | Naturally local | Multiple arrays touched |
| Single-field scan | Fetches unused fields | Dense field stream |
| SIMD | May require shuffles/gathers | Often straightforward |
| Record insertion | One object move | Coordinated moves in all arrays |
| Stable identity | One address if storage is stable | Needs index or handle |
| Allocation | One element allocation domain | Usually one per field array |

An SoA must preserve a cross-array invariant: index `i` names the same logical record in every array. Partial insertion or inconsistent resizing corrupts that invariant. Reserve all arrays before the hot path, update them as one operation, and use a single size authority.

Deletion policy deserves explicit design. Erasing index `i` from every vector is linear and shifts identities. Swapping the last record into `i` is constant work but changes an existing record's index. A free-index stack preserves bounded updates but introduces holes that scans must skip. An order book can often use a fixed price-to-index mapping; an order table may need stable handles with generation counters.

Hybrid layouts are common. An array-of-small-arrays can keep four or eight records in a SIMD-friendly block while retaining some record locality. The correct block size depends on the instruction set, access pattern, mutation pattern, and cache footprint. Use compiler vectorization reports and counters:

```sh
clang++ -std=c++23 -O3 -Rpass=loop-vectorize levels.cpp
perf stat -e cycles,instructions,cache-misses ./levels
```

Conversion between AoS and SoA is itself linear work and touches both representations. Performing that transpose on every market-data batch can erase the gain of a faster calculation. Keep the representation used by the dominant operation, or amortize conversion across enough downstream work. Also include tail handling when the record count is not a multiple of the SIMD block width.

## 5.7 `alignas`, Over-Alignment, and Interference Sizes

`alignas(N)` requests an alignment at least as strict as `N`, subject to the language's validity rules. A declaration cannot weaken a type's natural alignment.

```cpp
#include <atomic>
#include <cstddef>

struct alignas(64) Cursor {
    std::atomic<std::size_t> value{0};
};

static_assert(alignof(Cursor) >= 64);
```

Over-alignment can put independently written objects on different cache lines, align SIMD data, or meet a device/API requirement. It also introduces padding. An array of `Cursor` objects commonly has a stride of at least 64 bytes, even though the atomic payload may occupy only eight. That can be an excellent trade for producer and consumer cursors written by different cores and a poor trade for thousands of read-only counters.

C++17 provides `std::hardware_destructive_interference_size` and `std::hardware_constructive_interference_size` in `<new>`. They are implementation-supplied constants intended to guide separation and co-location. Availability and values vary by standard library and compilation target; they are not runtime discovery of the current CPU's cache-line size.

```cpp
#include <atomic>
#include <new>

struct QueuePositions {
    alignas(std::hardware_destructive_interference_size)
    std::atomic<unsigned> producer{0};

    alignas(std::hardware_destructive_interference_size)
    std::atomic<unsigned> consumer{0};
};
```

Dynamic allocation must preserve the required alignment. C++17 aligned `operator new` supports over-aligned types, and standard containers use an allocator capable of satisfying the element type's alignment when used correctly. Custom arenas must round each returned address and capacity themselves. A pointer into a byte buffer is not automatically aligned just because the buffer's first byte is aligned.

`std::align` can advance a pointer within raw storage while reducing the remaining capacity. C++20 `std::assume_aligned<N>(p)` does something different: it tells the optimizer that `p` is already aligned. If that promise is false, behavior is undefined. It is an assertion-backed optimization facility, not an aligning operation.

Verify addresses and coherence behavior on the target:

```cpp
auto address = reinterpret_cast<std::uintptr_t>(&object);
assert(address % alignof(decltype(object)) == 0);
```

Hardware counters related to cache-to-cache transfers are processor-specific. On supported systems, `perf c2c` can help identify contended lines. Alignment prevents a class of false sharing; it cannot remove true sharing of the same object.

## 5.8 Strict Aliasing

**Aliasing** occurs when two expressions designate overlapping storage. C++ restricts the types through which a stored value may be accessed. Violating those rules is undefined behavior even when the CPU instruction used for the access would succeed.

This familiar type pun is broken:

```cpp
// BROKEN: reading a float object through an unrelated uint32_t lvalue.
float value = 1.0f;
auto bits = *reinterpret_cast<std::uint32_t*>(&value);
```

The optimizer uses type-based alias analysis. If a function receives `float*` and `std::uint32_t*`, it can often assume that stores through one do not change the value observed through the other. A cast does not disable that assumption.

The language permits access through several related types, including the object's dynamic type, cv-qualified and corresponding signed or unsigned forms in specified cases, suitable aggregates or bases, and the designated character-like types discussed in Section 5.9. The complete rules contain details that matter. Prefer a representation operation with an explicit contract instead of reasoning from a cast.

Compiler options such as GCC and Clang's `-fno-strict-aliasing` change optimization assumptions for that build; they do not make all lifetime, alignment, or provenance errors valid C++. They also give up useful optimization globally. Likewise, `__restrict` is a nonstandard promise that selected pointers do not alias during their use. Breaking that promise can miscompile the program.

Lifetime and aliasing interact. Reusing storage for a different type does not justify accessing the new object through every pointer that once named the old object. Placement construction establishes the new lifetime; cached pointers, references, and `const` subobjects require the treatment described in Chapter 3. A union's common address similarly does not make all members simultaneously active.

The safe baseline is simple:

- use the declared type for ordinary access;
- use `std::bit_cast` for same-size value-preserving representation conversion;
- use `std::memcpy` when copying bytes between suitable objects;
- use `char`, `unsigned char`, or `std::byte` to inspect object representation;
- decode wire data field by field instead of casting a packet buffer to a structure.

Sanitizers catch some alignment and lifetime mistakes, but strict-aliasing violations are not comprehensively diagnosed. Compile at the intended optimization level and inspect warnings and generated code, but treat a clean run as evidence, not proof.

## 5.9 Character Access and `std::bit_cast`

C++ allows the object representation of any object to be examined through `char`, `unsigned char`, or `std::byte`. This is the foundation of serializers, hash functions, and byte-copy routines. `signed char` does not have this special permission in the C++ rule.

```cpp
#include <cstddef>
#include <cstdint>
#include <span>

template<class T>
std::span<const std::byte, sizeof(T)> bytes_of(const T& value) noexcept {
    return {reinterpret_cast<const std::byte*>(&value), sizeof(T)};
}
```

The bytes include padding. Reading them for diagnostics is different from assuming they form a canonical encoding. Padding and native byte order make the output unsuitable as a portable wire representation.

C++20 `std::bit_cast<To>(from)` returns a `To` whose representation corresponds to the source representation. Source and destination must have equal size and be trivially copyable.

```cpp
#include <bit>
#include <cstdint>

float value = 1.0f;
std::uint32_t bits = std::bit_cast<std::uint32_t>(value); // CORRECT
```

For suitable scalar types, GCC and Clang normally compile this to no runtime work: the value may simply be viewed in another register class. That is an implementation result enabled by correct semantics, not a promise that every `bit_cast` is free. Larger objects can require moves, and an invalid destination representation can still be problematic for types that do not admit every bit pattern.

Writing through a byte view modifies an existing object's representation, but it does not automatically solve lifetime or validity. Producing a trap or otherwise invalid representation and then reading the typed value is not safe. Constructing an object in raw storage also requires the lifetime rules from Chapter 3; byte access alone is not placement construction.

`std::bit_cast` converts a complete value; it is not a general packet decoder. A network structure can contain padding, use big-endian fields, and arrive unaligned. Even if its length equals `sizeof(LocalType)`, bit-casting all bytes couples the protocol to local padding and validity rules. Decode fixed-width integers, convert byte order, validate them, and construct a domain object.

For packet parsing, copy fixed-width fields into aligned integers, convert byte order, and validate ranges:

```cpp
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>

std::uint32_t load_be32(const std::byte* p) noexcept {
    std::uint32_t native;
    std::memcpy(&native, p, sizeof native);
    if constexpr (std::endian::native == std::endian::little) {
        native = std::byteswap(native); // C++23
    }
    return native;
}
```

Compilers commonly recognize the fixed-size `memcpy` and emit one unaligned load plus a byte-swap where the target permits it. Verify the target assembly instead of replacing the portable code with an invalid cast.

## 5.10 Pointer Arithmetic and One-Past-the-End

Built-in pointer arithmetic is defined within one array object. For this purpose, a non-array object behaves like an array of one element. A pointer may point at an element or exactly one position past the last element; the one-past pointer may be compared and subtracted within the array but not dereferenced.

```cpp
#include <cstddef>
#include <span>

long sum(std::span<const int> values) {
    const int* current = values.data();
    const int* end = current + values.size(); // one past
    long result = 0;
    while (current != end) {
        result += *current++;                 // never dereference end
    }
    return result;
}
```

Creating a pointer beyond the permitted range is already outside the arithmetic contract; returning it to range later does not repair the operation. Subtracting pointers is defined when both point into the same array object, including its one-past position, and the result must fit `std::ptrdiff_t`.

An allocated byte region is not automatically an array of every type that might fit inside it. Alignment and lifetime still govern typed access. Index calculations also need overflow checks before pointer addition. In a decoder, validate `length <= end - current` rather than computing `current + length <= end`, because the addition may itself leave the array or overflow the size calculation.

```cpp
bool consume(std::span<const std::byte>& input, std::size_t n) noexcept {
    if (n > input.size()) return false;
    input = input.subspan(n);
    return true;
}
```

Prefer an index or `std::span` when it keeps bounds explicit. These abstractions commonly optimize to the same pointer operations while making the valid range part of the interface.

Iterator invalidation is a higher-level version of the same issue. A pointer into `std::vector` belongs to its current allocation; reallocation ends the old elements' lifetimes and creates elements elsewhere. Equal contents do not keep old pointers valid. Reserving sufficient capacity before publishing views is both an allocation policy and a pointer-validity policy.

## 5.11 Alignment and Pointer Provenance

A typed pointer must satisfy the alignment required by its pointee when used for access. Reinterpreting an arbitrary byte address does not move the address or establish an object there.

```cpp
// BROKEN: p + 1 may not be aligned for uint64_t, and no uint64_t lifetime
// is established at that address.
std::uint64_t read_bad(const std::byte* p) {
    return *reinterpret_cast<const std::uint64_t*>(p + 1);
}
```

Some x86-64 instructions tolerate many unaligned scalar accesses, though crossing cache-line or page boundaries can cost more. ARM64 also supports many unaligned accesses but not every instruction or memory attribute does. The language contract is stricter than “my CPU happened to load it.” Use `memcpy` for potentially unaligned scalar data.

**Pointer provenance** describes the relationship between a pointer value and the storage from which it originates. The detailed standard model continues to evolve, but portable code should preserve that relationship: derive interior pointers from the owning object or array, do not use integer round trips to manufacture unrelated access rights, and do not expect equal numeric addresses from different object lifetimes to be interchangeable automatically.

Integer conversion is available for systems work through `std::uintptr_t` when the implementation provides it. A pointer converted to a sufficiently large integer and back to the same pointer type is subject to specified guarantees, but arithmetic on the integer does not provide the general semantics of array pointer arithmetic or start object lifetime.

Memory-mapped devices and shared-memory protocols add contracts outside C++. A mapping may provide an aligned numeric address yet require device-specific volatile accesses, process-shared atomics, or a cacheability mode. Conversely, `volatile` cannot repair misalignment or establish cross-thread synchronization. State separately what C++, the mapping API, and the hardware require.

Custom allocators must handle three independent requirements:

1. reserve enough bytes, including alignment padding;
2. choose an address satisfying `alignof(T)`;
3. begin `T`'s lifetime, normally with `std::construct_at`.

Check allocator code under alignment sanitization and with over-aligned test types. A pool that passes tests with eight-byte objects may fail immediately when given `alignas(64)` data.

## 5.12 Alias Information and Optimization

Correct non-alias information lets the compiler keep values in registers, eliminate repeated loads, reorder independent memory operations, and vectorize loops. Aliasing uncertainty forces conservative work.

```cpp
void add(float* output, const float* input, std::size_t n) {
    for (std::size_t i = 0; i < n; ++i) {
        output[i] += input[i];
    }
}
```

Because `output` and `input` may overlap, a compiler may need a runtime overlap check before selecting a vectorized loop. If the interface genuinely permits overlap, that check is useful and correct. If the application knows the arrays are separate, representing them as separate owned objects or using a compiler-specific restricted-pointer interface at a controlled boundary can expose the fact.

Copying a possibly aliased field to a local can also shorten the memory dependency:

```cpp
void apply_many(int* quantities, std::size_t n, const int& delta) {
    const int d = delta; // one load; subsequent stores cannot change d
    for (std::size_t i = 0; i < n; ++i) {
        quantities[i] += d;
    }
}
```

Without the local copy, `delta` could designate an element in `quantities`, so each store might change the next observed delta. The copy states the intended semantics and can enable a tighter loop.

`const` does not imply non-aliasing. A `const int&` prevents modification through that access path; another pointer can still modify the same object. Different static types sometimes provide non-alias conclusions, but abusing that rule by accessing an object through an unrelated type is undefined behavior, not an optimization annotation.

Use vectorization diagnostics to see what the compiler proved:

```sh
clang++ -std=c++23 -O3 -Rpass=loop-vectorize \
  -Rpass-missed=loop-vectorize -c alias.cpp
```

Then inspect assembly or benchmark. The goal is not “force vectorization”; it is “express truthful independence so the optimizer may choose well.”

Function boundaries can obscure alias facts. After inlining, the compiler may see that spans originate from separate allocations. Without visibility, it must honor the more general interface. A specialized no-alias hot path can make a real invariant explicit, but duplicating functions increases code size. First establish that a runtime overlap check or missed vectorization is material.

## 5.13 Undefined, Unspecified, and Implementation-Defined Behavior

The C++ specification uses several categories for behavior it does not fix. They have different engineering consequences.

| Category | What the implementation owes | Example | Engineering response |
|---|---|---|---|
| Undefined behavior | No requirements for that execution | Out-of-bounds access | Prevent it; tests cannot make it acceptable |
| Unspecified behavior | One of several allowed outcomes; documentation not required | Order of function-argument evaluation | Make correctness independent of the choice |
| Implementation-defined behavior | A choice that the implementation documents | Whether plain `char` is signed | Check target documentation or avoid dependence |

An **indeterminate value** has additional rules that vary with the value category and operation; it is not a fourth synonym for “whatever the machine contains.” Initialize data before typed use unless a narrowly specified byte-oriented operation permits otherwise.

Implementation-defined does not mean random per execution. For a fixed compiler and target, the documented choice can be a valid platform assumption. Record it with build constraints and assertions where practical. Unspecified behavior can vary between calls or builds, so an algorithm must accept every permitted result.

Manage portability at explicit boundaries. A component may deliberately require two's-complement integers, little-endian storage, and a named ABI if its build rejects other targets and external data is converted. Hidden assumptions are the dangerous case: a compiler upgrade or ARM64 port then changes several premises at once.

Record deliberate implementation choices in a build manifest and enforce cheap ones with `static_assert`, such as integer widths and required alignments. Runtime startup checks can cover page size or hardware facilities. An assertion cannot convert an implementation choice into a language guarantee, but it can turn an unsupported target into an immediate, diagnosable failure instead of silent corruption.

Undefined behavior is different. Once a reachable execution violates a rule, the standard places no constraints on that execution. It is incorrect to describe the result as merely a crash or a wrapped value. Debug behavior, generated instructions, and test history do not restore a contract.

Language UB must also be distinguished from operational nondeterminism. A cache miss, preemption, or dropped UDP packet can be undesirable but remains within a defined system model. Robust low-latency software handles those events. It cannot meaningfully “handle” UB after it occurs.

## 5.14 Data Races, Invalid Memory, Overflow, and Unsequenced Access

The most expensive undefined behavior is the kind that survives ordinary tests. Several families recur in performance-sensitive C++.

**Data races.** Two threads perform conflicting non-atomic accesses to the same memory location without a happens-before relationship, and at least one is a write. This is C++ undefined behavior, not merely a stale-read risk. `volatile` does not make the access atomic or synchronize threads. Chapter 14 develops the memory model.

**Invalid memory.** Use-after-free, dereferencing a null or one-past pointer, out-of-bounds access, and accessing an object outside its lifetime are undefined. A pool allocator can make use-after-free appear stable because bytes remain mapped; the lifetime violation still exists, and reuse makes the failure intermittent.

**Integer operations.** Signed integer overflow is generally undefined. Unsigned arithmetic wraps modulo (2^N), but a wrapped length can still lead to an invalid bounds decision. Division by zero is undefined. Shift counts must be nonnegative and less than the width of the promoted left operand; additional rules govern the shifted value.

Compiler builtins such as `__builtin_add_overflow` can report overflow without executing an overflowing signed expression. Another safe pattern widens to a proven-larger type, checks, then narrows. The widening must precede the operation: multiplying price by quantity in 32 bits and only then assigning to 64 bits is too late.

```cpp
// BROKEN: addition can wrap before the comparison.
bool fits_bad(std::size_t offset, std::size_t length, std::size_t size) {
    return offset + length <= size;
}

// CORRECT: subtraction occurs only after establishing offset <= size.
bool fits(std::size_t offset, std::size_t length, std::size_t size) {
    return offset <= size && length <= size - offset;
}
```

**Unsequenced conflicts.** If two evaluations that modify the same scalar, or one modification and one value computation of it, are unsequenced relative to each other, behavior is undefined. Do not compress state changes into clever expressions. Name intermediate results and make order explicit. Chapter 6 distinguishes unsequenced, indeterminately sequenced, and sequenced-before evaluations.

**Alignment and aliasing.** A misaligned typed access or access through an impermissible type is UB even if emitted hardware could complete the load.

Use multiple defenses. Warnings and static analysis catch suspicious constructs; AddressSanitizer catches many invalid accesses; UndefinedBehaviorSanitizer catches selected arithmetic, shift, alignment, and type errors; ThreadSanitizer detects many races. No tool proves absence, and sanitizer instrumentation changes timing and layout.

Run sanitizers in separate configurations because AddressSanitizer and ThreadSanitizer are not generally combined, and exercise error and recovery paths as well as normal flow. A checked debug build can also use bounds-aware containers and iterator diagnostics. Production performance should be measured without instrumentation, but the production source must remain the same well-defined program.

## 5.15 Why Optimizers Exploit Impossible Behavior

The optimizer must preserve the behavior of well-defined programs. It may therefore assume that undefined behavior never occurs in any execution it is required to preserve. This assumption enables transformations far from the line containing the defect.

Consider an overflow check written after a signed addition:

```cpp
bool increases(int x) {
    return x + 1 > x;
}
```

For every `int` value whose addition is defined, the result is true. The remaining case would overflow and has undefined behavior. An optimizer may compile the function as an unconditional `true`; it is not required to implement a hidden wraparound check.

A null check after dereference has the same structural problem:

```cpp
int read_then_check(const int* p) {
    int value = *p;       // defined execution implies p is valid here
    if (p == nullptr) {
        return 0;
    }
    return value;
}
```

The later check cannot protect the earlier access and may be removed. Similarly, an out-of-bounds loop can let the compiler infer that a supposedly terminating condition must occur, and a data race can let it reuse a register value instead of repeatedly loading shared memory.

Optimization often exposes UB; it does not create the underlying language defect. `-O0` may appear to work because it follows source structure more literally, but that behavior is neither portable nor stable. Disabling one optimization pass can hide a symptom while retaining the invalid program.

The as-if rule and UB assumptions reinforce each other. If no well-defined observer distinguishes two executions, the compiler may choose either realization. Invalid pointer access, overflow, and races are not observers that constrain the transformation. Source order alone therefore cannot rescue an operation the language has not made observable.

When comparing optimization levels, reduce the failure to a small case but keep the operation that exposes the defect. Compiler Explorer-style inspection can reveal the transformation, while a sanitizer can identify one invalid execution. Neither should be used to negotiate with the optimizer. The resolution is a source-level proof that every reachable operation is defined for every admitted input.

Keep that proof beside the invariant it depends on, so later refactoring does not silently invalidate the optimization's foundation.

Verify suspicious code in layers:

```sh
clang++ -std=c++23 -Wall -Wextra -Wconversion -O2 -c suspect.cpp
clang++ -std=c++23 -O1 -g -fsanitize=address,undefined suspect.cpp
clang++ -std=c++23 -O3 -S -masm=intel suspect.cpp
```

For arithmetic whose wrapping is intended, use an unsigned type or an explicit checked-arithmetic operation. For aliasing, use `bit_cast` or `memcpy`. For concurrency, use a proper ownership or synchronization protocol. Performance comes from giving the optimizer more truthful information, not from depending on executions the language refuses to describe.

## 5.16 Interview Check

1. Explain the differences among standard-layout, trivial, and trivially copyable types. Which property is relevant to `std::memcpy`, and which is relevant to portable `offsetof` use?
2. A structure shrinks from 24 bytes to 16 bytes after member reordering. Explain the possible cache and ABI effects, and describe a benchmark that would show whether the change helps.
3. Why is reading a `float` through a `std::uint32_t*` invalid, while `std::bit_cast<std::uint32_t>(value)` is valid? What code would you expect an optimizing compiler to emit?
4. Review a parser that checks `cursor + length <= end`. Under what conditions can the check itself be invalid, and how would you rewrite it?
5. Compare empty-base optimization with `[[no_unique_address]]`. Which parts are language permission, and which observed sizes are ABI choices?
6. Explain why `const T*` is not a non-aliasing promise. Give an example in which copying a referenced value to a local enables optimization.
7. Distinguish undefined, unspecified, and implementation-defined behavior using one performance-relevant example of each.
8. A lock-free queue works in debug builds but fails under `-O3`. List the lifetime, race, alignment, aliasing, and ordering evidence you would collect before blaming the compiler.
9. When would SoA improve an order-book calculation, and when would AoS be preferable? Include SIMD, allocation, mutation, and stable-identity considerations.
10. Why may an optimizer replace `x + 1 > x` with `true` for signed `int`? Show how to express intended modular or checked behavior instead.
