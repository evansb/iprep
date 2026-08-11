# 8. Classes and structs

*Part II — Classes, resource management, and generic programming*

---

**Recall**
- `class` and `struct` are the same class machinery; only *default member access* and *default base access* differ (private vs public).
- Construction order is fixed: virtual bases (most-derived ctor only) → direct bases in declaration order → non-static members in **declaration** order → ctor body.
- Destruction is the exact reverse: body → members reverse declaration order → direct bases reverse → virtual bases last.
- The mem-initializer list is a *set*, not a sequence: writing it out of order changes nothing but earns `-Wreorder`.
- A default member initializer is used only when the chosen constructor does not name that member in its mem-initializer list.
- If a constructor throws, already-constructed bases/members are destroyed but the complete object's destructor never runs — so every resource must live in an RAII subobject.
- A destructor is implicitly `noexcept`; letting an exception escape during unwinding calls `std::terminate`.
- Virtual calls from a constructor/destructor resolve to the *currently constructing* class's override, never a more-derived one.
- Access control is checked after name lookup and overload resolution — a private overload can still win and then be rejected.
- `this` is a pointer; cv/ref qualifiers on an ordinary member constrain the implicit object argument and participate in overload resolution.
- `mutable` relaxes const checking only; it grants no thread safety, and `const` never implies synchronized.
- C++23 explicit object parameters (`this Self&& self`) collapse `&`/`const&`/`&&` overload sets into one template that preserves value category.
- An explicit-object member cannot be `static`, `virtual`, or cv/ref-qualified, and has no implicit `this`.
- `static` data members are one entity per class; `inline static` (C++17) allows in-class definition, and `constexpr static` is implicitly inline.
- Friendship grants access, not membership; it is neither inherited nor transitive; hidden friends are found only by ADL.
- Bit-field allocation, ordering, packing, and straddling are implementation-defined — never a portable wire format, and you cannot take a bit-field's address or bind a non-const reference.
- A union has at most one active member; reading an inactive member is UB except for the common-initial-sequence carve-out — prefer `std::variant`.
- Later-declared non-static, non-`[[no_unique_address]]` members have higher addresses, but padding may sit between and after them, so `sizeof` ≠ Σ member sizes.
- `is_trivially_copyable`, `is_standard_layout`, `is_aggregate`, and `is_trivial` are four independent properties; none of them is a serialization guarantee.
- EBO and `[[no_unique_address]]` are *permissions* to overlap storage, not size promises; verify with `static_assert(sizeof(...))` only as a deliberate ABI contract.

---

## 8.1 `class` versus `struct`

```cpp
struct Base {};

struct S {                 // members public by default
    int a;                 // public
private:
    int b_;                // explicitly private
};

class C {                  // members private by default
    int a_;                // private
public:
    explicit C(int a) : a_{a} {}
    int a() const { return a_; }
protected:
    int p_{};              // visible to derived classes
};

struct D1 : Base {};       // public inheritance   (struct default)
class  D2 : Base {};       // private inheritance  (class default)
class  D3 : public Base {}; // spell it out — always clearer

// Same class-key is not required between declaration and definition:
class  S;                  // OK to forward-declare a struct as class
struct C;                  // OK (MSVC may warn; some ABIs mangle class-key — keep consistent)

union U { int i; float f; };      // union: members public, no bases, no virtuals
```

| Property | `class` | `struct` | `union` |
|---|---|---|---|
| Default member access | `private` | `public` | `public` |
| Default base access | `private` | `public` | no bases allowed |
| Constructors / dtors / virtuals | yes | yes | ctors/dtor yes, **no** virtuals, **no** bases |
| Can be an aggregate | yes, if it meets aggregate rules | yes | yes |
| Templates, friends, operators | yes | yes | yes |

```cpp
// Aggregate-ness is about rules, not the keyword:
class Agg { public: int x; int y; };   // aggregate: no private/protected NSDMs,
Agg a{1, 2};                           // no user-declared ctors, no virtuals/virtual bases
struct NotAgg { NotAgg(); int x; };    // user-declared ctor → not an aggregate
static_assert(std::is_aggregate_v<Agg> && !std::is_aggregate_v<NotAgg>);
```

- Convention: `struct` for transparent value bundles with no invariant; `class` when an invariant is maintained behind an interface.
- The choice never changes layout, ABI, or triviality — only the two defaults above.

**Traps** — mixing class-keys across TUs can change name mangling on some ABIs · `class D : Base` silently gives *private* inheritance, killing the is-a conversion · `struct` does not mean "POD".

---

## 8.2 Data members, member functions, and access control

```cpp
class Price {
public:
    // ---- member function qualifier grid ------------------------------
    constexpr explicit Price(std::int64_t ticks) noexcept : ticks_{ticks} {}

    [[nodiscard]] constexpr std::int64_t ticks() const noexcept { return ticks_; }
    void set(std::int64_t t) noexcept { ticks_ = t; }              // non-const
    Price& bump() & noexcept { ++ticks_; return *this; }           // lvalue only
    Price  bump() && noexcept { ++ticks_; return *this; }          // rvalue only
    virtual void print() const;                                    // virtual
    void inline_defined() { /* implicitly inline */ }
    void out_of_line();                                            // defined below
    static bool is_valid(std::int64_t t) noexcept { return t > 0; } // no `this`
    friend constexpr bool operator==(Price, Price) = default;      // hidden friend

private:
    std::int64_t ticks_;                    // non-static data member (NSDM)
    mutable std::uint64_t reads_{};         // modifiable in const members
    inline static std::atomic<int> live_{0};// C++17 inline static
    static constexpr std::int64_t kMax = 1'000'000; // implicitly inline
};

inline void Price::out_of_line() { ++reads_; }   // must repeat qualifiers, not `static`/`virtual`
```

```cpp
// ---- default member initializers (NSDMI) ------------------------------
struct Limits {
    std::size_t batch{64};          // brace NSDMI
    bool tracing = false;           // equal-form NSDMI (`{}` and `=` only; no parens)
    std::vector<int> v{};           // value-init
    // std::size_t bad(3);          // ill-formed: parentheses not allowed in NSDMI

    Limits() = default;                              // batch=64, tracing=false
    explicit Limits(std::size_t n) : batch{n} {}     // tracing still false
};
```

```cpp
// ---- access specifiers -------------------------------------------------
class A {
public:    int pub;
protected: int prot;
private:   int priv;
    friend struct Helper;                 // Helper sees all three
};
struct Helper { static int read(A const& a) { return a.priv; } };

struct B : A {
    void f() {
        prot = 1;                         // OK: through own object
        A other;
        // other.prot = 1;                // ill-formed: protected access must be
                                          // through B (or a class derived from B)
    }
};

// Changing access of an inherited name:
class Impl { public: void run(); void hide(); };
class Facade : private Impl {
public:
    using Impl::run;                      // re-export as public
    // hide() stays inaccessible
};
```

| Access | Reachable from |
|---|---|
| `public` | anywhere the name is visible |
| `protected` | the class, its friends, and derived classes **through an object of the derived type** |
| `private` | the class and its friends only |

- Access is a compile-time name-usability check, not memory protection and not obfuscation.
- Overload resolution happens *first*; if the best match is inaccessible, the program is ill-formed (it does not fall back to the next candidate).
- Access does not affect layout ordering in C++23 (that restriction was dropped in C++11 for member ordering across access specifiers, standard-layout still requires all NSDMs in one access section).

```cpp
// ---- invariant-enforcing factory ---------------------------------------
class Quantity {
public:
    static std::optional<Quantity> make(std::uint64_t v) noexcept {
        if (v == 0) return std::nullopt;             // invalid state unrepresentable
        return Quantity{v};
    }
    [[nodiscard]] std::uint64_t value() const noexcept { return value_; }
private:
    explicit Quantity(std::uint64_t v) noexcept : value_{v} {}
    std::uint64_t value_;
};
```

**Interview line** — "Access control is checked after overload resolution, so making a member private removes it from your reach but not from the candidate set."

**Traps** — getters/setters over an unconstrained field buy nothing · `mutable` on a `const` member is not thread safety · `protected` data is effectively public to anyone willing to derive · NSDMI cannot use `()` initialization.

---

## 8.3 Constructors, delegating constructors, and converting constructors

```cpp
class Buffer {
public:
    Buffer() : Buffer{4096} {}                       // delegating ctor
    explicit Buffer(std::size_t cap)                 // target ctor
        : storage_(cap), cursor_{0} {}
    Buffer(std::size_t cap, std::byte fill)
        : storage_(cap, fill) {}                     // parens: n copies of fill
    Buffer(std::initializer_list<std::byte> il)
        : storage_{il} {}                            // init-list ctor wins over others
    constexpr Buffer(std::span<std::byte const> s)   // converting (implicit!) ctor
        : storage_(s.begin(), s.end()) {}
    ~Buffer() = default;

private:
    std::vector<std::byte> storage_;
    std::size_t cursor_{};
};
```

| Form | Spelling | Notes |
|---|---|---|
| Default | `T();` / `T() = default;` | implicitly declared only if no other ctor is user-declared |
| Converting | `T(U);` non-`explicit` | enables implicit conversion + copy-init + `return {…}` |
| Explicit | `explicit T(U);` | direct-init only; blocks `T t = u;`, `f(u)`, `return u;` |
| Conditional explicit | `explicit(std::is_same_v<U,int>) T(U);` | C++20 |
| Delegating | `T() : T{4096} {}` | target ctor builds bases/members; cycle is ill-formed (no diagnostic required) |
| Inheriting | `using Base::Base;` | base ctors become candidates; derived NSDMIs still apply |
| Copy / move | `T(T const&)` / `T(T&&)` | see [ch 9](/iprep/books/cpp-cheatsheet/09-copying-moving-and-ownership/) |
| `constexpr` | `constexpr T(...)` | usable at compile time when the body qualifies |
| `consteval` | `consteval T(...)` | C++20, immediate: must run at compile time |

```cpp
// ---- explicit in action --------------------------------------------------
struct Ticks { explicit Ticks(std::int64_t t) : v{t} {} std::int64_t v; };
void submit(Ticks);
Ticks a{100};          // OK — direct-list-init
Ticks b(100);          // OK — direct-init
// Ticks c = 100;      // ill-formed: copy-init needs an implicit conversion
// submit(100);        // ill-formed
submit(Ticks{100});    // OK

// explicit also matters for multi-arg since C++11:
struct P { explicit P(int, int); };
// P p = {1, 2};       // ill-formed
P p{1, 2};             // OK
```

```cpp
// ---- explicit(bool), C++20 ----------------------------------------------
template<class T>
struct Wrap {
    template<class U>
    explicit(!std::is_convertible_v<U, T>)   // implicit iff U converts implicitly
    Wrap(U&& u) : v(std::forward<U>(u)) {}
    T v;
};
```

```cpp
// ---- inheriting constructors --------------------------------------------
struct Base { Base(int); Base(int, int); protected: Base() = default; };
struct Derived : Base {
    using Base::Base;          // inherits BOTH; access is preserved
    int extra_{7};             // NSDMI still applied when an inherited ctor runs
};
Derived d{1};                  // Base(int) runs, extra_ == 7
```

```cpp
// ---- initialization order (declaration order wins) -----------------------
class BadSnapshot {
    std::size_t size_;                    // declared FIRST → initialized FIRST
    std::vector<int> values_;
public:
    explicit BadSnapshot(std::size_t n)
        : values_(n), size_(values_.size()) {}  // BUG: reads values_ before it exists
};

class GoodSnapshot {
    std::vector<int> values_;             // dependency encoded in declaration order
    std::size_t size_;
public:
    explicit GoodSnapshot(std::size_t n) : values_(n), size_(values_.size()) {}
};
```

```text
complete-object construction
  1. virtual bases        (most-derived constructor only, depth-first left-to-right)
  2. direct bases         (declaration order in the base-specifier-list)
  3. non-static members   (DECLARATION order; NSDMI used if not in the mem-init list)
  4. constructor body
```

```cpp
// ---- failure during construction ----------------------------------------
struct Loud { Loud(); ~Loud(); };
struct T {
    Loud a;            // constructed
    Loud b;            // constructed
    T() { throw 1; }   // → ~b, ~a run;  ~T() does NOT run (T's lifetime never began)
};
// A function-try-block can observe but not repair:
struct U {
    Loud a;
    U() try : a{} { } catch (...) { /* implicitly rethrows on exit */ }
};
```

```cpp
// ---- escaping `this` -----------------------------------------------------
struct Session {
    Session(Registry& r) { r.add(this); }   // DANGER: object not yet complete;
};                                          // callbacks may fire mid-construction
// Fix: two-phase — construct, then `start()` publishes.
```

- `= default` on the first declaration keeps triviality; `= default` out of line makes it *user-provided* and non-trivial.
- Any user-declared constructor suppresses the implicit default constructor.
- Aggregate initialization bypasses constructors entirely and applies NSDMIs for omitted members.

**Traps** — `-Wreorder` is a real bug detector, not style noise · single-argument constructors default to converting unless marked `explicit` · delegating cycle = UB · `vector<int> v(5, 7)` vs `v{5, 7}` also bites in mem-init lists · calling a virtual from a constructor gets the *current* class's version.

---

## 8.4 Destructors and destruction order

```cpp
class FileBuffer {
public:
    ~FileBuffer() noexcept = default;      // implicitly noexcept anyway
private:
    std::vector<std::byte> bytes_;
};

struct Poly {
    virtual ~Poly() = default;             // REQUIRED for `delete` through Poly*
};
struct Abstract {
    virtual ~Abstract() = 0;               // pure virtual dtor still needs a body:
};
Abstract::~Abstract() = default;

struct Protected {                         // alternative to a virtual dtor:
protected:
    ~Protected() = default;                // non-polymorphic delete is blocked
};
```

- A destructor takes no parameters, has no return type, cannot be `const`/`volatile`/ref-qualified, and cannot be overloaded.
- It runs on scope exit, `delete`, container/owner destruction, exception unwinding, or an explicit `p->~T()`.
- Exactly one destructor per class; it is `virtual` iff declared so or inherited virtual.

```text
most-derived object destruction
  1. destructor body
  2. non-static members  — REVERSE declaration order
  3. direct bases        — REVERSE construction order
  4. virtual bases       — last, reverse construction order
```

| Context | Order |
|---|---|
| Locals in a block | reverse order of *completed* construction |
| Array elements | reverse subscript order |
| Temporaries | end of full-expression, reverse creation order |
| Static/thread-local | reverse order of completed dynamic init (`atexit` semantics) |
| Members / bases | reverse declaration / construction order |

```cpp
// ---- explicit lifetime management ---------------------------------------
alignas(Order) std::byte raw[sizeof(Order)];
Order* p = std::construct_at(reinterpret_cast<Order*>(raw), id, qty); // C++20
std::destroy_at(p);                                                   // C++17
// p->~Order();                       // equivalent spelling
new (raw) Order{id, qty};             // placement new, <new>
std::destroy(first, last);            // range form
std::destroy_n(first, n);
```

```cpp
// ---- exceptions and destructors ------------------------------------------
struct Bad { ~Bad() { throw 1; } };    // implicit noexcept → std::terminate
struct Explicit { ~Explicit() noexcept(false) { throw 1; } }; // legal but hostile
// Correct pattern: destructor swallows, and a separate fallible close() reports.
class Writer {
public:
    void close();                     // may throw — caller's choice
    ~Writer() noexcept { try { close(); } catch (...) {} }
};
// std::uncaught_exceptions()  (C++17, <exception>) — nonzero during unwinding
```

```cpp
// ---- virtual dispatch during construction/destruction --------------------
struct B2 { B2() { hook(); } virtual ~B2() { hook(); } virtual void hook(); };
struct D2 : B2 { void hook() override; };  // NEVER called from B2's ctor/dtor
```

| Situation | Consequence |
|---|---|
| `delete base_ptr` with non-virtual dtor | UB (typically leaks the derived part) |
| Dtor throws while unwinding | `std::terminate` |
| Dtor of an object whose ctor threw | never runs (subobjects do) |
| Skipping a destructor (`std::exit`, `longjmp`, `abort`) | no unwinding, no cleanup |
| Double `~T()` on the same object | UB |

**Traps** — polymorphic base without `virtual ~` · `= default` out-of-line breaks triviality and can hurt `memcpy`-based optimizations · `std::exit` runs statics' destructors but not locals' · `noexcept(false)` destructors poison every container that holds the type.

---

## 8.5 The implicit object parameter, cv/ref-qualified members, and explicit object parameters ("deducing `this`")

```cpp
class Book {
public:
    Top&       top() &       noexcept { return top_; }             // lvalue object
    Top const& top() const&  noexcept { return top_; }             // const lvalue
    Top        top() &&      noexcept { return std::move(top_); }  // rvalue: steal
    Top        top() const&& noexcept { return top_; }             // rare, completes the set
private:
    Top top_;
};

Book b;
b.top();                 // → Top&
std::as_const(b).top();  // → Top const&
Book{}.top();            // → Top   (moved out)
```

| Qualifier on member | Callable when the object expression is | `this` type in `T` |
|---|---|---|
| none | lvalue **or** rvalue | `T*` |
| `&` | lvalue only | `T*` |
| `&&` | rvalue only | `T*` |
| `const` | const or non-const, either category | `T const*` |
| `const&` | any lvalue, and rvalues too | `T const*` |
| `volatile` | volatile-qualified objects | `T volatile*` |
| `static` | n/a — no object parameter | none |

- You may not mix a ref-qualified and a non-ref-qualified overload of the same signature — it is ill-formed.
- Inside an `&&`-qualified member, `*this` is still an **lvalue**; you must write `std::move(member)` yourself.
- `this` is a prvalue pointer; you cannot assign to it. `*this` has the member's cv-qualification.

```cpp
// ---- mutable and logical constness ---------------------------------------
class Stats {
public:
    std::uint64_t samples() const noexcept { ++reads_; return samples_; } // OK
private:
    std::uint64_t samples_{};
    mutable std::uint64_t reads_{};        // exempt from const
    mutable std::mutex m_;                 // canonical legitimate use
};
// `mutable` cannot apply to references, `const` members, or static members.
```

```cpp
// ---- C++23 explicit object parameter --------------------------------------
struct Wrapper {
    int value{};

    template<class Self>
    constexpr auto&& get(this Self&& self) noexcept {   // one member, four overloads
        return std::forward<Self>(self).value;          // preserves cv + value category
    }

    template<class Self>
    constexpr decltype(auto) get2(this Self&& self) noexcept {
        return std::forward_like<Self>(self.value);     // C++23, <utility>
    }

    void plain(this Wrapper& self) { self.value = 1; }  // non-template form, explicit type
    void byval(this Wrapper self)  { self.value = 1; }  // BY VALUE — operates on a copy
};

Wrapper w;
w.get();                       // Self = Wrapper&        → int&
std::as_const(w).get();        // Self = Wrapper const&  → int const&
Wrapper{}.get();               // Self = Wrapper         → int&&
auto fp = &Wrapper::plain;     // void(*)(Wrapper&)  — ORDINARY function pointer
fp(w);                                                  // called like a free function
```

Rules for an explicit object member:
- must be the **first** parameter, spelled `this T self`, and only on a non-static member function or lambda;
- cannot be `static`, `virtual`, or carry trailing cv/ref qualifiers (`const`, `&`, `&&`);
- has **no** implicit `this` — naming a member without `self.` is ill-formed;
- its type is an ordinary function type, so `&C::f` yields `R(*)(Args...)`, not a pointer-to-member;
- an explicit-object and an implicit-object overload with otherwise identical parameters cannot coexist;
- pass-by-value (`this Self self`) silently copies — usually a bug on non-trivial types.

```cpp
// ---- recursive lambdas (the other headline use) ---------------------------
auto fib = [](this auto&& self, int n) -> int {         // C++23
    return n < 2 ? n : self(n - 1) + self(n - 2);
};

// ---- CRTP without CRTP ----------------------------------------------------
struct Comparable {
    bool operator<(this auto const& self, auto const& rhs) { return self.key() < rhs.key(); }
};
```

```cpp
#if __cpp_explicit_this_parameter >= 202110L   // feature test
#endif
#if __cpp_lib_forward_like >= 202207L
#endif
```

**Interview line** — "Deducing `this` turns a four-way cv/ref overload set into one template whose deduced `Self` carries the object's constness and value category."

**Traps** — `&&`-qualified member still sees `*this` as an lvalue · `this Self self` by value is a hidden copy · explicit-object members cannot be virtual, so they don't replace polymorphism · taking the address gives a plain function pointer, which breaks generic `std::invoke`-on-member assumptions in the other direction (it actually still works, but pointer-to-member traits do not match).

---

## 8.6 `static` data and function members; inline variables

```cpp
class Decoder {
public:
    // ---- static data members, every spelling -------------------------------
    static constexpr std::size_t header_size = 8;      // implicitly inline (C++17)
    inline static std::atomic<std::uint64_t> errors{0};// C++17 inline static, defined here
    static const int legacy_const = 3;                 // in-class init OK for integral const
    static int counter;                                // DECLARATION only
    static std::string name;                           // needs out-of-line definition
    static thread_local std::uint64_t tls_hits;        // one per thread

    // ---- static member functions -------------------------------------------
    static bool valid_length(std::size_t n) noexcept { return n >= header_size; }
    // static void f() const;      // ill-formed: no object → no cv-qualifier
    // static virtual void g();    // ill-formed
};

int Decoder::counter = 0;                    // exactly one TU
std::string Decoder::name{"decoder"};        // exactly one TU
thread_local std::uint64_t Decoder::tls_hits = 0;
const int Decoder::legacy_const;             // needed pre-C++17 if odr-used
```

| Form | Definition site | Since | Notes |
|---|---|---|---|
| `static constexpr T x = v;` | in class | C++17 implicit inline | address-taking is fine, no TU definition needed |
| `inline static T x{v};` | in class | C++17 | one entity across all TUs, linker merges |
| `static const Integral x = v;` | value in class, definition out of line if odr-used | C++98 | integral/enum only |
| `static T x;` | out of line in one TU | C++98 | classic; ODR violation if defined twice |
| `static thread_local T x;` | out of line | C++11 | per-thread storage, lazy init cost |
| `static inline` function | anywhere | — | `static` member functions are implicitly external unless `inline` |

```cpp
// ---- static member functions have no `this` -------------------------------
struct S {
    int v_;
    static int f() { /* return v_; */ return 0; }   // ill-formed to touch v_
    static int g(S const& s) { return s.v_; }       // fine: explicit object argument
};
auto pf = &S::f;                 // int(*)()          — plain function pointer
auto pm = &S::g;                 // int(*)(S const&)  — still plain
```

```cpp
// ---- initialization order ---------------------------------------------------
// Non-local statics across TUs have UNSPECIFIED relative init order (SIOF).
// Fix with a function-local static (thread-safe "magic static", C++11):
inline Registry& registry() { static Registry r; return r; }   // init on first call
// constinit forces constant initialization at compile time (C++20):
constinit static std::atomic<int> ready{0};   // guaranteed no dynamic init, no SIOF
// constexpr static data members are constant-initialized by construction.
```

```cpp
// ---- hot-path caution -------------------------------------------------------
struct Counters {
    inline static std::atomic<std::uint64_t> messages{0};  // CONTENDED cache line
};
// Prefer per-thread accumulation, published periodically:
struct alignas(64) PerThread { std::uint64_t messages{}; };  // avoid false sharing
inline thread_local PerThread local_counters{};
```

- A static member obeys access control like any other member (`private static` exists).
- `sizeof(Class)` never includes static data members.
- `static` members of a class template are instantiated once per specialization.
- Function-local statics are initialized exactly once, thread-safely, with a guard variable check on every entry (`-fno-threadsafe-statics` removes it, unsafely).

**Traps** — static initialization order fiasco across TUs · a global atomic counter in the message path serializes cores · `thread_local` access can involve a TLS-model-dependent function call · `inline static` in a header is one object, not one per TU.

---

## 8.7 Nested types, friends, and local classes

```cpp
class Pool {
public:
    // ---- nested class -----------------------------------------------------
    class Handle {
    public:
        std::uint32_t index{};
        std::uint32_t generation{};
        friend constexpr auto operator<=>(Handle, Handle) = default;
    };
    struct Stats;                       // nested forward declaration
    using size_type = std::uint32_t;    // nested typedef
    enum class State : std::uint8_t { Free, Live };   // nested scoped enum

    friend bool valid(Pool const&, Handle) noexcept;  // friend declaration
    friend class Inspector;                            // whole class is a friend
    template<class T> friend struct Adapter;           // template friend
private:
    std::vector<State> slots_;
};

struct Pool::Stats { std::uint32_t live{}; };          // out-of-class definition
bool valid(Pool const& p, Pool::Handle h) noexcept {   // friend: sees slots_
    return h.index < p.slots_.size();
}
```

- A nested class is a member for **name lookup and access**, but its objects hold no pointer to an enclosing object.
- A nested class may access the enclosing class's private members (C++11 onward); the reverse requires friendship.
- Out-of-class definitions of nested members need the full qualification (`Pool::Stats`) and access to it.

```cpp
// ---- hidden friends: the ADL-only idiom -----------------------------------
struct Price {
    std::int64_t ticks{};
    friend constexpr bool operator==(Price, Price) = default;      // C++20
    friend constexpr auto operator<=>(Price, Price) = default;
    friend Price operator+(Price a, Price b) { return {a.ticks + b.ticks}; }
    friend std::ostream& operator<<(std::ostream& os, Price p) { return os << p.ticks; }
    friend void swap(Price& a, Price& b) noexcept { std::swap(a.ticks, b.ticks); }
};
// These names are NOT found by ordinary unqualified lookup or `Price::operator+`;
// only ADL finds them → smaller overload sets, faster compiles, no accidental matches.
```

| Friendship property | Holds? |
|---|---|
| Grants access to `private` and `protected` | yes |
| Makes the friend a member | no |
| Inherited by derived classes | no |
| Transitive ("friend of my friend") | no |
| Reciprocal | no |
| Affected by the friend declaration's access specifier | no (position is irrelevant) |
| Can define the function inline in the class | yes → hidden friend |

```cpp
// ---- local class -----------------------------------------------------------
void run() {
    struct Comparator {                      // local class, block scope
        bool operator()(int a, int b) const { return a > b; }
        // static int s;                     // ill-formed: no static data members
        // template<class T> void f();       // ill-formed: no member templates
    };
    std::sort(v.begin(), v.end(), Comparator{});   // usable as a template arg (C++11+)
    auto lambda = [](int a, int b) { return a > b; };  // idiomatic replacement
}
```

- A local class has no linkage; it can use enclosing automatic variables only if they are `constexpr`/not odr-used.
- Lambdas are unnamed local classes with an `operator()`, so they supersede nearly every local-class use.

**Traps** — `friend class X;` in an unrelated namespace declares a *new* class in the nearest enclosing namespace unless already declared · friendship is the widest access grant in C++ — prefer a narrow function friend over `friend class` · a nested class does not get an implicit outer `this`.

---

## 8.8 Bit-fields and why they are poor wire formats

```cpp
struct Flags {
    unsigned side     : 1;      // width must be a constant expression <= bits of type
    unsigned type     : 3;
    unsigned          : 0;      // UNNAMED zero-width: force next field to a new unit
    unsigned reserved : 4;
    unsigned          : 2;      // unnamed padding bits
    // unsigned bad    : 0;     // ill-formed: named zero-width
    std::uint8_t small : 4;     // any integral / enum type is allowed (C++14+)
    bool flag : 1;              // bool bit-field: values are true/false
};

struct Sign {
    int  s : 3;                 // signed: range [-4, 3]
    unsigned u : 3;             // unsigned: range [0, 7]
    // plain `int x : 3;` IS signed; plain `char c : 3;` signedness is impl-defined
};
```

```cpp
Flags f{};
// int* p = &f.side;            // ill-formed: no address of a bit-field
// int& r = f.side;             // ill-formed: no non-const reference
int const& cr = f.side;         // OK — binds to a temporary copy, not the field
auto  copy   = f.side;          // C++14+: deduces the underlying type (unsigned)
decltype(f.side) d = 0;         // the declared type, `unsigned`
f.type = 9;                     // TRUNCATED to 3 bits (1) — implementation-defined
                                // for signed overflow; no warning by default
sizeof(Flags);                  // NOT the sum of widths
// offsetof(Flags, side);       // ill-formed: bit-fields have no offset
```

| Aspect | Status |
|---|---|
| Allocation order within a unit (LSB→MSB or MSB→LSB) | implementation-defined |
| Whether a field may straddle an allocation unit | implementation-defined |
| Size/alignment of the allocation unit | implementation-defined |
| Whether a bit-field of type `T` uses `sizeof(T)` units | implementation-defined |
| Signedness of plain `char`/`int` bit-fields | `int` is signed; `char` is impl-defined |
| Width 0 (unnamed) | forces alignment to next allocation unit |
| Address / reference / `offsetof` / `alignof` | ill-formed |
| Adjacent non-zero-width fields | share a memory location → **data race** if written concurrently |
| Zero-width field between them | separates memory locations → concurrent writes are safe |
| Read/write codegen | typically load–mask–shift–or–store (read-modify-write) |
| Atomic operations | impossible — no addressable object |

```cpp
// ---- the correct way to parse a wire byte ---------------------------------
constexpr unsigned side(std::uint8_t b) noexcept { return  b        & 0x01u; }
constexpr unsigned type(std::uint8_t b) noexcept { return (b >> 1)  & 0x07u; }
constexpr std::uint8_t pack(unsigned s, unsigned t) noexcept {
    return static_cast<std::uint8_t>((s & 0x01u) | ((t & 0x07u) << 1));
}

// ---- multi-byte fields: explicit endian handling ---------------------------
std::uint32_t load_be(std::byte const* p) noexcept {
    std::uint32_t n;
    std::memcpy(&n, p, 4);                       // no alignment/aliasing UB
    if constexpr (std::endian::native == std::endian::little) // C++20 <bit>
        n = std::byteswap(n);                    // C++23 <bit>
    return n;
}
```

```cpp
// ---- when bit-fields ARE fine: internal, single-TU, non-shared state -------
struct OrderMeta {
    std::uint32_t venue : 6;
    std::uint32_t side  : 1;
    std::uint32_t tif   : 3;
    std::uint32_t seq   : 22;      // one 32-bit word, cache-dense, never serialized
};
static_assert(sizeof(OrderMeta) == 4);   // deliberate ABI assertion, not a portable claim
```

**Interview line** — "Bit-field layout is implementation-defined in ordering, straddling, and unit size, so it describes your compiler's memory, never the protocol's bits."

**Traps** — no `&`, no `T&`, no `offsetof`, no atomics · silent truncation on over-wide assignment · adjacent fields race · `-fpack-struct`/`#pragma pack` changes everything · `std::bit_cast` a bit-field struct and you export your ABI.

---

## 8.9 Unions, anonymous unions, and active-member lifetime

```cpp
struct Add    { std::uint64_t id; std::int64_t px; };   // trivial
struct Cancel { std::uint64_t id; std::string reason; };// non-trivial

union Payload {
    Add    add;
    Cancel cancel;

    Payload() {}          // no member active; required because Cancel has a ctor
    ~Payload() {}         // required; owner must destroy the active member
    // Copy/move are IMPLICITLY DELETED when any member is non-trivially copyable.
};
```

- A union's members all start at the same address; `sizeof` ≥ largest member, `alignof` = strictest member.
- At most one member is **active** at a time; reading any other is UB (with the CIS carve-out below).
- If any variant member has a non-trivial special member, the union's corresponding special member is implicitly **deleted** and must be user-provided.
- A union cannot have base classes, be a base class, have virtual functions, or have reference members.

```cpp
// ---- switching the active member ------------------------------------------
Payload p;                                          // no active member
std::construct_at(&p.add, Add{1, 100});             // add is now active
// use p.add
std::destroy_at(&p.add);                            // add no longer active
std::construct_at(&p.cancel, Cancel{1, "stale"});   // cancel is active
std::destroy_at(&p.cancel);

// For TRIVIAL members, plain assignment through the member access starts its
// lifetime implicitly (the member must be trivially default-constructible):
union Simple { int i; float f; };
Simple s;
s.i = 1;        // i active
s.f = 2.0f;     // f active — legal because both are trivial
// int x = s.i; // UB: i is not the active member (this is the classic punning bug)
```

```cpp
// ---- the correct type-pun tools --------------------------------------------
float f = 1.0f;
std::uint32_t bits = std::bit_cast<std::uint32_t>(f);   // C++20 <bit>, constexpr
std::memcpy(&bits, &f, sizeof bits);                    // always valid
// bits = *reinterpret_cast<std::uint32_t*>(&f);        // strict-aliasing UB
```

```cpp
// ---- a correct tagged union (what variant does for you) --------------------
class Message {
    enum class Tag : std::uint8_t { None, Add, Cancel } tag_{Tag::None};
    union { Add add_; Cancel cancel_; };            // ANONYMOUS union member
public:
    Message() noexcept {}
    Message(Message const& o) : tag_{o.tag_} {
        switch (tag_) {
        case Tag::Add:    std::construct_at(&add_, o.add_); break;
        case Tag::Cancel: std::construct_at(&cancel_, o.cancel_); break;
        case Tag::None:   break;
        }
    }
    Message& operator=(Message const&);             // destroy-then-construct, self-safe
    ~Message() { reset(); }
    void reset() noexcept {
        if (tag_ == Tag::Cancel) std::destroy_at(&cancel_);
        else if (tag_ == Tag::Add) std::destroy_at(&add_);
        tag_ = Tag::None;
    }
};
```

```cpp
// ---- anonymous union: injects names into the enclosing scope ---------------
struct Holder {
    int kind;
    union { int i; double d; };     // NO name, NO member functions, NO private members,
};                                  // members are named as Holder::i / Holder::d
Holder h; h.kind = 0; h.i = 5;
// A namespace-scope anonymous union must be `static`.
```

```cpp
// ---- common initial sequence (the ONE portable read carve-out) -------------
struct A2 { int tag; int x; };
struct B2 { int tag; double y; };       // both standard-layout
union CIS { A2 a; B2 b; };
CIS c; c.a = {7, 1};
int t = c.b.tag;                        // OK: `tag` is in the common initial sequence
// double y = c.b.y;                    // UB: beyond the CIS
```

- The CIS rule requires both members to be **standard-layout structs** and only covers the leading run of layout-compatible members.
- It is not a licence to read past the shared prefix, and it does not extend to non-standard-layout types.

| Alternative | When |
|---|---|
| `std::variant<Add, Cancel>` | default — tag + lifetime + copy/move handled, `std::visit`, `valueless_by_exception` |
| `std::optional<T>` | one-or-nothing |
| `std::bit_cast` / `memcpy` | reinterpreting bytes of a trivially copyable type |
| Raw union + manual tag | only when `variant`'s size/dispatch is measured to be too costly |

**Traps** — reading an inactive member is UB even when the bytes "look right" · non-trivial members delete the union's copy/move/dtor · anonymous unions supply no tag · `variant` still costs a tag byte plus alignment padding · `std::visit` on a valueless variant throws `std::bad_variant_access`.

---

## 8.10 Layout, empty-base optimization, and `[[no_unique_address]]`

```cpp
struct Event {
    std::uint64_t sequence;   // offset 0
    std::uint8_t  type;       // offset 8   + 3 bytes padding
    std::uint32_t quantity;   // offset 12
};                            // sizeof == 16, alignof == 8

struct Packed {               // reorder largest-first to shrink padding
    std::uint64_t sequence;   // 0
    std::uint32_t quantity;   // 8
    std::uint8_t  type;       // 12  + 3 tail padding
};                            // sizeof == 16 too — tail padding to alignof(8)

static_assert(offsetof(Event, quantity) == 12);   // standard-layout only
static_assert(alignof(Event) == 8);
static_assert(sizeof(Event) == 16);
```

- Later-declared non-static, non-zero-sized, non-`[[no_unique_address]]` members have **higher addresses**; padding may appear between and after them.
- Alignment is the driver: each member sits at a multiple of its alignment, and `sizeof` rounds up to `alignof`.
- Declaration order is yours to choose — large-to-small usually minimizes padding.

| Trait | What it buys | What it does **not** imply |
|---|---|---|
| `std::is_trivially_copyable_v` | `memcpy`/`bit_cast` between live objects of the type | no padding, stable ABI, wire format |
| `std::is_standard_layout_v` | `offsetof`, C interop, CIS reads, address of first member == address of object | triviality of construction/destruction |
| `std::is_aggregate_v` | brace/designated init, no user ctor | standard layout or triviality |
| `std::is_trivial_v` | trivial default ctor **and** trivially copyable | packed representation |
| `std::has_unique_object_representations_v` | byte-comparison == value-comparison (no padding, no traps) | portability across ABIs |

```cpp
static_assert(std::is_trivially_copyable_v<Event>);
static_assert(std::is_standard_layout_v<Event>);
static_assert(!std::has_unique_object_representations_v<Event>);  // it has padding
static_assert(std::has_unique_object_representations_v<Packed> == false);
```

Standard-layout requires: no virtual functions or virtual bases; all NSDMs in **one** access section; no NSDMs in more than one class of the hierarchy; no base of the same type as the first member; all bases and members standard-layout.

```cpp
// ---- alignment control -----------------------------------------------------
struct alignas(64) CacheLine { std::atomic<std::uint64_t> v{}; };  // avoid false sharing
static_assert(alignof(CacheLine) == 64 && sizeof(CacheLine) == 64);
constexpr auto ds = std::hardware_destructive_interference_size;   // C++17, <new>
constexpr auto cs = std::hardware_constructive_interference_size;
// alignas can only INCREASE alignment (over-align); `alignas(1)` on an int is ill-formed.
```

```cpp
// ---- empty base optimization (EBO) -----------------------------------------
struct NoTrace { void operator()(int) const noexcept {} };   // stateless policy
static_assert(sizeof(NoTrace) == 1);   // complete objects need distinct addresses

template<class Policy>
class Engine : private Policy {        // classic EBO: base may take ZERO bytes
    std::uint64_t sequence_{};
};
static_assert(sizeof(Engine<NoTrace>) == 8);   // policy vanished

struct TwoSame : NoTrace {             // a base and a member of the same empty type
    NoTrace m;                         // must have DISTINCT addresses
};
static_assert(sizeof(TwoSame) == 1 || sizeof(TwoSame) == 2);  // ABI-dependent
```

```cpp
// ---- C++20 [[no_unique_address]] --------------------------------------------
template<class Policy>
class Engine2 {
    [[no_unique_address]] Policy policy_;   // may overlap other subobjects / tail padding
    std::uint64_t sequence_{};
};
static_assert(sizeof(Engine2<NoTrace>) == 8);        // typical, NOT guaranteed
static_assert(sizeof(Engine2<std::uint32_t>) == 16); // non-empty: no saving

struct Two {
    [[no_unique_address]] NoTrace a;
    [[no_unique_address]] NoTrace b;   // SAME type → must still differ in address
};                                     // sizeof(Two) >= 2 in practice

// Real-world use: allocators, comparators, deleters, and hashers in containers.
template<class T, class Deleter = std::default_delete<T>>
class Owner {
    T* p_{};
    [[no_unique_address]] Deleter d_{};   // stateless deleter costs nothing
};
```

| Mechanism | Since | Guarantee level |
|---|---|---|
| EBO via private base | C++98 | required for standard-layout cases; otherwise widely implemented |
| `[[no_unique_address]]` | C++20 | *permission* to overlap; no size guarantee, MSVC needs `[[msvc::no_unique_address]]` |
| `sizeof(Empty) >= 1` | always | distinct complete objects need distinct addresses |
| Two same-type potentially-overlapping subobjects | always | must have distinct addresses |

```cpp
// ---- hot-path design: hot/cold split, index handles -------------------------
struct HotOrder {                      // 24 bytes, trivially copyable, cache-dense
    std::uint64_t id;
    std::int64_t  price;
    std::uint32_t quantity;
    std::uint32_t next;                // INDEX, not pointer — survives relocation
};
static_assert(sizeof(HotOrder) == 24 && std::is_trivially_copyable_v<HotOrder>);

struct ColdOrderDiagnostics {          // never touched in the match loop
    std::string source_text;
    std::chrono::system_clock::time_point created;
};
std::vector<HotOrder> hot;             // scanned
std::vector<ColdOrderDiagnostics> cold;// parallel, index-aligned
```

**Class-design checklist**
1. Which states are valid, and can an invalid one be constructed at all?
2. Does declaration order encode construction/destruction dependencies?
3. Whose lifetime backs every reference, `span`, and `string_view` member?
4. Is each `const` member actually safe under concurrent readers?
5. Do you need standard layout / trivial copyability, or just value semantics?
6. Could this union be a `variant`?
7. Are bit operations explicit masks rather than compiler-chosen bit-field layout?
8. Is empty-policy compression verified with `static_assert(sizeof(...))` on the target?
9. Does the object size help or hurt cache density on the real access pattern?

**Interview line** — "`[[no_unique_address]]` is permission for a subobject to occupy no unique bytes; it is not a promise about `sizeof`, so assert the size you depend on."

**Traps** — `sizeof` as a protocol size · reordering members changes ABI · `offsetof` on non-standard-layout types is conditionally supported · MSVC ignores plain `[[no_unique_address]]` for ABI compatibility · over-aligned types need `operator new` alignment support (C++17 aligned new) · tail-padding reuse means `memcpy(&derived_as_base, ...)` can clobber derived members.
