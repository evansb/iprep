# Chapter 26 — From Signals to Ethernet Frames

A market-data message does not jump from one C++ buffer to another. It is wrapped in protocol headers, converted into an Ethernet frame, encoded as signals, serialized onto a medium, forwarded through ports and queues, and reconstructed at the receiver. The link rate explains only one part of that path. This chapter establishes the physical and Ethernet contracts, calculates their irreducible wire costs, and shows where transceivers, switches, filtering, Linux interfaces, DMA, and queueing add latency or loss.

## 26.1 Encapsulation and Cross-Layer Costs

**Encapsulation** adds a protocol's control information around data supplied by the layer above. The reverse operation, **decapsulation**, validates and removes that information at the receiver. A trading message may therefore occupy more bytes at each successive layer:

```text
application message
    [trading header | fields]
UDP datagram
    [UDP header | application message]
IP packet
    [IP header | UDP datagram]
Ethernet frame
    [Ethernet header | IP packet | padding? | FCS]
physical transmission
    [preamble/SFD | Ethernet frame] [inter-packet gap]
```

A layer's input is often called a **service data unit**; after that layer adds a header or trailer, the result is its **protocol data unit**. Names vary by layer—frame, packet, datagram, segment—but the accounting principle is the same. Headers consume link capacity and parsing work even when the application payload is one byte.

The practical Internet stack does not map perfectly onto the seven-layer OSI teaching model. Ethernet covers physical and data-link concerns, IP supplies network-layer forwarding, UDP or TCP supplies transport, and application protocols often combine session, presentation, and application responsibilities. Use layers to locate contracts, not to insist that software must have seven corresponding modules.

Cross-layer terms describe distinct services:

| Property | Meaning | Supplied by ordinary Ethernet? |
|---|---|---|
| Unicast | One addressed receiver | Yes, within a link |
| Broadcast | Every station in a broadcast domain | Yes |
| Multicast | Interested receivers in a group | Addressing exists; reliable interest filtering is separate |
| Anycast | Route to one of several instances sharing an address | Usually a network-layer routing behavior |
| Reliability | Recover lost data | No ordinary frame retransmission |
| Ordering | Preserve an application sequence | Not an end-to-end Ethernet promise |
| Flow control | Protect a receiver from a sender | Limited link mechanisms exist; not an application guarantee |
| Congestion control | Adapt offered load to a network | No end-to-end algorithm |

Connection-oriented and connectionless are likewise service properties, not synonyms for reliable and unreliable. A switched Ethernet link establishes physical state, yet ordinary Ethernet data delivery remains connectionless. TCP later constructs a connection-oriented reliable byte stream over IP; UDP preserves datagrams without such a connection contract.

The control plane establishes state such as routes, memberships, spanning trees, and forwarding entries. The data plane applies that state to each packet. Separating them clarifies costs: an FDB lookup can be fast in steady state, while a link transition or expired membership can trigger flooding and convergence. Control-plane work may not execute on the application CPU, but its state changes the application's loss and latency.

End-to-end delay can be decomposed conceptually:

```text
total = serialization + propagation + processing + queueing
        + host/software work + protocol-dependent recovery
```

Serialization depends on bytes and line rate. Propagation depends on physical distance and medium. Processing depends on NICs, switches, routers, and hosts. Queueing depends on competing traffic and is commonly the least bounded component. Recovery can dominate tails when a higher layer detects and repairs loss.

The **bandwidth-delay product** is the amount of data that can be in flight: bandwidth multiplied by round-trip time. At 10 Gbit/s and 100 microseconds RTT, the product is 1,000,000 bits, or 125,000 decimal bytes. This calculation does not predict latency; it sizes the data needed to fill a path and helps explain windows and buffering in later transport chapters.

MTUs also compose across layers. A link may accept a 1,500-byte IP packet, but a tunnel that adds an outer IP and encapsulation header must either use a smaller inner MTU, rely on a larger underlay, segment before encapsulation, or confront fragmentation. Adding bandwidth does not repair an MTU mismatch. Cross-layer accounting begins with the innermost application record and ends with every byte actually occupying each physical egress.

For every packet path, record the application size, every header and trailer, the maximum transmission unit (MTU), physical overhead, hop count, and possible queues. A packet capture normally begins at an OS or NIC observation point, so it may omit preamble, inter-packet gap, FCS, or offload-generated details. Wire accounting and capture length are not interchangeable.

## 26.2 Physical Media, Encoding, and Link Rates

The physical layer converts a stream of bits into electrical or optical signals suitable for a medium. Copper carries voltage changes; fiber carries modulated light. A **transceiver** joins the host or switch electronics to that medium and performs functions that can include serialization, deserialization, coding, clock recovery, equalization, and diagnostics.

Bits and symbols are different quantities. A **symbol** is one signaling event selected from an allowed set; baud is symbols per second. A symbol may represent less than, exactly, or more than one information bit depending on modulation and coding. Line coding adds structure for clock recovery, transition density, error properties, and control signaling. Therefore a physical signaling rate need not equal the advertised MAC data rate.

For example, some Ethernet families use 64b/66b coding: 64 data bits are carried in a 66-bit coded block. Other rates and media use different coding, lane counts, and modulation. Calculate MAC frame serialization using the Ethernet service rate—10 Gbit/s for 10GbE—unless analyzing a specific PHY. Calculate lane and optical timing only from that PHY's standard and hardware documentation.

A full-duplex Ethernet link can transmit and receive concurrently. Modern high-speed links negotiate or are configured for capabilities and may perform link training to adapt transmitter and receiver settings to the channel. Link establishment is a control event; a port that is still training cannot carry application traffic. Link flaps, marginal optics, and repeated negotiation create outages far larger than one frame time.

High-rate PHYs may divide data across several physical lanes and then realign those lanes at the receiver. Gearboxes can convert electrical lane arrangements between a switch ASIC and an optical module. These pipeline details affect latency and fault counters but are not visible in an Ethernet frame capture. Two ports advertising the same MAC rate can use different modules, FEC modes, lane arrangements, and internal pipelines.

Forward error correction (FEC) adds redundant information that lets a receiver correct some physical errors without retransmission. At higher rates it may be mandatory or operationally valuable. Encoding, block collection, and correction add implementation- and mode-specific latency. Disabling FEC can reduce that component on a supported link but may increase uncorrectable errors or make the link unusable. Treat FEC mode as a jointly engineered property of both endpoints and the medium, never as an isolated latency switch.

The bit-error rate describes erroneous bits relative to transmitted bits under stated conditions. A low rate is not a promise that errors arrive independently; marginal signal integrity can produce bursts. Optical power, connector cleanliness, cable quality, temperature, equalization, and transceiver compatibility all affect error behavior.

On Linux, `ethtool` exposes link and module properties when the driver supports them:

```sh
ethtool eth0
ethtool --show-fec eth0
ethtool -m eth0
```

Output and privileges vary. Correlate negotiated speed, duplex, FEC, module telemetry, and PHY error counters with switch-side observations. A process cannot infer a healthy physical path merely because its interface reports `UP`.

## 26.3 Serialization Delay

**Serialization delay** is the time required to place a given number of bits onto a link:

```text
serialization time = transmitted bit count / link rate
```

Ethernet wire occupancy includes more than the MAC frame. For conventional accounting, add 8 byte-times for the seven-byte preamble plus start-frame delimiter and 12 byte-times for the minimum inter-packet gap. The gap is idle time rather than frame data, but it limits how soon the next frame can begin.

An untagged minimum Ethernet MAC frame is 64 bytes from destination address through FCS. Its wire slot is therefore 64 + 8 + 12 = 84 byte-times, or 672 bit-times. At a 10 Gbit/s MAC rate:

```text
672 bits / 10,000,000,000 bits/s = 67.2 ns
```

This is a calculated minimum link occupancy, not an end-to-end latency claim. It excludes host work, PHY-specific pipelines, propagation, switch forwarding, and receiver processing.

For a conventional untagged frame carrying a 1,500-byte IP packet, the MAC frame has 14 bytes of destination/source/type header, 1,500 bytes of payload, and 4 bytes of FCS: 1,518 bytes. Including preamble/SFD and gap gives 1,538 byte-times, or 12,304 bits.

| MAC rate | Calculated occupancy for this frame |
|---:|---:|
| 1 Gbit/s | 12.304 microseconds |
| 10 Gbit/s | 1.2304 microseconds |
| 25 Gbit/s | 0.49216 microseconds |
| 100 Gbit/s | 0.12304 microseconds |

These values assume decimal Ethernet rates and the stated accounting. A VLAN tag, additional encapsulation, a different payload, or PHY-specific analysis changes the numerator or interpretation.

Serialization occurs at every rate-limited egress. A frame that crosses three independent 10GbE output ports occupies each one for the corresponding time, although cut-through forwarding can overlap transmission across adjacent links. A slow link or speed conversion can dominate. Two hosts both equipped with 25GbE NICs do not obtain 25GbE end-to-end service if an intermediate port, policer, or receiver path is slower.

Packet rate exposes fixed per-frame overhead. Back-to-back minimum slots at 10GbE have a theoretical rate of:

```text
10,000,000,000 / 672 = approximately 14.88 million frames/s
```

The host may reach a CPU, descriptor, PCIe, or interrupt limit earlier. Conversely, offloads can make host work appear to cover larger aggregates even though the NIC still emits legal frames. Always state whether a measurement counts application messages, OS packets, NIC frames, or wire frames.

Serialization also creates a non-preemptive blocking term on ordinary Ethernet. A high-priority frame arriving just after a lower-priority frame begins transmission normally waits for that frame to finish unless every device and link uses a compatible frame-preemption feature. At 10 Gbit/s, the 1,518-byte MAC frame in the preceding example contributes more than a microsecond of link occupancy. Queue priority cannot recover time already committed to serialization.

A burst of `N` equal frames on one egress occupies approximately `N` wire slots. The first frame can depart immediately while the last waits behind `N - 1` slots. This arithmetic gives a lower bound for burst-induced tail latency before considering switch scheduling or competing classes. Measure the burst distribution, not only average bits per second.

## 26.4 Transceivers, Switches, and HFT Hardware

A low-latency physical path is a sequence of devices and media, each with a defined or measured delay and failure mode. The path can include a NIC MAC and PHY, a pluggable optic or direct-attach cable, fiber or copper, switch ingress and egress logic, and another receive chain.

Propagation is constrained by the speed of signals in the medium. Light in typical fiber travels at roughly two-thirds of its vacuum speed, giving an order-of-magnitude estimate near 5 nanoseconds per meter one way. Exact delay depends on fiber and path. Patch panels, slack loops, and geographically indirect routes make map distance an unreliable substitute for measured fiber length.

A switch can use **store-and-forward** behavior, waiting for a complete frame and normally checking its FCS before transmitting it. A **cut-through** switch can begin forwarding after it has received enough header bytes to choose an egress. Cut-through overlaps ingress and egress serialization and can reduce latency for long frames on compatible port speeds. It may begin forwarding a frame whose bad FCS is discovered only later.

These labels do not yield a universal switch delay. A device may change behavior for speed conversion, congestion, certain features, or frame classes. Lookup pipelines, buffering architecture, VLAN processing, multicast replication, telemetry, and timestamping all contribute. Vendor figures also differ in measurement points and traffic conditions. Validate the configured feature set with the exact frame sizes and port pairs used in production.

An uncongested cut-through path does not eliminate queueing. If two ingress ports target one egress at once, only one stream can serialize first. The other waits. A microburst can fill limited shared or per-port buffers even when average utilization is low. Priority queues can protect one class but can also starve another or introduce head-of-line interactions depending on architecture.

NIC and switch timestamping points matter for time analysis. A hardware timestamp near the MAC or PHY excludes most host scheduling delay, but its exact relation to the first bit, start-frame delimiter, or another reference point is device-specific. Precision time synchronization aligns clocks; it does not remove uncertainty caused by asymmetric paths or unspecified timestamp locations. Chapter 33 develops these distinctions.

HFT deployments often value fixed configuration, low-hop topologies, deterministic multicast replication, precise clocks, and detailed counters. Redundancy still matters: the lowest-latency single path is not useful if a failed optic produces an unbounded outage. Document failover behavior, link training time, and the latency of the backup path as carefully as steady state.

Oversubscription must be analyzed at the actual convergence point. Eight 10GbE ingress ports feeding one 10GbE egress can produce a queue even when every ingress is lightly utilized on average. A scheduled test that transmits one flow at a time will miss this interaction. Reproduce synchronized bursts, record per-egress watermarks where supported, and vary frame size because large frames change serialization blocking.

Measure device latency between stated references: first bit in to first bit out, last bit in to first bit out, or timestamp points defined by the vendor. These quantities differ by one or more serialization intervals. A loopback measurement also includes the return path and both timestamp chains. Without named endpoints, subtracting two hardware timestamps can produce a precise number with an ambiguous meaning.

## 26.5 Ethernet Frame Layout

An Ethernet frame carries link-layer addressing, a protocol discriminator or length, payload, optional padding, and an integrity check. A conventional Ethernet II frame appears as follows:

```text
wire order
+----------+-----+----------+--------+----------+----------------+-----+
| preamble | SFD | dst MAC  | src MAC| EtherType| payload/padding| FCS |
| 7 bytes  |  1  | 6 bytes  | 6 bytes| 2 bytes  | 46..1500 bytes |  4  |
+----------+-----+----------+--------+----------+----------------+-----+
                                                         then IFG
```

Preamble helps the receiver synchronize; the start-frame delimiter marks the frame boundary. They are physical transmission overhead and are normally not delivered in a host packet buffer. The 64-byte minimum and 1,518-byte conventional untagged maximum count from destination MAC through FCS, not the preamble or inter-packet gap.

The two-byte field after source MAC is interpreted as an EtherType for Ethernet II framing or as a length in IEEE 802.3 framing according to its value and the applicable protocol. Common EtherTypes include IPv4, ARP, IPv6, and VLAN-tagged frames. Multi-byte fields are transmitted in network byte order where their protocol specifies it.

A payload shorter than 46 bytes in an untagged Ethernet II frame needs padding to reach the 64-byte minimum. That padding belongs to Ethernet framing, not necessarily to the network-layer packet length. A receiver must use the upper-layer length rather than treating every captured payload byte as application data.

The FCS is a 32-bit cyclic redundancy check computed over the MAC frame fields defined by Ethernet. NIC hardware commonly validates and strips it before placing data in host memory, so many captures show neither an FCS nor whether one was originally present. Capture tools may display synthetic or offload-affected checksums. Configure an observation point deliberately when validating physical corruption.

Frames shorter than the valid minimum are commonly counted as runts or undersized frames; frames beyond a device's configured maximum can be counted as giants or oversize frames. Exact counter categories vary, and an oversize frame is not necessarily corrupt if the network intentionally supports jumbo sizes. FCS status, configured MTU, and counter definitions must be read together.

Some networks support jumbo frames with payloads beyond the conventional 1,500-byte IP MTU. “Jumbo” does not identify one universal size. Every NIC, switch port, virtual interface, tunnel, and routing path involved must support a consistent size. A mismatch can cause drops or network-layer fragmentation and PMTU failures. Larger frames reduce per-byte header and per-packet host work but occupy an egress longer and increase loss impact.

## 26.6 MAC Addressing and Broadcast Domains

A MAC address identifies a link-layer destination or source within Ethernet forwarding. The common format is 48 bits. Ethernet transmits each octet according to its bit-order rules, but human notation writes octets in hexadecimal, such as `02:00:5e:10:00:01`.

The low-order bit of the first octet in human notation is the individual/group bit: zero denotes an individual address and one denotes a group address. The next bit is the universal/local bit: one denotes a locally administered address. These flags do not authenticate a sender. Software and virtual interfaces can choose addresses, and attackers can spoof them.

A source MAC should ordinarily be an individual address. Switch learning associates that source with the observed ingress. If the same source appears on two ports, the FDB can move back and forth—a symptom of a loop, duplicate address, failover, or virtualization error. Rapid MAC movement causes intermittent forwarding and flooding whose packet pattern can resemble random application loss.

`ff:ff:ff:ff:ff:ff` is the broadcast address. A switch floods a broadcast within the relevant VLAN or broadcast domain, subject to policy. Routers ordinarily separate broadcast domains; they do not forward ordinary Layer-2 broadcasts between interfaces.

A NIC normally filters received frames according to its programmed unicast addresses, accepted multicast filters, VLAN configuration, and broadcast rules. **Promiscuous mode** requests delivery of frames regardless of ordinary destination filtering. **All-multicast mode** requests all multicast frames while retaining unicast filtering. Driver and hardware capabilities determine which filtering occurs in silicon and which spills into software.

Filtering affects both correctness and CPU work. If a multicast filter table is too small, a NIC may use a hash filter with collisions or accept all multicast, causing the host to process unrelated traffic farther up the stack. Promiscuous capture can perturb the system being measured by adding DMA, descriptors, cache traffic, and packet processing.

Linux displays address and flag state with:

```sh
ip -details link show dev eth0
ip maddress show dev eth0
```

Do not change modes on a production feed interface merely to diagnose traffic. Prefer a switch mirror, a dedicated capture port, or a controlled duplicate receiver when the extra load would compromise the critical path.

## 26.7 VLAN Tags and Frame Size

An IEEE 802.1Q VLAN tag inserts four bytes between the source MAC and the original EtherType. It contains a tag protocol identifier followed by tag control information, including a 12-bit VLAN identifier and priority-related bits.

```text
[dst 6][src 6][TPID 2][PCP/DEI/VID 2][inner EtherType 2][payload][FCS]
```

An **access port** commonly associates untagged traffic with one VLAN and emits it according to that port's access policy. A **trunk port** carries tagged traffic for multiple VLANs. Exact native-VLAN and admission behavior is switch configuration, not a universal meaning of “trunk.” Misconfiguration can leak traffic, create duplicate domains, or make one direction work while the other fails.

For the same 1,500-byte network-layer payload, one VLAN tag grows the conventional MAC frame from 1,518 to 1,522 bytes. Equipment often calls this a tagged or “baby giant” frame relative to the untagged maximum. The IP MTU can remain 1,500 because the link accommodates the tag outside the IP packet. Stacked tags add further bytes and require corresponding link support.

The Ethernet minimum frame size remains governed by the medium's collision-era slot requirement; adding a tag reduces the padding needed for a short payload rather than requiring a second minimum-sized payload. Captures may show tags inserted or removed by NIC VLAN offload. A packet observed before hardware insertion can appear untagged even though the wire frame is tagged.

The priority code point can select traffic class when the network is configured to honor it. Marking alone does not create capacity or guarantee latency. Queue mappings, trust boundaries, schedulers, and policers across every hop determine the result. A high-priority microburst can still queue behind a frame already serializing on a non-preemptive link.

Verify VLAN state at several layers:

```sh
ip -details link show
bridge vlan show
ethtool -k eth0 | grep -i vlan
```

When comparing capture length with wire occupancy, record whether tags and FCS are visible and whether hardware offload is enabled.

## 26.8 Switching, Forwarding Tables, and Queueing

An Ethernet switch learns which source MAC addresses are reachable through which ports and uses a **forwarding database** (FDB) to choose egress ports. Learning and forwarding are usually scoped by VLAN.

On receiving a frame, a conventional learning bridge conceptually performs:

1. Learn or refresh the source MAC and ingress port for that VLAN.
2. If the destination is a known unicast on another port, forward there.
3. If it is an unknown unicast, broadcast, or unsnooped multicast, flood to eligible ports.
4. If the learned destination is the ingress port, filter it.

Hardware implements this pipeline in device-specific tables and stages. FDB capacity is finite. Entry aging, topology changes, table exhaustion, or source movement can turn a previously directed flow into flooded traffic and change both load and information exposure.

Layer-2 loops are dangerous because Ethernet frames have no hop limit. A broadcast or unknown unicast can circulate and multiply, consuming links and making MAC learning unstable. Spanning Tree protocols establish a loop-free active topology by blocking selected paths. Convergence and blocked links affect failover behavior; low-latency networks sometimes use tightly controlled loop-free designs, but removing loop prevention without an equivalent invariant is unsafe.

Link aggregation joins physical links into one logical link for capacity or redundancy. Switches and hosts commonly select a member using a hash over some combination of MAC, IP, and transport fields. A single flow often remains on one member to preserve order, so aggregate capacity does not imply that one feed receives the sum of member rates. Hash collisions can place several busy flows on one link while another is idle.

Aggregation also creates a two-sided configuration contract. Static bundling and a negotiation protocol such as LACP must agree with switch and host membership. During failure, detection and redistribution take time; frames already queued on the failed member can be lost. A receiver's application sequence is the final authority on continuity even when the bond reports a successful failover.

An egress queue forms whenever offered traffic temporarily exceeds that port's transmission opportunity. Queueing delay for `B` bytes ahead on a rate `R` link is at least `8B/R`, before device-specific scheduling. Buffers absorb bursts but convert overload into latency. When full, they drop frames. Multiple priorities or shared buffers can produce head-of-line blocking, starvation, or cross-port interactions depending on architecture.

Inspect a Linux bridge FDB with:

```sh
bridge fdb show
bridge link show
```

On a physical switch, obtain port counters, FDB state, queue occupancy or watermark telemetry, and discard reasons if available. Average utilization alone cannot diagnose microburst queueing.

## 26.9 FCS, Loss, and Error Handling

The Ethernet FCS detects many classes of corruption; it does not repair a frame and ordinary Ethernet does not retransmit a lost or corrupt data frame end to end. A receiver that detects a bad FCS normally discards the frame. Higher layers or the application must detect missing information and recover when required.

Loss has several distinct sources:

- Physical corruption, loss of signal, or coding failure.
- NIC receive-ring or device-buffer exhaustion.
- Switch ingress, shared-buffer, or egress-queue exhaustion.
- A policer or access-control rule.
- VLAN, FDB, multicast, or link-aggregation misconfiguration.
- Host software queues and socket buffers, covered in Chapter 31.

A CRC is strong error detection for its intended frame model, not cryptographic authentication. An attacker can construct a valid FCS. Nor does a good FCS prove that the sender encoded a valid IP or application message. Each layer validates its own contract.

Pause mechanisms can ask a directly connected sender to stop transmitting globally or by priority, depending on Ethernet features and configuration. They can prevent a local drop but propagate congestion backward and produce large latency excursions. Whether pause is enabled, honored, and appropriate is an operational network decision. It is not a substitute for application overload policy.

Error counters require careful interpretation. A switch ingress FCS counter points toward the incoming physical segment; an egress discard counter points toward queue or policy behavior. NIC counters are driver and hardware specific, and names are not standardized:

```sh
ip -s link show dev eth0
ethtool -S eth0
```

Take counter deltas over a defined interval and correlate both ends of every link. A zero application gap count does not prove zero link loss if the feed was idle; a sequence gap does not prove physical corruption because any downstream queue may have dropped the packet.

## 26.10 ARP and IPv6 Neighbor Discovery Placement

Before an IP packet can cross an Ethernet link, the sender needs the link-layer address of the next hop. ARP provides this mapping for IPv4. IPv6 Neighbor Discovery (ND), carried in ICMPv6, provides corresponding discovery plus other link functions for IPv6.

For a destination on the local IPv4 subnet, the host resolves the destination's MAC. For an off-subnet destination, it resolves the next-hop router's MAC, not the remote host's. A typical ARP exchange broadcasts a request and receives a unicast reply:

```text
host A: Who has 192.0.2.9? Tell 192.0.2.1.   [broadcast]
host B: 192.0.2.9 is at 02:00:00:00:00:09. [unicast]
```

ARP is carried directly in an Ethernet frame with its own EtherType. It conceptually joins Layer 2 addressing to Layer 3 configuration. ND is part of IPv6 and uses solicited-node multicast instead of Ethernet broadcast for ordinary address resolution. Chapter 27 discusses ICMPv6's network-layer role.

Linux maintains a neighbor table with states reflecting reachability knowledge. A missing or stale entry can cause the triggering packet to be queued while probes run. Resolution delay is vastly larger and less predictable than a warmed table lookup, and failure can discard queued traffic after retries.

Reachability state is not binary. Linux can retain a valid link-layer mapping while marking reachability stale, use it optimistically, and probe later; failed or incomplete entries follow different paths. Kernel details and timers are configurable and version-specific. For latency analysis, distinguish a resident usable mapping, a deferred confirmation, an active resolution, and a failed neighbor rather than grouping all as “ARP cost.”

```sh
ip neigh show dev eth0
ip -s neigh show dev eth0
```

Gratuitous ARP announcements and unsolicited neighbor advertisements can update peers after address movement or failover. They can also be spoofed. Static entries, switch inspection features, segmentation, and cryptographic protections at higher layers are possible controls, each with operational tradeoffs.

A low-latency service should make neighbor state observable and should exercise the failover path before relying on it. Sending periodic traffic can help retain state but does not guarantee it; kernels and switches age entries and links fail. Do not encode an undocumented neighbor-cache timeout as a correctness assumption.

## 26.11 Layer-2 Multicast

An Ethernet multicast address has the group bit set and can identify many receivers. IP multicast maps a network-layer group to an Ethernet multicast destination so a switch can replicate one ingress frame to interested ports.

IPv4 maps the low 23 bits of a multicast group into the MAC prefix `01:00:5e`. Because an IPv4 multicast address has 28 group-identifying bits after the fixed high-order pattern, 32 different IPv4 groups map to the same Ethernet address. IPv6 maps the low 32 bits of its multicast address to `33:33:xx:xx:xx:xx`, also a many-to-one mapping. A receiver must filter at IP and transport layers; a MAC match alone is insufficient.

Without membership awareness, a switch treats multicast much like broadcast and floods it within the VLAN. **IGMP snooping** for IPv4 and **MLD snooping** for IPv6 let a switch observe network-layer membership exchanges and restrict forwarding to interested ports. Snooping requires correct state, timers, and usually a querier. Missing or stale state can either flood unwanted traffic or prune wanted traffic, depending on implementation and failure mode.

Multicast replication consumes egress capacity independently on every selected port. A single ingress packet can therefore create many simultaneous egress demands. Slow receivers do not exert end-to-end flow control on the sender; their ports or hosts drop when buffers fill. This property suits one-to-many market data but shifts sequence checking and recovery to the application.

Forwarding remains VLAN-scoped. Two receivers can join the same IP group on different VLANs yet require a router or multicast gateway between them; Layer-2 replication alone does not cross that boundary. Conversely, an unsnooped group can reach every eligible port in one VLAN even when only one host requested it. Count replicated egress bytes, not just ingress bytes, when checking switch capacity.

MAC-level multicast membership is coarser than an IP socket subscription because several network-layer groups can share one destination MAC. The NIC may accept the frame and DMA it before the IP layer rejects the unwanted group. This makes switch snooping and exact NIC filters performance features as well as traffic-delivery features.

NIC multicast filters may be exact, hashed, or capacity limited. Joining hundreds of groups can increase false-positive delivery or force all-multicast behavior on some hardware. Observe both switch replication state and host receive counters. Chapter 28 covers socket membership, source filters, sequence gaps, and redundant feeds.

## 26.12 Linux Interfaces, Bridges, Bonds, VLANs, and Veth Pairs

A Linux network interface is a kernel networking endpoint, not necessarily a physical port. The same packet APIs operate over several interface kinds with very different data paths.

| Interface | Purpose | Important cost or constraint |
|---|---|---|
| Physical NIC | Connect host to a physical link | DMA rings, driver, PHY, offloads |
| `lo` | Host-local loopback | No physical Ethernet transmission |
| VLAN | Add/remove a configured 802.1Q tag | Often offloaded; inherits lower device |
| Bond | Combine links for redundancy/capacity | Mode and hash govern ordering/failover |
| Bridge | Software Layer-2 forwarding | FDB lookup, netfilter/configuration effects |
| Veth pair | Connected virtual interfaces | Crossing transfers packets between namespaces/stacks |
| TAP | Ethernet frames exchanged with user space | File-descriptor copies/wakeups unless optimized |
| Macvlan | Multiple MAC-facing virtual interfaces | Host/parent communication constraints vary by mode |

`ip link` creates and configures these objects; `bridge` manages Linux bridge details; `ethtool` queries physical devices and offloads. Example inspection commands are read-only:

```sh
ip -details -statistics link show
bridge -details link show
bridge vlan show
ethtool -i eth0
ethtool -k eth0
```

A VLAN interface such as `eth0.100` can present an ordinary IP interface while tagging frames on `eth0`. A bridge connects eligible ports into one broadcast domain and learns source MAC addresses. A bond's behavior depends on mode: active-backup emphasizes failover, while hashing modes distribute flows under negotiated switch configuration. Do not assume per-packet striping or lossless failover.

A veth pair is useful for isolated experiments. Frames or packets sent into one end appear at the other, often in another network namespace. It models kernel forwarding and namespace boundaries, not NIC DMA, PHY serialization, switch silicon, or real propagation. Performance conclusions from veth must remain scoped to the virtual path.

Linux bridges can participate in VLAN filtering, multicast snooping, and netfilter hooks depending on configuration. A bridge is therefore not guaranteed to be a trivial software wire. A host may also route between interfaces instead of bridging them; routing decrements the network-layer hop field and replaces the link header, while bridging forwards at Layer 2. Capture both ingress and egress when the intended mode is unclear.

Offloads complicate observation. VLAN insertion, checksum calculation, segmentation, and receive aggregation may occur after or before a capture hook. Compare captures at relevant points and inspect offload flags before declaring a malformed wire frame. Chapter 31 follows Linux's physical packet path in detail.

## 26.13 Copies, DMA, Queues, and Per-Packet Work

A high-level send operation expands into ownership transfers, metadata operations, queueing, and device work. **Direct memory access** (DMA) lets a NIC read or write host memory without the CPU copying every byte instruction by instruction. DMA is not “free”: buffers must be allocated, mapped or registered as required, described in rings, synchronized for ownership and cache coherence, and eventually reclaimed.

A simplified receive path is:

```text
wire -> NIC parser -> RX queue -> DMA into host buffer
     -> descriptor completion -> driver/NAPI -> protocol stack
     -> socket queue -> copy or map to application -> application queue
```

Every arrow may hide a queue or ownership boundary. The NIC receive ring has finite descriptors. Driver backlogs, socket buffers, and application rings also have finite capacity. A burst can overflow any one of them even if the long-run byte rate is modest. Counters at later layers cannot report packets already lost earlier.

Small packets emphasize fixed per-packet work: descriptor processing, metadata initialization, route and socket lookup, interrupt or polling work, cache-line movement, and application dispatch. Large packets emphasize byte movement and serialization. Batching amortizes calls and ring notifications but waits for a batch or lets one packet hold work behind it. Offloads can shift segmentation, checksums, or filtering to hardware; they do not remove wire frames or queueing.

Ring size changes where overload becomes visible. A larger receive ring can absorb a longer burst but also lets stale packets wait farther from the application. A smaller ring drops sooner and keeps the queued working set bounded. There is no capacity that eliminates overload; choose one from the burst budget, recovery behavior, and acceptable age of delivered data, then monitor occupancy and drops.

Transmit follows the reverse ownership direction: application data enters kernel or registered buffers, protocol headers are produced, a queue and NIC descriptor are selected, DMA reads the bytes, and the NIC serializes the frame. Completion means a specific layer has finished with a buffer; it does not necessarily mean the receiver consumed the packet. APIs must define which completion they report.

NUMA placement matters on multi-socket hosts. If the NIC is attached to one NUMA node while the receiving thread and buffers live on another, descriptor and payload access can cross the interconnect. Queue-to-CPU affinity, memory placement, and interrupt routing must be designed together. Chapter 31 covers RSS, NAPI, IRQ affinity, and busy polling.

Verify the whole chain with layer-appropriate evidence:

- NIC and driver counters from `ethtool -S`.
- Interface counters from `ip -s link`.
- Queue, interrupt, and softirq observations from Linux tools.
- Switch port and queue counters.
- Packet captures with documented capture point and offloads.
- Application sequence, queue-depth, and drop counters.

The critical distinction is byte rate versus packet rate. A link can have ample unused bandwidth while the host exhausts per-packet processing capacity, and a host can process packets quickly while one egress queue adds an unacceptable tail.

## 26.14 Interview Check

1. Draw the encapsulation of a trading message inside UDP, IPv4, and Ethernet. Which bytes would a typical host capture omit compared with wire occupancy?
2. Separate serialization, propagation, processing, and queueing delay. Which terms are fixed for a given frame and path, and which produce burst-dependent tails?
3. Calculate the wire occupancy of a minimum untagged Ethernet frame at 10 Gbit/s, including preamble/SFD and inter-packet gap. Explain why the result is not an end-to-end latency.
4. Compare cut-through and store-and-forward switching. What happens to their difference under congestion, speed conversion, or a corrupt frame?
5. Explain the fields and size of an untagged Ethernet II frame carrying a 1,500-byte IP packet. How does one VLAN tag change the accounting?
6. Given a switch receiving unknown unicast and multicast traffic, describe FDB learning, flooding, IGMP snooping, and the failure mode created by a Layer-2 loop.
7. A market-data receiver reports sequence gaps while all NIC FCS counters remain zero. List at least five other drop points and the evidence needed to distinguish them.
8. Explain why 32 IPv4 multicast groups can map to one Ethernet multicast MAC and why the receiver still needs network- and transport-layer filtering.
9. Compare a physical NIC, Linux bridge, bond, VLAN interface, and veth pair. Which aspects of a veth benchmark cannot predict physical-network latency?
10. Trace ownership of an incoming buffer from NIC DMA to application processing. Where can finite queues overflow, and how would NUMA placement change the cost?
