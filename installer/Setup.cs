// Nature Launcher Setup: installs the launcher straight from the GitHub repo's main branch
// (plus the Electron runtime it pins), so this exe never needs to change when the launcher updates.
// Build: npm run build:installer (uses the C# 5 compiler that ships with Windows)
// Args: /update (no questions, relaunch when done)  /dir <folder> (install folder for /update)  /uninstall
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
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
    // app code comes straight from the repo; the Electron runtime from Electron's official release
    public const string RepoZip = "https://github.com/" + Repo + "/archive/refs/heads/main.zip";
    public const string ElectronZip = "https://github.com/electron/electron/releases/download/v{0}/electron-v{0}-win32-x64.zip";
    public const string AppName = "Nature Launcher";
    public const string ExeName = "Nature Launcher.exe";
    public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\NatureLauncher";
    public static readonly string DefaultDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName);
    public static string Dir;
    public static string Exe { get { return Path.Combine(Dir, ExeName); } }
    public static string DesktopLnk { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"); } }
    public static string StartLnk { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk"); } }

    [STAThread]
    static int Main(string[] args)
    {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2, required by GitHub
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Func<string, bool> has = a => args.Contains(a, StringComparer.OrdinalIgnoreCase);
        if (has("/uninstall")) return Uninstall();
        int i = Array.FindIndex(args, a => a.Equals("/dir", StringComparison.OrdinalIgnoreCase));
        string given = i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        Dir = given != null && File.Exists(Path.Combine(given, ExeName)) ? given : InstalledDir() ?? DefaultDir;
        Application.Run(new SetupForm(has("/update")));
        return 0;
    }

    public static string InstalledDir()
    {
        using (var k = Registry.CurrentUser.OpenSubKey(UninstallKey))
        {
            var v = k == null ? null : k.GetValue("InstallLocation") as string;
            return v != null && File.Exists(Path.Combine(v, ExeName)) ? v : null;
        }
    }

    // The install folder gets wiped on update, so never touch a folder that holds anything else
    public static bool IsOurs(string d)
    {
        return !Directory.Exists(d) || File.Exists(Path.Combine(d, ExeName)) || !Directory.EnumerateFileSystemEntries(d).Any();
    }

    static void DeleteDir(string d)
    {
        for (int attempt = 0; Directory.Exists(d); attempt++)
        {
            try { Directory.Delete(d, true); }
            catch
            {
                if (attempt >= 10) throw new Exception("Could not replace the old files. Close Nature Launcher and try again.");
                System.Threading.Thread.Sleep(500);
            }
        }
    }

    public static void CloseLauncher()
    {
        foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(ExeName)))
        {
            try { p.CloseMainWindow(); if (!p.WaitForExit(3000)) { p.Kill(); p.WaitForExit(5000); } } catch { }
        }
    }

    static void Shortcut(string lnkPath, bool want)
    {
        if (!want) { try { File.Delete(lnkPath); } catch { } return; }
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        dynamic lnk = shell.CreateShortcut(lnkPath);
        lnk.TargetPath = Exe;
        lnk.WorkingDirectory = Dir;
        lnk.IconLocation = Path.Combine(Dir, "Setup.exe") + ",0"; // the exe is stock Electron; Setup.exe carries our icon
        lnk.Save();
    }

    static void Download(string url, string file, Action<string, int> report, string label, int from, int to)
    {
        using (var wc = new WebClient())
        {
            wc.Headers.Add("User-Agent", "nature-launcher-setup");
            wc.DownloadProgressChanged += (s, e) => report(label + "  " + (e.BytesReceived / 1048576) + " MB", from + e.ProgressPercentage * (to - from) / 100);
            wc.DownloadFileTaskAsync(new Uri(url), file).Wait();
        }
    }

    // stripTop: GitHub archives wrap everything in a "<repo>-main/" folder
    static void Extract(string zip, string dest, bool stripTop, Action<string, int> report, string label, int from, int to)
    {
        string root = Path.GetFullPath(dest) + Path.DirectorySeparatorChar;
        using (var archive = ZipFile.OpenRead(zip))
        {
            int i = 0, n = archive.Entries.Count;
            foreach (var e in archive.Entries)
            {
                report(label, from + (to - from) * ++i / n);
                string name = e.FullName.Replace('\\', '/');
                if (stripTop) { int s = name.IndexOf('/'); name = s < 0 ? "" : name.Substring(s + 1); }
                if (name == "" || name.EndsWith("/")) continue;
                string target = Path.GetFullPath(Path.Combine(dest, name));
                if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("Unsafe path in download: " + e.FullName);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                e.ExtractToFile(target, true);
            }
        }
    }

    // runs on a worker thread. startMenu/desktop null = keep whatever shortcuts exist (update mode)
    public static void Install(Action<string, int> report, bool? startMenu, bool? desktop)
    {
        if (!IsOurs(Dir)) throw new Exception("That folder already has other files in it. Pick an empty folder.");
        string parent = Path.GetDirectoryName(Dir);
        try
        {
            Directory.CreateDirectory(parent);
            string probe = Path.Combine(parent, ".nl-write-test");
            File.WriteAllText(probe, "");
            File.Delete(probe);
        }
        catch (UnauthorizedAccessException) { throw new Exception("No permission to install in " + parent + ". Pick another folder."); }

        string tmp = Path.Combine(Path.GetTempPath(), "NatureLauncher-" + Guid.NewGuid().ToString("N"));
        // staged beside the target so the final moves never cross drives
        string staging = Dir + ".new", appNew = Path.Combine(Dir, "resources", "app.new");
        Directory.CreateDirectory(tmp);
        try
        {
            // 1. app code: the repo's main branch (small, every push is an update)
            string repoZip = Path.Combine(tmp, "repo.zip");
            Download(RepoZip, repoZip, report, "Downloading Nature Launcher…", 0, 10);
            string app = Path.Combine(tmp, "app");
            Extract(repoZip, app, true, report, "Unpacking…", 10, 15);
            if (!File.Exists(Path.Combine(app, "main.js"))) throw new Exception("The download did not contain the launcher.");

            // 2. Electron runtime: only when missing or the repo pins a different version
            var m = System.Text.RegularExpressions.Regex.Match(File.ReadAllText(Path.Combine(app, "package-lock.json")),
                "\"node_modules/electron\":\\s*\\{\\s*\"version\":\\s*\"([^\"]+)\"");
            if (!m.Success) throw new Exception("Could not find the Electron version in package-lock.json");
            string electron = m.Groups[1].Value;
            string verFile = Path.Combine(Dir, "version");
            bool needRuntime = !File.Exists(Exe) || !File.Exists(verFile) || File.ReadAllText(verFile).Trim() != electron;

            if (needRuntime)
            {
                string ez = Path.Combine(tmp, "electron.zip");
                Download(string.Format(ElectronZip, electron), ez, report, "Downloading runtime (Electron " + electron + ")…", 15, 85);
                DeleteDir(staging);
                Extract(ez, staging, false, report, "Extracting runtime…", 85, 93);
                File.Move(Path.Combine(staging, "electron.exe"), Path.Combine(staging, ExeName));
                File.Delete(Path.Combine(staging, "resources", "default_app.asar"));
                CopyDir(app, Path.Combine(staging, "resources", "app"));

                report("Closing Nature Launcher…", 94);
                CloseLauncher();
                // old files are removed so nothing stale is left behind.
                // Instances and settings live in %APPDATA%\nature-launcher and are never touched.
                report("Installing…", 95);
                DeleteDir(Dir);
                Directory.Move(staging, Dir);
            }
            else
            {
                DeleteDir(appNew);
                CopyDir(app, appNew);
                report("Closing Nature Launcher…", 90);
                CloseLauncher();
                report("Installing…", 94);
                string res = Path.Combine(Dir, "resources");
                foreach (var asar in new[] { "app.asar", "default_app.asar" }) File.Delete(Path.Combine(res, asar)); // either would win over resources\app
                DeleteDir(Path.Combine(res, "app"));
                Directory.Move(appNew, Path.Combine(res, "app"));
            }
            File.Copy(Application.ExecutablePath, Path.Combine(Dir, "Setup.exe"), true);

            report("Creating shortcuts…", 98);
            Shortcut(StartLnk, startMenu ?? File.Exists(StartLnk));
            Shortcut(DesktopLnk, desktop ?? File.Exists(DesktopLnk));

            using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                k.SetValue("DisplayName", AppName);
                k.SetValue("DisplayIcon", Path.Combine(Dir, "Setup.exe"));
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
            try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { }
            try { if (Directory.Exists(appNew)) Directory.Delete(appNew, true); } catch { }
        }
    }

    static void CopyDir(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
        foreach (var d in Directory.GetDirectories(from)) CopyDir(d, Path.Combine(to, Path.GetFileName(d)));
    }

    static int Uninstall()
    {
        Dir = Path.GetDirectoryName(Application.ExecutablePath);
        var ok = MessageBox.Show("Remove Nature Launcher?\n\nYour instances, worlds and settings in %APPDATA%\\nature-launcher are kept.",
            "Uninstall Nature Launcher", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (ok != DialogResult.Yes) return 1;
        CloseLauncher();
        foreach (var l in new[] { DesktopLnk, StartLnk }) try { File.Delete(l); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }
        // this exe lives inside Dir, so let cmd delete the folder after we exit
        if (File.Exists(Exe))
            Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"" + Dir + "\"")
                { CreateNoWindow = true, UseShellExecute = false });
        return 0;
    }
}

// square pixel-style checkbox drawn over the scene
class PixelCheck : CheckBox
{
    public PixelCheck()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        BackColor = Color.Transparent;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaintBackground(e);
        var g = e.Graphics;
        int s = 12, y = (Height - s) / 2;
        using (var pen = new Pen(Checked ? SetupForm.Warm : SetupForm.Dim)) g.DrawRectangle(pen, 0, y, s, s);
        if (Checked) using (var b = new SolidBrush(SetupForm.Warm)) g.FillRectangle(b, 3, y + 3, s - 5, s - 5);
        if (Focused && ShowFocusCues) using (var pen = new Pen(Color.FromArgb(120, SetupForm.Warm))) g.DrawRectangle(pen, -0, y - 2, Width - 1, s + 4);
        TextRenderer.DrawText(g, Text, Font, new Point(s + 8, (Height - Font.Height) / 2), Enabled ? ForeColor : SetupForm.Dim);
    }
}

class SetupForm : Form
{
    public static readonly Color Ink = ColorTranslator.FromHtml("#eef1f8");
    public static readonly Color Dim = ColorTranslator.FromHtml("#aab4cc");
    public static readonly Color Warm = ColorTranslator.FromHtml("#ffcf9e");
    public static readonly Color Bad = ColorTranslator.FromHtml("#ff9b8a");
    public static readonly Color Deep = ColorTranslator.FromHtml("#0e1a36");
    const int W = 576, H = 360; // the background is 288x180 pixel art shown at exactly 2x

    readonly bool update;
    readonly Image bg;
    readonly TextBox dirBox = new TextBox();
    readonly Button browse = new Button(), action = new Button();
    readonly CheckBox startBox = new PixelCheck(), deskBox = new PixelCheck();
    string status;
    Color statusColor = Dim;
    int pct = -1;
    bool done;

    public SetupForm(bool update)
    {
        this.update = update;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        bg = Image.FromStream(Assembly.GetExecutingAssembly().GetManifestResourceStream("bg.png"));
        Text = "Nature Launcher Setup";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        ClientSize = new Size(W, H);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Deep;
        ForeColor = Ink;
        Font = new Font("Segoe UI", 9f);

        bool installed = File.Exists(Setup.Exe);
        status = update ? "Updating…" : installed ? "Already installed. Update to the latest version?" : "";

        dirBox.Text = Setup.Dir;
        dirBox.BorderStyle = BorderStyle.FixedSingle;
        dirBox.BackColor = Deep; dirBox.ForeColor = Ink;
        dirBox.Font = new Font("Segoe UI", 9.5f);
        dirBox.Bounds = new Rectangle(24, 222, 432, 25);
        dirBox.ReadOnly = installed; // moving an existing install isn't supported; uninstall first

        Style(browse, "Browse", new Rectangle(464, 221, 88, 27), Ink);
        browse.Enabled = !installed;
        browse.Click += (s, e) => Browse();

        Check(startBox, "Start menu shortcut", new Point(24, 262), !installed || File.Exists(Setup.StartLnk));
        Check(deskBox, "Desktop shortcut", new Point(200, 262), !installed || File.Exists(Setup.DesktopLnk));

        Style(action, installed ? "Update" : "Install", new Rectangle(432, 310, 120, 34), Warm);
        action.Click += (s, e) => { if (done) { Launch(); Close(); } else Start(); };

        Controls.AddRange(new Control[] { dirBox, browse, startBox, deskBox, action });
        ActiveControl = action; // don't open with the path text selected
        if (update)
        {
            foreach (Control c in Controls) c.Visible = false;
            Shown += (s, e) => Start();
        }
    }

    static void Style(Button b, string text, Rectangle r, Color c)
    {
        b.Text = text; b.Bounds = r;
        b.FlatStyle = FlatStyle.Flat; b.UseVisualStyleBackColor = false;
        b.BackColor = Color.Transparent; b.ForeColor = c;
        b.FlatAppearance.BorderColor = c;
        b.FlatAppearance.MouseOverBackColor = Color.FromArgb(40, c);
        b.FlatAppearance.MouseDownBackColor = Color.FromArgb(70, c);
        b.Font = new Font("Segoe UI Semibold", 9f);
        b.Cursor = Cursors.Hand;
    }

    static void Check(CheckBox c, string text, Point p, bool on)
    {
        c.Text = text; c.Bounds = new Rectangle(p, new Size(170, 22)); c.Checked = on;
        c.ForeColor = Ink; c.Cursor = Cursors.Hand;
    }

    void Browse()
    {
        using (var f = new FolderBrowserDialog { Description = "Choose where to install Nature Launcher. A \"Nature Launcher\" folder is created inside it.", ShowNewFolderButton = true })
        {
            if (f.ShowDialog(this) != DialogResult.OK) return;
            string p = f.SelectedPath;
            // always install into our own subfolder: updates wipe the install folder
            if (!string.Equals(Path.GetFileName(p.TrimEnd('\\')), Setup.AppName, StringComparison.OrdinalIgnoreCase))
                p = Path.Combine(p, Setup.AppName);
            dirBox.Text = p;
        }
    }

    void SetStatus(string msg, int p, Color c)
    {
        status = msg; pct = p; statusColor = c;
        Invalidate(new Rectangle(0, 290, W, H - 290));
    }

    void Start()
    {
        string d = dirBox.Text.Trim();
        if (!Path.IsPathRooted(d)) { SetStatus("Choose a full folder path.", -1, Bad); return; }
        Setup.Dir = Path.GetFullPath(d);
        bool? sm = update ? (bool?)null : startBox.Checked, dk = update ? (bool?)null : deskBox.Checked;
        foreach (Control c in Controls) c.Enabled = false;
        SetStatus("Starting…", 0, Dim);
        Task.Run(() => Setup.Install((msg, p) => BeginInvoke((Action)(() => SetStatus(msg, p, Dim))), sm, dk))
            .ContinueWith(t => BeginInvoke((Action)(() =>
            {
                if (t.Exception != null)
                {
                    SetStatus("Failed: " + t.Exception.GetBaseException().Message, -1, Bad);
                    foreach (Control c in Controls) c.Enabled = true;
                    bool inst = File.Exists(Setup.Exe);
                    dirBox.ReadOnly = inst; browse.Enabled = !inst;
                    action.Visible = true; // in update mode only the retry button comes back
                    action.Text = "Retry";
                    return;
                }
                done = true;
                if (update) { Launch(); Close(); return; }
                SetStatus("Installed. Nature Launcher is ready.", 100, Warm);
                action.Text = "Launch"; action.Enabled = true;
            })));
    }

    static void Launch()
    {
        Process.Start(new ProcessStartInfo(Setup.Exe) { WorkingDirectory = Setup.Dir });
    }

    // everything is drawn in the background pass so transparent child controls show the scene behind them
    protected override void OnPaintBackground(PaintEventArgs e) { DrawScene(e.Graphics); }
    protected override void OnPaint(PaintEventArgs e) { }

    void DrawScene(Graphics g)
    {
        g.InterpolationMode = InterpolationMode.NearestNeighbor;
        g.PixelOffsetMode = PixelOffsetMode.Half;
        g.DrawImage(bg, new Rectangle(0, 0, W, H));

        // dark glass over the lower half so the controls stay readable
        using (var b = new LinearGradientBrush(new Rectangle(0, 140, W, H - 140), Color.Transparent, Deep, 90f))
        {
            b.InterpolationColors = new ColorBlend
            {
                Colors = new[] { Color.FromArgb(0, Deep), Color.FromArgb(215, Deep), Color.FromArgb(240, Deep) },
                Positions = new[] { 0f, .4f, 1f },
            };
            g.FillRectangle(b, 0, 140, W, H - 140);
        }

        // soft fade behind the title so it reads over the clouds
        using (var b = new LinearGradientBrush(new Rectangle(0, 0, W, 125), Color.FromArgb(225, Deep), Color.FromArgb(0, Deep), 90f))
            g.FillRectangle(b, 0, 0, W, 125);

        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var title = new Font("Georgia", 26f))
        using (var shadow = new SolidBrush(Color.FromArgb(140, 8, 14, 30)))
        using (var ink = new SolidBrush(Ink))
        {
            g.DrawString("Nature Launcher", title, shadow, 23, 23);
            g.DrawString("Nature Launcher", title, ink, 21, 20);
        }
        using (var small = new Font("Segoe UI Semibold", 7.5f))
        using (var dim = new SolidBrush(Dim))
        using (var shadow = new SolidBrush(Color.FromArgb(170, 8, 14, 30)))
        using (var line = new Pen(Color.FromArgb(80, Ink)))
        {
            string sub = update ? "UPDATING" : "MINECRAFT LAUNCHER  ·  SETUP";
            g.DrawString(sub, small, shadow, 27, 67);
            g.DrawString(sub, small, dim, 26, 66);
            if (!update)
            {
                g.DrawLine(line, 24, 196, W - 24, 196);
                g.DrawString("INSTALL LOCATION", small, dim, 22, 203);
            }
        }

        int y = update ? 300 : 316;
        if (!string.IsNullOrEmpty(status))
            using (var b = new SolidBrush(statusColor))
                g.DrawString(status, Font, b, new RectangleF(22, y, 400, 20));
        if (pct >= 0)
        {
            int bw = update ? W - 48 : 392;
            using (var track = new SolidBrush(Color.FromArgb(45, Ink))) g.FillRectangle(track, 24, y + 24, bw, 3);
            using (var fill = new SolidBrush(Warm)) g.FillRectangle(fill, 24, y + 24, bw * pct / 100, 3);
        }
    }
}
