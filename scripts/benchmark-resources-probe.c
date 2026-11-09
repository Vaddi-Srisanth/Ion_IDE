#include <inttypes.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>

static uint64_t nanoseconds(uint64_t ticks, mach_timebase_info_data_t scale) {
  return (uint64_t)((__uint128_t)ticks * scale.numer / scale.denom);
}

int main(int argc, char *argv[]) {
  mach_timebase_info_data_t scale;
  if (mach_timebase_info(&scale) != KERN_SUCCESS || scale.denom == 0) return 1;
  if (argc == 2 && strcmp(argv[1], "--timebase") == 0) {
    printf("%u %u\n", scale.numer, scale.denom);
    return 0;
  }
  for (int index = 1; index < argc; index++) {
    int pid = atoi(argv[index]);
    struct rusage_info_v2 sample;
    if (pid <= 0 || proc_pid_rusage(pid, RUSAGE_INFO_V2, (rusage_info_t *)&sample) != 0) continue;
    printf("%d %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n", pid,
      sample.ri_phys_footprint, nanoseconds(sample.ri_user_time + sample.ri_system_time, scale),
      nanoseconds(sample.ri_child_user_time + sample.ri_child_system_time, scale),
      sample.ri_pkg_idle_wkups);
  }
  return 0;
}
