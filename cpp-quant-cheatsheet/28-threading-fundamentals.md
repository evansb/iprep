# 28. Threading fundamentals

*Part V — Concurrency and the memory model*

---

**Recall**
- Two evaluations *conflict* if one modifies (or begins/ends the lifetime of) a memory location the other reads or modifies; unordered conflicting accesses from different threads are a data race and UB.
- Only three things make an access safe: it is atomic, it is ordered by a happens-before edge, or the object is not shared.
- A mutex `unlock()` *synchronizes with* the next successful `lock()` of the same mutex — that is the entire visibility guarantee, not "cache flushing".
- A mutex protects an **invariant**, not a variable: two `atomic<long>` fields still cannot be read as one consistent pair.
- `std::thread` destruction while joinable calls `std::terminate` — no silent detach, no silent join.
- `std::thread` arguments are **decay-copied** into internal storage before invocation; use `std::ref`/`std::cref` for reference semantics and prove lifetime.
- `std::jthread` requests stop then joins in its destructor, and injects a `stop_token` as the first parameter when the callable accepts one.
- Cancellation is cooperative: `request_stop()` only sets a flag and runs callbacks — it never interrupts a blocked syscall or unwinds a thread.
- `stop_callback` may run synchronously on the requesting thread (or on the constructing thread if stop was already requested) — keep it bounded, non-throwing, race-safe.
- A condition variable stores no event; the mutex-protected state stores the condition, and a notification only tells waiters to recheck.
- Always `wait(lock, pred)` — spurious wakeups are permitted and a notification consumed by another waiter is normal.
- Notify inside or outside the lock is a *performance* choice; both are correct under the predicate protocol.
- `condition_variable` requires `unique_lock<std::mutex>`; only `condition_variable_any` takes arbitrary lockables and the `stop_token` overload.
- Prefer `wait_until` (absolute deadline) in retry loops; repeating a relative `wait_for` after spurious wakes can multiply the intended timeout.
- `counting_semaphore` counts transferable permits — any thread may `release()`; `binary_semaphore` is *not* a mutex and carries no ownership.
- `latch` is one-shot and never resets; `barrier` is reusable per phase and runs a `noexcept` completion function between phases.
- `future::get()` moves the result out once and rethrows any stored exception; `shared_future` is copyable and re-readable.
- Destroying a `promise` without setting a value makes the consumer see `future_error{broken_promise}`.
- Default-policy `std::async` may **defer** to `get()`; a discarded `std::launch::async` future blocks in its destructor, silently serializing code.
- No standard mutex promises fairness; `try_lock` may fail spuriously even when uncontended.
- Shutdown is an ordering protocol: stop admission → request stop → wake/close every wait → drain or discard by policy → join → destroy dependencies.
- Declare `jthread` members **last** so they join before the queues, mutexes, and services they reference are destroyed.

---

## 28.1 Processes, threads, shared state, and data races

```text
process         address space + resources; threads share all of it
thread          own stack, own registers, own TLS; shared heap/globals/statics
shared mutable  ──► must be atomic OR ordered by happens-before, else UB
immutable       ──► free after safe publication
thread-confined ──► no synchronization needed at all (cheapest correct design)
```

```cpp
// ---- the canonical race -------------------------------------------------
int counter = 0;
void bump() { ++counter; }                 // read-modify-write: UB from 2 threads
// UB is not "a wrong number": the compiler may assume no race and hoist,
// fuse, duplicate, or invent loads/stores.

// ---- three legal repairs ------------------------------------------------
std::atomic<int> a_counter{0};
a_counter.fetch_add(1, std::memory_order_relaxed);      // atomic

std::mutex m; int m_counter = 0;
{ std::lock_guard lk{m}; ++m_counter; }                 // ordered by mutex

thread_local int t_counter = 0; ++t_counter;            // not shared
```

```cpp
// ---- word tearing and false sharing -------------------------------------
struct Bad  { std::uint32_t a, b; };                    // distinct memory
                                                        // locations: NOT a race,
                                                        // but same cache line
struct alignas(std::hardware_destructive_interference_size) Padded {  // C++17
    std::atomic<std::uint64_t> value{};
};
// std::vector<bool>: adjacent elements SHARE a word → concurrent writes to
// different bits ARE a data race.

// Bit-fields in the same contiguous non-zero-width sequence are ONE memory
// location → concurrent writes to different bit-fields race.
struct Bits { unsigned x : 4; unsigned y : 4; };        // x and y race
```

| Concept | Rule |
|---|---|
| Memory location | one scalar object, or a maximal contiguous run of non-zero-width bit-fields |
| Conflict | two accesses to the same location, at least one a write/lifetime event |
| Data race | conflicting, unordered, not both atomic → **undefined behavior** |
| Happens-before | sequenced-before ∪ synchronizes-with, transitively closed |
| Safe publication | construct fully, then release-store/unlock; reader acquire-loads/locks |
| Thread of execution | started by `thread`/`jthread`/`async`; `main` is one |
| `std::thread::hardware_concurrency()` | *hint*, may return 0; never a guarantee |

```cpp
#include <thread>
unsigned n = std::thread::hardware_concurrency();       // 0 if unknown
std::this_thread::yield();                              // scheduling hint only
std::this_thread::sleep_for(std::chrono::milliseconds{5});
std::this_thread::sleep_until(deadline);                // absolute
std::thread::id id = std::this_thread::get_id();        // hashable, <=> ordered
```

**Traps** — "it's just an int, tearing is unlikely" is not a defense against UB · `volatile` is not atomic and creates no ordering · `hardware_concurrency()` ignores cgroups/affinity on many platforms · a race in *any* thread poisons the whole program's behavior.

---

## 28.2 `std::thread` and C++20 `std::jthread`

```cpp
#include <thread>
#include <functional>

void work(int n);
void by_ref(int& x) { ++x; }
struct Functor { void operator()(std::string s) const; };
struct Widget  { void member(int); };

std::thread t0;                                  // default: NOT joinable
std::thread t1{work, 42};                        // callable + decay-copied args
std::thread t2{Functor{}, std::string{"hi"}};    // functor object
std::thread t3{[]{ /* ... */ }};                 // lambda, no args
std::thread t4{[n = 5]() mutable { --n; }};      // init-capture (owns its copy)
Widget w;
std::thread t5{&Widget::member, &w, 7};          // pointer-to-member + object
std::thread t6{&Widget::member, std::ref(w), 7}; // reference_wrapper form
int value = 0;
std::thread t7{by_ref, std::ref(value)};         // REQUIRED for reference binding
std::thread t8{std::move(t1)};                   // move-construct; t1 empty now

// std::thread t9{work};                         // ill-formed: missing arg
// std::thread ta{by_ref, value};                // ill-formed: rvalue → int&
```

```cpp
// ---- argument decay is the classic dangling bug -------------------------
void log(std::string_view sv);
void danger() {
    char buf[64];
    std::sprintf(buf, "...");
    std::thread{log, buf}.detach();   // char* copied; buf dies at scope exit → UB
}
void safe() {
    char buf[64];
    std::thread{log, std::string{buf}}.detach();  // materialize BEFORE launching
}
```

```cpp
// ---- jthread: every ctor form ------------------------------------------
#include <stop_token>
std::jthread j0;                                       // not joinable
std::jthread j1{[]{ }};                                // no token
std::jthread j2{[](std::stop_token st){ while(!st.stop_requested()){} }};
std::jthread j3{[](std::stop_token st, int n){ (void)n; }, 5};  // token is FIRST
std::jthread j4{&Widget::member, &w, 7};
// destructor of j2/j3: request_stop(); if (joinable()) join();
```

| Member (`thread` / `jthread`) | Effect | Notes |
|---|---|---|
| `thread()` / `jthread()` | no associated thread | `joinable() == false` |
| `thread(F&&, Args&&...)` | decay-copies args, starts execution | may throw `system_error` (`resource_unavailable_try_again`) |
| `jthread(F&&, Args&&...)` | same, plus injects `stop_token` if `F` is invocable with one prepended | token comes from the internal `stop_source` |
| `~thread()` | `std::terminate()` if joinable | **no** implicit join/detach |
| `~jthread()` | `request_stop(); if (joinable()) join();` | the whole point |
| move ctor / move assign | transfers association; source becomes non-joinable | assigning over a joinable `thread` → `terminate`; over a joinable `jthread` → stop+join first |
| copy | **deleted** | |
| `joinable()` | has an associated thread of execution | true even after the function returned |
| `join()` | blocks until completion; then non-joinable | `system_error` if not joinable / deadlock on self |
| `detach()` | severs the handle; then non-joinable | thread keeps running; no way to observe it |
| `get_id()` | `std::thread::id` (`id{}` when not joinable) | |
| `native_handle()` | platform handle (`pthread_t`, `HANDLE`) | no portable semantics |
| `hardware_concurrency()` | static hint | may be 0 |
| `swap(other)` / `std::swap` | exchange associations | O(1) |
| `get_stop_source()` (jthread) | `std::stop_source` copy | |
| `get_stop_token()` (jthread) | `std::stop_token` copy | |
| `request_stop()` (jthread) | requests stop on the internal source | returns `bool` (true if this call did it) |

```cpp
// ---- pre-C++20 RAII joiner (still useful over thread pools/handles) -----
class JoiningThread {
public:
    JoiningThread() noexcept = default;
    template<class F, class... A>
    explicit JoiningThread(F&& f, A&&... a)
        : t_{std::forward<F>(f), std::forward<A>(a)...} {}
    explicit JoiningThread(std::thread t) noexcept : t_{std::move(t)} {}
    JoiningThread(JoiningThread&&) noexcept = default;
    JoiningThread& operator=(JoiningThread&& o) noexcept {
        if (t_.joinable()) t_.join();          // never terminate on assign
        t_ = std::move(o.t_);
        return *this;
    }
    ~JoiningThread() { if (t_.joinable()) t_.join(); }
    std::thread& get() noexcept { return t_; }
private:
    std::thread t_;
};
```

**Interview line** — "`std::thread`'s destructor terminates because both alternatives are wrong by default: implicit `join` silently blocks in a destructor, implicit `detach` silently invalidates lifetime proofs."

**Traps** — `std::thread t{Widget{}};` with a parenthesized form is a vexing-parse risk; brace-init avoids it · exceptions between construction and `join()` skip the join → `terminate` · `detach()` does not extend the lifetime of `this`, stack objects, or the program · thread construction can throw *after* other resources were acquired.

---

## 28.3 Joining, detaching, stop tokens, and cooperative cancellation

```cpp
#include <stop_token>

std::stop_source src;                       // owns the request state (heap-allocated)
std::stop_source none{std::nostopstate};    // NO state: stop_possible() == false
std::stop_token tok = src.get_token();      // cheap, copyable observer

bool requested = src.request_stop();        // true only for the first requester
src.stop_requested();                       // has stop been requested?
src.stop_possible();                        // has associated state
tok.stop_requested();                       // atomic load
tok.stop_possible();                        // false ⇒ never will be requested
bool same = (tok == src.get_token());       // C++20 comparison

// C++23: swap the source's state
std::stop_source other; src.swap(other);
```

```cpp
// ---- stop_callback: runs on request, or immediately if already requested
std::stop_callback cb{tok, []() noexcept {
    // MUST be bounded, non-throwing, and safe to run on the requesting thread
    wake_up_the_io_layer();
}};
// Destroying cb: if it is currently running on another thread, the destructor
// BLOCKS until it finishes — unless it is running on THIS thread (no deadlock).
```

```cpp
// ---- pattern 1: poll the token in a bounded loop -------------------------
void poll(std::stop_token st) {
    while (!st.stop_requested())
        process_one_bounded_batch();
}

// ---- pattern 2: stop-aware condition_variable_any wait -------------------
class Mailbox {
public:
    bool take(std::stop_token st, Message& out) {
        std::unique_lock lock{mutex_};
        // returns pred() — false means "stop requested and predicate still false"
        if (!cv_.wait(lock, st, [&]{ return closed_ || !queue_.empty(); }))
            return false;                       // cancelled
        if (queue_.empty()) return false;       // closed and drained
        out = std::move(queue_.front());
        queue_.pop_front();
        return true;
    }
    void close() {
        { std::lock_guard lk{mutex_}; closed_ = true; }
        cv_.notify_all();
    }
private:
    std::mutex mutex_;
    std::condition_variable_any cv_;            // ONLY _any takes a stop_token
    std::deque<Message> queue_;
    bool closed_ = false;
};

// ---- pattern 3: plain condition_variable + stop_callback ----------------
void wait_plain(std::stop_token st, std::mutex& m,
                std::condition_variable& cv, bool& ready) {
    std::stop_callback cb{st, [&]() noexcept {
        { std::lock_guard lk{m}; }             // ensure the waiter is parked
        cv.notify_all();
    }};
    std::unique_lock lk{m};
    cv.wait(lk, [&]{ return ready || st.stop_requested(); });
}
```

| Type | Members |
|---|---|
| `std::stop_source` | `get_token()`, `request_stop()`, `stop_requested()`, `stop_possible()`, `swap` (C++23), `==`; ctor `stop_source{std::nostopstate}` makes a stateless source |
| `std::stop_token` | `stop_requested()`, `stop_possible()`, `swap`, `==`; copyable/movable, no request ability |
| `std::stop_callback<Cb>` | ctor `(token, Callable)`; invokes `Cb` on the requesting thread, or on the constructing thread if already requested; destructor blocks until a concurrent invocation finishes; CTAD from the callable |
| `std::inplace_stop_source/token/callback` | C++26 — no allocation, non-copyable source |

```text
join()    ── blocking, observable completion, lifetimes provable  ← default choice
detach()  ── no completion signal; every referenced resource must outlive process
stop      ── a REQUEST; the worker must (a) observe it and (b) unblock its waits
```

**Interview line** — "Cancellation is cooperative: `request_stop` sets a flag and runs callbacks; unblocking a thread that is parked in `read()` or `cv.wait()` is the *worker's* design problem, not the token's."

**Traps** — `condition_variable::wait` has **no** `stop_token` overload · a `jthread` whose body ignores its token makes the destructor hang forever · stop callbacks that take the same mutex the requester holds deadlock · `detach()` + program exit = destructors of statics racing a live thread · `join()` on the current thread throws `resource_deadlock_would_occur`.

---

## 28.4 Thread-local storage and initialization

```cpp
struct Counters { std::uint64_t messages{}, errors{}; };

thread_local Counters local_counts;              // namespace scope: implicitly static
Counters& counters() noexcept { return local_counts; }

struct S {
    static thread_local int per_thread;          // static data member
};
thread_local int S::per_thread = 0;              // definition

void f() {
    thread_local int calls = 0;                  // one per thread, lives to thread exit
    static thread_local std::vector<char> scratch;  // 'static' is redundant here
    ++calls;
}

extern thread_local int shared_tls;              // declaration in a header
// thread_local on a local implies static storage semantics per thread
```

| Aspect | Rule |
|---|---|
| Storage duration | thread — one object per thread, including the main thread |
| Initialization | static/constant-initialized before use; dynamic init is *before first odr-use* in that thread (possibly lazy, guarded) |
| Destruction | at thread exit, reverse order of completed construction; runs **before** static destructors of the process for that thread |
| `constinit thread_local` | forces constant initialization → no lazy-init guard, no first-use latency (C++20) |
| Address stability | stable for the owning thread's lifetime; **dangles** after that thread exits |
| Cost | ABI-dependent: initial-exec/local-exec are a TLS-register offset; global-dynamic calls `__tls_get_addr` |
| `detach()` interaction | detached threads still run TLS destructors at their own exit — but may be killed at `exit()` |

```cpp
// ---- eager, allocation-free per-thread counters --------------------------
struct alignas(64) HotCounters { std::uint64_t hits{}, misses{}; };
constinit thread_local HotCounters hot{};        // C++20: zero first-use latency

// ---- lifetime-safe aggregation: register the slot, unregister at exit ----
class Registry {
public:
    void add(HotCounters* p) { std::lock_guard lk{m_}; slots_.push_back(p); }
    void remove(HotCounters* p) {
        std::lock_guard lk{m_};
        std::erase(slots_, p);
    }
    HotCounters total() {                        // snapshot, not atomic overall
        std::lock_guard lk{m_};
        HotCounters t{};
        for (auto* s : slots_) { t.hits += s->hits; t.misses += s->misses; }
        return t;
    }
private:
    std::mutex m_;
    std::vector<HotCounters*> slots_;
};
inline Registry registry;

struct Enroll {
    Enroll()  { registry.add(&hot); }
    ~Enroll() { registry.remove(&hot); }         // runs at thread exit
};
thread_local Enroll enroll{};                    // odr-use it to force construction
```

**Traps** — a non-trivial TLS initializer can allocate/throw on *every* thread's first touch · passing a `&thread_local` object across threads defeats confinement and dangles at that thread's exit · TLS destructors that create *new* TLS objects may be UB or leak · `thread_local` on a pointer does not make the pointee per-thread · TLS in a `dlopen`ed shared object may use the slow global-dynamic model.

---

## 28.5 Mutexes, timed mutexes, and recursive mutexes

```cpp
#include <mutex>
#include <shared_mutex>

std::mutex m;
m.lock();                 // blocks; UB to lock recursively
bool got = m.try_lock();  // may fail SPURIOUSLY; never blocks
m.unlock();               // UB unless this thread owns it

std::timed_mutex tm;
tm.try_lock_for(std::chrono::milliseconds{10});   // relative
tm.try_lock_until(deadline);                      // absolute — prefer in loops

std::recursive_mutex rm;
rm.lock(); rm.lock(); rm.unlock(); rm.unlock();   // must balance exactly

std::recursive_timed_mutex rtm;

std::shared_mutex sm;                             // C++17
sm.lock();          sm.unlock();                  // exclusive (writer)
sm.lock_shared();   sm.unlock_shared();           // shared (reader)
sm.try_lock(); sm.try_lock_shared();

std::shared_timed_mutex stm;                      // C++14
stm.try_lock_shared_for(std::chrono::milliseconds{1});
stm.try_lock_shared_until(deadline);
```

| Type | Header | Lockable concept | Extra |
|---|---|---|---|
| `std::mutex` | `<mutex>` | *Lockable* | `lock/try_lock/unlock`, `native_handle` |
| `std::timed_mutex` | `<mutex>` | *TimedLockable* | `+ try_lock_for/until` |
| `std::recursive_mutex` | `<mutex>` | *Lockable* | same thread may relock; unspecified max depth (throws `system_error` on overflow) |
| `std::recursive_timed_mutex` | `<mutex>` | *TimedLockable* | both of the above |
| `std::shared_mutex` | `<shared_mutex>` (C++17) | *SharedLockable* | `+ lock_shared/try_lock_shared/unlock_shared` |
| `std::shared_timed_mutex` | `<shared_mutex>` (C++14) | *SharedTimedLockable* | `+ try_lock_shared_for/until` |
| `std::once_flag` + `std::call_once` | `<mutex>` | — | exactly-once init; a throwing callable does *not* consume the flag |

| Operation | Contract |
|---|---|
| `lock()` | blocks; throws `system_error` on failure; recursive lock on non-recursive = UB |
| `try_lock()` | non-blocking `bool`; **allowed to fail spuriously** |
| `unlock()` | precondition: current thread owns the lock; otherwise UB |
| Destructor | precondition: not locked; otherwise UB |
| Fairness | none guaranteed by any standard mutex |
| Synchronization | prior `unlock()` *synchronizes with* the next successful `lock()` of the same object |
| Copy/move | all deleted — mutexes are neither copyable nor movable |

```cpp
// ---- a mutex protects an INVARIANT, not a field --------------------------
class Account {
public:
    void replace(long cash, long exposure) {
        std::lock_guard lock{mutex_};
        cash_ = cash; exposure_ = exposure;          // one atomic transition
    }
    std::pair<long, long> snapshot() const {
        std::lock_guard lock{mutex_};                // consistent PAIR
        return {cash_, exposure_};
    }
private:
    mutable std::mutex mutex_;                       // 'mutable' for const methods
    long cash_{}, exposure_{};
};
// Two std::atomic<long> members would give two consistent VALUES and no
// consistent SNAPSHOT.
```

```cpp
// ---- call_once ----------------------------------------------------------
std::once_flag flag;
void init_once() {
    std::call_once(flag, []{ expensive_setup(); });   // exactly one winner
}
// Function-local statics give the same guarantee with less code (C++11 magic statics):
Config& config() { static Config c = load(); return c; }
```

```cpp
// ---- shared_mutex: readers vs writers ------------------------------------
class Table {
public:
    std::optional<Row> find(Key k) const {
        std::shared_lock lock{mutex_};               // many readers
        auto it = rows_.find(k);
        return it == rows_.end() ? std::nullopt : std::optional{it->second};
    }
    void insert(Key k, Row r) {
        std::unique_lock lock{mutex_};               // one writer, excludes readers
        rows_.emplace(k, std::move(r));
    }
private:
    mutable std::shared_mutex mutex_;
    std::unordered_map<Key, Row> rows_;
};
// shared_mutex pays for itself only with LONG reads and a LOW write rate;
// its internal state is larger and reader/writer priority is unspecified.
```

**Traps** — locking a `std::mutex` twice on one thread is UB, not a deadlock diagnostic · `recursive_mutex` usually signals an ownership bug (an API that calls its own public method) · destroying a locked mutex, or unlocking from a non-owner, is UB · `try_lock()` returning false proves nothing about contention · a timeout is admission policy, not fairness · holding a lock across a callback, allocation, I/O, or `notify` costs latency and invites reentrancy.

---

## 28.6 Lock guards, unique locks, scoped locks, and deadlock avoidance

```cpp
#include <mutex>
std::mutex a, b, c;

// ---- lock_guard: acquire now, release at scope exit; no other API --------
{ std::lock_guard lk{a}; }                        // CTAD → lock_guard<std::mutex>
{ std::lock_guard<std::mutex> lk{a, std::adopt_lock}; }   // caller already locked

// ---- scoped_lock: 0..N mutexes, deadlock-avoiding ordering (C++17) ------
{ std::scoped_lock lk{a, b, c}; }                 // all-or-nothing, no fixed order
{ std::scoped_lock lk{}; }                        // zero mutexes: legal no-op
{ std::scoped_lock lk{std::adopt_lock, a, b}; }   // tag comes FIRST here

// ---- unique_lock: the full-featured, movable one ------------------------
std::unique_lock lk1{a};                                  // locks now
std::unique_lock lk2{b, std::defer_lock};                 // does NOT lock
std::unique_lock lk3{c, std::try_to_lock};                // try_lock now
std::unique_lock<std::timed_mutex> lk4{tm, std::chrono::milliseconds{5}};
std::unique_lock<std::timed_mutex> lk5{tm, deadline};
std::unique_lock lk6{a, std::adopt_lock};                 // takes over ownership

lk2.lock(); lk2.unlock(); lk2.try_lock();
lk2.owns_lock();  if (lk2) { }                             // explicit operator bool
std::mutex* raw = lk2.release();                           // give up WITHOUT unlocking
auto moved = std::move(lk1);                               // movable (lock_guard is not)

// ---- shared_lock: shared ownership of a shared_mutex (C++14) ------------
std::shared_mutex sm;
std::shared_lock s1{sm};                                   // lock_shared now
std::shared_lock s2{sm, std::defer_lock};
std::shared_lock s3{sm, std::try_to_lock};
```

| Wrapper | Header | Owns | Movable | API |
|---|---|---|---|---|
| `std::lock_guard<M>` | `<mutex>` | 1 mutex | no | ctor/dtor only; `adopt_lock` |
| `std::scoped_lock<M...>` | `<mutex>` (C++17) | 0..N | no | ctor/dtor only; uses `std::lock` for N ≥ 2; `adopt_lock` |
| `std::unique_lock<M>` | `<mutex>` | 1 | yes | `lock/try_lock/try_lock_for/try_lock_until/unlock/owns_lock/operator bool/release/mutex/swap` |
| `std::shared_lock<M>` | `<shared_mutex>` (C++14) | 1 (shared) | yes | same shape as `unique_lock`, shared mode |

| Tag | Meaning |
|---|---|
| `std::defer_lock` | construct without locking; lock later |
| `std::try_to_lock` | attempt non-blocking lock in the constructor; check `owns_lock()` |
| `std::adopt_lock` | the calling thread already owns it; just take responsibility for unlocking |

| Free function | Effect |
|---|---|
| `std::lock(l1, l2, ...)` | locks all with a deadlock-avoidance algorithm (try-and-back-off); blocking |
| `std::try_lock(l1, l2, ...)` | returns `-1` on success, else the 0-based index of the first failure (and unlocks the rest) |
| `std::call_once(flag, f, args...)` | exactly-once execution |
| `std::swap(lk1, lk2)` | for `unique_lock`/`shared_lock` |

```cpp
// ---- deadlock avoidance: all four correct shapes -------------------------
void transfer_scoped(Book& x, Book& y) {
    if (&x == &y) return;                       // self-transfer would double-lock
    std::scoped_lock lock{x.mutex, y.mutex};    // preferred
    move_funds(x, y);
}

void transfer_std_lock(Book& x, Book& y) {
    if (&x == &y) return;
    std::unique_lock lx{x.mutex, std::defer_lock};
    std::unique_lock ly{y.mutex, std::defer_lock};
    std::lock(lx, ly);                          // pre-C++17 idiom
    move_funds(x, y);
}

void transfer_ordered(Book& x, Book& y) {       // fixed global order by address
    if (&x == &y) return;
    auto& [first, second] = (&x < &y) ? std::tie(x, y) : std::tie(y, x);
    std::lock_guard l1{first.mutex};
    std::lock_guard l2{second.mutex};
    move_funds(x, y);
}

// ---- never call unknown code under a lock -------------------------------
void publish(Event e) {
    std::vector<Callback> snapshot;
    { std::lock_guard lk{mutex_}; snapshot = subscribers_; }  // copy, then release
    for (auto& cb : snapshot) cb(e);            // callbacks may block/throw/re-enter
}
```

```text
Deadlock needs all four; break ANY one:
  mutual exclusion · hold-and-wait · no preemption · circular wait
Practical breakers: scoped_lock/std::lock (atomic multi-acquire)
                    one global lock order (address, id, layer)
                    try_lock + back-off with randomized retry
                    lock-free handoff / thread confinement (remove the lock)
```

**Traps** — `std::lock_guard lk{m};` vs `std::lock_guard{m};` — the second is an unnamed temporary that unlocks immediately · `scoped_lock` puts `adopt_lock` **first**, `unique_lock` puts it **last** · `unique_lock::release()` does *not* unlock (it leaks the lock unless you unlock manually) · a moved-from `unique_lock` owns nothing · `try_lock` free function unlocks the ones it did acquire, but *not* on an exception from a lockable · recursive public-API calls under a non-recursive mutex self-deadlock.

---

## 28.7 Condition variables, predicates, spurious wakeups, and lost wakeups

```cpp
#include <condition_variable>

template<class Item>
class Queue {
public:
    void push(Item value) {
        {
            std::lock_guard lock{mutex_};
            items_.push_back(std::move(value));
        }                                    // unlock BEFORE notify: waiter
        cv_.notify_one();                    // won't wake only to block again
    }

    std::optional<Item> pop() {              // nullopt ⇒ closed and drained
        std::unique_lock lock{mutex_};
        cv_.wait(lock, [&]{ return closed_ || !items_.empty(); });
        if (items_.empty()) return std::nullopt;
        Item r = std::move(items_.front());
        items_.pop_front();
        return r;
    }

    std::optional<Item> pop_until(std::chrono::steady_clock::time_point tp) {
        std::unique_lock lock{mutex_};
        if (!cv_.wait_until(lock, tp, [&]{ return closed_ || !items_.empty(); }))
            return std::nullopt;             // predicate STILL false ⇒ timeout
        if (items_.empty()) return std::nullopt;
        Item r = std::move(items_.front());
        items_.pop_front();
        return r;
    }

    void close() {
        { std::lock_guard lock{mutex_}; closed_ = true; }
        cv_.notify_all();                    // ALL: every waiter must re-evaluate
    }
private:
    std::mutex mutex_;
    std::condition_variable cv_;
    std::deque<Item> items_;
    bool closed_ = false;
};
```

```cpp
// ---- every wait overload -------------------------------------------------
std::unique_lock lock{m};
cv.wait(lock);                                   // raw: MAY wake spuriously
cv.wait(lock, pred);                             // == while (!pred()) wait(lock);

std::cv_status s = cv.wait_for(lock, 10ms);      // timeout | no_timeout
bool ok = cv.wait_for(lock, 10ms, pred);         // returns pred() after the wait

std::cv_status s2 = cv.wait_until(lock, deadline);
bool ok2 = cv.wait_until(lock, deadline, pred);  // PREFER in retry loops

// condition_variable_any: same set over ANY BasicLockable, plus stop_token
std::condition_variable_any any;
any.wait(generic_lock, pred);
any.wait(generic_lock, stop_token, pred);        // C++20; false ⇒ stop requested
any.wait_for(generic_lock, stop_token, 10ms, pred);
any.wait_until(generic_lock, stop_token, deadline, pred);
```

| Member | `condition_variable` | `condition_variable_any` |
|---|---|---|
| Lock type | `std::unique_lock<std::mutex>` only | any *BasicLockable* (incl. `shared_lock`, custom) |
| `wait(lock)` / `wait(lock, pred)` | yes | yes |
| `wait_for(lock, dur[, pred])` | yes | yes |
| `wait_until(lock, tp[, pred])` | yes | yes |
| `wait(lock, stoken, pred)` and timed forms | **no** | yes (C++20) |
| `notify_one()` / `notify_all()` | yes — may be called with or without the mutex held | yes |
| `native_handle()` | yes | no |
| Cost | thin wrapper over futex/`pthread_cond_t` | extra internal mutex → measurably heavier |
| `std::notify_all_at_thread_exit(cv, lk)` | unlocks `lk` and notifies after TLS destruction | — |

```cpp
// ---- the three canonical bugs -------------------------------------------
// 1. no loop  → spurious wakeup / stolen notification proceeds on false state
if (!ready) cv.wait(lock);                       // WRONG

// 2. lost wakeup → state set outside the mutex, notify races the wait
ready = true; cv.notify_one();                   // WRONG: no mutex around 'ready'

// 3. relative timeout in a loop → total wait becomes unbounded
while (!pred()) cv.wait_for(lock, 100ms);        // WRONG: 100ms per spurious wake
while (!pred())                                  // RIGHT
    if (cv.wait_until(lock, deadline) == std::cv_status::timeout) break;
```

```text
The protocol — all three or none:
  1. Read AND write the predicate state under the SAME mutex.
  2. Wait with that mutex and a predicate (never a bare wait).
  3. Notify AFTER the state change is observable to a thread that takes the mutex.
notify_one   ⇒ only when ALL waiters are interchangeable and one item = one waiter
notify_all   ⇒ state change relevant to several waiters (close, phase change, reset)
```

**Interview line** — "A condition variable stores no state; the mutex-protected predicate is the condition, and a notification is only a hint to re-evaluate it."

**Traps** — a notification sent while no thread is waiting is lost forever — that is why the predicate exists · `notify_one` with heterogeneous waiters can wake the wrong one and stall the queue · `wait` requires the *same* mutex for every waiter on that cv, and the lock must be owned · destroying a cv with waiters is UB (`notify_all` first, then join, then destroy) · `notify` while holding the lock can cause a "hurry-up-and-wait" bounce on some implementations, but is never *incorrect*.

---

## 28.8 Semaphores, latches, and barriers

```cpp
#include <semaphore>
#include <latch>
#include <barrier>

// ---- counting_semaphore<LeastMaxValue> -----------------------------------
std::counting_semaphore<64> slots{64};        // 64 permits available
std::binary_semaphore signal{0};              // = counting_semaphore<1>, starts empty
static_assert(std::counting_semaphore<64>::max() >= 64);

slots.acquire();                              // blocks until a permit is taken
bool got  = slots.try_acquire();              // may fail spuriously
bool got2 = slots.try_acquire_for(10ms);
bool got3 = slots.try_acquire_until(deadline);
slots.release();                              // +1 permit
slots.release(4);                             // +4 permits; UB if it exceeds max()

// Producer/consumer signalling — ANY thread may release (unlike a mutex)
void producer() { prepare(); signal.release(); }
void consumer() { signal.acquire(); use(); }
```

```cpp
// ---- latch: one-shot countdown ------------------------------------------
std::latch started{worker_count};
// worker: initialize(); started.count_down();          // -1 (or count_down(n))
started.wait();                                          // blocks until zero
started.try_wait();                                      // non-blocking check
started.arrive_and_wait();                               // count_down(1) then wait
static_assert(std::latch::max() > 0);
// NO reset — construct a new latch for the next round.
```

```cpp
// ---- barrier: reusable phase boundary -----------------------------------
std::barrier phase{worker_count, [] noexcept { publish_phase_stats(); }};
std::barrier plain{worker_count};                        // default no-op completion

// each participant, each phase:
phase.arrive_and_wait();                                 // arrive() + wait()

auto token = phase.arrive();                             // barrier::arrival_token
do_unrelated_work();
phase.wait(std::move(token));                            // wait for this phase

phase.arrive_and_drop();      // arrive AND permanently decrement future counts
static_assert(std::barrier<>::max() > 0);
```

| Facility | Header | Key members | Semantics |
|---|---|---|---|
| `counting_semaphore<N>` | `<semaphore>` | `acquire`, `try_acquire`, `try_acquire_for/until`, `release(n = 1)`, `static max()` | counts permits; no ownership; release by any thread; `release` past `max()` is UB |
| `binary_semaphore` | `<semaphore>` | alias for `counting_semaphore<1>` | signalling flag, **not** a mutex |
| `latch` | `<latch>` | `count_down(n = 1)`, `try_wait()`, `wait()`, `arrive_and_wait(n = 1)`, `static max()` | one-shot; counting past zero is UB; never resets |
| `barrier<CompletionFn>` | `<barrier>` | `arrive(n = 1) → arrival_token`, `wait(token)`, `arrive_and_wait()`, `arrive_and_drop()`, `static max()` | reusable phases; completion runs once per phase, on one participating thread, and must be `noexcept` |

```text
Choosing:
  mutex      ── exclusive ownership around an invariant; unlock by the owner
  semaphore  ── N transferable permits (throttle, bounded queue slots, signalling)
  latch      ── "everyone reached the start line", exactly once
  barrier    ── "everyone finished phase k" — repeatedly
  cv         ── an arbitrary predicate over shared state
```

```cpp
// ---- bounded queue built from two semaphores -----------------------------
template<class T, std::size_t N>
class BoundedQueue {
public:
    void push(T v) {
        empty_.acquire();                                // reserve a slot
        { std::lock_guard lk{m_}; q_.push_back(std::move(v)); }
        full_.release();                                 // publish an item
    }
    T pop() {
        full_.acquire();
        T v;
        { std::lock_guard lk{m_}; v = std::move(q_.front()); q_.pop_front(); }
        empty_.release();
        return v;
    }
private:
    std::mutex m_;
    std::deque<T> q_;
    std::counting_semaphore<N> empty_{N}, full_{0};
};
// No shutdown path here: release the semaphores N times, or add a closed_ flag.
```

**Traps** — `binary_semaphore` used as a mutex loses ownership checking and RAII · `release()` beyond `max()` is UB, not saturation · `latch::count_down` past zero is UB · a barrier phase that loses a participant (exception, early return, cancellation) hangs every other participant — use `arrive_and_drop` on exit paths · barrier completion functions that throw call `std::terminate` · semaphores have no RAII wrapper in the standard: write your own `acquire`/`release` guard.

---

## 28.9 Futures, promises, packaged tasks, and `std::async` policy traps

```cpp
#include <future>

// ---- promise / future ---------------------------------------------------
std::promise<Result> p;
std::future<Result>  f = p.get_future();          // exactly once per promise

std::jthread worker{[p = std::move(p)]() mutable {
    try { p.set_value(calculate()); }
    catch (...) { p.set_exception(std::current_exception()); }
}};

Result r = f.get();                               // waits; MOVES out; rethrows
// f.valid() == false now — a second get() is UB (typically future_error)
```

```cpp
// ---- every future/promise call form -------------------------------------
std::promise<int>   pi;  pi.set_value(1);
std::promise<int&>  pr;  int x = 0; pr.set_value(x);        // reference spec.
std::promise<void>  pv;  pv.set_value();                    // void spec.
pi.set_exception(std::make_exception_ptr(std::runtime_error{"x"}));
pi.set_value_at_thread_exit(1);          // ready only after TLS destructors run
pi.set_exception_at_thread_exit(eptr);

f.wait();                                                    // block until ready
std::future_status st = f.wait_for(10ms);                    // ready|timeout|deferred
st = f.wait_until(deadline);
bool ok = f.valid();
std::shared_future<Result> sf = f.share();                   // f becomes invalid
std::shared_future<Result> sf2 = std::move(f2);              // or move-construct
Result const& ref = sf.get();                                // const& (T& for T&)
Result const& ref2 = sf.get();                               // repeatable, multi-thread
```

```cpp
// ---- packaged_task ------------------------------------------------------
std::packaged_task<int(int, int)> task{[](int a, int b){ return a + b; }};
std::future<int> tf = task.get_future();
task(2, 3);                                       // runs HERE; fulfils the future
// task.make_ready_at_thread_exit(2, 3);          // defer readiness to thread exit
task.reset();                                     // fresh shared state; get_future() again
bool live = task.valid();
std::packaged_task<int(int,int)> moved = std::move(task);    // move-only
// Ideal work-queue element: erases the callable, carries the result channel.
```

```cpp
// ---- std::async and its policies ----------------------------------------
auto a = std::async(std::launch::async, work, 1);     // NEW thread (as-if)
auto d = std::async(std::launch::deferred, work, 2);  // runs on get()/wait(), lazily
auto e = std::async(work, 3);                         // async|deferred: UNSPECIFIED
auto c = std::async(std::launch::async | std::launch::deferred, work, 4);

if (d.wait_for(0s) == std::future_status::deferred) { /* not started yet */ }

// THE TRAP: a future from std::async blocks in its destructor until ready.
std::async(std::launch::async, slow);   // temporary → dtor JOINS → serialized!
{ auto f1 = std::async(std::launch::async, slow_a);
  auto f2 = std::async(std::launch::async, slow_b); }   // these DO overlap
// Only async-launched std::async futures block; promise/packaged_task futures
// do NOT block in their destructor.
```

| Facility | Key members | Notes |
|---|---|---|
| `std::promise<T>` | `get_future()`, `set_value(v)`, `set_exception(p)`, `set_*_at_thread_exit`, `swap` | move-only; second set → `promise_already_satisfied`; destroyed unset → `broken_promise` |
| `std::future<T>` | `get()`, `valid()`, `wait()`, `wait_for()`, `wait_until()`, `share()` | move-only; `get()` once; `get()` on invalid = UB |
| `std::shared_future<T>` | same minus `share()`; `get()` returns `const T&` | copyable; many threads may `get()` concurrently on the *same object* only if they don't mutate it — safest is one copy per thread |
| `std::packaged_task<R(A...)>` | `operator()`, `get_future()`, `valid()`, `reset()`, `make_ready_at_thread_exit()`, `swap` | move-only; calling twice without `reset` → `promise_already_satisfied` |
| `std::async(policy, f, args...)` | returns `std::future<std::invoke_result_t<...>>` | args decay-copied like `thread`; `bad_alloc`/`system_error` on failure |
| `std::future_error` | `.code()` | `broken_promise`, `future_already_retrieved`, `promise_already_satisfied`, `no_state` |
| `std::future_status` | `ready`, `timeout`, `deferred` | `wait_for(0s) == deferred` detects laziness |
| `std::launch` | `async`, `deferred` (bitmask) | default is `async \| deferred` |

```cpp
// ---- a minimal thread pool from packaged_task ----------------------------
class Pool {
public:
    explicit Pool(unsigned n) {
        for (unsigned i = 0; i < n; ++i)
            workers_.emplace_back([this](std::stop_token st){ run(st); });
    }
    ~Pool() {
        for (auto& w : workers_) w.request_stop();
        { std::lock_guard lk{m_}; closed_ = true; }
        cv_.notify_all();
    }                                                  // jthreads join here
    template<class F, class... A>
    auto submit(F&& f, A&&... a) -> std::future<std::invoke_result_t<F, A...>> {
        using R = std::invoke_result_t<F, A...>;
        auto task = std::make_shared<std::packaged_task<R()>>(
            std::bind_front(std::forward<F>(f), std::forward<A>(a)...));
        auto fut = task->get_future();
        { std::lock_guard lk{m_}; jobs_.emplace_back([task]{ (*task)(); }); }
        cv_.notify_one();
        return fut;                                    // packaged_task is move-only
    }                                                  // → shared_ptr into std::function
private:
    void run(std::stop_token st) {
        std::stop_callback cb{st, [this]{ cv_.notify_all(); }};
        for (;;) {
            std::unique_lock lk{m_};
            cv_.wait(lk, [&]{ return closed_ || st.stop_requested() || !jobs_.empty(); });
            if (jobs_.empty()) return;                 // drained
            auto job = std::move(jobs_.front()); jobs_.pop_front();
            lk.unlock();
            job();                                     // NEVER run user code locked
        }
    }
    std::mutex m_;
    std::condition_variable cv_;
    std::deque<std::function<void()>> jobs_;
    bool closed_ = false;
    std::vector<std::jthread> workers_;                // declared LAST → joined FIRST
};
```

**Interview line** — "`std::async` is not a thread pool: the default policy may defer to `get()`, and an `async`-launched future blocks in its destructor, so discarding it serializes your code."

**Traps** — `std::async(f); std::async(g);` runs sequentially because each temporary future joins · a deferred future never runs if you only call `wait_for` · `future::get()` on a deferred future runs the work on the *calling* thread · shared state allocation makes `future` unsuitable for hot paths · `packaged_task` is move-only so it does not fit in `std::function` (C++23 `std::move_only_function` does) · an exception escaping an `async` task is stored and rethrown at `get()`, not at the call site · storing exceptions requires the task's callable to be reachable — a destroyed promise yields `broken_promise`, which reads as a mysterious hang-turned-throw.

---

## 28.10 Thread ownership, affinity/non-standard extensions, and shutdown protocols

```text
Shutdown is an ORDERING PROTOCOL — every step, in order:
  1 stop accepting external work (close the admission door)
  2 request cancellation of producers
  3 wake every blocking wait: close queues, notify_all, release semaphores
  4 producers stop publishing
  5 consumers drain (process the rest) or discard — an EXPLICIT policy, not luck
  6 join every thread
  7 destroy queues, pools, buffers, and the services they referenced
```

```cpp
class Service {
public:
    // Two-phase start: 'this' is fully constructed before any thread sees it.
    static std::unique_ptr<Service> create() {
        auto s = std::unique_ptr<Service>{new Service{}};
        s->start();
        return s;
    }
    ~Service() {
        worker_.request_stop();                 // (2)
        { std::lock_guard lock{mutex_}; closed_ = true; }   // (1)
        cv_.notify_all();                       // (3)
    }                                           // (6) jthread member joins here,
                                                //     BEFORE mutex_/cv_ die
private:
    Service() = default;
    void start() { worker_ = std::jthread{[this](std::stop_token st){ run(st); }}; }

    void run(std::stop_token st) {
        for (;;) {
            std::unique_lock lock{mutex_};
            cv_.wait(lock, [&]{ return closed_ || st.stop_requested() || !q_.empty(); });
            if (q_.empty()) return;             // (4)(5) drained ⇒ exit
            auto item = std::move(q_.front()); q_.pop_front();
            lock.unlock();
            handle(item);
        }
    }
    std::mutex mutex_;
    std::condition_variable cv_;
    std::deque<Item> q_;
    bool closed_ = false;
    std::jthread worker_;                       // LAST member ⇒ destroyed FIRST
};
```

| Ownership question | Answer you must be able to give |
|---|---|
| Who owns the thread handle? | exactly one object, with a destructor that joins |
| Who owns each shared object? | one owner; others hold references valid until join |
| What outlives the thread? | every object it captures — prove it, don't hope |
| How does it stop? | a named mechanism: token, sentinel value, closed flag, semaphore |
| How does a blocked wait wake? | notify_all / close / release / stop-aware wait — name it |
| Drain or discard? | a documented policy, chosen deliberately |

| Non-standard control | Reality |
|---|---|
| Thread name | `pthread_setname_np`, `SetThreadDescription` — via `native_handle()` |
| CPU affinity | `pthread_setaffinity_np`, `SetThreadAffinityMask`, `taskset`, `numactl` |
| Priority / RT policy | `sched_setscheduler`, `SCHED_FIFO`, `SetThreadPriority` |
| Stack size | pthread attributes at creation — **not** settable through `std::thread` |
| NUMA placement | `numa_alloc_onnode`, first-touch policy |
| Isolation | `isolcpus`, `nohz_full`, IRQ affinity — the real latency wins on Linux |
| `native_handle()` | the only standard door to all of the above; no portable semantics |

```cpp
// ---- pinning a jthread (Linux; not portable) -----------------------------
#ifdef __linux__
void pin(std::jthread& t, int cpu) {
    cpu_set_t set; CPU_ZERO(&set); CPU_SET(cpu, &set);
    ::pthread_setaffinity_np(t.native_handle(), sizeof(set), &set);
}
#endif
```

```cpp
// ---- starting a thread from a constructor is a publication race ----------
struct Bad {
    Bad() : t_{[this]{ use(*this); }} {}     // 'this' visible before derived ctors run
    virtual void use(Bad&);                  // virtual dispatch is WRONG here
    std::jthread t_;
};
// Fix: two-phase construction (see Service::create above) or a start() method.
```

| Mechanism | Cost model |
|---|---|
| Thread creation | syscall, stack reserve/commit, TLS init — µs-scale; never in a hot path |
| Uncontended mutex lock/unlock | one atomic RMW + compiler barriers — ~20 ns scale, implementation-specific |
| Contended mutex | cache-line transfer, spin, futex park/wake, scheduler delay — µs to ms |
| Condition variable wake | kernel-assisted; no latency bound |
| `shared_mutex` | larger state, more atomics; readers can starve writers or vice versa |
| `thread_local` access | TLS-register offset (fast) or `__tls_get_addr` call (slow, dynamic model) |
| `future`/`promise` | shared-state allocation + atomic refcount + synchronization |
| `std::async` | may create a thread per call |
| Oversubscription | context switches, cache/TLB pollution, scheduler jitter |
| False sharing | two hot fields in one cache line silently serialize threads |

**Interview line** — "The fastest synchronization is ownership: confine mutable state to one thread and communicate through a proved handoff; reach for a mutex when sharing is genuinely required, and never weaken the lifetime, predicate, or shutdown protocol to remove an uncontended lock from a benchmark."

**Rapid diagnoses**

| Symptom | Cause | Fix |
|---|---|---|
| Unexpected `std::terminate` at scope exit | joinable `std::thread` destroyed (often on an exception path) | `jthread` or an RAII joiner |
| Intermittent use-after-scope | detached/long-lived worker captured `this`, a reference, or a `string_view` | join before the lifetime ends, or transfer ownership |
| Wait occasionally hangs | predicate mutated outside the mutex, or bare `wait` without a loop | state under mutex + `wait(lock, pred)` |
| Shutdown never returns | stop requested but the worker sits in a non-stop-aware wait | close + `notify_all`, or `condition_variable_any::wait(lock, token, pred)` |
| Two operations freeze each other | inconsistent lock order | `scoped_lock`/`std::lock`, or one global order |
| Stale/corrupt payload behind an atomic flag | no release/acquire publication edge | see #ch29 / #ch30 |
| "Parallel" code is exactly as slow as serial | discarded `std::async` futures joining in their destructors | keep the futures alive to the end of the region |
| Throughput collapses as threads increase | false sharing or a single global mutex | pad to `hardware_destructive_interference_size`, shard, or confine |
