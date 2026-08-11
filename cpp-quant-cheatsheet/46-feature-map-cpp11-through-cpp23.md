# 46. Feature map: C++11 through C++23

*Part VIII — Modern C++ evolution and interview drill*

---

**Recall**
- Standards land every three years: C++11 (`201103L`), C++14 (`201402L`), C++17 (`201703L`), C++20 (`202002L`), C++23 (`202302L`).
- `__cplusplus` names the *language mode selected*, never the set of facilities actually implemented.
- Every language feature has a `__cpp_*` macro; every library facility has a `__cpp_lib_*` macro exposed by `<version>` (C++20) or the facility's own header.
- Macro values are `YYYYMM` dates and are **bumped** when the feature is revised — compare with `>=`, never with `==`.
- Compiler front end, standard library, ABI library, and platform advance independently; `-std=c++23` does not imply `<generator>` exists.
- C++11 is the modern baseline: value categories, move semantics, lambdas, variadics, the memory model, and RAII ownership.
- C++14 is a patch release for generic code: generic lambdas, init-capture, return deduction, relaxed `constexpr`.
- C++17 adds vocabulary types (`optional`/`variant`/`any`/`string_view`) and compile-time branching (`if constexpr`, folds, CTAD).
- C++20 reshapes interfaces: concepts, ranges, coroutines, modules, `<=>`, `span`, `jthread`, atomic wait/notify.
- C++23 fills gaps: deducing `this`, `if consteval`, multi-arg `operator[]`, `expected`, `mdspan`, `print`, flat containers, `generator`.
- Attribution says nothing about cost — `shared_ptr`, `regex`, `std::function`, `any`, and `format` can all allocate.
- Views borrow and are lazy; `expected`/`optional` own; `span`/`string_view`/`mdspan` do not.
- `constexpr` *permits* constant evaluation; `consteval` *requires* it; `constinit` only forbids dynamic initialization.
- Removed, not merely deprecated: `auto_ptr` and dynamic exception specs (C++17), `result_of` and `<codecvt>` core pieces (C++17 deprecation → C++20/26 removal path), `random_shuffle` (C++17).
- Deprecated in C++23: `std::aligned_storage`, `std::aligned_union`, `std::is_pod`.
- A conditional facility must not change class layout or inline definitions inconsistently across TUs — that is an ODR/ABI bug, not a portability win.
- The interview answer is always "check the feature-test macro and measure", never "that's C++20 so it's fast".

---

## 46.1 C++11: move semantics, lambdas, variadics, atomics, threads, smart pointers

```cpp
// ---- value categories and move ---------------------------------------
struct Buf {
    Buf() = default;                                  // __cpp_defaulted_functions 200604
    Buf(Buf const&);                                  // copy
    Buf(Buf&&) noexcept;                              // move — rvalue ref binds xvalue/prvalue
    Buf& operator=(Buf const&) &;                     // ref-qualified member (C++11)
    Buf& operator=(Buf&&) & noexcept;
    Buf(Buf const&&) = delete;                        // __cpp_deleted_functions 200806
    ~Buf() noexcept;
};
Buf a;
Buf b = std::move(a);            // std::move is a static_cast<Buf&&> — moves NOTHING itself
Buf c = static_cast<Buf&&>(a);   // exactly equivalent spelling
template<class T> void sink(T&& t) { use(std::forward<T>(t)); } // forwarding ref + perfect fwd
auto&& r = make_buf();           // lifetime of temporary extended to r's scope
```

```cpp
// ---- lambdas: every C++11 capture form --------------------------------
int x = 1, y = 2;
auto l1 = []            { return 0; };        // no capture → convertible to int(*)()
auto l2 = [x]           { return x; };        // by copy
auto l3 = [&y]          { y++; };             // by reference
auto l4 = [=]           { return x + y; };    // all by copy (deprecated w/ this in C++20)
auto l5 = [&]           { x = y; };           // all by reference
auto l6 = [=, &y]       { y += x; };          // mixed, default copy
auto l7 = [&, x]        { y += x; };          // mixed, default reference
auto l8 = [x]() mutable { return ++x; };      // mutable: call operator not const
auto l9 = [] () noexcept -> double { return 1.0; };  // trailing return + noexcept
struct S { int m; auto f() { return [this] { return m; }; } };  // capture this (pointer!)
```

```cpp
// ---- variadic templates -----------------------------------------------
template<class... Ts> struct Pack { static constexpr std::size_t n = sizeof...(Ts); };
template<class... Ts> void log(Ts const&... xs) { int _[]{0, (sink(xs), 0)...}; (void)_; }
template<class T, class... A> std::unique_ptr<T> mk(A&&... a) {
    return std::unique_ptr<T>(new T(std::forward<A>(a)...));   // pack expansion
}
```

```cpp
// ---- other C++11 core syntax ------------------------------------------
auto  v = 42;                       // deduction (drops top-level cv/ref)
decltype(v)  w = v;                 // int
decltype((v)) z = v;                // int& — parenthesized id-expression is lvalue
auto f() -> int;                    // trailing return type
enum class Side : std::uint8_t { buy, sell };   // scoped + fixed underlying type
constexpr int sq(int n) { return n * n; }       // C++11: single return statement only
static_assert(sq(4) == 16, "msg");              // message required until C++17
alignas(64) std::atomic<int> counter;           // cache-line alignment
static_assert(alignof(double) == 8, "");
char* p = nullptr;                              // std::nullptr_t
using Fn = int(*)(int);                         // alias declaration
template<class T> using Vec = std::vector<T>;   // alias TEMPLATE (typedef cannot)
struct P { int a, b; P() : P(0, 0) {} P(int a_, int b_) : a{a_}, b{b_} {} };  // delegating
struct Q : P { using P::P; };                   // inheriting constructors
int arr[]{1, 2, 3};                             // uniform init
// int narrow{3.5};                             // ill-formed: narrowing
std::vector<int> vi{5, 7};                      // TWO elements — init-list ctor wins
constexpr long double operator""_bp(long double v) { return v * 1e-4L; }  // UDL
for (auto const& e : vi) { use(e); }            // range-for
thread_local int tls_id = 0;                    // thread storage duration
[[noreturn]] void fatal();                      // C++11 attribute syntax
long long big = 1LL; char16_t u = u'x'; char32_t U = U'x'; auto raw = R"(a\b)";
```

| C++11 language feature | Example | Feature-test macro |
|---|---|---|
| Rvalue refs / move | `T(T&&) noexcept` | `__cpp_rvalue_references` 200610 |
| Reference qualifiers | `T& operator=(…) &` | `__cpp_ref_qualifiers` 200710 |
| Lambdas | `[x](int i){…}` | `__cpp_lambdas` 200907 |
| Variadic templates | `template<class...Ts>` | `__cpp_variadic_templates` 200704 |
| `constexpr` | `constexpr int f()` | `__cpp_constexpr` 200704 |
| `decltype` | `decltype(e)` | `__cpp_decltype` 200707 |
| Alias templates | `template<class T> using V=…` | `__cpp_alias_templates` 200704 |
| `= default` / `= delete` | `T() = default;` | `__cpp_defaulted_functions` / `__cpp_deleted_functions` |
| Delegating ctors | `T() : T(0) {}` | `__cpp_delegating_constructors` 200604 |
| Inheriting ctors | `using Base::Base;` | `__cpp_inheriting_constructors` 200802 |
| Scoped enums | `enum class E : u8` | *(no macro; assume with `__cplusplus>=201103L`)* |
| `nullptr` | `T* p = nullptr;` | *(no macro)* |
| `alignas` / `alignof` | `alignas(64)` | `__cpp_alignas` / `__cpp_aligned_new` (C++17) |
| Attributes | `[[noreturn]]` | `__cpp_attributes` 200809 |
| User-defined literals | `operator""_bp` | `__cpp_user_defined_literals` 200809 |
| Raw/unicode literals | `R"(x)"`, `u8"x"` | `__cpp_raw_strings`, `__cpp_unicode_literals` |
| `static_assert` | `static_assert(c, "m")` | `__cpp_static_assert` 200410 |
| NSDMI | `struct S { int a = 1; };` | `__cpp_nsdmi` 200809 |
| Range-for | `for (auto& e : r)` | `__cpp_range_based_for` 200907 |
| `noexcept` | `void f() noexcept` | *(no macro; core)* |
| Explicit conversion ops | `explicit operator bool()` | *(no macro)* |
| Thread-local storage | `thread_local int i;` | *(no macro)* |

| C++11 library facility | Header | One-liner | Macro |
|---|---|---|---|
| `unique_ptr` | `<memory>` | `std::unique_ptr<T> p(new T);` | *(none; C++11 baseline)* |
| `shared_ptr` / `weak_ptr` | `<memory>` | `auto s = std::make_shared<T>();` | `__cpp_lib_shared_ptr_arrays` (C++17/20) |
| `std::thread` | `<thread>` | `std::thread t{f}; t.join();` | — |
| `mutex` / `lock_guard` / `unique_lock` | `<mutex>` | `std::lock_guard g{m};` | — |
| `condition_variable` | `<condition_variable>` | `cv.wait(lk, pred);` | — |
| `future` / `promise` / `async` | `<future>` | `auto f = std::async(g);` | — |
| `atomic<T>` + memory orders | `<atomic>` | `a.store(1, std::memory_order_release);` | — |
| `unordered_map/set` | `<unordered_map>` | `std::unordered_map<K,V> m;` | — |
| `array` | `<array>` | `std::array<int,4> a{};` | — |
| `forward_list` | `<forward_list>` | `fl.insert_after(fl.before_begin(), 1);` | — |
| `tuple` | `<tuple>` | `auto t = std::make_tuple(1, 'c');` | — |
| `<chrono>` | `<chrono>` | `auto t0 = std::chrono::steady_clock::now();` | — |
| `<random>` | `<random>` | `std::mt19937_64 g{seed};` | — |
| Type traits | `<type_traits>` | `std::is_trivially_copyable<T>::value` | — |
| `function` / `bind` / `ref` | `<functional>` | `std::function<int(int)> f = l;` | — |
| `<regex>` | `<regex>` | `std::regex_search(s, m, re);` | — |
| `<ratio>`, `<system_error>`, `<initializer_list>` | — | compile-time ratios / `error_code` | — |

**Traps** — `std::move` on a `const` lvalue silently copies · a moved-from standard object is valid-but-unspecified, not empty · `[=]` captures `this` by pointer, not `*this` · lambdas capture *variables*, never expressions · `noexcept(false)` moves force copies during `vector` reallocation · `shared_ptr` control-block refcounts are atomic and contended · `std::async` without a stored future blocks in `~future`.

---

## 46.2 C++14: generic lambdas, return deduction, variable templates

```cpp
auto proj  = [](auto const& x)              { return x.price(); };   // generic lambda
auto proj2 = [](auto&&... xs)               { return sizeof...(xs); };
auto own   = [p = std::make_unique<T>()]    { return p->v; };        // init-capture (move)
auto alias = [&r = big_object]              { return r.size(); };    // init-capture by ref

auto twice(int x)           { return x * 2; }        // return type deduction
decltype(auto) fwd(Vec& v)  { return v[0]; }         // exact: returns int&, not int
auto& at(Vec& v)            { return v[0]; }

template<class T> constexpr T pi_v = T(3.1415926535897932385L);      // variable template
template<class T> constexpr bool cheap_v = std::is_nothrow_move_constructible<T>::value;

constexpr int fact(int n) {                          // relaxed constexpr: loops + locals
    int r = 1;
    for (int i = 2; i <= n; ++i) r *= i;             // ill-formed in C++11
    return r;
}
auto mask   = 0b1011'0000u;                          // binary literal + digit separator
auto secs   = 1500ms;                                // std::chrono UDL (using namespace)
auto str    = "abc"s;                                // std::string UDL
[[deprecated("use parse2")]] int parse(char const*);
```

| C++14 feature | Example | Macro |
|---|---|---|
| Generic lambdas | `[](auto x){}` | `__cpp_generic_lambdas` 201304 |
| Lambda init-capture | `[p = std::move(q)]{}` | `__cpp_init_captures` 201304 |
| Return type deduction | `auto f() { return 1; }` | `__cpp_return_type_deduction` 201304 |
| `decltype(auto)` | `decltype(auto) f()` | `__cpp_decltype_auto` 201304 |
| Variable templates | `template<class T> T pi_v;` | `__cpp_variable_templates` 201304 |
| Relaxed `constexpr` | loops/locals in `constexpr` | `__cpp_constexpr` **201304** |
| Aggregate NSDMI | `struct A{int x=1;}; A a{2};` | `__cpp_aggregate_nsdmi` 201304 |
| Binary literals | `0b1010` | `__cpp_binary_literals` 201304 |
| Digit separators | `1'000'000` | `__cpp_digit_separators` 201309 |
| `[[deprecated]]` | `[[deprecated("m")]]` | *(via `__has_cpp_attribute(deprecated)`)* |
| Sized deallocation | `operator delete(void*, size_t)` | `__cpp_sized_deallocation` 201309 |

| C++14 library | Example | Macro |
|---|---|---|
| `make_unique` | `auto p = std::make_unique<T>(a, b);` | `__cpp_lib_make_unique` 201304 |
| `shared_timed_mutex` + `shared_lock` | `std::shared_lock lk{m};` | `__cpp_lib_shared_timed_mutex` 201402 |
| `integer_sequence` | `std::make_index_sequence<N>{}` | `__cpp_lib_integer_sequence` 201304 |
| Transparent comparators | `std::map<K,V,std::less<>>` | `__cpp_lib_transparent_operators` 201510 |
| `get<T>(tuple)` | `std::get<int>(t)` | `__cpp_lib_tuple_element_t` / `tuples_by_type` 201304 |
| `exchange` | `auto old = std::exchange(v, 0);` | `__cpp_lib_exchange_function` 201304 |
| `quoted` | `os << std::quoted(s);` | `__cpp_lib_quoted_string_io` 201304 |
| `_t` trait aliases | `std::enable_if_t<C, T>` | `__cpp_lib_transformation_trait_aliases` 201304 |
| `cbegin`/`rbegin` free fns | `std::cbegin(c)` | `__cpp_lib_non_member_container_access` (C++17) |
| Null forward iterators | `Iter{} == Iter{}` | `__cpp_lib_null_iterators` 201304 |
| Heterogeneous `is_final`, `chrono`/`string` UDLs | `1s`, `"x"s` | `__cpp_lib_chrono_udls`, `__cpp_lib_string_udls` |

**Traps** — a generic lambda instantiates one call operator *per argument type* (code bloat) · `auto` return type strips references, `decltype(auto)` does not · `decltype(auto) f(){ return x; }` vs `return (x);` differ (value vs dangling ref) · `constexpr` member functions stopped being implicitly `const` in C++14 (a silent overload change).

---

## 46.3 C++17: structured bindings, `if constexpr`, fold expressions, vocabulary types, PMR

```cpp
// ---- structured bindings: all three cases -----------------------------
std::pair<int, std::string> p{1, "a"};
auto  [i, s]  = p;                       // copy of p, then bind members
auto& [ri, rs] = p;                      // bind to p itself
auto const& [ci, cs] = p;
int arr[2]{1, 2};        auto [a0, a1] = arr;            // array case
struct Agg { int q; double px; };  Agg g{1, 2.0};
auto [qty, price] = g;                                   // public non-static members
for (auto const& [k, v] : map) { use(k, v); }            // canonical map loop
if (auto [it, ok] = m.try_emplace(k, v); ok) { use(it); }// init-statement (C++17)
switch (auto n = next(); n) { default: break; }
```

```cpp
// ---- if constexpr: discards the untaken branch ------------------------
template<class T> auto encode(T const& x) {
    if constexpr (std::is_integral_v<T>)          return encode_int(x);
    else if constexpr (std::is_floating_point_v<T>) return encode_f64(x);
    else                                          return x.encode();   // not instantiated
}
```

```cpp
// ---- all four fold shapes ---------------------------------------------
template<class... T> auto sum_ur(T... x)  { return (x + ...);      } // unary right: x1+(x2+x3)
template<class... T> auto sum_ul(T... x)  { return (... + x);      } // unary left: (x1+x2)+x3
template<class... T> auto sum_br(T... x)  { return (x + ... + 0);  } // binary right
template<class... T> auto sum_bl(T... x)  { return (0 + ... + x);  } // binary left
template<class... T> bool all_of(T... b)  { return (b && ...);     } // empty pack → true
template<class... T> void print_all(T const&... x) { ((std::cout << x << ' '), ...); } // comma
```

```cpp
// ---- other C++17 core --------------------------------------------------
std::vector v{1, 2, 3};                 // CTAD → vector<int>
std::pair pr{1, 2.0};                   // CTAD → pair<int,double>
template<class T> Wrap(T) -> Wrap<T>;   // deduction guide
inline constexpr int kMax = 64;         // inline variable: one entity across TUs
namespace qs::feed { }                  // nested namespace definition
constexpr auto cl = [](int n){ return n * 2; };  static_assert(cl(2) == 4); // constexpr lambda
auto cpy = [*this]{ return field; };    // capture *this by copy (C++17)
[[nodiscard]] int must_use();
[[maybe_unused]] int dbg = 0;
switch (c) { case 1: f(); [[fallthrough]]; case 2: g(); break; }
template<auto N> struct Konst { static constexpr auto value = N; };  // auto NTTP
std::byte b{0xFF};  auto shifted = b << 2;   // no arithmetic, only bitops + to_integer
static_assert(sizeof(int) == 4);             // message optional (C++17)
if constexpr (sizeof(void*) == 8) { }        // works outside templates too
```

| C++17 language | Example | Macro |
|---|---|---|
| Structured bindings | `auto [a,b] = p;` | `__cpp_structured_bindings` 201606 |
| `if constexpr` | `if constexpr (cond)` | `__cpp_if_constexpr` 201606 |
| Fold expressions | `(x + ...)` | `__cpp_fold_expressions` 201603 |
| CTAD | `std::vector v{1,2};` | `__cpp_deduction_guides` 201703 |
| Inline variables | `inline constexpr int k=1;` | `__cpp_inline_variables` 201606 |
| Guaranteed copy elision | `T t = T(T(T()));` | `__cpp_guaranteed_copy_elision` 201606 |
| `constexpr` lambdas | `constexpr auto l=[]{};` | `__cpp_constexpr` **201603** |
| Capture `*this` | `[*this]{}` | `__cpp_capture_star_this` 201603 |
| `auto` NTTP | `template<auto N>` | `__cpp_nontype_template_parameter_auto` 201606 |
| Init-statement in `if`/`switch` | `if (auto x=f(); x)` | *(no macro)* |
| Nested namespaces | `namespace a::b {}` | `__cpp_namespace_attributes` / core |
| `noexcept` in type system | `void(*)() noexcept` | `__cpp_noexcept_function_type` 201510 |
| Hex float literals | `0x1.8p3` | `__cpp_hex_float` 201603 |
| `__has_include` | `#if __has_include(<x>)` | `__has_include` |
| Aligned `new`/`delete` | `new (std::align_val_t{64}) T` | `__cpp_aligned_new` 201606 |
| Class template `template<auto>`, `static_assert` w/o msg | — | `__cpp_static_assert` 201411 |

| C++17 library | Example | Macro |
|---|---|---|
| `optional<T>` | `std::optional<int> o = 5; if (o) use(*o);` | `__cpp_lib_optional` 201606 |
| `variant<Ts…>` | `std::visit(ov, var);` | `__cpp_lib_variant` 201606 |
| `any` | `std::any_cast<int>(a)` | `__cpp_lib_any` 201606 |
| `string_view` | `void f(std::string_view sv);` | `__cpp_lib_string_view` 201606 |
| `<filesystem>` | `std::filesystem::exists(p)` | `__cpp_lib_filesystem` 201703 |
| `<charconv>` | `std::from_chars(b, e, value);` | `__cpp_lib_to_chars` 201611 |
| PMR | `std::pmr::monotonic_buffer_resource r{buf, n};` | `__cpp_lib_memory_resource` 201603 |
| Parallel algorithms | `std::sort(std::execution::par, b, e);` | `__cpp_lib_parallel_algorithm` 201603 |
| `scoped_lock` | `std::scoped_lock lk{m1, m2};` | `__cpp_lib_scoped_lock` 201703 |
| `shared_mutex` | `std::shared_lock lk{sm};` | `__cpp_lib_shared_mutex` 201505 |
| `byte` | `std::to_integer<int>(b)` | `__cpp_lib_byte` 201603 |
| `apply` | `std::apply(f, tup);` | `__cpp_lib_apply` 201603 |
| `invoke` | `std::invoke(&S::m, obj);` | `__cpp_lib_invoke` 201411 |
| `invoke_result` | `std::invoke_result_t<F, A>` | `__cpp_lib_is_invocable` 201703 |
| `*_v` trait variables | `std::is_integral_v<T>` | `__cpp_lib_type_trait_variable_templates` 201510 |
| `void_t`, `conjunction`… | `std::conjunction_v<A,B>` | `__cpp_lib_void_t`, `__cpp_lib_logical_traits` |
| Node handles / `merge` | `m.extract(k); m2.insert(std::move(nh));` | `__cpp_lib_node_extract` 201606 |
| `try_emplace` / `insert_or_assign` | `m.try_emplace(k, a, b);` | `__cpp_lib_map_try_emplace` 201411 |
| `emplace_back` returns `T&` | `T& r = v.emplace_back();` | `__cpp_lib_sample`-era; see `__cpp_lib_array_constexpr` |
| `clamp`, `gcd`, `lcm`, `sample` | `std::clamp(x, lo, hi)` | `__cpp_lib_clamp`, `__cpp_lib_gcd_lcm`, `__cpp_lib_sample` |
| `not_fn` | `std::not_fn(pred)` | `__cpp_lib_not_fn` 201603 |
| `launder`, `as_const`, `size/empty/data` | `std::as_const(x)` | `__cpp_lib_launder`, `__cpp_lib_as_const`, `__cpp_lib_nonmember_container_access` |
| `uncaught_exceptions` | `std::uncaught_exceptions()` | `__cpp_lib_uncaught_exceptions` 201411 |
| `has_unique_object_representations` | trait | `__cpp_lib_has_unique_object_representations` |

**Traps** — `if constexpr` still requires both branches to *parse*, and a non-dependent bad branch is still diagnosed · `std::visit` on a valueless variant throws `bad_variant_access` · `string_view` does not own and is not NUL-terminated (`.data()` into a C API is a bug) · `optional<T&>` does not exist until C++26 · CTAD ignores the constructor's *implicit* conversions you assumed · PMR containers of different resources are different runtime behaviors but the same type · execution policies may terminate on escaped exceptions.

---

## 46.4 C++20: concepts, ranges, coroutines, modules, `<=>`, `span`, `jthread`, atomic wait

```cpp
// ---- concepts: every constraint spelling ------------------------------
template<class T> concept Tick = std::integral<T> && !std::same_as<T, bool>;

template<Tick T>            T mid1(T l, T h);                       // constrained TP
template<class T> requires Tick<T>   T mid2(T l, T h);              // requires-clause
template<class T> T mid3(T l, T h) requires Tick<T>;                // trailing requires
Tick auto mid4(Tick auto l, Tick auto h);                           // abbreviated + placeholder
void g(std::integral auto x);                                       // constrained auto param

template<class T> concept Feed = requires(T t, Msg const& m) {
    t.on(m);                                     // simple requirement
    { t.size() } -> std::convertible_to<std::size_t>;  // compound + return constraint
    typename T::value_type;                      // type requirement
    requires std::movable<T>;                    // nested requirement
    { t.pop() } noexcept;                        // noexcept requirement
};
static_assert(requires { typename int; } == false || true);         // requires-expression is bool
```

```cpp
// ---- ranges -------------------------------------------------------------
auto pipeline = prices
    | std::views::filter([](double p){ return p > 0; })
    | std::views::transform([](double p){ return p * 2; })
    | std::views::take(10)
    | std::views::reverse;
std::ranges::sort(v, std::ranges::less{}, &Order::price);   // range + comparator + PROJECTION
auto [lo, hi] = std::ranges::minmax(v);
std::ranges::for_each(v, f);
for (auto&& [idx, val] : std::views::zip(std::views::iota(0), v)) { } // zip/iota (C++23 zip)
```

```cpp
// ---- coroutines --------------------------------------------------------
Task<int> run() {
    int v = co_await fetch();     // suspend; awaiter drives resumption
    co_yield v;                   // generator-style (needs yield_value)
    co_return v;                  // finishes; sets promise result
}
// Any of co_await/co_yield/co_return makes the function a coroutine; the return type's
// promise_type supplies initial_suspend/final_suspend/get_return_object/unhandled_exception.
```

```cpp
// ---- <=> and the rewritten candidates -----------------------------------
struct Px {
    long ticks;
    auto operator<=>(Px const&) const = default;    // defaulted → also gives ==, <, >, <=, >=
};
struct Q2 {
    double v;
    std::partial_ordering operator<=>(Q2 const& o) const { return v <=> o.v; } // NaN → unordered
    bool operator==(Q2 const& o) const { return v == o.v; }  // == NOT auto-derived from custom <=>
};
static_assert((1 <=> 2) < 0);                       // std::strong_ordering
```

```cpp
// ---- other C++20 core ---------------------------------------------------
struct Cfg { int a; int b; };
Cfg c{.a = 1, .b = 2};                     // designated initializers, DECLARATION ORDER only
consteval int must_fold(int n) { return n + 1; }     // immediate function
constinit static int g_id = must_fold(1);            // static-init required, NOT const
constexpr std::vector<int> cv() { std::vector<int> v{1}; return v.size(); } // constexpr new/delete
auto tl = []<class T>(std::vector<T> const& v) { return v.size(); };  // templated lambda
struct Empty {}; struct Packed { [[no_unique_address]] Empty e; int n; }; // sizeof == 4
if (x) [[likely]] { fast(); } else [[unlikely]] { slow(); }
std::vector<int> pv(std::from_range_t{}, r);    // (C++23); C++20: aggregate paren-init
struct Agg2 { int a, b; };  auto ap = Agg2(1, 2);    // paren init of aggregates (C++20)
using enum Side;                                     // using enum (C++20)
char8_t u8c = u8'x';
export module qs.feed;  import std;                  // modules (toolchain-gated)
```

| C++20 language | Example | Macro |
|---|---|---|
| Concepts | `template<Tick T>` | `__cpp_concepts` 201907 |
| Ranged constraints on `auto` | `void f(std::integral auto)` | `__cpp_concepts` 201907 |
| Coroutines | `co_await`/`co_yield`/`co_return` | `__cpp_impl_coroutine` (lang) / `__cpp_lib_coroutine` (lib) |
| Modules | `export module m;` | `__cpp_modules` 201907 |
| Three-way comparison | `auto operator<=>(…)=default;` | `__cpp_impl_three_way_comparison` 201907 |
| Designated initializers | `T{.a=1}` | `__cpp_designated_initializers` 201707 |
| `consteval` | `consteval int f()` | `__cpp_consteval` 201811 |
| `constinit` | `constinit int g;` | `__cpp_constinit` 201907 |
| `constexpr` dynamic alloc | `new` in constant eval | `__cpp_constexpr_dynamic_alloc` 201907 |
| `constexpr` virtual / try / union | — | `__cpp_constexpr` **201907** |
| Templated lambdas | `[]<class T>(T){}` | `__cpp_generic_lambdas` **201707** |
| Init-capture pack expansion | `[...xs = f()]{}` | `__cpp_init_captures` **201803** |
| Abbreviated templates | `void f(auto x)` | `__cpp_generic_lambdas` / `__cpp_concepts` |
| Class-type NTTPs | `template<Fixed S>` | `__cpp_nontype_template_args` 201911 |
| `[[likely]]`/`[[unlikely]]` | `if(c)[[likely]]` | `__has_cpp_attribute(likely)` 201803 |
| `[[no_unique_address]]` | `[[no_unique_address]] E e;` | `__has_cpp_attribute(no_unique_address)` 201803 |
| `using enum` | `using enum Side;` | `__cpp_using_enum` 201907 |
| Aggregate paren init | `Agg(1,2)` | `__cpp_aggregate_paren_init` 201902 |
| `char8_t` | `u8'x'` | `__cpp_char8_t` 201811 |
| Conditionally explicit | `explicit(cond)` | `__cpp_conditional_explicit` 201806 |
| `constexpr` `try`/`dynamic_cast`/`typeid` | — | `__cpp_constexpr` 201907 |
| Immediate-context `if constexpr` in lambdas, CTAD for aggregates/alias | — | `__cpp_deduction_guides` **201907** |

| C++20 library | Example | Macro |
|---|---|---|
| `<concepts>` | `std::same_as<T,U>` | `__cpp_lib_concepts` 202002 |
| `<ranges>` | `v \| std::views::take(3)` | `__cpp_lib_ranges` 202110 |
| `<span>` | `std::span<int> s{v};` | `__cpp_lib_span` 202002 |
| `<format>` | `std::format("{:.2f}", x)` | `__cpp_lib_format` 202110 |
| `jthread` | `std::jthread t{[](std::stop_token s){}};` | `__cpp_lib_jthread` 201911 |
| `stop_token`/`stop_source`/`stop_callback` | `s.request_stop();` | `__cpp_lib_jthread` 201911 |
| `counting_semaphore` / `binary_semaphore` | `sem.acquire();` | `__cpp_lib_semaphore` 201907 |
| `latch` / `barrier` | `l.arrive_and_wait();` | `__cpp_lib_latch`, `__cpp_lib_barrier` |
| Atomic wait/notify | `a.wait(old); a.notify_one();` | `__cpp_lib_atomic_wait` 201907 |
| `atomic_ref` | `std::atomic_ref{x}.fetch_add(1);` | `__cpp_lib_atomic_ref` 201806 |
| `atomic<shared_ptr<T>>` | lock-free-ish refcount swap | `__cpp_lib_atomic_shared_ptr` 201711 |
| `atomic<float/double>` fetch_add | `a.fetch_add(1.0);` | `__cpp_lib_atomic_float` 201711 |
| `<bit>` | `std::popcount(x)`, `std::bit_cast<U>(x)` | `__cpp_lib_bitops` 201907, `__cpp_lib_bit_cast` 201806 |
| `std::endian` | `std::endian::native == std::endian::little` | `__cpp_lib_endian` 201907 |
| `<source_location>` | `std::source_location::current()` | `__cpp_lib_source_location` 201907 |
| `<syncstream>` | `std::osyncstream{std::cout} << x;` | `__cpp_lib_syncstream` 201803 |
| `erase`/`erase_if` free fns | `std::erase_if(v, pred);` | `__cpp_lib_erase_if` 202002 |
| `starts_with`/`ends_with` | `s.starts_with("AAPL")` | `__cpp_lib_starts_ends_with` 201711 |
| `contains` (associative) | `m.contains(k)` | `__cpp_lib_generic_unordered_lookup` 201811 |
| `midpoint` / `lerp` | `std::midpoint(a, b)` | `__cpp_lib_interpolate` 201902 |
| `ssize` | `std::ssize(v)` | `__cpp_lib_ssize` 201902 |
| `bind_front` | `std::bind_front(f, a)` | `__cpp_lib_bind_front` 201907 |
| `is_constant_evaluated` | `if (std::is_constant_evaluated())` | `__cpp_lib_is_constant_evaluated` 201811 |
| `assume_aligned` | `std::assume_aligned<64>(p)` | `__cpp_lib_assume_aligned` 201811 |
| `to_address` | `std::to_address(it)` | `__cpp_lib_to_address` 201711 |
| Calendar/time zones | `std::chrono::zoned_time{tz, tp}` | `__cpp_lib_chrono` 201907 |
| `constexpr` algorithms / `string` / `vector` | — | `__cpp_lib_constexpr_algorithms`, `_string`, `_vector` |
| `<numbers>` | `std::numbers::pi_v<double>` | `__cpp_lib_math_constants` 201907 |
| `<version>` header itself | `#include <version>` | `__cpp_lib_...` all live here |

```cpp
// ---- jthread cooperative stop -------------------------------------------
std::jthread worker([](std::stop_token st) {
    while (!st.stop_requested()) poll_once();       // must be checked by YOUR loop
});                                                  // dtor: request_stop() then join()
std::stop_callback cb{worker.get_stop_token(), []{ cv.notify_all(); }};  // wake blocked waits
```

**Traps** — views dangle when the underlying range is a temporary (`f() | views::filter(...)`) · adaptors weaken iterator category (a `filter_view` is not random-access, so `ranges::sort` may not apply) · `filter_view::begin()` is O(n) and caches · a defaulted `<=>` gives `==` but a *user-written* `<=>` does not · `consteval` functions cannot be called from non-`constexpr` runtime paths · `constexpr` allocation must be freed before the constant evaluation ends · modules need a build system that orders BMI generation · `atomic::wait` may be a futex or a spin depending on the implementation.

---

## 46.5 C++23 language: explicit object parameters, `if consteval`, static call/subscript operators, multidimensional subscript, constexpr extensions

```cpp
// ---- deducing this ------------------------------------------------------
struct Buffer {
    std::vector<std::byte> bytes;
    template<class Self>
    auto&& data(this Self&& self) noexcept {         // ONE function replaces 4 cv/ref overloads
        return std::forward<Self>(self).bytes;       // &, const&, &&, const&&
    }
    void inc(this Buffer& self) { self.n++; }        // no implicit `this` inside
    int n{};
};
// Recursive lambda without y-combinator:
auto fib = [](this auto&& self, int n) -> int { return n < 2 ? n : self(n-1) + self(n-2); };
// CRTP without inheritance: `this Self&&` gives you the derived type directly.
```

```cpp
// ---- if consteval -------------------------------------------------------
constexpr int scale(int x) {
    if consteval { return x * 2; }        // manifestly constant-evaluated path
    else         { return x << 1; }       // runtime path (may use intrinsics)
}
constexpr int y = scale(4);   // takes the consteval branch
// if !consteval { … } is also valid; unlike std::is_constant_evaluated() it may call consteval fns.
```

```cpp
// ---- static operator() and static operator[] ----------------------------
struct Add { static constexpr int operator()(int a, int b) noexcept { return a + b; } };
static_assert(Add{}(2, 3) == 5);          // no object passed → no this in registers
struct Zeros { static constexpr int operator[](std::size_t) noexcept { return 0; } };
```

```cpp
// ---- multidimensional subscript -----------------------------------------
struct Matrix {
    double cells[3][4]{};
    constexpr double& operator[](std::size_t r, std::size_t c) noexcept { return cells[r][c]; }
};
Matrix m; m[1, 2] = 7.0;                  // comma in [] is no longer the comma operator
```

```cpp
// ---- other C++23 core ---------------------------------------------------
auto copy = auto(expr);                   // decay-copy, prvalue
auto brace = auto{expr};                  // same, braced spelling
std::size_t n = 3uz;  auto sn = 3z;       // size_t / signed size_t literal suffixes
#ifdef FOO
#elifdef BAR                              // #elifdef / #elifndef
#elifndef BAZ
#endif
auto lam = []() [[nodiscard]] { return 1; };   // attributes on lambdas
void f() { done: }                             // label at end of compound statement
template<class T> void g() { static_assert(false, "never instantiate"); } // OK if uninstantiated
auto esc = "\u{1F600}\N{LATIN SMALL LETTER A}";  // delimited + named UCN escapes
constexpr auto s = []{ std::string t = "x"; return t.size(); }();  // non-literal vars in constexpr
[[assume(x > 0)]];                        // C++23 assumption attribute
```

| C++23 language | Example | Macro |
|---|---|---|
| Explicit object parameter | `auto f(this Self&&)` | `__cpp_explicit_this_parameter` 202110 |
| `if consteval` | `if consteval { }` | `__cpp_if_consteval` 202106 |
| Static `operator()` | `static int operator()(…)` | `__cpp_static_call_operator` 202207 |
| Multidim / static `operator[]` | `m[i, j]` | `__cpp_multidimensional_subscript` 202211 |
| `auto(x)` decay-copy | `auto(v)` | `__cpp_auto_cast` 202110 |
| `size_t` literals | `3uz` | `__cpp_size_t_suffix` 202011 |
| `#elifdef` / `#elifndef` | preprocessor | `__cpp_preprocessor` era; test `__cplusplus>=202302L` |
| Named universal escapes | `"\N{BULLET}"` | `__cpp_named_character_escapes` 202207 |
| Delimited escapes | `"\u{1F600}"` | `__cpp_delimited_escape_sequences` 202207 |
| Attributes on lambdas | `[]() [[nodiscard]] {}` | *(via `__has_cpp_attribute`)* |
| `[[assume(e)]]` | optimizer assumption | `__has_cpp_attribute(assume)` 202207 |
| Simpler implicit move | `return local_lvalue;` moves | `__cpp_implicit_move` 202207 |
| `static_assert(false)` in templates | CWG2518 | *(no macro; check toolchain)* |
| `constexpr` relaxations | goto/labels/non-literal vars | `__cpp_constexpr` **202306** |
| `constexpr` `cmath`/`cstdlib` (P0533) | `constexpr std::abs(x)` | `__cpp_lib_constexpr_cmath` 202306 |
| Extended floating-point types | `std::float32_t` | `__cpp_lib_extended_float_types`/`__STDCPP_FLOAT32_T__` |

**Traps** — an explicit-object member function cannot be `virtual`, `static`, or cv/ref-qualified, and has no implicit `this` · `this Self&&` templates can be instantiated with a *derived* `Self`, so `sizeof(Self)` may surprise · `[[assume]]` on a false expression is UB, not a check · `if consteval` is not the same as `std::is_constant_evaluated()` inside `constexpr` *initializers* of non-constant contexts · `m[1, 2]` silently changed meaning from the comma operator — old code is deprecated then ill-formed.

---

## 46.6 C++23 library: `expected`, `mdspan`, `print`, `stacktrace`, `flat_map`, `flat_set`, `generator`, `move_only_function`, range expansions, `byteswap`, `to_underlying`, `out_ptr`, and scope guards

```cpp
// ---- expected<T, E> ------------------------------------------------------
#include <expected>
enum class ParseError { empty, invalid, overflow };
std::expected<std::int64_t, ParseError> parse(std::string_view) noexcept;

auto r = parse(field);
if (r)              use(*r);                       // operator bool / operator*
else                handle(r.error());
auto v  = r.value();                                // throws std::bad_expected_access<E>
auto v2 = r.value_or(0);
auto out = parse(field)
    .transform  ([](std::int64_t x){ return Ticks{x}; })   // T -> U
    .and_then   ([](Ticks t) -> std::expected<Px, ParseError> { return Px{t}; })
    .transform_error([](ParseError e){ return to_string(e); })
    .or_else    ([](auto e){ return std::expected<Px, std::string>{std::unexpect, "bad"}; });
std::expected<void, ParseError> ok{};               // void specialization
auto err = std::unexpected{ParseError::empty};      // CTAD-friendly error factory
```

```cpp
// ---- mdspan ---------------------------------------------------------------
#include <mdspan>
std::array<double, 12> storage{};
std::mdspan m{storage.data(), 3, 4};                            // dynamic extents, layout_right
std::mdspan<double, std::extents<std::size_t, 3, 4>> ms{storage.data()};   // static extents
std::mdspan<double, std::dextents<std::size_t, 2>, std::layout_left> ml{storage.data(), 3, 4};
m[1, 2] = 7.0;                                                  // multidim subscript
auto rows = m.extent(0), cols = m.extent(1);
auto n    = m.size();  auto ok = m.is_exhaustive();
std::mdspan sub = std::submdspan(m, std::full_extent, std::pair{1, 3});   // C++26
```

```cpp
// ---- print / println -------------------------------------------------------
#include <print>
std::print("{} @ {:.4f}\n", sym, px);
std::println("qty={:>8}", qty);                     // adds newline
std::print(stderr, "err {}\n", code);
std::println(std::cout, "{}", x);                   // ostream overload
```

```cpp
// ---- flat containers (adaptors, not new containers) ------------------------
#include <flat_map>
std::flat_map<int, double> fm{{1, 1.0}, {2, 2.0}};  // keys vector + values vector (SoA)
fm.insert({3, 3.0});                                 // O(n) shift
auto ks = fm.keys();  auto vs = fm.values();         // contiguous, spannable
std::flat_multimap<int, double> fmm;
#include <flat_set>
std::flat_set<int> fs{3, 1, 2};                      // sorted vector<int>
```

```cpp
// ---- generator --------------------------------------------------------------
#include <generator>
std::generator<int> evens(int n) { for (int i = 0; i < n; i += 2) co_yield i; }
for (int i : evens(10)) use(i);                     // input_range, single-pass
std::generator<int> nested(int n) { co_yield std::ranges::elements_of(evens(n)); }
```

```cpp
// ---- other C++23 utilities ---------------------------------------------------
std::move_only_function<int(int) const noexcept> f = [p = std::make_unique<T>()](int){ return 1; };
std::copyable_function<int(int)> g2 = f2;            // C++26
{ std::scope_exit    se{[&]{ close(fd); }};          // <scope>, always
  std::scope_fail    sf{[&]{ rollback(); }};         // only if exception escapes
  std::scope_success ss{[&]{ commit(); }}; }         // only on normal exit
std::unique_resource res{fd, ::close};               // <scope>
auto be = std::byteswap(std::uint32_t{0x01020304});  // <bit> → 0x04030201
auto u  = std::to_underlying(Side::buy);             // <utility> → std::uint8_t
{ std::unique_ptr<C, Del> p; if (c_create(std::out_ptr(p)) != 0) fail(); }   // <memory>
{ std::unique_ptr<C, Del> p; c_resize(std::inout_ptr(p), n); }
std::unreachable();                                  // <utility> — reaching it is UB
auto fw = std::forward_like<Self>(member);           // <utility> cv/ref propagation
auto ir = std::invoke_r<int>(f, 1);                  // <functional> explicit return type
auto bb = std::bind_back(f, last_arg);               // <functional>
auto*  o = std::start_lifetime_as<Header>(buffer);   // <memory> implicit-lifetime
auto al = std::allocate_at_least(alloc, 100);        // {ptr, count >= 100}
bool has = s.contains("AAPL");                       // std::string::contains (C++23)
std::ispanstream in{std::span{buf}};                 // <spanstream> — no allocation
std::println("{}", std::stacktrace::current());      // <stacktrace>
std::optional<int> o2 = maybe().and_then(f).transform(g).or_else(h);  // monadic optional (C++23)
```

```cpp
// ---- range expansions ---------------------------------------------------------
auto v  = rng | std::ranges::to<std::vector>();                       // ranges::to
auto m2 = pairs | std::ranges::to<std::map<int, double>>();
for (auto [a, b]  : std::views::zip(xs, ys))            use(a, b);
for (auto s       : std::views::zip_transform(add, xs, ys)) use(s);
for (auto [p, q]  : std::views::adjacent<2>(xs))        use(p, q);    // sliding pairs
for (auto d       : std::views::adjacent_transform<2>(xs, diff)) use(d);
for (auto c       : std::views::chunk(xs, 4))           use(c);
for (auto w       : std::views::slide(xs, 3))           use(w);
for (auto g3      : std::views::chunk_by(xs, same_sym)) use(g3);
for (auto e       : std::views::stride(xs, 2))          use(e);
for (auto e       : std::views::repeat(0, 8))           use(e);
for (auto [a, b]  : std::views::cartesian_product(xs, ys)) use(a, b);
for (auto e       : std::views::join_with(xss, ','))    use(e);
for (auto e       : std::views::as_rvalue(xs))          sink(std::move(e));
for (auto e       : std::views::enumerate(xs))          use(e);       // {index, ref}
auto total = std::ranges::fold_left(xs, 0, std::plus{});
auto tl2   = std::ranges::fold_left_first(xs, std::plus{});           // optional<T>
auto tr    = std::ranges::fold_right(xs, 0, std::plus{});
std::vector<int> vc(std::from_range, rng);                            // tagged range ctor
vc.assign_range(r); vc.insert_range(vc.begin(), r); vc.append_range(r);
```

| C++23 library facility | Header | Macro |
|---|---|---|
| `expected<T,E>` / `unexpected` | `<expected>` | `__cpp_lib_expected` 202211 |
| `mdspan`, `extents`, `layout_*` | `<mdspan>` | `__cpp_lib_mdspan` 202207 |
| `print` / `println` | `<print>` | `__cpp_lib_print` 202207 |
| `stacktrace` | `<stacktrace>` | `__cpp_lib_stacktrace` 202011 |
| `flat_map` / `flat_multimap` | `<flat_map>` | `__cpp_lib_flat_map` 202207 |
| `flat_set` / `flat_multiset` | `<flat_set>` | `__cpp_lib_flat_set` 202207 |
| `generator` | `<generator>` | `__cpp_lib_generator` 202207 |
| `move_only_function` | `<functional>` | `__cpp_lib_move_only_function` 202110 |
| `scope_exit`/`_fail`/`_success`, `unique_resource` | `<scope>` | `__cpp_lib_scope` 202207 (TS/LFTS) |
| `out_ptr` / `inout_ptr` | `<memory>` | `__cpp_lib_out_ptr` 202106 |
| `byteswap` | `<bit>` | `__cpp_lib_byteswap` 202110 |
| `to_underlying` | `<utility>` | `__cpp_lib_to_underlying` 202102 |
| `unreachable` | `<utility>` | `__cpp_lib_unreachable` 202202 |
| `forward_like` | `<utility>` | `__cpp_lib_forward_like` 202207 |
| `invoke_r` | `<functional>` | `__cpp_lib_invoke_r` 202106 |
| `bind_back` | `<functional>` | `__cpp_lib_bind_back` 202202 |
| `start_lifetime_as` | `<memory>` | `__cpp_lib_start_lifetime_as` 202207 |
| `allocate_at_least` | `<memory>` | `__cpp_lib_allocate_at_least` 202302 |
| `spanstream` family | `<spanstream>` | `__cpp_lib_spanstream` 202106 |
| `string::contains` | `<string>` | `__cpp_lib_string_contains` 202011 |
| `string::resize_and_overwrite` | `<string>` | `__cpp_lib_string_resize_and_overwrite` 202110 |
| Monadic `optional` | `<optional>` | `__cpp_lib_optional` **202110** |
| `ranges::to` | `<ranges>` | `__cpp_lib_ranges_to_container` 202202 |
| `views::zip`/`zip_transform` | `<ranges>` | `__cpp_lib_ranges_zip` 202110 |
| `views::adjacent`/`adjacent_transform` | `<ranges>` | `__cpp_lib_ranges_adjacent` |
| `views::chunk` / `slide` | `<ranges>` | `__cpp_lib_ranges_chunk`, `__cpp_lib_ranges_slide` |
| `views::chunk_by` | `<ranges>` | `__cpp_lib_ranges_chunk_by` 202202 |
| `views::stride` | `<ranges>` | `__cpp_lib_ranges_stride` 202207 |
| `views::repeat` | `<ranges>` | `__cpp_lib_ranges_repeat` 202207 |
| `views::cartesian_product` | `<ranges>` | `__cpp_lib_ranges_cartesian_product` 202207 |
| `views::join_with` | `<ranges>` | `__cpp_lib_ranges_join_with` 202202 |
| `views::as_rvalue` | `<ranges>` | `__cpp_lib_ranges_as_rvalue` 202207 |
| `views::enumerate` | `<ranges>` | `__cpp_lib_ranges_enumerate` 202302 |
| `ranges::fold_left`/`fold_right` | `<algorithm>` | `__cpp_lib_ranges_fold` 202207 |
| Container `from_range` / `*_range` | many | `__cpp_lib_containers_ranges` 202202 |
| `ranges::starts_with` / `ends_with` | `<algorithm>` | `__cpp_lib_ranges_starts_ends_with` 202106 |
| `ranges::contains` | `<algorithm>` | `__cpp_lib_ranges_contains` 202207 |
| `ranges::find_last` | `<algorithm>` | `__cpp_lib_ranges_find_last` 202207 |
| `ranges::iota` (algorithm) | `<numeric>` | `__cpp_lib_ranges_iota` 202202 |
| `constexpr` `unique_ptr`/`bitset`/`typeinfo` | — | `__cpp_lib_constexpr_memory`, `_bitset`, `_typeinfo` |
| `stdatomic.h` compat, `is_scoped_enum` | — | `__cpp_lib_stdatomic_h`, `__cpp_lib_is_scoped_enum` |

**Traps** — `expected` still *throws* from `.value()` on an error · `mdspan` owns nothing and bounds-checks nothing · `flat_map` insert is O(n) and invalidates all iterators (it is a `vector` pair, not a tree) · `flat_map::keys()` is const-only; you mutate through `insert`/`erase` · `generator` allocates a coroutine frame and is single-pass · `move_only_function` has no guaranteed SBO · `std::unreachable()` is UB, not `assert` · `views::zip` stops at the shortest range · `scope_exit` swallows the guard's own throw only if the callable is `noexcept`.

---

## 46.7 Replaced/deprecated idioms and migration notes

| Legacy idiom | Modern default | Since | Qualification |
|---|---|---|---|
| `NULL` / literal `0` for pointers | `nullptr` | C++11 | still use `0` for integers |
| `new T` stored in a raw owner | `std::make_unique<T>()` | C++14 | custom deleters/alignment need explicit factories |
| Private undeclared copy ctor | `T(T const&) = delete;` | C++11 | deleted overloads still participate in resolution |
| `typedef` | `using` alias | C++11 | alias *templates* require `using` |
| Hand-rolled functor class | lambda | C++11 | lambdas cannot be named/reused as a type |
| `std::auto_ptr` | `unique_ptr` | C++11 / removed C++17 | move semantics vs copy-that-steals |
| Dynamic exception spec `throw(X)` | `noexcept` | C++11 / removed C++17 | `noexcept` participates in overload/trait decisions |
| `std::bind` | lambda, `bind_front` (C++20), `bind_back` (C++23) | — | `bind` has opaque nested-placeholder semantics |
| `std::result_of` | `std::invoke_result_t` | C++17 / removed C++20 | `invoke_result` handles all callable forms |
| SFINAE `enable_if` webs | concepts / `requires` | C++20 | SFINAE still needed inside implementations |
| Tag dispatch | `if constexpr` | C++17 | `if constexpr` needs a single return type or `auto` |
| `std::random_shuffle` | `std::shuffle(b, e, gen)` | C++14 dep. / removed C++17 | must supply a URBG |
| `const char*` + length params | `std::string_view` | C++17 | not NUL-terminated |
| Iterator-pair-only APIs | ranges / `span` | C++17/20 | ownership + invalidation unchanged |
| Out-param + `bool` error | `expected<T,E>` / `optional<T>` | C++23/17 | ABI/C boundaries still use out-params |
| Manual enum→int cast | `std::to_underlying` | C++23 | one-way only; int→enum is unchecked |
| `std::aligned_storage` / `aligned_union` | `alignas(T) std::byte buf[sizeof(T)]` + `construct_at` | dep. C++23 | you own lifetime and `launder` correctness |
| `std::is_pod` | `is_trivially_copyable` + `is_standard_layout` | dep. C++17 | "POD" conflates two orthogonal properties |
| `volatile` as a thread flag | `std::atomic<bool>` | C++11 | `volatile` orders nothing between threads; C++20 deprecated most compound `volatile` ops |
| `std::rand()` | `<random>` engines/distributions | C++11 | `rand()%n` is biased and not thread-safe |
| `printf`/`ostream` chains | `std::format` / `std::print` | C++20/23 | `print` may still allocate |
| `strtol`/`stoi`/`sscanf` | `std::from_chars` | C++17 | locale-independent, no allocation, no throw |
| Manual `mutex` pair locking | `std::scoped_lock` | C++17 | deadlock-avoiding multi-lock |
| Custom RAII guard classes | `std::scope_exit` | **not C++23** — LFTS v3 `<scope>` | availability spotty; keep hand-rolled guards portable |
| `<codecvt>` conversions | platform ICU/utf8 libs | dep. C++17 | no standard replacement |
| `std::uncaught_exception()` | `std::uncaught_exceptions()` | C++17 / removed C++20 | plural returns a count |
| `std::iterator` base class | write the 5 typedefs / use ranges | dep. C++17 | concepts replace the trait plumbing |

**Migration checklist — what a "drop-in" replacement can silently change**

| Axis | Example break |
|---|---|
| Ownership | `T*` → `string_view` turns an owner into a borrow |
| Lifetime / invalidation | `map` → `flat_map` changes reference stability from permanent to none |
| Exception behavior | `.at()` → `operator[]` swaps a throw for UB |
| Error channel | exception → `expected` requires every caller to check |
| ABI / layout | `[[no_unique_address]]` and `constexpr` changes alter `sizeof` |
| Overload resolution | adding `<=>` creates rewritten candidates that change which `<` runs |
| Allocation | `std::function` → `move_only_function` may add or remove SBO |
| Code size | generic lambdas / concepts instantiate more, not less |
| Compile time | ranges and concepts are heavy on the front end |

**Interview line** — "Modern spelling is a semantics change first and a performance change never-by-default; I compare ownership, invalidation, error channel, and ABI before I call it a refactor."

---

## 46.8 Feature-test macros and conditional availability

```cpp
#include <version>          // C++20: every __cpp_lib_* macro, no other content

#if defined(__cpp_lib_expected) && __cpp_lib_expected >= 202202L
    #include <expected>
    template<class T, class E> using Result = std::expected<T, E>;
#elif __has_include(<tl/expected.hpp>)
    #include <tl/expected.hpp>
    template<class T, class E> using Result = tl::expected<T, E>;   // project namespace, NOT std
#else
    #error "a Result type is required"
#endif
```

```cpp
// ---- the four probe mechanisms -------------------------------------------
#if __cplusplus >= 202302L                      // language mode (coarse, MSVC needs /Zc:__cplusplus)
#endif
#ifdef __cpp_concepts                           // core-language feature
#endif
#ifdef __cpp_lib_ranges                         // library feature (needs <version> or the header)
#endif
#if __has_include(<generator>)                  // header presence (C++17)
#endif
#if __has_cpp_attribute(assume) >= 202207L      // attribute support (C++20)
#endif
#if defined(_MSC_VER) || defined(__GNUC__)      // vendor macro — never a portable conformance test
#endif
```

```cpp
// ---- graceful degradation with identical semantics -------------------------
namespace qs {
#if defined(__cpp_lib_unreachable)
    [[noreturn]] inline void unreachable() { std::unreachable(); }
#elif defined(__GNUC__)
    [[noreturn]] inline void unreachable() { __builtin_unreachable(); }
#else
    [[noreturn]] inline void unreachable() { std::abort(); }
#endif

#if defined(__cpp_lib_byteswap)
    template<std::integral T> constexpr T bswap(T v) { return std::byteswap(v); }
#else
    template<std::integral T> constexpr T bswap(T v) {
        auto b = std::bit_cast<std::array<std::byte, sizeof(T)>>(v);
        std::ranges::reverse(b);
        return std::bit_cast<T>(b);
    }
#endif
}   // never open namespace std to add a fallback — that is UB
```

| Probe | Answers | Does NOT answer |
|---|---|---|
| `__cplusplus` | which language mode was selected | whether any facility is implemented |
| `__cpp_<feature>` | core-language feature + revision | library availability |
| `__cpp_lib_<feature>` | library facility + revision | runtime cost or platform data (e.g. tzdata) |
| `__has_include(<h>)` | header is findable | header's contents are complete |
| `__has_cpp_attribute(a)` | attribute recognized + revision | that it has any effect |
| `_MSC_VER`, `__GNUC__`, `_LIBCPP_VERSION`, `__GLIBCXX__` | implementation identity | conformance |
| `__STDCPP_DEFAULT_NEW_ALIGNMENT__` | over-aligned new threshold | allocator behavior |

| Language mode | `__cplusplus` value | Compiler flag |
|---|---|---|
| C++11 | `201103L` | `-std=c++11` / `/std:c++11` (MSVC: none, use `/std:c++14`) |
| C++14 | `201402L` | `-std=c++14` / `/std:c++14` |
| C++17 | `201703L` | `-std=c++17` / `/std:c++17` |
| C++20 | `202002L` | `-std=c++20` / `/std:c++20` |
| C++23 | `202302L` | `-std=c++23` / `/std:c++latest` |
| GNU dialects | same value | `-std=gnu++23` also enables extensions |

```bash
# ---- what does THIS toolchain actually have? -------------------------------
echo | g++ -std=c++23 -x c++ -dM -E - | grep -E '__cpp_(lib_)?' | sort
echo '#include <version>' | g++ -std=c++23 -x c++ -dM -E - | grep __cpp_lib_expected
clang++ -std=c++23 -E -dM -x c++ /dev/null | grep __cplusplus
g++ -std=c++23 -x c++ - <<<'#include <generator>
int main(){}' -o /dev/null && echo "has <generator>"
cl /std:c++latest /Zc:__cplusplus /EP test.cpp        # MSVC needs /Zc:__cplusplus
```

```cpp
// ---- ODR/ABI hazard: the SAME macro must hold in every TU -------------------
struct Config {
#if defined(__cpp_lib_stacktrace)
    std::stacktrace trace;      // layout differs between TUs if the macro differs → ODR violation
#endif
    int id;
};
// Fix: decide once in a build-system-generated header, force it via -D, and assert it:
static_assert(QS_HAS_STACKTRACE == 1, "config mismatch across translation units");
```

**Traps** — `__cpp_lib_*` macros are undefined until `<version>` (or the facility header) is included, so a bare `#ifdef` in a header that includes nothing always fails · MSVC reports `__cplusplus == 199711L` without `/Zc:__cplusplus` · a defined macro with an *older* value means an older revision of the feature (`__cpp_constexpr` is 200704/201304/201603/201907/202306) · `__has_include` can find a header that is empty or `#error`s · libstdc++/libc++ can be newer or older than the compiler front end · defining `_GLIBCXX_DEBUG` or `_ITERATOR_DEBUG_LEVEL` in some TUs only is an ABI mismatch, not a debugging aid.

**Interview line** — "I gate on `__cpp_lib_<facility> >= <revision>` after including `<version>`, put the fallback in my own namespace with identical semantics, and pin the decision in one build-generated header so no two TUs disagree."
