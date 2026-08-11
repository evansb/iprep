# 4. Values, objects, storage, and lifetime

*Part I — Language foundations*

---

**Recall**
- An object is a region of storage with a type, a lifetime, a storage duration, and (barring overlap rules) an identity; functions and references are not objects.
- Storage duration is *when the bytes exist*; lifetime is *when a `T` lives in them* — the two are independent axes.
- Allocation obtains storage; initialization begins lifetime — `malloc` is not a constructor and `~T()` does not free.
- Value category is a property of an *expression*, never of a type or an object.
- `glvalue = lvalue | xvalue`, `rvalue = xvalue | prvalue`; a prvalue has no identity until it is *materialized*.
- A named variable of type `T&&` is an **lvalue** expression; `std::move` is a cast to xvalue that moves nothing.
- Since C++17 a prvalue directly initializes its result object — guaranteed elision, so no copy/move ctor need exist.
- A temporary dies at the end of its full-expression unless a reference is bound *directly* to it.
- Lifetime extension never propagates through a function return, a reference parameter, or a second reference.
- Lifetime of a class object ends when the destructor *starts*, or when its storage is reused or released.
- Reusing the storage of a live object ends its lifetime without running the destructor — a leak of required effects.
- Pointer arithmetic is defined only within one array object (a scalar is a one-element array), including one-past-the-end.
- A one-past-the-end pointer compares and iterates but may never be dereferenced; null is not one-past.
- Provenance: an optimizer tracks which allocation a pointer came from — forging an address with the right numeric value is still UB.
- Implicit-lifetime types (trivially destructible + trivial or deleted default ctor, arrays, some aggregates) can be created implicitly by `malloc`, `operator new`, `memcpy`, and `bit_cast`.
- Use `std::construct_at` / `std::destroy_at` (or placement `new` / explicit `p->~T()`) for general types in raw storage; storage must be sized *and* aligned.
- `std::launder` retargets a pointer at a new object in the narrow non-transparent-replacement cases (const/reference members, base or `[[no_unique_address]]` subobjects); it creates nothing.
- Empty complete objects have nonzero size; empty *base* subobjects and `[[no_unique_address]]` members may occupy zero bytes and share addresses.
- Trivially copyable means `memcpy`-round-trippable in-process — not wire-serializable: padding, endianness, and ABI remain.
- Lifetime bugs hide in `-O0` tests and appear under load, because reuse of freed storage happens sooner.

---

## 4.1 Objects versus values; identity, type, lifetime, and storage

```cpp
#include <cstddef>
#include <cstdint>
#include <bit>
#include <type_traits>

int a = 7;            // object: automatic storage, type int, identity &a
int b = 7;            // equal VALUE, distinct object and identity
int& r = a;           // reference: has lifetime, provides no new storage
r = 9;                // assigns THROUGH the reference: a == 9
assert(&r == &a);     // a reference has no address of its own

struct Padded { std::uint8_t tag; std::uint32_t px; };  // likely 3 padding bytes
static_assert(sizeof(Padded) == 8);
// object representation = sizeof(T) bytes, INCLUDING padding
// value representation  = the bits that participate in the value
Padded p1{1, 100}, p2{1, 100};
// std::memcmp(&p1, &p2, sizeof p1) == 0  is NOT guaranteed: padding is indeterminate
bool same = (p1.tag == p2.tag && p1.px == p2.px);       // compare values, not bytes

auto bytes = std::bit_cast<std::array<std::byte, 8>>(p1);  // C++20; padding unspecified
```

```cpp
// const constrains modification through the type; identity is unchanged.
int const k = 5;
int const* pk = &k;             // fine
// *const_cast<int*>(pk) = 6;   // UB: modifying an object declared const

// A const member function returns a const view of the SAME object.
struct Book { int n; int get() const { return n; } };
```

| Term | One-line meaning |
|---|---|
| Object | Storage region + type + lifetime + (usually) identity |
| Value | Abstract information an object holds or an expression computes |
| Identity | Distinguishable address; two objects of the same type never share one (unless overlapping subobjects) |
| Storage duration | `automatic`, `static`, `thread`, `dynamic` — how long the *bytes* last |
| Lifetime | Interval in which the *object* may be used per the rules |
| Object representation | All `sizeof(T)` bytes, padding included |
| Value representation | The subset of bits determining the value |
| Subobject | Member, base subobject, or array element |

**Interview line** — "Allocation gets storage; construction starts a lifetime; they are separate events, and either can exist without the other."

**Traps** — `memcmp` on padded types compares indeterminate bytes · reading padding is not UB for `unsigned char`/`std::byte` but the values are unspecified · `sizeof` includes padding, so it is not a wire size · a reference is not an object, so no arrays/pointers of references.

---

## 4.2 lvalues, xvalues, prvalues, glvalues, and temporary materialization

```text
expression
├── glvalue           identifies an object or function
│   ├── lvalue        identity, NOT expiring
│   └── xvalue        identity, resources may be reused
└── prvalue           computes a value / initializes a result object

rvalue = xvalue | prvalue        glvalue = lvalue | xvalue
```

```cpp
struct Widget { int n; Widget f(); Widget& g(); Widget&& h(); };
Widget  w{};
Widget* pw = &w;
int     arr[4]{};

// ---- lvalues ----------------------------------------------------------
w;                     // named variable
arr;                   // array name (lvalue of array type)
"literal";             // string literal: lvalue of type const char[8]
*pw;                   // dereference of an object pointer
arr[2];                // subscript on an lvalue array
w.n;                   // member of an lvalue
w.g();                 // call returning T&
++w.n;                 // pre-increment
w.n = 1;               // assignment yields an lvalue
static_cast<Widget&>(w);

// ---- xvalues ----------------------------------------------------------
std::move(w);                       // cast to Widget&&
static_cast<Widget&&>(w);           // same thing, no <utility> needed
w.h();                              // call returning T&&
Widget{}.n;                         // member of a prvalue → xvalue (materialized)
std::move(arr)[1];                  // subscript on an rvalue array

// ---- prvalues ---------------------------------------------------------
42; 3.5; nullptr; true;             // literals (NOT string literals)
w.n + 1;                            // arithmetic
&w;                                 // address-of
w.f();                              // call returning T by value
Widget{};                           // temporary object expression
[]{ return 1; };                    // lambda expression
static_cast<int>(w.n);              // cast to non-reference type
```

```cpp
// ---- the classic ------------------------------------------------------
Widget&& rr = Widget{};   // rr is DECLARED T&&, but ...
use(rr);                  // ... the expression `rr` is an LVALUE
use(std::move(rr));       // explicit xvalue when you mean to pluck resources
// Rule: "if it has a name, it is an lvalue."
```

```cpp
// ---- temporary materialization (C++17 model) --------------------------
struct Price { int ticks; void log() const; };
int n = Price{42}.ticks;      // prvalue materialized → temporary → member access
Price const& ref = Price{7};  // materialized, and lifetime-extended
Price{9}.log();               // materialized to get a `this` pointer
auto sz = sizeof(Price{1});   // NOT materialized: unevaluated operand

// Guaranteed elision: a prvalue initializes the destination directly.
struct NoCopy { NoCopy(int); NoCopy(NoCopy const&) = delete; NoCopy(NoCopy&&) = delete; };
NoCopy make() { return NoCopy{1}; }   // OK in C++17+: no copy/move ctor required
NoCopy obj = make();                  // one object, constructed in place
```

| Expression form | Category | Note |
|---|---|---|
| named variable / parameter (any type, incl. `T&&`) | lvalue | names are lvalues |
| string literal | lvalue | type `const char[N]` |
| `*p`, `p->m`, `a[i]` (lvalue `a`) | lvalue | |
| `f()` returning `T&` | lvalue | |
| `f()` returning `T&&`, `std::move(x)`, `std::forward` on rvalue | xvalue | |
| `obj.m` where `obj` is a prvalue | xvalue | prvalue materialized first |
| `f()` returning `T` (by value) | prvalue | |
| `42`, `a+b`, `&a`, `T{}`, lambda | prvalue | |
| `a ? b : c` | category depends on operands | can be lvalue if both are same-type lvalues |
| `throw x` | prvalue of type `void` | |

```cpp
// ---- overload resolution by category ----------------------------------
void consume(Quote&);        // #1 mutable lvalue only
void consume(Quote const&);  // #2 catch-all: const lvalue, or any rvalue
void consume(Quote&&);       // #3 rvalue (prvalue or xvalue), beats #2

Quote q;  Quote const cq{};
consume(q);              // #1
consume(cq);             // #2
consume(Quote{});        // #3
consume(std::move(q));   // #3
consume(std::move(cq));  // #2 — const rvalue cannot bind to Quote&&
```

**Traps** — value category promises no copy or move, only which operations are *possible* · `std::move` on a `const` object silently copies · `decltype(x)` vs `decltype((x))`: the parenthesized form yields `int&` for an lvalue · `std::move` in a `return` statement can disable NRVO · returning `std::move(local)` of the return type is a pessimization.

---

## 4.3 Automatic, static, thread, and dynamic storage duration

```cpp
#include <memory>
#include <memory_resource>

int global_count;                       // static duration, external linkage, zero-init
static int tu_local;                    // static duration, internal linkage
inline int shared_across_tus = 0;       // C++17 inline variable: one object program-wide
thread_local std::uint64_t decoded{};   // thread duration, one per thread
constinit thread_local int fast_tls = 0;// C++20: guarantees no dynamic init → cheap TLS

struct Cache { Cache(); };

void f(int param) {                     // param: automatic duration
    Quote local{};                      // automatic; destroyed at }
    static Cache cache;                 // static duration, block scope, thread-safe
                                        //   first-use init ("magic static", guard var)
    thread_local Buffer scratch;        // thread duration, block scope
    auto owner = std::make_unique<Quote>();   // pointee: dynamic duration
    Quote* raw = new Quote{};           // dynamic duration; you must delete
    delete raw;
}
```

```cpp
// ---- dynamic storage: every spelling ----------------------------------
T*  p1 = new T;                       // default-init (indeterminate for trivial T)
T*  p2 = new T();                     // value-init
T*  p3 = new T{};                     // value-init (list)
T*  p4 = new T{a, b};                 // list-init
T*  a1 = new T[n];                    // array; delete[] required
T*  a2 = new T[n]{};                  // value-initialized array
T*  p5 = new (std::nothrow) T;        // returns nullptr instead of throwing
void* buf = ::operator new(bytes);    // raw storage only, NO object
void* abuf = ::operator new(bytes, std::align_val_t{64});  // C++17 over-aligned
::operator delete(abuf, std::align_val_t{64});
delete p1; delete[] a1;               // MUST match the form used

struct alignas(64) CacheLine { int x; };
auto* cl = new CacheLine;             // C++17: uses aligned operator new automatically

// Owning wrappers — prefer these:
auto u  = std::make_unique<T>(args...);
auto ua = std::make_unique<T[]>(n);          // value-initializes
auto uo = std::make_unique_for_overwrite<T>();   // C++20: default-init, no zeroing
auto s  = std::make_shared<T>(args...);      // one allocation for control block + T
```

| Duration | Introduced by | Bytes last | Init timing | Destruction |
|---|---|---|---|---|
| automatic | block variable, parameter | until block exit | on execution of declaration | reverse order at scope exit |
| static | namespace-scope, `static` member, local `static` | whole program | zero-init → constant-init → dynamic init | reverse order of completion, at exit |
| thread | `thread_local` | whole thread | first odr-use in that thread | thread exit, reverse order |
| dynamic | `new`, `operator new`, allocator | until `delete`/deallocate | at construction | when you say so |

```cpp
// ---- static initialization order fiasco & the fix ---------------------
// a.cpp: Config cfg = load();     b.cpp: int x = cfg.value;  // ORDER UNSPECIFIED
Config& config() { static Config c = load(); return c; }   // Meyers singleton: safe,
                                                           // thread-safe since C++11
// constinit forces constant initialization → no order problem, no guard check:
constinit Table lookup_table = make_table();   // must be a constant expression
constexpr std::array<int, 4> table2{1,2,3,4};  // even better: implies const
```

```cpp
// ---- cost of the guard variable in a hot path -------------------------
inline int hot(int i) {
    static Table const t = build();   // every call tests an atomic guard byte
    return t[i];
}
constinit Table const t2 = build();   // no guard, no branch — hoist init out of the path
```

**Traps** — `thread_local` access can compile to a `__tls_get_addr` call in shared libraries · local-static init takes a lock on first use and an acquire load thereafter · dynamic-init order across TUs is unspecified; destruction order at exit can outlive threads · `delete` on `new[]` memory is UB · `std::exit` does not destroy automatic objects of other threads.

---

## 4.4 Object lifetime begin/end rules

```text
storage acquired ─► lifetime BEGINS ─► usable ─► lifetime ENDS ─► storage reused/released
                    initialization                dtor starts /
                    or implicit creation          storage reused
```

```cpp
// ---- begins -----------------------------------------------------------
// 1. storage of the right size AND alignment is obtained, AND
// 2. initialization (including trivial default init) is complete.
Quote q{};                              // both, at the declaration
auto* h = new Quote{};                  // both, inside new-expression

// ---- ends -------------------------------------------------------------
// non-class T : when destroyed, or storage reused/released
// class T     : when the destructor CALL BEGINS (not when it returns)
// reference   : as if a scalar; does NOT destroy the referent
```

```cpp
#include <memory>
struct Slot { std::uint64_t id; ~Slot(); };

alignas(Slot) std::byte storage[sizeof(Slot)];
Slot* p = ::new (static_cast<void*>(storage)) Slot{42};  // lifetime BEGINS
p = std::construct_at(reinterpret_cast<Slot*>(storage), 42);  // C++20 equivalent
std::destroy_at(p);                     // lifetime ENDS; bytes remain valid storage
p->~Slot();                             // same, explicit destructor call
// p->id;                               // UB: no live Slot at that address
```

```cpp
// ---- reuse ends lifetime WITHOUT running the destructor ---------------
struct Res { std::FILE* f; ~Res() { std::fclose(f); } };
Res r{open()};
::new (&r) Res{open2()};   // r's lifetime ended; ~Res never ran → FILE leaked
// Correct: r.~Res(); ::new (&r) Res{open2()};
// (And you owe a destructor for the NEW object too.)
```

```cpp
// ---- during construction/destruction ----------------------------------
struct Base { Base() { virtual_call(); }   // dispatches to Base's override, not Derived's
              virtual void virtual_call(); };
struct Derived : Base { void virtual_call() override; int n = 1; };
// Inside Base's ctor: the Derived object's lifetime has not begun; Derived members
// are not yet initialized; dynamic type is Base.
```

| Question | Answer |
|---|---|
| Does `operator new` start a lifetime? | No — it returns storage; the *new-expression* also constructs |
| Does `~T()` free storage? | No — it ends lifetime only |
| Is a pointer to storage before construction usable? | Only as `void*`/byte access; member access is UB |
| Does `delete p` after `p->~T()` work? | Yes if the memory came from `new` — but double destruction is UB |
| Can lifetime restart in the same bytes? | Yes — that is exactly what a pool/`optional` does |
| Trivial default init: lifetime begun? | Yes; value is indeterminate but the object exists |

**Traps** — `p->~T()` then reusing `p` without laundering, on types with const/reference members · destroying an object twice (RAII + explicit call) · reusing the storage of a complete `const` object is UB · leaving raw storage half-constructed after a throwing constructor · `std::vector` reserved-but-unconstructed slots hold no objects.

---

## 4.5 Temporary lifetime extension

```cpp
// ---- default: end of the FULL-EXPRESSION, reverse order of completion --
consume(make_quote());                    // temporary destroyed after the `;`
auto n = std::string("a").size();         // temporary alive across the whole expression
char const* bad = std::string("a").c_str();  // DANGLES at the `;`

// ---- direct binding extends -------------------------------------------
Price const& p  = Price{101};       // lives as long as p
Price&&      q  = Price{102};       // same for an rvalue reference
auto&&       z  = Price{103};       // idiomatic "capture whatever it is"
int const&   m  = Price{104}.ticks; // extends the WHOLE temporary (member binding)
Base const&  bb = Derived{};        // extends the complete Derived object
static Price const& s = Price{9};   // extended to static duration (init at first pass)
```

```cpp
// ---- extension does NOT happen -----------------------------------------
Price const& identity(Price const& x) { return x; }
Price const& bad1 = identity(Price{1});          // dangles at end of full-expression

Price const& bad2() { Price const& r = Price{2}; return r; }  // returns a danger

struct Ref { Price const& p; };
Ref safe{Price{1}};        // brace-init of an aggregate member: EXTENDED (to safe)
Ref danger(Price{2});      // parenthesized-init (C++20 aggregate paren-init): NOT extended

struct Holder { Price const& p; Holder(Price const& q) : p(q) {} };
Holder h{Price{3}};        // ctor PARAMETER binding: dies at end of the full-expression

// Price const* pp = &Price{4};        // ill-formed: cannot take the address of a prvalue

struct RefMem { Price const& p; };
auto* heap = new RefMem{Price{5}};     // new-initializer: NOT extended — dangles at the `;`
```

```cpp
// ---- range-for over a temporary ---------------------------------------
for (auto& x : get_vector())            { }   // OK: the returned vector IS extended
for (auto& x : get_obj().member_vec())  { }   // C++20 and earlier: DANGLES;
                                              // C++23 fixed range-for temporaries (P2718)
for (auto obj = get_obj(); auto& x : obj.member_vec()) { }  // C++20 portable fix
```

| Situation | Extended? |
|---|---|
| `T const& r = T{};` / `T&& r = T{};` | yes, to `r`'s lifetime |
| binding to a member/base subobject of the temporary | yes, whole temporary |
| function *parameter* `T const&` | no — through the call's full-expression only |
| returning a bound reference | no — dangles |
| second reference initialized from the first | no — extension is not transitive |
| aggregate reference member, brace init | yes |
| aggregate reference member, paren init (C++20) | **no** |
| reference member in a constructor's mem-init-list | no |
| range-for over a *subexpression* temporary | C++23 yes; before that, no |

**Interview line** — "Lifetime extension happens exactly once, at the point of direct binding; it never passes through a return, a parameter, or another reference."

**Traps** — `std::string_view sv = std::string("x");` dangles immediately · `auto&& x = f().g();` extends only if `g()` returns by value · `std::min(a, 5)` returning a reference to the temporary `5` · extension is a compile-time property, so a runtime-conditional bind still extends whichever branch bound.

---

## 4.6 References: lvalue, rvalue, forwarding, and dangling references

```cpp
int x = 1, y = 2;
int&  lr = x;          // must be initialized; cannot be reseated
lr = y;                // assigns 2 INTO x; lr still refers to x
int const& cr = 42;    // const lvalue ref binds to a prvalue (extends it)
int&& rr = 42;         // rvalue ref binds to prvalue
// int& bad = 42;      // ill-formed: non-const lvalue ref cannot bind to rvalue
// int& e;             // ill-formed: must be initialized
double d = 1.0;
int const& conv = d;   // binds to a MATERIALIZED temporary int(1) — not to d!
```

```cpp
// ---- forwarding (universal) references ---------------------------------
template<class T> void sink(T&& t);        // T&& with DEDUCED T → forwarding ref
template<class T> void notfwd(std::vector<T>&& v);  // NOT a forwarding ref
auto&& u = expr;                            // forwarding ref (auto deduction)

Widget w;
sink(w);              // T = Widget&  → parameter Widget& &&  → Widget&
sink(std::move(w));   // T = Widget   → parameter Widget&&
sink(Widget{});       // T = Widget   → parameter Widget&&

template<class T>
void relay(T&& t) {
    consume(std::forward<T>(t));   // preserves category: lvalue stays lvalue
    // consume(std::move(t));      // WRONG: steals from a caller's lvalue
}
// C++23: deducing this gives a forwarding-ref member function
struct S { template<class Self> auto&& get(this Self&& self) {
               return std::forward<Self>(self).value; } };
```

```text
reference collapsing
T&  &  → T&      T&  && → T&
T&& &  → T&      T&& && → T&&        (only && && survives as &&)
```

```cpp
// ---- classic dangling sources ------------------------------------------
int const& local_ref()      { int v = 1; return v; }        // returns dead local
std::string_view bad_view() { return std::string{"tmp"}; }  // view into destroyed string
auto lam = [&x] { return x; };  // dangles if lam outlives x

std::vector<int> v{1,2,3};
int& ref = v[0];
v.push_back(4);        // may reallocate → ref dangles
v.reserve(100);        // ALSO invalidates: reallocation
std::map<int,int> m;
int& mref = m[1];
m.erase(1);            // mref dangles (node destroyed)

auto& first = get_container().front();   // container temporary dies; `first` dangles
std::string_view key = std::string(a) + b;   // concat temporary dies at the `;`
```

| Form | Binds to lvalue | Binds to rvalue | Binds to const | Deduction |
|---|---|---|---|---|
| `T&` | yes | no | no | fixed |
| `T const&` | yes | yes | yes | fixed; may extend |
| `T&&` (concrete `T`) | no | yes | no (const rvalue → no) | fixed |
| `T&&` (deduced `T`) | yes (`T=U&`) | yes (`T=U`) | yes | forwarding |
| `auto&&` | yes | yes | yes | forwarding |

**Traps** — `std::forward<T>` without a deduced `T` is a bug · a `const T&&` overload exists and swallows `std::move(const_obj)` · lambda `[&]` capture of a loop variable that outlives the loop · storing `string_view`/`span` in a member outlives its owner · returning `*this` by reference from an rvalue-qualified member.

---

## 4.7 Pointers: null, one-past, pointer arithmetic, and provenance concerns

```cpp
int a[4]{};
int* first = a;              // array-to-pointer decay
int* last  = a + 4;          // one-past-the-end: valid, NOT dereferenceable
for (int* p = first; p != last; ++p) ++*p;
// *last = 1;                // UB
// int* far = a + 5;         // UB even without dereference
std::ptrdiff_t n = last - first;    // 4 — same array object, OK

int scalar = 0;
int* sp = &scalar;
int* se = sp + 1;            // OK: a scalar behaves as a one-element array
// sp + 2;                   // UB

int b[4]{};
// a - b;                    // UB: unrelated arrays
bool ordered = std::less<int*>{}(a, b);   // library-defined TOTAL order: well-defined
bool eq = (a == b);          // equality between unrelated pointers is fine (false)
```

```cpp
// ---- null ---------------------------------------------------------------
int* p = nullptr;            // std::nullptr_t, prefer over NULL / 0
if (p != nullptr) use(*p);   // check BEFORE the dereference
// A null check AFTER a dereference is dead code to the optimizer:
// int v = *p; if (!p) return;   // compiler deduces p != nullptr and drops the branch
// nullptr + 0  is well-defined (C++11 CWG) and yields nullptr; nullptr + 1 is UB
static_assert(sizeof(nullptr) == sizeof(void*));
```

```cpp
// ---- casts on pointers ---------------------------------------------------
void*        vp  = a;                          // implicit to void*
int*         ip  = static_cast<int*>(vp);      // back out: must be the original type
std::byte*   bp  = reinterpret_cast<std::byte*>(a);   // byte inspection is allowed
std::uintptr_t u = reinterpret_cast<std::uintptr_t>(a);  // optional type!
int*         rt  = reinterpret_cast<int*>(u);  // round trip: same value, provenance murky
Base*        bpp = static_cast<Base*>(dp);     // up-cast: always safe
Derived*     ddp = static_cast<Derived*>(bpp); // down-cast: UNCHECKED, UB if wrong
Derived*     dyn = dynamic_cast<Derived*>(bpp);// checked, needs polymorphic Base, nullptr on fail
int const*   cp2 = const_cast<int const*>(ip); // adding const: fine
```

```cpp
// ---- pointer-interconvertible ------------------------------------------
struct Std { int first; int second; };            // standard-layout
Std s{};
// &s and &s.first are pointer-interconvertible:
Std* back = reinterpret_cast<Std*>(&s.first);     // OK
// offsetof works only for standard-layout types:
static_assert(offsetof(Std, second) == sizeof(int));
// std::addressof avoids an overloaded operator&:
auto* real = std::addressof(obj);
```

```cpp
// ---- provenance in practice ---------------------------------------------
int arr[8]{};
int* p1 = arr + 1;
int* p2 = arr + 3;
std::uintptr_t diff = reinterpret_cast<std::uintptr_t>(p2)
                    - reinterpret_cast<std::uintptr_t>(p1);
int* forged = reinterpret_cast<int*>(reinterpret_cast<std::uintptr_t>(p1) + diff);
// `forged` numerically equals p2 but the compiler may not treat it as pointing into arr.
int* honest = p1 + (p2 - p1);   // do this instead: arithmetic keeps provenance
```

| Operation | Defined when |
|---|---|
| `p + n`, `p - n` | result within `[array, array+N]` of the *same* array object |
| `p - q` | same array object (or both one-past); result type `std::ptrdiff_t` |
| `*p` | `p` points to a live object; never for one-past or null |
| `p == q`, `p != q` | always (unspecified but not UB for unrelated objects) |
| `p < q` | same array/complete object; else use `std::less<T*>` |
| `void*` round trip | back to the *original* pointer type only |
| `uintptr_t` round trip | `std::uintptr_t` is optional; value preserved, provenance implementation-defined |
| `std::memcpy` between objects | both trivially copyable, no overlap unless `memmove` |

**Traps** — signed overflow in an index computed as `int` before adding to a pointer · `p + 1 > end` as a bounds check is UB (check `n <= end - p`) · aliasing a `float*` through an `int*` violates strict aliasing (use `std::bit_cast` / `memcpy`) · `reinterpret_cast` never changes the address for the same object but does not create a live `T`.

---

## 4.8 Subobjects, complete objects, and potentially-overlapping subobjects

```cpp
struct Header  { std::uint32_t sequence; };
struct Message : Header { std::uint16_t size; };   // Header base + size member

Message m{};
Header& h = m;                    // base subobject
assert(static_cast<void*>(&h) == static_cast<void*>(&m));   // often, not required
// A complete object is one that is not a subobject of another object.
```

```cpp
// ---- empty base optimization vs empty member --------------------------
struct Empty {};
struct WithMember { Empty e; int n; };            // sizeof >= sizeof(int) + 1 padded → 8
struct WithBase : Empty { int n; };               // EBO: sizeof == 4
struct WithNUA { [[no_unique_address]] Empty e; int n; };  // C++20: sizeof == 4

static_assert(sizeof(Empty) == 1);                // complete empty objects: nonzero size
static_assert(sizeof(WithBase) == sizeof(int));
static_assert(sizeof(WithNUA)  == sizeof(int));

// Practical use: stateless comparators/deleters/allocators cost zero bytes.
template<class T, class Cmp = std::less<T>>
struct Sorted { [[no_unique_address]] Cmp cmp{}; std::vector<T> data; };
```

```cpp
// ---- two [[no_unique_address]] members of the SAME type cannot overlap --
struct Two { [[no_unique_address]] Empty a;
             [[no_unique_address]] Empty b; int n; };   // a and b need distinct addresses
static_assert(sizeof(Two) > sizeof(int));               // typically 8
```

| Concept | Rule |
|---|---|
| Complete object | not a subobject of anything; has a unique address among same-type objects |
| Subobject | member, base subobject, or array element |
| Potentially-overlapping subobject | base subobject, or `[[no_unique_address]]` member |
| Empty complete object | `sizeof >= 1` so addresses differ |
| Empty base / NUA member | may occupy zero bytes, may share an address with another subobject |
| Distinct objects of same type | must have distinct addresses **unless** one is potentially-overlapping |

```cpp
// ---- why overlap complicates lifetime ---------------------------------
// A potentially-overlapping subobject may NOT be safely `memcpy`ed as a whole
// (its tail bytes may belong to a sibling) and is a launder-relevant case
// after destroy/reconstruct.
static_assert(std::is_trivially_copyable_v<Message>);
Message copy;
std::memcpy(&copy, &m, sizeof m);      // OK: copying the COMPLETE object
// std::memcpy(&h_dest, &h, sizeof h); // risky if h is a base subobject with a tail
```

**Traps** — `sizeof(Base)` bytes of a `Derived` may include `Derived` members via tail padding reuse · `[[no_unique_address]]` changes ABI, so it is not a drop-in for shipped layouts · `offsetof` on non-standard-layout types is conditionally supported · array-of-`Base` iterated with a `Derived*` stride is UB (the classic slicing-array bug).

---

## 4.9 Implicit-lifetime types, placement `new`, and `std::launder`

```cpp
#include <memory>
#include <new>
#include <cstdlib>
#include <cstring>

// Implicit-lifetime type: scalar, array, or class with a trivial (or deleted)
// default ctor AND a trivial destructor. Such objects can be created IMPLICITLY.
struct Packet { std::uint32_t id; std::uint16_t size; };
static_assert(std::is_implicit_lifetime_v<Packet>);   // C++23 trait

void* raw = std::malloc(sizeof(Packet));   // implicitly creates a suitable Packet
auto* pk = static_cast<Packet*>(raw);      // ...and this is the one that makes it defined
pk->id = 7;                                // OK: no constructor was ever run
std::free(raw);

// Operations that implicitly create objects:
//   malloc/calloc/realloc/aligned_alloc, ::operator new / new[],
//   std::memcpy / std::memmove into the bytes, std::bit_cast,
//   std::allocator<T>::allocate, std::start_lifetime_as<T> (C++23).
auto* pkt = std::start_lifetime_as<Packet>(raw);          // C++23, explicit and clear
auto* arr = std::start_lifetime_as_array<Packet>(raw, n); // C++23
```

```cpp
// ---- placement new: every spelling -------------------------------------
alignas(Order) std::byte slot[sizeof(Order)];

Order* o1 = ::new (static_cast<void*>(slot)) Order{id, qty};   // placement new
Order* o2 = std::construct_at(reinterpret_cast<Order*>(slot), id, qty);  // C++20
                                                       // constexpr-friendly, no <new> syntax noise
std::destroy_at(o1);                                   // C++17
o1->~Order();                                          // equivalent

// Arrays / ranges of raw storage (<memory>):
std::uninitialized_default_construct_n(p, n);   // default-init (no zeroing)
std::uninitialized_value_construct_n(p, n);     // value-init
std::uninitialized_fill_n(p, n, value);
std::uninitialized_copy(first, last, p);
std::uninitialized_copy_n(first, n, p);
std::uninitialized_move(first, last, p);        // C++17; strong-guarantee-unfriendly
std::uninitialized_move_n(first, n, p);
std::destroy(p, p + n);
std::destroy_n(p, n);

// Aligned raw buffers:
alignas(T) std::byte buf[sizeof(T) * N];                    // preferred
// std::aligned_storage_t<sizeof(T), alignof(T)> old;       // DEPRECATED in C++23
void* ap = ::operator new(bytes, std::align_val_t{64});     // over-aligned heap
std::unique_ptr<T, void(*)(T*)> guard{o2, [](T* q){ std::destroy_at(q); }};
```

```cpp
// ---- exception safety around raw storage -------------------------------
template<class T, std::size_t N>
class InlineVec {
    alignas(T) std::byte buf_[sizeof(T) * N];
    std::size_t size_{};
    T* data() noexcept { return reinterpret_cast<T*>(buf_); }
public:
    template<class... A> T& emplace_back(A&&... a) {
        T* p = std::construct_at(data() + size_, std::forward<A>(a)...);  // may throw:
        ++size_;                       // ...size_ only advances AFTER success
        return *p;
    }
    ~InlineVec() { std::destroy_n(data(), size_); }      // exactly-once destruction
    InlineVec(InlineVec const&) = delete;                // or implement carefully
};
```

```cpp
// ---- transparent replacement: pointers auto-retarget --------------------
struct Node { int value; };
Node n{1};
Node* p = &n;
std::destroy_at(p);
std::construct_at(p, 2);
assert(p->value == 2);        // transparent replacement: no launder needed

// ---- NOT transparent: const/reference members, base/NUA subobjects ------
struct X { const int n; };
X x{1};
X* old = &x;
std::destroy_at(old);
::new (old) X{2};
// old->n;                    // UB: `old`/`x` still nominally denote the OLD object
X* fresh = std::launder(old); // C++17, <new>: a usable pointer to the new object
assert(fresh->n == 2);
// The NAME `x` is still poisoned — access only through `fresh`.
```

```cpp
// ---- launder after byte-level storage reuse -----------------------------
alignas(Widget) std::byte store[sizeof(Widget)];
auto* w = ::new (store) Widget{};                        // new-expr result is fine
auto* w2 = std::launder(reinterpret_cast<Widget*>(store));  // reinterpret needs launder
```

| Facility | Header | Effect |
|---|---|---|
| `::new (ptr) T(args)` | `<new>` | construct at `ptr`; returns `T*`; no allocation |
| `std::construct_at(p, args...)` | `<memory>` | C++20; `constexpr`; equivalent, value-init with no args |
| `std::destroy_at(p)` | `<memory>` | C++17; calls `p->~T()` (recurses into arrays) |
| `std::destroy(first,last)` / `_n` | `<memory>` | destroy a range |
| `std::uninitialized_*` family | `<memory>` | construct into raw storage, unwinding on throw |
| `std::launder(p)` | `<new>` | C++17; returns a pointer to the object *now* at that address |
| `std::start_lifetime_as<T>(p)` | `<memory>` | C++23; begin an implicit lifetime explicitly, no init |
| `std::bit_cast<To>(from)` | `<bit>` | C++20; `constexpr` reinterpretation, both trivially copyable, equal sizes |
| `std::is_implicit_lifetime_v<T>` | `<type_traits>` | C++23 trait |
| `std::allocator<T>::allocate(n)` | `<memory>` | raw storage for `n` `T`s; no lifetimes started for non-implicit `T` |

**`std::launder` does NOT** — start a lifetime · fix misalignment · make an aliasing violation legal · resurrect freed storage · convert between unrelated types.

**Interview line** — "`launder` creates nothing; it tells the compiler to stop assuming the old object is still there."

**Traps** — forgetting the destructor for a placement-constructed object · destroying twice via RAII plus an explicit call · under-aligned `char buf[]` instead of `alignas(T)` · `reinterpret_cast<T*>(buffer)` and dereferencing before any object exists · `std::launder` on a pointer to storage where no object lives is UB.

---

## 4.10 Trivial, standard-layout, aggregate, POD (historical), and implicit-lifetime types

```cpp
#include <type_traits>

struct Packet { std::uint32_t id; std::uint16_t size; };
static_assert(std::is_trivial_v<Packet>);                 // deprecated in C++26 as vocabulary
static_assert(std::is_trivially_copyable_v<Packet>);
static_assert(std::is_trivially_default_constructible_v<Packet>);
static_assert(std::is_trivially_destructible_v<Packet>);
static_assert(std::is_standard_layout_v<Packet>);
static_assert(std::is_aggregate_v<Packet>);               // C++17
static_assert(std::is_implicit_lifetime_v<Packet>);       // C++23
static_assert(std::has_unique_object_representations_v<std::uint32_t>);  // no padding/traps

// What breaks each property:
struct NotTrivial   { int n = 0; };                       // NSDMI → non-trivial default ctor
struct NotCopyable  { std::string s; };                   // non-trivial copy
struct NotStdLayout { public: int a; private: int b; };   // mixed access
struct NotStdLayout2 : Packet { int extra; };             // data in >1 class of the hierarchy
struct NotAggregate { NotAggregate(int); };               // user-declared ctor
struct NotAggregate2 { private: int n; };                 // private non-static member
class  HasVirtual   { virtual void f(); };                // vptr: none of trivial/std-layout
```

| Property | Requires | Buys you |
|---|---|---|
| trivially default constructible | no NSDMI, no user ctor, no virtuals, all members likewise | `T x;` is a no-op; no zeroing cost |
| trivially destructible | no user dtor, all members/bases likewise | destruction is a no-op; array teardown vanishes |
| trivially copyable | trivial copy/move ctor+assign, trivial dtor, none deleted | `memcpy` round trip; `bit_cast`; ABI in registers |
| trivial | trivially default constructible **and** trivially copyable | both of the above |
| standard-layout | one access control for all non-static data, no virtuals/virtual bases, data in one class, no base of the same type as the first member | `offsetof`, C interop, pointer-interconvertible with first member |
| aggregate | no user-*provided*/inherited/explicit ctors, no private/protected non-static data, no virtuals | brace init, designated initializers, CTAD |
| implicit-lifetime | trivial or deleted default ctor **and** trivial dtor | created implicitly by `malloc`/`memcpy`/`bit_cast` |
| POD (historical) | trivial + standard-layout | deprecated as design vocabulary; `std::is_pod` deprecated in C++20 |

```cpp
// ---- what trivially copyable really licenses ---------------------------
Packet p{7, 12};
std::byte bytes[sizeof p];
std::memcpy(bytes, &p, sizeof p);      // OK
Packet q;
std::memcpy(&q, bytes, sizeof q);      // OK: round trip; q's value == p's value
auto r = std::bit_cast<Packet>(bytes_as_array);   // C++20, constexpr, no UB, no aliasing games

// NOT licensed:
//  - writing those bytes to a socket and reading them on another machine
//    (padding is indeterminate, endianness differs, ABI layout differs)
//  - assuming a value read back is a VALID value of an enum/bool
bool b;
std::memcpy(&b, "\x02", 1);            // b now holds a trap-ish value → UB on use
```

```cpp
// ---- designated initializers require an aggregate (C++20) --------------
struct Config { int depth = 10; bool verbose = false; double eps = 1e-9; };
Config c{.depth = 5, .eps = 1e-6};     // must be in DECLARATION order; no skipping back
// Config d{.eps = 1, .depth = 2};     // ill-formed in C++ (legal in C)

// ---- concept-style checks for hot-path types ---------------------------
template<class T>
concept HotPathValue = std::is_trivially_copyable_v<T>
                    && std::is_standard_layout_v<T>
                    && std::is_trivially_destructible_v<T>
                    && (alignof(T) <= 64);
static_assert(HotPathValue<Packet>);
```

**Interview line** — "Trivially copyable is a *memory* property, not a *protocol* property: it says the bytes round-trip in this process, nothing about the wire."

**Traps** — `is_pod` is deprecated; ask the specific question instead · adding one `std::string` member silently costs triviality throughout the enclosing aggregate · a defaulted-in-class ctor (`T() = default;`) keeps triviality, a user-*provided* one (`T() {}`) does not · `has_unique_object_representations_v` is false for anything with padding, so hashing raw bytes is only safe when it holds · `std::is_trivial` is deprecated in C++26.

---

## Recall card

```text
object              storage + type + lifetime + identity
storage duration    automatic | static | thread | dynamic
lifetime begins     aligned storage + initialization complete (or implicit creation)
lifetime ends       dtor STARTS, or storage reused/released
lvalue              glvalue, not expiring          named T&& is an LVALUE
xvalue              glvalue, resources reusable    std::move / f() -> T&&
prvalue             initializes its result object  guaranteed elision since C++17
temporary           dies at full-expression unless a reference binds DIRECTLY
extension           never through return / parameter / a second reference
collapsing          & & -> &   & && -> &   && & -> &   && && -> &&
one-past pointer    comparable, iterable, never dereferenceable
pointer arithmetic  within one array object only; provenance survives + and -, not casts
overlap             base subobjects and [[no_unique_address]] members may share bytes
implicit-lifetime   trivial/deleted default ctor + trivial dtor; malloc can create it
construct_at        begin lifetime in valid storage    destroy_at ends it
launder             retarget a pointer after non-transparent replacement; creates nothing
trivially copyable  memcpy round-trip in-process, NOT a serialization contract

hot-path proof      owner + lifetime + invalidation + reuse state at every handoff
```
