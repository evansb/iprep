# 5. Object Lifetime, Initialization, and RAII

C++ makes object creation and destruction visible parts of the program. That control enables deterministic cleanup and predictable cost, but it also makes uninitialized objects and dangling references your responsibility. RAII turns that responsibility into a property of types rather than a collection of cleanup conventions.

## Storage, lifetime, and the object model

An object is a region of storage together with a type and a lifetime. Storage supplies the bytes; an object's lifetime determines when operations on those bytes may treat them as that type.

C++ has four storage durations:

| Storage duration | Typical source | Storage remains available until |
|---|---|---|
| Automatic | Local variable | Its block exits |
| Static | Namespace-scope variable; local `static` | Program termination |
| Dynamic | Explicit allocation | Explicit release |
| Thread-local | `thread_local` variable | Its thread terminates |

Automatic and static objects are the focus here. Dynamic storage and allocation appear in Chapter 17; thread-local objects appear with concurrency later in the book.

An object's lifetime begins after its initialization completes. For a class object, its lifetime ends when its destructor begins; for a trivial type such as `int`, it ends when its storage is released or reused.

```cpp
#include <iostream>

const int& closing_price() {
    int price = 102;
    return price;  // error: returns reference to local variable
}

int main() {
    const int& price = closing_price();
    std::cout << price << '\n';  // UB: the referenced int is dead
}
```

The storage formerly occupied by `price` may still contain the bits for `102`. That does not make an `int` object alive there. Lifetime is a semantic property, not a test of whether memory has been overwritten.

Compilers commonly warn about this example with `-Wall`. They cannot diagnose every lifetime error, especially after the reference passes through several functions.

Storage can outlive one object and later hold another. The mechanics and restrictions of storage reuse belong to Chapters 16–17. Any operation that treats storage as an object outside that object's lifetime has undefined behavior, using the terminology from Chapter 3.

**Pitfall.** A pointer retaining the same address says nothing about whether its former object still exists. Dereferencing a pointer or reference to a dead object is a lifetime violation even when the bytes look unchanged.

## The initialization zoo

C++ has several initialization forms because they express different constraints. The punctuation is part of the meaning.

| Form | Syntax | What it does | Main pitfall |
|---|---|---|---|
| Default-initialization | `T x;` | Calls a class default constructor; leaves fundamental values indeterminate | Reading an indeterminate fundamental value is UB |
| Value-initialization | `T x{};` | Produces zero for fundamental types; initializes class objects | Not identical to “zero every byte” for classes |
| Zero-initialization | Applied before some other initialization | Gives static-storage objects a zero state before startup work | Usually implicit, not a distinct syntax |
| Direct-initialization | `T x(args);` | Selects a constructor directly | Parentheses can trigger the most vexing parse |
| Copy-initialization | `T x = expr;` | Initializes from an expression | Ignores `explicit` converting constructors |
| List-initialization | `T x{args};` or `T x = {args};` | Uses braces and rejects narrowing | Prefers an `initializer_list` constructor |
| Aggregate initialization | `T x{members};` | Initializes aggregate members in declaration order | Positional values are easy to swap |

### Default, value, and zero initialization

Default-initializing a fundamental type does not give it a useful value. Reading an indeterminate `int` has undefined behavior.

```cpp
int uninitialized;
int zero{};

std::cout << zero << '\n';           // prints: 0
std::cout << uninitialized << '\n';  // UB: indeterminate value
```

Do not describe `uninitialized` as containing “garbage but usable.” The program has already left the rules of C++ when it reads the value. MemorySanitizer can find many uninitialized reads; AddressSanitizer generally targets different classes of memory errors.

Value-initialization with `{}` produces zero for `int`, `double`, pointers, and other fundamental types. For a class, the class's constructors and member initializers determine the result.

Objects with static storage duration are zero-initialized before any dynamic initialization runs. A namespace-scope `int count;`, for example, starts as zero. This guarantee does not apply to an ordinary local `int count;`.

### Direct, copy, and list initialization

Direct-initialization passes arguments directly to constructor selection. Copy-initialization asks to initialize from an expression and does not consider an `explicit` converting constructor, as introduced in Chapter 4.

```cpp
class Price {
public:
    explicit Price(double value) : value_(value) {}

private:
    double value_;
};

Price a(99.5);    // direct-initialization: OK
Price b{99.5};    // direct-list-initialization: OK
Price c = 99.5;   // error: explicit constructor is not considered
```

List-initialization rejects narrowing conversions:

```cpp
double market_price = 101.75;

int rounded(market_price);  // allowed: silently produces 101
int rejected{market_price}; // error: narrowing conversion from double to int
```

Braces are a strong default because they initialize fundamental values and reject narrowing. They have one important exception: a class with a `std::initializer_list` constructor prefers that constructor. `std::initializer_list` is the library type behind a braced element list.

```cpp
#include <iostream>
#include <vector>

int main() {
    std::vector<int> repeated(3, 5);
    std::vector<int> elements{3, 5};

    for (int value : repeated) {
        std::cout << value << ' ';  // prints: 5 5 5
    }
    std::cout << '\n';

    for (int value : elements) {
        std::cout << value << ' ';  // prints: 3 5
    }
    std::cout << '\n';
}
```

Parentheses select the constructor taking a count and a value. Braces prefer the constructor taking an element list. Check the relevant constructors before mechanically changing existing parentheses to braces.

**Note.** `auto x{1};` deduces `int`, not `std::initializer_list<int>`. Copy-list-initialization, as in `auto x = {1};`, does deduce an initializer-list type when its elements agree.

### Aggregate initialization

An aggregate is a class-like type intended for member-by-member initialization, with restrictions that include having no user-declared constructors. A plain `struct` used as a record is the usual example.

```cpp
struct Quote {
    double bid;
    double ask;
};

Quote positional{99.50, 99.70};
Quote named{.bid = 99.50, .ask = 99.70};  // C++20
```

Designated initializers (C++20) name members and must follow declaration order. They reduce mistakes when adjacent members have the same type.

**Rule.** Prefer `{}` for a default value and braces when narrowing must be rejected. Verify constructor overloads when the type accepts an `initializer_list`.

## Most vexing parse

If a statement can be parsed as a declaration, C++ parses it as one. `Widget w();` therefore declares a function named `w` that takes no arguments and returns `Widget`; it does not create an object.

```cpp
class Widget {
public:
    void reset() {}
};

void configure() {
    Widget w();
    w.reset();  // error: member reference base type 'Widget ()' is not an object
}
```

Empty braces cannot describe a function parameter list, so they state the intent unambiguously:

```cpp
void reset_widget() {
    Widget w{};
    w.reset();  // OK
}
```

The same grammar can hide inside constructor arguments:

```cpp
struct Config {};
struct Timer {
    explicit Timer(Config) {}
};

void start_timer() {
    Timer timer(Config());   // declares a function
    Timer working{Config{}}; // constructs an object
    (void)working;
}
```

The diagnostic often appears at the first attempted use rather than at the misleading declaration. Braces eliminate this parse and make value-initialization explicit.

## Initialization versus assignment in constructors

A member initializer list initializes members. Statements in the constructor body run only after all members already exist, so an assignment there performs a second operation.

```cpp
#include <iostream>
#include <string>

class TracedSymbol {
public:
    TracedSymbol() {
        std::cout << "default\n";
    }

    explicit TracedSymbol(const std::string& value) : value_(value) {
        std::cout << "construct from symbol\n";
    }

    TracedSymbol& operator=(const std::string& value) {
        value_ = value;
        std::cout << "assign symbol\n";
        return *this;
    }

private:
    std::string value_;
};

class GoodOrder {
public:
    explicit GoodOrder(const std::string& symbol) : symbol_(symbol) {}

private:
    TracedSymbol symbol_;
};

class WastefulOrder {
public:
    explicit WastefulOrder(const std::string& symbol) {
        symbol_ = symbol;
    }

private:
    TracedSymbol symbol_;
};

int main() {
    GoodOrder good{"AAPL"};       // prints: construct from symbol
    WastefulOrder bad{"MSFT"};   // prints: default
                                //         assign symbol
}
```

For `WastefulOrder`, `symbol_` is default-constructed before the constructor body starts, then assigned. For `GoodOrder`, it is built once from its final value. A real `std::string` member may allocate during one or both operations.

Constructor-body assignment is not merely slower in some cases; it is impossible for several kinds of members:

- A `const` member must receive its value during initialization.
- A reference member must bind during initialization.
- A class member without a default constructor cannot wait for the body.

**Rule.** Initialize every member in the member initializer list unless the member deliberately needs its default state before a later assignment.

## Temporaries and lifetime extension

A prvalue expression can compute a value without naming an object. When that value must have identity—for example, because a reference binds to it or code accesses one of its members—the language performs temporary materialization and creates a temporary object.

Most temporaries are destroyed at the end of the full-expression that contains them. A full-expression is normally an entire statement, including its subexpressions.

Binding a temporary directly to a local `const T&` extends the temporary's lifetime to the reference's scope:

```cpp
#include <iostream>
#include <string>

std::string make_name() {
    return "EURUSD";
}

int main() {
    const std::string& symbol = make_name();
    std::cout << symbol << '\n';  // prints: EURUSD
}                                // temporary string dies here
```

An rvalue reference can also extend a directly bound temporary's lifetime; Chapter 7 develops rvalue references as part of move semantics. The extension belongs to the direct binding and does not propagate through another reference.

```cpp
const std::string& pass_through(const std::string& value) {
    return value;
}

void print_dangling_name() {
    const std::string& symbol = pass_through(make_name());
    // The temporary string dies at the semicolon above.
    std::cout << symbol << '\n';  // UB: symbol dangles
}
```

The temporary survives long enough for the function call because it binds to the parameter. Returning the parameter's reference does not grant another extension.

| Binding | Lifetime extended? |
|---|---|
| Local `const T&` directly to a temporary | Yes, to the reference's scope |
| Local rvalue reference directly to a temporary | Yes, to the reference's scope |
| Reference member in a constructor initializer | No; ill-formed in current C++ |
| Reference returned through a function | No |
| Temporaries in a range-for range expression | Yes in C++23; limited rules before C++23 |

Older compilers once accepted a reference member bound to a temporary in a constructor initializer; that temporary died when the constructor returned, leaving the member dangling. Current C++ makes the construction ill-formed. In either case, no useful lifetime extension occurs.

C++23 extends temporaries created in a range-for's range expression through the loop:

```cpp
#include <iostream>
#include <vector>

struct Config {
    std::vector<int> levels;

    const std::vector<int>& values() const {
        return levels;
    }
};

Config make_config() {
    return Config{{1, 2, 3}};
}

int main() {
    for (int level : make_config().values()) {  // C++23: temporary survives
        std::cout << level << ' ';              // prints: 1 2 3
    }
}
```

Before C++23, the `Config` temporary could die before the loop body, leaving the returned member reference dangling. The C++23 rule does not rescue a reference to a temporary already destroyed inside a called function.

**Pitfall.** Lifetime extension is attached to specific direct bindings. Copying the reference, returning it, or storing it in another object does not repeatedly extend the temporary.

## Construction and destruction order

Construction follows the structure of the object, not the textual order of a constructor's initializer list:

1. Base-class subobjects are constructed.
2. Members are constructed in their declaration order.
3. The constructor body runs.

Destruction runs the exact reverse: destructor body, members in reverse declaration order, then bases. Local objects in a scope are also destroyed in reverse declaration order.

```cpp
#include <iostream>

struct Base {
    Base() { std::cout << "Base+\n"; }
    ~Base() { std::cout << "Base-\n"; }
};

struct M1 {
    M1() { std::cout << "M1+\n"; }
    ~M1() { std::cout << "M1-\n"; }
};

struct M2 {
    M2() { std::cout << "M2+\n"; }
    ~M2() { std::cout << "M2-\n"; }
};

struct Derived : Base {
    Derived() { std::cout << "Derived+\n"; }
    ~Derived() { std::cout << "Derived-\n"; }

    M1 first;
    M2 second;
};

int main() {
    Derived value;
}

// prints:
// Base+
// M1+
// M2+
// Derived+
// Derived-
// M2-
// M1-
// Base-
```

This reverse order allows later objects to depend on earlier objects in the same scope. The dependents die first, while the objects they use are still alive.

Members ignore initializer-list order. This constructor looks as if it initializes `size_` first, but `buffer_` is declared first and therefore uses `size_` before `size_` is initialized:

```cpp
class Packet {
public:
    explicit Packet(int size) : size_(size), buffer_(size_) {}

private:
    std::vector<int> buffer_;  // initialized first
    int size_;                 // initialized second
};
```

Compilers diagnose this ordering mismatch with `-Wreorder`, included by common warning sets. Fix the declaration order rather than rearranging only the initializer list:

```cpp
private:
    int size_;
    std::vector<int> buffer_;
```

**Pitfall.** The initializer list can visually lie about ordering. When one member initializer depends on another member, declaration order is the dependency order.

## RAII — the idiom of the book

RAII stands for Resource Acquisition Is Initialization. A constructor acquires a resource and establishes an ownership invariant; the destructor releases the resource. Every exit from the owner's scope then performs cleanup automatically.

```cpp
#include <cstdio>
#include <cstdlib>

class FileHandle {
public:
    FileHandle(const char* path, const char* mode)
        : file_(std::fopen(path, mode)) {
        if (file_ == nullptr) {
            std::abort();
        }
    }

    ~FileHandle() {
        std::fclose(file_);
    }

    FileHandle(const FileHandle&) = delete;
    FileHandle& operator=(const FileHandle&) = delete;

    std::FILE* get() const {
        return file_;
    }

private:
    std::FILE* file_;
};

bool write_report(const char* path, const char* text) {
    FileHandle output{path, "w"};

    if (text == nullptr) {
        return false;  // output closes
    }
    if (std::fputs(text, output.get()) < 0) {
        return false;  // output closes
    }
    return true;       // output closes
}
```

`FileHandle` always contains a valid open file after successful construction. Its destructor can therefore call `std::fclose` without another validity branch. This small example aborts when acquisition fails; Chapter 6 covers structured failure reporting.

Copying the raw `std::FILE*` would create two apparent owners and two calls to `std::fclose`, so both copy operations are deleted. Moving ownership safely out of a `FileHandle` is covered in Chapter 7.

Manual cleanup makes every control-flow path responsible for release:

```cpp
bool write_report_manually(const char* path, const char* text) {
    std::FILE* output = std::fopen(path, "w");
    if (output == nullptr) {
        return false;
    }
    if (text == nullptr) {
        return false;  // leak: forgot std::fclose(output)
    }
    const bool ok = std::fputs(text, output) >= 0;
    std::fclose(output);
    return ok;
}
```

Adding a return adds another opportunity to leak. The RAII version has one release site, and the compiler inserts the destructor call at each completed scope exit. Stack unwinding also runs destructors (Chapter 6).

The same ownership shape appears throughout modern C++:

- Containers own their storage.
- `std::unique_ptr` packages single-owner RAII (Chapter 8).
- `std::lock_guard` owns a mutex lock for a scope (Chapter 23).
- Application types can own files, sockets, database handles, and mapped regions.

A destructor must not let failure escape. Cleanup failure policy and exception interaction belong to Chapter 6.

**Rule.** Give every resource an owning type. Do not scatter naked acquire/release pairs across control flow.

## Statics and the initialization order fiasco

A function-local `static` object initializes the first time execution reaches its declaration. Since C++11, that initialization is thread-safe; concurrency details wait until Chapter 23.

```cpp
Logger& logger() {
    static Logger instance;
    return instance;
}
```

The `Logger` is constructed before `logger()` returns for the first time. Later calls return the same object.

Namespace-scope objects are different. Within one translation unit, their dynamic initialization follows definition order. Across translation units, the relative order is unspecified.

```cpp
// globals.hpp
struct Logger {
    Logger();
    void write(const char* message) const;
};

extern Logger global_logger;

struct Config {
    Config();
};
```

```cpp
// logger.cpp
#include "globals.hpp"
#include <cstdio>

Logger global_logger;

Logger::Logger() {
    // acquire logging destination
}

void Logger::write(const char* message) const {
    std::puts(message);
}
```

```cpp
// config.cpp
#include "globals.hpp"

Config global_config;

Config::Config() {
    global_logger.write("loading config");  // may run before global_logger's ctor
}
```

If `global_config` initializes first, its constructor uses storage reserved for `global_logger` before the `Logger` object's lifetime has begun. The result depends on link and startup ordering and can have undefined behavior. A different build arrangement may appear to fix it.

Move the dependent object behind a function-local static:

```cpp
Logger& logger() {
    static Logger instance;
    return instance;
}

Config::Config() {
    logger().write("loading config");  // Logger is alive before write()
}
```

The general fixes are:

- Prefer no dependent namespace-scope objects.
- Put a lazily needed object behind a function-local static accessor.
- Use constant initialization where possible; `constinit` can enforce it (Chapter 22).

Destruction across translation units has the mirror problem: teardown order is tied to construction order, whose cross-unit relationship was unspecified. A global destructor that uses another translation unit's already-destroyed object can fail at program shutdown.

**Pitfall.** Static initialization bugs often survive testing because a particular linker invocation chooses a repeatable order. Repeatable does not mean guaranteed.

## Latency Lens

- `int x{}` usually adds one zeroing store; the real cost of `int x;` is a possible UB investigation. Skip initialization only for a buffer provably overwritten before every read.
- Constructor-body assignment first constructs and then assigns; for a member such as `std::string`, that can add allocation and deallocation work that direct member initialization avoids.
- Temporary materialization creates a real object with any associated allocation and destructor work; count temporaries in hot expressions.
- Construction and destruction order is fixed by declarations, so RAII cleanup compiles to ordinary destructor calls rather than garbage-collector bookkeeping.
- RAII adds no ownership tax over a correct manual release: a `FileHandle` destructor performs the same `fclose`, while making missed paths structurally impossible.
- A function-local static has a guarded first-use check; repeated access in a hot loop can pay a synchronized, atomic-like check each iteration, so obtain the reference before the loop.
- Zero-initialized static storage is commonly supplied by the executable's zero-filled segment and loader; dynamic global initializers execute during startup and add launch work.
