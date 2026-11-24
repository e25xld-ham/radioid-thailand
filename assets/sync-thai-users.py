#!/usr/bin/env python3
"""Maintain a Thai RadioID users.json locally. Run with Python 3.8+."""
import argparse
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.request import Request, urlopen

SOURCE = "https://www.radioid.net/static/users.json"


def read_database(stream):
    data = json.load(stream)
    users = data["users"]
    if not isinstance(users, list) or not users:
        raise ValueError("Expected a nonempty RadioID users array")
    for row in users:
        int(row["id"])
        if not isinstance(row["callsign"], str) or not row["callsign"].strip():
            raise ValueError("Invalid RadioID callsign")
    return data


def write_json(path, data):
    fd, temp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=True, separators=(",", ":"))
            out.write("\n")
        os.chmod(temp, path.stat().st_mode & 0o777 if path.exists() else 0o644)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def merge(data, additions):
    users = [row for row in data["users"] if re.fullmatch(r"520[0-9]{4}", str(row["id"]))]
    data["users"] = users
    ids = {int(row["id"]): row["callsign"].strip().upper() for row in users}
    for row in additions:
        radio_id = row["id"]
        if not 5200000 <= radio_id <= 5209999:
            continue
        if radio_id in ids:
            if ids[radio_id] != row["callsign"]:
                raise ValueError(f"DMR ID {radio_id} already belongs to {ids[radio_id]}")
            continue
        users.append(row)
        ids[radio_id] = row["callsign"]
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, default=Path("users.json"))
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("sync", help="Download RadioID and keep local additions")
    add = commands.add_parser("add", help="Add an approved RadioID entry immediately")
    add.add_argument("id", type=int)
    add.add_argument("callsign")
    add.add_argument("name")
    add.add_argument("--city", default="")
    add.add_argument("--state", default="")
    add.add_argument("--country", default="Thailand")
    args = parser.parse_args()

    target = args.file.resolve()
    overrides = target.with_name("manual-users.json")
    if os.name == "nt":
        import msvcrt
    else:
        import fcntl
    with target.with_name(f".{target.name}.lock").open("a+b") as lock:
        if os.name == "nt":
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(lock, fcntl.LOCK_EX)
        additions = []
        if overrides.exists():
            with overrides.open(encoding="utf-8") as stream:
                additions = read_database(stream)["users"]
        if args.command == "sync":
            request = Request(SOURCE, headers={"User-Agent": "ThaiRadioIDDownloader/1.0 (https://github.com/e25xld-ham/radioid-thailand)"})
            with urlopen(request, timeout=60) as response:
                data = read_database(response)
            if sum(bool(re.fullmatch(r"520[0-9]{4}", str(row["id"]))) for row in data["users"]) < 100:
                raise ValueError("RadioID snapshot appears incomplete")
            write_json(target, merge(data, additions))
        else:
            call = args.callsign.strip().upper()
            name = args.name.strip()
            if not 5200000 <= args.id <= 5209999 or not re.fullmatch(r"[A-Z0-9]{3,12}", call) or not name:
                parser.error("Provide a valid DMR ID, callsign, and name")
            row = dict(name=name, fname=name, surname="", country=args.country,
                       callsign=call, city=args.city, radio_id=args.id, id=args.id,
                       state=args.state, has_valid_callsign="1", has_valid_email=0,
                       account_unvalidated=0, account_validation_status="validated")
            if any(previous["id"] == args.id and previous["callsign"] != call for previous in additions):
                raise ValueError(f"Conflicting local entry for DMR ID {args.id}")
            additions = [previous for previous in additions if previous["id"] != args.id]
            additions.append(row)
            with target.open(encoding="utf-8") as stream:
                data = merge(read_database(stream), additions)
            additions = [entry for entry in additions if 5200000 <= entry["id"] <= 5209999]
            write_json(overrides, {"users": additions})
            write_json(target, data)
        print(f"{target}: {len(data['users']):,} entries")


if __name__ == "__main__":
    main()
