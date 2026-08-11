# 3. Fundamental types and representation

*Part I — Language foundations*

---

**Recall**
- Four distinct notions: *value* (the math), *value representation* (bits that carry it), *object representation* (all `sizeof(T)` bytes incl. padding), *wire representation* (protocol bytes — never inferred from native layout).
- `sizeof(char) == 1` by definition, but a byte is `CHAR_BIT` bits and `CHAR_BIT >= 8` — not necessarily 8.
- Plain `char`, `signed char`, and `unsigned char` are **three distinct types**; plain `char`'s signedness is implementation-defined.
- Signed integers are two's complement since C++20, yet signed overflow is still **undefined behavior**; unsigned arithmetic is defined modulo 2^N.
- Integral promotion runs *before* almost every arithmetic operator: `uint8_t + uint8_t` is `int`, not `uint8_t`.
- Mixed signed/unsigned comparison converts the signed operand to unsigned when the unsigned rank is ≥ — `-1 < v.size()` is usually `false`.
- `std::cmp_less`/`cmp_equal`/`in_range` (C++20) compare integers by mathematical value with no conversions.
- Exact-width `intN_t`/`uintN_t` are **optional**; `int_leastN_t`/`int_fastN_t` always exist; `int_fastN_t` may be much wider.
- `std::uint8_t` is normally an alias of `unsigned char`, so it streams as a character and inherits char-aliasing rules.
- `numeric_limits<T>::min()` is the smallest *positive normal* for floating types; use `lowest()` for the most negative finite.
- IEC 60559 is not guaranteed — query `numeric_limits<T>::is_iec559`; `long double` may be identical to `double`.
- NaN is unordered: `x != x` is true, and all of `<`, `>`, `==` are false against it — this breaks strict weak ordering in `sort`.
- `epsilon()` is the spacing at 1.0 only; a usable tolerance comes from the numerical problem, mixing absolute and relative terms.
- `alignas` may only strengthen alignment; over-alignment (e.g. 64 for false sharing) costs footprint and needs an aligned allocator.
- `sizeof(Record)` is storage, never a message length — padding, tail padding, and field order are ABI choices.
- `char8_t` (C++20) is a distinct unsigned type; `u8"…"` no longer converts to `const char*`.
- `std::string_view::size()` counts code units, not code points and not graphemes.
- `std::endian::native` (C++20) tells byte order; `std::byteswap` (C++23) reverses bytes but fixes nothing about bounds, alignment, aliasing, or lifetime.
- Scoped enums do not implicitly convert to integers; `std::to_underlying` (C++23) is the explicit escape hatch.
- Casting an out-of-range integer to an enum with a fixed underlying type is defined by that type's rules; with no fixed type, values outside the enum's bit-width range are UB — validate untrusted input.

**Selection map**

| Need | Choice | Qualification |
|---|---|---|
| Logical state | `bool` | object representation is not a wire boolean |
| Ordinary text character | `char` | signedness implementation-defined |
| Raw byte, no arithmetic | `std::byte` | enum-like; only bitwise ops + `to_integer` |
| Raw byte, arithmetic | `unsigned char` | no padding bits; may alias any object |
| Exactly N bits | `std::intN_t` | optional typedef |
| At least N bits | `std::int_leastN_t` | always present |
| Fastest ≥ N bits | `std::int_fastN_t` | may be wider → worse cache density |
| Object sizes / indices | `std::size_t` | unsigned — beware wrap on subtraction |
| Pointer differences | `std::ptrdiff_t` | valid only within one array object |
| Exact decimal prices | scaled integer wrapper | never binary floating point |
| Closed typed tag | `enum class : uintN_t` | no implicit integer conversion |

---

## 3.1 `bool`, character types, signed and unsigned integers

```cpp
#include <climits>
#include <cstdint>
#include <cstddef>

// ---- bool -------------------------------------------------------------
bool a = 7;                       // true  — any nonzero scalar converts to true
bool b = nullptr;                 // false — null pointer converts to false
bool c = 0.0;                     // false
bool d{1};                        // ok: 1 and 0 are not narrowing into bool
// bool e{2};                     // ill-formed: narrowing in list-init
int  n = true;                    // 1 — bool promotes to int as 0 or 1
static_assert(sizeof(bool) >= 1); // exact size implementation-defined
// Never memcpy a bool out to a protocol field: the byte pattern is not specified.

// ---- byte-level types --------------------------------------------------
std::byte raw{0xF0};                       // C++17, scoped-enum based
raw = raw | std::byte{0x0F};               // only &  |  ^  ~  <<  >> are defined
raw <<= 1;                                 // shift by integer, result is byte
auto v = std::to_integer<unsigned>(raw);   // explicit conversion out
// raw + 1;                                // ill-formed: no arithmetic on byte
unsigned char ub = 0xFFu;                  // arithmetic byte; may alias any object

// ---- the three char types are DISTINCT ---------------------------------
static_assert(!std::is_same_v<char, signed char>);
static_assert(!std::is_same_v<char, unsigned char>);
static_assert(sizeof(char) == 1 && sizeof(signed char) == 1 && sizeof(unsigned char) == 1);
static_assert(CHAR_BIT >= 8);              // 8 on every mainstream ABI, not guaranteed
char ch = '\xFF';                          // value is -1 OR 255 — implementation-defined
int  cls = std::isdigit(static_cast<unsigned char>(ch));  // MUST launder through unsigned char

// ---- integer families ---------------------------------------------------
signed char  sc;  short s;  int i;  long l;  long long ll;   // rank strictly increases
unsigned char uc; unsigned short us; unsigned u; unsigned long ul; unsigned long long ull;
// Each unsigned type has the same size and alignment as its signed counterpart.

// ---- literals and suffixes ----------------------------------------------
auto x1 = 42;         // int
auto x2 = 42u;        // unsigned int
auto x3 = 42L;        // long
auto x4 = 42uLL;      // unsigned long long
auto x5 = 42z;        // std::ptrdiff_t  (C++23)
auto x6 = 42uz;       // std::size_t     (C++23)
auto x7 = 0b1010'1010;// binary literal (C++14) + digit separators (C++14)
auto x8 = 0x1F;       // hex
auto x9 = 017;        // OCTAL = 15  — leading zero trap
auto xa = 1'000'000;  // separators are ignored by the compiler
```

| Type | Minimum guaranteed width | Typical LP64 (Linux/macOS) | Typical LLP64 (Windows) |
|---|---|---|---|
| `bool` | ≥ 1 byte | 1 | 1 |
| `char` / `signed char` / `unsigned char` | 1 byte, ≥ 8 bits | 1 | 1 |
| `short` | 16 bits | 2 | 2 |
| `int` | 16 bits | 4 | 4 |
| `long` | 32 bits | **8** | **4** |
| `long long` | 64 bits | 8 | 8 |
| `wchar_t` | impl-defined | 4 (UTF-32-ish) | 2 (UTF-16) |
| pointer | — | 8 | 8 |

| Character type | Since | Role |
|---|---|---|
| `char` | — | ordinary literal encoding, byte access |
| `signed char` | — | smallest signed integer type |
| `unsigned char` | — | object-representation inspection; no padding bits |
| `wchar_t` | — | implementation-defined wide encoding |
| `char8_t` | C++20 | UTF-8 code unit; distinct unsigned type |
| `char16_t` | C++11 | UTF-16 code unit |
| `char32_t` | C++11 | UTF-32 code unit |

```cpp
// ---- unsigned wraps, signed does not -----------------------------------
std::uint32_t u = 0;
--u;                                        // 0xFFFF'FFFF — DEFINED, modulo 2^32
int s = std::numeric_limits<int>::max();
// ++s;                                     // UB: signed overflow (optimizers exploit it)

// C++20 guarantees two's complement REPRESENTATION, not wrapping ARITHMETIC.
static_assert(std::numeric_limits<int>::min() == -std::numeric_limits<int>::max() - 1);
```

**Interview line** — "Two's complement is now mandated for signed *representation*, but signed *overflow* is still undefined; only unsigned arithmetic wraps."

**Traps** — `char` vs `signed char` vs `unsigned char` are three overload targets · `isalpha(ch)` with a negative `char` is UB · `017` is octal · `std::byte` has no `+` · `sizeof(bool)` is not 1 by guarantee · `CHAR_BIT` may exceed 8.

---

## 3.2 Floating-point types and IEC 60559 assumptions

```cpp
#include <limits>
#include <cfloat>
#include <cmath>

float f;  double d;  long double ld;      // nondecreasing rank/precision — NOT strictly increasing
static_assert(sizeof(long double) >= sizeof(double));   // may be EQUAL (MSVC: both 8 bytes)

// ---- literals ----------------------------------------------------------
auto a = 1.0;         // double
auto b = 1.0f;        // float
auto c = 1.0L;        // long double
auto e = 1e-9;        // double
auto h = 0x1.8p3;     // hexadecimal float literal = 12.0 (C++17) — exact, no decimal rounding
auto i = 1'000.5;     // digit separators allowed

// ---- is this IEEE 754? -------------------------------------------------
if constexpr (std::numeric_limits<double>::is_iec559) {
    // infinities, quiet NaNs, signed zero, and the documented rounding all apply
}
static_assert(std::numeric_limits<double>::is_specialized);
static_assert(std::numeric_limits<double>::is_signed);
static_assert(!std::numeric_limits<double>::is_exact);
static_assert(std::numeric_limits<double>::radix == 2);

// ---- special values -----------------------------------------------------
double inf   = std::numeric_limits<double>::infinity();      // check has_infinity first
double qnan  = std::numeric_limits<double>::quiet_NaN();
double snan  = std::numeric_limits<double>::signaling_NaN();
double denm  = std::numeric_limits<double>::denorm_min();    // smallest subnormal > 0
double negz  = -0.0;
bool same    = (negz == 0.0);                                // true — but bits differ
bool signbit = std::signbit(negz);                           // true — distinguishes -0.0

// ---- classification ------------------------------------------------------
int k = std::fpclassify(d);   // FP_ZERO | FP_SUBNORMAL | FP_NORMAL | FP_INFINITE | FP_NAN
std::isnan(d); std::isinf(d); std::isfinite(d); std::isnormal(d);
```

| `numeric_limits<T>` member | Meaning for floating `T` |
|---|---|
| `min()` | smallest **positive normal** value (not the most negative!) |
| `lowest()` | most negative finite value (C++11) |
| `max()` | largest finite value |
| `denorm_min()` | smallest positive subnormal |
| `epsilon()` | gap from 1.0 to the next representable value — *local to 1.0* |
| `digits` | significand bits (binary precision): 24 for `float`, 53 for `double` |
| `digits10` | decimal digits guaranteed to survive T → text → T: 6 / 15 |
| `max_digits10` | decimal digits needed to round-trip **any** value: 9 / 17 |
| `min_exponent` / `max_exponent` | radix-exponent bounds |
| `has_infinity` / `has_quiet_NaN` / `has_signaling_NaN` | capability flags |
| `is_iec559` | true iff IEC 60559 conformance is claimed |
| `round_style` | `round_to_nearest`, `round_toward_zero`, … |
| `traps` / `tinyness_before` | trapping and underflow-detection characterization |

| Format | Bits (S/E/M) | `digits` | `digits10` | `max_digits10` | `epsilon()` |
|---|---|---|---|---|---|
| `float` (binary32) | 1/8/23 | 24 | 6 | 9 | ≈1.19e-7 |
| `double` (binary64) | 1/11/52 | 53 | 15 | 17 | ≈2.22e-16 |
| x87 `long double` | 1/15/64 | 64 | 18 | 21 | ≈1.08e-19 |

```cpp
// ---- fixed-width float aliases (C++23, <stdfloat>) ----------------------
#include <stdfloat>
std::float16_t  h16{};   // optional
std::float32_t  f32{};   // optional, IEC 60559 binary32
std::float64_t  f64{};   // optional
std::float128_t f128{};  // optional
std::bfloat16_t bf{};    // optional, brain float
```

> **Quant rule** — use a scaled integer domain type for exact tick/quantity arithmetic; `double` is for models whose error budget you have actually accepted.

**Traps** — `min()` is positive · `long double` may equal `double` · `is_iec559` false disables every NaN/inf assumption · `epsilon()` is not a tolerance · `-ffast-math` silently deletes NaN/inf handling.

---

## 3.3 `void`, `std::nullptr_t`, and `nullptr`

```cpp
// ---- void ---------------------------------------------------------------
void record();                        // no return value
void ignore(void);                    // C-style empty parameter list (legal, redundant)
// void v;                            // ill-formed: incomplete type, no objects
// void& r = ...;                     // ill-formed: no references to void
// void a[4];                         // ill-formed: no arrays of void
// sizeof(void);                      // ill-formed in standard C++ (GNU ext: 1)
void f() { return record(); }         // legal: returning a void expression from void

// ---- void* --------------------------------------------------------------
Object obj;
void* erased  = static_cast<void*>(&obj);        // implicit too: void* p = &obj;
auto* back    = static_cast<Object*>(erased);    // valid only if it came from an Object*
void const* cp = &obj;                           // cv qualifiers must be preserved
// Object* q = erased;                           // ill-formed in C++ (legal in C)
// void* fp = &f;                                // NOT portable: function ptr ⇄ void* is conditional
auto* fnp = reinterpret_cast<void(*)()>(&f);     // function-pointer casts go via function types

// ---- nullptr / std::nullptr_t -------------------------------------------
#include <cstddef>
std::nullptr_t np = nullptr;          // prvalue of its own type
int*         ip = nullptr;            // converts to any object pointer
int Object::*mp = nullptr;            // ... and any pointer-to-member
bool truth = static_cast<bool>(np);   // false; contextual conversion only (explicit)
// int k = nullptr;                   // ill-formed: no conversion to integer

void select(int);
void select(void*);
select(0);            // calls select(int)   — 0 is an integer literal
select(NULL);         // AMBIGUOUS or int    — NULL may be an integer literal
select(nullptr);      // calls select(void*) — unambiguous

template<class T> void g(T);
g(nullptr);           // T deduced as std::nullptr_t, NOT as a pointer type

// nullptr_t comparisons
static_assert(nullptr == nullptr);
auto ord = (nullptr <=> nullptr);     // std::strong_ordering::equal
```

| Facility | Rule |
|---|---|
| `void` | incomplete, never completed; no objects, references, arrays, or `sizeof` |
| `void*` | holds any *object* pointer; round-trips exactly; not dereferenceable |
| `void*` ↔ function pointer | **conditionally supported**, not portable |
| `nullptr` | prvalue of `std::nullptr_t`; converts to any pointer / pointer-to-member |
| `NULL` | macro, may be `0` — breaks overload resolution and template deduction |
| `(void)expr` | idiomatic discard, e.g. silencing `[[nodiscard]]` |

**Interview line** — "`nullptr` has a type, so it survives overload resolution and template deduction; `NULL` is an integer in disguise."

**Traps** — `void*` erases the destructor, so deleting through it is UB · `delete static_cast<T*>(p)` needs the *exact* original type · deducing `nullptr` gives `nullptr_t`, so forwarding it to a pointer parameter needs an explicit cast.

---

## 3.4 Object size, alignment, padding, and `sizeof` / `alignof`

```cpp
// ---- sizeof forms --------------------------------------------------------
sizeof(int);            // type form needs parentheses
sizeof x;               // expression form does not — operand is UNEVALUATED
sizeof(Record);         // complete type required
std::size_t n = sizeof buffer / sizeof buffer[0];   // C array element count
sizeof...(Ts);          // pack size (C++11)
// sizeof(void); sizeof(f); sizeof(Incomplete);     // all ill-formed

int calls();
auto sz = sizeof(calls());   // calls() is NEVER invoked — unevaluated operand

// ---- alignof / alignas ---------------------------------------------------
alignof(double);                        // alignment requirement, type std::size_t
alignof(Record);                        // == max member alignment (typical ABI)
static_assert(alignof(std::max_align_t) >= alignof(long double));

struct alignas(64) Counter { std::uint64_t value{}; };   // over-aligned: sizeof == 64
static_assert(alignof(Counter) == 64 && sizeof(Counter) == 64);  // size is a multiple of align

alignas(16) unsigned char storage[64];  // over-align an object
struct Weak { alignas(2) char c; };     // may only STRENGTHEN: alignas(1) on int is ill-formed

// ---- padding ------------------------------------------------------------
struct Record {              // typical x86-64 layout, NOT guaranteed
    std::uint8_t  tag;       // offset 0
    // 3 bytes padding
    std::uint32_t sequence;  // offset 4
    std::uint16_t size;      // offset 8
    // 2 bytes tail padding so alignof(4) holds for the next array element
};                           // sizeof == 12, alignof == 4
static_assert(sizeof(Record) >= 7);

struct Packed {              // reordered widest-first: sizeof == 8
    std::uint32_t sequence;
    std::uint16_t size;
    std::uint8_t  tag;
    std::uint8_t  flags;
};
```

```text
Record (typical):  [tag][pad][pad][pad][  sequence 4B  ][size 2B][pad][pad]
offset:             0                4                  8            10  12
```

```cpp
// ---- introspection --------------------------------------------------------
#include <cstddef>
static_assert(offsetof(Record, sequence) == 4);   // standard-layout types only
static_assert(std::is_standard_layout_v<Record>);
static_assert(std::has_unique_object_representations_v<Packed>);  // C++17: no padding, no -0.0
// ^ the ONE trait that licenses hashing/comparing the raw object bytes

// ---- empty types and [[no_unique_address]] --------------------------------
struct Empty {};
static_assert(sizeof(Empty) == 1);        // complete objects have nonzero size
struct WithEbo : Empty { int x; };
static_assert(sizeof(WithEbo) == sizeof(int));    // empty base optimization
struct WithNua { [[no_unique_address]] Empty e; int x; };   // C++20
static_assert(sizeof(WithNua) == sizeof(int));    // potentially-overlapping subobject
```

| Rule | Statement |
|---|---|
| `sizeof(char)` | exactly 1, by definition |
| Complete object size | always ≥ 1, even for empty classes |
| Arrays | `sizeof(T[N]) == N * sizeof(T)` — no inter-element padding |
| `sizeof` operand | unevaluated; no side effects, no ODR-use |
| Padding bytes | value is unspecified; may be clobbered by any member write |
| `alignas` | may only strengthen; must be a valid alignment (power of 2) |
| Over-aligned `new` | C++17 routes `alignof(T) > __STDCPP_DEFAULT_NEW_ALIGNMENT__` to aligned `operator new` |
| Distinct objects | have distinct addresses, except potentially-overlapping subobjects |

**Traps** — `sizeof(Record)` is **not** a message length · member order changes size and ABI · `offsetof` on non-standard-layout is conditionally supported · `alignas(64)` assumes a 64-byte cache line (`std::hardware_destructive_interference_size` names it, C++17) · over-aligned types need `aligned_alloc`/aligned `operator new`, not `malloc`.

---

## 3.5 Numeric limits and fixed-width/fast integer types

```cpp
#include <cstdint>
#include <limits>

// ---- exact / least / fast ------------------------------------------------
std::int8_t   e8;    std::uint8_t   u8;     // EXACT width — optional typedefs
std::int32_t  e32;   std::uint32_t  u32;    // present on all mainstream ABIs
std::int64_t  e64;   std::uint64_t  u64;
std::int_least16_t  l16;                    // narrowest type with ≥16 bits — ALWAYS present
std::int_fast32_t   f32;                    // fastest with ≥32 bits — often 64 bits on LP64!
std::intmax_t       imax;  std::uintmax_t umax;   // widest standard integer types
std::intptr_t       ip;    std::uintptr_t up;     // optional; round-trips a void*
std::size_t         sz;    std::ptrdiff_t pd;     // <cstddef>

// ---- limits queries -------------------------------------------------------
constexpr auto max_orders = std::numeric_limits<std::uint32_t>::max();     // 4294967295
constexpr auto min_i64    = std::numeric_limits<std::int64_t>::min();
static_assert(std::numeric_limits<std::int64_t>::digits == 63);            // value bits, no sign
static_assert(std::numeric_limits<std::uint64_t>::digits == 64);
static_assert(std::numeric_limits<int>::is_signed);
static_assert(std::numeric_limits<unsigned>::is_modulo);                   // wraps by contract

// ---- macro constants (<cstdint>) -----------------------------------------
INT32_MAX; INT32_MIN; UINT32_MAX; SIZE_MAX; PTRDIFF_MAX; INTMAX_MAX;
auto big  = INT64_C(9'000'000'000);      // literal of type int64_t
auto ubig = UINT64_C(18'000'000'000);
```

| Family | Contract | Interview note |
|---|---|---|
| `intN_t` / `uintN_t` | exactly N value bits, two's complement, no padding | **optional** — absent on exotic ABIs |
| `int_leastN_t` | narrowest provided type with ≥ N bits | always present |
| `int_fastN_t` | implementation's "fastest" with ≥ N bits | may be 8 bytes for `int_fast8_t` → kills cache density |
| `intmax_t` / `uintmax_t` | widest standard integer | not necessarily widest *extended* integer |
| `intptr_t` / `uintptr_t` | optional; `void*` round-trip | not for pointer arithmetic |
| `size_t` | can hold any `sizeof` result | unsigned → subtraction wraps |
| `ptrdiff_t` | signed pointer difference | valid only within one array |

```cpp
// ---- uint8_t is (almost always) unsigned char ----------------------------
std::uint8_t code = 65;
std::cout << code;      // prints 'A'  — streams as a character
std::cout << +code;     // prints 65   — unary + promotes to int
std::cout << static_cast<int>(code);   // explicit and clearer
static_assert(std::is_same_v<std::uint8_t, unsigned char>);   // true on mainstream ABIs

// ---- <bit> integer utilities (C++20) -------------------------------------
#include <bit>
std::bit_width(9u);        // 4   — bits needed to represent 9
std::bit_ceil(9u);         // 16  — smallest power of 2 >= 9 (UB if it overflows)
std::bit_floor(9u);        // 8
std::has_single_bit(8u);   // true
std::countl_zero(1u);      // 31
std::countl_one(~0u);      // 32
std::countr_zero(8u);      // 3
std::countr_one(7u);       // 3
std::popcount(7u);         // 3
std::rotl(0x80000001u, 1); // 0x00000003
std::rotr(0x00000003u, 1); // 0x80000001
auto asu = std::bit_cast<std::uint64_t>(3.14);   // C++20: safe type-punning, same size, trivially copyable

// ---- <charconv>: locale-free, allocation-free conversion -----------------
#include <charconv>
char buf[32];
auto [ptr, ec] = std::to_chars(buf, buf + sizeof buf, 12345);          // ec == std::errc{}
std::int64_t out{};
auto r = std::from_chars(buf, ptr, out);                               // r.ptr, r.ec
auto rh = std::from_chars(buf, ptr, out, 16);                          // base 16
double dv{};
std::from_chars(buf, ptr, dv, std::chars_format::general);             // no locale, correctly rounded
```

**Traps** — exact-width types are optional so `intN_t` in a public header is a portability claim · `int_fast8_t` is 8 bytes on glibc/LP64 · `uint8_t` prints as a char · `size_t` in a serialized struct changes width across ABIs · `bit_cast` requires equal sizes and trivially copyable types.

---

## 3.6 Integer ranges, promotions, usual arithmetic conversions, and wraparound

```cpp
// ---- step 1: INTEGRAL PROMOTION (applies to nearly every operator) -------
// bool, char, signed char, unsigned char, short, unsigned short, char8_t,
// char16_t, char32_t, wchar_t, and unscoped enums promote to `int` if int can
// represent every value; otherwise to `unsigned int`.
std::uint8_t a = 250, b = 10;
auto sum = a + b;                          // int, value 260 — NOT uint8_t, NOT 4
static_assert(std::is_same_v<decltype(a + b), int>);
static_assert(std::is_same_v<decltype(+a), int>);     // unary + forces promotion
static_assert(std::is_same_v<decltype(~a), int>);     // ~ promotes too: ~uint8_t(0) == -1
std::uint8_t narrowed = static_cast<std::uint8_t>(a + b);   // 4 — explicit truncation

// ---- step 2: USUAL ARITHMETIC CONVERSIONS (binary ops, after promotion) --
// 1. same signedness           -> higher rank wins
// 2. unsigned rank >= signed   -> the UNSIGNED type wins
// 3. signed can represent all unsigned values -> the SIGNED type wins
// 4. otherwise                 -> unsigned counterpart of the signed type
static_assert(std::is_same_v<decltype(1 + 1L),  long>);                   // rule 1
static_assert(std::is_same_v<decltype(1 + 1u),  unsigned>);               // rule 2
static_assert(std::is_same_v<decltype(1L + 1u), long>);                   // rule 3 on LP64
static_assert(std::is_same_v<decltype(1 + 1.0f), float>);                 // any float wins
```

| Relationship after promotion | Common type |
|---|---|
| same signedness | greater conversion rank |
| different signedness, unsigned rank ≥ signed rank | the **unsigned** type |
| signed type represents every unsigned value | the **signed** type |
| otherwise | unsigned counterpart of the signed type |

```cpp
// ---- the classic mixed-sign bug ------------------------------------------
int remaining = -1;
std::size_t available = 4;
bool surprising = remaining < available;   // FALSE: -1 -> 18446744073709551615

for (std::size_t i = v.size() - 1; i >= 0; --i) {}   // INFINITE LOOP + wrap when empty
for (std::size_t i = v.size(); i-- > 0;) {}          // correct reverse idiom
for (auto i = std::ssize(v) - 1; i >= 0; --i) {}     // C++20 signed size

// ---- C++20 safe integer comparison (<utility>) ---------------------------
#include <utility>
std::cmp_less(remaining, available);            // TRUE — compares mathematical values
std::cmp_less_equal(-1, 0u);  std::cmp_greater(-1, 0u);
std::cmp_equal(-1, std::numeric_limits<unsigned>::max());   // false (== is true without it!)
std::in_range<std::uint8_t>(300);               // false — value fits in target type?
std::in_range<std::size_t>(-1);                 // false

// ---- C++26 preview: checked arithmetic ------------------------------------
// std::add_sat / sub_sat / mul_sat / div_sat, std::saturate_cast  (C++26 <numeric>)
```

| Operation | Rule |
|---|---|
| unsigned `+ - *` | defined, modulo 2^N |
| signed overflow | **undefined behavior** |
| `/` or `%` by zero | UB (integer); `0.0/0.0` is NaN for IEC 60559 floats |
| `INT_MIN / -1`, `INT_MIN % -1` | UB — quotient unrepresentable |
| narrowing integer conversion | to unsigned: modulo; to signed: value-preserving if representable, else impl-defined (C++20: modulo) |
| `x << n` | UB if `n < 0` or `n >= width`; UB for signed `x < 0`; for signed `x >= 0`, UB if result unrepresentable |
| `x >> n` | UB if `n < 0` or `n >= width`; arithmetic (sign-filling) for negative signed since C++20 |
| `-x` where `x == INT_MIN` | UB |
| `std::abs(INT_MIN)` | UB |

```cpp
// ---- rearrange to avoid overflow -----------------------------------------
// BAD: header_size + payload_size may wrap before the comparison.
if (header_size + payload_size > capacity) reject();
// GOOD: prove header_size <= capacity first, then subtract.
if (header_size > capacity || payload_size > capacity - header_size) reject();

// ---- portable checked arithmetic ------------------------------------------
bool add_overflow(std::int64_t x, std::int64_t y, std::int64_t& out) noexcept {
    if (__builtin_add_overflow(x, y, &out)) return true;   // gcc/clang; MSVC: <intrin.h>
    return false;
}
// Portable fallback: do the arithmetic in the unsigned counterpart, then bit_cast back.
std::int64_t wrap_add(std::int64_t x, std::int64_t y) noexcept {
    return static_cast<std::int64_t>(static_cast<std::uint64_t>(x) + static_cast<std::uint64_t>(y));
}

// ---- shift hygiene ---------------------------------------------------------
std::uint32_t mask = (std::uint32_t{1} << 31);        // OK: unsigned, in range
// std::uint32_t bad = 1 << 31;                       // int 1 << 31 is UB (signed overflow)
// auto also_bad = x << 32;                           // UB: shift >= width
```

**Interview line** — "`-1 < v.size()` is false because the usual arithmetic conversions turn `-1` into a huge `size_t`; `std::cmp_less` compares values instead of representations."

**Traps** — casts that "fix" a signed/unsigned warning usually hide a missing precondition · `size() - 1` on an empty container is `SIZE_MAX` · `~uint8_t` is `int` · `1 << 31` on `int` is UB · unsigned counters make `<` in a loop wrap silently.

---

## 3.7 Floating-point precision, rounding, NaNs, infinities, and comparison hazards

```cpp
// ---- binary representation is not decimal --------------------------------
double x = 0.1 + 0.2;
bool exact = (x == 0.3);                  // FALSE: 0.30000000000000004
static_assert(0.5 + 0.25 == 0.75);        // exact: dyadic rationals are exact

// ---- NaN is unordered -----------------------------------------------------
double q = std::numeric_limits<double>::quiet_NaN();
assert(q != q);                           // the canonical NaN test
assert(!(q <  0.0));
assert(!(q >  0.0));
assert(!(q == 0.0));
assert(!(q >= q));
// => a comparator using `<` with NaNs present is NOT a strict weak ordering:
//    std::sort may then read out of bounds. Reject or canonicalize NaN first.

// ---- infinities ------------------------------------------------------------
double inf = 1.0 / 0.0;                   // +inf under IEC 60559 (UB if !is_iec559)
double nan = 0.0 / 0.0;                   // NaN
assert(inf > std::numeric_limits<double>::max());
assert(std::isinf(inf) && !std::isfinite(inf));

// ---- non-associativity ------------------------------------------------------
double big = 1e16, one = 1.0;
bool assoc = ((big + one) - big) == (big + (one - big));   // false — order matters
// Consequence: parallel/vectorized reductions give different sums than serial ones.
```

```cpp
// ---- tolerance: never a bare epsilon ---------------------------------------
bool nearly_equal(double a, double b, double abs_tol, double rel_tol) noexcept {
    if (std::isnan(a) || std::isnan(b)) return false;        // decide explicitly
    if (a == b) return true;                                 // handles inf == inf
    double diff = std::abs(a - b);
    return diff <= std::max(abs_tol, rel_tol * std::max(std::abs(a), std::abs(b)));
}
// abs_tol covers values near zero; rel_tol covers large magnitudes.
// Both tolerances must come from the numerical problem, not from epsilon().

// ---- ULP-based comparison (IEC 60559, same sign) ---------------------------
bool within_ulps(double a, double b, int ulps) noexcept {
    if (std::signbit(a) != std::signbit(b)) return a == b;    // handles ±0.0
    auto ia = std::bit_cast<std::int64_t>(a), ib = std::bit_cast<std::int64_t>(b);
    return std::abs(ia - ib) <= ulps;
}

// ---- total order when you must sort with NaNs ------------------------------
// std::strong_order(a, b) — IEC 60559 totalOrder: -NaN < -inf < ... < +inf < +NaN
auto ord = std::strong_order(0.0, -0.0);   // greater: distinguishes signed zeros
std::ranges::sort(v, [](double a, double b) { return std::strong_order(a, b) < 0; });
```

```cpp
// ---- rounding ----------------------------------------------------------------
#include <cfenv>
std::fesetround(FE_TONEAREST);   // FE_DOWNWARD, FE_UPWARD, FE_TOWARDZERO
// #pragma STDC FENV_ACCESS ON   // required, and poorly supported — do not rely on it
std::nearbyint(2.5);   // 2.0 under round-to-nearest-EVEN (banker's rounding)
std::round(2.5);       // 3.0 — always away from zero, ignores the rounding mode
std::trunc(-2.7);      // -2.0
std::floor(-2.7);      // -3.0
std::ceil(-2.7);       // -2.0
std::llround(2.5);     // 3   — integral result
std::fma(a, b, c);     // a*b+c with ONE rounding — may differ from a*b+c
std::remainder(5.0, 3.0);  // -1.0 (IEC 60559)   vs std::fmod(5.0,3.0) == 2.0

// ---- exact round-trip printing -------------------------------------------
std::cout << std::setprecision(std::numeric_limits<double>::max_digits10) << x;  // 17 digits
char buf[32];
std::to_chars(buf, buf + sizeof buf, x);                     // shortest round-trip form
std::to_chars(buf, buf + sizeof buf, x, std::chars_format::fixed, 6);
std::format("{:.17g}", x);                                    // C++20
```

| Hazard | Effect |
|---|---|
| `-ffast-math` / `/fp:fast` | assumes finite math, enables reassociation — NaN/inf tests may be deleted |
| FMA contraction | `a*b+c` fused into one rounding; results differ from the unfused form |
| x87 excess precision | intermediates evaluated at 80 bits then rounded (32-bit x86) |
| Subnormal flush-to-zero | MXCSR FTZ/DAZ bits change results *and* remove the slow path |
| Different libm versions | transcendental functions are not bit-identical across platforms |

**Interview line** — "Reproducible floating point is a claim about compiler, flags, hardware, libm, and evaluation order — not about the type `double`."

**Traps** — `==` on computed doubles · `epsilon()` as a global tolerance · sorting with NaN present · accumulating in `float` (use `double` or Kahan/Neumaier) · `printf("%f")` truncating to 6 digits · storing money in `double`.

---

## 3.8 Character encodings, `char8_t`, Unicode code units, and string literal prefixes

```cpp
// ---- literal prefixes -----------------------------------------------------
auto s0 = "ABC";        // const char[4]     — ordinary literal encoding
auto s1 = u8"ABC";      // const char8_t[4]  — UTF-8      (C++20 changed the type)
auto s2 = u"ABC";       // const char16_t[4] — UTF-16
auto s3 = U"ABC";       // const char32_t[4] — UTF-32
auto s4 = L"ABC";       // const wchar_t[4]  — impl-defined wide encoding
auto s5 = R"(raw\no escapes)";           // const char[…] — raw string
auto s6 = u8R"delim(raw + utf8 "quotes")delim";
auto s7 = "abc" "def";                   // adjacent concatenation → "abcdef"

// ---- character literals ---------------------------------------------------
char      c0 = 'a';     char8_t  c1 = u8'a';   // u8 char literal (C++17)
char16_t  c2 = u'é';   char32_t c3 = U'\U0001F600';   // emoji needs char32_t
wchar_t   c4 = L'a';
int       c5 = 'ab';    // multicharacter literal: type int, value impl-defined — avoid
char      c6 = '\x41';  // hex escape       char c7 = '\101';  // octal escape

// ---- standard library string / view types ---------------------------------
std::string      a;  std::string_view      av;    // char
std::u8string    b;  std::u8string_view    bv;    // char8_t  (C++20)
std::u16string   c;  std::u16string_view   cv;
std::u32string   d;  std::u32string_view   dv;
std::wstring     e;  std::wstring_view     ev;

// ---- char8_t is a DISTINCT type -------------------------------------------
// const char* p = u8"x";                     // ill-formed since C++20
auto* p = reinterpret_cast<char const*>(u8"x");           // explicit, well-defined (char aliases)
std::string s{reinterpret_cast<char const*>(u8"market")};

// ---- suffixes -------------------------------------------------------------
using namespace std::literals;
auto sv  = "abc"sv;      // std::string_view
auto str = "abc"s;       // std::string
auto u8s = u8"abc"sv;    // std::u8string_view
```

| Prefix | Element type | Encoding |
|---|---|---|
| *(none)* | `const char[N]` | ordinary literal encoding (UTF-8 on most modern toolchains) |
| `u8` | `const char8_t[N]` (C++20; was `char`) | UTF-8 code units |
| `u` | `const char16_t[N]` | UTF-16 code units |
| `U` | `const char32_t[N]` | UTF-32 code units — one unit = one code point |
| `L` | `const wchar_t[N]` | implementation-defined wide encoding |
| `R"(…)"` | unchanged element type | no escape processing; combinable: `u8R"(…)"` |

```cpp
// ---- size() counts CODE UNITS ---------------------------------------------
std::string_view s = "héllo";        // 'é' is 2 UTF-8 code units
s.size();                             // 6 bytes, NOT 5 characters
std::u32string_view t = U"héllo";
t.size();                             // 5 code points — still not graphemes
// "é" as U+0065 U+0301 is 2 code points but ONE grapheme cluster.
// The standard library counts code units; it does not normalize, validate,
// case-fold correctly for all locales, or segment graphemes.

// ---- decoding UTF-8 by hand (lead-byte lengths) ---------------------------
constexpr int utf8_len(unsigned char b) noexcept {
    if (b < 0x80) return 1;            // 0xxxxxxx        U+0000 .. U+007F
    if ((b & 0xE0) == 0xC0) return 2;  // 110xxxxx        U+0080 .. U+07FF
    if ((b & 0xF0) == 0xE0) return 3;  // 1110xxxx        U+0800 .. U+FFFF
    if ((b & 0xF8) == 0xF0) return 4;  // 11110xxx        U+10000.. U+10FFFF
    return 0;                          // 10xxxxxx continuation, or invalid
}
// UTF-16: code points above U+FFFF use a surrogate pair (0xD800-0xDBFF, 0xDC00-0xDFFF).
```

| Boundary | Independent choice |
|---|---|
| Source file encoding | how the compiler reads your `.cpp` |
| Ordinary/wide literal encoding | `-fexec-charset`, `/execution-charset` |
| Runtime locale | `std::setlocale`, affects `<cctype>`, `iostream` formatting |
| OS filesystem encoding | `std::filesystem::path::value_type` (`wchar_t` on Windows) |
| Terminal encoding | independent of all of the above |
| Protocol encoding | specified by the protocol — always convert explicitly |

**Traps** — `u8"x"` no longer converts to `const char*` (C++20 break) · `strlen` counts bytes · `toupper` is locale- and byte-based, not Unicode · `wchar_t` is 2 bytes on Windows and 4 on POSIX · `char` may be signed, so `s[i] > 0x7F` fails · no standard Unicode normalization or grapheme segmentation (use ICU).

---

## 3.9 Endianness with `std::endian` and byte swapping with `std::byteswap`

```cpp
#include <bit>
#include <span>
#include <cstring>

// ---- std::endian (C++20) ---------------------------------------------------
enum class endian { little = /*…*/, big = /*…*/, native = /*little|big|other*/ };
if constexpr (std::endian::native == std::endian::little) { /* x86-64, ARM (usual) */ }
if constexpr (std::endian::native == std::endian::big)    { /* network order */ }
// native == neither  =>  mixed-endian; both branches must be handled or static_assert'd
static_assert(std::endian::native == std::endian::little ||
              std::endian::native == std::endian::big, "mixed-endian unsupported");

// ---- std::byteswap (C++23) --------------------------------------------------
constexpr std::uint32_t wire = 0x01020304u;
static_assert(std::byteswap(wire) == 0x04030201u);   // constexpr, integral types only
static_assert(std::byteswap(std::uint16_t{0x00FF}) == std::uint16_t{0xFF00});
static_assert(std::byteswap(std::uint8_t{0x12}) == std::uint8_t{0x12});   // identity
// byteswap(T) requires an integral T with no padding bits; it compiles to bswap/rev.

template<std::integral T>
constexpr T to_big(T v) noexcept {
    if constexpr (std::endian::native == std::endian::big) return v;
    else return std::byteswap(v);
}
```

```cpp
// ---- SAFE big-endian load: no alignment, no aliasing, no lifetime issue ----
std::uint32_t load_be_u32(std::span<std::byte const, 4> s) noexcept {
    return (std::to_integer<std::uint32_t>(s[0]) << 24)
         | (std::to_integer<std::uint32_t>(s[1]) << 16)
         | (std::to_integer<std::uint32_t>(s[2]) <<  8)
         |  std::to_integer<std::uint32_t>(s[3]);
}
std::uint32_t load_le_u32(std::span<std::byte const, 4> s) noexcept {
    return  std::to_integer<std::uint32_t>(s[0])
         | (std::to_integer<std::uint32_t>(s[1]) <<  8)
         | (std::to_integer<std::uint32_t>(s[2]) << 16)
         | (std::to_integer<std::uint32_t>(s[3]) << 24);
}
void store_be_u32(std::span<std::byte, 4> s, std::uint32_t v) noexcept {
    s[0] = static_cast<std::byte>(v >> 24);
    s[1] = static_cast<std::byte>(v >> 16);
    s[2] = static_cast<std::byte>(v >>  8);
    s[3] = static_cast<std::byte>(v);
}

// ---- equally safe: memcpy + conditional swap (compiles to one mov) ---------
template<std::integral T>
T load_be(std::byte const* p) noexcept {          // caller must have bounds-checked
    T v{};
    std::memcpy(&v, p, sizeof v);                 // creates the object, no aliasing UB
    if constexpr (std::endian::native == std::endian::little) v = std::byteswap(v);
    return v;
}

// ---- floats go through bit_cast, never through byteswap directly -----------
double load_be_f64(std::byte const* p) noexcept {
    return std::bit_cast<double>(load_be<std::uint64_t>(p));
}

// ---- THE WRONG WAY ----------------------------------------------------------
// auto v = *reinterpret_cast<std::uint32_t const*>(bytes);
//   ✗ alignment: bytes may not be 4-aligned (UB even on x86)
//   ✗ aliasing:  no uint32_t object lives there (strict-aliasing UB)
//   ✗ lifetime:  reading an object that was never begun
//   ✗ endianness: still unhandled
// std::start_lifetime_as<T>(p) (C++23) fixes lifetime ONLY — alignment and
// endianness remain your problem.
```

| Facility | Header | Since | Note |
|---|---|---|---|
| `std::endian` | `<bit>` | C++20 | `little`, `big`, `native`; `other` if mixed |
| `std::byteswap` | `<bit>` | C++23 | `constexpr`; integral only; no padding bits allowed |
| `std::bit_cast` | `<bit>` | C++20 | `constexpr`; equal sizes; trivially copyable |
| `std::start_lifetime_as` | `<memory>` | C++23 | implicit-lifetime types; still needs correct alignment |
| `htonl` / `ntohl` | `<arpa/inet.h>` | POSIX | 16/32-bit only, non-constexpr, not portable to Windows headers |

**Interview line** — "`byteswap` reorders bytes of a value you already legally hold; it says nothing about how you obtained it — bounds, alignment, aliasing, and lifetime are separate obligations."

**Traps** — endianness is per-scalar, not per-struct: padding and field order still differ · bitfield layout is entirely implementation-defined · `__attribute__((packed))` yields unaligned member access · network order is big-endian but many exchange protocols (ITCH/OUCH is big, SBE/FIX-binary is little) are not.

---

## 3.10 Enums, scoped enums, underlying types, and `std::to_underlying`

```cpp
// ---- every declaration form -------------------------------------------------
enum Legacy { legacy_bid, legacy_ask };                 // unscoped, no fixed type
enum Flags : std::uint8_t { none = 0, live = 1, iceberg = 2 };  // unscoped, FIXED type (C++11)
enum class Side : std::uint8_t { bid = 0, ask = 1 };    // scoped + fixed
enum struct Action { add, cancel, replace };            // `struct` == `class` here; underlying int
enum class Status;                                      // forward declaration: OK (default int)
enum Fwd : int;                                         // unscoped fwd decl needs a fixed type
// enum Bad;                                            // ill-formed: no fixed underlying type

// ---- scope and lookup --------------------------------------------------------
auto l = legacy_bid;             // unscoped: enumerator leaks into the enclosing scope
auto l2 = Legacy::legacy_bid;    // also allowed (C++11) — prefer this spelling
auto s = Side::bid;              // scoped: qualification REQUIRED
using enum Side;                 // C++20: bring all enumerators into scope
auto s2 = bid;                   // now unqualified
using Side::ask;                 // C++20: single enumerator

// ---- conversions ---------------------------------------------------------------
int  li = legacy_bid;                          // implicit — unscoped promotes to int
// int si = Side::bid;                         // ill-formed — scoped never converts implicitly
int  si = static_cast<int>(Side::bid);         // explicit
auto ui = std::to_underlying(Side::ask);       // C++23 → std::uint8_t, no width guessing
auto ui2 = static_cast<std::underlying_type_t<Side>>(Side::ask);   // pre-C++23 spelling
Side back = static_cast<Side>(1);              // integer → enum

// ---- direct-list-init from an integer (C++17) ---------------------------------
Side ok{1};        // OK for a FIXED underlying type, and only if 1 fits
// Side bad{7};    // ill-formed: 7 is not representable... (still allowed if it fits uint8_t)
// Legacy nope{1}; // ill-formed: no fixed underlying type

// ---- comparisons ----------------------------------------------------------------
bool eq = (Side::bid == Side::bid);            // OK — same enum type
// bool x = (Side::bid == Action::add);        // ill-formed — different scoped enums
// bool y = (Side::bid < 1);                   // ill-formed — no implicit conversion
bool z = (legacy_bid < legacy_ask);            // OK — unscoped both promote to int
```

| Property | Unscoped `enum` | Scoped `enum class` |
|---|---|---|
| Enumerator scope | enclosing scope (+ enum scope since C++11) | enum scope only |
| Implicit → integer | **yes** (integral promotion) | **no** |
| Implicit ← integer | no (both need `static_cast`) | no |
| Default underlying type | implementation-chosen type able to hold all values | `int` |
| Fixed underlying type | optional (`enum E : T`) | optional (`enum class E : T`), defaults to `int` |
| Forward declaration | only with a fixed underlying type | always |
| `using enum` (C++20) | yes | yes |
| Value range when no fixed type | smallest bit-field able to hold all enumerators | n/a — always the underlying type's range |

```cpp
// ---- validate before casting untrusted input ---------------------------------
std::optional<Side> parse_side(std::uint8_t x) noexcept {
    switch (x) {
        case 0: return Side::bid;
        case 1: return Side::ask;
        default: return std::nullopt;         // never static_cast unvalidated bytes
    }
}
// With a FIXED underlying type, static_cast<Side>(200) is well-defined (value 200,
// just not a named enumerator). Without one, a value outside the enum's smallest
// covering bit-field range is UNSPECIFIED/UB. Either way, `switch` exhaustiveness
// is a lie unless you validate at the boundary.

// ---- enums as flags: opt in explicitly ----------------------------------------
enum class Cap : std::uint32_t { none = 0, read = 1u << 0, write = 1u << 1, admin = 1u << 2 };
constexpr Cap operator|(Cap a, Cap b) noexcept {
    return static_cast<Cap>(std::to_underlying(a) | std::to_underlying(b));
}
constexpr Cap  operator&(Cap a, Cap b) noexcept {
    return static_cast<Cap>(std::to_underlying(a) & std::to_underlying(b));
}
constexpr Cap  operator~(Cap a) noexcept { return static_cast<Cap>(~std::to_underlying(a)); }
constexpr Cap& operator|=(Cap& a, Cap b) noexcept { return a = a | b; }
constexpr bool any(Cap a) noexcept { return std::to_underlying(a) != 0; }
static_assert(any(Cap::read | Cap::write));

// ---- duplicate values are legal -------------------------------------------------
enum class Tif : std::uint8_t { day = 0, gtc = 1, ioc = 2, fok = 3, immediate = 2 };
static_assert(Tif::ioc == Tif::immediate);     // aliases, not distinct states

// ---- enum in a hot struct ---------------------------------------------------------
struct Event {                     // enum class : uint8_t keeps the struct at 16 bytes
    std::uint64_t id;
    std::int32_t  price_ticks;
    Side          side;            // 1 byte, not 4
    Tif           tif;             // 1 byte
    std::uint16_t pad_reserved;
};
static_assert(sizeof(Event) == 16);
```

| Facility | Header | Since | Effect |
|---|---|---|---|
| `std::underlying_type_t<E>` | `<type_traits>` | C++11 | the enum's underlying integer type |
| `std::to_underlying(e)` | `<utility>` | C++23 | `static_cast<underlying_type_t<E>>(e)`, no width mistake |
| `std::is_enum_v<E>` / `is_scoped_enum_v<E>` | `<type_traits>` | C++11 / C++23 | classification |
| `using enum E;` | — | C++20 | injects all enumerators into the current scope |
| `std::format("{}", e)` | `<format>` | — | **not** supported by default; needs a `formatter` specialization |

**Interview line** — "`enum class` gives you scoping and no implicit integer conversion; a fixed underlying type gives you a known width — you usually want both, plus boundary validation."

**Traps** — unscoped enumerators collide in the enclosing namespace · a scoped enum's default underlying type is `int` (4 bytes) unless you say otherwise · `switch` over an enum is not exhaustive at runtime · enums without a fixed underlying type are a terrible persisted/ABI field · `using enum` in a header re-introduces the name collisions you escaped · casting unvalidated wire bytes into an enum reintroduces invalid states.
