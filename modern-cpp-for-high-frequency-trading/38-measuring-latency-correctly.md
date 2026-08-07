# Chapter 38 — Measuring Latency Correctly

A latency number is meaningful only with a workload, a boundary, and an observation method. A tight loop can reveal instruction cost while hiding page faults, queueing, and scheduler delay; an end-to-end test can expose production tails while obscuring their cause. This chapter constructs measurements in layers, explains how closed-loop generators can erase stalls from their own data, and shows how to connect distributions to hardware and operating-system evidence without mistaking correlation for proof.

## 38.1 Microbenchmarks Versus End-to-End Measurements

A **microbenchmark** measures a deliberately small operation under controlled conditions. An **end-to-end measurement** spans a user-visible or protocol-visible transaction, such as NIC timestamp to order-send completion. They answer different questions.

A microbenchmark can compare two parsers on identical bytes, count allocations, inspect vectorization, and isolate cache-state effects. It cannot by itself predict a production path containing queues, interrupts, locks, syscalls, NUMA traffic, and overload policy. Its narrowness is a feature when the claim is narrow.

An end-to-end test includes interactions that dominate tail latency: batching, kernel wakeups, queue occupancy, retransmission, page faults, peer behavior, and clock synchronization. It identifies whether the system meets an outcome but rarely identifies which instruction caused a miss. Use profiles, counters, and narrower experiments after locating the failing interval.

Define the measurement boundary before running code:

```text
wire ingress -> NIC -> kernel/driver -> parser -> strategy -> risk -> send -> wire
      A                                                            B

software latency: chosen in-process timestamps
host latency:     A-host to B-host timestamp points
wire latency:     timestamp points near physical ingress/egress
```

Different points include different work. A userspace timestamp after `recv` excludes prior queueing. A send-call return usually means bytes were accepted by a software layer, not transmitted. Hardware timestamp semantics depend on NIC, driver, and socket configuration, as Chapter 33 explains.

Use a measurement ladder: confirm semantics with tests, isolate a component, integrate two adjacent stages, then measure end to end. If component results and end-to-end results disagree, investigate the interactions rather than adding component means. Cache state, queueing, and concurrency make systems non-additive.

One-way latency requires a common clock domain or a measured conversion between clocks. Round-trip latency can use one clock but includes the return path and peer processing. Dividing a round trip by two assumes symmetry that networks, queues, and processor placement rarely guarantee. State whether timestamps represent one way, round trip, or a bounded component.

Measurement boundaries also determine ownership. Timing until a queue push completes measures producer admission; timing until the consumer acknowledges measures handoff; timing until exchange bytes leave a NIC includes a different completion. Name the endpoint operation precisely rather than calling every boundary “send latency.”

## 38.2 Preventing Optimization of Measured Work

A compiler may remove measured work when its result has no observable effect. This is legal under the as-if rule and can turn a benchmark into a timer loop.

The most portable defense is to compute a result and make it observable outside the timed region. A checksum returned from the benchmark process works when the compiler cannot prove its value in advance. Inputs should be unavailable as compile-time constants, but reading a file or generating randomness must occur outside the timed section.

```cpp
#include <cstdint>
#include <span>

std::uint64_t checksum(std::span<const std::uint32_t> values) {
    std::uint64_t sum = 0;
    for (auto value : values) {
        sum += value;
    }
    return sum;
}

// Time checksum(data), then print or validate the returned value afterward.
```

Benchmark libraries offer compiler-specific “do not optimize” and “clobber memory” barriers. Their contracts differ: one may force a value to appear used, while another prevents assumptions about memory. Use the library primitive as documented and inspect optimized assembly. A barrier can also inhibit useful optimization and make the measured code unlike production.

`volatile` is not a general solution. Volatile accesses are observable to C++, so they can prevent elimination, but they change loads and stores and do not model ordinary memory, atomics, or interthread synchronization. A volatile accumulator measures volatile behavior.

Inlining also changes the question. Measuring a function through an indirect call includes call overhead and may prevent constant propagation. Inlining it into the harness may expose the production optimization opportunity. Select the form matching the claim, compile with production flags, and inspect both source and assembly.

Check for constant folding, dead branches, loop invariant motion, vectorization, and replacement by a library intrinsic. Record compiler version, target flags, LTO/PGO settings, and linked library. The benchmark executable—not the source file—is the experiment.

Harness overhead can dominate tiny operations. An indirect benchmark callback, exception guard, parameter lookup, and clock read may perform more work than an integer conversion. Measure an empty or minimal control with the same harness to understand scale, but do not mechanically subtract it when overlap and branch prediction differ.

Beware dependency chains. Repeatedly feeding one iteration's result into the next measures operation latency; applying independent inputs can measure reciprocal throughput through parallel execution units. Both are valid, but they answer different microarchitectural questions. Make dependencies match production.

## 38.3 Warmup, Preallocation, and Page Touching

**Warmup** executes preparatory work so that the measured phase starts in a specified state. It can initialize code pages, dynamic linking, allocator arenas, branch predictors, caches, page tables, and JIT state in languages that use one. C++ native code still has substantial first-use work.

Preallocate bounded containers and pools before timing if production does so. Reserve capacity is not enough when the first writes still fault pages. Touch every required writable page on the intended NUMA node, as Chapter 13 describes. Create long-lived threads and exercise intended stack depth and thread-local storage.

Warmup is not automatically truthful. A first-message service must measure cold behavior. An engine that runs continuously after a pre-session preparation phase should measure the warmed state and separately validate startup. State the cache condition:

- hot data and hot code;
- hot code with a working set larger than cache;
- intentionally cold lookup;
- post-idle state after power-saving transitions;
- post-restart or post-failover state.

Allocator warmup can hide growth and contention. If production reuses a fixed pool, that is correct. If production allocations occasionally expand arenas, the benchmark must include the expansion distribution or characterize it separately. The same rule applies to branch predictors: repeating one message type produces an unrealistically predictable path.

Warm for a condition, not an arbitrary duration. Monitor faults and iteration stability, and establish a stopping rule before looking at results. Discarding early samples merely because they are slower edits the workload after observation.

Cache “clearing” is difficult. Reading a large eviction buffer changes TLBs, prefetchers, memory-controller state, and power; cache-maintenance instructions are architecture-specific and may not recreate production coldness. Prefer a working-set experiment with documented access order, or run separate processes/epochs when startup coldness is the real condition.

## 38.4 CPU Pinning and Frequency Control

CPU affinity restricts where a benchmark thread may run. Pinning reduces migration and makes per-CPU cache, counter, and clock behavior easier to interpret. It does not reserve the CPU or prevent interrupts, kernel work, SMT-sibling contention, or thermal throttling.

On Linux, use `taskset`, `sched_setaffinity`, or `pthread_setaffinity_np` and verify the effective mask through `/proc/$PID/status` or `taskset -pc`. Cgroups and cpusets can further restrict it. Pin producer and consumer deliberately; placing both on one CPU measures time sharing, while placing them on SMT siblings or separate NUMA nodes measures different coherence paths.

Frequency changes convert cycles to time differently and can alter instruction throughput, memory latency in core cycles, and power/thermal state. Record the CPU model, governor, allowed frequency range, turbo policy, C-states, temperature, and throttling evidence. Tools such as `cpupower` and `turbostat` are platform- and privilege-dependent.

Do not assume a fixed requested frequency equals a fixed delivered frequency. Modern CPUs manage per-core and package limits dynamically. Cycle counters may tick at a reference rate rather than current core frequency, depending on the counter. Use wall-clock duration for latency and counters to explain work; document the clock source.

CPU isolation and real-time scheduling can improve experimental control but change the deployment environment and can starve essential services. Apply them only in a disposable or operationally reviewed setup. A benchmark on an unrealistically isolated host provides an upper bound on cleanliness, not proof of production behavior.

Inspect the SMT sibling of every pinned CPU. A supposedly idle logical CPU may share execution ports, caches, and bandwidth with a noisy sibling. Either reserve both siblings or deliberately run the expected colocated load. Record IRQ affinity and kernel housekeeping as well; affinity alone does not create exclusivity.

## 38.5 Separating Setup From Measurement

The **timed region** contains exactly the work named by the result. Allocation, input generation, logging, timer calibration, thread creation, and result formatting belong outside unless the claim explicitly includes them.

```cpp
prepare_inputs();
warmup();

auto start = clock_now();
auto result = operation(inputs);
auto stop = clock_now();

validate(result);       // outside timed interval
record(stop - start);  // outside timed interval where possible
```

Moving work outside timing must not remove required semantics. If an API promises to parse and allocate an owned message, comparing it with a parser that returns a view performs different work. If a production call includes lock acquisition, measuring a helper after the lock answers a narrower question and must be labeled accordingly.

Per-iteration timing adds two clock reads and sample-storage work to every operation. Batch timing amortizes those costs but reports only an aggregate. A hybrid times groups for throughput and periodically samples individual requests, while end-to-end sequence timestamps capture queueing. Select granularity according to the distribution required.

Preallocate the sample store. Appending to a growing vector in the timed loop can allocate and fault. A fixed array or histogram has bounded memory, but histogram recording itself performs indexing and writes cache lines. Measure and report recording overhead.

Randomization setup also stays outside. Generate a reproducible input schedule with a recorded seed, then consume it during measurement. If looking up the schedule adds a load absent from production, compare that cost or generate inputs through the same production path.

## 38.6 Realistic Data and Contention Distributions

A benchmark workload is a statistical model of production inputs and concurrency. Uniform random data is realistic only when production is uniform.

Market workloads are often bursty and state dependent. Message types have different sizes and branches; symbols follow skewed popularity; cancel/replace rates vary; packet gaps trigger recovery; book depth and price distance change data-structure work. Preserve relevant correlations rather than sampling every field independently.

Contention is a distribution too. One uncontended atomic operation says little about a shared counter with eight writers. Test the expected writer/reader topology, affinity, ownership transfer, and burst overlap. Include quiet periods because they cause sleeping, C-state entry, and cold code; include bursts because they cause queues and cache-line bouncing.

Use recorded production traces only after addressing privacy, proprietary protocol, and reproducibility concerns. Replay timing must preserve arrival schedule independently of service progress, or coordinated omission appears. Synthetic generators are valuable when their model and seed are documented.

Adversarial cases belong beside typical cases: maximum legal record, hash collision, full ring, sequence gap, cold symbol, allocator exhaustion, and peer restart. Report them separately rather than blending rare correctness tests into one unexplained average.

Before collecting results, write the hypothesis and primary metric. Choosing the most favorable input distribution or percentile after seeing results creates selection bias. Repeat across independent runs and retain run-level results; millions of iterations in one run do not replace variation across boots, thermal states, and background activity.

## 38.7 Coordinated Omission

**Coordinated omission** occurs when a load generator waits for the system before scheduling the next request, thereby omitting requests that should have arrived during a stall. The observed latency samples look better precisely when the system is failing.

Suppose the intended arrival interval is one unit. A closed-loop generator sends request A, waits ten units for its reply, then sends B. It records one ten-unit latency. An open-loop schedule would have offered requests at the nine intervening times; those requests would have waited behind the stall and contributed additional high latencies.

```text
intended arrivals: 0 1 2 3 4 5 6 7 8 9 ...
closed-loop sends:  0 -------------------- 10 ...
observed samples:  [one slow] instead of [one slow plus queued arrivals]
```

Prevent omission by scheduling offered work from an independent clock. At each intended time, either submit the request, record an explicit drop/admission failure, or record how late submission became. Do not shift all future arrivals because one request was slow. The generator needs sufficient independent capacity so it does not become the bottleneck.

Some histogram libraries offer coordinated-omission correction by adding synthetic samples at expected intervals beneath an observed long latency. This is useful only when the assumed constant arrival process matches the experiment. It cannot reconstruct arbitrary burst arrivals or server-side drop behavior. Prefer a correct offered-load generator and use correction as a documented secondary analysis.

Closed-loop testing is still valid for closed-loop semantics. A single client that cannot issue a second request until the first reply really does create that workload. The error is claiming it represents independent market arrivals or many asynchronous clients.

Report offered rate, admitted rate, completed rate, drop count, queue depth or age, and latency from intended arrival as well as actual submission where possible. At overload, a system that rejects promptly can have low latency and low completion; the rejection is part of the result.

The generator's own lateness is measurable. If it intends to submit at time `t` but runs at `t+d`, record `d`; otherwise client descheduling is silently removed from offered-load timing. Precompute the schedule and use absolute sleeps or a controlled spin policy, then verify that the generator has CPU and network capacity above the offered peak.

## 38.8 Means, Variance, Histograms, and Percentiles

A latency distribution cannot be summarized by one central value. The arithmetic mean is sensitive to large stalls; the median describes the middle sample; variance and standard deviation describe squared dispersion but can be unstable for heavy-tailed data.

A **histogram** groups observations into value ranges. Linear buckets give constant absolute resolution; logarithmic or significant-digit schemes cover a wide range with bounded relative error. Document bucket boundaries, range, overflow behavior, unit, and recording precision. A histogram that saturates at its highest bucket hides the very tail under investigation.

Percentile `p` is a value at or below which approximately `p` percent of samples fall, under a stated quantile convention. Report p95 for the broader slow population, then p99, p99.9, and p99.99 as the sample count and service objective justify. p99.9 leaves about one in a thousand samples above it; p99.99 needs far more than ten thousand samples for a stable estimate. Exact rank rules differ between tools, so keep raw or mergeable histogram data.

Maximum is sample-count and duration dependent. A longer run has more opportunity to observe rare stalls. Report run duration, sample count, and maximum together. Compare equal observation windows and examine run-to-run maxima rather than treating one maximum as a population bound.

Percentiles do not add. The p99 latency of stage A plus p99 of stage B is neither necessarily nor generally the p99 of their sum. Preserve per-request correlation or measure the pipeline directly. Likewise, averaging per-thread percentiles is invalid; merge counts or raw distributions first.

Confidence requires independent experimental units. Consecutive messages share cache, queue, and thermal state, so they are not independent samples in the simple textbook sense. Repeat whole runs, randomize treatment order, and show dispersion across runs. Avoid reporting more decimal places than clock and histogram resolution support.

Histograms can be merged only when their units, bucket definitions, highest trackable value, and correction policy agree. Keep counts rather than precomputed percentile tables. For per-thread collection, use thread-local histograms and merge after the run to avoid one contended recorder; account for the memory footprint of one histogram per thread.

Percentiles need a population definition. “p99 across messages” weights busy symbols and sessions more heavily; “p99 of per-session p99” answers another question. Decide whether the service objective applies to every message, every client, or time windows, and aggregate accordingly.

## 38.9 Throughput Versus Latency

**Throughput** is completed work per time. **Latency** is elapsed time per item over a defined boundary. Increasing concurrency can improve throughput while increasing queueing latency.

Measure a load curve, not one point. Increase offered rate through and beyond expected production load; at each point report admitted and completed throughput, latency distribution, drops, and queue state. Near saturation, small load increases can produce disproportionate latency growth.

Little's Law relates long-run average population `L`, arrival/completion rate `lambda`, and average time `W` as `L = lambda W` for a stable system under its assumptions. It is a consistency check, not a percentile formula. If offered rate exceeds sustainable completion rate without dropping, queue population grows and no steady-state latency distribution exists.

Batching improves throughput by amortizing fixed work but holds early items. Report both batch size and batch-formation policy. A maximum-wait deadline prevents an idle stream from waiting forever for a full batch.

For HFT, useful capacity often means completing within a deadline, not merely completing eventually. Report goodput: valid, nonduplicate work completed within the service objective. A system can show high raw throughput while most results arrive too late to use.

## 38.10 Tail Amplification in Pipelines

A pipeline amplifies tail risk because a request encounters several stages and queues. End-to-end latency is the sum of stage service and waiting times, with possible parallel branches and retries.

If independent stages each meet a threshold with probability `p`, the chance all `n` meet it is `p^n`. Real stages are not independent: a CPU disturbance, memory pressure, or burst can slow several simultaneously. Correlation can make the end-to-end tail much worse than an independence estimate.

Queues couple stages. One slow stage accumulates work, so later requests experience waiting even after the original cause ends. Retries add load during failure and can create positive feedback. Bounded queues convert unlimited delay into explicit drop or backpressure, making the failure mode measurable.

Assign a sequence or trace identifier and record timestamps at carefully chosen boundaries. This permits per-request decomposition:

```text
arrival | queue A | stage A | queue B | stage B | send
        <------------- end-to-end ------------->
```

Timestamping every boundary adds work and shared storage. Sample requests or use per-thread buffers, and calibrate overhead. Clock domains must be comparable; cross-host decomposition requires synchronization and uncertainty bounds.

Optimize the stage responsible for end-to-end misses, not necessarily the largest mean stage. A short stage with rare allocator stalls can dominate p99.99. Conditional analysis—stage latency for requests whose total exceeded a threshold—can generate hypotheses, but shared causes mean it does not alone establish causation.

Parallel fan-out has a different tail. If a request waits for every one of several workers, completion follows the maximum branch latency; adding workers increases the chance one is slow. If it accepts the first valid reply, duplication may reduce latency but consumes extra capacity and can worsen other requests. Benchmark the actual join and cancellation policy.

## 38.11 Cycles, Instructions, IPC, Branches, Caches, and TLBs

Hardware performance counters count selected microarchitectural events. They explain work on a particular CPU; they are not portable language semantics.

Cycles and instructions produce **instructions per cycle** (IPC). High IPC can mean efficient execution, but low IPC can result from memory stalls, branch misses, dependencies, or intentional waiting. A version doing more unnecessary instructions can have higher IPC and be slower. Always pair ratios with elapsed time and raw counts.

Branch instructions and branch misses indicate prediction behavior under the measured input. Cache-reference/miss events differ by level and CPU; generic event aliases may map imperfectly. TLB events distinguish translation pressure only when supported and correctly selected. “Cache miss” is incomplete without level, operation, and event definition.

Frontend- and backend-stalled-cycle events are CPU-specific diagnostic signals, not portable categories with identical meanings. They can overlap, may count cycles under different qualification rules, and must not be added as if they partitioned total cycles. Select the documented events for the exact processor and interpret them with the corresponding pipeline model.

Counters are finite. Requesting more events than physical counters can cause multiplexing, reducing time each event runs and scaling results. `perf` reports enabled and running time; heavily multiplexed ratios have larger uncertainty. Grouped events may fail to schedule together. Measure a small hypothesis-driven set.

Speculation complicates counts. Some events count retired work, others issued or speculative work. Precise event-based sampling support varies. Counter skid can attribute an interrupt after the instruction responsible. Consult the processor vendor's performance-monitoring documentation and `perf list` for the actual machine.

A disciplined interpretation connects layers: latency rose; cycles rose while instructions stayed similar; a supported last-level-miss event rose; the access pattern changed to a larger working set. This supports a memory-stall hypothesis. It does not prove every extra cycle was one named cache miss.

Normalize counter deltas to useful operations and inspect absolute counts before ratios. A branch-miss rate can fall because total branches rose, while misses per message remain unchanged. An LLC miss count can rise because more valid work completed. Use confidence across repeated runs and do not combine separately multiplexed events into a precise ratio without checking scaling.

## 38.12 Context Switches, Faults, Migrations, and NUMA Events

Software events describe kernel interactions that hardware counters cannot. Voluntary context switches commonly occur when a thread blocks; involuntary switches occur when it is preempted. The counts do not directly state how long the thread waited.

CPU migrations can discard warm private-cache and TLB state and change NUMA distance. A pinned thread should normally show no migrations within its effective mask, but interrupts and other tasks can still run on its CPU. Record per-thread affinity and scheduler evidence.

Minor faults require kernel mapping work without storage I/O; major faults require backing I/O. Both are unacceptable in many steady-state critical paths. Fault counters identify occurrence, while address or trace information is needed to locate the mapping. A zero major-fault count does not mean memory pressure was absent.

NUMA events are architecture specific. Local/remote DRAM counts, interconnect traffic, and Linux `numastat` placement can support a remote-access hypothesis. They can be affected by page migration, shared pages, and counter scope. Correlate with `/proc/$PID/numa_maps`, CPU placement, and first-touch procedure.

Collect process and thread context switches, faults, migrations, throttling, and cgroup pressure alongside latency. A coincident event narrows investigation. Reproduce by deliberately inducing or removing the suspected condition before claiming cause.

## 38.13 Timer, Logging, Tracing, Capture, and Observer Effects

Every measurement changes the system. An **observer effect** occurs when timestamping, recording, tracing, logging, or packet capture changes the behavior being measured.

Choose a monotonic clock for elapsed time. `std::chrono::steady_clock` promises monotonic behavior but not a specific implementation or resolution. `clock_gettime` may use the vDSO or a syscall depending on clock and platform. TSC-based timing requires architecture-specific serialization, migration, frequency, and conversion handling.

Measure timer overhead and resolution with the same compiler and environment, but do not simply subtract a minimum timer cost from every sample. Timer work overlaps differently with real code and has its own distribution. Batch timing or hardware timestamps can move the boundary more honestly.

Logging in the timed region can format, allocate, lock, fault, copy, and perform I/O. Even asynchronous logging writes a queue and can contend or fill. Store compact events in preallocated per-thread buffers and export after the run, recording drops and capacity.

Tracing adds probes, buffers, stack walks, and interrupts. Sampling usually perturbs less than tracing every event, but can miss rare short paths. Packet capture can copy packets, alter offloads, consume CPU, and drop independently. Record tool configuration and run paired measurements with and without observation.

The least intrusive tool is the one that answers the current question. Start with aggregate counters, add sampling to locate code, then use targeted tracepoints for timing or causality. High-volume instrumentation on a production matching or order path requires an explicit safety and capacity review.

Calibrate by running A/B/A: baseline without the observer, instrumented run, then baseline again. If the final baseline differs, temperature or workload drift may be responsible rather than instrumentation alone. Record trace-buffer loss and logging drops; an apparently clean result from an overflowing observer is not clean evidence.

## 38.14 Comparing Implementations That Perform Equal Work

A fair comparison holds semantics and delivered work constant. Two implementations are not equivalent when one validates input and the other trusts it, one owns output and the other returns a view, or one blocks at capacity while the other drops.

Write an equivalence checklist:

- same accepted and rejected inputs;
- same output representation and ownership lifetime;
- same synchronization and snapshot guarantee;
- same allocation/capacity policy;
- same error and overload behavior;
- same compiler, target, affinity, and workload schedule.

Randomize or alternate treatment order to reduce drift from temperature and background load. Use the same pre-generated inputs, but avoid sharing mutable warmed state that advantages the second implementation. Run separate processes when symbol layout, allocator state, or global initialization could interfere.

Validate output before comparing speed. Count instructions, allocations, bytes copied, branches, atomic retries, syscalls, and queue operations to explain the difference. A faster result caused by optimized-away work, unchecked bounds, or changed durability is a different product.

Report the full evidence needed to reproduce: source revision, build command, libraries, kernel, firmware where relevant, CPU and topology, frequency policy, isolation, input seed or trace description, warmup, sample count, run duration, histogram format, counters, and known observer effects. The goal is not a number. It is a defensible claim with a bounded scope.

## 38.15 Interview Check

1. When would a microbenchmark be more informative than an end-to-end test, and what claim must it avoid?
2. Name three ways a compiler can invalidate a naive benchmark and describe how assembly inspection helps.
3. Compare hot-cache, cold-cache, and prefaulted-memory experiments. Which production states do they model?
4. Explain coordinated omission with a closed-loop generator. Which rates and latencies should an open-loop test report at overload?
5. Why can p99 values from two pipeline stages not be added to obtain end-to-end p99?
6. A change raises IPC but also raises latency. Give two plausible explanations using raw cycles and instruction counts.
7. What can minor-fault, migration, and remote-NUMA counters establish, and what additional evidence is needed for causation?
8. Design a timer-overhead experiment and explain why blindly subtracting its minimum is unsound.
9. Two parsers return the same decoded fields, but one validates lengths and owns strings while the other returns unchecked views. Is their latency comparison fair?
10. Specify the metadata required to reproduce a p99.99 latency claim.
