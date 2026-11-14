#!/usr/bin/env python3
"""Abraham Tracker Sword - live CPI updater.

Pulls the latest headline / core inflation for USD, EUR, JPY, GBP and AUD
straight from official sources and merges it into data/inflation.json.

Standard library only, so it runs on a bare GitHub Actions runner.
Every source is fail-soft: if one is down or changes format, the last good
figures for that currency are kept and the problem is written to the log.

Sources
  USD  US Bureau of Labor Statistics API      (CPI-U NSA, core ex food & energy)
  EUR  ECB Data Portal, HICP (Eurostat data)  (includes flash estimates)
  GBP  ONS time series D7G7 / DKO8
  AUD  ABS Data API, monthly CPI              (all groups + trimmed mean)
  JPY  OECD Data Explorer, Japan CPI          (headline; also a fallback for all)

Usage
  python scripts/fetch_inflation.py                 # live
  python scripts/fetch_inflation.py --fixtures DIR  # offline test from saved responses
"""
from __future__ import annotations

import argparse
import csv
import email.utils
import html
import re
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "inflation.json")
NEWS_MAX = 60          # headlines kept in data/news.json
NEWS_MAX_AGE_DAYS = 7
UA = "AbrahamTrackerSword/1.0 (CPI tracker; GitHub Actions)"
HISTORY_MONTHS = 13
MONTHS = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}

FIXTURES: str | None = None
DEBUG_CHANGED = False


def save_debug(name: str, text: str) -> None:
    """Keep a small sample of a response that couldn't be parsed, so the parser can be fixed."""
    global DEBUG_CHANGED
    d = os.path.join(ROOT, "data", "_debug")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name)
    old = open(path, encoding="utf-8").read() if os.path.exists(path) else None
    if old != text:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        DEBUG_CHANGED = True


# ----------------------------------------------------------------- helpers
def now_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def today() -> dt.date:
    return dt.datetime.now(dt.timezone.utc).date()


def http(url: str, *, data: bytes | None = None, headers: dict | None = None,
         fixture: str | None = None, tries: int = 3) -> str:
    """GET/POST with retries. In fixture mode, read the named file instead."""
    if FIXTURES is not None:
        path = os.path.join(FIXTURES, fixture or "")
        if not fixture or not os.path.exists(path):
            raise RuntimeError(f"no fixture {fixture}")
        with open(path, encoding="utf-8") as f:
            return f.read()
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(headers or {})
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode("utf-8-sig")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def num(v) -> float | None:
    try:
        f = float(str(v).strip())
        return f
    except (TypeError, ValueError):
        return None


def r1(v: float) -> float:
    return round(v + 0.0, 1)


def ym(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}"


def add_month(p: str, n: int) -> str:
    y, m = map(int, p.split("-"))
    m += n
    y += (m - 1) // 12
    m = (m - 1) % 12 + 1
    return ym(y, m)


def yoy_from_index(levels: dict[str, float]) -> dict[str, float]:
    out = {}
    for p, v in levels.items():
        prev = levels.get(add_month(p, -12))
        if prev:
            out[p] = r1((v / prev - 1) * 100)
    return out


def result(series: dict[str, float], core: dict[str, float] | None = None, **extra) -> dict:
    """Package a month->yoy series into the fields the app reads."""
    if not series:
        raise RuntimeError("no observations")
    months = sorted(series)
    last = months[-1]
    prev = series.get(add_month(last, -1))
    first = add_month(last, -(HISTORY_MONTHS - 1))
    out = {"period": last, "headline": series[last], "history": {m: series[m] for m in months if m >= first}}
    if prev is not None:
        out["previous"] = prev
    if core and core.get(last) is not None:
        out["core"] = core[last]
    out.update(extra)
    return out


# ----------------------------------------------------------------- sources
def fetch_usd() -> dict:
    """BLS: CUUR0000SA0 (all items) and CUUR0000SA0L1E (ex food & energy), NSA index levels."""
    y = today().year
    body = {"seriesid": ["CUUR0000SA0", "CUUR0000SA0L1E"], "startyear": str(y - 2), "endyear": str(y)}
    key = os.environ.get("BLS_API_KEY")
    if key:
        body.update(registrationkey=key, calculations=True)
        url = "https://api.bls.gov/publicAPI/v2/timeseries/data/"
    else:
        url = "https://api.bls.gov/publicAPI/v1/timeseries/data/"
    txt = http(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, fixture="bls.json")
    j = json.loads(txt)
    if j.get("status") != "REQUEST_SUCCEEDED":
        raise RuntimeError(f"BLS status {j.get('status')}: {j.get('message')}")
    yoy = {}
    for s in j["Results"]["series"]:
        lv, published = {}, {}
        for d in s["data"]:
            if not d["period"].startswith("M") or d["period"] == "M13":
                continue
            p = ym(int(d["year"]), int(d["period"][1:]))
            v = num(d["value"])
            if v is not None:
                lv[p] = v
            pc = num(((d.get("calculations") or {}).get("pct_changes") or {}).get("12"))
            if pc is not None:
                published[p] = r1(pc)  # BLS's own 12-month change (needs API key)
        # Fill single-month gaps (e.g. Oct 2025, never published) by geometric interpolation
        # so the year-on-year change a year later can still be worked out.
        filled = []
        for p in sorted(lv):
            gap, nxt = add_month(p, 1), add_month(p, 2)
            if gap not in lv and nxt in lv:
                lv[gap] = (lv[p] * lv[nxt]) ** 0.5
                filled.append(gap)
        calc = yoy_from_index(lv)
        for p in filled:
            calc.pop(p, None)  # never show a month that wasn't published
        calc.update(published)
        yoy[s["seriesID"]] = calc
    return result(yoy.get("CUUR0000SA0", {}), yoy.get("CUUR0000SA0L1E"), status="Final")


def _ecb(key: str, fixture: str) -> list[dict]:
    url = f"https://data-api.ecb.europa.eu/service/data/ICP/{key}?format=csvdata&lastNObservations={HISTORY_MONTHS + 1}"
    rows = list(csv.DictReader(io.StringIO(http(url, headers={"Accept": "text/csv"}, fixture=fixture))))
    if not rows or "OBS_VALUE" not in rows[0]:
        raise RuntimeError("ECB: unexpected format")
    return rows


def fetch_eur() -> dict:
    """ECB Data Portal: euro area HICP annual rate, all items and ex energy/food/alc/tobacco."""
    head_rows = _ecb("M.U2.N.000000.4.ANR", "ecb_head.csv")
    core_rows = _ecb("M.U2.N.XEF000.4.ANR", "ecb_core.csv")
    pick = lambda rows: {r["TIME_PERIOD"]: r1(num(r["OBS_VALUE"])) for r in rows if num(r["OBS_VALUE"]) is not None}
    head, core = pick(head_rows), pick(core_rows)
    last = max(head)
    status_code = next((r.get("OBS_STATUS", "") for r in head_rows if r["TIME_PERIOD"] == last), "")
    # The ECB marks flash/provisional observations with a non-"A" status (E = estimated, P = provisional).
    status = "Flash estimate" if status_code and status_code != "A" else "Final"
    return result(head, core, status=status)


def _ons(series: str, fixture: str) -> tuple[dict[str, float], dict]:
    url = f"https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/{series}/mm23/data"
    j = json.loads(http(url, headers={"Accept": "application/json"}, fixture=fixture))
    out = {}
    for m in j.get("months", []):
        parts = str(m.get("date", "")).split()
        v = num(m.get("value"))
        if len(parts) == 2 and parts[1][:3].upper() in MONTHS and v is not None:
            out[ym(int(parts[0]), MONTHS[parts[1][:3].upper()])] = r1(v)
    if not out:
        raise RuntimeError(f"ONS {series}: no monthly data")
    return out, j.get("description", {})


def fetch_gbp() -> dict:
    """ONS: D7G7 = CPI annual rate, DKO8 = CPI ex energy, food, alcohol & tobacco annual rate."""
    head, desc = _ons("d7g7", "ons_d7g7.json")
    try:
        core, _ = _ons("dko8", "ons_dko8.json")
    except Exception:
        core = None
    extra = {"status": "Final"}
    nxt = parse_any_date(desc.get("nextRelease", ""))
    if nxt:
        extra["next_release"] = nxt
    return result(head, core, **extra)


def fetch_aud() -> dict:
    """ABS Data API, monthly CPI with labels; picks the 'corresponding month of previous year' rows."""
    flow = os.environ.get("ABS_DATAFLOW", "ABS,CPI_M")
    start = add_month(ym(today().year, today().month), -(HISTORY_MONTHS + 2))
    url = f"https://data.api.abs.gov.au/rest/data/{flow}/all?startPeriod={start}&format=csvfilewithlabels"
    raw = http(url, headers={"Accept": "text/csv"}, fixture="abs.csv")
    rows = list(csv.DictReader(io.StringIO(raw)))
    if not rows:
        save_debug("abs.txt", f"URL: {url}\n\n" + raw[:4000])
        raise RuntimeError("ABS: empty")
    tcol = next(c for c in rows[0] if c.split(":")[0].strip().upper() == "TIME_PERIOD")
    vcol = next(c for c in rows[0] if c.split(":")[0].strip().upper() == "OBS_VALUE")
    head, core = {}, {}
    for r in rows:
        text = " | ".join(str(v) for k, v in r.items() if k not in (tcol, vcol)).lower()
        if not re.search(r"corresponding month of (the )?previous year", text):
            continue
        if "seasonally adjusted" in text and "trimmed" not in text:
            continue  # headline uses original series
        if "weighted average of eight capital cities" not in text and "australia" not in text:
            continue
        v = num(r[vcol])
        p = str(r[tcol])[:7]
        if v is None or len(p) != 7:
            continue
        if "trimmed mean" in text:
            core[p] = r1(v)
        elif "all groups cpi" in text and "excluding" not in text and "original" in text:
            head[p] = r1(v)
    if not head:
        cols = {c: sorted({str(r[c]) for r in rows})[:25] for c in rows[0] if c not in (tcol, vcol)}
        save_debug("abs.txt", f"URL: {url}\nrows: {len(rows)}\n\n" + json.dumps(cols, indent=1, ensure_ascii=False)[:12000])
    return result(head, core, status="Final")


OECD_AREAS = {"USD": "USA", "EUR": "EA20", "JPY": "JPN", "GBP": "GBR", "AUD": "AUS"}
_oecd_cache: dict | None = None


def oecd_all() -> dict[str, dict[str, float]]:
    """OECD Data Explorer: CPI, all items, growth over same period previous year, monthly."""
    global _oecd_cache
    if _oecd_cache is None:
        areas = "+".join(OECD_AREAS.values())
        url = ("https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0/"
               f"{areas}.M.N.CPI.PA._T.N.GY?lastNObservations={HISTORY_MONTHS + 1}&format=csvfile")
        rows = list(csv.DictReader(io.StringIO(http(url, headers={"Accept": "text/csv"}, fixture="oecd.csv"))))
        out: dict[str, dict[str, float]] = {}
        for r in rows:
            v = num(r.get("OBS_VALUE"))
            if v is not None:
                out.setdefault(r["REF_AREA"], {})[r["TIME_PERIOD"][:7]] = r1(v)
        _oecd_cache = out
    return _oecd_cache


def fetch_oecd(code: str) -> dict:
    series = oecd_all().get(OECD_AREAS[code], {})
    return result(series, status="Final", via_oecd=True)


PRIMARY = {"USD": fetch_usd, "EUR": fetch_eur, "GBP": fetch_gbp, "AUD": fetch_aud,
           "JPY": lambda: fetch_oecd("JPY")}


# ----------------------------------------------------------------- release dates
def parse_any_date(s: str) -> str | None:
    s = (s or "").strip()
    for fmt in ("%d %B %Y", "%Y-%m-%d", "%d %b %Y", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return dt.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def next_release_after(row: dict, calendar: dict) -> tuple[str, bool]:
    """Earliest known future date for this currency, else an estimate one month on."""
    t = today().isoformat()
    known = sorted(d for d in calendar.get(row["code"], []) if d > t)
    if known:
        return known[0], False
    try:
        last = dt.date.fromisoformat(row.get("next_release") or row.get("released"))
    except (TypeError, ValueError):
        last = today()
    est = last
    while est.isoformat() <= t:
        y, m = est.year + (est.month // 12), est.month % 12 + 1
        est = dt.date(y, m, min(est.day, 28))
    return est.isoformat(), True


# ----------------------------------------------------------------- news
# Headlines only (title, link, outlet, time, a short teaser), always linking to the full story.
FEEDS = [
    ("BBC News", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ("CNBC", "https://www.cnbc.com/id/20910258/device/rss/rss.html"),
    ("CNBC", "https://www.cnbc.com/id/10000664/device/rss/rss.html"),
    ("MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
    ("The Guardian", "https://www.theguardian.com/business/economics/rss"),
    ("Financial Times", "https://www.ft.com/global-economy?format=rss"),
    ("FXStreet", "https://www.fxstreet.com/rss/news"),
    ("Yahoo Finance", "https://finance.yahoo.com/news/rssindex"),
    ("Nikkei Asia", "https://asia.nikkei.com/rss/feed/nar"),
    ("ABC News (AU)", "https://www.abc.net.au/news/feed/51892/rss.xml"),
]
# Strong words tag a story on their own; weak ones need an economics word too.
STRONG = {
    "USD": [r"federal reserve", r"\bfed\b", r"\bfomc\b", r"\bwarsh\b", r"\bu\.?s\.? (cpi|inflation|consumer prices)", r"\bbls\b", r"\bdollar index\b", r"\bdxy\b", r"\btreasury yields?\b"],
    "EUR": [r"\becb\b", r"european central bank", r"\blagarde\b", r"\beuro ?zone\b", r"\beuro area\b", r"\beurostat\b", r"\bhicp\b", r"\beur/?usd\b"],
    "JPY": [r"bank of japan", r"\bboj\b", r"\bueda\b", r"\byen\b", r"\busd/?jpy\b", r"\bjgbs?\b"],
    "GBP": [r"bank of england", r"\bboe\b", r"\bbailey\b", r"\bsterling\b", r"\bgbp/?usd\b", r"\bgilts?\b", r"\buk (cpi|inflation)\b", r"\bons\b"],
    "AUD": [r"reserve bank of australia", r"\brba\b", r"\bbullock\b", r"\baussie\b", r"australian dollar", r"\baud/?usd\b"],
}
WEAK = {
    "USD": [r"\bdollar\b", r"\bu\.?s\.? economy\b", r"\bwall street\b"],
    "EUR": [r"\beuro\b", r"\bgermany\b", r"\bfrance\b"],
    "JPY": [r"\bjapan(ese)?\b", r"\btokyo\b"],
    "GBP": [r"\bbritain\b", r"\bbritish\b", r"\bu\.?k\.?\b", r"\bpound\b"],
    "AUD": [r"\baustralia(n)?\b"],
}
ECON = r"inflation|\bcpi\b|prices|interest rate|\brates?\b|central bank|hike|\bcut\b|yields?|economy|currency|forex|\bfx\b|bond|wage|jobs|gdp|recession|tariff"


def _strip(t: str) -> str:
    t = re.sub(r"<[^>]+>", " ", html.unescape(t or ""))
    return re.sub(r"\s+", " ", t).strip()


def _when(s: str) -> str | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        d = email.utils.parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_feed(xml: str) -> list[dict]:
    """RSS 2.0 or Atom -> [{title, link, published, summary}]."""
    root = ET.fromstring(xml.encode("utf-8"))
    local = lambda tag: tag.rsplit("}", 1)[-1]
    out = []
    for item in root.iter():
        if local(item.tag) not in ("item", "entry"):
            continue
        f = {}
        for ch in item:
            k = local(ch.tag)
            if k == "link":
                f.setdefault("link", (ch.text or "").strip() or ch.attrib.get("href", ""))
            elif k in ("title", "pubDate", "published", "updated", "date", "description", "summary"):
                f.setdefault(k, ch.text or "")
        title = _strip(f.get("title"))
        link = (f.get("link") or "").strip()
        if not title or not link.startswith("http"):
            continue
        out.append({"title": title, "link": link,
                    "published": _when(f.get("pubDate") or f.get("published") or f.get("updated") or f.get("date")),
                    "summary": _strip(f.get("description") or f.get("summary"))})
    return out


def tag_codes(text: str) -> list[str]:
    t = text.lower()
    econ = re.search(ECON, t) is not None
    codes = []
    for m in re.finditer(r"\b(usd|eur|jpy|gbp|aud)/?(usd|eur|jpy|gbp|aud)\b", t):  # e.g. EUR/USD, gbpjpy
        codes += [m.group(1).upper(), m.group(2).upper()]
    for c in ("USD", "EUR", "JPY", "GBP", "AUD"):
        if any(re.search(p, t) for p in STRONG[c]) or (econ and any(re.search(p, t) for p in WEAK[c])):
            codes.append(c)
    return [c for c in ("USD", "EUR", "JPY", "GBP", "AUD") if c in codes]


def update_news(path: str) -> bool:
    old = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {"items": []}
    items = {it["link"]: it for it in old.get("items", [])}
    problems, ok = [], 0
    for i, (outlet, url) in enumerate(FEEDS):
        try:
            entries = parse_feed(http(url, headers={"Accept": "application/rss+xml, application/xml, text/xml"},
                                      fixture=f"feed{i}.xml", tries=2))
            ok += 1
        except Exception as e:  # fail-soft per outlet
            problems.append(f"{outlet}: {str(e)[:160]}")
            continue
        for e in entries:
            codes = tag_codes(e["title"] + " " + e["summary"])
            if not codes or e["link"] in items:
                continue
            summary = e["summary"]
            if len(summary) > 220:
                summary = summary[:217].rsplit(" ", 1)[0] + "…"
            items[e["link"]] = {"title": e["title"], "link": e["link"], "source": outlet,
                                "published": e["published"] or now_utc(), "codes": codes, "summary": summary}
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=NEWS_MAX_AGE_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    seen_titles, keep = set(), []
    for it in sorted(items.values(), key=lambda x: x["published"], reverse=True):
        key = re.sub(r"\W+", "", it["title"].lower())
        if it["published"] < cutoff or key in seen_titles:
            continue
        seen_titles.add(key)
        keep.append(it)
    keep = keep[:NEWS_MAX]
    changed = [x["link"] for x in keep] != [x["link"] for x in old.get("items", [])]
    doc = {"updated_at": now_utc() if changed else old.get("updated_at", now_utc()),
           "checked_at": now_utc(), "feeds_ok": ok, "feeds_total": len(FEEDS), "problems": problems, "items": keep}
    if changed or problems != old.get("problems") or ok != old.get("feeds_ok"):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=1, ensure_ascii=False)
            f.write("\n")
    for p in problems:
        print("WARN news", p, file=sys.stderr)
    return changed or problems != old.get("problems")


# ----------------------------------------------------------------- merge
def merge(doc: dict, code: str, got: dict, log: list) -> bool:
    row = next(r for r in doc["latest"] if r["code"] == code)
    hist = doc["history"].setdefault(code, {})
    changed = False
    for m, v in got.get("history", {}).items():
        if hist.get(m) != v:
            hist[m] = v
            changed = True
    if got["period"] < row["period"]:
        return changed  # source is behind what we already have (e.g. OECD lag)
    new_period = got["period"] > row["period"]
    for k in ("headline", "previous", "core", "status"):
        if k in got and row.get(k) != got[k]:
            if not new_period and k != "status" and row.get("source_of_update") == "seed" and got.get("via_oecd"):
                continue
            row[k] = got[k]
            changed = True
    if new_period:
        row["period"] = got["period"]
        row["released"] = today().isoformat()
        row["next_period"] = add_month(got["period"], 1)
        if "core" not in got:
            row["core"] = None
        row["note"] = ""
        row["next_release"] = None  # recomputed below from calendar.json or estimated
        log.append({"at": now_utc(), "code": code, "period": got["period"], "headline": got["headline"],
                    "msg": f"{code} {got['period']}: {got['headline']}%"})
        changed = True
    if got.get("next_release") and got["next_release"] > today().isoformat() and got["next_release"] != row.get("next_release"):
        row["next_release"] = got["next_release"]
        row["next_release_estimated"] = False
        changed = True
    row["source_of_update"] = "oecd" if got.get("via_oecd") else "official"
    return changed


def main() -> int:
    global FIXTURES
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures")
    ap.add_argument("--data", default=DATA)
    a = ap.parse_args()
    FIXTURES = a.fixtures

    with open(a.data, encoding="utf-8") as f:
        doc = json.load(f)
    cal_path = os.path.join(os.path.dirname(a.data), "calendar.json")
    calendar = json.load(open(cal_path, encoding="utf-8")) if os.path.exists(cal_path) else {}

    log = doc.setdefault("log", [])
    problems, changed = [], False
    for code, fn in PRIMARY.items():
        got = None
        try:
            got = fn()
        except Exception as e:  # fail-soft
            problems.append(f"{code} primary: {e}")
            if code != "JPY":
                try:
                    got = fetch_oecd(code)
                except Exception as e2:
                    problems.append(f"{code} OECD fallback: {e2}")
        if got:
            changed |= merge(doc, code, got, log)

    # Keep the release calendar moving forward.
    for row in doc["latest"]:
        if not row.get("next_release") or row["next_release"] < today().isoformat():
            d, est = next_release_after(row, calendar)
            row["next_release"], row["next_release_estimated"] = d, est
            changed = True
        elif row.get("next_release_estimated"):
            d, est = next_release_after(row, calendar)
            if not est:
                row["next_release"], row["next_release_estimated"] = d, False
                changed = True

    # Trim history to the 13 months ending at each currency's latest figure
    # (this also drops stray old months a source sometimes returns, e.g. OECD Japan 2021).
    for code, h in doc["history"].items():
        row = next((r for r in doc["latest"] if r["code"] == code), None)
        end = row["period"] if row else max(h)
        first = add_month(end, -(HISTORY_MONTHS - 1))
        for m in list(h):
            if m < first or m > end:
                del h[m]
                changed = True

    # Central bank policy rates (hand-maintained in data/policy_rates.json).
    pol_path = os.path.join(os.path.dirname(a.data), "policy_rates.json")
    if os.path.exists(pol_path):
        pol = json.load(open(pol_path, encoding="utf-8"))
        pol = {k: v for k, v in pol.items() if not k.startswith("_")}
        if doc.get("policy") != pol:
            doc["policy"] = pol
            changed = True

    doc["log"] = log[-30:]
    doc["checked_at"] = now_utc()
    doc["problems"] = problems
    if changed:
        doc["updated_at"] = doc["checked_at"]
    changed = changed or DEBUG_CHANGED
    with open(a.data, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
        f.write("\n")

    news_changed = update_news(os.path.join(os.path.dirname(a.data), "news.json"))
    changed = changed or news_changed

    print("changed" if changed else "no change")
    for p in problems:
        print("WARN", p, file=sys.stderr)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
