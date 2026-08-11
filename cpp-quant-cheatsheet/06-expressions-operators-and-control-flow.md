# 6. Expressions, operators, and control flow

*Part I — Language foundations*

---

**Recall**
- Precedence and associativity decide *parsing*; evaluation order is a separate, mostly unspecified question.
- `f() + g()` groups left-to-right but may call `g` first — associativity never implies timing.
- Two unsequenced side effects on the same scalar object, or a side effect unsequenced with a value computation reading it, are UB.
- C++17 made function arguments *indeterminately sequenced*: `f(i++, i++)` is no longer UB, but which argument sees which value is unspecified.
- `&&`, `||`, built-in `,`, and `?:` are the only built-in operators guaranteeing left-to-right sequencing plus conditional evaluation.
- Overloading `&&`, `||`, or `,` destroys short-circuit and sequencing — the call becomes ordinary function-argument sequencing.
- Since C++17 assignment evaluates its **right** operand before its left; `a[i()] = j()` still leaves `i` vs `j` order unspecified.
- Integer operands narrower than `int` are promoted; `uint16_t * uint16_t` is `int` arithmetic and can overflow signed.
- Signed overflow is UB, unsigned wraps modulo 2^N, integer `/` truncates toward zero, `INT_MIN / -1` and `% 0` are UB.
- Shift count must satisfy `0 <= n < width(promoted left)`; anything else is UB regardless of signedness.
- Mixed signed/unsigned comparison converts the signed operand — use `std::cmp_less` and friends (C++20) instead.
- `<=>` yields `strong_ordering` / `weak_ordering` / `partial_ordering`; compare the result only against literal `0`.
- Defaulted `<=>` compares bases then non-static members lexicographically in declaration order and can implicitly declare `==`.
- Rewritten candidates turn `a < b` into `(a <=> b) < 0` and `a != b` into `!(a == b)`; reversed candidates try `b <=> a` negated.
- Compound assignment `x op= y` evaluates `x` exactly once, computes in the promoted type, then converts back — narrowing is silent.
- `[[likely]]`/`[[unlikely]]` are hints about *relative* path frequency; they guarantee no instruction selection, layout, or speedup.
- `if constexpr` discards the non-taken branch at instantiation; the discarded statement must still parse and non-dependent errors still fire.
- `if consteval` (C++23) selects on manifest constant evaluation; `std::is_constant_evaluated()` in an `if constexpr` is always `true` (a trap).
- Range-for extends the lifetime of the top-level range temporary; C++23 (P2718R0) extends *all* temporaries in the for-range-initializer, but by-value parameters destroyed in the callee still dangle.
- RAII cleanup runs on `return`, `break`, `continue`, `goto`, and unwinding — never on `std::abort`, `_Exit`, or `std::terminate`.

---

## 6.1 Operator precedence, associativity, and evaluation order

| Level | Operators | Associativity |
|---|---|---|
| 1 | `::` | (none) |
| 2 | `a++ a--` `T()` `T{}` `f()` `a[]` `.` `->` | left → right |
| 3 | `++a --a` `+a -a` `!` `~` `(T)a` `*a` `&a` `sizeof` `co_await` `new` `delete` | right → left |
| 4 | `.*` `->*` | left → right |
| 5 | `* / %` | left → right |
| 6 | `+ -` | left → right |
| 7 | `<< >>` | left → right |
| 8 | `<=>` | left → right |
| 9 | `< <= > >=` | left → right |
| 10 | `== !=` | left → right |
| 11 | `&` | left → right |
| 12 | `^` | left → right |
| 13 | `\|` | left → right |
| 14 | `&&` | left → right |
| 15 | `\|\|` | left → right |
| 16 | `?:` `throw` `co_yield` `=` `+= -= *= /= %= <<= >>= &= ^= \|=` | right → left |
| 17 | `,` | left → right |

```cpp
// ---- the five precedence bugs that actually appear in interviews --------
bool ok    = flags & ready == 0;      // parses flags & (ready == 0)   — BUG
bool clear = (flags & ready) == 0;    // intended

int x = a + b << 2;                   // (a + b) << 2   — '+' binds tighter than '<<'
int y = a << b + 2;                   // a << (b + 2)

bool bad  = 0 < x < 10;               // (0 < x) < 10 → bool promoted, always true
bool good = 0 < x && x < 10;

if (a & 1 == 0) {}                    // a & (1 == 0) → a & 0 → always false
if ((a & 1) == 0) {}

*p++;                                 // *(p++)  — postfix binds tighter than unary *
(*p)++;                               // increment the pointee

a = b = 0;                            // right-assoc: a = (b = 0)
p ? q : r ? s : t;                    // right-assoc: p ? q : (r ? s : t)
-x % y;                               // (-x) % y  — unary binds tighter
new int[n]{};                         // array new, value-initialized
```

```cpp
// ---- grouping is NOT timing --------------------------------------------
int v = f() + g() + h();   // groups ((f()+g())+h());  call order UNSPECIFIED
                           // any of the 6 permutations is conforming

// Force order by naming intermediates — the only portable technique.
auto const a1 = f();
auto const a2 = g();
auto const a3 = h();
int v2 = a1 + a2 + a3;
```

```cpp
// ---- parenthesization affects grouping, and for FP also the result -----
double s1 = (a + b) + c;   // different rounding from a + (b + c): FP '+' is not associative
// The compiler may NOT reassociate FP without -ffast-math.
```

| Question | Answer |
|---|---|
| Does precedence order evaluation? | No — it only decides which operands belong to which operator. |
| Does associativity order evaluation? | No — same-precedence grouping only. |
| Do parentheses order evaluation? | No, except where the enclosed construct itself sequences (`&&`, `,`, …). |
| Which built-ins order operands? | `&&`, `\|\|`, `,`, `?:`, `->*`/`.*` (C++17), `=` (right before left), `<<`/`>>` on streams (C++17 left→right). |

**Traps** — `&`/`|`/`^` sit *below* `==`, a C inheritance that never gets fixed · `a < b < c` compiles silently · casting `(T)a * b` is `((T)a) * b` · `sizeof x + 1` is `(sizeof x) + 1` · conditional's middle operand is parsed as if parenthesized, so `a ? b = 1 : c` is legal.

---

## 6.2 Sequenced-before, indeterminately sequenced, and unsequenced operations

| Term | Definition | Consequence |
|---|---|---|
| Sequenced-before | A's value computation *and* side effects complete before B starts | deterministic, safe |
| Indeterminately sequenced | A before B, or B before A, never interleaved | order unspecified, **no UB** |
| Unsequenced | no ordering at all; may interleave | conflicting access to same object ⇒ **UB** |
| Full-expression | outermost expression not part of another; end is a sequence point for all its side effects | temporaries die here |

```cpp
// ---- UB: conflicting unsequenced side effects --------------------------
int i = 0;
// int a = i++ + i++;        // UB — two unsequenced modifications of i
// int b = i++ + i;          // UB — modification unsequenced with a read of i
// i = i++;                  // UB pre-C++17; well-defined C++17+ (RHS before LHS)... but
// i = ++i + 1;              // still UB-prone across compilers; never write it
// a[i] = i++;               // UB pre-C++17; defined C++17+ (RHS first)
// f(i) + g(i)               // fine unless BOTH modify i
```

```cpp
// ---- guaranteed sequencing, by construct -------------------------------
a && b;      // a sequenced-before b; b NOT evaluated if a is falsy
a || b;      // a sequenced-before b; b NOT evaluated if a is truthy
c ? a : b;   // c sequenced-before the chosen arm; exactly one arm evaluated
(a, b);      // built-in comma: a sequenced-before a, value/category is b's
a = b;       // C++17: b (RHS) sequenced-before a (LHS), then the store
a[b];        // C++17: a sequenced-before b  (built-in subscript)
a << b;      // C++17: a sequenced-before b  (applies to overloaded << too)
a .* b;      // C++17: a sequenced-before b
new T(args); // C++17: allocation sequenced-before argument evaluation
{ x, y, z }; // braced-init-list: STRICTLY left-to-right, each sequenced-before the next
f(x, y);     // args indeterminately sequenced w.r.t. each other; postfix-expr first (C++17)
```

```cpp
// ---- C++17 fixed the classic "leak" case ------------------------------
void sink(std::unique_ptr<A>, std::unique_ptr<B>);
sink(std::unique_ptr<A>(new A), std::unique_ptr<B>(new B));
// pre-C++17: new A, new B, ctor, ctor interleaving could leak if one threw.
// C++17: each argument's initialization is indeterminately sequenced (atomic
// w.r.t. the other) → no interleave → no leak. Still prefer make_unique.
```

```cpp
// ---- indeterminate does not mean deterministic -------------------------
int i = 0;
consume(i++, i++);  // no UB (C++17); i == 2 afterwards;
                    // WHICH parameter gets 0 and which gets 1 is unspecified.

// Deterministic rewrite:
auto const first  = i++;
auto const second = i++;
consume(first, second);
```

```cpp
// ---- overloaded operators lose operator sequencing --------------------
struct S { bool operator&&(S) const; };   // BAD API
S a, b;
a && b;   // this is a FUNCTION CALL: both operands always evaluated,
          // indeterminately sequenced, no short circuit.
// Same for overloaded operator|| and operator, — do not overload these.
// std::valarray historically overloads them; ranges/views deliberately do not.
```

| Construct | Sequencing (C++17/23) |
|---|---|
| `&&`, `\|\|` | left sequenced-before right; right conditionally skipped |
| `?:` | condition before selected arm; other arm not evaluated |
| built-in `,` | left before right |
| `=`, `op=` | right operand before left operand before the store |
| `[]`, `<<`, `>>`, `.*`, `->*` (built-in **and** overloaded) | left before right |
| function call | postfix-expression before args; args indeterminately sequenced |
| braced-init-list / aggregate init | strict left-to-right |
| default member initializers in a ctor | member declaration order, not mem-init-list order |
| full-expression `;` | everything before completes before the next begins |

**Interview line** — "Unsequenced conflicting access to the same scalar is UB; C++17 made function arguments *indeterminately* sequenced, which removes the UB but not the unspecified order."

**Traps** — `v[i] = v[i++]` still smells even when legal · `std::cout << f() << g()` ordering was only fixed in C++17 · thread-level sequencing is a different model (happens-before, see atomics) · `volatile` accesses are still unsequenced with respect to each other unless sequencing rules apply.

---

## 6.3 Arithmetic, comparison, logical, bitwise, and shift operators

```cpp
// ---- integral promotion + usual arithmetic conversions -----------------
std::uint16_t x = 60'000, y = 2;
auto p = x * y;             // both promoted to int → int(120000); NOT uint16_t
static_assert(std::is_same_v<decltype(p), int>);

char c = 'a';
auto q = +c;                // int — unary + forces promotion (idiom for printing chars)

unsigned u = 1; int s = -1;
bool b1 = (s < u);          // FALSE: s converts to unsigned → 4294967295
bool b2 = std::cmp_less(s, u);   // true — C++20 <utility>, no conversion
```

| Rank order for usual arithmetic conversions | Rule |
|---|---|
| any operand `long double` / `double` / `float` | other converts to it |
| both integral | promote each to at least `int` |
| same signedness | lower rank converts to higher rank |
| unsigned rank ≥ signed rank | signed converts to **unsigned** |
| signed type can represent all unsigned values | unsigned converts to signed |
| otherwise | both convert to unsigned version of the signed type |

| Hazard | Rule |
|---|---|
| signed overflow (`+ - * << ` , `abs(INT_MIN)`) | **UB** |
| unsigned overflow | wraps modulo 2^N — defined |
| integer `/` or `%` by zero | **UB** |
| `INT_MIN / -1`, `INT_MIN % -1` | **UB** (result unrepresentable) |
| integer division | truncates toward zero; `-7/2 == -3`, `-7%2 == -1` |
| `%` sign | takes the sign of the dividend |
| narrowing on conversion to unsigned | modulo, defined |
| narrowing to signed (out of range) | implementation-defined pre-C++20; **modulo (two's complement) since C++20** |
| float → int conversion out of range | UB |
| `0.0/0.0` | NaN (IEEE); no trap guaranteed |

```cpp
// ---- comparison semantics ---------------------------------------------
double n = std::numeric_limits<double>::quiet_NaN();
n == n;        // false
n != n;        // TRUE — the only comparison NaN satisfies
n < n;         // false;  n >= n false — beware "!(a<b) implies a>=b" reasoning

int* p1; int* p2;
p1 == p2;      // compares addresses, never pointees
// p1 < p2;    // only defined within one array/object; else unspecified

std::string a = "abc", b = "abd";
a < b;         // lexicographic via char_traits, not pointer compare
```

```cpp
// ---- logical operators -------------------------------------------------
if (msg != nullptr && msg->valid()) {}     // safe: deref guarded by short circuit
if (msg != nullptr & msg->valid()) {}      // UB when null: & evaluates BOTH

bool t = !!ptr;                            // contextual conversion to bool idiom
static_assert(std::is_same_v<decltype(1 && 2), bool>);   // result is bool
```

```cpp
// ---- bitwise on unsigned; enum needs a cast ---------------------------
enum class Flag : std::uint32_t { read = 1u << 0, write = 1u << 1, exec = 1u << 2 };
constexpr Flag operator|(Flag a, Flag b) noexcept {
    return Flag(std::to_underlying(a) | std::to_underlying(b));   // C++23 <utility>
}
constexpr bool has(Flag set, Flag f) noexcept {
    return (std::to_underlying(set) & std::to_underlying(f)) != 0;
}

std::uint32_t flags = 0b1010;
flags |=  1u << 2;        // set bit
flags &= ~(1u << 1);      // clear bit
flags ^=  1u << 3;        // toggle bit
bool bit2 = (flags >> 2) & 1u;
std::uint32_t lowest = flags & (~flags + 1u);   // isolate lowest set bit
std::uint32_t clearlo = flags & (flags - 1u);   // clear lowest set bit
```

```cpp
// ---- shifts ------------------------------------------------------------
// UB unless 0 <= count < std::numeric_limits<promoted-left>::digits (+1 if signed)
std::uint32_t v = 1;
v << 31;                    // fine: unsigned, count 31 < 32
// 1 << 31;                 // UB-adjacent: 1 is int; C++20 made it defined (two's compl.)
//                          // but 1 << 32 is ALWAYS UB
// v << 32;                 // UB — count == width
// v >> -1;                 // UB — negative count

std::int32_t sneg = -8;
sneg >> 1;                  // C++20: arithmetic shift, == -4 (impl-defined before)
// sneg << 1;               // C++20: defined as if unsigned then converted

constexpr std::uint32_t bit(unsigned n) noexcept {
    return n < 32u ? (std::uint32_t{1} << n) : 0u;   // count validated
}
```

| `<bit>` (C++20) | Effect |
|---|---|
| `std::rotl(x, n)` / `std::rotr(x, n)` | rotate; `n` may be any value including negative |
| `std::countl_zero` / `countl_one` / `countr_zero` / `countr_one` | leading/trailing run lengths |
| `std::popcount(x)` | set-bit count |
| `std::has_single_bit(x)` | exactly one bit set (power of two) |
| `std::bit_width(x)` | bits needed = `digits - countl_zero` |
| `std::bit_ceil(x)` / `bit_floor(x)` | round to power of two (`bit_ceil` UB if unrepresentable) |
| `std::bit_cast<To>(from)` | reinterpret bits, `constexpr`, requires equal sizes + trivially copyable |
| `std::byteswap(x)` | **C++23**, reverse bytes |
| `std::endian::native/little/big` | endianness enum |

| `<utility>` safe integer compare (C++20) | Meaning |
|---|---|
| `std::cmp_equal/cmp_not_equal` | value-correct `==`/`!=` across signedness |
| `std::cmp_less/cmp_greater/cmp_less_equal/cmp_greater_equal` | value-correct relational |
| `std::in_range<T>(v)` | is `v` representable in `T`? |

| `<numeric>` / `<cmath>` overflow-safe helpers | Meaning |
|---|---|
| `std::midpoint(a, b)` | C++20, no-overflow average, rounds toward `a` |
| `std::lerp(a, b, t)` | C++20, monotonic linear interpolation |
| `std::abs` on `INT_MIN` | UB — use a wider type |
| `std::fma(a,b,c)` | single-rounding `a*b+c` |

**Traps** — `size() - 1` on an empty container is a huge `size_t` · `-1 < 0u` is false · `x * 2 / 2` is not `x` for signed overflow · `%` of negatives is not mathematical mod (use `((a % n) + n) % n`) · `char` signedness is implementation-defined, so `c & 0xFF` before shifting · `1 << n` in a 64-bit context is 32-bit arithmetic — write `1ull << n`.

---

## 6.4 Three-way comparison (`<=>`) and rewritten comparison candidates

| Category | Guarantees | `==` implies | Typical domain |
|---|---|---|---|
| `std::strong_ordering` | total order, equal values are substitutable | indistinguishable | integers, enums, `string` |
| `std::weak_ordering` | total order over equivalence classes | equivalent, not substitutable | case-insensitive strings |
| `std::partial_ordering` | some pairs `unordered` | equivalent | floating point (NaN) |

```cpp
// values: strong_ordering::{less,equal,greater}  (equivalent == equal)
//         weak_ordering::{less,equivalent,greater}
//         partial_ordering::{less,equivalent,greater,unordered}
// Conversions: strong → weak → partial (one direction only).
```

```cpp
#include <compare>

struct Price {
    std::int64_t ticks{};
    friend constexpr auto operator<=>(Price const&, Price const&) = default; // strong_ordering
    // defaulted <=> ALSO implicitly declares defaulted operator== here
};

struct Bad {
    std::string name;
    double px;
    auto operator<=>(Bad const&) const = default;   // partial_ordering (double member)
    // note: == is memberwise ==, NOT derived from <=>
};

struct Custom {
    std::string sym;
    int qty;
    // Hand-written: order by sym then DESCENDING qty.
    friend std::weak_ordering operator<=>(Custom const& a, Custom const& b) {
        if (auto c = a.sym <=> b.sym; c != 0) return c;
        return b.qty <=> a.qty;
    }
    friend bool operator==(Custom const&, Custom const&) = default; // must be separate
};
```

```cpp
// ---- comparing the result: only against literal 0 ----------------------
auto c = a <=> b;
if (c < 0)  {}          // a < b
if (c > 0)  {}          // a > b
if (c == 0) {}          // equivalent under the returned category
if (c != 0) {}
// if (c == std::strong_ordering::less) {}   // legal but brittle
// if (c < d) {}                             // ill-formed: no ordering-vs-ordering compare
if (std::is_lt(c)) {}   // named helpers: is_eq is_neq is_lt is_lteq is_gt is_gteq
if (c == std::partial_ordering::unordered) {}  // the ONLY way to detect unordered
```

```cpp
// ---- rewritten and reversed candidates ---------------------------------
// Written        Candidates the compiler also considers
// a <  b    →    (a <=> b) < 0        and reversed  0 < (b <=> a)
// a >= b    →    (a <=> b) >= 0       and reversed  0 >= (b <=> a)
// a != b    →    !(a == b)            and reversed  !(b == a)
// a == b    →    reversed b == a
// Consequence: ONE hidden-friend operator== gives you both a==b and b==a
//              for heterogeneous types — no more 2N boilerplate overloads.

struct Ticks {
    std::int64_t v;
    friend constexpr bool          operator==(Ticks a, std::int64_t b) { return a.v == b; }
    friend constexpr std::strong_ordering operator<=>(Ticks a, std::int64_t b) { return a.v <=> b; }
};
static_assert(Ticks{5} == 5);
static_assert(5 == Ticks{5});     // reversed candidate — no second overload written
static_assert(5 < Ticks{6});      // rewritten + reversed
```

```cpp
// ---- library support ---------------------------------------------------
std::strong_ordering  s = std::strong_order(1.0, 2.0);   // total order over floats incl. NaN/-0
std::weak_ordering    w = std::weak_order(1.0, 2.0);
std::partial_ordering p = std::compare_three_way{}(1.0, nan);   // unordered

using C = std::common_comparison_category_t<std::strong_ordering,
                                            std::partial_ordering>;  // partial_ordering
static_assert(std::three_way_comparable<int>);                  // concept
static_assert(std::three_way_comparable_with<int, long>);
static_assert(std::totally_ordered<int> && std::equality_comparable<int>);

auto r = std::lexicographical_compare_three_way(a.begin(), a.end(),
                                                b.begin(), b.end());  // C++20
```

| Rule | Detail |
|---|---|
| Defaulted `<=>` return type | `auto` synthesizes `common_comparison_category_t` of all subobject comparisons |
| Defaulted `<=>` order | bases in declaration order, then non-static members in declaration order |
| Implicit `==` | declared only when `<=>` is *defaulted*; a user-written `<=>` does **not** give you `==` |
| Defaulted `==` | memberwise `==`, never routed through `<=>` (so it can be faster: size check first) |
| Arrays as members | compared element-wise |
| Reference / union / mutable members | defaulting is deleted for `<=>` with reference members changing meaning; unions defeat memberwise |
| `constexpr`/`noexcept` | deduced from the subobject operations |

**Interview line** — "A defaulted `<=>` gives you all four relational operators plus `==` and `!=` by rewriting; a *user-written* `<=>` gives you the four relationals but you must still write `==`."

**Traps** — `==` is never synthesized from a non-defaulted `<=>` · a `double` member silently downgrades your class to `partial_ordering`, which breaks `std::sort`'s strict-weak-ordering requirement for NaN inputs · rewritten candidates can make a badly written `operator==(A,A)` recurse infinitely if it calls `==` on itself · comparing two `ordering` values is ill-formed · pre-C++20 code with both `operator<(A,B)` and `operator<(B,A)` can become ambiguous under reversed candidates.

---

## 6.5 Assignment, compound assignment, increment, and decrement

```cpp
// ---- assignment is an LVALUE referring to the left operand -------------
int a{}, b{};
a = b = 0;              // right-assoc: a = (b = 0)
(a = 3) += 4;           // legal: a == 7
int& r = (a = 5);       // binds to a

// C++17: RHS is sequenced BEFORE LHS.
std::vector<int> v(4);
int i = 0;
v[i] = i++;             // C++17: well-defined; i++ runs first → v[0] = 0, i == 1
```

```cpp
// ---- compound assignment evaluates the left operand ONCE ---------------
values[index()] += delta;                       // index() called exactly once
// values[index()] = values[index()] + delta;   // index() called TWICE — not equivalent

// It computes in the promoted/common type, then CONVERTS BACK (implicit narrowing,
// no narrowing diagnostic — unlike braced init).
std::uint8_t n = 250;
n += 10;                // int arithmetic 260 → converted back → 4
double d = 3.9;
int k = 1;
k += d;                 // k = int(1 + 3.9) = 4 — no warning from the compound form
// int k2{1 + d};       // ill-formed: narrowing in braced init IS diagnosed
```

| Operator | Meaning | Note |
|---|---|---|
| `=` | copy/move assignment | may be defaulted/deleted; returns `T&` by convention |
| `+= -= *= /= %=` | arithmetic; `%=` integral only | UB on div/mod by zero |
| `<<= >>=` | shift-assign | same shift-count UB rules |
| `&= \|= ^=` | bitwise, integral/enum-with-overload | |
| built-in `op=` | left operand once, promoted arithmetic, converted back | no sequence point beyond RHS-before-LHS |
| overloaded `op=` | ordinary member call; conventionally returns `T&` | not required to evaluate left once in any special way |

```cpp
// ---- increment / decrement forms ---------------------------------------
int i = 0;
++i;        // prefix: modifies, yields an LVALUE (int&) — chainable: ++++i legal
i++;        // postfix: yields a PRVALUE copy of the old value — (i++)++ ill-formed
--i; i--;
// bool b = false; b++;   // removed in C++17 (was deprecated); ++/-- on bool gone

int* p = nullptr;
++p;        // pointer arithmetic in element units
// p += 1;  // same

// Canonical user-defined forms:
struct It {
    It& operator++()     { advance(); return *this; }          // prefix
    It  operator++(int)  { It old = *this; ++*this; return old; } // postfix: int is a dummy tag
    It& operator--()     { retreat(); return *this; }
    It  operator--(int)  { It old = *this; --*this; return old; }
};
```

```cpp
// ---- why ++it is the default habit -------------------------------------
for (auto it = m.begin(); it != m.end(); ++it) {}   // no copy constructed
// it++ builds and returns a copy; for trivial iterators the optimizer erases it,
// for heavy iterators (node handles, filter/transform views) it may not.
// C++20 input iterators may declare postfix++ returning void — `auto x = it++;` breaks.
```

**Traps** — `n += 10` on a small type wraps silently while `n = n + 10` at least widens visibly · `a = a++` is UB-prone; never write it · postfix on a proxy reference (`vector<bool>::reference`) copies a proxy, not a bit · returning `*this` from `op=` is a convention the language does not enforce, and forgetting it breaks `a = b = c` · self-assignment must be safe in a user-written `operator=` (check or use copy-and-swap).

---

## 6.6 Conditional, comma, member-access, call, and subscript expressions

```cpp
// ---- conditional operator ?: ------------------------------------------
auto const& best = is_bid ? bid_level : ask_level;   // LVALUE if both arms are
                                                     // lvalues of the same type
int  x = cond ? 1 : 2;                 // prvalue int
auto y = cond ? 1 : 2.0;               // common type double — 1 converts!
// auto z = cond ? 1 : "s";            // ill-formed: no common type
auto t = cond ? throw 1 : 2;           // throw arm has type void→ result is int
void v = cond ? f() : g();             // both void: legal, result is void

// Value category: prvalue unless BOTH arms are lvalues (or xvalues) of the same type.
int a{}, b{};
(cond ? a : b) = 5;                    // assigns through the lvalue result

// Bitfield/proxy arms decay to prvalues; ternary is right-associative:
auto grade = s >= 90 ? 'A' : s >= 80 ? 'B' : 'C';   // parses ... : (s>=80 ? 'B':'C')
```

```cpp
// ---- ?: dangling hazard -------------------------------------------------
std::string existing = "x";
std::string const& r = flag ? existing : "fallback";
// "fallback" converts → a TEMPORARY std::string is materialized, both arms become
// prvalue std::string, r extends its lifetime here — but returning r dangles:
// std::string const& pick(bool f, std::string const& s) { return f ? s : "z"; } // DANGLES

std::string_view sv = flag ? existing : std::string_view{"fallback"}; // no allocation
```

```cpp
// ---- comma operator ----------------------------------------------------
int q = (f(), g());          // f() evaluated and DISCARDED; result/category is g()'s
for (int i = 0, j = 9; i < j; ++i, --j) {}   // ',' in the init is a DECLARATOR separator;
                                             // in the iteration-expression it IS the operator
f(a, b);                     // argument separator, NOT the comma operator
f((a, b));                   // ONE argument: the comma operator
int arr[] = {1, 2};          // list separator
// Fold with comma is the C++17 idiom for "do this per pack element":
template<class... Ts> void print_all(Ts const&... xs) {
    ((std::cout << xs << ' '), ...);   // left fold over ',' — strictly left-to-right
}
```

```cpp
// ---- member access, call, subscript ------------------------------------
obj.member;      obj.template get<0>();     // '.'  on object/reference
ptr->member;     ptr->template get<0>();    // '->' chains through overloaded operator->
                                            // repeatedly until it yields a raw pointer
Base::method();  obj.Base::method();        // qualified: suppresses virtual dispatch
(obj.*pmf)(args); (ptr->*pmf)(args);        // pointer-to-member call — needs parens:
                                            // '()' binds tighter than '.*'
int Cls::* pmd = &Cls::field;               // pointer to data member
auto pmf2 = &Cls::method;                   // pointer to member function
std::invoke(pmf2, obj, args...);            // uniform call syntax (<functional>)

// Overloadable call/subscript:
struct Grid {
    int data[4][4]{};
    constexpr int&  operator[](std::size_t r, std::size_t c) noexcept { return data[r][c]; } // C++23 multidim
    constexpr int   operator()(std::size_t r, std::size_t c) const noexcept { return data[r][c]; }
    static constexpr int operator()(int v) noexcept { return v; }   // C++23 static operator()
    static constexpr int operator[](int v) noexcept { return v; }   // C++23 static operator[]
};
Grid g; g[1, 2] = 7;                       // C++23 multi-arg subscript
// int bad = arr[1, 2];                    // C++23: comma in subscript on an ARRAY is
                                           // deprecated/ill-formed (was arr[2])
```

| Expression | Rule |
|---|---|
| `a[b]` on built-in array/pointer | `*(a + b)`, so `arr[i] == i[arr]`; unchecked precondition |
| `a[b]` overloaded | ordinary member call; `a` sequenced-before `b` |
| `p->x` | requires `p` to point at a live object; overloaded `->` chains |
| `f(args)` | postfix-expression evaluated first; args indeterminately sequenced |
| `a.*p` / `a->*p` | null pointer-to-member is UB to call |
| `cond ? a : b` | one arm evaluated; result is lvalue only if both arms are same-type lvalues |
| `(a, b)` built-in | left evaluated then discarded; yields `b` |

**Traps** — `a ? b : c ? d : e` right-associates in the direction people misread · `?:` with mixed `unsigned`/`signed` arms applies usual arithmetic conversions and can flip a sign · `x.*p()` parses as `x.*(p())` — parenthesize the call · overloaded `operator,` breaks fold expressions and range algorithms (guard with `(void)`) · `container[i]` gives you zero bounds proof; `at()` or `span::subspan` when the index is untrusted.

---

## 6.7 Short-circuiting and branch hints

```cpp
// ---- ordering guards cheap→expensive and safe→unsafe -------------------
if (offset <= bytes.size() && length <= bytes.size() - offset) {
    decode(bytes.subspan(offset, length));   // subtraction can't underflow: guarded
}
// Wrong order:  length <= bytes.size() - offset && offset <= bytes.size()
//               → unsigned underflow when offset > size()

if (p && p->ready() && expensive_check(*p)) {}   // null → cheap → costly
if (idx < n && data[idx] == want) {}             // bounds before access
```

```cpp
// ---- && / || vs & / | ---------------------------------------------------
// bool ok = valid(p) & p->check();   // BUG: no short circuit, & evaluates both,
//                                    //      operands promote to int, result int→bool
// Only replace && with & when: both operands are already bool, both are side-effect
// free and always safe to evaluate, AND you have measured that the branch mispredicts.
bool const both = static_cast<bool>(a_flag) & static_cast<bool>(b_flag); // deliberate
```

```cpp
// ---- attributes: hints only ---------------------------------------------
if (type == common) [[likely]]   { hot(); }
else                [[unlikely]] { cold(); }

switch (op) {
    [[likely]]   case Op::add: return add();
    [[unlikely]] case Op::rare: return rare();
    default: return other();
}

for (auto&& x : xs) if (bad(x)) [[unlikely]] return handle(x);

while (running) [[likely]] { step(); }

[[noreturn]] void fatal(char const*);            // stronger than any hint: the path ends
[[assume(n > 0)]];                               // C++23: UB if false; enables optimization
```

| Mechanism | What it actually does |
|---|---|
| `[[likely]]` / `[[unlikely]]` | tells the optimizer a path is more/less probable *relative to alternatives*; affects block layout/inlining budget at best |
| `[[assume(expr)]]` (C++23) | promises `expr` is true; **UB if it is not**; `expr` is not evaluated |
| `[[noreturn]]` | function never returns; lets the caller drop the fall-through path |
| PGO (`-fprofile-generate/-use`) | real observed frequencies; strictly better information than a hand annotation |
| `__builtin_expect` | pre-C++20 spelling of the same hint |
| branchless arithmetic (`cmov`, masks) | trades a mispredict for unconditional work; loses short-circuit safety and may fault |

```cpp
// ---- "branchless" is a measurement, not a syntax -----------------------
int a1 = cond ? x : y;                  // compiler already emits cmov when profitable
int a2 = (-int(cond) & x) | (~-int(cond) & y);  // hand-masked: more instructions,
                                                // no safety win, harder to read
// Branchless is only a win when the branch is genuinely unpredictable AND both
// sides are cheap AND both are safe to evaluate (no deref, no division by zero).
```

**Interview line** — "`[[likely]]` is a hint about relative frequency, not a promise about generated instructions; the only reliable source of branch information is a profile."

**Traps** — hiding a side effect behind `&&` makes it conditional and unauditable (`if (ok && log())`) · reordering `&&` operands for speed can remove a safety guard · `[[assume]]` with a false predicate is UB, not a no-op · marking both arms `[[likely]]` is meaningless · a hint on a branch the compiler already predicts correctly can grow code size and hurt I-cache.

---

## 6.8 `if`, `if constexpr`, `if consteval`, `switch`, loops, and range-for

```cpp
// ---- if with init-statement (C++17) ------------------------------------
if (auto r = decode(input); r) {
    consume(*r);
} else {
    record(r.error());
}                                   // r's scope covers BOTH arms and ends here

if (std::lock_guard lk{m}; queue.empty()) { /* ... */ }   // scoped lock over both arms
if (auto it = m.find(k); it != m.end()) use(it->second);

// C++23: alias-declaration allowed as the init-statement
if (using T = std::decay_t<decltype(x)>; std::is_integral_v<T>) {}   // C++23
```

```cpp
// ---- if constexpr: discards the untaken branch at instantiation --------
template<class T>
constexpr bool is_negative(T x) {
    if constexpr (std::is_signed_v<T>) return x < 0;
    else { (void)x; return false; }        // uint path never instantiates 'x < 0'
}

template<class T>
void dump(T const& t) {
    if constexpr (requires { t.size(); })       return show(t.size());
    else if constexpr (std::is_arithmetic_v<T>) return show_number(t);
    else                                        return show_opaque(t);
}

template<class T> void f(T t) {
    if constexpr (sizeof(T) > 4) { t.only_on_big(); }  // OK: dependent, discarded
    // static_assert(false);                    // pre-C++23 ill-formed even if discarded
    static_assert(sizeof(T) < 0, "bad T");      // idiom: make it dependent
}
// C++23 (P2593): static_assert(false) in a discarded/uninstantiated branch is OK.
```

```cpp
// ---- if consteval (C++23) ----------------------------------------------
constexpr int checked_square(int x) {
    if consteval {                 // true only during manifest constant evaluation
        if (x > 46340 || x < -46340) throw "overflow";   // compile-time diagnostic
    } else {
        assert(x <= 46340);        // runtime check
    }
    return x * x;
}
if !consteval { /* runtime-only path */ }        // negated form

// Contrast with std::is_constant_evaluated() (C++20, <type_traits>):
constexpr int g(int x) {
    if (std::is_constant_evaluated()) return slow_exact(x);   // OK
    // if constexpr (std::is_constant_evaluated())            // TRAP: always TRUE
    return fast(x);
}
// if consteval permits calling immediate (consteval) functions in its branch;
// is_constant_evaluated() does not.
```

```cpp
// ---- switch --------------------------------------------------------------
switch (auto s = classify(msg); s) {          // init-statement allowed (C++17)
    case Side::bid:  on_bid();  break;
    case Side::ask:  on_ask();  break;
    case Side::odd:
        log();
        [[fallthrough]];                      // C++17: silences -Wimplicit-fallthrough
    case Side::even: on_even(); break;
    default: std::unreachable();              // C++23 <utility>: UB if reached
}

switch (n) {
    case 1: case 2: case 3: small(); break;   // stacked labels
    // case 1+1: ...                          // constant expressions OK, duplicates ill-formed
    case 4: { int local = 0; use(local); break; }  // BRACES: a case cannot jump past an
                                                   // initialization into scope
}
```

| `switch` rule | Detail |
|---|---|
| Condition type | integral, enumeration, or class with a single non-explicit conversion to one |
| Case labels | converted constant expressions; duplicates after conversion are ill-formed |
| Fallthrough | implicit and legal; annotate deliberate cases with `[[fallthrough]];` |
| No `default` over a full enum | lets `-Wswitch` flag a newly added enumerator — often preferable |
| Jumping into scope | ill-formed if it bypasses a non-vacuous initialization; wrap cases in `{}` |
| Codegen | jump table, binary search, or if-chain — never guaranteed O(1) |
| Invalid enum value | still reachable via casts/IO; validate at the boundary or keep a terminal `default` |

```cpp
// ---- loops ---------------------------------------------------------------
for (std::size_t i = 0; i < n; ++i) {}         // classic
for (;;) {}                                    // infinite; a side-effect-free infinite
                                               // loop without goto/atomics is UB (forward progress)
while (cursor.has_message()) decode_one(cursor);
do { poll_once(); } while (!stopped());        // body runs at least once; needs ';'

for (auto const& e : batch) process(e);        // observe, no copy
for (auto& e : batch) e.touch();               // mutate
for (auto e : batch) consume(e);               // deliberate copy
for (auto&& e : gen()) use(e);                 // preserve proxy/prvalue category
for (auto&& [k, v] : map) use(k, v);           // structured binding
for (auto i : std::views::iota(0, n)) {}       // C++20
for (auto const& [i, e] : std::views::enumerate(batch)) {}   // C++23

// C++20 init-statement in range-for:
for (std::size_t i = 0; auto const& e : batch) { use(i, e); ++i; }
```

```cpp
// ---- what range-for expands to (C++17+ shape) --------------------------
{
    init-statement;                     // C++20
    auto&& __range = range-init;        // hidden forwarding ref: lifetime-extends the
                                        // TOP-LEVEL temporary through the loop
    auto __b = begin-expr;              // member begin() or ADL begin(__range)
    auto __e = end-expr;                // may be a different sentinel type (C++17)
    for (; __b != __e; ++__b) {
        for-range-declaration = *__b;
        statement;
    }
}
```

```cpp
// ---- lifetime: the C++23 fix and its remaining hole --------------------
for (auto&& x : make_vector()) use(x);            // OK in every standard: top-level temp

// Pre-C++23 DANGLING; fixed by P2718R0 in C++23:
for (auto&& x : make_vector() | std::views::filter(pred)) use(x);
for (auto c  : get_config().names()) use(c);      // C++23 extends the get_config() temp

// STILL DANGLING in C++23 — by-value parameter destroyed inside the callee:
std::span<int> id(std::vector<int> v) { return v; }        // returns a view into a param
// for (auto x : id(make_vector())) use(x);                // UB: v dies at return

// Mutating the range under the loop is still your problem:
for (auto& x : v) if (drop(x)) v.push_back(0);    // UB on reallocation
```

| Loop concern | Rule |
|---|---|
| Range temporary | top-level always extended; C++23 extends all for-range-initializer temporaries |
| Iterator invalidation | range-for caches `begin`/`end` once — container mutation inside is UB |
| `end` recomputation | `views::filter`, `istream_view` etc. use sentinels; `__e` may be cheap |
| Forward progress | a loop with no side effects, no volatile access, no atomic, and no I/O may be assumed to terminate |
| `auto` vs `auto&` vs `auto&&` | copy / mutate-in-place / preserve category (needed for `vector<bool>` and views) |
| Algorithm vs hand loop | neither is categorically faster; algorithms name intent, hand loops expose invariants |

**Traps** — `for (auto x : v)` copying heavy elements silently · `while (i-- > 0)` on unsigned never terminates when `i` starts at 0... it does, but `while (i >= 0)` on unsigned never terminates · `do{}while()` missing the semicolon · a `switch` on a `bool`-ish condition with `case 2:` compiles · `if constexpr` outside a template still evaluates both branches for parsing but discards neither's diagnostics on non-dependent code.

---

## 6.9 `break`, `continue`, `return`, and `goto`

```cpp
for (auto const& msg : batch) {
    if (!msg.valid()) continue;      // next iteration; in a `for`, the iteration
                                     // expression STILL runs (unlike `while` textual moves)
    if (stop(msg))    break;         // exits the innermost loop OR switch — not both
    apply(msg);
}

// `break` inside a switch inside a loop exits only the SWITCH:
for (;;) {
    switch (op) { case Op::quit: goto done; default: break; }  // 'break' left the switch
}
done: ;
```

```cpp
// ---- return -------------------------------------------------------------
Order make() {
    Order o{};
    return o;              // NRVO (optional) or implicit move (guaranteed to try move first)
}
Order make2() { return Order{}; }      // C++17 guaranteed elision: no move/copy at all
// return std::move(o);                // PESSIMIZATION: blocks NRVO
auto&& bad() { Order o; return o; }    // DANGLES: returning a ref to a local
void v() { return f_void(); }          // legal: returning a void expression from void
[[noreturn]] void die() { std::abort(); }
```

```cpp
// ---- goto and its restrictions -------------------------------------------
void parse() {
    Guard g{};                       // RAII: destructor RUNS on every goto out of scope
    if (!step1()) goto fail;
    if (!step2()) goto fail;
    return;
fail:
    record_failure();                // single cleanup exit — the C idiom
}

// Ill-formed: jumping INTO the scope of a variable with non-vacuous initialization.
// goto skip;
// std::string s = "x";              // error: jump bypasses initialization
// skip: use(s);
// Legal to jump past a declaration with NO initializer of trivial type:
goto ok; int raw; ok: raw = 1;

// Breaking out of nested loops — the three options:
for (i = 0; i < n; ++i) for (j = 0; j < m; ++j) if (hit(i,j)) goto found;  // 1: goto
found: ;
auto search = [&]() -> std::optional<std::pair<int,int>> {                 // 2: function+return
    for (int a = 0; a < n; ++a) for (int b = 0; b < m; ++b)
        if (hit(a,b)) return std::pair{a,b};
    return std::nullopt;
};
bool stop = false;                                                          // 3: flag (worst)
for (i = 0; i < n && !stop; ++i) for (j = 0; j < m; ++j) if (hit(i,j)) { stop = true; break; }
```

| Jump | Effect | Destructors |
|---|---|---|
| `break` | leaves innermost loop **or** `switch` | run for scopes exited |
| `continue` | jumps to loop's iteration-expression (`for`) / condition (`while`, `do`) | run for the body scope |
| `return` | initializes the result object, then unwinds the function's automatic objects | run, in reverse construction order |
| `goto` | label in the same function; cannot bypass a non-vacuous initialization | run for every scope exited |
| `throw` | stack unwinding to a matching handler | run |
| `co_return` | finishes a coroutine; resumes via the promise | coroutine frame locals destroyed |
| `std::abort` / `_Exit` / `std::terminate` / `quick_exit` | immediate | **not run** |
| `longjmp` past non-trivial destructors | | **UB** |

**Interview line** — "RAII cleanup runs for every *normal* control transfer out of a scope — `return`, `break`, `continue`, `goto`, and exception unwinding — but never for `abort`, `_Exit`, or `terminate`."

**Traps** — `continue` in a `do {} while (cond)` jumps to the *condition*, not the top · `break` cannot exit two loops · a `goto` into a `switch` case's braced block is often ill-formed · returning a reference to a local or to a by-value parameter dangles · `std::exit` runs static destructors and `atexit` handlers but not automatic ones on other threads.

---

## 6.10 Immediately invoked lambdas and expression-oriented idioms

```cpp
// ---- IIFE: complex initialization that still yields a const object ------
auto const config = [&] {
    Config c{};
    c.capacity = read_capacity();
    if (c.capacity == 0) c.capacity = default_capacity;
    validate(c);
    return c;                          // one initialization, no two-phase construct
}();                                   // note the trailing () — that's the call
// Without the IIFE: `Config config;` then mutate → cannot be const, can be observed
// half-built, and the "is it initialized yet?" invariant leaks into the whole scope.
```

```cpp
// ---- forms ---------------------------------------------------------------
auto a = []{ return 1; }();                        // no params, deduced return
auto b = [x = compute()]{ return x + 1; }();       // init-capture (C++14)
auto c = [&]() -> std::string { return "s"; }();   // explicit trailing return type
auto d = []<class T>(T v) { return v * 2; }(21);   // templated lambda (C++20)
auto e = []() static { return 1; }();              // C++23 static operator() — no captures
auto f = [] consteval { return 7; }();             // C++23: immediate-function lambda
auto g = std::invoke([&]{ return h(); });          // clearer to some readers than `()`
auto&& bad = [&]() -> Config& { Config c; return c; }();   // DANGLES: local returned by ref
```

```cpp
// ---- constexpr lookup tables built at compile time ---------------------
constexpr auto masks = [] {
    std::array<std::uint32_t, 32> out{};
    for (std::size_t i = 0; i < out.size(); ++i)
        out[i] = std::uint32_t{1} << i;
    return out;
}();
static_assert(masks[5] == 32u);       // forced constant evaluation

// `constexpr` on the variable REQUIRES compile-time evaluation.
// `constexpr` on a function only PERMITS it — call it in a constant context to force.
constinit static auto table = build();   // C++20: static init at compile time, mutable after
```

```cpp
// ---- switch-as-expression via IIFE (no uninitialized intermediate) -----
auto const fee = [&]() -> std::int64_t {
    switch (tier) {
        case Tier::maker: return -5;
        case Tier::taker: return 12;
    }
    std::unreachable();                 // C++23
}();
```

```cpp
// ---- init-once with a mutex / call_once, scoped ------------------------
static auto const& registry = [] () -> Registry& {
    static Registry r{load()};          // C++11 magic statics: thread-safe init
    return r;
}();

// ---- pack expansion + IIFE for per-type work ---------------------------
template<class... Ts>
void register_all() {
    ([]{ Registry::add<Ts>(); }(), ...);    // fold over ',': strict left-to-right
}
```

| Idiom | Why |
|---|---|
| IIFE-initialized `const` | one initialization, no partially built object, helper locals stay scoped |
| IIFE `constexpr` table | imperative loops inside a constant expression; `static_assert` verifies |
| IIFE around `switch` | turns a statement into an expression without a default-constructed placeholder |
| `std::invoke([...]{})` | same effect, some styles find the `()` easy to miss |
| Fold over `,` with a lambda | per-pack-element side effects in guaranteed order |
| Function-local `static` in an IIFE | thread-safe lazy init with a narrow interface |

**Interview line** — "An immediately invoked lambda converts multi-step initialization into a single expression, which is what lets the result be `const` and the helper state be scoped."

**Traps** — forgetting the trailing `()` stores the closure instead of the value · capturing by reference and storing the lambda outliving the referents dangles · returning a reference/`string_view`/`span` into a lambda local dangles just like any function · `constexpr` on a *function* does not force compile-time evaluation — only a constant-required context does · a large IIFE in a header inlines into every TU and can bloat debug builds.
