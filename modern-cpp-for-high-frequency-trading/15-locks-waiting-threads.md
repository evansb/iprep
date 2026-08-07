# Chapter 15 — Locks, Waiting, and Threads

Concurrency primitives do not make contention disappear; they decide who may proceed, how a blocked thread becomes runnable, and which memory effects become visible. The common mistake is to judge a mutex or wait operation by its uncontended instruction path while ignoring scheduler delays, cache-line transfers, and cancellation or lifetime rules. This chapter establishes the contracts of the standard C++ primitives, relates common implementations to Linux futexes, and shows how to choose a waiting strategy whose tail behavior matches the system.

## 15.1 Mutex Families and Their Contracts

A **mutex** grants one thread exclusive ownership of a protected region. C++ defines the synchronization contract, not the representation or the algorithm inside the mutex. If thread A unlocks a mutex and thread B later locks the same mutex, A's unlock synchronizes with B's successful lock. The non-atomic state protected by the mutex can therefore be read safely by B.

```cpp
#include <cstdint>
#include <mutex>

struct Position {
    std::mutex mutex;
    std::int64_t quantity{};
    std::int64_t notional_ticks{};
};

void apply_fill(Position& p, std::int64_t quantity,
                std::int64_t price_ticks) {
    std::lock_guard lock{p.mutex};
    p.quantity += quantity;
    p.notional_ticks += quantity * price_ticks; // check overflow in production
}
```

The mutex covers an invariant, not merely individual fields. Using separate mutexes for `quantity` and `notional_ticks` would allow a reader to observe half of a fill. A good lock boundary is the smallest boundary that preserves the required state transition.

The standard mutex families differ in their contracts:

| Type | Ownership | Special capability | Principal risk |
|---|---|---|---|
| `std::mutex` | One writer | Basic mutual exclusion | Unspecified fairness |
| `std::recursive_mutex` | Reentrant owner | Same thread may lock repeatedly | Conceals tangled invariants |
| `std::timed_mutex` | One writer | Timed lock attempts | Clock and scheduling make timeout imprecise |
| `std::shared_mutex` | Many readers or one writer | Shared/exclusive modes | Reader or writer starvation is permitted |
| `std::shared_timed_mutex` | Many readers or one writer | Shared/exclusive timed attempts | More state and more complex contention |

Calling `lock()` twice on a nonrecursive mutex from the same thread is not a portable way to wait: for `std::mutex`, the behavior is undefined. A recursive mutex records an owner and recursion count in a common implementation, increasing state and work. More importantly, it makes it easy for an outer operation to expose an invariant to an inner call at the wrong point. Refactoring the class into public locking functions and private `*_unlocked` functions is usually clearer.

`std::shared_mutex` is attractive for read-mostly data, but the name does not promise low cost. Every reader still modifies coordination state in typical implementations. That state can become a contended cache line, and a stream of readers can delay a writer depending on the implementation's admission policy. An immutable snapshot published atomically may be a better design when reads dominate and slightly stale data is acceptable.

A common Linux C++ library implements an uncontended `std::mutex` lock with an atomic transition in user space and uses a futex-backed slow path under contention. This is an implementation model, not a C++ requirement. Even the fast path needs write ownership of the mutex's cache line. The slow path may enter the kernel, enqueue a waiter, sleep, wake, compete to run, and reacquire the cache line. That bimodal behavior is why an average uncontended benchmark says little about production tails.

Keep hot data separate from the mutex where practical. A mutex embedded beside fields read by another core can cause those fields to share the coordination line. Check sizes and offsets on each target library rather than assuming a mutex is one word:

```cpp
#include <iostream>
#include <mutex>

int main() {
    std::cout << "mutex size=" << sizeof(std::mutex)
              << " alignment=" << alignof(std::mutex) << '\n';
}
```

The relevant question is not “Are mutexes slow?” It is “How often is this mutex contended, how long is it held, what runs while it is held, and what happens to a delayed owner?”

## 15.2 RAII Lock Wrappers

An **RAII lock wrapper** acquires ownership as part of object construction and releases it during destruction. It makes every normal return and exception path obey the lock lifetime. C++11 introduced `std::lock_guard` and `std::unique_lock`; C++17 added `std::scoped_lock`; shared ownership uses `std::shared_lock`.

Use `std::lock_guard` for one mutex and one lexical scope:

```cpp
void reset(Position& p) {
    std::lock_guard guard{p.mutex};
    p.quantity = 0;
    p.notional_ticks = 0;
}
```

The wrapper normally stores only a reference or pointer to the mutex, and the compiler can inline the constructor and destructor. RAII is not an extra runtime locking layer. It expresses cleanup so the compiler and reviewer can see it.

`std::unique_lock` owns more state. It supports deferred locking, timed locking, manual unlock/relock, transfer by move, and integration with condition variables. That flexibility is essential when protected work must be separated from slow work:

```cpp
#include <mutex>
#include <utility>
#include <vector>

struct BatchQueue {
    std::mutex mutex;
    std::vector<int> pending;
};

std::vector<int> take_batch(BatchQueue& q) {
    std::unique_lock lock{q.mutex};
    std::vector<int> result;
    result.swap(q.pending);          // bounded lock-held work if capacity is reused
    lock.unlock();                   // make the boundary explicit
    return result;                   // processing happens in the caller
}
```

Manual unlock inside an RAII object is safe only if the ownership state remains obvious. Do not pass the wrapper through many layers or mix direct `mutex.unlock()` with a wrapper that still believes it owns the mutex; the eventual double unlock is erroneous.

`std::scoped_lock` locks one or more mutexes and releases them in reverse construction lifetime. With several mutexes it uses the standard deadlock-avoidance machinery rather than simply locking arguments left to right:

```cpp
void transfer(Position& from, Position& to, std::int64_t quantity) {
    if (&from == &to) return;
    std::scoped_lock lock{from.mutex, to.mutex};
    from.quantity -= quantity;
    to.quantity += quantity;
}
```

`std::shared_lock<std::shared_mutex>` expresses shared ownership and has flexibility similar to `unique_lock`. The synchronization guarantee still comes from the underlying mutex operations. The wrapper does not make references escaped from the protected scope safe. A pointer into a locked container can become invalid as soon as the wrapper is destroyed.

Lock wrappers can use adoption tags such as `std::adopt_lock`, but these tags transfer a proof obligation to the programmer. Constructing an adopting wrapper without already owning the mutex violates the precondition. Reserve such forms for small, established patterns such as `std::lock` followed immediately by two adopting wrappers.

RAII improves predictability by making release deterministic, but it cannot bound the destructor's delay: `unlock()` can wake a waiter, and implementation details vary. It also cannot protect against process termination, hardware failure, or undefined behavior. The contract is scoped C++ execution, not transaction durability.

## 15.3 Lock Ordering and Deadlock Prevention

A **deadlock** occurs when a set of threads wait indefinitely for conditions only members of that set can satisfy. The classic lock cycle has four ingredients: exclusive ownership, hold-and-wait, no forced revocation, and circular wait. Preventing a circular wait is generally the most practical policy.

Assign each lock class a rank and require acquisition in ascending order:

```text
rank 10: instrument configuration
rank 20: strategy state
rank 30: account risk
rank 40: outbound session
```

If every path follows this order, the wait-for graph cannot contain a lock cycle. Document the rule near the owning types, not in tribal knowledge. Debug builds can keep the highest rank held in thread-local state and assert that each acquisition advances the order.

Object identity complicates ordering. Two `Position` objects have the same conceptual rank. One option is to impose a stable address or ID order, but raw pointer relational comparison is not the general portable ordering operation for unrelated objects. `std::less<T*>` supplies a strict total order for pointers. More simply, `std::scoped_lock` handles a small dynamic set of standard Lockable objects without requiring an application-visible rank.

Do not call unknown code while holding a lock. A callback can acquire another lock, block on I/O, allocate, log, or reenter the same component. Copy or move the minimum callback data under the lock, release it, and invoke the callback afterward. The copied state must be a coherent snapshot; shortening a critical section is not worth breaking the invariant.

Locks are not the only nodes in a deadlock graph. A thread can hold a mutex while waiting for:

- another thread to join;
- a full bounded queue to gain space;
- a future or condition variable;
- a logging subsystem that needs the first mutex;
- an asynchronous task scheduled onto the blocked worker pool.

Include these resources in design reviews. A “single-lock” component can deadlock through a queue or thread join.

`try_lock` can avoid permanent circular waiting, but a retry loop may livelock: all participants repeatedly acquire one resource, fail on the next, release, and retry together. Randomized or exponential backoff reduces synchronization, but does not guarantee fairness. `std::lock` and `std::scoped_lock` use an unspecified deadlock-avoidance strategy; they do not promise bounded attempts.

Timed locking converts indefinite waiting into an error path, not into correctness. A timeout can leave an operation partially attempted and requires a recovery policy. Timed waits may return later than requested because the scheduler controls when the thread runs. Use timeouts for failure detection or service-level policy, not as a substitute for a consistent lock design.

Useful verification combines static and dynamic evidence. Clang thread-safety annotations can express guarded data and lock ordering in supported codebases. ThreadSanitizer detects many races and some lock-order inversions during observed executions, but it cannot prove the absence of deadlock. Production flight-recorder events for lock acquisition should be bounded and low overhead; record long waits or sampled contention rather than formatting a log message under the lock.

## 15.4 Convoying, Fairness, and Priority Inversion

A **lock convoy** forms when multiple threads serialize behind a delayed lock owner and continue handing the lock through scheduler-mediated wakeups. A short critical section can still produce a long queue if its owner is descheduled, page-faults, or is preempted by unrelated work.

Suppose eight feed-handler threads update one shared statistics map. If the current owner incurs an allocator slow path, the other seven can block. When the owner releases, waking one waiter does not guarantee immediate progress: the waiter must become runnable, be selected by the scheduler, and obtain cache-line ownership. New arrivals may compete too. The resulting latency distribution has a fast mode and a broad slow mode.

**Fairness** describes how access is distributed among waiters. C++ mutex types generally do not promise FIFO admission or starvation freedom. An unfair mutex can be efficient because the running thread may reacquire the mutex while its data and instructions remain hot. The same policy can starve an unlucky waiter. A fair queueing mutex reduces barging but can force ownership to a sleeping thread and increase handoff latency.

Fairness is therefore a service property, not an automatic optimization. For an order gateway, indefinite starvation is unacceptable even when aggregate throughput is high. For a private, briefly held internal mutex with low contention, strict FIFO handoff may add cost without a useful benefit. Measure per-thread wait distributions, not just completed operations per second.

**Priority inversion** occurs when a high-priority thread waits for a resource held by a lower-priority thread, while medium-priority work prevents the owner from running. The effective dependency is inverted:

```text
high priority  H: waits for mutex M
low priority   L: owns M but is runnable
medium         M: consumes the CPU, delaying L
```

The C++ standard does not require priority inheritance. Linux provides priority-inheritance futex and POSIX mutex facilities, but `std::mutex` does not expose a portable way to request them. A system needing this property may require a carefully configured native pthread mutex behind a project-specific RAII wrapper. That choice introduces platform-specific initialization, error handling, and operational tests.

Real-time priority is not a cure by itself. A runaway real-time thread can starve kernel housekeeping, logging, control processes, and lower-priority owners of resources it needs. Memory allocation, page faults, interrupts, and device work can still introduce delays. Scheduling configuration must be designed with watchdogs, bounded work, CPU placement, and a recovery path.

Reduce convoy risk by shortening and bounding critical sections, preallocating memory, avoiding system calls and callbacks while locked, partitioning independent state, and keeping long-lived owners on appropriately provisioned CPUs. Sharding changes semantics: an operation spanning shards still needs ordering or a snapshot rule. It is not enough to replace one mutex with many and hope.

On Linux, `perf sched timehist` can reveal when an apparent lock delay is actually scheduling delay. `perf lock` may help with supported lock classes, but standard-library user-space fast paths are not necessarily visible as kernel locks. Application instrumentation can timestamp attempted and successful acquisition using a sampled or thresholded design. Always account for the observer effect described in Chapter 1.

## 15.5 Adaptive Spinning and Kernel Fallback

**Adaptive spinning** waits in user space for a limited period and parks through the kernel if the condition does not change. It attempts to avoid a sleep/wakeup round trip when the owner is likely to release soon, while avoiding unlimited CPU consumption when the wait will be long.

A common mutex state machine is conceptually:

```text
unlocked --atomic acquire--> locked
locked   --spin/retry-------> locked
locked   --futex wait-------> sleeping waiter
unlock   --futex wake-------> runnable waiter
```

Real implementations use more states to track waiters and ownership. The atomic fast path still obtains exclusive ownership of the mutex line. Under contention, repeated exchanges can make all waiters write the line, creating more coherence traffic than a load-then-attempt scheme. Library implementations evolve, so inspect the target library or trace behavior instead of assuming a specific algorithm.

Spinning is rational when three conditions hold: the expected wait is short, the owner is currently running, and the spinning CPU is not needed for useful work. It is harmful when the owner was preempted, runs on the same physical core's SMT sibling, waits for I/O, or has entered a long critical section. In an oversubscribed process, spinners can prevent the owner from being scheduled.

Linux futexes illustrate the kernel fallback. A futex wait asks the kernel to sleep only if a user-space word still has an expected value. This comparison closes the race between observing “locked” and entering the wait queue. Unlock normally changes the user-space state first and calls a wake operation only when waiters may exist. The uncontended path can therefore avoid a syscall. C++ does not require futexes, and a particular `std::mutex` may use other machinery.

The slow path's tail includes several queues: the futex wait queue, the scheduler run queue, and the cache-coherence competition for the lock word and protected data. Waking many waiters for one available resource produces a thundering herd. Waking one reduces the herd but makes selection and fairness policy important.

Do not build a production mutex by copying a short futex example. Correct mutexes must address ordering, owner death where required, cancellation, signals, priority protocols, waiter races, and state wraparound. Use the standard or pthread primitives unless a measured requirement and specialist review justify a custom design.

To determine whether adaptive behavior helps, benchmark with realistic critical-section distributions and CPU placement. Include an owner that is occasionally preempted or delayed; a benchmark in which both threads run uninterrupted on isolated cores tests only the favorable mode. Record CPU time, voluntary and involuntary context switches, migrations, and wait percentiles:

```bash
perf stat -e cycles,instructions,context-switches,cpu-migrations \
  ./mutex_contention_bench
```

The optimal spin budget is workload- and machine-dependent. Hard-coding a loop count also makes the time budget change with processor frequency. Let a proven implementation adapt unless evidence demands otherwise.

## 15.6 Condition Variables and Predicate Loops

A **condition variable** lets a thread sleep until shared state may satisfy a predicate. The predicate belongs to the program and is protected by a mutex; the condition variable is only a notification mechanism.

```cpp
#include <condition_variable>
#include <cstddef>
#include <mutex>
#include <optional>
#include <queue>

class BoundedQueue {
public:
    explicit BoundedQueue(std::size_t capacity) : capacity_{capacity} {}

    bool push(int value) {
        std::unique_lock lock{mutex_};
        not_full_.wait(lock, [this] { return closed_ || queue_.size() < capacity_; });
        if (closed_) return false;
        queue_.push(value);
        lock.unlock();
        not_empty_.notify_one();
        return true;
    }

    std::optional<int> pop() {
        std::unique_lock lock{mutex_};
        not_empty_.wait(lock, [this] { return closed_ || !queue_.empty(); });
        if (queue_.empty()) return std::nullopt;
        int value = queue_.front();
        queue_.pop();
        lock.unlock();
        not_full_.notify_one();
        return value;
    }

    void close() {
        {
            std::lock_guard lock{mutex_};
            closed_ = true;
        }
        not_empty_.notify_all();
        not_full_.notify_all();
    }

private:
    const std::size_t capacity_;
    std::mutex mutex_;
    std::condition_variable not_empty_;
    std::condition_variable not_full_;
    std::queue<int> queue_;
    bool closed_{};
};
```

This teaching implementation bounds the number of queued elements, but `std::queue` may allocate while the mutex is held. A hot-path implementation would normally preallocate a ring or pool and make construction failure an initialization concern. Capacity alone does not imply allocation-free operation.

The predicate overload is equivalent in intent to a `while` loop. It checks under the lock, atomically releases the mutex and waits if false, then reacquires the mutex before checking again. “Atomically” here concerns the transition relative to notification; it does not mean the entire sleep is one CPU instruction.

The queue is bounded, making overload behavior explicit: producers wait. An HFT hot path might instead reject, overwrite, or drop according to policy, because producer blocking can propagate latency upstream. The primitive cannot choose the correct overload semantics.

Notify after changing the state under the same mutex used by the waiter. The modification does not have to occur while holding the mutex merely because of a narrow wording trick; rather, using the mutex establishes a simple, correct protocol and prevents the waiter from missing the state transition. Releasing before `notify_one()` can avoid waking a thread only to have it block immediately on the mutex. Some implementations optimize notification under the lock, so measure if the distinction matters. Correctness must not depend on which thread acquires the mutex next.

`notify_one()` is suitable when one state transition enables at most one useful consumer. `notify_all()` is needed for shutdown, a generation change, or a condition that can enable many waiters. It can also create a herd: every awakened thread reacquires the mutex and rechecks the predicate. Separate conditions such as `not_empty` and `not_full` avoid waking unrelated waiters.

Timed condition-variable waits must still use a predicate loop. Prefer an absolute deadline when retrying: repeatedly waiting for the full relative duration can extend the total time after spurious wakeups. `std::condition_variable::wait_until` can use a supplied clock, but the implementation's conversion and the system scheduler affect observed wake time. A timeout means “the predicate was not observed before this wait completed,” not “the thread ran exactly at the deadline.”

`std::condition_variable` works with `std::unique_lock<std::mutex>`. `std::condition_variable_any` supports other lock types, commonly with extra indirection or state. Choose it for a required lock interface, not as the default.

## 15.7 Spurious Wakeups and Lost-Wakeup Prevention

A **spurious wakeup** is a wait return not associated with a notification that makes the program's predicate true. C++ permits it. A **lost wakeup** is a protocol error in which a state change and notification occur, but a waiter sleeps without observing the enabling state.

The correct rule is simple: wait on state, not on the history of notifications.

```cpp
// BROKEN: `ready` is not protected by the same mutex protocol.
bool ready = false;
std::mutex mutex;
std::condition_variable cv;

// waiter
if (!ready) {
    std::unique_lock lock{mutex};
    cv.wait(lock);              // notification may already have happened
}
```

Even making `ready` atomic does not repair this particular split protocol. The notifier can set `ready` and notify after the waiter's first check but before the waiter actually begins waiting. Notifications are not stored as credits by a condition variable.

```cpp
// CORRECT: predicate and wait transition use one mutex protocol.
std::unique_lock lock{mutex};
cv.wait(lock, [&] { return ready; });
```

The notifier locks the same mutex, changes `ready`, unlocks, and notifies. If notification occurs before the waiter starts, the predicate is already true and the waiter does not sleep. If the waiter has atomically released the mutex and entered the wait, the notification makes it eligible to wake. In either case, the state carries the event.

A boolean may be too weak when events can occur repeatedly. If one thread publishes book generations and another must observe every change, use a monotonically increasing generation or a queue. A waiter remembers the last processed generation and waits for `generation != observed`. Wraparound and event coalescing must be addressed by the design. A condition variable does not make an event log.

Spurious wakeups are not the only reason for the loop. Another waiter may consume the item before this waiter reacquires the mutex. The state can change again between notification and lock acquisition. The predicate loop handles all these cases with one rule.

Testing a lost-wakeup bug is difficult because the vulnerable window is small. Stress tests should vary thread counts, insert scheduling perturbations in test-only builds, and run under ThreadSanitizer. These increase coverage but do not prove correctness. The proof comes from the mutex/predicate protocol and the happens-before edges described in Chapter 14.

The tail cost of a condition-variable wake is inherently scheduler-sensitive. After notification, the waiter is only eligible to run. CPU saturation, priority, affinity, migrations, and cache state determine when useful work resumes. If the required response time is shorter than acceptable scheduler variance, a dedicated polling design may be appropriate—but only with reserved CPU capacity and explicit power and interference costs.

## 15.8 C++20 Atomic Wait and Notify

C++20 **atomic waiting** blocks while an atomic object's value equals an expected value. `wait(old)` returns only after the value representation differs from `old`, although it may unblock internally and recheck. The producer must change the atomic value; notification alone is not persistent state.

```cpp
#include <atomic>
#include <cstdint>

class Generation {
public:
    std::uint64_t current() const noexcept {
        return value_.load(std::memory_order_acquire);
    }

    void publish_next() noexcept {
        value_.fetch_add(1, std::memory_order_release);
        value_.notify_all();
    }

    std::uint64_t wait_for_change(std::uint64_t observed) const noexcept {
        value_.wait(observed, std::memory_order_acquire);
        return value_.load(std::memory_order_acquire);
    }

private:
    mutable std::atomic<std::uint64_t> value_{0};
};
```

The release update and acquire observation publish prior non-atomic writes, assuming the reader accesses them through a correct ownership protocol. `wait`'s memory-order argument constrains its load; it does not make unrelated data safe by itself.

Atomic wait avoids a separate mutex and condition-variable object when the condition is exactly an atomic value transition. A standard library may use a short spin followed by a Linux futex or a hashed waiter table. Futex support depends on size, alignment, and platform capabilities, so not every atomic type maps directly to one kernel word. This implementation choice is invisible in the C++ interface but visible in memory footprint and contention behavior.

There is an ABA-style observation issue. If the value changes away from `old` and back before the waiter observes it, the waiter may continue waiting. Use a generation counter wide enough that wraparound is outside the operational horizon, or use a queue when every event must be retained. Do not use a flag that rapidly cycles when transitions matter individually.

Notification does not impose ordering beyond that carried by atomic operations. Calling `notify_one()` without changing the value does not guarantee that `wait(old)` returns. This differs from treating a condition variable as a possibly spurious pulse, and it is a valuable protection against accidentally proceeding with a false condition.

`notify_one()` reduces wakeups when any one waiter can do the work; `notify_all()` is appropriate for version publication or shutdown observed by all. Neither promises fair selection. A fast thread can repeatedly consume state while another remains delayed.

Atomic waiting has no standard timed overload in C++23. If deadlines are required, a condition variable, semaphore timed operation, platform API, or higher-level event loop may be necessary. That interface gap can decide the primitive before performance does.

## 15.9 Semaphores, Latches, and Barriers

C++20 added three coordination abstractions with different state models. A **semaphore** counts available permits. A **latch** is a one-shot countdown. A **barrier** is a reusable phase boundary.

`std::counting_semaphore` preserves permit state even when no thread is waiting. This makes it different from a condition-variable notification:

```cpp
#include <cstddef>
#include <semaphore>

template<std::ptrdiff_t N>
class Credits {
public:
    void acquire() { available_.acquire(); }
    void release() { available_.release(); }

private:
    std::counting_semaphore<N> available_{N};
};
```

The template argument is a least maximum value, not necessarily the exact representation bound. `std::binary_semaphore` is an alias with a least maximum of one. Releasing beyond the permitted maximum violates the contract. A semaphore controls admission but does not itself protect a container; the resource protocol still needs ownership and synchronization.

Timed semaphore acquisition supports failure or overload policies. As with other timed waits, success and timeout occur under scheduler and clock uncertainty. A permit often represents scarce queue capacity, DMA descriptors, or outstanding requests. Its count must match the actual resource even on exceptions and cancellation; an RAII permit wrapper can return the credit deterministically.

A `std::latch` starts with a count and becomes permanently ready when the count reaches zero. It is useful for test start gates or for waiting until a fixed set of long-lived workers has initialized. `count_down`, `wait`, and `arrive_and_wait` express the phases. Destruction while another thread is using the latch is a lifetime error; the latch does not own its participants.

A `std::barrier` synchronizes a known set of participants repeatedly. Each arrival reduces the current phase's expected count. When it reaches zero, an optional completion function runs and the next phase begins. `arrive_and_drop` permanently reduces participation, which is useful when a worker leaves a phased computation.

The completion function is part of the phase's critical progress. It should be bounded, nonblocking, and nonthrowing as required by the interface. A slow completion delays every participant. Barrier-based designs also amplify stragglers: phase time is determined by the slowest participant, so a rare cache miss or descheduling event becomes everyone's tail.

These abstractions can be implemented with atomics, waiting primitives, and platform support, but C++ does not fix their algorithm, fairness, object size, or whether a given operation enters the kernel. Measure their target-library implementations. More importantly, choose based on state semantics:

| Need | Primitive |
|---|---|
| Count retained permits | Semaphore |
| Wait once for N completions | Latch |
| Rejoin N participants each phase | Barrier |
| Wait for arbitrary protected predicate | Condition variable |
| Wait for one atomic value to change | Atomic wait |

Using the right state model eliminates home-grown counters and notifications, reducing both code and lost-wakeup risk.

## 15.10 Spin, Yield, and Park Tradeoffs

A waiting thread can **spin** while remaining runnable, **yield** its current scheduling opportunity, or **park** so the operating system marks it non-runnable until a wake event. These choices trade response latency against CPU capacity, power, and interference.

A polite spin loop repeatedly reads before attempting a contended write and gives the processor a spin-wait hint:

```cpp
#include <atomic>

void wait_until_ready(const std::atomic<bool>& ready) noexcept {
    while (!ready.load(std::memory_order_acquire)) {
#if defined(__x86_64__)
        __builtin_ia32_pause();
#elif defined(__aarch64__)
        asm volatile("yield" ::: "memory"); // compiler-specific excerpt
#endif
    }
}
```

This code deliberately has no timeout or stop path and is therefore unsuitable as a general library function. The architecture hints have different semantics and performance characteristics. An x86 `PAUSE` can reduce pipeline and SMT penalties in spin loops; ARM's `YIELD` is a hint. Neither releases the CPU to the Linux scheduler.

`std::this_thread::yield()` tells the scheduler that the current thread is willing to let another runnable thread proceed. The result depends on policy and run-queue state; the same thread may run again immediately. Yield is not a timed delay, a fairness guarantee, or an efficient substitute for a real event wait.

Parking with a condition variable, atomic wait, semaphore, or mutex slow path frees execution capacity. It adds transition and wakeup work and exposes the waiter to scheduler latency. Parking is normally correct for waits that may last longer than a brief critical section or when CPUs are oversubscribed.

Hybrid waiting spins for a budget, possibly yields, then parks. The useful budget depends on owner state, critical-section distribution, core topology, frequency, and power policy. A fixed iteration count is especially unstable. If the producer and consumer share SMT siblings, an aggressive consumer spin can slow the producer that must satisfy it.

For HFT, dedicating a physical core to a polling thread can make sense when the input path and deployment reserve that capacity. State the costs: sustained CPU consumption, higher power, heat and possible frequency effects, lost capacity for other services, and interference through shared caches or memory bandwidth. A polling loop also needs shutdown, health checking, and an overload policy.

Measure CPU time along with wake latency. A design that removes ten microseconds from an idle wake in exchange for consuming a core may be excellent or absurd depending on the deployment. Test steady load, bursts, idle-to-active transitions, and preempted producers. Tail latency—not the minimum observed wake—is the decisive quantity.

## 15.11 `std::thread`, C++20 `std::jthread`, and Stop Tokens

`std::thread` is an owning handle to a thread of execution. Constructing one starts the new thread; destroying a joinable `std::thread` calls `std::terminate`. The rule prevents silent detachment and lifetime bugs, but it means ownership must be settled on every path.

```cpp
#include <thread>

void run_feed();

int main() {
    std::thread worker{run_feed};
    worker.join();
}
```

`join()` waits for completion and establishes synchronization: actions in the completed thread happen before a successful return from `join`. `detach()` discards the handle without extending the lifetime of referenced objects. Detached threads make shutdown, error propagation, and resource ownership difficult; use a process-level service model only when those responsibilities are explicitly solved.

C++20 `std::jthread` joins during destruction and can supply a **stop token** for cooperative cancellation:

```cpp
#include <chrono>
#include <stop_token>
#include <thread>

using namespace std::chrono_literals;

void monitor(std::stop_token stop) {
    while (!stop.stop_requested()) {
        // Poll bounded work; use a stop-aware wait for long blocking periods.
        std::this_thread::sleep_for(10ms);
    }
}

int main() {
    std::jthread worker{monitor};
    // destructor requests stop and joins
}
```

Cancellation is cooperative. A stop request does not interrupt arbitrary code, unwind the target thread, or make blocking syscalls return. The worker must observe the token or use a stop-aware API. The polling example may take almost ten milliseconds to respond; C++20's stop-token overloads for `condition_variable_any` can integrate cancellation without periodic polling.

A `std::stop_source` owns the ability to request cancellation, and tokens are lightweight views of shared stop state. Copies can share underlying state, which may involve reference counting and an allocation depending on the library. `std::stop_callback` registers code to run when cancellation is requested; the callback can run synchronously in the requesting thread. It must not block, acquire locks in an unsafe order, or depend on the worker being the caller.

`jthread`'s destructor order matters. It requests stop and joins before member destruction completes, but members declared after or surrounding the `jthread` can still have tricky lifetime relationships. Design an owning service so data used by the thread outlives the thread object and so shutdown cannot wait while holding a lock the worker needs.

```cpp
#include <atomic>
#include <stop_token>
#include <thread>

class Service {
    // State is declared before worker_, so worker_ is destroyed first.
    std::atomic<unsigned> polls_{0};
    std::jthread worker_;

public:
    Service()
        : worker_{[this](std::stop_token stop) {
              while (!stop.stop_requested()) {
                  polls_.fetch_add(1, std::memory_order_relaxed);
                  std::this_thread::yield();
              }
          }} {}

    unsigned polls() const noexcept {
        return polls_.load(std::memory_order_relaxed);
    }
};
```

The compiler-generated destructor destroys members in reverse declaration order: `worker_` stops and joins before `polls_` is destroyed. A custom destructor may still be needed to notify a non-stop-aware wait before joining.

Thread exceptions do not propagate to the joining thread. An uncaught exception escaping the thread function calls `std::terminate`. Catch at the thread boundary, record failure through a bounded channel or `exception_ptr` outside latency-critical operation, request coordinated shutdown, and define which component owns recovery.

## 15.12 Creation, Destruction, and Stack Reservation

Thread creation is an operating-system resource operation, not a cheap function call. A Linux implementation commonly creates a kernel task, reserves virtual address space for a stack with a guard region, initializes thread-local runtime state, and schedules the new task. Physical stack pages usually arrive on first touch, so startup and later deep call paths can fault at different times.

The default stack reservation can multiply into a large virtual-memory footprint when hundreds of threads are created. Reservation is not the same as resident memory, but page tables, guard areas, TLS, kernel task structures, and scheduler work are real resources. Native pthread attributes allow a stack size to be selected before creation; `std::thread` exposes no portable stack-size control.

Creating a thread per message or order is therefore indefensible for a low-latency path. Use long-lived threads with explicit ownership and bounded work queues. Warm them before live traffic: start the thread, establish affinity, touch expected stack depth and thread-local structures, initialize libraries, and execute representative code paths. Warming reduces predictable first-use faults but cannot guarantee that pages will never be reclaimed or code will remain cached.

Destruction has two distinct meanings. Destroying the C++ handle is governed by `thread` or `jthread` rules. Thread exit also runs thread-local destructors and releases runtime and kernel resources. A TLS destructor can allocate, lock, log, or call into code whose global objects have already begun destruction. Production services should shut down threads explicitly before static teardown.

Joining is unbounded unless the worker's termination protocol is bounded. A `jthread` destructor that automatically joins is safer for ownership, but a hidden long wait in a destructor can surprise a latency-sensitive or error path. Expose an explicit `stop()`/`join()` phase for services whose shutdown can block, while keeping destructor behavior as a final safety net.

Thread pools amortize creation but add queueing, synchronization, and loss of locality. General-purpose pools optimize utilization; HFT stages often prefer one long-lived thread per role with single-writer state. That is a topology decision, not a language requirement. A pool is appropriate for noncritical parallel work whose queue delay and task migration are acceptable.

To observe Linux thread resources, inspect `/proc/<pid>/task`, per-thread status files, and mappings. `ps -L`, `top -H`, and `pidstat -t` expose per-thread scheduling statistics. Never infer resident stack use merely from the mapped stack range.

## 15.13 Affinity, Priority, and Oversubscription

**CPU affinity** restricts the logical CPUs on which a thread may execute. C++ has no standard affinity interface. Linux provides `pthread_setaffinity_np` and `sched_setaffinity`, so portable code should isolate the platform-specific policy behind a small RAII or startup function and report failures.

```cpp
// Linux-specific example.
#include <cerrno>
#include <pthread.h>
#include <sched.h>
#include <system_error>

void pin_current_thread(unsigned cpu) {
    if (cpu >= CPU_SETSIZE) {
        throw std::system_error{EINVAL, std::generic_category()};
    }
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    const int error = pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
    if (error != 0) throw std::system_error{error, std::generic_category()};
}
```

Affinity can preserve cache and TLB warmth and prevent migrations. It can also make things worse if the selected CPU handles interrupts, shares a physical core with a busy SMT sibling, lies on a remote NUMA node from memory or the NIC queue, or becomes saturated. Pinning is incomplete without mapping the whole path: worker, memory, interrupt, network receive/transmit queue, and housekeeping load.

Linux scheduling policies and priorities determine selection among runnable threads. Normal scheduling uses dynamic policies; real-time FIFO and round-robin policies have different rules and serious operational risks. Privilege and resource limits normally constrain their use. C++ exposes neither policy nor priority portably.

**Oversubscription** means there are more runnable compute-bound threads than available logical CPUs. It is useful for workloads that frequently block, but harmful to a continuously running low-latency pipeline. Runnable threads compete for scheduling time, incur context switches, evict one another's cache and TLB state, and broaden tails. Counting logical CPUs alone is insufficient because SMT siblings share front-end, execution, and cache resources.

Thread priority does not reserve memory bandwidth, LLC capacity, or an interrupt-free core. Nor does affinity prevent kernel activity on the selected CPU. CPU isolation, cpusets, interrupt routing, and kernel housekeeping are Linux operational topics developed in Chapter 21. Apply them cautiously: isolating too much can starve required kernel work.

Place communicating stages deliberately. Two stages with heavy shared-state traffic may benefit from nearby cores sharing a cache, while independent bandwidth-heavy stages may need separation. Producer and consumer on SMT siblings can have low communication distance but compete for execution resources. There is no topology-independent rule.

Verify placement rather than trusting configuration. `sched_getcpu()` can sample the current CPU in diagnostics; `/proc/<pid>/task/<tid>/status` reports allowed CPUs; `taskset`, `ps -o psr`, and `perf stat` expose placement and migrations. Do not call diagnostic APIs on every hot-path operation. Sample outside the critical path or use kernel counters.

## 15.14 Migrations, Context Switches, and Warmed Threads

A **context switch** changes the running task on a logical CPU. A **migration** resumes a task on a different CPU. Neither necessarily flushes every cache, but both can disrupt locality and expose the task to different private caches, TLBs, NUMA distance, and shared-resource contention.

Voluntary switches occur when a thread blocks or yields. Involuntary switches occur when the scheduler preempts it. A mutex slow path, condition-variable wait, `sleep`, blocking I/O, and thread join can all cause voluntary switches. CPU competition and scheduling slices produce involuntary switches.

The direct switch work—saving and restoring architectural state and executing scheduler code—is only part of the cost. The resumed task may reload instructions, data, translations, and branch-predictor context. Modern processors and kernels differ in exactly what is retained or mitigated. Treat “a context switch costs X” as an invalid universal claim.

Long-lived, pinned, warmed threads reduce several sources of variance:

- startup and TLS initialization;
- demand faults on known stack and data pages;
- cold code and data;
- migration between private caches;
- repeated allocator initialization.

They do not eliminate interrupts, system-management events, cache eviction, coherence traffic, thermal throttling, or kernel scheduling. Warmup must execute representative branches and touch representative memory; an empty loop warms little of value.

A practical startup protocol can create workers, apply affinity, initialize per-thread arenas and buffers, touch pages, run a short representative dry path, and then count down a latch. The main thread begins traffic only after all workers report ready. This turns many first-use surprises into observable startup failures.

Tail analysis should correlate application stalls with scheduling facts:

```bash
pidstat -wt -p PID 1
perf stat -e context-switches,cpu-migrations,page-faults -p PID
perf sched record -- ./application
perf sched timehist
```

Tool availability and permissions vary, and tracing adds overhead. Capture in a representative staging environment first. In production, bounded counters and occasional traces are safer than continuous detailed events.

The design conclusion is precise: keep hot-path threads long-lived when their roles are stable; pin only as part of a complete topology plan; block on explicit events rather than accidental contention; and verify the remaining scheduler and cache effects on the deployed machine.

## 15.15 Interview Check

1. What synchronization relationship does an unlock followed by a successful lock on the same mutex establish, and what does C++ leave unspecified?
2. Compare `lock_guard`, `unique_lock`, `scoped_lock`, and `shared_lock` in ownership state, flexibility, and likely object footprint.
3. Why can a very short mutex critical section still produce a long-tail latency distribution?
4. Find the lost-wakeup window in a design that tests an atomic flag and then waits unconditionally on a condition variable. How would you repair the state protocol?
5. When is `atomic::wait` a better fit than a condition variable, and what event-loss problem can arise if a value changes away and back?
6. Distinguish a semaphore, latch, and barrier by the state each retains. Which one amplifies a slow phase participant?
7. A feed handler spins on a flag while pinned to the SMT sibling of its producer. Explain why spinning may increase rather than reduce wake latency.
8. Design a shutdown sequence for a `jthread` whose worker can block waiting for queue input. Which objects must outlive the worker?
9. Explain how CPU affinity can reduce migrations yet worsen NUMA or interrupt-path latency.
10. Which measurements would separate lock contention from owner preemption, page faults, and CPU migration?
