# 47. High-frequency interview questions

*Part VIII — Modern C++ evolution and interview drill*

---

**Recall**
- Answer in one fixed order: rule/guarantee → ownership/lifetime → cost → qualification → tiny example.
- Every answer must name a *guarantee*, not a folk belief: "the standard says", "the implementation may", "I measured".
- `std::move` is a cast to xvalue; the selected constructor/assignment does the work.
- Value categories: lvalue = identity, no move; xvalue = identity + movable; prvalue = initializes a value.
- Move operations are implicitly declared only when no copy op, no move op, and no destructor is user-declared.
- Vector reallocation invalidates *everything*; non-reallocating `push_back` invalidates only the old `end()`.
- `reserve` sets capacity, `resize` creates elements — writing into reserved-but-unconstructed space is UB.
- A comparator must be a strict weak ordering; `<=` is not, and NaN breaks `<`.
- `unordered_map` rehash invalidates iterators but **not** references or pointers to elements.
- A base needs a `virtual` destructor exactly when objects are deleted through a pointer to that base.
- Concepts subsume; SFINAE only removes candidates — "more constrained" is a formal relation, not English.
- Exception safety ladder: no-throw > strong > basic > none; `noexcept` violation calls `std::terminate`.
- A data race = two conflicting concurrent accesses, ≥1 write, ≥1 non-atomic, no happens-before → UB.
- Release publishes everything sequenced before it; an acquire that *reads that value* synchronizes with it.
- Relaxed gives atomicity and per-object modification order only — no publication of surrounding writes.
- Lock-free means system-wide progress, not fast, not bounded latency, not allocation-free.
- `bit_cast`/`memcpy` are the legal punning tools; they do not fix endianness, padding, or trap representations.
- False sharing is two hot objects on one cache line; fix by separation/sharding, then measure.
- Hot-path design answers are: single writer, bounded pool, indices with generations, pre-reserved capacity.
- A benchmark without observable work, representative inputs, a distribution, and a recorded environment proves nothing.

**The sixty-second frame**

```text
1 rule/guarantee     what the language or library actually specifies
2 ownership/lifetime who owns it; what may dangle or be invalidated
3 cost               complexity, allocation, contention, cache behavior
4 qualification      implementation detail, precondition, exception, UB
5 example            three lines proving you can apply the rule
```

| If asked about… | State first |
|---|---|
| `vector` | Contiguous ownership, size vs capacity, invalidation |
| move | Value-category cast vs the selected move operation |
| atomics | The invariant and the happens-before edge, then the order |
| lock-free | Progress property plus lifetime/reclamation |
| performance | Workload, metric, platform, evidence |
| wire data | Bounds, ownership, representation, endian, errors |
| polymorphism | Open or closed type set, ownership, dispatch frequency |

---

## 47.1 What exactly happens during compilation and linking?

**Answer** — The preprocessor forms a translation unit from one source file plus its includes; the compiler parses, does semantic analysis, instantiates templates, optimizes under the as-if rule, and emits an object file of code, symbols, and relocations; the linker resolves those symbols across objects and libraries into an image, and the loader maps it and runs dynamic initialization before `main`. So "compiles but does not link" almost always means a missing or mismatched *definition*, or an omitted library.

```cpp
// ---- declaration vs definition ---------------------------------------
extern int g;                 // declaration: names the entity
int g = 1;                    // definition: allocates storage (exactly one in program)
void f();                     // declaration
void f() {}                   // definition
struct S;                     // incomplete type declaration
struct S { int x; };          // class definition — may repeat per TU under ODR
inline int h() { return 1; }  // one definition PER TU, all must be token-identical
inline int counter = 0;       // C++17 inline variable — one entity, many TUs
constexpr int k = 3;          // implicitly internal-linkage const at namespace scope
static void tu_local();       // internal linkage: no other TU can name it
namespace { struct Local {}; }// unnamed namespace: internal linkage, unique name
```

```cpp
// ---- templates: implicit vs explicit instantiation ---------------------
template<class T> T twice(T v) { return v + v; }
template int twice<int>(int);              // explicit instantiation DEFINITION
extern template int twice<long>(long);     // suppress implicit instantiation here
// Templates are normally defined in headers because instantiation needs the body.
```

```cpp
// ---- C++20 modules (link-visible interface without textual include) ----
export module book;                        // module interface unit
export int best_bid();                     // exported name
module :private;                           // private fragment: not visible to importers
```

```bash
g++ -std=c++23 -c a.cpp -o a.o          # compile only: TU -> object
nm -C a.o | grep ' U '                  # undefined symbols this object needs
g++ a.o b.o -lpthread -o app            # link (libraries AFTER the objects that need them)
ldd ./app                               # dynamic dependencies resolved by the loader
c++filt _Z5twiceIiET_S0_                # demangle
g++ -flto -fvisibility=hidden ...       # LTO + hidden visibility: enables devirtualization
```

| Failure | Real cause |
|---|---|
| `undefined reference to f()` | Declared, never defined, or defined in an unlinked object/library |
| `multiple definition of g` | Non-inline definition in a header included twice |
| Link OK, crashes at startup | ODR/ABI mismatch: different flags, `-D`, or struct layout per TU |
| Missing template symbol | Template defined in a `.cpp`, used from another TU |
| Static init order crash | Cross-TU dependency between namespace-scope objects |

**Traps** — `inline` is an ODR facility, not an inlining request · library order matters for static archives · different `-D`/`-std`/`NDEBUG` across TUs is a silent ODR violation, not a build style choice · static init order across TUs is unspecified (use a function-local `static`).

---

## 47.2 What is an lvalue/rvalue, and when does a temporary die?

**Answer** — An lvalue has identity and is not movable-from, a prvalue has no identity and initializes an object, and an xvalue has identity and is expiring; rvalue means prvalue-or-xvalue. A temporary is destroyed at the end of the full-expression unless a reference binds directly to it, which extends its lifetime to that reference's — non-transitively, and never across a `return`.

```text
          identity?  movable-from?
lvalue       yes         no        named variable, *p, a[i], function returning T&
xvalue       yes         yes       std::move(x), a[i] on rvalue array, T&& return
prvalue      no          yes       42, T{}, f() returning by value, lambda expression
glvalue = lvalue | xvalue      rvalue = prvalue | xvalue
```

```cpp
Order make_order();
Order  o  = make_order();      // prvalue directly initializes o — guaranteed elision (C++17)
Order&& rr = std::move(o);     // std::move(o) is an xvalue; o is still alive and named
Order&  lr = o;                // lvalue reference
auto&&  u  = make_order();     // forwarding/universal: binds prvalue, lifetime EXTENDED
// rr is an LVALUE expression: pass std::move(rr) to move again
consume(std::move(rr));
```

```cpp
// ---- lifetime extension: what works and what does not ------------------
std::string const& a = std::string{"x"};      // OK: extended to a's scope
std::string const& b = f().member;            // OK: binding to a member subobject
std::string const& c = id(std::string{"x"});  // DANGLES: extension not transitive through a call
std::string const& d(std::string{"x"});       // OK, same as a

std::string_view bad() { return std::string{"ABC"}; } // DANGLES at the return expression
auto&& e = v.front();                                  // no temporary; no extension needed
for (char ch : make_string()) {}                       // OK since C++23 range-for temporaries
```

```cpp
// ---- decltype tells you the category ----------------------------------
int  x = 0; int* p = &x;
static_assert(std::is_same_v<decltype(x),    int>);    // declared type of the entity
static_assert(std::is_same_v<decltype((x)),  int&>);   // lvalue expression   -> T&
static_assert(std::is_same_v<decltype(*p),   int&>);   // lvalue
static_assert(std::is_same_v<decltype(x+1),  int>);    // prvalue             -> T
static_assert(std::is_same_v<decltype(std::move(x)), int&&>); // xvalue       -> T&&
```

| Binding | lvalue | const lvalue | prvalue | xvalue |
|---|---|---|---|---|
| `T&` | yes | no | no | no |
| `T const&` | yes | yes | yes (extends) | yes (extends) |
| `T&&` | no | no | yes (extends) | yes |
| `auto&&` / `T&&` template | yes | yes | yes | yes |

**Traps** — a named `T&&` variable is an lvalue · extension does not survive a function return or a passthrough call · `string_view`/`span` bound to a temporary dangle at the semicolon · `const auto& = f().begin()` extends nothing.

---

## 47.3 Why does `std::move` not move anything?

**Answer** — `std::move(x)` is an unconditional cast to `T&&`; it only changes overload resolution so that a move constructor or move assignment is selected, and *that* operation does the transfer. If the type has no move operation, or the argument is `const`, the copy is selected silently and you pay a copy.

```cpp
template<class T>                                    // exactly what std::move is
constexpr std::remove_reference_t<T>&& move(T&& t) noexcept {
    return static_cast<std::remove_reference_t<T>&&>(t);
}
template<class T>                                    // forward: conditional cast
constexpr T&& forward(std::remove_reference_t<T>& t) noexcept {
    return static_cast<T&&>(t);
}
```

```cpp
std::string a = "feed";
std::string b = std::move(a);          // string's MOVE ctor runs: steals the buffer
// a is valid but unspecified: a.size() may be anything; a.clear() is fine

std::string const cs = "x";
std::string d = std::move(cs);         // const string&& -> binds to const&: COPY, silently

int i = 5, j = std::move(i);           // scalar: just a copy; i unchanged
std::array<int,1024> arr, brr = std::move(arr);  // O(N) element-wise move

template<class... A> void relay(A&&... a) {
    sink(std::forward<A>(a)...);       // preserve category; std::move here would be a bug
}
auto lam = [v = std::move(vec)]() mutable { v.clear(); };  // move-capture (C++14)
```

```cpp
// ---- return statements -------------------------------------------------
Big f() { Big local; return local; }             // NRVO permitted; else implicit move
Big g() { Big local; return std::move(local); }  // BAD: blocks NRVO, forces a move
Big h(Big param) { return param; }               // implicit move from parameter — correct
Big& bad() { Big local; return std::move(local); } // dangling reference
```

| Situation | What actually happens |
|---|---|
| `T` has `noexcept` move | Move selected; vector relocation uses it |
| `T` move can throw | `move_if_noexcept` picks the **copy** during reallocation |
| `const T` | `T&&` cannot bind after dropping const → copy |
| Type has only a copy ctor | Copy; no diagnostic |
| Moved-from standard type | Valid but unspecified (except `unique_ptr` → null, `shared_ptr` → empty) |

**Traps** — `std::move` on a `const` object is a silent pessimization · `std::move` in a return statement kills NRVO · using an object after move is legal but only for operations without preconditions · `std::forward` without an explicit template argument is a bug.

---

## 47.4 When are special members generated or deleted?

**Answer** — The six are default ctor, destructor, copy ctor, copy assign, move ctor, move assign; copies are implicitly declared unless a base or member cannot copy, and moves are implicitly declared *only* if the user declared no copy operation, no other move operation, and no destructor. That is why writing a destructor silently turns your class into a copy-only type, and why Rule of Zero — compose RAII members and declare none of the six — is the default answer.

```cpp
struct Owner { std::unique_ptr<int> p; };          // Rule of Zero
static_assert(!std::copy_constructible<Owner>);    // deleted: member is move-only
static_assert(std::movable<Owner>);                // implicitly moved

struct Trap {
    ~Trap() {}                                     // user-declared dtor
    std::vector<int> v;
};                                                 // moves NOT declared -> every "move" copies
static_assert(std::is_copy_constructible_v<Trap>); // deprecated-but-generated copy

struct Five {                                      // Rule of Five: only for direct resources
    Five() noexcept = default;
    ~Five();
    Five(Five const&);
    Five& operator=(Five const&);
    Five(Five&&) noexcept;
    Five& operator=(Five&&) noexcept;
};

struct NoCopy {
    NoCopy(NoCopy const&) = delete;                // deleted: still participates in overload res.
    NoCopy& operator=(NoCopy const&) = delete;
    NoCopy(NoCopy&&) = default;                    // must be re-declared: copy decl suppressed moves
    NoCopy& operator=(NoCopy&&) = default;
};

struct Agg { int a; double b; };                   // aggregate: all six implicit
Agg x{1, 2.0};                                     // aggregate init
struct Explicit { explicit Explicit(int); };       // no implicit conversion
struct Cmp { int a; auto operator<=>(Cmp const&) const = default; }; // C++20 defaulted comparison
```

| Member | Implicitly declared when… | Defined as deleted when… |
|---|---|---|
| Default ctor | No user-declared *constructor* | A member/base has no default ctor, or is a reference/const without initializer |
| Destructor | Always | A member/base destructor is deleted or inaccessible |
| Copy ctor | Always (deprecated if user dtor or copy-assign) | A member/base is non-copyable |
| Copy assign | Always (same deprecation) | Member is const, a reference, or non-copy-assignable |
| Move ctor | **No** user copy ctor/assign, move assign, or dtor | Member/base non-movable and non-copyable |
| Move assign | Same condition | Member is const, a reference, or non-move-assignable |

```cpp
// ---- diagnose it, do not guess -----------------------------------------
static_assert(std::is_nothrow_move_constructible_v<T>);  // vector relocation depends on this
static_assert(std::is_trivially_copyable_v<T>);          // memcpy/bit_cast legality
static_assert(std::default_initializable<T> && std::movable<T>);
```

**Traps** — declaring a destructor (even `= default` in the class body) suppresses implicit moves · `= default` can still yield a deleted function · `= delete` members are declared and can be *chosen*, then error · a `const` member disables move assignment · defaulting the destructor in the `.cpp` is how you make PIMPL with `unique_ptr` compile.

---

## 47.5 What is the difference between `push_back` and `emplace_back`?

**Answer** — `push_back` takes a `T` (copying or moving an existing object), while `emplace_back` perfect-forwards constructor arguments to build the element directly in storage. Both can reallocate and invalidate everything, `emplace_back` is not universally faster, and it will silently use `explicit` constructors that `push_back` would reject.

```cpp
struct Order { Order(std::uint64_t id, int qty); explicit Order(std::uint64_t id); };
std::vector<Order> orders;

orders.push_back(Order{id, qty});   // build temporary, then MOVE into storage
orders.emplace_back(id, qty);       // construct in place from the arguments
Order v{id, qty};
orders.push_back(v);                // copy — clearest when the object exists
orders.push_back(std::move(v));     // move — clearest intent
orders.emplace_back(id);            // uses the EXPLICIT ctor: push_back would not compile

Order& ref = orders.emplace_back(id, qty);   // returns T& since C++17
orders.emplace_back(id, qty);                // ref may now DANGLE (possible reallocation)

std::vector<std::vector<int>> m;
m.emplace_back(4);                  // vector<int>(4): four zeros — NOT one element 4
m.push_back({4});                   // one element equal to 4
```

| Call | Argument | Constructs | Returns | Realloc risk |
|---|---|---|---|---|
| `push_back(const T&)` | existing `T` | copy | `void` | yes |
| `push_back(T&&)` | rvalue `T` | move | `void` | yes |
| `emplace_back(Args&&...)` | ctor args | in place | `T&` (C++17) | yes |
| `emplace(pos, Args&&...)` | ctor args | in place at `pos` | iterator | yes |
| `append_range(R&&)` | range | element-wise | `void` (C++23) | yes |

```cpp
// Strong-guarantee cost: reallocation copies unless the move is noexcept.
struct Rec { Rec(Rec const&); Rec(Rec&&) noexcept; };  // noexcept -> relocation moves
```

**Traps** — `emplace_back` does not avoid reallocation · it bypasses `explicit` and can pick a surprising ctor · the returned `T&` is invalid after the next growth · `emplace_back(n)` on a container of containers means "n elements", not "value n" · neither is exception-safe to hold references across.

---

## 47.6 When does `vector` invalidate pointers, references, and iterators?

**Answer** — Any operation that reallocates invalidates every iterator, pointer, and reference into the vector; without reallocation, insertion invalidates from the insertion point onward plus the old `end()`, and erase invalidates from the erased position onward. `reserve` changes capacity only, so indexing into reserved-but-unconstructed space is UB.

| Operation | If it reallocates | If it does not |
|---|---|---|
| `reserve(n)` / `shrink_to_fit()` | all iterators, pointers, references | nothing |
| `push_back` / `emplace_back` / `append_range` | all | only the old `end()` |
| `insert`/`emplace`/`insert_range` at `pos` | all | at and after `pos`, incl. old `end()` |
| `erase(pos)` / `erase(f,l)` | n/a (never reallocates) | at and after `pos`, incl. old `end()` |
| `resize` larger | all | existing survive; `end()` moves |
| `resize` smaller | n/a | at and after the new end |
| `clear()` | n/a | all elements; **capacity retained** |
| `swap` / move-assign | n/a | iterators follow the *storage*, not the object |

```cpp
std::vector<Order> v;
v.reserve(8);            // capacity >= 8, size still 0
// v[0] = order;         // UB: no object lives there
v.push_back(order);      // now v[0] exists
v.resize(4);             // size 4: value-initialized elements
v.clear();               // destroys elements; capacity kept

// ---- the classic dangling bug -----------------------------------------
Order* p = &v.front();
v.push_back(x);          // may reallocate
use(*p);                 // UB

// ---- the quadratic reserve anti-pattern -------------------------------
for (auto const& x : in) { out.reserve(out.size() + 1); out.push_back(x); }  // O(n^2)
out.reserve(out.size() + in.size());                                          // O(n)
out.insert(out.end(), in.begin(), in.end());

// ---- self-referencing insert ------------------------------------------
v.push_back(v[0]);       // OK: the standard requires this to work
v.insert(v.end(), v.begin(), v.end()); // NOT required to work if it reallocates
```

```cpp
// ---- stable alternatives ----------------------------------------------
std::size_t idx = 3;                        // index survives growth
struct Handle { std::uint32_t slot, generation; };  // pool handle detects reuse
std::deque<Order> d;                        // end insertion keeps REFERENCES valid
std::vector<std::unique_ptr<Order>> owned;  // pointee addresses stable, one alloc each
```

**Traps** — `capacity()` growth factor is unspecified · `shrink_to_fit` is non-binding and may allocate · `clear()` does not free memory (`vector<T>{}.swap(v)` or `= {}` + `shrink_to_fit` does) · `erase` never reallocates so it never invalidates *before* the erase point · `data()` on an empty vector may be null.

---

## 47.7 Why must a comparator be a strict weak ordering?

**Answer** — Ordered containers and sorting algorithms have a *precondition* that `comp` be irreflexive, asymmetric, transitive, and have transitive incomparability; violating it is undefined behavior, and in practice `std::sort` will run off the end of the range and corrupt memory. Equivalence is defined as `!comp(a,b) && !comp(b,a)`, not by `operator==`.

```text
irreflexive          comp(a,a) == false
asymmetric           comp(a,b) implies !comp(b,a)          (follows from the above + transitivity)
transitive           comp(a,b) && comp(b,c) implies comp(a,c)
transitive equiv.    equiv(a,b) && equiv(b,c) implies equiv(a,c)
equiv(a,b)  :=  !comp(a,b) && !comp(b,a)
```

```cpp
struct Bad { bool operator()(double a, double b) const { return a <= b; } }; // NOT irreflexive -> UB
struct Good { bool operator()(double a, double b) const { return a <  b; } };

// NaN breaks it: comp(NaN,x) and comp(x,NaN) are both false, but NaN is not
// equivalent to every x -> incomparability is not transitive.
struct SafeDouble {
    bool operator()(double a, double b) const noexcept {
        assert(!std::isnan(a) && !std::isnan(b));   // reject at the boundary
        return a < b;
    }
};
struct TotalDouble {                                 // or use the total order (C++20)
    bool operator()(double a, double b) const noexcept {
        return std::strong_order(a, b) < 0;
    }
};
```

```cpp
// ---- multi-key ordering: tie-break, never compare independently --------
struct Key { std::int64_t price; std::uint64_t seq; };
auto by_price_then_seq = [](Key const& a, Key const& b) noexcept {
    return std::tie(a.price, a.seq) < std::tie(b.price, b.seq);   // correct
};
auto also_ok = [](Key const& a, Key const& b) noexcept {
    if (a.price != b.price) return a.price < b.price;
    return a.seq < b.seq;
};
// Wrong: `return a.price < b.price || a.seq < b.seq;`  — not transitive.

std::ranges::sort(keys, by_price_then_seq);
std::ranges::sort(keys, {}, &Key::price);     // projection form: comp defaults to less
std::map<Key, Level, decltype(by_price_then_seq)> book{by_price_then_seq};
std::set<int, std::greater<>> desc;           // transparent comparator: heterogeneous find
```

| Facility | Needs | Equivalence used |
|---|---|---|
| `sort` / `nth_element` / `partial_sort` | strict weak order | `!comp&&!comp` |
| `stable_sort` | strict weak order | preserves input order within equivalence |
| `lower_bound`/`upper_bound`/`binary_search` | range *partitioned* w.r.t. comp | `!comp&&!comp` |
| `map`/`set` | strict weak order | `!comp&&!comp` — **not** `operator==` |
| `unordered_map` | hash + `operator==` consistency | `==` |
| `priority_queue` | strict weak order | top = greatest under comp |

**Traps** — a comparator reading mutable external state corrupts an existing tree · `operator<=` and "sort descending with `>=`" are the two classic UB comparators · `map` keys that compare equivalent are the *same* key even if `!=` · a comparator must be `const`-callable and should be `noexcept` · `std::less<T*>` is the only guaranteed total order over unrelated pointers.

---

## 47.8 How does `unordered_map` rehashing affect latency and validity?

**Answer** — Lookup and insert are average O(1) but worst-case O(N), and an insert that pushes the load factor past `max_load_factor()` rehashes: it allocates a new bucket array and relinks every element, producing a latency spike. Rehashing invalidates all iterators but **not** references or pointers to elements, because the nodes themselves are not moved.

```cpp
std::unordered_map<std::uint64_t, Order> m;
m.reserve(1'000'000);            // plan for ELEMENTS (does rehash(ceil(n / max_load_factor)))
m.rehash(2'097'152);             // request BUCKETS
m.max_load_factor(0.5f);         // fewer collisions, more memory
m.load_factor();                 // size() / bucket_count()
m.bucket_count(); m.bucket(key); m.bucket_size(0);

auto [it, inserted] = m.try_emplace(id, args...);   // C++17: no construction if present
m.insert_or_assign(id, value);                      // C++17
auto node = m.extract(id);                          // C++17: move a node between maps
node.key() = new_id; m.insert(std::move(node));     // rekey without reallocating the node
std::erase_if(m, [](auto const& kv){ return kv.second.dead; });  // C++20

// C++20 heterogeneous lookup: needs a transparent hash AND equal
struct SvHash { using is_transparent = void;
    std::size_t operator()(std::string_view s) const noexcept {
        return std::hash<std::string_view>{}(s); } };
std::unordered_map<std::string, int, SvHash, std::equal_to<>> byname;
byname.find(std::string_view{"AAPL"});   // no temporary std::string
```

| Operation | Average | Worst | Invalidates iterators | Invalidates refs/pointers |
|---|---:|---:|---|---|
| `find` / `count` / `contains` | O(1) | O(N) | no | no |
| `insert` / `emplace` / `try_emplace` | O(1) | O(N) | **only if rehash** | no |
| `erase(key)` / `erase(it)` | O(1) | O(N) | only to erased | only to erased |
| `rehash(n)` / `reserve(n)` | O(N) | O(N²) hashing worst | **all** | no |
| `clear()` | O(N) | O(N) | all | all |
| Iteration | O(bucket_count + size) | | | |

```cpp
// ---- hash/equality contract -------------------------------------------
struct Sym { std::array<char,8> b; bool operator==(Sym const&) const = default; };
template<> struct std::hash<Sym> {
    std::size_t operator()(Sym const& s) const noexcept {
        return std::hash<std::string_view>{}({s.b.data(), s.b.size()});
    }
};   // equal keys MUST hash equal; unequal keys MAY collide
```

**Traps** — iteration order is unspecified and unstable, never use it for deterministic replay · `std::unordered_map` is node-based: one allocation per element, poor locality — prefer an open-addressed flat map on hot paths · a weak hash turns O(1) into O(N) and is an attack surface · `operator[]` default-constructs on lookup miss · `reserve` takes elements, `rehash` takes buckets.

---

## 47.9 What is object slicing, and when is a virtual destructor required?

**Answer** — Slicing happens when a derived object is copied into a base *object*: only the base subobject is copied, the derived state and the dynamic type are lost. A base destructor must be `virtual` whenever an object may be deleted through a pointer to that base — otherwise it is undefined behavior — and if polymorphic deletion is not intended, make the base destructor `protected` and non-virtual.

```cpp
struct Base { virtual void on(); virtual ~Base() = default; };
struct Derived : Base { void on() override; int state{}; };

void take_value(Base b);          // by value: SLICES
void take_ref(Base& b);           // polymorphic
void take_ptr(Base* b);           // polymorphic

Derived d;
take_value(d);                    // only the Base subobject copied; d.state lost
Base b = d;                       // slicing copy
b = d;                            // slicing assignment
std::vector<Base> vs; vs.push_back(d);   // slices every element
std::vector<std::unique_ptr<Base>> vp;   // correct: ownership + polymorphism
```

```cpp
// ---- deletion through a base ------------------------------------------
struct Iface { virtual ~Iface() = default; virtual void on() = 0; };  // public virtual dtor
std::unique_ptr<Iface> p = std::make_unique<Impl>();   // OK: virtual dtor dispatches

struct Policy { protected: ~Policy() = default; };      // non-deletable base, no vtable cost
// delete static_cast<Policy*>(p);                      // ill-formed: dtor inaccessible

// shared_ptr is the exception: it captures the deleter from the constructor
std::shared_ptr<void> anyp = std::make_shared<Impl>();  // Impl's dtor still runs
```

```cpp
// ---- prevent slicing structurally --------------------------------------
struct NoSlice { protected: NoSlice(NoSlice const&) = default;
                            NoSlice& operator=(NoSlice const&) = default; };
struct Final final : Base { void on() override; };       // final: enables devirtualization
using Msg = std::variant<NewOrder, Cancel, Trade>;       // closed set: value semantics, no slicing
```

| Design | Destructor | Copy/assign |
|---|---|---|
| Public polymorphic interface | `public virtual ~B() = default;` | usually deleted or protected |
| Non-deletable base / mixin | `protected ~B() = default;` (non-virtual) | protected |
| Value type in a container | non-virtual | public |
| `final` leaf | non-virtual is fine if base is virtual | public |

**Traps** — a virtual function does not make the destructor virtual · `delete` through a base without a virtual destructor is UB even when the derived has a trivial destructor · slicing is silent and compiles cleanly · assignment slices too, not just construction · a virtual destructor adds a vtable pointer and blocks trivial copyability.

---

## 47.10 What are SFINAE, concepts, and overload-resolution ordering?

**Answer** — SFINAE means a substitution failure in the immediate context removes a candidate from the overload set instead of being an error; concepts express the same requirements declaratively and additionally participate in *subsumption*, so a more-constrained overload wins over a less-constrained one. Overload resolution still runs in fixed order: gather candidates, discard non-viable ones, rank conversion sequences, and only then use template/non-template and constraint tie-breakers.

```cpp
// ---- every requires form -----------------------------------------------
template<class T>
concept HasTicks = requires(T const& x) {
    x.ticks();                           // simple requirement: expression is valid
    { x.ticks() } -> std::integral;      // compound: valid + result models the concept
    { x.reset() } noexcept;              // compound: expression must be noexcept
    typename T::tick_type;               // type requirement
    requires sizeof(T) <= 64;            // nested requirement: a bool constant-expression
};
template<class T> concept Num = std::integral<T> || std::floating_point<T>;  // disjunction
template<class T> concept SmallNum = Num<T> && (sizeof(T) <= 4);             // conjunction/subsumes Num
```

```cpp
// ---- every way to apply a constraint -----------------------------------
template<HasTicks T> void a(T const&);                   // type-constraint on the parameter
void b(HasTicks auto const&);                            // abbreviated template
template<class T> requires HasTicks<T> void c(T const&); // requires-clause
template<class T> void d(T const&) requires HasTicks<T>; // trailing requires-clause
template<class T> requires requires(T x){ x.ticks(); }   // ad-hoc requires-expression
void e(T);
auto f = []<HasTicks T>(T const& x){};                   // constrained lambda (C++20)
static_assert(HasTicks<Clock>);                          // concepts are bool constant-expressions
if constexpr (HasTicks<T>) { /* ... */ }                 // usable in constant conditions
```

```cpp
// ---- pre-C++20 SFINAE spellings (still seen in interviews) --------------
template<class T, class = std::enable_if_t<std::is_integral_v<T>>> void g(T);
template<class T> std::enable_if_t<std::is_integral_v<T>, void> h(T);
template<class T> auto k(T t) -> decltype(t.ticks(), void());   // expression SFINAE
template<class T> void m(T) noexcept(noexcept(T{}.ticks()));    // noexcept-spec SFINAE
// tag dispatch: no SFINAE at all, just overload on a tag type
template<class T> void n(T, std::true_type); template<class T> void n(T, std::false_type);
```

```cpp
// ---- ordering demonstrated ---------------------------------------------
void enc(std::integral auto x);          // #1
void enc(SmallNum auto x);               // #2  subsumes Num, more constrained
void enc(int x);                         // #3  non-template
enc(1);        // #3 wins: non-template beats template with equal conversion sequence
enc(short{1}); // #2 wins over #1 only if #2's constraints subsume #1's
```

| Stage | Rule |
|---|---|
| 1 Name lookup | ADL + ordinary lookup build the candidate set |
| 2 Deduction/substitution | Failure in the *immediate context* removes the candidate (SFINAE); a hard error inside a body is still an error |
| 3 Constraint check | Unsatisfied constraints make the candidate non-viable |
| 4 Ranking | Exact > promotion > standard conversion > user-defined > ellipsis |
| 5 Tie-breakers | Non-template > more specialized template > more constrained (subsumption) |

**Traps** — subsumption only works through *named* concepts and atomic constraints, not `enable_if` or type traits inside `requires` · `requires requires` is legal and means "ad-hoc requirement" · a `requires` expression only checks that the expression *compiles*, never that it is semantically correct · errors outside the immediate context are hard errors, not SFINAE · a concept cannot prove a comparator is a strict weak ordering.

---

## 47.11 What is RAII, and how does it interact with exceptions?

**Answer** — RAII binds a resource's lifetime to an object's: acquisition establishes the invariant in the constructor, release happens in the destructor, so any exit path — return, `break`, or a thrown exception unwinding the stack — releases it exactly once. A constructor that throws never creates the object, so its destructor never runs, but every fully constructed base and member is destroyed.

```cpp
{
    std::lock_guard lock{mtx};          // acquire; releases on any exit
    update();                           // throw -> unwind -> ~lock_guard() -> unlock
}
std::unique_lock ul{mtx, std::defer_lock};   // movable, deferred, supports condition_variable
std::scoped_lock sl{m1, m2};                 // C++17: deadlock-avoiding multi-lock
std::shared_lock rl{rw};                     // reader lock
```

```cpp
// ---- a general scope guard ---------------------------------------------
template<class F>
class ScopeExit {
    F f_; bool active_{true};
public:
    explicit ScopeExit(F f) noexcept : f_(std::move(f)) {}
    ~ScopeExit() noexcept { if (active_) f_(); }         // must not throw
    void release() noexcept { active_ = false; }         // commit: cancel rollback
    ScopeExit(ScopeExit&& o) noexcept : f_(std::move(o.f_)), active_(std::exchange(o.active_,false)) {}
    ScopeExit(ScopeExit const&) = delete;
};
void insert(Book& b, Order const& o) {
    b.index.emplace(o.id, o);
    ScopeExit rollback{[&]{ b.index.erase(o.id); }};     // undo if the next step throws
    b.levels.attach(o);                                  // may throw
    rollback.release();                                  // commit
}
```

```cpp
// ---- constructor failure ------------------------------------------------
struct Session {
    std::unique_ptr<Socket> sock;    // constructed first
    Buffer buf;                      // if Buffer's ctor throws, ~unique_ptr runs, ~Session does NOT
    Session() : sock{connect()}, buf{4096} {}
};

// ---- destructors during unwinding ---------------------------------------
struct Closer {
    ~Closer() noexcept {                              // destructors are noexcept by default
        try { flush(); } catch (...) { log(); }       // swallow: escaping here calls std::terminate
    }
};
int n = std::uncaught_exceptions();   // C++17: >0 means we are unwinding
```

| Resource | RAII type |
|---|---|
| Heap object | `unique_ptr` / `shared_ptr` / container |
| Mutex | `lock_guard` / `unique_lock` / `scoped_lock` / `shared_lock` |
| File / fd / socket | `fstream`, or a custom handle with a `close` destructor |
| Thread | `std::jthread` (C++20: joins and requests stop in its destructor) |
| Arbitrary rollback | scope guard as above |
| Elapsed-time / counter | timer object recording in its destructor |

**Traps** — an exception escaping a destructor while another is in flight calls `std::terminate` · `abort`, `_Exit`, `quick_exit`, and a `noexcept` violation skip stack unwinding entirely · `std::lock_guard lock{mtx};` vs `std::lock_guard{mtx};` — the latter is a temporary destroyed immediately · a `throw` in a ctor initializer list needs a function-try-block to observe · RAII is about *all* resources, not only memory.

---

## 47.12 What are the exception-safety guarantees?

**Answer** — Four levels: no-throw (the operation cannot fail), strong (failure leaves observable state unchanged, transactionally), basic (invariants and resources hold but state may have changed), and none. The standard idiom for the strong guarantee is build-then-commit: do all throwing work on a copy, then swap it in with a non-throwing operation.

| Guarantee | Meaning | Typical example |
|---|---|---|
| No-throw (`noexcept`) | Never emits an exception | `swap`, destructors, move ops, `size()` |
| Strong | Failure has no observable effect | `vector::push_back`, build-then-commit |
| Basic | Invariants intact, state unspecified | `vector::insert` on a throwing move type |
| None | No promise beyond the language's | Hand-rolled half-updated state |

```cpp
// ---- build-then-commit ---------------------------------------------------
void apply(Book& current, Update const& u) {
    Book candidate = current;      // may throw: harmless, nothing committed
    mutate(candidate, u);          // may throw: harmless
    swap(current, candidate);      // MUST be noexcept — this is the commit point
}                                  // ~candidate frees the old state

// ---- copy-and-swap assignment -------------------------------------------
Book& Book::operator=(Book other) noexcept {   // by value: copy/move happens in the caller
    swap(*this, other);                        // noexcept commit
    return *this;
}
```

```cpp
// ---- noexcept in every form ---------------------------------------------
void a() noexcept;                       // promise: violation -> std::terminate
void b() noexcept(true);                 // same
void c() noexcept(false);                // may throw (the default for non-dtors)
template<class T> void d(T t) noexcept(std::is_nothrow_move_constructible_v<T>); // conditional
static_assert(noexcept(a()));            // noexcept OPERATOR: compile-time query
// A noexcept violation calls std::terminate; it does NOT necessarily unwind first.
```

```cpp
// ---- errors without exceptions (hot path) -------------------------------
std::expected<std::int64_t, ParseError> parse(std::string_view) noexcept;  // C++23
if (auto r = parse(text); r) use(*r); else handle(r.error());
std::optional<Level> find_level(std::int64_t px) noexcept;
auto [ptr, ec] = std::from_chars(b, e, value);   // never throws, never allocates
if (ec != std::errc{}) { /* ... */ }
try { risky(); }
catch (std::bad_alloc const&) { throw; }         // rethrow preserves the object
catch (std::exception const& e) { log(e.what()); }
catch (...) { auto p = std::current_exception(); std::rethrow_exception(p); }
```

**Traps** — `noexcept` on a move constructor is what lets `vector` relocate by moving instead of copying · marking `noexcept` optimistically converts an exception into `std::terminate` · the strong guarantee usually costs a full copy, often unacceptable on a hot path · a `catch (std::exception e)` by value slices · `throw;` rethrows, `throw e;` copies and slices.

---

## 47.13 What is strict aliasing, and when is `memcpy` valid?

**Answer** — An object's stored value may only be accessed through a glvalue of a type compatible with its dynamic type, or through `char`, `unsigned char`, or `std::byte`; reinterpreting a pointer to an unrelated type and dereferencing it is UB, which optimizers actively exploit. The legal punning tools are `std::bit_cast` for equal-sized trivially copyable types and `memcpy` into an object of the destination type — neither fixes endianness, padding, or invalid representations.

```cpp
// ---- the three legal spellings ------------------------------------------
float f = 1.0F;
auto bits = std::bit_cast<std::uint32_t>(f);          // C++20: constexpr, sizes must match,
                                                       // both trivially copyable
std::uint32_t u; std::memcpy(&u, &f, sizeof u);        // always valid, optimizes to a move
auto const* bytes = reinterpret_cast<std::byte const*>(&f);  // byte inspection is allowed
std::uint32_t v = std::bit_cast<std::uint32_t>(std::array<std::byte,4>{...}); // from bytes

// ---- what is UB ----------------------------------------------------------
std::uint32_t bad = *reinterpret_cast<std::uint32_t*>(&f);   // strict-aliasing UB
auto* h = reinterpret_cast<Header*>(buffer + 1);             // + alignment UB, + no object there
union Pun { float f; std::uint32_t u; };                     // legal in C, UB-ish in C++
```

```cpp
// ---- parsing a wire message correctly ------------------------------------
struct Header { std::uint32_t len; std::uint16_t type; };      // may contain padding

std::optional<Header> read_header(std::span<std::byte const> in) noexcept {
    if (in.size() < 6) return std::nullopt;                    // 1. bounds first
    Header h{};
    std::uint32_t len_be{}; std::uint16_t typ_be{};
    std::memcpy(&len_be, in.data(),     4);                    // 2. copy, never cast
    std::memcpy(&typ_be, in.data() + 4, 2);
    h.len  = std::byteorder_swap(len_be);                       // 3. explicit endian step
    h.type = std::byteorder_swap(typ_be);
    return h;
}
// C++20/23 endian tools:
static_assert(std::endian::native == std::endian::little);      // <bit>
std::uint32_t be = std::byteswap(le);                           // C++23 <bit>
```

```cpp
// ---- lifetime: creating an object in raw storage --------------------------
alignas(Header) std::byte storage[sizeof(Header)];
auto* p = new (storage) Header{};              // placement new starts the lifetime
std::destroy_at(p);                            // ends it
auto* q = std::start_lifetime_as<Header>(raw); // C++23: implicit-lifetime type in received bytes
auto* r = std::launder(reinterpret_cast<Header*>(storage));   // C++17: refresh after reuse
```

| Tool | Requires | Gives |
|---|---|---|
| `std::bit_cast<To>(from)` | equal `sizeof`, both trivially copyable | new object of `To`, `constexpr` |
| `std::memcpy` | trivially copyable, non-overlapping, live storage | copied representation |
| `char`/`unsigned char`/`std::byte*` | nothing | legal inspection of representation |
| `std::start_lifetime_as<T>` (C++23) | implicit-lifetime `T`, suitable alignment | a live `T` over existing bytes |
| `std::launder` (C++17) | an object actually exists there | a usable pointer after storage reuse |
| `reinterpret_cast` + deref | — | **UB** for unrelated types |

**Traps** — padding bytes are unspecified, so `memcmp` on structs is not equality · misaligned access is UB even on x86 where it "works" · `-fno-strict-aliasing` is a local workaround, not portability · a `memcpy` of a valid `float` into a `uint32_t` is fine, the reverse can produce a signaling NaN · `bit_cast` fails to compile if the sizes differ, which is the feature.

---

## 47.14 What is false sharing, and how do you detect/avoid it?

**Answer** — False sharing is two logically independent objects landing on the same cache line: a write by one core invalidates the line in every other core's cache, so unrelated threads generate full coherence traffic and lose an order of magnitude. Fix it by padding or aligning hot mutable fields to `std::hardware_destructive_interference_size`, or better, by sharding so threads write to their own memory at all.

```cpp
#include <new>
// ---- padded counter ------------------------------------------------------
struct alignas(std::hardware_destructive_interference_size) Counter {   // C++17, usually 64
    std::atomic<std::uint64_t> value{};
};
std::array<Counter, 8> per_thread;                 // no two share a line

// ---- pack the read-together, split the write-separately ------------------
struct alignas(64) SpscRing {
    alignas(64) std::atomic<std::size_t> head{};   // producer writes, consumer reads
    alignas(64) std::atomic<std::size_t> tail{};   // consumer writes, producer reads
    alignas(64) std::size_t head_cache{};          // producer-private shadow of tail
    alignas(64) std::size_t tail_cache{};          // consumer-private shadow of head
};
// True sharing is the opposite goal: constructive interference size groups data
// that ARE accessed together onto one line.
static_assert(std::hardware_constructive_interference_size <= 256);
```

```cpp
// ---- shard, then reduce --------------------------------------------------
struct alignas(64) Shard { std::uint64_t count{}; };  // plain, not atomic: thread-private
std::vector<Shard> shards(nthreads);
shards[tid].count++;                                   // zero coherence traffic
auto total = std::transform_reduce(shards.begin(), shards.end(), 0ULL, std::plus<>{},
                                   [](Shard const& s){ return s.count; });
```

```bash
perf c2c record -- ./app && perf c2c report      # Linux: HITM events pinpoint the line
perf stat -e cache-misses,LLC-load-misses ./app
taskset -c 2,3 ./app                             # pin to sibling/non-sibling cores and A/B
```

| Symptom | Likely cause |
|---|---|
| Throughput *drops* as threads are added | False sharing or true contention |
| High HITM / remote-cache-hit counters | False sharing |
| Fixed by padding one struct field | False sharing confirmed |
| Not fixed by padding | True sharing, contention on one atomic, or memory bandwidth |

**Traps** — `hardware_destructive_interference_size` is a compile-time constant that need not match the deployed machine, and libstdc++ warns about using it across an ABI boundary · padding costs footprint and can hurt a cache-bound loop, so measure both ways · `alignas` on a type does not survive `new` for over-aligned types before C++17 · adjacent `std::atomic` members in one struct are the classic offender · a `vector<std::atomic<T>>` packs counters onto shared lines by default.

---

## 47.15 What makes a data race undefined behavior?

**Answer** — A data race is two conflicting accesses to the same memory location that are potentially concurrent, where at least one is a write, at least one is non-atomic, and neither happens-before the other; the standard makes that undefined behavior, so the compiler may assume it cannot happen. `volatile` does not help — it prevents compiler caching but provides no atomicity and no ordering.

```cpp
// ---- the race ------------------------------------------------------------
int payload;                       // non-atomic
bool ready = false;                // non-atomic
// producer: payload = 42; ready = true;
// consumer: if (ready) use(payload);     // DATA RACE: UB, may print anything or hoist the load

// ---- the fix ------------------------------------------------------------
int payload;
std::atomic<bool> ready{false};
// producer
payload = 42;                                        // ordinary write
ready.store(true, std::memory_order_release);        // publishes it
// consumer
if (ready.load(std::memory_order_acquire)) {         // reads the released value
    assert(payload == 42);                           // ordinary read, now synchronized
}
```

```cpp
// ---- what is and is not one memory location ------------------------------
std::array<int, 2> a;              // a[0] and a[1] are distinct locations: no race
struct Bits { unsigned x : 3, y : 5; };  // adjacent bit-fields = ONE location -> race
std::vector<bool> flags;           // proxy bits share a word -> race
std::string s;                     // concurrent read+write of the same string: race

// ---- other synchronization edges -----------------------------------------
std::mutex m; { std::lock_guard g{m}; payload = 42; }   // unlock happens-before next lock
std::thread t{f};  t.join();                            // join synchronizes
std::atomic_thread_fence(std::memory_order_release);    // standalone fence
std::atomic_ref<int> ar{payload};                       // C++20: atomic access to a normal object
std::latch l{2}; l.count_down(); l.wait();              // C++20
std::call_once(flag, init);                             // once-init edge
static Config const& cfg = load();                      // function-local static: thread-safe init
```

| Claim | Reality |
|---|---|
| "It's one machine instruction" | Not a C++ argument; the compiler may still reorder/fold/split |
| "`volatile` makes it safe" | No atomicity, no happens-before; only for MMIO and signal handlers |
| "The race is benign, worst case a stale value" | UB: the compiler may delete the loop or the check |
| "Only one thread writes, so it's fine" | Still a race if the read is non-atomic and unordered |
| "Aligned word writes are atomic on x86" | Platform folklore; use `std::atomic` and let it be free |

**Traps** — `std::atomic<T>` requires `T` trivially copyable and copies bytes, so it does not synchronize a pointee · reading and writing *different* members of the same struct is fine, but bit-fields are not · TSan finds races it observes, not all races · signal handlers may only touch `atomic` or `volatile sig_atomic_t`.

---

## 47.16 Explain acquire/release with a publication example

**Answer** — A release store publishes everything sequenced before it; when an acquire load *reads the value written by that store* (or a value later in its release sequence), the two synchronize-with, so everything before the release happens-before everything after the acquire. It orders the data protected by the token — it does not create a global total order the way `seq_cst` does.

```text
producer: construct payload ─────────► release-store(token)
                                          │ synchronizes-with (acquire reads THIS value)
consumer:                     acquire-load(token) ────► read payload  // guaranteed to see it
```

```cpp
struct Slot { Order order; };
Slot slot;
std::atomic<std::uint32_t> seq{0};

// producer: slot is producer-private while seq is even
void publish(Order o) {
    slot.order = std::move(o);                       // 1. private write
    seq.store(1, std::memory_order_release);         // 2. release: publishes step 1
}
// consumer
std::optional<Order> consume() {
    if (seq.load(std::memory_order_acquire) != 1) return std::nullopt;  // 3. acquire
    Order o = slot.order;                            // 4. sees step 1
    seq.store(0, std::memory_order_release);         // 5. release the slot back for reuse
    return o;
}
```

| Order | Guarantees | Typical use |
|---|---|---|
| `relaxed` | atomicity + per-object modification order only | statistics, ticket allocation |
| `consume` | data-dependent ordering (in practice promoted to acquire) | avoid |
| `acquire` | on a load: nothing after it moves before it; pairs with release | reading a published token |
| `release` | on a store: nothing before it moves after it; pairs with acquire | publishing a token |
| `acq_rel` | both, on a RMW | `fetch_sub` on a refcount, lock handoff |
| `seq_cst` | acq_rel + a single total order over all seq_cst ops | default; Dekker-style patterns |

```cpp
std::atomic<Node*> head{nullptr};
Node* n = new Node{...};                                        // fully constructed
head.store(n, std::memory_order_release);                        // publish the pointer
if (Node* p = head.load(std::memory_order_acquire)) use(p->x);   // safe to read *p

// compare_exchange takes TWO orders: success and failure (failure cannot be release)
std::uint32_t expected = 0;
while (!seq.compare_exchange_weak(expected, 1,
        std::memory_order_acq_rel,          // on success
        std::memory_order_acquire)) {}      // on failure (reload expected)

// fence form: equivalent edge without attaching the order to the operation
slot.order = o;
std::atomic_thread_fence(std::memory_order_release);
seq.store(1, std::memory_order_relaxed);
// consumer: if (seq.load(relaxed) == 1) { std::atomic_thread_fence(acquire); read(slot); }
```

**Traps** — the acquire must actually read the released value; reading a *different* value creates no edge · release on the wrong store (publishing before the payload is written) is the classic bug · acquire/release gives no total order, so two independent flag pairs can be observed inconsistently · `compare_exchange_weak` may fail spuriously, so it always lives in a loop, and it *writes* the observed value back into `expected`.

---

## 47.17 Why can relaxed atomics still be useful?

**Answer** — Relaxed operations still guarantee atomicity and a single total modification order per atomic object; they just do not order any surrounding non-atomic work. That is exactly enough when nothing is being published through the atomic — statistics counters, ticket allocation, or an index whose ownership edge is established by a separate acquire/release pair.

```cpp
std::atomic<std::uint64_t> drops{0};
drops.fetch_add(1, std::memory_order_relaxed);        // pure statistic: nobody reads data through it

std::atomic<std::uint64_t> next_id{0};
auto id = next_id.fetch_add(1, std::memory_order_relaxed);  // uniqueness only; no publication

std::atomic<bool> stop{false};
stop.store(true, std::memory_order_relaxed);          // poll flag: no data published with it
while (!stop.load(std::memory_order_relaxed)) work(); // must be atomic, need not be ordered

// refcount idiom: relaxed increment, acq_rel decrement
if (rc.fetch_sub(1, std::memory_order_acq_rel) == 1) delete p;   // release the writes, acquire before dtor
// (increment is relaxed because the caller already holds a reference -> already ordered)
```

```cpp
// ---- what relaxed does NOT do -------------------------------------------
int payload;
std::atomic<bool> ready{false};
payload = 42;
ready.store(true, std::memory_order_relaxed);         // BUG: consumer may see ready without payload
```

| Guaranteed by relaxed | Not guaranteed |
|---|---|
| Indivisible read/modify/write | Ordering of nearby non-atomic accesses |
| Single total modification order for that object | Any inter-thread happens-before |
| No out-of-thin-air values (practically) | That other threads see it "soon" |
| Coherence: a thread never sees the modification order run backwards | Consistency across two different atomics |

**Traps** — "relaxed for performance" without naming why ordering is unnecessary is the wrong answer · on x86 loads/stores compile identically for relaxed and acquire/release, so a relaxed bug is invisible until it ships to ARM · relaxed on an initialization flag is the canonical broken double-checked lock · `fetch_add` on a shared line is still a contended RMW, so relaxed does not make it cheap.

---

## 47.18 Compare mutex-based, lock-free, and wait-free designs

**Answer** — The distinction is a *progress* property, not a speed one: mutex-based designs are blocking because a descheduled owner stalls everyone, lock-free guarantees that some thread makes progress system-wide, and wait-free guarantees every thread finishes in a bounded number of steps. Lock-free is not automatically faster, not bounded-latency, and not allocation-free — retries, contention, and safe memory reclamation often make a well-designed single-writer or mutex architecture win on tail latency.

| Design | Progress | Strengths | Hazards |
|---|---|---|---|
| Blocking (mutex) | None if the owner is preempted | Simple invariants, condition waits, mature tooling | Convoying, priority inversion, contention |
| Obstruction-free | Progress when run in isolation | Simple retry structures | Livelock |
| Lock-free | Some operation always completes | A stalled thread cannot block all progress | Retries, starvation, ABA, reclamation |
| Wait-free | Every operation completes in bounded steps | Real per-thread latency bound | Complexity, space, large constants |

```cpp
// ---- lock-free push with CAS retry --------------------------------------
std::atomic<Node*> head{nullptr};
void push(Node* n) {
    n->next = head.load(std::memory_order_relaxed);
    while (!head.compare_exchange_weak(n->next, n,
               std::memory_order_release, std::memory_order_relaxed)) {}   // retry loop
}
// Popping is the hard part: ABA (the pointer is reused) plus reclamation
// (when may the node be freed?). Solutions: tagged pointers, hazard pointers,
// epoch reclamation, or never freeing (bounded pool).

std::atomic<std::uint64_t> x;
static_assert(std::atomic<std::uint64_t>::is_always_lock_free);   // C++17, constexpr
bool lf = x.is_lock_free();                                        // runtime query
// atomic<T> for large T uses a hidden lock: check, do not assume.

// ---- what to prefer on a hot path ---------------------------------------
// 1. single writer + immutable snapshot published by one release store
// 2. SPSC ring with acquire/release cursors and cached indices
// 3. sharded per-thread state reduced offline
// 4. a plain mutex held for a few nanoseconds of straight-line work
```

```cpp
// C++20 blocking primitives that avoid spinning
std::atomic<int> flag{0};
flag.wait(0);                       // block until value != 0
flag.store(1); flag.notify_one();   // wake a waiter
std::binary_semaphore sem{0}; sem.acquire(); sem.release();
std::stop_source ss; std::jthread t{[st = ss.get_token()]{ while(!st.stop_requested()) {} }};
```

**Traps** — `is_lock_free()` describes atomic operations on one type, not the progress property of your algorithm · a lock-free algorithm may still `new`/`delete` and thus block in the allocator · `compare_exchange_weak` in a tight loop can be worse than a mutex under contention · ABA is invisible in single-threaded tests · "lock-free" claims require naming the reclamation scheme.

---

## 47.19 Design and prove a bounded SPSC queue

**Answer** — State the constraints first — exactly one producer, one consumer, fixed power-of-two capacity, and a full/empty convention — then give the ownership argument: the producer writes the slot and *then* release-publishes the head, the consumer acquire-loads the head before reading, and publishes the tail with a release so the producer's acquire on the tail establishes that the slot is safe to reuse. Correctness is two release/acquire edges in opposite directions plus exactly one writer per cursor.

```text
producer owns slot[head] while head - tail < capacity
producer: write payload → release-store(head+1)
consumer: acquire-load(head) → read/move payload → release-store(tail+1)
producer: acquire-load(tail) before reusing a slot
cached copies of the opposite cursor remove most cross-core loads
```

```cpp
template<class T, std::size_t N>   // N must be a power of two
class SpscQueue {
    static_assert((N & (N - 1)) == 0 && N > 0);
    static constexpr std::size_t mask_ = N - 1;
    static constexpr std::size_t cl_ = std::hardware_destructive_interference_size;

    alignas(cl_) std::atomic<std::size_t> head_{0};   // producer writes
    alignas(cl_) std::atomic<std::size_t> tail_{0};   // consumer writes
    alignas(cl_) std::size_t cached_tail_{0};         // producer-private
    alignas(cl_) std::size_t cached_head_{0};         // consumer-private
    alignas(cl_) std::array<T, N> buf_{};             // pre-constructed: no placement new needed

public:
    bool try_push(T v) noexcept(std::is_nothrow_move_assignable_v<T>) {
        auto const h = head_.load(std::memory_order_relaxed);   // only this thread writes head_
        if (h - cached_tail_ == N) {                            // maybe full: refresh
            cached_tail_ = tail_.load(std::memory_order_acquire); // pairs with (B): slot reusable
            if (h - cached_tail_ == N) return false;             // genuinely full
        }
        buf_[h & mask_] = std::move(v);                          // producer-private write
        head_.store(h + 1, std::memory_order_release);           // (A) publish payload
        return true;
    }
    bool try_pop(T& out) noexcept(std::is_nothrow_move_assignable_v<T>) {
        auto const t = tail_.load(std::memory_order_relaxed);    // only this thread writes tail_
        if (t == cached_head_) {
            cached_head_ = head_.load(std::memory_order_acquire); // pairs with (A): payload visible
            if (t == cached_head_) return false;                  // genuinely empty
        }
        out = std::move(buf_[t & mask_]);                         // consumer-private read
        tail_.store(t + 1, std::memory_order_release);            // (B) release the slot
        return true;
    }
    std::size_t size_approx() const noexcept {                    // observers only
        return head_.load(std::memory_order_relaxed) - tail_.load(std::memory_order_relaxed);
    }
};
```

**Proof obligations to recite**

- Exactly one thread writes `head_`, exactly one writes `tail_` → no RMW needed, plain load/store suffice.
- `h - t` is correct across `size_t` wraparound because unsigned arithmetic is modular and `h - t <= N` always.
- Edge (A): payload write is sequenced before the release store; the consumer's acquire reads that value → payload visible.
- Edge (B): the consumer's read is sequenced before its release store; the producer's acquire on `tail_` → the slot is free.
- Capacity `N` power-of-two makes `& mask_` exact; a non-power-of-two needs `%` or a wrap branch.
- Pre-constructing `array<T,N>` means no object is overwritten while alive and none is destroyed twice; a raw-storage version needs placement `new` on push and `std::destroy_at` on pop.
- A throwing move assignment on push would leave the slot half-written but *unpublished*, so the queue invariant holds.
- Cache-line alignment of the four fields removes false sharing; the cached cursors remove most coherence traffic.
- Overload policy is explicit: `try_push` returns `false` — the alternative designs are drop-oldest, drop-newest, or block.

**Traps** — this reasoning does **not** generalize to MPMC: multiple producers need a reserved-slot sequence number per element (Vyukov) · a `size()` read by either side is only approximate · storing `T` by value pre-constructs `N` objects, which is wrong for expensive or non-default-constructible types · using `seq_cst` everywhere hides which edges actually matter · missing the tail acquire means the producer can overwrite a slot the consumer is still reading.

---

## 47.20 Design an allocation-conscious order book

**Answer** — State the invariants before naming a container: one writer mutates the book, each order ID maps to exactly one live order, each order sits in exactly one price-level FIFO, level aggregates equal the sum of their members, and best bid/ask always reference non-empty levels. Then the representation follows: a pre-sized node pool with a free list and generation-tagged handles, intrusive doubly-linked FIFOs per level, and a dense tick ladder or sorted vector for prices — no per-order allocation anywhere on the hot path.

```text
order id      ─ hash/flat map ─►  Handle{slot, generation}
Handle        ─ pool index ────►  OrderNode { qty, level, prev, next, generation }
price level   ─ ladder index ──►  Level { head, tail, total_qty, count }
prices        ─ dense array of ticks (or sorted vector / tree by domain)
best bid/ask  ─ cached indices, repaired on level empty/create
```

```cpp
using Qty  = std::int64_t;
using Tick = std::int32_t;
struct Handle { std::uint32_t slot{}; std::uint32_t generation{}; };
inline constexpr std::uint32_t kNil = 0xFFFF'FFFFu;

struct OrderNode {
    Qty qty{}; Tick tick{}; bool is_buy{};
    std::uint32_t prev{kNil}, next{kNil};    // intrusive FIFO links: indices, not pointers
    std::uint32_t generation{};              // bumped on free -> stale handles detected
    std::uint32_t free_next{kNil};
};
struct Level { std::uint32_t head{kNil}, tail{kNil}; Qty total{}; std::uint32_t count{}; };

class Book {
    std::vector<OrderNode> pool_;            // sized ONCE, never grows
    std::uint32_t free_head_{kNil};
    std::vector<Level> bids_, asks_;         // dense ladder indexed by tick
    std::unordered_map<std::uint64_t, Handle> by_id_;   // or a flat open-addressed map
    Tick best_bid_{-1}, best_ask_{-1};

    std::uint32_t alloc() noexcept {         // O(1), no heap traffic
        if (free_head_ == kNil) return kNil; // capacity exhaustion is EXPLICIT
        auto s = free_head_; free_head_ = pool_[s].free_next; return s;
    }
    void release(std::uint32_t s) noexcept {
        ++pool_[s].generation;               // invalidate outstanding handles
        pool_[s].free_next = free_head_; free_head_ = s;
    }
public:
    explicit Book(std::size_t capacity, std::size_t ticks)
        : pool_(capacity), bids_(ticks), asks_(ticks) {
        by_id_.reserve(capacity);            // no rehash on the hot path
        for (std::size_t i = capacity; i-- > 0; ) { pool_[i].free_next = free_head_;
                                                    free_head_ = std::uint32_t(i); }
    }
    bool add(std::uint64_t id, bool buy, Tick t, Qty q) noexcept;   // O(1) amortized
    bool cancel(std::uint64_t id) noexcept;                          // O(1) unlink
    bool modify(std::uint64_t id, Qty new_qty) noexcept;             // O(1) if qty only
    Qty  depth_at(bool buy, Tick t) const noexcept { return (buy?bids_:asks_)[t].total; }
    bool valid(Handle h) const noexcept {                            // stale-handle check
        return h.slot < pool_.size() && pool_[h.slot].generation == h.generation;
    }
};
```

| Operation | Cost | Notes |
|---|---|---|
| `add` | O(1) map insert + O(1) pool alloc + O(1) tail link | plus best-price update |
| `cancel` | O(1) map find + O(1) unlink + O(1) free | best price repair if level empties |
| `modify` qty down | O(1) | keeps FIFO priority |
| `modify` price / qty up | cancel + add | loses priority (matches exchange rules) |
| Best bid/ask | O(1) cached | O(levels scanned) to repair after a level empties |
| Match/trade | O(orders touched) | walk the level FIFO from head |

| Price index | When |
|---|---|
| Dense tick ladder (`vector<Level>`) | Bounded, known tick range — O(1), best locality |
| Sorted `vector` of levels | Sparse prices, few levels, insert cost tolerable |
| `std::map` | Wide sparse range, correctness over latency |
| Flat hash by tick + heap of tops | Very sparse, wide range |

**Traps** — a `std::map<Price, std::list<Order>>` allocates twice per order and misses cache on every hop · stable *pointers* require stable storage, so indices plus generations are the portable answer · aggregate quantities must be updated in the same place as the links or they drift · single-writer state means no atomics inside the book — publish an immutable snapshot to readers instead · capacity exhaustion must be a documented rejection, not an allocation.

---

## 47.21 Parse a decimal price without allocation or floating point

**Answer** — Convert `whole.frac` directly into a scaled integer of ticks with overflow checks at each step, never through `double` — binary floating point cannot represent most decimal ticks exactly, so `0.07` round-trips wrong and comparisons drift. Use `std::from_chars` or a hand loop over a `string_view`, right-pad the fraction to the fixed scale, and return `std::expected` rather than throwing.

```text
1 reject empty / validate sign per the grammar
2 accumulate whole, checking whole <= (INT64_MAX - digit) / 10 BEFORE multiplying
3 read at most `digits` fractional digits
4 right-pad missing fractional digits with zeros
5 reject or round extra digits by an EXPLICIT policy
6 check whole <= (INT64_MAX - frac) / S
7 return whole * S + frac
```

```cpp
#include <charconv>
#include <expected>

enum class ParseError { empty, bad_char, overflow, too_precise };

template<int Digits>                                   // scale S = 10^Digits
constexpr std::int64_t pow10 = 10 * pow10<Digits - 1>;
template<> constexpr std::int64_t pow10<0> = 1;

template<int Digits>
constexpr std::expected<std::int64_t, ParseError>
parse_price(std::string_view s) noexcept {
    constexpr std::int64_t S = pow10<Digits>;
    constexpr std::int64_t kMax = std::numeric_limits<std::int64_t>::max();
    if (s.empty()) return std::unexpected(ParseError::empty);

    bool neg = false;
    if (s.front() == '-' || s.front() == '+') { neg = (s.front() == '-'); s.remove_prefix(1); }

    std::int64_t whole = 0;
    std::size_t i = 0;
    for (; i < s.size() && s[i] >= '0' && s[i] <= '9'; ++i) {
        std::int64_t const d = s[i] - '0';
        if (whole > (kMax - d) / 10) return std::unexpected(ParseError::overflow);
        whole = whole * 10 + d;
    }
    if (i == 0) return std::unexpected(ParseError::bad_char);

    std::int64_t frac = 0;
    int seen = 0;
    if (i < s.size() && s[i] == '.') {
        ++i;
        for (; i < s.size() && s[i] >= '0' && s[i] <= '9'; ++i) {
            if (seen < Digits) { frac = frac * 10 + (s[i] - '0'); ++seen; }
            else if (s[i] != '0') return std::unexpected(ParseError::too_precise); // policy: reject
        }
    }
    if (i != s.size()) return std::unexpected(ParseError::bad_char);
    for (; seen < Digits; ++seen) frac *= 10;          // right-pad: "1.5" -> 1.50000000

    if (whole > (kMax - frac) / S) return std::unexpected(ParseError::overflow);
    std::int64_t const ticks = whole * S + frac;
    return neg ? -ticks : ticks;
}
static_assert(*parse_price<4>("1.5")     == 15000);
static_assert(*parse_price<4>("0.0001")  == 1);
static_assert(!parse_price<4>("1.00001"));            // too_precise under this policy
```

```cpp
// ---- std::from_chars: locale-independent, allocation-free, non-throwing ---
std::int64_t v{};
auto [p, ec] = std::from_chars(s.data(), s.data() + s.size(), v, 10);
if (ec == std::errc::result_out_of_range) { /* overflow */ }
if (ec == std::errc::invalid_argument)    { /* no digits */ }

// ---- formatting back out --------------------------------------------------
char out[32];
auto r = std::to_chars(out, out + sizeof out, ticks);            // integer, exact
std::string t = std::format("{}.{:0{}}", ticks / S, ticks % S, Digits);  // C++20
```

| Tool | Allocates | Locale | Throws | Exact decimal |
|---|---|---|---|---|
| `std::from_chars` / `std::to_chars` | no | no | no | yes for integers |
| `std::stod` / `atof` | yes | yes (`atof`) | yes | **no** |
| `std::istringstream` | yes | yes | configurable | no |
| Hand loop above | no | no | no | yes |
| `double` at any step | — | — | — | **no** |

**Traps** — `string_view` is only valid while the input buffer lives, so never store it past the callback · `from_chars` for floating point is exact round-trip but still binary · rounding policy (reject / truncate / half-even) must be stated, not implied · negative-zero and leading-zero grammars differ per venue · the overflow check must happen *before* the multiply, not after.

---

## 47.22 Find and repair UB, lifetime bugs, races, and invalidation bugs in short snippets

**Answer** — Audit in a fixed order so nothing is missed: bounds and arithmetic, then the owner and lifetime of every pointer/reference/view, then invalidation after any container mutation, then initialization and the active union or variant alternative, then aliasing/alignment, then sequencing within the expression, then concurrent conflicts and happens-before, then preconditions like `front()` on an empty container. Repair the invariant, not just the observed crash — sanitizers are evidence, not the definition of UB.

```text
1 bounds and integer arithmetic before any address calculation
2 lifetime and owner of every pointer, reference, view, span, string_view
3 invalidation after every container mutation
4 initialization; active union/variant alternative
5 aliasing, alignment, object representation
6 sequencing inside one expression
7 concurrent conflicts and happens-before edges
8 preconditions: empty front/back, invalid iterator, bad comparator, self-move
```

```cpp
// ---- the classic bugs, with the fix -----------------------------------
auto* p = &v.front(); v.push_back(x); use(*p);
//  -> dangling on realloc. FIX: v.reserve(max) or store an index.

std::string_view sv = std::string{"x"};
//  -> dangles at the semicolon. FIX: own the string, or take a view of a stable buffer.

int i = 0; a[i] = i++;
//  -> unsequenced-ish; do not be clever. FIX: a[0] = 0; i = 1;

auto x = *reinterpret_cast<std::uint32_t*>(bytes + 1);
//  -> alignment + aliasing + no object of that type. FIX: memcpy into a uint32_t.

bool ready; int data;   // written by one thread, read by another
//  -> data race + uninitialized read. FIX: atomic<bool> release/acquire.

for (auto it = m.begin(); it != m.end(); ++it) if (pred(*it)) m.erase(it);
//  -> use-after-erase. FIX: it = m.erase(it); with an else ++it, or std::erase_if.

int n = v.size() - 1;   // v empty -> size_t underflow -> huge value
//  -> FIX: if (!v.empty()) ... or use std::ssize(v) - 1.

std::sort(v.begin(), v.end(), [](auto a, auto b){ return a <= b; });
//  -> not a strict weak order: UB, can write past the end. FIX: <.

std::variant<int, std::string> var = 1; auto& s = std::get<std::string>(var);
//  -> throws std::bad_variant_access. FIX: std::get_if / std::visit.

char buf[8]; std::memcpy(buf, src, len);   // len unchecked
//  -> FIX: bounds-check against sizeof buf, or use std::span and subspan.

std::shared_ptr<T> a = ...; T* raw = a.get(); a.reset(); use(raw);
//  -> FIX: keep the shared_ptr alive, or pass shared ownership.

f(std::shared_ptr<T>{new T}, may_throw());
//  -> possible leak. FIX: std::make_shared<T>() (also one allocation).

x = std::move(x); v = std::move(v);
//  -> self-move leaves an unspecified value. FIX: guard, or never alias.
```

```bash
# ---- dynamic evidence ---------------------------------------------------
g++ -std=c++23 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer x.cpp
g++ -std=c++23 -O1 -g -fsanitize=thread x.cpp          # TSan: races (not with ASan)
g++ -std=c++23 -fsanitize=memory x.cpp                 # clang only: uninitialized reads
valgrind --tool=memcheck --leak-check=full ./app
g++ -D_GLIBCXX_DEBUG        # libstdc++ checked iterators/containers
clang++ -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG
g++ -Wall -Wextra -Wshadow -Wconversion -Wsign-conversion -Wold-style-cast -Werror
clang-tidy -checks='bugprone-*,cert-*,concurrency-*' x.cpp
```

**Traps** — ASan and TSan cannot run together · sanitizers only see executed paths, so a clean run proves nothing about UB · `-O0` hides UB that `-O2` exploits · signed overflow is UB while unsigned wraps, so `i - 1` on an unsigned zero is a silent disaster, not a crash.

---

## 47.23 Explain why a plausible microbenchmark is misleading

**Answer** — Most microbenchmarks measure something other than the thing under test: the optimizer deleted the work because the result is unobservable, the input was a compile-time constant, the timer overhead dominated, or the loop kept everything hot in L1 and perfectly branch-predicted in a way production never is. A credible number needs observable work, runtime-varying representative inputs, a defined measurement boundary, a reported distribution with tail percentiles, and a recorded environment.

**The checklist to recite**

- Is the result observable, or was the work folded/removed? (Check the disassembly.)
- Are the inputs runtime values and representative in *distribution*, not just in type?
- Does timer overhead dominate a sub-100ns operation?
- Is setup, allocation, or I/O inside only one of the regions being compared?
- Were caches and branch predictors deliberately warm or cold — and which does production see?
- Are state and branch distributions realistic, or is the branch always taken?
- Is a distribution reported (p50/p99/p99.9/max), or just the mean or the minimum?
- Was CPU pinning, frequency scaling, turbo, NUMA node, and background noise recorded?
- Does the contention load include rejects, retries, and queueing delay?
- Is the binary optimized, non-instrumented, and built with production flags?
- Was allocation count and generated code checked, not assumed?

```cpp
// ---- keeping work observable --------------------------------------------
static void bench(benchmark::State& st) {
    auto input = make_representative_input();     // runtime data, not a literal
    for (auto _ : st) {
        benchmark::DoNotOptimize(input);          // input is opaque to the optimizer
        auto r = parse_price<4>(input);
        benchmark::DoNotOptimize(r);              // result is observed
        benchmark::ClobberMemory();               // memory writes are not elided
    }
    st.SetItemsProcessed(st.iterations());
}
BENCHMARK(bench);

// ---- hand-rolled equivalents ---------------------------------------------
template<class T> void keep(T const& v) { asm volatile("" :: "r,m"(v) : "memory"); }
template<class T> void escape(T* p)     { asm volatile("" : "+r,m"(*p) :: "memory"); }
```

```cpp
// ---- measuring latency distributions, not means --------------------------
std::vector<std::uint64_t> ns; ns.reserve(1'000'000);
for (int i = 0; i < 1'000'000; ++i) {
    auto t0 = std::chrono::steady_clock::now();     // never system_clock: it can jump
    do_work(inputs[i]);
    auto t1 = std::chrono::steady_clock::now();
    ns.push_back(std::uint64_t((t1 - t0) / std::chrono::nanoseconds{1}));
}
std::ranges::sort(ns);
auto pct = [&](double q){ return ns[std::size_t(q * (ns.size() - 1))]; };
std::print("p50={} p99={} p99.9={} max={}\n", pct(.5), pct(.99), pct(.999), ns.back());
```

```bash
./bench --benchmark_repetitions=20 --benchmark_report_aggregates_only=true
perf stat -e cycles,instructions,branch-misses,cache-misses,LLC-load-misses ./app
perf record -g ./app && perf report
taskset -c 3 chrt -f 80 ./app                     # pin + real-time priority
sudo cpupower frequency-set -g performance        # disable frequency scaling
echo 0 | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/boost   # disable turbo
objdump -d --no-show-raw-insn ./app | less        # did the loop even survive?
```

**Traps** — `volatile` as a benchmark barrier also forbids register allocation and changes the code under test · one run, or the minimum of many, hides the tail that actually matters in trading · dividing total nanoseconds by a huge loop count measures throughput, not latency · `rdtsc` needs an invariant TSC and a serializing instruction · comparing debug against release, or two different compilers, is not a comparison of algorithms.

---

## 47.24 Choose between inheritance, templates, type erasure, and `variant`

**Answer** — The first question is whether the set of types is open or closed after the consumer is compiled: an open set needs virtual dispatch or type erasure, a closed set is better served by `std::variant` with `visit`, and if the types are known at compile time and the call is hot, templates and concepts give inlinable static dispatch with no indirection at all. Then decide ownership — inline value, heap-owned, or borrowed — and only then argue about speed.

| Mechanism | Type set | Dispatch | Ownership / layout | Best fit |
|---|---|---|---|---|
| Virtual inheritance | Open | Indirect call through a vtable | Behind pointer/reference; heap | Extensible runtime plugins, stable ABI |
| Templates + concepts | Compile-time | Static, inlinable | Concrete layout, no indirection | Hot composition, zero runtime dispatch |
| Type erasure | Open | Indirect through stored vtable | Wrapper may own or borrow; SBO or heap | Non-template interface across an ABI line |
| `variant` + `visit` | Closed | Tag switch, alternatives inlined | Inline, sized to the largest alternative | Closed message/state sets, exhaustive handling |
| Function pointer / `function_ref` | Open callables | Indirect | Borrowed | Callbacks with no ownership |

```cpp
// ---- 1. virtual: open set, runtime dispatch -----------------------------
struct Strategy { virtual ~Strategy() = default; virtual void on_tick(Tick const&) = 0; };
struct Momentum final : Strategy { void on_tick(Tick const&) override; };  // final -> devirtualizable
std::vector<std::unique_ptr<Strategy>> live;

// ---- 2. templates: compile-time set, inlined ----------------------------
template<class S> requires requires(S& s, Tick const& t) { s.on_tick(t); }
void run(S& s, std::span<Tick const> ticks) { for (auto const& t : ticks) s.on_tick(t); }
// CRTP: static polymorphism with a shared base
template<class D> struct Base { void go() { static_cast<D*>(this)->impl(); } };

// ---- 3. type erasure: open set, value semantics -------------------------
class AnyStrategy {
    struct Concept { virtual ~Concept() = default; virtual void on_tick(Tick const&) = 0;
                     virtual std::unique_ptr<Concept> clone() const = 0; };
    template<class T> struct Model final : Concept {
        T t;
        explicit Model(T v) : t(std::move(v)) {}
        void on_tick(Tick const& k) override { t.on_tick(k); }
        std::unique_ptr<Concept> clone() const override { return std::make_unique<Model>(t); }
    };
    std::unique_ptr<Concept> p_;
public:
    template<class T> AnyStrategy(T t) : p_(std::make_unique<Model<T>>(std::move(t))) {}
    AnyStrategy(AnyStrategy const& o) : p_(o.p_->clone()) {}
    AnyStrategy(AnyStrategy&&) noexcept = default;
    void on_tick(Tick const& k) { p_->on_tick(k); }
};
// std::function and std::any are type erasure; std::move_only_function (C++23) avoids
// requiring copyability; a function_ref-style borrow avoids allocation entirely.

// ---- 4. variant: closed set, exhaustive ---------------------------------
using Msg = std::variant<NewOrder, Cancel, Trade>;
struct Handler {
    void operator()(NewOrder const&) const;
    void operator()(Cancel const&)   const;
    void operator()(Trade const&)    const;
};
std::visit(Handler{}, msg);                                     // exhaustive: missing case = error
std::visit([]<class T>(T const& m){ if constexpr (std::same_as<T, Trade>) {} }, msg);
if (auto* t = std::get_if<Trade>(&msg)) use(*t);                 // non-throwing probe
// overload-set idiom
template<class... F> struct overloaded : F... { using F::operator()...; };
std::visit(overloaded{[](NewOrder const&){}, [](auto const&){}}, msg);
```

**Decision questions**

- Is the alternative set open after the consumer compiles? → open ⇒ virtual or erasure; closed ⇒ `variant`.
- Must values be owned inline (no allocation), heap-owned, or merely borrowed?
- Is there an ABI or compile-firewall boundary? → erasure or virtual; templates leak into headers.
- Is exhaustive handling a correctness feature? → `variant` gives a compile error on a new alternative.
- What is the dispatch *frequency* and is the target predictable? → a well-predicted indirect call is a few cycles.
- What allocation and exception behavior is permitted on this path?

**Traps** — `variant` is sized to its largest alternative, so one fat member bloats every message · `std::function` may allocate and is not guaranteed SBO — use `move_only_function` or a `function_ref` on hot paths · templates bloat instruction cache and compile time · virtual calls devirtualize well with `final` + LTO, so "virtual is slow" needs a measurement · type erasure hides one allocation and one indirection per object · `std::visit` over N variants of M alternatives generates Mᴺ instantiations.

---

**Recall card**

```text
build       TU -> object -> link -> load; ODR/ABI/flag consistency
values      lvalue identity; xvalue expiring identity; prvalue initializes
move        a cast enabling overload; the selected operation does the work
special     Rule of Zero; a declared destructor suppresses implicit moves
vector      contiguous; reserve != resize; reallocation invalidates all
ordering    strict weak order; !comp&&!comp is the equivalence
hash        avg O(1) worst O(N); rehash spikes; iterators die, references live
slicing     copy into a base object loses the derived part; virtual dtor on delete-through-base
concepts    subsumption orders overloads; requires only checks that it compiles
RAII        lifetime owns cleanup; unwinding destroys completed subobjects
exceptions  nothrow | strong | basic | none; noexcept violation terminates
bytes       bit_cast / memcpy / byte view; endian, padding, lifetime still yours
sharing     two hot objects, one line; align, shard, then measure
races       conflicting non-atomic access without happens-before = UB
publish     write payload -> release -> acquire -> read payload
relaxed     atomicity + modification order only; no publication
progress    blocking | lock-free system progress | wait-free per-op bound
SPSC        one writer per cursor + release/acquire in BOTH directions
book        single writer + bounded pool + generation handles + level invariants
decimal     integer ticks, overflow-checked, never through double
audit       bounds, lifetime, invalidation, init, aliasing, sequencing, races
benchmark   observable work + real inputs + boundary + distribution + environment
dispatch    open/closed set + ownership + ABI/code size + measured frequency
```
