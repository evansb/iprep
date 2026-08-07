# Chapter 8 — Templates and Compile-Time Programming

Templates let C++ move type checks, interface selection, calculation, and specialization into compilation. That can remove runtime branches and expose optimization opportunities, but it does not make work disappear: compilation consumes time and memory, generated specializations consume executable space, and a large instruction footprint can raise runtime latency. This chapter develops the template model from declaration and deduction through C++20 constraints and C++23 constant-evaluation tools, then connects source organization to linker behavior and instruction-cache cost.

## 8.1 Function, Class, Variable, and Alias Templates

A **template** describes a family of declarations parameterized by types or values. A specialization is formed when particular arguments are supplied or deduced. The compiler then checks and generates what the program actually uses.

A function template expresses one algorithm for many types:

```cpp
template<class Price>
constexpr Price midpoint(Price bid, Price ask) noexcept {
    return bid + (ask - bid) / Price{2};
}

static_assert(midpoint(100, 104) == 102);
```

`midpoint<int>` and `midpoint<long>` are distinct specializations. They may generate different instructions because their types have different sizes or operators. A call does not carry a runtime “template” object; the selection occurs during compilation.

A class template describes a family of types:

```cpp
#include <array>
#include <cstddef>

template<class T, std::size_t Capacity>
class FixedBuffer {
public:
    bool push(const T& value) {
        if (size_ == Capacity) return false;
        data_[size_++] = value;
        return true;
    }

private:
    std::array<T, Capacity> data_{};
    std::size_t size_{};
};
```

Capacity is part of the type. `FixedBuffer<int, 64>` embeds space for 64 integers and needs no allocation for the shown operation. `FixedBuffer<int, 128>` is an unrelated type with a different size. Compile-time capacity provides a hard memory bound but makes differently sized buffers inconvenient to store uniformly.

A variable template defines a family of variables or constants. C++17 inline variables make header-defined variable templates easier to use without creating multiple definitions:

```cpp
#include <cstddef>

template<class T>
inline constexpr bool fits_cache_word = sizeof(T) <= sizeof(std::size_t);
```

An alias template names a family of types without creating a new type:

```cpp
#include <cstdint>
#include <vector>

template<class T>
using Sequence = std::vector<T>;

using OrderIds = Sequence<std::uint64_t>;
```

The alias does not wrap `std::vector`; `OrderIds` has exactly that vector type and behavior, including allocation and invalidation. If a domain invariant is required, use a class rather than a synonym.

Template syntax exposes no runtime-cost guarantee. `FixedBuffer` has bounded inline storage because of its definition, while `Sequence` can allocate because it aliases a dynamic container. Analyze the resulting specialization exactly as ordinary code: ownership, object size, calls, branches, exceptions, and memory access still matter.

## 8.2 Type, Non-Type, and Template-Template Parameters

Template parameters can represent types, compile-time values, or templates. Each kind moves a different design choice into a specialization.

A **type parameter** stands for a type:

```cpp
template<class Price, class Quantity>
struct Trade {
    Price price;
    Quantity quantity;
};
```

A **non-type template parameter** represents a constant value whose type is permitted by the language. Integers and enumerations are common; modern C++ also permits pointers, floating-point values in supported standards, and certain structural class types.

```cpp
#include <array>
#include <cstddef>

template<std::size_t Depth>
struct BookSide {
    std::array<long, Depth> prices{};
    std::array<unsigned, Depth> quantities{};
};
```

`Depth` can control storage and unrolling. It also multiplies the number of types: components expecting depth 10 cannot directly accept depth 20. A runtime capacity keeps one type and smaller binary surface; a compile-time capacity can embed storage and let the compiler remove bounds known from context.

C++20 supports placeholder syntax for non-type parameters:

```cpp
template<auto Value>
struct Constant {
    static constexpr auto value = Value;
};
```

The value's type is deduced. This is convenient but can accidentally create more specializations than intended when `1`, `1u`, and `1L` appear at different call sites.

A **template-template parameter** accepts a template:

```cpp
#include <deque>

template<class T, template<class, class> class Container>
class QueueAdapter {
    Container<T, std::allocator<T>> values_;
};

using DequeQueue = QueueAdapter<int, std::deque>;
```

Real standard-library templates have allocator and default-parameter details that can make such interfaces brittle. Passing a concrete policy type or accepting a range is often easier to constrain and diagnose.

Parameters are compile-time inputs, not automatically free optimizations. A Boolean template parameter can remove a runtime branch:

```cpp
template<bool Validate>
void decode(const char* data) {
    if constexpr (Validate) {
        // validation code exists only in this specialization
    }
    // decode fields
}
```

But building both `decode<true>` and `decode<false>` duplicates the shared body unless inlining and linker merging recover it. Use template parameters for choices that materially affect representation or optimization, not for every configuration knob.

## 8.3 Specialization and Explicit Instantiation

A **specialization** supplies behavior for particular template arguments. Function templates can be fully specialized, while class and variable templates can be fully or partially specialized. Ordinary overloads are usually preferable for function-specific behavior because they participate naturally in overload resolution.

```cpp
#include <cstdint>
#include <type_traits>

template<class T>
struct WireWidth;

template<>
struct WireWidth<std::uint32_t>
    : std::integral_constant<std::size_t, 4> {};

template<>
struct WireWidth<std::uint64_t>
    : std::integral_constant<std::size_t, 8> {};
```

This primary template has no definition, so unsupported types fail to instantiate. A concept or a clear `static_assert` can give a better diagnostic.

Partial specialization matches a family:

```cpp
template<class T>
struct IsPointerLike : std::false_type {};

template<class T>
struct IsPointerLike<T*> : std::true_type {};
```

Specialization selection is a compile-time rule, not a runtime branch. However, specializations can drift semantically. If a fast path handles `std::uint64_t` but omits validation performed by the primary template, the optimization has changed correctness.

An **explicit instantiation definition** requests generation of one specialization in a chosen translation unit. An `extern template` declaration tells other translation units not to instantiate it there:

```cpp
// decoder.hpp
template<class Message>
void decode(Message&, const char*, std::size_t);

struct AddOrder;
extern template void decode<AddOrder>(AddOrder&, const char*, std::size_t);
```

```cpp
// decoder.cpp
#include "decoder.hpp"

template<class Message>
void decode(Message& out, const char* data, std::size_t size) {
    // definition
}

template void decode<AddOrder>(AddOrder&, const char*, std::size_t);
```

In practice the template definition is often placed in a detail header included by the instantiation file, while public users see the declaration and `extern template`. This can reduce repeated compiler work and stabilize where code is emitted. It restricts usable specializations to those whose definitions remain visible or are explicitly provided.

Explicit instantiation is an engineering tool, not a semantic optimization. It may reduce object-file duplication before linking, but the final linker could already discard equivalent copies. Measure clean build time, peak compiler memory, object sizes, and final binary size separately.

## 8.4 Two-Phase Lookup and Dependent Names

Template names are resolved in two broad stages. Nondependent names are looked up when the template is defined; dependent names are resolved using information available when a specialization is instantiated. This **two-phase lookup** prevents later declarations from silently changing ordinary names inside a template.

```cpp
void audit(int);

template<class T>
void process(T value) {
    audit(0);       // nondependent: ordinary lookup occurs here
    value.commit(); // dependent: validity awaits instantiation
}
```

A name that depends on a template parameter may need syntax telling the parser whether it denotes a type or a template:

```cpp
template<class Feed>
void consume(Feed& feed) {
    typename Feed::message_type message{};
    feed.template decode<Feed::wire_version>(message);
}
```

`typename` says that `Feed::message_type` is a type. The `template` disambiguator says that `decode` names a member template, so `<` begins template arguments rather than a comparison.

Members inherited from a dependent base are not found by ordinary unqualified lookup at template definition time:

```cpp
template<class T>
struct Base {
    void reset();
};

template<class T>
struct Derived : Base<T> {
    void prepare() {
        this->reset(); // dependent lookup; reset() alone may not be found
    }
};
```

These rules explain many diagnostics that look unrelated to performance. They also protect large template systems from order-dependent behavior. Do not “fix” lookup by adding global forwarding functions until the lookup model is understood; that can alter overload resolution and ADL.

Current conforming GCC and Clang implement two-phase lookup, though diagnostics differ. Reduce an error to the first failed specialization and ask: Is the name dependent? When is it looked up? Does it require `typename`, `template`, or `this->`? Compiler backtrace-limit options can keep diagnostics readable, but suppressing context does not repair the contract.

## 8.5 ADL and the One Definition Rule

**Argument-dependent lookup** (ADL) adds functions from namespaces and classes associated with call arguments to the overload set. It enables customization patterns such as unqualified `swap` without requiring a base interface.

```cpp
#include <utility>

namespace feed {
struct State { /* ... */ };

void swap(State& a, State& b) noexcept {
    // swap representation efficiently
}
}

template<class T>
void exchange(T& a, T& b) {
    using std::swap;
    swap(a, b); // std::swap plus ADL candidates
}
```

ADL is based on argument types, not return type. It can find a domain operation declared alongside its type. It can also make overload sets sensitive to namespaces introduced by template arguments, which is why generic unqualified calls require care.

The **One Definition Rule** (ODR) governs how many definitions an entity may have and when multiple translation-unit definitions must be equivalent. Templates and inline entities commonly appear in headers, so equivalent definitions may exist in many translation units. Divergence caused by macros, configuration-dependent declarations, packing pragmas, or inconsistent compiler options can make a program ill-formed with no diagnostic required.

```cpp
// BROKEN when different translation units define FAST_MODE differently
template<class T>
inline int score(T value) {
#ifdef FAST_MODE
    return value.fast_score();
#else
    return value.checked_score();
#endif
}
```

If both variants contribute the “same” specialization, the linker may keep one body arbitrarily from its perspective. This is not runtime feature selection; it is an ODR violation. Put configuration in explicit template arguments, generated configuration headers shared consistently, or runtime state.

C++20 modules can reduce textual inclusion and isolate macros, but they do not repeal the ODR. Module support and build integration vary by compiler version; a project should adopt them based on measured build and dependency benefits, not as an assumed source-compatibility switch.

ODR failures are hard to diagnose because normal linkers coalesce template bodies. Tools include link maps, symbol inspection, ODR-related linker or sanitizer diagnostics where supported, and clean rebuilds with captured command lines. ABI mismatches at shared-library boundaries require equal caution even when mangled names happen to link.

## 8.6 Function- and Class-Template Deduction

Template argument deduction determines parameters from call arguments or, since C++17, class construction expressions. It follows specific type-transformation rules rather than performing arbitrary conversion search.

```cpp
template<class T>
T clamp_low(T value, T low) {
    return value < low ? low : value;
}

auto a = clamp_low(10, 3);       // T is int
// auto b = clamp_low(10L, 3);   // deduction conflict: long versus int
auto c = clamp_low<long>(10L, 3); // explicit T permits conversion of 3
```

During deduction, the compiler generally seeks one consistent `T`; it does not choose a common type for conflicting arguments unless the interface says so. A two-parameter design can use `std::common_type_t`, but that changes return and conversion semantics.

References and cv-qualification affect deduction. A by-value parameter normally drops top-level `const` and references, while a reference parameter preserves more of the argument type. A parameter of form `T&&` is a forwarding reference when `T` is deduced and unqualified. Lvalues then deduce `T` as an lvalue reference; reference collapsing produces an lvalue-reference parameter.

```cpp
#include <utility>

template<class Handler, class Message>
decltype(auto) dispatch(Handler&& handler, Message&& message) {
    return std::forward<Handler>(handler)(
        std::forward<Message>(message));
}
```

Forwarding preserves value categories, but it also makes this function instantiate for combinations of cv-qualification and reference category. That can enlarge compile work and diagnostics. Use forwarding only when the callee needs those distinctions.

Class template argument deduction (CTAD) deduces class arguments from constructors or deduction guides:

```cpp
#include <array>
#include <utility>

std::pair pair{42u, 12'500L}; // std::pair<unsigned, long>
std::array values{1, 2, 3};   // std::array<int, 3>
```

CTAD saves spelling, but an inferred type can become part of persistent object layout or ABI accidentally. For public members, wire representations, and long-lived state, explicit types often communicate intent better. Use `static_assert(std::same_as<...>)` in tests when deduction itself is an important contract.

Deduction occurs before many ordinary implicit conversions. This is why an array passed to a reference parameter can retain its bound while the same array passed by value becomes a pointer, and why two numerically convertible arguments can still conflict. When an API wants conversion to one canonical domain type, name that type in a non-deduced position or provide a non-template overload. When it wants to preserve exact representation, let deduction expose mismatches instead of forcing a common type.

## 8.7 Deduction Guides, `auto`, and `decltype`

A **deduction guide** maps constructor-like arguments to class template arguments. The compiler synthesizes some guides from constructors; a user-defined guide handles relationships constructors do not express directly.

```cpp
#include <cstddef>
#include <span>

template<class T>
class BufferView {
public:
    BufferView(T* data, std::size_t size) : data_{data}, size_{size} {}
private:
    T* data_;
    std::size_t size_;
};

template<class T>
BufferView(T*, std::size_t) -> BufferView<T>;

int values[8]{};
BufferView view{values, 8}; // BufferView<int>
```

`auto` deduces a variable type using rules similar to template by-value deduction. It drops top-level references unless `auto&` or `auto&&` is written. Braced initialization has special rules, especially with `std::initializer_list`, so use it deliberately.

```cpp
const int quantity = 10;
auto copy = quantity;       // int
const auto& reference = quantity; // const int&
auto&& forwarding = copy;   // int& after collapsing
```

`decltype(expression)` reports a type using two rule sets. An unparenthesized id-expression gives the declared type. Otherwise, the expression's value category determines whether the result is `T`, `T&`, or `T&&`.

```cpp
int quantity = 10;
decltype(quantity) a = 0;    // int
decltype((quantity)) b = a;  // int&
```

That extra pair of parentheses changes the type. `decltype(auto)` applies the same rules to placeholder deduction, so a return statement can accidentally return a reference:

```cpp
// BROKEN: returns a reference to a local variable
decltype(auto) bad_quantity() {
    int q = 10;
    return (q);
}
```

Use `auto` to avoid repeating an obvious or unnameable type, not to hide ownership. A local `auto messages = get_messages();` should make it clear from the API whether the result owns storage or is a view. The compiler prevents type mismatch; it does not prevent a dangling view whose type was inferred correctly.

## 8.8 Decay and `remove_cvref`

**Decay** is the family of transformations traditionally applied when values are passed by value: arrays become pointers, functions become function pointers, and top-level references and cv-qualifiers are removed. `std::decay_t<T>` models these combined transformations. `std::remove_cvref_t<T>`—added in C++20—removes references and top-level cv-qualification but preserves arrays and function types.

```cpp
#include <type_traits>

using Array = int[16];

static_assert(std::is_same_v<std::decay_t<Array>, int*>);
static_assert(std::is_same_v<std::remove_cvref_t<Array>, int[16]>);
```

The distinction matters in generic code that needs array extent:

```cpp
#include <cstddef>
#include <type_traits>

template<class T>
constexpr std::size_t array_bytes(T&& value) {
    using U = std::remove_reference_t<T>;
    static_assert(std::is_array_v<U>);
    return sizeof(value);
}

int packet[32];
static_assert(array_bytes(packet) == sizeof(packet));
```

If the function had first decayed `T`, it would retain only a pointer and lose the bound. A pointer does not own or describe an array. This is a common source of unchecked packet parsing.

`remove_cvref_t` is often the right tool for asking about an underlying object type while preserving representation categories. `decay_t` is appropriate when intentionally storing a by-value callable or argument in a form similar to ordinary parameter passing. A callable wrapper may decay a function to a pointer and copy an array argument's pointer, creating lifetime implications.

Type transformations have no inherent runtime instructions. Their consequences do: choosing a pointer representation can lose bounds, choosing a value can copy payload, and choosing a reference can dangle. State the desired ownership and lifetime before selecting a trait.

Function types demonstrate the same difference:

```cpp
using Callback = void(const char*, std::size_t);

static_assert(std::is_same_v<std::decay_t<Callback>,
                             void (*)(const char*, std::size_t)>);
static_assert(std::is_same_v<std::remove_cvref_t<Callback>, Callback>);
```

A decayed callback stores an ordinary function pointer and therefore dispatches indirectly when the target is not known. Preserving the function type can let a reference bind directly, but the reference still does not own executable code or extend any captured state. Capturing lambdas are class types and follow different storage rules. Generic wrappers should name the exact callable model they intend rather than applying decay mechanically.

## 8.9 Requires-Clauses and Requires-Expressions

C++20 constraints let a template state which arguments are valid. A **requires-clause** attaches a Boolean constraint to a declaration. A **requires-expression** checks whether types and expressions satisfy specified requirements without evaluating those expressions.

```cpp
#include <concepts>
#include <cstddef>

template<class Decoder>
requires requires(Decoder& decoder, const std::byte* data, std::size_t size) {
    { decoder.decode(data, size) } noexcept -> std::same_as<bool>;
}
bool decode_one(Decoder& decoder, const std::byte* data, std::size_t size) noexcept {
    return decoder.decode(data, size);
}
```

The requires-expression checks syntax, result constraint, and `noexcept`. It does not call `decode`. Invalid candidates are removed according to constraint rules rather than failing deep in the function body.

Requirements can be simple, type, compound, or nested:

```cpp
template<class T>
concept WireMessage = requires(T message) {
    typename T::sequence_type;                    // type requirement
    message.sequence();                           // simple requirement
    { message.size() } noexcept -> std::same_as<std::size_t>; // compound
    requires std::is_trivially_copyable_v<T>;     // nested requirement
};
```

Syntactic validity is not a full semantic contract. `WireMessage` cannot prove that `size()` matches encoded bytes or that copying a received representation is portable. Concepts document and check interfaces; tests and invariants establish behavior.

Constraints normally add no runtime state or branch because selection happens during compilation. They can reduce time wasted compiling invalid bodies and improve errors, though complex constraint normalization and large overload sets can themselves cost compiler time. Prefer named concepts for important domain contracts and small local requires-expressions for one-off adaptation.

A useful constraint should fail at the interface. Compare a body-only assumption:

```cpp
template<class T>
void unchecked_send(T& transport) {
    transport.send_bytes(); // error may appear deep in an instantiation trace
}
```

with a named contract:

```cpp
template<class T>
concept ByteTransport = requires(T& transport) {
    { transport.send_bytes() } noexcept -> std::same_as<void>;
};

template<ByteTransport T>
void checked_send(T& transport) noexcept {
    transport.send_bytes();
}
```

The second form also makes the non-throwing expectation visible to overload resolution and documentation. It still says nothing about blocking. A socket transport could meet the concept and block indefinitely. C++ has no standard concept for “bounded latency”; express such operational properties through design, mode configuration, and measurement.

## 8.10 Concepts, Subsumption, Constrained `auto`, and Overload Ordering

A **concept** is a named compile-time predicate used to constrain templates. Standard concepts such as `std::integral`, `std::ranges::contiguous_range`, and `std::invocable` express common structural requirements.

```cpp
#include <concepts>

template<std::integral T>
constexpr T checked_add(T a, T b); // declaration for example

void consume(std::integral auto sequence) {
    // abbreviated function template
}
```

The `auto` parameter is constrained; `consume` is still a function template and can instantiate separately for each accepted type.

When several constrained overloads are viable, **subsumption** helps determine which is more constrained. The relationship is based on normalized constraint structure, not on the compiler proving arbitrary logical implication.

```cpp
template<class T>
concept HasSequence = requires(const T& value) {
    { value.sequence() } -> std::integral;
};

template<class T>
concept RecoverableMessage = HasSequence<T> && requires(const T& value) {
    { value.recovery_channel() } -> std::integral;
};

template<HasSequence T>
void route(const T&);              // general

template<RecoverableMessage T>
void route(const T&);              // selected for recoverable messages
```

Defining `RecoverableMessage` in terms of the named `HasSequence` concept gives the compiler a clear subsumption relationship. Repeating textually similar requires-expressions in both concepts may not establish the relationship expected by a human.

Constraints are part of an overload interface. Adding an overload or strengthening a concept can change which function existing source selects. It can also change mangling or binary compatibility depending on the ABI and declaration changes. Treat concept refactors like overload-set changes and test representative calls.

At runtime, both `route` specializations are ordinary functions. The specialized overload may enable a direct recovery operation, but the concept itself supplies no speed. Inspect which specialization was chosen through compile-time tests, compiler diagnostics, or deliberately constrained unit cases; inspect runtime code separately.

## 8.11 Type Traits and the Detection Idiom

A **type trait** maps types to compile-time values or types. The standard library provides queries such as `std::is_trivially_copyable_v<T>` and transformations such as `std::remove_reference_t<T>`.

```cpp
#include <bit>
#include <type_traits>

template<class Wire, class Host>
requires (sizeof(Wire) == sizeof(Host) &&
          std::is_trivially_copyable_v<Wire> &&
          std::is_trivially_copyable_v<Host>)
Host representation_copy(const Wire& wire) noexcept {
    return std::bit_cast<Host>(wire);
}
```

The trait gates what `bit_cast` requires; it does not prove that the wire and host formats mean the same thing. Endianness, padding, and valid value representations still matter.

Before C++20 concepts, generic libraries often used the **detection idiom** with `std::void_t` and partial specialization:

```cpp
#include <type_traits>

template<class, class = void>
struct has_reserve : std::false_type {};

template<class T>
struct has_reserve<T, std::void_t<
    decltype(std::declval<T&>().reserve(std::size_t{}))
>> : std::true_type {};

template<class T>
inline constexpr bool has_reserve_v = has_reserve<T>::value;
```

Substitution failure removes the partial specialization when the expression is invalid. This technique remains relevant in C++17 code and in some trait definitions, but a requires-expression is usually clearer for a C++20-or-later public constraint.

Traits can guide representation and optimization, but dangerous traits deserve special care. `std::is_trivially_copyable_v<T>` permits copying object representation through specified byte operations; it does not make unaligned typed loads legal, give objects a stable network format, or authorize aliasing violations. `std::is_nothrow_move_constructible_v<T>` reports the declared operation and can guide a container, but a false `noexcept` promise terminates if an exception escapes.

Compile-time branching over traits can generate multiple bodies. Group traits into concepts or policies that reflect domain intent rather than accumulating dozens of nearly equivalent Boolean combinations.

## 8.12 `if constexpr`, Folds, Packs, and Variadics

C++17 `if constexpr` discards the nonselected statement during specialization when its condition is not value-dependent at that point. Code in a discarded branch need not be valid for the current template arguments, subject to the language's parsing and dependency rules.

```cpp
#include <string_view>
#include <type_traits>

template<class T>
std::string_view kind() {
    if constexpr (std::is_integral_v<T>) {
        return "integer";
    } else {
        return T::kind_name(); // required only for non-integral T
    }
}
```

This is compile-time selection, not a runtime conditional. Separate specializations can still contain different code and contribute to binary growth.

A template parameter pack represents zero or more arguments. A **fold expression** combines a pack with an operator:

```cpp
template<class... Checks>
bool all_allow(Checks&... checks) {
    return (checks.allow() && ...);
}
```

The `&&` fold preserves short-circuit evaluation from left to right for this form: later checks are not called after failure. Other operators have their own sequencing rules. A `+` fold does not magically make floating-point reassociation or evaluation harmless, and a long fold can create a dependency chain.

Packs support compile-time iteration over heterogeneous fields:

```cpp
#include <tuple>
#include <utility>

template<class Tuple, class F, std::size_t... I>
void for_each_field(Tuple&& tuple, F&& f, std::index_sequence<I...>) {
    (f(std::get<I>(std::forward<Tuple>(tuple))), ...);
}
```

The comma fold sequences calls left to right. It may inline a separate operation for every field. That is effective for a small fixed protocol header; a message with hundreds of fields can produce a huge function and slow compilation. A compact runtime loop over homogeneous descriptors may be better for cold or variable schemas.

Variadic templates are type-safe compared with C varargs, but they do not inherently bound work. A logging call templated on arbitrary arguments can instantiate formatting machinery at many call sites and allocate at runtime depending on the destination. Separate the compile-time expressiveness from the runtime implementation.

## 8.13 `constexpr`, Relaxed `constexpr`, and Variable Templates

`constexpr` permits an entity to participate in constant evaluation. A `constexpr` function can also execute at runtime when its inputs or context are not constant. The keyword is an availability promise, not a requirement that every call be precomputed.

```cpp
#include <cstdint>

constexpr std::uint32_t fnv1a(const char* text) noexcept {
    std::uint32_t hash = 2'166'136'261u;
    while (*text != '\0') { // loops became broadly usable in constexpr in C++14
        hash ^= static_cast<unsigned char>(*text++);
        hash *= 16'777'619u;
    }
    return hash;
}

inline constexpr auto add_order_tag = fnv1a("AddOrder");
static_assert(add_order_tag != 0);
```

C++14 relaxed `constexpr` function-body restrictions, allowing local variables and loops. Later standards expanded constant evaluation to more library facilities and forms of allocation whose storage does not escape evaluation. Compiler and library support determines which standard-library operations are usable in a given build.

An `inline constexpr` variable in a header has one logical entity across translation units under the ODR, avoiding a separate source definition. It can hold a scalar, array, or structural table:

```cpp
#include <array>

inline constexpr std::array<unsigned char, 4> field_widths{8, 8, 4, 1};
```

Constant evaluation can remove startup initialization and runtime calculation. It can also enlarge object files or read-only data if large tables are embedded repeatedly before linker merging, and it consumes compiler time and memory. A 1 MiB precomputed table may trade arithmetic for instruction/data-cache and binary-page pressure.

Constant evaluation also has failure modes worth separating. Exceeding an implementation's constexpr step or recursion limit is a compile failure, not a slow runtime path. A calculation that accidentally ceases to be required at compile time may quietly become runtime initialization if the declaration permits it. `static_assert`, `consteval`, or a `constexpr` variable forces the issue where the value truly must be available during translation.

Static initialization does not imply that the table's physical pages are resident when the process starts processing traffic. The operating system can map read-only binary pages lazily. A first access may fault even though C++ performed no runtime initialization. Section 13.4 covers demand paging; the important distinction here is compile-time value production versus runtime memory residency.

Use `constinit` when static storage must be initialized statically but need not be immutable. Unlike `constexpr`, it does not make later modification illegal. This can prevent a dynamic-initialization guard without forcing constness.

To verify constant evaluation, use `static_assert` for required values and inspect symbols or assembly for unwanted initialization routines. Compare the deployed binary's section sizes; do not assume a source-level `constexpr` table is free to load into memory.

## 8.14 `consteval`, C++23 `if consteval`, and Lookup Tables

A C++20 `consteval` function is an **immediate function**: a potentially evaluated call must produce a constant expression in the required context. Use it when runtime evaluation would violate the interface rather than merely be slower.

```cpp
#include <cstdint>

consteval std::uint16_t message_tag(char a, char b) {
    return (static_cast<std::uint16_t>(static_cast<unsigned char>(a)) << 8) |
           static_cast<unsigned char>(b);
}

inline constexpr auto trade_tag = message_tag('T', 'R');
```

A runtime character pair cannot call `message_tag`. This turns a design rule into a compile-time diagnostic.

C++23 `if consteval` selects a branch according to whether evaluation is manifestly constant-evaluated. It makes dual compile-time/runtime implementations clearer than older probes:

```cpp
constexpr unsigned checksum_byte(unsigned value) {
    if consteval {
        // portable operations suitable for constant evaluation
        return (value * 33u) ^ (value >> 3);
    } else {
        // runtime path could call a target-specific optimized helper
        return (value * 33u) ^ (value >> 3);
    }
}
```

The example intentionally preserves semantics in both branches. A target intrinsic may be legal only at runtime, but the paths must still agree for valid inputs. Test both; compile-time tests exercise only the immediate branch.

A lookup table moves repeated computation into indexed memory access. That helps when the table is small, hot, and replaces a dependency-heavy operation. It hurts when the table is large, accessed randomly, or increases cache and TLB pressure.

```cpp
#include <array>
#include <cstddef>

consteval auto make_digit_table() {
    std::array<unsigned char, 256> table{};
    for (std::size_t i = 0; i < table.size(); ++i) {
        table[i] = (i >= '0' && i <= '9') ? 1 : 0;
    }
    return table;
}

inline constexpr auto is_digit_table = make_digit_table();
```

Index this table with an unsigned byte value; indexing with a negative signed `char` converted to a large size is invalid. Compile-time generation removes hand-maintained data but does not remove the runtime load.

Check C++23 support using `__cpp_if_consteval` and the deployed compiler version. For performance, compare arithmetic and table versions under realistic cache pressure, not in a tiny benchmark where the table is permanently hot.

## 8.15 Compilation Time and Compiler Memory

Template work is performed by the compiler for each required specialization and optimization context. Parsing headers, substituting arguments, evaluating constraints, instantiating bodies, constant-evaluating expressions, and optimizing generated intermediate representations all consume resources.

Several patterns cause disproportionate build cost:

- Broad headers expose large template definitions to many translation units.
- Deep recursive metaprogramming creates long instantiation chains.
- Large overload sets repeatedly normalize and test constraints.
- Variadic Cartesian products generate many visitors or adapters.
- Large `constexpr` calculations make the compiler execute substantial algorithms.
- Aggressive inlining and LTO retain more intermediate representation at once.

Forward declarations, narrower headers, non-template implementation functions, explicit instantiation, precompiled headers, and modules can reduce repeated work. The right boundary often keeps a small templated adapter in the header and moves type-independent work to one ordinary function:

```cpp
// Header: specialize only extraction.
void publish_fields(std::uint64_t id, std::int64_t price, unsigned quantity);

template<class Message>
void publish(const Message& message) {
    publish_fields(message.id(), message.price_ticks(), message.quantity());
}
```

Every message type gets a small adapter; formatting, I/O, or queueing code can remain single-copy in `publish_fields`.

Measure builds rather than reasoning only from source line count. Clang's `-ftime-trace` writes a trace viewable in compatible trace viewers. GCC's `-ftime-report` summarizes compiler phases. Build-system timing identifies high-fan-out translation units, while operating-system tools can record peak resident memory.

Track clean and incremental builds separately. A header change may invalidate hundreds of translation units even when each compiles quickly. The production cost includes developer feedback, CI capacity, and risk from disabling expensive validation to regain speed.

Template diagnostics also affect engineering time. Preserve the first useful error by constraining public entry points, isolating implementation details, and adding compile-only tests for rejected inputs. Avoid global reductions of the template backtrace limit in CI logs when they erase the cause; use them interactively after retaining a full failure artifact.

A practical build budget can be tracked like a runtime budget: wall time for a clean build, a representative incremental edit, peak resident memory per compiler process, total generated object bytes, and link time. A regression in one measure can be intentional, but it should be visible. Header ownership and dependency graphs often reveal larger gains than rewriting a small metaprogram.

## 8.16 Instantiation, Linker Deduplication, and LTO

Template definitions are usually visible at each point of implicit instantiation, so multiple translation units may emit the same specialization. Toolchains commonly place such definitions in coalescible sections—often COMDAT groups or weak ODR sections—and the linker retains one equivalent copy.

```text
orders.o:  decode<AddOrder>  ---\
replay.o:  decode<AddOrder>  ----+--> linker keeps one final body
tests.o:   decode<AddOrder>  ---/
```

This common behavior controls final executable duplication but does not refund parsing, instantiation, optimization, or object-file I/O already paid by each compiler process. It also depends on definitions satisfying the ODR.

Identical code folding may merge machine-code functions that happen to be equivalent, subject to linker options and semantic constraints such as observable function addresses. Do not depend on it as the only size strategy. Small source differences, debug information, visibility, or relocation patterns can prevent merging.

Explicit instantiation, introduced in Section 8.3, concentrates code generation. Another option is to move a type-independent core into a source file. Shared libraries can centralize implementation but introduce ABI, symbol visibility, relocation, and deployment considerations.

**Link-time optimization** (LTO) gives optimization access to intermediate representations across translation units. It can inline, devirtualize, propagate constants, remove unused specializations, and sometimes reduce duplication. It can also increase link time and peak memory, and inlining can grow the final hot code. ThinLTO-style designs distribute parts of the work and cache summaries, with toolchain-specific behavior.

Inspect each stage:

```sh
# Object and final section sizes
size build/orders.o build/replay.o build/trader

# Demangled specialization symbols
nm -C --size-sort build/trader | grep 'decode<'

# Link map when enabled by the build
less build/trader.map
```

Compare non-LTO, LTO, and explicit-instantiation builds using the same optimization, debug, and visibility settings. Record final text size and runtime counters as well as build time. A smaller binary is helpful only if semantics and hot-path performance remain correct.

Shared code can still be duplicated after source-level refactoring when different calling conventions, exception specifications, visibility, or constant arguments produce distinct machine code. Conversely, two differently named specializations may fold to one body. Symbol counts alone are therefore incomplete. Examine symbol sizes, disassembly, and section maps, then use runtime samples to determine which copies are actually hot.

LTO changes the observation boundary. Assembly emitted from compiling one `.cpp` without link-time optimization may contain a call that disappears in the final linked program. When validating final performance claims, inspect the linked executable or an LTO-aware optimization report. Keep a non-LTO build available when fast iteration and debuggability matter more than whole-program optimization.

## 8.17 Code Bloat and Instruction-Cache Consequences

**Code bloat** is executable growth caused by generated or inlined code that adds little corresponding value. Templates are one source, but macros, unrolling, duplicated error paths, and aggressive inlining also contribute.

Specialization can be valuable. A decoder specialized for a fixed wire schema may use constant offsets, eliminate tag switches, and vectorize validation. Bloat begins when large common bodies are repeated for small type differences or when rare paths are inlined into every hot caller.

Instruction bytes occupy cache lines and translation entries just like data uses its hierarchy. A larger hot working set can cause instruction-cache misses, instruction-TLB misses, and front-end stalls. Templates can therefore exchange indirect calls and branches for fetch pressure:

```text
runtime dispatch                 many specializations
+ one compact body               + direct calls and constants
+ stable binary boundary         + inlining opportunities
- indirect target                - repeated instruction bodies
- less cross-call optimization   - larger build and I-cache footprint
```

Useful controls include:

- Factor type-independent work into non-template functions.
- Mark unusually large cold error paths out of line; rely on profiles where appropriate.
- Instantiate only supported type combinations.
- Prefer runtime data for rarely changed knobs that do not affect representation.
- Use explicit instantiation for common public specializations.
- Apply LTO and profile-guided optimization only after measuring their output.

Cold code still contributes to file size and mapped pages, but only code that enters the active instruction working set competes directly for the hottest cache capacity. Separate size attribution from hotness attribution. A large set of rarely invoked administrative specializations may be a deployment concern without explaining front-end stalls in the event loop. Conversely, a modest increase inside an aggressively unrolled hot loop can matter because every iteration fetches it.

Inlining decisions are compiler and profile dependent. `inline` does not command inlining, and preventing all inlining adds call overhead and blocks optimization. Review optimization reports and assembly around critical loops.

Measure executable sections with `size`, symbol contributions with `nm` or tools such as Bloaty when available, and runtime front-end behavior with supported `perf` events. General events include `instructions`, `cycles`, and cache misses; precise instruction-cache and front-end events vary by CPU model. Correlate counters with sampled instruction addresses so cold unused template code is not blamed for a hot miss.

The final design criterion is total system cost. Templates are excellent when they enforce contracts and specialize genuinely different hot behavior. They are wasteful when compile-time variety merely republishes the same large algorithm under many names.

## 8.18 Interview Check

1. Distinguish a template, an implicit specialization, an explicit specialization, and an explicit instantiation. Which of them necessarily changes runtime dispatch?
2. Compare type, non-type, and template-template parameters. When does a compile-time capacity improve predictability, and what interoperability cost does it create?
3. Explain two-phase lookup for a nondependent call, a dependent member call, and a member inherited from a dependent base. When are `typename`, `template`, and `this->` required?
4. How can ADL enable efficient customization? Give an example of an ODR violation involving a header template and explain why linker coalescing does not make it valid.
5. For calls with `int`, `const int`, lvalue, and rvalue arguments, explain how by-value, `T&`, and forwarding-reference parameters deduce `T`.
6. Why do `std::decay_t<int[16]>` and `std::remove_cvref_t<int[16]>` differ, and how can choosing the wrong one lose packet bounds?
7. Compare a requires-expression with the detection idiom. What interface properties can a concept check, and which semantic properties still require tests or invariants?
8. Analyze `(checks.allow() && ...)`: what is the evaluation order, when does it stop, and how can the number of checks affect code size and dependency chains?
9. When does `constexpr` guarantee compile-time evaluation, and when does it merely permit it? Compare it with `consteval` and explain one valid use of C++23 `if consteval`.
10. A header-only decoder is instantiated for 40 message types in 100 translation units. Design a measurement and refactoring plan that addresses compiler memory, clean and incremental build time, object duplication, final text size, and instruction-cache behavior.
