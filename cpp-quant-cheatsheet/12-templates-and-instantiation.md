# 12. Templates and instantiation

*Part II — Classes, resource management, and generic programming*

---

**Recall**
- A template is a compile-time recipe: `f` is not a function and `Box` is not a type — `f<int>` and `Box<int>` are.
- Instantiation forms a specialization; it happens only where a complete type or a definition is *required*.
- Class instantiation does **not** instantiate member function bodies — an unused member with nonsense in it compiles fine.
- Definitions must be reachable in the instantiating TU: that is why templates live in headers or module interfaces.
- Deduction matches parameter pattern `P` against argument type `A` with only decay, qualification, and derived-to-base conversions — no arbitrary user conversions.
- By-value deduction strips top-level cv and references and decays arrays/functions; reference parameters preserve them.
- `T&&` is a *forwarding* reference only when `T` is a cv-unqualified template parameter deduced for that very parameter (plus `auto&&`); `Widget&&` and `const T&&` are plain rvalue refs.
- Return type never drives function-template deduction; deduction is one-directional from arguments.
- Non-deduced contexts (nested-name specifier before `::`, `decltype`, default arguments, non-deduced pack positions) require explicit arguments.
- Function templates can be **fully specialized but never partially specialized** — use overloading, usually constrained.
- Overload resolution picks a primary template/overload *first*, then its explicit specialization comes along for the ride — specializations do not participate in overload ranking.
- Partial specializations of class/variable templates are ordered by partial ordering; an ambiguous best match is ill-formed.
- CTAD (C++17) chooses class-template arguments from the initializer via implicit + user-written deduction guides; a guide is not a function and constructs nothing.
- Two-phase lookup binds non-dependent names at definition and dependent names at instantiation (ADL only, for the call syntax).
- `typename` says "this dependent qualified name is a type"; `template` says "this dependent member is a template" — neither proves the member exists.
- Members of a *dependent base* are invisible to unqualified lookup: write `this->m` or `Base<T>::m`.
- Fold expressions must be parenthesized; unary folds over an empty pack are ill-formed except for `&&` (true), `||` (false), `,` (void).
- NTTPs must be *structural* types: integrals, enums, pointers/refs with linkage, member pointers, `nullptr_t`, floating point (C++20), and literal classes with all-public non-mutable structural members.
- Each distinct template-argument list is a distinct entity: more specializations means more symbols, more debug info, more I-cache — "zero-cost abstraction" is a measurable claim, not a syntactic one.
- `extern template` suppresses implicit instantiation in one TU; exactly one explicit-instantiation *definition* must exist program-wide.

---

## 12.1 Function, class, variable, and alias templates

```cpp
#include <array>
#include <cstddef>
#include <type_traits>
#include <memory>

// ---- function template -------------------------------------------------
template<class T>
constexpr T square(T x) { return x * x; }        // square is NOT a function
static_assert(square<int>(4) == 16);             // square<int> IS a function
auto* fp = &square<double>;                      // taking the address forces instantiation

template<class T> void sink(T);                  // declaration only
template<class T> void sink(T) { }               // definition (same template)

// ---- class template ----------------------------------------------------
template<class T, std::size_t N>
struct FixedBatch {
    std::array<T, N> values{};
    std::size_t size{};

    FixedBatch() = default;                      // injected-class-name: no <T,N> needed
    FixedBatch(FixedBatch const&) = default;     // inside the template, FixedBatch means FixedBatch<T,N>
    using self = FixedBatch;                     // == FixedBatch<T, N>
};

// out-of-line member definition
template<class T, std::size_t N>
struct Ring {
    void push(T v);
    static int counter;                          // static data member: declaration
};
template<class T, std::size_t N>
void Ring<T, N>::push(T) { }                     // note the full parameter list twice
template<class T, std::size_t N>
int Ring<T, N>::counter = 0;                     // one per specialization

// ---- variable template (C++14) ----------------------------------------
template<class T>
inline constexpr bool cheap_v =                  // 'inline' avoids ODR issues in headers
    std::is_trivially_copyable_v<T> && sizeof(T) <= 16;

template<class T>
constexpr T pi_v = T(3.141592653589793238L);     // value depends on T
static_assert(pi_v<float> > 3.0f);

template<class T> inline constexpr bool is_ptr_v = false;        // primary
template<class T> inline constexpr bool is_ptr_v<T*> = true;     // PARTIAL specialization: legal

// ---- alias template (C++11) -------------------------------------------
template<class T> using ReadOnly  = std::add_const_t<T>;
template<class T> using Vec2      = std::pair<T, T>;
template<class T> using OwnerOf   = std::unique_ptr<T, void(*)(T*)>;
// template<> using ReadOnly<int> = int;   // ill-formed: alias templates cannot be specialized

// customization point done right: specialize the class, alias the result
template<class T> struct wire_type            { using type = T; };
template<>        struct wire_type<bool>      { using type = unsigned char; };
template<class T> struct wire_type<T*>        { using type = std::uintptr_t; };
template<class T> using  wire_type_t = typename wire_type<T>::type;
static_assert(std::is_same_v<wire_type_t<bool>, unsigned char>);
```

```cpp
// ---- member templates --------------------------------------------------
template<class T>
struct Box {
    T value{};
    template<class U>                            // member template
    Box(Box<U> const& other) : value(other.value) {}   // converting ctor
    template<class U> U as() const { return static_cast<U>(value); }
};
Box<long> bl{Box<int>{3}};
auto d = bl.as<double>();                        // non-dependent object: no 'template' needed

// ---- friend templates --------------------------------------------------
template<class T>
class Counter {
    int n_{};
    template<class U> friend class Counter;      // every Counter<U> is a friend
    friend void reset(Counter& c) { c.n_ = 0; }  // ONE non-template friend per specialization
};
```

| Kind | Specializable (full) | Specializable (partial) | Creates a distinct entity |
|---|---|---|---|
| Function template | yes (avoid; prefer overloads) | **no** | one function per arg list |
| Class template | yes | yes | one class per arg list |
| Variable template | yes | yes | one object per arg list |
| Alias template | **no** | **no** | **no** — pure name substitution |
| Member template | yes (if enclosing is specialized/non-template) | class-scope rules apply | per enclosing × member args |

**Traps** — alias templates never create a new type, so overload resolution and specialization can't see through them · a static data member is per-specialization state, not shared · `friend void reset(Counter&)` defines a *new* non-template function for each instantiation · out-of-line member definitions must repeat the exact parameter list · a variable template in a header without `inline` risks ODR violations pre-C++17.

---

## 12.2 Type, non-type, and template-template parameters

```cpp
#include <memory>
#include <vector>
#include <concepts>

template<class T>            struct A;          // type parameter (class == typename here)
template<typename T>         struct A2;         // identical meaning
template<std::size_t N>      struct B;          // non-type (constant) parameter
template<auto V>             struct C;          // C++17: deduced NTTP type
template<std::integral T>    struct D;          // C++20: constrained type parameter
template<class... Ts>        struct E;          // type parameter pack
template<auto... Vs>         struct F;          // NTTP pack
template<template<class...> class Tmpl> struct G;   // template-template parameter

// ---- template-template parameters --------------------------------------
template<class T, template<class, class> class Sequence,
         class Allocator = std::allocator<T>>
struct UsesSequence {
    Sequence<T, Allocator> data;                 // Sequence<T, Allocator> must be well-formed
};
UsesSequence<int, std::vector> us;               // pass the TEMPLATE, not a specialization

template<template<class...> class Tmpl>          // variadic form matches more templates
struct Rebinder {
    template<class... Us> using apply = Tmpl<Us...>;
};
using IntVec = Rebinder<std::vector>::apply<int>;

// ---- default template arguments ---------------------------------------
template<class T, class Cmp = std::less<T>, std::size_t Cap = 64>
struct Heap { };
Heap<int> h1;                                     // Cmp, Cap defaulted
Heap<int, std::greater<int>, 8> h2;

// class templates: defaults may be added across declarations (accumulate)
template<class T = int> struct Later;
template<class T> struct Later { T v; };
Later<> l{};                                      // note the required <>

// function templates: defaults may appear anywhere in the list
template<class R = double, class T>
R avg(T const* p, std::size_t n) { R s{}; for (std::size_t i=0;i!=n;++i) s += R(p[i]); return s/R(n); }
```

```cpp
// ---- explicit + deduced mixing (order matters) -------------------------
template<class Result, class Input>
constexpr Result narrow_as(Input x) { return static_cast<Result>(x); }
auto ticks = narrow_as<long>(42);                 // Result explicit, Input deduced = int
// Rule: put the parameters you want to specify FIRST, deducible ones last.

// ---- 'auto' NTTP -------------------------------------------------------
template<auto Value>
struct Constant { static constexpr decltype(Value) value = Value; };
using K1 = Constant<42>;        // decltype(Value) == int
using K2 = Constant<42UL>;      // unsigned long — DIFFERENT type
enum class Side { Bid, Ask };
using K3 = Constant<Side::Bid>;

template<auto F> struct Callback { void fire() { F(); } };   // function pointer as NTTP
```

| Parameter kind | Syntax | Argument must be | Deducible? |
|---|---|---|---|
| Type | `class T` / `typename T` | a type | yes |
| Constrained type (C++20) | `std::integral T` | a type satisfying the concept | yes |
| Non-type | `std::size_t N`, `auto V` | constant expression of structural type | yes (from array extents, NTTP positions) |
| Template-template | `template<class...> class C` | a class/alias template with compatible params | yes (from `C<Args...>` patterns) |
| Type pack | `class... Ts` | zero or more types | yes (trailing) |
| NTTP pack | `auto... Vs` | zero or more constants | yes |

**Traps** — `template<class,class> class Seq` will not accept `std::vector` on some older compilers because of the defaulted allocator (P0522 fixed this; prefer `template<class...> class`) · `Later<>` still needs the angle brackets · a template-template argument is the *template name*, never `std::vector<int>` · `Constant<42>` and `Constant<42u>` are unrelated types · template parameters have no address, storage, or lifetime.

---

## 12.3 Template argument deduction and explicit arguments

```cpp
template<class T> void by_value(T);        // P = T
template<class T> void by_lref(T&);        // P = T&
template<class T> void by_cref(T const&);  // P = const T&
template<class T> void by_rref(T&&);       // FORWARDING reference (T is deduced here)
template<class T> void by_ptr(T*);

int        x{};
int const cx{};
int&       rx = x;

by_value(cx);   // T = int          top-level const dropped
by_value(rx);   // T = int          reference dropped
by_lref(cx);    // T = const int    → parameter const int&
by_cref(x);     // T = int          → parameter const int&
by_rref(x);     // T = int&  → int& &&  collapses to int&      (lvalue)
by_rref(1);     // T = int   → int&&                            (rvalue)
by_rref(cx);    // T = const int&                              (const lvalue)
```

```cpp
// ---- reference collapsing (the only four rules) ------------------------
// T&  &   -> T&      T&  && -> T&
// T&& &   -> T&      T&& && -> T&&
// "lvalue reference wins."

template<class T>
void relay(T&& arg) {
    consume(std::forward<T>(arg));   // forward<T> = static_cast<T&&>(arg)
    // std::move(arg) would ALWAYS move, even when arg came in as an lvalue.
}
```

```cpp
// ---- decay: arrays and functions ---------------------------------------
template<class T> void takes_value(T);
template<class T> void takes_ref(T&);

int   arr[7];
void  fn(int);

takes_value(arr);   // T = int*            array-to-pointer decay
takes_ref(arr);     // T = int[7]          extent PRESERVED
takes_value(fn);    // T = void(*)(int)    function-to-pointer decay
takes_ref(fn);      // T = void(int)       function type preserved

template<class T, std::size_t N>
constexpr std::size_t extent(T const (&)[N]) noexcept { return N; }
static_assert(extent(arr) == 7);          // N deduced from the array bound
```

```cpp
// ---- non-deduced contexts ----------------------------------------------
template<class T> void nd1(typename std::type_identity<T>::type);   // before ::
template<class T> void nd2(decltype(T{}) );                          // decltype expr
template<class T> void nd3(T, T = T{});                              // default arg never deduces
template<class T, class U> void nd4(U, T);                           // T after a pack/at the end is fine
template<class... Ts, class Last> void nd5(Ts..., Last);             // Ts is non-deduced (not trailing)

nd1<int>(3);              // must be explicit
// nd5(1, 2, 3);          // Ts deduced as empty; Last = int → too many args

// blocking deduction deliberately:
template<class T> void set_gain(T value, std::type_identity_t<T> floor);
set_gain(1.0, 0);         // T = double from arg 1 only; 0 converts to double
```

```cpp
// ---- conflicting deduction ---------------------------------------------
template<class T> void same(T, T);
// same(1, 2.0);          // ERROR: T = int vs double; deduction never picks a common type
same<double>(1, 2.0);     // fix 1: fix T, then ordinary conversions apply
same(1.0, 2.0);           // fix 2: make the arguments agree
template<class T, class U> void pair_of(T, U);       // fix 3: two parameters
template<class T, class U>
void promoted(T a, U b) { using C = std::common_type_t<T, U>; (void)C(a); (void)C(b); }
```

```cpp
// ---- explicit arguments + overload interaction -------------------------
template<class T> int rank(T);        // #1 template
int rank(int);                        // #2 non-template
rank(0);        // #2 — a non-template wins only when conversion sequences TIE
rank(0.0);      // #1 — T = double is an exact match, #2 would need a conversion
rank<int>(0);   // #1 forced by explicit arguments

// deduction happens per-candidate, then normal overload ranking runs:
template<class T> void g(T);      // #A
template<class T> void g(T*);     // #B  more specialized
int* p{};
g(p);   // #B by partial ordering of function templates
```

| Pattern `P` | Argument `A` | Deduced `T` | Parameter type |
|---|---|---|---|
| `T` | `const int` lvalue | `int` | `int` |
| `T` | `int&` | `int` | `int` |
| `T` | `int[7]` | `int*` | `int*` |
| `T&` | `const int` lvalue | `const int` | `const int&` |
| `T&` | `int[7]` | `int[7]` | `int(&)[7]` |
| `const T&` | `int` lvalue/rvalue | `int` | `const int&` |
| `T&&` (forwarding) | `int` lvalue | `int&` | `int&` |
| `T&&` (forwarding) | `int` rvalue | `int` | `int&&` |
| `T&&` (forwarding) | `const int` lvalue | `const int&` | `const int&` |
| `T*` | `int* const` | `int` | `int*` |
| `Cont<T>` | `std::vector<int>` | `int` | `std::vector<int>` |
| `T (*)(U)` | `int(*)(char)` | `T=int, U=char` | same |

**Interview line** — "Deduction compares the parameter *pattern* with the argument *type* using only decay, qualification conversion, and derived-to-base; it never searches user conversions and never runs backwards from the return type."

**Traps** — `std::move` only casts; it does not make deduction choose a move · a `T&&` parameter of a *class* template member is a plain rvalue ref, not forwarding · `auto&&` and `decltype(auto)` follow the same forwarding rules · braced init lists have no type: `template<class T> void f(T)` cannot deduce from `f({1,2})`, but `f(std::initializer_list<T>)` can · `const` on a *pointee* is not top-level and survives by-value deduction.

---

## 12.4 Class template argument deduction and deduction guides

```cpp
#include <utility>
#include <vector>
#include <mutex>
#include <iterator>

std::pair p{42, 3.5};              // pair<int, double>
std::vector v{1, 2, 3};            // vector<int>
std::array a{1, 2, 3};             // array<int, 3>
std::lock_guard lk{mtx};           // lock_guard<std::mutex>
std::tuple t{1, 'c', 2.0};         // tuple<int, char, double>

// ---- implicit guides come from the constructors ------------------------
template<class T>
struct Window {
    T first, last;
    Window(T f, T l) : first(f), last(l) {}
};
Window w{1, 5};                    // Window<int> from the implicit guide

// ---- aggregate CTAD (C++20) -------------------------------------------
template<class T> struct Sample { T value; int tag; };
Sample s{42, 1};                   // Sample<int> — no constructor needed

// ---- user-written deduction guide --------------------------------------
template<class It>
Window(It, It) -> Window<typename std::iterator_traits<It>::value_type>;

template<class T> Window(T) -> Window<T>;                    // one-arg form
template<class T> Window(std::initializer_list<T>) -> Window<T>;
Window w2(vec.begin(), vec.end());  // Window<int> via the iterator guide

// ---- guide that strips references / decays ------------------------------
template<class T> struct Held { T value; };
template<class T> Held(T) -> Held<T>;              // decays: Held<char*> from a string literal
template<class T> Held(T&&) -> Held<std::decay_t<T>>;

// ---- explicit guides and conditional deduction --------------------------
template<class T> struct Owner { T v; };
template<class T> explicit Owner(T) -> Owner<T>;   // guide can be 'explicit': blocks copy-init CTAD
// Owner o = 1;   // ill-formed with an explicit guide
Owner o{1};       // ok

// ---- alias-template CTAD (C++20) ---------------------------------------
template<class T> using IntPair = std::pair<int, T>;
IntPair ip{1, 2.0};                // pair<int, double>
```

```cpp
// ---- the copy deduction candidate --------------------------------------
std::vector<int> src{1,2,3};
std::vector v1{src};        // vector<int>, a COPY — not vector<vector<int>>
std::vector v2{src, src};   // vector<vector<int>> — two elements
auto v3 = std::vector{std::vector<int>{}};   // still vector<int>: copy candidate wins
```

| CTAD source | When it applies | Note |
|---|---|---|
| Implicit guides from constructors | always | one per constructor, plus the copy candidate |
| Aggregate guides (C++20) | class is an aggregate | element-wise from the braced initializer |
| User-written `Tmpl(args) -> Tmpl<X>` | at namespace scope, same scope as the template | not a function; never called; no body |
| Copy deduction candidate | initializer is (a ref to) the same template | prefers copy over nesting |
| Alias-template CTAD (C++20) | `Alias x{...}` | deduces through the alias |
| Inherited constructors | never — CTAD ignores them | spell the type |

**Interview line** — "A deduction guide is not a function: it maps initializer types to a class specialization, and only after that specialization is fixed does ordinary overload resolution pick the constructor."

**Traps** — CTAD applies only when *no* template argument list is written; `std::vector<>` is ill-formed · after CTAD picks the type, braces still prefer an `initializer_list` constructor (`std::vector v(3, 0)` is 3 zeros; `std::vector v{3, 0}` is `{3,0}`) · guides do not participate in function calls and cannot be found by ADL · CTAD on a reference member erases `&`/cv — spell types explicitly at API boundaries · partial explicit argument lists disable CTAD entirely.

---

## 12.5 Full and partial specialization

```cpp
// ---- class templates ----------------------------------------------------
template<class T>            struct Codec           { static constexpr int kind = 0; };  // primary
template<>                   struct Codec<bool>     { static constexpr int kind = 1; };  // FULL
template<class T>            struct Codec<T*>       { static constexpr int kind = 2; };  // partial
template<class T>            struct Codec<T const>  { static constexpr int kind = 3; };  // partial
template<class T, std::size_t N> struct Codec<T[N]> { static constexpr int kind = 4; };  // partial
template<class R, class... A> struct Codec<R(A...)> { static constexpr int kind = 5; };  // signature

static_assert(Codec<int>::kind == 0 && Codec<bool>::kind == 1 && Codec<int*>::kind == 2);

// specializing a single MEMBER of a class template
template<class T> struct Trait { static int describe(); };
template<> int Trait<double>::describe() { return -1; }        // member full specialization

// ---- variable templates -------------------------------------------------
template<class T> inline constexpr std::size_t tag_v      = 0;
template<>        inline constexpr std::size_t tag_v<int>  = 1;   // full
template<class T> inline constexpr std::size_t tag_v<T*>   = 2;   // partial

// ---- function templates -------------------------------------------------
template<class T> void encode(T const&);            // primary
template<>        void encode<bool>(bool const&);   // FULL specialization: legal but discouraged
// template<class T> void encode(T* const&);        // "partial specialization" of a function: ILL-FORMED
template<class T> void encode(T* const&);           // ...this is an OVERLOAD, and that is the fix
void encode(bool);                                  // non-template overload: preferred solution
```

```cpp
// ---- why specializing functions surprises you --------------------------
template<class T> void h(T);        // #1
template<class T> void h(T*);       // #2
template<>        void h<int*>(int*){}   // specializes #2 (better match at declaration time)
int* p{};
h(p);   // calls the #2 specialization
// Move the explicit specialization ABOVE #2 and it specializes #1 instead —
// same code, different behavior. Hence: overload, do not specialize.
```

```cpp
// ---- C++20 constrained overloads replace most specialization tricks -----
#include <concepts>
template<class T> void store(T v);                                   // general
template<std::integral T> void store(T v);                           // more constrained wins
template<class T> requires std::floating_point<T> void store(T v);   // requires-clause form
```

| Category | Full specialization | Partial specialization | Notes |
|---|---:|---:|---|
| Class template | yes | yes | partial spec must be more specialized than the primary |
| Variable template | yes | yes | since C++14 |
| Function template | yes | **no** | use overloading / constraints |
| Alias template | **no** | **no** | specialize an underlying class |
| Member function of class template | yes | n/a | must be at namespace scope of the enclosing namespace |
| Member class/variable template | yes | yes | |

```cpp
// ---- specializing std: the narrow legal path ---------------------------
struct OrderId { std::uint64_t v; bool operator==(OrderId const&) const = default; };

template<>
struct std::hash<OrderId> {                       // allowed: program-defined type, all requirements met
    std::size_t operator()(OrderId const& k) const noexcept {
        return std::hash<std::uint64_t>{}(k.v);
    }
};
// NOT allowed: adding overloads to namespace std, partially specializing most std templates,
// or specializing anything for a type that contains no program-defined type.
```

**Traps** — a full specialization must be *declared before* the first use that would implicitly instantiate it, in every TU, or the program is IFNDR · full specializations of function templates are not overloads and are invisible to partial ordering · `template<> struct X<int>;` at class scope must be at enclosing namespace scope pre-C++17 · default template arguments may not appear on a partial specialization · a partial specialization's argument list may not be identical to the primary's parameter list.

---

## 12.6 Explicit instantiation and `extern template`

```cpp
// ===== stats.hpp =========================================================
#pragma once
#include <cstddef>

template<class T>
T sum(T const* p, std::size_t n);                       // declaration only

template<class T>
class Accumulator {
public:
    void add(T v);
    T total() const;
private:
    T total_{};
};

extern template T   sum<long>(long const*, std::size_t);  // explicit-instantiation DECLARATION
extern template class Accumulator<long>;                  // suppresses implicit inst. in includers
```

```cpp
// ===== stats.cpp =========================================================
#include "stats.hpp"

template<class T>
T sum(T const* p, std::size_t n) {                       // definition visible HERE
    T total{};
    for (std::size_t i = 0; i != n; ++i) total += p[i];
    return total;
}
template<class T> void Accumulator<T>::add(T v) { total_ += v; }
template<class T> T    Accumulator<T>::total() const { return total_; }

template long sum<long>(long const*, std::size_t);   // explicit-instantiation DEFINITION
template long sum(long const*, std::size_t);         // same thing, arguments deduced
template class Accumulator<long>;                    // instantiates ALL members whose defs are visible
template class Accumulator<double>;                  // a second supported specialization
```

```cpp
// ---- other spellings ----------------------------------------------------
template struct FixedBatch<int, 8>;         // class template, struct keyword
template int Ring<int,8>::counter;          // a single static data member
template void Ring<int,8>::push(int);       // a single member function
extern template class std::vector<MyType>;  // legal: suppress local instantiation of a std template
```

| Construct | Spelling | Effect |
|---|---|---|
| Implicit instantiation | (none — triggered by use) | forms only what is needed, where needed |
| Explicit inst. definition | `template class X<int>;` | emits the specialization in this TU; exactly one per program |
| Explicit inst. declaration | `extern template class X<int>;` | *suppresses* implicit instantiation in this TU |
| Member-only inst. | `template void X<int>::f();` | emits one member |
| Forcing a class complete | `sizeof(X<int>)`, deriving, member access | instantiates the class, not member bodies |

- Explicit instantiation of a class instantiates every non-inherited, non-template member whose definition is visible at that point — and silently skips ones that are not.
- A member whose body would be ill-formed for that `T` makes explicit class instantiation fail where implicit instantiation would have been fine.
- `extern template` is a *promise* that the definition exists elsewhere; a missing explicit-instantiation definition becomes a link error, not a compile error.
- The pattern trades compile time for a closed type set and, without LTO, blocks cross-TU inlining of those specializations.

```text
Symptom: "undefined reference to void f<int>(int)"
Cause:   template definition sat in a .cpp; the calling TU saw only the declaration.
Fixes:   (a) move the definition into the header / module interface
         (b) add `template void f<int>(int);` to the defining .cpp and declare
             `extern template void f<int>(int);` in the header
```

**Traps** — an explicit-instantiation *definition* in a header ODR-violates across TUs (that's what `extern template` is for) · `extern template` does not stop constexpr evaluation or `inline` member emission requirements · the two must agree exactly in signature · explicit instantiation cannot rescue a specialization the compiler has already implicitly instantiated in the same TU.

---

## 12.7 Dependent names, two-phase lookup, `typename`, and `template`

```cpp
void audit(int);                       // visible at definition

template<class T>
void process(T const& x) {
    audit(0);        // NON-dependent: bound now, at template definition
    inspect(x);      // DEPENDENT: looked up at instantiation, ADL only (no ordinary lookup rerun)
    audit(x);        // dependent because x is: ordinary lookup at definition + ADL at instantiation
}
```

```cpp
// ---- typename: a dependent qualified name is a type --------------------
template<class Range>
void read(Range const& r) {
    typename Range::const_iterator it = r.begin();      // required
    typename Range::value_type     v{};                 // required
    typename std::vector<Range>::size_type n{};         // required (dependent nested name)
    std::vector<Range> local;                           // NOT required: not a nested dependent name
    (void)it; (void)v; (void)n;
}

template<class T> struct Wrap : typename T::base { };   // ILL-FORMED: forbidden in base-specifier
template<class T> struct Wrap2 : T::base { };           // correct — grammar already demands a type

// C++20 relaxed 'typename' where only a type can appear:
template<class T> T::value_type f20(T t);               // C++20: OK, return type position
template<class T> auto g20() -> T::value_type;          // C++20
```

```cpp
// ---- template: a dependent name is a template --------------------------
template<class Parser>
auto read_u32(Parser& p) {
    return p.template read<unsigned>();      // after '.', dependent member template
}
template<class T> void via_ptr(T* p) { p->template get<0>(); }        // after '->'
template<class T> void via_qual()    { typename T::template rebind<int>::other x; (void)x; }
// Without 'template', '<' parses as less-than: "p.read < unsigned > ()".
```

```cpp
// ---- dependent bases: unqualified lookup does NOT see them --------------
template<class T> struct Base { void reset(); int n; };

template<class T>
struct Derived : Base<T> {
    void clear() {
        // reset();          // ERROR: not found — Base<T> is a dependent base
        this->reset();       // fix 1: makes the call dependent
        Base<T>::reset();    // fix 2: qualified (also disables virtual dispatch)
        using Base<T>::n;    // fix 3 (at class scope): using-declaration
    }
};

// ---- current instantiation ---------------------------------------------
template<class T>
struct Node {
    Node* next;              // 'Node' is the injected-class-name = Node<T>, a member of the
    Node<T>* also;           // CURRENT instantiation → looked up at definition, no typename needed
    using ptr = Node*;
};
```

| Situation | Needs `typename` | Needs `template` |
|---|---|---|
| `T::type x;` in a body | yes | no |
| `T::template tmpl<int>::type x;` | yes (leading) | yes (before `tmpl`) |
| `obj.f<int>()` where `obj` is dependent | no | yes |
| `std::vector<T> v;` | no | no |
| Base-specifier `struct D : T::base` | **forbidden** | allowed if `T::template base<...>` |
| Return type / trailing return (C++20) | optional | as needed |
| `using X = T::type;` (C++20) | optional | |
| Member of the *current* instantiation | no | no |

**Interview line** — "Two-phase lookup is not compiling the template twice: it fixes non-dependent names at definition and defers only dependent ones to instantiation, where ADL is the sole lookup for dependent call names."

**Traps** — MSVC's `/permissive` mode historically accepted missing `typename`/`this->`; portable code must not rely on it · a dependent call finds *only* ADL-reachable functions at instantiation, so a helper declared later in the same namespace but with no associated argument type is invisible · `Base<T>::reset()` suppresses virtual dispatch · adding overloads after the template definition cannot change a non-dependent call's binding (that is the point).

---

## 12.8 Variadic templates, parameter packs, and fold expressions

```cpp
#include <functional>
#include <utility>

template<class... Ts>
struct Pack {
    static constexpr std::size_t size = sizeof...(Ts);      // pack size at compile time
};

template<class... Ts>
void count(Ts&&... xs) {
    static_assert(sizeof...(Ts) == sizeof...(xs));          // both spellings work
}

// ---- the four fold forms ------------------------------------------------
template<class... Ts> constexpr auto sum_r(Ts... xs) { return (xs + ...); }        // unary RIGHT: x1+(x2+(x3))
template<class... Ts> constexpr auto sum_l(Ts... xs) { return (... + xs); }        // unary LEFT : ((x1+x2)+x3)
template<class... Ts> constexpr auto sum_r0(Ts... xs){ return (xs + ... + 0); }    // binary RIGHT
template<class... Ts> constexpr auto sum_l0(Ts... xs){ return (0 + ... + xs); }    // binary LEFT
```

```text
(pack op ...)            unary right   E1 op (E2 op (... op En))
(... op pack)            unary left    ((E1 op E2) op ...) op En
(pack op ... op init)    binary right  E1 op (... op (En op init))
(init op ... op pack)    binary left   ((init op E1) op ...) op En
Parentheses are part of the grammar — you cannot omit them.
```

```cpp
// ---- empty-pack behaviour ----------------------------------------------
// Only these three unary folds are valid on an EMPTY pack:
template<class... B> constexpr bool all_of_v  = (B::value && ...);   // empty -> true
template<class... B> constexpr bool any_of_v  = (B::value || ...);   // empty -> false
template<class... F> void run(F... f)         { (f(), ...); }        // empty -> void()
// (xs + ...) with an empty pack is ILL-FORMED. Use the binary form with an identity.
```

```cpp
// ---- idiomatic folds ----------------------------------------------------
template<class T, class... Us>
constexpr bool is_any_of = (std::is_same_v<T, Us> || ...);

template<class... Ts>
void print_all(std::ostream& os, Ts const&... xs) { ((os << xs << ' '), ...); }   // comma fold

template<class F, class... Ts>
constexpr void for_each_arg(F&& f, Ts&&... xs) {
    (std::invoke(f, std::forward<Ts>(xs)), ...);      // left-to-right, comma sequences
}

template<class... Ts>
constexpr auto min_of(Ts... xs) {
    using C = std::common_type_t<Ts...>;
    C best = std::numeric_limits<C>::max();
    ((best = xs < best ? C(xs) : best), ...);
    return best;
}

template<class... Ts>
auto push_all(std::vector<std::common_type_t<Ts...>>& v, Ts&&... xs) {
    v.reserve(v.size() + sizeof...(xs));
    (v.push_back(std::forward<Ts>(xs)), ...);
}
```

```cpp
// ---- pack expansion patterns -------------------------------------------
template<class... Ts> struct Tup;
template<class... Ts> void expand(Ts... xs) {
    Tup<Ts...>              a;    // T1, T2, ...
    Tup<Ts*...>             b;    // T1*, T2*, ...
    Tup<std::decay_t<Ts>...> c;   // pattern applies to each
    Tup<Tup<Ts, Ts>...>     d;    // Tup<T1,T1>, Tup<T2,T2>, ...
    f(xs...);                     // f(x1, x2, ...)
    f(&xs...);                    // f(&x1, &x2, ...)
    f(g(xs)...);                  // f(g(x1), g(x2), ...)
    f(g(xs...));                  // ONE call: g(x1, x2, ...)
    int arr[]{ (xs, 0)... , 0 };  // pre-C++17 expansion trick
    (void)a;(void)b;(void)c;(void)d;(void)arr;
}

// multiple packs expand TOGETHER and must have equal length
template<class... As, class... Bs>
void zip(std::tuple<As...> a, std::tuple<Bs...> b) requires (sizeof...(As) == sizeof...(Bs));

// ---- recursive processing (pre-fold style, still needed for head/tail) --
template<class T> void emit(T const& t) { }
template<class T, class... Rest>
void emit(T const& t, Rest const&... rest) { emit(t); if constexpr (sizeof...(rest)) emit(rest...); }

// ---- index_sequence: expanding over indices ----------------------------
template<class Tuple, std::size_t... I>
void apply_impl(Tuple&& t, std::index_sequence<I...>) {
    (use(std::get<I>(std::forward<Tuple>(t))), ...);
}
template<class... Ts>
void apply_all(std::tuple<Ts...>& t) { apply_impl(t, std::index_sequence_for<Ts...>{}); }

// ---- pack in a lambda (C++20 init-capture pack) ------------------------
template<class... Ts>
auto bind_all(Ts&&... xs) {
    return [...args = std::forward<Ts>(xs)]() { (use(args), ...); };   // C++20
}
```

| Facility | Header | Meaning |
|---|---|---|
| `sizeof...(pack)` | — | element count, `std::size_t`, compile time |
| `std::index_sequence<I...>` | `<utility>` | pack of `std::size_t` |
| `std::make_index_sequence<N>` | `<utility>` | `index_sequence<0..N-1>` |
| `std::index_sequence_for<Ts...>` | `<utility>` | indices matching a type pack |
| `std::tuple_size_v<T>` / `std::tuple_element_t<I,T>` | `<tuple>` | tuple-like introspection |
| `std::apply(f, tup)` | `<tuple>` | call `f` with the tuple's elements |
| `std::invoke(f, args...)` | `<functional>` | uniform call, handles member pointers |
| `[...xs = expr]` | — | C++20 init-capture of a pack |

**Traps** — `(xs + ...)` on an empty pack is a hard error; `(0 + ... + xs)` is not · subtraction/division/assignment/`<<` are order-sensitive — pick left vs right deliberately · a comma fold guarantees left-to-right sequencing only for the *built-in* comma; an overloaded `operator,` breaks it (guard with `(void)`) · `f(g(xs)...)` and `f(g(xs...))` are entirely different calls · packs cannot be indexed directly before C++26 pack indexing — go through `std::get`/`index_sequence` · deep recursive expansion is a real compile-time cost; folds are cheaper.

---

## 12.9 Non-type template parameters and structural types

```cpp
#include <cstddef>
#include <algorithm>

// ---- classic NTTPs ------------------------------------------------------
template<std::size_t Capacity>
struct QueueIndex {
    static_assert(Capacity > 0 && (Capacity & (Capacity - 1)) == 0, "power of two");
    static constexpr std::size_t capacity = Capacity;
    static constexpr std::size_t mask     = Capacity - 1;
};

template<int N>             struct I {};      // integral
template<bool B>            struct Bo {};     // bool
template<char C>            struct Ch {};     // char
enum class Side { Bid, Ask };
template<Side S>            struct Book {};   // enum
template<int* P>            struct Ptr {};    // pointer to object with linkage
template<int& R>            struct Ref {};    // reference
template<std::nullptr_t>    struct Null {};   // nullptr_t
template<void(*F)(int)>     struct Fn {};     // function pointer
struct S2 { int m; void f(); };
template<int S2::* M>       struct Mem {};    // pointer to data member
template<void (S2::*M)()>   struct MemF {};   // pointer to member function
template<double D>          struct Fp {};     // C++20: floating point
template<auto V>            struct Any {};    // C++17: deduced

inline int global{};                          // must have linkage & static storage duration
using P1 = Ptr<&global>;
using R1 = Ref<global>;
using M1 = Mem<&S2::m>;
```

```cpp
// ---- structural class types (C++20) ------------------------------------
struct Scale {                                 // structural: literal, all members public,
    int numerator;                             // non-mutable, and themselves structural
    int denominator;
    constexpr bool operator==(Scale const&) const = default;
};

template<Scale S>
struct ScaledPrice {
    static_assert(S.denominator != 0);
    static constexpr long apply(long raw) { return raw * S.numerator / S.denominator; }
};
using Cents = ScaledPrice<Scale{1, 100}>;
static_assert(Cents::apply(500) == 5);

// Template-argument identity uses the member-wise value, not operator==:
// ScaledPrice<Scale{1,2}> and ScaledPrice<Scale{1,2}> are the SAME type.
```

```cpp
// ---- compile-time strings: the FixedString idiom -----------------------
template<std::size_t N>
struct FixedString {
    char data[N]{};                                    // public array member -> structural
    constexpr FixedString(char const (&s)[N]) { std::copy_n(s, N, data); }
    constexpr std::size_t size() const noexcept { return N - 1; }   // minus '\0'
    constexpr operator std::string_view() const { return {data, N - 1}; }
    constexpr bool operator==(FixedString const&) const = default;
};
template<std::size_t N> FixedString(char const (&)[N]) -> FixedString<N>;   // guide

template<FixedString Name>
struct FieldTag {
    static constexpr std::string_view name = Name;
};
using PriceField = FieldTag<"price">;                  // CTAD on the NTTP: FixedString<6>
static_assert(PriceField::name == "price");

// Why not `template<const char* S>`? A string literal has no linkage and is not
// a permitted constant template argument; each literal would also be a distinct object.
```

| Allowed NTTP type | Since | Constraint |
|---|---|---|
| Integral / enum | C++98 | converted constant expression |
| Pointer / reference to object or function | C++98 | must have linkage; C++17 relaxed to any constant address |
| `std::nullptr_t` | C++11 | only `nullptr` |
| Pointer to member | C++98 | `&C::m` |
| `auto` deduced | C++17 | type comes from the argument |
| Floating point | C++20 | equality is exact bit-pattern based |
| Literal class (structural) | C++20 | all base/non-static members public, non-mutable, structural; no user-provided `operator==` needed for identity |
| Lambda closure type | C++20 | stateless closures are structural via `auto` in some contexts |

**Traps** — every distinct value is a distinct type: `FieldTag<"a">` and `FieldTag<"b">` multiply symbols, debug info, and instantiation time · a `private` member makes a class non-structural, so no encapsulation in NTTP types · floating-point NTTPs compare by value representation (`-0.0` vs `0.0`, NaN) — avoid in portable code · reference NTTPs bind to entities, not values · `template<auto V>` makes `V`'s *type* part of the identity, so `X<0>` and `X<0u>` differ · non-type arguments must be constant expressions, not merely `const` variables of non-integral type.

---

## 12.10 Template code bloat, compile-time cost, and ABI boundaries

```cpp
// ---- 1. hoist type-independent work out of the template ----------------
[[noreturn]] void throw_out_of_range(std::size_t i, std::size_t n);   // non-template, one copy

template<class T>
T& checked(std::vector<T>& v, std::size_t i) {
    if (i >= v.size()) throw_out_of_range(i, v.size());   // cold path not duplicated per T
    return v[i];
}

// ---- 2. thin generic edge, fat non-generic core ------------------------
struct DecodeOptions { bool strict; };
void decode_bytes(std::span<std::byte const>, DecodeOptions);          // ABI boundary, one symbol

template<std::contiguous_iterator It>
void decode(It first, It last, DecodeOptions options) {
    decode_bytes(std::as_bytes(std::span{first, last}), options);      // inlines to a call
}

// ---- 3. share the body, vary only the pointer (erase to void*) ---------
void sort_erased(void* base, std::size_t n, std::size_t stride,
                 bool (*less)(void const*, void const*));
template<class T>
void sort_typed(std::span<T> s) {
    sort_erased(s.data(), s.size(), sizeof(T),
                [](void const* a, void const* b) { return *static_cast<T const*>(a)
                                                        < *static_cast<T const*>(b); });
}

// ---- 4. if constexpr keeps ONE template instead of N overloads ---------
template<class T>
std::size_t encode(T const& v, std::byte* out) {
    if constexpr (std::is_trivially_copyable_v<T>) {   // discarded branch is not instantiated
        std::memcpy(out, &v, sizeof v);
        return sizeof v;
    } else {
        return v.encode_to(out);
    }
    // still ONE function body per T that reaches here.
}

// ---- 5. type erasure when the caller count dominates -------------------
class AnySink {                       // one symbol for all sinks; virtual call per use
public:
    virtual void write(std::span<std::byte const>) = 0;
    virtual ~AnySink() = default;
};
void publish(AnySink&, std::span<std::byte const>);   // non-template, stable ABI
```

```cpp
// ---- compile-time hygiene ----------------------------------------------
template<class T> struct Trait;             // forward declare instead of #include where possible
extern template class Accumulator<long>;    // stop re-instantiating in every TU
// prefer:  fold expressions   over  recursive variadic templates   (O(1) vs O(N) instantiations)
// prefer:  alias templates    over  ::type-bearing metafunction chains
// prefer:  concepts + requires over  SFINAE enable_if chains (better errors, fewer candidates)
// prefer:  std::type_identity_t<T> over  extra deduced parameters
```

| Technique | Benefit | Cost |
|---|---|---|
| Definitions in headers | full visibility → inlining, constant propagation | reparse + reinstantiate per TU; header fan-out |
| Many distinct arg lists | exact static behaviour, no branches | symbol/debug/I-cache multiplication |
| `if constexpr` in one template | dead branches never instantiated | still one body per instantiated `T` |
| Explicit instantiation + `extern template` | one emission, fast rebuilds | closed type set; no cross-TU inlining without LTO |
| Thin template → non-template core | small callers, stable ABI | one indirect call; loses per-type optimization |
| Type erasure (`function`, vtable, `void*`) | one symbol, ABI stability | indirection, possible allocation, no inlining |
| Modules / PCH | less repeated parsing | build complexity; no runtime effect |
| `extern`-ing cold paths (throw helpers) | shrinks every instantiation | none material |
| Unity builds / fewer TUs | shares instantiation work | worse incremental builds |

- Distinct specializations are distinct entities even when the emitted instructions are byte-identical; identical-COMDAT-folding (`-Wl,--icf=all`, MSVC `/OPT:ICF`) is a linker favour, not a language guarantee.
- Template code in a shared library's headers is part of its ABI: changing a member's *body* changes what callers inlined.
- Measure with `-ftime-trace` (Clang) / `/d1reportTime` (MSVC), `nm -C --size-sort`, and `bloaty`; do not guess.

```bash
clang++ -std=c++23 -ftime-trace -c hot.cpp     # per-instantiation compile timings
nm -C --size-sort -S build/libx.a | tail -40   # biggest emitted symbols
c++filt < syms.txt | sort | uniq -c | sort -rn # which specializations dominate
bloaty -d compileunits,symbols ./app           # binary size attribution
```

**Interview line** — "Templates make abstraction free at *runtime* only when the optimizer sees through them; they are never free at compile time, in binary size, or in instruction cache."

**Traps** — recursive variadic templates cost O(N) instantiations and dominate build time; folds and `index_sequence` are O(1) · `std::function` in a hot path adds an indirect call plus possible allocation that a template would have avoided · a `template<int N>` parameter used only for a loop bound can silently create dozens of near-identical functions · debug builds do not inline the thin wrappers, so "zero-cost" wrappers are very much non-zero at `-O0` · changing a header-defined template body is an ABI-affecting change for anyone who already inlined it.
