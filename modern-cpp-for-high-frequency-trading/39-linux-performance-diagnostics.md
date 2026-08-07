# Chapter 39 — Linux Performance Diagnostics

Linux exposes counters, samples, scheduler events, syscall traces, and programmable probes, but no tool prints “the cause” of a latency spike. Each observation has a scope, collection mechanism, and blind spot. This chapter moves from low-overhead aggregates to targeted tracing, explains what common tools can and cannot prove, and ends with diagnostic workflows that correlate application latency with faults, migration, throttling, and packet loss.

## 39.1 `perf stat` and Hardware Counters

`perf stat` reports aggregate hardware and software event counts over a command, process, thread, CPU, or cgroup scope. It is the first tool for questions such as “did the slower version execute more instructions, miss more branches, or fault more pages?”

```bash
perf stat --repeat 5 \
  -e cycles,instructions,branches,branch-misses \
  -e cache-misses,context-switches,cpu-migrations,page-faults \
  -- ./engine --replay workload.bin
```

This command's output is not shown because values depend on the target system. Record the command, event names, CPU model, kernel, and workload. Generic event names are convenience mappings; their exact hardware event can vary and some machines do not support them.

Counts need denominators. Instructions alone grow with run duration. Branch-miss percentage uses branches as a denominator; misses per message can be more actionable. IPC is instructions divided by cycles, but a higher IPC is not automatically faster. Include elapsed time and completed useful work.

Counter scope is crucial. System-wide `-a` includes unrelated tasks. `-p PID` follows a process according to perf's attachment and inheritance settings, while `-t TID` targets a thread. Per-CPU collection includes interrupts and every scheduled task on that CPU. A benchmark claim should state scope and affinity.

Processors expose a limited number of programmable counters. Asking for too many causes **multiplexing**: perf time-shares events and scales counts. Inspect each event's enabled/running percentage. Measure small event groups tied to one hypothesis; events in a group may fail to schedule simultaneously when constraints cannot be met.

Privilege is controlled by `perf_event_paranoid`, capabilities such as `CAP_PERFMON` on supporting kernels, ptrace access rules, cgroups, and distribution policy. Kernel symbol access can be restricted separately. Do not weaken host policy globally for convenience; use a controlled diagnostic environment or narrowly granted capability.

`perf stat` shows correlation, not source lines or causation. More LLC misses during a slow run supports a memory hypothesis. It does not identify the data structure, and generic cache events may not represent the LLC event expected. Use model-specific events and sampling only after consulting `perf list` and the processor documentation.

Event modifiers can restrict counting to user or kernel execution on supported events, commonly expressed with suffixes such as `:u` or `:k`. Excluding the kernel can make runs easier to compare but removes syscall, fault, interrupt, and scheduler work from the counter. State the filter and do not interpret user-only cycles as end-to-end CPU demand.

`--repeat` reports variation across invocations, but repeated child processes include startup unless the command isolates steady state internally. For a long-running service, attach for a known interval or add application markers around phases. Ensure the workload count is equal across repetitions before comparing event totals.

## 39.2 Sampling With `perf record` and `perf report`

**Sampling** records a subset of event occurrences and attributes them to instruction pointers, call chains, and other metadata. `perf record` collects samples; `perf report` aggregates them by symbol, shared object, thread, or call graph.

```bash
perf record -F 199 --call-graph fp \
  -o engine.perf.data -- ./engine --replay workload.bin
perf report -i engine.perf.data
```

The frequency is a requested target, not proof of exact periodic sampling. Perf may throttle high sample rates. Period-based sampling with `-c` answers a different question. Default software or hardware event selection varies; specify the event when the hypothesis requires one.

Call-chain quality depends on unwinding. Frame-pointer unwinding is relatively cheap and reliable when the binary and libraries retain frame pointers. DWARF unwinding can recover stacks without them but copies stack data and costs more. Last Branch Record call stacks are available on some CPUs with depth and semantic limits. Document compiler frame-pointer settings and unwind mode.

Build IDs, debug information, symbol files, JIT maps, containers, and deleted binaries affect symbolization. A large `[unknown]` fraction is a data-quality problem, not an application function. Preserve exact binaries and debug companions for offline analysis.

Samples estimate where selected events occur. A function with 30% of cycle samples is associated with roughly that share under the collection conditions; it did not necessarily take exactly 30% wall time. Interrupt skid can attribute a sample after the responsible instruction. Precise-event support reduces skid for supported events but does not remove every bias.

Rare latency outliers can vanish in an aggregate profile. Trigger or filter recording around application sequence IDs, use per-event timestamps, or collect a bounded flight recorder. Compare normal and slow intervals. Raising sample frequency until one outlier appears can perturb the very schedule being investigated.

`perf annotate` connects samples to source and disassembly when symbols and debug lines are available. Sample concentration on a load supports inspecting its address pattern, but attribution can skid and source lines can contain several instructions. Compare annotated assembly with Chapter 37's static inspection and use a precise event only when the CPU supports the needed semantics.

Data files can be large and may contain process names, paths, addresses, and stack information. Treat them as potentially sensitive production artifacts. Bound collection, preserve build IDs, compress offline, and apply the organization's retention and access policy.

## 39.3 Scheduling Analysis With `perf sched`

`perf sched` analyzes scheduler tracepoints to show when tasks run, wait, wake, migrate, and switch. It is appropriate when latency spikes align with descheduling rather than excess instructions.

```bash
sudo perf sched record -- ./engine --replay workload.bin
sudo perf sched timehist
```

Privileges and exact subcommand options vary by kernel/perf version. Check `perf sched --help` locally. `timehist` presents scheduling intervals; `latency` aggregates scheduling delay; `map` visualizes CPU/task movement. Treat any example format in documentation as schematic unless captured on the target.

Scheduling delay is the time between becoming runnable and actually running. It differs from sleep duration: a task can intentionally block for a long time, wake, then wait briefly or substantially on a run queue. Identify the wakeup source and CPU placement before blaming the scheduler.

Context-switch traces are high volume on a busy host. They consume trace buffers, CPU, and storage. Restrict duration, CPUs, cgroups, or PIDs when the tool/version supports it. Run a low-instrumentation baseline to see whether tracing shifts latency.

A migration in the trace can explain cold private caches or remote NUMA access, but migration alone does not quantify their cost. Combine scheduler chronology with hardware counters and placement. A task that never migrates can still be preempted by an interrupt or higher-priority task on the same CPU.

Wakeup causality matters. A queue consumer may wake late because the producer notified late, because it waited on the run queue, or because it ran and then faulted. Align application enqueue/notify timestamps with `sched_wakeup` and `sched_switch` events. Scheduler traces can establish the runnable interval; they cannot see an application predicate that was never instrumented.

## 39.4 Flame Graphs

A **flame graph** visualizes aggregated stack samples. Each box is a stack frame; vertical position is call depth; horizontal width is the number of samples containing the frame under the chosen event and collection. Horizontal position is aggregation layout, not time order.

The workflow is conceptually:

```text
perf samples -> stack collapse -> aggregate identical stacks -> render SVG
```

Tools from the FlameGraph project commonly use `perf script`, `stackcollapse-perf.pl`, and `flamegraph.pl`. Versions, paths, and options vary, so record the exact commands and keep the folded stacks as intermediate evidence.

A CPU-cycle flame graph answers where on-CPU cycle samples aggregate. It does not show off-CPU wait unless the collection records scheduling/off-CPU stacks and the rendering encodes them. A wide `poll` frame can mean active CPU work only under the sampled event; ordinary blocking time generates no CPU cycles.

Missing frames distort ancestry. Inlining moves work into callers; tail calls remove frames; frame-pointer omission or limited stack depth truncates chains. Debug information and inline-frame reporting improve names but do not reconstruct lost samples.

Flame graphs are excellent hypothesis generators: a newly wide parser subtree suggests inspecting its instructions or inputs. They do not show distributions or preserve individual slow requests. Pair them with latency histograms and time-correlated traces.

Differential flame graphs compare sample counts between two profiles and color growth or shrinkage. They are only meaningful when event type, duration normalization, workload, symbolization, and collection settings match. In a common default palette, a red frame indicates relative sample growth, not necessarily a regression in elapsed time.

Memory, lock, and off-CPU flame graphs require different collection sources. Label the graph by event—cycles, allocations, page faults, or blocked duration. Calling every stacked profile a “CPU flame graph” erases what width means.

## 39.5 `strace` and Syscall Behavior

`strace` reports system calls, arguments, return values, signals, and optionally durations. It proves that an observed process invoked a syscall and how the kernel API returned; it does not show all kernel work or userspace time between calls.

```bash
strace -f -tt -T -e trace=%network,read,write,futex \
  -o engine.strace ./engine --replay workload.bin
```

`-f` follows created tasks, `-tt` adds wall-clock timestamps, and `-T` reports syscall elapsed time as observed by strace. Confirm options on the installed version. Syscall duration can include sleeping, preemption, page faults, and kernel work; it is not pure instruction execution inside the syscall.

Tracing commonly uses ptrace-based stops or other instrumentation paths and can severely perturb syscall-heavy or multithreaded programs. Formatting and copying arguments add overhead, especially for buffers and strings. Use `-e` filters, bounded string lengths, summary mode (`-c`), and short windows. Never present straced request latency as the uninstrumented baseline.

`strace` is particularly useful for semantic surprises: repeated `EAGAIN`, short writes, unexpected `futex` calls, allocator mappings, missing close-on-exec, signal interruption, or synchronous logging. It cannot see lock-free contention that never enters the kernel and cannot explain why a thread was off-CPU without scheduler evidence.

Attach permissions follow ptrace security, credentials, namespaces, and Yama policy where enabled. Attaching to a production process can pause threads during setup and change timing. Prefer reproduction in a controlled environment.

Decoded arguments can expose payloads, file paths, credentials, and network addresses. Redact or restrict output and avoid tracing secrets. `-s` limits displayed strings but is not a comprehensive data-governance policy.

When a syscall appears unexpectedly, inspect its call stack with a sampling or uprobe-based technique rather than guessing from process-wide trace order. `strace` identifies the API event; symbolized call attribution requires a complementary observer and may add further perturbation.

## 39.6 `pidstat`, `vmstat`, `iostat`, `mpstat`, and `sar`

The sysstat and procps tools provide periodic aggregates at different scopes. Their strength is low-cost context over seconds or minutes; their weakness is that a sub-millisecond latency event can disappear inside an interval average.

`pidstat` reports per-process or per-thread CPU, faults, context switches, I/O, and scheduling information depending on flags. `pidstat -t -p PID 1` separates threads; exact columns and options depend on sysstat version. It can reveal one busy thread or rising faults but not the code responsible.

`vmstat` summarizes system run queues, memory, paging, block I/O, interrupts, context switches, and CPU states. Its first line commonly represents an average since boot and should not be confused with subsequent interval lines. Column units and semantics vary; read the local manual.

`iostat -xz 1` reports block-device throughput, queue, service, and utilization metrics. Device “utilization” semantics differ for parallel devices and stacked storage; 100% is not a universal saturation proof. Application I/O may be served from page cache and absent from device activity.

`mpstat -P ALL 1` exposes per-CPU use, interrupt classes, and imbalance. A hot benchmark CPU with significant softirq or steal time has less capacity for the task. Virtual-machine steal and host scheduling require hypervisor context.

`sar` records or reads historical system activity when sysstat collection is configured. It is useful for correlating a past incident with CPU, memory, network, or paging trends. Sampling interval limits temporal resolution, and retention/configuration must be established before the incident.

Synchronize timestamps and retain raw outputs. A one-second spike in `vmstat` alongside a p99.99 miss suggests a direction; it does not prove the individual request overlapped the event.

These tools often calculate rates from cumulative kernel counters. A container may see host-wide data, namespaced subsets, or restricted files depending on setup. Run collection from the same administrative scope used to interpret CPU, devices, and cgroups. “No activity” can mean “not visible.”

Interval choice trades resolution for overhead and noise. One-second sampling is useful for sustained pressure; it cannot resolve a short burst's internal ordering. Increase frequency only after checking tool support and perturbation, or move to event-driven tracepoints for a bounded interval.

## 39.7 `numastat` and NUMA Diagnosis

`numastat` reports NUMA allocation and access statistics at system or process scope. `numastat -p PID` helps determine where a process's mapped pages reside; `/proc/PID/numa_maps` provides mapping-level policy and placement detail.

```bash
numactl --hardware
numastat -p "$PID"
less "/proc/$PID/numa_maps"
```

Placement is not access. A process can own pages on node 0 while its critical thread runs on node 1, but the report does not prove which thread touches which pages. Shared-page accounting and kernel migration can complicate totals.

Correlate four facts: CPU affinity at the slow time, physical page placement, access pattern, and supported local/remote memory counters. A first-touch experiment can test causation: initialize the same prepared working set on node 0 and node 1 while pinning the consumer, then compare equal workloads.

Automatic NUMA balancing can fault, sample, and migrate pages or tasks. Its system-wide setting does not establish whether a specific page migrated. Inspect kernel counters and traces where needed. Disabling it changes host behavior and needs operational review.

NUMA diagnosis includes devices. NIC queues and DMA buffers attach to PCIe topology, and interrupts or polling threads should be considered with memory. `lspci -tv`, sysfs NUMA node files, and IRQ affinity help build the topology; exact device reporting varies.

## 39.8 `/proc/interrupts`, `/proc/softirqs`, and Process Status

`/proc/interrupts` shows interrupt counts by CPU and source. It can reveal a NIC queue or timer interrupt landing on the critical CPU. Names depend on drivers and kernel, and counters accumulated since boot need interval differences.

`/proc/softirqs` counts softirq activity such as networking and timers by CPU. A rising `NET_RX` count indicates receive softirq executions, not packets, bytes, or time spent. `/proc/net/softnet_stat` provides additional per-CPU networking backlog/drop fields whose layout is kernel-version specific.

`/proc/PID/status` exposes human-readable process state including memory, context-switch counts, allowed CPU/memory-node masks, thread count, and capabilities. `VmRSS` is not live-object size, and status counters may be approximate. `/proc/PID/smaps_rollup` is more detailed but more expensive to collect.

Useful checks include:

```bash
grep -E 'State|VmRSS|VmHWM|VmLck|Threads|voluntary|nonvoluntary|Cpus_allowed|Mems_allowed' \
  "/proc/$PID/status"
cat /proc/interrupts
cat /proc/softirqs
```

Reading proc files is not free. The kernel formats data and may walk process structures; frequent collection can perturb the target. Sample at a justified interval and compute deltas with counter wrap and CPU hotplug in mind.

An interrupt count on the same CPU as a spike is correlation. To establish timing, use tracepoints for interrupt entry/exit and scheduler events in a bounded window, then reproduce with corrected IRQ affinity if safe.

Interrupt totals can be misleading under polling or interrupt moderation. A NIC may process many packets per interrupt, and busy polling can reduce interrupts while increasing CPU consumption. Pair counts with packet rate, NAPI/softirq evidence, and driver queue statistics.

Process status includes voluntary and nonvoluntary context-switch totals, but a thread-level incident needs `/proc/TID/status` or another per-thread source. Differences between samples provide counts, not switch timestamps or duration. Use scheduler tracing only after the aggregate identifies a suspicious interval.

## 39.9 Ftrace and Tracepoints

**Ftrace** is Linux's in-kernel tracing infrastructure. Tracepoints are relatively stable, typed instrumentation sites for events such as scheduling, IRQs, faults, syscalls, and networking. Function tracers instrument broader function execution with higher volume and version sensitivity.

Tracefs is commonly mounted at `/sys/kernel/tracing` or available through debugfs on older setups. Access requires privileges set by the system. Never assume production trace policy permits arbitrary function tracing.

A targeted trace enables only required events, filters by PID/CPU or event fields where supported, sizes buffers, clears old data, records a short interval, then disables tracing. `trace_pipe` streams consuming reads; `trace` provides a snapshot. Exact event names and fields come from the running kernel:

```bash
find /sys/kernel/tracing/events -maxdepth 3 -name format | head
cat /sys/kernel/tracing/events/sched/sched_switch/format
```

These discovery commands do not enable tracing. Enabling events changes shared kernel state and should be performed only with authorization.

The `function` and `function_graph` tracers can expose call paths and durations but generate substantial data and alter function execution. Filters are essential. Compiler inlining, notrace functions, interrupt context, and clock choice affect interpretation.

Ring buffers are finite. An overrun means events were lost, invalidating claims about absence or exact sequence. Record overrun statistics, trace clock, buffer size, enabled events, filters, CPUs, and collection duration. A trace can prove an observed order among captured timestamped events within clock limits; it cannot prove an event never occurred when buffers overflowed or probes were absent.

Ftrace supports snapshots and triggers on some events, allowing a rolling buffer to freeze near a rare condition instead of streaming indefinitely. Configuration is kernel-version specific. Test the trigger in a staging workload, confirm that it fires once as intended, and restore prior tracing state after collection.

Trace clocks trade properties. A local per-CPU clock may be cheap but hard to compare across CPUs; a global clock can cost more. Read the active and available clocks from tracefs and select according to whether cross-CPU ordering is required. Retain clock choice with the trace.

## 39.10 eBPF-Based Observation

eBPF runs verified programs at kernel or userspace attachment points and exports aggregated or event data through maps, ring buffers, or perf buffers. It enables targeted questions without rebuilding the kernel or application.

Attachment choices include tracepoints, kprobes/kretprobes, uprobes/uretprobes, perf events, networking hooks, and Linux Security Module hooks. Tracepoints offer a more stable field contract than probing internal kernel functions. Kprobe symbols and arguments change with kernel versions; uprobes depend on exact binaries, addresses, inlining, and symbolization.

A diagnostic can aggregate in kernel rather than emit every event. For example, keying a histogram by PID and syscall duration exports a bounded summary, while streaming every entry/exit adds far more overhead and can drop records. Map capacity, per-CPU versus shared updates, stack collection, and user-space polling all affect memory and latency.

The verifier checks safety and bounded behavior under kernel rules, not whether the diagnostic logic answers the intended question. A probe can attach to the wrong function, filter the wrong namespace PID, or calculate a biased histogram while being verifier-safe.

Privileges depend on kernel version and policy: root, `CAP_BPF`, `CAP_PERFMON`, `CAP_SYS_ADMIN`, unprivileged-BPF settings, lockdown, and LSMs may apply. BTF and CO-RE improve portability but do not make every field stable. Record tool, program source, object build, kernel/BTF identity, attachments, and lost-event counts.

Tools such as bpftrace and BCC accelerate exploration; libbpf supports production-quality compiled probes. Begin with tracepoints and in-kernel aggregation. Compare baseline latency before and after attachment, especially for high-frequency probes on syscall, scheduler, or packet paths.

eBPF can establish that captured events met a programmed predicate at attachment points. It cannot observe code with no probe and does not automatically connect kernel events to an application request. Include sequence IDs or carefully aligned timestamps when making that correlation.

Probe cost depends on event rate and program work. A tiny tracepoint program executed on every packet can consume more total CPU than a richer program on a rare fault. Estimate event frequency, bound map entries, avoid unbounded cardinality from user-controlled keys, and expose ring-buffer loss. Per-CPU maps reduce contention but require a merge step and more memory.

Uprobes can replace instructions with traps or use architecture-specific mechanisms, making a very hot userspace function expensive to probe. Prefer application-native static tracepoints or sampling when available. Always compare with an unattached baseline.

## 39.11 Diagnosing Faults, Migrations, Throttling, and Socket Drops

Diagnosis is a narrowing process: begin with an application-visible symptom and timeline, select low-overhead evidence, form a hypothesis, then reproduce or remove the suspected cause.

For page faults:

1. Confirm minor/major fault deltas with `perf stat`, `pidstat`, or process counters.
2. Determine the responsible thread and time with targeted tracing.
3. Identify the mapping through fault address evidence, maps, allocation logs, or a controlled reproduction.
4. Correct preparation or allocation policy and verify zero steady-state faults.

For migrations and descheduling, check effective affinity, per-thread migration/context-switch counts, and `perf sched` chronology. Inspect IRQ and softirq activity on the CPU. Pinning the thread is a test only if it matches deployment; it does not remove interrupts or SMT contention.

CPU throttling has several sources. Cgroup v2 `cpu.stat` exposes quota throttling counts and duration; pressure stall information exposes contention time; thermal and frequency tools expose hardware limits where supported. A high `%CPU` process can still be throttled periodically. Inspect container and host scopes.

Socket drops can occur at NIC rings, driver processing, softnet backlog, protocol queues, socket receive buffers, packet capture, or the application. Use a layer-by-layer set:

- `ethtool -S INTERFACE` for driver/NIC counters, with driver-specific names;
- `/proc/net/softnet_stat` and `nstat` for host networking counters;
- `ss -m -i -u -t` for socket memory and protocol information;
- application sequence gaps and receive-overflow ancillary counters;
- targeted drop tracepoints or tools where the kernel supports them.

A counter increase proves loss at or before the counter's accounting point according to that implementation. A zero counter does not prove no loss at an uninstrumented layer. Packet capture itself can drop and can alter offloads; capture loss must be reported separately.

Map counters to ownership before changing capacity. Raising a socket receive buffer cannot repair NIC-ring loss; raising a NIC ring may increase buffering and latency; raising every queue can hide overload until a larger burst. Change the layer that dropped, retain explicit bounds, and rerun the same offered schedule.

For receive-buffer diagnosis, enable Linux overflow ancillary reporting where the socket API and protocol support it and compare its cumulative drop count with application sequence gaps. A gap with no local overflow can originate upstream, in another local layer, or in application validation. Redundant feed comparison can narrow the domain but has its own path correlation.

Build one incident timeline in a common monotonic domain where possible:

```text
request spike | task off-CPU | NET_RX softirq | socket overflow | sequence gap
```

This format is schematic, not tool output. Preserve raw evidence and clock uncertainty. Then change one variable—prefault memory, fix affinity, raise a bounded socket buffer, or remove quota—and repeat the same workload. A diagnosis becomes convincing when the predicted symptom changes without changing semantics elsewhere.

Stop escalating instrumentation once the question is answered. Leaving broad ftrace or high-rate eBPF probes enabled consumes buffers and capacity and expands operational risk. Diagnostics are code and configuration: review, version, bound, and remove them deliberately.

## 39.12 Interview Check

1. A `perf stat` run reports more IPC and longer elapsed time. Which raw counts and workload denominator would you inspect?
2. Compare frequency-based and event-period sampling. How can counter multiplexing and sample skid affect interpretation?
3. What does `perf sched` reveal that a context-switch count cannot?
4. Why does a CPU flame graph not display ordinary blocked time, and how would an off-CPU investigation differ?
5. Give three semantic bugs `strace` can reveal and explain why its measured syscall durations are perturbative.
6. Match `pidstat`, `vmstat`, `iostat`, `mpstat`, and `sar` to the scopes they summarize. Why can none alone explain a single microburst?
7. A critical thread runs on node 1 while most pages reside on node 0. What evidence would turn this into a remote-NUMA diagnosis?
8. Design a bounded ftrace collection for a suspected interrupt preemption. Which loss and clock metadata must be retained?
9. Compare an eBPF tracepoint program with a kprobe for portability, overhead, and what each can observe.
10. Construct a layer-by-layer investigation for a market-data sequence gap when all application buffers claim spare capacity.
