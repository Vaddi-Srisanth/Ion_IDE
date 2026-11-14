#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <array>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <io.h>
#include <string>
#include <vector>

namespace {
constexpr DWORD cleanupMs = 1500;
constexpr WORD maxFrame = 16 * 1024;
constexpr DWORD_PTR pseudoConsoleAttribute = 0x00020016;
constexpr int setupError = 125;

class Handle {
 public:
  Handle() = default;
  explicit Handle(HANDLE value) : value_(value) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE get() const { return value_; }
  explicit operator bool() const { return value_ && value_ != INVALID_HANDLE_VALUE; }
  void reset(HANDLE value = nullptr) {
    if (*this) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_ = nullptr;
};

using CreateConsole = HRESULT (WINAPI *)(COORD, HANDLE, HANDLE, DWORD, HANDLE*);
using ResizeConsole = HRESULT (WINAPI *)(HANDLE, COORD);
using CloseConsole = void (WINAPI *)(HANDLE);

template <typename Function>
Function consoleFunction(const char* name) {
  FARPROC address = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), name);
  Function function = nullptr;
  static_assert(sizeof(function) == sizeof(address));
  std::memcpy(&function, &address, sizeof(function));
  return function;
}

bool readAll(HANDLE source, void* bytes, DWORD size) {
  auto next = static_cast<unsigned char*>(bytes);
  while (size) {
    DWORD count = 0;
    if (!ReadFile(source, next, size, &count, nullptr) || !count) return false;
    next += count;
    size -= count;
  }
  return true;
}

bool writeAll(HANDLE destination, const void* bytes, DWORD size) {
  auto next = static_cast<const unsigned char*>(bytes);
  while (size) {
    DWORD count = 0;
    if (!WriteFile(destination, next, size, &count, nullptr) || !count) return false;
    next += count;
    size -= count;
  }
  return true;
}

void status(const char* message) {
  writeAll(GetStdHandle(STD_ERROR_HANDLE), message, static_cast<DWORD>(std::strlen(message)));
}

void status(const char* format, DWORD number) {
  char message[64];
  std::snprintf(message, sizeof(message), format, static_cast<unsigned long>(number));
  status(message);
}

[[noreturn]] void fail(DWORD error) {
  status("ERROR %lu\n", error);
  // The OS closes the job and pipes even when setup failed partway through.
  ExitProcess(setupError);
}

void makePipe(Handle& input, Handle& output) {
  HANDLE read = nullptr;
  HANDLE write = nullptr;
  if (!CreatePipe(&read, &write, nullptr, maxFrame)) fail(GetLastError());
  input.reset(read);
  output.reset(write);
}

bool validDimension(unsigned int value) { return value >= 2 && value <= 512; }

SHORT dimension(const wchar_t* value) {
  wchar_t* end = nullptr;
  const auto number = std::wcstol(value, &end, 10);
  if (*value == L'\0' || *end != L'\0' || number < 0 || !validDimension(static_cast<unsigned int>(number))) {
    fail(ERROR_INVALID_PARAMETER);
  }
  return static_cast<SHORT>(number);
}

bool absoluteExecutable(const std::wstring& path) {
  return (path.size() >= 3 && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) ||
    path.compare(0, 2, L"\\\\") == 0;
}

void appendArgument(std::wstring& command, const wchar_t* arg) {
  if (!command.empty()) command += L' ';
  command += L'"';
  size_t slashes = 0;
  for (; *arg; ++arg) {
    if (*arg == L'\\') {
      ++slashes;
      continue;
    }
    command.append(*arg == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    command += *arg;
    slashes = 0;
  }
  command.append(slashes * 2, L'\\');
  command += L'"';
}

struct Relay {
  HANDLE console;
  ResizeConsole resizeConsole;
  CloseConsole closeConsole;
  HANDLE input;
  HANDLE output;
  HANDLE stop;
};

DWORD WINAPI relayInput(void* parameter) {
  const auto& relay = *static_cast<Relay*>(parameter);
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  std::array<unsigned char, maxFrame> bytes{};
  std::array<unsigned char, 3> header{};
  while (WaitForSingleObject(relay.stop, 0) == WAIT_TIMEOUT &&
         readAll(input, header.data(), static_cast<DWORD>(header.size()))) {
    const DWORD size = (static_cast<DWORD>(header[1]) << 8) | header[2];
    if (size > bytes.size() || !readAll(input, bytes.data(), size)) break;
    if (header[0] == 'D' && size) {
      if (!writeAll(relay.input, bytes.data(), size)) break;
    } else if (header[0] == 'R' && size == 4) {
      const unsigned int columns = (static_cast<unsigned int>(bytes[0]) << 8) | bytes[1];
      const unsigned int rows = (static_cast<unsigned int>(bytes[2]) << 8) | bytes[3];
      if (validDimension(columns) && validDimension(rows)) {
        relay.resizeConsole(relay.console, {static_cast<SHORT>(columns), static_cast<SHORT>(rows)});
      }
    } else if (header[0] == 'S' && !size) {
      break;
    }
  }
  SetEvent(relay.stop);
  return 0;
}

DWORD WINAPI relayOutput(void* parameter) {
  const auto& relay = *static_cast<Relay*>(parameter);
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  std::array<unsigned char, maxFrame> bytes{};
  for (;;) {
    DWORD count = 0;
    if (!ReadFile(relay.output, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr)) {
      const DWORD error = GetLastError();
      if (error != ERROR_BROKEN_PIPE && error != ERROR_NO_DATA) {
        SetEvent(relay.stop);
        return 1;
      }
      return 0;
    }
    if (!count) return 0;
    if (!writeAll(output, bytes.data(), count)) {
      SetEvent(relay.stop);
      return 1;
    }
  }
}

DWORD WINAPI closeConsoleThread(void* parameter) {
  const auto& relay = *static_cast<Relay*>(parameter);
  relay.closeConsole(relay.console);
  return 0;
}

[[noreturn]] void incomplete(DWORD code) {
  status("INCOMPLETE\n");
  ExitProcess(code);
}


// One blocked reader exists only while this requested pipe command is alive.
// fd4 carries a fixed Stop frame; it is separate from program stdin and fd3.
struct PipeStopSignal {
  HANDLE input = nullptr;
  HANDLE event = nullptr;
  std::atomic<DWORD> error{ERROR_SUCCESS};
};

DWORD WINAPI readPipeStop(void* opaque) {
  auto& signal = *static_cast<PipeStopSignal*>(opaque);
  unsigned char frame[2]{};
  SetLastError(ERROR_SUCCESS);
  if (!readAll(signal.input, frame, sizeof(frame))) {
    const DWORD error = GetLastError();
    if (error == ERROR_OPERATION_ABORTED) return 0;
    signal.error.store(error ? error : ERROR_BROKEN_PIPE, std::memory_order_release);
  } else if (frame[0] != 'S' || frame[1] != '\n') {
    signal.error.store(ERROR_INVALID_DATA, std::memory_order_release);
  }
  SetEvent(signal.event);
  return 0;
}

class PipeStopReader {
 public:
  ~PipeStopReader() {
    // A live reader must never retain a pointer to a returned stack frame.
    // OS teardown closes the Job if synchronous IO cannot be canceled.
    if (!close()) ExitProcess(setupError);
  }
  bool start(HANDLE input) {
    event_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event_) return false;
    signal_.input = input;
    signal_.event = event_.get();
    thread_.reset(CreateThread(nullptr, 0, readPipeStop, &signal_, 0, nullptr));
    return static_cast<bool>(thread_);
  }
  HANDLE event() const { return event_.get(); }
  DWORD error() const { return signal_.error.load(std::memory_order_acquire); }
  bool close() {
    if (!thread_) return true;
    const ULONGLONG deadline = GetTickCount64() + cleanupMs;
    for (;;) {
      // Repeat cancellation to cover a read beginning immediately after a
      // previous cancellation request, as in the existing ConPTY cleanup.
      CancelSynchronousIo(thread_.get());
      const DWORD result = WaitForSingleObject(thread_.get(), 20);
      if (result == WAIT_OBJECT_0) { thread_.reset(); return true; }
      if (result != WAIT_TIMEOUT || GetTickCount64() >= deadline) return false;
    }
  }
 private:
  PipeStopSignal signal_;
  Handle event_;
  Handle thread_;
};

// Pipe mode owns one short-lived Job without creating a pseudoconsole or IO
// relay threads. The five inherited CRT fds are supplied by Node/libuv; only
// stdin/stdout/stderr are duplicated into the real command. fd3 is private
// supervisor status, fd4 requests Stop; neither is inherited by the command.
int pipeProcess(int argc, wchar_t** argv) {
  const intptr_t statusValue = _get_osfhandle(3);
  const HANDLE statusPipe = reinterpret_cast<HANDLE>(statusValue);
  const HANDLE stopPipe = reinterpret_cast<HANDLE>(_get_osfhandle(4));
  const auto report = [statusPipe](const char* text) {
    return statusPipe && statusPipe != INVALID_HANDLE_VALUE
      && writeAll(statusPipe, text, static_cast<DWORD>(std::strlen(text)));
  };
  const auto failure = [&report](DWORD error) {
    char text[64];
    std::snprintf(text, sizeof(text), "ERROR %lu\n", static_cast<unsigned long>(error));
    report(text);
    return setupError;
  };
  if (argc < 4 || !absoluteExecutable(argv[3])) return failure(ERROR_INVALID_PARAMETER);
  const auto ownerText = argv[2];
  if (!*ownerText || std::wcslen(ownerText) > 10) return failure(ERROR_INVALID_PARAMETER);
  for (const wchar_t* next = ownerText; *next; ++next) {
    if (*next < L'0' || *next > L'9') return failure(ERROR_INVALID_PARAMETER);
  }
  wchar_t* end = nullptr;
  const DWORD ownerId = std::wcstoul(ownerText, &end, 10);
  if (!ownerId || *end) return failure(ERROR_INVALID_PARAMETER);
  Handle owner(OpenProcess(SYNCHRONIZE, FALSE, ownerId));
  if (!owner || WaitForSingleObject(owner.get(), 0) != WAIT_TIMEOUT) return failure(ERROR_PROCESS_ABORTED);

  Handle job(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    return failure(GetLastError());
  }
  // Neither the Job nor owner/status handles may be inherited. A descendant
  // retaining a Job handle would defeat KILL_ON_JOB_CLOSE after helper death.
  SetHandleInformation(job.get(), HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(owner.get(), HANDLE_FLAG_INHERIT, 0);
  if (!SetHandleInformation(statusPipe, HANDLE_FLAG_INHERIT, 0)
      || !stopPipe || stopPipe == INVALID_HANDLE_VALUE
      || !SetHandleInformation(stopPipe, HANDLE_FLAG_INHERIT, 0)) return failure(GetLastError());
  Handle input, output, error;
  const auto inherit = [](DWORD stream, Handle& destination) {
    const HANDLE original = GetStdHandle(stream);
    HANDLE duplicate = nullptr;
    if (!original || original == INVALID_HANDLE_VALUE || !DuplicateHandle(GetCurrentProcess(), original,
        GetCurrentProcess(), &duplicate, 0, TRUE, DUPLICATE_SAME_ACCESS)) return false;
    destination.reset(duplicate);
    return true;
  };
  if (!inherit(STD_INPUT_HANDLE, input) || !inherit(STD_OUTPUT_HANDLE, output) || !inherit(STD_ERROR_HANDLE, error)) {
    return failure(GetLastError());
  }
  HANDLE inherited[] = { input.get(), output.get(), error.get() };
  HANDLE jobs[] = { job.get() };
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input.get();
  startup.StartupInfo.hStdOutput = output.get();
  startup.StartupInfo.hStdError = error.get();
  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeBytes);
  if (!attributeBytes) return failure(GetLastError());
  std::vector<unsigned char> attributes(attributeBytes);
  startup.lpAttributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &attributeBytes)) return failure(GetLastError());
  // PROC_THREAD_ATTRIBUTE_JOB_LIST (Windows 10+) assigns ownership atomically
  // during CreateProcess. Merely creating suspended then assigning leaves a
  // helper-death interval containing an unowned suspended process.
  constexpr DWORD_PTR jobListAttribute = 0x0002000D;
  const bool configured = UpdateProcThreadAttribute(startup.lpAttributeList, 0,
      PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr)
    && UpdateProcThreadAttribute(startup.lpAttributeList, 0, jobListAttribute, jobs, sizeof(jobs), nullptr, nullptr);
  if (!configured) {
    const DWORD code = GetLastError();
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    return failure(code);
  }
  std::wstring command;
  for (int index = 3; index < argc; ++index) appendArgument(command, argv[index]);
  PROCESS_INFORMATION process{};
  // Pipe commands need no console session. CREATE_NO_WINDOW still starts a
  // headless console host; detaching avoids that startup boundary while the
  // explicit stdio handles and atomic Job assignment retain IO and ownership.
  const BOOL created = CreateProcessW(argv[3], command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | DETACHED_PROCESS | EXTENDED_STARTUPINFO_PRESENT,
      nullptr, nullptr, &startup.StartupInfo, &process);
  const DWORD launchError = created ? ERROR_SUCCESS : GetLastError();
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (!created) return failure(launchError);
  Handle child(process.hProcess), thread(process.hThread);
  BOOL assigned = FALSE;
  if (!IsProcessInJob(child.get(), job.get(), &assigned) || !assigned) {
    TerminateProcess(child.get(), setupError);
    return failure(ERROR_ACCESS_DENIED);
  }
  if (WaitForSingleObject(owner.get(), 0) != WAIT_TIMEOUT) return failure(ERROR_PROCESS_ABORTED);
  char ready[64];
  std::snprintf(ready, sizeof(ready), "READY %lu\n", static_cast<unsigned long>(process.dwProcessId));
  if (!report(ready)) return failure(ERROR_BROKEN_PIPE);
  if (ResumeThread(thread.get()) == static_cast<DWORD>(-1)) return failure(GetLastError());
  thread.reset();
  input.reset(); output.reset(); error.reset();
  PipeStopReader stopReader;
  if (!stopReader.start(stopPipe)) return failure(GetLastError());
  const HANDLE running[] = { child.get(), owner.get(), stopReader.event() };
  const DWORD finished = WaitForMultipleObjects(3, running, FALSE, INFINITE);
  DWORD code = setupError;
  if (finished == WAIT_OBJECT_0 && !GetExitCodeProcess(child.get(), &code)) return failure(GetLastError());
  if (finished != WAIT_OBJECT_0 && finished != WAIT_OBJECT_0 + 1 && finished != WAIT_OBJECT_0 + 2) return failure(GetLastError());
  if (!TerminateJobObject(job.get(), setupError)) return failure(GetLastError());
  // Bounded cleanup only while a requested command is ending. There is no
  // idle polling, persistent monitor, heap cache or renderer involvement.
  const ULONGLONG deadline = GetTickCount64() + cleanupMs;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job.get(), JobObjectBasicAccountingInformation,
        &accounting, sizeof(accounting), nullptr)) return failure(GetLastError());
    if (!accounting.ActiveProcesses) break;
    if (GetTickCount64() >= deadline) return failure(ERROR_TIMEOUT);
    Sleep(10);
  }
  if (!stopReader.close()) {
    failure(ERROR_TIMEOUT);
    ExitProcess(setupError); // No CLEAN acknowledgement if a reader remains.
  }
  if (finished == WAIT_OBJECT_0 + 2 && stopReader.error() != ERROR_SUCCESS) return failure(stopReader.error());
  // CLEAN proves both Job drain and control-reader termination, including Stop.
  // Owner death also drains the Job; the departed owner cannot consume status.
  if (!report("CLEAN\n")) return setupError;
  return static_cast<int>(code);
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wcscmp(argv[1], L"--pipe-version") == 0) {
    writeAll(GetStdHandle(STD_OUTPUT_HANDLE), "ION_PIPE_JOB_2\n", 15);
    return 0;
  }
  if (argc >= 2 && std::wcscmp(argv[1], L"--pipe") == 0) return pipeProcess(argc, argv);
  if (argc < 4) fail(ERROR_INVALID_PARAMETER);
  const COORD size{dimension(argv[1]), dimension(argv[2])};
  const int executableIndex = std::wcscmp(argv[3], L"--shell") == 0 ? 4 : 3;
  if (argc <= executableIndex || !absoluteExecutable(argv[executableIndex])) fail(ERROR_INVALID_PARAMETER);
  std::wstring command;
  for (int i = executableIndex; i < argc; ++i) appendArgument(command, argv[i]);

  const auto create = consoleFunction<CreateConsole>("CreatePseudoConsole");
  const auto resize = consoleFunction<ResizeConsole>("ResizePseudoConsole");
  const auto close = consoleFunction<CloseConsole>("ClosePseudoConsole");
  if (!create || !resize || !close) {
    status("UNAVAILABLE\n");
    return setupError;
  }

  Handle consoleInput, consoleOutput, input, output;
  makePipe(consoleInput, input);
  makePipe(output, consoleOutput);
  HANDLE console = nullptr;
  const HRESULT created = create(size, consoleInput.get(), consoleOutput.get(), 0, &console);
  if (created == E_NOTIMPL || created == HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED) ||
      created == HRESULT_FROM_WIN32(ERROR_CALL_NOT_IMPLEMENTED)) {
    status("UNAVAILABLE\n");
    return setupError;
  }
  if (FAILED(created)) fail(static_cast<DWORD>(created));

  Handle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!stop) fail(GetLastError());
  Relay relay{console, resize, close, input.get(), output.get(), stop.get()};
  Handle outputThread(CreateThread(nullptr, 0, relayOutput, &relay, 0, nullptr));
  if (!outputThread) fail(GetLastError());

  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job) fail(GetLastError());
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    fail(GetLastError());
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  // The helper uses pipes. Clear its standard handles so the child opens
  // its own console handles from the pseudoconsole instead.
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
  if (!attributeBytes) fail(GetLastError());
  std::vector<unsigned char> attributes(attributeBytes);
  startup.lpAttributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeBytes) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, pseudoConsoleAttribute, console, sizeof(console), nullptr, nullptr)) {
    fail(GetLastError());
  }
  PROCESS_INFORMATION process{};
  // A parent's Ctrl+C ignore setting can otherwise be inherited by the child.
  SetConsoleCtrlHandler(nullptr, FALSE);
  const BOOL launched = CreateProcessW(argv[executableIndex], command.data(), nullptr, nullptr, FALSE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, nullptr, nullptr, &startup.StartupInfo, &process);
  const DWORD launchError = launched ? ERROR_SUCCESS : GetLastError();
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (!launched) fail(launchError);
  consoleInput.reset();
  consoleOutput.reset();
  Handle child(process.hProcess), childThread(process.hThread);

  if (!AssignProcessToJobObject(job.get(), child.get())) {
    const DWORD error = GetLastError();
    TerminateProcess(child.get(), setupError);
    fail(error);
  }
  Handle inputThread(CreateThread(nullptr, 0, relayInput, &relay, 0, nullptr));
  if (!inputThread) fail(GetLastError());
  if (ResumeThread(childThread.get()) == static_cast<DWORD>(-1)) fail(GetLastError());
  status("READY %lu\n", process.dwProcessId);

  const HANDLE running[] = {child.get(), stop.get()};
  const DWORD finished = WaitForMultipleObjects(2, running, FALSE, INFINITE);
  DWORD code = setupError;
  if (finished == WAIT_OBJECT_0) GetExitCodeProcess(child.get(), &code);
  TerminateJobObject(job.get(), setupError);
  job.reset();

  SetEvent(stop.get());
  // A synchronous read can begin just after the first cancellation request.
  const ULONGLONG deadline = GetTickCount64() + cleanupMs;
  for (;;) {
    CancelSynchronousIo(inputThread.get());
    const DWORD ended = WaitForSingleObject(inputThread.get(), 20);
    if (ended == WAIT_OBJECT_0) break;
    if (ended != WAIT_TIMEOUT || GetTickCount64() >= deadline) incomplete(code);
  }
  input.reset();
  // Older Windows versions can block in ClosePseudoConsole until the output pipe is drained.
  Handle closing(CreateThread(nullptr, 0, closeConsoleThread, &relay, 0, nullptr));
  const HANDLE cleanup[] = {closing.get(), outputThread.get()};
  if (!closing || WaitForMultipleObjects(2, cleanup, TRUE, cleanupMs) != WAIT_OBJECT_0) incomplete(code);
  DWORD outputCode = 1;
  if (!GetExitCodeThread(outputThread.get(), &outputCode) || outputCode) status("INCOMPLETE\n");
  return static_cast<int>(code);
}
