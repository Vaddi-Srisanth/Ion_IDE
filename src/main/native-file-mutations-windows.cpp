#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winternl.h>

#include <array>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

class FileHandle {
 public:
  explicit FileHandle(HANDLE value = INVALID_HANDLE_VALUE) : value_(value) {}
  ~FileHandle() { if (*this) CloseHandle(value_); }
  FileHandle(const FileHandle&) = delete;
  FileHandle& operator=(const FileHandle&) = delete;
  FileHandle(FileHandle&& other) noexcept : value_(std::exchange(other.value_, INVALID_HANDLE_VALUE)) {}
  explicit operator bool() const { return value_ != INVALID_HANDLE_VALUE; }
  HANDLE get() const { return value_; }

 private:
  HANDLE value_;
};

constexpr ULONG openReparsePoint = 0x00200000;
constexpr ULONG synchronousIo = 0x00000020;
constexpr ULONG directoryFile = 0x00000001;
constexpr ULONG nonDirectoryFile = 0x00000040;
constexpr ULONG createExclusive = 0x00000002;
constexpr ULONG caseInsensitive = 0x00000040;
constexpr DWORD pinSharing = FILE_SHARE_READ | FILE_SHARE_WRITE;
constexpr DWORD directoryAccess = FILE_TRAVERSE | FILE_READ_ATTRIBUTES;

using OpenFile = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, ULONG, ULONG);
using CreateFileRelative = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
                                           PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using ToDosError = ULONG(NTAPI*)(NTSTATUS);

template <class Function>
Function loadFunction(HMODULE module, const char* name) {
  const FARPROC address = GetProcAddress(module, name);
  Function function = nullptr;
  static_assert(sizeof(function) == sizeof(address));
  std::memcpy(&function, &address, sizeof(function));
  return function;
}

OBJECT_ATTRIBUTES relativeName(HANDLE parent, std::wstring_view leaf, UNICODE_STRING& name) {
  name.Buffer = const_cast<PWSTR>(leaf.data());
  name.Length = static_cast<USHORT>(leaf.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &name;
  attributes.Attributes = caseInsensitive;
  return attributes;
}

class NativeFiles {
 public:
  NativeFiles() : library_(GetModuleHandleW(L"ntdll.dll")),
      open_(library_ ? loadFunction<OpenFile>(library_, "NtOpenFile") : nullptr),
      create_(library_ ? loadFunction<CreateFileRelative>(library_, "NtCreateFile") : nullptr),
      error_(library_ ? loadFunction<ToDosError>(library_, "RtlNtStatusToDosError") : nullptr) {}

  explicit operator bool() const { return open_ && create_ && error_; }

  FileHandle openRelative(HANDLE parent, std::wstring_view leaf, DWORD access, DWORD sharing,
                          bool directory, DWORD& error) const {
    UNICODE_STRING name{};
    auto attributes = relativeName(parent, leaf, name);
    IO_STATUS_BLOCK io{};
    HANDLE handle = INVALID_HANDLE_VALUE;
    const NTSTATUS status = open_(&handle, access | SYNCHRONIZE, &attributes, &io, sharing,
                                  openReparsePoint | synchronousIo | (directory ? directoryFile : 0));
    error = status < 0 ? error_(status) : ERROR_SUCCESS;
    return FileHandle(status < 0 ? INVALID_HANDLE_VALUE : handle);
  }

  FileHandle createRelative(HANDLE parent, std::wstring_view leaf, bool directory, DWORD& error) const {
    UNICODE_STRING name{};
    auto attributes = relativeName(parent, leaf, name);
    IO_STATUS_BLOCK io{};
    HANDLE handle = INVALID_HANDLE_VALUE;
    const DWORD access = directory ? directoryAccess : DELETE | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | FILE_WRITE_DATA;
    const NTSTATUS status = create_(&handle, access | SYNCHRONIZE, &attributes, &io, nullptr, FILE_ATTRIBUTE_NORMAL,
      0, createExclusive, openReparsePoint | synchronousIo | (directory ? directoryFile : nonDirectoryFile), nullptr, 0);
    error = status < 0 ? error_(status) : ERROR_SUCCESS;
    return FileHandle(status < 0 ? INVALID_HANDLE_VALUE : handle);
  }

 private:
  HMODULE library_;
  OpenFile open_;
  CreateFileRelative create_;
  ToDosError error_;
};

int fail(const char* code) {
  std::fputs(code, stderr);
  std::fputc('\n', stderr);
  return 1;
}

const char* operationError(DWORD error) {
  switch (error) {
    case ERROR_ALREADY_EXISTS:
    case ERROR_DIR_NOT_EMPTY:
    case ERROR_FILE_EXISTS: return "EEXIST";
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND: return "ENOENT";
    case ERROR_BUSY:
    case ERROR_SHARING_VIOLATION:
    case ERROR_LOCK_VIOLATION:
    case ERROR_DELETE_PENDING: return "EBUSY";
    case ERROR_ACCESS_DENIED: return "EACCES";
    case ERROR_PRIVILEGE_NOT_HELD:
    case ERROR_WRITE_PROTECT: return "EPERM";
    case ERROR_NOT_SAME_DEVICE: return "EXDEV";
    case ERROR_INVALID_FUNCTION:
    case ERROR_NOT_SUPPORTED: return "ENOTSUP";
    default: return "FILE_OPERATION_FAILED";
  }
}

bool leafName(std::wstring_view name) {
  if (name.empty() || name.size() > 255 || name.back() == L' ' || name.back() == L'.'
      || name.find_first_of(L"\\/:<>\"|?*") != std::wstring_view::npos) return false;
  for (const wchar_t character : name) {
    if (character < 32 || character == 127) return false;
  }
  return true;
}

bool parseId(const wchar_t* input, std::uint64_t& value) {
  if (!*input) return false;
  for (auto cursor = input; *cursor; ++cursor) {
    if (*cursor < L'0' || *cursor > L'9') return false;
  }
  errno = 0;
  value = std::wcstoull(input, nullptr, 10);
  return errno != ERANGE;
}

bool parseMode(std::wstring_view input, unsigned int& mode) {
  if (input.empty() || input.size() > 4) return false;
  mode = 0;
  for (const wchar_t digit : input) {
    if (digit < L'0' || digit > L'7') return false;
    mode = (mode << 3) | static_cast<unsigned int>(digit - L'0');
  }
  // The 01000 protocol bit asks POSIX to restore the exact mode after umask.
  // On Windows only the low write bits affect the staged file attribute.
  return mode <= 01777;
}

bool information(HANDLE handle, BY_HANDLE_FILE_INFORMATION& info, DWORD& error) {
  if (!GetFileInformationByHandle(handle, &info)) {
    error = GetLastError();
    return false;
  }
  if (GetFileType(handle) != FILE_TYPE_DISK) {
    error = ERROR_NOT_SUPPORTED;
    return false;
  }
  return true;
}

std::uint64_t fileId(const BY_HANDLE_FILE_INFORMATION& info) {
  return (static_cast<std::uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
}

bool reparse(const BY_HANDLE_FILE_INFORMATION& info) {
  return (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

bool directory(const BY_HANDLE_FILE_INFORMATION& info) {
  return (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

std::wstring finalPath(HANDLE handle) {
  const DWORD flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
  const DWORD needed = GetFinalPathNameByHandleW(handle, nullptr, 0, flags);
  if (!needed || needed > 32768) return {};
  std::wstring path(needed, L'\0');
  const DWORD length = GetFinalPathNameByHandleW(handle, path.data(), needed, flags);
  if (!length || length >= needed) return {};
  path.resize(length);
  return path;
}

bool sameDosPath(std::wstring_view left, std::wstring_view right) {
  // Ignore only the spelling of the drive letter. NTFS directories can opt
  // into case sensitivity, so all path components must match the grant.
  return left.size() >= 7 && right.size() >= 7
      && CompareStringOrdinal(left.data(), 5, right.data(), 5, TRUE) == CSTR_EQUAL
      && left.substr(5) == right.substr(5);
}

bool exactLeaf(HANDLE handle, std::wstring_view leaf) {
  const auto path = finalPath(handle);
  const auto separator = path.find_last_of(L'\\');
  return separator != std::wstring::npos && std::wstring_view(path).substr(separator + 1) == leaf;
}

const char* pinParent(const NativeFiles& files, std::wstring_view path, std::uint64_t device,
                      std::uint64_t inode, std::vector<FileHandle>& pins) {
  if (path.size() < 3 || path.size() > 4096 || path[1] != L':' || path[2] != L'\\'
      || !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))) return "ENOTSUP";
  const std::wstring drive(path.substr(0, 3));
  if (GetDriveTypeW(drive.c_str()) == DRIVE_REMOTE) return "ENOTSUP";
  const std::wstring root = L"\\\\?\\" + drive;
  pins.emplace_back(CreateFileW(root.c_str(), directoryAccess, pinSharing, nullptr, OPEN_EXISTING,
                                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (!pins.back()) return operationError(GetLastError());
  BY_HANDLE_FILE_INFORMATION info{};
  DWORD error = ERROR_SUCCESS;
  if (!information(pins.back().get(), info, error)) return operationError(error);
  if (reparse(info) || !directory(info)) return "SCOPE_CHANGED";

  // Resolve exactly one child relative to each retained directory handle.
  // No unchecked ancestor pathname is resolved a second time for a write.
  for (std::size_t offset = 3; offset < path.size();) {
    const std::size_t end = path.find(L'\\', offset);
    const auto component = path.substr(offset, end == std::wstring_view::npos ? end : end - offset);
    if (!leafName(component)) return "SCOPE_CHANGED";
    auto child = files.openRelative(pins.back().get(), component, directoryAccess, pinSharing, true, error);
    if (!child) {
      if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND || error == ERROR_DIRECTORY) return "SCOPE_CHANGED";
      return operationError(error);
    }
    if (!information(child.get(), info, error)) return operationError(error);
    if (reparse(info) || !directory(info)) return "SCOPE_CHANGED";
    pins.push_back(std::move(child));
    if (end == std::wstring_view::npos) break;
    offset = end + 1;
    if (offset == path.size()) return "SCOPE_CHANGED";
  }
  if (info.dwVolumeSerialNumber != device || fileId(info) != inode
      || !sameDosPath(finalPath(pins.back().get()), L"\\\\?\\" + std::wstring(path))) return "SCOPE_CHANGED";
  return nullptr;
}

bool moveNoReplace(HANDLE source, HANDLE parent, const std::wstring& destination, DWORD& error) {
  struct RenameRequest {
    FILE_RENAME_INFO information;
    wchar_t remaining[255];
  } request{};
  constexpr std::size_t offset = offsetof(FILE_RENAME_INFO, FileName);
  const std::size_t nameBytes = (destination.size() + 1) * sizeof(wchar_t);
  request.information.ReplaceIfExists = FALSE;
  request.information.RootDirectory = parent;
  request.information.FileNameLength = static_cast<DWORD>(nameBytes - sizeof(wchar_t));
  std::memcpy(reinterpret_cast<unsigned char*>(&request) + offset, destination.c_str(), nameBytes);
  if (SetFileInformationByHandle(source, FileRenameInfo, &request, static_cast<DWORD>(offset + nameBytes))) return true;
  error = GetLastError();
  return false;
}

bool sameName(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_EQUAL;
}

int renameEntry(const NativeFiles& files, HANDLE parent, HANDLE source, const BY_HANDLE_FILE_INFORMATION& sourceInfo,
                const std::wstring& from, const std::wstring& to, bool caseOnly) {
  DWORD error = ERROR_SUCCESS;
  if (caseOnly) {
    if (!sameName(from, to)) return fail("EINVAL");
    const auto alias = files.openRelative(parent, to, FILE_READ_ATTRIBUTES, pinSharing | FILE_SHARE_DELETE, false, error);
    if (!alias && error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) return fail(operationError(error));
    if (alias) {
      BY_HANDLE_FILE_INFORMATION aliasInfo{};
      if (!information(alias.get(), aliasInfo, error)) return fail(operationError(error));
      if (aliasInfo.dwVolumeSerialNumber != sourceInfo.dwVolumeSerialNumber || fileId(aliasInfo) != fileId(sourceInfo)) {
        return fail("EEXIST");
      }
    }
  }
  return moveNoReplace(source, parent, to, error) ? 0 : fail(operationError(error));
}

int replaceEntry(const NativeFiles& files, HANDLE parent, HANDLE staged, const std::wstring& destination,
                 const std::wstring& backup) {
  DWORD error = ERROR_SUCCESS;
  const auto previous = files.openRelative(parent, destination, DELETE | FILE_READ_ATTRIBUTES, pinSharing, false, error);
  if (!previous) return fail(operationError(error));
  BY_HANDLE_FILE_INFORMATION info{};
  if (!information(previous.get(), info, error)) return fail(operationError(error));
  if (reparse(info) || directory(info) || !exactLeaf(previous.get(), destination)) return fail("SCOPE_CHANGED");
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_READONLY) != 0) return fail("EACCES");

  // Keep the actual destination under a unique adjacent name before publishing.
  // A crash between these two renames can leave the original name absent, but
  // its bytes remain in backup. Neither move can replace an external arrival.
  if (!moveNoReplace(previous.get(), parent, backup, error)) return fail(operationError(error));
  if (moveNoReplace(staged, parent, destination, error)) return 0;
  const DWORD publishError = error;
  if (!moveNoReplace(previous.get(), parent, destination, error)) return fail("BACKUP_RETAINED");
  return fail(operationError(publishError));
}

DWORD writeStagingFile(HANDLE file, unsigned int mode) {
  constexpr std::size_t maxBytes = 16 * 1024 * 1024;
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (!input || input == INVALID_HANDLE_VALUE) return ERROR_INVALID_HANDLE;
  std::array<char, 64 * 1024> buffer;
  std::size_t total = 0;
  for (;;) {
    DWORD size = 0;
    if (!ReadFile(input, buffer.data(), static_cast<DWORD>(buffer.size()), &size, nullptr)) {
      const DWORD error = GetLastError();
      if (error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF) break;
      return error;
    }
    if (!size) break;
    total += size;
    if (total > maxBytes) return ERROR_FILE_TOO_LARGE;
    for (DWORD offset = 0; offset < size;) {
      DWORD written = 0;
      if (!WriteFile(file, buffer.data() + offset, size - offset, &written, nullptr)) return GetLastError();
      if (!written) return ERROR_WRITE_FAULT;
      offset += written;
    }
  }
  if (!FlushFileBuffers(file)) return GetLastError();
  // Windows exposes a read-only attribute in the POSIX mode returned by Node.
  // Other permission bits are represented by inherited ACLs on this platform.
  if ((mode & 0222) == 0) {
    FILE_BASIC_INFO info{};
    if (!GetFileInformationByHandleEx(file, FileBasicInfo, &info, sizeof(info))) return GetLastError();
    info.FileAttributes = (info.FileAttributes & ~FILE_ATTRIBUTE_NORMAL) | FILE_ATTRIBUTE_READONLY;
    if (!SetFileInformationByHandle(file, FileBasicInfo, &info, sizeof(info))) return GetLastError();
  }
  return ERROR_SUCCESS;
}

int prepareEntry(const NativeFiles& files, wchar_t* args[]) {
  const std::wstring_view leaf(args[3]), type(args[7]);
  const bool folder = type == L"folder";
  std::uint64_t device = 0, inode = 0;
  unsigned int mode = 0;
  if (!leafName(leaf) || (!folder && type != L"file") || !parseId(args[4], device) || !parseId(args[5], inode)
      || !parseMode(args[6], mode)) return fail("EINVAL");
  std::vector<FileHandle> directories;
  if (const char* error = pinParent(files, args[2], device, inode, directories)) return fail(error);
  DWORD error = ERROR_SUCCESS;
  const auto staged = files.createRelative(directories.back().get(), leaf, folder, error);
  if (!staged) return fail(operationError(error));
  if (folder) return 0;

  error = writeStagingFile(staged.get(), mode);
  if (error == ERROR_SUCCESS) return 0;
  // Delete this helper's exclusively created file by its own handle. Never
  // reopen the path for cleanup because its name is not an ownership token.
  FILE_DISPOSITION_INFO disposition{ TRUE };
  if (!SetFileInformationByHandle(staged.get(), FileDispositionInfo, &disposition, sizeof(disposition))) {
    return fail("FILE_OPERATION_FAILED");
  }
  return fail(operationError(error));
}

int moveEntry(const NativeFiles& files, wchar_t* args[]) {
  const std::wstring source(args[3]), destination(args[5]);
  std::uint64_t fromDevice = 0, fromInode = 0, toDevice = 0, toInode = 0;
  if (!leafName(source) || !leafName(destination) || !parseId(args[6], fromDevice) || !parseId(args[7], fromInode)
      || !parseId(args[8], toDevice) || !parseId(args[9], toInode)) return fail("EINVAL");
  if (fromDevice != toDevice) return fail("EXDEV");
  std::vector<FileHandle> from, to;
  if (const char* error = pinParent(files, args[2], fromDevice, fromInode, from)) return fail(error);
  if (const char* error = pinParent(files, args[4], toDevice, toInode, to)) return fail(error);
  DWORD error = ERROR_SUCCESS;
  const auto entry = files.openRelative(from.back().get(), source, DELETE | FILE_READ_ATTRIBUTES, pinSharing, false, error);
  if (!entry) return fail(operationError(error));
  BY_HANDLE_FILE_INFORMATION info{};
  if (!information(entry.get(), info, error)) return fail(operationError(error));
  if (reparse(info) || !exactLeaf(entry.get(), source)) return fail("SCOPE_CHANGED");
  return moveNoReplace(entry.get(), to.back().get(), destination, error) ? 0 : fail(operationError(error));
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc < 2) return fail("EINVAL");
  const std::wstring_view operation(argv[1]);
  const NativeFiles files;
  if (!files) return fail("ENOTSUP");
  if (operation == L"prepare") return argc == 8 ? prepareEntry(files, argv) : fail("EINVAL");
  if (operation == L"move") return argc == 10 ? moveEntry(files, argv) : fail("EINVAL");
  if (argc != 8) return fail("EINVAL");
  const bool replacing = operation == L"replace";
  if (!replacing && operation != L"rename") return fail("EINVAL");
  const std::wstring source(argv[3]), destination(argv[4]), option(argv[7]);
  if (!leafName(source) || !leafName(destination) || source == destination) return fail("EINVAL");
  if (replacing && (!leafName(option) || sameName(source, destination) || sameName(option, source) || sameName(option, destination))) {
    return fail("EINVAL");
  }
  if (!replacing && option != L"0" && option != L"1") return fail("EINVAL");
  std::uint64_t device = 0, inode = 0;
  if (!parseId(argv[5], device) || !parseId(argv[6], inode)) return fail("EINVAL");
  std::vector<FileHandle> directories;
  if (const char* error = pinParent(files, argv[2], device, inode, directories)) return fail(error);
  const HANDLE parent = directories.back().get();
  DWORD error = ERROR_SUCCESS;
  const auto target = files.openRelative(parent, source, DELETE | FILE_READ_ATTRIBUTES, pinSharing, false, error);
  if (!target) return fail(operationError(error));
  BY_HANDLE_FILE_INFORMATION info{};
  if (!information(target.get(), info, error)) return fail(operationError(error));
  if (reparse(info) || (replacing && directory(info)) || !exactLeaf(target.get(), source)) return fail("SCOPE_CHANGED");
  return replacing ? replaceEntry(files, parent, target.get(), destination, option)
                   : renameEntry(files, parent, target.get(), info, source, destination, option == L"1");
}
