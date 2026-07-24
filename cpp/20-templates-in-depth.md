# 20. Templates in Depth

Templates generate concrete declarations from types, compile-time values, and other templates. Their rules determine which names are visible, which overloads participate, and how much code reaches the binary. Low-latency C++ uses that machinery to remove runtime dispatch and fuse work, while controlling the resulting build-time and instruction-cache costs.

## Non-type template parameters

A template parameter can represent a value rather than a type. Such a **non-type template parameter** (NTTP) makes the value part of every specialization's type.

`std::array<T, N>` uses `N` this way: the element count is known at compile time and `std::array<int, 8>` is a different type from `std::array<int, 16>`. The same technique lets a matrix carry dimensions known at compile time:

```cpp
#include <array>
#include <cstddef>
#include <iostream>

template<class T, std::size_t Rows, std::size_t Columns>
class Matrix {
public:
    static_assert(Rows > 0 && Columns > 0);

    T& at(std::size_t row, std::size_t column) {
        return elements_.at(row * Columns + column);
    }

    const T& at(std::size_t row, std::size_t column) const {
        return elements_.at(row * Columns + column);
    }

    static constexpr std::size_t rows = Rows;
    static constexpr std::size_t columns = Columns;

private:
    std::array<T, Rows * Columns> elements_{};
};

int main() {
    Matrix<double, 2, 3> prices;
    prices.at(1, 2) = 101.25;

    static_assert(decltype(prices)::rows == 2);
    static_assert(decltype(prices)::columns == 3);
    std::cout << prices.at(1, 2) << '\n';  // prints: 101.25
}
```

Integral and enumeration values are common NTTPs. Pointers and references with permitted linkage can also be arguments. C++20 added floating-point values and **structural class types**: literal class types whose bases and non-static data members are public, non-mutable, and structural. No custom equality operator is required.

An NTTP argument must be a constant expression of the parameter's type, apart from the permitted conversions. This is stronger than merely passing a runtime value that happens not to change. The argument becomes part of the specialization's mangled identity, which is why dimensions and policy flags can drive optimization without occupying an object data member.

An `auto` NTTP **(C++17)** deduces the value's type:

```cpp
enum class FieldTag { bid, ask };

template<auto Tag>
struct TaggedValue {
    static constexpr auto tag = Tag;
    double value;
};

static_assert(TaggedValue<FieldTag::bid>::tag == FieldTag::bid);
static_assert(TaggedValue<42>::tag == 42);
```

A string literal cannot directly serve as a pointer NTTP. A structural wrapper copies its characters into the template argument instead **(C++20)**:

```cpp
template<std::size_t N>
struct FixedString {
    char characters[N];

    constexpr FixedString(const char (&text)[N]) {
        for (std::size_t index = 0; index < N; ++index) {
            characters[index] = text[index];
        }
    }
};

template<FixedString Name>
struct NamedField {
    static constexpr auto name = Name;
    double value;
};

NamedField<"bid_price"> bid{101.25};
```

Every distinct argument list names a distinct specialization. `Matrix<double, 3, 3>` and `Matrix<double, 4, 4>` are unrelated types and may generate separate code, even when their member definitions are textually identical.

The dimensions are constants inside each specialization. A compiler can propagate them through loops, unroll a small fixed shape, or reject incompatible operations with `static_assert`. Runtime indices such as `row` and `column` remain runtime values; an NTTP does not make every operation on the object compile-time.

**Pitfall.** NTTPs can turn a runtime dimension into a compile-time constant, but a large population of values creates a large population of types. Use them when the value enables useful specialization, not merely because it can be known early.

## Template-template parameters and policy families

A template parameter can itself accept a template. This lets one generic component choose a family of types and instantiate that family for its own element type.

| Parameter kind | Example declaration | Argument example | What varies |
|---|---|---|---|
| Type | `class T` | `double` | one concrete type |
| Non-type | `std::size_t N` | `64` | one compile-time value |
| Template | `template<class...> class C` | `std::vector` | a type-generating template |

A book-side snapshot can select its sequence representation without turning every user into a template over a fully formed container type:

```cpp
#include <deque>
#include <vector>

struct Level {
    int price;
    int quantity;
};

template<template<class...> class Sequence>
class BookSide {
public:
    void add(Level level) {
        levels_.push_back(level);
    }

    const Level& best() const {
        return levels_.front();
    }

private:
    Sequence<Level> levels_;
};

BookSide<std::vector> contiguous_side;
BookSide<std::deque> stable_ends_side;
```

`BookSide<std::vector>` and `BookSide<std::deque>` are different class specializations. Their calls can inline through the chosen container, while their storage and invalidation behavior remain the behavior described in Chapter 10.

Template-template arguments must match the expected parameter shape. A variadic type-parameter form such as `template<class...> class Sequence` accepts common container templates whose remaining arguments have defaults. A template requiring a non-type capacity, such as `FixedVector<T, N>`, has a different shape:

```cpp
#include <array>
#include <cstddef>

template<class T, std::size_t N>
class FixedVector {
    std::array<T, N> storage_{};
};

template<template<class, std::size_t> class Sequence,
         std::size_t Capacity>
class BoundedBookSide {
    Sequence<Level, Capacity> levels_;
};

BoundedBookSide<FixedVector, 64> top_levels;
```

This is compile-time policy injection: the enclosing algorithm selects a storage recipe, not a runtime object. A concept-constrained concrete container parameter is often simpler when the caller already has a container object. Use a template-template parameter when the component itself must instantiate a related type family.

**Pitfall.** Every policy combination creates another specialization. Passing templates removes runtime dispatch but can multiply compile time and emitted code exactly like other template arguments.

## Instantiation mechanics

A template is a recipe, not a function or class by itself. **Instantiation** substitutes a template argument list into that recipe and produces a concrete specialization.

Most instantiation is implicit: using `Matrix<double, 2, 3>` causes the compiler to instantiate what that use requires. A class specialization's members are instantiated lazily, so an unused member can contain operations unsupported by its argument type.

```cpp
#include <vector>

struct NoEq {
    int value;
};

void store_values() {
    std::vector<NoEq> values{{1}, {2}};  // OK: storage needs no equality
    values.push_back(NoEq{3});           // OK

    const bool same = values == values;  // error: NoEq has no operator==
    static_cast<void>(same);
}
```

The declaration `std::vector<NoEq>` does not eagerly compile every member of `std::vector`. Equality is instantiated only when the equality expression needs it. This member-by-member rule lets class templates offer operations conditionally without rejecting every other use of the class.

Function templates similarly instantiate when a context needs a definition, rather than whenever a declaration is parsed. Merely taking part in overload resolution can require substituting a signature without instantiating its body. That boundary explains why an invalid signature can disappear through SFINAE while an invalid statement in the selected body produces a hard error.

A **point of instantiation** is the source location where the implementation conceptually instantiates a specialization. At working level, remember that declarations visible at the template definition and at relevant instantiation points affect lookup; two-phase lookup makes that split precise later in this chapter.

For a function specialization, the point is associated with the use that needs its definition. For a class specialization, member definitions can have their own points when separately required. The exact standard rules handle multiple translation units and dependent entities, but the usable rule is simple: make the template and its intended helpers visible before use.

An **explicit instantiation definition** requests one specialization directly. An `extern template` declaration tells other translation units not to instantiate that specialization implicitly:

```cpp
// price_level.hpp
#pragma once

template<class Price>
class PriceLevel {
public:
    void add(Price quantity) {
        quantity_ += quantity;
    }

    Price quantity() const {
        return quantity_;
    }

private:
    Price quantity_{};
};

extern template class PriceLevel<int>;
```

```cpp
// price_level.cpp
#include "price_level.hpp"

template class PriceLevel<int>;
```

```cpp
// strategy.cpp
#include "price_level.hpp"

int visible_quantity() {
    PriceLevel<int> level;
    level.add(20);
    return level.quantity();
}
```

The explicit definition requires the full template definition to be visible. Put exactly one such definition in the program. Omitting it while retaining `extern template` usually produces an undefined-symbol linker error rather than a compiler error.

Without `extern template`, each translation unit that uses the specialization may perform the same instantiation work and emit a weak definition. The linker merges those definitions under the ODR machinery from Chapter 19. `extern template` avoids redundant front-end work and object-file emission; it does not make calls faster at runtime.

Template definitions therefore usually live in headers: an implicitly instantiating translation unit needs the full recipe, not only a declaration. Explicit instantiation is one way to move selected common recipes behind a compiled source file while leaving other argument sets available from the header.

**Note.** An implementation can instantiate earlier or later than the conceptual point when doing so cannot change observable behavior or diagnostics required by the standard.

## Specialization

A **full specialization** replaces a primary template for one exact argument list. A **partial specialization** describes a family of class-template arguments more specific than the primary.

```cpp
#include <type_traits>

template<class T>
struct Storage {
    T value;
    static constexpr bool stores_pointer = false;
};

template<class T>
struct Storage<T*> {
    T* value;
    static constexpr bool stores_pointer = true;
};

template<>
struct Storage<void> {
    static constexpr bool stores_pointer = false;
};

static_assert(!Storage<int>::stores_pointer);
static_assert(Storage<int*>::stores_pointer);
static_assert(std::is_empty_v<Storage<void>>);
```

`Storage<int*>` matches both the primary and `Storage<T*>`; the partial specialization is more specialized, so it wins. `Storage<void>` selects the exact full specialization.

Class-template argument matching starts with the primary template's parameter structure, then compares every viable partial specialization. The compiler selects a unique most-specialized match; if two partial specializations match but neither is more specialized, using that argument list is ambiguous.

Function templates can be fully specialized but cannot be partially specialized. Overloading is the idiomatic replacement because overload resolution already ranks function candidates:

```cpp
#include <iostream>

template<class T>
void describe(const T&) {
    std::cout << "value\n";
}

void describe(const char*) {
    std::cout << "C string\n";
}

void show_description() {
    describe(42);       // prints: value
    describe("EURUSD"); // prints: C string
}
```

Do not attempt a spelling such as `template<class T> void describe<T*>(T*)`; partial specialization syntax does not exist for functions.

| Kind | Function template | Class template | Idiom if unavailable |
|---|---|---|---|
| Full specialization | Yes | Yes | Exact override |
| Partial specialization | No | Yes | Function overloading |
| Constrained refinement | Yes | Yes | Concepts and overloads |

**Pitfall.** For a function call, overload resolution first chooses among primary function templates and ordinary overloads. A full specialization attached to a different primary cannot rescue that call.

Specializations must be declared before the first use that would instantiate them in every translation unit where that use occurs. Getting the order wrong can violate the ODR (Chapter 19).

**Pitfall.** Adding specializations in `namespace std` is generally forbidden. A few standard customization points permit specialization for a user-defined type under explicit rules; prefer the customization mechanism documented by that facility.

## Two-phase name lookup

Template name lookup happens in two phases. At template definition, the compiler resolves **non-dependent names**—names whose meaning does not depend on a template parameter. At instantiation, it resolves relevant **dependent names** involving template arguments.

A typo in non-dependent code therefore fails even if the template is never instantiated:

```cpp
template<class T>
void publish(const T& value) {
    audit_start(); // error: non-dependent name has not been declared
    consume(value);
}
```

`audit_start` has no dependent arguments, so the compiler must resolve it while parsing the definition. The `consume(value)` call is dependent and waits for substitution. Ordinary unqualified lookup contributes declarations visible at definition; argument-dependent lookup can add functions from `T`'s associated namespaces at instantiation. A later unrelated declaration in the surrounding namespace does not simply become visible.

The parser cannot always know whether a dependent qualified name denotes a type or template. `typename` and `template` disambiguate those cases:

```cpp
template<class T>
auto first(T& range) {
    typename T::iterator position = range.begin();
    return *position;
}

template<class T>
int convert(T& value) {
    return value.template as<int>();
}
```

Without `typename`, the parser cannot assume `T::iterator` is a type. Without `template`, the `<` after `as` can be parsed as a less-than operator instead of the start of template arguments.

Members inherited from a dependent base are not found by ordinary lookup during the first phase:

```cpp
template<class T>
struct Base {
    void flush() {}
};

template<class T>
struct Derived : Base<T> {
    void broken() {
        flush();  // error: name is not found in the dependent base
    }

    void working() {
        this->flush();
    }
};
```

`this->flush()` makes the member access dependent, delaying its resolution until instantiation. `Base<T>::flush()` is the qualified alternative. This is the lookup rule behind a frequent CRTP surprise (Chapter 4).

**Note.** C++20 removed the need for `typename` in several unambiguous type contexts, but not everywhere. Use it when a dependent qualified name must be parsed as a type.

**Note.** Older MSVC releases delayed much more lookup until instantiation. Some legacy code consequently compiled there while GCC and Clang rejected missing declarations or disambiguators; current MSVC implements two-phase lookup much more closely.

This split makes templates stable across translation units. A non-dependent helper cannot silently change because one including source file happened to declare another overload before instantiation. Dependent customization remains possible through declarations visible with the template and through argument-dependent lookup.

## Compile-time type traits

The `<type_traits>` header is the standard compile-time introspection library. A trait is an ordinary class template, usually specialized so that a member named `value` or `type` reports its answer.

Variable-template aliases ending in `_v` expose values directly, while alias templates ending in `_t` expose transformed types:

```cpp
#include <type_traits>

static_assert(std::is_pointer_v<int*>);
static_assert(!std::is_pointer_v<int>);

using Raw = std::remove_cvref_t<const int&>;  // C++20
static_assert(std::is_same_v<Raw, int>);
```

The shortcuts avoid the older `std::is_pointer<T>::value` and `typename std::remove_cvref<T>::type` spellings.

Traits are built from specialization, not compiler magic at the interface. This trait recognizes `std::span` specializations:

```cpp
#include <cstddef>
#include <span>
#include <type_traits>

template<class T>
struct IsSpanLike : std::false_type {};

template<class T, std::size_t Extent>
struct IsSpanLike<std::span<T, Extent>> : std::true_type {};

template<class T>
inline constexpr bool is_span_like_v =
    IsSpanLike<std::remove_cvref_t<T>>::value;

static_assert(is_span_like_v<std::span<int>>);
static_assert(is_span_like_v<const std::span<const double>&>);
static_assert(!is_span_like_v<int*>);
```

The primary template answers false. Partial specialization matches every `std::span<T, Extent>` and answers true. Removing references and cv-qualifiers before querying lets a deduced `const std::span<int>&` reach that specialization.

| Category | Examples | Answers the question |
|---|---|---|
| Queries | `is_integral`, `is_trivially_copyable` | What properties does this type have? |
| Transforms | `remove_reference`, `decay` | Which related type should be used? |
| Relationships | `is_same`, `is_convertible`, `is_base_of` | How do two types relate? |

**Pitfall.** Traits answer about the exact type supplied. A reference is not trivially copyable merely because its referred-to type is; apply `std::remove_cvref_t` first when the intended question concerns the underlying deduced type.

## Dispatch on type: from tags to concepts

Compile-time dispatch chooses an implementation from type information without storing a runtime tag. C++ has accumulated several ways to express that choice; each generation packages the same overload-resolution and instantiation machinery more clearly.

### Tag dispatch

A **tag type** is an otherwise empty type used to select an overload. Iterator category tags let an advance operation choose constant-time addition for random-access iterators and repeated increment for input iterators, as introduced in Chapter 13:

```cpp
#include <iterator>

template<class Iterator, class Distance>
void advance_impl(
    Iterator& position,
    Distance distance,
    std::input_iterator_tag) {
    while (distance > 0) {
        ++position;
        --distance;
    }
}

template<class Iterator, class Distance>
void advance_impl(
    Iterator& position,
    Distance distance,
    std::random_access_iterator_tag) {
    position += distance;
}

template<class Iterator, class Distance>
void advance_cursor(Iterator& position, Distance distance) {
    using Category =
        typename std::iterator_traits<Iterator>::iterator_category;
    advance_impl(position, distance, Category{});
}
```

`Category{}` has no runtime state. Overload resolution selects `advance_impl`, and optimization removes the empty tag object. The input-iterator overload above has the narrow precondition `distance >= 0`; bidirectional handling is outside this example.

### Substitution failure and SFINAE

The compiler first forms candidates for overload resolution. If substituting deduced template arguments into a candidate's immediate signature produces an invalid type or expression, that candidate silently leaves the set instead of making the program ill-formed.

This rule is **substitution failure is not an error** (SFINAE). Failure inside the instantiated function body is not SFINAE; by then the overload has already been selected.

Legacy code converts a trait's Boolean answer into overload participation with `std::enable_if_t` **(C++14)**. A small overload probe can produce that Boolean before `std::void_t` packages the pattern more cleanly:

```cpp
template<class C>
auto reserve_probe(int) -> decltype(
    std::declval<C&>().reserve(std::size_t{}),
    std::true_type{});

template<class>
auto reserve_probe(...) -> std::false_type;

template<class C>
inline constexpr bool reservable_v =
    decltype(reserve_probe<C>(0))::value;

template<class C>
std::enable_if_t<reservable_v<C>>
reserve_sfinae(C& container, std::size_t count) {
    container.reserve(count);
}

template<class C>
std::enable_if_t<!reservable_v<C>>
reserve_sfinae(C&, std::size_t) {
}
```

Exactly one return type is well-formed for each `C`, so exactly one overload participates. The signature says little about the intent. In a legacy overload set with no fallback or with additional requirements, a failed call often reports the internals:

```text
error: no matching function for call to 'reserve_sfinae'
note: candidate template ignored: requirement 'reservable_v<FixedBook>' was not satisfied
note: candidate template ignored: substitution failure in 'std::enable_if_t<...>'
```

**Pitfall.** Default template arguments are not part of a function template's signature. Two overloads that differ only in `class = std::enable_if_t<condition>` are redefinitions, not complementary candidates:

```cpp
template<class T, class = std::enable_if_t<std::is_integral_v<T>>>
void encode(T);

template<class T, class = std::enable_if_t<std::is_floating_point_v<T>>>
void encode(T);  // error: redefinition; defaults do not distinguish it
```

Return-type placement, a non-type template parameter, or concepts can distinguish participation. Modern code should prefer concepts when a named requirement expresses the intent.

### Detection with void_t

The **detection idiom** asks whether substituting a type into an expression is well-formed. `std::void_t` **(C++17)** maps any well-formed list of types to `void`; a partial specialization is selected only when forming that list succeeds.

```cpp
#include <cstddef>
#include <array>
#include <type_traits>
#include <utility>
#include <vector>

template<class C, class = void>
struct HasReserve : std::false_type {};

template<class C>
struct HasReserve<
    C,
    std::void_t<decltype(
        std::declval<C&>().reserve(std::declval<std::size_t>()))>>
    : std::true_type {};

template<class C>
inline constexpr bool has_reserve_v = HasReserve<C>::value;

static_assert(has_reserve_v<std::vector<int>>);
static_assert(!has_reserve_v<std::array<int, 8>>);
```

`std::declval<C&>()` supplies an unevaluated expression with type `C&`; it creates no object and may be used only in an unevaluated context such as `decltype`. If the member call is invalid, substitution of the partial specialization fails and the primary template remains.

Only failures in the substitution's **immediate context** remove a candidate. If substitution successfully forms the signature and the chosen function body later calls a nonexistent member, compilation fails normally. Moving a questionable expression into `decltype`, a trait, or a requires-expression is what makes it control participation.

### if constexpr

`if constexpr` **(C++17)** makes the selection inside one function body. The branch whose condition is false is discarded during instantiation:

```cpp
template<class C>
void reserve_if_possible(C& container, std::size_t count) {
    if constexpr (has_reserve_v<C>) {
        container.reserve(count);
    } else {
        static_cast<void>(container);
        static_cast<void>(count);
    }
}
```

For `std::array<int, 8>`, the invalid `container.reserve(count)` expression is in a discarded dependent branch and is not instantiated. Both branches must still be syntactically valid, and outside a template a false `if constexpr` does not provide a general-purpose shelter for ill-formed code.

### Concepts

A requires-expression states the detection directly, and a requires-clause makes it part of overload participation **(C++20)**:

```cpp
template<class C>
concept Reservable = requires(C& container, std::size_t count) {
    container.reserve(count);
};

template<class C>
void reserve_concept(C&, std::size_t) {
}

template<Reservable C>
void reserve_concept(C& container, std::size_t count) {
    container.reserve(count);
}
```

For a reservable type, the constrained overload is more specialized than the unconstrained fallback. For another type, only the fallback is viable. The direct one-off spelling is also valid:

```cpp
template<class C>
requires requires(C& container, std::size_t count) {
    container.reserve(count);
}
void reserve_required(C& container, std::size_t count) {
    container.reserve(count);
}
```

Concepts do not add a runtime check. They expose the condition to overload resolution and let diagnostics name the failed requirement rather than an `enable_if` implementation detail.

| Technique | Readability | Diagnostics | Use when |
|---|---|---|---|
| Tag dispatch | Clear with established tags | Ordinary overload errors | Category selects distinct algorithms |
| `enable_if` SFINAE | Low | Often indirect | Maintaining pre-C++20 interfaces |
| Detection idiom | Medium | Trait internals surface | Producing reusable Boolean traits |
| `if constexpr` | High in one algorithm | Error points into chosen branch | Implementations share one interface |
| Concepts | Highest | Failed requirements are named | Constraining modern overload sets |

All five techniques resolve at compile time. The difference is how directly they express the requirement and where a failure appears.

## Constraint subsumption

Two constrained overloads can both be viable. **Constraint subsumption** lets the compiler determine that one constraint implies another, making the first overload more constrained instead of ambiguous.

The standard concepts `std::integral` and `std::signed_integral` are defined so that the latter includes the former as an atomic constraint:

```cpp
#include <concepts>
#include <iostream>

void classify(std::integral auto) {
    std::cout << "integral\n";
}

void classify(std::signed_integral auto) {
    std::cout << "signed integral\n";
}

int main() {
    classify(42);   // prints: signed integral
    classify(42u);  // prints: integral
}
```

For `int`, both overloads satisfy their constraints, but `std::signed_integral` subsumes `std::integral`. The compiler selects the more constrained function.

The compiler normalizes constraints into **atomic constraints**. Two atoms are identical only when they originate from the same source-level expression after concept expansion, not merely when their text looks equal.

```cpp
template<class T>
requires requires(T value) { value.size(); }
void inspect(const T&);

template<class T>
requires (
    requires(T value) { value.size(); } &&
    std::copy_constructible<T>)
void inspect(const T&);

void inspect_vector(const std::vector<int>& values) {
    inspect(values); // error: repeated size requirement is a distinct atom
}
```

Name a reusable constraint so every overload expands the same concept definition:

```cpp
template<class T>
concept Sized = requires(T value) {
    value.size();
};

template<Sized T>
void examine(const T&);

template<class T>
requires Sized<T> && std::copy_constructible<T>
void examine(const T&);
```

The second `examine` overload subsumes the first because both obtain the `Sized<T>` atom from the same concept definition.

Conjunction and disjunction affect normalization: `A && B` requires both atoms, while `A || B` provides alternatives. Subsumption compares those normalized forms, not arbitrary semantic facts about C++ types. The compiler does not prove that two separately written arithmetic predicates mean the same thing.

**Rule.** Name reusable constraints as concepts. Copy-pasted requires-expressions can be logically equivalent to a human and still fail to subsume because their atoms have different source identities.

## Variadic templates and folds

A **template parameter pack** represents zero or more template arguments. `class... Ts` declares a type pack, `Ts... arguments` declares a corresponding function-parameter pack, and `sizeof...(arguments)` reports its element count at compile time.

An expansion repeats a pattern once for every pack element:

```cpp
template<class T>
int encode_one(const T&);

template<class... Ts>
void send_all(const Ts&...) {
}

template<class... Ts>
void emit_record(const Ts&... arguments) {
    const std::array<int, sizeof...(Ts)> fields{
        encode_one(arguments)...};       // transform each element
    send_all(arguments...);              // pass the whole pack to one call
    static_cast<void>(fields);
}
```

The expansion in the braced initializer repeats `encode_one(arguments)`. The expansion in `send_all(arguments...)` passes all expanded arguments to one call. Unlike C variadics (Chapter 3), packs retain every argument's type and require no `va_arg`.

Before fold expressions, a variadic function commonly peeled one argument per recursive instantiation:

```cpp
#include <iostream>

void log_recursive() {
    std::cout << '\n';
}

template<class First, class... Rest>
void log_recursive(const First& first, const Rest&... rest) {
    std::cout << first;
    log_recursive(rest...);
}

template<class... Ts>
void log_fold(const Ts&... arguments) {
    (std::cout << ... << arguments) << '\n';
}

template<class... Ts>
void log_each(const Ts&... arguments) {
    auto write = [](const auto& value) {
        std::cout << value;
    };
    (static_cast<void>(write(arguments)), ...);
    std::cout << '\n';
}

int main() {
    log_recursive("bid=", 101, ",qty=", 20); // prints: bid=101,qty=20
    log_fold("bid=", 101, ",qty=", 20);      // prints: bid=101,qty=20
    log_each("bid=", 101, ",qty=", 20);      // prints: bid=101,qty=20
}
```

The recursive form instantiates a function for each suffix of the pack. The binary fold expresses the output chain in one function specialization. The comma fold calls `write` once per argument and sequences those calls left to right.

A **fold expression** **(C++17)** reduces a pack with an operator. For a pack `args` containing `a`, `b`, and `c`, the four forms group as follows:

| Form | Expansion | Empty-pack result |
|---|---|---|
| Unary left: `(... op args)` | `((a op b) op c)` | Defined only for `&&`, `\|\|`, `,` |
| Unary right: `(args op ...)` | `(a op (b op c))` | Defined only for `&&`, `\|\|`, `,` |
| Binary left: `(init op ... op args)` | `((init op a) op b) op c` | `init` |
| Binary right: `(args op ... op init)` | `a op (b op (c op init))` | `init` |

For an empty unary fold, `&&` yields `true`, `||` yields `false`, and comma yields `void()`. Other unary operators are ill-formed on an empty pack.

Left and right folds differ for non-associative operators. A subtraction left fold computes `(a - b) - c`, while a right fold computes `a - (b - c)`. Choose the form from the required grouping rather than from visual preference.

```cpp
template<class... Numbers>
constexpr bool all_positive(const Numbers&... numbers) {
    return (... && (numbers > 0));
}

static_assert(all_positive());
static_assert(all_positive(1, 2.5, 9));
static_assert(!all_positive(1, -2, 9));
```

**Pitfall.** Recursive peeling multiplies instantiations with arity. Prefer a fold when the operation fits one; use a braced initializer or comma fold when left-to-right sequencing is required.

## Forwarding references and perfect forwarding

A parameter of the exact form `T&&` is a **forwarding reference** when `T` is deduced for that call. An lvalue argument deduces `T` as an lvalue-reference type; an rvalue argument deduces `T` as a non-reference type.

```cpp
template<class T>
void observe(T&&) {
}

void deduction_examples() {
    int quantity = 20;

    observe(quantity);  // T = int&, parameter = int&
    observe(20);        // T = int,  parameter = int&&
}
```

`std::vector<T>&&` is not a forwarding reference because the parameter is not exactly a deduced `T&&`. A class template's member taking its already-fixed class parameter as `T&&` is an rvalue reference for the same reason.

`const T&&` is also an ordinary rvalue reference, not a forwarding reference. The added `const` prevents the special deduction rule and usually defeats the purpose of accepting an rvalue, because most move operations require a mutable source.

Reference formation follows **reference collapsing**. Any combination containing an lvalue reference collapses to an lvalue reference; only two rvalue references produce an rvalue reference.

| Declared pattern | Substituted `T` | Resulting parameter type |
|---|---|---|
| `T&` | `U&` | `U&` from `U& &` |
| `T&&` | `U&` | `U&` from `U& &&` |
| `T&` | `U&&` | `U&` from `U&& &` |
| `T&&` | `U&&` | `U&&` from `U&& &&` |

A named variable is an lvalue expression even when its type is `T&&`. `std::forward<T>(value)` restores the argument category encoded by deduction. Conceptually, it performs `static_cast<T&&>(value)`: collapsing produces `U&` for the original lvalue and `U&&` for the original rvalue.

`const` remains part of deduction. Passing a `const U` lvalue deduces `T` as `const U&`, and forwarding preserves that read-only lvalue. Perfect forwarding preserves the caller's category and qualifiers; it does not manufacture permission to move from a `const` object.

This is **perfect forwarding**. A wrapper forwards each argument so the wrapped constructor sees the same value category and cv-qualification that the wrapper received.

An object-pool factory can construct directly in a slot obtained from the pool (Chapter 17):

```cpp
#include <cstddef>
#include <new>
#include <utility>

class ObjectPool {
public:
    void* allocate(std::size_t size, std::size_t alignment);
    void release(void* address) noexcept;
};

template<class T, class... Args>
T* make_pooled(ObjectPool& pool, Args&&... arguments) {
    void* storage = pool.allocate(sizeof(T), alignof(T));

    try {
        return ::new (storage) T(
            std::forward<Args>(arguments)...);
    } catch (...) {
        pool.release(storage);
        throw;
    }
}
```

The pack expansion forwards every constructor argument independently. If construction throws, the catch block returns the unused slot before rethrowing. The caller must later destroy the object and release its slot according to the pool's ownership API.

`Args` is a pack of independently deduced types. One call can therefore encode an lvalue symbol as `std::string&`, a temporary price as `Price`, and a `const` configuration as `const Config&`; the corresponding collapsed parameter and forwarded expression retain each distinction.

This is the pattern behind `std::make_unique` and emplacement functions: obtain destination storage, then construct once with forwarded arguments. Omitting `std::forward` turns every named `arguments` expression into an lvalue and can replace a move with a copy.

A forwarding constructor can also outcompete the copy constructor:

```cpp
class Label {
public:
    explicit Label(std::string text) : text_(std::move(text)) {}
    Label(const Label&) = default;

    template<class U>
    explicit Label(U&& value)
        : text_(std::forward<U>(value)) {}

private:
    std::string text_;
};

void copy_label(Label& source) {
    Label copy{source}; // error: std::string cannot construct from Label
}
```

The template binds `Label&` exactly, while the copy constructor needs a qualification conversion to `const Label&`. Constrain the forwarding constructor away from the class itself:

```cpp
class SafeLabel {
public:
    explicit SafeLabel(std::string text) : text_(std::move(text)) {}
    SafeLabel(const SafeLabel&) = default;

    template<class U>
    requires (!std::same_as<std::remove_cvref_t<U>, SafeLabel>)
    explicit SafeLabel(U&& value)
        : text_(std::forward<U>(value)) {}

private:
    std::string text_;
};
```

- `std::forward(value)` without an explicit template argument does not deduce the intended type; write `std::forward<T>(value)`.
- Replacing forwarding with `std::move(value)` compiles but wrongly moves from lvalue callers.
- Forwarding the same argument into two consuming operations can move from it twice; the second operation sees a moved-from object.
- `auto&&` in a generic lambda follows the same deduction rule; Chapter 21 connects it to closure types.

## Expression templates

An **expression template** represents an unevaluated expression as a tree of types. Operators build small nodes instead of allocating result containers, and assignment traverses the tree once to compute the final elements.

```cpp
#include <cassert>
#include <cstddef>
#include <initializer_list>
#include <iostream>
#include <vector>

class Vec {
public:
    explicit Vec(std::size_t size) : values_(size) {}
    Vec(std::initializer_list<double> values) : values_(values) {}

    std::size_t size() const {
        return values_.size();
    }

    double operator[](std::size_t index) const {
        return values_[index];
    }

    template<class Expression>
    Vec& operator=(const Expression& expression) {
        assert(size() == expression.size());
        for (std::size_t index = 0; index < size(); ++index) {
            values_[index] = expression[index];
        }
        return *this;
    }

private:
    std::vector<double> values_;
};

template<class Left, class Right>
class AddExpr {
public:
    AddExpr(const Left& left, const Right& right)
        : left_(left), right_(right) {
        assert(left.size() == right.size());
    }

    std::size_t size() const {
        return left_.size();
    }

    double operator[](std::size_t index) const {
        return left_[index] + right_[index];
    }

private:
    const Left& left_;
    const Right& right_;
};

template<class Left, class Right>
AddExpr<Left, Right> operator+(const Left& left, const Right& right) {
    return {left, right};
}

int main() {
    Vec bids{100.0, 101.0, 102.0};
    Vec fees{0.1, 0.1, 0.1};
    Vec offsets{1.0, 1.0, 1.0};
    Vec result(3);

    result = bids + fees + offsets;  // one assignment loop, no Vec temporaries
    std::cout << result[1] << '\n';  // prints: 102.1
}
```

The type of `bids + fees` is `AddExpr<Vec, Vec>`. Adding `offsets` produces a nested `AddExpr<AddExpr<Vec, Vec>, Vec>`, an abstract syntax tree encoded in the type system. `Vec::operator=` evaluates `expression[index]` inside one loop, so the source-level design makes one pass and creates no intermediate `Vec`.

Each `operator[]` call recursively requests one element from its children. The optimizer sees the complete node types and can inline that chain into the assignment loop. There is no virtual dispatch and no heap allocation for the expression nodes themselves; the small nodes contain only operand references.

Linear-algebra libraries such as Eigen and Blaze use richer versions of this technique. An eager `a + b + c` implementation would ordinarily materialize the result of `a + b`, then allocate and traverse another result for `+ c`.

Production implementations also constrain compatible shapes, account for aliasing, and choose storage policies for expression nodes. Those details do not change the core mechanism: operator overloads assemble types, and a destination-controlled loop performs evaluation.

**Pitfall.** `auto expression = bids + fees;` stores the lazy expression object, not a result vector. Its nodes hold references; if either operand or an intermediate expression dies before evaluation, those references dangle, the same lifetime shape as lazy views (Chapter 13).

## Template costs

Every instantiated specialization is real code unless optimization merges or removes it. Instantiating `M` substantial member functions for `N` unrelated types can produce roughly `N × M` emitted functions.

An illustrative demangled symbol list makes the duplication visible:

```text
std::vector<int>::push_back(int const&)
std::vector<double>::push_back(double const&)
std::vector<Order>::push_back(Order const&)
```

The cost appears in several places:

- The compiler parses template definitions from headers and performs substitution for every needed argument set.
- Object files can contain repeated weak definitions until the linker merges them (Chapter 19).
- Distinct specializations remain distinct machine code when their operations differ or identical-code folding cannot merge them.
- More machine code widens the instruction-cache working set (Chapter 16).

Templates trade that footprint for static knowledge. Calls can inline, constants can propagate, and dead type-specific branches can disappear. Type erasure makes the opposite trade at a boundary: one non-template implementation and stable headers, paid for with an indirect call and less optimization across the erased interface (Chapter 4).

Inlining does not guarantee a smaller binary. It can duplicate a template specialization into many call sites even after weak definitions are merged. Measure release binaries and representative instruction-cache behavior rather than treating source-level abstraction as evidence of zero cost.

| Dimension | Template instantiation | Type erasure |
|---|---|---|
| Call cost | Direct; often inlineable | Indirect dispatch |
| Code size | Per argument set | Shared implementation |
| Header exposure | Definition usually visible | Interface can hide implementation |
| Compile time | Substitution per use | Mostly fixed implementation |

Useful compile-time controls include:

- Put `extern template` declarations in a header and one explicit instantiation definition in a source file for common specializations.
- Move type-independent work into a thin non-template core called by a small template shim.
- Use type-erased interfaces at module boundaries and instantiate templates inside performance-critical loops.
- Use precompiled headers to reduce repeated parsing of stable, heavy headers; they do not remove template instantiation work itself.

Thread-safe initialization of function-local statics in template specializations follows the rules covered in Chapter 23.

**Interview.** A strong comparison of templates with virtual or erased dispatch includes both axes: templates enable inlining and type-specific optimization but multiply compilation and code; erasure consolidates code but adds an indirect call and hides concrete types from the optimizer.

## Latency Lens

- Every distinct template-argument set can emit another copy of code, widening the instruction-cache footprint exactly as manual duplication would (Chapter 16).
- NTTP dimensions such as `Matrix<double, 3, 3>` expose loop bounds as constants, enabling unrolling and vectorization at the cost of a specialization per dimension.
- Template-template policy parameters select a type family without a runtime tag, but every selected family still creates another enclosing specialization.
- Tag dispatch, SFINAE, concepts, and `if constexpr` resolve before runtime; their type-based selection executes no runtime dispatch instruction.
- A discarded `if constexpr` branch reaches no code generation, so it adds neither a branch-predictor decision nor dead instructions to the specialization.
- Perfect forwarding preserves value categories into in-place construction; omitting `std::forward` can silently turn a move into a copy.
- Recursive variadic peeling instantiates a function for each suffix of the pack, while a fold expresses the reduction in one specialization.
- Expression templates fuse element-wise operators into one assignment pass and avoid temporary container allocations.
- `extern template` suppresses redundant per-translation-unit instantiation and emission; it improves builds and object size, not runtime execution.
- Type erasure at a boundary pays an indirect call but consolidates code, while templates in a hot loop expose operations for inlining and constant propagation.
