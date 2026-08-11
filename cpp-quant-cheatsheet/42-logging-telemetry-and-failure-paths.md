# 42. Logging, telemetry, and failure paths

*Part VI-B — Quant blueprints: pipeline, publication, and runtime*

---

**Recall**
- Observability is part of the workload: its branches, clock reads, cache footprint, and overload behaviour must be budgeted like any other code.
- The producer's job is *encode and publish*; formatting, enrichment, I/O, and allocation belong to the drain.
- A runtime level check inside the logging function runs **after** the arguments have already been evaluated — only `if constexpr`, a macro, or a call-site guard removes that work.
- `std::source_location::current()` must be a default argument of the *caller-facing* function, otherwise it captures the wrapper.
- Store a compile-time site ID (or a hashed file/line), not a pointer, in anything that will be persisted or replayed.
- A `DiagnosticRecord` must be trivially copyable and fixed-size so publication is a `memcpy` into a preallocated slot.
- Deferred `printf`-style varargs are unsound because the type information is lost; carry a per-argument type tag or a per-site schema.
- One SPSC ring per producer thread beats one MPSC ring: the producer owns the tail and its counters, the drain owns the heads.
- Trivially copyable ≠ portable wire format: padding, endianness, enum underlying type, ABI, and schema version all leak.
- Full-queue behaviour is a *named policy* — drop newest, overwrite oldest, block, spin, synchronous fallback, or degrade — never an accident.
- Loss must be counted in a channel that cannot itself be lost; never report a logger failure through the same logger.
- A plain `std::uint64_t` counter owned by exactly one thread is the cheapest race-free counter; concurrent reads of it are UB, not "approximate".
- `memory_order_relaxed` gives atomicity and per-object modification order — not synchronization of any other data.
- Pad per *shard*, not per field: a whole cache line for every counter wastes memory the shard owner touches together anyway.
- Histogram percentiles are approximations bounded by bucket edges; merge bucket counts before computing a quantile — never average per-thread p99s.
- `noexcept` on a logging entry point must be truthful: a throw escaping it calls `std::terminate`, and destructors log during unwinding.
- At fatal time assume the allocator, the logger mutex, the drain thread, and static objects are unusable; use a preallocated record and a pre-opened descriptor.
- `assert` vanishes under `NDEBUG` — never use it to validate untrusted input or to carry required control flow.
- "Flush" has five distinct meanings (queue drained → encoder → `write` → `fsync` → collector ack); promise exactly one.
- Benchmark telemetry **disabled, enabled, and overloaded**, and measure producer p99/p99.9 rather than throughput.

---

## 42.1 Compile-time log filtering and source locations

```cpp
#include <cstdint>
#include <source_location>
#include <utility>

enum class LogLevel : std::uint8_t {          // ordering is deliberate and load-bearing
    trace = 0, debug = 1, info = 2, warn = 3, error = 4, fatal = 5
};

constexpr auto to_underlying(LogLevel l) noexcept {   // C++23 <utility>: std::to_underlying
    return std::to_underlying(l);
}

// ---- build-time floor: sites below this vanish, arguments included -------
#ifndef QS_LOG_COMPILE_MIN
#  define QS_LOG_COMPILE_MIN ::LogLevel::info
#endif
inline constexpr LogLevel kCompileMin = QS_LOG_COMPILE_MIN;
```

```cpp
// ---- two-stage gate: constexpr first, runtime second ---------------------
class Logger;                                  // defined in 42.3

template<LogLevel Level, class... Args>
inline void log_if(Logger& lg, Args&&... args) noexcept {
    if constexpr (Level >= kCompileMin) {      // stage 1: whole call removed
        if (Level >= lg.runtime_min()) {       // stage 2: cheap predictable branch
            lg.template emit<Level>(std::forward<Args>(args)...);
        }
    }
    // else: args are never *used*, but they were already evaluated at the call.
}
```

```cpp
// ---- THE TRAP: arguments evaluate before any runtime check ---------------
lg.debug("book", expensive_snapshot());        // snapshot() runs even when disabled

// fix 1 — explicit call-site guard
if (lg.enabled(LogLevel::debug)) lg.debug("book", expensive_snapshot());

// fix 2 — lazy callable, invoked only inside the enabled branch
lg.debug_lazy([&] { return expensive_snapshot(); });

// fix 3 — macro: short-circuit keeps the argument list unevaluated
#define QS_LOG(lg_, lvl_, ...)                                              \
    do {                                                                     \
        if constexpr ((lvl_) >= ::kCompileMin)                               \
            if ((lg_).enabled(lvl_)) (lg_).emit_at<(lvl_)>(__VA_ARGS__);     \
    } while (false)
// do/while(false): one statement, requires a trailing ';', safe under `if/else`.
// Parenthesize every macro parameter; evaluate each exactly once; no new names.
```

```cpp
// ---- source_location: capture at the CALLER-facing boundary --------------
struct Site {
    char const* file{};                 // static storage in the image; NOT persistable
    char const* function{};
    std::uint_least32_t line{};
    std::uint_least32_t column{};
};

// Correct: default argument on the function the user calls.
inline Site here(std::source_location loc = std::source_location::current()) noexcept {
    return {loc.file_name(), loc.function_name(), loc.line(), loc.column()};
}

// WRONG: the wrapper's own location is captured, every record points at logger.hpp.
inline Site here_broken() noexcept { return here(); }

// Correct forwarding: thread the location through as a parameter.
template<class... Args>
void emit_here(Logger& lg, std::source_location loc = std::source_location::current(),
               Args&&... a);               // note: defaulted param BEFORE the pack is
                                           // unusable in practice — see below.
```

```cpp
// ---- the idiomatic fix: fold the location into the first parameter -------
struct FormatSite {
    char const* fmt;
    std::source_location loc;
    // implicit ctor lets callers write log(lg, "gap {}", n) unchanged
    consteval FormatSite(char const* f,                          // C++20 consteval
                         std::source_location l = std::source_location::current())
        : fmt{f}, loc{l} {}
};

template<class... Args>
void log(Logger& lg, FormatSite site, Args&&... args) noexcept;  // loc == caller's
```

```cpp
// ---- bounded site identity: what actually goes in the record -------------
constexpr std::uint32_t fnv1a(char const* s) noexcept {          // FNV-1a 32-bit
    std::uint32_t h = 2166136261u;
    for (; *s; ++s) { h ^= static_cast<std::uint8_t>(*s); h *= 16777619u; }
    return h;
}

struct SiteId { std::uint32_t value{}; };

consteval SiteId site_id(std::source_location l = std::source_location::current()) {
    return SiteId{fnv1a(l.file_name()) * 31u + static_cast<std::uint32_t>(l.line())};
}
// 4 bytes in the record; a build-generated dictionary maps id -> file:line:function.
// Collisions are a policy decision: detect them at build time over the site table.
```

| Facility | Header | Notes |
|---|---|---|
| `std::source_location::current()` | `<source_location>` | C++20; only meaningful as a **default argument** |
| `.file_name()` / `.function_name()` | — | `char const*`, static storage, implementation-defined content |
| `.line()` / `.column()` | — | `std::uint_least32_t`; `column()` may be `0` |
| `std::to_underlying(e)` | `<utility>` | C++23; replaces `static_cast<std::underlying_type_t<E>>` |
| `std::stacktrace` / `std::stacktrace_entry` | `<stacktrace>` | C++23; **allocates**, cold path only |
| `__FILE__` / `__LINE__` / `__func__` | — | pre-C++20 fallback; `__func__` is a local array, not a literal |
| `std::unreachable()` | `<utility>` | C++23; UB if reached — never a validation tool |

**Traps** — a wrapper without a defaulted `source_location` parameter reports the wrapper · different `QS_LOG_COMPILE_MIN` values across TUs that change an inline class definition is an ODR violation, so confine build-time levels to call-site macros · storing `file_name()` pointers in a replay file writes meaningless addresses · `consteval` site helpers cannot be called from a runtime-only context · macros that name a temporary leak it into the caller's scope.

---

## 42.2 Deferred formatting and bounded records

```cpp
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <span>
#include <string_view>
#include <type_traits>

enum class EventCode : std::uint16_t {
    none = 0, decode_error, sequence_gap, queue_full,
    invariant_failure, slow_path, reject, heartbeat
};

enum class ArgType : std::uint8_t { none = 0, u64, i64, f64, boolean, str8, id32 };

union ArgValue {                    // aggregate union: trivially copyable
    std::uint64_t u;
    std::int64_t  i;
    double        d;
    char          s[8];             // inline short string, NOT null-terminated
};
static_assert(sizeof(ArgValue) == 8);

struct Arg {
    ArgValue value{};               // zero-initializes the first member
    ArgType  type{ArgType::none};
    std::uint8_t len{};             // used by str8 only
};
static_assert(std::is_trivially_copyable_v<Arg>);
```

```cpp
// ---- one overload per source type: the type tag is captured, not lost ----
inline Arg arg(std::uint64_t v) noexcept { Arg a; a.type = ArgType::u64;     a.value.u = v; return a; }
inline Arg arg(std::uint32_t v) noexcept { return arg(static_cast<std::uint64_t>(v)); }
inline Arg arg(std::int64_t  v) noexcept { Arg a; a.type = ArgType::i64;     a.value.i = v; return a; }
inline Arg arg(int           v) noexcept { return arg(static_cast<std::int64_t>(v)); }
inline Arg arg(double        v) noexcept { Arg a; a.type = ArgType::f64;     a.value.d = v; return a; }
inline Arg arg(bool          v) noexcept { Arg a; a.type = ArgType::boolean; a.value.u = v; return a; }
inline Arg arg(SiteId        v) noexcept { Arg a; a.type = ArgType::id32;    a.value.u = v.value; return a; }

inline Arg arg(std::string_view v) noexcept {   // COPIES up to 8 bytes; never a view
    Arg a; a.type = ArgType::str8;
    a.len = static_cast<std::uint8_t>(v.size() < 8 ? v.size() : 8);
    std::memcpy(a.value.s, v.data(), a.len);
    return a;
}
// void* / T* deliberately have NO overload: pointers are not portable identities.
```

```cpp
// ---- the fixed record: everything a producer writes ----------------------
inline constexpr std::size_t kMaxArgs = 4;
inline constexpr std::size_t kInlineBytes = 24;

struct DiagnosticRecord {
    std::uint64_t monotonic_ns{};     // clock domain fixed by `flags`
    std::uint64_t sequence{};         // per-producer, monotonic, gap-detectable
    std::uint32_t site_id{};          // dictionary key -> file:line:function:format
    std::uint32_t source_id{};        // component / stream identity
    std::array<Arg, kMaxArgs> args{};
    std::uint32_t payload_original{}; // pre-truncation size of the byte blob
    std::uint16_t payload_copied{};   // bytes actually present in `payload`
    EventCode code{EventCode::none};
    LogLevel  level{LogLevel::info};
    std::uint8_t producer_id{};
    std::uint8_t flags{};             // bit0 truncated, bit1 sampled, bit2 tsc-domain
    std::array<std::byte, kInlineBytes> payload{};
};

static_assert(std::is_trivially_copyable_v<DiagnosticRecord>);
static_assert(std::is_trivially_destructible_v<DiagnosticRecord>);
static_assert(sizeof(DiagnosticRecord) <= 128);   // budget it; two cache lines
```

```cpp
// ---- producer-side construction: assignments only, no allocation, no fmt --
enum : std::uint8_t { kFlagTruncated = 1u << 0, kFlagSampled = 1u << 1 };

template<class... Ts>
    requires (sizeof...(Ts) <= kMaxArgs)
inline DiagnosticRecord make_record(LogLevel lvl, EventCode code, SiteId site,
                                    std::uint64_t now_ns, std::uint64_t seq,
                                    Ts... vs) noexcept {
    DiagnosticRecord r;
    r.monotonic_ns = now_ns;
    r.sequence     = seq;
    r.site_id      = site.value;
    r.code         = code;
    r.level        = lvl;
    std::size_t n = 0;
    ((r.args[n++] = arg(vs)), ...);            // fold over the pack, left to right
    return r;                                   // NRVO / trivial copy of ~128 bytes
}

inline void attach_payload(DiagnosticRecord& r, std::span<std::byte const> bytes) noexcept {
    r.payload_original = static_cast<std::uint32_t>(bytes.size());
    std::size_t const n = bytes.size() < kInlineBytes ? bytes.size() : kInlineBytes;
    std::memcpy(r.payload.data(), bytes.data(), n);
    r.payload_copied = static_cast<std::uint16_t>(n);
    if (n < bytes.size()) r.flags |= kFlagTruncated;   // truncation is RECORDED
}
```

```cpp
// ---- larger bounded payloads: pay for the size class you need ------------
template<std::size_t N>
struct SizedRecord {                       // N in {32, 128, 512} — pick per stream
    DiagnosticRecord header;
    std::array<std::byte, N> extra{};
};
```

```cpp
// ---- drain-side formatting: std::format, once, off the hot path ----------
#include <format>
#include <string>

inline void format_arg(std::string& out, Arg const& a) {
    switch (a.type) {
        case ArgType::u64:     std::format_to(std::back_inserter(out), "{}", a.value.u); break;
        case ArgType::i64:     std::format_to(std::back_inserter(out), "{}", a.value.i); break;
        case ArgType::f64:     std::format_to(std::back_inserter(out), "{:.9g}", a.value.d); break;
        case ArgType::boolean: out += (a.value.u ? "true" : "false"); break;
        case ArgType::id32:    std::format_to(std::back_inserter(out), "#{:08x}", a.value.u); break;
        case ArgType::str8:    out.append(a.value.s, a.len); break;
        case ArgType::none:    break;
    }
}

inline void render(std::string& out, DiagnosticRecord const& r,
                   std::string_view site_text) {           // site_text from dictionary
    std::format_to(std::back_inserter(out), "{:>20} {} {} {} ",
                   r.monotonic_ns, to_underlying(r.level),
                   static_cast<std::uint16_t>(r.code), site_text);
    for (auto const& a : r.args) {
        if (a.type == ArgType::none) break;
        format_arg(out, a);
        out.push_back(' ');
    }
    if (r.flags & kFlagTruncated)
        std::format_to(std::back_inserter(out), "[trunc {}/{}]",
                       r.payload_copied, r.payload_original);
    out.push_back('\n');                                   // NOT std::endl
}
```

| `<format>` facility | Cost / behaviour | Use |
|---|---|---|
| `std::format(fmt, args...)` | allocates a `std::string`; `fmt` checked at compile time | drain only |
| `std::format_to(out_it, fmt, …)` | no return string; appends through the iterator | drain, into a reused buffer |
| `std::format_to_n(out, n, fmt, …)` | bounded; returns `{out, size}` (untruncated size) | cold bounded buffers |
| `std::formatted_size(fmt, …)` | dry run to size a buffer | presizing |
| `std::vformat` / `std::make_format_args` | runtime format string, type-erased | dictionary-driven drains |
| `std::format` with `std::runtime_format(s)` | C++26 spelling for runtime strings | avoid `vformat` boilerplate |
| `std::print` / `std::println` | C++23; writes to `FILE*`, locks the stream | never on a producer |
| `std::formatter<T>` specialization | user type support; `parse` + `format` | drain-side record rendering |

**Traps** — a `std::string_view`/`std::span` stored in a queued record dangles once the producer's receive buffer is reused · `printf`-style deferred varargs lose types and read garbage · `std::format` throws `std::format_error` and allocates, so it can never live inside a `noexcept` producer · reading `a.value.d` when `type == u64` is reading an inactive union member (UB) — the tag is the contract · records larger than a cache line or two pollute the producer's L1 for the drain's benefit · `std::endl` flushes; use `'\n'`.

---

## 42.3 Per-thread buffers and asynchronous drains

```text
producer 0 ──SPSC ring──┐
producer 1 ──SPSC ring──┼──► drain thread ──► render ──► batch buffer ──► sink
producer 2 ──SPSC ring──┘        (owns every head; owns the dictionary)

producer owns: its tail, its slots-before-publish, its counters
drain    owns: every head, every slot after acquire, all formatting and I/O
```

```cpp
#include <atomic>
#include <new>
#include <thread>
#include <stop_token>
#include <vector>
#include <memory>
#include <chrono>

#ifdef __cpp_lib_hardware_interference_size
inline constexpr std::size_t kLine = std::hardware_destructive_interference_size;
#else
inline constexpr std::size_t kLine = 64;      // implementation value, not physics
#endif
```

```cpp
// ============ single-producer / single-consumer bounded ring =============
template<class T, std::size_t Capacity>
class SpscRing {
    static_assert(std::has_single_bit(Capacity), "power of two for mask indexing");
    static_assert(std::is_trivially_copyable_v<T>);
    static constexpr std::size_t kMask = Capacity - 1;

    alignas(kLine) std::atomic<std::size_t> tail_{0};   // producer line
    std::size_t cached_head_{0};                        // producer's stale view of head_
    alignas(kLine) std::atomic<std::size_t> head_{0};   // consumer line
    std::size_t cached_tail_{0};                        // consumer's stale view of tail_
    alignas(kLine) std::array<T, Capacity> slot_{};

public:
    static constexpr std::size_t capacity() noexcept { return Capacity; }

    // ---- producer side ---------------------------------------------------
    [[nodiscard]] bool try_push(T const& v) noexcept {
        std::size_t const t = tail_.load(std::memory_order_relaxed);   // we own it
        if (t - cached_head_ == Capacity) {                            // maybe full
            cached_head_ = head_.load(std::memory_order_acquire);      // refresh once
            if (t - cached_head_ == Capacity) return false;            // truly full
        }
        slot_[t & kMask] = v;                                          // private slot
        tail_.store(t + 1, std::memory_order_release);                 // PUBLISH
        return true;
    }

    // In-place emplace: fill the slot, then publish — no temporary record copy.
    [[nodiscard]] T* acquire_slot() noexcept {
        std::size_t const t = tail_.load(std::memory_order_relaxed);
        if (t - cached_head_ == Capacity) {
            cached_head_ = head_.load(std::memory_order_acquire);
            if (t - cached_head_ == Capacity) return nullptr;
        }
        return &slot_[t & kMask];
    }
    void publish() noexcept {
        tail_.store(tail_.load(std::memory_order_relaxed) + 1, std::memory_order_release);
    }

    // ---- consumer side ---------------------------------------------------
    [[nodiscard]] bool try_pop(T& out) noexcept {
        std::size_t const h = head_.load(std::memory_order_relaxed);   // we own it
        if (h == cached_tail_) {
            cached_tail_ = tail_.load(std::memory_order_acquire);      // ACQUIRE pairs
            if (h == cached_tail_) return false;                       // empty
        }
        out = slot_[h & kMask];
        head_.store(h + 1, std::memory_order_release);                 // free the slot
        return true;
    }

    // Batch drain: one acquire load amortized over up to `max` records.
    std::size_t pop_batch(std::span<T> out) noexcept {
        std::size_t const h = head_.load(std::memory_order_relaxed);
        cached_tail_ = tail_.load(std::memory_order_acquire);
        std::size_t n = cached_tail_ - h;
        if (n > out.size()) n = out.size();
        for (std::size_t i = 0; i < n; ++i) out[i] = slot_[(h + i) & kMask];
        if (n) head_.store(h + n, std::memory_order_release);
        return n;
    }

    [[nodiscard]] std::size_t size_approx() const noexcept {
        return tail_.load(std::memory_order_acquire) - head_.load(std::memory_order_acquire);
    }
    [[nodiscard]] bool empty_approx() const noexcept { return size_approx() == 0; }
};
```

```cpp
// ============ per-producer shard: ring + counters + sequence =============
struct ProducerStats {                      // plain: owned by exactly one thread
    std::uint64_t emitted{};
    std::uint64_t dropped{};
    std::uint64_t truncated{};
    std::uint64_t sampled{};
};

struct alignas(kLine) Shard {
    SpscRing<DiagnosticRecord, 4096> ring{};
    ProducerStats local{};                             // producer-private
    // Published snapshot: producer stores, drain loads — relaxed is enough for
    // independent statistics; see 42.5 for the consistent-snapshot version.
    std::atomic<std::uint64_t> pub_emitted{0};
    std::atomic<std::uint64_t> pub_dropped{0};
    std::atomic<std::uint64_t> pub_truncated{0};
    std::uint64_t sequence{0};
    std::uint8_t  id{};
    std::atomic<bool> active{false};

    void publish_stats() noexcept {                    // called on a dwell boundary
        pub_emitted.store(local.emitted, std::memory_order_relaxed);
        pub_dropped.store(local.dropped, std::memory_order_relaxed);
        pub_truncated.store(local.truncated, std::memory_order_relaxed);
    }
};
```

```cpp
// ============ the logger: registry + producer API ========================
class Sink {                                 // drain-side, may block, may throw
public:
    virtual ~Sink() = default;
    virtual void write(std::span<char const> bytes) = 0;
    virtual void flush() = 0;
};

class Logger {
public:
    static constexpr std::size_t kMaxProducers = 64;

    explicit Logger(std::unique_ptr<Sink> sink, std::size_t producers)
        : sink_{std::move(sink)}, shards_(producers) {          // ALL allocation here
        for (std::size_t i = 0; i < producers; ++i) shards_[i].id = std::uint8_t(i);
        batch_.reserve(1u << 16);
        scratch_.resize(256);
    }
    Logger(Logger const&) = delete;
    Logger& operator=(Logger const&) = delete;
    ~Logger() { stop_and_join(); }                              // never in a dtor race

    // ---- producer-thread binding: one shard per thread, claimed once -----
    Shard& bind() noexcept {
        thread_local Shard* mine = nullptr;
        if (mine) return *mine;
        for (auto& s : shards_) {
            bool expected = false;
            if (s.active.compare_exchange_strong(expected, true,
                                                 std::memory_order_acq_rel)) {
                mine = &s;
                return *mine;
            }
        }
        mine = &shards_.back();       // overflow: share the last shard (see traps)
        return *mine;
    }

    [[nodiscard]] LogLevel runtime_min() const noexcept {
        return runtime_min_.load(std::memory_order_relaxed);
    }
    void set_runtime_min(LogLevel l) noexcept {
        runtime_min_.store(l, std::memory_order_relaxed);
    }
    [[nodiscard]] bool enabled(LogLevel l) const noexcept { return l >= runtime_min(); }

    // ---- THE hot-path entry point: noexcept, allocation-free, bounded ----
    template<LogLevel Level, class... Ts>
    void emit_at(EventCode code, SiteId site, Ts... vs) noexcept {
        if constexpr (Level >= kCompileMin) {
            if (Level < runtime_min()) return;
            Shard& s = bind();
            DiagnosticRecord* slot = s.ring.acquire_slot();
            if (!slot) {                       // FULL: drop-newest policy
                ++s.local.dropped;             // plain increment, thread-owned
                s.pub_dropped.store(s.local.dropped, std::memory_order_relaxed);
                return;                        // NEVER log the logging failure
            }
            *slot = make_record(Level, code, site, now_ns(), ++s.sequence, vs...);
            slot->producer_id = s.id;
            s.ring.publish();
            ++s.local.emitted;
            // Wake the drain only on empty -> non-empty, not per record.
            if (s.ring.size_approx() == 1) notify();
        }
    }

    static std::uint64_t now_ns() noexcept {
        using namespace std::chrono;
        return static_cast<std::uint64_t>(
            duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count());
    }

    // ---- drain ------------------------------------------------------------
    void start() {
        drain_ = std::jthread{[this](std::stop_token st) { drain_loop(st); }};
    }
    void stop_and_join() noexcept {
        if (drain_.joinable()) {
            drain_.request_stop();
            notify();
            drain_.join();                    // jthread would also do this in its dtor
        }
    }

private:
    void notify() noexcept {
        pending_.store(true, std::memory_order_release);
        pending_.notify_one();                // C++20 atomic wait/notify, no mutex
    }

    void drain_loop(std::stop_token st) {
        std::array<DiagnosticRecord, 256> buf{};
        auto const dwell = std::chrono::milliseconds{5};
        while (!st.stop_requested()) {
            std::size_t moved = drain_once(buf);
            if (moved == 0) {
                pending_.store(false, std::memory_order_relaxed);
                pending_.wait(false);         // blocks until notify() flips it
            } else if (batch_.size() >= kBatchBytes || since_flush() >= dwell) {
                flush_batch();
            }
        }
        while (drain_once(buf) != 0) {}       // final sweep after stop
        flush_batch();
        sink_->flush();
    }

    std::size_t drain_once(std::span<DiagnosticRecord> buf) {
        std::size_t total = 0;
        for (auto& s : shards_) {             // round-robin: no shard starves
            std::size_t const n = s.ring.pop_batch(buf);
            for (std::size_t i = 0; i < n; ++i) {
                scratch_.clear();
                render(scratch_, buf[i], dictionary_lookup(buf[i].site_id));
                batch_.append(scratch_);
            }
            total += n;
            std::uint64_t const dropped = s.pub_dropped.load(std::memory_order_relaxed);
            if (dropped != seen_dropped_[&s - shards_.data()]) {
                seen_dropped_[&s - shards_.data()] = dropped;
                emit_loss_summary(s.id, dropped);   // reported in a separate channel
            }
        }
        return total;
    }

    void flush_batch() {
        if (!batch_.empty()) { sink_->write(batch_); batch_.clear(); }
        last_flush_ = std::chrono::steady_clock::now();
    }
    std::chrono::steady_clock::duration since_flush() const {
        return std::chrono::steady_clock::now() - last_flush_;
    }
    std::string_view dictionary_lookup(std::uint32_t site) const;   // build-generated
    void emit_loss_summary(std::uint8_t producer, std::uint64_t dropped);

    static constexpr std::size_t kBatchBytes = 32u << 10;

    std::unique_ptr<Sink> sink_;
    std::vector<Shard> shards_;
    std::array<std::uint64_t, kMaxProducers> seen_dropped_{};
    std::string batch_;                       // reserved once, reused forever
    std::string scratch_;
    std::atomic<LogLevel> runtime_min_{LogLevel::info};
    std::atomic<bool> pending_{false};
    std::chrono::steady_clock::time_point last_flush_{};
    std::jthread drain_{};                    // declared LAST: joined first at teardown
};
```

| Mechanism | Ordering / cost | Why here |
|---|---|---|
| `tail_.store(t+1, release)` | publishes the slot writes | consumer's `acquire` on `tail_` sees them |
| `head_.load(acquire)` on the producer | one cache-line pull, only when apparently full | `cached_head_` amortizes it |
| `cached_head_` / `cached_tail_` | 0 atomics in the common case | removes the ping-pong on the other side's index |
| `alignas(kLine)` on head/tail | avoids false sharing of the two indices | the single biggest SPSC win |
| power-of-two `kMask` | `&` instead of `%` | index is a monotonically growing `size_t` |
| `std::atomic<bool>::wait/notify_one` | C++20; futex-like, no mutex on producer | wake only on empty→non-empty |
| `std::jthread` + `std::stop_token` | C++20; joins in its destructor | deterministic shutdown |
| `pop_batch` | one acquire per batch, not per record | amortizes the drain's synchronization |

**Interview line** — "One SPSC ring per producer thread: the producer owns its tail and its counters, the drain owns every head, and no producer ever contends with another producer's cache line."

**Traps** — the unsigned `t - cached_head_` arithmetic is intentional and correct across wraparound of `size_t`; do not "fix" it with signed types · a shard shared by two threads silently breaks the SPSC contract, so make overflow a hard error or fall back to a mutexed slow path · `notify_one` on every record costs more than it saves · declaring `drain_` before the members it touches makes the destructor join *after* they die · calling `bind()` from the drain thread claims a shard nobody drains.

---

## 42.4 Drop, overwrite, block, and flush policies

| Policy | Producer behaviour | What you lose | When it fits |
|---|---|---|---|
| **Drop newest** | `try_push` fails, `++dropped`, return | the current record | default for diagnostics |
| **Overwrite oldest** | advance over the oldest slot | the *history*, plus ownership complexity | crash-dump ring, last-N-events |
| **Block** | wait for space | producer latency; telemetry stalls trading | audit/replay streams only |
| **Spin** | retry in a loop | CPU; deadlocks if the drain shares the core | never with a lower-priority drain |
| **Synchronous fallback** | format + write inline | tail latency explodes exactly during a burst | almost never |
| **Escalate / disable** | set a fault flag, stop detailed telemetry | detail, deliberately | controlled degradation |

```cpp
enum class FullPolicy : std::uint8_t { drop_newest, overwrite_oldest, block, degrade };

template<FullPolicy P>
bool emit_with_policy(Shard& s, DiagnosticRecord const& r) noexcept {
    if constexpr (P == FullPolicy::drop_newest) {
        if (s.ring.try_push(r)) { ++s.local.emitted; return true; }
        ++s.local.dropped;                       // counted, never logged
        return false;
    } else if constexpr (P == FullPolicy::block) {
        while (!s.ring.try_push(r)) {            // BLOCKS THE TRADING THREAD
            std::this_thread::yield();           // and yield is not a bounded wait
        }
        ++s.local.emitted;
        return true;
    } else if constexpr (P == FullPolicy::degrade) {
        if (s.ring.try_push(r)) { ++s.local.emitted; return true; }
        ++s.local.dropped;
        s.degraded.store(true, std::memory_order_relaxed);   // raise the level floor
        return false;
    }
}
```

```cpp
// ======== overwrite-oldest: producer owns the write index outright ========
// The consumer may be reading a slot the producer is about to reuse, so each
// slot carries a seqlock stamp: even == stable, odd == being written.
template<class T, std::size_t Capacity>
class OverwriteRing {
    static_assert(std::has_single_bit(Capacity));
    static_assert(std::is_trivially_copyable_v<T>);
    static constexpr std::size_t kMask = Capacity - 1;

    struct Slot {
        std::atomic<std::uint64_t> seq{0};      // 2*n+2 published, 2*n+1 writing
        T value{};
    };
    alignas(kLine) std::atomic<std::uint64_t> tail_{0};
    alignas(kLine) std::array<Slot, Capacity> slot_{};
    std::uint64_t read_{0};                     // consumer-private

public:
    void push(T const& v) noexcept {            // ALWAYS succeeds; never blocks
        std::uint64_t const t = tail_.load(std::memory_order_relaxed);
        Slot& s = slot_[t & kMask];
        s.seq.store(2 * t + 1, std::memory_order_release);   // odd: writing
        std::atomic_thread_fence(std::memory_order_release);
        s.value = v;
        s.seq.store(2 * t + 2, std::memory_order_release);   // even: published
        tail_.store(t + 1, std::memory_order_release);
    }

    // Returns false when empty; increments `lost` for every lapped record.
    bool try_pop(T& out, std::uint64_t& lost) noexcept {
        std::uint64_t const end = tail_.load(std::memory_order_acquire);
        if (read_ == end) return false;
        if (end - read_ > Capacity) {                        // producer lapped us
            lost += (end - Capacity) - read_;
            read_ = end - Capacity;                          // jump to oldest survivor
        }
        Slot& s = slot_[read_ & kMask];
        std::uint64_t const before = s.seq.load(std::memory_order_acquire);
        if (before != 2 * read_ + 2) { ++read_; ++lost; return false; }  // torn/reused
        out = s.value;                                       // racy read, see traps
        std::atomic_thread_fence(std::memory_order_acquire);
        if (s.seq.load(std::memory_order_relaxed) != before) { ++read_; ++lost; return false; }
        ++read_;
        return true;
    }
};
// FORMAL NOTE: the unsynchronized `out = s.value` is a data race in the abstract
// machine. The rigorous spelling copies through `std::atomic_ref<std::uint64_t>`
// word by word (or memcpy of an atomic byte array); see the seqlock in #ch40.
```

```cpp
// ======== bounded blocking with a deadline: the only defensible "block" ====
bool push_until(SpscRing<DiagnosticRecord, 4096>& ring, DiagnosticRecord const& r,
                std::chrono::steady_clock::time_point deadline) noexcept {
    while (!ring.try_push(r)) {
        if (std::chrono::steady_clock::now() >= deadline) return false;  // then drop
        std::this_thread::yield();
    }
    return true;
}
```

```cpp
// ======== rate limiting: a token bucket with no allocation and no clock ====
struct SiteThrottle {                     // one per site, producer-owned
    std::uint32_t seen{};
    std::uint32_t suppressed{};
    std::uint32_t limit{100};             // first 100 per window, then 1-in-1024
    bool admit() noexcept {
        if (++seen <= limit) return true;
        if ((seen & 1023u) == 0) return true;
        ++suppressed;
        return false;                     // `suppressed` is emitted with the next admit
    }
};
```

**"Flush" means five different things — promise exactly one**

| Level | Operation | Can it block/fail? |
|---|---|---|
| 1 | producer rings drained into process memory | no (bounded work) |
| 2 | encoder/batch buffer handed to the sink | no |
| 3 | sink issued an OS `write` | yes — short writes, `EINTR` |
| 4 | file data synchronized to storage (`fsync`) | yes — milliseconds to seconds |
| 5 | remote collector acknowledged | yes — indefinitely |

```text
Shutdown sequence — every step is observable and testable
1 close logger acceptance (producers see enabled() == false)
2 producers publish end markers + final counter/histogram snapshots
3 drain each ring to empty, or discard with an explicit counted policy
4 flush to the PROMISED level (1..5), no further
5 request_stop + join the drain thread
6 destroy rings, dictionary, batch buffers, sink — in that order
```

**Traps** — blocking on an `error`-level log turns a burst into a stall that produces more errors (telemetry feedback collapse) · a `dropped` counter that lives *inside* the queue is lost exactly when it matters · overwrite-oldest breaks the plain SPSC ownership model, so it needs the seqlock stamps above · `std::this_thread::yield()` is a hint with no bound · static-duration components logging from destructors after the logger died is a static-destruction-order bug — own the logger from `main` and destroy it *after* its producers · promising `fsync` durability from a `noexcept` path is a lie.

---

## 42.5 Allocation-free counters and histograms

```cpp
// ---- cheapest correct counter: one thread owns it, full stop -------------
struct alignas(kLine) Counters {          // pad the SHARD, not each field
    std::uint64_t messages{};
    std::uint64_t rejects{};
    std::uint64_t queue_full{};
    std::uint64_t bytes_in{};
};
thread_local Counters tls_counters;       // plain ++ compiles to one add

// ---- shared independent statistic: relaxed atomic ------------------------
std::atomic<std::uint64_t> global_failures{0};
global_failures.fetch_add(1, std::memory_order_relaxed);       // atomicity only
auto n = global_failures.load(std::memory_order_relaxed);
global_failures.store(0, std::memory_order_relaxed);           // reset (racy vs adds)
```

```cpp
// ---- safe publication of a plain shard: generation-stamped snapshot ------
struct alignas(kLine) PublishedCounters {
    std::atomic<std::uint32_t> generation{0};   // odd == writer in progress
    Counters value{};

    void publish(Counters const& c) noexcept {              // owner thread only
        auto g = generation.load(std::memory_order_relaxed);
        generation.store(g + 1, std::memory_order_release);  // odd
        std::atomic_thread_fence(std::memory_order_release);
        value = c;
        generation.store(g + 2, std::memory_order_release);  // even, consistent
    }
    bool read(Counters& out) const noexcept {               // any reader
        auto g0 = generation.load(std::memory_order_acquire);
        if (g0 & 1u) return false;                          // writer active
        out = value;
        std::atomic_thread_fence(std::memory_order_acquire);
        return generation.load(std::memory_order_relaxed) == g0;
    }
};
// One consistent multi-field sample; retry on false. Independent relaxed atomics
// give you N atomic reads, NOT one coherent snapshot.
```

```cpp
// ---- log2 histogram: O(1), branchless bucket, 65 * 8 = 520 bytes ---------
#include <bit>
#include <algorithm>
#include <numeric>

template<std::size_t N = 65>
struct Log2Histogram {
    std::array<std::uint64_t, N> bucket{};
    std::uint64_t count{};
    std::uint64_t sum{};
    std::uint64_t max{};

    void observe(std::uint64_t v) noexcept {
        std::size_t const i = (v == 0) ? 0
            : static_cast<std::size_t>(64 - std::countl_zero(v));   // bit width
        ++bucket[i < N ? i : N - 1];
        ++count;
        sum += v;
        if (v > max) max = v;
    }
    // bucket 0 == {0}; bucket i>0 covers [2^(i-1), 2^i)
    static constexpr std::uint64_t lower_edge(std::size_t i) noexcept {
        return i == 0 ? 0 : (std::uint64_t{1} << (i - 1));
    }
    void merge(Log2Histogram const& o) noexcept {
        for (std::size_t i = 0; i < N; ++i) bucket[i] += o.bucket[i];
        count += o.count; sum += o.sum; max = std::max(max, o.max);
    }
    void reset() noexcept { *this = Log2Histogram{}; }

    // Quantile from MERGED counts. Linear interpolation inside the bucket.
    double quantile(double q) const noexcept {
        if (count == 0) return 0.0;
        auto const target = static_cast<std::uint64_t>(q * static_cast<double>(count));
        std::uint64_t seen = 0;
        for (std::size_t i = 0; i < N; ++i) {
            if (seen + bucket[i] > target) {
                double const lo = static_cast<double>(lower_edge(i));
                double const hi = (i + 1 < N) ? static_cast<double>(lower_edge(i + 1))
                                              : static_cast<double>(max);
                double const frac = bucket[i] ? double(target - seen) / double(bucket[i]) : 0.0;
                return lo + frac * (hi - lo);
            }
            seen += bucket[i];
        }
        return static_cast<double>(max);
    }
};
```

```cpp
// ---- finer resolution: sub-buckets per power of two (HdrHistogram shape) --
template<std::size_t SubBits = 3, std::size_t Buckets = 64>
struct LogLinearHistogram {
    static constexpr std::size_t kSub = std::size_t{1} << SubBits;   // 8 per octave
    std::array<std::uint64_t, Buckets * kSub> bucket{};
    std::uint64_t count{};

    static std::size_t index(std::uint64_t v) noexcept {
        if (v < kSub) return static_cast<std::size_t>(v);             // linear floor
        auto const width = static_cast<std::size_t>(64 - std::countl_zero(v));
        auto const shift = width - SubBits - 1;
        auto const sub   = static_cast<std::size_t>((v >> shift) & (kSub - 1));
        return (shift + 1) * kSub + sub;
    }
    void observe(std::uint64_t v) noexcept {
        std::size_t const i = index(v);
        ++bucket[i < bucket.size() ? i : bucket.size() - 1];
        ++count;
    }
};
// Relative error is bounded by 2^-SubBits (~12.5% at SubBits=3, ~1.6% at 6).
```

```cpp
// ---- explicit boundaries: choose the search that fits the domain ---------
template<std::size_t N>
struct BoundedHistogram {
    std::array<std::uint64_t, N> upper{};        // strictly increasing, sorted
    std::array<std::uint64_t, N + 1> count{};    // count[N] is the overflow bucket

    void observe(std::uint64_t v) noexcept {     // O(log N)
        auto const it = std::ranges::lower_bound(upper, v);
        ++count[static_cast<std::size_t>(it - upper.begin())];
    }
    void observe_linear(std::uint64_t v) noexcept {   // often faster for N <= 8
        std::size_t i = 0;
        while (i < N && v > upper[i]) ++i;
        ++count[i];
    }
};
```

```cpp
// ---- race-free snapshot: double buffer with an atomic side flip ----------
struct HistogramPair {
    std::array<Log2Histogram<>, 2> h{};
    std::atomic<std::uint32_t> side{0};          // producer reads, drain flips

    void observe(std::uint64_t v) noexcept {     // producer thread only
        h[side.load(std::memory_order_acquire) & 1u].observe(v);
    }
    Log2Histogram<> take() noexcept {            // drain thread only
        auto const s = side.load(std::memory_order_relaxed) & 1u;
        side.store(s ^ 1u, std::memory_order_release);   // producer moves to the other
        // A grace period is required: the producer may still be mid-observe on `s`.
        std::this_thread::sleep_for(std::chrono::milliseconds{1});   // or an epoch/RCU
        auto out = h[s];
        h[s].reset();
        return out;
    }
};
```

| Approach | Producer cost | Reader safety | Notes |
|---|---|---|---|
| plain `thread_local` counter | 1 add, no fence | **UB to read concurrently** | join, hand off, or publish |
| generation-stamped snapshot | 2 stores + fence per publish | consistent multi-field sample | publish on a dwell boundary |
| `atomic<uint64_t>` relaxed | 1 `lock xadd`, owns the line | always safe | contention = line ping-pong |
| per-shard atomic + summation | 1 add on a private line | safe, not a coherent instant | the standard shape |
| `Log2Histogram::observe` | `lzcnt` + add | producer-owned | 520 B, constant time |
| `BoundedHistogram::observe` | `lower_bound`, O(log N) | producer-owned | branchy; benchmark real distributions |
| double-buffer flip | one relaxed load per observe | needs a grace period | or use two shards and swap ownership |

**Interview line** — "You cannot average per-thread p99s: merge the bucket counts into one distribution first, then read the quantile off the merged histogram."

**Traps** — `std::hardware_destructive_interference_size` is an implementation constant, not a physical one, and using it in a class layout that crosses TUs with different values is an ODR hazard · unsigned counters wrap silently — decide wrap vs saturate vs 128-bit aggregation · reading four independent relaxed atomics is four samples, not one · padding *every* field to 64 B multiplies a 4-field shard from 32 B to 256 B · resetting a counter with `store(0)` races with concurrent `fetch_add`s (use `exchange(0)`) · a double buffer without a grace period still races with an in-flight `observe`.

---

## 42.6 Fatal-path constraints and crash-safe minimalism

```text
At fatal time, assume these are unusable:
  allocator metadata   (corrupt or exhausted)
  the logger mutex     (possibly held by THIS thread)
  the drain thread     (stopped, or waiting on the lock you hold)
  the stack            (small, corrupted, or exhausted)
  iostreams / locales  (partially constructed or already destroyed)
  another thread       (failing simultaneously in the same handler)
```

```cpp
// ---- preallocated, trivially copyable, fixed-size fatal record -----------
struct FatalRecord {
    std::uint32_t magic{0x46'41'54'4C};   // "FATL"
    std::uint32_t code{};
    std::uint64_t sequence{};
    std::uint64_t arg0{};
    std::uint64_t arg1{};
    std::uint32_t site_id{};
    std::uint32_t thread_hint{};
};
static_assert(std::is_trivially_copyable_v<FatalRecord>);

// Storage and the descriptor are established during normal startup, never at
// fatal time: no open(), no malloc, no lazy static initialization.
alignas(kLine) inline FatalRecord g_fatal{};
inline std::atomic<int> g_fatal_fd{-1};
inline std::atomic_flag g_fatal_entered = ATOMIC_FLAG_INIT;   // recursion guard
```

```cpp
// ---- async-signal-safe integer formatting: no <format>, no locale --------
inline char* u64_to_dec(std::uint64_t v, char* end) noexcept {   // writes backwards
    do { *--end = static_cast<char>('0' + (v % 10)); v /= 10; } while (v);
    return end;                                                  // start of digits
}
inline char* u64_to_hex(std::uint64_t v, char* end, int digits) noexcept {
    for (int i = 0; i < digits; ++i) { *--end = "0123456789abcdef"[v & 0xF]; v >>= 4; }
    return end;
}
```

```cpp
// ---- the tiny audited platform layer (POSIX): the ONLY non-portable part -
#if defined(__unix__) || defined(__APPLE__)
#include <unistd.h>
#include <cerrno>

inline void raw_write(int fd, char const* p, std::size_t n) noexcept {
    while (n) {
        ssize_t const w = ::write(fd, p, n);          // async-signal-safe
        if (w > 0) { p += w; n -= static_cast<std::size_t>(w); continue; }
        if (w < 0 && errno == EINTR) continue;        // retry
        return;                                       // best effort; give up silently
    }
}
#else
inline void raw_write(int, char const*, std::size_t) noexcept {}   // stub
#endif
```

```cpp
// ---- the fatal handler: no allocation, no locks, no recursion ------------
[[noreturn]] void fatal(std::uint32_t code, std::uint64_t a0, std::uint64_t a1,
                        SiteId site) noexcept {
    if (g_fatal_entered.test_and_set(std::memory_order_acq_rel)) {
        std::_Exit(EXIT_FAILURE);          // second entry: leave immediately
    }
    g_fatal.code = code;
    g_fatal.arg0 = a0;
    g_fatal.arg1 = a1;
    g_fatal.site_id = site.value;

    char buf[128];                          // stack array, fixed size
    char* end = buf + sizeof buf;
    char* p   = end;
    *--p = '\n';
    p = u64_to_hex(a1, p, 16); *--p = ' ';
    p = u64_to_hex(a0, p, 16); *--p = ' ';
    p = u64_to_dec(code, p);
    char const tag[] = "FATAL ";
    for (std::size_t i = sizeof(tag) - 1; i-- > 0; ) *--p = tag[i];

    int const fd = g_fatal_fd.load(std::memory_order_relaxed);
    if (fd >= 0) {
        raw_write(fd, p, static_cast<std::size_t>(end - p));      // text line
        raw_write(fd, reinterpret_cast<char const*>(&g_fatal), sizeof g_fatal);
    }
    std::_Exit(EXIT_FAILURE);              // NO static destructors, NO atexit, NO flush
}
```

| Termination route | Runs dtors of automatics | Runs static dtors / `atexit` | Flushes `stdio` | Handler |
|---|---|---|---|---|
| return from `main` | yes (unwinds normally) | yes | yes | — |
| `std::exit` | **no** | yes | yes | — |
| `std::quick_exit` | no | no (runs `at_quick_exit`) | no | — |
| `std::_Exit` | no | no | **no** | — |
| `std::abort` | no | no | no | `SIGABRT` |
| `std::terminate` | no | no | no | `std::terminate_handler` |
| uncaught exception | implementation-defined whether the stack unwinds | — | — | `terminate` |
| escaping a `noexcept` fn | no | no | no | `terminate` |

```cpp
// ---- assertions: invariants only, plus real production handling ---------
#include <cassert>
assert(head <= tail);                  // COMPILED OUT under NDEBUG

#define QS_CHECK(cond, code)                                                  \
    do { if (!(cond)) ::fatal((code), 0, 0, ::site_id()); } while (false)
// QS_CHECK survives NDEBUG: use it for anything whose failure is unrecoverable.
// Untrusted input is validated with ordinary control flow, never an assert.

// C++23 contract-adjacent spellings:
[[assume(n > 0)]];                     // C++23: UB if false — an optimizer promise
if (bad) std::unreachable();           // C++23: UB if reached — not a check
```

**Traps** — `std::abort` inside a signal handler while another thread holds the malloc lock can hang instead of dying · reporting an enqueue failure through the same logger recurses until the stack dies (the `g_fatal_entered` flag is not optional) · `std::_Exit` skips every flush, so any promise of durable output there is false · portable C++ has *no* async-signal-safe I/O — `raw_write` is the audited exception, and `std::print`/`iostreams` are not permitted here · a fatal handler that takes the logger mutex deadlocks precisely when the failing thread already holds it · `assert` for input validation ships a program with no validation.

---

## 42.7 Avoiding measurement-induced latency

| Hidden cost | Typical magnitude | Mitigation |
|---|---|---|
| `steady_clock::now()` per event | 15–30 ns (vDSO) or a full syscall | timestamp per batch; or read the TSC |
| shared atomic increment | 20–100 ns under contention (line transfer) | per-shard counters, sum later |
| unpredictable level branch | ~15–20 cycles per misprediction | `if constexpr` removal; `[[likely]]` |
| integer/float formatting | 20–200 ns | defer to the drain entirely |
| `std::string` construction | allocation + possible page fault | fixed `Arg`s and inline `str8` |
| queue notify/wakeup | ~1–5 µs futex round trip | notify on empty→non-empty only |
| large record memcpy | L1 pollution, extra lines dirtied | budget `sizeof(Record)` ≤ 2 lines |
| lazy `thread_local` init | a guard branch + possible call on first use | `constinit`/POD TLS, or warm at start |
| I/O lock + syscall | µs to ms, unbounded under load | drain thread, batched writes |
| exception unwind on the error path | µs, and it is not `noexcept` | error codes on hot paths |

```cpp
// ---- count everything, time a sample ------------------------------------
struct Sampler {
    std::uint32_t n{};
    static constexpr std::uint32_t kMask = 1023;      // 1-in-1024, power of two
    [[nodiscard]] bool should_time() noexcept { return (++n & kMask) == 0; }
};
// Deterministic, thread-local, one add + one test. A shared PRNG adds contention
// and nondeterminism; a fixed stride can ALIAS a periodic workload — vary the
// stride (e.g. mask ^= n >> 10) if aliasing is plausible.
```

```cpp
// ---- batch timestamps: one clock read for a whole burst -----------------
std::uint64_t const batch_ns = Logger::now_ns();     // once per event-loop iteration
for (auto const& msg : batch) {
    handle(msg);
    lg.emit_at<LogLevel::info>(EventCode::heartbeat, site_id(), batch_ns, msg.id);
}
```

```cpp
// ---- constinit thread-local: no lazy-init guard on every access ---------
struct TlsBlock { Counters c{}; Sampler s{}; std::uint64_t seq{}; };
constinit thread_local TlsBlock tls{};    // C++20: guaranteed static init, no guard
// A thread_local with a non-trivial constructor costs a TLS-guard branch per access
// in the general (dynamic-initialization) case.
```

```cpp
// ---- hot/cold split: keep the disabled path to one predictable branch ----
class Stream {
    std::atomic<LogLevel> min_{LogLevel::info};      // hot: one word, read-mostly
    Logger* lg_{};                                   // cold
public:
    template<LogLevel L, class... Ts>
    void log(EventCode c, SiteId s, Ts... vs) noexcept {
        if constexpr (L >= kCompileMin) {
            if (L < min_.load(std::memory_order_relaxed)) [[likely]] return;  // C++20
            slow_emit<L>(c, s, vs...);               // out-of-line: no I-cache cost
        }
    }
private:
    template<LogLevel L, class... Ts>
    [[gnu::noinline]] void slow_emit(EventCode, SiteId, Ts...) noexcept;
};
```

```cpp
// ---- benchmarking telemetry honestly ------------------------------------
// 1. disabled at compile time     -> proves only that the compiler deleted it
// 2. disabled at runtime          -> the real "off" cost: one load + one branch
// 3. enabled, queue empty         -> the common enabled case
// 4. enabled, queue near capacity -> the case that actually hurts
// 5. enabled, queue FULL          -> the drop path plus counter traffic
// 6. drain formatting + I/O measured SEPARATELY on its own thread
// Report producer p50 / p99 / p99.9 latency, never throughput alone.

static void bench(benchmark::State& st) {
    for (auto _ : st) {
        lg.emit_at<LogLevel::info>(EventCode::heartbeat, site_id(), 42ull);
        benchmark::ClobberMemory();          // stop DCE from deleting the store
    }
}
```

**Traps** — benchmarking the compile-time-disabled site and calling it "logging overhead" measures nothing · `rdtsc` is not a steady clock across cores/frequency states without an invariant-TSC guarantee · a 1-in-1024 sampler aliases a 1024-message frame perfectly and can measure only message #0 · timestamping a whole batch changes the semantics of the record, so say so in the schema · `[[likely]]`/`[[unlikely]]` are hints and can pessimize when wrong · touching a 256-byte record evicts four lines of order-book state.

---

## 42.8 Structured binary logs for deterministic replay

```text
A trivially copyable struct is NOT a wire format:
  padding bytes        (indeterminate; leak stack content)
  host endianness      (x86 LE vs a big-endian reader)
  enum underlying type (unfixed enums vary)
  ABI / layout drift   (a field added in v2 shifts everything)
  pointer values       (meaningless across processes)
  no version, no length, no way for an old reader to skip
```

```text
Frame layout — every field explicit, little-endian, no padding
 offset size field
 0      4    magic       'Q','S','L','1'
 4      2    schema_version
 6      2    record_length   (bytes AFTER this header field; bounds the read)
 8      2    event_code
 10     1    level
 11     1    flags           bit0 truncated, bit1 sampled, bit2 tsc-domain
 12     1    clock_domain    0 steady, 1 system, 2 tsc, 3 logical
 13     1    producer_id
 14     2    payload_len
 16     8    timestamp
 24     8    sequence
 32     4    site_id
 36     4    source_id
 40     4*N  args (tag:1, len:1, pad:2, value:8) — N from record_length
 ...    P    payload bytes
 last   4    crc32c over bytes [0, last)
```

```cpp
// ---- endian-explicit primitives: no memcpy of whole structs -------------
#include <bit>
#include <cstring>
#include <optional>
#include <expected>

inline void put_u8 (std::span<std::byte> b, std::size_t o, std::uint8_t v) noexcept {
    b[o] = static_cast<std::byte>(v);
}
inline void put_u16(std::span<std::byte> b, std::size_t o, std::uint16_t v) noexcept {
    b[o + 0] = static_cast<std::byte>(v & 0xFF);
    b[o + 1] = static_cast<std::byte>(v >> 8);
}
inline void put_u32(std::span<std::byte> b, std::size_t o, std::uint32_t v) noexcept {
    for (std::size_t i = 0; i < 4; ++i)
        b[o + i] = static_cast<std::byte>((v >> (8 * i)) & 0xFFu);
}
inline void put_u64(std::span<std::byte> b, std::size_t o, std::uint64_t v) noexcept {
    for (std::size_t i = 0; i < 8; ++i)
        b[o + i] = static_cast<std::byte>((v >> (8 * i)) & 0xFFu);
}
inline std::uint16_t get_u16(std::span<std::byte const> b, std::size_t o) noexcept {
    return static_cast<std::uint16_t>(std::to_integer<unsigned>(b[o]) |
                                     (std::to_integer<unsigned>(b[o + 1]) << 8));
}
inline std::uint32_t get_u32(std::span<std::byte const> b, std::size_t o) noexcept {
    std::uint32_t v = 0;
    for (std::size_t i = 0; i < 4; ++i)
        v |= static_cast<std::uint32_t>(std::to_integer<unsigned>(b[o + i])) << (8 * i);
    return v;
}
inline std::uint64_t get_u64(std::span<std::byte const> b, std::size_t o) noexcept {
    std::uint64_t v = 0;
    for (std::size_t i = 0; i < 8; ++i)
        v |= static_cast<std::uint64_t>(std::to_integer<unsigned>(b[o + i])) << (8 * i);
    return v;
}

// Doubles: fix the representation explicitly; bit_cast is C++20 and constexpr.
inline void put_f64(std::span<std::byte> b, std::size_t o, double d) noexcept {
    static_assert(std::numeric_limits<double>::is_iec559);      // IEEE-754 required
    put_u64(b, o, std::bit_cast<std::uint64_t>(d));
}
inline double get_f64(std::span<std::byte const> b, std::size_t o) noexcept {
    return std::bit_cast<double>(get_u64(b, o));
}
// std::byteswap(x) (C++23) and std::endian::native cover the "swap if BE" style.
```

```cpp
// ---- encoder: returns bytes written, or nullopt if the buffer is short ---
inline constexpr std::uint32_t kMagic = 0x314C5351u;  // 'QSL1' little-endian
inline constexpr std::uint16_t kSchema = 3;
inline constexpr std::size_t kHeaderBytes = 40;
inline constexpr std::size_t kArgBytes = 12;

std::uint32_t crc32c(std::span<std::byte const> data) noexcept;   // hardware or table

inline std::optional<std::size_t>
encode(DiagnosticRecord const& r, std::span<std::byte> out) noexcept {
    std::size_t nargs = 0;
    while (nargs < kMaxArgs && r.args[nargs].type != ArgType::none) ++nargs;
    std::size_t const total = kHeaderBytes + nargs * kArgBytes + r.payload_copied + 4;
    if (out.size() < total) return std::nullopt;                  // no overrun, ever

    put_u32(out, 0, kMagic);
    put_u16(out, 4, kSchema);
    put_u16(out, 6, static_cast<std::uint16_t>(total - 8));       // length AFTER 8
    put_u16(out, 8, static_cast<std::uint16_t>(r.code));
    put_u8 (out, 10, to_underlying(r.level));
    put_u8 (out, 11, r.flags);
    put_u8 (out, 12, 0);                                          // clock_domain=steady
    put_u8 (out, 13, r.producer_id);
    put_u16(out, 14, r.payload_copied);
    put_u64(out, 16, r.monotonic_ns);
    put_u64(out, 24, r.sequence);
    put_u32(out, 32, r.site_id);
    put_u32(out, 36, r.source_id);

    std::size_t o = kHeaderBytes;
    for (std::size_t i = 0; i < nargs; ++i) {
        put_u8 (out, o + 0, static_cast<std::uint8_t>(r.args[i].type));
        put_u8 (out, o + 1, r.args[i].len);
        put_u16(out, o + 2, 0);                                   // explicit filler
        if (r.args[i].type == ArgType::f64) put_f64(out, o + 4, r.args[i].value.d);
        else if (r.args[i].type == ArgType::str8)
            for (std::size_t k = 0; k < 8; ++k)
                put_u8(out, o + 4 + k, static_cast<std::uint8_t>(r.args[i].value.s[k]));
        else put_u64(out, o + 4, r.args[i].value.u);
        o += kArgBytes;
    }
    for (std::size_t i = 0; i < r.payload_copied; ++i) out[o + i] = r.payload[i];
    o += r.payload_copied;
    put_u32(out, o, crc32c(out.first(o)));                        // trailer checksum
    return total;
}
```

```cpp
// ---- decoder: every read is bounds-checked BEFORE it happens ------------
enum class DecodeError : std::uint8_t {
    short_buffer, bad_magic, unknown_version, bad_length, bad_crc, bad_arg_tag
};

struct Decoded { DiagnosticRecord record; std::size_t consumed; };

inline std::expected<Decoded, DecodeError>            // C++23 <expected>
decode(std::span<std::byte const> in) noexcept {
    if (in.size() < 8) return std::unexpected(DecodeError::short_buffer);
    if (get_u32(in, 0) != kMagic) return std::unexpected(DecodeError::bad_magic);
    std::uint16_t const ver = get_u16(in, 4);
    std::uint16_t const len = get_u16(in, 6);
    std::size_t const total = std::size_t{len} + 8;
    if (total < kHeaderBytes + 4) return std::unexpected(DecodeError::bad_length);
    if (in.size() < total)        return std::unexpected(DecodeError::short_buffer);
    // Forward compatibility: an OLD reader still SKIPS a newer record safely,
    // because framing (magic/version/length/crc) is frozen for all versions.
    if (ver > kSchema) return std::unexpected(DecodeError::unknown_version);
    if (crc32c(in.first(total - 4)) != get_u32(in, total - 4))
        return std::unexpected(DecodeError::bad_crc);

    std::uint16_t const payload_len = get_u16(in, 14);
    std::size_t const body = total - kHeaderBytes - 4;
    if (payload_len > body) return std::unexpected(DecodeError::bad_length);
    std::size_t const arg_bytes = body - payload_len;
    if (arg_bytes % kArgBytes) return std::unexpected(DecodeError::bad_length);
    std::size_t const nargs = arg_bytes / kArgBytes;
    if (nargs > kMaxArgs)    return std::unexpected(DecodeError::bad_length);

    Decoded d{};
    d.consumed = total;
    d.record.code          = static_cast<EventCode>(get_u16(in, 8));
    d.record.level         = static_cast<LogLevel>(std::to_integer<std::uint8_t>(in[10]));
    d.record.flags         = std::to_integer<std::uint8_t>(in[11]);
    d.record.producer_id   = std::to_integer<std::uint8_t>(in[13]);
    d.record.payload_copied= payload_len;
    d.record.monotonic_ns  = get_u64(in, 16);
    d.record.sequence      = get_u64(in, 24);
    d.record.site_id       = get_u32(in, 32);
    d.record.source_id     = get_u32(in, 36);

    std::size_t o = kHeaderBytes;
    for (std::size_t i = 0; i < nargs; ++i, o += kArgBytes) {
        auto const tag = std::to_integer<std::uint8_t>(in[o]);
        if (tag > static_cast<std::uint8_t>(ArgType::id32))
            return std::unexpected(DecodeError::bad_arg_tag);      // reject, not assume
        d.record.args[i].type  = static_cast<ArgType>(tag);
        d.record.args[i].len   = std::to_integer<std::uint8_t>(in[o + 1]);
        d.record.args[i].value.u = get_u64(in, o + 4);
    }
    for (std::size_t i = 0; i < payload_len && i < kInlineBytes; ++i)
        d.record.payload[i] = in[o + i];
    return d;
}
```

```cpp
// ---- streaming reader: resynchronize without ever overreading -----------
std::size_t replay(std::span<std::byte const> file,
                   auto&& on_record, std::uint64_t& bad) noexcept {
    std::size_t off = 0, ok = 0;
    while (off + 8 <= file.size()) {
        auto const r = decode(file.subspan(off));
        if (r) { on_record(r->record); off += r->consumed; ++ok; continue; }
        if (r.error() == DecodeError::short_buffer) break;          // truncated tail
        ++bad;
        ++off;                                                      // rescan for magic
    }
    return ok;
}
```

**Determinism checklist for a replay stream**

| Requirement | Concretely |
|---|---|
| explicit ordering | per-producer `sequence`, plus a global sequence if a total order is needed |
| clock domain named | `clock_domain` byte; never mix `steady` and `system` values silently |
| no native dumps | field-wise encode only; no `memcpy` of the struct |
| no pointer identity | site IDs and handles, never addresses |
| deterministic truncation | fixed `kInlineBytes` and a recorded `payload_original` |
| schema recorded | `schema_version` in **every** record, not just a file header |
| integrity | crc32c per record; a state digest at checkpoints |
| loss semantics | a replay stream may **not** share the diagnostics stream's best-effort policy |

**Interview line** — "Diagnostics may drop; a replay capture whose correctness requires every record needs its own queue, its own full-queue policy, and its own durability promise — never the same 'best effort' as the log."

**Traps** — a global atomic sequence counter buys total order at the price of one contended cache line on every producer · merging by timestamp is approximate: clock reads happen at different points inside each producer's critical section and ties are unordered · `record_length` must be validated *before* any field read, or a corrupt file becomes an overread · omitting the per-record version means one schema change orphans the whole file · `crc32c` over a buffer containing padding you never wrote makes the checksum nondeterministic — encode every byte explicitly · `std::bit_cast<double>` requires IEC 559, so assert it.
