# 3. Expressions and Functions

Expressions are where C++ combines types, values, side effects, and sequencing rules. Functions add another compile-time decision layer through lookup, conversions, and overload resolution, then become register transfers and branches at the machine boundary. Precise reasoning at both levels prevents correctness bugs that optimization otherwise makes difficult to reproduce.

## Expressions and operators

Every expression has a type and a **value category**. The type determines which operations are permitted; the value category describes whether the result identifies an object and whether that result can be treated as expiring.

Operators consume **operands**, the expressions on which they act. Built-in operators implement language-defined behavior, while many operators on class and enumeration types can call overloaded functions; Chapter 4 shows how those overloads are defined.

Precedence decides how an unparenthesized expression groups. A flag test contains one of the expensive-to-debug traps:

```cpp
#include <cstdint>
#include <iostream>

int main() {
    constexpr std::uint32_t snapshot = 0b0001u;
    std::uint32_t flags = 0;

    bool wrong = flags & snapshot == 0;  // warning: == binds first
    bool right = (flags & snapshot) == 0;

    std::cout << std::boolalpha << wrong << ' ' << right << '\n';
    // prints: false true
}
```

Equality binds more tightly than bitwise AND, so the first expression means `flags & (snapshot == 0)`. The comparison produces `false`, which converts to zero, and `flags & 0` is always zero.

**Pitfall.** Protocol flags commonly arrive as integer bitmasks. Always parenthesize the mask operation: `(flags & snapshot) == 0`.

Three other forms deserve recognition:

| Source | Actual grouping | Safer spelling |
|---|---|---|
| `*pointer++` | `*(pointer++)` | `*(pointer++)` |
| `1 << level + 1` | `1 << (level + 1)` | `1 << (level + 1)` |
| `price + spread << scale` | `(price + spread) << scale` | `(price + spread) << scale` |

Do not memorize the entire precedence table. Parenthesize an expression whenever its grouping required thought.

Compound assignment combines an operation and assignment: `quantity += fill` is equivalent in effect to `quantity = quantity + fill`, except that `quantity` is evaluated only once. This matters when the left operand contains a function call or index calculation.

The comma operator evaluates its left operand, discards that result, then evaluates its right operand. It is rare outside the iteration expression of a `for` loop; commas separating function arguments are not comma operators.

The conditional operator `condition ? first : second` selects one operand and produces one result. Its type depends on both alternatives:

```cpp
bool use_model = true;
int ticks = 101;
double model_price = 101.25;
auto price = use_model ? ticks : model_price;

static_assert(std::is_same_v<decltype(price), double>);
```

Here `ticks` converts to `double`, following the usual arithmetic conversions from Chapter 2.

## Value categories

A value category answers two working questions:

1. Does the expression have identity—does it designate a particular object or function?
2. Can its result be treated as a value whose resources may be taken?

An **lvalue** has identity and is not itself marked as expiring. A **prvalue** has no identity in this working model; it computes a value used to initialize an object or feed another expression. An **xvalue** has identity and is marked as expiring.

Two umbrella categories complete the taxonomy:

- A **glvalue** is an lvalue or xvalue: it has identity.
- An **rvalue** is a prvalue or xvalue: it can participate in operations that consume an expiring value.

| Category | Identity? | Expiring? | Canonical examples | Reference binding |
|---|---:|---:|---|---|
| lvalue | Yes | No | named variable `x`; string literal `"X"`; function returning `T&` | `T&`, `const T&` |
| prvalue | No | Yes | `x + y`; `42`; function returning `T`; `Order{p, q}` | `const T&`, `T&&` |
| xvalue | Yes | Yes | `std::move(x)`; member of an expiring object | `const T&`, `T&&` |
| glvalue | Yes | Maybe | all lvalues and xvalues | depends on subtype |
| rvalue | Maybe | Yes | all prvalues and xvalues | `const T&`, `T&&` |

`T&&` is an rvalue reference, a reference that can bind to rvalues. Chapter 7 gives xvalues and rvalue references their practical meaning through move semantics; for now, classify them without assuming what a move does.

A named variable is an lvalue even if its type is an rvalue reference. A string literal is also an lvalue because it designates an array with static storage:

```cpp
int value = 10;
int& alias = value;                   // value is an lvalue
const int& temporary = value + 1;     // value + 1 is a prvalue
const char (&symbol)[4] = "IBM";       // "IBM" is an lvalue array

int make_value();
int& find_value();

const int& a = make_value();           // returned int is a prvalue
int& b = find_value();                 // returned int& expression is an lvalue
```

Reference binding exposes the distinction immediately:

```cpp
void reference_binding_demo() {
    int quantity = 100;
    int& mutable_view = quantity;
    const int& read_only_view = quantity + 1;

    // int& bad = quantity + 1;  // error: cannot bind to a temporary

    mutable_view += 25;
    std::cout << quantity << ' ' << read_only_view << '\n';
    // prints: 125 101
}
```

An assignment target must be a modifiable lvalue. `quantity = 7` is valid; `(quantity + 1) = 7` is not, because the addition produces a prvalue.

**Interview.** A value-category question often presents expressions rather than declarations. Classify the expression `x`, not the type of `x`, then state identity, whether it is expiring, and which reference types can bind.

## Sequencing and evaluation order

**Sequenced before** is a within-thread ordering relation between evaluations. If evaluation `A` is sequenced before evaluation `B`, every value computation and side effect in `A` completes before `B` begins.

Two evaluations are **indeterminately sequenced** when one completes before the other but the language does not choose which one. They are **unsequenced** when their operations may overlap. Unsequenced modifications of the same scalar object, or an unsequenced modification and value computation of that object, cause undefined behavior.

C++17 strengthened several sequencing rules:

| Expression shape | C++17 guarantee | Still unspecified |
|---|---|---|
| `object.member` or `pointer->member` | object/pointer expression first | subexpressions inside it |
| `left[index]` | `left` before `index` | order inside either operand |
| `left << right`, `left >> right` | left before right | order inside either operand |
| `left = right` | right before left | order inside either operand |
| `function(args...)` | function expression before every argument; arguments do not interleave | order among arguments |
| `new T(initializer)` | allocation before initializer | initializer's own unspecified order |

Function arguments are indeterminately sequenced relative to each other in C++17 and later. Each argument finishes before another argument starts, but either may run first:

```cpp
int first() {
    std::cout << "first ";
    return 1;
}

int second() {
    std::cout << "second ";
    return 2;
}

void consume(int left, int right) {
    std::cout << left << ' ' << right << '\n';
}

void argument_order_demo() {
    consume(first(), second());
    // may print: first second 1 2
    // may print: second first 1 2
}
```

The parameter values remain attached to their positions: `left` is always `1` and `right` is always `2`. Only the order of the calls is unspecified.

Likewise, `consume(i++, i++)` has an unspecified result in C++17 and later: one increment is sequenced before the other, but the implementation chooses the order. Before C++17, those modifications were unsequenced and the behavior was undefined.

Unspecified argument order must not carry program logic:

```cpp
int sequence = 0;

int next_bid() {
    return ++sequence;
}

int next_ask() {
    return ++sequence;
}

void publish(int bid_sequence, int ask_sequence);

void publish_unspecified_order() {
    publish(next_bid(), next_ask());
    // which argument evaluates to 1 is unspecified
}
```

Compute side effects in separate statements when order matters:

```cpp
void publish_in_order() {
    int bid_sequence = next_bid();
    int ask_sequence = next_ask();
    publish(bid_sequence, ask_sequence);
}
```

Within an arithmetic expression, operands usually have no ordering relation. The two increments in the right operand below remain unsequenced:

```cpp
int i = 0;
// i = i++ + i++;  // UB: two unsequenced modifications of i
```

By contrast, `i = i++ + 1;` is well-defined in C++17 because the complete right operand is sequenced before the left operand of assignment. With `i` initially `0`, it leaves `i` equal to `1`; before C++17, this expression had undefined behavior.

Chained stream insertion is left-to-right because the left operand of `<<` is sequenced before the right. Calls embedded within a single right operand can still contain their own unspecified ordering.

**Rule.** If two operations mutate shared state, put them in separate statements unless an explicit sequencing rule orders them. The `sequenced-before` relation returns as a foundation of the memory model in Chapter 25.

## UB, unspecified, implementation-defined

C++ separates three kinds of non-portable or unconstrained behavior. These terms are not interchangeable.

| Kind | Who chooses? | Must document? | Example |
|---|---|---:|---|
| implementation-defined | the implementation | Yes | signedness of plain `char`; size of `long` |
| unspecified | the implementation per occurrence | No | order of function-argument evaluation |
| undefined behavior | no requirements apply | No | signed integer overflow |

For implementation-defined behavior, the implementation selects a permitted choice and documents it. Code may rely on that choice when the platform contract is explicit.

For unspecified behavior, the standard permits a set of outcomes and the implementation need not announce its choice. Every permitted outcome is valid, so portable code must accept all of them.

For **undefined behavior**, the standard imposes no requirements on the execution. The optimizer may assume undefined behavior never occurs on any path that a valid program takes, then simplify surrounding code from that premise.

Common sources need different first-aid tools:

| Source | Minimal shape | First-aid tool |
|---|---|---|
| signed overflow | `INT_MAX + 1` | UBSan; range checks |
| out-of-bounds access | `int a[4]; a[4]` | ASan; bounds-aware APIs |
| dangling reference | read through reference returned to a local | ASan; lifetime review |
| null dereference | `int* p = nullptr; *p` | ASan/UBSan; null contract |
| uninitialized read | `int x; return x;` | compiler warnings; MemorySanitizer |
| data race | unsynchronized conflicting accesses | ThreadSanitizer; Chapter 25 |
| use after free | `delete p; return *p;` | ASan; Chapters 8 and 17 |
| invalid type aliasing | read `int` storage through `float*` | UBSan where supported; Chapter 16 |
| missing value return | value-returning function reaches `}` | `-Wreturn-type`; UBSan |

A One Definition Rule violation is a nearby but distinct category: many such programs are ill-formed with no diagnostic required, rather than executions with undefined behavior. Chapter 19 makes the distinction precise.

Undefined signed overflow gives the optimizer useful facts:

```cpp
bool wraps(int value) {
    return value + 1 < value;
}
```

For every `int` input on which the addition is defined, `value + 1` is greater than `value`. GCC on x86-64 can therefore emit:

```text
wraps(int):
    xor eax, eax
    ret
```

Calling `wraps(INT_MAX)` does not make it return `true`; the addition overflows, so the call has undefined behavior. The optimizer is not required to preserve hardware wraparound that the language contract forbids.

UBSan instruments selected operations:

```cpp
#include <iostream>
#include <limits>

int main() {
    int largest = std::numeric_limits<int>::max();
    int overflowed = largest + 1;
    std::cout << overflowed << '\n';
}
```

```sh
clang++ -std=c++23 -Wall -Wextra -fsanitize=undefined \
    -O1 -g overflow.cpp -o overflow
./overflow
```

```text
overflow.cpp:6:30: runtime error: signed integer overflow:
2147483647 + 1 cannot be represented in type 'int'
SUMMARY: UndefinedBehaviorSanitizer: undefined-behavior overflow.cpp:6
```

UBSan detects only the cases it instruments and only on executed paths. A clean sanitizer run is evidence, not proof that a program contains no undefined behavior.

**Rule.** Undefined behavior does not mean “the hardware usually does something useful.” It means a compiler update may exploit an assumption that makes the entire surrounding result unrecognizable.

## Declaring, defining, calling functions

A function declaration introduces its name, parameter types, and return type. A definition also supplies its body:

```cpp
double mid(double bid, double ask);  // declaration

double mid(double bid, double ask) { // definition
    return (bid + ask) / 2.0;
}

auto spread(double bid, double ask) -> double {
    return ask - bid;
}
```

The trailing-return spelling `auto spread(...) -> double` means the same as placing `double` first. A declaration is enough to compile a call; the linker must later find exactly the required definition, as the Chapter 1 linker example showed. Chapter 19 provides the complete build model.

A **parameter** is a local name in the function declaration or definition. An **argument** is the expression supplied by a particular call.

```cpp
#include <cstdint>
#include <iostream>

struct Order {
    std::int64_t id;
    double price;
};

double read_price(Order order) {
    return order.price;
}

double observe_price(const Order& order) {
    return order.price;
}

void reprice(Order& order, double price) {
    order.price = price;
}

int main() {
    Order order{42, 101.25};
    std::cout << read_price(order) << '\n';     // prints: 101.25
    std::cout << observe_price(order) << '\n';  // prints: 101.25
    reprice(order, 101.5);
    std::cout << order.price << '\n';           // prints: 101.5
}
```

`read_price` receives a copy. `observe_price` aliases the existing object without permitting modification, and `reprice` aliases it with permission to modify.

Use these defaults until a measured interface or ownership requirement says otherwise:

| Argument kind | Pass as | Why |
|---|---|---|
| `int`, `double`, pointer, small enumeration | `T` | copying is no more expensive than indirect access |
| small trivial record, up to roughly two registers | `T` | ABI can keep fields in registers |
| larger or unknown read-only object | `const T&` | avoids copying the object |
| caller-owned object to modify | `T&` | mutation is explicit at the declaration |

The size threshold is ABI-specific and not a substitute for measurement. Section 12 shows the SysV x86-64 case.

Return by value by default. Modern C++ can construct many returned class values directly in their destination through copy elision; Chapter 7 explains the mechanics. Never return a reference or pointer to a local object, whose lifetime ends when the function returns.

## Namespaces and name lookup

A namespace partitions names without creating an object or runtime layer. The scope-resolution operator `::` qualifies a name:

```cpp
#include <iostream>

int timeout = 1;

namespace market::feed {
int timeout = 2;

void print_timeout() {
    int timeout = 3;
    std::cout << timeout << ' '
              << market::feed::timeout << ' '
              << ::timeout << '\n';
    // prints: 3 2 1
}
}

int main() {
    market::feed::print_timeout();
}
```

Unqualified lookup starts in the innermost scope and works outward. It stops at the first scope containing the requested name, so the local `timeout` hides rather than combines with outer declarations.

A **using-declaration** imports one chosen name:

```cpp
void announce_connection() {
    using std::cout;
    cout << "connected\n";
}
```

A using-directive such as `using namespace std;` exposes every matching name for lookup. Never put one in a header, because every source file including that header inherits its collisions. This book uses explicit `std::` qualification even in source files.

The spelling `namespace market::feed {}` defines nested namespaces. An `inline namespace` supports library versioning while exposing its members through the enclosing namespace. An unnamed namespace gives names internal linkage within one source file; Chapter 19 defines linkage and its use.

## Overloading and overload resolution

Function overloading gives one name to functions with different parameter-type lists. Return type alone cannot distinguish overloads:

```cpp
int decode(const char* text);
// double decode(const char* text);  // error: differs only in return type
```

For each call, the compiler follows this sequence:

1. Name lookup collects candidate declarations, including candidates found by argument-dependent lookup.
2. The viability filter removes candidates with the wrong arity or arguments that cannot convert to their parameters.
3. Conversion sequences are ranked for every argument.
4. One viable function wins only if it is no worse for every argument and better for at least one.
5. If no unique best function exists, the call is ambiguous and compilation fails.

The main conversion ranks are:

| Rank | Included conversions | Example |
|---|---|---|
| exact match | same type; reference binding; qualification adjustment | `int` to `int`; `int*` to `const int*` |
| promotion | small integer to `int`; `float` to `double` | `short` to `int` |
| conversion | other numeric conversion; derived pointer to base pointer | `int` to `double` |
| user-defined conversion | converting constructor or conversion function | class conversion, Chapter 4 |
| ellipsis | match through `...` | C variadic fallback |

Promotion here is exactly the integer and floating-point promotion from Chapter 2. A lower-ranked conversion loses to a higher-ranked one; the compiler does not choose based on the destination's apparent “closeness” or width.

```cpp
#include <iostream>

void pick(int) {
    std::cout << "int\n";
}

void pick(long) {
    std::cout << "long\n";
}

void pick(double) {
    std::cout << "double\n";
}

int main() {
    short small = 7;
    pick(small);  // prints: int; promotion beats conversions
    pick(42);     // prints: int; exact match
    pick(4.2f);   // prints: double; floating-point promotion

    unsigned quantity = 42;
    (void)quantity;
    // pick(quantity);  // error: all candidates require conversion rank
}
```

Adding a reference overload can also produce an ambiguity:

```cpp
void exact(int);
void exact(const int&);

void exact_match_demo() {
    // exact(42);  // error: both candidates are exact matches
}
```

Qualification distinguishes mutable and read-only lvalues:

```cpp
void inspect(int&) {
    std::cout << "mutable\n";
}

void inspect(const int&) {
    std::cout << "const\n";
}

void reference_overload_demo() {
    int live = 1;
    const int fixed = 2;

    inspect(live);   // prints: mutable
    inspect(fixed);  // prints: const
    inspect(3);      // prints: const
}
```

For `live`, binding to `int&` avoids the added `const` qualification and wins. A temporary cannot bind to `int&`, leaving only `const int&` viable.

**Pitfall.** `route(0)` selects an integer overload while `route(nullptr)` selects a compatible pointer overload, as Chapter 2 showed. Overloads split across signed and unsigned integers also make ordinary literals and converted quantities prone to ambiguity.

Overload resolution is compile-time work. The selected function and required conversions are fixed before execution.

## Argument-dependent lookup

Ordinary unqualified lookup is not the whole candidate search. **Argument-dependent lookup** (ADL) also searches namespaces and classes associated with the argument types.

This is why an output function declared beside a user-defined type can be found by `std::cout << order`. The expression is operator notation for an unqualified call whose arguments associate both `std` and the type's namespace.

```cpp
#include <iostream>

namespace trading {
class Order {
public:
    Order(int id, double price) : id_(id), price_(price) {}

    friend std::ostream& operator<<(std::ostream& output,
                                    const Order& order) {
        return output << order.id_ << '@' << order.price_;
    }

private:
    int id_;
    double price_;
};
}

int main() {
    trading::Order order{42, 101.25};
    std::cout << order << '\n';  // prints: 42@101.25
}
```

The operator is a **hidden friend**: its definition appears inside `Order`, but ordinary namespace lookup does not see it. ADL finds it when an argument is an `Order`. Friendship and operator definitions are formalized in Chapter 4.

Hidden friends keep unrelated calls from considering the overload, reducing both accidental matches and compile-time candidate work.

ADL also supports customized swapping:

```cpp
#include <utility>

namespace trading {
struct Quote {
    int bid;
    int ask;
};

void swap(Quote& left, Quote& right) {
    std::swap(left.bid, right.bid);
    std::swap(left.ask, right.ask);
}
}

void exchange_quotes(trading::Quote& left, trading::Quote& right) {
    using std::swap;
    swap(left, right);
}
```

The using-declaration supplies `std::swap` as a fallback. The unqualified call lets ADL find `trading::swap`, which is a better match for `trading::Quote`. Calling `std::swap(left, right)` directly would suppress ADL customization.

ADL searches associated namespaces, not every namespace:

```cpp
namespace diagnostics {
void helper(const trading::Order&);
}

void report(const trading::Order& order) {
    diagnostics::helper(order);  // qualified call succeeds
    // helper(order);  // error: diagnostics is not associated with Order
}
```

**Pitfall.** Arguments from several namespaces can pull unexpected overloads into one candidate set. Keep general free-function names specific, and qualify calls when customization is not intended.

## Defaults, deduced returns, attributes

A default argument supplies an expression when a call omits that argument. The expression is evaluated at each call, not when the function is declared:

```cpp
#include <iostream>

int sequence = 0;

int next_sequence() {
    return ++sequence;
}

void report(int value = next_sequence()) {
    std::cout << value << '\n';
}

int main() {
    report();  // prints: 1
    report();  // prints: 2
}
```

Declarations in the same scope can add defaults to parameters that do not yet have them, but accumulating defaults across declarations is difficult to audit. Put each default once in the public header declaration.

A costly default is still costly at every call:

```cpp
std::string load_primary_symbol();
void publish(std::string symbol = load_primary_symbol());

void publish_default_symbol() {
    publish();  // calls load_primary_symbol() and constructs a string here
}
```

**Pitfall.** Virtual dispatch chooses an override at runtime, but a default argument is chosen from the static type at the call site. The two choices can disagree; Chapter 4 shows the failure mode with virtual functions.

An `auto` function return type is deduced from its non-discarded `return` expressions:

```cpp
auto clamp_to_zero(int value) {
    if (value < 0) {
        return 0;
    }
    return value;
}

// auto inconsistent(bool use_integer) {
//     if (use_integer) {
//         return 1;
//     }
//     return 1.0;  // error: return expressions deduce different types
// }
```

Every deduced return must agree exactly; the compiler does not find a common arithmetic type. A recursive call is valid only after an earlier return establishes the deduced type.

Return-type deduction is convenient for short local utilities and unavoidable for some generated callable types. Spell the return type at API boundaries when it communicates range, precision, or ownership.

Standard attributes attach portable metadata to declarations or statements:

| Attribute | Version | Purpose |
|---|---|---|
| `[[nodiscard]]` | **(C++17)** | warn when an important result is discarded |
| `[[maybe_unused]]` | **(C++17)** | suppress an intentional unused warning |
| `[[deprecated("use send_v2")]]` | **(C++14)** | warn on a superseded interface |
| `[[likely]]`, `[[unlikely]]` | **(C++20)** | indicate an expected control-flow path |

`[[nodiscard]]` belongs on results whose omission is likely a bug. Chapter 6 applies it to error values that callers must inspect.

```cpp
[[nodiscard]] bool send_order() {
    return false;
}

void submit() {
    send_order();  // warning: ignoring return value of nodiscard function
}
```

```text
warning: ignoring return value of function declared with
'nodiscard' attribute [-Wunused-result]
```

`[[likely]]` and `[[unlikely]]` can influence block layout and fall-through choices. They do not make a condition more probable, and an incorrect hint can make generated code worse. Measure before adding them; branch-prediction mechanics are covered in *Computer Architecture and Performance Engineering*.

## Function pointers, member pointers, std::invoke

A function name decays to a function pointer in most expressions, following the decay rule from Chapter 2:

```cpp
double mid(double bid, double ask) {
    return (bid + ask) / 2.0;
}

double (*mid_pointer)(double, double) = mid;
using PriceFunction = double (*)(double, double);
PriceFunction same_pointer = mid;

double price = mid_pointer(100.0, 102.0);  // result: 101.0
```

The alias removes punctuation from declarations that store or pass the pointer.

A pointer to a data member identifies a member within objects of a class, not a standalone address. A pointer to a member function also needs an object at the call:

```cpp
struct Order {
    double price;
    int quantity;

    double notional() const {
        return price * quantity;
    }
};

double Order::*price_member = &Order::price;
double (Order::*notional_member)() const = &Order::notional;

Order order{101.5, 200};
Order* order_pointer = &order;

double price = order.*price_member;
double value = (order_pointer->*notional_member)();
```

The parentheses around `order_pointer->*notional_member` are required because member-pointer operators have lower precedence than a function call.

`std::invoke` **(C++17)** provides one syntax for free functions, function pointers, member pointers, and function objects such as lambdas:

```cpp
#include <functional>
#include <iostream>

double mid(double bid, double ask) {
    return (bid + ask) / 2.0;
}

struct Order {
    double price;
    int quantity;

    double notional() const {
        return price * quantity;
    }
};

int main() {
    Order order{101.5, 200};
    double (*function_pointer)(double, double) = mid;
    double Order::*data_pointer = &Order::price;
    double (Order::*member_pointer)() const = &Order::notional;
    auto twice = [](double value) { return value * 2.0; };

    std::cout << function_pointer(100.0, 102.0) << ' '
              << order.*data_pointer << ' '
              << (order.*member_pointer)() << ' '
              << twice(order.price) << '\n';
    // prints: 101 101.5 20300 203

    std::cout << std::invoke(function_pointer, 100.0, 102.0) << ' '
              << std::invoke(data_pointer, order) << ' '
              << std::invoke(member_pointer, order) << ' '
              << std::invoke(twice, order.price) << '\n';
    // prints: 101 101.5 20300 203
}
```

| Callable shape | Declaration | Direct call | `std::invoke` |
|---|---|---|---|
| function pointer | `double (*fp)(double, double)` | `fp(a, b)` | `std::invoke(fp, a, b)` |
| data-member pointer | `double Order::*pm` | `order.*pm` | `std::invoke(pm, order)` |
| member-function pointer | `double (Order::*pmf)() const` | `(order.*pmf)()` | `std::invoke(pmf, order)` |
| lambda | `auto fn = [](double x) { return x; };` | `fn(x)` | `std::invoke(fn, x)` |

Member pointers are uncommon in application logic but useful inside serializers, binding libraries, and generic adapters. `std::function`, an owning callable wrapper with a uniform call interface, appears in Chapters 9 and 21.

**Pitfall.** `order.*member_pointer()` tries to call the pointer before applying it to `order` and does not compile. Write `(order.*member_pointer)()`.

## C variadics

A C variadic function uses `...` to accept arguments whose types are absent from its function type. `std::printf(const char*, ...)` relies on its format string to tell the callee what those erased types were.

Variadic arguments undergo default argument promotions: `float` becomes `double`, and `bool`, `char`, and small integer types become `int` or `unsigned int`. The callee must then retrieve exactly the promoted type promised by the format.

```cpp
#include <cstdio>
#include <print>

void bad_format() {
    std::printf("%d\n", 3.14);  // UB: %d expects int, argument is double
}

int main() {
    std::println("price: {:.2f}", 3.14);  // C++23; prints: price: 3.14
}
```

With a literal format string, `-Wall -Wextra` can diagnose the mismatch:

```text
warning: format specifies type 'int' but the argument has type
'double' [-Wformat]
```

A format assembled at runtime defeats this compile-time check. A mismatch then remains undefined behavior even when it appears to print a plausible value.

Variadic templates retain every argument type and are resolved at compile time (Chapter 20). Type-safe formatting through `std::println` **(C++23)** checks a literal format string against those types. Use C variadics only when a legacy C interface requires them; do not design new variadic APIs.

## Calling conventions and parameter passing

A calling convention is the platform contract that maps source-level calls to registers, stack locations, return values, and preservation rules. On the System V x86-64 ABI used by most 64-bit Unix-like systems, the first six integer or pointer argument slots use `rdi`, `rsi`, `rdx`, `rcx`, `r8`, and `r9`. Floating-point arguments use up to `xmm0` through `xmm7`.

Additional arguments use stack locations chosen by the ABI. Integer-like return values normally use `rax`, while floating-point returns use `xmm0`.

```text
higher addresses
+---------------------------+
| stack-passed arguments    |  placed by caller when needed
+---------------------------+
| return address            |  written by call
+---------------------------+
| saved registers           |  present only when needed
+---------------------------+
| local values and spills   |  present only when needed
+---------------------------+  <- stack pointer in the callee
lower addresses
```

The compiler can omit unused frame components. If it inlines a function, the call instruction and the entire call boundary disappear.

Small trivial records are eligible for register passing, but exact classification depends on their fields. Two `double` members form a clear SysV x86-64 case:

```cpp
struct Order {
    double price;
    double quantity;
};

double sum(Order order) {
    return order.price + order.quantity;
}

double sum_by_reference(const Order& order) {
    return order.price + order.quantity;
}
```

At `-O2`, an x86-64 compiler can emit these shapes:

```text
sum(Order):
    addsd xmm0, xmm1       # both fields arrived in registers
    ret

sum_by_reference(Order const&):
    movsd xmm0, [rdi]      # load through the reference
    addsd xmm0, [rdi + 8]
    ret
```

The by-value `Order` needs no copy loop and no memory access in the callee. The reference version passes an address in `rdi`, then loads both fields from memory.

Under this ABI, records up to 16 bytes can often travel in registers when their fields satisfy the ABI classification rules and the type has no user-defined copy machinery. A type with a `std::string` member has non-trivial copy and destruction behavior, so a by-value parameter is passed through an invisible pointer and copied according to the language rules.

**Rule.** Pass small, trivially copyable values—up to about 16 bytes on SysV x86-64—by value. Pass large or non-trivial read-only objects by `const T&`. Chapter 7 refines the rule for functions that retain their arguments, and Chapter 16 makes triviality precise.

**Note.** Windows x64 generally provides four register argument slots and classifies aggregates differently. AArch64 also favors register arguments but uses its own rules. Inspect the target ABI and optimized code before turning a platform observation into an interface rule.

## Latency Lens

- A non-inlined call sets up argument registers, executes `call`, and performs any required frame bookkeeping; inlining removes that boundary.
- A two-field trivial `Order` can ride in `xmm` registers on SysV x86-64, while `const Order&` adds address passing and dependent loads.
- A non-trivial member such as `std::string` can force a by-value aggregate through an invisible pointer and invoke copy machinery.
- Undefined-behavior assumptions let optimizers delete overflow and null-check paths; the same contract accelerates correct code and invalidates buggy code.
- Unspecified argument order lets the compiler schedule independent argument evaluations without preserving source-order side effects.
- Overload resolution and ADL happen entirely at compile time; runtime cost comes from the selected conversion and function, not the candidate count.
- Hidden friends reduce irrelevant overload candidates, improving build latency without changing runtime dispatch.
- `[[likely]]` and `[[unlikely]]` can alter block layout and fall-through; wrong hints can worsen instruction-fetch behavior, so profile first.
- A default argument is evaluated at every call, making construction or lookup costs invisible at the call site.
- C variadics promote and erase argument types, making mismatches undefined; type-safe formatting checks the type pairing before its runtime formatting work.
