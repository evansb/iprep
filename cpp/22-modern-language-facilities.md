# 22. Modern Language Facilities

Modern C++ adds language facilities that remove boilerplate, expose compile-time intent, and make generated behavior explicit. These features belong to the language rather than any one library. Adopt the shipping C++23 facilities now; treat the C++26 material as a preview.

## Language versions and feature-test macros

The `__cplusplus` macro reports the selected language mode: `201103L` for C++11, `201402L` for C++14, `201703L` for C++17, `202002L` for C++20, and `202302L` for C++23. It does not prove that a particular compiler and standard library implement every feature from that edition.

Feature-test macros answer the useful question directly. Language macros such as `__cpp_concepts` come from the compiler; library macros such as `__cpp_lib_expected` are available through `<version>` **(C++20)** or the feature's own header.

```cpp
#include <iostream>
#include <version>

#ifdef __cpp_lib_expected
#include <expected>
int read_sequence() {
    std::expected<int, int> result{42};
    return *result;
}
#else
int read_sequence() {
    return 42;  // project fallback
}
#endif

int main() {
    std::cout << read_sequence() << '\n';  // prints: 42
}
```

This gate asks for `std::expected`, not a nominal C++ version. That matters when compilers and standard libraries ship features at different times or backport them into older modes. Conditional compilation itself follows the preprocessing rules from Chapter 19; error handling with `expected` belongs to Chapter 6.

Feature macros carry dates rather than booleans, so code can request a revision:

```cpp
#if defined(__cpp_concepts) && __cpp_concepts >= 201907L
template<class T>
concept Priced = requires(const T& value) {
    value.price();
};
#endif
```

Do not define reserved `__cpp_` macros yourself. An absent or older value means the implementation cannot support the path you selected.

| Standard | Year | Identity |
|---|---:|---|
| C++11 | 2011 | Move semantics and the modern reboot |
| C++14 | 2014 | Generic refinement and relaxed `constexpr` |
| C++17 | 2017 | Vocabulary types and broader compile-time code |
| C++20 | 2020 | Concepts, ranges, coroutines, and modules |
| C++23 | 2023 | Library completion and explicit object parameters |
| C++26 | 2026 | Contracts and reflection, in progress |

**Note.** MSVC historically reports an old `__cplusplus` value unless `/Zc:__cplusplus` is enabled. Feature-test macros remain the more precise gate under every compiler.

## Range-based `for`, desugared

A range-based `for` **(C++11)** evaluates its range expression once. The compiler binds a hidden reference to the result, obtains the beginning and ending positions once, then advances through them.

```cpp
void print_prices() {
    std::vector<int> prices{101, 102, 103};

    for (int price : prices) {
        std::cout << price << ' ';
    }

    auto&& hidden_range = prices;
    auto hidden_begin = begin(hidden_range);
    auto hidden_end = end(hidden_range);
    for (; hidden_begin != hidden_end; ++hidden_begin) {
        int price = *hidden_begin;
        std::cout << price << ' ';
    }
}
// both loops print: 101 102 103
```

The names are explanatory; the standard's transformation uses exposition-only variables. Lookup first considers suitable member `begin()` and `end()` functions. Otherwise it finds free `begin(range)` and `end(range)` through argument-dependent lookup (Chapter 3). The two returned types may differ when the end is a sentinel, using the iterator protocol from Chapter 13.

The hidden `auto&&` explains the range-expression lifetime rule. Before C++23, only the outer temporary bound directly to that reference was extended. C++23 extends temporaries inside the range initializer through the loop:

```cpp
struct Text {
    std::string storage;

    std::string_view view() const {
        return storage;
    }
};

void print_text() {
    for (char c : Text{"FAST"}.view()) {  // UB before C++23; valid in C++23
        std::cout << c;                   // prints: FAST
    }
}
```

This does not repair a function that returns a dangling reference to its by-value parameter; that parameter still dies in the callee. The safe rule from Chapter 5 remains: understand which object owns the iterated elements.

Element declaration controls copying:

- `auto element` copies each element.
- `auto& element` permits mutation without copying.
- `const auto& element` avoids copying and forbids mutation.

**Pitfall.** A range expression runs once, but copying with `auto` runs once per element. Use a reference when elements are expensive and a copy is not intentional.

## Structured bindings, desugared

A structured binding **(C++17)** creates a hidden object, then introduces names bound into it. `auto [price, quantity] = order;` copies `order` once into the hidden object; it does not independently initialize two unrelated variables.

```cpp
struct Order {
    std::int64_t price;
    int quantity;
};

Order order{10'025, 50};

void mutate_order() {
    auto [price, quantity] = order;  // hidden Order object copies order
    quantity = 75;                   // changes the hidden copy

    auto& [live_price, live_quantity] = order;
    live_quantity = 100;             // changes order.quantity
    std::cout << order.quantity << '\n';  // prints: 100
    std::cout << price << ' ' << quantity << ' ' << live_price << '\n';
    // prints: 10025 75 10025
}
```

The compiler chooses one of three binding protocols in priority order:

1. Built-in arrays bind one name per element.
2. Tuple-like types use `std::tuple_size`, `std::tuple_element`, and `get` (Chapter 14).
3. Eligible classes bind their non-static data members in declaration order.

The declaration before `[` controls the hidden object's initialization. `auto` creates a new hidden object by value, `auto&` binds it to an lvalue, and `auto&&` forwards the initializer's value category. The individual names then bind into that chosen object.

Tuple-like return values therefore unpack without inventing a result class:

```cpp
std::tuple<std::int64_t, int> best_bid() {
    return {10'025, 40};
}

void print_best_bid() {
    auto [bid_price, bid_quantity] = best_bid();
    std::cout << bid_price << ' ' << bid_quantity << '\n';
    // prints: 10025 40
}
```

Map iteration is the common payoff:

```cpp
void print_positions(const std::map<std::string, int>& positions) {
    for (const auto& [symbol, position] : positions) {
        std::cout << symbol << ": " << position << '\n';
    }
}
```

Bindings cannot nest patterns or skip elements. Structured-binding packs such as `auto [first, ...rest] = values;` are a **(C++26)** preview, as is a reusable placeholder name for ignored bindings; shipping compiler support remains experimental.

**Note.** `decltype(live_quantity)` yields the declared member type, `int`, rather than `int&`, even though assigning through the binding changes `order`. Parenthesized `decltype((live_quantity))` follows the normal expression rules and yields a reference.

**Pitfall.** A by-value binding copies the entire hidden object even if only one binding is read. Prefer `const auto& [...]` for large tuples, map entries, and records.

## Three-way comparison

`operator<=>` **(C++20)**, pronounced “spaceship,” computes ordering in one operation. A defaulted spaceship compares members lexicographically and generates the relational operators that Chapter 4 otherwise writes by hand.

```cpp
#include <compare>
#include <cstdint>
#include <iostream>

struct Price {
    std::int64_t ticks;

    auto operator<=>(const Price&) const = default;
};

int main() {
    Price bid{10'025};
    Price ask{10'030};
    std::cout << std::boolalpha
              << (bid < ask) << ' ' << (bid != ask) << '\n';
    // prints: true true
}
```

The compiler rewrites `bid < ask` using `(bid <=> ask) < 0`. It rewrites `bid != ask` through equality. A defaulted `<=>` implicitly supplies a matching defaulted `operator==`; a hand-written `<=>` does not, so define equality too.

| Category | Meaning | Incomparable? | Example |
|---|---|---:|---|
| `std::strong_ordering` | Equal values are substitutable | No | `int`, `Price` |
| `std::weak_ordering` | Equivalent values may differ observably | No | Case-insensitive symbol |
| `std::partial_ordering` | Some pairs have no order | Yes | `double` with NaN |

Strong equality promises substitutability: code may treat equal objects interchangeably. Weak equivalence can group different representations, such as `"aapl"` and `"AAPL"`, while preserving the spelling.

```cpp
struct Symbol {
    std::string text;

    static char fold(char c) {
        return c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c;
    }

    friend std::weak_ordering operator<=>(const Symbol& left,
                                          const Symbol& right) {
        return std::lexicographical_compare_three_way(
            left.text.begin(), left.text.end(),
            right.text.begin(), right.text.end(),
            [](char a, char b) { return fold(a) <=> fold(b); });
    }

    friend bool operator==(const Symbol& left, const Symbol& right) {
        return (left <=> right) == 0;
    }
};
```

The generated operators work with ordered containers from Chapter 11 and sorting from Chapter 13. Equality remains separate because implementations can often decide it faster than a full ordering comparison, such as rejecting strings with different lengths first.

Defaulting follows member declaration order, so representation order becomes comparison order. If business ordering differs—perhaps venue before symbol while storage puts a timestamp first—write the spaceship explicitly rather than rearranging members for semantics.

**Pitfall.** A defaulted `<=>` on `double` members produces `std::partial_ordering`. NaN is unordered; feeding such values to an ordered container without a strict weak ordering violates the container's requirements.

## The `constexpr` family

| Keyword | Means | Evaluation | Use for |
|---|---|---|---|
| `constexpr` | Permitted in constant expressions | Compile time when required | Functions, constants, tables |
| `consteval` | Immediate function | Every potentially evaluated call at compile time | Compile-time-only validation and hashing |
| `constinit` | Constant initialization required | Initialization at compile time | Mutable static-storage state |

`constexpr` may run during compilation. It must do so in a constant-expression context, such as initializing a `constexpr` variable or checking a `static_assert`; an ordinary call may execute at runtime.

This CRC table is built by the compiler:

```cpp
constexpr std::uint32_t crc_entry(std::uint32_t value) {
    for (int bit = 0; bit < 8; ++bit) {
        value = (value & 1U)
            ? 0xEDB88320U ^ (value >> 1)
            : value >> 1;
    }
    return value;
}

constexpr auto make_crc_table() {
    std::array<std::uint32_t, 256> table{};
    for (std::size_t i = 0; i < table.size(); ++i) {
        table[i] = crc_entry(static_cast<std::uint32_t>(i));
    }
    return table;
}

inline constexpr auto crc_table = make_crc_table();
static_assert(crc_table[0] == 0);

std::uint32_t extend_crc(std::uint32_t crc, unsigned char byte) {
    return (crc >> 8) ^ crc_table[(crc ^ byte) & 0xFFU];
}
```

The table lands in read-only data rather than being generated during startup, following the section-placement rules from Chapter 19. Each runtime extension performs arithmetic and one table lookup.

Constant evaluation now permits loops, virtual calls when the target is known, and transient use of `std::vector`, `std::string`, and dynamic allocation **(C++20)**. Allocated storage cannot escape into runtime; no compile-time heap pointer can become a runtime pointer.

Undefined behavior is rejected during required constant evaluation:

```cpp
constexpr std::array<int, 2> values{10, 20};
constexpr int invalid = values[3];  // error: out-of-bounds access
```

That turns constant evaluation into a build-time sanitizer for executed paths. Overflow, invalid shifts, and out-of-bounds reads fail compilation rather than becoming runtime UB.

`consteval` **(C++20)** declares an immediate function:

```cpp
consteval std::uint64_t hash_key(std::string_view key) {
    std::uint64_t hash = 1469598103934665603ULL;
    for (char c : key) {
        hash = (hash ^ static_cast<unsigned char>(c))
             * 1099511628211ULL;
    }
    return hash;
}

constexpr auto order_key = hash_key("order");

std::uint64_t runtime_hash(std::string_view key) {
    return hash_key(key);  // error: key is not a constant expression
}
```

Use `consteval` when a runtime call would indicate a design mistake. `if consteval` **(C++23)** lets one function select a compile-time path without using template machinery.

`constinit` **(C++20)** applies to an object with static or thread storage duration:

```cpp
constexpr int compute_start() {
    return 1'000;
}

constinit int sequence_start = compute_start();

int next_start() {
    return sequence_start++;  // mutable after constant initialization
}
```

Constant initialization removes the cross-translation-unit dynamic-initialization ordering hazard from Chapter 5. `constinit` does not make the object constant; it constrains initialization only. By contrast, a `constexpr` variable is `const`.

## Deducing `this`

An explicit object parameter **(C++23)** makes the object parameter visible in a member function's signature. Its type and value category are deduced like any other forwarding reference.

```cpp
struct QuoteBefore {
    int price_;

    int& price() & { return price_; }
    const int& price() const & { return price_; }
};

struct Quote {
    int price_;

    template<class Self>
    decltype(auto) price(this Self&& self) {
        return (std::forward<Self>(self).price_);  // parentheses are load-bearing
    }
};
```

The single `Quote::price` preserves `const` and lvalue/rvalue category through `Self`. It replaces overload sets that differ only in object qualification.

The parentheses in the return statement are required. `decltype(auto)` applies `decltype` rules to the return expression, and `decltype` of an *unparenthesized* member access reports the member's declared type — so `return std::forward<Self>(self).price_;` returns `int` by value for every `Self`, silently losing the property this member function exists to provide. Parenthesizing makes `decltype` observe an lvalue or xvalue expression instead, yielding `int&`, `const int&`, or `int&&` to match the object. This is the same rule Chapter 2 introduced with `decltype((quantity))`.

A caller that binds the rvalue case must still respect lifetime: `Quote{7}.price()` produces an `int&&` referring to a member of a temporary that dies at the end of the full-expression.

The object can also be passed by value:

```cpp
struct Price {
    std::int64_t ticks;

    Price scaled(this Price self, std::int64_t factor) {
        self.ticks *= factor;
        return self;
    }
};

Price doubled = Price{50}.scaled(2);
```

For a small trivially copied type, a by-value object can travel in registers instead of through an implicit pointer. The optimization remains target-dependent. Explicit object parameters also let a base member deduce the derived object directly, replacing some CRTP patterns from Chapter 4.

**Pitfall.** An explicit-object member has no implicit `this`; access every member through `self`. Such a function cannot be `virtual`.

## Modules

Modules **(C++20)** replace textual inclusion with compiled, named interfaces. They address three costs from Chapter 19: reparsing the same header in every translation unit, ODR fragility from differing token environments, and macro leakage across boundaries.

`export` controls source visibility to importers. It does not create a new binary ABI guarantee, hide object layout, or make an exported definition immune to ordinary compatibility concerns. Modules change how declarations reach a translation unit, not what those declarations mean.

A module interface unit declares the module and exports its public surface:

```cpp
// pricing.cppm
module;
#include <compare>
#include <cstdint>

export module pricing;

export struct Price {
    std::int64_t ticks;
    auto operator<=>(const Price&) const = default;
};

export Price midpoint(Price bid, Price ask);
```

An implementation unit belongs to the same named module without exporting its definitions:

```cpp
// pricing.cpp
module pricing;

Price midpoint(Price bid, Price ask) {
    return Price{(bid.ticks + ask.ticks) / 2};
}
```

A consumer imports declarations, not source text:

```cpp
// main.cpp
import pricing;
#include <iostream>

int main() {
    Price mid = midpoint(Price{100}, Price{102});
    std::cout << mid.ticks << '\n';  // prints: 101
}
```

Build commands remain compiler-specific; the build tool must scan imports before compiling dependents:

```sh
c++ -std=c++23 -fmodules-ts pricing.cppm pricing.cpp main.cpp -o pricing_app
```

Flags and separate compilation steps differ across GCC, Clang, and MSVC. A module partition such as `pricing:core` divides a large module internally; implementation units and non-exported partitions remain invisible to importers.

**Note.** Compiler support is solid, while build-system integration is newer. CMake's `FILE_SET CXX_MODULES`, dependency scanning, and C++23 `import std;` support remain uneven across toolchains, so most codebases mix headers and modules during adoption.

Macros do not cross an import boundary. Migration code that expects a header-defined configuration macro to appear after `import` breaks. Mixing `#include` and `import` forms of the same component in one translation unit can also create transition-period redeclaration and configuration hazards.

## Contracts **(C++26)**

Contracts are a **(C++26)** preview, not a facility to deploy with today's shipping compilers. They attach declarative preconditions, postconditions, and assertions to code:

```cpp
// C++26 preview: syntax and support remain experimental
double mid_price(double bid, double ask)
    pre (bid > 0.0)
    pre (ask >= bid)
    post (result: result >= bid && result <= ask)
{
    double mid = (bid + ask) / 2.0;
    contract_assert(mid > 0.0);
    return mid;
}

// Enforce mode terminates on mid_price(-1.0, 2.0).
```

A contract can be evaluated under a selected semantic: ignore it, observe a violation through the violation handler and continue where permitted, or enforce it by terminating. A quick-enforce variant terminates without invoking the handler. Contract predicates must have no side effects because evaluation policy can change whether they run.

| Mechanism | When checked | False condition | Optimizer may exploit |
|---|---|---|---:|
| `assert(expr)` | Runtime in enabled builds | Diagnostic then abort | Limited |
| `[[assume(expr)]]` | Not checked | Undefined behavior | Yes |
| `pre`, `post`, `contract_assert` | Selected contract mode | Ignore, observe, or enforce | Mode-dependent |

`assert` is a macro controlled by `NDEBUG`. `[[assume(expr)]]` **(C++23)** is an optimizer promise, not a check; reaching it when `expr` is false causes UB. Contracts are declarative and tool-visible.

**Note.** Contracts are standardized for C++26, but shipping compiler support is partial and experimental. Read the syntax in proposals and job-posting code; do not base a current production interface on it.

## Static reflection **(C++26)** and the bridge to Part V

Static reflection is a **(C++26)** preview and is not yet available in shipping compilers. The reflection operator `^^T` produces a compile-time reflection value such as `std::meta::info`. A splice expression `[:reflection:]` turns a reflected entity back into code.

The intended shape is direct compile-time inspection:

```cpp
// C++26 preview: illustrative current reflection syntax
struct OrderMsg {
    std::uint64_t id;
    std::int32_t quantity;
};

consteval auto order_field_names() {
    constexpr auto members =
        std::meta::nonstatic_data_members_of(
            ^^OrderMsg, std::meta::access_context::current());
    std::array<std::string_view, members.size()> names{};
    for (std::size_t i = 0; i < members.size(); ++i) {
        names[i] = std::meta::identifier_of(members[i]);
    }
    return names;
}
```

Reflection can serialize wire-format structures from Chapter 16 without parallel macro lists or external code generators. It can also generate enum-to-string tables from the enum itself, removing a hand-maintained source of drift. Detailed syntax remains inappropriate for production guidance until compiler implementations settle.

The single-threaded language and library toolkit is now complete. Part V places multiple threads under it, beginning with threads and synchronization in Chapter 23, then making visibility precise in Chapter 25 and applying it to lock-free structures in Chapter 26.

## Latency Lens

- `constexpr` tables ship precomputed in read-only data; runtime lookup pays no startup-generation work.
- `constinit` eliminates dynamic initialization of static state, removing initialization-order hazards and first-use guard work.
- Defaulted `<=>` emits memberwise lexicographic comparison with early exit on the first differing member.
- A by-value structured binding copies the whole hidden object; `const auto&` preserves large records in place.
- Range-based `for` evaluates the range and obtains its endpoints once, rather than rediscovering them per iteration.
- A by-value explicit object parameter can keep a small type in registers instead of accessing it through an implicit pointer.
- Required constant evaluation rejects executed UB paths at build time with no runtime checking cost.
- Modules reduce build latency by compiling interfaces instead of repeatedly parsing textual headers; they do not change runtime cost.
- Enforced contracts add boundary checks and branches, while ignored contracts remove those checks under the selected build policy.
