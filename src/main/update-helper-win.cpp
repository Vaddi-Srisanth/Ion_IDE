#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <shlobj.h>
#include <shellapi.h>
#include <winver.h>

#include <array>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

// This short-lived helper is launched only after the user chooses Install and
// Restart. It never terminates Ion and never receives a shell command.
namespace {
constexpr unsigned long long maxInstaller = 512ULL * 1024 * 1024;
constexpr unsigned long long maxBackup = 2ULL * 1024 * 1024 * 1024;
constexpr unsigned long long maxUninstaller = 16ULL * 1024 * 1024;
constexpr size_t maxFiles = 12000;
constexpr wchar_t uninstallKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\dev.ionide.desktop";

class Handle {
 public:
  explicit Handle(HANDLE value = nullptr) : value_(value) {}
  ~Handle() { if (valid()) CloseHandle(value_); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE get() const { return value_; }
  bool valid() const { return value_ && value_ != INVALID_HANDLE_VALUE; }
 private:
  HANDLE value_;
};

struct Options {
  DWORD parent = 0;
  DWORD timeout = 120000;
  std::wstring installer, target, profile, digest, version;
};

struct RegistryVersion {
  REGSAM view;
  bool present = false;
  std::vector<unsigned char> bytes;
};

bool readVersion(RegistryVersion& previous) {
  HKEY key = nullptr;
  const LSTATUS opened = RegOpenKeyExW(HKEY_CURRENT_USER, uninstallKey, 0, KEY_QUERY_VALUE | previous.view, &key);
  if (opened == ERROR_FILE_NOT_FOUND) return true;
  if (opened != ERROR_SUCCESS) return false;
  DWORD type = 0, size = 0;
  const LSTATUS queried = RegQueryValueExW(key, L"DisplayVersion", nullptr, &type, nullptr, &size);
  if (queried == ERROR_FILE_NOT_FOUND) { RegCloseKey(key); return true; }
  if (queried != ERROR_SUCCESS || type != REG_SZ || size < sizeof(wchar_t) || size > 1024 || size % sizeof(wchar_t)) {
    RegCloseKey(key);
    return false;
  }
  previous.bytes.resize(size);
  const LSTATUS copied = RegQueryValueExW(key, L"DisplayVersion", nullptr, &type, previous.bytes.data(), &size);
  RegCloseKey(key);
  if (copied != ERROR_SUCCESS || type != REG_SZ || size != previous.bytes.size()
    || previous.bytes[size - 1] != 0 || previous.bytes[size - 2] != 0) return false;
  previous.present = true;
  return true;
}

bool restoreVersion(const RegistryVersion& previous) {
  HKEY key = nullptr;
  if (!previous.present) {
    const LSTATUS opened = RegOpenKeyExW(HKEY_CURRENT_USER, uninstallKey, 0, KEY_SET_VALUE | previous.view, &key);
    if (opened == ERROR_FILE_NOT_FOUND) return true;
    if (opened != ERROR_SUCCESS) return false;
    const LSTATUS removed = RegDeleteValueW(key, L"DisplayVersion");
    RegCloseKey(key);
    return removed == ERROR_SUCCESS || removed == ERROR_FILE_NOT_FOUND;
  }
  if (RegCreateKeyExW(HKEY_CURRENT_USER, uninstallKey, 0, nullptr, 0, KEY_SET_VALUE | previous.view,
    nullptr, &key, nullptr) != ERROR_SUCCESS) return false;
  const LSTATUS written = RegSetValueExW(key, L"DisplayVersion", 0, REG_SZ, previous.bytes.data(), static_cast<DWORD>(previous.bytes.size()));
  RegCloseKey(key);
  return written == ERROR_SUCCESS;
}

unsigned long long backupBytes = 0;
ULONGLONG backupMs = 0;

bool absolute(const std::wstring& path) {
  // Upgrades deliberately support local, per-user installed copies only.
  return path.size() > 3 && ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))
    && path[1] == L':' && path[2] == L'\\' && path.find_first_of(L"\r\n\"") == std::wstring::npos;
}

std::wstring parentPath(const std::wstring& path) { return path.substr(0, path.find_last_of(L'\\')); }

bool same(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_EQUAL;
}

std::wstring canonical(HANDLE handle) {
  std::vector<wchar_t> path(32768);
  const DWORD count = GetFinalPathNameByHandleW(handle, path.data(), static_cast<DWORD>(path.size()), FILE_NAME_NORMALIZED);
  if (!count || count >= path.size()) return {};
  return std::wstring(path.data(), count);
}

bool regular(HANDLE file, unsigned long long limit) {
  BY_HANDLE_FILE_INFORMATION info{};
  return GetFileType(file) == FILE_TYPE_DISK && GetFileInformationByHandle(file, &info)
    && !(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
    && ((static_cast<unsigned long long>(info.nFileSizeHigh) << 32) | info.nFileSizeLow) <= limit;
}

DWORD number(const wchar_t* value, DWORD minimum, DWORD maximum) {
  if (!*value || std::wcslen(value) > 10) return 0;
  for (const wchar_t* c = value; *c; ++c) if (*c < L'0' || *c > L'9') return 0;
  wchar_t* end = nullptr;
  const unsigned long count = std::wcstoul(value, &end, 10);
  return *value && !*end && count >= minimum && count <= maximum ? static_cast<DWORD>(count) : 0;
}

bool parse(int argc, wchar_t** argv, Options& options) {
  if (argc != 13 && argc != 15) return false;
  unsigned seen = 0;
  for (int i = 1; i + 1 < argc; i += 2) {
    const std::wstring flag(argv[i]);
    unsigned bit = 0;
    if (flag == L"--parent") { bit = 1; options.parent = number(argv[i + 1], 1, MAXDWORD); }
    else if (flag == L"--installer") { bit = 2; options.installer = argv[i + 1]; }
    else if (flag == L"--target") { bit = 4; options.target = argv[i + 1]; }
    else if (flag == L"--sha256") { bit = 8; options.digest = argv[i + 1]; }
    else if (flag == L"--version") { bit = 16; options.version = argv[i + 1]; }
    else if (flag == L"--profile") { bit = 32; options.profile = argv[i + 1]; }
    else if (flag == L"--timeout-ms") { bit = 64; options.timeout = number(argv[i + 1], 10, 120000); }
    else return false;
    if (seen & bit) return false;
    seen |= bit;
  }
  if ((seen & 63) != 63 || !options.parent || !options.timeout || !absolute(options.installer)
    || !absolute(options.target) || !absolute(options.profile) || options.digest.size() != 64
    || options.installer.size() < 4 || !same(options.installer.substr(options.installer.size() - 4), L".exe")) return false;
  for (const wchar_t c : options.digest) if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return false;
  int components = 0;
  size_t start = 0;
  while (start < options.version.size()) {
    const size_t end = options.version.find(L'.', start);
    const auto component = options.version.substr(start, end - start);
    if (component.empty() || component.size() > 5 || (component.size() > 1 && component[0] == L'0')) return false;
    for (const wchar_t c : component) if (c < L'0' || c > L'9') return false;
    if (std::wcstoul(component.c_str(), nullptr, 10) > 65535) return false;
    components++;
    if (end == std::wstring::npos) break;
    start = end + 1;
    if (start == options.version.size()) return false;
  }
  return components == 3;
}

void line(DWORD stream, const char* message) {
  DWORD written = 0;
  WriteFile(GetStdHandle(stream), message, static_cast<DWORD>(std::strlen(message)), &written, nullptr);
}

bool plainDirectory(const std::wstring& path) {
  const DWORD attr = GetFileAttributesW(path.c_str());
  return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY) && !(attr & FILE_ATTRIBUTE_REPARSE_POINT);
}

std::wstring localAppData() {
  PWSTR path = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &path))) return {};
  const std::wstring value(path);
  CoTaskMemFree(path);
  return value;
}

bool installedTarget(const Options& options, HANDLE target) {
  const std::wstring local = localAppData();
  if (local.empty()) return false;
  const std::wstring programs = local + L"\\Programs";
  const std::wstring root = programs + L"\\Ion IDE";
  const std::wstring app = root + L"\\App";
  const std::wstring expected = app + L"\\Ion IDE.exe";
  if (!same(expected, options.target) || !plainDirectory(programs) || !plainDirectory(root) || !plainDirectory(app)) return false;
  Handle check(CreateFileW(expected.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  return check.valid() && regular(check.get(), maxBackup) && !canonical(target).empty()
    && same(canonical(target), canonical(check.get()));
}

bool parentMatches(HANDLE parent, HANDLE target) {
  if (WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) return false;
  std::vector<wchar_t> path(32768);
  DWORD size = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(parent, 0, path.data(), &size)) return false;
  Handle image(CreateFileW(path.data(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  return image.valid() && regular(image.get(), maxBackup) && !canonical(image.get()).empty()
    && same(canonical(image.get()), canonical(target));
}

bool sameFile(HANDLE left, HANDLE right) {
  BY_HANDLE_FILE_INFORMATION a{}, b{};
  return GetFileInformationByHandle(left, &a) && GetFileInformationByHandle(right, &b)
    && a.dwVolumeSerialNumber == b.dwVolumeSerialNumber && a.nFileIndexHigh == b.nFileIndexHigh
    && a.nFileIndexLow == b.nFileIndexLow;
}

std::wstring sha256(HANDLE file) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  std::wstring result;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return result;
  if (BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) >= 0) {
    std::array<unsigned char, 65536> buffer{};
    std::array<unsigned char, 32> digest{};
    bool good = true;
    while (true) {
      DWORD bytes = 0;
      if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &bytes, nullptr)) { good = false; break; }
      if (!bytes) break;
      if (BCryptHashData(hash, buffer.data(), bytes, 0) < 0) { good = false; break; }
    }
    if (good && BCryptFinishHash(hash, digest.data(), static_cast<DWORD>(digest.size()), 0) >= 0) {
      constexpr wchar_t hex[] = L"0123456789abcdef";
      for (const unsigned char value : digest) { result += hex[value >> 4]; result += hex[value & 15]; }
    }
    BCryptDestroyHash(hash);
  }
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return result;
}

bool hasDigest(const std::wstring& path, const std::wstring& digest, unsigned long long limit) {
  Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  return file.valid() && regular(file.get(), limit) && sha256(file.get()) == digest;
}

bool copyTree(const std::wstring& source, const std::wstring& destination, unsigned long long& bytes, size_t& files, int depth = 0) {
  if (depth > 32 || !plainDirectory(source) || !CreateDirectoryW(destination.c_str(), nullptr)) return false;
  WIN32_FIND_DATAW entry{};
  const HANDLE raw = FindFirstFileW((source + L"\\*").c_str(), &entry);
  if (raw == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
  bool good = true;
  do {
    if (!std::wcscmp(entry.cFileName, L".") || !std::wcscmp(entry.cFileName, L"..")) continue;
    if ((entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || ++files > maxFiles) { good = false; break; }
    const std::wstring from = source + L"\\" + entry.cFileName;
    const std::wstring to = destination + L"\\" + entry.cFileName;
    if (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) good = copyTree(from, to, bytes, files, depth + 1);
    else {
      bytes += (static_cast<unsigned long long>(entry.nFileSizeHigh) << 32) | entry.nFileSizeLow;
      good = bytes <= maxBackup && CopyFileW(from.c_str(), to.c_str(), TRUE);
    }
    if (!good) break;
  } while (FindNextFileW(raw, &entry));
  const DWORD last = GetLastError();
  FindClose(raw);
  return good && (last == ERROR_NO_MORE_FILES || last == ERROR_SUCCESS);
}

// Removal is only used on the helper's unique, newly-created backup/failed tree.
// Refuse reparse points rather than following them outside that tree.
bool removeTree(const std::wstring& path, int depth = 0) {
  if (depth > 32 || !plainDirectory(path)) return false;
  WIN32_FIND_DATAW entry{};
  const HANDLE raw = FindFirstFileW((path + L"\\*").c_str(), &entry);
  if (raw == INVALID_HANDLE_VALUE) return RemoveDirectoryW(path.c_str()) != FALSE;
  bool good = true;
  do {
    if (!std::wcscmp(entry.cFileName, L".") || !std::wcscmp(entry.cFileName, L"..")) continue;
    if (entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { good = false; break; }
    const std::wstring child = path + L"\\" + entry.cFileName;
    if (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) good = removeTree(child, depth + 1);
    else {
      SetFileAttributesW(child.c_str(), FILE_ATTRIBUTE_NORMAL);
      good = DeleteFileW(child.c_str()) != FALSE;
    }
    if (!good) break;
  } while (FindNextFileW(raw, &entry));
  FindClose(raw);
  return good && RemoveDirectoryW(path.c_str());
}

std::wstring uniqueName(const std::wstring& directory, const wchar_t* prefix) {
  std::array<unsigned char, 16> random{};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return {};
  std::wstring path = directory + L"\\" + prefix;
  constexpr wchar_t hex[] = L"0123456789abcdef";
  for (const unsigned char value : random) { path += hex[value >> 4]; path += hex[value & 15]; }
  return path;
}

std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (const wchar_t c : value) {
    if (c == L'\\') { slashes++; continue; }
    if (c == L'\"') result.append(slashes * 2 + 1, L'\\');
    else result.append(slashes, L'\\');
    slashes = 0;
    result += c;
  }
  result.append(slashes * 2, L'\\');
  return result + L'\"';
}

bool launch(const std::wstring& file, const std::wstring& parameters, HANDLE* process) {
  SHELLEXECUTEINFOW info{};
  info.cbSize = sizeof(info);
  info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
  info.lpVerb = L"open";
  info.lpFile = file.c_str();
  info.lpParameters = parameters.empty() ? nullptr : parameters.c_str();
  info.nShow = SW_SHOWNORMAL;
  if (!ShellExecuteExW(&info)) return false;
  *process = info.hProcess;
  return true;
}

bool versionMatches(const std::wstring& file, const std::wstring& expected) {
  DWORD ignored = 0;
  const DWORD size = GetFileVersionInfoSizeW(file.c_str(), &ignored);
  if (!size || size > 1024 * 1024) return false;
  std::vector<unsigned char> data(size);
  if (!GetFileVersionInfoW(file.c_str(), 0, size, data.data())) return false;
  VS_FIXEDFILEINFO* version = nullptr;
  UINT length = 0;
  if (!VerQueryValueW(data.data(), L"\\", reinterpret_cast<void**>(&version), &length)
    || length < sizeof(VS_FIXEDFILEINFO) || version->dwSignature != 0xfeef04bd) return false;
  const std::wstring actual = std::to_wstring(HIWORD(version->dwProductVersionMS)) + L"."
    + std::to_wstring(LOWORD(version->dwProductVersionMS)) + L"."
    + std::to_wstring(HIWORD(version->dwProductVersionLS));
  return actual == expected;
}

void writeResult(const std::wstring& directory, const std::string& json) {
  if (!plainDirectory(directory)) return;
  const auto path = directory + L"\\result.json";
  const auto prefix = uniqueName(directory, L".ion-result-");
  if (prefix.empty()) return;
  const auto temporary = prefix + L".tmp";
  bool written = false;
  bool created = false;
  {
    Handle output(CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (output.valid()) {
      created = true;
      DWORD bytes = 0;
      written = WriteFile(output.get(), json.data(), static_cast<DWORD>(json.size()), &bytes, nullptr)
        && bytes == json.size() && FlushFileBuffers(output.get());
    }
  }
  if (written && MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return;
  if (created) DeleteFileW(temporary.c_str());
}

void result(const Options& options, bool installed, const char* message) {
  // Only fixed messages and numeric versions are recorded. Never include user paths.
  SYSTEMTIME time{};
  GetSystemTime(&time);
  char timestamp[32];
  std::snprintf(timestamp, sizeof(timestamp), "%04u-%02u-%02uT%02u:%02u:%02uZ",
    static_cast<unsigned>(time.wYear), static_cast<unsigned>(time.wMonth), static_cast<unsigned>(time.wDay),
    static_cast<unsigned>(time.wHour), static_cast<unsigned>(time.wMinute), static_cast<unsigned>(time.wSecond));
  const std::string version(options.version.begin(), options.version.end());
  const std::string json = "{\"schemaVersion\":1,\"state\":\"" + std::string(installed ? "installed" : "failed")
    + "\",\"version\":\"" + version + "\",\"message\":\"" + message + "\",\"timestamp\":\"" + timestamp
    + "\",\"backupBytes\":" + std::to_string(backupBytes) + ",\"backupMs\":" + std::to_string(backupMs) + "}\n";
  writeResult(parentPath(options.installer), json);
  // Profiles are local and user-owned. Reject a redirected updates directory;
  // never write through a junction or a result-file symbolic link.
  if (plainDirectory(options.profile)) {
    const auto updates = options.profile + L"\\updates";
    if (CreateDirectoryW(updates.c_str(), nullptr) || GetLastError() == ERROR_ALREADY_EXISTS) writeResult(updates, json);
  }
}

bool restart(const Options& options) {
  HANDLE rawApp = nullptr;
  const bool restarted = launch(options.target, quote(L"--user-data-dir=" + options.profile), &rawApp);
  Handle appProcess(rawApp);
  return restarted;
}

int perform(const Options& options) {
  Handle target(CreateFileW(options.target.c_str(), GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!target.valid() || !regular(target.get(), maxBackup) || !installedTarget(options, target.get())) return 3;
  if (!plainDirectory(options.profile)) return 2;
  Handle parent(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, options.parent));
  if (!parent.valid() || !parentMatches(parent.get(), target.get())) return 4;
  const std::wstring app = parentPath(options.target);
  const std::wstring root = parentPath(app);
  const std::wstring uninstallPath = root + L"\\Uninstall.exe";
  Handle uninstaller(CreateFileW(uninstallPath.c_str(), GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!uninstaller.valid() || !regular(uninstaller.get(), maxUninstaller)) return 3;
  const auto originalUninstallerDigest = sha256(uninstaller.get());
  if (originalUninstallerDigest.empty()) return 3;
  std::array<RegistryVersion, 2> versions{ RegistryVersion{ KEY_WOW64_32KEY }, RegistryVersion{ KEY_WOW64_64KEY } };
  for (auto& version : versions) if (!readVersion(version)) return 3;
  // Keep this handle until the installer exits: no post-hash replacement/writes.
  Handle installer(CreateFileW(options.installer.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (!installer.valid() || !regular(installer.get(), maxInstaller) || sha256(installer.get()) != options.digest) return 5;
  if (!versionMatches(options.installer, options.version)) return 5;
  const auto originalDigest = sha256(target.get());
  if (originalDigest.empty()) return 3;
  line(STD_OUTPUT_HANDLE, "READY\n");
  if (WaitForSingleObject(parent.get(), options.timeout) != WAIT_OBJECT_0) {
    result(options, false, "Ion did not exit. No application files were changed.");
    return 6;
  }

  {
    Handle current(CreateFileW(options.target.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!current.valid() || !sameFile(target.get(), current.get()) || !installedTarget(options, current.get())) {
      result(options, false, "The installed application changed while waiting. No application files were changed.");
      return 3;
    }
    Handle currentUninstaller(CreateFileW(uninstallPath.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!currentUninstaller.valid() || !regular(currentUninstaller.get(), maxUninstaller)
      || !sameFile(uninstaller.get(), currentUninstaller.get())) {
      result(options, false, "The installed uninstaller changed while waiting. No application files were changed.");
      return 3;
    }
  }

  const auto backup = uniqueName(root, L".ion-update-backup-");
  const auto backupApp = backup + L"\\App";
  const auto backupUninstaller = backup + L"\\Uninstall.exe";
  unsigned long long bytes = 0;
  LARGE_INTEGER uninstallerBytes{};
  if (!GetFileSizeEx(uninstaller.get(), &uninstallerBytes)) return 9;
  bytes = static_cast<unsigned long long>(uninstallerBytes.QuadPart);
  size_t files = 1;
  const auto backupStarted = GetTickCount64();
  const bool ownedBackup = !backup.empty() && CreateDirectoryW(backup.c_str(), nullptr);
  const bool copied = ownedBackup && CopyFileW(uninstallPath.c_str(), backupUninstaller.c_str(), TRUE)
    && copyTree(app, backupApp, bytes, files);
  backupMs = GetTickCount64() - backupStarted;
  backupBytes = bytes;
  if (!copied) {
    if (ownedBackup) removeTree(backup);
    result(options, false, "Could not prepare a rollback copy. The installed application was not changed.");
    return 9;
  }
  {
    if (!hasDigest(backupApp + L"\\Ion IDE.exe", originalDigest, maxBackup)
      || !hasDigest(backupUninstaller, originalUninstallerDigest, maxUninstaller)) {
      removeTree(backup);
      result(options, false, "The application changed while preparing rollback. No application files were changed.");
      return 9;
    }
  }
  HANDLE rawSetup = nullptr;
  DWORD status = 1;
  const bool started = launch(options.installer, L"/S", &rawSetup);
  {
    Handle setup(rawSetup);
    if (started && !setup.valid()) {
      result(options, false, "Setup started without an observable process handle. The rollback copy was preserved.");
      return 10;
    }
    if (started && setup.valid() && WaitForSingleObject(setup.get(), 600000) == WAIT_OBJECT_0) {
      GetExitCodeProcess(setup.get(), &status);
    } else if (started && setup.valid()) {
      // Do not replace files while a slow installer still owns them and do not
      // terminate it. Preserve the rollback tree for manual recovery.
      result(options, false, "Setup did not finish within ten minutes. The rollback copy was preserved.");
      return 10;
    }
  }
  if (!started || status != 0 || !versionMatches(options.target, options.version)) {
    const auto failed = uniqueName(root, L".ion-update-failed-");
    const bool missing = GetFileAttributesW(app.c_str()) == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND;
    const bool moved = missing || (!failed.empty() && MoveFileExW(app.c_str(), failed.c_str(), MOVEFILE_WRITE_THROUGH));
    const bool renamed = moved && MoveFileExW(backupApp.c_str(), app.c_str(), MOVEFILE_WRITE_THROUGH);
    bool restored = false;
    if (renamed) {
      Handle recovered(CreateFileW(options.target.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      restored = recovered.valid() && regular(recovered.get(), maxBackup) && sha256(recovered.get()) == originalDigest;
    }
    if (restored && !missing) removeTree(failed);
    bool metadataRestored = false;
    if (restored) {
      // Setup can replace its uninstaller before a later failure. Restore that
      // exact file and only DisplayVersion, never unrelated registry values.
      const auto temporary = uniqueName(root, L".ion-uninstall-restore-");
      const bool copiedUninstaller = !temporary.empty() && hasDigest(backupUninstaller, originalUninstallerDigest, maxUninstaller)
        && CopyFileW(backupUninstaller.c_str(), temporary.c_str(), TRUE);
      const bool replacedUninstaller = copiedUninstaller && MoveFileExW(temporary.c_str(), uninstallPath.c_str(),
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
      if (copiedUninstaller && !replacedUninstaller) DeleteFileW(temporary.c_str());
      metadataRestored = replacedUninstaller && hasDigest(uninstallPath, originalUninstallerDigest, maxUninstaller);
      if (metadataRestored) for (const auto& version : versions) if (!restoreVersion(version)) metadataRestored = false;
      if (metadataRestored) removeTree(backup);
    }
    const char* failure = restored && metadataRestored ? "Setup failed. The previous application and installer metadata were restored."
      : restored ? "Setup failed. The application was restored; installer metadata requires recovery from the preserved backup."
      : "Setup failed. A rollback copy was preserved beside the installation.";
    result(options, false, failure);
    if (restored) restart(options);
    return started ? 8 : 7;
  }
  removeTree(backup);
  result(options, true, "Ion was updated in place.");
  if (!restart(options)) {
    result(options, true, "Ion was updated. Open Ion to continue; automatic restart was unavailable.");
    return 11;
  }
  return 0;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  Options options;
  if (!parse(argc, argv, options)) { line(STD_ERROR_HANDLE, "Invalid updater arguments.\n"); return 2; }
  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE))) return 2;
  const int code = perform(options);
  if (code) {
    const char* message = code == 3 ? "Updates require the installed per-user Ion application.\n"
      : code == 4 ? "The running Ion process did not match the installation.\n"
      : code == 5 ? "The installer checksum or version did not match.\n"
      : code == 6 ? "Ion did not exit; the update was canceled.\n" : "The update could not finish.\n";
    line(STD_ERROR_HANDLE, message);
  }
  CoUninitialize();
  return code;
}
