# 20. Strings, text, parsing, and formatting

*Part III — Standard library quick reference*

---

**Recall**
- The only questions that matter for a text type: who owns the code units, how many are valid, is a `'\0'` required, and what encoding contract applies.
- `std::string` owns contiguous code units and guarantees `s.data()[s.size()] == CharT{}` for C interop; embedded nulls are legal and counted by `size()`.
- `std::string_view` is a `{const CharT*, size_t}` pair — copying it copies no characters, extends no lifetime, and guarantees no terminator.
- SSO exists in every mainstream implementation but its threshold, layout, and existence are unstandardized — never encode "≤15 chars never allocates" as a contract.
- Any reallocating `string` mutation invalidates every pointer, reference, iterator, and `string_view` derived from it.
- `string::substr` allocates and copies; `string_view::substr` is O(1) and copies nothing.
- `string_view::remove_prefix/suffix` mutate the *view*, never the source; both are UB when the count exceeds `size()`.
- `<cctype>` functions require an argument representable as `unsigned char` or equal to `EOF` — passing a negative plain `char` is UB.
- `from_chars` skips no whitespace, accepts no leading `+`, consumes no `0x` prefix, allocates nothing, touches no locale, and can succeed partially.
- Full-field validation requires **both** `ec == std::errc{}` **and** `ptr == last`.
- `to_chars` writes no null terminator and reports overflow as `std::errc::value_too_large` with unspecified buffer contents.
- `std::format` returns an owning `string`, so it can allocate and throw; `format_to_n` bounds the *writes*, not the reported `size`.
- Format strings in `format`/`print` are compile-time checked via `std::format_string`; genuinely runtime strings need `std::vformat` + `std::make_format_args`.
- `{:>10.3f}` decomposes as fill·align·sign·`#`·`0`·width·precision·`L`·type; `{}` argument-ids may be all-automatic or all-manual, never mixed.
- Streams carry sentries, locale facets, sticky format flags, and dynamic buffers — `std::endl` also flushes; use `'\n'`.
- C++23 `std::spanstream` gives stream semantics over caller storage: exhaustion sets `failbit` instead of growing.
- Standard string types store code units — no validation, normalization, grapheme segmentation, case folding, or display-width measurement.
- `u8"..."` is `const char8_t[]` since C++20 and does **not** implicitly convert to `char const*`.
- The zero-allocation text stack is: `span`/`string_view` in, `from_chars` to parse, `to_chars`/`format_to_n` out, `expected` for failure.

---

## 20.1 C strings, null termination, and bounded operations

```cpp
#include <cstring>
#include <span>
#include <expected>
#include <algorithm>

char        a[]  = "ABC";          // {'A','B','C','\0'} — mutable array of 4
char const* p    = "ABC";          // pointer into a string literal — modifying is UB
char        raw[3] = {'A','B','C'};// NOT a C string: no terminator
char        pad[8] = "AB";         // {'A','B','\0',0,0,0,0,0} — rest zero-filled
char const  q[]  = {'A','B','C',0};// explicit terminator

auto n1 = sizeof a;                // 4  — array extent, valid only before decay
auto n2 = std::strlen(a);          // 3  — scans to first '\0', O(n)
auto n3 = std::size(a);            // 4  — <iterator>, extent not length
// std::strlen(raw);               // UB: reads past the object

template<std::size_t N>
constexpr std::size_t extent(char const (&)[N]) noexcept { return N; }  // bound preserved
void loses_extent(char const*);    // bound gone: array-to-pointer decay
void keeps_extent(std::span<char const>);           // pointer + size travel together
```

| `<cstring>` | Signature | Notes |
|---|---|---|
| `strlen` | `size_t strlen(const char*)` | O(n); UB without a reachable `'\0'` |
| `strnlen_s` | `size_t strnlen_s(const char*, size_t)` | C11 Annex K, optional |
| `strcpy` | `char* strcpy(char*, const char*)` | no bound — overflow is on you |
| `strncpy` | `char* strncpy(char*, const char*, size_t)` | **may not terminate**; pads to full `n` |
| `strcat` / `strncat` | `char* (char*, const char*[, size_t])` | O(dest+src); `strncat` always terminates |
| `strcmp` / `strncmp` | `int (const char*, const char*[, size_t])` | sign of first differing `unsigned char` |
| `strchr` / `strrchr` | `char* (const char*, int)` | first/last occurrence; searches the `'\0'` too |
| `strstr` | `char* (const char*, const char*)` | substring; naive complexity unspecified |
| `strspn` / `strcspn` / `strpbrk` | span of accepted/rejected chars | classic tokenizer primitives |
| `strtok` | `char* (char*, const char*)` | **stateful, non-reentrant, mutates input** — avoid |
| `memcpy` / `memmove` | `void* (void*, const void*, size_t)` | `memcpy` requires non-overlap; `memmove` allows it |
| `memcmp` / `memchr` / `memset` | byte-wise ops | `memcmp` compares as `unsigned char`, no short-circuit semantics |

```cpp
// Bounded copy with an explicit named failure — the shape to prefer.
enum class CopyError { too_small };

std::expected<std::size_t, CopyError>
copy_c_string(std::span<char> out, std::string_view in) noexcept {
    if (out.size() <= in.size())               // NOT in.size() + 1 <= out.size(): overflow-safe
        return std::unexpected(CopyError::too_small);
    std::ranges::copy(in, out.begin());
    out[in.size()] = '\0';                     // capacity needed is in.size() + 1
    return in.size();
}
```

**Traps** — `sizeof p` is the pointer size, not the length · `strncpy(d, s, n)` truncates without a terminator when `strlen(s) >= n` · `char` signedness is implementation-defined · a literal is `const`, writing through a cast is UB · `strtok` scribbles on its input and keeps global state.

---

## 20.2 `std::string`: capacity, SSO, invalidation, and contiguous storage

```cpp
#include <string>
using namespace std::string_literals;

std::string s0;                          // empty, capacity unspecified
std::string s1("ABC");                   // from C string
std::string s2("A\0B", 3);               // ptr + count — embedded null kept, size()==3
std::string s3(5, 'x');                  // "xxxxx"
std::string s4(other, 2, 3);             // substring copy [2, 2+3)
std::string s5(first, last);             // iterator pair
std::string s6{'a', 'b'};                // initializer_list<char>
std::string s7 = "ABC"s;                 // <string> UDL, allows embedded nulls
std::string s8(sv);                      // explicit from string_view
std::string s9(std::from_range, rng);    // C++23
auto s10 = rng | std::ranges::to<std::string>();   // C++23

assert(s2.size() == 3 && std::strlen(s2.c_str()) == 1);   // C convention stops early
static_assert(std::ranges::contiguous_range<std::string>);
```

```cpp
// ---- size vs capacity -------------------------------------------------
std::string out;
out.reserve(64);          // capacity >= 64; size() still 0; writing out[0] is UB
out.append("seq=");       // size 4
out.resize(16, ' ');      // live characters now 16, padded with ' '
out.clear();              // size 0, capacity normally retained
out.shrink_to_fit();      // non-binding; may allocate and move
```

```cpp
// ---- C++23 resize_and_overwrite: fill uninitialized storage, no double write
std::string encoded;
encoded.resize_and_overwrite(32, [](char* p, std::size_t n) -> std::size_t {
    auto [end, ec] = std::to_chars(p, p + n, std::uint64_t{12345});
    return ec == std::errc{} ? static_cast<std::size_t>(end - p) : 0;
});   // callback must return <= n; it must not read the buffer's prior contents
```

**Full `std::basic_string` member API**

| Member | Complexity | Notes / invalidation |
|---|---|---|
| `operator=` (str / sv / `const char*` / `char` / init-list) | O(n) | may allocate; invalidates all |
| `assign(...)` (all ctor shapes) | O(n) | may allocate; invalidates all |
| `assign_range(rng)` | O(n) | C++23 |
| `at(i)` | O(1) | throws `std::out_of_range` |
| `operator[](i)` | O(1) | `i == size()` yields the null char (read-only) |
| `front()` / `back()` | O(1) | UB when empty |
| `data()` / `c_str()` | O(1) | contiguous; `data()` non-const since C++17; `[size()]` is `'\0'` |
| `operator string_view()` | O(1) | implicit conversion |
| `begin/end/cbegin/cend/rbegin/rend/crbegin/crend` | O(1) | |
| `empty()` / `size()` / `length()` | O(1) | `length() == size()` |
| `max_size()` | O(1) | |
| `reserve(n)` | O(size) if growing | since C++20 never shrinks; invalidates on growth |
| `capacity()` | O(1) | ≥ `size()` |
| `shrink_to_fit()` | O(size) | non-binding; may allocate; invalidates |
| `clear()` | O(1)–O(n) | capacity retained; invalidates iterators |
| `resize(n[, c])` | O(\|Δ\|) | growth may reallocate |
| `resize_and_overwrite(n, op)` | O(n) | **C++23**; storage is uninitialized on entry |
| `insert(pos, ...)` | O(size + inserted) | many overloads (index or iterator) |
| `erase([pos[, n]])` / `erase(it[, last])` | O(size − pos) | never reallocates |
| `push_back(c)` | amortized O(1) | may reallocate |
| `pop_back()` | O(1) | UB when empty |
| `append(...)` / `operator+=` | amortized O(added) | may reallocate |
| `append_range(rng)` | O(added) | C++23 |
| `compare(...)` | O(min) | returns `<0`/`0`/`>0`, code-unit lexicographic |
| `replace(pos, n, ...)` | O(size + new) | index and iterator forms |
| `substr(pos[, n])` | **O(n), allocates** | throws `out_of_range` if `pos > size()`; rvalue overload moves (C++23) |
| `copy(dest, n[, pos])` | O(n) | writes **no** terminator |
| `swap(other)` | O(1) | may invalidate (SSO buffers get copied) |
| `find` / `rfind` | O(n·m) worst | returns `npos` on failure |
| `find_first_of` / `find_last_of` | O(n·m) | any-of character set |
| `find_first_not_of` / `find_last_not_of` | O(n·m) | complement set |
| `starts_with` / `ends_with` | O(m) | C++20 |
| `contains(x)` | O(n·m) | C++23 |
| `operator==` / `operator<=>` | O(n) | C++20; heterogeneous with `string_view`/`const char*` |
| `std::erase(s, c)` / `std::erase_if(s, p)` | O(n) | C++20 free functions |
| `std::getline(is, s[, delim])` | O(n) | consumes and discards the delimiter |
| `std::stoi/stol/stoll/stoul/stoull/stof/stod/stold` | O(n) | **locale-aware, throws, allocates on `const char*`** — prefer `from_chars` |
| `std::to_string(v)` | O(n) | allocates; locale-independent since C++17 but slow |

**Invalidation** — every pointer/reference/iterator/`string_view` into `s` is invalidated by any operation that may reallocate (`reserve` growth, `append`, `insert`, `push_back`, `+=`, `resize` larger, `shrink_to_fit`, `assign`, `operator=`, `swap`).

```cpp
std::string s = "ABC";
std::string_view v = s;          // borrows s's buffer
s += very_long_suffix;           // may reallocate
use(v);                          // UB — v may dangle, and even if not, may be stale
```

**Interview line** — "SSO is universal in practice and guaranteed nowhere: presence, threshold, and layout are implementation details, so never write a no-allocation contract in terms of string length."

**Traps** — `s[s.size()]` is readable but writing anything but `'\0'` there is UB · `s.substr()` allocates in a loop is the classic quadratic parse · `copy()` does not terminate · `data()` written past `size()` breaks the invariant · `stoi` throws and respects locale · comparison is code-unit order, not collation.

---

## 20.3 `std::string_view`: slicing, lifetime, and null-termination traps

```cpp
#include <string_view>
using namespace std::string_view_literals;

constexpr std::string_view sv0;                       // empty; data() may be nullptr
constexpr std::string_view sv1 = "type=Q|px=10125";   // from literal, O(1) strlen at compile time
constexpr std::string_view sv2{"A\0B", 3};            // ptr + count keeps the embedded null
constexpr auto            sv3 = "ABC"sv;              // UDL, includes embedded nulls
std::string_view          sv4{s};                     // implicit from std::string
std::string_view          sv5{first, last};           // C++20 iterator/sentinel pair
std::string_view          sv6{rng};                   // C++23 range ctor (contiguous+sized)

auto field = sv1.substr(7, 1);   // O(1) view slice — no allocation, no copy
sv1.remove_prefix(7);            // moves the begin pointer; source untouched
sv1.remove_suffix(2);            // shrinks the end; UB if n > size()
```

**Full `std::basic_string_view` member API** — every member is `constexpr`; none allocate.

| Member | Complexity | Notes |
|---|---|---|
| `operator=` | O(1) | rebinds pointer+size, copies no characters |
| `begin/end/cbegin/cend/rbegin/rend/crbegin/crend` | O(1) | `const_iterator` always |
| `operator[](i)` | O(1) | unchecked; **no** null at `size()` |
| `at(i)` | O(1) | throws `std::out_of_range` |
| `front()` / `back()` | O(1) | UB when empty |
| `data()` | O(1) | **may be null**; **not** guaranteed terminated |
| `size()` / `length()` / `max_size()` | O(1) | |
| `empty()` | O(1) | |
| `remove_prefix(n)` / `remove_suffix(n)` | O(1) | UB when `n > size()`; mutates the view only |
| `swap(v)` | O(1) | |
| `copy(dest, n[, pos])` | O(n) | writes no terminator; throws if `pos > size()` |
| `substr([pos[, n]])` | **O(1), no allocation** | throws `out_of_range` if `pos > size()` |
| `compare(...)` (6 overloads) | O(min) | code-unit lexicographic via `Traits::compare` |
| `starts_with` / `ends_with` (sv, char, `const char*`) | O(m) | C++20 |
| `contains(...)` | O(n·m) | C++23 |
| `find` / `rfind` | O(n·m) | `npos` on failure |
| `find_first_of` / `find_last_of` | O(n·m) | character-set search |
| `find_first_not_of` / `find_last_not_of` | O(n·m) | complement |
| `operator==` / `operator<=>` | O(n) | C++20; works across `string`/`const char*` |
| `std::hash<string_view>` | O(n) | equals `hash<string>` for equal content |

**Lifetime matrix**

| Source of the view | Safety |
|---|---|
| String literal | Static storage — safe to retain forever |
| `std::string` lvalue, unmutated | Safe until any invalidating mutation or destruction |
| `std::string` after append/reserve/assign | **Dangling or stale** |
| Temporary `std::string` | Dangles at the end of the full expression |
| Local `std::string` returned as a view | Dangles on return |
| Network/receive buffer | Safe only until the owner refills, compacts, or frees it |

```cpp
std::string_view bad = std::string{"ABC"};      // dangles immediately after the ;
std::string_view also_bad() { std::string l = "ABC"; return l; }   // dangles on return
std::string_view ok(std::string const& s) { return s; }            // caller must outlive it
// Compilers are NOT required to diagnose either case.

// Not null-terminated:
std::string text = "ABC/DEF";
std::string_view left{text.data(), 3};
// c_api(left.data());        // sees "ABC/DEF" — the terminator is at offset 7, not 3
c_api(std::string{left}.c_str());   // deliberate owning terminated copy
```

- Take `string_view` by value; it is two words, trivially copyable, and never null-checks.
- Prefer `string_view` parameters over `const std::string&` to avoid a hidden allocation at each `const char*` call site.
- Do **not** return a `string_view` from a function taking `std::string` by value or by rvalue reference.

**Traps** — `data()` on an empty view may be `nullptr` · `substr` on a view is free, on a string is not · `remove_prefix(n > size())` is UB, not clamped · a view compares by code unit, never by locale · `sv == "abc"` works but `sv.data() == "abc"` compares pointers.

---

## 20.4 `std::span<const char>` and byte-oriented input

```cpp
#include <span>
#include <cstddef>

void parse_text  (std::string_view);                  // contract: text, comparison, slicing
void consume_chars(std::span<char const>);            // contract: bounded character buffer
void fill_buffer (std::span<char>);                   // contract: mutable output region
void decode_wire (std::span<std::byte const>);        // contract: binary, no encoding implied

std::array<char, 64> storage{};
std::span<char>       all{storage};                   // dynamic extent, size 64
std::span<char, 64>   fixed{storage};                 // static extent — size in the type
auto head = all.first(8);                             // dynamic-extent prefix
auto tail = all.last(8);
auto mid  = all.subspan(8, 16);
auto h2   = all.first<8>();                           // static-extent prefix

std::span<std::byte const> bytes = std::as_bytes(std::span<char const>{storage});
std::span<std::byte>       wbytes = std::as_writable_bytes(all);

// Interop both directions:
std::string_view sv{chars.data(), chars.size()};                  // span<const char> -> view
std::span<char const> sp{sv.data(), sv.size()};                   // view -> span
```

| Choose | When |
|---|---|
| `std::string_view` | Text semantics: comparison, `find`, `substr`, `starts_with` |
| `std::span<char const>` | Bounded character storage where "text" is not implied |
| `std::span<char>` | Caller-supplied *output* region |
| `std::span<std::byte const>` | Wire/binary payload; encoding is explicitly out of scope |
| `std::string const&` | Only when you genuinely need ownership or `c_str()` |

- `as_bytes` reinterprets object representation: it does not encode, terminate, validate UTF-8, or copy.
- Neither `span` nor `string_view` owns, extends lifetime, or implies alignment beyond the element type.
- `span` has no `find`/`compare`; reach for `std::ranges::search`, `std::ranges::equal`, or convert to a view.

**Traps** — a span into a growing `vector<char>` dangles like any other view · `span<const char>` from a `string` does not include the terminator · `reinterpret_cast<const char*>(bytes.data())` is fine for reading bytes but does not create objects · fixed-extent and dynamic-extent spans are distinct types.

---

## 20.5 Character classification and signed-`char` UB traps

```cpp
#include <cctype>

// UB when plain char is signed and c is negative (e.g. any UTF-8 continuation byte).
// std::isspace(c);

bool is_space_locale(char c) {
    return std::isspace(static_cast<unsigned char>(c)) != 0;   // correct domain conversion
}

char lower(char c) {                                            // tolower returns int
    return static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
}

// For wire protocols, explicit ASCII rules are clearer AND locale-proof:
constexpr bool is_ascii_digit(char c) noexcept { return c >= '0' && c <= '9'; }
constexpr bool is_ascii_upper(char c) noexcept { return c >= 'A' && c <= 'Z'; }
constexpr char ascii_lower(char c)    noexcept { return is_ascii_upper(c) ? char(c + 32) : c; }
```

| `<cctype>` | Accepts | Notes |
|---|---|---|
| `isalnum` / `isalpha` / `isdigit` / `isxdigit` | `int` in `unsigned char` range or `EOF` | locale-sensitive (C locale ⇒ ASCII) |
| `islower` / `isupper` | same | |
| `isspace` | same | C locale: `' ' \t \n \v \f \r` |
| `isblank` | same | `' '` and `'\t'` (C99/C++11) |
| `ispunct` / `isgraph` / `isprint` / `iscntrl` | same | |
| `tolower` / `toupper` | same | return `int`; identity outside the mapped set |

- The domain requirement is normative: any other `int` value is undefined behavior, and `char` is signed on x86-64 Linux/macOS.
- These are **byte** operations: they cannot classify a multi-byte UTF-8 sequence or perform Unicode case mapping (`ß`, `İ`, Turkish `ı`).
- Locale-aware alternatives live in `<locale>` (`std::isspace(c, loc)`, `std::ctype<char>` facets) and cost a facet dispatch.

**Interview line** — "`std::isdigit(c)` with a plain `char` is undefined behavior for negative values; convert through `unsigned char`, or compare against `'0'`/`'9'` directly."

**Traps** — a `<locale>` change silently alters `isalpha`/`isspace` results · `tolower` on a `char` return path needs a cast back · `isdigit` is not `constexpr` · byte classification over UTF-8 misclassifies every non-ASCII byte.

---

## 20.6 `std::from_chars` / `to_chars`: allocation-free numeric conversion

```cpp
#include <charconv>
#include <system_error>

// ---- exact signatures -------------------------------------------------
struct from_chars_result { const char* ptr; std::errc ec;
                           friend bool operator==(const from_chars_result&,
                                                  const from_chars_result&) = default; };
struct to_chars_result   { char* ptr;       std::errc ec;
                           friend bool operator==(const to_chars_result&,
                                                  const to_chars_result&) = default; };

enum class chars_format { scientific = /*unspecified*/, fixed, hex, general = fixed|scientific };

// from_chars — integers (every signed/unsigned integer type except bool; C++23 constexpr)
constexpr from_chars_result from_chars(const char* first, const char* last,
                                       /*integer-type*/ & value, int base = 10);
// from_chars — floating point (float, double, long double)
from_chars_result from_chars(const char* first, const char* last,
                             /*float-type*/ & value,
                             std::chars_format fmt = std::chars_format::general);

// to_chars — integers (C++23 constexpr)
constexpr to_chars_result to_chars(char* first, char* last,
                                   /*integer-type*/ value, int base = 10);
// to_chars — floating point, three overloads
to_chars_result to_chars(char* first, char* last, /*float-type*/ value);
to_chars_result to_chars(char* first, char* last, /*float-type*/ value,
                         std::chars_format fmt);
to_chars_result to_chars(char* first, char* last, /*float-type*/ value,
                         std::chars_format fmt, int precision);
```

| Result / `ec` value | Meaning | `ptr` |
|---|---|---|
| `std::errc{}` | success | `from_chars`: first unparsed char · `to_chars`: one past last written |
| `std::errc::invalid_argument` | `from_chars`: no character matched the pattern | `== first`; `value` untouched |
| `std::errc::result_out_of_range` | `from_chars`: pattern matched but value does not fit | first unparsed char; `value` untouched |
| `std::errc::value_too_large` | `to_chars`: buffer too small | unspecified; `[first,last)` has **unspecified contents** |

```cpp
// ---- parsing with full-field validation -------------------------------
enum class ParseError { invalid, out_of_range, trailing };

std::expected<std::int64_t, ParseError>
parse_i64(std::string_view text) noexcept {
    std::int64_t value{};
    auto [ptr, ec] = std::from_chars(text.data(), text.data() + text.size(), value);
    if (ec == std::errc::invalid_argument)     return std::unexpected(ParseError::invalid);
    if (ec == std::errc::result_out_of_range)  return std::unexpected(ParseError::out_of_range);
    if (ptr != text.data() + text.size())      return std::unexpected(ParseError::trailing);
    return value;
}

int  hex{};  std::from_chars(b, e, hex, 16);   // base 2..36; "0x" is NOT consumed
double d{};  std::from_chars(b, e, d, std::chars_format::fixed);       // "1.25", no exponent
double h{};  std::from_chars(b, e, h, std::chars_format::hex);         // "1.8p3", no "0x"
```

**`from_chars` rules**
- Leading whitespace is never skipped; `" 12"` fails with `invalid_argument`.
- A leading `'-'` is accepted for signed integers and for floats; a leading `'+'` is **never** accepted.
- `base` is 2–36 for integers; digits above 9 use `a`–`z`/`A`–`Z`; a `0x` prefix is not recognized (unlike `strtol`).
- For `chars_format::hex`, the input must *omit* the `0x` prefix.
- `general` accepts both fixed and scientific forms; `inf`/`nan` are accepted for non-`hex` formats.
- Success can be partial: `"12x"` returns `errc{}` with `ptr` at `'x'` — that is why `ptr == last` is mandatory.
- No allocation, no locale, no `errno`, `noexcept` in effect, and `constexpr` for integers since C++23.

```cpp
// ---- to_chars ---------------------------------------------------------
std::array<char, 32> buf{};
auto [ptr, ec] = std::to_chars(buf.data(), buf.data() + buf.size(), std::uint64_t{987654});
if (ec == std::errc{}) {
    std::string_view written{buf.data(), static_cast<std::size_t>(ptr - buf.data())};
    consume(written);                       // NOTE: no trailing '\0' was written
}

std::to_chars(b, e, 255, 16);               // "ff" — lowercase digits, no "0x", no sign for +
std::to_chars(b, e, 3.14159);               // shortest round-trip representation
std::to_chars(b, e, 3.14159, std::chars_format::fixed, 2);          // "3.14"
std::to_chars(b, e, 3.14159, std::chars_format::scientific, 3);     // "3.142e+00"
std::to_chars(b, e, 3.14159, std::chars_format::general, 6);        // printf %g-like
```

- The no-format/no-precision float overload produces the **shortest** string that round-trips back to the same value under `from_chars`.
- Safe buffer sizes: 21 chars for any 64-bit integer in base 10 (`-9223372036854775808`), 65 for base 2; `std::numeric_limits<double>::max_digits10` (17) plus sign/point/exponent ≈ 32 is ample, 64 is comfortable for `long double`.

```cpp
// ---- bounded append cursor -------------------------------------------
struct BufferWriter {
    std::span<char> rest;
    bool append(std::uint64_t value) noexcept {
        auto [p, ec] = std::to_chars(rest.data(), rest.data() + rest.size(), value);
        if (ec != std::errc{}) return false;                 // buffer contents now unspecified
        rest = rest.subspan(static_cast<std::size_t>(p - rest.data()));
        return true;
    }
    bool append(std::string_view s) noexcept {
        if (s.size() > rest.size()) return false;
        std::ranges::copy(s, rest.begin());
        rest = rest.subspan(s.size());
        return true;
    }
};
```

**Traps** — forgetting `ptr == last` accepts `"12x"` as `12` · expecting a terminator from `to_chars` · assuming `0x`/`+`/whitespace handling from `strtol` · treating a `value_too_large` buffer as a truncated-but-valid prefix · `from_chars` for floats lagged in libstdc++ (< GCC 11) and libc++ (< 20) — verify the deployed library.

---

## 20.7 `std::format` and C++23 `std::print`

```cpp
#include <format>
#include <print>      // C++23

auto line = std::format("id={} price={:.2f}", id, price);   // returns owning std::string
std::format_to(std::back_inserter(out), "{}:{}", venue, seq);    // any output_iterator
auto n   = std::formatted_size("id={}", id);                     // chars needed, no output
auto loc = std::format(std::locale("C"), "{:L}", 1234567);       // locale overload

// Runtime (non-literal) format strings:
std::string fmt = load_pattern();
auto s = std::vformat(fmt, std::make_format_args(id, price));    // no compile-time check
// std::format(fmt, id);          // ill-formed: fmt is not a constant expression
auto s2 = std::format(std::runtime_format(fmt), id);             // C++26 spelling
```

**Format string grammar**

```text
replacement-field ::= '{' [arg-id] [':' format-spec] '}'
arg-id            ::= digit+ | identifier          // all-automatic or all-manual, never mixed
escapes           ::= '{{'  '}}'                   // literal braces

format-spec ::= [[fill]align][sign]['#']['0'][width]['.' precision]['L'][type]

fill        ::= any character except '{' and '}'   // requires an explicit align after it
align       ::= '<'   left      (default for non-arithmetic)
              | '>'   right     (default for arithmetic)
              | '^'   center
sign        ::= '+'   always show sign
              | '-'   only for negative (default)
              | ' '   space for non-negative
'#'         ::= alternate form: 0b/0B/0/0x/0X prefix; always show '.' for floats
'0'         ::= zero-pad after the sign/prefix (ignored when align is given)
width       ::= digit+ | '{' [arg-id] '}'          // nested, must be a non-negative integer
precision   ::= digit+ | '{' [arg-id] '}'          // floats: digits; strings: truncate
'L'         ::= locale-specific form (digit grouping, decimal point, bool/true names)
```

| `type` | Applies to | Meaning |
|---|---|---|
| *(none)* | any | default presentation for the type |
| `b` / `B` | integer, `bool` | binary; `#` gives `0b` / `0B` |
| `c` | integer, `char` | as a character (throws if not representable) |
| `d` | integer, `bool`, `char` | decimal |
| `o` | integer | octal; `#` prefixes `0` (except for value 0) |
| `x` / `X` | integer, pointer | hex lower/upper; `#` gives `0x` / `0X` |
| `a` / `A` | floating point | hexfloat |
| `e` / `E` | floating point | scientific, default precision 6 |
| `f` / `F` | floating point | fixed, default precision 6 |
| `g` / `G` | floating point | general, default precision 6 |
| `s` | string, `bool` | string / `"true"`/`"false"` |
| `?` | string, `char` | **C++23** debug form: quoted + escaped |
| `p` / `P` | `const void*`, `nullptr_t` | pointer as hex (`P` uppercase, C++26) |
| `%` | floating point | value × 100 with a trailing `%` |

```cpp
std::format("{:>10}",     "px");        // "        px"   right align
std::format("{:*^11}",    "mid");       // "****mid****"  fill '*', center
std::format("{:+.3f}",    1.5);         // "+1.500"
std::format("{:#010x}",   255);         // "0x000000ff"   '#' prefix + zero pad
std::format("{:08.3f}",  -1.5);         // "-001.500"     zero pad after sign
std::format("{:{}.{}f}",  pi, 9, 4);    // "   3.1416"    nested width/precision
std::format("{0} {1} {0}", "a", "b");   // "a b a"        manual indices
std::format("{:L}",       1234567);     // "1,234,567" under a grouping locale
std::format("{:?}",       "a\tb");      // "\"a\\tb\""    C++23 debug
std::format("{{literal}}");             // "{literal}"
std::format("{:%F %T}",   tp);          // chrono spec (chrono has its own grammar)
std::format("{}", std::vector{1,2,3});  // "[1, 2, 3]"    C++23 range formatting
std::format("{}", std::pair{1, 'a'});   // "(1, 'a')"     C++23
std::format("{:n}", std::vector{1,2});  // "1, 2"         C++23: drop the brackets
```

| Facility | Signature sketch | Notes |
|---|---|---|
| `format(fmt, args...)` | `string` | allocates; compile-time checked format |
| `format(loc, fmt, args...)` | `string` | locale-aware `L` handling |
| `format_to(out, fmt, args...)` | `OutIt` | writes through any `output_iterator<const char&>` |
| `format_to_n(out, n, fmt, args...)` | `format_to_n_result{out, size}` | writes ≤ `n`; `size` is the **untruncated** total |
| `formatted_size(fmt, args...)` | `size_t` | measure first, allocate exactly once |
| `vformat(fmt, args)` / `vformat_to(out, fmt, args)` | runtime format string | pair with `make_format_args` |
| `make_format_args(args...)` | `format-arg-store` | **binds by reference** — never store the result |
| `print(fmt, args...)` / `print(FILE*, ...)` | C++23 | writes to `stdout` / a `FILE*` |
| `println(...)` | C++23 | `print` plus `'\n'` |
| `print(std::ostream&, ...)` | C++23 | routes through the stream, honoring its state |
| `std::formatter<T, CharT>` | customization point | specialize for your own types |
| `std::format_error` | exception | invalid spec or arg mismatch at runtime (`vformat`) |

```cpp
// ---- bounded formatting -----------------------------------------------
std::array<char, 128> buf{};
auto r = std::format_to_n(buf.begin(), buf.size(), "seq={} status={}", seq, status);
auto produced  = static_cast<std::size_t>(r.out - buf.begin());
bool truncated = r.size > buf.size();     // r.size = size that WOULD have been produced
// format_to_n bounds the writes, not the conceptual output. Truncation must be a
// named outcome, never silently accepted as a valid record.
```

```cpp
// ---- custom formatter: delegate to an existing one ---------------------
struct PriceTicks { std::int64_t value; };

template<> struct std::formatter<PriceTicks> : std::formatter<std::int64_t> {
    auto format(PriceTicks p, std::format_context& ctx) const {
        return std::formatter<std::int64_t>::format(p.value, ctx);   // inherits the whole spec
    }
};

// ---- custom formatter: full parse/format pair --------------------------
struct Side { bool buy; };

template<> struct std::formatter<Side> {
    bool verbose = false;
    constexpr auto parse(std::format_parse_context& ctx) {
        auto it = ctx.begin();
        if (it != ctx.end() && *it == 'v') { verbose = true; ++it; }
        if (it != ctx.end() && *it != '}') throw std::format_error("bad Side spec");
        return it;                                   // MUST return the '}' position
    }
    auto format(Side s, std::format_context& ctx) const {
        return std::format_to(ctx.out(), "{}",
                              verbose ? (s.buy ? "BUY" : "SELL") : (s.buy ? "B" : "S"));
    }
};
```

```cpp
std::print("accepted id={}\n", id);
std::println("accepted id={}", id);              // adds the newline
std::println(stderr, "decode error at {}", offset);
```

- `print`/`println` are I/O: they lock, buffer, may transcode to the console's encoding on Windows, can throw `std::system_error`, and are not a latency-bounded logger.
- `std::format` is compile-time checked because the parameter is `std::format_string<Args...>`, consteval-constructed from a literal.
- `make_format_args` stores references to its arguments — `auto a = std::make_format_args(x + 1);` dangles.

**Traps** — mixing `{}` and `{0}` in one string is ill-formed · `{:.3}` on a string truncates rather than sets precision · `0` flag is ignored once an explicit align is present · `r.size` from `format_to_n` is not the number written · a user `formatter` may allocate or throw on the hot path · `parse` must consume up to but not past `'}'`.

---

## 20.8 Streams, locales, synchronization, and common performance costs

```cpp
#include <sstream>
#include <iomanip>
#include <iostream>

std::ostringstream os;
os << std::hex << std::showbase << value << ' ' << std::setw(8) << std::setfill('0') << n;
auto text = std::move(os).str();        // C++20 rvalue str() — moves the buffer out
os.str("");                             // reset contents (does not clear state)
os.clear();                             // reset failbit/badbit/eofbit
auto view = os.view();                  // C++20: string_view without a copy
```

| Manipulator | Effect | Sticky? |
|---|---|---|
| `std::dec` / `hex` / `oct` | integer base | yes |
| `std::showbase` / `noshowbase` | `0x`/`0` prefix | yes |
| `std::showpos` / `noshowpos` | `+` on non-negative | yes |
| `std::uppercase` / `nouppercase` | `0X`, `E`, hex digits | yes |
| `std::fixed` / `scientific` / `hexfloat` / `defaultfloat` | float notation | yes |
| `std::setprecision(n)` | significant digits (or decimals when `fixed`) | yes |
| `std::setw(n)` | field width | **no — consumed by one insertion** |
| `std::setfill(c)` | pad character | yes |
| `std::left` / `right` / `internal` | adjustment | yes |
| `std::boolalpha` / `noboolalpha` | `true` vs `1` | yes |
| `std::ws` | extract and discard whitespace (input) | n/a |
| `std::endl` | `'\n'` **plus flush** | n/a |
| `std::flush` | flush only | n/a |
| `std::quoted(s[, delim, esc])` | quote/unquote round-trip | n/a |

| Stream state | Meaning |
|---|---|
| `good()` | no bits set |
| `eof()` | end of input reached during a previous read |
| `fail()` | formatting/extraction failure (**or** eof from a partial read) |
| `bad()` | irrecoverable stream error |
| `operator bool()` | `!fail()` — the loop condition |
| `exceptions(mask)` | throw `std::ios_base::failure` on the selected bits |

```cpp
int id{};
if (!(in >> id)) { /* failbit set: value is ZERO-INITIALIZED since C++11, not untouched */ }
in.clear();                        // must clear before further reads succeed
in.ignore(std::numeric_limits<std::streamsize>::max(), '\n');   // discard the bad line

std::ios::sync_with_stdio(false);  // decouple from C stdio — call BEFORE any I/O
std::cin.tie(nullptr);             // stop flushing cout before every cin read
std::cout << '\n';                 // not std::endl
```

**Costs, one per line**
- A `sentry` object is constructed per formatted operation (skips whitespace, checks/ties state).
- Every numeric insertion dispatches through `num_put`/`num_get` locale facets.
- `ostringstream` grows a dynamic buffer and may reallocate and copy.
- Format flags are sticky: a stray `std::hex` corrupts every later integer on that stream.
- `setw` is *not* sticky and silently applies to only the next item.
- A stream stuck in `failbit` makes every subsequent operation a no-op, silently.
- `std::endl` forces a flush — a syscall per line in the worst case.
- `sync_with_stdio(false)` speeds up conventional console throughput but forbids interleaving `printf` with `cout`, and does not make streams allocation-free.
- `operator>>` skips leading whitespace by default (`std::noskipws` disables it) — `from_chars` never does.

**Interview line** — "Streams are a formatting *and* locale *and* buffering *and* error-state machine; for a bounded hot path use `to_chars`/`format_to_n` into caller storage instead."

---

## 20.9 C++23 `std::spanstream`

```cpp
#include <spanstream>

// Output over caller-supplied storage — no internal buffer growth.
std::array<char, 64> storage{};
std::ospanstream os{std::span<char>{storage}};
os << "id=" << 42 << " px=" << 10125;
if (!os) handle_overflow();          // exhaustion sets failbit; it does NOT grow
std::span<char> written = os.span(); // the written prefix only

// Input over caller-supplied storage.
std::array<char, 16> input{'4','2',' ','7'};
std::ispanstream in{std::span<char>{input}};
int id{}, qty{};
in >> id >> qty;                     // still skips whitespace, still uses locale facets

// Bidirectional.
std::spanstream io{std::span<char>{storage}};
io.span(std::span<char>{other});     // rebind the underlying buffer
auto cur = io.span();                // current written/valid region
```

| Type | Base | Purpose |
|---|---|---|
| `std::basic_spanbuf<CharT>` | `basic_streambuf` | stream buffer over a fixed `span` |
| `std::basic_ispanstream` / `ispanstream` | `basic_istream` | read from caller storage |
| `std::basic_ospanstream` / `ospanstream` | `basic_ostream` | write into caller storage |
| `std::basic_spanstream` / `spanstream` | `basic_iostream` | both |
| `.span()` | — | span over the written sequence (out) / underlying buffer (in) |
| `.span(s)` | — | rebind to a new buffer, resetting positions |
| `.rdbuf()` | — | the `spanbuf` |

- Compared to `ostringstream`: no dynamic allocation and no internal growth, but every other stream cost (sentry, facets, flags, state) remains.
- `ispanstream` accepts a `string_view` directly; `ospanstream` requires a writable `span<char>`.
- For a small numeric protocol, `to_chars`/`format_to_n` is more direct, faster, and has an explicit error result.

**Traps** — overflow is signalled by `failbit`, so an unchecked `os << x` silently drops output · `os.span()` is only valid while the backing storage lives · a stream left in `failbit` ignores all later insertions · seeking past the span end fails rather than extending.

---

## 20.10 UTF encodings and why the standard string types do not imply Unicode semantics

```text
byte              addressable storage unit
code unit         one unit of an encoding (a UTF-8 byte, a UTF-16 word)
code point        one Unicode scalar value (U+0000..U+10FFFF minus surrogates)
grapheme cluster  one user-perceived character, possibly many code points
```

| Type / literal | Code-unit type | Size | Does **not** guarantee |
|---|---|---|---|
| `std::string`, `"..."` | `char` | 1 byte | UTF-8, characters, normalization |
| `std::u8string`, `u8"..."` | `char8_t` (C++20) | 1 byte | valid UTF-8 content or Unicode algorithms |
| `std::u16string`, `u"..."` | `char16_t` | 2 bytes | one code unit per code point (surrogate pairs) |
| `std::u32string`, `U"..."` | `char32_t` | 4 bytes | valid scalar values, normalization, one glyph |
| `std::wstring`, `L"..."` | `wchar_t` | 2 (Windows) / 4 (POSIX) | portable width or a single encoding |

```cpp
std::string  s = "héllo";      // 6 bytes in UTF-8 source, 5 "characters"
s.size();                      // 6 — code units, not code points
s[1];                          // 0xC3 — half of 'é'; slicing here corrupts the text

char8_t const* p8 = u8"abc";   // C++20: array of const char8_t
// char const* p = u8"abc";    // ill-formed since C++20 — no implicit conversion
auto* bytes = reinterpret_cast<char const*>(p8);   // deliberate, well-defined for reading

std::u8string  u8s = u8"héllo";
std::string    back(reinterpret_cast<char const*>(u8s.data()), u8s.size());  // explicit

char32_t cp = U'\U0001F600';   // one code point; UTF-8 encodes it as 4 bytes
char16_t hi = u'\uD83D';       // a lone surrogate: valid char16_t, invalid scalar value

// C++20 removed codecvt-based conversions from favour (deprecated in C++17):
// std::wstring_convert / std::codecvt_utf8 — deprecated, do not use in new code.
```

- Standard containers store code units: they never validate encoding, normalize (NFC/NFD), segment graphemes, case-fold, or measure display width.
- `size()`, `operator[]`, `substr`, `find`, and `<=>` all operate on code units — a byte index into UTF-8 may land mid-sequence.
- Comparison is code-unit lexicographic, which for UTF-8 equals code-point order but is *not* linguistic collation.
- `std::format`'s width/`^` alignment counts *estimated display width* of extended grapheme clusters for `char`/`wchar_t` (C++23 P1868), unlike `string::size()`.
- Source encoding, execution encoding, and file/console encoding are three separate settings; pin them (`/utf-8`, `-finput-charset`, `-fexec-charset`).
- Real Unicode work (normalization, collation, segmentation, case mapping) needs ICU, utf8cpp, or a similar library.

```cpp
// Minimal, explicit UTF-8 decode — the standard gives you nothing like it.
constexpr std::size_t utf8_len(unsigned char lead) noexcept {
    return lead < 0x80 ? 1 : (lead >> 5) == 0b110 ? 2
         : (lead >> 4) == 0b1110 ? 3 : (lead >> 3) == 0b11110 ? 4 : 0;  // 0 = invalid lead
}
```

```cpp
// ---- zero-allocation parsing blueprint --------------------------------
struct QuoteFields { std::uint64_t id; std::int64_t ticks; };
enum class FieldError { missing_separator, invalid_id, invalid_ticks };

std::expected<QuoteFields, FieldError>
parse_quote(std::string_view line) noexcept {
    auto sep = line.find(',');
    if (sep == line.npos) return std::unexpected(FieldError::missing_separator);

    auto id_text = line.substr(0, sep);          // O(1) view slices
    auto px_text = line.substr(sep + 1);
    std::uint64_t id{}; std::int64_t ticks{};

    auto a = std::from_chars(id_text.data(), id_text.data() + id_text.size(), id);
    if (a.ec != std::errc{} || a.ptr != id_text.data() + id_text.size())
        return std::unexpected(FieldError::invalid_id);
    auto b = std::from_chars(px_text.data(), px_text.data() + px_text.size(), ticks);
    if (b.ec != std::errc{} || b.ptr != px_text.data() + px_text.size())
        return std::unexpected(FieldError::invalid_ticks);

    return QuoteFields{id, ticks};               // owns numbers, borrows nothing
}
```

**Interview line** — "`std::string` is a container of `char` code units with no encoding contract; UTF-8 is a convention you impose at the boundary, and every Unicode operation beyond byte comparison is out of scope for the standard library."

**Rapid diagnosis table**

| Symptom | Cause |
|---|---|
| Garbage tail on a wire field | `strlen` on non-terminated bytes — carry the framing length |
| Corrupted text after an append | `string_view`/`data()` retained across a reallocating mutation |
| C API sees too much text | `substr(...).data()` passed to a `const char*` parameter |
| Crash on non-ASCII input | `std::isspace(char)` with a negative value |
| `"12x"` accepted as 12 | `from_chars` return `ptr` not compared to `last` |
| Trailing garbage after a number | expecting `to_chars` to write `'\0'` |
| Silently truncated log lines | `format_to_n` `size` field ignored |
| Mojibake / mid-character slice | byte index into UTF-8 assumed to be a character index |
| Every integer suddenly hex | sticky `std::hex` on a shared stream |
| One slow line in a hot loop | `std::endl` flushing per record |
