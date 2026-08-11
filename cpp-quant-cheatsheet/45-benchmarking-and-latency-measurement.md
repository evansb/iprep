# 45. Benchmarking and latency measurement

*Part VII — Correctness, testing, and performance validation*

---

**Recall**
- Performance is not a portable semantic property of C++ — a claim is only meaningful with compiler, options, library, CPU, OS, workload, metric boundary, and statistic named.
- Throughput is completed work per unit time; latency is time between a *defined* start and a *defined* stop; they are optimized by different changes and can move in opposite directions.
- Under the as-if rule an unused result may be deleted entirely, so a microbenchmark can legally compile to an empty loop.
- Compile-time-known inputs get constant-folded; the fix is data that only exists at run time, not `static const`.
- There is no standard `do_not_optimize`; every real barrier is inline asm, an opaque extern call, or a framework helper — all implementation-specific.
- `volatile` is not an optimization barrier and not a synchronization primitive: it changes *what you measure* into volatile accesses.
- `steady_clock` is the only standard clock guaranteed monotonic and steady-rate; `system_clock` can jump; `high_resolution_clock` may alias either.
- Two clock reads cost ~15–30 ns (`clock_gettime` vDSO) or ~20–40 cycles (`rdtsc`); anything smaller than that must be batched.
- `rdtsc` is not serializing (use `lfence`/`rdtscp`), counts *reference* cycles on invariant-TSC parts, and needs a measured ticks→ns calibration.
- Batching `B` operations yields `duration/B` = mean service cost and destroys the per-operation distribution — you cannot get a p99 from it.
- Warmup fills i-cache/d-cache, branch predictors, TLB, allocator arenas, and page tables — but never warm away a cost the claim is supposed to include.
- State leaks across iterations (vector capacity, load factor, freelist order, book depth); reset outside the timed region or declare the evolution as the workload.
- A percentile requires a stated estimator: nearest-rank `ceil(pN)` and linear-interpolation definitions disagree, especially in small samples.
- p99.9 from 10 000 samples rests on ~10 observations; autocorrelation makes the effective count smaller still.
- Coordinated omission: a closed-loop generator that waits for each slow response under-samples exactly the stalls you care about — measure intended-arrival→completion.
- Mean alone hides multimodality; percentiles alone hide time order — always also plot latency versus wall-clock to catch throttling and periodic interrupts.
- Contention benchmarks must report attempts, rejects, per-thread progress, occupancy, and overload policy, not just aggregate ops/s.
- A shared atomic counter in the measured path becomes the benchmark's own contention point — use thread-local counters combined after the run.
- Hardware counters explain a result; they never prove one, and multiplexed events are extrapolated estimates.
- Measure optimized, production-like binaries: sanitizer/debug builds benchmark the instrumentation.

---

## 45.1 Define throughput, latency, tail latency, jitter, and allocation goals

```text
claim → workload/input distribution → metric + scope boundary → harness validation
     → warmup/steady state → repeated independent samples → distribution + counters
     → randomized A/B → compiler/platform-specific conclusion
```

| Metric | Definition | Unit | Classic mistake |
|---|---|---|---|
| Throughput | completed ops / elapsed wall time | ops/s, MB/s | hiding per-item stalls behind batching or parallelism |
| Service latency | consumer-start → consumer-done | ns | called "end-to-end" |
| Queue residence | publish timestamp → consumer start | ns | omitted; the actual source of tails |
| End-to-end | input accepted → result observable | ns | mixes queueing + service + I/O without saying so |
| Tail latency | a stated high quantile (p99, p99.9, p99.99) | ns | estimated from too few samples |
| Jitter | dispersion statistic over observations | ns | reported as one scalar with no statistic named |
| CPU time | scheduled execution consumed | ns | treated as wall time |
| Allocation goal | count/bytes/high-water in a *named* phase | count, bytes | "zero allocation" after reserving one vector |

**Scope matrix — pick one and say which**

| Scope | Start | Stop | Includes |
|---|---|---|---|
| Kernel | immediately before op | immediately after | function work + timer overhead |
| Batch service | batch available | batch processed | loop, dispatch, amortized boundary cost |
| Queue residence | publication tsc | consumer dequeue | scheduling and backpressure delay |
| End-to-end | input accepted | result observable | everything, as explicitly defined |

```cpp
// Bad claim : "variant is faster".
// Testable  : "On GCC 14 -O2 -march=x86-64-v3, Zen 4, with objects preallocated
//              and identical output checksums, visiting this tag mix through
//              std::variant has lower median AND p99 service time than the
//              virtual hierarchy, over 2e6 samples, 5 randomized A/B processes."
```

Workload specification must state: input sizes and value distributions · valid/malformed/truncated proportions · tag and branch frequencies *and their correlations* · container occupancy and load factor · hot vs cold working set · thread counts and producer rates · burst/overload model · whether order is fixed, shuffled, or replayed.

**Traps** — uniform random data destroys branch locality real traffic has · sorted synthetic data makes predictors unrealistically perfect · a kernel number is not an end-to-end number · "average latency" under load without the arrival process is meaningless.

---

## 45.2 Preventing dead-code elimination and constant folding

```cpp
#include <cstdint>
#include <span>

// If `out` is never observed, the whole loop is legally deleted.
std::uint64_t sum(std::span<std::uint32_t const> xs) noexcept {
    std::uint64_t out{};
    for (auto x : xs) out += x;
    return out;
}
```

```cpp
// ---- real DoNotOptimize / ClobberMemory ------------------------------------
#if defined(__GNUC__) || defined(__clang__)

// Read barrier: the value must exist in a register/memory before this point.
template <class T>
inline void do_not_optimize(T const& value) noexcept {
    asm volatile("" : : "r,m"(value) : "memory");
}

// Read/write barrier for a modifiable lvalue: compiler must assume it changed.
template <class T>
inline void do_not_optimize(T& value) noexcept {
#if defined(__clang__)
    asm volatile("" : "+r,m"(value) : : "memory");   // clang accepts +r,m
#else
    asm volatile("" : "+m,r"(value) : : "memory");   // gcc wants +m first
#endif
}

// Full compiler-level memory clobber: all globals/heap assumed written.
// NOT a CPU fence — emits zero instructions.
inline void clobber_memory() noexcept { asm volatile("" : : : "memory"); }

#elif defined(_MSC_VER)                                 // MSVC has no inline asm on x64
#include <intrin.h>
#pragma optimize("", off)
template <class T> inline void do_not_optimize(T const& value) noexcept { (void)value; }
#pragma optimize("", on)
inline void clobber_memory() noexcept { _ReadWriteBarrier(); }
#endif
```

```cpp
// ---- the four legitimate defenses ------------------------------------------
// 1. sink the result
auto r = kernel(input);
do_not_optimize(r);

// 2. make the input opaque so it cannot be folded
auto in = make_input();
do_not_optimize(in);                 // compiler must reload; no constant folding
do_not_optimize(kernel(in));

// 3. writes into a buffer must not be dead-stored
std::vector<std::uint8_t> out(n);
encode(out.data(), in);
clobber_memory();                    // "someone may read out" — keeps the stores

// 4. escape the address so the object cannot be SROA'd into registers
Book book;
do_not_optimize(book);               // address escapes; fields stay in memory
```

```cpp
// ---- what NOT to do --------------------------------------------------------
volatile std::uint64_t sink;         // measures a volatile store, defeats vectorization
sink = kernel(in);                   // and forbids CSE across the loop body

static constexpr auto in = make();   // folded at compile time; loop times nothing
std::uint64_t acc = 0;
for (int i = 0; i < N; ++i) acc += kernel(in);   // hoisted out entirely
```

| Technique | Cost | Preserves? | Notes |
|---|---|---|---|
| `asm volatile("":: "r,m"(v) :"memory")` | 0 instructions | producer of `v` | GCC/Clang only; may force a spill |
| `asm volatile("":::"memory")` | 0 instructions | all stores to memory | compiler barrier only, no `mfence` |
| `volatile` variable | a real load/store each use | too much | changes the measured work |
| opaque extern fn in another TU | call overhead | everything | defeated by LTO — build that TU separately |
| checksum returned from `main` | none in loop | dependency chain | cheapest portable option |
| `benchmark::DoNotOptimize` (Google Benchmark) | 0 | same as asm | the reference implementation of the above |

```cpp
// ---- correctness oracle: run it OUTSIDE the timed region --------------------
auto const expected = reference(input);
for (auto& s : samples) {
    auto const t0 = Clock::now();
    auto const got = candidate(input);
    auto const t1 = Clock::now();
    do_not_optimize(got);
    s = t1 - t0;
    if (got != expected) std::abort();   // check per sample, not per operation
}
```

**Traps** — a barrier on the *output* still lets a loop-invariant input fold · LTO inlines your "opaque" helper · `do_not_optimize` on a big struct forces a memory spill that itself costs cycles · sinking inside the loop can serialize an otherwise pipelined kernel · always confirm with `-S` / Compiler Explorer that the work survived.

---

## 45.3 Warmup, steady state, caches, and branch-predictor state

```cpp
// ---- explicit warmup phases -------------------------------------------------
template <class F>
void warmup(F&& f, std::chrono::milliseconds budget) {
    auto const deadline = Clock::now() + budget;
    while (Clock::now() < deadline) { auto r = f(); do_not_optimize(r); }
}

// Touch every page so the timed region takes no minor faults.
void pretouch(std::span<std::byte> mem, std::size_t page = 4096) {
    for (std::size_t i = 0; i < mem.size(); i += page) mem[i] = std::byte{};
}

// Lock resident + disable lazy commitment (Linux).
#include <sys/mman.h>
mlockall(MCL_CURRENT | MCL_FUTURE);
```

```cpp
// ---- deliberately COLD measurement: evict the working set -------------------
void flush_from_cache(void const* p, std::size_t n) noexcept {
    auto const* c = static_cast<char const*>(p);
    for (std::size_t i = 0; i < n; i += 64) _mm_clflushopt(const_cast<char*>(c + i));
    _mm_sfence();                                    // clflushopt is weakly ordered
}
// Portable alternative: stream a buffer larger than LLC between iterations.
static std::vector<std::byte> thrash(64u << 20);
void evict_llc() { for (std::size_t i = 0; i < thrash.size(); i += 64) do_not_optimize(thrash[i]); }
```

```cpp
// ---- branch-predictor state: shuffle vs replay ------------------------------
std::vector<Event> events = load_events();
std::mt19937_64 rng{12345};                 // FIXED seed → reproducible
std::ranges::shuffle(events, rng);          // destroys real correlation!
// Prefer: replay a captured production sequence, or a Markov model of tag order.
```

```cpp
// ---- state leakage: reset outside the timed region --------------------------
std::vector<Book> pristine(kSamples);        // prebuilt equivalent states
for (auto& b : pristine) b = make_reserved_book();

for (std::size_t i = 0; i < kSamples; ++i) {
    Book& b = pristine[i];                   // fresh state, no reset cost timed
    auto const t0 = Clock::now();
    apply_batch(b, events);
    auto const t1 = Clock::now();
    samples[i] = t1 - t0;
}
```

| Warmup target | Preparation | Do NOT |
|---|---|---|
| Steady-state decoder | warm code + tables, replay representative sequence | include first-call init |
| Cold lookup | evict/vary working set, verify with `L1-dcache-load-misses` | warm the tables |
| First message / startup | include dynamic linking, page faults, lazy init | discard the first N |
| Overload recovery | drive to queue-full, then measure drain | pre-drain the queue |

Hidden one-time costs that ambush the first iteration: dynamic symbol resolution (fix with `LD_BIND_NOW=1`) · first `std::format`/locale/iostream init · first thread-local construction · first exception thrown (unwinder table load) · first map insertion and each rehash · vector/string growth · coroutine-frame allocation · first log call · page commitment despite prior `reserve`.

**Traps** — "discard the first 3 iterations" is not a warmup policy, it is an undocumented filter · warming until frequency ramps up measures turbo, not steady state · resetting to a byte-identical state every iteration makes branch prediction unrealistically perfect · `mlockall` needs `RLIMIT_MEMLOCK`.

---

## 45.4 Distributions and percentiles — not only averages

```cpp
#include <algorithm>
#include <cmath>
#include <ranges>
#include <vector>

// Nearest-rank: rank = ceil(p*N), p in (0,1]. No interpolation, always a real sample.
template <class Rep>
Rep nearest_rank(std::vector<Rep> s, double p) {
    std::ranges::sort(s);
    auto rank = static_cast<std::size_t>(std::ceil(p * static_cast<double>(s.size())));
    rank = std::clamp(rank, std::size_t{1}, s.size());
    return s[rank - 1];
}

// Linear interpolation (numpy default, "type 7") — disagrees with nearest-rank.
double interpolated(std::vector<double> s, double p) {
    std::ranges::sort(s);
    double const h = p * static_cast<double>(s.size() - 1);
    auto const lo = static_cast<std::size_t>(std::floor(h));
    auto const hi = std::min(lo + 1, s.size() - 1);
    return s[lo] + (h - static_cast<double>(lo)) * (s[hi] - s[lo]);
}

// O(N) selection when you need one quantile and may permute.
auto q = s.begin() + static_cast<std::ptrdiff_t>(0.99 * s.size());
std::nth_element(s.begin(), q, s.end());     // *q is p99 by nearest-rank-ish
```

```cpp
// ============ fixed-memory log-linear latency histogram =====================
// Constant-time record, no allocation, no locks. Precision: `kSub` buckets per
// power of two → relative error <= 2^-log2(kSub). Range: [0, kMaxNs).
#include <array>
#include <bit>
#include <cstdint>
#include <span>

class LatencyHistogram {
public:
    static constexpr int      kSubBits = 5;                       // 32 buckets/octave, ~3% error
    static constexpr unsigned kSub     = 1u << kSubBits;
    static constexpr int      kOctaves = 40;                      // up to ~1.1e12 ns (~18 min)
    static constexpr std::size_t kBuckets = kOctaves * kSub;

    void record(std::uint64_t ns) noexcept {
        ++count_;
        total_ += ns;
        if (ns > max_) max_ = ns;
        if (ns < min_) min_ = ns;
        buckets_[bucket_of(ns)]++;
    }

    // rank r in [0,count) → bucket lower bound (report as an interval!)
    [[nodiscard]] std::uint64_t quantile(double p) const noexcept {
        if (count_ == 0) return 0;
        auto target = static_cast<std::uint64_t>(
            std::ceil(p * static_cast<double>(count_)));
        target = std::clamp<std::uint64_t>(target, 1, count_);
        std::uint64_t seen = 0;
        for (std::size_t i = 0; i < kBuckets; ++i) {
            seen += buckets_[i];
            if (seen >= target) return value_at(i);                // conservative: lower edge
        }
        return max_;
    }

    [[nodiscard]] std::uint64_t count() const noexcept { return count_; }
    [[nodiscard]] std::uint64_t min()   const noexcept { return count_ ? min_ : 0; }
    [[nodiscard]] std::uint64_t max()   const noexcept { return max_; }
    [[nodiscard]] double        mean()  const noexcept {
        return count_ ? static_cast<double>(total_) / static_cast<double>(count_) : 0.0;
    }

    void merge(LatencyHistogram const& o) noexcept {               // per-thread → global
        for (std::size_t i = 0; i < kBuckets; ++i) buckets_[i] += o.buckets_[i];
        count_ += o.count_; total_ += o.total_;
        max_ = std::max(max_, o.max_); min_ = std::min(min_, o.min_);
    }

private:
    static std::size_t bucket_of(std::uint64_t ns) noexcept {
        if (ns < kSub) return static_cast<std::size_t>(ns);        // linear below 2^kSubBits
        int const  msb   = 63 - std::countl_zero(ns);              // floor(log2(ns))
        int const  shift = msb - kSubBits;
        auto const sub   = static_cast<std::size_t>((ns >> shift) & (kSub - 1));
        auto const oct   = static_cast<std::size_t>(shift + 1);
        std::size_t const idx = oct * kSub + sub;
        return std::min(idx, kBuckets - 1);                        // saturating overflow
    }
    static std::uint64_t value_at(std::size_t idx) noexcept {
        if (idx < kSub) return idx;
        auto const oct   = idx / kSub;
        auto const sub   = idx % kSub;
        auto const shift = static_cast<int>(oct) - 1;
        return (static_cast<std::uint64_t>(kSub) + sub) << shift;
    }

    std::array<std::uint32_t, kBuckets> buckets_{};
    std::uint64_t count_{}, total_{}, max_{};
    std::uint64_t min_{~std::uint64_t{0}};
};
```

```cpp
// ---- driver: per-operation samples, per-thread histogram --------------------
thread_local LatencyHistogram tls_hist;      // NEVER a shared mutex-protected vector

for (std::size_t i = 0; i < kOps; ++i) {
    auto const t0 = rdtsc_start();
    process(events[i % events.size()]);
    auto const t1 = rdtsc_stop();
    tls_hist.record(cycles_to_ns(t1 - t0));
}

// Report
std::print("N={} min={} p50={} p90={} p99={} p99.9={} p99.99={} max={} mean={:.1f}\n",
           h.count(), h.min(), h.quantile(0.50), h.quantile(0.90), h.quantile(0.99),
           h.quantile(0.999), h.quantile(0.9999), h.max(), h.mean());
```

```cpp
// ============ coordinated omission ==========================================
// WRONG (closed loop): next request is scheduled only after the previous returns,
// so a 200 ms stall produces ONE bad sample instead of the thousands that a real
// open-loop arrival stream would have suffered.
for (;;) { auto t0 = now(); send_and_wait(); hist.record(now() - t0); }

// RIGHT (open loop): fixed intended-arrival schedule; measure from INTENDED time.
auto const interval = std::chrono::nanoseconds{1'000'000'000 / kRatePerSec};
auto intended = Clock::now();
for (std::size_t i = 0; i < kOps; ++i, intended += interval) {
    if (auto const nowt = Clock::now(); nowt < intended) spin_until(intended);
    else backlog_ns += (nowt - intended).count();       // we are already behind
    auto const t0 = Clock::now();
    send_and_wait();
    hist.record((Clock::now() - intended).count());     // service + queueing delay
}
```

| Statistic | Report it because | Do not use it for |
|---|---|---|
| `N`, warmup policy, runs | reproducibility; tail credibility | — |
| min | best-observed lower bound on the mechanism | "typical" cost |
| median (p50) | robust central tendency | tail behavior |
| p99 / p99.9 / p99.99 | SLO-relevant tails | claims when `N` < 100/quantile-tail |
| max | operationally real; noise-sensitive | comparing two runs |
| mean + stdev | only if unimodal and near-symmetric | latency, essentially ever |
| histogram / eCDF | reveals modes, plateaus, retry cliffs | — |
| latency vs wall-clock | throttling, GC-like phases, interrupts | — |
| discarded samples + predeclared rule | honesty | post-hoc outlier removal |

Sample-count intuition: p99.9 keeps 0.1 % of samples beyond it, so 10 000 samples ⇒ ~10 observations describe your tail; 1e6 samples ⇒ ~1000. Autocorrelated samples reduce the *effective* count further, so bootstrap CIs over *blocks*, not individual samples.

**Traps** — quoting p99 to three significant figures from 2000 samples · averaging percentiles across runs or across shards (p99 is not additive — merge histograms instead) · a histogram bucket edge reported as an exact value · `nth_element` reorders your samples · HdrHistogram-style structures silently saturate above their configured max.

---

## 45.5 Separate setup, parsing, allocation, and I/O from the measured region

```cpp
// ---- phase discipline -------------------------------------------------------
std::vector<Event> const events = load_events("capture.bin");   // I/O        : untimed
Book  book  = make_reserved_book(kMaxLevels, kMaxOrders);       // allocation : untimed
warmup([&]{ return apply(book, events[0]); }, 200ms);           // preparation: untimed
book = make_reserved_book(kMaxLevels, kMaxOrders);              // reset      : untimed

auto const t0 = Clock::now();
for (std::size_t i = 0; i < kReps; ++i)
    apply(book, events[i % events.size()]);                     // MEASURED
clobber_memory();
auto const t1 = Clock::now();
do_not_optimize(book);
```

```cpp
// ---- prove the phase is allocation-free -------------------------------------
#include <memory_resource>

class CountingResource final : public std::pmr::memory_resource {
public:
    explicit CountingResource(std::pmr::memory_resource* up) noexcept : up_{up} {}
    std::size_t allocations() const noexcept { return allocs_; }
    std::size_t bytes()       const noexcept { return bytes_; }
    std::size_t high_water()  const noexcept { return high_; }
private:
    void* do_allocate(std::size_t n, std::size_t a) override {
        ++allocs_; bytes_ += n; live_ += n; high_ = std::max(high_, live_);
        return up_->allocate(n, a);
    }
    void do_deallocate(void* p, std::size_t n, std::size_t a) override {
        live_ -= n; up_->deallocate(p, n, a);
    }
    bool do_is_equal(std::pmr::memory_resource const& o) const noexcept override {
        return this == &o;
    }
    std::pmr::memory_resource* up_;
    std::size_t allocs_{}, bytes_{}, live_{}, high_{};   // thread-confined
};

CountingResource cr{std::pmr::new_delete_resource()};
std::pmr::vector<Level> levels{&cr};
levels.reserve(kMaxLevels);
auto const before = cr.allocations();
run_steady_state_phase(levels);
assert(cr.allocations() == before && "steady-state phase allocated");
```

```cpp
// ---- global operator new interception: catches EVERYTHING, test binary only --
#include <atomic>
#include <cstdlib>
inline std::atomic<std::size_t> g_new_calls{0};
inline std::atomic<bool>        g_forbid{false};

void* operator new(std::size_t n) {
    g_new_calls.fetch_add(1, std::memory_order_relaxed);
    if (g_forbid.load(std::memory_order_relaxed)) std::abort();   // trip the wire
    if (void* p = std::malloc(n ? n : 1)) return p;
    throw std::bad_alloc{};
}
void  operator delete(void* p)             noexcept { std::free(p); }
void  operator delete(void* p, std::size_t) noexcept { std::free(p); }
// Also override the aligned and array forms; sized delete must match.
```

```bash
# Allocation and page-fault evidence from outside the process
/usr/bin/time -v ./bench                      # max RSS, minor/major faults
ltrace -c -e 'malloc+free+calloc' ./bench     # call counts (slow, dev only)
valgrind --tool=massif --massif-out-file=m.out ./bench && ms_print m.out
heaptrack ./bench && heaptrack_print heaptrack.bench.*.zst | head -50
LD_PRELOAD=/usr/lib/libjemalloc.so MALLOC_CONF=stats_print:true ./bench
```

Hidden setup that leaks into a "kernel" measurement: `std::format`/locale/iostream first use · `std::regex` construction · thread-local ctor on first touch · first `throw` (loads `.eh_frame`, may `dlopen`) · first `unordered_map` insert and every rehash · `std::function` heap capture · coroutine frame allocation · lazy `std::async`/thread-pool spin-up · demand-zero page commitment despite `reserve`.

**Traps** — timing `reserve()` inside candidate A but not B · reusing a warm `book` for A and a cold one for B · reading the input file inside the loop (page cache makes it "fast" and non-deterministic) · `assert` compiled out under `-DNDEBUG` so your allocation guard silently vanishes.

---

## 45.6 Clock selection, measurement overhead, and batching

```cpp
#include <chrono>
using namespace std::chrono;

steady_clock::now();            // MONOTONIC, steady rate — use for elapsed intervals
system_clock::now();            // civil time, can jump backward (NTP/settimeofday)
high_resolution_clock::now();   // alias of one of the above; NOT guaranteed steady
utc_clock::now();               // C++20, no leap-second smearing
tai_clock::now(); gps_clock::now(); file_clock::now();     // C++20

// Static properties
static_assert(steady_clock::is_steady);
constexpr auto tick = steady_clock::period{};              // e.g. nano → 1 ns nominal
// Nominal period != achievable resolution != read cost.
```

```cpp
// ---- measured clock resolution and read cost --------------------------------
nanoseconds clock_granularity() {
    auto best = nanoseconds::max();
    for (int i = 0; i < 100'000; ++i) {
        auto a = steady_clock::now(), b = a;
        while (b == a) b = steady_clock::now();            // wait for a tick change
        best = std::min(best, b - a);
    }
    return best;                                           // typ. 1–40 ns on Linux vDSO
}

nanoseconds clock_read_cost(std::size_t n = 1'000'000) {
    auto const t0 = steady_clock::now();
    for (std::size_t i = 0; i < n; ++i) do_not_optimize(steady_clock::now());
    auto const t1 = steady_clock::now();
    return duration_cast<nanoseconds>(t1 - t0) / n;        // typ. 15–30 ns
}
```

```cpp
// ---- rdtsc: ~20–40 cycles, no syscall, needs ordering + calibration ---------
#include <x86intrin.h>

// Before the region: lfence prevents earlier loads from drifting past the read.
[[gnu::always_inline]] inline std::uint64_t rdtsc_start() noexcept {
    _mm_lfence();
    std::uint64_t const t = __rdtsc();
    _mm_lfence();
    return t;
}
// After the region: rdtscp waits for prior instructions to retire; lfence stops
// later instructions from being hoisted before it.
[[gnu::always_inline]] inline std::uint64_t rdtsc_stop() noexcept {
    unsigned aux;
    std::uint64_t const t = __rdtscp(&aux);                // aux = IA32_TSC_AUX (core id!)
    _mm_lfence();
    return t;
}

// ARM64 equivalent: the virtual counter, ~1–100 MHz, frequency from CNTFRQ_EL0.
inline std::uint64_t cntvct() noexcept {
    std::uint64_t v; asm volatile("isb; mrs %0, cntvct_el0" : "=r"(v)); return v;
}
```

```cpp
// ---- ticks → nanoseconds: measure, never assume the nominal frequency -------
inline double calibrate_tsc_ghz() {
    auto const w0 = steady_clock::now(); auto const c0 = rdtsc_start();
    std::this_thread::sleep_for(200ms);
    auto const c1 = rdtsc_stop();        auto const w1 = steady_clock::now();
    auto const ns = duration_cast<nanoseconds>(w1 - w0).count();
    return static_cast<double>(c1 - c0) / static_cast<double>(ns);   // ticks per ns
}
inline std::uint64_t cycles_to_ns(std::uint64_t cyc) {
    static double const ghz = calibrate_tsc_ghz();
    return static_cast<std::uint64_t>(static_cast<double>(cyc) / ghz);
}
```

```bash
# TSC trustworthiness (Linux)
grep -o -m1 -E 'constant_tsc|nonstop_tsc|tsc_reliable|rdtscp' /proc/cpuinfo | sort -u
cat /sys/devices/system/clocksource/clocksource0/current_clocksource   # want: tsc
dmesg | grep -i 'tsc:'            # "Marking TSC unstable" ⇒ do not use rdtsc for wall time
```

```cpp
// ---- amortize the timer: batch, and characterize the empty harness ----------
// observed = start_clock + loop + N*work + stop_clock
// empty    = start_clock + loop + N*nop  + stop_clock
template <class F>
nanoseconds time_batch(F&& f, std::size_t reps) {
    auto const t0 = steady_clock::now();
    for (std::size_t i = 0; i < reps; ++i) do_not_optimize(f(i));
    clobber_memory();
    auto const t1 = steady_clock::now();
    return duration_cast<nanoseconds>(t1 - t0);
}

auto const empty = time_batch([](std::size_t i) { return i; }, kReps);
auto const full  = time_batch([&](std::size_t i) { return kernel(in[i & mask]); }, kReps);
// Report BOTH. Do not silently subtract: the empty loop's code shape differs,
// overhead is variable, and a negative "corrected" value means your model is wrong.
double const per_op_ns = double((full - empty).count()) / double(kReps);   // calibration
```

```cpp
// ---- pick the batch size so signal >> resolution ---------------------------
// Rule of thumb: batch until the timed region is >= 1000x clock granularity
// AND >= 100 us of wall time, then run many independent batches for a distribution.
std::size_t choose_reps(auto&& f) {
    std::size_t n = 1;
    while (time_batch(f, n) < 100us) n *= 2;
    return n;
}
```

| Approach | Overhead per sample | Gives | Use when |
|---|---|---|---|
| `steady_clock` per operation | 15–30 ns ×2 | full distribution | op ≥ ~1 µs |
| `rdtsc`/`rdtscp` per operation | 20–40 cycles ×2 | full distribution | op ≥ ~200 ns, pinned thread |
| batch of `B` | amortized to ~0 | mean only | op < 100 ns, throughput claims |
| sampled timing (1-in-K) | 1/K of above | biased-free distribution, fewer samples | tails at high rate |
| `perf stat` cycles/instructions | none in-process | totals, IPC, misses | explaining a result |
| event timestamps at boundaries | one read per stage | queue vs service decomposition | pipelines |

**Traps** — `duration_cast` truncates toward zero; use `round<nanoseconds>` when it matters · comparing time points from *different* clocks is ill-formed, from different *cores* is meaningless unless the TSC is invariant and synced · `rdtsc` without fences drifts by tens of cycles from OoO execution · `__rdtscp`'s `aux` changes if you migrated — check it and discard the sample · TSC counts reference cycles, so a p-state change alters cycles-per-work but not ticks-per-second · deep sleep states stop non-`nonstop_tsc` counters · virtualized TSC may trap to the hypervisor (~1 µs).

---

## 45.7 CPU frequency, affinity, NUMA, interrupts, and environmental noise

```bash
# ---- boot-time isolation (GRUB cmdline; reboot required) --------------------
isolcpus=2-7,10-15 nohz_full=2-7,10-15 rcu_nocbs=2-7,10-15 \
  irqaffinity=0,1,8,9 intel_pstate=disable idle=poll processor.max_cstate=1 \
  intel_idle.max_cstate=0 mitigations=off transparent_hugepage=never audit=0
```

```bash
# ---- runtime environment control -------------------------------------------
sudo cpupower frequency-set -g performance                  # governor
sudo cpupower frequency-set -d 3.0GHz -u 3.0GHz             # pin frequency, kill turbo
echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo
echo 0 | sudo tee /proc/sys/kernel/nmi_watchdog
echo -1 | sudo tee /proc/sys/kernel/sched_rt_runtime_us     # allow 100% RT
echo 0 | sudo tee /proc/sys/kernel/numa_balancing
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
echo 0 | sudo tee /sys/devices/system/cpu/cpu14/online       # offline the SMT sibling
sudo sysctl -w kernel.perf_event_paranoid=-1                 # unprivileged perf
sudo sysctl -w vm.stat_interval=120                          # fewer vmstat wakeups

# ---- pin, prioritize, place memory -----------------------------------------
taskset -c 3 ./bench                                        # pin to CPU 3
chrt -f 80 taskset -c 3 ./bench                             # SCHED_FIFO prio 80
numactl --cpunodebind=0 --membind=0 ./bench                 # local NUMA only
numactl --physcpubind=3 --localalloc ./bench
nice -n -20 ./bench

# ---- what the topology actually is -----------------------------------------
lscpu -e=CPU,NODE,SOCKET,CORE,L1d:L1i:L2:L3,MAXMHZ           # sibling map
lstopo-no-graphics --of console
numactl --hardware
cat /sys/devices/system/cpu/cpu3/topology/thread_siblings_list
cat /sys/devices/system/cpu/isolated /sys/devices/system/cpu/nohz_full

# ---- did anything interfere? ------------------------------------------------
perf stat -e context-switches,cpu-migrations,page-faults,cycles \
          -C 3 -- ./bench
cat /proc/interrupts | awk 'NR==1 || $4+0>0'                 # per-CPU IRQ counts
perf sched latency --sort max
turbostat --interval 1 --show Core,CPU,Busy%,Bzy_MHz,PkgTmp,PkgWatt -- ./bench
grep -E 'MHz|model name' /proc/cpuinfo | head
```

```cpp
// ---- pin from inside the process --------------------------------------------
#include <pthread.h>
#include <sched.h>

bool pin_to_cpu(int cpu) noexcept {
    cpu_set_t set; CPU_ZERO(&set); CPU_SET(cpu, &set);
    return pthread_setaffinity_np(pthread_self(), sizeof(set), &set) == 0;
}

bool set_realtime(int prio) noexcept {                       // SCHED_FIFO
    sched_param p{}; p.sched_priority = prio;
    return pthread_setschedparam(pthread_self(), SCHED_FIFO, &p) == 0;
}

// Record which core actually ran, and drop samples that migrated.
int current_cpu() noexcept { return sched_getcpu(); }

// First-touch NUMA placement: the thread that first writes a page owns its node.
void first_touch(std::span<std::byte> mem) {
    for (std::size_t i = 0; i < mem.size(); i += 4096) mem[i] = std::byte{0};
}
```

```cpp
// ---- record the environment INTO the results file ---------------------------
struct RunMetadata {
    std::string host, kernel, cpu_model, compiler, flags, git_sha;
    int    pinned_cpu{}, numa_node{};
    bool   smt_sibling_online{}, turbo_enabled{}, thp_enabled{};
    double tsc_ghz{}, start_mhz{}, end_mhz{}, start_temp_c{}, end_temp_c{};
    std::uint64_t ctx_switches{}, migrations{}, minor_faults{}, major_faults{};
};
// getrusage(RUSAGE_SELF, &ru) → ru_nivcsw, ru_nvcsw, ru_minflt, ru_majflt
```

| Noise source | Symptom in the data | Control | Residual risk |
|---|---|---|---|
| Migration | bimodal, cross-node latencies | `taskset` / `pthread_setaffinity_np` | still preempted |
| Frequency / turbo | slow drift across a run | fixed governor + `no_turbo` | thermal cap remains |
| SMT sibling | ~2× variance, halved IPC | offline the sibling, or load it deliberately | production may have it busy |
| Interrupts / timer tick | periodic spikes | `nohz_full`, `irqaffinity`, `isolcpus` | IPIs, NMIs never removable |
| Page faults / THP | first-iteration cliffs | pretouch + `mlockall`, THP off | reclaim under memory pressure |
| NUMA remote memory | ~1.5–2× load latency | `numactl --membind`, first-touch | interleaved allocators |
| C-states | first-access wakeup latency | `idle=poll`, `max_cstate=1` | power/thermal budget |
| Virtualization | steal time, trapped `rdtsc` | bare metal; check `/proc/stat` steal | none in cloud |
| Background I/O / logging | rare multi-ms outliers | quiesce, record `iostat` | shared storage |

**Interview line** — "Pinning controls exactly one variable; it does not remove interrupts, frequency transitions, NUMA effects, or thermal throttling, and an isolated lab number may not predict deployed tail latency."

**Traps** — `isolcpus` alone still leaves the tick and kernel threads unless you add `nohz_full` + `rcu_nocbs` · `SCHED_FIFO` at high priority can hard-lock a machine — always keep an escape core · `mitigations=off` changes syscall cost so results no longer describe production · disabling turbo lowers absolute numbers but is the right call for comparability.

---

## 45.8 Benchmarking contention and overload behavior

```cpp
// ---- open-loop producer with a fixed offered load, per-thread accounting -----
struct alignas(64) ThreadStats {          // one cache line each: no false sharing
    std::uint64_t attempted{}, succeeded{}, rejected{}, spins{};
    LatencyHistogram enqueue, residence, service;
};

std::atomic<bool> go{false};              // barrier start
std::atomic<bool> stop{false};

void producer(Queue& q, ThreadStats& st, std::uint64_t rate_hz, int cpu) {
    pin_to_cpu(cpu);
    while (!go.load(std::memory_order_acquire)) __builtin_ia32_pause();
    auto const period = static_cast<std::uint64_t>(tsc_ghz * 1e9 / double(rate_hz));
    std::uint64_t next = rdtsc_start();
    while (!stop.load(std::memory_order_relaxed)) {
        while (rdtsc_start() < next) __builtin_ia32_pause();   // open loop: never wait on q
        next += period;
        Msg m{.publish_tsc = rdtsc_start(), .payload = make_payload()};
        auto const t0 = rdtsc_start();
        ++st.attempted;
        if (q.try_push(m)) { ++st.succeeded; st.enqueue.record(cycles_to_ns(rdtsc_stop() - t0)); }
        else               { ++st.rejected;  }                 // COUNT the drops
    }
}

void consumer(Queue& q, ThreadStats& st, int cpu) {
    pin_to_cpu(cpu);
    while (!go.load(std::memory_order_acquire)) __builtin_ia32_pause();
    Msg m;
    while (!stop.load(std::memory_order_relaxed)) {
        if (!q.try_pop(m)) { ++st.spins; continue; }
        auto const deq = rdtsc_start();
        st.residence.record(cycles_to_ns(deq - m.publish_tsc));  // QUEUE DELAY
        process(m);
        st.service.record(cycles_to_ns(rdtsc_stop() - deq));     // SERVICE TIME
    }
}
// Combine per-thread histograms AFTER stop; never share one atomic counter.
```

```cpp
// ---- occupancy sampling from a third, non-participating thread --------------
void sampler(Queue const& q, LatencyHistogram& occ) {
    while (!stop.load(std::memory_order_relaxed)) {
        occ.record(q.size_approx());                 // relaxed reads only
        std::this_thread::sleep_for(100us);
    }
}
```

```text
Load sweep — run each point long enough for steady state (>= 30 s):
  0.5x  0.7x  0.85x  0.95x  1.0x  1.05x  1.2x  2.0x  of measured capacity
Report per point: offered, achieved, rejected, p50/p99/p99.9 residence + service,
occupancy p50/max, per-thread success counts (fairness), and recovery time after a burst.
The "knee" is where p99 residence departs from p50 — that, not max ops/s, is capacity.
```

| Dimension | Points to cover |
|---|---|
| Topology | SPSC, MPSC, MPMC; same-core, same-L3, cross-socket producer/consumer |
| Offered load | below knee, at knee, sustained overload, bursty (on/off duty cycle) |
| Payload | 8-byte word, 64-byte cache line, owning object with allocation |
| Full policy | spin, yield, block, reject, overwrite-oldest |
| Capacity | tiny (wrap-heavy, index contention), production-sized |
| Metrics | attempted = succeeded + rejected + dropped; residence; service; end-to-end; occupancy; per-thread fairness |

```cpp
// ---- observer effect: the wrong way and the right way -----------------------
std::atomic<std::uint64_t> g_ops;              // BAD: every thread RFOs one line
g_ops.fetch_add(1, std::memory_order_relaxed); // becomes the benchmark's bottleneck

thread_local std::uint64_t t_ops;              // GOOD: register/L1-local
++t_ops;                                       // publish once at the end
```

**Traps** — barrier-start-then-report-aggregate-ops/s hides starvation and unfairness entirely · a queue that rejects 90 % of pushes looks superb per *successful* op · closed-loop producers self-throttle and manufacture coordinated omission · `size_approx()` on a lock-free queue is a hint, and reading it from a participating thread perturbs the line · pinning producer and consumer to SMT siblings measures a case production may never have.

---

## 45.9 Inspecting allocation counts, hardware counters, and generated code

```bash
# ---- perf: counts, then a profile, then annotated assembly ------------------
perf stat -d -r 10 ./bench                       # 10 runs, mean±stddev, L1/LLC breakdown
perf stat -e cycles,instructions,branches,branch-misses,\
cache-references,cache-misses,L1-dcache-load-misses,LLC-load-misses,\
dTLB-load-misses,stalled-cycles-frontend,stalled-cycles-backend \
  -C 3 -- taskset -c 3 ./bench                   # IPC + where the stalls are
perf stat -M TopdownL1 ./bench                   # frontend/backend/bad-spec/retiring
perf list | grep -i 'cache\|tlb'                 # what this CPU actually supports

perf record -F 4999 -g --call-graph=dwarf -- ./bench
perf report --sort=dso,symbol --percent-limit 1
perf annotate --stdio -s hot_function            # source+asm with sample attribution
perf script | stackcollapse-perf.pl | flamegraph.pl > flame.svg

# Precise-event sampling (PEBS) to defeat skid
perf record -e cycles:pp -c 100000 -- ./bench
perf mem record ./bench && perf mem report        # load/store latency & source
perf c2c record ./bench && perf c2c report        # FALSE SHARING: HITM cache lines

# Kernel-side latency causes
perf sched record -- ./bench && perf sched latency --sort max
perf trace -s ./bench                             # syscall counts + time
```

```bash
# ---- other counter/simulation tools ----------------------------------------
toplev.py -l3 --no-desc ./bench                   # pmu-tools top-down levels
likwid-perfctr -C 3 -g MEM_DP ./bench
ocperf.py stat -e cpu/event=0xd1,umask=0x1/ ./bench
valgrind --tool=cachegrind --cache-sim=yes ./bench    # deterministic, simulated
valgrind --tool=callgrind --dump-instr=yes ./bench && kcachegrind callgrind.out.*
llvm-mca -mcpu=znver4 -timeline kernel.s          # static pipeline model, no run
uiCA.py --arch SKL kernel.s                       # static throughput estimate
```

```bash
# ---- did the work survive? read the actual code ----------------------------
g++ -O2 -std=c++23 -march=native -S -masm=intel -fverbose-asm bench.cpp -o bench.s
objdump -d --no-show-raw-insn -M intel -S ./bench | less     # interleaved source
nm -C --size-sort ./bench | tail -30                          # code bloat by symbol
g++ -O2 -fopt-info-vec-missed -fopt-info-inline bench.cpp     # why not vectorized
clang++ -O2 -Rpass=loop-vectorize -Rpass-missed=loop-vectorize \
        -Rpass-analysis=loop-vectorize bench.cpp
clang++ -O2 -mllvm -inline-threshold=0 ...                    # A/B inlining effects
bloaty -d symbols ./bench                                     # template instantiation cost
```

```cpp
// ---- assembly audit checklist, as assertions where possible -----------------
// 1. Did the loop survive?             → non-empty body between the labels
// 2. Was it inlined / devirtualized?   → no `call` to the candidate
// 3. Are vector instructions present?  → vpaddd/vfmadd vs scalar addss
// 4. Were bounds checks hoisted?       → one cmp/jae before the loop, not inside
// 5. Did "branchless" cost more?       → cmov + both operands evaluated
// 6. Template blowup?                  → many near-identical symbols in nm output
// 7. Unexpected spills?                → push/pop or [rsp+..] traffic in the body

// Force the compiler to keep a function observable when auditing:
[[gnu::noinline, gnu::used]] std::uint64_t kernel(std::span<std::uint32_t const>);
```

| Counter | Reads as | Caveat |
|---|---|---|
| `instructions / cycles` (IPC) | pipeline efficiency | high IPC can mean more wasted work |
| `branch-misses` | ~15–20 cycle penalty each | normalize per branch, not per cycle |
| `L1-dcache-load-misses` | working set > L1 | prefetch hides many |
| `LLC-load-misses` | DRAM traffic, ~80–120 ns each | includes prefetcher fills |
| `dTLB-load-misses` | page-walk cost | THP changes it drastically |
| `stalled-cycles-backend` | memory/execution bound | not available on all parts |
| `cycles:pp` (PEBS) | precise attribution | still 1-instruction skid |
| `mem_load_retired.*_hitm` | false sharing | AMD/Intel names differ |

**Traps** — more events than counters ⇒ *multiplexing*, and `perf` scales up the estimate (check the `%` enabled column) · counter definitions differ per microarchitecture, so never compare raw event counts across CPU models · sampling skid attributes cost to the following instruction without PEBS · `perf` inside containers/VMs may see no PMU at all · counters explain, they never prove, and assembly describes exactly one build.

---

## 45.10 Performance claims as compiler/platform-specific evidence

```bash
# ---- disciplined A/B: same toolchain, randomized order, separate processes ---
for run in $(seq 1 20); do
  for cand in $(shuf -e A B); do            # randomize order → kill drift bias
    chrt -f 80 taskset -c 3 numactl --membind=0 \
      ./bench --impl=$cand --seed=$run --ops=2000000 --json >> results.jsonl
  done
done
# Compare PAIRED differences within each run, not pooled means across runs.
```

```bash
# ---- build both candidates identically except the change --------------------
g++ -std=c++23 -O2 -march=x86-64-v3 -fno-omit-frame-pointer -g \
    -DNDEBUG -flto=auto bench.cpp -o benchA
# record the provenance
g++ --version; git rev-parse HEAD; echo "$CXXFLAGS"
sha256sum benchA benchB

# ---- Google Benchmark: real invocation --------------------------------------
./bm --benchmark_repetitions=20 --benchmark_report_aggregates_only=false \
     --benchmark_min_time=2s --benchmark_enable_random_interleaving=true \
     --benchmark_format=json --benchmark_out=a.json
python3 tools/compare.py benchmarks a.json b.json     # U-test p-values, % change
```

```cpp
// ---- Google Benchmark idioms worth memorizing --------------------------------
#include <benchmark/benchmark.h>

static void BM_Apply(benchmark::State& state) {
    auto const events = load_events();                       // setup: untimed
    Book book = make_reserved_book();
    for (auto _ : state) {                                   // the timed loop
        state.PauseTiming(); reset(book); state.ResumeTiming();   // ~350 ns each — avoid
        for (auto const& e : events) benchmark::DoNotOptimize(apply(book, e));
        benchmark::ClobberMemory();
    }
    state.SetItemsProcessed(state.iterations() * events.size());
    state.SetBytesProcessed(state.iterations() * events.size() * sizeof(Event));
    state.counters["ns/event"] = benchmark::Counter(
        double(state.iterations() * events.size()),
        benchmark::Counter::kIsRate | benchmark::Counter::kInvert);
}
BENCHMARK(BM_Apply)->RangeMultiplier(2)->Range(1 << 10, 1 << 20)   // sweep sizes
                   ->UseRealTime()->MinWarmUpTime(0.5)->Unit(benchmark::kNanosecond);
BENCHMARK_MAIN();
```

**A/B protocol**
1. Verify identical outputs and identical semantic contracts (capacity, error, ordering, thread-safety).
2. Build both from the same compiler and flags, differing only in the change under test.
3. Feed identical prebuilt inputs; no candidate-specific setup inside the timed region.
4. Randomize and interleave run order; never all-A-then-all-B.
5. Repeat across *processes*, not only iterations — ASLR, allocator layout, and page colouring change between runs.
6. Report the distribution of paired differences or ratios, with a nonparametric test (Mann-Whitney U) and an effect size, not just a p-value.
7. Explain the mechanism with counters, allocation counts, and assembly.
8. Re-run on other CPUs, compilers, and workloads before generalizing at all.

**Common misleading benchmarks**

| Failure | Symptom | Repair |
|---|---|---|
| Unused result | loop deleted; time ~0 or constant | `do_not_optimize`, checked output, read the asm |
| Constant input | folded; branches unrealistically predictable | runtime data, fixed seed for reproducibility |
| One-nanosecond call timed directly | timer dominates; quantized output | batch, characterize the empty harness |
| Setup inside one candidate only | measures allocation/parsing, not the kernel | equalize setup or measure end-to-end explicitly |
| Best-of-N only | describes the luckiest noise state | full distribution + run metadata |
| One input size | a cache/capacity boundary masquerades as behavior | sweep sizes across L1/L2/LLC/DRAM thresholds |
| Sanitizer or `-O0` build | instrumentation is the workload | sanitizers for correctness; measure `-O2 -DNDEBUG` |
| "Pre-reserved ⇒ zero allocation" | element/formatter/callback allocates anyway | enforce capacity, instrument the entire phase |
| Coordinated omission | tail looks great under load | open-loop arrivals from intended timestamps |
| Comparing across machines/runs | ±20 % is ambient | paired, randomized, same-host comparison |

**Interview line** — "A benchmark result is evidence about one build on one machine under one workload; it is never a property of the C++ language, so the claim must carry compiler, options, CPU, OS state, workload, metric boundary, sample count, and estimator with it."

**Recall card**

```text
claim        metric + boundary + workload + platform/compiler/options
throughput   completed work / time; report rejected and dropped work too
latency      define start and stop; separate queue, service, end-to-end
tail         distribution + named estimator + enough samples; mean is insufficient
optimizer    runtime input + do_not_optimize + clobber_memory + read the asm
clock        steady_clock for intervals; rdtscp+lfence for cycles; calibrate ticks->ns
batching     amortizes observation cost; destroys the per-op distribution
warmup       intentional state preparation; never warm away a target cost
setup        exclude or include explicitly and name the scope
environment  affinity, isolcpus/nohz_full, governor, SMT, NUMA, IRQs, THP, thermals
contention   load sweep to the knee, occupancy, fairness, rejects, overload policy
allocation   name the phase, enforce bounds, intercept operator new, assert no delta
evidence     randomized paired A/B across processes + histograms + counters + asm

performance claim = compiler/platform/workload-specific evidence, never C++ law
```
