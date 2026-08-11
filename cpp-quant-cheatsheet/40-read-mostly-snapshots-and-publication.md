# 40. Read-mostly snapshots and publication

*Part VI-B — Quant blueprints: pipeline, publication, and runtime*

---

**Recall**
- Publication has three independent correctness problems: **visibility** (release/acquire), **consistency** (one coherent version), **lifetime** (nobody reclaims what a reader still reads).
- A release store publishes every write *sequenced before* it to any thread whose acquire load *observes* that store.
- An atomic pointer publishes an address; it does not own, keep alive, or reclaim the pointee.
- The default design is build-privately → publish identity with `release` → reader `acquire`s identity → reader holds a lifetime right until done.
- Immutability removes the consistency problem entirely: a fully-built `const` object cannot be observed mid-update.
- `std::atomic<std::shared_ptr<T>>` (C++20) is the correctness baseline: atomic publication + owning reader handle, paid for in refcount traffic and possible internal locking.
- Naïve double buffering is unsafe: "the writer republished" does not imply "every reader left the old buffer."
- Triple buffering buys slack, not a lifetime proof — an arbitrarily stalled reader defeats any fixed buffer count without a pin protocol.
- A generation/version tag *detects* that a slot changed; it cannot retroactively legalize a C++ data race.
- A classic seqlock over ordinary non-atomic fields is UB in portable C++ regardless of how the version check turns out.
- The portable seqlock stores payload in `std::atomic` fields (or `memcpy`s `atomic_ref`/byte-wise atomics) and validates with an even/odd sequence.
- Seqlock writer order: `seq++` (relaxed) → `release` fence → payload stores → `release` → `seq+1`; reader: `acquire` seq → payload → `acquire` fence → re-read seq.
- Seqlock readers are wait-free only if the writer stops; a continuously publishing writer can starve readers indefinitely.
- Independent atomic fields never form a transaction — `seq_cst` gives a global *order* of operations, not multi-load atomicity.
- `std::atomic<T>` on a trivially copyable aggregate gives whole-value snapshots, but large `T` is typically lock-free-*false* and takes a hidden library lock.
- Reclamation menu: retain-forever · refcount · per-slot reader counts · epochs/QSBR · hazard pointers · locks — pick from the *reader* guarantee, not from the writer's convenience.
- `std::hazard_pointer` and `std::rcu_domain` are C++26 (P2530/P2545); pre-C++26 use folly/libcds or hand-rolled with proof.
- Latest-value publication may skip versions; if every version matters you need a queue with capacity and backpressure, not a replaced pointer.
- Shutdown order: stop publishing → block new acquisitions → drain guards → reclaim retired → destroy publisher.
- Test with self-describing snapshots (version-derived payload + checksum), pause hooks at protocol boundaries, and TSan — which proves neither lock-freedom nor absence of every ordering bug.

---

## 40.1 Immutable snapshots and copy/publish designs

```cpp
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <utility>

// ---- The read model: self-contained, trivially copyable, no back-pointers ----
struct LevelView {
    std::int64_t  price_ticks{};
    std::uint64_t quantity{};
};

struct Snapshot {
    std::uint64_t            sequence{};    // version INSIDE the value
    std::array<LevelView, 8> bids{};        // fixed extent, no vector/string
    std::array<LevelView, 8> asks{};
    std::uint8_t             bid_count{};
    std::uint8_t             ask_count{};
};
static_assert(std::is_trivially_copyable_v<Snapshot>);   // memcpy-able, poolable
// A snapshot holding span/string_view/T* is NOT self-contained unless the
// referent's lifetime is provably >= the snapshot's.

// ---- Canonical copy/publish publisher ---------------------------------------
class Publisher {
public:
    // 1 build privately  2 fill all fields  3 release-publish identity
    void publish(Snapshot next) {
        next.sequence = ++seq_;                                  // writer-local
        auto p = std::make_shared<Snapshot const>(next);         // one alloc
        current_.store(std::move(p), std::memory_order_release); // step 3
    }

    // Reader acquires an OWNING handle: lifetime solved by refcount.
    [[nodiscard]] std::shared_ptr<Snapshot const> read() const noexcept {
        return current_.load(std::memory_order_acquire);
    }

private:
    std::atomic<std::shared_ptr<Snapshot const>> current_{};   // C++20
    std::uint64_t                                seq_{0};      // writer-only
};
```

```text
writer                                  reader
  construct candidate privately           .
  ordinary stores establish invariants    .
  ---- release store of identity ----> acquire load of identity
                                          reads ONE immutable snapshot
                                          drops pin/ownership
  reuse/reclaim only after that
```

```cpp
// ---- Building a snapshot from mutable writer state (projection) -------------
class BookProjector {
public:
    void on_update(OrderBook const& book) {                 // writer thread only
        Snapshot s{};
        s.bid_count = static_cast<std::uint8_t>(book.top_bids(s.bids));  // top-N
        s.ask_count = static_cast<std::uint8_t>(book.top_asks(s.asks));
        pub_.publish(s);      // publish AFTER every field is final
    }
private:
    Publisher pub_;
};
```

| Snapshot design rule | Why |
|---|---|
| Copy the *read model*, not the writer structure | top-N levels beat the whole ladder |
| Fixed arrays + compact IDs | no allocation, no indirection, one cache footprint |
| Sequence/version stored in the value | consumers can attribute contents exactly |
| No owning strings, no pointers into writer state | self-contained lifetime |
| Cold diagnostics in a side struct | keeps hot snapshot small |
| `is_trivially_copyable` | enables `memcpy`, pooling, `atomic<T>` |

| Publication step | Ordering | Failure if omitted |
|---|---|---|
| Fill fields | plain stores | — |
| Publish identity | `memory_order_release` | reader sees identity but stale/torn fields |
| Load identity | `memory_order_acquire` | reader may reorder field reads before load |
| Reclaim old | after proven reader-free | use-after-free |

**Interview line** — "Publication is release-store the identity of a fully constructed immutable value; the reader acquire-loads it and holds a lifetime right until it stops reading."

**Traps** — `relaxed` publish makes fields visible in any order · setting `sequence` after the release store · a `std::string` member turning every publish into an allocation · reusing the *object* the reader still holds a raw pointer to · assuming one writer removes the reader lifetime problem.

---

## 40.2 Double/triple buffering

```cpp
#include <atomic>
#include <array>
#include <cstdint>

// ============ WRONG: the classic reuse race ==================================
class BrokenDoubleBuffer {
public:
    void publish(Snapshot const& s) {
        std::uint32_t const back = 1U - active_.load(std::memory_order_relaxed);
        buf_[back] = s;                                    // overwrite "inactive"
        active_.store(back, std::memory_order_release);
    }
    Snapshot const& read() const {
        return buf_[active_.load(std::memory_order_acquire)];  // DANGLING CONTENT
    }
private:
    std::array<Snapshot, 2>    buf_{};
    std::atomic<std::uint32_t> active_{0};
};
// R loads index 0 → R descheduled → W publishes 1 → W overwrites 0 → R reads 0.
// An atomic index tells the writer NOTHING about readers still inside a buffer.
```

```cpp
// ============ RIGHT: N slots + per-slot reader pins, full implementation =====
template<class T, std::uint32_t N = 4>
class PinnedBufferPublisher {
    static_assert(N >= 3, "need spare slots so publish rarely blocks");

    struct alignas(64) Slot {
        std::atomic<std::uint32_t> readers{0};   // pin count
        std::atomic<std::uint32_t> generation{0};// bumped on each fill
        T                          value{};
        char pad[64]{};
    };

public:
    // ---- writer ------------------------------------------------------------
    // Returns false if no slot is free (all pinned) — caller decides policy.
    bool publish(T const& v) noexcept {
        for (std::uint32_t i = 0; i < N; ++i) {
            std::uint32_t const s = (write_hint_ + i) % N;
            if (s == published_.load(std::memory_order_relaxed)) continue;
            // Claim only a slot with zero readers. Nobody can pin an
            // unpublished slot, so once it reads 0 it stays 0 for us.
            if (slot_[s].readers.load(std::memory_order_acquire) != 0) continue;

            slot_[s].value = v;                                  // plain stores
            slot_[s].generation.store(++gen_, std::memory_order_relaxed);
            published_.store(s, std::memory_order_release);      // PUBLISH
            write_hint_ = (s + 1) % N;
            return true;
        }
        return false;                                            // all pinned
    }

    // ---- reader: pin / validate / read / unpin -----------------------------
    class Guard {
    public:
        Guard() noexcept = default;
        Guard(Guard const&)            = delete;                 // one pin only
        Guard& operator=(Guard const&) = delete;
        Guard(Guard&& o) noexcept : owner_(o.owner_), slot_(o.slot_) {
            o.owner_ = nullptr;
        }
        Guard& operator=(Guard&& o) noexcept {
            if (this != &o) { release(); owner_ = o.owner_; slot_ = o.slot_;
                              o.owner_ = nullptr; }
            return *this;
        }
        ~Guard() { release(); }

        [[nodiscard]] bool     valid() const noexcept { return owner_ != nullptr; }
        [[nodiscard]] T const& get()   const noexcept { return owner_->slot_[slot_].value; }

    private:
        friend class PinnedBufferPublisher;
        Guard(PinnedBufferPublisher* o, std::uint32_t s) noexcept
            : owner_(o), slot_(s) {}
        void release() noexcept {
            if (owner_) {
                owner_->slot_[slot_].readers.fetch_sub(1, std::memory_order_release);
                owner_ = nullptr;
            }
        }
        PinnedBufferPublisher* owner_{nullptr};
        std::uint32_t          slot_{0};
    };

    [[nodiscard]] Guard read() noexcept {
        for (;;) {
            std::uint32_t const s = published_.load(std::memory_order_acquire);
            slot_[s].readers.fetch_add(1, std::memory_order_acq_rel);   // announce
            // RE-VALIDATE: the writer may have republished between the two lines.
            if (published_.load(std::memory_order_acquire) == s)
                return Guard{this, s};                                  // pinned
            slot_[s].readers.fetch_sub(1, std::memory_order_release);   // retry
        }
    }

private:
    std::array<Slot, N>        slot_{};
    std::atomic<std::uint32_t> published_{0};
    std::uint32_t              write_hint_{1};   // writer-only
    std::uint32_t              gen_{0};          // writer-only
};
```

```cpp
// ---- usage ------------------------------------------------------------------
PinnedBufferPublisher<Snapshot, 4> pub;
if (!pub.publish(snap)) { ++dropped_publishes; }     // backpressure decision
{
    auto g = pub.read();
    consume(g.get());                                 // valid only inside scope
}                                                     // unpin here
// auto const& bad = pub.read().get();                // DANGLING after the ;
```

```text
Why the re-validation is mandatory
  R: load published == 0
  W: publish 1;  W: sees slot0.readers == 0;  W: starts overwriting slot 0
  R: pin slot 0  ← too late, writer already inside
  R: reload published == 1 != 0 → unpin, retry.  Safe.
The writer only claims a slot that is (a) not published and (b) unpinned; a
pin acquired on an unpublished slot is always discarded by the re-check.
```

| Scheme | Slots | Publish blocks? | Slow reader effect | Proof obligation |
|---|---|---|---|---|
| Single buffer + mutex | 1 | yes | writer waits | trivial |
| Double buffer, index only | 2 | never | **torn reads (UB)** | impossible |
| Triple buffer, index only | 3 | never | torn reads, just rarer | impossible |
| N slots + reader pins | ≥3 | when all pinned | publish fails/spins | pin ⇒ no reuse |
| Immutable + `shared_ptr` | ∞ | never | memory growth | refcount |

**Interview line** — "Triple buffering adds slack, not a lifetime proof: a reader stalled across arbitrarily many publications still needs a pin protocol."

**Traps** — a `generation` field detects reuse *after* the racy read already happened, which is still UB · `readers` counters sharing a cache line with the payload · unpinning with `relaxed` (writer may see 0 before the reader's last payload read retires) · forgetting the re-validate reload · `publish` returning `void` and silently overwriting a pinned slot.

---

## 40.3 Version counters and seqlock-style reads

```cpp
// ============ WRONG: the textbook seqlock, illegal in portable C++ ===========
struct BrokenSeqSnapshot {
    std::atomic<std::uint64_t> version{0};
    std::uint64_t bid{};    // written by writer, read by reader, non-atomic
    std::uint64_t ask{};    //   → DATA RACE → UB, whatever the version says
};
// "I throw the value away if the version changed" does not undo undefined
// behaviour: the race is in the ACCESS, not in the value you keep.
```

```cpp
// ============ RIGHT: portable atomic-payload seqlock, complete ==============
#include <atomic>
#include <cstdint>
#include <cstring>
#include <type_traits>

template<class T>
class SeqLock {
    static_assert(std::is_trivially_copyable_v<T>);
    static constexpr std::size_t kWords =
        (sizeof(T) + sizeof(std::uint64_t) - 1) / sizeof(std::uint64_t);

public:
    // ---- writer: single writer only (or externally serialized) -------------
    void store(T const& value) noexcept {
        std::uint64_t const s = seq_.load(std::memory_order_relaxed);
        seq_.store(s + 1, std::memory_order_relaxed);      // ODD: write in progress
        std::atomic_thread_fence(std::memory_order_release); // no store hoists up

        std::uint64_t buf[kWords]{};
        std::memcpy(buf, &value, sizeof(T));
        for (std::size_t i = 0; i < kWords; ++i)
            word_[i].store(buf[i], std::memory_order_relaxed);  // race-free

        seq_.store(s + 2, std::memory_order_release);      // EVEN: complete
    }

    // ---- reader: lock-free, retries; NEVER blocks the writer ---------------
    [[nodiscard]] T load() const noexcept {
        std::uint64_t buf[kWords]{};
        for (;;) {
            std::uint64_t const before = seq_.load(std::memory_order_acquire);
            if (before & 1U) continue;                     // writer mid-update

            for (std::size_t i = 0; i < kWords; ++i)
                buf[i] = word_[i].load(std::memory_order_relaxed);

            std::atomic_thread_fence(std::memory_order_acquire); // no load sinks
            if (seq_.load(std::memory_order_relaxed) == before) break;
        }
        T out;
        std::memcpy(&out, buf, sizeof(T));
        return out;
    }

    // Non-blocking variant: one attempt, caller decides on failure.
    [[nodiscard]] bool try_load(T& out) const noexcept {
        std::uint64_t const before = seq_.load(std::memory_order_acquire);
        if (before & 1U) return false;
        std::uint64_t buf[kWords]{};
        for (std::size_t i = 0; i < kWords; ++i)
            buf[i] = word_[i].load(std::memory_order_relaxed);
        std::atomic_thread_fence(std::memory_order_acquire);
        if (seq_.load(std::memory_order_relaxed) != before) return false;
        std::memcpy(&out, buf, sizeof(T));
        return true;
    }

    [[nodiscard]] std::uint64_t version() const noexcept {
        return seq_.load(std::memory_order_acquire) >> 1;   // publications so far
    }

private:
    alignas(64) mutable std::atomic<std::uint64_t> seq_{0};
    alignas(64) mutable std::atomic<std::uint64_t> word_[kWords]{};
};
```

```cpp
// ---- usage ------------------------------------------------------------------
struct Top { std::int64_t bid; std::int64_t ask; std::uint64_t seq; };
SeqLock<Top> quote;

// writer thread
quote.store(Top{bid_ticks, ask_ticks, ++publish_count});

// reader thread
Top t = quote.load();          // always a coherent Top, possibly stale
Top t2;
if (quote.try_load(t2)) use(t2);      // bounded-latency read path
```

```text
Writer                     seq   Reader
                            0    load before = 0  (even → proceed)
seq = 1 (odd)               1
  release fence
  store words                    reads words  ← may be torn
seq = 2 (release)           2    acquire fence; reload seq = 2 != 0 → RETRY
                            2    load before = 2; words; reload 2 → ACCEPT
```

| Element | Order | Why exactly this |
|---|---|---|
| writer `seq → odd` | `relaxed` | fence below does the ordering |
| writer fence after odd | `release` | prevents payload stores hoisting above the odd marker |
| writer payload stores | `relaxed` | atomic ⇒ race-free; ordering supplied by the fences |
| writer `seq → even` | `release` | payload stores happen-before any acquiring reader |
| reader first `seq` load | `acquire` | pairs with the writer's even store |
| reader payload loads | `relaxed` | ordering supplied by the fence below |
| reader fence before recheck | `acquire` | prevents payload loads sinking past the validation |
| reader second `seq` load | `relaxed` | already fenced |

| Property | Seqlock |
|---|---|
| Reader cost | 2 seq loads + payload copy, **no RMW, no cache-line write** |
| Writer cost | 2 seq stores + payload stores; never blocks, never waits |
| Reader progress | *not* wait-free — starves under a continuously publishing writer |
| Writer progress | wait-free with respect to readers |
| Best size | small `T` (one or two cache lines); cost is O(sizeof T) per retry |
| Reclamation | none needed — storage is never freed or reused out from under a reader |

**Interview line** — "A seqlock is the right answer when reads must never write a cache line and staleness is acceptable, but the payload must be atomic objects: version validation cannot legalize a data race."

**Traps** — plain (non-atomic) payload is UB even with a perfect retry loop · returning a reference into `word_` instead of a copy · multiple writers without an outer mutex (odd/even interleave breaks) · unbounded retry with no `try_load` escape on a latency-critical path · a 4 KB `T` making every retry a full re-copy · `seq` wrap only matters at 2^63 publications, but a 32-bit `seq` in a test can wrap deliberately.

---

## 40.4 Atomic pointer publication

```cpp
#include <atomic>

// ---- Visibility: trivial. Lifetime: the entire problem. ---------------------
std::atomic<Snapshot const*> current{nullptr};

// writer — candidate is fully initialized and live
current.store(candidate, std::memory_order_release);

// reader
if (auto const* p = current.load(std::memory_order_acquire)) consume(*p);
// delete old;   // ← use-after-free unless a reclamation protocol proves safety
```

```text
reader loads old pointer
reader descheduled
writer publishes new pointer AND deletes/reuses old
reader resumes, dereferences old  →  use-after-free
```

```cpp
// ============ Complete atomic-shared_ptr publisher (the safe baseline) =======
#include <memory>

template<class T>
class SharedPublisher {
public:
    void publish(T value) {
        auto p = std::make_shared<T const>(std::move(value));
        current_.store(std::move(p), std::memory_order_release);
    }

    // Exchange returns the previous owner → controlled destruction site.
    std::shared_ptr<T const> publish_and_take_old(T value) {
        auto p = std::make_shared<T const>(std::move(value));
        return current_.exchange(std::move(p), std::memory_order_acq_rel);
    }

    [[nodiscard]] std::shared_ptr<T const> read() const noexcept {
        return current_.load(std::memory_order_acquire);
    }

    // Conditional publish: only replace `expected` (single-writer not required).
    bool compare_publish(std::shared_ptr<T const>& expected,
                         std::shared_ptr<T const> desired) noexcept {
        return current_.compare_exchange_strong(
            expected, std::move(desired),
            std::memory_order_acq_rel, std::memory_order_acquire);
    }

    [[nodiscard]] static bool lock_free() noexcept {
        return std::atomic<std::shared_ptr<T const>>::is_always_lock_free;
    }

private:
    std::atomic<std::shared_ptr<T const>> current_{};   // C++20
};
```

```cpp
// ---- Pre-C++20 / libstdc++-portability fallback (deprecated in C++26) -------
std::shared_ptr<T const> cur;
auto p = std::atomic_load_explicit(&cur, std::memory_order_acquire);
std::atomic_store_explicit(&cur, np, std::memory_order_release);
#if defined(__cpp_lib_atomic_shared_ptr)   // >= 201711L → prefer the class
#endif
```

```cpp
// ============ Whole-value atomic<T> publication (no pointer at all) ==========
struct Top2 { std::int64_t bid{}; std::int64_t ask{}; };
static_assert(std::is_trivially_copyable_v<Top2>);
static_assert(std::atomic<Top2>::is_always_lock_free,      // 16 bytes: needs
              "build with -mcx16 / lock-free 16-byte CAS");// cmpxchg16b

std::atomic<Top2> top;
top.store(Top2{1, 2}, std::memory_order_release);          // coherent whole value
Top2 t = top.load(std::memory_order_acquire);
Top2 exp = t, des{t.bid + 1, t.ask};
while (!top.compare_exchange_weak(exp, des,
        std::memory_order_acq_rel, std::memory_order_acquire)) { des.ask = exp.ask; }

// C++20: padding bits are zeroed on atomic store/CAS for atomic<T>, so a padded
// struct no longer breaks compare_exchange — but keep T padding-free anyway.
```

```cpp
// ---- Tagged pointer: defeat ABA on a CAS-published pointer ------------------
struct Tagged {
    Snapshot const* ptr{nullptr};
    std::uint64_t   tag{0};                       // bumped on every publish
};
static_assert(sizeof(Tagged) == 16);
std::atomic<Tagged> slot;                          // needs 16-byte lock-free CAS
```

| Publication mechanism | Owns pointee | Read cost | Publish cost | Lock-free |
|---|---|---|---|---|
| `atomic<T*>` | **no** | 1 load | 1 store | yes |
| `atomic<shared_ptr<T>>` | yes | refcount RMW (+ possible spinlock) | alloc + exchange | usually **no** |
| `atomic<T>` small POD | n/a | 1 load | 1 store | if ≤ 8/16 B |
| `atomic<T>` large POD | n/a | library lock | library lock | no |
| tagged `atomic<Tagged>` | no | 16-B load | 16-B CAS | with `cmpxchg16b` |

| Order on publish | Legal? | Effect |
|---|---|---|
| `release` store | yes | standard publication |
| `relaxed` store | yes | **fields not guaranteed visible** — bug |
| `seq_cst` store | yes | adds a total order; costs a full barrier |
| `acq_rel` exchange | yes | publish + acquire the old value |
| `consume` load | avoid | unimplemented; every compiler promotes it to `acquire` |

**Interview line** — "An atomic pointer answers *which object*, never *is it still alive*; publication and reclamation are separate proofs."

**Traps** — `is_lock_free()` is platform evidence, not a portable guarantee · a `shared_ptr` reader doing the final decrement pays the destruction latency spike inside the read path · `make_shared` is one allocation *in practice*, not by mandate, and keeps the control block alive as long as any `weak_ptr` exists · `atomic<shared_ptr>` operations reject exotic memory orders · deleting the old pointer right after the release store is the single most common use-after-free in this chapter.

---

## 40.5 Ownership and reclamation of retired snapshots

```cpp
// ============ Strategy 1: retain until shutdown (arena) ======================
// Bounded number of publications, or bounded memory budget. Zero read cost.
class ArenaPublisher {
public:
    void publish(Snapshot const& s) {
        auto& slot = arena_.emplace_back(s);                    // never freed
        current_.store(&slot, std::memory_order_release);
    }
    Snapshot const* read() const noexcept {
        return current_.load(std::memory_order_acquire);        // raw, always live
    }
private:
    std::deque<Snapshot>          arena_;    // deque: references stay valid
    std::atomic<Snapshot const*>  current_{nullptr};
};
```

```cpp
// ============ Strategy 2: hazard pointers, complete minimal implementation ===
#include <algorithm>
#include <atomic>
#include <vector>

template<class T, std::size_t kMaxThreads = 64, std::size_t kRetireBatch = 32>
class HazardDomain {
public:
    struct alignas(64) Record {
        std::atomic<T*>    hazard{nullptr};
        std::atomic<bool>  active{false};
        char pad[64 - sizeof(std::atomic<T*>) - sizeof(std::atomic<bool>)]{};
    };

    // ---- reader side -------------------------------------------------------
    class Holder {
    public:
        explicit Holder(HazardDomain& d) : dom_(d), rec_(d.acquire_record()) {}
        Holder(Holder const&) = delete;
        ~Holder() { rec_->hazard.store(nullptr, std::memory_order_release);
                    rec_->active.store(false, std::memory_order_release); }

        // Protect: load, announce, RE-VALIDATE. The reload closes the window
        // between the first load and the hazard becoming visible.
        [[nodiscard]] T* protect(std::atomic<T*> const& src) noexcept {
            T* p = src.load(std::memory_order_acquire);
            for (;;) {
                rec_->hazard.store(p, std::memory_order_seq_cst);  // announce
                T* q = src.load(std::memory_order_acquire);        // validate
                if (q == p) return p;
                p = q;
            }
        }
        void clear() noexcept { rec_->hazard.store(nullptr, std::memory_order_release); }
    private:
        HazardDomain& dom_;
        Record*       rec_;
    };

    // ---- writer side -------------------------------------------------------
    void retire(T* p) {
        retired_.push_back(p);
        if (retired_.size() >= kRetireBatch) scan();
    }

    void scan() {
        std::vector<T*> protected_now;
        protected_now.reserve(kMaxThreads);
        for (auto& r : record_)
            if (T* h = r.hazard.load(std::memory_order_acquire)) protected_now.push_back(h);
        std::sort(protected_now.begin(), protected_now.end());

        std::vector<T*> keep;
        for (T* p : retired_) {
            if (std::binary_search(protected_now.begin(), protected_now.end(), p))
                keep.push_back(p);                 // still protected → retry later
            else
                delete p;                          // provably unreachable
        }
        retired_.swap(keep);
    }

    ~HazardDomain() { scan(); for (T* p : retired_) delete p; }

private:
    Record* acquire_record() {
        for (auto& r : record_) {
            bool expected = false;
            if (r.active.compare_exchange_strong(expected, true,
                    std::memory_order_acq_rel))
                return &r;
        }
        throw std::runtime_error("hazard record exhausted");
    }
    std::array<Record, kMaxThreads> record_{};
    std::vector<T*>                 retired_{};   // writer-local
};
```

```cpp
// ---- hazard usage -----------------------------------------------------------
HazardDomain<Snapshot const> dom;
std::atomic<Snapshot const*>  current{nullptr};

// reader
{
    HazardDomain<Snapshot const>::Holder h{dom};
    if (auto const* p = h.protect(current)) consume(*p);   // safe to deref
}                                                          // hazard cleared

// writer
auto* fresh = new Snapshot{build()};
auto* old   = current.exchange(fresh, std::memory_order_acq_rel);
if (old) dom.retire(old);            // freed only when absent from all hazards
```

```cpp
// ============ Strategy 3: epoch / QSBR, complete minimal implementation =====
class EpochDomain {
    static constexpr std::uint64_t kInactive = ~std::uint64_t{0};
public:
    struct alignas(64) Reader { std::atomic<std::uint64_t> local{kInactive}; };

    class Guard {                                     // read-side critical section
    public:
        Guard(EpochDomain& d, Reader& r) noexcept : r_(r) {
            r_.local.store(d.global_.load(std::memory_order_acquire),
                           std::memory_order_seq_cst);   // seq_cst: pin BEFORE read
        }
        Guard(Guard const&) = delete;
        ~Guard() { r_.local.store(kInactive, std::memory_order_release); }
    private:
        Reader& r_;
    };

    void retire(Snapshot const* p) {
        bucket_[global_.load(std::memory_order_relaxed) % 3].push_back(p);
    }

    // Called periodically by the writer: advance only when every active
    // reader has already observed the current epoch.
    void try_advance() {
        std::uint64_t const e = global_.load(std::memory_order_relaxed);
        for (auto& r : reader_) {
            std::uint64_t const l = r.local.load(std::memory_order_acquire);
            if (l != kInactive && l != e) return;     // a reader lags → cannot free
        }
        global_.store(e + 1, std::memory_order_release);
        auto& stale = bucket_[(e + 1) % 3];           // two epochs behind
        for (auto const* p : stale) delete p;
        stale.clear();
    }

    std::array<Reader, 64>                    reader_{};
private:
    std::atomic<std::uint64_t>                global_{0};
    std::array<std::vector<Snapshot const*>, 3> bucket_{};
};
```

| Technique | Reader cost | Writer/reclaimer cost | Main constraint |
|---|---|---|---|
| Retain until shutdown | 1 pointer load | unbounded memory | bounded snapshot count/size |
| `shared_ptr` | refcount RMW ×2 | alloc + destroy at last release | simplest correct ownership |
| Per-slot reader count | `fetch_add`/`fetch_sub` | find unpinned slot | a stalled reader pins a slot |
| Epoch / QSBR | store local epoch | scan readers, retire lists | every reader must report progress |
| Hazard pointers | store + validating reload | scan all hazard records | fixed protected-pointer budget |
| Mutex / `shared_mutex` | lock/unlock | contention, wakeups | readers interfere with the writer |
| **C++26** `std::hazard_pointer` / `std::rcu_domain` | library-managed | library-managed | not available before C++26 |

```cpp
// ---- C++26 preview (P2530 hazard pointers, P2545 RCU) ----------------------
// std::hazard_pointer h = std::make_hazard_pointer();
// Snapshot const* p = h.protect(current);          // load + announce + validate
// std::hazard_pointer_obj_base<Snapshot>::retire(); // deferred delete
// std::rcu_synchronize(); std::rcu_retire(p);       // RCU domain API
```

**Interview line** — "Pick reclamation from the reader's guarantee: refcount if readers may retain, hazards if readers hold one pointer briefly, epochs if every reader reports quiescence, retain-forever if the snapshot count is bounded."

**Traps** — hazard `protect` without the validating reload is a race, not an optimization · the hazard announce must be `seq_cst` (or fenced) so it cannot sink below the validation load · epoch schemes with an unregistered or dead thread block reclamation forever · unbounded retire lists are a memory leak with extra steps · unregistering a thread before it has left its read-side critical section · `shared_ptr` retention by a reader that stores the handle indefinitely defers *all* destruction.

---

## 40.6 Consistency across multiple fields

```cpp
// ============ WRONG: atomics without a transaction ==========================
std::atomic<std::int64_t>  bid;
std::atomic<std::int64_t>  ask;
std::atomic<std::uint64_t> sequence;

auto b = bid.load(std::memory_order_seq_cst);        // each load individually
auto a = ask.load(std::memory_order_seq_cst);        //   race-free …
auto s = sequence.load(std::memory_order_seq_cst);   //   … and mutually incoherent
// A reader can observe a NEW bid, an OLD ask, and either sequence: seq_cst gives
// a global ORDER over atomic operations, not an implicit multi-load transaction.
```

```text
time →      W: bid=101      W: ask=102      W: seq=7
R:              load bid=101 ────────────────────── load ask=(old 99)
observed pair (101, 99) never existed as a state.
```

```cpp
// ============ FIX 1: one immutable identity (see 40.1) ======================
auto snap = pub.read();            // shared_ptr<Snapshot const> — coherent by
use(snap->bids, snap->asks, snap->sequence);   //   construction

// ============ FIX 2: one atomic aggregate ===================================
struct Quote { std::int64_t bid; std::int64_t ask; };
static_assert(std::atomic<Quote>::is_always_lock_free);
std::atomic<Quote> q;
Quote whole = q.load(std::memory_order_acquire);   // ONE coherent pair

// ============ FIX 3: seqlock over atomic fields (see 40.3) ==================
SeqLock<Top> sl;  Top t = sl.load();

// ============ FIX 4: lock the whole transaction =============================
#include <shared_mutex>
std::shared_mutex m;
{
    std::shared_lock lk{m};                        // multiple readers
    use(bid_, ask_, seq_);                         // plain members, no race
}
{
    std::unique_lock lk{m};                        // exclusive writer
    bid_ = b; ask_ = a; seq_ = s;
}

// ============ FIX 5: document field-wise freshness ==========================
// "get_bid()/get_ask() are each individually fresh; they are NOT a snapshot."
```

```cpp
// ---- Bit-packing two fields into one atomic word ---------------------------
// When both fields fit in 64 bits, one atomic gives coherence for free.
std::atomic<std::uint64_t> packed;                   // hi 32 = bid, lo 32 = ask
auto const w = packed.load(std::memory_order_acquire);
std::int32_t const b32 = static_cast<std::int32_t>(w >> 32);
std::int32_t const a32 = static_cast<std::int32_t>(w & 0xFFFF'FFFFU);
packed.store((std::uint64_t(std::uint32_t(nb)) << 32) | std::uint32_t(na),
             std::memory_order_release);
```

| Coherence mechanism | Fields | Reader writes memory? | Blocking |
|---|---|---|---|
| Immutable object + owning handle | unlimited | yes (refcount) | no |
| Immutable object + pin/epoch | unlimited | yes (pin) or no (QSBR) | no |
| `atomic<T>` aggregate | ≤ 16 B lock-free | no | no |
| Bit-packed single word | ≤ 8 B total | no | no |
| Seqlock | any trivially copyable | **no** | reader may retry |
| `shared_mutex` | unlimited | yes (lock word) | yes |
| Independent atomics | — | no | no (and **no coherence**) |

**Interview line** — "`memory_order_seq_cst` gives a single total order of atomic *operations*; it never makes two separate loads atomic together."

**Traps** — putting the version outside the snapshot only, so a consumer cannot attribute contents · reading `sequence` before the payload and assuming it describes it · `shared_lock` still writes the mutex's cache line on every read · bit-packing that silently overflows when a field grows.

---

## 40.7 Freshness versus reader interference

```cpp
// ---- Contract 1: latest observed (may skip versions, never blocks) ---------
[[nodiscard]] std::shared_ptr<Snapshot const> latest() const noexcept {
    return current_.load(std::memory_order_acquire);
}

// ---- Contract 2: at least version V (waits / retries / fails) --------------
[[nodiscard]] std::shared_ptr<Snapshot const>
at_least(std::uint64_t v, std::chrono::steady_clock::duration timeout) const {
    auto const deadline = std::chrono::steady_clock::now() + timeout;
    for (;;) {
        auto p = current_.load(std::memory_order_acquire);
        if (p && p->sequence >= v) return p;
        if (std::chrono::steady_clock::now() >= deadline) return nullptr;
        std::this_thread::yield();                        // or futex/condvar wait
    }
}

// ---- Contract 3: every version → this is a QUEUE, not publication ----------
// ring_buffer<Snapshot, 1024> with explicit capacity + drop/block policy.

// ---- Contract 4: point-in-time pin (scoped guard) --------------------------
class SnapshotGuard {
public:
    SnapshotGuard(SnapshotGuard const&)            = delete;   // one pin
    SnapshotGuard& operator=(SnapshotGuard const&) = delete;
    SnapshotGuard(SnapshotGuard&&) noexcept;
    SnapshotGuard& operator=(SnapshotGuard&&) noexcept;
    ~SnapshotGuard();                                          // unpin
    [[nodiscard]] Snapshot const& get() const noexcept;
    [[nodiscard]] explicit operator bool() const noexcept;
};

// auto const& s = publisher.read().get();   // DANGLING: guard dies at the ';'
auto guard = publisher.read();               // guard outlives the use
consume(guard.get());

// ---- Contract 5: ephemeral callback (narrowest intended lifetime) ----------
template<class F>
decltype(auto) with_snapshot(F&& f) const {
    auto guard = read();
    return std::invoke(std::forward<F>(f), guard.get());   // ref must not escape
}
// Cannot PREVENT the callback storing a reference; a concept can discourage it:
template<class F>
concept SnapshotConsumer =
    std::invocable<F, Snapshot const&> &&
    !std::is_reference_v<std::invoke_result_t<F, Snapshot const&>>;
```

| Contract | Returns | May skip versions | Reader may block | Retention risk |
|---|---|---|---|---|
| Latest observed | some fully published version | yes | no | none |
| At least version V | ≥ V, or timeout | yes (intermediate) | yes | none |
| Every version | queue element | **no** | yes (backpressure) | queue growth |
| Point-in-time pin | owning handle | yes | no | holds a slot/object |
| Ephemeral callback | callback result | yes | no | escape is a bug |

```text
reader interference spectrum (not a universal performance ranking)
lowest interference ──────────────────────────────► strongest retention
seqlock (no reader writes)
  → raw pointer + QSBR (no per-read write)
    → epochs/hazards (one store per read)
      → shared_ptr (two RMWs per read)
        → shared_mutex (contended cache line)
          → mutex (serialized)
```

| Publication policy | Staleness | Writer cost | Skips |
|---|---|---|---|
| Every event | minimum | highest | none |
| Per input batch | one batch | amortized | intra-batch |
| Fixed cadence (e.g. 100 µs) | bounded by cadence | predictable | many |
| On selected-field change | event-driven | conditional | unchanged states |
| Reader-requested (pull via queue) | request latency | none until asked | all |

**Interview line** — "Latest-value publication and a queue answer different questions: one gives you the current state, the other gives you every state; choosing publication means accepting skipped versions."

**Traps** — binding a reference to a temporary guard · `at_least` spinning with no timeout on a shared core · a "read" API that never states whether skips are allowed · coalescing that silently changes the semantics tests rely on · a callback that returns `Snapshot const&`.

---

## 40.8 Testing torn-read and stale-read scenarios

```cpp
// ---- Self-describing snapshot: every field derivable from `version` --------
#include <array>
#include <cstdint>
#include <numeric>

struct TestSnapshot {
    std::uint64_t                 version{};
    std::array<std::uint64_t, 32> words{};
    std::uint64_t                 checksum{};

    static TestSnapshot make(std::uint64_t v) noexcept {
        TestSnapshot s{};
        s.version = v;
        for (std::size_t i = 0; i < s.words.size(); ++i)
            s.words[i] = v * 0x9E37'79B9'7F4A'7C15ULL + i;   // version-derived
        s.checksum = std::accumulate(s.words.begin(), s.words.end(),
                                     v, std::bit_xor<std::uint64_t>{});
        return s;
    }
    [[nodiscard]] bool consistent() const noexcept {
        auto const expect = make(version);
        return words == expect.words && checksum == expect.checksum;
    }
};
```

```cpp
// ---- Torn/stale test harness ------------------------------------------------
#include <barrier>
#include <thread>
#include <latch>

void stress_publication(Publisher& pub, int readers, int publishes) {
    std::atomic<bool>          stop{false};
    std::atomic<std::uint64_t> accepted{0}, torn{0}, regressions{0};
    std::latch                 go{1};

    std::vector<std::jthread> rs;
    for (int i = 0; i < readers; ++i)
        rs.emplace_back([&] {
            go.wait();
            std::uint64_t last = 0;
            while (!stop.load(std::memory_order_relaxed)) {
                auto s = pub.read();
                if (!s) continue;
                if (!s->consistent()) { torn.fetch_add(1); continue; }   // MUST be 0
                if (s->version < last) regressions.fetch_add(1);         // monotone?
                last = s->version;
                accepted.fetch_add(1, std::memory_order_relaxed);
            }
        });

    std::jthread w{[&] {
        go.count_down();
        for (int v = 1; v <= publishes; ++v) pub.publish(TestSnapshot::make(v));
        stop.store(true, std::memory_order_relaxed);
    }};

    rs.clear();                                    // join
    assert(torn.load() == 0);                      // torn read = the bug
    assert(regressions.load() == 0);               // if monotonicity is promised
}
```

```cpp
// ---- Deterministic hooks at protocol boundaries (compile-time, zero cost) ---
struct NoHooks {
    static void after_reader_loads_identity() noexcept {}
    static void after_reader_announces()      noexcept {}
    static void before_writer_publishes()     noexcept {}
    static void after_writer_retires()        noexcept {}
    static void before_writer_reuses_slot()   noexcept {}
};

template<class Hooks = NoHooks>
class TestablePublisher {
public:
    void publish(TestSnapshot s) {
        Hooks::before_writer_publishes();                      // test barrier here
        current_.store(std::make_shared<TestSnapshot const>(s),
                       std::memory_order_release);
    }
    auto read() const {
        auto p = current_.load(std::memory_order_acquire);
        Hooks::after_reader_loads_identity();                  // stall the reader
        return p;
    }
private:
    std::atomic<std::shared_ptr<TestSnapshot const>> current_{};
};

// Test hook: force the exact reuse interleaving instead of hoping for it.
struct PauseAfterLoad {
    static inline std::barrier<> gate{2};
    static void after_reader_loads_identity() { gate.arrive_and_wait(); }
    static void before_writer_publishes()     {}
    static void after_reader_announces()      noexcept {}
    static void after_writer_retires()        noexcept {}
    static void before_writer_reuses_slot()   { gate.arrive_and_wait(); }
};
```

| Test schedule | Targets |
|---|---|
| Pause reader immediately after loading the identity | reuse race, hazard-validation window |
| Publish ≥ N times while one reader is paused | slot exhaustion, generation wrap |
| Hold one guard across thousands of publications | retention, retire-list growth |
| Start/stop reader threads during a reclaim scan | registration races, dead-reader stalls |
| Wrap a deliberately narrow 16/32-bit generation | ABA / tag reuse |
| Publish at max rate while readers copy slowly | seqlock reader starvation |
| Verify staleness bound separately from consistency | staleness is allowed, tearing is not |
| Kill the writer mid-update (odd sequence) | seqlock reader must not hang forever |

```bash
# Sanitizers and stress
g++ -std=c++23 -O1 -g -fsanitize=thread    pub_test.cpp -o pub_tsan && ./pub_tsan
g++ -std=c++23 -O1 -g -fsanitize=address,undefined pub_test.cpp -o pub_asan && ./pub_asan
g++ -std=c++23 -O2 -g pub_test.cpp -o pub && for i in $(seq 200); do ./pub || break; done
taskset -c 2,3 ./pub          # pin writer/reader to sibling vs distant cores
TSAN_OPTIONS="history_size=7 second_deadlock_stack=1" ./pub_tsan
```

**Model assertions**

| Assertion | Holds for |
|---|---|
| Every accepted snapshot's checksum validates | all designs (a failure is tearing) |
| Versions seen by one reader are nondecreasing | designs promising monotonicity |
| No reclaimed object is reachable from a live guard | ASan/TSan under reclamation |
| Slot reuse never occurs while pinned | pinned-buffer publisher |
| Skipped versions occur only where the contract allows | latest-value publication |
| Shutdown leaves no registered reader, no retire record | epoch/hazard domains |

**Traps** — production `sleep()` sprinkled in to "hit the race" instead of a `std::barrier` · TSan proving nothing about lock-freedom, ABA, or staleness bounds · a checksum weak enough to pass on a mixed-version copy · testing only on one core layout · asserting monotonic versions for a design that never promised them · a passing single-threaded test on a `SeqLock` whose writer path was never contended.

---

## Recall card

```text
snapshot        complete immutable read model, version inside the value
publication     build privately → release identity → acquire identity → hold
three problems  visibility + consistency + lifetime/reclamation
atomic pointer  publishes an address; owns nothing
shared_ptr      simplest correct ownership; refcount + alloc + destroy cost
double buffer   safe only with a proof the retired slot has no readers
generation      detects change; cannot legalize a data race
seqlock         atomic payload + odd/even seq + release/acquire fences
atomic fields   race-free individually; need a protocol for cross-field coherence
reclamation     retain | refcount | pins | epochs | hazards | locks
freshness       latest observed ≠ every version
testing         version-derived payload + checksum, pause at protocol edges
shutdown        stop publish → block acquire → drain guards → reclaim → destroy
```

**Interview line** — "Safe read-mostly publication means a reader acquires one fully constructed immutable version and holds a lifetime right to it until it finishes; an atomic version, pointer, or buffer index alone supplies neither multi-field coherence nor reclamation."
