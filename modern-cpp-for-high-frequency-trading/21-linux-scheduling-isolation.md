# Chapter 21 — Linux Scheduling and Isolation

Low latency depends on when a thread runs, not merely how quickly its instructions execute once scheduled. Linux scheduling policy, CPU placement, interrupts, simultaneous multithreading, power management, cgroups, and resource exhaustion all shape that interval. “Pin the thread and make it real-time” is not a complete design: it can starve kernel housekeeping, invert priorities, or move interference to an SMT sibling. This chapter develops a measurable scheduling model and treats isolation as an operational system configuration with explicit risks.

## 21.1 Runnable, Sleeping, Stopped, and Zombie States

A Linux task is **runnable** when it is running on a CPU or eligible on a runqueue. It is **sleeping** when it waits for an event or timeout and is not eligible to execute. A stopped task is suspended by job control or tracing. A zombie has terminated and awaits reaping; it cannot be scheduled.

Linux kernel state encoding is more detailed than user tools display. `TASK_RUNNING` covers both executing and runqueue-eligible tasks. Interruptible sleep can wake for signals; uninterruptible sleep is used for waits whose kernel path does not accept ordinary signal interruption. Tool output commonly shows `R`, `S`, `D`, `T`, and `Z`, but exact letters and composite states belong to the tool and kernel version.

```sh
ps -eLo pid,tid,psr,stat,ni,rtprio,cls,wchan:24,comm
```

`wchan` can suggest where a sleeping task waits, subject to permissions, symbols, and races. It is not a stable API.

A blocked market-data thread consumes no CPU while sleeping, but wakeup traverses a kernel path: an event makes it runnable, the scheduler selects a CPU, it may preempt another task, and its caches may be cold. A busy-polling thread avoids sleep/wakeup latency at the cost of an entire logical CPU, power, thermal headroom, and interference. Neither path has a universal latency.

Uninterruptible `D` state is often described as “I/O wait,” but the kernel uses it for selected waits that must not be interrupted, not exclusively storage. Such tasks can contribute to load-average accounting even though they are not consuming a CPU. Diagnose the actual wait channel and subsystem instead of inferring disk trouble from one state letter.

A zombie is not sleeping. It has finished execution and will never wake; scheduling changes cannot repair it. A large zombie count points to the parent lifecycle protocol in Section 20.12, while a large runnable count points to CPU competition. State classification should narrow the investigation before any tuning.

State samples can miss short sleeps. Use scheduler tracepoints or `perf sched` to observe transitions in a controlled run. Separate runqueue delay—the time runnable but not executing—from blocked time waiting for the application event. Optimizing one does not reduce the other.

## 21.2 CFS Concepts

The Linux fair scheduling class shares CPU time among ordinary runnable tasks according to weights. Historically, the **Completely Fair Scheduler** (CFS) modeled an ideal processor and tracked each entity's weighted virtual runtime. Tasks with less virtual service were favored.

Nice values map to weights rather than fixed time slices. If two CPU-bound tasks of equal weight share one CPU, fairness aims to divide service approximately equally over time. A heavier task's virtual runtime advances more slowly for the same physical execution, entitling it to a larger share.

Linux began transitioning fair-class selection from classic CFS toward **EEVDF**—Earliest Eligible Virtual Deadline First—in kernel 6.6. Current kernels retain virtual-time and fairness ideas but may choose eligible tasks using lag and virtual deadlines rather than simply selecting the smallest virtual runtime. Kernel versions continue to evolve. Teach `vruntime`, weight, wakeup placement, and per-CPU runqueues as concepts; inspect the deployed kernel before naming a precise picker or tunable.

Fair does not mean low-tail-latency. A task can wait behind other eligible work, interrupts, higher scheduling classes, or throttling. Waking tasks can cause preemption, and load balancing can migrate work. Per-CPU runqueues improve scalability but require placement and balancing decisions.

Fair scheduling is hierarchical when task groups or cgroups participate. CPU time can first be divided among groups and then among tasks inside a group. A heavily weighted thread can still receive little host CPU if its parent cgroup has a small share or exhausted quota. Inspect the entire hierarchy.

Sleep/wakeup patterns matter. An event-driven thread may sleep most of the time and demand immediate service for short bursts. Virtual-time placement and EEVDF latency requests can improve responsiveness within the fair class, but they do not reserve execution at a deadline. A simultaneous IRQ storm or higher-class task still wins.

The scheduler also tracks utilization signals for load balancing and frequency selection. PELT-style averages, utilization clamps, heterogeneous CPU capacity, and the cpufreq governor may interact. These are Linux mechanisms, not POSIX contracts.

```sh
uname -r
chrt -p 1234
grep -E 'se\.vruntime|nr_switches' /proc/1234/sched
```

`/proc/PID/sched` is diagnostic and kernel-version-dependent. For latency analysis, measure wakeup-to-run distributions and competing runnable tasks. A process receiving its fair CPU share can still miss every microburst deadline.

## 21.3 FIFO, Round-Robin, and Deadline Scheduling

Linux exposes multiple scheduling classes. POSIX real-time policies `SCHED_FIFO` and `SCHED_RR` use fixed priorities above ordinary fair-class tasks. Linux `SCHED_DEADLINE` uses runtime, deadline, and period parameters with admission control and bandwidth enforcement.

A runnable `SCHED_FIFO` task continues until it blocks, yields, is preempted by a higher-priority task, or changes policy. It has no round-robin quantum among equal-priority peers. `SCHED_RR` adds a time quantum so equal-priority runnable tasks rotate. Higher numeric real-time priority wins on Linux; the POSIX range must be queried with `sched_get_priority_min` and `sched_get_priority_max` rather than assumed.

`SCHED_DEADLINE` uses an earliest-deadline-first design with constant-bandwidth-server behavior. A task requests a runtime budget to be supplied within each period and relative deadline. The kernel can reject an infeasible admission. Exhausting runtime throttles the task until replenishment, so incorrect parameters create deterministic stalls rather than extra capacity.

```sh
chrt -p 1234
chrt -r -p 50 1234   # MUTATING: example only; requires suitable privilege
```

Do not run the second command casually. A runaway real-time task can starve ordinary tasks, including logging, remote administration, and work needed for recovery. Linux provides real-time bandwidth controls and watchdog mechanisms depending on configuration, but those are safety nets, not an application proof.

Real-time policy does not reserve caches, memory bandwidth, interrupt service, or an SMT sibling. Page faults and blocking I/O still block. Locks can cause inversion. `SCHED_DEADLINE` admission does not prove application end-to-end deadlines when the path includes unaccounted devices and threads.

Scheduler-class ordering is more important than numeric priority fields printed by tools. Stop, deadline, real-time, fair, and idle classes have kernel-defined precedence relationships in that broad order, while configuration and throttling can alter when tasks are eligible. Numeric RT priority only orders real-time peers; it does not compare directly with a nice value or deadline parameter.

Reserve CPU time for housekeeping and failure recovery. If every CPU has a continuously runnable FIFO thread, a shell or watchdog may never execute. A bounded FIFO loop should periodically block on real work rather than call `yield` as a substitute for capacity planning. Deadline runtime must include the thread's worst supported CPU demand or specify what is dropped when budget is exhausted.

Use a lab host with an out-of-band recovery path. Record policy, priority, CPU mask, budget, kernel configuration, and cgroup constraints. Test overload and runaway behavior before treating elevated policy as production-ready.

## 21.4 Nice Levels and Real-Time Priorities

A **nice value** changes the weight of ordinary fair-scheduled work. Linux exposes a conventional range from -20, higher weight, to 19, lower weight. It does not create a real-time priority and does not outrank runnable `SCHED_FIFO`, `SCHED_RR`, or deadline tasks.

Ordinary policies use static scheduler priority zero in POSIX interfaces; the nice value affects fair-class weight. Real-time policies use a separate priority range. Mixing them in one number leads to incorrect comparisons.

```sh
ps -eLo pid,tid,ni,pri,rtprio,cls,comm
renice -n 5 -p 1234        # MUTATING: example only
chrt -f -p 60 1234         # MUTATING: example only
```

Displayed `PRI` fields are tool-specific transformed values. Use `chrt`, `sched_getscheduler`, and `sched_getparam` for policy-level inspection.

Raising ordinary weight or real-time priority requires appropriate privilege or limits. `CAP_SYS_NICE`, `RLIMIT_NICE`, and `RLIMIT_RTPRIO` participate, while containers, user namespaces, service-manager policy, seccomp, and cgroups can further restrict the operation.

Priority is relative to competitors. Increasing one feed thread can delay its book builder, network softirq work, or recovery service. Establish a whole-system priority graph. Reserve higher real-time priorities for short, bounded work that does not wait on lower-priority owners.

Nice weights are multiplicative in Linux's design rather than linear “priority points.” A one-step change does not reserve a fixed percentage, and the result depends on all runnable weights in the scheduling group. Cgroup CPU weights introduce another layer. Capacity planning should use runnable-set scenarios, not a statement such as “nice -10 gets twice as much CPU” without version-specific calculation.

Verify with forced contention rather than an idle-machine benchmark. Observe per-thread policy and runqueue delay, and include failure tests where priority changes are denied. Silently continuing at the default policy can invalidate the latency model.

## 21.5 CPU Affinity and Migration

**CPU affinity** restricts the CPUs on which a task may execute. Linux `sched_setaffinity` operates on a task identified by PID/TID semantics, and `pthread_setaffinity_np` applies to a POSIX thread through an NPTL interface.

```cpp
#include <pthread.h>
#include <sched.h>
#include <system_error>

void pin_current_thread(unsigned cpu) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    const int error = ::pthread_setaffinity_np(
        ::pthread_self(), sizeof(set), &set);
    if (error != 0) throw std::system_error(error, std::generic_category());
}
```

Pthread functions return an error number directly; they do not necessarily set `errno`. `cpu_set_t` has a compile-time capacity; dynamically sized CPU-set macros are needed for very large CPU identifiers.

The effective mask is the intersection of the requested mask, online CPUs, cpuset cgroup constraints, and other system restrictions. Linux may silently intersect masks in some interfaces. Read the mask back and fail startup if the contract is not met.

CPU hotplug and cgroup reconfiguration can change the effective mask after startup. A thread may be moved when its CPU goes offline. Production monitoring should compare desired and effective placement continuously enough to detect drift without scraping the hot CPU excessively.

Migration moves execution to another logical CPU. Register state must be scheduled there, and private caches may not contain the working set. TLB entries, NUMA locality, and shared last-level cache topology affect cost. Modern address-space identifiers can reduce some TLB flushes, but migration is not free.

Pinning reduces migration variance but can create overload if multiple tasks share one CPU or if a pinned task blocks work that would otherwise migrate. It also prevents the scheduler from avoiding thermal or heterogeneous-core constraints. Pin threads according to data ownership, NIC queues, NUMA memory, and SMT topology—not consecutive CPU numbers.

Verify with `taskset -pc PID`, `ps -L -o tid,psr`, `/proc/PID/task/TID/status`, `perf stat` migration counters, and scheduler traces. A sampled `psr` proves only where the task last ran.

Pinning by process ID can affect only one task when the operator intended all threads. Iterate `/proc/PID/task` carefully or configure affinity as each worker starts. Thread creation inherits an affinity mask on Linux, so pinning the parent before creation can be useful or can accidentally constrain every child to one CPU. Document which mechanism owns placement; competing application and service-manager settings otherwise overwrite each other.

## 21.6 CPU Isolation, Cpusets, and Interrupt Affinity

**CPU isolation** moves selected scheduler and kernel work away from designated CPUs. Affinity pins one task; isolation requires a system-wide housekeeping design.

Linux offers several mechanisms:

- cgroup v2 cpuset partitions can remove CPUs from load-balancing domains at runtime;
- `isolcpus=domain` is a boot-time, less flexible scheduler-domain mechanism;
- `nohz_full` can suppress the periodic scheduling tick when constraints permit;
- `rcu_nocbs` offloads selected RCU callback work;
- `/proc/irq/IRQ/smp_affinity*` controls many interrupt targets;
- managed interrupts have driver/kernel-controlled affinity constraints.

Current kernel documentation recommends cgroup v2 isolated cpuset partitions over the irreversible `isolcpus=domain` approach where feasible. Exact files and partition semantics depend on kernel configuration and cgroup version.

Isolation is not silence. Local timer events, exceptions, explicitly targeted interrupts, per-CPU kernel work, TLB shootdowns, machine-check activity, firmware system-management interrupts, and syscalls can still interrupt execution. Full dynticks has constraints and shifts bookkeeping onto kernel entry/exit and housekeeping CPUs.

```sh
cat /sys/devices/system/cpu/isolated
cat /sys/devices/system/cpu/nohz_full
cat /proc/cmdline
cat /proc/interrupts
find /sys/fs/cgroup -maxdepth 2 -name cpuset.cpus.effective -print
```

These are read-only inspection commands. Changing masks can disconnect storage or network interrupt processing from intended NUMA nodes, starve housekeeping, or make a host unmanageable. Keep at least one adequately provisioned housekeeping CPU per relevant topology, route critical NIC queues deliberately, and test failure recovery.

Isolation planning follows the work sources:

| Work source | Placement control or evidence |
|---|---|
| application threads | affinity and cpuset effective mask |
| scheduler balancing | isolated cpuset partition or scheduler domains |
| device interrupts | IRQ affinity and managed-IRQ behavior |
| unbound workqueues | housekeeping masks and workqueue configuration |
| RCU callbacks | callback offload and housekeeping threads |
| periodic tick | full-dynticks eligibility and trace evidence |
| firmware activity | platform tooling; often not kernel-controllable |

Moving noise away increases load elsewhere. Housekeeping CPUs must process RCU callbacks, timers, workqueues, interrupts, monitoring, and control services with enough capacity for bursts. If they saturate, work can backlog and later disturb the isolated path or prevent recovery.

Validate isolation with long scheduler and IRQ traces under representative background load. An idle ten-second test does not exercise RCU grace periods, logging bursts, link events, page reclaim, or service-manager work.

## 21.7 Voluntary and Involuntary Context Switches

A **voluntary context switch** occurs when a task blocks or explicitly yields. An **involuntary context switch** occurs when the scheduler preempts a runnable task, for example because its service interval ends or a higher-priority task becomes runnable.

Switching saves and restores architectural state, changes current-task kernel state, updates accounting, and may switch address-space context. Lazy or eager handling of extended vector state, PCID/ASID support, mitigation settings, and architecture affect the instruction path.

The larger cost is often indirect. The incoming task may miss in private caches, branch predictors may need retraining, and shared caches may contain a competitor's data. Migration adds remote-cache and NUMA effects. A same-process thread switch can retain the address space but still disrupt the working set.

On supported x86 systems, PCID can tag TLB entries by address space; ARM has analogous ASID concepts. Security mitigations and generation reuse influence what can be retained. This can make a same-process switch cheaper than an unrelated-process switch in one dimension, but private cache and predictor interference remain. Treat counter evidence as target-specific.

The switch-out point matters. Preemption inside a long dependency chain can leave the pipeline and cache in a different state from blocking after a completed batch. Application batching can reduce synchronization frequency but lengthen the time before another task is allowed to run. Throughput and response time pull in different directions.

```sh
pidstat -w -t -p 1234 1
perf stat -e context-switches,cpu-migrations -p 1234 -- sleep 10
perf sched record -- ./workload
perf sched timehist
```

Commands require suitable permissions and tool support. `perf sched record` captures substantial trace data and perturbs the workload.

Context-switch counts alone are not a latency diagnosis. One switch while blocked for milliseconds and hundreds of harmless off-path switches tell different stories. Correlate switch-out reason, runnable delay, CPU, migration, and application timestamps.

Avoid `sched_yield` as a generic backoff. Its placement effect depends on policy and competing tasks, and repeated yielding can create scheduler traffic. Choose bounded spinning, blocking, or event-driven waiting from an explicit contention model.

## 21.8 SMT Sibling Interference

**Simultaneous multithreading** (SMT) exposes multiple logical CPUs on one physical core. Siblings share substantial execution resources, commonly including front-end bandwidth, execution ports, private-cache capacity, and memory pipelines. Exact sharing is microarchitecture-specific.

Two threads pinned to different logical CPUs can therefore interfere strongly if they are siblings. A compute-heavy strategy can reduce the packet parser's issue bandwidth; a cache-intensive logger can evict its data. Logical CPU numbering does not reliably reveal topology.

```sh
lscpu -e=CPU,CORE,SOCKET,NODE,ONLINE
for c in /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; do
    printf '%s: ' "$c"; cat "$c"
done
```

The loop is diagnostic. On large hosts, summarize its output offline.

Leaving a sibling idle can improve predictability but reduces schedulable capacity and may change turbo behavior. Assigning complementary workloads can work, but “complementary” must be measured on the target microarchitecture with representative code. Hardware performance counters for cycles, instructions, cache events, and stalled resources can reveal contention, subject to counter availability.

A placement experiment needs at least three cases: sibling logical CPUs on one core, separate cores sharing a last-level cache, and separate NUMA nodes where available. Keep affinity and memory placement fixed, run the interferer at realistic intensity, and compare full latency distributions. This separates SMT execution-resource contention from LLC and memory-controller contention.

SMT also affects security because sibling threads can share microarchitectural state. Kernel mitigations and organizational policy may disable SMT, change core scheduling, or restrict co-tenancy. A low-latency placement plan must conform to that security model.

## 21.9 Frequency Scaling, Turbo, C-States, and Throttling

CPU execution rate and wakeup latency vary with power and thermal state. **Frequency scaling** changes requested performance levels; **turbo** opportunistically raises frequency within electrical and thermal limits; **C-states** reduce idle power with increasing wake cost; **throttling** reduces performance when constraints are exceeded.

Linux cpufreq policy, drivers such as `intel_pstate` or `amd_pstate`, governors, utilization signals, firmware, and hardware control loops all participate. Names and behavior depend on platform and kernel. The frequency reported by one sysfs file may be a request, an average, or a recent sample rather than instantaneous core frequency.

A thread that wakes after a quiet period can pay both C-state exit and frequency ramp behavior. Keeping a CPU busy can reduce those transitions but consumes power, raises temperature, reduces package turbo headroom, and may cause later throttling. This trades one source of variance for another.

Package-wide limits couple cores. A busy logger on another core can reduce turbo headroom for the strategy. AVX-heavy code can alter frequency behavior on some x86 generations. Fans, inlet temperature, and power-delivery limits affect sustained clocks. A result from an open test chassis may not reproduce in a dense rack.

```sh
cpupower frequency-info
turbostat --interval 1
grep . /sys/devices/system/cpu/cpufreq/policy*/scaling_{driver,governor} 2>/dev/null
```

Tool availability and permissions vary. `turbostat` itself wakes periodically and adds observation load.

On x86, invariant TSC supports stable elapsed-time measurement on suitable systems but does not imply instructions execute at TSC frequency. APERF/MPERF-style counters can estimate delivered frequency. On ARM systems, counter and DVFS behavior is platform-specific.

Control changes are privileged and operationally risky. Validate sustained performance under realistic thermal load, not a short cold benchmark. Record ambient conditions, power limits, sibling load, governor, firmware, and throttling counters with latency distributions.

Do not compare latency runs using a clock that changes rate with core frequency. `CLOCK_MONOTONIC_RAW`, invariant architectural counters where properly synchronized, and hardware timestamping have distinct contracts discussed in Chapter 33. Delivered instruction rate still varies even when the measurement clock is stable.

## 21.10 Priority Inversion and Inheritance

**Priority inversion** occurs when a high-priority task waits for a resource held by a lower-priority task, while medium-priority work prevents the owner from running and releasing it.

```text
low:    [lock L]----preempted----------------[unlock]
medium:          [runs runs runs runs]
high:               [blocks on L............]
```

The effective delay of the high-priority task is now governed by medium work, despite its priority.

Priority inheritance temporarily boosts the lock owner toward the waiting task's priority. POSIX mutex protocol `PTHREAD_PRIO_INHERIT` requests this behavior; Linux implements PI mutex paths using priority-aware futex support. Availability and privilege/policy interactions must be checked.

Priority protection/ceiling is another POSIX protocol in which acquiring a mutex raises execution to a configured ceiling. It requires a correct static ceiling and is less commonly used in general applications.

Inheritance does not make a long critical section short. It does not cover arbitrary lock-free dependencies, bounded queues, condition protocols, memory allocation locks, or devices unless their mechanisms participate. Nested locks require a consistent ordering and can propagate boosts.

PI changes scheduler state and can invoke kernel futex paths, adding bookkeeping to contention. That cost is justified when priority inversion is part of the threat model; it is not a free attribute to enable blindly. Mutex type, protocol, process-sharing, robustness, and priority ceiling combinations have support constraints that must be tested on the target libc and kernel.

The cleanest low-latency design often avoids a cross-priority lock: confine mutable state to one thread and send bounded messages, or ensure every waiter and owner belongs to one priority band. Queues can still invert progress when a high-priority consumer depends on a low-priority producer, so draw the dependency graph rather than counting mutexes.

Ordinary non-PI pthread mutexes may be correct for fair-scheduled threads where priorities are equal. Introducing one real-time thread changes the analysis for every resource it can wait on. Inventory allocator, logging, loader, filesystem, and library locks—not only application mutexes.

Test inversion by deliberately suspending a low-priority owner while medium work runs. Observe scheduler priorities and wakeup latency with tracepoints. Never inject this test on a production trading host.

## 21.11 POSIX Threads, NPTL, Stacks, and TLS

POSIX threads share a process address space and resources while retaining separate execution state. On Linux, glibc's **Native POSIX Thread Library** (NPTL) implements a one-to-one model using Linux tasks and clone mechanisms.

`pthread_create` allocates or arranges a user stack, guard region, thread descriptor, TLS, and kernel task. It can call the allocator and kernel and can fault pages when the new stack is first touched. Thread creation is control-path work, not suitable for a per-message operation.

A pthread identifier is opaque and valid under pthread API lifetime rules; it is not necessarily the numeric Linux TID. Joinable threads retain termination resources until joined. Detached threads release them automatically but provide no join point for proving shutdown completion. Long-lived systems should make join/detach ownership explicit.

Default stack size is implementation and configuration dependent; on NPTL it is influenced by the process's startup `RLIMIT_STACK` and architecture defaults. Reserved virtual space is not the same as resident memory. A guard region detects some overflow but cannot make unbounded recursion safe.

```cpp
pthread_attr_t attr;
::pthread_attr_init(&attr);
::pthread_attr_setstacksize(&attr, 512 * 1024);
// pass attr to pthread_create; check every returned error number
::pthread_attr_destroy(&attr);
```

The requested size must meet `PTHREAD_STACK_MIN` and alignment/implementation constraints. Too-small stacks fail under deep call paths, signals, sanitizers, or large automatic objects.

TLS provides one instance per thread, as Section 3.5 explains. Non-trivial `thread_local` objects may initialize on first use and destruct at thread exit. Large TLS multiplies memory across worker count.

NPTL exposes each thread under `/proc/PID/task/TID`. `pthread_setname_np`, affinity APIs, scheduler APIs, and per-thread counters support observability. Linux thread names are length-limited, so use stable compact names and log the TID separately.

Create long-lived workers during startup, establish mask, affinity, stack, TLS, and memory placement on the worker itself, then signal readiness. This converts lazy first-use work into a testable startup phase.

Stack prefaulting must touch pages on the worker without crossing the guard and without assuming downward growth as a C++ contract. A controlled recursive or iterative touch routine is platform-specific. Measure minor faults during readiness and verify that signal alternate stacks and rarely used error frames are included in the operational policy.

## 21.12 Futex-Based Pthread Synchronization

A **futex** is a Linux facility for waiting on and waking around a user-space integer under a defined protocol. The kernel does not make arbitrary memory atomic; user-space atomics and state transitions provide the fast path, while futex operations park and wake waiters.

An uncontended pthread mutex in glibc commonly uses atomic user-space operations without a syscall. Under contention, its implementation may spin briefly and then invoke `futex` to sleep. POSIX specifies mutex behavior, not that implementation, spin policy, word layout, or fairness.

Conceptually:

```text
lock:
  atomic attempt succeeds -> enter
  atomic attempt fails    -> mark/observe contention -> futex wait

unlock:
  atomic release
  if waiters may exist -> futex wake
```

`FUTEX_WAIT` checks that the word still has an expected value before sleeping, closing the lost-wakeup window when the user protocol is correct. Wakeups can be spurious or race with other waiters, so code always rechecks its predicate.

Contention cost includes cache-line ownership transfer before any syscall, futex-key lookup, queueing, scheduler transitions, wakeup placement, and cold caches. A hash collision in kernel futex structures or signal interruption can add variance depending on operation and kernel.

Timeouts add clock selection and race semantics. A timeout expiring does not prove no concurrent unlock occurred; the predicate remains authoritative. Relative timeouts can accumulate drift when loops restart. Prefer an absolute deadline with the primitive's documented clock where the API allows it.

`FUTEX_PRIVATE_FLAG` lets the kernel optimize futexes known not to cross processes. Pthread process-private mutexes can use such behavior internally. Incorrectly marking shared memory private can strand waiters because the kernel derives a different futex key.

Do not build a futex protocol by copying a simplified diagram. Memory ordering, state encoding, timeout clocks, private/shared flags, teardown, and ABA-like reuse must all be correct. Use pthread primitives or C++ synchronization unless a demonstrated requirement justifies a Linux-specific design.

Verify fast and contended paths separately with `strace -e futex`, `perf` scheduler events, and contention benchmarks. `strace` should show no steady futex syscalls for a genuinely uncontended implementation, but tracing changes timing and cannot prove a standard guarantee.

## 21.13 Robust and Process-Shared Mutexes

A **robust mutex** reports that its previous owner terminated while holding it. On successful acquisition after owner death, pthread APIs return `EOWNERDEAD`; the new owner holds the mutex but must repair protected state and call `pthread_mutex_consistent`. Unlocking without consistency can make the mutex permanently unusable with `ENOTRECOVERABLE`.

Robustness repairs lock ownership, not application data. A process can die halfway through updating an order-book snapshot, leaving fields mutually inconsistent. The recovery procedure needs a journal, version, checksum, redundant snapshot, or rebuild path. If repair cannot be proved, discard and reconstruct the shared state.

A robust recovery state machine is explicit:

```text
lock -> ordinary success -> use state -> unlock
     -> EOWNERDEAD -> validate/repair
          -> repaired -> pthread_mutex_consistent -> unlock
          -> impossible -> unlock without consistent -> not recoverable
```

If validation reads untrusted lengths or indexes left mid-update, it must remain bounds-safe. Recovery code runs rarely and deserves fuzzing and fault injection because production observation will be sparse.

A **process-shared mutex** is configured with `PTHREAD_PROCESS_SHARED` and placed in memory shared by participating processes. Merely copying a default mutex through `fork` does not establish a general interprocess mutex contract. Initialization must occur once with versioning and crash coordination.

```cpp
pthread_mutexattr_t attr;
::pthread_mutexattr_init(&attr);
::pthread_mutexattr_setpshared(&attr, PTHREAD_PROCESS_SHARED);
::pthread_mutexattr_setrobust(&attr, PTHREAD_MUTEX_ROBUST);
// initialize mutex in a shared mapping, with an external one-time protocol
::pthread_mutexattr_destroy(&attr);
```

Check all return values and platform support. The sample omits the shared-memory lifecycle deliberately.

Process-shared contention still transfers cache-line ownership across cores and can cross NUMA nodes. Parking enters the kernel. Owner death adds a rare but complex recovery tail. Align lock state away from frequently modified data and benchmark crash recovery, not just uncontended acquisition.

Destroy a mutex only when no process can access or wait on it. Unmapping shared storage while peers retain pointers is a lifetime failure no robust attribute can fix.

## 21.14 Cancellation and Cleanup Hazards

POSIX thread cancellation is a request whose effect depends on cancellation state and type. **Deferred cancellation** acts at cancellation points; **asynchronous cancellation** may act at almost any instruction and is unsafe for most C++ code.

A canceled thread may own locks, partially update state, or hold allocator and library resources. Cleanup handlers and language-level destructors can release resources only if cancellation follows the implementation's supported unwinding path and handlers are correctly nested. Glibc/NPTL uses internal mechanisms that interact with C++ unwinding; catching and swallowing implementation forced-unwind exceptions is dangerous.

Prefer cooperative cancellation: set an atomic stop state, wake the thread, let it exit its state machine, and join it. C++20 `std::jthread` and stop tokens provide a language-level request mechanism, but blocking POSIX calls still need an interruption or polling strategy.

Closing a descriptor from another thread to interrupt blocking I/O is not a universal cancellation protocol; descriptor numbers can be reused and syscall behavior varies by interface. Safer designs use a dedicated wake descriptor in the same poll set, shutdown on a socket where semantics fit, bounded timeouts, or API-specific cancellation.

```text
running -> stop requested -> reject new work -> finish/abort current unit
        -> publish final state -> release resources -> return -> join
```

Cancellation points such as condition waits can release and reacquire mutexes under specified rules, but application invariants may still be mid-transition. Disable cancellation around a non-idempotent critical update only as part of a complete design; forgotten re-enabling creates unresponsive shutdown.

Asynchronous cancellation should be confined to tiny code regions containing only operations documented as async-cancel-safe, a category far narrower than ordinary thread-safe code. In most trading systems, process termination is safer than asynchronously tearing down one corrupted worker inside shared state.

Test stop during every blocking state, full queue, allocation failure, and partial I/O path. A shutdown that works only when workers are idle is not a shutdown design.

## 21.15 Namespaces, Cgroups, Quotas, and Containers

Linux **namespaces** virtualize views of global resources. Major kinds cover PIDs, networking, mounts, IPC, users, UTS identity, time, and cgroups. A **cgroup** groups tasks for hierarchical resource accounting and control. Containers combine these mechanisms with filesystems and security policy; they are not lightweight virtual machines with a separate kernel.

Cgroup v2 provides unified controllers. Relevant controls include CPU weight and bandwidth, cpusets, memory thresholds/maximums, and I/O limits. Exact files exist only when controllers are enabled and delegated in the hierarchy.

CPU bandwidth quotas can throttle a cgroup after it consumes its period budget, producing a latency plateau unrelated to application code. CPU weight affects competition but is not a reservation. Memory limits can trigger reclaim, pressure notifications, or cgroup-local OOM behavior. I/O limits can queue operations. These controls can dominate tail latency while host-wide utilization looks modest.

For a quota expressed as `quota period`, the group can consume at most that CPU time per period before throttling, with multicore execution consuming budget concurrently. A short burst across several CPUs can exhaust a seemingly generous quota early and then wait until replenishment. Inspect throttled period counts and throttled time rather than average CPU percentage alone.

Memory controls have graded pressure. `memory.high` commonly induces reclaim/throttling pressure without being a hard usage ceiling; `memory.max` is a hard limit associated with cgroup OOM handling when reclaim cannot satisfy it. Swap configuration, `memory.low`, and ancestor cgroups change observed behavior. Kernel versions refine details, so test the deployed hierarchy.

```sh
cat /proc/self/cgroup
cat /sys/fs/cgroup/cpu.max 2>/dev/null
cat /sys/fs/cgroup/cpu.stat 2>/dev/null
cat /sys/fs/cgroup/memory.events 2>/dev/null
cat /sys/fs/cgroup/cpuset.cpus.effective 2>/dev/null
```

Paths assume a typical cgroup v2 mount and current cgroup membership. Service managers may place applications in nested scopes.

Namespace isolation also changes observability. A container may see different PIDs, interfaces, mounts, and clocks than a host agent. Hardware caches, memory controllers, CPUs, and kernel paths remain shared unless separately partitioned.

Record container runtime, cgroup paths, effective masks, quota periods, memory events, and throttling counters with every benchmark. “Runs in a container” is neither a performance diagnosis nor a guarantee of isolation.

## 21.16 Resource Limits and Exhaustion Behavior

A **resource limit** is a kernel-enforced soft and hard ceiling associated with a process or user context. The soft limit governs ordinary operation; the hard limit bounds how far an unprivileged process can raise the soft limit.

Relevant limits include:

| Limit | Failure or effect to design for |
|---|---|
| `RLIMIT_NOFILE` | descriptor creation returns `EMFILE`; system-wide exhaustion can return `ENFILE` |
| `RLIMIT_MEMLOCK` | memory locking fails or covers less than expected |
| `RLIMIT_STACK` | main-thread stack/exec argument interactions; overflow still possible |
| `RLIMIT_CORE` | core dumps truncated or disabled |
| `RLIMIT_RTPRIO` | unprivileged real-time priority ceiling |
| `RLIMIT_NPROC` | task/process creation failure for the accounted user |

Limits interact with cgroups, kernel-global tables, overcommit, security modules, and service-manager policy. A high `RLIMIT_NOFILE` does not reserve descriptors or memory; it merely raises one ceiling. A successful heap allocation does not guarantee future pages will survive memory pressure.

There are multiple exhaustion scopes. `EMFILE` means the process descriptor limit was reached; `ENFILE` points to a system-wide open-file limit. `EAGAIN` from thread creation can reflect user task limits, cgroup PID limits, or insufficient resources. Log the limit values and relevant cgroup events at failure time, outside the signal handler and with a bounded reporting path.

Exhaustion must have an explicit state transition. If `accept4` fails with `EMFILE`, decide whether to shed connections, reserve an emergency descriptor, alert, or restart. If `mlockall` fails, continuing silently may expose the hot path to major faults. If thread creation fails, do not run with half the ownership graph initialized.

```sh
prlimit --pid 1234
cat /proc/1234/limits
sysctl fs.file-nr
```

The last command is host-wide and may be restricted. Cgroup event files and application counters supply complementary evidence.

Test limits in a disposable environment by setting deliberately small ceilings before startup, then exercising recovery. Exhaustion tests must include cleanup: repeated failed connection or thread attempts can leak the very resource being tested. Tail-latency engineering includes bounded failure work, not only the successful fast path.

Readiness should verify capacity rather than only configured ceilings: open reserve descriptors, lock and touch required memory, create all workers, allocate bounded queues, and confirm effective policy and affinity. Release test resources only when doing so cannot invalidate the reservation assumption. If capacity cannot be reserved, the service should fail before accepting trading traffic.

Scheduling readiness needs the same rigor. For every critical thread, record TID, name, scheduling policy and parameter, desired and effective CPU masks, NUMA node for its working pages, SMT sibling occupancy, and cgroup path. At host level, record kernel command line, online and isolated CPUs, IRQ placement, cpufreq policy, throttling counters, and housekeeping capacity. Store this evidence outside the hot path and compare it with the declared topology.

Then run an interference test, not only a self-test. Exercise network interrupts, logging, recovery, memory pressure within safe bounds, and normal control-plane work while measuring wakeup-to-run and application latency. Configuration is accepted only when failure recovery remains schedulable. Isolation that produces excellent median latency while starving the supervisor is an invalid operating state.

Configuration drift is an operational event. CPU hotplug, container replacement, firmware updates, kernel upgrades, IRQ rebalance services, and service-manager changes can alter effective placement without changing application code. Monitor the few invariants that define the latency model and alert on mismatch. Revalidate after every kernel or firmware change because scheduler selection, power behavior, mitigations, and counter meanings can change even when commands retain the same names.

Keep the declared topology, observed topology, and benchmark topology identical; otherwise the measured distribution validates a different system than the one carrying production traffic.

## 21.17 Interview Check

1. Distinguish running, runnable, interruptible sleep, uninterruptible sleep, stopped, and zombie states. Which state explains runqueue delay?
2. Explain CFS virtual-runtime concepts and how the fair-class transition toward EEVDF changes overly literal descriptions of “pick the leftmost task.”
3. Compare `SCHED_FIFO`, `SCHED_RR`, and `SCHED_DEADLINE`, including preemption, quanta, budgets, admission, and starvation risk.
4. Why can raising one feed thread's real-time priority increase end-to-end latency or make recovery impossible?
5. Design an affinity plan using NIC queue, NUMA node, cache topology, and SMT siblings. How would you verify that the effective masks match it?
6. Compare pinning with full CPU isolation. Which scheduler, IRQ, RCU, tick, and housekeeping work can remain?
7. Decompose a context switch into direct scheduler work and indirect cache, TLB, branch, and migration effects.
8. Draw a priority-inversion timeline and explain what PI mutexes repair—and what they cannot make bounded.
9. Describe an NPTL mutex's common user-space/futex paths without presenting them as POSIX guarantees.
10. A process dies while holding a robust process-shared mutex halfway through a state update. What must the new owner do before calling `pthread_mutex_consistent`?
