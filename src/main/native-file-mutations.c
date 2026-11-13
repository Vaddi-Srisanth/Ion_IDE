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

#if defined(__APPLE__)
#include <sys/acl.h>
#include <sys/xattr.h>
#endif

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
    mode_t creation_mode = (mode_t)(mode & 0777);
#if defined(__APPLE__)
    if (mode & 01000) creation_mode = 0600;
#endif
    int file = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, creation_mode);
    if (file < 0) return system_failure(errno);
    unsigned char buffer[65536];
    size_t total = 0;
    int error = 0;
#if defined(__APPLE__)
    // An inherited parent ACL can grant access even when POSIX mode is 0600.
    // Remove inheritance before any source bytes enter an unpublished inode.
    if (mode & 01000) {
        acl_t empty = acl_init(0);
        if (!empty) error = errno;
        else {
            if (acl_set_fd_np(file, empty, ACL_TYPE_EXTENDED)) error = errno;
            acl_free(empty);
            if (!error && fchmod(file, 0600)) error = errno;
        }
    }
#endif
    while (!error) {
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
#if !defined(__APPLE__)
    if (!error && (mode & 01000) && fchmod(file, (mode_t)(mode & 0777))) error = errno;
#endif
    if (!error && fsync(file)) error = errno;
    if (error) {
        struct stat actual, created;
        if (!fstat(file, &created) && !fstatat(dir, name, &actual, AT_SYMLINK_NOFOLLOW)
            && created.st_ino == actual.st_ino && created.st_dev == actual.st_dev) unlinkat(dir, name, 0);
    }
    close(file);
    return error ? system_failure(error) : 0;
}

#if defined(__APPLE__)
// Source saves replace an inode. Copy supported security/extended metadata to
// the unpublished inode first, through nofollow descriptors in the pinned dir.
// Bounds apply only to explicit saves; no metadata is retained after this exits.
static int same_metadata_revision(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino
        && a->st_mode == b->st_mode && a->st_uid == b->st_uid && a->st_gid == b->st_gid
        && a->st_size == b->st_size
        && a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec
        && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec
        && a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec
        && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}

static int copy_replacement_metadata(int dir, const char *from, const char *to) {
    const size_t max_names = 64 * 1024, max_attribute = 1024 * 1024, max_total = 4 * 1024 * 1024;
    int source = -1, staged = -1, error = 0;
    char *names = NULL;
    void *value = NULL;
    acl_t acl = NULL;
    size_t total = 0, count = 0;
    struct stat original, created, latest;
    source = openat(dir, from, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (source < 0) { error = errno; goto done; }
    staged = openat(dir, to, O_RDWR | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (staged < 0) { error = errno; goto done; }
    if (fstat(source, &original) || fstat(staged, &created)) { error = errno; goto done; }
    if (!S_ISREG(original.st_mode) || !S_ISREG(created.st_mode)
        || (original.st_dev == created.st_dev && original.st_ino == created.st_ino)) { error = EINVAL; goto done; }
    if (fstatat(dir, from, &latest, AT_SYMLINK_NOFOLLOW)) { error = errno; goto done; }
    if (!same_metadata_revision(&original, &latest)) { error = EBUSY; goto done; }
    if (fstatat(dir, to, &latest, AT_SYMLINK_NOFOLLOW)) { error = errno; goto done; }
    if (created.st_dev != latest.st_dev || created.st_ino != latest.st_ino) { error = EBUSY; goto done; }

    // Ownership changes can clear mode bits, so preserve ownership before mode.
    // Never gain privileges to do so: failure leaves the original untouched.
    if ((created.st_uid != original.st_uid || created.st_gid != original.st_gid)
        && fchown(staged, original.st_uid, original.st_gid)) { error = errno; goto done; }

    // Options=0 intentionally excludes the filesystem's compression metadata.
    // Do not copy old source bytes or timestamps into the newly edited document.
    ssize_t length = flistxattr(source, NULL, 0, 0);
    if (length < 0) { error = errno; goto done; }
    if ((size_t)length > max_names) { error = EFBIG; goto done; }
    if (length) {
        names = malloc((size_t)length);
        if (!names) { error = ENOMEM; goto done; }
        ssize_t read_names = flistxattr(source, names, (size_t)length, 0);
        if (read_names != length) { error = read_names < 0 ? errno : EBUSY; goto done; }
        for (size_t offset = 0; offset < (size_t)length;) {
            const char *name = names + offset;
            size_t name_length = strnlen(name, (size_t)length - offset);
            if (!name_length || name_length == (size_t)length - offset || ++count > 128) { error = EFBIG; goto done; }
            offset += name_length + 1;
            ssize_t size = fgetxattr(source, name, NULL, 0, 0, 0);
            if (size < 0) { error = errno; goto done; }
            if ((size_t)size > max_attribute || (size_t)size > max_total - total) { error = EFBIG; goto done; }
            total += (size_t)size;
            void *next = realloc(value, size ? (size_t)size : 1);
            if (!next) { error = ENOMEM; goto done; }
            value = next;
            ssize_t copied = fgetxattr(source, name, value, size ? (size_t)size : 1, 0, 0);
            if (copied != size) { error = copied < 0 ? errno : EBUSY; goto done; }
            if (fsetxattr(staged, name, value, (size_t)size, 0, 0)) { error = errno; goto done; }
        }
    }

    // An empty ACL also matters: it must replace inherited staging permissions.
    // Unsupported/inaccessible ACLs are errors, never silent success.
    acl = acl_get_fd_np(source, ACL_TYPE_EXTENDED);
    // macOS reports ENOENT for a regular file with no extended ACL. That is
    // verified absence, not a permission/read failure: clear staging inheritance.
    if (!acl && errno == ENOENT) acl = acl_init(0);
    if (!acl) { error = errno; goto done; }
    ssize_t acl_bytes = acl_size(acl);
    if (acl_bytes < 0) { error = errno; goto done; }
    if (acl_bytes > 64 * 1024) { error = EFBIG; goto done; }
    if (acl_set_fd_np(staged, acl, ACL_TYPE_EXTENDED)) { error = errno; goto done; }
    // Install restrictions before widening the private staging mode.
    if (fchmod(staged, original.st_mode & 0777)) { error = errno; goto done; }
    if (fsync(staged)) { error = errno; goto done; }
    if (fstat(source, &latest)) { error = errno; goto done; }
    if (!same_metadata_revision(&original, &latest)) { error = EBUSY; goto done; }
    if (fstatat(dir, from, &latest, AT_SYMLINK_NOFOLLOW)) { error = errno; goto done; }
    if (!same_metadata_revision(&original, &latest)) error = EBUSY;
done:
    if (acl) acl_free(acl);
    free(value);
    free(names);
    if (staged >= 0) close(staged);
    if (source >= 0) close(source);
    return error;
}
#endif

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
#if defined(__APPLE__)
        int error = copy_replacement_metadata(dir, argv[4], argv[3]);
        if (error) { close(dir); return system_failure(error); }
#endif
        // The exchange publishes the staged file and moves the displaced entry
        // to a private name in a single atomic operation.
        if (rename_entry(dir, argv[3], dir, argv[4], 1)) result = system_failure(errno);
        else if (rename_entry(dir, argv[3], dir, argv[7], 0)) result = failure("BACKUP_RETAINED");
        else result = 0;
    } else result = failure("INVALID_OPERATION");
    close(dir);
    return result;
}
