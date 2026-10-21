# Cubit Launcher launcher (bypasses SmartScreen)
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI.
#
# Uses Win32 CreateProcess with bInheritHandles=FALSE + DETACHED_PROCESS,
# which is what ShellExecute does. Plain .NET Process.Start(UseShellExecute=false)
# inherits the parent console handles and makes Electron abort at startup.

$log = Join-Path $env:TEMP 'cubit-launch.log'
function Log($m) { add-content -path $log -value ("[" + (Get-Date -Format 'HH:mm:ss') + "] " + $m) }

$ErrorActionPreference = 'Stop'
Log "---- launch start ----"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $root 'release\win-unpacked\mc-launcher.exe'
$work = $root
Log "exe=$exe exists=$(Test-Path -LiteralPath $exe)"
if (-not (Test-Path -LiteralPath $exe)) { Log "ABORT missing exe"; exit 1 }

# Do not let Electron run in Node mode.
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:\DSH_SHELL -ErrorAction SilentlyContinue

$cmd = '"' + $exe + '"'
if ($args.Count -gt 0) { $cmd += ' ' + ($args -join ' ') }
Log "cmd=$cmd"

$sig = @'
using System;
using System.Runtime.InteropServices;

public static class WinProc
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public int dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);

    public static int Spawn(string exe, string cmdLine, string workingDir)
    {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;

        const uint DETACHED_PROCESS = 0x00000008;
        const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;

        bool ok = CreateProcessW(
            exe, cmdLine, IntPtr.Zero, IntPtr.Zero,
            false,                                  // bInheritHandles = FALSE
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            IntPtr.Zero, workingDir, ref si, out pi);

        if (!ok) return -Marshal.GetLastWin32Error();

        int pid = pi.dwProcessId;
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return pid;
    }
}
'@

try {
    Add-Type -TypeDefinition $sig -ErrorAction Stop
    $pid2 = [WinProc]::Spawn($exe, $cmd, $work)
    if ($pid2 -gt 0) {
        Log "OK pid=$pid2"
        exit 0
    } else {
        Log "CreateProcess failed, win32=$pid2"
        exit 1
    }
} catch {
    Log "EXCEPTION: $($_.Exception.Message)"
    exit 1
}

