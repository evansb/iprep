# 11. Inheritance and runtime polymorphism

*Part II — Classes, resource management, and generic programming*

---

**Recall**
- Public inheritance means substitutability: every `Derived` must honor the `Base` contract wherever a `Base` is expected.
- Private/protected inheritance is "implemented in terms of" — composition usually states that more clearly.
- A virtual call through a reference or pointer invokes the **final overrider** selected by the *dynamic* type.
- `virtual` is needed only on the first declaration; `override` on derived declarations turns a signature mismatch into a compile error.
- An override must match parameter list, cv-qualification, and ref-qualification exactly; only return types may be covariant.
- The override's exception specification must be at least as restrictive as the base's (`noexcept` base ⇒ `noexcept` override).
- Covariance works for raw pointers/references only — `unique_ptr<Derived>` does not covariantly override `unique_ptr<Base>`.
- Default arguments bind by *static* type while the body binds by *dynamic* type — never redeclare a default in an override.
- Any same-name declaration in the derived scope hides the whole base overload set; `using Base::f;` reintroduces it.
- A class is abstract if some pure virtual has no final overrider; it may still have data, ctors, and even a definition for the pure virtual.
- A pure virtual destructor still requires an out-of-class definition because destruction always calls it.
- Slicing: copying a derived object into a base *value* keeps only the base subobject and the dynamic type becomes `Base`.
- Delete through a base pointer ⇒ base destructor must be `public virtual`; otherwise make it `protected` non-virtual.
- During base construction/destruction the dynamic type *is* the base — virtual calls never reach derived overrides.
- Non-virtual multiple inheritance gives one base subobject per path; `Derived*→Base*` may require a pointer adjustment (thunk).
- Virtual inheritance shares one base subobject; the **most-derived** constructor initializes it, before all non-virtual bases.
- Vptr/vtable is a common ABI implementation, not a language guarantee — never `memcpy`, serialize, or assume layout.
- `dynamic_cast<T*>` yields `nullptr` on failure, `dynamic_cast<T&>` throws `std::bad_cast`; source must be polymorphic for down/cross-casts.
- `typeid(expr)` on a polymorphic glvalue evaluates the operand and yields the dynamic type; `typeid(*p)` with `p == nullptr` throws `std::bad_typeid`.
- `type_info::name()` is implementation-defined — not a stable protocol or persistence identifier.
- CRTP replaces dispatch with a `static_cast` to the derived type: inlinable, but no common runtime type and code duplicates per instantiation.
- Choose on the type set: open ⇒ virtual/type erasure, closed ⇒ `variant`, compile-time-known ⇒ template/CRTP.
- `final` can enable devirtualization but guarantees nothing; batching (one virtual call per span) removes dispatch cost entirely.

---

## 11.1 Public, protected, and private inheritance

```cpp
struct Handler { void reset(); protected: int state_{}; private: int secret_{}; };

struct FeedHandler   : public    Handler {};   // is-a; Derived*→Base* public
class  Impl          : private   Handler {};   // implemented-in-terms-of
struct Mid           : protected Handler {};   // relationship visible only downstream

struct S : Handler {};    // struct default: PUBLIC
class  C : Handler {};    // class  default: PRIVATE  ← classic surprise
```

```cpp
class Impl : private Handler {
public:
    using Handler::reset;                 // selectively re-export one base member
};
struct Re : private Handler {
    void go() { Handler::reset(); state_ = 1; }   // members/friends still reach base
};
```

| Base access | base `public` becomes | base `protected` becomes | base `private` | `Derived*→Base*` conversion |
|---|---|---|---|---|
| `public` | public | protected | inaccessible (still present, still initialized) | anyone |
| `protected` | protected | protected | inaccessible | derived classes + friends |
| `private` | private | private | inaccessible | derived's own members + friends |

```cpp
// Composition beats private inheritance for stateful helpers.
class Engine {
    Decoder decoder_;                     // Engine is not a Decoder
public:
    void feed(std::span<std::byte const> b) { decoder_.decode(b); }
};

// Empty policy without any inheritance (C++20)
template<class Alloc>
struct Buffer {
    [[no_unique_address]] Alloc alloc_{}; // zero size if Alloc is empty
    std::byte* data_{};
};
```

| Reuse mechanism | Use when |
|---|---|
| Composition | default; independent testing, clear ownership, layout freedom |
| Private inheritance | must override a base virtual, or need protected access, or EBO on pre-C++20 |
| `[[no_unique_address]]` | empty policy member without the inheritance coupling (C++20) |
| Public inheritance | and only when substitutability holds |

**Interview line** — "Public inheritance is an is-a contract; if I only want the code, I hold a member."

**Traps** — `class D : B` is private by default · private base members are inaccessible but still constructed/destroyed and still occupy space · no implicit `Derived*→Base*` outside the class for non-public bases · private inheritance still lets derived override base virtuals (that is often the only real reason for it).

---

## 11.2 Virtual functions, overriding, `final`, and covariant returns

```cpp
struct Sink {
    virtual void on(Event const&) = 0;                       // pure virtual
    virtual std::size_t capacity() const noexcept = 0;
    virtual void flush() { /* default impl */ }              // virtual with body
    virtual void tag() const& ;                              // ref-qualified virtual
    virtual ~Sink() = default;                               // polymorphic ownership
};

struct QueueSink final : Sink {                              // class final: no derivation
    void on(Event const&) override;                          // verified override
    std::size_t capacity() const noexcept override;
    void flush() final;                                      // no further overriding
    void tag() const& override;
    // 'virtual' may be repeated but is redundant with 'override'
};
```

```cpp
// ---- what must match -------------------------------------------------
struct B {
    virtual void poll() const;
    virtual void send(int);
    virtual void run() noexcept;
    virtual void late() &&;
};
struct D : B {
    void poll();                 // NOT an override (missing const) — hides B::poll
    void send(long);             // NOT an override (parameter type) — hides
    void run();                  // ill-formed: weaker exception spec than noexcept base
    void late() &&  override;    // ok: ref-qualifier matches
    // void poll() const override;   ← what was meant
};
```

```cpp
// ---- calling a specific version --------------------------------------
Sink& s = qs;
s.on(e);                 // virtual dispatch → QueueSink::on
s.Sink::flush();         // qualified call SUPPRESSES dispatch → Sink::flush
qs.Sink::flush();        // same, from derived code (typical "call base first")
void (Sink::*pm)(Event const&) = &Sink::on;   // pointer-to-member IS virtual-aware
(s.*pm)(e);                                   // dispatches to QueueSink::on
```

```cpp
// ---- name hiding vs overriding ---------------------------------------
struct Base {
    void send(int);
    void send(std::string_view);
};
struct Derived : Base {
    using Base::send;         // WITHOUT this, d.send(1) fails to find Base::send(int)
    void send(Event const&);
};
Derived d; d.send(1);         // ok only because of the using-declaration
```

```cpp
// ---- covariant returns ------------------------------------------------
struct Product { virtual ~Product() = default; };
struct Order : Product {};

struct Factory      { virtual Product* create() = 0; virtual ~Factory() = default; };
struct OrderFactory : Factory { Order* create() override; };   // covariant pointer
struct RefFactory   { virtual Product& get(); };
struct ORefFactory  : RefFactory { Order& get() override; };   // covariant reference

// std::unique_ptr<Order> create() override;  // ill-formed: NOT covariant
```

```cpp
// Owning factory: keep the virtual primitive erased, add a typed non-virtual sugar.
struct Factory2 {
    virtual std::unique_ptr<Product> create() = 0;
    virtual ~Factory2() = default;
};
struct OrderFactory2 : Factory2 {
    std::unique_ptr<Product> create() override { return make(); }
    std::unique_ptr<Order>   make()  { return std::make_unique<Order>(); }  // non-virtual
};
```

```cpp
// ---- template method: one default, one virtual hook -------------------
class Codec {
public:
    int encode(std::span<std::byte> out, int level = 3) {   // default lives HERE only
        return do_encode(out, level);
    }
    virtual ~Codec() = default;
private:
    virtual int do_encode(std::span<std::byte>, int) = 0;   // private virtual is fine
};
```

| Specifier | Applies to | Meaning |
|---|---|---|
| `virtual f()` | member function | enable dynamic dispatch from this class down |
| `= 0` | virtual | pure; class becomes abstract (definition still allowed) |
| `override` | derived member | compile error unless it overrides something |
| `final` (function) | virtual | no further overriding |
| `final` (class) | class | no derivation; enables trivial devirtualization |
| `Base::f()` | call site | static call, dispatch suppressed |

**Interview line** — "`override` is free; it converts silent hiding bugs into compile errors."

**Traps** — `override`/`final` are contextual keywords, still usable as identifiers · a private virtual is overridable (access controls calling, not overriding) · covariance requires the base return type be complete and the conversion unambiguous & accessible · virtual functions may not be templates · a default-argument change in an override is legal and almost always a bug.

---

## 11.3 Abstract classes and pure virtual functions

```cpp
struct Decoder {
    virtual DecodeResult decode(std::span<std::byte const>) = 0;
    virtual void reset() = 0;
    virtual ~Decoder() = 0;                     // pure virtual DESTRUCTOR
};
Decoder::~Decoder() = default;                  // ...still needs a definition

struct FixDecoder : Decoder {                   // concrete: all pure virtuals overridden
    DecodeResult decode(std::span<std::byte const>) override;
    void reset() override;
};

// Decoder d;                                   // ill-formed: abstract
Decoder* p = new FixDecoder;                    // ok
std::unique_ptr<Decoder> up = std::make_unique<FixDecoder>();
// void f(Decoder);                             // ill-formed: abstract by value
// std::vector<Decoder> v;                      // ill-formed
Decoder& r = *up;                               // ok: references/pointers only
```

```cpp
// A pure virtual MAY have a definition, callable only with qualified syntax.
struct Base { virtual void init() = 0; };
void Base::init() { /* shared partial work */ }
struct Der : Base { void init() override { Base::init(); /* extra */ } };
```

```cpp
// Abstract classes can carry state, constructors, and non-virtual helpers.
class Stage {
    std::string name_;
protected:
    explicit Stage(std::string n) : name_(std::move(n)) {}   // protected ctor
    Stage(Stage const&) = default;                           // protect against slicing
    Stage& operator=(Stage const&) = default;
public:
    std::string_view name() const noexcept { return name_; } // non-virtual
    virtual void run() = 0;
    virtual ~Stage() = default;
};
```

```cpp
// Non-deletable interface: no virtual destructor needed.
class Observer {
public:
    virtual void on_tick(Tick const&) noexcept = 0;
protected:
    ~Observer() = default;      // protected non-virtual: delete through Observer* is
};                              // ill-formed rather than UB
```

| Rule | Detail |
|---|---|
| Abstract class | ≥1 pure virtual without a final overrider |
| Instantiation | no objects, no by-value params/returns, no arrays, no container elements |
| Pointers/references | always allowed, including `unique_ptr`/`shared_ptr` |
| Pure virtual with body | legal; reachable only via `Base::f()` qualification |
| Pure virtual destructor | **must** be defined |
| Ctor/dtor calling a pure virtual | UB (typically `pure virtual method called` + abort) |

**Interview line** — "A pure virtual destructor is the cheapest way to make a class abstract when every other function has a sensible default — but you still have to define it."

**Traps** — abstract-class-by-value is a compile error, but abstract-base-*reference* copy-init still slices at the concrete level · declaring the destructor suppresses implicit move operations · leave copy ops protected on polymorphic bases to block slicing assignment.

---

## 11.4 Object slicing and virtual destructors

```cpp
struct Base { virtual int kind() const { return 0; } virtual ~Base() = default; };
struct Derived : Base { int payload{42}; int kind() const override { return 1; } };

Derived d;
Base sliced = d;               // SLICE: copies base subobject only
assert(sliced.kind() == 0);    // dynamic type is Base now

Base b2; Base& br = d;
b2 = br;                       // Base::operator= copies base part only
br = b2;                       // WORSE: overwrites d's base part, payload untouched
                               //        → object left in a mixed state

void by_value(Base);           // slices at the call
Base make();                   // slices at the return
std::vector<Base> v; v.push_back(d);   // slices into every element
try { throw Derived{}; } catch (Base e) {}   // slices the exception
```

```cpp
// Fixes, by ownership intent:
void observe(Base const& b);                       // borrow, no copy, no slice
void observe(Base* b);                             // nullable borrow
std::unique_ptr<Base> own = std::make_unique<Derived>();   // unique ownership
std::shared_ptr<Base> shr = std::make_shared<Derived>();   // shared ownership
std::vector<std::unique_ptr<Base>> heterogeneous;
std::vector<std::reference_wrapper<Base>> borrowed;         // non-owning, no slice
catch (Base const& e) { }                                   // ALWAYS catch by ref
```

```cpp
// Structural prevention: make the base non-copyable, or copy via clone().
struct Poly {
    Poly(Poly const&) = delete;                 // no slicing possible
    Poly& operator=(Poly const&) = delete;
    virtual std::unique_ptr<Poly> clone() const = 0;   // virtual copy ctor idiom
    virtual ~Poly() = default;
protected:
    Poly() = default;
};
struct Leaf : Poly {
    std::unique_ptr<Poly> clone() const override { return std::make_unique<Leaf>(*this); }
private:
    Leaf(Leaf const&) = default;                // private copy for clone's use
};
```

```cpp
// ---- destructor rules -------------------------------------------------
struct BadBase  { ~BadBase(); };                     // NON-virtual, public
struct BadDer : BadBase { std::vector<int> big; };
BadBase* p = new BadDer;
delete p;                                            // UB: leaks big, wrong dtor

struct GoodOwning    { virtual ~GoodOwning() = default; };     // deletable base
struct GoodNonOwning { protected: ~GoodNonOwning() = default; };// non-deletable base
// delete (GoodNonOwning*)p;   // ill-formed — a compile error, not UB
```

```cpp
// unique_ptr's deleter is captured from the STATIC type at construction...
std::unique_ptr<Base> u1 = std::make_unique<Derived>();  // needs virtual ~Base
// ...but shared_ptr type-erases the deleter at construction:
std::shared_ptr<Base> s1 = std::make_shared<Derived>();  // calls ~Derived even if
                                                         // ~Base is NON-virtual
std::shared_ptr<Base> s2(new Derived);                   // same: deleter remembers Derived
std::shared_ptr<Base> s3(static_cast<Base*>(new Derived)); // BAD: deleter is ~Base
```

```cpp
// ---- construction/destruction dispatch --------------------------------
struct CBase {
    CBase() { initialize(); }        // dispatches to CBase::initialize ALWAYS
    virtual ~CBase() { teardown(); } // dispatches to CBase::teardown ALWAYS
    virtual void initialize() { }
    virtual void teardown()  { }
};
struct CDer : CBase {
    std::vector<int> buf_;
    void initialize() override { buf_.resize(8); }   // never runs from CBase()
    void teardown()  override { buf_.clear();  }     // never runs from ~CBase()
};
// A PURE virtual called this way → UB, usually "pure virtual method called".
// Fix: two-phase init via a factory.
template<class T, class... A>
std::unique_ptr<T> make(A&&... a) {
    auto p = std::make_unique<T>(std::forward<A>(a)...);
    p->initialize();                 // now the dynamic type is complete
    return p;
}
```

| Situation | Destructor requirement |
|---|---|
| `delete base_ptr` on derived object | `virtual` public destructor (else UB) |
| Interface never deleted polymorphically | `protected` non-virtual destructor |
| `shared_ptr<Base>` built from `new Derived` / `make_shared<Derived>` | works without virtual dtor (erased deleter) |
| `unique_ptr<Base>` with default deleter | requires virtual dtor |
| Base stored by value only | no virtual needed; but then don't add virtuals |

**Interview line** — "If a base can be deleted through, its destructor is public and virtual; otherwise protected and non-virtual."

**Traps** — declaring `virtual ~B() = default;` suppresses implicit move ctor/assignment (rule of five) · destruction order is reverse of construction: derived members, derived bases, then base · a destructor is virtual if any base's is, even without the keyword · `std::vector<Base>` of a polymorphic type is almost always a slicing bug.

---

## 11.5 Multiple and virtual inheritance

```cpp
struct Pollable  { virtual void poll() = 0; virtual ~Pollable()  = default; };
struct Stoppable { virtual void stop() = 0; virtual ~Stoppable() = default; };

struct Session final : Pollable, Stoppable {          // orthogonal interfaces
    void poll() override; void stop() override;
};
Session s;
Pollable*  a = &s;                       // same address (first base, typically)
Stoppable* b = &s;                       // ADJUSTED address: (char*)&s + offset
assert((void*)a != (void*)b);            // holds in typical ABIs
Session* back = static_cast<Session*>(b);// static_cast un-adjusts correctly
```

```cpp
// ---- ambiguity resolution ---------------------------------------------
struct A { void reset(); int x; };
struct B { void reset(); int x; };
struct C : A, B {
    void clear() {
        // reset();          // ill-formed: ambiguous NAME LOOKUP (not overload res.)
        A::reset();          // qualify
        B::x = 1;
    }
};
// Ambiguity is decided during lookup, BEFORE access checks and overload resolution.
```

```cpp
// ---- non-virtual diamond: TWO Base subobjects -------------------------
struct Base { int v; };
struct Left  : Base {};
struct Right : Base {};
struct Dia   : Left, Right {};
Dia d;
// Base* p = &d;                 // ill-formed: ambiguous conversion
Base* p1 = static_cast<Left*>(&d);   // pick a path
d.Left::v = 1; d.Right::v = 2;       // two independent members
```

```text
      Base   Base                      Base
       |      |                        /  \
     Left   Right     vs.          Left    Right     (virtual: one shared Base)
       \     /                         \  /
         Dia                            Dia
  two Base subobjects              one Base subobject
```

```cpp
// ---- virtual inheritance ---------------------------------------------
struct Root  { explicit Root(int); virtual ~Root() = default; };
struct Left  : virtual Root { Left()  : Root{1} {} };   // ignored when not most-derived
struct Right : virtual Root { Right() : Root{2} {} };   // ignored likewise
struct Diamond : Left, Right {
    Diamond() : Root{3}, Left{}, Right{} {}   // MOST-DERIVED initializes the virtual base
};
Diamond dm;
Root* r = &dm;               // unambiguous now
// Order: virtual bases (Root) → non-virtual bases (Left, Right) → members → body.
// Destruction is exactly the reverse.
```

```cpp
// Because intermediate initializers are ignored, a virtual base with no default
// ctor forces EVERY most-derived class to name it:
struct Grand : Diamond { Grand() : Root{9}, Diamond{} {} };  // must repeat Root{9}
```

```cpp
// Interface-only diamond: the usual, harmless case.
struct IStream { virtual ~IStream() = default; };
struct IIn  : virtual IStream { virtual int  get()      = 0; };
struct IOut : virtual IStream { virtual void put(int)   = 0; };
struct IIO  : IIn, IOut {};                 // one IStream
```

| Feature | Non-virtual MI | Virtual inheritance |
|---|---|---|
| Base subobject count | one per path | exactly one, shared |
| Who initializes the base | the immediately derived class | the **most-derived** class |
| Init order | declaration order of bases | all virtual bases first, depth-first left-to-right |
| Upcast to shared base | ambiguous | unambiguous |
| `static_cast` from virtual base down | **ill-formed** | must use `dynamic_cast` |
| Cost | pointer adjust on cross-base conversion | extra indirection / vbase offset table |
| Layout stability | offsets are constant | virtual-base offset resolved at runtime |

**Interview line** — "Virtual inheritance solves shared-base *identity*; it costs an extra indirection and moves virtual-base initialization to the most-derived constructor."

**Traps** — `static_cast` cannot go *down* from a virtual base (`dynamic_cast` only) · calling a virtual from a virtual base's constructor is even more constrained · `delete` through a secondary base requires a virtual destructor plus a correct thunk · `void*` from different base pointers of the same object differ; use `dynamic_cast<void*>` to compare identity · MI of two bases with data members duplicates state silently.

---

## 11.6 Vptr/vtable as common implementations — not language guarantees

```text
Itanium-ABI shape (typical, NOT normative):

  Derived object              vtable for Derived
  +-----------+   vptr  ->  [ offset-to-top ]
  | vptr      |-----------> [ typeinfo*     ]   <- RTTI used by dynamic_cast/typeid
  | base data |             [ &Derived::~D  ]   (complete-object dtor)
  | data...   |             [ &Derived::~D  ]   (deleting dtor)
  +-----------+             [ &Derived::f   ]   slot 0
                            [ &Derived::g   ]   slot 1

  Multiple inheritance: one vptr per polymorphic base subobject; calls through a
  secondary base enter a THUNK that adjusts `this` before jumping.
```

```cpp
struct P { virtual void f(); int a; };            // sizeof(P) == 16 typically (8 vptr + 4 + pad)
static_assert(sizeof(void*) == 8);
struct NP { void f(); int a; };                   // sizeof(NP) == 4 — no vptr

static_assert(std::is_polymorphic_v<P>);          // has (or inherits) a virtual function
static_assert(!std::is_polymorphic_v<NP>);
static_assert(!std::is_trivially_copyable_v<P>);  // a virtual function ⇒ NOT trivially copyable
static_assert(std::is_trivially_copyable_v<NP>);  // no virtuals ⇒ memcpy-able
// A polymorphic object holds a vptr, so memcpy over one corrupts the dynamic type: never
// memcpy a polymorphic class, and never memcpy a Derived into a Base-sized buffer.
```

| Trait (`<type_traits>`) | True when |
|---|---|
| `std::is_polymorphic_v<T>` | `T` declares or inherits a virtual function |
| `std::is_abstract_v<T>` | `T` has an unresolved pure virtual |
| `std::is_final_v<T>` | `T` is declared `final` |
| `std::has_virtual_destructor_v<T>` | `T`'s destructor is virtual |
| `std::is_base_of_v<B, D>` | `B` is a base of `D` (ignores access; true for `D==B`) |
| `std::is_convertible_v<D*, B*>` | accessible, unambiguous public base |
| `std::derived_from<D, B>` | concept: public + unambiguous (C++20) |
| `std::is_standard_layout_v<T>` | false once a vptr exists |

- The standard specifies virtual *behavior*: no vptr member, no slot order, no object size, no fixed indirection count.
- Each polymorphic object carries ≥1 hidden pointer per polymorphic base subobject.
- A virtual call is a load of the vptr, a load of the slot, and an indirect branch — 2 dependent loads.
- Adding/reordering/removing virtuals is an **ABI break**: every translation unit must see identical class definitions.
- `dynamic_cast` and `typeid` read the RTTI pointer parked in the vtable; `-fno-rtti` removes it and both features.

**Traps** — never `memcpy`/`std::bit_cast`/serialize a polymorphic object: you would copy a vptr valid only in one process image · placement-new over a live polymorphic object then reusing the old pointer needs `std::launder` · `offsetof` on a non-standard-layout type is conditionally-supported · vtable addresses are not stable across builds, processes (ASLR), or shared-library loads.

---

## 11.7 RTTI, `dynamic_cast`, and `typeid`

```cpp
#include <typeinfo>

struct Base { virtual ~Base() = default; };
struct Derived : Base { void specific(); };
struct Other   : Base {};

void inspect(Base& base) {
    if (auto* d = dynamic_cast<Derived*>(&base)) d->specific();   // null on failure
    try { Derived& r = dynamic_cast<Derived&>(base); (void)r; }   // throws on failure
    catch (std::bad_cast const& e) { }
}
```

```cpp
Base* bp = get();
Derived*       d1 = dynamic_cast<Derived*>(bp);            // downcast, checked
Base*          u1 = dynamic_cast<Base*>(d1);               // upcast — static, always ok
void*          mo = dynamic_cast<void*>(bp);               // → most-derived object address
Derived const* dc = dynamic_cast<Derived const*>(cbp);     // cv must not be dropped

// Cross-cast through multiple inheritance (static_cast cannot do this):
struct L : virtual Base {}; struct R : virtual Base {}; struct LR : L, R {};
L* lp = new LR;
R* rp = dynamic_cast<R*>(lp);                              // sideways, checked

// Identity comparison of two unrelated base pointers:
bool same = dynamic_cast<void*>(p1) == dynamic_cast<void*>(p2);
```

| Cast form | On success | On failure | Requirement |
|---|---|---|---|
| `dynamic_cast<D*>(bp)` | pointer to `D` subobject | `nullptr` (also if `bp == nullptr`) | `Base` polymorphic |
| `dynamic_cast<D&>(br)` | reference | throws `std::bad_cast` | `Base` polymorphic |
| `dynamic_cast<void*>(bp)` | address of most-derived object | n/a | `Base` polymorphic |
| `dynamic_cast<B*>(dp)` (upcast) | pointer | never fails | compile-time, no RTTI needed |
| `static_cast<D&>(base)` | reference, **no check** | UB if wrong | unambiguous non-virtual base |
| `static_cast` from virtual base | — | ill-formed | use `dynamic_cast` |
| `reinterpret_cast<D*>(bp)` | wrong address under MI | UB | never do this |

```cpp
// static_cast downcast: fast, unchecked — only with a proven invariant.
struct Msg { std::uint8_t type; virtual ~Msg() = default; };
Msg& m = next();
if (m.type == kAdd) {
    auto& add = static_cast<Add&>(m);      // invariant: type tag proves dynamic type
    apply(add);
}
```

```cpp
// ---- typeid ------------------------------------------------------------
Derived dv; Base& ref = dv; Base val;
assert(typeid(ref)  == typeid(Derived));   // polymorphic GLVALUE → dynamic type
assert(typeid(val)  == typeid(Base));
assert(typeid(Base) == typeid(Base));      // type-id form: static, unevaluated

Base* np = nullptr;
// typeid(*np);                            // throws std::bad_typeid (polymorphic)

std::type_info const& ti = typeid(dv);
ti.name();                                 // IMPLEMENTATION-DEFINED, may be mangled
ti.hash_code();                            // size_t; equal types ⇒ equal hashes
ti.before(typeid(Base));                   // implementation-defined ordering

std::unordered_map<std::type_index, Handler> table;   // <typeindex>: copyable key
table[std::type_index(typeid(Derived))] = h;
```

```cpp
// typeid on a polymorphic glvalue EVALUATES its operand; otherwise it does not.
int calls = 0;
Base& side()    { ++calls; return globalBase; }
NonPoly& none() { ++calls; return globalNP;   }
typeid(side());   // calls == 1  (operand evaluated)
typeid(none());   // calls unchanged (unevaluated operand)
```

| `std::type_info` member | Notes |
|---|---|
| `operator==` / `operator!=` | exact type identity; the only portable comparison |
| `name()` | implementation-defined `char const*`; demangle with `abi::__cxa_demangle` on Itanium |
| `hash_code()` | `size_t`, consistent within one program run only |
| `before(other)` | implementation-defined total order; not stable across runs |
| `std::type_index` | copyable/hashable wrapper for use as a map key (`<typeindex>`) |

- `typeid` tests **exact** dynamic type; `dynamic_cast` tests the *is-a* relationship — prefer the cast for subtyping questions.
- `dynamic_cast` cost is implementation-defined and can walk the inheritance graph (not O(1) under MI); a virtual function or a tag is faster.
- Repeated `dynamic_cast` in an event loop usually means a missing virtual operation or a closed set that belongs in `std::variant`.
- `-fno-rtti` / `/GR-` removes both features; interfaces relying on them become non-portable to that build.

**Interview line** — "`dynamic_cast` returns null for pointers and throws `bad_cast` for references — that asymmetry exists because there is no null reference."

**Traps** — `dynamic_cast` on a non-polymorphic type is a compile error (except upcasts) · casting away const requires `const_cast`, `dynamic_cast` will not · during base construction, `dynamic_cast`/`typeid` see the *base* type · `typeid(a) == typeid(b)` fails for a derived object compared against its base even though the cast succeeds.

---

## 11.8 CRTP and compile-time polymorphism

```cpp
template<class Derived>
class HandlerBase {
    Derived&       self()       noexcept { return static_cast<Derived&>(*this); }
    Derived const& self() const noexcept { return static_cast<Derived const&>(*this); }
public:
    void on(Event const& e)
        noexcept(noexcept(std::declval<Derived&>().on_impl(e))) {
        self().on_impl(e);                     // static dispatch, fully inlinable
    }
    std::size_t count() const { return self().count_impl(); }
protected:
    HandlerBase() = default;                   // only Derived can construct → guards
    friend Derived;                             //   against the "false CRTP" mistake
};

class BookHandler : public HandlerBase<BookHandler> {
    friend class HandlerBase<BookHandler>;      // if hooks are private
public:
    void on_impl(Event const&) noexcept;
    std::size_t count_impl() const noexcept;
};
```

```cpp
// Mixin: base supplies operations DEFINED IN TERMS OF a derived hook.
template<class D>
struct Comparable {
    friend bool operator==(D const& a, D const& b) { return a.key() == b.key(); }
    friend auto operator<=>(D const& a, D const& b) { return a.key() <=> b.key(); }
};
struct Tick : Comparable<Tick> { std::int64_t k; std::int64_t key() const { return k; } };

// enable_shared_from_this is CRTP in the standard library:
struct Node : std::enable_shared_from_this<Node> {
    std::shared_ptr<Node> self() { return shared_from_this(); }
};
```

```cpp
// A heterogeneous container needs a runtime base — CRTP alone cannot provide it.
template<class D> struct Poly { void run() { static_cast<D&>(*this).run_impl(); } };
struct X : Poly<X> { void run_impl(); };
struct Y : Poly<Y> { void run_impl(); };
// std::vector<Poly<?>>  ← no common type. Use std::variant<X,Y> or a virtual base.
std::vector<std::variant<X, Y>> mixed;
for (auto& v : mixed) std::visit([](auto& h) { h.run(); }, v);
```

```cpp
// C++20 concepts express the same static interface without inheritance.
template<class H>
concept Handler = requires(H& h, Event const& e) {
    { h.on(e) } noexcept -> std::same_as<void>;
    { h.capacity() } -> std::convertible_to<std::size_t>;
};

void dispatch(Handler auto& h, Event const& e) noexcept { h.on(e); }
// Errors surface at the CALL with a readable constraint message, not deep inside.

// "Deducing this" collapses CRTP for many mixins (C++23):
struct Base23 {
    template<class Self>
    void on(this Self&& self, Event const& e) { self.on_impl(e); }   // no template base
};
struct Impl23 : Base23 { void on_impl(Event const&); };
```

| Property | Virtual | CRTP | Concept-constrained template |
|---|---|---|---|
| Dispatch | indirect call | direct, inlinable | direct, inlinable |
| Common runtime type | yes (`Base&`) | no | no |
| Heterogeneous container | yes | no | no |
| Error location | link/compile at declaration | deep instantiation | at the call, readable |
| Code size | one copy | one per derived | one per instantiation |
| Object overhead | vptr per object | none | none |
| Openness | runtime (plugins/DLL) | compile-time | compile-time |

**Interview line** — "CRTP is static polymorphism: the base gets the derived type as a template parameter and downcasts, so the call inlines — at the price of no common runtime type."

**Traps** — `class A : Base<B>` (wrong parameter) compiles and then downcasts to the wrong type ⇒ UB; block it with a protected ctor + `friend Derived` · `Derived` is incomplete inside the base's class body, so use members only in function bodies or defer with `template<class Self>` · CRTP bases are distinct types, so `is_base_of` matching needs a non-template tag base · public CRTP base with no virtual destructor must never be deleted through.

---

## 11.9 Type erasure versus inheritance versus variants

> This section is the *comparison*. The `variant` API itself (construction, `get_if`,
> `holds_alternative`, valueless states) is in [§21.3](/iprep/books/cpp-cheatsheet/21-utility-and-vocabulary-types/),
> the `Overload` visitor aggregate in [§14.9](/iprep/books/cpp-cheatsheet/14-callables-lambdas-and-customization/), and
> `std::function` / `move_only_function` storage and cost in
> [§14.6](/iprep/books/cpp-cheatsheet/14-callables-lambdas-and-customization/)–[§14.7](/iprep/books/cpp-cheatsheet/14-callables-lambdas-and-customization/).

```cpp
// ---- closed set: std::variant ----------------------------------------
struct Add     { std::uint64_t id; std::int64_t px; std::int32_t qty; };
struct Cancel  { std::uint64_t id; };
struct Execute { std::uint64_t id; std::int32_t qty; };
using Event = std::variant<Add, Cancel, Execute>;   // sizeof = max + tag + padding

// The property that distinguishes variant from the alternatives below:
// EXHAUSTIVENESS IS CHECKED AT COMPILE TIME.
struct Visitor {
    void operator()(Add const&) const;
    void operator()(Cancel const&) const;
    void operator()(Execute const&) const;   // omit one → compile error
};
std::visit(Visitor{}, ev);
// Add a 4th alternative and every non-generic visitor fails to compile — which is
// the feature (nothing is silently unhandled) and the cost (every TU recompiles).
```

```cpp
// ---- open set: virtual interface --------------------------------------
struct Strategy {
    virtual void on_book(Book const&) noexcept = 0;
    virtual ~Strategy() = default;
};
std::vector<std::unique_ptr<Strategy>> loaded;    // plugins, DLL boundary
```

```cpp
// ---- open set without an intrusive base: type erasure -----------------
class AnyHandler {                                 // owning, non-intrusive, movable
    struct Concept {
        virtual void call(Event const&) = 0;
        virtual std::unique_ptr<Concept> clone() const = 0;
        virtual ~Concept() = default;
    };
    template<class T>
    struct Model final : Concept {
        T obj;
        explicit Model(T t) : obj(std::move(t)) {}
        void call(Event const& e) override { obj(e); }
        std::unique_ptr<Concept> clone() const override {
            return std::make_unique<Model>(obj);
        }
    };
    std::unique_ptr<Concept> impl_;
public:
    template<class T>
        requires (!std::same_as<std::decay_t<T>, AnyHandler>)
    AnyHandler(T&& t) : impl_(std::make_unique<Model<std::decay_t<T>>>(std::forward<T>(t))) {}
    AnyHandler(AnyHandler const& o) : impl_(o.impl_->clone()) {}
    AnyHandler(AnyHandler&&) noexcept = default;
    void operator()(Event const& e) { impl_->call(e); }
};
```

```cpp
// Allocation-free erasure: a static vtable + borrowed pointer (a "view").
class HandlerRef {                                  // non-owning, trivially copyable
    void* obj_;
    void (*call_)(void*, Event const&);
public:
    template<class T>
    HandlerRef(T& t) noexcept
        : obj_(std::addressof(t)),
          call_([](void* p, Event const& e) { (*static_cast<T*>(p))(e); }) {}
    void operator()(Event const& e) const { call_(obj_, e); }
};
```

```cpp
// Standard-library erasers
std::function<int(int)>            f = [](int x) { return x; };  // copyable, may allocate
std::move_only_function<int(int)>  g = std::move(f);             // C++23, move-only
std::function_ref<int(int)>        h = lam;                      // C++26, non-owning
std::any                            a = Add{};                   // erased VALUE, needs any_cast
std::shared_ptr<void>               v = std::make_shared<Add>(); // erased deleter
```

| Mechanism | Type set | Storage | Dispatch | Allocates | Main tradeoff |
|---|---|---|---|---|---|
| Virtual base | open at runtime | pointer/reference, ownership separate | vtable indirect call | usually (one per object) | intrusive base; hard ABI commitment |
| Type erasure | open, non-intrusive | owning wrapper (SBO or heap) or borrowed ref | indirect through erased table | policy-dependent | extra indirection; erased capabilities |
| `std::variant` | closed at compile time | inline value, size of largest + tag | `visit` jump table / chained branches | no | recompile everything to add an alternative |
| Template / CRTP | fixed per instantiation | direct value | static, inlinable | no | code size, build time, no runtime type |
| Function pointer + `void*` | open | borrowed | one indirect call | no | manual lifetime, no type safety |

**Decision checklist**
1. Is the implementation set open at runtime (plugins, DLLs) or closed at compile time?
2. Who owns the object, and must it be movable/copyable?
3. Does value locality matter (variant packs inline; `unique_ptr<Base>` chases a pointer)?
4. Is a stable binary ABI required across a library boundary?
5. Is the dispatch target predictable in the *real* traffic mix?
6. What code-size and compile-time budget exists?
7. Does the abstraction allocate or refcount per event?

**Interview line** — "Open set of implementations behind a stable interface ⇒ virtual or type erasure; closed set of value-like alternatives ⇒ `variant`; known at compile time ⇒ template."

**Traps** — `std::variant` is as large as its largest alternative — one fat member bloats every event · `std::visit` on many alternatives can degrade to a chain of branches or an indirect jump table, no faster than a virtual call · `std::function` may heap-allocate and always costs an indirect call plus a possible null check · `std::any` requires the exact type at `any_cast` (no subtyping) · a valueless-by-exception variant throws `bad_variant_access` on `visit`.

---

## 11.10 Devirtualization and hot-path design tradeoffs

```cpp
// What lets a compiler prove the target:
struct S { virtual void f(); virtual ~S() = default; };
struct T final : S { void f() override; };      // (1) final class

void a() { T t; t.f(); }                        // (2) object of known dynamic type, local
void b(T& t) { t.f(); }                         // (3) static type is final
void c(S& s) { s.f(); }                         // opaque without LTO/PGO/whole-program
// (4) -flto / whole-program devirtualization; (5) PGO speculative devirt:
//     if (vptr == &T_vtable) T::f_inlined(); else indirect_call();
// NONE of these is guaranteed by the standard.
```

```cpp
// ---- amortize dispatch: one virtual call per BATCH --------------------
struct Stage {
    virtual void on_batch(std::span<Event const>) noexcept = 0;   // 1 call / N events
    virtual ~Stage() = default;
};
// vs. `virtual void on_event(Event const&)` — N calls, N unpredictable branches.
```

```cpp
// ---- hoist dispatch out of the loop -----------------------------------
void run(Strategy& s, std::span<Event const> evs) {
    for (auto const& e : evs) s.on(e);        // indirect call per event
}
template<class S>
void run_fast(S& s, std::span<Event const> evs) {
    for (auto const& e : evs) s.on(e);        // inlined; instantiate once per S at setup
}
// Configure the concrete type ONCE outside the hot loop; keep the loop monomorphic.
```

```cpp
// ---- closed set: replace dispatch with a tag switch --------------------
enum class Kind : std::uint8_t { Add, Cancel, Execute };
struct Msg { Kind kind; };                 // no vptr, trivially copyable, 1 byte tag
switch (m.kind) {                          // direct branch; predictable if sorted
case Kind::Add:     apply(static_cast<Add const&>(m));     break;
case Kind::Cancel:  apply(static_cast<Cancel const&>(m));  break;
case Kind::Execute: apply(static_cast<Execute const&>(m)); break;
}
```

```cpp
// ---- layout: SoA of concrete types beats a vector of base pointers ----
std::vector<std::unique_ptr<Strategy>> scattered;  // pointer chase + vptr load + indirect
struct Engine {                                    // grouped by type: 3 monomorphic loops
    std::vector<MomentumStrategy> momentum;
    std::vector<MeanRevStrategy>  meanrev;
    void on(Event const& e) {
        for (auto& s : momentum) s.on(e);          // inlined, vectorizable
        for (auto& s : meanrev)  s.on(e);
    }
};
```

| Cost term | Why it can dominate the indirect call |
|---|---|
| Indirect-branch misprediction | ~15–20 cycles when the target alternates unpredictably |
| Two dependent loads (vptr → slot) | serialized latency before the call issues |
| Lost inlining | blocks constant propagation, vectorization, and cross-call optimization |
| Pointer chasing / poor locality | one cache miss (~100+ ns) swamps a 2–5 ns dispatch |
| Heap allocation per polymorphic object | allocator + fragmentation + TLB pressure |
| I-cache pressure from template bloat | the *static* alternative's own hidden cost |
| Work inside the call | if the callee does 500 ns of work, dispatch is noise |

- A virtual call is a handful of cycles; measure before assuming it is your problem.
- Prefer coarse virtual boundaries (per batch, per session, per config) and monomorphic inner loops.
- `final` on the class and on the override is the cheapest hint a compiler can actually act on.
- Templating the whole system to avoid one dispatch trades i-cache and build time for a few cycles — usually a bad deal.
- Benchmark in optimized builds with a representative *type distribution*; a monomorphic microbenchmark devirtualizes and lies.
- Check generated code (`-fopt-info-inline`, `perf annotate`), allocations, working set, and tail latency — not just the mean.

**Interview line** — "I keep virtual boundaries coarse and the inner loop monomorphic; the indirect call is rarely the cost — the cache miss to reach the object is."

**Traps** — `final` guarantees nothing about codegen · speculative devirtualization helps only when one type actually dominates · LTO devirtualization dies at a shared-library boundary (that is the point of a stable ABI) · a `dynamic_cast` per event to recover a type you just erased is pure waste · "zero-cost abstraction" via templates is not zero *code size*.
