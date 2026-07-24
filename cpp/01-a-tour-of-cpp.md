# 1. A Tour of C++

C++ turns source code into native machine code while keeping costs visible in the source. This chapter gets a complete toolchain working, introduces the syntax needed to read small programs, and shows how to investigate failures instead of guessing at them.

## Hello, toolchain

A C++ implementation consists of a compiler, a standard library, and supporting tools such as a linker. The compiler accepts source files such as `hello.cpp` and produces a native executable ahead of time: there is no language-level interpreter or virtual machine between the executable and the processor.

```cpp
#include <print>

int main() {
    std::println("hello, hft");
    return 0;
}
```

The `#include <print>` line makes the standard library's printing declarations available. Program execution starts in `main`, whose `int` result reports success or failure to the environment. A result of `0` means success; reaching the end of `main` also returns `0`, a special rule that applies only to `main`.

Save the program as `hello.cpp`, then use either Clang or GCC:

```sh
clang++ -std=c++23 -Wall -Wextra -O2 hello.cpp -o hello
g++     -std=c++23 -Wall -Wextra -O2 hello.cpp -o hello
./hello
# prints: hello, hft
```

The commands name the source, choose an output file with `-o hello`, and apply three groups of options:

- `-std=c++23` selects the C++23 language and library baseline used by this book.
- `-Wall -Wextra` enables useful compiler warnings; leave both enabled.
- `-O2` enables optimization suitable for a release build.

Use `-O0 -g` instead while stepping through code in a debugger. Debug and instrumented builds appear later in this chapter.

**Note.** `std::println` is a C++23 facility, but some otherwise capable standard-library installations still lack `<print>`. Replace the include with `<iostream>` and the call with `std::cout << "hello, hft\n";` until the library is upgraded.

## Values and variables

Every C++ expression has a static type determined at compile time. In `int quantity = 42;`, the name `quantity` denotes an `int` for its entire lifetime; unlike a Python name, it cannot later become a string.

The fundamental types cover common scalar values. The standard library also provides fixed-width integer aliases such as `std::int64_t` in `<cstdint>`.

```cpp
#include <cstdint>
#include <iostream>

int main() {
    int quantity = 200;
    double price = 101.25;
    bool is_buy = true;
    char venue = 'X';
    std::int64_t sequence = 9'000'000'000;
    const int lot_size = 100;

    std::cout << quantity << ' ' << price << ' ' << std::boolalpha
              << is_buy << ' ' << venue << ' ' << sequence << ' '
              << lot_size << '\n';
    std::cout << sizeof(int) << ' ' << sizeof(double) << '\n';
    // prints: 200 101.25 true X 9000000000 100
    // typically prints on x86-64 Linux: 4 8
}
```

Digit separators such as the apostrophes in `9'000'000'000` improve readability without changing the value. `sizeof` reports a type's size in bytes; the exact sizes of several fundamental types depend on the implementation.

Variables hold values by default. Initializing one variable from another copies the value, so later changes are independent:

```cpp
int original = 42;
int copy = original;
copy = 7;

std::cout << original << ' ' << copy << '\n';  // prints: 42 7
```

This differs from the default object-binding model in Java and Python, where two names often refer to the same object. C++ can express aliases explicitly, but ordinary value variables do not alias each other.

`const` promises that a name will not be used to modify its value:

```cpp
const double tick_size = 0.01;
// tick_size = 0.05;  // error: cannot assign to a const variable
```

**Pitfall.** An uninitialized local `int` has an indeterminate value. Reading it can cause undefined behavior, meaning the C++ standard places no requirements on the program's result; Chapter 3 defines that term precisely. Initialize every variable.

Chapter 2 develops fundamental types, fixed-width integers, `const`, references, and conversions.

## Functions

A function declaration puts the return type before the function name. Function parameters receive copies by default, so assigning to a by-value parameter does not change the caller's variable.

An ampersand in a parameter type creates a reference: another name for the caller's object. Assigning through a non-`const` reference changes that object.

```cpp
#include <iostream>

double mid(double bid, double ask) {
    return (bid + ask) / 2.0;
}

void set_to_zero(double price) {
    price = 0.0;
    std::cout << price << '\n';  // prints: 0
}

void apply_fee(double& price) {
    price += 0.01;
}

int main() {
    double bid = 101.0;
    double ask = 101.5;
    double price = mid(bid, ask);

    set_to_zero(price);
    std::cout << price << '\n';  // prints: 101.25

    apply_fee(price);
    std::cout << price << '\n';  // prints: 101.26
}
```

`mid` receives two `double` values and returns a `double`. `set_to_zero` changes only its local copy, while `apply_fee` receives `price` by reference and changes the caller's variable.

C++ also allows several functions to share a name when their parameter types differ:

```cpp
int twice(int value) {
    return value * 2;
}

double twice(double value) {
    return value * 2.0;
}
```

This is function overloading. Chapter 3 explains functions, argument passing, references, and how the compiler chooses among overloads.

## A first class

A class defines a new type by grouping data with the operations that preserve its meaning. Labels `private:` and `public:` control which names client code can access.

```cpp
#include <iostream>

class Order {
public:
    Order(double price, int quantity)
        : price_(price), quantity_(quantity) {}

    double notional() const {
        return price_ * quantity_;
    }

private:
    double price_;
    int quantity_;
};

int main() {
    Order order{101.5, 200};
    std::cout << order.notional() << '\n';  // prints: 20300
}
```

`Order`'s constructor initializes a new object. The colon introduces a member initializer list, which initializes `price_` and `quantity_` before the constructor body runs. The trailing `const` on `notional` says that calling the function does not modify the `Order`.

`Order order{101.5, 200};` creates a value with automatic storage, normally in the function's stack frame. It needs no `new` and no garbage collector. The object is destroyed deterministically when execution leaves its scope.

Chapter 4 develops classes, constructors, access control, and invariants; Chapter 5 explains object lifetime and deterministic destruction.

## Vector, string, range-for

`std::vector<int>` is a growable array of `int`. It offers indexed access, appends with `push_back`, and reports its element count with `size`.

`std::string` is value-typed text. It supports concatenation with `+`, indexing, and `size` without requiring a separate string runtime.

```cpp
#include <iostream>
#include <string>
#include <vector>

class Order {
public:
    Order(double price, int quantity)
        : price_(price), quantity_(quantity) {}

    double price() const {
        return price_;
    }

    int quantity() const {
        return quantity_;
    }

private:
    double price_;
    int quantity_;
};

int main() {
    std::vector<Order> orders;
    orders.push_back(Order{101.5, 200});
    orders.push_back(Order{99.5, 50});

    for (const Order& order : orders) {
        std::cout << order.price() << " x " << order.quantity() << '\n';
    }

    std::vector<std::string> symbols{"AAPL", "MSFT"};
    std::string route = symbols[0] + "->" + symbols[1];
    std::cout << symbols.size() << ' ' << route << '\n';
    // prints: 101.5 x 200
    // prints: 99.5 x 50
    // prints: 2 AAPL->MSFT
}
```

The range-based `for` visits each element of `orders`. The type `const Order&` lets the loop inspect the element without copying it or permitting modification.

**Pitfall.** `orders[i]` does not check whether `i` is in range. An out-of-bounds access causes undefined behavior rather than throwing an exception.

Chapter 9 introduces the angle-bracket syntax and lambdas; Chapter 10 covers `std::vector`, its checked operations, and its storage behavior.

## A first lambda

A lambda is an unnamed function defined inline. It is useful when an algorithm needs a small, local operation such as an ordering rule.

```cpp
#include <algorithm>
#include <iomanip>
#include <iostream>
#include <vector>

class Order {
public:
    Order(double price) : price(price) {}

    double price;
};

int main() {
    std::vector<Order> orders{Order{101.5}, Order{102.0}, Order{99.5}};

    std::sort(orders.begin(), orders.end(),
              [](const Order& a, const Order& b) {
                  return a.price < b.price;
              });

    std::cout << std::fixed << std::setprecision(1);
    for (const Order& order : orders) {
        std::cout << order.price << ' ';
    }
    std::cout << '\n';  // prints: 99.5 101.5 102.0
}
```

`std::sort` from `<algorithm>` rearranges the vector. Its third argument is the comparator lambda, which returns `true` when `a` should appear before `b`. The empty `[]` is the lambda's capture list; it needs no outside state here.

`orders.begin()` and `orders.end()` delimit the elements to sort. `std::fixed` with `std::setprecision(1)` prints one digit after the decimal point.

Chapter 9 explains lambda syntax and captures.

## Headers, source files, compile-then-link

Larger programs separate declarations from definitions. A header presents the names shared by several source files, while source files contain the corresponding function definitions.

`order.hpp` declares the `Order` class:

```cpp
#pragma once

class Order {
public:
    Order(double price, int quantity);
    double notional() const;

private:
    double price_;
    int quantity_;
};
```

`#pragma once` asks the compiler to include this header at most once while processing a source file. An `#include` is conceptually a textual paste of the named header at that location.

`order.cpp` supplies the definitions:

```cpp
#include "order.hpp"

Order::Order(double price, int quantity)
    : price_(price), quantity_(quantity) {}

double Order::notional() const {
    return price_ * quantity_;
}
```

The `Order::` prefix qualifies each definition as a member of `Order`.

`main.cpp` uses the declarations from the header:

```cpp
#include "order.hpp"

#include <iostream>

int main() {
    Order order{101.5, 200};
    std::cout << order.notional() << '\n';  // prints: 20300
}
```

Building this program has three conceptual stages:

1. Preprocessing handles directives such as `#include`.
2. Compilation translates each processed source file into an object file.
3. Linking combines object files and libraries into one executable.

The commands expose the compilation and linking stages:

```sh
clang++ -std=c++23 -Wall -Wextra -c order.cpp
clang++ -std=c++23 -Wall -Wextra -c main.cpp
clang++ order.o main.o -o app
./app
# prints: 20300
```

GCC accepts the same commands with `g++` in place of `clang++`. The `-c` option stops after producing `order.o` or `main.o`.

If the link command omits `order.o`, `main.o` still contains calls for which no definitions are present:

```sh
clang++ main.o -o app
```

```text
main.cpp:(.text+0x20): undefined reference to `Order::Order(double, int)'
main.cpp:(.text+0x2c): undefined reference to `Order::notional() const'
clang++: error: linker command failed with exit code 1
```

This abbreviated GNU/Linux output is a linker error, not a C++ syntax error. The source compiled successfully, but the linker could not find the machine-code definitions named by `main.o`.

Chapter 19 develops headers, source files, object files, and the complete build and linkage model.

## Reading compiler errors

Compiler output can be long because one invalid operation fails inside several layers of library code. Start with the first error, fix it, and compile again; later messages are often consequences of the first failure.

This program asks `std::sort` to order `Order` objects but supplies neither a comparator nor an `operator<`:

```cpp
#include <algorithm>
#include <vector>

class Order {
public:
    double price;
};

int main() {
    std::vector<Order> orders{{101.5}, {99.5}};
    std::sort(orders.begin(), orders.end());  // error: Order has no ordering
}
```

An abbreviated Clang diagnostic using libstdc++ looks like this:

```text
.../stl_function.h:408:20: error: invalid operands to binary
expression ('const Order' and 'const Order')
  408 |       { return __x < __y; }
      |                ~~~ ^ ~~~
.../stl_algo.h:...: note: in instantiation of function template
'std::sort<...>' requested here
main.cpp:11:10: note: in instantiation of function template
'std::sort<...>' requested here
```

GCC may instead lead with `error: no match for 'operator<'`. The wording and the order of supporting notes vary, but the underlying complaint is the same: sorting needs a way to compare two `Order` values.

Use this triage sequence:

1. Read the first `error:` and temporarily ignore later errors.
2. Find the first referenced line in your own source file; skip library-header frames on the first pass.
3. Extract the short complaint, such as `invalid operands`, `no match for operator<`, or `no matching function`.
4. Ignore long candidate lists until the short complaint is insufficient.
5. Fix one cause and recompile to remove cascade noise.

**Note.** Clang often produces shorter diagnostics than GCC for the same source. Trying both compilers can reveal a clearer explanation.

## Warnings, sanitizers, debug builds

Warnings catch suspicious but syntactically valid code. Keep `-Wall -Wextra` enabled locally, and let continuous integration add `-Werror` so new warnings fail the build.

```cpp
int suspicious_condition() {
    int x = 0;
    if (x = 1) {  // warning: assignment used as a condition
        return x;
    }
    return 0;
}
```

The compiler accepts the assignment, but `-Wall` warns because `==` was probably intended. Do not silence a warning until its cause is understood.

Optimization and debug information are independent choices. `-O0 -g` preserves a straightforward debugging experience, `-O2 -g` produces optimized code with symbols useful for profiling, and `-O2` or `-O3` is typical for release binaries after measurement.

Sanitizers insert runtime checks during compilation. AddressSanitizer detects many invalid memory accesses, while UndefinedBehaviorSanitizer detects selected operations whose behavior the language does not define.

```cpp
#include <vector>

int main() {
    std::vector<int> values{1, 2, 3};
    int* first = values.data();
    return first[3];  // out of bounds: one past the final element
}
```

`values.data()` returns the address of the first element, stored here in an `int*`. Index `3` names the position just beyond a three-element vector.

Compile and run an instrumented build:

```sh
clang++ -std=c++23 -Wall -Wextra \
    -fsanitize=address,undefined -g -O1 bounds.cpp -o bounds
./bounds
```

A trimmed report identifies both the operation and its source location:

```text
ERROR: AddressSanitizer: heap-buffer-overflow on address 0x...
READ of size 4 at 0x... thread T0
    #0 0x... in main bounds.cpp:6
0x... is located 0 bytes after 12-byte region [0x...,0x...)
SUMMARY: AddressSanitizer: heap-buffer-overflow bounds.cpp:6 in main
```

Read `READ of size 4` as the failed operation, then follow the first stack frame in your code: `bounds.cpp:6`. The report turns a silent invalid read into an immediate, located failure.

| Flags | Use when | Catches or provides |
|---|---|---|
| `-O0 -g` | Stepping in a debugger | Source-level debug information |
| `-O2 -Wall -Wextra` | Release | Suspicious source patterns |
| `-fsanitize=address,undefined -g` | All testing | Memory errors; selected undefined behavior |
| `-O2 -g` | Profiling | Optimized code with symbols |

**Rule.** Run tests under AddressSanitizer and UndefinedBehaviorSanitizer. These builds are for testing, not production, because their checks add substantial runtime and memory overhead.

Chapter 3 defines undefined behavior and its common sources precisely.

## Compiler Explorer

[Compiler Explorer](https://godbolt.org/) compiles a small source fragment in the browser and shows the generated assembly live. Paste a function, select a compiler and target, enter flags such as `-std=c++23 -O2`, and use the colored source-to-assembly mapping to connect each source line to its instructions.

```cpp
int square(int x) {
    return x * x;
}
```

For an x86-64 target, GCC at `-O2` can emit:

```text
square(int):
    imul edi, edi    # multiply x by itself
    mov  eax, edi    # place the result in the return register
    ret              # return
```

Exact registers and instruction selection depend on the compiler and target. At `-O0`, the same function usually contains extra loads, stores, and stack-frame setup; the reader need not decode them yet. The contrast shows that the optimizer removes source-level machinery when it is not observable.

Try both GCC and Clang in the compiler dropdown. “Check the codegen” throughout this book means inspecting an optimized build here or with the local compiler, not inferring machine behavior from source shape alone.

## Where the book goes from here

Part I, Chapters 1–8, builds working C++ from types and expressions through classes, lifetime, errors, moves, and ownership. Its payoff is the ability to write small programs whose values, cleanup, and failure behavior are deliberate.

Part II, Chapters 9–15, covers the standard library: the first working model of templates and lambdas, containers, strings, algorithms, vocabulary types, and I/O. These chapters replace hand-built machinery with standard components while keeping their costs visible.

Part III, Chapters 16–19, connects source to the machine through object layout, allocation, allocators, and the build and linkage model. It supplies the vocabulary needed to explain cache behavior, heap traffic, and what becomes part of a binary.

Part IV, Chapters 20–22, develops generic and modern C++ through templates in depth, lambdas in depth, and newer language facilities. The result is reusable code that preserves type information and gives the optimizer room to work.

Part V, Chapters 23–26, covers threads, asynchronous work and coroutines, the memory model, and lock-free programming. It explains the correctness rules beneath concurrent low-latency systems rather than treating synchronization as a collection of recipes.

## Latency Lens

- C++ compiles ahead of time to native code, so normal execution has no interpreter loop or JIT warmup.
- An automatic-storage `Order` requires no heap allocation; reserving its stack frame is typically one stack-pointer adjustment shared with other locals.
- Deterministic destruction needs no tracing garbage collector, so cleanup occurs at known scope boundaries rather than during a GC pause.
- `-O0` and `-O2` can produce radically different instruction sequences; never infer production performance from a debug build.
- `std::vector::operator[]` performs no bounds check; the skipped branch removes a cost but leaves correctness to the caller.
- AddressSanitizer and UndefinedBehaviorSanitizer add enough overhead to keep them out of production, but expose invalid accesses during testing.
- Passing a scalar by value copies it, while passing by reference introduces an alias; that distinction affects both optimization and correctness.
- A range loop using `const Order&` avoids copying each `Order` while preventing modification through the loop variable.
- Compiler Explorer exposes the emitted instructions, making optimization changes visible before a source-level assumption becomes a latency claim.
