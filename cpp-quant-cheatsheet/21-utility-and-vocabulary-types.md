# 21. Utility and vocabulary types

*Part III — Standard library quick reference*

---

**Recall**
- Vocabulary types make absence, alternatives, errors, borrowing, and dimensions *visible in the signature* — that is the whole payoff.
- `optional<T>` stores `T` inline (no heap by itself); `sizeof(optional<T>) >= sizeof(T) + 1`, rounded to `alignof(T)`.
- `*o` on a disengaged optional is **UB**; `o.value()` throws `bad_optional_access` — they are not synonyms.
- `value_or(f())` and `expected::value_or` evaluate the argument **eagerly**, even when unused.
- There is no `std::optional<T&>` in C++23 — use `T*` or `optional<reference_wrapper<T>>` (it lands in C++26).
- `variant` is a closed sum type with a zero-based `index()`; type-based `get<T>` requires `T` to appear exactly once.
- `variant` can become `valueless_by_exception()` (`index() == variant_npos`) when a throwing alternative change loses the old value.
- `std::visit` requires the visitor to be callable and to return the *same* type for every alternative combination.
- `any` is open-ended type erasure: runtime `any_cast`, likely allocation, and `any_cast<T>(a)` **copies** — rarely a hot-path type.
- `expected<T,E>` is the value/typed-error vocabulary; `expected<void,E>` is the status-only form; `unexpected<E>` is the error wrapper.
- `and_then` returns the monad, `transform` wraps a raw value, `or_else`/`transform_error` act on the error side.
- `span` never owns and never extends lifetime — it dangles on reallocation and its size never tracks the container.
- Static extent `span<T,N>` puts the size in the type so it need not be stored; conversion dynamic→static is unchecked.
- `mdspan` = data handle + extents + layout mapping + accessor; `m[r, c]` is the C++23 multidimensional subscript.
- `layout_right` = row-major (rightmost fastest), `layout_left` = column-major; loop order must match the mapping or you stride the cache.
- `reference_wrapper<T>` is a copyable, *reseatable*, non-null borrow — assignment rebinds, `.get() = v` assigns through.
- `bitset<N>` is fixed-width packed bits with a proxy `operator[]`; `test`/`set(pos)` are checked, `operator[]` is not.
- `<bit>` (C++20) gives defined `popcount`/`countl_zero`/`bit_width`/`rotl`/`bit_cast`; C++23 adds `byteswap`.
- `bit_ceil(x)` is **UB** when the result is unrepresentable — it does not saturate.
- `source_location::current()` must sit in a **default argument** to name the caller; in a body it names the body.
- `stacktrace` capture allocates, locks, and symbolizes — diagnostics only, never per-event telemetry.
- `type_index`/`typeid` names and hashes are not stable across builds or processes — never persist them.

---

## 21.1 `std::pair`, `std::tuple`, structured bindings, and `std::apply`

```cpp
#include <utility>
#include <tuple>

// ---- construction ------------------------------------------------------
std::pair<std::uint64_t, int> p1{42, 7};              // direct
std::pair p2{42u, 7};                                  // CTAD → pair<unsigned,int>
auto p3 = std::make_pair(7u, 12.5);                    // decays refs/arrays
std::pair<int, std::string> p4(std::piecewise_construct,
                               std::forward_as_tuple(1),
                               std::forward_as_tuple(3, 'x'));  // in-place both members

std::tuple<int, double, std::string_view> t1{1, 2.5, "ABC"};
auto t2 = std::tuple{1, 2.5, std::string_view{"ABC"}};  // CTAD
auto t3 = std::make_tuple(1, 2.5);                      // decaying
std::tuple<> empty;                                     // legal, size 0-ish

// ---- element access ----------------------------------------------------
auto a = std::get<0>(t1);                    // by index
auto s = std::get<std::string_view>(t1);     // by type — must be UNIQUE
auto& r = std::get<1>(t1);                   // lvalue ref into the tuple
auto&& m = std::get<2>(std::move(t1));       // rvalue ref — enables moving out
constexpr auto n = std::tuple_size_v<decltype(t1)>;          // 3
using E1 = std::tuple_element_t<1, decltype(t1)>;            // double

// ---- tie / ignore / structured assignment ------------------------------
std::uint64_t id; double px;
std::tie(id, px) = std::pair{1ull, 9.5};     // assigns THROUGH refs
std::tie(id, std::ignore) = std::pair{2ull, 0.0};   // skip a position
auto refs = std::tie(id, px);                // tuple<uint64_t&, double&>
auto fwd  = std::forward_as_tuple(f(), g()); // tuple of FORWARDING refs — dangles if stored

// ---- concatenation / comparison / swap ---------------------------------
auto cat = std::tuple_cat(t3, std::tuple{'z'}, p3);  // flattens tuple-likes
bool eq  = (t3 == std::tuple{1, 2.5});
auto cmp = (t3 <=> std::tuple{1, 2.0});      // lexicographic three-way (C++20)
t3.swap(std::tuple{9, 9.0});                 // element-wise
```

```cpp
// ---- structured bindings: three declarators, three meanings -------------
std::pair<std::uint64_t, int> result{42, 7};
auto  [id1, q1] = result;        // hidden COPY of result; names alias the copy
auto& [id2, q2] = result;        // names alias result's members (mutable)
auto const& [id3, q3] = result;  // const aliases
auto&& [id4, q4] = make_pair();  // hidden temporary's lifetime is EXTENDED

// works over three kinds of thing:
int raw[2]{1, 2};        auto [x, y]   = raw;   // 1. array
struct S { int a; double b; };
S s{1, 2.0};             auto [sa, sb] = s;     // 2. public non-static data members
std::tuple tup{1, 2.0};  auto [ta, tb] = tup;   // 3. tuple protocol (tuple_size/get)

static int k = 0;
auto [c1, c2] = std::pair{k, k};       // no capture of structured bindings pre-C++20 lambdas
auto f = [c1, c2] { return c1 + c2; }; // C++20: bindings ARE capturable
```

```cpp
// ---- std::apply --------------------------------------------------------
auto args = std::tuple{3, 4};
auto sum  = std::apply([](auto a, auto b) { return a + b; }, args);   // invokes via std::invoke
auto obj  = std::make_from_tuple<Order>(std::tuple{id, qty});          // construct T from tuple

// generic forwarding wrapper
template<class F, class Tup>
decltype(auto) call(F&& f, Tup&& t) {
    return std::apply(std::forward<F>(f), std::forward<Tup>(t));  // value category preserved
}
```

| API | Header | Complexity | Notes |
|---|---|---|---|
| `pair(a,b)` / CTAD / `make_pair` | `<utility>` | O(1) | `make_pair` **decays** (array→ptr, `ref`→`T&`) |
| `pair(piecewise_construct, t1, t2)` | `<utility>` | O(1) | constructs both members in place |
| `p.first` / `p.second` | `<utility>` | O(1) | public members, not accessors |
| `tuple(...)` / `make_tuple` / `tie` / `forward_as_tuple` | `<tuple>` | O(1) | `tie`→`T&`, `forward_as_tuple`→`T&&` |
| `get<I>(t)` / `get<T>(t)` | `<tuple>` | O(1) compile-time | type form requires uniqueness |
| `tuple_size_v<T>` / `tuple_element_t<I,T>` | `<tuple>` | compile-time | drives structured bindings |
| `tuple_cat(ts...)` | `<tuple>` | O(total) copies/moves | accepts any tuple-likes |
| `apply(f, t)` | `<tuple>` | O(1) dispatch | calls through `std::invoke` |
| `make_from_tuple<T>(t)` | `<tuple>` | O(1) | `T{get<I>(t)...}` |
| `t == u`, `t <=> u` | `<tuple>` | O(N) | lexicographic; requires same size |
| `swap(t,u)` | `<tuple>` | O(N) | element-wise |
| `std::ignore` | `<tuple>` | — | assignable sink for `tie` |

```cpp
// ---- named struct beats tuple once fields carry meaning -----------------
struct LookupResult { std::size_t index; bool inserted; };   // .inserted ages better
auto [it, ok] = map.try_emplace(k, v);                        // tuple-like is fine here
```

**Traps** — `make_pair` decays so `make_pair(ref(x), …)` stores `T&` while `pair{ref(x),…}` stores the wrapper · `forward_as_tuple` holds dangling refs the moment the full-expression ends · `tie` cannot bind to `const` targets · `get<T>` on a tuple with duplicate types is ill-formed · `auto [a,b] = v` copies even when `v` is huge · structured bindings cannot be `static`, cannot have explicit types, and (pre-C++26) cannot be marked `constexpr`.

---

## 21.2 `std::optional`, monadic operations, and object lifetime

```cpp
#include <optional>

// ---- every construction form -------------------------------------------
std::optional<int> o1;                       // disengaged
std::optional<int> o2{std::nullopt};         // disengaged, explicit
std::optional<int> o3{7};                    // engaged, direct-init
std::optional o4{7};                         // CTAD → optional<int>
auto o5 = std::make_optional<int>(7);
auto o6 = std::make_optional<std::string>(3, 'x');       // in-place args
std::optional<std::string> o7{std::in_place, 3, 'x'};    // avoids a temporary
std::optional<std::vector<int>> o8{std::in_place, {1,2,3}};  // init-list overload
std::optional<int> o9 = o3;                  // copy (engaged-ness copied)
std::optional<long> o10 = o3;                // converting ctor

// ---- mutation ----------------------------------------------------------
o1 = 12;               // assigns/constructs contained value
o1 = std::nullopt;     // destroys contained value → disengaged
o1.emplace(5);         // destroys any old value, constructs in place, returns int&
o1.reset();            // destroy + disengage (no-op if empty)
o1.swap(o3);           // engaged-ness aware
```

```cpp
// ---- observation -------------------------------------------------------
if (o3)             {}          // explicit operator bool
if (o3.has_value()) {}
int  v1 = *o3;                  // UNCHECKED — UB when disengaged
int  v2 = o3.value();           // throws std::bad_optional_access
int  v3 = o3.value_or(-1);      // fallback is EAGERLY evaluated
auto p  = o7->size();           // operator-> ; UB when disengaged
int&& v4 = std::move(o3).value();   // rvalue overload → move out

if (auto q = lookup(id)) consume(*q);       // idiomatic check-then-use
```

```cpp
// ---- C++23 monadic operations ------------------------------------------
auto normalized = parse_quantity(text)
    .and_then(validate_positive)                      // T -> optional<U>
    .transform([](int x) { return Quantity{x}; })     // T -> U (auto-wrapped)
    .or_else([] { return std::optional<Quantity>{}; });// () -> optional<T>, same T

// C++26-adjacent helpers you should know exist but not assume:
// o.value_or(...) is eager; use or_else for lazy fallbacks.
```

| Member | Engaged | Disengaged | Complexity |
|---|---|---|---|
| `operator bool` / `has_value()` | `true` | `false` | O(1), `noexcept` |
| `operator*` / `operator->` | value | **UB** | O(1) |
| `value()` | value | throws `bad_optional_access` | O(1) |
| `value_or(u)` | value | `static_cast<T>(u)` by value | O(1) + eager arg |
| `emplace(args...)` | destroy old, construct | construct | O(1); throwing ctor leaves it **empty** |
| `reset()` | destroy, disengage | no-op | O(1), `noexcept` |
| `swap(o)` | move/construct as needed | — | O(1) |
| `and_then(f)` (C++23) | `f(*this)` → optional | propagates empty | O(1) |
| `transform(f)` (C++23) | wraps `f(*this)` | propagates empty | O(1) |
| `or_else(f)` (C++23) | propagates value | `f()` → optional | O(1) |
| `o == u`, `o <=> u` | compares values | empty < any value | O(1) |
| `o == std::nullopt` | `false` | `true` | O(1) |

```cpp
// ---- representable-state traps -----------------------------------------
// std::optional<int&> o;                 // ill-formed in C++23 (arrives in C++26)
std::optional<std::reference_wrapper<Order>> ref_opt;   // workaround #1
Order* ptr = nullptr;                                    // workaround #2 (usually better)

std::optional<bool>  tri;    // THREE states: empty / false / true
std::optional<int*>  op;     // FOUR-ish: empty / engaged-null / engaged-ptr
if (op)        {}            // true even when *op == nullptr
if (op && *op) {}            // what you actually meant

std::optional<std::string> os{"abc"};
auto const& sref = *os;
os.reset();                  // sref now DANGLES
```

**Interview line** — "`optional` models absence, not failure: the moment the caller needs to know *why*, you want `expected<T,E>`."

**Traps** — `*o` is UB, not an exception · `value_or(expensive())` always runs `expensive()` · `optional<bool>` collapses under `if` · assigning `nullopt` runs the destructor and invalidates references · `optional<T>` copies are as expensive as `T` copies · comparing `optional<T>` to `T` engages the value comparison, not identity.

---

## 21.3 `std::variant`, visitation, and `valueless_by_exception`

```cpp
#include <variant>

struct Add { std::uint64_t id; };
struct Cancel { std::uint64_t id; };
struct Execute { std::uint64_t id; int qty; };
using Event = std::variant<Add, Cancel, Execute>;

// ---- construction ------------------------------------------------------
Event e1;                                        // value-initializes alternative 0 (needs default ctor)
Event e2 = Add{7};                               // best-match alternative selection
Event e3{std::in_place_type<Execute>, 7, 100};   // by type — must be unique
Event e4{std::in_place_index<2>, 7, 100};        // by index — always unambiguous
std::variant<int, int> dup{std::in_place_index<1>, 5};   // duplicates need index form
std::variant<std::monostate, Add> maybe;         // monostate = "empty" first alternative

// ---- state -------------------------------------------------------------
std::size_t i = e2.index();                      // 0-based; variant_npos if valueless
bool has = std::holds_alternative<Add>(e2);
constexpr auto n = std::variant_size_v<Event>;   // 3
using A0 = std::variant_alternative_t<0, Event>; // Add
```

```cpp
// ---- access ------------------------------------------------------------
auto& add  = std::get<Add>(e2);        // throws std::bad_variant_access on mismatch
auto& add2 = std::get<0>(e2);          // index form
if (auto* c = std::get_if<Cancel>(&e2)) consume(*c);   // nullptr on mismatch, noexcept
if (auto* c = std::get_if<1>(&e2))      consume(*c);

// ---- mutation ----------------------------------------------------------
e2 = Cancel{9};                             // converting assignment
e2.emplace<Execute>(9, 50);                 // by type
e2.emplace<2>(9, 50);                       // by index
e2.swap(e3);
```

```cpp
// ---- visitation --------------------------------------------------------
// The `Overload` aggregate (inherit from each lambda, `using Fs::operator()...`)
// is built in §14.9; here it is just the visitor you reach for most often:
std::visit(Overload{ [](Add const& x)     { handle(x); },
                     [](Cancel const& x)  { handle(x); },
                     [](Execute const& x) { handle(x); } }, e2);

std::visit([](auto const& x) { generic(x); }, e2);          // generic lambda = catch-all
auto r = std::visit<std::string>([](auto const&) { return ""; }, e2);  // C++20 explicit return type

// multi-variant visitation: cartesian product of alternatives
std::visit([](auto const& a, auto const& b) { pair_rule(a, b); }, e2, e3);

// hand-rolled dispatch without visit (sometimes smaller codegen)
switch (e2.index()) {
    case 0: handle(std::get<0>(e2)); break;
    case 1: handle(std::get<1>(e2)); break;
    case 2: handle(std::get<2>(e2)); break;
}
```

```cpp
// ---- valueless_by_exception --------------------------------------------
struct Throwy { Throwy(Throwy&&) { throw 1; } Throwy(int) {} };
std::variant<int, Throwy> v{1};
try { v.emplace<Throwy>(0); } catch (...) {}
if (v.valueless_by_exception()) {                 // index() == std::variant_npos
    handle_corrupt_state();                       // get/visit now throw bad_variant_access
}
// Avoid entirely: make every alternative nothrow-move-constructible,
// or hold a variant<monostate, Ts...> and reset first.
static_assert(std::is_nothrow_move_constructible_v<Add>);
```

| API | Complexity | Notes |
|---|---|---|
| `index()` | O(1), `noexcept` | `variant_npos` (`size_t(-1)`) when valueless |
| `valueless_by_exception()` | O(1), `noexcept` | rarely true, never impossible |
| `holds_alternative<T>(v)` | O(1), `noexcept` | `T` must be unique |
| `get<T>(v)` / `get<I>(v)` | O(1) | throws `bad_variant_access` |
| `get_if<T>(&v)` / `get_if<I>(&v)` | O(1), `noexcept` | `nullptr` on mismatch or null input |
| `emplace<T>(args...)` / `emplace<I>(...)` | O(1) | destroys old first; can go valueless |
| `visit(f, vs...)` | O(1) dispatch (table or switch) | throws if any variant is valueless |
| `visit<R>(f, vs...)` (C++20) | O(1) | forces the common return type |
| `swap(a,b)` | O(1)–O(size) | same alternative → element swap; else move dance |
| `v == w`, `v <=> w` | O(1) | compares `index()` first, then the value |
| `variant_size_v<V>` / `variant_alternative_t<I,V>` | compile-time | |
| `std::monostate` | — | empty, regular, totally ordered first alternative |

```text
sizeof(variant<Ts...>) ≳ max(sizeof(Ts)...) + discriminator + padding
```

**Interview line** — "`variant` gives a closed alternative set with compile-time-exhaustive visitation; `any` gives an open set with a runtime cast."

**Traps** — a `variant<std::string, bool>` initialized from `"abc"` historically picks `bool` (fixed in C++17 DR/C++20 by best-match rules — still test it) · `get<T>` with duplicate `T` is ill-formed · `visit` requires one common return type across all arms · adding an alternative silently changes every `get<I>` index · a generic-lambda visitor destroys the compile-time exhaustiveness you came for · variant does *not* give you a cheap tagged union when alternatives differ wildly in size.

---

## 21.4 `std::any` and open-ended type erasure

```cpp
#include <any>

std::any a1;                                   // empty
std::any a2 = std::string{"ABC"};              // decay-copies the argument
std::any a3{std::in_place_type<std::string>, 3, 'x'};   // in-place construct
auto a4 = std::make_any<std::vector<int>>({1, 2, 3});

a1.emplace<Config>(args...);                   // returns Config&
a1.reset();                                    // destroys, becomes empty
bool ok = a1.has_value();
std::type_info const& ti = a1.type();          // typeid(void) when empty
a1.swap(a2);
```

```cpp
// ---- every any_cast form ------------------------------------------------
std::any payload = std::string{"ABC"};

auto  copy  = std::any_cast<std::string>(payload);        // COPY; throws bad_any_cast
auto& ref   = std::any_cast<std::string&>(payload);       // reference, no copy
auto const& cref = std::any_cast<std::string const&>(payload);
auto  moved = std::any_cast<std::string&&>(std::move(payload));  // move out
if (auto* p = std::any_cast<std::string>(&payload))       // pointer form: nullptr, noexcept
    consume(*p);
auto* cp = std::any_cast<std::string>(&std::as_const(payload));  // std::string const*
```

| API | Complexity | Notes / exceptions |
|---|---|---|
| `any()` / `any(v)` / `any(in_place_type<T>, …)` | O(1) + copy | may allocate; SBO is optional and unspecified |
| `make_any<T>(args...)` | O(1) + construct | in-place, avoids a temporary |
| `emplace<T>(args...)` | O(1) | destroys old; returns `T&`; empty if it throws |
| `reset()` | O(1) | `noexcept`, becomes empty |
| `has_value()` | O(1) | `noexcept` |
| `type()` | O(1) | `typeid(void)` when empty; needs RTTI |
| `swap(o)` | O(1) | `noexcept` |
| `any_cast<T>(a)` | O(1) + copy | throws `std::bad_any_cast` |
| `any_cast<T&>(a)` | O(1) | throws on mismatch; no copy |
| `any_cast<T>(&a)` | O(1) | `noexcept`, `nullptr` on mismatch |

- Stored type must be copy-constructible and (after decay) a non-array, non-reference object type.
- The cast type must match the **decayed** stored type *exactly* — no derived→base, no conversions.
- SBO existence and threshold are unspecified: large or throwing-move types typically heap-allocate.

**Traps** — `any_cast<T>(a)` copies silently; use `T&` or the pointer form to observe · `any_cast<Base&>` on a stored `Derived` throws — `any` is not polymorphism · `type()` and `any_cast` need RTTI, which some builds disable · `any` moves type errors from compile time to runtime; prefer `variant` whenever the set is closed.

---

## 21.5 `std::expected` and monadic error pipelines

```cpp
#include <expected>       // C++23

enum class DecodeError { truncated, invalid_tag, checksum };

std::expected<Message, DecodeError> decode(std::span<std::byte const> bytes) {
    if (bytes.empty())        return std::unexpected(DecodeError::truncated);
    if (!valid_tag(bytes[0])) return std::unexpected{DecodeError::invalid_tag};
    return Message{/* … */};                       // implicit value construction
}

// ---- construction forms -------------------------------------------------
std::expected<int, Err> e1;                             // value-initialized VALUE state
std::expected<int, Err> e2{42};
std::expected<int, Err> e3{std::in_place, 42};          // in-place value
std::expected<int, Err> e4{std::unexpect, Err::bad};    // in-place error
std::expected<int, Err> e5 = std::unexpected(Err::bad); // via unexpected<Err>
std::expected<void, Err> ok;                            // success-without-payload
std::expected<void, Err> bad = std::unexpected(Err::x);
auto ue = std::unexpected{Err::bad};                    // CTAD
Err const& raw = ue.error();
```

```cpp
// ---- observation --------------------------------------------------------
auto r = decode(bytes);
if (r)             consume(*r);          // explicit operator bool
if (r.has_value()) consume(r.value());   // value() throws bad_expected_access<E>
else               report(r.error());    // error() requires !has_value() (UB otherwise)
auto v = r.value_or(Message{});          // eager fallback argument
auto x = r.error_or(DecodeError::checksum);   // C++23 mirror of value_or
r->field;                                // operator-> ; UB in error state
auto out = std::move(r).value();         // rvalue overload moves the value out

r.emplace(args...);                      // construct a value in place
```

```cpp
// ---- monadic pipeline ---------------------------------------------------
auto event = frame(bytes)
    .and_then(decode)                  // T -> expected<U,E>   (E must match)
    .and_then(normalize)
    .transform(add_timestamp)          // T -> U               (auto-wrapped)
    .or_else(retry_once)               // E -> expected<T,G>
    .transform_error(add_offset);      // E -> G               (auto-wrapped)
```

| Member | Value state | Error state | Complexity |
|---|---|---|---|
| `operator bool` / `has_value()` | `true` | `false` | O(1), `noexcept` |
| `operator*` / `operator->` | value | **UB** | O(1) |
| `value()` | value | throws `bad_expected_access<E>` (carries `E`) | O(1) |
| `error()` | **UB** | error | O(1) |
| `value_or(u)` | value | `u` converted, by value | O(1) + eager arg |
| `error_or(g)` | `g` converted | error | O(1) |
| `emplace(args...)` | replace value | construct value | O(1) |
| `and_then(f)` | `f(value)` → `expected` | propagates error | O(1) |
| `transform(f)` | wraps `f(value)` | propagates error | O(1) |
| `or_else(f)` | propagates value | `f(error)` → `expected` | O(1) |
| `transform_error(f)` | propagates value | wraps `f(error)` | O(1) |
| `a == b` | value==value | error==error; mixed → `false` | O(1) |
| `swap(o)` | mixed states use a temp | may throw if both `E` and `T` moves throw | O(1) |
| `std::unexpected<E>` — `error()`, `==` | — | error wrapper type | O(1) |

```text
optional<T>       one non-success meaning: absent
expected<T,E>     typed, recoverable, local failure information
exception         nonlocal propagation; zero cost until thrown, then unbounded
error code + out  C-style; no enforcement that you checked
```

- `expected<T,E>` stores `T` and `E` in a union plus a bool: `sizeof ≈ max(sizeof(T), sizeof(E))` + flag + padding.
- Keep `E` small and trivially copyable on hot paths (an enum, or an enum + one integer) — build the string off-path.
- `[[nodiscard]]` on functions returning `expected` is what actually stops silently dropped errors.

**Interview line** — "`expected` is a value-or-error union with the error in the type system; exceptions move the error out of the signature and out of the happy path."

**Traps** — `*r` and `.error()` are both UB in the wrong state · `and_then`'s callable must return an `expected` with the *same* `E` · `transform` wraps, `and_then` does not — swapping them is the #1 compile error · discarding the result converts every error into silence · `expected<void,E>` still has `operator bool` but no `operator*` value.

---

## 21.6 `std::span` and C++23 `std::mdspan`

```cpp
#include <span>

// ---- construction -------------------------------------------------------
std::vector<int> v{1,2,3,4,5};
std::array<int,4> arr{};
int raw[4]{};

std::span<int> s1{v};                       // from contiguous range
std::span<int> s2{v.data(), v.size()};      // pointer + count
std::span<int> s3{v.begin(), v.end()};      // iterator pair (C++20)
std::span<int, 4> s4{arr};                  // STATIC extent from array
std::span<int, 4> s5{raw};                  // static extent from C array
std::span<int const> s6{v};                 // read-only view
auto s7 = std::span{v};                     // CTAD → span<int, dynamic_extent>
auto s8 = std::span{arr};                   // CTAD → span<int, 4>
std::span<int> s9;                          // empty, data() == nullptr

// ---- observation --------------------------------------------------------
s1.size(); s1.size_bytes(); s1.empty();
s1.front(); s1.back(); s1[2]; s1.data();    // ALL unchecked (no at())
for (int& x : s1) x = 0;
std::ranges::fill(s1, 0);

// ---- subviews -----------------------------------------------------------
auto head  = s1.first(2);        // dynamic count
auto head2 = s1.first<2>();      // static count → span<int,2>
auto tail  = s1.last(2);
auto mid   = s1.subspan(1, 3);   // offset, count
auto mid2  = s1.subspan<1, 3>(); // static → span<int,3>
auto rest  = s1.subspan(1);      // to the end

// ---- byte views ---------------------------------------------------------
auto rb = std::as_bytes(s1);              // span<std::byte const, N or dynamic>
auto wb = std::as_writable_bytes(s1);     // span<std::byte, …> (needs non-const T)
```

| API | Complexity | Notes |
|---|---|---|
| `span()` | O(1) | only when `Extent == 0` or `dynamic_extent` |
| `span(ptr, count)` / `span(first, last)` | O(1) | count must be exact; static extent is **unchecked** |
| `span(range)` / `span(array)` | O(1) | range must model `contiguous_range` + `sized_range` |
| `size()` / `size_bytes()` / `empty()` | O(1), `noexcept` | `size_bytes() == size() * sizeof(T)` |
| `operator[]` / `front()` / `back()` / `data()` | O(1) | **no bounds checking, no `at()`** |
| `begin/end/rbegin/rend` (+`c*` C++23) | O(1) | contiguous iterators |
| `first<N>()` / `first(n)` | O(1) | static form returns `span<T,N>` |
| `last<N>()` / `last(n)` | O(1) | |
| `subspan<O,C>()` / `subspan(o, c=dynamic_extent)` | O(1) | precondition: within range |
| `as_bytes(s)` / `as_writable_bytes(s)` | O(1) | reinterprets the object representation |
| `std::dynamic_extent` | — | `size_t(-1)` sentinel |

| Form | Extent | Typical layout | Conversion |
|---|---|---|---|
| `span<T>` | `dynamic_extent` | ptr + size | from anything contiguous |
| `span<T, N>` | compile-time `N` | ptr only (size in the type) | `span<T,N>` → `span<T>` implicit; reverse is **explicit and unchecked** |

```cpp
// ---- lifetime / invalidation -------------------------------------------
std::span<int> view = v;
v.push_back(1);          // realloc → view.data() DANGLES; even without realloc
                         // view.size() is still the OLD size
v.clear();               // view is stale but silently "valid-looking"
static_assert(std::is_trivially_copyable_v<std::span<int>>);   // pass by value
void f(std::span<int const> xs);    // ← canonical read-only contiguous parameter
```

```cpp
#include <mdspan>        // C++23; check __cpp_lib_mdspan

// ---- extents: static, dynamic, or mixed ---------------------------------
using E1 = std::extents<std::size_t, 3, 4>;                      // fully static
using E2 = std::extents<std::size_t, std::dynamic_extent, 4>;    // mixed
using E3 = std::dextents<std::size_t, 2>;                        // fully dynamic 2-D

std::vector<double> storage(rows * 4);
std::mdspan<double, E2> m{storage.data(), rows};          // dynamic extents in order
std::mdspan<double, std::dextents<std::size_t,2>> md{storage.data(), rows, 4};
auto cta = std::mdspan{storage.data(), std::extents{rows, 4u}};  // CTAD

m[2, 3] = 1.5;                                  // C++23 multidimensional subscript
double x = m[std::array{2uz, 3uz}];             // array index form
m.extent(0); m.extent(1); m.rank(); m.size();
m.data_handle(); m.mapping(); m.accessor();
bool contig = m.is_exhaustive();                // "no gaps" — was is_contiguous

// ---- layouts -------------------------------------------------------------
std::mdspan<double, E1, std::layout_right>  rowmajor{p};   // default; last index fastest
std::mdspan<double, E1, std::layout_left>   colmajor{p};   // first index fastest
std::array<std::size_t,2> strides{16, 1};
std::mdspan<double, E1, std::layout_stride> strided{
    p, std::layout_stride::mapping<E1>{E1{}, strides}};     // caller-supplied strides

// ---- submdspan (C++26 in most libs) --------------------------------------
// auto row = std::submdspan(m, 2, std::full_extent);
```

| mdspan API | Meaning | Complexity |
|---|---|---|
| `mdspan(ptr, exts...)` / `(ptr, extents)` / `(ptr, mapping)` / `(ptr, mapping, accessor)` | construct | O(1) |
| `operator[](i...)` (C++23) | element ref; every index must be in-extent | O(1) |
| `rank()` / `rank_dynamic()` | static rank counts | compile-time |
| `extent(r)` / `static_extent(r)` | one dimension | O(1) |
| `size()` / `empty()` | product of extents | O(rank) |
| `stride(r)` | mapping stride for dim `r` | O(1) |
| `data_handle()` / `mapping()` / `accessor()` | underlying pieces | O(1) |
| `is_unique()` / `is_exhaustive()` / `is_strided()` | mapping properties | O(1) |
| `layout_right` / `layout_left` / `layout_stride` | row-major / column-major / custom | — |
| `default_accessor<T>` | plain `T*` element access | — |

```cpp
// ---- loop order must match the mapping ----------------------------------
for (std::size_t r = 0; r < m.extent(0); ++r)      // layout_right: r outer
    for (std::size_t c = 0; c < m.extent(1); ++c)  // c inner varies fastest → sequential
        consume(m[r, c]);
```

**Interview line** — "`span` and `mdspan` are borrowed views: they never own, never allocate, never resize, and never validate that the backing storage is still alive."

**Traps** — `span` has no `at()`; every access is a precondition · a `span` built from a `vector` is stale after any size change · `span<T,N>` from a runtime-sized range is unchecked UB if the size differs · `as_bytes` exposes padding and is not a wire format · `mdspan` construction does not verify the allocation is large enough · walking `layout_right` column-first strides the cache · `<mdspan>` support lags C++23 language support — gate on `__cpp_lib_mdspan`.

---

## 21.7 `std::reference_wrapper`, `ref`, and `cref`

```cpp
#include <functional>

Order a, b;
std::reference_wrapper<Order> r1{a};      // direct; binds to an lvalue
auto r2 = std::ref(a);                    // reference_wrapper<Order>
auto r3 = std::cref(a);                   // reference_wrapper<Order const>
auto r4 = std::ref(r3);                   // re-wraps: reference_wrapper<Order const>
// auto bad = std::ref(Order{});          // ill-formed: rvalue overload is DELETED

r2 = std::ref(b);        // REBINDS the wrapper to b — does NOT assign b into a
r2.get() = b;            // assigns through: a = b
Order& live = r2;        // implicit conversion to T&
using U = std::reference_wrapper<Order>::type;   // Order

// ---- why it exists: references are not objects --------------------------
// std::vector<Order&> bad;                        // ill-formed
std::vector<std::reference_wrapper<Order>> selected{a, b};
for (Order& o : selected) mutate(o);               // implicit conversion in the loop
std::ranges::sort(selected, {}, &Order::price);    // projections see through it

// ---- invocation ---------------------------------------------------------
auto callable = std::ref(some_functor);
callable(1, 2);                                    // operator() forwards
std::invoke(std::ref(some_functor), 1, 2);

// ---- the classic bind/thread trap ---------------------------------------
std::thread t{worker, std::ref(shared_state)};     // WITHOUT ref: a copy is passed
auto bound = std::bind(f, std::ref(x));            // ditto for bind/async
```

| API | Complexity | Notes |
|---|---|---|
| `reference_wrapper<T>(T&)` | O(1) | `noexcept`; rvalue ctor is deleted |
| `operator T&()` | O(1) | implicit conversion |
| `get()` | O(1) | explicit access to `T&` |
| `operator=(reference_wrapper)` | O(1) | **rebinds**, does not assign the referent |
| `operator()(args...)` | forwards | via `std::invoke`; only for callable `T` |
| `std::ref(x)` / `std::cref(x)` | O(1) | rvalue overloads `= delete` |
| `std::unwrap_reference_t<T>` / `unwrap_ref_decay_t<T>` (C++20) | compile-time | what `make_pair`/`make_tuple` use |
| comparison (C++26) | O(1) | pre-C++26 there is no built-in `==` |

- `sizeof(reference_wrapper<T>) == sizeof(T*)`; it is trivially copyable and never null.
- It carries **no** lifetime management: copying the wrapper does nothing for the referent.
- `make_pair(std::ref(x), 1)` decays to `pair<T&, int>`; `std::pair{std::ref(x), 1}` keeps the wrapper.

**Traps** — `r = other_ref` rebinds while `r.get() = value` assigns — reading the wrong one is a silent logic bug · the deleted rvalue overload blocks only the *obvious* temporary, not a later-dying lvalue owner · a container of wrappers dangles wholesale when the owner dies · no `operator==` before C++26, so `std::find(vec_of_refs, x)` may not compile.

---

## 21.8 `std::bitset`, `<bit>`, and bit manipulation

```cpp
#include <bitset>

std::bitset<8> b1;                       // all zero
std::bitset<8> b2{0b0010'0101ull};       // from unsigned long long (low N bits)
std::bitset<8> b3{"00100101"};           // from string; throws invalid_argument on other chars
std::bitset<8> b4{std::string{"xoxo"}, 0, 4, 'o', 'x'};  // custom zero/one chars

b1.set();          b1.set(7);        b1.set(7, false);   // all / one / one-to-value
b1.reset();        b1.reset(0);
b1.flip();         b1.flip(2);
bool t = b1.test(3);          // CHECKED: throws std::out_of_range
bool u = b1[3];               // UNCHECKED proxy read
b1[3] = true;                 // proxy write
b1[3].flip();
auto proxy = b1[3];           // std::bitset<8>::reference — NOT bool&
// bool* p = &b1[3];          // ill-formed: bits are not addressable

b1.count();  b1.size();  b1.any();  b1.none();  b1.all();
auto ul  = b1.to_ulong();     // throws overflow_error if it does not fit
auto ull = b1.to_ullong();
auto str = b1.to_string();    // ALLOCATES; MSB first
auto s2  = b1.to_string('.', '#');

auto c = b1 & b2; auto d = b1 | b2; auto e = b1 ^ b2; auto f = ~b1;  // same N only
b1 <<= 2; b1 >>= 2;           // shifts in zeros, no rotation
std::cout << b1;              // MSB-first stream output
```

| `bitset<N>` API | Complexity | Notes |
|---|---|---|
| `set()` / `reset()` / `flip()` | O(N/word) | whole-set |
| `set(pos[,val])` / `reset(pos)` / `flip(pos)` | O(1) | throws `out_of_range` if `pos >= N` |
| `test(pos)` | O(1) | **checked**, throws `out_of_range` |
| `operator[](pos)` | O(1) | **unchecked**; returns proxy `reference` (non-const) |
| `count()` | O(N/word) | population count |
| `size()` | O(1), `constexpr` | always `N` |
| `any()` / `none()` / `all()` | O(N/word) | |
| `to_ulong()` / `to_ullong()` | O(N/word) | throws `overflow_error` |
| `to_string(zero,one)` | O(N) + allocation | MSB-first |
| `& \| ^ ~ << >> <<= >>=` | O(N/word) | operands must share `N` |
| `==` | O(N/word) | no `<=>` |
| `std::hash<bitset<N>>` | O(N/word) | |

- `bitset<N>` is a value type, packed to roughly `ceil(N/64)` words; it is **not** resizable and **not** atomic.
- Distinct bits share a word → concurrent writes to different bits are a **data race**.
- Alternatives: `vector<bool>` (dynamic, proxy), `vector<uint64_t>` + manual masks (control), `array<bool,N>` (addressable, 1 byte/flag).

```cpp
#include <bit>            // C++20

std::uint32_t x = 0b0010'1000;                 // 40

int  ones   = std::popcount(x);                // 2
int  lz     = std::countl_zero(x);             // 26  (leading zeros; == width for 0)
int  lo     = std::countl_one(x);              // 0
int  tz     = std::countr_zero(x);             // 3   (trailing zeros; == width for 0)
int  to     = std::countr_one(x);              // 0
int  w      = std::bit_width(x);               // 6   (bits needed; 0 for x==0)
auto fl     = std::bit_floor(x);               // 32  (0 for x==0)
auto ce     = std::bit_ceil(x);                // 64  — UB if unrepresentable
bool p2     = std::has_single_bit(x);          // false
auto l      = std::rotl(x, 5);                 // rotate left (negative s rotates right)
auto rr     = std::rotr(x, 5);

if constexpr (std::endian::native == std::endian::little) { /* … */ }
auto sw = std::byteswap(std::uint32_t{0x01020304});   // 0x04030201  (C++23)

float  fv = 1.0f;
auto   bits = std::bit_cast<std::uint32_t>(fv);       // 0x3F800000; constexpr-capable
static_assert(sizeof(float) == sizeof(std::uint32_t));
```

| `<bit>` function | Requires | Returns / semantics |
|---|---|---|
| `popcount(x)` | unsigned integral | number of 1 bits, `int` |
| `countl_zero(x)` / `countl_one(x)` | unsigned integral | leading 0s / 1s; `countl_zero(0) == width` |
| `countr_zero(x)` / `countr_one(x)` | unsigned integral | trailing 0s / 1s; `countr_zero(0) == width` |
| `bit_width(x)` | unsigned integral | `x ? 1 + floor(log2 x) : 0` |
| `bit_floor(x)` | unsigned integral | largest power of two `<= x`; `0` for `x == 0` |
| `bit_ceil(x)` | unsigned integral | smallest power of two `>= x`; **UB if unrepresentable** |
| `has_single_bit(x)` | unsigned integral | exact power of two |
| `rotl(x,s)` / `rotr(x,s)` | unsigned integral | bitwise rotate; `s` may be negative or `>= width` |
| `byteswap(x)` (C++23) | integral, no padding bits | reverses bytes |
| `bit_cast<To>(from)` | same `sizeof`, both trivially copyable | reinterprets the object representation |
| `endian::native / little / big` | — | `native` may equal neither on mixed-endian |

- All the counting functions exclude `bool`, `char`, `char8_t`… — they take *unsigned integer types* only; cast explicitly.
- They compile to single instructions (`popcnt`, `lzcnt`, `tzcnt`, `bswap`, `rol`) with the right `-march`, and to portable fallbacks without it.
- `bit_cast` is the only defined way to reinterpret representations — `reinterpret_cast` through a pointer is a strict-aliasing violation, and a `union` read of an inactive member is UB in C++.

**Traps** — `bitset::operator[]` is unchecked while `test()` throws · `to_ulong` throws for `N > 32`-valued sets · `to_string` allocates on a path where a mask would not · `bit_ceil(x)` for `x > 2^(w-1)` is UB, not saturation · `bit_width(0) == 0` surprises index math · `popcount(signed)` does not compile · `bit_cast` does not fix an invalid source representation (e.g. a trap `bool`) · `byteswap` is not an unaligned load and not a protocol.

---

## 21.9 `std::source_location`, `std::stacktrace`, and diagnostics

```cpp
#include <source_location>       // C++20

void record(Error e,
            std::source_location where = std::source_location::current()) {
    sink(e, where.file_name(), where.line(), where.column(), where.function_name());
}
record(error);         // default argument is evaluated AT THIS CALL SITE

// wrapper must forward, or it records itself
void record_wrapped(Error e,
                    std::source_location where = std::source_location::current()) {
    record(e, where);  // forward — otherwise `record` names record_wrapped's body
}

// variadic + location: take the location in a deduced-suppressing struct
template<class... Ts>
struct log_line {
    log_line(std::format_string<Ts...> fmt, Ts&&... a,
             std::source_location loc = std::source_location::current());
};

constexpr auto here = std::source_location::current();   // usable in constant expressions
```

| `source_location` member | Returns | Notes |
|---|---|---|
| `current()` | `source_location` | `consteval`; captures the *evaluation* site |
| `file_name()` | `const char*` | implementation-defined path spelling |
| `function_name()` | `const char*` | mangled/pretty form is implementation-defined |
| `line()` / `column()` | `uint_least32_t` | `column()` may be `0` |
| default ctor | implementation-defined placeholder | not "unknown" in a portable way |

```cpp
#include <stacktrace>            // C++23; check __cpp_lib_stacktrace, may need -lstdc++exp

auto trace = std::stacktrace::current();            // whole stack
auto shallow = std::stacktrace::current(1, 8);      // skip 1 frame, max 8
for (std::stacktrace_entry const& f : trace) {
    diagnostic(f.description(), f.source_file(), f.source_line(), f.native_handle());
}
auto text = std::to_string(trace);                  // multi-line rendering
std::cout << trace << '\n';                         // ostream support
// std::format("{}", trace);                        // formatter provided
```

| `stacktrace` / `stacktrace_entry` API | Complexity | Notes |
|---|---|---|
| `stacktrace::current([skip[, max]])` | O(depth), allocates | uses `basic_stacktrace`'s allocator |
| `size()` / `empty()` / `operator[]` / iterators | O(1) | frames are `[0] == innermost` |
| `entry.description()` | slow, allocates | symbolization; may be empty |
| `entry.source_file()` / `source_line()` | slow, allocates | needs debug info |
| `entry.native_handle()` | O(1) | platform address |
| `to_string(st)` / `operator<<` / `formatter` | O(depth) + allocation | |
| `std::basic_stacktrace<Alloc>` | — | supply a PMR allocator to control the cost |

- Capture cost is microseconds-to-milliseconds and takes internal locks; symbolization is the expensive half.
- Inlining, tail calls, `-fomit-frame-pointer`, and stripped binaries all silently degrade the result.
- Location and frame strings are **build artifacts**: never use them as map keys, wire identity, or dedup hashes across processes.

**Traps** — `current()` in a function *body* records that body, not the caller · a forwarding wrapper that forgets to pass the location silently reports the wrong site · defaulted `source_location` parameters must come after all other parameters, which fights variadic templates · `stacktrace` may need an extra library (`-lstdc++exp` on libstdc++) and returns empty frames on release builds.

---

## 21.10 `std::type_index`, `std::integer_sequence`, and miscellaneous utilities

```cpp
#include <typeindex>
#include <unordered_map>

std::unordered_map<std::type_index, Handler> handlers;
handlers.emplace(std::type_index{typeid(Add)}, add_handler);
handlers[typeid(Cancel)] = cancel_handler;             // implicit conversion from type_info
if (auto it = handlers.find(typeid(msg)); it != handlers.end()) it->second(msg);

std::type_info const& ti = typeid(*base_ptr);          // dynamic type IF polymorphic
                                                       // throws std::bad_typeid if base_ptr is null
bool same = (typeid(a) == typeid(b));
char const* name = ti.name();                          // implementation-defined, mangled
std::size_t h = std::type_index{ti}.hash_code();
```

| API | Complexity | Notes |
|---|---|---|
| `type_index(type_info const&)` | O(1) | implicit, `noexcept`; stores a pointer |
| `==` / `<=>` (C++20) | O(1) | ordering is arbitrary but consistent in-process |
| `hash_code()` / `std::hash<type_index>` | O(1) | equal types → equal hashes; not stable across runs |
| `name()` | O(1) | implementation-defined, often mangled |
| `typeid(expr)` on polymorphic glvalue | O(1) | dynamic type; `bad_typeid` on null deref |
| `typeid(expr)` otherwise | compile-time | static type; operand is unevaluated |

```cpp
#include <utility>

// ---- integer_sequence ---------------------------------------------------
template<class Tuple, std::size_t... I>
void print_impl(Tuple const& t, std::index_sequence<I...>) {
    (print_one(std::get<I>(t)), ...);                 // fold over a comma
}
template<class... Ts>
void print_fields(std::tuple<Ts...> const& t) {
    print_impl(t, std::index_sequence_for<Ts...>{});  // == make_index_sequence<sizeof...(Ts)>
}

using S1 = std::integer_sequence<int, 0, 1, 2>;
using S2 = std::index_sequence<0, 1, 2>;              // integer_sequence<size_t, …>
using S3 = std::make_index_sequence<3>;               // 0,1,2
using S4 = std::make_integer_sequence<int, 3>;
constexpr auto n = S1::size();                        // 3
using V = S1::value_type;                             // int

// C++20 template lambda often replaces the helper entirely:
auto each = [&]<std::size_t... I>(std::index_sequence<I...>) {
    (print_one(std::get<I>(t)), ...);
};
each(std::make_index_sequence<std::tuple_size_v<Tuple>>{});
```

```cpp
// ---- high-value one-liners ---------------------------------------------
auto old  = std::exchange(state, State::stopped);     // set new, return old (move-based)
auto u    = std::to_underlying(Side::bid);            // C++23; == static_cast<underlying_type_t<E>>
auto&  cx = std::as_const(x);                         // T const&; rvalue overload deleted
auto   mv = std::move(x);                             // CAST to rvalue; transfers nothing itself
auto   fw = std::forward<T>(x);                       // preserves deduced value category
std::swap(a, b);                                      // 3 moves (or ADL/member swap)
std::ranges::swap(a, b);                              // C++20 CPO: member → ADL → default
auto  mn  = std::move_if_noexcept(x);                 // move only if noexcept-movable
[[noreturn]] void die() { std::unreachable(); }       // C++23: UB if reached; enables optimization

// ---- safe integer comparison (C++20, <utility>) -------------------------
int i = -1; unsigned n = 1;
// if (i < n)                       // TRUE: i converts to a huge unsigned
if (std::cmp_less(i, n))            {}   // false — correct mathematical comparison
if (std::cmp_less_equal(i, n))      {}
if (std::cmp_greater(i, n))         {}
if (std::cmp_not_equal(i, n))       {}
if (std::in_range<std::uint16_t>(v)) {}  // fits without change of value?
```

| Utility | Header | Notes |
|---|---|---|
| `exchange(obj, new)` | `<utility>` | returns old by value; `constexpr`; basis of move assignment |
| `to_underlying(e)` (C++23) | `<utility>` | replaces `static_cast<std::underlying_type_t<E>>` |
| `as_const(x)` | `<utility>` | forces const overload; rvalue overload `= delete` |
| `move` / `forward` / `forward_like` (C++23) | `<utility>` | casts only — no runtime work |
| `move_if_noexcept(x)` | `<utility>` | copy when the move can throw |
| `swap` / `ranges::swap` | `<utility>` / `<concepts>` | 3 moves by default; may be O(n) for some types |
| `cmp_equal/not_equal/less/greater/less_equal/greater_equal` | `<utility>` | integral-only, no promotion trap |
| `in_range<T>(v)` | `<utility>` | value representable in `T` |
| `unreachable()` (C++23) | `<utility>` | UB if executed; not an assert |
| `integer_sequence` / `index_sequence` / `make_index_sequence<N>` / `index_sequence_for<Ts...>` | `<utility>` | pure compile-time packs |
| `type_index` | `<typeindex>` | hashable/orderable RTTI key |

**Hot-path representation checklist**

| Question | Why it decides the design |
|---|---|
| Own, borrow, or type-erase? | determines lifetime obligations at every call site |
| How many representable states? | `optional<T*>`, `optional<bool>`, valueless variant all add one |
| `sizeof` and alignment? | cache density and queue slot size |
| Can construct/assign/visit/copy throw? | valueless states and rollback complexity |
| Can it allocate — directly or via its payload? | `any`, `stacktrace`, `to_string` all can |
| What views become stale on state change? | spans, `mdspan`, references into an `optional` |
| Still trivially copyable? | required by seqlocks, snapshots, and shared-memory queues |

```cpp
static_assert(std::is_trivially_copyable_v<std::span<int>>);
static_assert(std::is_trivially_copyable_v<std::optional<int>>);
// Do NOT generalize: optional<std::string>, any, and variant<std::string,…> are not.
```

**Interview line** — "Pick the vocabulary type by the semantics you want to force callers to handle, then measure `sizeof`, dispatch, and allocation before it reaches the hot path."

**Traps** — `typeid` names and `hash_code()` differ across builds and are useless as persisted identity · RTTI can be compiled out, silently breaking `any`/`type_index` designs · `std::move` on a `const` object silently copies · `exchange` requires the new value to be assignable, not just constructible · `index_sequence` costs no runtime but does cost compile time and code size proportional to the pack · `unreachable()` is an optimization promise, not a check — use `assert` for the check.
