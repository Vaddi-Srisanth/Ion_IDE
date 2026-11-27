/** Ion-owned pytest plugin. Written only to a private operation directory; never imported before approval. */
export const pytestHelper = String.raw`import json, os, pathlib, sys, time

request_path, report_path = sys.argv[1:3]
with open(request_path, encoding="utf-8") as stream:
    request = json.load(stream)
root = pathlib.Path(request["root"]).resolve()
operation = request["operation"]
nodes, reports, errors, identities = [], {}, [], {}
started = time.monotonic()
report_stream = open(report_path, "xb")
written = 0

def emit(value):
    global written
    data = json.dumps(value, ensure_ascii=False).encode("utf-8") + b"\n"
    if written + len(data) > 2 * 1024 * 1024 - 512:
        raise RuntimeError("Ion test report exceeded 2 MiB.")
    report_stream.write(data)
    report_stream.flush()
    written += len(data)

def clipped(value, limit=2048):
    return str(value).replace("\x00", "").encode("utf-8", errors="replace")[:limit].decode("utf-8", errors="ignore")

def location(item):
    path = pathlib.Path(str(item.path)).resolve()
    relative = path.relative_to(root).as_posix()
    return {"path": relative, "line": int(item.location[1]) + 1}

class IonPlugin:
    def pytest_collection_finish(self, session):
        if len(session.items) > 1000:
            raise RuntimeError("Ion test collection exceeds 1000 cases.")
        for item in session.items:
            loc = location(item)
            selector = str(item.nodeid)
            # pytest's rootdir can be an ancestor. Rebuild the file portion from the verified location.
            suffix = selector[selector.index("::"):] if "::" in selector else ""
            nodes.append({"selector": loc["path"] + suffix, "label": clipped(item.name), "location": loc})
            identities[selector] = nodes[-1]
        emit({"kind": "collection", "nodes": nodes})

    def pytest_collectreport(self, report):
        if report.failed:
            if len(errors) < 16:
                errors.append(clipped(report.longrepr))

    def pytest_runtest_logreport(self, report):
        raw = str(report.nodeid)
        # All selected nodes have already been validated by collection_finish.
        matched = identities.get(raw)
        if matched is None:
            if len(errors) < 16:
                errors.append("Unrecognized pytest result identity.")
            return
        key = matched["selector"]
        row = reports.setdefault(key, {"selector": key, "outcome": "passed", "durationMs": 0,
                                      "message": "", "output": "", "location": matched["location"], "finished": False})
        row["durationMs"] += max(0, round(report.duration * 1000))
        if report.failed:
            row["outcome"] = "failed" if report.when == "call" else "error"
            row["message"] = clipped(report.longrepr)
        elif report.skipped and row["outcome"] == "passed":
            row["outcome"] = "skipped"
            row["message"] = clipped(getattr(report, "wasxfail", report.longrepr))
        elif getattr(report, "wasxfail", None) and row["outcome"] == "passed":
            row["message"] = "Unexpected pass (xfail): " + clipped(report.wasxfail, 1900)
        row["output"] = clipped(getattr(report, "capstdout", "") + getattr(report, "capstderr", ""))
        if report.when == "teardown":
            row["finished"] = True
            emit({"kind": "case", "case": row})

exit_code = 3
try:
    import pytest
    args = ["--rootdir=" + str(root), "-p", "no:cacheprovider", "-o", "addopts=", "--color=no", "-q"]
    if operation == "discover":
        args.append("--collect-only")
        args.extend(["--", str(root)])
    else:
        args.append("--")
        for selector in request["selectors"]:
            file, separator, suffix = selector.partition("::")
            candidate = (root / file).resolve()
            candidate.relative_to(root)
            args.append(str(candidate) + (separator + suffix if separator else ""))
    exit_code = int(pytest.main(args, plugins=[IonPlugin()]))
except BaseException as error:
    errors.append(clipped(type(error).__name__ + ": " + str(error)))
finally:
    value = {"kind": "complete", "version": 1, "complete": True, "exitCode": exit_code,
             "durationMs": round((time.monotonic() - started) * 1000),
             "errors": errors[:16]}
    try:
        emit(value)
    except BaseException:
        report_stream.write(b'{"kind":"complete","version":1,"complete":true,"exitCode":3,"durationMs":0,"errors":["Test report exceeded its limit."]}\n')
        exit_code = 3
    report_stream.close()
sys.exit(exit_code)
`
