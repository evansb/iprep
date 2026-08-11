# 35. Zero-allocation text parsing

*Part VI-A — Quant blueprints: types, codecs, and core structures*

---

**Recall**
- "Zero allocation" is a claim about *the parser during a stated phase* — the input owner, the result type, the logger, and first-use library init can all still allocate.
- `std::string_view` is a `{const char*, size_t}` pair: it does not own, copy, terminate, or extend lifetime.
- A subview's `data()` is almost never null-terminated — never hand it to a `char const*` C API.
- `std::from_chars` is the only standard integer conversion that is locale-free, allocation-free, non-throwing, and terminator-free.
- `from_chars` success does **not** mean the whole field parsed — an exact field requires `ec == errc{}` **and** `ptr == last`.
- Integer `from_chars` skips no whitespace, accepts `-` only for signed targets, never accepts `+`, and never infers `0x`/octal from a prefix.
- On failure `from_chars` leaves the destination object unmodified — do not read it.
- Binary floating point cannot represent decimal money exactly; parse fixed-point digit-by-digit into a scaled integer instead.
- Check overflow *before* the multiply-add: signed overflow is UB, so a post-hoc `if (x < 0)` test is already too late.
- Accumulate magnitude in `std::uint64_t` because `-INT64_MIN` is not representable as `int64_t`.
- The exact overflow predicate for `acc*10 + d <= limit` is `acc > (limit - d) / 10`, evaluated before the arithmetic.
- A hot-path error is a compact POD: enum code + byte offset + field id; text formatting belongs on the cold path.
- `std::expected<T,E>` stores `T` or `E` inline and allocates nothing by itself; its size is `max(sizeof T, sizeof E)` plus a discriminant.
- `noexcept` on a parser is only honest if every callee — including user callbacks and the result type's constructors — is non-throwing.
- Immutable subview tokenization is just as allocation-free as in-place `\0` splitting, and it preserves the input.
- In-place tokenization mutates the caller's buffer, races with concurrent readers, and dies on read-only mmap; `strtok` adds hidden global state on top.
- `std::to_chars` writes into caller-supplied `[first, last)` and returns `errc::value_too_large` when it does not fit — it writes nothing on failure.
- `<cctype>` functions are UB on a negative `char`; cast to `unsigned char`, or just compare `c >= '0' && c <= '9'` for ASCII grammars.
- Streams, `strtod`, `std::regex`, and per-token `std::string` are excluded from strict loops by *contract mismatch*, not by folklore.
- Benchmarks over one short valid literal measure constant folding; the matrix must include truncation, late-invalid bytes, and overflow at the final digit.

---

## 35.1 Input ownership with `span` / `string_view`

```cpp
#include <span>
#include <string>
#include <string_view>
#include <cstddef>

// ---- construction forms ------------------------------------------------
std::string_view a{};                          // empty; data() may be nullptr
std::string_view b = "10,20.5,3";              // from literal, size 9 (no '\0')
std::string_view c{b.data(), 2};               // pointer + length
std::string_view d{b.begin(), b.end()};        // iterator pair (C++20)
std::string_view e = "abc"sv;                  // <string_view> UDL, using namespace std::literals
std::span<char const> s{b.data(), b.size()};   // byte-counted, no text helpers
std::span<std::byte const> raw = std::as_bytes(s); // encoding-neutral wire view

// ---- slicing: all non-allocating, all borrowing ------------------------
auto f  = b.substr(3, 4);      // "20.5" — O(1), throws out_of_range if pos > size()
b.remove_prefix(3);            // advance the start
b.remove_suffix(1);            // shrink the end
bool z = b.starts_with("20");  // C++20
bool y = b.ends_with('3');     // C++20
bool x = b.contains("0.");     // C++23
auto p = b.find(',');          // npos if absent; O(n)

// ---- the dangling return -----------------------------------------------
std::string_view bad() {
    std::string tmp = "10,20";
    return tmp;                // DANGLES: tmp dies at return
}
std::string_view bad2(std::string s) { return s; }   // parameter dies too

// ---- the null-termination trap ------------------------------------------
void legacy(char const*);                 // contract: reads until '\0'
std::string_view field = "10,20"sv.substr(0, 2);
// legacy(field.data());                  // reads "10,20" — past the field
legacy(std::string{field}.c_str());       // correct, but ALLOCATES (maybe SSO)
```

```cpp
// Signature that states ownership in the type system.
struct ParsedRecord;                                        // owning scalars only
[[nodiscard]] auto parse_record(std::string_view input) noexcept
    -> std::expected<ParsedRecord, ParseError>;             // borrows input, returns owned
```

| View | Natural use | Caveat |
|---|---|---|
| `std::string_view` | text slicing, comparison, `from_chars` pointer pair | not null-terminated; no encoding validation |
| `std::span<char const>` | byte-counted buffer, generic contiguous range | no `find`/`substr`/comparison |
| `std::span<char>` | writable buffer for in-place tokenization | mutation is visible to the owner |
| `std::span<std::byte const>` | wire bytes before decoding | must validate/convert before text ops |
| `std::string` | ownership + terminator | allocates beyond SSO |

| `string_view` member | Complexity | Notes |
|---|---|---|
| `data()` / `size()` / `empty()` | O(1) | `data()` may be `nullptr` when empty |
| `operator[]` / `front()` / `back()` | O(1) | unchecked; UB when empty |
| `at(i)` | O(1) | throws `std::out_of_range` |
| `substr(pos, n)` | O(1) | throws if `pos > size()`; clamps `n` |
| `remove_prefix(n)` / `remove_suffix(n)` | O(1) | UB if `n > size()` |
| `find` / `rfind` / `find_first_of` / `find_first_not_of` | O(n·m) | returns `npos` |
| `starts_with` / `ends_with` (C++20), `contains` (C++23) | O(m) | |
| `compare` / `==` / `<=>` | O(n) | lexicographic, byte-wise |
| `copy(dest, n, pos)` | O(n) | writes into caller storage; no terminator |

**Traps** — returning a view of a local/temporary/by-value parameter · `data()` is not a C string · `substr` throws (it is *not* `noexcept`) · a view may contain an embedded `'\0'` · neither view validates UTF-8 · `span<const char>` has no `substr`, so slice with `subspan`.

---

## 35.2 Cursor, delimiter, and fixed-width parsing strategies

```cpp
#include <cstddef>
#include <string_view>

struct FieldView {
    std::string_view text{};       // borrowed slice of the record
    std::size_t      offset{};     // byte offset of text[0] within the record
    bool             terminated{}; // true iff a delimiter closed this field
};

class TextCursor {
public:
    explicit constexpr TextCursor(std::string_view input) noexcept
        : rest_{input}, size_{input.size()} {}

    // Consumes up to the next delimiter; the trailing suffix is the last field.
    [[nodiscard]] constexpr FieldView take_until(char delim) noexcept {
        auto const start = offset();
        auto const pos   = rest_.find(delim);
        if (pos == std::string_view::npos) {
            auto const field = rest_;
            rest_ = rest_.substr(rest_.size());     // keep data() valid, size 0
            return {field, start, false};
        }
        auto const field = rest_.substr(0, pos);
        rest_.remove_prefix(pos + 1);
        return {field, start, true};
    }

    // Required separator: distinguishes "last field" from "missing delimiter".
    [[nodiscard]] constexpr std::expected<FieldView, ParseError>
    require_until(char delim, std::uint16_t field_id) noexcept {
        auto const f = take_until(delim);
        if (!f.terminated)
            return std::unexpected(ParseError{ParseCode::missing_delimiter,
                                              f.offset + f.text.size(), field_id});
        return f;
    }

    [[nodiscard]] constexpr FieldView take_rest() noexcept {
        auto const start = offset();
        auto const field = rest_;
        rest_ = rest_.substr(rest_.size());
        return {field, start, true};
    }

    [[nodiscard]] constexpr bool        empty()  const noexcept { return rest_.empty(); }
    [[nodiscard]] constexpr std::size_t offset() const noexcept { return size_ - rest_.size(); }
    [[nodiscard]] constexpr std::string_view remaining() const noexcept { return rest_; }

private:
    std::string_view rest_{};
    std::size_t      size_{};
};
static_assert([]{ TextCursor c{"1,2"}; return c.take_until(',').text == "1"; }());
```

```cpp
// ---- fixed-width layout: validate the total width ONCE ------------------
// | id: 8 | value: 12 |   == 20 bytes exactly
if (record.size() != 20)
    return std::unexpected(ParseError{ParseCode::invalid_length, record.size(), 0});
auto const id_field    = record.substr(0, 8);    // proven in-bounds
auto const value_field = record.substr(8, 12);
```

```cpp
// ---- multi-char / any-of delimiters ------------------------------------
auto pos1 = rest.find_first_of(",;\t");            // any of a set
auto pos2 = rest.find("\r\n");                     // multi-byte terminator
auto pos3 = rest.find_first_not_of(' ');           // manual left-trim index

// ---- explicit trim helpers (from_chars will NOT do this for you) --------
constexpr std::string_view ltrim(std::string_view v) noexcept {
    auto const i = v.find_first_not_of(" \t");
    return i == std::string_view::npos ? v.substr(v.size()) : v.substr(i);
}
constexpr std::string_view rtrim(std::string_view v) noexcept {
    auto const i = v.find_last_not_of(" \t");
    return i == std::string_view::npos ? v.substr(0, 0) : v.substr(0, i + 1);
}

// ---- C++20 ranges split (views only; still allocation-free) -------------
#include <ranges>
for (auto part : record | std::views::split(',')) {
    std::string_view f{part.begin(), part.end()};  // C++23: std::string_view{part}
    (void)f;                                       // no offset tracking — cursor is better
}
```

| Strategy | Scan cost | Offsets | Notes |
|---|---|---|---|
| Forward cursor (`find` on suffix) | O(record) total | exact, free | one pass; state is the remaining view |
| Re-`find` from record start | O(record · fields) | manual | quadratic on many-field/malformed input |
| Fixed width `substr` | O(1) per field | trivial | one length check up front; bytes ≠ characters |
| `views::split` | O(record) | lost | no delimiter-vs-EOF distinction, no offsets |
| `strtok` | O(record) | none | mutates input, global state — never |

**Traps** — a trailing delimiter creates an empty final field, which the *grammar*, not the cursor, must accept or reject · `find` returns `npos`, not `size()` · `remove_prefix(pos+1)` overruns when `pos == npos` · `rest_ = {}` loses `data()`, so prefer `substr(size())` if callers compare pointers · a byte width is not a character width.

---

## 35.3 `from_chars` for integers and floating-point fields

```cpp
#include <charconv>     // from_chars, to_chars, chars_format, from_chars_result
#include <system_error> // std::errc

std::string_view text = "123x";
std::uint32_t v{};
auto [ptr, ec] = std::from_chars(text.data(), text.data() + text.size(), v);
// ec == std::errc{}  → success;  v == 123;  ptr points at 'x' (PREFIX parse)

// ---- the four behaviours that decide your parser's shape ----------------
// (full signatures, chars_format overloads, and the errc table are in §20.6)
// 1. PREFIX parse: stops at the first non-matching char and reports it in ptr.
//    There is no "parse the whole field" mode — YOU compare ptr against last.
// 2. '+' is NEVER accepted; leading whitespace is NEVER skipped. No locale.
// 3. Base 16 means "ff", not "0xff" — the "0x" prefix stops the parse at 'x'.
// 4. On failure `value` is UNTOUCHED, so it keeps whatever you initialized it to.
```

```cpp
enum class ParseCode : std::uint8_t {
    ok, empty, invalid_character, overflow, trailing_character,
    missing_delimiter, too_many_fraction_digits, invalid_length,
    invalid_value, output_too_small
};

struct ParseError {                 // 16 bytes, trivially copyable
    ParseCode     code{};
    std::size_t   offset{};         // byte offset within the supplied record
    std::uint16_t field{};          // compact schema field id
};

// Exact-field integer parse: the reusable primitive.
template<std::integral T>
[[nodiscard]] constexpr std::expected<T, ParseError>
parse_int(std::string_view text, std::size_t base_offset = 0,
          int base = 10, std::uint16_t field = 0) noexcept {
    if (text.empty())
        return std::unexpected(ParseError{ParseCode::empty, base_offset, field});

    T value{};
    auto const first = text.data();
    auto const last  = first + text.size();
    auto const r     = std::from_chars(first, last, value, base);  // constexpr since C++23
    auto const at    = base_offset + static_cast<std::size_t>(r.ptr - first);

    if (r.ec == std::errc::invalid_argument)                 // no digits consumed at all
        return std::unexpected(ParseError{ParseCode::invalid_character, at, field});
    if (r.ec == std::errc::result_out_of_range)              // syntax ok, value too big
        return std::unexpected(ParseError{ParseCode::overflow, at, field});
    if (r.ptr != last)                                       // valid prefix, junk suffix
        return std::unexpected(ParseError{ParseCode::trailing_character, at, field});
    return value;                                            // value is UNTOUCHED on failure
}

// Narrowing with an explicit range check instead of a silent truncation.
[[nodiscard]] constexpr std::expected<std::uint32_t, ParseError>
parse_u32(std::string_view t, std::size_t off, std::uint16_t f = 0) noexcept {
    auto const wide = parse_int<std::uint64_t>(t, off, 10, f);
    if (!wide) return std::unexpected(wide.error());
    if (*wide > std::numeric_limits<std::uint32_t>::max())
        return std::unexpected(ParseError{ParseCode::overflow, off + t.size(), f});
    return static_cast<std::uint32_t>(*wide);
}
```

| `<charconv>` entity | Signature / meaning | Notes |
|---|---|---|
| `from_chars(first, last, T& v, int base = 10)` | integral | no whitespace, no `+`, no `0x` inference |
| `from_chars(first, last, F& v, chars_format = general)` | float/double/long double | locale-free, correctly rounded |
| `from_chars_result` | `{const char* ptr; std::errc ec;}` | aggregate; `operator bool` on `ec` since C++23 |
| `to_chars(first, last, T v, int base = 10)` | integral | no null terminator written |
| `to_chars(first, last, F v)` | shortest round-trip form | |
| `to_chars(first, last, F v, chars_format)` | | |
| `to_chars(first, last, F v, chars_format, int precision)` | | |
| `to_chars_result` | `{char* ptr; std::errc ec;}` | |
| `chars_format` | `scientific`, `fixed`, `hex`, `general` | bitmask enum |

| `ec` value | Meaning | State of `v` / output |
|---|---|---|
| `std::errc{}` | success | `v` set; `ptr` = first unconsumed char |
| `std::errc::invalid_argument` | no valid conversion at `first` | `v` unmodified; `ptr == first` |
| `std::errc::result_out_of_range` | syntax valid, value unrepresentable | `v` unmodified; `ptr` = end of the matched pattern |
| `std::errc::value_too_large` | *(`to_chars` only)* buffer too small | buffer contents unspecified; `ptr == last` |

```cpp
// ---- behaviour table you must be able to recite -------------------------
//  " 12"  → invalid_argument      (no whitespace skipping)
//  "+12"  → invalid_argument      (integer overloads reject '+')
//  "-12"  → -12 for signed; invalid_argument for unsigned
//  "0x1f" base 16 → 0, ptr at 'x' (prefix NOT consumed)
//  "1f"   base 16 → 31
//  "123x" → success, 123, ptr at 'x'   → REJECT via ptr != last
//  ""     → invalid_argument
//  "99999999999999999999" into u32 → result_out_of_range, v untouched
//  "+1.5" into double → invalid_argument ('+' rejected for floats too)
//  "1e999" into double → result_out_of_range
```

**Traps** — checking `ec` but not `ptr` · reading the destination after failure · assuming `from_chars` behaves like `operator>>` or `strtol` · assuming `result_out_of_range` leaves `ptr == first` (it does not) · relying on floating `from_chars` on toolchains where it is unimplemented (libc++ historically) · passing `text.begin()`/`text.end()` where the iterators are not `const char*` on that implementation.

---

## 35.4 Fixed-point decimal parsing without intermediate strings

```text
grammar:  [+-]? [0-9]+ ( '.' [0-9]{1,ScaleDigits} )?
policy:   no whitespace · at least one integer digit · '+' accepted explicitly
          missing fraction digits zero-padded · excess precision REJECTED, not rounded
          result is a scaled std::int64_t · "-0" yields 0 · INT64_MIN reachable
```

```cpp
#include <cstdint>
#include <expected>
#include <limits>
#include <string_view>

[[nodiscard]] constexpr std::uint64_t pow10_u(unsigned n) noexcept {
    std::uint64_t r = 1;
    while (n-- != 0) r *= 10;
    return r;                                   // exact for n <= 19
}
[[nodiscard]] constexpr bool is_digit(char c) noexcept { return c >= '0' && c <= '9'; }

template<unsigned ScaleDigits>
[[nodiscard]] constexpr std::expected<std::int64_t, ParseError>
parse_fixed(std::string_view text, std::size_t base_offset = 0,
            std::uint16_t field = 0) noexcept {
    static_assert(ScaleDigits <= 18, "scale must fit alongside at least one whole digit");

    auto fail = [&](ParseCode c, std::size_t p) {
        return std::unexpected(ParseError{c, base_offset + p, field});
    };
    if (text.empty()) return fail(ParseCode::empty, 0);

    std::size_t pos = 0;
    bool negative = false;
    if (text[pos] == '-' || text[pos] == '+') {           // optional explicit sign
        negative = (text[pos] == '-');
        ++pos;
        if (pos == text.size()) return fail(ParseCode::invalid_character, pos);
    }
    if (!is_digit(text[pos])) return fail(ParseCode::invalid_character, pos);

    constexpr std::uint64_t scale = pow10_u(ScaleDigits);
    constexpr std::uint64_t pos_limit =
        static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max());   // 2^63 - 1
    constexpr std::uint64_t neg_limit = pos_limit + 1;                          // 2^63
    std::uint64_t const limit       = negative ? neg_limit : pos_limit;
    std::uint64_t const whole_limit = limit / scale;      // max representable whole part

    // ---- whole part: prove the multiply-add fits BEFORE evaluating it ----
    std::uint64_t whole = 0;
    while (pos < text.size() && is_digit(text[pos])) {
        std::uint64_t const digit = static_cast<std::uint64_t>(text[pos]) - '0';
        if (whole > (whole_limit - digit) / 10)           // whole*10+digit > whole_limit?
            return fail(ParseCode::overflow, pos);
        whole = whole * 10 + digit;
        ++pos;
    }

    // ---- fraction: bounded to ScaleDigits, no rounding -------------------
    std::uint64_t fraction = 0;
    unsigned      frac_digits = 0;
    if (pos < text.size() && text[pos] == '.') {
        ++pos;
        std::size_t const frac_start = pos;
        while (pos < text.size() && is_digit(text[pos])) {
            if (frac_digits == ScaleDigits)
                return fail(ParseCode::too_many_fraction_digits, pos);
            fraction = fraction * 10 + (static_cast<std::uint64_t>(text[pos]) - '0');
            ++frac_digits;
            ++pos;
        }
        if (pos == frac_start) return fail(ParseCode::invalid_character, pos);  // "1."
    }
    if (pos != text.size()) return fail(ParseCode::trailing_character, pos);    // "1.2.3", "1x"

    for (unsigned i = frac_digits; i < ScaleDigits; ++i) fraction *= 10;        // right-pad
    if (whole > (limit - fraction) / scale)              // whole*scale+fraction > limit?
        return fail(ParseCode::overflow, text.size());
    std::uint64_t const magnitude = whole * scale + fraction;

    if (!negative) return static_cast<std::int64_t>(magnitude);
    if (magnitude == neg_limit) return std::numeric_limits<std::int64_t>::min(); // exact 2^63
    return -static_cast<std::int64_t>(magnitude);
}

static_assert(*parse_fixed<4>("12.5")      == 125000);
static_assert(*parse_fixed<4>("-0")        == 0);
static_assert(*parse_fixed<2>("0.01")      == 1);
static_assert(!parse_fixed<2>("1.234"));                 // too_many_fraction_digits
static_assert(!parse_fixed<2>("1."));                    // invalid_character
static_assert(!parse_fixed<2>(" 1"));                    // invalid_character at 0
static_assert(parse_fixed<0>("-9223372036854775808").value()
              == std::numeric_limits<std::int64_t>::min());
```

```cpp
// ---- why the checks precede the arithmetic -----------------------------
// BAD:  auto x = x * 10 + d;  if (x < 0) return overflow;   // signed overflow is UB;
//                                                           // the compiler may delete the test
// BAD:  if (x * 10 + d > limit)                             // the overflow happens in the test
// GOOD: if (x > (limit - d) / 10) return overflow;          // pure division, cannot overflow
// Magnitude is unsigned so |INT64_MIN| == 2^63 is representable; unsigned wrap is
// well-defined anyway, but we never reach it.
```

| Policy change | Edit |
|---|---|
| Require exactly N decimals | reject when `frac_digits != ScaleDigits` |
| Accept `.5` (no whole digits) | drop the leading `is_digit` gate; treat `whole = 0` |
| Accept `5.` (empty fraction) | drop the `pos == frac_start` check |
| Round excess precision | keep scanning, inspect the first discarded digit, name the tie rule (half-up / half-even) |
| Reject `+` | delete the `'+'` branch |
| Unsigned result | reject `'-'`; use `UINT64_MAX` as `limit`, return `std::uint64_t` |
| Reject leading zeros | check `text[pos]=='0' && pos+1<size && is_digit(text[pos+1])` |
| Wider result | accumulate in `unsigned __int128` / `std::uint64_t` pairs |

**Traps** — one permissive parser silently serving two incompatible grammars · using `double` as an intermediate (0.1 is not exact; 1e17+1 loses the unit) · `text[pos] - '0'` on a signed `char` with a high-bit byte (cast to unsigned first) · forgetting that `"1.2.3"` fails at the second `.` only because of the final `pos != size` check · `scale` overflow when `ScaleDigits > 19`.

---

## 35.5 Validation, overflow, partial parse, and error offsets

```cpp
struct ParsedRecord {
    std::uint64_t id{};
    std::int64_t  price_e4{};      // fixed point, scale 10^4
    std::uint32_t quantity{};
};

[[nodiscard]] constexpr std::expected<ParsedRecord, ParseError>
parse_record(std::string_view input) noexcept {
    TextCursor cursor{input};

    auto id_f = cursor.require_until(',', 0);
    if (!id_f) return std::unexpected(id_f.error());
    auto px_f = cursor.require_until(',', 1);
    if (!px_f) return std::unexpected(px_f.error());
    auto qty_f = cursor.take_rest();                    // suffix is the last field

    auto id = parse_int<std::uint64_t>(id_f->text, id_f->offset, 10, 0);
    if (!id) return std::unexpected(id.error());

    auto px = parse_fixed<4>(px_f->text, px_f->offset, 1);
    if (!px) return std::unexpected(px.error());

    auto qty = parse_u32(qty_f.text, qty_f.offset, 2);
    if (!qty) return std::unexpected(qty.error());

    // ---- semantic validation, distinct from syntactic parsing -----------
    if (*px <= 0)
        return std::unexpected(ParseError{ParseCode::invalid_value, px_f->offset, 1});
    if (*qty == 0)
        return std::unexpected(ParseError{ParseCode::invalid_value, qty_f.offset, 2});

    // ---- transactional commit: build locally, return only when complete --
    return ParsedRecord{.id = *id, .price_e4 = *px, .quantity = *qty};
}
```

```cpp
// ---- monadic chaining (C++23) instead of the if-ladder -------------------
auto id2 = parse_int<std::uint64_t>(id_f->text, id_f->offset)
               .and_then([](std::uint64_t v) -> std::expected<std::uint64_t, ParseError> {
                   if (v == 0) return std::unexpected(ParseError{ParseCode::invalid_value, 0, 0});
                   return v;
               })
               .transform([](std::uint64_t v) { return v - 1; })      // map success
               .transform_error([](ParseError e) { e.field = 0; return e; });
```

```cpp
// ---- cold-path rendering: the ONLY place text is produced ---------------
[[nodiscard]] constexpr std::string_view describe(ParseCode c) noexcept {
    switch (c) {
        case ParseCode::ok:                       return "ok";
        case ParseCode::empty:                    return "empty field";
        case ParseCode::invalid_character:        return "invalid character";
        case ParseCode::overflow:                 return "value out of range";
        case ParseCode::trailing_character:       return "trailing characters";
        case ParseCode::missing_delimiter:        return "missing delimiter";
        case ParseCode::too_many_fraction_digits: return "excess precision";
        case ParseCode::invalid_length:           return "wrong record length";
        case ParseCode::invalid_value:            return "value rejected by schema";
        case ParseCode::output_too_small:         return "output buffer too small";
    }
    return "unknown";
}
```

| Failure class | Detected by | Offset points at |
|---|---|---|
| Empty field | `text.empty()` | field start |
| No digits at all | `errc::invalid_argument` / `!is_digit` | first bad byte |
| Valid prefix, junk suffix | `ptr != last` | first unconsumed byte |
| Numeric overflow | `errc::result_out_of_range` / pre-check | digit that would overflow |
| Narrowing overflow | explicit range compare | field end |
| Excess precision | `frac_digits == ScaleDigits` | first excess digit |
| Missing delimiter | `!FieldView::terminated` | end of consumed input |
| Too many fields | `!cursor.empty()` after last field | cursor offset |
| Schema violation | post-parse predicate | field start |

**Traps** — mutating the caller's object field-by-field and then failing halfway · reporting an offset relative to the *field* instead of the *record* · losing the field id because the error was constructed inside a generic helper · treating "value out of range" and "not a number" as one code when the caller reacts differently · `*expected` without checking (`operator*` is UB when empty; `value()` throws `bad_expected_access`).

---

## 35.6 In-place tokenization and immutable-input variants

```cpp
#include <span>

// Destructive split: delimiters become '\0' in the CALLER's writable buffer.
template<class F>
constexpr void split_in_place(std::span<char> buffer, char delim, F&& on_token) {
    std::size_t first = 0;
    for (std::size_t i = 0; i != buffer.size(); ++i) {
        if (buffer[i] == delim) {
            buffer[i] = '\0';                                  // MUTATES the owner
            on_token(std::span<char>{buffer.data() + first, i - first});
            first = i + 1;
        }
    }
    on_token(std::span<char>{buffer.data() + first, buffer.size() - first});
}

// Non-destructive split: identical allocation profile, input preserved.
template<class F>
constexpr void split_view(std::string_view input, char delim, F&& on_token) {
    std::size_t first = 0;
    for (;;) {
        auto const pos = input.find(delim, first);
        if (pos == std::string_view::npos) {
            on_token(input.substr(first), first);
            return;
        }
        on_token(input.substr(first, pos - first), first);
        first = pos + 1;
    }
}

// Bounded field table: N views, zero allocation, no callback indirection.
template<std::size_t MaxFields>
struct FieldTable {
    std::array<FieldView, MaxFields> fields{};
    std::size_t count{};
    [[nodiscard]] constexpr std::span<FieldView const> view() const noexcept {
        return {fields.data(), count};
    }
};

template<std::size_t MaxFields>
[[nodiscard]] constexpr std::expected<FieldTable<MaxFields>, ParseError>
tokenize(std::string_view input, char delim) noexcept {
    FieldTable<MaxFields> out{};
    TextCursor cursor{input};
    for (;;) {
        if (out.count == MaxFields)
            return std::unexpected(ParseError{ParseCode::overflow, cursor.offset(),
                                              static_cast<std::uint16_t>(out.count)});
        auto const f = cursor.take_until(delim);
        out.fields[out.count++] = f;
        if (!f.terminated) return out;                 // suffix consumed → done
    }
}
```

| Aspect | In-place `\0` split | Immutable subview split |
|---|---|---|
| Allocation | none | none |
| Input preserved | **no** | yes |
| Works on read-only mmap / `const` data | **no** | yes |
| Concurrent readers of the buffer | data race | safe |
| Produces C strings | yes (each token terminated) | no |
| Token lifetime | until buffer refill/destruction | until input lifetime ends |
| Re-parseable | no (delimiters destroyed) | yes |

```cpp
// Why not strtok:
//   char* t = std::strtok(buf, ",");   // mutates buf, hidden static/thread-local state,
//   while (t) t = std::strtok(nullptr, ",");   // collapses runs of delimiters (no empty
//                                              // fields), needs a terminator, not reentrant,
//                                              // gives no offsets. strtok_r fixes only reentrancy.
```

**Traps** — retaining tokens across a buffer refill · `on_token` capturing into an allocating `std::function` (use `auto&&`/a template parameter) · assuming an empty token's `data()` is dereferenceable just because a `'\0'` was written · in-place splitting a `std::string` you also intend to log · a callback that throws inside a `noexcept` parser.

---

## 35.7 Stack/static buffers and bounded output formatting

```cpp
#include <array>
#include <charconv>
#include <span>

[[nodiscard]] constexpr std::expected<std::string_view, ParseError>
format_u64(std::uint64_t value, std::span<char> out) noexcept {
    auto const r = std::to_chars(out.data(), out.data() + out.size(), value);
    if (r.ec == std::errc::value_too_large)                  // nothing usable was written
        return std::unexpected(ParseError{ParseCode::output_too_small, out.size(), 0});
    return std::string_view{out.data(), static_cast<std::size_t>(r.ptr - out.data())};
}

// Canonical inverse of parse_fixed: sign + whole + exactly ScaleDigits decimals.
template<unsigned ScaleDigits>
[[nodiscard]] constexpr std::expected<std::string_view, ParseError>
format_fixed(std::int64_t value, std::span<char> out) noexcept {
    constexpr std::uint64_t scale = pow10_u(ScaleDigits);
    // Derive the magnitude WITHOUT negating INT64_MIN.
    std::uint64_t const magnitude =
        value < 0 ? static_cast<std::uint64_t>(-(value + 1)) + 1
                  : static_cast<std::uint64_t>(value);
    bool const negative = value < 0;

    std::size_t pos = 0;
    auto put = [&](char c) noexcept {
        if (pos == out.size()) return false;
        out[pos++] = c;
        return true;
    };
    auto too_small = [&] {
        return std::unexpected(ParseError{ParseCode::output_too_small, out.size(), 0});
    };

    if (negative && !put('-')) return too_small();

    std::uint64_t const whole = magnitude / scale;
    std::uint64_t       frac  = magnitude % scale;

    auto const r = std::to_chars(out.data() + pos, out.data() + out.size(), whole);
    if (r.ec != std::errc{}) return too_small();
    pos = static_cast<std::size_t>(r.ptr - out.data());

    if constexpr (ScaleDigits > 0) {
        if (out.size() - pos < ScaleDigits + 1u) return too_small();
        out[pos++] = '.';
        for (unsigned i = ScaleDigits; i-- > 0;) {           // fill right-to-left
            out[pos + i] = static_cast<char>('0' + frac % 10);
            frac /= 10;
        }
        pos += ScaleDigits;
    }
    return std::string_view{out.data(), pos};                // borrows `out`
}

// Worst case widths: u64 = 20, i64 = 20 (incl '-'), fixed = 1 + 19 + 1 + ScaleDigits.
std::array<char, 32> scratch;                                // automatic storage
auto text = format_fixed<4>(-1250000, scratch);              // "-125.0000"
```

```cpp
// ---- to_chars floating forms -------------------------------------------
std::array<char, 64> b;
std::to_chars(b.data(), b.data()+b.size(), 0.1);                                  // shortest round-trip
std::to_chars(b.data(), b.data()+b.size(), 0.1, std::chars_format::fixed);        // "0.1"
std::to_chars(b.data(), b.data()+b.size(), 0.1, std::chars_format::scientific, 6);// "1.000000e-01"
std::to_chars(b.data(), b.data()+b.size(), 0.1, std::chars_format::hex);          // no "0x" prefix
// std::format_to_n / std::formatted_size: bounded, but the formatter machinery
// and any dynamic width/precision path is heavier than to_chars.
```

| Buffer choice | Lifetime | Races | Escapes? |
|---|---|---|---|
| Caller-provided `span<char>` | caller's | caller's problem, explicit | yes — the caller owns it |
| Function-local `std::array` | automatic | none | **no** — returned view dangles |
| Function-local `static` | program | **data race**, non-reentrant | yes, but shared/clobbered |
| `thread_local` | thread | no inter-thread race | still clobbered by reentrancy |
| `std::string` | dynamic | none | yes — but allocates |

**Traps** — returning a `string_view` into a local array · assuming `to_chars` writes a `'\0'` (it never does) · sizing a buffer for "typical" instead of worst-case digits · `-value` on `INT64_MIN` while building the magnitude · `to_chars` on failure leaves the range in an unspecified state, so do not print a partial result · forgetting the `'.'` in the capacity check.

---

## 35.8 Result types with `expected` or compact error enums

```cpp
#include <expected>

std::expected<ParsedRecord, ParseError> r = parse_record(line);

// ---- observers ----------------------------------------------------------
if (r) { /* ... */ }                    // explicit operator bool
r.has_value();
*r;                                     // UB if empty
r->id;                                  // UB if empty
r.value();                              // throws std::bad_expected_access<ParseError>
r.error();                              // UB if it HAS a value
r.value_or(ParsedRecord{});             // fallback copy
r.error_or(ParseError{});               // C++23

// ---- monadic interface --------------------------------------------------
r.and_then(f);          // f: T  -> expected<U,E>
r.or_else(g);           // g: E  -> expected<T,G>
r.transform(f);         // f: T  -> U          (wraps into expected<U,E>)
r.transform_error(g);   // g: E  -> G

// ---- construction -------------------------------------------------------
return ParsedRecord{...};                                  // implicit success
return std::expected<ParsedRecord, ParseError>{std::in_place, 1, 2, 3};
return std::unexpected(ParseError{ParseCode::empty, 0, 0}); // CTAD on unexpected
return std::unexpect;                                       // tag for in-place error
std::expected<void, ParseError> v{};                        // void specialization: check only
```

```cpp
// ---- error size discipline ---------------------------------------------
static_assert(std::is_trivially_copyable_v<ParseError>);
static_assert(sizeof(ParseError) <= 16);
// expected<T,E> is inline storage: sizeof ≈ max(sizeof T, sizeof E) + discriminant + padding.
// A hot parser returning expected<uint64_t, ParseError> passes 24 bytes in registers/stack —
// no allocation, no unwinding, no vtable.

// ---- the cheapest alternatives ------------------------------------------
struct Parsed { std::uint64_t value; ParseCode code; };  // out-param-free POD, 16 bytes
bool try_parse(std::string_view, std::uint64_t& out) noexcept;  // C-style, loses offset
std::optional<std::uint64_t> maybe(std::string_view) noexcept;  // loses WHY it failed
// std::error_code: 16 bytes but carries a category pointer + virtual message() on the cold path
// std::system_error / exceptions: allocation, unwinding, unpredictable burst latency
```

| Result shape | Size | Carries why | Carries where | Allocates |
|---|---|---|---|---|
| `bool` + out-param | 1 + T | no | no | no |
| `std::optional<T>` | sizeof T + 1 | no | no | no |
| `expected<T, ParseCode>` | max(T,1)+1 | yes | no | no |
| `expected<T, ParseError>` | max(T,16)+8 | yes | offset + field | no |
| `expected<T, std::error_code>` | max(T,16)+8 | yes | no | no (message() may) |
| `expected<T, std::string>` | max(T,32)+8 | yes | free-form | **yes** |
| throw `std::runtime_error` | — | yes | free-form | **yes** |

**Interview line** — "Malformed input at a trust boundary is expected control flow, not an exceptional condition, so it belongs in the return type — `std::expected` stores the error inline and costs no allocation and no unwinding."

**Traps** — `noexcept` on a parser whose result type has a throwing move, or that calls a user callback · `[[nodiscard]]` missing, so a failure is silently dropped · `operator*` on an errored `expected` · putting a `std::string` message in `E` and calling the parser allocation-free · an `E` larger than `T`, which silently inflates every success path.

---

## 35.9 No exceptions, locale, streams, regex, or hidden allocation on the hot path

```cpp
// ---- the <cctype> UB trap ----------------------------------------------
#include <cctype>
char c = input[i];
// if (std::isdigit(c)) ...                       // UB when char is signed and c < 0
if (std::isdigit(static_cast<unsigned char>(c))) {}   // required conversion
constexpr bool digit = c >= '0' && c <= '9';          // better: ASCII, locale-free, branch-cheap
// std::tolower(c) has the identical unsigned-char requirement.
// Locale-aware classification can accept digits and separators outside a strict ASCII grammar.
```

```cpp
// ---- what NOT to do ------------------------------------------------------
std::istringstream in{std::string{field}};   // allocates the string AND drags in locale facets
in >> value;                                 // skips whitespace by default, sets stream state
double d = std::stod(std::string{field});    // allocation + throws + locale decimal point
double e = std::strtod(field.data(), &end);  // needs a terminator; sets errno; locale-dependent
std::regex re{R"((\d+),(\d+))"};             // construction allocates; matching may allocate
std::smatch m;                               // ALLOCATES: vector of sub_match
std::vector<std::string> tokens;             // one allocation per token + growth
std::function<void(std::string_view)> cb;    // may allocate for a large capture
```

| Facility | Contract mismatch |
|---|---|
| `std::istringstream` / `operator>>` | locale + facet machinery, stream state bits, whitespace skipping, heavy control flow |
| `std::stod` / `std::stoi` | takes `std::string` (allocates), throws on failure, no offset |
| `strtod` / `strtol` | needs null termination, `errno`, locale decimal point, `0x`/octal inference |
| `std::regex` | construction and matching allocate; no capacity control; no complexity bound |
| `std::smatch` / `std::cmatch` | owns a `vector` of sub-matches |
| Per-field `std::string` | allocation per token beyond SSO; adds a terminator you did not need |
| Exceptions for malformed fields | unwinding cost, cold metadata, latency bursts under an attack |
| `std::format` / `iostream` logging per error | allocation, locks, I/O, amplification under bad input |
| `std::function` callback | type-erased, may allocate, opaque to inlining |

```text
Hidden-allocation audit checklist
  □ returned vector/string/map of tokens or errors
  □ growing error message or context string
  □ callback stored in std::function instead of a template parameter
  □ std::string temporary built only to get a null terminator
  □ lazy first-use init of locale, logging, or regex objects
  □ downstream insertion into an unreserved container
  □ coroutine frame / std::generator around the parse loop
  □ std::expected<T, E> where E owns dynamic storage
  □ std::pmr container whose monotonic arena has fallen back upstream
```

```bash
# Prove it, do not assert it: override the allocator and count in a steady-state test.
```

```cpp
static std::atomic<std::size_t> g_allocs{0};
void* operator new(std::size_t n) { g_allocs.fetch_add(1, std::memory_order_relaxed);
                                    return std::malloc(n); }
void  operator delete(void* p) noexcept { std::free(p); }
void  operator delete(void* p, std::size_t) noexcept { std::free(p); }
// Warm up first (locale/iostream init allocates once), snapshot, run N records, assert delta == 0.
```

**Traps** — `noexcept` asserted but a callee throws → `std::terminate` · "regex is allocation-free after warm-up" is an observation, not a contract · `std::string` SSO hides allocation for short test fields and reveals it in production · pmr `monotonic_buffer_resource` silently allocating upstream once the stack buffer is exhausted · measuring allocation only in the valid path, never in the error burst.

---

## 35.10 Benchmark cases: valid, malformed, truncated, and worst-case input

| Case | What it exercises |
|---|---|
| Typical valid record | ordinary branch prediction and locality |
| Minimum / maximum value | digit count and the overflow boundary |
| Longest legal field and record | worst *valid* work per record |
| Empty field | earliest failure path |
| Invalid first character | early rejection, minimal work |
| Invalid last character | full scan, then failure |
| Overflow at the final digit | worst overflow-detection work |
| `ScaleDigits + 1` fraction digits | precision rejection path |
| Missing delimiter / truncated record | framing interaction |
| Maximum field count | loop bound and metadata bound |
| Repeated malformed burst | error-path amplification / DoS shape |
| Embedded NUL, high-bit bytes | byte-safety of the scanner |
| Alternating valid/invalid | branch mispredict cost |

```cpp
// ---- measurement skeleton (google-benchmark shape) ----------------------
static void BM_ParseRecord(benchmark::State& state) {
    auto const corpus = make_corpus(state.range(0));   // BUILT OUTSIDE the loop
    std::size_t i = 0;
    for (auto _ : state) {
        auto r = parse_record(corpus[i++ % corpus.size()]);   // vary input: no const-fold
        benchmark::DoNotOptimize(r);                          // consume the result
    }
    state.SetBytesProcessed(state.iterations() * corpus[0].size());
    state.SetItemsProcessed(state.iterations());
}
BENCHMARK(BM_ParseRecord)->Arg(1)->Arg(1024);   // 1 = pure const-fold trap, 1024 = realistic
```

```bash
# Correctness first, then speed.
g++ -std=c++23 -O2 -Wall -Wextra -Wconversion -fsanitize=address,undefined parser_test.cpp
./a.out
# Fuzz the whole surface: any byte sequence must terminate, stay in bounds, and be deterministic.
clang++ -std=c++23 -O1 -g -fsanitize=fuzzer,address,undefined fuzz_parse.cpp
./a.out -max_len=256 -runs=5000000
```

```cpp
// ---- fuzz entry point ---------------------------------------------------
extern "C" int LLVMFuzzerTestOneInput(std::uint8_t const* data, std::size_t size) {
    std::string_view input{reinterpret_cast<char const*>(data), size};
    auto const r = parse_record(input);
    if (r) {
        std::array<char, 64> buf;
        auto const t = format_fixed<4>(r->price_e4, buf);          // round-trip invariant
        assert(t && *parse_fixed<4>(*t) == r->price_e4);
    } else {
        assert(r.error().offset <= size);                          // offset stays in bounds
    }
    return 0;
}
```

**Test matrix — integer fields**: `0`, max, max+1, signed min/max, empty, sign-only, leading `+`/`-`, leading zeros, whitespace at both ends, valid prefix + invalid suffix, every supported base, forbidden `0x` prefix.
**Test matrix — scaled decimal**: `0`, `-0`, max positive, min negative, 0..N fraction digits, N+1 digits, missing whole/fraction digits, second `.`, overflow in the whole accumulation, overflow only after scaling, the exact boundary where the fraction tips an otherwise-fitting whole, round-trip through `format_fixed`.
**Test matrix — records**: every truncation point, every missing delimiter, empty fields, trailing delimiter, exact/too few/too many fields, embedded NUL, high-bit bytes, maximum length and field count, returned-view lifetime.

- Keep input generation and result logging outside the measured region.
- Vary inputs and consume results, or you benchmark constant propagation.
- Report bytes/s, records/s, **and** a latency distribution — not just a mean.
- Use the production error distribution *plus* adversarial cases.
- Count allocations in a separate instrumented run, not by reading the source.
- Compare against a slow reference parser on the same corpus.
- Read the disassembly only after end-to-end measurement proves parsing is material.

**Traps** — benchmarking one short valid literal · letting the optimizer hoist the parse out of the loop · a corpus that fits entirely in L1 while production streams from a NIC ring · ignoring the malformed-burst path, which is exactly what an adversary controls.

---

## Recall card

```text
string_view        borrowed ptr+len; no terminator, no lifetime extension
span<const char>   borrowed bounded chars; subspan, no substr
cursor             scan once forward, keep byte offset, distinguish delimiter vs EOF
from_chars         no alloc/locale/whitespace/'+'/0x; check ec AND ptr == last
errc               invalid_argument | result_out_of_range; destination untouched on failure
fixed decimal      unsigned magnitude, explicit scale, reject excess precision
overflow           acc > (limit - d) / 10   BEFORE the multiply-add
INT64_MIN          |min| == 2^63 → accumulate unsigned, special-case at the end
to_chars           caller-owned bounded output; no '\0'; value_too_large on overflow
error              enum code + byte offset + field id; format on the cold path
expected<T,E>      inline storage, no allocation, monadic and_then/or_else/transform
in-place split     mutates the owner, tokens still borrow, no read-only mmap
immutable split    same zero-allocation profile, input preserved
off the hot path   streams, stod/strtod, regex, per-token string, exceptions, log formatting
evidence           boundary tests + fuzz + reference comparison + allocation counter
```

**Interview line** — "An allocation-free parser is a bounded state machine over borrowed characters: it scans once, proves each arithmetic step fits before evaluating it, commits only complete typed values, and reports failure as a compact code plus a byte offset."
