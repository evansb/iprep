# Appendices

**Contents:** [Appendix A — Operator precedence and associativity](#appendix-a) [Appendix B — Initialization decision table](#appendix-b) [Appendix C — Implicit conversion ranking](#appendix-c) [Appendix D — Special member generation matrix](#appendix-d) [Appendix E — Value categories and reference collapsing](#appendix-e) [Appendix F — Cast selection matrix](#appendix-f) [Appendix G — Container complexity and invalidation matrix](#appendix-g) [Appendix H — Iterator and range concept hierarchy](#appendix-h) [Appendix I — Standard-library thread-safety summary](#appendix-i) [Appendix J — Atomic memory orders and canonical patterns](#appendix-j) [Appendix K — Type traits and concepts quick index](#appendix-k) [Appendix L — Exception-safety checklist](#appendix-l) [Appendix M — Lifetime and ownership checklist](#appendix-m) [Appendix N — Allocation and hot-path audit checklist](#appendix-n) [Appendix O — Undefined-behavior field guide](#appendix-o) [Appendix P — C++11–C++23 feature chronology](#appendix-p) [Appendix Q — Compiler and standard-library feature-test macro index](#appendix-q) [Appendix R — HFT/quant implementation-pattern index](#appendix-r) [Appendix S — Interview last-minute recall sheet](#appendix-s) 

---

<a id="appendix-a"></a>
## Appendix A — Operator precedence and associativity

All 17 levels, highest binding first. Associativity is **grouping**, not evaluation order; see the sequencing table below.

| # | Operators | Associativity | Notes |
|---|---|---|---|
| 1 | `::` (qualified name, `class::member`, `ns::name`, `::name`) | left-to-right | Not really an operator: a name-lookup construct. Binds tighter than everything. |
| 2 | `a++` `a--` · `T(x)` `T{x}` (functional cast) · `f(args)` · `a[i]` · `a.m` `p->m` · `typeid(x)` · `static_cast`/`dynamic_cast`/`const_cast`/`reinterpret_cast<T>(x)` | left-to-right | Postfix. Named casts are complete postfix expressions, so no parenthesizing needed around the target type. |
| 3 | `++a` `--a` · `+a` `-a` · `!a` `~a` · `(T)a` (C-style cast) · `*p` · `&a` · `sizeof a` `sizeof(T)` `sizeof...(P)` · `alignof(T)` · `noexcept(e)` · `co_await a` · `new` `new[]` `delete` `delete[]` | right-to-left | Prefix/unary. `sizeof` binds tighter than binary ops: `sizeof x + 1` is `(sizeof x) + 1`. |
| 4 | `.*` `->*` | left-to-right | Pointer-to-member access. Lower than `.`/`->`, so `p->*pm` needs no parens but `(o.*pmf)(args)` does — call `()` outranks `.*`. |
| 5 | `*` `/` `%` | left-to-right | `%` is integer-only. |
| 6 | `+` `-` | left-to-right | |
| 7 | `<<` `>>` | left-to-right | Lower than `+`: `a + b << 2` is `(a+b) << 2`. Higher than relational, so `std::cout << a < b` is `(cout << a) < b`. |
| 8 | `<=>` | left-to-right | (C++20) Higher than `<`/`==`; chaining is ill-formed in practice because the result is a comparison-category type. |
| 9 | `<` `<=` `>` `>=` | left-to-right | `a < b < c` parses as `(a<b) < c` — a `bool` compared to `c`. |
| 10 | `==` `!=` | left-to-right | **Lower than bitwise-shift, higher than `&`** — the classic `flags & mask == 0` bug. |
| 11 | `&` | left-to-right | |
| 12 | `^` | left-to-right | |
| 13 | `\|` | left-to-right | |
| 14 | `&&` | left-to-right | |
| 15 | `\|\|` | left-to-right | |
| 16 | `?:` · `throw x` · `co_yield x` · `=` `+=` `-=` `*=` `/=` `%=` `<<=` `>>=` `&=` `^=` `\|=` | right-to-left | `a = b = 0` is `a = (b = 0)`. `c ? a : b = x` parses as `c ? a : (b = x)`. Assignment's RHS may itself contain `?:` without parens. |
| 17 | `,` | left-to-right | Lowest. Inside a function-argument list or braced-init-list a `,` is a **separator**, not the operator; use `(a, b)` to force the operator. |

**Precedence traps to memorize**

| Written | Parses as | Intended |
|---|---|---|
| `flags & mask == 0` | `flags & (mask == 0)` | `(flags & mask) == 0` |
| `a & b \| c` | `(a & b) \| c` | usually fine, but write parens |
| `*p++` | `*(p++)` | postfix outranks unary `*` |
| `++*p` | `++(*p)` | both right-to-left |
| `*p.m` | `*(p.m)` | `(*p).m` i.e. `p->m` |
| `a + b << 2` | `(a + b) << 2` | — |
| `x = a < b ? c : d` | `x = ((a<b) ? c : d)` | — |
| `!x == y` | `(!x) == y` | `!(x == y)` |
| `~x & mask` | `(~x) & mask` | — |
| `(int)a + b` | `((int)a) + b` | cast is unary, binds tightest of the two |
| `new T[n]()` | array-new of `n`, value-initialized | not `new (T[n])` |
| `delete p, q` | `(delete p), q` | comma is lowest |
| `sizeof(int)*p` | `(sizeof(int)) * p` | not a cast |

**Precedence is not evaluation order** — sequencing rules (C++17 and later)

| Construct | Sequencing |
|---|---|
| `a && b`, `a \|\| b` | left fully sequenced before right; right not evaluated if short-circuited |
| `a ? b : c` | condition sequenced before the chosen branch; the other branch is not evaluated |
| `a , b` (comma operator) | left sequenced before right |
| `a = b`, `a op= b` | **right** operand sequenced before left, and the assignment after both (C++17) |
| `a << b`, `a >> b` | left sequenced before right (C++17) |
| `a[b]` | `a` sequenced before `b` (C++17) |
| `a->*b`, `a.*b` | left before right (C++17) |
| `f(a, b, c)` | postfix-expression `f` sequenced before all arguments (C++17); arguments **indeterminately sequenced** relative to each other — never interleaved, but order unspecified |
| `T{a, b, c}` / braced-init-list | elements evaluated **left to right**, in order |
| `new T(expr)` | allocation function called before `expr` is evaluated (C++17) |
| `a + b`, `a * b`, all other binary operators | operands **unsequenced** relative to each other |
| `i = i++` | UB before C++17; in C++17 well-defined — the RHS (`i++`) completes first, then `i` is assigned that **old** value, so `i` is unchanged. `i = ++i` yields `i+1`. Write neither. |
| `f(i++, i)` | unspecified order, still UB-free in C++17 (indeterminately sequenced), but the value passed is unspecified |
| Full-expression end | all side effects complete at the end of the full-expression; temporaries destroyed there (reverse order of construction) |

- Overloaded operators are function calls: they get **function-call sequencing**, but retain the built-in operator's *precedence and associativity*. Overloaded `&&`/`||`/`,` therefore lose short-circuiting/left-to-right guarantees — a reason not to overload them.
- Rewritten candidates (C++20): `a != b` may become `!(a == b)`; `a < b` may become `(a <=> b) < 0`; `a @ b` may become `b @ a` with reversed arguments. Precedence is unaffected.
- `throw` and `co_yield` sit at assignment level, so `x = throw_or(a) ? b : c` needs no parens but `(cond ? throw e : v)` does when used as a subexpression.

---

<a id="appendix-b"></a>
## Appendix B — Initialization decision table

### B.1 The forms and their official names

| Syntax | Name | One-line meaning |
|---|---|---|
| `T x;` | default-initialization | Call default ctor; for scalars/trivial types leave **indeterminate** (static/thread storage: zero-init first) |
| `T x{};` | value-initialization (direct-list-init, empty) | Zero-init then default-ctor as applicable; scalars become `0` |
| `T x = {};` | copy-list-initialization, empty | Same as `T x{}` but `explicit` default ctor is an error |
| `T x(a, b);` | direct-initialization | Overload resolution over **all** ctors; narrowing allowed |
| `T x{a, b};` | direct-list-initialization | Aggregate init, or ctor call with `initializer_list` preference; **narrowing is ill-formed** |
| `T x = a;` | copy-initialization | Only non-`explicit` ctors/conversions considered |
| `T x = {a, b};` | copy-list-initialization | Like `T x{a,b}` but `explicit` ctors make it ill-formed if selected |
| `T x();` | **function declaration** | Most vexing parse — declares a function returning `T` |
| `T x(A(), B());` | **function declaration** | Vexing parse with parameters; use braces |
| `T x[N];` / `T x[N]{};` / `T x[N]{a}` | array default / value / aggregate init | Remaining elements are **value-initialized** (`{a}` ⇒ rest zeroed) |
| `T x[] {a, b}` | array with deduced extent | Extent = number of initializers |
| `new T` | default-init | Heap scalars indeterminate |
| `new T()` / `new T{}` | value-init | Scalars zeroed |
| `new T[n]` / `new T[n]{}` | array default / value init | |
| `T{}` / `T()` as an expression | prvalue value-init | `T()` on an aggregate is value-init, not a call |
| `T(a, b)` for an aggregate | parenthesized aggregate init (C++20) | Allows narrowing; **no brace elision**, **no lifetime extension**, no `initializer_list` |
| `T x{.m = a, .n = b};` | designated initialization (C++20) | Aggregates only; members in **declaration order**; no mixing with positional |
| `auto x = e;` / `auto x{e};` | copy-init / direct-list-init with deduction | `auto x{e}` deduces the element type (C++17), `auto x = {e}` deduces `std::initializer_list` |
| `T&& r = e;` / `T& r = e;` | reference initialization | Binds; may materialize and lifetime-extend a temporary |
| ctor mem-init `: m(a)` / `: m{a}` / `: m()` | member direct/list/value init | Order follows **declaration order**, not mem-init-list order |
| member omitted from mem-init-list | default-init, or the default member initializer if present | |
| `static T x;` / namespace-scope `T x;` | static init | Zero-init, then constant-init if possible, else dynamic init |

### B.2 What each form does, by type category

| Form | Scalar (`int`, `T*`, enum) | Aggregate (no user ctors, public bases/members) | Class with only non-list ctors | Class with an `initializer_list` ctor | Raw array `T[N]` | Reference |
|---|---|---|---|---|---|---|
| `T x;` | **indeterminate** (auto/dynamic storage); zero for static/thread | each element default-init ⇒ trivial members indeterminate | default ctor; error if deleted/absent | default ctor | each element default-init | **ill-formed** — must be initialized |
| `T x{};` | `0` / `nullptr` / `E{}` (value 0) | every element value-initialized ⇒ zeros, defaults applied | value-init: zero-init then default ctor if non-trivial | **default ctor wins** — empty list never means "empty `initializer_list`" | all elements value-init (zeros) | ill-formed |
| `T x = {};` | `0` | same as above | same, but `explicit` default ctor ⇒ ill-formed | default ctor | zeros | ill-formed |
| `T x(a);` | conversion; narrowing allowed | (C++20) parenthesized aggregate init, narrowing **allowed** | best-viable ctor incl. `explicit` | ordinary ctor overload resolution (no list involved) | ill-formed (`T x[N](…)` not a thing) | binds `a` |
| `T x{a};` | conversion, **narrowing ill-formed** | aggregate init of first member (brace elision applies) | best-viable ctor, narrowing checked | `initializer_list<E>` ctor **preferred** if `a` converts to `E` non-narrowingly | first element = `a`, rest value-init | binds `a`, narrowing checked |
| `T x{a, b};` | ill-formed (too many initializers) | member-wise, in declaration order; extra members value-init | ctor taking `(a,b)` | `initializer_list` ctor wins over `(a,b)` ctor | elements `a`, `b`, rest value-init | ill-formed |
| `T x = a;` | implicit conversion, non-`explicit` only | ill-formed unless `a` is a `T` (copy) | non-`explicit` converting ctor | non-`explicit` ctor | ill-formed | binds |
| `T x = {a, b};` | ill-formed | aggregate init | ctor, `explicit` selection ⇒ ill-formed | `initializer_list` ctor, must be non-`explicit` | array copy-list-init | ill-formed |
| `new T` | indeterminate | members default-init | default ctor | default ctor | — | — |
| `new T()` / `new T{}` | `0` | value-init (zeros) | value-init | default ctor | — | — |

### B.3 List-initialization resolution order (`T x{args…}`)

1. If `T` is an **aggregate** and the list is a braced-init-list → **aggregate initialization** (element-wise, declaration order, brace elision permitted, remaining members get their default member initializer or are value-initialized). Designated initializers (C++20) also land here.
2. Else if the list is **empty** and `T` has a default constructor → **value-initialization** (never an empty `std::initializer_list`).
3. Else if `T` has any `std::initializer_list<E>` constructor → those are considered **first and, if any is viable, exclusively**. A viable `initializer_list` ctor beats every other ctor, even an exact match.
4. Else all constructors are candidates; the list elements are the arguments.
5. Else if the list has exactly one element and `T` is not a class type → conversion from that element.
6. Else if `T` is a reference type → bind (with a materialized temporary for a prvalue element).
7. In every branch: **narrowing conversions are ill-formed**.

```cpp
std::vector<int> a(5, 7);   // 5 elements each 7        — parens: ordinary ctor
std::vector<int> b{5, 7};   // 2 elements: 5 and 7      — braces: init-list ctor wins
std::vector<int> c{5};      // 1 element: 5
std::vector<int> d(5);      // 5 value-initialized zeros
std::vector<std::string> e{5};   // 5 empty strings — int does not convert to string,
                                 // so the init-list ctor is not viable and rule 4 applies
```

### B.4 Narrowing — ill-formed inside braces, allowed inside parentheses

| Conversion | Narrowing? |
|---|---|
| floating → integer | always |
| `long double` → `double` / `double` → `float` | yes, unless the source is a constant expression whose value is exactly representable |
| integer → floating | yes, unless constant expression exactly representable |
| integer → smaller/unsigned integer | yes, unless constant expression whose value fits the target |
| `int` → `bool`, pointer → `bool` | yes (`bool` is an integer type here) |
| scoped enum → integer | requires an explicit cast anyway |
| unscoped enum → integer that can hold all values | not narrowing |
| `char` ↔ `signed char`/`unsigned char` | narrowing unless constant and representable |

### B.5 Reference initialization and temporary lifetime

| Initialization | Result |
|---|---|
| `T& r = lvalue_of_T;` | direct bind, no temporary |
| `T& r = prvalue;` | **ill-formed** (non-const lvalue ref cannot bind an rvalue) |
| `const T& r = prvalue;` | temporary materialized; **lifetime extended** to `r`'s scope |
| `const T& r = convertible_lvalue;` | temporary of type `T` created from the conversion, then extended |
| `T&& r = prvalue;` | materialized and extended |
| `T&& r = lvalue;` | ill-formed; needs `std::move` |
| `Base& b = derived_lvalue;` | binds to the base subobject, no temporary |
| `const Base& b = derived_prvalue;` | materialize the *derived* temporary, bind base subobject, extend the whole object |
| member `: ref_(Temp{})` in a mem-init-list | **no extension** — dangles at the end of the constructor |
| `return const T& / T&&` referring to a local temporary | **no extension** — dangles at the return |
| temporary bound to a reference that is itself bound to another reference | extension does **not** transitively propagate through a second binding |
| `auto&& r = e;` | forwarding-reference form; extends prvalues, binds lvalues |
| `for (auto& x : f().vec())` | temporaries in the range-initializer are lifetime-extended **since C++23** (P2718R0); before that this dangles |
| `std::initializer_list<T> il = {a, b};` | backing array's lifetime matches `il`; **returning** or storing an `initializer_list` member dangles |

### B.6 Static and thread-storage initialization order

| Phase | What happens |
|---|---|
| Zero-initialization | Every object with static/thread storage duration is zeroed before anything else |
| Constant initialization | Performed at compile time where possible; `constinit` (C++20) *requires* it and errors otherwise |
| Dynamic initialization | Runs in declaration order **within one TU**; order **across TUs is unspecified** — the static initialization order fiasco |
| Function-local `static` | Initialized on first control-flow pass, thread-safely (C++11 "magic statics"); the Meyers-singleton fix for cross-TU ordering |
| Destruction | Reverse order of completed construction; `std::exit` runs them, `std::quick_exit`/`_exit` do not |

**Traps** — `T x();` declares a function · `auto x{1}` is `int` but `auto x = {1}` is `initializer_list<int>` · braces silently pick `initializer_list` over a "better" ctor · `T x;` on a trivial member leaves garbage that sanitizers, not the compiler, will find · mem-init-list order is a lie; declaration order rules · designated initializers cannot skip backwards or mix with positional initializers · parenthesized aggregate init (C++20) reintroduces narrowing and drops lifetime extension.

---

<a id="appendix-c"></a>
## Appendix C — Implicit conversion ranking

### C.1 Top-level ordering of implicit conversion sequences

| Tier | Sequence kind | Beats |
|---|---|---|
| 1 (best) | **Standard conversion sequence** | everything below |
| 2 | **User-defined conversion sequence** — one converting constructor or one conversion function, wrapped by a standard sequence on each side | ellipsis |
| 3 | **List-initialization sequence** to an aggregate or `initializer_list` | ranked by its own rules (C.5) |
| 4 (worst) | **Ellipsis conversion sequence** (`...`) | nothing |

A standard conversion sequence has at most four parts, applied in this order:

```text
[1] lvalue transformation   [2] promotion OR conversion   [3] qualification adjustment
    lvalue-to-rvalue            integral/floating/etc.        add cv to pointees
    array-to-pointer
    function-to-pointer
```

Its **rank is the worst rank among parts [1]–[2]**; lvalue transformations and qualification adjustment are Exact Match rank and never worsen the sequence.

### C.2 Standard conversions by rank

| Rank | Conversion | Example | Notes |
|---|---|---|---|
| **Exact Match** | Identity | `int` → `int` | best possible |
| Exact Match | Lvalue-to-rvalue | `int lv` → `int` value | reads the object; UB if uninitialized |
| Exact Match | Array-to-pointer (decay) | `int[5]` → `int*` | extent is lost |
| Exact Match | Function-to-pointer | `void()` → `void(*)()` | |
| Exact Match | Qualification conversion | `int*` → `const int*` | multi-level rules; `int**` → `const int**` is **not** allowed, `int**` → `const int* const*` is |
| Exact Match | Function-pointer conversion (C++17) | `void(*)() noexcept` → `void(*)()` | one-way only |
| **Promotion** | Integral promotion | `bool`/`char`/`signed char`/`unsigned char`/`short`/`unsigned short`/`char8_t`/`char16_t`/`char32_t`/`wchar_t`/unscoped enum/bit-field → `int` (or `unsigned int` if `int` cannot hold all values) | value-preserving |
| Promotion | Floating-point promotion | `float` → `double` | value-preserving |
| **Conversion** | Integral conversion | `int` → `long`, `int` → `short`, `unsigned` ↔ signed | modular for unsigned; implementation-defined-then-well-defined (C++20: two's complement, wraps) for signed narrowing |
| Conversion | Floating-point conversion | `double` → `float` | precision loss; UB if out of range |
| Conversion | Floating–integral conversion | `double` → `int` (truncates toward zero), `int` → `double` | UB if the truncated value is not representable |
| Conversion | Pointer conversion | `nullptr`/`0`-literal → `T*`, `Derived*` → `Base*`, `T*` → `void*` | derived-to-base requires accessible, unambiguous, non-virtual-ambiguous base |
| Conversion | Pointer-to-member conversion | `nullptr` → `T C::*`, `T Base::*` → `T Derived::*` | direction is **reversed** from object pointers |
| Conversion | Boolean conversion | any arithmetic / unscoped enum / pointer / pointer-to-member → `bool` | non-zero ⇒ `true` |
| Conversion | Derived-to-base *value* conversion | only as the second sequence of a user-defined conversion | slices |

### C.3 Tiebreakers between two same-tier sequences

Applied in order; the first that discriminates wins.

| # | Rule |
|---|---|
| 1 | **Subsequence rule** — if S1 is a proper subsequence of S2 (excluding the identity), S1 is better. Fewer conversions win. |
| 2 | **Rank** — Exact Match < Promotion < Conversion. Lower rank wins. |
| 3 | `B*` → `void*` is worse than `B*` → `A*` when `A` is a base of `B`. |
| 4 | `C*` → `B*` is better than `C*` → `A*` when `A` is a base of `B` and `B` a base of `C`. Nearer base wins. Same for `A::*` → `C::*` vs `B::*` → `C::*` (reversed for pointers-to-member). |
| 5 | Conversion of `C` to `B` (as a class value) is better than `C` to `A` for the same chain. |
| 6 | **Reference binding**: if both bind the same argument, an **rvalue reference bound to an rvalue** beats an lvalue reference bound to that rvalue. `T&&` beats `const T&` for rvalue arguments. |
| 7 | Less cv-qualified target wins when the sequences differ only in top-level cv of the referenced/pointed-to type: `T&` beats `const T&` for a non-const lvalue argument; `int*` beats `const int*`. |
| 8 | For user-defined sequences: comparable **only if they use the same conversion function or constructor**; then the **second standard conversion sequence** decides. Otherwise ambiguous. |
| 9 | A conversion function of a more-derived class is better than one of a less-derived class. |
| 10 | List-init rules of C.5. |

### C.4 Ordering of the candidate machinery (where conversions sit)

| Stage | Winner |
|---|---|
| Non-template function vs template specialization with equal conversion sequences | **non-template wins** |
| Two template specializations, equal sequences | more **specialized** wins (partial ordering); then more-constrained (C++20 concepts) |
| Two candidates with equal sequences, one more constrained (C++20) | more constrained wins |
| One candidate needs a user-defined conversion, other only standard | standard wins, regardless of how "ugly" |
| One candidate is variadic (`...`) | loses to everything else viable |
| A member function's implicit object parameter | ranked like a reference binding; ref-qualifiers (`&`, `&&`, `const&`) participate |
| Deleted function selected | selection succeeds, then the program is ill-formed — `= delete` does not remove a candidate |
| `explicit` ctor/conversion in copy-initialization | not a candidate at all |

### C.5 List-initialization sequence ranking

| Rule |
|---|
| An `initializer_list<X>` parameter beats any non-list parameter when the elements convert to `X` — see B.3 rule 3. |
| Sequence to `std::initializer_list<X>` is ranked as the **worst** conversion among the element-to-`X` conversions. |
| If the list has one element and the parameter is not a class/`initializer_list`, the ranking is that of the single element's conversion. |
| Conversion to `std::array<char, N>`/char array from a string literal beats conversion to `std::array` of another type. |
| An empty list to a class with a default ctor is Exact Match ("identity"). |
| Narrowing anywhere in a list-initialization sequence makes it **ill-formed**, not merely worse. |
| List-init to an aggregate ranks by the element-wise conversions. |

### C.6 Special conversion contexts

| Context | Rule |
|---|---|
| Contextual conversion to `bool` (`if`, `while`, `!`, `&&`, `\|\|`, `?:`, `static_assert`, `noexcept`) | `explicit operator bool()` **is** considered — this is why `explicit operator bool` still works in `if (p)` |
| `switch` condition | contextual conversion to an integral/enum type; `explicit` conversion functions considered, must be unique |
| `delete e` | contextual conversion to pointer-to-object |
| Array bound, bit-field width, `alignas` | contextual conversion to `std::size_t` / integral constant expression |
| Return statement | copy-initialization from the operand; implicit move from a local (C++11/17/20/23 rules) applies first |
| Ellipsis argument | arrays/functions decay, `float` → `double`, integral promotions apply; passing a non-trivially-copyable class type is **conditionally supported / UB in practice** |
| Rewritten and reversed candidates for `==`/`<=>` (C++20) | the reversed form `b == a` is a candidate alongside `a == b`; when both are viable with equal conversion sequences the call is **ambiguous** — a common break when adding a member `operator==` next to a free one |
| `std::same_as` etc. in a `requires` clause | constraint satisfaction is not conversion ranking; it gates viability, then C.4 applies |

**Traps** — a user-defined conversion never chains with another user-defined conversion (at most one) · `long` → `int` and `long` → `float` are both Conversion rank ⇒ ambiguous · `0` is a null-pointer constant, `NULL` may be `long` ⇒ prefer `nullptr` · promotion of `unsigned short` goes to `int` on typical 32-bit-`int` platforms, so `us * us` is signed arithmetic · binding a `const T&` parameter to a converted temporary silently costs a construction.

---

<a id="appendix-d"></a>
## Appendix D — Special member generation matrix

The six special members: **default ctor, destructor, copy ctor, copy assign, move ctor, move assign**. What matters is what you **declare**, not what you define.

### D.1 The matrix — declare one thing, get these

| You declare | Default ctor | Destructor | Copy ctor | Copy assign | Move ctor | Move assign |
|---|---|---|---|---|---|---|
| *nothing* | defaulted | defaulted | defaulted | defaulted | defaulted | defaulted |
| any constructor (non-default, e.g. `T(int)`) | **not declared** | defaulted | defaulted | defaulted | defaulted | defaulted |
| default ctor | user | defaulted | defaulted | defaulted | defaulted | defaulted |
| **destructor** | defaulted | user | defaulted *(deprecated)* | defaulted *(deprecated)* | **not declared** | **not declared** |
| copy ctor | **not declared** | defaulted | user | defaulted *(deprecated)* | **not declared** | **not declared** |
| copy assign | defaulted | defaulted | defaulted *(deprecated)* | user | **not declared** | **not declared** |
| **move ctor** | **not declared** | defaulted | **deleted** | **deleted** | user | **not declared** |
| **move assign** | defaulted | defaulted | **deleted** | **deleted** | **not declared** | user |

Reading rules:
- *defaulted* = implicitly declared and implicitly defined if odr-used (may still end up defined-as-deleted, see D.3).
- *not declared* = the member does not exist; a call may still resolve to a **different** member (a `const T&` copy ctor accepts an rvalue, so "move" silently copies).
- *deleted* = declared and defined as deleted; using it is ill-formed.
- *deprecated* = still generated, but the implicit copy generation in the presence of a user-declared destructor or the other copy operation is deprecated; treat as "will break".

### D.2 Consequences worth reciting

| Statement | True? |
|---|---|
| Declaring a destructor kills both move operations | yes — the single most common accidental pessimization |
| Declaring either move operation deletes **both** copy operations | yes |
| Declaring either copy operation suppresses **both** move operations | yes (not declared, not deleted) |
| `= default` counts as user-**declared** for suppression purposes | yes — `~T() = default;` still kills the moves |
| A class with no move ctor is still `std::is_move_constructible_v` | often yes — the copy ctor binds the rvalue |
| `std::move(x)` on such a type moves | **no** — it copies, silently |
| Rule of Zero | declare none of the six; let members (`vector`, `unique_ptr`, …) do the work |
| Rule of Five | if you declare any of dtor/copy-ctor/copy-assign/move-ctor/move-assign, declare (or `= default`/`= delete`) all five |
| Rule of Three | pre-C++11 form: dtor, copy ctor, copy assign travel together |
| `= default` on the **first declaration** keeps the member non-user-provided (triviality, aggregate-ness, value-init behavior preserved) | yes |
| `= default` **out of line / after** the first declaration makes it user-provided | yes — silently destroys triviality and `is_trivially_copyable` |
| Declaring any ctor removes the implicit default ctor and makes the class a non-aggregate | yes |

### D.3 When an implicitly declared member is defined as **deleted**

| Member | Deleted if the class has… |
|---|---|
| default ctor | a const or reference non-static member without a default member initializer; a member/base with no accessible default ctor or with a deleted/ambiguous one; a variant member with a non-trivial default ctor; an ambiguous or inaccessible destructor |
| destructor | a member/base whose destructor is deleted or inaccessible |
| copy ctor | a member/base whose copy ctor is deleted/inaccessible; an rvalue-reference member; a user-declared move operation |
| copy assign | a const non-static member, a reference member, or a member/base whose copy assign is deleted/inaccessible; a user-declared move operation |
| move ctor | a member/base that cannot be moved **or copied**; a deleted/inaccessible destructor |
| move assign | a const or reference member; a member/base that is neither move- nor copy-assignable |
| all of them | a virtual base with an inaccessible/ambiguous corresponding operation |

### D.4 Triviality, `noexcept`, and `constexpr` of defaulted members

| Property | Rule |
|---|---|
| Trivial | the member is not user-provided, the class has no virtual functions and no virtual bases, and every corresponding base/member operation is trivial |
| Trivially copyable class | every copy/move ctor, copy/move assign is trivial or deleted, at least one is not deleted, and the destructor is trivial and non-deleted ⇒ `memcpy`-able, `bit_cast`-able |
| Implicit `noexcept` | a defaulted special member is `noexcept` iff every operation it invokes is `noexcept`; the destructor is `noexcept` by default unless a member's is not |
| `constexpr` | a defaulted special member is implicitly `constexpr` if it satisfies the constexpr-function requirements; since C++20 non-trivial ones can be too |
| Explicitly defaulted with a mismatched exception spec | allowed since C++20 — the member becomes deleted only if the stated spec is incompatible in the pre-C++20 sense; prefer stating `noexcept` and letting the compiler verify |
| `noexcept` move matters | `std::vector` reallocation uses `move_if_noexcept`: a throwing move forces **copies**; declare `noexcept` on move ctor/assign |

### D.5 Related declarations and their effect

| Declaration | Effect |
|---|---|
| `T(T&) ` (non-const copy ctor) | is a copy ctor; blocks copying from `const` |
| `template<class U> T(U&&)` | is **never** a copy/move ctor; the implicit ones are still generated and usually win for `T` arguments |
| `T(std::initializer_list<E>)` | not a special member, but hijacks all brace initialization |
| `~T() noexcept(false)` | legal; makes containers and stack unwinding fragile — a throwing dtor during unwinding calls `std::terminate` |
| virtual destructor | required whenever you `delete` through a base pointer; declaring it kills the implicit moves (declare all five) |
| `protected` non-virtual destructor | the alternative to a virtual dtor for non-polymorphically-owned bases |
| `= delete` on a special member | keeps it as a **candidate**; selection then makes the program ill-formed (better diagnostics than making it private) |
| explicit object parameter (C++23, `this Self&&`) | may be used for assignment operators; **constructors and destructors cannot** have an explicit object parameter, so it never declares a copy/move *constructor* |
| inheriting constructors (`using Base::Base;`) | does not inherit default/copy/move ctors; those still follow this table |
| `[[no_unique_address]]` member | does not change any generation rule; may change layout and `sizeof` |

```cpp
// The canonical Rule-of-Five skeleton
class Buffer {
    std::byte* data_{};
    std::size_t size_{};
public:
    Buffer() = default;
    ~Buffer();
    Buffer(Buffer const&);                        // deep copy
    Buffer& operator=(Buffer const&);             // copy-and-swap or guarded
    Buffer(Buffer&&) noexcept;                    // steal + null the source
    Buffer& operator=(Buffer&&) noexcept;         // self-move safe
};

// Move-only resource: delete copies, default moves
struct Handle {
    Handle(Handle const&)            = delete;
    Handle& operator=(Handle const&) = delete;
    Handle(Handle&&) noexcept        = default;
    Handle& operator=(Handle&&) noexcept = default;
    ~Handle();
};
```

---

<a id="appendix-e"></a>
## Appendix E — Value categories and reference collapsing

### E.1 The taxonomy

```text
expression
├── glvalue  — has identity
│   ├── lvalue   identity, not expiring
│   └── xvalue   identity, resources reusable
└── prvalue  — no identity; initializes a result object

rvalue  = prvalue ∪ xvalue          (can bind to T&&)
glvalue = lvalue  ∪ xvalue          (has an address / identity)
```

| Property | lvalue | xvalue | prvalue |
|---|---|---|---|
| Has identity | yes | yes | no |
| Can be moved from | no | yes | yes |
| Binds to `T&` | yes | no | no |
| Binds to `const T&` | yes | yes | yes |
| Binds to `T&&` | no | yes | yes |
| Can take its address | yes | yes (of the materialized object) | no |
| Can be the LHS of built-in `=` | if non-const | no | no |
| `decltype((e))` yields | `T&` | `T&&` | `T` |
| Polymorphic (dynamic type may differ) | yes | yes | no — a prvalue's type is its dynamic type |

### E.2 Value category by expression kind

| Expression | Category |
|---|---|
| name of a variable, function, data member, or template parameter object | **lvalue** |
| a variable declared `T&& r` — the *name* `r` | **lvalue** (a named rvalue reference is an lvalue) |
| string literal `"abc"` | **lvalue** of type `const char[4]` |
| any other literal (`42`, `1.0`, `'c'`, `true`, `nullptr`) | **prvalue** |
| `*p` (object pointer) | lvalue |
| `p[i]`, `a[i]` on arrays/pointers | lvalue |
| `a[i]` where `a` is an array **prvalue** | xvalue |
| `a.m` where `a` is an lvalue and `m` a non-static data member | lvalue |
| `a.m` where `a` is a prvalue/xvalue and `m` a non-static data member | **xvalue** |
| `a.m` where `m` is a static member or an enumerator | lvalue |
| `p->m` | lvalue |
| `a.*pm` / `p->*pm` (data member) | lvalue (xvalue if `a` is an rvalue) |
| function call returning `T&` | lvalue |
| function call returning `T&&` | **xvalue** |
| function call returning `T` (by value) | **prvalue** |
| `std::move(x)`, `static_cast<T&&>(x)` | xvalue |
| `std::forward<T>(x)` with `T` an lvalue ref | lvalue |
| `std::forward<T>(x)` with `T` a non-reference | xvalue |
| `T{}`, `T(a, b)`, functional/`static_cast<T>(x)` to non-reference | prvalue |
| `new T` | prvalue (of pointer type) |
| `this` | prvalue |
| lambda expression | prvalue |
| `a = b`, `a += b` (built-in) | lvalue (refers to the left operand) |
| `++a`, `--a` (built-in prefix) | lvalue |
| `a++`, `a--` (built-in postfix) | prvalue |
| `a + b`, `a & b`, `a < b`, `!a`, `a && b` (built-in) | prvalue |
| `&a` | prvalue |
| `a , b` | category of `b` |
| `c ? a : b` | lvalue if both are lvalues of the same type; xvalue if both are xvalues; otherwise prvalue |
| `throw e` | prvalue of type `void` |
| cast to `T&` | lvalue |
| cast to `T&&` | xvalue |
| `typeid(e)` | lvalue (`const std::type_info&`) |
| `co_await e` / `co_yield e` | depends on the awaiter's `await_resume` return type |
| a bit-field access | glvalue, but its address cannot be taken and it cannot bind to a non-const reference |
| an overloaded operator call | category of the operator function's return type, per the rows above |

### E.3 Materialization, elision, and lifetime

| Rule | Effect |
|---|---|
| Temporary materialization conversion (C++17) | a prvalue converts to an xvalue whenever a glvalue is required: binding a reference, member access, array subscript, base conversion, `typeid`/`sizeof` on a class prvalue |
| Guaranteed copy elision (C++17) | `T x = T(T(T()));` performs exactly one initialization — a prvalue *is* the initializer; no copy/move ctor need exist |
| NRVO | still **optional**; a named local returned by value may or may not be elided |
| Implicit move on `return` | a returned local/parameter is first treated as an rvalue (C++11); widened by C++20 (P1825) to more cases including conversions to base and `throw` operands |
| `return std::move(local)` | **pessimizes** — blocks NRVO; do not write it |
| `return std::move(member)` from an rvalue-qualified member | correct and necessary |
| Lifetime of temporaries | destroyed at the end of the full-expression, in reverse construction order, unless bound to a reference (see B.5) |
| `std::forward_like<T>(x)` (C++23) | applies `T`'s value category **and** const-ness to `x` — the right tool for member access in a deducing-`this` member |

### E.4 Reference collapsing

Collapsing applies only when a reference-to-reference arises through a template parameter, `auto`, `decltype`, or a typedef/alias — never in source syntax.

| Written | Collapses to | Mnemonic |
|---|---|---|
| `T&` `&` | `T&` | |
| `T&` `&&` | `T&` | **lvalue wins** |
| `T&&` `&` | `T&` | |
| `T&&` `&&` | `T&&` | only rvalue+rvalue stays rvalue |

Cv-qualifiers: `const` applied to a reference type is dropped (`const (T&)` is `T&`); the referenced type keeps its own cv.

### E.5 Forwarding-reference deduction

`template<class T> void f(T&& x);` — a **forwarding reference** only when `T` is a template parameter of *this* function template being deduced.

| Argument | `T` deduced as | Parameter type after collapsing | `x` inside `f` is |
|---|---|---|---|
| `U` lvalue | `U&` | `U&` | lvalue |
| `const U` lvalue | `const U&` | `const U&` | lvalue |
| `U` prvalue / xvalue | `U` | `U&&` | **lvalue** (named) of type `U&&` |
| `const U` rvalue | `const U` | `const U&&` | lvalue |
| array `U[N]` lvalue | `U(&)[N]` | `U(&)[N]` | no decay |
| function lvalue | `R(&)(Args…)` | `R(&)(Args…)` | no decay |
| bit-field lvalue | ill-formed to bind non-const | — | — |

```cpp
template<class T> void f(T&& x) {
    g(std::forward<T>(x));   // T&  -> forward yields lvalue
}                            // T   -> forward yields xvalue
// std::forward<T>(x) == static_cast<T&&>(x), relying on collapsing.
```

**What is *not* a forwarding reference**

| Form | Why |
|---|---|
| `void f(Widget&& x)` | concrete type, plain rvalue reference |
| `template<class T> void f(const T&& x)` | `const` disqualifies it |
| `template<class T> void f(std::vector<T>&& v)` | `T` is not deduced *as* the reference; `v` is an rvalue ref |
| `template<class T> struct S { void f(T&& x); };` | `T` is fixed by the class, not deduced by `f` |
| `template<class T> void f(T&&… args)` | *is* a forwarding reference pack — this one **does** forward |
| `auto&& x = e;` | **is** a forwarding reference (same deduction rules) |
| `auto&& [a, b] = e;` | structured binding to a forwarding reference; the names `a`,`b` are not references themselves |
| `template<class Self> auto g(this Self&& self)` (C++23) | **is** a forwarding reference; `Self` deduces the object's category and cv |

### E.6 `auto`, `decltype`, and `decltype(auto)`

| Declaration | Given `int i; const int ci = 0; int& r = i; int&& rr = 0;` | Result |
|---|---|---|
| `auto a = i;` | value, decays, drops top-level cv and refs | `int` |
| `auto a = ci;` | | `int` |
| `auto a = r;` | | `int` |
| `const auto& a = i;` | | `const int&` |
| `auto&& a = i;` | lvalue ⇒ collapse | `int&` |
| `auto&& a = 0;` | prvalue | `int&&`, temporary extended |
| `auto* p = &ci;` | | `const int*` |
| `decltype(i)` | name ⇒ declared type | `int` |
| `decltype((i))` | parenthesized lvalue | `int&` |
| `decltype(ci)` | | `const int` |
| `decltype(r)` | name of a reference | `int&` |
| `decltype(rr)` | name of an rvalue reference | `int&&` |
| `decltype(std::move(i))` | xvalue | `int&&` |
| `decltype(i + 1)` | prvalue | `int` |
| `decltype(auto) f() { return i; }` | uses `decltype` rules on the operand | `int` |
| `decltype(auto) f() { return (i); }` | | `int&` — **dangles** if `i` is local |
| `auto f() { return i; }` | `auto` return decays | `int` |
| `auto& f()` returning a local | | dangling reference |

**Traps** — `std::move` moves nothing; it is a cast to xvalue · a named `T&&` parameter is an lvalue, so forward it, do not just pass it · forwarding twice from the same variable is a use-after-move · `const` kills moves (a `const T&&` argument selects the copy ctor) · `decltype((x))` vs `decltype(x)` differ by one pair of parentheses and one reference · returning `auto&&` from a function does not extend anything.

---

<a id="appendix-f"></a>
## Appendix F — Cast selection matrix

### F.1 Capability matrix

| Operation | `static_cast` | `dynamic_cast` | `const_cast` | `reinterpret_cast` | `std::bit_cast` | C-style `(T)x` | functional `T(x)` |
|---|---|---|---|---|---|---|---|
| Numeric conversion (`int`↔`double`, widening/narrowing) | ✔ | ✘ | ✘ | ✘ | ✘ (only same-size bit reinterpretation) | ✔ | ✔ |
| Enum ↔ integer, scoped enum → integer | ✔ | ✘ | ✘ | ✘ | ✔ (same size, trivially copyable) | ✔ | ✔ |
| Any implicit conversion, made explicit | ✔ | ✘ | ✘ | ✘ | ✘ | ✔ | ✔ |
| Inverse of a standard conversion (`void*` → `T*`) | ✔ | ✘ | ✘ | ✔ | ✘ | ✔ | ✔ |
| Upcast `Derived*`/`Derived&` → `Base` | ✔ (implicit anyway) | ✔ | ✘ | ✘ (adjusts no offset — wrong) | ✘ | ✔ | ✔ |
| Downcast `Base*` → `Derived*`, **unchecked** | ✔ (UB if wrong) | ✘ | ✘ | ✘ | ✘ | ✔ | ✔ |
| Downcast, **runtime-checked** | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| Cross-cast between sibling bases | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| Downcast **from a virtual base** | ✘ (ill-formed) | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| `dynamic_cast<void*>` → most-derived object address | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| Add/remove `const`/`volatile` | ✔ (add only) | ✘ | ✔ | ✘ | ✘ | ✔ | ✔ |
| Pointer ↔ integer (`std::uintptr_t`) | ✘ | ✘ | ✘ | ✔ | ✘ | ✔ | ✘ |
| Unrelated `T*` → `U*` | ✘ | ✘ | ✘ | ✔ | ✘ | ✔ | ✘ |
| `T*` ↔ `std::byte*`/`char*`/`unsigned char*` | ✘ | ✘ | ✘ | ✔ | ✘ | ✔ | ✘ |
| Function pointer ↔ function pointer | ✘ | ✘ | ✘ | ✔ (call through wrong type is UB) | ✘ | ✔ | ✘ |
| Function pointer ↔ object pointer | ✘ | ✘ | ✘ | conditionally supported | ✘ | conditionally supported | ✘ |
| Pointer-to-member reinterpretation | ✘ | ✘ | ✘ | ✔ | ✘ | ✔ | ✘ |
| lvalue → `T&&` (make an xvalue) | ✔ (`static_cast<T&&>`) | ✘ | ✘ | ✘ | ✘ | ✔ | ✘ |
| Value reinterpretation of the **object representation** | ✘ | ✘ | ✘ | ✘ (UB via lvalue) | ✔ | ✘ | ✘ |
| Usable in a constant expression | ✔ | ✘ | ✔ (no UB) | ✘ | ✔ (no padding/pointers/unions) | partly | partly |
| Runtime cost | zero, or a fixed pointer offset | RTTI lookup, unbounded walk of the hierarchy | zero | zero | zero (typically a register move) | zero unless it resolves to `dynamic_cast`-like work (it never does) | as `static_cast` |
| Greppable intent | ✔ | ✔ | ✔ | ✔ | ✔ | **✘** | **✘** |

### F.2 What C-style `(T)x` actually does — tried in this order

1. `const_cast<T>(x)`
2. `static_cast<T>(x)` (including access-ignoring base/derived conversions a `static_cast` would reject)
3. `static_cast` followed by `const_cast`
4. `reinterpret_cast<T>(x)`
5. `reinterpret_cast` followed by `const_cast`

It never performs a `dynamic_cast`. The danger is step 4: an innocuous-looking `(Foo*)p` silently becomes a `reinterpret_cast` when the types turn out to be unrelated (or when a header changes). Functional `T(x)` is the same set but only for single-word type names, and `T(a, b)` is a construction, not a cast.

### F.3 UB and failure modes per cast

| Cast | Fails how | UB when |
|---|---|---|
| `static_cast<Derived*>(base_ptr)` | compiles unconditionally | the pointee's dynamic type is not `Derived` (or derived from it) |
| `static_cast<Derived&>(base_ref)` | compiles unconditionally | same |
| `static_cast<T>(double)` where the value is out of `T`'s range | none at compile time | UB (integral) / unspecified-then-UB (float→float out of range) |
| `static_cast<E>(n)` for scoped/unscoped enum | none | UB if `n` is outside the enum's *range of representable values* (fixed underlying type ⇒ safe) |
| `static_cast<T&&>(x)` | — | not UB; but *using* the moved-from object beyond its valid-but-unspecified state may violate the type's contract |
| `dynamic_cast<T*>` | returns `nullptr` on failure | UB if the source is not polymorphic (won't compile), or during construction/destruction of the base before the derived vtable is set |
| `dynamic_cast<T&>` | throws `std::bad_cast` | same |
| `const_cast` | never fails to compile | **writing** through the result when the underlying object was declared `const` (or is in read-only storage) |
| `const_cast<volatile>` removal | — | removing `volatile` and then accessing an object that really is volatile |
| `reinterpret_cast<U*>(t_ptr)` then `*` | never | **strict-aliasing violation** unless `U` is `char`/`unsigned char`/`std::byte`, a similar type, or a signed/unsigned variant; also UB if alignment is insufficient; also UB because **no object of type `U` was created there** |
| `reinterpret_cast` between function pointer types | never | calling through a pointer whose type does not match the function's type |
| `reinterpret_cast<std::uintptr_t>` round-trip | never | round-tripping back to the *same* pointer is fine; arithmetic on the integer and converting back is implementation-defined at best |
| `std::bit_cast<To>(from)` | **compile error** if `sizeof(To) != sizeof(From)` or either type is not trivially copyable | not UB by construction; but the result is unspecified if the source has padding/indeterminate bits, and it is ill-formed in a constant expression if it involves pointers, member pointers, unions, or padding |
| C-style cast | never | inherits whichever of the above it resolved to, invisibly |

### F.4 Choosing the right tool

| Goal | Use |
|---|---|
| Explicit numeric/enum conversion | `static_cast` (or `std::to_underlying` (C++23) for enum → underlying) |
| Checked narrowing at runtime | write a guarded helper; C++ has no built-in checked cast |
| Downcast where the type is *known* by an invariant | `static_cast` + `assert(dynamic_cast<T*>(p) != nullptr)` in debug builds |
| Downcast where the type is *unknown* | `dynamic_cast`, or replace the design with `std::variant`/`std::visit`, a virtual function, or a type tag |
| Bridge a C API's `void* user_data` | `static_cast<T*>(v)` — the inverse of the implicit `T*` → `void*` |
| Strip `const` to call a legacy C API that does not modify | `const_cast`, with a comment stating the callee does not write |
| Cache a computed value inside a logically-const member function | `mutable` member, **not** `const_cast` |
| Reinterpret a `float` as its bit pattern | `std::bit_cast<std::uint32_t>(f)` (C++20) |
| Read a POD out of a wire buffer | `std::memcpy` into a local `T`, or `std::bit_cast` on a same-size byte array — **not** `*reinterpret_cast<T*>(buf)` |
| Write a POD into a wire buffer | `std::memcpy` from the object; `std::byte`/`char` pointers may legally alias it |
| Iterate an object's bytes | `reinterpret_cast<const std::byte*>(&obj)` — legal, `std::byte`/`char`/`unsigned char` may alias anything |
| Placement-new into a buffer, then use it | `new (buf) T{…}` and use the **returned** pointer; `std::launder` if you must reuse an old pointer to the storage |
| Pointer ↔ integer for hashing/tagging | `reinterpret_cast<std::uintptr_t>`; round-trip only through the identical integer value |
| Recover a `shared_ptr`/`unique_ptr` of a derived type | `std::static_pointer_cast` / `std::dynamic_pointer_cast` / `std::const_pointer_cast` / `std::reinterpret_pointer_cast` |
| Convert between `std::span` element types | `std::as_bytes` / `std::as_writable_bytes` |

```cpp
// Legal punning
float f = 1.0f;
auto bits = std::bit_cast<std::uint32_t>(f);          // C++20, constexpr-friendly
std::uint32_t b2; std::memcpy(&b2, &f, sizeof b2);    // always legal

// Illegal punning — strict aliasing, and no uint32_t object exists at &f
// auto bad = *reinterpret_cast<std::uint32_t*>(&f);  // UB

// Wire decode: no object of type Header lives in the buffer
Header h;
std::memcpy(&h, buf.data(), sizeof h);                // correct
// Header const& bad = *reinterpret_cast<Header const*>(buf.data());  // UB
```

**Traps** — `dynamic_cast` in a hot path is a hash/string comparison walk, not a vtable index · `reinterpret_cast` never adjusts a pointer for multiple inheritance, so casting `Derived*` → `Base2*` with it yields a wrong address · `const_cast` on a `const` *reference parameter* is fine only if the referent was never `const` · a C-style cast in a template silently becomes a `reinterpret_cast` for some instantiations · `bit_cast` does not handle endianness, padding, or trap representations · `const_cast` itself is never UB — only *writing* through the result to an object that was actually declared `const` is.

---

<a id="appendix-g"></a>
## Appendix G — Container complexity and invalidation matrix

### G.1 Master complexity table

`—` = the operation does not exist on that container. `n` = element count of the container operated on, `m` = number of elements inserted/merged, `k` = number of elements matching a key. Amortized ("am.") means over a sequence of operations, not per call. "avg" = average case under a good hash; the worst case is stated where it differs.

| Operation | `array<T,N>` | `vector` | `deque` | `list` | `forward_list` | `string` | `set`/`map` | `multiset`/`multimap` | `unordered_*` | `flat_set`/`flat_map` (C++23) |
|---|---|---|---|---|---|---|---|---|---|---|
| default ctor | O(N) | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) or O(buckets) | O(1) |
| range ctor (m elems) | — | O(m) | O(m) | O(m) | O(m) | O(m) | O(m log m); O(m) if sorted | O(m log m); O(m) if sorted | avg O(m) | O(m log m) (sort + unique) |
| copy ctor / assign | O(N) | O(n) | O(n) | O(n) | O(n) | O(n) | O(n) | O(n) | O(n) | O(n) |
| move ctor | O(N) | O(1) | O(1) | O(1) | O(1) | O(1) (O(n) if SSO-active) | O(1) | O(1) | O(1) | O(1) |
| move assign | O(N) | O(1)\* | O(1)\* | O(1)\* | O(1)\* | O(1)\* | O(1)\* | O(1)\* | O(1)\* | O(1)\* |
| `size()` | O(1) | O(1) | O(1) | O(1) (since C++11) | — | O(1) | O(1) | O(1) | O(1) | O(1) |
| `empty()` | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) |
| `operator[](i)` / `at(i)` | O(1) | O(1) | O(1) | — | — | O(1) | — | — | — | — |
| `operator[](key)` | — | — | — | — | — | — | `map`: O(log n) | — | `unordered_map`: avg O(1), worst O(n) | `flat_map`: O(log n) hit, O(n) insert |
| `at(key)` | — | — | — | — | — | — | O(log n) | — | avg O(1), worst O(n) | O(log n) |
| `front()` | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) | `*begin()` O(1) | O(1) | `*begin()` O(1) | O(1) |
| `back()` | O(1) | O(1) | O(1) | O(1) | — | O(1) | O(1) via `rbegin()` | O(1) | — (forward only) | O(1) |
| `data()` | O(1) | O(1) | — | — | — | O(1) | — | — | — | `keys()`/`values()` O(1) |
| `push_back` / `emplace_back` | — | am. O(1) | am. O(1) | O(1) | — | am. O(1) | — | — | — | — |
| `push_front` / `emplace_front` | — | — | am. O(1) | O(1) | O(1) | — | — | — | — | — |
| `pop_back` | — | O(1) | O(1) | O(1) | — | O(1) | — | — | — | — |
| `pop_front` | — | — | O(1) | O(1) | O(1) | — | — | — | — | — |
| `insert(pos, v)` (positional) | — | O(n − pos) | O(min(pos, n − pos)) | O(1) | `insert_after` O(1) | O(n − pos) | — | — | — | — |
| `insert(v)` (keyed) | — | — | — | — | — | — | O(log n) | O(log n) | avg O(1), worst O(n) | O(n) |
| `insert(hint, v)` | — | — | — | — | — | — | am. O(1) if hint correct, else O(log n) | am. O(1) if correct | avg O(1) | O(n) |
| `insert(first, last)` (m elems) | — | O(m + n − pos) | O(m + min(pos, n−pos)) | O(m) | O(m) | O(m + n − pos) | O(m log(n+m)); O(m) if sorted + hinted | same | avg O(m), worst O(m·n) | O(n + m log m) |
| `insert_range` (C++23) | — | as above | as above | O(m) | O(m) | as above | as above | as above | as above | as above |
| `erase(iterator)` | — | O(n − pos) | O(min(pos, n−pos)) | O(1) | `erase_after` O(1) | O(n − pos) | am. O(1) | am. O(1) | avg O(1), worst O(n) | O(n) |
| `erase(first, last)` | — | O(n − first) | O(dist + min ends) | O(dist) | O(dist) | O(n − first) | O(log n + dist) | O(log n + dist) | avg O(dist), worst O(n) | O(n) |
| `erase(key)` | — | — | — | — | — | — | O(log n + k) | O(log n + k) | avg O(k), worst O(n) | O(n) |
| `find(key)` | — | — | — | — | — | — | O(log n) | O(log n) (first match) | avg O(1), worst O(n) | O(log n) |
| `contains(key)` (C++20) | — | — | — | — | — | — | O(log n) | O(log n) | avg O(1), worst O(n) | O(log n) |
| `count(key)` | — | — | — | — | — | — | O(log n) | O(log n + k) | avg O(k), worst O(n) | O(log n + k) |
| `lower_bound` / `upper_bound` | — | — | — | — | — | — | O(log n) | O(log n) | — | O(log n) |
| `equal_range(key)` | — | — | — | — | — | — | O(log n) | O(log n + k) | avg O(k), worst O(n) | O(log n) |
| `clear()` | — | O(n) | O(n) | O(n) | O(n) | O(n) (or O(1) for trivial `char`) | O(n) | O(n) | O(n + buckets) | O(n) |
| `swap(other)` | O(N) | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) | O(1) |
| `resize(k)` | — | O(\|Δ\|) + realloc | O(\|Δ\|) | O(\|Δ\|) | O(\|Δ\|) | O(\|Δ\|) | — | — | — | — |
| `reserve(k)` / `capacity()` | — | O(n) when growing | — | — | — | O(n) when growing | — | — | `reserve` ⇒ rehash: avg O(n), worst O(n²) | via underlying `vector` |
| `shrink_to_fit()` | — | O(n), non-binding | O(n), non-binding | — | — | O(n), non-binding | — | — | — | non-binding |
| `rehash(k)` / `max_load_factor` | — | — | — | — | — | — | — | — | avg O(n), worst O(n²) | — |
| `bucket_count` / `bucket(k)` / `bucket_size(i)` | — | — | — | — | — | — | — | — | O(1) / O(1) / O(size of bucket) | — |
| `extract(key)` / `extract(pos)` (C++17) | — | — | — | — | — | — | O(log n) / am. O(1) | same | avg O(1) | — (no node handles) |
| `insert(node_handle)` | — | — | — | — | — | — | O(log n) | O(log n) | avg O(1) | — |
| `merge(other)` (node splice, C++17) | — | — | — | — | — | — | O(m log(n+m)) | same | avg O(m), worst O(m·n) | — |
| `merge(other)` (sorted merge) | — | — | — | O(n + m) | O(n + m) | — | — | — | — | — |
| `splice` / `splice_after` | — | — | — | O(1); O(dist) for a range from another list | O(1); O(dist) for a range | — | — | — | — | — |
| member `sort()` | — | — | — | O(n log n), stable | O(n log n), stable | — | — | — | — | — |
| member `unique()` | — | — | — | O(n) (adjacent only) | O(n) | — | — | — | — | — |
| member `remove` / `remove_if` | — | — | — | O(n) | O(n) | — | — | — | — | — |
| member `reverse()` | — | — | — | O(n) | O(n) | — | — | — | — | — |
| `std::erase` / `std::erase_if` (C++20) | — | O(n) | O(n) | O(n) | O(n) | O(n) | O(n) | O(n) | O(n) | O(n) |
| `operator==` | O(N) | O(n) | O(n) | O(n) | O(n) | O(n) | O(n) | O(n) | avg O(n), worst O(n²) | O(n) |
| `a <=> b` (C++20) | O(N) | O(n) | O(n) | O(n) | O(n) | O(n) | O(n) | O(n) | — (no `<=>`) | O(n) |
| `std::distance(first, last)` | O(1) | O(1) | O(1) | O(n) | O(n) | O(1) | O(n) | O(n) | O(n) | O(1) |

\* Move assignment is O(1) only when the allocators compare equal or `propagate_on_container_move_assignment` is true; otherwise it degrades to element-wise O(n).

### G.2 Structural properties

| Container | Iterator category | Contiguous | Ordered by key | Per-element overhead | Allocations |
|---|---|---|---|---|---|
| `array<T,N>` | contiguous | yes | — | 0 | none (extent is part of the type) |
| `vector` | contiguous | yes | — | 0 + capacity slack | am. < 1 per `push_back` (geometric growth) |
| `vector<bool>` | random access (proxy ref) | bit-packed | — | 1 bit | as `vector` |
| `deque` | random access | **no** | — | block map entry + partial block | one per block |
| `list` | bidirectional | no | — | 2 pointers | 1 per element |
| `forward_list` | forward | no | — | 1 pointer | 1 per element |
| `string` | contiguous | yes | — | SSO buffer or capacity slack | 0 while short (SSO), then as `vector` |
| `set` / `map` | bidirectional | no | yes (`Compare`) | ~3 pointers + colour bit | 1 per element |
| `multiset` / `multimap` | bidirectional | no | yes, duplicates kept in insertion order (C++11) | ~3 pointers + colour bit | 1 per element |
| `unordered_*` | forward | no | no | 1 pointer/node + bucket array; hash may be cached | 1 per element + bucket array |
| `flat_set` / `flat_map` (C++23) | random access (contiguous for `flat_set`) | yes | yes (`Compare`) | 0 (`flat_map` keeps two parallel vectors) | as the underlying containers |
| `stack` / `queue` / `priority_queue` | none (no iterators) | via adaptee | `priority_queue`: heap order | as adaptee | as adaptee |

### G.3 Adapters

| Operation | `stack` (over `deque`) | `queue` (over `deque`) | `priority_queue` (over `vector`) |
|---|---|---|---|
| `push` / `emplace` | am. O(1) | am. O(1) | O(log n) + possible realloc |
| `top()` / `front()` / `back()` | `top()` O(1) | O(1) | `top()` O(1) |
| `pop()` | O(1), returns `void` | O(1), returns `void` | O(log n), returns `void` |
| construct from range / iterator pair | O(n) | O(n) | O(n) heapify (`make_heap`) |
| `size` / `empty` / `swap` | O(1) | O(1) | O(1) / O(1) / O(1) |
| erase arbitrary element, iterate, decrease-key | — | — | — |

### G.4 Combined invalidation summary

`I` = iterators, `R` = references **and** pointers. "own" = only handles to the removed/affected elements.

| Container | Insert (no reallocation/rehash) | Insert (reallocation/rehash) | Erase | `clear` | `swap` | `resize` |
|---|---|---|---|---|---|---|
| `array` | — | — | — | — | nothing invalidated (values swap in place) | — |
| `vector`, `string` | I,R at and after the insertion point, incl. old `end()` | **all** I,R | I,R at and after the erased position, incl. old `end()` | all I,R | all I,R (they follow the buffer, so treat as invalid) | grow: none if no realloc, else all; shrink: at and after the new end |
| `deque` | ends: **all I**, **no R**; middle: all I and R | same (ends: all I, no R) | ends: own only (+ `end()`); middle: all I and R | all I,R | all I,R | ends only: all I, no R for the survivors |
| `list` | nothing | — | own only | all I,R | all I,R | own only for the removed tail |
| `forward_list` | nothing | — | own only (`erase_after`) | all I,R | all I,R | own only |
| `set` / `map` / `multiset` / `multimap` | nothing | — | own only | all I,R | all I,R (the `end()` iterator too) | — |
| `unordered_*` | nothing | rehash: **all I**, **no R** | own only | all I,R | all I,R | — |
| `flat_set` / `flat_map` (C++23) | **all** I,R | **all** I,R | **all** I,R | all I,R | all I,R | — |

### G.5 Per-container invalidation notes

**`array`** — Nothing ever invalidates. `swap` is O(N) element-wise: an iterator keeps pointing at the same *position*, whose value has changed. `data()` on `array<T,0>` need not be a usable pointer.

**`vector`**
- Reallocation invalidates every iterator, pointer, and reference — including `data()` and any `span` built from it.
- Reallocation happens when `size() + inserted > capacity()`, and on `reserve` growth and (possibly) `shrink_to_fit`.
- Non-reallocating `push_back`/`emplace_back` invalidates only the old `end()`.
- `erase` never reallocates; it invalidates from the erased position onward.
- `clear()` destroys elements, keeps capacity; all iterators/references die, `data()` value may persist but points at raw storage.
- Reallocation moves elements only if the move constructor is `noexcept` (`move_if_noexcept`); otherwise it copies.
- `vector<bool>`: `operator[]` yields a proxy, `&v[i]` is ill-formed, and writes to distinct bits in the same word are a **data race**.

**`deque`**
- The asymmetry to memorize: **end insertion keeps references/pointers valid but invalidates all iterators**; middle insertion invalidates everything.
- Erasing at either end invalidates only handles to the erased elements (and `end()` for a back-erase); erasing in the middle invalidates all iterators and references.
- No `reserve`, no `capacity`, no `data()` — the storage is a map of fixed-size blocks, so `deque` cannot be `span`-ed.

**`list` / `forward_list`**
- The only mutation that invalidates anything is erasure, and only for the erased node.
- `splice`/`splice_after` moves nodes without touching elements: iterators, pointers, and references to spliced elements **stay valid** but now denote elements of the destination list; the source's `size()` and the destination's `size()` both change.
- `list::sort`, `merge`, `reverse`, `unique` relink nodes; iterators remain valid and continue to denote the same elements, in the new order.
- `remove`/`remove_if`/`unique` invalidate only handles to the removed elements.

**`string`**
- Same rules as `vector`, plus: any non-`const` member call other than `operator[]`, `at`, `front`, `back`, `begin`, `end`, `rbegin`, `rend`, and passing the string as a non-`const` argument to a standard-library function, may invalidate iterators, pointers, and references — this covers `c_str()`/`data()` results.
- Copy-on-write is forbidden since C++11, so a copy never aliases.
- SSO means a move can be O(n) for short strings and that `data()` may point into the string object itself — moving the object moves the buffer.

**`set` / `map` / `multiset` / `multimap`**
- Insertion never invalidates anything. Erasure invalidates only the erased element's iterator/reference.
- `extract(k)` detaches the node into a `node_handle`: the element is not copied or moved, iterators to it are invalidated, but pointers/references to the element remain valid while the handle is alive. `insert(std::move(nh))` re-attaches without allocating — this is how you change a key in place (`nh.key() = ...`) or move an element between two containers with the same node type.
- `merge(src)`: no elements are copied or moved; pointers and references to transferred elements remain valid but now refer into the destination. Treat all iterators as invalidated.
- Keys in ordered containers are `const`; modifying a key through `const_cast` breaks the invariant (UB in practice).
- `multimap` preserves relative insertion order of equivalent keys (C++11).

**`unordered_set` / `unordered_map` / `unordered_multi*`**
- **References and pointers to elements are never invalidated by insertion** — only iterators are, and only if a rehash occurs.
- A rehash occurs when `size() + 1 > max_load_factor() * bucket_count()`. `reserve(n)` = `rehash(ceil(n / max_load_factor()))`; call it before bulk insertion to make insertion iterator-stable and avoid repeated rehashing.
- Erasure invalidates only the erased element's handles.
- `extract`/`insert(node)`/`merge` behave as for the ordered containers.
- Worst-case O(n) per lookup is real: adversarial or degenerate keys collapse every element into one bucket. `std::hash<integral>` is commonly the identity — strided keys can be pathological with power-of-two bucket counts.

**`flat_set` / `flat_map` / `flat_multiset` / `flat_multimap` (C++23)**
- Container *adaptors* over one (or, for `flat_map`, two parallel) sorted sequence containers, `vector` by default.
- Any insertion or erasure invalidates **all** iterators, pointers, and references — including the ones you were holding across the call.
- Trade: O(log n) lookup with cache-friendly contiguous scanning and zero per-node allocation, paid for with O(n) insert/erase.
- Use the `std::sorted_unique` / `std::sorted_equivalent` tags to skip the sort when constructing from data you know is ordered.
- If a modifying operation throws, the container is left in a valid but unspecified state (it may be emptied).

**Adapters (`stack`, `queue`, `priority_queue`)** — expose no iterators at all, so invalidation is not observable; they are not thread-safe, they allocate through the adaptee, and `priority_queue` supports no erase and no decrease-key.

### G.6 Guarantees that are *not* complexity

| Claim | Reality |
|---|---|
| "`push_back` is O(1)" | *Amortized* over a sequence. One call may allocate and relocate every element. |
| "`reserve` prevents invalidation" | Only while `size() <= capacity()`; the `reserve` call itself invalidates everything if it grows. |
| "`shrink_to_fit` frees memory" | Non-binding request; it may allocate a new smaller buffer first, or do nothing. |
| "`clear()` frees memory" | It destroys elements; capacity is retained. Use `vector<T>{}.swap(v)` or `v = {}` + `shrink_to_fit`. |
| "`unordered_map` is faster than `map`" | Average O(1) vs O(log n), but with a pointer chase per element, worse locality, and worst-case O(n). Benchmark. |
| "`list` insertion is O(1) so it is fast" | O(1) plus one allocation and a cache miss; `vector` memmove of thousands of bytes often wins. |
| "`deque` is a ring buffer" | No fixed capacity, no overwrite policy, no backpressure, and it allocates. |
| "`map::operator[]` is a lookup" | It default-constructs and inserts on miss; use `find`/`at`/`contains` for read-only access. |
| "Iterator invalidation is diagnosable" | It is UB; use `_GLIBCXX_DEBUG` / `_LIBCPP_HARDENING_MODE` / ASan to catch it. |

---

<a id="appendix-h"></a>
## Appendix H — Iterator and range concept hierarchy

### H.1 Legacy (C++98–C++17) named requirements

Refinement chain: `LegacyIterator` → `LegacyInputIterator` → `LegacyForwardIterator` → `LegacyBidirectionalIterator` → `LegacyRandomAccessIterator` → `LegacyContiguousIterator`. `LegacyOutputIterator` is a separate branch off `LegacyIterator`.

| Named requirement | Tag type | Valid expressions added | Key semantics |
|---|---|---|---|
| `LegacyIterator` | — | `*i`, `++i`, copy/assign/destroy, `swappable` | Dereferenceable or past-the-end; no equality required |
| `LegacyOutputIterator` | `output_iterator_tag` | `*i = v`, `++i`, `i++`, `*i++ = v` | Single-pass, write-only; `++` invalidates prior copies |
| `LegacyInputIterator` | `input_iterator_tag` | `i == j`, `i != j`, `i->m`, `i++`, `*i++` | **Single-pass**, read-only; equality does not imply the same sequence position after `++` |
| `LegacyForwardIterator` | `forward_iterator_tag` | default-constructible; `i++` returns `It` | **Multipass**: `i == j` ⇒ `++i == ++j`; `*i` must be a real `value_type&` (or `const&`) |
| `LegacyBidirectionalIterator` | `bidirectional_iterator_tag` | `--i`, `i--`, `*i--` | Reversible traversal |
| `LegacyRandomAccessIterator` | `random_access_iterator_tag` | `i += n`, `i + n`, `n + i`, `i -= n`, `i - n`, `i - j`, `i[n]`, `<`, `<=`, `>`, `>=` | O(1) jump and O(1) distance; total order |
| `LegacyContiguousIterator` (C++17) | `contiguous_iterator_tag` (C++20) | — | `*(i + n)` is `*(addressof(*i) + n)`: elements are contiguous in memory |

- `std::iterator_traits<It>` supplies `value_type`, `difference_type`, `reference`, `pointer`, `iterator_category`; it is SFINAE-friendly since C++17 and specialized for pointers.
- Deriving from the deprecated `std::iterator<>` base is removed practice; declare the five typedefs (or the C++20 concepts) directly.

### H.2 C++20 iterator concepts (`<iterator>`)

Foundation concepts, in dependency order:

| Concept | Requires | Adds |
|---|---|---|
| `indirectly_readable<I>` | `iter_value_t`, `iter_reference_t`, `iter_rvalue_reference_t` exist and share a common reference | `*i` is readable and its value/reference types agree |
| `indirectly_writable<Out, T>` | `*o = std::forward<T>(t)` valid, including through `const` rvalue `*o` | `*o` is writable |
| `weakly_incrementable<I>` | `movable<I>`, `iter_difference_t<I>` is a signed integral, `++i` → `I&`, `i++` valid | Incrementable **without** equality; single-pass |
| `incrementable<I>` | `weakly_incrementable` + `regular<I>` + `i++` returns `I` | Equality-preserving increment ⇒ multipass |
| `input_or_output_iterator<I>` | `weakly_incrementable<I>` + `*i` is referenceable | The root iterator concept |
| `sentinel_for<S, I>` | `semiregular<S>` + `i == s` valid | A type that can mark the end of a range |
| `sized_sentinel_for<S, I>` | `sentinel_for` + `s - i` and `i - s` yield `iter_difference_t<I>` in O(1) | `ranges::distance` is O(1); opt out with `disable_sized_sentinel_for` |

Traversal hierarchy (each refines the previous):

| Concept | Requires additionally | What it buys | Modelled by |
|---|---|---|---|
| `input_iterator<I>` | `input_or_output_iterator` + `indirectly_readable` + `ITER_CONCEPT` derives from `input_iterator_tag` | Read once, forward, single-pass | `istream_iterator`, `filter_view` iterators |
| `output_iterator<I, T>` | `input_or_output_iterator` + `indirectly_writable<I,T>` + `*i++ = t` | Write once, forward, single-pass | `back_insert_iterator`, `ostream_iterator` |
| `forward_iterator<I>` | `input_iterator` + `incrementable` + `sentinel_for<I,I>` + tag derives from `forward_iterator_tag` | Multipass; iterators are `regular`, can be saved and re-traversed | `forward_list`, `unordered_*` |
| `bidirectional_iterator<I>` | `--i` → `I&`, `i--` → `I` | Reverse traversal; enables `reverse_view`, `std::reverse` | `list`, `set`, `map` |
| `random_access_iterator<I>` | `totally_ordered<I>` + `sized_sentinel_for<I,I>` + `+= -= + - []` | O(1) jump, O(1) `distance`, sortable | `deque` |
| `contiguous_iterator<I>` | `is_lvalue_reference_v<iter_reference_t<I>>`, `same_as<iter_value_t<I>, remove_cvref_t<iter_reference_t<I>>>`, `to_address(i)` valid | A raw pointer can replace the iterator; memcpy/SIMD/`span` are legal | `array`, `vector`, `string`, `string_view`, `span`, `valarray` |

**Where the C++20 concepts and the legacy requirements disagree** — memorize this, it is a standard interview question:

| Difference | Consequence |
|---|---|
| C++20 splits the *value category* requirement out of `forward_iterator`: `iterator_concept` (not `iterator_category`) drives the concept via the exposition-only `ITER_CONCEPT` | An iterator can be a C++20 `random_access_iterator` while advertising `input_iterator_tag` as its `iterator_category` — exactly what `views::zip`, `views::enumerate`, and `views::transform` (with prvalue results) do, so that legacy algorithms do not mistake them for multipass `T&` iterators |
| Legacy `ForwardIterator` demands `*i` be `T&`; C++20 `forward_iterator` allows proxy references | Proxy ranges work with `ranges::` algorithms but are not `LegacyForwardIterator` |
| C++20 `input_iterator` need not be copyable in the equality-preserving sense; `weakly_incrementable` allows move-only iterators | Move-only iterators (many views) are legal in C++20 but break C++17 algorithms |
| C++20 allows a sentinel type different from the iterator type | `[first, last)` becomes `[iterator, sentinel)`; `views::take_while`, null-terminated ranges, and counted ranges need no matching end iterator |
| C++20 `output_iterator` requires `*i++ = t` to work | Unchanged in spirit; but ranges algorithms return the final output iterator so you can keep writing |

**Associated type aliases**

| Alias | Yields |
|---|---|
| `std::iter_value_t<I>` | the value type (`ranges::range_value_t<R>` for ranges) |
| `std::iter_reference_t<I>` | `decltype(*i)` |
| `std::iter_const_reference_t<I>` (C++23) | the reference type of a read-only view of `I` |
| `std::iter_difference_t<I>` | signed distance type |
| `std::iter_rvalue_reference_t<I>` | `decltype(ranges::iter_move(i))` |
| `std::iter_common_reference_t<I>` | common reference of value and reference types |
| `std::ranges::range_value_t/reference_t/const_reference_t/rvalue_reference_t/difference_t/size_t<R>` | the same, lifted to ranges |
| `std::ranges::iterator_t<R>` / `sentinel_t<R>` / `const_iterator_t<R>` (C++23) | `decltype(ranges::begin(r))` etc. |
| `std::ranges::borrowed_iterator_t<R>` / `borrowed_subrange_t<R>` | `iterator_t<R>` or `ranges::dangling` |

Customization points: `ranges::iter_move(i)` and `ranges::iter_swap(i, j)` — use these, not `std::move(*i)` / `std::swap(*i, *j)`, in generic code, because proxy iterators customize them.

### H.3 Indirect callable and rearrangement concepts

| Concept | Meaning |
|---|---|
| `indirectly_unary_invocable<F, I>` | `F` callable with `*i` (and with the value/common-reference forms) |
| `indirectly_regular_unary_invocable<F, I>` | as above, and equality-preserving |
| `indirect_unary_predicate<F, I>` | predicate over `*i` — what `find_if`, `all_of`, `filter` take |
| `indirect_binary_predicate<F, I1, I2>` | predicate over `*i1, *i2` |
| `indirect_equivalence_relation<F, I1, I2>` | reflexive, symmetric, transitive |
| `indirect_strict_weak_order<F, I1, I2>` | what `sort`, `lower_bound`, `merge` require of the comparator |
| `indirect_result_t<F, Is...>` | result type of the indirect call |
| `projected<I, Proj>` | the "iterator" seen by an algorithm after applying a projection |
| `indirectly_movable<In, Out>` / `_storable` | `*out = ranges::iter_move(in)` valid / plus buffering via `iter_value_t` |
| `indirectly_copyable<In, Out>` / `_storable` | same for copies |
| `indirectly_swappable<I1, I2>` | `ranges::iter_swap` valid both ways |
| `indirectly_comparable<I1, I2, Cmp, P1, P2>` | comparison after projection is valid |
| `permutable<I>` | `forward_iterator` + `indirectly_movable<I,I>` + `indirectly_swappable<I,I>` — needed to rearrange in place |
| `mergeable<I1, I2, Out, Cmp, P1, P2>` | required by `merge`, `set_union`, `set_intersection`, … |
| `sortable<I, Cmp, Proj>` | `permutable<I>` + `indirect_strict_weak_order` — required by `sort`, `nth_element`, heap ops |

### H.4 Range concepts (`<ranges>`)

| Concept | Definition / adds | Notes |
|---|---|---|
| `ranges::range<R>` | `ranges::begin(r)` and `ranges::end(r)` are valid | The root; arrays and anything with member or ADL `begin`/`end` |
| `ranges::borrowed_range<R>` | `R` is an lvalue range, or opts in via `enable_borrowed_range` | Iterators outlive the range expression; algorithms return real iterators instead of `ranges::dangling` |
| `ranges::sized_range<R>` | `ranges::size(r)` is valid and O(1) | Opt out with `disable_sized_range` |
| `ranges::view<R>` | `range` + `movable` + `enable_view` (usually via `view_interface`/`view_base`) | O(1) move/copy/destroy — cheap to pass by value |
| `ranges::viewable_range<R>` | can be converted by `views::all` | Rejects binding a view to an rvalue container |
| `ranges::output_range<R, T>` | `range` + `output_iterator<iterator_t<R>, T>` | Destination ranges |
| `ranges::input_range<R>` | `input_iterator<iterator_t<R>>` | |
| `ranges::forward_range<R>` | `forward_iterator<iterator_t<R>>` | multipass |
| `ranges::bidirectional_range<R>` | `bidirectional_iterator` | |
| `ranges::random_access_range<R>` | `random_access_iterator` | |
| `ranges::contiguous_range<R>` | `contiguous_iterator` + `ranges::data(r)` valid | convertible to `span` |
| `ranges::common_range<R>` | `same_as<iterator_t<R>, sentinel_t<R>>` | Required to feed a range into a legacy iterator-pair algorithm; `views::common` adapts |
| `ranges::constant_range<R>` (C++23) | `input_range` whose reference is read-only | `views::as_const` produces one |
| `ranges::simple-view` (exposition) | `R` and `const R` have the same iterator/sentinel | Explains the `const`/non-`const` `begin` overload pairs in views |

Useful facts: `view` does **not** imply cheap *iteration* (a `filter_view`'s `begin()` is O(n) and is cached); `sized_range` and `common_range` are independent of the traversal category; `views::all_t<R>` is the view type `views::all` produces.

### H.5 Which algorithms require which

| Minimum requirement | Algorithms |
|---|---|
| `input_iterator` / `input_range` | `for_each`, `find`, `find_if`, `find_if_not`, `count`, `count_if`, `mismatch`, `equal`, `all_of`, `any_of`, `none_of`, `accumulate`, `reduce`, `transform_reduce`, `inner_product`, `copy`, `copy_n`, `move`, `transform` (unary/binary), `partial_sum`, `inclusive_scan`, `exclusive_scan`, `adjacent_difference`, `fold_left` (C++23), `contains` (C++23) |
| `output_iterator` (destination) | `copy`, `move`, `transform`, `fill_n`, `generate_n`, `merge`, `set_*`, `unique_copy`, `remove_copy`, `replace_copy`, `partition_copy`, `sample`, `rotate_copy`, `reverse_copy`, `partial_sort_copy` |
| `forward_iterator` / `forward_range` | `adjacent_find`, `search`, `search_n`, `find_end`, `find_first_of`, `lower_bound`, `upper_bound`, `equal_range`, `binary_search`, `partition_point`, `is_sorted`, `is_sorted_until`, `min_element`, `max_element`, `minmax_element`, `is_partitioned`, `fill`, `generate`, `replace`, `swap_ranges`, `iota`, `unique`\*, `remove`\*, `partition`\*, `rotate`\*, `shift_left`/`shift_right` (C++20)\*, `adjacent` views |
| `bidirectional_iterator` | `reverse`, `reverse_copy`, `stable_partition`, `inplace_merge`, `next_permutation`, `prev_permutation`, `copy_backward`, `move_backward`, `views::reverse` |
| `random_access_iterator` | `sort`, `stable_sort`, `partial_sort`, `partial_sort_copy` (dest), `nth_element`, `is_heap`, `is_heap_until`, `make_heap`, `push_heap`, `pop_heap`, `sort_heap`, `shuffle`, `random_shuffle` (removed C++17), `views::stride`/`views::slide` fast paths |
| `contiguous_iterator` | Nothing in `<algorithm>` *requires* it, but it enables `span` construction, `memcpy`/`memcmp` fast paths, `std::from_chars`/`to_chars`, `read`/`write` on raw buffers, and vectorization |
| `permutable` (rearranging in place) | `unique`, `remove`, `remove_if`, `partition`, `rotate`, `reverse`, `shuffle`, all sorts and heap ops |
| `sortable` = `permutable` + strict weak order | `sort`, `stable_sort`, `partial_sort`, `nth_element`, heap ops |
| `mergeable` | `merge`, `set_union`, `set_intersection`, `set_difference`, `set_symmetric_difference` |
| `sized_sentinel_for` | O(1) `ranges::distance`; `views::take`/`drop`/`counted` fast paths |
| `common_range` | Passing a range to a legacy `(first, last)` algorithm; `views::common` |
| `borrowed_range` | Any `ranges::` algorithm whose return type is an iterator, else you get `ranges::dangling` |

\* These require `permutable`, i.e. `forward_iterator` plus movable/swappable elements.

Extra preconditions that are **not** captured by concepts and are therefore silent UB when violated:

| Algorithm family | Unchecked precondition |
|---|---|
| `binary_search`, `lower_bound`, `upper_bound`, `equal_range` | the range is partitioned with respect to the comparator |
| `merge`, `inplace_merge`, `includes`, `set_*` | both inputs are sorted by the same comparator |
| `unique`, `unique_copy` | duplicates are **adjacent** (usually implies a prior sort) |
| `sort` and friends | the comparator is a strict weak ordering (`<=` is not) |
| `partition_point` | the range is partitioned by the predicate |
| `copy`, `transform` (in-place-ish) | ranges do not overlap unless the algorithm is `_backward` |
| `push_heap` / `pop_heap` | `[first, last-1)` is already a heap |
| all copying algorithms | the destination has **size**, not just capacity |

### H.6 Iterator adaptors and factories

| Adaptor | Purpose | Resulting category |
|---|---|---|
| `reverse_iterator` | traverse backwards; `base()` is one past the referent | as the underlying, ≤ bidirectional |
| `back_insert_iterator` / `back_inserter` | `push_back` on assignment | output |
| `front_insert_iterator` / `front_inserter` | `push_front` | output |
| `insert_iterator` / `inserter` | `insert(pos, v)` | output |
| `move_iterator` / `make_move_iterator` | `*i` yields an rvalue | as underlying |
| `move_sentinel` (C++20) | pairs with `move_iterator` | sentinel |
| `counted_iterator` (C++20) | carries a remaining count; ends at `default_sentinel` | as underlying |
| `common_iterator` (C++20) | erases an iterator/sentinel pair into one type | ≤ forward |
| `basic_const_iterator` (C++23) | read-only view of an iterator | as underlying |
| `istream_iterator` / `ostream_iterator` | stream adaptors | input / output |
| `istreambuf_iterator` / `ostreambuf_iterator` | unformatted character streams | input / output |
| `default_sentinel_t` / `unreachable_sentinel_t` | "ask the iterator" / infinite range | sentinel |

---

<a id="appendix-i"></a>
## Appendix I — Standard-library thread-safety summary

### I.1 The two base rules

1. **Data-race rule** — a program has a data race if two threads perform conflicting actions (at least one a write) on the same memory location without a happens-before relation; the behaviour is undefined. Nothing in the standard library repeals this.
2. **Library rule** — a standard-library function may not directly or indirectly access objects accessible by other threads except through its own arguments (including `this`), and may not modify objects accessible through its arguments unless the specification says so. Therefore: **concurrent `const` use is safe; any non-`const` use must be exclusive.**

### I.2 Containers

| Situation | Guarantee |
|---|---|
| Multiple threads calling only `const` members on the same container | Safe |
| One writer + any reader on the same container | **Data race** — external synchronization required |
| Concurrent writes to *different elements* of the same container | Safe for all containers **except `vector<bool>`** (bit packing puts distinct elements in one word) |
| Concurrent `begin`, `end`, `rbegin`, `rend`, `front`, `back`, `data`, `find`, `lower_bound`, `upper_bound`, `equal_range`, `at`, `size`, `empty`, `count`, `contains` | Treated as `const` for race purposes even in their non-`const` overloads — safe concurrently with each other |
| `map::operator[]` / `unordered_map::operator[]` | **Not** const-like: it may insert. Never call it concurrently |
| Unordered containers: `bucket_count`, `bucket_size`, `bucket`, `load_factor`, `max_load_factor()` (getter), `begin(n)`, `end(n)` | Const-like; `max_load_factor(z)`, `rehash`, `reserve` are writes |
| Any operation that may reallocate, rehash, splice, or erase | Exclusive access required — it can invalidate handles other threads hold |
| Container adapters (`stack`, `queue`, `priority_queue`) | No extra guarantees; they are not concurrent queues |
| `std::atomic<T>` elements inside a container | The elements are race-free; the *container* is not (a `vector<atomic<T>>` still cannot be resized concurrently, and `atomic` is not copyable/movable) |

There are **no** concurrent containers in the standard library. A "thread-safe queue" is something you build (mutex + condition variable, or the SPSC ring of `#ch36`).

### I.3 Smart pointers and reference counting

| Subject | Guarantee |
|---|---|
| `shared_ptr` control-block reference count | Atomic. Copying, destroying, and `weak_ptr::lock()` from many threads on **different** `shared_ptr` objects that share a control block is safe |
| The **same** `shared_ptr` object read by one thread and assigned/reset by another | **Data race** — the pointer and deleter fields are ordinary members |
| The pointee `T` | No protection at all; `shared_ptr<T>` says nothing about `T`'s thread safety |
| `std::atomic<std::shared_ptr<T>>` / `atomic<weak_ptr<T>>` (C++20) | The supported way to publish and swap a `shared_ptr` concurrently; may not be lock-free (`is_lock_free()`), typically a spinlock in the implementation |
| `std::atomic_load/atomic_store/atomic_exchange/atomic_compare_exchange_*(shared_ptr*)` | Deprecated in C++20, removed in C++26 — replace with `atomic<shared_ptr<T>>` |
| `unique_ptr` | No atomicity whatsoever; it is a plain member move |
| `enable_shared_from_this::shared_from_this()` | Safe concurrently once at least one `shared_ptr` owns the object; throws `bad_weak_ptr` otherwise |
| `weak_ptr::expired()` | Advisory only — racy by construction; use `lock()` and test the result |
| Deleter / destructor invocation | Runs exactly once, on the thread that drops the last reference; the decrement to zero synchronizes with all prior decrements (release/acquire), so all prior writes are visible to the destructor |

### I.4 Streams and I/O

| Subject | Guarantee |
|---|---|
| `cin`, `cout`, `cerr`, `clog`, and the wide versions | Concurrent formatted/unformatted input or output from multiple threads is **not a data race** (they are synchronized with the C streams while `sync_with_stdio(true)`, which is the default), but the **interleaving is unspecified** — characters from different threads may interleave mid-line |
| Any other stream object (`ifstream`, `ostringstream`, `stringstream`, …) | Ordinary object rules: one writer excludes all. Not thread-safe |
| `sync_with_stdio(false)` | Removes the C-stream tie **and the race freedom** for `cin`/`cout`/`cerr` |
| Stream state and format flags (`setf`, `precision`, `width`, `imbue`, `tie`, `exceptions`, `rdbuf`) | Writes to the stream object — a race if done concurrently with any use |
| `std::osyncstream` / `wosyncstream` (C++20, `<syncstream>`) | The portable fix for interleaving: buffers locally and emits atomically on destruction/`emit()` |
| `std::print` / `std::println` (C++23) | Output through the underlying C stream; same race-freedom-but-unspecified-interleaving story, and the implementation locks the `FILE*` |
| `printf` family / C streams | Each `FILE*` is locked per call by the C library; interleaving between calls is still unspecified |
| `std::filesystem` | The library functions are reentrant, but the file system is shared mutable state; concurrent access from other processes makes every query advisory (TOCTOU) |

### I.5 Statics, initialization, and lifetime

| Subject | Guarantee |
|---|---|
| Block-scope `static` with dynamic initialization ("magic statics", C++11) | Exactly one thread runs the initializer; all others block until it completes and then see the initialized object. This is the correct thread-safe lazy singleton |
| Recursive re-entry into a static's own initializer | Undefined behaviour (typically deadlock or `__cxa_guard` abort) |
| Namespace-scope non-local dynamic initialization | Unordered across translation units; concurrent-safe within a thread of startup but the classic **static initialization order fiasco** is unaffected. `constinit` forces constant initialization and eliminates it |
| `thread_local` | One object per thread; constructed on first use in that thread, destroyed at thread exit in reverse order. Destruction order relative to `static` objects at program end is a known hazard |
| `std::call_once` / `std::once_flag` | Exactly-once with a happens-before edge to every other `call_once` on that flag; if the callable throws, the flag stays unset and the next caller retries |
| `std::atexit` / `std::quick_exit` handlers | Run on the calling thread; if other threads are still running, everything they touch races |
| Destroying an object while another thread may use it | Always the caller's problem; `shared_ptr` only defers it |

### I.6 Randomness, time, locale, and C legacy

| Subject | Guarantee |
|---|---|
| `std::rand` / `std::srand` | **Not required to be thread-safe**; implementations commonly share hidden state. Avoid |
| `std::mt19937`, `minstd_rand`, any `<random>` engine object | An ordinary object: generating from one engine on two threads is a data race. Use one engine per thread (`thread_local`), seeded distinctly |
| `<random>` distributions | Stateful (`normal_distribution` caches a second Box–Muller value); one per thread |
| `std::random_device` | Each object is separate; may block, may be deterministic on some implementations (`entropy()` returns 0). Use it only to seed |
| `std::chrono::*_clock::now()` | Thread-safe; `steady_clock` is monotonic, `system_clock` is not (NTP steps) |
| `std::localtime`, `gmtime`, `ctime`, `asctime` | **Not thread-safe** — they return a pointer to a shared static buffer. Use `std::chrono::zoned_time` / `year_month_day` (C++20), or the POSIX `_r` variants |
| `std::strtok`, `std::mbtowc`, `std::wctomb` | Hold static state; not thread-safe (`strtok_s`/`strtok_r` are) |
| `errno` | Thread-local (guaranteed since C++11) |
| `std::setlocale`, `std::locale::global` | Not safe concurrently with any other locale-sensitive call, including stream formatting |
| `std::getenv` / `setenv` / `putenv` | Reading concurrently with a modification is a race; `setenv` is not thread-safe |
| `std::terminate`, `std::abort`, `std::exit` | `exit` runs destructors of static objects while other threads run — a well-known crash source. Prefer joining threads first, or `std::quick_exit`/`_exit` for hard shutdown |

### I.7 Synchronization primitives (what they guarantee)

| Type | Header | Guarantee |
|---|---|---|
| `std::mutex`, `recursive_mutex`, `timed_mutex`, `recursive_timed_mutex` | `<mutex>` | Mutual exclusion; unlock *synchronizes-with* subsequent lock. Not recursive unless named so; relocking a `mutex` you hold is UB |
| `std::shared_mutex` (C++17), `shared_timed_mutex` (C++14) | `<shared_mutex>` | Many readers or one writer; writer starvation policy is unspecified |
| `lock_guard`, `unique_lock`, `shared_lock`, `scoped_lock` (C++17) | `<mutex>` | RAII; `scoped_lock` locks multiple mutexes deadlock-free (`std::lock` ordering) |
| `std::condition_variable` / `_any` | `<condition_variable>` | Requires a predicate loop — spurious and lost wakeups are permitted. `notify_*` need not hold the lock, but the state change must |
| `std::counting_semaphore` / `binary_semaphore` (C++20) | `<semaphore>` | Counted permits; `acquire`/`release`; no ownership, so any thread may release |
| `std::latch` (C++20) | `<latch>` | Single-use countdown; `count_down` + `wait` |
| `std::barrier` (C++20) | `<barrier>` | Reusable phase synchronization with an optional completion function |
| `std::atomic<T>`, `atomic_ref<T>` (C++20), `atomic_flag` | `<atomic>` | Race-free access with the requested ordering (see `#appendix-j`) |
| `std::jthread` (C++20), `stop_token`, `stop_source` | `<thread>`, `<stop_token>` | RAII join on destruction + cooperative cancellation. `std::thread`'s destructor calls `terminate()` if still joinable |
| `std::promise` / `future` / `shared_future` / `packaged_task` / `async` | `<future>` | Setting the value happens-before the waiter's return. `shared_future` may be read by many threads only through **distinct copies**; `async` with the default policy returns a future whose destructor **blocks** |
| Global `operator new` / `operator delete` | `<new>` | Thread-safe by requirement; each allocation returns storage disjoint from all others. Replacements you write must be too |

### I.8 Quick verdicts

| Claim | Verdict |
|---|---|
| "`shared_ptr` is thread-safe" | Only the control block is. The pointee and the `shared_ptr` object itself are not. |
| "`const` means thread-safe" | For standard-library types, yes by design; for your own types only if you keep `const` and logically-immutable in sync (a `mutable` cache breaks it). |
| "`std::cout` is thread-safe" | No data race, but lines interleave. Use `osyncstream` or a single logging thread. |
| "`volatile` helps with threads" | No. It is for MMIO and signal handlers; it provides no atomicity and no ordering. |
| "Static local singletons need double-checked locking" | Not since C++11 — the compiler emits the guard. |
| "Reading while another thread writes is fine if I only read an `int`" | No. Torn/duplicated reads and compiler transformations are permitted; use `std::atomic` or `atomic_ref`. |
| "The container is fine, I only push from one thread" | `push_back` reallocating invalidates readers' pointers — still a race. |
| "`rand()` is fine, I don't care about quality" | It may be a race regardless of quality. |

---

<a id="appendix-j"></a>
## Appendix J — Atomic memory orders and canonical patterns

### J.1 Which order is allowed where

| Operation | `relaxed` | `consume` | `acquire` | `release` | `acq_rel` | `seq_cst` |
|---|---|---|---|---|---|---|
| `load()` | yes | yes | yes | **UB** | **UB** | yes (default) |
| `store()` | yes | **UB** | **UB** | yes | **UB** | yes (default) |
| RMW: `exchange`, `fetch_add/sub/and/or/xor`, `fetch_max/min` (C++26) | yes | yes | yes | yes | yes | yes |
| `compare_exchange_weak/strong` — success order | yes | yes | yes | yes | yes | yes |
| `compare_exchange_*` — **failure** order | yes | yes | yes | **UB** | **UB** | yes |
| `atomic_thread_fence` | yes (no-op) | yes | yes | yes | yes | yes |
| `atomic_signal_fence` | yes | yes | yes | yes | yes | yes |
| `wait(old, order)` | yes | yes | yes | **UB** | **UB** | yes |
| `notify_one` / `notify_all` | takes no order | | | | | |
| `atomic_flag::test_and_set` / `clear` | `clear` accepts load-free store orders (`relaxed`, `release`, `seq_cst`); `test_and_set` accepts all | | | | | |

- Since C++17 the failure order need **not** be no stronger than the success order; it must merely be a load order.
- Failure order applies when the comparison fails: the operation is then a *load*, not an RMW, so no release semantics can apply — hence the UB entries.

### J.2 What each order guarantees

| Order | Guarantee | Cost on x86-64 | Cost on AArch64 | Use for |
|---|---|---|---|---|
| `memory_order_relaxed` | Atomicity and modification-order consistency for **this one location** only. No ordering with any other location. Coherence still holds: a single object's modification order is total, and a thread never sees it go backwards | plain `mov` | `ldr`/`str` | statistics counters, reference-count increments, ABA tags, spin backoff reads |
| `memory_order_consume` | Ordering only along the *data-dependency* chain out of the loaded value. **Discouraged since C++17** (P0371); every known implementation promotes it to `acquire` | as acquire | as acquire | nothing new — write `acquire` |
| `memory_order_acquire` | On a load: no reads or writes in this thread can be reordered before it, and everything sequenced before the matching *release* store in the releasing thread becomes visible | plain `mov` (TSO) | `ldar` | the consumer side of publication, lock acquisition |
| `memory_order_release` | On a store: no reads or writes in this thread can be reordered after it; it publishes everything sequenced before it to any thread that acquires this value | plain `mov` (TSO) | `stlr` | the producer side of publication, lock release, refcount decrement |
| `memory_order_acq_rel` | RMW only: acquire on the read half, release on the write half | `lock`-prefixed RMW | `ldaxr`/`stlxr` | CAS loops that both consume and publish, `fetch_sub` on a refcount that must order the destructor |
| `memory_order_seq_cst` | Everything `acq_rel` gives, **plus** membership in a single total order *S* over all `seq_cst` operations in the program, consistent with every thread's program order | `xchg` or `mov` + `mfence` on stores; loads are plain | `stlr`/`ldar` (+ `dmb ish` on some models) | flags whose relative order across *different* locations matters — store-buffering / Dekker patterns |

**The one thing `seq_cst` adds over `acq_rel`**: release/acquire orders operations *relative to a single synchronizing variable*; it does **not** prevent two threads from disagreeing about the interleaving of two independent variables. Only `seq_cst` gives all threads one agreed-upon order.

### J.3 Ordering vocabulary

| Relation | Definition |
|---|---|
| *sequenced-before* | Program-order relation within one thread |
| *synchronizes-with* | A release operation A on M synchronizes-with an acquire operation B on M if B reads the value stored by A, or by any store in A's *release sequence* |
| *release sequence* | The store itself plus any subsequent RMW operations on the same object by any thread — this is why `fetch_add` chains keep the release edge alive |
| *happens-before* | Transitive closure of sequenced-before and synchronizes-with (plus dependency-ordered-before for `consume`) |
| *modification order* | A total order on all writes to one atomic object; agreed by all threads, exists even for `relaxed` |
| *data race* | Two conflicting non-atomic accesses with no happens-before between them ⇒ **UB** |
| *out-of-thin-air* | Prohibited in practice by all implementations, not formally excludable for `relaxed` in the standard's model |

### J.4 Canonical patterns

**Publication (release/acquire message passing)** — the single most important pattern.

```cpp
// Producer                              // Consumer
Payload data;                            std::atomic<bool> ready{false};

data.a = 1;                              while (!ready.load(std::memory_order_acquire))
data.b = 2;                                  ;                       // spin or wait()
ready.store(true, std::memory_order_release);
                                         use(data.a, data.b);       // guaranteed visible
```
The plain writes to `data` are ordered before the release store; the acquire load that observes `true` establishes happens-before, so the non-atomic reads are race-free. Making `ready` `relaxed` on either side breaks it silently.

**Pointer publication (`consume` written as `acquire`)**

```cpp
std::atomic<Config const*> current{nullptr};

void publish(Config const* c) {          // producer: c is fully built
    current.store(c, std::memory_order_release);
}
Config const* read() {                   // consumer
    return current.load(std::memory_order_acquire);   // never write consume
}
```

**Relaxed counters**

```cpp
std::atomic<std::uint64_t> messages{0};
messages.fetch_add(1, std::memory_order_relaxed);      // stats: no ordering needed
auto total = messages.load(std::memory_order_relaxed);  // may lag; that is fine
```

**Reference count (the `acq_rel` / `acquire`-fence idiom)**

```cpp
if (refs.fetch_sub(1, std::memory_order_acq_rel) == 1) delete p;
// Equivalent, cheaper on the common path:
if (refs.fetch_sub(1, std::memory_order_release) == 1) {
    std::atomic_thread_fence(std::memory_order_acquire);   // order the destructor
    delete p;                                              // after all other threads' uses
}
// Increments may be relaxed only when the caller already owns a reference.
```

**CAS loop (read–modify–write on a value the hardware cannot do atomically)**

```cpp
std::atomic<Stats> stats;                      // trivially copyable, lock-free
Stats expected = stats.load(std::memory_order_relaxed);
Stats desired;
do {
    desired = update(expected);                // recompute EVERY iteration
} while (!stats.compare_exchange_weak(expected, desired,
                                      std::memory_order_acq_rel,     // on success
                                      std::memory_order_relaxed));   // on failure
// compare_exchange_* writes the CURRENT value back into `expected` when it fails,
// so the loop reloads for free. Forgetting to recompute `desired` is the classic bug.
```

| CAS choice | Rule |
|---|---|
| `compare_exchange_weak` | May fail spuriously; use inside a loop where a retry is free (LL/SC targets emit tighter code) |
| `compare_exchange_strong` | No spurious failure; use when there is no loop, or when the loop body is expensive |
| Success order | The order you need if the swap happens (`acq_rel` when it publishes and consumes) |
| Failure order | A load order, ≤ what you need to re-read; `relaxed` is almost always right |

**Lock-free stack push (with the ABA caveat)**

```cpp
void push(Node* n) {
    n->next = head.load(std::memory_order_relaxed);
    while (!head.compare_exchange_weak(n->next, n,
                                       std::memory_order_release,
                                       std::memory_order_relaxed))
        ;   // n->next is refreshed by the failed CAS
}
// Pop needs acquire (to see n->next written by the pusher) AND a reclamation
// scheme — hazard pointers, epochs, or a tagged pointer — or it hits ABA. See #ch31.
```

**Seqlock (single writer, many readers, no reader-side writes)**

```cpp
struct Seqlock {
    std::atomic<std::uint64_t> seq{0};
    std::atomic<Quote> value;            // atomic (or per-field atomics) — plain data
                                         // would be a formal data race even if the
                                         // sequence check discards the torn read
    void write(Quote const& q) {                       // ONE writer only
        auto s = seq.load(std::memory_order_relaxed);
        seq.store(s + 1, std::memory_order_relaxed);   // odd = write in progress
        std::atomic_thread_fence(std::memory_order_release);
        value.store(q, std::memory_order_relaxed);
        seq.store(s + 2, std::memory_order_release);   // even = stable
    }
    Quote read() const {
        Quote q;
        std::uint64_t s0, s1;
        do {
            s0 = seq.load(std::memory_order_acquire);
            if (s0 & 1) continue;                      // writer mid-update
            q = value.load(std::memory_order_relaxed);
            std::atomic_thread_fence(std::memory_order_acquire);
            s1 = seq.load(std::memory_order_relaxed);
        } while (s0 != s1);
        return q;                                      // readers never block the writer
    }
};
```

**Store-buffering / Dekker — the case that *requires* `seq_cst`**

```cpp
std::atomic<int> x{0}, y{0};
// Thread 1                              // Thread 2
x.store(1, std::memory_order_seq_cst);   y.store(1, std::memory_order_seq_cst);
int r1 = y.load(std::memory_order_seq_cst); int r2 = x.load(std::memory_order_seq_cst);
// With seq_cst: r1 == 0 && r2 == 0 is IMPOSSIBLE.
// With release/acquire (or relaxed): r1 == 0 && r2 == 0 IS allowed — and x86 will
// produce it, because the store buffer is not flushed before the load.
```

**Fences (standalone, for when the ordering is not attached to one variable)**

```cpp
std::atomic_thread_fence(std::memory_order_release);   // orders everything BEFORE it
                                                       // against a later relaxed store
std::atomic_thread_fence(std::memory_order_acquire);   // orders a prior relaxed load
                                                       // against everything AFTER it
std::atomic_signal_fence(std::memory_order_seq_cst);   // compiler barrier only;
                                                       // for signal handlers, no CPU cost
```
A fence needs a partner *atomic operation* on both sides to create synchronizes-with; a lone fence orders nothing across threads. Fence-based proofs are strictly harder than operation-based ones — prefer ordering on the operation.

**Wait/notify (C++20) instead of a raw spin**

```cpp
std::atomic<bool> ready{false};
ready.wait(false, std::memory_order_acquire);   // blocks while value == false
// producer:
ready.store(true, std::memory_order_release);
ready.notify_all();                             // no order parameter
// wait() may return spuriously — re-check in a loop for anything but a one-shot flag.
```

### J.5 Atomic type facts

| Fact | Detail |
|---|---|
| `std::atomic<T>` requires | `T` trivially copyable, copy-constructible, copy-assignable, and equality-comparable via its object representation |
| Lock-freedom | `is_lock_free()` (runtime) and `is_always_lock_free` (`constexpr`, C++17). A lock-free `atomic` does not make your *algorithm* lock-free |
| Padding | Compare-exchange compares object representations; padding bits can make CAS fail forever. Since C++20 padding bits in `atomic<T>` are zeroed for the comparison in the common implementations — do not rely on it, use padding-free types |
| `atomic<T>` is | not copyable, not movable; `a = b` on atomics does not exist (only `T` conversions) |
| `std::atomic_ref<T>` (C++20) | Applies atomic operations to an existing non-atomic object; requires alignment ≥ `atomic_ref<T>::required_alignment`, and **all** accesses to that object during the ref's lifetime must go through `atomic_ref` |
| `atomic_flag` | The only type guaranteed lock-free on every implementation; C++20 adds `test()` |
| `atomic<float/double>` | `fetch_add`/`fetch_sub` since C++20; no `fetch_and` etc. |
| `atomic<shared_ptr<T>>` / `atomic<weak_ptr<T>>` (C++20) | Usually lock-based |
| Integral specializations | `fetch_add/sub/and/or/xor`, `++`, `--`, `+=`, `-=`, `&=`, `\|=`, `^=`; arithmetic wraps as unsigned (no UB on overflow) |
| Pointer specializations | `fetch_add`/`fetch_sub` in element units; the result must stay in range |
| Default construction | `atomic<T> a;` value-initializes since C++20 (was indeterminate before); `ATOMIC_VAR_INIT` is deprecated/removed |
| `volatile` | Neither necessary nor sufficient for atomicity or ordering; `volatile atomic` is for MMIO |
| False sharing | Two atomics in one cache line serialize. Pad with `alignas(std::hardware_destructive_interference_size)` (C++17) |

### J.6 Rapid diagnoses

| Symptom | Likely cause |
|---|---|
| Flag observed set but the data is stale/garbage | Store used `relaxed` instead of `release`, or the load used `relaxed` instead of `acquire` |
| CAS loop spins forever | `desired` computed once outside the loop, or padding bits differ, or `expected` not being refreshed (it is refreshed automatically — the bug is recomputing) |
| Works on x86, fails on ARM | Release/acquire omitted; x86 TSO hides missing ordering that AArch64 exposes |
| `r1 == 0 && r2 == 0` in a Dekker-style test | Release/acquire is not enough — needs `seq_cst` on all four operations |
| Destructor runs while another thread still uses the object | Refcount decrement lacked `acq_rel` (or the release + acquire-fence pair) |
| Huge slowdown with more threads | False sharing, or `seq_cst` stores emitting `mfence` in a hot loop |
| `is_lock_free()` returns true but the code deadlocks | Lock-free type ≠ lock-free algorithm; you still have a blocking protocol |
| TSan reports a race on a "protected" field | The publication used a non-atomic flag, or `volatile` was used as a substitute for `atomic` |

---

<a id="appendix-k"></a>
## Appendix K — Type traits and concepts quick index

Every trait below has a `_v` variable template if it yields a value (`std::is_integral_v<T>`) and a `_t` alias if it yields a type (`std::remove_cv_t<T>`), both since C++17 (C++14 for `_t`). Value traits derive from `std::integral_constant<bool, B>`; `std::true_type` / `std::false_type` / `std::bool_constant<B>` are the spellings you use in tag dispatch.

### K.1 `<type_traits>` — primary type categories

Exactly one is true for any type.

| Trait | True for |
|---|---|
| `is_void<T>` | cv `void` |
| `is_null_pointer<T>` (C++14) | cv `std::nullptr_t` |
| `is_integral<T>` | `bool`, all character types, all signed/unsigned integers (incl. `char8_t`) |
| `is_floating_point<T>` | `float`, `double`, `long double` (and the C++23 extended FP types) |
| `is_array<T>` | `T[]` and `T[N]` |
| `is_enum<T>` | unscoped and scoped enums |
| `is_union<T>` | unions |
| `is_class<T>` | classes and structs (not unions) |
| `is_function<T>` | function types (not function pointers, not closures) |
| `is_pointer<T>` | object/function pointers (not member pointers) |
| `is_lvalue_reference<T>` | `T&` |
| `is_rvalue_reference<T>` | `T&&` |
| `is_member_object_pointer<T>` | `int C::*` |
| `is_member_function_pointer<T>` | `int (C::*)()` |

### K.2 Composite categories

| Trait | Equals |
|---|---|
| `is_reference<T>` | lvalue ∪ rvalue reference |
| `is_arithmetic<T>` | integral ∪ floating point |
| `is_fundamental<T>` | arithmetic ∪ `void` ∪ `nullptr_t` |
| `is_object<T>` | anything that is not a function, reference, or `void` |
| `is_scalar<T>` | arithmetic ∪ enum ∪ pointer ∪ member pointer ∪ `nullptr_t` |
| `is_compound<T>` | `!is_fundamental<T>` |
| `is_member_pointer<T>` | member object ∪ member function pointer |

### K.3 Type properties

| Trait | Meaning |
|---|---|
| `is_const<T>` / `is_volatile<T>` | top-level cv-qualification (note: `is_const<const int&>` is **false**) |
| `is_trivial<T>` (deprecated C++26) | trivially default-constructible and trivially copyable |
| `is_trivially_copyable<T>` | copy/move/assign/destroy are all trivial ⇒ `memcpy`-able, `bit_cast`-able |
| `is_standard_layout<T>` | one access control for all non-static members, no virtuals, layout-compatible with C ⇒ `offsetof` is valid |
| `is_pod<T>` (deprecated C++20) | trivial ∧ standard layout |
| `is_empty<T>` | class with no non-static data members, no virtuals, no non-empty bases ⇒ EBO/`[[no_unique_address]]` candidate |
| `is_polymorphic<T>` | declares or inherits a virtual function |
| `is_abstract<T>` | has an unoverridden pure virtual |
| `is_final<T>` (C++14) | declared `final` |
| `is_aggregate<T>` (C++17) | aggregate-initializable |
| `is_signed<T>` / `is_unsigned<T>` | arithmetic and signed/unsigned (false for non-arithmetic; `bool` is unsigned) |
| `is_bounded_array<T>` (C++20) | `T[N]` |
| `is_unbounded_array<T>` (C++20) | `T[]` |
| `is_scoped_enum<T>` (C++23) | `enum class` |
| `is_implicit_lifetime<T>` (C++23) | objects can be created implicitly by `malloc`/`memcpy`/`start_lifetime_as` |
| `has_unique_object_representations<T>` (C++17) | no padding, no trap values ⇒ equal objects have equal bytes ⇒ hashable/comparable by bytes |

### K.4 Supported operations

Each row exists in plain, `is_trivially_*`, and `is_nothrow_*` forms.

| Trait family | Question answered |
|---|---|
| `is_constructible<T, Args...>` | is `T obj(declval<Args>()...)` well-formed |
| `is_default_constructible<T>` | `T obj;` |
| `is_copy_constructible<T>` | `T obj(lvalue const&)` |
| `is_move_constructible<T>` | `T obj(rvalue&&)` (true if only a copy ctor exists!) |
| `is_assignable<T, U>` | `declval<T>() = declval<U>()` |
| `is_copy_assignable<T>` / `is_move_assignable<T>` | the corresponding assignments |
| `is_destructible<T>` | `obj.~T()` is accessible and not deleted |
| `has_virtual_destructor<T>` | required before `delete base_ptr` |
| `is_swappable<T>` / `is_swappable_with<T,U>` / `is_nothrow_swappable*` (C++17) | `swap` is valid after `using std::swap` |

Practical uses: `is_nothrow_move_constructible_v<T>` decides whether `vector` relocation moves or copies; `is_nothrow_swappable_v<T>` decides `noexcept` on your own `swap`; `is_trivially_destructible_v<T>` lets a pool skip destructor loops.

### K.5 Property queries

| Trait | Yields |
|---|---|
| `alignment_of<T>::value` | `alignof(T)` |
| `rank<T>::value` | number of array dimensions (0 for non-arrays) |
| `extent<T, I>::value` | size of the `I`-th dimension (0 if unbounded) |

### K.6 Type relationships

| Trait | Meaning |
|---|---|
| `is_same<T, U>` | identical types including cv and reference |
| `is_base_of<B, D>` | `B` is a base of `D` (true for `B == D`; ignores access) |
| `is_convertible<From, To>` | implicit conversion is valid |
| `is_nothrow_convertible<From, To>` (C++20) | and does not throw |
| `is_invocable<F, Args...>` / `is_invocable_r<R, F, Args...>` (C++17) | `std::invoke(f, args...)` is valid / result convertible to `R` |
| `is_nothrow_invocable*` (C++17) | and `noexcept` |
| `is_layout_compatible<T, U>` (C++20) | layout-compatible ⇒ common-initial-sequence reads through a union are defined |
| `is_pointer_interconvertible_base_of<B, D>` (C++20) | a `D*` can be `reinterpret_cast` to `B*` and back |
| `is_pointer_interconvertible_with_class(M C::*)` (C++20, function) | member is at offset 0 in a standard-layout class |
| `is_corresponding_member(M1 C1::*, M2 C2::*)` (C++20, function) | members occupy the same position in a common initial sequence |
| `reference_constructs_from_temporary<T, U>` (C++23) | binding `T` to `U` would create a dangling reference |
| `reference_converts_from_temporary<T, U>` (C++23) | same, for copy-initialization |

### K.7 Type transformations

| Group | Traits |
|---|---|
| cv | `remove_const`, `remove_volatile`, `remove_cv`, `add_const`, `add_volatile`, `add_cv` |
| references | `remove_reference`, `add_lvalue_reference`, `add_rvalue_reference` |
| pointers | `remove_pointer`, `add_pointer` |
| sign | `make_signed`, `make_unsigned` (UB-adjacent for `bool`; ill-formed for non-integral non-enum) |
| arrays | `remove_extent` (one dimension), `remove_all_extents` |
| combined | `remove_cvref` (C++20) = `remove_cv_t<remove_reference_t<T>>` — the correct default for a forwarding-reference parameter; `decay` (adds array/function decay too, i.e. what pass-by-value does) |
| selection | `conditional<B, T, F>`, `enable_if<B, T>`, `void_t<...>` (C++17) |
| deduction | `common_type<Ts...>`, `common_reference<Ts...>` (C++20) + `basic_common_reference` customization, `underlying_type<Enum>`, `invoke_result<F, Args...>` (C++17; `result_of` removed in C++20) |
| identity | `type_identity<T>` (C++20) — blocks template deduction on a parameter |
| `reference_wrapper` | `unwrap_reference<T>`, `unwrap_ref_decay<T>` (C++20) — what `make_pair`/`make_tuple` do |
| storage (deprecated C++23) | `aligned_storage`, `aligned_union` — use `alignas` + `std::byte[]` |
| logical | `conjunction<Ts...>`, `disjunction<Ts...>`, `negation<T>` (C++17) — short-circuiting, unlike `&&` on `_v` |
| constant evaluation | `is_constant_evaluated()` (C++20, a function); prefer `if consteval` (C++23) |

```cpp
// The three most-used idioms
template<class T> void f(T&& t) { using U = std::remove_cvref_t<T>; }   // C++20
template<class, class = void> struct has_size : std::false_type {};      // detection
template<class T> struct has_size<T, std::void_t<decltype(std::declval<T>().size())>>
    : std::true_type {};
template<class T> constexpr bool always_false_v = false;                 // for static_assert
```

`std::declval<T>()` (`<utility>`) yields a `T&&` in unevaluated contexts only — using it in evaluated code is ill-formed by design.

### K.8 `<concepts>` — the standard concept set

| Concept | Requires |
|---|---|
| `same_as<T, U>` | `is_same_v` both ways (symmetric for subsumption) |
| `derived_from<D, B>` | `is_base_of_v<B,D>` **and** the conversion is accessible (unambiguous public base) |
| `convertible_to<From, To>` | implicit **and** explicit (`static_cast`) conversion both valid |
| `common_reference_with<T, U>` | `common_reference_t<T,U>` exists and both convert to it |
| `common_with<T, U>` | `common_type_t<T,U>` exists and both convert to it |
| `integral<T>` / `signed_integral<T>` / `unsigned_integral<T>` | `is_integral_v` (+ signedness) |
| `floating_point<T>` | `is_floating_point_v` |
| `assignable_from<L, R>` | `L` is an lvalue reference, `l = std::forward<R>(r)` returns `L`, and does not modify `r`'s value when `R` is an lvalue |
| `swappable<T>` / `swappable_with<T, U>` | `ranges::swap` is valid |
| `destructible<T>` | `is_nothrow_destructible_v` — note the **nothrow** |
| `constructible_from<T, Args...>` | `destructible<T>` + `is_constructible_v` |
| `default_initializable<T>` | `constructible_from<T>` + `T{}` valid + `T obj;` valid |
| `move_constructible<T>` | `constructible_from<T, T>` + `convertible_to<T, T>` |
| `copy_constructible<T>` | `move_constructible` + constructible from `T&`, `const T&`, `const T` |
| `equality_comparable<T>` | `==` and `!=` yield `boolean-testable`, with equivalence-relation semantics |
| `equality_comparable_with<T, U>` | cross-type `==`, requires `common_reference_with` |
| `totally_ordered<T>` | `equality_comparable` + `<`, `>`, `<=`, `>=` forming a total order |
| `totally_ordered_with<T, U>` | cross-type version |
| `movable<T>` | `is_object_v` + `move_constructible` + `assignable_from<T&, T>` + `swappable` |
| `copyable<T>` | `movable` + `copy_constructible` + assignable from `T&`/`const T&`/`const T` |
| `semiregular<T>` | `copyable` + `default_initializable` |
| `regular<T>` | `semiregular` + `equality_comparable` — the "behaves like `int`" concept |
| `invocable<F, Args...>` | `std::invoke(f, args...)` is valid |
| `regular_invocable<F, Args...>` | same, **and** equality-preserving (a semantic promise the compiler cannot check) |
| `predicate<F, Args...>` | `regular_invocable` returning something `boolean-testable` |
| `relation<F, T, U>` | binary predicate over all four argument combinations |
| `equivalence_relation<F, T, U>` | `relation` + reflexive, symmetric, transitive |
| `strict_weak_order<F, T, U>` | `relation` + irreflexive, transitive, transitive incomparability — what `sort` demands |

Adjacent, in other headers: `std::three_way_comparable<T, Cat>` and `three_way_comparable_with<T, U, Cat>` (`<compare>`); `std::ranges::swap`, `std::ranges::equal_to`/`less`/`greater`/… (`<functional>`, constrained and heterogeneous, safe for pointer comparison).

### K.9 Iterator and range concepts by header

| Header | Concepts |
|---|---|
| `<iterator>` — foundational | `indirectly_readable`, `indirectly_writable`, `weakly_incrementable`, `incrementable`, `input_or_output_iterator`, `sentinel_for`, `sized_sentinel_for` |
| `<iterator>` — categories | `input_iterator`, `output_iterator`, `forward_iterator`, `bidirectional_iterator`, `random_access_iterator`, `contiguous_iterator` |
| `<iterator>` — indirect callables | `indirectly_unary_invocable`, `indirectly_regular_unary_invocable`, `indirect_unary_predicate`, `indirect_binary_predicate`, `indirect_equivalence_relation`, `indirect_strict_weak_order` |
| `<iterator>` — rearrangement | `indirectly_movable`, `indirectly_movable_storable`, `indirectly_copyable`, `indirectly_copyable_storable`, `indirectly_swappable`, `indirectly_comparable`, `permutable`, `mergeable`, `sortable` |
| `<ranges>` | `range`, `borrowed_range`, `sized_range`, `view`, `viewable_range`, `output_range`, `input_range`, `forward_range`, `bidirectional_range`, `random_access_range`, `contiguous_range`, `common_range`, `constant_range` (C++23) |

Full definitions and refinement order: `#appendix-h`.

### K.10 Writing constraints

```cpp
template<class T>
concept Price = std::is_arithmetic_v<T> && requires(T a, T b) {
    { a + b } -> std::same_as<T>;          // compound requirement: valid AND typed
    { a <=> b } -> std::convertible_to<std::partial_ordering>;
    typename T::tick_type;                 // type requirement (would fail for double)
    requires sizeof(T) <= 8;               // nested requirement: a bool expression
};

template<Price T> T mid(T a, T b);                     // constrained template parameter
template<class T> requires Price<T> T mid(T, T);       // requires clause
T mid(Price auto a, Price auto b);                     // abbreviated (two independent params!)
void f(auto&&...) requires (sizeof...(x) > 0);         // trailing requires clause
```

| Rule | Consequence |
|---|---|
| Subsumption compares *atomic constraints* syntactically | `std::integral<T>` subsumes nothing unless spelled identically; wrap traits in named concepts so overloads order correctly |
| Constraints are checked in order, short-circuiting `&&` / `\|\|` | Put the cheap, disqualifying check first |
| A `requires`-expression only checks **validity**, never semantics | `regular_invocable`'s equality preservation and `strict_weak_order`'s axioms are promises you must keep |
| Concepts improve diagnostics and overload selection, not codegen | A constrained template compiles to the same instructions as an unconstrained one |
| `requires requires` is legal and idiomatic | `template<class T> requires requires(T t) { t.size(); }` — a requires-clause whose expression is a requires-expression |

---

<a id="appendix-l"></a>
## Appendix L — Exception-safety checklist

**The four levels (an operation offers exactly one; document which)**

| Level | If the operation exits by exception | Typical carrier |
|---|---|---|
| No-throw (`noexcept`) | It does not exit by exception at all | Destructors, `swap`, move ops, `size`/`empty`, deallocation |
| Strong | Observable state is exactly as before the call; commit-or-rollback | `vector::push_back`, copy-and-swap assignment |
| Basic | All invariants hold, no resource leaks, but observable values may have changed | `vector::insert` on a throwing-copy `T`, most mutators |
| None | Nothing beyond what the language guarantees; object may be unusable | Rare and always a bug in library-quality code |

**Achieve**

1. Give every raw resource an owner whose destructor releases it, before you write a single `try`.
2. Acquire each resource in its own declaration statement, never two owners per `new` expression.
3. Perform every operation that can throw *before* mutating any observable state; make the mutation itself no-throw.
4. Implement the strong guarantee as copy-and-swap: build a complete new value, then `swap` (no-throw) and let the old value die.
5. Declare `swap` `noexcept` and implement it as member-wise `swap` of no-throw-swappable members only.
6. Mark move constructor and move assignment `noexcept` so `vector` relocation moves instead of copying (`std::move_if_noexcept`).
7. Never let a destructor exit by exception — destructors are implicitly `noexcept`, and throwing during unwinding calls `std::terminate`.
8. Catch, log, and swallow inside any destructor that performs work that can fail (`close`, `flush`, `rollback`), or expose an explicit `close()` for callers who want the error.
9. Do the throwing work of a two-phase mutation into a scratch object, then splice it in with no-throw moves/`swap`/pointer assignment.
10. Reserve capacity before a loop that must not fail midway, so the only remaining throw source is element construction.
11. Restore invariants on every early-exit path with RAII scope guards, not with `goto cleanup` or duplicated cleanup code.
12. Return `expected<T,E>`/`optional<T>` for expected failures and reserve exceptions for rare failures that must skip layers.
13. Make constructors either fully succeed or fully fail: a constructor that exits by exception never creates the object, so its destructor never runs, but every fully-constructed member and base *is* destroyed.
14. Initialize members in declaration order in the member-init list so partial construction unwinds exactly the constructed prefix.
15. Use delegating constructors rather than an `init()` method that leaves a legal-but-invalid state.
16. Keep generic code exception-*neutral*: let the element type's exceptions propagate unchanged, and guarantee only what `T`'s operations allow.
17. Assume in templates that `T`'s copy, move, comparison, hash, and destructor can throw unless a trait proves otherwise.
18. Query `std::is_nothrow_move_constructible_v<T>` / `is_nothrow_swappable_v<T>` when you need to *promise* strong safety generically, and downgrade to basic when the trait is false.
19. Never `throw` from a function declared `noexcept` — the call is not propagated, it is `std::terminate`.
20. Do not paper over a violated precondition with an exception: precondition violations are caller bugs and belong to assertion/fail-fast policy.
21. Keep `catch (...)` at exactly one place per thread/task boundary, and rethrow with bare `throw;` (never `throw e;`, which slices).
22. Catch polymorphic exception types by `const&`; catch by value only for trivially copyable status types you own.
23. Ensure no exception crosses a `thread` entry function, a C ABI boundary, a coroutine's `noexcept` machinery, or a callback registered with C code.
24. Give `operator=` the strong guarantee for free by writing it as `T& operator=(T rhs) { swap(*this, rhs); return *this; }` when copies are affordable.
25. Handle self-assignment and self-move by design (copy-and-swap is self-safe; a hand-written move assignment must be checked or made no-op-safe).
26. Release ownership only after the receiving container has taken it (`v.push_back(std::move(p)); p.release()` is backwards — move the `unique_ptr` and let it null itself).
27. Prefer `make_unique`/`make_shared` so argument evaluation order can never leak a raw allocation.
28. Treat `vector::push_back` of a type with a throwing move as strong-but-expensive: it copies; fix the type, not the call site.
29. Decide and document what `operator new` failure means for the hot path — most latency-critical systems preallocate and treat `bad_alloc` as fatal.
30. Record the guarantee in the declaration's comment or contract; an undocumented guarantee is "none".

**Verify**

31. Read every function top-to-bottom and mark the first statement that mutates observable state; everything that can throw must be above it.
32. List every operation in the body that can throw (allocation, copy, `T` construction, container growth, `at`, `stoi`, formatting, virtual calls) and prove each is either above the commit point or `noexcept`.
33. Compile with a throwing-allocator or fault-injecting test allocator and assert the object's invariants after each injected failure.
34. Write a `ThrowOnNth<T>` element type and run the operation N times, throwing at each successive throw site, checking invariants and value equality after every run.
35. Run the same test under ASan+LSan to prove no leak on any unwinding path.
36. Assert `static_assert(std::is_nothrow_move_constructible_v<T>)` for every type stored in a `vector` on the hot path.
37. Check that `noexcept(f(args))` is `true` for functions you believe are no-throw, instead of trusting the declaration site.
38. Grep for `catch` blocks that discard the exception without restoring an invariant or logging.
39. Confirm the destructor of every RAII type in the codebase is `noexcept` (it is by default — confirm nothing inside it throws).
40. Review each `try`/`catch` for whether the handler can make a *decision*; if not, delete it and let the exception propagate.

---

<a id="appendix-m"></a>
## Appendix M — Lifetime and ownership checklist

**Ownership model per handle**

| Handle | Owns | Nullable | Cost | Use when |
|---|---|---|---|---|
| Value member / `array` | Yes, exclusively | No | None | Lifetime is the enclosing object's |
| `unique_ptr<T>` | Yes, exclusively | Yes | One pointer (stateless deleter) | Polymorphic or heap-allocated exclusive resource |
| `shared_ptr<T>` | Yes, shared | Yes | 2 pointers + atomic control block | Genuinely unknown last owner |
| `weak_ptr<T>` | No (observes) | Yes | 2 pointers + `lock()` atomics | Break cycles, cached observers |
| `T&` / `T*` | No | ref: no, ptr: yes | Free | Non-owning parameter or short-lived observer |
| `span<T>` / `string_view` | No | Empty, not null | Pointer + size | Borrowed contiguous range within a known lifetime |
| Index + generation | No (arena owns) | Sentinel | 4–8 bytes | Stable handles across relocation, no allocation |

**Checklist**

1. Name exactly one owner for every resource, and write it in the type — a raw pointer is never an owner.
2. Prefer a value member over any pointer; prefer `unique_ptr` over `shared_ptr`; use `shared_ptr` only when the last owner is genuinely unknown at compile time.
3. Pass ownership as `unique_ptr<T>` by value, share ownership as `shared_ptr<T>` by value, and observe with `T&`, `T const&`, `T*`, or `span`.
4. Do not pass `shared_ptr const&` when the callee only observes — take `T&` and keep the refcount out of the call.
5. Take `shared_ptr` **by value** in any callee that may outlive the caller's copy (async, thread, coroutine).
6. Break every ownership cycle with `weak_ptr` on the back edge; a cycle is a leak that LSan will not report.
7. Use `make_unique`/`make_shared` for allocation; use `shared_ptr(new T)` only when a control block adjacent to a large object would delay its memory release.
8. Give every polymorphic base either a public virtual destructor or a protected non-virtual one; deleting through a non-virtual base pointer is UB.
9. Match every allocation form with its deallocation form: `new`/`delete`, `new[]`/`delete[]`, `unique_ptr<T[]>` for arrays, custom deleter for C APIs.
10. Wrap every C-API resource in a `unique_ptr<T, Deleter>` or a small RAII type at the boundary, and never pass raw handles around internally.
11. Declare `Rule of Zero` by default; if you write any of destructor, copy ctor, copy assign, move ctor, move assign, write or `= delete` all five (Rule of Five).
12. Remember a user-declared destructor suppresses implicit move operations, silently turning moves into copies.
13. Mark move operations `noexcept` and leave the moved-from object in a valid, self-consistent, destructible state.
14. Never read a moved-from object's value; only assign to it, `clear()` it, or destroy it.
15. Do not return a reference or pointer to a local, a temporary, or a by-value parameter.
16. Do not store `string_view`/`span` in a class member unless the class documents that its referent outlives it.
17. Watch the dangling-`string_view` classics: `sv = std::string(...)`, `sv = ret_by_value()`, `sv = map[key].substr()` — each binds to a temporary that dies at the semicolon.
18. Remember a reference bound to a temporary in a member-init list does **not** get lifetime extension; only a local `const&`/`&&` binding does, and only for the immediate temporary.
19. Assume lifetime extension does not cross a function return, a chained call on a temporary, or an implicit conversion through a helper.
20. Do not hold a pointer or reference into a `vector` across any operation that can reallocate; store an index instead.
21. Re-derive iterators after any container mutation, and consult the invalidation matrix (`#appendix-G`) rather than intuition.
22. Never bind a lambda's reference capture (`[&]`) to state that outlives the lambda — for anything stored, queued, or detached, capture by value or by `shared_ptr`.
23. Capture `this` explicitly and audit it: `[=]` in a member function captures `this` by pointer, not the object (deprecated form in C++20).
24. Prefer `[self = shared_from_this()]` for asynchronous member callbacks, and guarantee the object is already owned by a `shared_ptr` before calling `shared_from_this()`.
25. Ensure coroutine frames outlive every reference they hold: parameters are copied into the frame, but references and views passed in are not.
26. Do not pass a temporary into a coroutine or a lazy view pipeline that is consumed after the full expression ends.
27. Join or `stop()`+join every thread before any object it references is destroyed; `jthread` requests stop and joins in its destructor, but only if declared *after* the state it uses.
28. Order members so that dependents are declared after dependencies — destruction runs in reverse declaration order.
29. Avoid non-trivial destruction order across translation units; prefer function-local statics (thread-safe, lazily initialized) over namespace-scope objects.
30. Use `constinit` for globals that must have no dynamic initialization, and never rely on the static initialization order of another TU.
31. Never touch an object before its constructor completes or after its destructor begins — including through a callback registered inside the constructor.
32. Do not call virtual functions from a constructor or destructor expecting derived behavior; a pure-virtual call there is UB.
33. Begin an object's lifetime explicitly in raw storage: placement `new`, `std::construct_at`, or (C++23) `std::start_lifetime_as` for implicit-lifetime types.
34. End it explicitly with `std::destroy_at`/explicit destructor call before reusing the storage, and once per object.
35. Use `std::launder` after reusing storage where the compiler could otherwise assume the old object's constness or vtable.
36. Do not `memcpy` into or out of a non-trivially-copyable object, and do not `memcpy` an object whose lifetime has not begun.
37. Reserve pool slots with a generation counter so a stale handle is detected rather than silently aliasing a recycled object.
38. Have every arena/pool assert at shutdown that its checked-out count is zero and that all live destructors ran.
39. Treat `shared_ptr`'s refcount as thread-safe and its pointee as not; the control block is atomic, `*p` is not.
40. Use `atomic<shared_ptr<T>>` (C++20) or a hazard-pointer/RCU scheme (`#ch31`) when publishers replace a pointer that readers may be dereferencing.
41. Do not `delete` a pointer obtained from an arena, `malloc`, `new[]`, or a different allocator instance.
42. Verify every ownership change under ASan (use-after-free, use-after-scope), LSan (leaks), and a stress test that destroys objects in adversarial order.

---

<a id="appendix-n"></a>
## Appendix N — Allocation and hot-path audit checklist

**Order-of-magnitude budget (typical modern server core; measure your own)**

| Event | Typical cost |
|---|---|
| L1 hit / correctly predicted branch | ~1 ns / ~0 |
| L2 hit | ~3–4 ns |
| L3 hit | ~10–20 ns |
| DRAM access | ~60–100 ns |
| Branch mispredict | ~15–20 cycles |
| Uncontended `malloc`/`free` round trip | ~20–100 ns |
| Uncontended mutex lock/unlock | ~20 ns |
| Contended mutex (futex sleep + wake) | µs–ms |
| Syscall (`clock_gettime` via vDSO / real syscall) | ~20 ns / ~100 ns–1 µs |
| Page fault (minor / major) | ~1 µs / ms |
| Cache-line ping-pong between cores | ~40–100 ns per transfer |

**Define the path**

1. Write down the exact entry and exit points of the latency-critical path before auditing anything.
2. State the target percentile (p50/p99/p99.9) — jitter sources, not average cost, dominate tail latency.
3. Separate the hot path from setup, teardown, logging, and error paths, and allow allocation only outside it.
4. Enumerate every function the path calls transitively, including library and template-instantiated code.

**Find allocations**

5. Override global `operator new`/`operator delete` to abort (or increment a counter) and assert zero allocations across the measured window.
6. Add a per-thread `no_alloc_scope` guard that trips in tests when the path allocates.
7. Trace with `ltrace`/`perf probe`/`bpftrace` on `malloc`, `operator new`, `mmap`, and `brk` during a replay.
8. Grep the path for the allocating vocabulary: `new`, `make_shared`, `make_unique`, `std::string`, `std::function`, `std::vector` growth, `push_back` without `reserve`, `to_string`, `format`, `ostringstream`, `regex`, `any`, `variant` with heap alternatives, `packaged_task`, `promise`/`future`, `thread` creation, `shared_ptr` copies of non-existing control blocks.
9. Check every `std::function` on the path — it allocates when the callable exceeds SBO or is not nothrow-move-constructible; replace with a function reference, a template parameter, an `inplace_function`, or `move_only_function` (C++23, still not guaranteed SBO).
10. Check every `std::string` on the path — short-string optimization covers ~15 chars on libstdc++/libc++; anything longer allocates.
11. Confirm `reserve()` is called once, outside the loop, with a proven bound — never `reserve(size()+1)` inside a loop (quadratic relocation).
12. Replace node containers (`map`, `set`, `list`, `unordered_*`) on the path with flat sorted vectors, open-addressed tables, or index-linked arenas.
13. Ensure `unordered_map` never rehashes on the path: `reserve(n)` up front and confirm `max_load_factor` and bucket count afterwards.
14. Replace dynamic strings with `string_view`, fixed `char` arrays, or `std::to_chars` into a caller-supplied buffer.
15. Route unavoidable per-message allocation through a `monotonic_buffer_resource` over a stack/static buffer, reset once per cycle.
16. Preallocate every pool, ring, and arena at startup, size them to a proven worst case, and define an explicit exhaustion policy.
17. Touch (first-write) all preallocated memory at startup so no minor page fault occurs on the path.
18. Use huge pages and `mlockall(MCL_CURRENT|MCL_FUTURE)` where the platform allows, to remove TLB misses and page-fault jitter.
19. Verify moves actually move: `static_assert(std::is_nothrow_move_constructible_v<T>)` for every element type stored in a growing container.
20. Check for hidden copies — range-for over `auto` instead of `auto const&`, a `const&` parameter that binds a converted temporary, a lambda captured by value into `std::function`.

**Find locks and contention**

21. List every mutex, `shared_mutex`, `condition_variable`, and atomic RMW touched by the path.
22. Replace shared mutable state with per-thread state plus explicit publication; a lock you never take costs nothing.
23. Convert reader/writer sharing into a single-writer, multi-reader snapshot (seqlock, RCU-style publish, double buffer) — see `#ch40`.
24. Use a bounded SPSC ring (`#ch36`) for producer/consumer handoff instead of a mutex-protected queue.
25. Ensure every producer/consumer index pair lives on separate cache lines (`alignas(std::hardware_destructive_interference_size)`).
26. Eliminate false sharing: audit every struct whose fields are written by different threads, and pad the write set.
27. Prefer release/acquire on a single flag to a lock; do not "optimize" it to relaxed without a proven publication edge.
28. Remove atomic RMW (`fetch_add`, CAS) from the fast path where a load/store pair with the right ordering suffices.
29. Avoid `shared_ptr` copy/destruction on the path — each is an atomic increment/decrement on a shared cache line.
30. Never allocate, log, take a lock, or call `malloc` while holding a lock that a hot path can also want.
31. If a lock must stay, bound its critical section to a few instructions and measure the contended case, not the uncontended one.
32. Pin threads to cores, isolate those cores (`isolcpus`/`nohz_full`), and avoid oversubscription so the scheduler never preempts the path.
33. Do not spin without `_mm_pause`/`std::this_thread::yield` backoff, and never spin on a core shared with the producer.

**Find syscalls and kernel transitions**

34. `strace -c -f` (or `perf trace`) a replay and require an empty syscall count in the steady-state window.
35. Remove all I/O from the path: no `write`, no `printf`, no `ostream`, no file logging — push records into a ring and drain on another thread (`#ch42`).
36. Replace `std::chrono::system_clock::now()` in inner loops with `rdtsc`/`steady_clock` reads that are known to use the vDSO, and cache the timestamp per batch.
37. Eliminate blocking calls: `poll`/`epoll_wait` with a timeout, `futex` waits, `condition_variable::wait`, `sleep`, and dynamic-library lazy binding (`-Wl,-z,now`).
38. Use busy-polling or kernel-bypass receive (`SO_BUSY_POLL`, `AF_XDP`, user-space NIC stacks) when the wakeup latency dominates.
39. Preallocate and pre-fault socket buffers, and avoid `mmap`/`munmap`/`madvise` during steady state.
40. Ensure no exception is thrown on the path — the first throw touches the unwind tables, may take a global lock, and can allocate.
41. Ensure no lazy initialization on the path: no function-local static's guard variable, no first-use table build, no `std::call_once`.

**Find branch mispredictions and stalls**

42. Measure first: `perf stat -e branches,branch-misses,cache-misses,LLC-load-misses,cycles,instructions,stalled-cycles-backend`.
43. Attribute misses to source with `perf record -e branch-misses:pp` and `perf annotate` before changing any code.
44. Hoist loop-invariant and configuration branches out of the loop; specialize with a template parameter or two loops instead of a per-iteration `if`.
45. Convert unpredictable data-dependent branches into branchless arithmetic (`std::min`/`max`, masks, conditional move) — only where the profile shows misses.
46. Do not use `[[likely]]`/`[[unlikely]]` as a substitute for measurement; use them only for genuinely rare paths (error, resize, wrap-around).
47. Move cold work (error handling, logging, resize, rehash) into `[[gnu::noinline, gnu::cold]]` functions so the hot path's I-cache footprint shrinks.
48. Replace virtual dispatch on the path with a template, a `variant` + `visit`, a function pointer that is stable, or type-partitioned batches.
49. Batch homogeneous work so each branch resolves the same way for many iterations.
50. Sort or partition input by type/branch outcome before the loop when the ordering is free.
51. Lay out data structure-of-arrays when the loop touches a subset of fields; count the bytes per cache line actually used.
52. Keep the hot working set within L1/L2; shrink types (indices instead of pointers, `int32_t` instead of `int64_t`, bitfields for flags).
53. Align hot structures to a cache line and ensure no hot object straddles two lines.
54. Use `__builtin_prefetch` only with a measured distance, and only when the access pattern is predictable but not already prefetched by hardware.
55. Check for aliasing that blocks vectorization: use `__restrict`, local copies of members, or `span` with distinct provenance.
56. Verify the generated code (`objdump -d`, Compiler Explorer) for the actual hot function — confirm inlining, no unexpected call, no stack spill, no `memcpy` for a "move".

**Verify**

57. Measure with a fixed replay input, pinned cores, disabled turbo/frequency scaling, and a warmed cache; report percentiles, not means.
58. Report p50/p99/p99.9/max and the histogram; a mean improvement with worse tails is a regression.
59. Compare against a recorded baseline in CI and fail on tail regressions.
60. Re-run the allocation, syscall, and lock assertions as tests, not as a one-time audit — they regress silently.

---

<a id="appendix-o"></a>
## Appendix O — Undefined-behavior field guide

Legend for **Detector**: UBSan = `-fsanitize=undefined` (sub-check named), ASan = `-fsanitize=address`, MSan = `-fsanitize=memory`, TSan = `-fsanitize=thread`, LSan = leaks, Warn = compiler warning/static analysis, Hard = generally not caught by any standard tool.

### O.1 Arithmetic and conversions

| Category | What it is | Minimal example | How it bites | Detector |
|---|---|---|---|---|
| Signed integer overflow | Result outside the signed type's range | `int x = INT_MAX; ++x;` | Compiler assumes it cannot happen: `x+1 > x` folds to `true`, loop bounds vanish | UBSan `signed-integer-overflow` |
| Division by zero | Integer `/` or `%` with zero divisor | `int q = a / 0;` | SIGFPE, or an optimizer-inferred impossible path | UBSan `integer-divide-by-zero` |
| `INT_MIN / -1`, `INT_MIN % -1` | Quotient not representable | `int q = INT_MIN / -1;` | SIGFPE on x86 (`idiv` traps) | UBSan `signed-integer-overflow` |
| Shift count out of range | Count negative or ≥ operand width | `1u << 32` on 32-bit `unsigned` | x86 masks to `& 31` → silently wrong; other ISAs differ | UBSan `shift-exponent` |
| Shift of a negative value | Left-shifting a negative signed value | `-1 << 1` | UB pre-C++20; **defined since C++20** (two's complement) | UBSan `shift-base` (pre-C++20) |
| Float→integer out of range | Truncated value not representable in the target | `int i = 1e30;` | Garbage value, or `INT_MIN` sentinel from `cvttsd2si` | UBSan `float-cast-overflow` |
| Invalid enum value | Storing a value outside a scoped/fixed-range enum's value range | `auto e = static_cast<Color>(99);` | `switch` with no `default` falls through to an assumed-impossible path | UBSan `enum` |
| Invalid `bool` | A `bool` object holding a byte other than 0/1 | `bool b; memcpy(&b, &byte2, 1);` | `if (b)` and `if (!b)` can both be false | UBSan `bool` |
| Unsigned wrap (**not UB**) | Modulo-2ⁿ arithmetic | `0u - 1u == UINT_MAX` | Defined, but `i - 1 >= 0` is always true for unsigned — a logic bug, not UB | Warn `-Wsign-compare` |
| Narrowing conversion (**not UB**) | Value out of destination range | `int i = -1; unsigned u = i;` | Defined conversion, wrong answer; ill-formed only in braced init | Warn `-Wconversion` |

### O.2 Pointers, memory, and bounds

| Category | What it is | Minimal example | How it bites | Detector |
|---|---|---|---|---|
| Null dereference | Reading/writing through a null pointer | `int* p = nullptr; *p = 1;` | Segfault, or the compiler deletes a later null check because deref implies non-null | UBSan `null`, ASan |
| Out-of-bounds array/heap access | Index or pointer outside the object | `int a[4]; a[4] = 0;` | Adjacent-object corruption, stack smashing | ASan; UBSan `array-bounds` for known extents |
| `vector::operator[]` out of range | Precondition violation, no check required | `v[v.size()]` | Reads past the live range; `at()` would have thrown | ASan; libstdc++/libc++ hardening |
| Pointer arithmetic outside `[begin, end]` | Forming a pointer more than one past the end | `p = a + 5;` for `int a[4]` | Legal-looking pointer the optimizer assumes is in range | UBSan `pointer-overflow` |
| Dereferencing one-past-the-end | `*end()` or `*(a+n)` | `*v.end()` | Reads padding/other object; iterator debug catches it | ASan; library debug mode |
| Use after free | Access through a pointer to released storage | `delete p; *p = 1;` | Reads recycled data; exploitable | ASan `heap-use-after-free` |
| Use after scope / after return | Access to a dead automatic object | `int* f(){ int x=0; return &x; }` | Stack slot reused by the next call | ASan `stack-use-after-scope/return`, Warn `-Wreturn-local-addr` |
| Dangling reference from container growth | Pointer/reference held across reallocation | `int& r = v[0]; v.push_back(1); r=2;` | Silent corruption; see `#appendix-G` | ASan |
| Dangling `string_view` / `span` | View outlives its owner | `std::string_view sv = std::string("x");` | Temporary dies at the semicolon | ASan, Warn `-Wdangling-gsl` |
| Double free / invalid free | Freeing twice or freeing a non-heap pointer | `delete p; delete p;` | Allocator metadata corruption | ASan |
| `new`/`delete` form mismatch | `delete` on `new[]`, `free` on `new` | `delete new int[4];` | Heap corruption; array cookie mishandled | ASan `alloc-dealloc-mismatch` |
| Delete via non-virtual base | Destroying a derived object through a base pointer without a virtual destructor | `Base* b = new Derived; delete b;` | Derived destructor never runs; wrong size to `operator delete` | Warn `-Wdelete-non-virtual-dtor` |
| Misaligned access | Object accessed through an insufficiently aligned pointer | `*reinterpret_cast<uint32_t*>(bytes+1)` | Trap on strict-alignment ISAs, torn atomics, missed vectorization | UBSan `alignment` |
| Uninitialized read | Reading an object with an indeterminate value | `int x; return x;` | Values vary by build; used as an "any value" assumption by the optimizer | MSan; Warn `-Wuninitialized` |
| Reading padding as data | Comparing/serializing padding bytes | `memcmp(&a,&b,sizeof a)` on a padded struct | Two equal objects compare unequal | MSan |
| Object lifetime not begun | Using storage as `T` without starting a lifetime | `T* p=(T*)malloc(sizeof(T)); p->x=1;` for non-implicit-lifetime `T` | Works today, breaks with new optimizations; use placement `new`/`construct_at`/`start_lifetime_as` (C++23) | Hard |
| Access after lifetime ends | Using an object after its destructor ran | `p->~T(); p->x = 1;` | Vtable already invalid | ASan (heap), otherwise Hard |
| Missing `std::launder` after storage reuse | Old pointer reused for a new object with const/reference members or a vtable | reuse of `T` in the same buffer | Optimizer reuses the old value/vptr | Hard |
| Modifying a `const` object | Casting away const on an actually-const object | `const int c=1; *const_cast<int*>(&c)=2;` | Object may live in `.rodata`; optimizer propagates `1` | Hard (Warn on obvious cases) |
| Modifying a string literal | Writing through `char*` to a literal | `char* s="hi"; s[0]='H';` | Ill-formed in C++11+; segfault in `.rodata` | Warn `-Wwrite-strings` |
| Strict-aliasing violation | Accessing an object through an unrelated type | `float f; int i = *(int*)&f;` | Loads reordered around stores; wrong values at `-O2` only | Warn `-Wstrict-aliasing` (weak); use `memcpy`/`bit_cast` |
| Reading an inactive union member | Type punning through a union | `union{float f; int i;} u; u.f=1; use(u.i);` | UB in C++ (allowed in C); common-initial-sequence rule is the only exception | Hard |
| Invalid `static_cast` downcast | Casting to a type the object is not | `static_cast<D*>(base_ptr)` when it is not a `D` | Wrong offsets/vtable; `dynamic_cast` would have returned null | Hard (use `dynamic_cast` in debug) |
| Invalid function-pointer cast + call | Calling through an incompatible function type | `((void(*)(int))f)(1)` where `f` takes `double` | Argument registers mismatched; CFI trap | UBSan `function` (Clang) |
| `memcpy` with overlapping ranges | Source and destination overlap | `memcpy(p, p+1, n)` | Silent corruption for large `n`; use `memmove` | ASan (partially), Warn |
| Null passed to `memcpy`/`memcmp` with size 0 | Library precondition is non-null pointers | `memcpy(nullptr, nullptr, 0)` | Compiler infers pointers are non-null and deletes later checks | UBSan `nonnull-attribute` |
| Bad `alignof`/`operator new` alignment | Over-aligned type allocated by non-aligned `new` (pre-C++17) | `new alignas(64) T` on C++14 | Misaligned SIMD loads | UBSan `alignment` |

### O.3 Control flow, functions, and objects

| Category | What it is | Minimal example | How it bites | Detector |
|---|---|---|---|---|
| Falling off a value-returning function | Reaching `}` without `return` | `int f(bool b){ if(b) return 1; }` | Whatever is in the return register; the optimizer may delete the whole path | UBSan `return`, Warn `-Wreturn-type` |
| Reaching `std::unreachable()` | Executing a path declared impossible | `default: std::unreachable();` on untrusted input | Arbitrary jump; never use for input validation | UBSan `unreachable` |
| Violated `[[assume(expr)]]` (C++23) | Assumption is false at runtime | `[[assume(i > 0)]]` with `i == 0` | Same as `unreachable`; the expression is not evaluated | Hard |
| Infinite loop with no side effect | Loop without I/O, atomic, volatile, or sync | `while(true){}` | Forward-progress guarantee lets the compiler delete or fall through it | Hard |
| Recursion into a function-local static's initialization | Re-entering initialization of the same static | recursive `init()` returning a local `static` | Deadlock or UB (implementation may detect) | Hard |
| Calling a virtual before construction / after destruction | Virtual dispatch during base ctor/dtor | virtual call in base ctor | Base version runs (defined); a pure virtual call is UB → `__cxa_pure_virtual` | Warn; runtime abort |
| Throwing from a `noexcept` function | Exception escapes a `noexcept` boundary | `void f() noexcept { throw 1; }` | `std::terminate` (defined, not UB) — still fatal | Warn `-Wterminate` |
| Exception escaping a destructor during unwinding | Second exception while unwinding | throwing `~T()` | `std::terminate` | Warn `-Wterminate` |
| Exception escaping `main`/thread entry/C callback | No handler | uncaught in `std::thread` body | `std::terminate` | Runtime |
| Unsequenced modification | Two unsequenced side effects on one object | `i++ + i++` | Any result; still UB in C++17/20/23 | UBSan (partial), Warn `-Wsequence-point`/`-Wunsequenced` |
| `i = i++` | Modification vs. value computation ordering | `i = i++;` | UB before C++17; **defined since C++17** (right operand sequenced before left) | Warn |
| ODR violation | Two different definitions of one entity across TUs | class with different members under different `#define`s | Linker picks one; silent layout mismatch, crashes far from the cause | Hard (LTO/gold `-Wodr` sometimes) |
| Mixed ABI/config across TUs | Debug-iterator or `_GLIBCXX_ASSERTIONS` mismatch | one TU with library debug mode | Different container layout at a call boundary | Hard |
| Mismatched iterators | Iterators from different containers, or an invalidated one | `std::sort(a.begin(), b.end())` | Runs off the end | Library debug mode, ASan |
| Broken strict weak ordering | Comparator that is not irreflexive/transitive | `[](a,b){return a<=b;}` in `std::sort` | Reads out of bounds inside the sort itself | libstdc++ debug mode, ASan |
| Inconsistent hash/equality | `==` says equal, `hash` disagrees (or a mutated key) | mutating a key inside a `set`/map node | Lookup misses, invariants break | Hard |
| Self-move / self-assign misuse | Hand-written move-assign that frees then copies | `a = std::move(a);` | Use after free; self-move leaves a *valid but unspecified* state, not UB by the standard | ASan |
| Placement `new` into too-small/misaligned storage | Storage does not satisfy size/alignment | `new (buf) T` with `sizeof(buf) < sizeof(T)` | Overwrites neighbors | ASan |
| Infinite mutual recursion / stack overflow | Exceeding the stack | deep recursion | Guard-page fault; not diagnosed as UB | ASan (partially), stack probes |
| `va_arg` with the wrong type | Variadic argument type mismatch | `printf("%d", 1.0)` | Reads the wrong register/slot | Warn `-Wformat` |

### O.4 Concurrency

| Category | What it is | Minimal example | How it bites | Detector |
|---|---|---|---|---|
| Data race | Two potentially concurrent conflicting accesses to one memory location, ≥1 non-atomic, no happens-before | `int g; t1: g=1; t2: read(g);` | Torn/stale values; whole-program UB, not just a wrong value | TSan |
| Insufficient memory order | Publication with `relaxed` on both sides | `ready.store(true, relaxed)` after `payload = 42` | Reader sees the flag but not the payload | TSan (often), review |
| Non-atomic `shared_ptr` pointee access | Refcount is atomic, pointee is not | two threads writing `*sp` | Race on the object, not the count | TSan |
| Unsynchronized library object | Concurrent non-const access to one container/stream | two threads `push_back` on one `vector` | Corruption; see `#appendix-I` | TSan |
| Missing `join`/`detach` before destruction | `std::thread` destroyed while joinable | thread object goes out of scope | `std::terminate` (defined) — `jthread` joins instead | Runtime |
| Object destroyed while a thread uses it | Lifetime shorter than the thread's reference | `[&]` capture into a detached thread | Use after free across threads | ASan + TSan |
| Deadlock / lock-order inversion | Two locks taken in opposite orders | `A→B` in one thread, `B→A` in another | Hang, not UB — invisible to sanitizers except TSan's deadlock detector | TSan (deadlock detector), review |
| Recursive lock of a non-recursive mutex | `lock()` twice on the same `std::mutex` | nested call locks again | UB (typically deadlock) | TSan |
| Unlocking a mutex not owned | `unlock()` from the wrong thread | manual unlock | UB | TSan |
| Condition-variable wait without a predicate | Spurious wakeup or lost wakeup | `cv.wait(lk)` with no loop | Proceeds without the condition, or sleeps forever | Review |
| `volatile` used for synchronization | Volatile gives no ordering or atomicity | `volatile bool done;` | Torn/reordered access; use `std::atomic` | TSan |
| Atomic on a non-lock-free/misaligned type | Assuming lock-freedom | large `std::atomic<T>` | Silent internal lock; check `is_always_lock_free` | Static check |

---

<a id="appendix-p"></a>
## Appendix P — C++11–C++23 feature chronology

### P.0 One-line summary per standard

| Standard | `__cplusplus` | Language headline | Library headline |
|---|---|---|---|
| C++11 | `201103L` | Move semantics, lambdas, variadic templates, `constexpr`, `noexcept`, `enum class` | Threads, atomics + memory model, smart pointers, `unordered_*`, `<chrono>`, type traits |
| C++14 | `201402L` | Generic lambdas, init-capture, return-type deduction, relaxed `constexpr`, variable templates | `make_unique`, `shared_timed_mutex`, `integer_sequence`, transparent comparators |
| C++17 | `201703L` | Structured bindings, `if constexpr`, fold expressions, CTAD, guaranteed copy elision | `optional`/`variant`/`any`, `string_view`, `filesystem`, PMR, `charconv`, parallel algorithms |
| C++20 | `202002L` | Concepts, coroutines, modules, `<=>`, designated initializers, `consteval`/`constinit` | Ranges, `span`, `format`, `<bit>`, `jthread`/`stop_token`, latches/barriers/semaphores, atomic wait |
| C++23 | `202302L` | Deducing `this`, `if consteval`, static/multidim `operator[]`, `auto(x)`, `[[assume]]` | `expected`, `mdspan`, `print`, `stacktrace`, `flat_map`, `generator`, `move_only_function`, `ranges::to` |

### P.1 C++11 — language

| Feature | One-line recall |
|---|---|
| Rvalue references, move ctor/assign | Transfer resources instead of copying; `std::move` is a cast to `T&&` |
| Reference qualifiers on members (`&`, `&&`) | Overload a member on the value category of `*this` |
| Perfect forwarding (`T&&` + reference collapsing) | One template forwards value category to the callee |
| Variadic templates and packs | Type-safe arbitrary arity; `sizeof...` |
| Lambdas with captures | Anonymous closure types; `[=]`, `[&]`, `[x]`, mutable |
| `auto`, `decltype`, trailing return type | Deduce and query types |
| Range-based `for` | Iterate any range with `begin`/`end` |
| `constexpr` (single-return functions) | Compile-time-evaluable functions and objects |
| `noexcept` operator and specifier | Non-throwing contract usable in overload resolution and traits |
| `= default`, `= delete` | Explicit special-member intent |
| `override`, `final` | Checked overriding; devirtualization hint |
| Scoped enums (`enum class`), fixed underlying type | No implicit conversion, no name leakage |
| `nullptr`, `std::nullptr_t` | Typed null pointer literal |
| Uniform/list initialization, `initializer_list` | Brace init with narrowing diagnostics; init-list ctor wins over others |
| Delegating and inheriting constructors | `T(): T(0) {}`, `using Base::Base;` |
| Non-static data member initializers | Default member values in the class body |
| `alignas`, `alignof` | Standard alignment control and query |
| `thread_local` | Per-thread storage duration |
| `static_assert(cond, msg)` | Compile-time assertion |
| Alias templates (`using X = ...`) | Templated typedefs |
| User-defined literals | `42_ticks` |
| Attributes `[[noreturn]]`, `[[carries_dependency]]` | Standard attribute syntax introduced |
| Unrestricted unions, explicit conversion operators | Non-trivial union members; `explicit operator bool()` |
| Raw string literals, `char16_t`/`char32_t`, `u8""` | Text and Unicode literal forms |
| `long long`, `>>` in templates, extern templates | Assorted core cleanups |
| Standard memory model (`<atomic>` semantics) | Defines data races, happens-before, and orderings |

### P.1b C++11 — library

| Facility | Header | Recall |
|---|---|---|
| `unique_ptr`, `shared_ptr`, `weak_ptr` | `<memory>` | RAII ownership; `make_shared` (no `make_unique` until C++14) |
| `thread`, `mutex`, `lock_guard`, `unique_lock`, `condition_variable` | `<thread>`, `<mutex>`, `<condition_variable>` | Portable threading |
| `future`, `promise`, `packaged_task`, `async` | `<future>` | One-shot asynchronous results |
| `atomic<T>`, `atomic_flag`, `memory_order` | `<atomic>` | Lock-free primitives and ordering |
| `unordered_map/set/multimap/multiset` | `<unordered_map>`, `<unordered_set>` | Hash containers |
| `array`, `forward_list`, `tuple` | `<array>`, `<forward_list>`, `<tuple>` | Fixed array, singly linked list, heterogeneous pack |
| `<chrono>` | `<chrono>` | `duration`, `time_point`, `steady_clock`, `system_clock`, `high_resolution_clock` |
| `<random>` | `<random>` | Engines + distributions replacing `rand()` |
| `<type_traits>`, `<ratio>` | | Compile-time type queries; compile-time rationals |
| `function`, `bind`, `reference_wrapper`, `ref`/`cref` | `<functional>` | Type-erased callables and references |
| `<regex>`, `<system_error>` | | Regular expressions; `error_code`/`error_condition` |
| `emplace*`, `move_iterator`, `allocator_traits` | | Move-aware containers and allocators |
| `to_string`, `stoi`/`stod` family | `<string>` | Numeric/string conversions (locale-aware, allocating) |

### P.2 C++14

| Kind | Feature | Recall |
|---|---|---|
| Lang | Generic lambdas | `[](auto const& x){...}` — templated `operator()` |
| Lang | Lambda init-capture | `[p = std::move(p)]` enables move capture |
| Lang | Return type deduction for normal functions | `auto f() { return x; }` |
| Lang | `decltype(auto)` | Exact deduction preserving references |
| Lang | Relaxed `constexpr` | Loops, locals, multiple statements |
| Lang | Variable templates | `template<class T> constexpr T pi_v = ...` |
| Lang | Binary literals, digit separators | `0b1011`, `1'000'000` |
| Lang | `[[deprecated]]` | Standard deprecation attribute |
| Lang | Sized deallocation | `operator delete(void*, size_t)` |
| Lib | `std::make_unique` | Exception-safe `unique_ptr` factory |
| Lib | `shared_timed_mutex`, `shared_lock` | Reader/writer locking |
| Lib | `integer_sequence`, `index_sequence` | Compile-time index packs for pack expansion |
| Lib | Transparent comparators `less<>`, `greater<>` | Heterogeneous lookup in ordered containers |
| Lib | `get<T>(tuple)` | Address a tuple element by unique type |
| Lib | `exchange`, `quoted`, `cbegin`/`cend` free functions | Small utilities |
| Lib | `_t`/`_v`-style trait aliases (`enable_if_t`, …) | Alias forms of C++11 traits |
| Lib | `chrono`/`string` UDLs (`10ms`, `"x"s`) | Typed literals |

### P.3 C++17

| Kind | Feature | Recall |
|---|---|---|
| Lang | Structured bindings | `auto [a, b] = pair;` over tuple-like, arrays, public members |
| Lang | `if constexpr` | Discards the untaken branch during instantiation |
| Lang | Init-statement in `if`/`switch` | `if (auto it = m.find(k); it != m.end())` |
| Lang | Fold expressions | `(xs + ...)`, `(... , f(xs))` |
| Lang | Class template argument deduction (CTAD) + deduction guides | `std::pair p{1, 2.0}` |
| Lang | Inline variables | ODR-safe header-defined variables/static members |
| Lang | Guaranteed copy elision for prvalues | Result constructed directly; no move required |
| Lang | `constexpr` lambdas, `*this` capture | `[*this]` copies the object |
| Lang | `template<auto>` non-type parameters | Deduce the NTTP's type |
| Lang | `noexcept` part of the function type | Affects pointer conversions and overloads |
| Lang | Over-aligned `new`/`delete` | `operator new(size_t, align_val_t)` |
| Lang | Nested namespace definition `a::b::c` | Shorter namespace nesting |
| Lang | `[[nodiscard]]`, `[[maybe_unused]]`, `[[fallthrough]]` | Standard attributes |
| Lang | `__has_include`, `static_assert(cond)` without message | Portability and brevity |
| Lang | Stricter expression evaluation order | Operands of `<<`, `[]`, `.`, assignment sequenced |
| Lang | Removed: `auto_ptr`, `register`, trigraphs, dynamic exception specifications | Cleanup |
| Lib | `optional<T>` | Present/absent value, no error payload |
| Lib | `variant<Ts...>`, `visit`, `monostate` | Closed type-safe sum; `bad_variant_access` |
| Lib | `any` | Open type erasure; may allocate |
| Lib | `string_view` | Non-owning character range; no null-termination guarantee |
| Lib | `<filesystem>` | Paths, directory iteration, file status |
| Lib | `<memory_resource>` (PMR) | `monotonic_buffer_resource`, `unsynchronized_pool_resource`, `pmr::vector` |
| Lib | `<charconv>` `to_chars`/`from_chars` | Locale-free, allocation-free, non-throwing conversions |
| Lib | Parallel algorithms + execution policies | `std::execution::par`, `par_unseq` |
| Lib | `shared_mutex`, `scoped_lock` | RW mutex; deadlock-free multi-lock RAII |
| Lib | `std::byte` | Byte type without arithmetic/character semantics |
| Lib | `apply`, `invoke`, `not_fn` | Uniform invocation |
| Lib | `gcd`, `lcm`, `clamp`, `sample`, `reduce`, `transform_reduce`, `*_scan` | Numeric/algorithm additions |
| Lib | Node handles: `extract`, `insert(node)`, `merge` | Move nodes between associative containers without reallocating |
| Lib | `try_emplace`, `insert_or_assign` | Precise map insertion semantics |
| Lib | `shared_ptr<T[]>`, `weak_from_this` | Array support; safe self-`weak_ptr` |
| Lib | `void_t`, `conjunction`/`disjunction`/`negation`, `is_invocable`, `invoke_result` | Metaprogramming (`result_of` deprecated) |
| Lib | `launder`, `as_const`, `uncaught_exceptions`, `size`/`empty`/`data` | Utilities |

### P.4 C++20

| Kind | Feature | Recall |
|---|---|---|
| Lang | Concepts, `requires` clauses and expressions | Named constraints participating in overload resolution and subsumption |
| Lang | Coroutines (`co_await`, `co_yield`, `co_return`) | Compiler-generated state machine; promise type supplies all policy (no library generator until C++23) |
| Lang | Modules (`export module`, `import`) | Non-textual interface units; toolchain support varies |
| Lang | Three-way comparison `<=>`, `= default` comparisons | `strong/weak/partial_ordering`; rewritten `<`, `>`, `<=`, `>=`, `==`/`!=` |
| Lang | Designated initializers | `T{.a = 1, .c = 3}` — declaration order, no reordering |
| Lang | `consteval`, `constinit` | Immediate functions; guaranteed constant initialization |
| Lang | Expanded `constexpr`: `try`/`catch`, virtual calls, `new`/`delete`, `union` members | Constant evaluation covers most of the language |
| Lang | `std::is_constant_evaluated()` | Branch on constant evaluation context |
| Lang | Abbreviated function templates (`auto` parameters) | `void f(auto x)` |
| Lang | Templated lambdas `[]<class T>(T x){}` | Explicit template parameter list on closures |
| Lang | `[[likely]]`, `[[unlikely]]`, `[[no_unique_address]]` | Branch hints; empty-member size elision |
| Lang | Aggregate initialization with parentheses | `T(1, 2)` for aggregates |
| Lang | Class types as non-type template parameters | Structural types as NTTPs |
| Lang | `explicit(bool)`, `using enum`, `char8_t`, `__VA_OPT__` | Conditional explicit; enum name import; UTF-8 char type |
| Lang | Init-statement in range-`for`; structured bindings extensions | `for (auto x = init(); auto& e : x)`; capture/`static` bindings |
| Lang | Deprecated: `[=]` implicitly capturing `this` | Write `[=, this]` |
| Lib | Ranges: `<ranges>`, `std::ranges::` algorithms, views | Lazy, composable, non-owning pipelines; concepts-checked |
| Lib | `std::span<T, Extent>` | Non-owning contiguous view; static or dynamic extent |
| Lib | `std::format` / `format_to` / `formatter` | Type-safe, locale-independent-by-default formatting |
| Lib | `<bit>`: `bit_cast`, `popcount`, `countl/r_zero`, `rotl/rotr`, `bit_width/floor/ceil`, `has_single_bit`, `endian` | Bit manipulation and endian query |
| Lib | `jthread`, `stop_token`, `stop_source`, `stop_callback` | Cooperative cancellation; destructor requests stop and joins |
| Lib | `latch`, `barrier`, `counting_semaphore`, `binary_semaphore` | Coordination primitives |
| Lib | `atomic::wait/notify_one/notify_all`, `atomic_ref`, `atomic<shared_ptr>`, atomic floating-point | Blocking without a mutex; atomics over existing objects |
| Lib | `<syncstream>`, `source_location` | Interleave-free output; caller file/line/function |
| Lib | Calendar and time zones in `<chrono>` | `year_month_day`, `zoned_time`, `<chrono>` formatting |
| Lib | `erase`/`erase_if` free functions, `contains` (associative), `starts_with`/`ends_with` | Container/string conveniences |
| Lib | `ssize`, `to_address`, `midpoint`, `lerp`, `<numbers>` constants | Small numeric/pointer utilities |
| Lib | `bind_front`, `remove_cvref`, `type_identity`, `assume_aligned` | Utilities and traits |
| Lib | `constexpr` `std::string` and `std::vector`, `constexpr` algorithms | Dynamic allocation during constant evaluation |
| Lib | `make_shared` for arrays, `shift_left`/`shift_right` | Assorted additions |
| Lib | Removed: `std::result_of`, `raw_storage_iterator` | Superseded by `invoke_result` |

### P.5 C++23

| Kind | Feature | Recall |
|---|---|---|
| Lang | Deducing `this` (explicit object parameter) | `template<class Self> auto f(this Self&& self)` — unifies cv/ref overloads, enables CRTP-free static polymorphism and recursive lambdas |
| Lang | `if consteval` / `if !consteval` | Select behavior in a manifestly constant-evaluated context |
| Lang | `static operator()` and `static operator[]` | Stateless callables/subscripts without an object parameter |
| Lang | Multidimensional subscript `a[i, j]` | Multiple arguments to `operator[]` |
| Lang | `auto(x)` / `auto{x}` | Explicit decay-copy of an expression |
| Lang | `[[assume(expr)]]` | Optimizer assumption; a false assumption is UB, and `expr` is not evaluated |
| Lang | `size_t` literal suffix `uz` / `z` | `for (auto i = 0uz; i < v.size(); ++i)` |
| Lang | `#elifdef`, `#elifndef`, `#warning` | Preprocessor additions |
| Lang | Simplified implicit move in `return`/`throw` | More cases move instead of copy |
| Lang | `static_assert(false)` valid in an uninstantiated template | Via the adopted defect resolution |
| Lang | Labels at the end of compound statements, attributes on lambdas | Syntax cleanups |
| Lang | Extended `constexpr` (non-literal variables, `goto`, labels, `static`/`thread_local` in non-taken branches) | More functions can be `constexpr` |
| Lang | Named universal character escapes, delimited escape sequences | `\N{LATIN SMALL LETTER A}`, `\u{1F600}` |
| Lang | Deprecated: `std::aligned_storage`, `aligned_union` | Use raw `alignas` byte arrays plus explicit lifetime |
| Lib | `std::expected<T, E>` + monadic ops | Value-or-typed-error return channel; `and_then`, `transform`, `or_else`, `transform_error` |
| Lib | `std::mdspan` | Non-owning multidimensional view with extents/layout/accessor policies |
| Lib | `std::print`, `std::println` | Formatted output without iostreams |
| Lib | `std::stacktrace`, `stacktrace_entry` | Captured call stack; availability and symbolization vary |
| Lib | `flat_map`, `flat_set`, `flat_multimap`, `flat_multiset` | Sorted-container adaptors over contiguous storage (no reference stability) |
| Lib | `std::generator<T>` | Synchronous coroutine producing an input range |
| Lib | `std::move_only_function` | Move-only type-erased callable with cv/ref/noexcept qualifiers in the type |
| Lib | `out_ptr`, `inout_ptr` | Adapt smart pointers to C `T**` out-parameters |
| Lib | `std::byteswap`, `std::to_underlying`, `std::unreachable`, `std::forward_like`, `std::invoke_r`, `std::bind_back` | Small utilities |
| Lib | `std::start_lifetime_as` family, `allocate_at_least` | Implicit-lifetime object workflows; allocator size feedback |
| Lib | `std::optional` monadic ops (`and_then`/`transform`/`or_else`) | Matches `expected` |
| Lib | `ranges::to<C>()` | Materialize a range into a container |
| Lib | New views: `zip`, `zip_transform`, `adjacent`, `adjacent_transform`, `chunk`, `chunk_by`, `slide`, `stride`, `repeat`, `cartesian_product`, `join_with`, `as_rvalue`, `as_const`, `enumerate` | Range pipeline expansion |
| Lib | `ranges::fold_left`/`fold_right`/`fold_left_first` and variants | Range folds |
| Lib | `ranges::starts_with`/`ends_with`/`contains`/`find_last`/`iota`/`shift_left` | Range algorithm additions |
| Lib | Container `from_range` ctors, `assign_range`, `insert_range`, `append_range`, `prepend_range` | Range-aware container construction and insertion |
| Lib | `std::string::contains`, `string_view::contains`, `resize_and_overwrite` | String additions |
| Lib | `<spanstream>` | Stream over a caller-provided buffer, no allocation |
| Lib | `is_scoped_enum`, `formatter` for ranges/tuples, `<stdatomic.h>` compatibility | Traits, formatting, and C interop |
| Lib | Wider `constexpr` in `<cmath>`, `<memory>`, `unique_ptr`, algorithms | More compile-time library |

### P.6 Version traps

- Language mode is not availability — test `__cpp_*` / `__cpp_lib_*` feature-test macros from `<version>` (`#appendix-Q`).
- `constexpr` does not mean "evaluated at compile time"; only `consteval` calls must be.
- Views borrow and evaluate lazily; a pipeline can dangle even though every element is owned somewhere.
- Flat containers own a growable underlying container: they allocate, shift, and invalidate — contiguity is the benefit, not fixed capacity.
- `std::unreachable()` is not an assertion; reaching it is UB.
- `jthread` requests cooperative stop and joins — it does not interrupt a blocking call that ignores the token.
- `<scope>` scope guards (`scope_exit`, `scope_fail`, `scope_success`) are Library Fundamentals TS, **not** C++23.
- A newer facility is not automatically faster: compare ownership, invalidation, error channel, allocation, ABI, and code size before migrating.

---

<a id="appendix-q"></a>
## Appendix Q — Compiler and standard-library feature-test macro index

### Q.1 The mechanism

| Fact | Detail |
|---|---|
| Form of value | `YYYYMML` integer date of the paper's adoption, e.g. `202202L` |
| Definition rule | The macro is **defined only if the feature is supported**; it is never defined as `0` |
| Correct test | `#if defined(X) && X >= 202002L` — a bare `#if X` on an undefined macro silently reads `0` |
| Revision bumps | One macro may be bumped by later papers; test the *value*, not just existence |
| `__cplusplus` | Language-mode date only: `199711L`, `201103L`, `201402L`, `201703L`, `202002L`, `202302L`. **Not** conformance proof |
| MSVC caveat | `__cplusplus` reports `199711L` unless `/Zc:__cplusplus`; `_MSVC_LANG` carries the real mode |
| `__cpp_*` | Core-language feature; predefined by the compiler, no header needed |
| `__cpp_lib_*` | Library feature; requires including `<version>` **or** the feature's own header |
| `__has_include(<hdr>)` | Preprocessor header probe (C++17) — orthogonal to feature macros |
| `__has_cpp_attribute(a)` | Attribute probe (C++20), value is also a `YYYYMML` date |
| Not feature macros | `__GNUC__`, `_MSC_VER`, `__clang__`, `_LIBCPP_VERSION`, `__GLIBCXX__`, `_GLIBCXX_RELEASE` — vendor facts, not portable capability |
| Conditional macros | `__cpp_exceptions` and `__cpp_rtti` (`199711L`) are **undefined** under `-fno-exceptions` / `-fno-rtti` |
| ABI hazard | A feature macro must not change a class layout or inline definition differently across TUs of one program |

```cpp
// ---- <version> is the library capability header (C++20) ------------------
#include <version>          // defines every __cpp_lib_* the implementation has,
                            // and NOTHING else — no types, no allocation, cheap.
// Before C++20 the portable trick was #include <ciso646> (deprecated in C++17,
// removed in C++20) — use <version> and stop.

#if defined(__cpp_lib_expected) && __cpp_lib_expected >= 202202L
    #include <expected>
    template <class T> using Result = std::expected<T, ErrorCode>;
#elif __has_include(<tl/expected.hpp>)
    #include <tl/expected.hpp>
    template <class T> using Result = tl::expected<T, ErrorCode>;
#else
    #error "no expected implementation available"
#endif
```

```cpp
// ---- correct vs incorrect guards ----------------------------------------
#if __cpp_lib_ranges >= 202202L          // BAD: undefined -> 0, silently false,
                                         //      and -Wundef warns on some builds
#if defined(__cpp_lib_ranges) && __cpp_lib_ranges >= 202202L   // GOOD

#ifdef __cpp_lib_hardware_interference_size          // GOOD: existence is enough
constexpr std::size_t kLine = std::hardware_destructive_interference_size;
#else
constexpr std::size_t kLine = 64;                    // measured platform fallback
#endif

// Never define fallbacks in namespace std — UB. Put them in your own namespace.
```

### Q.2 Core-language macros — C++11 / C++14

| Macro | Value | Feature |
|---|---|---|
| `__cpp_rvalue_references` | `200610L` | Rvalue references, move semantics |
| `__cpp_ref_qualifiers` | `200710L` | `&` / `&&` ref-qualified member functions |
| `__cpp_variadic_templates` | `200704L` | Parameter packs |
| `__cpp_lambdas` | `200907L` | Lambda expressions |
| `__cpp_decltype` | `200707L` | `decltype` |
| `__cpp_attributes` | `200809L` | `[[attribute]]` syntax |
| `__cpp_alias_templates` | `200704L` | `template <class T> using` |
| `__cpp_delegating_constructors` | `200604L` | Delegating constructors |
| `__cpp_inheriting_constructors` | `200802L` / `201511L` (C++17) | `using Base::Base;` |
| `__cpp_nsdmi` | `200809L` | Default member initializers |
| `__cpp_initializer_lists` | `200806L` | `std::initializer_list` construction |
| `__cpp_alignas` | `200809L` | `alignas` |
| `__cpp_threadsafe_static_init` | `200806L` | Magic-static thread-safe initialization |
| `__cpp_unicode_characters` | `200704L` | `char16_t` / `char32_t` |
| `__cpp_unicode_literals` | `200710L` | `u""`, `U""`, `u8""` |
| `__cpp_raw_strings` | `200710L` | `R"(...)"` |
| `__cpp_user_defined_literals` | `200809L` | `operator""_x` |
| `__cpp_static_assert` | `200410L` / `201411L` (C++17 message-less) | `static_assert` |
| `__cpp_range_based_for` | `200907L` / `201603L` (C++17 asymmetric `end`) / `202211L` (C++23 temporary lifetime extension) | Range-`for` |
| `__cpp_binary_literals` | `201304L` | `0b1010` |
| `__cpp_init_captures` | `201304L` / `201803L` (C++20 pack init-capture) | `[x = expr]` |
| `__cpp_generic_lambdas` | `201304L` / `201707L` (C++20 explicit template parameter list) | `[](auto x){}` |
| `__cpp_return_type_deduction` | `201304L` | `auto` return type |
| `__cpp_decltype_auto` | `201304L` | `decltype(auto)` |
| `__cpp_variable_templates` | `201304L` | `template <class T> constexpr T pi_v` |
| `__cpp_aggregate_nsdmi` | `201304L` | Aggregate with default member initializers |
| `__cpp_sized_deallocation` | `201309L` | `operator delete(void*, size_t)` |
| `__cpp_exceptions` | `199711L` | Exceptions enabled (**undefined** if disabled) |
| `__cpp_rtti` | `199711L` | RTTI enabled (**undefined** if disabled) |

### Q.3 Core-language macros — C++17

| Macro | Value | Feature |
|---|---|---|
| `__cpp_if_constexpr` | `201606L` | `if constexpr` |
| `__cpp_fold_expressions` | `201603L` | `(... op pack)` |
| `__cpp_structured_bindings` | `201606L` | `auto [a, b] = t;` |
| `__cpp_inline_variables` | `201606L` | `inline` variables, `inline constexpr` |
| `__cpp_guaranteed_copy_elision` | `201606L` | Prvalue = initializer, not an object |
| `__cpp_deduction_guides` | `201611L` / `201703L` / `201907L` (C++20 aggregate + alias CTAD) | CTAD |
| `__cpp_aligned_new` | `201606L` | Over-aligned `new`, `align_val_t` |
| `__cpp_noexcept_function_type` | `201510L` | `noexcept` is part of the function type |
| `__cpp_capture_star_this` | `201603L` | `[*this]` capture by value |
| `__cpp_nontype_template_args` | `201411L` / `201911L` (C++20 class-type / structural NTTPs) | NTTP relaxations |
| `__cpp_nontype_template_parameter_auto` | `201606L` | `template <auto V>` |
| `__cpp_template_template_args` | `201611L` | Matching relaxation |
| `__cpp_variadic_using` | `201611L` | `using Bases::f...;` |
| `__cpp_namespace_attributes` | `201411L` | Attributes on namespaces |
| `__cpp_enumerator_attributes` | `201411L` | Attributes on enumerators |
| `__cpp_hex_float` | `201603L` | `0x1.8p3` |
| `__cpp_constexpr_in_decltype` | `201711L` (DR) | Instantiation required inside `decltype` |

### Q.4 Core-language macros — C++20

| Macro | Value | Feature |
|---|---|---|
| `__cpp_concepts` | `201907L` / `202002L` (conditionally trivial special members) | Concepts, `requires` |
| `__cpp_modules` | `201907L` | Modules, header units |
| `__cpp_impl_coroutine` | `201902L` | Coroutine **language** support (pairs with `__cpp_lib_coroutine`) |
| `__cpp_impl_three_way_comparison` | `201907L` | `<=>`, rewritten candidates |
| `__cpp_designated_initializers` | `201707L` | `.member = value` |
| `__cpp_aggregate_paren_init` | `201902L` | `T(a, b)` for aggregates |
| `__cpp_char8_t` | `201811L` / `202207L` (C++23 compat remediation) | `char8_t`, `u8""` type change |
| `__cpp_conditional_explicit` | `201806L` | `explicit(bool)` |
| `__cpp_consteval` | `201811L` / `202211L` (C++23 relaxed immediate-function contexts) | `consteval` |
| `__cpp_constinit` | `201907L` | `constinit` |
| `__cpp_using_enum` | `201907L` | `using enum E;` |
| `__cpp_constexpr_dynamic_alloc` | `201907L` | `new`/`delete` in constant evaluation |
| `__cpp_constexpr` | `200704L` (C++11) / `201304L` (C++14 relaxed) / `201603L` (C++17 lambdas) / `201907L` (C++20 `virtual`, `try`, `dynamic_cast`, trivial default init) / `202002L` (C++20 change union active member) / `202110L`, `202207L` (C++23 non-literal variables, `static`/`thread_local`, `goto`, labels; non-constant-evaluable bodies) | `constexpr` breadth |
| `__cpp_deleted_function` | `202403L` (C++26) | `= delete("reason")` — **not** C++23 |

### Q.5 Core-language macros — C++23

| Macro | Value | Feature |
|---|---|---|
| `__cpp_explicit_this_parameter` | `202110L` | Deducing `this` (explicit object parameter) |
| `__cpp_if_consteval` | `202106L` | `if consteval` |
| `__cpp_multidimensional_subscript` | `202110L` / `202211L` | `a[i, j]`, static `operator[]` |
| `__cpp_static_call_operator` | `202207L` | `static operator()` |
| `__cpp_auto_cast` | `202110L` | `auto(x)` / `auto{x}` decay-copy |
| `__cpp_size_t_suffix` | `202011L` | `1uz`, `1z` |
| `__cpp_named_character_escapes` | `202207L` | `"\N{LATIN SMALL LETTER A}"` |
| `__cpp_implicit_move` | `202207L` | Simpler implicit move on return |
| `__cpp_constexpr` (C++23 tier) | `202110L`, `202207L` | see Q.4 |
| `__cpp_range_based_for` (C++23 tier) | `202211L` | Range-`for` temporary lifetime extension |
| `__cpp_consteval` (C++23 tier) | `202211L` | `consteval` propagation (P2564) |

### Q.6 Library macros — C++17 vocabulary and utilities

| Macro | Value | Header / feature |
|---|---|---|
| `__cpp_lib_optional` | `201606L` / `202110L` (C++23 monadic `and_then`/`transform`/`or_else`) | `<optional>` |
| `__cpp_lib_variant` | `201606L` / `202106L` (C++23 constexpr + fixes) | `<variant>` |
| `__cpp_lib_any` | `201606L` | `<any>` |
| `__cpp_lib_string_view` | `201606L` | `<string_view>` |
| `__cpp_lib_starts_ends_with` | `201711L` (C++20) | `string`/`string_view` prefix/suffix tests |
| `__cpp_lib_string_contains` | `202011L` (C++23) | `contains()` |
| `__cpp_lib_to_chars` | `201611L` | `<charconv>` — `from_chars` / `to_chars` |
| `__cpp_lib_constexpr_charconv` | `202207L` (C++23) | `constexpr` integral `from_chars`/`to_chars` |
| `__cpp_lib_memory_resource` | `201603L` | `<memory_resource>`, `pmr::` |
| `__cpp_lib_polymorphic_allocator` | `201902L` (C++20) | `pmr::polymorphic_allocator::allocate_bytes` etc. |
| `__cpp_lib_hardware_interference_size` | `201703L` | `hardware_destructive/constructive_interference_size` |
| `__cpp_lib_launder` | `201606L` | `std::launder` |
| `__cpp_lib_byte` | `201603L` | `std::byte` |
| `__cpp_lib_apply` | `201603L` | `std::apply` |
| `__cpp_lib_invoke` | `201411L` | `std::invoke` |
| `__cpp_lib_invoke_r` | `202106L` (C++23) | `std::invoke_r<R>` |
| `__cpp_lib_node_extract` | `201606L` | Map/set node handles, `extract`, `merge` |
| `__cpp_lib_scoped_lock` | `201703L` | `std::scoped_lock` |
| `__cpp_lib_shared_mutex` | `201505L` | `std::shared_mutex` |
| `__cpp_lib_execution` | `201603L` / `201902L` (C++20 `unseq`) | Execution policies |
| `__cpp_lib_parallel_algorithm` | `201603L` | Parallel algorithm overloads |
| `__cpp_lib_filesystem` | `201703L` | `<filesystem>` |
| `__cpp_lib_gcd_lcm` | `201606L` | `std::gcd`, `std::lcm` |
| `__cpp_lib_clamp` | `201603L` | `std::clamp` |
| `__cpp_lib_as_const` | `201510L` | `std::as_const` |
| `__cpp_lib_uncaught_exceptions` | `201411L` | `std::uncaught_exceptions()` |

### Q.7 Library macros — C++20

| Macro | Value | Header / feature |
|---|---|---|
| `__cpp_lib_concepts` | `202002L` | `<concepts>` |
| `__cpp_lib_ranges` | `201911L` (C++20) / `202106L`, `202110L`, `202202L`, `202207L`, `202211L` (C++23 tiers) | `<ranges>` core |
| `__cpp_lib_span` | `202002L` | `<span>` |
| `__cpp_lib_bit_cast` | `201806L` | `std::bit_cast` |
| `__cpp_lib_bitops` | `201907L` | `countl_zero`, `popcount`, `rotl`, … |
| `__cpp_lib_int_pow2` | `202002L` | `has_single_bit`, `bit_ceil`, `bit_width` |
| `__cpp_lib_endian` | `201907L` | `std::endian` |
| `__cpp_lib_byteswap` | `202110L` (C++23) | `std::byteswap` |
| `__cpp_lib_atomic_ref` | `201806L` | `std::atomic_ref` |
| `__cpp_lib_atomic_wait` | `201907L` | `wait`/`notify_one`/`notify_all` |
| `__cpp_lib_atomic_flag_test` | `201907L` | `atomic_flag::test()` |
| `__cpp_lib_atomic_shared_ptr` | `201711L` | `atomic<shared_ptr<T>>` |
| `__cpp_lib_atomic_float` | `201711L` | `atomic<float/double>` arithmetic |
| `__cpp_lib_atomic_lock_free_type_aliases` | `201907L` | `atomic_signed_lock_free`, `atomic_unsigned_lock_free` |
| `__cpp_lib_semaphore` | `201907L` | `counting_semaphore`, `binary_semaphore` |
| `__cpp_lib_latch` | `201907L` | `std::latch` |
| `__cpp_lib_barrier` | `201907L` | `std::barrier` |
| `__cpp_lib_jthread` | `201911L` | `jthread`, `stop_token`, `stop_source` |
| `__cpp_lib_coroutine` | `201902L` | `<coroutine>` library support |
| `__cpp_lib_format` | `201907L` / `202106L` / `202110L` / `202207L` / `202304L` | `<format>` (later tiers: compile-time checks, `vformat_to`, C++23 fixes) |
| `__cpp_lib_source_location` | `201907L` | `std::source_location` |
| `__cpp_lib_three_way_comparison` | `201907L` | `<compare>`, `strong_ordering`, `compare_three_way` |
| `__cpp_lib_erase_if` | `202002L` | Uniform `std::erase` / `std::erase_if` |
| `__cpp_lib_to_array` | `201907L` | `std::to_array` |
| `__cpp_lib_ssize` | `201902L` | `std::ssize` |
| `__cpp_lib_shift` | `201806L` | `shift_left`, `shift_right` |
| `__cpp_lib_constexpr_algorithms` | `201806L` | `constexpr` `<algorithm>` |
| `__cpp_lib_constexpr_vector` | `201907L` | `constexpr std::vector` |
| `__cpp_lib_constexpr_string` | `201907L` | `constexpr std::string` |
| `__cpp_lib_constexpr_dynamic_alloc` | `201907L` | `constexpr std::allocator` |
| `__cpp_lib_is_constant_evaluated` | `201811L` | `std::is_constant_evaluated()` |
| `__cpp_lib_remove_cvref` | `201711L` | `std::remove_cvref_t` |
| `__cpp_lib_type_identity` | `201806L` | `std::type_identity` |
| `__cpp_lib_bounded_array_traits` | `201902L` | `is_bounded_array`, `is_unbounded_array` |
| `__cpp_lib_assume_aligned` | `201811L` | `std::assume_aligned` |
| `__cpp_lib_destroying_delete` | `201806L` | `operator delete(T*, destroying_delete_t)` |
| `__cpp_lib_smart_ptr_for_overwrite` | `202002L` | `make_unique_for_overwrite` |
| `__cpp_lib_math_constants` | `201907L` | `<numbers>` |
| `__cpp_lib_chrono` | `201611L` / `201907L` (C++20 calendars, time zones) | `<chrono>` |
| `__cpp_lib_syncbuf` | `201803L` | `osyncstream` |
| `__cpp_lib_int_pow2`, `__cpp_lib_bitops` | see above | `<bit>` |

### Q.8 Library macros — C++23

| Macro | Value | Header / feature |
|---|---|---|
| `__cpp_lib_expected` | `202202L` | `<expected>` — `std::expected<T, E>` |
| `__cpp_lib_mdspan` | `202207L` | `<mdspan>` |
| `__cpp_lib_print` | `202207L` | `<print>` — `std::print`, `std::println` |
| `__cpp_lib_flat_map` | `202207L` | `<flat_map>` |
| `__cpp_lib_flat_set` | `202207L` | `<flat_set>` |
| `__cpp_lib_generator` | `202207L` | `<generator>` — `std::generator` |
| `__cpp_lib_stacktrace` | `202011L` | `<stacktrace>` |
| `__cpp_lib_move_only_function` | `202110L` | `std::move_only_function` |
| `__cpp_lib_spanstream` | `202106L` | `<spanstream>` |
| `__cpp_lib_out_ptr` | `202106L` | `std::out_ptr`, `std::inout_ptr` |
| `__cpp_lib_to_underlying` | `202102L` | `std::to_underlying` |
| `__cpp_lib_unreachable` | `202202L` | `std::unreachable()` |
| `__cpp_lib_forward_like` | `202207L` | `std::forward_like` |
| `__cpp_lib_start_lifetime_as` | `202207L` | `start_lifetime_as`, `start_lifetime_as_array` |
| `__cpp_lib_is_scoped_enum` | `202011L` | `std::is_scoped_enum` |
| `__cpp_lib_is_implicit_lifetime` | `202302L` (C++26) | `is_implicit_lifetime` — **not** C++23 |
| `__cpp_lib_bind_back` | `202202L` | `std::bind_back` |
| `__cpp_lib_containers_ranges` | `202202L` | `from_range` ctor, `append_range`, `insert_range`, `assign_range`, `prepend_range` |
| `__cpp_lib_ranges_to_container` | `202202L` | `std::ranges::to` |
| `__cpp_lib_ranges_zip` | `202110L` | `views::zip`, `zip_transform`, `adjacent`, `adjacent_transform` |
| `__cpp_lib_ranges_chunk` | `202202L` | `views::chunk` |
| `__cpp_lib_ranges_slide` | `202202L` | `views::slide` |
| `__cpp_lib_ranges_chunk_by` | `202202L` | `views::chunk_by` |
| `__cpp_lib_ranges_join_with` | `202202L` | `views::join_with` |
| `__cpp_lib_ranges_stride` | `202207L` | `views::stride` |
| `__cpp_lib_ranges_repeat` | `202207L` | `views::repeat` |
| `__cpp_lib_ranges_cartesian_product` | `202207L` | `views::cartesian_product` |
| `__cpp_lib_ranges_as_const` | `202207L` | `views::as_const` |
| `__cpp_lib_ranges_as_rvalue` | `202207L` | `views::as_rvalue` |
| `__cpp_lib_ranges_enumerate` | `202302L` | `views::enumerate` |
| `__cpp_lib_ranges_fold` | `202207L` | `ranges::fold_left`, `fold_right`, `fold_left_first`, … |
| `__cpp_lib_ranges_find_last` | `202207L` | `ranges::find_last`, `find_last_if` |
| `__cpp_lib_ranges_contains` | `202207L` | `ranges::contains`, `contains_subrange` |
| `__cpp_lib_ranges_starts_ends_with` | `202106L` | `ranges::starts_with`, `ends_with` |
| `__cpp_lib_format_ranges` | `202207L` | Formatting ranges, `std::formatter` for containers |
| `__cpp_lib_formatters` | `202302L` | `formatter` for `thread::id` and `stacktrace` |
| `__cpp_lib_string_resize_and_overwrite` | `202110L` | `std::string::resize_and_overwrite` |
| `__cpp_lib_constexpr_bitset` | `202207L` | `constexpr std::bitset` |
| `__cpp_lib_constexpr_typeinfo` | `202106L` | `constexpr type_info::operator==` |
| `__cpp_lib_associative_heterogeneous_erasure` | `202110L` | Heterogeneous `erase`/`extract` on associative containers |
| `__cpp_lib_adaptor_iterator_pair_constructor` | `202106L` | `queue`/`stack` from an iterator pair |
| `__cpp_lib_ios_noreplace` | `202207L` | `std::ios_base::noreplace` |
| `__cpp_lib_allocate_at_least` | `202302L` | `allocator::allocate_at_least` |
| `__cpp_lib_stdatomic_h` | `202011L` | `<stdatomic.h>` in C++ |
| `__cpp_lib_experimental_scope` | `201902L` (**LFTS v3, not ISO C++23**) | `experimental::scope_exit` / `scope_fail` / `scope_success` |

### Q.9 Hot-path relevance — which macro actually gates what you write

| You want | Guard on | Fallback if absent |
|---|---|---|
| `std::expected` error returns | `__cpp_lib_expected >= 202202L` | Hand-rolled `Result<T,E>` in your namespace |
| Allocation-free number parse | `__cpp_lib_to_chars >= 201611L` | Hand-written digit loop (**never** `strtod`/`sscanf` on hot path) |
| `<format>` / `std::print` | `__cpp_lib_format`, `__cpp_lib_print` | `fmt` library, or deferred binary records (`#ch42`) |
| Cache-line constant | `__cpp_lib_hardware_interference_size` | Measured platform constant, not a hardcoded 64 |
| `atomic_ref` over pooled storage | `__cpp_lib_atomic_ref >= 201806L` | `std::atomic<T>` members, changing the layout |
| Endian-safe wire loads | `__cpp_lib_endian`, `__cpp_lib_byteswap`, `__cpp_lib_bit_cast` | Explicit byte shifts (`#ch34`) |
| Untyped-buffer object creation | `__cpp_lib_start_lifetime_as` | `memcpy` into a real object |
| `move_only_function` callbacks | `__cpp_lib_move_only_function` | Custom fixed-size type-erased callable |
| Non-allocating pool/arena | `__cpp_lib_memory_resource` | Your own arena (`#ch37`) |
| Deducing `this` CRTP replacement | `__cpp_explicit_this_parameter` | Classic CRTP (`#ch11`) |

**Traps** — testing `__cplusplus >= 202302L` and assuming the whole library is present (front end, stdlib, and ABI library version independently) · forgetting `#include <version>` so every `__cpp_lib_*` reads as absent · `#if X` instead of `#if defined(X) && X >= …` · defining fallback names in `namespace std` (UB) · letting a feature macro change a class layout or an inline function body differently in different TUs (ODR/ABI break) · treating an implementation's *macro* as proof the feature is bug-free or fast.

---

<a id="appendix-r"></a>
## Appendix R — HFT/quant implementation-pattern index

Anchors point at the chapter holding the **full implementation**. Chapters 33–42 are the blueprint
part; two entries (branchless select, hot/cold split) are implemented in the performance chapters and
are marked as such.

### R.1 Master index

| Pattern | Problem it solves | Key invariant | Cost | Anchor |
|---|---|---|---|---|
| **Bounded SPSC ring** | Hand data between exactly two threads with no lock, no allocation, and bounded memory | Producer owns `write` only, consumer owns `read` only; `0 <= write - read <= Capacity`; publish index **after** constructing the element, free the slot **after** destroying it | Two cache lines bouncing between cores; enqueue is a few relaxed loads + one release store; full/empty is a policy decision, not an error | `#ch36` |
| **Fixed-capacity object pool** | Stable addresses and O(1) acquire/release without `new` on the hot path | Every slot is exactly *free* or *occupied*; `live + free == Capacity`; construct before publishing occupancy, destroy before publishing free | O(1) pop/push of an intrusive free-list index; footprint is `Capacity * sizeof(T)` paid up front; exhaustion is a return value, never a grow | `#ch37` |
| **Bump / monotonic arena** | Phase-scoped allocation where everything dies together (one message, one tick, one replay batch) | One monotonically advancing cursor; individual `deallocate` is a no-op; `reset()` is only legal once every object's lifetime has ended | One aligned add per allocation; alignment padding is charged to `used`; non-trivial `T` needs recorded destructors or the arena leaks lifetimes | `#ch37` |
| **Seqlock** | Let readers take a consistent multi-field snapshot without ever blocking the single writer | Writer: `version` odd → mutate → even. Reader: reject if version is odd or if the recheck differs. Data fields must be **atomic** (relaxed) — a plain-field seqlock is a data race and therefore UB regardless of the recheck | Writer pays two stores + two fences; readers pay a retry loop that is unbounded under a hot writer; no reader-side write traffic on the data | `#ch40` |
| **Double / triple buffer** | Publish a whole new snapshot without a lock and without tearing | The writer may reuse a buffer only when no reader can still be inside it — an atomic active-index alone does **not** establish that | O(1) publish (one release store of index/pointer); costs a full copy per publish and 2–3× memory; triple buffering reduces, does not prove away, slow-reader collision | `#ch40` |
| **Atomic pointer publication** | Swap in an immutable snapshot object with one store | Snapshot is fully built and immutable before the release store; readers acquire-load once and use the pointer for the whole read | O(1) publish; the hard part is **reclamation** of retired snapshots (refcount, hazard pointer, epoch — all with their own cost) | `#ch40` |
| **Dense price ladder** | O(1) price→level lookup for a book with a known tick range | `index = (tick - base_tick)`, computed without signed overflow and range-checked once; a best-price index or active bitmap is maintained alongside, or best-price search degrades to scanning empty levels | O(1) access, perfect locality on a contiguous scan; memory is proportional to the **tick range**, not to the live level count; sized at setup, never grown on the hot path | `#ch38` |
| **Intrusive FIFO order chain** | Price-time priority per level with zero per-order allocation and O(1) cancel | `prev`/`next` **indices** live inside the order slot; level `head`/`tail`, `aggregate` quantity, and `order_count` are updated as one transaction; unlink before erasing the level | O(1) add/cancel/execute given a handle; no node allocation; cost is one dependent load per hop, so long chains still chase | `#ch38` |
| **Generation handle** | Detect use of a stale reference to a recycled slot, in constant time, without shared ownership | Valid iff `index < Capacity && slot occupied && slot.generation == handle.generation`; generation is bumped on **release**; generation `0` is reserved as the null handle | 32+32 bits, trivially copyable, survives container relocation; detects staleness only until the generation counter wraps and aliases; a handle owns nothing | `#ch37` |
| **Wire cursor** | Decode/encode a framed binary message over `std::span<std::byte>` without overlaying a packed struct | The cursor owns no bytes and advances **only on success** — a failed read must leave the position unconsumed; every field load is an explicit endian-aware byte load, never a `reinterpret_cast` overlay | One bounds branch per variable field with a per-field cursor, versus one branch total when the frame size is fixed and checked once; no allocation, no UB from alignment or aliasing | `#ch34` |
| **`from_chars` parser** | Turn ASCII fields into integers / fixed-point prices with no allocation, no locale, no exceptions | Success means "some prefix parsed" — you must additionally require `ptr == last` to prove the field was fully consumed; overflow is checked **before** the multiply (a post-hoc signed check is already UB); excess precision is rejected, not silently rounded | Allocation-free, locale-free, branch-predictable; orders of magnitude cheaper than `stringstream`/`sscanf`; fixed-point keeps exactness that `double` cannot | `#ch35` |
| **Timing wheel** | Schedule and expire many timers in O(1) amortized instead of O(log n) per heap operation | `bucket = (deadline_tick) mod bucket_count`; you must define tick resolution and rounding, the horizon before wrap, revolution disambiguation, cascading, and what happens to skipped ticks | O(1) insert and cancel; expiry is **not** O(1) if one bucket holds many timers; memory is `bucket_count` slots regardless of load; a heap is better for few, far-out, precise deadlines | `#ch41` |
| **Deferred log record** | Get diagnostics off the hot path without formatting, allocating, or blocking on it | The record is fixed-size and trivially copyable (site id + numeric args + codes) — it may never hold a view into a caller temporary; all text formatting happens in the drain thread; the full-queue policy is explicit and counted, never a silent drop | Producer cost is a few stores plus a bounded SPSC enqueue; the drain owns formatting and I/O; the queue is the backpressure knob | `#ch42` |
| **Branchless select** | Remove an unpredictable branch from an inner loop (best-price update, clamp, min/max merge) | Both sides must be **safe to evaluate**: no loads through a pointer that may be invalid, no side effects, no division by zero on the untaken side | Trades a mispredict (tens of cycles) for a longer dependency chain and always-executed work; loses to a *predictable* branch; "branchless C++" is not a language guarantee — the compiler may still emit a branch | `#ch26` (§ branch prediction) |
| **Cache-line padding** | Stop two independently written variables from ping-ponging one cache line between cores | Each independently written datum sits on its own line: `alignas(std::hardware_destructive_interference_size)`, with the size read from the implementation, not hardcoded to 64 | Grows the object by up to a line per padded field; padding per *shard* (per producer, per queue) not per field, or footprint and TLB pressure win back what you saved | `#ch36` (also `#ch42` for sharded counters) |
| **Hot/cold split** | Keep the bytes actually touched per event dense, and evict rarely-read diagnostics from the cache line | Hot struct holds only fields read on every event; cold data lives in a parallel array indexed by the same slot index; layout is asserted with `static_assert`, not assumed | Halving a hot record's size can halve cache misses on a sweep; costs a second indirection whenever cold data *is* needed, and two arrays to keep in sync | `#ch33` (§ layout audit), applied in `#ch37`, `#ch38` |

### R.2 Selection guide — symptom to pattern

| Symptom in the design | Reach for | Not |
|---|---|---|
| `new`/`delete` appears between two timestamps | object pool or bump arena (`#ch37`) | `shared_ptr`, `make_unique` |
| Two threads, one direction, bounded queue | SPSC ring (`#ch36`) | `std::queue` + mutex; MPMC generality you do not need |
| Many readers need a consistent view of a small struct | seqlock (`#ch40`) | `shared_mutex` (reader-side writes contend) |
| Many readers need a consistent view of a large structure | atomic pointer publication + reclamation (`#ch40`) | seqlock (retry storm on a big payload) |
| A handle may outlive the object it names | index + generation (`#ch37`) | raw pointer; `weak_ptr` on a hot path |
| Price → level lookup dominates the profile | dense ladder (`#ch38`) | `std::map<Price, Level>` |
| Cancel-by-order-id must be O(1) | id→slot index map + intrusive chain (`#ch38`) | scanning the level's order list |
| Decoding reads fields out of a packed struct overlay | wire cursor over `span<byte>` (`#ch34`) | `reinterpret_cast` onto the buffer, `#pragma pack` |
| Parsing calls `stod` / `stringstream` / `regex` | `from_chars` + fixed-point (`#ch35`) | anything locale- or exception-dependent |
| Thousands of timers, coarse resolution | timing wheel (`#ch41`) | `priority_queue<deadline>` |
| Logging shows up in the latency histogram | deferred record + async drain (`#ch42`) | synchronous `std::format` / `iostream` |
| Two cores writing "unrelated" counters, throughput collapses | cache-line padding / sharding (`#ch36`) | assuming distinct variables are independent |
| One struct's size exceeds a cache line and half is rarely read | hot/cold split (`#ch33`) | adding more fields to the hot record |

### R.3 What each pattern refuses to do

| Pattern | Explicitly out of scope — you must supply it |
|---|---|
| SPSC ring | Multiple producers or consumers; growth; fairness; a blocking API (backpressure policy is yours: reject, spin, yield, block, overwrite) |
| Object pool | Growth on exhaustion; cross-thread release unless the variant says so; defragmentation |
| Bump arena | Individual free; destructor calls for non-trivial `T` unless recorded; sub-arena lifetime nesting |
| Seqlock | Writer-writer exclusion (it is single-writer); progress guarantee for readers; correctness over non-atomic fields |
| Double buffer | Proof that readers have left the retired buffer |
| Dense ladder | Prices outside the configured tick range; best-price tracking, unless you maintain it |
| Intrusive FIFO | Order identity lookup (a separate id→index map does that) |
| Generation handle | Ownership, lifetime extension, or safety across generation wraparound |
| Wire cursor | Semantic validation, message versioning, and replay ordering |
| `from_chars` parser | Locale-aware, scientific, or hex forms unless requested; rounding of excess precision |
| Timing wheel | Deadlines beyond the horizon (needs cascading or an overflow list); sub-tick precision |
| Deferred log record | Ordering across threads; delivery guarantee on crash; unbounded strings |
| Branchless select | Being faster — that is a measurement, not a property |
| Cache-line padding | Portability of the constant; it is implementation-defined |
| Hot/cold split | Automatic synchronization between the two arrays |

---

<a id="appendix-s"></a>
## Appendix S — Interview last-minute recall sheet

*Read this in the 15 minutes before the interview. It assumes you already studied the chapters; nothing here is explained, only re-armed. Every row is a complete sentence you can say out loud without editing.*

### S.0 The answer template — say it in this order every time

| # | Move | Say this |
|---|---|---|
| 1 | Rule | "The guarantee is …" — name the standard rule, not a habit. |
| 2 | Ownership | "Who owns it and how long does it live?" — answer that before anything else. |
| 3 | Cost | "What does that cost in allocations, cache lines, and contention?" |
| 4 | Qualification | "That holds when …" — state the precondition that makes your answer true. |
| 5 | Example | Three lines of code, or one concrete failure case. |

| # | Sentence stem | When to reach for it |
|---|---|---|
| 1 | "The standard guarantees …" | You are certain and it is normative. |
| 2 | "The implementation is permitted to … but is not required to …" | SSO, NRVO, devirtualization, inlining, `[[likely]]`. |
| 3 | "That's undefined behaviour, so the question isn't what happens — it's that the optimizer assumes it can't." | Any UB question. |
| 4 | "That's implementation-defined; I'd check the ABI/toolchain." | Layout, `char` signedness, bit-fields, `type_info::name()`. |
| 5 | "I'd have to measure that; here's what I'd measure and why." | Any performance claim you can't source. |

---

### S.1 The 20 lines that most often decide a C++ interview

| # | Say this |
|---|---|
| 1 | "`std::move` moves nothing — it's an unconditional cast to an xvalue, and the constructor or assignment that overload resolution then picks is what actually transfers." |
| 2 | "A named rvalue-reference parameter is an **lvalue** inside the function body; that is exactly why `std::forward` exists." |
| 3 | "The move operations are implicitly declared only if the class declares no copy operation, no move operation, and no destructor." |
| 4 | "Vector reallocation invalidates every iterator, pointer, and reference; a `push_back` that doesn't reallocate invalidates only the old `end()`." |
| 5 | "`reserve` gives capacity, `resize` gives elements — writing `v[i]` into reserved-but-unconstructed storage is undefined behaviour." |
| 6 | "A base needs a `virtual` destructor exactly when objects are deleted through a pointer to that base; otherwise make the destructor `protected` and non-virtual." |
| 7 | "A comparator must be a strict weak ordering — `<=` isn't one, and a NaN in the data breaks `<`, so `std::sort` is UB in both cases." |
| 8 | "`unordered_map` rehash invalidates all iterators but keeps references and pointers to elements valid." |
| 9 | "A data race is two potentially concurrent conflicting accesses to the same memory location, at least one a write, at least one non-atomic, with neither happening-before the other — and it's undefined behaviour, not a wrong value." |
| 10 | "A release store synchronizes-with an acquire load that actually reads that value, and that edge publishes everything sequenced before the store." |
| 11 | "`relaxed` gives atomicity and a per-object modification order and nothing else — it publishes no surrounding writes." |
| 12 | "Lock-free means some thread makes system-wide progress; it does not mean fast, bounded-latency, or allocation-free." |
| 13 | "Copy elision is mandatory for prvalue initialization since C++17; NRVO on a named local is permitted but never guaranteed, and `return std::move(local)` disables it." |
| 14 | "`std::bit_cast` and `memcpy` are the legal punning tools; a `reinterpret_cast` overlay of a receive buffer breaks lifetime, alignment, and strict aliasing before endianness is even discussed." |
| 15 | "The exception-safety ladder is no-throw, strong, basic, none — and a violated `noexcept` calls `std::terminate` instead of propagating." |
| 16 | "The strong-guarantee recipe is: do all the throwing work into a complete candidate, validate it, then commit with an operation I can prove is non-throwing." |
| 17 | "False sharing is two independently written objects landing on one cache line; you fix it with layout, never with a weaker memory order." |
| 18 | "Overload resolution is pure compile-time selection: lookup plus ADL builds the candidate set, deduction and constraints prune it, then implicit conversion sequences are ranked." |
| 19 | "Concepts subsume — 'more constrained' is a formal relation over normalized atomic constraints, not the English sense — whereas SFINAE only removes candidates." |
| 20 | "Big-O counts abstract operations; it never counts cache misses, allocations, syscalls, or contention, which is where the latency actually lives." |

---

### S.2 Value categories and move — 10 lines

| # | Say this |
|---|---|
| 1 | "Value category is a property of an **expression**, never of a type and never of an object." |
| 2 | "An lvalue has identity and can't be moved from; an xvalue has identity and can; a prvalue has no identity yet — it initializes a result object." |
| 3 | "`glvalue` is lvalue plus xvalue, `rvalue` is xvalue plus prvalue; a prvalue only gets an address when it's materialized." |
| 4 | "Since C++17 a prvalue directly initializes its result object, so no copy or move constructor needs to exist at all." |
| 5 | "`std::move` is `static_cast<T&&>`; `std::forward<T>` is a *conditional* cast that is only correct on a genuinely deduced `T&&`." |
| 6 | "`T&&` is a forwarding reference only when `T` is a cv-unqualified template parameter deduced for that parameter, or `auto&&` — `Widget&&` and `const T&&` are ordinary rvalue references." |
| 7 | "Reference collapsing: only `&& + &&` yields `&&`; every other combination collapses to `&`." |
| 8 | "Moving from a `const` object silently copies, because `const T&&` can't bind to `T&&` so the copy constructor wins." |
| 9 | "A moved-from standard-library object is **valid but unspecified** — I can destroy it or assign to it, but I may not assume it's empty, null, or zero." |
| 10 | "Move cost follows representation: a pointer-owning container moves in O(1), `std::array<T,N>` moves N elements, and a short `std::string` copies its inline SSO bytes." |
| 11 | "Forward each parameter exactly once; a second `std::forward` may consume an already-pillaged value." |
| 12 | "`std::forward_like<Model>(x)` (C++23) applies the model's cv-qualification and value category to `x` — the natural partner of a deducing-`this` accessor." |

---

### S.2b Lambdas and callables — 10 lines

| # | Say this |
|---|---|
| 1 | "Every lambda expression creates a distinct unnamed closure class, so two textually identical lambdas have different types." |
| 2 | "A captureless lambda converts to a matching function pointer; a capturing one never does." |
| 3 | "Captures copy *the object*, not what it refers to — `[sv]`, `[ptr]`, `[span]`, and `[it]` are all still borrowing." |
| 4 | "`[this]` copies a pointer and `[*this]` copies the object; implicit `this` capture through `[=]` is deprecated since C++20." |
| 5 | "The closure's `operator()` is `const` by default; `mutable` removes that `const` and grants no thread safety and no lifetime extension." |
| 6 | "Init-capture `[p = std::move(u)]` is how a closure owns move-only state — and it's exactly why such a closure can't go into `std::function`." |
| 7 | "`std::function` is *copyable* type erasure, so its target must be copy-constructible, construction may allocate, and calling an empty one throws `bad_function_call`." |
| 8 | "`std::move_only_function` (C++23) can express a `noexcept` signature and holds move-only targets, but calling an empty one is **UB**, not an exception." |
| 9 | "Small-buffer optimization in `std::function` is only *required* for function pointers and `reference_wrapper` — everything else is a quality-of-implementation accident." |
| 10 | "A lambda doesn't allocate; the allocation comes from the erasing wrapper or the container you store it in." |
| 11 | "`std::invoke` is the one spelling that uniformly handles free functions, functors, member functions, and member *data*." |
| 12 | "A coroutine lambda is hazardous: the frame keeps the closure's `this`, so a dead closure dangles all its captures." |

---

### S.3 Special members and Rule of Zero/Five — 8 lines

| # | Say this |
|---|---|
| 1 | "Rule of Zero: put ownership in members — `vector`, `string`, `unique_ptr` — and declare none of the six." |
| 2 | "Rule of Five: the moment I manage a raw resource, I have to reason about destructor, copy ctor, copy assign, move ctor, move assign together." |
| 3 | "Declaring any move operation makes the implicitly declared copy operations **deleted**; declaring any copy operation suppresses the implicit moves." |
| 4 | "Declaring a destructor — even `= default` in the class body — suppresses the implicit move operations, so the class silently degrades to copying." |
| 5 | "`= default` **on the first declaration** keeps the member non-user-provided and possibly trivial; defaulting it later makes it user-provided and non-trivial." |
| 6 | "`is_move_constructible_v<T>` is true whenever an rvalue can initialize a `T`, so a `const T&` copy constructor satisfies it — the trait never proves a real move constructor exists." |
| 7 | "Make move operations `noexcept` or `vector` reallocation falls back to copying via `move_if_noexcept` to keep the strong guarantee." |
| 8 | "Self-move must leave the object valid; the naive release-then-steal ordering frees the very resource it then adopts, which is why copy-and-swap is the safe default." |
| 9 | "Copy-and-swap buys self-assignment safety and the strong guarantee at the price of a full temporary and delayed release." |
| 10 | "Members are initialized in **declaration order** regardless of the mem-initializer list order, bases before members, and destruction is the exact reverse." |

---

### S.3b Initialization — 10 lines

| # | Say this |
|---|---|
| 1 | "Name the form before predicting behaviour: `T x;` is default, `T x{};` is value, `T x(a);` is direct, `T x = a;` is copy, `T x{a};` is direct-list." |
| 2 | "Default-initializing an automatic scalar leaves indeterminate bytes, and reading them is UB in C++23." |
| 3 | "`new T` default-initializes while `new T()` and `new T{}` value-initialize — the parenthesized form is what zeroes an array." |
| 4 | "List-initialization rejects narrowing: float to int, wider to narrower integer, and signed to unsigned all become errors." |
| 5 | "Braces prefer an `initializer_list` constructor so strongly that `vector<int>{5, 7}` is two elements while `vector<int>(5, 7)` is five sevens — and that preference is not a fallback." |
| 6 | "`auto x = {1, 2}` is an `initializer_list<int>` but `auto x{1}` is an `int`." |
| 7 | "`Widget w();` declares a function — that's the most vexing parse; `Widget w{};` constructs." |
| 8 | "A default member initializer applies only when the chosen constructor's mem-init list doesn't mention that member." |
| 9 | "Static initialization — constant, then zero — always precedes dynamic initialization, and cross-TU dynamic order is unspecified; that's the static initialization order fiasco." |
| 10 | "`constinit` forbids dynamic initialization but doesn't imply `const`; `constexpr` on a variable does imply `const`; `consteval` makes every call immediate." |
| 11 | "Function-local statics initialize on first use with thread-safe semantics since C++11 — destruction order and reentrancy are still your problem." |
| 12 | "`explicit` removes a constructor from copy-initialization and implicit conversion but keeps it for direct-initialization; `explicit(bool)` is C++20." |

---

### S.4 Container choice and invalidation — 12 lines

| # | Say this |
|---|---|
| 1 | "Default to `vector` and pick something else only for a *measured* need: reference stability, both-end insertion, splice, or a fixed extent." |
| 2 | "`vector` is the only sequence container that is both contiguous and dynamically sized, so `data()` plus `size()` is a valid `span`." |
| 3 | "Amortized O(1) `push_back` bounds a *sequence*, not a call — one append can allocate and relocate everything, and that's your tail latency." |
| 4 | "`deque` end-insertion keeps references valid but invalidates iterators, has no `reserve`, and isn't contiguous." |
| 5 | "`list` and `forward_list` buy O(1) splice and stable handles for one allocation, two link words, and a cache miss per element." |
| 6 | "Ordered containers give O(log n) lookup plus ordered range queries; unordered give average O(1) with worst-case O(n) and no defined iteration order." |
| 7 | "Flat containers (C++23) are sorted-sequence adaptors: O(log n) lookup, O(n) mutation, the best traversal locality, and no node handles." |
| 8 | "Ordered insert invalidates nothing and ordered erase invalidates only handles to the erased element; unordered rehash invalidates iterators but not references or pointers." |
| 9 | "`map::operator[]` is a mutation — on a miss it inserts a value-initialized mapped value and may allocate; use `find`, `try_emplace`, or `insert_or_assign`." |
| 10 | "Heterogeneous lookup needs a transparent comparator, and for unordered containers a transparent hash **and** equality (C++20) — that's how you find by `string_view` without materializing a `string`." |
| 11 | "Mutating a key's ordering or hash value while it sits in a container silently corrupts the container; extract, mutate, reinsert." |
| 12 | "`remove_if` doesn't erase — it partitions and returns the new logical end; `std::erase_if` (C++20) is the one-call form." |
| 13 | "Dense bounded integer keys beat every associative container: index a `vector` directly." |
| 14 | "For hot paths I prefer pre-sized flat storage plus indices or generation handles over node containers with per-element allocation." |

---

### S.5 Templates, concepts, and overload resolution — 10 lines

| # | Say this |
|---|---|
| 1 | "A template is a compile-time recipe: `f` is not a function and `Box` is not a type — `f<int>` and `Box<int>` are." |
| 2 | "Instantiating a class template does **not** instantiate its member function bodies, which is why an unused member with nonsense in it still compiles." |
| 3 | "Deduction matches the parameter pattern against the argument type using only decay, qualification, and derived-to-base conversions — no user-defined conversions, and the return type never drives it." |
| 4 | "Function templates can be fully specialized but never *partially* specialized — the answer is constrained overloading." |
| 5 | "Non-template beats template on an otherwise-equal tie; between two templates the more specialized, or in C++20 the more constrained, wins." |
| 6 | "At most **one** user-defined conversion per implicit conversion sequence, with a standard conversion permitted on each side of it." |
| 7 | "Ambiguity means two candidates each win on a different argument, so neither is better on every argument and strictly better on one." |
| 8 | "Members of a *dependent* base are invisible to unqualified lookup — write `this->m` or `Base<T>::m`." |
| 9 | "A satisfied concept proves **syntax**, never semantics: `strict_weak_order` can't prove transitivity and `regular_invocable` can't prove purity." |
| 10 | "SFINAE removes a candidate only for substitution failures in the *immediate context*; an error inside an instantiated body is a hard error." |
| 11 | "`if constexpr` discards the untaken branch at instantiation, but it must still parse and non-dependent errors still fire." |
| 12 | "Every distinct template-argument list is a distinct entity, so 'zero-cost abstraction' is a measurable claim about one build, not a property of the syntax." |

---

### S.5b Inheritance and polymorphism — 10 lines

| # | Say this |
|---|---|
| 1 | "Public inheritance means substitutability: every `Derived` must honour the `Base` contract wherever a `Base` is expected." |
| 2 | "A virtual call through a reference or pointer invokes the final overrider selected by the *dynamic* type; `virtual` is needed only on the first declaration and `override` turns a signature mismatch into a compile error." |
| 3 | "An override must match the parameter list, cv-qualification, and ref-qualification exactly — only the return type may be covariant, and only for raw pointers and references." |
| 4 | "Default arguments bind by *static* type while the body binds by dynamic type, so never redeclare a default in an override." |
| 5 | "Any same-name declaration in a derived class hides the entire base overload set; `using Base::f;` brings it back." |
| 6 | "During base construction and destruction the dynamic type *is* the base, so a virtual call there never reaches a derived override." |
| 7 | "Slicing is copying a derived object into a base *value*: only the base subobject survives and the dynamic type becomes `Base`." |
| 8 | "`dynamic_cast<T*>` yields null on failure and `dynamic_cast<T&>` throws `bad_cast`; the source must be polymorphic." |
| 9 | "Vptr and vtable are a common ABI implementation, not a language guarantee — never `memcpy`, serialize, or assume their layout." |
| 10 | "CRTP replaces dispatch with a `static_cast` to the derived type: inlinable, but there's no common runtime type and the code duplicates per instantiation." |
| 11 | "I choose on the type set: open means virtual or type erasure, closed means `variant`, compile-time-known means template or CRTP." |
| 12 | "Batching removes dispatch cost entirely — one virtual call per span rather than one per element." |

---

### S.6 Lifetime and undefined behaviour — 12 lines

| # | Say this |
|---|---|
| 1 | "Storage duration is when the bytes exist; lifetime is when a `T` lives in them — two independent axes, and `malloc` is not a constructor." |
| 2 | "A temporary dies at the end of its full-expression unless a reference binds *directly* to it, and lifetime extension never propagates through a function return or a second reference." |
| 3 | "A view never extends a lifetime — `string_view`, `span`, and every `views::` adaptor dangle over a destroyed owner." |
| 4 | "Reusing the storage of a live object ends its lifetime without running the destructor, which leaks whatever the destructor was required to do." |
| 5 | "Pointer arithmetic is defined only within one array object, including one-past-the-end, and that one-past pointer compares but may never be dereferenced." |
| 6 | "Provenance is real: forging an address with the right numeric value is still UB, because the optimizer tracks which allocation a pointer came from." |
| 7 | "Only `char`, `unsigned char`, and `std::byte` glvalues may inspect an arbitrary object's representation; any other unrelated type is a strict-aliasing violation." |
| 8 | "Every typed access needs four independent proofs — bounds, alignment, a live object of that type, and a permitted access type — and none of them substitutes for another." |
| 9 | "Hardware tolerating unaligned loads doesn't legalize a misaligned typed lvalue on the abstract machine." |
| 10 | "UB is not a runtime branch you can test after the fact: a null check after the dereference, or a bounds check after the subscript, may legally be deleted." |
| 11 | "Signed overflow, out-of-bounds access, use-after-free, data races, aliasing violations, and misalignment are *premises* the optimizer reasons from, not merely bugs that might crash." |
| 12 | "Lifetime bugs hide at `-O0` and surface under load, because freed storage gets reused sooner." |
| 13 | "`memcmp == 0` is not value equality — padding, multiple representations, `-0.0`, NaN, and pointers all break it." |
| 14 | "`std::launder` creates nothing; it only retargets a pointer in the narrow cases where transparent replaceability fails, such as const or reference members." |

---

### S.7 Memory model and atomics — 15 lines

| # | Say this |
|---|---|
| 1 | "A memory location is one scalar object, or one maximal run of adjacent non-zero-width bit-fields — which is why concurrent writes to adjacent bit-fields race." |
| 2 | "Two evaluations conflict if they touch overlapping storage and at least one is a write or a lifetime transition." |
| 3 | "Only three things make a shared access safe: it's atomic, it's ordered by a happens-before edge, or the object isn't actually shared." |
| 4 | "Sequenced-before is within-thread only; happens-before is sequenced-before plus inter-thread synchronization, closed transitively." |
| 5 | "Synchronizes-with edges come only from operations the standard names: release/acquire pairs, mutex unlock/lock, `join`, futures, `latch`, `barrier`, thread start." |
| 6 | "A mutex `unlock` synchronizes-with the next successful `lock` of the same mutex — that's the entire guarantee, it is not 'flushing the cache'." |
| 7 | "A mutex protects an **invariant**, not a variable: two separate `atomic<long>` fields still can't be read as one consistent pair." |
| 8 | "Every atomic object has one total modification order that even `relaxed` respects; there's no inherent order *across* different atomic objects except the single total order over `seq_cst` operations." |
| 9 | "`acquire` does not mean 'read the freshest value' — it only supplies ordering *if* the load actually reads from the matching release or its release sequence." |
| 10 | "`acq_rel` is legal only on a read-modify-write; a store can't be acquire and a load can't be release." |
| 11 | "A CAS overwrites `expected` on failure with the observed value, so anything derived from it must be recomputed inside the loop." |
| 12 | "`compare_exchange_weak` may fail spuriously and belongs in a loop; `strong` never does and belongs in a single-shot." |
| 13 | "The default order on every atomic member is `seq_cst` — that's the correctness baseline, and I only weaken it with a written happens-before proof." |
| 14 | "`volatile` is neither atomic nor synchronizing; it's an observable-access rule for MMIO, and a `volatile` increment is not an RMW." |
| 15 | "Data-race freedom does not imply sequential consistency — relaxed and acq_rel programs admit outcomes no single interleaving explains." |
| 16 | "A fence needs an atomic read-from carrier to synchronize; a fence sitting next to plain data proves nothing." |
| 17 | "Atomic reachability is not lifetime — reclamation needs its own proof: hazard pointers, epochs, refcounts, or quiescence." |
| 18 | "ABA is a *representation* problem and use-after-free is a *lifetime* problem; a version tag fixes only the first." |
| 19 | "Weakening the memory order never removes cache-line ownership traffic — a hot atomic serializes its line even under `relaxed`." |
| 20 | "My proof order is: name the conflicting evaluations, exhibit a happens-before path or atomicity for each, prove lifetime, and only then talk about fences and cache cost." |

---

### S.8 Cache, layout, and latency — 10 lines

| # | Say this |
|---|---|
| 1 | "The standard specifies no cache hierarchy, line size, TLB, NUMA, or prefetcher — it gives me contiguity, alignment, layout queries, and the interference constants." |
| 2 | "I optimize the bytes and branches the dominant operation actually touches, not `sizeof` and not the asymptotic complexity." |
| 3 | "A contiguous walk lets the hardware prefetch; a pointer chain serializes, because the next address is only known after the current load returns." |
| 4 | "The working set has to count parallel arrays, indices, hash metadata, allocator blocks, and touched code — not just the payload." |
| 5 | "AoS wins when one pass consumes most fields of one object; SoA wins when a pass scans one or a few columns." |
| 6 | "`hardware_destructive_interference_size` is a recommended *minimum* separation to avoid false sharing and `hardware_constructive_interference_size` a recommended *maximum* span to co-locate; both are implementation-defined and ABI-affecting." |
| 7 | "False sharing is independent writes sharing a coherence unit and padding fixes it; true sharing is real contention on the same logical state and padding does nothing." |
| 8 | "Indices survive container reallocation and pointers don't — but indices then need bounds, a sentinel, and generation rules." |
| 9 | "A branchless rewrite must never evaluate what the guarded branch would have skipped: no out-of-bounds load, no divide by zero, no invalid shift, no signed overflow." |
| 10 | "Batching amortizes synchronization, call overhead, and bounds checks while delaying the first element and enlarging the live set — so every batch needs a flush deadline." |
| 11 | "Inlining and specialization improve one kernel and can simultaneously make the binary worse through instruction-cache and branch-target pressure." |
| 12 | "'Zero-cost' means an abstraction *can* compile to the hand-written equivalent — it's an evidence claim about a build, not a language guarantee." |

#### S.8b Numbers worth quoting (order of magnitude, typical modern x86 server — say "roughly" and offer to measure)

| Operation | Rough cost |
|---|---|
| L1 hit | ~1 ns / ~4 cycles |
| L2 hit | ~4 ns |
| L3 hit | ~15–40 ns (socket-dependent) |
| Local DRAM | ~70–100 ns |
| Remote-NUMA DRAM | ~120–200 ns |
| Cache line transferred from another core | ~40–100 ns |
| Uncontended atomic RMW on a hot-in-L1 line | ~10–20 ns |
| Uncontended mutex lock+unlock | ~15–25 ns |
| `clock_gettime` via vDSO | ~15–30 ns |
| `rdtsc` | ~20–40 cycles, not serializing |
| Small `malloc`/`free` pair | ~20–100 ns, with a long tail |
| Futex wake plus context switch | ~1–5 µs |
| Typical cache line | 64 bytes (128 on some Apple/POWER parts) |
| Page | 4 KiB, with 2 MiB huge pages |

---

### S.9 Error handling and exception safety — 10 lines

| # | Say this |
|---|---|
| 1 | "I pick the channel from semantics: absence is `optional`, a recoverable failure is `expected`, an OS or library domain is `error_code`, a rare non-local failure is an exception, and a programmer bug is an assert or terminate." |
| 2 | "The four guarantees nest: no-throw contains strong, strong contains basic, basic contains none." |
| 3 | "'Strong' means commit-or-rollback of *this object's* observable state — it never rolls back I/O, logging, callbacks, or an external system." |
| 4 | "Catch class types by `const&`; catching by value slices, and handler order is first-match, so derived handlers must precede base handlers." |
| 5 | "`throw;` rethrows the current exception unchanged; `throw e;` copy-initializes a new object and slices when `e` is a base reference." |
| 6 | "If a constructor throws, the completed bases and members are destroyed but the object's own destructor never runs — so every resource must be acquired straight into an RAII member." |
| 7 | "Destructors are implicitly `noexcept`, so a throw escaping one during unwinding calls `std::terminate`; fallible finalization needs an explicit `close()` or `commit()`." |
| 8 | "`noexcept` is a promise that nothing escapes, not that the body can't throw internally — and a lying `noexcept` turns a recoverable error into process death." |
| 9 | "`optional`'s `*o` is unchecked and UB when disengaged; `value()` throws — they are not synonyms, and the same split applies to `expected`." |
| 10 | "`assert` is erased by `NDEBUG` *including its expression*, so it can never validate untrusted input or carry required control flow." |
| 11 | "The standard gives no cost guarantee for exceptions — not zero-cost on success, not allocation-free, not bounded unwind." |
| 12 | "An exception must never escape a C ABI boundary, a thread entry function, or a `noexcept` function — translate at the boundary." |

---

### S.10 Ownership and smart pointers — 10 lines

| # | Say this |
|---|---|
| 1 | "RAII binds a resource invariant to an object's lifetime: acquire in the constructor, release exactly once in a non-throwing destructor." |
| 2 | "Destructors run on every normal scope exit and during unwinding, and never on `abort`, `_Exit`, `quick_exit`, or the automatic objects abandoned by `std::exit`." |
| 3 | "`unique_ptr` is the default dynamic owner: non-copyable, movable, and zero overhead over a raw pointer for a stateless deleter — but the deleter is part of its type." |
| 4 | "`release()` hands ownership out and never deletes; `reset()` deletes." |
| 5 | "`unique_ptr<Incomplete>` compiles only if the owner's destructor is defined where the type is complete — that's the pImpl out-of-line destructor rule." |
| 6 | "Two `shared_ptr`s built independently from the same raw pointer get two control blocks and double-delete." |
| 7 | "The refcount is atomic and thread-safe; the pointee and the `shared_ptr` object itself are not, and `use_count()` is a racy snapshot." |
| 8 | "A `shared_ptr` cycle keeps the count above zero forever; make at least one edge a `weak_ptr`, and only `lock()` is race-free." |
| 9 | "`make_shared` co-allocates object and control block for locality, but weak owners then keep that whole block alive after the object dies, and it can't take a custom deleter." |
| 10 | "Pass `T&`, `T*`, `span`, or `string_view` to observe; pass a smart pointer only when ownership actually moves or is shared." |
| 11 | "On a hot path every `shared_ptr` copy is a contended atomic RMW and the last release runs the destructor on an arbitrary thread — I'd prefer values, `unique_ptr` transfer, or index/generation handles." |
| 12 | "An allocator decides where the bytes come from; it never decides when objects live or die." |

---

### S.11 Concurrency primitives — 12 lines

| # | Say this |
|---|---|
| 1 | "Destroying a joinable `std::thread` calls `std::terminate` — no silent detach and no silent join." |
| 2 | "`std::jthread` requests stop and then joins in its destructor, and injects a `stop_token` as the first parameter when the callable takes one." |
| 3 | "Declare `jthread` members **last**, so they join before the queues and mutexes they reference are destroyed." |
| 4 | "Cancellation is cooperative: `request_stop()` sets a flag and runs callbacks — it never interrupts a blocked syscall or unwinds a thread." |
| 5 | "Thread arguments are decay-copied into internal storage before invocation; `std::ref` opts into reference semantics and you then own the lifetime proof." |
| 6 | "A condition variable stores no event — the mutex-protected state stores the condition, and a notification only tells waiters to re-check." |
| 7 | "Always use the predicate form `wait(lock, pred)`: spurious wakeups are permitted and another waiter consuming the notification is normal." |
| 8 | "Prefer `wait_until` with an absolute deadline in a retry loop; repeating a relative `wait_for` after a spurious wake multiplies the intended timeout." |
| 9 | "A `binary_semaphore` is not a mutex — it carries no ownership, and any thread may `release()` a counting semaphore." |
| 10 | "`latch` is one-shot and never resets; `barrier` is reusable per phase with a `noexcept` completion function between phases." |
| 11 | "Default-policy `std::async` may *defer* until `get()`, and a discarded `std::launch::async` future blocks in its destructor and silently serializes the code." |
| 12 | "No standard mutex promises fairness, and `try_lock` may fail spuriously even when uncontended." |
| 13 | "Shutdown is an ordering protocol — stop admission, request stop, wake every waiter, drain or discard by policy, join, then destroy dependencies — not a destructor order." |
| 14 | "A coroutine is a transformation, not a runtime: `co_await` creates no thread, no scheduler, and no concurrency." |
| 15 | "The coroutine is fully suspended before `await_suspend` runs, so publishing the handle there is an ownership handoff — it may be resumed and destroyed before `await_suspend` returns." |

---

### S.12 Text, parsing, and numerics — 10 lines

| # | Say this |
|---|---|
| 1 | "`string_view` is a `{const char*, size_t}` pair: it owns nothing, copies nothing, extends no lifetime, and guarantees no null terminator — never hand a subview's `data()` to a C API." |
| 2 | "SSO exists in every mainstream implementation, but its threshold and layout are unstandardized, so 'short strings never allocate' is never a contract." |
| 3 | "`from_chars` skips no whitespace, accepts no leading `+`, infers no `0x`, allocates nothing, and touches no locale — and full-field validation needs both `ec == errc{}` **and** `ptr == last`." |
| 4 | "`to_chars` writes no null terminator and reports overflow as `errc::value_too_large`." |
| 5 | "Binary floating point can't represent decimal money exactly — parse fixed-point digit-by-digit into a scaled integer." |
| 6 | "Check overflow *before* the arithmetic: `acc > (limit - d) / 10` is the exact predicate, because a post-hoc sign test is already too late for signed types." |
| 7 | "`<cctype>` functions are UB on a negative plain `char` — cast to `unsigned char` first." |
| 8 | "Integral promotion runs before almost every arithmetic operator, so `uint8_t + uint8_t` is `int` arithmetic, and mixed signed/unsigned comparison converts the signed operand — that's what `std::cmp_less` fixes." |
| 9 | "NaN is unordered: `x != x` is true and all of `<`, `>`, `==` are false against it, which is exactly how it breaks a strict weak ordering." |
| 10 | "`steady_clock` is the only standard clock guaranteed monotonic and is the one for elapsed time and deadlines; `system_clock` can jump, and `high_resolution_clock` guarantees nothing." |
| 11 | "`duration_cast` truncates toward zero while `chrono::floor` truncates toward negative infinity — they differ for negative durations." |
| 12 | "Time points from different clocks are different domains: not comparable, not subtractable — subtracting them is the classic negative-latency bug." |
| 13 | "`accumulate` is a strictly ordered left fold; `reduce` may regroup, so floating-point results legitimately differ." |
| 14 | "`-ffast-math` silently repeals the NaN, infinity, signed-zero, `errno`, and associativity guarantees — build flags are part of numeric semantics." |

---

### S.12b Standards, build, and ABI — 10 lines

| # | Say this |
|---|---|
| 1 | "`__cplusplus` names the language mode selected, never the set of facilities actually implemented — the answer is a feature-test macro." |
| 2 | "Feature-test macro values are `YYYYMM` dates that get bumped when the feature is revised, so compare with `>=`, never with `==`, and get `__cpp_lib_*` from `<version>`." |
| 3 | "C++11 is the modern baseline (value categories, move, lambdas, the memory model); C++14 patches generic code; C++17 adds the vocabulary types and `if constexpr`; C++20 reshapes interfaces with concepts, ranges, coroutines, modules, and `<=>`; C++23 fills gaps with deducing `this`, `expected`, `mdspan`, `print`, flat containers, and `generator`." |
| 4 | "The as-if rule lets the implementation emit anything whose observable behaviour matches the abstract machine — volatile accesses, I/O, synchronization effects, and termination are observable; nothing else is." |
| 5 | "Optimization levels are toolchain policy, not language modes; the standard never mentions `-O2`." |
| 6 | "`inline` is an ODR facility — multiple identical definitions permitted, one address — and has never been a machine-code inlining command." |
| 7 | "Name mangling, calling conventions, vtable layout, and exception unwind are Itanium or MSVC ABI, not ISO C++; `extern "C"` fixes the symbol name and function type only." |
| 8 | "Adding, removing, or reordering non-static data members changes `sizeof` and offsets and breaks shared-library ABI; pImpl freezes the public size at one pointer for one allocation, one indirection, and total loss of inlining." |
| 9 | "ABI-relevant flags — standard-library version, exception model, iterator debug mode, layout-affecting macros — must match across every binary boundary or you have an IFNDR program." |
| 10 | "LTO lets the optimizer see across TUs and PGO feeds measured frequencies into layout and inlining — but a profile trained on the happy path can pessimize the rare latency-critical recovery path." |
| 11 | "`std::unreachable()` and `[[assume(expr)]]` (C++23) are premises, not checks: reaching or violating them is UB." |
| 12 | "Assembly answers 'what did this exact build emit', never 'is this fast'." |

---

### S.13 The blueprint designs — one line each, plus its key invariant

| # | Blueprint | What it is | Key invariant |
|---|---|---|---|
| 1 | Domain wrapper types (`#ch33`) | A one-member struct over a scalar with an explicit constructor and a capability-chosen operator set, normally register-passed and trivially copyable. | Affine split: coordinate ± delta is a coordinate, coordinate − coordinate is a delta, and coordinate + coordinate is never legal. |
| 2 | Binary wire decoder (`#ch34`) | A pure function from a bounded `span<const std::byte>` to `expected<Message, Error>`, reading fields by shift or `memcpy`, never by overlaying a struct. | Validate in dependency order and advance the cursor only after a successful read; `NeedMore` is a distinct outcome from `Malformed`, and success must consume more than zero bytes. |
| 3 | Zero-allocation text parser (`#ch35`) | Immutable `string_view` tokenization plus `from_chars` or hand-rolled fixed-point accumulation, returning a POD error code with a byte offset. | Every overflow test precedes the arithmetic, and "zero allocation" is scoped to a named phase, not to the whole program. |
| 4 | Bounded SPSC ring (`#ch36`) | A power-of-two array of raw aligned slots with two monotonic 64-bit counters on separate cache lines. | Each counter has exactly one writer; the owner loads its own counter relaxed and the other side's with acquire, and publishes with release after constructing the payload. |
| 5 | Fixed-capacity pool and bump arena (`#ch37`) | Aligned byte slots plus an intrusive free list, handed out as `{index, generation}` handles; the arena variant bumps one cursor and resets in O(1). | Every slot is free XOR occupied with `live + free == Capacity`; construct before unlinking, destroy before publishing the slot as free, and bump the generation on release. |
| 6 | Limit order book (`#ch38`) | Several redundant indexes over one logical state: a price index (dense ladder or tree) selecting a level, an intrusive FIFO chain carrying time priority, and an ID→handle map. | Time priority lives *only* in the chain links; all fallible work happens before any link mutation so the commit is `noexcept`, and derived state like best bid/ask is repaired in the same operation that changed it. |
| 7 | Read-mostly snapshot publication (`#ch40`) | Build privately, publish identity with a release store, reader acquires and then holds a lifetime right until done. | Visibility, consistency, and lifetime are three separate proofs — an atomic pointer publishes an address but neither owns nor reclaims the pointee. |
| 8 | Timer scheduler and event loop (`#ch41`) | An indexed heap or sorted vector of absolute `steady_clock` deadlines with generation-validated slots, driven by a predicate-looped `wait_until`. | A new *earliest* deadline must update the protected state **and** notify; equal deadlines need an explicit insertion-sequence tie-breaker or replay is nondeterministic. |
| 9 | Market-data pipeline (`#ch39`) | Framer → decoder → normalizer → sequencer → book, with exactly one mutating thread per book and SPSC handoffs between stages. | Borrowed bytes may cross a synchronous call boundary and never an asynchronous one; a normalized event owns everything it needs because the receive block is refilled immediately. |
| 10 | Telemetry and logging (`#ch42`) | One SPSC ring per producer thread carrying fixed-size trivially copyable records with a compile-time site ID; formatting, enrichment, and I/O live on the drain. | Full-queue behaviour is a named policy, loss is counted in a channel that can't itself be lost, and the fatal path uses a preallocated record and a pre-opened descriptor. |

---

### S.14 Trap questions and the one-line answer that defuses them

| # | If they ask | Say this |
|---|---|---|
| 1 | "Is `std::move` free?" | "The cast is free; whether anything is cheap depends entirely on which constructor gets selected and what it does." |
| 2 | "Does `noexcept` make it faster?" | "It changes which algorithms the library may use — notably `move_if_noexcept` during vector reallocation — and it is a correctness promise, not a speed knob." |
| 3 | "Are exceptions zero-cost?" | "The standard makes no cost guarantee at all; typical implementations are cheap on the non-throwing path and expensive when they throw, and I'd measure the tail." |
| 4 | "Is `shared_ptr` thread-safe?" | "The control block's refcount is; the pointee and the `shared_ptr` object itself are not." |
| 5 | "Is `vector<bool>` a vector of bools?" | "No — it's a bit-packed specialization whose `operator[]` returns a proxy, not a `bool&`." |
| 6 | "Why is `emplace_back` faster?" | "It often isn't; it constructs in place and forwards arguments, but it also bypasses `explicit` and can pessimize when the argument is already a `T`." |
| 7 | "Does `reserve` stop reallocation?" | "Only up to the reserved capacity, and it creates no elements — writing past `size()` is UB regardless." |
| 8 | "Is `volatile` enough for a flag between threads?" | "No — `volatile` gives no atomicity, no happens-before, and no synchronization; use `std::atomic`." |
| 9 | "Aren't aligned word writes atomic?" | "That's a hardware fact, not a C++ guarantee — the abstract machine still calls it a data race." |
| 10 | "Isn't `relaxed` just a faster `seq_cst`?" | "It's a *weaker* contract, not a faster instruction — and it removes no cache-line contention at all." |
| 11 | "Does `final` devirtualize?" | "It can enable devirtualization; it guarantees nothing, and a heterogeneous call site legitimately keeps the indirect branch." |
| 12 | "Can I `memcpy` a struct to the wire?" | "Trivially copyable means memcpy-round-trippable *in this process* — padding, endianness, and ABI are still protocol concerns." |
| 13 | "Is `unordered_map` O(1)?" | "Average O(1), worst case O(n), and average is not a latency bound — rehash, collisions, and allocation own the tail." |
| 14 | "Why not `#pragma pack` the message?" | "It changes implementation layout only: it creates no object, fixes no byte order, and can hand me misaligned member pointers." |
| 15 | "`std::endl` or `'\n'`?" | "`'\n'`; `endl` also flushes, and that flush is usually the cost you didn't intend." |
| 16 | "Is `[[likely]]` a speedup?" | "It's a hint about relative path frequency with no guaranteed instruction selection or layout." |
| 17 | "Is a lock-free queue always faster than a mutex?" | "No — lock-free is a progress property; under low contention a mutex is often faster, and the claim is void if allocation or a retry loop sits on the path." |
| 18 | "Does TSan prove my queue is correct?" | "It finds data races; it can't prove linearizability, progress, ABA, or reclamation safety, and a relaxed-only queue passes billions of iterations on x86." |
| 19 | "Can I catch `bad_alloc` and continue?" | "Only if I can prove I hadn't half-mutated the structure — a mid-commit invariant failure is terminal unless rollback is proven." |
| 20 | "Is your benchmark realistic?" | "Here's the compiler, flags, workload, metric boundary, and statistic — without those a number isn't a claim." |

---

### S.15 Testing, sanitizers, and benchmarking — 10 lines

| # | Say this |
|---|---|
| 1 | "A clean sanitizer run proves only that no enabled check fired on the paths actually executed in that instrumented binary — evidence, never proof of absence." |
| 2 | "ASan tracks addressability and lifetime, MSan tracks initializedness, TSan tracks happens-before — three different questions, and ASan and TSan can't share a binary." |
| 3 | "Build sanitizers at `-O1 -g -fno-omit-frame-pointer`: `-O0` hides optimizer-exploited UB and `-O2` inlines away the frames." |
| 4 | "Fix the **earliest** report — every later one may be a consequence of the first UB." |
| 5 | "I assert observable contracts — return values, event order, resource counts, digests — never private capacity, bucket count, or object address." |
| 6 | "`sleep_for` in a unit test measures the OS scheduler; I inject a manual clock and step to `deadline-1`, `deadline`, and `deadline+1`." |
| 7 | "`pmr::memory_resource` is the cheapest allocation seam: subclass it to count, to fail on the Nth call, and to detect leaks." |
| 8 | "Exhaustive failure injection is a loop over the throw budget, asserting the advertised guarantee and zero leaks at each step." |
| 9 | "Under the as-if rule an unused result can be deleted, so a microbenchmark can legally compile to an empty loop — the input has to be genuinely runtime-only." |
| 10 | "Batching B operations gives me a mean service cost and destroys the distribution — you cannot recover a p99 from it." |
| 11 | "Coordinated omission means a closed-loop generator that waits for each slow response under-samples exactly the stalls I care about; measure intended-arrival to completion." |
| 12 | "p99.9 from ten thousand samples rests on about ten observations, and autocorrelation makes the effective count smaller still." |

---

### S.16 Ten questions to ask the interviewer

| # | Ask this | What it signals |
|---|---|---|
| 1 | "What's the latency budget for the path this code sits on, and is it measured as mean or as a tail percentile?" | You think in distributions, not averages. |
| 2 | "Where is the measurement boundary — wire-to-wire, or in-process function entry to exit?" | You know most latency arguments are boundary disagreements. |
| 3 | "Which parts of the system are allowed to allocate at steady state, and how is that enforced rather than intended?" | You've built a real hot path. |
| 4 | "How is the threading model expressed — single writer per shard, or shared state with locks?" | You reach for ownership before synchronization. |
| 5 | "What's the policy when a bounded queue is full: reject, drop, block, or trigger recovery?" | You treat backpressure as correctness, not an edge case. |
| 6 | "How do you handle a sequence gap — is recovery a separate state machine or an `if` in the decoder?" | You've thought about the failure path, not just the happy one. |
| 7 | "What's your build and ABI story: one toolchain, pinned flags, LTO/PGO, and how are performance claims reproduced?" | You know a number without an environment is not a number. |
| 8 | "Do you run ASan, UBSan, and TSan in CI, and is there a fuzz corpus for the decoders?" | You expect correctness infrastructure, not heroics. |
| 9 | "How do you replay production traffic — do you capture at the byte/frame boundary so the whole pipeline is deterministic?" | You've debugged something nasty before. |
| 10 | "Which C++ standard do you actually build with, and what's the process for adopting a new one?" | You separate language mode from implemented facilities. |
| 11 | "What's the split between latency work and feature work on this team over a typical quarter?" | You're evaluating the job, not just passing the test. |
| 12 | "If I joined, what's the first component you'd want me to own, and what's currently painful about it?" | Confident, specific, forward-looking. |

---

### S.17 Phrases that signal seniority (and their opposites)

| # | Say | Instead of |
|---|---|---|
| 1 | "Who owns this, and how long does it live?" | "We can just pass a pointer." |
| 2 | "That's undefined behaviour, so the question isn't what happens — it's that the optimizer assumes it can't." | "It works on our compiler." |
| 3 | "The standard permits that; it doesn't require it." | "The compiler will optimize that away." |
| 4 | "That's implementation-defined — I'd check the ABI." | "It's 8 bytes." |
| 5 | "What's the invariant, and which operation is allowed to break it temporarily?" | "I'll add a mutex." |
| 6 | "Average O(1) isn't a latency bound." | "Hash maps are O(1)." |
| 7 | "I'd make the failure path a named policy rather than an accident." | "That shouldn't happen." |
| 8 | "Let me state which exception-safety guarantee I'm claiming." | "It's exception-safe." |
| 9 | "I'd do all the fallible work first and commit with a non-throwing operation." | "I'll wrap it in try/catch." |
| 10 | "That's a correctness bug that happens to show up as a performance number." | "It's just slow." |
| 11 | "I don't know that one — here's how I'd find out in five minutes." | Guessing confidently. |
| 12 | "I measured it; here's the compiler, flags, workload, and the percentile." | "It's faster." |
| 13 | "Single writer, bounded capacity, indices with generations, pre-reserved storage." | "We'll make it lock-free." |
| 14 | "Let me name the conflicting accesses before I talk about memory order." | "I'll use `seq_cst` to be safe." |
| 15 | "That's a protocol concern, not a language concern — it shouldn't leak past the adapter." | "We reinterpret the buffer." |

---

### S.18 Sixty-second whiteboard skeletons

| # | If asked to write | Open with |
|---|---|---|
| 1 | SPSC ring | Two `alignas(hardware_destructive_interference_size)` monotonic counters, raw `alignas(T) std::byte` slots, power-of-two mask, and the sentence "producer owns `write_`, consumer owns `read_`". |
| 2 | `unique_ptr` | Pointer + deleter member, `explicit` constructor, deleted copy, `noexcept` move that null-checks and swaps, destructor that calls the deleter on non-null. |
| 3 | Copy-and-swap assignment | Take the parameter **by value**, `swap` members, return `*this`, and say "self-assignment safe and strong-guaranteed at the cost of a temporary". |
| 4 | Fixed-size object pool | Slot array + free-list head + generation array, and the invariant sentence "free XOR occupied, `live + free == Capacity`". |
| 5 | Frame decoder | `expected<Msg, Err> decode(std::span<const std::byte>)`, then validation in dependency order, then "the cursor advances only after a successful read". |
| 6 | Thread-safe queue | State under one mutex, `wait(lock, pred)` on the condition variable, a `stop_token`-aware close, and a named full-queue policy. |
| 7 | Order book best-price query | Active-level bitmap plus `countr_zero`, and "best is only O(1) if empty-level removal is O(1) too". |
| 8 | Type-erased callable | A concept-model pair with a virtual `invoke`, an owning `unique_ptr<Concept>`, and the note that SBO is a QoI decision, not a guarantee. |

---

### S.19 The last 60 seconds

| # | Reminder |
|---|---|
| 1 | Answer the question that was asked, then offer the qualification — don't lead with the caveat. |
| 2 | Say the guarantee before the trivia; "release publishes everything sequenced before it" beats naming an instruction. |
| 3 | When you don't know, say so in one sentence and immediately say how you'd find out. |
| 4 | Draw the ownership arrows before writing any code; most design questions are lifetime questions in disguise. |
| 5 | Every bounded component you propose needs four sentences: capacity, failure policy, invariant, and the `noexcept` proof. |
| 6 | Never claim a performance number you can't attach an environment to. |
| 7 | If you catch your own error mid-answer, correct it out loud — that reads as rigor, not weakness. |
| 8 | Finish each answer; trailing off signals uncertainty you may not actually have. |
