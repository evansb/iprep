# Chapter 30 — Sessions, Representation, and Trading Protocols

A transport connection can deliver bytes or datagrams without knowing whether a trading participant is logged in, which application message comes next, or how stale state is repaired after a gap. Those responsibilities live in protocol state machines above TCP and UDP. Their costs are often underestimated because framing, validation, persistence, replay, encryption, and application queueing are discussed separately. This chapter treats them as one data path: from logical session state through wire representation to bounded parsing and recovery.

## 30.1 Practical Session-Layer Responsibilities

A **session** is a logical relationship whose state persists across individual application messages and may outlive one transport connection. Internet applications rarely expose a distinct OSI session-layer implementation; instead, protocols implement session responsibilities directly.

Typical session state includes:

- authenticated participant and granted capabilities;
- inbound and outbound application sequence numbers;
- negotiated protocol version and features;
- heartbeat and liveness deadlines;
- replay or recovery position;
- connection generation and failover role;
- shutdown or logout state.

This state is different from TCP state. A newly established TCP connection can carry a resumed application session, or a healthy TCP connection can carry a session that the peer has rejected. TCP sequence numbers order bytes inside one connection; application sequence numbers usually order messages in a protocol-defined stream and support business-level recovery.

A useful state machine is explicit:

```text
Disconnected -> TransportUp -> Authenticating -> Active
     ^               |              |              |
     |               +----fail------+----reject----+
     |                                             |
     +------------- Recovering <----gap------------+
                           |
                           +----checkpoint/replay--> Active
```

Transitions should have one owner. A single session thread can update sequence, heartbeat, and socket state without locks, while other threads submit commands through bounded queues. If several threads mutate the state, every transition needs synchronization and a rule for ordering concurrent disconnect, timeout, and message events.

Session state consumes memory beyond a few counters. Resend logs, credentials, negotiated dictionaries, timers, outstanding requests, and diagnostic history can dominate the footprint. Allocate and validate these resources before entering the active state. A reconnect path that first allocates a large replay buffer during an outage adds allocator and page-fault variance to an already stressed path.

Latency analysis must include the slow transitions, not just Active-to-Active messages. Authentication can involve cryptography or remote services. Recovery can burst historical data. Logout can flush persistent state. A system that is fast only after a clean startup is not operationally low latency.

Keep normal and recovery metrics separate. Combining them into one average hides both the steady-state budget and the operational time needed to restore trustworthy state.

Define the session contract as a table of events, allowed states, outputs, and durable updates. Then test every transition, including repeated, delayed, and reordered control events. Logs can record state-transition IDs and sequence values in a fixed binary format; formatting them synchronously inside the state machine risks changing the failure it is meant to explain.

## 30.2 Authentication, Heartbeats, Checkpoints, and Recovery

**Authentication** binds a connection or session to an identity; **heartbeats** provide protocol-level evidence of liveness; **checkpoints** record recovery position. None of the three proves that the peer's business logic is healthy.

Authentication may use a password-equivalent secret, message authentication code, client certificate, token, or venue-specific challenge. Never invent a shortcut for latency. Credentials must be protected at rest and in memory according to the threat model, comparisons should follow the protocol's security requirements, and failures should not leak sensitive detail. Perform expensive certificate or entitlement setup outside the message hot path where the protocol permits, but do not skip validation.

A heartbeat protocol needs at least these decisions:

- which side sends periodic messages;
- whether ordinary traffic counts as activity;
- whether a heartbeat carries a sequence or timestamp;
- how many missed intervals trigger suspicion or disconnect;
- which clock supplies deadlines;
- what happens during recovery or backpressure.

Use a monotonic clock for local deadlines. A heartbeat received late can indicate network delay, scheduler delay, peer overload, or local queueing. It does not identify the cause. Recording receive timestamps at several path locations, as Chapter 33 develops, narrows the diagnosis.

Timer implementation affects predictability. One timer object per session in a general heap may allocate and perform logarithmic insertion/removal; a bounded timer wheel can trade deadline granularity for fixed storage and near-constant bucket work. Whichever mechanism is used, update liveness state in the same serialized session context as message receipt. Otherwise a timer thread can declare the session dead while a newly received heartbeat waits in another queue.

Avoid synchronized heartbeat bursts across many sessions. Fixed periods starting at process launch can align timers, producing short CPU, network, and logging spikes. Protocol rules permitting, distribute scheduling phases while preserving each peer's deadline. A random offset must remain bounded and must never delay a required heartbeat beyond the negotiated interval.

Checkpoints make sequence recovery restartable. A checkpoint can contain the last durably applied inbound sequence, last durably committed outbound sequence, session generation, and a checksum or version. Persistence order matters: acknowledging an operation before the corresponding state is recoverable can create a false success after a crash. The exact durability requirement belongs to the business protocol; `write()` completion alone does not universally mean stable storage.

Do not synchronously persist every sequence value on a latency-critical thread unless the protocol truly requires it. Group commit, append-only logs, replicated state, or a separate persistence stage can move work, but each changes the acknowledged-loss window. State the window explicitly.

Recovery begins from trusted state, not merely the largest observed sequence. Validate checkpoint version and integrity, establish the peer's recovery contract, and bound replay. A long outage may exceed local log retention and require a fresh snapshot. During replay, control whether live traffic is buffered, interleaved, or rejected; otherwise a “catch-up” stream can grow without limit.

Test authentication expiry, heartbeat silence while data continues, stale checkpoints, disk-full conditions, corrupted recovery files, and repeated reconnects. Measure recovery-to-active time and its distribution separately from normal message latency.

## 30.3 FIX Sessions, Resend Requests, and Gap Fills

FIX is a family of tag-value application protocols whose session conventions commonly include logon, logout, heartbeats, test requests, sequence numbers, resend requests, and sequence resets. Exact fields, versions, counterparty rules, and certification requirements vary; an implementation must follow its negotiated FIX specification and bilateral agreement.

A FIX session normally maintains independent inbound and outbound message sequence numbers. If the next inbound application message is greater than expected, the receiver detects a gap and can issue a resend request. A lower-than-expected sequence can be a legitimate replay marked according to protocol rules or an error. Never classify it using sequence alone.

```text
expected inbound: 105
received:         108
action:           request 105..107, enter recovery policy
later:            replay application messages or gap-fill administrative range
```

A **gap fill** advances sequence state over messages that are not replayed, often administrative messages or entries governed by the session policy. It is not permission to ignore missing business messages. Sequence-reset handling is security- and correctness-sensitive because an invalid reset can conceal loss or move the receiver backward.

FIX's textual representation makes parsing work visible. A parser finds delimiters, recognizes numeric tags, validates required fields and checksum framing, and converts decimal values. General streams, locale-aware number conversion, `std::string` construction, and associative lookup can allocate or branch heavily. A bounded parser can scan a `std::span<const std::byte>`, dispatch common numeric tags through a generated or hand-validated table, and expose non-owning field views for the duration of the input buffer.

Session and application messages must remain distinct. A resend request is session control; a new order is business intent. During recovery, a state machine may accept heartbeats while delaying new application messages. The rules must specify which messages can cross the recovery boundary.

Outbound replay requires a journal indexed by application sequence. Storing rendered wire bytes can reduce replay serialization cost but increases storage and binds records to a protocol/version context. Storing normalized messages enables re-rendering but adds CPU work and risks producing bytes that differ from the original. The counterparty's requirements decide.

Verify with transcript-driven tests: logon negotiation, duplicates, too-low and too-high sequences, open-ended resend ranges, gap fills, corrupted framing, logout during recovery, and crash restart. FIX engines should also be tested against certified counterparty behavior; a locally plausible interpretation is not a venue contract.

## 30.4 Exchange Session Establishment and Failover

An **exchange session** is a venue-defined state machine that authorizes access to order entry, market data, or recovery services. Binary protocols often reduce normal-message overhead, but establishment may still include TCP or TLS setup, credentials, version negotiation, sequence exchange, session selection, and throttling parameters.

Separate endpoint reachability from session readiness. A successful `connect()` only establishes a transport. The application becomes active after all required logon responses, capability checks, sequence reconciliation, and warmup policy complete.

Primary/backup endpoints create several state questions:

- Are both transports connected concurrently?
- May both sessions be active, or is one standby?
- Is outbound sequence state shared across endpoints?
- Can unacknowledged orders be replayed after failover?
- How are late messages from the old generation rejected?
- Which endpoint owns cancel-on-disconnect behavior?

These answers are venue-specific. Sending the same order automatically to a backup can create a duplicate order unless the protocol provides an idempotent key and explicitly supports replay. Conversely, refusing all recovery may leave unknown live orders. The safe behavior comes from protocol semantics and risk policy, not a generic networking recipe.

Attach a monotonically increasing local connection generation to internal events. When a socket is replaced, callbacks and queued messages tagged with an older generation can be discarded before they mutate active state. The generation does not replace venue sequence or order identifiers; it prevents local lifecycle races.

Failover also changes topology. The backup address may take a different route, land on a different NIC queue, or have colder ARP/neighbor, TLS, code, and data state. Keeping a standby connection warm can reduce setup work but consumes venue sessions and local resources and may be prohibited. Confirm policy.

Measure establishment by phase: name/config lookup if any, route and neighbor readiness, transport handshake, TLS, authentication, sequence reconciliation, recovery, and application-ready acknowledgement. A single “reconnect time” obscures the actionable component.

Failure injection should close connections at every transition and delay or duplicate establishment responses. Test simultaneous endpoint reachability, split-brain local control, stale DNS or configuration, expired credentials, sequence disagreement, and failback to the preferred endpoint. Failover is a correctness feature with latency consequences.

## 30.5 Reconnection, Replay, and Duplicate Suppression

**Reconnection** creates a new transport after failure; **replay** retransmits historical application events; **duplicate suppression** prevents a previously applied event from being applied again. Together they implement at-least-once delivery without double effects when the protocol supplies a stable identity.

Exactly-once delivery is not obtained by naming a queue or setting a flag. A sender can lose the connection after the peer commits an order but before the acknowledgement returns. On reconnect, the sender sees an unknown outcome. Resolution requires a protocol-level identifier, query/reconciliation mechanism, or a policy that treats uncertainty explicitly.

Sequence numbers suppress duplicates only within their defined domain. The key might include venue, session, partition, stream, generation, and sequence. Using one global “largest seen” value can discard valid messages from another partition. For commands, a client order ID may identify intent across a reconnect; its uniqueness and reuse window must follow venue rules.

A fixed-size duplicate window can use a base sequence plus a bitmap when bounded reordering is permitted:

```text
base sequence: 1000
bitmap:        10110100...
meaning:       seen state for a bounded range above base
```

Sliding the window is fixed work if implemented carefully. A message older than the retained base needs an explicit policy: reject as stale, consult durable history, or begin reconciliation. A hash set of every historical ID grows without bound and can allocate during recovery.

Replay can overwhelm the normal path. Historical data arrives faster than live rate because it is read and sent in batches. Limit replay bandwidth or process it in a dedicated stage, while ensuring live and replay ordering remains valid. Recovery queues need fixed capacity and a full policy; otherwise an outage converts into memory exhaustion.

Backoff reconnect attempts to avoid synchronized storms, but include a cap and operational visibility. Random jitter spreads many clients; it is not a security primitive or a correctness guarantee. A protocol-defined minimum retry interval overrides a locally preferred latency.

Verify duplicates at every boundary: before and after durable commit, after acknowledgement generation, during failover, and after process restart. Track counts of detected gaps, replayed messages, suppressed duplicates, unknown outcomes, and exhausted recovery windows. Counters should be per domain so aggregation does not hide one broken stream.

## 30.6 Framing, Byte Order, Encoding, and Schema Evolution

**Framing** identifies message boundaries; **byte order** defines the order of bytes inside multibyte fields; **encoding** maps bytes to values or characters. A correct parser establishes all three before reading business fields.

TCP supplies a byte stream, so applications commonly use a fixed header containing a length and type, a delimiter scheme, or a self-describing encoding. UDP preserves datagram boundaries, but one datagram can still contain multiple messages or fragments according to the application protocol.

A compact illustrative header might be:

```text
offset  size  field
0       2     total_length, big-endian
2       1     message_type
3       1     schema_version
4       4     stream_sequence, big-endian
8       ...   payload
```

The wire layout is a protocol contract, not a C++ struct layout. C++ structs can contain padding, use host byte order, and require alignment. Never `reinterpret_cast` untrusted bytes to a wire struct and dereference it unless a carefully specified representation and lifetime design proves that operation valid.

Length validation must precede field access. Convert from wire order only after confirming that the length bytes exist, then validate minimum, maximum, and type-specific size. Beware arithmetic wraparound in `offset + length`; use `length <= buffer.size() - offset` after proving `offset <= buffer.size()`.

Text encoding matters even in mostly binary systems. Identifiers may be ASCII, UTF-8, fixed padded bytes, or a venue-defined restricted character set. Case folding, normalization, and locale transformations are not free and may change identity. Treat fields as opaque bytes unless the protocol requires textual interpretation.

Schema evolution needs a compatibility rule. Common approaches include versioned whole messages, template IDs plus schema versions, fixed prefixes with appended optional fields, and tagged fields. A newer sender must know whether an older receiver rejects, truncates, or safely ignores additions. Reusing a field or enum value with new meaning is especially dangerous.

Generated codecs can make offsets and version rules consistent, but generated code still needs bounds validation, compiler/version control, and code-size review. Many message specializations can expand the instruction footprint. Keep rare versions off the primary dispatch path where possible, without making them untestable.

## 30.7 Fixed-Layout Binary Versus Text Protocols

A **fixed-layout binary protocol** places fields at predetermined byte offsets and widths. A **text protocol** represents fields with characters and delimiters or names. Neither is automatically superior; semantics, compatibility, tooling, and traffic shape determine the trade.

| Property | Fixed-layout binary | Delimited/tagged text |
|---|---|---|
| Field location | Constant offset after type/version | Scan and recognize delimiters/tags |
| Numeric conversion | Endian load and integer transform | Digit parsing and validation |
| Wire size | Usually compact | Usually larger |
| Evolution | Requires version/layout discipline | Unknown tags can often be skipped |
| Human inspection | Needs decoder | Often readable |
| Code footprint | Per-template decoders | Generic scanner plus dispatch |

Binary decoding can be extremely regular: validate length, dispatch type, load fields, convert byte order. Variable-length fields and optional groups reintroduce loops and branches. Text scanning can be fast with bounded `from_chars`-style conversion and integer tag dispatch; it need not allocate a `std::string` per field.

Wire size affects serialization delay, link and PCIe bandwidth, socket buffers, and cache footprint. Packet rate can dominate byte rate for small messages because each packet pays descriptors, headers, routing, and queue operations. Packing multiple messages reduces per-packet work but adds batch delay and couples their fate under loss.

Text's operational readability is valuable during certification and incidents, but synchronous formatting/parsing through iostreams adds locale machinery and often allocation. Capture bounded raw frames and decode them outside the critical process instead.

Binary layouts can tempt unsafe struct overlays. The safe performance comparison must include bounds checks and endian conversion for both designs. Benchmarking unchecked binary access against validated text measures different correctness.

Schema and tooling costs matter. A compact protocol with poorly controlled generated code may be harder to evolve than a larger tagged one. Conversely, a fixed venue protocol with certified templates may make generic self-description wasted work. Treat protocol selection as a system interface decision, not a microbenchmark contest.

Measure bytes per useful message, instructions and branches per decoded field, code size, allocations, cache misses, and rejection-path work. Include malformed and uncommon messages because unpredictable validation branches can dominate tails during incidents.

## 30.8 Alignment-Safe, Bounds-Checked Decoding

An **alignment-safe decoder** reads wire bytes without assuming that their address satisfies a C++ object's alignment. A **bounds-checked decoder** proves every read lies inside the supplied buffer before performing it.

C++20 `std::span` expresses a borrowed contiguous buffer. `std::memcpy` into an integer is a portable way to load possibly unaligned bytes; compilers commonly optimize a small fixed-size copy into an unaligned-capable load where the target allows it.

```cpp
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>

std::optional<std::uint32_t>
read_be_u32(std::span<const std::byte> bytes, std::size_t offset) noexcept {
    if (offset > bytes.size() || sizeof(std::uint32_t) > bytes.size() - offset) {
        return std::nullopt;
    }

    std::uint32_t value;
    std::memcpy(&value, bytes.data() + offset, sizeof(value));
    if constexpr (std::endian::native == std::endian::little) {
        value = std::byteswap(value); // C++23
    } else if constexpr (std::endian::native != std::endian::big) {
        return std::nullopt;
    }
    return value;
}
```

The subtraction form avoids an overflowing `offset + sizeof(value)`. `bytes.data() + offset` is formed only after `offset <= size`. The function neither allocates nor throws in normal C++ library implementations, and `optional<uint32_t>` is normally returned in registers under common ABIs, but these representation details are not language guarantees.

For a whole message, validate the common header once, then pass a narrowed payload span to a type-specific decoder. This makes each decoder's bounds relative to its declared message, not to a large receive buffer that may contain following messages.

Unchecked pointer casts can violate alignment, lifetime, aliasing, and representation rules. x86-64 supports many unaligned integer loads, but that hardware capability does not legalize undefined C++. Some ARM64 loads also support unaligned addresses, with instruction and mapping caveats. Portable source plus optimized assembly gives both correctness and speed.

Validation must cover semantic bounds too: enum domain, price and quantity range, count × element-size overflow, nested group depth, and duplicate required fields. Put an explicit maximum on loops driven by wire counts. Rejecting malformed input should take bounded work and must not allocate an error string on the hot path.

Fuzz type-specific decoders and run them under AddressSanitizer and UndefinedBehaviorSanitizer. Keep corpus cases for minimum and maximum lengths, every truncation point, endian patterns, oversized counts, and unknown versions. Inspect optimized assembly to ensure small loads are efficient rather than deleting safety checks blindly.

## 30.9 Compression, Encryption, and TLS Concepts

**Compression** trades CPU and state for fewer transmitted bytes. **Encryption** protects confidentiality; authenticated encryption also protects integrity and authenticity under a cryptographic protocol. TLS combines record protection with handshake, identity, and key-management machinery.

Compression latency depends on algorithm, level, input entropy, dictionary state, block size, and implementation. Highly compressible recovery snapshots may benefit; tiny order messages often cannot amortize headers and setup. Decompression expands the working set and can create output bursts that overwhelm downstream queues even when the compressed input rate looks modest.

Variable data produces variable work. A ratio quoted from one day's market data does not establish a tail bound. Benchmark representative normal, open/close burst, and adversarial low-compressibility data. Bound both compressed input and decompressed output before allocating or writing.

TLS protects a byte stream as records. Common implementations maintain connection state, authenticate records, decrypt, and copy or expose plaintext according to the API. Handshakes can include public-key operations, certificate-chain validation, randomness, and network round trips; resumed sessions may reduce some work but follow library and peer policy.

Hardware instructions can accelerate standard cryptographic primitives, but “hardware accelerated” does not mean free or constant latency. Key schedule, record framing, authentication tags, cache footprint, library dispatch, and copies remain. Dedicated accelerators can add queueing and DMA. Measure on the exact CPU, library build, cipher suite, and record size.

Do not disable certificate validation, downgrade algorithms, reuse nonces incorrectly, or invent encryption for latency. Use maintained cryptographic libraries and protocol configurations approved by the organization and counterparty. Security properties are part of correctness.

TLS record boundaries do not preserve application message boundaries. A read can return partial or multiple records' plaintext depending on the API, and one application message can span records. The framing state machine from Section 30.6 still applies.

Operational verification includes library/version inventory, certificate expiry monitoring, failed-handshake reasons, resumed/full handshake counts, record sizes, and encryption CPU. Keep secrets out of packet captures and logs. Compare end-to-end latency with the same security semantics; plaintext and authenticated encryption are not interchangeable benchmarks.

## 30.10 Request/Reply, Streaming, and Publish/Subscribe

An application interaction model determines who initiates work and how responses relate to requests. **Request/reply** correlates one request with a response. **Streaming** delivers an ordered or partially ordered sequence over time. **Publish/subscribe** distributes messages by topic or feed without a per-message response from every subscriber.

Familiar protocols illustrate how layers combine rather than occupy clean boxes. DNS commonly uses request/reply over UDP or TCP and can delay initial endpoint resolution. DHCP establishes host configuration. HTTP uses request/response and streaming over its selected transport; TLS can protect it. SSH combines authentication, encryption, multiplexed channels, and a long-lived session. NTP and PTP management traffic supports clock operation, while monitoring protocols export health and counters. These protocols matter to a trading system's control plane even when they do not carry orders.

Keep control-plane dependencies out of the per-message critical path where architecture permits. Resolve and validate endpoint configuration before activation, maintain authenticated management connections separately, and export monitoring asynchronously. This does not mean ignoring failures: expired DNS records, unavailable authentication, clock alarms, and monitoring backpressure need explicit state transitions. It means an order parser should not perform a DNS query or synchronous metrics request.

Protocol names do not determine one cost. DNS can hit a local cache or wait on recursive resolution; HTTP can reuse a connection or establish several handshakes; monitoring can update a per-thread counter or synchronously serialize a large document. Analyze the actual deployment path, its caches, allocations, security, queues, and timeouts.

Request/reply needs a correlation identifier, timeout, duplicate policy, and maximum outstanding count. A synchronous call serializes on one round trip. Pipelining several requests increases throughput but requires storage for outstanding state and can deliver responses out of order if the protocol permits.

Streaming preserves context and amortizes setup. TCP streams inherit head-of-line blocking; UDP-based streams require application loss and ordering policy. A slow consumer needs backpressure, dropping, disconnection, or independent buffering. “Keep reading later” is not a capacity plan.

Publish/subscribe scales distribution but changes recovery. A publisher normally cannot await every subscriber. Sequence numbers and snapshots let subscribers detect and repair gaps. Topic filters can reduce traffic but add classification state at publishers, brokers, switches, NICs, or consumers depending on the design.

Message buses may add brokers, durable logs, acknowledgements, replication, and consumer offsets. These features improve decoupling and recovery while adding hops, copies, queues, and tail modes. They often belong off the direct order-entry critical path while remaining useful for risk distribution, telemetry, and persistence.

Correlation state needs careful expiration. A response can arrive after its request timed out and its table slot was reused. Pair identifiers with a generation or make reuse impossible within the maximum response lifetime. Removing a timeout entry must coordinate with the receive path; otherwise a late callback can access freed storage. A bounded timer wheel can make expiration work predictable when deadline granularity permits, while a general heap gives logarithmic operations and may allocate unless reserved.

Streaming and publish/subscribe also need fairness. Processing an unbounded burst from one stream can starve session heartbeats or another partition. Limit messages or bytes per turn and return to the event loop. This increases the time to drain a burst but bounds interference with control traffic. Report both stream backlog and event age so fairness is visible.

Model memory explicitly. An outstanding request table has a fixed maximum and timeout cleanup. A stream decoder owns partial-frame bytes. A subscriber queue has a capacity and overflow policy. If correlation keys or topic names allocate on each message, pre-intern or use bounded representations where semantics permit.

Verify under delayed replies, duplicated responses, publisher restart, subscriber pause, topic churn, and queue saturation. Report latency from the appropriate semantic points—for example, client send to accepted reply, or NIC receive to applied market-data sequence—not merely function entry to queue insertion.

## 30.11 Binary Order-Entry and Multicast Market-Data Protocols

Binary trading protocols are specialized application state machines. **Order-entry protocols** carry commands and acknowledgements, commonly over a reliable session. **Multicast market-data protocols** distribute one-way updates efficiently to many receivers and commonly provide separate recovery facilities. Venue specifications govern every actual field and transition.

An order-entry message may contain a type, length, client token, instrument, side, price in ticks, quantity, and time-in-force. The acknowledgement may assign a venue order ID or reject with a reason. A compact wire layout reduces parsing work but does not remove semantic validation, session sequencing, throttles, or unknown-outcome handling.

Order identifiers have lifetimes and namespaces. A client token convenient for local correlation may not be the identifier used for later cancel/replace. Keep types distinct in C++ so they cannot be accidentally interchanged. Fixed-width wrappers can be zero-overhead after optimization while making invalid calls fail at compile time.

Multicast data often divides instruments among channels or partitions and numbers packets or messages per stream. UDP can lose, duplicate, and reorder, so the consumer must detect gaps and decide whether to arbitrate a redundant feed, request retransmission, or rebuild from a snapshot.

Packet-level and message-level sequences answer different questions. One packet can contain several messages; a packet gap may cover a range. A heartbeat packet may advance one sequence domain but not the book's update sequence. Implement exactly the domains described by the feed specification.

Parsing should publish validated normalized events into a bounded downstream interface. Avoid passing venue wire structs throughout the strategy: doing so couples the whole system to packing, endian, schema, and buffer lifetime. Normalization costs a copy of selected fields, but creates stable internal types and releases receive buffers promptly.

Test protocol transcripts against venue certification cases where available. Add local cases for truncation, unknown type/version, stale sequence, duplicate token, reject bursts, recovery overlap, and channel reset. Do not infer proprietary protocol behavior from another venue's similarly named message.

## 30.12 Snapshots Plus Incrementals

A **snapshot** describes state at a declared synchronization point. **Incrementals** describe changes after that point. Combining them lets a receiver initialize or repair state without replaying all history.

The central rule is that snapshot and incremental sequence domains must be reconciled according to the protocol. A typical abstract process is:

```text
1. buffer bounded live incrementals
2. acquire snapshot with reference sequence S
3. validate and install snapshot
4. discard buffered updates at or before S
5. apply contiguous updates after S
6. enter live state
```

This is a pattern, not a universal venue algorithm. Some feeds publish snapshots cyclically on multicast; others provide request-based images, per-instrument checkpoints, or recovery retransmissions. The reference sequence may be a packet, message, or instrument sequence.

The buffer between starting recovery and installing the snapshot must be bounded. If it fills, restart recovery, drop the instrument, or escalate according to policy. Applying partial state while claiming the book is live is worse than declaring it unavailable.

Snapshots need internal validation: record counts, duplicate keys, crossed or otherwise invalid book conditions according to venue rules, checksums where provided, and complete termination. Build into inactive storage, then atomically or single-threadedly swap the completed state into service. This avoids readers observing a half-built image.

Large snapshots touch many pages and cache lines. Preallocate both active and staging state where feasible. Recovery can evict the hot live working set, so isolate it by core or time budget when the architecture allows. That isolation still shares LLC and memory bandwidth.

Incrementals arriving after snapshot installation must remain contiguous. A second gap immediately returns the receiver to recovery; do not silently continue from a plausible-looking state. Expose per-instrument or per-channel validity so strategies and risk checks can reject stale input.

Verification should inject a gap at every buffer position, snapshot delay, duplicated and reordered incrementals, invalid images, buffer overflow, and a second gap during catch-up. Measure time unavailable, maximum buffered updates, recovery CPU, and impact on unaffected streams.

## 30.13 Zero-Copy Views and Buffer Lifetime

A **zero-copy view** refers to bytes owned elsewhere instead of owning a duplicate. `std::span` and `std::string_view` are C++ vocabulary types for such views; neither extends the source lifetime.

```cpp
#include <cstddef>
#include <span>

struct NewOrderView {
    std::span<const std::byte> client_token;
    std::span<const std::byte> symbol;
};
```

The object contains pointer-and-length-like state, not the bytes. If it points into a socket read buffer, ring slot, packet buffer, or TLS plaintext buffer, it becomes invalid when that storage is reused or returned. Moving the view does not move the data.

Zero-copy parsing is effective when validation and consumption finish inside the buffer's ownership window. It becomes dangerous when views cross an asynchronous queue. The producer may recycle the slot before the consumer reads it. Solutions include copying normalized fields into an owning event, transferring unique buffer ownership, reference-counting buffers, or using a ring protocol that prevents reuse until consumption.

Each solution has cost. Copying a small fixed record can be cheaper than reference-count contention and scattered reads. Unique ownership constrains fan-out. Reference counts write shared metadata and delay reclamation. Holding ring slots can backpressure the NIC or socket path.

Views also need validity rules beyond lifetime. They may point to untrusted encoded text without a terminator, and they can be invalidated by vector growth, buffer compaction, or decryption into a new record. Name types according to their borrowed nature and avoid storing them in long-lived domain objects.

An arena tied to a batch can provide a middle ground: copy variable fields once into batch-owned storage, process all events, then reset the arena. The batch lifetime must be explicit, and reset must wait for all consumers. Batching adds queueing delay, so size it from latency requirements.

Use sanitizers and ownership tests that recycle buffers immediately after callback return. Poison freed or recycled test buffers to expose escaped views. Code review should trace the owner from DMA or `recv` through parsing, queues, consumers, and reuse.

## 30.14 Fixed Offsets, Lookup Tables, and Allocation-Free Parsing

An **allocation-free parser** uses caller-owned or fixed storage for all normal inputs. It does not merely avoid `new` in the top-level function; callbacks, logging, error construction, containers, locale, and code-generated helpers must also be checked.

Fixed-layout messages permit fixed offsets after one type/version/length check. Load only fields required by the current stage. A risk gate may need token, instrument, side, price, and quantity but not a display name. Deferred decoding reduces work and cache footprint if the source buffer remains valid.

Lookup tables turn bounded codes into direct indexes:

```cpp
#include <array>
#include <cstdint>
#include <optional>

enum class Side : std::uint8_t { buy, sell };

constexpr std::array<std::optional<Side>, 256> make_side_table() {
    std::array<std::optional<Side>, 256> table{};
    table[static_cast<unsigned>('B')] = Side::buy;
    table[static_cast<unsigned>('S')] = Side::sell;
    return table;
}

inline constexpr auto side_table = make_side_table();
```

The 256-entry table has a fixed data footprint and removes a search, but a two-case branch may be smaller and equally predictable. Inspect code and measure representative symbol distributions. Tables indexed by wire values must cover the entire index domain before access.

For text tags, parse digits with overflow checks and dispatch common tags through a `switch` or bounded table. `std::from_chars` avoids locale and allocation, but library performance and supported conversions vary. Confirm it consumed exactly the intended field and reject trailing junk.

Error reporting should use a compact code plus byte offset and message type. Formatting a descriptive string belongs off-path. Keep counters bounded by known error categories; using the raw invalid tag as a map key creates attacker-controlled allocation.

Batch parsing can amortize system calls and dispatch, expose vectorization, and improve instruction locality. It also delays the earliest message and can produce large bursts into downstream queues. Cap messages or bytes per batch and return to other work fairly.

Verify allocation freedom with an instrumented allocator in tests and with representative error paths. Check optimized assembly for fixed loads and byte swaps, and measure branches, instructions, code footprint, and cache misses. Allocation-free is a useful property only after correctness and bounded loop work are established.

## 30.15 Application Queues, Logging, Recovery, and Backpressure

The application protocol ends not at the parser but where its effects are accepted. **Backpressure** is the policy by which a slow downstream stage limits, rejects, drops, or otherwise influences upstream work.

A typical receive path contains several queues:

```text
NIC -> kernel socket -> user receive batch -> parser -> normalized-event queue
    -> book/risk state -> strategy queue -> outbound session -> socket
```

Every queue stores memory and delay. Increasing all capacities can prevent immediate drops while making stale data wait longer and consuming more pages. For market data, processing a deep backlog may be worse than declaring a gap and recovering. For order acknowledgements, dropping can make state unknowable and usually demands disconnect or fail-safe handling.

Assign each queue a semantic overflow policy: block producer, reject new work, drop newest, overwrite oldest, disconnect, recover, or terminate safely. “Should never fill” is not a policy. The choice differs by message class; heartbeats and session control may need reserved capacity so data bursts cannot prevent liveness handling.

Logging on the protocol thread can format strings, acquire locks, fault pages, and write to storage. Prefer fixed binary events in a preallocated per-thread ring, with an explicit overwrite or drop policy. Log state transitions, sequence domains, compact error codes, and connection generations. Never log secrets or full sensitive payloads by default.

Recovery traffic needs its own admission controls. It can consume network, parser, journal, and book capacity exactly when live queues are stressed. Rate limits or separate lanes protect live control messages, but ordering rules must remain valid.

Measure queue residence time, not only depth. Timestamping at each boundary can reveal where an end-to-end tail formed, but clocks and instrumentation cost need calibration. Track high-water marks, overflow counts, time invalid, replay volume, and oldest-item age.

Test the complete degraded path: slow consumer, logger stall, journal stall, replay burst, invalid-message storm, and downstream disconnect. A protocol implementation is predictable only when overload changes state deliberately rather than through incidental allocation, blocking, or memory exhaustion.

## 30.16 Interview Check

1. Distinguish a TCP connection from an application session. Which state can survive reconnection?
2. Why does a heartbeat establish only limited evidence of health, and which clock should drive its local deadline?
3. Explain the roles of FIX resend requests and gap fills without assuming that every missing application message may be skipped.
4. An order acknowledgement is lost immediately after the venue commits the order. Why can reconnect and replay not manufacture exactly-once behavior without protocol support?
5. Compare fixed-layout binary and tag-value text formats in parsing work, wire footprint, evolution, and operational tooling.
6. Identify the alignment, lifetime, bounds, and endian errors in a decoder that casts a receive-buffer pointer to a packed C++ struct.
7. Why can compression reduce link bytes while increasing downstream tail latency?
8. Design a bounded snapshot-plus-incremental recovery flow and state what happens if its live-update buffer fills.
9. When is copying a normalized record preferable to sending a zero-copy view across a queue?
10. For market data, order acknowledgements, and logs, propose distinct queue-overflow policies and justify their correctness consequences.
