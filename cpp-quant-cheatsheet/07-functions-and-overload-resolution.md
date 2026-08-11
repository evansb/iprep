# 7. Functions and overload resolution

*Part I — Language foundations*

---

**Recall**
- Overload resolution is pure compile-time selection among declarations — it is not runtime dispatch, and the destination type never picks the overload.
- Pipeline: name lookup (+ ADL) → candidate set → deduction/constraints → viable set → rank conversion sequences → unique best → access/deleted check.
- A candidate is *viable* when every parameter can be initialized from an argument and every missing argument has a default.
- Conversion ranks, best to worst: exact match → promotion → conversion → user-defined conversion → ellipsis.
- At most **one** user-defined conversion per implicit conversion sequence; a standard conversion may sit on each side of it.
- Ambiguity arises when two candidates each win on a different argument — no candidate is better on *every* argument and strictly better on one.
- Return type, parameter names, default arguments, top-level parameter `cv`, and `noexcept` alone cannot form an overload; parameter types, member cv/ref-qualifiers, and constraints can.
- Array and function parameter types decay in declarations: `T p[64]` *is* `T*`, `void f()` param *is* `void(*)()`.
- Non-template beats template on an otherwise-equal tie; between templates, the more specialized (or more constrained, C++20) wins.
- Parameter form is an ownership contract: `T` owns, `T&`/`T*` borrows, `span`/`string_view` views without extending any lifetime.
- A named rvalue-reference parameter is an **lvalue** inside the body — you must `std::move` it again to move from it.
- `std::move` only casts to xvalue; `std::forward<T>` conditionally casts and is only correct on a deduced `T&&`.
- Default arguments are substituted at the call site from declarations visible there; on virtuals they come from the **static** type while the body comes from the dynamic type.
- `inline` is an ODR facility (repeated definitions, one address), never a machine-code-inlining command.
- `constexpr` = *may* run at compile time; `consteval` = every evaluated call *must* be constant; `constinit` = static initialization, not constness.
- `noexcept` escape ⇒ `std::terminate`; the conditional form `noexcept(noexcept(expr))` composes contracts mechanically.
- C++17 guarantees elision for same-type prvalue initialization — no copy/move ctor need even exist; NRVO for a named local stays optional.
- `return std::move(local)` blocks NRVO and downgrades a free elision into a real move.
- C varargs rank last, require default argument promotions, and are UB for mismatched `va_arg` types.
- Neither tail-call elimination nor inlining is guaranteed — bound recursion depth explicitly on untrusted input.

---

## 7.1 Function declarations, definitions, signatures, and return types

```cpp
#include <cstdint>
#include <span>
#include <ranges>

// ---- declaration forms -------------------------------------------------
long midpoint(long bid, long ask) noexcept;                    // leading return type
auto midpoint2(long bid, long ask) noexcept -> long;           // trailing return type
[[nodiscard]] auto fee(long qty) noexcept -> long;             // C++17 attribute
extern "C" int c_abi_entry(int);                               // C linkage, no mangling
static long helper(long);            // internal linkage (TU-local)
inline long shared(long);            // ODR-safe repeated definition in headers
constexpr long twice(long x) { return 2 * x; }                 // implicitly inline

long midpoint(long bid, long ask) noexcept {                   // definition
    return bid + (ask - bid) / 2;                              // no overflow on sum
}

// ---- parameter type adjustments (the declared type is NOT what you wrote)
void decode(std::byte bytes[64]);      // adjusted to std::byte*
void decode(std::byte* bytes);         // SAME function — redeclaration, not overload
void invoke(void callback());          // adjusted to void (*)()
void invoke(void (*callback)());       // SAME function
void take(const int x);                // top-level const on param is IGNORED
void take(int x);                      // SAME function — but only ONE may define it

// ---- keeping the extent -------------------------------------------------
template<std::size_t N>
void validate(std::byte const (&packet)[N]);      // reference-to-array: N deduced
void validate(std::span<std::byte const, 64>);    // static extent in the type
void validate(std::span<std::byte const>);        // dynamic extent

// ---- unnamed / defaulted-out parameters ---------------------------------
void on_tick(Tick const&, int /*unused_venue*/) {}   // name omitted = intentionally unused
```

```cpp
// ---- return-type deduction ---------------------------------------------
auto twice_(int x)          { return x * 2; }       // deduced int (template rules)
auto ref_drop(int& x)       { return x; }           // int  — top-level ref/cv DROPPED
auto&& keep(int& x)         { return x; }           // int& — forwarding-ref return
decltype(auto) exact(int& x){ return x; }           // int&  (id-expression → its type)
decltype(auto) paren(int& x){ return (x); }         // int&  (parenthesized lvalue)
decltype(auto) val(int x)   { return x; }           // int
auto late(int x) -> decltype(x * 2);                // trailing: params in scope
// auto bad(bool b){ if(b) return 1; return 2.0; }  // ill-formed: conflicting deductions
auto recurse(int n) -> int { return n ? recurse(n-1) : 0; }  // deduction needs a seen return

// ---- multiple returns must deduce the SAME type -------------------------
auto ok(bool b) { if (b) return 1; return 2; }       // both int — fine
```

| Difference between two declarations | Distinct overload? | Note |
|---|---|---|
| Parameter types / count | **yes** | includes reference-binding distinctions (`T&` vs `T&&`) |
| Member `const` / `volatile` | **yes** | qualifies the implicit object parameter |
| Member ref-qualifier `&` / `&&` | **yes** | selects lvalue vs rvalue objects |
| Template parameter list / constraints | **yes** | constraint subsumption participates in ordering |
| Return type only | no | `int f(); double f();` is ill-formed |
| Parameter names | no | not part of the type |
| Default arguments | no | belong to declarations, not the function type |
| Top-level parameter `cv` | no | `f(int)` and `f(const int)` are one function |
| `noexcept` only | no | part of the *type* since C++17, still not an overload discriminator |
| `T[]` vs `T*`, `F()` vs `F(*)()` | no | parameter adjustment makes them identical |

| Return spelling | Deduces | Can return a reference? |
|---|---|---|
| `auto` | template-deduction rules (decays) | no |
| `auto&` / `auto&&` | reference to the operand | yes |
| `decltype(auto)` | `decltype(return-expr)` | **yes — accidentally** |
| `-> T` trailing | exactly `T` | yes |

**Traps** — `decltype(auto)` + `return (local);` returns a dangling `T&` · `auto` silently strips `const`/`&` from a member getter · a declaration with `T p[64]` promises nothing about size · redeclaring with different top-level `const` is not an overload, it is a duplicate · `[[nodiscard]]` on the *declaration* is what clients see.

---

## 7.2 Pass by value, reference, pointer, and view

```cpp
struct OrderId { std::uint64_t value; };

void cancel(OrderId id);                          // small trivially-copyable → by value
void update(Book& book);                          // required, mutable
void inspect(Book const& book);                   // required, read-only, no copy
void maybe_trace(TraceSink const* sink);          // NULL is meaningful = "disabled"
void normalize(std::span<std::byte const> wire);  // non-owning contiguous bytes
void log(std::string_view msg);                   // non-owning chars, may NOT be NUL-terminated
void consume(Buffer&& buf);                       // sink: caller yields ownership

template<class T> void generic(T&& x) {           // forwarding reference (deduced T only)
    sink(std::forward<T>(x));                     // preserves value category
}
```

| Form | Contract communicated | Cost / risk |
|---|---|---|
| `T` | callee owns an independent value | copy or move at the boundary; ideal for small values + sinks |
| `T const&` | required, non-owning, read-only | no copy; indirection + aliasing; must not outlive referent |
| `T&` | required mutable borrow | visible mutation, aliasing hazard |
| `T const*` | optional read-only observation | null check required; lifetime external |
| `T*` | optional mutable observation | null + mutation + lifetime contract |
| `std::span<T>` / `<T const>` | non-owning contiguous range | ptr+size (or ptr for static extent); no lifetime extension |
| `std::string_view` | non-owning character sequence | not necessarily NUL-terminated; trivially danglable |
| `T&&` (non-template) | sink / expiring object | binds only to rvalues; does **not** itself move |
| `T&&` (deduced `T`) | forwarding reference | binds to everything; needs `std::forward` |
| `std::function<Sig>` | type-erased callable | allocation + indirect call — avoid in hot paths |
| template / `auto` param | monomorphized, inlinable callable | code bloat; no ABI stability |

```cpp
// ---- sink-by-value idiom ------------------------------------------------
class Session {
public:
    explicit Session(std::string venue) : venue_{std::move(venue)} {}
    //  lvalue arg : 1 copy  + 1 move
    //  rvalue arg : 1 move  + 1 move
private:
    std::string venue_;
};

// ---- the two-overload alternative (one fewer move, twice the API) -------
class Session2 {
public:
    explicit Session2(std::string const& v) : venue_{v} {}            // 1 copy
    explicit Session2(std::string&& v) : venue_{std::move(v)} {}      // 1 move
private:
    std::string venue_;
};
// 2^n overloads for n parameters — use sink-by-value unless measured.
```

```cpp
// ---- forwarding-reference greediness ------------------------------------
struct Widget {
    template<class T> Widget(T&& name);      // beats Widget(Widget const&) for a NON-const lvalue!
    Widget(Widget const&);
};
Widget w1{/*...*/};
// Widget w2{w1};   // picks the TEMPLATE (exact match Widget&), not the copy ctor
// Fix: constrain it.
struct Widget2 {
    template<class T>
        requires (!std::same_as<std::remove_cvref_t<T>, Widget2>)
    Widget2(T&& name);
    Widget2(Widget2 const&);
};
```

```cpp
// ---- named rvalue reference is an LVALUE --------------------------------
void sink(Order&& order) {
    consume(order);              // copies! `order` is a named lvalue here
    consume(std::move(order));   // moves — explicit re-cast required
}

// ---- dangling views -----------------------------------------------------
std::string_view bad() {
    std::string local = "ABC";
    return local;                             // dangles at return
}
auto sv = std::string_view{std::string{"ABC"}};   // dangles at the semicolon
std::span<int const> s = std::vector<int>{1,2,3}; // dangles at the semicolon
void ok(std::string_view v);  ok(std::string{"ABC"});  // FINE: temp outlives the call
```

**Interview line** — "`span` and `string_view` describe *shape*, never *ownership*; they never extend a lifetime, so passing them down is safe and storing them is a contract you must enforce."

**Traps** — `const&` on a small trivial type adds an indirection the optimizer may not remove · `string_view` handed to a C API that wants NUL-termination · unconstrained `T&&` ctor hijacking copies · `T&&` parameter used twice after being moved-from · `std::span<T>` (mutable) silently accepts a `const` element source only if you wrote `T const`.

---

## 7.3 Default arguments and variadic C-style arguments

```cpp
// ---- defaults ----------------------------------------------------------
void connect(int port, int retries = 3, int timeout_ms = 250);
void start() { connect(9000); }             // as if connect(9000, 3, 250)

// right-to-left: once a parameter has a default, all later ones must too
// void bad(int a = 1, int b);              // ill-formed

// a later declaration in the SAME scope may add defaults for earlier params
void listen(int port, int backlog);
void listen(int port, int backlog = 128);   // OK: adds one
// void listen(int port, int backlog = 64); // ill-formed: redefinition of a default
void listen(int port = 0, int backlog);     // OK now: backlog already has one

// evaluated at each CALL, in the caller's context
int next_id();
void enqueue(int id = next_id());           // next_id() runs per call

// defaults may use earlier parameters? NO — only globals/statics/constants
// void f(int a, int b = a);                // ill-formed
struct S { int n = 4; void m(int k = n); }; // OK inside a class: member allowed

// inner-scope redeclaration does NOT inherit defaults
void g(int x = 1);
void caller() { void g(int x); /* g(); */ }  // ill-formed here: no default in scope

// ---- virtual defaults come from the STATIC type -------------------------
struct Base { virtual int poll(int batch = 8)  { return batch; } };
struct Fast : Base { int poll(int batch = 64) override { return batch; } };
Fast fast; Base& b = fast;
assert(b.poll()    == 8);    // Fast::poll body, Base's default
assert(fast.poll() == 64);
```

```cpp
// ---- C-style ellipsis ---------------------------------------------------
#include <cstdarg>
int sum_ints(int count, ...) {              // at least one named param needed pre-C++26
    std::va_list ap;
    va_start(ap, count);                    // (C++23 allows va_start(ap) with no anchor)
    int sum = 0;
    for (int i = 0; i < count; ++i) sum += va_arg(ap, int);   // type MUST match exactly
    va_end(ap);                             // mandatory
    return sum;
}
int log_fields(char const* fmt, ...);
// __attribute__((format(printf,1,2)))      // GCC/Clang: get real checking
```

| Default argument promotion applied to `...` args | Result |
|---|---|
| `float` | `double` |
| `bool`, `char`, `signed/unsigned char`, `short`, enum with small underlying type | integral promotion → `int` |
| arrays / functions | decay to pointers |
| non-trivially-copyable class type | **conditionally supported**, commonly UB |

```cpp
// ---- the C++ replacements ----------------------------------------------
template<class... Ts> int sum(Ts... xs) { return (0 + ... + xs); }      // variadic template
void logf(std::format_string<int, double> f, int a, double b);          // C++20 typed format
void batch(std::span<int const> xs);                                    // contiguous run
void batch(std::initializer_list<int> xs);                              // brace list
```

**Traps** — defaults baked into client TUs: changing one requires recompiling every caller (ABI/API hazard) · `va_arg(ap, float)` is UB (it was promoted to `double`) · passing `std::string` through `...` · ellipsis candidates rank *worst*, so `f(...)` is a fallback overload only · a default expression evaluated per call can hide allocation.

---

## 7.4 Function overloading and viable/best candidate selection

```text
f(args...)
  1. name lookup            ordinary unqualified lookup + ADL (unless qualified /
                            parenthesized / a declared block-scope-only name)
  2. candidate set          all found declarations; member calls gain an implicit
                            object argument; surrogate call fns for conversion-to-fnptr
  3. deduction/constraints  template args deduced; unsatisfied constraint → removed
                            (SFINAE: substitution failure in the immediate context)
  4. viability              every param initializable from its arg;
                            arity matches after defaults / packs / ellipsis
  5. ranking                per-argument implicit conversion sequence comparison
  6. best                   F beats G iff ICS(F,i) is not worse than ICS(G,i) for ALL i
                            and strictly better for at least one i
  7. tie-breakers           non-template > template; more-specialized template;
                            more-constrained (C++20); non-ellipsis; return-type of
                            conversion-function; non-reversed operator (C++20)
  8. checks                 access control, deleted status, explicit-ness
```

```cpp
// ---- exact match wins ---------------------------------------------------
void on(long);
void on(double);
on(1L);    // on(long)   — exact
on(1.0);   // on(double) — exact
// on(1);  // AMBIGUOUS: int→long and int→double are both rank "conversion"
on(static_cast<long>(1));   // disambiguate at the call site

// ---- cross-argument ambiguity -------------------------------------------
void route(int, double);
void route(double, int);
// route(1, 1);   // ambiguous: each wins one argument, neither wins both
route(1, 1.0);    // route(int, double)

// ---- non-template beats template on a tie -------------------------------
void h(int);                        // #1
template<class T> void h(T);        // #2
h(0);        // #1 (both exact; non-template preferred)
h<int>(0);   // #2 forced
h(0.0);      // #2 with T=double (exact) beats #1's double→int conversion

// ---- more-specialized template wins -------------------------------------
template<class T> void p(T*);       // more specialized
template<class T> void p(T);
int* q{}; p(q);                     // p(T*)

// ---- more-constrained wins (C++20) --------------------------------------
template<class T> void alg(T);                                  // #A
template<std::integral T> void alg(T);                          // #B subsumes #A
template<class T> requires std::integral<T> && (sizeof(T)>2)
void alg(T);                                                    // #C subsumes #B
alg(1);                             // #C
```

```cpp
// ---- ADL: the lookup step people forget ---------------------------------
namespace mkt {
    struct Tick { int px; };
    void publish(Tick const&);              // found by ADL from the argument's namespace
}
void demo(mkt::Tick t) {
    publish(t);                             // OK — ADL on mkt::Tick
    // (publish)(t);                        // parenthesized name → NO ADL → error
}
using std::swap;                            // the two-step: enable ADL, keep a fallback
swap(a, b);
```

```cpp
// ---- member overload sets: cv- and ref-qualifiers ------------------------
class Book {
public:
    Level&       top()       &  { return top_; }   // non-const lvalue object
    Level const& top() const &  { return top_; }   // const lvalue object
    Level        top()       && { return std::move(top_); }  // rvalue object: steal
    // Level top() const;  // ill-formed with the & versions: cannot mix
private:
    Level top_;
};
Book bk;  bk.top();                 // Level&
Book const cb{}; cb.top();          // Level const&
Book{}.top();                       // Level (moved out)

// ---- C++23 explicit object parameter ("deducing this") -------------------
struct Log {
    template<class Self>
    auto&& msg(this Self&& self) { return std::forward<Self>(self).msg_; }  // one body, 4 overloads
    std::string msg_;
};
```

```cpp
// ---- hiding: derived names hide the ENTIRE base overload set ------------
struct B { void f(int); void f(double); };
struct D : B { void f(char*); };
D d;
// d.f(1);              // error: B::f hidden by D::f
struct D2 : B { using B::f; void f(char*); };   // fix: re-export
```

| Step | What removes a candidate |
|---|---|
| Lookup | not visible / hidden by a nearer declaration / qualified call suppresses ADL |
| Deduction | deduction failure, or substitution failure in the immediate context (SFINAE) |
| Constraints | unsatisfied `requires` / concept |
| Viability | wrong arity with no defaults, or a parameter not initializable |
| Ranking | strictly worse conversion on some argument |
| Post-selection | inaccessible (private/protected), `= delete`, or `explicit` in a copy-init context |

**Traps** — `explicit` errors surface *after* selection, so an explicit ctor still wins and then fails · access control is checked last, so a `private` best-match is an error rather than a fallback · a derived-class member hides all same-named base members · SFINAE only applies in the immediate context; an error inside an instantiated body is a hard error · `0` is an `int`, not a pointer — use `nullptr`.

---

## 7.5 Standard, user-defined, and ellipsis conversion ranking

```text
IMPLICIT CONVERSION SEQUENCE kinds (whole-sequence rank, best → worst)
  standard conversion sequence
  user-defined conversion sequence   (standard? → user conv → standard?)
  ellipsis conversion sequence

STANDARD conversion sequence rank
  Exact Match    identity · lvalue-to-rvalue · array-to-pointer · function-to-pointer
                 · qualification adjustment (adds const/volatile)
  Promotion      char/short/bool/enum → int · float → double
  Conversion     int↔double · int→long · derived*→base* · T*→void* · anything→bool
                 · enum→int(scoped: NO) · nullptr_t→T* · int→unscoped-enum(NO)
```

```cpp
// ---- rank demonstrations -------------------------------------------------
void r(int);      void r(double);
r('a');           // r(int)    — promotion beats conversion
r(3.0f);          // r(double) — promotion float→double beats conversion float→int
r(true);          // r(int)    — bool promotes to int

void b(bool);     void b(std::string);
// b("literal");  // b(bool)!  char const* → bool is a standard CONVERSION,
                  //           char const* → std::string is USER-DEFINED (worse rank)

void v(void*);    void v(bool);
int* ip{};
v(ip);            // AMBIGUOUS-ish by rank: both are "conversion" → ill-formed on many
                  // sets; add void v(int*) for an exact match.
```

```cpp
// ---- exactly one user-defined conversion ---------------------------------
struct Price {
    Price(long);                       // converting ctor  (user-defined)
    operator double() const;           // conversion function (user-defined)
};
void use(Price);
use(42L);          // long → Price : ONE user-defined conversion — OK
// use(42);        // int → long (standard) → Price (user) : still ONE user-defined — OK
struct Wrapper { Wrapper(Price); };
void take(Wrapper);
// take(42L);      // long → Price → Wrapper : TWO user-defined — ill-formed
take(Price{42L});  // spell one of them

// ---- explicit blocks implicit use ---------------------------------------
struct Qty { explicit Qty(int); };
void q(Qty);
// q(5);           // error: copy-initialization cannot use an explicit ctor
q(Qty{5});         // direct-initialization is fine
struct Flag { explicit operator bool() const; };
Flag f;
if (f) {}          // OK — contextual conversion to bool allows explicit
// bool z = f;     // error
```

```cpp
// ---- reference binding participates in ranking ---------------------------
void inspect(Order&);        // #1 non-const lvalue
void inspect(Order const&);  // #2 const lvalue OR temporary
void inspect(Order&&);       // #3 xvalue/prvalue
Order o; Order const co{};
inspect(o);              // #1  (#2 viable but binding a non-const lvalue to const& is worse)
inspect(co);             // #2
inspect(std::move(o));   // #3  (#2 also viable; rvalue-ref binding wins)
inspect(Order{});        // #3
// const& is the universal fallback — it binds to EVERYTHING.

// A const& parameter binding a temporary extends the temporary to the end of
// the full-expression only (not beyond the call).
```

| Standard-sequence tie-breakers (both same rank) | Better is |
|---|---|
| One sequence is a proper subsequence of the other | the shorter one |
| Both convert pointers/refs through a class hierarchy | the shorter derived→base distance |
| Qualification conversion differs only in added cv | fewer added cv-qualifiers |
| `T&` vs `T const&` binding a non-const lvalue | `T&` |
| `T&&` vs `T const&` binding an rvalue | `T&&` |
| Both are user-defined sequences | comparable **only** if they use the *same* conversion function/ctor |
| One is `bool` conversion from pointer/pointer-to-member | the other (bool conversion is deprioritized in some contexts, still rank "conversion") |

```cpp
// ---- list-initialization ranks differently -------------------------------
void L(std::initializer_list<int>);   // #1
void L(int, int);                     // #2
L({1, 2});     // #1 — a braced list prefers an initializer_list parameter
L(1, 2);       // #2
// Narrowing inside braces is an ERROR, not a conversion:
// void n(int); n({3.5});   // ill-formed: double→int narrowing in a braced list
```

**Traps** — `const char*` → `bool` beating `→ std::string` is the classic overload bug · scoped `enum class` never implicitly converts to `int` · `0`/`NULL` matching an integer overload instead of a pointer one · a converting ctor left non-`explicit` opens a silent conversion path · two user-defined conversions never chain implicitly · `std::string_view`↔`std::string` conversions are asymmetric (`string`→`view` is implicit, `view`→`string` is explicit).

---

## 7.6 Deleted functions and explicitly defaulted functions

```cpp
// ---- delete participates in resolution, then errors ---------------------
void submit(std::uint64_t id);
void submit(bool) = delete;                 // reject the bool trap precisely
submit(42ULL);
// submit(true);        // error: best candidate is deleted (NOT a fallback to uint64_t)

// ---- delete-everything-else pattern -------------------------------------
void exact_only(int);
template<class T> void exact_only(T) = delete;      // any other type: hard error
// C++23: a reason string
void legacy(int) = delete("use submit(std::uint64_t) instead");

// ---- suppressing copies / moves ----------------------------------------
struct NonCopyable {
    NonCopyable() = default;
    NonCopyable(NonCopyable const&)            = delete;
    NonCopyable& operator=(NonCopyable const&) = delete;
    NonCopyable(NonCopyable&&)                 = default;   // move-only
    NonCopyable& operator=(NonCopyable&&)      = default;
};
struct NoHeap { static void* operator new(std::size_t) = delete; };
struct NoTemp { NoTemp(int&&) = delete; NoTemp(int const&); };  // ban rvalue binding

// ---- explicit defaulting ------------------------------------------------
struct Sequence {
    Sequence() = default;                              // trivial, user-DECLARED
    Sequence(Sequence const&) = default;               // on first decl → not user-provided
    Sequence& operator=(Sequence const&) = default;
    Sequence(Sequence&&) noexcept = default;
    Sequence& operator=(Sequence&&) noexcept = default;
    ~Sequence() = default;
    bool operator==(Sequence const&) const = default;              // C++20 memberwise ==
    auto operator<=>(Sequence const&) const = default;             // C++20 memberwise <=>
    std::uint64_t n{};
};

// defaulted-OUT-of-class = user-provided → NOT trivial
struct Late { Late(); };
Late::Late() = default;                 // Late is no longer trivially default-constructible
```

| Situation | Effect |
|---|---|
| `= delete` on first declaration | required; deleting after a definition is ill-formed |
| Deleted function selected as best | ill-formed call; no fallback to the next candidate |
| Deleted function merely *odr-used* in an unevaluated context | fine (`decltype`, `sizeof`, `noexcept()`) |
| `= default` on first declaration | not user-provided; triviality and aggregate-ness preserved |
| `= default` out of line | **user-provided**; triviality lost, `is_trivially_*` becomes false |
| Defaulted SM whose subobject can't do the operation | implicitly *defined as deleted* |
| Defaulted `<=>` with a member lacking `<=>` | comparison operators become deleted, not an error at declaration |
| Declaring any destructor / copy op | suppresses implicit move ops (rule of five) |
| Declaring a move op | copy ops become **deleted** |

**Interview line** — "Deleted does not mean invisible: it is a full participant in overload resolution whose selection is a compile error, which is exactly why it makes a sharper diagnostic than not declaring it at all."

**Traps** — `= default` moved out of line silently kills triviality (and `memcpy`-ability) · deleting the copy ctor also blocks passing by value · defaulted `operator==` is deleted, not missing, when a member has no `==` · a defaulted move that would throw makes `vector` fall back to copies (it needs `noexcept`) · deleting `operator new` does not prevent `std::vector<T>` from heap-allocating an array of `T`.

---

## 7.7 `inline`, `constexpr`, `consteval`, and `constinit`

| Specifier | Operational meaning | Explicitly NOT |
|---|---|---|
| `inline` (function) | permits identical definitions in multiple TUs; one entity, one address | a request to inline machine code |
| `inline` (variable, C++17) | one shared object across TUs, header-definable | thread safety |
| `constexpr` function | *usable* in a constant expression when args/context permit; otherwise ordinary runtime call; implicitly `inline` | every call being compile-time |
| `constexpr` variable | const, initialized by constant expression; implicitly `inline` at namespace scope (C++17) | mutability of anything |
| `consteval` (C++20) | immediate function — every potentially-evaluated call must be a constant expression | callable at runtime |
| `constinit` (C++20) | the variable *must* be constant-initialized (no dynamic init, no static-init-order fiasco) | const-ness; not a function specifier |
| `static` (fn) | internal linkage | anything about storage of locals |

```cpp
#include <cstdint>

constexpr std::uint64_t mask(unsigned bit) { return std::uint64_t{1} << bit; }
static_assert(mask(3) == 8);                  // compile-time
unsigned runtime_bit();
auto m = mask(runtime_bit());                 // same function, runtime call

consteval unsigned checked_capacity(unsigned n) {
    if (n == 0 || (n & (n - 1)) != 0) throw "capacity must be a power of two";
    return n;                                 // a throw here = compile error at the call
}
inline constexpr auto queue_capacity = checked_capacity(1024);   // OK
// unsigned bad = checked_capacity(runtime_bit());               // error: not constant

constinit std::uint64_t packets_seen = 0;     // mutable, guaranteed static init
constexpr std::uint64_t kMax = 1'000'000;     // const AND compile-time
inline int shared_counter = 0;                // C++17 inline variable, header-safe
thread_local constinit int tls_depth = 0;

// ---- constexpr function bodies (C++20/23 loosened a lot) ----------------
constexpr int sum_to(int n) {
    int s = 0;
    for (int i = 1; i <= n; ++i) s += i;      // loops OK since C++14
    if consteval { /* compile-time branch */ }  // C++23
    return s;
}
constexpr auto build() {
    std::vector<int> v{1,2,3};                // C++20: transient allocation, freed before return
    return v.size();
}
// C++23: constexpr functions may contain goto, static/thread_local vars, and
// non-literal types, as long as no such construct is *evaluated* at compile time.

// ---- detect the evaluation context -------------------------------------
constexpr int fast_or_exact(int x) {
    if (std::is_constant_evaluated()) return exact_slow(x);   // C++20
    return approx_fast(x);
}
constexpr int v2(int x) { if consteval { return exact_slow(x); } else { return approx_fast(x); } } // C++23
```

```cpp
// ---- what a constexpr evaluation REJECTS (turns UB into an error) -------
constexpr int oops() {
    int a[3]{};
    // return a[3];              // out of bounds → compile error, not UB
    // int* p = nullptr; return *p;   // null deref → compile error
    // return 1 / 0;             // → compile error
    return 0;
}
// At RUNTIME the very same function has ordinary UB — constexpr is not a checker.
```

**Traps** — `constexpr` on a member function no longer implies `const` (since C++14) · a `constexpr` function that can never be constant-evaluated for any argument is IFNDR · `constinit` ≠ `constexpr`: the object stays mutable · `inline` in a header is about linkage, and removing it causes ODR violations, not slowdowns · `consteval` functions cannot be taken as a runtime function pointer · `static_assert(mask(runtime_bit()))` is an error, not a fallback.

---

## 7.8 `noexcept`, conditional `noexcept`, and exception specifications

```cpp
// ---- the specifier ------------------------------------------------------
void commit() noexcept;                    // == noexcept(true)
void risky() noexcept(false);              // explicit potentially-throwing (the default)
void unspecified();                        // potentially-throwing

// ---- the operator (unevaluated, compile-time bool) ----------------------
static_assert(noexcept(1 + 1));
static_assert(!noexcept(throw 1));
bool b1 = noexcept(std::declval<T&>() = std::declval<T&&>());

// ---- conditional / composed --------------------------------------------
template<class T>
void relocate(T& dst, T&& src)
    noexcept(noexcept(dst = std::move(src)))            // outer specifier, inner operator
{ dst = std::move(src); }

template<class T>
void swap_(T& a, T& b)
    noexcept(std::is_nothrow_move_constructible_v<T> &&
             std::is_nothrow_move_assignable_v<T>);      // trait-driven — preferred

// ---- escaping = terminate ----------------------------------------------
void publish() noexcept {
    may_throw();          // if it throws: std::terminate() — NO unwinding guaranteed
}
```

| Fact | Detail |
|---|---|
| Escaping exception | `std::terminate()` via `std::terminate_handler`; stack may or may not be unwound |
| C++17 | exception specification is part of the **function type** |
| Conversion | `void(*)() noexcept` → `void(*)()` is implicit; the reverse needs a cast and is unsafe |
| Overloading | **cannot** overload on `noexcept` alone |
| Virtuals | an override may not be *less* restrictive than the base (`noexcept` base ⇒ `noexcept` override) |
| Implicit specials | dtors, and defaulted SMs, are `noexcept` unless a subobject's operation can throw |
| Destructors | implicitly `noexcept(true)`; throwing from one during unwinding ⇒ terminate |
| Deallocation functions | implicitly `noexcept` |
| `std::vector` growth | uses `std::move_if_noexcept`: a throwing move ⇒ copies instead |
| `throw()` | removed in C++20 (was equivalent to `noexcept`); dynamic `throw(A,B)` removed in C++17 |
| Templates | conditional `noexcept` propagates the real contract instead of guessing |

```cpp
// ---- the vector consequence, concretely ---------------------------------
struct Record {
    Record(Record const&);            // copy exists
    Record(Record&&) noexcept;        // ← this noexcept is what makes growth O(n) moves
};
static_assert(std::is_nothrow_move_constructible_v<Record>);
// Drop the noexcept and every vector reallocation deep-copies for the strong guarantee.

// ---- swap must be noexcept for the copy-and-swap idiom to be useful -----
friend void swap(Widget& a, Widget& b) noexcept { /* member-wise std::swap */ }
```

**Interview line** — "`noexcept` is a hard, mechanically-checkable contract enforced by `terminate`, not an optimization hint — mark it only after auditing every reachable operation, but *always* mark moves, swaps, and destructors."

**Traps** — aspirational `noexcept` on a function that later allocates · `noexcept(f())` measures the *declared* specification, not the real behavior · a `noexcept` function calling a throwing callback through `std::function` · `noexcept` on a move ctor whose member's move can throw ⇒ terminate at the worst moment · marking a function `noexcept` in a header changes the type and thus the ABI.

---

## 7.9 Trailing return types and abbreviated function templates

```cpp
// ---- trailing return: parameters are in scope ---------------------------
template<class L, class R>
auto add(L const& lhs, R const& rhs) -> decltype(lhs + rhs) { return lhs + rhs; }

template<class L, class R>
auto add2(L const& l, R const& r) -> decltype(auto) { return l + r; }   // C++14

template<class T>
auto at(T& c, std::size_t i) -> decltype(c[i]) { return c[i]; }         // SFINAE-friendly

// ---- member-of-dependent-type return needs trailing ---------------------
template<class C>
auto first(C& c) -> typename C::value_type&;

// ---- abbreviated function templates (C++20) -----------------------------
auto midpoint(auto lhs, auto rhs) { return lhs + (rhs - lhs) / 2; }
// equivalent to: template<class T1, class T2> auto midpoint(T1, T2);
// NOTE: the two auto params deduce INDEPENDENTLY.

void same(std::same_as<int> auto x);                        // constrained placeholder
void num(std::integral auto x, std::floating_point auto y); // two constrained params
auto sum(std::integral auto... xs) { return (0 + ... + xs); }  // constrained pack
void fwd(auto&& x) { sink(std::forward<decltype(x)>(x)); }  // forwarding with auto&&

auto consume(std::ranges::contiguous_range auto const& r)
    -> std::ranges::range_value_t<decltype(r)>;

// ---- constrained return placeholder -------------------------------------
std::integral auto count();                                 // return must satisfy integral
auto build() -> std::ranges::view auto;                     // ill-formed spelling; use above

// ---- forcing sameness ---------------------------------------------------
template<class T> void pair_up(T a, T b);                   // one type parameter
void pair_up2(auto a, std::same_as<decltype(a)> auto b);    // abbreviated equivalent
```

| Form | Template parameters introduced | When to prefer |
|---|---|---|
| `template<class T> auto f(T) -> R` | named, addressable, specifiable at call site | need `f<int>(x)`, need the name in the body |
| `auto f(auto x)` | anonymous, one per placeholder | short generic helpers |
| `void f(Concept auto x)` | anonymous + constrained | self-documenting, better diagnostics |
| `auto f(...) -> decltype(expr)` | — | SFINAE-friendly, expression-dependent return |
| `auto f(...) -> decltype(auto)` | — | perfect return forwarding (may return a reference) |

**Traps** — `auto f(auto, auto)` lets the two arguments differ, which is almost never what you meant for `min`/`max` · abbreviated templates cannot be explicitly specialized nor have their args spelled at the call site · `decltype(auto)` returning `(local)` dangles · `-> decltype(c[i])` yields a *reference*, which is usually right and occasionally surprising · you cannot partially specify: mixing `template<class T>` with `auto` params is allowed, but the `auto` ones come last in the implicit list.

---

## 7.10 Return value optimization, NRVO, copy elision, and returning `std::move(local)`

```cpp
// ---- GUARANTEED elision (C++17): prvalue initializes the result directly -
Order make() { return Order{42}; }        // no temporary is materialized at all
Order o = make();                         // still ONE object, constructed in place
// Works even if Order has NO copy and NO move constructor:
struct Immobile { Immobile(int); Immobile(Immobile const&) = delete;
                  Immobile(Immobile&&) = delete; };
Immobile mk() { return Immobile{1}; }     // OK in C++17
Immobile im = mk();                       // OK — same object, never "copied"

// ---- NRVO: permitted, NOT guaranteed ------------------------------------
Order make_nrvo(bool flagged) {
    Order result{42};
    if (flagged) result.set_flag();
    return result;               // NRVO may construct directly in the caller's storage
}                                // if not: IMPLICIT MOVE of `result` (C++11/20 rules)

// ---- what defeats NRVO --------------------------------------------------
Order a1(bool b) { Order x{1}, y{2}; return b ? x : y; }  // two candidates → no NRVO
Order a2(Order p) { return p; }                            // parameter → no NRVO, implicit move
Order a3() { Order x{1}; return std::move(x); }            // BLOCKS NRVO — never write this
Order a4() { Order x{1}; return (x); }                     // parenthesized → blocks NRVO
Order a5(Order& r) { return r; }                           // reference → real COPY
static Order s;  Order a6() { return s; }                  // static → real copy

// ---- when std::move on return IS correct --------------------------------
struct Base {}; struct Derived : Base {};
Base slice_move() { Derived d; return std::move(d); }  // different type → move is needed
                                                       // (implicit move applies here too
                                                       //  since C++20; explicit is clearer)
std::unique_ptr<Base> up() { auto d = std::make_unique<Derived>(); return d; }  // implicit move, OK

// ---- returning a member / a moved-from field ----------------------------
struct Holder {
    std::string s;
    std::string take() && { return std::move(s); }   // ok: member, needs explicit move
    std::string copy() const& { return s; }
};
```

| Return expression | C++17/20 behavior |
|---|---|
| prvalue of the return type | **guaranteed elision** — no ctor required |
| named local / parameter of the return type | NRVO allowed; otherwise **implicit move** (overload resolution treats it as an rvalue first, then retries as lvalue) |
| named local of a *different* (convertible/base) type | implicit move since C++20; move ctor used |
| `std::move(local)` | move ctor; **NRVO blocked** |
| `(local)` | NRVO blocked; still implicitly moved |
| reference parameter / global / static / member | copy (no elision candidate) |
| `co_return`, `throw x` | separate rules; `throw x` also gets implicit move |
| function returning `void` | `return f();` allowed where `f` returns `void` |

```cpp
// ---- proving it in an interview ----------------------------------------
struct Probe {
    Probe()            { std::puts("ctor"); }
    Probe(Probe const&){ std::puts("copy"); }
    Probe(Probe&&) noexcept { std::puts("move"); }
    ~Probe()           { std::puts("dtor"); }
};
Probe f1() { return Probe{}; }        // prints: ctor dtor          (guaranteed elision)
Probe f2() { Probe p; return p; }     // prints: ctor dtor          (NRVO) — or ctor move dtor dtor
Probe f3() { Probe p; return std::move(p); }  // ALWAYS: ctor move dtor dtor
// compile with -fno-elide-constructors to see the un-elided form
```

**Interview line** — "C++17 turned elision from an optimization into a language rule for prvalues, so `return T{...}` costs nothing and needs no move constructor; NRVO for a named local is still merely permitted, and `return std::move(local)` converts a free elision into a guaranteed move."

**Traps** — `-fno-elide-constructors` does not disable *guaranteed* elision · returning a `const` local blocks the implicit move and forces a copy · `return {a, b};` is a prvalue and elides, but uses list-initialization rules (narrowing is an error) · elision may skip a side-effecting copy ctor — never rely on copy-ctor side effects · returning by value from a `co_routine` follows promise-type rules, not these.

---

## 7.11 Recursion, tail calls (not guaranteed), and inlining (not guaranteed)

```cpp
// ---- recursion is fine when depth is BOUNDED BY CONSTRUCTION ------------
constexpr std::uint64_t factorial(std::uint64_t n) {
    return n < 2 ? 1 : n * factorial(n - 1);      // fine at compile time; check n at runtime
}

// ---- tail position is NOT a guarantee -----------------------------------
std::size_t depth(Node const* n) {                // "tail call" — still may use a frame
    return n ? 1 + depth(n->next) : 0;            // NOT a tail call: the +1 follows the call
}

// ---- explicit stack: bounded, no overflow, no ABI dependence ------------
std::size_t depth_iter(Node const* n) noexcept {
    std::size_t d = 0;
    for (; n; n = n->next) ++d;
    return d;
}

// ---- bounded recursion over untrusted input -----------------------------
struct ParseError {};
Value parse(Reader& r, unsigned depth = 0) {
    if (depth > 64) throw ParseError{};           // enforce the bound explicitly
    // ... recurse with depth + 1 ...
}

// ---- explicit worklist instead of recursion -----------------------------
void walk(Node* root) {
    std::vector<Node*> stack;                     // heap, but bounded and resizable
    stack.reserve(64);
    stack.push_back(root);
    while (!stack.empty()) {
        Node* n = stack.back(); stack.pop_back();
        for (Node* c : n->children) stack.push_back(c);
    }
}
```

| Claim people make | Reality |
|---|---|
| "It's a tail call, so no stack growth" | C++ mandates no TCO; destructors, unwind tables, ABI, `-O0`, and instrumentation each defeat it |
| "`inline` makes it inline" | `inline` is an ODR/linkage keyword only |
| "`constexpr` means no runtime cost" | only when actually constant-evaluated in that call |
| "Templates always inline" | the definition being visible *enables* inlining; the optimizer still decides |
| "`__forceinline` / `[[gnu::always_inline]]` guarantees it" | compiler-specific, may be ignored, and can hurt I-cache |
| "Recursion depth is my algorithm's depth" | it is the *input's* depth; untrusted input ⇒ stack overflow (not an exception, not catchable) |

```text
What actually enables inlining          What blocks it
  definition visible in the TU            call through function pointer / std::function
  or LTO / whole-program                  virtual call not devirtualized
  small body, hot call site (PGO)         separate TU without LTO
  `inline`/`constexpr`/template hint      recursion beyond the inline depth limit
  __attribute__((always_inline))          -O0, address-taken, varargs, huge body
```

```bash
# verify, never assume
g++ -O2 -S -masm=intel -o - hot.cpp | c++filt        # read the real code
g++ -O2 -Rpass=inline -Rpass-missed=inline hot.cpp   # clang: why it did/didn't inline
g++ -O2 -fopt-info-inline-optimized hot.cpp          # gcc equivalent
ulimit -s                                            # your actual stack limit (KiB)
```

**Traps** — stack overflow is UB and usually a SIGSEGV, not a catchable exception · a deep recursive destructor on a linked list blows the stack at *destruction* time · `alloca`/VLAs inside a recursive function multiply the per-frame cost · benchmarking a recursive function at `-O0` measures the call overhead, not your algorithm · inlining decisions change with unrelated edits, so a latency claim must be re-measured on the shipped binary.

**Hot-path signature checklist**

1. Does each parameter state ownership, optionality, mutability, and extent?
2. Can any view or reference outlive its owner?
3. Does the overload set admit an unintended `bool`, narrowing, or allocating conversion?
4. Does the call allocate, lock, throw, format, or dispatch virtually?
5. Is work bounded by an enforced capacity rather than expected traffic?
6. Is every `noexcept` mechanically true for all reachable operations?
7. Can the return use guaranteed elision (`return T{...}`) rather than NRVO?
8. Are default arguments stable across headers and binary versions?
9. Is recursion depth bounded by construction or by an explicit check?
10. Is the performance claim measured on the actual optimized binary?

```text
RECALL CARD
call selection     lookup(+ADL) → candidates → deduce/constrain → viable → rank → best → access/deleted
conversion rank    exact → promotion → conversion → user-defined(×1) → ellipsis
tie-breakers       non-template > template > less-specialized; more-constrained wins (C++20)
return type        never distinguishes ordinary overloads
default argument   substituted from the declaration visible at the CALL SITE; virtual ⇒ static type
deleted            participates; selection is an error, not a fallback
defaulted          in-class = trivial; out-of-line = user-provided = not trivial
value param        independent object; ideal for small values and sinks (then std::move)
T const&           universal fallback binding; extends a temporary only to end of full-expression
span/string_view   non-owning; never extends a lifetime; view ≠ NUL-terminated
named T&&          is an LVALUE in the body — std::move again
inline             ODR facility · constexpr may · consteval must · constinit = static init
noexcept           escape ⇒ terminate; part of the type since C++17; drives move_if_noexcept
prvalue return     guaranteed elision, no ctor needed · NRVO optional · return std::move(x) blocks it
tail call/inline   optimizer choices, never portable guarantees — bound depth, read the asm
```
