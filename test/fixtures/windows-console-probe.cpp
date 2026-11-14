// Disposable native regression executable, never included in Ion packages.
#include <windows.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <fcntl.h>
#include <io.h>

int main() {
  STARTUPINFOW startup{};
  GetStartupInfoW(&startup);
  int crtDescriptorCount = 0;
  if (startup.lpReserved2 && startup.cbReserved2 >= sizeof(int)) {
    std::memcpy(&crtDescriptorCount, startup.lpReserved2, sizeof(int));
  }
  DWORD members[8]{};
  const DWORD consoleProcesses = GetConsoleProcessList(members, 8);
  const UINT consoleCodePage = GetConsoleCP();
  const bool consoleWindow = GetConsoleWindow() != nullptr;
  const DWORD inputType = GetFileType(GetStdHandle(STD_INPUT_HANDLE));
  const DWORD outputType = GetFileType(GetStdHandle(STD_OUTPUT_HANDLE));
  const DWORD errorType = GetFileType(GetStdHandle(STD_ERROR_HANDLE));
  BOOL inJob = FALSE;
  const bool jobQuery = IsProcessInJob(GetCurrentProcess(), nullptr, &inJob) != FALSE;
  if (_setmode(_fileno(stdin), _O_BINARY) == -1) return 126;
  unsigned char bytes[1024];
  std::size_t total = 0, count = 0;
  std::uint32_t hash = 2166136261u;
  while ((count = std::fread(bytes, 1, sizeof(bytes), stdin)) != 0) {
    total += count;
    if (total > 65536) return 126;
    for (std::size_t i = 0; i < count; i++) hash = (hash ^ bytes[i]) * 16777619u;
  }
  if (std::ferror(stdin)) return 126;
  std::printf("{\"consoleCodePage\":%u,\"consoleProcesses\":%lu,\"consoleWindow\":%s,"
    "\"stdioTypes\":[%lu,%lu,%lu],\"inJob\":%s,\"jobQuery\":%s,\"inputBytes\":%zu,\"inputHash\":%u,\"crtBytes\":%u,\"crtDescriptorCount\":%d}\n",
    consoleCodePage, static_cast<unsigned long>(consoleProcesses), consoleWindow ? "true" : "false",
    static_cast<unsigned long>(inputType), static_cast<unsigned long>(outputType), static_cast<unsigned long>(errorType),
    inJob ? "true" : "false", jobQuery ? "true" : "false", total, hash,
    static_cast<unsigned int>(startup.cbReserved2), crtDescriptorCount);
  std::fputs("ION-PIPE-STDERR\n", stderr);
  return 125;
}
