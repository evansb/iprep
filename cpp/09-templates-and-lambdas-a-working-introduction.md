# 9. Templates and Lambdas: A Working Introduction

Templates let one definition produce type-specific code, while lambdas package behavior into small objects. This is the working knowledge needed to use standard containers and algorithms without treating their types as magic. The full instantiation model, specialization, and packs belong to Chapter 20; advanced lambda mechanics belong to Chapter 21.

## Templates are compile-time code generation

A template is a recipe from which the compiler generates a concrete function or class. Each distinct set of template arguments creates a separate **instantiation** at compile time: there is no runtime dispatch and no boxing.

```cpp
#include <iostream>

template<class T>
T max(T a, T b) {
    return a < b ? b : a;
}

int main() {
    std::cout << max(3, 5) << '\n';       // prints: 5; calls max<int>
    std::cout << max(2.5, 7.1) << '\n';   // prints: 7.1; calls max<double>
}
```

`T` is a **template parameter**: a placeholder in the declaration. `int` and `double` are **template arguments**: concrete types supplied at use sites. The distinction mirrors a function parameter and the argument passed to it.

The compiler can treat those calls roughly as if these functions had been written by hand:

```cpp
int max(int a, int b) {
    return a < b ? b : a;
}

double max(double a, double b) {
    return a < b ? b : a;
}
```

Both instantiations have concrete parameter types and can be optimized independently. Unlike commonly used Java generics, C++ templates normally instantiate type-specific native code rather than erasing every argument to one runtime representation. Compiler Explorer (Chapter 1) can show the separate generated functions when optimization does not inline them away.

`class` and `typename` mean the same thing when introducing a type template parameter. This book uses `class`:

```cpp
template<class T>
T midpoint(T low, T high);
```

A template parameter can also have a default argument:

```cpp
template<class T = double>
class Price;
```

The compiler parses a template definition when it sees it, but some operations cannot be validated for a particular type until instantiation. The original `max` requires `a < b`; defining it succeeds even if a later argument type does not support `<`.

**Pitfall.** A template body is not proof that every possible instantiation is valid. Errors involving a particular type often appear only at the first use that asks the compiler to instantiate the template.

## The four template kinds

C++ applies the same parameter syntax to functions, classes, variables, and aliases. Standard-library names such as `std::vector<int>` and `std::unique_ptr<Order>` are class-template instantiations, so their angle brackets are already familiar.

```cpp
// Function template
template<class T>
T square(T value) {
    return value * value;
}

// Class template
template<class T>
class Buffer {
public:
    explicit Buffer(std::size_t count) : data_(count) {}
    T& operator[](std::size_t index) { return data_[index]; }

private:
    std::vector<T> data_;
};

// Variable template
template<class T>
constexpr T zero = T{};

// Alias template
template<class T>
using Vec = std::vector<T>;
```

Each use supplies or deduces arguments according to the kind:

```cpp
int squared = square(7);       // function template; T is deduced as int
Buffer<double> prices{64};     // class template; T is explicitly double
double origin = zero<double>;  // variable template
Vec<int> quantities{1, 2, 3};  // alias for std::vector<int>
```

An alias template creates a family of type aliases. It does not create a new, distinct type: `Vec<int>` is exactly `std::vector<int>`.

## Deduction: how the compiler picks T

For a function template, each function argument can propose a type for a template parameter. The proposals must agree under the deduction rules before normal overload resolution continues (Chapter 3).

```cpp
template<class T>
T max(T a, T b) {
    return a < b ? b : a;
}

double bad = max(1, 2.0);  // error: conflicting deductions: int and double

double good = max<double>(1, 2.0);
//                T fixed explicitly; 1 converts to 1.0
```

Template argument deduction does not perform an `int`-to-`double` conversion to make conflicting proposals agree. Once `T` is fixed explicitly, however, the call has two `double` parameters and ordinary argument conversion applies.

Another design can accept two types:

```cpp
template<class T, class U>
bool less_than(T left, U right) {
    return left < right;
}

bool result = less_than(1, 2.0);  // T is int; U is double
```

That is a different interface, not a way to make the one-parameter `max` infer a compromise type. `auto` deduction from Chapter 2 follows the same broad principle: deduction starts from the initializer's type rather than searching for a type to which every value could convert.

String literals expose a nastier case. A literal used as a by-value argument decays to `const char*`:

```cpp
auto wrong = max("alpha", "beta");  // compares pointers, not text

auto right = ::max(std::string{"alpha"}, std::string{"beta"});
// right == "beta"
```

The first call instantiates `max<const char*>`. Its `<` compares pointer values, not characters; for pointers into unrelated objects, the built-in relational result is unspecified. Constructing `std::string` makes lexical comparison explicit. The leading `::` selects this example's global `max`; argument-dependent lookup would otherwise also find `std::max` through the `std::string` arguments.

**Rule.** Deduction finds types; it does not negotiate conversions between arguments. Supply the template argument or convert the arguments when one type is required.

## CTAD: deducing class template arguments

Class template argument deduction, or **CTAD** **(C++17)**, lets constructor arguments determine class template arguments:

```cpp
std::pair p{1, 2.0};         // std::pair<int, double>
std::vector values{1, 2, 3}; // std::vector<int>

static_assert(std::same_as<decltype(p), std::pair<int, double>>);
static_assert(std::same_as<decltype(values), std::vector<int>>);
```

CTAD removes a repeated type when the constructor arguments make it obvious. It does not change constructor overload resolution, including the special preference given to `std::initializer_list` constructors.

```cpp
std::vector ambiguous{3, 5};  // 2 elements: 3, 5 — not three fives
std::vector<int> filled(3, 5); // 3 elements, all 5
```

Braces select the initializer-list interpretation here. The count-and-value constructor needs parentheses, and spelling `int` makes the intended element type unmistakable.

Use CTAD for local objects whose arguments make the result unsurprising. Spell template arguments in public interfaces and whenever the deduced type or selected constructor would make a reviewer pause.

Deduction belongs to an object definition, not to the object's type once established. After `values` becomes a `std::vector<int>`, later insertions follow the normal `std::vector<int>` interface and cannot rededuce it as a different specialization.

## Reading template errors

A template error often reports the implementation machinery that failed, not merely the bad call. For example, `std::sort` needs random-access iterators, but a `std::list` provides bidirectional iterators:

```cpp
std::list<int> prices{103, 101, 102};
std::sort(prices.begin(), prices.end());  // error: list iterators lack operator-
```

A pre-concepts implementation may produce output shaped like this:

```text
.../bits/stl_algo.h: In instantiation of
    'constexpr void std::__sort(_RandomAccessIterator, ...)':
.../bits/stl_algo.h:1938:50: error: no match for 'operator-'
    __last - __first
    ~~~~~~~^~~~~~~~~
chapter09.cpp:8:14: required from here
    std::sort(prices.begin(), prices.end());
// ... candidate operators elided
```

Triage the diagnostic from the outside of the library machinery:

1. Read the first actual `error:`; later errors are frequently consequences.
2. Scan `required from` and `in instantiation of` lines to reconstruct the call chain.
3. Find the first location in your source file, here `chapter09.cpp:8`.
4. Ignore library-internal candidates until your call and its inferred types make sense.

Here `__last - __first` is the useful clue: subtraction is unavailable for the list's iterator type. Chapter 13 covers the iterator requirements and the appropriate algorithms. Concepts turn many failures of this kind into a direct “constraint not satisfied” diagnosis.

## Concepts: constraints you can read

A **concept** **(C++20)** is a named compile-time predicate on types. A constraint attached to a template rejects unsuitable arguments at the call site and describes the required category.

```cpp
template<std::integral T>
T max(T a, T b) {
    return a < b ? b : a;
}

int high = max(8, 13);        // T is int
auto bad = max("a", "b");      // error: const char* is not integral
```

`std::integral` comes from `<concepts>` and accepts integer-like types, including `bool` and character types. Use standard concepts when they express the contract; their names communicate more than a failure deep inside a function body.

The same constraint can be written in several positions:

| Syntax | Example | Reads as |
|---|---|---|
| Constrained parameter | `template<std::integral T>` | `T` must be integral |
| `requires` clause | `template<class T> requires std::integral<T>` | require integral `T` |
| Abbreviated template | `void send(std::integral auto x)` | `send` accepts an integral value |

A `requires` expression tests whether expressions involving a type are well-formed. This small concept asks whether `std::hash<T>` can be called and whether its result converts to `std::size_t`:

```cpp
template<class T>
concept Hashable = requires(T value) {
    { std::hash<T>{}(value) } -> std::convertible_to<std::size_t>;
};

static_assert(Hashable<int>);
static_assert(Hashable<std::string>);
```

Read the body as: “for a value of type `T`, these expressions must compile with these result requirements.” The expression is checked by the compiler; it is not executed at runtime.

Constraints participate in choosing among overloaded templates, but concept design, subsumption, and deeper `requires` clauses wait until Chapter 20.

**Interview.** A strong explanation distinguishes deduction from constraint checking: first the compiler infers a candidate `T`, then verifies that `T` satisfies the constraint. Concepts improve interfaces and diagnostics; they do not add a runtime test.

## Function objects and lambda anatomy — the flagship

A **function object**, often called a functor, is an object whose class defines `operator()`. More generally, a **callable** is anything that can be invoked: a function, function pointer, function object, or lambda. Standard-library facilities accept callables so callers can supply both behavior and state, building on the invocation rules introduced with `std::invoke` in Chapter 3.

A lambda expression asks the compiler to create a function object. The source-level lambda and the hand-written approximation below have the same useful mental model:

```cpp
struct Order {
    double price;
    int quantity;
};

void inspect_closures() {
    double limit = 100.0;

    auto over = [limit](const Order& order) {
        return order.price > limit;
    };

    struct Over {
        double limit;  // one data member for the capture

        bool operator()(const Order& order) const {
            return order.price > limit;
        }
    };

    Over over_by_hand{limit};
    Order order{101.25, 50};

    std::cout << std::boolalpha
              << over(order) << ' '
              << over_by_hand(order) << '\n';  // prints: true true
    std::cout << sizeof(over) << '\n';          // commonly prints: 8
}
```

The text between `[` and `]` is the **capture list**. The parentheses hold call parameters, and the body becomes the generated object's `operator()`. That operator is `const` by default, which is why the hand-written version marks it `const`.

The generated class is the lambda's **closure type**; the object stored in `over` is a **closure object**. The type is unique and unnamed, so `auto` is the normal way to hold it. Even identical lambda expressions have different closure types:

```cpp
auto first = [](int x) { return x + 1; };
auto second = [](int x) { return x + 1; };

static_assert(!std::same_as<decltype(first), decltype(second)>);
```

Each by-value capture normally corresponds to an unnamed data member. A closure capturing one `double` is therefore commonly the size of one `double`, though exact layout is implementation-defined. An empty closure still has nonzero size, commonly one byte, because every complete object has an addressable identity.

`std::function<bool(const Order&)>` can hold any suitable callable behind one type-erased interface. Its storage and call costs are covered in Chapter 21; when a template can accept the lambda's concrete type directly, no such wrapper is needed.

## Capture modes

A capture list states which local entities become part of the closure and how. A by-value capture takes its value when the closure object is created, not each time it is called. A by-reference capture refers back to the original object, so that object's lifetime must cover every call.

| Form | Meaning | Stored as | Dangling risk |
|---|---|---|---|
| `[]` | capture nothing | nothing | none |
| `[=]` | all odr-used locals by value | copies | low; copied pointers can dangle |
| `[&]` | all odr-used locals by reference | references | high if stored |
| `[x]` | `x` by value | copy | none for `x` itself |
| `[&x]` | `x` by reference | reference | high if stored |
| `[x = expr]` | init-capture (Chapter 21) | computed or moved value | depends on value |

An entity is **odr-used** here when the lambda needs its stored value or identity, rather than merely using a compile-time constant. Default captures include only locals actually needed by the body, not every local in the surrounding block. Globals and static locals are accessed directly and are not captured.

```cpp
void show_snapshot() {
    int level = 1;
    auto snapshot = [level] {
        std::cout << level << '\n';
    };

    level = 2;
    snapshot();  // prints: 1 (captured at creation)
}
```

Changing the outer `level` does not change the closure's copy. In contrast, `[&level]` would observe the current outer value on each call while `level` remained alive.

`[=]` and `[&]` are concise for a lambda created and consumed in one expression. Prefer explicit captures for stored, returned, or queued lambdas: the capture list then exposes the object's state and its lifetime obligations.

## Dangling captures

A reference capture does not extend an object's lifetime. If a closure outlives the captured object, invoking it reads a dangling reference and has undefined behavior.

```cpp
auto make_bad_adder(int n) {
    return [&n](int x) {
        return x + n;
    };
}  // n's lifetime ends

auto add_five = make_bad_adder(5);
int result = add_five(3);  // UB: reads destroyed n
```

The closure remains alive, but its reference points into a dead function invocation. Compiler warnings and AddressSanitizer may detect some versions of this bug; neither is a lifetime guarantee.

Capture the needed value instead:

```cpp
auto make_adder(int n) {
    return [n](int x) {
        return x + n;
    };
}

auto add_five = make_adder(5);
int result = add_five(3);  // result == 8
```

Use these lifetime rules:

- Capture by value when a lambda is returned, stored, or queued to another thread (Chapter 23).
- Capture by reference when the lambda is consumed immediately and the referent clearly outlives the call.
- Treat a copied pointer or view as a lifetime dependency even though the capture itself is by value.
- Recheck captures whenever code changes an immediate lambda into an asynchronous or stored callback.

**Pitfall.** `[=]` does not copy the current object when a member is used; it captures `this` as a pointer. The closure can therefore outlive the object and dangle. Capturing `this` and `*this` receive full treatment in Chapter 21.

## Generic lambdas and passing lambdas to algorithms

A lambda parameter declared with `auto` makes a **generic lambda** **(C++14)**. Its generated `operator()` is a function template: one closure type can be called with multiple argument types, producing a suitable instantiation for each.

```cpp
struct Order {
    double price;
    int quantity;
};

struct Quote {
    double price;
};

auto less_price = [](const auto& left, const auto& right) {
    return left.price < right.price;
};

static_assert(less_price(Order{99.95, 10}, Order{100.10, 20}));
static_assert(less_price(Quote{99.95}, Quote{100.10}));
```

Like the earlier `max` template, the lambda body is valid only for types that support the operations it uses. A call with two `int` arguments fails because `int` has no `.price`.

Algorithms receive the closure object as an ordinary argument. `std::sort` can use it as a comparator:

```cpp
void print_sorted_orders() {
    std::vector<Order> orders{
        {100.25, 10},
        {99.95, 30},
        {100.10, 20}
    };

    std::sort(orders.begin(), orders.end(), less_price);

    std::cout << std::fixed << std::setprecision(2);
    for (const Order& order : orders) {
        std::cout << order.price << ' ';
    }
    std::cout << '\n';  // prints: 99.95 100.10 100.25
}
```

Iterators, comparator requirements, and the algorithm library are formalized in Chapter 13. For now, the performance mechanism matters: `std::sort` is instantiated with the lambda's exact closure type, so the comparator body is visible inside that instantiation and can be inlined. A comparator passed through an opaque function pointer usually requires an indirect call when the optimizer cannot recover its target.

## Latency Lens

- Templates spend compile time to produce type-specific code; an instantiation needs no boxing, type erasure, or virtual dispatch at runtime.
- A lambda passed directly to `std::sort` has a distinct concrete type, exposing its comparator body for inlining into the algorithm instantiation.
- A function pointer can turn the same comparator into an opaque indirect call when the optimizer cannot prove its target.
- Creating a by-value closure copies its captured members, typically through register moves for a few small scalars.
- Closure size follows captured state; a broad `[=]` that odr-uses a large object can copy that object into the closure.
- A reference or pointer capture keeps the closure small but transfers the referent's lifetime obligation to the caller.
- `std::function` type-erases a callable and may allocate for its closure; passing a raw lambda to a template avoids that layer.
- Concepts are compile-time checks: they improve rejection and diagnostics without adding runtime branches or changing generated code.
- Repeated template instantiations can increase compile time and binary size, but hot paths execute only the concrete generated functions; Chapter 20 covers controlling that bloat.
