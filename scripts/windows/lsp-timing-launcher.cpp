#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <string>

namespace {
std::wstring utf8(const std::string& value) {
  if (value.empty()) return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
    static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) return {};
  std::wstring result(static_cast<size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
    static_cast<int>(value.size()), result.data(), length) != length) return {};
  return result;
}

std::wstring setting(const std::wstring& directory, const wchar_t* name) {
  const std::wstring path = directory + name;
  HANDLE input = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL, nullptr);
  if (input == INVALID_HANDLE_VALUE) return {};
  char buffer[32768];
  DWORD length = 0;
  const BOOL read = ReadFile(input, buffer, sizeof(buffer), &length, nullptr);
  CloseHandle(input);
  if (!read || !length || length == sizeof(buffer)) return {};
  std::string value(buffer, buffer + length);
  const size_t newline = value.find('\n');
  if (newline != std::string::npos) value.resize(newline);
  if (!value.empty() && value.back() == '\r') value.pop_back();
  return utf8(value);
}

std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\"";
  unsigned slashes = 0;
  for (const wchar_t character : value) {
    if (character == L'\\') { ++slashes; continue; }
    if (character == L'\"') result.append(slashes * 2 + 1, L'\\');
    else result.append(slashes, L'\\');
    slashes = 0;
    result.push_back(character);
  }
  result.append(slashes * 2, L'\\');
  result.push_back(L'\"');
  return result;
}
}

int wmain(int argc, wchar_t** argv) {
  std::wstring executable(32768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
  if (!length || length >= executable.size()) return 119;
  executable.resize(length);
  const size_t separator = executable.find_last_of(L"\\/");
  if (separator == std::wstring::npos) return 119;
  const std::wstring directory = executable.substr(0, separator + 1);
  const std::wstring node = setting(directory, L"pyright-node.txt");
  const std::wstring proxy = setting(directory, L"pyright-proxy.txt");
  const std::wstring timing = setting(directory, L"pyright-timing.txt");
  const std::wstring entry = setting(directory, L"pyright-entry.txt");
  if (node.empty() || proxy.empty() || timing.empty() || entry.empty()) return 120;

  std::wstring command = quote(node) + L" " + quote(proxy) + L" " + quote(timing) + L" " + quote(entry);
  for (int index = 1; index < argc; ++index) command += L" " + quote(argv[index]);

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) return 121;

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))
      || !AssignProcessToJobObject(job, process.hProcess)) {
      CloseHandle(job);
      job = nullptr;
    }
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(process.hProcess, &code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  if (job) CloseHandle(job);
  return static_cast<int>(code);
}
