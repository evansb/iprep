# 39. Market-data pipeline in C++

*Part VI-B — Quant blueprints: pipeline, publication, and runtime*

---

**Recall**
- A market-data pipeline is an ownership-and-state machine, not a chain of function calls: every arrow needs an owner, a lifetime, a failure policy, and a thread.
- `std::span` and `std::string_view` are borrowed pointer+length pairs — they never extend the lifetime of the receive buffer.
- Borrowed bytes may cross a *synchronous* call boundary; they may never cross an *asynchronous* (queue/thread) boundary.
- Reinterpreting wire bytes as a packed struct is undefined: alignment, padding, endianness, aliasing, and object lifetime all break it.
- Validate bounds *before* every field load, and consume input bytes only *after* all validation of that frame succeeds.
- `incomplete` is flow control, not corruption — model "need more bytes" separately from "malformed frame".
- Decode understands protocol representation; normalize establishes internal invariants; keep protocol quirks on the wire side of the boundary.
- Normalized events must own everything they need, because the receive block is refilled immediately after.
- Prices are scaled integers (ticks); binary floating point in a book is a correctness bug, not a performance one.
- Sequence handling is a state machine (`cold`/`live`/`recovering`/`failed`), not an `if` scattered through the decoder.
- Exactly one thread mutates each book; partition by instrument/shard rather than adding a mutex per field.
- An SPSC handoff carries an *owning value or ownership token* — the release/acquire edge publishes everything the producer wrote to the payload.
- One SPSC queue per direction: filled batches downstream, empty batches back, or the "single producer" claim is false.
- Bounded capacity is part of correctness: every full-queue path needs a named policy (reject / drop-newest / drop-oldest / spin / block / recover).
- For ordered incremental state, silently dropping one event and applying later ones is incoherent — a full queue must trigger gap recovery.
- "Zero allocation" means zero *dynamic* allocation during a defined phase; `reserve` without an enforced hard bound proves nothing.
- Timestamps from different clock domains are different types; subtracting them is the classic negative-latency bug.
- Publish state as a complete immutable snapshot behind one release edge; per-field atomics do not make a multi-field transaction.
- Recovery builds a *candidate* state off to the side and promotes it in one transition — never a hybrid of stale and rebuilt state.
- Capture at the byte/frame boundary so replay drives the identical framer → decoder → normalizer → sequencer → book path.
- Shutdown is a protocol (stop → close → drain/discard → release → join → destroy); destructor order alone is not one.

**Interview line** — "Bytes stay borrowed only while their owner is stable, normalized values cross explicit bounded boundaries, one writer applies a total event order, and readers only ever see completely published state."

---

## 39.1 Byte source → framer → decoder → normalizer → book → consumer

```text
owned receive block          (input/buffer pool owns the storage)
   │ std::span<std::byte const>   borrowed, bounded lifetime
   ▼
framer      → complete wire frame + consumed_bytes | need-more | malformed
   │
   ▼
decoder     → protocol-typed WireMessage | DecodeError      (bounds + endian only)
   │
   ▼
normalizer  → owning internal BookEvent | NormalizeError    (invariants established)
   │
   ▼
sequencer   → in-order SequencedEvent | gap → recovery transition
   │
   ▼
single-writer Book ──► derived events / immutable snapshots
   ├──► strategy consumer      (SPSC, owning values)
   ├──► capture / replay       (owned bytes at the frame boundary)
   └──► telemetry              (thread-local counters, sampled)
```

Five questions per arrow: **who owns it · how long is it valid · can the handoff allocate/block/throw/drop · which thread may mutate it · what happens at capacity, malformed input, gap, and shutdown.**

```cpp
// ---- shared vocabulary used by every stage in this chapter --------------
#include <array>
#include <bit>
#include <cassert>
#include <chrono>
#include <compare>
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <expected>          // C++23
#include <optional>
#include <span>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

// Strong value types: trivially copyable, same size as the primitive.
struct PriceTicks { std::int64_t  value{}; friend constexpr auto operator<=>(PriceTicks, PriceTicks) = default; };
struct Quantity   { std::uint64_t value{}; friend constexpr auto operator<=>(Quantity,   Quantity)   = default; };
struct OrderId    { std::uint64_t value{}; friend constexpr auto operator<=>(OrderId,    OrderId)    = default; };
struct Sequence   { std::uint64_t value{}; friend constexpr auto operator<=>(Sequence,   Sequence)   = default; };

enum class Side : std::uint8_t { bid, ask };

static_assert(std::is_trivially_copyable_v<PriceTicks>);
static_assert(sizeof(PriceTicks) == sizeof(std::int64_t));   // ABI expectation of THIS design
static_assert(std::is_trivially_copyable_v<Sequence>);

// Internal event sum type — owning, closed set, exhaustively dispatchable.
struct Add     { OrderId id; PriceTicks price; Quantity quantity; Side side; };
struct Cancel  { OrderId id; Quantity quantity; };
struct Execute { OrderId id; Quantity quantity; };
struct Clear   { };                                   // e.g. start-of-day / recovery base

using BookEvent = std::variant<Add, Cancel, Execute, Clear>;

struct SequencedEvent {
    Sequence  sequence{};
    BookEvent event{};
};
static_assert(std::is_trivially_copyable_v<Add>);
```

```cpp
// ---- the narrow stage concept ------------------------------------------
template<class Stage, class Input>
concept PipelineStage = requires(Stage& s, Input in) {
    { s.on(in) } -> std::same_as<void>;   // shape only
};
// A concept constrains SYNTAX. Ownership, error type, capacity, and thread
// affinity are still contract, not compiler-checked.
```

| Stage | Input | Output | May allocate? | Thread |
|---|---|---|---|---|
| Byte source | socket/file | owned block | warmup only | I/O |
| Framer | `span<byte const>` | `FrameView` + consumed | no | I/O |
| Decoder | `span<byte const>` | `WireMessage` | no | I/O |
| Normalizer | `WireMessage` | owning `BookEvent` | no | I/O |
| Sequencer | `SequencedEvent` | apply / gap | no | I/O |
| Handoff | owning batch | queue slot | no | boundary |
| Book | `BookEvent` | snapshots | warmup only | book owner |

**Traps** — a `span` returned by the framer dies when the block compacts · calling the decoder before the framer proved completeness · normalizing on the consumer thread after the producer refilled the buffer · one giant `handle_packet()` that does all five jobs and can therefore never be unit-tested.

---

## 39.2 Ownership and lifetime at every stage

| Artifact | Owner | Representation | Valid until |
|---|---|---|---|
| Receive block | buffer pool | `ByteBlock<N>` / owned `vector<byte>` | block released/reused |
| Frame payload | receive block | `std::span<std::byte const>` | owner reuses block |
| Decoded string field | receive block | `std::string_view` / `span` | same borrowed lifetime |
| Normalized event | batch / queue slot | owning trivially-copyable value | slot reused |
| Book node | book pool | index + generation handle | slot freed/reused |
| Published snapshot | snapshot publisher | immutable buffer + version | reader releases / version retires |
| Capture record | capture queue | owned header + owned bytes | writer completes |
| Error record | fixed-size struct | `PipelineError` (no strings) | copied out |

```cpp
// ---- borrow vs own -----------------------------------------------------
struct WireFrameView {
    Sequence sequence{};
    std::span<std::byte const> payload;   // OBSERVATION ONLY — no lifetime extension
};

void decode_now(WireFrameView);           // OK: completes before the block is reused
// queue.try_push(frame);                 // UB-shaped: block may be refilled first

// Safe ways to cross an asynchronous boundary:
//  1. move the whole receive block (transfer ownership of the storage);
//  2. copy required fields into an owning normalized event  <-- usually cheapest;
//  3. queue a pool handle {index, generation} plus a release protocol;
//  4. keep framing/decoding/normalizing on the buffer-owning thread, queue values.
```

```cpp
// ---- fixed-capacity receive block --------------------------------------
#include <algorithm>

template<std::size_t Capacity>
class ByteBlock {
public:
    [[nodiscard]] std::span<std::byte> writable_tail() noexcept {
        return {storage_.data() + size_, Capacity - size_};
    }
    [[nodiscard]] std::span<std::byte const> readable() const noexcept {
        return {storage_.data(), size_};
    }
    [[nodiscard]] bool commit(std::size_t n) noexcept {           // bytes just received
        if (n > Capacity - size_) return false;
        size_ += n;
        return true;
    }
    void consume_prefix(std::size_t n) noexcept {                 // drop fully framed bytes
        assert(n <= size_);
        std::ranges::move(storage_.begin() + static_cast<std::ptrdiff_t>(n),
                          storage_.begin() + static_cast<std::ptrdiff_t>(size_),
                          storage_.begin());                      // O(remaining) compaction
        size_ -= n;
        // EVERY span previously handed out is now dangling. Contract: none outlive this call.
    }
    void reset() noexcept { size_ = 0; }
    [[nodiscard]] std::size_t size() const noexcept { return size_; }

private:
    alignas(64) std::array<std::byte, Capacity> storage_{};
    std::size_t size_{};
};
```

```cpp
// ---- ownership-carrying pool handle ------------------------------------
struct BlockHandle {
    std::uint32_t index{};        // slot in the pool array
    std::uint32_t generation{};   // rejects a handle to a recycled slot
    std::uint32_t size{};         // valid bytes
    [[nodiscard]] constexpr bool valid() const noexcept { return generation != 0; }
};

template<std::size_t Capacity, std::size_t Slots>
class BlockPool {
public:
    BlockPool() noexcept {
        for (std::uint32_t i = 0; i != Slots; ++i) { free_[i] = i; gen_[i] = 1; }
        free_count_ = Slots;
    }
    [[nodiscard]] std::optional<BlockHandle> acquire() noexcept {   // thread-confined
        if (free_count_ == 0) return std::nullopt;                  // NO exception, NO growth
        auto const idx = free_[--free_count_];
        blocks_[idx].reset();
        return BlockHandle{.index = idx, .generation = gen_[idx], .size = 0};
    }
    [[nodiscard]] bool release(BlockHandle h) noexcept {
        if (h.index >= Slots || gen_[h.index] != h.generation) return false;  // stale
        ++gen_[h.index];                                            // invalidate old handles
        free_[free_count_++] = h.index;
        return true;
    }
    [[nodiscard]] ByteBlock<Capacity>* get(BlockHandle h) noexcept {
        if (h.index >= Slots || gen_[h.index] != h.generation) return nullptr;
        return &blocks_[h.index];
    }
private:
    std::array<ByteBlock<Capacity>, Slots> blocks_{};
    std::array<std::uint32_t, Slots>       free_{};
    std::array<std::uint32_t, Slots>       gen_{};
    std::size_t                            free_count_{};
};
```

The handle alone is not a safety mechanism; the pool must state **which thread owns a checked-out block**, **when ownership transfers**, **how stale generations are rejected**, **whether release is SPSC/MPSC/confined**, and **what happens when empty**.

| Facility | Owning? | Cost | Invalidation |
|---|---|---|---|
| `std::span<T>` | no | 2 words | when owner reallocates/reuses |
| `std::string_view` | no | 2 words | same |
| `std::vector<std::byte>` | yes | heap | on growth |
| `std::array<std::byte,N>` | yes | inline | never (fixed) |
| `BlockHandle` | token | 12 bytes | generation bump |
| `std::shared_ptr` | shared | control block + atomics | never (but allocates) |
| `std::unique_ptr` | yes, unique | 1 word | on move |

**Interview line** — "'Zero copy' usually relocates lifetime and reclamation complexity rather than removing cost; copying a 32-byte normalized event is often cheaper *and* provable."

**Traps** — returning a `span` from a function whose block is compacted by the caller · storing `string_view` symbols that point into a recycled packet · `shared_ptr<Block>` on the hot path for "safety" (control-block atomics + non-deterministic release) · a handle without a generation counter (ABA on slot reuse).

---

## 39.3 Preallocated message batches and buffer reuse

```cpp
// ---- fixed-capacity batch, no dynamic allocation -----------------------
template<class T, std::size_t N>
class Batch {
public:
    [[nodiscard]] bool push(T value) noexcept(std::is_nothrow_move_assignable_v<T>) {
        if (size_ == N) return false;              // caller MUST handle full
        values_[size_] = std::move(value);
        ++size_;                                   // size advances only after success
        return true;
    }
    [[nodiscard]] bool full()  const noexcept { return size_ == N; }
    [[nodiscard]] bool empty() const noexcept { return size_ == 0; }
    [[nodiscard]] std::span<T const> values() const noexcept { return {values_.data(), size_}; }
    [[nodiscard]] std::span<T>       values()       noexcept { return {values_.data(), size_}; }
    void clear() noexcept { size_ = 0; }           // trivial T: no destructor work
    static constexpr std::size_t capacity = N;

private:
    std::array<T, N> values_{};                    // constructs all N — fine for trivial T
    std::size_t      size_{};
};

using EventBatch = Batch<SequencedEvent, 64>;
static_assert(sizeof(EventBatch) <= 4096);
```

```cpp
// ---- lifetime-aware variant for non-trivial / non-default-constructible T
template<class T, std::size_t N>
class StorageBatch {
public:
    template<class... Args>
    [[nodiscard]] T* emplace(Args&&... args)
        noexcept(std::is_nothrow_constructible_v<T, Args...>) {
        if (size_ == N) return nullptr;
        T* p = std::construct_at(reinterpret_cast<T*>(&raw_[size_]),
                                 std::forward<Args>(args)...);     // <memory>, C++20
        ++size_;
        return p;
    }
    void clear() noexcept {
        for (std::size_t i = size_; i-- > 0; )
            std::destroy_at(std::launder(reinterpret_cast<T*>(&raw_[i])));
        size_ = 0;
    }
    ~StorageBatch() { clear(); }
    StorageBatch() = default;
    StorageBatch(StorageBatch const&) = delete;
    StorageBatch& operator=(StorageBatch const&) = delete;
    [[nodiscard]] std::span<T> values() noexcept {
        return {std::launder(reinterpret_cast<T*>(raw_.data())), size_};
    }
private:
    struct alignas(T) Slot { std::byte bytes[sizeof(T)]; };        // std::aligned_storage is
    std::array<Slot, N> raw_{};                                    // deprecated in C++23
    std::size_t         size_{};
};
```

```cpp
// ---- flush rule: full OR burst ended OR deadline ------------------------
class BatchFlusher {
public:
    using Clock = std::chrono::steady_clock;

    [[nodiscard]] bool should_flush(EventBatch const& b, bool input_drained,
                                    Clock::time_point now) const noexcept {
        if (b.empty())                       return false;
        if (b.full())                        return true;   // capacity
        if (input_drained)                   return true;   // no more work this wakeup
        return now - opened_ >= max_delay_;                 // latency deadline
    }
    void opened(Clock::time_point now) noexcept { opened_ = now; }
private:
    Clock::time_point       opened_{};
    Clock::duration         max_delay_{std::chrono::microseconds{50}};
};
```

```cpp
// ---- enforce a hard bound instead of trusting reserve() ----------------
class FixedEvents {
public:
    explicit FixedEvents(std::size_t capacity) {
        events_.reserve(capacity);            // ONE allocation, at warmup
        hard_capacity_ = capacity;            // requested, not events_.capacity()
    }
    [[nodiscard]] bool push(SequencedEvent v) noexcept {
        if (events_.size() == hard_capacity_) return false;   // never grows
        events_.push_back(v);                                  // cannot reallocate
        return true;
    }
    void clear() noexcept { events_.clear(); }                 // capacity retained
private:
    std::vector<SequencedEvent> events_;
    std::size_t                 hard_capacity_{};
};
```

| Buffer-reuse strategy | Cost | Use when |
|---|---|---|
| Compact prefix (`consume_prefix`) | O(remaining) memmove per read | small residuals, simple |
| Read/write cursor, reset when drained | O(1) common case | most stream framers |
| Ring of blocks + handles | O(1), no copy | ownership crosses threads |
| Scatter/gather (`readv`, iovec) | O(1), kernel-side | large frames, datagram batching |
| New allocation per packet | heap traffic + jitter | never on the hot path |

**Traps** — `std::array<T,N>` default-constructs all `N` (expensive/impossible for some `T`) · batching amortizes cost but *adds queueing delay for the first element* · `clear()` on a batch of views leaves the views dangling anyway · reusing a batch while the consumer still reads it (needs a return path, see 39.7).

---

## 39.4 Static dispatch versus virtual handlers versus variants

```cpp
// ==== framing: 2-byte big-endian length | 1-byte type | payload =========
[[nodiscard]] constexpr std::uint16_t load_be_u16(std::span<std::byte const, 2> b) noexcept {
    auto const hi = std::to_integer<std::uint16_t>(b[0]);
    auto const lo = std::to_integer<std::uint16_t>(b[1]);
    return static_cast<std::uint16_t>((hi << 8) | lo);      // no unaligned typed load
}
[[nodiscard]] constexpr std::uint32_t load_be_u32(std::span<std::byte const, 4> b) noexcept {
    return (std::to_integer<std::uint32_t>(b[0]) << 24)
         | (std::to_integer<std::uint32_t>(b[1]) << 16)
         | (std::to_integer<std::uint32_t>(b[2]) <<  8)
         |  std::to_integer<std::uint32_t>(b[3]);
}
[[nodiscard]] constexpr std::uint64_t load_be_u64(std::span<std::byte const, 8> b) noexcept {
    std::uint64_t v = 0;
    for (std::size_t i = 0; i != 8; ++i)
        v = (v << 8) | std::to_integer<std::uint64_t>(b[i]);
    return v;
}
// Little-endian host shortcut, still no aliasing violation:
//   std::uint32_t v; std::memcpy(&v, p, 4); v = std::byteswap(v);   // C++23 <bit>
// std::endian::native == std::endian::little  // C++20 compile-time query
```

```cpp
struct FrameView {
    std::span<std::byte const> payload;      // borrowed from the receive block
    std::size_t consumed_bytes{};            // header + payload
};

enum class FrameError : std::uint8_t {
    incomplete,             // FLOW CONTROL, not corruption
    zero_length,
    length_exceeds_limit
};

[[nodiscard]] inline std::expected<FrameView, FrameError>
try_frame(std::span<std::byte const> in, std::size_t max_payload) noexcept {
    constexpr std::size_t header_size = 2;
    if (in.size() < header_size)                       return std::unexpected(FrameError::incomplete);

    auto const length = load_be_u16(in.first<2>());    // fixed-extent subspan, C++20
    if (length == 0)                                   return std::unexpected(FrameError::zero_length);
    if (length > max_payload)                          return std::unexpected(FrameError::length_exceeds_limit);
    if (in.size() - header_size < length)              return std::unexpected(FrameError::incomplete);
    //  ^ subtraction, never `header_size + length`, which can wrap in a narrow type

    return FrameView{.payload        = in.subspan(header_size, length),
                     .consumed_bytes = header_size + length};
}

// Alternative shape that forces the caller to handle all three states:
struct NeedMoreBytes { std::size_t at_least{}; };
struct MalformedFrame { FrameError reason{}; std::size_t offset{}; };
using FrameStatus = std::variant<NeedMoreBytes, FrameView, MalformedFrame>;
```

```cpp
// ==== decoding with a bounded cursor ====================================
class ByteCursor {
public:
    explicit constexpr ByteCursor(std::span<std::byte const> in) noexcept : rest_{in} {}

    [[nodiscard]] constexpr std::optional<std::uint8_t> u8() noexcept {
        if (rest_.empty()) return std::nullopt;
        auto const v = std::to_integer<std::uint8_t>(rest_.front());
        rest_ = rest_.subspan(1);
        return v;
    }
    [[nodiscard]] constexpr std::optional<std::uint16_t> be_u16() noexcept {
        if (rest_.size() < 2) return std::nullopt;
        auto const v = load_be_u16(rest_.first<2>());
        rest_ = rest_.subspan(2);
        return v;
    }
    [[nodiscard]] constexpr std::optional<std::uint32_t> be_u32() noexcept {
        if (rest_.size() < 4) return std::nullopt;
        auto const v = load_be_u32(rest_.first<4>());
        rest_ = rest_.subspan(4);
        return v;
    }
    [[nodiscard]] constexpr std::optional<std::uint64_t> be_u64() noexcept {
        if (rest_.size() < 8) return std::nullopt;
        auto const v = load_be_u64(rest_.first<8>());
        rest_ = rest_.subspan(8);
        return v;
    }
    [[nodiscard]] constexpr std::optional<std::span<std::byte const>> bytes(std::size_t n) noexcept {
        if (rest_.size() < n) return std::nullopt;
        auto const v = rest_.first(n);
        rest_ = rest_.subspan(n);
        return v;
    }
    [[nodiscard]] constexpr std::span<std::byte const> rest() const noexcept { return rest_; }
    [[nodiscard]] constexpr bool exhausted() const noexcept { return rest_.empty(); }
private:
    std::span<std::byte const> rest_;
};
```

```cpp
enum class DecodeError : std::uint8_t {
    truncated, unknown_type, invalid_side, invalid_quantity, trailing_bytes
};

struct WireAdd     { std::uint64_t id; std::uint32_t price; std::uint32_t qty; std::uint8_t side; };
struct WireCancel  { std::uint64_t id; std::uint32_t qty; };
struct WireExecute { std::uint64_t id; std::uint32_t qty; };

using WireMessage  = std::variant<WireAdd, WireCancel, WireExecute>;
using DecodeResult = std::expected<WireMessage, DecodeError>;

[[nodiscard]] inline DecodeResult decode(std::span<std::byte const> payload) noexcept {
    ByteCursor c{payload};
    auto const type = c.u8();
    if (!type) return std::unexpected(DecodeError::truncated);

    switch (*type) {
    case 'A': {
        auto id = c.be_u64(); auto px = c.be_u32(); auto qty = c.be_u32(); auto side = c.u8();
        if (!id || !px || !qty || !side)  return std::unexpected(DecodeError::truncated);
        if (!c.exhausted())               return std::unexpected(DecodeError::trailing_bytes);
        return WireMessage{WireAdd{*id, *px, *qty, *side}};
    }
    case 'X': {
        auto id = c.be_u64(); auto qty = c.be_u32();
        if (!id || !qty)                  return std::unexpected(DecodeError::truncated);
        if (!c.exhausted())               return std::unexpected(DecodeError::trailing_bytes);
        return WireMessage{WireCancel{*id, *qty}};
    }
    case 'E': {
        auto id = c.be_u64(); auto qty = c.be_u32();
        if (!id || !qty)                  return std::unexpected(DecodeError::truncated);
        if (!c.exhausted())               return std::unexpected(DecodeError::trailing_bytes);
        return WireMessage{WireExecute{*id, *qty}};
    }
    default:                              return std::unexpected(DecodeError::unknown_type);
    }
}
```

```cpp
// ==== normalize once, at the untrusted boundary =========================
enum class NormalizeError : std::uint8_t {
    price_out_of_range, zero_quantity, unknown_side, quantity_overflow
};

[[nodiscard]] inline std::expected<Add, NormalizeError> normalize(WireAdd const& w) noexcept {
    if (w.qty == 0)                    return std::unexpected(NormalizeError::zero_quantity);
    if (w.price == 0xFFFF'FFFFu)       return std::unexpected(NormalizeError::price_out_of_range); // sentinel

    Side side{};
    switch (w.side) {                                   // never cast an unvalidated byte to an enum
    case 0: side = Side::bid; break;
    case 1: side = Side::ask; break;
    default: return std::unexpected(NormalizeError::unknown_side);
    }
    return Add{.id       = OrderId{w.id},
               .price    = PriceTicks{static_cast<std::int64_t>(w.price)},   // widening, checked above
               .quantity = Quantity{w.qty},
               .side     = side};
}

[[nodiscard]] inline std::expected<BookEvent, NormalizeError>
normalize_message(WireMessage const& m) noexcept {
    return std::visit([]<class W>(W const& w) -> std::expected<BookEvent, NormalizeError> {
        if constexpr (std::same_as<W, WireAdd>) {
            auto a = normalize(w);
            if (!a) return std::unexpected(a.error());
            return BookEvent{*a};
        } else if constexpr (std::same_as<W, WireCancel>) {
            if (w.qty == 0) return std::unexpected(NormalizeError::zero_quantity);
            return BookEvent{Cancel{OrderId{w.id}, Quantity{w.qty}}};
        } else {
            if (w.qty == 0) return std::unexpected(NormalizeError::zero_quantity);
            return BookEvent{Execute{OrderId{w.id}, Quantity{w.qty}}};
        }
    }, m);
}
```

Normalization policy checklist: **is zero legal per field · which conversions narrow or overflow · are sentinels rejected or mapped to absence · are prices scaled integers (never `double`) · does the event own everything it needs · can an invalid enum value exist past this line.**

```cpp
// ==== dispatch: the three idioms ========================================

// (1) switch on a tag — closed set, jump table, manual tag/payload consistency
enum class Tag : std::uint8_t { add, cancel, execute };
struct TaggedEvent { Tag tag; union { Add a; Cancel c; Execute e; }; };  // you own lifetime

// (2) variant + visit — closed set, exhaustive, type-safe
//     `Overload` here is the overloaded-lambda visitor aggregate from §14.9.

class Book;                                                             // see 39.7
inline void apply_visit(Book& book, BookEvent const& ev);               // defined below

// (3) virtual — open set, stable ABI, indirect call + ownership question
struct IEventSink {
    virtual ~IEventSink() = default;
    virtual void on(Add const&)     noexcept = 0;
    virtual void on(Cancel const&)  noexcept = 0;
    virtual void on(Execute const&) noexcept = 0;
    virtual void on_gap(Sequence expected, Sequence received) noexcept = 0;
};

// (4) function-pointer table — compact, configured at startup
using Handler = void (*)(void* ctx, std::span<std::byte const>) noexcept;   // noexcept in type (C++17)
inline std::array<Handler, 256> handlers{};   // indexed by wire type byte, filled at warmup

// (5) static composition — full inlining, no indirection, rigid wiring
template<class Normalizer, class Sink>
class DecodeStage {
public:
    DecodeStage(Normalizer n, Sink& sink) noexcept
        : normalizer_{std::move(n)}, sink_{sink} {}     // sink MUST outlive this stage

    void on(WireMessage const& m) noexcept {
        auto normalized = normalizer_(m);
        if (normalized) sink_.on(*normalized);
        else            sink_.on_error(normalized.error());
    }
private:
    [[no_unique_address]] Normalizer normalizer_;       // C++20: empty functor costs 0 bytes
    Sink& sink_;                                        // reference = non-owning, no rebinding
};
```

| Mechanism | Set | Hot-path shape | Main risk |
|---|---|---|---|
| `switch` on tag | closed | direct branch / jump table | manual tag↔payload consistency, union lifetime |
| `std::variant` + `visit` | closed | exhaustive, often a jump table | `sizeof` = largest alt + index; visit code bloat |
| Virtual function | open | one indirect call, possible devirtualization | allocation/ownership, BTB pressure if heterogeneous |
| Function-pointer table | configured | indexed indirect call | context plumbing via `void*`, no type safety |
| Templates / static pipeline | compile time | full inlining, constant folding | code size, build time, no runtime composition |

**Traps** — `std::visit` on a valueless-by-exception variant throws `std::bad_variant_access` (avoid by keeping alternatives nothrow-movable) · `variant` grows to the largest alternative and hurts queue density · replacing `variant` with a hand-rolled union "for speed" without measuring, then leaking active-member bugs · virtual `on()` per *message* instead of per *batch*.

---

## 39.5 Sequence-number state machines

```cpp
enum class StreamState : std::uint8_t { cold, live, recovering, failed };

enum class SequenceClass : std::uint8_t { expected, duplicate_or_old, gap };

[[nodiscard]] constexpr SequenceClass classify(Sequence received, Sequence expected) noexcept {
    if (received == expected) return SequenceClass::expected;
    if (received <  expected) return SequenceClass::duplicate_or_old;
    return SequenceClass::gap;
}

// Wrapping fixed-width sequence spaces need modular comparison + a max distance:
[[nodiscard]] constexpr SequenceClass classify_wrapping(std::uint32_t recv, std::uint32_t exp,
                                                        std::uint32_t max_ahead) noexcept {
    std::uint32_t const delta = recv - exp;              // unsigned wraparound is well-defined
    if (delta == 0)          return SequenceClass::expected;
    if (delta <= max_ahead)  return SequenceClass::gap;
    return SequenceClass::duplicate_or_old;              // beyond the unambiguous window
}
```

| Current | Input | Action | Next |
|---|---|---|---|
| `cold` | valid snapshot / base | install complete state, set `next` | `live` |
| `cold` | incremental | buffer boundedly or drop by policy | `cold` |
| `live` | `seq == next` | apply once, `++next` | `live` |
| `live` | `seq < next` | count duplicate, drop | `live` |
| `live` | `seq > next` | stop publishing, begin gap procedure | `recovering` |
| `recovering` | incremental | buffer boundedly (explicit overflow policy) | `recovering` |
| `recovering` | valid recovery base | rebuild + replay, promote atomically | `live` |
| `recovering` | buffer overflow / timeout | escalate per policy | `recovering` or `failed` |
| any | invariant or capacity fault | record context, isolate stream | `failed` |

```cpp
// ---- the sequencer: apply exactly once, in one owner -------------------
struct SequenceStats {
    std::uint64_t applied{};
    std::uint64_t duplicates{};
    std::uint64_t gaps{};
    std::uint64_t buffered{};
    std::uint64_t dropped{};
};

template<class Sink>            // Sink: .on(BookEvent const&) noexcept, .on_gap(Sequence,Sequence) noexcept
class Sequencer {
public:
    explicit Sequencer(Sink& sink) noexcept : sink_{sink} {}

    void start_at(Sequence first) noexcept {              // after a snapshot install
        next_  = first;
        state_ = StreamState::live;
    }

    void on(SequencedEvent const& in) noexcept {
        switch (state_) {
        case StreamState::cold:       on_cold(in);       return;
        case StreamState::live:       on_live(in);       return;
        case StreamState::recovering: on_recovering(in); return;
        case StreamState::failed:     ++stats_.dropped;  return;   // isolated: never resumes silently
        }
    }

    [[nodiscard]] StreamState     state() const noexcept { return state_; }
    [[nodiscard]] Sequence        next()  const noexcept { return next_; }
    [[nodiscard]] SequenceStats const& stats() const noexcept { return stats_; }

private:
    void on_cold(SequencedEvent const& in) noexcept {
        if (!buffer_.push(in)) ++stats_.dropped;         // bounded pre-snapshot buffer
        else                   ++stats_.buffered;
    }

    void on_live(SequencedEvent const& in) noexcept {
        switch (classify(in.sequence, next_)) {
        case SequenceClass::expected:
            sink_.on(in.event);                          // apply MUST be noexcept here
            ++next_.value;                               // increment only after a successful apply
            ++stats_.applied;
            drain_buffered();                            // a queued future event may now be next
            break;
        case SequenceClass::duplicate_or_old:
            ++stats_.duplicates;                         // idempotent drop
            break;
        case SequenceClass::gap:
            ++stats_.gaps;
            state_ = StreamState::recovering;
            sink_.on_gap(next_, in.sequence);            // publication of live state stops NOW
            if (!buffer_.push(in)) ++stats_.dropped; else ++stats_.buffered;
            break;
        }
    }

    void on_recovering(SequencedEvent const& in) noexcept {
        if (in.sequence < next_) { ++stats_.duplicates; return; }
        if (!buffer_.push(in)) {                         // overflow policy is EXPLICIT
            ++stats_.dropped;
            state_ = StreamState::failed;                // cannot bridge the gap → isolate
            return;
        }
        ++stats_.buffered;
    }

    void drain_buffered() noexcept {                     // apply any contiguous buffered suffix
        bool progress = true;
        while (progress) {
            progress = false;
            for (auto& e : buffer_.values()) {
                if (e.sequence == next_) {
                    sink_.on(e.event);
                    ++next_.value;
                    ++stats_.applied;
                    e.sequence = Sequence{~0ull};        // tombstone; compaction is a policy detail
                    progress = true;
                }
            }
        }
    }

    Sink&                          sink_;
    StreamState                    state_{StreamState::cold};
    Sequence                       next_{};
    Batch<SequencedEvent, 4096>    buffer_{};            // BOUNDED recovery buffer
    SequenceStats                  stats_{};
};
```

- The **order of apply and increment** is the failure contract: increment after apply means a throwing/rejecting apply replays; increment before means it is skipped.
- Hot-path apply operations are `noexcept` on already-validated input; a capacity or invariant fault transitions to `failed` rather than throwing through the sequencer.
- Duplicates must be *dropped*, not re-applied: an `Execute` applied twice silently corrupts quantity.
- A/B (two-feed arbitration) is the same machine driven by `min(seqA, seqB)` — the first feed to deliver `next` wins, the other's copy classifies as duplicate.

```cpp
// ---- A/B feed arbitration on top of the same sequencer -----------------
template<class Sink>
class FeedArbiter {
public:
    explicit FeedArbiter(Sink& sink) noexcept : seq_{sink} {}
    void on_a(SequencedEvent const& e) noexcept { seq_.on(e); ++from_a_; }
    void on_b(SequencedEvent const& e) noexcept { seq_.on(e); ++from_b_; }
private:
    Sequencer<Sink> seq_;
    std::uint64_t   from_a_{}, from_b_{};
};
```

**Traps** — comparing wrapping sequences with `<` · resuming `live` while buffered events still precede `next` · unbounded `std::vector` recovery buffer (defeats bounded memory) · publishing snapshots while `recovering` (hybrid state) · treating a gap as "just log it and continue".

---

## 39.6 Gap detection, snapshot handoff, and replay buffers

```text
live state detects gap (seq > next)
   │
   ├── stop marking new live state as current           (no hybrid publication)
   ├── acquire recovery base/snapshot into a SEPARATE candidate Book
   ├── collect bounded incrementals with an explicit overflow policy
   ├── validate the sequence bridge  (base.next <= first buffered seq <= base.next)
   ├── replay buffered incrementals into the candidate
   └── promote the complete candidate in ONE state transition
```

```cpp
enum class RecoveryError : std::uint8_t {
    base_too_old,        // snapshot ends before our buffered range starts → unbridgeable
    buffer_overflow,
    replay_rejected,
    timed_out,
    capacity
};

struct RecoveryInput {
    Sequence                          base_next{};      // first incremental the base does NOT include
    std::span<SequencedEvent const>   incrementals;     // buffered, sorted, contiguous from base_next
};

class Book;                                             // single-writer state, see 39.7

[[nodiscard]] std::expected<Book, RecoveryError> rebuild(RecoveryInput const&) noexcept;
```

```cpp
class RecoveryController {
public:
    using Clock = std::chrono::steady_clock;

    void begin(Sequence expected, Sequence received, Clock::time_point now) noexcept {
        state_    = StreamState::recovering;
        gap_from_ = expected;
        gap_to_   = received;
        started_  = now;
        buffer_.clear();
    }

    [[nodiscard]] bool buffer(SequencedEvent const& e) noexcept {
        return buffer_.push(e);                          // false → caller escalates
    }

    [[nodiscard]] std::expected<void, RecoveryError>
    complete(Book candidate, Sequence next) noexcept {
        // ALL validation is done before the current state is touched.
        current_ = std::move(candidate);                 // bounded only if Book's move is bounded
        next_    = next;
        state_   = StreamState::live;
        publish_current();                               // one release edge, one visible transition
        return {};
    }

    [[nodiscard]] std::expected<void, RecoveryError>
    poll(Clock::time_point now) noexcept {
        if (state_ == StreamState::recovering && now - started_ > deadline_)
            return std::unexpected(RecoveryError::timed_out);
        return {};
    }

private:
    void publish_current() noexcept;

    StreamState                 state_{StreamState::cold};
    Sequence                    gap_from_{}, gap_to_{}, next_{};
    Clock::time_point           started_{};
    Clock::duration             deadline_{std::chrono::seconds{5}};
    Batch<SequencedEvent, 8192> buffer_{};               // hard bound, sized from the SLA
    Book                        current_{};
};
```

Overflow / timeout options — pick one and name it: **restart recovery from a newer base · fail and isolate the stream · spill to a separately governed slow path · disconnect and rebuild from scratch.** The API returns the outcome; it never quietly grows.

```cpp
// ==== snapshot publication (double-buffer + version) ====================
#include <atomic>

struct TopSnapshot {
    PriceTicks bid_price{};
    Quantity   bid_quantity{};
    PriceTicks ask_price{};
    Quantity   ask_quantity{};
    Sequence   sequence{};
};
static_assert(std::is_trivially_copyable_v<TopSnapshot>);

class SnapshotPublisher {                 // one writer, many readers
public:
    void publish(TopSnapshot const& s) noexcept {                  // writer thread only
        auto const idx = active_.load(std::memory_order_relaxed) ^ 1u;  // the inactive buffer
        buffers_[idx] = s;                                          // plain writes, no reader here
        active_.store(idx, std::memory_order_release);              // publishes the writes above
        // Reuse safety: with 2 buffers a slow reader can be overwritten. Use 3+ buffers,
        // a reader-epoch/hazard scheme, or accept torn-free-but-stale reads by design.
    }
    [[nodiscard]] TopSnapshot read() const noexcept {                // any reader thread
        auto const idx = active_.load(std::memory_order_acquire);    // sees the writes above
        return buffers_[idx];                                        // copy out; do not hold a ref
    }
private:
    std::array<TopSnapshot, 3> buffers_{};
    std::atomic<unsigned>      active_{0};
    static_assert(std::atomic<unsigned>::is_always_lock_free);
};
```

```text
seqlock-style read (see #ch36 for the proof obligations):
  reader loads version (must be even)          acquire
  reader copies fields
  reader reloads version                       acquire
  accept only if both versions match and are even
  NOTE: plain concurrent reads of the payload are a data race in the C++ model —
  use atomic_ref / relaxed atomic loads on the payload, not ordinary loads.
```

**Publication contract** — state explicitly whether a snapshot is: latest-observed vs guaranteed-per-sequence · deep copy vs top-N projection · valid until next read / until handle destruction / forever · permitted to skip versions · available during recovery (usually **no**).

**Traps** — promoting a candidate before validating the sequence bridge · two buffers plus a preempted reader (buffer reused under it) · exposing a `TopSnapshot const&` instead of a copy · `std::atomic<TopSnapshot>` when the type exceeds the lock-free width (silently becomes mutex-backed) · publishing during `recovering`.

---

## 39.7 SPSC stage boundaries and single-writer state

```text
input/decoder thread ──SPSC filled batches──►  book-owner thread
                     ◄──SPSC empty batches───
```

```cpp
// ---- minimal SPSC ring carrying OWNING values (see #ch36 for the proof) ----
template<class T, std::size_t N>            // N must be a power of two
class SpscQueue {
    static_assert((N & (N - 1)) == 0 && N >= 2, "N must be a power of two");
public:
    [[nodiscard]] bool try_push(T&& v) noexcept {                 // PRODUCER thread only
        auto const w = write_.load(std::memory_order_relaxed);    // exclusively ours
        auto const next = (w + 1) & (N - 1);
        if (next == read_cache_) {
            read_cache_ = read_.load(std::memory_order_acquire);  // refresh only when it looks full
            if (next == read_cache_) return false;                // FULL → caller's policy
        }
        slots_[w] = std::move(v);                                 // write payload first
        write_.store(next, std::memory_order_release);            // publish payload + index
        return true;
    }
    [[nodiscard]] bool try_pop(T& out) noexcept {                 // CONSUMER thread only
        auto const r = read_.load(std::memory_order_relaxed);
        if (r == write_cache_) {
            write_cache_ = write_.load(std::memory_order_acquire); // acquires the producer's payload
            if (r == write_cache_) return false;                   // EMPTY
        }
        out = std::move(slots_[r]);
        read_.store((r + 1) & (N - 1), std::memory_order_release); // frees the slot
        return true;
    }
    [[nodiscard]] std::size_t size_approx() const noexcept {       // TELEMETRY ONLY — stale
        return (write_.load(std::memory_order_relaxed)
              - read_.load(std::memory_order_relaxed)) & (N - 1);
    }
    void close() noexcept { closed_.store(true, std::memory_order_release); }  // wakes waiters
    [[nodiscard]] bool closed() const noexcept { return closed_.load(std::memory_order_acquire); }
private:
    std::atomic<bool> closed_{false};
    static constexpr std::size_t cl = 64;                          // std::hardware_destructive_interference_size
    alignas(cl) std::atomic<std::size_t> write_{0};
    alignas(cl) std::size_t              write_cache_{0};          // consumer-private cache
    alignas(cl) std::atomic<std::size_t> read_{0};
    alignas(cl) std::size_t              read_cache_{0};           // producer-private cache
    alignas(cl) std::array<T, N>         slots_{};
};

using BatchQueue = SpscQueue<EventBatch, 64>;
```

```text
ownership protocol (memorize):
  producer owns the batch while filling                     — plain writes, no atomics
  producer publishes the completed batch with RELEASE       — one edge for all fields
  consumer ACQUIREs the slot and exclusively owns the batch — plain reads
  consumer applies all events to the book
  consumer returns the emptied batch on the return queue    — ownership goes back
```

```cpp
// ---- WRONG: queueing a pointer to producer stack state -----------------
// EventBatch batch;
// fill(batch);
// queue.try_push(&batch);      // dangles / races the moment the loop reuses `batch`

// ---- RIGHT: move an owning batch, or use pooled batch handles ----------
EventBatch batch;               // or: acquired from a free-batch queue
// fill(batch);
// if (!queue.try_push(std::move(batch))) { /* named overload policy */ }
```

```cpp
// ---- single-writer book -----------------------------------------------
enum class ApplyError : std::uint8_t {
    duplicate_order, unknown_order, quantity_exceeded, capacity_exhausted
};

class Book {
public:
    // Ordinary non-atomic members: correct because exactly ONE thread mutates them.
    [[nodiscard]] std::expected<void, ApplyError> apply(Add const&)     noexcept;
    [[nodiscard]] std::expected<void, ApplyError> apply(Cancel const&)  noexcept;
    [[nodiscard]] std::expected<void, ApplyError> apply(Execute const&) noexcept;
    [[nodiscard]] std::expected<void, ApplyError> apply(Clear const&)   noexcept;

    [[nodiscard]] TopSnapshot top() const noexcept;

private:
    struct Node {                                          // book internals: see #ch40
        OrderId    id{};
        PriceTicks price{};
        Quantity   quantity{};
        Side       side{};
        std::uint32_t next{}, prev{}, generation{};        // indices, not pointers
    };
    std::vector<Node> pool_;      // resize()d once at warmup to a hard capacity
    std::uint32_t     free_head_{};
};

inline void apply_visit(Book& book, BookEvent const& ev) {
    std::visit([&book](auto const& e) {
        auto r = book.apply(e);
        if (!r) { /* capacity/invariant fault → stream isolation policy */ }
    }, ev);
}
```

```cpp
// ---- the consumer loop -------------------------------------------------
#include <thread>

void book_thread(BatchQueue& filled, BatchQueue& empties, Book& book, std::stop_token st) {
    EventBatch batch;
    while (!st.stop_requested()) {
        if (!filled.try_pop(batch)) {
            std::this_thread::yield();                  // or spin N, then wait — a named policy
            continue;
        }
        for (auto const& e : batch.values())            // exclusive ownership: plain reads
            apply_visit(book, e.event);
        batch.clear();
        while (!empties.try_push(std::move(batch))) {}  // return path must never deadlock
    }
    // drain-or-discard on stop is part of the shutdown contract (39.10)
}
```

Single-writer buys: **ordinary non-atomic fields · deterministic total event order · no per-operation mutex · replayability · synchronization confined to the queue and publication edges.** It does *not* mean single-threading the system — partition by instrument/shard, one writer per mutable object.

| Memory order | Where | Why |
|---|---|---|
| `relaxed` | producer's own `write_`, consumer's own `read_` | exclusively owned counter, no ordering needed |
| `acquire` | reading the *other side's* index | makes the peer's payload writes visible |
| `release` | storing your own index after touching the payload | publishes everything written before it |
| `seq_cst` | avoid on this path | full fence cost with no added guarantee here |

**Traps** — a "SPSC" queue with two producers returning buffers (that is MPSC) · `size()` used for logic instead of telemetry (it is stale by construction) · false sharing between `read_` and `write_` (fix with `alignas(64)`) · non-power-of-two `N` with `%` on the hot path · `try_push` result ignored (`[[nodiscard]]` it) · blocking on the return queue while the consumer waits on the forward queue (deadlock).

---

## 39.8 Backpressure, loss policy, and bounded memory

| Policy | Meaning | Suitable when |
|---|---|---|
| Reject / fail | caller receives `false`/error | upstream has a defined resync |
| Drop newest | preserve already-queued work | newest data discardable coherently |
| Drop / overwrite oldest | favor recency | consumers tolerate and *detect* loss |
| Spin | busy-wait, occupying a core | stalls provably sub-microsecond |
| Yield / block | involve scheduler | latency budget permits a wakeup |
| Disconnect / recover | abandon the live stream, rebuild | any loss invalidates incremental state |

- For **ordered incremental state**, drop-and-continue is incoherent: a full queue must set the gap/recovery transition, not "best effort".
- For **last-value/quote-style state**, overwrite-oldest is legitimate — the consumer only wants the newest value.

```cpp
enum class PublishResult : std::uint8_t { published, full, stopped };

[[nodiscard]] PublishResult publish(EventBatch&& b) noexcept;   // ignoring this is review-visible

// Tie "full" to stream invalidation for incremental feeds:
inline void on_full(Sequencer<IEventSink>& seq, IEventSink& sink, Sequence next) noexcept {
    sink.on_gap(next, next);       // synthetic gap: force recovery rather than lose an event
    (void)seq;
}
```

```cpp
// ---- watermarks without a contended atomic per event -------------------
class Watermarks {
public:
    void sample(std::size_t occupancy) noexcept {          // once per batch, not per event
        if (occupancy > high_) high_ = occupancy;
        ++samples_;
    }
    void publish_periodically() noexcept {                 // e.g. every 1024 samples
        if ((samples_ & 1023u) == 0)
            shared_high_.store(high_, std::memory_order_relaxed);
    }
private:
    std::size_t              high_{}, samples_{};          // thread-local, plain
    std::atomic<std::size_t> shared_high_{};               // read by telemetry, relaxed
};
```

**Allocation policy — "zero allocation" means zero *dynamic* allocation during a defined phase.**

```text
WARM / SETUP phase (allocation allowed, then frozen):
  allocate receive blocks, queue slots, batch pools
  size/reserve book storage to enforced capacities
  construct formatters, log buffers, capture buffers
  build symbol/instrument lookup tables
  first-touch every page if placement matters
  validate all configuration against capacity limits

STEADY-STATE audit — hidden allocation sources:
  vector/string growth        node-container insertion      std::function beyond SBO
  exception construction      iostream/format buffers       coroutine frames
  shared_ptr control blocks   telemetry maps                first-use local statics
  library lazy init           std::regex, locale            std::async, thread creation
```

```cpp
// ---- prove it: allocation-counting test hook ---------------------------
#include <cstdlib>
#include <new>

inline std::atomic<std::size_t> g_allocations{0};

void* operator new(std::size_t n) {
    g_allocations.fetch_add(1, std::memory_order_relaxed);
    if (void* p = std::malloc(n)) return p;
    throw std::bad_alloc{};
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }

// TEST: warm every deliberate one-time path, snapshot the counter,
//       run representative steady-state traffic, assert the counter is unchanged.
```

```cpp
// ---- pmr for bounded, arena-backed setup allocations -------------------
#include <memory_resource>
inline std::array<std::byte, 1 << 20> arena_bytes;
inline std::pmr::monotonic_buffer_resource arena{arena_bytes.data(), arena_bytes.size(),
                                                 std::pmr::null_memory_resource()}; // no fallback
inline std::pmr::vector<SequencedEvent> replay_buffer{&arena};   // throws bad_alloc if exhausted
```

**Traps** — `reserve()` without a hard-bound check (one extra element reallocates and spikes p99.9) · counting only `operator new` while the library allocates through `malloc` directly · a `std::function` sink whose target exceeds SBO · a `catch` block that formats a message with `std::format` on the error path.

---

## 39.9 Timestamp representation and clock-domain separation

```cpp
#include <chrono>

using Nanoseconds = std::chrono::nanoseconds;

// Distinct TYPES, identical representation — the compiler enforces the domains.
struct ExchangeTimestamp { Nanoseconds since_epoch{}; };   // remote wall clock
struct ReceiveTimestamp  { Nanoseconds since_epoch{}; };   // NIC/kernel SO_TIMESTAMPING
struct DecodeTimestamp   { Nanoseconds since_epoch{}; };   // host monotonic
struct PublishTimestamp  { Nanoseconds since_epoch{}; };   // host monotonic

// Cross-domain arithmetic must be explicit and calibrated:
struct ClockOffset { Nanoseconds exchange_minus_host{}; };
[[nodiscard]] constexpr ReceiveTimestamp to_host(ExchangeTimestamp t, ClockOffset o) noexcept {
    return ReceiveTimestamp{t.since_epoch - o.exchange_minus_host};   // error/drift is real
}
// auto d = publish.since_epoch - exchange.since_epoch;   // COMPILES but is meaningless
```

```cpp
// ---- monotonic durations only, for latency ----------------------------
using SteadyClock = std::chrono::steady_clock;
using SteadyPoint = SteadyClock::time_point;

struct ProcessingStamp {
    SteadyPoint received{};
    SteadyPoint decoded{};
    SteadyPoint published{};
    [[nodiscard]] Nanoseconds decode_latency() const noexcept {
        return std::chrono::duration_cast<Nanoseconds>(decoded - received);
    }
    [[nodiscard]] Nanoseconds total_latency() const noexcept {
        return std::chrono::duration_cast<Nanoseconds>(published - received);
    }
};
```

| Clock | Monotonic | Steady | Use for |
|---|---|---|---|
| `std::chrono::steady_clock` | yes | yes | durations, latency, deadlines |
| `std::chrono::system_clock` | no | no | wall-clock logging, exchange-time correlation |
| `std::chrono::high_resolution_clock` | alias | alias | avoid — implementation-defined alias |
| `std::chrono::utc_clock` / `tai_clock` / `gps_clock` | no | no | leap-second-correct conversion (C++20) |
| `rdtsc` / `__rdtscp` | per-core | needs calibration | sub-nanosecond stamps, requires invariant TSC |
| NIC hardware timestamp | device domain | device domain | true wire-arrival time |

```cpp
// ---- C++20 calendar/zone formatting (OFF the hot path) ----------------
#include <format>
inline std::string format_wall(std::chrono::system_clock::time_point tp) {
    return std::format("{:%F %T}", std::chrono::floor<Nanoseconds>(tp));   // allocates!
}
```

```cpp
// ---- hot/cold field placement -----------------------------------------
struct HotEvent {                        // consumed by the book on every message
    Sequence   sequence;
    BookEvent  event;
};
struct ColdDiagnostics {                 // sampled, kept in a parallel array
    ReceiveTimestamp  received;
    DecodeTimestamp   decoded;
    ExchangeTimestamp exchange;
};
// [[no_unique_address]] compresses only EMPTY members — it will not shrink these.
```

- Calling a clock at every stage costs (`clock_gettime` vDSO ≈ 20–30 ns; `rdtsc` ≈ 10–20 cycles) and perturbs what it measures — stamp at boundaries that matter, or sample 1-in-N.
- `steady_clock` is monotonic but *not* synchronized across machines; never compare it to a remote timestamp.

**Traps** — `std::uint64_t` for every timestamp (all domains silently interchangeable) · subtracting `system_clock` points across an NTP step and getting a negative latency · `duration_cast` truncating toward zero (use `round`/`ceil` where it matters) · assuming exchange timestamps are monotonic (they often are not).

---

## 39.10 Deterministic capture/replay hooks

```cpp
// ---- capture at the BYTE/FRAME boundary, field-by-field encoded --------
struct CapturedFrameHeader {                 // written big-endian, explicitly, field by field
    std::uint32_t magic{0x4D444331};         // "MDC1" — schema identity
    std::uint16_t schema_version{1};
    std::uint16_t source_id{};
    std::uint64_t capture_sequence{};        // capture-order tiebreak, independent of feed seq
    std::uint64_t receive_ns{};              // host monotonic-since-boot or calibrated epoch
    std::uint64_t exchange_ns{};             // as reported, unconverted
    std::uint32_t payload_size{};
    std::uint32_t crc32{};                   // detects truncated/corrupt capture files
};
static_assert(std::is_trivially_copyable_v<CapturedFrameHeader>);
// ...and DO NOT fwrite(&header, sizeof header): padding, host endianness, and ABI
// layout are not an interchange format. Serialize each field explicitly:

inline void store_be_u32(std::span<std::byte, 4> out, std::uint32_t v) noexcept {
    out[0] = std::byte(v >> 24); out[1] = std::byte(v >> 16);
    out[2] = std::byte(v >>  8); out[3] = std::byte(v);
}
inline void store_be_u64(std::span<std::byte, 8> out, std::uint64_t v) noexcept {
    for (std::size_t i = 0; i != 8; ++i) out[i] = std::byte(v >> (56 - 8 * i));
}
```

```text
SAME-PATH PRINCIPLE
  live owned bytes    ─┐
                       ├──► framer → decoder → normalizer → sequencer → book
  replayed owned bytes ┘
A replay-only shortcut that constructs BookEvents directly never exercises the
framing, decoding, or normalization code where the bug actually lives.
```

```cpp
// ---- one source interface, two implementations -------------------------
struct IByteSource {
    virtual ~IByteSource() = default;
    // Returns the bytes received into `into`, or 0 at end of stream.
    [[nodiscard]] virtual std::size_t read(std::span<std::byte> into) noexcept = 0;
    [[nodiscard]] virtual ReceiveTimestamp last_receive_time() const noexcept = 0;
};

class SocketSource  : public IByteSource { /* recv/recvmmsg + SO_TIMESTAMPING */ };
class CaptureSource : public IByteSource { /* mmap'd capture file, replays stored stamps */ };

// The pipeline is templated or takes IByteSource&: live and replay are the SAME binary path.
```

```cpp
// ---- end-to-end core: the drive loop over borrowed bytes ---------------
struct PipelineError {
    enum class Code : std::uint8_t { malformed, gap, capacity, invariant } code{};
    std::uint32_t source_id{};
    Sequence      sequence{};
    std::uint32_t byte_offset{};                 // FIXED SIZE — no strings on the error path
};
static_assert(std::is_trivially_copyable_v<PipelineError>);

class PipelineCore {
public:
    explicit PipelineCore(Book& book) noexcept : book_{book} {}

    struct ConsumeResult {
        std::size_t consumed_bytes{};
        enum class Status : std::uint8_t { complete, need_more } status{};
    };

    [[nodiscard]] std::expected<ConsumeResult, PipelineError>
    on_bytes(std::span<std::byte const> input) noexcept {
        std::size_t total = 0;

        while (!input.empty()) {
            auto framed = try_frame(input, max_payload_size);
            if (!framed) {
                if (framed.error() == FrameError::incomplete)          // FLOW CONTROL
                    return ConsumeResult{total, ConsumeResult::Status::need_more};
                return std::unexpected(frame_error(framed.error(), total));
            }

            auto decoded = decode(framed->payload);
            if (!decoded) return std::unexpected(decode_error(decoded.error(), total));

            auto normalized = normalize_message(*decoded);
            if (!normalized) return std::unexpected(normalize_error(normalized.error(), total));

            if (auto applied = sequence_and_apply(*normalized); !applied)
                return std::unexpected(applied.error());

            input  = input.subspan(framed->consumed_bytes);  // consume AFTER full success
            total += framed->consumed_bytes;
        }
        return ConsumeResult{total, ConsumeResult::Status::complete};
    }

private:
    static constexpr std::size_t max_payload_size = 4096;

    Book& book_;                                  // non-owning: PipelineCore must not outlive Book

    [[nodiscard]] std::expected<void, PipelineError> sequence_and_apply(BookEvent const&) noexcept;
    [[nodiscard]] static PipelineError frame_error(FrameError,     std::size_t off) noexcept;
    [[nodiscard]] static PipelineError decode_error(DecodeError,   std::size_t off) noexcept;
    [[nodiscard]] static PipelineError normalize_error(NormalizeError, std::size_t off) noexcept;
};
// Contract: on `need_more` the caller consumes exactly `consumed_bytes` and RETAINS the suffix.
// On error, define whether the prefix was consumed or the whole block is discarded — and say so.
```

**Determinism checklist**
- identical input ordering and sequence metadata on every run;
- no dependence on `unordered_map` iteration order (or fix the order externally);
- no wall-clock reads inside state transitions — inject time;
- deterministic capacity and failure policy (same buffer sizes → same drops);
- seeded or eliminated randomness (including hash seeds / ASLR-derived values);
- stable handling of duplicates, unknown types, and malformed records;
- versioned capture schema with explicit endianness;
- no pointer values, no native object dumps in the persisted format.

```cpp
// ---- deterministic state hash: the replay equality oracle --------------
[[nodiscard]] constexpr std::uint64_t fnv1a(std::uint64_t h, std::uint64_t v) noexcept {
    for (int i = 0; i != 8; ++i) { h ^= (v >> (8 * i)) & 0xFFu; h *= 0x100000001b3ull; }
    return h;
}
// Book::state_hash() folds levels in a FIXED order (ascending tick), never container order.
// Test: hash(live_run) == hash(replay_of_captured_bytes)  for the same capture.
```

**Error taxonomy — different categories, different actions**

| Category | Example | C++ response |
|---|---|---|
| Need more input | partial frame | retain bytes, read more (not an error) |
| Malformed wire data | impossible type/length/value | reject frame, bounded context record, policy decides |
| Sequence fault | gap / duplicate | state-machine transition |
| Capacity fault | pool/queue/book full | explicit overload result → recovery |
| Internal invariant fault | corrupt index/link/count | `assert` in test; isolate stream in production |
| External shutdown | stop requested | ordered close/drain/discard |

**Shutdown protocol** — destruction is not a shutdown protocol:

```text
1 request producer stop           (std::stop_token observed by the loop)
2 producer stops publishing new work
3 producer publishes an end marker or closes the handoff
4 consumer drains or discards per policy
5 consumer releases every block/batch handle back to its pool
6 join threads
7 destroy queues, pools, books, telemetry sinks in dependency order
```

```cpp
class Pipeline {
public:
    ~Pipeline() { stop(); }                    // explicit: do not rely on member order alone
    void stop() noexcept {
        thread_.request_stop();                // 1
        empties_.close(); filled_.close();     // 3 — wakes any waiter
        if (thread_.joinable()) thread_.join();// 6
    }
private:
    BlockPool<2048, 64> pool_;                 // constructed first, destroyed last
    BatchQueue          filled_{}, empties_{};
    Book                book_{};
    std::jthread        thread_;               // declared LAST → joined/destroyed FIRST
};
// Member destruction is reverse declaration order; jthread's dtor requests stop and joins,
// but application loops must OBSERVE the token and blocking waits must be woken.
```

**Cost ledger**

| Stage | Expected work | Common accidental cost |
|---|---|---|
| Buffer input | fill existing bytes | per-packet allocation, compaction memmove |
| Frame | length/type checks | rescanning from zero, generic branch-heavy parser |
| Decode | endian loads + validation | iostream/locale, temporary strings, unaligned UB |
| Normalize | checked field conversion | hash lookup, dynamic symbol strings |
| Handoff | batch move + index publish | copying payloads, false sharing, wakeup per event |
| Sequence | compare + state transition | unbounded recovery buffering |
| Book apply | lookup/update | node allocation, pointer chasing, rehash |
| Snapshot | copy N fields + release store | deep copy per message, reader contention |
| Telemetry | thread-local counter | global contended atomic, formatting, blocking I/O |

**Testing matrix**

| Target | Cases |
|---|---|
| Framer | every truncation point 0..full · zero/min/max/over-max length · byte-at-a-time feed · two frames in one read |
| Decoder | every tag + unknown tags · asymmetric endian vectors · invalid enums · trailing bytes · fuzz under ASan/UBSan |
| Normalizer | zero quantity · sentinel price · narrowing boundaries · every rejected enum value |
| Sequencer | first seq · duplicate immediately before expected · large forward gap · wrap policy · recovery buffer full · repeated failure/restart |
| Book | invariants after every event · differential vs a slow reference impl · deterministic state hash after replay · capacity exhaustion leaves state valid |
| Concurrency | SPSC wraparound + long-run counters · ownership transfer of nontrivial payloads · full/empty races under TSan · stop while empty/full/producing/recovering |
| Allocation | warm all one-time paths, snapshot counter, run steady state, assert unchanged |

**Rapid diagnoses**

| Symptom | Cause | Fix |
|---|---|---|
| Decoded fields sporadically corrupt under load | queued `span` into a reused block | transfer block ownership or normalize before the async boundary |
| Works on one platform, fails under sanitizer | `reinterpret_cast<WireHeader const*>` overlay | validated byte loads + explicit conversion |
| Rare latency spike only in high-volume sessions | input exceeded `reserve`, vector reallocated | check the hard bound before mutation |
| Inconsistent snapshots despite atomics | per-field atomicity is not a multi-field transaction | single writer + immutable published snapshot |
| Book valid but diverges from replay | silent queue drop with no recovery transition | make `full` observable, tie it to stream invalidation |
| Live-only bugs unreproducible | replay skips the decoder | capture at the byte/frame boundary |
| Negative or implausible latency | mixed clock domains | strong timestamp types + explicit calibration |
| Malformed bursts collapse latency | formatting/allocating/logging per error | fixed-size binary error records, off-thread formatting |

```text
RECALL CARD
bytes owner    owns receive storage; refills it immediately
frame          borrowed span; never crosses an async boundary
decoder        bytes → protocol type; bounds + endian + format only
normalizer     protocol type → owning internal type with invariants
sequencer      expected | duplicate | gap; explicit recovery state machine
book           one writer; bounded storage; deterministic apply
handoff        owning value/token; release publish + acquire consume
backpressure   reject/drop/spin/block/recover — always named
snapshot       immutable state + publication edge + reclamation rule
timestamps     one type per clock domain
replay         same processing path as live input
shutdown       stop → close → drain/discard → release → join → destroy

hot path       bounded work, bounded memory, no hidden ownership
correctness    lifetime + sequence + capacity + publication invariants
evidence       fuzzing + sanitizers + deterministic replay + allocation tests
```

**Interview line** — "Capture owned bytes at the frame boundary and replay them through the identical framer, decoder, normalizer, sequencer, and book; if the state hash differs, the pipeline has a hidden nondeterminism, not a performance problem."
