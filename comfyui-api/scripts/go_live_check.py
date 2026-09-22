#!/usr/bin/env python3
"""
Go-Live Readiness & Security Audit Verification Script for comfyui-api.
Runs end-to-end integrity checks on schema, configuration, routes, SDK, and daemon bridge.
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

# Ensure UTF-8 output on Windows consoles
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


class ReadinessAuditor:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.warnings = 0
        self.checks = []

    def report(self, name: str, success: bool, message: str = "", is_warn: bool = False):
        if success:
            self.passed += 1
            status_str = "[PASS]"
        elif is_warn:
            self.warnings += 1
            status_str = "[WARN]"
        else:
            self.failed += 1
            status_str = "[FAIL]"

        print(f"  {status_str} {name}: {message}")
        self.checks.append({"name": name, "success": success, "warning": is_warn, "message": message})

    def check_file_inventory(self):
        print("\n>> 1. File Structure & Component Inventory:")
        required_files = [
            "deploy/d1/schema.sql",
            "deploy/workers/src/worker.js",
            "deploy/workers/wrangler.toml",
            "deploy/frontend/index.html",
            "deploy/frontend/style.css",
            "deploy/frontend/app.js",
            "bridge/comfy_worker_daemon.py",
            "bridge/workflow_adapter.py",
            "client/comfyui_api_client.py",
            "package.json",
            "pyproject.toml",
            "requirements.txt",
            ".env.example",
            ".github/workflows/ci.yml",
            ".github/workflows/deploy.yml",
            "README.md",
        ]

        for rel_path in required_files:
            p = ROOT_DIR / rel_path
            if p.exists() and p.stat().st_size > 0:
                self.report(rel_path, True, f"Found ({p.stat().st_size} bytes)")
            else:
                self.report(rel_path, False, "Missing or empty file")

    def check_database_schema(self):
        print("\n>> 2. D1 SQL Schema Validation:")
        schema_path = ROOT_DIR / "deploy" / "d1" / "schema.sql"
        if not schema_path.exists():
            self.report("D1 Schema File", False, "deploy/d1/schema.sql missing")
            return

        sql_content = schema_path.read_text(encoding="utf-8")
        try:
            # Test executing schema against an in-memory SQLite database
            conn = sqlite3.connect(":memory:")
            conn.executescript(sql_content)

            # Check expected tables
            cursor = conn.cursor()
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
            tables = {row[0] for row in cursor.fetchall()}

            expected_tables = {"jobs", "workflows", "gpu_nodes", "job_logs", "api_keys"}
            missing_tables = expected_tables - tables

            if not missing_tables:
                self.report("SQLite Schema Execution", True, f"Created tables: {', '.join(sorted(tables))}")
            else:
                self.report("SQLite Schema Tables", False, f"Missing tables: {missing_tables}")

            # Verify indexes
            cursor.execute("SELECT name FROM sqlite_master WHERE type='index';")
            indexes = {row[0] for row in cursor.fetchall()}
            self.report("Performance Indexes", len(indexes) >= 4, f"Found {len(indexes)} indexes")

            conn.close()
        except Exception as e:
            self.report("D1 Schema Syntax", False, f"SQL error: {e}")

    def check_wrangler_config(self):
        print("\n>> 3. Wrangler Deployment Config:")
        wrangler_path = ROOT_DIR / "deploy" / "workers" / "wrangler.toml"
        if not wrangler_path.exists():
            self.report("wrangler.toml", False, "Missing wrangler.toml")
            return

        content = wrangler_path.read_text(encoding="utf-8")
        self.report("Worker Name", 'name = "comfyui-api"' in content, "Worker name set to comfyui-api")
        self.report("D1 Binding", 'database_name = "comfyui_api_db"' in content, "Database bound to comfyui_api_db")
        self.report("Scheduled Cron", 'crons =' in content, "Scheduled lease maintenance cron enabled")

    def check_python_modules(self):
        print("\n>> 4. Python SDK & Bridge Module Resolution:")
        try:
            from bridge.workflow_adapter import adapt_workflow
            from bridge.comfy_worker_daemon import ComfyWorkerDaemon
            from client.comfyui_api_client import ComfyUIClient, AsyncComfyUIClient

            self.report("Workflow Adapter Import", True, "Successfully imported adapt_workflow")
            self.report("Worker Daemon Import", True, "Successfully imported ComfyWorkerDaemon")
            self.report("Client SDK Import", True, "Successfully imported ComfyUIClient & AsyncComfyUIClient")

            # Quick sanity test on workflow adapter
            sample_wf = {
                "1": {"class_type": "KSampler", "inputs": {"seed": 100, "steps": 20, "cfg": 7.0}},
                "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "hello"}, "_meta": {"title": "Prompt"}},
            }
            adapted, seed = adapt_workflow(sample_wf, {"prompt": "neon cyber city", "seed": 7777, "steps": 30})
            self.report(
                "Adapter Parameter Override",
                seed == 7777 and adapted["1"]["inputs"]["steps"] == 30 and adapted["2"]["inputs"]["text"] == "neon cyber city",
                "Prompt, seed, and step overrides verified",
            )
        except Exception as e:
            self.report("Python Module Imports", False, f"Import/runtime error: {e}")

    def check_worker_test_suite(self):
        print("\n>> 5. Worker API Test Suite Execution:")
        try:
            res = subprocess.run(["node", "tests/test_worker_api.js"], cwd=str(ROOT_DIR), capture_output=True, text=True)
            if res.returncode == 0 and "ALL 12 WORKER API TESTS PASSED" in res.stdout:
                self.report("Worker JS Test Suite", True, "12/12 Cloudflare Worker tests passed")
            else:
                self.report("Worker JS Test Suite", False, f"Worker tests failed:\n{res.stderr or res.stdout}")
        except Exception as e:
            self.report("Node Test Runner", False, f"Error launching node: {e}")

    def run_all(self):
        print("=" * 68)
        print("       COMFYUI-API GO-LIVE READINESS & VERIFICATION AUDIT       ")
        print("=" * 68)

        self.check_file_inventory()
        self.check_database_schema()
        self.check_wrangler_config()
        self.check_python_modules()
        self.check_worker_test_suite()

        print("\n" + "=" * 68)
        total = self.passed + self.failed
        print(f"Audit Summary: {self.passed}/{total} checks PASSED | {self.warnings} Warnings | {self.failed} Failures")
        if self.failed == 0:
            print("[SUCCESS] ALL GO-LIVE READINESS CRITERIA SATISFIED! SYSTEM IS READY FOR PRODUCTION.")
        else:
            print(f"[FAILED] {self.failed} CHECKS FAILED. RESOLVE ISSUES BEFORE PROD DEPLOYMENT.")
        print("=" * 68 + "\n")
        return self.failed == 0


if __name__ == "__main__":
    auditor = ReadinessAuditor()
    success = auditor.run_all()
    sys.exit(0 if success else 1)
