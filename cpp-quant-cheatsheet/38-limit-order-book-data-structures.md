# 38. Limit order book data structures

*Part VI-A — Quant blueprints: types, codecs, and core structures*

---

**Recall**
- A book is not "a map of maps": it is several redundant indexes over one logical state, and updating only some of them is corruption.
- Two independent axes: a *price* index selects the level, an intrusive *FIFO chain* inside the level carries time priority.
- Time priority is represented **only** by the chain links — never by pool address order, `unordered_map` iteration, ID magnitude, or timestamps.
- Cancel/execute/delete arrive by `OrderId`, so a direct ID→handle index is mandatory; scanning levels destroys the cost model.
- Store each order once in stable bounded storage; every other structure holds an index or handle into it.
- Pointers into a growing `vector` dangle — pre-size once, then address slots by `std::uint32_t` index.
- A stable slot is not an immortal identity: pair the index with a `generation` counter so a recycled slot rejects an old handle (logical ABA).
- `unordered_map::reserve(n)` is a bucket hint, not a hard capacity — it neither bounds memory nor prevents per-node allocation or rehash spikes.
- Fixed-capacity open addressing gives an explicit `full` outcome and no hot-path allocation; the price is tombstone/rebuild policy.
- Dense ladder: O(1) price→level, contiguous, memory ∝ tick range; tree: O(log L), sparse-safe, pointer-chasing and per-level allocation.
- "Best is O(1)" is only true if the *empty-level removal* path is O(1) too — otherwise a dense ladder scans a huge empty range.
- Maintain an active-level bitmap and use `std::countr_zero`/`std::countl_zero` (only on a proven-nonzero word) to find the next best.
- Cached best bid/ask is derived state: repair it in the same private operation that deactivates a level, never later.
- Failure atomicity: do all fallible work (validation, capacity reservation, arithmetic checks) *before* any link mutation, so the commit is `noexcept`.
- Do not catch `bad_alloc` after half-mutating and claim recovery — a mid-commit invariant failure is terminal unless rollback is proven.
- Replace is its own transition, not `cancel + add`: the input semantics decide priority retention, and the same slot can often be relinked.
- A pure quantity reduction keeps FIFO position; a priority reset unlinks and appends to the tail.
- One thread mutates; readers consume immutable published projections — per-field `atomic` does not make a multi-index transaction coherent.
- Sequence gating (`==next` apply, `<next` duplicate, `>next` gap) is a different error axis from `duplicate_id`.
- Rebuild by constructing a *candidate* book and promoting it atomically; never clear the live book in place.
- Prove correctness with structural invariants (links, counts, sums, index agreement, best) plus a canonical-order state digest replayed identically.

---

## 38.1 API boundary: commands/events in, queries/snapshots out

```cpp
#include <array>
#include <bit>
#include <compare>
#include <cstdint>
#include <expected>
#include <optional>
#include <span>
#include <vector>

// ---- normalized domain values, not wire layouts -------------------------
struct OrderId  { std::uint64_t value{}; friend constexpr auto operator<=>(OrderId, OrderId) = default; };
struct Price    { std::int64_t  ticks{}; friend constexpr auto operator<=>(Price, Price)     = default; };
struct Quantity { std::uint64_t value{}; friend constexpr auto operator<=>(Quantity, Quantity) = default; };

enum class Side     : std::uint8_t { bid, ask };
enum class Priority : std::uint8_t { retain, reset };   // replace policy, supplied by caller

// ---- commands / events --------------------------------------------------
struct Add     { OrderId id; Side side; Price price; Quantity quantity; };
struct Cancel  { OrderId id; Quantity quantity; };                 // partial reduction
struct Execute { OrderId id; Quantity quantity; };                 // fill reduction
struct Replace { OrderId id; Price price; Quantity quantity; Priority policy; };
struct Delete  { OrderId id; };

// ---- semantic failure, never partial state ------------------------------
enum class BookError : std::uint8_t {
    duplicate_id, unknown_id, invalid_quantity, quantity_exceeded,
    order_capacity, level_capacity, price_out_of_range,
    stale_handle, sequence_gap, invariant_failure
};

using Result = std::expected<void, BookError>;   // C++23; [[nodiscard]] at call sites
```

```cpp
class Book {                                     // full definition in 38.7
public:
    [[nodiscard]] Result apply(Add     const&) noexcept;
    [[nodiscard]] Result apply(Cancel  const&) noexcept;
    [[nodiscard]] Result apply(Execute const&) noexcept;
    [[nodiscard]] Result apply(Replace const&) noexcept;
    [[nodiscard]] Result apply(Delete  const&) noexcept;

    [[nodiscard]] std::optional<Price>    best_bid()  const noexcept;
    [[nodiscard]] std::optional<Price>    best_ask()  const noexcept;
    [[nodiscard]] std::optional<Quantity> depth_at(Side, Price) const noexcept;
};
```

| Boundary decision | Consequence in C++ |
|---|---|
| authoritative *events to replay* vs local *commands to validate* | changes duplicate/unknown-ID policy and whether errors are fatal |
| partial cancel allowed? | `Cancel` carries a quantity vs `Delete` carrying none |
| replace keeps priority? | caller supplies `Priority`; the book must not invent it |
| errors returned or thrown? | `expected` keeps the hot path branch-visible and `noexcept` |
| observations by value or reference? | returning `span`/iterators into mutable storage is a lifetime + race bug |

**Interview line** — "Policy lives at the boundary; the link-manipulation primitives below it are unchecked, private, and assume validated inputs."

**Traps** — `[[nodiscard]]` on every `apply` or a dropped error silently corrupts · `Quantity{0}` must be rejected explicitly, not by underflow · one `apply` overload per command beats a stringly-typed opcode · an ID duplicate and a sequence duplicate are different diagnoses.

---

## 38.2 Price-time priority as C++ data-structure invariants

```text
bids: best = greatest active price          asks: best = smallest active price

Level @ 10100:  head → [id 7] ↔ [id 12] ↔ [id 19] ← tail
                        older                newer      (append at tail)
```

```text
I1  every active OrderId maps to exactly one live, generation-checked slot
I2  every live slot belongs to exactly one level, of its own side and price
I3  each chain is well-formed FIFO: head.prev == null, tail.next == null, links agree both ways
I4  level.aggregate == Σ remaining of its live orders; level.order_count == chain length
I5  empty levels are deactivated (bit cleared) — never reachable as "best"
I6  cached best identifies the best active level, or is empty
I7  a failed operation leaves every invariant intact and every index unchanged
I8  exactly one thread mutates; readers never traverse mutable internals
I9  a sequence gate decides whether an event may be applied exactly once
I10 capacity / duplicate / unknown-ID / gap outcomes are explicit values, not asserts
```

| Priority source | Valid? | Why |
|---|---|---|
| chain position (`prev`/`next`) | **yes** | the authoritative representation |
| slot index / pool address order | no | free list reuses slots out of order |
| `unordered_map` iteration order | no | unspecified, changes on rehash |
| `OrderId` magnitude | no | IDs need not be monotonic per level |
| arrival timestamp | no | event order is already sequenced; ties are unresolvable |
| insertion order into a rebuildable price index | no | a rebuild may produce a different order |

**Traps** — one `Level` per *order* instead of per *price* destroys the model · sorting a level by anything but insertion order silently reorders queue position · a comparator that reads mutable tick size is not a strict weak ordering.

---

## 38.3 Price level representation and intrusive FIFO order chains

```cpp
inline constexpr std::uint32_t null_index = 0xFFFF'FFFFu;

struct Handle {                                   // generation-checked reference
    std::uint32_t index{null_index};
    std::uint32_t generation{};
    friend constexpr bool operator==(Handle, Handle) = default;
};

struct OrderSlot {                                // 48 bytes with padding — one cache line holds 1⅓
    OrderId       id{};
    Price         price{};
    Quantity      remaining{};
    std::uint32_t prev{null_index};               // intrusive links: INDEX, not pointer
    std::uint32_t next{null_index};
    std::uint32_t level_index{null_index};        // back-pointer: O(1) unlink from ID alone
    std::uint32_t generation{};
    Side          side{};
    bool          live{};
};

struct Level {                                    // price is implied by ladder index
    Quantity      aggregate{};
    std::uint32_t order_count{};
    std::uint32_t head{null_index};
    std::uint32_t tail{null_index};
};
```

```cpp
// ---- private, unchecked link primitives: preconditions already validated ----
inline void link_back(Level& lv, std::uint32_t i, std::span<OrderSlot> s) noexcept {
    OrderSlot& n = s[i];
    n.prev = lv.tail;
    n.next = null_index;
    if (lv.tail == null_index) lv.head = i;            // first order in the level
    else                       s[lv.tail].next = i;
    lv.tail = i;
    ++lv.order_count;
    lv.aggregate.value += n.remaining.value;           // overflow prevalidated by caller
}

inline void link_front(Level& lv, std::uint32_t i, std::span<OrderSlot> s) noexcept {
    OrderSlot& n = s[i];                               // only for snapshot rebuild in reverse
    n.next = lv.head;
    n.prev = null_index;
    if (lv.head == null_index) lv.tail = i;
    else                       s[lv.head].prev = i;
    lv.head = i;
    ++lv.order_count;
    lv.aggregate.value += n.remaining.value;
}

inline void unlink(Level& lv, std::uint32_t i, std::span<OrderSlot> s) noexcept {
    OrderSlot& n = s[i];
    if (n.prev == null_index) lv.head          = n.next;   // was head
    else                      s[n.prev].next   = n.next;
    if (n.next == null_index) lv.tail          = n.prev;   // was tail
    else                      s[n.next].prev   = n.prev;
    --lv.order_count;
    lv.aggregate.value -= n.remaining.value;               // membership proves no underflow
    n.prev = n.next = null_index;
}
```

| Operation | Complexity | Precondition (unchecked) |
|---|---|---|
| `link_back` | O(1) | `i` live, not currently linked, aggregate cannot overflow |
| `link_front` | O(1) | same; used only by bulk rebuild |
| `unlink` | O(1) | `i` is a member of *this* level |
| chain traversal | O(order_count) | pointer chase across the slot array |

```cpp
// ---- iterate one level in strict FIFO order -----------------------------
for (std::uint32_t i = lv.head; i != null_index; i = slots[i].next) {
    OrderSlot const& o = slots[i];                 // oldest → newest
    consume(o.id, o.remaining);
}
```

**Traps** — a public unchecked `unlink(index)` turns a stale index into memory corruption · forgetting `n.prev = n.next = null_index` leaves a removed node "linked" to the audit · updating `remaining` *before* `unlink` desyncs the aggregate · `level_index` inside the slot is what makes cancel-by-ID O(1) — without it you must re-derive the level from `price` (still fine on a dense ladder, impossible on a hash of levels without a lookup).

---

## 38.4 Order-ID lookup and cancellation path

| Index choice | Expected lookup | Worst case | Bounded? |
|---|---:|---|---|
| `std::unordered_map<std::uint64_t, Handle>` | O(1) | rehash spike, node allocation, collision chain | no |
| `std::map<std::uint64_t, Handle>` | O(log n) | pointer chasing, allocation per node | no |
| sorted `vector<pair<Id,Handle>>` | O(log n) find | O(n) insert/erase, relocation | yes (capacity) |
| dense direct table `Handle[MaxId]` | O(1) | memory ∝ ID domain | yes |
| **fixed open-addressed table** | O(1) expected | clustering, tombstone buildup | **yes, explicit `full`** |

```cpp
// ---- fixed-capacity, power-of-two, linear-probing table with tombstones ----
class IdTable {
public:
    enum State : std::uint8_t { empty = 0, used = 1, dead = 2 };   // dead == tombstone
    struct Entry { OrderId id{}; Handle handle{}; State state{empty}; };

    explicit IdTable(std::size_t pow2_capacity)                    // must be a power of two
        : mask_{pow2_capacity - 1}, entries_(pow2_capacity) {}

    static constexpr std::size_t hash(OrderId id) noexcept {        // splitmix64 finalizer
        std::uint64_t x = id.value;
        x ^= x >> 30; x *= 0xbf58'476d'1ce4'e5b9ULL;
        x ^= x >> 27; x *= 0x94d0'49bb'1331'11ebULL;
        x ^= x >> 31;
        return static_cast<std::size_t>(x);
    }

    [[nodiscard]] Entry* find(OrderId id) noexcept {
        std::size_t i = hash(id) & mask_;
        for (std::size_t p = 0; p <= mask_; ++p, i = (i + 1) & mask_) {
            Entry& e = entries_[i];
            if (e.state == empty) return nullptr;        // empty terminates the probe
            if (e.state == used && e.id == id) return &e;
        }                                                // dead does NOT terminate
        return nullptr;
    }
    [[nodiscard]] Entry const* find(OrderId id) const noexcept {
        return const_cast<IdTable*>(this)->find(id);
    }

    // Cursor for a key already proven absent by find(); nullptr == table full.
    [[nodiscard]] Entry* reserve(OrderId id) noexcept {
        if ((used_ + dead_ + 1) * 10 > (mask_ + 1) * 7) return nullptr;   // load factor 0.70
        std::size_t i = hash(id) & mask_;
        Entry* recycled = nullptr;
        for (std::size_t p = 0; p <= mask_; ++p, i = (i + 1) & mask_) {
            Entry& e = entries_[i];
            if (e.state == dead)  { if (!recycled) recycled = &e; continue; }
            if (e.state == empty) return recycled ? recycled : &e;
        }
        return nullptr;
    }
    void commit(Entry* e, OrderId id, Handle h) noexcept {   // noexcept commit phase
        if (e->state == dead) --dead_;
        e->state = used; e->id = id; e->handle = h; ++used_;
    }
    void erase(Entry* e) noexcept { e->state = dead; --used_; ++dead_; }

    [[nodiscard]] std::size_t size()     const noexcept { return used_; }
    [[nodiscard]] std::size_t capacity() const noexcept { return mask_ + 1; }
    [[nodiscard]] std::span<Entry const> raw() const noexcept { return entries_; }

    void clear() noexcept {                                  // rebuild path
        for (Entry& e : entries_) e = Entry{};
        used_ = dead_ = 0;
    }
private:
    std::size_t        mask_;
    std::size_t        used_{};
    std::size_t        dead_{};
    std::vector<Entry> entries_;
};
```

| `IdTable` member | Complexity | Notes |
|---|---|---|
| `hash` | O(1) | avalanche finalizer; raw `id % n` clusters on sequential IDs |
| `find` | O(1) expected | stops at `empty`, skips `dead` |
| `reserve` | O(1) expected | returns `nullptr` at 70 % load → explicit `order_capacity` |
| `commit` | O(1), `noexcept` | never fails, so it is safe after linking work began |
| `erase` | O(1) | leaves a tombstone; `dead_` counts toward load |
| `clear` | O(capacity) | only on rebuild |

```cpp
// ---- std::unordered_map alternative, and why it is not a hard bound -------
std::unordered_map<std::uint64_t, Handle> ids;
ids.reserve(max_orders);        // bucket hint only — insertion can still allocate
ids.max_load_factor(0.7F);      // policy; bucket layout is unspecified
auto [it, ok] = ids.try_emplace(id.value, h);   // ok == false → duplicate, no overwrite
ids.erase(it);                  // O(1); iterators to OTHER elements stay valid
// node handles (C++17): auto n = ids.extract(k); n.key() = k2; ids.insert(std::move(n));
```

**Cancellation transaction — the ordering that makes it atomic**

```text
1 find ID → Entry*                       (fails: unknown_id)
2 resolve handle → live slot, generation (fails: stale_handle)
3 validate quantity vs remaining          (fails: quantity_exceeded / invalid_quantity)
4 locate level via slot.side + level_index (already O(1))
--- everything above is fallible and mutates nothing ---
5 reduce quantity  OR  unlink whole order
6 if fully removed: erase ID entry, release slot
7 if level now empty: deactivate and repair cached best
```

**Traps** — a tombstone must not terminate `find` or lookups break after churn · tombstones count toward load or the table degrades to a linear scan · `erase` then `reserve` for the same key can reuse the tombstone only because the key is proven absent · never `find` twice (once to check, once to erase) on the hot path — keep the `Entry*`.

---

## 38.5 Dense price ladder versus tree/map versus sorted-vector levels

| Representation | Find level | Best | Add/remove level | Domain |
|---|---:|---:|---:|---|
| **dense ladder + bitmap** | O(1) | O(1) cached, O(range/64) repair | O(1) set/clear bit | bounded, dense ticks |
| `std::map<Price, Level>` | O(log L) | O(1) via `begin()` | O(log L) + allocation | sparse/unbounded |
| sorted `vector<Level>` | O(log L) | O(1) endpoint | O(L) shift | low level churn |
| flat hash of levels | O(1) expected | needs a separate ordered summary | O(1) expected | fast lookup, extra best state |
| hybrid window + overflow map | O(1) in window | policy-dependent | rebasing cost | only with measured range data |

```cpp
// ---- dense ladder for one side, with an active-level bitmap and cached best ----
class DenseSide {
public:
    DenseSide(Side side, Price base, std::uint32_t tick_count)
        : side_{side}, base_{base}, levels_(tick_count), words_((tick_count + 63) / 64, 0) {}

    [[nodiscard]] std::optional<std::uint32_t> index_of(Price p) const noexcept {
        if (p.ticks < base_.ticks) return std::nullopt;                    // compare BEFORE subtracting
        auto const d = static_cast<std::uint64_t>(p.ticks - base_.ticks);  // no signed overflow now
        if (d >= levels_.size()) return std::nullopt;
        return static_cast<std::uint32_t>(d);
    }
    [[nodiscard]] Price price_at(std::uint32_t i) const noexcept {
        return Price{base_.ticks + static_cast<std::int64_t>(i)};
    }
    [[nodiscard]] Level&       level(std::uint32_t i)       noexcept { return levels_[i]; }
    [[nodiscard]] Level const& level(std::uint32_t i) const noexcept { return levels_[i]; }
    [[nodiscard]] std::uint32_t tick_count() const noexcept {
        return static_cast<std::uint32_t>(levels_.size());
    }

    void activate(std::uint32_t i) noexcept {                 // first order joined level i
        words_[i / 64] |= (1ULL << (i % 64));
        if (!best_ || better(i, *best_)) best_ = i;           // O(1): improvement only
    }
    void deactivate(std::uint32_t i) noexcept {               // last order left level i
        words_[i / 64] &= ~(1ULL << (i % 64));
        if (best_ && *best_ == i) best_ = rescan_from(i);     // repair derived state HERE
    }
    [[nodiscard]] bool active(std::uint32_t i) const noexcept {
        return (words_[i / 64] >> (i % 64)) & 1ULL;
    }
    [[nodiscard]] std::optional<std::uint32_t> best_index() const noexcept { return best_; }
    [[nodiscard]] std::optional<Price> best_price() const noexcept {
        return best_ ? std::optional{price_at(*best_)} : std::nullopt;
    }
    void reset() noexcept {                                   // rebuild path
        for (Level& l : levels_) l = Level{};
        for (std::uint64_t& w : words_) w = 0;
        best_.reset();
    }

    // next active index at or below `from` (bids) / at or above `from` (asks)
    [[nodiscard]] std::optional<std::uint32_t> scan_down(std::uint32_t from) const noexcept {
        std::size_t w = from / 64;
        unsigned const b = from % 64;
        std::uint64_t m = words_[w] & (b == 63 ? ~0ULL : ((1ULL << (b + 1)) - 1));
        for (;;) {
            if (m) return static_cast<std::uint32_t>(w * 64 + 63 - std::countl_zero(m)); // m != 0 proven
            if (w == 0) return std::nullopt;
            m = words_[--w];
        }
    }
    [[nodiscard]] std::optional<std::uint32_t> scan_up(std::uint32_t from) const noexcept {
        std::size_t w = from / 64;
        std::uint64_t m = words_[w] & (~0ULL << (from % 64));
        for (;;) {
            if (m) return static_cast<std::uint32_t>(w * 64 + std::countr_zero(m));
            if (++w == words_.size()) return std::nullopt;
            m = words_[w];
        }
    }
private:
    [[nodiscard]] bool better(std::uint32_t a, std::uint32_t b) const noexcept {
        return side_ == Side::bid ? a > b : a < b;            // bids: higher tick wins
    }
    [[nodiscard]] std::optional<std::uint32_t> rescan_from(std::uint32_t i) const noexcept {
        if (side_ == Side::bid) return i == 0 ? std::nullopt : scan_down(i - 1);
        return i + 1 >= levels_.size() ? std::nullopt : scan_up(i + 1);
    }

    Side                       side_;
    Price                      base_;
    std::vector<Level>         levels_;   // resize()d once at setup — never grows on the hot path
    std::vector<std::uint64_t> words_;    // 1 bit per tick: active-level summary
    std::optional<std::uint32_t> best_{};
};
```

```cpp
// ---- <bit> operations used above (C++20) --------------------------------
std::countr_zero(x);   // index of lowest set bit  — UB-free but returns width(x) if x == 0
std::countl_zero(x);   // leading zeros            — 63 - countl_zero(x) == index of highest set bit
std::popcount(x);      // active levels in a word
std::has_single_bit(n);// power-of-two check for table capacity
std::bit_ceil(n);      // round capacity up to a power of two
```

```cpp
// ---- ordered-tree alternative: comparator makes begin() the best ---------
using AskLevels = std::map<Price, Level, std::less<>>;      // begin() == lowest ask
using BidLevels = std::map<Price, Level, std::greater<>>;   // begin() == highest bid
auto it = bids.lower_bound(p);                              // O(log L)
auto [pos, inserted] = bids.try_emplace(p, Level{});        // no overwrite; nodes never move
bids.erase(pos);                                            // O(1) amortized given the iterator
// map/set iterators & references survive every insert; erase invalidates only the erased one.

// ---- sorted-vector alternative: compact, O(L) structural change ---------
struct PricedLevel { Price price; Level level; };
std::vector<PricedLevel> asks;                              // ascending
auto lo = std::ranges::lower_bound(asks, p, {}, &PricedLevel::price);
if (lo == asks.end() || lo->price != p) lo = asks.insert(lo, {p, Level{}});  // O(L) memmove
// invalidates every iterator/pointer past the insertion point — store indices, not Level*.
```

| Container | Iterator/reference stability | Best-price cost | Allocation on hot path |
|---|---|---|---|
| `vector<Level>` pre-sized | stable while never resized | cached + bitmap | none |
| `std::map` | all survive insert; erase kills only the erased | `begin()` O(1) | one node per new level |
| sorted `vector` | insert/erase invalidate from the point on | `front()`/`back()` O(1) | on growth |

**Traps** — subtracting `base_` before the range check invites signed overflow · `countr_zero(0)` is 64, not "none" — guard the word · `std::bitset<N>` needs compile-time `N` and has no "find next set bit" · dense ladder memory is ∝ *range*, not population — a 1 M-tick × 2 sides × 32 B level table is 64 MB · clearing that array on rebuild is a real O(range) cost.

---

## 38.6 Stable-address strategies and preallocated order storage

| Strategy | Benefit | Cost / trap |
|---|---|---|
| `std::list<Order>` | stable addresses + built-in links | one allocation and 2 pointers per order, cache misses, links duplicated |
| node map as owner | lookup + stable nodes | tree/hash overhead; price traversal still a separate structure |
| **pre-sized `vector<OrderSlot>` + free list** | compact, bounded, index-addressed | you own lifetime, exhaustion, and generations |
| `std::deque<OrderSlot>` | references stable across end growth | segmented, no hard capacity, reuse still needs generations |
| `vector<unique_ptr<Order>>` | pointee stable | allocation per order, double indirection |

```cpp
class SlotPool {
public:
    explicit SlotPool(std::size_t capacity)
        : slots_(capacity), free_(capacity), free_size_{capacity} {   // set in the mem-init list
        for (std::size_t i = 0; i < capacity; ++i)
            free_[i] = static_cast<std::uint32_t>(capacity - 1 - i);  // pop yields 0,1,2,… first
    }

    [[nodiscard]] std::optional<Handle> acquire() noexcept {
        if (free_size_ == 0) return std::nullopt;                     // explicit exhaustion
        std::uint32_t const i = free_[--free_size_];
        OrderSlot& s = slots_[i];
        ++s.generation;                                               // invalidates every old handle
        s.live = true;
        s.prev = s.next = s.level_index = null_index;
        return Handle{i, s.generation};
    }

    void release(std::uint32_t i) noexcept {
        OrderSlot& s = slots_[i];
        s.live = false;
        s.prev = s.next = s.level_index = null_index;
        s.remaining = Quantity{};                                     // generation is NOT reset
        free_[free_size_++] = i;
    }

    [[nodiscard]] OrderSlot* resolve(Handle h) noexcept {             // the only public way in
        if (h.index >= slots_.size()) return nullptr;                 // bounds
        OrderSlot& s = slots_[h.index];
        if (!s.live || s.generation != h.generation) return nullptr;  // liveness + generation
        return &s;
    }

    [[nodiscard]] OrderSlot&       operator[](std::uint32_t i)       noexcept { return slots_[i]; }
    [[nodiscard]] OrderSlot const& operator[](std::uint32_t i) const noexcept { return slots_[i]; }
    [[nodiscard]] std::span<OrderSlot>       span()       noexcept { return slots_; }
    [[nodiscard]] std::span<OrderSlot const> span() const noexcept { return slots_; }
    [[nodiscard]] std::size_t capacity() const noexcept { return slots_.size(); }
    [[nodiscard]] std::size_t live()     const noexcept { return slots_.size() - free_size_; }

    void reset() noexcept {                                           // rebuild: keep generations
        for (std::size_t i = 0; i < slots_.size(); ++i) {
            slots_[i].live = false;
            ++slots_[i].generation;
            free_[i] = static_cast<std::uint32_t>(slots_.size() - 1 - i);
        }
        free_size_ = slots_.size();
    }
private:
    std::vector<OrderSlot>     slots_;
    std::vector<std::uint32_t> free_;      // stack of free indices
    std::size_t                free_size_;
};
```

```cpp
// ---- non-trivial payloads: raw storage + explicit lifetime ---------------
alignas(OrderSlot) std::byte storage[sizeof(OrderSlot) * N];
auto* p = std::construct_at(reinterpret_cast<OrderSlot*>(storage) + i, args...);  // C++20
std::destroy_at(p);                                                               // before reuse
// std::launder is needed to read through an old pointer after in-place reconstruction.
```

- Declaration order controls member initialization: `std::size_t free_size_{free_.size()};` reads `free_` **before** it is constructed if declared earlier — set it in the constructor's mem-init list instead.
- Generation wrap: `std::uint32_t` wraps after 4 G reuses of *one* slot; make wrap terminal, widen to 64 bits, or prove no handle survives a wrap.
- A free-list stack (LIFO) maximizes cache reuse; a FIFO free list maximizes time before a slot is recycled (better ABA margin).

**Interview line** — "A pool index is stable storage; a generation makes it a stable *identity* — without the counter, a cancel can delete a newer unrelated order."

**Traps** — storing `OrderSlot*` anywhere outside the pool re-creates the dangling-pointer bug the pool exists to avoid · `resolve` must check bounds *and* `live` *and* `generation` · double-release corrupts the free list — assert `s.live` on entry.

---

## 38.7 Add, cancel, replace, execute, and delete transitions

The complete single-writer book. Every fallible step precedes the first link mutation, so the commit is unconditional.

```cpp
class Book {
public:
    Book(Price base, std::uint32_t tick_count, std::size_t max_orders)
        : pool_{max_orders},
          ids_{std::bit_ceil(max_orders * 2)},          // ≤ 0.70 load at full population
          bids_{Side::bid, base, tick_count},
          asks_{Side::ask, base, tick_count} {}

    // ---------------- ADD ----------------------------------------------
    [[nodiscard]] Result apply(Add const& c) noexcept {
        if (c.quantity.value == 0)   return std::unexpected(BookError::invalid_quantity);
        if (ids_.find(c.id))         return std::unexpected(BookError::duplicate_id);

        DenseSide& s  = side_of(c.side);
        auto const li = s.index_of(c.price);
        if (!li)                     return std::unexpected(BookError::price_out_of_range);

        Level& lv = s.level(*li);
        if (lv.aggregate.value > UINT64_MAX - c.quantity.value)
            return std::unexpected(BookError::quantity_exceeded);
        if (lv.order_count == UINT32_MAX)
            return std::unexpected(BookError::level_capacity);

        IdTable::Entry* cursor = ids_.reserve(c.id);    // fallible: table full
        if (!cursor)                 return std::unexpected(BookError::order_capacity);
        auto const h = pool_.acquire();                 // fallible: pool exhausted
        if (!h)                      return std::unexpected(BookError::order_capacity);

        // ----------------- noexcept commit; nothing below can fail -----------------
        OrderSlot& o    = pool_[h->index];
        o.id            = c.id;
        o.price         = c.price;
        o.remaining     = c.quantity;
        o.side          = c.side;
        o.level_index   = *li;

        bool const was_empty = (lv.order_count == 0);
        link_back(lv, h->index, pool_.span());
        ids_.commit(cursor, c.id, *h);
        if (was_empty) s.activate(*li);                 // sets bit AND repairs best
        return {};
    }

    // ---------------- CANCEL (partial reduction) ------------------------
    [[nodiscard]] Result apply(Cancel const& c) noexcept  { return reduce(c.id, c.quantity); }
    // ---------------- EXECUTE (fill reduction) --------------------------
    [[nodiscard]] Result apply(Execute const& c) noexcept { return reduce(c.id, c.quantity); }

    // ---------------- DELETE (remove all remaining) ---------------------
    [[nodiscard]] Result apply(Delete const& c) noexcept {
        IdTable::Entry* e = ids_.find(c.id);
        if (!e)                      return std::unexpected(BookError::unknown_id);
        OrderSlot* o = pool_.resolve(e->handle);
        if (!o)                      return std::unexpected(BookError::stale_handle);
        remove_whole(*e, *o);                            // noexcept
        return {};
    }

    // ---------------- REPLACE (its own transition) ----------------------
    [[nodiscard]] Result apply(Replace const& c) noexcept {
        if (c.quantity.value == 0)   return std::unexpected(BookError::invalid_quantity);
        IdTable::Entry* e = ids_.find(c.id);
        if (!e)                      return std::unexpected(BookError::unknown_id);
        OrderSlot* op = pool_.resolve(e->handle);
        if (!op)                     return std::unexpected(BookError::stale_handle);
        OrderSlot& o = *op;

        DenseSide& s   = side_of(o.side);                // replace never changes side
        auto const dst = s.index_of(c.price);
        if (!dst)                    return std::unexpected(BookError::price_out_of_range);

        std::uint32_t const src = o.level_index;
        Level& dlv = s.level(*dst);
        // Destination-capacity check BEFORE unlinking the source.
        std::uint64_t const dst_after_unlink =
            dlv.aggregate.value - (*dst == src ? o.remaining.value : 0);
        if (dst_after_unlink > UINT64_MAX - c.quantity.value)
            return std::unexpected(BookError::quantity_exceeded);

        // ----------------- noexcept commit -----------------
        bool const in_place = (*dst == src) && (c.policy == Priority::retain);
        if (in_place) {                                  // same price, priority kept
            Level& lv = s.level(src);
            lv.aggregate.value -= o.remaining.value;
            lv.aggregate.value += c.quantity.value;
            o.remaining = c.quantity;
            return {};
        }
        Level& slv = s.level(src);
        unlink(slv, e->handle.index, pool_.span());      // priority reset or price move
        if (slv.order_count == 0) s.deactivate(src);

        o.price       = c.price;
        o.remaining   = c.quantity;
        o.level_index = *dst;
        bool const was_empty = (dlv.order_count == 0);
        link_back(dlv, e->handle.index, pool_.span());   // tail = lost priority
        if (was_empty) s.activate(*dst);
        return {};
    }

    // ---------------- queries -------------------------------------------
    [[nodiscard]] std::optional<Price> best_bid() const noexcept { return bids_.best_price(); }
    [[nodiscard]] std::optional<Price> best_ask() const noexcept { return asks_.best_price(); }

    [[nodiscard]] std::optional<Quantity> depth_at(Side sd, Price p) const noexcept {
        DenseSide const& s = (sd == Side::bid) ? bids_ : asks_;
        auto const i = s.index_of(p);
        if (!i || !s.active(*i)) return std::nullopt;
        return s.level(*i).aggregate;
    }
    [[nodiscard]] std::size_t order_count() const noexcept { return ids_.size(); }

    // ---------------- defined in 38.10–38.12 -----------------------------
    void reset() noexcept;                                    // rebuild: clear every index
    [[nodiscard]] Result dispatch(BufferedEvent const&) noexcept;   // replay one buffered event
    template<std::size_t N> void project(BookSnapshot<N>&, std::uint64_t seq) const noexcept;
    void digest(Digest&) const noexcept;
    [[nodiscard]] Result audit() const noexcept;

private:
    [[nodiscard]] DenseSide& side_of(Side s) noexcept { return s == Side::bid ? bids_ : asks_; }

    [[nodiscard]] Result reduce(OrderId id, Quantity q) noexcept {
        if (q.value == 0)            return std::unexpected(BookError::invalid_quantity);
        IdTable::Entry* e = ids_.find(id);
        if (!e)                      return std::unexpected(BookError::unknown_id);
        OrderSlot* o = pool_.resolve(e->handle);
        if (!o)                      return std::unexpected(BookError::stale_handle);
        if (q.value > o->remaining.value)
            return std::unexpected(BookError::quantity_exceeded);

        // ----------------- noexcept commit -----------------
        if (q.value == o->remaining.value) { remove_whole(*e, *o); return {}; }
        DenseSide& s = side_of(o->side);
        Level& lv    = s.level(o->level_index);
        o->remaining.value -= q.value;                   // FIFO position UNCHANGED
        lv.aggregate.value -= q.value;                   // one transition, both indexes
        return {};
    }

    void remove_whole(IdTable::Entry& e, OrderSlot& o) noexcept {
        DenseSide&          s  = side_of(o.side);
        std::uint32_t const li = o.level_index;
        Level&              lv = s.level(li);
        std::uint32_t const idx = e.handle.index;
        unlink(lv, idx, pool_.span());                   // 1: while the level still owns it
        if (lv.order_count == 0) s.deactivate(li);       // 2: deactivate + repair best together
        ids_.erase(&e);                                  // 3: index cannot reach a freed slot
        pool_.release(idx);                              // 4: slot retires last
    }

    SlotPool  pool_;
    IdTable   ids_;
    DenseSide bids_;
    DenseSide asks_;
};
```

| Transition | Fallible phase | Commit phase | Complexity |
|---|---|---|---|
| `Add` | qty, duplicate, range, overflow, table, pool | init slot · link tail · commit ID · activate | O(1) |
| `Cancel`/`Execute` partial | qty, ID, handle, ≤ remaining | `remaining -= q`; `aggregate -= q` | O(1) |
| `Cancel`/`Execute` full | same | `remove_whole` | O(1) + best repair |
| `Delete` | ID, handle | `remove_whole` | O(1) + best repair |
| `Replace` in place | qty, ID, handle, range, dest overflow | two aggregate adjusts | O(1) |
| `Replace` relink | same | unlink · deactivate · relink · activate | O(1) + best repair |
| best repair (dense) | — | O(1) typical, O(range/64) worst | bitmap word scan |

```text
same price + Priority::retain  → adjust quantities in place, queue position kept
same price + Priority::reset   → unlink, update, append to tail
new price                      → validate destination, unlink source, relink destination
```

| Failure point | Required state |
|---|---|
| duplicate / unknown ID, bad quantity, out-of-range price | completely unchanged |
| pool full / ID table full / aggregate overflow | completely unchanged |
| invariant failure discovered mid-commit | book and stream are terminal unless rollback is *proven* |

**Interview line** — "Replace is not cancel-plus-add: the ID survives, priority retention is an input, and the destination must be validated before the source is unlinked."

**Traps** — deactivating the level before unlinking reads a level whose counts are stale · `ids_.erase` before `unlink` leaves an unreachable but linked node · releasing the slot before erasing the ID leaves the index pointing at a free slot · reducing `o.remaining` before `unlink` makes the aggregate drift · `apply(Add)` must reject `quantity == 0` or `remove_whole` never runs and a zero-quantity ghost sits in the chain forever.

---

## 38.8 Best bid/ask maintenance and empty-level removal

- Cached best is **derived**: it may only change inside `activate`/`deactivate`, never in the caller.
- Activation is O(1) — a new level can only *improve* the best or not matter.
- Deactivation is the expensive direction: if the removed level *was* best, the next best must be found.

```cpp
// Restated from 38.5 — bids improve upward, asks improve downward.
void DenseSide::activate(std::uint32_t i) noexcept {
    words_[i / 64] |= (1ULL << (i % 64));
    if (!best_ || (side_ == Side::bid ? i > *best_ : i < *best_)) best_ = i;
}
void DenseSide::deactivate(std::uint32_t i) noexcept {
    words_[i / 64] &= ~(1ULL << (i % 64));
    if (best_ && *best_ == i)
        best_ = (side_ == Side::bid) ? (i == 0 ? std::nullopt : scan_down(i - 1))
                                     : (i + 1 >= levels_.size() ? std::nullopt : scan_up(i + 1));
}
```

| Strategy for "next best" | Cost | Notes |
|---|---|---|
| linear scan over `vector<Level>` | O(range) | dominates on sparse books — the classic hidden cost |
| flat bitmap (`words_`) | O(range/64) | 1 M ticks → 16 K word loads worst case, contiguous |
| two-level (or three-level) hierarchical bitmap | O(1)–O(3) loads | summary bit per 64-word block; the production answer |
| `std::map` with side comparator | O(1) `begin()` | tree already maintains the order |
| separate max-heap of active prices | O(log L) | needs lazy deletion — heaps have no decrease-key |

```cpp
// ---- two-level summary: 64 × 64 = 4096 ticks per summary word ----------
std::vector<std::uint64_t> words_;    // bit per tick
std::vector<std::uint64_t> summary_;  // bit set iff words_[w] != 0
void set_bit(std::uint32_t i) {
    words_[i / 64]   |= 1ULL << (i % 64);
    summary_[i / 4096] |= 1ULL << ((i / 64) % 64);
}
void clear_bit(std::uint32_t i) {
    if ((words_[i / 64] &= ~(1ULL << (i % 64))) == 0)
        summary_[i / 4096] &= ~(1ULL << ((i / 64) % 64));
}
```

```cpp
// ---- top-N walk (dense, bids: descending) -------------------------------
std::size_t n = 0;
auto i = bids_.best_index();
while (i && n < N) {
    Level const& lv = bids_.level(*i);
    out[n++] = LevelView{bids_.price_at(*i), lv.aggregate, lv.order_count};
    i = (*i == 0) ? std::nullopt : bids_.scan_down(*i - 1);
}
```

- Use `std::optional<Price>`, not a sentinel like `INT64_MIN` — a sentinel is only safe if no valid price can equal it.
- Assert on deactivation that `aggregate == 0 && order_count == 0 && head == null && tail == null`.
- A crossed book (`best_bid >= best_ask`) is a *validation* signal, not something the structure should silently allow.

**Traps** — "best is O(1)" is false the moment the empty-level path is a scan · updating `best_` from the caller after `deactivate` double-repairs and can select an empty level · `scan_down(*best_)` instead of `scan_down(*best_ - 1)` re-finds the level you just cleared only if the bit was not cleared first · a level whose orders all reduce to zero must go through `remove_whole`, not a bare aggregate decrement.

---

## 38.9 Sequence checks, duplicate handling, and gap state

```cpp
enum class FeedState : std::uint8_t { cold, live, recovering, failed };

class SequenceGate {
public:
    enum class Action : std::uint8_t { apply, ignore_duplicate, gap, reject };

    [[nodiscard]] Action classify(std::uint64_t seq) const noexcept {
        if (state_ != FeedState::live) return Action::reject;
        if (seq == next_) return Action::apply;
        if (less_modular(seq, next_)) return Action::ignore_duplicate;   // old/retransmit
        return Action::gap;                                             // forward hole
    }
    void advance(std::uint64_t applied) noexcept { next_ = applied + 1; }  // only on apply-success
    void enter_recovery() noexcept { state_ = FeedState::recovering; }
    void go_live(std::uint64_t first_expected) noexcept { state_ = FeedState::live; next_ = first_expected; }
    [[nodiscard]] FeedState state() const noexcept { return state_; }

    // Wrapping protocols: "<" is meaningless; use a signed half-window comparison.
    static constexpr bool less_modular(std::uint64_t a, std::uint64_t b) noexcept {
        return static_cast<std::int64_t>(a - b) < 0;
    }
private:
    FeedState     state_{FeedState::cold};
    std::uint64_t next_{};
};
```

| Input while `live` | Action | Book effect |
|---|---|---|
| `seq == next` | apply once, then `advance` | mutates |
| `seq < next` (modular) | count as duplicate, ignore | none |
| `seq > next` | enter `recovering`, buffer or drop | none |
| any while `cold`/`recovering`/`failed` | reject or buffer per protocol | none |

```cpp
Result on_event(std::uint64_t seq, Add const& a) noexcept {
    switch (gate_.classify(seq)) {
        case SequenceGate::Action::apply: {
            auto r = book_.apply(a);
            if (r) gate_.advance(seq);          // advance ONLY on success — else you skip an event
            return r;
        }
        case SequenceGate::Action::ignore_duplicate: ++dupes_; return {};
        case SequenceGate::Action::gap:  gate_.enter_recovery(); return std::unexpected(BookError::sequence_gap);
        case SequenceGate::Action::reject: return std::unexpected(BookError::sequence_gap);
    }
    return std::unexpected(BookError::invariant_failure);
}
```

- A replayed old `Add` looks like `duplicate_id`; catching it at the *sequence* boundary preserves the correct diagnosis.
- Decide explicitly whether a *rejected* event still advances the sequence (usually yes for authoritative feeds, no for local commands).
- Per-instrument vs per-channel sequences are different gates — do not share one counter across books.

**Traps** — advancing `next_` before `apply` succeeds silently loses an event · `a < b` on wrapping counters flips at the boundary · buffering gap events without a bound is an unbounded memory leak under a broken feed · a duplicate counter that is never inspected hides a broken transport.

---

## 38.10 Snapshot rebuild and incremental replay

```text
Book A stays published and readable
        │
        ├── construct candidate Book B (fresh indexes, or reset() a spare)
        ├── load validated snapshot rows into B, preserving input FIFO order
        ├── buffer bounded incrementals arriving during the load
        ├── establish the sequence bridge (snapshot seq → first incremental)
        ├── replay buffered incrementals into B through the SAME apply() code
        ├── audit B (38.12) and compare its digest with the source if available
        └── promote B atomically; retire A after readers have drained (see #ch40)
```

```cpp
class BookBuilder {
public:
    explicit BookBuilder(Book& target) noexcept : b_{target} {}

    [[nodiscard]] Result load_row(Add const& row) noexcept { return b_.apply(row); }  // same transition

    [[nodiscard]] Result finish(std::uint64_t snapshot_seq,
                                std::span<BufferedEvent const> pending) noexcept {
        for (BufferedEvent const& ev : pending) {
            if (SequenceGate::less_modular(ev.seq, snapshot_seq + 1)) continue;   // already included
            if (auto r = b_.dispatch(ev); !r) return r;
        }
        return b_.audit();                                                        // 38.12
    }
private:
    Book& b_;
};
```

Rebuild requirements — each is a separate failure mode:

- Fully reset **every** index: slots, free list, ID table, all levels, all bitmap words, both cached bests, aggregates.
- Reject duplicate IDs and zero quantities *in snapshot input* — a snapshot is untrusted data.
- Preserve the snapshot's stated FIFO order explicitly; do not rely on row order being priority order unless the protocol says so.
- Bound the incremental buffer and report overflow as a recoverable failure, not `bad_alloc`.
- Publish only at one sequence boundary — a partially rebuilt book must never be visible.

```cpp
void Book::reset() noexcept {          // reuse a pre-allocated spare: no allocation, O(range)
    pool_.reset();                     // bumps every generation → all old handles die
    ids_.clear();
    bids_.reset();
    asks_.reset();
}
```

- A bulk builder (sort rows per level, then `link_back` in order) beats event-by-event insertion, but must be differential-tested against `apply` to the same digest.
- Double-buffering two `Book` objects costs 2× memory and makes promotion a single pointer store.

**Traps** — clearing the live book in place while readers hold it is the canonical rebuild bug · forgetting to clear the bitmap leaves phantom active levels with empty chains · a snapshot that omits the sequence number cannot be bridged · reusing generations across a reset lets a pre-rebuild handle resolve.

---

## 38.11 Single-writer ownership and read-side snapshots

```text
writer thread : mutate Book (plain, non-atomic fields) → build immutable projection → publish
reader threads: acquire published projection → read only that object → never touch Book
```

- Internal fields may be plain (non-atomic) precisely because exactly one thread reads *and* writes them.
- Making `OrderSlot::remaining` atomic buys nothing: a reader could see a new quantity with an old level aggregate, or a removed node still reachable through the ID map.
- The unit of publication is a **whole coherent projection at one sequence number**, not a field.

```cpp
struct LevelView { Price price{}; Quantity aggregate{}; std::uint32_t order_count{}; };

template<std::size_t N>
struct BookSnapshot {                        // trivially copyable, no pointers into the book
    std::uint64_t              sequence{};
    std::array<LevelView, N>   bids{};
    std::array<LevelView, N>   asks{};
    std::uint32_t              bid_count{};
    std::uint32_t              ask_count{};
};

template<std::size_t N>
void Book::project(BookSnapshot<N>& out, std::uint64_t seq) const noexcept {
    out = BookSnapshot<N>{};
    out.sequence = seq;
    auto i = bids_.best_index();
    while (i && out.bid_count < N) {
        Level const& lv = bids_.level(*i);
        out.bids[out.bid_count++] = {bids_.price_at(*i), lv.aggregate, lv.order_count};
        i = (*i == 0) ? std::nullopt : bids_.scan_down(*i - 1);
    }
    auto j = asks_.best_index();
    while (j && out.ask_count < N) {
        Level const& lv = asks_.level(*j);
        out.asks[out.ask_count++] = {asks_.price_at(*j), lv.aggregate, lv.order_count};
        j = (*j + 1 >= asks_.tick_count()) ? std::nullopt : asks_.scan_up(*j + 1);
    }
}
```

```cpp
// Publication (protocol details in #ch40): the snapshot is immutable once stored.
std::atomic<std::shared_ptr<BookSnapshot<10> const>> top10;     // C++20 atomic<shared_ptr>
top10.store(std::make_shared<BookSnapshot<10> const>(built), std::memory_order_release);
auto view = top10.load(std::memory_order_acquire);              // reader owns a stable copy
```

| Exposed to readers | Verdict |
|---|---|
| `BookSnapshot` by value / immutable `shared_ptr` | safe |
| `Level const&`, `std::span<OrderSlot const>`, iterators | **race + dangling** — the writer mutates them |
| `std::atomic<Quantity>` per level | still torn across indexes |
| a mutex around every `apply` | correct but serializes the writer's hot path |

**Interview line** — "One writer means one owner of the whole multi-index transaction; readers get immutable snapshots, never a pointer into live storage."

**Traps** — `shared_ptr` copy in the reader is an atomic RMW on the control block — pre-size and reuse if it shows up in profiles · building the projection *while* mutating produces a torn view · `project` on the writer thread must run between transitions, not inside one.

---

## 38.12 Invariants, property tests, and deterministic replay

```cpp
[[nodiscard]] Result Book::audit() const noexcept {   // debug/test builds and on demand
    std::size_t linked = 0;
    for (DenseSide const* s : {&bids_, &asks_}) {
        for (std::uint32_t li = 0; li < s->tick_count(); ++li) {
            Level const& lv = s->level(li);
            bool const empty = (lv.order_count == 0);
            if (empty != (lv.head == null_index)) return std::unexpected(BookError::invariant_failure);
            if (empty != (lv.tail == null_index)) return std::unexpected(BookError::invariant_failure);
            if (s->active(li) == empty)           return std::unexpected(BookError::invariant_failure);

            std::uint64_t sum = 0;
            std::uint32_t n = 0, prev = null_index;
            for (std::uint32_t i = lv.head; i != null_index; i = pool_[i].next) {
                OrderSlot const& o = pool_[i];
                if (!o.live)                       return std::unexpected(BookError::invariant_failure);
                if (o.prev != prev)                return std::unexpected(BookError::invariant_failure);
                if (o.level_index != li)           return std::unexpected(BookError::invariant_failure);
                if (o.price != s->price_at(li))    return std::unexpected(BookError::invariant_failure);
                if (o.remaining.value == 0)        return std::unexpected(BookError::invariant_failure);
                if (sum > UINT64_MAX - o.remaining.value)   // checked add: the auditor must not wrap
                    return std::unexpected(BookError::invariant_failure);
                sum += o.remaining.value;
                if (++n > pool_.capacity())        return std::unexpected(BookError::invariant_failure); // cycle
                prev = i;
            }
            if (prev != lv.tail)                   return std::unexpected(BookError::invariant_failure);
            if (n != lv.order_count)               return std::unexpected(BookError::invariant_failure);
            if (sum != lv.aggregate.value)         return std::unexpected(BookError::invariant_failure);
            linked += n;
        }
        // cached best == best active level, or empty
        auto const b = s->best_index();
        for (std::uint32_t li = 0; li < s->tick_count(); ++li)
            if (s->active(li) && (!b || (s == &bids_ ? li > *b : li < *b)))
                return std::unexpected(BookError::invariant_failure);
        if (b && !s->active(*b))                   return std::unexpected(BookError::invariant_failure);
    }
    if (linked != ids_.size())                     return std::unexpected(BookError::invariant_failure);
    if (linked != pool_.live())                    return std::unexpected(BookError::invariant_failure);
    for (IdTable::Entry const& e : ids_.raw())     // every index entry resolves to its own slot
        if (e.state == IdTable::used) {
            if (e.handle.index >= pool_.capacity()) return std::unexpected(BookError::invariant_failure);
            OrderSlot const& o = pool_[e.handle.index];
            if (!o.live || o.generation != e.handle.generation || o.id != e.id)
                return std::unexpected(BookError::invariant_failure);
        }
    return {};
}
```

```text
per live slot : ID index resolves to this exact generation · level exists · appears once in that chain
per level     : forward/backward links agree · traversal terminates · count matches · sum == aggregate
global        : live slots == ID index size == Σ level counts · free + live == capacity · best is correct
```

```cpp
// ---- canonical state digest: side, then price ascending, then FIFO order ----
struct Digest {
    std::uint64_t h{0xcbf2'9ce4'8422'2325ULL};                 // FNV-1a 64 offset basis
    constexpr void add_u64(std::uint64_t v) noexcept {
        for (int b = 0; b < 8; ++b) { h ^= (v >> (b * 8)) & 0xFF; h *= 0x0000'0100'0000'01B3ULL; }
    }
    constexpr void add_i64(std::int64_t v) noexcept { add_u64(static_cast<std::uint64_t>(v)); }
};

void Book::digest(Digest& d) const noexcept {
    for (DenseSide const* s : {&bids_, &asks_})
        for (std::uint32_t li = 0; li < s->tick_count(); ++li) {
            if (!s->active(li)) continue;                      // skip empties: canonical
            d.add_i64(s->price_at(li).ticks);
            for (std::uint32_t i = s->level(li).head; i != null_index; i = pool_[i].next) {
                d.add_u64(pool_[i].id.value);                  // field by field — never memcpy a struct
                d.add_u64(pool_[i].remaining.value);           // (padding bytes are indeterminate)
            }
        }
}
```

**Property-test loop**

```cpp
// 1. generate a random validated op stream (add/cancel/execute/replace/delete)
// 2. apply to Book and to a slow reference model (std::map<Price, std::vector<Order>>)
// 3. after EVERY op: assert(book.audit()); assert(book.digest() == model.digest());
// 4. shrink failing streams to a minimal reproducer; replay the same seed for determinism
```

| Tool | Invocation | Finds |
|---|---|---|
| ASan | `-fsanitize=address -fno-omit-frame-pointer` | stale index → out-of-bounds slot access |
| UBSan | `-fsanitize=undefined` | signed overflow in `price - base`, bad shifts |
| assertions | `-D_GLIBCXX_ASSERTIONS` / `-D_LIBCPP_HARDENING_MODE=…` | `vector::operator[]` out of range |
| fuzzing | `-fsanitize=fuzzer` over a byte→op decoder | gap/duplicate/capacity paths |

**Traps** — hashing the raw struct includes padding and produces machine-dependent digests · iterating an `unordered_map` for the digest makes it order-dependent · an audit that itself wraps arithmetic hides the bug it looks for · a cycle in the chain hangs the auditor unless the traversal is bounded.

---

## 38.13 Cost model: lookup, insertion, cancellation, traversal, and cache behavior

Let `O` = active orders, `L` = active levels, `R` = tick range.

| Operation | tree levels + `unordered_map` + `list` | dense ladder + flat table + pool |
|---|---|---|
| add at existing level | O(1) expected ID + O(log L) level + 1 alloc | O(1), zero allocation |
| add creating a level | O(log L) + node allocation | O(1) bit set + O(1) best compare |
| cancel/execute partial | O(1) expected + pointer chase | O(1), 2 cache lines |
| delete / full cancel | O(1) expected + O(log L) possible level erase + free | O(1) + O(1)–O(R/64) best repair |
| replace, same price | O(1) | O(1) |
| replace, new price | 2 level ops + relink | O(1) if both in range |
| best query | O(1) (`begin()`) | O(1) cached |
| remove best level | O(log L) erase, next is O(1) | O(1) with hierarchical bitmap, O(R/64) flat |
| top-N traversal | O(N) with tree + list pointer chasing | O(N) + gap scan, contiguous |
| memory | ∝ O + L, plus allocator overhead per node | ∝ O + R (levels always resident) |

**What Big-O hides — the actual latency sources**

- Hash probe count and collision tails at high load factor; tombstone accumulation.
- Rehash / tree rebalance / allocator slow-path spikes at *specific populations* — a tail-latency cliff, not an average.
- Pointer chasing: a `std::list` cancel touches 3 unrelated cache lines; a pool cancel touches the slot, its 2 neighbours, and the level.
- Slot size drives the working set: 48 B × 1 M orders = 48 MB; shrinking to 32 B fits 33 % more per cache line.
- Dense level arrays are always resident: `R` × 24 B × 2 sides, plus the O(R) memset on rebuild.
- Branch predictability: the error and empty-level paths are cold — mark them `[[unlikely]]` and keep them out of the inline body.
- Redundant aggregates (`order_count`, `aggregate`) are extra stores on *every* transition — they exist to make queries O(1), and that trade must be measured.

```cpp
// ---- keeping the hot path branch-lean -----------------------------------
if (!e) [[unlikely]] return std::unexpected(BookError::unknown_id);   // C++20 attribute
alignas(64) std::vector<Level> levels_;   // level array head aligned to a cache line
static_assert(sizeof(OrderSlot) == 48);   // guard against accidental growth
// Prefetch the slot as soon as the ID lookup yields the handle:
__builtin_prefetch(&pool_[e->handle.index]);   // GCC/Clang; measure before believing
```

**Benchmark rules**

```text
measure a REALISTIC mix (adds ≈ cancels, ~5-10 % deletes hitting best), not lookup microbenchmarks
report p50 / p99 / p99.9 / max, never the mean
run AT capacity — the interesting behaviour is at 70 %+ load and full pools
pin the thread, disable turbo/frequency scaling, warm the caches, count instructions AND cycles
compare against a fixed replay stream so runs are bit-identical (see the digest in 38.12)
```

**Interview line** — "Choose the dense ladder when the tick range is bounded and reasonably dense; choose the tree when prices are sparse or unbounded — and in both cases the cost that decides it is removing the best level, not looking one up."

**Traps** — quoting "O(1) best" without the empty-level repair path · benchmarking add-only streams (no cancels, no level churn) · ignoring the O(R) clear on rebuild when sizing the ladder · assuming a flat table beats `unordered_map` without measuring at *your* load factor and key distribution.

---

## Recall card

```text
API             normalized sequenced commands in; values and immutable snapshots out
priority        price index selects the level; intrusive FIFO chain carries time
identity        OrderId → open-addressed table → generation-checked pool Handle
order storage   pre-sized vector<OrderSlot> + free-list stack; explicit exhaustion
level storage   dense ladder + active bitmap | map with side comparator | sorted vector
add             validate + reserve table slot + acquire pool slot, THEN link/commit/activate
cancel/execute  O(1) ID lookup; quantity delta in place, or full unlink via remove_whole
delete          unlink → deactivate if empty → erase ID → release slot, in that order
replace         explicit Priority; validate destination before unlinking the source
best            cached index repaired inside activate/deactivate; bitmap finds the next
sequence        == next apply | < next duplicate | > next gap → recovery
rebuild         fresh candidate + bounded replay + audit + atomic promotion
concurrency     one writer owns the whole transaction; readers get value snapshots
proof           link/count/sum/index/best audit + canonical digest + differential replay
cost            allocation, probes, pointer chasing, empty-gap scans, resident level array
```

**Core design sentence** — A robust order book stores each order once in bounded stable storage, reaches it in O(1) through a generation-checked ID index, links it into exactly one price-level FIFO, mutates every redundant index and aggregate as a single all-or-nothing transition, and publishes only complete immutable observations.
