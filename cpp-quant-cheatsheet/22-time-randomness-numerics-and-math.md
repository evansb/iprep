# 22. Time, randomness, numerics, and math

*Part III — Standard library quick reference*

---

**Recall**
- `duration<Rep, Period>` is a count of ticks plus a compile-time `std::ratio` of seconds per tick — the period lives in the type, never in a comment.
- `time_point<Clock, Duration>` is a duration since *one specific clock's* epoch; two clocks are two incomparable domains.
- Implicit duration conversion is allowed only when it cannot lose value (integral widening, or any conversion to a floating `Rep`); narrowing needs an explicit cast.
- `duration_cast` truncates **toward zero**; `floor` truncates **toward −∞** — they differ for negative durations.
- `round` on chrono ties to **even**; `ceil` goes toward +∞.
- chrono is unit-safe, not range-safe: `Rep` arithmetic can still overflow.
- `steady_clock` is the only standard clock guaranteed monotonic (`is_steady == true`) — use it for every elapsed measurement and deadline.
- `system_clock` can jump forward or backward from NTP/admin adjustment; it is the only one convertible to `time_t` and civil time.
- `high_resolution_clock` is an alias of one of the other two on every real implementation — it guarantees nothing.
- Calendar types can *hold* invalid civil combinations (`2025y/February/29d`); `.ok()` is the only validation.
- Local times are not unique: a DST fold makes one ambiguous (two instants) and a spring-forward gap makes one nonexistent (zero instants).
- A random *engine* is a deterministic state machine over bits; a *distribution* maps those bits to a value family — only the engine sequence is portable across implementations.
- `std::random_device` may be deterministic, may block, may throw, and may be extremely slow — call it once at setup, never per sample.
- `engine() % n` is biased unless the engine range is an exact multiple of `n`; use `uniform_int_distribution`.
- Distributions carry state (`normal_distribution` caches a second Box–Muller value), so replaying the engine alone can diverge.
- `accumulate` is a strictly ordered left fold; `reduce`/`transform_reduce`/scans may regroup, so floating results legitimately differ.
- The init value of `accumulate` determines the accumulator *type* — `0` silently makes a `double` sum integral.
- `<cmath>` reports errors via `errno` and/or floating-point exception flags per `math_errhandling`, never via C++ exceptions.
- NaN compares `false` against everything including itself; `+0.0 == -0.0` is `true` but `signbit` and `1/x` distinguish them.
- `-ffast-math` silently repeals NaN/inf/signed-zero/`errno`/associativity guarantees — build flags are part of numeric semantics.
- Deterministic cores take time and randomness as *explicit inputs*; anything calling `now()` or a hidden RNG inside a state transition cannot be replayed.

---

## 22.1 `<chrono>` durations, time points, clocks, and conversions

```cpp
#include <chrono>
using namespace std::chrono;
using namespace std::chrono_literals;   // 1ns 1us 1ms 1s 1min 1h 1d 1y (d/y are calendar!)

// ---- duration<Rep, Period> --------------------------------------------
duration<std::int64_t, std::ratio<1, 1'000'000'000>> raw_ns{5};  // spelled out
nanoseconds  a{5};                     // predefined typedefs, all signed integral
microseconds b = 250us;
milliseconds c{2};
seconds      s{1};
minutes      m{1};
hours        h{1};
days         D{1};                     // C++20: 24h
weeks        W{1};                     // C++20: 7 days
months       M{1};                     // C++20: 30.436875 days (AVERAGE — not a calendar month)
years        Y{1};                     // C++20: 365.2425 days (AVERAGE)

duration<double>                fp_sec{1.5};   // Period defaults to ratio<1>
duration<double, std::milli>    fp_ms{0.5};
using HundredNs = duration<std::int64_t, std::ratio<1, 10'000'000>>;  // Windows FILETIME tick
using Frame60   = duration<std::int64_t, std::ratio<1, 60>>;

auto ticks = c.count();                // 2 — a bare Rep with NO unit; do not export this
constexpr auto zero = nanoseconds::zero();
constexpr auto lo   = nanoseconds::min();
constexpr auto hi   = nanoseconds::max();
```

```cpp
// ---- conversions -------------------------------------------------------
nanoseconds widened = 250us;           // OK: implicit, exact (ratio divides evenly)
// milliseconds narrowed = 1500ns;     // ill-formed: would lose value
auto d1 = duration_cast<milliseconds>(1'500'001ns);  // 1ms   truncate toward ZERO
auto d2 = floor<milliseconds>(1'500'001ns);          // 1ms   toward -inf
auto d3 = ceil<milliseconds>(1'500'001ns);           // 2ms   toward +inf
auto d4 = round<milliseconds>(1'500'001ns);          // 2ms   nearest, ties to EVEN
auto d5 = abs(-3ms);                                 // 3ms   (signed Rep only)

auto neg = -1500us;
duration_cast<milliseconds>(neg);      // -1ms   <-- differs
floor<milliseconds>(neg);              // -2ms   <-- from this
duration<double, std::milli> exact = 1'500'001ns;    // implicit: floating Rep never "loses"

// ---- arithmetic: common_type_t picks the FINER period ------------------
auto total = 2ms + 500us;              // duration<int64,micro> == 2500us
auto scal  = total / 500us;            // common_type_t<Rep> — a plain integer 5
auto half  = total / 2;                // duration          1250us
auto rem   = total % 1ms;              //                    500us
total += 1ms; total -= 1ms; ++total; total *= 2; total /= 2;
bool eq = (1000ms == 1s);              // true — compared in the common period
auto cmp = (1000ms <=> 1s);            // std::strong_ordering::equal (C++20)
```

```cpp
// ---- time_point<Clock, Duration> ---------------------------------------
using Clock    = steady_clock;
using Deadline = Clock::time_point;    // == time_point<steady_clock, Clock::duration>

Deadline deadline_after(Clock::duration t) { return Clock::now() + t; }
bool     expired(Deadline dl)              { return Clock::now() >= dl; }

auto t0 = Clock::now();
do_work();
Clock::duration elapsed = Clock::now() - t0;        // tp - tp -> duration
auto us_elapsed = duration_cast<microseconds>(elapsed).count();

auto later  = t0 + 5ms;                // tp + dur -> tp
auto before = t0 - 5ms;
auto since  = t0.time_since_epoch();   // duration since THIS clock's unspecified epoch
time_point<steady_clock, milliseconds> coarse = time_point_cast<milliseconds>(t0);
auto rtp = round<milliseconds>(t0);    // floor/ceil/round also work on time_points
// auto bad = system_clock::now() - steady_clock::now();  // ill-formed: different clocks
```

| Facility | Form | Notes |
|---|---|---|
| `duration<Rep, Period>` | `count()`, `zero()`, `min()`, `max()` | `Period` is `std::ratio` seconds/tick |
| `duration_cast<D>(d)` | explicit | truncates toward zero; `constexpr` |
| `floor<D>` / `ceil<D>` / `round<D>` | explicit (C++17) | −∞ / +∞ / nearest-ties-even |
| `abs(d)` | signed `Rep` only | C++17 |
| `time_point<C, D>` | `time_since_epoch()`, `min()`, `max()` | epoch is per-clock, unspecified |
| `time_point_cast<D>(tp)` | explicit | changes precision, **not** clock |
| `clock_cast<C2>(tp)` | C++20 | only among `system`/`utc`/`tai`/`gps`/`file`/`local` |
| `duration_values<Rep>` | `zero/min/max` customization | for user `Rep` types |
| `treat_as_floating_point<Rep>` | trait | true ⇒ implicit conversions always allowed |
| `common_type_t<D1, D2>` | gcd of periods | mixed arithmetic result type |
| `hh_mm_ss<D>` | `hours/minutes/seconds/subseconds/is_negative/to_duration` | decomposes a duration |

```cpp
// ---- writing clock-generic and unit-safe interfaces ---------------------
template<class Rep, class Period>
void sleep_budget(duration<Rep, Period> d);              // accepts ANY duration
void sleep_budget_ns(nanoseconds d);                     // callers convert implicitly
// void bad(std::int64_t nanos);                         // unit erased at the boundary

std::this_thread::sleep_for(50us);                       // <thread>
std::this_thread::sleep_until(deadline);                 // absolute — no drift accumulation
cv.wait_for(lock, 10ms); cv.wait_until(lock, deadline);  // <condition_variable>
```

**Traps** — `1d`/`1y` are calendar `days`/`years`, not "day"/"year" durations you can mix with `months` exactly · `months`/`years` are *average* lengths, useless for civil arithmetic · `count()` at an API boundary throws away the unit · `duration_cast` on a negative value is not `floor` · overflow in `Rep` is UB for signed types even though the units are correct.

---

## 22.2 `steady_clock` versus `system_clock`

```cpp
// ---- the standard clocks -----------------------------------------------
system_clock::now();            // wall time; to_time_t/from_time_t; CAN JUMP
steady_clock::now();            // monotonic, never adjusted; epoch meaningless
high_resolution_clock::now();   // alias of one of the above — guarantees NOTHING
utc_clock::now();               // C++20: includes leap seconds
tai_clock::now();               // C++20: no leap seconds, offset 37s from UTC (as of 2017)
gps_clock::now();               // C++20: GPS timescale
file_clock::now();              // C++20: std::filesystem::file_time_type's clock
// local_t is a PSEUDO-clock: no now(), tags a local_time with no zone attached
```

| Clock | `is_steady` | Epoch | Convertible to civil | Use for |
|---|---|---|---|---|
| `steady_clock` | **true** | unspecified (often boot) | no | elapsed time, deadlines, latency |
| `system_clock` | usually false | Unix epoch since C++20 | yes (`sys_days`, `time_t`) | timestamps, logs, civil time |
| `high_resolution_clock` | impl-defined | impl-defined | maybe | nothing — name it explicitly instead |
| `utc_clock` | false | 1970-01-01 UTC incl. leaps | yes | leap-second-correct durations |
| `tai_clock` | false | 1958-01-01 | yes | continuous atomic timescale |
| `gps_clock` | false | 1980-01-06 | yes | GPS-stamped feeds |
| `file_clock` | impl-defined | impl-defined | yes | filesystem timestamps |

```cpp
// ---- the deadline bug ---------------------------------------------------
auto bad_dl = system_clock::now() + 100ms;
while (system_clock::now() < bad_dl) { /* NTP step backward => spins ~forever */ }

auto good_dl = steady_clock::now() + 100ms;      // immune to wall-clock adjustment
while (steady_clock::now() < good_dl) { /* bounded */ }

static_assert(steady_clock::is_steady);          // the guarantee, not the name
```

```cpp
// ---- legacy and cross-clock conversion ----------------------------------
auto now = system_clock::now();
std::time_t legacy = system_clock::to_time_t(now);      // seconds; PRECISION LOST
auto back          = system_clock::from_time_t(legacy);
auto utc  = clock_cast<utc_clock>(now);                 // C++20, leap-aware
auto tai  = clock_cast<tai_clock>(now);
auto file = clock_cast<file_clock>(now);

// Cross-domain (exchange epoch <-> steady) needs an explicit calibration pair:
struct Calibration { system_clock::time_point wall; steady_clock::time_point mono; };
Calibration cal{system_clock::now(), steady_clock::now()};
auto approx_wall = cal.wall + (steady_clock::now() - cal.mono);   // drifts; re-calibrate
```

```cpp
// ---- clock reads are not free -------------------------------------------
// now() -> vDSO read (~15-30ns) or full syscall (~hundreds of ns) by platform.
// Measuring every event perturbs the path being measured.
auto t0 = steady_clock::now();
for (auto const& msg : batch) handle(msg);      // ONE pair per batch
auto per_msg = (steady_clock::now() - t0) / batch.size();
// TSC-style counters (rdtsc) are faster but need pinning, invariant-TSC and calibration.
```

**Interview line** — "`steady_clock` for how long, `system_clock` for when; they are different types precisely so you cannot subtract one from the other."

**Traps** — `high_resolution_clock` assumed monotonic · casting both clocks' points to `int64` nanoseconds to "fix" the type error creates a fake common epoch · `to_time_t` truncates subsecond precision · `steady_clock`'s epoch is not comparable across processes or machines.

---

## 22.3 Calendars, time zones, formatting, and leap-second caveats

```cpp
// ---- calendar types (C++20) ---------------------------------------------
year  y{2026};  month mo{8};  day d{8};
weekday wd{Monday};                     // Sunday..Saturday, plus 0..6
year_month_day ymd = 2026y / August / 8d;       // any of the 3 orderings works
year_month_day alt = 8d / August / 2026y;
year_month_day iso = August / 8d / 2026y;
if (!ymd.ok()) return;                          // ONLY validation — construction never throws

year_month_day bad = 2025y / February / 29d;    // representable!
assert(!bad.ok());

year_month_day_last eom  = 2026y / August / last;     // last day of month
year_month_weekday      third_fri = 2026y / August / Friday[3];   // 3rd Friday
year_month_weekday_last last_fri  = 2026y / August / Friday[last];// expiry dates
month_day  md  = August / 8d;
month_day_last mdl = August / last;
year_month ym = 2026y / August;

// ---- serial <-> field --------------------------------------------------
sys_days sd{ymd};                       // time_point<system_clock, days> — days since epoch
year_month_day round_trip{sd};          // back to fields
sys_seconds ss = sd + 9h + 30min;
auto dow = weekday{sd};                 // day-of-week comes from the SERIAL form
auto count = sd.time_since_epoch().count();     // days since 1970-01-01
```

```cpp
// ---- calendar vs linear arithmetic --------------------------------------
auto next_month = ymd + months{1};      // FIELD arithmetic: 2026-09-08; may be !ok()
auto jan31 = 2026y/January/31d;
auto feb   = jan31 + months{1};         // 2026-02-31 — representable and NOT ok()
auto fixed = year_month_day{sys_days{feb.year()/feb.month()/last}};   // clamp policy
auto tomorrow = sys_days{ymd} + days{1};        // LINEAR: always a valid day point
auto biz_gap  = sys_days{b} - sys_days{a};      // days between two dates

// ---- time of day --------------------------------------------------------
auto now   = system_clock::now();
auto today = floor<days>(now);                  // midnight UTC of today
hh_mm_ss tod{now - today};                      // decompose; NOT a zone lookup
auto hr = tod.hours(); auto mi = tod.minutes();
auto se = tod.seconds(); auto sub = tod.subseconds();
bool pm = is_pm(tod.hours()); auto h12 = make12(tod.hours());
```

| Calendar type | Members | Note |
|---|---|---|
| `day` / `month` / `year` | `ok()`, `operator unsigned/int`, `++/--/+=` | `year::min()==-32767`, `max()==32767` |
| `weekday` | `c_encoding()`, `iso_encoding()`, `operator[]` | `wd[n]` → `weekday_indexed`, `wd[last]` |
| `year_month_day` | `year() month() day() ok()`, → `sys_days` | the workhorse |
| `year_month_day_last` | `+ day()` resolves month end | leap-year aware |
| `year_month_weekday(_last)` | nth / last weekday of month | expiries, roll dates |
| `hh_mm_ss<D>` | `hours minutes seconds subseconds is_negative to_duration` | `fractional_width` static |
| `last_spec` (`last`) | tag object | `y/m/last`, `wd[last]` |

```cpp
// ---- time zones ---------------------------------------------------------
auto const* db_zone = locate_zone("Asia/Singapore");   // throws std::runtime_error if unknown
auto const* cur     = current_zone();
zoned_time zt{db_zone, system_clock::now()};
sys_time<system_clock::duration>   utc_tp   = zt.get_sys_time();
local_time<system_clock::duration> local_tp = zt.get_local_time();
auto info = db_zone->get_info(system_clock::now());    // sys_info: offset, save, abbrev

zoned_time ny{"America/New_York", local_days{2026y/March/8d} + 2h30min};   // GAP
// throws nonexistent_local_time  (02:30 does not exist on that date)
zoned_time amb{"America/New_York", local_days{2026y/November/1d} + 1h30min};
// throws ambiguous_local_time    (01:30 occurs twice)
zoned_time pick1{"America/New_York", lt, choose::earliest};   // policy, never throws
zoned_time pick2{"America/New_York", lt, choose::latest};
auto& tzdb = get_tzdb();                 // tzdb: version, zones, links, leap_seconds
reload_tzdb();                           // pick up host database updates explicitly
```

```cpp
// ---- leap seconds --------------------------------------------------------
auto u = clock_cast<utc_clock>(system_clock::now());
auto lsi = get_leap_second_info(u);      // {bool is_leap_second; seconds elapsed;}
// sys_time durations IGNORE leap seconds; utc_time durations count them.
// A 1972..now duration differs by 27s between the two timescales.
```

```cpp
// ---- formatting (C++20 <format>, chrono specs) ---------------------------
std::string t1 = std::format("{:%F %T}", floor<seconds>(now));   // 2026-08-08 09:30:00
std::string t2 = std::format("{:%Y-%m-%dT%H:%M:%S%Ez}", zt);     // ISO-8601 with +hh:mm
std::string t3 = std::format("{:%F %T %Z}", zt);                 // ... SGT
std::string t4 = std::format("{:>12%T}", 90s);                   // fill/align/width apply
std::string t5 = std::format("{:%Q %q}", 250us);                 // "250 us" — duration only
std::string t6 = std::format("{}", 250us);                       // "250us" default form
std::string t7 = std::format("{:%j}", ymd);                      // day of year
std::string t8 = std::format(std::locale("de_DE"), "{:L%A}", wd);// locale-aware
std::cout << ymd << ' ' << 250us << ' ' << zt << '\n';           // operator<< for all
```

| Spec | Meaning | Spec | Meaning |
|---|---|---|---|
| `%Y` `%y` `%C` | year / 2-digit year / century | `%H` `%I` `%p` | 24h / 12h / AM-PM |
| `%m` `%b` `%h` `%B` | month num / abbrev / abbrev / full | `%M` `%S` | minute / second (incl. subseconds) |
| `%d` `%e` | day zero-padded / space-padded | `%R` `%T` `%r` | `%H:%M` / `%H:%M:%S` / locale 12h |
| `%a` `%A` `%u` `%w` | weekday abbrev/full/ISO 1-7/0-6 | `%D` `%F` `%x` | `%m/%d/%y` / `%Y-%m-%d` / locale date |
| `%j` | day of year (or duration days) | `%X` `%c` | locale time / locale date+time |
| `%G` `%g` `%V` | ISO week-year / 2-digit / ISO week | `%z` `%Ez` `%Oz` | `+hhmm` / `+hh:mm` / `+hh:mm` |
| `%U` `%W` | week of year (Sun / Mon first) | `%Z` | zone abbreviation |
| `%Q` `%q` | duration tick count / unit suffix | `%n` `%t` `%%` | newline / tab / literal `%` |
| `%s` (C++23) | seconds since epoch | `%OS` `%EY` … | locale alternative forms |

```cpp
// ---- parsing -------------------------------------------------------------
std::istringstream in{"2026-08-08 09:30:00"};
sys_seconds parsed;
in >> parse("%F %T", parsed);                 // C++20
if (in.fail()) return error;                  // ALWAYS check the stream
year_month_day ymd2; std::string zone_abbrev; minutes offset;
in >> parse("%F", ymd2) >> parse("%Z", zone_abbrev) >> parse("%z", offset);
if (!ymd2.ok()) return error;                 // parsed successfully != valid civil date
from_stream(in, "%F %T", parsed);             // the underlying customization point
```

**Traps** — a `year_month_day` that parsed is not a date that exists · `+ months{1}` can produce Feb 31 · local time treated as unique · zone-database version silently drifts with the host (pin it for reproducible backtests) · `%S` on a floating-`Rep` duration prints fractional seconds whose width comes from the type · formatting allocates and can take locale/tzdb locks — never on a capture path.

---

## 22.4 `<random>` engines, distributions, seeding, and reproducibility

```cpp
#include <random>

std::mt19937_64 eng{123456789ull};                // engine: deterministic bit source
std::uniform_int_distribution<int> side{0, 1};    // distribution: bits -> values
int sample = side(eng);                           // distribution consumes engine output
```

```cpp
// ---- every engine construction / seeding form ----------------------------
std::mt19937 e1;                                  // default_seed (5489u) — reproducible
std::mt19937 e2{42u};                             // scalar seed
std::seed_seq ss{1u, 2u, 3u, 4u};                 // sequence seed (expands to full state)
std::mt19937 e3{ss};
std::array<std::uint32_t, std::mt19937::state_size> st{};
std::random_device rd;                            // may throw, may block, may be fake
std::generate(st.begin(), st.end(), std::ref(rd));
std::seed_seq full(st.begin(), st.end());
std::mt19937 e4{full};                            // fully-seeded state (best practice)

e1.seed();            // back to default_seed
e1.seed(7u);
e1.seed(ss);          // NOTE: seed_seq is consumed/re-generated, not copied cheaply
e1.discard(1000);     // advance 1000 draws (may be O(1) for some engines, O(n) generally)
auto x  = e1();                                   // one draw
auto lo = std::mt19937::min(), hi2 = std::mt19937::max();   // static constexpr range
std::ostringstream save; save << e1;              // FULL textual state round-trip
std::istringstream load{save.str()}; load >> e1;
bool same = (e1 == e4);                           // engines are equality-comparable
static_assert(std::uniform_random_bit_generator<std::mt19937>);   // C++20 concept
```

| Engine / adaptor | Kind | State | Notes |
|---|---|---|---|
| `linear_congruential_engine<UInt,a,c,m>` | LCG | 1 word | fast, poor quality, short period |
| `minstd_rand0` | LCG (a=16807) | 4 B | historical |
| `minstd_rand` | LCG (a=48271) | 4 B | fast, cheap, low quality |
| `mersenne_twister_engine<...>` | MT | 624 words | period 2^19937−1 |
| `mt19937` / `mt19937_64` | MT | 2.5 KB / 5 KB | good statistical quality, **not** cryptographic, big cache footprint |
| `subtract_with_carry_engine<...>` | lagged Fibonacci | 24/48 words | base for ranlux |
| `ranlux24_base` / `ranlux48_base` | SWC | small | base engines |
| `ranlux24` / `ranlux48` | `discard_block_engine` over base | small | high quality, **expensive** (discards blocks) |
| `knuth_b` | `shuffle_order_engine<minstd_rand0,256>` | 1 KB | shuffled LCG |
| `discard_block_engine<E,p,r>` | adaptor | — | keeps `r` of every `p` outputs |
| `independent_bits_engine<E,w,UInt>` | adaptor | — | repacks output to exactly `w` bits |
| `shuffle_order_engine<E,k>` | adaptor | — | permutes output order via a table |
| `default_random_engine` | impl-selected alias | — | **sequence is not portable** |
| `random_device` | entropy interface | — | `entropy()` may return 0 ⇒ deterministic fallback; may throw |

```cpp
// ---- random_device: setup only ------------------------------------------
std::random_device rd2;                 // ctor may throw std::system_error (no device)
double ent = rd2.entropy();             // 0.0 means "possibly deterministic" (MinGW famously)
std::uint32_t seed_word = rd2();        // may be a syscall / may block on low entropy
// NEVER: for (...) dist(rd2);          // orders of magnitude slower than an engine
```

```cpp
// ---- reproducible stream policy ------------------------------------------
struct RngStream {
    std::uint64_t seed;                 // logged with every run
    std::mt19937_64 engine;
    explicit RngStream(std::uint64_t s) : seed{s}, engine{s} {}
};
// Per-thread streams (no shared mutable engine, no locks, no scheduling dependence):
std::mt19937_64 make_stream(std::uint64_t run_seed, std::uint32_t stream_id) {
    std::seed_seq ss{static_cast<std::uint32_t>(run_seed),
                     static_cast<std::uint32_t>(run_seed >> 32), stream_id};
    return std::mt19937_64{ss};
}
```

| Distribution | Header type | Parameters | Notes |
|---|---|---|---|
| `uniform_int_distribution<I>` | discrete | `[a, b]` **inclusive** | unbiased; default `[0, I_max]` |
| `uniform_real_distribution<R>` | continuous | `[a, b)` | `b` excluded in principle, reachable via rounding |
| `bernoulli_distribution` | discrete | `p` | returns `bool` |
| `binomial_distribution<I>` | discrete | `t, p` | |
| `negative_binomial_distribution<I>` | discrete | `k, p` | |
| `geometric_distribution<I>` | discrete | `p` | failures before first success |
| `poisson_distribution<I>` | discrete | `mean` | arrival counts |
| `exponential_distribution<R>` | continuous | `lambda` | inter-arrival times |
| `gamma_distribution<R>` | continuous | `alpha, beta` | |
| `weibull_distribution<R>` | continuous | `a, b` | |
| `extreme_value_distribution<R>` | continuous | `a, b` | Gumbel |
| `normal_distribution<R>` | continuous | `mean, stddev` | **caches** a second variate |
| `lognormal_distribution<R>` | continuous | `m, s` | price-return models |
| `chi_squared_distribution<R>` | continuous | `n` | |
| `cauchy_distribution<R>` | continuous | `a, b` | no mean/variance — fat tails |
| `fisher_f_distribution<R>` | continuous | `m, n` | |
| `student_t_distribution<R>` | continuous | `n` | fat-tailed returns |
| `discrete_distribution<I>` | discrete | weights | index by probability weight |
| `piecewise_constant_distribution<R>` | continuous | boundaries + weights | histogram sampling |
| `piecewise_linear_distribution<R>` | continuous | boundaries + weights | |
| `generate_canonical<R, bits>(g)` | function | — | uniform in `[0, 1)` with `bits` of entropy |

```cpp
// ---- distribution API surface (identical for all) ------------------------
std::normal_distribution<double> nd{0.0, 1.0};
double v  = nd(eng);                                   // sample
auto  mu  = nd.mean(); auto sd2 = nd.stddev();         // per-distribution accessors
auto  p   = nd.param();                                // param_type snapshot
nd.param(std::normal_distribution<double>::param_type{0.0, 2.0});
double v2 = nd(eng, decltype(nd)::param_type{1.0, 3.0});   // one-shot params, state kept
nd.reset();                                            // DROP cached state (Box-Muller pair)
auto lo3 = nd.min(), hi3 = nd.max();                   // support bounds
std::ostringstream os; os << nd;                       // serializable state
bool same_d = (nd == std::normal_distribution<double>{0.0, 2.0});

std::uniform_int_distribution<std::uint32_t> pick(0, n - 1);   // INCLUSIVE bounds
auto index = pick(eng);
// auto biased = eng() % n;   // biased unless (max-min+1) % n == 0
```

```cpp
// ---- shuffling and sampling ---------------------------------------------
std::ranges::shuffle(v, eng);                       // C++20; std::shuffle for iterators
std::ranges::sample(pop, std::back_inserter(out), 5, eng);   // reservoir sampling
// std::random_shuffle  — REMOVED in C++17
```

**Reproducibility contract**

| Guaranteed portable | Not guaranteed portable |
|---|---|
| Engine output sequence for a named engine + seed | Any distribution's mapping of engine bits to values |
| `seed_seq` expansion | `default_random_engine`'s identity |
| Engine text serialization round-trip within one implementation | `random_device` output or entropy |
| `discard(n)` semantics | `shuffle`/`sample` element order across libraries |

- To replay across toolchains: record the final generated values, pin the toolchain, or own the mapping (e.g. Lemire bounded-uniform) yourself.

**Traps** — sharing one engine across threads is a data race · `mt19937 e{rd()}` seeds 19937 bits of state from 32 bits · replaying the engine but not `normal_distribution`'s cached variate · `uniform_int_distribution(0, n)` includes `n` (off-by-one vs container size) · rejection-based distributions have unbounded worst-case latency · `random_device` on some MinGW builds returns a fixed sequence.

---

## 22.5 `<numeric>` algorithms and reductions

| Algorithm | Signature shape | Order | Since |
|---|---|---|---|
| `iota(first, last, value)` | fills `value, ++value, …` | sequential | C++11 |
| `ranges::iota(r, value)` | returns `out_value_result` | sequential | C++23 |
| `accumulate(f, l, init[, op])` | left fold `op(acc, *it)` | **strict left-to-right** | C++11 |
| `reduce(f, l[, init[, op]])` | fold, any grouping | **unspecified** | C++17 |
| `reduce(policy, f, l, …)` | parallel reduce | unspecified | C++17 |
| `inner_product(f1, l1, f2, init[, op1, op2])` | `Σ *a * *b` | strict left | C++11 |
| `transform_reduce(f, l, init, red, tr)` | unary transform then reduce | unspecified | C++17 |
| `transform_reduce(f1, l1, f2, init[, red, tr2])` | binary; parallel `inner_product` | unspecified | C++17 |
| `partial_sum(f, l, out[, op])` | inclusive prefix | strict left | C++11 |
| `inclusive_scan(f, l, out[, op[, init]])` | prefix incl. current | unspecified | C++17 |
| `exclusive_scan(f, l, out, init[, op])` | prefix excl. current | unspecified | C++17 |
| `transform_inclusive_scan(f, l, out, op, tr[, init])` | transform + scan | unspecified | C++17 |
| `transform_exclusive_scan(f, l, out, init, op, tr)` | transform + scan | unspecified | C++17 |
| `adjacent_difference(f, l, out[, op])` | `*f`, then `op(*it, *(it-1))` | strict left | C++11 |
| `gcd(m, n)` | greatest common divisor | — | C++17 |
| `lcm(m, n)` | least common multiple | — | C++17 |
| `midpoint(a, b)` | overflow-free midpoint (int/float/pointer) | — | C++20 |
| `add_sat/sub_sat/mul_sat/div_sat`, `saturate_cast` | saturating integer ops | — | C++26 |

```cpp
#include <numeric>
#include <execution>   // for the policy overloads

std::vector<double> xs{0.5, 1.5, 2.5};
std::vector<int>    ids(5);

std::iota(ids.begin(), ids.end(), 0);                 // 0 1 2 3 4
std::ranges::iota(ids, 100);                          // C++23

double ordered   = std::accumulate(xs.begin(), xs.end(), 0.0);          // strict left fold
double product   = std::accumulate(xs.begin(), xs.end(), 1.0, std::multiplies<>{});
double reducible = std::reduce(xs.begin(), xs.end(), 0.0);              // may regroup
double par       = std::reduce(std::execution::par_unseq, xs.begin(), xs.end(), 0.0);

double dot  = std::inner_product(a.begin(), a.end(), b.begin(), 0.0);
double norm = std::inner_product(a.begin(), a.end(), a.begin(), 0.0);
double mx   = std::inner_product(a.begin(), a.end(), b.begin(), 0.0,
                                 [](double l, double r){ return std::max(l, r); },
                                 [](double l, double r){ return std::abs(l - r); });

double sumsq = std::transform_reduce(xs.begin(), xs.end(), 0.0,
                                     std::plus<>{}, [](double v){ return v * v; });
double pdot  = std::transform_reduce(std::execution::par,
                                     a.begin(), a.end(), b.begin(), 0.0);   // parallel dot

std::vector<double> prefix(xs.size());
std::partial_sum(xs.begin(), xs.end(), prefix.begin());                 // 0.5 2.0 4.5
std::inclusive_scan(xs.begin(), xs.end(), prefix.begin());              // same values
std::exclusive_scan(xs.begin(), xs.end(), prefix.begin(), 0.0);         // 0.0 0.5 2.0
std::transform_inclusive_scan(xs.begin(), xs.end(), prefix.begin(),
                              std::plus<>{}, [](double v){ return v * v; });
std::adjacent_difference(prefix.begin(), prefix.end(), xs.begin());     // inverse of partial_sum

auto g = std::gcd(12, 18);                 // 6   — common_type of |m|,|n|
auto l = std::lcm(4, 6);                   // 12  — UB if not representable
auto mid  = std::midpoint(low, high);      // no (low+high)/2 overflow; rounds toward `low`
auto pmid = std::midpoint(p, p + n);       // pointers into the SAME array only
auto fmid = std::midpoint(1.0e308, 1.0e308);   // no overflow for floating too
```

```cpp
// ---- accumulate vs reduce ------------------------------------------------
// accumulate: acc = op(op(op(init, x0), x1), x2)              deterministic rounding
// reduce:     any binary tree over {init, x0, x1, x2}         op must be
//             associative AND commutative for a well-defined result
// FP addition is neither exactly => results can differ in the last bits.
// reduce may regroup EVEN WITHOUT an execution policy.

// ---- the init-type trap ---------------------------------------------------
std::vector<double> ys{0.5, 1.5};
auto wrong = std::accumulate(ys.begin(), ys.end(), 0);     // int accumulator -> 1 (!!)
auto right = std::accumulate(ys.begin(), ys.end(), 0.0);   // double         -> 2.0
// The accumulator type is decltype(init) — every step converts back through it.
// reduce(f, l) with NO init uses value_type{} — also a trap for mixed types.

// ---- ordered summation when precision matters -----------------------------
double kahan(std::span<double const> v) {          // compensated summation
    double sum = 0.0, c = 0.0;
    for (double x : v) {
        double y = x - c, t = sum + y;
        c = (t - sum) - y;
        sum = t;
    }
    return sum;
}
// or: sort by magnitude, or accumulate in long double / __int128 fixed point.
```

```cpp
// ---- C++23 range folds (<algorithm>, the modern accumulate) ---------------
auto r1 = std::ranges::fold_left(xs, 0.0, std::plus<>{});          // value
auto r2 = std::ranges::fold_left_first(xs, std::plus<>{});         // optional<T>, no init
auto r3 = std::ranges::fold_right(xs, 0.0, std::plus<>{});
auto r4 = std::ranges::fold_left_with_iter(xs, 0.0, std::plus<>{});// {iterator, value}
```

**Traps** — `reduce` expected to bit-match `accumulate` · integer `init` for floating data · scans that alias input and output without honoring the overlap rules (`inclusive_scan` permits in-place, `exclusive_scan`'s `init` shifts the result) · `lcm`/`gcd` with `bool` or non-integer types is ill-formed · `gcd(INT_MIN, x)` violates representability preconditions · execution-policy overloads require `<execution>`, a TBB-style runtime, and callables free of data races and throwing (an escaping exception calls `terminate`).

---

## 22.6 `<cmath>`, classification, error handling, and floating environment

```cpp
#include <cmath>
#include <cfenv>
#include <limits>

// ---- classification --------------------------------------------------------
bool fin = std::isfinite(x);   bool nan = std::isnan(x);   bool inf = std::isinf(x);
bool nrm = std::isnormal(x);   bool neg = std::signbit(x); // distinguishes -0.0
int  cls = std::fpclassify(x); // FP_NAN FP_INFINITE FP_ZERO FP_SUBNORMAL FP_NORMAL
bool gt  = std::isgreater(x, y);       // NaN-quiet comparisons: no FE_INVALID raised
bool ge  = std::isgreaterequal(x, y);  bool lt = std::isless(x, y);
bool le  = std::islessequal(x, y);     bool lg = std::islessgreater(x, y);
bool un  = std::isunordered(x, y);     // true iff either is NaN
// Prefer std::isnan(x) over x != x — intent is explicit and survives -ffinite-math-only reading.
```

```text
NaN == NaN            false        (and !=  is true)
NaN < > <= >= v       false        (all four)
+0.0 == -0.0          true         (but signbit differs, and 1/x gives ±inf)
inf - inf             NaN          0.0/0.0 -> NaN,  1.0/0.0 -> inf (FE_DIVBYZERO)
```

| Group | Functions |
|---|---|
| Basic | `abs` `fabs` `fmod` `remainder` `remquo` `fma` `fmax` `fmin` `fdim` `nan` |
| Exponential | `exp` `exp2` `expm1` `log` `log10` `log2` `log1p` |
| Power | `pow` `sqrt` `cbrt` `hypot` (2- and 3-arg, overflow-safe) |
| Trig / hyperbolic | `sin cos tan asin acos atan atan2` `sinh cosh tanh asinh acosh atanh` |
| Error / gamma | `erf` `erfc` `tgamma` `lgamma` |
| Rounding | `ceil` `floor` `trunc` `round` `lround` `llround` `nearbyint` `rint` `lrint` `llrint` |
| Manipulation | `frexp` `ldexp` `modf` `scalbn` `scalbln` `ilogb` `logb` `nextafter` `nexttoward` `copysign` |
| Special (C++17) | `assoc_laguerre` `beta` `comp_ellint_*` `cyl_bessel_*` `expint` `hermite` `legendre` `riemann_zeta` `sph_*` |
| C++20/23 | `std::lerp` `std::midpoint` (in `<numeric>`) · `std::float16_t` etc. in `<stdfloat>` (C++23) |

```cpp
// ---- the high-value ones ----------------------------------------------------
auto y1 = std::fma(a, b, c);            // a*b+c with ONE rounding (and no intermediate overflow)
auto y2 = std::hypot(dx, dy);           // sqrt(dx*dx+dy*dy) without overflow/underflow
auto y3 = std::nextafter(x, INFINITY);  // adjacent representable value — 1-ULP stepping
auto y4 = std::remainder(x, d);         // IEEE remainder: result in [-d/2, d/2]
auto y5 = std::fmod(x, d);              // C remainder: SIGN OF x, result in (-|d|, |d|)
double whole; auto frac = std::modf(x, &whole);          // split, both keep x's sign
int e2;      auto man   = std::frexp(x, &e2);            // x == man * 2^e2, man in [0.5,1)
auto back    = std::ldexp(man, e2);
auto y6      = std::copysign(1.0, -0.0);                 // -1.0
auto y7      = std::lerp(a, b, t);                       // C++20, monotonic & exact at t==1
auto y8      = std::rint(x);            // uses the CURRENT rounding mode; may raise FE_INEXACT
auto y9      = std::nearbyint(x);       // current mode, never raises FE_INEXACT
auto y10     = std::round(x);           // always half-away-from-zero, ignores mode
// fma vs a*b+c: different results. -ffp-contract=fast lets the compiler introduce fma silently.
```

```cpp
// ---- error reporting: NOT exceptions ----------------------------------------
// math_errhandling & MATH_ERRNO     -> errno set to EDOM / ERANGE
// math_errhandling & MATH_ERREXCEPT -> FE_INVALID / FE_DIVBYZERO / FE_OVERFLOW / ...
errno = 0;
std::feclearexcept(FE_ALL_EXCEPT);
double r = std::sqrt(x);
if (std::fetestexcept(FE_INVALID)) handle_domain_error();      // x < 0
if (errno == EDOM) handle_domain_error();
// Cheaper and usually clearer: validate the input, or classify the result with isnan/isinf.
```

```cpp
// ---- <cfenv>: ambient state, treat as RAII ----------------------------------
#pragma STDC FENV_ACCESS ON        // required for the compiler to respect dynamic env
struct RoundingGuard {
    int saved{std::fegetround()};
    explicit RoundingGuard(int mode) { if (std::fesetround(mode) != 0) throw std::runtime_error{"fesetround"}; }
    ~RoundingGuard() { std::fesetround(saved); }
    RoundingGuard(RoundingGuard const&) = delete;
    RoundingGuard& operator=(RoundingGuard const&) = delete;
};
// Modes: FE_DOWNWARD FE_UPWARD FE_TOWARDZERO FE_TONEAREST (default)
// Flags: FE_DIVBYZERO FE_INEXACT FE_INVALID FE_OVERFLOW FE_UNDERFLOW FE_ALL_EXCEPT
std::fenv_t env; std::fegetenv(&env); std::fesetenv(&env);     // whole-environment save/restore
std::feholdexcept(&env); std::feupdateenv(&env);               // suppress then merge flags
std::fexcept_t f; std::fegetexceptflag(&f, FE_ALL_EXCEPT); std::fesetexceptflag(&f, FE_ALL_EXCEPT);
std::feraiseexcept(FE_INEXACT);
```

```cpp
// ---- numeric_limits facts worth memorizing ----------------------------------
static_assert(std::numeric_limits<double>::is_iec559);        // check before relying on IEEE
constexpr auto eps  = std::numeric_limits<double>::epsilon(); // 2.22e-16 — ULP at 1.0, NOT a tolerance
constexpr auto qnan = std::numeric_limits<double>::quiet_NaN();
constexpr auto inf3 = std::numeric_limits<double>::infinity();
constexpr auto dmin = std::numeric_limits<double>::denorm_min();
constexpr auto d10  = std::numeric_limits<double>::max_digits10;   // 17 — round-trip digits

bool close(double a, double b, double abs_tol, double rel_tol) {
    if (std::isnan(a) || std::isnan(b)) return false;              // policy, not accident
    if (a == b) return true;                                       // handles ±inf and ±0
    double diff = std::abs(a - b);
    return diff <= std::max(abs_tol, rel_tol * std::max(std::abs(a), std::abs(b)));
}
// There is no universal epsilon comparison; the tolerance must model the actual error.
// For money/prices: use scaled integers (ticks), where exact equality IS correct.
```

**Integer arithmetic hazards**

- Signed overflow is UB; unsigned wraps modulo 2^N; division by zero is UB; `INT_MIN / -1` and `INT_MIN % -1` are UB.
- Shift by ≥ width, or by a negative count, is UB; left-shifting a negative value is UB before C++20, well-defined after.
- Mixed signed/unsigned comparison converts the signed operand — use `std::cmp_less`/`cmp_equal`/`cmp_greater_equal` (`<utility>`, C++20).
- Narrowing back into the source type after widening is the only safe overflow check; or use `__builtin_*_overflow` / C++26 saturating ops.

**Traps** — `fmod` vs `remainder` sign rules · `pow(x, 0.5)` is slower and less accurate than `sqrt` · `-ffast-math` implies `-ffinite-math-only` (NaN checks compile away), `-fno-signed-zeros`, and reassociation · `#pragma STDC FENV_ACCESS` is unimplemented on several compilers, so a rounding-mode change may be optimized around · the floating environment is thread-local in practice but its state is invisible ambient configuration.

---

## 22.7 `std::ratio`, compile-time units, and dimensional wrappers

```cpp
#include <ratio>

using Half     = std::ratio<1, 2>;              // auto-reduced: num=1, den=2
using Same     = std::ratio<2, 4>;              // ::num == 1, ::den == 2 as well
static_assert(std::ratio_equal_v<Half, Same>);
static_assert(Half::num == 1 && Half::den == 2);
using TickSize = std::ratio<1, 10'000>;         // 0.0001 price ticks

// SI prefixes (all predefined):
// atto femto pico nano micro milli centi deci deca hecto kilo mega giga tera peta exa
// (yocto/zepto/zetta/yotta only if intmax_t is wide enough)
using P = std::ratio_multiply<std::micro, TickSize>;   // ratio<1, 10'000'000'000>
using Q = std::ratio_divide<std::milli, std::micro>;   // ratio<1000, 1>
using S = std::ratio_add<Half, std::ratio<1, 3>>;      // ratio<5, 6>
using D = std::ratio_subtract<Half, std::ratio<1, 3>>; // ratio<1, 6>
static_assert(std::ratio_less_v<std::micro, std::milli>);
// also: ratio_not_equal_v, ratio_less_equal_v, ratio_greater_v, ratio_greater_equal_v
// Every intermediate must be representable in intmax_t or the program is ill-formed.
```

```cpp
// ---- strong scaled quantity ------------------------------------------------
template<class Rep, class Scale, class Tag>
class Scaled {
public:
    using rep = Rep; using scale = Scale; using tag = Tag;

    Scaled() = default;
    explicit constexpr Scaled(Rep count) noexcept : count_{count} {}
    constexpr Rep count() const noexcept { return count_; }

    // Exact cross-scale conversion only (compile-time check), like chrono's rule.
    template<class S2>
    constexpr explicit Scaled(Scaled<Rep, S2, Tag> other) noexcept
        : count_{other.count() * std::ratio_divide<S2, Scale>::num
                               / std::ratio_divide<S2, Scale>::den} {}

    friend constexpr Scaled operator+(Scaled a, Scaled b) noexcept { return Scaled{a.count_ + b.count_}; }
    friend constexpr Scaled operator-(Scaled a, Scaled b) noexcept { return Scaled{a.count_ - b.count_}; }
    friend constexpr Scaled operator*(Scaled a, Rep k)    noexcept { return Scaled{a.count_ * k}; }
    friend constexpr auto operator<=>(Scaled, Scaled) = default;   // and ==
private:
    Rep count_{};
};

struct PriceTag; struct QtyTag;
using PriceTicks = Scaled<std::int64_t, std::ratio<1, 10'000>, PriceTag>;
using Shares     = Scaled<std::int64_t, std::ratio<1, 1>,      QtyTag>;
// PriceTicks{1} + Shares{1};   // ill-formed — the Tag is what prevents dimension mixing
```

- A `ratio` is a compile-time rational value only; it enforces **no** dimensional analysis on its own.
- A complete unit type must also define: cross-scale conversion rules, result *dimensions* of `*` and `/`, an overflow policy, comparison, hashing, and formatting.
- chrono is the working example of the pattern: `duration<Rep, Period>` = this class with `Period` as the scale and "time" as the implicit tag.
- Prefer scaled integers (price in ticks, quantity in lots) to `double` for money — exact equality then means what it says.
- For real work, `std::chrono` for time and a units library (mp-units) for everything else beat hand-rolled wrappers.

**Traps** — `std::ratio<1, 0>` is ill-formed · intermediate overflow in `ratio_multiply` is a hard error, not a wrap · a typedef alone (`using Price = std::int64_t;`) gives zero type safety · implicit conversion between scales silently truncates unless you gate it like chrono does.

---

## 22.8 Why wall-clock time and pseudo-random engines do not belong in deterministic hot-path logic

```cpp
// ---- untestable, unreplayable core ------------------------------------------
Decision decide(State const& s) {
    auto now = std::chrono::system_clock::now();          // hidden input, can jump
    static std::mt19937 rng{std::random_device{}()};      // hidden mutable state + entropy
    return calculate(s, now, rng());                      // + a static => data race
}
// Same captured inputs, different outputs. No replay, no golden test, no bisect.
```

```cpp
// ---- explicit inputs: the core is a pure function ---------------------------
struct Inputs {
    std::chrono::steady_clock::time_point now;   // typed clock domain
    std::uint64_t random_word;                   // pre-drawn, logged, replayable
};

Decision decide(State const& state, Inputs in) noexcept;   // deterministic, testable

// ---- inject providers at the boundary (compile-time, inlinable) -------------
template<class Clock, std::uniform_random_bit_generator Engine>
class Driver {
public:
    explicit Driver(Engine e) : engine_{std::move(e)} {}
    Decision step(State const& s) { return decide(s, Inputs{Clock::now(), engine_()}); }
private:
    Engine engine_;
};
using Live = Driver<std::chrono::steady_clock, std::mt19937_64>;

// ---- scripted test doubles ---------------------------------------------------
struct ScriptedClock {
    using duration = std::chrono::nanoseconds;
    using rep = duration::rep; using period = duration::period;
    using time_point = std::chrono::time_point<ScriptedClock, duration>;
    static constexpr bool is_steady = true;
    static inline time_point current{};
    static time_point now() noexcept { return current; }
    static void advance(duration d) noexcept { current += d; }
};
struct ScriptedEngine {                                   // models uniform_random_bit_generator
    using result_type = std::uint64_t;
    static constexpr result_type min() { return 0; }
    static constexpr result_type max() { return ~result_type{0}; }
    std::vector<result_type> script; std::size_t i{};
    result_type operator()() { return script[i++ % script.size()]; }
};
using Replay = Driver<ScriptedClock, ScriptedEngine>;
```

- Timestamp at the **edge** (packet receipt), carry it as data, and never re-read the clock inside a state transition.
- Wall-clock time is *metadata on an event*, not control flow: identical inputs must produce identical outputs.
- Runtime polymorphic providers (`IClock*`) are more flexible off-path; template injection inlines but multiplies code size.
- Determinism also requires a fixed sample→stream assignment: if threads pull from a shared engine, scheduling changes results even with a fixed seed.

**Hot-path cost ledger**

| Facility | Hidden / variable cost |
|---|---|
| `clock::now()` | vDSO read or syscall, serializing instruction, counter→ns conversion |
| `zoned_time` / `locate_zone` | tzdb load, global lock, allocation, may throw |
| `std::format("{:%T}")` | string allocation, locale access, tzdb lookup |
| `random_device` | OS entropy call, may block or fail, orders of magnitude slower than an engine |
| `mt19937_64` | 5 KB of state mutated per draw — evicts your working set |
| rejection distributions (`normal`, `poisson`, `gamma`) | unbounded loop count; no worst-case bound |
| `reduce` / parallel numeric | thread pool wakeups, partitioning, non-reproducible FP result |
| `<cmath>` transcendentals | library call, denormal/exceptional-input slow paths, `errno` write |
| `<cfenv>` mode change | pipeline flush, disables vectorization, ambient global state |

- Warmup cannot convert an unbounded rejection loop or an OS entropy call into a hard worst-case bound.
- If a deadline requires bounded work, pick a bounded algorithm (table lookup, precomputed variates, fixed-point) and state the quality tradeoff.

**Interview line** — "Time and randomness are inputs, not ambient services: the deterministic core takes a `time_point` and a `uint64_t`, and the boundary decides where they came from."

**Traps** — a `static` engine inside a function is both a data race and a replay hazard · logging `system_clock::now()` for latency measurement instead of `steady_clock` · formatting timestamps inside the capture loop · seeding from `random_device` without logging the seed · assuming a fixed seed replays when work is distributed across threads.
