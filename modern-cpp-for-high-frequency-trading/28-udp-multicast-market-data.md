# Chapter 28 — UDP and Multicast Market Data

UDP is attractive for market data because it preserves message boundaries, requires little transport state, and supports multicast delivery to many receivers. Those properties do not make delivery reliable or timely. A receiver must detect gaps, reject corrupt application messages, bound its queues, and recover state without stalling the live path. This chapter starts with the eight-byte UDP header, follows datagrams through Linux socket buffers, and ends with sequence arbitration across redundant A/B feeds and the packet-rate costs that dominate small-message traffic.

## 28.1 UDP Headers and Datagram Semantics

A **UDP datagram** is one transport-layer message. UDP preserves its boundary: one successful receive operation consumes at most one datagram, unlike TCP's byte stream in Chapter 29. The header has four 16-bit fields and is eight bytes long.

```text
 0               15 16              31
+------------------+------------------+
|   source port    | destination port |
+------------------+------------------+
|      length      |     checksum     |
+------------------+------------------+
|                payload ...          |
+-------------------------------------+
```

The UDP length includes header and payload. In ordinary IPv4 and IPv6 packets it is at least 8 and at most 65,535. IPv6 jumbograms define exceptional handling, including a zero UDP length field, but ordinary market-data networks should not infer jumbogram support from IPv6 support.

With a minimum 20-byte IPv4 header, the largest non-jumbogram UDP payload representable in one IPv4 packet is 65,507 bytes. That arithmetic says nothing about path MTU: an Ethernet path with a conventional MTU would require fragmentation for anything remotely near that size. Under ordinary IPv6 without extension headers, the corresponding UDP payload limit follows from the IPv6 payload-length field and the eight-byte UDP header. Extension headers consume part of that IPv6 payload length. Publishers should configure to a verified path limit rather than a theoretical field maximum.

Ports identify transport endpoints within a host. The source port can be zero in IPv4 UDP when no reply port is supplied; the destination port cannot be zero for normal delivery. A socket is selected using local address and port plus, for connected sockets, peer information and interface or namespace context. The exact Linux lookup rules include bind state and reuse options; UDP itself specifies no host socket API.

UDP supplies no handshake, acknowledgment, retransmission, duplicate suppression, ordering, receiver flow control, or congestion control. A successful `sendto` says that the local kernel accepted the datagram or completed the operation according to its API. It does not say that a switch forwarded it, a receiver queued it, or an application processed it.

One send operation normally creates one UDP datagram. The IP layer may fragment an oversized datagram, but losing one fragment prevents reassembly of the whole packet. IPv6 routers do not fragment in transit; IPv4 routers may under applicable header settings. Market-data publishers therefore normally keep datagrams below the known path MTU and avoid fragmentation.

Datagram semantics simplify parsing. A receiver can validate a fixed packet header and then process all messages declared within that packet. The packet buffer owns the bytes until the next receive reuses it. Any `std::span` or `string_view` into that buffer is non-owning and must not escape that lifetime without a copy or ownership transfer.

```cpp
// Excerpt: PacketView and DecodeError are domain types.
std::expected<PacketView, DecodeError>
decode_datagram(std::span<const std::byte> bytes) noexcept {
    if (bytes.size() < wire_header_size) {
        return std::unexpected{DecodeError::truncated};
    }
    return validate_packet(bytes);
}
```

The transport boundary is useful but insufficient. A valid UDP length says nothing about the venue message count, field bounds, sequence, or schema version. Validate every nested length with checked arithmetic before constructing a view.

The receiver must also distinguish zero-length payload from no packet. UDP permits an empty payload, yielding a length field of eight. A feed protocol can forbid it, but the socket layer cannot. Code that treats a zero return from a datagram receive exactly like TCP end-of-stream is wrong: UDP has no stream EOF indicated that way.

## 28.2 Checksums Under IPv4 and IPv6

The **UDP checksum** is a one's-complement checksum over the UDP header, payload, and an IP pseudo-header. The pseudo-header binds the datagram to source and destination addresses, protocol number, and length. It is included in checksum calculation but is not transmitted as part of the UDP header.

Under IPv4, a transmitted UDP checksum field of zero means that the sender did not supply a checksum. If calculation produces numeric zero, it is transmitted as all one bits so the meaning remains distinct. Receivers cannot treat an IPv4 datagram with checksum zero as corruption-detected.

Under ordinary IPv6 UDP, the checksum is mandatory. IPv6 defines narrow exceptions for specific tunnel uses and special jumbogram behavior; those exceptions are not a general permission for applications to disable it. A normal IPv6 market-data socket should expect checksum protection.

The checksum detects many accidental bit errors, but it is not cryptographic and does not provide a strong end-to-end integrity guarantee. Some multi-bit changes collide. It also protects the bytes as seen by the transport endpoints, not the correctness of application framing or state transitions. Feed protocols commonly add message lengths, type validation, sequence numbers, and sometimes stronger checksums.

One's-complement arithmetic adds 16-bit words with end-around carry and complements the result. Odd payload length requires a conceptual zero pad for calculation; the pad is not transmitted as UDP payload. Implementing this in user space needs careful treatment of byte order, unaligned data, and the pseudo-header. Most socket applications should let the kernel and NIC handle UDP checksums rather than duplicate the work.

Checksum offload can make packet captures confusing. On Linux, a packet captured before the NIC fills a transmit checksum may appear to have an invalid checksum. Receive metadata may tell the kernel that hardware already verified a checksum. A capture taken on another host or switch sees a different point in the path.

Use capture and interface statistics together:

```bash
sudo tcpdump -ni eth0 -vv 'udp port 18000'
ethtool -k eth0
ethtool -S eth0
```

Do not disable offloads merely to make a capture easier on a production path. Reproduce in an isolated environment, capture at an appropriate point, or have the analyzer account for offload state.

Checksum work scales with bytes, but hardware offload, vectorized software, cache state, and packet layout determine the actual cost. A tiny packet workload is often dominated by per-packet work elsewhere. Never use an observed checksum cost as evidence that the application can skip bounds or semantic validation.

## 28.3 Loss, Duplication, Reordering, and Corruption Detection

UDP does not report end-to-end loss, duplication, or reordering. A datagram may be dropped at the sender, NIC, switch, route, receiver NIC, kernel backlog, socket queue, or application queue. It may arrive after a later datagram when paths or queues differ. The network may duplicate it during a transient or feed fan-out design.

The application therefore needs an identity and ordering domain. A common market-data packet carries a channel identifier and the sequence of its first message:

```text
channel = 7
first_sequence = 1,004,210
message_count = 3

packet covers messages 1,004,210 through 1,004,212
next expected sequence becomes 1,004,213
```

If the next valid packet begins at 1,004,215, two messages are missing. If it begins at 1,004,211, it overlaps already processed data and may be a duplicate or malformed retransmission. The exact rule belongs to the feed protocol: some sequence per packet, some per message, and some exclude administrative records.

Do not equate a receive syscall failure with packet loss. `recvmsg` returning `EAGAIN` on a nonblocking socket means that no datagram is currently queued. Conversely, a successful receive can follow silent loss because ordinary UDP does not create a per-gap error event.

Corruption detection happens in layers:

| Layer | Example check | What it cannot establish |
|---|---|---|
| Ethernet | Frame check sequence | End-to-end application validity |
| IP/UDP | Header or transport checksum | Schema and business semantics |
| Feed packet | Length, type, count, optional CRC | Correct order-book transition |
| State machine | Sequence and invariant checks | Recovery availability |

A receiver should validate before mutating shared state. Decode into bounded local fields, check the message extent, and only then apply an update. If partial application precedes detection, gap recovery must know whether to roll back or discard the entire book.

Drop attribution follows the receive path in order:

```text
NIC ring -> driver/NAPI backlog -> IP validation/reassembly
         -> UDP socket lookup -> socket receive queue
         -> userspace receive buffer -> application work queue
```

A sequence gap proves that the application did not obtain a logical record, but it does not identify this stage. NIC counters, softnet statistics, IP/UDP counters, socket drop metadata, and application queue counters narrow the location. Keep the stages separate in telemetry; a single counter named `packet_loss` destroys useful evidence.

Packet reordering requires a policy, not an assumption. A small reorder buffer can wait for a missing predecessor, but it adds memory and delay and can be exhausted. An HFT receiver may instead declare a gap immediately, keep processing a redundant feed, or enter recovery. The best choice depends on venue recovery semantics and whether later messages are meaningful without the missing update.

Fault testing should inject each condition independently. A namespace and `tc netem` can model loss, duplication, reordering, and corruption for development, though it does not reproduce every switch or NIC mechanism:

```bash
sudo tc qdisc add dev veth-feed root netem \
    loss 0.1% duplicate 0.05% reorder 0.2% 25%
```

Use an isolated veth or test namespace, not a production interface. Record the configuration and random seed where supported so results can be interpreted.

## 28.4 Sequence Numbers, Timestamps, and Gap Recovery

A **sequence number** orders items within a defined stream. Its width, initial value, wrap rule, and unit—packet or message—must come from the application protocol. Comparing unsigned sequence numbers with ordinary `<` fails around wrap unless the protocol's maximum ambiguity window is bounded.

For a 32-bit sequence with no valid distance of 2^31 or more, compare the forward unsigned distance against the half range:

```cpp
// Valid only under the protocol's less-than-2^31 ambiguity bound.
[[nodiscard]] constexpr bool sequence_before(std::uint32_t a,
                                             std::uint32_t b) noexcept {
    const std::uint32_t forward = b - a;
    return forward != 0 && forward < (std::uint32_t{1} << 31);
}
```

Unsigned subtraction is defined modulo 2^32, so this implementation handles wrap without an implementation-defined signed conversion. The protocol bound remains essential: values exactly half a range apart have no unique ordering, and a receiver that can lag by half the sequence space needs an epoch or wider identity. Encapsulate the rule in one tested sequence type.

A timestamp is not a sequence number. Two packets can carry equal timestamps, clocks can step or drift, and feeds A and B can traverse different delays. Exchange send time, NIC hardware receive time, kernel software time, and application read time belong to different clock domains. Use timestamps for latency and staleness analysis only after identifying their source, resolution, synchronization, and wrap behavior.

Gap handling commonly separates the live and recovery paths:

```text
live packet sequence 5010 arrives; expected 5008
             |
             +--> mark [5008, 5009] missing
             +--> request retransmission or snapshot
             +--> continue buffering bounded later updates
             +--> apply recovery in sequence
```

A retransmission channel might be TCP or unicast UDP; a snapshot may describe complete current state rather than historical messages. Neither is supplied by UDP. The receiver must define how buffered incrementals relate to the snapshot sequence and what happens when the recovery queue fills.

Recovery must not wait forever on the hot thread. Use a state machine with deadlines and capacity:

| State | Live-feed action | Exit condition |
|---|---|---|
| Synchronized | Apply next expected record | Gap or validation failure |
| Recovering | Buffer or discard by policy | Missing range filled or snapshot ready |
| Stale | Reject book-dependent decisions | Successful atomic rebuild |
| Failed | Stop channel and alert | Explicit restart |

Sequence persistence matters across restart. If a receiver restarts without a current snapshot, its first observed sequence cannot establish book correctness. Session reset and sequence reset indicators need protocol-specific handling; treating every backward jump as a duplicate can conceal a new epoch.

Gap requests themselves need identities and limits. If a missing range spans 50 messages but the recovery service limits one request to 10, split it deterministically and cap outstanding requests. Merge adjacent gaps where the protocol permits, suppress duplicate requests from A/B arbitration, and expire responses belonging to an old session epoch. Otherwise, an incident can produce a recovery-request storm that competes with live traffic.

Timestamping should record at least clock source and capture point with each sample. Linux `SO_TIMESTAMPING` can request software or hardware timestamps, but availability and control-message format depend on NIC, driver, and socket setup. A timestamp copied into the feed payload by the publisher and a receive timestamp generated by the local NIC measure different intervals.

Verification should replay wraparound, overlapping packets, empty administrative packets, duplicate recoveries, snapshot races, and one-past-capacity. Counters should distinguish network-observed gaps, kernel drops, application queue drops, duplicate packets, and failed recoveries.

## 28.5 Kernel Receive-Buffer Overflow

The **socket receive buffer** holds packet data and kernel metadata until the application consumes it. When the receive path cannot enqueue another datagram within applicable limits, Linux may drop the datagram. The sender normally receives no indication, especially for multicast.

A nominal buffer size is not a datagram count. Accounting includes socket-buffer structures, alignment, shared packet data, and kernel implementation details. A burst of small datagrams can consume much more queue memory than the sum of UDP payload bytes.

Queue capacity in time is approximately queued datagrams divided by arrival rate only under a stable packet-size and accounting model. Bursty multicast invalidates an average-rate estimate. Measure the minimum effective packet capacity using production-sized frames, then compare it with the longest admitted scheduling pause. Include simultaneous channels mapped to the same receive thread.

Linux can attach an `SO_RXQ_OVFL` ancillary value to received packets when enabled. It reports a cumulative count of packets dropped by the socket since creation according to Linux's implementation. The value can wrap, and absence of a control message is not proof that no loss occurred on other layers.

```cpp
// Excerpt: error handling abbreviated.
int enabled = 1;
::setsockopt(fd, SOL_SOCKET, SO_RXQ_OVFL, &enabled, sizeof(enabled));

// recvmsg() supplies control messages; inspect each cmsghdr for
// level SOL_SOCKET and type SO_RXQ_OVFL.
```

System counters add context:

```bash
nstat -az UdpInDatagrams UdpInErrors UdpRcvbufErrors
ss -u -a -n -m
ip -s link show dev eth0
ethtool -S eth0
```

Counter names and visibility depend on kernel, driver, namespace, and privileges. NIC ring drops, softnet backlog drops, UDP checksum errors, socket overflow, and application loss are separate events. Correlate them with feed sequence gaps rather than choosing one counter as the universal truth.

Increasing `SO_RCVBUF` can absorb a longer burst, but it also permits older data to wait in the kernel. That can convert visible loss into invisible staleness. Capacity should cover a justified scheduling or batch interval, and the receiver should timestamp near arrival or query queue overflow so it can detect excessive lag.

Socket overflow is already too late for backpressure: UDP and multicast have no receiver window that can slow the publisher. The only choices are to provision, shed local work, recover, or change the upstream protocol. Sending an application complaint later may influence a venue service, but it cannot restore the discarded datagram by UDP semantics.

The application must drain efficiently. Pinning, interrupt affinity, NAPI behavior, and busy polling affect scheduling but introduce system-level tradeoffs developed in Chapter 31. Before advanced tuning, remove synchronous logging, allocation, locks, and unbounded work from the receive loop.

## 28.6 Connected and Unconnected Sockets

A **connected UDP socket** has a default peer recorded in the kernel. Calling `connect` on UDP does not exchange packets and does not establish reliable state. It selects a peer for `send` and normally filters received datagrams to that peer tuple.

```cpp
sockaddr_in peer{/* family, port, address */};
if (::connect(fd, reinterpret_cast<sockaddr*>(&peer), sizeof(peer)) == -1) {
    return socket_error(errno);
}

// No handshake occurred. The first send can still fail or be lost.
const ssize_t sent = ::send(fd, data, size, MSG_DONTWAIT);
```

Connected UDP can simplify calls, avoid supplying an address for each send, and make asynchronous network errors such as ICMP port-unreachable reports visible through subsequent operations on some systems. Exact error delivery is OS-dependent, can be delayed, and never proves that the peer application received earlier packets.

An unconnected socket uses `sendto` or `sendmsg` with a destination and `recvfrom` or `recvmsg` to obtain source addressing. It can communicate with many peers. Every inbound source must be validated; source IP and port are not authentication.

Binding and connecting also select local state. An unbound socket is commonly assigned an ephemeral local port on first send or connect by the OS. Route selection can choose a local source address. Applications that require a specific interface, source address, or firewall identity should bind and configure explicitly, then read back `getsockname` rather than relying on incidental routing.

For multicast, receivers usually bind a local port and join a group rather than “connect” in the session sense. A UDP connect can filter to one source on Linux, but source-specific multicast membership expresses the network intent more directly and supports the protocol's interface semantics.

Calling `connect` again can change a UDP peer. Linux supports disconnecting with an address family convention, but that behavior is not a portable socket guarantee. Do not build a cross-platform abstraction around Linux-specific disconnect semantics without an explicit branch and tests.

Socket creation and setup belong before the critical loop. Route lookup, neighbor resolution, local port assignment, and error-queue behavior can put slow work on the first sends even though UDP has no handshake. Warmup traffic changes external state and must be allowed by venue and network policy.

## 28.7 Send, Receive, Scatter/Gather, and Batch APIs

The basic datagram APIs transfer one message per call. `sendto` and `recvfrom` include an address; `send` and `recv` use a connected peer. `sendmsg` and `recvmsg` add scatter/gather arrays, addresses, flags, and ancillary control data.

```cpp
// Excerpt: send one header and one payload without concatenating them.
iovec parts[] = {
    {.iov_base = &header, .iov_len = sizeof(header)},
    {.iov_base = payload.data(), .iov_len = payload.size()}
};

msghdr message{};
message.msg_iov = parts;
message.msg_iovlen = std::size(parts);

const ssize_t n = ::sendmsg(fd, &message, MSG_DONTWAIT | MSG_NOSIGNAL);
```

Scatter/gather avoids an application concatenation copy, but the kernel still walks iovecs, validates user memory, and usually copies payload into kernel-managed packet storage unless a specialized path applies. The iovec array and all referenced bytes must remain valid for the synchronous syscall. A successful datagram send reports the whole datagram size; ordinary UDP does not report a partial datagram send.

Linux provides `sendmmsg` and `recvmmsg` to process arrays of messages in one syscall. Batching amortizes syscall entry, wakeups, and some per-call setup. It also delays the earliest packet while the application assembles a batch or waits for more receives.

```cpp
// Excerpt: slots contain preinitialized mmsghdr/iovec/buffer storage.
int count = ::recvmmsg(fd, slots.data(), slots.size(),
                      MSG_DONTWAIT | MSG_TRUNC, nullptr);
for (int i = 0; i < count; ++i) {
    process(slots[i].msg_len);
}
```

`recvmmsg` is Linux-specific. Its timeout and interruption behavior have had subtleties across kernel versions; a nonblocking receive loop integrated with readiness notification is easier to bound. `MSG_WAITFORONE` changes blocking after the first message and should not be mistaken for a guarantee that a desired batch fills.

Ancillary data can carry timestamps, destination address, interface index, drop counters, and other metadata. The control buffer must be correctly aligned and large enough; `MSG_CTRUNC` reports truncated ancillary data. Parsing `cmsghdr` manually without the `CMSG_*` macros risks alignment and bounds bugs.

Every output field from `recvmsg` is per call. Reset `msg_namelen`, `msg_controllen`, `msg_flags`, and iovec lengths before reusing a slot; the kernel updates them. Failing to restore control-buffer capacity after one short result can silently prevent metadata delivery on later packets. Likewise, a batch slot's `msg_len` belongs to that invocation and should not be trusted after an error.

Choose a maximum batch from measured packet rate, per-message work, and latency budget. A receiver should stop a batch before starving other required tasks. Report both packets per syscall and time a packet waits before processing.

## 28.8 Socket Buffer Accounting

`SO_RCVBUF` and `SO_SNDBUF` configure socket buffer limits, not exact application payload capacity. Linux commonly reports twice the requested receive or send buffer value because it reserves additional space for bookkeeping. The doubling rule and minimum or maximum clamping are Linux implementation details.

```cpp
int requested = 4 * 1024 * 1024;
if (::setsockopt(fd, SOL_SOCKET, SO_RCVBUF,
                 &requested, sizeof(requested)) == -1) {
    return socket_error(errno);
}

int effective{};
socklen_t length = sizeof(effective);
::getsockopt(fd, SOL_SOCKET, SO_RCVBUF, &effective, &length);
```

System limits such as `net.core.rmem_max` and privileged force options can cap the request. Namespace and container configuration may differ from the host. Always read back the effective value and log it during controlled initialization.

Privilege is not a capacity model. Raising a global maximum permits a socket request; it does not reserve physical memory for all sockets or protect the receive thread from scheduling. Total memory equals the effective limit multiplied across channels and fan-out consumers only as an upper-bound starting point; shared packet storage and accounting complicate actual residency.

Receive memory includes more than queued bytes. One Ethernet frame can be represented by a socket-buffer object referring to shared or fragmented storage. Offloads can alter aggregation and accounting. Consequently, dividing `SO_RCVBUF` by payload size does not yield a guaranteed packet capacity.

The UDP send buffer covers locally queued output. Nonblocking sends can fail with `EAGAIN` when space is unavailable; other failures include `EMSGSIZE` for a message that cannot be sent under path or socket constraints and routing errors. Linux may also report asynchronous errors through the error queue when enabled.

Buffers move where overload is observed. A large kernel queue tolerates short scheduling gaps but increases memory footprint and possible residence time. A tiny queue exposes loss quickly but may fail under ordinary bursts. Pair size with application high-water telemetry and a stale-data threshold.

Verify settings and occupancy with `ss -u -m`, `/proc/net/udp`, and application counters, qualifying every field by kernel documentation. Tool snapshots race with traffic; they are diagnostic samples, not a complete event history.

## 28.9 Reuse, Fan-Out, Truncation, and Atomicity

Address-reuse options control binding, not packet reliability. `SO_REUSEADDR` and `SO_REUSEPORT` have OS-specific rules. On Linux, `SO_REUSEPORT` can create a group of sockets bound to the same address and port, with kernel selection or an attached BPF program distributing traffic.

Unicast reuse-port distribution usually selects a socket rather than copying every packet to every socket. Multicast delivery has different fan-out behavior and depends on memberships, bind addresses, and kernel version. Test the exact topology. Never assume that adding a receiver is passive: it can change reuse-port distribution.

Linux normally requires sockets in one `SO_REUSEPORT` group to satisfy effective-user-ID restrictions, helping prevent arbitrary port hijacking. An attached classic or extended BPF selector can choose group members and must handle membership changes and return values correctly. This is Linux behavior, not a UDP feature, and a selector bug can create deterministic loss on one worker.

Fan-out to several sockets multiplies queue memory and processing. It can isolate consumers, but a slow consumer can still overflow its own socket while another remains healthy. A single receiver followed by an application multicast or shared-memory ring centralizes sequence arbitration but adds another queue and ownership boundary.

UDP send atomicity means an application sends one complete datagram or receives an error; the API does not return a successful short count for an ordinary datagram. IP fragmentation does not change this application boundary. At receive, a buffer smaller than the datagram yields a different problem: the excess is discarded, not left for a second read.

`MSG_TRUNC` is essential for detecting this case. POSIX and Linux details differ; on Linux, supplying `MSG_TRUNC` as an input flag can make the return value report the full datagram length even when the buffer was shorter. `msg_flags & MSG_TRUNC` also marks truncation.

```cpp
// Excerpt: one-slot recvmsg setup omitted.
const ssize_t n = ::recvmsg(fd, &message, MSG_DONTWAIT | MSG_TRUNC);
if (n > static_cast<ssize_t>(buffer.size()) ||
    (message.msg_flags & MSG_TRUNC) != 0) {
    record_oversize_datagram(n);
    return DecodeError::truncated;
}
```

Zero-length UDP datagrams are valid. An API reporting zero queued bytes cannot always distinguish no datagram from a queued empty datagram; receive the message instead of using byte availability as a readiness truth.

Reuse, fan-out, and truncation policies should be tested during rolling restart, where old and new receiver processes overlap. Confirm whether both receive, one receives, or packets are redistributed, and ensure sequence recovery covers the transition.

## 28.10 Joining and Leaving Multicast Groups

A multicast receiver must bind an appropriate local address and port and install a **group membership** on a specific interface. Binding alone does not join a group; joining alone does not replay packets sent earlier.

IPv4 applications use APIs such as `IP_ADD_MEMBERSHIP` with `ip_mreq`, `ip_mreqn`, or the protocol-independent `MCAST_JOIN_GROUP`. IPv6 uses `IPV6_JOIN_GROUP` with an `ipv6_mreq` containing a group address and interface index. The available structures and exact selection rules vary by OS.

```cpp
// Excerpt: Linux IPv4 group join with an explicit interface index.
ip_mreqn request{};
request.imr_multiaddr = group_address;
request.imr_ifindex = interface_index;

if (::setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP,
                 &request, sizeof(request)) == -1) {
    return socket_error(errno);
}
```

Membership is associated with a socket and interface. Closing the socket removes its memberships. Explicit leave is useful when a long-lived socket changes subscriptions, but leave completion does not mean every switch immediately pruned the port.

The host's membership protocol—IGMP for IPv4 or MLD for IPv6—communicates receiver interest to adjacent network devices. Switch IGMP snooping and multicast routing can take time to update. A successful `setsockopt` proves only local kernel acceptance, not that the first subsequent feed packet will arrive.

Socket setup order should be transactional. Create and configure the descriptor, bind, join every required leg, enable metadata, and only then publish it to the receive loop. If the second group join fails, unwind the first membership by closing the unpublished socket. Partially activating a channel complicates sequence state and makes startup failure nondeterministic.

Join before declaring the channel live. Wait for protocol-specific synchronization, such as a snapshot plus an incremental sequence boundary. Receiving one packet proves connectivity at that instant, not continuity from the join call.

Multiple memberships can share one socket, but the receiver then needs destination-address ancillary data to distinguish groups when ports overlap. `IP_PKTINFO` or IPv6 packet information can provide destination and interface context on Linux. Validate control-message truncation and interface changes.

## 28.11 Interface Selection, TTL, Loopback, and Source Filters

Multicast routing decisions require explicit interface intent on multihomed hosts. For IPv4, `IP_MULTICAST_IF` selects the outgoing interface; join requests select the incoming membership interface. IPv6 commonly uses interface indices. Relying on a default route can send traffic to the wrong network after a routing change.

The multicast **TTL** for IPv4, or hop limit for IPv6, limits router hops. It is not elapsed time and does not expire a datagram sitting in a queue. A TTL of one generally confines routing to the local link, subject to network configuration.

`IP_MULTICAST_LOOP` controls whether locally sent multicast is looped back to local receivers. Disabling it can make a same-host publisher/receiver test fail while remote delivery works. Enabling it can duplicate a test feed when another physical path returns the packet. Set and verify the intended behavior.

**Any-source multicast (ASM)** accepts traffic for a group from permitted sources. **Source-specific multicast (SSM)** identifies both source and group, reducing unwanted-source delivery and making feed identity explicit. APIs include source membership operations and protocol-independent `MCAST_JOIN_SOURCE_GROUP`; network support must extend across the path.

Source filtering is not cryptographic authentication. An attacker or misconfigured host able to inject with the expected source may still deliver packets. Validate channel IDs, schema, lengths, and session epochs at the application layer.

TTL and loopback are sender-side properties. A receiver cannot infer the sender's configured TTL from ordinary delivered payload, and changing the local receiver TTL option does not constrain incoming traffic. Record publisher and network configuration separately from receiver membership state.

Interface identifiers can change across hosts and namespaces. Resolve by configured name at startup, record the resulting index and address, and fail clearly if they disagree with routing policy. Monitor link state, address changes, membership reports, and packet counters without performing configuration churn in the hot loop.

## 28.12 Redundant A/B Feeds and Sequence Arbitration

Redundant **A/B feeds** carry logically equivalent sequence streams over paths intended to fail independently. The receiver normally applies the first valid copy of each next sequence and discards later duplicates. Redundancy reduces exposure to a single-path loss; it does not guarantee losslessness when paths share failure domains or the publisher omits data on both.

Independence must be verified end to end. Two multicast groups can enter different switch ports yet share a publisher process, top-of-rack switch, fiber conduit, receiver NIC, IRQ, socket thread, or memory queue. A common receive bottleneck can drop both copies at once. Document physical and software failure domains, then compare simultaneous gap events across legs.

For feeds with message-level sequences:

```text
expected = 9001

time       feed A             feed B              action
t0         seq 9001           --                  apply 9001
t1         --                 seq 9001            discard duplicate
t2         seq 9003           seq 9002            apply 9002, hold/evaluate 9003
t3         seq 9002           seq 9003            discard 9002, apply one 9003
```

The exact handling of 9003 at `t2` depends on the allowed reorder window and whether B is expected promptly. Applying 9003 before 9002 would violate an ordered incremental book. Waiting indefinitely would turn redundancy into unbounded latency. Use a bounded reorder structure and a recovery deadline.

Validate duplicates, do not merely compare sequence. If A and B carry different bytes for the same logical message, raise a feed-divergence event and follow venue policy. Normalization may be required when transport headers or feed-specific timestamps legitimately differ; comparison must target the protocol's logical payload.

Timestamps should not choose the winner unless their clock semantics make that valid. Arrival timestamps from two NICs can have different hardware clocks or queueing points. Sequence establishes order; the earliest locally observed valid next sequence commonly establishes selection.

Arbitration state should track each leg separately:

- highest contiguous sequence received;
- duplicates, gaps, validation failures, and late packets;
- last arrival time in a declared local clock domain;
- interface, NIC queue, and socket drop counters; and
- current session or sequence epoch.

A path can be alive but stale. Heartbeats without data do not prove that expected data arrived. Compare leg progress and alert on sustained skew. Failover should already be active reception, not a cold join after A fails, because multicast membership and state synchronization take time.

The reorder structure can be a fixed window indexed by sequence modulo capacity. Each slot needs a generation or exact sequence tag so wraparound and reuse cannot make stale bytes look current. Store only the data required until application; retaining full maximum-sized datagrams per slot may produce a large cache and memory footprint. When distance exceeds the window, transition to recovery rather than overwriting an unresolved predecessor silently.

Recovery requests can be deduplicated across legs. If both miss the same range, one bounded recovery operation is sufficient. If only A misses and B fills the gap, cancel or ignore a later retransmission safely. Test the race in which recovery, A, and B all supply overlapping ranges.

Arbitration must validate the declared message count before advancing expected sequence. A malformed packet claiming many records must not skip a range merely because its ending sequence looks newer. Advance only after every logical record in the contiguous packet has passed bounds and schema checks, or reject the packet atomically and let the other leg or recovery path fill it.

## 28.13 Packet-Rate Limits and Small-Packet Costs

Small UDP messages are often **packet-rate bound** rather than bandwidth bound. Each packet can require descriptor processing, DMA bookkeeping, driver and protocol work, socket lookup, queue accounting, a wakeup or poll iteration, a syscall share, validation, and sequence arbitration regardless of payload size.

Ethernet wire accounting illustrates the distinction. A minimum ordinary Ethernet frame occupies 64 bytes from destination MAC through frame check sequence, with padding when payload is short. Transmission also consumes an 8-byte preamble/start delimiter and a 12-byte interpacket gap on the link. Thus link occupancy is larger than the IP or UDP length visible to the application. VLAN tags and larger payloads change the calculation; switches and NICs can add their own framing outside the Ethernet model.

For an unfragmented IPv4 UDP payload of `P` bytes without IP options or VLAN tags, the protocol bytes before Ethernet padding are:

```text
Ethernet header 14 + IPv4 header 20 + UDP header 8 + payload P + FCS 4
```

If that sum is below 64, Ethernet padding raises the frame to the minimum. Then add preamble and interpacket gap for wire-time occupancy. IPv6 uses a 40-byte base header before extensions. Verify venue encapsulation rather than applying this simplified formula blindly.

Batch receive reduces syscall rate, while interrupt moderation and NAPI reduce interrupt rate. Generic receive offload may aggregate eligible traffic before parts of the stack. These mechanisms trade per-packet overhead against waiting and can change what a host capture shows. Support for UDP, multicast, and particular offloads is NIC-, driver-, and kernel-dependent.

Application design matters just as much. A parser that allocates one object per message, hashes variable strings, and logs every gap can exhaust CPU before the link approaches capacity. Fixed-layout validation, preallocated buffers, bounded event records, and cache-local state reduce work without changing protocol semantics.

At a line rate `R` bits per second and wire occupancy `W` bytes per packet, an idealized packet-rate ceiling is `R / (8W)`. This ignores physical coding overhead outside the stated model, pause frames, switch behavior, and imperfect utilization. It is useful for checking orders of magnitude, not promising achieved rate. The CPU must also sustain that packet rate for every active channel and redundant copy.

Measure at several layers:

```bash
perf stat -e cycles,instructions,cache-misses,context-switches \
    ./market_data_receiver
ethtool -S eth0
nstat -az UdpInErrors UdpRcvbufErrors
```

Report payload bytes per second, packets per second, messages per packet, syscalls per packet, batch distribution, application queue depth, gaps, and end-to-end timestamp deltas. Throughput at zero loss is insufficient if batching or queues make the data stale.

The receiver's capacity plan should include the maximum packet burst, not only average bandwidth. When it cannot keep up, it must expose where loss occurred, mark dependent state unsafe, and enter a defined recovery mode. UDP's simplicity makes that responsibility visible. It does not remove it.

A production readiness test should sustain both redundant feeds, recovery traffic, and telemetry simultaneously, because testing each path alone omits their shared CPU, cache, memory-bandwidth, and queue pressure.

## 28.14 Interview Check

1. Which fields are in the UDP header, what does its length include, and which delivery properties does UDP explicitly not supply?
2. Contrast UDP checksum rules for ordinary IPv4 and IPv6. Why might a host-side transmit capture show a checksum that appears invalid?
3. A packet begins at message sequence 10,005 and contains four messages while the receiver expects 10,003. Identify the missing and overlapping cases the receiver must distinguish.
4. Why can increasing `SO_RCVBUF` reduce observed drops while increasing market-data staleness? Which Linux and application counters would you inspect?
5. Explain what UDP `connect` does and does not do. How can asynchronous ICMP errors appear without creating a reliable connection?
6. Compare `recvmsg` with `recvmmsg` for latency and throughput. What lifetimes and ancillary-data truncation rules must the code handle?
7. What happens when a UDP receive buffer is smaller than the datagram, and how does Linux `MSG_TRUNC` help detect it?
8. Design a safe multicast startup sequence from socket creation through book synchronization. Why is a successful group join not enough?
9. Given out-of-order arrivals on redundant A/B feeds, specify a bounded arbitration and recovery policy without using timestamps as sequence numbers.
10. Calculate the Ethernet wire occupancy of a small IPv4 UDP datagram, including minimum-frame padding, preamble, and interpacket gap, and explain why packet rate may dominate payload bandwidth.
