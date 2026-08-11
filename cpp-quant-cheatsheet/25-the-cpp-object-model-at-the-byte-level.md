# 25. The C++ object model at the byte level

*Part IV — Memory, representation, and performance*

---

**Recall**
- An *object* is storage plus a type, an identity, and a lifetime; bytes alone are never an object.
- *Object representation* of `T` is the `sizeof(T)` `unsigned char` objects it occupies; *value representation* is the subset of bits that participate in the value.
- Padding bits/bytes are part of the object representation but carry no defined value — they may be unspecified even after value-initialization.
- Every typed access must independently satisfy four proofs: **bounds**, **alignment**, **live object of the required type**, **permitted access type**.
- Alignment being satisfied never implies lifetime; permitted aliasing never implies bounds — the proofs do not substitute for one another.
- Only `char`, `unsigned char`, and `std::byte` glvalues may inspect an arbitrary object's representation; every other unrelated type is UB.
- `memcmp == 0` is not value equality (padding, multiple representations, `-0.0`/`NaN`, pointers) and `memcmp != 0` is not inequality.
- `std::bit_cast<To>(from)` requires equal `sizeof` and both types trivially copyable, is `constexpr`, and returns a *value* — it creates no alias.
- `memcpy` requires non-overlapping ranges and trivially copyable types; `memmove` allows overlap; neither runs a constructor.
- `std::align` finds an aligned subregion and constructs nothing; `std::assume_aligned<N>` only *promises* an already-true fact and is UB if false.
- Hardware tolerating unaligned loads does not legalize a misaligned typed lvalue on the abstract machine.
- Pointer-interconvertibility is narrow: standard-layout object ↔ first member, union ↔ each member, plus transitivity — it never licenses walking to the second member.
- Layout-compatibility enables the common-initial-sequence union rule only; same-shaped unrelated structs are still mutually inaccessible.
- Reused storage yields a new object; use the pointer returned by `construct_at`/placement-new, and `std::launder` only where transparent replaceability fails (const/reference members, base subobject).
- Wire formats are byte encodings: explicit widths, explicit endianness, explicit bounds, explicit validation — never a `reinterpret_cast` overlay of received bytes.
- Packing is an implementation extension: it fixes neither endianness, nor lifetime, nor validation, nor ABI portability, and can hand you misaligned member pointers.
- `volatile` is an observable-access rule for MMIO, not atomicity and not synchronization; `volatile` increment is not an RMW.
- UB is not a runtime branch you can test after the fact — the optimizer assumes it never happens, so checks must precede the operation.
- *Erroneous behavior* is a C++26 category; in C++23, indeterminate-value reads are UB (except through `unsigned char`/`std::byte`).
- Legal byte code is usually just as fast: explicit `memcpy` + `byteswap` lowers to the same instructions as an illegal overlay.

---

## 25.1 Object representation, value representation, and padding bytes

```cpp
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <type_traits>

struct Quote {
    std::uint32_t id;     // offset 0, 4 bytes
    std::uint8_t  side;   // offset 4, 1 byte
    // 3 padding bytes at offsets 5..7 to satisfy alignof(Quote) == 4
};
static_assert(sizeof(Quote) == 8);
static_assert(alignof(Quote) == 4);
static_assert(offsetof(Quote, side) == 4);          // <cstddef>, standard-layout only

// Object representation = ALL sizeof(T) bytes, padding included.
auto bytes = std::bit_cast<std::array<std::byte, sizeof(Quote)>>(Quote{7, 1});

// Value representation = the bits that determine the value (id + side here).
Quote a{7, 1};
Quote b{7, 1};
bool value_equal = (a.id == b.id && a.side == b.side);   // correct
// bool byte_equal = std::memcmp(&a, &b, sizeof a) == 0; // NOT value equality
```

```cpp
// ---- how initialization touches padding ------------------------------
Quote u;              // automatic storage: members INDETERMINATE, reading them is UB
Quote v{};            // aggregate value-init: members zeroed; padding UNSPECIFIED
Quote w{7, 1};        // named members set; padding still unspecified
Quote z = {};         // same as v
static Quote s;       // static storage: zero-initialized INCLUDING padding bytes
auto  h = Quote{};    // value-initialized temporary

Quote scrub{};
std::memset(&scrub, 0, sizeof scrub);   // the portable way to define every byte
scrub.id = 7; scrub.side = 1;           // assignment MAY re-dirty padding (unspecified)
```

```cpp
// ---- unique object representations ------------------------------------
static_assert(std::has_unique_object_representations_v<std::uint32_t>);
static_assert(!std::has_unique_object_representations_v<Quote>);   // padding
static_assert(!std::has_unique_object_representations_v<float>);   // -0.0 == 0.0, NaNs

struct Packed { std::uint32_t id; std::uint32_t side; };            // no padding
static_assert(std::has_unique_object_representations_v<Packed>);
// True ⇒ equal values have equal bytes ⇒ byte hashing is well-defined LOCALLY.
// It does NOT imply endian stability, ABI stability, or semantic equality.
```

| Trait (`<type_traits>`) | True when | Byte-level licence granted |
|---|---|---|
| `is_trivially_copyable_v<T>` | trivial copy/move/assign/dtor, all non-deleted | `memcpy`/`bit_cast` of representation |
| `is_standard_layout_v<T>` | one access control, no virtuals, single-class data | `offsetof`, first-member interconvertibility |
| `is_trivial_v<T>` | trivially copyable **and** trivially default-constructible | above + no ctor work |
| `is_implicit_lifetime_v<T>` (C++23) | scalar, array, aggregate, or trivially-constructible+destructible class | implicitly created by `memcpy`/`malloc` |
| `has_unique_object_representations_v<T>` | trivially copyable, no padding, no equal-value alternatives | equal value ⇒ equal bytes |
| `alignment_of_v<T>` / `alignof(T)` | — | address suitability test |
| `is_layout_compatible_v<A,B>` (C++20) | same-value class/enum layout rules | common-initial-sequence union read |
| `is_pointer_interconvertible_base_of_v<B,D>` (C++20) | `B` shares address with `D` | `reinterpret_cast` between them |

**Traps** — `sizeof` includes trailing padding, so `memcmp` of two equal-valued structs may differ · zeroing bytes is not "default value" for every type (pointers, `bool`, floats, enums with narrow ranges) · assignment need not preserve or define padding · `offsetof` on non-standard-layout types is conditionally supported · never hash, persist, or MAC native object bytes just because all named fields were assigned.

---

## 25.2 Alignment, `std::align`, and `std::assume_aligned`

```cpp
#include <cstddef>
#include <memory>       // std::align, construct_at, destroy_at, assume_aligned

struct alignas(32) LevelBlock { std::uint64_t values[4]; };
static_assert(alignof(LevelBlock) == 32 && sizeof(LevelBlock) == 32);

alignas(64)            std::byte line[64];       // cache-line aligned
alignas(std::max_align_t) std::byte pool[256];   // fundamental alignment
struct Over { alignas(16) std::uint8_t b; };     // sizeof(Over) == 16: size is a multiple of align

static_assert(alignof(std::max_align_t) >= alignof(long double));
constexpr auto weak = __STDCPP_DEFAULT_NEW_ALIGNMENT__;  // over-aligned ⇒ aligned new
```

```cpp
// ---- getting suitably aligned storage --------------------------------
auto* p1 = new LevelBlock;                                  // aligned new (C++17)
auto* p2 = static_cast<LevelBlock*>(
    ::operator new(sizeof(LevelBlock), std::align_val_t{alignof(LevelBlock)}));
::operator delete(p2, std::align_val_t{alignof(LevelBlock)});  // MUST match
auto* p3 = std::aligned_alloc(32, 64);                      // C library: size % align == 0
std::free(p3);
delete p1;

alignas(LevelBlock) std::byte raw[sizeof(LevelBlock)];      // in-place storage
auto* obj = std::construct_at(reinterpret_cast<LevelBlock*>(raw));  // C++20
std::destroy_at(obj);
auto* obj2 = new (raw) LevelBlock{};                        // placement new, <new>
obj2->~LevelBlock();
```

```cpp
// ---- std::align: locate an aligned subregion (constructs NOTHING) -----
void* cursor    = pool;
std::size_t rem = sizeof pool;

if (void* place = std::align(alignof(LevelBlock), sizeof(LevelBlock), cursor, rem)) {
    // On success: place == cursor (advanced past skipped padding),
    //             rem reduced by the padding only — NOT by sizeof(LevelBlock).
    auto* blk = std::construct_at(static_cast<LevelBlock*>(place));
    cursor = static_cast<std::byte*>(cursor) + sizeof(LevelBlock);  // caller advances
    rem   -= sizeof(LevelBlock);
    std::destroy_at(blk);
}
// On failure: returns nullptr and leaves cursor/rem UNMODIFIED.
```

```cpp
// ---- promising alignment to the optimizer ----------------------------
template<std::size_t N, class T>
T* scale(T* p, std::size_t n) noexcept {
    T* q = std::assume_aligned<N>(p);        // C++20, <memory>; returns p
    for (std::size_t i = 0; i != n; ++i) q[i] *= T{2};   // vectorizable
    return q;
}
// assume_aligned neither aligns nor checks. A false promise is UB and licenses
// the optimizer to emit aligned-only SIMD that faults or silently corrupts.

// ---- manual alignment arithmetic -------------------------------------
constexpr std::uintptr_t align_up(std::uintptr_t x, std::size_t a) noexcept {
    return (x + a - 1) & ~(std::uintptr_t{a} - 1);        // a must be a power of two
}
bool aligned_for_u64 = (reinterpret_cast<std::uintptr_t>(pool) % alignof(std::uint64_t)) == 0;
```

```cpp
// ---- the misalignment trap -------------------------------------------
auto* bad = reinterpret_cast<LevelBlock*>(pool + 1);   // pointer value is unspecified
// bad->values[0] = 1;   // UB: misaligned typed lvalue, even on x86
std::memcpy(pool + 1, &someBlock, sizeof someBlock);   // legal: byte copy, no typed access
```

| Facility | Header | Effect | Notes |
|---|---|---|---|
| `alignof(T)` | core | required alignment | `alignof(T&)` == `alignof(T)` |
| `alignas(N)` / `alignas(T)` | core | raise alignment | cannot *lower* it; strictest declaration wins |
| `std::align(a, sz, ptr&, space&)` | `<memory>` | aligned subregion | returns `nullptr` on failure; mutates on success only |
| `std::assume_aligned<N>(p)` | `<memory>` | optimizer promise (C++20) | precondition, not a check; UB if false |
| `std::max_align_t` | `<cstddef>` | fundamental alignment | what plain `malloc`/`new` guarantee |
| `std::align_val_t` | `<new>` | over-aligned new/delete tag | allocation and deallocation must match |
| `std::aligned_alloc(a, sz)` | `<cstdlib>` | C11 aligned malloc | `sz % a == 0`; free with `free` |
| `std::aligned_storage` | `<type_traits>` | **deprecated in C++23** | use `alignas(T) std::byte[sizeof(T)]` |
| `std::hardware_destructive_interference_size` | `<new>` | false-sharing stride | C++17, implementation-defined |

**Traps** — `alignas` on a member also raises the class's alignment and its size · `sizeof(T) % alignof(T) == 0` always, so over-aligning a 1-byte type inflates arrays · mismatched sized/aligned `operator delete` is UB · `assume_aligned` "fixes" nothing and makes miscompiles worse · pointer arithmetic on `std::byte*` is fine, dereferencing as `T` is where alignment bites.

---

## 25.3 Aliasing, effective/dynamic type, and type-accessibility

```cpp
// The rule: an object's stored value may be accessed only through a glvalue of
// a permitted type. Otherwise UB — regardless of equal addresses.

float f = 1.0f;
// auto bits = *reinterpret_cast<std::uint32_t*>(&f);   // UB: unrelated access type
auto bits = std::bit_cast<std::uint32_t>(f);            // OK: representation copy
std::uint32_t back;
std::memcpy(&back, &f, sizeof f);                       // OK: byte copy
auto peek = static_cast<unsigned char const*>(static_cast<void const*>(&f))[0]; // OK
```

| Access `E` on object of dynamic type `T` | Permitted? |
|---|---|
| `T`, or cv-qualified `T` | yes |
| signed/unsigned variant of `T` (e.g. `int` ↔ `unsigned int`) | yes |
| base class of `T` (`B` for a `D` object) | yes |
| aggregate/union type having `T` among its elements/members | yes |
| `char`, `unsigned char`, `std::byte` | yes (representation inspection) |
| `signed char` | yes for `char`-family; **not** a general representation type in `std::byte`'s sense |
| unrelated class with identical layout | **no** |
| `float` ↔ `std::uint32_t` | **no** |
| `T*` viewed as `void*` then back to `T*` | yes (round-trip preserves value) |
| element of `T[]` viewed as `T` | yes |

```cpp
// ---- identical layout is still unrelated -----------------------------
struct Price    { std::int64_t value; };
struct Quantity { std::int64_t value; };
Price p{100};
// auto& q = reinterpret_cast<Quantity&>(p);   // UB on access
Quantity q{p.value};                           // just copy the field
```

```cpp
// ---- why the compiler cares -------------------------------------------
void update(int* a, float* b) noexcept {
    *a = 1;
    *b = 2.0f;          // compiler may assume this cannot change *a
    consume(*a);        // may be folded to consume(1)
}

void update2(int* a, int* b) noexcept {   // same type: overlap MUST be assumed
    *a = 1; *b = 2; consume(*a);          // reload required
}

// Non-standard escape hatches (toolchain contracts, not portable C++):
//   __restrict / __restrict__       — promise of no overlap
//   -fno-strict-aliasing            — disables the optimization, not the UB in general
//   __attribute__((may_alias))      — type may alias anything (GCC/Clang)
```

```cpp
// ---- unions: read the last written member ----------------------------
union Bits { float f; std::uint32_t u; };
Bits b; b.f = 1.0f;
// auto x = b.u;         // reading the non-active member: UB in C++ (legal in C)
auto x = std::bit_cast<std::uint32_t>(b.f);    // portable

// Common initial sequence: standard-layout struct members may be inspected
// through EITHER union member as long as they are layout-compatible prefixes.
struct A { std::uint32_t tag; std::uint32_t a; };
struct B { std::uint32_t tag; double b; };
union  M { A a; B b; };
M m; m.a = {1, 7};
auto tag = m.b.tag;      // OK: common initial sequence {uint32_t tag}
```

```cpp
// ---- dynamic type and derived-to-base ---------------------------------
struct Base { virtual ~Base() = default; int x; };
struct Derived : Base { int y; };
Derived d;
Base& rb = d;                                  // OK: base subobject access
auto* pd = dynamic_cast<Derived*>(&rb);        // checked downcast, needs polymorphic Base
auto* sd = static_cast<Derived*>(&rb);         // unchecked; UB if dynamic type isn't Derived
// reinterpret_cast<Derived*>(&rb);            // wrong: no base-offset adjustment
```

**Interview line** — "Strict aliasing is not a compiler switch; it is the type-accessibility rule, and `bit_cast`/`memcpy`/byte views are the three legal ways across it."

**Traps** — equal addresses prove nothing about legal access · `reinterpret_cast` is a pointer-value conversion, not permission to dereference · casting away `const` and writing to a genuinely const object is UB · `static_cast` down a hierarchy skips the check `dynamic_cast` performs · `-fno-strict-aliasing` fixes your build, not your code's portability.

---

## 25.4 `char`, `unsigned char`, and `std::byte` views

```cpp
#include <span>
#include <cstddef>
#include <memory>       // std::addressof

template<class T>
[[nodiscard]] std::span<std::byte const, sizeof(T)> object_bytes(T const& v) noexcept {
    static_assert(std::is_trivially_copyable_v<T>);
    return std::span<std::byte const, sizeof(T)>{
        reinterpret_cast<std::byte const*>(std::addressof(v)), sizeof(T)};
}

template<class T>
[[nodiscard]] std::span<std::byte, sizeof(T)> writable_bytes(T& v) noexcept {
    return std::span<std::byte, sizeof(T)>{
        reinterpret_cast<std::byte*>(std::addressof(v)), sizeof(T)};
}

// Ready-made in <span> (C++20): any contiguous range → byte span.
std::array<int, 4> arr{};
std::span<std::byte const> cb = std::as_bytes(std::span{arr});          // read-only
std::span<std::byte>       wb = std::as_writable_bytes(std::span{arr}); // writable
```

```cpp
// ---- std::byte is a distinct byte vocabulary (NOT arithmetic) --------
std::byte flag{0b0001'0000};      // list-init from an integer literal ONLY
flag |= std::byte{0b0000'0010};   // | & ^ ~ |= &= ^=
flag <<= 1;                       // << >> <<= >>=
// flag + 1;                      // ill-formed: no arithmetic
auto n  = std::to_integer<unsigned>(flag);       // explicit conversion out
auto bb = static_cast<std::byte>(0xFFu);         // explicit conversion in
// std::byte b = 5;               // ill-formed: scoped-enum, no implicit conversion
static_assert(sizeof(std::byte) == 1 && alignof(std::byte) == 1);
```

```cpp
// ---- hexdump: the canonical safe inspection --------------------------
void dump(std::span<std::byte const> bs) {
    for (std::byte b : bs)
        std::print("{:02x} ", std::to_integer<unsigned>(b));   // C++23 <print>
}
dump(object_bytes(Quote{7, 1}));   // includes 3 unspecified padding bytes
```

```cpp
// ---- writing representation bytes ------------------------------------
bool ready = false;
auto* rawp = reinterpret_cast<unsigned char*>(&ready);
*rawp = 2;                 // storing IS allowed…
// if (ready) {}           // …but reading a bool with an invalid representation is UB
std::uint32_t counter = 0;
writable_bytes(counter)[0] = std::byte{0xFF};   // every uint32 bit pattern is valid: OK
```

| Facility | Header | Purpose |
|---|---|---|
| `std::byte` | `<cstddef>` | `enum class byte : unsigned char`; bitwise ops only |
| `std::to_integer<IntT>(b)` | `<cstddef>` | `byte` → integer, explicit |
| `std::as_bytes(span)` | `<span>` | contiguous range → `span<const byte>` |
| `std::as_writable_bytes(span)` | `<span>` | requires non-const element type |
| `std::start_lifetime_as<T>(p)` | `<memory>` | C++23: begin an implicit-lifetime object's lifetime, no copy |
| `std::start_lifetime_as_array<T>(p, n)` | `<memory>` | C++23: array form |
| `std::addressof(x)` | `<memory>` | real address even with overloaded `operator&` |
| `std::memcpy/memmove/memset/memcmp/memchr` | `<cstring>` | raw byte primitives |

```cpp
// ---- C++23: adopting a buffer without copying ------------------------
struct Tick { std::uint32_t seq; std::uint32_t px; };   // implicit-lifetime type
void* buf = std::malloc(sizeof(Tick));
Tick* t = std::start_lifetime_as<Tick>(buf);   // C++23: no copy, no construction
t->seq = 1;                                    // now a live Tick exists here
// Requires: correct alignment + implicit-lifetime T. Values are whatever bytes held.
```

**Traps** — a byte span borrows: it dangles the moment the object dies, moves, or the vector reallocates · byte views expose padding, so never feed them to a hash/MAC/serializer · `std::byte` has no `operator+`, deliberately · writing bytes may create invalid representations for `bool`, enums, floats, pointers, and reading those back is UB · `signed char` reads of representation can sign-extend surprisingly — use `unsigned char`/`std::byte`.

---

## 25.5 Trivial copyability, `memcpy`, and serialization boundaries

```cpp
#include <cstring>
#include <bit>
#include <type_traits>

struct Snapshot {
    std::uint64_t sequence;
    std::int64_t  bid;
    std::int64_t  ask;
};
static_assert(std::is_trivially_copyable_v<Snapshot>);
static_assert(std::is_standard_layout_v<Snapshot>);

Snapshot src{9, 100, 102};
Snapshot dst{};
std::memcpy(&dst, &src, sizeof src);        // dst now holds src's value
std::memmove(&dst, &src, sizeof src);       // same, overlap-safe

unsigned char store[sizeof(Snapshot)];
std::memcpy(store, &src, sizeof src);       // save representation
Snapshot restored;
std::memcpy(&restored, store, sizeof store);// restore: guaranteed same value
```

| Function (`<cstring>`) | Contract | Notes |
|---|---|---|
| `memcpy(d, s, n)` | ranges must **not** overlap; both valid for `n` bytes | UB if `d`/`s` null even with `n == 0` |
| `memmove(d, s, n)` | overlap allowed (acts as if via a temp buffer) | same cost class on modern libc |
| `memset(d, c, n)` | fills with `(unsigned char)c` | not "default value" for non-trivial types |
| `memcmp(a, b, n)` | lexicographic on `unsigned char` | **not** value comparison |
| `memchr(p, c, n)` | first occurrence | returns `void*`/`const void*` |
| `std::bit_cast<To>(from)` (`<bit>`) | `sizeof(To)==sizeof(From)`, both trivially copyable | `constexpr`, no aliasing, by value |
| `std::byteswap(x)` (`<bit>`, C++23) | reverse bytes of an integer | no padding bits allowed in `T` |
| `std::start_lifetime_as<T>` (`<memory>`, C++23) | implicit-lifetime `T`, aligned | no copy, no ctor |

```cpp
// ---- bit_cast: every legal form ---------------------------------------
float px = 1.0f;
auto  u  = std::bit_cast<std::uint32_t>(px);            // 0x3F800000
auto  f2 = std::bit_cast<float>(u);                     // round-trips
constexpr auto k = std::bit_cast<std::uint32_t>(2.0f);  // constexpr-usable
auto  arr = std::bit_cast<std::array<std::byte, 8>>(std::uint64_t{1});
// std::bit_cast<double>(px);   // ill-formed: size mismatch
// std::bit_cast<std::string>(x); // ill-formed: not trivially copyable
// Still UB if the bits are not a valid value of To (e.g. an out-of-range enum).
```

```cpp
// ---- what memcpy is NOT ------------------------------------------------
struct Owner { std::unique_ptr<int> p; };
// std::memcpy(&a, &b, sizeof a);  // ill-formed intent: not trivially copyable → UB
Owner moved = std::move(other);    // the only correct "bitwise-looking" move

struct Node { Node* next; std::int64_t v; };   // trivially copyable…
// …but memcpy copies the POINTER, not the pointee: no deep ownership transfer.

struct Virt { virtual ~Virt(); };
// memcpy of a polymorphic object copies a vptr — never trivially copyable, always UB.
```

```cpp
// ---- serialization boundary: explicit, field-by-field ------------------
struct WireSnapshot {                          // logical schema, not a memory layout
    static constexpr std::size_t size = 8 + 8 + 8 + 2;   // seq, bid, ask, version
};

[[nodiscard]] bool decode(std::span<std::byte const> in, Snapshot& out,
                          std::uint16_t& version) noexcept {
    if (in.size() < WireSnapshot::size) return false;              // bounds
    version     = load_be_u16(in.subspan<0, 2>());
    if (version != 1) return false;                                // versioning
    out.sequence = load_be_u64(in.subspan<2, 8>());                // endian
    out.bid      = static_cast<std::int64_t>(load_be_u64(in.subspan<10, 8>()));
    out.ask      = static_cast<std::int64_t>(load_be_u64(in.subspan<18, 8>()));
    return out.bid <= out.ask;                                     // semantic validation
}
```

**What trivial copyability does *not* buy**

- a portable file/wire format (endianness, widths, padding, ABI all unspecified);
- value comparison via `memcmp`;
- deep copying of pointer or index-into-other-container members;
- freedom from padding leakage into logs, hashes, or the network;
- any validation of bytes from an untrusted source;
- exemption from class invariants a constructor would have enforced.

**Interview line** — "`memcpy` copies a representation; it does not copy ownership, run invariants, or define a format."

**Traps** — `memcpy(dst, src, sizeof dst)` when `dst` is a pointer copies 8 bytes · `sizeof` on a decayed array parameter is the pointer size · `memcpy` with overlapping ranges is UB even when it "works" · `memset(&obj, 0, sizeof obj)` on a non-trivial type destroys invariants silently · sending struct bytes cross-host leaks padding (an information-disclosure bug, not just a portability one).

---

## 25.6 Pointer-interconvertibility and layout-compatible types

```cpp
#include <type_traits>

struct Header {
    std::uint32_t type;    // first member
    std::uint32_t size;
};
static_assert(std::is_standard_layout_v<Header>);

Header h{1, 8};
auto* first = reinterpret_cast<std::uint32_t*>(&h);   // points to h.type — LEGAL
*first = 2;                                           // h.type == 2
auto* back = reinterpret_cast<Header*>(first);        // recovers &h — LEGAL
// first + 1;      // NOT a pointer into an array — arithmetic is UB
// first[1];       // UB: h is not a uint32_t[2]
```

**Pointer-interconvertible pairs (exhaustive)**

| Pair | Condition |
|---|---|
| object ↔ its first non-static data member | class is standard-layout, member is not a bit-field |
| object ↔ its first base class subobject | standard-layout, non-empty base at offset 0 |
| union object ↔ each non-static data member | always |
| `a` ↔ `c` | transitive through a common `b` |
| everything else | **not** interconvertible |

```cpp
// ---- C++20 introspection ----------------------------------------------
struct D : Header {};
static_assert(std::is_pointer_interconvertible_base_of_v<Header, D>);
constexpr bool same = std::is_pointer_interconvertible_with_class(&Header::type); // true
constexpr bool nope = std::is_pointer_interconvertible_with_class(&Header::size); // false
static_assert(std::is_corresponding_member(&A::tag, &B::tag));   // C++20, CIS check
```

```cpp
// ---- layout compatibility ---------------------------------------------
struct L1 { int a; char b; };
struct L2 { int x; char y; };            // same types, same order, both standard-layout
static_assert(std::is_layout_compatible_v<L1, L2>);          // C++20
// Grants: reading the common initial sequence through either UNION member.
// Does NOT grant: reinterpret_cast<L2&>(l1) access — still UB.
union U { L1 p; L2 q; };
U u; u.p = {1, 'x'};
int viaQ = u.q.x;                        // OK via common initial sequence
```

```cpp
// ---- lifetime reuse and std::launder ----------------------------------
struct X { const int n; };               // const member ⇒ NOT transparently replaceable

X x{1};
X* old = &x;
std::destroy_at(&x);
X* fresh = std::construct_at(&x, X{2});  // preferred: use the returned pointer
use(fresh->n);                           // 2 — always correct
// use(old->n);                          // UB: old still refers to the old object
use(std::launder(old)->n);               // legal but only ever a repair, never a plan

// Transparent replacement HOLDS (old pointers just work) when the new object:
//   - has the same type (ignoring cv) as the old,
//   - occupies exactly the same storage,
//   - is not a base subobject, and
//   - has no const-qualified or reference non-static data members (transitively).

// launder does NOT: create an object · fix alignment · legalize unrelated aliasing
//                 · extend lifetime · resurrect a pointer after storage is freed.
```

```cpp
// ---- reinterpret_cast value rules -------------------------------------
auto* v  = static_cast<void*>(&h);
auto* h2 = static_cast<Header*>(v);         // round-trip: same pointer value
auto  ip = reinterpret_cast<std::uintptr_t>(&h);
auto* h3 = reinterpret_cast<Header*>(ip);   // round-trip via uintptr_t: same value
auto* c  = reinterpret_cast<char*>(&h);     // always allowed to form and dereference
// Forming a T* is nearly always legal; DEREFERENCING needs the four proofs.
```

**Interview line** — "Same address is not the same as a live, legally accessible object of the target type."

**Traps** — a `[[no_unique_address]]` or empty first member breaks the offset-0 assumption you were relying on · adding a virtual function silently destroys standard-layout and interconvertibility · a bit-field first member is never interconvertible · `launder` in a hot loop is a design smell — encapsulate the storage instead · `is_layout_compatible_v` says nothing about aliasing permission.

---

## 25.7 Endianness-safe load/store helpers

> The production helper set — generic `load_be`/`store_be` over any unsigned width, the
> `if consteval` split between the byte-wise and `memcpy` paths, mixed-endian fallback, and
> signed/float field handling — is in [§34.3](/iprep/books/cpp-cheatsheet/34-wire-messages-and-binary-codecs/), with
> the bounds-checked cursor in [§34.5](/iprep/books/cpp-cheatsheet/34-wire-messages-and-binary-codecs/). What belongs
> *here* is why the two legal techniques are legal at all.

```cpp
#include <bit>
#include <span>
#include <cstring>

// ---- technique 1: byte-wise shifts — no object-model question at all ----
// Reading through `std::byte const*` is always permitted (25.4), the result is
// an integer computed from values, and alignment never enters the picture.
[[nodiscard]] constexpr std::uint32_t load_be_u32(std::span<std::byte const, 4> in) noexcept {
    return (std::to_integer<std::uint32_t>(in[0]) << 24)   // promote FIRST, then shift
         | (std::to_integer<std::uint32_t>(in[1]) << 16)
         | (std::to_integer<std::uint32_t>(in[2]) <<  8)
         |  std::to_integer<std::uint32_t>(in[3]);
}

// ---- technique 2: memcpy + byteswap — legal for a DIFFERENT reason ------
[[nodiscard]] std::uint32_t load_le_u32(std::span<std::byte const, 4> in) noexcept {
    std::uint32_t v;
    std::memcpy(&v, in.data(), sizeof v);   // creates an object in `v`; no aliasing
    if constexpr (std::endian::native == std::endian::big)   // violation, no alignment
        v = std::byteswap(v);                                // requirement on `in`
    return v;
}

// ---- what is NOT legal, and is the whole point of this section ----------
// std::uint32_t v = *reinterpret_cast<std::uint32_t const*>(in.data());
//   -> no uint32_t object exists at that address  (strict aliasing, 25.3)
//   -> the address may be unaligned               (25.2)
// Both are UB even where the hardware would have done exactly what you meant.
```

```cpp
// std::endian (C++20, <bit>) — note the third possibility
static_assert(std::endian::native == std::endian::little
           || std::endian::native == std::endian::big);   // mixed-endian: neither

// std::byteswap (C++23): integral T with no padding bits
static_assert(std::byteswap(std::uint32_t{0x11223344}) == 0x44332211u);
static_assert(std::byteswap(std::uint8_t{0x12}) == 0x12);

// Endianness is a property of the OBJECT REPRESENTATION (25.1), not of the value.
// `std::byteswap` permutes representation bytes; `std::bit_cast` reinterprets a
// whole representation as another type. Neither is a conversion of the value.
```

| Bit facility (`<bit>`) | Since | Meaning |
|---|---|---|
| `std::endian::native/little/big` | C++20 | scalar byte order (may be neither) |
| `std::byteswap(x)` | C++23 | reverse byte order of an integral |
| `std::bit_cast<To>(x)` | C++20 | equal-size trivially-copyable reinterpretation |
| `std::has_single_bit(x)` | C++20 | power-of-two test |
| `std::bit_ceil/bit_floor/bit_width(x)` | C++20 | rounding / significant bits |
| `std::rotl/rotr(x, s)` | C++20 | rotate |
| `std::countl_zero/countl_one/countr_zero/countr_one(x)` | C++20 | leading/trailing runs |
| `std::popcount(x)` | C++20 | set-bit count |

**Traps** — `htonl`/`ntohl` are POSIX, not portable C++, and only cover 16/32-bit · shifting an `unsigned char` promotes to `int`, so `b << 24` can overflow signed — cast to the target width first · `std::endian::native` may equal neither `little` nor `big` · `std::memcpy` is not `constexpr`, so a byte-wise path is still required for constant evaluation · fixed-extent `span` subscripting is unchecked; validate `size()` before `first<N>()` · never assume the wire matches `std::endian::native` "because it always has".

---

## 25.8 Packed structs, unaligned access, and ABI/compiler extensions

```cpp
// Packing is NOT standard C++. Illustration of both spellings:
#if defined(_MSC_VER)
#  pragma pack(push, 1)
struct WireHdr { std::uint8_t tag; std::uint32_t length; };   // sizeof == 5
#  pragma pack(pop)
#else
struct __attribute__((packed)) WireHdr { std::uint8_t tag; std::uint32_t length; };
#endif
// alignof(WireHdr) becomes 1, so &hdr.length may be MISALIGNED for uint32_t.
```

```cpp
// ---- the misaligned-member-pointer trap -------------------------------
WireHdr hdr{};
// std::uint32_t* bad = &hdr.length;   // GCC/Clang: -Waddress-of-packed-member
// *bad;                               // UB / SIGBUS on strict-alignment targets
std::uint32_t len;
std::memcpy(&len, &hdr.length, sizeof len);   // the legal read even from packed data
```

```cpp
// ---- the portable replacement: an explicit codec ----------------------
struct Hdr { std::uint8_t tag; std::uint32_t length; };   // natural layout in memory

inline constexpr std::size_t hdr_wire_size = 5;           // 1 + 4, on the wire

[[nodiscard]] bool decode_hdr(std::span<std::byte const> in, Hdr& out) noexcept {
    if (in.size() < hdr_wire_size) return false;
    out.tag    = std::to_integer<std::uint8_t>(in[0]);
    out.length = load_be_u32(in.subspan<1, 4>());
    return out.length <= max_message_bytes;               // validate before trusting
}

void encode_hdr(std::span<std::byte, hdr_wire_size> out, Hdr const& h) noexcept {
    out[0] = static_cast<std::byte>(h.tag);
    store_be_u32(out.subspan<1, 4>(), h.length);
}
// Same instruction count as the overlay on x86/ARM64, with none of the UB.
```

| Packing gives you | Packing does **not** give you |
|---|---|
| suppressed padding in *one* implementation | defined endianness |
| a smaller `sizeof` | a live object in received bytes |
| a layout matching one ABI | alignment safety for member pointers |
| — | length/field validation |
| — | versioning or forward compatibility |
| — | cross-compiler or cross-architecture stability |

```cpp
// ---- layout assertions when you must keep a packed/ABI type ----------
static_assert(sizeof(WireHdr) == 5);
static_assert(offsetof(WireHdr, length) == 1);
static_assert(alignof(WireHdr) == 1);
// Assert these on EVERY supported compiler/target in CI, not just the dev box.
```

**Traps** — a packed member passed to a function taking `T&` binds a misaligned reference · packed + `alignas` interactions are compiler-specific · packed members inside `std::atomic` or SIMD paths are pathological · `#pragma pack` leaking across a header include changes unrelated types' ABI · `-Wpacked`/`-Waddress-of-packed-member` warnings are load-bearing, not noise.

---

## 25.9 `volatile` is not synchronization

```cpp
// volatile = "this access is an observable side effect; do not elide, reorder
// with other volatile accesses, or fuse it." Nothing about threads.

volatile bool ready = false;
int payload = 0;

// Thread A: payload = 42; ready = true;     // no release: payload may not be visible
// Thread B: while (!ready) {} use(payload); // DATA RACE — UB
```

```cpp
// ---- the correct spellings --------------------------------------------
#include <atomic>
std::atomic<bool> ready_a{false};
int payload2 = 0;

void producer() { payload2 = 42; ready_a.store(true, std::memory_order_release); }
void consumer() {
    while (!ready_a.load(std::memory_order_acquire)) {}
    use(payload2);                       // ordered by release/acquire
}

std::atomic<int> counter{0};
counter.fetch_add(1, std::memory_order_relaxed);   // a real RMW

volatile int mmio_reg;
// mmio_reg++;   // load + store, two accesses, NOT atomic
```

| Property | `volatile` | `std::atomic` |
|---|---|---|
| Access is not elided/fused | yes | yes |
| Indivisible read-modify-write | **no** | yes (`fetch_*`, `exchange`, CAS) |
| Ordering vs *non*-volatile accesses | **no** | yes (per memory order) |
| Establishes happens-before | **no** | yes (release/acquire, seq_cst) |
| Prevents CPU reordering / emits fences | **no** | yes as required |
| Bypasses cache | **no** (never guaranteed) | no (coherence handles it) |
| Legitimate use | MMIO, `sig_atomic_t` handlers, setjmp locals | inter-thread communication |

```cpp
// ---- legitimate volatile ----------------------------------------------
struct DeviceRegs { volatile std::uint32_t status; volatile std::uint32_t control; };
auto* regs = reinterpret_cast<DeviceRegs*>(mapped_address);   // MMIO
while ((regs->status & 1u) == 0) {}    // each read really happens
regs->control = 0x3;                   // the write really happens

volatile std::sig_atomic_t quit = 0;   // signal-handler flag, single thread of control

// Benchmark trick: force the compiler to materialize a value.
template<class T> void do_not_optimize(T const& v) {
    asm volatile("" : : "r,m"(v) : "memory");   // GCC/Clang idiom
}
```

```cpp
// ---- C++20 deprecations -----------------------------------------------
volatile int x = 0;
// x++;            // deprecated in C++20: volatile compound/inc/dec
// int y = (x = 5); // deprecated: value of a volatile assignment expression
x = 5;             // fine
int y = x;         // fine
// volatile parameters and volatile return types: deprecated (C++20)
// std::atomic<T> has volatile-qualified overloads only when is_always_lock_free
```

**Interview line** — "`volatile` controls whether an access happens; `atomic` controls what other threads can observe about the accesses around it."

**Traps** — a `volatile` spin flag still races on the payload it "protects" · casting away `volatile` and accessing a genuinely volatile object non-volatilely is UB · `volatile std::vector<int>` does not compile meaningfully — the library is not volatile-aware · Java/C# `volatile` has acquire/release semantics, C++ `volatile` does not · `volatile` disables optimizations you paid for, so it is a poor "make it work" band-aid.

---

## 25.10 Undefined, unspecified, implementation-defined, and erroneous behavior

| Category | Standard's obligation | Diagnosable? | Examples |
|---|---|---|---|
| **Well-defined** | prescribes exact behavior | — | unsigned wraparound mod 2ⁿ, signed shift-left (C++20), two's complement (C++20) |
| **Implementation-defined** | one behavior, must be **documented** | no | `sizeof(int)`, `char` signedness, `std::endian::native`, alignment of `max_align_t` |
| **Unspecified** | one of several allowed, no documentation required | no | order of evaluation of unsequenced operands, addresses of distinct allocations, padding byte values |
| **Undefined (UB)** | no requirements at all | no (in general) | OOB access, data race, misaligned/wrong-type access, signed overflow, null deref, dangling read |
| **Ill-formed, diagnostic required** | must be diagnosed | yes | type/syntax errors, failed `static_assert`, failed constraints |
| **Ill-formed, NDR** | invalid, no diagnostic required | no | most ODR violations, bad template instantiation across TUs |
| **Erroneous behavior** | **C++26 only** — well-defined-but-wrong, implementation may diagnose | yes (may) | reading an uninitialized automatic variable (C++26) |

```cpp
// ---- UB is not a runtime branch ---------------------------------------
int double_positive(int x) { return x * 2; }        // signed overflow is UB

// WRONG: the check is after the UB and may be deleted entirely.
bool bad(int x) { int y = x * 2; return y > x; }

// RIGHT: check in a domain that cannot already overflow.
bool ok(int x) { return x <= std::numeric_limits<int>::max() / 2; }
auto [v, overflowed] = std::pair{0, __builtin_mul_overflow(x, 2, &v)};  // builtin form
unsigned uw = static_cast<unsigned>(x) * 2u;        // defined wraparound, then convert back
```

```cpp
// ---- indeterminate values in C++23 ------------------------------------
int u;                       // indeterminate
// int v = u;                // UB in C++23 (erroneous behavior only from C++26)
unsigned char b;             // indeterminate
unsigned char c = b;         // OK: unsigned char/std::byte copies are the carve-out
std::byte d;
std::byte e = d;             // OK

int init{};                  // just initialize; the cost is usually zero after inlining
[[indeterminate]] int fast;  // C++26 opt-out; NOT available in C++23
```

```cpp
// ---- the classic byte-level UB catalogue ------------------------------
// auto* h = reinterpret_cast<Header const*>(input.data());  // no live Header there
// *reinterpret_cast<std::uint32_t*>(&someFloat);            // wrong access type
// *reinterpret_cast<LevelBlock*>(pool + 1);                 // misaligned
// std::memcpy(&nonTrivial, &other, sizeof other);           // not trivially copyable
// std::memcmp(&a, &b, sizeof a) == 0                        // padding-sensitive
// arr[n]  /  &arr[n+1]                                      // one-past-end is the limit
// delete[] p; use(p);                                       // dangling
// p1 < p2 for unrelated allocations                         // unspecified/UB
```

```cpp
// ---- tools that make byte-level UB visible ----------------------------
// -fsanitize=address,undefined  -fsanitize=alignment,object-size
// -fsanitize=memory (uninitialized reads)  -Wall -Wextra -Wcast-align
// -D_GLIBCXX_ASSERTIONS  /  -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG
// valgrind --tool=memcheck   ·   -fno-strict-aliasing (diagnostic experiment only)
```

**Interview line** — "Erroneous behavior is C++26; in C++23 an uninitialized read is plain undefined behavior, with `unsigned char` and `std::byte` as the only carve-out."

**Byte-code review checklist**

1. Where did the storage come from, and what alignment does that source guarantee?
2. Which exact object is live at every typed access, and who ended its lifetime?
3. Is every pointer inside its object/array, with one-past-end formed but never dereferenced?
4. Is the glvalue type permitted to access that dynamic type?
5. Do overlapping copies use `memmove` rather than `memcpy`?
6. Is the type trivially copyable everywhere its representation is copied?
7. Can padding or an invalid representation be observed, hashed, or transmitted?
8. Is external encoding defined field-by-field with explicit width, endianness, and version?
9. Do all `span`/`string_view`/byte views die before their owners do?
10. Are compiler extensions (`packed`, `restrict`, `may_alias`) isolated, asserted, and tested on every supported ABI?

**Recall card**

```text
object representation  all sizeof(T) bytes, padding included
value representation   the bits that determine the value
padding                unspecified; never semantic data

typed access proof     bounds + alignment + live object of that type + permitted access type
byte access            char | unsigned char | std::byte  (only these)
memcpy                 non-overlapping, trivially copyable
memmove                overlap allowed
bit_cast               equal size + trivially copyable, constexpr, returns a value
start_lifetime_as      C++23: implicit-lifetime object from raw bytes, no copy
std::align             locate aligned subregion; constructs nothing
assume_aligned         optimizer promise; false promise is UB
launder                narrow replacement-object repair, never a design
interconvertible       std-layout ↔ first member; union ↔ any member; transitive

wire format            explicit width + endian + bounds + version + validation
packed struct          implementation extension, not a portable codec
volatile               observable access, not atomicity, not ordering
UB                     prevent before the operation; optimizer assumes it never occurs
erroneous behavior     C++26 category, not C++23
```

**Traps** — "it works on x86" is not a proof of any of the four obligations · a UB-based parser is not a faster C++ program, it is a program whose optimizer contract is already broken · sanitizers find *executed* UB only, so a clean run proves nothing about untaken branches · `-fno-strict-aliasing` makes one compiler agree with you today, not the standard.
