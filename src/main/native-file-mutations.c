#ifndef __APPLE__
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/fs.h>
#include <sys/syscall.h>
#endif

static int failure(const char *code) {
    fprintf(stderr, "%s\n", code);
    return 1;
}

static int system_failure(int error) {
    switch (error) {
        case EEXIST: case ENOTEMPTY: return failure("EEXIST");
        case ENOENT: return failure("ENOENT");
        case EACCES: return failure("EACCES");
        case EPERM: return failure("EPERM");
        case EBUSY: return failure("EBUSY");
        case EXDEV: return failure("EXDEV");
        case ENOTSUP: case ENOSYS: case EINVAL: return failure("ENOTSUP");
        default: return failure("FILE_OPERATION_FAILED");
    }
}

static int leaf(const char *name) {
    return *name && !strchr(name, '/') && strcmp(name, ".") && strcmp(name, "..");
}

static int guarded_directory(const char *path, const char *device, const char *inode) {
    int fd = open(path, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    struct stat info;
    if (fstat(fd, &info) || (uintmax_t)info.st_dev != strtoumax(device, NULL, 10)
        || (uintmax_t)info.st_ino != strtoumax(inode, NULL, 10)) {
        close(fd);
        return -1;
    }
    return fd;
}

static int rename_entry(int source_dir, const char *from, int target_dir, const char *to, int exchange) {
#if defined(__APPLE__)
    return renameatx_np(source_dir, from, target_dir, to, exchange ? RENAME_SWAP : RENAME_EXCL);
#elif defined(__linux__)
    return (int)syscall(SYS_renameat2, source_dir, from, target_dir, to, exchange ? RENAME_EXCHANGE : RENAME_NOREPLACE);
#else
    errno = ENOTSUP;
    return -1;
#endif
}

static int write_file(int dir, const char *name, unsigned long mode) {
    int file = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, (mode_t)(mode & 0777));
    if (file < 0) return system_failure(errno);
    unsigned char buffer[65536];
    size_t total = 0;
    int error = 0;
    for (;;) {
        ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { error = errno; break; }
        if (!count) break;
        total += (size_t)count;
        if (total > 16 * 1024 * 1024) { error = EFBIG; break; }
        ssize_t offset = 0;
        while (offset < count) {
            ssize_t written = write(file, buffer + offset, (size_t)(count - offset));
            if (written < 0 && errno == EINTR) continue;
            if (written <= 0) { error = written < 0 ? errno : EIO; break; }
            offset += written;
        }
        if (error) break;
    }
    if (!error && (mode & 01000) && fchmod(file, (mode_t)(mode & 0777))) error = errno;
    if (!error && fsync(file)) error = errno;
    if (error) {
        struct stat actual, created;
        if (!fstat(file, &created) && !fstatat(dir, name, &actual, AT_SYMLINK_NOFOLLOW)
            && created.st_ino == actual.st_ino && created.st_dev == actual.st_dev) unlinkat(dir, name, 0);
    }
    close(file);
    return error ? system_failure(error) : 0;
}

int main(int argc, char **argv) {
    if (argc == 10 && !strcmp(argv[1], "move") && leaf(argv[3]) && leaf(argv[5])) {
        int from = guarded_directory(argv[2], argv[6], argv[7]);
        int to = guarded_directory(argv[4], argv[8], argv[9]);
        int result = from < 0 || to < 0 ? failure("SCOPE_CHANGED")
            : rename_entry(from, argv[3], to, argv[5], 0) ? system_failure(errno) : 0;
        if (from >= 0) close(from);
        if (to >= 0) close(to);
        return result;
    }
    if (argc != 8 || !leaf(argv[3])) return failure("INVALID_OPERATION");
    if (!strcmp(argv[1], "prepare")) {
        int dir = guarded_directory(argv[2], argv[4], argv[5]);
        if (dir < 0) return failure("SCOPE_CHANGED");
        unsigned long mode = strtoul(argv[6], NULL, 8);
        int result = !strcmp(argv[7], "folder")
            ? (mkdirat(dir, argv[3], (mode_t)(mode & 0777)) ? system_failure(errno) : 0)
            : !strcmp(argv[7], "file") ? write_file(dir, argv[3], mode) : failure("INVALID_OPERATION");
        close(dir);
        return result;
    }
    if (!leaf(argv[4])) return failure("INVALID_OPERATION");
    int dir = guarded_directory(argv[2], argv[5], argv[6]);
    if (dir < 0) return failure("SCOPE_CHANGED");
    int result;
    if (!strcmp(argv[1], "rename")) {
        result = rename_entry(dir, argv[3], dir, argv[4], 0) ? system_failure(errno) : 0;
    } else if (!strcmp(argv[1], "replace") && leaf(argv[7])) {
        // The exchange publishes the staged file and moves the displaced entry
        // to a private name in a single atomic operation.
        if (rename_entry(dir, argv[3], dir, argv[4], 1)) result = system_failure(errno);
        else if (rename_entry(dir, argv[3], dir, argv[7], 0)) result = failure("BACKUP_RETAINED");
        else result = 0;
    } else result = failure("INVALID_OPERATION");
    close(dir);
    return result;
}
