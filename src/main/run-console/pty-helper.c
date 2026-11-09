// The only command this helper executes is the argv vector supplied by Ion.
// stdout carries terminal bytes, stderr carries helper status, and stdin
// carries length-prefixed input and window-resize requests.
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifdef __APPLE__
#include <util.h>
#else
#include <pty.h>
#endif

enum { max_payload = 16384, drain_ms = 250, stop_ms = 180 };

struct control {
    unsigned char header[3];
    size_t header_size;
    unsigned char bytes[max_payload];
    size_t size;
    size_t length;
    size_t sent;
};

struct output {
    unsigned char bytes[16384];
    size_t size;
    size_t sent;
};

static int wake_pipe[2] = {-1, -1};
static volatile sig_atomic_t stopping = 0;

static void wake(int signal_number) {
    int saved = errno;
    if (signal_number != SIGCHLD) stopping = 1;
    const unsigned char marker = 0;
    (void)write(wake_pipe[1], &marker, 1);
    errno = saved;
}

static void install_handler(int signal_number, void (*handler)(int)) {
    struct sigaction action = {0};
    action.sa_handler = handler;
    sigemptyset(&action.sa_mask);
    if (signal_number == SIGCHLD) action.sa_flags = SA_NOCLDSTOP;
    sigaction(signal_number, &action, NULL);
}

static int nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int64_t now_ms(void) {
    struct timespec clock;
    clock_gettime(CLOCK_MONOTONIC, &clock);
    return (int64_t)clock.tv_sec * 1000 + clock.tv_nsec / 1000000;
}

static int dimension(const char *value) {
    char *end;
    long size = strtol(value, &end, 10);
    return *value && !*end && size >= 2 && size <= 512 ? (int)size : 0;
}

static void signal_job(pid_t child, int signal_number) {
    // While its exit status is unconsumed, the leader's PID cannot be reused.
    // Signal the PID too in case Stop arrives before forkpty establishes the group.
    (void)kill(-child, signal_number);
    (void)kill(child, signal_number);
}

static int child_exited(pid_t child) {
    siginfo_t state = {0};
    return waitid(P_PID, (id_t)child, &state, WEXITED | WNOHANG | WNOWAIT) == 0 && state.si_pid == child;
}

static int read_control(struct control *frame, int master) {
    if (frame->header_size < sizeof(frame->header)) {
        ssize_t count = read(STDIN_FILENO, frame->header + frame->header_size, sizeof(frame->header) - frame->header_size);
        if (count <= 0) return count < 0 && (errno == EAGAIN || errno == EINTR);
        frame->header_size += (size_t)count;
        if (frame->header_size < sizeof(frame->header)) return 1;
        frame->length = (size_t)frame->header[1] * 256 + frame->header[2];
        const unsigned char kind = frame->header[0];
        if (kind == 'S' && !frame->length) return 0;
        if (kind == 'D' && frame->length && frame->length <= max_payload) return 1;
        if (kind == 'R' && frame->length == 4) return 1;
        return 0;
    }

    ssize_t count = read(STDIN_FILENO, frame->bytes + frame->size, frame->length - frame->size);
    if (count <= 0) return count < 0 && (errno == EAGAIN || errno == EINTR);
    frame->size += (size_t)count;
    if (frame->size == frame->length && frame->header[0] == 'R') {
        struct winsize size = {
            .ws_col = (unsigned short)(frame->bytes[0] * 256 + frame->bytes[1]),
            .ws_row = (unsigned short)(frame->bytes[2] * 256 + frame->bytes[3]),
        };
        if (size.ws_col >= 2 && size.ws_col <= 512 && size.ws_row >= 2 && size.ws_row <= 512)
            (void)ioctl(master, TIOCSWINSZ, &size);
        frame->header_size = frame->size = frame->length = 0;
    }
    return 1;
}

static void relay(pid_t child, int master, int *retained_slave) {
    struct control frame = {0};
    struct output output = {0};
    int64_t stop_deadline = 0;
    int64_t drain_deadline = 0;
    int exited = 0;
    int terminal_end = 0;

    for (;;) {
        const int64_t now = now_ms();
        if (!exited && child_exited(child)) {
            exited = 1;
            signal_job(child, SIGKILL);
            drain_deadline = now + drain_ms;
        }
        if (exited && terminal_end && !output.size) break;
        if (exited && now >= drain_deadline) {
            (void)write(STDERR_FILENO, "INCOMPLETE\n", 11);
            break;
        }
        if (!exited && stopping && !stop_deadline) {
            signal_job(child, SIGTERM);
            stop_deadline = now + stop_ms;
        } else if (!exited && stop_deadline && now >= stop_deadline) {
            signal_job(child, SIGKILL);
            stop_deadline = INT64_MAX;
        }

        const int input_ready = frame.length && frame.size == frame.length;
        const int read_input = !exited && !stopping && !input_ready;
        const int final_read = exited && *retained_slave >= 0 && !output.size;
        const short terminal_events =
            (!output.size ? POLLIN : 0) | (input_ready && !stopping && !exited ? POLLOUT : 0);
        struct pollfd fds[] = {
            {wake_pipe[0], POLLIN, 0},
            {!exited && !stopping ? STDIN_FILENO : -1, read_input ? POLLIN : 0, 0},
            {!terminal_end && terminal_events ? master : -1, terminal_events, 0},
            {output.size ? STDOUT_FILENO : -1, POLLOUT, 0},
        };
        const int64_t deadline = exited ? drain_deadline : stop_deadline;
        const int timeout = final_read ? 0 : (deadline && deadline != INT64_MAX ? (int)(deadline - now) : -1);
        if (poll(fds, sizeof(fds) / sizeof(*fds), timeout) < 0) {
            if (errno == EINTR) continue;
            signal_job(child, SIGKILL);
            break;
        }
        if (fds[0].revents & POLLIN) {
            unsigned char markers[64];
            while (read(wake_pipe[0], markers, sizeof(markers)) > 0) {}
        }
        if (fds[1].revents & (POLLHUP | POLLERR | POLLNVAL)) stopping = 1;
        if (read_input && !stopping && fds[1].revents & POLLIN && !read_control(&frame, master)) stopping = 1;
        if (fds[2].revents & (POLLHUP | POLLERR | POLLNVAL)) {
            frame.header_size = frame.size = frame.length = frame.sent = 0;
        } else if (fds[2].revents & POLLOUT && input_ready && !stopping) {
            ssize_t count = write(master, frame.bytes + frame.sent, frame.size - frame.sent);
            if (count > 0) frame.sent += (size_t)count;
            if (frame.sent == frame.size || (count < 0 && errno != EAGAIN && errno != EINTR)) {
                frame.header_size = frame.size = frame.length = frame.sent = 0;
            }
        }
        if (final_read || (fds[2].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL) && !output.size)) {
            ssize_t count;
            do {
                count = read(master, output.bytes, sizeof(output.bytes));
            } while (count < 0 && errno == EINTR);
            if (count > 0) output.size = (size_t)count;
            else {
                if (!count || errno != EAGAIN) terminal_end = 1;
                if (final_read) {
                    close(*retained_slave);
                    *retained_slave = -1;
                }
            }
        }
        if (fds[3].revents & (POLLOUT | POLLHUP | POLLERR | POLLNVAL)) {
            ssize_t count = write(STDOUT_FILENO, output.bytes + output.sent, output.size - output.sent);
            if (count > 0) output.sent += (size_t)count;
            if (output.sent == output.size) output.sent = output.size = 0;
            else if (count < 0 && errno != EAGAIN && errno != EINTR) {
                // The child may be waiting for its tty to drain. Let main
                // close the master before it waits for the child to exit.
                signal_job(child, SIGKILL);
                break;
            }
        }
    }
}

int main(int argc, char **argv) {
    int columns = argc >= 4 ? dimension(argv[1]) : 0;
    int rows = argc >= 4 ? dimension(argv[2]) : 0;
    if (!columns || !rows || argv[3][0] != '/') return 125;

    if (pipe(wake_pipe) < 0 || nonblocking(wake_pipe[0]) < 0 || nonblocking(wake_pipe[1]) < 0) {
        perror("Ion PTY signal pipe");
        return 125;
    }
    install_handler(SIGCHLD, wake);
    install_handler(SIGTERM, wake);
    install_handler(SIGINT, wake);
    install_handler(SIGHUP, wake);
    install_handler(SIGPIPE, SIG_IGN);

    int master = -1;
    int retained_slave = -1;
    struct winsize size = {.ws_col = (unsigned short)columns, .ws_row = (unsigned short)rows};
#ifdef __APPLE__
    // Darwin can discard unread output as the last slave fd closes. Keep our
    // slave fd until the relay has read any queued bytes after the child exits.
    // https://bugs.ruby-lang.org/issues/20682
    if (openpty(&master, &retained_slave, NULL, NULL, &size) < 0) {
        perror("Ion PTY");
        return 125;
    }
    pid_t child = fork();
#else
    pid_t child = forkpty(&master, NULL, NULL, &size);
#endif
    if (child < 0) {
        perror("Ion PTY");
        return 125;
    }
    if (!child) {
#ifdef __APPLE__
        close(master);
        if (login_tty(retained_slave) < 0) {
            perror("Ion controlling terminal");
            _exit(125);
        }
#endif
        install_handler(SIGCHLD, SIG_DFL);
        install_handler(SIGTERM, SIG_DFL);
        install_handler(SIGINT, SIG_DFL);
        install_handler(SIGHUP, SIG_DFL);
        install_handler(SIGPIPE, SIG_DFL);
        close(wake_pipe[0]);
        close(wake_pipe[1]);
        struct rlimit core_limit = {0, 0};
        (void)setrlimit(RLIMIT_CORE, &core_limit);
        execv(argv[3], &argv[3]);
        perror("Unable to launch program");
        _exit(127);
    }

    (void)dprintf(STDERR_FILENO, "READY %ld\n", (long)child);
    if (nonblocking(master) < 0 || nonblocking(STDIN_FILENO) < 0 || nonblocking(STDOUT_FILENO) < 0) {
        signal_job(child, SIGKILL);
    } else {
        relay(child, master, &retained_slave);
    }
    close(master);
    if (retained_slave >= 0) close(retained_slave);

    int status;
    pid_t waited;
    do {
        waited = waitpid(child, &status, 0);
    } while (waited < 0 && errno == EINTR);
    if (waited != child) return 125;
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) {
        const int signal_number = WTERMSIG(status);
        install_handler(signal_number, SIG_DFL);
        sigset_t unblocked;
        sigemptyset(&unblocked);
        sigaddset(&unblocked, signal_number);
        sigprocmask(SIG_UNBLOCK, &unblocked, NULL);
        struct rlimit core_limit = {0, 0};
        (void)setrlimit(RLIMIT_CORE, &core_limit);
        raise(signal_number);
    }
    return 125;
}
