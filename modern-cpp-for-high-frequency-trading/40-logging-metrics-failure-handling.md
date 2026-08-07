# Chapter 40 — Logging, Metrics, and Failure Handling

Observability is part of a production trading system, but observation performs work: it formats values, moves bytes, updates shared state, enters the kernel, and sometimes waits behind storage or a reader. Removing diagnostics makes failures unexplainable; placing unbounded diagnostics on the critical path creates the failures being measured. This chapter builds bounded logging and metric paths, then connects application events to kernel, NIC, and network evidence without pretending that timestamps from different clocks are directly comparable.

## 40.1 Formatting, Locale, Allocation, Locks, and I/O

A log call is a pipeline, not one operation. It selects fields, converts values to text, obtains storage, serializes with other writers, and transfers bytes to a sink. Each stage has distinct latency and failure behavior.

```text
arguments -> format parsing -> numeric conversion -> buffer growth
          -> logger lock/queue -> stdio or write -> kernel buffers
          -> filesystem/socket/collector -> durable or indexed record
```

Integer conversion is usually bounded by digit count, but floating-point formatting can execute substantially more logic. Timestamps, time zones, locale-aware punctuation, source names, and escaped text add branches and table access. Building a `std::string` can allocate; concatenation can allocate repeatedly. A stream can use locale facets and internal synchronization. A file write can block on dirty-page throttling, filesystem behavior, or a full pipe.

```cpp
// BROKEN for a strict hot path: hidden allocation and synchronous stream work.
std::cerr << "gap venue=" << venue
          << " expected=" << expected
          << " received=" << received << '\n';
```

C++ guarantees the library's observable formatting and I/O behavior, not a lock, allocation count, syscall count, or buffer size. A standard-library implementation may retain locale objects, buffer output, or combine operations. Linux adds page cache, pipe capacity, scheduler, and device paths below the language interface.

Disabled logs can still perform work if arguments are evaluated before the logger checks severity:

```cpp
// expensive_snapshot() runs before log_debug can decide to discard it.
log_debug("book={}", expensive_snapshot());
```

A lazy logging API, macro guarded without double evaluation, or explicit `if (debug_enabled())` can prevent that work. The guard itself can add a branch and shared configuration read. For rare disabled levels this is normally predictable; confirm it in assembly when it sits inside the message loop.

Locale is especially easy to invoke accidentally through iostreams or locale-aware formatting. A fixed protocol log should use an explicit locale-independent representation. Human display can localize after ingestion. Decimal prices should normally be rendered from their integer tick representation rather than converted through floating point.

Text fields also create correctness and security work. Newlines, control bytes, delimiters, and invalid encodings can forge apparent records or break downstream parsing. Escape or length-prefix untrusted fields and cap their size. Redact credentials before formatting because removing them at the collector is too late: they have already crossed queues, files, and crash buffers.

Severity selection must not change program semantics. A call used for a side effect—such as incrementing inside a formatting argument—creates build- and configuration-dependent behavior. Logs observe state; they do not own state transitions.

Measure formatting separately from enqueue and sink I/O. Instrument allocations, inspect lock contention, count syscalls with `strace -c` in a lab, and record write latency distributions. A benchmark writing to `/dev/null` measures conversion and syscall work, not the production collector or storage path.

## 40.2 C++23 `std::print` and Formatting Costs

C++23 `std::print` writes formatted output using the standard formatting machinery. It improves type safety and concision over printf-style varargs, but it does not make formatting or I/O free.

```cpp
#include <cstdint>
#include <print>

void report_gap(std::uint32_t channel,
                std::uint64_t expected,
                std::uint64_t received) {
    std::println("gap channel={} expected={} received={}",
                 channel, expected, received);
}
```

The literal format string can be checked at compile time through the formatting interface. Argument conversion still occurs at runtime, and the destination still has synchronization and I/O semantics. Dynamic format strings require runtime handling through the appropriate APIs and broaden error paths.

`std::print` and `std::println` were standardized in C++23, but compiler support alone is insufficient: the selected standard library must provide `<print>`, and implementations have differed in rollout. Check `__cpp_lib_print` and a configure-time compile/link test. Do not silently replace a missing facility with a semantically different logger.

Printing to a `FILE*` can interact with C stream buffering and locking. Terminal handling and Unicode requirements may choose implementation-specific paths. None of these functions provides a bounded, nonblocking hot-path contract.

Formatting can fail. Invalid dynamic format input, allocation failure, and output errors have library-specified reporting paths that are not `noexcept` hot-path contracts. A logging call from a destructor during unwinding must not let another exception escape. Prefer compile-time format strings, preallocated buffers, and an explicit “diagnostic unavailable” policy over wrapping an unbounded print in a catch-all block.

Custom formatter specializations execute application code. They can allocate, take locks, traverse containers, or call logging recursively. Review them as critical-path functions rather than assuming the standard formatting front end constrains their work. A formatter for an order book should accept a bounded summary, not discover at runtime how many levels to print.

Prefer formatting into caller-owned fixed storage when a textual record must be prepared synchronously and the worst-case encoded size is known. Handle “buffer too small” explicitly; truncating an order ID or error category can make a record misleading. Better still, enqueue typed fields and format on a consumer as Section 40.5 describes.

Verify generated code and allocations for the deployed library version. Compare `std::print`, `std::format_to_n`, `std::to_chars`, and the existing logging library using identical fields and sinks. Report record size and overflow behavior along with latency.

## 40.3 Asynchronous Logging Queues

An **asynchronous logger** separates event production from formatting or I/O with a queue and consumer. It moves work off the producer but does not remove it. The queue transfers ownership and introduces capacity, synchronization, wakeup, and shutdown questions.

```text
critical thread -> bounded event queue -> logger thread -> sink
                        |
                        +-- full: drop/sample/overwrite/escalate
```

An SPSC ring is attractive when one producer owns one queue. Multiple producers can use per-thread rings and one aggregator, avoiding a contended global producer index. An MPSC queue is simpler operationally but can concentrate cache-line ownership and fairness problems.

A queued event must own its payload until consumption. Storing a `std::string_view` into a packet buffer that is recycled after enqueue creates a dangling view. Copy bounded fields, retain a reference-counted buffer with known release cost, or transfer an owning pool handle. Variable-size ownership can allocate and undermine the design.

Queue publication is two-phase. The producer reserves a slot, fills fields, then publishes completion. A consumer that observes the reservation too early can read a torn record. If a producer can be canceled or crash after reservation, the design needs a way to skip or diagnose an abandoned slot; otherwise one dead producer can stop the consumer behind it.

Per-thread rings avoid that global failure mode because a stalled producer blocks only its own stream. The aggregator still needs fair polling so one high-volume thread does not starve quiet but important control events. Round-robin polling, per-ring budgets, and priority classes are policies to test under skewed load.

Wake strategy changes tails. A continuously polling consumer burns a CPU and competes for caches and power. A sleeping consumer needs a notification and scheduler wakeup. Batching amortizes sink overhead but delays individual records. The right point depends on event rate and the maximum acceptable diagnostic lag.

Shutdown must drain or deliberately discard. The consumer may be blocked in storage or a collector. A bounded shutdown defines a deadline, records how many entries remain if possible, and never lets the producer wait indefinitely for logging.

Logger failure must be visible without recursively logging. A health page or atomic status can expose consumer heartbeat, last completed sequence, sink error code, and queue occupancy to an external monitor. Producers can then switch to a minimal flight recorder or increment one fallback counter. They must not synchronously take over sink I/O.

Measure producer enqueue separately from consumer lag, queue occupancy, dropped events, sink latency, and shutdown. A fast enqueue benchmark with an absent consumer proves neither capacity nor end-to-end observability.

## 40.4 Dropping, Sampling, and Overwriting Under Load

When a bounded diagnostic queue is full, the system needs an **overload policy**. Waiting preserves records but adds logger latency to the producer. Dropping, sampling, and overwriting preserve producer progress while losing information in different ways.

Drop-new rejects the current record and retains older context. Drop-old or overwrite keeps recent events but destroys history leading into the incident. Sampling reduces repetitive volume but can miss a rare transition. Blocking is appropriate only outside the critical path or where losing the record is worse than missing the latency objective.

| Policy | Preserves | Loses | Suitable example |
|---|---|---|---|
| drop new | earlier causal history | newest state | bounded audit preview, with counters |
| overwrite old | latest state | lead-up history | rolling flight recorder |
| deterministic sampling | representative recurring events | exact multiplicity | high-rate health events |
| rate limiting | bounded output rate | burst detail | repeated identical warning |
| block | every accepted record | latency bound | cold administrative path only |

Every loss policy needs loss telemetry that does not recurse through the same full queue. A per-thread counter can record dropped events; a later summary reports count, first/last sequence, and time range. Saturate or widen the counter so its own wrap does not conceal overload.

Probabilistic sampling needs a defined random source and inclusion probability if counts will be estimated. Deterministic “one of every N” sampling is cheap and reproducible but aliases with periodic events. Token-bucket rate limiting preserves bounded bursts and long-term rate; its clock read and shared state still cost work. Per-thread token buckets reduce contention but make the total fleet rate a sum of local limits.

Overwriting requires reader/writer versioning. A reader can begin copying an old slot while the producer wraps and overwrites it. Sequence-before/sequence-after validation or an equivalent publication scheme detects this race. A checksum alone detects some torn records but does not establish C++ synchronization.

Sampling must preserve security and correctness signals. Never sample away authentication failures, risk-limit transitions, or the first occurrence of a novel parser error without another durable mechanism. Deduplicate only with a key that captures meaningful distinctions.

Test overload by stopping the consumer and driving producers beyond capacity. Verify bounded enqueue work, correct counters, record integrity after wrap, and recovery when the consumer returns. Slow disks and collectors are normal failure modes, not exceptional test conditions.

## 40.5 Binary Events and Per-Thread Buffers

A **binary event** stores typed fields in a compact internal schema instead of human-readable text. It avoids hot-path formatting and can have a fixed maximum size, but requires versioned decoding and careful byte representation.

```cpp
#include <cstdint>
#include <type_traits>

struct GapEvent {
    std::uint64_t monotonic_ns;
    std::uint64_t expected;
    std::uint64_t received;
    std::uint32_t channel;
    std::uint16_t schema_version;
    std::uint16_t type;
};

static_assert(std::is_trivially_copyable_v<GapEvent>);
```

Trivially copyable does not define a portable file or network format. Padding, endianness, and schema evolution still need contracts. Encode fields explicitly for long-lived interchange. A process-local flight recorder can use an ABI-specific layout if the build ID, architecture, and decoder are recorded together.

Per-thread rings eliminate producer-producer contention. Each producer advances its own sequence; a consumer merges streams by timestamps or sequence domains. The buffers multiply memory by thread count and can evict application data, so capacity is a cache and page-budget decision.

Use a publication protocol: fill a slot, then publish its sequence with release semantics; the consumer acquires before reading. Sequence numbers distinguish an unpublished slot from one overwritten after wrap. Do not mark a packed unaligned field atomic or assume x86 tolerates every access portably.

Binary records should carry event type, schema version, clock identity, and enough stable identifiers to correlate without pointer values. Pointers reveal address-space information and become meaningless after exit. Sensitive data needs explicit redaction before it enters a reusable buffer.

Schema evolution needs forward and backward rules. A record header can carry total encoded length so an older decoder skips an unknown type safely. Appending optional fields is simpler than reinterpreting existing ones. Reusing an event number for a new meaning corrupts postmortem analysis even if the byte size matches.

For persistence, write complete blocks with a header, build ID, byte order, schema table version, record count, and integrity check. A crash can leave the final block partial. The offline decoder must stop safely at an incomplete block rather than scanning arbitrary memory as a new header.

Verify the ring with wraparound, producer death mid-record, consumer lag, and decoder version mismatch. Measure producer stores and cache-line ownership, not just serialized bytes per second.

## 40.6 Atomic Versus Per-Thread Metrics

A shared atomic counter gives one immediately readable value but makes all updating CPUs acquire ownership of the same cache line. A **per-thread metric** keeps updates local and aggregates later, trading freshness and memory for lower contention.

```cpp
#include <cstdint>

alignas(64) thread_local std::uint64_t decoded_messages = 0;

void on_message() noexcept {
    ++decoded_messages;
}
```

The `alignas` on a `thread_local` object does not by itself define how all TLS objects are laid out, and 64 is not a universal cache-line size. It expresses an alignment request; verify actual addresses and target interference sizes.

An atomic relaxed increment guarantees atomicity and modification order for that counter, not synchronization of unrelated state. Under contention, the read-modify-write still moves cache-line ownership. A plain per-thread increment can remain in a local cache and may compile to fewer instructions.

Use the weakest ordering that matches semantics. A statistics counter independent of protected data can use relaxed operations. If a metric is also the publication flag for a snapshot, it is no longer “just a metric” and needs the correct release/acquire protocol. Combining observability with control creates coupling that makes both harder to reason about.

Counters wrap. Unsigned modulo subtraction can compute deltas only when the maximum advance between samples is known to be less than the modulus. Process restart also resets counters. Export an instance identifier or start time so a collector distinguishes wrap from restart, and define whether the first sample is a baseline or a delta.

Aggregation needs a lifetime protocol. A registry of pointers into worker TLS can dangle after thread exit. Stable worker slots owned by the process, registered before readiness and retained through join, are easier to scan. Readers must avoid data races: use atomics for concurrently read fields, publish snapshots, or aggregate after quiescence.

Metrics such as “current open orders” may require a coherent gauge rather than a sum of delayed counters. Decide required consistency explicitly. Most throughput counters tolerate a scrape lag; risk state does not become safe merely because it has a metric.

Compare shared atomic and sharded counters at actual producer count, socket topology, and scrape frequency. Hardware counters can expose cache-to-cache transfers; application tests should check aggregation loss at thread shutdown.

## 40.7 False Sharing and Histogram Footprint

**False sharing** occurs when independent fields modified by different CPUs occupy one coherence line. The hardware tracks the line, not C++ objects, so unrelated counters can ping-pong.

```cpp
#include <atomic>
#include <cstddef>
#include <cstdint>

struct alignas(64) CounterSlot {
    std::atomic<std::uint64_t> value{0};
    std::byte padding[64 - sizeof(value)]; // target-specific layout assumption
};
```

This schematic assumes a 64-byte destructive-interference unit and must be guarded by target assertions. `std::hardware_destructive_interference_size` is an implementation-provided constant when available, not a runtime topology query.

Padding every metric prevents one kind of interference while inflating memory. Ten thousand padded counters occupy hundreds of kilobytes rather than one compact array. Larger working sets consume cache and TLB capacity and make scrapes slower. Prefer per-thread structures that group fields written by the same owner, while separating fields with different writers.

Histograms magnify footprint. A per-thread histogram with 4,096 64-bit buckets uses 32 KiB before metadata; multiplying by dozens of workers can displace hot data. Logarithmic buckets, fixed quantization, sketches, or sampled event streams reduce storage with different accuracy guarantees.

Bucket boundaries define accuracy. A histogram cannot later recover detail within one bucket, so choose boundaries around decision thresholds and expected tails. A highest bucket needs explicit overflow semantics. Saturating it says “at least this large”; wrapping it corrupts the distribution.

Measurement methodology matters too. A loop that records latency only after an operation completes can omit requests never issued during a stall—coordinated omission. The histogram implementation cannot repair the workload generator. Use scheduled arrival times or another model that represents demand during pauses, as Chapter 38 explains.

An atomic update in every latency bucket can be worse than a timestamp itself. Update local non-atomic buckets and merge outside the hot path when exact global immediacy is unnecessary. Handle bucket overflow and maximum-range saturation explicitly.

Use `pahole`, `sizeof`, address logging during startup, and cache-line transfer counters to verify layout. Benchmark scrapes too: a monitor scanning megabytes of per-thread histograms can interfere with the same cores it observes.

## 40.8 Exporting Outside the Critical Path

**Export** converts internal observations into a collector's protocol and transmits them. Serialization, compression, TLS, DNS, socket backpressure, and collector retries belong outside the critical path.

A snapshot boundary separates ownership:

```text
worker-local counters -> aggregator snapshot -> exporter-owned batch -> network
```

The aggregator can exchange active and inactive buffers, copy bounded counters, or read atomics. After the snapshot transfer, the exporter must not retain pointers into buffers that workers immediately reuse.

A scrape across independently updated counters is not one instant. `orders_sent` can be sampled before an update and `acks_received` after it, briefly violating an apparent invariant. Options include accepting weakly consistent monitoring, tagging worker snapshots with epochs, or publishing a coherent domain snapshot. Do not add a global lock to obtain cosmetic consistency without considering producer blocking.

Reset-on-scrape complicates failure recovery because a lost export loses the only copy of a delta. Monotonic cumulative counters are easier to retry and deduplicate; local wrap and restart identity still require handling. Histograms can use cumulative buckets or double-buffered interval snapshots according to collector semantics.

Export queues need capacity and loss policy just like log queues. A collector outage must not grow memory without bound. Coalesce gauges to the latest value, retain monotonic counter deltas with sequence numbers where feasible, and cap retry history. Exponential backoff needs jitter and a ceiling; retries can otherwise synchronize across a fleet.

Exported labels are a memory and cardinality risk. Order IDs, arbitrary symbols, client strings, and error text can create unbounded time series. Use bounded enumerations and stable dimensions; put high-cardinality diagnostics in an event system with separate retention policy.

Security is part of export: authenticate the receiver, redact secrets, bound payloads, and define behavior when credentials expire. Certificate refresh or DNS lookup can allocate and block, which reinforces the separation.

Verify by disconnecting the collector, slowing reads, rotating credentials, and exhausting the export queue. Producer latency and memory must stay bounded, and recovery must not create a burst that starves trading work.

## 40.9 C++20 `source_location`

C++20 `std::source_location` captures source file, line, column, and function information at a call site without requiring callers to spell predefined macros at each use.

```cpp
#include <source_location>

// Excerpt: ErrorCode is the application's bounded error enumeration.
void record_error(ErrorCode code,
                  std::source_location where =
                      std::source_location::current());

void decode() {
    record_error(ErrorCode::bad_length); // location is this call site
}
```

`current()` used as a default argument captures the caller's location. Calling it inside the function body captures that body instead. The standard specifies accessors, not the storage layout or whether strings are pooled.

File and function names increase binary data and can disclose build paths or internal symbols. Reproducible-build path mapping and symbol policy should be deliberate. A compact runtime record can store a generated site ID while an offline table maps it to source metadata.

Site IDs need collision control and versioning. Hashing the text of file and line can collide and changes when the source moves. A generated table can assign dense IDs per build, with the build ID selecting the correct map. Preserve that artifact beside debug symbols.

Wrappers should pass `source_location` as a defaulted final parameter or capture it at the macro boundary. If a generic logger constructs a new location internally, every record points to the logging library. Test call sites through templates and inline functions because the useful semantic location may be the wrapper or its caller depending on the API.

Copying a source-location object is commonly cheap, but recording its strings or formatting it is not automatically cheap. Do not construct a `std::string` for every successful packet merely because the source metadata itself is static.

Source locations identify code, not dynamic causality. Include stable event, connection, sequence, and clock fields. Verify that optimization and inlining produce the expected call-site information on supported compilers, especially through wrappers.

A high-rate event can encode location without copying text:

```cpp
struct EventSite {
    std::uint32_t site_id;
    std::uint16_t event_type;
    std::uint16_t schema_version;
};
```

At build time, a generated manifest maps `{build_id, site_id}` to file, function, line, and event schema. At runtime, the producer stores only the compact IDs. The decoder refuses to apply a table from another build. This design moves path normalization, string storage, and symbol presentation offline while preserving an exact source reference.

Generated IDs must remain stable within one artifact and unique in the manifest. If a macro derives IDs from `__COUNTER__`, include-order changes can renumber all sites; that is acceptable only when the build ID selects the table. Hash-derived IDs need collision detection at build time. Never silently resolve a collision by keeping one entry.

Privacy still applies. Function names can disclose strategy structure, and file paths can disclose developer names or build infrastructure. Keep the rich manifest in a restricted symbol store and export only approved summaries to general monitoring. Production records need enough information for authorized diagnosis, not every source string.

This approach has a code-size cost: call sites carry constants and the offline table occupies artifact storage. It avoids hot string formatting and repeated file-name bytes in rings. Confirm the final binary and manifest sizes, because instrumentation with thousands of sites can affect instruction-cache layout even when each runtime record is compact.

Site-table generation must be reproducible and run before signing or packaging. Archive it atomically with the executable, debug symbols, schemas, and compiler identity.

Without that bundle, compact diagnostic records lose their authoritative interpretation after deployment.

## 40.10 C++23 `stacktrace`

C++23 `std::stacktrace` represents a captured call stack as a sequence of entries. Capturing, symbolizing, and formatting are different operations with different costs and support requirements.

```cpp
#include <stacktrace>

void diagnose_slow_path() {
    const auto trace = std::stacktrace::current();
    // Queue or format only on a non-critical diagnostic path.
}
```

The standard interface does not promise allocation-free capture, signal safety, complete frames, source lines, or bounded time. Implementations depend on unwinding metadata, frame-pointer policy, debug information, symbol tables, helper libraries, and platform support. Optimized code can inline functions, merge code, or omit frames visible in a source-level model.

Standard-library availability has lagged C++23 language modes and can require extra link support in some toolchain releases. Use `__cpp_lib_stacktrace`, a configure-time link test, and an end-to-end symbolization test. A header compiling is not sufficient.

Capture addresses or compact entries on a cold path and symbolize offline when possible. Symbolization can acquire loader locks, allocate, read files, and execute substantial lookup work. It does not belong in an async signal handler.

Unwinding itself may read unwind tables and process frame metadata. Preserving frame pointers can make some profilers and fallback unwinders more reliable at a possible register/code-generation cost that depends on architecture and compiler. Frame pointers still do not restore inlined frames without debug information.

Limit stack depth. A trace captured on every repeated error can allocate large records and dominate the failure path. Capture the first instance, a sampled set, or an explicit slow-path request. Associate it with a stable error signature so later repetitions can increment a counter.

Compare stacktrace output across optimized, frame-pointer-preserving, split-debug, and stripped builds. Keep build IDs and matching debug artifacts. Without them, a production address stream cannot be reliably mapped after deployment changes.

## 40.11 Core Dumps, Signal Safety, and Flight-Recorder Buffers

A **core dump** is an operating-system-produced snapshot of selected process memory and metadata after a fatal event. On Linux, resource limits, dumpability, `core_pattern`, service-manager policy, namespaces, and storage capacity determine whether and where it is produced.

A fatal signal handler runs in an asynchronously interrupted process. The allocator or dynamic loader may already hold locks. Async-signal-safe POSIX functions form a small set; C++ iostreams, `std::string`, `std::stacktrace`, general allocation, mutex locking, and ordinary logging are not safe choices.

Linux core-dump configuration can pipe dumps to a user-space collector. That collector is another capacity-limited service; a large process can generate gigabytes and multiple simultaneous crashes can exhaust storage or memory bandwidth. Core filtering and `MADV_DONTDUMP` can exclude selected mappings, but excluding the wrong arena removes the evidence. Test the actual `core_pattern`, limits, namespace, service manager, and dump collector.

Secrets can also be excluded by keeping them in dedicated mappings with an explicit dump policy, though copies may still exist on stacks, heaps, or registers. Diagnostic policy is defense in depth, not a guarantee that one flag removes every secret.

A minimal handler can write a fixed record to an already-open descriptor and restore or re-raise default handling. If it returns, it should preserve the interrupted code's `errno`. Even `write` can fail or produce a partial result, and a full pipe can block unless configured and designed otherwise. Complex crash collection belongs in the kernel or an external supervisor.

Flight-recorder rings continuously retain recent fixed-size events in prefaulted memory. Overwrite semantics bound memory and keep the lead-up to failure. Records need publication sequences so a postmortem tool can reject a slot interrupted midway.

```text
slot sequence odd/uncommitted -> write payload -> publish even/committed sequence
reader accepts only matching stable sequence observations
```

The exact atomic protocol must follow the C++ memory model; a drawing is not an implementation. Crash-time readers operating out of process may require a documented shared-memory/file format and architecture assumptions.

Core files and flight records contain secrets: credentials, orders, keys, addresses, and client data. Restrict access, encrypt at rest where operationally feasible, set retention, and scrub exports. Diagnostics that compromise keys turn one crash into a security incident.

Test fatal signals in disposable environments, including disk-full and collector failure. Confirm that cores are symbolizable, build IDs match, and normal hot-path recording stays bounded.

## 40.12 Sequence Gaps and Network Drop Layers

A market-data **sequence gap** proves that expected application sequence values were not observed in order. It does not identify where loss occurred. The feed, switch, NIC, driver, kernel queues, socket buffer, parser, or application queue may be responsible.

```text
venue/feed -> switch port -> NIC ring -> driver/NAPI -> kernel backlog
           -> socket receive queue -> application read -> parser queue
```

Evidence exists at different layers:

- protocol sequence numbers and recovery messages;
- switch interface counters and telemetry;
- NIC hardware statistics from `ethtool -S`;
- driver and stack counters from `nstat`, `/proc/net/softnet_stat`, and tracepoints;
- socket drop ancillary data or application-visible counters where enabled;
- application queue overflow and parser rejection counters.

Counter names and meanings are driver/kernel/version-specific. A “drop” may mean no buffer, filter rejection, checksum failure, queue overflow, or policy discard. Read documentation and compare deltas during the exact incident window.

Queue locality matters. RSS can distribute flows to hardware queues, each with its own ring and interrupt/NAPI CPU. One queue can drop while interface-wide utilization appears low. Preserve queue ID and CPU in packet-path events when available, and map driver counter names to the deployed firmware and driver version.

Socket receive drops can occur after the NIC successfully DMAed the frame. Application queue drops can occur after the socket read succeeded. A packet capture point may sit before or after a particular loss layer. Document the capture hook; “not in the pcap” has no meaning without it.

Counters can wrap, reset on interface reload, aggregate queues, or update asynchronously. Record width, reset events, interface identity, queue mapping, and sample timestamps. Absence of an increment is not proof that the layer did not lose traffic if the relevant counter is unavailable.

TCP retransmission is different from multicast UDP loss. TCP may recover bytes while adding head-of-line latency; UDP application sequencing exposes gaps directly. Correlate protocol semantics before interpreting kernel retransmit counters.

Reproduce controlled overload in a lab, verify which counters move, and document a drop decision tree. Do not change ring sizes blindly: larger buffers can turn loss into stale data and larger tails.

## 40.13 Faults, Reclaim, Context Switches, and Throttling

Operating-system latency signals connect application stalls to memory and scheduling behavior. Minor page faults establish mappings without storage reads; major faults can require storage. Reclaim scans and evicts pages. Context switches and migrations interrupt cache residency. Cgroup or thermal throttling withholds CPU progress.

```sh
pidstat -r -w -t -p 1234 1
perf stat -e page-faults,minor-faults,major-faults,context-switches,cpu-migrations \
    -p 1234 -- sleep 10
cat /sys/fs/cgroup/cpu.stat 2>/dev/null
cat /sys/fs/cgroup/memory.events 2>/dev/null
```

These tools have different sampling and attribution models. `perf stat` totals an interval; `pidstat` samples counters; cgroup files aggregate a group. None alone says which application event was delayed.

Page reclaim can happen outside the measured task yet contend for memory bandwidth or locks. A fault count of zero does not prove memory had no role. NUMA remote access, TLB misses, cache eviction, and writeback pressure require additional evidence.

Linux pressure stall information (PSI) aggregates time in which tasks are stalled on CPU, memory, or I/O pressure for a monitored scope. It can reveal sustained resource contention missed by point counters, but it does not identify one instruction or packet. Cgroup-scoped PSI is often more relevant than host totals for containers.

Thermal throttling, cgroup CPU bandwidth throttling, and scheduler runqueue delay all reduce progress but require different remedies. More application threads can worsen all three. Correlate throttled periods, delivered frequency, runnable delay, and throughput before changing affinity or priority.

Context-switch count does not equal delay. Scheduler traces reveal whether a thread was sleeping or runnable and how long it waited. Throttling counters expose cgroup budget exhaustion; hardware tools expose thermal and power throttling. Clock drift can make duration comparison wrong even when the system executed normally.

Keep observation work off isolated cores where possible, and quantify its overhead. High-frequency tracing can fill buffers, trigger wakeups, and change the schedule. Begin with low-rate counters, narrow the time window, then enable targeted tracing.

## 40.14 Correlating Application, Kernel, NIC, and Switch Time

**Correlation** joins observations from independent components into one causal timeline. It requires common identifiers, known clock domains, bounded timestamp error, and retention that covers the same interval.

Application clocks, kernel software timestamps, NIC hardware clocks, and switch clocks may all differ. PTP can synchronize them within an observed error distribution, but offset, drift, path asymmetry, residence time, timestamp point, and conversion error remain. Chapter 33 develops those clocks in detail.

Carry stable identifiers where protocols permit: packet sequence, channel, flow tuple, queue, order ID, and a generated trace ID for internal stages. Do not rely only on wall-clock equality. Two events with close timestamps may be unrelated under load.

Clock conversion is a model with coefficients and validity interval. A PHC-to-system offset measured at one instant ages as clocks drift. Store calibration samples and interpolate only within a justified window. If synchronization health reports a step or loss of lock, split the timeline and increase uncertainty rather than forcing continuity.

```text
event time reported = true event time
                    + clock offset
                    + timestamp-point delay
                    + capture/transport delay
                    + conversion error
```

Document where each timestamp is taken: at NIC ingress, driver handling, syscall return, parser completion, or strategy decision. A later timestamp from a better clock is not automatically closer to wire arrival.

Build a correlation record with clock identity and synchronization health. Detect clock steps, PHC adjustment, interface reset, capture loss, and counter reset. Use intervals with uncertainty rather than inventing false total order when errors overlap.

Verification needs injected identifiable traffic observed at multiple layers. Compare timestamp differences over load, temperature, and synchronization disturbances. Preserve raw timestamps so improved calibration can be applied offline; formatting them early discards information.

Correlation pipelines can themselves reorder data. A log collector batches one source, a switch exports asynchronously, and a packet capture drops under load. Preserve per-source sequence numbers and ingestion timestamps in addition to event timestamps. Reconstruction should report missing records and ambiguity explicitly.

A useful incident artifact contains the raw event sets, counter snapshots with reset metadata, clock calibration, build/configuration identity, and the query that produced the derived timeline. This makes the conclusion reproducible rather than a screenshot of one dashboard.

Consider a multicast gap reported at application sequence 8,104,221. The parser records its last good sequence and receive timestamp; the socket reports a receive-queue overflow counter delta; the NIC reports no missed-buffer increment; one application SPSC queue reports no overwrite. This evidence suggests loss after NIC reception and before application consumption, but it does not yet prove which kernel queue overflowed. A concurrent scheduler trace shows the receiver runnable but unscheduled while its cgroup was throttled. The diagnosis becomes a causal chain: CPU quota prevented the receiver from draining, the socket queue filled, the kernel discarded packets, and the protocol detector observed the gap.

The correlation is valid only if counter intervals overlap the gap, counter reset state is known, and the receiver's timestamps are in a calibrated domain. If the socket counter was sampled minutes later or shared by several flows, label the inference accordingly. If the capture hook sits before the socket queue, seeing the packet in capture is consistent with later socket loss.

The remedy follows the cause. Increasing the NIC ring would not address a socket queue that filled during CPU throttling. Increasing the socket buffer might absorb a brief quota stall but also increases potential message age. Removing quota changes resource isolation and needs capacity review. The observability system should make these alternatives visible rather than recommend the largest buffer.

Before enabling a diagnostic path in production, complete this contract:

| Property | Required decision and evidence |
|---|---|
| producer work | maximum stores, branches, clock reads, and copies |
| storage | per-thread and total bytes, prefault policy, NUMA owner |
| ownership | lifetime of every queued field and decoder artifact |
| overload | block/drop/sample/overwrite rule and independent loss count |
| consumer failure | heartbeat, fallback, restart, and bounded backlog |
| clocks | timestamp point, domain, calibration, and uncertainty |
| sensitive data | redaction point, access, encryption, and retention |
| shutdown/crash | drain deadline, partial-record detection, core policy |
| verification | load, consumer-stop, disk-full, wrap, and clock-fault tests |

This table is not operational bureaucracy. Each row closes a way in which diagnostics can corrupt state, leak data, or create an unbounded latency tail. An observability feature is complete only when its own failure is observable through a simpler bounded mechanism.

## 40.15 Interview Check

1. Decompose a synchronous text log call into formatting, memory, synchronization, syscall, and sink work. Which parts does writing to `/dev/null` fail to measure?
2. What does C++23 `std::print` improve, and which allocation, locking, I/O, and support properties does it not guarantee?
3. Design an asynchronous logging queue for eight producers. Compare one MPSC ring with per-thread SPSC rings in cache traffic, ordering, and shutdown.
4. A diagnostic queue is full during a feed gap. Compare drop-new, overwrite-old, sampling, and blocking policies and specify nonrecursive loss telemetry.
5. Why is a trivially copyable binary event not automatically a portable file format? Design its schema and publication fields.
6. Compare a relaxed global atomic counter with per-thread counters. How are concurrent aggregation and thread exit made race-free?
7. Explain how false-sharing padding can reduce coherence traffic while worsening histogram cache and TLB footprint.
8. Contrast `std::source_location`, `std::stacktrace`, a core dump, and a flight recorder by hot-path work, signal safety, and postmortem requirements.
9. Given an application sequence gap, build a counter-and-trace decision tree across switch, NIC, driver, socket, and application queues.
10. Why can timestamps from application, kernel, NIC, and switch logs disagree even under PTP, and how would you attach uncertainty to the reconstructed timeline?
