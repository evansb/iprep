# Chapter 31 — The Linux Packet Path

A packet does not move directly from a NIC into a C++ object. It crosses descriptor rings, DMA ownership, driver polling, protocol code, socket queues, a system-call boundary, and usually a copy before the application can parse it. Each stage has capacity, CPU placement, batching, and drop behavior. This chapter follows receive and transmit packets through Linux, then shows how steering, offloads, busy polling, bypass, and observability change the work. Exact functions and optimizations vary by kernel, driver, NIC, and configuration; the stable method is to track ownership, queues, and evidence.

## 31.1 NIC DMA and Receive Descriptor Rings

A **receive descriptor ring** is a circular array through which a driver supplies packet buffers to a NIC and learns which buffers contain received data. The device commonly transfers frame bytes by direct memory access (DMA), so the CPU does not copy each byte from the NIC.

A simplified ownership cycle is:

```text
driver allocates/maps buffer
        |
        v
descriptor owned by NIC -> NIC DMAs frame -> completion visible
        ^                                      |
        |                                      v
driver recycles/refills <- stack/XDP releases buffer
```

Real descriptors contain device-specific addresses, lengths, status, checksum, VLAN, timestamp, and other metadata. Some NICs separate completion queues from buffer rings. Linux drivers may source receive memory from page pools and build socket-buffer metadata around all or part of those pages. These are implementations, not socket API guarantees.

DMA requires a platform mapping contract. Drivers use kernel DMA APIs to establish device-visible addresses and synchronization. A C++ atomic fence in user space is not a substitute for that contract. On cache-coherent server platforms, hardware and kernel mappings make ordinary NIC DMA practical; other devices or architectures may need explicit cache maintenance handled by the driver.

Ring capacity absorbs a finite arrival burst while the CPU is unavailable. When the NIC runs out of posted descriptors, it must drop frames or apply device-specific behavior. A larger ring tolerates a longer service gap but reserves more buffers, touches more memory, and permits a larger hidden backlog before upper layers see traffic.

Ring entries and buffers should be NUMA-local to the processing CPU when possible. If the driver allocates on one node and application/IRQ processing runs on another, descriptor metadata and packet data cross the interconnect. First-touch rules, driver allocation policy, and NIC PCIe attachment all matter.

Packets are often distributed among several receive queues. Section 31.8 explains hashing; for now, treat each queue as its own ring, interrupt/poll context, counters, and capacity. One hot flow can overflow one queue even while other queues are idle.

Inspect actual configuration and driver counters:

```bash
ethtool -g eth0
ethtool -l eth0
ethtool -S eth0
ip -s link show dev eth0
```

Names such as `rx_missed_errors`, `rx_no_buffer`, or queue-specific drops are driver-defined. Consult the driver's documentation and compare counter deltas during a controlled burst; labels are not uniform across hardware.

## 31.2 Interrupt Moderation and NAPI

**Interrupt moderation** groups packet notifications to reduce interrupt rate. **NAPI** is Linux's receive-processing framework that switches from interrupt notification to bounded polling under load. Together they trade immediate notification for batch efficiency and overload control.

In a common driver path, the NIC signals that a queue has completions. The interrupt handler acknowledges or masks further notification for that queue and schedules a NAPI poll. The poll routine processes up to a packet budget. If work remains, Linux schedules further polling; when the queue is drained, the driver completes the poll and reenables notification. Exact interrupt masking and completion rules are driver-specific.

```text
low load:   packet -> interrupt -> NAPI poll -> drain -> interrupts enabled
high load:  packet burst -> interrupt -> repeated bounded polls -> drain
```

Moderation can be configured by time, packet count, adaptive firmware/driver policy, or combinations. Higher coalescing reduces interrupts, improves batching, and can raise throughput. It also holds the earliest packet at the NIC until the condition fires. Adaptive modes may change latency with traffic rate, producing distributions that are hard to infer from one configuration value.

NAPI prevents a busy queue from monopolizing the CPU indefinitely by using budgets, but budget exhaustion defers remaining work. Deferral appears as backlog and tail latency. Other devices and queues sharing the CPU can also compete in softirq processing.

Do not blindly set coalescing to zero. Very high packet rates can create an interrupt storm, reduce useful application CPU, and increase tails. Conversely, a throughput-tuned adaptive profile may be inappropriate for a sparse latency-sensitive feed. Test sparse packets, sustained line rate, and bursts.

Configuration and support vary:

```bash
ethtool -c eth0
ethtool -C eth0 rx-usecs 0 rx-frames 1
```

The second command is only an example of a requested policy; a NIC or driver may reject, round, reinterpret, or override it. Changing production coalescing can affect every flow on a queue and should follow an approved rollback plan.

Measure interrupt count, packet rate, NAPI work, application latency, and CPU usage together. `/proc/interrupts` reveals vector distribution; `/proc/softirqs` and softnet statistics reveal processing pressure. A lower interrupt count is not success if queue residence increased beyond the service target.

## 31.3 Driver, Socket-Buffer, GRO, and Protocol Processing

After a receive completion, the driver turns device-specific metadata and packet storage into a representation usable by Linux networking. The traditional representation is `struct sk_buff`, usually called an **skb**. It holds metadata and references packet data; it is not necessarily one contiguous allocation containing a copied frame.

Driver work can include validating completion status, setting length, recording checksum or VLAN metadata, attaching a hardware timestamp, and passing the packet into XDP or the network stack. Buffer recycling may let packet pages return to a page pool without general allocation. The exact path depends on driver, kernel, offloads, and whether an early hook consumes or redirects the frame.

**Generic Receive Offload** (GRO) combines compatible received packets into a larger logical skb for later protocol processing. It amortizes per-packet work in headers, routing, and sockets. It can change batching and delay, and packet captures above the combination point can display aggregates that never existed on the wire.

GRO behavior differs by protocol and kernel support. TCP aggregation is common; UDP GRO exists in supported configurations but should not be assumed. Hardware large receive offload (LRO) is a different, more device-oriented aggregation facility and can conflict with routing or visibility requirements. Feature names reported by `ethtool` describe capability and current settings, not necessarily use by every packet.

The protocol stack validates link and network headers, processes VLAN or encapsulation metadata, performs IP checks, reassembly where applicable, and enters transport processing. Checksums may be verified in hardware and represented as metadata, or computed/verified in software. “Checksum offload on” does not mean no CPU work: metadata, pseudoheader rules, fallback cases, and validation remain.

Each skb and fragment consumes metadata and contributes to socket memory accounting. Small packets are costly because metadata and per-packet branches are large relative to payload. GRO reduces that rate but can create larger units that occupy caches and are split or copied later.

Inspect features with:

```bash
ethtool -k eth0
```

Correlate feature changes with `perf`, packet rate, and application latency. Disable an offload only in a controlled experiment; it can dramatically raise CPU and alter packet boundaries. Chapter 26's on-wire sizes remain distinct from the internal skb shape observed here.

## 31.4 Routing, Netfilter, Socket Lookup, and User Copies

Linux must classify a received network packet before an application can read it. The path can include route decisions, netfilter hooks, policy, transport validation, socket lookup, enqueueing, wakeup, and copying to user memory. The exact hook sequence depends on local delivery versus forwarding, protocol, namespaces, and kernel configuration.

For a local UDP packet, a conceptual path is:

```text
IP validation -> route says local -> netfilter hooks -> UDP lookup
 -> socket receive-memory admission -> receive queue -> wake waiter
 -> recv syscall -> copy payload/metadata to user buffer
```

Socket lookup uses addresses, ports, protocol, namespace, and reuse/fan-out policy. Large numbers of sockets, wildcard binds, reuse groups, and hash collisions affect work. Linux implementations use hashed structures and optimized lookup, but user code should not depend on a particular internal table.

Netfilter rules can accept, drop, mark, translate, log, or track traffic. Even an eventual accept may execute rule traversal or state lookup. Connection tracking creates per-flow state and has capacity, timeout, lock/contention, and memory implications. Section 31.16 covers operational policy.

When data reaches a socket queue, Linux accounts it against receive memory. A blocked reader may be awakened. Readiness only says an operation may make progress; another thread or packet error can change the result before `recv`. Nonblocking code must still handle `EAGAIN`, short stream reads, truncation flags, and `EINTR` according to the API.

The ordinary socket receive operation copies payload into user-owned memory. That copy can be efficient and cache-warm the bytes for immediate parsing. Avoiding it is not automatically faster if a zero-copy design adds ownership, page pinning, reference counts, or scattered access.

Keep the application buffer preallocated and correctly aligned for its decoder, but do not cast it to wire structs as Section 30.8 explains. Batching several datagrams with `recvmmsg` amortizes syscall and wakeup work while preserving per-datagram lengths.

Tracepoints or eBPF can locate stack and socket delays, but probe choice changes overhead and requires kernel-specific knowledge. Begin with counters and queue evidence, then add the narrowest trace that distinguishes the remaining hypotheses.

## 31.5 Receive-Path Drop Points

A **receive drop** means a frame, packet, datagram, or application event was discarded at a particular layer. One “packet loss” counter cannot identify all layers, and counters at different points count different objects after offloads or aggregation.

Important receive drop points include:

| Layer | Example cause | Evidence source |
|---|---|---|
| Switch/NIC | Congestion or physical/frame error | Switch telemetry, NIC counters |
| RX ring | No posted descriptor/completion overflow | Driver queue counters |
| Driver/NAPI | Allocation failure or backlog pressure | Driver and softnet counters |
| IP/transport | Header, checksum, fragment, policy error | `nstat`, protocol counters |
| Netfilter | Explicit rule or conntrack limit | nftables counters, conntrack stats |
| Socket | Receive-memory limit exceeded | socket/protocol counters, `ss` |
| Application | User queue full or validation rejection | Application counters |

A packet absent from `tcpdump` may have been dropped before the capture hook—or steered to a place not captured. A packet present in a capture can still be dropped later at the socket or application. Capture itself can lose packets and consume CPU.

UDP does not retransmit. Application sequence gaps are therefore the most relevant end-to-end evidence for market data, but a gap does not identify where loss occurred. Redundant feed arbitration can show that only one local path lost the packet, while switch/NIC/kernel counters narrow the layer.

TCP hides many network drops through retransmission. The application instead observes delayed bytes, reduced congestion window, or connection failure. Transport counters and `TCP_INFO` help distinguish loss recovery from application queueing.

Counters can wrap, reset on link or driver restart, or have device-specific meanings. Collect deltas with timestamps and configuration identity. Per-queue counters are crucial: total NIC capacity can look healthy while one RSS queue drops.

Build an incident correlation timeline from venue or sender sequence, hardware/software receive timestamps if available, NIC queue counters, softnet drops, socket drops, and application queue overflow. Align clock domains before comparing timestamps.

Test overload intentionally in an isolated environment. Generate controlled bursts that separately exceed application consumption, socket memory, NAPI service, and NIC ring capacity where safe. The goal is not a maximum rate number; it is a verified mapping from each failure to an observable signal and recovery action.

## 31.6 Transmit Syscalls, Qdiscs, Drivers, and Completion

The transmit path begins when user code submits bytes and ends later when the NIC reports that descriptor resources can be reclaimed. A successful `send` normally means the kernel accepted some bytes into its networking state, not that they reached the peer or even the wire.

A conceptual local transmit path is:

```text
send/sendmsg
 -> copy or reference user data
 -> socket memory + transport/IP headers
 -> route and netfilter
 -> qdisc selection/queueing
 -> driver TX ring
 -> DMA read by NIC
 -> physical transmission
 -> completion and buffer cleanup
```

TCP may accept a short byte count or return `EAGAIN` when nonblocking send space is unavailable. UDP normally submits one datagram atomically with respect to the socket API; oversize or unavailable-buffer errors still need handling. Signals can produce `EINTR` under documented conditions. The application needs an outbound state machine, not one unchecked call.

The **queueing discipline** (qdisc) schedules or shapes packets before driver transmission. Multiqueue devices commonly have a root arrangement feeding per-TX-queue qdiscs, but configuration and kernel paths vary. `noqueue` on some virtual or special devices does not imply that no queue exists anywhere downstream.

Drivers map packet data for DMA and place descriptors in a finite TX ring. If the ring is full, transmission stops that software queue until completions free entries. Linux Byte Queue Limits can control how much data is outstanding in a driver queue for supported drivers, reducing excessive device queueing without changing the physical ring size.

Completion means the NIC no longer needs the DMA buffer according to its driver contract. It is not a peer acknowledgement. Completion cleanup releases skb and page references; delayed cleanup can hold socket memory and zero-copy user pages.

Transmit queueing can occur at the socket, TCP pacing, qdisc, driver, NIC, switch, and receiver. Measure at the semantic boundary needed: syscall acceptance, software/hardware TX timestamp, peer receipt, or application acknowledgement. Only the latter proves remote application processing.

Inspect qdiscs with `tc -s qdisc`, driver queues with `ethtool -S`, and sockets with `ss -mti`. Chapter 32 develops traffic-control behavior. Keep send timestamps and sequence identifiers so a queue delay can be correlated across layers.

## 31.7 GSO, TSO, Checksum, and Receive Offloads

**Segmentation offloads** let upper layers work with a large packet representation while segmentation into MTU-sized frames happens later. Generic Segmentation Offload (GSO) is a Linux software framework; TCP Segmentation Offload (TSO) commonly delegates final TCP segmentation to a capable NIC. Receive offloads aggregate in the reverse direction.

Offloads reduce per-packet CPU work. A large TCP write may become one large skb through much of the stack, then multiple wire frames at the NIC. Checksum offload can ask hardware to complete checksums using metadata. The exact supported encapsulations, headers, and fallback paths depend on the NIC and driver.

The packet observed at a capture point may therefore not match wire boundaries:

- host egress capture can show one large pre-TSO skb;
- host ingress capture can show a GRO aggregate;
- an external tap sees individual wire frames;
- checksum fields in a pre-offload capture can look incomplete.

Do not diagnose malformed wire traffic from a host capture without locating the capture relative to offloads. Conversely, external captures lack some host queue and timestamp context.

Offloads can increase batching and make latency load-dependent. Holding bytes to construct a larger unit, processing a large GRO skb, or queueing a large TSO packet can affect fairness with small latency-sensitive packets. Modern stack and qdisc mechanisms try to account for segments, but behavior is kernel/configuration-specific.

UDP segmentation and receive aggregation exist on supported Linux/NIC combinations, but applications must check feature and API support and preserve datagram semantics. An optimization valid for a bulk telemetry stream may not fit a one-message-per-datagram feed.

Feature toggles are visible through `ethtool -k` and mutable through `ethtool -K` when supported. Changing them can alter CPU, packet rate, captures, and qdisc behavior. Run A/B tests with the same application semantics, record feature state, and use an external capture when on-wire segmentation is material.

The performance question is total work and queueing. Count syscalls, skbs, wire packets, bytes, CPU, and tail latency. “Offload enabled” is not a conclusion.

## 31.8 RSS, RPS, RFS, XPS, and Flow Hashing

**Receive-Side Scaling** (RSS) is NIC hardware distribution of received flows among queues, usually using a hash over selected header fields and an indirection table. Linux software mechanisms can further steer processing: RPS selects receive CPUs, RFS tries to follow application flow locality, and XPS selects transmit queues/CPUs. Availability and exact behavior vary.

RSS seeks two properties: parallelism across flows and stable ordering within one flow. A common NIC uses a Toeplitz-style hash, but hash key, input fields, tunnel parsing, and symmetric behavior are device settings. The indirection table maps hash buckets to receive queues.

Hashing is not load balancing by message cost. One high-rate multicast flow can land on one queue, while many quiet flows occupy others. Several unrelated flows can collide on the same bucket or queue. A `SO_REUSEPORT` group can add another software selection stage depending on socket setup.

Changing an RSS indirection table while traffic is live can remap a flow. Packets already in the old queue and new packets in the new queue can be processed out of order. Whether the device provides a transition guarantee is hardware-specific. Schedule and validate changes carefully.

RPS can enqueue an skb to another CPU's backlog, increasing parallelism when hardware queues are scarce. It also adds interprocessor work and can move packet data away from the NIC-local CPU/cache. RFS uses flow information to improve locality with the consuming application, but maintains tables and is not a substitute for deliberate pinning in a fixed topology.

XPS influences TX queue selection to reduce contention and improve locality. Application CPU, TX queue, NIC port, and completion CPU should be considered together. Multiple senders sharing one queue can contend; too many queues increase rings, interrupts, and memory.

Inspect channels, hashes, and indirection where supported:

```bash
ethtool -l eth0
ethtool -x eth0
ethtool -n eth0 rx-flow-hash udp4
```

Use per-queue counters and CPU utilization to verify actual distribution. Record flow keys and queue/CPU observations in staging. The desired outcome is stable placement with adequate capacity, not the largest possible number of queues.

## 31.9 IRQ Affinity and NUMA Locality

**IRQ affinity** controls which CPUs may handle a device interrupt vector. **NUMA locality** places packet buffers, driver work, application threads, and memory near the NIC's PCIe attachment and one another. Both affect cache, interconnect, and scheduling work.

Multiqueue NICs commonly assign interrupt vectors to queue pairs or groups. `/proc/interrupts` shows counts and vector names; `/proc/irq/<n>/smp_affinity_list` exposes or controls allowed CPUs. An irq-balancing service may change placement unless configured consistently.

The lowest-latency topology often aligns an RX queue interrupt/NAPI context with an application CPU or nearby core and allocates buffers on the local NUMA node. But putting interrupt and application on the same CPU creates direct competition. Some systems dedicate a sibling or nearby core; the best arrangement depends on packet rate, processing work, cache sharing, and SMT topology.

Pinning only the C++ thread is incomplete. Check:

- NIC PCIe NUMA node;
- IRQ/NAPI CPU;
- RSS queue and indirection;
- application affinity;
- socket and user-buffer first touch;
- TX queue/completion placement;
- unrelated interrupts and kernel work.

Linux reports a device NUMA node in sysfs when known. `lspci -vv`, `cat /sys/class/net/eth0/device/numa_node`, `numactl --hardware`, and `lscpu -e` help map topology. A reported `-1` means locality is unknown, not necessarily uniform.

Remote placement can add interconnect transfers for packet data and descriptors. Coherence still makes memory accessible; NUMA policy changes cost, not C++ correctness. A shared LLC boundary or cross-socket link can broaden tail latency under competing traffic.

Affinity configuration has operational risk. Offline CPUs, changed hardware enumeration, container cpusets, or boot settings can invalidate CPU IDs. Apply at startup, verify the effective mask, and fail visibly or use a documented fallback. Do not silently pin every thread to CPU 0 after an error.

Measure migrations, per-CPU interrupts, NUMA events, queue counters, and application latency. Compare same-node and remote-node placement under representative memory and network load. Topology diagrams should be generated from the deployed host, not copied from another machine.

## 31.10 Softirq Budgets and Busy Polling

Linux performs much networking work in **softirq** context. Budgets limit how long or how many packets one processing episode handles before deferring remaining work. **Busy polling** instead has a thread actively poll for arrivals for some period, trading CPU for reduced wakeup and interrupt delay.

When NAPI work exceeds a packet or time budget, processing can continue in a later softirq opportunity or kernel thread context depending on load and kernel behavior. `/proc/net/softnet_stat` exposes per-CPU fields whose meanings are documented by kernel version; drops and time-squeeze-like indicators can reveal backlog or budget pressure. Decode fields with version-aware tooling rather than memorized column positions.

Socket busy-poll facilities such as `SO_BUSY_POLL` can let supported receive calls poll the device's NAPI context for a configured duration. System-wide sysctls and newer APIs vary by kernel. Support requires compatible drivers and packet/socket association. The option is a hint within Linux policy, not a portable socket guarantee.

Application-level polling repeatedly calls nonblocking receive or inspects a bypass ring. It can avoid sleeping but still executes syscalls unless an API exposes memory directly. A tight `recv` loop returning `EAGAIN` consumes front-end and kernel entry work.

Busy polling makes sense when a core is reserved, traffic response matters more than idle efficiency, and the producer path can progress independently. It can harm latency by stealing a CPU from NAPI or the producer, competing on an SMT sibling, increasing heat, or saturating shared resources.

Budgets and polling interact with fairness. A hot queue can monopolize a core up to each budget; a long busy-poll interval can delay unrelated tasks. Isolate roles carefully and preserve CPU time for control, watchdog, and recovery work.

Test idle-to-first-packet, sparse traffic, steady rate, and bursts. Record application CPU time, interrupts, softirq time, `EAGAIN` calls, NAPI budget pressure, and latency percentiles. A lower minimum latency with a worse p99.99 under bursts is not a win.

## 31.11 DPDK, XDP, AF_XDP, and Vendor Stacks

**Kernel bypass** moves selected packet I/O work out of the ordinary socket stack, often exposing userspace-owned rings and DMA-capable buffer pools to a polling application. It can remove syscalls, copies, wakeups, and general protocol processing. It also transfers memory ownership, driver, routing, isolation, and operational responsibilities to the application or framework.

DPDK-style poll-mode drivers commonly bind queues to userspace, allocate huge-page-backed packet pools, poll descriptor rings, and process batches on dedicated cores. Exact APIs and supported hardware belong to DPDK and its poll-mode driver version. A DPDK process does not automatically gain predictable latency if its memory is remote, batches are unbounded, or cores share noisy resources.

**XDP** runs a restricted program early in the Linux receive path, commonly at driver level when supported. It can pass, drop, redirect, or transmit packets before skb allocation. Generic and offloaded modes have different placement and capability. Verification must state which mode is active.

**AF_XDP** connects XDP redirection with userspace rings and a registered UMEM region. Fill, completion, RX, and TX rings coordinate ownership of fixed-size frames. “Zero-copy mode” depends on NIC/driver support and configuration; copy mode remains possible. Ring and UMEM lifetime rules are central to correctness.

Vendor low-latency stacks may interpose socket calls, provide direct NIC APIs, or accelerate selected flows. Their semantics, fallback paths, licensing, observability, and kernel compatibility are product-specific. Test the actual version and confirm which calls/traffic are accelerated.

Bypass costs include dedicated polling cores, pinned/huge memory, buffer management, custom protocol work, loss of familiar firewall/routing tools, privilege, deployment isolation, and recovery after process failure. Security boundaries and operational ownership must be approved, not optimized away.

Use bypass when measured socket-path transitions or stack work violate requirements and the team can own the replacement. Compare equal features: checksums, filtering, sequencing, timestamping, failover, and overload behavior. A raw packet loop is not equivalent to a production socket service.

## 31.12 Zero-Copy Ownership and Buffer Lifetime

Network **zero copy** avoids one or more payload copies by transferring references or ownership of buffers. It does not mean zero CPU, zero DMA, zero cache misses, or zero synchronization.

Receive bypass APIs often use a state cycle:

```text
FREE -> posted to NIC -> RX complete -> owned by application
  ^                                      |
  +------------- returned/recycled <-----+
```

The application must not read before completion, retain after return, or post the same frame twice. A parser view is valid only while the application owns the frame. Fan-out requires copying, reference counts, or delayed recycle, each with cost and backpressure.

Linux zero-copy send facilities can pin or reference user pages and report asynchronous completion through an error queue or API-specific mechanism. The application cannot modify or free the bytes until completion. A successful `sendmsg` does not release that lifetime obligation.

Pinning memory reduces paging flexibility and consumes kernel accounting resources. Long-held receive frames starve the fill ring; long-held transmit pages exhaust completion or socket capacity. Bounded outstanding counts and a timeout/error recovery policy are mandatory.

Copies can be beneficial. Copying a small packet into compact normalized state releases a large frame immediately and places needed bytes contiguously in the consumer's cache. A zero-copy view can retain a whole page or frame for a few fields and cause pointer-chasing across stages.

Ownership should be represented in types or explicit ring indices, not comments alone. Move-only buffer handles can return frames in destructors, but destruction must occur on an allowed thread and must not hide an unbounded operation. Bulk recycling amortizes ring updates but delays availability.

Test double return, leaked buffers, delayed consumers, completion loss, process shutdown, queue reset, and device restart. Track free/fill/receive/transmit/completion ring occupancy. Zero-copy performance is inseparable from correct reclamation.

## 31.13 Socket Batching, Ancillary Data, and Timestamping

Socket batching amortizes system-call and per-call work across messages. Linux `recvmmsg` and `sendmmsg` process arrays of message headers; scatter/gather operations use `iovec` arrays. Each element still has its own length and result.

Batching improves throughput when several messages are already queued. Waiting to fill a batch adds latency, so a receive loop should normally process what is available up to a fixed maximum rather than sleep for a target batch size. Cap work per iteration so timers, session control, and outbound events are not starved.

**Ancillary data** arrives through control messages attached to `recvmsg`-style operations. It can carry destination/interface information, errors, credentials for Unix sockets, and software or hardware timestamps. The caller supplies a bounded control buffer and must iterate headers with the standard macros, checking truncation flags.

Socket timestamping can report different locations and clock domains:

- software timestamps near a kernel path point;
- hardware receive timestamps generated by a NIC clock;
- transmit timestamps delivered asynchronously after later path stages;
- legacy timestamp options with different precision and semantics.

No timestamp is simply “the packet time.” Record its source, clock, and path location. Hardware timestamps need NIC capability and configuration, and their clock often requires synchronization/conversion as Chapter 33 explains.

Receive payload and control data can be truncated independently (`MSG_TRUNC` and `MSG_CTRUNC` indications). Treat truncation as invalid input or a deliberate metadata-loss policy; never parse a partial control structure.

Batch arrays and payload buffers should be preallocated and reused. Large arrays increase stack or cache footprint and may encourage long monopolizing loops. Compare batch sizes using packet-rate distributions, not only a saturated generator.

Verify syscall counts, batch occupancy distribution, per-message residence time, control truncation, and timestamp availability. External captures can validate ordering but not necessarily the same clock or capture point.

## 31.14 Ring, Backlog, Socket, and Application Queue Sizing

The packet path contains a **queue chain**: NIC descriptors, NAPI/backlog state, protocol/socket buffers, user batches, and application queues. Capacity at one layer does not compensate for every other layer, and the same byte can be accounted differently at each.

For a queue with service rate below arrival rate, backlog grows until arrivals slow, packets drop, or capacity is exhausted. Larger capacity changes the time to failure and the age of delivered data; it does not fix sustained overload.

NIC ring sizes are configured within driver/hardware limits. Kernel backlog parameters affect packets awaiting stack processing. Socket `SO_RCVBUF` and `SO_SNDBUF` requests are subject to Linux accounting, doubling conventions, sysctl maxima, autotuning for some protocols, and privilege. Check the effective value with `getsockopt` or `ss -m`, not just the requested value.

Application queues should be sized in semantic units as well as bytes: maximum orders, acknowledgements, market-data packets, or recovery messages. Variable-size payloads need both item and byte limits. Preallocation makes the memory commitment and page-touch behavior visible at startup.

Use burst envelopes to reason about capacity:

```text
required items >= peak arrivals during worst expected service pause
                 - service completed during that interval
```

This is not a guarantee if arrival and pause are unbounded. State the operational envelope and the response beyond it.

Queues can hide one another. A shallow application queue may appear empty while the socket holds a large backlog; timestamps reveal old messages arriving in user space. Conversely, a large application batch can drain the socket counters while events wait internally.

Measure occupancy and oldest-item age at every controllable layer. Vary one capacity at a time in tests. A useful design often keeps enough NIC/socket capacity for short scheduler or interrupt disturbances while enforcing a small semantic application backlog that triggers recovery before stale data is consumed.

## 31.15 Bufferbloat and Bounded Overload Policies

**Bufferbloat** is excessive queueing delay caused by deep buffers that continue accepting traffic. Loss can be low while latency becomes unusable. This occurs in switches, qdiscs, driver/NIC queues, sockets, and applications.

For trading market data, freshness usually dominates eventual delivery of every queued incremental after a large delay. Once sequence continuity is lost or event age exceeds policy, dropping buffered data and recovering from a snapshot may be safer than processing stale updates. For order-entry commands and acknowledgements, discarding can create financial uncertainty; a fail-closed disconnect or reconciliation path may be required.

Bounded overload policies include:

- reject new submissions before enqueue;
- drop newest best-effort telemetry;
- overwrite oldest sample data;
- mark a market-data stream invalid and recover;
- disconnect a session to force explicit reconciliation;
- shed lower-priority work while reserving control capacity.

Each policy must preserve sequence and ownership invariants. Overwriting one slot in a multi-consumer queue can race with readers; use a data structure designed for that policy. Rejecting after partially assigning an outbound sequence may create a gap unless sequence assignment and admission are ordered correctly.

Active queue management in network qdiscs can signal or drop before a queue fills, but it cannot understand application freshness or order semantics. Chapter 32 covers those mechanisms. Application queues need application-aware decisions.

Simple **drop-tail** queues accept until full and then discard new arrivals. They are easy to reason about but allow the maximum configured delay to build and can synchronize transport reactions. Active queue management uses queue state to mark or drop earlier, seeking lower delay and better flow behavior. Whether that helps depends on transport response and placement; a UDP market-data sender does not reduce rate merely because a downstream qdisc dropped an unacknowledged datagram.

Track queue delay directly with enqueue timestamps or sequence age, calibrating timestamp cost. A depth of 100 can mean little at one message per second and disaster at a burst of old messages. High-water marks alone are insufficient.

Load tests should exceed each declared envelope and verify the exact transition: which messages are retained, which counters rise, whether control traffic proceeds, how clients are notified, and how recovery returns to Active. Predictability means failing according to design.

## 31.16 Network Namespaces, Nftables, and Conntrack

A Linux **network namespace** has its own interfaces, routes, neighbor tables, firewall context, and sockets. It is useful for isolation and tests, but packets crossing veth pairs, bridges, namespace boundaries, or container policy can perform more work than a host-bound diagram suggests.

Namespaces do not virtualize hardware independently by default. Several namespaces can share a physical NIC through host routing, bridges, virtual devices, SR-IOV functions, or other mechanisms. Queue, IRQ, and NUMA placement depends on that attachment.

**nftables** programs netfilter rules that match packet metadata and take actions such as accept, drop, mark, reject, or translate. Rule sets can use maps and sets for efficient classification, but exact evaluation and generated kernel representation depend on rule and kernel versions. Logging rules are especially capable of adding work and queueing.

**Connection tracking** records flow state for firewalling and network address translation. It consumes memory and lookup/update work, has table limits and timeouts, and can contend under churn. UDP can create conntrack entries despite lacking a transport connection. Exhaustion or policy mismatch can drop packets.

Do not disable firewalling or conntrack globally in the name of latency. Security, routing, and operational requirements govern them. On an isolated approved critical path, narrow rules or untracked traffic may reduce unnecessary state, but the change needs threat analysis, testing, and rollback.

Namespace-based labs make packet paths reproducible without touching production interfaces. Veth pairs can connect endpoints, nftables counters can prove hook traversal, and `tc netem` can inject impairments in Chapter 32. Virtual paths do not reproduce NIC DMA, hardware queues, offloads, or physical switch behavior.

Inspect inside the relevant namespace:

```bash
ip netns exec feed-ns ip route
ip netns exec feed-ns ss -u -a -m
ip netns exec feed-ns nft list ruleset
conntrack -S
```

Permissions and tool availability vary. Record namespace inode/identity with diagnostics so data from similarly named containers is not confused.

## 31.17 `ethtool`, `ss`, `nstat`, Captures, Tracing, and Drop Tools

Packet-path diagnosis works by correlating observations from several layers. No single Linux tool sees NIC hardware, protocol state, socket queues, application overflow, and on-wire traffic at once.

Start with a low-overhead inventory:

```bash
ip -s link show dev eth0
ethtool -i eth0
ethtool -k eth0
ethtool -c eth0
ethtool -S eth0
ss -s
ss -u -a -m
nstat -az
cat /proc/net/softnet_stat
```

Record kernel, driver, firmware, NIC, namespace, offload, ring, channel, coalescing, affinity, and sysctl configuration. A counter delta without configuration context is difficult to reproduce.

`ss -i` exposes TCP internals such as congestion, RTT, and retransmission fields where available; `ss -m` exposes socket memory accounting. `nstat` reports protocol counters. Names and fields vary with kernel and protocol, so retain raw outputs alongside parsed dashboards.

`tcpdump` and libpcap capture at a configured host hook. They can consume CPU, allocate buffers, drop capture packets, and display GRO/GSO shapes rather than wire frames. Use snap lengths and filters to bound work, note the capture point, and prefer a tap or switch mirror when exact wire boundaries matter. Mirroring can also drop under load.

`dropwatch`, kernel tracepoints, perf, ftrace, and eBPF programs can locate drops or measure path intervals. Tool and tracepoint availability is kernel-dependent. Probes can alter timing, and broad per-packet tracing can overwhelm the host. Begin with a specific hypothesis and capture only the fields needed to test it.

Application observability completes the path: message sequence gaps, receive timestamps, parser rejects, queue residence, high-water marks, recovery transitions, and connection generations. Use bounded per-thread events and export them asynchronously.

A disciplined investigation follows one packet class and time window:

1. establish sender/venue sequence evidence;
2. compare switch and NIC counters;
3. inspect per-queue interrupts, rings, and softnet pressure;
4. inspect protocol and socket memory/drop counters;
5. inspect application queue and validation state;
6. add a narrow capture or trace only where ambiguity remains.

Evidence must respect clock domains and offload boundaries. The result should identify an ownership transition or queue whose capacity/service failed, not merely state that “the network was slow.”

## 31.18 Interview Check

1. Trace one UDP frame from NIC receive descriptor to a C++ parser, naming each ownership transition, queue, and possible copy.
2. Explain how interrupt moderation and NAPI improve efficiency while creating load-dependent latency.
3. Why can a host capture show a packet larger than the interface MTU or an apparently incomplete checksum?
4. A multicast sequence gap occurs while total NIC drops remain zero. Which per-queue, softnet, socket, and application evidence would you inspect next?
5. What does successful `send()` guarantee, and how does it differ from NIC completion and peer acknowledgement?
6. Compare RSS, RPS, RFS, and XPS. How can changing an RSS indirection table risk reordering?
7. Design CPU, IRQ, queue, and memory placement for one latency-sensitive feed, including what you would verify rather than assume.
8. Compare ordinary sockets, AF_XDP zero-copy mode, and a DPDK-style poll loop in ownership, CPU, isolation, and observability.
9. Why can increasing NIC, socket, and application buffers reduce drops yet worsen trading correctness?
10. Build a minimal evidence plan to distinguish wire loss, RX-ring overflow, socket-buffer overflow, and application-queue overflow without relying on one capture point.
