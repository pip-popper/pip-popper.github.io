using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher {
    [STAThread]
    static int Main() {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string identity;
        using (var sha = SHA256.Create())
            identity = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant()))).Replace("-", "");
        bool owns;
        using (var mutex = new Mutex(true, @"Local\PipPopperManager-" + identity, out owns))
        using (var reopen = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\PipPopperOpen-" + identity)) {
            if (!owns) { reopen.Set(); return 0; }
            try { return Run(root, reopen); }
            catch { MessageBox.Show("管理ツールを起動できませんでした。フォルダー一式と同梱ファイルを確認してください。", "PIP POPPER", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
            finally { mutex.ReleaseMutex(); }
        }
    }

    static void Open(string url) {
        if (Environment.GetEnvironmentVariable("PP_MANAGER_NO_OPEN") == "1") return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { MessageBox.Show("ブラウザを開けませんでした。既定のブラウザの設定を確認してください。", "PIP POPPER"); }
    }

    static int Run(string root, EventWaitHandle reopen) {
        string runtime = Path.Combine(root, "manager", "runtime");
        var start = new ProcessStartInfo(Path.Combine(runtime, "node.exe")) {
            Arguments = "\"" + Path.Combine(root, "manager", "server.mjs") + "\" --port 0 --no-open --launcher",
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        start.EnvironmentVariables["PATH"] = Path.Combine(runtime, "git", "cmd") + ";" + runtime + ";" + Environment.GetEnvironmentVariable("PATH");
        using (var ready = new ManualResetEvent(false))
        using (var exited = new ManualResetEvent(false))
        using (var child = new Process { StartInfo = start, EnableRaisingEvents = true }) {
            string url = null;
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) {
                if (args.Data != null && args.Data.StartsWith("http://127.0.0.1:") && args.Data.Contains("/#t=")) {
                    url = args.Data; ready.Set();
                }
            };
            child.ErrorDataReceived += delegate { };
            child.Exited += delegate { exited.Set(); };
            child.Start();
            child.BeginOutputReadLine(); child.BeginErrorReadLine();
            try {
                if (WaitHandle.WaitAny(new WaitHandle[] { ready, exited }, 30000) != 0)
                    throw new IOException("Startup failed");
                if (Environment.GetEnvironmentVariable("PP_MANAGER_PRINT_TOKEN") == "1") {
                    Console.WriteLine(url);
                    Console.WriteLine("SERVER_PID=" + child.Id);
                }
                Open(url);
                while (WaitHandle.WaitAny(new WaitHandle[] { exited, reopen }) == 1) Open(url);
                return child.ExitCode;
            } finally {
                if (!child.HasExited) { child.Kill(); child.WaitForExit(); }
            }
        }
    }
}
