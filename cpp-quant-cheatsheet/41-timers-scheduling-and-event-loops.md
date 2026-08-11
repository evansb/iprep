# 41. Timers, scheduling, and event loops

*Part VI-B — Quant blueprints: pipeline, publication, and runtime*

---

**Recall**
- Schedule elapsed-time work on `steady_clock` (`is_steady == true`); wall-clock adjustment can move `system_clock` time points backward.
- A deadline is an absolute `time_point`; a delay is a `duration` — never a bare `int`.
- Time points from different clocks are not comparable, not subtractable, and not convertible without `clock_cast`/calibration.
- Fire when `deadline <= now`: a deadline equal to the observation is due.
- Read `now()` once per expiry batch, not once per timer — clock reads are a real syscall/`rdtsc`-fence cost.
- Equal deadlines need an explicit tie-breaker (insertion sequence) or replay is nondeterministic.
- `std::priority_queue` gives O(1) `top`, O(log T) push/pop, and **no** erase and **no** decrease-key.
- Lazy cancellation (tombstones) makes `cancel` O(1) but retains storage and can produce a burst of stale pops.
- Never reuse a timer slot while a stale ordering entry still names it — carry and validate a generation.
- An indexed heap (slot → heap position, maintained by sift-up/sift-down) restores O(log T) arbitrary cancel and rearm.
- A sorted vector beats a heap for tens of timers: contiguous scan, cache-friendly `lower_bound`, predictable memmove.
- A timing wheel is O(1) *bucket selection*, not O(1) expiry — cost tracks bucket occupancy, elapsed ticks, and cascading.
- Mutating an element already inside a heap invalidates the heap invariant; re-sift or insert a fresh validated entry.
- Fixed-delay repeats schedule from completion (drifts); fixed-rate repeats schedule from the previous deadline (needs a missed-interval policy).
- Unbounded catch-up of missed intervals is a timer storm; coalesce, skip, or enforce a callback budget.
- `wait_until` may return early (spuriously), late, or for another predicate — always loop on the predicate under its mutex.
- A new *earliest* deadline must update protected state **and** notify, or the loop sleeps to the old later deadline.
- `std::stop_token` is cooperative: it interrupts nothing by itself; the wait must register a `stop_callback` that wakes it.
- `std::jthread` joins in its destructor, but members declared *after* it are destroyed *first* — declare the thread last or stop/join explicitly.
- Tests inject a manual clock and a manual waiter and advance exact durations; `sleep_for` in a unit test is a bug.

---

## 41.1 Monotonic deadlines and duration-safe APIs

```cpp
#include <chrono>
#include <cstdint>

using Clock     = std::chrono::steady_clock;   // monotonic by contract
using TimePoint = Clock::time_point;           // = time_point<steady_clock, nanoseconds> in practice
using Duration  = Clock::duration;             // signed integral rep

static_assert(Clock::is_steady);               // the whole reason to pick it
static_assert(std::chrono::steady_clock::period::den >= 1'000'000);  // impl detail, not a guarantee
```

```cpp
// ---- duration spellings ------------------------------------------------
using namespace std::chrono_literals;
std::chrono::nanoseconds  ns{250};             // explicit rep
auto us  = 250us;                              // microseconds  (literal, C++14)
auto ms  = 5ms;                                // milliseconds
auto s   = 3s;  auto mi = 2min; auto h = 1h;
std::chrono::duration<double, std::milli> fms{2.5};   // floating rep
std::chrono::duration<std::int64_t, std::ratio<1, 3>> third{1};  // custom period

auto sum = 1s + 250ms;                         // → milliseconds (common_type = finer period)
// auto bad = 1s + fms;                        // ok actually: → duration<double, milli>
auto exact = std::chrono::duration_cast<std::chrono::nanoseconds>(250us);  // widening: exact
auto cut   = std::chrono::duration_cast<std::chrono::seconds>(1'999ms);    // → 1s, TRUNCATES toward zero
auto up    = std::chrono::ceil<std::chrono::seconds>(1'999ms);             // → 2s   (C++17)
auto down  = std::chrono::floor<std::chrono::seconds>(-1'999ms);           // → -2s  (C++17)
auto near  = std::chrono::round<std::chrono::seconds>(1'500ms);            // ties to even (C++17)
auto abs_  = std::chrono::abs(-5ms);
auto r     = ms.count();                       // strips units — do this only at the ABI edge
```

```cpp
// ---- time_point arithmetic --------------------------------------------
TimePoint now  = Clock::now();
TimePoint due  = now + 250us;                  // tp + dur → tp
Duration  left = due - now;                    // tp - tp  → dur
// auto x = due + now;                          // ill-formed: tp + tp is meaningless
bool overdue = due <= now;                     // '<=' : equal deadline IS due
auto ord     = due <=> now;                    // strong_ordering (C++20)
auto coarse  = std::chrono::floor<std::chrono::milliseconds>(due);   // tp cast, C++17
auto epoch   = now.time_since_epoch();         // duration since UNSPECIFIED epoch
constexpr TimePoint never = TimePoint::max();  // "no deadline" sentinel
```

```cpp
// ---- typed API surface -------------------------------------------------
struct Deadline { TimePoint value{}; };        // strong type: cannot pass a delay by accident

[[nodiscard]] constexpr Deadline after(TimePoint now, Duration d) noexcept {
    return Deadline{now + d};                  // overflow-check if `d` is untrusted
}
void arm_at(Deadline);                         // absolute
void arm_after(Duration);                      // relative
// void arm(long long);                        // BAD: unitless; 250 what?

// Saturating add: Duration is signed; now + huge can overflow to the past.
[[nodiscard]] constexpr TimePoint add_saturating(TimePoint t, Duration d) noexcept {
    constexpr auto hi = Duration::max();
    auto room = hi - t.time_since_epoch();     // assumes t >= epoch
    return (d > room) ? TimePoint::max() : t + d;
}
```

| Clock | Standard property | Use for |
|---|---|---|
| `std::chrono::steady_clock` | monotonic, never adjusted, epoch unspecified | deadlines, elapsed time, backoff, latency |
| `std::chrono::system_clock` | maps to civil time (`to_time_t`, `from_time_t`), may jump | timestamps, calendar scheduling, logs |
| `std::chrono::high_resolution_clock` | alias for one of the above; **not guaranteed steady** | nothing portable |
| `std::chrono::utc_clock` / `tai_clock` / `gps_clock` | C++20, leap-second aware | civil arithmetic across leap seconds |
| `std::chrono::file_clock` | filesystem timestamps | `last_write_time` |

| Facility | Header | Notes |
|---|---|---|
| `duration_cast<D>(d)` | `<chrono>` | truncates toward zero; explicit for lossy conversions |
| `floor/ceil/round<D>(d\|tp)` | `<chrono>` | C++17, stated rounding direction |
| `clock_cast<Clock>(tp)` | `<chrono>` | C++20; only between clocks with a `clock_time_conversion` |
| `time_point_cast<D>(tp)` | `<chrono>` | truncating tp conversion |
| `treat_as_floating_point_v<Rep>` | `<chrono>` | governs implicit lossy conversions |
| `duration_values<Rep>::{zero,min,max}` | `<chrono>` | customization for user reps |
| `std::this_thread::sleep_until/sleep_for` | `<thread>` | may sleep **longer**, never shorter |
| `cv.wait_until(lk, tp, pred)` | `<condition_variable>` | returns `pred()`; may wake spuriously |

**Traps** — `high_resolution_clock` is not portably monotonic · `duration_cast` truncates toward zero, so `-1'999ms → -1s` · `count()` at an interface loses the unit forever · mixing `steady_clock` and `system_clock` time points compiles for *durations* but is a semantic bug · `now + delay` can overflow a signed `rep` and land in the past · `system_clock::now()` moving backward makes an interval fire twice or never.

---

## 41.2 Sorted queues, heaps, timing wheels, and fixed buckets

Let `T` = active timers, `B` = timers in one bucket.

| Structure | Insert | Earliest | Arbitrary cancel | Best fit |
|---|---:|---:|---:|---|
| sorted `vector` | O(T) shift | O(1) | O(T) or lazy | T ≲ 64, expiry-heavy, compact |
| binary heap (lazy) | O(log T) | O(1) | O(1) mark + O(log T) later pop | general purpose, simple |
| indexed binary heap | O(log T) | O(1) | O(log T) | cancel/rearm heavy |
| `std::map`/`multimap` | O(log T) | O(1) `begin()` | O(log T) via iterator | stable nodes, allocates per timer |
| hierarchical timing wheel | O(1) | O(1) per tick | O(1) intrusive unlink | 10⁴–10⁶ timers, bounded horizon |
| single bucket ring | O(1) | O(elapsed + B) | O(1) | one fixed resolution and horizon |

```cpp
// ---- 1. std::priority_queue: the 10-line version -----------------------
#include <queue>
#include <vector>

struct HeapEntry {
    TimePoint     deadline{};
    std::uint64_t seq{};            // total order for equal deadlines
    std::uint32_t index{};          // slot index
    std::uint32_t generation{};     // stale-entry detector (see 41.4)
};
struct Later {                      // REVERSED: priority_queue pops the "largest"
    bool operator()(HeapEntry const& a, HeapEntry const& b) const noexcept {
        if (a.deadline != b.deadline) return a.deadline > b.deadline;
        return a.seq > b.seq;       // earlier insertion wins ties
    }
};
std::priority_queue<HeapEntry, std::vector<HeapEntry>, Later> pq;   // top() == earliest
// No erase. No decrease-key. Cancel = mark the slot dead; discard on pop.
```

```cpp
// ---- 2. sorted vector: best for small T --------------------------------
#include <algorithm>
class SortedTimerList {
    std::vector<HeapEntry> v_;      // sorted DESCENDING so the earliest is back()
public:
    void insert(HeapEntry e) {
        auto pos = std::lower_bound(v_.begin(), v_.end(), e,
            [](HeapEntry const& a, HeapEntry const& b) {
                return a.deadline != b.deadline ? a.deadline > b.deadline : a.seq > b.seq;
            });
        v_.insert(pos, e);          // O(T) memmove — contiguous, branch-free, cheap for small T
    }
    [[nodiscard]] bool empty() const noexcept { return v_.empty(); }
    [[nodiscard]] HeapEntry const& earliest() const noexcept { return v_.back(); }
    void pop() noexcept { v_.pop_back(); }                 // O(1) at the back
    bool erase(std::uint32_t index) noexcept {             // O(T) scan
        auto it = std::find_if(v_.begin(), v_.end(),
                               [&](HeapEntry const& e) { return e.index == index; });
        if (it == v_.end()) return false;
        v_.erase(it);
        return true;
    }
};
```

```cpp
// ---- 3. hand-rolled binary heap (the whiteboard version) ---------------
// Array heap: parent(i) = (i-1)/2, children 2i+1 / 2i+2. min-heap on (deadline, seq).
inline bool earlier(HeapEntry const& a, HeapEntry const& b) noexcept {
    return a.deadline != b.deadline ? a.deadline < b.deadline : a.seq < b.seq;
}
inline void sift_up(std::vector<HeapEntry>& h, std::size_t i) {
    HeapEntry e = h[i];
    while (i != 0) {
        std::size_t p = (i - 1) / 2;
        if (!earlier(e, h[p])) break;
        h[i] = h[p];  i = p;                  // hole-shifting: 1 move per level, not 3
    }
    h[i] = e;
}
inline void sift_down(std::vector<HeapEntry>& h, std::size_t i) {
    std::size_t const n = h.size();
    HeapEntry e = h[i];
    for (;;) {
        std::size_t c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && earlier(h[c + 1], h[c])) ++c;
        if (!earlier(h[c], e)) break;
        h[i] = h[c];  i = c;
    }
    h[i] = e;
}
```

```cpp
// ---- 4. hierarchical timing wheel: complete, allocation-free -----------
// 4 levels x 64 slots, intrusive doubly-linked lists of pool indices.
// Horizon = 64^4 = 16'777'216 ticks; at 1ms resolution ≈ 4.6 hours.
#include <array>
#include <limits>

class TimingWheel {
public:
    static constexpr std::uint32_t kShift  = 6;
    static constexpr std::uint32_t kSlots  = 1u << kShift;      // 64
    static constexpr std::uint32_t kMask   = kSlots - 1;
    static constexpr std::uint32_t kLevels = 4;
    static constexpr std::uint32_t npos    = std::numeric_limits<std::uint32_t>::max();
    static constexpr std::uint64_t kHorizon = 1ull << (kShift * kLevels);

    struct Node {
        std::uint64_t tick{};          // absolute tick of expiry (validates the lap)
        std::uint32_t prev{npos};
        std::uint32_t next{npos};
        std::uint32_t generation{};
        std::uint32_t level{};         // cached for O(1) unlink
        std::uint32_t slot{};
        bool          linked{false};
    };

    explicit TimingWheel(std::uint32_t capacity, std::uint64_t start_tick = 0)
        : pool_(capacity), current_(start_tick) {
        for (auto& lvl : wheel_) lvl.fill(npos);
        for (std::uint32_t i = 0; i + 1 < capacity; ++i) pool_[i].next = i + 1;
        if (capacity) pool_[capacity - 1].next = npos;
        free_head_ = capacity ? 0 : npos;
    }

    // Returns npos when out of capacity or beyond the representable horizon.
    std::uint32_t insert(std::uint64_t tick) {
        if (free_head_ == npos) return npos;                     // capacity error
        std::uint64_t const delta = (tick > current_) ? tick - current_ : 0;
        if (delta >= kHorizon) return npos;                      // horizon error
        std::uint32_t const i = free_head_;
        free_head_ = pool_[i].next;
        Node& n = pool_[i];
        n.tick = tick;  ++n.generation;  n.prev = n.next = npos;  n.linked = false;
        link(i, level_of(delta), tick);
        ++size_;
        return i;
    }

    bool cancel(std::uint32_t i, std::uint32_t generation) noexcept {
        if (i >= pool_.size()) return false;
        Node& n = pool_[i];
        if (!n.linked || n.generation != generation) return false;   // stale handle
        unlink(i);
        n.next = free_head_;  free_head_ = i;                        // reuse bumps generation
        --size_;
        return true;
    }

    // Advance to `target` inclusive, appending every expired index to `out`.
    template<class Sink>
    void advance_to(std::uint64_t target, Sink&& out) {
        while (current_ <= target) {
            std::uint32_t const idx = static_cast<std::uint32_t>(current_ & kMask);
            if (idx == 0) {                                  // level 0 wrapped: pull down
                for (std::uint32_t lvl = 1; lvl < kLevels; ++lvl) {
                    cascade(lvl);
                    if (((current_ >> (kShift * lvl)) & kMask) != 0) break;
                }
            }
            for (std::uint32_t i = wheel_[0][idx]; i != npos; ) {
                std::uint32_t const next = pool_[i].next;
                unlink(i);
                pool_[i].next = free_head_;  free_head_ = i;
                --size_;
                out(i, pool_[i].generation);
                i = next;
            }
            ++current_;
        }
    }

    [[nodiscard]] std::uint64_t current_tick() const noexcept { return current_; }
    [[nodiscard]] std::uint32_t size() const noexcept { return size_; }
    [[nodiscard]] std::uint32_t generation_of(std::uint32_t i) const noexcept { return pool_[i].generation; }

private:
    static std::uint32_t level_of(std::uint64_t delta) noexcept {
        std::uint32_t lvl = 0;
        while (lvl + 1 < kLevels && (delta >> (kShift * (lvl + 1))) != 0) ++lvl;
        return lvl;                                          // slot resolution = 64^lvl ticks
    }
    void link(std::uint32_t i, std::uint32_t lvl, std::uint64_t tick) noexcept {
        auto const slot = static_cast<std::uint32_t>((tick >> (kShift * lvl)) & kMask);
        std::uint32_t& head = wheel_[lvl][slot];
        Node& n = pool_[i];
        n.prev = npos;  n.next = head;  n.linked = true;
        n.level = lvl;  n.slot = slot;
        if (head != npos) pool_[head].prev = i;
        head = i;
    }
    void unlink(std::uint32_t i) noexcept {
        Node& n = pool_[i];
        if (n.prev != npos) pool_[n.prev].next = n.next;
        else                wheel_[n.level][n.slot] = n.next;
        if (n.next != npos) pool_[n.next].prev = n.prev;
        n.prev = n.next = npos;  n.linked = false;
    }
    void cascade(std::uint32_t lvl) {                        // reinsert one higher bucket lower
        auto const slot = static_cast<std::uint32_t>((current_ >> (kShift * lvl)) & kMask);
        std::uint32_t i = wheel_[lvl][slot];
        wheel_[lvl][slot] = npos;
        while (i != npos) {
            std::uint32_t const next = pool_[i].next;
            pool_[i].prev = pool_[i].next = npos;  pool_[i].linked = false;
            std::uint64_t const d = (pool_[i].tick > current_) ? pool_[i].tick - current_ : 0;
            link(i, level_of(d), pool_[i].tick);
            i = next;
        }
    }
    std::vector<Node> pool_;
    std::array<std::array<std::uint32_t, kSlots>, kLevels> wheel_{};
    std::uint32_t free_head_{npos};
    std::uint32_t size_{};
    std::uint64_t current_{};
};
```

```cpp
// ---- 5. single fixed bucket ring (simplest wheel) ----------------------
// resolution R, N slots ⇒ horizon = N*R. Deadline → slot = (tick % N).
// A timer beyond the horizon must be re-armed later or rejected; a slot list
// must therefore record its absolute tick and skip entries from a future lap.
```

```cpp
// ---- ticks and deadlines ----------------------------------------------
constexpr Duration kResolution = std::chrono::milliseconds{1};
constexpr std::uint64_t to_tick(TimePoint base, TimePoint tp) noexcept {
    auto d = tp - base;
    if (d < Duration::zero()) return 0;
    // ceil: never fire EARLY than requested
    return static_cast<std::uint64_t>((d + kResolution - Duration{1}) / kResolution);
}
```

| Wheel decision | Must be answered |
|---|---|
| Tick resolution | rounding direction (`ceil` = never early) and worst-case lateness = one tick |
| Horizon | `slots^levels * resolution`; behavior beyond it (reject, clamp, re-arm chain) |
| Lap disambiguation | store the absolute tick in the node and validate on expiry |
| Cascading | when level-0 index wraps, cascade level 1 …; amortized O(1), bursty per tick |
| Skipped ticks | `advance_to` walks every intervening tick — bound it or use a coarse fast path |
| Per-bucket order | insertion order (LIFO here); make it FIFO if determinism matters |

**Traps** — "O(1) wheel" hides O(B) per bucket and O(elapsed ticks) after a stall · a wheel without absolute-tick validation fires a next-lap timer early · `priority_queue` has no `erase`, so cancellation must be lazy or the container replaced · mutating a heap element's deadline in place breaks the invariant silently · comparator must be a strict weak ordering and must not read mutable state.

---

## 41.3 Busy polling, blocking waits, and hybrid spin strategies

| Strategy | Wake latency | Cost when idle | Failure mode |
|---|---|---|---|
| busy spin on `now()` | ~tens of ns | one core at 100 % | starves siblings, thermal/frequency throttling |
| spin + `pause`/`yield` | ~100 ns–µs | full core, friendlier SMT | no timing guarantee at all |
| `cv.wait_until` | ~µs–ms (scheduler) | ~0 | lost wakeup if predicate protocol is wrong |
| `atomic::wait` | ~µs | ~0 | **no timed overload in C++23** |
| hybrid spin-then-block | low for short idles | bounded | tuning, double-check race at the transition |

```cpp
// ---- Waiter concept used by the loop in 41.6 ---------------------------
#include <condition_variable>
#include <mutex>
#include <stop_token>
#include <thread>
#include <atomic>

// Every waiter must satisfy: wait_until(deadline, stop_token) returns when
// (a) the deadline passed, (b) state changed, or (c) stop was requested.
```

```cpp
// ---- 1. blocking waiter, stop-aware (correct shape) --------------------
class CvWaiter {
public:
    void wait_until(TimePoint deadline, std::stop_token st) {
        std::unique_lock lock{m_};
        // C++20 stop-aware overload: registers/unregisters the stop_callback
        // internally, so a stop request that arrives *before* the wait cannot
        // deadlock on m_ the way a hand-rolled stop_callback would.
        cv_.wait_until(lock, st, deadline, [&] { return signalled_; });
        signalled_ = false;                    // predicate loop absorbs spurious wakeups
    }
    void signal() {                            // called by producers of new work
        { std::lock_guard g{m_}; signalled_ = true; }  // publish state FIRST
        cv_.notify_one();                              // then notify
    }
private:
    std::mutex m_;
    std::condition_variable_any cv_;           // _any is required for the stop_token overloads
    bool signalled_{false};
};
// wait_until(lock, tp, pred) == while (!pred()) if (wait_until(lock,tp)==timeout) return pred();
// It returns pred(): false means "timed out and still not ready".
```

```cpp
// ---- 2. pure spin waiter ----------------------------------------------
class SpinWaiter {
public:
    void wait_until(TimePoint deadline, std::stop_token st) {
        while (Clock::now() < deadline && !st.stop_requested()
               && !flag_.load(std::memory_order_acquire)) {
#if defined(__x86_64__)
            __builtin_ia32_pause();            // PAUSE: SMT-friendly spin hint
#elif defined(__aarch64__)
            __asm__ __volatile__("yield");
#endif
        }
        flag_.store(false, std::memory_order_release);
    }
    void signal() noexcept { flag_.store(true, std::memory_order_release); }
private:
    std::atomic<bool> flag_{false};
};
```

```cpp
// ---- 3. hybrid: spin a bounded window, then block ----------------------
class HybridWaiter {
public:
    explicit HybridWaiter(Duration spin_budget = std::chrono::microseconds{50})
        : spin_{spin_budget} {}

    void wait_until(TimePoint deadline, std::stop_token st) {
        auto const spin_until = std::min(deadline, Clock::now() + spin_);
        while (Clock::now() < spin_until) {
            if (ready(st)) return;             // fast path: no syscall at all
            std::this_thread::yield();
        }
        if (Clock::now() >= deadline) return;
        std::unique_lock lock{m_};
        cv_.wait_until(lock, st, deadline, [&] { return signalled_; });
        signalled_ = false;                    // re-check under the lock: no lost wakeup
    }
    void signal() {
        { std::lock_guard g{m_}; signalled_ = true; }
        cv_.notify_one();
    }
private:
    bool ready(std::stop_token const& st) {
        std::lock_guard g{m_};
        if (st.stop_requested()) return true;
        return std::exchange(signalled_, false);   // consume, or the next wait returns instantly
    }
    Duration spin_;
    std::mutex m_;
    std::condition_variable_any cv_;
    bool signalled_{false};
};
```

```cpp
// ---- 4. atomic wait/notify (C++20) — untimed --------------------------
std::atomic<std::uint64_t> wake_epoch_{0};

void wait_for_change() {
    auto observed = wake_epoch_.load(std::memory_order_acquire);
    wake_epoch_.wait(observed, std::memory_order_acquire);   // blocks while == observed
}
void wake_all() {
    wake_epoch_.fetch_add(1, std::memory_order_release);     // epoch, not bool: no ABA
    wake_epoch_.notify_all();                                // or notify_one()
}
// There is NO wait_until/wait_for on std::atomic in C++23; combine with a
// platform futex timeout, a cv, or a timerfd/kqueue timer.
```

| API | Header | Semantics |
|---|---|---|
| `cv.wait(lk, pred)` | `<condition_variable>` | loops `while(!pred()) wait(lk)` |
| `cv.wait_until(lk, tp)` | | returns `cv_status::timeout` / `no_timeout`; may wake spuriously |
| `cv.wait_until(lk, tp, pred)` | | returns `pred()`; `false` ⇒ timed out and not ready |
| `cv.wait_for(lk, d, pred)` | | equivalent to `wait_until(steady_clock::now()+d)` |
| `cv.notify_one/all()` | | **not** stored: a notify with no waiter is lost — the predicate is the truth |
| `std::condition_variable_any` | | works with any Lockable; has `wait*(lk, stop_token, pred)` overloads |
| `a.wait(old, mo)` / `notify_one/all()` | `<atomic>` | C++20, untimed, no mutex, per-object wait set |
| `std::this_thread::yield()` | `<thread>` | scheduler hint, no ordering, no timing guarantee |

```cpp
// ---- condition_variable_any: stop-aware wait, no manual stop_callback --
std::condition_variable_any cva;
std::mutex m;
{
    std::unique_lock lk{m};
    bool woken = cva.wait(lk, st, [&]{ return has_work; });   // C++20 overload
    // returns false iff stop was requested and the predicate is still false
}
```

**Traps** — notifying without mutating the predicate state loses the wakeup · holding the mutex across the callback dispatch serializes producers · `wait_for` restarts its duration on every spurious wake (use `wait_until` with an absolute deadline) · a `stop_callback` runs on the *requesting* thread and must not deadlock on a mutex the loop holds while calling `request_stop` · spinning inside a container/VM burns your CPU quota · `notify_one` with several distinct predicates can wake the wrong waiter — use `notify_all` or separate CVs.

---

## 41.4 Cancellation and generation-safe timer handles

```cpp
// ---- the handle -------------------------------------------------------
struct TimerId {
    std::uint32_t index{};        // slot in a fixed pool
    std::uint32_t generation{};   // bumped on every (re)acquisition — rejects recycled slots
    friend constexpr bool operator==(TimerId, TimerId) noexcept = default;
    [[nodiscard]] constexpr explicit operator bool() const noexcept { return generation != 0; }
};
inline constexpr TimerId kNoTimer{};

enum class CancelResult : std::uint8_t {
    cancelled,          // was armed; it will not run
    already_fired,      // one-shot completed before the request
    already_cancelled,  // duplicate request
    stale,              // generation mismatch: slot was recycled — handle is a lie
    queued              // accepted by a cross-thread command queue; not yet linearized
};
```

```cpp
// ---- complete indexed-heap timer queue --------------------------------
#include <functional>          // std::move_only_function (C++23)
#include <cassert>

class TimerQueue {
public:
    using Callback = std::move_only_function<void()>;   // C++23; or a CallbackId into a table

    explicit TimerQueue(std::uint32_t capacity) : slots_(capacity) {
        heap_.reserve(capacity);
        for (std::uint32_t i = 0; i + 1 < capacity; ++i) slots_[i].next_free = i + 1;
        if (capacity) slots_[capacity - 1].next_free = npos;
        free_head_ = capacity ? 0 : npos;
    }

    [[nodiscard]] TimerId arm_at(TimePoint deadline, Callback cb) {
        return arm(deadline, Duration::zero(), std::move(cb));
    }
    [[nodiscard]] TimerId arm_after(TimePoint now, Duration d, Callback cb) {
        return arm(now + d, Duration::zero(), std::move(cb));
    }
    [[nodiscard]] TimerId arm_every(TimePoint first, Duration period, Callback cb) {
        assert(period > Duration::zero());
        return arm(first, period, std::move(cb));
    }

    CancelResult cancel(TimerId id) noexcept {
        if (id.index >= slots_.size()) return CancelResult::stale;
        Slot& s = slots_[id.index];
        if (s.generation != id.generation) return CancelResult::stale;
        switch (s.state) {
            case State::armed:
                heap_erase(s.heap_pos);
                retire(id.index, State::cancelled);
                return CancelResult::cancelled;
            case State::firing:                    // self-cancel from inside its own callback
                s.state = State::firing_cancelled; // suppresses the repeat re-insert
                return CancelResult::cancelled;
            case State::firing_cancelled:
            case State::cancelled:
                return CancelResult::already_cancelled;
            case State::free:
                return CancelResult::already_fired; // generation still matches ⇒ it ran
        }
        return CancelResult::stale;
    }

    [[nodiscard]] bool empty() const noexcept { return heap_.empty(); }
    [[nodiscard]] std::size_t size() const noexcept { return heap_.size(); }
    [[nodiscard]] TimePoint next_deadline() const noexcept {
        return heap_.empty() ? TimePoint::max() : slots_[heap_.front()].deadline;
    }

    // Returns the number of callbacks dispatched. `budget` bounds the burst.
    std::size_t expire_due(TimePoint now, std::size_t budget = 64) {
        std::size_t fired = 0;
        while (fired < budget && !heap_.empty()) {
            std::uint32_t const i = heap_.front();
            Slot& s = slots_[i];
            if (s.deadline > now) break;                  // '<=' is due, '>' is not
            heap_pop_front();                             // detach BEFORE the callback runs
            s.heap_pos = npos;
            s.state = State::firing;
            std::uint32_t const gen = s.generation;
            TimePoint const scheduled = s.deadline;

            s.callback();                                 // may arm/cancel anything, incl. itself
            ++fired;

            assert(s.generation == gen);                  // slot cannot be recycled while firing
            bool const cancelled = (s.state == State::firing_cancelled);
            if (!cancelled && s.period > Duration::zero()) {
                s.deadline = next_periodic(scheduled, s.period, now);   // fixed-rate + coalesce
                s.seq = ++sequence_;
                s.state = State::armed;
                heap_push(i);
            } else {
                retire(i, State::free);                   // generation bumps at next acquire
            }
        }
        return fired;
    }

private:
    static constexpr std::uint32_t npos = 0xFFFF'FFFFu;
    // free/cancelled both sit on the free list; they differ only in what a
    // later cancel() with the SAME generation reports.
    enum class State : std::uint8_t { free, cancelled, armed, firing, firing_cancelled };

    struct Slot {
        TimePoint     deadline{};
        Duration      period{};
        Callback      callback{};
        std::uint64_t seq{};
        std::uint32_t generation{0};
        std::uint32_t heap_pos{npos};
        std::uint32_t next_free{npos};
        State         state{State::free};
    };

    TimerId arm(TimePoint deadline, Duration period, Callback cb) {
        if (free_head_ == npos) return kNoTimer;          // capacity exhausted — caller must check
        std::uint32_t const i = free_head_;
        Slot& s = slots_[i];
        free_head_ = s.next_free;
        ++s.generation;                                   // acquisition bumps: old handles go stale
        if (s.generation == 0) ++s.generation;            // 0 reserved for kNoTimer
        s.deadline = deadline;  s.period = period;  s.callback = std::move(cb);
        s.seq = ++sequence_;  s.state = State::armed;  s.next_free = npos;
        heap_push(i);
        return TimerId{i, s.generation};
    }
    void retire(std::uint32_t i, State reason) noexcept {
        Slot& s = slots_[i];
        s.state = reason;                                 // free (ran) or cancelled
        s.callback = nullptr;                             // release captured resources NOW
        s.heap_pos = npos;
        s.next_free = free_head_;
        free_head_ = i;
    }
    static TimePoint next_periodic(TimePoint scheduled, Duration period, TimePoint now) noexcept {
        TimePoint next = scheduled + period;
        if (next <= now) {                                // stalled: coalesce missed intervals
            auto const missed = (now - scheduled) / period;
            next = scheduled + (missed + 1) * period;
        }
        return next;
    }

    // ---- indexed min-heap over slot indices; slots_[i].heap_pos is the inverse map
    bool earlier(std::uint32_t a, std::uint32_t b) const noexcept {
        Slot const& x = slots_[a];  Slot const& y = slots_[b];
        return x.deadline != y.deadline ? x.deadline < y.deadline : x.seq < y.seq;
    }
    void place(std::uint32_t pos, std::uint32_t i) noexcept {
        heap_[pos] = i;  slots_[i].heap_pos = pos;
    }
    void sift_up(std::uint32_t pos) noexcept {
        std::uint32_t const i = heap_[pos];
        while (pos != 0) {
            std::uint32_t const p = (pos - 1) / 2;
            if (!earlier(i, heap_[p])) break;
            place(pos, heap_[p]);  pos = p;
        }
        place(pos, i);
    }
    void sift_down(std::uint32_t pos) noexcept {
        auto const n = static_cast<std::uint32_t>(heap_.size());
        std::uint32_t const i = heap_[pos];
        for (;;) {
            std::uint32_t c = 2 * pos + 1;
            if (c >= n) break;
            if (c + 1 < n && earlier(heap_[c + 1], heap_[c])) ++c;
            if (!earlier(heap_[c], i)) break;
            place(pos, heap_[c]);  pos = c;
        }
        place(pos, i);
    }
    void heap_push(std::uint32_t i) {
        heap_.push_back(i);
        slots_[i].heap_pos = static_cast<std::uint32_t>(heap_.size() - 1);
        sift_up(static_cast<std::uint32_t>(heap_.size() - 1));
    }
    void heap_erase(std::uint32_t pos) noexcept {         // O(log T) arbitrary erase
        auto const last = static_cast<std::uint32_t>(heap_.size() - 1);
        if (pos != last) {
            place(pos, heap_[last]);
            heap_.pop_back();
            sift_down(pos);                               // one of these two is a no-op
            sift_up(pos);
        } else {
            heap_.pop_back();
        }
    }
    void heap_pop_front() noexcept { heap_erase(0); }

    std::vector<Slot>          slots_;
    std::vector<std::uint32_t> heap_;
    std::uint32_t              free_head_{npos};
    std::uint64_t              sequence_{0};
};
```

| Cancellation linearization point | Guarantee | Cost |
|---|---|---|
| command enqueued | request accepted; callback may still run | O(1), lock-free possible |
| loop dequeued & applied | callback will **not start** afterwards | one loop turn of latency |
| join-style cancel | returns only after any running callback finished | may block; deadlocks if called *from* the callback |

```cpp
// ---- rearm without ABA -------------------------------------------------
// WRONG: mutate the deadline of a slot already in the heap.
//   slots_[id.index].deadline = new_deadline;      // heap invariant now broken
// RIGHT (indexed heap):
void rearm(TimerId id, TimePoint when);   // set deadline, then sift_up+sift_down its heap_pos
// RIGHT (lazy heap): push a NEW entry carrying (deadline, seq, index, generation)
//   and let the old entry fail validation on pop:
//   if (e.generation != slots_[e.index].generation || slots_[e.index].deadline != e.deadline)
//       continue;   // stale
```

**Traps** — recycling a slot while a lazy heap entry still names it makes a cancelled timer fire as a *different* timer · a generation of 0 must be reserved or `kNoTimer` compares equal to a live slot · destroying the queue while callbacks own resources leaks unless `retire` clears the callback · `assert(s.generation == gen)` after the callback is real: never let a callback free the firing slot · returning `stale` and `already_fired` from the same code path hides bugs · generation wrap is ABA — 32 bits at 10⁶ arms/s wraps in ~70 min per slot, so size the field or define a terminal wrap.

---

## 41.5 Drift, deadline versus interval scheduling, and catch-up behavior

```text
fixed delay :  next = time_after_callback_returns + period    → no burst, drifts
fixed rate  :  next = previous_DEADLINE          + period     → phase-stable, can be in the past
```

```cpp
// ---- the four missed-interval policies ---------------------------------
enum class MissPolicy : std::uint8_t { catch_up, coalesce, skip, fail };

struct Repeat {
    TimePoint scheduled;     // the deadline this activation was *supposed* to have
    Duration  period;
    MissPolicy policy;
};

// Returns {next_deadline, extra_immediate_fires}.
struct NextFire { TimePoint next; std::uint64_t missed; };

inline NextFire advance_periodic(Repeat r, TimePoint now) {
    assert(r.period > Duration::zero());                 // division precondition
    TimePoint next = r.scheduled + r.period;             // fixed rate
    if (next > now) return {next, 0};
    auto const missed = static_cast<std::uint64_t>((now - r.scheduled) / r.period);
    switch (r.policy) {
        case MissPolicy::catch_up:                       // fire once per missed interval
            return {next, 0};                            // leave `next` in the past; loop re-enters
        case MissPolicy::coalesce:                       // one fire, report the count
            return {r.scheduled + r.period * static_cast<Duration::rep>(missed + 1), missed};
        case MissPolicy::skip:                           // silently jump to the next future slot
            return {r.scheduled + r.period * static_cast<Duration::rep>(missed + 1), 0};
        case MissPolicy::fail:
            throw std::runtime_error("timer overrun");   // or disable the timer
    }
    return {next, 0};
}
```

```cpp
// ---- fixed delay: measure AFTER the callback ---------------------------
timer.callback();
auto const completed = clock.now();          // NOT the pre-callback `now`
timer.deadline = completed + timer.period;   // literal fixed-delay semantics
```

```cpp
// ---- checked multiply: (missed+1)*period can overflow the rep ----------
constexpr bool mul_overflows(Duration::rep n, Duration::rep period_count) noexcept {
    return n != 0 && period_count > Duration::max().count() / n;   // 2^63 ns ≈ 292 years
}
```

| Policy | Burst | Phase | Use when |
|---|---|---|---|
| `catch_up` | unbounded after a stall | preserved exactly | accounting ticks that must all be produced |
| `coalesce` | one fire + `missed` count | preserved | heartbeats, metrics flush, market snapshots |
| `skip` | one fire | preserved | pure sampling where history is irrelevant |
| `fail` | none | n/a | latency SLOs where lateness is an incident |
| fixed delay | none by construction | drifts by callback runtime | polling loops, backoff, retry |

```cpp
// ---- exponential backoff with jitter (a timer, not a sleep) -----------
Duration backoff(std::uint32_t attempt, Duration base, Duration cap,
                 std::uint64_t rnd) noexcept {
    auto const shift = std::min<std::uint32_t>(attempt, 30);
    auto d = base * (Duration::rep{1} << shift);       // duration * rep, never duration * duration
    if (d > cap) d = cap;
    return Duration{static_cast<Duration::rep>(rnd % static_cast<std::uint64_t>(d.count()) + 1)};
    // full jitter: uniform in (0, d]; decorrelated jitter is the other common choice
}
```

**Traps** — dividing by a zero or negative period is UB/nonsense — validate at arm time · `missed * period` overflows a 64-bit nanosecond rep for large periods · fixed-rate + `catch_up` after a GC pause or a debugger breakpoint is the classic timer storm · measuring "completion" before the callback silently converts fixed-delay into fixed-rate · a repeating timer that re-arms into an exhausted pool must have a defined outcome (drop, error, or reserved slot — reusing its own slot is the fix).

---

## 41.6 Single-threaded event-loop ownership

```text
producer threads ──bounded MPSC command queue──► loop thread (sole mutator)
                                                    │
   drain commands → now = clock.now() → expire timers (budget) → poll I/O → wait_until
```

```cpp
// ---- full loop skeleton, clock/waiter injected -------------------------
#include <deque>

template<class ClockT, class WaiterT>
class EventLoop {
public:
    using Command = std::move_only_function<void()>;    // executed ON the loop thread

    EventLoop(ClockT& clock, WaiterT& waiter, std::uint32_t timer_capacity,
              std::size_t command_capacity)
        : clock_{clock}, waiter_{waiter}, timers_{timer_capacity},
          command_capacity_{command_capacity} {}

    // --- called from ANY thread ------------------------------------------
    bool post(Command c) {                              // false ⇒ backpressure or shutting down
        {
            std::lock_guard g{m_};
            if (closed_ || commands_.size() >= command_capacity_) return false;
            commands_.push_back(std::move(c));
        }
        waiter_.signal();                               // mutate state, THEN notify
        return true;
    }

    // --- called ONLY on the loop thread ----------------------------------
    TimerQueue& timers() noexcept { return timers_; }

    void run(std::stop_token st) {
        while (!st.stop_requested()) {
            drain_commands();
            auto const now = clock_.now();              // ONE clock read per turn
            timers_.expire_due(now, kExpiryBudget);     // bounded burst → I/O cannot starve
            poll_io(now);
            if (st.stop_requested()) break;
            if (has_pending_commands()) continue;       // a command may have armed something earlier
            waiter_.wait_until(next_wakeup(), st);
        }
        shutdown();
    }

    void run_once(TimePoint now) {                      // deterministic single turn, for tests
        drain_commands();
        timers_.expire_due(now, kExpiryBudget);
        poll_io(now);
    }
    [[nodiscard]] TimePoint next_wakeup() const noexcept { return timers_.next_deadline(); }

private:
    static constexpr std::size_t kExpiryBudget = 64;

    void drain_commands() {
        std::deque<Command> batch;
        { std::lock_guard g{m_}; batch.swap(commands_); }   // batch: one lock per turn
        for (auto& c : batch) {
            try { c(); }
            catch (...) { on_callback_exception(); }         // never let a command kill the loop
        }
    }
    bool has_pending_commands() { std::lock_guard g{m_}; return !commands_.empty(); }
    void poll_io(TimePoint) {}                              // epoll/kqueue/io_uring lives here
    void on_callback_exception() noexcept {}
    void shutdown() {
        { std::lock_guard g{m_}; closed_ = true; commands_.clear(); }
        // policy: cancel all timers, or run due ones once, then release resources
    }

    ClockT&  clock_;
    WaiterT& waiter_;
    TimerQueue timers_;
    std::mutex m_;
    std::deque<Command> commands_;
    std::size_t command_capacity_;
    bool closed_{false};
};
```

| Property | Single-owner loop gives you | And costs you |
|---|---|---|
| Mutation | no locks inside component state machines | one slow callback blocks everything |
| Ordering | deterministic at the dequeue boundary | producers need bounded queues + backpressure policy |
| Lifetime | objects die on the loop thread only | cross-thread queries need a reply channel (deadlock risk) |
| Reentrancy | callbacks never run concurrently | nested `run_once()` reorders events — forbid it |
| Fairness | explicit budgets per source | you must write the policy; there is no default |

```cpp
// ---- callback discipline ----------------------------------------------
// 1. bounded work; offload anything long to a worker pool
// 2. no blocking syscalls, no unbounded allocation, no locks held across dispatch
// 3. exceptions: catch at the boundary or declare the callback noexcept
// 4. never call run()/run_once() from inside a callback (re-entrancy)
// 5. results come back via post(), never by mutating loop state from the worker

pool.submit([this, req = std::move(req)]() mutable {
    auto result = expensive(std::move(req));
    loop.post([this, result = std::move(result)]() mutable { deliver(std::move(result)); });
});
// The completion lambda must not capture raw pointers to objects the loop may
// have destroyed — capture a weak handle/generation id and validate on the loop.
```

**Traps** — `post()` from inside a callback then blocking on the result is a self-deadlock · unbounded command queues turn producer pressure into unbounded latency and memory · signalling the waiter *before* publishing the state is a lost wakeup · draining commands under the lock lets a callback re-enter `post` and deadlock — swap out a batch first · a callback that arms an already-due timer will fire it in the *next* turn only if you break out of the expiry loop by budget.

---

## 41.7 Stop tokens and deterministic shutdown

```cpp
#include <stop_token>
#include <thread>

std::stop_source src;
std::stop_token  tok = src.get_token();
bool ok  = src.request_stop();       // true iff THIS call performed the transition
bool req = tok.stop_requested();     // observable by all tokens/sources sharing the state
bool can = tok.stop_possible();      // false for a default-constructed token
std::stop_source nsrc{std::nostopstate};   // never stoppable; stop_possible() == false

{
    std::stop_callback cb{tok, [] { /* wake the waiter */ }};
    // - runs IMMEDIATELY on the registering thread if stop was ALREADY requested
    // - otherwise runs on the thread calling request_stop()
    // - destructor blocks until an in-flight invocation of THIS callback completes
    // - callbacks run in unspecified order; must be non-throwing in practice
}   // deregistered here
```

```cpp
// ---- jthread: the member-order trap ------------------------------------
class Service {
public:
    Service()
        : loop_{clock_, waiter_, 1024, 4096},
          thread_{[this](std::stop_token st) { loop_.run(st); }} {}   // ctor gets the token

    ~Service() {
        thread_.request_stop();      // 1. cooperative signal
        waiter_.signal();            // 2. wake it even without a stop_callback
        if (thread_.joinable()) thread_.join();   // 3. join BEFORE members die
    }
private:
    SteadyClock  clock_;             // declared FIRST  → destroyed LAST
    CvWaiter     waiter_;
    EventLoop<SteadyClock, CvWaiter> loop_;
    std::jthread thread_;            // declared LAST   → destroyed FIRST (joins first)
};
// jthread's destructor does request_stop() then join(). If the thread were
// declared first it would be destroyed LAST — after loop_ and waiter_ are gone.
```

```text
deterministic shutdown sequence
1  close command acceptance          (post() starts returning false)
2  request_stop() + wake the waiter  (stop alone unblocks nothing)
3  apply pending-timer policy        (cancel all | run due once | drop silently)
4  resolve outstanding handles       (they must report cancelled/stale, not fire)
5  release callback-owned resources  (clear std::move_only_function slots)
6  join the loop thread
7  destroy timers, queue, waiter, clock — in reverse construction order
```

| Question | Default answer to state out loud |
|---|---|
| Do pending timers fire at shutdown? | **No** — destroying a timer is not an expiry event |
| Do queued commands run? | Policy: drain-then-stop or drop-and-report |
| Can `request_stop` be called from a callback? | Yes; the loop must not join itself |
| Does `stop_token` abort a blocking syscall? | No — only a registered `stop_callback` that writes an eventfd/pipe can |
| Is `request_stop` idempotent? | Yes; only the first call returns `true` |

**Traps** — a `stop_callback` capturing `this` must be destroyed before `this` · `stop_callback`'s destructor blocks on an in-flight invocation — never destroy it while holding a mutex that the callback takes · `jthread` declared before its dependencies destroys them out from under a running loop · calling `join()` from the loop thread is `resource_deadlock_would_occur` · a detached loop thread outliving `main` touches destroyed statics.

---

## 41.8 Test clocks and reproducible time-dependent code

```cpp
// ---- a Clock-conforming manual clock -----------------------------------
class ManualClock {
public:
    using duration   = std::chrono::nanoseconds;
    using rep        = duration::rep;
    using period     = duration::period;
    using time_point = std::chrono::time_point<ManualClock, duration>;
    static constexpr bool is_steady = true;          // it never goes backward: we control it

    [[nodiscard]] time_point now() const noexcept { return now_; }
    void advance(duration d) noexcept { assert(d >= duration::zero()); now_ += d; }
    void set(time_point t) noexcept { assert(t >= now_); now_ = t; }
private:
    time_point now_{};
};
// Note: a *static* now() would satisfy the Cpp17Clock requirement, but an
// injectable clock must be an OBJECT — hence the loop template parameter.

class SteadyClock {                                   // production adapter, same shape
public:
    using time_point = Clock::time_point;
    [[nodiscard]] time_point now() const noexcept { return Clock::now(); }
};
```

```cpp
// ---- a manual waiter: records the request, returns instantly -----------
class ManualWaiter {
public:
    void wait_until(TimePoint deadline, std::stop_token) { last_deadline_ = deadline; ++waits_; }
    void signal() noexcept { ++signals_; }
    [[nodiscard]] TimePoint last_deadline() const noexcept { return last_deadline_; }
    [[nodiscard]] std::size_t waits() const noexcept { return waits_; }
    [[nodiscard]] std::size_t signals() const noexcept { return signals_; }
private:
    TimePoint   last_deadline_{TimePoint::max()};
    std::size_t waits_{}, signals_{};
};
```

```cpp
// ---- deterministic test: order, ties, cancel, stale, repeat ------------
#include <string>
#include <vector>

void test_timer_queue() {
    TimePoint const t0{};
    TimerQueue q{16};
    std::vector<std::string> trace;

    auto b = q.arm_at(t0 + 20ms, [&] { trace.emplace_back("b"); });
    auto a = q.arm_at(t0 + 10ms, [&] { trace.emplace_back("a"); });
    auto c = q.arm_at(t0 + 20ms, [&] { trace.emplace_back("c"); });   // tie with b, armed later

    assert(q.next_deadline() == t0 + 10ms);
    assert(q.expire_due(t0 +  9ms) == 0);      // strictly before  → nothing
    assert(q.expire_due(t0 + 10ms) == 1);      // exactly equal    → due
    assert(q.expire_due(t0 + 20ms) == 2);      // b before c: insertion-sequence tie-break
    assert((trace == std::vector<std::string>{"a", "b", "c"}));

    assert(q.cancel(a) == CancelResult::already_fired);   // gen still matches, slot free
    (void)b; (void)c;

    auto d = q.arm_at(t0 + 30ms, [] {});
    assert(q.cancel(d) == CancelResult::cancelled);
    assert(q.cancel(d) == CancelResult::already_cancelled);   // same generation, cancelled state
    assert(q.empty());

    // repeating, fixed rate, coalescing a 99-period stall into ONE fire
    int ticks = 0;
    auto r = q.arm_every(t0 + 1ms, 1ms, [&] { ++ticks; });
    q.expire_due(t0 + 100ms);
    assert(ticks == 1);                        // coalesce, not 99 catch-up callbacks
    assert(q.next_deadline() == t0 + 101ms);   // phase preserved: still on the 1ms grid
    assert(q.cancel(r) == CancelResult::cancelled);
}
```

```cpp
// ---- self-cancel and self-rearm from inside the callback ---------------
void test_reentrancy() {
    TimerQueue q{8};
    TimerId self{};
    int n = 0;
    TimePoint const t0{};
    self = q.arm_every(t0 + 1ms, 1ms, [&] {
        if (++n == 3) q.cancel(self);          // firing → firing_cancelled: no re-insert
    });
    for (int i = 1; i <= 4; ++i) q.expire_due(t0 + std::chrono::milliseconds{i});
    assert(n == 3 && q.empty());
}
```

**Checklist — the cases an interviewer wants named**

| Case | Assertion |
|---|---|
| deadline `now-1`, `now`, `now+1` | fires, fires, does not fire |
| two timers, equal deadline | insertion order, every run |
| cancel armed / after fire / twice / stale generation | `cancelled` / `already_fired` / `already_cancelled` / `stale` |
| rearm earlier and later | `next_deadline()` updates; heap invariant holds |
| callback arms a new timer | fires next turn, not this one (budget/`break` rule) |
| callback exhausts capacity | `arm` returns `kNoTimer`; no UB, no silent drop |
| fixed-rate after a 10-period stall | `coalesce` → 1 fire; `catch_up` → 10 |
| `Duration::max()` / `TimePoint::max()` deadlines | no overflow, sorts last |
| new earliest timer while blocked | waiter signalled; `last_deadline()` shrinks |
| stop while idle / mid-callback | no callback starts after stop is applied |
| repeated runs of the same script | identical trace vector |

```cpp
// ---- coarse real-clock liveness test (the only place time may pass) ----
auto const t_start = Clock::now();
service.wait_for_first_tick();
auto const elapsed = Clock::now() - t_start;
assert(elapsed < 500ms);        // generous upper bound only; NEVER assert a lower bound
```

**Interview line** — "I inject a clock object and a waiter object, so the unit test advances time explicitly and executes exact loop turns; the only thing a real `steady_clock` test may assert is a generous upper bound on liveness."

---

**Cost ledger**

| Path | Intended work | Accidental tail |
|---|---|---|
| `arm` | acquire slot + O(log T) sift | allocation, heap/vector growth, node allocation |
| `cancel` | generation check + O(log T) erase | O(T) scan, tombstone accumulation |
| `expire` | compare + pop + dispatch | stale-entry burst, unbounded catch-up, slow callback |
| `idle` | one `wait_until` | a syscall per microsecond of idleness |
| cross-thread `post` | bounded enqueue + one signal | contended lock, notification storm |
| clock read | one `now()` per turn | one `now()` per timer |

```text
deadline   steady_clock::time_point; typed durations, absolute deadlines, '<=' is due
order      (deadline, insertion_sequence) — total order or no determinism
storage    fixed slot pool + generation; ordering structure holds indices only
heap       O(log T) arm/pop; indexed heap ⇒ O(log T) cancel/rearm; lazy ⇒ validate on pop
wheel      O(1) bucket, O(B) expiry, fixed resolution + horizon + cascade
cancel     define linearization: queued | prevents start | waits for completion
repeat     fixed delay drifts; fixed rate needs catch_up | coalesce | skip | fail
idle       spin | yield | block | hybrid; predicate under mutex prevents lost wakeups
loop       one owner, bounded commands, bounded expiry budget, no reentrancy
stop       cooperative: close, request_stop, wake, apply policy, join, destroy
test       manual clock + manual waiter, exact boundaries, stale handles, no sleeps
```
