# Chapter 33 — Clocks, Synchronization, and Timestamping

A timestamp is useful only when its clock, epoch, adjustment policy, and capture point are known. Reading a counter quickly does not make it synchronized, and disciplining a clock accurately does not place an application timestamp near the wire. Trading systems need both correctness—bounded offset and a defined time scale—and a measured access path that does not distort the event being observed. This chapter separates wall and interval clocks, develops NTP and PTP timing models, follows Linux software and hardware timestamps, and ends with a monitoring discipline for clock steps, drift, servo state, and domain conversion.

## 33.1 Wall, Monotonic, Raw, and Boottime Clocks

A **clock** maps an advancing physical process or counter to a time value. Its properties include epoch, rate, adjustability, suspend behavior, resolution, read cost, and synchronization to other clocks. No single Linux clock optimizes every property.

`CLOCK_REALTIME` represents system wall time. Administrators and time-synchronization software can adjust it, including by a discontinuous step. It has a civil-time epoch conventionally related to UTC, subject to system timekeeping and leap-second policy. Use it for externally meaningful timestamps only when its synchronization state is monitored.

`CLOCK_MONOTONIC` measures time from an unspecified starting point and is not set by wall-clock changes. Linux may discipline its frequency, so it is monotonic but not a raw oscillator. It normally excludes suspended time. “Monotonic” means it does not run backward; consecutive reads can still be equal at the clock's effective resolution.

`CLOCK_MONOTONIC_RAW` exposes a less-disciplined hardware-based timescale on Linux. It is useful for observing oscillator behavior and selected measurements where NTP/PTP frequency correction should not affect the interval. It is not synchronized to UTC and does not by itself support correlation with another host.

`CLOCK_BOOTTIME` resembles monotonic time but includes time spent suspended. It suits lease or watchdog semantics that must expire across suspend. A server that never suspends can still use it, but its semantic distinction should be deliberate.

| Clock | External epoch | Can wall-time step affect value? | Frequency disciplined | Includes suspend |
|---|---|---|---|---|
| `CLOCK_REALTIME` | Wall/UTC-related | Yes | Commonly | Yes |
| `CLOCK_MONOTONIC` | Unspecified | No backward wall step | Commonly | No |
| `CLOCK_MONOTONIC_RAW` | Unspecified | No | Normally no NTP discipline | No |
| `CLOCK_BOOTTIME` | Unspecified | No backward wall step | Kernel-defined relation | Yes |

These are Linux semantics; exact clock-source and implementation choices depend on kernel and platform. Query advertised resolution with `clock_getres`, but do not confuse it with accuracy, precision, or call cost.

Linux chooses a system clocksource from hardware/platform candidates and maintains conversion parameters. A stable invariant counter can support efficient reads; another platform may need a more expensive mechanism. Virtual machines can expose paravirtual clocks whose relationship to host migration and suspend is hypervisor-defined. Record clocksource and virtualization when comparing measurements.

```cpp
#include <cerrno>
#include <cstdint>
#include <system_error>
#include <time.h>

std::int64_t monotonic_nanoseconds() {
    timespec ts{};
    if (::clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
        throw std::system_error(errno, std::generic_category());
    }
    return std::int64_t{ts.tv_sec} * 1'000'000'000 + ts.tv_nsec;
}
```

Linux commonly serves several clock reads through the vDSO without a syscall, using kernel-maintained conversion data and a hardware counter. That is an implementation optimization, not a C++ or POSIX cost guarantee. A fallback syscall, seqlock retry during an update, cache misses, and counter serialization can change latency. Benchmark the exact clock on the target and keep error handling outside the critical path when the operating contract makes failure fatal.

Conversion to a signed nanosecond count can overflow for large epochs or durations even when `timespec` itself is valid. Checked arithmetic or a structured seconds/nanoseconds representation is safer at long-lived storage boundaries. Normalize negative timestamps carefully; not every domain is guaranteed to begin after the application's epoch.

## 33.2 C++20 Calendar and Time-Zone Facilities

`std::chrono` separates durations, time points, clocks, calendars, and time zones. C++20 added calendar types and a time-zone database interface, allowing civil-time conversion without treating local time as arithmetic on seconds.

`std::chrono::system_clock` is the standard wall-clock interface. C++ does not require it to map to Linux `CLOCK_REALTIME`, though mainstream Linux implementations commonly do. `std::chrono::steady_clock` promises that `is_steady` is true and time points never decrease; its Linux mapping is an implementation choice, commonly based on a monotonic clock.

```cpp
#include <chrono>

using namespace std::chrono;

steady_clock::duration elapsed(steady_clock::time_point start,
                               steady_clock::time_point finish) {
    return finish - start;
}

sys_days trading_day(int year, unsigned month, unsigned day) {
    return sys_days{std::chrono::year{year} /
                    std::chrono::month{month} /
                    std::chrono::day{day}};
}
```

Use a steady clock for process-local intervals. Use system-clock or explicitly converted UTC/PTP-domain values for cross-process, cross-host, or audit timestamps. Subtracting time points from unrelated clocks is not defined by `std::chrono`; an explicit measured conversion is required.

Calendar types such as `year_month_day` express dates. Time zones map between `sys_time` and `local_time` using a rules database. A local civil time can be ambiguous when clocks move backward or nonexistent when clocks move forward. The API exposes choices for these cases; silent assumptions are dangerous in session scheduling.

```cpp
// Excerpt: run during configuration, not per packet.
const std::chrono::time_zone* zone = std::chrono::locate_zone("Asia/Singapore");
std::chrono::zoned_time local{zone, std::chrono::system_clock::now()};
```

Time-zone database support and update mechanisms vary among C++ standard libraries. Loading or locating zone data can lock, allocate, perform file I/O, or throw. Convert trading-session boundaries during configuration and store steady/system time points needed by the hot path. Do not perform locale or zone lookup per market-data message.

C++20 also specifies `utc_clock`, `tai_clock`, `gps_clock`, and leap-second facilities, but library availability has historically lagged core calendar support. Feature-test the implementation. More importantly, name the operational time scale: a PHC following PTP time and a system clock following UTC may differ by an integral offset even when both are correctly synchronized.

Formatting timestamps is separate work. It can allocate, consult locale/time-zone state, and expand code. Store a compact numeric time point with clock-domain metadata in the event path and format it asynchronously.

Leap seconds expose a time-scale distinction. POSIX-style system time, UTC-aware chrono facilities, TAI, PTP time, and a deployment's smear policy can map the inserted second differently. Two hosts following different policies can disagree transiently while each daemon reports healthy. Record the announced time properties and test the actual leap policy before it becomes operationally relevant.

Time-zone rules are versioned external data. Recomputing a past local timestamp with a newer database can produce different descriptive output when jurisdictions revise rules. Audit records should retain an unambiguous system/UTC time and, when civil rendering matters, the zone name and database/version policy used for presentation.

## 33.3 Clock Steps, Slewing, Drift, and Asymmetry

**Offset** is the time difference between two clocks at an instant. **Frequency error** is their rate difference. **Drift** describes how those quantities change, often because of oscillator characteristics, temperature, aging, or servo behavior.

If a local oscillator is fast by one part per million, its uncorrected clock gains about one microsecond per second. Holdover error therefore grows with time since the last trustworthy reference, but not necessarily at a constant rate. Temperature changes and oscillator quality matter.

A **step** changes a clock's phase discontinuously. It corrects a large error quickly but can make `CLOCK_REALTIME` jump forward or backward. A **slew** changes frequency temporarily so the offset converges gradually. Slewing avoids a discontinuity but leaves a nonzero offset during correction and changes measured wall-clock intervals.

Use a monotonic clock for timeout deadlines so a wall-clock step does not expire everything or extend a timeout unexpectedly. Use absolute wall time for records that must correlate with external systems, but attach synchronization health and detect steps.

```cpp
// Excerpt: compare domains to detect a realtime discontinuity.
struct ClockPair {
    std::chrono::system_clock::time_point realtime;
    std::chrono::steady_clock::time_point monotonic;
};

// If delta(realtime) - delta(monotonic) changes abruptly, investigate a step
// or a substantial discipline event. Sampling is not simultaneous.
```

Sampling two clocks sequentially introduces an uncertainty interval equal to the time between reads plus scheduling and execution variation. Bracket a target clock read between two reference-clock reads to bound the conversion error, and retain the narrowest sample among several attempts when appropriate.

Two-way synchronization estimates path delay by assuming some symmetry. If forward and reverse delay differ by (A), the inferred offset can be biased by roughly (A/2) in the elementary model. No servo can infer unknown persistent asymmetry from the same four timestamps alone. Different fibers, switches, queues, packet priorities, or routes can therefore create a stable-looking but wrong clock.

Clock quality and read cost are orthogonal:

- a raw cycle counter can be cheap and unsynchronized;
- `CLOCK_REALTIME` can be well disciplined but subject to steps;
- a PHC can be close to the wire but costly to read over a device path;
- a converted PHC timestamp can be precise yet wrong if the domain offset is stale.

Monitor both dimensions. Timing benchmarks establish read overhead and variance. Synchronization telemetry establishes offset, frequency correction, path delay, state, and reference health.

A servo is a feedback controller. Aggressive gains can converge quickly but amplify timestamp noise; conservative gains converge slowly and leave more startup error. Production states commonly include initial acquisition, locked/steady operation, holdover, and recovery. Alerting should not apply the same offset threshold and timeout to every state.

Clock correction can affect timeout rate without causing discontinuity. If a process compares a disciplined monotonic clock over a long interval, the result follows that clock's adjusted frequency. For most timeouts this is desirable because it tracks system timekeeping, but oscillator characterization should compare against raw or an independent reference.

Monotonic ordering alone cannot order events from different cores, processes, or hosts causally. On one Linux host, the kernel clock interface aims to provide a coherent clock across CPUs, subject to platform support, but two reads can still be too close to distinguish. Across hosts, synchronization uncertainty dominates. Sequence numbers and message causality remain necessary.

## 33.4 NTP Offset, Delay, Strata, and Holdover

The Network Time Protocol estimates clock offset and round-trip delay using timestamped exchanges. In the elementary four-timestamp model, the client sends at (t_1), the server receives at (t_2), the server sends at (t_3), and the client receives at (t_4).

```text
client                         server
t1  -------- request --------> t2
t4  <------- response --------- t3
```

Under the symmetric-path assumption:

```text
round-trip delay = (t4 - t1) - (t3 - t2)
offset estimate  = ((t2 - t1) + (t3 - t4)) / 2
```

Implementations apply filtering, selection, sanity checks, and a clock discipline beyond these equations. NTP is not merely “set the clock from one packet.” Multiple samples and sources help reject delay outliers and faulty servers.

The four timestamps must be interpreted in their sender's clock domains. The equations estimate both delay and the transformation between those domains under their assumptions. Timestamping closer to packet transmission and reception reduces software variation, but ordinary NTP deployments often rely on kernel or software points and variable routed paths.

**Stratum** describes distance in the NTP reference hierarchy. A stratum-1 server is directly attached to a reference source; a stratum-2 server synchronizes from higher-quality upstream servers. Lower stratum does not prove lower current offset, lower network delay, or a better oscillator. Selection uses more information than the number.

NTP can discipline phase and frequency. During source loss, the system enters **holdover**, advancing from its local oscillator and learned frequency estimate. Holdover quality depends on oscillator stability, temperature, elapsed time, and prior calibration. “Synchronized five minutes ago” is not a sufficient health metric.

NTP over a variable routed network can provide excellent general-purpose wall time, but unknown asymmetry and software timestamp location usually make it insufficient by itself for the tightest exchange timestamp requirements. This is a use-case statement, not a universal accuracy number. Measure offset against the required bound in the actual topology.

Production monitoring should include selected source, reachability, root distance or equivalent error estimate, offset, delay, frequency correction, jitter, last update, leap status, and whether the daemon stepped the clock. Daemon-specific tools differ—for example, chrony and ntpd expose different commands and metrics—so operational runbooks must name the installed implementation.

Source diversity must be real. Several servers behind one receiver, one upstream grandmaster, or one network path can fail together. A majority algorithm cannot detect a common-mode error shared by every source. Where audit correctness is critical, compare the disciplined clock with an independent technology or administrative domain.

NTP packets and management interfaces are security surfaces. Authenticate or constrain sources according to the deployment, prevent an arbitrary network peer from becoming the trusted clock, and retain multiple independent monitors. A compromised but internally consistent time source can damage audit ordering without causing obvious application failure.

Test source failure explicitly. Block the selected source, introduce delay variation, restart the daemon, and observe transition to holdover and recovery in a lab. Verify whether recovery slews or steps at the configured threshold and whether the application records that event. Never inject these faults into the production timing network without an approved exercise.

## 33.5 PTP Clocks and Message Exchange

The Precision Time Protocol, standardized by IEEE 1588, distributes time over a network with explicit clock roles and timestamped event messages. Hardware timestamping and PTP-aware network devices can reduce variable software and queueing delay from the timing measurement.

A **grandmaster** is the selected root clock for a PTP domain. An **ordinary clock** has one PTP port and can be a source or client. A **boundary clock** terminates synchronization on one port and serves time on others, running a clock for the boundary. A **transparent clock** forwards PTP traffic while adding measured residence-time information to a correction field.

Role selection commonly uses the Best Master Clock Algorithm and configured priorities and clock-quality data. Operational profiles can constrain transport, intervals, delay mechanism, domains, and role behavior. Two devices both supporting “PTP” are not necessarily interoperable until their profile and transport settings match.

In an end-to-end delay exchange, Sync conveys master time, Follow_Up may provide a precise origin timestamp, Delay_Req travels from client to master, and Delay_Resp reports the master's receive time. A simplified two-step flow is:

```text
master                         client
       ------ Sync ---------->
       ------ Follow_Up ----->
       <----- Delay_Req -------
       ------ Delay_Resp ---->
```

The client combines timestamps and correction fields to estimate master offset and path delay. Peer-to-peer delay uses peer-delay messages on each link instead of the end-to-end request/response model. All devices on the relevant path and profile must agree on the mechanism.

PTP event messages benefit most from precise ingress and egress timestamps. General messages such as Follow_Up carry information but are not necessarily timestamped at the same hardware point. Switch queueing between an upstream timestamp point and the wire introduces variation unless the topology compensates for it.

Residence-time correction and path-delay estimates use finite-width protocol fields and scaled units defined by the PTP profile/standard. Applications should rely on a conforming stack rather than reimplementing arithmetic casually. Packet captures are useful for consistency checks but do not replace servo telemetry or independent clock comparison.

A boundary clock can prevent variable residence in one segment from directly entering another segment's delay measurement. A transparent clock measures and reports residence correction. Neither fixes an asymmetric physical path automatically, and both depend on correct hardware, profile, and calibration.

PTP traffic is typically low bandwidth, but servo behavior is sensitive to delayed, missing, or misclassified messages. QoS can reduce queue variation, while an incorrect priority configuration can starve other control traffic or create asymmetry. Validate PTP under the same load and switch configuration as production.

PTP domains allow multiple timing systems on one network. Domain number is not a security boundary, and selecting the wrong but valid grandmaster can yield internally consistent incorrect time. Monitor grandmaster identity, clock class, priority, steps removed, and port state, and alarm on unplanned topology changes.

Transport can be Ethernet or UDP over IPv4/IPv6 according to profile and configuration. Multicast and unicast modes exercise different switch, ACL, and queue paths. A firewall rule that passes Sync but blocks delay messages creates a failure different from total packet loss, so test message types and directions explicitly.

## 33.6 One-Step and Two-Step Operation

In **one-step** PTP, the transmitting device inserts or accounts for the precise egress timestamp in the Sync message as it leaves. In **two-step** PTP, the sender transmits Sync and later sends a Follow_Up containing the precise origin timestamp.

One-step operation needs hardware capable of modifying the packet or correction information at the timestamp point while maintaining checksums and protocol semantics. Two-step operation separates timestamp capture from the original packet and works naturally when the exact value becomes available only after transmission.

```text
one-step:  timestamp -> modify Sync on transmit -> wire

two-step:  Sync -> wire
           hardware reports timestamp -> Follow_Up(timestamp) -> wire
```

Two-step adds another message and matching state. The client must associate Follow_Up with the correct Sync sequence and handle loss, duplication, or reordering. One-step adds hardware/path constraints and can complicate capture interpretation because a capture taken before final hardware modification may not show the on-wire correction.

One-step is not universally “more accurate” or “lower latency.” Accuracy depends on the actual timestamp point, calibration, PHY/MAC behavior, transparent clocks, and path asymmetry. Two-step hardware timestamping can be highly precise. The messages synchronize clocks; their own delivery latency is not the same metric as the final clock offset.

NICs, switches, and linuxptp configurations support different modes. Confirm `ethtool -T`, device documentation, driver behavior, and PTP profile. A silent fallback from hardware to software timestamping changes the error model even if synchronization continues.

Mixed one-step and two-step paths can be valid only when the profile and devices support the combination and correction rules. Inventory each port rather than assigning one mode to an entire site. Firmware upgrades can change advertised or actual behavior, so timestamp-mode validation belongs in qualification testing.

Verify sequence matching and correction fields with a PTP-aware capture point, but remember that capture location matters. Compare servo-reported offset and an independent measurement across both normal load and congestion. Protocol correctness without clock-quality verification is incomplete.

Capture tools can display a two-step Follow_Up accurately while missing the final one-step on-wire modification if capture occurs above the hardware point. Conversely, an external tap sees the final frame but needs its own calibrated clock for absolute timing. Use both when diagnosing a disagreement.

## 33.7 Hardware and Software Timestamping

A **software timestamp** is captured by software at a defined kernel or application point. A **hardware timestamp** is captured by a NIC, PHY, or switch timestamp unit closer to packet ingress or egress. The closer point removes more variable host processing from the measured interval, but only if its clock is correctly synchronized and the timestamp location is understood.

Application timestamps around `send` and `recvmsg` include userspace scheduling and syscall placement. Linux receive software timestamps are commonly generated near entry to the kernel networking stack after the driver hands over a packet. Transmit software timestamps can mark a later kernel/driver point before interface transmission. They do not include all NIC queueing and serialization.

Hardware receive timestamps are attached by supported device/driver paths. Hardware transmit timestamps are asynchronous: the application sends a packet, the device reports a timestamp later, and Linux returns it through the socket error queue. The application must drain that queue and associate results with sends.

Linux `SO_TIMESTAMPING` uses flags to request timestamp generation and reporting. Requests can include receive or transmit, software or hardware, and other path points supported by the kernel. Reporting uses ancillary messages from `recvmsg`. The UAPI has old and new time representations; contemporary code should use the new interfaces where available to avoid 32-bit time limitations.

```cpp
// Excerpt: error checks and portability guards omitted for focus.
int flags = SOF_TIMESTAMPING_RX_HARDWARE |
            SOF_TIMESTAMPING_RX_SOFTWARE |
            SOF_TIMESTAMPING_SOFTWARE |
            SOF_TIMESTAMPING_RAW_HARDWARE;

setsockopt(fd, SOL_SOCKET, SO_TIMESTAMPING, &flags, sizeof(flags));

// recvmsg() must provide a sufficiently large, aligned msg_control buffer.
// Iterate CMSG_FIRSTHDR/CMSG_NXTHDR and validate cmsg_level, cmsg_type,
// and cmsg_len before reading SCM_TIMESTAMPING payload data.
```

Device timestamping must also be configured through the supported ethtool netlink interface or legacy ioctl path. Drivers may broaden a requested receive filter when exact filtering is unsupported. Capability output is not proof that the requested mode became active for this packet.

Ancillary data consumes buffer space and parsing work. A control buffer that is too small sets truncation indicators and loses metadata. Transmit timestamps add error-queue traffic and outstanding-request state. Sampling only selected packets can bound overhead, but toggling socket options per packet is itself work; Linux also supports per-send timestamp requests in appropriate configurations.

Size receive and error queues for the maximum number of outstanding timestamped packets, then define overflow behavior. A transmit timestamp arriving after the application has reused an identifier can be misassociated unless wrap and lifetime are handled. Linux timestamp IDs assist association but do not replace application generation tracking for long-lived high-rate sockets.

Measure the timestamp feature enabled and disabled under equal traffic. Count syscalls or `recvmsg` calls, ancillary bytes, error-queue backlog, CPU cycles, cache misses, and missing timestamps. A hardware feature can improve capture precision while increasing host completion work; those are compatible results.

Timestamp resolution describes representation granularity, not accuracy. A nanosecond field can contain a timestamp uncertain by much more than one nanosecond. Accuracy requires a synchronized clock, calibrated timestamp point, bounded asymmetry, and monitored health.

Software receive timestamps belong to packets, not necessarily to individual application messages. One UDP datagram maps naturally to one packet event, while TCP presents a byte stream that can combine or split writes. Timestamp options for streams have additional association semantics. Define whether the application needs packet arrival, first-byte availability, complete-frame parsing, or strategy-consumption time.

Control-message parsing is a bounds problem. Initialize `msghdr`, preserve alignment using a suitable byte/control buffer, check `MSG_CTRUNC`, and walk all ancillary records. Copy timestamp payloads into aligned application objects rather than retaining pointers into a reused receive buffer. Ownership ends when that buffer is reused.

## 33.8 PHCs, System Clocks, and Cross-Timestamping

A **PTP hardware clock** (PHC) is a device clock exposed by Linux, commonly as `/dev/ptpN`. A NIC's hardware packet timestamps are normally in its PHC domain. `CLOCK_REALTIME` belongs to the system clock domain. Equal numeric units do not make the domains interchangeable.

`ptp4l` commonly synchronizes a NIC PHC to the PTP domain. `phc2sys` commonly synchronizes the system clock from a selected PHC or manages another configured clock relationship. The direction depends on whether the host is a PTP client, a grandmaster, or part of a more complex boundary-clock design.

```text
grandmaster/network
        |
      ptp4l
        v
      NIC PHC  ---- phc2sys ----> system CLOCK_REALTIME
        |
hardware packet timestamps
```

In hardware-timestamping mode, linuxptp commonly treats the PHC as following the PTP time scale while the system clock follows UTC. Their expected difference includes the current UTC/PTP offset. A whole-second error can result from configuring the direction or offset incorrectly even when the servo reports a small residual.

Cross-timestamping estimates the relationship between a PHC and a system clock. A simple userspace method reads system–PHC–system and uses the midpoint of the system bracket. Its uncertainty is at least related to bracket width and asymmetry in the reads. Linux PHC ioctls can provide multiple or more precise cross-timestamp samples when supported, including system-device cross timestamps backed by driver/hardware features.

Keep conversion as an affine model over a validity interval:

```text
system_time ~= offset + rate * phc_time
```

Offset alone is insufficient when the clocks have residual frequency difference. Refit or discipline the relationship, record its sample time and uncertainty, and invalidate it across a step or device reset.

Reading a PHC through a device operation can cost more and vary more than reading a vDSO-backed system clock. That does not make the PHC inferior for packet timestamps captured in hardware. Use hardware-attached PHC values for event precision, then convert off the critical path when possible.

Cross-timestamp samples should be filtered by uncertainty, not merely averaged. A sample interrupted between bracket reads has a wide interval and contributes little. Repeatedly choosing only the narrowest bracket can reduce read-path noise, but it cannot reveal fixed device-access asymmetry or a wrong time-scale offset.

PHC device numbering is not a stable business identifier. Map network interface to PHC using supported tooling/sysfs/ethtool information and monitor device resets, driver reloads, bond failover, and hotplug. A failover can change the active timestamp provider and clock domain.

Some interfaces share one PHC; others expose separate PHCs. A multiport boundary clock with independent unsynchronized PHCs needs an explicit synchronization design, sometimes using external PPS or a tool such as `ts2phc`. Do not infer a shared clock merely because ports are on one adapter.

PHC adjustment and read permissions should follow least privilege. A trading process usually needs timestamps, not authority to discipline the device. Separate ownership also prevents an application restart from resetting a clock that other processes use.

## 33.9 `ptp4l`, `phc2sys`, `ethtool -T`, and Socket APIs

Linux PTP tooling separates capability discovery, network synchronization, clock synchronization, and application timestamp consumption.

```sh
# Read-only capability discovery.
ethtool -T eth0
readlink /sys/class/net/eth0/device/ptp/ptp*
ls -l /dev/ptp*
```

Topology and sysfs paths vary; virtual, bonded, and DSA devices need specific interpretation. `ethtool -T` reports device timestamp capabilities and associated PHC information where supported. It does not prove current synchronization or per-packet delivery.

```sh
# Examples only. Run from a reviewed linuxptp configuration.
ptp4l -i eth0 -m
phc2sys -a -r -m
```

`ptp4l` can operate ordinary, boundary, and transparent clock roles depending on configuration and capabilities. Hardware timestamping is commonly its default mode; `-S` selects software timestamping in versions documented by linuxptp. `phc2sys -a` discovers clocks from `ptp4l`; `-r` includes the system realtime clock. Exact role, direction, time-scale offset, transport, domain, and delay mechanism must come from a reviewed configuration, not these minimal commands.

Changing a system clock requires powerful authority such as `CAP_SYS_TIME`. Configuring NIC hardware timestamping or interfaces commonly needs network administrative privileges. Opening PHC devices depends on permissions. These capabilities can affect the entire host and audit timeline. Do not grant them broadly to the trading process; use a small managed synchronization service and read-only telemetry where possible.

The `pmc` tool can query and manage PTP data sets through linuxptp's management interface. Monitoring can inspect port state, grandmaster identity, time properties, and offset-related data. Protect management sockets and distinguish desired grandmaster changes from accidental source changes.

Configuration files deserve the same review as code. linuxptp tools share option names, but using one file for multiple daemons can apply a nondefault value where it was not intended. Keep role-specific files, pin their versions, validate them in a lab, and log effective startup options.

Socket timestamping requires three layers to agree:

1. device/driver hardware timestamp configuration;
2. socket generation and reporting flags;
3. correct `recvmsg` ancillary/error-queue handling.

For transmit timestamps, use `MSG_ERRQUEUE` and handle asynchronous arrival, queue overflow, and reordering. Linux options such as timestamp IDs can help associate outstanding requests; exact semantics differ for datagram and stream sockets. For receive timestamps, parse each control message by length and type. Never assume the first ancillary item is the desired timestamp.

Operational logs should state selected interface, PHC, timestamp mode, domain, port state, master identity, and servo status. A daemon process being alive is not evidence of synchronization.

A validation run should compare `ethtool -T` capability, effective hardware filter configuration, `ptp4l` port/servo state, `phc2sys` offset, socket-delivered timestamp type, and an independent clock observation. If only software timestamp fields are nonzero, report fallback explicitly rather than labeling the sample “hardware timestamped.”

Do not raise PTP worker threads to aggressive real-time priority as a reflex. Driver timestamp delivery can suffer if workers are starved, but an overly privileged FIFO thread can starve the host and make recovery impossible. Measure scheduling delay, use bounded priorities under an operational policy, and retain watchdog and rollback mechanisms.

## 33.10 Timestamping Near the Wire

A timestamp's **capture point** determines which delays it includes. Moving the point closer to the wire removes variable software, queueing, and scheduling stages from one side of the measured interval.

```text
TX application timestamp
    |
send syscall
    |
TX scheduler timestamp
    |
qdisc -- driver -- NIC queue
                     |
              hardware TX timestamp
                     |
                  serialize
                     v
                    wire
```

On receive, a hardware timestamp can be taken at a MAC or PHY-related point before driver and kernel processing. The exact point, ingress/egress correction, and calibration are device-specific. A switch timestamp might be closer to an exchange-facing port than a server NIC timestamp but lives in another clock domain.

Subtracting application send time from hardware transmit time estimates host-side residence only after clock-domain conversion. Linux can expose scheduler, software, completion, and hardware transmit timestamp points in supported configurations. Each answers a different question: protocol processing, qdisc/driver delay, completion notification, or physical-near transmit.

Wire serialization still matters. A timestamp can refer to start-of-frame, a defined symbol point, or another hardware event. Two devices using different conventions need correction before their values are compared. PHY propagation, cable length, transceiver delay, and ingress versus egress calibration can create a fixed bias.

Hardware timestamping reduces variable host latency in the observation; it does not eliminate network asymmetry or make the application faster. Requesting timestamps can add device work, completion handling, error-queue traffic, and cache pressure. Sample if every-packet evidence is unnecessary, but ensure sampled events represent bursts and recovery periods.

For one-way latency, sender and receiver clocks must share a bounded relationship. A precise timestamp at each endpoint is insufficient if their offset uncertainty exceeds the latency being measured. Report latency together with synchronization uncertainty and capture-point definitions.

The appropriate timestamp can differ by question. Exchange audit may require UTC-related hardware ingress. Feed-handler performance may use hardware ingress to application completion. Strategy computation may use one steady clock at start and finish. Order egress attribution may retain application intent, kernel scheduler, and hardware transmit points rather than collapsing them into one number.

Use an external tap or calibrated test instrument when validating the absolute timestamp point. Software captures on the measured host are useful for sequence and protocol evidence but share clocks and processing with the system under test.

Calibration values can be directional and speed-dependent. Changing link speed, transceiver, cable path, firmware, or port can change fixed ingress/egress delay. Treat calibration as configuration tied to hardware identity and revalidate it after maintenance.

## 33.11 Clock-Domain Conversion and Monitoring

A clock-domain conversion is a measured model, not a cast between integer types. Every converted timestamp should retain or imply source clock, target clock, conversion version, validity interval, and uncertainty.

A practical conversion service can maintain offset and rate from repeated cross-timestamps. Readers take an immutable snapshot containing coefficients and an epoch/version. A clock step, PHC reset, master change, or residual threshold creates a new epoch. Events on opposite sides of an unmodeled step must not be ordered by naïvely comparing converted numbers.

Publish transforms with ordinary concurrency discipline. A reader must not observe a new rate with an old anchor or uncertainty. A small immutable structure can be copied under a sequence counter or published through an atomic pointer with safe reclamation. Conversion belongs off the packet-critical path when the application can retain raw timestamps and a transform version.

```cpp
#include <cstdint>

struct ClockTransform {
    std::int64_t source_anchor_ns;
    std::int64_t target_anchor_ns;
    double rate_ratio;
    std::uint64_t version;
    std::int64_t uncertainty_ns;
};

// Excerpt: production code needs checked arithmetic and a bounded source delta.
std::int64_t convert(std::int64_t source_ns, const ClockTransform& t) {
    const auto delta = static_cast<double>(source_ns - t.source_anchor_ns);
    return t.target_anchor_ns + static_cast<std::int64_t>(delta * t.rate_ratio);
}
```

Floating-point conversion can lose integer precision for large epochs. A production implementation can use fixed-point rate correction, wide integer intermediates, or keep deltas small by refreshing anchors. It must define rounding and overflow behavior. The example emphasizes model fields, not a recommended numeric implementation.

Monitor at least:

- current and maximum observed offset;
- frequency correction and its rate of change;
- path delay and asymmetry indicators;
- servo state and time since synchronization;
- selected grandmaster/source identity and changes;
- PTP port state and message loss;
- clock steps, leap status, and UTC/PTP offset;
- PHC/device resets and timestamp timeouts;
- cross-timestamp bracket or uncertainty;
- timestamp request, delivery, truncation, and error-queue loss.

Alert thresholds come from system requirements and measured noise, not copied universal numbers. Use separate thresholds for startup acquisition, steady state, holdover, and recovery. A servo can report a low current offset immediately before source loss; time since last valid update reveals the risk.

Metrics themselves need clock-safe semantics. Timestamp the sample in both a monotonic domain for age and an external domain for correlation. Export current value, worst value over a defined interval, and state transitions. Averages can hide a single clock step that invalidates an entire latency trace.

On loss of trustworthy synchronization, choose an explicit application policy: continue with a degraded-time flag, reject externally timestamped actions, fail over to another source, or stop a component. The clock service should not silently claim precision it no longer has. The correct policy depends on regulatory and trading-system requirements.

Clock reads also need performance monitoring. Benchmark distributions for `steady_clock`, `clock_gettime` variants, PHC reads, and ancillary parsing on the target. Confirm whether vDSO or syscalls are used, and test during discipline updates. Do not weaken synchronization to reduce a timestamp call until the event's correctness requirement is reconsidered.

Subtract benchmark-loop overhead carefully. Read the clock many times, retain results so the compiler cannot remove work, and inspect deltas for zero values, outliers, and backward movement. Pinning can reduce scheduler noise but does not represent every production thread. Report compiler, kernel, clocksource, CPU power policy, vDSO status, and whether the synchronization daemon was active.

PHC-read benchmarks need a different design from system-clock reads because device access and driver serialization may dominate. Benchmark both direct reads and packet-attached timestamps. The latter measures delivery and parsing work as well as timestamp capture, which is often the application-relevant cost.

Cross-system correlation should include sequence IDs and causal protocol evidence, not timestamps alone. If two events differ by less than combined clock uncertainty, their temporal order is unknown. A correct analysis says so rather than inventing precision from nanosecond-formatted fields.

Persist raw source timestamps when storage permits. Reprocessing with improved calibration can correct a transform error, while storing only rounded converted time destroys that evidence. Retain enough metadata to distinguish a late packet from a clock correction, including receive sequence, source identity, and conversion epoch.

Finally, define units and epoch in every public schema. A bare `int64 timestamp` invites seconds-versus-nanoseconds and UTC-versus-TAI mistakes. Use a named field, scale, clock domain, and validity flags, and version the schema when those semantics change.

Conversion uncertainty should travel with derived latency. If two endpoint timestamps each have an error bound and the path calibration has another, combine them according to the validated error model and publish the bound beside the result. Never discard uncertainty merely because downstream storage accepts only one numeric duration.

The displayed precision must never exceed the evidence supporting that bound.

Report that limitation explicitly during review.

## 33.12 Interview Check

1. Compare `CLOCK_REALTIME`, `CLOCK_MONOTONIC`, `CLOCK_MONOTONIC_RAW`, and `CLOCK_BOOTTIME` for epoch, adjustment, suspend behavior, and appropriate trading-system use.
2. Why can a nanosecond-resolution clock be inaccurate, and why can a well-synchronized clock still be expensive to read?
3. Derive the elementary NTP offset and round-trip-delay equations from four timestamps. How does persistent path asymmetry bias the offset estimate?
4. Compare clock stepping and slewing. Which clock should drive timeout deadlines, and how would an application detect a realtime step?
5. Draw a two-step PTP exchange and explain the roles of ordinary, boundary, transparent, and grandmaster clocks.
6. Compare one-step and two-step PTP without assuming that one is universally more accurate. What hardware and verification facts decide the result?
7. Trace application, software, scheduler, completion, and hardware transmit timestamps. Which queueing intervals can each expose or omit?
8. A NIC reports hardware timestamp support, but the application receives no transmit timestamps. Check the device configuration, socket flags, error queue, ancillary buffer, driver counters, and privileges.
9. Explain why a PHC timestamp cannot be subtracted directly from a `CLOCK_REALTIME` value. Design a conversion record that remains diagnosable across clock steps and master changes.
10. Define the monitoring evidence required to declare a host synchronized during steady state and holdover. Include offset, frequency, source identity, servo state, last update, and uncertainty.
