# Diagnostic lane A only. Trusted shipped code; never dot-source workspace code.
# Native Windows verification is required. No profile, module or shell startup
# commands are loaded. Run with an explicit PowerShell 7 x64 executable.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ManifestPath)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'Stop'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$runId = 'preflight'
$executionStarted = $false

function Assert-PlainPath([string]$Path, [bool]$MustExist = $true) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.Path]::IsPathFullyQualified($Path) -or
        $Path.StartsWith('\\') -or $Path.StartsWith('\\?\') -or $Path.Substring(2).Contains(':')) {
        throw 'Only absolute local drive paths without devices or alternate streams are permitted.'
    }
    $full = [System.IO.Path]::GetFullPath($Path)
    $cursor = $full
    if ($MustExist -and -not [System.IO.File]::Exists($full) -and -not [System.IO.Directory]::Exists($full)) {
        throw 'Required diagnostic path does not exist.'
    }
    while ($cursor.Length -gt 3) {
        if ([System.IO.File]::Exists($cursor) -or [System.IO.Directory]::Exists($cursor)) {
            $attrs = [System.IO.File]::GetAttributes($cursor)
            if (($attrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse paths are not permitted.' }
        }
        $cursor = [System.IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}
function Assert-InWorkspace([string]$Path, [string]$Workspace, [bool]$MustExist = $true) {
    $full = Assert-PlainPath $Path $MustExist
    $prefix = $Workspace.TrimEnd('\') + '\'
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Diagnostic path escapes the disposable workspace.'
    }
    return $full
}

try {
    if (-not $IsWindows -or -not [Environment]::Is64BitProcess -or
        [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString() -ne 'X64' -or
        $PSVersionTable.PSVersion.Major -lt 7) { throw 'Genuine Windows x64 and PowerShell 7 x64 are required.' }
    $manifestFile = Assert-PlainPath $ManifestPath
    if ([System.IO.FileInfo]::new($manifestFile).Length -gt 65536) { throw 'Manifest exceeds its 64 KiB bound.' }
    $manifest = [System.IO.File]::ReadAllText($manifestFile) | ConvertFrom-Json -AsHashtable
    if ($manifest.schemaVersion -ne 1 -or $manifest.lane -ne 'A' -or
        $manifest.runId -notmatch '^(?:first-[ABC]|warm-(?:[1-9][0-9]?|100)-[ABC])$') { throw 'Invalid diagnostic manifest identity.' }
    $runId = [string]$manifest.runId
    $workspace = (Assert-PlainPath ([string]$manifest.workspace)).TrimEnd('\')
    if (-not [System.IO.Directory]::Exists($workspace)) { throw 'Workspace must be a pre-created disposable directory.' }
    $null = Assert-InWorkspace $manifestFile $workspace
    $cwd = Assert-PlainPath ([string]$manifest.cwd)
    if (-not $cwd.StartsWith($workspace + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Working directory must remain in the disposable workspace.' }
    $source = Assert-InWorkspace ([string]$manifest.source) $workspace
    $output = Assert-InWorkspace ([string]$manifest.output) $workspace $false
    if ([System.IO.Path]::GetDirectoryName($source) -ne $cwd -or
        [System.IO.Path]::GetDirectoryName($output) -ne $cwd -or
        [System.IO.Path]::GetFileName($source) -ne 'latency-probe.c' -or
        [System.IO.Path]::GetFileName($output) -ne 'latency-probe.exe') { throw 'Only the fixed diagnostic fixture names are permitted.' }
    $expectedSource = '#include <stdio.h>' + "`n" + 'int main(void) { puts("ION-GCC-LATENCY"); return 0; }' + "`n"
    if ([System.IO.File]::ReadAllText($source) -cne $expectedSource) { throw 'Source differs from the fixed diagnostic fixture.' }
    $compiler = Assert-PlainPath ([string]$manifest.compiler)
    if ([System.IO.Path]::GetFileName($compiler) -ine 'gcc.exe' -or
        $compiler.StartsWith($workspace + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'An explicitly selected installed GCC outside the disposable workspace is required.'
    }
    $expectedArgs = @('-x', 'c', '-std=c17', '-Wall', '-Wextra', '-fdiagnostics-color=never', $source, '-o', $output)
    if ($manifest.args -isnot [System.Array] -or $manifest.args.Count -ne $expectedArgs.Count) { throw 'Compiler arguments do not match the fixed workload.' }
    for ($i = 0; $i -lt $expectedArgs.Count; $i++) {
        if ([string]$manifest.args[$i] -cne $expectedArgs[$i]) { throw 'Compiler arguments do not match the fixed workload.' }
    }
    if ($manifest.timeoutMs -ne 15000 -or $manifest.outputBytes -ne 65536) { throw 'Diagnostic production deadline/output bound cannot be changed.' }
    if ($manifest.environment -isnot [System.Collections.IDictionary] -or
        $manifest.environment.Count -gt 128) { throw 'Invalid bounded explicit environment.' }
    $environment = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($key in $manifest.environment.Keys) {
        $value = [string]$manifest.environment[$key]
        if ([string]$key -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,127}$' -or $value.Length -gt 8192 -or
            $value.Contains([char]0)) { throw 'Invalid diagnostic environment entry.' }
        $environment.Add([string]$key, $value)
    }
    foreach ($key in @('TEMP', 'TMP', 'HOME', 'USERPROFILE')) {
        if (-not $environment.ContainsKey($key)) { throw 'Private TEMP/TMP/HOME/USERPROFILE environment is required.' }
        $privateDirectory = Assert-PlainPath $environment[$key]
        if (-not $privateDirectory.Equals($workspace, [System.StringComparison]::OrdinalIgnoreCase) -and
            -not $privateDirectory.StartsWith($workspace + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Temporary and home paths must remain in the disposable workspace.'
        }
    }
    foreach ($key in @('GCC_EXEC_PREFIX', 'COMPILER_PATH', 'LIBRARY_PATH', 'CPATH', 'C_INCLUDE_PATH',
        'CPLUS_INCLUDE_PATH', 'OBJC_INCLUDE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS',
        'BASH_ENV', 'ENV', 'PSModulePath')) {
        if ($environment.ContainsKey($key)) { throw 'Executable/library override environment variables are forbidden.' }
    }
    if (-not $environment.ContainsKey('PATH')) { throw 'An explicit safe PATH is required.' }
    foreach ($entry in $environment['PATH'].Split(';')) {
        if ([string]::IsNullOrWhiteSpace($entry)) { throw 'PATH cannot contain current-directory search entries.' }
        $pathEntry = Assert-PlainPath $entry
        if ($pathEntry.Equals($workspace, [System.StringComparison]::OrdinalIgnoreCase) -or
            $pathEntry.StartsWith($workspace + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'PATH cannot search the diagnostic workspace.'
        }
    }

    # This fixed implementation is compiled in memory. It creates no service,
    # registry setting, script file, persistent process or network request.
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class IonGccDirectEvent {
    public double ms { get; set; }
    public string stage { get; set; }
    public string @event { get; set; }
    public int? pid { get; set; }
    public double? value { get; set; }
}
public sealed class IonGccDirectResult {
    public string state { get; set; } = "error";
    public int? exitCode { get; set; }
    public double elapsedMs { get; set; }
    public bool outputComplete { get; set; }
    public bool cleanupVerified { get; set; }
    public string stdoutTail { get; set; } = "";
    public string stderrTail { get; set; } = "";
    public long stdoutBytes { get; set; }
    public long stderrBytes { get; set; }
    public int? compilerPid { get; set; }
    public int controllerPid { get; set; }
    public int? payloadPid { get; set; }
    public bool overflow { get; set; }
    public IonGccDirectEvent[] events { get; set; } = Array.Empty<IonGccDirectEvent>();
    public string detail { get; set; } = "";
    public IonGccObserverFailure observerFailure { get; set; }
    public int observerFailureCount { get; set; }
    public bool compilerResultValid { get; set; }
    public string clock { get; set; } = "Stopwatch: native adapter origin; not Node performance.now or kernel exit time";
    public string childLifecycleScope { get; set; } = "100 ms bounded Job membership snapshots; short-lived children may be missed";
}

// The only observer-error fields intended for export. No exception messages,
// stack traces, paths, environment values or arbitrary type names are retained.
public sealed class IonGccObserverFailure {
    public string category { get; set; }
    public string managedType { get; set; }
    public int? nativeErrorCode { get; set; }
    public string operation { get; set; }
    public string lifecycleStage { get; set; }
    public bool? ownedProcessAlreadyExited { get; set; }
    public bool cleanupCompleted { get; set; }
    public bool compilerResultValid { get; set; }
    public int? snapshotAssigned { get; set; }
    public int? snapshotListed { get; set; }
}

public static class IonGccDirect {
    const uint KILL_ON_JOB_CLOSE = 0x2000, ACTIVE_PROCESS = 8;
    const int BASIC_PID_LIST = 3, EXTENDED_LIMIT = 9;
    const uint PROCESS_TERMINATE = 1, QUERY_LIMITED = 0x1000;
    const uint MAX_CHILDREN = 64;
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
        public uint active; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
        public BASIC_LIMITS basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attr, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMITS data, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    static readonly HashSet<string> Operations = new HashSet<string>(StringComparer.Ordinal) {
        "job-create", "job-set-limits", "job-assign-controller", "job-verify-controller", "job-pre-spawn-snapshot",
        "job-member-query", "job-member-counts", "job-member-pid", "job-member-set", "job-sample", "job-sample-controller",
        "job-drain", "job-open-child-handle", "job-check-child-membership", "job-stop-owned-child", "job-drain-deadline",
        "process-start-info", "process-start", "process-verify-inherited-job", "process-close-stdin", "process-wait",
        "process-has-exited", "process-read-exit-code", "process-wait-after-stop", "process-exact-stop",
        "stream-read-stdout", "stream-read-stderr", "stream-reader-wait", "stream-reader-close", "stream-reader-status",
        "job-release-limits", "job-close-handle", "process-dispose", "trace-event", "unknown"
    };
    static readonly HashSet<string> Stages = new HashSet<string>(StringComparer.Ordinal) {
        "ownership-setup", "compiler-start", "compiler-execution", "cleanup", "stream-shutdown", "observer-snapshot", "result-delivery", "unknown"
    };
    [ThreadStatic] static string currentOperation;
    [ThreadStatic] static string currentStage;
    [ThreadStatic] static int? snapshotAssigned;
    [ThreadStatic] static int? snapshotListed;
    public static IonGccObserverFailure LastObserverFailure { get; private set; }
    static void Mark(string stage, string operation) {
        currentStage=Stages.Contains(stage??"")?stage:"unknown";
        currentOperation=Operations.Contains(operation??"")?operation:"unknown";
    }
    static string NativeOperation(string name) {
        switch(name) {
            case "CreateJobObject": return "job-create";
            case "SetInformationJobObject": return "job-set-limits";
            case "Assign controller to Job before compiler spawn": return "job-assign-controller";
            case "Verify controller Job": return "job-verify-controller";
            case "QueryInformationJobObject": return "job-member-query";
            case "IsProcessInJob child": return "job-check-child-membership";
            case "Verify compiler inherited Job": return "process-verify-inherited-job";
            case "Release empty controller-only Job": return "job-release-limits";
            default: return "unknown";
        }
    }
    static void Check(bool result, string name) {
        // Preserve the immediate last-error value before any other interop.
        int code=result?0:Marshal.GetLastWin32Error();
        currentOperation=NativeOperation(name);
        if(!result)throw new Win32Exception(code);
    }
    public static IonGccObserverFailure DescribeFailure(Exception error,string operation,string stage,
        bool? exited,bool cleaned,bool compilerValid) {
        string type="other";
        if(error is Win32Exception)type="System.ComponentModel.Win32Exception";
        else if(error is ObjectDisposedException)type="System.ObjectDisposedException";
        else if(error is InvalidOperationException)type="System.InvalidOperationException";
        else if(error is IOException)type="System.IO.IOException";
        else if(error is AggregateException)type="System.AggregateException";
        else if(error is OperationCanceledException)type="System.OperationCanceledException";
        else if(error is ArgumentException)type="System.ArgumentException";
        int? native=null;
        Exception codeSource=error;
        for(int depth=0;depth<4&&codeSource is AggregateException;depth++) {
            var aggregate=(AggregateException)codeSource;
            if(aggregate.InnerExceptions.Count!=1)break;
            codeSource=aggregate.InnerExceptions[0];
        }
        if(codeSource is Win32Exception&&((Win32Exception)codeSource).NativeErrorCode>=0)native=((Win32Exception)codeSource).NativeErrorCode;
        string safeOperation=Operations.Contains(operation??"")?operation:"unknown";
        string safeStage=Stages.Contains(stage??"")?stage:"unknown";
        string category=native!=null?"native-api-failure":error is ObjectDisposedException?"handle-lifetime":
            safeOperation=="job-member-counts"||safeOperation=="job-member-pid"||safeOperation=="job-sample-controller"||
                safeOperation=="job-pre-spawn-snapshot"||safeOperation=="job-verify-controller"||safeOperation=="process-verify-inherited-job"?"membership-invariant":
            safeOperation.StartsWith("stream-",StringComparison.Ordinal)?"stream-observer-failure":
            safeOperation=="trace-event"?"evidence-capacity":error is AggregateException?"synchronization-failure":"managed-observer-failure";
        return new IonGccObserverFailure { category=category,managedType=type,nativeErrorCode=native,operation=safeOperation,
            lifecycleStage=safeStage,ownedProcessAlreadyExited=exited,cleanupCompleted=cleaned,compilerResultValid=compilerValid };
    }
    static bool? Exited(Process child) { if(child==null)return null;try{return child.HasExited;}catch{return null;} }
    static void Failure(IonGccDirectResult result,Exception error,Process child) {
        result.state="error";result.observerFailureCount=Math.Min(16,result.observerFailureCount+1);
        if(result.observerFailure==null) {
            result.observerFailure=DescribeFailure(error,currentOperation,currentStage,Exited(child),false,false);
            if(currentOperation=="job-member-counts"||currentOperation=="job-member-pid") {
                result.observerFailure.snapshotAssigned=snapshotAssigned;
                result.observerFailure.snapshotListed=snapshotListed;
            }
        }
        result.detail=result.observerFailure.category;
        LastObserverFailure=result.observerFailure;
    }
    public static void ValidateMemberCounts(int assigned,int count) {
        if(assigned<0||count<0||count>64||count!=assigned)throw new InvalidOperationException("Incomplete Job membership snapshot.");
    }
    public static void CompleteObservation(IonGccDirectResult result,bool ownedProcessVerified) {
        result.compilerResultValid=ownedProcessVerified&&result.exitCode.HasValue&&result.outputComplete&&result.cleanupVerified;
        if(result.observerFailure!=null) {
            result.observerFailure.cleanupCompleted=result.cleanupVerified;
            result.observerFailure.compilerResultValid=result.compilerResultValid;
        }
    }

    sealed class Capture {
        public byte[] Tail = new byte[8192]; public int Count, Position; public long Bytes;
        public double? FirstMs, LastMs; public bool Complete; public Exception Error;
        public void Add(byte[] data, int size, double at) {
            if (FirstMs == null) FirstMs = at; LastMs = at; Bytes += size;
            for (int i=0;i<size;i++) { Tail[Position]=data[i]; Position=(Position+1)%Tail.Length; Count=Math.Min(Count+1,Tail.Length); }
        }
        public string Text() {
            byte[] data = new byte[Count];
            int first=(Position-Count+Tail.Length)%Tail.Length;
            for(int i=0;i<Count;i++) data[i]=Tail[(first+i)%Tail.Length];
            int skip=0; while(skip<data.Length && (data[skip]&0xc0)==0x80)skip++;
            return Encoding.UTF8.GetString(data,skip,data.Length-skip);
        }
    }
    sealed class Session {
        public Stopwatch Clock=Stopwatch.StartNew(); public string RunId; public int EventCount;
        public List<IonGccDirectEvent> Events=new List<IonGccDirectEvent>(); public bool Overflow;
        public long TotalOutput; public int OverLimit;
        readonly object gate=new object();
        public void Event(string stage, string ev, int? pid=null, double? value=null) {
            lock(gate) {
                if(EventCount++>=128) { Overflow=true; Mark(currentStage,"trace-event"); throw new InvalidOperationException("Bounded native event capacity exceeded."); }
                double at=Clock.Elapsed.TotalMilliseconds;
                Events.Add(new IonGccDirectEvent { ms=at,stage=stage,@event=ev,pid=pid,value=value });
                string msg="{\"schemaVersion\":1,\"runId\":\""+RunId+"\",\"lane\":\"A\",\"kind\":\"event\",\"ms\":"+
                    at.ToString("F4",CultureInfo.InvariantCulture)+",\"stage\":\""+stage+"\",\"event\":\""+ev+"\"";
                if(pid!=null)msg+=",\"pid\":"+pid.Value.ToString(CultureInfo.InvariantCulture);
                if(value!=null)msg+=",\"value\":"+value.Value.ToString("F4",CultureInfo.InvariantCulture);
                Console.Out.WriteLine(msg+"}"); Console.Out.Flush();
            }
        }
    }
    // Process.Start is synchronous and can itself stall. A one-shot native
    // ownership watchdog therefore covers spawn as well as compiler execution.
    // Logging is best-effort on a separate ThreadPool callback: a blocked stdout
    // receiver must never postpone terminating this exact owned Job/controller.
    sealed class DeadlineWatchdog : IDisposable {
        readonly object gate=new object(); readonly Session session;
        IntPtr ownedJob; Timer timer; bool armed;
        public DeadlineWatchdog(IntPtr job,Session owner) { ownedJob=job;session=owner; }
        public void Arm(int dueMs) {
            lock(gate) {
                if(armed||ownedJob==IntPtr.Zero)throw new InvalidOperationException("Invalid deadline ownership state.");
                armed=true;
                timer=new Timer(Expired,null,dueMs,Timeout.Infinite);
            }
        }
        void Expired(object unused) {
            lock(gate) {
                if(!armed)return;
                armed=false;
                ThreadPool.QueueUserWorkItem(_=> {
                    try { session.Event("compiler-process","timeout"); } catch { }
                });
                // This handle remains live while the gate is held. Dispose
                // takes the same gate BEFORE the owner can release/reuse it.
                TerminateJobObject(ownedJob,124);
                TerminateProcess(GetCurrentProcess(),124);
            }
        }
        public void Dispose() {
            lock(gate) {
                armed=false;
                timer?.Dispose(); timer=null;
                ownedJob=IntPtr.Zero;
            }
        }
    }
    static async Task Pump(Stream stream, Capture capture, string name, Session s) {
        byte[] buffer=new byte[4096];
        try {
            int size;
            while((size=await stream.ReadAsync(buffer,0,buffer.Length).ConfigureAwait(false))!=0) {
                double at=s.Clock.Elapsed.TotalMilliseconds;
                bool first=capture.FirstMs==null;
                capture.Add(buffer,size,at);
                if(first)s.Event("compiler-"+name,"first-callback",null,at);
                if(Interlocked.Add(ref s.TotalOutput,size)>65536)Interlocked.Exchange(ref s.OverLimit,1);
            }
            capture.Complete=true;
            if(capture.LastMs!=null)s.Event("compiler-"+name,"last-callback",null,capture.LastMs);
            s.Event("compiler-"+name,"end");
        } catch(Exception e) { capture.Error=e; s.Event("compiler-"+name,"stream-error"); }
    }
    static HashSet<int> Members(IntPtr job) {
        // The Job has a 64-process limit including this PowerShell controller.
        int capacity=8+IntPtr.Size*128;
        IntPtr buffer=Marshal.AllocHGlobal(capacity);
        snapshotAssigned=null;snapshotListed=null;
        try {
            Check(QueryInformationJobObject(job,BASIC_PID_LIST,buffer,(uint)capacity,IntPtr.Zero),"QueryInformationJobObject");
            Mark(currentStage,"job-member-counts");
            int assigned=Marshal.ReadInt32(buffer,0), count=Marshal.ReadInt32(buffer,4);
            snapshotAssigned=assigned;snapshotListed=count;
            ValidateMemberCounts(assigned,count);
            var set=new HashSet<int>();
            for(int i=0;i<count;i++) {
                long id=IntPtr.Size==8?Marshal.ReadInt64(buffer,8+i*8):Marshal.ReadInt32(buffer,8+i*4);
                Mark(currentStage,"job-member-pid");
                if(id<=0 || id>Int32.MaxValue)throw new InvalidOperationException("Invalid Job process identifier.");
                set.Add((int)id);
            }
            return set;
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static void Sample(IntPtr job, int self, HashSet<int> previous, Session s) {
        var current=Members(job);
        Mark(currentStage,"job-sample-controller");
        if(!current.Contains(self))throw new InvalidOperationException("Controller lost its Job membership.");
        foreach(int pid in current)if(pid!=self&&!previous.Contains(pid))s.Event("job-membership","child-observed",pid);
        foreach(int pid in previous)if(pid!=self&&!current.Contains(pid))s.Event("job-membership","child-absent-observed",pid);
        previous.Clear(); foreach(int pid in current)previous.Add(pid);
    }
    static bool Drain(IntPtr job, int self, Session s) {
        // Open handles first, then verify actual Job membership before killing.
        // PID reuse cannot authorize terminating an unrelated process.
        Mark("cleanup","job-drain");
        Stopwatch drain=Stopwatch.StartNew();
        while(drain.ElapsedMilliseconds<2000) {
            var members=Members(job); members.Remove(self);
            if(members.Count==0)return true;
            foreach(int pid in members) {
                Mark("cleanup","job-open-child-handle");
                IntPtr handle=OpenProcess(PROCESS_TERMINATE|QUERY_LIMITED,false,pid);
                if(handle==IntPtr.Zero)continue;
                try {
                    bool owned; Check(IsProcessInJob(handle,job,out owned),"IsProcessInJob child");
                    if(owned) { s.Event("cleanup","terminate-owned-child",pid); Mark("cleanup","job-stop-owned-child"); TerminateProcess(handle,124); }
                } finally { CloseHandle(handle); }
            }
            Mark("cleanup","job-drain");
            Thread.Sleep(20);
        }
        return false;
    }
    public static IonGccDirectResult Run(string runId,string compiler,string[] args,string cwd,Dictionary<string,string> environment) {
        var s=new Session { RunId=runId };
        var r=new IonGccDirectResult { controllerPid=checked((int)GetCurrentProcessId()) };
        var stdout=new Capture(); var stderr=new Capture();
        IntPtr job=IntPtr.Zero; bool assigned=false, detached=false;
        Process child=null; Task outTask=null,errTask=null;
        DeadlineWatchdog watchdog=null;
        bool launched=false,ownedProcessVerified=false;
        LastObserverFailure=null;
        Mark("ownership-setup","job-create");
        try {
            job=CreateJobObjectW(IntPtr.Zero,null);
            if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateJobObject");
            var limits=new EXTENDED_LIMITS();
            limits.basic.flags=KILL_ON_JOB_CLOSE|ACTIVE_PROCESS; limits.basic.active=MAX_CHILDREN;
            Check(SetInformationJobObject(job,EXTENDED_LIMIT,ref limits,(uint)Marshal.SizeOf<EXTENDED_LIMITS>()),"SetInformationJobObject");
            Check(AssignProcessToJobObject(job,GetCurrentProcess()),"Assign controller to Job before compiler spawn");
            assigned=true;
            bool owned; Check(IsProcessInJob(GetCurrentProcess(),job,out owned),"Verify controller Job");
            if(!owned)throw new InvalidOperationException("Controller is not in its owning Job.");
            int initialMembers=Members(job).Count;
            Mark("ownership-setup","job-pre-spawn-snapshot");
            if(initialMembers!=1)throw new InvalidOperationException("Unexpected pre-spawn Job members.");
            s.Event("ownership","controller-job-verified",r.controllerPid);
            Mark("compiler-start","process-start-info");
            var info=new ProcessStartInfo { FileName=compiler,WorkingDirectory=cwd,UseShellExecute=false,
                RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true };
            info.Environment.Clear(); foreach(var pair in environment)info.Environment.Add(pair.Key,pair.Value);
            foreach(string arg in args)info.ArgumentList.Add(arg);
            child=new Process { StartInfo=info };
            double began=s.Clock.Elapsed.TotalMilliseconds;
            s.Event("compiler-process","spawn-request");
            watchdog=new DeadlineWatchdog(job,s);
            watchdog.Arm(Math.Max(1,(int)Math.Ceiling(15000-(s.Clock.Elapsed.TotalMilliseconds-began))));
            Mark("compiler-start","process-start");
            if(!child.Start())throw new InvalidOperationException("Process.Start returned false.");
            launched=true; r.compilerPid=child.Id; r.payloadPid=child.Id;
            s.Event("compiler-process","spawned",child.Id);
            Check(IsProcessInJob(child.Handle,job,out owned),"Verify compiler inherited Job");
            if(!owned) {
                TerminateProcess(child.Handle,125);
                if(!child.WaitForExit(1000))throw new InvalidOperationException("Compiler inherited Job verification failed; exact launched process cleanup is unverified.");
                throw new InvalidOperationException("Compiler failed inherited Job verification; exact launched process was terminated.");
            }
            ownedProcessVerified=true;
            Mark("compiler-start","process-close-stdin");
            child.StandardInput.Close();
            outTask=Pump(child.StandardOutput.BaseStream,stdout,"stdout",s);
            errTask=Pump(child.StandardError.BaseStream,stderr,"stderr",s);
            var observed=new HashSet<int>();
            while(true) {
                Mark("compiler-execution","process-wait");
                if(child.WaitForExit(Math.Max(1,(int)Math.Min(100,15000-(s.Clock.Elapsed.TotalMilliseconds-began)))))break;
                Mark("compiler-execution","job-sample");
                Sample(job,r.controllerPid,observed,s);
                if(Volatile.Read(ref s.OverLimit)!=0) { r.state="output-limit"; break; }
                if(s.Clock.Elapsed.TotalMilliseconds-began>=15000) { r.state="timeout"; break; }
            }
            watchdog.Dispose();
            Mark("compiler-execution","process-has-exited");
            if(child.HasExited) {
                Mark("compiler-execution","process-read-exit-code");
                r.exitCode=child.ExitCode; r.state=Volatile.Read(ref s.OverLimit)!=0?"output-limit":"exited";
                s.Event("compiler-process","exit-callback",child.Id,child.ExitCode);
            }
            s.Event("adapter-cleanup","requested");
            r.cleanupVerified=Drain(job,r.controllerPid,s);
            Mark("cleanup","job-drain-deadline");
            if(!r.cleanupVerified)throw new InvalidOperationException("Owned Job did not drain; final fail-closed termination required.");
            Mark("cleanup","process-wait-after-stop");
            if(!child.HasExited)child.WaitForExit(1000);
            if(child.HasExited && r.exitCode==null) { r.exitCode=child.ExitCode; s.Event("compiler-process","exit-callback",child.Id,child.ExitCode); }
            Mark("stream-shutdown","stream-reader-wait");
            var tasks=Task.WhenAll(outTask,errTask);
            if(!tasks.Wait(2000)) { Mark("stream-shutdown","stream-reader-close"); child.StandardOutput.Close(); child.StandardError.Close(); Mark("stream-shutdown","stream-reader-wait"); tasks.Wait(1000); }
            r.outputComplete=stdout.Complete&&stderr.Complete&&stdout.Error==null&&stderr.Error==null;
            if(!r.outputComplete)s.Event("streams","completion-unverified");
            if(Volatile.Read(ref s.OverLimit)!=0)r.state="output-limit";
            Mark("cleanup","job-sample");
            Sample(job,r.controllerPid,observed,s);
        } catch(Exception e) {
            Failure(r,e,child);
            s.Event("diagnostic","failed");
        } finally {
            // Disarm while the Job handle is still valid. A callback queued
            // after Dispose can only observe armed=false under the same gate.
            watchdog?.Dispose();
            Mark("cleanup","process-has-exited");
            if(launched && child!=null && !child.HasExited) {
                // This handle is the exact process launched by this adapter,
                // including a failed inherited-Job assertion. Never taskkill by name.
                Mark("cleanup","process-exact-stop");
                TerminateProcess(child.Handle,125);
                Mark("cleanup","process-wait-after-stop");
                if(!child.WaitForExit(1000)) {
                    r.cleanupVerified=false;
                    s.Event("cleanup","exact-payload-exit-unverified",child.Id);
                    TerminateProcess(GetCurrentProcess(),125);
                    throw new InvalidOperationException("Cannot verify exact launched process cleanup.");
                }
            }
            if(job!=IntPtr.Zero) {
                if(assigned) {
                    bool drained=false;
                    try { drained=Drain(job,r.controllerPid,s); } catch(Exception error) { Failure(r,error,child); }
                    if(!drained) {
                        // This deliberately kills the owning PowerShell too.
                        // The outer controller must retain an unfinished attempt.
                        s.Event("cleanup","fail-closed-terminate-job");
                        TerminateJobObject(job,125);
                        TerminateProcess(GetCurrentProcess(),125);
                        throw new InvalidOperationException("Cannot verify diagnostic Job drain.");
                    }
                    r.cleanupVerified=true;
                    var noKill=new EXTENDED_LIMITS();
                    try { Check(SetInformationJobObject(job,EXTENDED_LIMIT,ref noKill,(uint)Marshal.SizeOf<EXTENDED_LIMITS>()),"Release empty controller-only Job"); }
                    catch(Exception error) { Failure(r,error,child); throw; }
                    detached=true;
                }
                if(!assigned||detached) { Mark("cleanup","job-close-handle"); CloseHandle(job); }
            }
            if(outTask!=null && errTask!=null) {
                Mark("stream-shutdown","stream-reader-wait");
                var pending=Task.WhenAll(outTask,errTask);
                bool complete=false;
                try { complete=pending.Wait(2000); } catch(Exception error) { Failure(r,error,child); complete=true; }
                if(!complete) {
                    Mark("stream-shutdown","stream-reader-close");
                    child.StandardOutput.Close(); child.StandardError.Close();
                    Mark("stream-shutdown","stream-reader-wait");
                    try { complete=pending.Wait(1000); } catch(Exception error) { Failure(r,error,child); complete=true; }
                }
                if(!complete) {
                    s.Event("streams","reader-cleanup-unverified");
                    TerminateProcess(GetCurrentProcess(),125);
                    throw new InvalidOperationException("Diagnostic stream readers did not stop.");
                }
                r.outputComplete=stdout.Complete&&stderr.Complete&&stdout.Error==null&&stderr.Error==null;
            }
            if(stdout.Error!=null) { Mark("stream-shutdown","stream-read-stdout"); Failure(r,stdout.Error,child); }
            if(stderr.Error!=null) { Mark("stream-shutdown","stream-read-stderr"); Failure(r,stderr.Error,child); }
            Mark("cleanup","process-dispose");
            child?.Dispose();
            if(r.cleanupVerified)s.Event("adapter-cleanup","completed");
            r.stdoutTail=stdout.Text(); r.stderrTail=stderr.Text(); r.stdoutBytes=stdout.Bytes; r.stderrBytes=stderr.Bytes;
            r.elapsedMs=s.Clock.Elapsed.TotalMilliseconds;
        }
        CompleteObservation(r,ownedProcessVerified);
        Mark("result-delivery","trace-event");
        s.Event("compiler-process","result-finalized");
        s.Event("adapter","result-delivered");
        r.elapsedMs=s.Clock.Elapsed.TotalMilliseconds;
        r.events=s.Events.ToArray(); r.overflow=s.Overflow;
        return r;
    }
}
'@
    $executionStarted = $true
    $nativeResult = [IonGccDirect]::Run($runId, $compiler, [string[]]$expectedArgs, $cwd, $environment)
    $receipt = [ordered]@{schemaVersion=1; runId=$runId; lane='A'; kind='result';
        ms=$nativeResult.elapsedMs; wrapperElapsedMs=$clock.Elapsed.TotalMilliseconds}
    foreach ($property in $nativeResult.PSObject.Properties) { $receipt[$property.Name] = $property.Value }
    [Console]::Out.WriteLine(($receipt | ConvertTo-Json -Compress -Depth 10))
    [Console]::Out.Flush()
    if (-not $nativeResult.cleanupVerified -or -not $nativeResult.outputComplete -or $nativeResult.state -ne 'exited' -or $nativeResult.exitCode -ne 0) { exit 1 }
    exit 0
} catch {
    $safeObserverFailure = $null
    if ($executionStarted) { $safeObserverFailure = [IonGccDirect]::LastObserverFailure }
    [Console]::Out.WriteLine((@{schemaVersion=1; runId=$runId; lane='A'; kind='preflight-error';
        ms=$clock.Elapsed.TotalMilliseconds; detail=$_.Exception.GetType().Name;
        executionStarted=$executionStarted; nativeVerified=$false; observerFailure=$safeObserverFailure} | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
    exit 2
}
