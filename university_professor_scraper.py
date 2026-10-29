#!/usr/bin/env python3
"""
Generic University Professor Scraper
====================================

End-to-end scraper that accepts any university website URL, discovers department
pages, discovers people/faculty pages under each department, extracts professor
records, and exports JSON + CSV.

Design goals:
- Modular architecture (fetching separated from parsing/orchestration)
- Robust error handling (continue on failures)
- Politeness delay between requests
- Works across multiple university site structures with heuristics
- Supports browser-based fetching (Playwright) and automatic requests->browser fallback

Usage examples:
    python university_professor_scraper.py --university-url https://www.polito.it
    python university_professor_scraper.py --university-url https://www.example.edu --output-dir data
    python university_professor_scraper.py --university-url https://www.university.edu --min-delay 2 --max-delay 4
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import random
import re
import time
from dataclasses import asdict, dataclass
from typing import Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup, Tag

try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    from playwright.sync_api import sync_playwright
except Exception:  # Playwright is optional at runtime.
    sync_playwright = None

    class PlaywrightTimeoutError(Exception):
        pass

# --------------------------- Data model ---------------------------


@dataclass
class ProfessorRecord:
    university: str
    department: str
    full_name: str
    role_title: str
    profile_url: str
    source_url: str


# --------------------------- Fetching layer ---------------------------


class BaseFetcher:
    """Abstract fetcher interface to keep architecture swappable."""

    def get_text(self, url: str) -> Optional[str]:
        raise NotImplementedError


class RequestsFetcher(BaseFetcher):
    """requests-based fetcher; swap this class if you move to Playwright/Selenium."""

    def __init__(self, timeout: int = 20) -> None:
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": (
                    "UniversityProfessorScraper/1.0 "
                    "(academic data project; contact: replace-with-your-email@example.com)"
                ),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en;q=0.9,it;q=0.8",
                "Connection": "keep-alive",
            }
        )

    def get_text(self, url: str) -> Optional[str]:
        try:
            response = self.session.get(url, timeout=self.timeout)
            response.raise_for_status()
            if "text/html" not in response.headers.get("Content-Type", ""):
                # Ignore non-HTML responses for crawl robustness.
                return None
            return response.text
        except requests.RequestException as exc:
            logging.error("HTTP error for %s: %s", url, exc)
            return None


class PlaywrightFetcher(BaseFetcher):
    """Browser fetcher for JS-heavy pages that do not render with plain HTTP requests."""

    def __init__(self, timeout_ms: int = 30000, headless: bool = True) -> None:
        if sync_playwright is None:
            raise RuntimeError(
                "Playwright is not installed. Install with: pip install playwright "
                "and run: playwright install"
            )
        self.timeout_ms = timeout_ms
        self.headless = headless

    def get_text(self, url: str) -> Optional[str]:
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=self.headless)
                page = browser.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=self.timeout_ms)
                content = page.content()
                browser.close()
                return content
        except PlaywrightTimeoutError:
            logging.error("Playwright timeout for %s", url)
            return None
        except Exception as exc:
            logging.error("Playwright error for %s: %s", url, exc)
            return None


class AutoFallbackFetcher(BaseFetcher):
    """
    Hybrid mode:
    1) Try fast requests fetch first
    2) If it fails or returns non-HTML/empty, retry with Playwright
    """

    def __init__(self, requests_timeout: int = 20, browser_timeout_ms: int = 30000):
        self.requests_fetcher = RequestsFetcher(timeout=requests_timeout)
        self.browser_fetcher: Optional[PlaywrightFetcher] = None
        self.browser_timeout_ms = browser_timeout_ms

    def _get_browser(self) -> Optional[PlaywrightFetcher]:
        if self.browser_fetcher is not None:
            return self.browser_fetcher
        try:
            self.browser_fetcher = PlaywrightFetcher(timeout_ms=self.browser_timeout_ms)
            return self.browser_fetcher
        except Exception as exc:
            logging.warning(
                "Browser fallback unavailable (continuing with requests only): %s", exc
            )
            return None

    def get_text(self, url: str) -> Optional[str]:
        html = self.requests_fetcher.get_text(url)
        if html:
            return html

        browser = self._get_browser()
        if browser is None:
            return None

        logging.info("Retrying with browser fallback: %s", url)
        return browser.get_text(url)


# --------------------------- Scraper ---------------------------


class UniversityProfessorScraper:
    """
    Generic scraper that:
      1) Discovers department pages from university root
      2) Discovers people/faculty pages for each department
      3) Extracts professor data from pages
      4) Aggregates + deduplicates
      5) Exports CSV/JSON
    """

    DEPARTMENT_KEYWORDS = {
        "department",
        "departments",
        "school",
        "schools",
        "faculty",
        "faculties",
        "institute",
        "institutes",
        "college",
        "colleges",
        "academics",
        "units",
        "dipartimento",
        "dipartimenti",
        "dip.",
        "scuola",
        "scuole",
        "facolta",
        "facoltà",
        "strutture",
        "aree",
        "departamento",
        "departamentos",
        "facultad",
    }

    PEOPLE_KEYWORDS = {
        "people",
        "staff",
        "faculty",
        "professor",
        "professors",
        "personnel",
        "directory",
        "team",
        "members",
        "academic staff",
        "teaching staff",
        "research staff",
        "personale",
        "docenti",
        "elenco",
        "rubrica",
        "anagrafica",
        "persone",
        "equipo",
        "profesores",
        "personal",
    }

    ROLE_KEYWORDS = {
        "professor",
        "associate professor",
        "assistant professor",
        "full professor",
        "lecturer",
        "researcher",
        "senior lecturer",
        "adjunct",
        "emeritus",
        "professore",
        "professore ordinario",
        "professore associato",
        "ricercatore",
        "docente",
        "teaching assistant",
        "postdoc",
    }

    DISCOVERY_PATH_HINTS = [
        "/",
        "/departments",
        "/department",
        "/academics",
        "/faculties",
        "/schools",
        "/people",
        "/staff",
        "/faculty",
        "/organization",
        "/about",
        "/structure",
        "/dipartimenti",
        "/dipartimento",
        "/strutture",
        "/personale",
        "/docenti",
    ]

    def __init__(
        self,
        fetcher: Optional[BaseFetcher] = None,
        delay_range: Tuple[float, float] = (2.0, 4.0),
        max_discovery_pages: int = 100,
    ) -> None:
        self.fetcher = fetcher or RequestsFetcher()
        self.delay_range = delay_range
        self.max_discovery_pages = max_discovery_pages
        self.records: List[ProfessorRecord] = []

    # --------------------------- Utilities ---------------------------

    @staticmethod
    def _clean_text(value: str) -> str:
        return re.sub(r"\s+", " ", (value or "").strip())

    @staticmethod
    def _normalize_url(url: str) -> str:
        raw = (url or "").strip()
        if not raw:
            raise ValueError("Empty URL provided.")
        if not raw.startswith(("http://", "https://")):
            raw = "https://" + raw
        parsed = urlparse(raw)
        path = parsed.path or "/"
        path = re.sub(r"/{2,}", "/", path)
        if path != "/" and path.endswith("/"):
            path = path[:-1]
        return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))

    @staticmethod
    def _same_host(url_a: str, url_b: str) -> bool:
        return urlparse(url_a).netloc.lower() == urlparse(url_b).netloc.lower()

    @staticmethod
    def _base_site(url: str) -> str:
        p = urlparse(url)
        return f"{p.scheme}://{p.netloc}"

    @staticmethod
    def _link_score(text: str, href: str, keywords: Set[str]) -> int:
        t = f"{text} {href}".lower()
        return sum(1 for kw in keywords if kw in t)

    def _sleep(self) -> None:
        low, high = self.delay_range
        if high <= 0:
            return
        wait = random.uniform(max(0.0, low), max(low, high))
        time.sleep(wait)

    @staticmethod
    def _is_likely_person_name(text: str) -> bool:
        """
        Heuristic:
        - 2 to 5 words
        - mostly alphabetic words
        - first letters uppercase in at least half words
        """
        t = re.sub(r"\s+", " ", text.strip())
        if not t or any(ch.isdigit() for ch in t):
            return False

        words = [w for w in re.split(r"[ \-']", t) if w]
        if not (2 <= len(words) <= 5):
            return False

        alpha_words = [w for w in words if re.search(r"[A-Za-zÀ-ÖØ-öø-ÿ]", w)]
        if len(alpha_words) < 2:
            return False

        upper_initial_count = sum(1 for w in alpha_words if w[0].isupper())
        if upper_initial_count < max(2, len(alpha_words) // 2):
            return False

        # Reject obvious nav labels.
        bad = {"home", "about", "contact", "privacy", "login", "read", "more", "news"}
        if t.lower() in bad:
            return False
        return True

    def _extract_role_from_text(self, text: str) -> str:
        clean = self._clean_text(text)
        lower = clean.lower()
        for role in sorted(self.ROLE_KEYWORDS, key=len, reverse=True):
            if role in lower:
                return role.title()
        return ""

    # --------------------------- Discovery ---------------------------

    def discover_department_pages(self, university_url: str) -> Dict[str, str]:
        """
        Crawl limited pages from the university host and find likely department pages.
        Returns {department_name: department_url}
        """
        root = self._normalize_url(university_url)
        base = self._base_site(root)

        queue: List[str] = []
        seen: Set[str] = set()
        scored_candidates: Dict[str, int] = {}

        for hint in self.DISCOVERY_PATH_HINTS:
            queue.append(self._normalize_url(urljoin(base, hint)))

        pages_visited = 0

        while queue and pages_visited < self.max_discovery_pages:
            current = queue.pop(0)
            if current in seen:
                continue
            seen.add(current)

            if not self._same_host(current, base):
                continue

            html = self.fetcher.get_text(current)
            pages_visited += 1
            if html is None:
                continue

            soup = BeautifulSoup(html, "html.parser")
            anchors = soup.find_all("a", href=True)

            for a in anchors:
                if not isinstance(a, Tag):
                    continue
                href = a.get("href", "")
                text = self._clean_text(a.get_text(" ", strip=True))
                if not href:
                    continue

                full = self._normalize_url(urljoin(current, href))

                # Keep only same host and likely navigable pages.
                if not self._same_host(full, base):
                    continue
                if any(
                    full.lower().endswith(ext)
                    for ext in (".pdf", ".jpg", ".png", ".zip", ".doc", ".docx")
                ):
                    continue

                score = self._link_score(text, full, self.DEPARTMENT_KEYWORDS)
                if score > 0:
                    scored_candidates[full] = max(scored_candidates.get(full, 0), score)

                # Keep crawling only links that may lead to structural pages.
                discovery_signal = self._link_score(
                    text, full, self.DEPARTMENT_KEYWORDS | self.PEOPLE_KEYWORDS
                )
                if discovery_signal > 0 and full not in seen and full not in queue:
                    queue.append(full)

            self._sleep()

        # Keep strongest candidates.
        ordered = sorted(scored_candidates.items(), key=lambda x: x[1], reverse=True)
        top_candidates = ordered[:250]  # safety cap

        departments: Dict[str, str] = {}
        for url, _ in top_candidates:
            dept_name = self._derive_department_name(url)
            unique_name = dept_name
            i = 2
            while unique_name in departments and departments[unique_name] != url:
                unique_name = f"{dept_name} ({i})"
                i += 1
            departments[unique_name] = url

        # If discovery fails, fallback to root as one department.
        if not departments:
            departments["GENERAL"] = root

        return departments

    @staticmethod
    def _derive_department_name(url: str) -> str:
        path_parts = [p for p in urlparse(url).path.split("/") if p]
        if path_parts:
            tail = path_parts[-1]
            tail = tail.replace("-", " ").replace("_", " ")
            tail = re.sub(
                r"\b(department|departments|dipartimento|dipartimenti|faculty|school|college)\b",
                "",
                tail,
                flags=re.I,
            )
            tail = re.sub(r"\s+", " ", tail).strip()
            if tail:
                return tail.title()

        host_parts = urlparse(url).netloc.split(".")
        if len(host_parts) >= 3 and host_parts[0].lower() not in {"www"}:
            return host_parts[0].upper()

        return "Unknown Department"

    def discover_people_pages(self, department_url: str) -> List[str]:
        """
        Find likely people/faculty directory pages for one department URL.
        """
        html = self.fetcher.get_text(department_url)
        if html is None:
            return [department_url]

        soup = BeautifulSoup(html, "html.parser")
        candidates: Dict[str, int] = {}
        anchors = soup.find_all("a", href=True)

        for a in anchors:
            if not isinstance(a, Tag):
                continue
            href = a.get("href", "")
            text = self._clean_text(a.get_text(" ", strip=True))
            if not href:
                continue

            full = self._normalize_url(urljoin(department_url, href))
            score = self._link_score(text, full, self.PEOPLE_KEYWORDS)
            if score > 0:
                candidates[full] = max(candidates.get(full, 0), score)

        ordered = [
            u for u, _ in sorted(candidates.items(), key=lambda x: x[1], reverse=True)
        ]

        # Include department page itself as fallback; first 8 people pages are enough in most structures.
        result = [department_url] + [u for u in ordered if u != department_url][:8]
        return result

    # --------------------------- Parsing ---------------------------

    def _extract_from_tables(
        self, soup: BeautifulSoup, source_url: str, department: str, university: str
    ) -> List[ProfessorRecord]:
        records: List[ProfessorRecord] = []

        for table in soup.find_all("table"):
            rows = table.find_all("tr")
            if not rows:
                continue

            for row in rows:
                cells = row.find_all(["td", "th"])
                if not cells:
                    continue

                # Pick first likely name anchor/text.
                name = ""
                profile_url = ""
                anchor = row.find("a", href=True)
                if anchor:
                    candidate = self._clean_text(anchor.get_text(" ", strip=True))
                    if self._is_likely_person_name(candidate):
                        name = candidate
                        profile_url = self._normalize_url(
                            urljoin(source_url, anchor["href"])
                        )
                if not name:
                    for c in cells:
                        txt = self._clean_text(c.get_text(" ", strip=True))
                        if self._is_likely_person_name(txt):
                            name = txt
                            break

                if not name:
                    continue

                role = ""
                if len(cells) >= 2:
                    role = self._extract_role_from_text(
                        cells[1].get_text(" ", strip=True)
                    )
                if not role:
                    role = self._extract_role_from_text(row.get_text(" ", strip=True))

                records.append(
                    ProfessorRecord(
                        university=university,
                        department=department,
                        full_name=name,
                        role_title=role,
                        profile_url=profile_url,
                        source_url=source_url,
                    )
                )

        return records

    def _extract_from_cards_and_lists(
        self, soup: BeautifulSoup, source_url: str, department: str, university: str
    ) -> List[ProfessorRecord]:
        records: List[ProfessorRecord] = []
        seen_local: Set[str] = set()

        # Prefer content-ish nodes.
        containers = soup.select("main, article, section, div, ul, ol")
        if not containers:
            containers = [soup]

        for node in containers:
            anchors = node.find_all("a", href=True)
            for a in anchors:
                text = self._clean_text(a.get_text(" ", strip=True))
                if not self._is_likely_person_name(text):
                    continue

                profile_url = self._normalize_url(urljoin(source_url, a["href"]))
                key = f"{text.lower()}|{profile_url.lower()}|{department.lower()}"
                if key in seen_local:
                    continue
                seen_local.add(key)

                # Try role from parent/sibling text.
                role = ""
                parent_text = (
                    self._clean_text(a.parent.get_text(" ", strip=True))
                    if a.parent
                    else ""
                )
                role = self._extract_role_from_text(parent_text)
                if not role and a.parent and a.parent.parent:
                    role = self._extract_role_from_text(
                        a.parent.parent.get_text(" ", strip=True)
                    )

                records.append(
                    ProfessorRecord(
                        university=university,
                        department=department,
                        full_name=text,
                        role_title=role,
                        profile_url=profile_url,
                        source_url=source_url,
                    )
                )

        return records

    def parse_professors(
        self, html: str, source_url: str, department: str, university: str
    ) -> List[ProfessorRecord]:
        try:
            soup = BeautifulSoup(html, "html.parser")
        except Exception as exc:
            logging.error("Parser initialization failed for %s: %s", source_url, exc)
            return []

        try:
            table_records = self._extract_from_tables(
                soup, source_url, department, university
            )
            card_records = self._extract_from_cards_and_lists(
                soup, source_url, department, university
            )
            all_records = table_records + card_records
            return self._deduplicate(all_records)
        except Exception as exc:
            logging.error("Parsing failed for %s: %s", source_url, exc)
            return []

    # --------------------------- Orchestration ---------------------------

    def scrape_university(self, university_url: str) -> List[ProfessorRecord]:
        uni_root = self._normalize_url(university_url)
        university_name = urlparse(uni_root).netloc.lower()

        logging.info("Discovering departments from %s", uni_root)
        departments = self.discover_department_pages(uni_root)
        logging.info("Discovered %d department candidates", len(departments))

        aggregated: List[ProfessorRecord] = []
        depts = list(departments.items())

        for idx, (department_name, department_url) in enumerate(depts, start=1):
            logging.info(
                "[%d/%d] Department: %s | %s",
                idx,
                len(depts),
                department_name,
                department_url,
            )

            people_pages = self.discover_people_pages(department_url)
            logging.info("  Found %d candidate people pages", len(people_pages))

            for p_idx, people_url in enumerate(people_pages, start=1):
                html = self.fetcher.get_text(people_url)
                if html is None:
                    continue

                records = self.parse_professors(
                    html=html,
                    source_url=people_url,
                    department=department_name,
                    university=university_name,
                )
                if records:
                    logging.info(
                        "  [%d/%d] Extracted %d records from %s",
                        p_idx,
                        len(people_pages),
                        len(records),
                        people_url,
                    )
                aggregated.extend(records)
                self._sleep()

        self.records = self._deduplicate(aggregated)
        logging.info("Total unique professor records: %d", len(self.records))
        return self.records

    @staticmethod
    def _deduplicate(records: Iterable[ProfessorRecord]) -> List[ProfessorRecord]:
        unique: List[ProfessorRecord] = []
        seen: Set[Tuple[str, str, str, str]] = set()

        for r in records:
            key = (
                r.university.strip().lower(),
                r.department.strip().lower(),
                r.full_name.strip().lower(),
                r.profile_url.strip().lower(),
            )
            if key in seen:
                continue
            seen.add(key)
            unique.append(r)
        return unique

    # --------------------------- Export ---------------------------

    def save_json(self, file_path: str = "professors.json") -> None:
        payload = [asdict(r) for r in self.records]
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        logging.info("Saved JSON: %s", file_path)

    def save_csv(self, file_path: str = "professors.csv") -> None:
        with open(file_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "university",
                    "department",
                    "full_name",
                    "role_title",
                    "profile_url",
                    "source_url",
                ],
            )
            writer.writeheader()
            for rec in self.records:
                writer.writerow(asdict(rec))
        logging.info("Saved CSV: %s", file_path)

    def save_outputs(
        self, json_path: str = "professors.json", csv_path: str = "professors.csv"
    ) -> None:
        self.save_json(json_path)
        self.save_csv(csv_path)


# --------------------------- CLI ---------------------------


def build_output_path(output_dir: str, file_name: str) -> str:
    cleaned = output_dir.rstrip("/").rstrip("\\")
    if not cleaned:
        cleaned = "."
    return f"{cleaned}/{file_name}"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Discover departments and scrape professors from any university site."
    )
    parser.add_argument(
        "--university-url",
        required=True,
        help="University website URL (e.g., https://www.polito.it)",
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Output directory for professors.json and professors.csv",
    )
    parser.add_argument(
        "--min-delay",
        type=float,
        default=2.0,
        help="Minimum politeness delay in seconds (default: 2.0)",
    )
    parser.add_argument(
        "--max-delay",
        type=float,
        default=4.0,
        help="Maximum politeness delay in seconds (default: 4.0)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=20,
        help="HTTP timeout in seconds for requests mode (default: 20)",
    )
    parser.add_argument(
        "--browser-timeout-ms",
        type=int,
        default=30000,
        help="Browser navigation timeout in milliseconds (default: 30000)",
    )
    parser.add_argument(
        "--fetch-mode",
        default="auto",
        choices=["requests", "browser", "auto"],
        help="Fetching strategy: requests, browser, or auto fallback (default: auto)",
    )
    parser.add_argument(
        "--max-discovery-pages",
        type=int,
        default=100,
        help="Maximum pages to visit while discovering departments (default: 100)",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging level",
    )

    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s | %(levelname)s | %(message)s",
    )

    if args.min_delay < 0 or args.max_delay < 0 or args.max_delay < args.min_delay:
        raise ValueError("Invalid delay range. Ensure 0 <= min-delay <= max-delay.")
    if args.max_discovery_pages <= 0:
        raise ValueError("--max-discovery-pages must be > 0")

    if args.fetch_mode == "requests":
        fetcher: BaseFetcher = RequestsFetcher(timeout=args.timeout)
    elif args.fetch_mode == "browser":
        fetcher = PlaywrightFetcher(timeout_ms=args.browser_timeout_ms)
    else:
        fetcher = AutoFallbackFetcher(
            requests_timeout=args.timeout,
            browser_timeout_ms=args.browser_timeout_ms,
        )

    scraper = UniversityProfessorScraper(
        fetcher=fetcher,
        delay_range=(args.min_delay, args.max_delay),
        max_discovery_pages=args.max_discovery_pages,
    )

    scraper.scrape_university(args.university_url)

    json_path = build_output_path(args.output_dir, "professors.json")
    csv_path = build_output_path(args.output_dir, "professors.csv")
    scraper.save_outputs(json_path=json_path, csv_path=csv_path)


if __name__ == "__main__":
    main()
