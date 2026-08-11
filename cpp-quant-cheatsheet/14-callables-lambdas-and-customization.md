# 14. Callables, lambdas, and customization

*Part II — Classes, resource management, and generic programming*

---

**Recall**
- "Callable" names only call *syntax*; ownership, lifetime, and dispatch mechanism are three separate, independent decisions.
- A function pointer is non-owning, exactly one signature, and since C++17 `noexcept` is part of its type (conversion goes noexcept → throwing only).
- A pointer to member is not an address: it needs an object, and its representation can encode inheritance adjustments.
- `std::invoke` is the one spelling that handles free functions, functors, member functions, and member *data* uniformly.
- Every lambda expression creates a distinct unnamed closure class type — two textually identical lambdas have different types.
- A captureless lambda converts to a matching function pointer; a capturing one never does.
- Captures copy *the object*, not what it refers to: `[sv]`, `[ptr]`, `[span]`, `[it]` still borrow.
- `[this]` copies a pointer; `[*this]` (C++17) copies the object; implicit `this` capture via `[=]` is deprecated since C++20.
- The closure's `operator()` is `const` by default; `mutable` removes the `const`, and grants no thread safety and no lifetime extension.
- Init-capture `[p = std::move(u)]` is how a closure owns move-only state — and is why it cannot go into `std::function`.
- A lambda's call operator is implicitly `constexpr` when it qualifies; `consteval` makes it immediate; C++23 allows `static operator()` (captureless only).
- `bind_front`/`bind_back` decay-copy bound arguments; `std::ref`/`std::cref` opt into borrowing and reintroduce lifetime risk.
- `std::function` is copyable type erasure: target must be copy-constructible, construction may allocate, and calling an empty one throws `std::bad_function_call`.
- `std::function` cannot express a `noexcept` signature; `std::move_only_function` (C++23) can, and its empty call is **UB**, not an exception.
- SBO in `std::function` is only *required* for function pointers and `reference_wrapper`; everything else is a QoI accident, not a guarantee.
- A lambda does not allocate; allocation comes from the erasing wrapper or container it is stored in.
- ADL finds hidden friends; a CPO is an `inline constexpr` function object that pins the name and controls which ADL overloads win.
- `std::visit` over an `Overload{...}` aggregate is closed-set typed dispatch; a generic `[](auto&&)` arm silently swallows new alternatives.
- Multi-variant visitation instantiates the Cartesian product of alternatives — code size grows multiplicatively.

---

## 14.1 Function pointers and member pointers

```cpp
#include <functional>
#include <type_traits>

// ---- free function pointers -------------------------------------------
bool decode_a(char const*, std::size_t) noexcept;
bool decode_b(char const*, std::size_t) noexcept;

using Decoder  = bool (*)(char const*, std::size_t) noexcept;  // noexcept in type (C++17)
using MayThrow = bool (*)(char const*, std::size_t);

Decoder  d1 = &decode_a;        // explicit address-of
Decoder  d2 = decode_a;         // function-to-pointer decay — same thing
MayThrow d3 = d1;               // OK: drops noexcept
// Decoder d4 = d3;             // ill-formed: cannot ADD noexcept
bool ok = d1(nullptr, 0);       // call through pointer
bool ok2 = (*d1)(nullptr, 0);   // legacy dereference spelling — identical

bool (*table[2])(char const*, std::size_t) noexcept = {decode_a, decode_b};  // array of ptrs
bool (&fref)(char const*, std::size_t) noexcept = decode_a;                  // reference to function

// ---- disambiguating an overload set -----------------------------------
int    parse(int);
double parse(double);
auto p_int  = static_cast<int (*)(int)>(&parse);      // cast selects
int  (*p2)(int) = &parse;                             // target type selects
auto lam    = [](int x) { return parse(x); };         // lambda wrapper: keeps overload resolution

// ---- pointer + context: the C-callback shape --------------------------
using Callback = void (*)(void* ctx, int event) noexcept;
struct Ctx { int n; };
void on_event(void* ctx, int event) noexcept { static_cast<Ctx*>(ctx)->n += event; }
Ctx ctx{};
Callback cb = &on_event;  cb(&ctx, 1);   // context lifetime is YOUR problem

// ---- captureless lambda → function pointer ----------------------------
int (*add)(int, int) noexcept = [](int a, int b) noexcept { return a + b; };
auto gen = []<class T>(T a, T b) { return a + b; };
int (*gi)(int, int) = gen;               // generic captureless: conversion per specialization
auto plus = +[](int a, int b) { return a + b; };   // unary + forces the conversion
```

```cpp
// ---- pointers to members ----------------------------------------------
struct Book {
    int depth{};
    int best_qty() const noexcept { return depth; }
    void bump(int d) { depth += d; }
    static int stat();                                  // STATIC → ordinary function ptr
};

int  Book::*                       pd  = &Book::depth;          // data member ptr
int  (Book::* pf)() const noexcept = &Book::best_qty;           // const member fn ptr
void (Book::* pb)(int)             = &Book::bump;               // non-const member fn ptr
int  (*ps)()                       = &Book::stat;               // static: NOT a member ptr

Book  b{7};
Book* pbk = &b;
int v1 = b.*pd;              // object   . *  data-member-ptr
int v2 = pbk->*pd;           // pointer  -> * data-member-ptr
int v3 = (b.*pf)();          // parens REQUIRED: .* binds looser than ()
int v4 = (pbk->*pf)();
(b.*pb)(3);

int Book::* pnull = nullptr;   // null member ptr is valid and comparable
static_assert(sizeof(pd) >= sizeof(int));   // size is implementation-defined

// ---- std::invoke: one spelling for all five callable shapes ------------
int i1 = std::invoke(&Book::best_qty, b);              // object
int i2 = std::invoke(&Book::best_qty, pbk);            // pointer to object
int i3 = std::invoke(&Book::best_qty, std::ref(b));    // reference_wrapper
int i4 = std::invoke(&Book::depth,   b);               // member DATA → int&
int i5 = std::invoke(decode_a, nullptr, 0);            // ordinary callable
std::invoke_r<long>(decode_a, nullptr, 0);             // C++23: explicit return conversion

static_assert(std::is_same_v<decltype(std::invoke(pd, b)), int&>);
static_assert(std::is_invocable_v<decltype(pf), Book const&>);
static_assert(std::is_invocable_r_v<long, decltype(pf), Book const&>);
static_assert(std::is_nothrow_invocable_v<decltype(pf), Book const&>);
using R = std::invoke_result_t<decltype(pf), Book const&>;      // int
```

| Facility | Header | Meaning / cost |
|---|---|---|
| `R (*)(Args...) noexcept` | — | non-owning target, one exact signature, indirect call |
| `T C::*` | — | member-data pointer; `obj.*p` is an lvalue of type `T` |
| `R (C::*)(Args...) cv ref noexcept` | — | member-function pointer; needs an object |
| `std::invoke(f, args...)` | `<functional>` | uniform call; O(1), `constexpr`, conditionally `noexcept` |
| `std::invoke_r<R>(f, args...)` | `<functional>` | C++23; converts result to `R` (allows `R = void`) |
| `std::is_invocable_v<F, Args...>` | `<type_traits>` | callable-ness predicate |
| `std::is_invocable_r_v<R, F, Args...>` | `<type_traits>` | result implicitly convertible to `R` |
| `std::is_nothrow_invocable_v<...>` | `<type_traits>` | call is non-throwing |
| `std::invoke_result_t<F, Args...>` | `<type_traits>` | the return type |
| `std::reference_wrapper<T>` / `ref` / `cref` | `<functional>` | copyable, rebindable borrow; implicit `T&` conversion |
| `std::mem_fn(&C::m)` | `<functional>` | wraps a member pointer into a callable object |

**Traps** — `b.*pf()` parses as `b.*(pf())`; always parenthesize · function pointers carry no state, so a `void*` context must be kept alive by you · casting between function and object pointers is not portable · calling a null/invalid function pointer is UB · a static member function is an ordinary function pointer, not a member pointer · member-pointer size differs per inheritance model on MSVC.

---

## 14.2 Lambda closure types, captures, init-captures, and generic lambdas

```cpp
// ---- the closure type --------------------------------------------------
auto add = [](int a, int b) noexcept { return a + b; };
static_assert(std::is_empty_v<decltype(add)>);      // captureless → empty class
static_assert(add(2, 3) == 5);                      // implicitly constexpr
auto a1 = [] { return 0; };
auto a2 = [] { return 0; };
static_assert(!std::is_same_v<decltype(a1), decltype(a2)>);   // distinct types

// Closure types: no default ctor (until C++20, captureless ones now have one),
// deleted copy-assignment when capturing by reference, destructor/copy from members.
decltype(add) fresh{};            // C++20: captureless closures are default-constructible
decltype(add) copy = add;         // copy-constructible

// ---- full lambda grammar ----------------------------------------------
auto full = []<class T>(T x)                 // C++20 explicit template parameter list
    noexcept(noexcept(T(x)))                 // conditional noexcept
    -> T                                     // trailing return type
    requires std::integral<T>                // trailing requires-clause (C++20)
{ return x + 1; };

auto attr = [](int x) [[nodiscard]] { return x; };   // attributes after the parameter list
```

```cpp
// ---- every capture form ------------------------------------------------
int   threshold = 10;
int   counter   = 0;
auto  vec       = std::vector<int>(128);

auto c1 = [threshold]           (int x) { return x > threshold; };  // by copy
auto c2 = [&threshold]          (int x) { return x > threshold; };  // by reference
auto c3 = [=]                   (int x) { return x > threshold; };  // implicit copy (odr-used only)
auto c4 = [&]                   (int x) { return x > threshold; };  // implicit reference
auto c5 = [=, &counter]         (int x) { counter += x > threshold; };  // default copy, one by ref
auto c6 = [&, threshold]        (int x) { return x > threshold; };  // default ref, one by copy
auto c7 = [n = threshold]       (int x) { return x > n; };          // init-capture (C++14)
auto c8 = [&r = threshold]      (int x) { return x > r; };          // init-capture BY REFERENCE
auto c9 = [v = std::move(vec)]  ()      { return v.size(); };       // move into the closure
auto ca = [p = std::make_unique<int>(3)]() { return *p; };          // move-only capture → move-only closure
auto cb = [n = threshold + 1]   (int x) { return x > n; };          // arbitrary expression

template<class... Ts>
auto pack(Ts... ts) {
    return [...xs = std::move(ts)] { return (xs + ...); };   // C++20 pack init-capture
}
template<class... Ts>
auto pack_ref(Ts&... ts) { return [&...rs = ts] { return (rs + ...); }; }  // C++20

// static/thread_local/constexpr and globals are NOT captured — they are just used
static int shared = 0;
auto uses_static = [] { return shared; };          // capture list stays empty

// unevaluated / structured-binding captures
auto cs = [sz = sizeof(int)] { return sz; };
auto [lo, hi] = std::pair{1, 2};
auto cbind = [lo, hi] { return hi - lo; };         // C++20: structured bindings capturable
```

| Capture | Closure stores | Lifetime consequence |
|---|---|---|
| `[x]` | member copy-initialized from `x` | independent copy; pointers/views *inside* `x` still borrow |
| `[&x]` | reference to the original `x` | closure must not outlive `x` |
| `[=]` | copies of odr-used automatic vars | hides ownership; `this` capture deprecated (C++20) |
| `[&]` | references to odr-used automatic vars | most dangling-prone form |
| `[x = expr]` | member from arbitrary expression | can move, convert, rename, or narrow state |
| `[&r = expr]` | reference member bound to `expr` | borrow with an explicit name |
| `[this]` | the `this` **pointer** | `*this` must outlive every call |
| `[*this]` | a **copy** of `*this` (C++17) | independent; pays a copy |
| `[...xs = ts]` | pack of members (C++20) | one member per pack element |
| `[]` | nothing | convertible to function pointer |

```cpp
// ---- generic and templated lambdas -------------------------------------
auto id = [](auto&& x) -> decltype(auto) {           // perfect forwarding
    return std::forward<decltype(x)>(x);
};
auto sum = [](auto... xs) { return (xs + ...); };            // variadic generic
auto fwd = [](auto&&... xs) { return f(std::forward<decltype(xs)>(xs)...); };

auto same = []<class T>(T a, T b) { return a == b; };        // C++20: ties both params to ONE T
auto ctd  = []<class T, std::size_t N>(std::array<T, N> const& a) { return N; };  // deduce NTTP
auto cons = []<std::integral T>(T x, T y) constexpr noexcept { return x + y; };
auto vpk  = []<class... Ts>(Ts&&... ts) { return sizeof...(Ts); };

// recursion: C++23 deducing this ("explicit object parameter") kills the Y-combinator
auto fib = [](this auto&& self, int n) -> int {              // C++23
    return n < 2 ? n : self(n - 1) + self(n - 2);
};
static_assert(fib(10) == 55);
```

**Traps** — identical lambdas are different types, so `std::vector<decltype(l)>` cannot hold another lambda · `[=]` does not copy the object when you meant `[*this]` · capturing a `string_view`/`span`/iterator copies the handle, not the bytes · reference-capturing closures have deleted copy-assignment · a lambda in a default argument or NSDMI has a distinct type per instantiation context.

---

## 14.3 Capture lifetime, `this` versus `*this`, and dangling closures

```cpp
// ---- the classic dangle -------------------------------------------------
std::function<void()> bad() {
    int count = 0;
    return [&] { use(count); };            // UB: count dies at return
}
auto make_pred_bad(int threshold) {
    return [&threshold](int x) { return x > threshold; };   // dangles: PARAMETER is local
}
auto make_pred_ok(int threshold) {
    return [threshold](int x) { return x > threshold; };    // owns a copy
}

// ---- this versus *this --------------------------------------------------
class Engine {
    int mode_{};
    std::vector<int> book_;
public:
    auto observer()        { return [this]  { return mode_; }; }   // borrows the object
    auto snapshot() const  { return [*this] { return mode_; }; }   // copies the object (C++17)
    auto field()     const { return [m = mode_] { return m; }; }   // copies just the field — cheapest
    // auto old()          { return [=] { return mode_; }; }       // deprecated implicit this (C++20)
    auto both()            { return [=, this] { return mode_; }; } // C++20: explicit, non-deprecated
};

// ---- temporaries: no lifetime extension through a capture ---------------
std::string_view name = std::string("tmp");   // ALREADY dangling
auto f1 = [name] { use(name); };              // copies ptr+len, not characters
auto f2 = [s = std::string("tmp")] { use(s); };   // owns the characters

// ---- async escape -------------------------------------------------------
void enqueue(std::function<void()>);
void bad_async(std::vector<int>& data) {
    enqueue([&data] { crunch(data); });                    // caller may return first
}
void ok_async(std::shared_ptr<Data> d) {
    enqueue([d] { crunch(*d); });                          // shared ownership: +atomic refcount
}
void ok_async2(std::vector<int> data) {
    enqueue([data = std::move(data)] { crunch(data); });    // sole ownership, no refcount
}
class Session : public std::enable_shared_from_this<Session> {
    void arm() { enqueue([self = shared_from_this()] { self->tick(); }); }   // keep-alive idiom
    void arm_weak() {
        enqueue([w = weak_from_this()] { if (auto s = w.lock()) s->tick(); });  // no cycle
    }
};
```

**Escape checklist** — before returning, storing, queueing, or cross-thread posting a closure:

- Classify every capture as *owned* or *borrowed*; `[&]`/`[this]`/`std::ref` are borrows.
- Prove each borrowed object outlives the **last** invocation, not just the enqueue.
- Lifetime safety ≠ race safety: `[&counter]` can be live and still be a data race.
- Give shutdown a way to cancel or join before the borrowed owner is destroyed.
- `shared_ptr` capture buys safety at the price of atomic refcount traffic on every copy of the closure.
- Prefer capturing the *field* over `[this]` when the closure needs one value.

**Interview line** — "`[this]` captures a pointer, so the closure is only as valid as the object; `[*this]` captures a copy and is self-contained."

**Traps** — `-Wdangling-capture`/ASan catch only some cases · lambdas stored in members that capture `this` create a self-reference that a move of the object silently invalidates · `[=]` inside a member function captures `this`, not the members · a coroutine lambda's closure dies at the first suspend unless it is kept alive.

---

## 14.4 Mutable, constexpr, consteval, static, and templated lambdas

```cpp
// ---- mutable ------------------------------------------------------------
auto seq = [next = 0]() mutable noexcept { return next++; };   // non-const operator()
seq(); seq();                                  // 0, 1 — state lives in the closure
auto copy_of_seq = seq;                        // COPIES the state; counters diverge
// const auto cs = seq; cs();                  // ill-formed: operator() is non-const

auto ro = [n = 0] { /* n = 1; */ return n; };  // operator() const → n is const here

// ---- constexpr / consteval ---------------------------------------------
auto mask = [](unsigned bit) { return 1u << bit; };            // implicitly constexpr
static_assert(mask(3) == 8);
constexpr auto cmask = [](unsigned bit) constexpr { return 1u << bit; };  // explicit
consteval auto width = [](unsigned bytes) consteval { return bytes * 8; };
static_assert(width(4) == 32);
// int r = width(runtime_bytes);      // ill-formed: immediate function needs a constant

constexpr auto table = [] {                    // IIFE builds a constexpr table
    std::array<int, 8> t{};
    for (int i = 0; i != 8; ++i) t[i] = i * i;
    return t;
}();
static_assert(table[3] == 9);

// ---- static call operator (C++23) --------------------------------------
auto twice = [](int x) static noexcept { return x * 2; };      // C++23; captureless ONLY
// auto bad = [n = 1](int x) static { return x + n; };          // ill-formed: has a capture
// auto bad2 = [](int x) static mutable { return x; };          // ill-formed: static + mutable

// ---- deducing this on a lambda (C++23) ---------------------------------
auto self_aware = [](this auto const& self, int n) -> int {
    return n == 0 ? 1 : n * self(n - 1);
};

// ---- combining qualifiers ----------------------------------------------
auto everything = []<class T>(T&& x) mutable
    noexcept(std::is_nothrow_move_constructible_v<std::remove_cvref_t<T>>)
    -> std::remove_cvref_t<T>
    requires std::movable<std::remove_cvref_t<T>>
{ return std::forward<T>(x); };
```

| Specifier | Effect | Constraint |
|---|---|---|
| (none) | `operator()` is `const` | by-value captures read-only inside |
| `mutable` | `operator()` is non-const | captures modifiable; per-closure state; no synchronization implied |
| `constexpr` | forces constant-evaluability check | implicit anyway when the body qualifies |
| `consteval` | immediate function | every call must be a constant expression |
| `static` (C++23) | no implicit object parameter | capture list must be empty; excludes `mutable` |
| `this auto&& self` (C++23) | explicit object parameter | enables recursion and CRTP-free forwarding; excludes `static`/`mutable` |
| `noexcept(expr)` | conditional non-throwing | affects the conversion-to-function-pointer type too |
| `-> T` | fixed return type | required when returning a reference from a body with `return x;` |

**Traps** — `mutable` state is copied with the closure, so a `std::function` copy forks the counter · a `mutable` lambda cannot be called on a const closure, which breaks `const`-qualified algorithm parameters · `consteval` lambdas cannot be stored in `std::function` and called at runtime · `static` operator() is a signature/ABI change, not a measured speedup.

---

## 14.5 `std::invoke`, `std::bind_front`, and `std::bind_back`

```cpp
#include <functional>

int clamp_add(int base, int x, int limit);

// ---- bind_front (C++20) / bind_back (C++23) ----------------------------
auto from10 = std::bind_front(clamp_add, 10);       // fixes LEFTMOST args
int r = from10(5, 100);                             // clamp_add(10, 5, 100)
auto cap100 = std::bind_back(clamp_add, 100);       // C++23; fixes RIGHTMOST args
int s = cap100(10, 5);                              // clamp_add(10, 5, 100)
auto both = std::bind_back(std::bind_front(clamp_add, 10), 100);
int t = both(5);                                    // clamp_add(10, 5, 100)

// NTTP form (C++23): the callable is a template argument — no stored object at all
auto ntt = std::bind_front<clamp_add>(10);          // C++23
auto ntb = std::bind_back<clamp_add>(100);          // C++23

// ---- member functions --------------------------------------------------
struct State { void update(int); int read() const; };
State st;
auto upd  = std::bind_front(&State::update, &st);        // pointer: borrows
auto upd2 = std::bind_front(&State::update, std::ref(st)); // ref wrapper: borrows
auto upd3 = std::bind_front(&State::update, st);         // COPIES the State
upd(7);

// ---- decay-copy semantics ----------------------------------------------
std::string key = "abc";
auto b1 = std::bind_front(consume, key);              // stores a COPY (decay-copy)
auto b2 = std::bind_front(consume, std::move(key));   // stores a moved-from copy
auto b3 = std::bind_front(consume, std::ref(key));    // stores reference_wrapper → borrows

// ---- mem_fn and reference_wrapper --------------------------------------
auto qty = std::mem_fn(&Book::best_qty);
int  q   = qty(b);                                    // qty(obj | ptr | ref_wrapper)
auto depth = std::mem_fn(&Book::depth);               // member data also works
std::reference_wrapper<State> rw = std::ref(st);
State& raw = rw;                                       // implicit conversion
rw.get().update(1);
std::vector<std::reference_wrapper<State>> observers;  // references in a container

// ---- legacy std::bind (avoid) -------------------------------------------
using namespace std::placeholders;
auto old = std::bind(clamp_add, _2, _1, 100);          // reorders; nested-bind composition
// std::bind ignores extra args, composes nested binds surprisingly, and hides types.

// ---- when a lambda is simply clearer ------------------------------------
auto cap = [limit = 100](int base, int x) { return clamp_add(base, x, limit); };
```

| Facility | Since | Semantics |
|---|---|---|
| `std::invoke(f, a...)` | C++17 | uniform call; `constexpr`, conditionally `noexcept` |
| `std::invoke_r<R>(f, a...)` | C++23 | as above, result converted to `R` |
| `std::bind_front(f, a...)` | C++20 | decay-copies `f` and `a...`; forwards trailing args; preserves value category and `noexcept` |
| `std::bind_back(f, a...)` | C++23 | decay-copies; appends bound args after the call args |
| `std::bind_front<f>(a...)` / `bind_back<f>(a...)` | C++23 | callable as NTTP; nothing stored for `f` |
| `std::bind(f, ...)` | C++11 | placeholders `_1.._N`; reorders; legacy, avoid |
| `std::mem_fn(&C::m)` | C++11 | member pointer → callable accepting obj/ptr/ref_wrapper |
| `std::ref(x)` / `std::cref(x)` | C++11 | `reference_wrapper`; copyable borrow, `noexcept` |
| `std::not_fn(f)` | C++17 | negates the result of `f` |
| `std::identity{}` | C++20 | perfect-forwarding identity; default ranges projection |
| `std::plus<>`, `less<>`, … | C++14 | transparent operator functors (heterogeneous lookup) |
| `std::ranges::less{}`, … | C++20 | constrained, totally-ordered comparison objects |

**Traps** — `bind_front` copies by default, so the copy of a heavy object is silent · `std::ref` opts into a dangle · `std::bind` silently drops extra arguments (a lambda would not compile) · a bound `&State::update` with a raw `&st` is a borrow, so the binder must not outlive `st` · `bind_front`'s result is copyable only if all bound pieces are.

---

## 14.6 `std::function`, small-buffer optimization, allocation, and type erasure

```cpp
#include <functional>

// ---- construction, assignment, emptiness --------------------------------
std::function<int(int)> f;                       // EMPTY
if (!f) { /* empty */ }
// f(1);                                          // throws std::bad_function_call
f = [scale = 3](int x) { return scale * x; };    // from a lambda (must be copy-constructible)
f = &some_free_fn;                               // from a function pointer  (no allocation, required)
f = std::ref(functor);                           // from reference_wrapper   (no allocation, required)
f = std::bind_front(clamp_add, 1, 2);            // from a binder
f = nullptr;                                     // reset to empty
std::function<int(int)> g{std::move(f)};         // move: f left valid-but-unspecified (often empty)
f.swap(g);
std::function h = [](int x) { return x + 1; };   // CTAD from a lambda (C++17)

int y = f(4);
auto const& ti = f.target_type();                 // typeid of the stored target
if (auto* p = f.target<int (*)(int)>()) { /* exact-type access */ }

// ---- signature conversions are implicit --------------------------------
std::function<void(int)> discard = [](int x) { return x; };   // return value discarded — OK
std::function<long(int)> widen   = [](int x) { return x; };   // int → long conversion — OK
// std::function<void() noexcept> nf;             // ill-formed: no noexcept signatures

// ---- storing member functions ------------------------------------------
std::function<int(Book const&)> mf = &Book::best_qty;    // member ptr → invoke semantics
std::function<int()>            bd = std::bind_front(&Book::best_qty, &b);

// ---- what fails ---------------------------------------------------------
// std::function<void()> t = [p = std::make_unique<int>(0)] {};   // ill-formed: move-only target
auto sp = std::make_shared<int>(0);
std::function<void()> t2 = [sp] {};               // workaround: shared ownership (refcount cost)

// ---- the reference-return trap ------------------------------------------
// std::function<int&()> bad = [] { return 0; };  // rejected since C++23 LWG rules; older modes dangled
std::function<int&()> good = [v = 0]() mutable -> int& { return v; };

// ---- self-assignment / recursion pitfall --------------------------------
std::function<int(int)> fact = [&fact](int n) { return n ? n * fact(n - 1) : 1; };  // borrows fact!
```

| Member | Complexity | Notes |
|---|---|---|
| `function()` / `function(nullptr_t)` | O(1) | empty; `operator bool` is `false` |
| `function(F&& f)` | O(sizeof target) | **may allocate**; requires `F` copy-constructible and `is_invocable_r_v<R,F&,Args...>` |
| `function(function const&)` | copy of target | may allocate; strong guarantee |
| `function(function&&)` | O(1) *if* heap-stored, else move of target | source is valid-but-unspecified |
| `operator=(F&&)` / `= nullptr` | as ctor | |
| `operator()(Args...)` | one indirect call + target cost | throws `std::bad_function_call` when empty |
| `explicit operator bool()` | O(1) | `noexcept` |
| `swap(function&)` | O(1) or target move | `noexcept` |
| `target_type()` | O(1) | `typeid`; needs RTTI |
| `target<T>()` | O(1) | returns `T*` on exact type match, else `nullptr` |
| `operator==(nullptr_t)` | O(1) | the only comparison; targets are not comparable |

**Allocation rules**

- Only two no-allocation cases are *mandated*: a plain function pointer target and a `reference_wrapper` target.
- Any wider SBO (libstdc++ ~16 bytes, libc++ ~24 bytes, MSVC larger) is implementation detail — never a portable design premise.
- A target that is not nothrow-move-constructible may be forced onto the heap even when it fits.
- Allocator-extended constructors were **removed** in C++17 — you cannot control `std::function`'s allocation portably.
- Call cost = one indirect dispatch through erased vtable/pointer + the target's own cost; inlining across it is normally lost.

**Interview line** — "`std::function` is owning, copyable type erasure with an unspecified small-buffer policy; the only guaranteed allocation-free targets are function pointers and `reference_wrapper`."

**Traps** — empty call throws, and the throw is often in the hot path · copying a `std::function` copies (and may reallocate) the target, so passing by value in a loop allocates · `std::function` erases `noexcept` so a `noexcept` context calling it is a `terminate` risk · `target<T>()` needs the *exact* type including cv/ref · recursion via a captured reference to the `std::function` itself dangles if the `std::function` moves.

---

## 14.7 C++23 `std::move_only_function`

```cpp
#include <functional>
#include <memory>
#include <version>
#if !defined(__cpp_lib_move_only_function)
#  error "libstdc++ 12+ / libc++ 18+ required"
#endif

// ---- move-only, owning erasure ------------------------------------------
std::move_only_function<void()> task = [p = std::make_unique<State>()] { p->run(); };
task();
// auto c = task;                        // ill-formed: NOT copyable
auto moved = std::move(task);            // ownership transfer; task now empty
if (moved) moved();                      // CHECK: calling an empty one is UB, not a throw

// ---- full signature grammar (function does NOT support these) -----------
std::move_only_function<void()>              plain;      // call on lvalue or rvalue
std::move_only_function<void() noexcept>     nx;         // target must be nothrow-invocable
std::move_only_function<int(int) const>      ro;         // invokes the target as const
std::move_only_function<void() &>            lref;       // callable only on lvalues
std::move_only_function<void() &&>           rref;       // callable ONCE on an rvalue: std::move(rref)()
std::move_only_function<void() const noexcept> cn;
std::move_only_function<void() const & noexcept> can;

std::move_only_function<void() &&> once = [p = std::make_unique<Job>()] { p->go(); };
std::move(once)();                       // consumes; `once` is then valid-but-unspecified

// ---- construction / reset ------------------------------------------------
std::move_only_function<int(int)> m{std::in_place_type<Fn>, ctor_args...};  // in-place construct
m = nullptr;                                    // empty
m.swap(other);
bool empty = (m == nullptr);                    // only nullptr comparison exists
// no target(), no target_type(): NO RTTI introspection

// ---- typical use: a task queue of move-only work -------------------------
std::vector<std::move_only_function<void() &&>> queue;
queue.emplace_back([p = std::make_unique<Order>()] { submit(std::move(*p)); });
for (auto& j : queue) std::move(j)();
```

| Aspect | `std::function` | `std::move_only_function` (C++23) | `std::copyable_function` (C++26) |
|---|---|---|---|
| Copyable | yes (target must be) | **no** | yes |
| Move-only targets | rejected | accepted | rejected |
| `noexcept` in signature | no | **yes** | yes |
| `const` / `&` / `&&` qualifiers | no | **yes** | yes |
| Empty invocation | throws `bad_function_call` | **UB** | throws |
| `target()` / `target_type()` | yes (RTTI) | **no** | no |
| Const-correctness | `operator()` is `const` but may call a mutable target | qualifier is enforced on the target | enforced |
| Allocation | may allocate; SBO unspecified | may allocate; SBO unspecified | may allocate |

| Need | Choose |
|---|---|
| Copyable open-ended callback | `std::function` |
| Owning move-only task / one-shot continuation | `std::move_only_function` |
| Borrowed callable, synchronous call, no ownership | template `F&&`, `std::reference_wrapper`, or a project `function_ref` |
| Callable known at compile time | template parameter / concrete closure type |
| Closed set of alternatives | `std::variant` + visitor |

```cpp
// C++23 has NO std::function_ref (it lands in C++26). Minimal non-owning shape:
template<class Sig> class function_ref;
template<class R, class... A>
class function_ref<R(A...)> {
    void* obj_{};
    R (*call_)(void*, A...){};
public:
    template<class F> requires std::invocable<F&, A...>
    function_ref(F& f) noexcept
        : obj_(std::addressof(f)),
          call_([](void* o, A... a) -> R {
              return std::invoke(*static_cast<F*>(o), std::forward<A>(a)...); }) {}
    R operator()(A... a) const { return call_(obj_, std::forward<A>(a)...); }
};
// Binding a temporary to function_ref dangles — take F& (lvalue), not F&&.
```

**Traps** — empty call is UB, so guard with `operator bool` or an invariant · a `void() &&` wrapper is consumed by the call and must not be reused · `const`-qualified signatures require the target's `operator()` to be const, so `mutable` lambdas will not bind · no `target()` means no runtime type recovery · "move-only" says nothing about allocation.

---

## 14.8 Customization points, ADL, hidden friends, and CPOs

```cpp
// ---- ADL basics ---------------------------------------------------------
namespace qs {
struct Price {
    long ticks{};
    friend void swap(Price& a, Price& b) noexcept {     // HIDDEN FRIEND: only via ADL
        std::swap(a.ticks, b.ticks);
    }
    friend bool operator==(Price, Price) = default;      // hidden friend, symmetric conversions
    friend auto operator<=>(Price, Price) = default;
};
}
qs::Price a, b;
using std::swap;      // "std two-step": brings the fallback into scope
swap(a, b);           // unqualified: ADL finds qs::swap, std::swap is the fallback
// std::swap(a, b);   // qualified: NEVER finds the customization
std::ranges::swap(a, b);   // C++20 CPO: does the two-step for you, correctly

// Associated entities for ADL: the argument's class, its bases, its enclosing
// namespaces, template arguments' namespaces, and function-parameter types.
```

```cpp
// ---- writing a CPO -------------------------------------------------------
namespace qs::detail {
void consume() = delete;                       // POISON PILL: blocks accidental non-ADL hits

template<class T>
concept HasMember = requires(T&& x) { std::forward<T>(x).consume(); };
template<class T>
concept HasAdl    = requires(T&& x) { consume(std::forward<T>(x)); };

struct consume_fn {
    template<class T> requires HasMember<T> || HasAdl<T>
    constexpr decltype(auto) operator()(T&& x) const
        noexcept(HasMember<T> ? noexcept(std::forward<T>(x).consume())
                              : noexcept(consume(std::forward<T>(x))))
    {
        if constexpr (HasMember<T>) return std::forward<T>(x).consume();  // member wins
        else                        return consume(std::forward<T>(x));   // then ADL
    }
};
}
namespace qs {
inline constexpr detail::consume_fn consume_event{};   // ONE stable name, no ADL at the call site
}
```

```cpp
// ---- tag_invoke style (a library convention, NOT in the standard) --------
namespace qs {
inline constexpr struct get_id_t {
    template<class T> requires requires(T&& t, get_id_t c) { tag_invoke(c, (T&&)t); }
    constexpr auto operator()(T&& t) const { return tag_invoke(*this, (T&&)t); }
} get_id{};
}
struct Order { friend int tag_invoke(qs::get_id_t, Order const& o) { return o.id; } int id; };
// One ADL name (`tag_invoke`) carries every customization; tags stay unambiguous.
```

| Mechanism | Selection | When it fits |
|---|---|---|
| Virtual function | runtime, single dispatch | open set, needs an interface + heap object |
| Template + concept | compile time, exact type | fastest; requires the type at the call site |
| Class template specialization | compile time, explicit opt-in | `std::hash`, `std::formatter`, traits |
| ADL / hidden friend | compile time, argument-associated | `swap`, `begin/end`, operators |
| CPO (`inline constexpr` object) | compile time, controlled priority | library APIs needing one stable name |
| `tag_invoke` | compile time, one ADL name + tags | large customization families (senders) |

**Why a CPO over a plain function template**

- Its name is an *object*, so it never participates in ADL and cannot be hijacked at the call site.
- It centralizes the constraint, the `noexcept` computation, and the fallback priority.
- It can be passed as an argument to algorithms (a function template cannot, without a lambda).
- It is stateless and `inline constexpr`, so it inlines to nothing.
- Standard CPOs: `std::ranges::{begin,end,size,data,swap,iter_move,iter_swap}`, `std::ranges::to`, the `views::*` range adaptors.

**Traps** — an unconstrained catch-all ADL overload hijacks every call · calling the CPO's own name inside the CPO recurses forever instead of reaching the ADL target (use a distinct `detail` name or the poison pill) · forgetting to forward the value category silently copies · `noexcept(noexcept(...))` must mirror the branch actually taken · specializing `std` templates is only legal for the ones the standard permits and requires at least one program-defined type · hidden friends are invisible to qualified calls and to `std::` explicit qualification.

---

## 14.9 Overload sets and the overloaded-lambda visitor idiom

```cpp
// ---- an overload set is not an object ------------------------------------
void handle(int);
void handle(double);
// auto h = handle;                              // ill-formed: ambiguous, no target type
auto h1 = static_cast<void (*)(int)>(&handle);   // pick one
auto h2 = [](auto&&... a) -> decltype(auto) {    // pass the WHOLE set generically
    return handle(std::forward<decltype(a)>(a)...);
};
#define QS_LIFT(f) [](auto&&... a) noexcept(noexcept(f(std::forward<decltype(a)>(a)...))) \
    -> decltype(auto) { return f(std::forward<decltype(a)>(a)...); }
auto lifted = QS_LIFT(handle);                   // the standard "lifting" idiom

// ---- the Overload aggregate ----------------------------------------------
template<class... Fs> struct Overload : Fs... { using Fs::operator()...; };
template<class... Fs> Overload(Fs...) -> Overload<Fs...>;   // CTAD guide (unneeded since C++20)

struct Add { int qty; }; struct Cancel { int id; }; struct Trade { int px; };
using Event = std::variant<Add, Cancel, Trade>;

void process(Event const& e, Book& book) {
    std::visit(Overload{
        [&](Add    const& x) { book.on(x); },
        [&](Cancel const& x) { book.on(x); },
        [&](Trade  const& x) { book.on(x); },
    }, e);
}

// exhaustiveness: WITHOUT a generic arm, adding a variant alternative fails to compile.
// WITH one, it silently compiles and does nothing:
auto lenient = Overload{[](Add const&) {}, [](auto const&) { /* swallows new types */ }};

// ---- visit variations -----------------------------------------------------
auto tag = std::visit([](auto const& x) -> int { return sizeof x; }, e);       // generic arm
auto r   = std::visit<std::string>(Overload{...}, e);                          // C++20: explicit R
std::visit([](auto const& x, auto const& y) { /* ... */ }, e1, e2);            // N-ary: CARTESIAN product
if (auto* p = std::get_if<Add>(&e)) { /* ... */ }                              // no-throw probe
if (e.index() == 0) { /* ... */ }
if (std::holds_alternative<Trade>(e)) { /* ... */ }
// std::get<Add>(e) throws std::bad_variant_access on the wrong alternative
// visiting a valueless_by_exception variant throws std::bad_variant_access
```

```cpp
// ---- alternatives to visitation on the hot path ---------------------------
switch (e.index()) {                             // manual jump table, no visit machinery
    case 0: book.on(*std::get_if<Add>(&e));    break;
    case 1: book.on(*std::get_if<Cancel>(&e)); break;
    case 2: book.on(*std::get_if<Trade>(&e));  break;
}
```

| Dispatch | Cost | Exhaustiveness | Open/closed |
|---|---|---|---|
| `std::visit` + `Overload` | one indirect jump through a generated table | compile-time, unless a generic arm exists | closed |
| `e.index()` `switch` | direct switch; compiler builds the table | `-Wswitch` if you switch on an enum tag | closed |
| Virtual call | vtable indirection + heap object | none | open |
| `std::function` | erased indirect call + possible allocation | none | open |
| Template / concrete lambda | inlinable, zero indirection | n/a | closed at compile time |

**Interview line** — "`Overload` inherits each lambda's `operator()` and re-exposes them with `using Fs::operator()...`, turning N lambdas into one overload set for `std::visit`."

**Traps** — a `[](auto const&)` fallback destroys the only exhaustiveness check you get · N-ary `visit` instantiates `∏ alternatives` functions, exploding code size · `Overload{...}` capturing by `[&]` is fine only for a synchronous `visit` · `std::visit` on a valueless variant throws · duplicate alternative types in a `variant` make `std::get<T>`/type-based arms ambiguous — use `std::in_place_index` and index-based arms · lambdas taking `Add` by value in a visitor silently copy each event.

---

## 14.10 Selection and cost ledger

```text
function pointer    exact non-owning target; indirect call; noexcept is in the type
member pointer      not an address; needs an object; use std::invoke
lambda              unique closure class; NO inherent allocation
[x]                 copies x; handles inside x still borrow
[&x]                borrows x; never outlive it
[this] / [*this]    pointer copy / object copy
mutable             non-const operator(); no synchronization, no lifetime magic
static (C++23)      captureless call operator, no implicit object parameter
this auto&& self    C++23 recursive/forwarding lambdas
bind_front/back     decay-copy bound args; std::ref opts into borrowing
std::function       copyable erasure; may allocate; empty call THROWS; no noexcept sig
move_only_function  C++23 move-only erasure; may allocate; empty call is UB; qualifiers OK
ADL / hidden friend argument-associated customization; use the std two-step
CPO                 inline constexpr object: one stable name, controlled lookup
variant + Overload  closed-set typed dispatch; watch the Cartesian product
```

| Requirement | Design | Verify |
|---|---|---|
| Maximum inlining | template parameter / concrete closure | code size, compile time |
| C ABI callback | function pointer + `void*` context | context lifetime, indirect call |
| Closed alternative set | `variant` + `Overload` visitor | variant size, instantiation count |
| Open copyable callback | `std::function` | allocation, copy cost, empty-throw |
| Open move-only task | `std::move_only_function` | allocation, empty-call precondition |
| Borrowed synchronous callback | `F&&` template or `function_ref` | dangling on temporaries |
| Library customization | standard or project CPO | ADL correctness, constraints, `noexcept` |

**Hot-path checklist**

- Is the callable constructed once, or once per event?
- Does this exact standard library allocate for this exact target size? (measure; SBO is not portable)
- Can the optimizer see through the call site, or is the target erased?
- Is the indirect-branch target distribution predictable?
- Does specializing one handler per type inflate the instruction cache?
- Does captured state enlarge each queue element or straddle a cache line?
- Is callback ownership explicit, and does shutdown provably precede owner destruction?
- Is the signature `noexcept` where the caller cannot handle a throw?

**Interview line** — "A lambda is an object, not an allocation; allocation comes from where you *store* it."

---

## 14.11 Rapid diagnoses

| Symptom | Cause | Fix |
|---|---|---|
| Deferred callback reads freed state | `[this]` copied only a pointer | capture the field, `[*this]`, or `shared_from_this` keep-alive |
| Predicate returns garbage after the factory returns | `[&param]` on a by-value parameter | capture by value |
| `std::function` refuses a lambda | closure is move-only (init-capture of `unique_ptr`) | `std::move_only_function`, or capture a `shared_ptr` |
| `bad_function_call` at runtime | empty `std::function` invoked | check `operator bool` or establish a set-once invariant |
| Crash with no exception on an erased call | empty `move_only_function` invoked (UB) | guard with `operator bool` |
| `std::ref(local)` outlives the scope | erasure/binding never extends lifetimes | own the value or prove the lifetime |
| Counter resets unexpectedly | `mutable` closure was copied into `std::function` | store by reference or move once |
| Profiler shows `operator new` in a callback path | target exceeded the implementation SBO | shrink captures, use a fixed-capacity delegate, or pass a template |
| New `variant` alternative silently ignored | generic `[](auto const&)` arm | delete the fallback and let it fail to compile |
| Customization ignored | qualified call `std::swap(a, b)` | unqualified with `using std::swap`, or a `std::ranges::` CPO |
| Infinite recursion inside a CPO | the CPO calls its own name | poison pill plus a distinct `detail` name |
| Ambiguity for `auto f = overloaded_name;` | overload sets have no type | cast, or lift with a generic lambda |

---

## 14.12 Interview drill

1. **What is a lambda?** An expression producing an object of a unique unnamed closure class type.
2. **Does a lambda allocate?** Not inherently — storage context or an erasing wrapper may.
3. **What does `[this]` capture?** The pointer; the object must outlive every call.
4. **What does `[*this]` capture?** A copy of the object (C++17).
5. **Why is `operator()` const by default?** Value captures are the closure's state and are not modifiable through a const call unless `mutable`.
6. **What does `std::invoke` add?** One spelling for free functions, functors, member functions, and member data.
7. **Can `std::function` hold move-only state?** No — the target must be copy-constructible; use `std::move_only_function`.
8. **Is `std::function` allocation-free for small lambdas?** Only function pointers and `reference_wrapper` are guaranteed; wider SBO varies.
9. **`bind_front` versus a lambda?** Both own bound values; `bind_front` standardizes prefix binding and forwarding, a lambda expresses reordering and transformation.
10. **What is a hidden friend?** A non-member function defined inside a class, findable only through ADL.
11. **What is a CPO?** An `inline constexpr` function object implementing a controlled customization protocol via constraints and ADL.
12. **Why avoid a catch-all visitor arm?** It hides missing handling when a new alternative is added.
13. **Empty-call behavior?** `std::function` throws `bad_function_call`; `move_only_function` is UB.
14. **What is new about C++23 lambdas?** `static operator()`, explicit object parameter (`this auto&& self`), `bind_back`, `invoke_r`.
