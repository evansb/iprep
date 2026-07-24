# 24. Asynchronous C++ and Coroutines

Asynchronous code separates starting work from collecting its result. C++ offers several ways to express that separation, each with a different ownership model, error channel, cancellation story, and runtime cost. Coroutines restore straight-line control flow without hiding the state machine or its allocation.

## From synchronous calls to tasks

A synchronous function call does not return until the callee finishes. An asynchronous operation starts work that may proceed elsewhere, allowing the caller to perform independent CPU work while an I/O operation or another computation is outstanding.

Every asynchronous mechanism in this chapter has three parts:

- A **task** is the unit of work.
- **Shared state** records completion and holds the outcome.
- A **result channel** carries a value or failure to the consumer.

Promises and futures make these parts explicit:

```text
producer thread                                      consumer thread
     task
       |
       v
 std::promise<T> ---> [ shared state ] ---> std::future<T>
                      | value          |
                      | exception      |
                      | ready status   |
```

The producer and consumer need not be operating-system threads. A task may run on a pool, and a coroutine may suspend on one thread and resume on another. The triple remains the same even when a library packages it behind a different interface.

Asynchrony can hide latency only when useful work overlaps the wait. Starting a task and immediately blocking for its result adds machinery without overlap.

## Callbacks and their problems

A callback is a continuation: a function supplied now for an event loop to invoke when an operation completes. Callback APIs are workable and can be efficient, but sequential logic becomes distributed among handlers.

```cpp
#include <functional>
#include <system_error>

using Connection = int;
using OrderId = int;
using Confirmation = int;

void connect(std::function<void(std::error_code, Connection)> done);
void send(Connection connection, OrderId order,
          std::function<void(std::error_code)> done);
void confirm(Connection connection,
             std::function<void(std::error_code, Confirmation)> done);
void finish(std::error_code error, Confirmation confirmation);

void submit_order(OrderId order) {
    connect([order](std::error_code error, Connection connection) {
        if (error) {
            return finish(error, 0);
        }
        send(connection, order, [connection](std::error_code send_error) {
            if (send_error) {
                return finish(send_error, 0);
            }
            confirm(connection, [](std::error_code confirm_error,
                                   Confirmation confirmation) {
                finish(confirm_error, confirmation);
            });
        });
    });
}
```

Three related costs appear:

- **Inversion of control:** the event loop, not the visible function body, decides when each continuation runs.
- **Error plumbing:** an exception cannot jump across an event-loop turn, so every callback needs an explicit failure path.
- **Callback nesting:** each dependent operation introduces another lambda and another lifetime boundary.

Futures package the result channel, including exceptions. Coroutines let the compiler turn straight-line source into the necessary continuations.

**Pitfall.** A callback often outlives the function that registered it. Capturing a local by reference then produces the dangling-capture bug from Chapter 9; capture owned state by value or place it in an object whose lifetime covers the operation.

## Promises and futures

A `std::promise<T>` and its `std::future<T>` are the producer and consumer ends of one shared state. Standard library implementations normally allocate that state separately and manage it much like the shared control block from Chapter 8.

The producer calls `set_value()` once. The consumer calls `get()`, which waits if necessary, moves the result out, and invalidates the future.

```cpp
#include <future>
#include <iostream>
#include <thread>
#include <utility>
#include <vector>

double portfolio_risk(const std::vector<double>& positions) {
    double sum = 0.0;
    for (double position : positions) {
        sum += position * position;
    }
    return sum;
}

int main() {
    std::promise<double> producer;
    std::future<double> result = producer.get_future();

    std::jthread worker{
        [promise = std::move(producer)]() mutable {
            std::vector<double> positions{2.0, -3.0, 1.0};
            promise.set_value(portfolio_risk(positions));
        }
    };

    std::cout << result.get() << '\n';  // prints: 14
}
```

`std::promise` is move-only, so the lambda takes ownership with a move capture. The `std::future` remains with the consumer. Calling `result.get()` a second time throws `std::future_error` because the first call leaves the future with no associated state.

`valid()` reports whether a future still refers to shared state. Waiting does not invalidate it; `get()` does. Calling `get_future()` twice on the same promise or satisfying a promise twice also throws `std::future_error`, because each shared state has exactly one producer slot and one ordinary future endpoint.

A `std::shared_future<T>` permits several consumers to observe the same result. Its `get()` does not consume the state, so multiple threads may wait and read it. It trades one-shot transfer for shared access and a potentially longer shared-state lifetime.

### Waiting and polling

`get()` is a blocking rendezvous. A consumer that must do other work can inspect readiness using the duration and clock types from Chapter 14:

```cpp
std::future<double> start_risk_calculation();
void service_admin_messages();

double wait_for_risk() {
    std::future<double> risk = start_risk_calculation();

    while (risk.wait_for(std::chrono::milliseconds{1})
           == std::future_status::timeout) {
        service_admin_messages();
    }

    return risk.get();
}
```

`wait_for()` and `wait_until()` report one of three statuses:

| Status | Meaning |
|---|---|
| `std::future_status::ready` | Value or exception is available |
| `std::future_status::timeout` | Deadline passed without completion |
| `std::future_status::deferred` | Work is configured to run lazily |

Polling with a short timeout does not make waiting free. It repeatedly enters synchronization code and may repeatedly involve the operating system.

### Exceptions and broken promises

Exceptions do not propagate directly between threads. The worker catches the active exception and stores it with `set_exception()`; `get()` rethrows it in the consumer, preserving the exception type.

```cpp
void calculate_with_error_channel() {
    std::promise<int> producer;
    std::future<int> result = producer.get_future();

    std::jthread worker{
        [promise = std::move(producer)]() mutable {
            try {
                throw std::runtime_error{"risk input unavailable"};
            } catch (...) {
                promise.set_exception(std::current_exception());
            }
        }
    };

    try {
        (void)result.get();
    } catch (const std::runtime_error& error) {
        std::cout << error.what() << '\n';
        // prints: risk input unavailable
    }
}
```

This is the asynchronous form of the propagation rules from Chapter 6. A worker should satisfy its promise with exactly one value or exception.

If a promise dies before doing either, the shared state becomes ready with a broken-promise error:

```cpp
void observe_broken_promise() {
    std::future<int> result;
    {
        std::promise<int> producer;
        result = producer.get_future();
    }  // producer dies without fulfilling the shared state

    (void)result.get();  // throws std::future_error: broken promise
}
```

That failure is a useful “producer disappeared” signal. It does not explain why the producer disappeared; the worker should still catch failures and preserve the original exception whenever possible.

**Rule.** Every producer path must fulfill its promise with either `set_value()` or `set_exception()`. Let destruction produce `broken_promise` only for genuinely abandoned work.

## `packaged_task` and `std::async`

`std::packaged_task<R(Args...)>` wraps a callable and gives its eventual invocation a future. Calling the packaged task executes the callable; a return value or thrown exception automatically enters the shared state.

This connects futures to the thread pool from Chapter 23. Its `std::function<void()>` queue accepts only copyable callables, so a `std::shared_ptr` makes the move-only packaged task copyable for that interface:

```cpp
// Members added to ThreadPool from Chapter 23.
void enqueue(std::function<void()> work) {
    {
        std::lock_guard lock{mutex_};
        tasks_.push(std::move(work));
    }
    ready_.notify_one();
}

template<class F>
auto submit(F&& function)
    -> std::future<std::invoke_result_t<F&>> {
    using Result = std::invoke_result_t<F&>;
    auto task = std::make_shared<std::packaged_task<Result()>>(
        std::forward<F>(function));
    std::future<Result> result = task->get_future();
    enqueue([task] { (*task)(); });
    return result;
}
```

The extra shared owner and allocation adapt to the old copyable queue; they are not intrinsic to `std::packaged_task`. Changing the pool queue and worker local to `std::move_only_function<void()>` (C++23) allows a lambda to capture the packaged task directly. The existing mutex and condition variable still govern queue access; lock-free task queues belong to Chapter 26.

A packaged task is one-shot with respect to its current shared state. Invoking it again attempts to publish a second result and throws `std::future_error`; invoking a default-constructed or moved-from task reports that it has no state. The queue should therefore treat each wrapper as one consumable work item.

`std::async` combines callable packaging, scheduling, and future creation in one function. Its launch policy determines where and when work runs.

| Policy | New thread? | Work begins | `get()` | `wait_for()` status before execution |
|---|---:|---|---|---|
| `std::launch::async` | Yes | During the call | Waits for thread result | `ready` or `timeout` |
| `std::launch::deferred` | No | On first non-timed wait or `get()` | Runs work on waiting thread | `deferred` |
| Default policy | Implementation chooses | Async or deferred | Depends on choice | May be `deferred` |

Write the policy when behavior matters:

```cpp
int load_reference_data();

std::future<int> background =
    std::async(std::launch::async, load_reference_data);
```

`std::launch::async` permits no executor choice; it behaves as a new thread per invocation. `std::launch::deferred` is lazy synchronous execution, not background work. With the default policy, either behavior is permitted.

A special rule makes a temporary future returned by `std::async` wait in its destructor when it is the last reference to an unfinished asynchronous shared state:

```cpp
int load_reference_data();

void load_and_discard() {
    static_cast<void>(
        std::async(std::launch::async, load_reference_data));
    // temporary future's destructor waits: effectively synchronous
}
```

Two discarded calls in consecutive statements therefore serialize rather than overlap. Storing their futures keeps both operations outstanding.

`std::async` is acceptable for tests, tools, and coarse fan-out where thread creation and scheduler placement do not matter. It is a poor fit for a latency-sensitive service: each asynchronous launch can create a thread and shared state, and the caller cannot select a pool, queue, affinity, or backpressure policy.

The future also exposes no continuation operation in C++23. Composing two dependent futures usually means blocking a worker in `get()` or writing another task that performs that wait. Coroutines and senders avoid occupying a worker solely to express “start this after that.”

**Pitfall.** A deferred future never transitions to `ready` merely because code repeatedly calls `wait_for()`. Timed waits keep returning `std::future_status::deferred`; a non-timed wait or `get()` executes the callable.

## Cooperative cancellation

C++ does not preemptively kill a thread. Terminating code in the middle of a critical section could strand a mutex, partially update an invariant, or leak an external resource. Cancellation is cooperative: one component requests a stop, and the worker observes the request at a safe point.

The C++20 cancellation types divide the roles:

- `std::stop_source` owns the ability to request cancellation.
- `std::stop_token` observes whether cancellation was requested.
- `std::stop_callback` invokes a hook when a request arrives.

As seen in Chapter 23, `std::jthread` owns a stop source and can pass its token as the callable's first argument:

```cpp
#include <stop_token>
#include <thread>

void poll_market_data();
void service_for_a_while();

void run_feed_until_stopped() {
    std::jthread feed{[](std::stop_token stop) {
        while (!stop.stop_requested()) {
            poll_market_data();
        }
    }};

    service_for_a_while();
    feed.request_stop();
}  // jthread joins
```

The worker checks only between calls to `poll_market_data()`. If one call can block indefinitely, the stop request can also wait indefinitely.

A stop callback can wake a worker blocked on a condition variable:

```cpp
std::mutex queue_mutex;
std::condition_variable_any ready;
bool has_message = false;
void consume_message();

void wait_for_message(std::stop_token stop) {
    std::stop_callback wake_on_stop{
        stop,
        [] { ready.notify_all(); }
    };

    std::unique_lock lock{queue_mutex};
    ready.wait(lock, [&] {
        return has_message || stop.stop_requested();
    });

    if (stop.stop_requested()) {
        return;
    }
    consume_message();
}
```

The request invokes the callback, notification wakes the wait, and the predicate observes the stop. The `std::condition_variable_any` overload used in Chapter 23 packages this pattern:

```cpp
void wait_for_message_direct(std::stop_token stop) {
    std::unique_lock lock{queue_mutex};
    if (!ready.wait(lock, stop, [] {
            return has_message;
        })) {
        return;
    }
    consume_message();
}
```

A plain `std::condition_variable` has no stop-token overload. It can still participate through an explicit `std::stop_callback`, but the predicate must include the stop request.

A stop request is permanent for that stop state; it cannot be reset. Registering a `std::stop_callback` after the request has already happened invokes the callback during registration, closing the race between checking the token and installing the wake hook. The callback may therefore run on the requesting thread or the registering thread, so it must be short and safe in either context.

**Pitfall.** Cancellation latency is bounded by how often the worker checks and whether its blocking operations can be awakened. A token that nobody polls changes no control flow.

### Cancellation, completion, and deadline races

An asynchronous operation can complete while another thread requests cancellation. A deadline adds a third participant: the timer can expire at the same moment the device reports success. The operation needs one terminal-state decision.

| Event wins | Published terminal state | Required cleanup |
|---|---|---|
| I/O completion | value or error | cancel timer; unregister stop hook |
| Stop request | stopped | cancel I/O; cancel timer |
| Deadline | timeout error or stopped, by API contract | cancel I/O; unregister stop hook |

The race is not solved by testing a Boolean before registering callbacks. Cancellation can arrive between the test and registration. `std::stop_callback` closes that particular window by invoking inline when registration observes an already-requested stop.

A shared atomic state lets exactly one event claim completion:

```cpp
#include <atomic>

enum class AsyncState {
    pending,
    completed,
    cancelled,
    timed_out
};

class CompletionRace {
public:
    bool complete() noexcept {
        return claim(AsyncState::completed);
    }

    bool cancel() noexcept {
        return claim(AsyncState::cancelled);
    }

    bool timeout() noexcept {
        return claim(AsyncState::timed_out);
    }

private:
    bool claim(AsyncState terminal) noexcept {
        AsyncState expected = AsyncState::pending;
        return state_.compare_exchange_strong(
            expected, terminal,
            std::memory_order_acq_rel,
            std::memory_order_acquire);
    }

    std::atomic<AsyncState> state_{AsyncState::pending};
};
```

Only the caller receiving `true` publishes the result and schedules the continuation. Losing callbacks still release their own registration references, but must not resume the consumer again.

The acquire/release pair orders terminal-state publication; Chapter 25 develops that proof. A runtime that confines all three callbacks to one executor can keep this state ordinary and serialize the decision through the executor instead.

```text
                     I/O callback
                         |
                         v
pending ---- CAS ----> completed ----> schedule continuation once
   |                     ^
   |                     |
   +---- CAS ----> cancelled       losing CAS: cleanup only
   |
   +---- CAS ----> timed_out
          ^
          |
       timer callback
```

Destroying a suspended coroutine adds a lifetime race. Before its frame disappears, every I/O registration, timer, and stop callback capable of reaching its handle must be removed or must retain a separate state object that no longer resumes the frame.

**Rule.** Treat completion, cancellation, and timeout as competing terminal results. One atomic or executor-confined state transition wins; every other callback performs cleanup without a second resumption.

**Pitfall.** A timeout result does not prove the underlying operation stopped. The implementation must cancel and drain the operation, or keep its callback state alive until the late completion is harmlessly consumed.

## Coroutines: functions that suspend

A function is a coroutine if its body contains `co_await`, `co_yield`, or `co_return`. The compiler transforms the function into a resumable state machine whose **coroutine frame** stores parameters, locals that survive suspension, bookkeeping, and a resume point.

Straight-line source:

```text
connect
co_await -------- suspend 1
send
co_await -------- suspend 2
confirm
co_return
```

Generated shape:

```text
coroutine frame
+---------------------------+
| parameters and live locals|
| state = 0, 1, 2, or done  |
+---------------------------+
      resume() |   resume()
               v
 state 0 -> [suspend 1] -> state 1 -> [suspend 2] -> state 2
```

The complete frame lifecycle includes two edges that the state-machine picture alone does not show:

```text
call coroutine
      |
      v
allocate frame -> construct promise/parameters
      |
      v
initial_suspend
      |
      +---- resume <---- external event / scheduler
      |         |
      |         +---- co_await suspends ----+
      |                                      |
      +--------------------------------------+
      |
      v
co_return or unhandled_exception
      |
      v
final_suspend ---- result remains observable
      |
      v
owner calls destroy()
      |
      v
destroy live frame objects -> destroy promise -> release frame storage
```

`final_suspend` does not destroy the frame. It gives the return object or continuation a chance to observe completion before the owner eventually calls `destroy()`. RAII members stored in the frame live across suspension and are destroyed only when control leaves their scope during execution or when the suspended frame itself is destroyed.

The frame is the compiler-generated callback context. Calling `resume()` enters the state machine at its saved point, so source code can retain the order of the synchronous algorithm.

Value parameters become values owned by the frame. A local that must survive a suspension also resides there; a local used only before suspension may remain in a register or disappear under optimization. Reference parameters remain references, which makes their external lifetime part of the coroutine's contract.

The nested callback submission from earlier becomes:

```cpp
Task<Confirmation> submit_order(AsyncGateway& gateway, Order order) {
    Connection connection = co_await gateway.connect();
    co_await gateway.send(connection, order);
    co_return co_await gateway.confirm(connection);
}
```

`Task` is the coroutine return type, defined at working depth in the next section. The gateway operations return awaitable objects supplied by an asynchronous I/O library.

Suspension does not imply a thread block. The coroutine returns control to its caller or scheduler; an event source later resumes the frame. It also does not imply a new thread: the component that calls `resume()` determines the execution thread.

## The promise type, awaiters, and the frame

Every coroutine return type selects a nested `promise_type`. This coroutine promise is unrelated to `std::promise`; it is the compiler-facing policy object embedded in the coroutine frame.

The following minimal `Task<T>` starts lazily, stores one result or exception, and owns the frame with RAII. Its `get()` is a synchronous driver suitable for this minimal task; a production asynchronous task arranges resumption through its awaited operations rather than repeatedly calling `resume()`.

```cpp
#include <coroutine>
#include <exception>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <utility>

template<class T>
class Task {
public:
    struct promise_type;
    using Handle = std::coroutine_handle<promise_type>;

    struct promise_type {
        std::optional<T> value;
        std::exception_ptr error;

        Task get_return_object() { // gives the caller a frame owner
            return Task{Handle::from_promise(*this)};
        }

        std::suspend_always initial_suspend() noexcept { // lazy start
            return {};
        }

        std::suspend_always final_suspend() noexcept { // owner reads before destroy
            return {};
        }

        void return_value(T result) { // handles co_return expression
            value.emplace(std::move(result));
        }

        void unhandled_exception() noexcept { // preserves original failure
            error = std::current_exception();
        }
    };

    explicit Task(Handle handle) : handle_(handle) {}
    Task(const Task&) = delete;
    Task& operator=(const Task&) = delete;

    Task(Task&& other) noexcept
        : handle_(std::exchange(other.handle_, {})) {}

    ~Task() {
        if (handle_) {
            handle_.destroy();
        }
    }

    T get() {
        if (!handle_) {
            throw std::logic_error{"empty task"};
        }
        while (!handle_.done()) {
            handle_.resume();
        }
        if (handle_.promise().error) {
            std::rethrow_exception(handle_.promise().error);
        }
        return std::move(*handle_.promise().value);
    }

private:
    Handle handle_;
};

Task<int> answer() {
    co_return 42;
}

int main() {
    Task<int> task = answer();
    std::cout << task.get() << '\n';  // prints: 42
}
```

The compiler's contract with `promise_type` is:

1. Allocate the frame and construct its promise.
2. Obtain the return object through `get_return_object()`.
3. Consult `initial_suspend()` before running the body.
4. Route `co_return value` through `return_value()`.
5. Route an escaping exception through `unhandled_exception()`.
6. Consult `final_suspend()` before the completed frame may be destroyed.

`final_suspend()` must be `noexcept`. Returning `std::suspend_always` keeps the completed frame alive until the owning `Task` reads its result and calls `destroy()`. Returning `std::suspend_never` here would let the frame destroy itself and leave this owning handle dangling.

The `co_await expression` protocol converts the expression to an **awaiter**, then calls three operations:

| Awaiter operation | Question it answers |
|---|---|
| `await_ready()` | Can execution continue without suspension? |
| `await_suspend(handle)` | After suspension, who stores or resumes this coroutine? |
| `await_resume()` | What is the value of the `co_await` expression? |

This awaiter always has a cached result, so suspension is skipped:

```cpp
struct CachedPrice {
    double value;

    bool await_ready() const noexcept {
        return true;
    }

    void await_suspend(std::coroutine_handle<>) const noexcept {}

    double await_resume() const noexcept {
        return value;
    }
};

Task<double> read_cached_price() {
    double price = co_await CachedPrice{101.25};
    co_return price;
}
```

`std::suspend_always` and `std::suspend_never` are tiny standard awaiters implementing this same triple. A real I/O awaiter usually returns `false` from `await_ready()`, registers the coroutine handle with a reactor in `await_suspend()`, and obtains the completed result in `await_resume()`.

`await_suspend()` may return `void`, `bool`, or another coroutine handle. `void` commits to suspension; `bool` can cancel the suspension by returning `false`. Returning another `std::coroutine_handle` performs **symmetric transfer**: execution resumes that coroutine without growing the ordinary call stack. Production `Task` types use this to connect parent and child continuations.

### Frame allocation

Unless allocation is elided, entering a coroutine calls an allocation function for a compiler-chosen frame size. The default allocation function normally reaches the heap.

The compiler may apply heap allocation elision optimization, often called HALO, when it proves that the frame's lifetime is nested within the caller and knows its size at the call site. This is an optimization, not a language guarantee; verify it in generated code using the Compiler Explorer habit from Chapter 1.

A promise can route frame allocation to a pool using the allocation hooks from Chapter 17:

```cpp
class FramePool {
public:
    void* allocate(std::size_t bytes);
    void deallocate(void* pointer, std::size_t bytes) noexcept;
};

extern FramePool frame_pool;

struct promise_type {
    static void* operator new(std::size_t bytes) {
        return frame_pool.allocate(bytes);
    }

    static void operator delete(void* pointer, std::size_t bytes) noexcept {
        frame_pool.deallocate(pointer, bytes);
    }
};
```

This hook provides a bounded, warmed allocation path when the pool does. It does not remove the frame or its lifetime requirements.

Destroying a suspended frame runs destructors for live objects stored in it, then releases the frame allocation. It does not run the rest of the coroutine body. This is why the return object must have unambiguous ownership of the handle and why cancellation-aware awaiters must detach any external registration before destruction.

**Rule.** A coroutine handle is a non-owning access path to a frame. Never resume a completed or destroyed frame; doing so has undefined behavior.

**Pitfall.** Reference parameters stored in a suspended frame remain references, not owned copies. If the coroutine outlives the caller's argument, resumption reads a dangling object.

## `std::generator`

`std::generator<T>` **(C++23)** packages a lazy, single-pass sequence. `co_yield` publishes one element and suspends; advancing the iterator resumes the generator until it yields again or finishes.

```cpp
#include <generator>
#include <span>

struct RawTick {
    int price_ticks;
};

struct Tick {
    double price;
};

Tick decode(RawTick raw) {
    return Tick{raw.price_ticks / 100.0};
}

void consume(Tick tick);
bool interesting(Tick tick);

std::generator<Tick> replay(std::span<const RawTick> input) {  // C++23
    for (RawTick raw : input) {
        co_yield decode(raw);
    }
}

void inspect(std::span<const RawTick> input) {
    for (Tick tick : replay(input)) {
        consume(tick);
        if (interesting(tick)) {
            break;  // decodes only the ticks actually consumed
        }
    }
}
```

The range-for machinery from Chapter 13 repeatedly resumes one generator frame. It does not first build a `std::vector<Tick>`, and it does not allocate once per yielded element. The frame itself normally requires one allocation unless allocation elision applies.

`std::generator` is move-only and single-pass. Incrementing its iterator resumes the producer and may overwrite storage used for the previous yielded value.

**Note.** `std::generator` is in C++23, but standard-library delivery lags compiler language support; check the `<generator>` header in the deployment toolchain.

**Pitfall.** A reference yielded from a loop-local object is valid only while that object remains alive, often only until the next resume. Copy a yielded value before advancing if it must survive.

## Executors, senders, and structured concurrency

Futures and coroutines say how a result is represented and how control suspends. Neither mechanism alone says where work runs.

An **execution context** owns execution resources, such as the persistent workers in Chapter 23's thread pool. A **scheduler** is a lightweight handle used to place work onto that context. An executor-oriented design makes scheduling a parameter rather than a hidden choice.

Senders and receivers in `std::execution` **(C++26)** standardize a composable model:

- A **sender** describes work that has not started.
- A **receiver** provides completion slots for a value, an error, or cancellation.
- Connecting them creates an operation state; starting that state begins work.

```text
 sender: description of work
             |
          connect
             v
     [ operation state ] -- start --> scheduler / execution context
             |
             +--> receiver.set_value(...)
             +--> receiver.set_error(...)
             `--> receiver.set_stopped()
```

A representative pipeline has this shape:

```cpp
// C++26: sender/receiver API; exact library availability may vary.
runtime::StaticThreadPool pool{4};  // implementation-provided context
auto scheduler = pool.get_scheduler();

auto work =
    std::execution::then(
        std::execution::schedule(scheduler),
        [] { return compute_risk_snapshot(); });

auto result = std::this_thread::sync_wait(std::move(work));
```

The sender expression builds a description as a value; it does not run `compute_risk_snapshot()`. A sender pipeline can avoid the mandatory separately allocated shared state of a future, though an implementation or a particular operation may still allocate when connected or started.

**Note.** Sender/receiver facilities are C++26 and are still arriving in standard libraries. `static_thread_pool` is a common library-provided context, not a standard C++26 type; the standard execution library provides scheduler concepts and standard scheduler facilities, while concrete runtime integration varies by implementation.

The three completion channels clarify the model:

| Mechanism | Value channel | Error channel | Cancellation channel |
|---|---|---|---|
| Future | Shared-state value | Stored exception | No built-in channel |
| Callback | Callback parameters | Convention or second callback | Convention or token |
| Sender/receiver | `set_value` | `set_error` | `set_stopped` |

Structured concurrency makes child-operation lifetimes nest within their parent's scope. Child failures and cancellation travel along the same ownership edges. It is the asynchronous analogue of RAII from Chapter 5 and exception propagation from Chapter 6: work cannot silently outlive the scope responsible for it.

**Pitfall.** A sender is an inert description, not a running future. Building a pipeline performs no scheduled work until code connects and starts it, directly or through an algorithm such as `sync_wait`.

## Async I/O and the verdict

Coroutine-based I/O keeps session logic linear while a reactor owns readiness notification. ASIO and Linux `io_uring` are examples of the surrounding machinery; their socket and reactor mechanics belong to *Networking for Low-Latency Systems*.

```cpp
Task<std::size_t> run_gateway(AsyncSocket& socket) {
    std::size_t messages = 0;

    while (auto message = co_await socket.read()) {
        Reply reply = handle_message(*message);
        co_await socket.write(reply);  // suspension parks this session in reactor
        ++messages;
    }

    co_return messages;
}
```

One thread can service many sessions because an idle session occupies a parked coroutine frame rather than a blocked thread and stack. The reactor resumes the frame when the socket becomes ready.

The appropriate mechanism depends on both composability and cost:

| Technique | Composability | Allocation profile | Error propagation | Hot-path verdict |
|---|---|---|---|---|
| Thread + future | Moderate | Shared state; thread or pool task | Exception through `get()` | Keep off tick path |
| Callback | Low for sequences | Can be allocation-free with fixed storage | Explicit convention | Viable if tightly controlled |
| Coroutine | High, straight-line | Usually one frame per operation/session | Promise stores exception | Good for orchestration, not tick loop |
| Sender-based | High, pipeline algebra | Can avoid future shared state | Value/error/stopped channels | Promising with measured implementation |

Coroutines fit connection logic, startup sequencing, administration, and other orchestration where an outstanding operation waits more than it computes. They are usually the wrong shape for a hot tick-to-trade loop: frame allocation must be eliminated or pooled, resume uses an indirect control transfer, and code splits across resume points in the instruction cache.

An awaiter can return `true` from `await_ready()` and keep execution on the synchronous fast path. That measurement does not represent the cost of actual suspension, scheduler registration, and later resumption.

**Rule.** Choose an asynchronous abstraction for the path it actually runs on. Keep blocking shared states and frame allocation out of the tick path; use coroutines where their state-machine structure replaces blocked threads or tangled continuations.

## Latency Lens

- A promise/future pair normally creates a separately allocated, reference-managed shared state; `get()` is a blocking rendezvous, so neither mechanism belongs on a tick path.
- `std::async` can spawn one thread per `std::launch::async` call, and a discarded future waits in its destructor, silently serializing consecutive statements.
- Coroutine frames use dynamic allocation unless the compiler proves allocation elision; inspect generated code for HALO, or use a pool-backed promise allocation hook for a bounded path.
- Each actual `co_await` suspension stores state and later resumes through an indirect transfer, adding branch-predictor and instruction-cache costs absent from straight-line code.
- `std::generator<T>` normally uses one frame allocation for the sequence and no allocation per element, unlike materializing every result in a container.
- Cancellation is cooperative, so cancel latency follows the polling interval; a `stop_callback` turns a request into a wake only at waits wired to it.
- Completion, stop, and deadline callbacks need one terminal-state arbitration; every extra contender adds registration and atomic work even when cancellation is rare.
- Callback and sender pipelines can be allocation-free descriptions until start, while a future requires shared state for its result channel.
- A coroutine-per-session design keeps each idle connection as one parked frame; it saves blocked thread stacks, but the reactor controls resumption order.
