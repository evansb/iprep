# 2. Tokens, declarations, and type notation

*Part I — Language foundations*

---

**Recall**
- Translation runs source characters → preprocessing tokens → preprocessing → tokens → declarations; a macro sees only preprocessing tokens and has no type, scope, or single-evaluation guarantee.
- The lexer applies **maximal munch**: it forms the longest valid preprocessing token, so `x+++2` is `x++ + 2` and spacing can change meaning.
- Read a declarator **from the identifier outward**, respecting parentheses; postfix `()` and `[]` bind tighter than prefix `*`, `&`, `&&`.
- `*`, `&`, and `[]` belong to the individual declarator, not the base specifier — `int* a, b;` declares one pointer and one `int`.
- There are no arrays of references, no functions returning arrays or functions; indirection through pointers/references supplies those.
- `noexcept` is part of a function *type* since C++17; non-throwing → potentially-throwing pointer conversion is one-way.
- `using` and `typedef` both create **synonyms**, never distinct types — they add no overload separation, no validation, no runtime cost; only `using` can be templated.
- `auto x = e` deduces like a by-value template parameter: drops references and top-level cv; the written `const`/`&`/`&&` is then re-applied.
- `auto&&` is a forwarding reference only when `auto` is actually deduced; reference collapsing yields `T&` from lvalues, `T&&` from rvalues.
- `auto x = {1,2}` is `std::initializer_list<int>` but `auto x{1}` is `int` — the brace boundary is the single most-tested `auto` trap.
- An unconstrained template parameter cannot deduce from a braced-init-list; `std::initializer_list<T>` parameters are the carve-out.
- `decltype(e)` yields the *declared type* for an unparenthesized id-expression or member access, otherwise encodes value category: lvalue → `T&`, xvalue → `T&&`, prvalue → `T`.
- `decltype(auto)` reproduces those rules exactly, which makes parentheses in a `return` statement observable — and makes dangling references easy.
- `sizeof`, `decltype`, `noexcept(expr)`, `requires`, and (for non-polymorphic operands) `typeid` leave their operand **unevaluated**; names must still resolve and the expression must be well-formed.
- Top-level cv qualifies the declared object and is discarded by copying/by-value deduction; low-level cv sits inside a compound type and constrains access through it.
- East const (`int const*`) and west const (`const int*`) are the same type; a reference is never itself cv-qualified.
- `volatile` means "this access is an observable side effect" — it supplies no atomicity, no mutual exclusion, no happens-before edge, no cache semantics.
- `const` on an object does not freeze what it *reaches*: `View const v{&n}; *v.p = 42;` is fine.
- Modifying an object that was *defined* `const` through a `const_cast` is UB; casting const off a genuinely non-const object is legal but usually signals a broken interface.
- Most attributes are permissions or hints, not guarantees: `[[likely]]` promises no layout, `[[no_unique_address]]` promises no size reduction, `[[nodiscard]]` promises no error — never make correctness depend on one.
- `[[assume(expr)]]` (C++23) and `[[noreturn]]` are the two attributes whose violation is straight UB.
- All of this is compile-time machinery; the runtime cost is entirely in *which type got selected* — copy vs reference, owner vs view, proxy vs value, wider vs narrower.

---

## 2.1 Keywords, identifiers, literals, operators, and punctuation

```cpp
// ---- token categories -------------------------------------------------
// keyword | identifier | literal | operator | punctuator
int   sequence = 1'000'000;   // int / identifier / literal / = / ;

// ---- integer literals -------------------------------------------------
auto d   = 42;          // int (first fitting decimal type: int, long, long long)
auto u   = 42u;         // unsigned int
auto l   = 42L;         // long
auto ull = 42ULL;       // unsigned long long
auto z   = 42z;         // std::ptrdiff_t     (C++23)
auto uz  = 42uz;        // std::size_t        (C++23)
auto hex = 0xFFu;       // hex list admits unsigned types earlier than decimal
auto oct = 0777;        // octal — leading zero, a classic config-file bug
auto bin = 0b1010'0001; // binary literal      (C++14)
auto sep = 1'000'000'0; // digit separators are ignored by the value

// ---- floating literals ------------------------------------------------
auto f0 = 3.0;          // double
auto f1 = 3.0f;         // float
auto f2 = 3.0L;         // long double
auto f3 = 12.5e-3;      // double, scientific
auto f4 = 0x1.8p3;      // hex float = 1.5 * 2^3 = 12.0  (C++17)

// ---- character / string literals --------------------------------------
auto c0 = 'A';          // char   (NOT int, unlike C)
auto c1 = u8'A';        // char8_t   (C++20)
auto c2 = u'A';         // char16_t
auto c3 = U'A';         // char32_t
auto c4 = L'A';         // wchar_t
auto s0 = "ABC";        // const char[4] — includes the trailing '\0'
auto s1 = u8"ABC";      // const char8_t[4]  (C++20)
auto s2 = R"(no \escapes here)";           // raw string literal
auto s3 = R"tag(X("quoted")X)tag";         // custom delimiter for embedded )"
constexpr auto joined = "ITCH " "decoder"; // adjacent literals concatenate: char[13]

// ---- other literals ---------------------------------------------------
auto n  = nullptr;      // std::nullptr_t
auto b  = true;         // bool
using namespace std::chrono_literals;
auto t  = 10ms;         // user-defined literal — needs the operator visible
using namespace std::string_literals;
auto ss = "abc"s;       // std::string, not const char*
auto sv = "abc"sv;      // std::string_view  (<string_view>)
```

```cpp
// ---- maximal munch: the lexer takes the LONGEST valid token -----------
int x = 1;
int y = x+++2;          // parsed x++ + 2   (not x + ++2)
int z = x+ ++2;         // ill-formed anyway, but shows spacing changes tokens
Slot<Slot<int>> nested; // `>>` split into two closers since C++11
auto q = 1/*c*/+2;      // comment acts as a separator → 1 + 2

// ---- comments do not nest ---------------------------------------------
/* outer /* inner */ int live = 1;   // the FIRST */ ends it; rest is code
```

| Spelling | Type / rule |
|---|---|
| `42` | first fitting type of `int`, `long`, `long long` |
| `42u` / `42L` / `42ULL` | suffix selects the candidate list; letters case-insensitive |
| `0xff` / `0b1` / `0777` | hex/binary/octal; hex & octal lists include unsigned types |
| `42z` / `42uz` | `ptrdiff_t` / `size_t` (C++23) |
| `3.0` / `3.0f` / `3.0L` | `double` / `float` / `long double` |
| `0x1.8p3` | hexadecimal floating literal (C++17) |
| `'A'` | `char` in C++ (`int` in C) |
| `"ABC"` | `const char[N+1]`, null-terminated, static storage duration |
| `nullptr` | `std::nullptr_t` |
| `10ms`, `"x"s`, `"x"sv` | user-defined literal — requires the literal operator in scope |

**Reserved identifiers** — never define these:

| Pattern | Reserved where |
|---|---|
| contains `__` anywhere | everywhere, to the implementation |
| `_` followed by uppercase (`_Foo`) | everywhere |
| leading `_` (`_foo`) | in the global namespace |
| keywords, incl. alternative spellings `and` `or` `not` `xor` `bitand` `bitor` `compl` `not_eq` | always |
| `std` and nested namespaces | additions are UB except permitted specializations |

**Traps** — maximal munch means whitespace is semantic · `'A'` is `char`, so `sizeof('A') == 1` in C++ and `4` in C · a leading `0` is octal · comments cannot nest, so `/* */` cannot comment out a block containing a comment (use `#if 0`) · macros have no scope, no type, and may evaluate an argument zero or many times · UCNs and confusable glyphs in identifiers are a real supply-chain hazard.

---

## 2.2 Declaration syntax and the declarator "spiral"

```cpp
// declaration-specifiers   declarator                initializer
   const std::uint32_t      * const active_sequence = &sequence;
// ^^^^^^^^^^^^^^^^^^^      ^^^^^^^^^^^^^^^^^^^^^^   ^^^^^^^^^^^
// base type + cv           read from the name out    initial value
```

```cpp
// ---- one specifier, many declarators — each has its own type ----------
int* bid, ask;          // bid is int*;  ask is int   <-- the classic trap
int *bid2, *ask2;       // both int* (still: one declarator per line is better)
int a[8], (*p)[8];      // a is int[8]; p is pointer to int[8]
```

```cpp
// ---- every declarator form --------------------------------------------
int   v;                  // int
int*  p;                  // pointer to int
int** pp;                 // pointer to pointer to int
int&  r  = v;             // lvalue reference to int
int&& rr = 1;             // rvalue reference to int
int (&&rr2) = std::move(v); // parentheses do not change it
int   arr[8];             // array of 8 int
int   grid[2][16];        // array of 2 arrays of 16 int
int*  parr[8];            // array of 8 pointers to int      ([] binds first)
int (*pa)[8]  = &arr;     // pointer to array of 8 int
int (&ra)[8]  = arr;      // reference to array of 8 int
int  f(double);           // function taking double returning int
int (*pf)(double) = f;    // pointer to that function
int (&rf)(double) = f;    // reference to that function
int (*apf[4])(double);    // array of 4 such function pointers
int (*(*ppf)(char))(double); // ptr to fn(char) returning ptr to fn(double)->int

struct C { int m; int g(double); };
int  C::*pm  = &C::m;     // pointer to int data member of C
int (C::*pmf)(double) = &C::g;  // pointer to member function
C c; (c.*pmf)(1.0); C* pc = &c; (pc->*pmf)(1.0);  // invocation syntax
```

| Declaration | Read as |
|---|---|
| `int* p` | `p` is pointer to `int` |
| `int const* p` | pointer to const `int` (target read-only) |
| `int* const p` | const pointer to `int` (cannot reseat) |
| `int const* const p` | const pointer to const `int` |
| `int& r` | lvalue reference to `int` |
| `int&& r` | rvalue reference to `int` |
| `int a[8]` | array of 8 `int` |
| `int (*p)[8]` | pointer to array of 8 `int` |
| `int* p[8]` | array of 8 pointers to `int` |
| `int (*f)(double)` | pointer to function `(double) -> int` |
| `int (&f)(double)` | reference to that function |
| `int C::* p` | pointer to `int` data member of `C` |
| `int (C::* p)(double)` | pointer to member function of `C` |

```cpp
// ---- the three impossible things --------------------------------------
// int f()[8];       // ill-formed: function returning array
// int f()();        // ill-formed: function returning function
// int& a[8];        // ill-formed: array of references
using Levels = int[8];
Levels& current_levels();                 // OK: returns reference to array
auto    current_levels2() -> int (&)[8];  // same, trailing return syntax
auto    make_fn() -> int (*)(double);     // returns a function pointer
```

```cpp
// ---- function declarators ---------------------------------------------
using Handler = bool(std::span<std::byte const>) noexcept;  // function TYPE
Handler* handler = nullptr;                                 // pointer to it
auto decode(std::span<std::byte const> in) noexcept -> bool; // trailing return

bool  may_throw(int);
bool  no_throw(int) noexcept;
bool (*pt)(int)          = no_throw;   // OK: noexcept -> throwing conversion
// bool (*pn)(int) noexcept = may_throw; // ill-formed: NOT the other way
// noexcept is part of the function type since C++17.

void  legacy();                 // takes no arguments (C++: () == (void))
void  api(int, char) = delete;  // deleted declaration
void  defaulted(int a, int b = 0); // default args live in the declaration
```

```cpp
// ---- declarations declare many kinds of entity ------------------------
struct Quote;                                       // type declaration
extern Quote const* current;                        // object declaration (no def)
bool validate(Quote const&);                        // function declaration
using QuotePtr = Quote const*;                      // alias declaration
namespace px = project::execution;                  // namespace alias
enum class Side : std::uint8_t;                     // opaque enum declaration
template<class T> concept Small = sizeof(T) <= 16;  // concept definition
static_assert(Small<int>);                          // not a declaration of a name
[[maybe_unused]] int diag;                          // attributed declaration
```

**Idiom** — one declarator per declaration; it kills the `int* p, q` family and makes diffs line-local.

**Interview line** — "I read a declarator starting at the identifier and moving outward, taking `()` and `[]` before `*` and `&`, and using parentheses to override that."

**Traps** — `int* a, b;` · `int* p[8]` vs `int (*p)[8]` · top-level `const` on a by-value parameter does not change the function type, so `void f(int)` and `void f(int const)` are the same function · `void f()` in C++ is a zero-parameter function, unlike C's unspecified list · a declaration that could be a function declaration *is* one (most vexing parse, see #ch05).

---

## 2.3 `using` aliases versus `typedef`

```cpp
using   OrderId       = std::uint64_t;
typedef std::uint64_t LegacyOrderId;
static_assert(std::is_same_v<OrderId, LegacyOrderId>);   // SAME type

void cancel(OrderId);
// void cancel(LegacyOrderId);   // redeclaration, NOT an overload — ill-formed
cancel(7);                        // any uint64_t works; no domain safety
```

```cpp
// ---- using reads left-to-right; typedef reads like a declaration ------
using   Handler = bool (*)(Message const&) noexcept;
typedef bool  (*LegacyHandler)(Message const&) noexcept;   // name is buried

using   Grid  = double[2][16];
typedef double LegacyGrid[2][16];

using   Fn    = int(double);       // function type, not pointer
using   MemPtr = int Quote::*;     // pointer to data member
using   Ref   = int&;              // reference alias
```

```cpp
// ---- alias templates: `using` only ------------------------------------
template<class T>
using BookVector = std::vector<T, BookAllocator<T>>;

template<class T> using Ptr = T*;               // Ptr<int> == int*
template<class T> using Fn2 = int(T, T);        // alias to a function type
BookVector<Level> book;

// typedef cannot be templated; the pre-C++11 workaround was:
template<class T> struct BookVectorT { using type = std::vector<T>; };  // + ::type
// Alias templates are never deducible and never specializable:
// template<class T> using P = T*;   P<int> deduces nothing in P<T> parameters.
```

```cpp
// ---- alias vs strong type ---------------------------------------------
struct OrderId2 {                       // distinct type: overloadable, no mixing
    std::uint64_t value{};
    friend auto operator<=>(OrderId2, OrderId2) = default;   // C++20
    explicit constexpr operator std::uint64_t() const { return value; }
};
enum class Ticks : std::int64_t {};     // cheapest strong type: no implicit conv
```

| Facility | Creates new type? | Templatable | Overload-distinct | Runtime cost |
|---|---|---|---|---|
| `typedef X Y;` | no | no | no | none |
| `using Y = X;` | no | yes (alias template) | no | none |
| `enum class E : U {}` | **yes** | no | yes | none |
| `struct S { U v; };` | **yes** | yes | yes | none if trivial & layout-compatible |
| `using enum E;` (C++20) | no — injects enumerators | n/a | n/a | none |

**Interview line** — "An alias is a spelling, not a type; if I need the compiler to stop me mixing `Price` and `Quantity`, I need a struct or a scoped enum."

**Traps** — two aliases of the same underlying type collide as overloads · a wrapper struct is usually layout-compatible with its member but that is only an ABI *guarantee* if you assert it (`static_assert(sizeof(OrderId2) == sizeof(std::uint64_t))`) · alias templates do not participate in template argument deduction or partial specialization · `typedef` inside a dependent type still needs `typename`.

---

## 2.4 `auto`, placeholder types, and deduction boundaries

```cpp
int        value  = 7;
int const  frozen = 8;
int&       ref    = value;
int const& cref   = value;

auto        a = frozen;   // int         — top-level const DROPPED
auto        b = ref;      // int         — reference + top-level const dropped
auto        b2 = cref;    // int         — same
auto&       c = frozen;   // int const&  — referred-to cv preserved
auto const& d = value;    // int const&  — also binds temporaries
auto&&      e = value;    // int&        — forwarding ref + collapsing
auto&&      f = 9;        // int&&       — temporary's lifetime extended to f
auto*       p = &value;   // int*
auto const* q = &value;   // int const*
```

| Form | Deduction behavior |
|---|---|
| `auto x = e;` | by-value template parameter: strips `&`/`&&` and top-level cv; arrays/functions decay |
| `auto& x = e;` | must bind an lvalue (or array/function); preserves referred-to cv; **no decay** |
| `auto const& x = e;` | binds lvalues *and* prvalues; observes as const; extends temporary lifetime |
| `auto&& x = e;` | forwarding reference; lvalue → `T&`, rvalue → `T&&` |
| `auto* x = e;` | requires a pointer initializer; pointed-to cv preserved |
| `decltype(auto) x = e;` | exact `decltype` rules, no stripping (see 2.5) |
| `auto x = e1, y = e2;` | all declarators must deduce the **same** type |

```cpp
// ---- decay differences -------------------------------------------------
int arr[8]; int fn(double);
auto  ad = arr;    // int*            — array-to-pointer decay
auto& ar = arr;    // int (&)[8]      — no decay
auto  fd = fn;     // int (*)(double) — function-to-pointer decay
auto& fr = fn;     // int (&)(double)
```

```cpp
// ---- braces are a special boundary ------------------------------------
auto x  = {1, 2, 3};   // std::initializer_list<int>   (copy-list-init)
auto y{1};             // int   — since C++17, single element direct-list-init
// auto z{1, 2};       // ill-formed: >1 element with direct-list-init
// auto w = {1, 2.0};  // ill-formed: no single initializer_list element type
auto e = std::initializer_list<int>{}; // explicit spelling when you mean it

template<class T> void consume(T);
// consume({1, 2, 3});                 // ill-formed: T cannot deduce from braces
template<class T> void take(std::initializer_list<T>);
take({1, 2, 3});                       // OK: the one deducible carve-out
```

```cpp
// ---- every placeholder site -------------------------------------------
auto midpoint(int a, int b) { return a + (b - a) / 2; }   // deduced return, C++14
auto trailing(int a) -> double { return a; }              // trailing return type
void on_message(auto const& m);                           // abbreviated FT, C++20
void constrained(std::integral auto n);                   // constrained auto, C++20
auto* pp = &value;                                        // pointer placeholder
auto lam = [](auto&& x) -> decltype(auto) { return std::forward<decltype(x)>(x); };
new auto(42);                                             // allocated type is int
for (auto&& item : container) { /* generic loop binding */ }
template<auto N> struct Fixed {};  Fixed<42> fx;          // NTTP placeholder, C++17
static constexpr auto k = 3;                              // constexpr placeholder
auto [lo, hi] = std::pair{1, 2};                          // structured binding
```

```cpp
// ---- return-type deduction rules --------------------------------------
auto ok()   { if (x) return 1; return 2; }        // both int — fine
// auto bad() { if (x) return 1; return 2.0; }    // ill-formed: int vs double
auto rec(int n) -> int { return n ? rec(n - 1) : 0; }  // recursion needs a type…
auto rec2(int n) { return n ? rec2(n - 1) : 0; }       // …or a non-recursive first return
// A deduced return type is NOT known to a caller until the definition is seen:
auto declared_only();      // usable only after its definition in this TU
```

```cpp
// ---- the semantic-drift hazard ----------------------------------------
std::vector<bool> flags(8);
auto  proxy = flags[0];       // std::vector<bool>::reference — a PROXY, not bool
bool  real  = flags[0];       // materialized copy

std::map<Key, Big> m;
for (auto const& [k, v] : m) {}          // OK
// for (std::pair<Key, Big> const& kv : m)  // BINDS A TEMPORARY: value_type is
//                                          // pair<const Key, Big> — silent copy

auto row = matrix.row(0);     // expression-template proxy may dangle after the ';'
```

**Interview line** — "`auto` costs nothing at runtime; its cost is semantic — a proxy, a wide type, or a copy can slip in where the reviewer expected a reference."

**Traps** — `auto x = {1}` vs `auto x{1}` · `auto` drops `&` so range-for over expensive elements should be `auto const&`/`auto&&` · `auto` never deduces a proxy away (`vector<bool>`, expression templates, `std::bitset::reference`) · a deduced return type prevents header-only forward use · `auto` on a `const` member function's return still copies unless you write `auto&` · abbreviated function templates are templates, so they cannot be virtual and cause new instantiations.

---

## 2.5 `decltype`, `decltype(auto)`, and unevaluated operands

```cpp
// RULE 1: unparenthesized id-expression or class-member access
//         -> the DECLARED type of that entity (no value-category step).
// RULE 2: anything else -> value category encoded:
//         lvalue -> T& , xvalue -> T&& , prvalue -> T.

int x = 0;
int const cx = 0;
int& r = x;
struct Quote { long price; } q;
Quote* pq = &q;
int arr[8];
int f(double);

static_assert(std::is_same_v<decltype(x),            int>);          // rule 1
static_assert(std::is_same_v<decltype((x)),          int&>);          // rule 2, lvalue
static_assert(std::is_same_v<decltype(cx),           int const>);     // cv KEPT
static_assert(std::is_same_v<decltype((cx)),         int const&>);
static_assert(std::is_same_v<decltype(r),            int&>);          // declared type
static_assert(std::is_same_v<decltype((r)),          int&>);
static_assert(std::is_same_v<decltype(q.price),      long>);          // rule 1
static_assert(std::is_same_v<decltype((q.price)),    long&>);         // rule 2
static_assert(std::is_same_v<decltype(pq->price),    long>);          // rule 1
static_assert(std::is_same_v<decltype(std::move(x)), int&&>);         // xvalue
static_assert(std::is_same_v<decltype(x + 1),        int>);           // prvalue
static_assert(std::is_same_v<decltype(x = 1),        int&>);          // assignment is lvalue
static_assert(std::is_same_v<decltype(arr),          int[8]>);        // NO decay
static_assert(std::is_same_v<decltype(arr[0]),       int&>);          // subscript is lvalue
static_assert(std::is_same_v<decltype(f),            int(double)>);   // function type
static_assert(std::is_same_v<decltype(&f),           int(*)(double)>);
static_assert(std::is_same_v<decltype(&Quote::price), long Quote::*>);
static_assert(std::is_same_v<decltype(nullptr),      std::nullptr_t>);
static_assert(std::is_same_v<decltype("ab"),         char const(&)[3]>); // lvalue!
static_assert(std::is_same_v<decltype(true ? x : x), int&>);
```

```cpp
// ---- decltype(auto): exact preservation --------------------------------
int global = 0;

decltype(auto) by_value() { return global; }    // int   — unparenthesized name
decltype(auto) by_ref()   { return (global); }  // int&  — parentheses matter!
auto           copy()     { return (global); }  // int   — plain auto still drops &

decltype(auto) v1 = global;    // int
decltype(auto) v2 = (global);  // int&

// ---- perfect forwarding of a return value ------------------------------
template<class F, class... Args>
decltype(auto) invoke_log(F&& f, Args&&... args) {
    return std::forward<F>(f)(std::forward<Args>(args)...);  // preserves T&, T&&, T
}

// ---- the dangling footgun ----------------------------------------------
// decltype(auto) oops() { int local = 0; return (local); }  // returns int& to dead object
```

```cpp
// ---- decltype in trailing return types & SFINAE ------------------------
template<class T, class U>
auto add(T t, U u) -> decltype(t + u) { return t + u; }      // SFINAE-friendly

template<class C>
auto begin_of(C& c) -> decltype(c.begin()) { return c.begin(); }

template<class T>                 // detection idiom via declval
using process_result_t = decltype(std::declval<T&>().process());

template<class T, class = void> struct has_process : std::false_type {};
template<class T> struct has_process<T, std::void_t<process_result_t<T>>>
    : std::true_type {};

// C++20 equivalent, clearer:
template<class T> concept Processable = requires (T& t) { t.process(); };
```

| Construct | Operand evaluated? | Yields |
|---|---|---|
| `sizeof(expr)` | no | `std::size_t` byte size |
| `sizeof...(pack)` | n/a | `std::size_t` pack length |
| `alignof(T)` | n/a | `std::size_t` alignment |
| `decltype(expr)` | no | a type |
| `noexcept(expr)` | no | `constexpr bool` |
| `requires { expr; }` / `requires (…)` | no | `constexpr bool` (C++20) |
| `typeid(expr)` | **only** if operand is a polymorphic glvalue | `std::type_info const&` |
| default template args / trailing return types | no | a type |

```cpp
int i = 0;
static_assert(sizeof(i++) == sizeof(int));   // i is STILL 0 — unevaluated
static_assert(noexcept(i + 1));              // no evaluation, just a query
// Names must still be found and the expression must still be well-formed.

// std::declval<T>() is declared, never defined — usable only unevaluated.
// using bad = decltype(std::declval<int>());          // fine: int&&
// int n = std::declval<int>();                        // link/compile error by design
static_assert(std::is_same_v<decltype(std::declval<T&>()),  T&>);
static_assert(std::is_same_v<decltype(std::declval<T>()),   T&&>);
```

**Interview line** — "`decltype(x)` is `int`, `decltype((x))` is `int&` — the extra parentheses turn a declared-type query into a value-category query."

**Traps** — `decltype(auto)` on `return (x)` silently returns a reference · `decltype` does not decay arrays or functions, so `decltype(arr)` is `int[8]` · a string literal is an lvalue, so `decltype("ab")` is `char const(&)[3]` · `typeid` on a polymorphic glvalue *does* evaluate and can throw `std::bad_typeid` for a null dereference · `declval` in an evaluated context is an error by design · `decltype(a, b)` uses the comma operator and yields `b`'s category.

---

## 2.6 `const`, `volatile`, cv-qualification, and east/west const

```cpp
int value = 1;
int const* observe   = &value;   // pointer to const int  — cannot write *observe
const int* observe2  = &value;   // IDENTICAL type (west const)
int* const fixed     = &value;   // const pointer — cannot reseat, can write *fixed
int const* const both = &value;  // both
int const& cref      = value;    // reference to const int
// int& const bad;               // ill-formed: a reference is never cv-qualified

*observe = 2;      // error: target is const
observe  = nullptr; // OK: the pointer itself is not const
*fixed   = 2;      // OK
// fixed = nullptr; // error: pointer is const
```

```cpp
// ---- top-level vs low-level -------------------------------------------
void inspect(int);          // top-level const on a by-VALUE parameter
void inspect(int const);    // is NOT part of the function type -> SAME function
void read(int*);            // low-level const IS part of the type ->
void read(int const*);      // a genuine overload

int const  ci  = 5;
auto       cp  = ci;        // int          — top-level dropped by copy
int* const pc  = &value;
auto       ap  = pc;        // int*         — top-level on the pointer dropped
int const* lp  = &value;
auto       al  = lp;        // int const*   — LOW-level const survives
```

```cpp
// ---- const member functions -------------------------------------------
class Book {
    std::vector<Level> levels_;
    mutable std::mutex m_;                 // mutable: writable through const
    mutable std::size_t hits_{};           // typical cache/counter use
public:
    Level const& at(std::size_t i) const { ++hits_; return levels_[i]; }
    Level&       at(std::size_t i)       { return levels_[i]; }   // const overload pair
    void         touch() &;                // ref-qualified: lvalue objects only
    Level        take() &&;                // rvalue objects only — can steal
    int          v() const noexcept;
    // "const" here means the const overload is selected; it is a LOGICAL promise,
    // NOT a thread-safety guarantee unless the class documents one.
};
```

```cpp
// ---- const does not freeze what it reaches -----------------------------
struct View { int* p; };
int n = 0;
View const v{&n};
// v.p = nullptr;   // error: the member pointer is const
*v.p = 42;          // OK: it points to a mutable int — "shallow const"

// Also: const on a std::shared_ptr<T> restricts the pointer, not *ptr.
std::shared_ptr<int> const sp = std::make_shared<int>(0);
*sp = 7;            // OK
```

```cpp
// ---- const_cast: legal vs UB -------------------------------------------
void legacy_api(char* s);
std::string buf = "x";
legacy_api(const_cast<char*>(buf.c_str()));   // legal iff the object is not const
                                              // and the API does not write past it

int const truly_const = 5;
// *const_cast<int*>(&truly_const) = 6;       // UNDEFINED BEHAVIOR: object was
                                              // DEFINED const; may live in .rodata
int mutable_obj = 5;
int const& as_const = mutable_obj;
*const_cast<int*>(&as_const) = 6;             // defined: underlying object is non-const
```

```cpp
// ---- volatile is NOT synchronization ------------------------------------
volatile bool ready = false;      // observable access; NO atomicity, NO ordering,
                                  // NO happens-before edge, NO cache protocol.
// while (!ready) {}              // DATA RACE if another thread writes it
std::atomic<bool> ready2{false};  // correct tool
ready2.store(true, std::memory_order_release);
while (!ready2.load(std::memory_order_acquire)) {}

// Legitimate volatile: memory-mapped I/O / a register the hardware changes.
auto* status = reinterpret_cast<volatile std::uint32_t*>(0x4000'0000);
std::uint32_t s = *status;        // the read must actually happen

// C++20 deprecated: compound assignment, ++/--, and volatile-qualified
// parameters/return types on scalars.
```

| Term | Meaning |
|---|---|
| top-level cv | qualifies the declared object; discarded by copy / by-value deduction |
| low-level cv | inside a compound type; part of the type, affects overloads and conversions |
| east const `int const*` | same type as west const `const int*`; pick one and be consistent |
| `mutable` | member writable through a const object; grants **no** thread safety |
| const member fn | `this` is `T const*`; participates in overload resolution |
| ref-qualifier `&` / `&&` | restricts the value category of the object expression |
| `volatile` | each access is an observable side effect; not atomic, not ordered |
| `const` + `constexpr` | `constexpr` implies const on objects; the reverse is false |

**Interview line** — "`volatile` guarantees the access happens; `std::atomic` guarantees the access is indivisible and ordered — they solve different problems and only the second one solves threading."

**Traps** — `const` is shallow: it never propagates through a pointer member (that is what `std::experimental::propagate_const` was for) · writing through `const_cast` to an object *defined* const is UB · top-level `const` on parameters is silently ignored in declarations but still binding inside the definition · `mutable` members break the "const means safe to share" assumption · a `const` member function is not automatically thread-safe unless the class says so · `volatile std::atomic` is not the same as `std::atomic`.

---

## 2.7 Attributes: `[[nodiscard]]`, `[[maybe_unused]]`, `[[likely]]`, `[[no_unique_address]]`, and friends

| Attribute | Since | Appertains to | Meaning / limitation |
|---|---|---|---|
| `[[noreturn]]` | C++11 | function | never returns normally; **returning is UB** |
| `[[carries_dependency]]` | C++11 | param / fn | `memory_order_consume` plumbing; effectively unused |
| `[[deprecated("why")]]` | C++14 | most declarations | encourages a diagnostic on use |
| `[[fallthrough]]` | C++17 | null statement in `switch` | documents intentional fall-through |
| `[[nodiscard("why")]]` | C++17 (reason C++20) | fn, type, ctor, enum | encourages a diagnostic if the result is discarded |
| `[[maybe_unused]]` | C++17 | decl, param, label | suppresses unused-entity diagnostics |
| `[[likely]]` / `[[unlikely]]` | C++20 | statement / label | relative-likelihood hint; **no layout guarantee** |
| `[[no_unique_address]]` | C++20 | non-static data member | *permits* overlap; **no size guarantee**; ignorable |
| `[[assume(expr)]]` | C++23 | null statement | optimizer may assume `expr`; false at runtime → **UB** |

```cpp
// ---- nodiscard ---------------------------------------------------------
struct DecodeError {};
[[nodiscard("check for malformed input")]] DecodeError decode();
[[nodiscard]] struct Handle { /* every fn returning Handle now warns */ };
enum class [[nodiscard]] Status { ok, bad };
struct Guard { [[nodiscard]] explicit Guard(std::mutex&); };  // ctor form, C++20
decode();                     // warning (not an error)
(void)decode();               // conventional silencer
[[maybe_unused]] auto _ = decode();  // explicit-discard idiom

// ---- maybe_unused ------------------------------------------------------
void handle([[maybe_unused]] int seq, Payload const& p) {
    assert(seq >= 0);         // seq unused in NDEBUG builds
    [[maybe_unused]] auto n = p.size();
}

// ---- likely / unlikely -------------------------------------------------
if (fast_path()) [[likely]] { process(); }
else                        { record_error(); }

switch (tag) {
    [[likely]]   case 1: prepare(); [[fallthrough]];   // fall-through is intentional
                 case 2: process(); break;
    [[unlikely]] default: reject(); break;
}
for (auto const& m : msgs) [[likely]] { consume(m); }
while (running) [[likely]] { poll(); }

// ---- noreturn / deprecated --------------------------------------------
[[noreturn]] void fatal(char const* why) { std::fprintf(stderr, "%s", why); std::abort(); }
[[deprecated("use decode_v2")]] bool decode_v1(Message const&);

// ---- assume (C++23) ----------------------------------------------------
void scale(std::span<double> xs, std::size_t n) {
    [[assume(n % 8 == 0)]];          // lets the vectorizer drop the tail loop
    [[assume(!xs.empty())]];
    // If n % 8 != 0 at runtime, the whole program is UB — assert first in debug.
}
// The operand is UNEVALUATED: [[assume(v.pop_back(), true)]] has no side effect.
```

```cpp
// ---- no_unique_address: empty-policy compression -----------------------
struct NoopPolicy {};                 // empty class: sizeof == 1 standalone

template<class Policy>
struct Parser {
    [[no_unique_address]] Policy policy;   // may occupy zero bytes if empty
    std::uint32_t cursor{};
};
static_assert(sizeof(Parser<NoopPolicy>) == sizeof(std::uint32_t));  // typical, NOT guaranteed

// Same rules the standard library uses for allocators/comparators/deleters.
template<class T, class Deleter>
struct UniqueLike {
    T* p{};
    [[no_unique_address]] Deleter d{};
};
// Constraints: two members of the SAME empty type still need distinct addresses,
// so only one of them can be collapsed. Overlap changes address identity — do not
// assume &a.policy != &a.cursor-adjacent storage, and do not memcmp such objects.
```

```cpp
// ---- attribute syntax forms --------------------------------------------
[[nodiscard]] [[deprecated]] int f();     // multiple attribute specifiers
[[nodiscard, deprecated]]     int g();    // one specifier, two attributes
[[using gnu: hot, always_inline]] void h();  // attribute-using-prefix (C++17)
[[gnu::hot]] void h2();                   // vendor-namespaced, ignorable
alignas(64) struct Padded { int x; };     // alignas is a specifier, not [[…]]
// Unknown attributes must be IGNORED (with an optional warning), not rejected.
```

| Symptom | Cause | Repair |
|---|---|---|
| `[[nodiscard]]` result still ignored | it only *encourages* a diagnostic | `-Wall -Werror=unused-result`, plus explicit control flow |
| `[[likely]]` made the code slower | hint contradicts the real distribution | measure with representative traffic; delete the hint |
| `[[no_unique_address]]` saved nothing | implementation may ignore it; MSVC needs `[[msvc::no_unique_address]]` | check `sizeof` with a `static_assert` |
| crash only under `-O2` | `[[assume]]` violated at runtime | assert the same predicate in debug builds |
| "unused parameter" in release only | `assert` compiled out | `[[maybe_unused]]` on the parameter |
| attribute silently ignored | vendor attribute on another compiler | that is conforming behavior — never rely on it |

**Interview line** — "Standard attributes are permissions and hints with a few UB-on-violation exceptions (`[[noreturn]]`, `[[assume]]`); correctness must never depend on one being honored."

**Traps** — `[[assume]]` and `[[noreturn]]` are the two that make wrong code UB, not just slow · `[[likely]]` on a mis-predicted branch can pessimize by pushing hot code out of line · `[[no_unique_address]]` changes object layout and therefore ABI — adding it to a shipped type is a breaking change · placement is checked per attribute, and a misplaced standard attribute is ill-formed even though an unknown one is ignored · `[[nodiscard]]` on a type applies to every function returning it, which can flood a codebase with warnings.

---

**Recall card**

```text
tokens          keyword | identifier | literal | operator | punctuator
maximal munch   longest valid token wins; x+++2 == x++ + 2
declarator      start at the name, go outward; () and [] before * & &&
int* a, b;      a is int*, b is int
noexcept        part of the function type since C++17; one-way conversion
using/typedef   synonyms only — no new type, no overload split, no cost
alias template  `using` only; never deduced, never specialized
auto x = e      drops &, drops top-level cv, decays arrays/functions
auto& / auto&&  no decay; && is a forwarding reference when deduced
auto x{1}       int          |  auto x = {1}   initializer_list<int>
decltype(name)  declared type (unparenthesized id / member access)
decltype((e))   lvalue->T&   |  xvalue->T&&    |  prvalue->T
decltype(auto)  exact; `return (x);` returns a reference
unevaluated     sizeof, decltype, noexcept(e), requires, declval, most typeid
top-level cv    dropped by copy / by-value deduction
low-level cv    part of the type; overloadable; survives auto
T* const        const pointer  |  T const*  pointer to const
const           shallow: never propagates through a pointer member
volatile        observable access; NOT atomic, NOT ordered, NOT a lock
attributes      hints/permissions; [[noreturn]] & [[assume]] violation = UB

hot-path question  did deduction pick a copy, proxy, owner, view, or wider type?
```
