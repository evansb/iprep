# 43. Testing C++ components

*Part VII — Correctness, testing, and performance validation*

---

**Recall**
- Pick the smallest test that can falsify a guarantee; a green happy-path unit test proves almost nothing about lifetime, failure, or ordering.
- Every component answers five independent questions: value correctness, ownership/invalidation, failure state, synchronization/progress, and steady-state allocation cost.
- Assert **observable contracts** — return value, public projection, event order, resource counts, digests — never private capacity, bucket count, or object address.
- A test seam exists where real nondeterminism lives: clock, RNG, scheduler, allocator, byte source, sink, syscall — not on every class "for testing".
- Dependency injection in C++ is usually a template parameter or a reference, not a virtual base; `[[no_unique_address]]` keeps stateless policies free.
- A **fake** has behavior, a **stub** returns canned data, a **mock** asserts interactions — prefer state assertions because interaction assertions break on harmless refactors.
- `sleep_for` in a unit test measures the OS scheduler, not your component: inject a manual clock and advance to `deadline-1`, `deadline`, `deadline+1`.
- Standard *engines* (`mt19937_64`) are algorithm-specified and portable; standard *distributions* are not — capture generated actions, not just the seed.
- "It didn't crash on a million random inputs" is not a property; a property is an invariant, a model equivalence, or a round trip.
- Shrinking to a minimal failing action sequence beats retaining a huge seed; keep seed + minimized trace + toolchain in every failure report.
- `std::pmr::memory_resource` is the cheapest allocation seam: subclass it to count, to fail on the Nth call, and to detect leaks — but it only sees allocations routed through it.
- Exhaustive failure injection = loop `budget = 0..N_success`, construct fresh, expect throw, then assert the advertised strong/basic guarantee plus zero leaks.
- Strong guarantee ⇒ observable state equals the pre-call snapshot; basic ⇒ invariants hold and nothing leaks; no-throw ⇒ mark it `noexcept` and `static_assert` it.
- Test invalidation through safe handles (index, generation) — dereferencing a known-dangling pointer is UB in the *test*, not a demonstration.
- Force reallocation with `reserve(capacity() + 1)`; never assume a growth factor or a resulting capacity.
- Differential testing needs *implementation independence*: a model that shares production helpers agrees with production bugs.
- Fuzz targets must be deterministic, bounded, allocation-capped, and state-reset per invocation; every crash becomes a corpus entry.
- Reduced-width counters (`std::uint8_t` sequence) reach wraparound in microseconds — but only if the algorithm's modular-distance assumption survives the smaller width.
- TSan finds data races, not linearizability, progress, or every ordering bug; a relaxed-only queue passes billions of iterations on x86.
- Compile-time interface tests (`concept` + `static_assert`) pin API shape, `noexcept`, and constexpr evaluation for free at zero runtime cost.
- Sanitizer builds change timing and layout: they are correctness evidence, never latency evidence.

---

## 43.1 Unit, integration, property, differential, and fuzz testing

```text
compile-time contract ── static_assert / concepts / negative compile tests
single operation       ── unit examples + boundary partitions
operation sequences    ── property / state-machine tests + shrinking
equivalent design      ── differential comparison against a reference model
byte boundary          ── fuzz target + corpus + sanitizers
thread protocol        ── forced interleavings + long stress + TSan
component graph        ── integration test owning real boundaries
performance claim      ── separate benchmark + allocation instrumentation
```

| Test type | Best at | Does **not** prove alone |
|---|---|---|
| unit / example | named cases, local transitions, diagnostics | sequence coverage, concurrency, absence of UB |
| table-driven | input partitions, boundary matrices | emergent long-sequence behavior |
| property / state-machine | invariants across generated sequences | correctness of the oracle itself |
| differential | optimized impl vs. simple model | that both don't share one wrong assumption |
| fuzz | malformed bytes, parser states, odd combinations | semantic coverage, thread schedules |
| integration | wiring, ownership across real components | edge cases, fault isolation |
| stress | rare scheduling / capacity / wrap events | deterministic repro, memory-model correctness |
| compile-time | API shape, constraints, constant evaluation | runtime semantics and cost |

```cpp
// ---- unit example: named case, exact boundary --------------------------
TEST_CASE("ring reports exact usable capacity") {
    SpscRing<int, 8> r;                    // 8 slots
    CHECK(r.empty());
    for (int i = 0; i != 7; ++i) CHECK(r.try_push(i));   // one slot reserved
    CHECK_FALSE(r.try_push(7));            // full
    CHECK(r.size() == 7);
}
```

```cpp
// ---- table-driven: partitions in one place ----------------------------
struct Case { std::string_view input; std::optional<Price> expect; char const* why; };

constexpr Case kCases[]{
    {"0",         Price{0},        "zero is legal"},
    {"1",         Price{1},        "one"},
    {"2147483647",Price{2147483647},"max"},
    {"2147483648",std::nullopt,    "max+1 overflows"},
    {"-1",        std::nullopt,    "negative rejected"},
    {"",          std::nullopt,    "empty"},
    {" 1",        std::nullopt,    "no leading space allowed"},
    {"01",        Price{1},        "leading zero permitted by spec"},
};

TEST_CASE("parse_price partitions") {
    for (auto const& c : kCases) {
        INFO(c.why << " input=" << c.input);
        CHECK(parse_price(c.input) == c.expect);
    }
}
```

```cpp
// ---- property: invariant over generated sequences ----------------------
TEST_CASE("book invariants hold for every generated action sequence") {
    for (std::uint64_t seed : kRegressionSeeds) {          // pinned + random
        std::mt19937_64 rng{seed};
        Book book; ReferenceBook model;
        std::vector<Action> trace;                          // for shrinking
        for (int step = 0; step != 2'000; ++step) {
            Action a = generate_action(rng, book);          // biased to boundaries
            trace.push_back(a);
            auto got = apply(book, a);
            auto want = apply(model, a);
            REQUIRE_MESSAGE(got == want, "seed=" << seed << " step=" << step
                                                 << " trace=" << render(trace));
            REQUIRE(book.check_invariants());
        }
    }
}
```

```cpp
// ---- differential: same input, two independent implementations ---------
TEST_CASE("SIMD parser matches scalar parser") {
    for (auto const& msg : corpus()) {
        auto a = parse_scalar(msg);
        auto b = parse_simd(msg);
        CHECK(a.has_value() == b.has_value());
        if (a) CHECK(canonical(*a) == canonical(*b));   // compare projections
    }
}
```

```cpp
// ---- fuzz: bounded, deterministic, side-effect-free --------------------
extern "C" int LLVMFuzzerTestOneInput(std::uint8_t const* data, std::size_t size) {
    if (size > 64 * 1024) return -1;                 // cap per-input work
    auto bytes = std::span{reinterpret_cast<std::byte const*>(data), size};
    Decoder d;                                       // fresh state every call
    if (auto msg = d.decode(bytes)) {
        assert(invariants(*msg));
        std::array<std::byte, 4096> out{};
        auto n = encode(*msg, out);                  // round trip
        auto again = d.decode(std::span{out.data(), n});
        assert(again && canonical(*again) == canonical(*msg));
    } else {
        assert(d.error_offset() <= size);            // error position bounded
    }
    return 0;
}
```

```cpp
// ---- integration: real boundaries, owned lifetimes ---------------------
TEST_CASE("feed → book → publisher end to end") {
    TempDir dir;                                     // RAII, unique per test
    FileByteSource src{dir.write("capture.bin", golden_capture())};
    Book book; SnapshotPublisher pub{4};
    FeedHandler feed{src, book, pub};
    feed.run_to_end();
    CHECK(pub.latest().version == kExpectedVersion);
    CHECK(digest(book) == kGoldenDigest);
}
```

**Assert these** — returned value/error code · public state projection · emitted event sequence · allocation/resource counts · explicit invariant checker · documented callback order.

**Never assert** — `v.capacity()` · `m.bucket_count()` · `&obj` · comparator call count · unordered-container iteration order · generated instruction count.

**Interview line** — "Layer the tests: a decoder gets table cases, a fuzz target, sanitizer runs, and a replay integration test — not one enormous end-to-end test."

**Traps** — one giant e2e test hides which layer broke · asserting hash iteration order gives a golden that changes with the standard library · "no crash" fuzzing without invariant asserts finds only segfaults.

---

## 43.2 Test seams without runtime-polymorphism overhead

```cpp
// ---- seam form 1: template policies, zero indirection ------------------
template<class Clock, class Sink, class Allocator = std::allocator<std::byte>>
class RetryController {
public:
    RetryController(Clock& clock, Sink& sink, Allocator alloc = {})
        : clock_{clock}, sink_{sink}, alloc_{alloc} {}

    void on_failure() {
        ++attempts_;
        next_due_ = clock_.now() + backoff(attempts_);
        sink_.emit(Event::Scheduled{next_due_});
    }
    bool poll() {                                   // deterministic turn
        if (clock_.now() < next_due_) return false;
        sink_.emit(Event::Retry{attempts_});
        return true;
    }
private:
    Clock& clock_;                                  // non-owning: fixture owns it
    Sink&  sink_;
    [[no_unique_address]] Allocator alloc_;         // stateless → 0 bytes (C++20)
    typename Clock::time_point next_due_{};
    int attempts_{};
};

using Production = RetryController<std::chrono::steady_clock, UdpSink>;
using UnderTest  = RetryController<ManualClock, RecordingSink>;
```

```cpp
// ---- seam form 2: callable template parameter (no member at all) -------
template<std::invocable<Message const&> OnMessage>
void drain(Ring& r, OnMessage on_message) {         // inlined at both sites
    Message m;
    while (r.try_pop(m)) on_message(m);
}
drain(r, [&](Message const& m) { seen.push_back(m); });   // test
```

```cpp
// ---- seam form 3: function pointer + context (ABI-stable, no template) -
struct SinkVTable {
    void (*emit)(void* ctx, Event const&) noexcept;
    void* ctx;
};
inline void emit(SinkVTable const& s, Event const& e) noexcept { s.emit(s.ctx, e); }
```

```cpp
// ---- seam form 4: data in, not I/O hidden inside ----------------------
// BAD : void Handler::run();                      // opens a socket internally
// GOOD:
std::size_t Handler::consume(std::span<std::byte const> bytes);   // testable
```

```cpp
// ---- seam form 5: narrow virtual interface, used only where substitution
//                   is a real production requirement -------------------
struct IClock {
    virtual ~IClock() = default;
    virtual std::chrono::nanoseconds now() const noexcept = 0;
};
// One virtual call per timer tick is fine; one per order is not.
```

| Seam mechanism | Runtime cost | Substitutable at | Use when |
|---|---|---|---|
| template policy parameter | none (inlined) | compile time | hot path, one impl per binary |
| callable template param | none | compile time | callbacks, visitors, drains |
| `[[no_unique_address]]` policy member | 0 bytes if empty | compile time | allocators, comparators, tags |
| function pointer + `void*` ctx | 1 indirect call | run time | C ABI, plugin boundary |
| reference to narrow interface | 1 virtual call | run time | genuinely polymorphic boundary |
| `std::span` / iterator input | none | n/a | replaces hidden I/O |
| link seam (replace TU at link) | none | link time | platform syscall wrappers only |

**Fake vs stub vs mock**

| Kind | Definition | Assertion style | Brittleness |
|---|---|---|---|
| fake | working simplified implementation (in-memory sink, `map`-backed store) | state after | low |
| stub | returns canned values | result | low |
| spy | records calls, asserts later, optionally | recorded sequence | medium |
| mock | asserts interactions as they happen (`EXPECT_CALL`) | call order/count | high |

```cpp
// ---- a fake with real behavior beats a mock ---------------------------
class RecordingSink {
public:
    void emit(Event const& e) { events_.push_back(e); }
    std::span<Event const> events() const noexcept { return events_; }
    void clear() noexcept { events_.clear(); }
private:
    std::vector<Event> events_;
};

CHECK(sink.events() == std::vector<Event>{Event::Scheduled{t1}, Event::Retry{1}});
// asserts the *documented* event sequence, not "clock_.now() was called twice"
```

**Traps** — adding a virtual base to every class doubles indirection and kills inlining for a testing benefit a template gives free · a mock on call counts turns refactors into test rewrites · seams that change production semantics (extra atomics, extra branches in the hot loop) invalidate the thing you measured · `[[no_unique_address]]` only elides *empty* types.

---

## 43.3 Deterministic clocks, RNGs, schedulers, and allocators

```cpp
// ---- manual clock satisfying the Clock named requirements --------------
#include <chrono>

class ManualClock {
public:
    using duration   = std::chrono::nanoseconds;
    using rep        = duration::rep;
    using period     = duration::period;
    using time_point = std::chrono::time_point<ManualClock>;
    static constexpr bool is_steady = true;

    [[nodiscard]] time_point now() const noexcept { return now_; }   // member form
    void advance(duration d) noexcept { now_ += d; }
    void set(time_point t) noexcept { now_ = t; }
private:
    time_point now_{};
};
static_assert(std::chrono::is_clock_v<ManualClock> == false);  // no static now()

// If you need std::chrono::is_clock_v<C>, add the static form + a global state:
struct StaticManualClock {
    using duration = std::chrono::nanoseconds;
    using rep = duration::rep; using period = duration::period;
    using time_point = std::chrono::time_point<StaticManualClock>;
    static constexpr bool is_steady = true;
    static inline time_point current{};
    static time_point now() noexcept { return current; }   // test-only global!
};
static_assert(std::chrono::is_clock_v<StaticManualClock>);
```

```cpp
// ---- test exactly three points around every deadline -------------------
TEST_CASE("timer fires at the deadline, not before") {
    ManualClock clk; RecordingSink sink;
    RetryController<ManualClock, RecordingSink> rc{clk, sink};
    rc.on_failure();                       // due at now + 100ms

    clk.advance(99ms);  CHECK_FALSE(rc.poll());    // now <  deadline → not due
    clk.advance(1ms);   CHECK(rc.poll());          // now == deadline → due
    clk.advance(1h);    CHECK(rc.poll());          // now >  deadline → late, still due
}
// NEVER: std::this_thread::sleep_for(100ms); CHECK(rc.poll());
```

| Time construct | Test replacement |
|---|---|
| `steady_clock::now()` sprinkled everywhere | one seam; pass captured `now` downward |
| `sleep_for` / `sleep_until` | `clock.advance(d)` + explicit `poll()` turn |
| `condition_variable::wait_for` | `wait` + injected predicate flip, or a fake timer queue |
| `system_clock` in logic | forbidden — it can jump backwards; use `steady_clock` |
| real-clock integration test | one-sided generous bound: `CHECK(elapsed < 5s)`, assert liveness not precision |

```cpp
// ---- deterministic RNG: inject the engine, never hide random_device ----
#include <random>

class Simulator {
public:
    explicit Simulator(std::mt19937_64& rng) : rng_{rng} {}   // seam
    int next_qty() { return std::uniform_int_distribution<int>{1, 100}(rng_); }
private:
    std::mt19937_64& rng_;
};

std::mt19937_64 rng{0x5eedULL};            // reproducible
// std::random_device rd; std::mt19937_64 rng{rd()};   // production only
```

```cpp
// ---- engines are portable, distributions are NOT ----------------------
std::mt19937_64 e{42};
auto a = e();                              // SAME value on every conforming impl
std::uniform_int_distribution<int> d{0, 9};
auto b = d(e);                             // implementation-defined mapping!
// Portable golden: define the mapping yourself.
constexpr int pick(std::uint64_t x, int n) { return int(((x >> 32) * n) >> 32); }
auto c = pick(e(), 10);                    // reproducible across libstdc++/libc++/MSVC
```

```cpp
// ---- record the trace, not only the seed ------------------------------
struct Trial {
    std::uint64_t seed;
    std::vector<Action> actions;           // this is what you shrink and keep
};
inline constexpr std::uint64_t kRegressionSeeds[]{
    0x5eed, 0xdeadbeef, 0x1, 0xffff'ffff'ffff'ffff,     // pinned past failures
};
TEST_CASE("randomized sweep") {
    std::random_device rd;
    std::uint64_t seed = std::getenv("TEST_SEED")
                       ? std::strtoull(std::getenv("TEST_SEED"), nullptr, 0)
                       : (std::uint64_t(rd()) << 32 | rd());
    INFO("re-run with TEST_SEED=0x" << std::hex << seed);   // printed on failure
    run_generated_scenario(seed);
}
```

```cpp
// ---- shrinking: minimize the failing action sequence -------------------
template<class Trace, class Fails>
Trace shrink(Trace t, Fails fails) {                 // fails(t) == true initially
    bool changed = true;
    while (changed) {
        changed = false;
        for (std::size_t i = 0; i < t.size(); ) {    // try deleting each action
            Trace candidate = t;
            candidate.erase(candidate.begin() + i);
            if (fails(candidate)) { t = std::move(candidate); changed = true; }
            else ++i;
        }
        for (auto& a : t)                            // then simplify each value
            if (auto smaller = simplify(a); smaller && fails(with(t, *smaller)))
                { a = *smaller; changed = true; }
    }
    return t;
}
```

```cpp
// ---- deterministic scheduler: name the protocol points ----------------
// after load, before CAS │ after reservation, before publication
// after acquire, before payload read │ after retire, before reclamation
// before wait, after predicate update, before notify

#include <barrier>
#include <thread>

TEST_CASE("reader that paused after identity load sees no torn payload") {
    Publisher pub;
    std::barrier sync{2};

    std::jthread reader([&] {
        auto id = pub.identity.load(std::memory_order_acquire);  // POINT A
        sync.arrive_and_wait();                                  // let writer publish
        sync.arrive_and_wait();                                  // writer done
        auto snap = pub.read_payload(id);                        // POINT B
        CHECK(snap.checksum == compute(snap));                   // never torn
    });

    sync.arrive_and_wait();
    pub.publish_next();                     // races exactly at the chosen point
    pub.try_reclaim_old();
    sync.arrive_and_wait();
}
// A forced schedule tests ONE interleaving; it complements TSan + long stress,
// it does not replace them. Never add an unsynchronized debug flag to steer it —
// that flag is itself a data race.
```

```cpp
// ---- deterministic executor: turn-by-turn, single-threaded -------------
class TestExecutor {
public:
    void post(std::move_only_function<void()> f) { q_.push_back(std::move(f)); }
    bool run_one() {                          // one deterministic turn
        if (q_.empty()) return false;
        auto f = std::move(q_.front()); q_.pop_front(); f(); return true;
    }
    std::size_t run_all() { std::size_t n = 0; while (run_one()) ++n; return n; }
    std::size_t pending() const noexcept { return q_.size(); }
private:
    std::deque<std::move_only_function<void()>> q_;   // C++23
};
```

```cpp
// ---- allocation seam: counting pmr resource ---------------------------
#include <memory_resource>

class CountingResource final : public std::pmr::memory_resource {
public:
    explicit CountingResource(std::pmr::memory_resource* up = std::pmr::new_delete_resource())
        : up_{up} {}
    std::size_t allocations() const noexcept { return allocs_; }
    std::size_t live_bytes()  const noexcept { return live_; }
    std::size_t peak_bytes()  const noexcept { return peak_; }
    void reset_counters() noexcept { allocs_ = 0; }
private:
    void* do_allocate(std::size_t n, std::size_t a) override {
        ++allocs_; live_ += n; peak_ = std::max(peak_, live_);
        return up_->allocate(n, a);
    }
    void do_deallocate(void* p, std::size_t n, std::size_t a) override {
        live_ -= n; up_->deallocate(p, n, a);
    }
    bool do_is_equal(memory_resource const& o) const noexcept override { return this == &o; }
    std::pmr::memory_resource* up_;
    std::size_t allocs_{}, live_{}, peak_{};
};

TEST_CASE("steady state allocates nothing") {
    CountingResource mem;
    std::pmr::vector<Order> orders{&mem};
    orders.reserve(4096);                       // configure + warm phase
    Engine engine{orders};
    engine.warm();                              // one-time library paths
    mem.reset_counters();                       // ---- record ----
    for (auto const& ev : representative_stream()) engine.apply(ev);
    CHECK(mem.allocations() == 0);              // steady state is allocation-free
    CHECK(mem.live_bytes() > 0);
}
```

**Traps** — `sleep_for` makes a test that measures the CI machine · a seed alone does not reproduce a bug that used `random_device` or wall time · `std::pmr` counters see only what routes through that resource: a `std::string` member, a callback, or a `new` inside a third-party lib is invisible · a global `operator new` hook has wider reach but also catches the test framework's own allocations — scope it with a thread-local enable flag · `is_clock_v` requires a *static* `now()`, so member-style manual clocks fail it deliberately.

---

## 43.4 Lifetime, exception-safety, and allocation-failure tests

```cpp
// ---- lifetime probe: counts every special member ----------------------
struct LifetimeProbe {
    static inline int live = 0, ctors = 0, copies = 0, moves = 0,
                      copy_assigns = 0, move_assigns = 0, dtors = 0;
    static void reset() noexcept { live = ctors = copies = moves =
                                   copy_assigns = move_assigns = dtors = 0; }

    int value{};
    explicit LifetimeProbe(int v = 0) : value{v} { ++live; ++ctors; }
    LifetimeProbe(LifetimeProbe const& o) : value{o.value} { ++live; ++copies; }
    LifetimeProbe(LifetimeProbe&& o) noexcept : value{o.value} { o.value = -1; ++live; ++moves; }
    LifetimeProbe& operator=(LifetimeProbe const& o) { value = o.value; ++copy_assigns; return *this; }
    LifetimeProbe& operator=(LifetimeProbe&& o) noexcept { value = o.value; o.value = -1; ++move_assigns; return *this; }
    ~LifetimeProbe() { --live; ++dtors; }        // destructors NEVER throw
};

// RAII guard so a failing assertion cannot poison the next test
struct ProbeScope {
    ProbeScope() { LifetimeProbe::reset(); }
    ~ProbeScope() { CHECK(LifetimeProbe::live == 0); }   // no leaks
};
```

```cpp
TEST_CASE("pool destroys before reusing storage") {
    ProbeScope scope;
    Pool<LifetimeProbe, 4> pool;
    auto* a = pool.construct(1);
    CHECK(LifetimeProbe::live == 1);
    pool.destroy(a);
    CHECK(LifetimeProbe::live == 0);
    CHECK(LifetimeProbe::dtors == 1);            // destroyed BEFORE slot reuse
    auto* b = pool.construct(2);
    CHECK(LifetimeProbe::live == 1);
    CHECK(b->value == 2);                        // not a resurrected 1
    pool.destroy(b);
}
```

**Lifetime assertion checklist** — every constructed object destroyed exactly once · failed construction destroys already-built subobjects · pool release destroys before reuse · move-only and non-default-constructible payloads work where promised · destruction order keeps referenced dependencies alive · moved-from objects touched only within their stated valid-but-unspecified contract.

```cpp
// ---- throwing probe: fail on the Nth operation ------------------------
struct InjectedFailure : std::exception {
    char const* what() const noexcept override { return "injected"; }
};

struct ThrowingProbe {
    static inline int copies_until_throw = -1;   // -1 = never
    static inline int live = 0;
    static void arm_copy(int n) noexcept { copies_until_throw = n; }
    static void disarm() noexcept { copies_until_throw = -1; }

    int value{};
    explicit ThrowingProbe(int v = 0) : value{v} { ++live; }
    ThrowingProbe(ThrowingProbe const& o) : value{o.value} {
        if (copies_until_throw == 0) throw InjectedFailure{};
        if (copies_until_throw > 0) --copies_until_throw;
        ++live;
    }
    ThrowingProbe(ThrowingProbe&&) noexcept;     // NOT noexcept(false):
    ~ThrowingProbe() { --live; }                 // vector relocation needs it
};
// A throwing *move* forces vector to copy (move_if_noexcept) — make a separate
// type for that experiment rather than mutating this one.
```

| Guarantee | Post-failure assertion | How to mark it |
|---|---|---|
| no-throw | operation cannot exit via exception under documented preconditions | `noexcept` + `static_assert(noexcept(x.op()))` |
| strong | observable state == snapshot taken before the call | compare `snapshot()` values |
| basic | invariants hold, nothing leaks; value may have changed | `check_invariants()` + `live == 0` after teardown |
| none | only language minimums; almost never an acceptable implicit default | document loudly or fix |

```cpp
// ---- strong-guarantee test pattern ------------------------------------
TEST_CASE("Book::replace is strongly exception safe") {
    Book book = populated();
    auto before = book.snapshot();                   // canonical value projection
    for (int n = 0; n != 8; ++n) {                   // every throwing point
        ThrowingProbe::arm_copy(n);
        CHECK_THROWS_AS(book.replace(order_id, new_qty), InjectedFailure);
        ThrowingProbe::disarm();
        CHECK(book.snapshot() == before);            // unchanged, observably
        CHECK(book.check_invariants());
    }
    CHECK(book.replace(order_id, new_qty));          // succeeds once disarmed
}
// "Unchanged" means observable value — NOT identical addresses, capacity, or
// allocator internals, unless those are part of the published contract.
```

```cpp
// ---- exhaustive allocation-failure injection --------------------------
class FailingResource final : public std::pmr::memory_resource {
public:
    explicit FailingResource(std::size_t successes) : remaining_{successes} {}
    std::size_t served() const noexcept { return served_; }
    std::size_t live()   const noexcept { return live_; }
private:
    void* do_allocate(std::size_t n, std::size_t a) override {
        if (remaining_ == 0) throw std::bad_alloc{};
        --remaining_; ++served_; ++live_;
        return up_->allocate(n, a);
    }
    void do_deallocate(void* p, std::size_t n, std::size_t a) override {
        --live_; up_->deallocate(p, n, a);
    }
    bool do_is_equal(memory_resource const& o) const noexcept override { return this == &o; }
    std::size_t remaining_, served_{}, live_{};
    std::pmr::memory_resource* up_{std::pmr::new_delete_resource()};
};

TEST_CASE("component survives failure at every allocation point") {
    // 1. measure how many allocations a successful run needs
    std::size_t total = [] {
        FailingResource mem{~std::size_t{0}};
        { Component c{&mem}; c.operation(input()); }
        return mem.served();
    }();

    // 2. fail at each one in turn
    for (std::size_t budget = 0; budget != total; ++budget) {
        FailingResource mem{budget};
        bool threw = false;
        {
            Component c{&mem};
            auto before = c.snapshot();
            try { c.operation(input()); }
            catch (std::bad_alloc const&) { threw = true; CHECK(c.snapshot() == before); }
            CHECK(c.check_invariants());
        }                                        // destructor runs here
        CHECK(mem.live() == 0);                  // no leak on ANY failure path
        CHECK(threw);                            // budget < total must fail
    }
}
```

```cpp
// ---- exception-neutral generic code: throw from the callbacks too ------
struct ThrowingHash    { static inline int until = -1;
    std::size_t operator()(Key const& k) const {
        if (until == 0) throw InjectedFailure{}; if (until > 0) --until;
        return std::hash<Key>{}(k); } };
struct ThrowingEqual   { bool operator()(Key const&, Key const&) const; };
struct ThrowingCompare { bool operator()(Key const&, Key const&) const; };
// A throwing hash/comparator exposes "I already inserted the node, then computed
// the key" bugs that a throwing element type alone will not reach.
```

```cpp
// ---- no-exceptions builds still need failure tests --------------------
// -fno-exceptions does not make partial mutation safe.
TEST_CASE("capacity failure leaves state untouched") {
    FixedBook book{/*capacity=*/2};
    CHECK(book.add(o1) == Status::Ok);
    CHECK(book.add(o2) == Status::Ok);
    auto before = book.snapshot();
    CHECK(book.add(o3) == Status::Full);         // error return, not throw
    CHECK(book.snapshot() == before);            // same strong-guarantee proof
}
```

**Traps** — static probe counters are global mutable state: reset in a fixture and do not run those tests in parallel · a throwing destructor during stack unwinding calls `std::terminate` · a probe with a throwing move silently changes `vector` to copy semantics · exhaustive injection only terminates when the allocation count is bounded and deterministic — cap the loop · asserting `capacity() == before.capacity()` overconstrains the strong guarantee.

---

## 43.5 Container invalidation and boundary-value tests

```cpp
// ---- BAD: the test itself is UB ---------------------------------------
auto* p = &v.front();
v.reserve(v.capacity() + 1);
CHECK(*p == expected);           // UB — dereferencing an invalidated pointer
CHECK(p == &v.front());          // even the comparison is questionable:
                                 // an allocator may hand back the same address
```

```cpp
// ---- GOOD: test the safe abstraction the component promises -----------
TEST_CASE("indices survive growth; pointers are not part of the contract") {
    std::vector<Order> v; v.reserve(2);
    v.push_back(a); v.push_back(b);
    std::size_t idx = 1;                              // handle, not pointer
    while (v.size() <= v.capacity()) v.push_back(make_order());   // force realloc
    CHECK(v[idx].id == b.id);                         // reacquire by index
}

TEST_CASE("generation handle is rejected after slot reuse") {
    Pool<Order, 4> pool;
    auto h = pool.acquire();
    pool.release(h);
    auto h2 = pool.acquire();                         // same slot, new generation
    CHECK(pool.get(h)  == nullptr);                   // stale handle rejected
    CHECK(pool.get(h2) != nullptr);
    CHECK(h.slot == h2.slot);
    CHECK(h.generation != h2.generation);
}

TEST_CASE("pre-sized container performs the maximum legal work without allocating") {
    CountingResource mem;
    std::pmr::vector<Level> levels{&mem};
    levels.reserve(kMaxLevels);
    mem.reset_counters();
    for (std::size_t i = 0; i != kMaxLevels; ++i) levels.emplace_back();
    CHECK(mem.allocations() == 0);
}
```

```cpp
// ---- forcing reallocation without assuming a growth factor -------------
auto force_realloc = [](auto& v) {
    auto old_cap = v.capacity();
    v.reserve(old_cap + 1);          // strictly larger; exact result unspecified
    CHECK(v.capacity() > old_cap);   // the only portable postcondition
};
// v.reserve(v.capacity() * 2) also works but assumes no overflow;
// NEVER assert v.capacity() == 2 * old_cap.
```

**Invalidation contracts under test**

| Container | Operation | Iterators | Pointers / references |
|---|---|---|---|
| `vector` | realloc (`push_back`, `reserve`, `insert`, `resize↑`) | all | all |
| `vector` | `push_back` without realloc | old `end()` only | none |
| `vector` | `erase(pos)` | at and after `pos` | at and after `pos` |
| `deque` | push/pop at either end | **all** | **stay valid** (erased element aside) |
| `deque` | middle insert/erase | all | all |
| `list` / `forward_list` | insert / erase / splice | only the erased node | only the erased node |
| `map` / `set` | insert / erase | only the erased element | only the erased element |
| `unordered_*` | rehash (`insert` past `max_load_factor`) | **all iterators** | references **stay valid** |
| `unordered_*` | `erase` | only the erased element | only the erased element |
| `std::span` / `string_view` | any op on the owner that reallocates | n/a | dangles silently |

```cpp
// ---- unordered rehash: iterators die, references live -----------------
TEST_CASE("unordered_map references survive rehash") {
    std::unordered_map<int, Order> m;
    m.reserve(4);
    auto& ref = m.emplace(1, o1).first->second;
    while (m.bucket_count() == 4) m.emplace(int(m.size()) + 2, make_order());
    CHECK(ref.id == o1.id);            // legal: references are stable across rehash
}
```

**Boundary partition checklist** — apply every line to every precondition:

```text
size        empty | one | capacity-1 | capacity | capacity+1
index       0 | 1 | n-1 | n | n+1 (rejected)
integer     0 | 1 | max-1 | max | max+1 (wrap/overflow path)
signed      min | min+1 | -1 | 0 | 1 | max-1 | max
time        before | exactly at | after the deadline
price/qty   min valid | min-1 | max valid | max+1 | zero | negative
bytes       0 | 1 | header-1 | header | header+1 | declared len ± 1 | every split point
sequence    expected | duplicate | gap of 1 | gap of N | wrap boundary
strings     "" | 1 char | exactly N | N+1 | embedded NUL | invalid UTF-8
float       0 | -0 | denormal | ±inf | NaN | last representable
```

```cpp
// ---- parameterize the counter width so wrap arrives instantly ---------
template<std::unsigned_integral Counter = std::uint64_t>
class RingIndex {
public:
    void advance(Counter n) noexcept { head_ += n; }             // wraps by rule
    [[nodiscard]] Counter distance(Counter tail) const noexcept {
        return Counter(head_ - tail);                            // modular
    }
private:
    Counter head_{};
};
using ProdIndex = RingIndex<std::uint64_t>;
using TinyIndex = RingIndex<std::uint8_t>;   // wraps after 256 ops

TEST_CASE("sequence comparison survives wrap") {
    TinyIndex idx;
    for (int i = 0; i != 10'000; ++i) {       // crosses the wrap ~39 times
        idx.advance(1);
        CHECK(idx.distance(std::uint8_t(i)) <= 1);
    }
}
// The algorithm must DOCUMENT that it only relies on max distance < 2^(bits-1);
// otherwise a uint8_t instantiation proves nothing about the uint64_t one.
```

```cpp
// ---- the oracle must not overflow the same way ------------------------
// BAD  oracle: int expected = a + b;                 // UB on overflow, blesses the bug
// GOOD oracle:
std::int64_t expected{};
bool ok = !__builtin_add_overflow(std::int64_t{a}, std::int64_t{b}, &expected);
// or, wider type + explicit range check, or std::add_sat / std::mul_sat (C++26)
CHECK(component.add(a, b) == (ok ? std::optional{expected} : std::nullopt));
```

```cpp
// ---- demonstrating UB deliberately: separate process, ASan expected ----
// tests/negative/use_after_realloc.cpp — built separately, run under ASan,
// the CMake test asserts a nonzero exit and a matching stderr regex:
//   add_test(NAME uaf COMMAND use_after_realloc)
//   set_tests_properties(uaf PROPERTIES WILL_FAIL TRUE
//       PASS_REGULAR_EXPRESSION "heap-use-after-free")
```

**Traps** — `CHECK(*p == x)` after invalidation is UB even when it passes · pointer *comparison* after invalidation is also unspecified, and allocator reuse can return the same address · `reserve(capacity()+1)` overflows if capacity is near `max_size()` · asserting exact capacity after growth is implementation-defined · a `uint8_t` counter test only transfers to `uint64_t` if the modular-distance precondition is width-independent · `span`/`string_view` into a mutated vector dangles with no diagnostic outside ASan.

---

## 43.6 Order-book invariant and replay tests

```cpp
// ---- the invariant checker is a first-class production-adjacent artifact
bool Book::check_invariants() const noexcept {
    std::size_t live = 0;

    for (auto const& [id, handle] : by_id_) {
        auto const* slot = pool_.get(handle);
        if (!slot) return false;                            // ID ↔ live slot
        if (slot->id != id) return false;
        auto const* level = level_at(slot->side, slot->price);
        if (!level) return false;                           // slot ↔ its level
        if (!level_contains(*level, handle)) return false;
        ++live;
    }
    if (live + pool_.free_count() != pool_.capacity()) return false;  // slot census

    for (auto side : {Side::Bid, Side::Ask}) {
        std::int64_t prev = side == Side::Bid ? INT64_MAX : INT64_MIN;
        for (auto const& lvl : levels_[side]) {
            if (lvl.orders.empty()) return false;           // no empty levels kept
            if (side == Side::Bid ? !(lvl.price < prev) : !(lvl.price > prev))
                return false;                               // price ordering
            prev = lvl.price;

            std::int64_t sum = 0; std::uint32_t count = 0;
            auto h = lvl.head;
            std::uint32_t guard = 0;
            while (h != kNil) {                             // forward FIFO walk
                auto const& n = pool_[h];
                if (n.prev == kNil ? h != lvl.head : pool_[n.prev].next != h)
                    return false;                           // links agree
                sum += n.quantity; ++count;
                if (++guard > pool_.capacity()) return false;   // terminates
                h = n.next;
            }
            if (sum != lvl.total_quantity || count != lvl.order_count) return false;
        }
    }
    if (best_bid() && best_ask() && !(*best_bid() < *best_ask())) return false;
    return true;
}
```

```text
Full audit after EVERY generated event
  ID index        ↔ exactly one live generation slot
  slot            ↔ exactly one matching side/price level
  FIFO links      forward == backward, terminate within capacity
  level totals    stored count/sum == traversal count/sum
  empty levels    never retained; best price agrees with first level
  slot census     free + live == capacity
  digest          canonical digest == reference model digest
```

```cpp
// ---- reference model: readable, allocating, independently structured ---
struct ReferenceOrder { OrderId id; std::int64_t qty; };
struct ReferenceBook {
    std::map<Price, std::deque<ReferenceOrder>, std::greater<>> bids;  // best first
    std::map<Price, std::deque<ReferenceOrder>, std::less<>>    asks;
    std::unordered_map<OrderId, std::pair<Side, Price>> by_id;

    Result add(OrderId id, Side s, Price p, std::int64_t q) {
        if (by_id.contains(id)) return Result::DuplicateId;      // same rejections
        if (q <= 0) return Result::BadQuantity;
        side(s)[p].push_back({id, q});                           // FIFO by arrival
        by_id.emplace(id, std::pair{s, p});
        return Result::Ok;
    }
    Result cancel(OrderId id) {
        auto it = by_id.find(id);
        if (it == by_id.end()) return Result::UnknownId;
        auto [s, p] = it->second;
        auto& dq = side(s).at(p);
        std::erase_if(dq, [&](auto const& o) { return o.id == id; });
        if (dq.empty()) side(s).erase(p);                        // no empty levels
        by_id.erase(it);
        return Result::Ok;
    }
    // ...  replace / execute / delete elided for brevity
};
```

```cpp
// ---- canonical projection: the ONLY thing you compare -----------------
struct CanonicalLevel { Side side; Price price; std::int64_t total;
                        std::vector<std::pair<OrderId, std::int64_t>> fifo; };
using Canonical = std::vector<CanonicalLevel>;   // sorted: side, then price, then FIFO

std::uint64_t digest(Canonical const& c) noexcept {          // FNV-1a, order-sensitive
    std::uint64_t h = 1469598103934665603ULL;
    auto mix = [&](std::uint64_t v) {
        for (int i = 0; i != 8; ++i) { h ^= (v >> (8 * i)) & 0xff; h *= 1099511628211ULL; }
    };
    for (auto const& l : c) {
        mix(std::uint64_t(l.side)); mix(std::uint64_t(l.price)); mix(std::uint64_t(l.total));
        for (auto const& [id, q] : l.fifo) { mix(id); mix(std::uint64_t(q)); }
    }
    return h;
}
```

```cpp
// ---- the state-machine property test ----------------------------------
using Action = std::variant<Add, Cancel, Replace, Execute, Delete>;

Action generate(std::mt19937_64& rng, Book const& b) {
    // Deliberately biased: uniform random valid Adds test only insertion.
    switch (pick(rng(), 10)) {
        case 0: return Add{fresh_id(rng), rand_side(rng), boundary_price(rng), 0};      // invalid qty
        case 1: return Add{existing_id(b, rng), rand_side(rng), rand_price(rng), 1};    // duplicate ID
        case 2: return Cancel{unknown_id(rng)};                                          // unknown
        case 3: return Add{fresh_id(rng), rand_side(rng), kMinPrice, kMaxQty};           // extremes
        case 4: return Replace{existing_id(b, rng), rand_price(rng), rand_qty(rng)};
        case 5: return Execute{existing_id(b, rng), oversized_qty(rng)};                 // > resting
        default: return Add{fresh_id(rng), rand_side(rng), rand_price(rng), rand_qty(rng)};
    }
}

TEST_CASE("book == reference model over generated sequences") {
    for (std::uint64_t seed : kRegressionSeeds) {
        std::mt19937_64 rng{seed};
        Book book{kCapacity}; ReferenceBook model;
        std::vector<Action> trace;
        for (int step = 0; step != 5'000; ++step) {
            auto a = generate(rng, book);
            trace.push_back(a);
            INFO("seed=" << std::hex << seed << " step=" << step << "\n" << render(trace));
            REQUIRE(apply(book, a) == apply(model, a));    // result categories match
            REQUIRE(book.check_invariants());              // structural audit
            REQUIRE(digest(canonical(book)) == digest(canonical(model)));
        }
    }
}
```

```cpp
// ---- replay matrix -----------------------------------------------------
TEST_CASE("batching boundaries do not change the final state") {
    auto events = golden_events();
    auto reference = replay_all(events).digest();
    for (std::size_t chunk = 1; chunk <= events.size(); ++chunk) {   // every split
        Book b{kCapacity};
        for (std::size_t i = 0; i < events.size(); i += chunk)
            b.apply_batch(std::span{events}.subspan(i, std::min(chunk, events.size() - i)));
        CHECK(b.digest() == reference);
    }
}

TEST_CASE("snapshot + buffered incrementals == uninterrupted stream") {
    auto full = replay_all(events()).digest();
    Book b{kCapacity};
    auto snap = snapshot_at(events(), /*seq=*/500);
    b.load(snap);
    b.apply_range(events_after(500));
    CHECK(b.digest() == full);
}

TEST_CASE("duplicate and gapped sequence numbers") {
    Book b{kCapacity}; SequenceGate gate;
    CHECK(gate.accept(1) == Gate::Apply);
    CHECK(gate.accept(1) == Gate::Duplicate);       // idempotent, no state change
    auto before = b.digest();
    CHECK(gate.accept(3) == Gate::Gap);             // buffer, request recovery
    CHECK(b.digest() == before);
    CHECK(gate.accept(2) == Gate::Apply);
    CHECK(gate.drain() == std::vector<Seq>{3});     // buffered event released
}
```

**Replay matrix** — one-by-one vs. every batch boundary · serialize then decode through the live path · duplicate seq · forward gap of 1 and of N · snapshot base + buffered incrementals vs. uninterrupted · recovery buffer at capacity and one beyond · snapshot build failure leaves the previous publication current · identical digest at each named sequence checkpoint.

**Model independence rules** — do not share intrusive link helpers or pool code with the optimized book · *do* share domain value types and the canonicalization definition · compare public projections only · periodically rebuild the model from canonical state to catch model index bugs · keep hand-written golden cases so a *shared misunderstanding* is still visible.

**Traps** — comparing `unordered_map` iteration order gives a golden that changes with the standard library — canonicalize by side, price, then FIFO · a model that reuses the production `Level` struct will agree with the production bug · an invariant checker that is O(n²) per event throttles the sequence length that fits in CI — run the full audit every event in the short test and every 1000th in the long soak · digests must be order-sensitive or they miss FIFO reordering.

---

## 43.7 Ring-buffer wraparound and concurrency stress tests

```cpp
// ---- functional SPSC properties (single-threaded, deterministic) -------
TEST_CASE("empty / full / exact capacity") {
    SpscRing<int, 4> r;                        // power-of-two, 3 usable
    CHECK(r.empty()); CHECK_FALSE(r.full()); CHECK(r.size() == 0);
    CHECK(r.capacity() == 3);
    CHECK(r.try_push(1)); CHECK(r.try_push(2)); CHECK(r.try_push(3));
    CHECK(r.full());
    CHECK_FALSE(r.try_push(4));                // rejects, does not overwrite
    int out{};
    CHECK(r.try_pop(out)); CHECK(out == 1);
    CHECK_FALSE(r.full());
}

TEST_CASE("FIFO holds across the physical wrap") {
    SpscRing<int, 4> r;
    int out{}, expected = 0, next = 0;
    for (int round = 0; round != 100; ++round) {          // >> capacity: many wraps
        while (r.try_push(next)) ++next;                  // fill
        while (r.try_pop(out)) CHECK(out == expected++);  // drain, strict order
    }
    CHECK(expected == next);
    CHECK(r.empty());
}

TEST_CASE("move-only, non-default-constructible payload") {
    struct Payload {
        std::unique_ptr<int> p;
        explicit Payload(int v) : p{std::make_unique<int>(v)} {}
        Payload(Payload&&) noexcept = default;
        Payload& operator=(Payload&&) noexcept = default;
    };
    static_assert(!std::copy_constructible<Payload>);
    static_assert(!std::default_initializable<Payload>);
    SpscRing<Payload, 4> r;
    CHECK(r.try_emplace(7));
    auto got = r.try_pop_value();                  // std::optional<Payload>
    REQUIRE(got);
    CHECK(*got->p == 7);
}

TEST_CASE("destructor destroys the elements still in the queue") {
    ProbeScope scope;
    { SpscRing<LifetimeProbe, 8> r;
      for (int i = 0; i != 5; ++i) r.try_emplace(i);
      CHECK(LifetimeProbe::live == 5); }             // ring destroyed here
    CHECK(LifetimeProbe::live == 0);
}

TEST_CASE("batch span stops at the physical end and commits the exact count") {
    SpscRing<int, 8> r;
    for (int i = 0; i != 5; ++i) r.try_push(i);
    int tmp{}; for (int i = 0; i != 5; ++i) r.try_pop(tmp);   // head near the end
    auto span = r.acquire_write_span(6);
    CHECK(span.size() <= 6);
    CHECK(span.size() == 3);                    // truncated at the buffer end
    std::ranges::fill(span, 42);
    r.commit_write(2);                          // commit FEWER than acquired
    CHECK(r.size() == 2);
}

TEST_CASE("shutdown while empty, full, and partially consumed") {
    for (int prefill : {0, 3, 7}) {
        SpscRing<LifetimeProbe, 8> r;
        ProbeScope scope;
        for (int i = 0; i != prefill; ++i) r.try_emplace(i);
        r.shutdown();
        CHECK_FALSE(r.try_emplace(99));         // pushes rejected after shutdown
        int drained = 0; while (r.try_pop_value()) ++drained;
        CHECK(drained == prefill);              // already-published items still pop
    }
}
```

```cpp
// ---- counter wrap with a reduced-width test instantiation --------------
template<class T, std::size_t N, std::unsigned_integral Seq = std::uint64_t>
class SpscRing;                                  // Seq is a test knob

using TinyRing = SpscRing<int, 4, std::uint8_t>; // head/tail wrap after 256

TEST_CASE("producer and consumer counters cross their wrap boundary") {
    TinyRing r;                                  // wraps ~4 times in 1000 ops
    int out{}, expected = 0;
    for (int i = 0; i != 1000; ++i) {
        REQUIRE(r.try_push(i & 0xff));
        REQUIRE(r.try_pop(out));
        REQUIRE(out == (expected++ & 0xff));
    }
}
// PRECONDITION the algorithm must document: max in-flight distance < 2^(bits-1),
// i.e. capacity <= 127 for uint8_t. Without that, the small type proves nothing.
```

```cpp
// ---- long-run checksum stress: no loss, no duplication, no reorder -----
TEST_CASE("SPSC stress: 50M items through a 16-slot ring") {
    constexpr std::uint64_t N = 50'000'000;
    SpscRing<std::uint64_t, 16> ring;            // tiny → constant full/empty
    std::atomic<bool> failed{false};

    std::jthread consumer([&] {
        std::uint64_t expected = 0, digest = 1469598103934665603ULL;
        std::uint64_t v{};
        while (expected != N) {
            if (!ring.try_pop(v)) { std::this_thread::yield(); continue; }
            if (v != expected) { failed = true; return; }   // loss/dup/reorder
            digest = (digest ^ v) * 1099511628211ULL;
            ++expected;
        }
        CHECK(digest == kExpectedDigest);
    });

    std::mt19937_64 rng{0xbeef};
    for (std::uint64_t i = 0; i != N; ++i) {
        while (!ring.try_push(i)) std::this_thread::yield();
        if ((rng() & 0x3ff) == 0) std::this_thread::yield();   // asymmetric pauses
    }
    consumer.join();
    CHECK_FALSE(failed);
    CHECK(ring.empty());
    CHECK(LifetimeProbe::live == 0);
}
```

```text
producer: for i in [0,N):  spin/yield until push(i) succeeds
consumer: expect exactly i; destroy/return the slot; fold i into a digest
final:    produced == consumed == N; queue empty; live probe count == 0
```

> This is **necessary but not sufficient**: a relaxed-only implementation passes billions of iterations on x86-TSO and fails on AArch64.

```cpp
// ---- forced interleaving at the named protocol point ------------------
TEST_CASE("consumer's acquire of tail happens-before it reads the payload") {
    SpscRing<Payload, 4> ring;
    std::latch produced{1};
    std::jthread consumer([&] {
        produced.wait();
        Payload p;
        REQUIRE(ring.try_pop(p));               // acquire on tail
        CHECK(p.checksum == compute(p));        // must see the full payload
    });
    ring.try_emplace(make_payload());           // release on tail
    produced.count_down();
}
```

**Concurrency tool matrix**

| Tool | Finds | Cannot find |
|---|---|---|
| TSan | data races, some mutex misuse, some `std::atomic` misuse | linearizability, wait-freedom, all ordering bugs |
| ASan + UBSan | use-after-free, OOB, misaligned, signed overflow | races (build separately from TSan) |
| LSan | leaks | anything about ordering |
| debug assertions | index/sequence/ownership invariants at runtime | what you did not assert |
| randomized stress | rare capacity/wrap/schedule events | reproduction, proof |
| forced interleavings | the one schedule you named | the ones you did not name |
| review / litmus reasoning | missing acquire/release edges | typos |

```bash
# ---- sanitizer build matrix (separate builds; ASan and TSan do not mix) --
cmake -S . -B build/asan  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DCMAKE_CXX_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer \
                     -fno-sanitize-recover=all -g"
cmake -S . -B build/tsan  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DCMAKE_CXX_FLAGS="-fsanitize=thread -fno-omit-frame-pointer -g"
cmake -S . -B build/dbgstl -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_CXX_FLAGS="-D_GLIBCXX_DEBUG -D_GLIBCXX_DEBUG_PEDANTIC"   # libstdc++
#   libc++:  -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG  (C++23 era)
#   MSVC  :  /RTC1 /D_ITERATOR_DEBUG_LEVEL=2   (ABI must match ALL linked code)

ASAN_OPTIONS=detect_leaks=1:strict_string_checks=1:detect_stack_use_after_return=1 \
UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1 \
  ./build/asan/tests

TSAN_OPTIONS=halt_on_error=1:second_deadlock_stack=1:history_size=7 \
  ./build/tsan/tests --stress-iterations=50000000

# repeat a flaky concurrency test until it fails
ctest --test-dir build/tsan -R spsc_stress --repeat until-fail:200 --timeout 300
```

```bash
# ---- fuzzing: build, run, minimize, regress ---------------------------
clang++ -std=c++23 -g -O1 -fsanitize=fuzzer,address,undefined \
        decoder_fuzz.cpp -o decoder_fuzz
./decoder_fuzz corpus/ -max_len=4096 -rss_limit_mb=2048 -timeout=5 -jobs=8
./decoder_fuzz -minimize_crash=1 crash-a1b2c3        # → minimized reproducer
./decoder_fuzz -merge=1 corpus/ new_inputs/          # keep coverage-minimal corpus
cp minimized-* tests/regressions/corpus/             # every crash becomes a test
./decoder_fuzz -runs=0 tests/regressions/corpus/*    # replay corpus in CI
```

```text
Fuzzer hygiene
  reset all global/component state each invocation
  validate and bound every decoded length BEFORE allocating
  no clocks, no network, no random_device, no filesystem
  do not log rejected inputs (drowns the run)
  keep assert() live: build with -DNDEBUG removed
  cap per-input work; return -1 to reject oversized inputs from the corpus
```

**Traps** — `sleep_for` between producer and consumer hides the very races you are hunting · a ring with a huge capacity never reaches `full` in a stress test — use 8 or 16 slots · TSan false-positives on custom primitives it cannot model (inline asm, hand-rolled seqlocks): annotate with `__tsan_acquire`/`__tsan_release` rather than disabling the test · sanitizer builds serialize enough to hide relaxed-ordering bugs · a stress test that only ever passes proves nothing until you verify it *fails* on a deliberately broken implementation · `_GLIBCXX_DEBUG` changes the ABI: every linked TU must agree.

---

## 43.8 Compile-time interface tests with concepts and `static_assert`

```cpp
#include <concepts>
#include <type_traits>

// ---- pin the required expressions, return types, and noexcept ---------
template<class Q, class T>
concept BoundedQueue = requires(Q& q, Q const& cq, T value) {
    { q.try_push(std::move(value)) } noexcept -> std::same_as<bool>;
    { q.try_pop(value)            } noexcept -> std::same_as<bool>;
    { cq.capacity()               } noexcept -> std::convertible_to<std::size_t>;
    { cq.size()                   } noexcept -> std::convertible_to<std::size_t>;
    { cq.empty()                  } noexcept -> std::same_as<bool>;
    typename Q::value_type;
    requires std::same_as<typename Q::value_type, T>;
};

static_assert(BoundedQueue<SpscRing<Message, 16>, Message>);
static_assert(BoundedQueue<MpmcRing<Message>,     Message>);   // both impls conform
```

```cpp
// ---- every static_assert form -----------------------------------------
static_assert(sizeof(Header) == 16);                    // C++11: message + expr
static_assert(alignof(Slot) == 64, "false sharing");    // with message
static_assert(std::is_trivially_copyable_v<Header>);    // C++17: message optional
static_assert(requires { Decoder{}.decode(std::span<std::byte const>{}); });

// value / type / expression traits
static_assert(std::is_nothrow_move_constructible_v<Message>);
static_assert(std::is_nothrow_destructible_v<Message>);
static_assert(std::is_standard_layout_v<Header>);
static_assert(std::is_aggregate_v<Header>);
static_assert(std::has_unique_object_representations_v<Header>);  // memcmp-able
static_assert(!std::copy_constructible<UniqueHandle>);            // move-only
static_assert(std::regular<Price>);                               // ==, copy, default
static_assert(std::totally_ordered<Price>);
static_assert(std::three_way_comparable<Price, std::strong_ordering>);
static_assert(std::ranges::random_access_range<Book::LevelView>);
static_assert(std::ranges::view<Book::LevelView>);
static_assert(std::invocable<Callback, Message const&>);
static_assert(std::is_nothrow_invocable_r_v<bool, Callback, Message const&>);
static_assert(std::atomic<Seq>::is_always_lock_free);             // C++17
static_assert(std::is_empty_v<DefaultPolicy>);                    // no_unique_address payoff
```

```cpp
// ---- noexcept of a specific expression --------------------------------
SpscRing<Message, 16> r;
Message m;
static_assert(noexcept(r.try_push(std::move(m))));      // hot path cannot throw
static_assert(noexcept(r.try_pop(m)));
static_assert(!noexcept(r.grow()));                     // cold path may throw
static_assert(noexcept(std::declval<Book&>().best_bid()));   // no object needed
```

```cpp
// ---- constexpr evaluation as a test -----------------------------------
constexpr auto kTable = build_crc_table();              // must be constant-evaluable
static_assert(kTable[0] == 0x00000000u);
static_assert(kTable[255] == 0xb40bbe37u);
static_assert(crc32("123456789") == 0xcbf43926u);       // golden vector at compile time
static_assert(parse_price("100.25") == Price{1002500}); // parser is constexpr-clean

consteval int checked(int x) { return x > 0 ? x : throw "nonpositive"; }  // C++20
static_assert(checked(5) == 5);
// static_assert(checked(0) == 0);   // ill-formed: not a constant expression
```

```cpp
// ---- negative tests: assert that something does NOT compile -----------
template<class Q, class T>
concept HasCopyPush = requires(Q& q, T const& v) { q.try_push(v); };

static_assert(!HasCopyPush<SpscRing<MoveOnly, 8>, MoveOnly>);  // no copy overload
static_assert(!std::constructible_from<Price, double>);        // no implicit float
static_assert(!std::convertible_to<int, Price>);               // explicit only
static_assert(!requires(Book& b) { b.raw_pool(); });           // internals not public

// requires-expression forms, all four:
template<class T> concept C1 = requires { typename T::value_type; };        // type req
template<class T> concept C2 = requires(T t) { t.reset(); };                // simple req
template<class T> concept C3 = requires(T t) { { t.size() } -> std::integral; }; // compound
template<class T> concept C4 = requires(T t) { requires sizeof(T) <= 64; }; // nested req
```

```cpp
// ---- dependent context: needed so the check is not hard-error ---------
template<class T>
constexpr bool rejects_negative_qty = !requires(T& b) { b.add(Id{1}, Side::Bid, Price{1}, -1); };
// A non-dependent ill-formed expression is a compile ERROR, not a false requires;
// wrap it in a template so substitution failure is the observable outcome.
```

```cmake
# ---- "must fail to compile" tests, kept out of the normal test binary ---
add_executable(compile_fail_copy_ring EXCLUDE_FROM_ALL compile_fail/copy_ring.cpp)
add_test(NAME compile_fail_copy_ring
         COMMAND ${CMAKE_COMMAND} --build . --target compile_fail_copy_ring --config $<CONFIG>)
set_tests_properties(compile_fail_copy_ring PROPERTIES
    WILL_FAIL TRUE
    PASS_REGULAR_EXPRESSION "no matching function|constraints not satisfied")
```

| Check | Spelling | Test what |
|---|---|---|
| required expressions | `concept` + `static_assert(C<T>)` | API shape |
| forbidden expression | `static_assert(!requires { … })` | overload not offered |
| exception spec | `static_assert(noexcept(expr))` | hot-path `noexcept` |
| layout / ABI | `is_standard_layout_v`, `sizeof`, `alignof` | only when representation is a contract |
| bitwise semantics | `has_unique_object_representations_v` | `memcmp`/hash by bytes is legal |
| trivial relocation | `is_trivially_copyable_v` | `memcpy`-based vector growth |
| lock-freedom | `atomic<T>::is_always_lock_free` | no hidden mutex in the queue |
| constant evaluation | `static_assert(f(args) == golden)` | tables, parsers, CRC |
| access control | dedicated "must fail" build target | `private:` really is private |
| diagnostics text | dedicated build target + regex | error message quality |

```cpp
// ---- what NOT to assert ------------------------------------------------
// static_assert(sizeof(std::vector<int>) == 24);   // implementation-defined
// static_assert(sizeof(Book) == 4096);             // overconstrains the impl
static_assert(sizeof(WireHeader) == 16);            // OK: it IS the wire contract
static_assert(offsetof(WireHeader, length) == 4);   // OK: standard-layout + on-wire
static_assert(alignof(alignas(64) CacheLine) == 64);// OK: false-sharing contract
```

**Test isolation and reproducibility** — a failure report carries: seed + minimized action/byte input · test and configuration name · compiler, standard library, sanitizer, `-O` level, architecture · capacity and counter widths in effect · deterministic trace around the failure · the *first* divergence, not megabytes of logs.

**Regression retention** — parser/fuzzer bug → a corpus byte file · state-machine bug → a short action trace · concurrency bug → a forced interleaving test · exception/allocation bug → a failure-index case · interface bug → a `static_assert`.

**Interview line** — "A compile-time interface test is a concept plus `static_assert` that verifies required expressions, result types, `noexcept`, and constant evaluation without running a single instruction."

**Traps** — a `requires` on a non-dependent ill-formed expression is a hard error, not `false` · `static_assert(!requires{...})` silently passes if you typo the member name — verify the positive case compiles too · `sizeof`/`offsetof` assertions freeze layout you may want to change; reserve them for wire and ABI contracts · `noexcept(expr)` is `true` for an expression that never calls the function you meant (e.g. an overload resolution surprise) · access-control and diagnostic-quality tests need a separate build target, never the main test binary.

---

**Recall card**

```text
examples         named cases and exact boundaries
partitions       empty | one | cap-1 | cap | cap+1 | 0 | max | max+1
properties       invariants and relations over generated sequences
model            simple, independently structured, allocates freely
fuzz             deterministic, bounded, state-reset, corpus + sanitizers
seams            clock | RNG | scheduler | allocator | byte source | sink
time             manual clock, advance to deadline-1/deadline/deadline+1
failure          inject at every allocation and throw point; assert the guarantee
lifetime         probe counters + ProbeScope + ASan/UBSan
invalidation     safe handles only; never dereference known-dangling data
concurrency      forced schedules + TSan + long stress + happens-before reasoning
order book       links/counts/sums/census/best + canonical replay digest
ring             empty/full/wrap/FIFO/move-only/dtor/shutdown at capacity 4
compile time     concepts + static_assert + separate must-fail build targets
repro            seed + minimized trace + toolchain + sanitizer + widths
```

**Core design sentence** — Strong C++ component tests replace nondeterminism at real boundaries, attack invariants across injected failures and long generated sequences, compare optimized code against an independently written model, and use sanitizers and stress as *evidence alongside* — never as substitutes for — lifetime and memory-model reasoning.
