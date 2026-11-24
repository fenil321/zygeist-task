#!/usr/bin/env python3
"""
Standalone In-Store Hub Simulator for Brightleaf Market (Module 6).
Completely decoupled from the web platform: communicates solely via inbox/ and outbox/.
"""

import argparse
import logging
import os
import re
import shutil
import sys
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

PRICE_REGEX = re.compile(r"^\d+\.\d{2}$")


class HubSimulator:
    def __init__(self, source_dir: Path, runtime_dir: Path, speed: float, max_delay: float):
        self.source_outbox = source_dir / "outbox"
        self.live_outbox = runtime_dir / "outbox"
        self.live_inbox = runtime_dir / "inbox"
        self.processed_inbox = self.live_inbox / "processed"
        self.speed = speed
        self.max_delay = max_delay

        self.live_outbox.mkdir(parents=True, exist_ok=True)
        self.live_inbox.mkdir(parents=True, exist_ok=True)
        self.processed_inbox.mkdir(parents=True, exist_ok=True)

        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.emitted_files: list[str] = []
        self.applied_change_ids: set[str] = set()

        # In-memory hub state seeded from source PRICELIST_*.xml files
        self.known_stores = {"BL01", "BL02"}
        self.known_depts: set[str] = set()
        self.known_tax_groups: set[str] = {"T0", "T1", "T2"}
        # Key: (store_id, item_code, variant) -> dict of item attributes
        self.catalog: dict[tuple[str, str, str], dict] = {}

        self._setup_logging(runtime_dir / "simulator.log")
        self._seed_catalog_from_source()

    def _setup_logging(self, log_path: Path):
        self.logger = logging.getLogger("HubSimulator")
        self.logger.setLevel(logging.INFO)
        formatter = logging.Formatter("%(asctime)s [HUB] %(message)s", "%Y-%m-%d %H:%M:%S")

        fh = logging.FileHandler(log_path, encoding="utf-8")
        fh.setFormatter(formatter)
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(formatter)

        self.logger.addHandler(fh)
        self.logger.addHandler(sh)

    def _seed_catalog_from_source(self):
        """Load initial departments, tax groups, and items from PRICELIST_*.xml in source."""
        if not self.source_outbox.exists():
            self.logger.warning(f"Source outbox not found at {self.source_outbox}")
            return

        for file_path in sorted(self.source_outbox.glob("PRICELIST_*.xml")):
            try:
                tree = ET.parse(file_path)
                root = tree.getroot()
                store_id = root.attrib.get("storeId") or file_path.stem.split("_")[1]
                self.known_stores.add(store_id)

                for dept_el in root.findall(".//Department"):
                    code = dept_el.attrib.get("code") or dept_el.attrib.get("id")
                    if code:
                        self.known_depts.add(code.lstrip("0") or "0")
                        self.known_depts.add(code)

                for tg_el in root.findall(".//TaxGroup"):
                    tg = tg_el.attrib.get("code") or tg_el.attrib.get("id")
                    if tg:
                        self.known_tax_groups.add(tg)

                for item_el in root.findall(".//Item"):
                    code = item_el.attrib.get("code") or item_el.attrib.get("itemCode")
                    variant = item_el.attrib.get("variant", "000")
                    dept = item_el.attrib.get("dept", "")
                    if dept:
                        self.known_depts.add(dept)
                        self.known_depts.add(dept.lstrip("0") or "0")
                    if code:
                        self.catalog[(store_id, code, variant)] = {
                            "description": item_el.attrib.get("description", ""),
                            "dept": dept,
                            "price": item_el.attrib.get("price", "0.00"),
                            "taxGroup": item_el.attrib.get("taxGroup", "T0"),
                            "active": True,
                        }
            except Exception as exc:
                self.logger.warning(f"Could not pre-seed from {file_path.name}: {exc}")

        self.logger.info(
            f"Seeded catalog: {len(self.catalog)} items, {len(self.known_depts)} departments."
        )

    def _atomic_write_outbox(self, filename: str, content: str):
        """Write to .tmp first and atomically rename into outbox/."""
        tmp_path = self.live_outbox / f"{filename}.tmp"
        final_path = self.live_outbox / filename
        tmp_path.write_text(content, encoding="utf-8")
        tmp_path.replace(final_path)
        with self.lock:
            self.emitted_files.append(filename)
        self.logger.info(f"EMITTED -> outbox/{filename}")

    def _copy_to_outbox(self, src: Path):
        """Copy file atomically into live outbox/ without modifying source."""
        tmp_path = self.live_outbox / f"{src.name}.tmp"
        final_path = self.live_outbox / src.name
        shutil.copy2(src, tmp_path)
        tmp_path.replace(final_path)
        with self.lock:
            self.emitted_files.append(src.name)
        self.logger.info(f"EMITTED -> outbox/{src.name}")

    def replay_loop(self):
        """Replay files from source outbox/ in chronological mtime order."""
        if not self.source_outbox.exists():
            self.logger.error(f"Source outbox missing: {self.source_outbox}")
            return
        
        files = [f for f in self.source_outbox.iterdir() if f.is_file() and not f.name.startswith(".")]
        files.sort(key=lambda f: f.stat().st_mtime)

        if not files:
            self.logger.warning("No files found in source outbox/ to replay.")
            return

        self.logger.info(f"Starting replay of {len(files)} files at {self.speed}x speed...")
        prev_mtime = files[0].stat().st_mtime

        for idx, file_path in enumerate(files):
            if self.stop_event.is_set():
                break

            # Skip already copied files if resuming
            if (self.live_outbox / file_path.name).exists():
                with self.lock:
                    if file_path.name not in self.emitted_files:
                        self.emitted_files.append(file_path.name)
                prev_mtime = file_path.stat().st_mtime
                continue

            if idx > 0 and self.speed > 0:
                delta_real = max(0.0, file_path.stat().st_mtime - prev_mtime)
                sleep_sec = min(self.max_delay, delta_real / self.speed)
                if sleep_sec > 0:
                    self.stop_event.wait(sleep_sec)
                    if self.stop_event.is_set():
                        break

            self._copy_to_outbox(file_path)
            prev_mtime = file_path.stat().st_mtime

        self.logger.info("Replay of historical dataset complete. Hub remains online for inbox/ & manual commands.")

    def inbox_poll_loop(self):
        """Poll inbox/ every 2 seconds (ignoring .tmp files) and process change files."""
        while not self.stop_event.is_set():
            try:
                for path in sorted(self.live_inbox.iterdir()):
                    if not path.is_file() or path.name.endswith(".tmp") or path.name.startswith("."):
                        continue
                    self._process_change_file(path)
            except Exception as exc:
                self.logger.error(f"Inbox polling error: {exc}")
            self.stop_event.wait(2.0)

    def _process_change_file(self, path: Path):
        self.logger.info(f"PROCESSING -> inbox/{path.name}")
        raw_text = path.read_text(encoding="utf-8", errors="replace")

        # Move input file to inbox/processed/ regardless of outcome
        dest_processed = self.processed_inbox / f"{int(time.time())}_{path.name}"
        shutil.move(str(path), str(dest_processed))

        # Parse XML (E302)
        try:
            root = ET.fromstring(raw_text)
        except ET.ParseError as exc:
            self._write_rej("UNKNOWN", path.stem, "E302", f"Malformed XML: {exc}")
            return

        if root.tag != "ChangeFile":
            self._write_rej("UNKNOWN", path.stem, "E302", "Root element must be ChangeFile")
            return

        change_id = root.attrib.get("changeId", path.stem)
        store_id = root.attrib.get("storeId", "")

        # E301: Store match check
        if store_id not in self.known_stores:
            self._write_rej(store_id or "UNKNOWN", change_id, "E301", f"Unknown storeId '{store_id}'")
            return

        # E410: Reject non-item maintenance (accounts, staff, devices, departments)
        allowed_children = {"Items"}
        for child in root:
            if child.tag not in allowed_children:
                self._write_rej(
                    store_id,
                    change_id,
                    "E410",
                    f"Element <{child.tag}> not accepted via file exchange; hub terminal only",
                )
                return

        items_container = root.find("Items")
        if items_container is None:
            self._write_rej(store_id, change_id, "E302", "Missing <Items> container")
            return

        # Duplicate changeId check
        if change_id in self.applied_change_ids:
            ack_xml = (
                f'<?xml version="1.0" encoding="UTF-8"?>\n'
                f'<ChangeAck changeId="{change_id}" storeId="{store_id}" '
                f'processed="{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}" result="ALREADY_APPLIED"/>\n'
            )
            self._atomic_write_outbox(f"ACK_{store_id}_{change_id}.xml", ack_xml)
            return

        # Validate & apply item-level changes
        item_results = []
        applied_count = 0
        rejected_count = 0

        for item_el in items_container.findall("Item"):
            action = item_el.attrib.get("action", "")
            code = item_el.attrib.get("code", "")
            variant = item_el.attrib.get("variant")
            desc = item_el.attrib.get("description")
            price_str = item_el.attrib.get("price")
            dept = item_el.attrib.get("dept")
            tax_group = item_el.attrib.get("taxGroup")

            err_code, err_msg = self._validate_item(
                store_id, action, code, variant, desc, price_str, dept, tax_group
            )
            # --- UPDATED SECTION START ---
            if err_code:
                rejected_count += 1
                item_results.append(
                    f'  <ItemResult code="{code}" variant="{variant or ""}" action="{action}" '
                    f'result="REJECTED" errorCode="{err_code}" message="{err_msg}"/>'
                )
            else:
                applied_count += 1
                self._apply_item_mutation(
                    store_id, action, code, variant, desc, price_str, dept, tax_group
                )
                item_results.append(
                    f'  <ItemResult code="{code}" variant="{variant}" action="{action}" result="APPLIED"/>'
                )

        self.applied_change_ids.add(change_id)

        if applied_count > 0 and rejected_count == 0:
            overall = "APPLIED"
        elif applied_count > 0 and rejected_count > 0:
            overall = "PARTIAL"
        else:
            overall = "REJECTED"

        ack_xml = (
            f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<ChangeAck changeId="{change_id}" storeId="{store_id}" '
            f'processed="{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}" result="{overall}">\n'
            + "\n".join(item_results)
            + "\n</ChangeAck>\n"
        )
        # --- UPDATED SECTION END ---

        self._atomic_write_outbox(f"ACK_{store_id}_{change_id}.xml", ack_xml)
        
    def _validate_item(self, store_id, action, code, variant, desc, price_str, dept, tax_group):
        if variant is None or variant.strip() == "":
            return "E312", "variant is required on every item"

        if desc is not None and len(desc) > 24:
            return "E315", f"description exceeds 24 characters ({len(desc)})"

        if action in ("add", "update") or price_str is not None:
            if not price_str or not PRICE_REGEX.match(price_str):
                return "E318", "price must have exactly 2 decimal places"
            try:
                val = Decimal(price_str)
                if val <= Decimal("0.00") or val > Decimal("999.99"):
                    return "E318", "price must be > 0.00 and <= 999.99"
            except InvalidOperation:
                return "E318", "invalid decimal price"

        if dept is not None and self.known_depts:
            if dept not in self.known_depts and (dept.lstrip("0") or "0") not in self.known_depts:
                return "E320", f"unknown department '{dept}'"

        if tax_group is not None and tax_group not in self.known_tax_groups:
            return "E321", f"unknown taxGroup '{tax_group}'"

        exists = (store_id, code, variant) in self.catalog
        if action in ("update", "deactivate") and not exists:
            return "E330", f"item {code}:{variant} does not exist for {action}"
        if action == "add" and exists:
            return "E331", f"item {code}:{variant} already exists"
        if action not in ("add", "update", "deactivate"):
            return "E302", f"unsupported action '{action}'"

        return None, None

    def _apply_item_mutation(self, store_id, action, code, variant, desc, price_str, dept, tax_group):
        key = (store_id, code, variant)
        if action == "add":
            self.catalog[key] = {
                "description": desc or "",
                "dept": dept or "",
                "price": price_str,
                "taxGroup": tax_group or "T0",
                "active": True,
            }
        elif action == "update":
            if desc is not None:
                self.catalog[key]["description"] = desc
            if price_str is not None:
                self.catalog[key]["price"] = price_str
            if dept is not None:
                self.catalog[key]["dept"] = dept
            if tax_group is not None:
                self.catalog[key]["taxGroup"] = tax_group
        elif action == "deactivate":
            self.catalog[key]["active"] = False

    def _write_rej(self, store_id: str, change_id: str, error_code: str, message: str):
        rej_xml = (
            f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<ChangeReject changeId="{change_id}" storeId="{store_id}" '
            f'processed="{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}" '
            f'errorCode="{error_code}" message="{message}"/>\n'
        )
        self._atomic_write_outbox(f"REJ_{store_id}_{change_id}.xml", rej_xml)

    def trigger_reemit(self, target_name: str | None = None):
        """Re-emit an already sent TLOG file to demonstrate duplicate/idempotency handling."""
        with self.lock:
            tlogs = [f for f in self.emitted_files if f.startswith("TLOG_")]
        if not tlogs:
            self.logger.warning("No TLOG files emitted yet to re-emit.")
            return
        chosen = target_name if target_name else tlogs[-1]
        src = self.source_outbox / chosen
        if not src.exists():
            self.logger.warning(f"Source file {chosen} not found.")
            return
        # Touch mtime so file watchers detect a fresh event on the duplicate file
        tmp_path = self.live_outbox / f"{chosen}.tmp"
        final_path = self.live_outbox / chosen
        shutil.copyfile(src, tmp_path)
        os.utime(tmp_path, None)
        tmp_path.replace(final_path)
        self.logger.info(f"DEMO TRIGGER: Re-emitted duplicate file outbox/{chosen}")

    def trigger_corrupt(self):
        """Emit a damaged XML file to demonstrate quarantine handling."""
        filename = f"TLOG_BL01_CORRUPT_{int(time.time())}.xml"
        broken_content = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<TransactionLog formatVersion="2.1" storeId="BL01" businessDate="2026-10-14" batchSeq="9999">\n'
            '  <Transaction seq="999999" type="SALE" status="COMPLETED"\n'
            '  <!-- TRUNCATED / CORRUPT STREAM -->'
        )
        self._atomic_write_outbox(filename, broken_content)
        self.logger.info(f"DEMO TRIGGER: Emitted damaged file outbox/{filename}")

    def interactive_cli(self):
        print("\n--- Hub Simulator Commands: [reemit] | [corrupt] | [status] | [quit] ---")
        while not self.stop_event.is_set():
            try:
                cmd = input().strip().lower()
            except EOFError:
                break
            if cmd == "reemit":
                self.trigger_reemit()
            elif cmd == "corrupt":
                self.trigger_corrupt()
            elif cmd == "status":
                with self.lock:
                    count = len(self.emitted_files)
                print(f"Emitted files: {count} | Applied changeIds: {len(self.applied_change_ids)}")
            elif cmd in ("quit", "exit"):
                self.stop_event.set()
                break


def main():
    parser = argparse.ArgumentParser(description="Brightleaf Market In-Store Hub Simulator")
    parser.add_argument("--source", default="../data_package", help="Path to read-only data package")
    parser.add_argument("--runtime", default="../runtime_hub", help="Path to live inbox/outbox directory")
    parser.add_argument(
        "--speed",
        type=float,
        default=1440.0,
        help="Replay speed multiplier (1440 = 1 business day per minute; 0 = instant burst)",
    )
    parser.add_argument(
        "--max-delay",
        type=float,
        default=1.5,
        help="Max seconds to wait between consecutive files during replay",
    )
    args = parser.parse_args()

    sim = HubSimulator(Path(args.source).resolve(), Path(args.runtime).resolve(), args.speed, args.max_delay)

    t_replay = threading.Thread(target=sim.replay_loop, daemon=True)
    t_inbox = threading.Thread(target=sim.inbox_poll_loop, daemon=True)
    t_replay.start()
    t_inbox.start()

    try:
        sim.interactive_cli()
    except KeyboardInterrupt:
        sim.stop_event.set()

    sim.logger.info("Hub Simulator stopped.")


if __name__ == "__main__":
    main()