using System;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.XR.Management;
using UnityEditor.XR.Management.Metadata;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.XR.Management;
using UnityEngine.XR.OpenXR;
using UnityEngine.XR.OpenXR.Features;
using UnityEngine.XR.OpenXR.Features.CompositionLayers;
using UnityEngine.XR.OpenXR.Features.Interactions;

namespace VirtualMakerspace.Editor
{
    public static class QuestBuildPipeline
    {
        public const string PackageName = "edu.ua.virtualmakerspace";
        public const string ApkPath = "Builds/Quest/VirtualMakerspace.apk";

        private const string ScenePath = "Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity";
        private const string OpenXrLoaderType = "UnityEngine.XR.OpenXR.OpenXRLoader";
        private const string DefaultSdkPath = @"C:\Users\jewoo\AppData\Local\Android\Sdk";
        private const string DefaultJdkPath = @"C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot";

        public static void BuildQuestApk()
        {
            PrepareSceneForQuest();
            ConfigureAndroidTools();
            ConfigurePlayer();
            ConfigureOpenXr();

            CleanStaleSimulationBuildAssets();
            string absoluteApkPath = Path.GetFullPath(ApkPath);
            Directory.CreateDirectory(Path.GetDirectoryName(absoluteApkPath));
            BuildReport report = BuildPipeline.BuildPlayer(
                new[] { ScenePath },
                absoluteApkPath,
                BuildTarget.Android,
                BuildOptions.None);

            if (report.summary.result != BuildResult.Succeeded)
            {
                throw new InvalidOperationException(
                    $"Quest APK build failed: {report.summary.result}, errors={report.summary.totalErrors}");
            }

            File.WriteAllText(Path.Combine(Path.GetDirectoryName(absoluteApkPath), ".buildstamp"), DateTime.UtcNow.ToString("O"));
            Debug.Log($"QUEST_APK_READY path={absoluteApkPath} bytes={report.summary.totalSize}");
        }

        public static void PrepareSceneForQuest()
        {
            MilestoneThreeBuilder.Build();
            CloudInfrastructureBuilder.Configure();
            MilestoneFourTutorialBuilder.Build();
            WristHudBuilder.Build();
        }

        private static void ConfigureAndroidTools()
        {
            string sdkPath = Environment.GetEnvironmentVariable("ANDROID_SDK_ROOT") ?? DefaultSdkPath;
            string jdkPath = DefaultJdkPath;
            string ndkPath = Path.Combine(sdkPath, "ndk", "27.2.12479018");

            RequireDirectory(sdkPath, "Android SDK");
            RequireDirectory(ndkPath, "Android NDK r27c");
            RequireDirectory(jdkPath, "JDK 17");

            Type toolsType = Type.GetType(
                "UnityEditor.Android.AndroidExternalToolsSettings, UnityEditor.Android.Extensions",
                throwOnError: true);
            SetStaticProperty(toolsType, "sdkRootPath", sdkPath);
            SetStaticProperty(toolsType, "ndkRootPath", ndkPath);
            SetStaticProperty(toolsType, "jdkRootPath", jdkPath);
        }

        private static void ConfigurePlayer()
        {
            if (!EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Android, BuildTarget.Android))
            {
                throw new InvalidOperationException("Could not switch the active build target to Android.");
            }
            PlayerSettings.companyName = "University of Alabama";
            PlayerSettings.productName = "Virtual Makerspace CPS";
            PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Android, PackageName);
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, ScriptingImplementation.IL2CPP);
            PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel29;
            PlayerSettings.Android.targetSdkVersion = AndroidSdkVersions.AndroidApiLevel35;
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
            PlayerSettings.SetGraphicsAPIs(BuildTarget.Android, new[] { GraphicsDeviceType.OpenGLES3 });
            PlayerSettings.colorSpace = ColorSpace.Linear;
            EditorUserBuildSettings.androidBuildSystem = AndroidBuildSystem.Gradle;
        }

        private static void ConfigureOpenXr()
        {
            XRGeneralSettingsPerBuildTarget container = GetOrCreateXrSettingsContainer();
            if (!container.HasManagerSettingsForBuildTarget(BuildTargetGroup.Android))
            {
                container.CreateDefaultManagerSettingsForBuildTarget(BuildTargetGroup.Android);
            }

            XRGeneralSettings settings = container.SettingsForBuildTarget(BuildTargetGroup.Android);

            if (!XRPackageMetadataStore.AssignLoader(
                    settings.Manager,
                    OpenXrLoaderType,
                    BuildTargetGroup.Android))
            {
                throw new InvalidOperationException("Could not assign the OpenXR loader for Android.");
            }

            EnableOpenXrFeatures(BuildTargetGroup.Android);
            EnableOpenXrFeatures(BuildTargetGroup.Standalone);
            Debug.Log($"OPENXR_CONFIGURED selectedGroup={EditorUserBuildSettings.selectedBuildTargetGroup}");
            settings.InitManagerOnStart = true;
            EditorUtility.SetDirty(settings);
            EditorUtility.SetDirty(settings.Manager);
            AssetDatabase.SaveAssets();
        }

        private static void CleanStaleSimulationBuildAssets()
        {
            AssetDatabase.DeleteAsset("Assets/XR/Temp/XRSimulationPreferences.asset");
            AssetDatabase.DeleteAsset("Assets/XR/Temp/XRSimulationRuntimeSettings.asset");
        }

        private static void EnableOpenXrFeatures(BuildTargetGroup group)
        {
            OpenXRSettings openXrSettings = OpenXRSettings.GetSettingsForBuildTargetGroup(group);
            if (openXrSettings == null)
            {
                throw new InvalidOperationException($"OpenXR feature settings are unavailable: {group}");
            }

            EnableFeature<OculusTouchControllerProfile>(openXrSettings);
            EnableFeature<OpenXRCompositionLayersFeature>(openXrSettings);
        }

        private static void EnableFeature<TFeature>(OpenXRSettings settings)
            where TFeature : OpenXRFeature
        {
            TFeature feature = settings.GetFeature<TFeature>();
            if (feature == null)
            {
                throw new InvalidOperationException($"OpenXR feature is unavailable: {typeof(TFeature).Name}");
            }

            feature.enabled = true;
            EditorUtility.SetDirty(feature);
        }

        private static XRGeneralSettingsPerBuildTarget GetOrCreateXrSettingsContainer()
        {
            string[] guids = AssetDatabase.FindAssets("t:XRGeneralSettingsPerBuildTarget");
            if (guids.Length > 0)
            {
                string existingPath = AssetDatabase.GUIDToAssetPath(guids[0]);
                XRGeneralSettingsPerBuildTarget existing =
                    AssetDatabase.LoadAssetAtPath<XRGeneralSettingsPerBuildTarget>(existingPath);
                EditorBuildSettings.AddConfigObject(XRGeneralSettings.k_SettingsKey, existing, true);
                return existing;
            }

            const string assetPath = "Assets/XR/Settings/XRGeneralSettingsPerBuildTarget.asset";
            Directory.CreateDirectory(Path.GetDirectoryName(assetPath));
            XRGeneralSettingsPerBuildTarget created =
                ScriptableObject.CreateInstance<XRGeneralSettingsPerBuildTarget>();
            AssetDatabase.CreateAsset(created, assetPath);
            EditorBuildSettings.AddConfigObject(XRGeneralSettings.k_SettingsKey, created, true);
            AssetDatabase.SaveAssets();
            return created;
        }

        private static void RequireDirectory(string path, string label)
        {
            if (!Directory.Exists(path))
            {
                throw new DirectoryNotFoundException($"{label} not found: {path}");
            }
        }

        private static void SetStaticProperty(Type type, string propertyName, string value)
        {
            PropertyInfo property = type.GetProperty(
                propertyName,
                BindingFlags.Public | BindingFlags.Static);
            if (property == null)
            {
                throw new MissingMemberException(type.FullName, propertyName);
            }

            property.SetValue(null, value);
        }
    }
}