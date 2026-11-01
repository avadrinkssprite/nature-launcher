// Nature Launcher Setup: a bootstrapper that always installs the latest build from GitHub Releases,
// so this exe never needs to change when the launcher updates.
// Build: npm run build:installer (uses the C# 5 compiler that ships with Windows)
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Nature Launcher Setup")]
[assembly: AssemblyProduct("Nature Launcher")]

static class Setup
{
    public const string Repo = "avadrinkssprite/nature-launcher";
    public const string ZipUrl = "https://github.com/" + Repo + "/releases/latest/download/NatureLauncher-win-x64.zip";
    public const string AppName = "Nature Launcher";
    public const string ExeName = "Nature Launcher.exe";
    public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\NatureLauncher";
    public static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName);
    public static readonly string Exe = Path.Combine(Dir, ExeName);

    [STAThread]
    static int Main(string[] args)
    {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2, required by GitHub
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.Contains("/uninstall", StringComparer.OrdinalIgnoreCase)) return Uninstall();
        Application.Run(new SetupForm(args.Contains("/update", StringComparer.OrdinalIgnoreCase)));
        return 0;
    }

    public static void CloseLauncher()
    {
        foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(ExeName)))
        {
            try { p.CloseMainWindow(); if (!p.WaitForExit(3000)) { p.Kill(); p.WaitForExit(5000); } } catch { }
        }
    }

    public static void Shortcut(string lnkPath)
    {
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        dynamic lnk = shell.CreateShortcut(lnkPath);
        lnk.TargetPath = Exe;
        lnk.WorkingDirectory = Dir;
        lnk.IconLocation = Exe + ",0";
        lnk.Save();
    }

    static string DesktopLnk { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"); } }
    static string StartLnk { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk"); } }

    // runs on a worker thread; report(status, percent)
    public static void Install(Action<string, int> report)
    {
        bool fresh = !File.Exists(Exe);
        string tmp = Path.Combine(Path.GetTempPath(), "NatureLauncher-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tmp);
        try
        {
            string zip = Path.Combine(tmp, "app.zip");
            using (var wc = new WebClient())
            {
                wc.Headers.Add("User-Agent", "nature-launcher-setup");
                wc.DownloadProgressChanged += (s, e) => report("Downloading Nature Launcher…  " + (e.BytesReceived / 1048576) + " MB", e.ProgressPercentage * 80 / 100);
                wc.DownloadFileTaskAsync(new Uri(ZipUrl), zip).Wait();
            }

            report("Extracting…", 80);
            // stage beside the install dir so the final Directory.Move never crosses drives
            Directory.CreateDirectory(Path.GetDirectoryName(Dir));
            string staging = Dir + ".new";
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
            using (var archive = ZipFile.OpenRead(zip))
            {
                int i = 0, n = archive.Entries.Count;
                string root = Path.GetFullPath(staging) + Path.DirectorySeparatorChar;
                foreach (var e in archive.Entries)
                {
                    string dest = Path.GetFullPath(Path.Combine(staging, e.FullName));
                    if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("Unsafe path in download: " + e.FullName);
                    if (e.FullName.EndsWith("/") || e.FullName.EndsWith("\\")) { Directory.CreateDirectory(dest); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    e.ExtractToFile(dest, true);
                    report("Extracting…", 80 + 15 * ++i / n);
                }
            }
            if (!File.Exists(Path.Combine(staging, ExeName))) throw new Exception("The download did not contain " + ExeName);

            report("Closing Nature Launcher…", 95);
            CloseLauncher();

            // swap in the new files; old ones are removed so nothing stale is left behind.
            // Instances and settings live in %APPDATA%\nature-launcher and are never touched.
            report("Installing…", 96);
            for (int attempt = 0; Directory.Exists(Dir); attempt++)
            {
                try { Directory.Delete(Dir, true); }
                catch { if (attempt >= 10) throw new Exception("Could not replace the old files. Close Nature Launcher and try again."); System.Threading.Thread.Sleep(500); }
            }
            Directory.Move(staging, Dir);

            string self = Application.ExecutablePath;
            File.Copy(self, Path.Combine(Dir, "Setup.exe"), true);

            report("Creating shortcuts…", 98);
            Shortcut(StartLnk);
            if (fresh || File.Exists(DesktopLnk)) Shortcut(DesktopLnk);

            using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                k.SetValue("DisplayName", AppName);
                k.SetValue("DisplayIcon", Exe);
                k.SetValue("Publisher", "Nature Launcher");
                k.SetValue("InstallLocation", Dir);
                k.SetValue("UninstallString", "\"" + Path.Combine(Dir, "Setup.exe") + "\" /uninstall");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
            report("Done", 100);
        }
        finally
        {
            try { Directory.Delete(tmp, true); } catch { }
            try { if (Directory.Exists(Dir + ".new")) Directory.Delete(Dir + ".new", true); } catch { }
        }
    }

    static int Uninstall()
    {
        var ok = MessageBox.Show("Remove Nature Launcher?\n\nYour instances, worlds and settings in %APPDATA%\\nature-launcher are kept.",
            "Uninstall Nature Launcher", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (ok != DialogResult.Yes) return 1;
        CloseLauncher();
        foreach (var l in new[] { DesktopLnk, StartLnk }) try { File.Delete(l); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }
        // this exe lives inside Dir, so let cmd delete the folder after we exit
        Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"" + Dir + "\"")
            { CreateNoWindow = true, UseShellExecute = false });
        return 0;
    }
}

class SetupForm : Form
{
    static readonly Color Bg = ColorTranslator.FromHtml("#13244a");
    static readonly Color Ink = ColorTranslator.FromHtml("#eef1f8");
    static readonly Color Dim = ColorTranslator.FromHtml("#a9b3cc");
    static readonly Color Warm = ColorTranslator.FromHtml("#ffcf9e");

    readonly bool update;
    readonly Label status = new Label();
    readonly ProgressBar bar = new ProgressBar();
    readonly Button action = new Button();
    bool done;

    public SetupForm(bool update)
    {
        this.update = update;
        Text = "Nature Launcher Setup";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        ClientSize = new Size(480, 230);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Bg;
        ForeColor = Ink;
        Font = new Font("Segoe UI", 9.5f);

        var title = new Label { Text = "Nature Launcher", Font = new Font("Georgia", 24f), ForeColor = Ink, AutoSize = true, Location = new Point(28, 24) };
        var line = new Panel { BackColor = Color.FromArgb(70, 238, 241, 248), Location = new Point(30, 76), Size = new Size(420, 1) };
        bool installed = File.Exists(Setup.Exe);
        status.Text = update ? "Updating…" : installed ? "Nature Launcher is installed. Update it to the latest version?" : "Install the latest Nature Launcher for your account.";
        status.ForeColor = Dim; status.Location = new Point(28, 92); status.Size = new Size(424, 40);
        bar.Location = new Point(30, 140); bar.Size = new Size(420, 8); bar.Style = ProgressBarStyle.Continuous;
        action.Text = installed ? "Update" : "Install";
        action.FlatStyle = FlatStyle.Flat; action.FlatAppearance.BorderColor = Warm; action.ForeColor = Warm; action.BackColor = Bg;
        action.Size = new Size(120, 34); action.Location = new Point(330, 174);
        action.Click += (s, e) => { if (done) { Launch(); Close(); } else Start(); };
        Controls.AddRange(new Control[] { title, line, status, bar, action });
        if (update) Shown += (s, e) => Start();
    }

    void Start()
    {
        action.Enabled = false;
        Task.Run(() => Setup.Install((msg, pct) => BeginInvoke((Action)(() => { status.Text = msg; bar.Value = Math.Max(0, Math.Min(100, pct)); }))))
            .ContinueWith(t => BeginInvoke((Action)(() =>
            {
                if (t.Exception != null)
                {
                    var err = t.Exception.GetBaseException();
                    status.Text = "Failed: " + err.Message;
                    status.ForeColor = ColorTranslator.FromHtml("#ff9b8a");
                    action.Text = "Retry"; action.Enabled = true;
                    return;
                }
                done = true;
                if (update) { Launch(); Close(); return; }
                status.Text = "Installed. You can find Nature Launcher in the Start menu.";
                action.Text = "Launch"; action.Enabled = true;
            })));
    }

    static void Launch()
    {
        Process.Start(new ProcessStartInfo(Setup.Exe) { WorkingDirectory = Setup.Dir });
    }
}
