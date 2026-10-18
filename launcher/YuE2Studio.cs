// YuE2 Studio launcher. Built by scripts\build-launcher.ps1 with the C# compiler that ships with Windows.
// Runs scripts\launch.pyw (starts the backend if needed and opens the app window) without a console.
// If the app has not been set up yet, offers to run scripts\setup.ps1.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("YuE2 Studio")]
[assembly: AssemblyProduct("YuE2 Studio")]
[assembly: AssemblyDescription("Local music generation with YuE2")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Program
{
    const string Title = "YuE2 Studio";

    [STAThread]
    static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string pythonw = Path.Combine(root, @".venv\Scripts\pythonw.exe");
        string launcher = Path.Combine(root, @"scripts\launch.pyw");
        string setup = Path.Combine(root, @"scripts\setup.ps1");
        bool ready = File.Exists(pythonw) && File.Exists(Path.Combine(root, @"frontend\dist\index.html"));

        if (!File.Exists(launcher))
        {
            MessageBox.Show("Can't find " + launcher + ".\n\nKeep YuE2 Studio.exe in the YuE2 Studio folder.",
                            Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        if (!ready)
        {
            var answer = MessageBox.Show(
                "YuE2 Studio isn't set up yet.\n\nSet it up now? This installs Python packages and downloads " +
                "the YuE2 model (about 11 GB in total) and takes a while. A window shows the progress.",
                Title, MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
            if (answer != DialogResult.OK) return 1;
            var install = Process.Start(new ProcessStartInfo("powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -File \"" + setup + "\" -Pause") {
                WorkingDirectory = root, UseShellExecute = false });
            install.WaitForExit();
            if (install.ExitCode != 0 || !File.Exists(pythonw)) return 1;
        }

        Process.Start(new ProcessStartInfo(pythonw, "\"" + launcher + "\"") {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true });
        return 0;
    }
}
