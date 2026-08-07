# Chapter 27 — IP Addressing, Routing, and Multicast

IP extends communication beyond one Ethernet broadcast domain by assigning network-layer addresses and selecting a next hop at each router. That service is connectionless and best effort: it does not make ordinary datagrams reliable, ordered, or latency-bounded. This chapter develops IPv4 and IPv6 headers, prefix-based routing, control-plane decisions, fragmentation, ICMP, translation, multicast, and Linux inspection, then assembles them into a defensible per-hop cost model.

## 27.1 IPv4 Headers and Checksums

An IPv4 header describes how a packet is addressed, bounded, fragmented, and forwarded. Its minimum size is 20 bytes; options can extend it to 60 bytes. The Internet Header Length (IHL) gives the header size in 32-bit words.

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-------+-------+---------------+---------------------------------+
|version|  IHL  |   DSCP/ECN    |          total length           |
+-------------------------------+---------------------------------+
|        identification         |flags|       fragment offset     |
+---------------+---------------+---------------------------------+
|      TTL      |   protocol    |         header checksum         |
+---------------------------------------------------------------+-+
|                         source address                          |
+----------------------------------------------------------------+
|                       destination address                       |
+----------------------------------------------------------------+
|                    options, if IHL > 5                          |
+----------------------------------------------------------------+
```

Version is 4. Total length counts the entire IPv4 packet, header included, and is 16 bits. A parser must verify that IHL is at least 5, that `IHL * 4` does not exceed total length, and that total length fits the received buffer before accessing the payload.

DSCP can classify traffic for differentiated treatment; ECN can signal congestion without a drop when every relevant layer supports and configures it. Markings alone promise neither priority nor low latency. Networks can remark, ignore, police, or map them into different queues.

Identification, flags, and fragment offset support IPv4 fragmentation. The Don't Fragment (DF) flag prohibits router fragmentation; More Fragments indicates that another fragment follows. The offset is measured in eight-byte units. Section 27.8 covers the resulting reassembly and loss behavior.

Time to Live (TTL) is decremented by each router. A router discards a packet whose TTL expires and can send ICMP Time Exceeded. The protocol field identifies the next payload, such as ICMP, TCP, or UDP. Source and destination are 32-bit addresses.

The IPv4 checksum is a one's-complement checksum over the header, not the payload. Because TTL changes at every routed hop, a router must update the checksum. Implementations can update it incrementally rather than recomputing all words. Ethernet FCS and transport checksums cover different data at different scopes; one does not make the others redundant.

The maximum value of the 16-bit total-length field is 65,535 bytes, but the usable path MTU is usually much smaller. A large local send can be divided by transport or NIC offloads before reaching the wire; that host-side representation does not authorize an oversized IP packet on the path. Inspect captures on the wire-facing side when validating actual packet size.

Checksum validation must handle one's-complement arithmetic correctly, including end-around carry. Hand-written parsers should be tested against independent packet construction and malformed corpora. On receive, checksum offload can make a capture appear to contain an unchecked packet; on transmit, a capture can show a placeholder before the NIC fills it. The capture metadata and offload state determine interpretation.

Options make the header variable and often take a slower or specially handled path in routers. Network hardware policy varies: unsupported or unexpected options may be punted, rate-limited, or dropped. A fast parser should handle variable IHL correctly even if production policy normally forbids options.

A bounds-first C++23 view can expose fields without unaligned typed loads:

```cpp
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

struct Ipv4View {
    std::span<const std::byte> header;
    std::uint16_t total_length;
};

std::optional<Ipv4View> parse_ipv4(std::span<const std::byte> packet) {
    if (packet.size() < 20) return std::nullopt;

    const auto first = std::to_integer<unsigned>(packet[0]);
    const auto version = first >> 4;
    const auto header_size = (first & 0x0fU) * 4U;
    if (version != 4 || header_size < 20 || header_size > packet.size()) {
        return std::nullopt;
    }

    const auto total = static_cast<std::uint16_t>(
        (std::to_integer<unsigned>(packet[2]) << 8) |
         std::to_integer<unsigned>(packet[3]));
    if (total < header_size || total > packet.size()) return std::nullopt;

    return Ipv4View{packet.first(header_size), total};
}
```

The view does not own bytes; it must not outlive the receive buffer. A production parser would validate checksum and fragmentation policy and would expose addresses and payload only after corresponding checks. The bytewise form is portable and safe; a target-specific optimized implementation must preserve those semantics.

## 27.2 IPv6 Base and Extension Headers

IPv6 uses a fixed 40-byte base header. It expands addresses to 128 bits and moves optional information into chained extension headers.

```text
+---------+---------------+--------------------------------------+
| version | traffic class |              flow label              |
+-------------------------+-------------------+------------------+
|      payload length     |    next header    |    hop limit     |
+----------------------------------------------------------------+
|                    source address: 128 bits                    |
+----------------------------------------------------------------+
|                 destination address: 128 bits                  |
+----------------------------------------------------------------+
```

The first 32 bits hold version, traffic class, and a 20-bit flow label. Payload length normally counts bytes after the base header. A zero value has special meaning in the separately specified jumbogram mechanism; ordinary code must not interpret zero as a universally empty payload without considering policy.

The flow label can help devices identify packets belonging to a flow without examining transport headers, but its generation and use depend on endpoint, network, and policy. It is not a latency reservation. Changing it can alter an ECMP decision on equipment that includes it in a hash, so packet generators should preserve it during controlled comparisons.

The Next Header field identifies either an upper-layer protocol or the first extension header. Each extension can identify another header, forming a chain. Hop Limit serves the forwarding role of IPv4 TTL. Source and destination addresses each consume 16 bytes.

IPv6 has no base-header checksum. This removes per-hop checksum update work, though routers still decrement Hop Limit and upper layers still provide their specified integrity checks. Ethernet FCS protects only one link and is normally regenerated at the next link.

Extension headers carry functions such as hop-by-hop options, routing information, destination options, authentication, and fragmentation. They restore variable parsing beyond the fixed base header. A robust parser must bound both byte count and number of headers, reject malformed lengths and loops in its own state machine, and follow local security policy. Hardware fast-path support is device-specific; long or unusual chains may be dropped or handled more slowly.

The base header's Next Header can also state that no next header follows. Unknown extension types and invalid ordering need an explicit policy; treating their bytes as UDP or TCP is unsafe. Firewalls and load balancers that inspect transport ports must either walk the chain correctly or reject what they cannot classify. Attackers can exploit disagreement between devices, so every boundary should use compatible parsing rules.

IPv6 routers do not fragment ordinary packets in transit. A source uses a Fragment extension header when fragmentation is necessary. Routers that cannot forward a packet because of MTU send ICMPv6 Packet Too Big. This makes ICMPv6 availability essential to ordinary path behavior.

The larger base header reduces payload capacity relative to a minimum IPv4 header under the same link MTU. With Ethernet IP MTU 1,500 and UDP, an ordinary unextended IPv6 datagram has 1,500 - 40 - 8 = 1,452 bytes available for UDP payload; the analogous minimum-header IPv4 value is 1,472. Application framing must use the configured path constraints rather than hard-code either number.

## 27.3 Addressing, Prefixes, and Subnetting

CIDR notation pairs an address with a **prefix length**: the number of high-order bits identifying a network. IPv4 has 32 address bits, so `192.0.2.0/24` fixes the first 24 and leaves 8 host bits. IPv6 has 128 bits, so `2001:db8:1::/64` fixes the first 64.

Subnet masks are not type boundaries. Classful A/B/C routing is historical; modern forwarding uses explicit prefixes of arbitrary valid length. A `/32` IPv4 or `/128` IPv6 route names one address. A `/0` prefix matches every address and forms a default route when no more specific route applies.

For conventional IPv4 multi-access subnets, the all-zero host part names the network and the all-one host part is the directed broadcast address. Point-to-point and host-route configurations have specialized rules, so code should not reject addresses from folklore alone. Linux derives broadcast settings from interface configuration and allows them to be displayed explicitly.

Prefix arithmetic is bit arithmetic. `192.0.2.130/26` fixes 26 bits, leaving six host bits. Blocks therefore contain 64 addresses and begin at fourth-octet multiples of 64; this address belongs to `192.0.2.128/26`. The conventional directed broadcast is `192.0.2.191`. Do calculations in an unsigned representation with an explicit mask, and avoid shifting by the type width when handling `/0`.

IPv6 text compresses consecutive zero groups with `::` once and omits leading zeros within groups. Text has multiple equivalent spellings; compare parsed binary addresses, not raw strings. IPv6 commonly uses `/64` on LANs because address configuration and neighbor mechanisms are designed around it, but routing itself supports other prefix lengths.

Subnetting controls which destinations are considered on-link. For an on-link destination, the sender resolves that destination's neighbor address. For an off-link destination, it selects a route and resolves the next-hop router. A broad, incorrect on-link prefix can therefore trigger futile neighbor discovery instead of using a gateway.

Address lookup and arithmetic should use unsigned fixed-size bytes or integers with explicit network order. Never type-pun an unaligned packet buffer into a C++ header structure and assume compiler padding matches the wire. Bounds, lifetime, alignment, and byte order remain part of correctness.

## 27.4 Special Address Ranges

Several address ranges carry defined or conventional roles and should not be treated as ordinary globally routed unicast.

| Family | Range | Purpose |
|---|---|---|
| IPv4 | `0.0.0.0` | Unspecified address |
| IPv4 | `127.0.0.0/8` | Loopback |
| IPv4 | `10.0.0.0/8` | Private use |
| IPv4 | `172.16.0.0/12` | Private use |
| IPv4 | `192.168.0.0/16` | Private use |
| IPv4 | `169.254.0.0/16` | Link-local |
| IPv4 | `224.0.0.0/4` | Multicast |
| IPv4 | `255.255.255.255` | Limited broadcast |
| IPv4 | `192.0.2.0/24` | Documentation and examples |
| IPv6 | `::` | Unspecified address |
| IPv6 | `::1` | Loopback |
| IPv6 | `fe80::/10` | Link-local unicast |
| IPv6 | `fc00::/7` | Unique-local address space |
| IPv6 | `ff00::/8` | Multicast |
| IPv6 | `2001:db8::/32` | Documentation and examples |

The table is not a complete registry. Address assignment and routing policy evolve; consult the applicable standards and operational registry when building validators or filters. In particular, “not private” does not imply “publicly routable.” Reserved, benchmarking, documentation, carrier, and special-purpose ranges exist.

IPv4 supports broadcast. IPv6 has no broadcast address; it uses scoped multicast for functions that would otherwise reach a group of nodes. IPv6 multicast addresses encode scope, so link-local and wider groups must not be conflated.

**Anycast** assigns the same unicast address to multiple instances and lets routing deliver a packet to one selected instance, typically the closest under routing policy. The address does not identify all replicas, and the selected instance can change after routing convergence. Stateful applications must account for that behavior.

Link-local IPv6 addresses often require an interface scope identifier because the same prefix exists on every link, for example `fe80::1%eth0` in suitable text syntax. Omitting the interface can make the destination ambiguous.

Use documentation ranges in examples and labs. Do not copy arbitrary production-looking public addresses into test configurations, and do not assume that a private range is collision-free across merged networks or VPNs.

## 27.5 Routing Tables and Longest-Prefix Matching

A router or host selects a route by **longest-prefix match**: among matching routes, the one with the greatest prefix length is most specific. Metrics and protocol preferences then distinguish candidates according to implementation and configuration rules.

Suppose a host has:

```text
192.0.2.42/32    via 10.0.0.9
192.0.2.0/24     via 10.0.0.2
0.0.0.0/0        via 10.0.0.1
```

Traffic to `192.0.2.42` uses the `/32`, traffic to `192.0.2.43` uses the `/24`, and unmatched traffic uses the default. A lower metric on the default does not make it beat a matching `/24`; specificity is considered first in the normal route selection model.

The routing control plane maintains routing information and selects paths. The forwarding plane uses a forwarding information base (FIB) optimized for packet lookup. Hardware routers commonly program specialized tables; Linux maintains kernel data structures whose details change across versions. The semantic result matters more than assuming a literal linear table scan.

A selected route identifies an output interface and may identify a gateway. A directly connected prefix normally has no gateway: the destination itself is the neighbor. A gateway route resolves the gateway's link-layer address. Route lookup does not by itself guarantee that neighbor resolution has completed.

Routing tables can also contain local, unreachable, prohibit, throw, and blackhole behavior rather than a forwarding next hop. A blackhole route discards deliberately; an unreachable route can return an error; local routes deliver to the host. These distinctions matter when an application sees immediate send errors versus silent network loss. Exact Linux route types and error reporting are kernel interfaces, not universal IP behavior.

Source-address selection is part of the host decision on a multihomed system. The chosen route, preferred source, socket binding, and policy rules interact. A correct destination next hop paired with the wrong source can be rejected by remote policy or return along an unintended path. Reproduce diagnostics with the same bound source and mark as the application.

Linux asks the kernel for its actual decision with:

```sh
ip route get 192.0.2.42
ip -6 route get 2001:db8:2::42
```

Add source address, input interface, mark, or other selectors when reproducing a policy-dependent lookup. Reading `ip route show` and mentally choosing one route can miss policy rules or source selection.

Modern Linux does not use the old global per-destination IPv4 route cache removed from the main path years ago, but sockets and protocol structures can retain destination information, and the kernel maintains exceptions and neighbor state. Exact caching is implementation- and version-specific. A cold synthetic lookup can differ from a connected socket's steady state.

Route-table size, prefix distribution, CPU cache state, and updates can affect lookup cost. In many low-latency host paths, a neighbor miss or egress queue dominates a warmed FIB lookup. Verify with kernel tracing or profiling before optimizing a route representation the kernel owns.

## 27.6 Policy Routing and ECMP

**Policy routing** selects a routing table using properties beyond the destination prefix. Linux rules can match source prefixes, input interfaces, firewall marks, and other selectors, then consult one of several tables.

```sh
ip rule show
ip route show table main
ip route show table 100
```

Rules are ordered by priority. More rules and tables can add lookup work, but the larger risks are configuration ambiguity and asymmetric paths. A reply sourced from a different interface or table may fail reverse-path checks, stateful firewalls, or exchange allowlists.

**Equal-cost multipath** (ECMP) installs several next hops for a prefix. Implementations commonly hash a flow's addresses, protocol, and sometimes ports to select one next hop, preserving packet order for that flow while spreading many flows. Hash fields, seeds, weights, and resilience during next-hop changes are implementation details.

Per-flow hashing means one market-data flow usually receives one path's capacity and latency, not the sum of all paths. Several important flows can collide onto the same member. A topology can also suffer hash polarization when multiple layers make correlated choices from similar fields.

When a next hop fails, ECMP membership changes can remap flows. Packets already on the old and new paths can arrive reordered, and path latency can shift. “Equal cost” is a routing metric statement, not proof of equal physical distance, queueing, or congestion.

Policy rules and ECMP choices should be tested with exact production tuples. Linux commands can request a route for a representative source and destination, while controlled packet captures show the actual egress. Do not generate test traffic that could reach a production venue without explicit isolation.

Hashing creates a measurement trap. Changing a UDP source port to label test runs can change the ECMP member and therefore physical latency. A/B comparisons must hold the full flow tuple constant or deliberately sample every relevant bucket. Conversely, a test of one tuple says nothing about balance across thousands of sessions.

## 27.7 Control-Plane Routing Concepts

The **control plane** discovers or configures reachability and installs forwarding state. The **data plane** applies that state to packets. A routing protocol does not normally run a full path algorithm for every data packet, but its convergence changes what the forwarding plane does.

Static routes are configured explicitly. They are simple and predictable until topology changes; failover requires another mechanism or operator action. Interior gateway protocols such as OSPF and IS-IS distribute topology information within an administrative domain and compute paths from link-state data. BGP exchanges reachability between routing domains and applies path attributes and policy rather than merely choosing shortest physical distance.

These descriptions are conceptual. Protocol timers, areas, levels, route reflection, filtering, graceful restart, fast detection, and vendor implementation substantially affect behavior. A trading application normally should not manipulate routing protocols, but its availability and latency depend on their resulting paths.

Convergence is an interval, not an atomic switch. Devices detect failure, communicate or infer it, recompute routes, program FIBs, and drain or discard packets associated with old state. Transient loops, black holes, duplication, reordering, and path-length changes are possible depending on topology and mechanisms.

Detection time and repair time are different. A physical loss-of-signal may be detected immediately by a neighboring port, while a remote failure requires protocol timers or an auxiliary liveness mechanism. After detection, computing and installing a repair still takes time. Fast failover claims must name the failure type, topology, precomputed state, and measurement endpoints.

Redundant A/B market-data feeds should not be assumed independent merely because they use different IP addresses. Trace physical links, switches, routing fate, power, and software dependencies. Shared control-plane failure can affect both at once.

Monitor control-plane state outside the critical packet loop and correlate changes with application sequences and timestamps. Route update logs, interface transitions, BFD or protocol neighbor state where deployed, and FIB observations can explain gaps that host CPU counters cannot.

## 27.8 Fragmentation, Reassembly, and Path MTU

The **path MTU** is the smallest IP packet size that can traverse every link on a path without network-layer fragmentation. It can be smaller than the local interface MTU because of another link or added tunnel headers.

In IPv4, a source or router may fragment a packet when it exceeds an outgoing MTU unless DF prohibits it. Fragments share identifying fields; each carries its own IPv4 header, and the fragment offset locates data in eight-byte units. Except for the final fragment, payload sizing must respect that granularity. The destination reassembles before delivering the complete original packet to the upper layer.

For a 4,000-byte IPv4 payload, a 20-byte header, and a 1,500-byte outgoing MTU, each full fragment can carry 1,480 bytes because 1,480 is divisible by eight. The fragments carry 1,480, 1,480, and 1,040 payload bytes, with total lengths 1,500, 1,500, and 1,060. Their offsets are 0, 185, and 370; the first two set More Fragments. The original packet's one header has become three headers and three separately losable units.

Fragmentation amplifies loss. If any fragment is lost, the complete datagram cannot be reassembled and buffered fragments eventually expire. Reassembly consumes memory and state keyed by source, destination, protocol, and identification information. Overlap, duplication, tiny fragments, and resource exhaustion require defensive handling. Middleboxes may mishandle noninitial fragments because those fragments do not contain transport ports.

With DF set, an IPv4 router that cannot forward should discard the packet and send an ICMP Destination Unreachable message indicating fragmentation is needed, including the usable MTU when supported. IPv6 routers never fragment ordinary transit packets; they discard an oversized packet and send ICMPv6 Packet Too Big. The IPv6 source can adapt or create fragments itself.

**Path MTU Discovery** uses these signals to lower packet size. If ICMP is blocked, packets below one size can work while larger ones disappear—a PMTU black hole. Packetization-layer PMTU discovery, where implemented by a transport or application, uses probes and observed delivery rather than relying only on ICMP.

Every IPv6 link must support the protocol's minimum link MTU of 1,280 bytes, with specified accommodation rules for links whose native frame size is smaller. That does not mean every IPv6 application should emit 1,280-byte packets without accounting for transport and tunnel headers. The end-to-end payload budget is the path MTU minus every header outside the application data.

Tunnels reduce effective MTU by adding outer headers. A path with 1,500-byte physical MTU cannot carry a 1,500-byte inner packet plus tunnel overhead without fragmentation, segmentation before encapsulation, or a larger underlay MTU. Offloads can hide host-side segmentation from captures, so observe the relevant side of the tunnel.

Market-data publishers commonly choose datagram sizes that avoid IP fragmentation across the engineered path. Receivers should still detect fragments and apply an explicit policy. Silently interpreting a noninitial fragment as a complete UDP packet is invalid.

Useful diagnostics include:

```sh
ip link show                    # configured interface MTUs
tracepath 192.0.2.9             # path observations where supported
ping -M do -s 1472 192.0.2.9    # IPv4: 1500 minus 20-byte IP and 8-byte ICMP headers
```

The `ping` payload arithmetic assumes a minimum IPv4 header and the stated link target. Firewalls, rate limits, asymmetric routing, and tool behavior can invalidate simple conclusions. Run probes only in an authorized environment.

## 27.9 ICMP and ICMPv6

ICMP reports network conditions and supports diagnostics. ICMPv6 additionally carries essential IPv6 functions such as Neighbor Discovery and Packet Too Big signaling. Neither protocol is merely “ping.”

Common message roles include:

- Echo Request and Echo Reply for reachability diagnostics.
- Destination Unreachable for delivery failures and IPv4 PMTU signals.
- Packet Too Big for IPv6 PMTU discovery.
- Time Exceeded when TTL or Hop Limit expires, used by traceroute techniques.
- Redirect to suggest a better first hop under constrained conditions.
- ICMPv6 router and neighbor discovery messages.

An ICMP error often includes part of the packet that triggered it so the sender can associate the condition with a flow. Quoted length, extensions, filtering, and delivery to applications vary. An application should not trust quoted content blindly; ICMP can be spoofed and must be validated against relevant state.

Routers and hosts commonly rate-limit ICMP generation or processing to protect control resources. Therefore absence of an ICMP response does not prove absence of the condition, and measured ICMP RTT does not necessarily equal application packet latency. Control-plane handling can follow a different path or priority.

ICMP errors are not generated for every possible offending packet; standards restrict responses in cases that could cause storms or ambiguity, such as certain broadcasts, multicast packets, error messages, and noninitial fragments. Implementations and policy add further limits. Diagnostics must combine ICMP with local counters and captures instead of waiting for one mandatory explanatory packet.

Blocking all ICMP is harmful. It breaks or degrades PMTU discovery and, for IPv6, can break fundamental neighbor and router behavior. A sound firewall admits necessary types with validation and rate policy rather than treating the entire protocol as optional.

`ping`, `tracepath`, and `traceroute` are evidence sources with different probe methods. Captures can show ICMP messages, while kernel counters can reveal errors delivered locally. Correlate a PMTU event with route, tunnel, and interface-MTU state rather than increasing buffers at random.

## 27.10 NAT and Connection Tracking

Network address translation rewrites addresses and sometimes transport ports. **Source NAT** changes the source as traffic leaves a domain; **destination NAT** changes the destination, often to select an internal service. Port address translation lets many internal flows share one external address by assigning distinct port mappings.

Translation must preserve relevant checksums. An implementation can update checksum fields incrementally, but it still parses, looks up state or rules, rewrites fields, and handles exceptional packets. Fragmentation complicates translation because noninitial fragments lack transport headers.

Linux netfilter can apply NAT at configured hooks, and connection tracking commonly maintains per-flow state used by NAT and stateful filtering. The table records tuples, protocol state, timeouts, and reply direction according to protocol-specific logic. Exact structures, locks, hashing, and fast paths depend on kernel version and configuration.

State has capacity and lifecycle costs. Bursts of short-lived flows can enlarge the table, create contention, and exhaust configured limits. Hash collisions and garbage collection affect latency. Stale state can continue translating or rejecting traffic until timeout. A stateless UDP application can therefore traverse a stateful network path even though UDP itself establishes no connection.

The first packet of a flow can take a different path through rule evaluation and state creation from established packets that match existing state. This creates a cold-flow tail even with warm routes and neighbors. Benchmark both creation rate and steady-state packet rate, and include expiration churn; a single long-lived flow exercises little of the allocator and cleanup behavior.

NAT also obscures endpoint identity and makes asymmetric routing difficult: return traffic often must encounter compatible state. Failover between translators needs state synchronization or accepts broken flows. For these reasons, critical low-latency paths often avoid NAT and unnecessary connection tracking when network architecture permits. Security and isolation requirements still apply; bypassing state is not automatically safe.

Inspect Linux state and counters with tools appropriate to the installed environment, for example `nft list ruleset`, `conntrack` when installed, and `/proc` or `nstat` counters. Commands may require privileges. A packet capture on both sides of translation establishes which tuple was rewritten and where, while latency measurement determines whether it matters under representative table load.

## 27.11 IP Multicast, IGMP, MLD, and Source-Specific Groups

IP multicast delivers a datagram addressed to a group to receivers that have joined through the network's multicast mechanisms. IPv4 uses `224.0.0.0/4`; IPv6 uses `ff00::/8` with embedded flags and scope.

Membership signaling is local to a link. IPv4 hosts use IGMP to inform multicast routers about group interest; IPv6 hosts use MLD, which is carried in ICMPv6. Switches may snoop these exchanges to constrain Layer-2 replication as described in Section 26.11. A socket join causes host protocol actions but is not an end-to-end subscription acknowledgment from a publisher.

In **any-source multicast** (ASM), a receiver joins a group `G` and may receive permitted traffic from multiple sources, often described as `(*,G)`. In **source-specific multicast** (SSM), it requests traffic from source `S` to group `G`, described as `(S,G)`. Source filtering can reduce unwanted traffic and simplify routing state, but every host, switch, router, and API in the path must support the chosen mode.

Multicast provides no inherent reliability, ordering, duplicate suppression, flow control, or congestion control. Different receivers can lose different packets. A publisher does not learn from ordinary IP multicast that one subscriber's socket or CPU is overloaded. Trading feeds therefore add sequence numbers, redundant paths, snapshots, and recovery protocols at the application layer.

The IPv4 multicast TTL and IPv6 multicast scope constrain propagation, but they are not access controls. A receiver within scope can still see traffic if routing, switch state, and policy permit it. Sensitive feeds need network isolation and appropriate application or link protections; choosing a low TTL does not authenticate subscribers.

Group scope and interface selection are part of correctness on multihomed hosts. The same group can be reachable through several interfaces, and joining on the wrong one can produce silence or traffic on an unintended network. Linux socket APIs and routes specify interface choices; Chapter 28 covers those details.

Observe membership at multiple layers:

```sh
ip maddress show
ip -4 mroute show
ip -6 mroute show
```

These commands do not alone prove end-to-end delivery. Host membership, switch snooping, multicast routing, source state, NIC filters, socket queues, and application processing must all agree.

## 27.12 Multicast Routing and Reverse-Path Forwarding

Multicast forwarding builds a distribution tree from a source toward receivers. A router may replicate one packet onto several outgoing interfaces. Protocols such as PIM coordinate tree state in deployed multicast networks, often using unicast routing information to decide how a source should be reached.

A **reverse-path forwarding** (RPF) check asks whether a multicast packet arrived on the interface the router expects to use toward its source. If not, the router can discard it. This prevents loops and duplicate forwarding in the distribution tree.

```text
             receiver A
                 ^
source -> R1 -> R2
          |      v
          +--> receiver B

At each router, source-facing ingress must satisfy RPF policy;
outgoing state identifies receiver-facing branches.
```

RPF depends on route and multicast state. An asymmetric or unexpectedly changed unicast route can therefore stop multicast even though ordinary unicast connectivity still exists. In an A/B feed design with two source networks, filters and routing must identify both intended source-interface relationships.

Do not confuse multicast RPF forwarding logic with Linux's `rp_filter` setting for unicast source-address validation. They share a reverse-path idea but operate in different mechanisms and configurations. Blindly changing `rp_filter` may weaken spoofing defenses without fixing multicast routing.

Multicast routing state commonly distinguishes `(S,G)` source-specific entries and `(*,G)` shared entries. State has timers and depends on membership reports, queriers, and routing adjacencies. During convergence, receivers can see gaps, duplicates, or a source switch. Application sequence handling must remain correct across those events.

RPF checks make source addressing operationally significant. If a publisher starts using a new source address, the group can remain unchanged while routers reject the traffic because their source-facing expectation differs. Feed-change procedures must therefore validate both `S` and `G`, not merely the multicast destination and UDP port.

Validate the tree from source to each receiver: source route, first-hop router, RPF decision, outgoing-interface list, switch snooping state, receiver membership, and capture. One receiver's success does not prove another branch is healthy.

## 27.13 Linux IP Tools and Network Namespaces

Linux exposes address, route, policy, and neighbor state through the `ip` command suite. Read-only inspection begins with:

```sh
ip -brief addr show
ip route show table all
ip -6 route show table all
ip rule show
ip neigh show
ss -u -a
```

`ip addr` shows address lifetimes and scope. `ip route` shows routes; `ip route get` asks for a decision. `ip rule` exposes policy routing. `ip neigh` exposes ARP and ND state. `ss` displays sockets, not switch forwarding or physical frames. Each tool covers one layer.

A **network namespace** owns an isolated set of network devices, addresses, routes, firewall state, and sockets. A veth pair can connect two namespaces for safe routing experiments. The following lab mutates host networking and requires appropriate privileges; run it only in a disposable environment:

```sh
ip netns add left
ip netns add right
ip link add veth-left type veth peer name veth-right
ip link set veth-left netns left
ip link set veth-right netns right

ip -n left addr add 192.0.2.1/24 dev veth-left
ip -n right addr add 192.0.2.2/24 dev veth-right
ip -n left link set lo up
ip -n right link set lo up
ip -n left link set veth-left up
ip -n right link set veth-right up

ip netns exec left ping -c 1 192.0.2.2

ip netns del left
ip netns del right
```

Deleting either namespace destroys its moved veth endpoint; deleting both removes the lab state. Use unique names if other namespace experiments exist. The documentation prefix keeps the addresses out of ordinary public use, but namespace isolation—not the prefix alone—prevents unintended traffic.

Namespaces reproduce kernel namespace and virtual-interface behavior. They do not reproduce NIC rings, physical loss, switch ASICs, propagation, or hardware timestamping. Use them for route, MTU, policy, netfilter, and socket correctness, then validate physical performance on the target topology.

Counters remain namespace- and interface-specific. A packet can increment a veth receive counter, traverse a namespace router, and then drop at a policy rule before another interface records transmission. Take snapshots from both namespaces and all interfaces around a bounded test. `nstat` can add IP, ICMP, and fragmentation counters where available, while `ip -s link` remains link oriented.

Capture commands such as `tcpdump -i veth-left -nn -e` can show Ethernet and IP headers visible at that hook. Offloads and capture point still matter. Keep captures bounded and filtered on busy systems to avoid turning observation into the workload.

## 27.14 Route Lookup, Neighbor Resolution, and Per-Hop Cost

Sending an IP packet over Ethernet requires two selections: a network-layer route and a link-layer neighbor. The route chooses an output interface and next-hop IP address; the neighbor table supplies the next-hop MAC address.

```text
application/socket
       |
       v
 policy + route lookup ---- no route ---> error/drop
       |
       v
 choose output interface and next-hop IP
       |
       v
 neighbor lookup ---- miss ---> queue packet, ARP/ND, retry/fail
       |
       v
 build L2 frame -> qdisc/driver/NIC queue -> serialize
       |
       v
 switch queues -> router ingress -> route next hop -> repeat
```

A warmed steady-state path can use cached socket destination information, a resident FIB, and a reachable neighbor entry. A cold or changed path can trigger rule traversal, route exceptions, neighbor resolution, control-plane work, and queued packets. Those state transitions explain why a first packet can have a very different tail from later packets.

Consider an off-subnet destination. The host's `/24` route may select gateway `10.0.0.1`; the Ethernet destination is then the gateway's MAC while the IP destination remains the remote host. At the router, that Ethernet header ends. The router retains the IP destination, decrements TTL or Hop Limit, chooses its own next hop, and builds a new Ethernet frame. Confusing IP destination with frame destination is a common packet-capture error.

At each router, the incoming Ethernet header is consumed and a new link-layer header is built for the next link. IPv4 TTL is decremented and its header checksum updated; IPv6 Hop Limit is decremented without a base checksum. The router performs a FIB lookup, applies policy and configured filtering, resolves or uses a next-hop neighbor, queues for an egress, and serializes.

A useful one-way model is:

```text
host processing
+ first-link serialization and propagation
+ sum(router processing + egress queue + next-link serialization + propagation)
+ receiver processing
+ recovery delay for any loss visible to higher layers
```

Only some terms have simple lower bounds. Queueing can vary from zero to a configured drop threshold or worse under control-plane handling. Neighbor resolution can add probes and retry timers. Fragmentation adds packets and reassembly state. NAT and conntrack add lookup and lifecycle work. Multicast replication creates different queues on different receiver branches.

Build evidence from both packet and state observations:

1. Use `ip route get` with the real tuple to verify policy and next hop.
2. Use `ip neigh` to identify cold, stale, or failed neighbor state.
3. Capture on source, router links where authorized, and receiver to locate loss or delay.
4. Read NIC, switch, queue, route, ICMP, fragment, and conntrack counters.
5. Correlate application sequence numbers and hardware timestamps across redundant paths.

Do not collapse all unexplained time into “the network.” Name the lookup, queue, link, state machine, and observation point. That decomposition makes a latency claim testable.

## 27.15 Interview Check

1. Parse the minimum IPv4 header: explain IHL, total length, fragmentation fields, TTL, protocol, checksum, and the bounds checks required before reading a payload.
2. Compare IPv4 and IPv6 headers. Why does a fixed IPv6 base header not imply fixed parsing work, and who may fragment in each protocol?
3. Given `/32`, `/24`, and default routes that all match a destination, apply longest-prefix matching and explain when metrics matter.
4. Explain the difference between a routing information base, a forwarding information base, a neighbor table, and a socket's cached destination state.
5. A flow moves between ECMP paths after a failure. What reordering and latency effects can occur even though both routes have equal cost?
6. Trace PMTU discovery for an oversized IPv4 packet with DF set and for an oversized IPv6 packet. How does an ICMP-filtering black hole appear to the application?
7. Why does losing one IP fragment lose the complete upper-layer datagram? List the memory, security, and middlebox costs of reassembly.
8. Compare SNAT, DNAT, port translation, and connection tracking. Why can a connectionless UDP feed still consume state in a Linux network path?
9. Distinguish ASM `(*,G)`, SSM `(S,G)`, IGMP/MLD membership, switch snooping, and multicast RPF. Which layer owns each decision?
10. A receiver gets no multicast after a route change. Give a layer-by-layer diagnostic plan covering source routing, RPF, outgoing interfaces, switch state, NIC filters, socket membership, and application queues.
