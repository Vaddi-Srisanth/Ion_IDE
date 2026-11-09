#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <array>
#include <cstdio>
#include <cstring>
#include <cwchar>
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
}  // namespace

int wmain(int argc, wchar_t** argv) {
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
