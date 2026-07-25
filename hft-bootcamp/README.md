# HFT System Engineering Bootcamp
### A Preparation Guide for Low-Latency Interviews

**Scope:** systems engineering only — hardware, operating systems, networking, measurement.
**Out of scope:** C++ language mechanics, quantitative/mathematical content, and trading-domain
components (order books, matching engines, strategy, risk models).

---

## Table of Contents

## Part 0 — Orientation

**Chapter 1. What "Low Latency" Actually Means**
- 1.1 Latency vs. throughput vs. jitter
- 1.2 Tail latency: why p99.9 is the only number that matters
- 1.3 The latency budget: wire → NIC → kernel → application → NIC → wire
- 1.4 Orders of magnitude: nanoseconds, cache misses, syscalls, context switches, network hops
- 1.5 Determinism as a first-class goal
- 1.6 How low-latency interviews are structured and what they probe

**Chapter 2. The Mental Model of a Trading Host**
- 2.1 Anatomy of a colocated server
- 2.2 The hot path vs. the cold path
- 2.3 Where jitter comes from: a taxonomy
- 2.4 Trade-offs: latency vs. throughput vs. reliability vs. cost

---

## Part I — Hardware Foundations for Performance Engineering

**Chapter 3. CPU Microarchitecture Essentials**
- 3.1 Pipelines, superscalar execution, out-of-order execution
- 3.2 The frontend: fetch, decode, µop cache
- 3.3 The backend: execution ports, reservation stations, retirement
- 3.4 Instruction-level parallelism and why it hides latency
- 3.5 Branch prediction and the cost of a mispredict
- 3.6 Speculative execution and pipeline flushes
- 3.7 Hardware prefetchers: what they detect and how to cooperate

**Chapter 4. The Cache Hierarchy**
- 4.1 L1i / L1d / L2 / L3: sizes, latencies, inclusivity
- 4.2 Cache lines, sets, ways, associativity
- 4.3 Cache line fills, evictions, and write-back vs. write-through
- 4.4 Conflict misses, capacity misses, compulsory misses
- 4.5 False sharing and cache line padding
- 4.6 Cache line alignment and structure layout
- 4.7 Store buffers, line-fill buffers, and non-temporal stores
- 4.8 Cache warming and keeping the hot path resident
- 4.9 Measuring cache behavior with hardware counters

**Chapter 5. Memory Systems**
- 5.1 DRAM organization: channels, ranks, banks, rows
- 5.2 Memory latency vs. memory bandwidth
- 5.3 Virtual memory, page tables, and the page walk
- 5.4 The TLB, TLB misses, and huge pages
- 5.5 NUMA topology, local vs. remote access, and interconnects
- 5.6 NUMA-aware allocation and thread placement
- 5.7 Memory access patterns: sequential, strided, random
- 5.8 Data-oriented layout: array-of-structs vs. struct-of-arrays

**Chapter 6. Multicore, Coherence, and Memory Ordering**
- 6.1 SMP, chiplets, and on-die interconnect
- 6.2 Cache coherence protocols (MESI/MESIF/MOESI)
- 6.3 The cost of a coherence miss vs. a DRAM miss
- 6.4 Memory consistency models: TSO, weak ordering
- 6.5 Store buffers, memory barriers, and fences
- 6.6 Atomics at the hardware level: LOCK prefix, LL/SC, cost of contention
- 6.7 Simultaneous multithreading (hyperthreading) and resource sharing
- 6.8 Whether to disable SMT on trading hosts

**Chapter 7. Clocks, Timers, and Time**
- 7.1 TSC, invariant TSC, and reading cycle counters
- 7.2 HPET, ACPI PM timer, and clock sources
- 7.3 Frequency scaling, turbo, C-states, P-states, and their jitter cost
- 7.4 Timestamping accuracy and clock drift
- 7.5 Monotonic vs. wall clock, and clock reading overhead

**Chapter 8. Buses, Devices, and I/O Hardware**
- 8.1 PCIe: lanes, generations, topology, root complex
- 8.2 DMA, MMIO, and doorbell registers
- 8.3 Interrupts: MSI/MSI-X, interrupt coalescing, interrupt affinity
- 8.4 DDIO / direct cache injection
- 8.5 NIC architecture: rings, descriptors, offloads
- 8.6 FPGAs and hardware acceleration: where the boundary sits
- 8.7 Switch architecture: store-and-forward vs. cut-through, buffering, port-to-port latency

---

## Part II — Operating Systems

**Chapter 9. Kernel Architecture and the Syscall Boundary**
- 9.1 User space vs. kernel space
- 9.2 Syscall mechanics and their real cost
- 9.3 vDSO and syscall avoidance
- 9.4 Traps, faults, and exceptions
- 9.5 Kernel preemption models
- 9.6 Meltdown/Spectre mitigations and their latency tax

**Chapter 10. Processes, Threads, and Scheduling**
- 10.1 Process and thread lifecycle, PCB/task_struct
- 10.2 Context switch anatomy and cost
- 10.3 CFS/EEVDF: how the default scheduler works
- 10.4 Real-time scheduling classes: SCHED_FIFO, SCHED_RR, SCHED_DEADLINE
- 10.5 Priorities, nice values, and priority inversion
- 10.6 CPU affinity and thread pinning
- 10.7 Core isolation: `isolcpus`, `nohz_full`, RCU offload
- 10.8 Housekeeping cores and IRQ steering
- 10.9 Busy-polling vs. blocking: spin, yield, and hybrid waiting
- 10.10 cgroups, containers, and their scheduling implications

**Chapter 11. Memory Management**
- 11.1 The virtual address space layout
- 11.2 Demand paging, page faults, and minor vs. major faults
- 11.3 Page cache and the buffer cache
- 11.4 Allocators: kernel slab, glibc malloc, tcmalloc, jemalloc — behavior and latency profile
- 11.5 Preallocation, pre-faulting, and `mlockall`
- 11.6 Transparent huge pages vs. explicit huge pages
- 11.7 Swap, overcommit, and the OOM killer
- 11.8 Shared memory, `mmap`, and anonymous mappings
- 11.9 Copy-on-write and fork semantics

**Chapter 12. Synchronization and IPC**
- 12.1 Mutexes, futexes, and the fast/slow path
- 12.2 Spinlocks, adaptive locks, and reader-writer locks
- 12.3 Condition variables and wakeup latency
- 12.4 Lock-free and wait-free queues: concepts and hazards
- 12.5 SPSC ring buffers and shared-memory transports
- 12.6 Pipes, Unix domain sockets, eventfd, signals
- 12.7 POSIX shared memory and `/dev/shm`
- 12.8 The ABA problem, memory reclamation, and lifetime hazards
- 12.9 Priority inversion and inheritance in practice

**Chapter 13. I/O Subsystems**
- 13.1 File descriptors and the VFS
- 13.2 Blocking, non-blocking, and asynchronous I/O
- 13.3 `select` / `poll` / `epoll`: mechanics and trade-offs
- 13.4 Edge-triggered vs. level-triggered
- 13.5 `io_uring`: submission/completion queues and polled mode
- 13.6 Buffered vs. direct I/O, `fsync`, and durability
- 13.7 Storage: NVMe queues, SSD behavior, write amplification
- 13.8 Journaling and low-latency logging strategies

**Chapter 14. The Linux Networking Stack**
- 14.1 Packet reception path: NIC → DMA → softirq → protocol stack → socket
- 14.2 Packet transmission path and qdiscs
- 14.3 NAPI, softirqs, and interrupt mitigation
- 14.4 sk_buff lifecycle and copies
- 14.5 Socket buffers, backlogs, and drop counters
- 14.6 RSS, RPS, RFS, XPS and flow steering
- 14.7 Offloads: checksum, TSO/GSO/GRO/LRO — and when to disable them
- 14.8 Busy polling (`SO_BUSY_POLL`), `SO_REUSEPORT`
- 14.9 Hardware and software timestamping (`SO_TIMESTAMPING`)

**Chapter 15. Tuning a Linux Box for Determinism**
- 15.1 BIOS/UEFI settings that matter
- 15.2 Kernel boot parameters checklist
- 15.3 `sysctl` knobs worth knowing
- 15.4 Disabling power management and frequency scaling
- 15.5 Taming timers, RCU, kernel threads, and background daemons
- 15.6 Managing NMIs, SMIs, and system management mode
- 15.7 Real-time kernels: PREEMPT_RT trade-offs
- 15.8 Reproducible benchmarking environments

---

## Part III — Networking and TCP/IP

**Chapter 16. The Network Stack from the Bottom Up**
- 16.1 Layering models and where they leak
- 16.2 Ethernet framing, MTU, jumbo frames
- 16.3 Encapsulation, headers, and per-layer overhead
- 16.4 ARP, VLANs, and switching fundamentals
- 16.5 Serialization delay, propagation delay, queueing delay

**Chapter 17. IP and the Network Layer**
- 17.1 IPv4 and IPv6 headers field by field
- 17.2 Fragmentation, reassembly, and Path MTU Discovery
- 17.3 Routing tables, longest-prefix match, TTL
- 17.4 ICMP and diagnostics
- 17.5 NAT and why it's absent from trading paths
- 17.6 DSCP/QoS marking

**Chapter 18. UDP and Multicast**
- 18.1 UDP header, semantics, and checksums
- 18.2 Why market data is UDP multicast
- 18.3 IGMP, multicast group management, and switch snooping
- 18.4 A/B feed arbitration and gap detection as a networking pattern
- 18.5 Packet loss, reordering, and duplication
- 18.6 Receive buffer sizing and burst absorption
- 18.7 Multicast storms and incast

**Chapter 19. TCP In Depth**
- 19.1 TCP header, flags, sequence and acknowledgment numbers
- 19.2 Connection establishment, the three-way handshake, SYN backlog, SYN cookies
- 19.3 Connection teardown, FIN/RST, TIME_WAIT, and port exhaustion
- 19.4 The state machine in full
- 19.5 Sliding window and flow control
- 19.6 Congestion control: slow start, congestion avoidance, fast retransmit/recovery
- 19.7 Modern algorithms: CUBIC, BBR — behavior, not derivation
- 19.8 Retransmission timeout, RTT estimation, and SACK
- 19.9 Nagle's algorithm, delayed ACK, and their pathological interaction
- 19.10 `TCP_NODELAY`, `TCP_QUICKACK`, `TCP_CORK`
- 19.11 Keepalives, half-open connections, and failure detection
- 19.12 Head-of-line blocking
- 19.13 Bufferbloat and queue management

**Chapter 20. Sockets Programming Model**
- 20.1 The socket API surface and its state transitions
- 20.2 Socket options that matter for latency
- 20.3 Blocking vs. non-blocking connect/accept
- 20.4 Zero-copy paths: `sendfile`, `MSG_ZEROCOPY`, `splice`
- 20.5 Scatter-gather I/O
- 20.6 Error handling: partial writes, EAGAIN, EINTR, RST semantics
- 20.7 Backpressure and slow-consumer handling

**Chapter 21. Kernel Bypass**
- 21.1 Why the kernel is in the way
- 21.2 DPDK: PMDs, hugepages, poll mode, core model
- 21.3 Solarflare/Onload, ef_vi, and TCPDirect
- 21.4 AF_XDP and eBPF/XDP fast paths
- 21.5 RDMA and RoCE concepts
- 21.6 User-space TCP stacks
- 21.7 Trade-offs: portability, debuggability, CPU burn
- 21.8 When bypass is the wrong answer

**Chapter 22. Network Design and Operations**
- 22.1 Colocation, cross-connects, and cable length as latency
- 22.2 Switch selection and port-to-port latency
- 22.3 Microbursts, buffer occupancy, and drop diagnosis
- 22.4 Link aggregation and redundancy
- 22.5 Multicast distribution architecture
- 22.6 Line arbitration and diverse paths
- 22.7 Microwave, millimeter wave, and hollow-core fiber: the physics of the fast route
- 22.8 Time synchronization: NTP, PTP (IEEE 1588), hardware timestamping, GPS/PPS
- 22.9 Network capture: SPAN/TAP, packet brokers, nanosecond-precision capture

**Chapter 23. Network Debugging Toolkit**
- 23.1 `tcpdump`, Wireshark, and reading a trace by hand
- 23.2 `ss`, `netstat`, `ethtool`, `ip`
- 23.3 Interpreting drop, error, and overrun counters
- 23.4 `nstat` / `/proc/net/snmp` TCP counters
- 23.5 Diagnosing retransmits, resets, and stalls
- 23.6 Latency measurement: ping, one-way delay, hardware timestamps

---

## Part IV — Measurement, Profiling, and Optimization

**Chapter 24. Measuring Correctly**
- 24.1 Why averages lie: percentiles and histograms
- 24.2 Coordinated omission
- 24.3 Warm-up, steady state, and measurement bias
- 24.4 Timestamping methodology and instrumentation overhead
- 24.5 Repeatability and confidence without heavy statistics
- 24.6 Building a latency harness
- 24.7 Wire-to-wire vs. in-process measurement

**Chapter 25. Profiling Tools and Hardware Counters**
- 25.1 `perf`: sampling, tracepoints, `perf stat`
- 25.2 PMU counters: cycles, instructions, IPC, cache misses, branch misses, stalls
- 25.3 Top-down microarchitecture analysis
- 25.4 Intel VTune / AMD uProf overview
- 25.5 Flame graphs and off-CPU analysis
- 25.6 `ftrace`, eBPF, `bpftrace`, and BCC tools
- 25.7 Intel PT and last-branch records
- 25.8 Tracing jitter to its source

**Chapter 26. Systematic Optimization**
- 26.1 A method: measure → hypothesize → change → verify
- 26.2 Picking the right target: where the time actually goes
- 26.3 Eliminating syscalls, allocations, and copies from the hot path
- 26.4 Reducing branches and improving predictability
- 26.5 Data layout and access pattern rewrites
- 26.6 Batching vs. latency, and when batching hurts
- 26.7 Precomputation and hot-path/cold-path separation
- 26.8 Avoiding the classic anti-patterns

**Chapter 27. Jitter Hunting**
- 27.1 A checklist of jitter sources
- 27.2 Page faults, TLB shootdowns, and IPIs
- 27.3 Timer interrupts and kernel background work
- 27.4 SMIs and firmware interference
- 27.5 Thermal throttling and power events
- 27.6 NUMA and cross-socket traffic
- 27.7 Contention and lock convoys
- 27.8 Case studies: from symptom to root cause

---

## Part V — Systems in Production

**Chapter 28. Reliability and Failure Handling**
- 28.1 Failure modes in a latency-critical system
- 28.2 Redundancy, failover, and hot/warm standby
- 28.3 Graceful degradation and kill switches
- 28.4 Health checks and heartbeats
- 28.5 Deterministic recovery and state reconstruction

**Chapter 29. Observability Without Slowing Down**
- 29.1 Low-overhead logging: ring buffers, deferred formatting, binary logs
- 29.2 Async telemetry off the hot path
- 29.3 Metrics collection and sampling strategy
- 29.4 Post-mortem capture and replay from packet traces
- 29.5 Alerting on latency regressions

**Chapter 30. Build, Deploy, and Environment Discipline**
- 30.1 Reproducible builds and binary provenance
- 30.2 Configuration management for tuned hosts
- 30.3 Continuous performance regression testing
- 30.4 Rollout strategy in a colo environment
- 30.5 Drift detection: verifying the machine is still tuned

---

## Part VI — Interview Preparation

**Chapter 31. The Question Bank**
- 31.1 Cache and memory questions
- 31.2 Concurrency and memory ordering questions
- 31.3 Operating system and scheduling questions
- 31.4 TCP/IP and sockets questions
- 31.5 Kernel bypass and NIC questions
- 31.6 Measurement and profiling questions
- 31.7 "Why is this slow?" diagnostic scenarios

**Chapter 32. Systems Design Rounds**
- 32.1 Designing a low-latency market data distribution path
- 32.2 Designing an inter-process transport
- 32.3 Designing a latency measurement and monitoring system
- 32.4 Designing for determinism under load
- 32.5 How to structure an answer: budget, bottleneck, trade-off

**Chapter 33. Estimation and Back-of-the-Envelope**
- 33.1 Latency numbers every candidate should know
- 33.2 Bandwidth and packet rate arithmetic
- 33.3 Reasoning about queueing intuitively
- 33.4 Sanity-checking a claimed number

**Chapter 34. Study Plan**
- 34.1 A structured multi-week path through this book
- 34.2 Hands-on labs and exercises per part
- 34.3 Building a personal benchmarking playground
- 34.4 Reading list and primary sources
- 34.5 Common gaps and how to close them

---

## Appendices

- **A.** Latency Reference Tables
- **B.** Linux Tuning Cheat Sheet (boot params, sysctls, BIOS)
- **C.** Socket Options Reference
- **D.** `perf` and `bpftrace` Recipe Book
- **E.** TCP/IP Header Reference Diagrams
- **F.** Counter and Metric Glossary (`ethtool -S`, `nstat`, PMU events)
- **G.** Glossary of Terms
- **H.** Annotated Bibliography

---
---

## Authoring Prompt

> Use the prompt below verbatim as the system/task prompt when generating chapters. Fill the
> `<<...>>` placeholders per invocation. Generate **one chapter per invocation** — never the whole
> book at once.

```markdown
You are writing one chapter of *HFT System Engineering Bootcamp*, a fast-paced technical book that
prepares an experienced engineer for C++ low-latency interviews at trading firms.

## The reader

A working software engineer with a solid CS background and **no low-latency experience**. Calibrate
to that gap precisely — it is the single most important thing to get right.

**What they already have.** Undergraduate-level systems knowledge: they know what a cache, a
process, a thread, a page table, a socket, and TCP are. They have written concurrent code. They can
read a man page. Do not re-teach these from zero and do not paraphrase documentation.

**What they do not have.** Any intuition for *scale*, for *variance*, or for *why any of it matters
at nanosecond resolution*. Specifically, assume they have never:
- reasoned about the difference between a 100 ns and a 100 µs operation as an engineering constraint;
- seen a latency histogram, or thought about a tail as distinct from an average;
- tuned an operating system, pinned a thread, or touched a NIC setting;
- traced a performance problem to hardware behavior rather than to their own code;
- had to care whether something was *predictable*, as opposed to merely fast.

**What follows from that.** Every mechanism must be motivated before it is described. The reader
needs to know *what problem exists* and *why the obvious approach fails* before they can absorb how
the hardware or kernel solves it. A knob name means nothing to them until they understand the
mechanism it controls; a number means nothing until they can compare it to something.

They are preparing for interviews, but they are learning this material for the first time. Teach it.

## Scope boundaries — enforce strictly

IN scope: CPU microarchitecture, cache and memory, NUMA, operating systems (Linux), scheduling,
synchronization primitives at the OS/hardware level, I/O, the network stack, TCP/IP, kernel bypass,
measurement, profiling, and production operation of latency-critical hosts.

OUT of scope — never write about these, even in passing examples:
- C++ language features, syntax, idioms, templates, STL, compiler-specific C++ behavior.
- Mathematical or quantitative content: derivations, proofs, queueing formulas, statistics beyond
  reading a percentile off a histogram.
- Trading-domain components: order books, matching engines, market microstructure, strategies,
  execution algorithms, risk models, PnL.

Trading context may appear only as *motivation for a systems requirement* — e.g. "market data
arrives as UDP multicast, so receive-buffer sizing determines burst tolerance." One sentence, then
back to systems.

## Voice and pacing

The book is structured and scannable, but it **teaches** — it is not a cheat sheet. Bullets, tables,
and diagrams carry the reference material; prose carries the understanding. Both are load-bearing.

**Explain before you enumerate.** Every section opens with real explanatory prose — typically two to
four paragraphs — that establishes:

1. the problem this mechanism exists to solve,
2. why the naive approach fails,
3. how the mechanism works, in narrative form,
4. only then, why a latency-sensitive system cares.

Only after that does the section switch to bullets and tables for the specifics, the numbers, and
the knobs. A section that opens with a bullet list has skipped the teaching and is wrong.

- **Paragraphs are allowed and expected.** Write as many sentences as the explanation genuinely
  needs. The previous hard cap on consecutive sentences is withdrawn.
- **But never pad.** Every sentence must carry a fact, a mechanism, a consequence, or a
  motivation. Cut anything that merely restates, previews, or transitions decoratively.
- **Build from the familiar.** Start from something the reader already knows from a CS degree, then
  extend. "You know a cache stores recently-used data. What an undergraduate course omits is that…"
- **Use concrete scenarios to motivate.** A short worked example — a specific access pattern, a
  specific packet arriving, a specific thread being descheduled — beats an abstract statement of the
  problem.
- **Define terms on first use, in place.** Do not assume vocabulary like "row buffer," "shootdown,"
  "softirq," "microburst," "coordinated omission."
- **Bullets carry specifics, not explanations.** Each bullet leads with a **bold claim**, then a
  clause of detail. If a bullet needs three sentences to make sense, its content belongs in the prose
  above it.
- **Tables for anything comparative.** Options, knobs, trade-offs, cost figures, state transitions,
  header fields, tool flags. Prefer a table over prose *for comparisons* — not for explanations.
- **Mermaid diagrams for anything with structure or flow.** Data paths, state machines, hierarchies,
  timelines, topologies. Aim for 3–6 diagrams per chapter, each introduced by the prose around it.
- No throat-clearing. No "in this chapter we will." No summaries of what was just said.
- No filler adjectives, no hype, no marketing tone. Precision over enthusiasm.

## Required chapter structure

1. **`# Chapter Title`**
2. **Opening** — two or three paragraphs establishing what this chapter's subject is, what goes
   wrong without understanding it, and how it fits the end-to-end latency picture. Teach, don't
   announce.
3. **`## Section` per numbered subsection in the outline** — use the outline's subsection titles as
   the section headings, rewritten as prose titles, not numbered. Split a section into `###`
   subsections whenever it covers genuinely distinct mechanisms.

   **Each section follows this internal shape:**
   - **Explanatory prose** (2–4 paragraphs) — problem, why the naive approach fails, how it works,
     why latency work cares.
   - **Specifics** — bullets, a table, a diagram.
   - **`**Failure mode:**` callouts** — one to three per section, inline, as a bolded lead-in
     paragraph or bullet. Each names a symptom, its cause, and the specific tool, counter, or file
     that confirms it. These are placed *where the mechanism is explained*, so the reader meets the
     pathology immediately after the theory.
   - **`**Try it:**` callout** — one or two per section, inline, as a bolded lead-in paragraph. A
     concrete exercise on a Linux box: exact commands, files under `/proc` and `/sys`, `perf`
     invocations, knobs to flip. State what the reader should observe and what it means.

   Failure modes and exercises are **distributed through the chapter, never collected into
   end-of-chapter sections.** A section that explains a mechanism and does not show how it fails or
   how to observe it is incomplete.
4. **`## Numbers to Know`** — a summary table of the concrete latencies, sizes, or costs introduced
   in this chapter. Order-of-magnitude figures, with the hardware class they refer to. This is the
   only end-of-chapter reference block; it collects numbers already taught, adding nothing new.
5. **`## Key Takeaways`** — 8–12 single-line bullets. No new material.

**Do not add an interview-questions section to a chapter.** All interview Q&A, design rounds, and
estimation drills live exclusively in Part VI. Part VI chapters use their own
question-and-answer-sketch structure and skip items 4–5 above.

## Mermaid rules

- Use fenced ```mermaid blocks.
- Prefer `flowchart`, `stateDiagram-v2`, `sequenceDiagram`, `block-beta`.
- Label edges with what actually crosses them (a packet, a cache line, a wakeup, a DMA write).
- Use `<br/>` for line breaks inside nodes; `<i>` for secondary detail.
- Keep each diagram under ~12 nodes. Split rather than crowd.
- Every diagram must be referenced by at least one adjacent bullet — no decorative diagrams.

## Code and command rules

- **No C++.** No C either, unless a 3–5 line snippet is the only honest way to show a syscall
  sequence or a struct layout — and then keep it minimal and unidiomatic-free.
- Shell, `perf`, `bpftrace`, `ethtool`, kernel boot parameters, `sysctl` settings, and config
  fragments are encouraged and should be exact and copy-pasteable.
- Name real files: `/proc/interrupts`, `/sys/devices/system/cpu/...`, `/proc/net/snmp`.
- Never invent a flag, counter, sysctl, or file path. If unsure it exists, describe the mechanism
  and say which tool exposes it instead of guessing a name.

## Accuracy rules

- Latency and size figures are order-of-magnitude teaching aids: label them as typical for a stated
  class of hardware (e.g. "modern x86 server, Skylake-and-later"), never as universal constants.
- Distinguish clearly between: architectural guarantees, Linux implementation details that change
  across versions, and vendor-specific behavior.
- When something is contested or workload-dependent, say so in one clause rather than picking a
  side silently.
- Prefer "this costs roughly N ns because X" over an unexplained number.

## Continuity

- Cross-reference other chapters by title in the form: *(see "The Cache Hierarchy")*.
- Do not re-teach material owned by an earlier chapter; one-line reminder plus a cross-reference.
- Terminology must match the book glossary. Introduce an acronym once with its expansion, then use
  the acronym.

## Length

**There is no word limit.** Write the length the material requires to be genuinely understood by a
reader encountering it for the first time. A thorough chapter on a dense topic may run well past
6,000 words; a narrow one may not.

Length is never the goal — completeness of explanation is. The test for any passage is: *would a
competent engineer with no low-latency background finish this section able to explain the mechanism
to someone else, predict how it fails, and observe it on a real machine?* If not, it is too short,
regardless of word count. If a passage could be deleted without weakening that outcome, it is
padding, regardless of word count.

Do not compress by dropping the explanatory prose and leaving bullets — that produces a reference
card, which is exactly what this book is not.

## Output

Output the chapter as a single markdown document. No commentary before or after it. Do not restate
these instructions.

---

## This invocation

Write **Chapter <<N>>: <<CHAPTER TITLE>>**.

Outline subsections to cover:
<<PASTE THE SUBSECTION LIST FROM THE TABLE OF CONTENTS>>

Chapters already written (do not re-teach; cross-reference instead):
<<LIST OF PRIOR CHAPTER TITLES>>
```
