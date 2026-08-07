# Chapter 36 — Order Books and Pre-Trade Risk

An order book and its risk gate turn external messages into trading state under strict correctness and latency constraints. The fastest lookup is useless if two prices map to one level incorrectly, a cancel follows a recycled pointer, or a notional calculation overflows before comparison. This chapter designs bounded, venue-neutral structures whose work, storage, ownership, and failure policy can be stated before measurement.

## 36.1 Price-to-Level Mapping

A **price-to-level mapping** converts a valid discrete price into an index or key that identifies one book level. If an instrument has a constant tick size, a dense mapping can use

```text
level = (price_ticks - base_ticks) / tick_spacing
```

The names matter. If prices are already stored in the instrument's minimum ticks, `tick_spacing` is the number of those ticks between adjacent valid prices. A value of one means every integer price is valid.

Validate before dividing. `tick_spacing` must be positive, subtraction must not overflow, the difference must be divisible by the spacing, and the resulting index must lie within capacity. Avoid converting a negative signed difference to `std::size_t`; it becomes a large unsigned value.

```cpp
#include <cstddef>
#include <cstdint>
#include <optional>

std::optional<std::size_t> level_index(
    std::int64_t price,
    std::int64_t base,
    std::int64_t spacing,
    std::size_t capacity) noexcept {
    if (spacing <= 0 || price < base)
        return std::nullopt;

    // Unsigned arithmetic represents the full nonnegative int64_t distance.
    const auto distance = static_cast<std::uint64_t>(price)
                        - static_cast<std::uint64_t>(base);
    const auto step = static_cast<std::uint64_t>(spacing);
    if (distance % step != 0)
        return std::nullopt;

    const auto index = distance / step;
    if (index >= capacity)
        return std::nullopt;
    return static_cast<std::size_t>(index);
}
```

Because `price >= base`, their mathematical distance lies in `[0, UINT64_MAX]`. Converting both values to `uint64_t` and subtracting modulo `2^64` produces that distance, including when `base` is negative. This reasoning depends on the exact 64-bit types used in the signature; changing them requires revisiting the proof. Numeric preconditions belong beside the representation, not in an optimistic comment.

Tick schedules can change by price band. Then division by one spacing is wrong at band boundaries. Precompute a compact table of bands containing start price, spacing, and cumulative level offset. A binary search has logarithmic comparison work; a small fixed linear scan can be faster and more predictable. The correct choice follows the maximum number of bands and their access distribution.

Mapping must be reversible. For every accepted price, `price_for(level_for(price))` should equal the original price. Property tests should exercise band boundaries, minimum and maximum prices, negative values if supported, and numeric limits.

## 36.2 Dense, Tree, Hash, and Flat Representations

The book representation determines lookup work, ordering support, footprint, and invalidation behavior.

| Representation | Lookup | Best-price traversal | Memory behavior | Worst-case concern |
|---|---|---|---|---|
| dense array | direct index | bitmap or bounded scan | contiguous, includes empty range | wide sparse price range |
| ordered tree | logarithmic comparisons | first/last node | node allocation and pointer chasing | allocator and cache misses |
| hash table | average constant lookup | separate best tracking | buckets, metadata, rehash risk | collision chains and rehash |
| sorted flat array | logarithmic search | endpoints | compact contiguous storage | insertion movement |

A dense book is attractive when the valid price window is bounded and reasonably compact. Each level can be an inline object, and an occupancy bitmap can skip blocks of empty levels. Direct mapping gives a strict lookup bound. A large empty range, however, consumes pages and cache capacity even when few levels are active.

Tree containers provide ordering and stable node addresses under many operations, but standard containers do not promise an allocation-free update. Pointer-rich nodes amplify cache and TLB misses. A preallocated intrusive tree can control storage while retaining comparison and rotation work.

A hash table needs a separate structure or cached value for the best bid and ask. Reserve capacity before trading if using a standard unordered container, but remember that C++ specifies average complexity rather than a collision bound. A fixed open-addressed table with controlled load factor can make probe limits explicit; exhausting that probe bound requires a defined recovery path.

Flat sorted storage works well for a small number of active price levels and read-heavy traversal. Inserting a new price can move later elements and invalidate handles. Storing stable level objects in a pool while sorting compact handles separates ordering from identity.

There is no universally best representation. Derive it from maximum price span, active-level distribution, update mix, best-price queries, and required worst-case work. Measure with realistic gaps; uniformly random prices rarely resemble a live book.

## 36.3 Stable Identity and Intrusive FIFO Queues

**Stable order identity** means an order remains addressable until its removal, regardless of changes to surrounding containers. Price-time priority commonly requires a FIFO queue at each price level.

An intrusive queue stores links inside each order node:

```cpp
struct order_node {
    std::uint64_t order_id{};
    std::int64_t quantity{};
    std::uint32_t instrument{};
    std::uint32_t level{};
    order_node* previous{};
    order_node* next{};
    std::uint32_t generation{};
};

struct price_level {
    order_node* first{};
    order_node* last{};
    std::int64_t total_quantity{};
};
```

Appending and unlinking are constant pointer operations once the node and level are known. There is no separate list-node allocation. The tradeoff is coupling: an order can participate in only one queue per link set, and link corruption damages the book.

Raw pointers are stable only while pool slots are not relocated and while lifetime is valid. Reusing a slot can turn an old pointer into a reference to a different order. A handle `{slot_index, generation}` detects stale reuse when the generation changes. The generation itself can wrap, so its width and maximum reuse count during any stale-handle lifetime need a bound.

Queue invariants include matching head and tail emptiness, null outer links, consistent neighbor links, node level ownership, and aggregate quantity equal to the sum of nodes. Full invariant scans are too expensive per update but belong in offline replay, fuzzing, and sampled debug diagnostics.

## 36.4 Cancel and Modify Lookup

A cancel begins with an external order identifier and must find the exact live node. A pre-sized direct-address table works when identifiers have a bounded dense domain. A fixed open-addressed hash index is more general.

The index maps order ID to a generation-checked pool handle, not merely a pointer. Insertion must fail cleanly on duplicate IDs or exhausted probes. Removal must preserve the hash table's probe semantics, often with tombstones or backward-shift deletion. Tombstones accumulate and lengthen probes; rebuilding is unbounded unless scheduled outside the hot path or implemented incrementally under a strict budget.

A same-price quantity reduction can update the node and level aggregate in place if venue rules preserve priority. A price change often behaves as cancel plus new insertion and loses time priority. Increasing quantity may also lose priority. These are domain policies supplied by the venue adapter; the generic book must not guess.

Perform validation before mutation. Check existence, instrument, allowed transition, quantity bounds, destination capacity, and arithmetic. Then commit changes in an order that preserves invariants or can be rolled back without allocation. A partial modify that unlinks the old node and then discovers a full destination corrupts externally observable state.

Unknown cancels and duplicate adds are not mere branches. They can indicate packet loss, replay, stale state, or protocol violation. Count them with source sequence context and transition to the recovery policy established in Chapter 35.

## 36.5 Pools, Capacity, and Cache Footprint

A **fixed object pool** preallocates storage for the maximum number of live and temporarily retained orders. Allocation removes one index from a free list; deallocation destroys the node, advances its generation, and returns the slot only when no stale internal reference remains.

Capacity must include more than steady live orders. Recovery overlap, deferred reclamation, messages in queues, and modify staging can temporarily increase demand. State the formula:

```text
pool capacity = maximum live orders
              + maximum in-flight additions
              + recovery overlap
              + operational reserve
```

Each term needs an enforcement source. If the venue or internal limit does not provide one, the claimed bound is an assumption requiring monitoring and a safe exhaustion action.

Footprint includes nodes, free-list metadata, generation values, ID index buckets, levels, occupancy bitmaps, alignment padding, and allocator bookkeeping. Multiplying `sizeof(order_node)` by capacity is only a lower-level component. Pages should be allocated, NUMA-placed, and touched before the session if page faults are forbidden on the update path.

Layout trades line touches against capacity. On a target with a measured 64-byte coherence line, a compact hot node prefix may place two nodes in one line, while a parallel cold-audit array keeps diagnostics out of normal updates. Treat that size as an illustrative target property, not a C++ guarantee. Calculate total bytes, pages, and lines touched by add, cancel, and fill; `sizeof` alone misses index and page costs. Test several load factors because shrinking a hash table saves pages while lengthening bounded probes.

Packing fields can improve density but misalignment or narrower overflow bounds can cost more than padding saves. Separate hot fields—links, quantity, level—from cold audit metadata when updates rarely read the latter. A structure-of-arrays layout can accelerate sweeps but complicates stable handles and multi-field mutation.

Pool exhaustion is a business-state transition. Rejecting a new internal order, entering recovery, or halting the strategy can be valid; falling back silently to the general heap destroys the stated latency and capacity model.

## 36.6 Bounding Update Work

A bounded update has a documented maximum number of probes, comparisons, pointer operations, and touched cache lines under admitted input. Big-O notation alone is insufficient. “Average constant time” does not bound an adversarial collision chain.

For a dense-level, fixed-pool book, adding an order can require:

1. validate price and quantity;
2. map price to one bounded level index;
3. probe the ID index up to `P` slots;
4. pop one pool slot;
5. append to one level queue;
6. update aggregate and best-price metadata.

Best-price maintenance needs care when removing the last order at the best level. Scanning one price at a time can traverse the entire configured window. A hierarchical occupancy bitmap bounds the search by a small number of machine-word operations. CPU-specific bit-scan instructions are common compiler output, but C++20 `std::countr_zero` expresses the portable operation.

Batch messages can create a second bound. Processing an exchange packet with `M` entries costs the sum of per-entry work; enforce a protocol maximum before entering the loop. Avoid callbacks, logging, or destruction that can allocate or block inside the update.

Verification should count maximum probes, levels scanned, pool occupancy, and work per message during historical replay and synthetic boundary cases. These counters are diagnostic state, not proof of future input, but they reveal whether implementation matches the designed bound.

Trace each operation explicitly. With probe limit eight, an add examines at most eight index entries, pops one pool slot, changes at most two queue links, updates one aggregate, and sets one occupancy bit. A cancel performs the bounded lookup, validates generation, changes at most two neighbors, clears one index entry, and returns one slot. Removing the last best-price order searches a fixed number of hierarchical bitmap words rather than an unbounded run of empty levels.

A modify reserves and validates destination capacity before unlinking the source. Same-price reduction follows a shorter in-place trace. Tests should label which trace executed, force the eighth probe, remove the last best level, and verify that every precommit failure leaves byte-for-byte equivalent logical state.

## 36.7 Position, Notional, and Limit Checks

A **pre-trade risk check** decides whether proposed state remains within configured limits before an order can leave the process. Common checks include maximum order quantity, price collars, gross and net position, open-order quantity, notional exposure, message rate, and kill state.

Checks should evaluate the prospective state, not update then attempt to undo:

```text
candidate_position = current_position + signed_order_quantity
candidate_notional = current_notional + price_ticks * quantity * value_scale
admit only if every candidate is representable and within its limit
```

Price, quantity, and notional scales must be explicit. Use wider intermediates than stored values, or perform checked multiplication and addition. Comparing after signed overflow is undefined behavior and may be optimized into incorrect code.

Limits form a hierarchy: order, instrument, strategy, account, and firm. Reading each from independently changing memory can create a combination that never existed. Either confine the complete decision state to one owner or consume a versioned immutable limit snapshot.

Risk work must also be ordered with send work. If two threads both read available capacity, approve, and then update, they can jointly exceed a limit. Reservation must be atomic as one logical operation, serialized through an owner, or partitioned into conservative per-thread budgets whose sum cannot exceed the global limit.

## 36.8 Overflow and State Ownership

Overflow analysis starts from external maxima, not from current observations. Suppose price ticks and quantity are 64-bit. Their product can require 128 bits even when each input is valid. GCC and Clang support `__int128` on common 64-bit targets, but it is an implementation extension rather than a standard C++23 fixed-width type.

A portable checked multiplication can use division bounds before multiplying, with separate signed edge cases. C++26 adds standardized checked integer arithmetic facilities; a C++23 implementation needs a reviewed local helper or compiler builtins with documented portability.

State ownership determines which arithmetic result is authoritative. Position updated by fills, open quantity updated by acknowledgements and cancels, and pending quantity reserved by outbound orders must follow one event-ordering model. A number protected by an atomic is not automatically a coherent risk state.

Use distinct types or named fields for confirmed, pending, and total exposure. Unit tests should reject mixing quantity, ticks, currency minor units, and scaled notional. Strong types may compile to the same integers after inlining while preventing an entire class of semantic errors.

Overflow or invalid scale should fail the check conservatively and raise an operational signal. Saturation can be useful for telemetry, but a saturated exposure used for admission can incorrectly appear below a differently scaled limit.

GCC and Clang provide checked-arithmetic builtins that report overflow without invoking it. The following listing is GCC/Clang-specific internal code: both `__int128` and the builtins stay behind a portable public boundary. A portability wrapper can use them on supported toolchains and a reviewed fallback elsewhere:

```cpp
struct notional_result {
    bool valid;
    __int128 value; // GCC/Clang extension on supported 64-bit targets
};

notional_result checked_notional(std::int64_t price_ticks,
                                 std::int64_t quantity,
                                 std::int64_t value_scale) noexcept {
    __int128 first;
    __int128 total;
    if (__builtin_mul_overflow(static_cast<__int128>(price_ticks),
                               static_cast<__int128>(quantity), &first) ||
        __builtin_mul_overflow(first,
                               static_cast<__int128>(value_scale), &total))
        return {false, 0};
    return {true, total};
}
```

On common implementations, multiplying two 64-bit values into 128 bits cannot overflow, but the second multiplication can. The explicit checks preserve the reasoning if representations change. The extension and builtin must be isolated behind a tested interface; they are not portable C++23.

For each check, derive a boundary table: minimum and maximum admitted price, quantity, scale, position, and accumulated notional. Test products exactly at the limit and one unit beyond in each sign combination. Random fuzzing rarely lands on the signed minimum, where negation and division checks are especially easy to get wrong.

## 36.9 Thread Confinement Versus Atomic State

**Thread confinement** gives one thread exclusive mutation authority over related state. Messages arrive through bounded queues, and the owner performs checks and updates in a total order. Ordinary loads and stores then need no inter-thread atomic synchronization.

The queue adds handoff latency and capacity, but it centralizes invariants. It is often preferable for an account-level risk gate whose checks must reserve several counters together. Sharding by account or strategy can scale ownership without splitting one invariant.

Atomic counters permit direct cross-thread updates but do not compose automatically. Updating position and notional in two atomics exposes intermediate combinations. A compare-exchange on a packed state works only if fields fit a lock-free atomic representation and all writers use it. Wider atomics may call hidden locks; verify `is_always_lock_free` and linked code on the deployment platform.

Conservative distributed budgets can avoid a shared atomic on every order. A coordinator grants each trading thread a bounded allowance. Local admission is thread-confined; replenishment is slower. Unused allowance reduces global utilization, while reclaiming allowance needs a protocol that cannot double-spend.

Choose ownership first, then memory order. Relaxed atomics can safely count independent telemetry, but a risk reservation needs the ordering and indivisibility defined by its algorithm.

## 36.10 Consistent Snapshots Across Cores

A **consistent snapshot** represents related fields from one logical version. Reading several atomics independently is data-race-free but can combine different updates.

Immutable snapshot publication is straightforward: construct a complete object, release-publish a pointer or index, and let readers acquire it. Storage reclamation then follows Chapter 17. Atomic `shared_ptr` provides lifetime at the cost of reference-count traffic; epochs or a bounded multi-buffer protocol can reduce reader work.

A sequence counter with atomic fields can allow readers to copy and validate a version. Ordinary fields concurrently read and written would be a formal C++ data race even if a retry detects change. Readers may starve under continuous writes, and counter wrap requires a bound.

For admission, a stale but internally consistent limit snapshot may still be unsafe if limits can only tighten. Include an activation version or effective sequence and define whether outstanding reservations use old or new limits. A kill switch commonly needs a separate fast path whose transition cannot be hidden behind a stale cache indefinitely.

Snapshot latency includes cache-line transfer and possible retries. Place frequently published version metadata away from read-mostly payload when doing so reduces invalidation, but account for the additional load. Test writer bursts and deliberately preempted readers.

A snapshot is not necessarily a reservation. If two cores read the same consistent “remaining 100” and each approve quantity 80, consistency did not prevent overcommit. Snapshot publication suits configuration and read-only observation. Consumable capacity needs an owner, atomic reservation, or prepartitioned budgets.

Another failure appears when position and pending notional publish separately: a reader can combine new position with old notional and admit a state no complete version permits. A version check works only when every field access is data-race-free and overlap forces retry. Exhausted retries should close new admission, not accept a mixture.

Arithmetic failures need a distinct reject code. Inject signed minima, maximum products, and a scale change concurrent with snapshot publication; verify that no partial reservation commits. Record the scale/version in a compact event so diagnosis does not require reconstructing mutable configuration.

For limit changes, publish the entire hierarchy with one monotonically increasing configuration version. Each admission records the version used. Tightening can first close admission, wait for owners to acknowledge the new version, reconcile reservations, and reopen. Loosening can usually activate without that barrier, but the policy should remain one state machine rather than a collection of atomic pointer swaps.

Snapshots also retain memory. If one reader stalls while configurations update repeatedly, an epoch scheme can retain every retired version. Configuration size, update rate, and maximum reader stall determine the bound. A small fixed set of buffers requires acknowledgement before reuse; two buffers and an atomic active index alone do not protect a delayed reader.

## 36.11 Fail-Open and Fail-Closed Policy

**Fail closed** means uncertainty denies new risk; **fail open** means the system continues despite a failed check or unavailable dependency. The choice is a business and safety policy, not a low-level optimization.

Pre-trade limits normally fail closed on arithmetic error, missing limits, stale authoritative state, pool exhaustion, or an unhealthy risk owner. Closing new orders may still permit cancels and risk-reducing actions. Treating every message identically can trap existing exposure.

Failure classification should be explicit:

| Failure | Possible policy |
|---|---|
| invalid new order | reject locally |
| risk snapshot stale | block new risk; request refresh |
| outbound queue full | reject or enter kill state |
| cancel path degraded | use reserved emergency capacity |
| telemetry unavailable | continue only if non-authoritative |

A fail-closed path must itself be bounded and observable. Synchronously formatting a detailed log or contacting a remote service can block after the decision. Record a compact event into a reserved bounded channel and return a stable reject code.

Test failures before production: corrupt a limit version, exhaust every pool and queue, inject arithmetic boundaries, stop the risk owner, and delay snapshot publication. Verify which messages remain permitted and that recovery cannot accidentally reopen admission.

## 36.12 Rate Limiters and Deterministic Admission

A **rate limiter** bounds admitted events over time. A token bucket has capacity `B`, replenishes at rate `R`, and consumes tokens per event. It permits a bounded burst while limiting sustained rate.

Floating-point replenishment introduces rounding and reproducibility questions. Fixed-point time and token units make the rule deterministic. Compute elapsed time using a monotonic clock, cap it before multiplication, use a wide intermediate, and clamp replenished tokens to capacity.

```text
elapsed = min(now - last, maximum_refill_interval)
added   = floor(elapsed * rate_numerator / rate_denominator)
tokens  = min(capacity, tokens + added)
```

Clock rollback should be impossible for a conforming `steady_clock`, but conversion, overflow, and cross-process clock domains still require care. Reading a clock on every order has instruction and possible library cost; batch-local budgets or timestamp reuse can reduce calls while changing admission granularity.

One owner gives deterministic ordering. A shared limiter needs atomic reservation, often a compare-exchange loop on combined timestamp and token state. Contention can cause retries and unfairness. Per-thread buckets scale but can admit the sum of their bursts; divide global capacity conservatively.

Configuration updates require a rule for existing tokens. Replacing the rate and capacity can preserve current tokens capped to the new capacity, reset to zero, or recompute from an activation timestamp. Each produces different bursts. Apply a versioned policy on the owner thread so an order cannot consume under half old and half new parameters.

Sliding-window limiters record timestamps or bucket counts over a window. Exact timestamp queues have memory and eviction work proportional to admitted events. A ring of fixed time buckets bounds memory and per-event work but introduces time quantization. Choose the algorithm from the contractual rule; a token bucket and fixed window are not interchangeable merely because both quote a rate.

Admission should return a reason—accepted, quantity limit, notional limit, stale state, rate limit, capacity, or kill state—without allocating. Evaluation order can place cheap, highly rejecting checks first, but preserve semantics: do not consume a rate token for an order rejected earlier unless policy explicitly charges attempts.

Verify with a model using exact arithmetic. Test events at identical timestamps, exact refill boundaries, long idle periods, timer wrap assumptions, concurrent attempts, and configuration changes. Performance tests should report retries, clock reads, branch distribution, and reject latency as well as accepted throughput.

### Worked design: a bounded order gateway

Consider one strategy shard trading a configured set of instruments through one order gateway. One pinned gateway thread owns outbound sequence, pending-order state, account risk reservations, and rate limiters. Strategy threads submit fixed-size intents through bounded SPSC queues. Exchange acknowledgements and fills enter through another sequenced input owned by the gateway.

```text
strategy shards                 gateway owner                 network
---------------                 -------------                 -------
bounded intents ---> validate -> reserve risk -> encode ---> outbound
                         |             |
                         |             +--> pending-order pool
                         v
                  deterministic reject

inbound ack/fill ----------------> reconcile reservation and position
```

The intent is a value object containing instrument, side, price ticks, quantity, strategy ID, and client request ID. It contains no string, owning pointer, or callback. The gateway maps instrument IDs into a prevalidated dense configuration table. Every lookup is bounds-checked before dereference.

Admission runs as a transaction. It first loads the current immutable configuration version and verifies kill state. It maps price and checks collars, validates quantity, computes wider candidate position and notional, checks instrument/account limits, previews rate-token availability, confirms outbound queue and order-pool capacity, and checks that the client ID is unused. Only then does it commit the risk reservation, consume a token, allocate a pool slot, and publish the outbound message.

The commit phase must not fail under its established preconditions. Pool allocation and hash insertion use reserved capacity and bounded probes. Encoding writes into a preclaimed fixed buffer. If publication can still fail because another actor changes capacity, ownership is incomplete; either the gateway must own that resource or the reservation protocol must include it.

A small rollback guard can restore counters if an exceptional setup action remains, but the hot path is easier to prove when all commit operations are nothrow. Rollback itself needs a bound and must not allocate. A production policy may treat a supposedly impossible commit failure as an invariant violation, close new admission, and preserve enough state for reconciliation.

An acknowledgement transitions pending quantity to acknowledged open quantity without changing total reserved exposure. A fill reduces open quantity and changes confirmed position. A reject releases pending reservation. A cancel request normally retains exposure until the venue confirms cancellation; releasing it when the request is sent permits another order to consume capacity while the original remains live.

Each inbound transition carries the venue-neutral order handle and an expected state. Duplicate acknowledgements, fills beyond remaining quantity, and transitions for a recycled generation are rejected into recovery rather than partially applied. Source sequence and local outbound sequence make reconciliation auditable.

The capacity worksheet includes:

- intent queue slots per strategy;
- live and pending order nodes;
- order-ID index buckets at maximum load;
- outbound buffers and messages awaiting send;
- inbound replay overlap;
- instrument level arrays and occupancy bitmaps;
- immutable configuration snapshots retained during publication;
- reserved diagnostic events for failure reporting.

Convert every item to bytes, round for alignment, add page and huge-page policy, and compare with the NUMA-local memory budget. Touch the complete committed range at startup. Record live high-water marks, but do not automatically convert an observed maximum into the configured limit.

The correctness test model runs the same event stream through a simple map-and-list reference book using arbitrary-precision or checked arithmetic. After every event it compares live IDs, FIFO order, level totals, best prices, pending exposure, confirmed position, and reject reason. Generated streams emphasize duplicate IDs, unknown cancels, price-band boundaries, full pools, maximum probes, partial fills, cancel/fill races, and limit changes.

The performance harness replays admitted and rejected mixes with the production object layout and capacity. It reports work by outcome because an early quantity reject and a successful order perform different work. Useful distributions include intent-to-publication latency, reject latency by reason, index probes, occupancy-bitmap words scanned, queue depth, pool high-water mark, and clock reads.

Fault injection stops the network consumer until outbound capacity fills, stalls the configuration publisher, exhausts diagnostic channels, and delays acknowledgements while fills arrive. The expected result is not always continued trading. It is the specified state transition: which requests are denied, which cancels remain possible, and what evidence permits recovery.

This design gains predictability from one owner, but the owner is a throughput bound. Scale by partitioning independent accounts or risk budgets only when the partition proof prevents oversubscription. If a global firm limit remains, its coordinator operates at a slower control cadence and grants conservative shard budgets. The fast path never reconstructs a global truth from casually read atomics.

## 36.13 Interview Check

1. Design a price-to-level function for a banded tick schedule and state its numeric preconditions.
2. Compare dense, hash, tree, and flat book representations for a sparse instrument with frequent best-price queries.
3. Why does a pool pointer not provide stable identity after slot reuse, and how does a generation handle help?
4. A modify moves an order to a full destination level. How should validation and commit be ordered?
5. Give a concrete bound for the work of add, cancel, and removal of the last order at the best price.
6. Explain how two individually atomic risk counters can still produce an inconsistent or overcommitted decision.
7. When would thread confinement beat direct atomic updates for risk state despite adding a queue?
8. Distinguish fail-closed admission from the treatment of cancels and risk-reducing actions.
9. Design a deterministic token bucket without floating point and identify all overflow boundaries.
10. Which metrics and fault tests would demonstrate that an order book remains within its storage and latency model?
