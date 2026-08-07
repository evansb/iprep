# Chapter 45 — Trading-System Capstones

The capstones combine numeric correctness, parsing, data structures, recovery, redundancy, and risk into bounded venue-neutral components. Each component must state what it owns, what it rejects, and what happens at capacity before performance work begins. The objective is not a proprietary trading stack; it is a small system whose semantics, memory footprint, latency path, failure modes, and evidence can survive an engineering review.

## 45.1 Fixed-Point Price Library

A fixed-point price represents a monetary value as an integer number of a declared quantum. It avoids binary floating-point ambiguity only when scale, conversion, rounding, and overflow are part of the type's contract.

**Requirements.** Implement `Price<Scale>` with a signed 64-bit raw representation, where `Scale` is the number of raw units per whole currency unit. For this capstone, require `Scale` to be a power of ten so decimal parsing and formatting have one fixed number of fractional places. Construction from raw units is explicit. Decimal parsing accepts a bounded ASCII grammar and a declared rounding policy; formatting is locale-independent. Addition and subtraction require equal scales. Multiplication by quantity and conversion between scales use a wider intermediate and return an explicit error on overflow or inexact conversion when policy forbids rounding.

**Environment.** Use C++23 with GCC and Clang. `__int128` is available on common GCC/Clang 64-bit targets but is not a standard C++ integer type; provide a checked portable path or state the supported toolchain. Tests use venue-neutral decimal strings and integer ticks. Do not use a binary floating-point constructor in the core API.

**Invariants.** Every `Price<Scale>` holds a valid raw integer. Scale is positive, compile-time, and included in the type. Arithmetic never invokes signed overflow. Parsing consumes the entire accepted input. Negative-zero text normalizes to raw zero. Comparisons at one scale compare raw values directly. Cross-scale operations are either explicit and checked or unavailable.

**Scaffold.** Keep the representation small and the fallible operations visible:

```cpp
#include <cstdint>

enum class PriceError { invalid, overflow, inexact };

consteval bool positive_power_of_ten(std::int64_t value) {
    if (value <= 0) return false;
    while (value > 1 && value % 10 == 0) value /= 10;
    return value == 1;
}

template<std::int64_t Scale>
class Price {
    static_assert(positive_power_of_ten(Scale));

public:
    static constexpr Price from_raw(std::int64_t raw) noexcept {
        return Price{raw, RawTag{}};
    }

    constexpr std::int64_t raw() const noexcept { return raw_; }
    friend constexpr auto operator<=>(const Price&, const Price&) = default;

private:
    struct RawTag {};
    constexpr Price(std::int64_t raw, RawTag) noexcept : raw_{raw} {}
    std::int64_t raw_{};
};
```

Add checked free functions returning `std::expected` so ordinary value construction remains nonthrowing. Parsing computes whole and fractional components with pre-multiply bounds checks. A price-times-quantity notional uses a wide intermediate before comparing risk limits; narrowing occurs only after a range check.

The accepted grammar is `[+-]?[0-9]+(\.[0-9]+)?` with a configured maximum character count. Decide whether `+` is accepted and whether fewer fractional digits are padded; this capstone accepts both and pads on the right. Excess digits use one named policy: reject, toward zero, toward negative infinity, toward positive infinity, or nearest with a stated tie rule. The default risk-facing parser rejects excess nonzero digits. It must not call `strtod`, consult locale, allocate a string, or infer a scale from input.

Checked addition can use boundary comparisons before the operation or compiler-supported checked intrinsics behind a portable interface. Never perform signed overflow and inspect it afterward. Formatting handles the most-negative raw value without first negating it in the same signed type. Write into a caller-supplied fixed span and return the written subspan or a capacity error.

**Failure injection.** Parse empty strings, signs without digits, extra decimal points, excess fractional digits, maximum and minimum values, leading zeros, unsupported whitespace, and trailing junk. Add and subtract values at both extremes. Convert between scales whose ratio is integral and nonintegral. Multiply by zero, maximum quantity, and a negative quantity if the domain forbids it.

**Verification.** Unit tests cover exact examples and boundary values. Property tests compare checked arithmetic with an arbitrary-precision reference in the test process. Round-trip `parse(format(x)) == x` for generated raw values. Compile-time tests verify size, trivial copyability if required, ordering, and prohibition of implicit raw conversion. Inspect optimized arithmetic and benchmark parsing distributions without inventing universal timings.

**Acceptance.** `sizeof(Price<Scale>)` equals the raw representation for the supported ABI unless an explained design feature changes it. All generated operations agree with the reference, all malformed strings reject without allocation, and every public fallible operation states whether the destination changes on error. Document the cost of division in scale conversion and keep it outside paths that already operate in canonical ticks.

Use strong companion types for `Quantity`, `OrderId`, and `Notional` rather than passing every domain value as `std::int64_t`. They can keep the same one-word representation while preventing price-plus-quantity mistakes at compile time. The notional type may need a wider range than persisted price; do not narrow merely to keep all wrappers the same size.

**Five-lens review.** Semantics: scale, grammar, rounding, and overflow. Latency: digit loop, division, branches, and error exits. Memory: one integer per price plus result discriminators on fallible operations. Predictability: bounded input length and no locale or allocation. Verification: boundary tests, reference arithmetic, fuzzing, sanitizer builds, and assembly.

## 45.2 Allocation-Free Market-Data Parser

An allocation-free parser validates a bounded wire message and returns values or views without acquiring dynamic storage. “Zero copy” is a lifetime statement as much as a speed statement: every view becomes invalid when its receive buffer is reused.

**Requirements.** Define a venue-neutral binary protocol with a fixed header containing magic, version, message type, total length, and 64-bit sequence number in network order. Support `Add`, `Cancel`, and `Trade` bodies with fixed-width integer fields. Decode from `std::span<const std::byte>` into a `std::variant` of small value messages or explicitly lifetime-bound views. Reject unknown required versions, types, invalid lengths, out-of-range enum values, invalid prices/quantities, and trailing bytes unless the version contract permits extensions.

Use this exact capstone layout, with no implicit wire padding:

| Field | Bytes | Rule |
|---|---:|---|
| Magic | 2 | `0x5142`, network order |
| Version | 1 | Exactly `1` |
| Type | 1 | `1=Add`, `2=Cancel`, `3=Trade` |
| Total length | 2 | Header plus body |
| Flags | 2 | Must be zero in version 1 |
| Sequence | 8 | Network order |

The common header is 16 bytes. `Cancel` adds an 8-byte order ID. `Add` adds order ID (8), signed raw price (8), quantity (4), side (1), and three reserved zero bytes: 24 body bytes. `Trade` uses order ID (8), raw price (8), quantity (4), and four reserved zero bytes. Fixed lengths are therefore 24 or 40 bytes. Signed wire values are reconstructed without relying on implementation-defined out-of-range unsigned-to-signed casts; preserve bits with `std::bit_cast` after assembling the unsigned representation.

**Environment.** Use a generated corpus rather than copied exchange data. Compile portable bounds-first code with GCC and Clang, then enable AddressSanitizer, UndefinedBehaviorSanitizer, and a coverage-guided fuzzer. A production benchmark uses the normal optimized build; sanitizer timings are not representative.

**Invariants.** No typed unaligned dereference or aliasing violation occurs. Every field read is preceded by a remaining-length check. Byte order conversion is explicit. A message advances sequence state only after full validation. No parse path allocates, logs, throws, or retains a span beyond buffer ownership. All accepted price and quantity values satisfy the fixed-point domain contract from Section 45.1.

**Scaffold.** A cursor centralizes bounds:

```cpp
class Cursor {
public:
    explicit Cursor(std::span<const std::byte> bytes) : bytes_{bytes} {}

    std::expected<std::uint32_t, ParseError> u32_be() noexcept;
    std::expected<std::uint64_t, ParseError> u64_be() noexcept;
    std::expected<std::span<const std::byte>, ParseError>
    take(std::size_t count) noexcept;

    std::size_t remaining() const noexcept { return bytes_.size(); }

private:
    std::span<const std::byte> bytes_;
};
```

Parse the common header, validate total length against the datagram and configured maximum, then dispatch by type. Keep rare diagnostic detail out of the hot result; an error enum plus byte offset is usually enough for a bounded counter and offline capture lookup. C++23 `std::expected` library availability should be checked for the deployed standard library.

Return value types by default because these messages are small. A `std::variant<Add, Cancel, Trade>` stores its largest alternative inline and needs a discriminator; its exact size and visitation implementation are library/ABI details. If a later schema adds variable data, introduce an explicitly named `MessageView` and bind its lifetime to a receive-batch callback. Do not quietly change an owning result into a view under the same API.

**Failure injection.** Truncate at every byte, mutate each length and type bit, use maximum integer values, corrupt magic/version, duplicate fields, append bytes, and misalign the starting address. Feed valid records with one-byte mutations. Reuse the receive buffer immediately after parsing in a special test to expose retained views under AddressSanitizer where possible.

**Verification.** A reference encoder/decoder written independently round-trips generated messages. The fuzzer asserts that parsing never crashes, never reads outside input, and either consumes exactly the declared message or rejects it. Instrument `operator new` or use a test allocator to assert zero allocations. Record branches, instructions, and cache behavior by message mix and by early versus late invalidity.

**Acceptance.** Exhaustive truncation of every valid seed rejects at the first unavailable field. Reserved bytes and unknown flags reject. Every accepted result re-encodes to the canonical byte sequence, and no invalid input changes sequence or book state. The optimized parser processes the fixed maximum in bounded steps; report separate distributions for each message type and malformed-input class.

Keep parser observability bounded. Increment one per-error counter and optionally copy the first `N` invalid records into a fixed flight recorder with capture length and sequence context. Formatting hexadecimal dumps in the receive loop would add variable work and can leak malformed-input content into logs. Offline tools can format the retained bytes after ownership is safe.

**Five-lens review.** Semantics: wire grammar, byte order, validation, and view lifetime. Latency: bounds branches, decoding, dispatch, and error location. Memory: cursor, inline result, receive batch, and no heap. Predictability: fixed maximum length, finite message types, and bounded error reporting. Verification: differential tests, fuzzing, sanitizers, allocation traps, and packet corpus coverage.

## 45.3 Bounded-Latency Limit-Order Book

A bounded-latency order book fixes its price range, order capacity, index capacity, and work per update. Average constant-time lookup is insufficient if rehashing, allocation, or an adversarial probe chain remains possible in the critical path.

**Requirements.** Maintain bids and asks for one instrument. Support add, cancel, reduce/execute, best bid/ask, and top levels. Preserve FIFO order at each price. Choose a configured tick interval `[min_tick, max_tick]`, a fixed order pool, and a fixed-capacity ID index. Every operation returns a status for duplicate ID, unknown ID, invalid side/price/quantity, pool full, index full, or consistency failure. No hot operation allocates.

**Environment.** Start single-threaded and single-writer. Replay generated event streams with a simple slow reference book for comparison. Size price arrays, order nodes, index, and test traces before the run. Pinning is optional and only on a reserved test core; correctness tests must not depend on affinity.

**Invariants.** Each live order occupies exactly one pool node, one ID-index entry, and one price-level FIFO. Level aggregate quantity equals the sum of its nodes, computed without overflow. FIFO head/tail links are reciprocal and acyclic. Empty levels have zero aggregate and no nodes. Best-price state names a nonempty level or the book is empty. Cancel or execution removes an order exactly once.

**Scaffold.** A direct price-to-level array gives a bounded mapping when the price range is reasonable:

```cpp
struct OrderNode {
    std::uint64_t id;
    std::uint32_t quantity;
    std::uint32_t next;
    std::uint32_t previous;
    std::uint32_t level_index;
};

struct Level {
    std::uint64_t aggregate_quantity;
    std::uint32_t head;
    std::uint32_t tail;
};
```

Use a sentinel index rather than pointers if the pool can move only during initialization. The ID index can use fixed open addressing with a declared maximum load. Every lookup has a finite probe limit, even though worst-case work may reach table capacity; choose capacity and hash defense accordingly. A hierarchical bitmap can find the next nonempty direct-addressed level in bounded word operations when scanning the entire price interval would be too costly.

An add first validates fields and proves that the ID is absent. It then reserves one node and one hash position before mutating the level. After initialization, it links at the tail, updates aggregate quantity, sets the nonempty bitmap, and updates best price. If reservation cannot complete, release any provisional resource and leave the book unchanged. A cancel locates the node by ID, unlinks its two neighbors, subtracts aggregate quantity with an invariant check, clears an empty level's bitmap bit, updates best price if necessary, removes the hash entry, and returns the node to the pool.

Open-address deletion needs a long-run policy. Accumulating tombstones makes probe work drift with history even when live load remains low. This capstone uses backward-shift deletion or an equivalent deletion strategy whose work is limited by the finite cluster/table size. Measure probes after adversarial add/cancel churn. A keyed high-quality hash can make deliberate collision attacks harder, but its initialization and per-lookup cost must be included.

Best-price discovery uses one bit per price level and a two-level summary bitmap. Setting or clearing a level updates its word and the summary bit for that word. Finding best asks for the highest bid bit or lowest ask bit with defined bit operations. Handle empty words without invoking count-leading/trailing-zero operations on zero when the chosen C++ facility does not define that input.

Readers do not access this mutable structure concurrently in the base design. Publish a separate immutable top-of-book snapshot through a safe handoff if another thread needs it. Adding locks or atomics inside nodes would change size, cache sharing, and consistency semantics without creating a coherent multi-field snapshot automatically.

**Failure injection.** Fill the pool and ID table, cluster hashes deliberately, add duplicate IDs, cancel unknown IDs, execute beyond remaining quantity, empty the best level repeatedly, and alternate extreme prices. Corrupt a link only in a copied debug instance and ensure the invariant checker identifies it. Test quantity aggregation near its numeric bound.

**Verification.** After every event in correctness runs, compare top levels and per-order state with the reference and run a full invariant check. Production-like replay disables the expensive checker but records statuses and final digest. Measure per-operation histograms by add/cancel/execute, probe counts, levels examined, pool high-water mark, allocations, cache/TLB counters, and code hot spots. Report capacity failures rather than excluding them.

**Acceptance.** One million generated legal and illegal operations, with a separately recorded seed, agree with the reference. Allocation instrumentation remains zero after construction. Maximum observed probe and bitmap-word counts do not exceed their proved capacities. At pool, index, price, or quantity limits, the operation returns its exact status and the pre-operation digest is unchanged.

Publish an operation-complexity table with the implementation:

| Operation | Fast path | Declared bound |
|---|---|---|
| Add | Hash absence check, reserve, tail link | Index capacity plus fixed bitmap work |
| Cancel | Hash lookup, unlink, release | Index capacity plus fixed bitmap work |
| Execute/reduce | Lookup and quantity update | Index capacity; removal adds unlink work |
| Best price | Cached value or bitmap query | Fixed summary/word count |

The bounds can be large enough to miss a latency objective; bounded does not mean acceptable. Adversarial probe and best-level transition tests determine whether capacities and algorithms need revision.

**Five-lens review.** Semantics: price-time priority and update statuses. Latency: hash probes, list updates, bitmap scans, and best-price changes. Memory: direct levels, nodes, index load, padding, pages, and NUMA placement. Predictability: fixed capacities, bounded probes/scans, single ownership, and overflow. Verification: reference replay, invariant checker, adversarial streams, allocation trap, counters, and percentile distributions.

## 45.4 Snapshot and Incremental Recovery

Snapshot recovery combines a point-in-time state image with ordered incremental updates. Correctness depends on the sequence boundary between them; applying every received message is wrong if messages are missing, duplicated, or older than the snapshot.

**Requirements.** Implement states `Starting`, `Live`, `Gap`, `AwaitingSnapshot`, and `Applying`. Incrementals carry a monotonically wrapping sequence under a documented half-range rule. A snapshot identifies the last included sequence and contains complete bounded book state. While waiting, store at most `recovery_capacity` validated incrementals. After a snapshot, discard buffered updates at or below its sequence, sort or index the remaining bounded window by sequence, apply a contiguous suffix, and enter `Live` only when no gap remains.

**Environment.** Use the parser and book from Sections 45.2 and 45.3 with a deterministic simulator producing snapshot and incremental channels. Keep one state-machine owner thread. Recovery I/O can occur elsewhere, but publication into the owner uses a bounded queue. No proprietary recovery protocol is assumed.

**Invariants.** Book state is never presented as live while a known sequence gap exists. A sequence applies at most once and only after its predecessor. Snapshot application either constructs a fully valid candidate book or leaves the current state unchanged. Buffer overflow transitions to a new snapshot request rather than dropping an arbitrary missing update. Recovery request count and retry timeout are bounded by policy.

**Scaffold.** Make transitions explicit:

```text
Starting --snapshot S--> Applying(S)
Live --receive > expected--> Gap -> AwaitingSnapshot
AwaitingSnapshot --snapshot S--> Applying(S)
Applying --contiguous buffered suffix--> Live
Applying --remaining hole/invalid snapshot--> AwaitingSnapshot
```

Build snapshots into a second preallocated book, validate them fully, then swap book roles at a safe single-owner point. The inactive book is cleared with bounded work before its next use. If copying snapshot state is permitted instead, include that cost and ensure readers cannot observe a partial copy.

The recovery window stores an expected sequence base and fixed slots tagged with their full sequence. A message ahead within the window maps to a slot by modular distance; the tag distinguishes current data from a stale occupant after wrap or reset. This avoids dynamic sorting and makes insertion bounded. Draining advances from the base while the next slot contains the exact expected tag. A collision or displacement outside the half-range/window invariant forces a new snapshot.

Snapshot acceptance checks instrument identity, schema/configuration epoch, capacity, record uniqueness, aggregate consistency, and included sequence. A snapshot from a previous session or product must not overwrite current state merely because its numeric sequence looks newer. Configuration changes either reset the recovery epoch explicitly or are rejected during a live epoch.

Publication after candidate validation is a state-machine event. First establish the candidate as active, then replay the contiguous buffered suffix against it, and only then publish `Live` plus the final applied sequence. If replay encounters invalid data or another hole, the candidate can remain internal for diagnostics but readers continue to see a not-live status. There is no interval in which a complete-looking book is advertised with a known missing update.

**Failure injection.** Drop one incremental, deliver duplicates and reordering, delay the snapshot, deliver an older snapshot, omit a level, exceed recovery capacity, wrap the sequence, and inject a gap while applying the buffered suffix. Kill and restart the recovery provider in the simulator. Force candidate-book capacity failure.

**Verification.** A ground-truth event log produces the expected state at every sequence. The recovered book digest must equal the ground truth only at declared live points. Model-based tests enumerate short event permutations around a gap. Record recovery duration, buffered high-water mark, snapshot retries, discarded duplicates, candidate build cost, and time unavailable as live.

**Acceptance.** Every permutation in the bounded model either reaches the exact ground-truth live state or remains explicitly nonlive. No window overflow overwrites an update. Snapshot failure leaves the prior published book/status coherent, recovery requests respect retry bounds, and the maximum replay burst work equals the declared window capacity.

**Five-lens review.** Semantics: snapshot inclusion boundary, sequence order, and live-state publication. Latency: candidate construction, buffering, replay burst, validation, and role swap. Memory: two books, bounded recovery window, and queue. Predictability: overflow, stale snapshot, repeated gap, and provider failure. Verification: state-machine model, ground-truth digest, injected permutations, counters, and recovery-time distribution.

## 45.5 Redundant A/B Feed Arbitration

Redundant feeds carry logically equivalent sequenced data over failure-independent paths. Arbitration accepts one valid copy of each sequence and uses the other path to cover loss; it must not merge inconsistent messages silently.

**Requirements.** Consume two feeds labeled A and B with the same logical sequence space. Validate messages before arbitration. For the expected sequence, accept the first valid copy and mark the later copy duplicate. Buffer a bounded number of ahead-of-expected messages per feed or in one sequence-indexed window. If both copies for one sequence arrive, compare a canonical message digest and raise a feed-consistency fault on mismatch. If neither path supplies the missing sequence before capacity or timeout policy, request recovery.

**Environment.** Drive the component with a deterministic dual-feed simulator capable of independent delay, loss, duplication, reordering, corruption, and path outage. Production hardware timestamps can be recorded for diagnostics, but correctness must not assume synchronized arrival timestamps order messages.

**Invariants.** Expected sequence advances once per logical message. A/B duplicates never update the book twice. An invalid message cannot hide a valid counterpart. Mismatched valid copies are quarantined and counted under an explicit fail-safe policy. The ahead window has one owner and fixed capacity. Sequence wrap is valid only under the declared maximum displacement.

**Scaffold.** Key the pending window by modular distance from `expected`:

```text
on message(feed, seq, digest):
  validate sequence distance and message
  if seq == expected: accept, expected++, drain contiguous pending
  else if seq is ahead within window: insert or compare duplicate
  else: classify duplicate/late or excessive gap
```

Pending entries record which feeds supplied a copy and the canonical payload or digest. Digest collisions cannot be treated as impossible when correctness is critical; compare the canonical bytes or decoded fields after a digest match policy appropriate to the format.

Fastest-copy arbitration makes an explicit trade: sequence 50 from A can update state before B's later copy is available for comparison. If B then supplies different valid content, the component cannot retroactively pretend no state changed. This capstone immediately sets a consistency-fault/kill state, stops outbound decisions that depend on the book, and requests an authoritative snapshot. A system that must prevent any mismatched message from applying has to wait for both copies or a trusted source, sacrificing latency and availability.

The pending window does not wait for both feeds under normal operation. Once the expected sequence is available, it is emitted immediately and the window drains. Per-feed health uses gaps, invalid messages, arrival skew, and silence as diagnostics, not as permission to advance past a missing logical sequence. On path restoration, stale packets classify as duplicates without filling the ahead window.

**Failure injection.** Drop only A, only B, and the same sequence on both. Delay A relative to B, alternate the faster path, reorder within the window, duplicate bursts, corrupt one copy, send a valid mismatch, exhaust pending capacity, and wrap sequence. Simulate path restoration with stale queued packets.

**Verification.** Compare accepted output against one canonical source log. Exactly one output exists per recovered sequence and outputs remain contiguous. Counters distinguish A-won, B-won, duplicates, per-path gaps, invalid copies, mismatches, joint gaps, and recovery. Measure arbitration processing, pending occupancy, delay from first copy to acceptance, and recovery transitions without rewarding a design that waits unnecessarily for both copies.

**Acceptance.** All deterministic dual-path fault traces yield the canonical output up to the first intentionally unrecoverable joint gap or mismatch. The component never emits twice, never skips silently, and never overwrites a pending sequence. Mismatch triggers the documented safe state even when the conflicting copy is late.

**Five-lens review.** Semantics: logical identity, duplicate suppression, mismatch, and recovery threshold. Latency: validation, window lookup, contiguous drain, and optional waiting. Memory: two receive batches and bounded pending entries. Predictability: joint loss, path skew, corruption, capacity, and wrap. Verification: canonical replay, exhaustive short permutations, fault matrix, counters, and latency/occupancy distributions.

## 45.6 Rate Limiter and Pre-Trade Risk Engine

A pre-trade gate admits an order only if rate and risk state permit it at one consistent decision point. Fast checks that overflow, read inconsistent snapshots, or fail open during stale state are not correct optimizations.

**Requirements.** Implement a fixed-point token-bucket rate limiter plus checks for maximum order quantity, price collar, maximum open orders, gross notional, net position, and kill state. Use a monotonic clock. Define whether rejected orders consume tokens; the recommended policy consumes only after every risk check succeeds and the order is committed to the outbound queue. All arithmetic is checked and uses the price type from Section 45.1.

**Environment.** Start with one owner thread for limits, positions, limiter, and outbound admission. Other threads publish bounded commands or immutable versioned snapshots. A fake monotonic clock drives deterministic tests; a target-host clock implementation drives performance measurements. Do not request real-time scheduling or change affinity outside reserved test resources.

**Invariants.** Tokens stay in `[0, capacity]`. Refill never moves time backward; clock anomalies follow an explicit fail-safe rule. Position, open quantity, and notional include all states named by policy, such as pending new and cancel messages. A check and its state update are atomic with respect to the owner event loop. Stale, missing, overflowed, or kill-state data rejects admission. Outbound queue full also rejects without partially updating risk state.

**Scaffold.** A checked decision pipeline is:

```text
validate order fields
-> read one coherent limit/state version
-> compute price collar and worst-case notional with wide intermediates
-> check position/open-order limits
-> compute token refill and availability
-> reserve bounded outbound slot
-> commit risk deltas and token consumption
-> publish outbound order
```

Use integer token units with a rational refill rate or a wide fixed-point accumulator. Clamp elapsed time before multiplication to avoid overflow after long idle periods. Separate configuration updates from order checks and apply a complete validated configuration at an event-loop boundary.

For a rational rate `rate_num / rate_den` tokens per nanosecond, calculate refill from `elapsed * rate_num + remainder` in a checked wide type. Add the quotient to tokens, keep the modulus as the new remainder, and cap at bucket capacity. When capped, reset or normalize the remainder according to one documented rule so idle time cannot create credit beyond capacity. A fake clock makes every boundary deterministic.

Reserve the outbound queue slot before committing mutable risk deltas. A reservation object is cancelled automatically unless `commit` publishes the fully encoded order. After all checks pass, update pending quantity/notional and consume tokens using operations already proved nonfailing, write the reserved slot, then publish it with the queue's release protocol. If encoding can still fail, move encoding before commit or make it total for validated input.

Transport failure after publication is not grounds to erase pending risk blindly: the remote venue might have accepted the order before disconnection. Session reconciliation decides whether to retain, cancel, or clear pending state. This capstone fails closed until authoritative session/order state is restored.

Risk configuration is versioned. A control-plane update builds and validates a complete immutable configuration, including numeric relationships such as nonnegative limits and collar ordering. The owner installs one pointer/index at an event boundary and records the version on every decision. Partial field-by-field updates are forbidden.

**Failure injection.** Send zero, negative where representable, and maximum fields; overflow notional intermediates; move price just inside and outside collars; exhaust every independent limit; move fake time backward and far forward; update limits during a burst; set kill state; fill the outbound queue; and deliver fills/cancels out of expected order under the system's declared event semantics.

**Verification.** A slow arbitrary-precision model makes the same decision for generated event streams. Property tests assert that accepted orders never violate post-commit limits and rejected orders leave state unchanged. Record rejection reason, token level, risk high-water marks, state version, queue occupancy, and decision-latency distributions. Inspect assembly for accidental division or overflow-undefined operations only after semantic tests pass.

**Acceptance.** The model and implementation agree across time, configuration, fill, cancel, reject, and disconnect streams. Every rejection leaves tokens, risk, and queue unchanged unless policy explicitly counts the attempt. Kill and stale states admit nothing. Capacity and numeric extremes return stable reason codes without exceptions or allocations.

**Five-lens review.** Semantics: policy fields, event inclusion, token consumption, and commit point. Latency: arithmetic, branches, time read, state access, and queue reservation. Memory: one-owner state, configuration snapshots, counters, and outbound ring. Predictability: overflow, stale state, clock jumps, capacity, and kill behavior. Verification: reference model, boundary generation, state invariants, allocation trap, assembly, and histograms.

## 45.7 Full Latency, Memory, and Failure-Mode Review

The final review evaluates the composed path, not the sum of isolated component medians. One message travels through buffers, sequence state, book updates, risk state, queues, and network I/O, while recovery and observability compete for resources.

**Requirements.** Compose the capstones into a venue-neutral pipeline:

```text
feed A/B receive
-> parse and validate
-> arbitrate sequence
-> recovery state machine
-> update order book
-> produce strategy intent (test stub)
-> pre-trade risk and rate limit
-> bounded outbound queue
-> order-entry encoder/test transport
```

Fix the maximum instruments, price levels, orders, pending feed window, recovery window, input batch, outbound orders, and diagnostic events. Define one owner for every mutable object. Provide overload behavior at every arrow. No benchmark run begins before initialization, prefaulting, and configuration validation complete.

**Environment.** Use generated market streams and a test transport that cannot reach a live venue. Run correctness under sanitizers and fuzzers, deterministic model tests in CI, and performance on documented target hardware with a noninstrumented optimized build. Any affinity, NUMA, memory locking, or network impairment uses a dedicated host or isolated namespace under operator-approved limits.

**Invariants.** Only fully validated, contiguous logical messages change live book state. Recovery never publishes a known-incomplete book. Each logical A/B message applies once. Every admitted outbound order passed one coherent risk version, owns a queue slot, and has corresponding pending-risk state. Every buffer/view lifetime ends before reuse. Capacity failure selects a declared reject, recovery, disconnect, or safe-stop transition.

**Implementation scaffold.** Produce four artifacts before optimization:

1. An ownership diagram naming every buffer, pool, queue, state machine, and thread.
2. A capacity table with per-element size, count, bytes, pages, NUMA node, and overflow action.
3. A fast/slow-path state diagram including first page touch, neighbor miss, gaps, recovery, queue full, logging overflow, and peer reconnect.
4. A measurement map naming timestamps, clocks, sequence IDs, counters, and capture boundaries.

The capacity table must use measured `sizeof` and alignment from the production configuration. Include container metadata, allocator/pool metadata, padding, double-buffered books, socket buffers, kernel/NIC rings where observable, and safety margin. Distinguish committed/resident memory from address-space reservation.

For example, do not write “one million orders” as a capacity. Record `1,000,000 * sizeof(OrderNode)`, ID-index bucket count and size, direct price-level count, two book instances, recovery slots, A/B pending slots, and alignment rounding. Convert totals to base pages and expected huge pages under the actual mapping policy. Then compare with NUMA-node capacity, memory-lock limit, and prefault duration. A spare slot in each bounded structure is useful only if its reserved memory is included.

Thread and queue architecture gets the same treatment. A recommended baseline has one feed-processing owner for arbitration, recovery, and book state; one separate order-session owner; and bounded SPSC handoffs where ownership crosses. Strategy computation may be inline or on another owner, but its snapshot and staleness semantics must be explicit. Every additional thread adds scheduler, cache-coherence, queue-capacity, and shutdown behavior.

**Failure injection.** Build a matrix rather than a demonstration. Inject malformed and truncated messages, one-path and joint feed loss, duplicate and conflicting copies, snapshot delay and corruption, book/index exhaustion, risk overflow, stale configuration, outbound backpressure, socket overflow, page faults, scheduler interruption, clock discontinuity in test abstraction, disk/log failure, process restart, route/neighbor cold state, and test-transport disconnect. Combine failures only after each isolated signature is known.

Each failure has an expected earliest detector, state transition, externally visible status, recovery action, capacity consumed, and maximum allowed persistence. A failure with no bounded response is an unresolved design issue, even if it is rare.

**Verification.** Use several complementary levels:

- Unit and property tests for price, parser, book, sequence, limiter, and risk invariants.
- Model-based event permutations for recovery and A/B arbitration.
- Fuzzing and sanitizers for byte-facing and lifetime-sensitive code.
- Deterministic end-to-end replay with a final state and outbound-order digest.
- Fault-injection replay with expected transition/counter manifests.
- Microbenchmarks that isolate equal semantic work.
- End-to-end latency histograms with sequences and no coordinated omission.
- `perf`, allocation instrumentation, page-fault/NUMA counters, queue high-water marks, socket/NIC/switch counters, and bounded packet captures.

Record compiler, flags, standard library, kernel, firmware, CPU, NUMA topology, NIC, link rate, offloads, affinity, frequency policy, and dataset. Repeat across cold startup, warmed steady state, bursts, recovery, and saturation. Do not mix sanitizer results with production latency claims.

Latency timestamps must bracket named stages and use a characterized clock. Store raw events in per-thread bounded flight recorders and export them after the run. If a recorder fills, count drops or overwrite under an explicit policy; never block the critical owner. Avoid coordinated omission by generating offered load independently of completion when the test asks about overload, and report rejected/dropped work alongside accepted latency.

Counters are reconciled by conservation where possible: generated messages = network/test drops + invalid messages + duplicates + accepted logical messages + messages still queued at stop. Accepted intents = risk rejects + queue rejects + published orders, adjusted for explicitly pending work. A mismatch in the accounting is itself a correctness failure, not measurement noise.

**Five-lens review.**

| Lens | Questions the final review must answer |
|---|---|
| Semantics | Which message changes which state, once, under what validated sequence and risk version? |
| Latency | Which instructions, branches, atomics, copies, syscalls, queue waits, faults, and retransmissions lie on each path? |
| Memory | What is the object/per-element footprint, who owns it, when is it resident, and which cache lines/pages/NUMA nodes are touched? |
| Predictability | What is fixed, amortized, average, or unbounded; what happens at every capacity and external failure? |
| Verification | Which model, test, counter, trace, capture, assembly, and benchmark can falsify each claim? |

Review pointer and iterator invalidation, exception behavior, atomic memory orders, cache-line sharing, thread migration, and diagnostics explicitly even if the chosen single-owner design makes some entries “none.” Absence is a conclusion to prove, not a checklist item to skip.

**Acceptance.** The system is ready for review when correctness holds under the full deterministic fault corpus, every capacity has a tested action, the optimized hot path performs zero unexpected allocations and faults, and latency results include overflow and recovery rather than discarding them. No claim may depend on a universal nanosecond constant or undocumented venue behavior.

The capstone remains disconnected from live order routing. Its order-entry transport writes to a simulator or capture file with an explicit test-only protocol marker, and credentials/configuration for a real venue are out of scope. Promotion to any external certification environment requires a separate operational, security, and venue-protocol review; performance success does not grant that authority.

Archive the final manifest, generated seeds, capacity tables, fault expectations, counter snapshots, and binary build identifiers so another engineer can reproduce both acceptance and failure results.

## 45.8 Interview Check

1. Design a fixed-point price conversion between two scales. Where can overflow or inexactness occur, and which rounding rule does the type expose?
2. Explain why an allocation-free zero-copy parser can still be unsafe. Trace bounds, alignment, byte order, and receive-buffer lifetime for one message.
3. For the bounded order book, derive memory from capacities and describe the worst-case work for ID lookup, cancel, best-price removal, and pool exhaustion.
4. A snapshot includes sequence 1,000 while buffered incrementals contain 998, 1,001, 1,003, and 1,002. State the exact discard and replay order and when the book may become live.
5. Feed A supplies sequence 50 first, feed B later supplies different valid content for sequence 50, and sequence 51 has already arrived. What state and safety policy prevent silent divergence?
6. Define the commit point of a pre-trade check. What must happen when the outbound queue fills after risk arithmetic but before publication?
7. Compare single-owner state with cross-thread atomics for book and risk processing. Which queueing, cache-coherence, snapshot, and failure costs move rather than disappear?
8. Construct a failure matrix row for a joint A/B gap followed by recovery-buffer overflow. Name detector, state transition, bounded resource use, external signal, and recovery.
9. What evidence proves a hot-path “zero allocation and zero fault” claim, and why do warmup-only timings fail to prove capacity behavior?
10. Present the complete pipeline through the five lenses, distinguishing standards guarantees, Linux behavior, deployed hardware assumptions, and facts established only by measurement.
