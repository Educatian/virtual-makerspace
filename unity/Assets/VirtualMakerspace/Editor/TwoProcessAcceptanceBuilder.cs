using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;

namespace VirtualMakerspace.Editor
{
    public static class TwoProcessAcceptanceBuilder
    {
        public static void BuildWindowsPlayer()
        {
            string root = Path.GetFullPath(".");
            string output = Path.Combine(root, "Builds", "Acceptance", "VirtualMakerspaceAcceptance.exe");
            Directory.CreateDirectory(Path.GetDirectoryName(output));
            var options = new BuildPlayerOptions
            {
                scenes = new[] { "Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity" },
                locationPathName = output,
                target = BuildTarget.StandaloneWindows64,
                options = BuildOptions.Development
            };

            BuildReport report = BuildPipeline.BuildPlayer(options);
            if (report.summary.result != BuildResult.Succeeded)
            {
                throw new BuildFailedException("Two-process acceptance player build failed.");
            }
        }
    }
}
