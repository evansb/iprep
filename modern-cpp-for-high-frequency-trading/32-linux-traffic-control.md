# Chapter 32 — Linux Traffic Control

Linux traffic control can delay, drop, classify, reshape, and redirect packets, but a command that prints successfully does not prove that traffic experienced the intended model. Queueing discipline placement, multiqueue devices, segmentation offloads, timer behavior, and filter order all affect the result. In a low-latency system, an oversized queue can turn a brief overload into a long latency tail, while an ill-considered experiment can disrupt the management path to the host. This chapter develops the `tc` architecture, its principal algorithms, and a safe method for validating behavior in disposable network namespaces before touching a real interface.

## 32.1 Qdisc Placement and Architecture

A **queueing discipline**, or **qdisc**, is a Linux packet-scheduler object attached at a traffic-control location associated with a network device. The most familiar root qdisc controls egress. Packets have already passed through socket and protocol processing when they reach it; after dequeue, the driver and NIC transmit queues still remain.

```text
application
    |
socket/protocol/routing
    |
root egress qdisc -- driver queue -- NIC ring -- wire
    |
 qdisc filters/actions may classify, drop, mark, or redirect
```

This diagram is intentionally simplified. Virtual devices, tunnels, bridges, bonding, VLAN devices, and redirects can create several qdisc traversals. Linux kernel details also change by version and driver. Trace the actual path for the deployment rather than treating “the qdisc” as one universal queue.

The qdisc does not own application payload objects. It queues kernel packet representations, commonly `skb` objects or references managed by the networking stack. Memory accounting therefore includes kernel metadata, fragments, and possibly aggregates produced by offloads. A packet count multiplied by average wire size is not a reliable bound on kernel memory.

Ingress historically used an ingress qdisc as a filter/action hook rather than a conventional queue that could delay received packets. The `clsact` qdisc supplies ingress and egress classifier/action hooks without replacing the device's root egress qdisc. To shape ingress, a common design redirects traffic to an Intermediate Functional Block (IFB) device and applies an egress shaper there, as Section 32.9 shows.

A qdisc is **classless** when it exposes no child classes for traffic subdivision. FIFO, `fq`, `fq_codel`, and `netem` are commonly used as classless qdiscs. A **classful** qdisc, such as HTB, contains classes and can attach child qdiscs beneath them. Classful does not mean “better”; it means that hierarchical classification and scheduling are part of the configuration.

Objects use handles such as `1:` for a qdisc and class identifiers such as `1:10`. The major number commonly identifies the parent qdisc, while the minor number identifies a class. `parent`, `root`, and `classid` connect the tree. Handles are configuration identifiers, not packet-flow IDs.

```sh
# Read-only. No elevated privilege is normally needed.
tc qdisc show dev eth0
tc -s qdisc show dev eth0
tc class show dev eth0
tc filter show dev eth0
```

Changing qdiscs requires administrative networking authority, normally root or `CAP_NET_ADMIN` in the owning network namespace. That authority can disconnect the host. Never experiment on the production management interface; use Section 32.11's namespace lab.

The latency model contains at least classification work, enqueue/dequeue work, locks or per-CPU coordination, timer scheduling, and time spent waiting behind earlier packets. The qdisc's configured delay is only one term. Driver queues, NIC rings, switches, and receiver queues add independent waiting after dequeue.

Backpressure also depends on the protocol and device. A stopped driver queue can prevent qdisc dequeue until capacity returns. A virtual device may synchronously pass a packet into another stack layer. A qdisc enqueue success therefore does not imply immediate driver ownership, and a send syscall success does not imply qdisc admission for every protocol path.

## 32.2 Classes, Filters, Actions, and Chains

A **class** represents a scheduling group inside a classful qdisc. A **filter** selects packets. An **action** changes their treatment. A **chain** groups ordered filters and allows control flow among classification stages.

```text
packet
  |
filter preference 10 -- match? -- action(s) -- class 1:10
  | no match
filter preference 20 -- match? -- action(s) -- class 1:20
  | no match
default class or qdisc behavior
```

Filter ordering is observable. `pref` or `priority` chooses the order in which filters at a hook are considered, subject to classifier and kernel behavior. If two filters overlap, the earlier successful terminal result can make the later filter unreachable. Always print priorities and handles in configuration reviews.

A class normally carries rate or scheduling parameters and may have a leaf qdisc. Classification into an HTB class does not itself define the leaf's queue policy: a FIFO child and an `fq_codel` child respond differently to a burst even when the parent rate is identical.

Actions include accepting or dropping, setting metadata, policing, mirroring, redirecting, and editing VLAN information. An action pipeline can perform more than one operation. Each operation adds parsing, metadata updates, table lookup, cloning, or device traversal. A mirror generally retains the original packet and sends a clone; a redirect transfers the packet toward another device. Exact clone and ownership mechanics are Linux implementation details.

Chains help organize large rule sets and can support jumps or gotos where the classifier/action infrastructure permits them. They do not make lookup free. A linear set of filters can perform work proportional to the rules visited; hashed or compiled classifiers have different memory and cache behavior. Hardware offload may move selected rules to the NIC or switch, but support is device-, driver-, and rule-specific. Use `skip_hw` or `skip_sw` only when the intended failure behavior is understood and verify offload flags in `tc` output.

Class IDs and marks are control-plane data. Keep a source-controlled allocation plan for them, because an innocent reuse can connect a filter to the wrong class without producing a syntax error. Prefer explicit defaults that send unmatched packets to a known class or reject deployment when the desired fail-closed behavior cannot be represented.

The safe design sequence is:

1. define the traffic classes and overload behavior;
2. choose the queue policy for each class;
3. write non-overlapping match rules with explicit priorities;
4. add the minimum actions needed;
5. verify packet and byte counters per filter, class, and qdisc;
6. measure timing and drops outside the configuration host.

A filter with zero hits may contain a wrong offset, protocol, VLAN assumption, namespace, or hook. A qdisc counter increasing only proves that packets reached that qdisc; it does not prove that a particular classifier or offloaded wire path behaved as intended.

## 32.3 FIFO, Fair Queueing, CoDel, CAKE, `mq`, and `noqueue`

A queueing algorithm chooses which packet to dequeue and what to do when capacity is exhausted. Simple algorithms minimize scheduler work; richer algorithms trade additional state and classification for isolation, pacing, or active queue management.

`pfifo` limits packets, while `bfifo` limits bytes. Both preserve enqueue order and normally tail-drop when the limit is full. They are easy to reason about, but one large flow can occupy the entire queue. A large limit absorbs a burst at the cost of queueing delay. A small limit bounds waiting more tightly but drops sooner.

`pfifo_fast` is a historical priority-band qdisc associated with older Linux defaults. Do not assume a contemporary kernel uses it. Distribution defaults and kernel configurations differ; inspect the device.

`fq` separates traffic into flows using a hash and schedules among them. Linux's implementation also supports pacing-related behavior used by parts of the networking stack. Per-flow isolation prevents one backlogged flow from sitting directly ahead of every packet from another, but hashing can collide and flow state consumes memory. Packet ordering remains per flow, not globally across the qdisc.

CoDel is an active queue management algorithm concerned with persistent queueing delay rather than a fixed byte threshold alone. `fq_codel` combines flow queueing with CoDel behavior, isolating flows and dropping or marking when delay remains excessive according to its control law. It can control bulk-traffic bufferbloat effectively; it is not a guarantee that a latency-sensitive packet never waits.

Active queue management can use packet drops or Explicit Congestion Notification where the qdisc, protocol, and endpoints support the configured mode. Marking informs a congestion-aware sender without discarding the packet, but an endpoint that ignores or cannot negotiate ECN does not gain that feedback. UDP market-data publishers normally do not react like TCP congestion control, so AQM semantics must be evaluated at the application level.

CAKE integrates shaping, flow isolation, active queue management, and link-layer accounting concepts. It is often used at constrained access links. Kernel/module availability and option support vary, and its richer processing is not automatically suitable for an HFT critical interface. Use it when its integrated semantics match the link, not because it has more features.

`mq` is associated with multiqueue network devices. It exposes a qdisc beneath each hardware transmit queue so scheduling can align with driver queues. Queue selection can occur before the child qdisc, based on socket or packet queue mapping and mechanisms discussed in Chapter 31. Inspect every child: changing one leaf does not necessarily change all transmit queues.

`noqueue` indicates that conventional software queueing is inappropriate for a device. It is common for particular virtual or non-queueing device types. It does not mean the entire path has no queues; another virtual device, host qdisc, driver, peer, or switch can still queue.

| Qdisc | Main state | Overload behavior | Important cost |
|---|---|---|---|
| `pfifo`/`bfifo` | One bounded FIFO | Tail drop | One flow can block all others |
| `fq` | Per-flow queues and scheduler | Limit/policy dependent | Hashing and flow state |
| `fq_codel` | Per-flow state plus delay control | AQM drop/mark | More decisions per enqueue/dequeue |
| CAKE | Shaper, flow isolation, AQM | Integrated policy | Rich state and classification |
| `mq` | One child per TX queue | Child dependent | Configuration and queue mapping |
| `noqueue` | No ordinary qdisc queue | Device dependent | Queues may exist elsewhere |

Availability is a platform fact. Check `tc qdisc help`, kernel configuration, loaded modules, and `tc qdisc show` on the target. Never replace an unknown production qdisc merely to see whether another name is accepted.

Queue choice also determines failure visibility. A FIFO exposes drops when its hard limit fills. An AQM can drop or mark before that limit to signal persistent delay. Fair queueing can keep a sparse order flow responsive while a bulk flow remains backlogged, yet aggregate counters can hide which flow suffered. Pair qdisc statistics with application sequence and latency metrics.

## 32.4 `netem` Impairment Models

`netem` is a test qdisc that emulates selected network impairments, including delay, variation, loss, duplication, corruption, reordering, and rate effects. It is valuable for recovery testing because it makes faults repeatable enough to exercise application behavior. It is not a faithful model of every physical network.

```sh
# Example only: run inside a disposable network namespace.
tc qdisc replace dev veth-left root netem delay 5ms 1ms loss 0.5%
```

The command introduces a delay distribution and probabilistic loss according to the installed iproute2/kernel implementation. The printed configuration is not measured packet timing. Scheduler wakeups, timer resolution, CPU load, batching, and the virtual-device path affect observations.

Direction is a common mistake. Applying `netem` to `veth-left` egress impairs packets leaving that endpoint, not packets arriving there from its peer. To impair both directions, configure each direction explicitly. To model asymmetric paths, use different parameters and verify them independently.

Loss can be independent or correlated, depending on options. Real links often exhibit bursts caused by buffer overflow, congestion, physical errors, or a failed path; a simple independent percentage does not reproduce those mechanisms. More elaborate state or burst-loss models can approximate a pattern but still need validation against the failure being studied.

Reordering requires packets to be held or delayed relative to others. Combining delay, a reorder percentage, correlation, and a gap parameter can produce unintuitive results. Duplication clones packets, increasing downstream load. Corruption changes selected packet bits, after which checksums or protocol validation may discard the packet at a later layer. An application might therefore observe a gap rather than corrupted payload.

Rate emulation in `netem` is useful for a constrained test but differs from a dedicated shaper and from a real serialized link. Packet overhead, offloads, timer granularity, and queue limits affect effective rate. If rate fidelity is central, combine or compare with TBF/HTB and measure wire-equivalent traffic.

Always set a finite queue limit appropriate to the test. Delay is implemented by holding packets, so the memory footprint grows with packet rate multiplied by delay. If arrival rate exceeds departure capacity, the queue grows to the limit and then drops. That may be exactly the desired overload test, but it must not be an accidental side effect.

Useful scenarios include:

- market-data gaps followed by snapshot recovery;
- duplicated and reordered UDP messages;
- TCP retransmission and head-of-line delay;
- a burst constrained below the sender's offered rate;
- corruption detected by checksums or parser validation.

Record the complete `tc -s qdisc` output, offered load, sender and receiver timestamps, CPU load, and offload settings. A seed or correlation option, when supported, improves repeatability but does not make scheduling deterministic. Test assertions should allow the configured distribution rather than expect an exact packet sequence unless the experiment creates one explicitly.

Probability estimates need enough observations. Ten packets cannot validate a small configured loss rate, while millions of packets can make even tiny model differences statistically visible but operationally irrelevant. Define confidence and tolerance from the application's recovery requirement. Also test deterministic gap patterns when a specific state-machine transition must be covered.

## 32.5 TBF and HTB Shaping

**Shaping** delays packets so that departures conform to a traffic contract. Linux's Token Bucket Filter (TBF) is a classless shaper based on token accumulation. Hierarchical Token Bucket (HTB) is classful and distributes rate among classes.

In a token bucket, tokens arrive at the configured rate up to a burst capacity. Sending a packet consumes tokens corresponding to its accounted length. A burst can depart immediately while tokens are available; sustained traffic is limited by the refill rate.

```text
tokens += rate * elapsed_time, capped at burst

if tokens >= packet_cost:
    tokens -= packet_cost
    dequeue packet
else:
    wait until enough tokens are available
```

A TBF configuration supplies a rate and burst/buffer plus either a queue limit or a latency-derived limit. Exact accepted syntax and calculations depend on the installed iproute2 version. A peak-rate bucket can impose an additional short-timescale constraint. Do not copy parameters without reading `tc tbf help` on the target.

```sh
# Example only, for an isolated test interface.
tc qdisc replace dev veth-left root handle 1: \
  tbf rate 100mbit burst 128kb latency 20ms
```

The `latency` parameter helps iproute2 derive a limit; it is not a promise that every packet waits no more than that under every kernel and lower-layer condition. Once a packet leaves TBF, driver and NIC queues remain. If the offered rate exceeds the configured rate long enough, the qdisc either queues to its bound or drops.

Rate suffixes and link accounting deserve review. Bit and byte units, decimal and binary suffixes, minimum packet units, and configured overhead can change a copied command's effective contract. Print the normalized installed configuration with detailed output and measure known packet sizes at the receiver.

HTB assigns guaranteed rates to classes and optional ceilings above those rates. Classes can borrow unused capacity according to the hierarchy and scheduling parameters. Priorities affect which eligible class is served; they do not create bandwidth absent from the parent.

```sh
# Example only; class and filter commands must be applied as one reviewed unit.
tc qdisc replace dev veth-left root handle 1: htb default 30
tc class replace dev veth-left parent 1: classid 1:10 \
  htb rate 80mbit ceil 100mbit
tc class replace dev veth-left parent 1: classid 1:30 \
  htb rate 20mbit ceil 100mbit
```

Attach an appropriate leaf qdisc to each class and add explicit filters. Otherwise defaults vary with configuration and kernel. HTB maintains more state and performs classification and scheduling work that TBF does not. Use it when independent class contracts and borrowing are required.

Validate shaped throughput over intervals long enough to cover bursts, and validate per-packet delay during overload. An average close to the configured rate can coexist with unacceptable microbursts or queue tails.

HTB borrowing can make an isolated class exceed its guaranteed rate while siblings are idle. A test that measures only one active class will therefore observe the ceiling rather than the guarantee. Exercise all classes concurrently, check per-class lends/borrows statistics where available, and test the default class with unmatched traffic.

## 32.6 Policing Versus Shaping

A **policer** enforces a traffic contract without holding excess packets for later transmission. It normally drops them or marks them for another treatment. A shaper queues excess traffic and sends it when eligible.

| Question | Shaper | Policer |
|---|---|---|
| Where do excess packets go? | Into a bounded queue | Usually drop or reclassify |
| Added delay | Deliberate | Little queueing in the policer itself |
| Burst handling | Tokens plus queue | Tokens plus drop/mark policy |
| Downstream load | Smoothed | Reduced through loss/remarking |
| Typical placement | Egress or IFB egress | Ingress or egress action |

A policer can protect a process or link from overload, but loss can trigger TCP retransmission, market-data recovery, or application-level retry. Those consequences can cost more than the packets dropped. A shaper preserves packets within its limit but converts overload into latency. Neither policy is universally correct.

`tc` police actions use rate and burst parameters plus an exceed action. Syntax varies by version and context. This schematic command is intentionally not a production recipe:

```sh
# Example only: match-all ingress police in an isolated namespace.
tc qdisc add dev veth-right clsact
tc filter add dev veth-right ingress pref 10 matchall \
  action police rate 50mbit burst 64kb drop
```

Some iproute2 versions name the match-all classifier `matchall`; syllabus terminology may call the conceptual classifier “basic.” Query local help. Counters must show both conforming and overlimit behavior.

Marking rather than dropping supports a two-stage policy: an excess packet can enter a lower-priority class. That adds filter/action work and requires a later classifier to interpret the mark. Document whether a firewall or routing rule also uses the same metadata.

For HFT systems, overload policy should be tied to semantics. Dropping redundant telemetry may be acceptable. Silently shaping order acknowledgments behind a large queue may not be. Market data may prefer prompt gap detection and recovery over stale delivery. State the maximum retained backlog and the observable failure mode.

Policing placement changes whose traffic is protected. Ingress policing on a host occurs after the physical link and some NIC/driver work have already been consumed, so it cannot protect upstream bandwidth. It can bound later stack/application load. An upstream switch policer protects a different resource and has a different clock, burst, and counter model.

## 32.7 Burst Sizes, Timer Granularity, and Queue Growth

A **burst size** is the amount of traffic a token-based limiter can admit beyond its long-term rate while accumulated tokens are available. It must cover legitimate packetization and scheduling gaps, but an oversized burst permits a correspondingly large microburst.

At rate (R) bytes per second, a queued backlog of (B) bytes contributes approximately (B/R) seconds of serialization time before later bytes, excluding framing details and all other queues. This arithmetic is a bound model, not a measured Linux guarantee.

```text
offered rate > shaped rate
        |
        v
queue grows -- reaches limit --> drops
        |
        +--> every queued byte increases later-packet delay
```

Token refill and dequeue scheduling depend on Linux timekeeping, high-resolution timers, CPU scheduling, and qdisc implementation. Older descriptions often reduce shaping precision to a single “jiffy” rule. Contemporary kernels can use finer timers, but wakeup latency and batching still exist. Measure the installed kernel under representative load.

Minimum useful burst depends on rate, timer behavior, and packet sizes. If it is too small to admit a maximum-sized accounted packet, configuration may fail or traffic may behave unexpectedly. Link-layer overhead accounting changes how many tokens a packet consumes. VLAN tags, tunneling, framing, and CAKE/TBF options can alter the relationship between qdisc bytes and wire bytes.

Queue bounds can be expressed in packets, bytes, or parameters from which iproute2 derives a limit. Packet limits make memory and delay vary with packet sizes. Byte limits map more directly to serialization but still omit kernel metadata. Each queued `skb` carries memory beyond payload, and segmentation offloads can make one queued `skb` represent a larger packet aggregate.

For predictable latency, start from an allowed queueing-time budget, derive a byte bound at the service rate, and then test bursts at and above that bound. Record overlimit, drop, backlog, and requeue counters. A large limit should never be used merely to make drops disappear; it moves the failure into latency.

Queue growth is dynamic, so snapshots can miss peaks. Polling `tc -s` adds netlink and formatting work and may be too slow to observe a microburst. Packet timestamps, tracepoints, driver statistics, and external capture can provide complementary evidence. Instrumentation itself changes load; use the least invasive observer that answers the question.

## 32.8 Basic, `u32`, Flower, Mark, and BPF Classifiers

A **classifier** maps packets and metadata to a class or action result. Linux provides several classifier families with different expressiveness, state, and offload support.

The basic or match-all style applies an expression or rule broadly, depending on installed classifier support. It is suitable when every packet at a hook receives the same action. Confirm whether the local iproute2 uses `basic`, `matchall`, or another syntax for the intended operation.

`u32` matches fields at specified offsets and can build hashed structures. It is powerful but easy to misconfigure when VLANs, IPv4 options, IPv6 extension headers, tunnels, or changing header offsets invalidate a copied rule. A match that assumes a fixed transport offset must state that packet-shape precondition.

Flower provides readable keys for common fields such as Ethernet addresses, IP addresses, IP protocol, ports, VLAN information, tunnel metadata, and packet marks. Supported keys and hardware offload coverage depend on kernel, iproute2, driver, and device.

```sh
# Example only: classify UDP destination port 9000 into HTB class 1:10.
tc filter replace dev veth-left parent 1: protocol ip pref 10 flower \
  ip_proto udp dst_port 9000 classid 1:10
```

The `fw` classifier uses packet marks commonly set by nftables/iptables or earlier actions. A mark is metadata, not authentication. Define masks and ownership so unrelated subsystems do not overwrite each other's bits.

The BPF classifier can run a verified eBPF program and return classification or action results. It supports complex parsing and maps, but it adds program execution, map access, verifier constraints, lifecycle management, and potentially JIT-specific behavior. Hardware offload is not automatic. Use BPF when simpler keys cannot express the policy or when one managed program replaces an otherwise unwieldy rule set.

Filter changes have consistency semantics at the kernel object level, but a multi-filter policy update is not automatically atomic as one business rule. During replacement, packets can observe old or new rules at different instants. Chains, priorities, staged handles, or BPF map indirection can support controlled cutover, but the exact design must be tested under traffic.

Classification cost depends on rules visited, key extraction, cache locality, map lookup, and offload location. A readable flower rule can be faster or slower than `u32` depending on the installed implementation and rule set. Verify counters and profile under the target packet distribution.

## 32.9 Redirect, Mirror, Mark, Police, VLAN, and IFB Actions

A traffic-control **action** can terminate, redirect, duplicate, annotate, police, or edit a packet. Action order matters because later actions see the packet and metadata produced by earlier ones.

`mirred` supports mirroring and redirecting toward another device. Mirroring preserves the original path while sending a copy; redirecting transfers the packet to the target path. A mirror can double traffic and memory pressure and may perturb the path being observed. It is not a zero-cost tap.

Marks can carry a classification decision across hooks. Police actions enforce a rate as described in Section 32.6. VLAN actions can push, pop, or modify tags where the kernel and device support them. Editing headers can interact with checksum and segmentation offloads; verify received packets, not only action counters.

IFB provides a common ingress-shaping pattern:

```text
physical ingress hook
    |
mirred redirect
    v
IFB egress qdisc -- shaper -- host receive path
```

```sh
# Example only. Requires IFB support and CAP_NET_ADMIN.
ip link add ifb0 type ifb
ip link set ifb0 up
tc qdisc add dev eth0 clsact
tc filter add dev eth0 ingress pref 10 matchall \
  action mirred egress redirect dev ifb0
tc qdisc replace dev ifb0 root tbf rate 100mbit burst 128kb latency 10ms
```

Do not run this sequence on a remote production host. A mistake can redirect all ingress away from the expected path and sever management access. Names, classifier syntax, and module availability must be validated locally. Use a namespace/veth lab first, preserve an out-of-band recovery path, and apply changes through an operationally reviewed transaction or rollback mechanism.

Redirect loops are possible. A packet redirected to a device whose filters redirect it back can consume CPU until kernel safeguards intervene or packets drop. Draw the device graph and include every virtual layer before adding `mirred` rules.

Counters should be reconciled across source filter, action, target device, target qdisc, and receiver. Differences can reflect drops, clones, offloads, or accounting points. Packet capture on one side alone cannot establish the entire path.

VLAN manipulation must distinguish metadata tags handled by offload from bytes visible in a host capture. A pushed tag can appear only after a later device stage, while a stripped receive tag can be recorded in packet metadata. Validate on an external peer and inspect offload settings before concluding that an action failed.

## 32.10 Inspecting and Changing `tc` Safely

Traffic-control inspection is read-only; mutation is an operational change. Begin by capturing the complete existing state, including statistics and details.

```sh
tc -s -d qdisc show dev eth0
tc -s -d class show dev eth0
tc -s -d filter show dev eth0 ingress
tc -s -d filter show dev eth0 egress
ip -details link show dev eth0
ethtool -k eth0
```

Command availability and formatting depend on iproute2. JSON output (`tc -j`) can be easier to inventory when supported. Save the exact kernel, iproute2 version, interface topology, queue count, and offload state with the snapshot.

`add` expects no conflicting object. `change` modifies an existing compatible object. `replace` creates or replaces according to the command's semantics. `del` removes an object and can recursively remove children. None is a universal transaction across an entire qdisc tree. A partially applied multi-command configuration can expose unintended defaults between commands.

On a real system, use a deployment mechanism that validates prerequisites, stages rules where possible, applies explicit handles and priorities, verifies counters, and rolls back on failure. Schedule changes away from critical sessions. Maintain console or out-of-band access. A shell trap is not sufficient recovery if the network path carrying the shell disappears.

Treat the saved configuration as structured state, not a screenshot. Text output from one iproute2 release may not be accepted as input to another, and implicit defaults can disappear from ordinary output. Keep declarative source plus a tested reconstruction procedure and verify it on the exact host image.

Deleting a root qdisc causes Linux to install the device's default behavior, which depends on device and system configuration. “Delete” does not necessarily mean “no queue.” Record the original state and restore it explicitly.

After a change, verify:

- the intended qdisc/class/filter tree exists;
- counters advance on the expected objects only;
- backlog and drops match offered load;
- measured timing matches the intended impairment or rate;
- unrelated traffic and management remain reachable;
- offload state and hardware statistics agree with the assumed path.

There is no general `tc` dry run that proves a multi-command policy against live kernel and driver capabilities without changing state. Rehearse the exact commands on the same kernel/NIC model in an isolated namespace or staging host. Parse and validate all generated arguments before the privileged step, but treat successful rehearsal as risk reduction rather than proof about a different production topology.

Counter baselines matter. Snapshot them immediately before and after a bounded test interval; cumulative counters from earlier traffic can otherwise make a dead filter appear active. Account for counter width, resets after object replacement, and concurrent unrelated traffic.

Archive the receiver's sequence-level result with those baselines. Configuration evidence without application-visible evidence cannot establish that loss, delay, or classification met the test contract.

Preserve sender evidence as well, so receiver gaps can be separated from packets the sender never emitted.

Administrative privileges should be scoped to a network namespace when possible. Granting `CAP_NET_ADMIN` broadly allows far more than changing one test qdisc. Container boundaries do not make a shared host interface safe if the namespace still owns or can reach it.

Before mutation, resolve the interface by stable deployment identity rather than a guessed `eth0` name. Bonds, VLANs, renames, and hotplug can change the visible device. Confirm namespace inode, interface index, link master, peer, and route. Refuse to continue if they differ from the reviewed target.

## 32.11 Namespace and Veth Experiments

A network namespace gives a process an isolated network stack, and a veth pair connects two virtual Ethernet endpoints. Together they provide a safe place to learn `tc` semantics without modifying a production interface.

The following lab requires root or suitable namespace capabilities on Linux. It creates disposable namespace state. Use unique names on a development host and remove only the namespaces created by the lab.

```sh
ip netns add tc-left
ip netns add tc-right
ip link add veth-left type veth peer name veth-right
ip link set veth-left netns tc-left
ip link set veth-right netns tc-right

ip -n tc-left addr add 192.0.2.1/24 dev veth-left
ip -n tc-right addr add 192.0.2.2/24 dev veth-right
ip -n tc-left link set lo up
ip -n tc-right link set lo up
ip -n tc-left link set veth-left up
ip -n tc-right link set veth-right up
```

Apply impairment only inside `tc-left`:

```sh
ip netns exec tc-left tc qdisc replace dev veth-left root \
  netem delay 5ms 1ms loss 1%

ip netns exec tc-left tc -s -d qdisc show dev veth-left
ip netns exec tc-left ping -c 100 192.0.2.2
```

Ping confirms connectivity and gives a coarse round-trip view; it does not validate one-way packet delay or UDP sequence behavior. A better lab sends numbered UDP datagrams at a controlled rate, records sender and receiver timestamps in a known clock arrangement, and reports loss, duplication, reorder distance, and delay distribution. TCP tests should report retransmissions and application completion time as well as RTT.

Both namespaces share the same kernel scheduler and usually the same host clock. That simplifies delay comparison but fails to reproduce separate-host clock error, physical serialization, NIC DMA, interrupt handling, or switch queues. The lab validates qdisc and application logic first; a two-host hardware test validates the deployment path.

Capture at both namespace endpoints when needed:

```sh
ip netns exec tc-left tcpdump -ni veth-left -w /tmp/tc-left.pcap
ip netns exec tc-right tcpdump -ni veth-right -w /tmp/tc-right.pcap
```

Capture changes CPU work and timing, and virtual-device capture points may observe segmentation aggregates differently. Treat captures as one observer. Reconcile them with sequence numbers and qdisc counters.

Cleanup is destructive to the named lab namespaces, so verify the names before running it:

```sh
ip netns del tc-left
ip netns del tc-right
```

Deleting a namespace deletes devices owned only by it and terminates its network context after references disappear. Do not reuse generic names that might belong to another test. An automated lab should create unique names, trap ordinary failures, and still provide an explicit inventory-based cleanup command.

## 32.12 Offloads, Multiqueue Effects, and Measurement Limits

Offloads change the unit and location of packet work. With TCP segmentation offload or generic segmentation offload, one large `skb` can reach parts of the qdisc/driver path and be segmented later. Receive aggregation can make captures above the driver show packets larger than wire frames. Checksum and VLAN offloads can make captured headers appear incomplete or unusual.

This affects shaping. A qdisc may account an aggregate's bytes correctly yet release them in a burst that the NIC later divides. Some qdiscs and kernel paths contain offload-aware logic, but behavior depends on qdisc, kernel, driver, and device. If microburst control matters, measure departures at an external receiver, hardware tap, or suitable NIC timestamp point.

Multiqueue devices add parallel paths:

```text
root mq
  +-- TX queue 0 leaf qdisc -- ring 0
  +-- TX queue 1 leaf qdisc -- ring 1
  +-- TX queue 2 leaf qdisc -- ring 2
  +-- TX queue 3 leaf qdisc -- ring 3
```

Queue selection, XPS, socket mapping, and driver behavior determine which leaf sees a flow. Per-queue counters can reveal imbalance. An aggregate rate across queues can exceed a per-leaf expectation if the shaper was attached at the wrong level, while a single hot queue can build latency despite spare capacity elsewhere.

Hardware-offloaded filters or shapers move work and counters away from the software path. `tc` may display `in_hw` or related status when supported, but semantics and statistics are driver-specific. A rule that cannot offload may fall back to software unless explicitly forbidden. Decide whether fallback is correctness, performance degradation, or deployment failure.

Changing offloads for measurement can change the system being measured. Disabling GSO/TSO often raises packet rate, interrupts, descriptor pressure, and CPU cost. Report both the configuration being evaluated and any diagnostic configuration, and never transfer conclusions between them without a controlled comparison.

Virtual machines and containers add host qdiscs, virtual switches, hypervisor queues, and physical NIC queues outside a guest's view. Cloud platforms may apply undisclosed policers. A guest's `tc -s` output cannot account for queues it does not own.

A complete experiment records:

- kernel, iproute2, driver, firmware, and NIC identity;
- qdisc tree, filters, actions, and counters;
- queue count, queue mapping, and offload settings;
- packet sizes on wire and as seen at each capture point;
- offered-load distribution and CPU placement;
- receiver sequence data and timestamps;
- switch or external observer evidence when available.

`netem` is excellent for testing application response to controlled impairment. It does not reproduce every switch buffer, PHY error, route change, congestion-control interaction, or adversarial queue. The model is useful precisely when its limits are stated.

Use several observers to separate configuration from effect. Qdisc counters establish enqueue/dequeue decisions, receiver sequence numbers establish delivery semantics, timestamps estimate delay, and external captures establish wire behavior. When they disagree, first compare accounting points and clock domains. A single dashboard number cannot prove the packet path.

## 32.13 Interview Check

1. Place a root egress qdisc, driver queue, NIC ring, ingress hook, and IFB on a packet-path diagram. Which of these can still queue after a TBF dequeue?
2. Compare classless and classful qdiscs. Why does selecting an HTB class not fully determine a packet's leaf queue behavior?
3. A team changes a FIFO limit from 1,000 to 100,000 packets and drops disappear. Explain the likely tail-latency and memory consequences.
4. Compare `fq`, `fq_codel`, CAKE, `mq`, and `noqueue` for state, isolation, overload behavior, and placement.
5. Design a `netem` experiment for UDP loss and reorder recovery. What evidence would show that the application—not merely the qdisc configuration—behaved correctly?
6. Explain token bucket rate, burst, and queue limit. At a fixed service rate, how would you derive a maximum backlog from a queueing-time budget?
7. Choose between shaping and policing for market data, order traffic, and telemetry. State the application-visible overload behavior for each choice.
8. Review a flower filter that reports zero packets. Which hook, protocol, VLAN, priority, offload, and namespace checks would you perform?
9. Why can TSO/GSO and multiqueue hardware make `tc` counters disagree with a packet capture or wire-level burst observation?
10. Outline a production-safe traffic-control change procedure, including privilege scope, state capture, verification, rollback, and out-of-band recovery.
