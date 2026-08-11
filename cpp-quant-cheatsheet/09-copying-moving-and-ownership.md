# 9. Copying, moving, and ownership

*Part II — Classes, resource management, and generic programming*

---

**Recall**
- A "move" is not a language operation — it is overload resolution picking an rvalue-taking constructor/assignment; what transfers is entirely up to that function's body.
- `std::move` moves nothing: it is an unconditional `static_cast` to `T&&` (xvalue); `std::forward<T>` is a *conditional* cast driven by the deduced `T`.
- Moving from a `const` object silently copies — `const T&&` cannot bind to `T&&`, so `T(const T&)` wins.
- Implicit move operations are declared **only** if the class declares no copy ctor, no copy assign, no move ctor, no move assign, and no destructor.
- Declaring any move operation defines the implicitly declared copy operations as **deleted**; declaring a copy operation suppresses implicit moves.
- `is_move_constructible_v<T>` is true whenever an rvalue can initialize a `T` — a `const T&` copy constructor satisfies it, so the trait never proves a real move ctor exists.
- Rule of Zero: put ownership in members (`vector`, `string`, `unique_ptr`) and declare none of the six; Rule of Five: if you manage a raw resource, reason about all five.
- `= default` **on the first declaration** keeps the member non-user-provided and possibly trivial; defaulting later makes it user-provided and non-trivial.
- Moved-from standard-library objects are **valid but unspecified**: destroy them, assign to them, call operations with no preconditions — never assume empty/null/zero.
- Move cost follows representation: a pointer-owning container moves in O(1), `std::array<T,N>` moves N elements, an SSO `std::string` copies its inline bytes.
- Self-move (`x = std::move(x)`) must leave `x` valid; the naive "release then steal" ordering frees the very resource it then adopts.
- A forwarding reference is `T&&` with `T` a *deduced, cv-unqualified* template parameter (or `auto&&`) — `T&&` on a class template parameter is an ordinary rvalue reference.
- Reference collapsing: only `&& + &&` yields `&&`; every other combination yields `&`.
- A named parameter of type `T&&` is an **lvalue** expression — that is exactly why `std::forward` exists.
- Forward each parameter **once**: the second forward may consume an already-pillaged value.
- `std::forward_like<Model>(x)` (C++23) applies `Model`'s cv-qualification and value category to `x`, the natural partner of deducing-`this` accessors.
- Copy-and-swap gives self-assignment safety plus the strong guarantee, at the price of a full temporary and delayed release.
- `vector` reallocation uses `std::move_if_noexcept`: a non-`noexcept` move on a copyable type forces copies to keep the strong guarantee.
- A `noexcept` that is violated at runtime calls `std::terminate` — spell conditional `noexcept` or use `= default` rather than lying.
- Ownership is a *convention* for raw pointers and a *type* for `unique_ptr`/`shared_ptr`/values; state it at every interface.

---

## 9.1 Copy/move constructors and copy/move assignment

```cpp
struct X {
    X();                          // default constructor
    X(X const&);                  // copy constructor      (canonical form)
    X(X&);                        // ALSO a copy ctor — but rejects const/temporaries
    X(X const&, int = 0);         // still a copy ctor: extra params all defaulted
    X(X&&) noexcept;              // move constructor
    X& operator=(X const&);       // copy assignment
    X& operator=(X&&) noexcept;   // move assignment
    ~X();                         // destructor
};
// NOT special members: X(X) is ill-formed; template<class T> X(T&&) is never
// a copy/move ctor (a template never suppresses implicit generation).
```

```cpp
Buffer a{1024};
Buffer b = a;                 // copy CONSTRUCTION (not assignment) — b is new
Buffer c = std::move(a);      // move construction
Buffer d(a);                  // direct-init copy construction
Buffer e{std::move(c)};       // braced move construction
b = c;                        // copy ASSIGNMENT — b already alive, must release
c = std::move(b);             // move assignment
Buffer f = Buffer{4};         // no copy/move at all: guaranteed elision (C++17)
```

```cpp
// Construction vs assignment: the asymmetry that drives every bug.
//   construction: no prior state         → only acquire
//   assignment:   prior state is live    → release old, then acquire, and
//                                          survive self-assignment + exceptions
```

```cpp
// Canonical minimal owner (see 9.3 for the full Rule of Five).
class Str {
public:
    Str() noexcept = default;
    explicit Str(char const* s) : p_{::strdup(s)} {}
    ~Str() { std::free(p_); }
    Str(Str const& o) : p_{o.p_ ? ::strdup(o.p_) : nullptr} {}   // deep copy
    Str(Str&& o) noexcept : p_{std::exchange(o.p_, nullptr)} {}  // steal
    Str& operator=(Str o) noexcept { swap(o); return *this; }    // copy-and-swap
    void swap(Str& o) noexcept { std::swap(p_, o.p_); }
    friend void swap(Str& a, Str& b) noexcept { a.swap(b); }
private:
    char* p_{};
};
```

| Form | Selected for | Returns |
|---|---|---|
| `X(X const&)` | lvalues, const lvalues, rvalues (fallback) | new object |
| `X(X&&)` | non-const rvalues (prvalue/xvalue) only | new object |
| `X& operator=(X const&)` | lvalue RHS | `*this` by reference |
| `X& operator=(X&&)` | rvalue RHS | `*this` by reference |
| `X& operator=(X)` | both (unified copy-and-swap) | `*this` by reference |

**Interview line** — "Copy/move *construction* begins a lifetime; copy/move *assignment* overwrites a live object, so it must also release, tolerate self-assignment, and stay valid if it throws."

**Traps** — `X(X&)` blocks copying temporaries and const objects · returning `void` or `X` from `operator=` breaks chaining conventions · a perfect-forwarding constructor `template<class T> X(T&&)` hijacks `X(X&)` overload resolution (constrain it with `requires (!std::same_as<std::remove_cvref_t<T>, X>)`) · `Buffer b = a;` is *construction*, never assignment.

---

## 9.2 Special member generation, deletion, and suppression rules

```cpp
// The trigger is USER-DECLARED, not user-provided:
// `X(X const&) = default;` and `X(X const&) = delete;` both count as declared.
```

| Member | Implicitly declared iff |
|---|---|
| Default constructor | no user-declared constructor of any kind |
| Destructor | no user-declared prospective destructor |
| Copy constructor | no user-declared copy ctor (deprecated if move-ops or dtor/copy-assign declared) |
| Copy assignment | no user-declared copy assignment (same deprecation) |
| Move constructor | **no** user-declared copy ctor, copy assign, move ctor, move assign, **or destructor** |
| Move assignment | same five-way condition as move constructor |

| You declare | Default ctor | Copy ops | Move ops |
|---|---|---|---|
| nothing | ✔ | ✔ | ✔ |
| any constructor | ✘ | ✔ | ✔ |
| destructor | ✔ | ✔ (deprecated) | **✘ suppressed** |
| copy ctor **or** copy assign | ✘ (if ctor) | other copy op ✔ (deprecated) | **✘ suppressed** |
| move ctor **or** move assign | ✘ | **deleted** | other move op **not** declared |

```cpp
struct DtorOnly {
    ~DtorOnly() {}                 // suppresses BOTH implicit move operations
};                                 // implicit copy ops still exist (deprecated)
static_assert(std::is_move_constructible_v<DtorOnly>);   // TRUE — via copy ctor!
static_assert(std::is_copy_constructible_v<DtorOnly>);
// Trait truth ≠ "a move constructor exists". Verify with a counting type or
// by checking that a move-only member would break: see the probe below.
```

```cpp
struct MoveOnly { std::unique_ptr<int> p; };            // Rule of Zero
static_assert(!std::is_copy_constructible_v<MoveOnly>); // copy deleted through member
static_assert( std::is_move_constructible_v<MoveOnly>);

struct HasMove { HasMove(HasMove&&) noexcept; };        // declaring a move…
static_assert(!std::is_copy_constructible_v<HasMove>);  // …DELETES implicit copy
static_assert(!std::is_move_assignable_v<HasMove>);     // …and doesn't declare the other
```

```cpp
// Implicitly declared members are DEFINED AS DELETED when a base/member's
// corresponding operation is deleted, inaccessible, ambiguous, or absent:
struct Bad {
    std::mutex m;                 // non-copyable, non-movable → Bad has neither
    int const  k;                 // const member → copy/move ASSIGNMENT deleted
    int&       r;                 // reference member → assignment deleted too
};
```

```cpp
// ---- = default / = delete spellings ---------------------------------------
struct Handle {
    Handle() = default;                              // trivial, non-user-provided
    Handle(Handle const&)            = delete;       // "no copying"
    Handle& operator=(Handle const&) = delete;
    Handle(Handle&&) noexcept            = default;  // defaulted in-class
    Handle& operator=(Handle&&) noexcept = default;
    ~Handle() = default;
};

struct Late { Late(Late const&); };
Late::Late(Late const&) = default;   // defaulted OUT of line → USER-PROVIDED:
                                     // no longer trivial; affects triviality
                                     // traits, constexpr-ness and value-init.
```

```cpp
// = delete is not restricted to special members; use it to poison overloads.
void take(long);
void take(int) = delete;                       // reject exact int calls
void take(std::nullptr_t) = delete;
struct NoHeap { static void* operator new(std::size_t) = delete; };
void f(auto&&) = delete("use f(Order const&)"); // C++26 reason string (tag: future)
```

| Trait (`<type_traits>`) | True when |
|---|---|
| `is_copy_constructible_v<T>` | `T t(declval<T const&>())` is valid |
| `is_move_constructible_v<T>` | `T t(declval<T&&>())` is valid — copy ctor qualifies |
| `is_copy_assignable_v<T>` / `is_move_assignable_v<T>` | corresponding assignment is valid |
| `is_nothrow_move_constructible_v<T>` | that construction is `noexcept` — drives `vector` relocation |
| `is_trivially_copyable_v<T>` | copy/move/dtor all trivial → `memcpy`-safe, `bit_cast`-able |
| `is_trivially_destructible_v<T>` | destructor is trivial → containers can skip loops |
| `is_swappable_v<T>` / `is_nothrow_swappable_v<T>` | `swap(t, t)` is valid / non-throwing |
| `is_standard_layout_v<T>` | layout is C-compatible (orthogonal to triviality) |

**Traps** — writing `~X() {}` "for logging" silently kills every move in the class · `= default` after the first declaration destroys triviality · `= delete`d functions still participate in overload resolution (that is the point) and their selection is an error, not a fallback · a defaulted move ctor is implicitly `noexcept` only if every base/member move is · declaring copy ops keeps `T` copyable but makes every "move" a copy.

---

## 9.3 Rule of Zero, Rule of Five, and Rule of Three

```cpp
// ---- Rule of Zero: the default. Own nothing directly. ----------------------
class Session {
    std::string venue_;
    std::vector<std::byte> buffer_;
    std::unique_ptr<Decoder> decoder_;      // makes Session move-only, correctly
    // No destructor, no copy, no move, no assignment written.
    // Generated ops compose member-wise, in declaration order (reverse for dtor).
};
static_assert(!std::is_copy_constructible_v<Session>);
static_assert( std::is_nothrow_move_constructible_v<Session>);
```

```cpp
// ---- Rule of Five: direct raw-resource management --------------------------
class ByteBuffer {
public:
    ByteBuffer() noexcept = default;
    explicit ByteBuffer(std::size_t n)
        : data_{n ? new std::byte[n] : nullptr}, size_{n} {}

    ~ByteBuffer() { delete[] data_; }                              // 1

    ByteBuffer(ByteBuffer const& o) : ByteBuffer{o.size_} {        // 2 deep copy
        std::copy_n(o.data_, size_, data_);
    }
    ByteBuffer& operator=(ByteBuffer const& o) {                   // 3 strong guar.
        if (this == &o) return *this;
        ByteBuffer tmp{o};      // may throw BEFORE any mutation of *this
        swap(tmp);
        return *this;
    }
    ByteBuffer(ByteBuffer&& o) noexcept                            // 4
        : data_{std::exchange(o.data_, nullptr)},
          size_{std::exchange(o.size_, 0)} {}

    ByteBuffer& operator=(ByteBuffer&& o) noexcept {               // 5
        if (this == &o) return *this;          // or: swap(o) and let o clean up
        delete[] data_;
        data_ = std::exchange(o.data_, nullptr);
        size_ = std::exchange(o.size_, 0);
        return *this;
    }
    void swap(ByteBuffer& o) noexcept {
        std::swap(data_, o.data_); std::swap(size_, o.size_);
    }
private:
    std::byte*  data_{};
    std::size_t size_{};
};
// Production version: `std::vector<std::byte>` member and ZERO special members.
```

```cpp
// ---- Rule of Five reduced to Zero by wrapping the raw resource -------------
struct FdDeleter { void operator()(int* p) const noexcept { ::close(*p); delete p; } };
class Better {
    std::unique_ptr<std::byte[]> data_ = std::make_unique<std::byte[]>(0);
    std::size_t size_{};
};   // copy is deleted, move is noexcept, dtor is correct — nothing written.
```

| Rule | When | Members you write |
|---|---|---|
| Rule of Zero | members already own correctly | none of the six |
| Rule of Three (pre-C++11 / no moves) | custom dtor **or** copy ctor **or** copy assign | all three |
| Rule of Five | direct raw-resource ownership | dtor + 2 copies + 2 moves |
| Rule of Five-and-a-half | above + unified assignment | dtor, copy ctor, move ctor, `operator=(T)` |
| Delete copy, allow move | ownership must be unique | `=delete` copies, `=default`/write moves |
| Delete both | pinned/immobile (e.g. holds a self-pointer) | `=delete` copies **and** moves |

```cpp
// Polymorphic bases: the "Rule of Five" variant everyone forgets.
struct Base {
    virtual ~Base() = default;              // declaring it suppresses moves…
    Base(Base const&) = default;            // …so re-default what you want,
    Base& operator=(Base const&) = default; //     and keep them PROTECTED to
    Base(Base&&) noexcept = default;        //     prevent slicing through Base&
    Base& operator=(Base&&) noexcept = default;
};
```

**Interview line** — "Rule of Zero is the goal; Rule of Five is what you owe the compiler once you take a resource into your own hands."

**Traps** — a defaulted copy of a class holding a raw owning pointer double-frees · `swap`-based assignment delays release of the old resource to the temporary's destructor · a copy ctor delegating to `ByteBuffer{o.size_}` must still guard `size_ == 0` if `copy_n` cannot take null · public copy/move on a polymorphic base enables slicing.

---

## 9.4 Move semantics as ownership transfer—not "moving bytes"

```cpp
class Socket {
public:
    explicit Socket(int fd = -1) noexcept : fd_{fd} {}
    ~Socket() { if (fd_ != -1) ::close(fd_); }

    Socket(Socket const&)            = delete;     // OS handle is unique
    Socket& operator=(Socket const&) = delete;

    Socket(Socket&& o) noexcept : fd_{std::exchange(o.fd_, -1)} {}
    Socket& operator=(Socket&& o) noexcept {
        if (this != &o) { if (fd_ != -1) ::close(fd_); fd_ = std::exchange(o.fd_, -1); }
        return *this;
    }
    [[nodiscard]] int get() const noexcept { return fd_; }
    [[nodiscard]] int release() noexcept { return std::exchange(fd_, -1); }
private:
    int fd_;
};
// Bytes copied: 4. Ownership transferred: an external kernel resource.
```

| Type | Move cost | Why |
|---|---|---|
| `std::vector<T>` | O(1) | three pointers swapped/stolen |
| `std::string` (long) | O(1) | heap pointer stolen |
| `std::string` (short, SSO) | O(sizeof buffer) | inline chars are copied |
| `std::array<T, N>` | O(N) | element-wise moves, no indirection |
| `std::unique_ptr<T>` | O(1), `noexcept` | one pointer + null-out |
| `std::shared_ptr<T>` | O(1), no atomics on move | copy costs an atomic increment |
| `std::list` / `map` / `set` | O(1) move-construct | node pointers stolen |
| `std::vector` move-**assign** | O(1) *or* O(N) | O(N) if allocators unequal and non-propagating |
| trivially copyable struct | O(sizeof) copy | "move" is just a copy |

```cpp
// ---- std::move is a cast, nothing more ------------------------------------
template<class T>
constexpr std::remove_reference_t<T>&& move(T&& v) noexcept {
    return static_cast<std::remove_reference_t<T>&&>(v);
}
std::vector<int> v{1,2,3};
std::move(v);                 // no effect whatsoever — discarded xvalue
auto w = std::move(v);        // NOW the move ctor runs and transfers

// ---- moving from const silently copies -------------------------------------
std::string const name = "venue";
std::string s = std::move(name);    // const string&& → binds to const string&
                                    // → COPY. No diagnostic. Drop the const.
```

```cpp
// ---- ownership vocabulary at interfaces ------------------------------------
void inspect(Order const&);                  // borrow, no ownership, no null
void mutate(Order&);                         // borrow mutably
void consume(std::unique_ptr<Order>);        // TRANSFER exclusive ownership
void share(std::shared_ptr<Order>);          // acquire shared ownership
void observe(Order const*);                  // nullable observation — document lifetime
void scan(std::span<Order const>);           // borrowed contiguous range (C++20)
void parse(std::string_view);                // borrowed text; NO lifetime extension
// void bad(std::unique_ptr<Order> const&);  // observes the WRAPPER; prefer Order&
```

| Representation | Ownership meaning | Cost |
|---|---|---|
| value member | owner controls subobject lifetime | inline, no indirection |
| `std::unique_ptr<T>` | exclusive dynamic ownership; move-only | one indirection, zero overhead vs raw |
| `std::shared_ptr<T>` | shared lifetime via control block | atomic refcount traffic, 2 words |
| `std::weak_ptr<T>` | non-owning observation of shared state | `lock()` is an atomic CAS loop |
| raw `T*` / `T&` | observation **by convention** | free; enforce with docs and reviews |
| `std::span` / `std::string_view` | borrowed range/text | free; dangles if source dies |
| index + generation | handle into an owner-managed pool | survives reallocation |

```cpp
// ---- return by value; do NOT std::move a local return -----------------------
std::vector<int> make()      { std::vector<int> v(1000); return v; }            // NRVO
std::vector<int> makeBad()   { std::vector<int> v(1000); return std::move(v); } // blocks NRVO
std::vector<int> makeOk(std::vector<int> v) { return v; }                       // implicit move (param)
Base makeSlice(Derived d)    { return d; }        // implicit move from local — C++20 widened
```

**Interview line** — "A move transfers *ownership*, not memory; whether that is one pointer or N elements depends on how the type represents what it owns."

**Traps** — `std::move` on a `const` variable · `return std::move(local)` disabling NRVO · assuming `move` is `noexcept` for a type whose members allocate · moving a `std::array` or SSO string expecting O(1) · `std::move` on a trivially copyable type buys nothing.

---

## 9.5 Moved-from states and valid-but-unspecified values

```cpp
std::vector<int> src{1, 2, 3};
auto dst = std::move(src);

src.clear();          // OK — no preconditions
src.push_back(4);     // OK — no preconditions
src = other;          // OK — assignment always valid
src.size();           // OK — but the value is UNSPECIFIED
// src.front();       // UB unless you checked !src.empty() first
// assert(src.empty());  // NOT a portable postcondition (true in practice for
//                       // move-CONSTRUCTION on libstdc++/libc++, still not guaranteed)
```

| Type | Moved-from guarantee |
|---|---|
| `std::unique_ptr` | **specified**: equals `nullptr` |
| `std::shared_ptr` / `std::weak_ptr` | **specified**: empty |
| `std::optional` | still *engaged* if it was; contained value is moved-from |
| `std::variant` | holds the same alternative, whose value is moved-from |
| `std::string`, `std::vector`, containers | valid but **unspecified** |
| `std::thread`, `std::jthread` | **specified**: not joinable |
| `std::fstream`, `std::unique_lock` | **specified**: closed / no owned mutex |
| `std::any` | valid but unspecified (usually empty) |
| your types | whatever you document — document it |

- "Valid" = all class invariants hold, destructor and assignment are safe.
- "Unspecified" = do not assume empty, null, zero, zero-capacity, or the original value.
- Prefer designing an *explicitly specified* moved-from state (usually "empty/default") for your own types.
- Reusing a moved-from `vector` via `clear()` + `push_back` may keep the old capacity — a legitimate optimization you must not *rely* on.

```cpp
// Making your own contract explicit and testable:
class Batch {
public:
    Batch(Batch&& o) noexcept : items_{std::move(o.items_)} { o.items_.clear(); }
    // Documented postcondition: a moved-from Batch is empty().
    bool empty() const noexcept { return items_.empty(); }
private:
    std::vector<Event> items_;
};
```

**Traps** — `assert(v.empty())` after a move is a portability bug · reading `.front()`/`.top()`/`*ptr` on a moved-from object without checking · a moved-from `optional` is still `has_value()` · a self-move can leave an object in the unspecified state even though nothing was "transferred".

---

## 9.6 Self-assignment and self-move

```cpp
x = x;                              // self copy-assignment
x = std::move(x);                   // self move-assignment
v[i] = v[j];                        // aliasing self-assignment when i == j
std::swap(a, a);                    // must be a no-op, not corruption
```

```cpp
// ---- BROKEN: release-then-steal --------------------------------------------
Resource& operator=(Resource&& o) noexcept {
    release(h_);                     // if &o == this, we just freed o.h_
    h_ = o.h_;                       // adopt a dangling handle
    o.h_ = invalid;                  // …and then null ourselves out
    return *this;
}

// ---- FIX 1: explicit self-check --------------------------------------------
Resource& operator=(Resource&& o) noexcept {
    if (this == &o) return *this;
    release(h_);
    h_ = std::exchange(o.h_, invalid);
    return *this;
}

// ---- FIX 2: swap and let the source's destructor free the old resource ------
Resource& operator=(Resource&& o) noexcept { std::swap(h_, o.h_); return *this; }
// Self-move becomes a genuine no-op; old resource dies with `o`, not sooner.

// ---- FIX 3: copy-and-swap handles BOTH self-copy and self-move --------------
Resource& operator=(Resource o) noexcept { swap(o); return *this; }
```

```cpp
// ---- BROKEN copy-assignment: mutate-before-allocate -------------------------
Buf& operator=(Buf const& o) {
    delete[] p_;                      // self-assignment already destroyed o.p_
    p_ = new T[o.n_];                 // and if new throws, *this is wrecked
    std::copy_n(o.p_, o.n_, p_);
    n_ = o.n_; return *this;
}
// ---- FIX: build first, commit last (strong guarantee, self-safe) ------------
Buf& operator=(Buf const& o) {
    T* q = new T[o.n_];               // may throw — *this untouched
    std::copy_n(o.p_, o.n_, q);
    delete[] p_; p_ = q; n_ = o.n_;   // noexcept commit
    return *this;
}
```

- Copy assignment must be **value-preserving** under self-assignment: `x = x` leaves `x` equal to its old value.
- Move assignment is only required to leave the object *valid*; the standard's `MoveAssignable` requirement permits valid-but-unspecified after self-move.
- Standard algorithms (`sort`, `remove`, `unique`, `shift_left`) do perform self-moves internally — a broken self-move shows up as memory corruption deep inside `<algorithm>`.
- The `if (this == &other)` branch is one predictable compare; take it unless a benchmark proves otherwise.

**Traps** — `std::swap(a, a)` on a type whose move-assign is release-then-steal is UB · self-check by value equality instead of address · assuming `x = std::move(x)` preserves `x`'s value · forgetting that `erase`/`remove_if` alias elements.

---

## 9.7 `std::move`, `std::forward`, and `std::forward_like`

```cpp
#include <utility>

// ---- std::move: unconditional cast to xvalue --------------------------------
template<class T>
constexpr std::remove_reference_t<T>&& move(T&&) noexcept;

// ---- std::forward: conditional cast, two overloads --------------------------
template<class T> constexpr T&& forward(std::remove_reference_t<T>&  t) noexcept;
template<class T> constexpr T&& forward(std::remove_reference_t<T>&& t) noexcept;
// Always call as forward<T>(x) with an EXPLICIT template argument.

// ---- std::forward_like<Model>(x) : C++23, <utility> -------------------------
template<class Model, class U> constexpr auto&& forward_like(U&& x) noexcept;
// Result category: Model's (lvalue vs rvalue). Result constness: merged (const
// from Model OR from U). "Model const&&" → "U const&&".
```

| Call | Argument | Result |
|---|---|---|
| `std::move(x)` | any | `remove_reference_t<decltype(x)>&&` (xvalue) |
| `std::forward<T>(x)`, `T = U&` | lvalue-deduced | `U&` (lvalue) |
| `std::forward<T>(x)`, `T = U` | rvalue-deduced | `U&&` (xvalue) |
| `std::forward_like<M&>(x)` | — | `like_t&` lvalue |
| `std::forward_like<M&&>(x)` | — | `like_t&&` xvalue |
| `std::forward_like<M const&>(x)` | — | `const like_t&` |
| `std::move_if_noexcept(x)` | `T` | `T&&` if nothrow-move **or** non-copyable, else `T const&` |
| `std::exchange(obj, new)` | — | old value (moved out), assigns `new` |
| `std::swap(a, b)` | — | three moves; `noexcept` iff move ops are |

```cpp
// ---- forward_like with deducing this (C++23) --------------------------------
template<class T>
struct Slot {
    T value;
    template<class Self>
    constexpr auto&& get(this Self&& self) noexcept {
        return std::forward_like<Self>(self.value);   // T& / T const& / T&& / T const&&
    }
};
Slot<std::string> s{"a"};
auto&  a = s.get();                          // std::string&
auto&& b = Slot<std::string>{"t"}.get();     // std::string&&  (dangles after ;)
auto const& c = std::as_const(s).get();      // std::string const&
```

```cpp
// ---- forward_like without deducing this: forwarding through a wrapper --------
template<class Self>
decltype(auto) unwrap(Self&& s) { return std::forward_like<Self>(*s.ptr); }
// *s.ptr is always an lvalue; forward_like re-applies Self's category.
// std::forward<decltype(*s.ptr)> would NOT work — the pointee's category is
// unrelated to the owner's.
```

```cpp
// ---- exchange / move_if_noexcept in practice --------------------------------
int fd = std::exchange(other.fd_, -1);             // steal + reset in one expression
auto ptr = std::exchange(head_, head_->next);      // classic list pop
T tmp = std::move_if_noexcept(src[i]);             // what vector growth does
```

- `std::move` on a *return* of a local blocks NRVO; on a *member of a returned local* it is still useful.
- `std::forward<T>` with an omitted explicit argument does not compile (by design — the parameter is an lvalue).
- `std::forward_like` never validates lifetime: forwarding a member out of a temporary produces a dangling xvalue as easily as anything else.
- `as_const(x)` (C++17) is the cheap way to force the const overload; `std::move(as_const(x))` is a deliberate "copy this" spelling.

**Traps** — `std::move` inside `return` statements · `std::forward(x)` without `<T>` · `forward<T>` applied to something whose type is not `T`'s parameter · using `forward_like<Self>` on a member accessed through a *pointer you also own* without checking lifetime · `std::exchange` is not atomic (that is `std::atomic::exchange`).

---

## 9.8 Perfect forwarding and forwarding-reference deduction

```cpp
// A forwarding (universal) reference is EXACTLY:
template<class T> void f(T&& x);          // T deduced, cv-unqualified → forwarding
void g(auto&& x);                          // C++20 abbreviated → forwarding
auto&& r = expr;                           // forwarding in a deduced init
template<class T> void h(T const&& x);     // NOT forwarding (cv-qualified)
template<class T> void i(std::vector<T>&& x); // NOT forwarding (not plain T)
void j(Message&& m);                       // NOT forwarding (no deduction)
template<class T> struct Box {
    void put(T&& x);                       // NOT forwarding — T belongs to Box
    template<class U> void set(U&& x);     // IS forwarding — U deduced here
};
```

| Argument expression | Deduced `T` | Parameter type after collapse | `forward<T>(x)` yields |
|---|---|---|---|
| `X lv` (mutable lvalue) | `X&` | `X&` | lvalue `X&` |
| `X const clv` | `X const&` | `X const&` | const lvalue |
| `X{}` (prvalue) | `X` | `X&&` | xvalue `X&&` |
| `std::move(lv)` (xvalue) | `X` | `X&&` | xvalue `X&&` |
| `std::move(clv)` | `X const` | `X const&&` | const xvalue |

```text
reference collapsing:   & + &  ->  &
                        & + && ->  &
                       && + &  ->  &
                       && + && ->  &&      (only rvalue+rvalue stays rvalue)
```

```cpp
// The named parameter is ALWAYS an lvalue — that is the whole reason for forward.
template<class T>
void relay(T&& value) {
    static_assert(std::is_lvalue_reference_v<decltype((value))>);  // always true
    consume(value);                     // ALWAYS copies (lvalue)
    consume(std::move(value));          // ALWAYS moves — wrong for lvalue args
    consume(std::forward<T>(value));    // correct: preserves the caller's category
}
```

```cpp
// ---- Full-fidelity forwarding wrapper --------------------------------------
template<class F, class... Args>
constexpr decltype(auto) invoke_logged(F&& f, Args&&... args)
    noexcept(std::is_nothrow_invocable_v<F, Args...>)
    requires std::invocable<F, Args...>
{
    return std::invoke(std::forward<F>(f), std::forward<Args>(args)...);
}
// decltype(auto) preserves references; auto would decay them to values.
```

```cpp
// ---- Forwarding into containers and factories -------------------------------
template<class T, class... A>
std::unique_ptr<T> make(A&&... a) { return std::unique_ptr<T>(new T(std::forward<A>(a)...)); }
v.emplace_back(std::forward<A>(a)...);
std::forward<Tuple>(t);                        // then std::get<I>(std::forward<Tuple>(t))
std::apply([](auto&&... xs){ sink(decltype(xs)(xs)...); }, std::move(tup)); // decltype-cast idiom
```

```cpp
// ---- Forward each value ONCE ------------------------------------------------
template<class T> void bad(T&& v) {
    consume(std::forward<T>(v));
    inspect(std::forward<T>(v));   // may inspect a pillaged object
}
template<class T> void good(T&& v) {
    inspect(v);                    // read via lvalue first
    consume(std::forward<T>(v));   // forward last, exactly once
}
// In a pack expansion each element is forwarded once — that is fine.
// In a LOOP body, forwarding the same parameter every iteration is not.
```

```cpp
// ---- Constrain forwarding constructors or they eat everything ---------------
class Person {
public:
    template<class S>
        requires std::constructible_from<std::string, S> &&
                 (!std::same_as<std::remove_cvref_t<S>, Person>)
    explicit Person(S&& n) : name_{std::forward<S>(n)} {}
    Person(Person const&) = default;   // otherwise the template beats this for Person&
private:
    std::string name_;
};
```

```cpp
// ---- Forwarding a range / an lvalue-only overload set -----------------------
template<class R> void sink(R&& r) {
    for (auto&& e : r) use(std::forward<decltype(e)>(e));   // per-element forwarding
}
```

- Perfect forwarding is *not* perfect: it fails or misbehaves for braced-init-lists (`{1,2}` has no type), `0`/`NULL` as a null pointer, overloaded function names, template names, bit-fields, and `static const` members with no definition (pre-C++17 ODR-use).
- Forwarding templates instantiate once per distinct cv/ref combination — a real code-size and compile-time cost on hot paths.
- `std::forward` never changes the *type*, only the value category and cv-qualification.

**Interview line** — "`T&&` is a forwarding reference only when `T` is deduced at that call; `std::forward<T>` recovers the category that reference collapsing recorded in `T`."

**Traps** — `template<class T> void f(std::vector<T>&& v)` is a plain rvalue ref · `const T&&` disables forwarding · `auto&& x = f();` extends a temporary's lifetime but forwarding it out of the function does not · unconstrained forwarding ctors shadow the copy ctor and cause infinite recursion or hard errors · `forward` in a loop.

---

## 9.9 Copy-and-swap and transactional assignment

```cpp
class Value {
public:
    // One assignment for both copy and move: the PARAMETER is copy- or
    // move-constructed by the caller's category, then swapped in.
    Value& operator=(Value other) noexcept(std::is_nothrow_swappable_v<Value>) {
        swap(other);
        return *this;
    }
    void swap(Value& o) noexcept {
        using std::swap;              // enable ADL + std fallback
        swap(data_, o.data_);
        swap(tag_, o.tag_);
    }
    friend void swap(Value& a, Value& b) noexcept { a.swap(b); }
private:
    std::vector<int> data_;
    std::string      tag_;
};
```

```cpp
Value a, b;
a = b;              // parameter copy-constructed → strong guarantee, self-safe
a = std::move(b);   // parameter MOVE-constructed → no extra allocation
a = a;              // safe: the parameter is an independent copy
```

| Property | Copy-and-swap | Hand-written pair of assignments |
|---|---|---|
| Self-assignment | free | needs explicit check |
| Exception guarantee | strong (if ctor throws before mutation) | must be engineered |
| Code volume | one function | two functions |
| Capacity reuse | **no** — always builds a fresh temporary | yes: `data_ = o.data_` reuses buffer |
| Old resource release | deferred to temporary's destructor | immediate |
| Move-assign cost | one extra move + swap | direct steal |
| Distinct copy/move costs | hidden behind one signature | explicit |

```cpp
// ---- The capacity-reuse alternative: cheaper in hot loops --------------------
Value& operator=(Value const& o) {          // basic guarantee, reuses storage
    data_ = o.data_;                        // vector::operator= reuses capacity
    tag_  = o.tag_;                         // when capacity() >= o.size()
    return *this;
}
```

```cpp
// ---- Transactional in-place assignment (strong guarantee, no full temporary) --
Matrix& operator=(Matrix const& o) {
    if (rows_ == o.rows_ && cols_ == o.cols_) {   // fast path: no allocation
        std::copy(o.begin(), o.end(), begin());   // requires nothrow element copy
        return *this;
    }
    Matrix tmp{o};                                // slow path: build then commit
    swap(tmp);
    return *this;
}
```

```cpp
// ---- swap correctness rules --------------------------------------------------
// 1. Member swap must be noexcept, or the whole idiom loses its guarantee.
// 2. Swap ALL members — a forgotten member is a silent corruption.
// 3. `using std::swap; swap(x, y);` (two-step), never `std::swap(x, y)` in generics.
// 4. std::swap is O(1) for pointer-owning containers, O(N) for std::array.
// 5. Container swap: iterators/refs follow the ELEMENTS to the other container;
//    end() iterators are invalidated. Allocators must be equal or propagate.
static_assert(std::is_nothrow_swappable_v<Value>);
```

| Facility | Effect |
|---|---|
| `std::swap(a, b)` | three moves; `constexpr` since C++20 |
| `std::swap(T (&)[N], T (&)[N])` | element-wise, O(N) |
| `std::ranges::swap` | C++20 CPO: ADL-correct, no `using` dance needed |
| `std::exchange(a, v)` | assign and return old — the building block of move ctors |
| `c.swap(other)` (containers) | O(1) except `array`; `end()` invalidated |
| `std::iter_swap(i, j)` | swaps pointees |

**Interview line** — "Copy-and-swap buys self-assignment safety and the strong guarantee with one function, and pays for it with a full temporary allocation on every assignment."

**Traps** — `operator=(Value other)` plus a separate `operator=(Value&&)` is ambiguous · a throwing `swap` destroys the guarantee · forgetting a member in `swap` · using copy-and-swap on a hot-loop object whose capacity would otherwise be reused · `std::swap` on `std::array<T,N>` is O(N), not a pointer swap.

---

## 9.10 `noexcept` moves and container relocation

```cpp
struct Record {
    Record(Record const&);              // copy available
    Record(Record&&) noexcept;          // move cannot throw → vector will USE it
};
static_assert(std::is_nothrow_move_constructible_v<Record>);

struct Throwy {
    Throwy(Throwy const&);
    Throwy(Throwy&&);                   // NOT noexcept → vector growth COPIES
};
```

```cpp
// What vector reallocation effectively does per element:
template<class T>
constexpr auto relocate(T& x) -> decltype(auto) { return std::move_if_noexcept(x); }
// move_if_noexcept(x) is:
//   T&&      if is_nothrow_move_constructible_v<T> || !is_copy_constructible_v<T>
//   T const& otherwise
```

| `T` | nothrow move? | copyable? | Reallocation uses | Guarantee |
|---|---|---|---|---|
| `T` | yes | either | **move** | strong |
| `T` | no | yes | **copy** | strong |
| `T` | no | no (move-only) | move | basic only — a throw mid-relocation loses elements |
| trivially copyable | n/a | yes | may `memcpy` | strong |

```cpp
// ---- Get noexcept right: default it, or make it CONDITIONAL -----------------
struct Batch {
    std::vector<Event> events;
    std::string        tag;
    Batch(Batch&&) noexcept = default;   // implicitly noexcept iff all members are
};
static_assert(std::is_nothrow_move_constructible_v<Batch>);

struct Custom {
    std::vector<Event> events;
    Custom(Custom&& o) noexcept(std::is_nothrow_move_constructible_v<std::vector<Event>>)
        : events{std::move(o.events)} {}
};

// Introspective form for wrappers:
template<class T>
struct Wrap {
    T v;
    Wrap(Wrap&& o) noexcept(std::is_nothrow_move_constructible_v<T>)
        : v{std::move(o.v)} {}
    Wrap& operator=(Wrap&& o) noexcept(std::is_nothrow_move_assignable_v<T>) = default;
};
```

```cpp
// ---- Cases that quietly break noexcept moves --------------------------------
struct A { std::array<std::string, 8> s; };  // move is O(8) but still noexcept
struct B { std::list<int> l; };              // list move ctor IS noexcept
struct C { std::list<int, MyAlloc> l; };     // may NOT be, if the allocator can throw
struct D { std::string s; MyLoggingType t; };// one throwing member poisons the whole class
struct E {
    E(E&&) noexcept { log(); }               // log() throws → std::terminate. Never lie.
};
```

| Operation | `noexcept` in the standard | Consequence |
|---|---|---|
| `vector` move constructor | yes | O(1) steal |
| `vector` move assignment | conditional on allocator traits | O(N) element moves if allocators unequal & non-propagating |
| `vector::swap` | conditional | requires equal or propagating allocators |
| `unique_ptr` move ctor/assign | yes | always cheap |
| `shared_ptr` move ctor | yes | no atomic; copy costs one |
| `std::string` move ctor | yes | SSO copy still bounded |
| `std::array` move | conditional on `T` | O(N) |
| `std::function` move | **not** guaranteed | may allocate; `move_only_function` (C++23) move is `noexcept` |

- `noexcept` is part of the *function type* since C++17: a `void(*)() noexcept` converts to `void(*)()`, never the reverse.
- A violated `noexcept` calls `std::terminate` via `std::terminate_handler` — no unwinding is guaranteed.
- `noexcept(expr)` (the operator) yields `true`/`false` at compile time; `noexcept(bool)` (the specifier) consumes it.
- Marking a *destructor* `noexcept` is redundant — destructors are implicitly `noexcept` since C++11.
- A non-`noexcept` move on a copyable type turns every `push_back` growth into an O(N) *copy* pass — often the single largest avoidable cost in a hot container.
- `noexcept` never eliminates the allocation or the O(N) relocation itself; it only chooses move over copy.

```cpp
// Verify in one line before you ship a value type into a vector:
static_assert(std::is_nothrow_move_constructible_v<Order>);
static_assert(std::is_nothrow_move_assignable_v<Order>);
static_assert(std::is_nothrow_swappable_v<Order>);
```

**Interview line** — "If a copyable type's move constructor is not `noexcept`, `vector` growth copies every element to preserve the strong guarantee — so `noexcept` on moves is a performance contract, not decoration."

**Traps** — a user-declared destructor removes the move entirely, so there is nothing for `noexcept` to help · defaulted moves lose `noexcept` when any member's move can throw · writing `noexcept` on a body that logs, allocates, or throws · `std::function` members silently making a class's move throwing · allocator-aware move *assignment* being O(N) despite a `noexcept` move *constructor*.

---

## Recall card

```text
copy ctor        X(X const&)   new object from lvalue; independent state
move ctor        X(X&&)        new object from rvalue; transfer is type-defined
assignment                     overwrite a LIVE object: release + acquire + self-safe
implicit moves                 declared only if no copy/move op AND no destructor declared
declared move                  implicit copy ops become DELETED
= default in-class             stays non-user-provided, may stay trivial
Rule of Zero                   own via members; write none of the six
Rule of Five                   raw resource → dtor + 2 copies + 2 moves
move(x)                        static_cast to xvalue; performs no transfer
const + move                   binds to const&: silently COPIES
moved-from                     alive and valid; state only as documented
forward<T>(x)                  restore deduction-time category (call site category)
forward_like<M>(x)             apply M's cv + category (C++23, deducing this)
forwarding ref                 deduced cv-unqualified T&& / auto&& only
&&+&& == &&                    every other collapse yields &
forward once                   second forward may consume a pillaged value
copy-and-swap                  build replacement, noexcept commit; costs a temporary
move_if_noexcept               T&& if nothrow-move or move-only, else T const&
noexcept move                  vector relocates by move instead of copying
ownership                      value/unique/shared own; ptr/ref/span/view observe
```
