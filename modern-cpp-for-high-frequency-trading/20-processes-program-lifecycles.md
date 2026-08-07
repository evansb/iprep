# Chapter 20 — Processes and Program Lifecycles

A Linux process is not merely “a running program.” It is a set of kernel-managed resources attached to one or more schedulable tasks, and those resources change through creation, program replacement, signals, and termination. The distinctions matter in low-latency systems: `fork` can copy page tables without copying data pages, `execve` preserves a PID while replacing the address space, and a harmless-looking descriptor race can leak a market-data socket into a child. This chapter establishes the lifecycle contracts and shows where kernel work, page faults, dynamic linking, and asynchronous interruption enter the latency model.

## 20.1 Processes, Threads, Tasks, and Shared Resources

A **process** conventionally means an executing program with its own virtual address space and resource set. A **thread** is an execution stream within that process. Linux schedules **tasks** represented internally by kernel task structures; process and thread behavior emerges from which resources tasks share.

POSIX presents a process containing threads. Linux's `clone` family can choose sharing independently with flags such as `CLONE_VM`, `CLONE_FILES`, `CLONE_SIGHAND`, and `CLONE_THREAD`. The NPTL pthread implementation uses an appropriate combination to build POSIX threads. Kernel internal structures and flag details are Linux implementation contracts, not C++ guarantees.

Threads in one process normally share:

- the virtual address space and mappings;
- file-descriptor table;
- signal dispositions;
- current working directory and filesystem context;
- many credentials and namespace memberships.

Each thread has its own register state, stack, thread-local storage, signal mask, scheduling attributes, and Linux task ID. Some “process attributes” have more nuanced per-thread storage inside Linux, but POSIX interfaces may require process-wide behavior.

Separate processes provide address-space isolation: one process cannot ordinarily dereference another's pointer. Threads avoid serialization and kernel IPC for shared memory, but an invalid write can corrupt the entire process and data races invoke C++ undefined behavior. A process boundary improves fault containment at the cost of explicit communication, additional kernel objects, separate page tables, and potentially more copies or mappings.

Sharing is not all-or-nothing. Two processes can map the same memory object while retaining separate descriptor tables and signal state. Conversely, `fork` initially gives a child descriptors that reference the same kernel open file descriptions while user memory is logically separate. For every component, enumerate address space, descriptor ownership, scheduling, credentials, and failure propagation independently.

C++ does not define processes, `fork`, or interaction between its runtime and a post-fork child. POSIX and the C/C++ implementation supply that layer. A process that uses allocator threads, iostream locks, or runtime registries cannot assume those facilities are consistent in the child merely because their bytes were copied.

```text
process
├── shared address space, fd table, dispositions
├── task: stack, registers, mask, scheduler state
├── task: stack, registers, mask, scheduler state
└── task: stack, registers, mask, scheduler state
```

Count kernel crossings and bytes communicated, but also count failure domains. A separate risk gateway may accept IPC latency to prevent a strategy fault from bypassing controls. A parser and book builder on one thread may instead eliminate synchronization entirely. Linux supplies mechanisms; architecture supplies the ownership contract.

Inspect the model with `ps -eLf`, `/proc/PID/task`, and `strace -f`. These tools observe a moving system and can perturb scheduling, so use them diagnostically rather than in a production hot path.

## 20.2 PIDs, TIDs, Groups, Sessions, and Namespaces

A **PID** identifies a process in a PID namespace. Linux also assigns a **TID** to every task; for the thread-group leader, TID equals PID. `getpid()` returns the thread-group ID as exposed by the process API, while Linux `gettid()` returns the calling task's TID.

Identifiers are reused after exit and reaping. A cached numeric PID is therefore not a stable handle to one lifetime. Section 20.12 introduces pidfds, which allow operations on a referenced process without the same PID-reuse race.

A **process group** collects processes for job-control signal delivery. A **session** collects process groups and can own a controlling terminal. Shell pipelines commonly form a process group; terminal-generated signals target the foreground group. HFT daemons rarely use interactive job control directly, but inherited session and controlling-terminal state can still affect signal delivery and shutdown.

```sh
ps -o pid,ppid,pgid,sid,lwp,stat,comm -p 1234
```

Output fields are a snapshot. A task can exit or change state between inspection and the next operation.

PID namespaces virtualize identifier visibility. A process can have one PID as seen by its namespace and another as seen by an ancestor namespace. The first process in a PID namespace has special reaping and signal responsibilities. `/proc` must be mounted with the intended namespace view if tools inside a container are to report matching identities.

Namespaces do not create a new scheduler or physical CPU. Two containers can have disjoint PID views while competing on the same runqueue and cache. Namespaces also do not make a numeric PID globally meaningful. Operational logs should include namespace or container identity when correlating TIDs across hosts.

Creating groups, sessions, or namespaces involves syscalls and kernel bookkeeping, but lookup and observability errors usually dominate their steady-state performance impact. Verify identity using `/proc/PID/status`, namespace symlinks under `/proc/PID/ns`, and `lsns`; avoid scripts that assume one host PID equals one container PID.

APIs taking zero or negative PID-like values can interpret them as “self,” a process group, or a broad set rather than one process. `kill(0, sig)` targets the caller's process group; `waitpid(-1, ...)` selects any child. Validate sign and range when identifiers cross a protocol boundary. Accidentally broad signal delivery is a correctness and availability failure, not a mere lookup bug.

## 20.3 Credentials, Capabilities, and Limits

**Credentials** determine which security checks a task passes. POSIX defines real and effective user and group IDs; saved IDs support controlled privilege transitions. Linux adds filesystem IDs, supplementary groups, securebits, capability sets, and user namespaces.

The effective IDs commonly drive access checks. Real IDs describe origin and affect selected APIs; saved IDs can permit regaining a previous effective identity. Changing one without understanding the full set can leave more privilege than intended.

Linux **capabilities** split traditional superuser privilege into named powers such as `CAP_NET_ADMIN`, `CAP_SYS_NICE`, and `CAP_IPC_LOCK`. Capability checks are contextual: effective, permitted, inheritable, bounding, and ambient sets interact with user namespaces and `execve`. Possessing one capability is not equivalent to unrestricted root, and container root may have no matching privilege in the initial user namespace.

Low-latency setup sometimes requests privileges to lock memory, set affinity, tune network devices, or use real-time policies. Apply privileged configuration during a controlled startup phase, then reduce privileges when the operating model permits. Never grant broad capabilities merely to make a tuning command succeed; each widens the failure and security domain.

Resource limits, retrieved with `getrlimit` and exposed in `/proc/PID/limits`, impose per-process or per-user ceilings. Relevant examples include open descriptors, stack size, locked memory, core size, process count, and real-time priority. Section 21.16 treats exhaustion behavior in detail.

```sh
id
getpcaps 1234
prlimit --pid 1234
grep -E '^(Uid|Gid|Cap|NoNewPrivs)' /proc/1234/status
```

Commands depend on permissions and tool versions. Their output is observational, not a proof that a later privileged operation will succeed; Linux security modules, seccomp, namespaces, and cgroups can add restrictions.

Credential transitions are normally cold-path operations involving kernel checks and shared state. Their main latency risk is misconfiguration that triggers fallback, permission failure, or partial startup. Treat the exact required privilege set and rollback behavior as deployment artifacts tested on the production kernel configuration.

Capability behavior across exec is computed from file capabilities, process sets, securebits, ambient capabilities, bounding set, `no_new_privs`, and namespace context. Do not compress that transition into “capabilities are inherited.” Use `capsh`, `getpcaps`, `/proc/PID/status`, and a purpose-built startup self-check, then refuse readiness if required operations fail. Dropping a capability should be tested by proving a forbidden operation is denied after the transition.

## 20.4 Process Resources and `/proc`

A process owns or references a graph of kernel and user-space resources: address-space mappings, page tables, an open-descriptor table, open file descriptions, signal state, credentials, namespaces, resource limits, timers, and task structures. Many entries are reference-counted and can be shared after `fork` or `dup`.

The distinction between a descriptor and an open file description is essential. A descriptor is a small integer in one descriptor table. It refers to a kernel open file description containing status flags and, for seekable files, an offset. After `fork`, parent and child have separate descriptor tables whose entries can refer to the same open file description; offset changes can therefore be shared.

`/proc` is a virtual filesystem that exposes kernel-generated views:

| Path | Useful information |
|---|---|
| `/proc/PID/status` | IDs, state, capabilities, memory counters, masks |
| `/proc/PID/maps` | virtual mappings and permissions |
| `/proc/PID/smaps` | per-mapping memory accounting |
| `/proc/PID/fd` | descriptor symlinks |
| `/proc/PID/fdinfo/N` | flags and object-specific details |
| `/proc/PID/task` | threads in the process |
| `/proc/PID/stat` | compact scheduler and fault counters |

Reading these files performs kernel formatting and copies data to userspace. `smaps` can be substantially more expensive than `maps`. Do not scrape it at high frequency from latency-sensitive CPUs.

Memory counters also answer different questions. Virtual size counts address ranges, RSS approximates resident pages attributed to the process, proportional set size distributes shared pages, and private dirty pages suggest COW or writable state. Kernel accounting can lag or use estimates. Select the counter that matches the hypothesis instead of treating “memory usage” as one scalar.

Paths race with process change. A descriptor can close and be reused between listing `/proc/PID/fd` and opening one entry. Mapping lines can change during inspection. Parsing `/proc/PID/stat` requires care because the command field is parenthesized and may contain spaces. Prefer maintained libraries or exact documented parsing over naive field splitting.

Use tools for complementary views: `ps` for snapshots, `pidstat` for interval counters, `top` for interactive summaries, and `strace` for syscall tracing. `strace -f -ttT` can reveal lifecycle paths but ptrace-based observation changes timing and signal behavior. `perf` tracepoints and eBPF can reduce some overhead while still imposing cost.

## 20.5 `fork` and Copy-on-Write

`fork()` creates a child process whose initial user-visible state largely duplicates the caller's process. Parent and child return from the same call with different return values. Linux normally implements the address-space duplication through **copy-on-write** mappings: pages are initially shared and copied only when one side writes.

```cpp
#include <cerrno>
#include <cstdlib>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

int main() {
    const pid_t child = ::fork();
    if (child == -1) return EXIT_FAILURE;
    if (child == 0) ::_exit(42);

    int status = 0;
    while (::waitpid(child, &status, 0) == -1 && errno == EINTR) {}
    return WIFEXITED(status) && WEXITSTATUS(status) == 42
        ? EXIT_SUCCESS : EXIT_FAILURE;
}
```

COW avoids eagerly copying every data page, but `fork` is not independent of address-space size. Linux must create task and memory-management structures, duplicate or share mapping metadata, copy page-table levels as needed, update reference accounting, copy a descriptor table, and make the child schedulable. Section 20.6 separates page-table effects.

Afterward, writes to shared private pages fault. The kernel allocates a page, copies content when necessary, updates page tables, and resumes execution. A large allocator heap whose metadata is touched by both parent and child can trigger many faults. Transparent huge-page state and kernel version can change the granularity and path.

Open descriptors are inherited and normally refer to the same open file descriptions. Buffered C library and C++ iostream state is duplicated in userspace. If both processes flush a buffer copied before `fork`, output can be duplicated.

In a multithreaded process, only the calling thread appears in the child. Locks held by vanished threads remain represented in copied memory. POSIX consequently restricts what the child may safely call before an `exec` operation; use only async-signal-safe functions in the child path. `pthread_atfork` handlers can repair selected library state, but composing handlers across libraries is fragile and adds work around every fork.

Allocator state is a prominent example. Another thread may have been modifying an arena when the snapshot occurred. A conforming libc arranges its own fork handling, but application allocators and third-party runtimes need their own documented support. Calling `new`, formatting an error string, or throwing in the child can enter copied synchronization state. Prepare raw arguments and error descriptors before `fork`; keep the child branch a sequence of safe descriptor actions, `execve`, and `_exit`.

COW also changes memory accounting. Parent and child can each appear to have a large RSS even while physical pages are shared; proportional or private-dirty accounting better exposes divergence. A backup child that scans and writes metadata may destroy the sharing benefit and compete for memory bandwidth with the parent.

Linux `madvise` options such as `MADV_DONTFORK` and `MADV_WIPEONFORK` can alter inheritance for selected mappings. They are explicit Linux policies with strong correctness consequences, not generic fork optimizations.

Measure fork under realistic resident-set and mapping counts. Record minor faults in both parent and child, page-table memory, elapsed distributions, and post-fork writes. A microprocess with an empty heap is not representative of a market process holding a large order book.

## 20.6 Page-Table and TLB Costs of Creation

Copy-on-write shares data pages, not one mutable page-table tree. Process creation requires address-translation metadata that the child can later modify independently. The work depends on populated mappings and page-table structure, not only virtual address range.

For a large resident address space, `fork` can walk and copy many page-table entries while holding memory-management locks. It also establishes write protection for private mappings so later writes fault. Kernel optimizations and page-table sharing details evolve, so no fixed per-page instruction count is portable across kernels and architectures.

Translation lookaside buffers cache page-table results per CPU. Changing mappings may require invalidation and interprocessor coordination. Address-space identifiers such as x86 PCIDs and ARM ASIDs can retain translations across some context switches, but they do not eliminate page-table creation or every invalidation. Whether the kernel uses a particular optimization depends on CPU features and kernel configuration.

The latency path can be decomposed:

```text
fork syscall
  -> allocate child kernel state
  -> duplicate/share resource tables
  -> duplicate memory-map metadata
  -> establish child page tables and COW protection
  -> enqueue child
later write
  -> protection fault -> allocate/copy page -> update PTE -> resume
```

An address space with many small VMAs can be costly even if few bytes are resident. A huge sparse mapping can be cheaper than a densely populated one. Transparent huge pages may reduce translation entries but introduce splitting or large-copy considerations on write. Measure both mapping count and resident pages.

Useful observations include `/proc/PID/status` fields such as `VmPTE`, `perf stat` minor-fault counts, and targeted tracepoints for faults and scheduling. `time` around a one-shot fork is too coarse and mixes parent scheduling with creation. Run distributions, pin observation threads thoughtfully, and keep tracing overhead explicit.

The predictable choice for spawning helpers from a large multithreaded trading process is often to avoid a general fork path. Start helpers before constructing the large working set, maintain a small supervisor process, or use `posix_spawn` where its implementation offers a safer optimized path.

A useful experiment varies one dimension at a time: number of VMAs, number of resident base pages, amount of transparent-huge-page coverage, and number of open descriptors. Measure parent pause, time until child executes, child minor faults, and post-fork write faults. Drop-caches experiments require privilege and alter the whole host; use disposable systems and label cold-cache results separately.

## 20.7 `vfork`, `clone3`, and `posix_spawn`

`vfork()` creates a child that temporarily executes in the parent's address-space context while the parent is suspended, until the child calls an exec function or `_exit`. Its restrictions are severe: modifying ordinary data, returning from the calling function, or calling unsuitable functions can corrupt the parent or invoke undefined behavior under the API contract.

Treat the child path as a tiny exec stub. Do not use `vfork` directly in general C++ code: constructors, destructors, allocation, exceptions, and library calls manipulate shared process state. An implementation of a higher-level spawning API can use it because that implementation controls the entire stub.

Linux `clone()` and `clone3()` expose fine-grained resource sharing. `clone3` accepts a size-versioned structure and supports features such as requesting a pidfd atomically. Flag combinations have interdependencies and security consequences. They underpin threads, namespaces, and container runtimes; they are not a simpler portable process API.

`posix_spawn()` combines process creation with a defined set of child file actions and attributes before program replacement. POSIX specifies behavior, not whether the implementation uses `fork`, `vfork`, or `clone`. Current libc implementations choose paths based on requested actions and their own versions. Therefore “`posix_spawn` is always faster” is false.

File actions can close, duplicate, and open descriptors in an ordered sequence. Attributes can set selected masks, groups, scheduling properties, and defaults according to supported flags. Unsupported or failing child-side setup is reported through the spawn operation's defined error machinery. Build actions from an allowlist of descriptors rather than attempting to close an unknown range one by one where modern close-range mechanisms or libc extensions are available.

```cpp
#include <spawn.h>
#include <sys/wait.h>

extern char** environ;

int spawn_true() {
    pid_t pid{};
    char path[] = "/usr/bin/true";
    char* argv[] = {path, nullptr};
    const int error = ::posix_spawn(&pid, path, nullptr, nullptr, argv, environ);
    if (error != 0) return error; // returns an error number directly

    int status{};
    return ::waitpid(pid, &status, 0) == pid && WIFEXITED(status)
        ? WEXITSTATUS(status) : -1;
}
```

Spawn cost includes kernel task creation, action processing, argument/environment copying, scheduling, and the full exec startup path. Use `strace -f` in a test environment to see the actual syscall path for the deployed libc, then benchmark the exact file actions and process memory footprint.

## 20.8 `execve`, ELF Loading, and the Dynamic Linker

`execve()` replaces the calling process's program image. On success it does not return. The process keeps its PID, but its address space, code, data, stack, and most execution context are replaced according to POSIX and Linux rules.

The kernel copies and validates argument and environment strings subject to a size limit related to system configuration and stack limits. It resolves the executable, checks permissions, installs a new memory map, creates the initial stack and auxiliary vector, and starts at the executable interpreter or entry point.

For a dynamically linked ELF binary, a `PT_INTERP` program header names the dynamic linker. The kernel maps the executable and interpreter; the interpreter maps required shared objects, processes relocations, establishes TLS, runs initialization, and transfers control to the program entry sequence that eventually calls `main`.

```sh
readelf -lW ./gateway
readelf -dW ./gateway
LD_DEBUG=libs,reloc ./gateway   # diagnostic only; very intrusive
```

Many process attributes survive exec, including PID, current directory, resource limits, and descriptors without close-on-exec. Caught signal dispositions are reset to defaults; ignored dispositions generally remain ignored under POSIX rules. The calling thread becomes the initial thread of the new program and other threads do not survive.

The new image also inherits environment, umask, process group/session membership, namespace membership, and selected timers or locks according to their individual contracts. Memory mappings, alternate signal stacks, and user-space synchronization objects do not simply carry over as usable state. The only safe way to reason about exec inheritance is an attribute checklist, not “same process” or “new process” shorthand.

Argument strings are copied data, not shared pointers into the old image. Large environments add copying and stack setup and may expose secrets through `/proc` or child behavior. Pass the minimum explicit environment required by the program and avoid latency-sensitive dynamic configuration through enormous environment blocks.

Set-user-ID, capabilities, `no_new_privs`, tracing, mount options, and security modules affect credential transition. Never describe exec as “starting a clean process” without enumerating inherited state.

On failure, `execve` returns `-1` and sets `errno`; the old program remains. Child spawn code must report failure without invoking unsafe buffered or allocation-heavy machinery. A dedicated error pipe with close-on-exec can distinguish successful replacement from exec failure.

## 20.9 Relocations, Constructors, and Demand Paging

Program startup continues after the kernel maps ELF segments. The dynamic linker finds dependencies, resolves symbols, applies relocations, configures thread-local storage, and may run audit or preload machinery from the environment when security rules permit.

Position-independent executables and ASLR relocate load addresses. Some relocations write process-private tables and trigger page faults. `RELRO` can make relocation targets read-only after startup. Immediate binding resolves eligible symbols up front; lazy binding can defer some function resolution until first call. Toolchain defaults, linker flags, libc, architecture, and security settings determine the exact path.

For latency-sensitive programs, deferring a symbol lookup to the first market packet is undesirable. Linking with immediate binding or explicitly warming paths can move work into startup, but it may increase startup time and resolve functions never used. Inspect with:

```sh
readelf -rW ./gateway
LD_BIND_NOW=1 ./gateway
perf stat -e page-faults,minor-faults,major-faults ./gateway
```

Do not use `LD_DEBUG` or loader auditing for timing; they change the path drastically.

Namespace-scope C++ constructors run before `main` through runtime startup machinery. Their order has the limitations discussed in Section 3.2, and they may allocate, open files, or start threads. Prefer an explicit startup graph that can report failures and record duration.

Static linking removes runtime shared-library lookup for included code but can enlarge the executable and page-cache footprint, duplicate security-sensitive libraries across deployments, and still perform relocations and constructors. Dynamic linking can share clean pages between processes and supports centralized updates, while adding loader dependencies. Choose from deployment, ABI, memory, and startup evidence rather than the slogan “static is faster.”

Mapped executable and library pages are generally demand-paged. The first instruction or data access can fault a resident page into the page tables; if backing storage is not cached, a major fault can involve storage latency. Read-ahead, page cache state, filesystem, and deployment packaging all affect the distribution. Touching code is less straightforward than touching data because speculative or artificial calls can change state. Exercise representative cold paths during a controlled readiness phase and measure faults.

## 20.10 Close-on-Exec and Descriptor-Leak Races

The **close-on-exec** descriptor flag causes the kernel to close a descriptor during successful exec. It prevents inherited sockets, files, event descriptors, and secret-bearing handles from leaking into a new program.

Setting `FD_CLOEXEC` with `fcntl` after creating a descriptor is racy in a multithreaded process:

```text
thread A: fd = open(...)
thread B: fork(); execve(...)  // child inherits fd here
thread A: fcntl(fd, F_SETFD, FD_CLOEXEC)
```

Use creation interfaces that set the flag atomically: `open(..., O_CLOEXEC)`, `socket(... | SOCK_CLOEXEC)`, `accept4(..., SOCK_CLOEXEC)`, `pipe2(..., O_CLOEXEC)`, `dup3(..., O_CLOEXEC)`, and analogous Linux APIs. Availability is interface- and platform-specific; portable code may require a global spawn/descriptor protocol when atomic creation is unavailable.

Close-on-exec is a descriptor flag, unlike open-file status flags such as `O_NONBLOCK`. Duplicating a descriptor with different APIs can clear or set close-on-exec according to that API. Review every creation and duplication site.

A leak has correctness and performance effects. The child can retain a socket reference, preventing peer-visible closure after the parent closes its copy. It consumes descriptor-table capacity and can expose data or control surfaces. Large descriptor tables also add work to process creation and exec close scanning, though kernel representation and optimizations vary.

C++ RAII wrappers should set close-on-exec at creation, own exactly one descriptor, close on destruction, and expose explicit duplication or release operations. A wrapper cannot repair an already-racy create-then-flag sequence. The safe property belongs to the syscall that creates the kernel table entry.

Verify in integration tests by spawning a helper that lists `/proc/self/fd` and comparing against an allowlist. The listing operation itself opens a directory descriptor, so account for the observer. Static wrappers should default every owned descriptor to close-on-exec unless deliberate inheritance is part of the API.

## 20.11 `_exit`, `exit`, and Buffered Cleanup

`exit()` performs user-space process termination cleanup: it calls functions registered with `atexit`, flushes and closes C standard I/O streams, removes temporary files registered through relevant facilities, and then terminates. Returning from `main` is defined in terms of calling `exit` with the return value.

`_exit()` terminates without running `atexit` handlers or flushing user-space stdio buffers. POSIX still requires process-level kernel cleanup, such as closing descriptors and reporting status. The C library `_exit` wrapper on modern Linux commonly invokes an exit-group operation so all process threads terminate; the raw kernel distinction is implementation detail.

After `fork`, the child should use `_exit` on a pre-exec error path. Calling `exit` can flush buffers copied from the parent and invoke handlers against copied lock state.

```cpp
if (::fork() == 0) {
    ::execl("/usr/bin/helper", "helper", nullptr);
    const char message[] = "exec failed\n";
    (void)::write(STDERR_FILENO, message, sizeof(message) - 1);
    ::_exit(127);
}
```

Even `_exit` can incur unpredictable kernel work because closing the last reference to a descriptor can trigger protocol teardown or storage-related handling. Linux manual pages note that descriptor closure can delay termination. If bounded shutdown matters, release costly resources in an explicit monitored phase before the final termination call.

C++ automatic objects do not have their destructors run merely because `_exit` is called. Abrupt termination bypasses language-level cleanup. That is appropriate for a corrupted child stub, not a normal graceful shutdown. Separate “stop admitting work,” “drain or reject,” “flush required durable state,” “close,” and “terminate” as explicit states.

Exit status occupies a limited representation. Normal exit supplies a small status inspected with `WIFEXITED` and `WEXITSTATUS`; signal termination is reported with `WIFSIGNALED` and `WTERMSIG`. Shell conventions such as `128 + signal` are not the raw wait-status API. Supervisors should preserve the distinction when deciding restart, escalation, and alert severity.

## 20.12 Zombies, Reaping, Subreapers, and Pidfds

A terminated child becomes a **zombie** until its parent collects termination information. It no longer has a runnable address space, but the kernel retains enough process metadata for status and accounting. Accumulated zombies consume PID and task-table resources.

`wait`, `waitpid`, and `waitid` reap children and report exit, signal, stop, or continuation events according to options. A `SIGCHLD` handler can notify a parent, but robust code loops because signals coalesce and several children may change state before one delivery.

```cpp
void reap_available() {
    for (;;) {
        int status{};
        const pid_t pid = ::waitpid(-1, &status, WNOHANG);
        if (pid > 0) continue;
        if (pid == -1 && errno == EINTR) continue;
        break;
    }
}
```

If a parent exits, children are reparented to an appropriate reaper. Linux `prctl(PR_SET_CHILD_SUBREAPER, 1)` lets a supervisor act as the reaper for orphaned descendants in its subtree. PID-namespace init processes and service managers commonly fill this role. Subreaping changes lifecycle responsibility; it does not automatically wait for children.

POSIX has special behavior when `SIGCHLD` is explicitly ignored or `SA_NOCLDWAIT` is selected; systems can avoid ordinary zombies under those configurations. Portability details differ historically, and these modes discard or alter status collection. A supervisor that needs exit reasons should keep an explicit reaping path instead of relying on signal disposition shortcuts.

Linux pidfds are file descriptors referring to a process lifetime. `pidfd_open` can obtain one for an existing process, while newer creation APIs can return one atomically. A pidfd can be polled for exit and used by pidfd-aware operations, avoiding the classic “check PID, PID exits and is reused, signal wrong process” race.

Kernel-version and permission support must be checked. A pidfd does not make arbitrary process state immutable, and `pidfd_open` after a numeric PID lookup still occurs after creation; use atomic creation when the parent controls it.

Integrating pidfds into `epoll` can unify process completion with other event sources. This trades asynchronous `SIGCHLD` handling for descriptor readiness, though the parent still calls an appropriate wait operation to collect status. Test rapid process churn specifically; slow manual tests rarely trigger reuse races.

## 20.13 Signals, Masks, Delivery, and Async-Signal Safety

A **signal** is an asynchronous notification with a number and disposition. A disposition may be default action, ignore, or a user handler. Signal dispositions are process-wide under POSIX, while each thread has its own signal mask.

Standard signals generally do not queue multiple identical pending instances. POSIX real-time signals queue and carry ordering/value semantics subject to resource limits. A program that treats “one handler call equals one event” can lose multiplicity with standard signals.

Process-directed signals may be delivered to an eligible thread that does not block them. Thread-directed signals target a specific thread. A common deterministic design blocks operational signals in all threads, then has one control thread receive them synchronously with `sigwait` or through `signalfd` as Section 20.14 describes.

```cpp
sigset_t set;
::sigemptyset(&set);
::sigaddset(&set, SIGTERM);
::sigaddset(&set, SIGINT);
::pthread_sigmask(SIG_BLOCK, &set, nullptr); // call before creating workers
```

New threads inherit the creator's mask, which makes “block first, then start threads” effective. Masking a signal does not discard it; it can remain pending.

A handler interrupts ordinary control flow. Only async-signal-safe functions may be called reliably; most C++ library operations, allocation, locking, iostreams, and nontrivial destructors are unsafe. Access to shared state is severely constrained. A `volatile sig_atomic_t` flag supports limited communication in ISO C; POSIX and C++ atomic interactions require careful, implementation-supported reasoning.

Real-time signals are ordered within POSIX rules and can carry a `sigqueue` value, but their queue is finite and subject to `RLIMIT_SIGPENDING` accounting. Queue exhaustion must be handled. Standard signals are often preferable for idempotent state requests such as “begin shutdown”; an event counter belongs in a pipe, eventfd, or shared-memory structure.

Signal masks are inherited across thread creation and preserved across exec; dispositions follow separate exec rules. This distinction enables a common spawn bug: a child program unexpectedly starts with `SIGTERM` blocked because the spawning thread's mask was never normalized in spawn attributes or the child stub.

Signal delivery saves and restores execution context, disturbs registers and caches, and can arrive at an inconvenient instruction. No application-level tail bound follows from “the handler is short.” Keep handlers minimal, route work to normal control flow, and observe signal counts through `/proc`, tracing, or controlled tests without logging from the handler.

## 20.14 `EINTR`, Restart Behavior, `signalfd`, and Alternate Stacks

A blocking syscall can return early when a signal handler runs, reporting `-1` with `errno == EINTR`. Some interfaces are automatically restarted when the handler was installed with `SA_RESTART`; others are not, and Linux behavior has syscall-specific details.

Blindly retrying is wrong when an operation already transferred data. `read` or `write` can return a short positive count; that progress must be consumed before continuing. A timeout may also need recomputation against an absolute deadline rather than restarting its full duration.

```cpp
ssize_t read_retry(int fd, void* buffer, std::size_t size) {
    for (;;) {
        const ssize_t result = ::read(fd, buffer, size);
        if (result == -1 && errno == EINTR) continue;
        return result; // caller handles EOF, short read, and other errors
    }
}
```

This wrapper is suitable only when unconditional retry matches cancellation policy. A shutdown signal may be intended to break the wait.

Linux `signalfd` converts selected blocked signals into records read from a descriptor. It integrates with `poll`, `epoll`, and a normal state machine, avoiding async handler code. The signals must remain blocked from conventional delivery. Reading consumes pending instances according to signal semantics; standard signals still do not become lossless counters.

`sigwait` is a portable POSIX alternative for a dedicated signal thread. It blocks synchronously and returns a selected signal number. Choose between a signal thread and `signalfd` based on the existing event architecture, not an assumed universal speed difference.

An alternate signal stack configured with `sigaltstack` and selected by `SA_ONSTACK` lets a handler run when the normal thread stack is exhausted or corrupted. The application owns the memory and must size it for nested signals, architecture context, and handler call depth; `SIGSTKSZ` is not a proof of sufficiency for every extended machine state. Guarding and prefaulting the region can reduce failure risk.

Alternate stacks are configured per thread. Installing one only on the main thread does not protect a worker that receives the signal. Signal routing policy, per-thread masks, and alternate-stack installation must be designed together. The stack memory cannot be freed until disabled on that thread and no handler uses it.

Handler setup should use `sigaction`, initialize the mask deliberately, and avoid mixing `sa_handler` and `sa_sigaction` interpretations. Save and restore `errno` inside a minimal handler if interrupted code depends on it. These details are small; their failure paths are asynchronous and exceptionally difficult to reproduce.

Signals are control-plane mechanisms, not low-latency queues. Prefer eventfds, sockets, or shared-memory protocols for frequent application events. Reserve signals for lifecycle and exceptional control, and verify with forced interruption tests that every blocking loop, partial transfer, and shutdown path remains correct.

Consider a gateway that starts a capture helper and later replaces it during a configuration rollout. A decision-complete lifecycle is:

```text
prepare argv, environment, allowlisted descriptors, error pipe
  -> spawn child with atomic close-on-exec policy
  -> observe exec success when error-pipe writer closes
  -> obtain/retain pidfd
  -> wait for explicit application-ready message
  -> route traffic
  -> request shutdown through ordinary IPC
  -> wait until deadline
  -> escalate through pidfd signal if required
  -> wait/reap and record exact status
```

Each transition owns a timeout and failure response. PID publication before exec success exposes a process that may still be the child stub. Exec success before application readiness exposes relocations, constructors, page faults, and configuration work. A numeric PID without a pidfd permits reuse races during escalation. Declaring readiness only after memory, threads, descriptors, affinity, and protocol state are prepared moves lazy tails out of live traffic.

The descriptor allowlist should include standard streams only when deliberately connected, the exec-error writer until successful exec closes it, and application IPC needed by the new image. Everything else is created close-on-exec. The child does no heap allocation or C++ formatting. The parent reads the error pipe with partial-I/O and `EINTR` handling and simultaneously owns the child's reaping responsibility.

Verification combines layers. Trace one disposable launch to confirm spawn and exec syscalls; inspect the child's `/proc/PID/fd`, limits, credentials, masks, and namespace membership; record minor and major faults until readiness; kill the child during every transition; and churn enough short-lived children to exercise identifier reuse. A fast successful launch is insufficient evidence for a correct lifecycle.

This pattern also makes costs attributable. Spawn latency belongs to task and resource creation, exec latency to image and loader setup, readiness latency to the application, and shutdown latency to drain and cleanup. Reporting one “process start time” hides the component that must be bounded.

Crash handling needs a separate path from graceful replacement. A fatal signal may arrive while allocator, logger, or loader locks are held, so an in-process crash handler cannot safely produce an elaborate report. Configure core-dump policy and a minimal async-safe notification, then let an external supervisor collect `/proc`, pidfd status, and deployment metadata. Core creation itself can consume storage and time and is constrained by `RLIMIT_CORE`, dumpability, cgroup policy, and system configuration. Decide whether the service stops, restarts, or enters a fail-closed mode before the crash occurs.

Finally, process lifecycle tests must run under the actual service manager. Managers can reset signal masks, redirect descriptors, create cgroups, impose limits, select restart policy, and report readiness through their own protocol. A binary launched from an interactive shell does not exercise that inherited state. Capture both application self-checks and manager-visible status in the acceptance evidence.

Inherited state is executable configuration.

## 20.15 Interview Check

1. Explain how Linux tasks represent POSIX processes and threads. Which resources are normally shared by threads but not by separate processes?
2. Distinguish PID, TID, process group, session, and PID-namespace-visible identifiers. Why is a numeric PID not a stable lifetime handle?
3. Trace `fork` for a multigigabyte process from the syscall through the child's first write. Which costs occur even when data pages use copy-on-write?
4. Why may only async-signal-safe operations be used in a multithreaded child between `fork` and `exec`?
5. Compare `vfork`, `clone3`, and `posix_spawn` in semantics, portability, and implementation freedom.
6. Describe the kernel, ELF interpreter, relocation, constructor, and demand-paging stages between `execve` and `main`.
7. Find the race in “open, then set `FD_CLOEXEC`” and name four atomic close-on-exec creation interfaces.
8. Compare `exit` and `_exit` after `fork`. Which user-space cleanup is intentionally skipped, and what kernel work can remain?
9. Design a supervisor that reaps descendants and avoids PID-reuse races using subreaping, pidfds, and wait operations.
10. Explain standard versus real-time signal queueing, per-thread masks, `SA_RESTART`, partial I/O, and when `signalfd` is preferable to a handler.
