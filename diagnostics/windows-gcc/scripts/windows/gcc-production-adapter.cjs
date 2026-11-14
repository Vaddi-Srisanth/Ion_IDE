var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// <stdin>
var stdin_exports = {};
__export(stdin_exports, {
  InteractiveRunner: () => InteractiveRunner,
  configureWindowsProcessHelper: () => configureWindowsProcessHelper,
  defaultRunLimits: () => defaultRunLimits,
  execute: () => execute
});
module.exports = __toCommonJS(stdin_exports);

// src/main/runner.ts
var import_node_child_process = require("node:child_process");
var import_node_string_decoder = require("node:string_decoder");

// src/main/windows-process.ts
var import_node_path = require("node:path");
var import_node_os = require("node:os");
var systemRoot = process.env.SystemRoot || "C:\\Windows";
var windowsSystemDirectory = (0, import_node_path.join)(systemRoot, "System32");
function windowsToolPaths() {
  return [.../* @__PURE__ */ new Set([
    ...(process.env.PATH ?? "").split(import_node_path.delimiter).map((path) => path.replace(/^"(.*)"$/, "$1")),
    windowsSystemDirectory
  ])].filter((path) => /^[a-z]:[/\\]/i.test(path) && !/[/\\]WindowsApps(?:[/\\]|$)/i.test(path));
}
function processTempEnvironment(scratch) {
  return process.platform === "win32" ? { TEMP: scratch, TMP: scratch } : { TMPDIR: scratch };
}
function windowsEnvironment(paths, scratch) {
  return {
    PATH: paths.join(import_node_path.delimiter),
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    HOME: (0, import_node_os.homedir)(),
    USERPROFILE: (0, import_node_os.homedir)(),
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    ...scratch ? processTempEnvironment(scratch) : {}
  };
}
var helperKey = () => /* @__PURE__ */ Symbol.for("ion.ide.trusted-windows-process-helper");
function configureWindowsProcessHelper(path) {
  if (!(0, import_node_path.isAbsolute)(path) || path.includes("\0")) throw new Error("Invalid Windows process helper path.");
  Object.defineProperty(globalThis, helperKey(), { value: path, writable: true, enumerable: false });
}
function windowsPipeCommand(executable, args) {
  const configured = Reflect.get(globalThis, helperKey());
  const helper = (typeof configured === "string" ? configured : void 0) ?? (!process.versions.electron ? process.env.ION_WINDOWS_PROCESS_TEST_HELPER : void 0);
  if (!helper || !(0, import_node_path.isAbsolute)(helper)) throw new Error("The Windows process helper is unavailable. Repair or reinstall Ion.");
  return { executable: helper, args: ["--pipe", String(process.pid), executable, ...args] };
}
function monitorWindowsPipeProcess(child, onFailure, trace) {
  const status = child.stdio[3];
  if (!status) return {
    finished: Promise.resolve(false),
    verified: false,
    detail: "The Windows process supervisor status channel is unavailable.",
    requestStop: () => Promise.resolve(false),
    markForced() {
    },
    dispose() {
    }
  };
  const control = child.stdio[4];
  let stopRequest;
  let buffered = "";
  let ready = false;
  let cleaned = false;
  let forced = false;
  let closed = false;
  let detail;
  let complete;
  const finished = new Promise((resolve) => {
    complete = resolve;
  });
  const verified = () => closed && ready && cleaned && !forced && !detail && !buffered;
  function fail(message) {
    if (detail) return;
    detail = message;
    onFailure(message);
  }
  function data(text) {
    if (detail || closed) return;
    buffered += text;
    if (buffered.length > 4096) return fail("The Windows process supervisor returned invalid status.");
    for (; ; ) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      if (!ready && /^READY [1-9][0-9]{0,9}$/.test(line)) {
        ready = true;
        trace?.("compiler-payload", "ready-observed", Number(line.slice(6)));
      } else if (ready && !cleaned && line === "CLEAN") {
        cleaned = true;
        trace?.("compiler-job", "clean-observed");
      } else return fail(/^ERROR [0-9]{1,10}$/.test(line) ? "The Windows process supervisor failed (" + line.slice(6) + ")." : "The Windows process supervisor returned invalid status.");
    }
  }
  const error = () => fail("The Windows process supervisor status channel stopped.");
  status.setEncoding("utf8");
  status.on("data", data);
  status.on("error", error);
  child.once("close", () => {
    closed = true;
    if (buffered) detail ??= "The Windows process supervisor status ended mid-message.";
    status.removeListener("data", data);
    status.removeListener("error", error);
    complete(verified());
  });
  function force() {
    if (closed || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (!child.kill("SIGKILL")) return;
    } catch {
    }
    forced = true;
    detail ??= "The Windows process supervisor did not acknowledge Stop; cleanup is unverified.";
  }
  function requestStop() {
    if (stopRequest) return stopRequest;
    if (closed) return finished;
    stopRequest = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(grace);
        clearTimeout(bound);
        resolve(value);
      };
      const grace = setTimeout(force, 3500);
      const bound = setTimeout(() => {
        force();
        finish(false);
      }, 4e3);
      grace.unref();
      bound.unref();
      void finished.then(finish);
      if (!control || control.destroyed || !control.writable) force();
      else control.write("S\n", (error2) => {
        if (error2) force();
      });
    });
    return stopRequest;
  }
  const controlError = () => {
    if (!closed) force();
  };
  control?.on("error", controlError);
  child.once("close", () => control?.removeListener("error", controlError));
  return {
    finished,
    requestStop,
    get verified() {
      return verified();
    },
    get detail() {
      return detail;
    },
    markForced() {
      forced = true;
    },
    dispose() {
      if (!closed) forced = true;
      status.destroy();
      control?.destroy();
    }
  };
}

// src/main/runner.ts
var maxInputBytes = 64 * 1024;
var defaultRunLimits = { compileMs: 15e3, programMs: 5e3, outputBytes: 256 * 1024 };
var cBinaryName = process.platform === "win32" ? "program.exe" : "program";
function execute(executable, args, options) {
  if (options.signal.aborted) return Promise.resolve({ state: "cancelled", exitCode: null, output: "" });
  return new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    let command;
    options.trace?.("compiler-command", "construct-start");
    try {
      if (!grouped) command = windowsPipeCommand(executable, args);
    } catch (error) {
      options.trace?.("compiler-command", "construct-error");
      resolve({ state: "error", exitCode: null, output: "", detail: error instanceof Error ? error.message : "Windows process helper unavailable." });
      return;
    }
    options.trace?.("compiler-command", "constructed", !!command);
    options.trace?.("compiler-process", "spawn-request");
    const child = (0, import_node_child_process.spawn)(command?.executable ?? executable, command?.args ?? args, {
      cwd: options.cwd,
      env: options.environment,
      stdio: command ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      detached: grouped,
      shell: false,
      windowsHide: true
    });
    if (options.trace) child.once("spawn", () => options.trace?.("compiler-process", "spawned", child.pid));
    const stdout = new import_node_string_decoder.StringDecoder();
    const stderr = new import_node_string_decoder.StringDecoder();
    const chunks = [];
    const stdoutChunks = options.splitOutput ? [] : void 0;
    const stderrChunks = options.splitOutput ? [] : void 0;
    let state = "exited";
    let guard;
    let finished = false;
    let detail;
    let exitSignal = null;
    let termination;
    const streamTrace = options.trace ? { stdout: void 0, stderr: void 0, ended: 0 } : void 0;
    function dataReceived(stream) {
      if (!streamTrace) return;
      const enteredAt = performance.now();
      if (streamTrace[stream] === void 0) options.trace?.("compiler-" + stream, "first-callback", enteredAt);
      streamTrace[stream] = enteredAt;
    }
    function streamEnded(stream) {
      if (!streamTrace) return;
      if (streamTrace[stream] !== void 0) options.trace?.("compiler-" + stream, "last-callback", streamTrace[stream]);
      streamTrace.ended |= stream === "stdout" ? 1 : 2;
      options.trace?.("compiler-" + stream, "end");
    }
    function killGroup() {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, "SIGKILL");
        else if (child.exitCode === null && child.signalCode === null) {
          termination ??= ownership?.requestStop() ?? Promise.resolve(false);
        }
      } catch {
      }
    }
    function finish(exitCode, signal, outputComplete = true) {
      if (finished) return;
      finished = true;
      if (ownership && !ownership.verified) {
        if (state === "exited") state = "error";
        detail ??= ownership.detail ?? "The Windows process exited without verified descendant cleanup.";
        outputComplete = false;
      }
      ownership?.dispose();
      clearTimeout(timer);
      clearTimeout(guard);
      options.signal.removeEventListener("abort", cancel);
      if (streamTrace) for (const stream of ["stdout", "stderr"]) {
        if (!(streamTrace.ended & (stream === "stdout" ? 1 : 2))) {
          if (streamTrace[stream] !== void 0) options.trace?.("compiler-" + stream, "last-callback", streamTrace[stream]);
          options.trace?.("compiler-" + stream, "destroy-before-end");
        }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      append(stdout.end(), stdoutChunks);
      append(stderr.end(), stderrChunks);
      const result = {
        state,
        exitCode,
        output: chunks.join(""),
        detail: detail ?? signal ?? exitSignal ?? void 0,
        stdout: stdoutChunks?.join(""),
        stderr: stderrChunks?.join(""),
        outputComplete: outputComplete && state !== "output-limit",
        signal: signal ?? exitSignal ?? void 0
      };
      options.trace?.("compiler-process", "cleanup", result.outputComplete);
      options.trace?.("compiler-process", "result-finalized", result.state);
      resolve(result);
    }
    function stop(reason) {
      if (state !== "exited") return;
      state = reason;
      options.trace?.("compiler-process", "stop", reason);
      killGroup();
      if (ownership) {
        void termination?.then(() => {
          if (!finished) finish(child.exitCode, child.signalCode, ownership.verified);
        });
      } else {
        guard = setTimeout(() => finish(null, void 0, false), 250);
      }
    }
    function cancel() {
      stop("cancelled");
    }
    function append(text, stream) {
      if (!text) return;
      if (!options.interactive && options.collectOutput !== false) chunks.push(text);
      stream?.push(text);
      options.onOutput?.(text);
    }
    function collect(data, decoder, stream) {
      if (state !== "exited") return;
      const count = Math.min(data.length, options.budget.remaining);
      options.trace?.("compiler-output", "bytes", count);
      if (count > 0) append(decoder.write(data.subarray(0, count)), stream);
      options.budget.remaining -= count;
      if (count < data.length) stop("output-limit");
    }
    const ownership = command ? monitorWindowsPipeProcess(child, (message) => {
      detail = message;
      stop("error");
    }, options.trace) : void 0;
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    options.signal.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk) => {
      if (streamTrace) dataReceived("stdout");
      collect(chunk, stdout, stdoutChunks);
    });
    child.stderr.on("data", (chunk) => {
      if (streamTrace) dataReceived("stderr");
      collect(chunk, stderr, stderrChunks);
    });
    if (options.trace) {
      child.stdout.once("end", () => streamEnded("stdout"));
      child.stderr.once("end", () => streamEnded("stderr"));
    }
    child.stdin.on("error", () => void 0);
    child.once("error", (error) => {
      options.trace?.("compiler-process", "error-callback");
      if (state === "exited") state = "error";
      detail = error.message;
      finish(null);
    });
    child.once("exit", (code, signal) => {
      options.trace?.("compiler-process", "exit", code);
      options.trace?.("compiler-process", "exit-callback", code);
      exitSignal = signal;
      killGroup();
      if (guard) return;
      clearTimeout(timer);
      guard = setTimeout(() => finish(code, signal, false), 250);
    });
    child.once("close", (code, signal) => {
      options.trace?.("compiler-process", "close", code);
      finish(code, signal);
    });
    if (options.interactive) {
      child.once("spawn", () => {
        if (state !== "exited" || finished) return;
        options.interactive((text) => {
          if (state !== "exited" || finished || !child.stdin.writable) return false;
          if (text === null) child.stdin.end();
          else {
            if (child.stdin.writableLength + Buffer.byteLength(text) > maxInputBytes) return false;
            child.stdin.write(text);
          }
          return true;
        });
      });
    } else child.stdin.end(options.input);
  });
}
function rejectedRun(message) {
  return {
    status: "rejected",
    message,
    compiler: null,
    compileOutput: "",
    programOutput: "",
    exitCode: null,
    durationMs: 0
  };
}

// src/main/run-console/line-console.ts
var maxLineLength = 16 * 1024;
function startLineConsole(options) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  let write;
  let line = "";
  let endsWithCarriageReturn = false;
  const result = execute(options.executable, options.args, {
    cwd: options.cwd,
    input: "",
    environment: options.environment,
    signal,
    timeoutMs: options.timeoutMs,
    budget: options.budget,
    interactive(send) {
      write = send;
      options.ready();
    },
    onOutput(text) {
      const output = text.replace(/(?<!\r)\n/g, "\r\n");
      options.onOutput(endsWithCarriageReturn && text.startsWith("\n") ? output.slice(1) : output);
      endsWithCarriageReturn = text.endsWith("\r");
    }
  }).then((outcome) => {
    write = void 0;
    line = "";
    return { ...outcome, outputComplete: outcome.outputComplete ?? true };
  });
  return {
    result,
    resize() {
    },
    input(data) {
      if (!write || signal.aborted) return;
      let echo = "";
      const text = data.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)?/g, "").replace(/\r\n/g, "\n");
      let pending = line;
      for (const character of text) {
        if (character === "" || character === "" || character === "") break;
        if (character === "\r" || character === "\n") pending = "";
        else if (character === "\x7F" || character === "\b") {
          const pair = (pending.codePointAt(pending.length - 2) ?? 0) > 65535;
          pending = pending.slice(0, pair ? -2 : -1);
        } else if (character >= " " && !/[\u0080-\u009f]/.test(character)) {
          if (pending.length + character.length > maxLineLength) throw new Error(`Input was not sent: line input supports at most ${maxLineLength} characters.`);
          pending += character;
        }
      }
      for (const character of text) {
        if (character === "") {
          controller.abort();
          break;
        }
        if (character === "" || character === "") {
          if (line && !write(line)) throw new Error("Input could not be sent: the program input buffer is busy.");
          line = "";
          write(null);
          write = void 0;
          break;
        }
        if (character === "\r" || character === "\n") {
          if (!write(line + "\n")) throw new Error("Input could not be sent: the program input buffer is busy.");
          echo += "\r\n";
          line = "";
        } else if (character === "\x7F" || character === "\b") {
          if (line) {
            const pair = (line.codePointAt(line.length - 2) ?? 0) > 65535;
            line = line.slice(0, pair ? -2 : -1);
            echo += "\b \b";
          }
        } else if (character >= " " && !/[\u0080-\u009f]/.test(character) && line.length + character.length <= maxLineLength) {
          line += character;
          echo += character;
        }
      }
      if (echo) options.onOutput(echo);
    }
  };
}

// src/main/run-console/pty.ts
var import_node_child_process2 = require("node:child_process");
var import_node_string_decoder2 = require("node:string_decoder");
var maxFrameBytes = 16 * 1024;
var maxPendingBytes = 64 * 1024;
function startPty(options) {
  if (options.signal.aborted) {
    return {
      input: () => {
      },
      resize: () => {
      },
      pauseOutput: () => {
      },
      resumeOutput: () => {
      },
      writeInput: () => Promise.reject(new Error("The terminal session has closed.")),
      result: Promise.resolve({ state: "cancelled", exitCode: null, outputComplete: true })
    };
  }
  const shell = "shell" in options;
  const windows = process.platform === "win32";
  const mode = shell ? ["--shell"] : [];
  options.trace?.("pty", "spawn-request");
  const child = (0, import_node_child_process2.spawn)(options.helper, [String(options.columns), String(options.rows), ...mode, options.executable, ...options.args], {
    cwd: options.cwd,
    env: { ...options.environment, TERM: "xterm-256color", COLORTERM: "truecolor" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  if (options.trace) child.once("spawn", () => options.trace?.("pty", "spawned", child.pid));
  const decoder = new import_node_string_decoder2.StringDecoder();
  let state = "exited";
  let programPid;
  let guard;
  let helperLine = "";
  let earlyOutput = "";
  let outputComplete = true;
  let detail;
  let unavailable = false;
  let started = false;
  let finished = false;
  let lastSize = [options.columns, options.rows];
  function collect(text) {
    if (!text) return;
    if (started) {
      options.trace?.("program-output", "forwarded", text.length);
      options.onOutput(text);
    } else {
      earlyOutput += text;
      if (shell) child.stdout.pause();
    }
  }
  function stop(reason) {
    if (state !== "exited" || finished) return;
    state = reason;
    options.trace?.("pty", "stop", reason);
    if (reason === "output-limit") outputComplete = false;
    if (windows) child.stdin.end(Buffer.from([83, 0, 0]));
    else child.kill("SIGTERM");
    if (shell) child.stdout.resume();
    guard = setTimeout(() => {
      if (windows && child.exitCode === null && child.signalCode === null) outputComplete = false;
      if (!windows && programPid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-programPid, "SIGKILL");
        } catch {
        }
      }
      child.kill("SIGKILL");
    }, windows ? 3500 : 1e3);
  }
  const abort = () => stop("cancelled");
  const timer = !shell ? setTimeout(() => stop("timeout"), options.timeoutMs) : void 0;
  options.signal.addEventListener("abort", abort, { once: true });
  function send(opcode, bytes, written) {
    if (!started || finished || state !== "exited" || !child.stdin.writable) return false;
    if (child.stdin.writableLength + bytes.length + 3 > maxPendingBytes) return false;
    const frame = Buffer.allocUnsafe(bytes.length + 3);
    frame[0] = opcode;
    frame.writeUInt16BE(bytes.length, 1);
    bytes.copy(frame, 3);
    child.stdin.write(frame, written);
    if (opcode === 68) options.trace?.("stdin", "queued-bytes", bytes.length);
    return true;
  }
  child.stdin.on("error", () => {
  });
  child.stdout.on("data", (bytes) => {
    if (finished) return;
    options.trace?.("program-output", "received-bytes", bytes.length);
    if (shell) {
      if (state === "exited") collect(decoder.write(bytes));
      return;
    }
    const count = Math.min(bytes.length, options.budget.remaining);
    if (count > 0) collect(decoder.write(bytes.subarray(0, count)));
    options.budget.remaining -= count;
    if (count < bytes.length) {
      outputComplete = false;
      stop("output-limit");
    }
  });
  if (shell) child.stdout.pause();
  child.stderr.on("data", (bytes) => {
    helperLine += bytes.toString("utf8");
    for (; ; ) {
      const newline = helperLine.indexOf("\n");
      if (newline < 0) break;
      const line = helperLine.slice(0, newline).replace(/\r$/, "");
      helperLine = helperLine.slice(newline + 1);
      if (line === "INCOMPLETE") outputComplete = false;
      if (windows && line === "UNAVAILABLE" && !started) unavailable = true;
      if (windows && /^ERROR \d+$/.test(line)) {
        detail = "Windows could not start the pseudoconsole (code " + line.slice(6) + ").";
      }
      const ready = /^READY ([1-9]\d*)$/.exec(line);
      if (ready && !started) {
        programPid = Number(ready[1]);
        started = true;
        options.trace?.("pty", "ready", programPid);
        if (state === "exited") {
          options.ready();
          if (lastSize[0] !== options.columns || lastSize[1] !== options.rows) resize(lastSize[0], lastSize[1]);
        }
        if (earlyOutput) {
          options.onOutput(earlyOutput);
          earlyOutput = "";
        }
      }
    }
    helperLine = helperLine.slice(-1024);
  });
  const result = new Promise((resolve) => {
    child.on("error", (error) => {
      if (state === "exited") state = "error";
      options.trace?.("pty", "spawn-error");
      if (windows && !started && error.code === "ENOENT") {
        unavailable = true;
        detail = "The Windows terminal helper is missing. Reinstall Ion from the Windows installer.";
      } else detail = error.message;
    });
    child.once("close", (exitCode, signal) => {
      options.trace?.("pty", "close", exitCode);
      finished = true;
      clearTimeout(timer);
      clearTimeout(guard);
      options.signal.removeEventListener("abort", abort);
      collect(decoder.end());
      if (earlyOutput) options.onOutput(earlyOutput);
      if (state === "exited" && !started) {
        state = "error";
        detail ??= unavailable ? "Windows pseudoconsole support is unavailable. Install a current Windows build of Ion on Windows 10 (1809 or later) or Windows 11." : shell ? "The terminal could not open a pseudoterminal." : "The Run Console could not open a pseudoterminal.";
      }
      options.trace?.("pty", "cleanup", outputComplete);
      resolve({
        state,
        exitCode,
        signal: state === "exited" ? signal ?? void 0 : void 0,
        outputComplete,
        detail,
        unavailable: unavailable && !started && state === "error"
      });
    });
  });
  function resize(columns, rows) {
    lastSize = [columns, rows];
    const size = Buffer.alloc(4);
    size.writeUInt16BE(columns, 0);
    size.writeUInt16BE(rows, 2);
    send(82, size);
  }
  return {
    input(data) {
      if (!started || finished || state !== "exited") return;
      if (data.length > maxFrameBytes) throw new Error("Input was not sent: send at most 16 KiB per terminal chunk.");
      const bytes = Buffer.from(data);
      if (bytes.length > maxFrameBytes) throw new Error("Input was not sent: send at most 16 KiB per terminal chunk.");
      if (bytes.length && !send(68, bytes, options.trace ? (error) => options.trace?.("stdin", error ? "write-error" : "written-bytes", bytes.length) : void 0)) {
        throw new Error("Input was not sent: the program input buffer is busy.");
      }
    },
    writeInput(data) {
      const bytes = Buffer.from(data);
      if (!bytes.length || bytes.length > maxFrameBytes) return Promise.reject(new Error("Send at most 16 KiB per terminal input chunk."));
      return new Promise((resolve, reject) => {
        if (!send(68, bytes, (error) => error ? reject(error) : resolve())) {
          reject(new Error("The terminal session is closed or its input buffer is busy."));
        }
      });
    },
    pauseOutput() {
      child.stdout.pause();
    },
    resumeOutput() {
      child.stdout.resume();
    },
    resize,
    result
  };
}

// src/main/run-console/engine.ts
var systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";
var interactiveLimits = { ...defaultRunLimits, programMs: 5 * 6e4 };
var maxCompileTimeMs = 2 * 6e4;
var batchBytes = 8192;
var batchDelayMs = 16;
function commandEnvironment(command, locale) {
  const defaults = process.platform === "win32" ? windowsEnvironment(windowsToolPaths()) : { PATH: systemPath, LANG: locale };
  return { ...defaults, ...command.environment };
}
function publisher(emit, trace) {
  let batch = "";
  let stream = "compiler";
  let timer;
  function send(update) {
    trace?.("publish-run-console", "dispatch-start", update.kind);
    try {
      emit(update);
    } catch {
    } finally {
      trace?.("publish-run-console", "dispatch-end", update.kind);
    }
  }
  function flush() {
    clearTimeout(timer);
    timer = void 0;
    if (!batch) return;
    const text = batch;
    batch = "";
    send({ kind: "data", text, stream });
  }
  return {
    phase(phase, label) {
      flush();
      send({ kind: "phase", phase, label });
    },
    output(kind, text) {
      if (kind !== stream) flush();
      stream = kind;
      batch += text;
      if (batch.length >= batchBytes) flush();
      else timer ??= setTimeout(flush, batchDelayMs);
    },
    flush
  };
}
var InteractiveRunner = class {
  constructor(helperPath, limits = interactiveLimits) {
    this.helperPath = helperPath;
    this.limits = limits;
  }
  helperPath;
  limits;
  active;
  columns = 80;
  rows = 24;
  run(plan, emit, signal, sourceStillCurrent, trace) {
    if (this.active) return Promise.resolve(rejectedRun("A program is already compiling or running."));
    const active = {};
    this.active = active;
    trace?.("engine", "start");
    return this.executePlan(plan, active, signal, emit, sourceStillCurrent, trace).finally(() => {
      this.active = void 0;
      trace?.("engine", "cleanup");
    });
  }
  input(data) {
    this.active?.terminal?.input(data);
  }
  resize(columns, rows) {
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 2 || columns > 512 || rows < 2 || rows > 512) return;
    this.columns = columns;
    this.rows = rows;
    this.active?.terminal?.resize(columns, rows);
  }
  async executePlan(plan, active, signal, emit, sourceStillCurrent, trace) {
    const start = performance.now();
    const budget = { remaining: this.limits.outputBytes };
    const publish = publisher(emit, trace);
    let compileOutput = "";
    let compileMs;
    let compileVerified;
    let stage = plan.compile ? "Compilation" : "Program";
    function result(status, message, detail = {}) {
      trace?.("result", status);
      return {
        status,
        message,
        compiler: plan.toolchain,
        compileOutput,
        compileMs,
        compileVerified,
        programOutput: "",
        exitCode: null,
        durationMs: Math.round(performance.now() - start),
        ...detail
      };
    }
    function failed(state, reason, detail = {}) {
      if (state === "cancelled") return result("cancelled", "Run stopped.", detail);
      if (state === "timeout") return result("timeout", stage + " exceeded its time limit.", detail);
      if (state === "output-limit") return result("output-limit", stage + " exceeded the combined output limit.", detail);
      return result(stage === "Compilation" ? "compile-error" : "runtime-error", stage + " failed (" + reason + ").", detail);
    }
    try {
      if (signal.aborted) return result("cancelled", "Run stopped.");
      trace?.("source-check-before-compile", "start");
      const sourceBeforeCompile = !sourceStillCurrent || await sourceStillCurrent();
      trace?.("source-check-before-compile", "end", sourceBeforeCompile);
      if (!sourceBeforeCompile) {
        return signal.aborted ? result("cancelled", "Run stopped.") : result("rejected", "The source or workspace changed. Review it and run again.");
      }
      if (signal.aborted) return result("cancelled", "Run stopped.");
      if (plan.compile) {
        publish.phase("compiling", plan.label);
        const compileStart = performance.now();
        trace?.("compile", "start");
        const compiled = await execute(plan.compile.executable, plan.compile.args, {
          cwd: plan.compile.cwd ?? plan.cwd,
          input: plan.compile.input ?? "",
          signal,
          timeoutMs: Math.min(maxCompileTimeMs, plan.compile.timeoutMs ?? this.limits.compileMs),
          budget,
          environment: commandEnvironment(plan.compile, "C"),
          onOutput: (text) => publish.output("compiler", text),
          trace
        });
        trace?.("compile", "end", compiled.state);
        compileMs = Math.round(performance.now() - compileStart);
        compileOutput = compiled.output;
        const detail2 = { exitCode: compiled.exitCode, outputComplete: compiled.outputComplete };
        if (compiled.state !== "exited" || compiled.exitCode !== 0) {
          return failed(compiled.state, compiled.detail ?? "exit code " + String(compiled.exitCode), detail2);
        }
        if (compiled.outputComplete === false) {
          return result("compile-error", "A compiler child kept output open. Compilation could not be verified.", detail2);
        }
        if (compiled.outputComplete === true) compileVerified = true;
      }
      if (signal.aborted) return result("cancelled", "Run stopped.");
      trace?.("resolve-program", "start");
      const command = plan.resolveRun ? await plan.resolveRun() : plan.run;
      trace?.("resolve-program", "end");
      trace?.("source-check-before-program", "start");
      const sourceBeforeProgram = !sourceStillCurrent || await sourceStillCurrent();
      trace?.("source-check-before-program", "end", sourceBeforeProgram);
      if (!sourceBeforeProgram) {
        return signal.aborted ? result("cancelled", "Run stopped.") : result("rejected", "The source or workspace changed. Review it and run again.");
      }
      if (signal.aborted) return result("cancelled", "Run stopped.");
      stage = "Program";
      const programStart = performance.now();
      publish.flush();
      const terminalOptions = {
        helper: this.helperPath,
        executable: command.executable,
        args: command.args,
        cwd: command.cwd ?? plan.cwd,
        environment: commandEnvironment(command, "en_US.UTF-8"),
        columns: this.columns,
        rows: this.rows,
        signal,
        timeoutMs: Math.min(this.limits.programMs, command.timeoutMs ?? this.limits.programMs),
        budget,
        ready: () => {
          trace?.("program", "ready");
          publish.phase("running", plan.label);
        },
        onOutput: (text) => publish.output("terminal", text),
        trace
      };
      trace?.("program", "launch-requested");
      let terminal = startPty(terminalOptions);
      active.terminal = terminal;
      let ran = await terminal.result;
      trace?.("program", "end", ran.state);
      if (ran.unavailable && !signal.aborted) {
        const remaining = Math.floor(terminalOptions.timeoutMs - (performance.now() - programStart));
        if (remaining <= 0) return failed("timeout", "The program could not start within its time limit.");
        publish.output("terminal", "Windows pseudoconsole unavailable. Using line input.\r\n");
        trace?.("program", "line-launch-requested");
        terminal = startLineConsole({ ...terminalOptions, timeoutMs: remaining });
        active.terminal = terminal;
        ran = await terminal.result;
      }
      const detail = {
        exitCode: ran.exitCode,
        programSignal: ran.signal,
        outputComplete: ran.outputComplete,
        programMs: Math.round(performance.now() - programStart)
      };
      if (ran.state !== "exited" || ran.exitCode !== 0) {
        return failed(ran.state, ran.detail ?? ran.signal ?? "exit code " + String(ran.exitCode), detail);
      }
      return result("success", ran.outputComplete ? "Program exited successfully." : "Program exited successfully. A descendant kept the terminal open, so output may be incomplete.", detail);
    } catch (error) {
      return signal.aborted ? result("cancelled", "Run stopped.") : failed(
        "error",
        error instanceof Error ? error.message : "Unable to start the process."
      );
    } finally {
      publish.flush();
      trace?.("output", "flushed");
    }
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  InteractiveRunner,
  configureWindowsProcessHelper,
  defaultRunLimits,
  execute
});
