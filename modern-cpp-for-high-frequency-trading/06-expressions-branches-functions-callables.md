# Chapter 6 — Expressions, Branches, Functions, and Callables

An expression that produces the right value can still hide an unspecified order, a long dependency chain, an indirect branch, or an allocation. These distinctions matter in event-processing code, where a small semantic misunderstanding can become either undefined behavior or a persistent source of tail latency. This chapter separates evaluation order from sequencing, explains when control-flow transformations help, and follows calls from direct functions through lambdas and type-erased wrappers. The objective is not to eliminate every branch or call. It is to make their semantics and costs visible.

## 6.1 Sequencing, Evaluation Order, and Structured Bindings

**Evaluation order** selects which subexpression is evaluated first. **Sequencing** states whether one evaluation is completed before another. C++ can specify one without fixing the other.

If evaluation A is **sequenced before** B, A completes before B begins. If A and B are **indeterminately sequenced**, one completes before the other, but the standard does not say which. If they are **unsequenced**, their evaluations may interleave, and conflicting accesses to the same scalar can cause undefined behavior.

Function arguments illustrate the distinction:

```cpp
#include <cstdio>

int mark(const char* text) {
    std::puts(text);
    return 1;
}

void consume(int, int) {}

int main() {
    consume(mark("left"), mark("right"));
}
```

Since C++17, the two argument evaluations are indeterminately sequenced: one `mark` call completes before the other starts. Their order remains unspecified. A program that requires “left” first is incorrect even though there is no character-level interleaving between the calls.

Several operators impose order. The left operand of `&&`, `||`, and the comma operator is sequenced before the right. The first operand of `?:` is evaluated before exactly one selected alternative. Most arithmetic operators do not impose a left-to-right evaluation order merely because their notation reads that way.

C++17 structured bindings introduce names for elements of an array, tuple-like object, or suitable class. The initializer is evaluated once, then bindings are initialized in declaration order according to the applicable binding protocol.

```cpp
#include <cstdint>
#include <utility>

std::pair<std::uint64_t, int> next_update();

void process() {
    [[maybe_unused]] auto [sequence, quantity] = next_update();
    // The binding owns a copied/moved result.
    // sequence and quantity name subobjects of the hidden binding object
}
```

`auto [a, b] = expression` normally creates a hidden object from the initializer; `auto& [a, b] = object` binds through a reference. The latter can dangle if the referred object dies. With tuple-like types, `get<I>` calls participate in binding and can contain user code, so a visually simple binding need not be free.

Separate side effects when order matters:

```cpp
auto first = read_first();
auto second = read_second();
consume(first, second);
```

This usually produces the same optimized machine code while giving readers and tools an explicit order.

Overloaded operators are function calls and can have sequencing rules different from a handwritten function-looking equivalent. Since C++17, an overloaded operator used with operator notation follows the sequencing rule of that operator where specified, while an explicit call to `operator@(a, b)` follows function-call rules. Avoid overloads whose correctness depends on subtle side-effect order; an operator should behave like the operation its spelling suggests.

Sequencing constrains observable evaluations, not the physical issue order of independent instructions. The compiler and CPU may overlap loads and arithmetic when no observable difference results. `volatile` accesses and atomic operations add particular observable constraints, but an ordinary statement boundary is not a hardware fence.

## 6.2 Short-Circuiting and Fold Expressions

The built-in logical `&&` and `||` operators **short-circuit**: the right operand is evaluated only when needed to determine the result. This is both a safety property and a performance property.

```cpp
#include <cstddef>

bool valid_message(const std::byte* data, std::size_t size) noexcept {
    return size >= 4 && data[0] == std::byte{0x4d};
}
```

The bounds check completes before the byte access. Replacing the expression with bitwise `&` evaluates both operands and makes the access invalid when `size == 0`. A compiler may implement a logical expression with a branch, conditional instructions, or predication, but it must preserve the rule that an unneeded right operand has no effects.

A **fold expression** applies an operator across a parameter pack. C++17 supports unary and binary left and right folds. Parenthesization determines association; the chosen operator determines sequencing.

```cpp
#include <utility>

template<class... Predicates>
bool all(Predicates&&... predicates) {
    return (std::forward<Predicates>(predicates)() && ...);
}
```

This unary right fold expands conceptually as `p1() && (p2() && p3())`. The logical operator checks predicates left to right and stops at the first false result. A fold over comma also imposes order. A fold over `+` determines grouping but does not turn operand evaluation into a guaranteed left-to-right sequence.

Association matters for floating-point results and dependency depth. A left fold over addition creates a serial accumulator chain. A balanced reduction exposes independent additions but can produce a different floating-point result and is not what the fold syntax itself guarantees. Chapter 18 revisits reductions under SIMD.

Fold expressions generate code proportional to pack size. A long compile-time list of validators may inline into a large block with many branches. For a bounded, small protocol schema this can be effective. For hundreds of handlers it can inflate the instruction working set. Inspect object size and hot assembly rather than assuming compile-time expansion has zero runtime cost.

Empty packs need an identity. Unary folds over `&&`, `||`, and comma have specified empty-pack results; most other operators do not. A binary fold supplies an initial value and can support an empty pack. Select the identity from the domain—zero for addition may be appropriate, while a price minimum needs a deliberate sentinel or an optional result.

## 6.3 Dependency Chains and Instruction-Level Parallelism

A **data dependency** exists when an instruction needs a result produced by an earlier instruction. Modern out-of-order CPUs can execute independent instructions concurrently, but they cannot execute through a true dependency.

```cpp
#include <cstdint>
#include <span>

std::uint64_t serial_sum(std::span<const std::uint32_t> values) {
    std::uint64_t sum = 0;
    for (auto value : values) {
        sum += value; // every addition depends on the preceding sum
    }
    return sum;
}
```

The loop has abundant load work but one serial accumulator. Multiple accumulators can expose more instruction-level parallelism (ILP):

```cpp
std::uint64_t split_sum(std::span<const std::uint32_t> v) {
    std::uint64_t a = 0, b = 0, c = 0, d = 0;
    std::size_t i = 0;
    for (; i + 4 <= v.size(); i += 4) {
        a += v[i]; b += v[i + 1]; c += v[i + 2]; d += v[i + 3];
    }
    for (; i < v.size(); ++i) a += v[i];
    return (a + b) + (c + d);
}
```

Compilers often perform this transformation while unrolling or vectorizing, but aliasing, overflow semantics, or strict floating-point rules can prevent it. The integer example uses a wide unsigned accumulator, whose arithmetic is defined modulo its width.

Dependencies extend beyond arithmetic. A linked-list traversal loads the next address from the current node, so multiple cache misses cannot easily overlap. A hash lookup may depend on the hash before selecting a bucket and on the bucket load before following a node. Branchless code may replace one mispredicted branch with a chain of comparisons, masks, and dependent selects.

Memory dependencies can be ambiguous rather than definite. If the processor does not yet know whether an older store and younger load use the same address, it may speculate or wait. Aliasing information helps the compiler arrange the operations; the microarchitecture's memory disambiguator handles the issued instructions. A mis-speculation replays work. Dense data and simple address calculations generally give both layers an easier problem.

Latency and reciprocal throughput are different instruction properties. An instruction with a latency of several cycles may still accept a new independent operation every cycle on a particular microarchitecture. A dependency chain pays latency; independent chains can approach throughput limits. Neither number is a C++ guarantee.

Use source analysis, compiler output, and counters together. `perf stat` reports cycles and instructions, while a microarchitecture-aware analyzer can estimate port pressure for a fixed assembly sequence. Real measurements remain necessary because cache misses, prediction, frequency, and surrounding code change the result.

## 6.4 `if`, `switch`, Three-Way Comparison, and Conditional Moves

`if`, `switch`, `?:`, and comparison expressions specify values and selected evaluations, not instruction choices. An optimizing compiler may use branches, conditional moves, masks, or lookup tables when their observable behavior is equivalent.

```cpp
int sign(int quantity) noexcept {
    if (quantity < 0) return -1;
    if (quantity > 0) return 1;
    return 0;
}
```

A dense `switch` can become a jump table; a sparse switch can become a decision tree or comparisons. A jump table adds an indexed load and indirect branch, consumes table space, and needs a range check. For a handful of cases, direct comparisons can be smaller and more predictable.

Case labels do not create scopes, and fallthrough is semantic unless control transfers. Use `[[fallthrough]]` when intentional. In a message decoder, validate the numeric message type before using it as an array index; a compiler-generated switch range check is not a substitute for protocol validation when other code also consumes the value.

C++20's three-way comparison operator, `<=>`, produces an ordering category such as `std::strong_ordering`. It can synthesize the ordinary relational operators when defaulted:

```cpp
#include <compare>
#include <cstdint>

struct PriceLevel {
    std::int64_t ticks;
    auto operator<=>(const PriceLevel&) const = default;
};
```

Defaulted comparison follows member order and can stop after the first difference. This is a semantic convenience, not a promise of one machine comparison. For structures, it may generate several loads and branches. Floating-point `<=>` yields a partial ordering because NaNs are unordered.

A **conditional move** selects between register values without changing control flow. It can avoid a branch misprediction but keeps both input-producing dependency paths relevant. The compiler cannot eagerly evaluate an alternative that might throw, fault, perform I/O, or otherwise have an observable effect.

Lookup tables can replace computation with memory access. A 256-entry classification table is small and predictable; a large, sparsely accessed table can trade arithmetic for cache misses. Count the load, table footprint, and bounds work before calling the transformation faster.

## 6.5 Predictable and Unpredictable Branches

A branch is **predictable** when the processor's predictor usually chooses its direction and target correctly in context. Correctly predicted branches can be cheap enough that their alternatives do more work. A misprediction discards speculative work and redirects the front end, creating a microarchitecture-dependent penalty.

Data distribution is decisive. A branch that rejects one malformed packet per million can be highly predictable. A branch on random buy/sell sides may be close to evenly split, yet correlations in the actual feed can still make it predictable. Alternation, phases, history, and aliasing in predictor tables all matter.

```cpp
std::int64_t sum_positive(std::span<const std::int32_t> values) {
    std::int64_t total = 0;
    for (auto value : values) {
        if (value > 0) total += value;
    }
    return total;
}
```

The compiler may vectorize this loop with masks, removing the scalar branch. If it remains scalar, sorted positive/negative runs can behave very differently from uniformly random signs. A benchmark that tests only one distribution does not characterize the operation.

Indirect branches add target prediction. A virtual call, function pointer, or type-erased callable invoked from one call site with one stable target can be predicted well. The same site cycling among many targets can produce misses. Thus “indirect” does not mean “always mispredicted.”

Misprediction cost also depends on what lies behind the branch. Independent useful work before the branch resolves can occupy execution resources, while a branch waiting on a cache-missed load leaves a long speculative window. Moving a cheap discriminant earlier can resolve control sooner. Duplicating a load solely to decide earlier may instead increase pressure, so verify the complete schedule.

Measure branch behavior with target hardware counters:

```sh
perf stat -e cycles,instructions,branches,branch-misses ./branch_benchmark
```

Report the input distribution, warmup, compiler flags, and whether vectorization occurred. Branch-miss counts alone do not identify the source line; sampling or processor tracing may be needed.

Separate per-item cost from burst behavior. A predictor warmed on one message regime may mispredict repeatedly when the feed changes phase, and those misses can cluster in a latency window. Record histograms by workload phase instead of averaging opening, continuous trading, and recovery into one branch-miss percentage.

## 6.6 `[[likely]]`, `[[unlikely]]`, and Profile Information

C++20 `[[likely]]` and `[[unlikely]]` are hints attached to statements or labels. They do not change semantics and do not force a particular branch instruction or layout.

```cpp
bool apply(const Message& message) {
    if (!message.valid()) [[unlikely]] {
        record_rejection(message);
        return false;
    }
    update_book(message);
    return true;
}
```

GCC or Clang may use the hint to arrange fall-through code, bias optimization decisions, and separate cold blocks. Keeping the common path contiguous can improve instruction fetch. The processor's dynamic predictor still learns from runtime history; the attribute is not a command sent with each branch.

Incorrect hints can enlarge or distort hot code. A condition rare in production may be common during recovery, startup, or a feed fault—the exact period when tail behavior matters. Use attributes for durable domain facts, such as a validated error path, and not as decoration on every condition.

Hints on labels inside a `switch` can express expected cases, but conflicting or nested hints quickly become hard to interpret. They also become stale as venue mix changes. Keep each annotation close to a documented invariant and include hinted paths in performance regression tests.

Profile-guided optimization (PGO) supplies measured edge and call-target frequencies to the compiler. It can guide inlining, block layout, code placement, devirtualization, and cloning more accurately than local hints. Its quality depends on workload representativeness. A profile containing only the opening auction may damage the continuous-trading path.

A responsible workflow records the compiler version, build flags, training corpus, and profile age. Compare both central latency and tails across normal, burst, and recovery workloads. Static hints remain useful where training cannot exercise operational failures, but source annotations should document the assumed frequency.

## 6.7 When Branchless Code Loses

**Branchless code** computes a result without data-dependent control transfer. It can help when a branch is genuinely unpredictable and both alternatives are cheap. It loses when it performs unnecessary work, lengthens dependencies, increases memory traffic, or blocks better optimization.

```cpp
// Clear and often compiled without a branch when profitable.
int minimum(int a, int b) noexcept {
    return a < b ? a : b;
}
```

Hand-written mask tricks are usually inferior to expressing selection directly. They can depend on representation or overflow behavior, obscure intent, and prevent the compiler from choosing a branch when prediction is excellent.

Never make unsafe work unconditional:

```cpp
// CORRECT: only the selected pointer is dereferenced.
int select(bool use_first, const int* first, const int* second) {
    return use_first ? *first : *second;
}
```

Loading both values and selecting afterward changes semantics if the unselected pointer can be null or invalid. It also doubles load traffic and may bring an unnecessary cache line into the working set.

Branchless table lookup introduces address dependencies and possible cache misses. Branchless binary search variants may load from more nodes than a conventional search. Masked arithmetic can execute an expensive divide for a case that a branch would skip. On the other hand, SIMD naturally uses masks to operate on many lanes, so the right comparison can change with vector width.

Compare implementations with the same validation and error behavior. Test realistic distributions, including stable runs and adversarial alternation. Inspect instruction count, branch misses, cache misses, and critical dependencies. “Fewer branches” is not an acceptance criterion; lower and more stable end-to-end cost is.

Constant-time security code is a separate requirement. There, avoiding secret-dependent control flow and memory access protects information even if it costs more. A branchless trading calculation is not automatically constant-time, because table indexes, cache state, division, and compiler transformations can still depend on data.

## 6.8 Passing by Value, Pointer, Reference, and `const` Reference

Parameter passing defines ownership and mutation semantics before it defines machine cost. A value is an independent function parameter; a pointer is nullable unless constrained; a reference must bind to an object but can still dangle; a `const` reference prevents mutation through that path without promising non-aliasing.

For small scalar and handle types, pass by value:

```cpp
struct OrderId { std::uint64_t value; };

bool is_cancel(OrderId incoming, OrderId resting) noexcept {
    return incoming.value == resting.value;
}
```

A common x86-64 or AArch64 ABI passes these values in registers. Passing an eight-byte integer by `const&` commonly passes an address instead, adding indirection and aliasing uncertainty. C++ itself does not specify registers or a calling convention.

Use a pointer when absence is meaningful or pointer arithmetic is part of the interface. Use a reference for a required object. Use `std::span<T>` for a contiguous range; it commonly contains a pointer and size, makes bounds available, and expresses no ownership.

A span passed by value copies only its descriptor, not its elements. Its elements can still alias any other view, and the span does not extend their lifetime. Fixed-extent spans may encode the size in the type and commonly store only a pointer. These are useful interface facts, not a guarantee that a particular ABI uses a specific register assignment.

Large values need case-specific analysis. Passing by value can copy at the call boundary, but a “sink” function that needs its own object can accept by value and move into storage, allowing callers to choose copy or move. A `const&` avoids the initial copy but may force a later one.

Returning by value is often efficient. C++17 guarantees copy elision in specified prvalue cases:

```cpp
// Excerpt: Quote is an aggregate defined by the surrounding application.
Quote make_quote() {
    return Quote{/* fields */}; // constructed directly in result storage
}
```

Named return-value optimization (NRVO) for `return local;` is permitted but not universally mandatory. Do not write `return std::move(local);`; it can inhibit NRVO. Common ABIs pass hidden result-storage addresses for large returned objects.

Default arguments are substituted at the call site based on the static declaration visible there. They do not provide virtual dispatch and can create versioning surprises across separately compiled callers. Changing a default in a shared-library header does not change already compiled call sites.

ABI classification can split a small aggregate among registers, pass it indirectly, or use a hidden result pointer. Adding one field can cross a threshold and change every call boundary even if the source signature still looks simple. Public ABI types need compatibility review; private hot functions need assembly inspection only when profiling shows that boundary matters.

## 6.9 Inline Linkage and Compiler Inlining

The `inline` specifier primarily changes language linkage and definition rules. It permits identical definitions in multiple translation units and gives an inline function or variable one entity with one address under the One Definition Rule. It does not require the compiler to replace calls with function bodies.

**Compiler inlining** is an optimization that substitutes a callee body at a call site. Compilers can inline functions not declared `inline` and decline to inline ones that are. Visibility, optimization level, body size, call frequency, recursion, exception behavior, and profile data affect the choice.

Inlining removes call/return work and exposes constants, alias facts, and dead paths to further optimization. It can also duplicate code at many sites, increasing executable size and instruction-cache pressure. A tiny price conversion is a strong candidate; a large rejection logger is usually not.

Functions defined in headers are visible to each translation unit. Functions compiled separately may require link-time optimization (LTO) for cross-unit inlining. Templates are often defined in headers because instantiation needs their definitions, but template visibility still does not guarantee inlining.

Attributes such as GCC and Clang's `always_inline` and `noinline` are nonstandard and do not override every compiler limitation. Use them sparingly at measured boundaries. They can make debugging, sanitization, and code layout worse.

Inspect decisions and resulting size:

```sh
clang++ -std=c++23 -O3 -Rpass=inline -Rpass-missed=inline -c calls.cpp
objdump -drC calls.o
size calls.o
```

The final machine code is the evidence. Source-level `inline` is not.

Inline definitions still obey the One Definition Rule. Different macro settings that produce different definitions in separate translation units create an ill-formed program for which a diagnostic is not generally required. This failure can look like optimizer instability because the linker selects or merges bodies. Keep configuration-dependent implementation out of inline definitions or ensure every translation unit sees identical configuration.

## 6.10 Recursion, C Varargs, Variadic Templates, and `noexcept`

Recursion creates a new abstract function invocation for each non-elided call. A common ABI uses stack space for return addresses, saved registers, spills, and local objects, though exact frame layout is implementation-specific.

Tail-call elimination is not guaranteed by C++. Destructors, stack-protector work, calling-convention mismatches, or compiler choices can prevent it. Recursion with data-dependent depth risks stack overflow and unbounded latency. A bounded tree traversal may be clear and acceptable; a parser driven by untrusted nesting should enforce a depth limit or use explicit storage.

Even bounded recursion affects predictability when each frame contains large locals or triggers stack growth into untouched pages. Estimate maximum frame depth, inspect stack-usage reports, and prefault thread stacks when the operational design requires it. Converting recursion to an explicit fixed-capacity stack makes overflow policy visible.

C varargs erase type information after the named parameters:

```cpp
#include <cstdarg>

double sum_doubles(int count, ...) {
    va_list args;
    va_start(args, count);
    double result = 0;
    for (int i = 0; i < count; ++i) {
        result += va_arg(args, double);
    }
    va_end(args);
    return result;
}
```

Default argument promotions apply, and retrieving a value with an incompatible type is undefined behavior, subject to narrow specified exceptions. Varargs also complicate ABI register-save areas and static checking.

Variadic templates preserve types and enable compile-time validation:

```cpp
template<class... Values>
auto sum(Values... values) {
    return (values + ...);
}
```

They can inline efficiently but create a distinct instantiation for each type sequence, increasing compile time and code size.

`noexcept` is part of a function's exception specification and, since C++17, its function type. If an exception escapes a non-throwing function, `std::terminate` is called; callers cannot recover by catching across that boundary.

```cpp
void commit(Order& order) noexcept {
    // Every reachable operation must honor the non-throwing contract.
    order.state = State::live;
}

static_assert(noexcept(commit(std::declval<Order&>())));
```

`noexcept` can enable library choices, most notably moving container elements when move construction is known not to throw. It may also reduce exceptional control-flow obligations, but it does not guarantee faster instructions. Declare it because the interface can uphold the contract, especially at C callbacks and thread entry boundaries where escape would be fatal anyway.

Conditional exception specifications propagate a generic operation's contract: `noexcept(noexcept(f(args...)))`. Standard traits such as `std::is_nothrow_invocable_v` let an adapter select a non-throwing path. Do not mark a wrapper unconditionally `noexcept` merely to improve a trait; that converts a target exception into termination.

## 6.11 Function Pointers and Member Pointers

A function pointer stores the address of a compatible free or static member function. Calling through it is indirect unless optimization proves the target.

```cpp
using Handler = void (*)(const Message&) noexcept;

void on_add(const Message&) noexcept;
void on_cancel(const Message&) noexcept;

constexpr Handler handlers[] = {on_add, on_cancel};
```

The pointer itself requires no heap allocation. A stable table is compact and suitable for C interoperability. At runtime, a bounds check and indexed load often precede the indirect call. Target prediction and inability to inline may dominate the call instruction's direct cost.

A function pointer carries no environment. C APIs therefore commonly pair it with `void* context`. The callback casts the context back to its documented type, so lifetime and thread-safety remain the caller's responsibility. This pair is a useful non-owning callable reference when its validity interval is explicit.

A pointer to member is not necessarily a raw code address. It may need to encode adjustment information for inheritance or distinguish virtual dispatch. Its representation and size are ABI-specific.

```cpp
struct Book {
    void add(const Message&) noexcept;
};

using MemberHandler = void (Book::*)(const Message&) noexcept;

void dispatch(Book& book, MemberHandler handler, const Message& message) {
    (book.*handler)(message);
}
```

Do not serialize member pointers or assume they fit in `void*`. Even converting function pointers to object pointers is not a generally portable C++ representation technique.

If the handler is a compile-time template argument, the compiler knows the target and can inline it, at the cost of one instantiation per handler. If it is runtime configuration, an indirect function pointer may be the appropriate honest abstraction. Choose based on mutability and target diversity, not a blanket rule against indirect calls.

Indexing a function-pointer table with untrusted data requires a bounds check before the load. Spectre-class threats can require stronger mitigation at a security boundary because speculative execution may run beyond architectural checks. Ordinary language correctness and speculation-hardening are separate reviews; Chapter 41 develops that distinction.

## 6.12 Capturing, Non-Capturing, and Generic Lambdas

A lambda expression creates an unnamed **closure type** with a call operator. Captures become closure state, with representation and layout chosen by the implementation subject to language rules.

```cpp
auto above = [threshold = std::int64_t{10'000}](const Quote& q) noexcept {
    return q.price_ticks > threshold;
};

static_assert(sizeof(above) >= sizeof(std::int64_t));
```

Value capture owns a member initialized from the captured value. Reference capture stores whatever representation the implementation uses to refer to the original object and can dangle. `[this]` captures the pointer, not an owning copy of the object. C++20's `[*this]` captures a copy of the object, which may be unexpectedly large or expensive.

A captureless lambda converts to a function pointer with a compatible signature. A capturing lambda does not, because a plain function pointer has nowhere to store the closure object.

Generic lambdas, introduced in C++14, have a templated call operator:

```cpp
auto price_of = [](const auto& update) noexcept {
    return update.price_ticks;
};
```

Each argument type instantiates another call operator. This enables static dispatch and inlining, but many types can increase code size. C++20 explicit template parameter lists allow constraints and named template parameters on lambdas.

Lambda objects do not allocate merely because they capture. Their state is inline in the closure. Allocation can occur when a large closure is placed in a type-erased wrapper, copied into a dynamic task node, or captures an owning object that allocates. Inspect `sizeof(lambda)` and trace the enclosing storage policy.

Capturing several neighboring locals by reference does not guarantee that a closure stores one base pointer; layout is unspecified. Capture a deliberate context object when identity and lifetime belong together. Init-capture can move ownership into a task, making delayed execution safer while also making the closure non-copyable.

## 6.13 `std::function` Storage, Allocation, and Indirection

`std::function<R(Args...)>` is a copyable, type-erased owner of a callable compatible with the signature. It can hold a function pointer, lambda, function object, or bound expression without exposing the concrete type.

Type erasure requires runtime dispatch and management operations. A typical implementation stores an inline buffer plus a manager/invoker mechanism. Small suitable targets may fit inline; larger or specially aligned targets may require heap allocation. The C++ standard does not specify a universal buffer size or general small-object optimization policy.

```cpp
#include <cstddef>
#include <array>
#include <functional>

std::function<bool(const Quote&)> make_filter(std::int64_t limit) {
    return [limit](const Quote& q) { return q.price_ticks <= limit; };
}

std::function<void()> possibly_large() {
    std::array<std::byte, 256> state{};
    return [state] { /* use state */ };
}
```

The first closure commonly fits an implementation's inline storage. The second commonly allocates. Neither outcome is guaranteed by the signatures. Copying a `std::function` copies its target and can allocate; moving commonly transfers ownership but details depend on the target and implementation.

Target alignment can defeat inline storage even when byte size fits. Exception guarantees for moving the target can also influence an implementation's strategy. Therefore test the concrete target, not an empty or captureless surrogate. An allocation seen during wrapper construction belongs outside the hot path only if wrapper replacement and copying are also excluded there.

Invocation normally performs an indirect call and prevents ordinary inlining when the concrete target is unknown. A compiler with whole-program visibility may sometimes devirtualize the wrapper, but code should not rely on it. Calling an empty `std::function` throws `std::bad_function_call`.

For a setup-time callback outside the critical path, these costs may buy valuable flexibility. For a per-packet callback, prefer a template parameter when the target is compile-time fixed, a function pointer plus context when a small non-owning ABI is needed, or a bounded custom wrapper whose inline capacity and failure policy are explicit.

A non-owning “function reference” can represent a callable as an erased object pointer plus invoker pointer. Such a wrapper is often two words and allocation-free, but it can dangle as easily as `std::string_view`; C++23 does not provide a standard `function_ref`. A project-specific version needs a clear lifetime contract and must decide whether temporary callables are rejected. Type erasure removes the concrete type, not the caller's duty to keep the target alive.

A fixed-capacity owning wrapper makes oversize handling part of the API: reject at compile time, return an error, or allocate from a named fallback resource. That predictability can be valuable in a hot path, but implementing correct copy, move, destruction, alignment, and exception behavior is substantial work. Chapter 42 turns it into a workshop rather than treating it as a trivial replacement.

Verify allocation rather than inferring it from `sizeof(std::function<...>)`. Use a counting allocator around the application boundary, a heap profiler, or overridden allocation in an isolated test. Test the exact standard library and closure types used in production.

## 6.14 C++23 `std::move_only_function`

C++23 `std::move_only_function` is a move-only, type-erased callable wrapper. Unlike `std::function`, it can own a non-copyable target such as a lambda that captures a `std::unique_ptr`.

```cpp
#include <functional>
#include <memory>

std::move_only_function<int()> make_source() {
    auto value = std::make_unique<int>(42);
    return [owned = std::move(value)] { return *owned; };
}
```

The wrapper prevents accidental target copies and expresses single ownership. It also supports cv-, reference-, and `noexcept`-qualified function signatures, allowing the wrapper's call contract to match the intended callable use more closely.

Move-only does not mean allocation-free or direct-call. Storage strategy remains implementation-dependent, and invocation remains type-erased. The captured `unique_ptr` owns a separate allocation in this example even if the small closure itself fits the wrapper's inline storage.

Move-only ownership fits task transfer between queues, but moved-from wrappers become empty. A queue protocol must ensure exactly one consumer obtains and invokes the task. The wrapper does not provide synchronization, capacity control, or reclamation for the queue node around it.

The qualified signature can prevent interface mismatches. For example, `std::move_only_function<void() noexcept>` accepts only targets callable under the non-throwing contract, while an `&&`-qualified signature can model a one-shot invocation. These type-level restrictions are often more valuable than a hoped-for instruction saving.

An empty `move_only_function` must not be called; unlike empty `std::function` invocation, doing so has undefined behavior. Make emptiness impossible by construction or check `operator bool()` before a legitimately optional call.

At the time of writing, C++23 library availability depends on compiler and standard-library versions. Feature-test `__cpp_lib_move_only_function` and maintain an explicit fallback if the supported toolchain lacks it. Do not silently substitute `std::function` when targets are intentionally non-copyable.

Feature-test macros belong in configuration code, not scattered hot logic. If a fallback wrapper has different empty-call or allocation behavior, expose that difference in its documented contract and tests. Source compatibility is insufficient when the replacement changes ownership or failure semantics.

## 6.15 `std::bind` and `std::invoke`

`std::invoke` is the uniform operation for calling ordinary callables, pointers to members, and reference wrappers. It is primarily compile-time machinery and commonly optimizes to the corresponding direct syntax.

```cpp
#include <functional>

Book book;
MemberHandler handler = &Book::add;
std::invoke(handler, book, message); // equivalent to (book.*handler)(message)
```

Generic adapters should use `std::invoke` because it handles member-pointer rules correctly. C++17's `std::invoke_result_t` and C++20's `std::invocable` concepts can describe the interface.

`std::bind` creates a callable object that stores a function and bound arguments, then substitutes placeholders at invocation:

```cpp
using namespace std::placeholders;
auto add_to_book = std::bind(&Book::add, &book, _1);
```

The storage is in the returned binder object; `std::bind` itself does not require heap allocation. Copies, decay, reference handling, nested bind expressions, and placeholder forwarding can nevertheless be surprising. Wrapping the binder in `std::function` can add type erasure and possible allocation.

A lambda is usually clearer and gives precise capture semantics:

```cpp
auto add_to_book = [&book](const Message& m) noexcept { book.add(m); };
```

Use `std::ref` or `std::cref` when a bind expression must store a reference wrapper rather than a decayed value, and verify the referred lifetime. Prefer `std::invoke` for implementing generic call mechanisms and lambdas for adapting a known call. Both choices expose intent better than a layered binder whose types and ownership are hard to audit.

## 6.16 Call Overhead Versus Instruction-Cache Growth

A call can require argument setup, a control transfer, a return-address prediction, register saving, and a return. An indirect call additionally needs a target load and prediction. Those costs are real, but removing the call by inlining can be worse if it duplicates substantial code.

The instruction cache and instruction TLB are finite. A hot event loop containing inlined parsing, validation, book updates, risk checks, and logging branches can exceed the front end's comfortable working set. Misses and decode pressure then affect every message, including paths that never execute most of the duplicated logic.

Inlining also changes register pressure. Combining caller and callee can keep values in registers and remove spills, or it can make too many values live simultaneously and create stack traffic. The outcome depends on the call site. This is another reason a source-level count of call instructions is incomplete.

Outlining cold code is often effective:

```cpp
[[gnu::noinline]] void reject_slow(const Message&, Error);

bool validate(const Message& message) {
    if (auto error = check(message); error != Error::none) [[unlikely]] {
        reject_slow(message, error);
        return false;
    }
    return true;
}
```

The attribute is a GCC/Clang extension. Profile-guided block placement or compiler cold attributes may achieve similar layout. The important design is a small, contiguous success path and a bounded transition to detailed error work.

Static polymorphism and templates can remove indirect calls but instantiate a copy of surrounding logic per type. Dynamic dispatch shares one implementation but adds indirection. A function-pointer table offers small data and stable code size. A type-erased wrapper additionally owns state and may allocate. These are code-layout, data-layout, and ownership tradeoffs, not merely call-instruction comparisons.

Measure the final linked binary with the production compiler and LTO/PGO settings. Use `size`, `nm --size-sort`, `objdump`, compiler optimization reports, and `perf` front-end events available on the target. Benchmark realistic mixes of handlers; a single-target microbenchmark can let prediction or constant propagation erase the very dispatch being evaluated.

Prevent that erasure deliberately. Select handlers from runtime input, keep the dispatch result observable, and confirm in assembly that the compared variants still contain the intended direct or indirect call. At the same time, do not hide information the real application exposes to LTO; the benchmark should preserve production optimization opportunities as well as production uncertainty.

The right question is not “can this call be inlined?” It is “does inlining this call improve the critical path after accounting for code growth, target predictability, and the optimizations exposed inside the caller?”

## 6.17 Interview Check

1. Distinguish sequenced-before, indeterminately sequenced, and unsequenced evaluations. What can a program assume about the order of two function arguments in C++23?
2. A fold expression uses `+` across eight values. Explain the difference between association, evaluation order, dependency depth, and floating-point reproducibility.
3. Compare a predictable branch, a conditional move, and a lookup table. What work and failure modes would you measure for each?
4. Why can a branchless rewrite be both slower and incorrect when one alternative dereferences a pointer? Give a semantics-preserving alternative.
5. Explain why `inline` does not require inlining. How do LTO, PGO, and instruction-cache footprint affect the compiler's choice?
6. When should a two-word descriptor be passed by value rather than `const&`? Qualify your answer with language and ABI guarantees.
7. Compare C varargs and variadic templates in type safety, ABI work, code size, and optimization opportunity.
8. Describe the representation and lifetime risks of value capture, reference capture, `[this]`, and `[*this]` in a lambda queued for later execution.
9. Compare a function pointer, `std::function`, `std::move_only_function`, and a templated callable parameter for a per-message handler. Include ownership, allocation, copying, indirect calls, and binary size.
10. A callback benchmark reports no difference between direct and type-erased calls. What compiler transformations, input choices, and counters would you inspect before accepting the result?
