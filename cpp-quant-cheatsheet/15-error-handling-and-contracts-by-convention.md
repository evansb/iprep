# 15. Error handling and contracts-by-convention

*Part II — Classes, resource management, and generic programming*

---

**Recall**
- Pick the failure channel from *semantics* first: absence → `optional`, recoverable → `expected`, OS/library domain → `error_code`, rare non-local → exception, programmer bug → assert/terminate.
- A `throw` initializes an exception object, transfers control to the nearest dynamically enclosing matching handler, and destroys the fully constructed automatic objects in every exited scope.
- No matching handler anywhere → `std::terminate` (stack may or may not be unwound first — that is implementation-defined).
- Catch class types by `const&`: by-value catch slices derived exceptions and copies; catch ordering is *first match wins*, so derived handlers must precede base handlers.
- `throw;` rethrows the *current* exception object unchanged; `throw e;` copy-initializes a **new** object from `e` and slices when `e` is a base reference.
- Destructors are `noexcept(true)` by default; throwing out of one while another exception propagates calls `std::terminate` — expose an explicit `close()`/`flush()` for reportable failure.
- If a constructor throws, the object is not destroyed, but its completed bases and members are — so acquire every resource into an RAII member immediately.
- Four guarantees: **no-throw** ⊃ **strong** (commit-or-rollback, observable state unchanged) ⊃ **basic** (invariants hold, no leaks) ⊃ **none**.
- Strong guarantee recipe: build a complete candidate → validate → commit with a proven non-throwing `swap`/move/index flip.
- "Strong" never rolls back I/O, logging, callbacks, or external systems; only *this object's* observable state.
- Exception-neutral generic code lets user exceptions propagate while keeping its own invariants and freeing its own resources — it does **not** promise rollback.
- `noexcept` is a promise that nothing escapes, not that the body cannot throw internally; a lying `noexcept` converts a recoverable error into process death.
- Containers use `std::move_if_noexcept` during reallocation: a throwing move constructor forces copies, so `noexcept` move ops are a performance and guarantee lever.
- `std::error_code` = integer + `error_category` *identity*; default-constructed is success, `operator bool` is `value() != 0`, and `message()` returns a `std::string` that may allocate.
- `error_code` is a concrete system/library error; `error_condition` is the portable abstraction (`std::errc`) reached through category equivalence.
- `optional<T>` owns a `T` or nothing and carries **no reason**; `optional<T&>` does not exist in C++23; `*o`/`o->` are unchecked (UB when disengaged), `value()` throws `bad_optional_access`.
- `expected<T, E>` (C++23) stores one alternative inline plus a discriminator — no allocation of its own; `*r`/`r.error()` are unchecked, `value()` throws `bad_expected_access<E>`.
- Monadic chains (`and_then`/`transform`/`or_else`/`transform_error`) are composition sugar, not a cost guarantee — they still copy/move `T` and `E`.
- `assert` is erased by `NDEBUG` **including its expression**, so side effects vanish; untrusted input needs real validation with defined release behavior.
- `std::unreachable()` (C++23) is a promise, not a check: reaching it is UB, so untrusted enum tags still need a `default`.
- The standard gives *no* cost guarantee for exceptions — not zero-cost-on-success, not allocation-free, not bounded unwind; and "exceptions disabled" is not a standard language mode.
- Never let an exception escape a C ABI boundary, a thread entry function, or a `noexcept` function — translate at the boundary.

---

## 15.1 Exceptions: throw, propagation, handlers, and rethrow

```cpp
#include <exception>
#include <stdexcept>
#include <system_error>

// ---- exception type hierarchy ----------------------------------------
struct DecodeFailure : std::runtime_error {
    using std::runtime_error::runtime_error;          // inherit ctors
    explicit DecodeFailure(std::size_t off)
        : std::runtime_error{"truncated"}, offset{off} {}
    std::size_t offset{};
};

// ---- throw forms ------------------------------------------------------
throw DecodeFailure{"truncated quote"};   // temporary; object lifetime managed by runtime
throw std::runtime_error{"boom"};         // standard type
throw 42;                                 // legal but useless: catch(int)
throw;                                    // rethrow — ONLY valid inside a handler
// throw std::current_exception();        // wrong: that yields exception_ptr, not a throw
```

```cpp
// ---- handler forms & ordering ----------------------------------------
try {
    auto q = decode(input);
    consume(q);
} catch (DecodeFailure const& e) {        // most-derived FIRST
    report(e.what(), e.offset);
} catch (std::system_error const& e) {
    report(e.code().value(), e.code().category().name());
} catch (std::exception const& e) {       // base LAST
    report(e.what());
} catch (...) {                           // matches anything; no object available
    report("unknown");
    throw;                                // may rethrow the active exception
}
// catch (std::exception e)      // SLICES + copies — never do this
// catch (std::exception* e)     // only matches thrown POINTERS
```

```cpp
// ---- function-try-block: catches member/base ctor failures too --------
struct Session {
    File file_;
    Session(char const* path) try : file_{path} {
        connect();
    } catch (std::exception const&) {
        // ctor function-try-block ALWAYS rethrows on exit (implicit throw;)
        // members are already destroyed here — do not touch them
    }
    ~Session() noexcept = default;
};
```

```cpp
// ---- rethrow vs re-throw-by-value ------------------------------------
try { work(); }
catch (std::exception const& e) {
    add_context();
    throw;        // same object, same dynamic type, same identity
    // throw e;   // NEW object copy-initialized from static type → SLICED
}

// ---- nested exceptions -----------------------------------------------
try { parse(); }
catch (...) { std::throw_with_nested(ConfigError{"loading feed.cfg"}); }

void unwrap(std::exception const& e, int depth = 0) {
    report(depth, e.what());
    try { std::rethrow_if_nested(e); }
    catch (std::exception const& inner) { unwrap(inner, depth + 1); }
    catch (...) {}
}

// ---- transporting an exception across threads -------------------------
std::exception_ptr slot;
try { risky(); } catch (...) { slot = std::current_exception(); }   // capture
if (slot) std::rethrow_exception(slot);   // [[noreturn]]; rethrows in this thread
auto p = std::make_exception_ptr(DecodeFailure{"synthesized"});     // no throw needed
```

| Facility | Header | Meaning |
|---|---|---|
| `std::exception` | `<exception>` | base; `virtual char const* what() const noexcept` |
| `std::logic_error` / `runtime_error` | `<stdexcept>` | ctor takes `std::string` / `char const*` — **may allocate** |
| `std::invalid_argument`, `domain_error`, `length_error`, `out_of_range` | `<stdexcept>` | derive from `logic_error` |
| `std::range_error`, `overflow_error`, `underflow_error` | `<stdexcept>` | derive from `runtime_error` |
| `std::system_error` | `<system_error>` | carries `error_code()`; thrown by OS-facing library code |
| `std::bad_alloc` | `<new>` | allocation failure |
| `std::bad_cast` / `bad_typeid` | `<typeinfo>` | failed `dynamic_cast<T&>` / null `typeid` |
| `std::bad_optional_access` | `<optional>` | `optional::value()` on disengaged |
| `std::bad_expected_access<E>` | `<expected>` | `expected::value()` on error; `.error()` accessor |
| `std::bad_variant_access` | `<variant>` | wrong-alternative `std::get` |
| `std::exception_ptr` | `<exception>` | shared-ownership handle; copyable, comparable to `nullptr` |
| `std::current_exception()` | `<exception>` | active exception as `exception_ptr` (null outside handler) |
| `std::rethrow_exception(p)` | `<exception>` | `[[noreturn]]`; UB if `p` is null |
| `std::make_exception_ptr(e)` | `<exception>` | wrap a value without throwing |
| `std::throw_with_nested(e)` / `rethrow_if_nested(e)` | `<exception>` | chain causes |
| `std::uncaught_exceptions()` | `<exception>` | count of in-flight uncaught exceptions (C++17) |
| `std::terminate()` / `set_terminate` / `get_terminate` | `<exception>` | fatal path hooks |

**Traps** — `throw e;` in a handler slices · by-value catch copies (and can itself throw `bad_alloc`) · base handler placed before derived silently swallows · `catch(...)` with no rethrow hides bugs · exception matching uses only standard/base conversions, never user-defined conversions · a bare `throw;` outside a handler calls `terminate` · `what()` strings are not guaranteed allocation-free.

---

## 15.2 Stack unwinding and destructor behavior

```cpp
void persist() {
    File file{"capture.bin"};       // 1st constructed
    std::lock_guard lock{mutex_};   // 2nd
    Buffer buffer;                  // 3rd
    write_record(file, buffer);     // throws → ~Buffer, ~lock_guard, ~File (reverse order)
}                                   // identical cleanup on normal exit — that is RAII
```

```cpp
// ---- partial construction --------------------------------------------
struct Feed {
    Socket  socket_;      // constructed 1st
    Decoder decoder_;     // constructed 2nd — if THIS throws, ~Socket runs,
    Journal journal_;     //   ~Feed does NOT run, journal_ never constructed
    Feed();
};

// ---- raw-flag anti-pattern -------------------------------------------
class Bad {
    int  fd_{-1};
    bool owns_{false};
public:
    Bad(char const* p) {
        fd_ = ::open(p, O_RDONLY);
        owns_ = true;
        validate();          // throws → ~Bad never runs → fd_ LEAKS
    }
    ~Bad() { if (owns_) ::close(fd_); }
};
class Good {
    FileDescriptor fd_;      // RAII member owns immediately
public:
    explicit Good(char const* p) : fd_{p} { validate(); }  // throw → ~fd_ runs
};
```

```cpp
// ---- destructors must not throw during unwinding ---------------------
class CaptureFile {
public:
    ~CaptureFile() noexcept { (void)::close(fd_); }        // swallow, never throw
    [[nodiscard]] std::error_code close() noexcept;        // explicit reportable path
private:
    int fd_{-1};
};

struct Reckless {
    ~Reckless() noexcept(false) { throw 1; }   // legal to declare…
};                                             // …but throwing while unwinding → terminate
```

```cpp
// ---- scope guards via uncaught_exceptions() (C++17) -------------------
class ScopeFail {
    int depth_ = std::uncaught_exceptions();
    std::function<void()> f_;
public:
    explicit ScopeFail(std::function<void()> f) : f_{std::move(f)} {}
    ~ScopeFail() noexcept {
        if (std::uncaught_exceptions() > depth_) f_();   // destroyed *by* an exception
    }
};
// std::uncaught_exception() (singular, bool) was removed in C++20.
```

| Rule | Statement |
|---|---|
| Order | Automatic objects destroyed in exact reverse order of completed construction |
| Scope | Every scope between throw point and matching handler is unwound |
| Partial object | Object whose ctor threw is *not* destroyed; its completed bases/members are |
| Array | Elements already constructed are destroyed in reverse index order |
| `new T` | If `T`'s ctor throws, the matching `operator delete` is called automatically |
| No handler | `std::terminate`; whether unwinding happened first is **implementation-defined** |
| Destructor throws while unwinding | `std::terminate` (unconditionally) |
| Default `~T()` spec | `noexcept(true)` unless a base/member destructor is `noexcept(false)` |
| `longjmp` past a nontrivial destructor | Undefined behavior |

**Interview line** — "Unwinding destroys exactly the fully constructed automatic objects of each exited scope, in reverse order; the object whose constructor threw is not one of them."

**Traps** — `noexcept(false)` destructors poison every container that holds the type · cleanup that logs can allocate and throw · a mutex released *after* an invariant is half-updated publishes broken state · function-try-block on a constructor cannot suppress the exception.

---

## 15.3 Basic, strong, and no-throw exception guarantees

| Guarantee | If the operation exits by exception |
|---|---|
| **No-throw** (`noexcept`-correct) | It does not; the operation always succeeds or reports without throwing |
| **Strong** | Observable state of the target is exactly as before; commit-or-rollback |
| **Basic** | Invariants hold, nothing leaks, state may have changed to *some* valid value |
| **None** | Nothing beyond language-level obligations; typically a bug |

```cpp
// ---- strong: prepare → validate → non-throwing commit -----------------
class SymbolTable {
    std::vector<Symbol> symbols_;
public:
    void replace(std::span<Symbol const> source) {
        std::vector<Symbol> candidate(source.begin(), source.end()); // may throw
        validate(candidate);                                          // may throw
        symbols_.swap(candidate);   // noexcept for equal/propagating allocators
    }                               // ~candidate frees the old buffer
};

// ---- strong on hot state without allocation: double buffer + index flip
class Ladder {
    std::array<Snapshot, 2> slot_{};
    std::atomic<unsigned>   live_{0};
public:
    void publish(Update const& u) {
        unsigned next = live_.load(std::memory_order_relaxed) ^ 1u;
        slot_[next] = slot_[live_];      // may throw → live_ untouched
        apply(slot_[next], u);           // may throw → live_ untouched
        live_.store(next, std::memory_order_release);   // noexcept commit
    }
};
```

```cpp
// ---- rollback via scope guard ----------------------------------------
void transfer(Account& a, Account& b, Money m) {
    a.debit(m);
    bool committed = false;
    auto undo = finally([&]{ if (!committed) a.credit(m); });  // noexcept undo
    b.credit(m);          // may throw → undo restores a
    committed = true;
}
// The rollback action itself MUST be noexcept, or the guarantee evaporates.
```

Copy-and-swap is the third standard shape for the strong guarantee — the by-value parameter
does all the throwing work before a `noexcept` swap commits it. Its mechanics, self-assignment
behaviour, and the cost it charges (no capacity reuse, deferred release) are in
[§9.9](/iprep/books/cpp-cheatsheet/09-copying-moving-and-ownership/).

| Standard-library operation | Guarantee (with qualifications) |
|---|---|
| `vector::push_back` / `emplace_back` | Strong **iff** `T`'s move ctor is `noexcept` or `T` is copy-insertable; else basic |
| `vector::insert` (middle) | Strong on reallocation; basic otherwise if `T`'s move/copy assignment throws |
| `vector::reserve` / `resize` grow | Strong iff no throwing move (`move_if_noexcept`) |
| `vector::erase`, `pop_back`, `clear` | No-throw iff element ops do not throw |
| `deque::push_front/back` | Strong |
| `list`/`forward_list` insert, splice, erase | Strong (insert) / no-throw (splice, erase) |
| `map`/`set` `insert`, `emplace` | Strong (single element) |
| `unordered_*` `insert`/`rehash` | Strong for single insert; rehash may throw and leave a valid container |
| `swap` on standard containers | No-throw except when allocators are unequal and non-propagating |
| Node handles (`extract`/`insert(node)`) | No-throw transfer — no element construction |

**Traps** — "strong" says nothing about side effects outside the object (I/O, logging, counters, callbacks) · strong often costs a full duplicate buffer plus an allocation · `swap` is only `noexcept` under allocator conditions · a throwing move-only `T` degrades `vector` reallocation to basic · never quote a container guarantee without its element-type qualifications.

---

## 15.4 Exception-neutral generic code

```cpp
// Neutral: user callables may throw; the algorithm leaks nothing and
// maintains its own (basic) invariants. It does NOT roll back.
template<std::input_iterator It, class F>
void for_each_neutral(It first, It last, F&& f)
    noexcept(std::is_nothrow_invocable_v<F&, std::iter_reference_t<It>>)
{
    for (; first != last; ++first)
        std::invoke(f, *first);      // propagates unchanged
}
```

```cpp
// Neutral with cleanup of what THIS function created (uninitialized_copy shape)
template<class It, class Out>
Out copy_construct_neutral(It first, It last, Out out) {
    Out start = out;
    try {
        for (; first != last; ++first, ++out)
            std::construct_at(std::to_address(out), *first);  // may throw
    } catch (...) {
        std::destroy(start, out);    // undo only OUR effects
        throw;                       // stay neutral
    }
    return out;
}
```

```cpp
// Throw-point inventory for one line of generic code:
//   comparison · hash · allocator::allocate · element ctor/copy/move/assign
//   iterator ++/* · projection · user callback · logging · to_string/format
container_[key] = compute(value);
// ^ hash may throw · allocate may throw · T's ctor may throw · assignment may throw
```

**Neutral-code audit**
- Which of comparison, hashing, allocation, construction, move, assignment, destruction, and callback invocation can throw?
- What has already been mutated at each throw point, and is that state still a valid invariant?
- Can the rollback path itself throw? (If yes, the strong guarantee is fiction.)
- Are the allocators compatible for the swap/move you plan to commit with?
- Are partially processed elements observable to another thread or to the caller?
- Does propagation cross a `noexcept`, C ABI, thread-entry, coroutine, or plugin boundary?

**Interview line** — "Exception neutrality means user exceptions pass through untouched while the algorithm still honors its own resource and invariant promises — propagation is a feature, not a leak."

**Traps** — catching only to log and rethrow at every layer multiplies telemetry and hides the origin · `catch(...)` that swallows breaks neutrality and turns errors into corruption · a `noexcept` on a template that invokes user code is a terminate waiting to happen (use conditional `noexcept`) · rollback in a `catch` must be `noexcept` or you get an exception during handling.

---

## 15.5 `noexcept` correctness and `std::terminate`

```cpp
// ---- the two spellings ------------------------------------------------
void a() noexcept;              // specification: nothing escapes (== noexcept(true))
void b() noexcept(true);
void c() noexcept(false);       // default for ordinary functions
void d() throw();               // REMOVED in C++20 — dynamic spec is gone

constexpr bool q = noexcept(f());   // OPERATOR: unevaluated Boolean query
static_assert(noexcept(std::declval<Handler&>()(std::declval<Event const&>())));
```

```cpp
// ---- conditional noexcept: propagate, don't guess ---------------------
template<class T>
void exchange3(T& a, T& b)
    noexcept(std::is_nothrow_move_constructible_v<T> &&
             std::is_nothrow_move_assignable_v<T>)
{
    T tmp = std::move(a);
    a = std::move(b);
    b = std::move(tmp);
}

template<class T>
void wrapper(T& t) noexcept(noexcept(t.step()))   // noexcept(noexcept(expr)) idiom
{ t.step(); }
```

```cpp
// ---- where noexcept is mandatory or load-bearing ----------------------
struct Record {
    Record(Record&&) noexcept;             // vector relocation MOVES instead of COPIES
    Record& operator=(Record&&) noexcept;  // required by MoveAssignable-heavy algorithms
    ~Record() noexcept;                    // implicit; keep it
    friend void swap(Record&, Record&) noexcept;
};
static_assert(std::is_nothrow_move_constructible_v<Record>);

// std::move_if_noexcept picks copy when the move can throw AND a copy exists.
```

```cpp
// ---- deliberate translation at a noexcept boundary --------------------
extern "C" int api_decode(void const* p, std::size_t n) noexcept {
    try              { decode_or_throw(p, n); return 0; }
    catch (DecodeFailure const&) { return 1; }
    catch (std::bad_alloc const&) { return 2; }
    catch (...)      { return 3; }   // nothing escapes into C
}

void thread_entry() noexcept {
    try { run(); } catch (...) { record_fatal(); std::abort(); }
}
```

| `std::terminate` is called when… | Notes |
|---|---|
| No handler matches a thrown exception | Unwinding before terminate is implementation-defined |
| An exception tries to escape a `noexcept` function | The `noexcept` specification is enforced by termination |
| A destructor throws while another exception propagates | Unconditional |
| An exception escapes a `std::thread` entry function | Also for `jthread` |
| An exception escapes a static/thread-local initializer, or a `main` return path handler | As specified |
| `std::rethrow_exception(null)` / bare `throw;` with no active exception | UB / terminate |
| A `joinable` `std::thread` is destroyed or assigned to | Not exception-related but the same fatal path |
| Exception escapes the handler of a function-try-block on `main` | Per `[except.handle]` |

| API | Purpose |
|---|---|
| `std::terminate()` | Invokes the current terminate handler; handler must not return |
| `std::set_terminate(h)` / `std::get_terminate()` | Install/read handler (`void(*)()`, `[[noreturn]]` in effect) |
| `std::abort()` | Immediate; no destructors, no atexit, raises `SIGABRT` |
| `std::quick_exit` / `at_quick_exit` | Exit without running static destructors |

**Interview line** — "`noexcept` is a promise about the *boundary*, not the body: the function may throw and catch internally; only escape is fatal."

**Traps** — `noexcept` does not make code faster by itself and never converts throws to error returns · marking a function `noexcept` that calls a user callback is a latent `terminate` · `noexcept` is part of the function type since C++17 (affects pointers and overload resolution, not overloading) · a `noexcept` virtual override may not weaken the base's specification · fatal-path logging must avoid locks, allocation, and possibly corrupt state.

---

## 15.6 Error codes, `std::error_code`, and error categories

```cpp
#include <system_error>

std::error_code ec;                                  // value 0, system_category — success
ec = std::make_error_code(std::errc::permission_denied);
ec = std::error_code{ENOENT, std::generic_category()};
ec.assign(EACCES, std::system_category());
ec.clear();                                          // back to success

if (ec) { /* operator bool == (value() != 0) */ }
int         v    = ec.value();
char const* name = ec.category().name();             // noexcept, stable pointer
std::string text = ec.message();                     // MAY ALLOCATE — keep off hot path
std::error_condition cond = ec.default_error_condition();

// comparison uses category equivalence, not raw integers
if (ec == std::errc::no_such_file_or_directory) { /* portable test */ }
if (ec.category() == std::system_category() && ec.value() == 5) { /* platform-specific */ }
```

```cpp
// ---- dual API: throwing overload + noexcept ec overload ---------------
File open_capture(std::string_view path);                              // throws system_error
File open_capture(std::string_view path, std::error_code& ec) noexcept; // sets ec

std::error_code ec2;
auto f = open_capture(path, ec2);
if (ec2) return log_and_bail(ec2);

// filesystem uses exactly this shape:
std::filesystem::file_size(p);        // throws std::filesystem::filesystem_error
std::filesystem::file_size(p, ec2);   // noexcept; reports through ec2
```

```cpp
// ---- custom category, correct protocol --------------------------------
enum class FeedErrc { ok = 0, truncated = 1, bad_tag = 2, stale_sequence = 3 };

class FeedCategory final : public std::error_category {
public:
    char const* name() const noexcept override { return "feed"; }
    std::string message(int v) const override {
        switch (static_cast<FeedErrc>(v)) {
            case FeedErrc::ok:             return "ok";
            case FeedErrc::truncated:      return "truncated frame";
            case FeedErrc::bad_tag:        return "unknown tag";
            case FeedErrc::stale_sequence: return "stale sequence";
        }
        return "unknown feed error";
    }
    // optional: map to portable conditions
    std::error_condition default_error_condition(int v) const noexcept override {
        if (static_cast<FeedErrc>(v) == FeedErrc::truncated)
            return std::errc::message_size;
        return {v, *this};   // error_condition(int, error_category const&)
    }
};

inline std::error_category const& feed_category() noexcept {
    static FeedCategory const instance;   // ONE program-wide identity
    return instance;
}
std::error_code make_error_code(FeedErrc e) noexcept {   // found by ADL
    return {static_cast<int>(e), feed_category()};
}
template<> struct std::is_error_code_enum<FeedErrc> : std::true_type {};
// now: std::error_code ec = FeedErrc::bad_tag;   // implicit conversion enabled
```

| Type / function | Header | Notes |
|---|---|---|
| `std::error_code` | `<system_error>` | `value()`, `category()`, `message()`, `assign`, `clear`, `operator bool`, `<=>`; trivially copyable, 2 words |
| `std::error_condition` | `<system_error>` | Portable abstraction; compared against codes via categories |
| `std::error_category` | `<system_error>` | Abstract, non-copyable; identity is address; `name()`, `message()`, `equivalent()`, `default_error_condition()` |
| `std::generic_category()` | `<system_error>` | POSIX `errno` values ↔ `std::errc` |
| `std::system_category()` | `<system_error>` | Native OS errors (`errno` on POSIX, `GetLastError` on Windows) |
| `std::iostream_category()` | `<ios>` | `std::io_errc::stream` |
| `std::future_category()` | `<future>` | `std::future_errc` |
| `std::errc` | `<system_error>` | Enum of portable conditions; `is_error_condition_enum` specialized |
| `std::system_error` | `<system_error>` | Exception carrying `code()`; ctor `(ec)`, `(ec, what)`, `(val, cat, what)` |
| `std::make_error_code(e)` / `make_error_condition(e)` | ADL | Enable-conversion hooks |
| `std::is_error_code_enum<E>` / `is_error_condition_enum<E>` | `<system_error>` | Opt-in traits for implicit conversion |

```cpp
// ---- from_chars: error reporting without error_code --------------------
#include <charconv>
unsigned qty{};
auto [ptr, err] = std::from_chars(b, e, qty);      // err is std::errc (a value, not a code)
if (err == std::errc::invalid_argument) { /* no digits */ }
if (err == std::errc::result_out_of_range) { /* overflow */ }
// std::from_chars_result is noexcept, allocation-free, locale-independent.
```

**Traps** — `message()` allocates and formats: store the code, format later · two categories with the same integer are different errors — never compare `value()` across categories · a category defined in a header without `inline`/function-local `static` can get one instance per TU and break equality · `error_code` in a return position is easy to ignore: mark `[[nodiscard]]` · comparing `error_code == error_code` is exact identity, `error_code == errc` goes through equivalence · for a closed domain a compact enum in `expected` is smaller and faster than category dispatch.

---

## 15.7 `std::optional` for absence

> Construction forms, the full member table, monadic operations, and the representable-state
> traps (`optional<bool>`, `optional<T*>`, dangling references after `reset`) are in
> [§21.2](/iprep/books/cpp-cheatsheet/21-utility-and-vocabulary-types/). Here the question is narrower: **when is
> absence the right error model at all?**

```cpp
#include <optional>

// Absence is the WHOLE story: there is no bid, and "why" is not a question
// the caller can act on differently.
std::optional<Price> best_bid(Book const& book) noexcept {
    if (book.empty()) return std::nullopt;
    return book.best_bid();                   // implicit conversion T -> optional<T>
}

if (auto bid = best_bid(book)) consume(*bid);  // test-and-use; no error channel needed
```

```cpp
// ---- the failure mode: overloading disengagement ----------------------
std::optional<Quote> read_quote();   // BAD: nullopt now means
                                     //   timed out / malformed / socket closed /
                                     //   subscription not yet active
// The caller must retry, log, reconnect, or wait — and cannot tell which.
// Once "why" changes the caller's behaviour, absence is the wrong model:
std::expected<Quote, ReadError> read_quote();   // see 15.8
```

| Situation | Model | Reason |
|---|---|---|
| Value may legitimately not exist; caller has one response | `optional<T>` | absence *is* the information |
| Caller branches on the reason | `expected<T, E>` | the reason must survive the return |
| Absence is a programming error | precondition + assert | not a value at all, see [§15.9](#159-assertions-preconditions-invariants-and-unreachable-states) |
| Absence is normal but the reason is worth *recording* only | `optional<T>` + a counter | keeps the hot-path type small |

- `optional` costs roughly `sizeof(T)` + a discriminator + padding, and never allocates on its own — but it does not shrink `T`, so `optional<BigThing>` is still big by value.
- A disengaged `optional` returned from a `noexcept` function is the cheapest possible failure signal: no allocation, no unwinding, no error object.
- Reserve `nullopt` for one meaning per function and write that meaning in the declaration's comment; the type cannot carry it.

**Traps** — `*o` on a disengaged optional is UB, not a throw · `value_or` eagerly evaluates and *copies* the fallback (use `or_else` for lazy) · overloading disengagement to mean "timeout OR malformed OR shutdown" destroys the caller's ability to react · returning `optional<T>` from a function that also throws gives the caller two error channels to handle · `optional` in an aggregate makes it non-trivial when `T` is non-trivial.

---

## 15.8 C++23 `std::expected<T, E>` for recoverable errors

> Construction forms, the member table, and the monadic combinators (`and_then` /
> `transform` / `or_else` / `transform_error`) are in
> [§21.5](/iprep/books/cpp-cheatsheet/21-utility-and-vocabulary-types/). This section is about the two decisions
> that are *error-handling* decisions: what `E` should be, and what choosing `expected`
> commits you to.

```cpp
#include <expected>

enum class ParseError : std::uint8_t { empty, invalid_digit, overflow };

std::expected<unsigned, ParseError> parse_quantity(std::string_view text) noexcept {
    if (text.empty()) return std::unexpected(ParseError::empty);
    unsigned value{};
    for (char c : text) {
        if (c < '0' || c > '9') return std::unexpected(ParseError::invalid_digit);
        unsigned digit = static_cast<unsigned>(c - '0');
        if (value > (std::numeric_limits<unsigned>::max() - digit) / 10)
            return std::unexpected{ParseError::overflow};
        value = value * 10 + digit;
    }
    return value;                                   // implicit T -> expected
}
// Note what the signature now promises: noexcept, every failure named, and a
// caller that cannot compile without acknowledging the error channel.
```

```cpp
// ---- designing E for the hot path -------------------------------------
struct DecodeError {                       // 4 bytes, trivially copyable
    enum class Code : std::uint8_t { truncated, bad_tag, bad_value } code{};
    std::uint8_t  field{};
    std::uint16_t offset{};
};
static_assert(std::is_trivially_copyable_v<DecodeError> && sizeof(DecodeError) == 4);
// Store CONTEXT, not a formatted string: formatting allocates and amplifies
// malformed bursts. Format at the reporting boundary.
```

| `E` choice | Cost per failure | Use when |
|---|---|---|
| Scoped enum (1 byte) | none | the caller switches on a closed set of reasons |
| Enum + offset/field (≤8 bytes) | none | the caller must *locate* the failure (codecs, parsers) |
| `std::error_code` (16 bytes) | none, but category indirection to render | crossing a library boundary, see [§15.6](#156-error-codes-stderror_code-and-error-categories) |
| `std::string` / `exception_ptr` | **allocation on every failure** | cold configuration/startup paths only |

**What choosing `expected` commits you to**
- One inline union of `T` and `E` plus a discriminator: `sizeof ≈ max(sizeof T, sizeof E)` + alignment padding; **no allocation by the wrapper**. A large `E` inflates the success path too.
- The error branch is ordinary control flow — a predictable, cheap, *always-paid* branch, unlike a never-thrown exception which costs nothing until it throws and then costs an unbounded amount.
- `T` and `E` are both part of the return type, so changing either is an **ABI break** across a shared-library boundary.
- Errors propagate only where a caller writes the propagation; there is no unwinding to carry them out of a deep call stack for free. That is the point on a latency-critical path, and the cost everywhere else.
- `std::unexpected<E>` is a *type* (a wrapper); `std::unexpect` is a *tag* (for in-place error construction); `std::bad_expected_access<E>` carries a copy of `E` and derives from `std::exception` via `bad_expected_access<void>`.

**Interview line** — "`expected` makes failure a value in the return type: no unwinding, no allocation by the wrapper, but every caller pays a branch and the error type is part of your ABI."

**Traps** — `r.error()` on a value-holding `expected` is UB, not a throw · `std::unexpected` (type) vs `std::unexpect` (tag) vs `std::nullopt` · `expected<T,E>` where `E` is a `std::string` allocates on every failure · forgetting `[[nodiscard]]` lets callers drop the whole error channel · a large `E` inflates `sizeof(expected)` for the success path too · `and_then` requires the callable to return an `expected` with the *same* `E`.

---

## 15.9 Assertions, preconditions, invariants, and unreachable states

```cpp
#include <cassert>

Price const& level(std::size_t i) const noexcept {
    assert(i < levels_.size());        // erased entirely when NDEBUG is defined
    return levels_[i];
}

assert(++checked_count);               // BUG: side effect vanishes under NDEBUG
assert(("index out of range", i < n)); // old comma-string trick
assert(i < n && "index out of range"); // preferred: message shows in the diagnostic

static_assert(sizeof(Price) == 8, "unexpected layout");   // compile time, always active
```

```cpp
// ---- a check that survives release ------------------------------------
#define ALWAYS_CHECK(cond)                                            \
    do { if (!(cond)) [[unlikely]] {                                  \
        fail_fast(#cond, __FILE__, __LINE__, std::source_location::current()); \
    } } while (0)

[[noreturn]] void fail_fast(char const*, char const*, int,
                            std::source_location) noexcept;
// Fatal handler: no locks, no allocation, write(2) to fd 2, then std::abort().
```

| Term | Meaning | Enforcement |
|---|---|---|
| **Precondition** | What the caller must establish before the call | Types > assert > documented UB |
| **Postcondition** | What holds after successful return | Assert at exit, tests |
| **Class invariant** | Holds at every observable point outside member functions | Ctor establishes, each mutator restores |
| **Validation** | Check of *untrusted* runtime input | Must remain in release; returns `expected`/`error_code` |
| **Assumption** | Optimizer fact with no check | `std::unreachable()`, `[[assume]]` (C++26) |

```cpp
// ---- checked boundary, unchecked core ---------------------------------
std::expected<Event, DecodeError> decode(std::span<std::byte const>) noexcept;  // VALIDATES

void apply_validated(Event const& e) noexcept {   // core: assumes the contract
    assert(e.quantity > 0 && "decode must have rejected this");
    // bounded, branch-light work
}
// Valid ONLY if every path into the core passes through decode/normalize,
// or the type itself makes the invariant unrepresentable:
class PositiveQty {                     // invariant enforced by construction
    std::uint32_t v_;
    explicit constexpr PositiveQty(std::uint32_t v) noexcept : v_{v} {}
public:
    static std::optional<PositiveQty> make(std::uint32_t v) noexcept {
        if (v == 0) return std::nullopt;
        return PositiveQty{v};
    }
    constexpr std::uint32_t get() const noexcept { return v_; }
};
```

```cpp
// ---- unreachable states -----------------------------------------------
#include <utility>

char side_char(Side side) noexcept {
    switch (side) {
        case Side::bid: return 'B';
        case Side::ask: return 'A';
    }
    std::unreachable();      // C++23: PROMISE, not a check — UB if reached
}

char side_char_hardened(Side side) noexcept {   // untrusted tag from the wire
    switch (side) {
        case Side::bid: return 'B';
        case Side::ask: return 'A';
        default: fail_fast("bad side", __FILE__, __LINE__, {});  // deterministic
    }
}

// Closed internal variants: let the type system prove exhaustiveness.
std::visit(overloaded{
    [](Add   const& a) { apply(a); },
    [](Cancel const& c) { apply(c); },
}, event);   // ill-formed if an alternative is unhandled — better than unreachable()
```

| Facility | Header | Semantics |
|---|---|---|
| `assert(expr)` | `<cassert>` | Erased with expression when `NDEBUG`; on failure prints and calls `std::abort()` |
| `static_assert(c, msg)` | core | Compile time; message optional since C++17 |
| `std::unreachable()` | `<utility>` | C++23; `[[noreturn]]`; reaching it is UB |
| `std::source_location::current()` | `<source_location>` | C++20; file/line/function/column as a default argument |
| `std::stacktrace` / `stacktrace_entry` | `<stacktrace>` | C++23; capture at the failure point (implementation support varies) |
| `[[nodiscard]]`, `[[nodiscard("why")]]` | core | Diagnostic on discarded result, C++20 for the reason string |
| `[[noreturn]]` | core | Function never returns; returning is UB |
| `[[assume(expr)]]` | core | **C++26**, not C++23 — do not advertise as portable here |
| `std::abort()` | `<cstdlib>` | No destructors, no atexit, `SIGABRT` |
| `-D_GLIBCXX_ASSERTIONS` / `_LIBCPP_HARDENING_MODE` | toolchain | Library-level bounds/precondition checks in release |

- C++23 has **no** standard contract facility (`pre`/`post` land in C++26); until then contracts are types, constraints, docs, asserts, checked/unchecked API pairs, tests, and sanitizer builds.
- Prefer making an invalid state unrepresentable (strong typedefs, factory-validated types) over asserting it later.

**Traps** — `assert` as the only bounds check on wire data means release-mode UB · side effects inside `assert` disappear under `NDEBUG` · `assert` in a `constexpr` function makes it non-constant-evaluable on failure · `std::unreachable()` after a switch on a *deserialized* enum invites arbitrary code paths · `[[nodiscard]]` produces a warning, not enforcement · a `default:` label defeats the compiler's "unhandled enumerator" warning — omit it for closed internal enums, add it for untrusted input.

---

## 15.10 Exceptions disabled or excluded from latency-critical paths

- The standard guarantees **nothing** about exception cost: not zero-cost-on-success, not allocation-free throwing, not constant-time or bounded unwinding.
- Common Itanium-ABI implementations make the *non-throwing* path near-free (side tables, no runtime checks) and the *throwing* path very expensive — that is implementation evidence, not language law.
- Throwing typically touches: `__cxa_allocate_exception` (may allocate or use an emergency pool), unwind-table lookup (often a global lock or read-only mapping), per-frame personality routine dispatch, and cold handler code.
- Unwind cost scales with the number of frames **and** the amount of cleanup, and pollutes I-cache/D-cache and branch predictors.
- `-fno-exceptions` is a **toolchain** mode, not a language mode: `throw` becomes `abort`, `try`/`catch` are rejected, and standard-library throwing paths become fatal.
- Mixing `-fno-exceptions` and exception-enabled TUs across inline/template boundaries is an ODR and ABI hazard — validate with your toolchain or don't do it.

```text
Layered architecture that most desks actually use
─────────────────────────────────────────────────────────────────────
setup / control plane   exceptions permitted; catch at the ownership boundary
decode / hot path       expected<T, compact_error> or status enum; noexcept
internal corruption     assert in debug + explicit fail-fast/isolate policy
outer fatal boundary    catch(...) → bounded lock-free diagnostic → terminate/restart
```

```cpp
// ---- hot path: no throw, no allocate, no format -----------------------
struct alignas(64) Engine {
    [[nodiscard]] std::expected<void, ApplyError>
    on_packet(std::span<std::byte const> bytes) noexcept {
        auto ev = decode(bytes);                     // expected, noexcept
        if (!ev) return std::unexpected(to_apply(ev.error()));
        return apply(*ev);                           // noexcept
    }
};

// ---- control plane: exceptions fine -----------------------------------
int main() try {
    Config cfg = load_config("feed.cfg");            // may throw
    Engine engine{cfg};
    return run(engine);
} catch (std::exception const& e) {
    std::fputs(e.what(), stderr);                    // bounded diagnostic
    return 1;
}
```

```cpp
// ---- preallocate so the hot path cannot fail ---------------------------
class Session {
    std::vector<Order> orders_;
public:
    explicit Session(std::size_t cap) { orders_.reserve(cap); }  // throws HERE, at setup
    bool add(Order o) noexcept {                                 // never throws, never allocates
        if (orders_.size() == orders_.capacity()) return false;  // explicit backpressure
        orders_.push_back(std::move(o));                         // no realloc possible
        return true;
    }
};
```

| Channel | Success cost | Failure cost | Fits |
|---|---|---|---|
| Exception | ~0 on modern ABIs (table-driven) | microseconds, unbounded, may allocate | rare control-plane failure, deep skip |
| `expected<T, E>` | one branch + `sizeof(E)` in the return slot | one branch | per-message recoverable errors |
| `error_code` out-param | one branch, 2 words | one branch | OS/library boundaries, C-friendly |
| `optional<T>` | one branch | one branch | reasonless absence |
| Status enum + out-param | one branch | one branch | C ABI, `-fno-exceptions` builds |
| Assert/fail-fast | zero in release | process death | programmer-controlled invariants |

- Result channels are **not free**: a branch on every call, a fat `E` inflating every return, a copied payload, or a silently ignored status can cost more than a well-placed exception for a genuinely rare failure.
- Preallocate at setup so the hot path's only failure is a documented capacity/backpressure result, not an allocation exception.
- `std::vector::at`, `std::stoi`, `std::string` growth, `std::format`, `std::regex`, and any `new` are latent throw+allocate sites inside "hot" code.
- Measure the real path: fix the semantic architecture first, then the mechanism.

**Interview line** — "Exceptions are excluded from the hot path not because they are slow to *not* throw, but because their throwing cost is unbounded and unmeasurable in a latency budget."

**Traps** — assuming "zero-cost exceptions" means zero cost when thrown · `-fno-exceptions` silently turning `bad_alloc` into `abort` deep inside the standard library · an `expected<T, std::string>` allocating on every malformed packet in a burst · logging on the fatal path taking a lock that the crashing thread already holds · exceptions crossing a `noexcept`, C, thread-entry, or plugin boundary and terminating the process instead of failing the request.
