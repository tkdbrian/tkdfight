using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
internal static class OpenTkd {
    [STAThread] private static int Main() {
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, @"sistema\scripts\Launch-Sunday.ps1");
            if (!File.Exists(script)) throw new IOException("Extraiga TODO el ZIP antes de abrir TKD. Falta sistema\\scripts\\Launch-Sunday.ps1");
            var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"));
            start.Arguments = "-NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script + "\"";
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(start);
            return 0;
        } catch (Exception error) { MessageBox.Show(error.Message, "TKD Fight - No se pudo abrir", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
    }
}
