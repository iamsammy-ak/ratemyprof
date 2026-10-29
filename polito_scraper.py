#!/usr/bin/env python3
"""
PoliTo Professor Directory Scraper
----------------------------------

Enhanced scraper for Politecnico di Torino personnel directories.

Enhancements in this version:
- Teaching-staff filtering (full/associate/researcher tracks)
- Role categorization
- Canonical professor IDs for stable identity across runs
- Extra output files:
  - professors.json / professors.csv
  - teaching_staff_only.json / teaching_staff_only.csv
  - role_summary.json
  - canonical_index.csv

Dependencies:
- requests
- beautifulsoup4
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
import os
import random
import re
import time
import unicodedata
from dataclasses import asdict, dataclass
from typing import Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup


@dataclass
class ProfessorRecord:
    canonical_id: str
    full_name: str
    normalized_name: str
    display_name: str
    department: str
    role_title: str
    role_category: str
    is_teaching_staff: bool
    profile_url: str
    source_url: str


class PolitoScraper:
    """
    Scraper class for PoliTo personnel directory pages.

    Pipeline:
    1) Orchestrator loops through configured URLs
    2) Fetcher retrieves HTML with custom headers
    3) Parser extracts professor records
    4) Canonicalization + role categorization + deduplication
    5) Export to JSON/CSV + extra analytics outputs
    """

    # All 11 departments
    DEFAULT_DEPARTMENTS: Dict[str, str] = {
        "DAD": "https://www.dad.polito.it/personale/elenco",
        "DAUIN": "https://www.dauin.polito.it/personale/elenco",
        "DENERG": "https://www.denerg.polito.it/personale/elenco",
        "DET": "https://www.det.polito.it/personale/elenco",
        "DIATI": "https://www.diati.polito.it/personale/elenco",
        "DIGEP": "https://www.digep.polito.it/personale/elenco",
        "DIMEAS": "https://www.dimeas.polito.it/personale/elenco",
        "DISAT": "https://www.disat.polito.it/personale/elenco",
        "DISEG": "https://www.diseg.polito.it/personale/elenco",
        "DISMA": "https://www.disma.polito.it/personale/elenco",
        "DIST": "https://www.dist.polito.it/personale/elenco",
    }

    ROLE_PATTERNS: List[Tuple[str, Tuple[str, ...]]] = [
        (
            "FULL_PROFESSOR",
            (
                "professore ordinario",
                "professore ordinario (l.240)",
                "full professor",
                "ordinario",
            ),
        ),
        (
            "ASSOCIATE_PROFESSOR",
            (
                "professore associato",
                "professore associato (l.240)",
                "prof. associato",
                "associate professor",
                "associato",
            ),
        ),
        (
            "RESEARCHER",
            (
                "ricercatore",
                "researcher",
                "research assistant",
                "assistant professor",
                "tenured assistant professor",
                "fixed-term tenure-track assistant professor",
                "tenure-track assistant professor",
            ),
        ),
        (
            "POSTDOC",
            (
                "assegnista di ricerca",
                "research fellow",
                "postdoc",
                "post-doctoral",
            ),
        ),
        (
            "PHD_CANDIDATE",
            (
                "dottorando",
                "ph.d. candidate",
                "phd candidate",
            ),
        ),
        (
            "ADJUNCT_LECTURER",
            (
                "docente a contratto",
                "adjunct lecturer",
                "adjunct instructor",
                "collaboratore didattico",
            ),
        ),
        (
            "TECHNICAL_ADMIN",
            (
                "personale tecnico",
                "tecnico amministrativo",
                "amministrativo",
                "staff",
                "collaboratore esterno",
                "ospite",
            ),
        ),
    ]

    TEACHING_CATEGORIES: Set[str] = {
        "FULL_PROFESSOR",
        "ASSOCIATE_PROFESSOR",
        "RESEARCHER",
    }

    def __init__(
        self,
        department_urls: Optional[Dict[str, str]] = None,
        delay_range: Tuple[float, float] = (2.0, 4.0),
        timeout: int = 20,
    ) -> None:
        self.department_urls: Dict[str, str] = (
            department_urls.copy()
            if department_urls
            else self.DEFAULT_DEPARTMENTS.copy()
        )
        self.delay_range = delay_range
        self.timeout = timeout
        self.records: List[ProfessorRecord] = []

        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": (
                    "PoliToProfessorScraper/2.0 "
                    "(Academic project: RateMyProfessor PoliTo; "
                    "contact: replace-with-your-email@example.com)"
                ),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
                "Connection": "keep-alive",
            }
        )

    # ---------- Normalization helpers ----------

    @staticmethod
    def _clean_text(value: str) -> str:
        return re.sub(r"\s+", " ", (value or "").strip())

    @staticmethod
    def _strip_accents(value: str) -> str:
        normalized = unicodedata.normalize("NFD", value)
        return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")

    def _normalize_name(self, full_name: str) -> str:
        base = self._strip_accents(self._clean_text(full_name)).lower()
        base = re.sub(r"[^a-z0-9\s]", " ", base)
        base = re.sub(r"\s+", " ", base).strip()
        return base

    def _to_display_name(self, full_name: str) -> str:
        cleaned = self._clean_text(full_name)
        if cleaned.isupper():
            return " ".join(part.capitalize() for part in cleaned.split())
        return cleaned

    # ---------- URL / Department normalization ----------

    def _normalize_elenco_url(self, url: str) -> str:
        clean = (url or "").strip()
        if not clean:
            raise ValueError("Empty URL provided.")

        if not clean.startswith(("http://", "https://")):
            clean = "https://" + clean

        parsed = urlparse(clean)
        path = parsed.path.rstrip("/")

        if path.endswith("/personale/elenco"):
            final_path = path
        elif path.endswith("/personale"):
            final_path = path + "/elenco"
        elif path == "":
            final_path = "/personale/elenco"
        else:
            final_path = "/personale/elenco"

        return f"{parsed.scheme}://{parsed.netloc}{final_path}"

    def _derive_department_code(self, url: str) -> str:
        parsed = urlparse(url)
        host = (parsed.netloc or "").lower()
        parts = host.split(".")

        if len(parts) >= 4 and parts[0] == "www":
            candidate = parts[1]
            if candidate and candidate not in {"polito"}:
                return candidate.upper()

        if len(parts) >= 3:
            candidate = parts[0]
            if candidate and candidate not in {"www", "polito"}:
                return candidate.upper()

        return "UNKNOWN"

    def add_custom_urls(self, urls: Iterable[str]) -> None:
        for raw_url in urls:
            if not raw_url or not raw_url.strip():
                continue

            try:
                normalized = self._normalize_elenco_url(raw_url)
                dept = self._derive_department_code(normalized)

                key = dept
                counter = 2
                while (
                    key in self.department_urls
                    and self.department_urls[key] != normalized
                ):
                    key = f"{dept}_{counter}"
                    counter += 1

                self.department_urls[key] = normalized
            except Exception as exc:
                logging.error("Skipping invalid custom URL '%s': %s", raw_url, exc)

    # ---------- Role categorization ----------

    def categorize_role(self, role_title: str) -> str:
        role = self._clean_text(role_title).lower()
        if not role:
            return "OTHER"

        for category, patterns in self.ROLE_PATTERNS:
            for pattern in patterns:
                if pattern in role:
                    return category
        return "OTHER"

    def is_teaching_staff_role(self, category: str) -> bool:
        return category in self.TEACHING_CATEGORIES

    # ---------- Canonical ID ----------

    def _canonical_slug_from_profile(self, profile_url: str) -> str:
        if not profile_url:
            return ""

        url = profile_url.strip()
        # Common PoliTo profile shape:
        # .../personale/scheda/(nominativo)/stefano.quer
        match = re.search(r"/\(nominativo\)/([^/?#]+)", url, flags=re.IGNORECASE)
        if match:
            candidate = match.group(1)
        else:
            path = urlparse(url).path.strip("/")
            candidate = path.split("/")[-1] if path else ""

        candidate = candidate.lower()
        candidate = re.sub(r"[^a-z0-9._-]", "", candidate)
        return candidate

    def build_canonical_id(
        self, full_name: str, department: str, profile_url: str
    ) -> str:
        profile_slug = self._canonical_slug_from_profile(profile_url)
        if profile_slug:
            base = profile_slug.replace(".", "_")
            return f"polito_{base}"

        normalized_name = self._normalize_name(full_name)
        slug = normalized_name.replace(" ", "_")
        if slug:
            return f"polito_{slug}"

        digest = hashlib.md5(
            f"{full_name}|{department}|{profile_url}".encode("utf-8")
        ).hexdigest()[:12]
        return f"polito_{digest}"

    # ---------- Fetching ----------

    def fetch_page(self, url: str) -> Optional[str]:
        try:
            response = self.session.get(url, timeout=self.timeout)
            response.raise_for_status()
            return response.text
        except requests.RequestException as exc:
            logging.error("HTTP error for %s: %s", url, exc)
            return None

    # ---------- Parsing ----------

    def _build_record(
        self,
        full_name: str,
        department: str,
        role_title: str,
        profile_url: str,
        source_url: str,
    ) -> Optional[ProfessorRecord]:
        name = self._clean_text(full_name)
        if not name:
            return None

        role = self._clean_text(role_title)
        role_category = self.categorize_role(role)
        is_teaching = self.is_teaching_staff_role(role_category)
        canonical_id = self.build_canonical_id(name, department, profile_url)

        return ProfessorRecord(
            canonical_id=canonical_id,
            full_name=name,
            normalized_name=self._normalize_name(name),
            display_name=self._to_display_name(name),
            department=department,
            role_title=role,
            role_category=role_category,
            is_teaching_staff=is_teaching,
            profile_url=profile_url.strip(),
            source_url=source_url.strip(),
        )

    def _extract_from_table(
        self,
        soup: BeautifulSoup,
        source_url: str,
        department: str,
    ) -> List[ProfessorRecord]:
        found: List[ProfessorRecord] = []
        candidate_tables = soup.find_all("table")

        for table in candidate_tables:
            rows = table.find_all("tr")
            if not rows:
                continue

            header_cells = rows[0].find_all(["th", "td"])
            headers = [
                self._clean_text(cell.get_text(" ", strip=True)).lower()
                for cell in header_cells
            ]
            has_name_signal = any(
                ("nome" in h or "name" in h or "docente" in h) for h in headers
            )
            has_role_signal = any(
                ("ruolo" in h or "qualifica" in h or "role" in h) for h in headers
            )
            start_idx = 1 if headers and (has_name_signal or has_role_signal) else 0

            for row in rows[start_idx:]:
                cells = row.find_all("td")
                if not cells:
                    continue

                anchor = row.find("a", href=True)
                if anchor:
                    full_name = self._clean_text(anchor.get_text(" ", strip=True))
                    profile_url = urljoin(source_url, anchor["href"])
                else:
                    full_name = self._clean_text(cells[0].get_text(" ", strip=True))
                    profile_url = ""

                if not full_name:
                    continue

                role_title = ""
                if len(cells) >= 2:
                    role_title = self._clean_text(cells[1].get_text(" ", strip=True))
                elif len(cells) == 1:
                    row_text = self._clean_text(row.get_text(" ", strip=True))
                    role_title = self._clean_text(row_text.replace(full_name, "", 1))

                record = self._build_record(
                    full_name=full_name,
                    department=department,
                    role_title=role_title,
                    profile_url=profile_url,
                    source_url=source_url,
                )
                if record:
                    found.append(record)

        return found

    def _extract_fallback_links(
        self,
        soup: BeautifulSoup,
        source_url: str,
        department: str,
    ) -> List[ProfessorRecord]:
        found: List[ProfessorRecord] = []
        seen_local: Set[str] = set()

        for anchor in soup.find_all("a", href=True):
            text = self._clean_text(anchor.get_text(" ", strip=True))
            href = anchor.get("href", "")

            if len(text.split()) < 2:
                continue
            if len(text) < 5:
                continue
            if any(skip in href.lower() for skip in ["mailto:", "tel:", "#"]):
                continue

            profile_url = urljoin(source_url, href)
            signature = f"{text.lower()}|{profile_url.lower()}"
            if signature in seen_local:
                continue
            seen_local.add(signature)

            record = self._build_record(
                full_name=text,
                department=department,
                role_title="",
                profile_url=profile_url,
                source_url=source_url,
            )
            if record:
                found.append(record)

        return found

    def parse_professors(
        self, html: str, source_url: str, department: str
    ) -> List[ProfessorRecord]:
        try:
            soup = BeautifulSoup(html, "html.parser")
        except Exception as exc:
            logging.error("Parser initialization failed for %s: %s", source_url, exc)
            return []

        try:
            records = self._extract_from_table(soup, source_url, department)
            if not records:
                logging.warning(
                    "No table records found for %s. Trying fallback parser.", source_url
                )
                records = self._extract_fallback_links(soup, source_url, department)
            return records
        except Exception as exc:
            logging.error("Parsing failed for %s: %s", source_url, exc)
            return []

    # ---------- Orchestration ----------

    def scrape_all(self) -> List[ProfessorRecord]:
        aggregated: List[ProfessorRecord] = []
        items = list(self.department_urls.items())
        total = len(items)

        for idx, (dept_key, raw_url) in enumerate(items, start=1):
            try:
                url = self._normalize_elenco_url(raw_url)
            except Exception as exc:
                logging.error("Invalid URL for %s: %s (%s)", dept_key, raw_url, exc)
                continue

            department = (
                dept_key if dept_key != "UNKNOWN" else self._derive_department_code(url)
            )
            logging.info("[%d/%d] Scraping %s -> %s", idx, total, department, url)

            html = self.fetch_page(url)
            if html is None:
                continue

            records = self.parse_professors(html, url, department)
            logging.info("Extracted %d raw records from %s", len(records), department)
            aggregated.extend(records)

            if idx < total:
                wait = random.uniform(self.delay_range[0], self.delay_range[1])
                logging.info("Sleeping %.2f seconds before next request...", wait)
                time.sleep(wait)

        self.records = self._deduplicate(aggregated)
        logging.info("Total unique records: %d", len(self.records))
        return self.records

    def _deduplicate(self, records: List[ProfessorRecord]) -> List[ProfessorRecord]:
        """
        Deduplicate by canonical identity + department.
        If duplicates exist, keep richer role/profile info.
        """
        best_by_key: Dict[Tuple[str, str], ProfessorRecord] = {}

        for rec in records:
            key = (rec.canonical_id, rec.department.upper())
            existing = best_by_key.get(key)

            if existing is None:
                best_by_key[key] = rec
                continue

            # Keep record with richer information
            existing_score = (1 if existing.role_title else 0) + (
                1 if existing.profile_url else 0
            )
            current_score = (1 if rec.role_title else 0) + (1 if rec.profile_url else 0)

            if current_score > existing_score:
                best_by_key[key] = rec

        return list(best_by_key.values())

    def teaching_staff_records(self) -> List[ProfessorRecord]:
        return [r for r in self.records if r.is_teaching_staff]

    # ---------- Export helpers ----------

    @staticmethod
    def _build_output_path(output_dir: str, filename: str) -> str:
        os.makedirs(output_dir, exist_ok=True)
        return os.path.join(output_dir, filename)

    @staticmethod
    def _records_to_dicts(records: List[ProfessorRecord]) -> List[Dict[str, object]]:
        return [asdict(r) for r in records]

    def save_json(self, records: List[ProfessorRecord], file_path: str) -> None:
        payload = self._records_to_dicts(records)
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        logging.info("Saved JSON: %s", file_path)

    def save_csv(self, records: List[ProfessorRecord], file_path: str) -> None:
        fieldnames = [
            "canonical_id",
            "full_name",
            "normalized_name",
            "display_name",
            "department",
            "role_title",
            "role_category",
            "is_teaching_staff",
            "profile_url",
            "source_url",
        ]
        with open(file_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for record in records:
                writer.writerow(asdict(record))
        logging.info("Saved CSV: %s", file_path)

    def build_role_summary(self, records: List[ProfessorRecord]) -> Dict[str, object]:
        by_category: Dict[str, int] = {}
        by_department: Dict[str, Dict[str, int]] = {}
        teaching_count = 0

        for rec in records:
            by_category[rec.role_category] = by_category.get(rec.role_category, 0) + 1
            if rec.is_teaching_staff:
                teaching_count += 1

            dept = rec.department
            if dept not in by_department:
                by_department[dept] = {"total": 0, "teaching_staff": 0}
            by_department[dept]["total"] += 1
            if rec.is_teaching_staff:
                by_department[dept]["teaching_staff"] += 1

        return {
            "total_records": len(records),
            "teaching_staff_records": teaching_count,
            "role_category_counts": dict(
                sorted(by_category.items(), key=lambda x: x[0])
            ),
            "department_counts": dict(
                sorted(by_department.items(), key=lambda x: x[0])
            ),
        }

    def build_canonical_index(
        self, records: List[ProfessorRecord]
    ) -> List[Dict[str, str]]:
        by_id: Dict[str, Dict[str, object]] = {}
        for rec in records:
            node = by_id.get(rec.canonical_id)
            if node is None:
                by_id[rec.canonical_id] = {
                    "canonical_id": rec.canonical_id,
                    "display_name": rec.display_name,
                    "normalized_name": rec.normalized_name,
                    "profile_url": rec.profile_url,
                    "departments": {rec.department},
                    "role_categories": {rec.role_category},
                }
            else:
                node["departments"].add(rec.department)
                node["role_categories"].add(rec.role_category)
                if not node["profile_url"] and rec.profile_url:
                    node["profile_url"] = rec.profile_url

        output: List[Dict[str, str]] = []
        for _, node in sorted(by_id.items(), key=lambda x: x[1]["display_name"]):
            output.append(
                {
                    "canonical_id": str(node["canonical_id"]),
                    "display_name": str(node["display_name"]),
                    "normalized_name": str(node["normalized_name"]),
                    "profile_url": str(node["profile_url"]),
                    "departments": ";".join(sorted(node["departments"])),
                    "role_categories": ";".join(sorted(node["role_categories"])),
                }
            )
        return output

    def save_canonical_index_csv(
        self, records: List[ProfessorRecord], file_path: str
    ) -> None:
        rows = self.build_canonical_index(records)
        fieldnames = [
            "canonical_id",
            "display_name",
            "normalized_name",
            "profile_url",
            "departments",
            "role_categories",
        ]
        with open(file_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        logging.info("Saved CSV: %s", file_path)

    def save_outputs(
        self,
        output_dir: str = ".",
        only_teaching_primary: bool = False,
        skip_extra_files: bool = False,
    ) -> None:
        all_records = self.records
        teaching_records = self.teaching_staff_records()
        primary = teaching_records if only_teaching_primary else all_records

        # Primary outputs
        self.save_json(primary, self._build_output_path(output_dir, "professors.json"))
        self.save_csv(primary, self._build_output_path(output_dir, "professors.csv"))

        if skip_extra_files:
            return

        # Extra outputs
        self.save_json(
            teaching_records,
            self._build_output_path(output_dir, "teaching_staff_only.json"),
        )
        self.save_csv(
            teaching_records,
            self._build_output_path(output_dir, "teaching_staff_only.csv"),
        )

        role_summary = self.build_role_summary(all_records)
        role_summary_path = self._build_output_path(output_dir, "role_summary.json")
        with open(role_summary_path, "w", encoding="utf-8") as f:
            json.dump(role_summary, f, ensure_ascii=False, indent=2)
        logging.info("Saved JSON: %s", role_summary_path)

        self.save_canonical_index_csv(
            all_records,
            self._build_output_path(output_dir, "canonical_index.csv"),
        )


def load_urls_from_file(file_path: str) -> List[str]:
    urls: List[str] = []
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    urls.append(line)
    except OSError as exc:
        logging.error("Could not read URLs file '%s': %s", file_path, exc)
    return urls


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Scrape PoliTo personnel directory pages with canonical IDs, "
            "role categorization, and teaching-staff filtering."
        )
    )
    parser.add_argument(
        "--url",
        action="append",
        default=[],
        help="Custom department URL (can be used multiple times).",
    )
    parser.add_argument(
        "--urls-file",
        default="",
        help="Text file containing custom URLs (one per line).",
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Directory for output files (default current directory).",
    )
    parser.add_argument(
        "--min-delay",
        type=float,
        default=2.0,
        help="Minimum politeness delay in seconds (default 2.0).",
    )
    parser.add_argument(
        "--max-delay",
        type=float,
        default=4.0,
        help="Maximum politeness delay in seconds (default 4.0).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=20,
        help="HTTP timeout in seconds (default 20).",
    )
    parser.add_argument(
        "--only-teaching-staff",
        action="store_true",
        help="Write professors.json/csv with teaching staff only.",
    )
    parser.add_argument(
        "--skip-extra-files",
        action="store_true",
        help="Skip extra outputs (teaching_staff_only.*, role_summary.json, canonical_index.csv).",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging level.",
    )

    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s | %(levelname)s | %(message)s",
    )

    if args.min_delay < 0 or args.max_delay < 0 or args.max_delay < args.min_delay:
        raise ValueError("Invalid delay range. Ensure 0 <= min-delay <= max-delay.")

    scraper = PolitoScraper(
        delay_range=(args.min_delay, args.max_delay),
        timeout=args.timeout,
    )

    custom_urls = list(args.url)
    if args.urls_file:
        custom_urls.extend(load_urls_from_file(args.urls_file))
    if custom_urls:
        scraper.add_custom_urls(custom_urls)

    scraper.scrape_all()
    scraper.save_outputs(
        output_dir=args.output_dir,
        only_teaching_primary=args.only_teaching_staff,
        skip_extra_files=args.skip_extra_files,
    )


if __name__ == "__main__":
    main()
