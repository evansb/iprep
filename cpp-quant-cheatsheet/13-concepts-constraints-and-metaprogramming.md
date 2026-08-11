# 13. Concepts, constraints, and metaprogramming

*Part II — Classes, resource management, and generic programming*

---

**Recall**
- A *requires-clause* constrains a declaration; a *requires-expression* is a `bool` prvalue that reports whether requirements are well-formed.
- Requirement operands inside a requires-expression are **unevaluated** — no code runs, no side effects, no ODR-use.
- Four requirement kinds: simple (`e;`), type (`typename T::X;`), compound (`{ e } noexcept -> C;`), nested (`requires P<T>;`).
- A compound requirement applies the result constraint to `decltype((e))`, so lvalue results carry a reference — `same_as<T>` and `same_as<T&>` differ.
- A failed constraint makes a templated candidate **non-viable**; it is not a runtime branch and the body is never instantiated.
- Constrained candidates are ordered by *subsumption* over **normalized atomic constraints**, not by logical implication — the compiler is not a theorem prover.
- Atomic constraints compare identical only when they came from the *same* source expression with equivalent parameter mappings — reuse a named concept to get subsumption.
- Constraint conjunction/disjunction short-circuit left to right during satisfaction checking, so put the prerequisite first.
- Concepts must not be explicitly specialized or partially specialized; model the underlying trait instead.
- A satisfied concept proves **syntax**, never semantics: `strict_weak_order` cannot prove transitivity, `regular_invocable` cannot prove purity.
- SFINAE removes a candidate only for substitution failures in the **immediate context**; errors in an instantiated body or a transitive instantiation are hard errors.
- `std::void_t` + partial specialization is the pre-C++20 detection idiom; a requires-expression replaces it with better diagnostics.
- `remove_cvref_t` strips ref + top-level cv only; `decay_t` additionally decays arrays and functions to pointers.
- Specializing standard traits is UB unless the standard explicitly permits it for that trait (`common_type`, `common_reference`, a few others).
- `if constexpr` discards the unselected substatement — it is not instantiated for dependent code but must still parse and be non-dependently valid.
- `static_assert(false)` in a template body is only safe when the condition is **dependent** (`dependent_false_v<T>`); C++23 (P2593) relaxed this but toolchains vary.
- `consteval` requires every potentially-evaluated call to be an immediate invocation; `if consteval` (C++23) branches on manifest constant evaluation.
- Constant evaluation may allocate **transiently**, but storage must be freed inside the same evaluation — a `constexpr std::vector` cannot survive into runtime; `std::array` is the persistent table type.
- Constraints, traits, `static_assert`, and discarded branches add **zero** runtime instructions; they change cost only by selecting different code.
- Compile-time work is not free: specialization blow-up costs build time, debug info, binary size, and instruction-cache locality.

---

## 13.1 `requires` clauses and requires-expressions

```cpp
#include <concepts>
#include <cstddef>
#include <type_traits>

// ---- four equivalent ways to constrain one function --------------------
template<class T> requires std::integral<T>          // leading requires-clause
constexpr T twice_a(T x) { return x + x; }

template<class T>
constexpr T twice_b(T x) requires std::integral<T>   // trailing requires-clause
{ return x + x; }

template<std::integral T>                            // type-constraint on the param
constexpr T twice_c(T x) { return x + x; }

constexpr auto twice_d(std::integral auto x)         // abbreviated / terse syntax
{ return x + x; }

// ---- constraint-expression grammar ------------------------------------
// A requires-clause takes a *constraint-logical-or-expression*: primary
// expressions joined by && and ||. Anything else needs parentheses.
template<class T> requires (sizeof(T) <= 16)                     // parens REQUIRED
void a(T);
template<class T> requires std::integral<T> || std::floating_point<T>   // OK bare
void b(T);
template<class T> requires (!std::is_pointer_v<T>)               // parens REQUIRED for !
void c(T);
template<class T> requires requires { typename T::type; }        // requires requires
void d(T);
```

```cpp
// ---- requires-expression: all four requirement forms -------------------
template<class T>
concept QuoteLike = requires(T const& q, typename T::price_type p) {  // local params
    typename T::price_type;                                 // TYPE requirement
    q.bid();                                                // SIMPLE: well-formed?
    { q.ask() };                                            // COMPOUND, no constraint
    { q.mid() } -> std::convertible_to<typename T::price_type>;  // COMPOUND + constraint
    { q.tick() } noexcept;                                  // COMPOUND + noexcept
    { q.size() } noexcept -> std::same_as<std::size_t>;     // both
    requires sizeof(T) <= 64;                               // NESTED requirement
    requires std::copyable<T>;                              // NESTED, named concept
};

static_assert(std::same_as<decltype(requires { true; }), bool>);  // prvalue bool
```

```cpp
// ---- reference-preserving result constraints ---------------------------
// The result constraint C is checked as C<decltype((expr)), Args...>.
template<class T>
concept FrontByValue = requires(T& t) { { t.front() } -> std::same_as<typename T::value_type>; };
template<class T>
concept FrontByRef   = requires(T& t) { { t.front() } -> std::same_as<typename T::value_type&>; };
// std::vector<int> models FrontByRef, NOT FrontByValue.

// Prefer a decay-tolerant constraint when you only care about the value type:
template<class T>
concept FrontIsInt = requires(T& t) { { t.front() } -> std::convertible_to<int>; };
```

```cpp
// ---- requires-expression outside a concept -----------------------------
template<class T>
void store(T v) {
    if constexpr (requires { v.reserve(1uz); }) { /* ... */ }   // ad-hoc, inline
}
constexpr bool int_addable = requires(int a, int b) { a + b; };  // constant init
```

| Form | Spelling | Checks |
|---|---|---|
| Simple | `e;` | `e` is well-formed; result discarded, not evaluated |
| Type | `typename T::X;` / `typename A<T>;` | the type-id names a valid type |
| Compound | `{ e } noexcept -> C;` | validity · optional `noexcept(e)` · `C<decltype((e))>` |
| Nested | `requires CE;` | the constraint-expression `CE` is *satisfied* |

| Placement | Legal on | Note |
|---|---|---|
| Leading `requires` after template-parameter-list | any template | most general |
| Trailing `requires` after declarator | functions, member functions | after `const`/`noexcept`/trailing return |
| Type-constraint `template<Concept T>` | type parameters | shorthand for `requires Concept<T>` |
| `Concept auto` parameter | function params, return, variables | invents a template parameter |
| `requires` on a non-template member | member of a class template | uses the enclosing parameters |

**Traps** — a bare `sizeof(T) <= 16` in a requires-clause is a syntax error without parens · `requires (T t) { ... }` local parameters have no storage, no linkage, no lifetime, no default arguments, no ellipsis · a *simple* requirement `{ t.f() } -> C` written without braces silently becomes an expression, not a constraint · requirements never fire side effects · a construct invalid for **every** possible `T` is ill-formed NDR, not "always false" · `requires` on a constructor still lets CTAD deduce from other candidates.

---

## 13.2 Concepts, subsumption, and constrained overload resolution

```cpp
// ---- defining concepts -------------------------------------------------
template<class T>
concept Small = sizeof(T) <= 16;                       // atomic constraint

template<class T>
concept Numeric = std::integral<T> || std::floating_point<T>;      // disjunction

template<class T>
concept SignedNumeric = Numeric<T> && std::signed_integral<T>;     // conjunction

template<class F, class... Args>
concept Handler = std::invocable<F, Args...>;          // variadic concept

template<class T>
concept Price = std::regular<T> && std::totally_ordered<T> && requires(T a, T b) {
    { a <=> b } -> std::convertible_to<std::strong_ordering>;
};
// template<> concept Small<int> = true;   // ILL-FORMED: no concept specialization
```

```cpp
// ---- subsumption picks the more constrained overload -------------------
template<Numeric T>       constexpr int category(T) { return 1; }
template<SignedNumeric T> constexpr int category(T) { return 2; }  // subsumes #1
static_assert(category(1)   == 2);     // int: both viable, #2 more constrained
static_assert(category(1u)  == 1);     // unsigned: only #1 viable
static_assert(category(1.0) == 1);     // double: only #1 viable

// ---- subsumption is syntactic, not arithmetic --------------------------
template<class T> requires (sizeof(T) >  1) void f(T);
template<class T> requires (sizeof(T) >= 2) void f(T);
// f(0);  // AMBIGUOUS: two distinct atomic constraints; no implication proved.

// ---- fix: share the atom via a named concept ---------------------------
template<class T> concept Wide = sizeof(T) >= 2;
template<class T> requires Wide<T>                      void g(T);   // #1
template<class T> requires (Wide<T> && std::integral<T>) void g(T);  // #2 subsumes #1
```

```cpp
// ---- normalization rules (what the compiler actually compares) ---------
// 1. Concept-id -> substitute its definition, recursively, keeping a parameter mapping.
// 2. &&/|| in a *constraint-expression* become conjunction/disjunction nodes.
// 3. Everything else becomes ONE opaque ATOMIC constraint (expression + mapping).
// 4. A requires-expression is atomic AS A WHOLE — its interior never decomposes.
// 5. A subsumes B iff A's disjunctive normal form implies B's, atom-identity only.
template<class T> concept HasX = requires { typename T::x; };
template<class T> concept HasXY = requires { typename T::x; typename T::y; };
// HasXY does NOT subsume HasX: two different atomic requires-expressions.
template<class T> concept HasXY2 = HasX<T> && requires { typename T::y; };
// HasXY2 DOES subsume HasX: the HasX atom literally appears.
```

```cpp
// ---- short-circuiting guards ill-formed sub-checks ----------------------
template<class T> concept HasValue = requires { typename T::value_type; };
template<class T>
concept SmallValue = HasValue<T> && (sizeof(typename T::value_type) <= 8);  // order matters
// Reversed, `typename T::value_type` would be a hard error for T without it.
```

```cpp
// ---- constrained class templates / partial specializations -------------
template<class T> struct Codec;                                // primary
template<std::integral T> struct Codec<T> { /* ... */ };       // constrained partial spec
template<std::floating_point T> struct Codec<T> { /* ... */ };

// ---- constrained members and non-template members ----------------------
template<class T>
struct Box {
    T value;
    void hash() const requires std::integral<T>;               // member only when integral
    auto operator<=>(Box const&) const requires std::three_way_comparable<T> = default;
};
```

| Overload-resolution step | Where constraints act |
|---|---|
| Name lookup / candidate set | — |
| Template argument deduction | substitution failure removes candidate (SFINAE) |
| **Constraint satisfaction** | unsatisfied constraint removes candidate |
| Conversion-sequence ranking | ordinary rules win first |
| Non-template vs template | non-template still preferred on a tie |
| Partial ordering of templates | tie broken by **subsumption** of associated constraints |

**Traps** — subsumption only breaks ties *after* conversion ranking, so a better conversion beats a tighter constraint · an unconstrained non-template overload beats every constrained template · copy-pasting the same predicate text into two declarations produces *different* atoms (unless it is the same concept-id) · a constraint on the *return type* of an abbreviated template still forms an atom · `requires` inside a lambda's trailing spec applies to `operator()` · concepts are never virtual dispatch.

---

## 13.3 Standard concepts and semantic requirements

```cpp
#include <concepts>
#include <iterator>
#include <ranges>

// ---- <concepts> core language concepts ---------------------------------
static_assert(std::same_as<int, int>);
static_assert(std::derived_from<std::input_iterator_tag, std::input_iterator_tag>);
static_assert(std::convertible_to<short, int>);        // implicit AND explicit
static_assert(std::common_reference_with<int&, int const&>);
static_assert(std::common_with<int, long>);
static_assert(std::integral<char> && std::signed_integral<int> && std::unsigned_integral<unsigned>);
static_assert(std::floating_point<double>);
static_assert(std::assignable_from<int&, int>);
static_assert(std::swappable<int> && std::swappable_with<int&, int&>);

// ---- object concepts (each builds on the previous) ---------------------
static_assert(std::destructible<int>);
static_assert(std::constructible_from<std::pair<int,int>, int, int>);
static_assert(std::default_initializable<int> && std::move_constructible<int>);
static_assert(std::copy_constructible<int> && std::movable<int> && std::copyable<int>);
static_assert(std::semiregular<int>);   // copyable + default_initializable
static_assert(std::regular<int>);       // semiregular + equality_comparable

// ---- comparison concepts ----------------------------------------------
static_assert(std::equality_comparable<int>);
static_assert(std::equality_comparable_with<int, long>);
static_assert(std::totally_ordered<double>);           // NOTE: NaN violates the SEMANTICS
static_assert(std::three_way_comparable<int, std::strong_ordering>);

// ---- callable concepts -------------------------------------------------
static_assert(std::invocable<int(*)(int), int>);
static_assert(std::regular_invocable<int(*)(int), int>);   // same syntax, stronger MEANING
static_assert(std::predicate<bool(*)(int), int>);
static_assert(std::relation<bool(*)(int,int), int, int>);
static_assert(std::equivalence_relation<bool(*)(int,int), int, int>);
static_assert(std::strict_weak_order<std::less<int>, int, int>);
```

```cpp
// ---- syntax satisfied, semantics violated ------------------------------
struct BadLess {
    bool operator()(double a, double b) const { return a <= b; }  // NOT irreflexive
};
static_assert(std::strict_weak_order<BadLess, double, double>);    // compiler says yes
// std::sort(v.begin(), v.end(), BadLess{});  // UB: may read out of bounds.

struct StatefulPred {                       // satisfies `predicate`, breaks regularity
    mutable int n = 0;
    bool operator()(int) const { return ++n % 2; }   // not equality-preserving
};
// Algorithms may call a predicate any number of times, in any order.
```

| Family | Header | Members | Semantic obligation the compiler cannot check |
|---|---|---|---|
| Core language | `<concepts>` | `same_as`, `derived_from`, `convertible_to`, `common_with`, `common_reference_with` | conversions must be equality-preserving |
| Arithmetic | `<concepts>` | `integral`, `signed_integral`, `unsigned_integral`, `floating_point` | — |
| Object | `<concepts>` | `movable`, `copyable`, `semiregular`, `regular` | moved-from object valid but unspecified; copies compare equal |
| Comparison | `<concepts>` | `equality_comparable`, `totally_ordered`, `three_way_comparable` | reflexive/symmetric/transitive; NaN breaks `totally_ordered` |
| Callable | `<concepts>` | `invocable`, `regular_invocable`, `predicate`, `relation`, `strict_weak_order` | equal inputs ⇒ equal outputs; no observable mutation |
| Iterator | `<iterator>` | `input_or_output_iterator`, `input_iterator`, `forward_iterator`, `bidirectional_iterator`, `random_access_iterator`, `contiguous_iterator`, `output_iterator` | forward = multipass; contiguous = `to_address` arithmetic valid |
| Iterator pairing | `<iterator>` | `sentinel_for`, `sized_sentinel_for`, `indirectly_readable`, `indirectly_writable`, `indirect_unary_predicate`, `mergeable`, `sortable`, `permutable` | `sized_sentinel_for` promises O(1) `s - i` |
| Range | `<ranges>` | `range`, `sized_range`, `borrowed_range`, `view`, `input_range` … `contiguous_range`, `common_range`, `viewable_range`, `constant_range` (C++23) | `view` promises O(1) copy/move/destroy; `sized_range` O(1) `size()` |

```cpp
// ---- writing your own concept with a documented contract ---------------
// Semantics (NOT checked): on() must not allocate, must not block, must be
// callable from the market-data thread, and must be O(1).
template<class Sink, class Event>
concept EventSink = requires(Sink& s, Event const& e) {
    { s.on(e) } noexcept -> std::same_as<void>;
};
```

**Interview line** — "A concept is a machine-checkable syntactic filter plus a human-checked semantic contract; satisfying it proves the code compiles, never that it is correct."

**Traps** — `convertible_to<From,To>` demands both implicit and `static_cast` conversion · `totally_ordered<double>` is satisfied yet floating-point NaN breaks the axioms · `regular_invocable` and `invocable` are syntactically identical — the difference is documentation only · `view` requires O(1) move, so a `vector` is a range but not a view · a moved-from `movable` object must still be destructible and assignable-to.

---

## 13.4 SFINAE, detection idiom, and `void_t`

```cpp
#include <type_traits>
#include <utility>

// ---- return-type SFINAE ------------------------------------------------
template<class T>
auto size_of(T const& x) -> decltype(x.size()) { return x.size(); }   // removed if no size()
template<class T>
auto size_of(T const&) -> std::size_t { return 1; }                   // ambiguity risk!

// ---- enable_if in every position --------------------------------------
template<class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>   // default NTTP: BEST
T f1(T x) { return x; }

template<class T, class = std::enable_if_t<std::is_integral_v<T>>>    // default TYPE: fragile
T f2(T x) { return x; }        // two such overloads REDECLARE each other

template<class T>
std::enable_if_t<std::is_integral_v<T>, T> f3(T x) { return x; }      // return type

template<class T>
T f4(T x, std::enable_if_t<std::is_integral_v<T>, int> = 0) { return x; }  // param
```

```cpp
// ---- void_t detection idiom (the canonical pre-C++20 pattern) ----------
template<class...> using void_t = void;                 // std::void_t since C++17

template<class T, class = void>
struct has_reserve : std::false_type {};

template<class T>
struct has_reserve<T, std::void_t<
    decltype(std::declval<T&>().reserve(std::declval<typename T::size_type>()))>>
    : std::true_type {};

template<class T> inline constexpr bool has_reserve_v = has_reserve<T>::value;

// ---- generalized detector ---------------------------------------------
template<class Default, class AlwaysVoid, template<class...> class Op, class... Args>
struct detector { using value_t = std::false_type; using type = Default; };
template<class Default, template<class...> class Op, class... Args>
struct detector<Default, std::void_t<Op<Args...>>, Op, Args...> {
    using value_t = std::true_type; using type = Op<Args...>;
};
template<template<class...> class Op, class... Args>
using is_detected = typename detector<void, void, Op, Args...>::value_t;
template<template<class...> class Op, class... Args>
using detected_t = typename detector<void, void, Op, Args...>::type;

template<class T> using reserve_t = decltype(std::declval<T&>().reserve(0uz));
static_assert(is_detected<reserve_t, std::vector<int>>::value);
```

```cpp
// ---- C++20 replacements -----------------------------------------------
template<class T>
concept Reservable = requires(T& t, typename T::size_type n) { t.reserve(n); };

template<Reservable T> void grow(T& t, std::size_t n) { t.reserve(n); }   // clause
template<class T> void grow2(T& t, std::size_t n) {
    if constexpr (requires { t.reserve(n); }) t.reserve(n);               // inline
}
```

```cpp
// ---- immediate context: what SFINAE does and does NOT cover ------------
template<class T> struct Wrapper { using type = typename T::missing; };   // hard error site

template<class T> auto h(T) -> typename Wrapper<T>::type;   // instantiating Wrapper<int>
// h(0);   // HARD ERROR: the failure is inside Wrapper, not in h's immediate context.

template<class T> auto ok(T) -> typename T::missing;        // failure IS immediate
template<class T> void ok(T) {}
// ok(0);  // fine: first candidate silently removed.
```

| Idiom | Availability | Diagnostic quality | Participates in subsumption |
|---|---|---|---|
| `enable_if` default NTTP | C++11 | poor ("no matching function") | no |
| Return-type `decltype` SFINAE | C++11 | poor | no |
| `void_t` partial specialization | C++17 | poor, but composable into traits | no |
| Tag dispatch | C++03 | good (explicit overloads) | no |
| Requires-clause / concept | C++20 | best (names the failed atom) | **yes** |

**Traps** — `std::enable_if_t<...>` as a *default template type argument* makes two overloads the same signature → redeclaration error · `declval<T>()` is unevaluated-only; calling it is ill-formed · `void_t` needed a workaround on pre-CWG1558 compilers · access-control violations are SFINAE-friendly but only in the immediate context · an error inside an instantiated *body* is never SFINAE · substitution can still trigger expensive instantiations even when the candidate is discarded.

---

## 13.5 Type traits, transformations, and `_v` / `_t` helpers

```cpp
#include <type_traits>

static_assert(std::is_integral<int>::value);          // C++11 class form
static_assert(std::is_integral_v<int>);               // C++17 variable template `_v`
using U = std::remove_cvref_t<int const&>;            // C++14/20 alias `_t`
static_assert(std::is_same_v<U, int>);

using yes = std::true_type;    // std::integral_constant<bool, true>
using no  = std::false_type;
static_assert(yes::value && yes{}() && static_cast<bool>(yes{}));   // ::value, (), conversion
using three = std::integral_constant<int, 3>;
static_assert(three::value == 3 && std::is_same_v<three::value_type, int>);
```

| Category | Traits |
|---|---|
| Primary categories | `is_void`, `is_null_pointer`, `is_integral`, `is_floating_point`, `is_array`, `is_enum`, `is_union`, `is_class`, `is_function`, `is_pointer`, `is_lvalue_reference`, `is_rvalue_reference`, `is_member_object_pointer`, `is_member_function_pointer` |
| Composite | `is_reference`, `is_arithmetic`, `is_fundamental`, `is_object`, `is_scalar`, `is_compound`, `is_member_pointer` |
| Type properties | `is_const`, `is_volatile`, `is_trivial`, `is_trivially_copyable`, `is_standard_layout`, `is_empty`, `is_polymorphic`, `is_abstract`, `is_final`, `is_aggregate`, `is_signed`, `is_unsigned`, `is_bounded_array`, `is_scoped_enum` (C++23), `has_unique_object_representations` |
| Supported operations | `is_constructible`, `is_default_constructible`, `is_copy_constructible`, `is_move_constructible`, `is_assignable`, `is_copy_assignable`, `is_move_assignable`, `is_destructible`, `is_swappable`, `is_swappable_with`, each with `is_trivially_*` and `is_nothrow_*` forms |
| Relationships | `is_same`, `is_base_of`, `is_convertible`, `is_nothrow_convertible`, `is_layout_compatible` (C++20), `is_pointer_interconvertible_base_of`, `is_invocable`, `is_invocable_r`, `is_nothrow_invocable` |
| Queries | `alignment_of`, `rank`, `extent` |
| cv/ref transforms | `remove_cv`, `remove_const`, `remove_volatile`, `add_cv`, `add_const`, `add_volatile`, `remove_reference`, `add_lvalue_reference`, `add_rvalue_reference`, `remove_cvref` (C++20) |
| Pointer/array | `remove_pointer`, `add_pointer`, `remove_extent`, `remove_all_extents` |
| Sign | `make_signed`, `make_unsigned` |
| Other | `decay`, `conditional`, `enable_if`, `common_type`, `common_reference` (C++20), `underlying_type`, `invoke_result`, `type_identity` (C++20), `void_t`, `unwrap_reference`, `unwrap_ref_decay` |
| Logical | `conjunction`, `disjunction`, `negation` (short-circuiting, C++17) |
| Constant eval | `std::is_constant_evaluated()` (C++20, `<type_traits>`) |

```cpp
// ---- decay vs remove_cvref --------------------------------------------
using A = int[4];
static_assert(std::is_same_v<std::remove_cvref_t<A const&>, int[4]>);   // extent KEPT
static_assert(std::is_same_v<std::decay_t<A const&>,  int const*>);     // decayed; const KEPT on element
static_assert(std::is_same_v<std::decay_t<int(double)>,     int(*)(double)>);
static_assert(std::is_same_v<std::remove_cvref_t<int const&>, int>);
// decay_t models "what a by-value parameter would become".

// ---- conditional / conjunction / type_identity -------------------------
using Idx = std::conditional_t<sizeof(void*) == 8, std::uint64_t, std::uint32_t>;
template<class T>
using SafeCheck = std::conjunction<std::is_class<T>, std::is_trivially_copyable<T>>;  // short-circuits
template<class T> void exact(std::type_identity_t<T>, T);   // blocks deduction on arg 1

// ---- invoke_result / is_invocable --------------------------------------
auto fn = [](int, double) { return 1L; };
static_assert(std::is_same_v<std::invoke_result_t<decltype(fn), int, double>, long>);
static_assert(std::is_invocable_r_v<long, decltype(fn), int, double>);

// ---- writing a trait: value form + transform form ----------------------
template<class T> struct is_price : std::false_type {};
template<> struct is_price<std::int64_t> : std::true_type {};   // specializing YOUR trait: fine
template<class T> inline constexpr bool is_price_v = is_price<T>::value;

template<class T> struct widen              { using type = T; };
template<>        struct widen<std::int32_t>{ using type = std::int64_t; };
template<class T> using widen_t = typename widen<T>::type;
```

**Traps** — `std::is_trivially_copyable` on a type you lied about via specialization is UB; you may only specialize `common_type`, `common_reference`, `basic_common_reference`, and a few designated templates · `is_convertible<From,To>` does not instantiate `To`'s definition, so incomplete types are UB · `is_base_of<T,T>` is `true` for classes · `std::is_constant_evaluated()` inside a plain `if constexpr` is **always true** — use `if consteval` or a runtime `if` · `_v` variable templates exist only from C++17 · `remove_const_t<int* const>` removes the pointer's const, not the pointee's.

---

## 13.6 Tag dispatch, `if constexpr`, and constrained customization

```cpp
#include <iterator>

// ---- tag dispatch (pre-concepts, still idiomatic for category trees) ---
template<class It>
void advance_impl(It& it, std::ptrdiff_t n, std::random_access_iterator_tag) { it += n; }
template<class It>
void advance_impl(It& it, std::ptrdiff_t n, std::bidirectional_iterator_tag) {
    for (; n > 0; --n) ++it;
    for (; n < 0; ++n) --it;
}
template<class It>
void advance_impl(It& it, std::ptrdiff_t n, std::input_iterator_tag) { while (n-- > 0) ++it; }

template<class It>
void advance_fast(It& it, std::ptrdiff_t n) {
    advance_impl(it, n, typename std::iterator_traits<It>::iterator_category{});
}
// Tag dispatch relies on DERIVED-to-base conversion ranking, so a partial
// hierarchy naturally falls back to the weakest overload.

// ---- custom tags ------------------------------------------------------
struct owning_t   { explicit owning_t()   = default; };
struct borrowed_t { explicit borrowed_t() = default; };
inline constexpr owning_t   owning{};
inline constexpr borrowed_t borrowed{};
void submit(Payload p, owning_t);
void submit(std::span<std::byte const> p, borrowed_t);
```

```cpp
// ---- if constexpr ------------------------------------------------------
template<class T>
constexpr auto magnitude(T x) {
    if constexpr (std::signed_integral<T>) {
        using U = std::make_unsigned_t<T>;
        return x < 0 ? static_cast<U>(-(x + 1)) + 1 : static_cast<U>(x);  // -min is safe here
    } else if constexpr (std::floating_point<T>) {
        return x < 0 ? -x : x;
    } else {
        return x;
    }
}

// ---- if constexpr with init-statement (C++17) --------------------------
template<class T>
void log(T const& t) {
    if constexpr (constexpr bool named = requires { t.name(); }; named) { /* use t.name() */ }
}

// ---- pack expansion + if constexpr -------------------------------------
template<class... Ts>
constexpr std::size_t bytes() {
    return (std::size_t{0} + ... + sizeof(Ts));       // fold
}

// ---- discarded-branch rules --------------------------------------------
template<class T>
void encode(T const& t) {
    if constexpr (std::integral<T>) { /* ... */ }
    else {
        // static_assert(false, "no");     // NOT dependent: historically ill-formed
        static_assert(dependent_false_v<T>, "unsupported encode type");   // portable
        t.nonexistent_but_dependent();     // fine: never instantiated for integral T
        // int x = "abc";                  // NOT dependent: diagnosed even if discarded
    }
}
```

```cpp
// ---- constrained customization: overloads vs one branchy body ----------
template<class Sink, class Event>
concept Accepts = requires(Sink& s, Event const& e) {
    { s.on(e) } noexcept -> std::same_as<void>;
};
template<class Sink, class Event>
concept Batches = requires(Sink& s, std::span<Event const> b) { s.on_batch(b); };

template<class Sink, class Event> requires Batches<Sink, Event>
void dispatch(Sink& s, std::span<Event const> b) { s.on_batch(b); }        // preferred

template<class Sink, class Event> requires (Accepts<Sink, Event> && !Batches<Sink, Event>)
void dispatch(Sink& s, std::span<Event const> b) { for (auto const& e : b) s.on(e); }
```

| Choose | When |
|---|---|
| Constrained overloads | the alternatives are distinct *interfaces*, need subsumption ordering, or live in different headers/extension points |
| `if constexpr` | most of the implementation is shared and only a step differs; one function, one name |
| Tag dispatch | categories already exist as types (iterator/allocator tags), or you need base-conversion fallback ranking |
| Runtime `if` | the choice depends on runtime data — no metaprogramming involved |
| `virtual` | the set of implementations is open and resolved at link/run time |

**Traps** — `if constexpr` in a **non-template** still instantiates/diagnoses both branches fully; it is not `#if` · a discarded branch must still parse and be valid for non-dependent constructs · `if constexpr` cannot discard a `return` type mismatch — differing branch return types make the function's deduced type depend on the branch (fine) but `auto` still needs each *taken* return to agree · tag-dispatch parameters cost nothing at runtime but appear in the mangled name · a concept used only for docs is dead weight if no overload contends.

---

## 13.7 `static_assert` and compile-time validation

```cpp
#include <bit>
#include <cstddef>
#include <cstdint>

static_assert(sizeof(std::uint64_t) == 8);                        // with message
static_assert(sizeof(void*) == 8, "64-bit only");
static_assert(std::endian::native == std::endian::little, "LE layout assumed");
static_assert(alignof(std::max_align_t) >= 8);
// static_assert(cond);                       // C++17: message optional
// static_assert(cond, msg);                  // C++26: msg may be a constexpr string-like

template<std::size_t Capacity>
struct SpscConfig {
    static_assert(Capacity >= 2,                    "capacity needs two usable states");
    static_assert(std::has_single_bit(Capacity),    "capacity must be a power of two");
    static_assert(Capacity <= (1u << 20),           "capacity would blow the L2 budget");
};

struct alignas(64) Slot { std::uint64_t seq; std::uint64_t payload; };
static_assert(sizeof(Slot) == 64 && alignof(Slot) == 64);         // ABI/layout lock-in
static_assert(std::is_trivially_copyable_v<Slot>);                // memcpy-legal
static_assert(std::is_standard_layout_v<Slot>);                   // offsetof-legal
static_assert(offsetof(Slot, payload) == 8);
```

```cpp
// ---- dependent-false: the portable "unreachable specialization" --------
template<class> inline constexpr bool dependent_false_v = false;

template<class T>
void encode(T const&) {
    if constexpr (std::integral<T>)            { /* ... */ }
    else if constexpr (std::floating_point<T>) { /* ... */ }
    else static_assert(dependent_false_v<T>, "unsupported encode type");
}
// C++23 P2593 permits static_assert(false) in an uninstantiated template,
// but dependent_false_v is what compiles everywhere today.

// ---- assert inside a concept vs assert inside a body -------------------
template<class T> requires std::integral<T>   // candidate silently removed
void take_a(T);
template<class T> void take_b(T) { static_assert(std::integral<T>, "int only"); }
// take_a: other overloads may still match. take_b: hard error, best diagnostic.
```

| Tool | Effect on a bad type | Use when |
|---|---|---|
| Requires-clause / concept | candidate removed from overload set | multiple implementations, or a fallback exists |
| `static_assert` in body | hard error with your message | exactly one valid implementation; you want the message |
| `static_assert` in class scope | hard error at instantiation of the class | invariants over NTTPs / layout / ABI |
| `= delete("reason")` (C++26) | candidate selected then rejected with reason | forbid a specific conversion loudly |
| `std::unreachable()` (C++23) | runtime UB, optimizer hint | a state proved impossible at runtime |

**Interview line** — "Constrain when the answer is 'this overload does not apply'; `static_assert` when the answer is 'this program is wrong'."

**Traps** — `static_assert` in a template only fires when that specialization is instantiated · a non-dependent `static_assert(false)` in a template fires even for uninstantiated code on older toolchains · the message must be a string literal before C++26 · asserting `sizeof` equalities locks your ABI — intentional for wire structs, accidental elsewhere · a class-scope assert does not run for an explicit instantiation *declaration*.

---

## 13.8 Compile-time computation, `constexpr` containers, and limitations

```cpp
#include <array>
#include <algorithm>
#include <vector>
#include <string>

// ---- constexpr function: usable at compile time AND runtime ------------
constexpr std::array<unsigned char, 256> make_popcount() {
    std::array<unsigned char, 256> t{};
    for (unsigned x = 0; x != t.size(); ++x)
        for (unsigned v = x; v; v >>= 1) t[x] += static_cast<unsigned char>(v & 1u);
    return t;
}
inline constexpr auto popcount8 = make_popcount();     // persists into .rodata
static_assert(popcount8[0xff] == 8);

// ---- the four spellings -------------------------------------------------
constexpr int  a = 1;                 // constant object, immutable
constexpr int  f(int x) { return x; } // MAY be constant-evaluated
consteval int  g(int x) { return x; } // MUST be constant-evaluated (immediate function)
constinit int  c = f(2);              // static-init guaranteed; NOT const, mutable at runtime
constexpr int  d = f(3);              // forced constant evaluation
int            e = f(runtime_value);  // ordinary runtime call
```

```cpp
// ---- consteval and its call rules --------------------------------------
consteval unsigned checked_field(unsigned offset, unsigned width) {
    if (width == 0 || offset + width > 64) throw "invalid field";   // throw => not a constant expr
    return offset;
}
constexpr unsigned k = checked_field(0, 8);      // OK
// unsigned bad = checked_field(0, 0);           // ERROR: not a constant expression

// C++23: an immediate function may be called from another immediate context
consteval unsigned wrap(unsigned o, unsigned w) { return checked_field(o, w); }

// ---- if consteval (C++23) vs is_constant_evaluated (C++20) -------------
constexpr double fast_pow(double b, int e) {
    if consteval { return e == 0 ? 1.0 : b * fast_pow(b, e - 1); }  // exact, portable path
    else         { return std::pow(b, e); }                          // may call non-constexpr
}
constexpr int legacy() {
    if (std::is_constant_evaluated()) return 1;    // MUST be a plain `if`
    // if constexpr (std::is_constant_evaluated())  // BUG: always true
    return 2;
}
```

```cpp
// ---- transient allocation: allowed, but must not escape -----------------
constexpr int sum_sorted() {
    std::vector<int> v{3, 1, 2};      // allocation during constant evaluation
    std::ranges::sort(v);
    return v[0] + v[1] + v[2];        // freed at scope exit -> OK
}
static_assert(sum_sorted() == 6);
// constexpr std::vector<int> kept{1,2,3};   // ERROR: storage would escape the evaluation
// constexpr std::string s = "short";        // OK only if SSO avoids allocation (impl-defined)

// ---- the persistent pattern: build in a vector, freeze into an array ---
template<std::size_t N>
constexpr std::array<int, N> freeze() {
    std::vector<int> v;
    for (int i = 0; i < int(N); ++i) v.push_back(i * i);
    std::array<int, N> out{};
    std::ranges::copy(v, out.begin());
    return out;                       // array escapes; vector does not
}
inline constexpr auto squares = freeze<8>();
```

| Facility | Version | Rule |
|---|---|---|
| `constexpr` function | C++11 (relaxed C++14/20/23) | may run at compile time; C++23 allows non-constexpr-usable bodies if *some* args could work |
| `constexpr` variable | C++11 | must be initialized by a constant expression; implicitly `const` |
| `consteval` | C++20 | every potentially-evaluated call must be immediate |
| `constinit` | C++20 | constant *initialization*, no dynamic-init order fiasco; mutable afterwards |
| `if consteval` | C++23 | branch on manifest constant evaluation; may call `consteval` in the true branch |
| `std::is_constant_evaluated()` | C++20 | plain `if` only; never `if constexpr` |
| `constexpr` `std::vector`/`std::string` | C++20 | transient allocation only |
| `constexpr` algorithms | C++20 | most of `<algorithm>`, `<numeric>`, `<ranges>` |
| `constexpr` `unique_ptr` | C++23 | still transient-only |
| `static constexpr` in a `constexpr` fn | C++23 | previously ill-formed |
| Goto/labels/non-literal vars in `constexpr` | C++23 | permitted if not evaluated |

**Traps** — a `constexpr` function called with runtime arguments silently becomes a normal call, no diagnostic · `constexpr` implies `inline` for functions and `const` for variables, but `constinit` implies neither · UB during constant evaluation is *diagnosed* (that is the superpower), UB at runtime is not · compilers cap `-fconstexpr-ops-limit` / `-fconstexpr-steps`, so heavy tables hit hard limits · every distinct NTTP value spawns a new specialization — code bloat and build time · huge `constexpr` tables land in the binary and consume data cache and page-in time.

---

## 13.9 Compile-time strings, lookup tables, and generated dispatch

```cpp
#include <array>
#include <algorithm>
#include <string_view>

// ---- structural type usable as a non-type template parameter (C++20) ---
template<std::size_t N>
struct FixedString {
    char data[N]{};
    constexpr FixedString(char const (&s)[N]) { std::ranges::copy(s, data); }  // CTAD from literal
    constexpr operator std::string_view() const { return {data, N - 1}; }
    constexpr std::size_t size() const { return N - 1; }
    auto operator<=>(FixedString const&) const = default;   // structural: needs defaulted ==
};
template<std::size_t N> FixedString(char const (&)[N]) -> FixedString<N>;

template<FixedString Name>              // string literal AS a template argument
struct Field { static constexpr std::string_view name = Name; };
using Px = Field<"price">;
static_assert(Px::name == "price");
// Each distinct literal creates a distinct specialization: keep shared decoding
// machinery in a NON-templated base so only the thin wrapper is duplicated.
```

```cpp
// ---- lookup table with an explicit invalid state -----------------------
enum class MessageKind : unsigned char { invalid = 0, add, cancel, trade };  // invalid FIRST

constexpr std::array<MessageKind, 256> make_kind_table() {
    std::array<MessageKind, 256> t{};                       // all == invalid (value 0)
    t[static_cast<unsigned char>('A')] = MessageKind::add;
    t[static_cast<unsigned char>('C')] = MessageKind::cancel;
    t[static_cast<unsigned char>('T')] = MessageKind::trade;
    return t;
}
inline constexpr auto kind_table = make_kind_table();
constexpr MessageKind classify(char c) { return kind_table[static_cast<unsigned char>(c)]; }
static_assert(classify('A') == MessageKind::add && classify('Z') == MessageKind::invalid);
```

```cpp
// ---- sorted constexpr table + binary search (no hashing, no allocation) ---
struct Entry { std::string_view key; int id; };
constexpr auto symbols = [] {
    std::array<Entry, 4> t{{{"AAPL",1},{"MSFT",2},{"ESZ5",3},{"NQZ5",4}}};
    std::ranges::sort(t, {}, &Entry::key);
    return t;
}();
constexpr int lookup(std::string_view k) {
    auto it = std::ranges::lower_bound(symbols, k, {}, &Entry::key);
    return (it != symbols.end() && it->key == k) ? it->id : -1;
}
static_assert(lookup("MSFT") == 2 && lookup("XXXX") == -1);
```

```cpp
// ---- four ways to generate dispatch ------------------------------------
// (a) switch: closed set, compiler builds a jump table or a branch chain
int handle_switch(MessageKind k) {
    switch (k) {
        case MessageKind::add:    return 1;
        case MessageKind::cancel: return 2;
        case MessageKind::trade:  return 3;
        default:                  return 0;
    }
}

// (b) constexpr array of function pointers: data-driven, indirect call
using Fn = int(*)();
inline constexpr std::array<Fn, 4> table{ []{return 0;}, []{return 1;}, []{return 2;}, []{return 3;} };
int handle_table(MessageKind k) { return table[static_cast<std::size_t>(k)](); }

// (c) pack expansion over an index sequence: N direct, inlinable calls
template<class F, std::size_t... I>
constexpr void for_each_index(F&& f, std::index_sequence<I...>) {
    (f(std::integral_constant<std::size_t, I>{}), ...);       // unary right fold over comma
}
template<std::size_t N, class F> constexpr void for_each_index(F&& f) {
    for_each_index(std::forward<F>(f), std::make_index_sequence<N>{});
}

// (d) variant + overloaded visitor: type-safe payload association
template<class... Ts> struct overloaded : Ts... { using Ts::operator()...; };
template<class... Ts> overloaded(Ts...) -> overloaded<Ts...>;   // CTAD (redundant since C++20)
int handle_variant(std::variant<Add, Cancel, Trade> const& m) {
    return std::visit(overloaded{ [](Add const&){return 1;},
                                  [](Cancel const&){return 2;},
                                  [](Trade const&){return 3;} }, m);
}
```

| Form | Runtime shape | Cost | Tradeoff |
|---|---|---|---|
| `switch` over a dense tag | jump table or compare chain | 1 indirect branch (predictable) | compact, closed set, compiler-optimized |
| `constexpr` array of fn pointers | bounds check + indirect call | 1 load + 1 indirect call, no inlining | fully data-driven, extensible at init |
| Template recursion / pack expansion | N direct calls | inlinable, zero dispatch | code size and build time grow with N |
| `std::variant` + `std::visit` | vtable-ish jump table | ~1 indirect branch | type-safe payloads, valueless-by-exception state |
| `virtual` | vtable indirect call | 1 load + 1 indirect call | open set, no inlining across the call |

**Traps** — default-initializing a table to a *valid* enumerator conflates unknown input with a real message; reserve value 0 for `invalid` · a 64 KB table is a data-cache and TLB problem even though the arithmetic vanished · every distinct `FixedString` NTTP instantiates everything downstream · `FixedString` must be a *structural* type (public members, no user-provided destructor/copy) to be an NTTP · `string_view` into a `constexpr` array is fine; into a transient `constexpr std::string` it dangles.

---

## 13.10 When concepts improve diagnostics but do not change runtime cost

```cpp
// ---- what emits zero instructions --------------------------------------
// concept satisfaction, requires-expressions, type traits, static_assert,
// discarded if-constexpr branches, tag-dispatch tag arguments (empty types),
// subsumption/partial ordering — ALL compile-time only.

template<class T> requires std::integral<T>
T add(T a, T b) { return a + b; }        // identical codegen to the unconstrained version
```

```cpp
// ---- how metaprogramming DOES move runtime cost ------------------------
// 1. Selects a different algorithm/overload:
template<std::contiguous_iterator It> void copy_fast(It f, It l, It o);  // -> memmove
template<std::input_iterator     It> void copy_fast(It f, It l, It o);   // -> element loop

// 2. Turns a runtime bound into a compile-time constant (unroll/vectorize):
template<std::size_t N> void consume(std::span<Event const, N> b);   // static extent
void consume_dyn(std::span<Event const> b);                          // dynamic extent

// 3. Enables devirtualization / inlining by making the target static.
// 4. Replaces branches with a table lookup (or vice versa).
// 5. Bloats I-cache: many N specializations replicate the whole consumer body.
```

```cpp
// ---- measure the axis you actually changed ------------------------------
// text size:      size -A app | grep -E '\.text|\.rodata'
// specializations: nm -C app | grep -c 'consume<'
// build cost:     clang++ -ftime-trace / -ftime-report
// I-cache misses: perf stat -e L1-icache-load-misses,iTLB-load-misses ./app
```

| Change | Compile-time cost | Binary size | Runtime effect |
|---|---|---|---|
| Add a concept to an existing template | small | none | **none** |
| Replace `enable_if` with a concept | usually lower | none | none |
| `if constexpr` instead of a runtime `if` | none | smaller | removes one predictable branch |
| Specialize over N compile-time sizes | ×N instantiations | ×N body | unrolls; may thrash I-cache |
| Generate a 64 KB `constexpr` table | moderate | +64 KB `.rodata` | removes ALU work, adds D-cache/TLB pressure |
| Deep template recursion | large, superlinear | large debug info | none directly |
| Swap `virtual` for a constrained template | higher | larger | enables inlining, removes indirect branch |

> **Cost rule** — concepts buy API precision and diagnostics; speed comes from *which implementation* was selected and how much evidence the optimizer got.

**Interview line** — "Constraints are a compile-time filter over the overload set; they emit no code, so any performance difference comes entirely from the different function they let you select."

**Traps** — "we added concepts and it got faster" almost always means an overload changed, not that constraints are fast · a `constexpr` table that replaces three ALU ops with an L2 miss is a regression · concept-heavy headers slow *every* translation unit that includes them · debug builds instantiate everything you generated, so `-O0` link times explode first · a satisfied concept still cannot prove the noexcept/allocation/latency contract your hot path actually depends on.

---

## Rapid diagnosis

| Symptom | Cause | Fix |
|---|---|---|
| Sort or `map` lookup behaves inconsistently | comparator satisfies `strict_weak_order` syntactically but is not irreflexive/transitive | use `<`, not `<=`; test the axioms |
| Two "obviously ordered" overloads are ambiguous | textually similar constraints are *distinct atoms* | factor the predicate into one named concept |
| Hard error where you expected SFINAE | failure was outside the immediate context (inside an instantiated class/body) | move the check into the signature or a requires-clause |
| `same_as` requirement never satisfied | compound requirement uses `decltype((e))`, so lvalues are `T&` | constrain with `same_as<T&>` or `convertible_to<T>` |
| Redeclaration error with two `enable_if` overloads | `class = enable_if_t<...>` default args give identical signatures | use `enable_if_t<...,int> = 0` NTTPs, or concepts |
| `static_assert(false)` fires without instantiation | condition is non-dependent | use `dependent_false_v<T>` |
| `is_constant_evaluated()` always true | wrapped in `if constexpr` | use a plain `if`, or `if consteval` |
| `constexpr std::vector` rejected | allocation would escape the evaluation | build in a vector, return a `std::array` |
| Build time exploded after "zero-cost" refactor | thousands of specializations / deep recursion | profile with `-ftime-trace`; hoist shared code out of value-specialized layers |
| Binary grew, throughput fell | per-`N` specialization replicated a large body | compare against a single dynamic-extent implementation |

## Recall card

```text
requires-clause        constrains a declaration (leading, trailing, template<C T>, C auto)
requires-expression    bool prvalue; operands UNEVALUATED
requirement kinds      simple | type | compound | nested
compound result        C<decltype((e))>  -> lvalues carry &
normalization          concept-id expands; &&/|| split; everything else = one ATOM
subsumption            atom identity + DNF implication; NOT a theorem prover
short-circuit          left-to-right; put the prerequisite first
SFINAE                 immediate-context substitution failure removes the candidate
void_t                 maps valid type-expressions to void; detection building block
trait _v / _t          value helper / type helper
remove_cvref vs decay  decay ALSO decays array->ptr and fn->ptr
if constexpr           discarded dependent branch not instantiated; still must parse
static_assert          hard invariant; use dependent_false_v<T> inside templates
consteval              every potentially-evaluated call is immediate
if consteval           C++23 manifest-constant-evaluation branch
constexpr alloc        transient only; freeze into std::array to persist
runtime                constraints emit ZERO instructions
hot-path question      which overload / table / code size did metaprogramming produce?
semantic trap          valid syntax proves nothing about ordering, purity, bounds, or latency
```
