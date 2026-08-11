# 23. Dynamic memory and allocation

*Part IV — Memory, representation, and performance*

---

**Recall**
- Allocation obtains *storage*; construction begins an *object's lifetime* in that storage — they are separable operations.
- A `new`-expression = allocation function call + initialization; a `delete`-expression = destruction + deallocation function call.
- `operator new` is an ordinary function returning `void*`; it never constructs anything.
- Every acquisition form has exactly one matching release form: scalar↔scalar, array↔array, aligned↔aligned, allocator↔same allocator, placement↔explicit destructor.
- Throwing allocation reports failure with `std::bad_alloc`; `new (std::nothrow)` reports it with a null pointer.
- `new (std::nothrow) T(args)` does **not** suppress exceptions from `T`'s constructor — only from allocation.
- If allocation succeeds and the constructor throws, the new-expression calls the matching deallocation function automatically (no leak).
- Deleting a derived object through a base pointer requires a `virtual` destructor (or a destroying-delete design).
- `delete nullptr` and `delete[] nullptr` are well-defined no-ops; double delete, wrong form, and interior-pointer delete are UB.
- Over-aligned types (`alignof(T) > __STDCPP_DEFAULT_NEW_ALIGNMENT__`) select `align_val_t` overloads since C++17; manual code must pass the same alignment to `operator delete`.
- `std::construct_at` / `std::destroy_at` are the constexpr-friendly spellings of placement new / explicit destructor call.
- Placement construction must prove: enough size, correct alignment, no conflicting live object, exact destruction, and backing storage outliving every use.
- Ending a lifetime does not release storage; releasing storage does not end lifetimes — an arena reset never runs destructors.
- `reserve(n)` creates capacity, not objects: writing `v[i]` past `size()` is UB regardless of capacity.
- Sized delete (`operator delete(void*, size_t)`) is a lookup preference, not a portable guarantee that size is always passed.
- Destroying delete (C++20, `std::destroying_delete_t`) makes the deallocation function responsible for calling the destructor too.
- Fragmentation (external: no contiguous fit; internal: waste inside a size class) is a state property, invisible to Big-O.
- Tail latency from allocation comes from search/coalescing, lock contention, metadata cache/TLB traffic, first-touch page faults, and remote frees.
- "No allocation in the source text" is not proof: containers, `std::string` past SSO, `std::function`, exceptions, and coroutine frames allocate indirectly.
- `memcpy`/`memset` are not constructors or destructors — only implicit-lifetime/trivially-copyable types may be created or copied bytewise.

---

## 23.1 `new` / `delete`, array forms, and allocation failure

```cpp
#include <cstddef>
#include <cstdint>
#include <memory>
#include <new>

struct Order {
    explicit Order(std::uint64_t id) : id{id} {}
    std::uint64_t id{};
};

// ---- scalar new-expression, every initializer spelling -------------------
Order*  p1 = new Order{42};          // list-init; allocate then construct
Order*  p2 = new Order(42);          // direct-init (parenthesized)
int*    i1 = new int;                // DEFAULT-init: value indeterminate
int*    i2 = new int();               // value-init: zero
int*    i3 = new int{};               // value-init: zero
int*    i4 = new int{7};              // = 7
auto*   a1 = new auto(3.5);           // deduced: double*
Order*  p3 = new (std::nothrow) Order{1};  // null on allocation failure
delete p1; delete p2; delete i1; delete i2; delete i3; delete i4;
delete a1; delete p3;

// ---- array new-expression ------------------------------------------------
std::size_t n = 8;
int*   arr1 = new int[n];             // n DEFAULT-initialized ints (garbage)
int*   arr2 = new int[n]();           // n value-initialized zeros
int*   arr3 = new int[n]{};           // n value-initialized zeros
int*   arr4 = new int[4]{1, 2};       // {1,2,0,0}
Order* arr5 = new Order[2]{Order{1}, Order{2}};
auto*  arr6 = new int[n][3];          // int(*)[3]; only FIRST extent may be runtime
delete[] arr1; delete[] arr2; delete[] arr3;
delete[] arr4; delete[] arr5; delete[] arr6;

// ---- null and mismatch ---------------------------------------------------
int* q = nullptr;
delete q;                             // no-op, well-defined
delete[] q;                           // no-op, well-defined
int* bad = new int[4];
// delete bad;                        // UB: array acquired, scalar released
delete[] bad;

// ---- prefer RAII ---------------------------------------------------------
auto one   = std::make_unique<Order>(42);
auto many  = std::make_unique<Order[]>(128);          // value-initializes 128
auto raw_n = std::make_unique_for_overwrite<int[]>(128); // C++20: no zeroing
auto shared = std::make_shared<Order>(7);             // one alloc: object+control
```

```cpp
// ---- polymorphic deletion ------------------------------------------------
struct Base { virtual ~Base() = default; };           // REQUIRED for delete-through-base
struct Derived final : Base { std::vector<int> data; };
Base* b = new Derived;
delete b;                                             // reaches ~Derived

struct NoVirt { ~NoVirt() = default; };
struct D2 : NoVirt {};
// NoVirt* nb = new D2; delete nb;                    // UB
// Mitigation: protected non-virtual dtor, or final, or unique_ptr<Base> with
// a deleter that knows the dynamic type (shared_ptr captures it automatically).
std::shared_ptr<NoVirt> sp = std::make_shared<D2>();  // OK: type-erased deleter
```

```cpp
// ---- allocation failure semantics ---------------------------------------
try {
    auto* huge = new int[std::size_t(-1) / 2];        // throws std::bad_alloc
    delete[] huge;
} catch (std::bad_alloc const& e) { /* e.what() */ }

auto* np = new (std::nothrow) Order{42};
if (!np) { /* acquisition failed; no exception thrown */ }
delete np;                                            // matches nothrow new

struct Fails { Fails() { throw 7; } };
try {
    auto* f = new (std::nothrow) Fails;   // ctor still throws 7;
    delete f;                             //   matching operator delete(p, nothrow) ran
} catch (int) {}

// new-handler: process-global, runs in a loop before bad_alloc is thrown
std::new_handler prev = std::set_new_handler([] { std::abort(); });
std::set_new_handler(prev);
```

```cpp
// ---- bounded acquisition: explicit error beats global recovery -----------
#include <expected>                                    // C++23
enum class AcquireError { exhausted };
template<class Pool>
[[nodiscard]] auto try_make_order(Pool& pool, std::uint64_t id)
    -> std::expected<typename Pool::handle_type, AcquireError>;
```

**Pairing table — memorize**

| Acquisition | Required release |
|---|---|
| `new T` | `delete p` |
| `new T[n]` | `delete[] p` |
| `new (std::nothrow) T` | `delete p` (compiler pairs the nothrow deallocator on ctor throw) |
| `::operator new(bytes)` | `::operator delete(p)` after ending lifetimes |
| `::operator new(bytes, std::align_val_t{a})` | `::operator delete(p, std::align_val_t{a})` |
| `Alloc::allocate(n)` | `Alloc::deallocate(p, n)` — same `n`, compatible allocator |
| `mr->allocate(b, a)` | `mr->deallocate(p, b, a)` — same size *and* alignment |
| placement `new (addr) T` | `p->~T()` / `std::destroy_at(p)`; storage freed by its owner |
| `std::make_unique<T>` | automatic (`unique_ptr`) |
| `malloc` | `free` — never `delete` |

| Failure form | Reports how | Notes |
|---|---|---|
| `new T` | throws `std::bad_alloc` | after new-handler loop exhausts |
| `new (std::nothrow) T` | returns `nullptr` | ctor exceptions still propagate |
| `new T[n]` with overflowing `n` | throws `std::bad_array_new_length` | derived from `bad_alloc` |
| `::operator new(size)` | throws `std::bad_alloc` | |
| `::operator new(size, std::nothrow)` | returns `nullptr` | `noexcept` |

**Traps** — `new int[n]` leaves elements indeterminate; `new int[n]()` zeroes them · `delete` vs `delete[]` mismatch is UB even for `int` · deleting through a base without a virtual destructor is UB · `new (std::nothrow)` does not make constructors nothrow · allocation is not input validation — a bogus `n` may *succeed* · never `delete` a pointer you did not get from `new` · `void*` cannot be portably deleted.

---

## 23.2 Allocation functions versus object construction

```cpp
#include <memory>
#include <new>

// ---- the four primitive operations, spelled separately -------------------
void* raw  = ::operator new(sizeof(Order));            // 1. storage only
Order* ord = ::new (raw) Order{7};                     // 2. construction only
ord->~Order();                                         // 3. destruction only
::operator delete(raw);                                // 4. deallocation only

// ---- modern spelling of 2 and 3 -----------------------------------------
void* raw2 = ::operator new(sizeof(Order));
auto* o2   = std::construct_at(static_cast<Order*>(raw2), 7);  // C++20, constexpr
std::destroy_at(o2);                                   // C++17
::operator delete(raw2);
```

```cpp
// ---- global allocation function overload set (<new>) --------------------
void* operator new(std::size_t);                                    // throwing
void* operator new(std::size_t, std::nothrow_t const&) noexcept;
void* operator new(std::size_t, std::align_val_t);                  // C++17
void* operator new(std::size_t, std::align_val_t, std::nothrow_t const&) noexcept;
void* operator new[](std::size_t);                                  // + same 3 variants
void  operator delete(void*) noexcept;
void  operator delete(void*, std::size_t) noexcept;                 // sized, C++14
void  operator delete(void*, std::align_val_t) noexcept;            // C++17
void  operator delete(void*, std::size_t, std::align_val_t) noexcept;
void  operator delete(void*, std::nothrow_t const&) noexcept;
void* operator new(std::size_t, void* p) noexcept { return p; }     // PLACEMENT: not replaceable
void  operator delete(void*, void*) noexcept {}                     // placement: no-op
```

```cpp
// ---- class-specific allocation ------------------------------------------
struct Pooled {
    static void* operator new(std::size_t n);                     // implicitly static
    static void  operator delete(void* p) noexcept;
    static void* operator new[](std::size_t n);
    static void  operator delete[](void* p) noexcept;
    static void* operator new(std::size_t n, Arena& a);           // placement-style
    static void  operator delete(void* p, Arena& a) noexcept;     // ctor-throw partner
};
Pooled* a = new Pooled;            // finds Pooled::operator new by class lookup
Pooled* b = ::new Pooled;          // :: forces the GLOBAL allocation function
delete a;                          // Pooled::operator delete
::delete b;                        // global operator delete — must match!
Arena arena;
Pooled* c = new (arena) Pooled;    // extra args → placement-style class overload
```

```cpp
// ---- global replacement (program-wide; one definition, no header needed) --
void* operator new(std::size_t n) {
    if (n == 0) n = 1;                        // must return distinct non-null
    while (void* p = std::malloc(n)) return p;
    if (auto h = std::get_new_handler()) { h(); continue_loop(); }
    throw std::bad_alloc{};
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }  // sized: MUST also exist
```

| Function / helper | Header | What it does | Complexity |
|---|---|---|---|
| `::operator new(n)` | `<new>` | raw bytes, default-aligned, throws `bad_alloc` | allocator-dependent |
| `::operator new(n, nothrow)` | `<new>` | raw bytes or `nullptr`, `noexcept` | |
| `::operator delete(p)` / `(p, n)` | `<new>` | release bytes; `noexcept`; `nullptr` OK | |
| `new (p) T(args)` | `<new>` | construct at `p`, no allocation | O(ctor) |
| `std::construct_at(p, args...)` | `<memory>` | C++20; placement new, `constexpr`, no `()`-vs-`{}` ambiguity | O(ctor) |
| `std::destroy_at(p)` | `<memory>` | C++17; calls `p->~T()`, recurses over array elements (C++20) | O(dtor) |
| `std::destroy(first, last)` / `destroy_n(f, n)` | `<memory>` | destroy a range | O(n) |
| `std::uninitialized_default_construct(_n)` | `<memory>` | default-init a raw range; rolls back on throw | O(n) |
| `std::uninitialized_value_construct(_n)` | `<memory>` | value-init a raw range | O(n) |
| `std::uninitialized_fill(_n)` | `<memory>` | copy-construct from one value | O(n) |
| `std::uninitialized_copy(_n)` / `_move(_n)` | `<memory>` | construct from a source range | O(n) |
| `std::start_lifetime_as<T>(p)` | `<memory>` | C++23; begin implicit-lifetime object lifetime over bytes | O(1) |
| `std::launder(p)` | `<new>` | re-legitimize a pointer after storage reuse | O(1) |
| `std::allocator<T>::allocate(n)` / `deallocate(p, n)` | `<memory>` | typed raw storage; `allocate_at_least` C++23 | |
| `std::align(a, sz, ptr, space)` | `<memory>` | advance `ptr` to alignment inside a buffer | O(1) |
| `std::assume_aligned<N>(p)` | `<memory>` | C++20 optimizer hint; UB if false | O(1) |
| `std::get_new_handler()` / `set_new_handler(h)` | `<new>` | global handler, `noexcept` | O(1) |
| `std::hardware_destructive_interference_size` | `<new>` | C++17 cache-line padding constant | |

**Interview line** — "`operator new` is a function that returns raw storage; a `new`-expression is the language construct that couples that call with initialization."

**Traps** — `::new`/`::delete` bypass class-specific forms and must be paired with each other · a class-specific `operator new` with extra args needs a matching `operator delete` with the same args or a constructor throw leaks · replacing global `operator new` affects libraries, startup, and test tooling · if you replace unsized `operator delete` you must also replace the sized one · `std::allocator::deallocate` requires the *same* `n` you allocated · `construct_at` refuses to compile for aggregate `()`-init before C++20 rules.

---

## 23.3 Alignment-aware allocation and over-aligned types

```cpp
#include <new>
#include <memory>

struct alignas(64) CacheSlot { std::uint64_t sequence{}; };   // over-aligned
static_assert(alignof(CacheSlot) == 64);
static_assert(sizeof(CacheSlot) % alignof(CacheSlot) == 0);   // arrays keep alignment
static_assert(alignof(CacheSlot) > __STDCPP_DEFAULT_NEW_ALIGNMENT__ ||
              alignof(CacheSlot) <= __STDCPP_DEFAULT_NEW_ALIGNMENT__);

auto* s = new CacheSlot{};      // C++17: selects operator new(size, align_val_t{64})
delete s;                       // selects operator delete(p, align_val_t{64})

// ---- manual: alignment must be carried through deallocation --------------
constexpr auto al = std::align_val_t{alignof(CacheSlot)};
void* raw  = ::operator new(sizeof(CacheSlot), al);
auto* slot = std::construct_at(static_cast<CacheSlot*>(raw));
std::destroy_at(slot);
::operator delete(raw, al);     // WRONG: ::operator delete(raw)  → UB
```

```cpp
// ---- alignment spellings -------------------------------------------------
alignas(16)            int  x;              // strengthen
alignas(int)           char c;              // borrow another type's alignment
alignas(alignof(long)) char d;
struct alignas(64) Padded { int a; };       // whole-type alignment
struct S { alignas(8) char buf[8]; };       // member alignment
// alignas(1) double bad;                   // ill-formed: cannot weaken
constexpr std::size_t A = alignof(std::max_align_t);   // default-new-ish bound
using Cache = std::aligned_storage_t<64, 64>;          // DEPRECATED in C++23

// C++17 padding constants for false-sharing control
struct alignas(std::hardware_destructive_interference_size) Counter {
    std::atomic<std::uint64_t> value{};
};
```

```cpp
// ---- carving aligned sub-blocks out of one buffer ------------------------
alignas(64) std::byte buffer[4096];
void*       ptr   = buffer;
std::size_t space = sizeof buffer;
if (void* aligned = std::align(alignof(CacheSlot), sizeof(CacheSlot), ptr, space)) {
    auto* here = std::construct_at(static_cast<CacheSlot*>(aligned));
    ptr = static_cast<std::byte*>(ptr) + sizeof(CacheSlot);   // std::align advanced ptr/space
    std::destroy_at(here);
}
auto* hint = std::assume_aligned<64>(reinterpret_cast<CacheSlot*>(buffer)); // C++20
```

| Facility | Meaning |
|---|---|
| `alignof(T)` | alignment requirement in bytes (power of two) |
| `alignas(N)` / `alignas(T)` | strengthen only; weakening is ill-formed |
| `__STDCPP_DEFAULT_NEW_ALIGNMENT__` | max alignment plain `operator new` guarantees |
| `std::align_val_t` | scoped enum tag selecting aligned allocation overloads |
| `std::max_align_t` | type with the greatest fundamental alignment |
| `std::align(a, size, ptr&, space&)` | in-place pointer bump; returns `nullptr` if it does not fit |
| `std::assume_aligned<N>(p)` | promise to the optimizer; UB if violated |
| `std::hardware_destructive_interference_size` | pad to avoid false sharing |
| `std::hardware_constructive_interference_size` | pack to share a line |

**Traps** — an allocation being large enough does not make every interior offset aligned · over-alignment inflates `sizeof` (padded up to a multiple of alignment) so arrays stay aligned · `malloc`/`std::aligned_alloc` results must be `free`d, never `operator delete`d · `std::aligned_alloc` requires `size % alignment == 0` and is absent on MSVC · aligned storage acquired with `align_val_t` and released without it is UB · `alignas` on a `std::vector` element does not align the *vector's* buffer unless the allocator honors it (`std::allocator` does since C++17).

---

## 23.4 Placement `new`, explicit destruction, and raw storage

```cpp
#include <array>
#include <cstddef>
#include <memory>
#include <new>

// ---- standard placement form: constructs, never allocates ----------------
alignas(Order) std::array<std::byte, sizeof(Order)> storage{};
Order* p = ::new (static_cast<void*>(storage.data())) Order{123};   // classic
Order* q = std::construct_at(reinterpret_cast<Order*>(storage.data()), 123); // C++20
use(*p);
std::destroy_at(p);          // ends lifetime; storage untouched
// delete p;                 // UB: storage did not come from an allocation function
```

```cpp
// ---- the six proof obligations of placement construction -----------------
// 1. sizeof(storage) >= sizeof(T)
// 2. address % alignof(T) == 0
// 3. no other live object occupies the region
// 4. construction completes before the pointer is used as T*
// 5. destruction happens exactly once, before storage is released or reused
// 6. the backing storage outlives every object and every pointer into it
```

```cpp
// ---- exception-safe partial array construction ---------------------------
template<class T>
void construct_n(T* first, std::size_t n) {
    std::size_t built = 0;
    try {
        for (; built != n; ++built) std::construct_at(first + built);
    } catch (...) {
        while (built != 0) std::destroy_at(first + --built);   // only [0, built) are live
        throw;
    }
}
// Library equivalents already do this (and are the ones you should use):
std::uninitialized_value_construct_n(first, n);
std::uninitialized_copy_n(src, n, first);
std::uninitialized_move_n(src, n, first);      // C++17
std::uninitialized_fill_n(first, n, value);
std::destroy_n(first, n);
```

```cpp
// ---- a typed slot: the minimum honest raw-storage abstraction -------------
template<class T>
class Slot {
    alignas(T) std::byte buf_[sizeof(T)];
    bool live_{false};
public:
    template<class... A> T& emplace(A&&... a) {
        assert(!live_);
        T* r = std::construct_at(ptr(), std::forward<A>(a)...);
        live_ = true;
        return *r;
    }
    void reset() noexcept { if (live_) { std::destroy_at(ptr()); live_ = false; } }
    T*   ptr() noexcept { return reinterpret_cast<T*>(buf_); }
    T&   get() noexcept { assert(live_); return *std::launder(ptr()); }
    ~Slot() { reset(); }
    Slot() = default;
    Slot(Slot const&) = delete;                 // raw storage is not copyable by default
    Slot& operator=(Slot const&) = delete;
};
// In real code: std::optional<T> gives exactly this, correctly, for free.
```

```cpp
// ---- storage reuse and std::launder --------------------------------------
struct Quote { int bid; int ask; };
Quote qq{100, 102};
std::destroy_at(&qq);
std::construct_at(&qq, Quote{101, 103});   // same type: transparently replaceable
use(qq);                                   // OK, no launder needed here

struct WithConst { const int id; int px; };
WithConst w{1, 100};
std::destroy_at(&w);
auto* w2 = std::construct_at(&w, WithConst{2, 101});
// use(w);          // UB: old name refers to a non-transparently-replaceable object
use(*w2);           // OK — or use(*std::launder(&w))

// C++23: reinterpret bytes as implicit-lifetime objects, legally
std::byte* bytes = recv_buffer();
struct Header { std::uint32_t len; std::uint16_t type; };   // implicit-lifetime
Header* h = std::start_lifetime_as<Header>(bytes);          // C++23, no copy
```

| Operation | Ends lifetime | Releases storage |
|---|---|---|
| `delete p` | yes | yes |
| `p->~T()` / `std::destroy_at(p)` | yes | **no** |
| `::operator delete(p)` | **no** | yes |
| arena/`monotonic_buffer_resource::release()` | **no** | yes (bulk) |
| placement `new (p) T` | starts a new one | no |
| `std::start_lifetime_as<T>` (C++23) | starts (implicit-lifetime only) | no |

**Traps** — placement new into a `std::byte[]` without `alignas` is UB for over-aligned `T` · `delete` on a placement-constructed pointer is UB · forgetting the destructor for a non-trivial `T` in a slot/arena leaks resources (not bytes) · `std::launder` is required after reusing storage that held const/reference members · a `union` member switch needs destroy + construct, not assignment · never destroy an automatic object and let scope destroy it again without a replacement · `std::aligned_storage` is deprecated in C++23 — use `alignas(T) std::byte[sizeof(T)]`.

---

## 23.5 Sized delete and destroying delete

```cpp
// ---- sized deallocation (C++14) ------------------------------------------
struct Node {
    static void* operator new(std::size_t n)                 { return pool_alloc(n); }
    static void  operator delete(void* p) noexcept           { pool_free(p, 0); }
    static void  operator delete(void* p, std::size_t n) noexcept { pool_free(p, n); }
    // The sized form is PREFERRED by lookup when both exist; size lets a
    // size-class allocator skip its metadata lookup.
};
// Global sized form exists too; -fsized-deallocation controls whether the
// compiler actually emits calls to it. If you replace one, replace both.
```

```cpp
// ---- destroying delete (C++20) -------------------------------------------
struct Message {
    std::size_t payload_bytes;
    static void operator delete(Message* p, std::destroying_delete_t) noexcept {
        std::size_t n = sizeof(Message) + p->payload_bytes;  // read BEFORE destroying
        p->~Message();                                       // WE must destroy
        ::operator delete(p, n);                             // then release
    }
};
Message* m = make_variable_length_message();
delete m;   // destructor NOT called separately; the function above does everything
```

```cpp
// ---- why: variable-length / self-describing layouts -----------------------
// Classic problem: the correct deallocation size depends on member state that
// the destructor has already destroyed by the time plain operator delete runs.
// Destroying delete inverts the order so the size can still be computed.

// Polymorphic variant: takes the most-derived pointer type of the static class.
struct BaseD {
    virtual ~BaseD() = default;
    static void operator delete(BaseD* p, std::destroying_delete_t) noexcept;
};
```

| Overload | Signature | Selected when |
|---|---|---|
| plain | `void operator delete(void*) noexcept` | fallback |
| sized | `void operator delete(void*, std::size_t) noexcept` | preferred if declared (C++14) |
| aligned | `void operator delete(void*, std::align_val_t) noexcept` | `alignof(T)` over-aligned (C++17) |
| sized+aligned | `void operator delete(void*, std::size_t, std::align_val_t) noexcept` | both above |
| placement partner | `void operator delete(void*, Args...) noexcept` | constructor throws after matching placement `new` |
| destroying | `void operator delete(T*, std::destroying_delete_t) noexcept` | C++20; wins over all others; suppresses the separate dtor call |

**Interview line** — "Destroying delete makes the deallocation function responsible for invoking the destructor, so it can read object state to compute the release size."

**Traps** — every deallocation function is implicitly `noexcept`; throwing from one calls `std::terminate` · declaring only the sized form and letting a build disable sized deallocation silently changes which overload is called · destroying delete is not a substitute for a virtual destructor or for RAII · in a destroying-delete body the object is still alive on entry — you must destroy it exactly once · class `operator delete` is always `static` even without the keyword.

---

## 23.6 Fragmentation, allocator metadata, and tail latency

```text
malloc fast path:   thread cache hit → pop free-list head        ~20-50 ns
malloc slow path:   size-class refill → central lock → contention  100s ns
malloc slowest:     mmap/brk growth → page fault on first touch    µs
free (remote):      block owned by another thread's cache → handoff/atomic
```

| Cost source | Latency implication |
|---|---|
| Free-list search / coalescing | work varies with allocator *state*, not request size |
| Lock or atomic contention | cross-thread queueing → multi-µs jitter at p99.9 |
| Metadata access | extra cache lines and TLB entries per allocation |
| External fragmentation | free bytes exist but not contiguously in the needed class |
| Internal fragmentation | 33-byte request lands in a 48-byte class → 31% waste |
| First touch / heap growth | new pages fault on write; `MAP_POPULATE`/warmup avoids it |
| Remote free | alloc on thread A, free on thread B → cross-thread handoff |
| Destruction cascade | one `delete` on a graph root frees thousands of nodes |
| NUMA placement | first-touch decides the node; migration is expensive |

```cpp
// ---- hidden allocations that "allocation-free" code still performs --------
std::string s = "a 40-character string exceeds typical SSO";  // heap
std::function<void()> f = [big = std::array<char,64>{}]{};    // heap (SBO exceeded)
std::any a = BigType{};                                       // heap
throw std::runtime_error{"msg"};                              // exception object + what()
auto task = coro();                     // coroutine frame unless HALO elides it
std::shared_ptr<T> sp(new T);           // TWO allocations (object + control block)
auto sp2 = std::make_shared<T>();       // ONE allocation
std::vector<int> v; v.push_back(1);     // first push allocates
std::unordered_map<int,int> m; m[1]=1;  // bucket array + node
std::stable_sort(b, e);                 // allocates a temporary buffer
std::regex re{"..."};                   // allocates on construction
std::this_thread::get_id();             // fine; but iostreams/locale first use allocates
```

```cpp
// ---- measuring, not asserting -------------------------------------------
// Interpose to count allocations around a warmed, representative workload.
static std::atomic<std::uint64_t> g_allocs{0}, g_bytes{0};
void* operator new(std::size_t n) {
    g_allocs.fetch_add(1, std::memory_order_relaxed);
    g_bytes.fetch_add(n, std::memory_order_relaxed);
    if (void* p = std::malloc(n ? n : 1)) return p;
    throw std::bad_alloc{};
}
void operator delete(void* p) noexcept           { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
```

```bash
# external evidence
LD_PRELOAD=/usr/lib/libtcmalloc.so ./bench      # swap allocators to see sensitivity
valgrind --tool=massif ./bench                  # heap profile over time
heaptrack ./bench                               # per-callsite allocation counts
perf stat -e page-faults,minor-faults ./bench   # first-touch cost
MALLOC_ARENA_MAX=2 ./bench                      # glibc arena/fragmentation knob
```

- The standard specifies allocation *semantics*, never allocator algorithms or latency bounds.
- Big-O never measures fragmentation: it is a property of allocator state history, not of one call.
- A warm benchmark that happens not to allocate proves nothing about a later size that crosses a capacity or size class.

**Traps** — measuring only mean latency hides the allocator's tail entirely · a "no-allocation" claim that excludes error/recovery/shutdown paths is not a latency contract · `shrink_to_fit` and `clear()`+refill can *cause* fragmentation churn · allocating on one thread and freeing on another is the most common source of hidden contention.

---

## 23.7 Preallocation, object reuse, and capacity planning

```text
setup:        allocate + construct pools/containers + validate every limit
steady state: reuse live slots or construct into reserved slots; never grow silently
shutdown:     destroy live objects, then release storage after all users stop
```

```cpp
// ---- capacity as a CONTRACT, not a prediction -----------------------------
template<class T>
class BoundedVector {
public:
    explicit BoundedVector(std::size_t limit) : limit_{limit} { values_.reserve(limit); }
    [[nodiscard]] bool push(T value) {                 // false == exhausted, deterministic
        if (values_.size() == limit_) return false;
        values_.push_back(std::move(value));           // provably no reallocation
        return true;
    }
    void clear() noexcept { values_.clear(); }         // keeps capacity
    std::span<T> elements() noexcept { return values_; }
private:
    std::vector<T> values_;
    std::size_t    limit_;
};
// reserve() alone is a hope; the size check is the contract.
```

```cpp
// ---- fixed-block pool: stable addresses, O(1) acquire/release ------------
template<class T, std::size_t N>
class Pool {
    alignas(T) std::byte storage_[N * sizeof(T)];
    std::array<std::uint32_t, N> next_{};              // intrusive free list of indices
    std::uint32_t head_{0};
    std::size_t   live_{0};
public:
    Pool() noexcept { for (std::uint32_t i = 0; i < N; ++i) next_[i] = i + 1; }
    template<class... A> T* acquire(A&&... a) {
        if (head_ == N) return nullptr;                // explicit exhaustion
        std::uint32_t i = head_; head_ = next_[i];
        ++live_;
        return std::construct_at(slot(i), std::forward<A>(a)...);
    }
    void release(T* p) noexcept {
        std::destroy_at(p);                            // storage reuse REQUIRES this
        auto i = static_cast<std::uint32_t>(p - slot(0));
        next_[i] = head_; head_ = i; --live_;
    }
    ~Pool() { /* caller must have released all; live_ == 0 asserted in debug */ }
    T* slot(std::uint32_t i) noexcept {
        return reinterpret_cast<T*>(storage_ + i * sizeof(T));
    }
};
```

```cpp
// ---- pmr: move allocator choice out of the type ---------------------------
#include <memory_resource>
alignas(64) std::array<std::byte, 1 << 16> buf;
std::pmr::monotonic_buffer_resource arena{buf.data(), buf.size(),
                                          std::pmr::null_memory_resource()};
std::pmr::vector<int>            v{&arena};      // allocator is a runtime value
std::pmr::string                 s{&arena};
std::pmr::unordered_map<int,int> m{&arena};
v.reserve(1024);
arena.release();                                 // bulk free — runs NO destructors

std::pmr::unsynchronized_pool_resource pool{&arena};   // size-classed, single-thread
std::pmr::synchronized_pool_resource   spool{};        // locked variant
std::pmr::set_default_resource(&arena);                // process-global default
std::pmr::memory_resource* d = std::pmr::get_default_resource();
```

| Resource | Behavior | Use |
|---|---|---|
| `new_delete_resource()` | forwards to global `new`/`delete` | default |
| `null_memory_resource()` | always throws `bad_alloc` | prove no upstream fallback |
| `monotonic_buffer_resource` | bump pointer; `deallocate` is a no-op; `release()` frees all | per-frame/per-message arenas |
| `unsynchronized_pool_resource` | size-classed pools, no locking | single-threaded reuse |
| `synchronized_pool_resource` | same, thread-safe | shared reuse |

| Reuse strategy | Benefit | Obligation |
|---|---|---|
| Keep objects alive, assign new values | simplest lifetime | must reset *every* semantic field; assignment may allocate |
| Destroy + reconstruct slots | supports non-assignable/const-member types | exact live-slot tracking + exception rollback |
| Monotonic arena | near-free allocation, bulk release | no individual reclamation; destructors are your job |
| Fixed-block pool | stable addresses, O(1), no fragmentation | exhaustion policy, alignment, free list |
| Index handles into pre-sized arrays | compact, cache-friendly, relocation-proof | generation counters + bounds validation |

- Plan capacity for: burst size, recovery overlap, in-flight objects awaiting consumers, telemetry backlog, and a *deterministic* exhaustion action.
- An allocator does not make a container thread-safe.
- `std::pmr` containers of different resources are different *values* of the same type — assignment does not propagate the resource.

**Traps** — `arena.release()` with live non-trivial objects leaks their owned resources · `pmr` containers hold a raw `memory_resource*`: the resource must outlive the container (declare it *first*) · copying a `pmr` container uses the *destination's* resource, a move between different resources degrades to element-wise move · `reserve` on `vector<T>` still allocates *inside* `T` if `T` owns memory.

---

## 23.8 Avoiding allocation without violating lifetime rules

```cpp
// ---- reserved bytes are not objects --------------------------------------
std::vector<Order> orders;
orders.reserve(128);
// orders[0] = Order{1};      // UB: size() == 0, no live element there
orders.emplace_back(1);       // constructs element 0
orders.resize(128);           // NOW 128 live, value-initialized elements exist
```

```cpp
// ---- bytes are not construction ------------------------------------------
struct Owner { std::unique_ptr<int> p; };
Owner o;
// std::memset(&o, 0, sizeof o);      // corrupts a live object; leaks; not a "reset"
// std::memcpy(&o2, &o, sizeof o);    // UB: not trivially copyable — double free
o = Owner{};                          // correct reset: assignment

struct Pod { int a; float b; };                     // trivially copyable
static_assert(std::is_trivially_copyable_v<Pod>);
Pod src{1, 2.f}, dst;
std::memcpy(&dst, &src, sizeof dst);                 // OK
auto bits = std::bit_cast<std::uint64_t>(src);       // C++20: typed, constexpr, safer
Pod back  = std::bit_cast<Pod>(bits);
```

```cpp
// ---- allocation-free alternatives, by shape -------------------------------
std::optional<Order>            maybe;          // in-place storage + engaged flag
std::variant<Ack, Fill, Reject> event;          // in-place tagged union
std::array<Level, 4096>         ladder{};       // fixed extent, no allocation
std::span<Level>                view{ladder};   // non-owning: pointer + extent
std::string_view                sym{"ESZ5"};    // non-owning chars
std::inplace_vector<int, 64>    small;          // C++26; today: static_vector equivalent
std::function_ref<void(int)>    cb;             // C++26 non-owning callable
// today's stand-ins: a template parameter, a raw fn-pointer + void*, or
//   struct Callback { void (*fn)(void*, int); void* ctx; };
char buf[64];
auto [ptr, ec] = std::to_chars(buf, buf + sizeof buf, 12345);   // no allocation
```

```cpp
// ---- hot-path allocation audit checklist ---------------------------------
// 1. Can a container exceed size()/capacity() or rehash?          → reserve + enforce
// 2. Can a string exceed SSO (~15-22 bytes, impl-defined)?        → fixed buffer / to_chars
// 3. Does type erasure or a coroutine allocate state?             → templates / HALO / custom
//                                                                    operator new on the promise
// 4. Does the error path allocate exception or log storage?       → error codes / expected
// 5. Does ownership use a separate control block or node?         → make_shared / intrusive
// 6. Is memory freed on a different thread than it was allocated? → per-thread pools
// 7. Does reuse preserve alignment and exact destruction?         → typed slots, not memset
// 8. Is exhaustion visible to the caller?                         → bool/expected, not throw
```

```cpp
// ---- coroutine frames: the allocation you cannot see ---------------------
struct Task {
    struct promise_type {
        static void* operator new(std::size_t n) { return frame_pool().alloc(n); }
        static void  operator delete(void* p, std::size_t n) noexcept { frame_pool().free(p, n); }
        // ...
    };
};
```

| Want to avoid | Reach for | Caveat |
|---|---|---|
| `std::string` heap | `std::string_view`, `char[N]`, `std::to_chars` | view must not outlive its buffer |
| `std::function` heap | template param, `function_ref`, fn-ptr + `void*` | callable must outlive the ref |
| `vector` growth | `reserve` + size check, `std::array`, ring buffer | must enforce, not assume |
| node containers | flat/sorted `vector`, open-addressing map | different invalidation rules |
| `shared_ptr` control block | `make_shared`, intrusive refcount, index handles | `make_shared` delays block free with `weak_ptr` |
| exception allocation | `std::expected` / error codes | changes API shape |
| coroutine frame | HALO elision, custom promise `operator new` | elision is not guaranteed |

**Interview line** — "`reserve` establishes capacity, not objects: it changes where the next element can go, never how many are alive."

**Traps** — `memset` on a non-trivial type destroys invariants silently and passes tests · `reinterpret_cast<T*>(bytes)` without `start_lifetime_as` (C++23) or an actual construction is UB even when the bytes are right · dangling `string_view`/`span` are the standard cost of avoiding allocation — pin the owner's lifetime · SSO capacity is implementation-defined, so "short strings don't allocate" is not portable · an `expected<T, E>` with a large `E` costs size on every hot return.
