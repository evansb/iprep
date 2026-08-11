# 10. RAII and smart pointers

*Part II — Classes, resource management, and generic programming*

---

**Recall**
- RAII binds a resource invariant to an object's lifetime: acquire in the constructor/factory, release exactly once in a non-throwing destructor.
- Destructors run on every normal scope exit *and* during stack unwinding — `return`, `break`, `goto`, and `throw` are all covered.
- Destructors do **not** run for `std::abort`, `std::_Exit`, `std::quick_exit`, a crash, a leaked object, or the automatic objects abandoned by `std::exit`.
- A destructor is implicitly `noexcept`; throwing from one during unwinding calls `std::terminate`.
- Fallible finalization needs an explicit `close()`/`flush()`/`commit()` that can report errors; the destructor is the best-effort net.
- `unique_ptr<T, D>` is the default dynamic owner: non-copyable, movable, zero overhead over a raw pointer for a stateless deleter.
- The deleter is part of `unique_ptr`'s *type*, so it changes conversions, `pointer` alias, and often `sizeof`.
- `release()` relinquishes ownership and returns the pointer — it never deletes; `reset()` deletes.
- `unique_ptr<T>` tolerates incomplete `T` at declaration, but the destructor must be instantiated where `T` is complete (pImpl: out-of-line `~Engine()`).
- `shared_ptr` holds a *stored pointer* plus a *control-block pointer*; the aliasing constructor lets the two describe different objects.
- Two `shared_ptr`s built independently from the same raw pointer get two control blocks and double-delete.
- Control-block refcount updates are atomic and thread-safe; the pointee and the `shared_ptr` *object itself* are not.
- `use_count()` is a racy snapshot — never a mutation permit.
- `weak_ptr` observes the control block without extending the object's life; only `lock()` is race-free, `expired()`-then-use is check-then-act.
- Two `shared_ptr` edges in a cycle keep counts above zero forever; make at least one edge `weak_ptr`.
- `shared_from_this()` throws `std::bad_weak_ptr` unless a `shared_ptr` already owns the object; `weak_from_this()` (C++17) never throws.
- `make_shared` co-allocates object + control block (one allocation, better locality) but weak owners keep that whole block alive after the object dies.
- `make_shared` cannot take a custom deleter; `shared_ptr<T>{new T, D}` can, at two allocations.
- Pass `T&`/`T*`/`span`/`string_view` to observe; pass smart pointers only when ownership actually moves or is shared.
- On hot paths every `shared_ptr` copy is a contended atomic RMW, and the last release runs the destructor on an arbitrary thread — prefer values, `unique_ptr` transfer, or index/generation handles.

---

## 10.1 RAII and deterministic cleanup

```cpp
#include <mutex>
#include <fstream>
#include <thread>

// ---- the shape of every RAII type -------------------------------------
class Buffer {
public:
    explicit Buffer(std::size_t n)                    // 1. acquire = establish invariant
        : data_{static_cast<std::byte*>(::operator new(n))}, size_{n} {}

    ~Buffer() { ::operator delete(data_); }           // 3. release, never throws

    Buffer(Buffer const&)            = delete;        // non-copyable...
    Buffer& operator=(Buffer const&) = delete;
    Buffer(Buffer&& o) noexcept                        // ...but movable: steal + null out
        : data_{std::exchange(o.data_, nullptr)}, size_{std::exchange(o.size_, 0)} {}
    Buffer& operator=(Buffer&& o) noexcept {
        Buffer tmp{std::move(o)};                      // move-and-swap: self-assign safe
        swap(tmp);
        return *this;
    }
    void swap(Buffer& o) noexcept { std::swap(data_, o.data_); std::swap(size_, o.size_); }

    std::span<std::byte> bytes() noexcept { return {data_, size_}; }   // 2. use
private:
    std::byte*  data_{};
    std::size_t size_{};
};
```

```cpp
// ---- every exit path unlocks ------------------------------------------
void process(std::mutex& m, Book& book) {
    std::lock_guard lock{m};    // CTAD: std::lock_guard<std::mutex>
    validate(book);             // may throw  -> ~lock_guard during unwinding
    if (book.empty()) return;   // early return -> ~lock_guard
    apply(book);                // fallthrough  -> ~lock_guard
}
```

```cpp
// ---- destruction order: reverse of construction ------------------------
struct Trace { char id; ~Trace() { std::print("{}", id); } };
void order() { Trace a{'a'}; Trace b{'b'}; Trace c{'c'}; }   // prints "cba"

struct Service {
    Queue        queue_;    // constructed 1st, destroyed LAST
    Logger       log_;      // 2nd
    std::jthread worker_;   // constructed LAST, destroyed 1st: stop + join
};                          // => worker cannot outlive the queue it drains
```

```cpp
// ---- fallible teardown needs an explicit channel -----------------------
class Writer {
public:
    [[nodiscard]] std::expected<void, std::error_code> close();  // reportable  (C++23)
    ~Writer() noexcept { if (open_) (void)close(); }             // best-effort net
private:
    bool open_{true};
};
```

| RAII covers | RAII does **not** cover |
|---|---|
| `return`, `break`, `continue`, `goto` out of scope | `std::abort()`, `std::_Exit()`, `std::quick_exit()` |
| Exception unwinding to a handler | Uncaught exception where the impl. does not unwind |
| Member/base subobject teardown | `std::exit()` — abandoned stack frames |
| Container element destruction | Leaked object (owner itself never destroyed) |
| Temporaries at end of full-expression | Detached `std::thread`, killed process, power loss |

| Resource | Canonical RAII owner |
|---|---|
| Heap object / array | `std::vector`, `std::unique_ptr`, `std::shared_ptr` |
| Mutex ownership | `lock_guard`, `unique_lock`, `scoped_lock`, `shared_lock` |
| File stream | `std::fstream` / `std::ofstream` |
| POSIX fd / socket | project-specific movable wrapper (see 10.8) |
| `mmap` region | wrapper storing `{addr, len}`, calls `munmap` |
| Transaction | commit/rollback guard (`scope_fail`) |
| Thread | `std::jthread` (C++20), or `std::thread` + explicit joiner |
| Coroutine frame | `unique_ptr<promise, handle_deleter>` or an owning task type |

**Interview line** — "RAII means the only cleanup path is the destructor, so correctness does not depend on remembering an exit."

**Traps** — a throwing destructor during unwinding terminates · `~T()` is `noexcept` by default, so any escape is a `terminate`, not a rethrow · declaring *any* of copy/move/dtor suppresses or deletes others (Rule of 0/3/5) · a moved-from owner must be safely destructible · member declaration order silently fixes teardown order.

---

## 10.2 Scope guards and `std::scope_exit` / `scope_fail` / `scope_success`

> **Not ISO C++23.** `<scope>` guards (`scope_exit`, `scope_fail`, `scope_success`, `unique_resource`) are Library Fundamentals TS v3, not C++23 — the source TOC mislabels them. Feature-test with `__cpp_lib_scope_guard` / `__cpp_lib_experimental_scope` and keep a hand-rolled guard as the portable fallback.

```cpp
#include <scope>            // LFTS v3, NOT C++23; guard with __cpp_lib_scope_guard

// ---- scope_exit: unconditional ----------------------------------------
bool update_index(Index& index, Entry e) {
    index.begin_update();
    std::scope_exit finish{[&]() noexcept { index.end_update(); }};
    if (!index.insert(std::move(e))) return false;   // finish runs
    return true;                                     // finish runs
}                                                    // ...and on unwinding

// ---- scope_fail / scope_success ---------------------------------------
void commit(Transaction& tx) {
    std::scope_fail    rollback{[&]() noexcept { tx.rollback(); }};  // only if throwing out
    std::scope_success audit   {[&]           { record_commit(); }}; // only if not
    tx.apply();
    tx.commit();
}

// ---- release(): disarm -------------------------------------------------
auto raw = allocate();
std::scope_exit undo{[&]() noexcept { deallocate(raw); }};
auto owner = adopt(raw);     // may throw -> undo fires
undo.release();              // succeeded -> cancel the action, owner now responsible
```

```cpp
// ---- std::unique_resource (LFTS v3 <scope>, NOT C++23) -----------------
std::unique_resource file{
    std::fopen("capture.bin", "rb"),                       // resource
    [](std::FILE* f) noexcept { if (f) std::fclose(f); }}; // deleter
if (file.get()) std::fread(buf, 1, n, file.get());
file.release();                                            // disown, no close
file.reset(std::fopen("other.bin", "rb"));                 // close old, adopt new

auto fd = std::make_unique_resource_checked(              // skips deleter on failure
    ::open("f", O_RDONLY), -1, [](int d) noexcept { ::close(d); });
```

| Guard | Action runs when scope exits and… | Typical use |
|---|---|---|
| `std::scope_exit` | …for any reason, while active | unconditional undo / end-of-phase |
| `std::scope_fail` | …with **more** uncaught exceptions than at construction | rollback, error counters |
| `std::scope_success` | …without an increased uncaught-exception count | audit, publish, commit hooks |
| `std::unique_resource` | …destroying a *resource + deleter* pair | generic non-pointer RAII |

| Member | Effect |
|---|---|
| `release()` | Make the guard inactive — the action will **not** run (for `unique_resource`: disown without deleting) |
| `reset()` (`unique_resource`) | Invoke deleter on the current resource, become empty |
| `reset(r)` | Invoke deleter on the old resource, adopt `r` |
| `get()` / `operator*` / `operator->` | Observe the held resource |
| `get_deleter()` | Access the deleter object |
| move-construct | Transfers activity; source becomes inactive |

```cpp
// ---- portable fallback when <scope> is unavailable ---------------------
#if !defined(__cpp_lib_scope_guard)
template<class F>
class ScopeExit {
public:
    explicit ScopeExit(F f) noexcept : f_{std::move(f)} {}
    ~ScopeExit() noexcept { if (active_) f_(); }
    void release() noexcept { active_ = false; }
    ScopeExit(ScopeExit const&) = delete;
    ScopeExit& operator=(ScopeExit const&) = delete;
private:
    F f_; bool active_{true};
};
#endif
```

- Guards are non-copyable; move construction transfers the armed state and disarms the source.
- The exception-count classification comes from `std::uncaught_exceptions()`, not from your error semantics.
- Captured references must outlive the guard — a guard declared *before* what it captures is a dangling-use bug.

**Traps** — `return false` is a *success* to `scope_success`, not a failure · a throwing `scope_exit` callback terminates, so mark cleanup lambdas `noexcept` · constructing/moving a stateful callable can itself throw before the guard is armed · library support lags the language mode: feature-test `__cpp_lib_scope_guard` · declare the guard *immediately* after acquisition, never after intervening throwing code.

---

## 10.3 `std::unique_ptr`, custom deleters, arrays, and incomplete types

```cpp
#include <memory>

// ---- construction ------------------------------------------------------
std::unique_ptr<Decoder> p0;                              // empty, == nullptr
std::unique_ptr<Decoder> p1{nullptr};                     // empty
std::unique_ptr<Decoder> p2{new Decoder{cfg}};            // explicit ctor only
auto p3 = std::make_unique<Decoder>(cfg);                 // preferred (C++14)
auto p4 = std::make_unique_for_overwrite<Decoder>();      // default-init, no zeroing (C++20)
// std::unique_ptr<Decoder> bad = new Decoder;            // ill-formed: ctor is explicit

// ---- transfer ----------------------------------------------------------
std::unique_ptr<Decoder> moved = std::move(p3);           // p3 == nullptr (guaranteed)
std::unique_ptr<Codec>   base  = std::move(moved);        // derived->base if Codec has virtual dtor
sink(std::move(base));                                    // by-value param = ownership transfer
auto ret = make_decoder();                                // return by value, no std::move needed

// ---- observation & mutation -------------------------------------------
Decoder* raw = p2.get();          // observe; ownership unchanged
Decoder& r   = *p2;               // UB if empty
p2->start();                      // operator->
if (p2) p2->start();              // explicit operator bool
Decoder* orphan = p2.release();   // RELINQUISH: returns ptr, does NOT delete
p2.reset(orphan);                 // deletes current (none), adopts orphan
p2.reset();                       // deletes, becomes nullptr
p2.reset(nullptr);                // same
p2.swap(other);
p2 = nullptr;                     // equivalent to reset()
auto const& d = p2.get_deleter();

// ---- comparison --------------------------------------------------------
bool same = (p2 == other);        // compares stored pointers
auto ord  = (p2 <=> other);       // C++20 three-way over pointers
bool null = (p2 == nullptr);
```

```cpp
// ---- arrays ------------------------------------------------------------
auto bytes = std::make_unique<std::byte[]>(4096);           // value-initialized (zeroed)
auto fast  = std::make_unique_for_overwrite<std::byte[]>(4096); // NOT zeroed (C++20)
bytes[0] = std::byte{0x42};                                 // operator[] on T[] spec.
// bytes->x;                                                // no operator-> on T[]
std::unique_ptr<int[]> owned{new int[8]{}};                 // calls delete[]
std::span<std::byte> view{bytes.get(), 4096};               // length is NOT stored
// Prefer std::vector<T> whenever size, growth, or ranges are needed.
```

```cpp
// ---- custom deleters: four spellings -----------------------------------
struct FileCloser {                                     // 1. stateless functor: EBO -> 8 bytes
    void operator()(std::FILE* f) const noexcept { if (f) std::fclose(f); }
};
using FilePtr = std::unique_ptr<std::FILE, FileCloser>;
FilePtr file{std::fopen("capture.bin", "rb")};

using CFilePtr = std::unique_ptr<std::FILE, decltype(&std::fclose)>;   // 2. function ptr: 16 bytes
CFilePtr f2{std::fopen("x", "rb"), &std::fclose};

auto lam = [](std::FILE* f) noexcept { if (f) std::fclose(f); };       // 3. lambda (C++20 captureless
std::unique_ptr<std::FILE, decltype(lam)> f3{std::fopen("x","rb")};   //    types are default-ctible)

template<auto Fn>                                                      // 4. NTTP deleter: stateless
struct Call { template<class T> void operator()(T* p) const noexcept { Fn(p); } };
using XmlPtr = std::unique_ptr<xmlDoc, Call<xmlFreeDoc>>;
```

```cpp
// ---- fancy pointer via deleter::pointer --------------------------------
struct HandleDeleter {
    using pointer = Handle;                       // opt-in: stored type is NOT T*
    void operator()(Handle h) const noexcept { ::CloseHandle(h); }
};
using UniqueHandle = std::unique_ptr<void, HandleDeleter>;   // stores a Handle
static_assert(std::is_same_v<UniqueHandle::pointer, Handle>);
```

```cpp
// ---- incomplete types / pImpl ------------------------------------------
// engine.hpp
class EngineImpl;                       // incomplete
class Engine {
public:
    Engine();
    ~Engine();                          // DECLARED here, DEFINED in the .cpp
    Engine(Engine&&) noexcept;          // same rule: defaulted move-assign deletes the old impl
    Engine& operator=(Engine&&) noexcept;
private:
    std::unique_ptr<EngineImpl> impl_;
};
// engine.cpp
#include "engine_impl.hpp"              // EngineImpl now complete
Engine::Engine() : impl_{std::make_unique<EngineImpl>()} {}
Engine::~Engine() = default;            // default_delete instantiated HERE
Engine::Engine(Engine&&) noexcept = default;
Engine& Engine::operator=(Engine&&) noexcept = default;
```

| Member / free function | Complexity | Notes |
|---|---|---|
| `unique_ptr(p)` / `unique_ptr(p, d)` | O(1) | ctor from raw is `explicit`; deleter copied/moved |
| `~unique_ptr()` | deleter cost | calls `get_deleter()(get())` only if `get() != nullptr` |
| `operator=(unique_ptr&&)` | O(1) + delete | deletes the old target first |
| `operator=(nullptr_t)` | delete | same as `reset()` |
| `get()` | O(1) | observe; never transfers |
| `release()` | O(1) | returns pointer, sets to null, **no delete** |
| `reset(p = nullptr)` | delete | old deleted after the stored pointer is replaced |
| `swap(u)` / `std::swap` | O(1) | swaps pointer **and** deleter |
| `operator*` / `operator->` | O(1) | UB when empty; absent for `T[]` |
| `operator[](i)` | O(1) | `T[]` specialization only; unchecked |
| `explicit operator bool()` | O(1) | `get() != nullptr` |
| `get_deleter()` | O(1) | returns `D&` / `D const&` |
| `std::make_unique<T>(args…)` | one allocation | value/direct-init; **not** available with a custom deleter |
| `std::make_unique<T[]>(n)` | one allocation | value-initializes `n` elements |
| `std::make_unique_for_overwrite<T>()` | one allocation | default-init (C++20): trivial members left indeterminate |
| `std::default_delete<T>` | — | calls `delete`; `default_delete<T[]>` calls `delete[]` |

| Form | `sizeof` (typical) |
|---|---|
| `unique_ptr<T>` (default deleter) | 1 pointer — empty-base optimized |
| `unique_ptr<T, StatelessFunctor>` | 1 pointer |
| `unique_ptr<T, void(*)(T*)>` | 2 pointers |
| `unique_ptr<T, StatefulLambda>` | pointer + capture size (padded) |
| `shared_ptr<T>` | 2 pointers, always |

**Interview line** — "`unique_ptr` is the default owner because it costs nothing over a raw pointer and makes the single-owner contract a compile-time fact."

**Traps** — `release()` leaks unless the returned pointer is immediately adopted · `unique_ptr<T[]>` does not remember its length · `unique_ptr<Base>` on a `Derived` needs a virtual destructor (or a custom deleter) — `unique_ptr<T[]>` has no polymorphic form at all · a defaulted destructor *in the header* of a pImpl class instantiates `default_delete<Incomplete>` and is ill-formed (often only a warning) · `make_unique` cannot pass a custom deleter or a braced init-list requiring `initializer_list` narrowing control · self-`reset(p.get())` deletes then adopts a dangling pointer.

---

## 10.4 `std::shared_ptr` control blocks, aliasing, and atomic operations

```text
shared_ptr object (2 pointers, always)
  stored pointer  ─────────────► object / subobject (what * and -> yield)
  control pointer ─────────────► strong count (atomic)
                                 weak count  (atomic, +1 while strong > 0)
                                 type-erased deleter
                                 allocator state
                                 [make_shared only: inline object storage]
```

```cpp
// ---- construction ------------------------------------------------------
std::shared_ptr<Order> s0;                                  // empty: no ctrl block
auto s1 = std::make_shared<Order>(id, qty);                 // ONE allocation
auto s2 = std::allocate_shared<Order>(alloc, id, qty);      // one alloc from `alloc`
std::shared_ptr<Order> s3{new Order{id, qty}};              // TWO allocations
std::shared_ptr<Order> s4{new Order{}, OrderDeleter{}};     // custom deleter
std::shared_ptr<Order> s5{new Order{}, OrderDeleter{}, alloc};
std::shared_ptr<Order[]> arr{new Order[8]};                 // C++17: delete[] deleter
auto arr2 = std::make_shared<Order[]>(8);                   // C++20
auto arr3 = std::make_shared<Order[8]>();                   // C++20, extent in type
std::shared_ptr<Order> s6{std::move(unique)};               // adopt a unique_ptr (deleter kept)
std::shared_ptr<Order> s7{weak};                            // throws bad_weak_ptr if expired
std::shared_ptr<Order> s8{s1};                              // copy: strong count +1
std::shared_ptr<Order> s9{std::move(s1)};                   // move: NO atomic, s1 empty

// ---- aliasing constructor: share ctrl block, point elsewhere -----------
struct Snapshot { Header header; std::vector<Level> levels; };
auto snap = std::make_shared<Snapshot>();
std::shared_ptr<Header> hdr{snap, &snap->header};           // keeps whole Snapshot alive
std::shared_ptr<void>   any{snap};                          // type-erased owner
std::shared_ptr<Header> stolen{std::move(snap), &raw->header};  // C++20 aliasing move
```

```cpp
// ---- observation & mutation -------------------------------------------
Order* raw = s2.get();
*s2; s2->fill();
s2.reset();                            // drop this ownership
s2.reset(new Order{});                 // drop, adopt (NEW control block)
s2.reset(new Order{}, Deleter{});
s2.swap(other);
long n = s2.use_count();               // strong count SNAPSHOT (racy)
bool only = (s2.use_count() == 1);     // NOT a mutation permit
bool b = static_cast<bool>(s2);
bool before = s2.owner_before(other);  // strict weak order on CONTROL BLOCK identity
bool same_owner = !s2.owner_before(o) && !o.owner_before(s2);
std::size_t h = s2.owner_hash();       // C++26
bool eq = s2.owner_equal(other);       // C++26

// ---- casts (all share the control block) -------------------------------
auto d  = std::static_pointer_cast<Derived>(base);
auto d2 = std::dynamic_pointer_cast<Derived>(base);   // empty shared_ptr on failure
auto c  = std::const_pointer_cast<Order>(const_order);
auto r  = std::reinterpret_pointer_cast<Raw>(base);   // C++17
auto* dp = std::get_deleter<OrderDeleter>(s4);        // nullptr if type mismatches
```

```cpp
// ---- the double-control-block disaster ---------------------------------
Widget* raw = new Widget;
std::shared_ptr<Widget> a{raw};
// std::shared_ptr<Widget> b{raw};      // SECOND control block -> double delete, UB
std::shared_ptr<Widget> b = a;          // correct: copy an existing owner
// std::shared_ptr<Widget> c{a.get()};  // same bug, disguised
```

```cpp
// ---- atomic publication (C++20) ----------------------------------------
std::atomic<std::shared_ptr<Snapshot const>> current;

void publish(std::shared_ptr<Snapshot const> next) {
    current.store(std::move(next), std::memory_order_release);
}
void reader() {
    auto view = current.load(std::memory_order_acquire);   // takes a strong ref
    if (view) consume(*view);                              // *view must be immutable
}
std::shared_ptr<Snapshot const> old = current.exchange(next);
current.compare_exchange_strong(expected, desired);
bool lf = current.is_lock_free();     // frequently FALSE -> internal mutex

// Deprecated in C++20, removed in C++26: std::atomic_load/store/exchange(&sp)
```

| Member / free function | Complexity | Notes |
|---|---|---|
| copy ctor / copy assign | O(1) | **atomic** strong increment (+ old release) |
| move ctor / move assign | O(1) | no atomic traffic — prefer it |
| `~shared_ptr()` | O(1) + dtor on last | atomic decrement; last strong destroys the object |
| `get()` / `operator*` / `operator->` | O(1) | returns the **stored** pointer |
| `operator[](i)` | O(1) | `T[]` specializations (C++17) |
| `reset()` / `reset(p[, d[, a]])` | O(1) + maybe delete | `reset(p)` creates a **new** control block |
| `use_count()` | O(1) | strong count only; approximate under concurrency |
| `owner_before` / `owner_equal` / `owner_hash` | O(1) | control-block identity, not stored address |
| `swap` | O(1) | no refcount change |
| `std::make_shared<T>(args…)` | 1 allocation | value-init; no custom deleter; `T`'s ctor may be non-public → fails |
| `std::make_shared_for_overwrite<T>()` | 1 allocation | default-init (C++20) |
| `std::allocate_shared<T>(a, args…)` | 1 allocation via `a` | allocator rebound internally |
| `std::static_/dynamic_/const_/reinterpret_pointer_cast` | O(1) | new `shared_ptr` sharing the block |
| `std::get_deleter<D>(sp)` | O(1) | `D*` or `nullptr` |
| `std::atomic<shared_ptr<T>>::load/store/exchange/CAS` | O(1)* | *may take an internal lock |

| Concurrency question | Answer |
|---|---|
| Two threads copy/destroy **distinct** `shared_ptr`s to the same object | Safe — control-block counts are atomic |
| Two threads write the **same** `shared_ptr` object | Data race — use `std::atomic<shared_ptr<T>>` |
| One thread writes `*sp`, another reads `*sp` | Data race — `shared_ptr` synchronizes the count, never the pointee |
| Reader `load()`s while writer `store()`s a new snapshot | Safe with `atomic<shared_ptr>`; reader holds a strong ref |
| `use_count() == 1` then mutate | Racy — the count can change the next instruction |

**Interview line** — "A `shared_ptr` is two pointers: one says what you see, the other says what you own — and only the aliasing constructor lets those disagree."

**Traps** — building a second `shared_ptr` from `get()` double-deletes · `reset(p)` allocates a fresh control block rather than reusing one · aliasing keeps the *whole* parent alive, which is a memory-retention bug when the subobject is tiny · `shared_ptr<Base>` does **not** need a virtual destructor (the deleter is captured at construction from the *static* type given) — but only if the `shared_ptr<Derived>` was constructed first · `atomic<shared_ptr>` is rarely lock-free · destroying the last owner runs the destructor on *that* thread, wherever it happens to be.

---

## 10.5 `std::weak_ptr`, cycle breaking, and `enable_shared_from_this`

```cpp
// ---- weak_ptr basics ---------------------------------------------------
std::weak_ptr<Session> w0;                        // empty
std::weak_ptr<Session> w1 = shared;               // observe; weak count +1
std::weak_ptr<Session> w2{w1};
w1.reset();
long strong = w1.use_count();                     // STRONG count (0 if dead)
bool dead   = w1.expired();                       // == (use_count() == 0), racy alone

if (auto s = w1.lock()) {   // atomic: returns owner, or empty shared_ptr
    s->poll();              // safe for as long as `s` lives
}
std::shared_ptr<Session> strict{w1};              // throws std::bad_weak_ptr if expired
bool ord = w1.owner_before(w2);                   // control-block identity ordering
```

```cpp
// ---- breaking a cycle --------------------------------------------------
struct Parent;
struct Child  { std::weak_ptr<Parent> parent; };            // observing edge
struct Parent { std::vector<std::shared_ptr<Child>> kids; }; // owning edge
// Both edges shared_ptr => both counts stay >= 1 forever => leak, no destructors.

// caching without retention
std::unordered_map<Key, std::weak_ptr<Row>> cache;          // does not keep rows alive
if (auto it = cache.find(k); it != cache.end())
    if (auto row = it->second.lock()) return row;            // still alive
```

```cpp
// ---- enable_shared_from_this -------------------------------------------
class Session : public std::enable_shared_from_this<Session> {
public:
    static std::shared_ptr<Session> create() {           // force shared ownership
        return std::shared_ptr<Session>{new Session{}};  // make_shared blocked by private ctor
    }
    void keep_alive_during_io() {
        auto self = shared_from_this();                  // +1 strong, throws if unowned
        async_read([self](Bytes b) { self->on_read(b); });   // callback OWNS the session
    }
    void observe_only() {
        auto weak = weak_from_this();                    // C++17, never throws
        timer_.on_tick([weak] { if (auto s = weak.lock()) s->tick(); });  // no cycle
    }
private:
    Session() = default;
};
// Session s;  s.shared_from_this();      // throws std::bad_weak_ptr (stack object)
// std::shared_ptr<Session>{this};        // WRONG: second control block
```

| Member (`weak_ptr`) | Complexity | Notes |
|---|---|---|
| `weak_ptr(shared_ptr const&)` / `weak_ptr(weak_ptr const&)` | O(1) | atomic weak increment |
| `lock()` | O(1) | atomic strong-increment-if-nonzero; empty on expiry — the **only** race-free upgrade |
| `expired()` | O(1) | snapshot; check-then-act hazard |
| `use_count()` | O(1) | strong count |
| `reset()` / `swap()` | O(1) | |
| `owner_before` / `owner_equal` / `owner_hash` | O(1) | usable as map key / ordering |
| `shared_ptr(weak_ptr const&)` | O(1) | throws `std::bad_weak_ptr` instead of returning empty |

| `enable_shared_from_this<T>` member | Behavior |
|---|---|
| `shared_from_this()` | `shared_ptr<T>` sharing the existing block; **throws `bad_weak_ptr`** if none exists |
| `weak_from_this()` | `weak_ptr<T>` (C++17); empty rather than throwing when unowned |
| protected ctor/dtor | Prevents slicing; derive publicly and unambiguously (`T` must be the derived type) |

**Interview line** — "`weak_ptr::lock()` is the only race-free way to ask 'is it still alive?', because the answer and the ownership grab are one atomic step."

**Traps** — `expired()` followed by `lock()`/use is check-then-act · `weak_ptr` still pins the control block (and, for `make_shared`, the entire object storage) until it is reset · capturing `shared_from_this()` in a callback the object itself owns recreates the cycle · calling `shared_from_this()` inside the constructor throws — no owner exists yet · inheriting `enable_shared_from_this` privately, twice, or with the wrong `T` gives `bad_weak_ptr` or ambiguity · a raw `new T` combined with `enable_shared_from_this` is fine, but `shared_ptr<T>{this}` inside a member is not.

---

## 10.6 `make_unique`, `make_shared`, `allocate_shared`, and allocation count

```cpp
auto u  = std::make_unique<Order>(id, qty);                    // 1 alloc
auto uo = std::make_unique_for_overwrite<Order>();             // 1 alloc, default-init (C++20)
auto s  = std::make_shared<Order>(id, qty);                    // 1 alloc (object + ctrl)
auto so = std::make_shared_for_overwrite<Order>();             // C++20
auto a  = std::allocate_shared<Order>(alloc, id, qty);         // 1 alloc via `alloc`
std::shared_ptr<Order> t{new Order{id, qty}};                  // 2 allocs
std::shared_ptr<Order> d{new Order{}, Deleter{}};              // 2 allocs, custom deleter

std::pmr::monotonic_buffer_resource arena{buf.data(), buf.size()};
auto p = std::allocate_shared<Order>(
    std::pmr::polymorphic_allocator<Order>{&arena}, id, qty);  // arena-backed
```

| Factory | Allocations | Init | Custom deleter | Custom allocator |
|---|---|---|---|---|
| `make_unique<T>(args…)` | 1 | value/direct | no | no |
| `make_unique<T[]>(n)` | 1 | value-init all | no | no |
| `make_unique_for_overwrite<T>()` | 1 | default-init | no | no |
| `make_shared<T>(args…)` | 1 (co-allocated) | value/direct | **no** | no |
| `make_shared<T[]>(n)` / `<T[N]>()` | 1 | value-init (C++20) | no | no |
| `allocate_shared<T>(a, args…)` | 1 via `a` | value/direct | no | yes |
| `shared_ptr<T>{new T}` | 2 | direct | via 2nd arg | via 3rd arg |
| `shared_ptr<T>{std::move(uniq)}` | 1 extra (ctrl block) | — | inherited from `unique_ptr` | no |

```cpp
// ---- retention hazard: make_shared + long-lived weak_ptr ---------------
auto big = std::make_shared<std::array<std::byte, 1 << 20>>();  // 1 MiB co-allocated
std::weak_ptr<std::array<std::byte, 1 << 20>> obs = big;
big.reset();          // object DESTROYED, but the 1 MiB block stays until `obs` dies
// Fix: shared_ptr<T>{new T} -> object storage freed at strong 0, ctrl block is tiny.
```

```cpp
// ---- why factories exist: exception-safety of argument evaluation ------
// process(std::unique_ptr<A>{new A}, may_throw());   // pre-C++17 leak window
process(std::make_unique<A>(), may_throw());          // no raw owner is ever exposed
```

- Co-allocation gives one allocator round trip and one cache line covering both counts and object.
- With a separate control block the object's storage is freed when the strong count hits zero; the small block lingers for weak owners.
- `make_shared` needs an accessible constructor — a private ctor (factory pattern) forces `shared_ptr<T>{new T}` or a passkey.
- `make_shared` value-initializes (`T()`); `make_shared_for_overwrite` default-initializes — use it for large POD buffers to skip zeroing.
- Over-aligned `T` is handled by `make_shared` since C++17/20 library fixes, but verify with an old toolchain.

**Interview line** — "`make_shared` trades one allocation for delayed reclamation: weak owners keep the co-allocated object storage alive after the object is gone."

**Traps** — `make_shared` cannot express a custom deleter · `make_unique<T>({1,2,3})` may fail to deduce an `initializer_list` · `make_shared<T[]>` exists only since C++20 · `for_overwrite` leaves trivial members indeterminate — reading them is UB · adopting a `unique_ptr` into a `shared_ptr` still allocates a control block.

---

## 10.7 Ownership versus observation: raw pointer, reference, `span`, and `string_view`

```cpp
// ---- the parameter vocabulary ------------------------------------------
void must_read (Book const& b);                 // required, non-owning, sync
void must_write(Book& b);                       // required, mutable, sync
void maybe     (Book const* b);                 // optional, nullable, non-owning
void scan      (std::span<Level const> levels); // borrow contiguous elements
void log       (std::string_view msg);          // borrow chars, NOT null-terminated
void take      (std::unique_ptr<Book> b);       // ownership moves INTO callee
void share     (std::shared_ptr<Book> b);       // callee becomes a co-owner (by value!)
void observe   (std::weak_ptr<Book> b);         // callee may later upgrade
void reseat    (std::unique_ptr<Book>& b);      // callee may REPLACE the owner
void optional_ (std::optional<Book> b);         // optional VALUE, owned

// wrong-by-default:
// void f(std::shared_ptr<Book> const& b);   // couples API to ownership, gains none
// void g(std::unique_ptr<Book> const& b);   // hides the simpler Book const&
```

| Parameter | Promise | Cost |
|---|---|---|
| `T const&` | required, read-only, valid for the call | free |
| `T&` | required, mutable, valid for the call | free |
| `T const*` | optional (nullable), read-only | free |
| `std::span<T>` / `span<T const>` | borrow contiguous range, no ownership | 2 words |
| `std::string_view` | borrow characters, no NUL guarantee | 2 words |
| `T` by value | callee gets its own copy/move | copy or move |
| `std::unique_ptr<T>` by value | ownership transfers in | move |
| `std::shared_ptr<T>` by value | callee becomes an owner | atomic increment |
| `std::shared_ptr<T> const&` | callee *might* copy it | free, but leaks ownership into the API |
| `std::weak_ptr<T>` | callee observes without extending | atomic weak increment |

```cpp
// ---- span / string_view syntax -----------------------------------------
std::span<int>       d{v};                        // dynamic extent from a contiguous range
std::span<int, 4>    f{arr};                      // static extent, size in the type
std::span<int>       p{ptr, n};                   // pointer + count
std::span<int>       q{first, last};              // iterator pair
auto head = d.first(3);  auto tail = d.last(3);   // static or dynamic
auto mid  = d.subspan(2, 4);
auto raw  = std::as_bytes(d);                     // span<const std::byte>
auto wr   = std::as_writable_bytes(d);
d.size(); d.size_bytes(); d.empty(); d.data(); d.front(); d.back(); d[0];

using namespace std::literals;
std::string_view sv = "abc"sv;
sv.substr(1, 2); sv.remove_prefix(1); sv.remove_suffix(1);
sv.starts_with("ab"); sv.ends_with("c"); sv.contains("b");   // C++20/23
// std::fopen(sv.data(), "r");   // BUG: sv.data() need not be NUL-terminated
```

```cpp
// ---- dangling views ----------------------------------------------------
std::string_view bad = std::string{"temp"};       // dangles at end of full-expression
std::span<int>   s{make_vector()};                // dangles: temporary vector
auto            v = get_vector();
std::span<int>  ok{v};
v.push_back(1);                                   // realloc -> `ok` dangles

// ---- crossing an async boundary ----------------------------------------
void enqueue_bad (std::span<Tick const> ticks) { queue.push([ticks] { use(ticks); }); }  // UB
void enqueue_copy(std::span<Tick const> ticks) { queue.push(std::vector<Tick>{ticks.begin(), ticks.end()}); }
void enqueue_move(std::unique_ptr<Batch> b)    { queue.push(std::move(b)); }
void enqueue_share(std::shared_ptr<Batch const> b) { queue.push([b] { use(*b); }); }
void enqueue_handle(PoolIndex h)               { queue.push([h] { use(pool.at(h)); }); } // + generation check
```

- Ownership crosses a **thread or queue** boundary; observation stays within a proven-stable synchronous phase.
- `T*` means "optional and non-owning" only by convention — document it, or use `std::optional<std::reference_wrapper<T>>`/a named type.
- Returning `span`/`string_view` from a function is safe only when the backing storage outlives every caller (static, member, or caller-provided).

**Traps** — `string_view::data()` is not a C string · `span` over a `vector` dies on any reallocation · `const` on a `span` protects the *handle*, not the elements (`span<T const>` does) · binding a `T const&` parameter to a temporary is fine for the call and fatal if stored · `shared_ptr` by value in a hot loop is an atomic pair per call.

---

## 10.8 File descriptors, sockets, locks, mappings, and custom RAII wrappers

```cpp
// ---- integer-handle wrapper (fd, socket) -------------------------------
class UniqueFd {
public:
    UniqueFd() noexcept = default;
    explicit UniqueFd(int fd) noexcept : fd_{fd} {}
    ~UniqueFd() { reset(); }

    UniqueFd(UniqueFd const&)            = delete;
    UniqueFd& operator=(UniqueFd const&) = delete;
    UniqueFd(UniqueFd&& o) noexcept : fd_{std::exchange(o.fd_, -1)} {}
    UniqueFd& operator=(UniqueFd&& o) noexcept {
        if (this != &o) { reset(); fd_ = std::exchange(o.fd_, -1); }
        return *this;
    }

    [[nodiscard]] int  get()     const noexcept { return fd_; }
    [[nodiscard]] explicit operator bool() const noexcept { return fd_ != -1; }
    [[nodiscard]] int  release()       noexcept { return std::exchange(fd_, -1); }
    void reset(int repl = -1) noexcept {
        int old = std::exchange(fd_, repl);
        if (old != -1) ::close(old);        // EINTR: Linux already closed it — do not retry
    }
private:
    int fd_{-1};
};

// factory reports failure instead of publishing a half-owner
std::expected<UniqueFd, std::error_code> open_ro(char const* path) {     // C++23
    int fd = ::open(path, O_RDONLY | O_CLOEXEC);
    if (fd == -1) return std::unexpected{std::error_code{errno, std::generic_category()}};
    return UniqueFd{fd};
}
```

```cpp
// ---- mapping: address + length must travel together --------------------
class Mapping {
public:
    Mapping(void* addr, std::size_t len) noexcept : addr_{addr}, len_{len} {}
    ~Mapping() { if (addr_ != MAP_FAILED && addr_) ::munmap(addr_, len_); }
    Mapping(Mapping&& o) noexcept
        : addr_{std::exchange(o.addr_, nullptr)}, len_{std::exchange(o.len_, 0)} {}
    Mapping& operator=(Mapping&& o) noexcept { Mapping t{std::move(o)}; swap(t); return *this; }
    void swap(Mapping& o) noexcept { std::swap(addr_, o.addr_); std::swap(len_, o.len_); }
    std::span<std::byte const> bytes() const noexcept {
        return {static_cast<std::byte const*>(addr_), len_};
    }
private:
    void* addr_{}; std::size_t len_{};
};
```

```cpp
// ---- lock wrappers: every form -----------------------------------------
std::mutex m1, m2; std::shared_mutex sm; std::timed_mutex tm;

std::lock_guard  g{m1};                          // lock now, unlock at scope end; no members
std::scoped_lock s{m1, m2};                      // N mutexes, deadlock-avoiding std::lock
std::scoped_lock s0{};                           // zero mutexes: legal no-op
std::lock_guard  adopt{m1, std::adopt_lock};     // already locked by me

std::unique_lock u1{m1};                         // lock now
std::unique_lock u2{m1, std::defer_lock};        // do NOT lock yet
std::unique_lock u3{m1, std::try_to_lock};       // try; check u3.owns_lock()
std::unique_lock u4{m1, std::adopt_lock};        // adopt an existing lock
std::unique_lock u5{tm, std::chrono::milliseconds{5}};   // timed
u2.lock(); u2.unlock(); u2.try_lock();
bool held = u2.owns_lock();
auto* pm  = u2.mutex();
auto* rel = u2.release();                        // disown WITHOUT unlocking
cv.wait(u2, [&]{ return ready; });               // condition_variable needs unique_lock

std::shared_lock r{sm};                          // many readers
std::unique_lock w{sm};                          // one writer
```

| Wrapper | Locks | Movable | Deferred / timed / relock | CV-compatible |
|---|---|---|---|---|
| `std::lock_guard` | 1 | no | no | no |
| `std::scoped_lock` | 0..N | no | no (adopt only) | no |
| `std::unique_lock` | 1 | yes | yes | yes (`condition_variable`) |
| `std::shared_lock` | 1 shared | yes | yes | `condition_variable_any` |

| Handle checklist | Question to answer in the wrapper |
|---|---|
| Sentinel | Which value means "not owned"? (`-1`, `nullptr`, `INVALID_HANDLE_VALUE`, `MAP_FAILED`) |
| Zero validity | Is `0` a legal handle? (fd 0 is stdin — yes) |
| Retry semantics | Can `close` be retried? (POSIX `close` + `EINTR`: no on Linux) |
| Error observation | Is a failing close reportable, or silently swallowed? |
| Affinity | Must release happen on the acquiring thread? |
| Duplication | Does `dup()` mean copy-ownership or shared-ownership? |
| Move-from state | Is the default/empty state safely destructible? |

```cpp
// ---- composite teardown: order is a protocol, not an accident ----------
class Service {
public:
    ~Service() {
        publisher_.stop();      // 1. stop producing
        queue_.close();         // 2. wake blocked consumers
        worker_.request_stop(); // 3. signal
        // 4. ~jthread joins; 5. ~queue_; 6. ~publisher_  (reverse declaration order)
    }
private:
    Publisher    publisher_;
    Queue        queue_;
    std::jthread worker_;   // declared last => destroyed first => joined before its deps die
};
```

**Interview line** — "Do not smuggle an integer handle into `unique_ptr` with a cast; write the four special members and name the sentinel."

**Traps** — fd `0` is valid, so `if (fd)` is wrong — test `fd != -1` · a copyable handle wrapper double-closes · closing a stale fd after another thread reopened the number redirects unrelated I/O · `unique_lock::release()` leaks the lock (does not unlock) · `lock_guard{m}` with no name is a temporary that unlocks immediately — always name the guard · a `jthread` member declared *before* what it uses joins too late · nesting `lock_guard`s in different orders across call sites deadlocks; use `scoped_lock` with all mutexes at once.

---

## 10.9 Why shared ownership is often undesirable on hot paths

```cpp
// ---- what a copy actually costs ----------------------------------------
void consume(std::shared_ptr<Book> b);          // lock xadd on entry, lock xadd on exit
void consume(std::shared_ptr<Book> const& b);   // no traffic — but still leaks ownership into the API
void consume(Book& b);                          // free; correct when lifetime is proven
consume(std::move(sp));                          // move: NO atomic at all
```

| Cost | Mechanism |
|---|---|
| ~20–100 ns per contended copy | `lock xadd` on the strong count; cache line ping-pongs between cores |
| False sharing | Strong and weak counts share a line; readers invalidate each other |
| Extra indirection | Control-block pointer is a second, cold cache line |
| Allocation | 1 (`make_shared`) or 2 (`new`) per object; malloc lock/arena contention |
| Nondeterministic teardown | Whichever thread drops the count to zero pays the destructor + free |
| Retention | Weak owners hold co-allocated storage past object death |
| Hidden locks | `atomic<shared_ptr>` is often mutex-backed |
| Shutdown complexity | Cycles leak; ordering becomes graph-dependent |

```cpp
// ---- alternative 1: single owner + borrowed references ------------------
class Engine {
    std::vector<Order> orders_;                   // sole owner, contiguous
public:
    void step() { for (Order& o : orders_) match(o); }   // borrow inside a proven phase
};

// ---- alternative 2: transfer ownership through the queue ----------------
Queue<std::unique_ptr<Batch>> q;
q.push(std::make_unique<Batch>(std::move(data)));  // one owner at a time, no atomics
auto batch = q.pop();                              // consumer now owns it

// ---- alternative 3: pool + generation handle (no pointers at all) -------
struct Handle { std::uint32_t index; std::uint32_t generation; };
class OrderPool {
    struct Slot { Order order; std::uint32_t generation{}; bool live{}; };
    std::vector<Slot>          slots_;             // sized once, before the hot path
    std::vector<std::uint32_t> free_;
public:
    Handle acquire(Order o) {
        std::uint32_t i = free_.back(); free_.pop_back();
        slots_[i] = {std::move(o), slots_[i].generation + 1, true};
        return {i, slots_[i].generation};
    }
    void release(Handle h) { if (valid(h)) { slots_[h.index].live = false; free_.push_back(h.index); } }
    bool   valid(Handle h) const noexcept {
        return h.index < slots_.size() && slots_[h.index].live
            && slots_[h.index].generation == h.generation;   // stale handle detected
    }
    Order* get(Handle h) noexcept { return valid(h) ? &slots_[h.index].order : nullptr; }
};

// ---- alternative 4: immutable snapshot publication ----------------------
std::atomic<std::shared_ptr<Snapshot const>> published;   // ONE atomic op per publish,
auto view = published.load(std::memory_order_acquire);    // amortized over many reads
```

| Situation | Preferred ownership |
|---|---|
| Object lives entirely inside one call/frame | value or automatic storage |
| Single owner, dynamic size or polymorphism | `std::unique_ptr` |
| Producer hands off to consumer | move a `unique_ptr` / value through the queue |
| Many readers of a rarely replaced snapshot | `atomic<shared_ptr<T const>>`, or epoch/RCU |
| Fixed-population objects with reuse | pre-sized pool + generation handles |
| Genuinely independent, unordered lifetimes | `std::shared_ptr` (and only then) |
| Observer that must not extend life | `weak_ptr`, or a handle with a validity check |

- Ordering rule: **simplify the lifetime graph → pick a reclamation scheme → prove it → measure**; never skip to a raw pointer for speed.
- A `shared_ptr` local to one thread costs little (uncontended atomics); the damage is cross-core sharing of the same control block.
- If profiling shows `lock xadd` hotspots, the fix is usually passing `T&` instead of `shared_ptr<T>` by value, not a hand-rolled refcount.

**Interview line** — "`shared_ptr` is not a performance problem, it is an *ownership design* problem: its cost only shows up when the lifetime graph is more complicated than it needed to be."

**Traps** — replacing a correct `shared_ptr` with a raw pointer trades a measurable cost for UB · `atomic<shared_ptr>` still copies (atomic increment) on every `load()` · a lock-free container of `shared_ptr` is a reclamation problem in disguise (hazard pointers / epochs) · "just cache the `shared_ptr` in a member" often creates the cycle that leaks at shutdown.

---

## Recall card

```text
RAII            acquire in ctor, release once in a noexcept dtor; every exit path covered
not covered     abort/_Exit/quick_exit/crash/leak; exit() abandons the stack
scope_exit      any exit · scope_fail  uncaught count grew · scope_success it did not
release()       disarms a guard / disowns a unique_ptr — it never deletes
unique_ptr      default owner; deleter is part of the type; 1 pointer if stateless
pImpl           declare ~T() in the header, define it where the impl is complete
shared_ptr      stored ptr + control ptr; copy = atomic RMW; move = free
aliasing        share a control block while pointing at a subobject
double ctrl     two shared_ptr from one raw pointer = double delete
thread safety   counts are atomic; the pointee and the pointer OBJECT are not
weak_ptr        lock() is the only race-free upgrade; expired() is check-then-act
cycle           two strong edges never reach zero; weaken one
shared_from_this  needs an existing owner, else bad_weak_ptr; weak_from_this is safe
make_shared     1 allocation, no custom deleter, weak owners retain the storage
observe         T& / T* / span / string_view — never extend a lifetime
hot path        values, unique_ptr transfer, pool handles, bounded snapshot publication
```
