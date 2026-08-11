# 48. Code-reading and implementation drills

*Part VIII — Modern C++ evolution and interview drill*

---

**Recall**
- Read every fragment in four passes: name lookup → deduction/constraints → overload resolution → best viable candidate.
- Then runtime: initialization form → owner of every object/view → mutation/invalidation → destruction order.
- Then concurrency: conflicting accesses → synchronizes-with edge → happens-before chain.
- Then cost: work/capacity/allocation → locality/contention → what the measurement scope actually covers.
- Braces are not parentheses: `{}` prefers an `initializer_list` constructor and forbids narrowing, and that preference is *not* a fallback.
- Copy elision is mandatory only for prvalue initialization (C++17); NRVO is permitted, never guaranteed.
- `return std::move(local)` disables NRVO and is almost always a pessimization; `return local` already moves when eligible.
- `T&&` is a forwarding reference only in a deduced context; a named rvalue-reference parameter is an lvalue inside the function.
- `decltype(id)` gives the declared type; `decltype((id))` gives `T&` because a parenthesized id-expression is an lvalue.
- A view never extends a lifetime — `string_view`, `span`, and `views::*` all dangle over a destroyed owner.
- Vector reallocation invalidates every iterator/pointer/reference; `erase(pos)` invalidates at and after `pos`.
- Reinterpreting bytes as a wider integer risks misalignment, type-access (strict-aliasing) violation, and host-endian assumptions; shift or `memcpy` instead.
- `memcmp` on class objects compares padding and alternate value representations — object equality ≠ value equality.
- Exception safety = do all throwing work first, then commit with non-throwing operations; state which guarantee you claim.
- Publication is *release on the writer, acquire on the reader*; a store may not be `acquire` and a load may not be `release`.
- A relaxed atomic flag orders nothing: the ordinary payload access still races.
- `acquire` is not "read the freshest value" — it constrains ordering only when it observes the matching release.
- On CAS failure `expected` is overwritten, so any `desired` derived from it must be recomputed inside the loop.
- Bounded components must state capacity, failure policy (`false`/`nullopt`/`expected`), invariants, and the `noexcept` proof.
- A benchmark that discards its result, uses one compile-time-known input, and prints a batch average measures nothing useful.

---

## 48.1 Initialization and overload-resolution puzzles

```cpp
#include <initializer_list>
#include <vector>
#include <string>

void pick(int);                              // #1
void pick(double);                           // #2
void pick(std::initializer_list<int>);       // #3

void drill_1() {
    std::vector<int> a(3, 7);   // 3 elements, each 7      — parenthesized ctor
    std::vector<int> b{3, 7};   // 2 elements: 3, 7        — init-list ctor wins
    std::vector<int> c{};       // empty (value-init), NOT vector(0)
    std::vector<int> d = {};    // empty
    std::vector<std::string> e(3);   // 3 empty strings
    std::vector<std::string> f{3};   // ill-formed: no string from int (narrowing/none)

    pick(1);        // #1 exact match
    pick(1.0);      // #2 exact match
    pick({1});      // #3 — list-init prefers the initializer_list candidate
    pick({});       // #3 with an empty list (not #1 with 0)
 // pick({1.0});    // ILL-FORMED: #3 is preferred, then double→int narrows
    pick(1.0f);     // #2 via float→double promotion (better than →int conversion)
}
```

**Answer** — the defect is assuming `{}` behaves like `()`: `b{3,7}` builds two elements, and `pick({1.0})` does *not* silently fall back to `pick(double)`; the repair is to spell size-and-fill constructors with parentheses (`vector<int> a(3, 7)`) and to pass non-list arguments unbraced when overloads on `initializer_list` exist.

```cpp
// ---- every initialization form, and what it means ----------------------
int    i1;            // indeterminate (automatic storage)
int    i2{};          // value-initialized → 0
int    i3 = 5;        // copy-initialization
int    i4(5);         // direct-initialization
int    i5{5};         // direct-list-init, no narrowing allowed
int    i6 = {5};      // copy-list-init
// int i7{5.0};       // ill-formed: narrowing double→int
int    i8{static_cast<int>(5.0)};   // explicit, fine
auto   a1 = {1, 2};   // std::initializer_list<int>          (copy-list-init)
auto   a2{1};         // int                                 (C++17 rule)
// auto a3{1, 2};     // ill-formed: direct-list auto needs exactly one element
auto   a4 = std::vector{1, 2};      // CTAD → vector<int>

struct Agg { int x; double y; };
Agg g1{};             // {0, 0.0}
Agg g2{1};            // {1, 0.0} — remainder value-initialized
Agg g3{.x = 1, .y = 2};             // designated init (C++20), declaration order
Agg g4(1, 2.0);       // parenthesized aggregate init (C++20)

struct Ex { explicit Ex(int); };
Ex e1{1};             // OK: direct-list-init sees explicit ctors
// Ex e2 = {1};       // ill-formed: copy-list-init rejects explicit
// Ex e3 = 1;         // ill-formed
```

| Construct | Resolution rule | Gotcha |
|---|---|---|
| `T x(a, b)` | ordinary overload resolution | most-vexing-parse when args are type-ids |
| `T x{a, b}` | `initializer_list` ctors considered **first** | narrowing is an error, not a demotion |
| `T x = {a}` | copy-list-init | `explicit` ctors make it ill-formed |
| `auto x{a}` | deduces `decltype(a)` (C++17) | single element only |
| `auto x = {a, b}` | deduces `initializer_list` | dangles if the list outlives the full-expression |
| `T x{}` | value-initialization | for class types with defaulted ctor: zero-init then default-ctor |

**Traps** — `vector<int> v{n}` makes one element `n`, not `n` elements · `Widget w();` declares a function · `explicit` is invisible to `emplace_back` · `initializer_list` elements are `const`, so they can only be copied out, never moved · `auto x = {…}`'s backing array dies at the end of the full-expression.

---

## 48.2 Copy-elision and move-semantics traces

```cpp
#include <utility>

struct Trace {
    Trace();
    Trace(Trace const&);          // copy
    Trace(Trace&&) noexcept;      // move
    Trace& operator=(Trace const&);
    Trace& operator=(Trace&&) noexcept;
    ~Trace();
};

Trace direct()  { return Trace{}; }              // prvalue → guaranteed elision (C++17)
Trace named()   { Trace x; return x; }           // NRVO permitted, else implicit move
Trace forced()  { Trace x; return std::move(x); }// NRVO disabled → one move, always
Trace param(Trace p) { return p; }               // parameter: never NRVO, implicit move
Trace member(Trace& r) { return r; }             // lvalue ref → COPY (not eligible)

void drill_2() {
    Trace a = direct();   // 0 copies, 0 moves — mandatory
    Trace b = named();    // 0 (NRVO) or 1 move
    Trace c = forced();   // exactly 1 move — the pessimization
    Trace d = param(a);   // 1 copy into p, then 0-or-1 move out
}
```

**Answer** — the defect is `return std::move(x);` in `forced()`: the operand is no longer the name of an eligible local, so NRVO is suppressed and a move is mandated; the repair is `return x;`, which permits NRVO and otherwise falls back to an implicit move.

```cpp
// ---- the const trap ----------------------------------------------------
Trace const cx;
Trace y = std::move(cx);   // static_cast<Trace const&&> → Trace(Trace&&) cannot
                           // bind (would discard const) → COPY constructor runs
// Repair: do not declare movable-from locals const.

// ---- self-inflicted copies --------------------------------------------
struct Holder {
    std::string s_;
    explicit Holder(std::string s) : s_(std::move(s)) {}   // sink + move: 1 move
    // explicit Holder(std::string s) : s_(s) {}           // BUG: extra copy
    void set(std::string s) { s_ = std::move(s); }         // reuses capacity
};

// ---- rule of zero / five ----------------------------------------------
struct Rule5 {
    Rule5(Rule5 const&);
    Rule5(Rule5&&) noexcept;
    Rule5& operator=(Rule5 const&);
    Rule5& operator=(Rule5&&) noexcept;
    ~Rule5();
};
struct BadDtor { ~BadDtor(); };   // user dtor ⇒ move ops NOT generated ⇒ copies
```

| Return expression | Elision | Fallback |
|---|---|---|
| `return T{…};` (prvalue) | guaranteed, no ctor call at all | — |
| `return local;` | NRVO permitted | implicit move (overload resolution twice) |
| `return std::move(local);` | **suppressed** | move |
| `return param;` | no NRVO | implicit move |
| `return ref;` / `return *ptr;` | no | copy |
| `return global;` | no | copy |
| `return cond ? a : b;` | no NRVO | implicit move (C++23 relaxed rules) |

**Traps** — a throwing move constructor makes `vector` reallocation copy (`move_if_noexcept`) · declaring any destructor kills implicit move operations · `std::move` on a `const` object silently copies · elision is about *constructors*, not about the destructor of the source.

---

## 48.3 Template deduction and forwarding traces

```cpp
#include <functional>
#include <utility>
#include <type_traits>

template<class T> void inspect(T&& x);   // forwarding reference

void drill_3() {
    int i = 0;
    int const ci = 0;
    inspect(i);    // T = int&        → param int&        → x is an LVALUE
    inspect(ci);   // T = int const&  → param int const&  → x is an LVALUE
    inspect(0);    // T = int         → param int&&       → x is an LVALUE (it is named)
    inspect(std::move(i));  // T = int → param int&&      → x is an LVALUE
}

template<class T> void by_value(T);      // decays: strips ref/const/array/function
template<class T> void by_cref(T const&);// T never has top-level const
template<class T> void by_rref(T&&);     // forwarding only because T is deduced
void not_forwarding(std::string&&);      // ordinary rvalue ref — NOT forwarding

template<class T>
struct Box { void take(T&& t); };        // NOT forwarding: T is fixed by the class
```

**Answer** — the defect in reading `inspect(0)` as "an rvalue inside the body" is confusing type with value category: `x` is a named parameter and therefore an lvalue; the repair is `std::forward<T>(x)` at the single point of use, which restores the caller's category exactly once.

```cpp
// ---- correct perfect forwarding ---------------------------------------
template<class F, class... Args>
constexpr decltype(auto) relay(F&& f, Args&&... args)
    noexcept(std::is_nothrow_invocable_v<F, Args...>)
{
    return std::invoke(std::forward<F>(f), std::forward<Args>(args)...);
}
// decltype(auto): preserves reference-ness of the callee's return type.
// forward ONCE per argument: forwarding twice can move from the same object twice.

// ---- reference collapsing ---------------------------------------------
// T&  &  → T&    T&  && → T&    T&& &  → T&    T&& && → T&&   ("& wins")
static_assert(std::is_same_v<int& &&, int&>);          // via alias/deduction only

// ---- decltype special rules -------------------------------------------
int n = 0;
decltype(n)     d1 = 1;    // int   — unparenthesized id-expression: declared type
decltype((n))   d2 = n;    // int&  — parenthesized: lvalue expression → T&
decltype(n + 0) d3 = 1;    // int   — prvalue → T
decltype(auto)  d4 = (n);  // int&  — same rules applied to the initializer

// ---- constrained forwarding (C++20) -----------------------------------
template<class T>
    requires std::is_constructible_v<std::string, T&&>
void emplace_symbol(T&& t);          // stops the greedy-ctor hijack

template<class Self>
void deducing_this(this Self&& self);  // C++23 explicit object parameter
```

| Call form | Deduced `T` | Parameter type | Notes |
|---|---|---|---|
| `f(lvalue)` on `T&&` | `U&` | `U&` | collapse `U& &&` → `U&` |
| `f(const lvalue)` on `T&&` | `U const&` | `U const&` | const preserved |
| `f(rvalue)` on `T&&` | `U` | `U&&` | |
| `f(arr)` on `T` | `U*` | `U*` | array-to-pointer decay |
| `f(arr)` on `T&` | `U[N]` | `U(&)[N]` | extent preserved |
| `f(lambda)` on `T` | closure type | by value | not a function pointer |
| braced arg on `T` | — | — | non-deduced; `auto` is the exception |

**Traps** — a greedy `template<class T> Widget(T&&)` beats the copy constructor for non-const lvalues · `std::forward<T>` without an explicit `T` is meaningless · `auto&&` in a range-for is a forwarding reference, `auto&` is not · `Box<T>::take(T&&)` takes an rvalue only.

---

## 48.4 Object lifetime, aliasing, and byte-access audits

```cpp
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <span>
#include <string>
#include <string_view>

std::string_view symbol() {
    std::string s = "EURUSD";
    return s;                                  // (1)
}

std::uint32_t load(std::byte const* p) {
    return *reinterpret_cast<std::uint32_t const*>(p);   // (2)
}

struct Packet { std::uint8_t tag; std::uint32_t value; };
bool same(Packet const& a, Packet const& b) {
    return std::memcmp(&a, &b, sizeof(Packet)) == 0;     // (3)
}
```

**Answer** — (1) returns a view into storage destroyed at the return, (2) assumes alignment, native endianness, and legal type access on bytes that hold no `uint32_t` object, and (3) compares padding bytes and alternate value representations; the repairs are: return an owning `std::string` (or a view of static/caller-owned storage), decode bytes with explicit shifts or `memcpy` into a live trivially copyable object, and compare members (or `= default`ed `operator==`).

```cpp
// ---- repaired forms ----------------------------------------------------
std::string symbol_owned() { return std::string{"EURUSD"}; }
constexpr std::string_view symbol_static() { return "EURUSD"; }   // static storage

constexpr std::uint32_t load_be_u32(std::span<std::byte const, 4> b) noexcept {
    return (std::to_integer<std::uint32_t>(b[0]) << 24) |
           (std::to_integer<std::uint32_t>(b[1]) << 16) |
           (std::to_integer<std::uint32_t>(b[2]) <<  8) |
            std::to_integer<std::uint32_t>(b[3]);
}

std::uint32_t load_native(std::byte const* p) noexcept {
    std::uint32_t v;                       // live object of the right type
    std::memcpy(&v, p, sizeof v);          // no alignment/aliasing requirement
    return v;                              // still host-endian — convert if wire data
}

struct Packet2 {
    std::uint8_t tag{};
    std::uint32_t value{};
    friend bool operator==(Packet2 const&, Packet2 const&) = default;  // member-wise
};

// ---- C++20/23 lifetime and byte tools ---------------------------------
#include <bit>
#include <memory>
auto bits = std::bit_cast<std::uint32_t>(3.0f);       // C++20, same size, trivially copyable
auto sw   = std::byteswap(std::uint32_t{0x01020304}); // C++23
constexpr bool le = (std::endian::native == std::endian::little);
auto* obj = std::start_lifetime_as<Packet2>(buffer);  // C++23, implicit-lifetime types
auto* p2  = std::launder(reinterpret_cast<Packet2*>(storage));  // after placement new
```

| Hazard | Why it is UB | Repair |
|---|---|---|
| View outliving owner | no lifetime extension through `string_view`/`span`/`views` | return owning value; document ownership |
| `reinterpret_cast` to wider type | alignment + no object of that type there | `memcpy` / shifts / `bit_cast` |
| Reading through the wrong type | type-access rules ("strict aliasing") | go through `std::byte`/`char`/`memcpy` |
| Packed wire struct overlay | padding, endianness, ABI | field-by-field decode |
| `memcmp` on class types | padding, negative zero, redundant reps | `= default` comparison |
| Placement new then old pointer | old pointer may not name the new object | `std::launder` / use the `new` result |
| Reference to temporary member | extension applies only to the whole temporary, once | copy it |

**Traps** — lifetime extension does not apply through a function return, a member reference, or a chained call · `const&` binding to a temporary extends only in the direct-binding case · `std::span` over a temporary container dangles the same way · pointer arithmetic past one-past-the-end is UB even if never dereferenced.

---

## 48.5 Iterator invalidation and dangling-view audits

```cpp
#include <ranges>
#include <string>
#include <string_view>
#include <vector>
void use(std::string_view);
void use(std::string const&);

void drill_5() {
    std::vector<std::string> names{"A", "B", "C"};
    auto first = std::string_view{names[0]};
    auto it    = names.begin() + 1;

    names.push_back("D");     // may reallocate → it dangles, first dangles
    use(first);               // UB if reallocation happened (SSO makes it visible)
    names.erase(names.begin());
    use(*it);                 // UB: erase invalidated at and after the erased pos
}

auto make_even() {
    std::vector<int> v{1, 2, 3, 4};
    return v | std::views::filter([](int x) { return x % 2 == 0; });  // dangles
}
```

**Answer** — the defects are a `string_view` and an iterator captured across a possibly reallocating `push_back` and a definitely shifting `erase`, plus a lazy view returned over a destroyed local; the repairs are to `reserve` an enforced maximum before taking handles, store indices/IDs and re-acquire after every mutation, and materialize views with `std::ranges::to<std::vector>()` (or `views::owning_view` over a moved-in container) before returning them.

```cpp
// ---- repaired ----------------------------------------------------------
void drill_5_fixed() {
    std::vector<std::string> names;
    names.reserve(4);                       // proven maximum → no reallocation
    names.insert(names.end(), {"A", "B", "C"});

    std::size_t idx = 1;                    // index, not iterator
    names.push_back("D");                   // no realloc: handles survive
    use(names[idx]);

    names.erase(names.begin());             // shifts: re-acquire
    idx = 0;
    use(names[idx]);
}

std::vector<int> make_even_owned() {
    std::vector<int> v{1, 2, 3, 4};
    return v | std::views::filter([](int x) { return x % 2 == 0; })
             | std::ranges::to<std::vector>();          // C++23, owning result
}

// ---- erase-while-iterating, the three correct spellings ---------------
for (auto i = v.begin(); i != v.end(); )
    if (pred(*i)) i = v.erase(i); else ++i;             // sequence containers
for (auto i = m.begin(); i != m.end(); )
    if (pred(*i)) i = m.erase(i); else ++i;             // node containers (C++11+)
std::erase_if(v, pred);                                 // C++20, one call
```

| Operation | Invalidates iterators | Invalidates references/pointers |
|---|---|---|
| `vector` realloc (`push_back`, `insert`, `reserve`, `resize↑`) | all | all |
| `vector` `push_back` without realloc | old `end()` only | none |
| `vector` `erase(pos)` | at and after `pos` | at and after `pos` |
| `deque` push/pop at either end | all iterators | none (except erased) |
| `deque` middle insert/erase | all | all |
| `list`/`forward_list` insert/erase/splice | only the erased | only the erased |
| `map`/`set` insert/erase | only the erased | only the erased |
| `unordered_*` insert causing rehash | all | none |
| `string` any capacity change | all | all (invalidates `string_view`) |

**Traps** — a `string_view` into an SSO string dangles when the *string object* moves, even with no allocation · `views::filter` caches `begin()`, so the first traversal is special and the view is not `const`-iterable · a range adaptor over an rvalue container keeps it alive (`owning_view`) but over an lvalue it does not · `unordered_map::operator[]` can rehash.

---

## 48.6 Exception-safety repair exercises

```cpp
#include <cstdint>
#include <expected>
#include <limits>
#include <vector>

class Level {
    std::vector<Order> orders_;
    std::int64_t total_{};
public:
    void add(Order order) {
        total_ += order.quantity();          // committed BEFORE the throwing step
        orders_.push_back(std::move(order)); // may throw → total_ now lies
    }
};
```

**Answer** — the defect is committing aggregate state before the operation that can throw (and before overflow is proven), leaving `total_` inconsistent with `orders_`; the repair is to perform all throwing work first and commit with non-throwing arithmetic afterwards, or to validate capacity and overflow up front and return `std::expected`.

```cpp
// ---- Solution A: throwing work first, non-throwing commit last ---------
void add(Order order) {
    auto const q = order.quantity();
    orders_.push_back(std::move(order));   // throws → no state changed
    total_ += q;                           // cannot throw; overflow pre-validated
}

// ---- Solution B: validate, then report failure without exceptions ------
enum class AddError { capacity, quantity_overflow };

std::expected<void, AddError> try_add(Order order) noexcept {
    static_assert(std::is_nothrow_move_constructible_v<Order>);
    if (orders_.size() == orders_.capacity())
        return std::unexpected(AddError::capacity);
    auto const q = order.quantity();
    if (q > std::numeric_limits<std::int64_t>::max() - total_)
        return std::unexpected(AddError::quantity_overflow);
    orders_.push_back(std::move(order));   // no growth, nothrow move ⇒ noexcept holds
    total_ += q;
    return {};
}

// ---- copy-and-swap: strong guarantee from a nothrow swap ---------------
class Buffer {
    std::vector<std::byte> data_;
public:
    void swap(Buffer& o) noexcept { data_.swap(o.data_); }
    Buffer& operator=(Buffer rhs) noexcept { swap(rhs); return *this; }  // by value
};

// ---- scope guard: rollback for irreversible steps ----------------------
template<class F>
class ScopeGuard {
    F f_; bool active_{true};
public:
    explicit ScopeGuard(F f) : f_(std::move(f)) {}
    void dismiss() noexcept { active_ = false; }
    ~ScopeGuard() noexcept { if (active_) f_(); }   // dtor must not throw
    ScopeGuard(ScopeGuard const&) = delete;
};

void link_and_publish(Book& b, Index i) {
    b.link(i);
    ScopeGuard undo{[&] { b.unlink(i); }};
    b.index_.emplace(b.node(i).id, i);   // may allocate/throw → undo runs
    undo.dismiss();                      // committed
}
```

| Guarantee | Meaning | How to get it |
|---|---|---|
| Nothrow (`noexcept`) | never throws | only nothrow ops; prove with `is_nothrow_*_v` |
| Strong | commit-or-rollback, state unchanged on throw | do throwing work into temporaries, then nothrow swap/assign |
| Basic | valid but unspecified state, no leaks | RAII everywhere |
| None | broken invariants / leaks | never ship |

**Traps** — `noexcept` that lies calls `std::terminate` · a throwing destructor during stack unwinding terminates · `vector::push_back` is strong only if `T`'s move is `noexcept` or `T` is copyable · a `catch(...)` that swallows and continues turns a strong guarantee into none · two-phase commit needs the *second* phase to be `noexcept`.

---

## 48.7 Acquire/release litmus tests

```cpp
#include <atomic>
#include <cassert>

int payload = 0;
std::atomic<bool> ready{false};

void producer_A() { payload = 42; ready.store(true, std::memory_order_release); }
void consumer_A() { if (ready.load(std::memory_order_acquire)) assert(payload == 42); }

void producer_B() { ready.store(true, std::memory_order_acquire); }   // (B)
void consumer_B() { (void)ready.load(std::memory_order_release); }    // (B)

void producer_C() { payload = 42; ready.store(true, std::memory_order_relaxed); } // (C)
void consumer_C() { if (ready.load(std::memory_order_relaxed)) assert(payload == 42); }
```

**Answer** — A is correct (the acquire load, when it reads the release store, creates synchronizes-with, so `payload = 42` happens-before the assert); B is invalid because a store may not use `acquire` and a load may not use `release` — the repair is release-on-write/acquire-on-read; C is a data race because relaxed atomics order nothing around them — the repair is to upgrade the flag to release/acquire (or make `payload` atomic).

```cpp
// ---- every memory order, and what it buys ------------------------------
std::atomic<int> a{0};
a.load(std::memory_order_relaxed);   // atomicity + modification order only
a.load(std::memory_order_acquire);   // no later access moves before it
a.store(1, std::memory_order_release);// no earlier access moves after it
a.load(std::memory_order_consume);   // dependency-ordered; treat as acquire (discouraged)
a.exchange(1, std::memory_order_acq_rel);      // RMW: both directions
a.load(std::memory_order_seq_cst);   // default: single total order over seq_cst ops
std::atomic_thread_fence(std::memory_order_acquire);   // standalone fence

// ---- CAS: the failure-order and reload rules ---------------------------
std::atomic<Node*> head{nullptr};
void push(Node* n) {
    Node* expected = head.load(std::memory_order_relaxed);
    do {
        n->next = expected;               // MUST be recomputed each iteration
    } while (!head.compare_exchange_weak(expected, n,
                 std::memory_order_release,     // success order
                 std::memory_order_relaxed));   // failure order (never stronger)
}
// compare_exchange_weak may fail spuriously → always in a loop.
// compare_exchange_strong fails only on mismatch → use when there is no loop.
// On failure, `expected` is OVERWRITTEN with the observed value.

// ---- atomic_ref: atomic access to a non-atomic object (C++20) ----------
alignas(std::atomic_ref<std::uint64_t>::required_alignment) std::uint64_t x{};
std::atomic_ref<std::uint64_t> r{x};   // x must outlive r; no conflicting plain access
r.fetch_add(1, std::memory_order_relaxed);

// ---- waiting without spinning (C++20) ----------------------------------
ready.wait(false, std::memory_order_acquire);   // blocks while value == false
ready.notify_one();  ready.notify_all();
```

| Order | Legal on | Guarantee |
|---|---|---|
| `relaxed` | load/store/RMW | atomicity, per-object modification order, no ordering |
| `acquire` | load/RMW | later accesses stay after; pairs with a release it reads |
| `release` | store/RMW | earlier accesses stay before; publishes them |
| `acq_rel` | RMW only | both |
| `seq_cst` | all | plus one global total order (default, most expensive) |
| `consume` | load | dependency ordering; practically promoted to acquire |

**Interview line** — "Publication is release on the writer and acquire on the reader; if the acquire load reads the value written by the release store, everything sequenced before the store happens-before everything sequenced after the load."

**Traps** — acquire does not mean "freshest value": it may legally read an older value in the modification order · a release store publishes only what precedes it *in that thread* · fences order accesses, not individual variables · `volatile` provides no atomicity and no ordering · `atomic<T>::is_lock_free()` is a runtime property; `is_always_lock_free` is the constant.

---

## 48.8 SPSC ring-buffer implementation

```cpp
#include <array>
#include <atomic>
#include <cstddef>
#include <new>
#include <optional>
#include <type_traits>
#include <utility>

template<class T, std::size_t Capacity>
class SpscRing {
    static_assert(Capacity > 0);
    static_assert(std::is_nothrow_move_constructible_v<T>);
#ifdef __cpp_lib_hardware_interference_size
    static constexpr std::size_t line = std::hardware_destructive_interference_size;
#else
    static constexpr std::size_t line = 64;   // platform assumption — measure it
#endif
public:
    SpscRing() = default;
    SpscRing(SpscRing const&) = delete;
    SpscRing& operator=(SpscRing const&) = delete;

    [[nodiscard]] bool try_push(T value) noexcept {
        auto const head = head_.load(std::memory_order_relaxed);   // producer-owned
        auto const tail = tail_.load(std::memory_order_acquire);   // see freed slots
        if (head - tail == Capacity) return false;                 // full
        slots_[head % Capacity].emplace(std::move(value));         // construct
        head_.store(head + 1, std::memory_order_release);          // publish it
        return true;
    }

    [[nodiscard]] bool try_pop(T& out) noexcept(std::is_nothrow_move_assignable_v<T>) {
        auto const tail = tail_.load(std::memory_order_relaxed);   // consumer-owned
        auto const head = head_.load(std::memory_order_acquire);   // see published
        if (tail == head) return false;                            // empty
        auto& slot = slots_[tail % Capacity];
        out = std::move(*slot);
        slot.reset();                                              // end lifetime
        tail_.store(tail + 1, std::memory_order_release);          // release the slot
        return true;
    }

    [[nodiscard]] std::optional<T> try_pop() {                     // convenience
        T tmp;
        if (!try_pop(tmp)) return std::nullopt;
        return std::optional<T>{std::move(tmp)};
    }

    // Approximate: valid only as a hint, never as a synchronization decision.
    [[nodiscard]] std::size_t size_approx() const noexcept {
        return head_.load(std::memory_order_acquire) -
               tail_.load(std::memory_order_acquire);
    }

private:
    alignas(line) std::atomic<std::size_t> head_{0};   // written by producer only
    alignas(line) std::atomic<std::size_t> tail_{0};   // written by consumer only
    alignas(line) std::array<std::optional<T>, Capacity> slots_{};
};
```

**Answer** — the classic defects this design removes are (a) `head_`/`tail_` sharing a cache line (false sharing → fix with `alignas(hardware_destructive_interference_size)`), (b) relaxed publication of the payload (fix: release-store `head_` after construction, acquire-load it before reading the slot), and (c) reusing a slot before the consumer finished with it (fix: the reverse release/acquire edge on `tail_`).

```text
producer:  construct slot[head] ── release ──▶ head_ = head+1
consumer:                         acquire ──▶ read head_, read slot, destroy
consumer:  destroy slot[tail]   ── release ──▶ tail_ = tail+1
producer:                         acquire ──▶ read tail_, reuse slot
```

| Property | This design | Proof / caveat |
|---|---|---|
| Topology | exactly one producer, one consumer | more of either breaks every invariant |
| Allocation after construction | none | `std::array` inline storage |
| Full / empty | `head - tail == Capacity` / `head == tail` | unsigned counters; distance bounded by `Capacity` |
| Slot lifetime | `optional` constructs/destroys | raw storage + placement new is tighter but manual |
| `try_push` | `noexcept`, O(1) | requires nothrow move-construct of `T` |
| `try_pop` | conditional `noexcept`, O(1) | a throwing move-assign leaves the element live |
| Wraparound | `% Capacity` | use a power-of-two `& (Capacity-1)` for a cheaper mask |
| `size()` | approximate only | two loads are not atomic together |

**Traps** — never index with a *stored* modulo counter and also compare raw counters · a `size()` used for a control decision is a race · shutdown/drain is not part of `try_push`/`try_pop` and must be designed separately · `alignas(64)` is a guess unless measured · test capacity 1, exact wraparound, move-only payloads, and long stress under TSan.

---

## 48.9 Fixed-block allocator implementation

```cpp
#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <new>
#include <optional>
#include <utility>

template<class T, std::size_t N>
class FixedPool {
    static_assert(N > 0 && N <= UINT32_MAX - 1);
public:
    struct Handle {
        std::uint32_t index{};
        std::uint32_t generation{};
        friend bool operator==(Handle, Handle) = default;
    };

    FixedPool() noexcept {
        for (std::uint32_t i = 0; i + 1 < N; ++i) slots_[i].next = i + 1;
        slots_[N - 1].next = none;                  // freelist terminator
    }
    FixedPool(FixedPool const&) = delete;           // storage is address-bound
    FixedPool& operator=(FixedPool const&) = delete;
    ~FixedPool() {
        for (auto& s : slots_) if (s.live) std::destroy_at(ptr(s));
    }

    template<class... Args>
    [[nodiscard]] std::optional<Handle> create(Args&&... args) {
        if (free_ == none) return std::nullopt;     // exhaustion is a value, not a throw
        auto const i = free_;
        auto& slot = slots_[i];
        auto const next = slot.next;                // read before overwriting storage
        std::construct_at(raw_ptr(slot), std::forward<Args>(args)...);  // may throw
        slot.live = true;
        free_ = next;                               // commit only after construction
        return Handle{i, slot.generation};
    }

    [[nodiscard]] T* get(Handle h) noexcept {
        if (h.index >= N) return nullptr;
        auto& slot = slots_[h.index];
        if (!slot.live || slot.generation != h.generation) return nullptr;  // stale
        return ptr(slot);
    }
    [[nodiscard]] T const* get(Handle h) const noexcept {
        return const_cast<FixedPool*>(this)->get(h);
    }

    [[nodiscard]] bool destroy(Handle h) noexcept {
        auto* object = get(h);
        if (!object) return false;                  // double-destroy is rejected
        auto& slot = slots_[h.index];
        std::destroy_at(object);
        slot.live = false;
        ++slot.generation;                          // invalidates every old handle
        slot.next = free_;
        free_ = h.index;
        return true;
    }

    [[nodiscard]] std::size_t capacity() const noexcept { return N; }

private:
    static constexpr std::uint32_t none = UINT32_MAX;
    struct Slot {
        alignas(T) std::array<std::byte, sizeof(T)> storage{};
        std::uint32_t next{none};
        std::uint32_t generation{};
        bool live{};
    };
    static T* raw_ptr(Slot& s) noexcept { return reinterpret_cast<T*>(s.storage.data()); }
    static T* ptr(Slot& s) noexcept { return std::launder(raw_ptr(s)); }

    std::array<Slot, N> slots_{};
    std::uint32_t free_{0};
};
```

**Answer** — the defects a naive pool shows are (a) popping the freelist *before* constructing, so a throwing constructor loses the slot — repaired by committing `free_ = next` only after `construct_at` succeeds; (b) raw indices as handles, so a reused slot silently answers a stale handle — repaired by the `generation` tag checked in `get`; and (c) returning `reinterpret_cast<T*>(storage)` without `std::launder` after placement new — repaired by `ptr()`.

| Invariant | Statement |
|---|---|
| Slot state | live with exactly one `T`, or free with a valid `next` link |
| Partition | free-list ∪ live set = all `N` slots, disjoint |
| Handle validity | `get` returns non-null iff slot live and generation matches |
| Exception safety | `create` is strong: throw leaves freelist and `live` unchanged |
| Allocation | zero after construction; `create` is O(1), `destroy` is O(1) |
| Address stability | `T*` from `get` is stable until that slot is destroyed |
| Threading | thread-confined; a lock-free freelist adds ABA and reclamation problems |

**Traps** — generation wrap resurrects stale handles: widen the counter or retire the slot · the pool object itself must not move (copy deleted, no move supplied) · a throwing destructor breaks `destroy`'s `noexcept` · `std::array<std::byte, sizeof(T)>` needs `alignas(T)` or every access is misaligned · test exhaustion, constructor-throw, double-destroy, and destructor counts.

---

## 48.10 Zero-allocation numeric parser implementation

```cpp
#include <cstdint>
#include <expected>
#include <limits>
#include <string_view>

enum class PriceError { empty, invalid, too_many_fraction_digits, overflow };

// Grammar: [0-9]+ ( '.' [0-9]{0,4} )?  → signed 64-bit ten-thousandths.
// No locale, allocation, streams, floating point, or exceptions.
[[nodiscard]] constexpr std::expected<std::int64_t, PriceError>
parse_price4(std::string_view s) noexcept {
    if (s.empty()) return std::unexpected(PriceError::empty);

    constexpr std::uint64_t scale = 10'000;
    constexpr auto max = static_cast<std::uint64_t>(
        std::numeric_limits<std::int64_t>::max());

    std::uint64_t whole = 0;
    std::size_t pos = 0;
    bool saw_digit = false;

    while (pos < s.size() && s[pos] != '.') {
        char const c = s[pos++];
        if (c < '0' || c > '9') return std::unexpected(PriceError::invalid);
        saw_digit = true;
        auto const digit = static_cast<std::uint64_t>(c - '0');
        if (whole > (max - digit) / 10)                 // check BEFORE multiplying
            return std::unexpected(PriceError::overflow);
        whole = whole * 10 + digit;
    }
    if (!saw_digit) return std::unexpected(PriceError::invalid);

    std::uint64_t fraction = 0;
    std::size_t digits = 0;
    if (pos < s.size()) {
        ++pos;                                          // consume '.'
        while (pos < s.size()) {
            char const c = s[pos++];
            if (c < '0' || c > '9') return std::unexpected(PriceError::invalid);
            if (digits == 4) return std::unexpected(PriceError::too_many_fraction_digits);
            fraction = fraction * 10 + static_cast<std::uint64_t>(c - '0');
            ++digits;
        }
    }
    while (digits++ < 4) fraction *= 10;                // left-align to 4 places

    if (whole > (max - fraction) / scale)               // scale overflow check
        return std::unexpected(PriceError::overflow);
    return static_cast<std::int64_t>(whole * scale + fraction);
}

static_assert(parse_price4("12.34").value() == 123'400);
static_assert(parse_price4("0").value() == 0);
static_assert(parse_price4("1.0001").value() == 10'001);
static_assert(!parse_price4(".5"));            // no leading digit
static_assert(!parse_price4("1.23456"));       // excess precision
static_assert(!parse_price4(""));
static_assert(parse_price4("922337203685477.5807").has_value());  // INT64_MAX
```

**Answer** — the defects of the usual attempt are `std::stod`/`atof` (floating point cannot represent tick values exactly, and `atof` has no error channel), `std::stoll` on a `string_view` (forces an allocation and throws), and checking overflow *after* `whole = whole*10 + d` (the wrap has already happened); the repair is the `whole > (max - digit) / 10` pre-check above plus an `expected` error channel, giving a `constexpr noexcept` allocation-free parser.

```cpp
// ---- alternative: std::from_chars (C++17, no locale, no allocation) ----
#include <charconv>
std::int64_t v{};
auto [ptr, ec] = std::from_chars(s.data(), s.data() + s.size(), v, 10);
// ec == std::errc{} on success; ptr marks the first unconsumed character.
// ec == std::errc::result_out_of_range on overflow; NO exception, NO allocation.
// Floating-point from_chars exists but is still binary FP — not a price type.
```

| Requirement | Mechanism |
|---|---|
| No allocation | `string_view` in, integer out; no `std::string`, no streams |
| No exceptions | `std::expected<std::int64_t, PriceError>` + `noexcept` |
| No floating point | integer ten-thousandths |
| Overflow-proof | compare against `(max - term) / factor` before each step |
| Compile-time testable | `constexpr` ⇒ `static_assert` cases |
| No locale dependence | explicit `'0'..'9'` range test, not `isdigit` |

**Traps** — `isdigit(c)` with a negative `char` is UB; cast to `unsigned char` · `"1."` is accepted by this grammar — reject it if policy demands a digit after the dot · adding a sign needs the `INT64_MIN` asymmetry handled in unsigned magnitude before negation · rounding excess digits requires an explicit tie policy; this version rejects them · the `string_view` is borrowed and never retained.

---

## 48.11 Wire decoder implementation

```text
byte  0      type = 1
bytes 1..4   big-endian order ID
bytes 5..8   big-endian price ticks
bytes 9..12  big-endian quantity, must be nonzero
byte  13     side: 0 = bid, 1 = ask
exact size   14 bytes
```

```cpp
#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

enum class Side : std::uint8_t { bid, ask };
struct Add {
    std::uint32_t id{};
    std::uint32_t price{};
    std::uint32_t quantity{};
    Side side{};
    friend bool operator==(Add const&, Add const&) = default;
};
enum class DecodeError { wrong_size, wrong_type, zero_quantity, bad_side };

constexpr std::uint32_t be32(std::span<std::byte const, 4> b) noexcept {
    return (std::to_integer<std::uint32_t>(b[0]) << 24) |
           (std::to_integer<std::uint32_t>(b[1]) << 16) |
           (std::to_integer<std::uint32_t>(b[2]) <<  8) |
            std::to_integer<std::uint32_t>(b[3]);
}

[[nodiscard]] constexpr std::expected<Add, DecodeError>
decode_add(std::span<std::byte const> bytes) noexcept {
    if (bytes.size() != 14) return std::unexpected(DecodeError::wrong_size);  // once
    if (bytes[0] != std::byte{1}) return std::unexpected(DecodeError::wrong_type);

    auto const id    = be32(bytes.subspan<1, 4>());   // static extent, bounds proven
    auto const price = be32(bytes.subspan<5, 4>());
    auto const qty   = be32(bytes.subspan<9, 4>());
    if (qty == 0) return std::unexpected(DecodeError::zero_quantity);

    Side side{};
    switch (std::to_integer<std::uint8_t>(bytes[13])) {
        case 0: side = Side::bid; break;
        case 1: side = Side::ask; break;
        default: return std::unexpected(DecodeError::bad_side);   // no cast-to-enum
    }
    return Add{id, price, qty, side};
}
```

**Answer** — the defect in the overlay version (`auto const* m = reinterpret_cast<Message const*>(bytes.data()); return m->id;`) is fourfold — no object of type `Message` exists in that buffer, the pointer may be misaligned, the struct's padding and field order are implementation-defined, and the integers are host-endian; the repair is the size-checked, shift-based, field-by-field decode above, which produces an owning `Add` with no aliasing, alignment, padding, or endian assumption.

| Check | Placement | Why |
|---|---|---|
| Exact length | first, once | proves every later fixed offset is in bounds |
| Message type tag | before field decode | wrong type must not be misread |
| Big-endian assembly | `to_integer` + shifts | endian-explicit, `constexpr`, alignment-free |
| Domain validation (`qty != 0`) | after decode, before construction | reject at the boundary |
| Enum mapping | explicit `switch`, no `static_cast` | a cast can produce an out-of-range enumerator |
| Output ownership | value struct, no views | nothing borrows the buffer |

```cpp
// ---- variable-length frames: re-validate before every read -------------
[[nodiscard]] constexpr std::expected<std::span<std::byte const>, DecodeError>
take(std::span<std::byte const>& in, std::size_t n) noexcept {
    if (in.size() < n) return std::unexpected(DecodeError::wrong_size);
    auto head = in.first(n);
    in = in.subspan(n);                    // cursor advances only on success
    return head;
}
```

**Traps** — `#pragma pack` structs are non-portable and can produce misaligned member access · `bytes[0] == 1` does not compile for `std::byte` (compare against `std::byte{1}`) · `subspan<Offset, Count>` is checked at compile time only when the source extent is static · test every truncation length `0..13`, exact, oversized, both endian vectors, every invalid side byte, zero quantity, and fuzz arbitrary 14-byte arrays under ASan/UBSan.

---

## 48.12 Limit-order-book implementation and invariant review

```cpp
#include <cstdint>
#include <limits>
#include <unordered_map>
#include <vector>

using Index = std::uint32_t;
inline constexpr Index no_index = std::numeric_limits<Index>::max();

struct OrderNode {
    std::uint64_t id{};
    std::int64_t  price{};
    std::uint64_t quantity{};
    Index prev{no_index};          // index, not pointer: survives vector relocation
    Index next{no_index};
    std::uint32_t generation{};
    bool live{};
};

struct PriceLevel {
    Index head{no_index};          // FIFO front
    Index tail{no_index};          // FIFO back
    std::uint64_t quantity{};      // Σ live node quantities at this price
    std::uint32_t count{};         // number of live nodes
};

class BookCore {
public:
    explicit BookCore(std::size_t capacity)
        : nodes_(capacity), free_(0) {                 // pre-sized ONCE, never grows
        for (Index i = 0; i + 1 < capacity; ++i) nodes_[i].next = i + 1;
        nodes_.back().next = no_index;
        by_id_.reserve(capacity);                      // enforced maximum
    }

    bool add(std::uint64_t id, std::int64_t price, std::uint64_t qty) {
        if (qty == 0 || free_ == no_index) return false;          // capacity failure
        if (by_id_.contains(id)) return false;                    // duplicate ID
        auto& level = levels_[price];                             // may allocate/throw
        auto const i = free_;                                     // ...before linking
        auto const next_free = nodes_[i].next;
        nodes_[i] = OrderNode{id, price, qty, level.tail, no_index,
                              nodes_[i].generation, true};        // init unpublished
        by_id_.emplace(id, i);                                    // throwing step done
        if (level.tail != no_index) nodes_[level.tail].next = i;   // ---- commit ----
        else                        level.head = i;
        level.tail = i;
        level.quantity += qty;
        ++level.count;
        free_ = next_free;
        return true;
    }

    bool cancel(std::uint64_t id) {
        auto it = by_id_.find(id);
        if (it == by_id_.end()) return false;
        auto const i = it->second;
        auto& n = nodes_[i];
        if (!n.live) return false;
        auto& level = levels_[n.price];
        if (n.prev != no_index) nodes_[n.prev].next = n.next; else level.head = n.next;
        if (n.next != no_index) nodes_[n.next].prev = n.prev; else level.tail = n.prev;
        level.quantity -= n.quantity;
        --level.count;
        if (level.count == 0) levels_.erase(n.price);   // drop empty level
        by_id_.erase(it);
        n.live = false;
        ++n.generation;                                 // invalidates stale handles
        n.next = free_;
        free_ = i;
        return true;
    }

private:
    std::vector<OrderNode> nodes_;                      // stable indices
    std::unordered_map<std::uint64_t, Index> by_id_;
    std::unordered_map<std::int64_t, PriceLevel> levels_;
    Index free_{no_index};
};
```

**Answer** — the defects a first draft shows are storing `OrderNode*` into a `std::vector` that reallocates (repair: store `Index` and pre-size the vector once), performing the possibly-throwing `by_id_.emplace` *after* the list links were mutated so a throw leaves a half-linked level (repair: do every allocating/throwing step before the commit block, as above, or install a rollback guard), and forgetting to fix `level.head`/`level.tail` when unlinking the first/last node (repair: the sentinel-checked unlink in `cancel`).

```cpp
// ---- debug-only invariant checker: run after every event in tests -------
void check_invariants(BookCore const&);   // asserts all of:
```

| Invariant | Assertion |
|---|---|
| Sentinels | `head->prev == no_index`, `tail->next == no_index`, or both `no_index` |
| Link symmetry | `next[prev[i]] == i` and `prev[next[i]] == i` for every linked node |
| Uniqueness | no index appears twice; every index `< capacity` |
| Liveness | every node reached from a level is `live` and has that level's price |
| Aggregates | `level.count` and `level.quantity` equal the traversal totals, no overflow |
| ID map | every entry names a live node; every live node has exactly one entry |
| Partition | free list ∪ live set = all slots, disjoint |
| Best price | best bid/ask names a non-empty level; bid < ask (or crossed by policy) |

**What is deliberately incomplete** — replace/execute/partial-fill semantics · bid/ask side separation · best-price maintenance (dense ladder vs sorted vector vs tree) · generation-carrying external handles · snapshot publication and replay sequencing · rollback for the `levels_` insertion · overload/capacity policy · tests.

**Traps** — `unordered_map::operator[]` default-constructs and can rehash mid-transaction · `reserve` without an *enforced* maximum is not a bound · subtracting `level.quantity` before validating `live` corrupts aggregates on double-cancel · "O(1) cancel" requires the ID map, the node index, *and* the intrusive links to be maintained as one transaction.

---

## 48.13 Cache-layout redesign exercise

```cpp
#include <array>
#include <cstdint>
#include <string>
#include <vector>

struct Order {                                   // 100+ bytes, hot fields scattered
    std::uint64_t id;
    std::string symbol;                          // 32 bytes + possible allocation
    std::int64_t price;                          // HOT
    std::uint64_t quantity;                      // HOT
    Side side;                                   // HOT
    std::array<std::uint64_t, 8> diagnostic_timestamps;   // 64 bytes, cold
    std::uint64_t client_tag;                    // cold
};

std::int64_t total(std::vector<Order> const& orders) {
    std::int64_t value = 0;
    for (Order const& o : orders) value += o.price * o.quantity;   // 2 of ~14 words
    return value;
}
```

**Answer** — the defect is that the hot loop touches 16 bytes per order but pulls in two-plus cache lines each iteration because cold diagnostics, a `std::string`, and a client tag sit between the hot fields; the repairs, in order of preference, are hot/cold splitting with a `cold_index`, a structure-of-arrays layout for columnar scans, and replacing `std::string symbol` with a compact interned symbol ID — each a *hypothesis* to be confirmed by measuring `sizeof`, cache misses, and the real mutation mix.

```cpp
// ---- Repair A: hot/cold split -----------------------------------------
struct HotOrder {                 // aim: one line holds several orders
    std::int64_t  price;          // 8
    std::uint64_t quantity;       // 8
    std::uint64_t id;             // 8
    std::uint32_t cold_index;     // 4 — indirection to the rare data
    std::uint32_t symbol_id;      // 4 — interned; text lives cold
    Side side;                    // 1 (+ padding to 40)
};
struct ColdOrder {
    std::string symbol;
    std::array<std::uint64_t, 8> diagnostic_timestamps;
    std::uint64_t client_tag;
};
std::vector<HotOrder>  hot;
std::vector<ColdOrder> cold;      // parallel; index must be maintained on erase

// ---- Repair B: structure of arrays (columnar scans, vectorizable) ------
struct OrdersSoA {
    std::vector<std::int64_t>  prices;
    std::vector<std::uint64_t> quantities;
    std::vector<Side>          sides;
    std::size_t size() const noexcept { return prices.size(); }
};
std::int64_t total(OrdersSoA const& o) {
    std::int64_t v = 0;
    for (std::size_t i = 0; i < o.size(); ++i) v += o.prices[i] * o.quantities[i];
    return v;                     // two dense streams, no cold bytes touched
}

// ---- Repair C: O(1) unordered erase keeps density ----------------------
void erase_unordered(std::vector<HotOrder>& v, std::size_t i,
                     std::vector<std::uint32_t>& id_to_slot) {
    v[i] = v.back();
    id_to_slot[v[i].id] = static_cast<std::uint32_t>(i);   // fix the moved element
    v.pop_back();
}

// ---- Verify, do not assume --------------------------------------------
static_assert(sizeof(HotOrder) <= 40);
// perf stat -e cache-misses,L1-dcache-load-misses ./bench
```

| Technique | Wins when | Costs |
|---|---|---|
| Hot/cold split | hot fields are a small fraction, cold access is rare | one indirection; two containers to keep in sync |
| SoA | scans touch one or two independent columns; vectorizable | insert/erase touches every array; awkward per-object APIs |
| Interned symbol ID | strings are compared/copied, not printed, on the hot path | needs a symbol table and a lifetime for it |
| Bit-packing / smaller types | field ranges are proven bounded | shifts and masks; overflow risk on widening |
| `alignas(64)` per object | the object is genuinely shared across threads | multiplies footprint, worsens TLB and cache pressure |
| Pre-sized flat storage | address stability with no per-element allocation | you own the freelist and exhaustion policy |

**Traps** — `alignas(64)` on every order is a footprint disaster, not an optimization · SoA does not help when the loop needs all columns anyway · padding and field order are implementation-defined: check `sizeof`/`offsetof` rather than counting by hand · reordering members largest-first is a heuristic, not a rule · a layout change that speeds a scan by 20% but doubles insertion cost may lose overall.

---

## 48.14 Benchmark critique and rewrite

```cpp
#include <chrono>
#include <iostream>

void bad_benchmark() {
    auto start = std::chrono::high_resolution_clock::now();
    for (int i = 0; i < 1'000'000; ++i) {
        parse_price("123.4567");            // result discarded
    }
    auto stop = std::chrono::high_resolution_clock::now();
    std::cout << (stop - start).count() / 1'000'000 << " ns\n";
}
```

**Answer** — the defects are: the result is unused so the call can be deleted entirely; the input is a compile-time constant so the compiler can fold or specialize it and the branch predictor sees one path; `high_resolution_clock` need not be steady and its period is unspecified, so `.count()` is not necessarily nanoseconds; integer division truncates and the label overstates precision; and a single batch average reports neither a distribution nor a per-call tail — the repair is the harness below: runtime-loaded varied inputs, a consumed checksum, `steady_clock`, an explicit `duration_cast`, warmup, and repeated samples.

```cpp
#include <chrono>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

// Prevents the optimizer from deleting work, without adding measured cost.
template<class T>
inline void do_not_optimize(T const& value) noexcept {
#if defined(__clang__) || defined(__GNUC__)
    asm volatile("" : : "r,m"(value) : "memory");
#else
    volatile auto sink = value; (void)sink;
#endif
}

struct Sample { std::chrono::nanoseconds duration; std::size_t ops; };

std::vector<Sample> benchmark(std::vector<std::string> const& storage,
                              std::size_t repetitions) {
    std::vector<std::string_view> inputs;          // built at runtime: not foldable
    inputs.reserve(storage.size());
    for (auto const& s : storage) inputs.emplace_back(s);

    std::uint64_t checksum = 0;
    for (auto in : inputs) {                       // warmup: caches, branch predictor
        auto r = parse_price4(in);
        checksum ^= r.value_or(0);
    }
    do_not_optimize(checksum);

    std::vector<Sample> samples;
    samples.reserve(repetitions);
    for (std::size_t rep = 0; rep < repetitions; ++rep) {
        auto const begin = std::chrono::steady_clock::now();   // steady, monotonic
        for (auto in : inputs) {
            auto r = parse_price4(in);
            checksum = checksum * 1099511628211ull ^ r.value_or(0);  // observable work
        }
        auto const end = std::chrono::steady_clock::now();
        samples.push_back({std::chrono::duration_cast<std::chrono::nanoseconds>(
                               end - begin),
                           inputs.size()});
    }
    do_not_optimize(checksum);                     // consumed OUTSIDE the timed region
    return samples;                                // report median/quantiles, not mean
}
```

| Error | Symptom | Repair |
|---|---|---|
| Result discarded | dead-code elimination; impossibly fast | consume via checksum / `do_not_optimize` |
| Constant input | constant folding, perfect prediction | load inputs at runtime, vary them |
| `high_resolution_clock` | may be non-steady; unspecified period | `steady_clock` + `duration_cast` |
| `.count()` labelled "ns" | unit mismatch | cast to `nanoseconds` explicitly |
| One aggregate number | no distribution, no tail | many samples; report median and quantiles |
| Batch average = latency | hides per-op tail | per-op timestamps with measured observer cost |
| No warmup | cold caches/pages/predictor dominate | run a discarded warmup pass |
| No oracle | measures a wrong implementation fast | validate against a reference first |
| Allocation unmeasured | hidden malloc in the loop | counting allocator / heap profiler |
| Nothing checked in codegen | assumptions invisible | inspect the assembly |

**Interview line** — "A microbenchmark is only credible when the result is consumed, the input is not compile-time known, the clock is steady and explicitly cast, and the report is a distribution over repeated runs rather than one batch average."

**Traps** — timing a loop that fits entirely in L1 with a working set the production path never has · comparing binaries built with different flags or with sanitizers enabled · running one A then one B (interleave and randomize instead) · reporting p99 from a batch mean — it cannot be derived · forgetting that `do_not_optimize` itself has a cost that must be small relative to the measured work.

```text
read code     lookup → deduction → initialization → lifetime → mutation → concurrency
braces        initializer_list preferred, narrowing is an error, no fallback
elision       prvalue guaranteed; NRVO optional; never return std::move(local)
forwarding    deduce T, collapse refs, named param is an lvalue, forward once
views         never own; container/string mutation invalidates them
bytes         size-check first, explicit endian, no packed reinterpret overlay
exceptions    throwing work first, nothrow commit last, name the guarantee
publication   write payload → release token → acquire token → read payload
reuse         read/destroy → release free token → acquire → reconstruct
pool          explicit lifetime + freelist + generation + exhaustion value
parser        grammar + scale + overflow-check-before-op + precision policy
book          ID map, slot, level, FIFO links, aggregates = ONE transaction
layout        hot/cold and SoA are hypotheses; measure footprint and mutation
benchmark     consumed work + runtime input + steady clock + distribution

implementation answer = invariants + ownership + failure policy + proof + tests + cost
```
