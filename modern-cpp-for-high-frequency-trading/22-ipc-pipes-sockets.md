# Chapter 22 — IPC Selection, Pipes, and Sockets

Inter-process communication is a contract about ownership, capacity, failure, and wakeups before it is a choice of system call. Pipes, Unix-domain sockets, and message queues all move data through kernel-managed state, but they preserve different boundaries and fail differently when a peer stalls or dies. This chapter compares those semantics, accounts for copies and scheduler work, and shows why the fastest average mechanism can still be the wrong mechanism for a bounded-latency service.

## 22.1 IPC Selection Dimensions

An **IPC mechanism** transfers data or coordinates state across protection domains. The first selection dimension is distance: threads in one process can share ordinary objects; processes on one Linux host can use kernel IPC or shared mappings; hosts connected by a network require a network protocol. Do not pay for process isolation when a thread boundary is intended, and do not disguise a future network boundary behind assumptions about shared pointers.

The second dimension is the communication shape:

| Requirement | Natural candidates |
|---|---|
| one-way byte stream | pipe, FIFO, Unix stream socket |
| bidirectional byte stream | Unix stream socket or socket pair |
| bounded records | Unix datagram/seqpacket socket, message queue |
| shared mutable state | shared mapping plus synchronization |
| one producer, many subscribers | per-subscriber sockets, broker, or shared log |
| descriptor transfer | Unix-domain socket |

“Natural” does not mean mandatory. An application can add framing to a stream, but then it owns partial-read buffering, length validation, and resynchronization. It can emulate request/reply with two pipes, but it must manage four ends and half-close behavior.

Security is part of semantics. A filesystem object can inherit directory access control; an already-open descriptor can be passed to a less privileged process; credentials can be checked at connection or message time. Namespaces, user IDs, SELinux or AppArmor policy, and container boundaries affect reachability. A low-latency shortcut that makes an endpoint writable by unintended peers is not an optimization.

Finally, decide what happens when capacity is exhausted. Blocking transfers backpressure to the caller and may invoke the scheduler. Nonblocking I/O returns an error that the application must convert into retry, drop, disconnect, or failover. An unbounded application queue merely moves the problem into memory growth and later latency.

Topology changes the comparison. A pipe between two processes pinned to cores on one NUMA node can keep kernel queues and payload pages relatively local. Moving one endpoint to another socket adds cache-coherence and remote-memory effects. A shared-memory scheme can avoid a payload copy yet perform worse if every message bounces several control lines between sockets. Record placement and affinity in IPC benchmarks.

Operational tooling also matters. File-descriptor IPC composes with `epoll`, supervisor inheritance, descriptor limits, and namespace policy. Named kernel objects require cleanup and discovery. Shared memory requires a separate notification and lifecycle plane. A mechanism with slightly more fast-path work may be preferable when its state is inspectable and its peer-death semantics are unambiguous.

## 22.2 Copies, Serialization, Capacity, and Recovery

A **copy path** describes where payload bytes move; a **control path** describes metadata, syscalls, wakeups, and scheduling. Counting only payload copies misses much of IPC cost.

For a conventional kernel-buffered transfer, the common shape is:

```text
sender object -> serialized user buffer -> kernel queue -> receiver buffer -> object
                   syscall/copy             wakeup        syscall/copy
```

Linux may optimize particular paths, but ordinary `write`/`send` and `read`/`recv` conceptually cross the user/kernel boundary and copy between user buffers and kernel-managed buffers. Small messages can be dominated by syscall entry, validation, queue locks, readiness bookkeeping, and waking a sleeping peer. Large messages become more sensitive to memory bandwidth and cache pollution.

Serialization is optional only when both endpoints agree on an in-memory representation and lifetime. Kernel byte streams do not serialize C++ objects. Writing `sizeof(Order)` bytes is unsafe when the type contains pointers, padding with indeterminate values, virtual state, endian-sensitive integers, or a representation that changes between builds. An explicit wire structure with fixed-width fields and bounds-checked lengths is usually clearer even on one host.

Capacity exists at several layers: the kernel object, a socket's send and receive queues, application staging buffers, and the receiving service. Enlarging a kernel buffer absorbs a longer burst but also permits more queueing delay and memory consumption. A capacity plan must specify both bytes and messages because a flood of tiny records stresses per-message metadata differently from a few large records.

Recovery differs by mechanism. A pipe or connected socket reports peer closure once outstanding data is handled and all peer references are gone. A named queue may outlive a process. Neither reconstructs application state automatically. Sequence numbers, idempotent requests, checkpoints, and explicit session generations belong above IPC.

Measure equal semantics. A benchmark that drops on full cannot be compared directly with one that blocks until delivery. Report payload sizes, queue capacity, producer/consumer affinity, blocking mode, burst distribution, and whether the receiver was already running. Mean throughput hides the wakeup and saturation cases that determine production tails.

Copy accounting should include cache effects. Copying a message reads source lines and writes destination lines, commonly triggering write allocation unless an optimized routine chooses another strategy. The receiver then reads those lines. For small records, this can be less costly than coordinating ownership of a complicated shared structure; for large streams, memory bandwidth becomes more prominent. Measure cycles, instructions, cache misses, context switches, and bytes delivered together.

Syscall batching changes queueing. `writev` and `readv` gather or scatter stream buffers, while datagram APIs offer their own batching facilities. Batching does not change record or stream semantics. Waiting to accumulate a batch delays its first record, so set a maximum batch size and a flush condition based on an absolute deadline.

## 22.3 Pipes and FIFOs

A **pipe** is a unidirectional kernel-managed byte stream. `pipe2` creates two file descriptors atomically with flags such as `O_CLOEXEC` and `O_NONBLOCK`, avoiding separate flag-setting races around `fork` and `exec`.

```cpp
#include <array>
#include <cerrno>
#include <fcntl.h>
#include <system_error>
#include <unistd.h>

std::array<int, 2> make_nonblocking_pipe() {
    std::array<int, 2> fd{};
    if (::pipe2(fd.data(), O_CLOEXEC | O_NONBLOCK) == -1) {
        throw std::system_error(errno, std::generic_category(), "pipe2");
    }
    return fd; // caller owns both descriptors
}
```

Bytes written to `fd[1]` are read from `fd[0]`. There is no message boundary. A read can return part of one write, combine several writes, or return fewer bytes than requested. The reader must frame records itself if boundaries matter.

End-of-file appears only when every descriptor referring to the write end has been closed and the buffered bytes have been consumed. A forgotten duplicate in a parent or child can keep a reader blocked forever. A write with no readers raises `SIGPIPE` by default and fails with `EPIPE` when the signal is ignored or handled. Production code must choose an intentional signal policy.

A **FIFO**, created with `mkfifo`, gives a pipe a filesystem name. Unrelated processes can open it, subject to filesystem permissions. Opening can block while waiting for the opposite endpoint unless nonblocking mode is used. Once open, its data semantics are pipe semantics; the directory entry does not store queued bytes after all opens disappear.

Pipes are attractive for parent/child output capture, logging handoff, and simple one-way control. They offer small API surface and `epoll` integration. They are awkward for bidirectional sessions, peer identity, or record protocols. Two pipes can form a duplex channel, but a Unix socket pair usually expresses the intent better.

After `fork`, close unused ends immediately in both processes. Close-on-exec handles unintended descriptors during a later `exec`, but it does not close endpoints intentionally retained in the current image. Use RAII wrappers so exception paths close them as well. Descriptor ownership is part of the protocol diagram, not housekeeping:

```text
parent: closes read end; owns write end
child:  closes write end; owns read end
EOF:    child sees zero only after parent and every duplicate close writers
```

A FIFO rendezvous has additional startup cases. A nonblocking open for writing fails with `ENXIO` when no reader is present. Opening a FIFO read/write can avoid open-time blocking on Linux, but it changes EOF and self-communication behavior and is not a portable substitute for a peer handshake. Use a separate supervisor or socket when connection identity matters.

Verification starts with descriptor ownership. Inspect `/proc/$PID/fd`, use `strace -f -e trace=pipe2,dup,close,read,write`, and test premature exit on both sides. `strace` changes timing; use it to establish syscall and error behavior, not to measure the latency distribution.

## 22.4 `PIPE_BUF`, Blocking, and Backpressure

`PIPE_BUF` is the maximum size for which POSIX requires a pipe write to be atomic with respect to writes by other processes. Atomic means bytes from competing qualifying writes are not interleaved. It does not create read records, guarantee immediate completion, or make a sequence of writes atomic.

For blocking descriptors, a write of at most `PIPE_BUF` waits until it can be accepted as one noninterleaved unit. A larger write can be split and interleaved. In nonblocking mode, the result depends on requested size and available capacity: a qualifying small write succeeds in full or fails with `EAGAIN`; a larger write may make partial progress.

`PIPE_BUF` is a property queried for the pipe endpoint, for example with `fpathconf(fd, _PC_PIPE_BUF)`. It is distinct from total pipe capacity. Linux exposes the latter with `F_GETPIPE_SZ` and permits bounded changes with `F_SETPIPE_SZ`, subject to kernel limits and privileges. Distribution defaults are not API guarantees.

A blocking read waits when the pipe is empty but writers still exist. A nonblocking read returns `EAGAIN`; it returns zero for EOF. A blocking write waits when capacity is insufficient; a nonblocking write returns `EAGAIN` or a partial count as permitted. Every retry loop must preserve the unwritten suffix and avoid busy-spinning indefinitely.

Backpressure is information: the consumer is not keeping up. There are four common responses:

- block the producer, accepting scheduler and upstream delay;
- retain a bounded application backlog, accepting bounded queueing;
- drop or overwrite according to message importance;
- disconnect or fail the session, triggering recovery.

An HFT control channel may block during startup but reject or coalesce repeated status updates during trading. An audit channel may never drop but must run outside the order path. State the policy per message class.

Readiness is only a hint that an operation was possible when Linux recorded the condition. Another thread can consume capacity before the caller runs. Use nonblocking descriptors with readiness loops and handle `EAGAIN` even after notification. Chapter 24 develops the complete readiness model.

Pipe capacity is not a latency target. Enlarging it lets a producer get further ahead before blocking, so an old record can spend longer queued. Track application sequence age or enqueue timestamps in addition to capacity. If records expire after a deadline, retaining more expired records is harmful.

A useful test has three phases: drain at the expected rate, stop the reader until the pipe fills, then resume it. Record where the writer first blocks or receives `EAGAIN`, how much work is queued outside the pipe, and whether recovery preserves record framing. Repeat with competing writers on either side of `PIPE_BUF` to verify the assumed atomicity boundary.

## 22.5 `splice`, `tee`, and `vmsplice`

Linux's `splice` family moves or references data through pipe buffers to reduce copying between user and kernel address spaces. These interfaces are Linux-specific and operate under filesystem, descriptor, alignment, and kernel-version constraints.

`splice` transfers data between a pipe and another supported file descriptor, with at least one endpoint normally a pipe. It can connect file-to-pipe or pipe-to-socket paths without first copying payload into an application buffer. The application loses the opportunity to parse or transform bytes during that leg.

`tee` duplicates references from one pipe to another without consuming the source pipe. It is useful for fan-out or capture, but both pipes retain capacity obligations. A stalled duplicate can pin pipe-buffer references and backpressure the pipeline.

`vmsplice` maps user pages into a pipe-buffer path or copies data depending on flags, alignment, kernel, and subsequent use. The caller must obey strict buffer lifetime and mutation rules while the kernel may reference the pages. `SPLICE_F_GIFT` transfers page ownership assumptions and is unsuitable for casual use. Treat “zero copy” as a path to verify, not a promise attached to the function name.

Reduced copying can trade memory bandwidth for page-reference bookkeeping, constraints, and larger failure surface. Short transfers, `EAGAIN`, signal interruption, and unsupported descriptor combinations still require loops. Page pinning or retained references can increase memory pressure. Benchmark the end-to-end pipeline, including the slow receiver and cleanup path.

An operation returning zero or a short count must be interpreted according to the exact descriptors and flags. `SPLICE_F_NONBLOCK` does not necessarily make every underlying descriptor nonblocking, and a blocking participant elsewhere in the chain can still stall. Cancellation also becomes harder when data is represented by references held in several pipes. Define who drains or discards each pipe after peer failure.

Reduced-copy paths are most compelling when bytes pass through unchanged. If the application must validate every field, transform representation, or compute a business checksum, it will touch the payload anyway. A conventional read into the eventual parser buffer may have simpler ownership and comparable cache work. Optimize the full computation, not the copy count in isolation.

Use `perf`, syscall tracing, and CPU/memory counters to distinguish copy cost from wakeup cost. Never infer absence of copies solely from throughput. Kernel implementation evolves, and security fixes can change fast paths.

## 22.6 Unix Stream Sockets

A **Unix stream socket** is a bidirectional, reliable, ordered byte stream between local endpoints. `socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0, fd)` creates a connected pair without naming or `accept`; `socket`, `bind`, `listen`, `connect`, and `accept4` create a rendezvous endpoint.

Stream sockets preserve byte order, not writes. Applications need framing. A length-prefixed frame parser must handle a partial prefix, a partial payload, several frames in one receive, malicious lengths, and end-of-stream mid-frame.

```text
receive buffer: [length][payload][length][partial payload ...]
                 frame 1          frame 2 incomplete
```

Use fixed-width length fields, define byte order, cap the length before allocation, and maintain parser state across reads. `SOCK_STREAM` does not justify `recv(fd, &msg, sizeof msg, 0) == sizeof msg`.

A bounded parser owns one fixed receive buffer and two indices. It reads until `EAGAIN`, parses every complete prefix and payload, then compacts only the unconsumed suffix or uses a ring buffer. Before computing `header + length`, it checks `length <= maximum` and subtraction-based bounds to avoid overflow. If EOF arrives with unconsumed bytes, the session ended on a truncated frame and must not dispatch it.

Output needs the dual state machine. A successful partial `send` advances an offset into an immutable queued frame. The frame storage cannot be reused until every byte is accepted. `send` can fail with `EPIPE`, and Linux offers `MSG_NOSIGNAL` to suppress `SIGPIPE` for that call; choose either a process-wide signal policy or per-send behavior deliberately.

Half-close is meaningful. `shutdown(fd, SHUT_WR)` says no more bytes will be sent while reads may continue. `recv` returns zero after peer write shutdown and all queued bytes are consumed. Errors and abrupt process death can produce reset-like conditions depending on pending data and close behavior. Application heartbeats still matter when a process is alive but wedged.

Connection setup has its own queues. A listening socket has a backlog, and `accept4` can return descriptors with nonblocking and close-on-exec flags atomically. A full or stalled accept path delays or rejects new sessions according to Linux behavior and resource state. Pre-established long-lived channels keep this work out of steady state, but restart testing must exercise it.

`SO_PEERCRED` commonly authenticates the process credentials captured for a connected Unix peer on Linux. It does not validate application identity, binary version, or authorization by itself. Exchange a versioned handshake after connection and reject incompatible layouts before accepting descriptors or commands.

Unix sockets avoid IP routing and transport processing, but remain kernel-mediated. Common Linux paths copy payload into socket buffers, update queue state, and may wake the peer. They provide valuable semantics—duplex flow control, descriptor passing, peer credentials, and event-loop integration—in exchange for that work.

## 22.7 Datagram and Sequenced-Packet Unix Sockets

A **Unix datagram socket** preserves message boundaries. One successful send produces one datagram; one receive obtains one datagram. If the receive buffer is too small, excess bytes are discarded, with truncation reported through APIs such as `recvmsg` and `MSG_TRUNC`.

Linux Unix-domain datagrams provide local reliable, ordered delivery under their socket semantics; resource exhaustion is expressed at send time through blocking or errors rather than silent IP-style network loss. Application loss can still occur through truncation, receiver bugs, explicit drops, process restart, or queue teardown. A send success means the kernel accepted the datagram, not that the peer processed it.

`SOCK_SEQPACKET` combines connection-oriented, ordered delivery with record boundaries. It is useful when a session and records are both required. Availability outside Unix domains and exact maximum message behavior are protocol specific; Linux `AF_UNIX` supports it.

Record preservation saves framing state but creates a maximum-record contract. Oversized messages cannot be streamed incrementally without an application fragmentation protocol. Memory footprint includes per-record metadata, and a flood of small records can stress queue bookkeeping.

Use `recvmsg` when truncation, credentials, or ancillary data matters. Always inspect return length and flags. A C++ wrapper should return a bounded byte span plus metadata, not silently construct an object from an incomplete record.

With datagrams, a zero-length record is valid and differs from stream EOF. Readiness consumers must not interpret every zero return identically across socket types. Likewise, `MSG_PEEK` observes a queued record without consuming it but can add syscalls and races when another receiving thread is present. Prefer one receive owner per socket.

The maximum practical record is bounded by socket-buffer policy and kernel constraints, not only the receiver's array. Establish an application maximum below configuration limits and reject larger records at the sender boundary. Fragmenting a logical message into records requires sequence, count, timeout, and memory caps to resist incomplete assemblies.

## 22.8 Filesystem and Abstract Addresses

A filesystem Unix-socket address binds an endpoint to a path. Directory permissions control creation and traversal; the socket inode's ownership and mode contribute access policy. The server must handle stale pathnames from previous crashes without deleting an unrelated object.

A safe startup sequence creates a private directory, uses `lstat` to inspect an existing entry, binds with a restrictive `umask` or corrects permissions, and unlinks only the expected socket. There remains a race if untrusted peers can replace directory entries; directory ownership is the primary defense. Closing the socket does not automatically remove the pathname.

A socket inode's mode controls who may connect on Linux, but portable Unix behavior varies. The containing directory controls who can replace or remove the name. Place service sockets in a runtime directory owned by the service or supervisor, not a world-writable directory with a predictable bare path.

Linux also supports an **abstract namespace** address whose `sun_path` begins with a null byte. It is not a filesystem pathname, has no inode permissions, and disappears when the last reference closes. This namespace is Linux-specific. Authorization must rely on the surrounding namespace exposure and credential checks rather than filesystem mode bits.

`sockaddr_un` addresses are length-sensitive. Abstract names can contain null bytes after the leading null; filesystem names may face termination and length constraints. Pass the exact address length returned or constructed rather than comparing `sun_path` as an ordinary C string.

Mount namespaces affect filesystem addresses, while network namespaces govern Unix abstract namespace visibility on Linux. Container deployment can therefore change which peers can rendezvous. Test the actual namespace layout rather than assuming host-global reachability.

## 22.9 Descriptor and Credential Passing

`SCM_RIGHTS` ancillary data passes references to open file descriptions over a Unix-domain socket. The receiver obtains new descriptor numbers referring to the same underlying open file descriptions; shared file offsets and status flags follow those descriptions. The integer values sent by the sender are not preserved.

Use `sendmsg` and `recvmsg` with a correctly aligned control buffer built through `CMSG_SPACE`, `CMSG_FIRSTHDR`, and related macros. Validate `MSG_CTRUNC`, ancillary type, level, payload length, and the expected number of descriptors. Linux's `MSG_CMSG_CLOEXEC` asks the receive operation to set close-on-exec atomically on received descriptors, avoiding a leak race.

Descriptor passing transfers capability. A receiver may gain access to a file, socket, `memfd`, or device it could not open by path. Authenticate the peer before transfer, apply least privilege to the descriptor, and close every received descriptor on parse or policy failure. Queueing many descriptors consumes receiver and system file-table resources even when payloads are tiny.

On receive failure, ancillary data may already contain valid descriptors. The cleanup path must walk every well-formed `SCM_RIGHTS` payload it received and close those descriptors before returning a higher-level protocol error. Otherwise malformed control traffic becomes a descriptor-exhaustion attack. Apply `RLIMIT_NOFILE`, cap descriptors per message, and monitor open-descriptor counts.

Linux can pass credentials using `SCM_CREDENTIALS` with `SO_PASSCRED`, and can query connected peer credentials with `SO_PEERCRED` where supported. The kernel validates credentials subject to documented privilege rules; do not trust a user-supplied payload claiming a PID or UID. PID namespaces and credential changes affect interpretation, and a PID can be reused after a peer exits.

Ancillary data belongs to a message boundary. Datagram and sequenced-packet sockets make that association natural. On streams, control data is associated with at least one byte and requires disciplined receive handling. Test partial payloads and control-buffer truncation explicitly.

## 22.10 Socket Buffers, Wakeups, and Flow Control

A Unix socket has kernel-managed send and receive state. Buffer limits bound queued data, although Linux accounting and reported `SO_SNDBUF`/`SO_RCVBUF` values include implementation details and may be adjusted or doubled internally. Query the effective settings on the deployed kernel.

When a sender enqueues data, Linux may mark the receiver runnable or notify a readiness waiter. If the receiver is already running and polling, no sleep-to-run transition is needed; if it is blocked, scheduler placement and CPU availability enter latency. Batching amortizes syscalls and wakeups but delays the first item in the batch.

Stream flow control permits partial writes. Datagram sends are record-atomic: an accepted message is queued as a record, while insufficient capacity causes blocking or an error rather than a partial datagram. Nonblocking code must handle `EAGAIN`; blocking code must account for unbounded peer delay unless timeouts or cancellation are part of the contract.

Socket timeouts alter blocking syscalls but are not end-to-end request deadlines. Time spent in an application queue or after a short successful write is outside that timeout. A monotonic absolute deadline propagated through the protocol is more robust than restarting a relative timeout after each partial operation.

Useful observations include `ss -x -a -m -p`, process syscall counters, scheduler traces, and `/proc/net/unix`. Permission and namespace restrictions apply. Measure queue occupancy together with application sequence lag; an empty kernel queue can coexist with a large user-space backlog.

Busy polling a local socket avoids some sleeps but consumes a CPU and can starve its peer when affinity is wrong. A bounded spin-then-park strategy can help when gaps are short and dedicated CPUs are available, but sockets do not expose the same user-space predicate as a shared ring. Evaluate scheduler and energy effects and retain a blocking path for quiet periods.

Avoid concurrent writers to one stream unless framing is serialized. The kernel protects internal socket state, but separate large sends can be partially accepted and application frames can interleave across retry loops. A single writer or serialized output queue gives one owner to framing and backpressure.

## 22.11 POSIX and System V Message Queues

A **message queue** stores discrete records in a kernel object. It provides boundaries and selection semantics at the cost of kernel copies, queue metadata, locks, limits, and wakeups.

POSIX queues use `mq_open`, `mq_send`, and `mq_receive`. A queue has fixed maximum message count and message size chosen at creation within system limits. Messages carry priorities; Linux returns higher priorities first and preserves FIFO order among equal priorities. `mq_send` blocks when full unless nonblocking mode is selected; `mq_receive` blocks when empty. Timed variants use absolute timeouts with their specified clock behavior.

POSIX queue names exist in a dedicated IPC namespace and commonly appear through the `mqueue` filesystem when mounted. Permissions resemble file modes. The queue persists until `mq_unlink` and the last open reference is closed, so a crashed process can leave queued state and a stale schema. Version the payload and define who may recreate or drain it.

`mq_notify` registers one-shot notification; the application must rearm it without losing the empty-to-nonempty transition. Linux also exposes queue descriptors that can integrate with some polling interfaces, but portable POSIX code should not assume descriptor behavior.

System V queues use integer identifiers from `msgget`. Each message begins with a positive type, and `msgrcv` can select by type rather than only FIFO position. This flexibility can require scanning and creates starvation possibilities. `MSG_NOERROR` truncates oversized messages; without it, the receive fails and leaves the message queued.

System V objects persist in the kernel until removed with `IPC_RMID` or by administrative cleanup. Identifiers can be reused, permissions are separate metadata, and namespace behavior depends on deployment. Inspect with `ipcs -q` and remove only known objects with `ipcrm`.

Neither queue is automatically an HFT fast path. They are useful when kernel persistence, priorities, or record selection matter more than minimum latency. Validate `/proc/sys/fs/mqueue` and other kernel limits, resource exhaustion, interruption, and crash cleanup.

Priority can create starvation. A continuous stream of high-priority POSIX messages can prevent lower-priority work from running; selective System V receives can leave unmatched types indefinitely. Bound priority use and expose age metrics per class. If fairness is required, implement and test it explicitly.

Queue attributes are part of compatibility. An opener can use `mq_getattr` to verify message size and capacity, but an existing object's attributes are not replaced merely because a new caller supplies different creation attributes. A stale queue from an older binary can therefore accept opens and then reject or misparse messages unless the application includes schema negotiation.

## 22.12 Choosing by Semantics and Tail Behavior

The correct IPC choice is the simplest mechanism whose failure behavior matches the service. Begin with semantics, then measure its implementation on the target Linux version and hardware.

| Mechanism | Boundary | Backpressure | Distinctive strength | Main tail risks |
|---|---|---|---|---|
| pipe/FIFO | bytes | buffer blocks/errors | simple one-way stream | partial I/O, wakeup, forgotten endpoints |
| Unix stream | bytes | bidirectional flow control | sessions, ancillary data | framing, queueing, wakeup |
| Unix datagram | records | per-message block/error | local record delivery | truncation, full queue |
| Unix seqpacket | records/session | per-message block/error | ordered records with connection | record limit, queueing |
| POSIX/System V MQ | records | bounded kernel queue | priorities/types, persistence | kernel locks, stale objects |
| shared memory | application-defined | application-defined | no payload copy after setup | coherence, crash recovery, correctness |

For each candidate, answer five questions:

1. What exactly is delivered: bytes, records, a descriptor, or shared state?
2. Which process owns each buffer before, during, and after transfer?
3. What happens at capacity: block, retry, drop, overwrite, or disconnect?
4. How are peer death, partial state, duplicate work, and restart detected?
5. Which copies, syscalls, locks, cache-line transfers, and wakeups occur on the fast and slow paths?

Build a saturation test, not just a ping-pong. Hold the consumer, fill every layer, release it, and observe producer behavior, queue delay, memory use, and recovery. Kill each endpoint with data outstanding. Reduce descriptor and queue limits. A mechanism is predictable only when these paths have intentional outcomes.

For example, a local order gateway commonly benefits from one long-lived `SOCK_SEQPACKET` control session when messages are bounded and descriptor passing is required. A telemetry exporter may use a nonblocking datagram socket and drop/coalesce policy. A child-process stdout collector naturally uses a pipe. These choices follow record, ownership, and failure semantics; benchmark results then tune buffer sizes and batching within the chosen contract.

## 22.13 Interview Check

1. Compare a pipe and a Unix stream socket for a bidirectional parent/child control channel. Which semantics simplify the design?
2. What does the `PIPE_BUF` atomicity guarantee, and why does it not give the reader message boundaries?
3. A nonblocking pipe write of a large buffer returns a short count. What state must the sender preserve, and what prevents busy-spin?
4. Explain why `splice` can reduce copies without guaranteeing lower tail latency.
5. Design a bounds-checked frame reader for a Unix stream socket that handles partial headers and payloads.
6. Compare Unix datagram and sequenced-packet sockets with respect to connection state and record boundaries.
7. What exactly crosses the socket with `SCM_RIGHTS`, and which resource and security checks must the receiver perform?
8. Why can increasing a socket buffer improve burst tolerance while worsening end-to-end latency?
9. When would a POSIX or System V message queue be preferable to a Unix socket despite additional kernel bookkeeping?
10. Describe a saturation and crash test that distinguishes blocking, dropping, and recovery behavior among IPC candidates.
