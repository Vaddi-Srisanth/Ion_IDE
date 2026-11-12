#import <AppKit/AppKit.h>
#import <Security/Security.h>
#include <libproc.h>
#include <sys/event.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>

// A short-lived, unprivileged helper. No shell, services, force quit, or
// quarantine removal. It starts only after Ion's normal save/quit approval.
static NSString *const identifier = @"dev.ionide.desktop";

static BOOL regularDirectory(NSString *path, struct stat *info) {
  return lstat(path.fileSystemRepresentation, info) == 0 && S_ISDIR(info->st_mode);
}

static NSDictionary *codeInfo(NSString *bundle) {
  SecStaticCodeRef code = NULL;
  CFDictionaryRef info = NULL;
  if (SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:bundle], kSecCSDefaultFlags, &code) != errSecSuccess) return nil;
  OSStatus status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures, NULL);
  if (status == errSecSuccess) status = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info);
  CFRelease(code);
  if (status != errSecSuccess || !info) return nil;
  return CFBridgingRelease(info);
}

static BOOL validPair(NSString *target, NSString *candidate, NSString *version, dev_t device, ino_t inode) {
  struct stat original, replacement;
  if (!regularDirectory(target, &original) || original.st_dev != device || original.st_ino != inode
      || !regularDirectory(candidate, &replacement) || replacement.st_dev != device) return NO;
  NSDictionary *before = codeInfo(target), *after = codeInfo(candidate);
  if (![before[(__bridge NSString *)kSecCodeInfoIdentifier] isEqual:identifier]
      || ![after[(__bridge NSString *)kSecCodeInfoIdentifier] isEqual:identifier]) return NO;
  NSString *team = before[(__bridge NSString *)kSecCodeInfoTeamIdentifier];
  if (team.length && ![team isEqual:after[(__bridge NSString *)kSecCodeInfoTeamIdentifier]]) return NO;
  NSDictionary *a = [NSDictionary dictionaryWithContentsOfURL:[NSURL fileURLWithPath:[target stringByAppendingPathComponent:@"Contents/Info.plist"]]];
  NSDictionary *b = [NSDictionary dictionaryWithContentsOfURL:[NSURL fileURLWithPath:[candidate stringByAppendingPathComponent:@"Contents/Info.plist"]]];
  return [a[@"CFBundleIdentifier"] isEqual:identifier] && [b[@"CFBundleIdentifier"] isEqual:identifier]
    && [b[@"CFBundleShortVersionString"] isEqual:version]
    && [a[@"CFBundleShortVersionString"] compare:version options:NSNumericSearch] == NSOrderedAscending;
}

static BOOL parentMatches(pid_t pid, NSString *target) {
  char executable[PROC_PIDPATHINFO_MAXSIZE];
  return proc_pidpath(pid, executable, sizeof(executable)) > 0
    && [[NSString stringWithUTF8String:executable] isEqual:[target stringByAppendingPathComponent:@"Contents/MacOS/Ion IDE"]];
}

static void result(NSString *profile, NSString *state, NSString *version, NSString *message) {
  // The profile is supplied by the trusted main process, never the renderer.
  NSString *directory = [profile stringByAppendingPathComponent:@"updates"];
  struct stat info;
  if (!regularDirectory(directory, &info) || info.st_uid != getuid()) return;
  NSDictionary *value = @{ @"schemaVersion": @1, @"state": state, @"version": version,
    @"message": message, @"timestamp": [[NSDate date] description] };
  NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
  [json writeToFile:[directory stringByAppendingPathComponent:@"result.json"] options:NSDataWritingAtomic error:NULL];
}

static BOOL archive(NSString *previous, NSString *profile) {
  NSString *directory = [profile stringByAppendingPathComponent:@"updates"];
  NSString *temporary = [directory stringByAppendingPathComponent:@"rollback.zip.part"];
  NSString *backup = [directory stringByAppendingPathComponent:@"rollback.zip"];
  NSTask *task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/ditto"];
  task.arguments = @[@"-c", @"-k", @"--sequesterRsrc", @"--keepParent", previous, temporary];
  task.standardOutput = [NSFileHandle fileHandleWithNullDevice];
  task.standardError = [NSFileHandle fileHandleWithNullDevice];
  NSError *error = nil;
  if (![task launchAndReturnError:&error]) return NO;
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:180];
  while (task.running && deadline.timeIntervalSinceNow > 0) [NSThread sleepForTimeInterval:0.1];
  if (task.running) {
    [task terminate];
    NSDate *grace = [NSDate dateWithTimeIntervalSinceNow:2];
    while (task.running && grace.timeIntervalSinceNow > 0) [NSThread sleepForTimeInterval:0.05];
    if (task.running) kill(task.processIdentifier, SIGKILL);
    return NO;
  }
  if (task.terminationStatus != 0) return NO;
  return rename(temporary.fileSystemRepresentation, backup.fileSystemRepresentation) == 0;
}

static BOOL launch(NSString *target, NSString *profile) {
  __block BOOL finished = NO, successful = NO;
  NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
  configuration.arguments = @[[NSString stringWithFormat:@"--user-data-dir=%@", profile]];
  [[NSWorkspace sharedWorkspace] openApplicationAtURL:[NSURL fileURLWithPath:target]
    configuration:configuration completionHandler:^(NSRunningApplication *application, NSError *error) {
      successful = application != nil && error == nil;
      finished = YES;
    }];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:60];
  while (!finished && deadline.timeIntervalSinceNow > 0) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  // A pending OS approval is not proof of failure. Do not replace its target
  // while Gatekeeper may still be asking the user. They can open Ion manually.
  return !finished || successful;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 17 && argc != 19) { fprintf(stderr, "Invalid update request.\n"); return 2; }
    NSMutableDictionary *args = [NSMutableDictionary dictionary];
    NSSet *allowed = [NSSet setWithArray:@[@"--parent", @"--target", @"--stage", @"--version", @"--profile", @"--device", @"--inode", @"--protocol", @"--timeout-ms"]];
    for (int i = 1; i + 1 < argc; i += 2) {
      NSString *key = @(argv[i]);
      if (args[key] || ![allowed containsObject:key]) return 2;
      args[key] = @(argv[i + 1]);
    }
    for (NSString *key in allowed) if (![key isEqual:@"--timeout-ms"] && ![args[key] length]) return 2;
    NSCharacterSet *notDigits = [[NSCharacterSet decimalDigitCharacterSet] invertedSet];
    for (NSString *key in @[@"--parent", @"--device", @"--inode"]) {
      if ([args[key] rangeOfCharacterFromSet:notDigits].location != NSNotFound || [args[key] length] > 19) return 2;
    }
    NSString *target = args[@"--target"], *stage = args[@"--stage"], *version = args[@"--version"], *profile = args[@"--profile"];
    pid_t parent = [args[@"--parent"] intValue];
    dev_t device = (dev_t)strtoull([args[@"--device"] UTF8String], NULL, 10);
    ino_t inode = (ino_t)strtoull([args[@"--inode"] UTF8String], NULL, 10);
    // The exact number of options is deliberately fixed; arbitrary commands
    // and arbitrary replacement destinations are not a helper capability.
    if (![args[@"--protocol"] isEqual:@"1"] || parent <= 1 || !target.isAbsolutePath || !stage.isAbsolutePath || !profile.isAbsolutePath
        || ![target.lastPathComponent isEqual:@"Ion IDE.app"]
        || ![stage.stringByDeletingLastPathComponent isEqual:target.stringByDeletingLastPathComponent]
        || ![stage.lastPathComponent hasPrefix:@".ion-update-"] || ![stage hasSuffix:@".noindex"]) return 2;
    struct stat staging;
    NSString *candidate = [stage stringByAppendingPathComponent:@"Ion IDE.app"];
    if (!regularDirectory(stage, &staging) || staging.st_uid != getuid() || (staging.st_mode & 077) != 0
        || !parentMatches(parent, target) || !validPair(target, candidate, version, device, inode)) {
      fprintf(stderr, "Update validation failed; the installed Ion IDE was not changed.\n"); return 3;
    }
    struct stat candidateIdentity;
    if (!regularDirectory(candidate, &candidateIdentity)) return 3;
    NSData *candidateHash = codeInfo(candidate)[(__bridge NSString *)kSecCodeInfoUnique];
    NSData *originalHash = codeInfo(target)[(__bridge NSString *)kSecCodeInfoUnique];
    if (!candidateHash || !originalHash) return 3;
    long milliseconds = args[@"--timeout-ms"] ? [args[@"--timeout-ms"] longLongValue] : 120000;
    if (milliseconds < 10 || milliseconds > 120000) return 2;
    int queue = kqueue();
    struct kevent change, event;
    EV_SET(&change, parent, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
    if (queue < 0 || kevent(queue, &change, 1, NULL, 0, NULL) < 0) return 4;
    printf("READY\n"); fflush(stdout);
    struct timespec timeout = {milliseconds / 1000, (milliseconds % 1000) * 1000000};
    int count = kevent(queue, NULL, 0, &event, 1, &timeout);
    close(queue);
    if (count != 1 || (event.flags & EV_ERROR)) {
      result(profile, @"failed", version, @"Ion did not finish quitting. The original application is unchanged."); return 5;
    }
    struct stat currentCandidate;
    if (!regularDirectory(candidate, &currentCandidate) || currentCandidate.st_ino != candidateIdentity.st_ino
        || currentCandidate.st_dev != candidateIdentity.st_dev || !validPair(target, candidate, version, device, inode)
        || ![candidateHash isEqual:codeInfo(candidate)[(__bridge NSString *)kSecCodeInfoUnique]]
        || ![originalHash isEqual:codeInfo(target)[(__bridge NSString *)kSecCodeInfoUnique]]) {
      result(profile, @"failed", version, @"The application changed during the update. Download the update again."); return 6;
    }
    // Same-volume atomic exchange: there is never a missing application path.
    if (renamex_np(target.fileSystemRepresentation, candidate.fileSystemRepresentation, RENAME_SWAP) != 0) {
      result(profile, @"failed", version, @"Could not replace Ion. The original application is unchanged."); return 7;
    }
    BOOL backedUp = archive(candidate, profile);
    BOOL opened = launch(target, profile);
    result(profile, @"installed", version, !opened ? @"Ion was updated in place. macOS did not open it; open Ion from Applications and follow any macOS security approval. A local rollback copy was retained."
      : backedUp ? @"Updated the existing Ion IDE installation. A local rollback archive is available."
      : @"Updated the existing Ion IDE installation. The previous app was retained in hidden update staging because backup failed.");
    if (backedUp) [[NSFileManager defaultManager] removeItemAtPath:stage error:NULL];
    return 0;
  }
}
