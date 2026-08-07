# Chapter 35 — Market-Data State and Recovery

A fast decoder is useful only while its state is trustworthy. Market-data systems must parse untrusted bytes, preserve message order across loss and duplication, combine redundant feeds, join snapshots to incrementals, and remain bounded during recovery. This chapter builds those behaviors as one explicit state machine, with buffer lifetime, overload policy, and observability designed into the normal path rather than added after the first gap.

## 35.1 Allocation-Free Binary Decoding

An **allocation-free decoder** reads a message without obtaining dynamic storage. It can return copied scalar fields and non-owning views into caller-owned bytes, but it cannot promise that later domain processing will never allocate unless that processing has its own bounded storage design.

Do not decode a wire header by casting a byte pointer to a C++ struct. The wire may use different alignment, padding, byte order, or object representation. A misaligned access can be undefined in C++, and a packed struct merely replaces one set of assumptions with compiler-specific layout behavior.

Read bytes under explicit bounds and endianness:

```cpp
#include <cstddef>
#include <cstdint>
#include <span>

class Cursor {
public:
    explicit Cursor(std::span<const std::byte> bytes) noexcept
        : bytes_{bytes} {}

    bool read_u16_be(std::uint16_t& out) noexcept {
        if (bytes_.size() - offset_ < 2) return false;
        const auto b0 = std::to_integer<std::uint8_t>(bytes_[offset_]);
        const auto b1 = std::to_integer<std::uint8_t>(bytes_[offset_ + 1]);
        out = (std::uint16_t{b0} << 8) | std::uint16_t{b1};
        offset_ += 2;
        return true;
    }

    bool read_u32_be(std::uint32_t& out) noexcept {
        if (bytes_.size() - offset_ < 4) return false;
        out = 0;
        for (int i = 0; i != 4; ++i) {
            out = (out << 8) |
                  std::to_integer<std::uint8_t>(bytes_[offset_ + i]);
        }
        offset_ += 4;
        return true;
    }

private:
    std::span<const std::byte> bytes_;
    std::size_t offset_{};
};
```

The subtraction checks are safe because the invariant `offset <= bytes.size()` must hold before each call. If arbitrary code can alter the cursor, check that invariant first; otherwise unsigned subtraction could wrap. A private offset and tested methods make the invariant easier to preserve.

The loop in `read_u32_be` has a compile-time trip count and GCC or Clang commonly unrolls it at optimization. A `memcpy` into an aligned integer followed by C++23 `std::byteswap` on little-endian hosts can also compile efficiently, but it needs an endian branch and honest C++23 library availability handling. The portable shifts are a clear baseline.

A decoder result should distinguish malformed input from a valid message type without allocation or exceptions:

```cpp
#include <cstddef>
#include <cstdint>
#include <span>

enum class DecodeError : std::uint8_t {
    none, truncated, bad_length, bad_type, bad_value
};

struct AddOrderView {
    std::uint64_t sequence{};
    std::uint64_t order_id{};
    std::int64_t price_ticks{};
    std::uint32_t quantity{};
    std::span<const std::byte> symbol; // borrows packet storage
};

struct DecodeResult {
    DecodeError error{};
    AddOrderView message{};
};
```

This result embeds fixed-size state and a view. Returning it does not itself allocate. The decoder should be `noexcept` once all failure modes are explicit. C++23 `std::expected` can express the same shape, but library support and object ABI should be checked on the deployment toolchain; it does not make an allocating payload allocation-free.

Parsing work should be proportional to validated message length and bounded field counts. Avoid locale, streams, temporary strings, maps populated on demand, and callbacks through type erasure. A switch on a validated message tag commonly inlines direct field decoders. A table of function pointers can reduce branch code size but introduces indirect calls; measure realistic type distributions and instruction-cache behavior.

Batching several datagrams can amortize syscall work, yet decoding should still establish a failure boundary per packet. One malformed message must not move a cursor into the next buffer or invalidate the remaining batch. Fuzz the decoder with truncation at every byte and with maximum counts, not just well-formed captures.

Separate framing from message decoding. A packet iterator validates each message length and yields a bounded subspan; a type decoder cannot read beyond that subspan even if one field is corrupt. The outer iterator advances only after the complete frame passes its length checks. This composition localizes errors and makes nested bounds visible.

Variable-length fields need an ownership decision. A fixed symbol field can remain a view long enough to resolve an instrument; a variable list needed after packet release must be copied into preallocated domain storage. “Zero copy” is not a goal when it transfers an unbounded lifetime obligation to every downstream stage.

Decoder tables and schemas should be initialized before live traffic. Lazy construction of a map, regular expression, or locale object can allocate and fault pages on the first message of a type. Touch lookup tables and exercise every supported decoder with a synthetic valid message during startup, then verify that a counting allocator observes no steady-state allocations.

## 35.2 Packet and Message Validation

Validation proves that later code's assumptions hold. It is part of the fast path because the cost of applying a malformed length, price, or identity can exceed any parsing savings.

Validate in an order that prevents unsafe work:

1. The packet has the minimum framing bytes.
2. Declared lengths fit the remaining packet without overflowing arithmetic.
3. Version, channel, and message type are supported.
4. Repetition counts fit both remaining bytes and configured limits.
5. Enumerations, prices, quantities, and identifiers satisfy domain rules.
6. Optional integrity fields or authentication checks pass where the protocol defines them.

Prefer `length <= remaining` over `offset + length <= size`; addition can wrap. For a repeated fixed-size entry, validate `count <= remaining / entry_size` before multiplying. If entries are variable length, advance one checked cursor and cap the count independently so a packet containing many empty entries cannot create unbounded loop work.

Packet checks and message checks are distinct. A UDP checksum or Ethernet FCS detects certain corruption in transit but does not establish that an application length, sequence, or enum is valid. Kernel delivery does not make bytes trusted. Conversely, an application checksum cannot restore a packet dropped before the socket.

Validation policy must define what happens next. A malformed packet can be dropped and counted, can mark the stream suspect and trigger recovery, or can terminate the session when continuing would be unsafe. The correct action depends on whether packet loss is recoverable and whether sequence numbers let the consumer detect omitted state.

Partial acceptance is dangerous. If a packet contains five sequenced messages and the fourth is malformed, applying the first three and silently skipping the rest changes the gap boundary. Either validate framing for the complete packet before mutation or record exactly which sequences were applied and enter recovery at the first untrusted one. The protocol's sequencing granularity determines the safe choice.

Expensive integrity checks can sometimes run once per packet rather than once per contained message. That optimization is valid only when the integrity field covers the exact framed bytes and failure rejects every contained event. Keep structural per-message bounds even after a packet-level checksum passes.

Do not synchronously format the offending packet on the critical path. Record a bounded binary diagnostic containing reason, channel, sequence if readable, length, and a short byte prefix. Full capture can run on a sampled or separate path with data-governance controls.

Validation branches are usually predictable for valid traffic. That is not a reason to remove them. Benchmark a valid corpus and a controlled invalid corpus; inspect branch and instruction counts; fuzz under AddressSanitizer and UndefinedBehaviorSanitizer. Sanitizer results establish safety evidence, not production timing.

Schema versions must be explicit. If a newer packet adds fields, the declared frame length may allow an older decoder to skip the suffix, but only when the protocol promises backward compatibility. Reject unknown versions when field meaning or sequence semantics could differ. A silent partial decode is more dangerous than an observable unavailable state.

Semantic validation includes cross-field relationships: delete quantity cannot exceed the known order under certain protocols, a price exponent must match reference data, a side enum must be valid, and an instrument must belong to the channel. Some checks require current state. Keep cheap structural validation in the decoder and state-dependent validation in the single ordered applicator so the parser remains deterministic and reusable.

Classify failures with stable bounded codes, not free-form strings. The code becomes a metric label and replay artifact. Limit label cardinality—never use raw order IDs or sequence numbers as metric dimensions—and put those details in sampled binary records instead.

## 35.3 Sequence-Gap Detection

A **sequence number** orders messages within a protocol-defined scope such as channel, product partition, or session. Gap detection compares each received sequence against the next sequence the consumer requires.

For a stream whose sequence does not wrap within a session, the state is simple:

```cpp
#include <cstdint>

enum class SequenceRelation { expected, future, old };

SequenceRelation classify(std::uint64_t received,
                          std::uint64_t expected) noexcept {
    if (received == expected) return SequenceRelation::expected;
    if (received > expected)  return SequenceRelation::future;
    return SequenceRelation::old;
}
```

An expected message is applied and increments `expected`. A future message proves that at least `[expected, received)` is missing, although redundant feeds or permissible reordering may still supply it. An old message is a duplicate or stale message and must not be applied again.

Wraparound changes the relation. Unsigned subtraction can implement serial-number arithmetic only when the protocol defines the modulus and comparisons never span half or more of the sequence space. Do not import a generic “signed difference” trick without proving those conditions. A session epoch plus a sequence that resets at logon is often clearer.

Some packets carry a first sequence and message count. Validate the count and compute the last sequence with checked arithmetic. A zero-message heartbeat may advance no application state while still proving channel liveness. Protocol definitions decide whether sequence is per packet, per message, or per recoverable event.

The gap transition should be explicit:

```text
LIVE --future sequence--> GAPPED --recovery requested--> RECOVERING
  ^                            |                            |
  |                            +--buffer overflow-----------+--> RESNAPSHOT
  +--------contiguous replay and live catch-up--------------+
```

Store the first missing sequence, highest observed sequence, channel, session epoch, and detection time. Do not emit a recovery request for every later packet in the same gap. Coalesce ranges under a bounded policy, and cap retry rate so an outage does not turn the receiver into a request storm.

State invariants make implementation review possible:

| State | May mutate published book? | Future-message handling |
|---|---|---|
| `LIVE` | Yes, for the expected sequence | Enter gap on a future sequence |
| `GAPPED` | No further dependent updates | Store within bounded window |
| `RECOVERING` | Mutate private or isolated recovery state | Merge by full sequence |
| `RESNAPSHOT` | No | Buffer only within snapshot policy |

Whether recovery mutates the former live book or a staging copy is a design choice, but readers must see it as unavailable until continuity is restored. The state enum alone does not enforce that rule; publication APIs must carry availability.

Gap detection belongs before state mutation. Applying sequence 105 while 104 is absent can make an order book internally inconsistent, even if 105 looks valid alone. If the protocol guarantees messages are independent within a specified class, that exception must be encoded by message type and tested—not assumed globally.

Sequence initialization is a state transition. At cold start, the first observed sequence is not automatically a safe baseline; doing so hides messages lost before process readiness. Obtain the expected start from session negotiation, persisted checkpoint, or snapshot boundary. If the protocol explicitly says “start from first packet after join,” record that degraded scope.

Empty packets, administrative events, and reset messages need defined sequence effects. A reset should advance the epoch and clear reorder, recovery, and deduplication state atomically from the owner's perspective. Old packets still in kernel or user queues must then be rejected by epoch or session identity, not compared only by their small sequence.

Expose both gap count and missing-message count. One outage can create a million-message range; a burst of isolated losses can create many one-message gaps. These patterns have different causes and recovery costs. Keep arithmetic checked when computing range length.

## 35.4 Redundant-Feed Arbitration

Redundant A/B feeds carry equivalent logical data over separate paths so that one path can cover loss or delay on the other. **Arbitration** chooses which arrival to apply while suppressing the duplicate.

The lowest-latency common policy is first valid arrival by sequence. If sequence `s` is expected, apply the first valid copy from either feed and advance. When the second copy arrives, classify it as old and discard it. The application does not wait for both paths on every message.

This policy requires equivalence. If two copies with the same session and sequence can contain different business data, define which source is authoritative or compare a cheap canonical digest and enter a fault state on mismatch. Silently accepting whichever raced first makes replay nondeterministic and can hide upstream corruption.

Each feed also needs its own receive statistics and high-water mark. A combined expected sequence alone cannot tell operators that feed B has been dead for ten minutes while feed A continues perfectly. Track last arrival time, last sequence, duplicates contributed, gaps observed, and packets selected from each feed.

Reordering complicates immediate gap declaration. Suppose A delivers 100 then 102, while B's 101 is in flight. The arbitrator can hold 102 in a bounded reorder window and accept 101 from B. The window is indexed by sequence, stores at most a configured number of decoded events or packet leases, and has a time or distance threshold. When either threshold expires, request recovery.

A distance-bounded slot table avoids allocation:

```text
expected = 101, window size = 4

slot:       101       102       103       104
present:     no        yes        no        no
source:       -         A          -         -
```

Map `sequence % capacity` only after checking that the sequence lies within the current window and that the slot's stored full sequence matches. Otherwise wrap can overwrite a different outstanding event. When full, the policy must resnapshot or drop buffered future events and recover; it cannot grow invisibly.

Slot payload can be normalized event data or ownership of a packet buffer. Normalized data costs a bounded copy and releases receive capacity promptly. Packet ownership avoids the copy but couples reorder depth to receive-ring availability. Include both slot and leased-buffer capacity in overload analysis.

One thread should own arbitration state when possible. Two receive threads racing to publish the same sequence need atomics, ownership transfer, and duplicate resolution on every event. Steering both feeds to one polling thread often provides simpler and more predictable state, though it may limit throughput. Measure the actual packet rate and CPU headroom.

Redundancy is not independence unless paths truly differ. A and B may share a switch, NIC queue, socket buffer, CPU, or application queue. Feed metrics should include capture point and path identity so simultaneous loss is not misdiagnosed as an arbitration bug. Separate sockets and receive rings can still converge on one ordered state owner through bounded handoff.

Arrival timestamps are useful for path comparison but should not decide logical order when sequence is authoritative. Hardware timestamps from two NICs may use different clock domains or calibration. Record source and timestamp domain, and compare latency only after the synchronization checks from Chapter 33.

If one feed consistently leads, first-arrival selection may make almost every packet from the other a duplicate. The duplicate work is still necessary insurance. Optimize its cheap path—header validation, epoch/sequence classification, release—without skipping enough validation to miss a corrupt or misconfigured standby feed.

## 35.5 Snapshot and Incremental State

A **snapshot** describes state at a protocol-defined boundary; an **incremental** describes a change relative to prior state. Combining them correctly requires the snapshot's sequence relationship, not merely their arrival times.

A robust join follows this pattern:

1. Enter snapshot-building state and record the requested channel or instrument scope.
2. Continue receiving live incrementals into a bounded buffer.
3. Validate and build the snapshot in private staging storage.
4. Read the snapshot boundary sequence from the protocol.
5. Discard buffered incrementals at or before that boundary.
6. Apply buffered messages from the protocol-defined successor of `boundary` only while contiguous.
7. Publish the staged state after it catches up to the required live point.

The snapshot may span multiple packets. Validate snapshot identity, fragment index or sequence, declared totals, duplicates, and completion. A “last fragment” flag does not prove all earlier fragments arrived. Cap entries and fragments to the preallocated staging capacity.

Never clear the live book and fill it incrementally where readers can observe partial state. Build a second book or otherwise isolate mutation, then publish under the concurrency contract used by readers. Double buffering makes memory consumption explicit: two complete books plus buffered incrementals and recovery metadata.

The boundary semantics are protocol-specific. A snapshot marked “through sequence 500” usually joins at 501; another protocol may label the first required incremental. Encode a checked or protocol-defined successor operation in one adapter so wrapping and terminal sequence values are handled deliberately, and test the off-by-one cases. Do not write an unchecked generic `boundary + 1` or infer a boundary from the local receive timestamp.

If the live buffer overflows before the snapshot catches up, the state is no longer recoverable from that attempt. Abort it, increment a reason-specific counter, and request a new snapshot under retry backoff. Expanding a vector during the outage only postpones a memory failure and increases catch-up latency.

Snapshot publication should include an epoch or generation. Downstream consumers can detect that handles and derived state based on the old book are stale. Publishing a pointer atomically protects only pointer visibility; reclamation and consistent multi-field state require the mechanisms discussed in Chapters 14–17 and 36.

Snapshot scope matters. A channel-wide snapshot may cover thousands of instruments with one boundary; per-instrument snapshots can complete independently. Buffering and publication must use the same scope. Combining instrument A from one boundary and B from another is acceptable only if consumers do not require a channel-consistent view.

Derived state should be built or invalidated with the snapshot. Best bid/ask caches, aggregate quantities, instrument maps, and risk inputs cannot continue pointing into the abandoned book. Recomputing them before publication adds work to snapshot completion but prevents readers from observing a new book with old derived values.

Snapshot memory is a capacity commitment. Preallocate node pools, price-level arrays, fragment tracking, and future-incremental slots. Touch them during startup if the operational policy requires avoiding first-use faults. Report configured capacity alongside venue reference-data maxima so an ordinary market expansion does not appear as random recovery failure.

## 35.6 Recovery Channels and Replay

A **recovery channel** supplies missing historical messages or a fresh snapshot. Recovery runs concurrently with new live arrivals, so it is a merge problem rather than a pause-and-copy operation.

On a gap `[L, H)`, request a bounded range according to the venue-neutral adapter. Continue capturing live messages at `H` and above in a bounded buffer. Validate replay messages with the same decoder and domain rules as live traffic; “recovery” is not a trust level.

Apply only a contiguous sequence beginning at `L`. Replay may overlap messages already received on A or B. Duplicates are suppressed by sequence and epoch. Once replay reaches the buffered live range, drain contiguous buffered events and return to `LIVE` only when no hole remains.

```text
missing:       204 205 206
live buffered:             207 208 209
replay:        204 205 206 207
apply:         204 205 206 207 208 209
discard buffered duplicate: 207
```

Recovery requests need limits: maximum range, maximum outstanding requests, timeout, retry count or duration, and resnapshot threshold. A very large gap can be cheaper and safer to repair with a snapshot than with millions of incrementals. The threshold depends on message rate, replay capacity, state rebuild cost, and the provider's service contract.

Replay must preserve deterministic order. If several recovery responses arrive concurrently, queue or merge them by full sequence under one state owner. Do not let network completion order decide application order. Log the requested and received ranges in compact binary events so a postmortem can reconstruct the transition.

Recovery traffic can compete with live traffic for CPU, socket buffers, and memory bandwidth. Separate queues or priorities can keep live ingestion draining while catch-up consumes a controlled budget. Too little recovery budget prolongs stale state; too much can cause another live drop. Observe both queue occupancy and progress rate.

Recovery has a throughput condition: catch-up service rate must exceed the live arrival rate by enough to drain accumulated backlog. Measure decoded and applied messages per budget interval, not only response bandwidth. If the condition is false, abandon incremental catch-up at a bounded threshold and take the snapshot path.

Rate limiting should include jitter or coordination when many channels detect a shared outage. Simultaneous retries can overload the recovery service and the local CPU. Preserve per-channel correctness while a higher-level controller budgets aggregate requests.

If recovery cannot be proven complete, fail closed for state-dependent decisions. The system may continue recording raw traffic and health metrics while marking the book unavailable. Returning to live state because a timeout expired converts an observable outage into silent corruption.

Associate responses with a request or generation when the service provides one. A delayed response to an earlier gap must not be merged into a later recovery attempt merely because some sequence numbers overlap. Without request IDs, use session epoch, requested range, and active state to reject unrelated replay.

Recovery completion needs a clear live high-water target. Catching the point at which the request was sent is insufficient if live packets accumulated meanwhile. The target advances as live traffic is buffered; completion occurs when contiguous application reaches the current buffered frontier and the queues have no unresolved hole.

Persisted raw packet logs can provide another recovery source, but durability and completeness must be proven. An asynchronous logger may itself have dropped the missing packet. Store sequence and integrity metadata with log segments, and never treat “file exists” as evidence of a contiguous replay range.

Exercise recovery under sustained arrival, not only a paused test feed. Inject response reordering, duplicate ranges, partial responses, timeouts, and a second live loss during catch-up. Assert state and final book equivalence against a no-loss reference run.

## 35.7 Duplicate and Stale-Message Handling

A **duplicate** repeats a logical event already applied in the current epoch. A **stale message** belongs to an older epoch, snapshot generation, or state lifetime. Both must be identified before mutation.

Sequence numbers often provide the primary duplicate key, but only within their scope. Store session or channel epoch with the next expected sequence. After reconnect, sequence 1 from the new session is not a duplicate of sequence 1 from yesterday. If the protocol supplies a unique event ID, validate its relationship to sequence rather than replacing one blindly with the other.

Applying a duplicate add, cancel, or trade can corrupt state. Prefer suppression at the ordered ingress so domain handlers see each event once. Domain operations should still validate identities and generations: a cancel for an unknown order might indicate a duplicate, a gap, stale state, or malformed input, and those cases need different diagnostics.

Sequence-based suppression needs bounded history. Values below `expected` can be dropped without remembering every prior sequence when delivery is strictly ordered after arbitration. If messages can arrive independently by instrument, keep a per-partition sequence or a bounded deduplication window as the protocol requires. An unbounded hash set of event IDs is not a sustainable recovery design.

Snapshot fragments and recovery responses also need duplicate handling. Receiving a fragment twice must not double-add levels. Store a bounded fragment bitmap or full fragment sequence in staging state. Clear it only when the snapshot generation changes under an explicit transition.

Stale buffer views are a different failure with similar symptoms. A decoded message whose receive slot has been recycled can appear to carry a new sequence and old identity fields. Ownership rules in the next section prevent that class before duplicate logic attempts to interpret corrupt bytes.

Idempotence is helpful but does not replace ordering. Setting a level quantity to an absolute value may be idempotent when repeated, while applying a delta is not. Even absolute updates can be stale and overwrite a newer value. Suppress by sequence before asking whether the business operation happens to tolerate duplication.

Order identifiers are often reused after a session or generation boundary. A domain handle should include generation or be resolved only inside current state. Treating a late cancel for an old generation as a cancel of the new order with the same numeric ID is a classic plausible-state failure.

Count duplicates by source and state. Normal A/B duplicates while live are expected; repeated duplicates in replay indicate overlap; stale-epoch traffic after reset can indicate queues not drained or upstream misconfiguration. One total counter hides those operationally different cases.

## 35.8 Buffer Ownership and Parser Views

A parser view borrows bytes. Its validity ends when the owner releases, overwrites, unmaps, or reallocates the buffer. The type `span<const byte>` expresses extent and const access, not lifetime.

In a receive ring, ownership commonly flows through explicit states:

```text
NIC/producer owns slot
        |
        v
receiver owns filled slot --> decoder creates temporary views
        |                              |
        +--> domain copies required state
        |
        v
receiver releases slot --> producer may overwrite bytes
```

If decoding and application occur synchronously on one thread, keep every view inside the slot-processing call. Copy durable fields—order ID, tick price, quantity, flags—into domain storage before release. A symbol view can be resolved to a stable instrument ID while valid rather than copied into every order.

Passing a view to another thread transfers a lifetime obligation. Options include transferring exclusive ownership of the ring slot, reference-counting a buffer lease, or copying the required payload into a bounded queue element. Exclusive slot transfer is simple but can exhaust the ring when consumers stall. Reference counting adds atomic operations and delayed reclamation. Copying has predictable byte work when messages have a hard maximum.

A queue containing `AddOrderView` is not owning merely because the struct was copied. Its span still points into the original packet. Name owning and borrowed message forms differently and make conversion explicit. A debug build can attach a generation to a slot lease and assert that a view is consumed before reuse; production correctness must not rely solely on the assertion.

Kernel-bypass and zero-copy paths make ownership more visible, not less important. Returning a descriptor to the NIC can permit DMA overwrite. Kernel sockets usually copy into application memory on receive, but reusing that application buffer has the same logical effect. The safe lifetime boundary follows actual storage ownership.

Memory layout affects cache work. A domain event containing only normalized scalar fields can fit into one or two cache lines and avoid rereading the packet. Copying an entire maximum-sized packet into every queue slot wastes bandwidth. Measure the fields downstream truly needs and preserve the raw packet separately only under a bounded capture policy.

An ownership-carrying lease should make release deterministic. Its destructor can return a slot to a pool, but moving the lease transfers that responsibility and any views must not outlive it. A shared lease extends lifetime across consumers but adds a control block or embedded atomic reference count. Do not hide that choice behind the same alias used for an ordinary span.

Buffer pools need an exhaustion policy just like message queues. If every slot is leased to slow consumers, receive must drop, copy into an emergency bounded pool, or declare the stream stale. Allocating an extra packet dynamically changes the design precisely under overload.

Poisoning recycled buffers in tests can reveal accidental retention. Combine it with a small ring that wraps frequently and randomized consumer delay. In optimized production, generation tags and ownership invariants should catch misuse without filling every byte on release.

## 35.9 Backpressure, Drops, and Bounded Queues

**Backpressure** occurs when a downstream stage cannot accept work at the arrival rate. A feed arriving from the network usually cannot be slowed reliably by the local parser; delaying reads eventually fills application, socket, driver, or NIC queues and then causes drops.

Every in-process queue needs a fixed capacity or a proved memory budget and an explicit full policy. Common actions are:

| Full policy | Consequence for market data |
|---|---|
| Block producer | Can move loss upstream and add scheduler latency |
| Drop newest | Preserves queued prefix but creates a sequence gap |
| Drop oldest | Keeps recent traffic but invalidates contiguous state |
| Overwrite by key | Valid only for explicitly conflatable data |
| Mark stale and resnapshot | Sacrifices availability to preserve correctness |

Incremental order-book updates are generally not conflatable: an add followed by cancel cannot be replaced by the cancel unless the protocol and current state make that transformation valid. When a required incremental is dropped, mark the state gapped before processing later messages and start bounded recovery.

A bounded SPSC ring can make enqueue and dequeue work predictable when exactly one producer and one consumer own it. Capacity must cover a measured burst plus recovery interference, not merely average traffic. Larger capacity absorbs a longer burst but increases memory, catch-up time, and the age of the oldest event.

Track a high-water mark and failed enqueue count without placing contended logging on every event. Sampling occupancy can miss a brief full condition; updating a per-queue maximum with thread-confined state is cheap when one owner observes occupancy. Export metrics asynchronously.

Batching trades syscall and synchronization overhead against waiting time and queue occupancy. Drain up to a bounded batch or time budget, then give recovery and health work a chance to run. An unlimited drain loop under sustained load can starve control-plane transitions even while it improves packet throughput.

Capacity tests must force wraparound, exactly-full and exactly-empty states, producer bursts, delayed consumers, and recovery plus live traffic together. Check sequence continuity in the output, not only queue counters. ThreadSanitizer can find data races in a test configuration, while cache-line placement and acquire/release costs need optimized target measurements.

Size from a budget rather than a guess. At peak rate `R` messages per second and tolerated consumer pause `T`, the queue needs at least `R × T` slots plus burst and scheduling margin. Multiply by the real padded slot size to obtain memory, then verify that catch-up throughput exceeds arrival rate. If it does not, a larger queue only delays inevitable overflow.

Queue age is often more useful than depth. A half-full queue of large, expensive messages can represent more delay than a full queue of cheap heartbeats. Timestamp enqueue in a known monotonic domain or carry ingress time, and export the oldest-event age with bounded overhead.

Overload policy should propagate availability state. Once a required event is dropped, downstream strategies must not continue reading a book merely because the queue later drains. Publish `gapped` or `unavailable` before exposing subsequent state and clear it only through the proven recovery transition.

Avoid a chain of uncoordinated buffers. NIC, kernel, receiver, decoder, recovery, and strategy queues each add burst capacity and latency. Document the full path and observe high-water marks together; otherwise increasing one buffer can move the drop and lengthen time-to-detection.

## 35.10 Failure-State Observability

Observability must answer whether state is current, why it is not, and whether recovery is progressing. A single “packets dropped” counter cannot distinguish network loss, parser rejection, duplicate suppression, application overflow, or a stale session.

Maintain reason-specific counters and state gauges:

- packets and messages received by feed and channel;
- last received, applied, and expected sequence;
- gaps detected, missing messages, and gap range;
- duplicates and stale-epoch messages;
- malformed packets by bounded reason code;
- recovery requests, retries, messages replayed, and time in recovery;
- snapshot attempts, fragment gaps, buffer overflows, and successful publications;
- queue occupancy, high-water mark, and enqueue failures;
- last valid arrival time and last state-advance time per feed.

Counters need ownership policy. Per-thread counters avoid atomic contention on the ingress core and can be aggregated periodically. Cross-thread gauges require synchronization and padding to avoid false sharing. A monitoring reader observing several fields may see different instants unless they are published as a snapshot; label approximate metrics accordingly.

Emit a bounded binary transition record for rare events such as `LIVE -> GAPPED`, recovery request, snapshot abort, and return to live. Include monotonic timestamp, channel, epoch, expected and received sequence, reason, queue occupancy, and feed source. Formatting and external I/O belong on another thread.

Clock choice matters. A monotonic clock measures outage duration without wall-clock steps. Hardware receive timestamps can help localize network delay but may use a PTP hardware-clock domain that must be converted and monitored as Chapter 33 describes. Never subtract timestamps from unverified clock domains.

Correlate layers. A sequence gap with NIC missed-packet counters points differently from one with an application queue overflow. Socket drops, softnet backlog, IRQ migration, page faults, and CPU throttling can all interrupt ingress. Record enough deployment context to align application transitions with Linux and NIC metrics without permanently enabling high-overhead tracing.

A flight recorder is a fixed-size ring of compact recent events that overwrites old entries. It bounds memory and preserves context before a failure. Publication must not race with readers; use one-writer records with sequence or commit markers, and accept that a crash may leave the newest record incomplete. Do not store borrowed packet pointers in it.

Alert on state semantics, not only rates. Useful conditions include state not live, expected sequence not advancing while packets arrive, one redundant feed silent, repeated recovery failure, snapshot buffer near capacity, or increasing event age. Rate limits and hysteresis prevent an outage from overwhelming the monitoring system.

Availability should propagate to every consumer. A strategy may choose to cancel orders, stop quoting, or use another source, but it must receive a generation-tagged unavailable status rather than infer health from missing callbacks. Recovery success publishes the new generation and continuity evidence together.

Test observability with fault injection. Drop selected sequences, duplicate packets, reorder A/B arrivals, corrupt lengths, delay recovery, overflow the future window, recycle buffers aggressively, and force snapshot restart. The state transition, counters, and diagnostic record should explain each injected failure without consulting synchronous debug logs.

Define freshness as data, not intuition. A published status can contain state enum, channel epoch, last applied sequence, last state-advance monotonic time, and snapshot generation. Consumers then reject stale state under their own documented threshold rather than trusting that a process heartbeat means the book is current.

Metrics transport can fail during the same overload. Keep critical state locally queryable and preserve transition records in bounded memory even when an exporter is disconnected. Export failure must not block ingress. Count lost or overwritten diagnostic records so absence of evidence is not mistaken for evidence of health.

Sequence values may be sensitive at high cardinality and can roll rapidly; counters should remain numeric gauges rather than metric labels. Feed, channel, state, and bounded reason code are suitable dimensions. Instrument ID often is not unless the monitoring system is explicitly sized for it.

Postmortem correlation should reconstruct a timeline: last good message, first detected hole, A/B health, queue state, recovery requests and responses, snapshot boundary, publication, and consumer availability. If any transition lacks the previous and next state, the observability design is incomplete.

## 35.11 Interview Check

1. Why is casting a packet pointer to a packed C++ struct not a portable allocation-free decoder? Discuss lifetime, alignment, padding, and endianness.
2. Design a bounds check for `count` fixed-size entries that cannot overflow while computing the required bytes.
3. A receiver sees sequences 100 on A, 102 on A, 101 on B, and 102 on B. Show the arbitration and state transitions for a reorder window of four.
4. Which conditions are required before unsigned modular arithmetic can classify wrapped sequence numbers safely?
5. Describe the exact join between a snapshot labeled through sequence 500 and live incrementals 498–505. Which messages are discarded, buffered, and applied?
6. How should live ingestion and replay share CPU and queues during a gap? State the failure policy when the recovery buffer fills.
7. Explain why copying a struct containing `std::span<const std::byte>` into another thread's queue does not transfer packet ownership.
8. Compare exclusive receive-slot transfer, reference-counted leases, and bounded payload copies for cross-thread decoding.
9. Why are order-book incrementals generally unsafe to conflate under backpressure? Give a case where dropping one produces plausible but wrong state.
10. Specify the counters and transition records needed to distinguish NIC loss, socket overflow, malformed input, redundant-feed duplication, and application-queue overflow.
