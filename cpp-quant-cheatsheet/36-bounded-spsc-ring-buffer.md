# 36. Bounded SPSC ring buffer

*Part VI-A — Quant blueprints: types, codecs, and core structures*

---

**Recall**
- SPSC means *exactly* one producer thread and *exactly* one consumer thread — "usually one producer" is not SPSC and the API must make the extra caller impossible.
- Correctness comes from exclusive **cursor ownership** plus exclusive **slot ownership**, not from the indices merely being atomic.
- Producer alone writes `write_`; consumer alone writes `read_`; each side only *loads* the other's counter.
- Owner-side loads are `relaxed` (already sequenced in that thread); cross-owner loads that authorize access or reuse are `acquire`.
- Producer: construct payload → `write_.store(w+1, release)`; consumer: `write_.load(acquire)` → read payload — that edge makes construction happen-before use.
- Consumer: use → destroy → `read_.store(r+1, release)`; producer: `read_.load(acquire)` → reconstruct — that edge stops reuse of a live slot.
- Monotonic 64-bit unsigned counters give all `Capacity` slots: empty is `w == r`, full is `w - r == Capacity` (modular subtraction).
- A spare-slot design stores wrapped indices instead and costs one usable slot (`N-1`); a count/phase-bit design costs extra synchronized state.
- Power-of-two capacity turns `% Capacity` into `& (Capacity-1)`; arbitrary capacity is legal but pays a division or a conditional subtract.
- Raw `alignas(T) std::byte[sizeof(T)]` slots + `construct_at`/`destroy_at` support move-only, non-default-constructible payloads and keep live ranges exact.
- `std::launder` is required when reading back a `T*` from the byte array after placement construction.
- Each side caches the opposite counter; a stale cache is only ever *conservative* (understates free space / available items) and is refreshed exactly at apparent full/empty.
- Put `write_` and `read_` on separate cache lines (`alignas(std::hardware_destructive_interference_size)`) or two cores ping-pong one line.
- If construction throws, `write_` was not advanced, so the logical queue is unchanged — never publish across an unconstructed slot.
- Batch ops amortize the shared-counter traffic: construct/consume `k` slots, then one release store of `+k`.
- Raw free slots are **not** live `T` objects — a raw-storage batch API cannot honestly hand out `span<T>` over them; use an emplacement lease.
- Unsigned wrap is defined and harmless while the occupancy invariant holds; signed counters would be UB and must never be used.
- Full is an application event: choose reject / spin / yield / block / drop / overwrite explicitly; never implement overwrite by letting the producer advance `read_`.
- Destroying, resetting, copying, or moving the queue while either thread runs is a lifetime bug regardless of memory order — delete copy and move.
- `fetch_add` does not upgrade this to MPMC: reservation and publication can complete out of order, so MPMC needs per-slot sequence/readiness state.

---

## 36.1 Capacity, mask, and power-of-two constraints

```cpp
#include <bit>          // std::has_single_bit, std::bit_ceil
#include <cstddef>
#include <cstdint>

template<std::size_t Capacity>
struct RingConstants {
    static_assert(Capacity >= 2, "capacity 1 makes producer and consumer lockstep");
    static_assert(std::has_single_bit(Capacity), "power of two for mask indexing"); // C++20
    static_assert(Capacity < (std::uint64_t{1} << 63), "occupancy must fit modularly");
    static constexpr std::uint64_t mask = Capacity - 1;
};

constexpr std::size_t want = 1000;
constexpr std::size_t cap  = std::bit_ceil(want);   // 1024 — round a request up (C++20)
static_assert(std::has_single_bit(cap));
static_assert(std::bit_width(cap - 1) == 10);       // log2 of the capacity
```

```cpp
// ---- physical index from a monotonic logical counter --------------------
std::uint64_t counter = 1'000'003;
auto slot_pow2 = counter & (Capacity - 1);   // 1 AND, no division, wrap is implicit
auto slot_any  = counter % Capacity;         // legal for any Capacity; constant divisor
// runtime (non-constexpr) capacity: compiler cannot strength-reduce % → keep a mask,
// or use the conditional-subtract form below.
std::size_t i = /*...*/;
i = (i + 1 == Capacity) ? 0 : i + 1;         // branchy successor, arbitrary capacity
```

| Capacity design | Index expression | Cost | Usable slots |
|---|---|---|---|
| Power of two + monotonic counters | `c & (N-1)` | one `and` | `N` |
| Arbitrary `N`, compile-time | `c % N` | mul/shift sequence | `N` |
| Arbitrary `N`, runtime | `c % N` | hardware divide (~20–40 cycles) | `N` |
| Arbitrary `N`, wrapped indices | `i+1==N?0:i+1` | predictable branch | `N` or `N-1` |

- Power-of-two capacity is an *algorithm choice* of this implementation, not a property of ring buffers.
- Masking a monotonic counter is safe across 2⁶⁴ wrap because `2⁶⁴ % Capacity == 0` when `Capacity` is a power of two.
- `Capacity == 1` is degenerate: the queue holds at most one item and both threads serialize on it — require `>= 2`.
- Slot padding to a cache line (`alignas(64) RawSlot`) is a separate decision from capacity; it trades footprint for zero payload false sharing.

**Traps** — `std::has_single_bit(0)` is `false` but `bit_ceil(0)` is `1` · masking a *wrapped index* with a non-power-of-two `N` silently corrupts · `Capacity - 1` in `std::size_t` on a 32-bit target still needs 64-bit counters · a capacity chosen larger than the working set only enlarges the cache footprint.

---

## 36.2 Producer/consumer ownership of indices

```text
producer thread                                   consumer thread
───────────────                                   ───────────────
writes  write_          (release stores)          writes  read_          (release stores)
reads   write_          (relaxed loads)           reads   read_          (relaxed loads)
reads   read_           (acquire loads)           reads   write_         (acquire loads)
owns    cached_read_    (plain uint64_t)          owns    cached_write_  (plain uint64_t)
owns    slot[w & mask]  while unpublished         owns    slot[r & mask]  while published
```

```cpp
// Ownership expressed in the type system: two disjoint state blocks.
struct ProducerState {
    std::atomic<std::uint64_t> write{0};  // producer stores, consumer acquire-loads
    std::uint64_t cached_read{0};         // producer-private, NON-atomic on purpose
};
struct ConsumerState {
    std::atomic<std::uint64_t> read{0};   // consumer stores, producer acquire-loads
    std::uint64_t cached_write{0};        // consumer-private, NON-atomic on purpose
};
```

**Invariants — state these before choosing memory orders**

```text
I1  0 <= write - read <= Capacity                    (modular unsigned arithmetic)
I2  logical range [read, write) is exactly the live, published elements
I3  only the producer constructs, and only at logical position write
I4  only the consumer reads/moves/destroys, and only at logical position read
I5  the producer publishes (advances write) only after construction completed
I6  the consumer releases (advances read) only after use AND destruction completed
I7  storage outlives both threads and every in-flight operation
I8  reset/clear/destructor never runs concurrently with push or pop
```

- Single producer ⇒ no producer-producer reservation CAS; the next `write` value is a private increment.
- Single consumer ⇒ no consumer-consumer claim CAS, and exactly one destructor call per element.
- The private cached counters are non-atomic *because* only their owning thread touches them — adding a second producer instantly makes `cached_read` a data race.
- Nothing in the algorithm prevents a *third* thread from calling `try_push`; enforce topology by construction (ownership handles, thread-id assert in debug builds).

```cpp
#ifndef NDEBUG
    std::thread::id producer_id_{};   // debug-only single-caller assertion
    assert(producer_id_ == std::thread::id{} || producer_id_ == std::this_thread::get_id());
#endif
```

**Traps** — "one producer at a time" (with a mutex) is MPSC, not SPSC, and still races the private cache unless the mutex spans it · shutdown helpers and buffer-return paths are extra producers/consumers · a queue exposed by `shared_ptr` invites a third caller.

---

## 36.3 Full/empty detection: spare slot versus monotonic counters

```cpp
// ---- monotonic counters (this chapter's design) ------------------------
bool empty = (write == read);
bool full  = (write - read == Capacity);      // unsigned modular difference
std::uint64_t size = write - read;            // 0 .. Capacity
std::uint64_t free = Capacity - (write - read);
std::size_t slot   = static_cast<std::size_t>(read & (Capacity - 1));
```

```cpp
// ---- spare-slot variant: wrapped indices only, N-1 usable --------------
template<class T, std::size_t N>
class SpareSlotRing {                       // T must be default-constructible here
    static_assert(std::has_single_bit(N));
    alignas(64) std::atomic<std::size_t> head_{0};   // next write index
    alignas(64) std::atomic<std::size_t> tail_{0};   // next read index
    std::array<T, N> slots_{};
public:
    bool try_push(T v) {
        auto const h = head_.load(std::memory_order_relaxed);
        auto const next = (h + 1) & (N - 1);
        if (next == tail_.load(std::memory_order_acquire)) return false;  // full
        slots_[h] = std::move(v);                                        // assign, not construct
        head_.store(next, std::memory_order_release);
        return true;
    }
    bool try_pop(T& out) {
        auto const t = tail_.load(std::memory_order_relaxed);
        if (t == head_.load(std::memory_order_acquire)) return false;     // empty
        out = std::move(slots_[t]);
        tail_.store((t + 1) & (N - 1), std::memory_order_release);
        return true;
    }
};
```

| Design | Empty test | Full test | Usable | Extra state | Notes |
|---|---|---|---|---|---|
| Spare slot | `head == tail` | `next(head) == tail` | `N-1` | none | simplest; wastes one slot |
| Monotonic counters | `w == r` | `w - r == N` | `N` | wider counters | this chapter |
| Shared count | `count == 0` | `count == N` | `N` | a third atomic | extra RMW contention |
| Phase/lap bit | index+phase equal | index equal, phase differs | `N` | 1 bit per cursor | equivalent to counters |
| Per-slot sequence | slot seq mismatch | slot seq mismatch | `N` | 1 word per slot | the MPMC (Vyukov) route |

- Wrapped indices alone are ambiguous at `head == tail`: it means both empty and full — that is the whole reason for the spare slot.
- Monotonic counters carry the "lap" implicitly in the high bits, so occupancy is a plain subtraction.
- `size()` sampled from two independently loaded counters is **advisory telemetry only** — it may correspond to no instantaneous state.

```cpp
// Advisory only — never branch on this for correctness.
[[nodiscard]] std::uint64_t size_approx() const noexcept {
    auto const w = producer_.write.load(std::memory_order_acquire);
    auto const r = consumer_.read.load(std::memory_order_acquire);
    return w - r;                 // may exceed Capacity if sampled skewed? no:
                                  // load w first then r ⇒ result is an over-estimate bound by Capacity
}
```

**Traps** — comparing `write < read` instead of `write - read` breaks at wrap · a shared `count` reintroduces a contended RMW the two-counter design avoided · using `size_approx()` to decide "there is room" bypasses the proof.

---

## 36.4 Acquire/release publication protocol

```text
producer                                    consumer
P1 construct payload bytes in slot[w&mask]
P2 write_.store(w+1, release) ───────────►  C1 write_.load(acquire) sees >= w+1
                     synchronizes-with      C2 read/move payload   (P1 happens-before C2)
                                            C3 destroy_at(payload)
P3 read_.load(acquire) sees >= r+1  ◄─────  C4 read_.store(r+1, release)
P4 construct into the reused slot            (C3 happens-before P4)
```

```cpp
// ---- every memory order that appears, and why --------------------------
producer_.write.load(std::memory_order_relaxed);   // owner load: value is thread-private already
consumer_.read .load(std::memory_order_acquire);   // authorizes REUSE of a slot
producer_.write.store(w + 1, std::memory_order_release); // publishes construction
consumer_.read .load(std::memory_order_relaxed);   // owner load
producer_.write.load(std::memory_order_acquire);   // authorizes ACCESS to a published slot
consumer_.read .store(r + 1, std::memory_order_release); // publishes destruction

// std::memory_order_seq_cst      // correct but adds an unneeded total order + fences
// std::memory_order_acq_rel      // only meaningful on read-modify-write ops
// std::memory_order_consume      // discouraged; treat as acquire
std::atomic_thread_fence(std::memory_order_release); // alternative: fence + relaxed store
```

- A release store synchronizes-with an acquire load **that reads that store's value or a later one in its modification order**.
- Because payload writes precede the release store, they are visible to any thread that acquire-observes it — that is why payload fields may be ordinary non-atomic memory.
- The two edges are independent: producer→consumer publishes *construction*, consumer→producer publishes *destruction*.
- Relaxed owner-side loads still participate in the modification order and are atomic; they merely add no cross-thread edge that the thread already has by sequencing.
- On x86 the release store is a plain `mov` and the acquire load a plain `mov`; on AArch64 they become `stlr`/`ldar` — an x86-only test proves nothing about ordering.
- `volatile` is not a synchronization tool: no atomicity, no happens-before, no race protection.

```cpp
// ---- fence formulation (equivalent, occasionally cheaper in batches) ----
std::construct_at(slot, args...);
std::atomic_thread_fence(std::memory_order_release);
producer_.write.store(w + 1, std::memory_order_relaxed);
// consumer side:
auto w = producer_.write.load(std::memory_order_relaxed);
std::atomic_thread_fence(std::memory_order_acquire);
```

**Traps** — storing the counter before constructing publishes garbage · advancing `read_` before `destroy_at` lets the producer reconstruct into a live object · `relaxed` everywhere keeps the counters atomic but publishes nothing · `seq_cst` everywhere does not replace the lifetime proof.

---

## 36.5 Cache-line separation and false-sharing avoidance

```cpp
#include <new>          // std::hardware_destructive_interference_size (C++17)

#ifdef __cpp_lib_hardware_interference_size
inline constexpr std::size_t cache_line = std::hardware_destructive_interference_size;
#else
inline constexpr std::size_t cache_line = 64;   // deployment assumption, not a guarantee
#endif

struct alignas(cache_line) ProducerState {
    std::atomic<std::uint64_t> write{0};
    std::uint64_t cached_read{0};
    char pad[cache_line - 2 * sizeof(std::uint64_t)]{};   // fill the trailing line
};
static_assert(alignof(ProducerState) >= 64);
static_assert(sizeof(ProducerState) % cache_line == 0);
```

```text
BAD                                   GOOD
┌──────── one 64B line ────────┐      ┌── line 0 ──┐ ┌── line 1 ──┐ ┌─ slots… ─┐
│ write_ │ read_ │  …          │      │ write_ …   │ │ read_ …    │ │          │
└──────────────────────────────┘      └────────────┘ └────────────┘ └──────────┘
producer store invalidates the         each core owns its own line in M state;
consumer's line every push → RFO        only the true handoff transfers it
ping-pong on every operation
```

- False sharing is a *performance* bug, not a correctness bug: the code is still correct, just 5–20× slower under load.
- `alignas` on the member types is what actually separates them; padding a struct without aligning it can still straddle a line.
- Pad the *trailing* bytes too, otherwise the next member (or an adjacent object) shares the line.
- Over-aligned queue objects need over-aligned storage: `new` and automatic storage honor complete-object alignment; a `std::vector<SpscRing>` element does too (C++17 aligned allocation).
- `hardware_destructive_interference_size` is 64 on most x86-64 and 64 or 128 on Apple/ARM server parts; some implementations warn about ABI stability, hence the `#ifdef`.
- Adjacent-line prefetching means two hot lines can still interfere on some Intel parts — 128-byte separation is a measurable tuning option.
- Do not over-pad blindly: 1024 queues × 256 bytes of padding is 256 KB of pure L2 pressure.

```cpp
// Verify the layout you think you have.
static_assert(offsetof(SpscRing<int,1024>, consumer_) - offsetof(SpscRing<int,1024>, producer_)
              >= cache_line);      // requires standard-layout; use in a test TU
```

**Traps** — cold statistics counters sharing the producer line reintroduce the ping-pong · `alignas` on a `std::atomic` member alone does not pad the tail · padding changes `sizeof` and can silently blow a fixed shared-memory layout.

---

## 36.6 Element lifetime in preallocated raw storage

```cpp
// ---- a slot is BYTES, not a T ------------------------------------------
template<class T>
struct RawSlot {
    alignas(T) std::byte bytes[sizeof(T)];

    [[nodiscard]] T* storage() noexcept {                       // for placement construction
        return reinterpret_cast<T*>(bytes);
    }
    [[nodiscard]] T* object() noexcept {                        // ONLY while a T is live there
        return std::launder(reinterpret_cast<T*>(bytes));
    }
};
static_assert(sizeof(RawSlot<std::uint64_t>) == 8);
static_assert(alignof(RawSlot<std::max_align_t>) >= alignof(std::max_align_t));
```

```cpp
#include <memory>       // construct_at, destroy_at, uninitialized_*
T* p = std::construct_at(slot.storage(), a, b);   // C++20: placement new, begins lifetime
::new (static_cast<void*>(slot.bytes)) T(a, b);   // pre-C++20 spelling, same effect
std::destroy_at(slot.object());                   // calls ~T(); ends lifetime
slot.object()->~T();                              // equivalent explicit spelling
std::destroy(first, last);                        // range form
std::uninitialized_move_n(src, n, slot.storage());// batch begin-lifetime from a range
```

### THE COMPLETE IMPLEMENTATION — type this from memory

```cpp
#include <array>
#include <atomic>
#include <bit>
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <new>
#include <optional>
#include <type_traits>
#include <utility>

template<class T, std::size_t Capacity>
class SpscRing {
    static_assert(Capacity >= 2);
    static_assert(std::has_single_bit(Capacity), "power-of-two capacity for mask indexing");
    static_assert(Capacity < (std::uint64_t{1} << 63));
    static_assert(std::is_nothrow_destructible_v<T>, "a throwing ~T cannot be sequenced safely");

    static constexpr std::uint64_t mask = Capacity - 1;

#ifdef __cpp_lib_hardware_interference_size
    static constexpr std::size_t cache_line = std::hardware_destructive_interference_size;
#else
    static constexpr std::size_t cache_line = 64;   // deployment assumption
#endif

    struct RawSlot {
        alignas(T) std::byte bytes[sizeof(T)];
        [[nodiscard]] T* storage() noexcept { return reinterpret_cast<T*>(bytes); }
        [[nodiscard]] T* object()  noexcept { return std::launder(reinterpret_cast<T*>(bytes)); }
    };

    struct alignas(cache_line) ProducerState {
        std::atomic<std::uint64_t> write{0};   // producer stores (release), consumer acquire-loads
        std::uint64_t cached_read{0};          // producer thread only — deliberately non-atomic
    };
    struct alignas(cache_line) ConsumerState {
        std::atomic<std::uint64_t> read{0};    // consumer stores (release), producer acquire-loads
        std::uint64_t cached_write{0};         // consumer thread only — deliberately non-atomic
    };

    ProducerState producer_{};
    ConsumerState consumer_{};
    alignas(cache_line) std::array<RawSlot, Capacity> slots_{};   // uninitialized bytes

    [[nodiscard]] RawSlot& at(std::uint64_t counter) noexcept {
        return slots_[static_cast<std::size_t>(counter & mask)];
    }

public:
    using value_type = T;
    static constexpr std::size_t capacity() noexcept { return Capacity; }

    SpscRing() noexcept = default;
    SpscRing(SpscRing const&)            = delete;   // relocating raw storage would move live
    SpscRing& operator=(SpscRing const&) = delete;   // objects out from under both threads
    SpscRing(SpscRing&&)                 = delete;
    SpscRing& operator=(SpscRing&&)      = delete;

    ~SpscRing() noexcept { clear_stopped(); }        // PRECONDITION: both threads joined

    // ---------------- producer side (one thread only) ---------------------

    template<class... Args>
        requires std::constructible_from<T, Args...>
    [[nodiscard]] bool try_emplace(Args&&... args)
        noexcept(std::is_nothrow_constructible_v<T, Args...>)
    {
        auto const w = producer_.write.load(std::memory_order_relaxed);   // I own it
        if (w - producer_.cached_read == Capacity) {                      // maybe full
            producer_.cached_read = consumer_.read.load(std::memory_order_acquire); // authorizes reuse
            if (w - producer_.cached_read == Capacity) return false;      // really full
        }
        std::construct_at(at(w).storage(), std::forward<Args>(args)...);  // may throw ⇒ no publish
        producer_.write.store(w + 1, std::memory_order_release);          // PUBLISH
        return true;
    }

    [[nodiscard]] bool try_push(T const& v)
        noexcept(std::is_nothrow_copy_constructible_v<T>)
        requires std::copy_constructible<T>
    { return try_emplace(v); }

    [[nodiscard]] bool try_push(T&& v)
        noexcept(std::is_nothrow_move_constructible_v<T>)
        requires std::move_constructible<T>
    { return try_emplace(std::move(v)); }

    // ---------------- consumer side (one thread only) ---------------------

    [[nodiscard]] std::optional<T> try_pop()
        noexcept requires std::is_nothrow_move_constructible_v<T>
    {
        auto const r = consumer_.read.load(std::memory_order_relaxed);    // I own it
        if (r == consumer_.cached_write) {                                // maybe empty
            consumer_.cached_write = producer_.write.load(std::memory_order_acquire); // authorizes access
            if (r == consumer_.cached_write) return std::nullopt;         // really empty
        }
        T* value = at(r).object();
        std::optional<T> out{std::in_place, std::move(*value)};           // noexcept by constraint
        std::destroy_at(value);
        consumer_.read.store(r + 1, std::memory_order_release);           // RELEASE the slot
        return out;
    }

    [[nodiscard]] bool try_pop(T& out)                                    // avoids optional
        noexcept(std::is_nothrow_move_assignable_v<T>)
        requires std::is_move_assignable_v<T>
    {
        auto const r = consumer_.read.load(std::memory_order_relaxed);
        if (r == consumer_.cached_write) {
            consumer_.cached_write = producer_.write.load(std::memory_order_acquire);
            if (r == consumer_.cached_write) return false;
        }
        T* value = at(r).object();
        out = std::move(*value);
        std::destroy_at(value);
        consumer_.read.store(r + 1, std::memory_order_release);
        return true;
    }

    template<class F>                                                     // zero-copy consume
        requires std::invocable<F&, T&>
    [[nodiscard]] bool try_consume(F&& f) noexcept(std::is_nothrow_invocable_v<F&, T&>) {
        auto const r = consumer_.read.load(std::memory_order_relaxed);
        if (r == consumer_.cached_write) {
            consumer_.cached_write = producer_.write.load(std::memory_order_acquire);
            if (r == consumer_.cached_write) return false;
        }
        T* value = at(r).object();
        std::invoke(f, *value);
        std::destroy_at(value);                                           // destroy even if f threw?
        consumer_.read.store(r + 1, std::memory_order_release);           // → see exception contract
        return true;
    }

    [[nodiscard]] T* peek() noexcept {                                    // consumer thread only
        auto const r = consumer_.read.load(std::memory_order_relaxed);
        if (r == consumer_.cached_write) {
            consumer_.cached_write = producer_.write.load(std::memory_order_acquire);
            if (r == consumer_.cached_write) return nullptr;
        }
        return at(r).object();                                            // valid until pop_front()
    }
    void pop_front() noexcept {                                           // pairs with peek()
        auto const r = consumer_.read.load(std::memory_order_relaxed);
        std::destroy_at(at(r).object());
        consumer_.read.store(r + 1, std::memory_order_release);
    }

    // ---------------- advisory telemetry (NOT for control flow) ----------
    [[nodiscard]] std::uint64_t size_approx() const noexcept {
        auto const w = producer_.write.load(std::memory_order_acquire);
        auto const r = consumer_.read.load(std::memory_order_acquire);
        return w - r;
    }
    [[nodiscard]] bool empty_approx() const noexcept { return size_approx() == 0; }

private:
    void clear_stopped() noexcept {          // exclusive ownership required
        auto r = consumer_.read.load(std::memory_order_relaxed);
        auto const w = producer_.write.load(std::memory_order_relaxed);
        for (; r != w; ++r) std::destroy_at(at(r).object());
        consumer_.read.store(w, std::memory_order_relaxed);
    }
    template<class, std::size_t> friend class SpscRingTestAccess;
};
```

**Exception contract**

- `try_emplace`: if `T`'s constructor throws, `write_` was never advanced ⇒ strong guarantee, queue unchanged, slot still logically free.
- `try_pop`: constrained to `is_nothrow_move_constructible_v<T>` — a throwing move could mutate the source and then fail, leaving a moved-from value still logically queued.
- `try_consume`: if `f` throws, decide and *document* one of: destroy-and-advance (item consumed), leave-in-place (item retried), or poison; the code above assumes a non-throwing `f` in the hot path.
- `~T` must be `noexcept` (static_assert): a throwing destructor during `clear_stopped` would terminate mid-drain.

| Operation | Complexity | Atomics touched | Notes |
|---|---|---|---|
| `try_emplace` (space cached) | O(1) + ctor | 1 relaxed load, 1 release store | no shared-line read |
| `try_emplace` (cache says full) | O(1) + ctor | + 1 acquire load of `read_` | one extra coherence miss |
| `try_push(const T&)` / `try_push(T&&)` | O(1) + copy/move ctor | same as `try_emplace` | forwards |
| `try_pop()` → `optional<T>` | O(1) + move ctor + dtor | 1 relaxed load, 1 release store | +1 acquire when empty-looking |
| `try_pop(T&)` | O(1) + move assign + dtor | same | reuses caller storage |
| `try_consume(f)` | O(1) + `f` + dtor | same | no payload move at all |
| `peek()` / `pop_front()` | O(1) | 1 load / 1 release store | pointer valid until `pop_front` |
| `size_approx()` | O(1) | 2 acquire loads | advisory only |
| destructor | O(size) dtors | 2 relaxed | requires joined threads |

**Traps** — `reinterpret_cast` without `launder` after placement new is UB in the general case · `std::array<RawSlot,N> slots_{}` value-initializes the *bytes*, not any `T` · reading `slots_[i]` outside `[read, write)` touches no object · `peek()`'s pointer dies at `pop_front()` · a `T` with a throwing destructor cannot use this queue.

---

## 36.7 Move-only and non-default-constructible payloads

```cpp
struct Packet {
    std::uint32_t id;
    std::unique_ptr<std::byte[]> bytes;
    std::size_t len;

    Packet(std::uint32_t i, std::unique_ptr<std::byte[]> b, std::size_t n) noexcept
        : id{i}, bytes{std::move(b)}, len{n} {}
    Packet(Packet&&) noexcept            = default;   // required by try_pop's constraint
    Packet& operator=(Packet&&) noexcept = default;
    Packet(Packet const&)                = delete;    // move-only: fine
    Packet& operator=(Packet const&)     = delete;
    // no default constructor: fine — raw storage never default-constructs
};

SpscRing<Packet, 1024> q;
auto ok = q.try_emplace(id, std::move(buffer), n);    // constructs IN the slot
auto ok2 = q.try_push(Packet{id, std::move(buf2), n});// builds a temp, then moves in
// q.try_push(pkt);                                   // ill-formed: no copy ctor → requires fails
if (auto p = q.try_pop()) use(*p);                    // optional<Packet>, moved out
q.try_consume([](Packet& p) noexcept { handle(p); }); // no move at all
```

```cpp
// ---- what the raw-storage design does and does not buy ------------------
static_assert(!std::is_default_constructible_v<Packet>);   // still queueable
static_assert(!std::is_copy_constructible_v<Packet>);      // still queueable
// but: Packet's unique_ptr still owns heap memory, and constructing the
// argument may allocate BEFORE try_emplace is even called. "No allocation in
// the queue" ≠ "no allocation in the operation".
```

```cpp
// ---- always-live std::array<T,N> alternative ---------------------------
template<class T, std::size_t N>
class SimpleRing {                       // requires default-constructible + assignable T
    std::array<T, N> slots_{};           // constructs N objects at queue construction
    // push: slots_[w & (N-1)] = std::move(v);       (assignment, not construction)
    // pop : out = std::move(slots_[r & (N-1)]);     (leaves a moved-from live object)
};
```

| Aspect | Raw slots (`RawSlot`) | Always-live `std::array<T,N>` |
|---|---|---|
| `T` requirements | destructible (+ per-op ctor/move) | default-constructible **and** assignable |
| Construction cost at startup | zero | `N` constructors |
| Empty slots | no objects at all | `N` live objects holding resources |
| Push | `construct_at` (begins lifetime) | assignment (reuses object) |
| Pop | move + `destroy_at` | move + moved-from object retained |
| Move-only `T` | supported | supported (assignment) |
| `span<T>` over free region | **impossible** (no objects) | legal (objects exist) |
| Proof burden | lifetime must be tracked exactly | simpler; resource retention is the cost |

```cpp
// ---- queue a handle when the payload is large --------------------------
struct BlockHandle { std::uint32_t index; std::uint32_t generation; };   // 8 bytes, trivially copyable
static_assert(std::is_trivially_copyable_v<BlockHandle> && sizeof(BlockHandle) == 8);
SpscRing<BlockHandle, 4096> handles;    // cheap moves; pool owns the bytes
// The queue does not validate the handle or keep its target alive — the pool
// must define transfer of ownership and reclamation (generation catches reuse).
```

**Traps** — a move constructor that is not `noexcept` disqualifies `try_pop()` (by design) · `try_emplace` bypasses `explicit` just like `emplace_back` · `sizeof(T)` large ⇒ `Capacity * sizeof(T)` bytes are resident and touched on wrap · queueing a `shared_ptr` adds an atomic refcount RMW per handoff.

---

## 36.8 Batch push/pop and contiguous spans

```text
available = write - read
first  = min(available, Capacity - (read & mask))     // up to the physical end
second = available - first                            // wrapped remainder, starts at slot 0
```

```cpp
// ---- producer lease: construct k, publish once -------------------------
class ProduceLease {                        // nested in SpscRing; producer thread only
    SpscRing* q_;
    std::uint64_t base_{};                  // logical position of the first slot
    std::uint64_t space_{};                 // slots available
    std::uint64_t built_{};                 // constructed but unpublished
public:
    explicit ProduceLease(SpscRing& q) noexcept : q_{&q} {
        base_ = q_->producer_.write.load(std::memory_order_relaxed);
        q_->producer_.cached_read = q_->consumer_.read.load(std::memory_order_acquire);
        space_ = Capacity - (base_ - q_->producer_.cached_read);
    }
    ProduceLease(ProduceLease const&) = delete;
    ProduceLease& operator=(ProduceLease const&) = delete;

    [[nodiscard]] std::uint64_t space() const noexcept { return space_ - built_; }

    template<class... Args>
        requires std::constructible_from<T, Args...>
    [[nodiscard]] bool emplace_next(Args&&... args) {
        if (built_ == space_) return false;
        std::construct_at(q_->at(base_ + built_).storage(), std::forward<Args>(args)...);
        ++built_;                            // increment AFTER construction succeeds
        return true;
    }
    void commit() noexcept {                 // ONE release store publishes the whole batch
        if (built_ == 0) return;
        q_->producer_.write.store(base_ + built_, std::memory_order_release);
        base_ += built_; space_ -= built_; built_ = 0;
    }
    void rollback() noexcept {               // destroy the constructed-but-unpublished prefix
        for (std::uint64_t i = 0; i != built_; ++i) std::destroy_at(q_->at(base_ + i).object());
        built_ = 0;
    }
    ~ProduceLease() noexcept { rollback(); } // transactional by default: uncommitted work is undone
};

[[nodiscard]] ProduceLease produce_lease() noexcept { return ProduceLease{*this}; }
```

```cpp
// ---- typed bulk push/pop for copyable/movable T ------------------------
template<class It>                          // producer thread only
[[nodiscard]] std::size_t try_push_n(It first, std::size_t n) {
    auto const w = producer_.write.load(std::memory_order_relaxed);
    producer_.cached_read = consumer_.read.load(std::memory_order_acquire);
    auto const room = static_cast<std::size_t>(Capacity - (w - producer_.cached_read));
    auto const k = n < room ? n : room;
    for (std::size_t i = 0; i != k; ++i, ++first)
        std::construct_at(at(w + i).storage(), *first);     // strong-ish: see rollback note
    producer_.write.store(w + k, std::memory_order_release);// single publication
    return k;
}

template<class Out>                         // consumer thread only
[[nodiscard]] std::size_t try_pop_n(Out out, std::size_t n)
    noexcept(std::is_nothrow_move_constructible_v<T>)
{
    auto const r = consumer_.read.load(std::memory_order_relaxed);
    consumer_.cached_write = producer_.write.load(std::memory_order_acquire);
    auto const avail = static_cast<std::size_t>(consumer_.cached_write - r);
    auto const k = n < avail ? n : avail;
    for (std::size_t i = 0; i != k; ++i, ++out) {
        T* v = at(r + i).object();
        *out = std::move(*v);
        std::destroy_at(v);
    }
    consumer_.read.store(r + k, std::memory_order_release); // single release
    return k;
}

template<class F>                           // segment-wise consume, no copies
    requires std::invocable<F&, T&>
[[nodiscard]] std::size_t consume_batch(F&& f, std::size_t max)
    noexcept(std::is_nothrow_invocable_v<F&, T&>)
{
    auto const r = consumer_.read.load(std::memory_order_relaxed);
    consumer_.cached_write = producer_.write.load(std::memory_order_acquire);
    auto const avail = static_cast<std::size_t>(consumer_.cached_write - r);
    auto const k = avail < max ? avail : max;
    for (std::size_t i = 0; i != k; ++i) {
        T* v = at(r + i).object();
        std::invoke(f, *v);
        std::destroy_at(v);
    }
    consumer_.read.store(r + k, std::memory_order_release);
    return k;
}
```

```cpp
// ---- spans are legal ONLY for the always-live array representation -----
template<class T, std::size_t N>
struct Segments { std::span<T> first, second; };   // first may wrap into second

Segments<T,N> readable(std::uint64_t r, std::uint64_t avail, std::array<T,N>& slots) {
    auto const off   = static_cast<std::size_t>(r & (N - 1));
    auto const head  = std::min<std::size_t>(avail, N - off);
    return { std::span<T>{slots.data() + off, head},
             std::span<T>{slots.data(), static_cast<std::size_t>(avail) - head} };
}
// For RawSlot storage this is ILL-FOUNDED: those bytes hold no T objects, and
// adjacent independently-created T objects are not one language-level T[].
```

| Batch shape | Publication | Failure handling |
|---|---|---|
| `ProduceLease` + `commit()` | one release store of `base+built` | destructor rolls back the unpublished prefix |
| `try_push_n` | one release store of `w+k` | wrap in try/catch + destroy `[w, w+i)` for throwing `T` |
| `try_pop_n` | one release store of `r+k` | requires `nothrow` move |
| `consume_batch` | one release store of `r+k` | callback must not throw, or define retry semantics |
| Per-element loop | k release stores | simplest; k× shared-line traffic |

- Batching trades **latency** (the first item waits for the commit) for **throughput** (one coherence transfer per k items).
- Never advance `write_` past a slot whose construction did not complete — that is the one non-negotiable batch rule.
- Two-segment iteration exists only because the physical array wraps; the logical range never wraps.
- A partially-successful batch must document one contract: transactional (publish nothing) or prefix (publish what succeeded).

**Traps** — returning `span<T>` over raw free slots is UB waiting to happen · `commit()` inside a loop defeats the point · a lease held across a `try_emplace` call double-books slots · forgetting `rollback` on the throwing path leaks live objects into logically free slots.

---

## 36.9 Backpressure: reject, spin, yield, block, or overwrite

```cpp
// ---- reject (the primitive) --------------------------------------------
if (!q.try_push(std::move(v))) { ++dropped_; record_overflow(); }

// ---- spin with a pause hint --------------------------------------------
#if defined(__x86_64__)
  #include <immintrin.h>
  inline void cpu_relax() noexcept { _mm_pause(); }
#elif defined(__aarch64__)
  inline void cpu_relax() noexcept { asm volatile("yield" ::: "memory"); }
#else
  inline void cpu_relax() noexcept {}
#endif
while (!q.try_push(v)) cpu_relax();                 // burns a core; can starve the consumer

// ---- bounded spin, then yield, then sleep ------------------------------
for (int i = 0; !q.try_push(v); ++i) {
    if (i < 64)        cpu_relax();
    else if (i < 1024) std::this_thread::yield();
    else               std::this_thread::sleep_for(std::chrono::microseconds{50});
}

// ---- block on the atomic itself (C++20) --------------------------------
// producer waits for space:
auto const w = producer_.write.load(std::memory_order_relaxed);
std::uint64_t r = consumer_.read.load(std::memory_order_acquire);
while (w - r == Capacity) { consumer_.read.wait(r, std::memory_order_acquire); // sleeps until != r
                            r = consumer_.read.load(std::memory_order_acquire); }
// consumer after freeing a slot:
consumer_.read.store(r + 1, std::memory_order_release);
consumer_.read.notify_one();                        // cost: an unconditional notify per pop

// ---- counting semaphore layer (C++20) ----------------------------------
std::counting_semaphore<Capacity> slots_free{Capacity}, items{0};
slots_free.acquire(); (void)q.try_push(v); items.release();   // producer
items.acquire();      auto v2 = q.try_pop();  slots_free.release(); // consumer
```

| Policy | API shape | Latency | Cost / risk |
|---|---|---|---|
| Reject | `bool` / `std::expected<void, Full>` | none | caller must have a plan |
| Spin | retry + `pause` | lowest when brief | burns a core, starves consumer on shared cores |
| Yield | retry + `this_thread::yield` | scheduler-dependent | unbounded tail |
| Block (`atomic::wait`) | futex-backed sleep | wakeup latency | lost-wakeup and shutdown protocol |
| Semaphore | acquire/release pair | syscall on contention | two extra atomics per item |
| Drop newest | discard `v`, count it | none | loss must be semantically allowed |
| Drop oldest / overwrite | separate lossy ring | none | **producer must not advance `read_`** |
| Fail upward | transition the component | n/a | correct when any loss invalidates state |

- `try_push == false` is an application-visible overload event, not an implementation detail — count it, log it, alarm on it.
- Never implement overwrite by having the producer advance `read_`: it seizes the consumer's cursor and can destroy an object the consumer is reading.
- A real overwrite ring is a *different algorithm* (consumer detects being lapped via a sequence/generation and reports loss).
- `notify_one` on every pop costs a store + a (usually cheap) futex check; notify only when a waiter is plausible, tracked by a separate flag.
- Blocking layers need a close/stop state or the waiter sleeps forever at shutdown.

**Traps** — spinning on a hyperthread sibling of the consumer halves the consumer's throughput · `yield()` on a busy machine can be a multi-millisecond nap · `wait(old)` re-checks the value, so always reload in a loop · a semaphore around a `try_*` queue silently hides the queue's own full test.

---

## 36.10 Counter wraparound and correctness tests

```cpp
std::uint64_t w = 0xFFFF'FFFF'FFFF'FFFEull, r = 0xFFFF'FFFF'FFFF'FFFCull;
auto occupancy = w - r;                  // 2 — correct
w += 4;                                  // wraps to 0x...0002, defined for unsigned
occupancy = w - r;                       // 6 — still correct modulo 2^64
// bool wrong = (w < r);                 // true, and meaningless: never compare chronologically
// std::int64_t signed_counter;          // signed overflow is UB — the optimizer may assume away
```

- Unsigned wrap is modulo `2^N` **by language rule**, so `w - r` is the exact modular distance while `0 <= occupancy <= Capacity` holds.
- Requirements: unsigned fixed-width counters, `Capacity ≪ 2^64`, invariant maintained by both sides, comparisons by difference only.
- "64 bits takes centuries at 1 G ops/s" is an excuse, not a proof — the modular invariant is the proof.
- Test wrap by *parameterizing the counter width*, not by waiting.

```cpp
// ---- reduced-width model to actually exercise wrap ---------------------
template<class Counter, std::size_t Capacity>
struct CounterModel {                        // Counter = std::uint8_t in tests
    Counter write{}, read{};
    bool full()  const { return static_cast<Counter>(write - read) == Capacity; }
    bool empty() const { return write == read; }
    void push()  { assert(!full());  ++write; }
    void pop()   { assert(!empty()); ++read;  }
};
// uint8_t + Capacity 4 ⇒ full wrap every 256 pushes; run 10^6 random ops with
// an invariant check: static_cast<Counter>(write - read) <= Capacity.
```

**Sequential tests**

```cpp
SpscRing<Move, 4> q;
assert(!q.try_pop());                                  // empty on construction
for (int i = 0; i != 4; ++i) assert(q.try_emplace(i)); // fills exactly Capacity — all N usable
assert(!q.try_emplace(99));                            // rejects the (N+1)th
for (int i = 0; i != 4; ++i) assert(q.try_pop()->v == i);   // FIFO order
assert(!q.try_pop());                                  // rejects empty pop
for (int i = 0; i != 1000; ++i) { assert(q.try_emplace(i)); assert(q.try_pop()->v == i); } // wrap
// + move-only / non-default-constructible payload compiles
// + instrumented T: destructor count == successful construction count
// + throwing constructor leaves size and order unchanged
// + destructor after a partial fill destroys exactly the live elements
```

**Concurrent tests**

- Monotonic payload values: the consumer asserts `v == expected++` — catches gaps, duplicates, and reordering in one check.
- Run producer-faster and consumer-faster; both expose different boundary refresh paths.
- Long runs (10⁸ items) across many physical wraps; capacities 2, 4, 1024, 65536.
- Randomized pauses/yields injected immediately before and after each publication store.
- Shutdown while empty, partially full, and completely full.
- Nontrivial payload with an internal checksum verified after handoff (catches torn/uninitialized reads).

```bash
g++ -std=c++23 -O2 -fsanitize=thread   spsc_test.cpp -o tsan && ./tsan   # data races
g++ -std=c++23 -O1 -fsanitize=address,undefined spsc_test.cpp -o asan && ./asan
g++ -std=c++23 -O2 -DNDEBUG spsc_bench.cpp -o bench                      # measure, then tune padding
# run the same test suite on AArch64: x86-64's TSO hides missing acquire/release
```

- Stress testing **cannot prove** a memory-order algorithm: derive happens-before first, then use TSan, weak hardware, and model checkers (CDSChecker, herd7, `litmus7`) as defect finders.
- TSan understands `std::atomic` orders and will report a missing acquire as a race on the payload.
- A benchmark should report round-trip latency percentiles and throughput at several occupancy levels, not just a mean.

**Traps** — testing only on x86-64 · `assert` compiled out under `NDEBUG` in the "stress" build · a test that pins both threads to the same core turns spin policies into livelock · relying on `size_approx()` in test assertions.

---

## 36.11 Why SPSC reasoning does not generalize to MPMC

```cpp
// Two producers with the SPSC body: both load w == 7 and both construct into
// slot 7. Two constructions, one slot, one lost item, one leaked object.
auto const w = producer_.write.load(std::memory_order_relaxed);   // ← races
std::construct_at(at(w).storage(), args...);
producer_.write.store(w + 1, std::memory_order_release);          // ← lost update
// producer_.cached_read is a plain uint64_t ⇒ instant data race as well.
```

```cpp
// fetch_add reserves a UNIQUE slot but does NOT fix publication:
auto const w = write_.fetch_add(1, std::memory_order_relaxed);    // unique ticket
std::construct_at(at(w).storage(), args...);
// Producer A holds ticket 7 and stalls; producer B finishes ticket 8.
// A single "write_" counter can no longer mean "everything below is published"
// ⇒ the consumer would read the hole at 7.
```

```cpp
// The MPMC fix: per-slot sequence numbers (Vyukov bounded queue) ----------
struct Cell { std::atomic<std::size_t> seq; RawSlot storage; };
// enqueue: CAS the tail ticket, require cell.seq == ticket, construct,
//          cell.seq.store(ticket + 1, release)
// dequeue: CAS the head ticket, require cell.seq == ticket + 1, move out,
//          cell.seq.store(ticket + Capacity, release)
```

| Change | What breaks | What it costs to fix |
|---|---|---|
| 2nd producer | shared `write` load, private `cached_read`, same-slot construction | ticketed `fetch_add`/CAS + per-slot ready flag |
| 2nd consumer | shared `read` load, private `cached_write`, double move/destroy | ticketed claim + per-slot sequence |
| Both | all of the above + ABA on reuse | per-slot sequence word, contention backoff |
| Consumer publishing back | producer no longer owns reuse | full MPMC reclamation proof |

- One extra producer breaks three things at once: the counter load, the private cache, and slot exclusivity.
- Per-slot sequence numbers restore "is this slot ready for me?" locally, which the single shared counter can no longer answer.
- MPMC additionally needs contention management (backoff), and its throughput degrades with thread count while SPSC's does not.
- MPSC and SPMC are intermediate: only the multi side needs tickets; the single side keeps its relaxed/release protocol.
- Sharding N SPSC queues (one per producer, consumer round-robins) often beats one MPMC queue and preserves this proof.

```cpp
static_assert(std::atomic<std::uint64_t>::is_always_lock_free);  // assert it if your target requires it
```

- "Lock-free" is a *progress* property, not a synonym for fast, wait-free, or low tail latency.
- These `try_*` operations are in fact wait-free: bounded local steps, given bounded payload construction/destruction.

**Interview line** — "SPSC correctness comes from exclusive cursor and slot ownership; making the indices atomic is necessary but nowhere near sufficient, so adding a second producer requires a different reservation, publication, and reclamation proof, not a bigger memory order."

---

### Recall card

```text
SPSC             exactly one producer thread + exactly one consumer thread
write owner      producer: construct → write_.store(w+1, release)
read owner       consumer: use → destroy → read_.store(r+1, release)
consumer entry   write_.load(acquire) authorizes reading the payload
producer entry   read_.load(acquire)  authorizes reusing the slot
owner loads      relaxed (already sequenced in that thread)
empty            w == r                       full  w - r == Capacity
slot             counter & (Capacity - 1), Capacity a power of two
raw storage      alignas(T) byte[sizeof(T)] · construct_at · launder · destroy_at
caches           private cached_read/cached_write; refresh only at apparent full/empty
false sharing    alignas(hardware_destructive_interference_size) on each state block
batch            construct k → one release store of +k; raw free slots are NOT span<T>
exceptions       ctor throws ⇒ nothing published; pop needs nothrow move; ~T must be noexcept
backpressure     reject | spin | yield | block | drop | overwrite — named, counted, explicit
wrap             unsigned modular difference only; never signed, never `w < r`
shutdown         stop → close/signal → drain or discard → join → destroy
copy/move        deleted; relocating raw storage moves live objects out from under threads
MPMC             needs tickets + per-slot sequence numbers; fetch_add alone is not enough
```

**Core design sentence** — a bounded SPSC ring is an object-lifetime handoff proved by exclusive cursor ownership: release publishes each constructed element, acquire authorizes the other thread's access, and no slot is ever reused before its destruction has been published back.
