# 5. Initialization and conversions

*Part I — Language foundations*

---

**Recall**
- Initialization gives an object its *first* value; assignment replaces the value of an object that already exists.
- Name the form before predicting behavior: `T x;` default, `T x{};` value, `T x(a);` direct, `T x = a;` copy, `T x{a};` direct-list, `T x = {a};` copy-list.
- Default-initializing an automatic scalar leaves indeterminate bytes (C++26 downgrades most such reads to *erroneous behavior*, still a bug, no longer UB).
- Value-initialization of a class with no user-provided/deleted default constructor zero-initializes the object first, then runs the implicit default constructor.
- `new T` default-initializes; `new T()` and `new T{}` value-initialize; the parenthesized form is what zeroes arrays.
- Aggregates have no user-declared/inherited constructors, no private/protected non-static data, no virtual functions, no virtual bases — verify with `std::is_aggregate_v<T>`.
- Designated initializers (C++20) name direct non-static members, in declaration order, never mixed with positional clauses, no nesting (`.a.b`), no reordering.
- Members initialize in *declaration* order regardless of mem-initializer-list order; bases before members; virtual bases before direct bases; destruction reverses.
- A default member initializer applies only when the constructor's mem-init-list does not mention that member.
- Static-storage objects get constant initialization when eligible, otherwise zero-initialization, then dynamic initialization; cross-TU dynamic order is unspecified (static initialization order fiasco).
- `constinit` demands static initialization but does *not* imply `const`; `constexpr` variables are const and constant-initialized; function-local statics are lazily initialized and thread-safe since C++11.
- List-initialization rejects narrowing: float→int, wider→narrower integer, signed↔unsigned, double→float, and any non-constant or non-exactly-representable conversion.
- Braces prefer `initializer_list` constructors so strongly that `std::vector<int>{5, 7}` is two elements while `(5, 7)` is five sevens.
- An implicit conversion sequence is at most: standard sequence → **one** user-defined conversion → standard sequence; ranks are exact > promotion > conversion > user-defined > ellipsis.
- `explicit` removes a constructor/conversion function from copy-initialization and from implicit conversion, but keeps it for direct-initialization; `explicit(bool)` is C++20.
- Contextual conversion to `bool` (`if`, `while`, `&&`, `!`, `?:`, `static_assert`) uses `explicit operator bool` without enabling arbitrary integer conversions.
- `static_cast` is compile-time only; `dynamic_cast` needs a polymorphic source and returns null (pointer) or throws `std::bad_cast` (reference); `const_cast` only changes cv; `reinterpret_cast` blesses nothing.
- `std::bit_cast<To>(from)` (C++20) requires equal `sizeof` and both types trivially copyable; it is constexpr when no member is a pointer/reference/union/volatile.
- Reading a `float` through a `std::uint32_t*` is a strict-aliasing violation; `bit_cast` or `memcpy` is the portable spelling, and union inactive-member reads are not portable C++.
- `Widget w();` is a function declaration (most vexing parse); `Widget w{};` constructs.

---

## 5.1 Default-, value-, zero-, direct-, copy-, and list-initialization

```cpp
#include <array>
#include <cstdint>
#include <string>
#include <vector>

// ---- the six spellings, scalar --------------------------------------------
int a;            // default-init  : indeterminate for automatic storage
int b{};          // value-init    : 0
int c = 3;        // copy-init     : explicit ctors excluded from final conversion
int d(3);         // direct-init   : explicit ctors are candidates
int e{3};         // direct-list-init : narrowing rejected, init_list preferred
int f = {3};      // copy-list-init   : narrowing rejected + explicit ctor => ill-formed
int g();          // NOT a variable: function declaration (most vexing parse)
auto h = int{};   // 0, unambiguously an expression
int i[3];         // three indeterminate ints
int j[3]{};       // {0,0,0}
int k[3]{1};      // {1,0,0} — remaining elements value-initialized

static int s;     // static storage => ZERO-initialized, never indeterminate
thread_local int t;  // also zero-initialized

// ---- class types -----------------------------------------------------------
struct Trivial { int x; };
struct UserDef  { int x; UserDef() {} };        // user-PROVIDED default ctor
struct Defaulted{ int x; Defaulted() = default; };

Trivial   t1;    // default-init: x indeterminate
Trivial   t2{};  // value-init : aggregate init => x == 0
UserDef   u1;    // ctor runs; x indeterminate (ctor does not touch it)
UserDef   u2{};  // SAME: value-init calls the user-provided ctor, no zeroing
Defaulted v1;    // x indeterminate
Defaulted v2{};  // zero-init the object, THEN trivial default ctor => x == 0

std::string str;      // class with default ctor: always "" — no indeterminacy
std::vector<int> vec; // empty

// ---- references ------------------------------------------------------------
int obj = 1;
int& r = obj;         // reference init binds a referent
// int& r2;           // ill-formed: references cannot be default-initialized
int const& cr = 42;   // binds to a temporary; lifetime extended to cr's scope
int&& rr = 7;         // rvalue reference to materialized temporary

// ---- new-expressions -------------------------------------------------------
int* p1 = new int;      // default-init: indeterminate
int* p2 = new int();    // value-init: 0
int* p3 = new int{};    // value-init: 0
int* p4 = new int{5};
int* q1 = new int[4];   // four indeterminate
int* q2 = new int[4](); // C++20: all zero
int* q3 = new int[4]{}; // all zero
auto* w  = new Trivial;   // x indeterminate
auto* w2 = new Trivial(); // x == 0

// ---- guaranteed zeroing idioms ---------------------------------------------
std::array<std::uint64_t, 64> counters{};   // all zero
std::vector<int> pre(1024);                 // 1024 value-initialized zeros
struct Header { std::uint32_t len{}; std::uint16_t ver{1}; };  // DMIs
```

```cpp
// ---- initialization vs assignment ------------------------------------------
std::string s1 = "abc";   // INITIALIZATION: ctor, no prior object
s1 = "def";               // ASSIGNMENT: operator= on a live object
struct Big { Big(int); Big& operator=(Big const&); };
Big big1{1};              // one construction
Big big2 = Big{2};        // guaranteed elision since C++17: still ONE construction
```

| Form | Selected by | Zero-fills? | `explicit` ctors usable? | Narrowing rejected? |
|---|---|---|---|---|
| `T x;` | default ctor / nothing for scalars | no | yes | n/a |
| `T x{};` | value-init rules | yes for scalars & implicitly-defaulted classes | yes | yes |
| `T x(a);` | direct-init, all ctors | no | yes | no |
| `T x = a;` | copy-init, implicit conversion | no | **no** | no |
| `T x{a};` | direct-list-init, `initializer_list` first | no | yes | yes |
| `T x = {a}` | copy-list-init, `initializer_list` first | no | candidate, but picking one is ill-formed | yes |
| `new T` | default-init | no | yes | n/a |
| `new T()` / `new T{}` | value-init | yes | yes | `{}` yes |

**Traps** — `UserDef u{};` does *not* zero members when the default ctor is user-provided · `int x;` at namespace scope is zero but at block scope is indeterminate · `int g();` is a function · `T x = {a}` with an `explicit` best match is ill-formed rather than falling back · `std::array<T,N> a;` leaves trivial elements indeterminate.

---

## 5.2 Aggregate initialization and designated initializers

```cpp
#include <type_traits>
#include <cstdint>

struct Add {                       // aggregate: no ctors, all public, no virtuals
    std::uint64_t id{};            // default member initializer (allowed in aggregates since C++14)
    std::int64_t  price{};
    std::uint32_t qty{};
};
static_assert(std::is_aggregate_v<Add>);

Add a1{7, 101, 5};                 // positional, memberwise
Add a2{7};                         // price/qty use their DMIs => 0
Add a3{};                          // all DMIs
Add a4 = {7, 101, 5};              // copy-list-init form
Add a5{.id = 7, .price = 101, .qty = 5};   // C++20 designated
Add a6{.id = 7, .qty = 5};                 // gaps allowed; price uses its DMI
// Add bad1{.qty = 5, .id = 7};    // ill-formed: must follow declaration order
// Add bad2{7, .qty = 5};          // ill-formed: no mixing positional + designated
// Add bad3{7, 101, 5, 9};         // ill-formed: too many initializers
// Add bad4{.id = 7.5};            // ill-formed: narrowing double -> uint64_t

// ---- base classes are the first "member" -----------------------------------
struct Base { int b; };
struct Derived : Base { int d; };  // aggregate since C++17 (public non-virtual base)
Derived dv1{{1}, 2};               // brace the base subobject
Derived dv2{1, 2};                 // brace elision also works
// Derived dv3{.d = 2};            // ill-formed: cannot designate a base

// ---- nested aggregates & brace elision -------------------------------------
struct Point { int x, y; };
struct Rect  { Point tl, br; int flags; };
Rect r1{{0, 0}, {4, 4}, 1};        // explicit
Rect r2{0, 0, 4, 4, 1};            // brace elision (allowed, less readable)
Rect r3{.tl = {0, 0}, .br = {4, 4}};   // flags value-initialized

// ---- arrays of aggregates ---------------------------------------------------
Point pts[]{{1, 2}, {3, 4}};       // extent deduced = 2
Add table[3]{};                    // three all-zero Adds

// ---- CTAD for aggregates (C++20) -------------------------------------------
template<class T> struct Wrap { T value; int tag; };
Wrap w{3.5, 1};                    // deduces Wrap<double>

// ---- what DISQUALIFIES an aggregate ----------------------------------------
struct NotAgg1 { NotAgg1() = default; private: int x; };   // private data
struct NotAgg2 { NotAgg2(int); };                          // user-declared ctor
struct NotAgg3 { virtual void f(); };                      // virtual function
struct NotAgg4 { explicit NotAgg4() = default; };          // C++20: user-DECLARED ctor
static_assert(!std::is_aggregate_v<NotAgg2>);
```

| Rule | Since | Detail |
|---|---|---|
| Default member initializers in aggregates | C++14 | omitted members use the DMI |
| Public non-virtual bases allowed | C++17 | base is initialized first, like member 0 |
| `explicit`/inherited/user-declared ctor disqualifies | C++20 | previously only user-*provided* |
| Designated initializers | C++20 | declaration order, no mixing, no nesting, no reordering |
| Parenthesized aggregate init `Add a(7, 101, 5)` | C++20 | allows narrowing, no brace elision, no lifetime extension |
| Omitted member with no DMI | — | copy-initialized from `{}` (value-initialized) |
| More initializers than members | — | ill-formed |

**Interview line** — "Adding any user-declared constructor, private data member, or virtual function silently removes aggregate initialization from every caller."

**Traps** — designators must follow declaration order (unlike C) · `.a.b` nested designators are C-only · `Add a(7)` (C++20 parenthesized) permits narrowing that `Add a{7}` rejects · brace elision hides which subobject a value lands in · reordering fields breaks positional clients without a compile error.

---

## 5.3 Member initialization order and default member initializers

```cpp
#include <cstddef>
#include <vector>

struct BadBook {
    std::size_t capacity_;
    std::vector<int> levels_;
    explicit BadBook(std::size_t requested)
        : levels_(capacity_),        // RUNS SECOND, but reads capacity_ ...
          capacity_{requested} {}    // ... which is initialized FIRST — from garbage
};                                   // -Wreorder / -Wuninitialized fires

struct GoodBook {
    std::size_t capacity_;
    std::vector<int> levels_;
    explicit GoodBook(std::size_t requested)
        : capacity_{requested},      // declaration order == written order
          levels_(capacity_) {}      // parens: n elements, NOT one element
};

// ---- full construction order ------------------------------------------------
struct V           { V(); };
struct B1 : virtual V { B1(); };
struct B2 : virtual V { B2(); };
struct D  : B1, B2 {
    int x_;
    std::vector<int> v_;
    D() : v_(4), x_(1) {}   // actual order: V, B1, B2, x_, v_ ; destruction reverses
};
```

```cpp
// ---- default member initializers -------------------------------------------
struct Limits {
    std::size_t max_orders{100'000};      // DMI, brace form
    bool        strict = true;            // DMI, equals form ( '(' is NOT allowed )
    double      fee{};                    // 0.0
    Limits() = default;                                  // all DMIs apply
    explicit Limits(std::size_t n) : max_orders{n} {}    // strict/fee keep DMIs
    Limits(std::size_t n, bool s) : max_orders{n}, strict{s} {}
};

// ---- delegating and inheriting constructors --------------------------------
struct Order {
    std::uint64_t id_;
    std::int64_t  px_;
    Order(std::uint64_t id, std::int64_t px) : id_{id}, px_{px} {}
    explicit Order(std::uint64_t id) : Order{id, 0} {}   // delegating: target ctor
                                                         // fully constructs, then body
};
struct TaggedOrder : Order {
    using Order::Order;      // inheriting ctors; TaggedOrder's own DMIs still apply
    int tag_{-1};
};

// ---- const / reference members MUST be in the mem-init-list ----------------
struct Binder {
    int const  k_;
    int&       ref_;
    Binder(int k, int& r) : k_{k}, ref_{r} {}   // no assignment alternative exists
};

// ---- initialization vs assignment in the body ------------------------------
struct Slow  { std::string s_; Slow(std::string v) { s_ = std::move(v); } };  // default-ctor + move-assign
struct Fast  { std::string s_; Fast(std::string v) : s_{std::move(v)} {} };   // one move-ctor
```

| Rule | Consequence |
|---|---|
| Virtual bases → direct bases → non-static members → ctor body | fixed by the standard, not by your list |
| Members in **declaration** order | reordering the list changes nothing but readability/warnings |
| Destruction is exact reverse of completed construction | a throwing ctor destroys only fully-constructed subobjects |
| DMI applies iff the member is absent from the mem-init-list | a delegating ctor's target applies DMIs once |
| `const` and reference members | must be in the mem-init-list (or have a DMI) |
| Body assignment | costs a default construction plus an assignment |
| Calling a virtual from a ctor | dispatches to the *current* class, not the override |
| Exception escaping a ctor | destructor of that object never runs; delete[] of partially built array handled by the runtime |

**Traps** — `-Wreorder` is not on by default in `-Wall` on every compiler · reading another member in a DMI depends on declaration order too · `levels_(capacity_)` vs `levels_{capacity_}` are one-element vs n-element vectors · a member initialized from a parameter with the same name (`: ticks{ticks}`) is legal and unambiguous.

---

## 5.4 Static initialization, constant initialization, and dynamic initialization

```cpp
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>

// ---- phase 1: static initialization (before any code runs) -----------------
int zeroed;                                  // zero-initialization
constexpr std::uint32_t header = 8;          // constant init; implies const + inline-in-header safe
constinit std::uint32_t limit = 4096;        // C++20: MUST be constant-initialized, NOT const
constinit thread_local int tls_depth = 0;    // avoids the TLS lazy-init guard
inline constexpr double tick = 0.01;         // one entity across TUs (C++17)
static_assert(header == 8);

// limit = 8192;                              // legal: constinit is not const
// constinit int bad = std::rand();           // ill-formed: needs dynamic init

// ---- phase 2: dynamic initialization ---------------------------------------
std::string g_name = compute_name();         // dynamic; ordered within this TU,
                                             // UNORDERED across TUs
extern std::string g_other;                  // reading it during g_name's init is a fiasco

// ---- fixes -------------------------------------------------------------------
// (a) constant-initialize
constinit std::array<std::uint32_t, 4> masks = {1u, 2u, 4u, 8u};

// (b) Meyers singleton: lazy, thread-safe since C++11 (magic statics)
Config const& config() {
    static Config const instance = load_config();   // guarded; init runs once
    return instance;                                // if it throws, the next call retries
}

// (c) own the lifetime from main
int main() {
    Runtime runtime;              // explicit construction order
    return run(runtime);
}

// ---- constexpr vs consteval vs constinit ------------------------------------
constexpr int twice(int n) { return 2 * n; }        // usable at compile OR run time
consteval int must(int n) { return 2 * n; }         // C++20: compile time ONLY
constinit int slot = twice(4);                      // value 8 baked into .data/.rodata

// ---- if consteval / is_constant_evaluated -----------------------------------
constexpr int checksum(int n) {
    if consteval { return n * 2; }                  // C++23
    else         { return n * 2; }                  // runtime path may differ
}
constexpr int alt(int n) {
    if (std::is_constant_evaluated()) return n;     // C++20; note: plain `if`, never `if constexpr`
    return n + 1;
}
```

| Facility | Guarantee | Implies `const`? | Failure mode |
|---|---|---|---|
| zero-initialization | all static/thread objects, before anything else | no | none |
| constant initialization | value computed at translation time | no | falls back to dynamic silently |
| `constexpr` variable | constant-initialized | **yes** | compile error |
| `constinit` (C++20) | constant-initialized | **no** | compile error |
| `consteval` function | every call is a constant expression | n/a | compile error at any runtime call |
| dynamic initialization | runs at startup / first use | no | unspecified cross-TU order |
| function-local `static` | lazy, thread-safe, once | as declared | recursive re-entry is UB; throwing init retried next call |
| `inline constexpr` variable | one entity across TUs (C++17) | yes | ODR violation without `inline` |

**Interview line** — "`constexpr` guarantees a constant *can* be formed, `constinit` guarantees the variable *is* constant-initialized without making it const, and `consteval` guarantees the function is *never* called at runtime."

**Traps** — the fiasco applies only to *dynamic* initialization across TUs · magic-static guards cost an acquire load on every call in some ABIs — hoist the reference out of hot loops · `thread_local` non-constinit access can carry a per-access initialization check · startup allocation and locking are invisible in steady-state benchmarks but show up on the first message · destruction order at exit is reverse construction, so a static logger can outlive or predecease its users.

---

## 5.5 Narrowing conversions and brace initialization

```cpp
#include <cstdint>
#include <expected>
#include <limits>
#include <system_error>

// ---- what braces reject -----------------------------------------------------
int i = 3.9;                 // OK, truncates to 3
// int j{3.9};               // ill-formed: floating -> integer
// int j2 = {3.9};           // ill-formed too

std::uint16_t a{42};         // OK: constant expression that FITS
// std::uint16_t b{70000};   // ill-formed: constant does not fit
int n = 70000;
// std::uint16_t c{n};       // ill-formed: non-constant int -> uint16_t

double d{42};                // OK: int constant exactly representable
// float f{0.1};             // ill-formed: double -> float
float f2{0.1f};              // OK
float f3{1};                 // OK: int constant 1 is exactly representable as float
// int s{-1}; unsigned u{s}; // ill-formed: signed -> unsigned
unsigned u2{1u};             // OK
char ch{'a'};                // OK
// char ch2{300};            // ill-formed if char is 8-bit
enum class Side : std::uint8_t { buy, sell };
Side side{Side::buy};
// Side bad{1};              // ill-formed pre-C++17; C++17 allows Side{1} for scoped enum
                             // with fixed underlying type IF the value fits
Side ok{static_cast<Side>(1)};

// ---- narrowing list (list-init rejects each) --------------------------------
// float/double -> integer;  integer/enum -> float (unless constant & exact);
// double -> float (unless constant & exactly representable);
// integer/enum -> narrower integer (unless constant & fits);
// pointer -> bool.

// ---- the escape hatch that proves nothing ----------------------------------
std::uint16_t forced{static_cast<std::uint16_t>(n)};   // compiles; may still be wrong

// ---- the escape hatch that proves something --------------------------------
enum class Error { too_large };
std::expected<std::uint16_t, Error> checked_size(std::size_t n) {
    if (n > std::numeric_limits<std::uint16_t>::max())
        return std::unexpected(Error::too_large);
    return static_cast<std::uint16_t>(n);              // narrowing PROVEN safe
}

// C++20 std::in_range: value-preserving test across integer types
static_assert(std::in_range<std::uint16_t>(65535));
static_assert(!std::in_range<std::uint16_t>(65536));
bool fits = std::cmp_less(-1, 1u);                     // true — correct signed/unsigned compare
```

| Idiom | Effect |
|---|---|
| `T x{v}` | compile-time narrowing diagnostic on constants and on any non-constant width/sign loss |
| `T x(v)` / `T x = v` | silent conversion; only `-Wconversion` warns |
| `static_cast<T>(v)` | suppresses the diagnostic; no runtime check |
| `std::in_range<T>(v)` (C++20, `<utility>`) | true iff `v` is representable in `T` |
| `std::cmp_less/greater/equal…` (C++20) | mixed signed/unsigned comparison without promotion bugs |
| `std::saturate_cast<T>(v)` (C++26) | clamps instead of wrapping |
| `gsl::narrow<T>(v)` | casts and throws when the round-trip differs |

**Traps** — braces catch *width* narrowing, never *semantic* narrowing (ticks vs dollars) · `float f{0.1}` fails but `float f = 0.1` compiles · a `static_cast` inside braces silences the only automatic check you had · narrowing rules use the *value* for constant expressions and the *type* otherwise · `auto x{1}` is `int` (C++17), but `auto x{1,2}` is ill-formed.

---

## 5.6 Implicit conversion sequences and contextual conversion to `bool`

```cpp
// ---- an implicit conversion sequence, at most: --------------------------------
//   [standard conversion seq] -> [ONE user-defined conversion] -> [standard conversion seq]
// so no chain of two user-defined conversions is ever formed.

struct A { A(int); };
struct B { B(A);  };
// B b = 1;      // ill-formed: int -> A -> B needs TWO user-defined conversions
B b = A{1};      // OK: one user-defined conversion

// ---- standard conversion categories ------------------------------------------
int arr[4];
int* p       = arr;              // array-to-pointer decay
void (*fp)() = some_function;    // function-to-pointer decay
int lv = arr[0];                 // lvalue-to-rvalue
int prom = 'a';                  // integral promotion (char -> int)
double dpr = 1.0f;               // floating-point promotion
long conv = 3;                   // integral conversion
double num = 3;                  // floating-integral conversion
int const* qc = p;               // qualification conversion
struct Base {}; struct Derived : Base {};
Derived dd; Base* bp = &dd;      // derived-to-base pointer conversion
Base& br = dd;                   // derived-to-base reference binding
int* np = nullptr;               // null pointer conversion
bool flag = p;                   // boolean conversion (pointer -> bool)

// ---- ranking in action --------------------------------------------------------
void f(long);
void f(double);
// f(1);        // AMBIGUOUS: int->long and int->double are both "conversion" rank
f(1L);          // exact match
f(1.0);         // exact match

void g(int);
void g(long);
g('a');         // calls g(int): promotion beats conversion

void h(int);
void h(...);
h(3.5);         // calls h(int): any standard conversion beats the ellipsis
```

```text
rank order:  exact match  >  promotion  >  conversion  >  user-defined seq  >  ellipsis
tie-breakers: more-cv-qualified reference, derived-to-base depth, non-template
              beats template, more-specialized template, ...
```

```cpp
// ---- contextual conversion to bool ------------------------------------------
struct Handle {
    void* ptr{};
    explicit operator bool() const noexcept { return ptr != nullptr; }
};
Handle h;
if (h) {}                    // OK: contextual conversion
while (h) { break; }         // OK
bool ok = !h;                // OK: operator! applies contextual conversion
auto x2 = h && true;         // OK
auto y2 = h ? 1 : 0;         // OK
static_assert(sizeof(h) > 0);
// int bad = h;              // ill-formed: explicit blocks copy-init
// bool bad2 = h;            // ill-formed
bool good = static_cast<bool>(h);   // direct-init: explicit is a candidate

// contextual-bool contexts: if / while / for cond / do-while / !, &&, ||
//   / ?: first operand / static_assert / noexcept operator / explicit(bool)
```

```cpp
// ---- conversion operators ------------------------------------------------------
struct Ticks {
    std::int64_t v{};
    constexpr explicit operator std::int64_t() const noexcept { return v; }
    constexpr operator double() const noexcept { return double(v); }   // IMPLICIT: usually a mistake
};
// The implicit operator double lets Ticks silently enter arithmetic with dollars.
```

| Conversion category | Rank | Example |
|---|---|---|
| Identity, lvalue-to-rvalue, array/function decay, qualification | exact match | `int` → `int`, `T[]` → `T*` |
| Integral / floating-point promotion | promotion | `char`→`int`, `float`→`double` |
| Integral, floating, floating-integral, pointer, pointer-to-member, boolean, derived-to-base | conversion | `int`→`double`, `D*`→`B*` |
| Converting constructor / conversion function | user-defined | `int`→`std::string_view`? no; `char const*`→`std::string` yes |
| Ellipsis `...` | worst | `printf`-style |

**Traps** — the compiler ranks conversions, never intent · `f(1)` ambiguity is a *design* bug: one overload per unit type fixes it · at most one user-defined conversion means adding a converting constructor rarely composes · `explicit operator bool` still allows `h == other_handle` if you also define `operator==` on a bool-convertible chain — prefer `operator<=>` on the real type · a non-explicit `operator double` is how unit types leak.

---

## 5.7 `explicit` and conditional `explicit(bool)`

```cpp
#include <concepts>
#include <cstdint>
#include <utility>

struct Price {
    std::int64_t ticks;
    explicit constexpr Price(std::int64_t t) noexcept : ticks{t} {}
};
Price p{100};                 // direct-init: OK
Price p2(100);                // OK
// Price q = 100;             // ill-formed: copy-init excludes explicit
// void take(Price); take(5); // ill-formed: no implicit conversion
Price q2 = Price{100};        // OK, explicit at the call site

// ---- multi-parameter ctors convert too, when defaults allow one arg --------
struct Span2 {
    Span2(int begin, int end = 0);   // CONVERTING: Span2 s = 3; compiles
};
struct Span3 {
    explicit Span3(int begin, int end = 0);
};
// Explicit also matters for multi-arg list-init: Span3 s = {1, 2}; is ill-formed.

// ---- explicit conversion functions ------------------------------------------
struct Fd {
    int fd{-1};
    explicit operator int() const noexcept { return fd; }   // no accidental arithmetic
    explicit operator bool() const noexcept { return fd >= 0; }
};

// ---- explicit(bool), C++20 ----------------------------------------------------
template<class T>
struct Box {
    T value;
    template<class U>
    explicit(!std::convertible_to<U, T>)     // implicit iff U converts implicitly to T
    constexpr Box(U&& u) : value(std::forward<U>(u)) {}
};
Box<long> b1 = 3;                 // implicit: int -> long is convertible
Box<Price> b2{Price{1}};          // explicit path required

// how the standard library itself uses it:
//   pair(U1&&, U2&&) is explicit(!is_convertible_v<U1,T1> || !is_convertible_v<U2,T2>)
//   tuple, optional, expected, unique_ptr's deleter ctors: same pattern

// explicit(false) is legal and means "implicit"
struct Meters { double v; explicit(false) Meters(double d) : v{d} {} };

// ---- explicit default ctor (C++20 consequence) -------------------------------
struct E { explicit E() = default; };   // now user-DECLARED => NOT an aggregate
// E e = {};   // ill-formed
E e{};         // OK
```

| Declaration | `T x(a);` | `T x = a;` | `f(a)` where `f(T)` | `return a;` from `T f()` | `T{a}` in list |
|---|---|---|---|---|---|
| non-explicit ctor | ✓ | ✓ | ✓ | ✓ | ✓ |
| `explicit` ctor | ✓ | ✗ | ✗ | ✗ | ✓ (direct-list) |
| non-explicit conversion fn | ✓ | ✓ | ✓ | ✓ | ✓ |
| `explicit` conversion fn | ✓ (via `static_cast`) | ✗ | ✗ | ✗ | ✓ |
| `explicit(cond)` | ✓ | only when `cond` is false | same | same | ✓ |

**When to be implicit vs explicit**

| Make it implicit | Make it explicit |
|---|---|
| Semantics-preserving widening (`int`→`Ratio`) | Domain units (`Price`, `Qty`, `Ticks`) |
| A view over the same bytes (`string`→`string_view`) | Ownership handles (`unique_ptr`, `Fd`) |
| Perfect-forwarding wrappers when `U` is implicitly convertible | Anything requiring validation or lossy |
| `std::pair`/`tuple` element-wise when all elements are implicit | Single-`size_t` ctors (`vector(size_t)` is explicit for this reason) |

**Traps** — `explicit` on a *copy* constructor breaks pass-by-value and `return` · `emplace_back` bypasses the `explicit` barrier because it direct-initializes · marking only the constructor leaves `operator T()` as a back door · a `explicit(bool)` predicate evaluated on an incomplete type is a hard error, not SFINAE · declaring `explicit X() = default` (C++20) removes aggregate status.

---

## 5.8 C-style casts versus `static_cast`, `dynamic_cast`, `const_cast`, and `reinterpret_cast`

```cpp
#include <cstdint>
#include <memory>
#include <typeinfo>

struct Base { virtual ~Base() = default; };
struct Derived : Base { void specific(); };
struct Other   : Base {};

// ---- static_cast ---------------------------------------------------------------
double dv = 3.9;
int    iv = static_cast<int>(dv);                  // truncates toward zero
auto   u  = static_cast<std::uint32_t>(-1);        // 0xFFFFFFFF (well-defined wrap)
enum class Side : std::uint8_t { buy, sell };
auto   raw  = static_cast<std::uint8_t>(Side::buy);
auto   side = static_cast<Side>(std::uint8_t{1});
Derived d;
Base*  up   = static_cast<Base*>(&d);              // upcast: always safe
auto*  down = static_cast<Derived*>(up);           // downcast: UNCHECKED precondition
void*  vp   = &d;
auto*  back = static_cast<Derived*>(vp);           // void* round-trip
auto&& mv   = static_cast<Derived&&>(d);           // this is what std::move does
int&&  xv   = static_cast<int&&>(iv);
static_cast<void>(iv);                             // discard, silence [[nodiscard]]
auto* fp = static_cast<void(*)(int)>(overloaded);  // pick an overload

// ---- dynamic_cast ---------------------------------------------------------------
Base* b = get();
if (auto* p = dynamic_cast<Derived*>(b)) p->specific();   // null on failure
try { Derived& r = dynamic_cast<Derived&>(*b); (void)r; }
catch (std::bad_cast const&) { /* reference failure THROWS */ }
void* most_derived = dynamic_cast<void*>(b);   // address of the most-derived object
Other* cross = dynamic_cast<Other*>(b);        // sibling cross-cast, needs RTTI
// requires: source is polymorphic (has a virtual function) and RTTI enabled (-frtti)

// ---- const_cast ------------------------------------------------------------------
void legacy_api(char* s);
std::string msg = "hi";
char const* cs = msg.c_str();
legacy_api(const_cast<char*>(cs));            // OK only if legacy_api does not write
int const ci = 5;
int* bad = const_cast<int*>(&ci);
// *bad = 6;                                  // UB: object is genuinely const
const_cast<volatile int*>(&iv);               // also adds/removes volatile

// ---- reinterpret_cast ------------------------------------------------------------
auto addr = reinterpret_cast<std::uintptr_t>(&d);      // pointer -> integer
auto* p2  = reinterpret_cast<Derived*>(addr);          // and back: same pointer
auto* bytes = reinterpret_cast<std::byte const*>(&d);  // OK: byte/char/uchar may alias
// auto* wrong = reinterpret_cast<double*>(&iv);       // reading *wrong is UB (aliasing)
// reinterpret_cast never changes the bits and never creates an object

// ---- C-style: tries the sequence const_cast / static_cast / reinterpret_cast ----
auto* c1 = (Derived*)up;      // static_cast here
auto* c2 = (char*)cs;         // const_cast here
auto* c3 = (double*)&iv;      // reinterpret_cast here — indistinguishable at a glance
// functional-style T(x) is the same thing with different syntax

// ---- smart-pointer casts (<memory>) ------------------------------------------------
std::shared_ptr<Base> sb = std::make_shared<Derived>();
auto sd = std::dynamic_pointer_cast<Derived>(sb);   // shares ownership, null on fail
auto ss = std::static_pointer_cast<Derived>(sb);
auto sc = std::const_pointer_cast<Base>(sb);
auto sr = std::reinterpret_pointer_cast<Derived>(sb);
```

| Cast | Job | Runtime cost | Fails how | Major trap |
|---|---|---|---|---|
| `static_cast<T>` | numeric, enum↔integer, up/down-cast, `void*` round-trip, lvalue→rvalue-ref, explicit ctor/conversion fn | none (conversion itself may cost) | compile error | downcast precondition unchecked; can narrow silently |
| `dynamic_cast<T*>` | runtime-checked downcast / cross-cast / `void*` | RTTI lookup, implementation-defined | returns `nullptr` | needs a polymorphic source and `-frtti` |
| `dynamic_cast<T&>` | same, reference form | same | throws `std::bad_cast` | forgetting the throw path |
| `const_cast<T>` | add/remove `const`/`volatile` only | none | compile error | writing through it to a truly-const object is UB |
| `reinterpret_cast<T>` | pointer↔integer, unrelated pointer types | none | compile error | grants no alignment, lifetime, or aliasing permission |
| C-style `(T)x` | tries `const_cast`, then `static_cast`, then `static_cast`+`const_cast`, then `reinterpret_cast`(+`const_cast`) | varies | rarely | hides which dangerous operation happened; ungreppable |
| `std::bit_cast<T>` | equal-size value reinterpretation | none (usually) | compile error | not for different sizes or non-trivially-copyable |
| `std::start_lifetime_as<T>` (C++23) | make an object exist in suitable storage | none | compile error | still requires correct alignment and size |

```cpp
// ---- alternatives to casting -----------------------------------------------------
// virtual dispatch instead of dynamic_cast:
struct Node { virtual void accept(Visitor&) = 0; };
// std::variant + std::visit instead of a hierarchy + dynamic_cast:
using Msg = std::variant<NewOrder, Cancel, Trade>;
std::visit([](auto const& m) { handle(m); }, msg);
// mutable member instead of const_cast in a const member function
```

**Interview line** — "A named cast documents *which* dangerous operation you chose; it never proves the precondition holds."

**Traps** — `dynamic_cast` in a hot loop is a tag-dispatch smell; use a virtual call, an enum tag, or a `variant` · `dynamic_cast` on a non-polymorphic type does not compile · `static_cast` between unrelated pointer types does not compile — reaching for `reinterpret_cast` there is the red flag · C-style casts through a `private` base fail where `static_cast` would too · `const_cast` on a `const` *reference parameter* whose referent was non-const is fine; on a genuinely const object it is UB.

---

## 5.9 `std::bit_cast` versus type punning

```cpp
#include <bit>
#include <cstdint>
#include <cstring>
#include <span>

// ---- std::bit_cast (C++20, <bit>) -------------------------------------------
float f = 1.0f;
auto bits  = std::bit_cast<std::uint32_t>(f);       // 0x3F800000
auto round = std::bit_cast<float>(bits);            // exact round-trip
static_assert(std::bit_cast<std::uint32_t>(1.0f) == 0x3F800000u);   // constexpr!

// requirements, all compile-time:
//   sizeof(To) == sizeof(From)
//   std::is_trivially_copyable_v<To> && std::is_trivially_copyable_v<From>
// constexpr only when neither type (recursively) contains a pointer,
// pointer-to-member, reference, union, or volatile-qualified member.
// template<class To, class From>
// constexpr To bit_cast(From const& from) noexcept;   // NOT conditionally noexcept: always noexcept

// ---- what bit_cast does NOT do -----------------------------------------------
// - does not swap byte order          -> use std::byteswap (C++23)
// - does not validate the result      -> a bit pattern may not be a valid value of To
// - does not fix padding portability  -> padding bytes become unspecified in To
// - does not begin an object's lifetime in raw storage -> use start_lifetime_as
// - reading a bool/enum with an out-of-range representation is still UB

// ---- the unsafe spelling ------------------------------------------------------
// auto b = *reinterpret_cast<std::uint32_t*>(&f);   // strict-aliasing violation (UB)
union Pun { float f; std::uint32_t u; };
// Pun p{.f = 1.0f}; auto v = p.u;                   // reading the INACTIVE member:
                                                     // legal in C, UB in C++ (GCC/Clang
                                                     // document it as an extension)

// ---- the portable byte-level spellings ----------------------------------------
std::uint32_t via_memcpy;
std::memcpy(&via_memcpy, &f, sizeof via_memcpy);     // always correct; optimizes away

std::uint32_t load_be(std::span<std::byte const, 4> b) noexcept {   // explicit wire decode
    return (std::uint32_t(b[0]) << 24) | (std::uint32_t(b[1]) << 16)
         | (std::uint32_t(b[2]) <<  8) |  std::uint32_t(b[3]);
}

// ---- <bit> companions ----------------------------------------------------------
static_assert(std::endian::native == std::endian::little || true);   // C++20
auto swapped = std::byteswap(std::uint32_t{0x01020304});             // C++23 -> 0x04030201
static_assert(std::has_single_bit(8u));                              // power of two
static_assert(std::bit_ceil(5u) == 8u && std::bit_floor(5u) == 4u);
static_assert(std::bit_width(5u) == 3);
static_assert(std::countl_zero(std::uint8_t{1}) == 7);
static_assert(std::countr_zero(std::uint8_t{8}) == 3);
static_assert(std::popcount(0b1011u) == 3);
auto rot = std::rotl(std::uint8_t{0b1000'0001}, 1);                  // rotr also exists

// ---- C++23 implicit lifetime helpers ------------------------------------------
#include <memory>
alignas(std::uint32_t) std::byte buffer[64]{};
auto* hdr = std::start_lifetime_as<std::uint32_t>(buffer);           // C++23
auto* arr = std::start_lifetime_as_array<std::uint32_t>(buffer, 16); // C++23
```

| Facility | Header | Requirement | constexpr | Use for |
|---|---|---|---|---|
| `std::bit_cast<To>(from)` | `<bit>` | equal size, both trivially copyable | yes (no ptr/ref/union/volatile) | value reinterpretation |
| `std::memcpy` | `<cstring>` | trivially copyable, sizes you control | no | object representation, partial copies, differing sizes |
| `std::start_lifetime_as<T>` | `<memory>` | suitably sized/aligned storage, implicit-lifetime `T` | no | making an object exist over received bytes |
| `std::byteswap` (C++23) | `<bit>` | integral, no padding | yes | endian conversion |
| `std::endian::native/little/big` | `<bit>` | — | yes | compile-time endianness branch |
| explicit shift/or loads | — | — | yes | wire formats: no alignment, no endianness, no padding assumption |
| `reinterpret_cast` deref | — | only `char`/`unsigned char`/`std::byte` may alias | no | almost never |

**Interview line** — "`bit_cast` is a *value* operation on equal-size trivially copyable types; `reinterpret_cast` is a *pointer* operation that grants no permission to read through the result."

**Traps** — equal `sizeof` is checked, matching padding is not · `bit_cast` into a `bool` or scoped enum can produce an invalid representation · it says nothing about endianness, so never use it as a wire decoder · union punning is a documented compiler extension, not portable C++ · `memcpy` of a type with padding leaves the padding unspecified, which breaks naive `memcmp` equality.

---

## 5.10 Most vexing parse, initializer-list preference, and initialization traps

```cpp
#include <memory>
#include <string>
#include <vector>

// ---- most vexing parse ---------------------------------------------------------
struct Timer { Timer(); Timer(int); };
Timer t1();                        // FUNCTION declaration: Timer(*)()
Timer t2{};                        // object
Timer t3;                          // object (default-init)
Timer t4(Timer());                 // FUNCTION taking Timer(*)() returning Timer
Timer t5{Timer{}};                 // object
struct Reader { Reader(std::istream&); };
// Reader r(std::istream(std::cin));  // function declaration!
Reader r2{std::istream{std::cin}};    // object
// rule: if a construct can be parsed as a declaration, it IS a declaration.

// ---- initializer_list preference ------------------------------------------------
std::vector<int> a(3, 9);          // {9, 9, 9}
std::vector<int> b{3, 9};          // {3, 9}  <- init-list ctor wins
std::vector<int> c(3);             // {0, 0, 0}
std::vector<int> d{3};             // {3}
std::vector<std::string> e(3, "x");// three "x"
std::vector<std::string> f{3, "x"};// ill-formed: 3 is not convertible to string

// the preference is absolute: an init-list ctor is considered FIRST and, if any
// is viable, no other ctor is considered — even if a non-list ctor is a better match.
struct Odd {
    Odd(int, int);
    Odd(std::initializer_list<double>);
};
Odd o1{1, 2};       // picks the initializer_list<double> ctor
Odd o2(1, 2);       // picks Odd(int, int)
struct Narrow { Narrow(std::initializer_list<int>); Narrow(double, double); };
// Narrow n{1.0, 2.0};   // ill-formed: list ctor chosen, then double->int narrows

// empty braces are special: {} selects the DEFAULT ctor, not an empty init-list ctor
struct Both { Both(); Both(std::initializer_list<int>); };
Both z{};      // default ctor
Both z2{{}};   // initializer_list with one value-initialized int

// ---- initializer_list elements are const ----------------------------------------
std::vector<std::unique_ptr<int>> v;
// std::vector<std::unique_ptr<int>> w{std::make_unique<int>(1)};  // ill-formed:
//   initializer_list yields const unique_ptr<int>&, copy is deleted
v.push_back(std::make_unique<int>(1));       // OK
v.emplace_back(new int(2));                  // OK (but prefer make_unique)

// ---- initializer_list lifetime ---------------------------------------------------
std::initializer_list<int> il = {1, 2, 3};   // backing array lifetime = il's lifetime
auto get_bad() {
    std::initializer_list<int> local = {1, 2, 3};
    return local;                            // DANGLES: backing array dies at return
}
void take(std::initializer_list<int> xs);
take({1, 2, 3});                             // fine: array outlives the call

// ---- accidental temporary instead of reset ---------------------------------------
struct Widget { Widget(); };
Widget w;
Widget();          // constructs and destroys a TEMPORARY; w is untouched
w = Widget{};      // this is the reset

// ---- auto and braces (C++17 rules) -------------------------------------------------
auto x1{1};        // int          (direct-list with ONE element)
auto x2 = {1};     // std::initializer_list<int>  (copy-list)
auto x3 = {1, 2};  // std::initializer_list<int>
// auto x4{1, 2};  // ill-formed
auto x5 = {1, 2.0};// ill-formed: cannot deduce a single element type

// ---- copy elision (guaranteed since C++17) --------------------------------------
struct NoCopy { NoCopy(); NoCopy(NoCopy const&) = delete; };
NoCopy make() { return NoCopy{}; }
NoCopy n = make();     // legal: prvalue initializes n directly, no copy/move exists

// ---- self-initialization ---------------------------------------------------------
// int y = y;         // UB: reads its own indeterminate value
// ---- shadowed member -------------------------------------------------------------
struct S { int v_; S(int v) { int v_ = v; (void)v_; } };  // BUG: initializes a local
```

| Symptom | Cause | Fix |
|---|---|---|
| "call of non-object type" on `t.method()` | most vexing parse | `Timer t{};` |
| `vector<int>{5,7}` has 2 elements | init-list ctor preferred | use `( )` for count/value |
| move-only type rejected by `{...}` | `initializer_list` elements are `const` | `push_back`/`emplace_back` in a loop |
| narrowing error on a brace with a list ctor | list ctor chosen first, then narrowing checked | `( )`, or fix the types |
| `auto x = {1};` is not `int` | copy-list-init deduces `initializer_list` | `auto x = 1;` or `auto x{1};` |
| member stays garbage after ctor body | shadowed by a local declaration | enable `-Wshadow` |
| dangling `initializer_list` | backing array is a temporary | copy into a `vector` |
| object not reset by `Widget();` | statement creates a temporary | `w = Widget{};` |

**Interview line** — "Braces buy you narrowing diagnostics and cost you overload predictability, because any viable `initializer_list` constructor is chosen before every other candidate."

**Cost and boundary checklist**

- Initialization can allocate, throw, lock, dispatch to user code, or walk an `initializer_list` — none of it is free.
- `reserve` allocates capacity but constructs nothing; `resize`/`vector(n)` construct live objects.
- Validate untrusted lengths, prices, tags, and offsets *before* narrowing, then narrow once into a strong type.
- Keep dynamic initialization, first-use statics, and lazy TLS out of the measured hot phase.
- `static_cast` costs nothing by itself; the conversion it names may cost (int↔float, virtual-base adjust).
- `dynamic_cast` cost is implementation-specific and unbounded across deep hierarchies — design it out before measuring it.

**Recall card**

```text
T x;              default-init; automatic scalar left indeterminate
T x{};            value-init; scalar zero; class zero-then-implicit-ctor
T x(args)         direct-init; explicit ctors are candidates
T x = expr        copy-init; explicit excluded from the final conversion
T x{args}         list-init; narrowing rejected; initializer_list wins first
aggregate         memberwise; designators in declaration order, no mixing
member order      virtual bases -> bases -> members in DECLARATION order
static init       constant init if eligible, else zero; then dynamic (unordered cross-TU)
constinit         requires static init, does NOT imply const
constexpr var     const + constant-initialized ; consteval fn = compile time only
conversion rank   exact > promotion > conversion > user-defined > ellipsis
ICS shape         standard -> ONE user-defined -> standard
explicit          blocks copy-init and implicit conversion, keeps direct-init
explicit(bool)    C++20; how pair/tuple/optional stay conditionally implicit
static_cast       compile-time; unchecked downcast
dynamic_cast      polymorphic only; null (ptr) / bad_cast (ref)
const_cast        cv only; writing to a truly-const object is UB
reinterpret_cast  no lifetime, alignment, or aliasing blessing
bit_cast          equal size + trivially copyable; constexpr; no endian help
most vexing parse if it can parse as a declaration, it is a declaration
boundary rule     validate first, then narrow/cast ONCE into a strong type
```
