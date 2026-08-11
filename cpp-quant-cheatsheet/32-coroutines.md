# 32. Coroutines

*Part V — Concurrency and the memory model*

---

**Recall**
- A function is a coroutine iff its body contains `co_await`, `co_yield`, or `co_return`; the declared return type is unrelated to `co_return`'s operand type.
- The compiler picks the promise via `std::coroutine_traits<Ret, Args...>::promise_type`, which by default is `Ret::promise_type`.
- The frame holds the promise, by-value parameter copies, and every local/temporary whose lifetime crosses a suspension point — layout is implementation-defined.
- Coroutines are a *transformation*, not a runtime: no thread, no scheduler, no concurrency is created by `co_await`.
- `initial_suspend()` decides eager (`suspend_never`) vs lazy (`suspend_always`) start; `final_suspend()` decides who observes completion and destroys the frame.
- `final_suspend()` must be `noexcept`; resuming a coroutine suspended at final suspend is UB.
- `std::coroutine_handle` is a non-owning, trivially copyable pointer-sized token — exactly one protocol must own `resume()`/`destroy()`.
- `co_await e` becomes `await_transform` (if the promise has one) → `operator co_await` (if any) → awaiter, then `await_ready`/`await_suspend`/`await_resume`.
- The coroutine is *fully suspended* before `await_suspend` runs, so publishing the handle there is an ownership handoff: it may be resumed and destroyed before `await_suspend` returns.
- `await_suspend` returning `void` stays suspended, `bool` false resumes immediately, a handle performs **symmetric transfer** (tail-call, no stack growth).
- `co_yield v` is exactly `co_await promise.yield_value(v)`.
- A promise declares `return_void()` **or** `return_value(T)`, never both.
- Frame allocation is normally dynamic (`operator new` — promise-level overload wins) but the compiler may elide it when the frame lifetime is strictly nested in the caller; elision is never guaranteed.
- If the promise defines `get_return_object_on_allocation_failure()`, the non-throwing `operator new` form is used and failure returns that object instead of throwing `bad_alloc`.
- Exceptions escaping the body go to `promise.unhandled_exception()`; exceptions from `await_ready`/`await_resume` propagate inside the body normally.
- `std::stop_token` cancels nothing by itself — the awaitable must arbitrate `pending → completed XOR cancelled` with exactly one resume.
- By-value coroutine parameters are copied into the frame; references, `span`, `string_view`, pointers, and iterators remain borrowed and must outlive every suspension.
- Coroutine lambdas are hazardous: the frame keeps the closure's `this`, so a dead closure dangles its captures.
- `std::generator<Ref, V, Alloc>` (C++23) is a lazy **synchronous** pull generator with recursive `yield elements of` support.
- Suspension is cheaper than blocking an OS thread but is not free: measure frame allocations, frame size, enqueue hops, and cache migration.

---

## 32.1 Coroutine vocabulary: promise, frame, handle, awaiter, and awaitable

```text
call f(args)
  │ allocate frame (promise::operator new or elided)
  │ copy/move by-value params into frame; construct promise
  ▼
promise.get_return_object()          ──► object handed to the caller
  ▼
co_await promise.initial_suspend()   ──► suspend here => lazy; else run body
  ▼
body: co_await / co_yield / co_return / exception
  ├ co_await e   → awaiter.await_ready / await_suspend / await_resume
  ├ co_yield v   → co_await promise.yield_value(v)
  ├ co_return v  → promise.return_value(v)  |  co_return; → promise.return_void()
  └ throw        → promise.unhandled_exception()
  ▼
co_await promise.final_suspend()     ──► noexcept; normally suspends
  ▼
handle.destroy()  → locals, promise, param copies destroyed; operator delete
```

| Term | One-line meaning |
|---|---|
| Coroutine | Function whose body uses `co_await`/`co_yield`/`co_return`; compiler-transformed |
| Frame | Storage surviving suspension: promise + param copies + live locals + resume index |
| Promise type | Customization object inside the frame; controls every lifecycle point |
| Return object | What the *caller* receives, built by `get_return_object()` |
| `coroutine_handle<P>` | Non-owning token: `resume`, `destroy`, `done`, `promise`, `address` |
| Awaitable | Expression usable with `co_await` after `await_transform`/`operator co_await` |
| Awaiter | Object with `await_ready`/`await_suspend`/`await_resume` |
| Suspension point | Where the frame is consistent and the handle may be resumed |

```cpp
#include <coroutine>
// Restrictions on coroutine bodies:
//   no plain `return` statement           (use co_return)
//   no variadic `...` parameter pack of C style
//   cannot be constexpr / consteval
//   cannot be a constructor or destructor
//   cannot have a deduced (auto) return type
//   main() cannot be a coroutine
```

**The complete `promise_type` reference — every customization point**

```cpp
struct promise_type {
    // ---- REQUIRED -----------------------------------------------------
    Task get_return_object();                    // built first; handed to caller
    /* Awaitable */ initial_suspend();           // suspend_always => lazy
    /* Awaitable */ final_suspend() noexcept;    // MUST be noexcept
    void unhandled_exception();                  // body threw; usually current_exception()

    // exactly ONE of these two, never both:
    void return_void();                          // for `co_return;` / falling off end
    void return_value(T v);                      // for `co_return expr;`

    // ---- OPTIONAL ------------------------------------------------------
    // enables co_yield; result is co_await-ed
    std::suspend_always yield_value(T v);
    // C++23 generator-style recursive yield helper (library-side, not language)

    // intercepts every co_await in the body (NOT initial/final/yield awaits)
    template<class U> auto await_transform(U&& u);
    // define as `= delete` for U to BAN co_await of that type in this coroutine

    // frame allocation control (promise-scope overloads win over global ones)
    static void* operator new(std::size_t n);
    static void* operator new(std::size_t n, std::nothrow_t) noexcept;
    // placement form: receives copies of the coroutine's own arguments
    template<class... Args>
    static void* operator new(std::size_t n, Allocator& a, Args&&...);
    static void  operator delete(void* p) noexcept;
    static void  operator delete(void* p, std::size_t n) noexcept; // sized

    // if present, allocation uses the nothrow new and returns this on failure
    static Task get_return_object_on_allocation_failure();
};
```

| Member | When called | Notes |
|---|---|---|
| `get_return_object()` | once, before `initial_suspend` | typically `from_promise(*this)` |
| `initial_suspend()` | immediately after | `suspend_never` = eager, `suspend_always` = lazy |
| `final_suspend() noexcept` | after `co_return`/fall-off | suspend ⇒ owner must `destroy()`; no-suspend ⇒ self-destroys |
| `return_value(v)` / `return_void()` | at `co_return` | mutually exclusive |
| `unhandled_exception()` | body exception escapes | rethrowing here propagates out of `resume()` |
| `yield_value(v)` | each `co_yield` | must return an awaitable |
| `await_transform(u)` | each body `co_await` | presence disables raw awaitables unless overloaded |
| `operator new/delete` | frame alloc/dealloc | placement form gets the function's arguments |
| `get_return_object_on_allocation_failure()` | alloc failed | switches to `nothrow` allocation |

```cpp
// Promise-type selection is via coroutine_traits — specialize to add a promise
// to a return type you do not own (e.g. member coroutines returning std::future):
template<class... Args>
struct std::coroutine_traits<MyResult, Args...> { using promise_type = MyPromise; };
```

**Traps** — forgetting `noexcept` on `final_suspend` is ill-formed · declaring both `return_void` and `return_value` is ill-formed · `get_return_object()` runs *before* the body, so it cannot see results · `await_transform` silently applies to *every* `co_await` in the body.

---

## 32.2 `co_await`, `co_yield`, and `co_return` transformation model

```cpp
// ---- co_await expansion (conceptual) ---------------------------------
// 1. awaitable = has await_transform ? promise.await_transform(expr) : expr
// 2. awaiter   = has operator co_await ? awaitable.operator co_await() : awaitable
{
    auto&& awaiter = get_awaiter(expr);
    if (!awaiter.await_ready()) {           // false => suspend
        // <coroutine is now FULLY suspended; frame is consistent>
        using R = decltype(awaiter.await_suspend(h));
        if constexpr (std::is_void_v<R>)          { awaiter.await_suspend(h); return_to_caller(); }
        else if constexpr (std::is_same_v<R,bool>){ if (awaiter.await_suspend(h)) return_to_caller(); }
        else                                      { awaiter.await_suspend(h).resume(); } // tail call
        resume_point:;
    }
    result = awaiter.await_resume();        // ALWAYS runs, ready or not
}

// ---- co_yield expansion ----------------------------------------------
co_yield v;            // ⟺ co_await promise.yield_value(v);

// ---- co_return expansion ---------------------------------------------
co_return;             // ⟺ promise.return_void();      then goto final_suspend
co_return expr;        // ⟺ promise.return_value(expr);  then goto final_suspend
co_return f();         // ⟺ promise.return_value(f())   — f() runs BEFORE the store
// falling off the end of a body ⟺ co_return;  (requires return_void)
```

**Full awaiter protocol**

| Member | Signature | Effect |
|---|---|---|
| `await_ready` | `bool await_ready() const noexcept` | `true` ⇒ skip suspension *and* `await_suspend`; `await_resume` still runs |
| `await_suspend` | `void await_suspend(std::coroutine_handle<P>)` | Stay suspended; control returns to caller/resumer |
| | `bool await_suspend(...)` | `true` = stay suspended; `false` = resume this coroutine immediately |
| | `std::coroutine_handle<> await_suspend(...)` | Symmetric transfer: resume *that* handle via a tail call |
| | `std::noop_coroutine_handle await_suspend(...)` | Return to the resumer's loop without resuming anything |
| `await_resume` | `T await_resume()` | Produces the value of `co_await`; may throw into the body |

```cpp
// ---- every awaitable spelling ----------------------------------------
struct Awaiter {                                  // 1. awaiter directly
    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<>) const noexcept {}
    int  await_resume() const noexcept { return 7; }
};

struct Awaitable {                                // 2. member operator co_await
    Awaiter operator co_await() const noexcept { return {}; }
};

Awaiter operator co_await(SomeType const&) noexcept;   // 3. free operator co_await

struct Promise {                                  // 4. promise await_transform
    Awaiter await_transform(SomeType) { return {}; }
    void    await_transform(std::chrono::seconds) = delete;  // ban this await
};

// ---- the standard trivial awaiters -----------------------------------
struct suspend_never  { bool await_ready() const noexcept { return true;  }
                        void await_suspend(std::coroutine_handle<>) const noexcept {}
                        void await_resume() const noexcept {} };
struct suspend_always { bool await_ready() const noexcept { return false; }
                        void await_suspend(std::coroutine_handle<>) const noexcept {}
                        void await_resume() const noexcept {} };
```

```cpp
// ---- awaiter that hands the handle to an executor ---------------------
struct ScheduleOn {
    Executor& ex;
    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) const {
        ex.enqueue(h);        // OWNERSHIP HANDOFF: h may run+destroy before we return
        // touching *this or the frame after this line is use-after-free
    }
    void await_resume() const noexcept {}
};

// ---- awaiter returning a value and rethrowing on the resume path ------
struct AwaitResult {
    std::optional<int> value; std::exception_ptr err;
    bool await_ready() const noexcept { return value || err; }
    bool await_suspend(std::coroutine_handle<> h) { return start(h); } // false = ready now
    int  await_resume() { if (err) std::rethrow_exception(err); return *value; }
};
```

**`std::coroutine_handle` API**

```cpp
std::coroutine_handle<>          erased;               // type-erased, promise-less
std::coroutine_handle<P>         typed;                // knows the promise type
typed = std::coroutine_handle<P>::from_promise(p);     // promise&  → handle
P&    p2 = typed.promise();                            // handle    → promise&
void* raw = typed.address();                           // handle    → void*
auto  back = std::coroutine_handle<P>::from_address(raw);
std::coroutine_handle<> up = typed;                    // implicit upcast (lossy)
```

| Operation | Signature | Precondition / notes |
|---|---|---|
| `resume()` / `operator()()` | `void` | suspended, not at final suspend, not running; O(1) indirect jump |
| `destroy()` | `void` | suspended and not already destroyed; runs frame dtors + `operator delete` |
| `done()` | `bool` | valid only if suspended; `true` ⇔ at final suspend |
| `operator bool()` | `bool` | non-null handle — says nothing about frame validity |
| `promise()` | `P&` | typed handles only; UB after `destroy()` |
| `address()` | `void*` | opaque frame address; round-trips via `from_address` |
| `from_address(void*)` | static | must come from `address()` of the same specialization |
| `from_promise(P&)` | static | promise must live in a coroutine frame |
| `operator==` / `<=>` | | compares addresses (C++20) |
| `std::noop_coroutine()` | `noop_coroutine_handle` | `resume()` returns, `destroy()` is a no-op, `done()` is `false` |
| `std::hash<coroutine_handle<P>>` | | usable as a map key |

**Traps** — handles are non-owning and copies do not refcount · `done()` on a *running* handle is UB · double `destroy()` is UB · `resume()` after final suspend is UB · a `coroutine_handle<>` compares equal to a `coroutine_handle<P>` for the same frame but cannot reach `promise()`.

---

## 32.3 Initial/final suspend and coroutine lifetime

| `initial_suspend()` returns | Start semantics |
|---|---|
| `std::suspend_never` | **Eager**: body runs during the call, up to the first real suspension |
| `std::suspend_always` | **Lazy**: caller gets a suspended coroutine; someone must `resume()`/`co_await` it |
| custom awaiter | Start on an executor / hop threads before the first statement |

| `final_suspend()` returns | Completion semantics |
|---|---|
| `std::suspend_always` | Frame stays alive; `done() == true`; the **owner must `destroy()`** |
| `std::suspend_never` | Frame self-destroys as the body completes; every retained handle dangles |
| awaiter returning a handle | Symmetric transfer to the continuation, then owner destroys |

```cpp
// ---- lazy: nothing runs until resumed --------------------------------
Task<int> lazy() { std::puts("body"); co_return 1; }
auto t = lazy();        // prints nothing
t.run();                // prints "body"

// ---- eager: fire-and-forget, self-cleaning ---------------------------
struct DetachedTask {
    struct promise_type {
        DetachedTask get_return_object() noexcept { return {}; }
        std::suspend_never initial_suspend() const noexcept { return {}; } // run now
        std::suspend_never final_suspend()   const noexcept { return {}; } // self-destroy
        void return_void() noexcept {}
        void unhandled_exception() noexcept { std::terminate(); } // nobody can observe it
    };
};
// No handle is retained anywhere => nothing can resume or destroy it twice.
```

```cpp
// ---- lifetime state machine ------------------------------------------
// created ──initial_suspend──► suspended ──resume()──► running
//     running ──co_await(suspend)──► suspended
//     running ──co_return──► final_suspend ──► suspended&&done()
//     suspended ──destroy()──► destroyed  (locals + promise + params destroyed)
//
// VALID:   resume(suspended && !done())   destroy(suspended)
// UB:      resume(running) resume(done()) destroy(running) *anything*(dangling)
```

**Interview line** — "Normally suspend at final suspend so the owner or continuation can observe completion and pick the moment of destruction; only a detached, self-destroying coroutine may skip it."

**Traps** — a lazy coroutine that nobody awaits leaks its frame silently · `final_suspend` that doesn't suspend makes `done()` unobservable and every stored handle dangling · destroying a frame suspended inside `await_suspend`'s publication window races the resumer.

---

## 32.4 Frame allocation and allocation elision

**Frame contents**
- promise object;
- copies/moves of by-value parameters, and the *references themselves* for reference parameters;
- locals and temporaries whose lifetime spans a suspension point;
- the resume/destroy function pointers (or a resume index) and suspension state;
- often the awaiter objects for in-flight `co_await`s.

```cpp
Task<void> send(std::string message, Socket& socket) {   // message: OWNED by frame
    co_await writable(socket);                           // socket: still a reference
    co_await async_send(socket, message);                // socket must outlive both awaits
}

Task<void> process(BigBuffer& b) {
    { LargeTemporary tmp = prepare(b); consume_now(tmp); } // dies before any suspension
    co_await next_event();                                 // => tmp need not be in the frame
}
```

```cpp
// ---- promise-level allocator control ---------------------------------
struct promise_type {
    static void* operator new(std::size_t n) { return FramePool::alloc(n); }
    static void  operator delete(void* p, std::size_t n) noexcept { FramePool::free(p, n); }

    // placement form: receives the coroutine's OWN arguments (leading-allocator style)
    template<class... Args>
    static void* operator new(std::size_t n, std::pmr::memory_resource* mr, Args&&...) {
        void* p = mr->allocate(n + sizeof(mr), alignof(std::max_align_t));
        std::memcpy(static_cast<std::byte*>(p) + n, &mr, sizeof(mr)); // stash for delete
        return p;
    }
    static void operator delete(void* p, std::size_t n) noexcept { /* recover mr, free */ }

    // nothrow path
    static void* operator new(std::size_t n, std::nothrow_t) noexcept { return std::malloc(n); }
    static Task get_return_object_on_allocation_failure() { return Task{nullptr}; }
};
// Called as:  Task<int> job(std::pmr::memory_resource* mr, int x);
```

| Fact | Consequence |
|---|---|
| Frame size is fixed at compile time | but is implementation-defined and not queryable portably |
| Allocation uses `promise::operator new` if present, else global `::operator new` | sized delete is preferred when declared |
| HALO (Heap Allocation eLision Optimization) is *permitted*, not required | needs inlining + strictly nested frame lifetime + known size |
| `-O0`/debug builds essentially never elide | never claim "zero allocation" without checking the build you ship |
| A coroutine whose handle escapes cannot be elided | fire-and-forget, executors, and type-erased tasks defeat HALO |
| Pool allocators must handle alignment, sized delete, and cross-thread free | completion may run on another thread than the call |

```bash
# Verify elision, do not assume it
clang++ -std=c++23 -O2 -Rpass=coro-elide -c task.cpp   # clang remark on elided frames
g++     -std=c++23 -O2 -fdump-tree-optimized task.cpp  # look for the frame alloc call
nm -C a.out | grep -i 'operator new'                   # global operator new interposition
# or override ::operator new in a test binary and count coroutine-sized allocations
```

**Traps** — "coroutines are zero-cost" is false by default · reducing live-across-suspend state shrinks the frame but layout is unspecified · `operator delete` must match the `operator new` that actually ran (including the nothrow path) · a placement `operator new` has *no* matching placement delete call on normal destruction — only on constructor failure.

---

## 32.5 Symmetric transfer and continuation scheduling

```cpp
// A completes → resume its awaiting parent B WITHOUT growing the stack.
struct FinalAwaiter {
    bool await_ready() const noexcept { return false; }      // always suspend
    void await_resume() const noexcept {}

    template<class Promise>
    std::coroutine_handle<> await_suspend(std::coroutine_handle<Promise> h) const noexcept {
        auto k = h.promise().continuation;
        return k ? k : std::noop_coroutine();   // tail-transfer; noop = return to resumer
    }
};
```

```text
recursive resume (BAD)              symmetric transfer (GOOD)
resume(A)                           resume(A)
 └ resume(B)                          A finishes → tail-jump → B
    └ resume(C)                       B finishes → tail-jump → C
       └ ...  stack grows O(depth)    stack depth stays O(1)
```

```cpp
// The awaiter that hooks a child task into its parent:
struct TaskAwaiter {
    std::coroutine_handle<promise_type> child;
    bool await_ready() const noexcept { return !child || child.done(); }
    std::coroutine_handle<> await_suspend(std::coroutine_handle<> parent) noexcept {
        child.promise().continuation = parent;  // publish BEFORE starting the child
        return child;                           // symmetric transfer INTO the child
    }
    T await_resume() { return child.promise().result(); }
};
```

| Return of `await_suspend` | Machine effect |
|---|---|
| `void` | `return` to whoever called `resume()` |
| `false` | resume the *current* coroutine inline (no suspension observed) |
| `true` | same as `void` |
| `coroutine_handle<>` h | `h.resume()` performed as a **guaranteed tail call** — no stack frame added |
| `std::noop_coroutine()` | tail-jump to a coroutine that immediately returns to the resumer |

- Transfer chooses *who runs next*; it does not choose *which thread* — that is the executor's job.
- Continuation scheduling and frame destruction are separate: destroying the child inside the wrong step invalidates the result the parent is about to read.
- Trampolining through a queue is the alternative when you must bound per-hop latency or cross threads.

**Interview line** — "Returning a handle from `await_suspend` is a symmetric transfer: the compiler emits a tail call, so a chain of a million immediately-completing tasks runs in constant stack."

---

## 32.6 Exceptions and cancellation in coroutine code

| Exception thrown by | Where it surfaces |
|---|---|
| frame allocation | `std::bad_alloc` from the *call*, unless `get_return_object_on_allocation_failure` |
| parameter copy into the frame | propagates from the call; frame is freed |
| `get_return_object()` / `initial_suspend()` | propagates from the call, before the body |
| the coroutine **body** | caught by the transform → `promise.unhandled_exception()` → `final_suspend` |
| `await_ready()` / `await_resume()` | inside the body: catchable by a `try` in the coroutine |
| `await_suspend()` | coroutine is resumed and the exception propagates in the body |
| `unhandled_exception()` rethrowing | propagates out of the `resume()` call that was running the body |
| `final_suspend()` | ill-formed — it is required `noexcept` |

```cpp
// ---- capture-and-rethrow (the standard promise idiom) ----------------
void unhandled_exception() noexcept { error_ = std::current_exception(); }
T    result() { if (error_) std::rethrow_exception(error_); return std::move(*value_); }

// ---- errors as values on hot paths (an API choice, not a language one) --
struct promise_type {
    std::expected<int, ErrorCode> slot;
    void return_value(std::expected<int, ErrorCode> v) { slot = std::move(v); }
    void unhandled_exception() noexcept { slot = std::unexpected{ErrorCode::exception}; }
};
```

```cpp
// ---- try/catch works normally across suspension ----------------------
Task<int> guarded() {
    try { co_return co_await risky(); }        // await_resume may throw here
    catch (std::exception const& e) { log(e.what()); co_return -1; }
}
// co_await inside a catch handler is legal; the in-flight exception object stays
// alive in the frame until the handler exits, so it survives the suspension.
```

**Cancellation is a protocol, not a keyword**

```cpp
Task<void> consume(std::stop_token stop) {
    while (!stop.stop_requested()) {
        auto event = co_await next_event(stop);   // the AWAITABLE integrates the token
        if (!event) co_return;                    // API defines stopped vs closed vs error
        apply(*event);
    }
}
```

```cpp
// One-winner cancellable awaiter skeleton
class CancellableOp {
    std::atomic<int> state_{0};                   // 0 pending, 1 completed, 2 cancelled
    std::coroutine_handle<> h_{};
    std::optional<std::stop_callback<Fn>> cb_;
public:
    bool await_ready() const noexcept { return token_.stop_requested(); } // fast path
    bool await_suspend(std::coroutine_handle<> h) {
        h_ = h;
        cb_.emplace(token_, [this] { if (claim(2)) h_.resume(); }); // may fire inline!
        if (!start_io()) { cb_.reset(); return false; }             // resume inline
        return true;
    }
    Result await_resume() { cb_.reset(); return state_ == 2 ? Result::cancelled : value_; }
private:
    bool claim(int w) { int e = 0; return state_.compare_exchange_strong(e, w,
                            std::memory_order_acq_rel, std::memory_order_acquire); }
};
```

- A cancellable await must: check an already-requested stop; register/deregister its callback safely; race cancellation against completion with exactly one atomic winner; withdraw queued I/O or timers; and define the result value for each outcome.
- Destroying a task while an external operation still holds its handle is use-after-free unless destruction first cancels **and synchronously deregisters**, or the callback owns shared state instead of the frame.
- Destroying a suspended coroutine runs the destructors of live frame objects — it is not stack unwinding, and those destructors must not throw.
- Cancellation semantics must state whether partial effects remain, whether children are joined, and on which executor the continuation resumes.

**Traps** — `stop_token` alone cancels nothing · a `stop_callback` can fire *inside* `await_suspend` on the requesting thread · resuming from both the completion and the cancellation path is a double resume (UB) · `unhandled_exception()` in a detached coroutine has no observer, so `terminate()` is often the honest choice.

---

## 32.7 Lazy tasks and C++23 `std::generator`

**Complete working lazy `task<T>` with symmetric transfer**

```cpp
#include <coroutine>
#include <exception>
#include <utility>
#include <variant>

template <class T>
class task {
public:
    struct promise_type;
    using handle_type = std::coroutine_handle<promise_type>;

    struct promise_base {
        std::coroutine_handle<> continuation{};      // who resumes when we finish
        std::exception_ptr error{};

        std::suspend_always initial_suspend() noexcept { return {}; }   // LAZY

        struct final_awaiter {                                          // symmetric transfer
            bool await_ready() const noexcept { return false; }
            void await_resume() const noexcept {}
            template <class P>
            std::coroutine_handle<> await_suspend(std::coroutine_handle<P> h) noexcept {
                auto k = h.promise().continuation;
                return k ? k : std::noop_coroutine();
            }
        };
        final_awaiter final_suspend() noexcept { return {}; }           // MUST be noexcept
        void unhandled_exception() noexcept { error = std::current_exception(); }
    };

    struct promise_type : promise_base {
        std::variant<std::monostate, T> slot{};
        task get_return_object() noexcept { return task{handle_type::from_promise(*this)}; }
        template <class U = T>
        void return_value(U&& v) { slot.template emplace<1>(std::forward<U>(v)); }
        T&& result() && {
            if (this->error) std::rethrow_exception(this->error);
            return std::move(std::get<1>(slot));
        }
    };

    task() noexcept = default;
    explicit task(handle_type h) noexcept : h_{h} {}
    task(task const&) = delete;
    task& operator=(task const&) = delete;
    task(task&& o) noexcept : h_{std::exchange(o.h_, {})} {}
    task& operator=(task&& o) noexcept {
        if (this != &o) { if (h_) h_.destroy(); h_ = std::exchange(o.h_, {}); }
        return *this;
    }
    ~task() { if (h_) h_.destroy(); }                 // sole owner of the frame

    [[nodiscard]] bool done() const noexcept { return !h_ || h_.done(); }

    // ---- awaitable: co_await task<T> inside another coroutine --------
    auto operator co_await() && noexcept {
        struct awaiter {
            handle_type child;
            bool await_ready() const noexcept { return !child || child.done(); }
            std::coroutine_handle<> await_suspend(std::coroutine_handle<> parent) noexcept {
                child.promise().continuation = parent;   // publish first
                return child;                            // tail-jump into the child
            }
            T&& await_resume() { return std::move(child.promise()).result(); }
        };
        return awaiter{h_};
    }

    // ---- synchronous driver for the top of the call stack -------------
    T sync_wait() && {
        h_.resume();                                   // runs until final suspend
        return std::move(h_.promise()).result();
    }

private:
    handle_type h_{};
};

// void specialization differs only in return_void/result
template <>
struct task<void>::promise_type : task<void>::promise_base {
    task<void> get_return_object() noexcept {
        return task<void>{std::coroutine_handle<promise_type>::from_promise(*this)};
    }
    void return_void() noexcept {}
    void result() && { if (this->error) std::rethrow_exception(this->error); }
};

// ---- usage -----------------------------------------------------------
task<int> leaf(int x) { co_return x * 2; }
task<int> mid(int x)  { co_return co_await leaf(x) + 1; }   // symmetric transfer chain
int main() { return std::move(mid(20)).sync_wait(); }       // 41
```

**Complete hand-written `generator<T>`** (what `std::generator` gives you for free)

```cpp
#include <coroutine>
#include <iterator>

template <class T>
class generator {
public:
    struct promise_type {
        T const* value{};                 // points at the co_yield operand IN THE CALLER
        std::exception_ptr error{};

        generator get_return_object() noexcept {
            return generator{std::coroutine_handle<promise_type>::from_promise(*this)};
        }
        std::suspend_always initial_suspend() noexcept { return {}; }   // lazy
        std::suspend_always final_suspend()   noexcept { return {}; }   // owner destroys
        std::suspend_always yield_value(T const& v) noexcept { value = &v; return {}; }
        void return_void() noexcept {}
        void unhandled_exception() noexcept { error = std::current_exception(); }
        template <class U> std::suspend_never await_transform(U&&) = delete; // no co_await
    };

    class iterator {
        std::coroutine_handle<promise_type> h_{};
    public:
        using iterator_category = std::input_iterator_tag;
        using value_type = T; using difference_type = std::ptrdiff_t;

        iterator() noexcept = default;
        explicit iterator(std::coroutine_handle<promise_type> h) noexcept : h_{h} {}
        T const& operator*() const noexcept { return *h_.promise().value; }
        iterator& operator++() {
            h_.resume();
            if (h_.done()) { auto e = h_.promise().error; h_ = {}; if (e) std::rethrow_exception(e); }
            return *this;
        }
        void operator++(int) { ++*this; }
        bool operator==(std::default_sentinel_t) const noexcept { return !h_ || h_.done(); }
    };

    generator(generator&& o) noexcept : h_{std::exchange(o.h_, {})} {}
    ~generator() { if (h_) h_.destroy(); }

    iterator begin() {
        if (h_) { h_.resume();                                     // run to first co_yield
                  if (h_.done() && h_.promise().error) std::rethrow_exception(h_.promise().error); }
        return iterator{h_};
    }
    std::default_sentinel_t end() const noexcept { return {}; }

private:
    explicit generator(std::coroutine_handle<promise_type> h) noexcept : h_{h} {}
    std::coroutine_handle<promise_type> h_{};
};

generator<int> levels(int first, int count) {
    for (int i = 0; i < count; ++i) co_yield first + i;   // == co_await yield_value(...)
}
// for (int v : levels(100, 3)) consume(v);   // 100, 101, 102 — resumed on THIS thread
```

**`std::generator` (C++23, `<generator>`)**

```cpp
#include <generator>

// template<class Ref, class V = void, class Allocator = void> class generator;
std::generator<int>             ints();          // yields int&&, value_type int
std::generator<int const&>      by_ref();        // yields references into the coroutine
std::generator<Level&, Level>   levels();        // Ref = Level&, value_type = Level
std::generator<int, int, std::pmr::polymorphic_allocator<>> pooled(
        std::allocator_arg_t, std::pmr::polymorphic_allocator<>, int n);

std::generator<int> fib() {                      // infinite lazy sequence
    int a = 0, b = 1;
    while (true) { co_yield a; auto t = a + b; a = b; b = t; }
}

std::generator<int> flatten(Tree const& t) {
    if (t.left)  co_yield std::ranges::elements_of(flatten(*t.left));   // O(1) recursion
    co_yield t.value;                                                   // no per-level resume
    if (t.right) co_yield std::ranges::elements_of(flatten(*t.right));
}

for (int x : fib() | std::views::take(10)) use(x);   // it is an input_range/view
```

| Facility | Semantics |
|---|---|
| `generator<Ref, V, Alloc>` | move-only `view` modeling `input_range`; `value_type` = `V` or `remove_cvref_t<Ref>` |
| `begin()` | resumes to the first `co_yield`; calling twice is UB |
| `end()` | `std::default_sentinel_t` |
| `operator++` | resumes until the next yield or completion; O(1) per element plus body cost |
| `operator*` | reference to the yielded object (which lives in the *yielding* frame) |
| `co_yield ranges::elements_of(r)` | splices a nested range/generator without O(depth) per element |
| exceptions | escape the body → rethrown from `begin()`/`operator++` |
| allocator | pass via `std::allocator_arg` as the first two coroutine parameters |
| threading | **synchronous**: resumption happens on the iterating thread |

**Traps** — `std::generator` is not an async stream: no backpressure, no executor, no thread · iterating twice is UB (single-pass) · a yielded reference dangles after the next `++` or generator destruction · lazy means side effects happen during iteration, not at construction · library support lags the standard (check `__cpp_lib_generator >= 202207L`).

---

## 32.8 Dangling references and destruction hazards

```cpp
// ---- trap 1: coroutine lambda outliving its closure -------------------
auto make_bad() {
    int value = 42;
    auto lambda = [&]() -> task<int> {          // frame keeps `this` = &closure
        co_await suspend_once();
        co_return value;                        // dangling once make_bad returns
    };
    return lambda();                            // closure dies at the semicolon
}

// ---- fix: named coroutine taking owned values -------------------------
task<int> owned_work(int value) {               // by-value param lives in the frame
    co_await suspend_once();
    co_return value;
}
auto make_good() { return owned_work(42); }

// ---- fix 2: keep the closure alive as long as the frame ---------------
task<void> run_with(std::function<task<void>()> f) { co_await f(); } // f outlives the await
```

```cpp
// ---- trap 2: views and references as coroutine parameters -------------
task<void> bad(std::string_view s);          // borrows; caller's buffer may die
task<void> bad2(std::span<int const> xs);    // borrows
task<void> bad3(Config const& c);            // borrows
task<void> good(std::string s);              // OWNED copy in the frame
task<void> good2(std::vector<int> xs);       // OWNED
task<void> good3(std::shared_ptr<Config> c); // shared ownership across suspension

bad(std::string{"tmp"});   // the temporary dies at the end of the full-expression,
                           // i.e. potentially before the coroutine ever resumes
```

| Parameter form | In the frame? | Safe across suspension? |
|---|---|---|
| `T` by value | copy/move of `T` | yes |
| `T&` / `T const&` | the reference only | only if the referent outlives all suspensions |
| `T&&` | the reference only | almost never — temporaries die at the call's full-expression |
| `std::string_view`, `std::span`, `T*`, iterators | the view *object* is copied | no — the pointee is still borrowed |
| `std::shared_ptr<T>` | the control-block-owning copy | yes |

```cpp
// ---- trap 3: reference-returning member coroutines --------------------
struct Engine {
    task<int> poll() { co_await tick(); co_return counter_; }  // uses `this` after suspend
    int counter_{};
};
// The frame stores `this`, not the Engine. Destroying the Engine while poll()
// is suspended is a use-after-free. Own the object or join before destruction.

// ---- trap 4: two owners of one handle ---------------------------------
auto h = handle_type::from_promise(p);
executor.enqueue(h);          // executor will resume + maybe destroy
task_object.~task();          // ALSO destroys  ==> double destroy, UB
```

**Handle ownership rules** — exactly one protocol must answer all five:
- who may call `resume()`, and at most once per suspension;
- who calls `destroy()`, and exactly once;
- whether destruction must first cancel and deregister outstanding work;
- how stale/duplicate queued handles are prevented;
- how normal completion races with owner destruction.

**Rapid diagnoses**

| Symptom | Cause | Fix |
|---|---|---|
| Callback resumes freed frame | task destroyed while an operation held its handle | cancel + synchronous deregistration, or shared op state |
| Coroutine body never runs | lazy `initial_suspend` and nobody awaits/resumes | define start semantics in the return type |
| Frame leak (heap grows) | suspended handle lost, or owner never called `destroy()` | one move-only owner; explicit detach semantics |
| Double resume / random corruption | cancellation and completion both enqueued the handle | atomic one-winner state machine |
| Value correct before await, garbage after | borrowed parameter or lambda capture | pass owned values into a named coroutine |
| "Async" call blocks the loop | the awaited implementation blocks or resumes inline | inspect the awaiter/executor contract |
| Stack overflow in long chains | continuation calls `resume()` recursively | symmetric transfer or an executor trampoline |
| `bad_alloc` under load | one frame allocation per task | frame pool, `get_return_object_on_allocation_failure`, or fewer tasks |

---

## 32.9 Coroutines are not threads: execution and synchronization responsibilities

```text
thread A: task()          body runs on A until a suspension point
          awaiter.await_suspend(h) → queue.push(h)      [release]
thread B: h = queue.pop()                               [acquire]
          h.resume()      body continues on B after await_resume()
```

- Execution continues on whichever thread calls `resume()` — the language supplies no scheduler, no thread pool, and no affinity.
- Publishing a handle across threads needs a release/acquire edge (a synchronized queue provides it); the same edge publishes everything written before the enqueue.
- State touched concurrently *outside* that ownership transfer still needs its own synchronization.

| Migrates with the coroutine | Does **not** migrate |
|---|---|
| Frame contents (promise, params, locals) | `thread_local` values — re-read them after every suspension |
| Values captured by value in the frame | Mutex ownership (`unique_lock` unlocks on the *resuming* thread) |
| The logical continuation | Thread-affine I/O handles, GUI/event-loop affinity |
| | Tracing/span context, CPU affinity, NUMA-local allocator identity |

```cpp
// ---- never hold an ordinary lock across a suspension ------------------
{
    std::unique_lock lock{mutex_};
    co_await operation();        // BAD: lock held for an unbounded time; unlock may
                                 // happen on a DIFFERENT thread than lock() did
}

// ---- fix: copy out, release, then await ------------------------------
Snapshot snap;
{ std::lock_guard g{mutex_}; snap = state_; }   // no suspension inside the guard
co_await operation(snap);

// ---- or use an async mutex whose "lock" is an awaitable --------------
auto guard = co_await async_mutex_.lock_async();  // resumes when acquired, no blocking
```

```cpp
// ---- hopping executors explicitly ------------------------------------
co_await schedule_on(io_pool);      // continuation runs on io_pool
auto data = co_await read(fd);
co_await schedule_on(strand);       // hop back to the affine context
publish(data);
```

**Cost ledger**

| Mechanism | Potential cost |
|---|---|
| Frame | one allocation + free unless elided; size; cache footprint |
| Suspend / resume | state store, resume-index branch, indirect (or tail) jump |
| Executor hop | atomic enqueue/dequeue, wakeup latency, cache-line migration |
| Awaiter | registration, cancellation state, timer/I-O bookkeeping |
| Exception storage | `exception_ptr` refcount + runtime unwinding machinery |
| Generator | one resume per element; frame allocation; no vectorization |
| Composition | continuation chain, code size, nested frame lifetimes |

- A suspension is far cheaper than blocking an OS thread, and expresses state machines readably — but it is not zero-cost by definition.
- `await_ready() == true` on an always-ready operation avoids the suspension entirely; whether the surrounding machinery is inlined away is implementation-dependent.
- For HFT/event-loop work, compare: hand-written state machine · callback/continuation · coroutine on a fixed executor with a frame pool · dedicated single-threaded loop.
- Measure frame allocations, frame sizes, enqueue hops, cache migrations, and tail latency — not source line count.

**Interview drill**

| Question | One-sentence answer |
|---|---|
| What is in a frame? | Promise, parameter state, resume state, and locals crossing a suspension; layout is implementation-defined. |
| Does calling a coroutine run its body? | Only if `initial_suspend()` returns `suspend_never`. |
| What does `await_ready() == true` mean? | Skip suspension and `await_suspend`; `await_resume` still runs. |
| What can `await_suspend` return? | `void`, `bool`, or a `coroutine_handle` — stay suspended / resume inline / symmetric transfer. |
| Who schedules a coroutine? | The awaiter, executor, or application; the language provides only the transformation. |
| Why suspend at final suspend? | So the continuation or owner can observe completion and choose when to destroy the frame. |
| Who owns a `coroutine_handle`? | Nobody inherently — the return type or operation state must assign resume and destroy. |
| Are frames always heap-allocated? | No; dynamic allocation is common, elision is permitted but never guaranteed. |
| What is symmetric transfer? | Returning a handle from `await_suspend` so the compiler tail-calls into it, avoiding recursive resume. |
| How do exceptions leave a coroutine? | Body exceptions go to `promise.unhandled_exception()`; the return type rethrows or reports later. |
| Does `stop_token` cancel an await? | Only if the awaitable registers a callback and atomically arbitrates cancel vs complete. |
| Why are coroutine lambdas hazardous? | The frame stores the closure's `this`; suspension can outlive the closure. |
| Is `std::generator` asynchronous? | No — it is a lazy synchronous pull generator resumed by iteration. |
| Can a coroutine migrate threads? | Only when the handoff is synchronized and every TLS, lock, and affine resource assumption permits it. |

**Recall card**

```text
coroutine       compiler-transformed resumable function; not a thread
frame           promise + by-value params + live-across-suspend locals + resume state
promise         get_return_object / initial_suspend / final_suspend noexcept /
                return_void XOR return_value / unhandled_exception /
                yield_value / await_transform / operator new+delete /
                get_return_object_on_allocation_failure
handle          non-owning; resume/destroy/done/promise/address/from_promise/noop
await_ready     true => no suspension (await_resume still runs)
await_suspend   void | bool | handle; publishing h is an ownership handoff
await_resume    value or exception on the resume path
co_yield v      == co_await promise.yield_value(v)
initial/final   eager vs lazy start; completion handoff, never resume after final
symmetric       return a handle => guaranteed tail call, O(1) stack
allocation      promise operator new; HALO permitted, never promised
cancellation    pending → completed XOR cancelled; exactly one resume
lifetime        by-value owned; refs/views/this stay borrowed
scheduling      the resumer picks the thread; handoff needs release/acquire
```

**Core design sentence** — a coroutine abstraction is correct only when frame ownership is explicit: every suspension has exactly one party responsible for eventual resume or cancellation, every external callback is withdrawn before frame destruction, all borrowed data outlives every suspension, and cross-thread resumption rides a real synchronization contract.
