# 19. Build, Linkage, and the Translation Model

A C++ compiler processes source files independently, then a linker joins their compiled artifacts into a program. That split explains the language's header conventions, the One Definition Rule, and failures such as `undefined reference` and `multiple definition`. It also determines whether hot calls can be inlined or must cross a shared-library boundary.

## From text to executable

Use one small pricing component as the running example. Its header publishes types and declarations; its source file owns non-inline definitions.

`pricing.hpp`:

```cpp
#ifndef LOWLATENCY_PRICING_HPP
#define LOWLATENCY_PRICING_HPP

struct Order {
    double bid;
    double ask;
};

inline double mid(double bid, double ask) {
    return (bid + ask) / 2.0;
}

double spread_bps(const Order& order);
extern int tick_count;

#endif
```

`pricing.cpp`:

```cpp
#include "pricing.hpp"

#include <cmath>

int tick_count = 0;

double spread_bps(const Order& order) {
    ++tick_count;
    return 10'000.0 * std::abs(order.ask - order.bid)
           / mid(order.bid, order.ask);
}
```

`main.cpp`:

```cpp
#include "pricing.hpp"

#include <iostream>

int main() {
    const Order order{99.0, 101.0};
    std::cout << mid(order.bid, order.ask) << ' '
              << spread_bps(order) << ' '
              << tick_count << '\n';
} // prints: 100 200 1
```

A **translation unit**, or TU, is one source file after preprocessing. Preprocessing replaces each `#include` directive with header contents and expands macros. The compiler sees translation units one at a time; it never sees “the project.” The linker later sees sections, symbol names, and unresolved references—not C++ source-level intent.

The C++ standard specifies nine phases of translation. A practical toolchain groups them into four stages:

| Stage | Command | Input → output | Typical failure |
|---|---|---|---|
| Preprocess | `g++ -E` | source + headers → TU text | missing header, macro clash |
| Compile | `g++ -S` | TU text → assembly | syntax or type error |
| Assemble | `g++ -c` | assembly → object file | rare assembler error |
| Link | `g++` without `-c` | objects + libraries → executable | undefined or multiply defined symbol |

Preprocessing produces plain source text, conventionally saved as `.ii` for C++. Compilation parses that text, checks the language rules, optimizes it, and selects machine instructions in assembly form. The assembler encodes those instructions into a relocatable `.o`: machine code exists, but calls and addresses that cross object-file boundaries are not final.

The linker is the first tool with all selected object files in view. It combines their code and data, matches references to definitions, assigns final addresses, and writes an executable or library. It cannot repair a type disagreement hidden behind two otherwise compatible symbol names.

The commands expose every artifact:

```sh
g++ -std=c++23 -E pricing.cpp -o pricing.ii
wc -l pricing.ii
g++ -std=c++23 -S pricing.ii -o pricing.s
g++ -c pricing.s -o pricing.o
g++ -std=c++23 -c main.cpp -o main.o
g++ pricing.o main.o -o pricer
./pricer
# prints: 100 200 1
```

`g++ -E pricing.cpp | wc -l` commonly reports thousands of lines because `<cmath>` includes other headers. The exact count is library-specific. Normal `g++ -c pricing.cpp` performs the first three stages in one command and keeps only `pricing.o`.

Separate compilation saves work: editing `main.cpp` need not compile `pricing.cpp` again. The reverse obligation is easy to miss. If `pricing.hpp` changes, every translation unit that included it sees different pasted text and must be rebuilt; reusing a stale object can preserve an old layout or declaration.

**Rule.** A compile error belongs to one translation unit. A linker error is a disagreement among translation units or libraries.

## Headers, guards, and the preprocessor

`#include` is textual paste. Including an unguarded header twice puts two copies of every definition into one translation unit:

`bad_pricing.hpp`:

```cpp
struct Order {
    double bid;
    double ask;
};
```

`broken.cpp`:

```cpp
#include "bad_pricing.hpp"
#include "bad_pricing.hpp" // error: redefinition of 'struct Order'

int main() {
    return 0;
}
```

An **include guard** makes the header's contents conditional on a unique macro. The `LOWLATENCY_PRICING_HPP` guard in `pricing.hpp` ensures that only the first inclusion contributes text. `#pragma once` is a shorter alternative supported by all major C++ toolchains.

**Note.** `#pragma once` is not part of the C++ standard, despite being universal in practice. Either form is reasonable; use one convention consistently and give guard macros project-unique names.

Guard state lasts only for the current preprocessing run. Both `pricing.cpp` and `main.cpp` independently paste one guarded copy of `pricing.hpp`, so the class and inline function definitions still appear in both translation units. The ODR determines when those repeated definitions are legal.

Headers normally contain:

- declarations of functions and variables;
- class and enumeration definitions;
- `inline` function and variable definitions;
- template definitions, as introduced in Chapter 9;
- compile-time constants that are safe to define there.

A non-`inline` function or global-variable definition usually belongs in one `.cpp` file. Putting it in a header makes every including translation unit emit a definition, producing a link-time `multiple definition` error.

Make each header self-contained: it includes what its own declarations require and compiles when included first in an otherwise empty source file. Relying on a transitive include—one header accidentally including another—makes correctness depend on include order and breaks when an unrelated library header is cleaned up.

Macros perform token rewriting before the compiler understands types, scope, or precedence. A function-like macro can therefore parse unlike a function call:

```cpp
#define SQUARE(x) x * x

int macro_result() {
    const int a = 2;
    const int b = 3;
    return SQUARE(a + b); // expands to: a + b * a + b
} // returns: 11, not 25
```

Parenthesizing every parameter and the complete expansion would fix this macro, but a function is safer:

```cpp
constexpr int square(int value) {
    return value * value;
}
```

Parentheses do not fix repeated evaluation:

```cpp
#define GREATER(a, b) ((a) > (b) ? (a) : (b))

int macro_side_effect() {
    int sequence = 0;
    const int result = GREATER(++sequence, -1);
    return result + sequence;
} // returns: 4 because sequence is incremented twice
```

An equivalent function evaluates each argument once. A macro has no parameter objects; it substitutes `++sequence` into both places where `a` appears.

Constants, `inline` functions, `constexpr`, and templates replace most object-like and function-like macros. Conditional compilation remains a legitimate use:

```cpp
#ifdef NDEBUG
inline constexpr bool diagnostics_enabled = false;
#else
inline constexpr bool diagnostics_enabled = true;
#endif
```

The `NDEBUG` macro also controls whether `<cassert>`'s `assert` checks are active. The preprocessor additionally supports stringizing with `#` and token pasting with `##`; both are specialized tools, not ordinary abstraction mechanisms. Modules replace the textual-paste model (Chapter 22).

**Pitfall.** Macro names ignore namespaces and scopes. A short guard name can collide with another header's guard, while platform macros such as Windows headers' historical `min` and `max` can rewrite innocent identifiers throughout later source text.

## Declarations, definitions, and the ODR

A **declaration** introduces a name and enough type information to use it. A **definition** supplies the entity: a function body, an object's storage, or a complete class body.

| Entity | Declaration | Definition |
|---|---|---|
| Function | `double spread_bps(const Order&);` | declaration plus body |
| Global variable | `extern int tick_count;` | `int tick_count = 0;` |
| Inline variable | — | `inline int limit = 100;` in a header |
| Class | `struct Order;` | complete `struct Order { /* members */ };` |

Some syntax does both jobs. `int tick_count;` at namespace scope is a declaration and a definition, while `extern int tick_count;` without an initializer is only a declaration. Adding an initializer makes even `extern int tick_count = 0;` a definition.

The **One Definition Rule**, or ODR, has two working forms:

- A non-inline function or variable has exactly one definition in the entire program.
- A class, `inline` entity, or template may be defined in multiple translation units when every definition satisfies the ODR, including matching token sequences and name lookup.

“Matching tokens” is stricter than “seems equivalent.” Two inline bodies containing `return rate * 2;` and `return 2 * rate;` violate the ODR even if ordinary arithmetic makes their results equal. Identical tokens can also violate it if an unqualified name resolves to different entities in the two translation units.

The `extern` declaration in `pricing.hpp` does not allocate another `tick_count`. It says that an external-linkage definition exists elsewhere. `pricing.cpp` supplies that one definition.

```cpp
extern int tick_count; // declaration; may appear in many TUs
int tick_count = 0;    // definition; exactly one in the program
```

Today, `inline` primarily means that identical definitions may appear in several translation units. It does not command the optimizer to substitute a function body at its call sites. Conversely, an optimizer may inline a function that lacks the keyword.

An `inline` variable, available since C++17, permits a header-defined global to denote one entity across the program:

```cpp
inline constexpr int max_symbols = 4096; // C++17; safe in a header
```

An ODR violation need not produce a linker error. The following two source files define the same externally linked class and member function differently.

`helper_a.cpp`:

```cpp
struct Helper {
    int value;
    void normalize();
};

inline void Helper::normalize() {
    value = 0;
}

void normalize_a() {
    Helper helper{7};
    helper.normalize();
}
```

`helper_b.cpp`:

```cpp
struct Helper {
    int value;
    double scale;
    void normalize();
};

inline void Helper::normalize() {
    scale = 1.0;
}

void normalize_b() {
    Helper helper{7, 2.0};
    helper.normalize();
}
```

`main_helpers.cpp`:

```cpp
void normalize_a();
void normalize_b();

int main() {
    normalize_a();
    normalize_b();
}
```

Both out-of-class `inline` member definitions commonly become weak or COMDAT symbols with the same mangled name. The linker may retain one without comparing bodies. If `helper_b.cpp`'s version wins, `normalize_a` can write beyond its shorter object; if the other wins, `normalize_b` calls the wrong behavior.

```sh
g++ -std=c++23 -O0 -fno-inline -c helper_a.cpp helper_b.cpp main_helpers.cpp
g++ helper_a.o helper_b.o main_helpers.o -o helper_demo
# links clean on common ELF toolchains; running has undefined behavior
```

No diagnostic is required. Optimization level, link order, or an unrelated edit can change the symptom.

**Pitfall.** Two `.cpp` files do not automatically give their helper types separate identities. Put translation-unit-local helpers in anonymous namespaces, as shown in the next sections.

An entity is **odr-used** when a use requires its identity or stored value, such as taking its address, binding a reference to it, or making a non-inline function call. Odr-use requires a definition somewhere.

```cpp
struct LegacyLimits {
    static constexpr int max_orders = 100;
};

constexpr int copied = LegacyLimits::max_orders;
static_assert(copied == 100);
const int* address = &LegacyLimits::max_orders;
```

**Note.** Before C++17, the address-taking line odr-used `max_orders` and required an out-of-class definition such as `constexpr int LegacyLimits::max_orders;`; omitting it caused an undefined reference. Since C++17, a `static constexpr` data member is implicitly `inline`, so this C++23 code is complete.

Compiler success proves only that each translation unit had a usable declaration. It does not prove that an odr-used external entity has a definition; that check necessarily waits until linking.

## Three orthogonal properties

**Storage duration** answers when an object exists. **Scope** answers where a name can be written. **Linkage** answers whether declarations in different scopes or translation units denote the same entity.

C++ has four storage-duration categories:

| Duration | Typical object | Lifetime |
|---|---|---|
| Automatic | ordinary local variable | enclosing block execution |
| Static | namespace object or local `static` | entire program |
| Thread | `thread_local` object | one lifetime per thread |
| Dynamic | object created by allocation | controlled by allocation and release |

Storage duration describes the object, not necessarily the handle used to reach it. An automatic `std::unique_ptr` can own a dynamic-storage object; RAII couples their lifetimes without making their durations the same (Chapters 5 and 7).

| Entity | Storage duration | Scope | Linkage |
|---|---|---|---|
| Local `static` object | static | block | none |
| `extern` namespace variable | static | namespace | external |
| Anonymous-namespace function | not applicable | namespace | internal |
| Header `inline` variable | static | namespace | external; one entity |
| Namespace `thread_local` variable | thread | namespace | external by default |

A local `static` object's name is visible only inside its block, but the object lives for the program's duration. This replacement for `spread_bps` counts calls without exposing the counter:

```cpp
double spread_bps(const Order& order) {
    static unsigned long call_count = 0;
    ++call_count; // persists across calls; visible only in this function
    return 10'000.0 * (order.ask - order.bid)
           / mid(order.bid, order.ask);
}
```

A namespace-scope `extern` declaration such as `extern int tick_count` has external linkage: declarations in other translation units can denote the same object. The object's namespace scope does not itself mean that the object is created and destroyed as execution enters and leaves a namespace; namespaces are not runtime blocks.

An anonymous-namespace function has internal linkage. Other translation units can contain a function with the same spelling, but each denotes a different function. Functions do not have storage duration, because storage duration classifies objects and references.

An `inline` namespace variable still has external linkage and static storage duration. The ODR's inline allowance makes all matching header definitions refer to one object rather than giving each translation unit a private copy.

A `thread_local` object has one instance per thread; its detailed initialization and access mechanics belong to Chapter 23. The scope and linkage of its name still depend on where and how it is declared.

The keyword `static` is overloaded. At block scope it gives an object static storage duration; at namespace scope it gives a name internal linkage; inside a class it declares a member shared by all instances (Chapter 4). Ask which property the context changes instead of treating “static” as one concept.

Scope is equally independent. A block-scope reference can denote an external-linkage global, while a namespace-scope name in an anonymous namespace has internal linkage. Name visibility in source text says nothing by itself about lifetime or whether another translation unit can denote the entity.

The static-initialization-order fiasco occurs because dynamic initialization order across translation units is unspecified. Chapter 5's construct-on-first-use solution follows directly from that translation-unit boundary.

## Internal linkage and language linkage

Names with **internal linkage** cannot denote the same entity from another translation unit. An anonymous namespace is the preferred way to make helpers local to one translation unit, and it works for types as well as functions and variables.

```cpp
namespace {

struct Helper {
    int value;

    void normalize() {
        value = 0;
    }
};

double clamp_price(double price) {
    return price < 0.0 ? 0.0 : price;
}

} // namespace

double normalized_price(double price) {
    Helper helper{1};
    helper.normalize();
    return clamp_price(price) + helper.value;
}
```

Each `.cpp` can now define its own `Helper` without an ODR collision. Namespace-scope `static` also gives functions and variables internal linkage, but it cannot localize a type and survives mainly as C-compatible style.

**Rule.** Put every translation-unit-local helper type, function, and variable in an anonymous namespace.

C++ supports overloading, so an object file's symbol names must distinguish parameter types. **Name mangling** encodes that information into linker-visible names. On a typical Itanium-ABI ELF toolchain:

```sh
nm pricing.o | grep spread
# 0000000000000000 T _Z10spread_bpsRK5Order

c++filt _Z10spread_bpsRK5Order
# spread_bps(Order const&)
```

`c++filt` decodes the mangled spelling for humans. MSVC uses a different encoding, and Mach-O tools often display an additional leading underscore.

The return type is normally absent from an ordinary function's mangled name, while namespaces, class membership, parameter types, and qualifiers contribute as needed to distinguish overloads. Never construct or parse these names in application logic; use `c++filt` or the platform's symbol tools.

A declaration with C **language linkage** suppresses C++ name mangling so C and foreign-function interfaces can find a stable flat symbol:

```cpp
extern "C" double mid_c(double bid, double ask);
extern "C" double mid_c(int bid, int ask); // error: conflicting C-linkage declaration
```

An `extern "C"` API cannot overload one symbol name. It should expose C-compatible values, pointers, and explicitly laid-out records rather than references or classes with constructors and destructors. A flat C wrapper is often the cleanest boundary for Python `ctypes` and other FFI consumers.

Namespaces may organize C-linkage declarations in C++ source, but the exported C symbol does not encode that namespace. Two C-linkage declarations with the same function name therefore cannot become distinct overloads merely by placing them in different namespaces.

C headers that may also be parsed as C use this pattern:

```cpp
#ifdef __cplusplus
extern "C" {
#endif

double feed_mid(double bid, double ask);

#ifdef __cplusplus
}
#endif
```

**Pitfall.** If a header declares `mid_c` with `extern "C"` but its definition is compiled without that declaration, the definition gets a mangled C++ name. The linker then reports an undefined unmangled `mid_c`; `nm` makes the mismatch visible.

## Inside the object file

An object file packages machine code and data into **sections**, plus metadata that lets the linker combine it with other objects.

| Section | Typical contents | File behavior |
|---|---|---|
| `.text` | machine code | executable, read-only |
| `.rodata` | string literals, constant tables | read-only bytes |
| `.data` | nonzero-initialized globals | stored in the object |
| `.bss` | zero-initialized globals | size recorded; zero bytes omitted |

In `pricing.o`, `spread_bps` contributes code to `.text`; floating-point constants may occupy `.rodata`; `tick_count = 0` normally occupies `.bss`. A nonzero initializer would normally move it to `.data`.

These section names and placements describe the common ELF model, not requirements of C++. Optimizers may fold a constant into an instruction, remove an unused object, or create specialized sections such as `.text.hot`; inspect the actual object when the distinction matters.

`nm` prints the **symbol table**. Its one-letter codes make the unresolved work explicit:

| `nm` letter | Meaning | Typical source |
|---|---|---|
| `T` | global definition in `.text` | non-inline function |
| `t` | local definition in `.text` | anonymous-namespace function |
| `U` | undefined reference | call into another translation unit |
| `W` | weak definition | emitted inline function |
| `B` | global definition in `.bss` | zero-initialized global |
| `D` | global definition in `.data` | initialized global |

Inspect the running example with optimization disabled so the compiler emits `mid` out of line:

```sh
g++ -std=c++23 -O0 -fno-inline -c pricing.cpp main.cpp
nm pricing.o
# 0000000000000000 W _Z3middd
# 0000000000000000 T _Z10spread_bpsRK5Order
# 0000000000000000 B tick_count

nm main.o
#                  U _Z10spread_bpsRK5Order
# 0000000000000000 W _Z3middd
#                  U tick_count
```

Addresses and decoration vary by object format. The important match is `main.o`'s `U _Z10spread_bpsRK5Order` against `pricing.o`'s `T` definition. An `undefined reference` means some `U` symbol survived without a compatible strong or weak definition.

`nm -C main.o` performs demangling directly. The raw form is still useful when diagnosing a signature mismatch: a function taking `Order` by value and one taking `const Order&` produce different mangled names, so the linker cannot pair the call with the wrong definition.

`objdump` exposes section headers:

```sh
objdump -h pricing.o
# Idx Name       Size
#   0 .text      toolchain-specific
#   1 .data      toolchain-specific
#   2 .bss       toolchain-specific
#   3 .rodata    toolchain-specific
```

A **relocation** records a location in code or data whose final address is not known yet. An object-file call to `spread_bps` contains a placeholder plus a relocation naming that symbol. The linker merges compatible sections, resolves each `U` against a definition, assigns final addresses, and patches the recorded locations.

The same mechanism handles an instruction that loads `tick_count`: its address is unknown while `main.cpp` is compiled, so `main.o` carries an undefined symbol and a relocation at the load instruction. A declaration satisfied the compiler's type checking; the relocation carries the unresolved physical-address problem forward.

A `multiple definition` error is the opposite failure. Two strong symbols claim the same linker-visible name where the ODR permits only one, so the linker cannot choose. Weak definitions explicitly permit a selection, which is why an ODR violation involving inline bodies can remain silent.

## Libraries: static vs dynamic

A static library, normally ending in `.a` on Unix-like systems, is an archive of object files. The linker extracts an archive member only when it satisfies a symbol that is unresolved at the moment the archive is scanned.

```sh
g++ -std=c++23 -c pricing.cpp main.cpp
ar rcs libpricing.a pricing.o

g++ main.o -L. -lpricing -o pricer
./pricer
# prints: 100 200 1

g++ -L. -lpricing main.o -o pricer
# error: undefined reference to spread_bps(Order const&)
```

The linker usually scans command-line inputs left to right. In the failing order, no unresolved reference requests `pricing.o` when `libpricing.a` is scanned, so the archive member is not extracted. `main.o` introduces the reference too late.

Objects named directly are always included; archive members are demand-loaded. If one extracted archive member introduces another unresolved symbol, the linker can use the archive's index to extract another member. The command-line ordering problem appears at the boundary between separate archives and preceding objects.

**Pitfall.** Put an archive after the objects and archives that need it. Circular archive dependencies may require repeating libraries or GNU linker's `--start-group` and `--end-group`.

A shared library, normally ending in `.so` on ELF systems, remains a separate file. Position-independent code allows the loader to map it at a suitable address:

```sh
g++ -std=c++23 -fPIC -c pricing.cpp -o pricing.pic.o
g++ -shared pricing.pic.o -o libpricing.so
g++ main.o -L. -lpricing -Wl,-rpath,'$ORIGIN' -o pricer-dynamic
./pricer-dynamic
# prints: 100 200 1
```

Cross-library calls commonly use a Procedure Linkage Table and Global Offset Table, abbreviated PLT and GOT. After symbol resolution, the call performs an indirect jump through a GOT entry; lazy binding makes the first call enter the dynamic loader as well. Load-time relocation, symbol lookup, and interposition add startup work.

The executable records a dependency on the library's needed name—often its soname—rather than copying `pricing.o` into itself. At launch, the dynamic loader must locate a compatible file; search paths and installed versions therefore become deployment inputs. The `$ORIGIN` runtime path in the example asks the ELF loader to search beside the executable.

| Property | Static library `.a` | Shared library `.so` |
|---|---|---|
| Call path | direct | PLT/GOT indirection |
| Startup | no dynamic-library work | map, resolve, relocate |
| Deployment | one executable | executable plus compatible libraries |
| Sharing across different executables | code copied into each executable | library code pages shareable |
| Interposition | unavailable | `LD_PRELOAD` |
| LTO scope | whole linked program possible | normally per library |

Static linking often suits latency-sensitive executables: calls can be direct, deployment has no library-version skew, and link-time optimization with `-flto` gives the optimizer a cross-translation-unit view. Shared libraries remain valuable for plugins and large dependencies shared by many processes.

Static linking does not automatically produce cross-file optimization. Ordinary `.o` files have already lost much source-level information; both compilation and the final link must participate in LTO so the linker plugin can pass intermediate representation to the optimizer.

Dynamic-library pages containing unchanged code can be shared by processes running different executables, reducing aggregate physical memory. Processes running the same static executable can also share its read-only pages, but separate executables each contain their own linked copy.

Linking `libpricing.a` statically does not by itself make the whole executable self-contained; other dependencies may remain dynamic. “Fully static” describes a final link that selects static forms of every required library.

ELF symbol **interposition** permits a loaded definition to replace another definition. `LD_PRELOAD` loads a chosen shared library first:

```sh
LD_PRELOAD=./libcountalloc.so ./pricer-dynamic
```

That mechanism can install a counting `malloc` or another allocator without rebuilding the executable, complementing the allocation tripwires from Chapters 17 and 18.

**Note.** `LD_PRELOAD`, `.so`, and the shown linker-group flags are ELF conventions. macOS and Windows use different file formats and loader controls. Mixing static and dynamic C++ runtime-library variants can duplicate runtime state and violate ABI assumptions; keep one consistent runtime strategy.

## PImpl and opaque ABI boundaries

A public class definition normally exposes its non-static data members. Changing those members changes `sizeof`, alignment, layout, and the source dependencies required to compile every user. The **pointer-to-implementation** idiom, or PImpl, moves private representation behind one pointer.

```cpp
// session.hpp
#pragma once

#include <memory>
#include <string_view>

class Session {
public:
    explicit Session(std::string_view endpoint);
    ~Session();

    Session(Session&&) noexcept;
    Session& operator=(Session&&) noexcept;

    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;

    void send(int order_id);

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
```

The header declares `Impl` without defining it. The source file owns the representation and the headers it needs:

```cpp
// session.cpp
#include "session.hpp"

#include <string>
#include <utility>
#include <vector>

class Session::Impl {
public:
    explicit Impl(std::string_view endpoint)
        : endpoint_(endpoint) {}

    void send(int order_id) {
        pending_.push_back(order_id);
    }

private:
    std::string endpoint_;
    std::vector<int> pending_;
};

Session::Session(std::string_view endpoint)
    : impl_(std::make_unique<Impl>(endpoint)) {}

Session::~Session() = default;
Session::Session(Session&&) noexcept = default;
Session& Session::operator=(Session&&) noexcept = default;

void Session::send(int order_id) {
    impl_->send(order_id);
}
```

The destructor and move operations are defined where `Impl` is complete. Users compile against a class containing one `unique_ptr`, not against `string` and `vector` internals. A private member change recompiles `session.cpp` rather than every translation unit including `session.hpp`.

PImpl is one point on an interface spectrum:

| Boundary | Private representation visible? | Typical call shape | Build/ABI effect | Runtime cost |
|---|---:|---|---|---|
| Header-defined value type | Yes | direct, often inlineable | member changes rebuild users and can change ABI | no boundary indirection |
| PImpl class | No | load implementation pointer, then call | stable outer size; fewer header dependencies | allocation plus indirection unless storage is supplied separately |
| C opaque handle | No | function call with handle pointer | narrow language-neutral ABI | call and pointer-based access |
| Pure virtual interface | No concrete layout | indirect virtual call | implementation types hidden | vtable dispatch; usually separate object |

An opaque C boundary exposes only an incomplete handle:

```cpp
// session_c.h
typedef struct session_handle session_handle;

session_handle* session_create(const char* endpoint);
void session_send(session_handle*, int order_id);
void session_destroy(session_handle*);
```

This shape avoids C++ name mangling and keeps the concrete layout on one side of the library boundary. The creating library must also destroy the object so allocation and runtime-library ownership do not cross inconsistently.

PImpl is not a universal class design. A `Price` or `Order` value used in an inner loop benefits from inline storage, trivial movement, and compiler-visible members. PImpl fits coarse service objects and shared-library boundaries where build isolation or ABI control justifies its pointer chase and usual allocation.

**Rule.** Hide representation at a binary boundary deliberately. Keep compact hot-path value types transparent to the optimizer and use opaque ownership at colder subsystem edges.

## Visibility and weak symbols

Linkage and visibility answer different questions. External linkage lets declarations in different translation units denote one entity. **Visibility** controls whether that entity appears in a shared library's exported dynamic symbol table.

ELF toolchains export external symbols by default. Building with `-fvisibility=hidden` makes hidden the default, then an API macro marks the intentional public surface:

```cpp
#if defined(PRICING_BUILD)
#define PRICING_API __attribute__((visibility("default")))
#else
#define PRICING_API
#endif

struct Order;
PRICING_API double spread_bps(const Order& order);
PRICING_API extern int tick_count;
```

Build the library with `-DPRICING_BUILD -fvisibility=hidden`. A smaller dynamic symbol table reduces loader lookup and relocation work. Hidden functions also cannot be interposed from outside the shared object, giving the optimizer more freedom to inline, devirtualize, or bind calls directly.

Inspect the dynamic export surface rather than assuming the attribute worked:

```sh
nm -D --defined-only libpricing.so | c++filt
# spread_bps(Order const&)
# tick_count
```

On ELF, ordinary `nm` shows the full object symbol table, while `nm -D` selects symbols visible to the dynamic loader. Internal implementation helpers can still exist in the library without appearing in this output.

**Pitfall.** Hidden visibility breaks a plugin or `dlopen` consumer that expects an unexported symbol. Treat the export macro as part of the library's ABI contract.

Weak symbols explain how common toolchains implement the ODR allowance for `inline`. The `mid` function is defined in `pricing.hpp`, so both translation units can emit it:

```sh
g++ -std=c++23 -O0 -fno-inline -c pricing.cpp main.cpp
nm pricing.o main.o | c++filt | grep ' mid('
# 0000000000000000 W mid(double, double)
# 0000000000000000 W mid(double, double)
```

The linker retains one compatible weak or COMDAT copy and discards the duplicates. Templates behave similarly on common ABIs; their instantiation mechanics belong to Chapter 20.

A strong definition normally overrides a weak definition with the same compatible symbol name. Weak binding is consequently useful for replaceable defaults in some systems, but portable C++ code should not use it as an application-level dispatch mechanism; the language itself has no standard weak-symbol feature.

**Note.** The C++ standard specifies program semantics, not ELF symbol letters or COMDAT sections. `W` is the common ELF observation, while other object formats implement the same language rule differently.

The linker compares names and binding strength, not C++ token sequences. Different weak definitions with the same mangled name can therefore link cleanly, as the `Helper` violation did. The program is still ill-formed, no diagnostic required; whichever body survives does not repair the ODR violation.

## Latency Lens

- A call across an ELF shared-library boundary commonly adds PLT/GOT indirection, and an interposable callee cannot normally be inlined into the caller.
- PImpl and opaque handles reduce rebuild and ABI coupling at the price of an object allocation and pointer indirection; keep that boundary outside per-event value processing.
- Link-time optimization with `-flto` gives the optimizer cross-file IR, enabling hot small functions to inline across translation-unit boundaries.
- `-fvisibility=hidden` shrinks dynamic symbol and relocation work and lets the compiler bind calls that an exported, interposable symbol would constrain.
- Dynamic loading pays mapping and relocation at startup, while lazy binding can put symbol resolution on the first hot-path call; warm up or link statically when that tail matters.
- Duplicate `inline` definitions increase preprocessing, compilation, and object-file work, but weak/COMDAT deduplication leaves one runtime body.
- A dynamically initialized function-local `static` needs a once-only guard check until initialization completes; constant namespace-scope initialization can remove that hot-call check.
- `LD_PRELOAD` swaps allocators through the same interposition machinery without recompilation, while preserving the indirect dynamic-call path.
- `.bss` records only the size of a zero-initialized table in the executable; runtime address space and first-touch page costs remain even though file I/O does not carry the zero bytes.
