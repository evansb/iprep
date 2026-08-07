# Chapter 44 — Linux and Networking Workshops

These workshops turn Linux and networking mechanisms into observable experiments. Each one begins with a contract, fixes capacities and failure behavior, and ends with evidence rather than a timing anecdote. Run privileged commands only in disposable namespaces or dedicated test hosts: namespace, traffic-control, affinity, memory-locking, and diagnostic settings can disrupt unrelated workloads when applied to a shared or production system.

For every workshop, retain a short experiment manifest: source revision, compiler and flags, kernel, CPU and NUMA topology, relevant limits, namespace topology, commands, input seed, and start/end counter snapshots. Correctness and performance are separate runs. Sanitizers, syscall tracing, packet capture, and verbose logging intentionally perturb the path; use them to establish behavior, then repeat with the optimized configuration for timing.

## 44.1 Trace `fork` Through `exec` and Demand Paging

This workshop traces a process from address-space duplication through image replacement and first page use. The important distinction is virtual mapping work versus physical page residency: `fork` commonly establishes copy-on-write mappings, `execve` replaces the image, and later instruction or data access can still fault pages in.

**Requirements.** Build a parent that allocates a page-aligned region, writes one byte per page, then calls `fork`. The child reports its PID over a pipe, modifies exactly one page, waits for the parent, and calls `execve` on a small helper. The helper touches one page at a time in a large static or mapped region and reports minor and major fault counts with `getrusage`. Use `_exit` on child failures before `exec` so copied C++ or stdio buffers are not flushed twice.

**Environment.** Use a disposable user session with GCC or Clang, `strace`, `perf`, and `/proc`. Do not create artificial memory pressure on a shared host: forcing reclaim or swap can disrupt other processes. Capture the kernel, filesystem, compiler, page size, transparent-huge-page policy, and whether the executable was already in the page cache.

**Invariants.** The pipe ends have explicit ownership. Descriptors not needed after `exec` carry close-on-exec. The child calls only async-signal-safe operations between `fork` and `exec` if the parent was multithreaded; the simplest workshop parent stays single-threaded. The parent reaps the exact child. Every mapped byte touched is within the mapping.

**Scaffold.** Mark phases with writes to the synchronization pipe rather than sleeps:

```text
parent: mmap -> touch pages -> fork -> inspect child -> release child -> waitpid
child:  close unused FDs -> report PID -> write one private page -> wait
        -> execve(helper)
helper: report maps/faults -> touch pages -> report faults -> exit
```

Trace process and mapping syscalls with `strace -ff -e trace=process,memory`. Record faults and scheduling events with a command such as `perf stat -e page-faults,minor-faults,major-faults,context-switches`. Inspect `/proc/<pid>/maps`, `smaps_rollup`, and `status` only at pipe-controlled pauses; `/proc` reads perturb timing and race with process exit.

**Failure injection.** Execute a nonexistent helper and verify the child reports `errno` then `_exit`s. Close the synchronization peer and handle `EPIPE` without a default signal unexpectedly killing the process. Compare read-only child access with one-byte-per-page writes to expose copy-on-write. Run once with a cold disposable file and once warm, but do not claim that dropping system-wide page caches is necessary or safe.

**Verification.** The trace must show one successful `fork`, one `execve`, and one `waitpid`. The child write should make only touched private pages eligible for copy-on-write copying; exact kernel accounting and huge-page behavior are implementation-specific. After `exec`, old user mappings disappear except for kernel-defined survivors and the new image is mapped. Helper page touches should increase minor faults when pages are resident but unmapped and may show major faults only when storage I/O is required.

**Five-lens review.** Semantics: state what POSIX/Linux guarantees and what copy-on-write merely implements. Latency: count syscalls, page-table work, faults, scheduler stops, and loader activity. Memory: compare virtual size, RSS, proportional set size, and private dirty pages. Predictability: name page-cache, huge-page, loader, and scheduler dependencies. Verification: retain commands, phase markers, fault deltas, and the precise observation points.

## 44.2 Select Shared Memory, Unix Sockets, or Pipes

The IPC choice is a contract about ownership, framing, backpressure, crash behavior, and topology—not a contest between isolated syscall medians.

**Requirements.** Design a same-host channel carrying fixed records `{sequence, timestamp, payload[48]}` from one producer to one consumer. Compare three valid designs: a bounded shared-memory SPSC ring with an `eventfd` or futex-assisted wait, a Unix-domain `SOCK_SEQPACKET` or framed stream socket, and a pipe with explicit record framing. Define maximum burst, capacity, full behavior, peer-death detection, startup handshake, and restart policy.

**Environment.** Run two processes under one user on a disposable host. Keep payload, producer rate, consumer work, CPU placement, and result validation identical. Affinity with `taskset` is optional and must use CPUs reserved for the experiment; pinning onto a production core can degrade another service. Record whether peers share a NUMA node.

**Invariants.** A sequence is published only after all record bytes are initialized. The shared ring uses process-shared atomics that are actually lock-free if the design requires lock freedom; verify with the deployed implementation. Socket and pipe readers retain partial data until a complete record exists. No design silently overwrites unread data. A crashed producer cannot leave the consumer interpreting a partially initialized record as valid.

**Scaffold.** Hide transports behind a narrow test interface:

```cpp
struct Record {
    std::uint64_t sequence;
    std::uint64_t send_ticks;
    std::array<std::byte, 48> payload;
};

struct Channel {
    virtual bool try_send(const Record&) noexcept = 0;
    virtual bool try_receive(Record&) noexcept = 0;
    virtual ~Channel() = default;
};
```

The interface is a harness convenience, not a required production abstraction. Measure shared-memory polling separately from blocking notification. For stream transports, deliberately split headers and payloads; for `SOCK_SEQPACKET`, verify record-size and truncation behavior. Pipes guarantee atomic writes only under the relevant `PIPE_BUF` rule, so do not generalize from this small record to arbitrary messages.

Before implementing, fill in this decision table with project-specific bounds:

| Question | Shared ring | Unix socket | Pipe |
|---|---|---|---|
| Message boundary | Slot protocol | `SEQPACKET` or application framing | Application framing |
| Kernel crossing per transfer | Optional notification; data shared | Send/receive path | Write/read path |
| Full behavior | Ring policy | Socket-buffer/backpressure policy | Pipe-buffer/backpressure policy |
| Peer credentials | Separate handshake | Kernel-supported local credentials | Separate process contract |
| Restart cleanup | Versioned mapping/epoch | Endpoint reconnect | Recreate descriptors |

The table does not declare a winner. A shared ring can minimize copies and still be wrong for independently restarting peers; a Unix socket can add kernel work and still reduce overall failure complexity.

**Failure injection.** Fill each channel while the consumer pauses. Kill either peer. Restart one side with stale shared memory present. Truncate a stream record, close mid-message, and send an unsupported protocol version. For shared memory, corrupt the version field in a copied test mapping and ensure attachment fails before data access.

**Verification.** Validate every accepted sequence and payload checksum generated by the harness. Record throughput and a latency histogram without coordinated omission. Use `strace -c` to count syscalls, `perf stat` for context switches/cache behavior, and `/proc/<pid>/fd` to confirm descriptor ownership. Report drops or blocked time as results, not excluded samples.

**Five-lens review.** Semantics: shared bytes versus kernel-carried byte or message streams. Latency: polling, syscalls, wakeups, copies, and cache-line transfers. Memory: ring slots, socket buffers, pipe capacity, mappings, and metadata. Predictability: full queues, peer death, stale mappings, and scheduler delay. Verification: sequences, syscall counts, queue telemetry, counters, and reproducible placement.

## 44.3 Edge-Triggered `epoll` With Partial I/O

Edge-triggered `epoll` reports readiness transitions; it does not promise that one read or write completes an application message. Correct code keeps explicit connection state and drains a nonblocking descriptor until `EAGAIN`.

**Requirements.** Implement a single-threaded server using nonblocking sockets, `epoll` with `EPOLLET`, and a four-byte big-endian length prefix. Support many simultaneous clients, payloads up to a fixed maximum, partial reads, partial writes, multiple frames per read, orderly half-close, reset, and bounded output queues. Do not allocate after connection admission; give each admitted connection fixed buffers or a pool slot.

**Environment.** Start with `socketpair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, ...)` for deterministic tests, then use loopback TCP. File-descriptor limits and accepted-connection capacity are explicit. Run sanitizers in correctness builds and a noninstrumented build for performance. No elevated privileges are required.

**Invariants.** Each byte belongs to exactly one state: unused input space, retained incomplete frame, completed frame under processing, or queued output. A parsed length never exceeds the buffer. The server registers interest in `EPOLLOUT` only while output remains. It closes a connection once, removes its state, and never uses a descriptor number after that number may have been reused.

**Scaffold.** A connection holds parsing and write cursors:

```cpp
struct Connection {
    static constexpr std::size_t capacity = 64 * 1024;
    std::array<std::byte, capacity> input{};
    std::array<std::byte, capacity> output{};
    std::size_t input_begin{};
    std::size_t input_end{};
    std::size_t output_begin{};
    std::size_t output_end{};
    bool peer_eof{};
};
```

On an input event, call `read` in a loop until it returns `-1` with `EAGAIN` or `EWOULDBLOCK`, handling `EINTR`, zero, and real errors separately. Parse every complete buffered frame, compact only when needed, and stop admission if output capacity would overflow. On output, loop until empty or `EAGAIN`. Treat `EPOLLERR` and `EPOLLHUP` as reasons to inspect and drain state, not as substitutes for ordinary I/O results.

**Failure injection.** Send one prefix byte at a time, two frames in one write, a payload split at every boundary, zero length if disallowed, maximum length, and maximum plus one. Stop reading responses to force partial writes. Close after half a prefix or half a payload. Rapidly close and reconnect to expose descriptor-reuse bugs.

**Verification.** A reference decoder reconstructs the exact sent frame sequence. Assert buffer cursors after every state transition in tests. Use a syscall trace to prove edge-triggered handlers drain until `EAGAIN`. Run AddressSanitizer and UndefinedBehaviorSanitizer; fuzz arbitrary byte chunks and EOF positions. Performance tests report admitted connections, rejected connections, output-overflow policy, syscalls per frame, and event-loop delay.

**Five-lens review.** Semantics: readiness, nonblocking results, stream framing, and close behavior. Latency: event calls, read/write loops, compaction, wakeups, and queueing. Memory: fixed per-connection buffers and descriptor table. Predictability: capacity admission, slow readers, malformed lengths, and reused FDs. Verification: chunk-boundary tests, fuzzing, traces, and queue histograms.

## 44.4 Prefault and NUMA-Place an Order-Book Pool

Prefaulting establishes physical pages before the critical phase; NUMA placement determines which memory controller backs them. Neither action helps if later allocations expand beyond the prepared pool.

**Requirements.** Reserve a fixed pool sized for a stated maximum number of order nodes and index entries. Map or allocate it before the session, bind the initialization thread to the intended NUMA node, apply an explicit memory policy, and write at least one byte in every base page. Optionally lock only the required mapping if privileges and `RLIMIT_MEMLOCK` permit. The hot allocator returns pool slots and never requests new pages.

**Environment.** Record `lscpu`, `numactl --hardware`, page size, huge-page policy, and NIC locality. A single-node host can test prefaulting but not remote-node effects. CPU affinity and NUMA policy can starve or imbalance other jobs; use a reserved test machine or cgroup/cpuset assigned by the operator. Do not change system-wide huge-page or reclaim policy for this exercise.

**Invariants.** Capacity arithmetic is overflow-checked. Every slot has one owner or is on the free list, never both. Touching occurs after the desired memory policy is active and from the intended CPU. No background initialization races with use. Pool exhaustion returns an explicit error and does not fall back to the general heap.

**Scaffold.** Separate phases:

```text
calculate bytes -> map aligned region -> establish NUMA policy
-> touch each page -> optionally mlock selected pages
-> build free list -> record fault baseline -> enter hot phase
```

Linux mechanisms include `mbind`, `set_mempolicy`, or a NUMA library. `madvise` can express access expectations but does not by itself prove residency or node placement. `mlock` prevents eligible pages from being reclaimed under its contract; it is not a substitute for touching them, and failure must be checked.

Touch one location in each actual page, not each assumed 4 KiB interval. Obtain the base page size with `sysconf(_SC_PAGESIZE)` and check multiplication when rounding the region. Transparent huge pages can collapse or split backing later, so page-count expectations need the observed mapping policy. If explicit huge pages are a requirement, reserve and test them as a separate configuration with an ordinary-page fallback policy.

**Failure injection.** Request one slot beyond capacity. Run a correctness test with deliberately remote initialization, then restore policy. Lower the child process's memory-lock limit and verify initialization reports failure rather than continuing under a false assumption. Exercise release/reuse patterns and poison freed slots in debug builds.

**Verification.** Record minor and major fault deltas with `perf stat` during initialization and separately during the hot phase. Inspect placement with `numastat -p`, `/proc/<pid>/numa_maps`, or supported `move_pages` queries. Compare local and remote placement only while CPU and workload remain fixed. A successful acceptance run has zero unexpected hot-phase allocation and an explained fault count; do not require a universal cycle figure.

**Five-lens review.** Semantics: mapping, first touch, affinity, policy, and locking contracts. Latency: faults, remote access, allocator operations, and free-list dependencies. Memory: pages, metadata, padding, and huge-page effects. Predictability: capacity, reclaim, migration, and placement drift. Verification: faults, page maps, NUMA counters, allocation instrumentation, and target-host measurements.

## 44.5 Diagnose Switches, Faults, and Socket Drops

Packet loss must be localized by observation boundaries. An application sequence gap says that data did not reach the state machine; it does not identify the failing queue.

**Requirements.** Given a UDP feed with occasional sequence gaps, produce a timeline and a layer-by-layer evidence table covering publisher, wire, switch ingress/egress, receiver NIC, driver, IP/UDP stack, socket buffer, application queue, and parser. Preserve counter baselines and timestamps. State which devices and clocks are authoritative.

**Environment.** Use a replica feed or controlled packet generator, switch read access, and a receiver with `ethtool`, `ip`, `nstat`, `ss`, packet capture, `perf`, and application counters. Do not enable promiscuous capture, reset counters, change ring sizes, or mirror high-rate production traffic without capacity and change approval. Diagnostic commands can consume CPU and management-plane resources.

**Invariants.** Application sequence accounting distinguishes missing, duplicate, late, malformed, and intentionally filtered messages. Counters are monotonic or rollover-aware. Capture loss is measured separately from network loss. Observation never changes the recovery decision.

**Scaffold.** Build an evidence matrix:

| Boundary | Evidence | A gap here suggests |
|---|---|---|
| Switch ingress | FCS/alignment/ingress drop deltas | Physical source link or ingress policy |
| Switch egress | Queue watermark/discard deltas | Contention or replication burst |
| NIC | `ethtool -S` ring/missed/error counters | PHY, device buffer, or RX-ring loss |
| Kernel | interface, UDP, softnet, socket overflow | Host packet-path overload |
| Application | sequence and bounded-queue counters | Scheduling, parsing, or application overload |

Capture on both a passive network observation point and the host when feasible. Linux can expose socket overflow counts through ancillary data when configured; treat counter availability as kernel-specific. Record interrupt affinity, softirq load, page faults, context switches, and CPU frequency or throttling state around the event.

Work from earliest boundary to latest. Do not tune socket buffers while unexplained switch egress discards remain, and do not blame a switch when the publisher manifest never contained the missing sequence. A single synchronized evidence bundle is more useful than many unaligned screenshots. If clocks are not synchronized to the needed accuracy, correlate by sequence and counter interval rather than inventing a sub-microsecond timeline.

**Failure injection.** In a lab, reduce an application queue, pause the consumer, shrink the socket buffer, overload one switch egress, inject malformed sequence fields, and corrupt a captured test file. Inject one cause at a time, then combine bursts with scheduler interference. Never create loss on a production VLAN for diagnosis.

**Verification.** Each injected fault must produce the predicted earliest counter or capture divergence. The final report identifies the last boundary where the packet exists and the first where it does not, with uncertainty when capture itself drops. It separates physical errors, congestion drops, host drops, and application rejects.

**Five-lens review.** Semantics: what each counter actually counts. Latency: queue buildup, interrupts, softirqs, scheduling, and parser work. Memory: rings, socket buffers, captures, and application queues. Predictability: microbursts, counter rollover, capture loss, and clock alignment. Verification: correlated deltas, bounded captures, sequence logs, and controlled reproduction.

## 44.6 Decode Ethernet, VLAN, IPv4, and UDP Safely

A packet decoder is a bounds-checked state machine over bytes. Casting a receive pointer to nested C++ header structures assumes alignment, lifetime, padding, and validity that an untrusted frame does not promise.

**Requirements.** Decode an Ethernet II frame with zero or one 802.1Q tag, IPv4 with variable IHL, and an unfragmented UDP datagram. Return a non-owning payload view plus source/destination addresses and ports. Reject truncated headers, unsupported EtherTypes, more VLAN tags than supported, invalid IPv4 version or IHL, inconsistent total length, fragments, invalid UDP length, and checksum failures according to an explicit validation policy.

**Environment.** Use C++23 `std::span<const std::byte>` and `std::expected` where the deployed library supports it; otherwise provide an equivalent result type. Compile with high warnings and run AddressSanitizer, UndefinedBehaviorSanitizer, and a coverage-guided fuzzer. Test byte arrays and saved synthetic captures, not proprietary venue data.

**Invariants.** Check remaining length before every read. Decode multi-byte fields bytewise or with `memcpy` plus explicit network-order conversion. Subviews never exceed the validated parent length. The returned view cannot outlive its input buffer. IP fragments never reach the UDP parser. Ethernet padding never becomes UDP payload.

**Scaffold.** Advance a cursor only after validation:

```cpp
enum class DecodeError {
    truncated, unsupported, invalid_length, fragmented, bad_checksum
};

struct DatagramView {
    std::uint32_t source_ip;
    std::uint32_t destination_ip;
    std::uint16_t source_port;
    std::uint16_t destination_port;
    std::span<const std::byte> payload;
};

std::expected<DatagramView, DecodeError>
decode(std::span<const std::byte> frame) noexcept;
```

Parse 14 Ethernet bytes, inspect EtherType, conditionally consume four VLAN bytes and the inner EtherType, then validate at least 20 IPv4 bytes. Compute `ihl_bytes`, constrain it by both total length and capture length, reject nonzero fragment offset or More Fragments, and locate UDP. UDP length includes its eight-byte header and must fit the validated IP payload.

Checksum policy depends on observation point. On a physical receive path, NIC metadata can report checksum validation even when the captured buffer does not contain an independently verified value. In an offline byte corpus, calculate Ethernet FCS only if the corpus includes it, IPv4 header checksum over exactly IHL bytes, and UDP checksum over pseudo-header plus UDP datagram. An IPv4 UDP checksum of zero means “not supplied” under that protocol's rule; it is not a computed success. Keep this policy in the decoder configuration rather than silently accepting all checksums in benchmark mode.

**Failure injection.** Truncate at every byte offset. Mutate every length and type field, set all IHL values, flip fragment flags, supply odd-aligned starting spans, append Ethernet padding, and make UDP length smaller than eight or larger than IP payload. Include valid and invalid checksums and a policy that deliberately skips only offload-unavailable validation at a documented boundary.

**Verification.** Cross-check accepted fields against an independent decoder such as Wireshark/tshark for generated packets. Property tests assert that no accepted subview leaves the input, no truncation crashes, and serialization followed by decode preserves values. Fuzz under sanitizers and retain the smallest crashing or disagreement corpus. Benchmark valid common packets and invalid early/late exits separately.

**Five-lens review.** Semantics: exact protocol lengths and checksum coverage. Latency: branches, byte loads, checksum work, and invalid exits. Memory: view size, no allocations, and input lifetime. Predictability: bounded header chains and rejection policy. Verification: differential decoding, fuzzing, sanitizers, corpus coverage, and optimized assembly.

## 44.7 Calculate Wire Size and Serialization Delay

Wire calculation begins with a named application payload and includes every transmitted header, trailer, preamble, and inter-packet gap relevant to the link-rate budget.

**Requirements.** Calculate a 96-byte application message carried by UDP over minimum-header IPv4 in one 802.1Q-tagged Ethernet frame. Assume no tunnels or IP options, a 1,500-byte IP MTU, and MAC rates of 10 and 25 Gbit/s. Report MAC-frame bytes, wire-accounted byte-times, serialization time, and maximum back-to-back frame rate under those assumptions.

**Environment.** This is an arithmetic workshop. Record whether a device's advertised rate is being treated as the MAC service rate and state that PHY coding, device pipelines, propagation, processing, and queueing are excluded.

**Invariants.** Count every field once. UDP length is 8 + 96 = 104 bytes. IPv4 total length is 20 + 104 = 124 bytes. A tagged Ethernet header before IP is 18 bytes; FCS is 4. The 124-byte IP packet exceeds the tagged frame's padding threshold, so no padding is needed.

**Scaffold.** The calculation is:

```text
MAC frame       = 18 tagged Ethernet header + 124 IP packet + 4 FCS
                = 146 bytes
wire occupancy  = 8 preamble/SFD + 146 frame + 12 inter-packet gap
                = 166 byte-times = 1,328 bit-times

at 10 Gbit/s    = 1,328 / 10,000,000,000 s = 132.8 ns
at 25 Gbit/s    = 1,328 / 25,000,000,000 s = 53.12 ns
10GbE frame rate= 10,000,000,000 / 1,328 ≈ 7.530 million frames/s
```

These are serialization/occupancy calculations, not measured end-to-end figures.

**Failure injection.** Recalculate with a 10-byte application payload to force padding, with no VLAN, with two VLAN tags, and with a tunnel header. Try a payload that exceeds the path MTU and stop: fragmentation or segmentation creates several frames, so merely adding bytes to one frame is wrong.

**Verification.** Implement the arithmetic with checked integer units, compare by hand, and verify packet-layer lengths in a generated capture. A host capture may omit FCS, preamble, gap, or hardware-inserted VLAN tags, so document adjustments. Confirm that 146 + 20 equals 166 byte-times and that rate multiplication recovers 1,328 bits.

**Five-lens review.** Semantics: which fields exist at each layer. Latency: unavoidable serialization versus excluded terms. Memory: application/capture bytes versus wire bytes. Predictability: size changes, padding, tags, and fragmentation. Verification: dimensional analysis, capture reconciliation, and independent arithmetic.

## 44.8 Trace ARP, Routing, Fragmentation, and Socket Delivery

This workshop follows one UDP datagram across a routed topology and makes every address and size transition visible.

**Requirements.** Create source, router, and receiver namespaces joined by two veth pairs. Use documentation IPv4 prefixes, enable forwarding only in the router namespace, and assign a smaller MTU to the receiver-side link. Trace route selection, ARP for each next hop, Ethernet header replacement, TTL decrement, optional IPv4 fragmentation, reassembly, UDP socket lookup, and delivery.

**Environment.** Namespace creation, forwarding, MTU changes, and capture require suitable Linux privileges. Use unique names on a disposable host. Keep commands inside namespace-specific invocations; never enable global forwarding or alter a production interface. Prepare an idempotent cleanup command before creation.

**Invariants.** The source routes the receiver prefix through the router. The receiver has a return route. Neither endpoint believes the remote prefix is on-link. The router never bridges the two links. Captures are bounded. The sender explicitly chooses DF on or off for each test, and the payload has a sequence so reassembly success is observable.

**Scaffold.** Use this logical topology:

```text
source ns               router ns                 receiver ns
192.0.2.2/24 --- veth --- 192.0.2.1/24
                         198.51.100.1/24 --- veth --- 198.51.100.2/24
                         receiver-side MTU: 1200
```

Inspect `ip route`, `ip route get`, and `ip neigh` in every namespace. Capture `-e` link headers on both router interfaces. Send a small datagram first, then an oversized datagram with DF, then one that permits fragmentation. Use `tracepath` or controlled `ping` payloads to observe PMTU behavior; exact tool support varies.

**Failure injection.** Delete the source neighbor entry to force ARP. Remove the receiver return route. Set an incorrect on-link prefix. Block the relevant ICMP only inside a dedicated variation to demonstrate a PMTU black hole, then restore it. Drop one fragment and verify the entire UDP datagram fails reassembly. Never leave broad filtering changes outside the lab namespaces.

**Verification.** The source Ethernet destination is the router MAC while the IP destination remains the receiver. At the second link, source/destination MACs change and TTL decreases. DF oversized traffic produces an ICMP fragmentation-needed outcome when permitted; fragmentation-enabled traffic produces correctly offset fragments and one reassembled UDP delivery. Socket and IP counters explain failures.

Record a packet ledger with one row per observation point: capture timestamp, interface, source/destination MAC, source/destination IP, TTL, identification, flags, fragment offset, UDP ports when present, and captured length. Noninitial fragments do not contain the UDP header, so a capture filter that selects only the UDP port can hide them. Filter by host or protocol while studying fragmentation, then narrow during socket-delivery analysis.

The router's first packet on its receiver-side link can wait for its own ARP resolution independently of the source's ARP for the router. Warm both tables for the steady-state run and delete one exact neighbor entry for the cold run. Never use broad neighbor flushes on a shared namespace or host.

**Five-lens review.** Semantics: route, neighbor, TTL, DF, fragment, reassembly, and socket contracts. Latency: cold ARP, router lookup, serialization, ICMP, and reassembly. Memory: neighbor entries, fragment queues, socket buffers, and captures. Predictability: stale state, PMTU black holes, and fragment loss. Verification: four-point captures, routes, neighbors, counters, and application sequence.

## 44.9 Build a Multicast Receiver With Gap Detection

A multicast receiver must treat network delivery and application sequence continuity as separate contracts. Joining a group arranges delivery interest; it does not make messages reliable or ordered.

**Requirements.** Receive fixed-size venue-neutral messages containing `{version, type, length, sequence, payload}` over IPv4 UDP multicast. Select the interface explicitly, join one group, detect gaps, duplicates, late messages, malformed lengths, and sequence wrap according to a documented unsigned sequence rule. Preallocate a receive batch and never allocate in the packet loop. Emit bounded counters and recovery requests through a separate queue.

**Environment.** Use a namespace/veth multicast lab or an isolated VLAN. Configure loopback behavior deliberately. If using `recvmmsg`, document Linux specificity and fall back to `recvmsg` for portability. Record socket buffer size, group, source, port, interface index, and whether source-specific membership is used.

**Invariants.** Only a validated message advances expected sequence. Duplicate or old packets do not roll state backward. A forward gap creates one bounded recovery range; an excessive gap or queue-full condition transitions to snapshot recovery. Payload views expire before the receive buffer is reused. Counters never block the receiver.

**Scaffold.** Keep sequence logic explicit:

```cpp
enum class SequenceResult { next, gap, duplicate_or_late };

SequenceResult classify(std::uint32_t expected, std::uint32_t received) {
    const auto delta = received - expected;
    if (delta == 0) return SequenceResult::next;
    if (delta < 0x8000'0000U) return SequenceResult::gap;
    return SequenceResult::duplicate_or_late;
}
```

This half-range modular comparison is valid only if no legitimate displacement reaches half the sequence space. State that invariant. Parse network byte order safely, inspect `MSG_TRUNC`, and capture kernel overflow ancillary counters where supported.

**Failure injection.** Send sequences with one missing, duplicate, adjacent swap, large jump, wraparound, bad length, wrong version, and truncated datagram. Pause the consumer to overflow its socket in a controlled lab. Drop and reorder packets with namespace traffic control as in Section 44.12.

**Verification.** Compare receiver counters with the sender's manifest and a packet capture that reports its own drops. Each injected pattern yields the specified classification and recovery range. Measure packets per second, batch size, syscalls, socket overflow, application queue depth, and processing-latency histograms. A capture's success does not prove socket delivery.

**Five-lens review.** Semantics: multicast, datagram boundaries, truncation, and modular sequences. Latency: syscalls, batch waits, parsing, queueing, and recovery. Memory: socket buffers, batch arrays, views, and recovery queue. Predictability: burst loss, wrap invariant, overflow, and malformed input. Verification: sender manifest, captures, kernel counters, application counters, and fault matrix.

## 44.10 Implement TCP Length-Prefix Framing

TCP supplies an ordered byte stream, not messages. A length-prefix decoder must work for every legal division and coalescing of those bytes.

**Requirements.** Implement a four-byte big-endian length prefix followed by that many payload bytes. Accept lengths from 1 through a fixed `max_frame`; reject zero and larger values. Support partial prefix, partial body, several frames in one read, EOF at a frame boundary, EOF mid-frame, and reset. The encoder supports partial writes without rebuilding or duplicating a frame.

**Environment.** Test with `socketpair` before loopback TCP. Limit send/receive buffer sizes to encourage partial operations, but never assume one setting forces a particular split. Use nonblocking mode if integrated with Section 44.3 and blocking mode in a separate reference test.

**Invariants.** The parser's retained byte count never exceeds capacity. It consumes a prefix only after all four bytes exist. It validates length before reserving or copying a body. EOF with retained bytes is a truncated-frame error. A queued output frame owns its storage until every byte is written.

**Scaffold.** Model states rather than calls:

```text
NeedPrefix(0..4 bytes)
    -> NeedBody(validated_length, 0..length bytes)
    -> CompleteFrame
    -> NeedPrefix
```

A fixed buffer can retain input and two indices. When free space is fragmented, compact validated retained bytes or use a ring representation. Do not call `read` “for one message.” It asks for bytes and can return any positive count up to the supplied capacity.

**Failure injection.** Feed every possible split point for a corpus of frames, one byte at a time, and all frames in one chunk. Close at every byte offset. Encode lengths `0`, `max_frame`, `max_frame + 1`, and `0xffffffff`. Stop the peer from reading to force partial output and `EAGAIN`.

**Verification.** A property test concatenates encoded frames, partitions the byte string randomly, and requires the decoder to reproduce exactly the originals. Sanitizers and fuzzing exercise arbitrary streams. Syscall traces confirm partial handling, while performance tests report copies, compactions, syscalls per frame, buffer occupancy, and slow-peer rejection.

**Five-lens review.** Semantics: ordered bytes, EOF, and nonblocking results. Latency: prefix parsing, copies, compaction, syscalls, and head-of-line delay. Memory: fixed input/output capacity and ownership. Predictability: malicious length, slow peer, and truncated stream. Verification: exhaustive split tests, fuzzing, sanitizers, and syscall traces.

## 44.11 Diagnose Nagle, ACK, Window, and Retransmission Behavior

TCP latency emerges from interacting sender, receiver, and network state. Naming Nagle's algorithm alone does not explain a stall; inspect segment timing, acknowledgments, congestion state, and receive windows together.

**Requirements.** Build a loopback or namespace client/server that can issue small writes, delay reads, toggle `TCP_NODELAY`, report `TCP_INFO`, and timestamp application send/receive events. Run controlled cases for coalescing, delayed acknowledgments, receiver-window closure, packet loss, retransmission, and head-of-line blocking.

**Environment.** Use isolated namespaces for impairment. `tcpdump`, `ss -ti`, and `TCP_INFO` observations add work and can see offload-shaped packets; document capture point and offload state. Do not change global congestion control, delayed-ACK behavior, or production qdiscs. Kernel algorithms and timers vary, so record the kernel and socket options.

**Invariants.** Application records remain length-framed. Tests change one factor at a time. Clock timestamps use one domain or a documented conversion. A successful `write` means bytes entered the local socket path, not that the peer application consumed them.

**Scaffold.** Cases include:

1. One small request and response with default options.
2. Two small writes with and without `TCP_NODELAY`.
3. Receiver stops reading until its advertised window shrinks or closes.
4. `tc netem` drops a segment while later bytes are sent.
5. Receiver resumes and application delivery timing is recorded.

Capture sequence and acknowledgment numbers, advertised windows, retransmissions, and packet timestamps. Read `TCP_INFO` before and after each phase, understanding that field availability is Linux-version-specific.

**Failure injection.** Delay application reads, constrain socket buffers, inject isolated loss and bursts, and close one side without draining. Do not hard-code a delayed-ACK timer or retransmission duration as universal. Make the test wait for observed state with a bounded overall timeout.

**Verification.** Relate every application stall to capture and socket state. Show that later stream bytes are not delivered past missing earlier bytes. Distinguish sender coalescing from receiver delayed ACK, receiver flow control from congestion control, and fast recovery from timeout recovery. Repeat enough times to expose distribution rather than selecting one trace.

**Five-lens review.** Semantics: reliable ordered bytes, acknowledgment, flow control, and congestion control. Latency: coalescing, ACK timing, retransmission, wakeups, and head-of-line blocking. Memory: send/receive queues and unacknowledged bytes. Predictability: loss pattern, kernel timers, buffer limits, and peer behavior. Verification: capture, `ss`, `TCP_INFO`, application timestamps, and controlled impairment.

## 44.12 Validate Impairments With Namespaces, Veth, and `tc netem`

`tc netem` emulates selected delay, loss, duplication, corruption, reordering, and rate effects at a Linux queueing point. It validates application failure behavior; it does not reproduce every property of a physical switch or WAN.

**Requirements.** Create sender and receiver namespaces connected by a veth pair. Apply one impairment at a time to the egress where its direction is unambiguous. Run a sequence-numbered UDP generator and the receiver from Section 44.9. Measure configured versus observed delay and loss, then test one combined burst scenario.

**Environment.** `ip netns` and `tc qdisc` operations require appropriate privileges. Use unique test-only namespace and interface names. Never attach a root qdisc to an interface whose ownership is uncertain. Prepare cleanup before setup and verify the target with `ip -n <namespace> link show`.

**Invariants.** Both baseline directions work before impairment. Every `tc` command names a namespace and exact test veth. Generator sequence count is fixed. Capture loss is reported. Cleanup removes only the named namespaces; no wildcard or host-root qdisc deletion is used.

**Scaffold.** A minimal variation after namespace setup is:

```sh
set -eu
LAB_SEND="lab44-send-$$"
LAB_RECV="lab44-recv-$$"
VETH_SEND="v44s$$"
VETH_RECV="v44r$$"
MADE_SEND=0
MADE_RECV=0
MADE_LINK=0

cleanup() {
    if [ "$MADE_LINK" -eq 1 ]; then
        ip link del "$VETH_SEND" 2>/dev/null || true
        ip link del "$VETH_RECV" 2>/dev/null || true
    fi
    if [ "$MADE_SEND" -eq 1 ]; then
        ip netns del "$LAB_SEND" 2>/dev/null || true
    fi
    if [ "$MADE_RECV" -eq 1 ]; then
        ip netns del "$LAB_RECV" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

ip netns add "$LAB_SEND"
MADE_SEND=1
ip netns add "$LAB_RECV"
MADE_RECV=1
ip link add "$VETH_SEND" type veth peer name "$VETH_RECV"
MADE_LINK=1
ip link set "$VETH_SEND" netns "$LAB_SEND"
ip link set "$VETH_RECV" netns "$LAB_RECV"
ip -n "$LAB_SEND" addr add 192.0.2.1/24 dev "$VETH_SEND"
ip -n "$LAB_RECV" addr add 192.0.2.2/24 dev "$VETH_RECV"
ip -n "$LAB_SEND" link set lo up
ip -n "$LAB_RECV" link set lo up
ip -n "$LAB_SEND" link set "$VETH_SEND" up
ip -n "$LAB_RECV" link set "$VETH_RECV" up

ip netns exec "$LAB_SEND" tc qdisc replace dev "$VETH_SEND" root \
    netem delay 2ms 500us loss 1%

ip netns exec "$LAB_SEND" tc -s qdisc show dev "$VETH_SEND"

# Normal completion uses the same ownership-aware cleanup path.
cleanup
trap - EXIT INT TERM
```

The process-specific names make collisions unlikely; more importantly, `set -e` stops on a failed creation and each ownership flag is set only after that resource is created. Cleanup therefore removes only resources created by this run. Never substitute a wildcard, host interface, or empty variable into a destructive network command.

Random loss and jitter produce distributions, not exact counts in a short run. `netem` options and random-seed support vary by `iproute2` and kernel version. Record both and retain the exact command.

**Failure injection.** Test fixed delay, jitter, random loss, burst loss where supported, duplication, corruption, and reordering separately. Add a rate-limiting qdisc only when its queue interaction is understood. Verify both directions by moving the qdisc or using distinct devices; an egress qdisc does not impair the reverse path automatically.

**Verification.** Capture before and after the impaired egress when practical. Compare sender manifest, qdisc statistics, receiver sequences, and application latency distribution. Fixed delay should shift observations near the configured amount plus host scheduling; random loss should converge statistically over a sufficiently large sample, not equal exactly one percent. Inspect `tc -s` drops/backlog and bound the run.

**Five-lens review.** Semantics: egress qdisc placement and modeled impairment. Latency: configured delay, queueing, scheduler noise, and batching. Memory: qdisc limit, backlog, socket buffers, and capture buffers. Predictability: random distribution, burst model, direction, and cleanup. Verification: baseline, exact configuration, qdisc counters, dual captures, sequence results, and repeated trials.

## 44.13 Interview Check

1. After `fork`, which pages are logically private, which physical pages may still be shared, and what observations distinguish a minor fault from a major fault after `exec`?
2. Choose among shared memory, Unix sockets, and pipes for a fixed-record same-host feed. Define ownership, backpressure, peer-death, and restart behavior before discussing speed.
3. Why must an edge-triggered `epoll` handler drain until `EAGAIN`? Trace a partial prefix, a complete frame, and a partial write through its connection state.
4. Design a prefaulted NUMA-local order pool. How do you prove page residency, node placement, hot-phase allocation count, and behavior at capacity?
5. A host capture sees a packet that the application misses. Which kernel and application queues remain possible drop points, and which counters localize them?
6. For a tagged Ethernet/IPv4/UDP decoder, list every length relationship that must hold before returning a payload span.
7. Recalculate Section 44.7 for a 10-byte application payload. Where is padding added, and which capture bytes may be absent from the wire accounting?
8. Explain why the Ethernet destination is a router's MAC while the IP destination remains a remote receiver. What changes at each routed hop?
9. Compare UDP multicast gap recovery with TCP retransmission and head-of-line behavior under the same injected loss.
10. Design a safe `netem` experiment whose results distinguish qdisc loss, capture loss, socket overflow, and application-queue overflow.
