# 1. C++ program anatomy and the build model

*Part I — Language foundations*

---

**Recall**
- A translation unit (TU) is one source file *after* preprocessing: included text present, excluded `#if` branches gone.
- The preprocessor manipulates tokens and files; the compiler reasons about entities inside one TU; the linker resolves symbols across TUs.
- Every definition is a declaration; not every declaration is a definition — a definition supplies storage, a body, or a class/enum body.
- The ODR has two layers: exactly one definition program-wide for non-inline functions/variables, and identical definitions permitted in many TUs for classes, templates, `inline` functions, and `inline` variables.
- ODR violations are IFNDR (ill-formed, no diagnostic required) — the linker picking one copy does not make the program correct.
- `inline` is an ODR/linkage facility, not an optimizer command; the compiler may inline non-`inline` functions and may emit calls to `inline` ones.
- Linkage answers "can declarations in different scopes/TUs denote the same entity"; it is orthogonal to storage duration.
- Namespace-scope `const` objects have internal linkage by default; `inline constexpr` is the ODR-safe header constant.
- `static` means three unrelated things: internal linkage (namespace scope), static storage duration (block scope), per-class not per-object (class member).
- An incomplete type suffices for pointers, references, and declarations; not for `sizeof`, by-value members, bases, or `new`/`delete`.
- `std::unique_ptr<Incomplete>` members compile only if the owner's destructor is defined where the type is complete — declare `~Owner();` and define it out of line.
- Unqualified calls trigger ADL over the namespaces/classes associated with the arguments; that is what makes hidden friends and `using std::swap;` work.
- Static initialization (constant then zero) happens before any dynamic initialization; cross-TU *dynamic* initialization order is unspecified — the static initialization order fiasco.
- Function-local statics initialize on first use with thread-safe (`__cxa_guard`) semantics since C++11; destruction order and reentrancy remain your problem.
- `constinit` forbids dynamic initialization (still mutable); `constexpr` implies `const` for variables; `consteval` makes every call immediate.
- `std::exit` runs static destructors but unwinds nothing; `quick_exit`/`_Exit`/`abort` skip static destruction entirely.
- Reaching the closing brace of `main` is `return 0;`; `main` may not be called, overloaded, `static`, `inline`, `constexpr`, a coroutine, or attached to a named module.
- `#pragma once` is a ubiquitous extension; include guards are standard — neither fixes ODR-wrong header contents.
- Modules give an importable interface and cut textual coupling, but do not abolish linking, ABI, instantiation, or build-order scanning.
- Feature-test macros (`__cpp_*`, `__cpp_lib_*` via `<version>`) beat compiler-version sniffing; `__cplusplus` names a language mode, not full support.
- ABI-relevant flags (standard-library version, exception model, iterator debug mode, `-D` macros affecting layout) must match across every binary boundary.
- Hot-path relevance: ODR/flag skew silently changes inlined code and layout; unexpected dynamic initialization allocates or locks before `main`; visibility and LTO decide devirtualization.

---

## 1.1 Source files, headers, translation units, and preprocessing

```text
source.cpp + #included headers
   │ phases 1–4: charset map, line splice, tokenize, PREPROCESS
   ▼ translation unit (one compiler input)
   │ phases 5–7: convert literals, concatenate adjacent string literals, PARSE + INSTANTIATE
   ▼ object file: code + data + symbol table + relocations
   │ phase 9: LINK (archives, shared libs, entry stub)
   ▼ executable / shared object
   │ loader: map image, resolve dynamic symbols, run .init_array
   ▼ static init → main() → static destruction / atexit
```

```cpp
// price.cpp — one TU after preprocessing
#include "price.hpp"            // textual inclusion: the header's tokens land HERE
#include <cstdint>              // <> searches system paths; "" searches local first

#if defined(ENABLE_TRACE)       // only ONE branch survives into the TU
  #define TRACE(x) ::trace(x)
#elif __has_include(<tracing>)  // C++17 include check
  #define TRACE(x) ((void)0)
#else
  #define TRACE(x) ((void)0)
#endif

#ifdef NDEBUG                   // defined(X) / #ifdef X / #ifndef X
#endif

#undef TRACE                    // macros are file/token scoped, not C++ scoped
```

```cpp
// ---- preprocessor operator zoo ----------------------------------------
#define STRINGIZE_(x) #x                 // # : stringize the argument
#define STRINGIZE(x)  STRINGIZE_(x)      // two levels → expand THEN stringize
#define CAT_(a, b)    a##b               // ## : token paste
#define CAT(a, b)     CAT_(a, b)
#define UNIQUE        CAT(tmp_, __LINE__)   // tmp_42
#define LOG(fmt, ...) log(fmt __VA_OPT__(,) __VA_ARGS__)  // C++20: comma only if args
static_assert(sizeof(STRINGIZE(1 + 1)) == 6);             // "1 + 1"

// predefined: __FILE__ __LINE__ __DATE__ __TIME__ __cplusplus __func__ (a variable)
```

```cpp
// ---- macro traps -------------------------------------------------------
#define BAD_SQUARE(x) x * x
int a = BAD_SQUARE(1 + 2);        // 1 + 2*1 + 2 == 5   — no precedence
#define LESS_BAD(x) ((x) * (x))
int b = LESS_BAD(i++);            // i incremented twice — UB (unsequenced)
constexpr int square(int x) noexcept { return x * x; }   // the actual fix

#define MAX(a, b) ((a) > (b) ? (a) : (b))   // also double-evaluates
constexpr auto mx = [](auto a, auto b) { return a > b ? a : b; };

#define min(a,b) ...                       // <windows.h> style: poisons std::min
// mitigate: #define NOMINMAX  or  (std::min)(a, b)  or #undef min
```

```bash
c++ -std=c++23 -E price.cpp -o price.ii        # preprocess only
c++ -std=c++23 -O2 -c price.cpp -o price.o     # compile+assemble, no link
c++ -std=c++23 -S price.cpp -o price.s         # emit assembly
c++ price.o main.o -o app                      # link
c++ -MMD -MP -c price.cpp                      # emit .d header dependencies
c++ -E -dM -x c++ /dev/null                    # dump all predefined macros
```

| Concept | One-line recall |
|---|---|
| Source file | Implementation input; the `.cpp`/`.hpp` suffix is tool convention, not language. |
| Header | Text intended for inclusion; compiled once *per includer*, not once globally. |
| Translation unit | Source file + all included text, after conditional compilation. |
| Phases of translation | 9 conceptual phases; toolchains fuse them into preprocess/compile/assemble/link. |
| String literal concatenation | `"a" "b"` merges in phase 6, before parsing. |
| `__has_include` / `__has_cpp_attribute` | Preprocessor-time availability queries (C++17/C++20). |

**Interview line** — "`#include` is textual substitution, not import: the same declarations and template definitions are re-parsed in every TU that includes them."

**Traps** — macros have no scope and no type checking · a function-like macro can evaluate an argument twice · a header's macros leak into every later include · macros defined differently per TU silently change inline/class definitions (see 1.4) · `#pragma once` fails across hard links/symlink duplicates of the same header.

---

## 1.2 Declarations versus definitions

```cpp
// ---- declarations that are NOT definitions -----------------------------
struct Quote;                       // incomplete class type
extern int connection_count;        // object declared elsewhere
int parse(Quote const&);            // function declaration (no body)
extern template class Pool<int>;    // suppresses implicit instantiation here
namespace api = api_v2;             // (alias declaration — is a definition)
class C;                            // elaborated-type-specifier declaration
enum class Side : std::uint8_t;     // opaque enum DECLARATION (needs fixed base)

// ---- definitions --------------------------------------------------------
struct Quote { long bid; long ask; };            // class definition
int connection_count = 0;                        // object definition (+ init)
int parse(Quote const& q) { return q.bid <= q.ask; }  // function definition
enum class Side : std::uint8_t { buy, sell };    // enum definition
using Index = int;                               // alias definition (no new type)
inline constexpr int depth = 8;                  // inline variable definition
template<class T> struct Ring { T* p; };         // template definition
static_assert(sizeof(Quote) == 16);
```

| Spelling (namespace scope) | Definition? | Note |
|---|---|---|
| `int x;` | yes | Defines and zero-initializes. |
| `extern int x;` | no | Pure declaration. |
| `extern int x = 1;` | **yes** | An initializer makes it a definition. |
| `static int x;` | yes | Definition with internal linkage. |
| `const int x = 1;` | yes | Definition, internal linkage by default. |
| `inline int x = 1;` | yes | One entity program-wide (C++17). |
| `thread_local int x;` | yes | One object per thread. |
| `void f();` | no | Declaration. |
| `void f() {}` | yes | Definition. |
| `void f() = delete;` | yes | Deleted definition. |
| `virtual void f() = 0;` | no* | Pure-virtual declaration; may still be defined out of line. |
| `class C;` | no | Incomplete. |
| `class C {};` | yes | Complete. |
| `enum class E : int;` | no | Opaque declaration. |
| `using A = B;` | yes | Alias definition. |
| `template<class T> void f();` | no | Template declaration. |
| `extern template void f<int>();` | no | Explicit instantiation *declaration*. |
| `template void f<int>();` | yes | Explicit instantiation *definition*. |

```cpp
// ---- incomplete types: what is allowed --------------------------------
class Book;
Book* p;                                    // OK: pointer
void consume(Book const&);                  // OK: reference parameter
Book make();                                // OK: DECLARING by value is fine
extern Book* table[8];                      // OK
using Factory = std::unique_ptr<Book>(*)(); // OK

// Book b;                  // error: complete type required to define an object
// sizeof(Book);            // error
// struct Cache { Book v; };// error: by-value member
// struct D : Book {};      // error: base must be complete
// delete p;                // UB if Book incomplete and has non-trivial dtor
// make();                  // error at the call: return type must be complete
```

```cpp
// ---- pimpl: unique_ptr to an incomplete type ---------------------------
// engine.hpp
#include <memory>
class Book;                    // incomplete on purpose
class Engine {
public:
    Engine();
    ~Engine();                 // DECLARED here, DEFINED in engine.cpp
    Engine(Engine&&) noexcept; // ditto: move ops also touch the deleter
    Engine& operator=(Engine&&) noexcept;
private:
    std::unique_ptr<Book> book_;
};
// engine.cpp
#include "engine.hpp"
#include "book.hpp"            // Book is complete HERE
Engine::Engine() : book_{std::make_unique<Book>()} {}
Engine::~Engine() = default;               // deleter instantiated with Book complete
Engine::Engine(Engine&&) noexcept = default;
Engine& Engine::operator=(Engine&&) noexcept = default;
```

**Traps** — an implicit inline `~Engine()` instantiates `default_delete<Book>` in a TU where `Book` is incomplete (`static_assert` fires or, worse, silent UB) · `std::shared_ptr<Incomplete>` is fine because the deleter is captured at construction · defaulting move ops *in the header* reintroduces the same problem · a declared-but-never-defined function is a link error only if odr-used.

---

## 1.3 Compile, instantiate, link, load, and execute

```cpp
// ---- what each stage can and cannot see -------------------------------
// compiler:  one TU. Type-checks calls against visible DECLARATIONS.
// linker:    symbols only. No types (except via name mangling), no bodies.
extern void trade();     // compiles fine everywhere
int main() { trade(); }  // link error if no TU defines trade()
```

```cpp
// ---- template instantiation happens in the USING TU ---------------------
// pool.hpp
template<class T> struct Pool { T* alloc(); };
template<class T> T* Pool<T>::alloc() { return nullptr; }   // must be visible

// pool.cpp — option A: explicit instantiation definition (emits the code once)
template struct Pool<int>;
// user.cpp  — option B: suppress implicit instantiation, rely on pool.o
extern template struct Pool<int>;   // C++11
```

```bash
nm -C app.o                  # list symbols (-C demangles)
nm -C --undefined-only app.o # what this object still needs
c++filt _ZN2qs8midpointENS_5PriceES1_   # demangle by hand
ldd ./app                    # dynamic dependencies (Linux); otool -L on macOS
readelf -d ./app             # DT_NEEDED, RUNPATH, SONAME
nm -D --defined-only libfeed.so
objdump -d --no-show-raw-insn price.o
ar rcs libfeed.a a.o b.o     # static library = archive of objects
c++ -shared -fPIC -o libfeed.so a.o b.o
c++ main.o -L. -lfeed -Wl,-rpath,'$ORIGIN'   # link order matters for archives
c++ -flto -O2 ...            # cross-TU inlining/devirtualization
c++ -fvisibility=hidden -DFEED_API='__attribute__((visibility("default")))'
```

| Symptom | Likely cause |
|---|---|
| `undefined reference to 'f()'` | Declared, never defined; object/library omitted; archive listed before its user; signature/`const`/namespace mismatch changed the mangled name. |
| `undefined reference` to a C symbol from C++ | Missing `extern "C"` on one side. |
| `multiple definition of 'x'` | Non-`inline` definition in a header; same `.cpp` linked twice. |
| Undefined template specialization | Definition not visible in the instantiating TU and no explicit instantiation linked. |
| Links, then crashes/misbehaves | ODR violation, ABI/flag skew, init-order bug, or plain UB. |
| Works static, breaks shared | Visibility, `-fPIC`, symbol interposition, or duplicated static state per DSO. |

- Static library = archive; the linker extracts only objects that resolve a pending undefined symbol, scanning left to right.
- Shared library = separately mapped image; ABI compatibility depends on compiler, standard-library version, flags, layouts, exception model, and visibility.
- Loader order: map image → relocate → resolve dynamic symbols (lazy via PLT unless `-Wl,-z,now`) → run `.init_array` (dynamic initializers) → `main`.

**Interview line** — "Compiling checks one TU against declarations; linking requires that the whole program supply exactly one definition of everything odr-used."

---

## 1.4 The One Definition Rule (ODR)

```cpp
// ---- layer 1: one definition in the whole program ----------------------
// config.hpp  — WRONG: every includer defines the same external object
int feed_port = 9000;                 // multiple definition at link time

// config.hpp  — right
extern int feed_port;                 // declaration
// config.cpp
int feed_port = 9000;                 // the single definition
// or, header-only:
inline int feed_port = 9000;          // C++17 inline variable: one entity, one address
```

```cpp
// ---- layer 2: identical definitions allowed in many TUs ----------------
// price.hpp
struct Price {                                   // class: define in the header
    long ticks{};
    friend constexpr bool operator==(Price, Price) = default;   // hidden friend
};
inline constexpr Price invalid_price{-1};        // inline variable
inline long clamp_ticks(long t) { return t < 0 ? 0 : t; }       // inline function
template<class T> constexpr T midpoint(T a, T b) { return a + (b - a) / 2; }
```

| Entity | Definitions allowed | Requirement |
|---|---|---|
| Non-`inline` function / variable | exactly 1 in program | odr-used ⇒ must exist |
| `inline` function / variable | 1 per TU | token-identical, same lookup results |
| Class / enum / union | 1 per TU | identical token sequence and meaning |
| Templates (class/function/variable) | 1 per TU | identical; instantiations merged by the linker |
| `constexpr`/`consteval` function | implicitly `inline` | same rules as `inline` |
| Member function defined in-class | implicitly `inline` | same rules |
| Lambda closure type | per TU | in a header, must be the same expression |

```cpp
// ---- silent ODR violation: config-dependent inline definition ----------
// behavior.hpp
inline int mode() {
#ifdef FAST_MODE          // TU A sees it, TU B does not
    return 1;
#else
    return 0;
#endif
}
// Both TUs emit a weak symbol `mode`; the linker keeps ONE arbitrarily.
// Program is ill-formed, NO DIAGNOSTIC REQUIRED. Behavior may flip with -O2.

// Same class, two layouts — the worst version:
struct Book {
#ifdef WITH_STATS
    std::uint64_t hits;        // changes sizeof and every member offset
#endif
    long px;
};
```

```cpp
// ---- odr-use intuition -------------------------------------------------
struct Limits {
    static const int depth = 10;        // pre-C++17 in-class initializer
    static constexpr int width = 8;     // implicitly inline since C++17
};
int a[Limits::depth];                   // constant expression: NOT an odr-use
auto const* p = &Limits::depth;         // takes the address → odr-use
const int Limits::depth;                // pre-C++17 you needed this in a .cpp
void take(int const&);
take(Limits::width);                    // binds a reference → odr-use, fine in C++17

// Rule of thumb: reading the value in a constant expression is not an odr-use;
// needing the object's identity (address / reference binding) is.
```

```bash
# Detecting ODR skew in practice
c++ -fsanitize=address -g ...            # ASan reports odr-violation for globals
c++ -flto ...                            # LTO often surfaces mismatched definitions
gold/lld --detect-odr-violations         # linker-side heuristics
```

**Interview line** — "`inline` primarily grants permission for identical definitions to appear in every TU; it is not a request to inline machine code."

**Traps** — anonymous-namespace entities inside a header create a *different* entity per TU (and inline functions referring to them are ODR-violating) · `static` functions in headers duplicate code and addresses · differing `-D` flags, `-fno-exceptions`, or `_GLIBCXX_DEBUG` across objects is an ODR/ABI violation · a lambda in a header-inline function must be the same expression in every TU.

---

## 1.5 Names, scopes, namespaces, and qualified lookup

```cpp
// ---- scope kinds --------------------------------------------------------
int g;                                   // namespace (global) scope
namespace feed { struct Message { int seq; }; }   // namespace scope
struct S { int m; void f(); };           // class scope (members)
void h(int p) {                          // function parameter scope
    int local = 0;                       // block scope
    { int local = 1; (void)local; }      // inner hides outer
    (void)local;
}
template<class T> struct W { using type = T; };   // template parameter scope
enum class Side { buy, sell };           // enumeration scope (scoped enum)
enum Legacy { a, b };                    // unscoped: enumerators leak to enclosing scope
```

```cpp
// ---- namespace forms ----------------------------------------------------
namespace market { namespace itch { struct AddOrder{}; } }  // classic nesting
namespace market::itch { struct DeleteOrder{}; }            // C++17 nested
namespace market::inline v2 { struct Book{}; }              // C++20 nested inline
namespace api_v2 { void send(); }
inline namespace v3 { void send(); }     // inline namespace: names leak outward (ABI versioning)
namespace api = api_v2;                  // namespace alias
namespace { int tu_private = 0; }        // unnamed: internal linkage, unique per TU
namespace detail { /* convention only — NOT an access boundary */ }
// namespaces may be reopened at any point; they are open sets
```

```cpp
// ---- lookup forms -------------------------------------------------------
feed::Message m{};
feed::decode(m);           // QUALIFIED lookup: only inside feed (and its inline/using set)
decode(m);                 // UNQUALIFIED: ordinary lookup + ADL over feed
::g = 1;                   // global-scope qualification
using feed::Message;       // using-DECLARATION: one name into this scope
using namespace feed;      // using-DIRECTIVE: names visible as if in nearest common ns
using Msg = feed::Message; // alias, unrelated to the above

// two-step swap idiom — the canonical ADL usage
template<class T> void relocate(T& a, T& b) {
    using std::swap;       // fallback
    swap(a, b);            // ADL prefers a namespace-matched swap if one exists
}
```

```cpp
// ---- ADL associated entities (memorize) --------------------------------
// For each argument: its type's namespace + class, base classes, template
// arguments' associated namespaces, enclosing class of a member pointer,
// return/param types of a function pointer. Fundamental types associate nothing.
namespace qs {
    struct Price { long t; };
    void print(Price);                       // found by ADL
    struct Order { friend bool ok(Order) { return true; } };  // HIDDEN FRIEND:
}                                            // only findable via ADL — no ns pollution
qs::Price p{1};
print(p);                                    // OK: ADL
// ok(qs::Order{});                          // OK via ADL; qs::ok(...) is ILL-FORMED

// ADL is disabled when the callee is parenthesized or a variable/lambda:
(print)(p);                                  // ordinary lookup only
```

| Rule | One-liner |
|---|---|
| Name hiding | An inner declaration hides *all* outer overloads of that name; `using Base::f;` restores them. |
| Unnamed namespace | Internal linkage; unique entity per TU; preferred over file-`static`. |
| `using namespace` in a header | Pollutes every includer's lookup — never do it. |
| `inline namespace` | Members are visible in the enclosing namespace; used for ABI/API versioning. |
| Adding to `namespace std` | UB, except explicitly permitted specializations of templates like `std::hash`, `std::formatter` for *user* types. |
| Argument-dependent lookup | Runs only for unqualified *function call* expressions with class/enum arguments. |
| `std::` customization points | `std::ranges::swap`/`begin` etc. are CPOs: niebloids that block plain ADL and do the two-step internally. |

**Traps** — `using namespace std;` at namespace scope collides with `count`, `data`, `distance`, `size` · a `detail` namespace is documentation, not privacy · unscoped enum enumerators leak into the enclosing scope · reopening a namespace with a typo silently creates a new namespace · declaring a function in the *global* namespace defeats hidden-friend encapsulation.

---

## 1.6 Linkage: no linkage, internal, module, and external linkage

```cpp
// ---- namespace scope ----------------------------------------------------
int   x1;                     // external linkage, static storage
extern int x2;                // external linkage, declaration only
static int x3;                // INTERNAL linkage
const int x4 = 1;             // INTERNAL by default (non-template, non-volatile, non-inline)
extern const int x5;          // external (define once with `extern const int x5 = 1;`)
constexpr int x6 = 1;         // const ⇒ internal linkage too
inline int x7 = 1;            // external, exactly one address program-wide (C++17)
inline constexpr int x8 = 1;  // external + constant: THE header-constant idiom
thread_local int x9;          // external linkage, thread storage duration
namespace { int x10; }        // internal linkage, unique per TU
static void helper() {}       // internal linkage function
template<class T> void tf();  // external linkage

// ---- block scope --------------------------------------------------------
void f() {
    int  a;                   // NO linkage, automatic storage
    static int b;             // NO linkage, STATIC storage
    extern int x1;            // redeclares the external-linkage x1
}
struct S { static int m; };   // class member: external linkage, one object
```

| Declaration | Linkage | Storage duration |
|---|---|---|
| `int x;` (ns scope) | external | static |
| `extern int x;` | external | static |
| `static int x;` (ns scope) | internal | static |
| `const int x = 1;` (ns scope) | internal | static |
| `extern const int x = 1;` | external | static |
| `inline int x = 1;` | external (one entity) | static |
| name in unnamed namespace | internal | per declaration |
| `thread_local T t;` | external (unless `static`) | thread |
| local `static int b;` | none | static |
| local `int a;` | none | automatic |
| class member function/`static` data | external | — / static |
| non-exported name in a named module | **module linkage** | — |
| lambda closure type | as the enclosing context | — |

```cpp
// ---- module linkage (C++20) --------------------------------------------
export module qs.feed;
export void decode();      // external linkage, visible to importers
void helper();             // MODULE linkage: visible to this module's units only,
                           // linker-visible symbol, but not nameable by importers
static void tu_only();     // internal linkage as usual
```

```cpp
// ---- language linkage ---------------------------------------------------
extern "C" int decode_packet(void const* data, unsigned long n);  // C mangling/ABI
extern "C" {
    #include <zlib.h>          // older C headers
    int callback(void*);       // NOT overloadable; only one extern "C" `callback`
}
extern "C++" void modern();     // the default
// A function POINTER's language linkage is part of its type on conforming impls:
extern "C" using CCallback = void(*)(void*);
// extern "C" functions may not be overloaded, may be templates' arguments,
// must not let exceptions escape into C frames (use a noexcept boundary).
```

**Interview line** — "Linkage is about *name identity across scopes and TUs*; storage duration is about *when the object exists* — `static` at block scope changes only the latter."

**Traps** — `const` at namespace scope in a header gives each TU its own object (different addresses, duplicated storage) · `static` in a header duplicates state per TU — a "singleton counter" that counts differently everywhere · `extern "C"` does not suppress C++ semantics inside the body · exceptions crossing an `extern "C"` frame with C code between is UB in practice · `inline` variables are the fix, not `#define`.

---

## 1.7 `main`, program startup, termination, and static initialization

```cpp
// ---- the two required forms --------------------------------------------
int main() { return 0; }                 // falling off the end ⇒ return 0;
int main(int argc, char* argv[]) {       // argv[argc] == nullptr; argv[0] may be ""
    for (int i = 0; i < argc; ++i) { (void)argv[i]; }
    return 0;                            // 0 / EXIT_SUCCESS / EXIT_FAILURE
}
// implementations MAY accept more (e.g. char* envp[]) — non-portable.
// main cannot be: called from the program, overloaded, static, inline,
// constexpr, a coroutine, [[noreturn]], or attached to a named module.
```

```cpp
// ---- initialization phases ---------------------------------------------
// 1. STATIC initialization (before any code runs):
//      a) constant initialization where possible,  b) otherwise zero-initialization
// 2. DYNAMIC initialization: unordered / partially-ordered / ordered.
int   z;                                   // zero-initialized
constexpr int c = 4;                       // constant-initialized
constinit int limit = 1024;                // C++20: MUST be constant-initialized, still mutable
int   d = std::atoi("7");                  // dynamic initialization
inline int inl = compute();                // UNORDERED dynamic init (like templates)
thread_local Counter tc{};                 // per-thread; may be lazy on first odr-use

// within ONE TU, ordered dynamic initialization follows definition order;
// ACROSS TUs the order is unspecified.
```

```cpp
// ---- static initialization order fiasco --------------------------------
// logger.cpp
Logger global_logger{};
// engine.cpp
Engine global_engine{global_logger};   // may run BEFORE global_logger is built

// Fix 1: lazy function-local static — thread-safe init since C++11
Logger& logger() { static Logger instance{}; return instance; }   // magic static
// Fix 2 (preferred): explicit ownership from main
int main() {
    Logger logger{};
    Engine engine{logger};
    return engine.run();
}                                      // engine destroyed BEFORE logger — reverse order
// Fix 3: make it constant-initialized so there is no dynamic phase at all
constinit inline std::atomic<int> counter{0};
```

```cpp
// ---- constinit / constexpr / consteval ---------------------------------
constinit int packet_limit = 1024;        // static/thread storage only; no dynamic init
constexpr int header_size  = 16;          // implies const; usable in constant expressions
consteval int checked(int n) {            // IMMEDIATE function: every call is compile-time
    return n > 0 ? n : throw "bad size";
}
constexpr int f(int n) { return n * 2; }  // may run at compile OR run time
static_assert(checked(4) == 4);
// int r = checked(runtime_n);            // error: argument not a constant expression
if consteval { /* C++23 */ } else { }     // detect immediate context
```

```cpp
// ---- termination paths ---------------------------------------------------
#include <cstdlib>
std::atexit([]{ /* LIFO, after main returns or exit() */ });
std::at_quick_exit([]{ });
std::exit(0);        // no unwinding of the current stack; runs static dtors + atexit
std::quick_exit(0);  // no unwinding, no static dtors; runs at_quick_exit handlers
std::_Exit(0);       // immediate; nothing runs
std::abort();        // SIGABRT; no cleanup
std::terminate();    // calls the current terminate_handler (default: abort)
```

| Mechanism | Unwinds locals? | Static dtors / `atexit`? |
|---|---|---|
| `return` from `main` | yes (main's locals) | yes |
| `std::exit(n)` | **no** | yes |
| `std::quick_exit(n)` | no | only `at_quick_exit` |
| `std::_Exit(n)` | no | no |
| `std::abort()` | no | no |
| uncaught exception | implementation-defined whether unwinding happens | `std::terminate` → no |
| `throw` from a static initializer | — | `std::terminate` |

| Storage duration | Declaration | Lifetime |
|---|---|---|
| automatic | `void f(){ Quote q; }` | block entry → block exit (reverse-order destruction) |
| static | namespace object, local `static`, class `static` | first init → after `main`/`exit`, reverse of completion order |
| thread | `thread_local T t;` | thread start (or first use) → thread exit |
| dynamic | `new T`, allocators, placement `new` | explicit, or owned by RAII |

**Traps** — a local `static` costs a guard-variable check on every call (usually a predictable load) and can deadlock if its constructor reentrantly calls the same function · `std::exit` from a thread while another holds a lock during static destruction races · registering `atexit` handlers that touch already-destroyed statics is the classic "static destruction order fiasco" · `constinit` does *not* imply `const` · dynamic initialization of a namespace-scope `std::string`/`std::map` allocates before `main`.

---

## 1.8 Include guards, `#pragma once`, forward declarations, and incomplete types

```cpp
// ---- portable include guard ---------------------------------------------
#ifndef QS_FEED_DECODER_HPP_INCLUDED     // unique: project_dir_file_HPP
#define QS_FEED_DECODER_HPP_INCLUDED
// ... declarations ...
#endif // QS_FEED_DECODER_HPP_INCLUDED

// ---- non-standard but universal ------------------------------------------
#pragma once                              // identity by file, not by macro
```

```cpp
// ---- a self-contained header ---------------------------------------------
// decoder.hpp
#pragma once
#include <cstddef>          // include what you USE: std::byte
#include <span>             // std::span
#include <cstdint>

namespace feed {

struct Message;             // forward declaration: only pointers/refs used below

class Decoder {
public:
    Decoder() noexcept;
    [[nodiscard]] bool decode(std::span<std::byte const> in, Message& out) const;
private:
    std::uint64_t seq_{};
};

}  // namespace feed
```

**Header checklist** (each is one rule)
- Self-contained: compiles when included first, alone.
- Include what it uses; never lean on transitive includes.
- No `using namespace` at namespace scope; no unqualified `using` of std names.
- No non-`inline` function or variable definitions.
- No configuration-dependent (`#ifdef`-varying) inline/class definitions.
- `#undef` any private macro it had to define.
- Expose complete types only where the interface genuinely needs them.
- State ownership, lifetime, and exception behavior in the declarations.
- Prefer `inline constexpr` for constants and hidden friends for operators.

| Forward declare when | Include the header when |
|---|---|
| pointer or reference members/parameters | by-value member, base class, or return-by-value that is called |
| `std::unique_ptr<T>` member + out-of-line dtor | `sizeof(T)`, `alignof(T)`, member access, `new`/`delete T` |
| declaring functions you do not define | instantiating a template on `T` that needs completeness |
| breaking a header cycle | `T` is an enum without a fixed underlying type |

```cpp
// ---- what you may NOT forward declare -----------------------------------
// namespace std { class string; }       // UB: declaring in std
#include <iosfwd>                         // the sanctioned std forward declarations
enum class Side : std::uint8_t;           // OK: fixed underlying type
// enum Legacy;                           // ill-formed: unfixed underlying type
template<class T> class Ring;             // OK for class templates
// forward declaring an alias template's target does not help
```

**Traps** — a forward declaration hard-codes the entity's *kind* and *namespace*; a later change from `class` to a type alias breaks every declarer · `#pragma once` can duplicate under symlinks, bind mounts, or two include paths reaching the same file · a guard macro copy-pasted between headers silently empties one of them · guards prevent re-inclusion, not ODR errors · including a header inside a namespace nests every declaration in it.

---

## 1.9 Headers versus C++20 modules and header units

```cpp
// ---- price.cppm — module interface unit ---------------------------------
module;                          // global module fragment: for #includes only
#include <cstdint>
export module qs.price;          // module declaration

import std;                      // C++23 standard-library module (std.compat also)
export import qs.types;          // re-export another module's interface

export namespace qs {
class Price {
public:
    explicit constexpr Price(std::int64_t t) noexcept : ticks_{t} {}
    [[nodiscard]] constexpr std::int64_t ticks() const noexcept { return ticks_; }
private:
    std::int64_t ticks_;
};
[[nodiscard]] Price midpoint(Price, Price) noexcept;
}                                // everything above is exported

namespace qs { int internal_helper(); }   // NOT exported: module linkage
```

```cpp
// ---- price.impl.cpp — module implementation unit -------------------------
module qs.price;                 // no `export` keyword
namespace qs {
Price midpoint(Price a, Price b) noexcept {
    return Price{a.ticks() + (b.ticks() - a.ticks()) / 2};   // overflow-safe
}
}
```

```cpp
// ---- partitions ----------------------------------------------------------
export module qs.price:math;     // interface partition
module qs.price:detail;          // implementation partition (not exported)
export module qs.price;
export import :math;             // partitions are internal to the module name
import :detail;
```

```cpp
// ---- consumer -------------------------------------------------------------
import qs.price;                 // named module
import <vector>;                 // HEADER UNIT: macros ARE exported, header semantics kept
#include <cstdio>                // still legal alongside modules
int main() { return qs::midpoint(qs::Price{2}, qs::Price{4}).ticks() == 3 ? 0 : 1; }
```

```bash
# GCC
g++ -std=c++23 -fmodules-ts -c price.cppm -o price.o
# Clang
clang++ -std=c++23 --precompile price.cppm -o qs.price.pcm
clang++ -std=c++23 -fmodule-file=qs.price=qs.price.pcm -c main.cpp
# MSVC
cl /std:c++latest /interface /TP price.ixx
# CMake 3.28+
#   target_sources(app PUBLIC FILE_SET CXX_MODULES FILES price.cppm)
```

| Header model | Named module model |
|---|---|
| Text re-included and re-parsed per TU | Interface built once, imported as a binary artifact |
| Macros flow in and out freely | Macros are **not** exported (header units are the exception) |
| Include order can change meaning | Import order is irrelevant |
| Guards/`#pragma once` needed | Not needed |
| Internal helpers leak unless in unnamed ns | Non-exported names get module linkage |
| Templates re-instantiated per TU | Toolchain can reuse the compiled interface |
| Universally supported | Build-system support required; must scan for dependencies |

- Module units of the same module must be compiled in dependency order — the build system needs a *scanning* step (`clang-scan-deps`, CMake's dyndep).
- Modules change nothing about linking, ABI, name mangling requirements, or instantiation cost at run time.
- A **header unit** (`import <vector>;`) wraps an existing header in module machinery: it exports macros and preserves header semantics; distinct from a named module.
- `import std;` (C++23) replaces dozens of `#include`s; `import std.compat;` adds the C library names in the global namespace.

**Interview line** — "Modules replace textual inclusion with an importable interface; they improve build hygiene and throughput, not run-time speed."

**Traps** — `#include` inside a module *purview* (after `export module`) is ill-formed for most headers; put it in the global module fragment · exporting a name whose type is not exported is an error · ODR still applies across module and non-module code · mixing a header-included and module-imported copy of the same entity is an ODR violation.

---

## 1.10 Language modes, feature-test macros, hosted versus freestanding C++

```cpp
#include <version>              // ALL __cpp_lib_* macros, no other content

#if __cplusplus >= 202302L      // C++23 (MSVC needs /Zc:__cplusplus)
#endif
#if defined(__cpp_lib_expected) && __cpp_lib_expected >= 202202L
  #include <expected>
  using Result = std::expected<int, Error>;
#else
  #error "component requires std::expected"
#endif
#if __cpp_if_consteval >= 202106L      // core feature-test macro
#endif
#if __has_include(<memory_resource>)   // C++17 availability probe
  #include <memory_resource>
#endif
#if __has_cpp_attribute(assume) >= 202207L   // C++23
  #define QS_ASSUME(x) [[assume(x)]]
#else
  #define QS_ASSUME(x) ((void)0)
#endif
```

| Macro family | Meaning |
|---|---|
| `__cplusplus` | `199711L` / `201103L` / `201402L` / `201703L` / `202002L` / `202302L` — the *mode*, not full support. |
| `__cpp_<feature>` | Core-language feature test, always defined when supported (e.g. `__cpp_concepts`, `__cpp_consteval`, `__cpp_modules`, `__cpp_deducing_this`). |
| `__cpp_lib_<feature>` | Library feature test, surfaced by `<version>` and the owning header. |
| `__has_include(x)` / `__has_cpp_attribute(x)` | Preprocessor availability probes. |
| `__GNUC__`, `_MSC_VER`, `__clang__`, `_LIBCPP_VERSION`, `__GLIBCXX__` | Implementation identity — non-portable, last resort. |
| `__STDC_HOSTED__` | `1` hosted, `0` freestanding. |

```bash
c++ -std=c++23 -Wall -Wextra -Wpedantic -Werror        # language mode + hygiene
c++ -std=c++23 -fno-exceptions -fno-rtti               # ABI-affecting: must be global
c++ -march=native -O3 -flto -fno-omit-frame-pointer    # perf build
c++ -D_GLIBCXX_ASSERTIONS  /  -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST
c++ -fvisibility=hidden -fvisibility-inlines-hidden    # smaller/faster DSOs
```

- **Must match across every binary boundary**: standard-library implementation and version, `-fno-exceptions`/`-fno-rtti`, debug-iterator and hardening macros, struct-packing pragmas, `-D` macros that alter class layout or inline bodies, and the exception/personality model.
- **Hosted** (`__STDC_HOSTED__ == 1`): the full library is available; `main` is the entry point; this is what a Linux HFT process is, even when it avoids `<iostream>` on hot paths.
- **Freestanding**: a defined subset is guaranteed (`<cstddef>`, `<limits>`, `<type_traits>`, `<concepts>`, `<bit>`, `<atomic>`, `<coroutine>`, `<ratio>`, `<initializer_list>`, …); C++23 (P1642) enlarged the subset and added `// freestanding` marking; the entry point need not be `main`.
- "Freestanding" ≠ "no standard library" and ≠ "embedded only" — check the specific facility and implementation.

**Interview line** — "Test the feature, not the compiler: `#if defined(__cpp_lib_expected)` is a promise; `_MSC_VER >= 1930` is a guess."

**Traps** — `__cplusplus` reports `199711L` on MSVC without `/Zc:__cplusplus` · library feature macros live in `<version>` *and* their own header, so probing before any include fails · a feature-test macro says "implemented", not "bug-free" · mixing translation units built with different `-std` values is legal but mixing different `_GLIBCXX_DEBUG` settings is not.

---

**Recall card**

```text
TU               = one source file after preprocessing
declaration      = introduces name + type info;  definition = supplies the entity
ODR              = one definition program-wide; identical inline/template/class
                   definitions may repeat per TU (IFNDR if they differ)
inline           = ODR permission, not an optimizer directive
linkage          = none | internal | module | external   (≠ storage duration)
storage duration = automatic | static | thread | dynamic
static           = internal linkage (ns) | static storage (block) | per-class (member)
init order       = constant → zero → dynamic; cross-TU dynamic order UNSPECIFIED
fixes            = constinit · function-local static · ownership from main
header           = self-contained, includes what it uses, no non-inline definitions
module           = importable interface; linking, ABI, and instantiation still exist
feature tests    = __cpp_* / __cpp_lib_* via <version>, not compiler versions
```
